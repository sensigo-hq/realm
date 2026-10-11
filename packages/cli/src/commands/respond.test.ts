// Tests for respondToGate — CLI respond command logic.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { respondToGate, respondCommand } from './respond.js';
import {
  JsonFileStore,
  JsonWorkflowStore,
  WorkflowError,
  ExtensionRegistry,
  executeStep,
  submitHumanResponse,
  composeStepViews,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
} from '@sensigo/realm';
import type { WorkflowDefinition, StepHandler, RunRecord } from '@sensigo/realm';
import { clearProjectExtensionsCache } from '../extensions/load-project-extensions.js';

const gateWorkflow: WorkflowDefinition = {
  id: 'respond-test-wf',
  name: 'Respond Test Workflow',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    'step-one': {
      description: 'Auto step with gate',
      execution: 'auto',
      trust: 'human_confirmed',
      gate: { choices: ['approve', 'reject'] },
    },
  },
};

/**
 * #706 walk W8-R1: a question (`decide`) and an `auto` step after it, so an answer leaves the run
 * `running` and the `Responded:` line ends `new state 'running'`.
 */
const answererWorkflow: WorkflowDefinition = {
  id: 'respond-answerer-wf',
  name: 'Respond Answerer Workflow',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    decide: {
      description: 'Auto step with gate',
      execution: 'auto',
      trust: 'human_confirmed',
      gate: { choices: ['ship', 'hold'] },
    },
    after: {
      description: 'The step after the question',
      execution: 'auto',
      depends_on: ['decide'],
    },
  },
};

describe('respondToGate', () => {
  let runDir: string;
  let workflowDir: string;
  let runStore: JsonFileStore;
  let workflowStore: JsonWorkflowStore;

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), 'realm-respond-run-'));
    workflowDir = await mkdtemp(join(tmpdir(), 'realm-respond-wf-'));
    runStore = new JsonFileStore(runDir);
    workflowStore = new JsonWorkflowStore(workflowDir);
    await workflowStore.register(gateWorkflow);
  });

  it('advances a gate-waiting run to completed on valid choice', async () => {
    const { run: run } = await runStore.create({
      workflowId: 'respond-test-wf',
      workflowVersion: 1,
      params: {},
    });

    // Open the gate via executeStep.
    const gateEnvelope = await executeStep(runStore, gateWorkflow, {
      runId: run.id,
      command: 'step-one',
      input: {},
      dispatcher: async () => ({}),
    });
    expect(gateEnvelope.status).toBe('confirm_required');

    const { choice, newState } = await respondToGate(
      run.id,
      { gate: gateEnvelope.gate!.gate_id, choice: 'approve' },
      runStore,
      workflowStore,
      new ExtensionRegistry(), // inject empty registry — keep the test hermetic (no fs loader)
    );

    expect(choice).toBe('approve');
    expect(newState).toBe('completed');

    const updated = await runStore.get(run.id);
    expect(updated.run_phase).toBe('completed');
  });

  it('C1 (issue #456) a workflow-absent run carries the remedy — "most often" and "respond again"', async () => {
    // Direct respondToGate call, bypassing the CLI action entirely — exercises :25's OWN fetch
    // (the direct-caller/test seam; the CLI action's :91 prefetch never runs here).
    const missingWfStore = new JsonWorkflowStore(
      await mkdtemp(join(tmpdir(), 'realm-respond-missing-wf-')),
    );
    const { run: run } = await runStore.create({
      workflowId: 'dev456',
      workflowVersion: 1,
      params: {},
    });
    // A gate must exist for submitHumanResponse to have something to resolve — but the
    // workflow fetch at :25 happens BEFORE any gate logic, so a bare pending_gate suffices.
    await runStore.update({
      ...run,
      pending_gate: {
        gate_id: 'g1',
        step_name: 'step-one',
        preview: {},
        choices: ['approve', 'reject'],
        opened_at: new Date().toISOString(),
      },
    });

    await expect(
      respondToGate(
        run.id,
        { gate: 'g1', choice: 'approve' },
        runStore,
        missingWfStore,
        new ExtensionRegistry(),
      ),
    ).rejects.toThrow(/most often/);
    await expect(
      respondToGate(
        run.id,
        { gate: 'g1', choice: 'approve' },
        runStore,
        missingWfStore,
        new ExtensionRegistry(),
      ),
    ).rejects.toThrow(/respond again/);
  });

  it('throws WorkflowError when gate_id does not match', async () => {
    const { run: run } = await runStore.create({
      workflowId: 'respond-test-wf',
      workflowVersion: 1,
      params: {},
    });

    await executeStep(runStore, gateWorkflow, {
      runId: run.id,
      command: 'step-one',
      input: {},
      dispatcher: async () => ({}),
    });

    await expect(
      respondToGate(
        run.id,
        { gate: 'wrong-gate-id', choice: 'approve' },
        runStore,
        workflowStore,
        new ExtensionRegistry(), // inject empty registry — keep the test hermetic (no fs loader)
      ),
    ).rejects.toThrow(WorkflowError);
  });
});

