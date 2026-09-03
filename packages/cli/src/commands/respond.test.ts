// Tests for respondToGate — CLI respond command logic.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { respondToGate, respondCommand } from './respond.js';
import {
  JsonFileStore,
  JsonWorkflowStore,
  WorkflowError,
  ExtensionRegistry,
  executeStep,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
} from '@sensigo/realm';
import type { WorkflowDefinition, StepHandler } from '@sensigo/realm';
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
  });
});