// A gated workflow whose on_outcome: complete finalizer uses a PROJECT handler registered
// only in a custom registry (never the default filesystem-only registry).
const gateFinalizerWorkflow: WorkflowDefinition = {
  id: 'respond-finalizer-wf',
  name: 'Respond Finalizer Workflow',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    'step-one': {
      description: 'Auto step with gate',
      execution: 'auto',
      trust: 'human_confirmed',
      gate: { choices: ['approve', 'reject'] },
    },
    record_outcome: {
      description: 'Record terminal outcome',
      execution: 'finalizer',
      on_outcome: 'complete',
      handler: 'record_outcome',
    },
  },
};

describe('respondToGate — fires finalizers on gate completion (registry threaded)', () => {
  let runDir: string;
  let workflowDir: string;
  let runStore: JsonFileStore;
  let workflowStore: JsonWorkflowStore;

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), 'realm-respond-fin-run-'));
    workflowDir = await mkdtemp(join(tmpdir(), 'realm-respond-fin-wf-'));
    runStore = new JsonFileStore(runDir);
    workflowStore = new JsonWorkflowStore(workflowDir);
    await workflowStore.register(gateFinalizerWorkflow);
  });

  async function openGate(): Promise<{ runId: string; gateId: string }> {
    const { run } = await runStore.create({
      workflowId: 'respond-finalizer-wf',
      workflowVersion: 1,
      params: {},
    });
    const gateEnvelope = await executeStep(runStore, gateFinalizerWorkflow, {
      runId: run.id,
      command: 'step-one',
      input: {},
      dispatcher: async () => ({}),
    });
    expect(gateEnvelope.status).toBe('confirm_required');
    return { runId: run.id, gateId: gateEnvelope.gate!.gate_id };
  }

  it('runs the complete finalizer with a project handler when the injected registry provides it', async () => {
    const ran = vi.fn();
    const handler: StepHandler = {
      id: 'record_outcome',
      execute: vi.fn(async () => {
        ran();
        return { data: { recorded: true } };
      }),
    };
    const registry = new ExtensionRegistry();
    registry.register('handler', 'record_outcome', handler);

    const { runId, gateId } = await openGate();
    const { newState } = await respondToGate(
      runId,
      { gate: gateId, choice: 'approve' },
      runStore,
      workflowStore,
      registry,
    );

    expect(newState).toBe('completed');
    expect(ran).toHaveBeenCalledTimes(1);
    const updated = await runStore.get(runId);
    expect(updated.completed_steps).toContain('record_outcome');
    expect(updated.evidence.some((e) => e.step_id === 'record_outcome')).toBe(true);
  });

  it('leaves the finalizer PENDING (recoverable on a capable runner) when the registry lacks its handler (run still completes)', async () => {
    // Control: a registry without the project handler. issue #279 (increment 2, PR-D): gate
    // resolution now completes via the post-commit drain loop (drainFinalizers) on a declaring
    // store (JsonFileStore) — its registry pre-check LEAVES an absent-handler entry PENDING and
    // discloses why, rather than burning it into failed_steps (design record §6: "leasing it,
    // failing the call, and marking it 'failed' would destroy the 'recoverable on a capable
    // runner' property a still-pending entry carries" — this is PR-B's own already-shipped drain
    // semantics, now also reached via gate resolution). The run outcome is unchanged either way
    // (finalizer non-delivery never un-completes the run).
    const { runId, gateId } = await openGate();
    const { newState } = await respondToGate(
      runId,
      { gate: gateId, choice: 'approve' },
      runStore,
      workflowStore,
      new ExtensionRegistry(), // empty — no 'record_outcome' handler
    );

    expect(newState).toBe('completed');
    const updated = await runStore.get(runId);
    expect(updated.failed_steps).not.toContain('record_outcome');
    expect(updated.completed_steps).not.toContain('record_outcome');
    expect(updated.finalizer_ledger?.['record_outcome']?.status).toBe('pending');
  });
});

// =================================================================================================
// issue #466 — the extensions sentence at `realm run respond`
// =================================================================================================

describe('respondCommand — `Error loading extensions:` (issue #466)', () => {
  let home: string;
  let originalHome: string | undefined;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clearProjectExtensionsCache();
    home = mkdtempSync(join(tmpdir(), 'realm-respond-ext-home-'));
    mkdirSync(join(home, '.realm', 'workflows'), { recursive: true });
    originalHome = process.env['HOME'];
    process.env['HOME'] = home;
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('process.exit');
    }) as never);
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = originalHome;
    vi.restoreAllMocks();
    rmSync(home, { recursive: true, force: true });
  });

  const errored = (): string => errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');

  it('P1 a module that cannot be resolved reports `Error loading extensions:`, not the raw message', async () => {
    // Red-first on main: the raw resolver message, NO prefix at all — `Cannot resolve extension
    // module './nope.js' of workflow '…' …`, exit 1. run/validate/register/watch/agent already
    // named this failure (#445/#451/#465); respond did not.
    //
    // Seeded via DIRECT store APIs: JsonWorkflowStore.register persists WITHOUT resolving
    // extensions — the module never has to exist. source_dir/trust_root are REQUIRED (or the
    // loader throws a DIFFERENT message, load-project-extensions.ts:748-759) — a real project dir
    // stands in for both.
    const { JsonFileStore, JsonWorkflowStore, executeStep, CURRENT_WORKFLOW_SCHEMA_VERSION } =
      await import('@sensigo/realm');
    const proj = mkdtempSync(join(tmpdir(), 'realm-respond-ext-proj-'));
    const runStore = new JsonFileStore();
    const workflowStore = new JsonWorkflowStore();
    const gateWorkflow = {
      id: 'p466-respond',
      name: 'P466 Respond',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      extensions: ['./nope.js'],
      source_dir: proj,
      trust_root: proj,
      steps: {
        'step-one': {
          description: 'g',
          execution: 'auto' as const,
          trust: 'human_confirmed' as const,
          gate: { choices: ['approve', 'reject'] },
        },
      },
    };
    await workflowStore.register(gateWorkflow);
    const { run } = await runStore.create({
      workflowId: gateWorkflow.id,
      workflowVersion: 1,
      params: {},
    });
    const gateEnvelope = await executeStep(runStore, gateWorkflow, {
      runId: run.id,
      command: 'step-one',
      input: {},
      dispatcher: async () => ({}),
    });

    await expect(
      respondCommand.parseAsync(
        [run.id, '--gate', gateEnvelope.gate!.gate_id, '--choice', 'approve'],
        { from: 'user' },
      ),
    ).rejects.toThrow('process.exit');

    expect(errored()).toMatch(
      /^Error loading extensions: Cannot resolve extension module '\.\/nope\.js' of workflow 'p466-respond'/m,
    );
    expect(errored()).not.toMatch(/^Cannot resolve extension module/m);
    // NESTED-EXIT ARTIFACT (the #466 test.ts twin): the inner catch's process.exit(1) throws
    // under this mock, propagating to the OUTER catch, which re-prints and exits again —
    // production-neutral (a real process.exit never returns). Assert the CALL, never the count.
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(logSpy).not.toHaveBeenCalled();
    rmSync(proj, { recursive: true, force: true });
  });

  it('REPAIR-TOOL FLAG TRAVEL — --extensions-module and --project reach the hoisted resolution', async () => {
    // MA novel probe (the #353 flag-travel class on newly-minted code): mutating the hoist to
    // `loadProjectExtensions(workflow)` — dropping the options object — leaves every other cell
    // green. Under that regression BOTH declared respond flags die silently: `--project` and
    // `--extensions-module`, which the command's own help text calls the REPAIR TOOL ("module
    // that REPLACES the workflow's declared 'extensions' modules") — the repair tool dying
    // silently in exactly the broken-extensions scenario it exists for. This is the only pin on
    // the hoist's options travel; `--project` rides the same object, pinned transitively.
    //
    // No red-first exists — green on the PR branch immediately (the option travel already
    // works); its tooth is the mutant.
    const { JsonFileStore, JsonWorkflowStore, executeStep, CURRENT_WORKFLOW_SCHEMA_VERSION } =
      await import('@sensigo/realm');
    const proj = mkdtempSync(join(tmpdir(), 'realm-respond-ext-repair-proj-'));
    const runStore = new JsonFileStore();
    const workflowStore = new JsonWorkflowStore();
    const gateWorkflow = {
      id: 'p466-repair-respond',
      name: 'P466 Repair Respond',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      extensions: ['./nope.js'],
      source_dir: proj,
      trust_root: proj,
      steps: {
        'step-one': {
          description: 'g',
          execution: 'auto' as const,
          trust: 'human_confirmed' as const,
          gate: { choices: ['approve', 'reject'] },
        },
      },
    };
    await workflowStore.register(gateWorkflow);
    const { run } = await runStore.create({
      workflowId: gateWorkflow.id,
      workflowVersion: 1,
      params: {},
    });
    const gateEnvelope = await executeStep(runStore, gateWorkflow, {
      runId: run.id,
      command: 'step-one',
      input: {},
      dispatcher: async () => ({}),
    });

    // The override module resolves against CWD ONLY (load-project-extensions.ts:729-737) —
    // never `projectDir`/`--project` — so an ABSOLUTE path keeps this cell independent of
    // vitest's cwd. gateWorkflow's one step needs no handlers.
    const overridePath = join(proj, 'override.mjs');
    writeFileSync(overridePath, 'export default { handlers: {} };\n', 'utf8');
    // The override arm prints an unspied advisory (load-project-extensions.ts:734) — spied here
    // only to keep test output clean; not asserted.
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await respondCommand.parseAsync(
      [
        run.id,
        '--gate',
        gateEnvelope.gate!.gate_id,
        '--choice',
        'approve',
        '--extensions-module',
        overridePath,
      ],
      { from: 'user' },
    );

    // The override REACHED the loader — no sentence, the load was repaired.
    expect(errored()).not.toContain('Error loading extensions');
    const logged = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(logged).toContain('Responded:');
    expect(logged).toContain("new state 'completed'");
    expect(exitSpy).not.toHaveBeenCalled();
    rmSync(proj, { recursive: true, force: true });
  });

  it('MISATTRIBUTION CONTROL — a bad run-id never wears the extensions sentence', async () => {
    // The run/workflow fetches stay OUTSIDE the sentence-try (decision 3): respond's most common
    // operator error must classify as itself, not as an extensions failure.
    await expect(
      respondCommand.parseAsync(['no-such-run', '--gate', 'g1', '--choice', 'approve'], {
        from: 'user',
      }),
    ).rejects.toThrow('process.exit');

    expect(errored()).not.toContain('Error loading extensions');
    expect(errored()).toContain('Run not found');
    expect(exitSpy).toHaveBeenCalledWith(1);
    // issue #456: the by-id bare control — a bad run-id must never wear the OTHER remedy either.
    expect(errored()).not.toContain('most often');
  });

  it('C2 (issue #456) a workflow-absent run carries the remedy via the ACTION path — "most often" and "respond again"', async () => {
    // Via the CLI action (respondCommand.parseAsync) — exercises :91's OWN prefetch, which fails
    // BEFORE respondToGate (and its own :25 fetch) is ever called. The action constructs its own
    // default JsonWorkflowStore (under this describe's $HOME override) — nothing registered in
    // it, matching the dev-run scenario exactly.
    const { JsonFileStore } = await import('@sensigo/realm');
    const runStore = new JsonFileStore();
    const { run } = await runStore.create({
      workflowId: 'dev456',
      workflowVersion: 1,
      params: {},
    });
    await runStore.update({
      ...run,
      pending_gate: {
        gate_id: 'g1',
        step_name: 'step-one',
        preview: {},
        choices: ['approve', 'reject'],
        opened_at: new Date().toISOString(),
      },
    });

    await expect(
      respondCommand.parseAsync([run.id, '--gate', 'g1', '--choice', 'approve'], {
        from: 'user',
      }),
    ).rejects.toThrow('process.exit');

    expect(errored()).toContain('most often');
    expect(errored()).toContain('respond again');
    expect(errored()).not.toContain('Error loading extensions');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

// -------------------------------------------------------------------------------------------------
// #706 walk W8-R1: the `Responded:` line's answerer clause names the answer the RECORD holds, never
// this command's own `--by`. A repeat of the recorded choice records nothing (core's `already_settled`
// path) and still prints `Responded:` — so it must name whoever's answer the record keeps.
//
// Every cell carries (a) the change that turns it red and (b) what it prints on failure: the printed
// line and the record's answers as the step view reads them (choice, answerer, proof) — never an
// environment. Cell 8 (`realm run inspect`'s and `realm workflow run`'s answer lines, unchanged) is
// the existing pins in inspect-holder-625.test.ts and run-prompt-625.test.ts.
// -------------------------------------------------------------------------------------------------
describe('the answerer clause reads the record (#706 walk W8-R1)', () => {
  let runDir: string;
  let runStore: JsonFileStore;
  let workflowStore: JsonWorkflowStore;
  let registry: ExtensionRegistry;
  let runId: string;
  let gateId: string;

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), 'realm-respond-answerer-run-'));
    runStore = new JsonFileStore(runDir);
    workflowStore = new JsonWorkflowStore(
      await mkdtemp(join(tmpdir(), 'realm-respond-answerer-wf-')),
    );
    await workflowStore.register(answererWorkflow);
    registry = new ExtensionRegistry();
    const { run } = await runStore.create({
      workflowId: answererWorkflow.id,
      workflowVersion: 1,
      params: {},
    });
    const opened = await executeStep(runStore, answererWorkflow, {
      runId: run.id,
      command: 'decide',
      input: {},
      dispatcher: async () => ({}),
    });
    expect(opened.status).toBe('confirm_required');
    runId = run.id;
    gateId = opened.gate!.gate_id;
  });

  /** `realm run respond <run> --gate <gate> --choice ship [--by <by>]`: its `Responded:` line. */
  async function respond(by?: string, store: JsonFileStore = runStore): Promise<string> {
    const outcome = await respondToGate(
      runId,
      { gate: gateId, choice: 'ship', ...(by !== undefined ? { by } : {}) },
      store,
      workflowStore,
      registry,
    );
    // The owed lines follow the `Responded:` line; the cells compare the first line only.
    return outcome.lastLine.split('\n')[0]!;
  }

  /** The record's answers to the question, as the step view reads them — what a failure prints. */
  async function recordedAnswers(): Promise<string> {
    return JSON.stringify(composeStepViews(await runStore.get(runId))['decide']?.answers ?? []);
  }

  const respondedLine = (clause: string): string =>
    `Responded: ${runId} | choice 'ship'${clause} | new state 'running'`;

  it('1. a repeat names the answerer the record holds, never its own --by', async () => {
    await respond('alice');
    const bob = await respond('bob');
    // (a) red when the clause is composed from this command's `--by`: bob's line names bob, while
    //     the record keeps alice. (b) prints bob's line and the record's answers.
    expect(bob, `the record's answers: ${await recordedAnswers()}`).toBe(
      respondedLine(' | answered by alice (as stated)'),
    );
  });

  it('2. no name recorded, --by given: the repeat says (not stated), never its own name', async () => {
    await respond();
    const bob = await respond('bob');
    // (a) red when the clause is composed from `--by`: bob's line names bob, while the record holds
    //     no name. (b) prints bob's line and the record's answers.
    expect(bob, `the record's answers: ${await recordedAnswers()}`).toBe(
      respondedLine(' | answered by (not stated)'),
    );
  });

  it('3. a repeat without --by after a named answer names the recorded answerer', async () => {
    await respond('alice');
    const anonymous = await respond();
    // (a) red when the clause is said only when `--by` was given (`byGiven ? … : ''` for every
    //     answer): the line has no clause. (b) prints the line and the record's answers.
    expect(anonymous, `the record's answers: ${await recordedAnswers()}`).toBe(
      respondedLine(' | answered by alice (as stated)'),
    );
  });

  it('4. a recorded name that cannot be printed: the repeat prints the one phrase, no byte of the name', async () => {
    // A host program's own call through core's `submitHumanResponse` (no CLI or MCP door bounds the
    // name): core stores the control character, and the record reads the name as unreadable.
    const host = await submitHumanResponse(runStore, answererWorkflow, {
      runId,
      gateId,
      choice: 'ship',
      respondedBy: 'al\u0007ice',
      registry,
    });
    const before = await recordedAnswers();
    // Witness of the setup: (a) red when core refuses the name (then bob's answer would be the one
    // recorded and the cell would test something else); (b) prints the reply's status and errors.
    expect(host.status, `the host's answer: ${host.status} ${JSON.stringify(host.errors)}`).toBe(
      'ok',
    );
    expect(
      composeStepViews(await runStore.get(runId))['decide']?.answers?.map((a) => a.answered_by),
      `the record's answers: ${before}`,
    ).toEqual([{ by: null, absent_cause: 'name_unreadable' }]);
    const bob = await respond('bob');
    // (a) red when the clause is composed from `--by` (bob's name), or when an unreadable name reads
    //     as `(not stated)`, or when the stored bytes are printed. (b) prints bob's line, JSON-quoted
    //     so a control character shows as an escape, and the record's answers.
    const shown = `bob's line: ${JSON.stringify(bob)}; the record's answers: ${await recordedAnswers()}`;
    expect(bob, shown).toBe(
      respondedLine(
        ' | answered by a recorded name that cannot be printed (control characters, or not a name with its source)',
      ),
    );
    expect(bob.includes('\u0007'), shown).toBe(false);
    expect(bob.includes('alice'), shown).toBe(false);
  });

  it("5. the race: bob reads the question open, alice's answer lands, bob's submit finds it settled — bob's line names alice", async () => {
    // Bob's own store over the same folder (a delegating wrapper is refused at admission). Its FIRST
    // read returns the record with the question open — after alice's answer, written through the
    // other instance, has landed. Bob's submit then reads the settled question (`already_settled`).
    const bobStore = new JsonFileStore(runDir);
    const read = bobStore.get.bind(bobStore);
    const reads: RunRecord[] = [];
    let aliceStatus: string | undefined;
    bobStore.get = async (id: string): Promise<RunRecord> => {
      const record = await read(id);
      reads.push(record);
      if (reads.length === 1) {
        const alice = await submitHumanResponse(runStore, answererWorkflow, {
          runId,
          gateId,
          choice: 'ship',
          respondedBy: 'alice',
          caller: 'respond',
          registry,
        });
        aliceStatus = alice.status;
      }
      return record;
    };
    const bob = await respond('bob', bobStore);
    const answersAfter = composeStepViews(await runStore.get(runId))['decide']?.answers ?? [];
    // (b) what every assertion here prints: bob's reads (question open? record version), alice's
    //     reply status, bob's line and the record's answers.
    const shown =
      `bob's reads: ${JSON.stringify(reads.map((r) => [r.pending_gate?.gate_id === gateId, r.version]))}; ` +
      `alice's reply: ${String(aliceStatus)}; bob's line: ${bob}; ` +
      `the record's answers: ${JSON.stringify(answersAfter)}`;
    // Witnesses of the race — (a) each red when the setup misfires: bob's first read saw the question
    // open; alice's answer was recorded; the record holds exactly one answer (alice's).
    expect(reads[0]?.pending_gate?.gate_id, shown).toBe(gateId);
    expect(aliceStatus, shown).toBe('ok');
    expect(answersAfter.length, shown).toBe(1);
    // (a) red when the clause is composed from `--by` (bob), or from the record bob read BEFORE his
    //     call (the question open: no answer, so no clause).
    expect(bob, shown).toBe(respondedLine(' | answered by alice (as stated)'));
  });

  it('6. (preservation) a first answer with --by names that answerer', async () => {
    const alice = await respond('alice');
    // (a) red when a recorded name stops being said, or its words change. (b) prints the line and
    //     the record's answers.
    expect(alice, `the record's answers: ${await recordedAnswers()}`).toBe(
      respondedLine(' | answered by alice (as stated)'),
    );
  });

  it('7. (preservation) a first answer with no --by prints no clause', async () => {
    const anonymous = await respond();
    // (a) red when a clause is printed for an answer nobody named, with no `--by` given. (b) prints
    //     the line and the record's answers.
    expect(anonymous, `the record's answers: ${await recordedAnswers()}`).toBe(respondedLine(''));
  });

  it('9. the reference page and the CHANGELOG say the line names the answerer the record holds', () => {
    const repo = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
    const flat = (t: string): string => t.replace(/\s+/g, ' ');
    // (a) red when the file no longer holds the sentence word for word (whitespace flattened);
    // (b) prints the file's name and the sentence it should hold — never the whole file.
    const says = (file: string, sentence: string): void => {
      expect(
        flat(readFileSync(join(repo, file), 'utf8')).includes(flat(sentence)),
        `${file} no longer says: ${sentence}`,
      ).toBe(true);
    };
    says(
      'docs/reference/cli/realm-run-acting.md',
      'Giving the same answer again prints the `Responded:` line again, naming the answerer the record holds (`answered by <name> (as stated)`, or `answered by (not stated)` when you gave `--by` and the record holds no name); it records no new answer.',
    );
    says(
      'CHANGELOG.md',
      '`realm run respond` prints the derived phase, the answerer the record holds (`answered by <name> (as stated)`; `answered by (not stated)` when `--by` was given and the record holds no name), and the owed line.',
    );
  });
});
