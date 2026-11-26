// docs-claims-625.test.ts — issue #625 PR-2a, decision C163 (the method): each sentence about
// function behaviour that #625 PR-2a adds or changes in `docs/reference/core-library.md` is pinned
// here, one cell per function and case it covers. Each cell quotes its sentence exactly and asserts
// the page still holds it (read from the repository), then drives the case through the library and
// asserts what the sentence states — so neither the page nor the behaviour can change alone.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as core from '../index.js';
import { CheckQuotesHandler } from '../handlers/check-quotes.js';
import {
  NOT_SENTENCE_ENDS,
  QUOTE_SEARCH_BUDGET,
  QUOTE_STATES,
  canonicalForm,
  locateQuote,
  segmentsOf,
} from '../handlers/primitives/locate-quote.js';
import { createDefaultRegistry } from '../extensions/default-registry.js';
import { ExtensionRegistry } from '../extensions/registry.js';
import {
  loadWorkflowFromString,
  loadWorkflowFromStringWithDiagnostics,
} from '../workflow/yaml-loader.js';
import { JsonWorkflowStore } from '../workflow/registrar.js';
import {
  advanceRun,
  executeChain,
  executeEngineStep,
  executeStep,
  submitHumanResponse,
  pendingGateQuestion,
  runReadError,
} from './execution-loop.js';
import { describePending } from './pending.js';
import { JsonFileStore } from '../store/json-file-store.js';
import { jsonAsRunStore } from '../test-support/json-as-run-store.js';
import { InMemoryStore, settableClock, type SettableClock } from '@sensigo/realm-testing';
import { WorkflowError } from '../types/workflow-error.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
import type { RunStore } from '../store/store-interface.js';
import { agentActionFor, nextCalls, owedOf } from '../test-support/ways-view.js';
import { composeWaysAt, stepBrief } from './ways.js';
import { compareStrings } from '../handlers/primitives/compare-strings.js';
import { writeTestClockFile } from '../store/test-clock-file.js';
import { writtenSnapshot } from './snapshot.js';
import { zOf } from '../test-support/instant.js';

/** The three cells about a run FILE that is not JSON (C156, its class, C169) keep a JSON store of
 *  their own: on a test location, its runs folder beside the location's clock file (set to the
 *  host's reading). The engine's other cells run on an in-memory store on a settable clock. */
async function testLocationRuns(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  await writeTestClockFile(root, new Date());
  // The runs folder exists from the start: some cells write a file into it before any run.
  await mkdir(join(root, 'runs'), { recursive: true });
  return join(root, 'runs');
}
/** #616 PR-2c c4: the JSON store wrapped as a `RunStore` (it lacks the scan verbs), with its folder;
 *  PR-3 deletes it. */
async function clockedJsonStore(
  prefix: string,
): Promise<RunStore & { readonly runsDirPath: string }> {
  return jsonAsRunStore(new JsonFileStore(await testLocationRuns(prefix)));
}

const PAGE = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../docs/reference/core-library.md',
);
const flat = (t: string) => t.replace(/\s+/g, ' ');

/** (a) red when core-library.md no longer holds the sentence word for word; (b) prints it. */
function claim(sentence: string): void {
  expect(flat(readFileSync(PAGE, 'utf8')), `core-library.md no longer says: ${sentence}`).toContain(
    flat(sentence),
  );
}

/** (a) red when gates.md no longer holds the sentence word for word; (b) prints it. */
function claimGates(sentence: string): void {
  const page = readFileSync(join(dirname(PAGE), 'workflow/gates.md'), 'utf8');
  expect(flat(page), `gates.md no longer says: ${sentence}`).toContain(flat(sentence));
}

/** `q` (a question, 60 s, `on_expiry` as given), then `after` (a bare `auto` step). */
function gated(onExpiry: 'settle_default' | 'abort' = 'settle_default'): WorkflowDefinition {
  return {
    id: `dc-${onExpiry}`,
    name: 'docs claims',
    version: 1,
    steps: {
      q: {
        description: 'Ask.',
        execution: 'auto',
        trust: 'human_confirmed',
        depends_on: [],
        gate: {
          choices: ['approve', 'reject'],
          timeout_seconds: 60,
          on_expiry: onExpiry,
          ...(onExpiry === 'settle_default' ? { default_choice: 'approve' } : {}),
        },
      },
      after: { description: 'After.', execution: 'auto', depends_on: ['q'] },
    },
  };
}

/** decision C193: core-library.md's `onGuard` sentence (MR-147: it names every guard the call records). */
const ONGUARD_SENTENCE =
  "`onGuard` (called with the name of each guard the reply lists in `chained_auto_steps`, as the call reaches it and before the next step's `onStep`: one decided by the write of a step the call ran, one the call decides itself, and one another call decided first, which the call finds already settled; a guard decided by the expiry the call carries out is on the expiry line instead; added after version 0.46.0)";

const dispatcher = async () => ({});
const LATER = () => new Date(Date.now() + 120_000);
const EARLIER = () => new Date(Date.now() - 120_000);

describe('#625 PR-2a, C163 — core-library.md, sentence by sentence, through the library', () => {
  // #715 (b) (01 §C.4): the store's clock decides what is due — an in-memory store on a settable
  // clock, first set to the host's reading, which a cell moves.
  let clock: SettableClock;
  let store: InMemoryStore;
  beforeEach(() => {
    clock = settableClock(new Date());
    store = new InMemoryStore({ clock });
  });

  async function atQuestion(d: WorkflowDefinition = gated()) {
    // #715 (b): each question opens at the host's time (a cell may have moved the store's clock).
    await clock.set(new Date());
    const { record: run } = await store.create({
      workflowId: d.id,
      workflowVersion: 1,
      params: {},
    });
    const opened = await executeStep(store, d, {
      runId: run.id,
      command: 'q',
      input: {},
      dispatcher,
    });
    if (opened.status !== 'confirm_required') throw new Error(`fixture: ${opened.status}`);
    return { runId: run.id, gateId: (await store.get(run.id)).record.pending_gate!.gate_id };
  }

  // --- the expiry line names the call (line 80) -----------------------------------------------
  const NAMES_THE_CALL =
    "When a call carries out an expired question's `on_expiry`, the library prints nothing: the line that says so is in the reply's `warnings`, and names the call — for your program's own call, the function: `this advanceRun call first carried out its declared …` (`enacted_via: advanceRun`), and likewise `executeStep`, `executeChain`, `submitHumanResponse` and `executeEngineStep`";
  it.each([
    [
      'advanceRun',
      async (d: WorkflowDefinition, runId: string) => {
        await clock.set(LATER());
        return advanceRun(store, d, { runId });
      },
    ],
    [
      'executeStep',
      async (d: WorkflowDefinition, runId: string) => {
        await clock.set(LATER());
        return executeStep(store, d, { runId, command: 'after', input: {}, dispatcher });
      },
    ],
    [
      'executeChain',
      async (d: WorkflowDefinition, runId: string) => {
        await clock.set(LATER());
        return executeChain(store, d, { runId, command: 'after', input: {}, dispatcher });
      },
    ],
    [
      'executeEngineStep',
      async (d: WorkflowDefinition, runId: string) => {
        await clock.set(LATER());
        return executeEngineStep(store, d, {
          runId,
          step: 'after',
          run: (await store.get(runId)).record,
        });
      },
    ],
  ] as const)(
    'C163 line 80: %s carries out an expired question — the line is in warnings, names the function, and nothing is printed',
    async (fn, call) => {
      claim(NAMES_THE_CALL);
      claimGates(
        'and from a program the library function (`enacted_via: submitHumanResponse`, `executeChain`, …).',
      );
      const d = gated();
      const { runId, gateId } = await atQuestion(d);
      const printed: unknown[] = [];
      const [log, err, warn] = [console.log, console.error, console.warn];
      console.log = console.error = console.warn = (...a: unknown[]) => void printed.push(a);
      let reply;
      try {
        reply = await call(d, runId);
      } finally {
        [console.log, console.error, console.warn] = [log, err, warn];
      }
      // (a) red when the line names another call, is missing, or is printed; (b) prints the reply.
      expect(reply.warnings).toContain(
        `gate '${gateId}' on 'q' had expired 1m before this call (deadline ${zOf(reply.expiry!.expired_at)}) — this ${fn} call first carried out its declared settle_default: the default choice 'approve' was recorded (enacted_via: ${fn}).`,
      );
      expect(printed).toEqual([]);
    },
  );

  it('C163 line 80: submitHumanResponse carries out an expired question — the line names submitHumanResponse', async () => {
    claim(NAMES_THE_CALL);
    claimGates(
      'and from a program the library function (`enacted_via: submitHumanResponse`, `executeChain`, …).',
    );
    const d = gated();
    const { runId, gateId } = await atQuestion(d);
    await clock.set(LATER());
    const reply = await submitHumanResponse(store, d, {
      runId,
      gateId,
      choice: 'reject',
    });
    expect(reply.warnings).toContain(
      `gate '${gateId}' on 'q' had expired 1m before this call (deadline ${zOf(reply.expiry!.expired_at)}) — this submitHumanResponse call first carried out its declared settle_default: the default choice 'approve' was recorded (enacted_via: submitHumanResponse).`,
    );
  });

  // --- callers (lines 102, 104, 119, 121) -----------------------------------------------------
  it.each([
    [
      'advanceRun',
      "`caller` is one of seven words: `advanceRun` (the default, a program's own call), `advance_run`, `advance`, `start_run`, `agent`, `submit_human_response` or `submitHumanResponse` (the last two, added after version 0.50.0, name an answer's call that carries the run on).",
      [
        'advanceRun',
        'advance_run',
        'advance',
        'start_run',
        'agent',
        'submit_human_response',
        'submitHumanResponse',
      ],
    ],
    [
      'executeStep',
      '`executeStep` takes `executeStep` (the default) or `agent`',
      ['executeStep', 'agent'],
    ],
    [
      'executeChain',
      '`executeChain` takes `executeChain` (the default), `execute_step`, `agent` or `run`.',
      ['executeChain', 'execute_step', 'agent', 'run'],
    ],
    [
      'submitHumanResponse',
      '`submitHumanResponse` (the default), `submit_human_response`, `respond`, `run` or `agent`; any other value rejects as above',
      ['submitHumanResponse', 'submit_human_response', 'respond', 'run', 'agent'],
    ],
    [
      'executeEngineStep',
      'optionally `caller`: `executeEngineStep` (the default) or `agent`; any other value rejects with a `WorkflowError` with the code `VALIDATION_CALLER_INVALID`, naming `executeEngineStep`, before anything is read or written.',
      ['executeEngineStep', 'agent'],
    ],
  ] as const)(
    'C155/C163: %s takes exactly the words its row lists; any other rejects VALIDATION_CALLER_INVALID naming it, nothing read or written',
    async (fn, sentence, words) => {
      claim(sentence);
      claim(
        'Each of these functions takes a `caller` option for a host that names the call itself; see below.',
      );
      claim('The call the expiry line names when this call carries out an expired question first.');
      claim(
        'Any other value rejects with a `WorkflowError` with the code `VALIDATION_CALLER_INVALID` before anything is read or written.',
      );
      const d = gated();
      const { runId, gateId } = await atQuestion(d);
      const call = async (caller: unknown) => {
        const c = caller as never;
        switch (fn) {
          case 'advanceRun':
            return advanceRun(store, d, { runId, caller: c });
          case 'executeStep':
            return executeStep(store, d, {
              runId,
              command: 'after',
              input: {},
              dispatcher,
              caller: c,
            });
          case 'executeChain':
            return executeChain(store, d, {
              runId,
              command: 'after',
              input: {},
              dispatcher,
              caller: c,
            });
          case 'submitHumanResponse':
            return submitHumanResponse(store, d, { runId, gateId, choice: 'approve', caller: c });
          default:
            return executeEngineStep(store, d, {
              runId,
              step: 'after',
              run: (await store.get(runId)).record,
              caller: c,
            });
        }
      };
      const before = JSON.stringify((await store.get(runId)).record);
      // (a) red when a listed word is refused, or another word is taken; (b) prints the throw.
      await expect(call('nightly')).rejects.toMatchObject({
        code: 'VALIDATION_CALLER_INVALID',
        message: expect.stringMatching(
          new RegExp(`^${fn}'s caller is one of ${words.join(', ')}; `),
        ),
      });
      expect(JSON.stringify((await store.get(runId)).record)).toBe(before);
      for (const w of words) {
        const r = await call(w).catch((e: unknown) => e);
        expect(
          r instanceof WorkflowError && r.code === 'VALIDATION_CALLER_INVALID',
          `${fn} refused '${w}'`,
        ).toBe(false);
      }
    },
  );

  it("C163 line 102: advanceRun's caller is the reply's command and the call the line names; command is a free label that replaces it", async () => {
    claim("It is the call the expiry line names and the reply's `command`");
    claim(
      "`command` is a free label: it replaces the reply's `command`, and the expiry line still names `caller`.",
    );
    const d = gated();
    const a = await atQuestion(d);
    await clock.set(LATER());
    const named = await advanceRun(store, d, { runId: a.runId, caller: 'advance' });
    const b = await atQuestion(d);
    await clock.set(LATER());
    const labelled = await advanceRun(store, d, {
      runId: b.runId,
      caller: 'advance',
      command: 'nightly',
    });
    // (a) red when caller stops labelling the reply, or command renames the line; (b) prints them.
    expect([named.command, labelled.command]).toEqual(['advance', 'nightly']);
    expect(labelled.warnings.some((w) => w.includes('this advance call first carried out'))).toBe(
      true,
    );
  });

  // --- answering, then advanceRun (lines 82, 101, 102) ----------------------------------------
  it('C163 lines 82, 101: submitHumanResponse runs no auto step — ok, running, the owed sentence, advance_run offered; advanceRun then runs it', async () => {
    // #625 PR-2b A2a: the sentence now says which answer runs them — this cell's passes no token;
    // one that passes it back, with a registry: carry-on-a2a-625.test.ts check 2 (and check 1, row 4);
    // on a store that keeps no claims a passed-back token is `unverifiable` and the run is not carried
    // on: carry-on-a2a-625 check 1, "row 3 on a store that keeps no claims".
    claim(
      "An answer that passes back the opening reply's `claimToken`, with a registry, on a store that keeps claims, on a run whose recorded code identity matches the registry's, or where neither has one, runs the `auto` steps after it in the same call, up to the next pause; without `budget` nothing bounds it. Any other answer runs none: call `advanceRun`. Say the workflow",
    );
    claim('Then `submitHumanResponse` replies `status: ok` with `run_phase: running`.');
    claim(
      "Its `context_hint` says `Gate 'decide' resolved with choice 'approve'.`, and its `ways` hold an `advance` way whose `owed` names `file`.",
    );
    claim(
      "An answer that passes back the opening reply's `claimToken`, with a registry, on a store that keeps claims, on a run whose recorded code identity matches the registry's, or where neither has one, runs the `auto` steps after it in the same call, up to the next pause; without `budget` nothing bounds it. Any other answer runs none: call `advanceRun`. Added after version 0.50.0, which ran none.",
    );
    claim(
      'The replies are `EngineReply`: the fields of an MCP tool reply (see [MCP tools](mcp/tools.md)) without `next_actions`, `agent_action` and `blocked_reason.suggestion`, and with what can be done next as data',
    );
    claim(
      'A program reads the run with `store.get(runId)`, which returns `{ record, at }` (added after version 0.48.0), and takes a way with the function that matches it: `executeStep` for a `run_step` way, `advanceRun` for an `advance` way, `submitHumanResponse` for a `respond` way; `LIBRARY_WORDS` says each way in those words.',
    );
    claim(
      'Your program then calls `advanceRun` (also imported from `@sensigo/realm`), which runs `file`:',
    );
    claim(
      'Say the workflow has one more step, `file` (`execution: auto`, `depends_on: [decide]`), and the program passes no `claimToken`, as above.',
    );
    claim('reply = await advanceRun(store, definition, { runId: run.id, registry });');
    const d: WorkflowDefinition = {
      id: 'dc-decide',
      name: 'decide',
      version: 1,
      steps: {
        decide: {
          description: 'D.',
          execution: 'auto',
          trust: 'human_confirmed',
          depends_on: [],
          gate: { choices: ['approve', 'reject'] },
        },
        file: { description: 'F.', execution: 'auto', depends_on: ['decide'] },
      },
    };
    const { record: run } = await store.create({
      workflowId: d.id,
      workflowVersion: 1,
      params: {},
    });
    await executeStep(store, d, { runId: run.id, command: 'decide', input: {}, dispatcher });
    const gateId = (await store.get(run.id)).record.pending_gate!.gate_id;
    const answered = await submitHumanResponse(store, d, {
      runId: run.id,
      gateId,
      choice: 'approve',
    });
    // (a) red when the answer runs `file`, or its hint or ways change; (b) prints the reply.
    expect([
      answered.status,
      answered.run_phase,
      answered.context_hint,
      answered.names_next,
      nextCalls(answered),
      owedOf(answered),
    ]).toEqual([
      'ok',
      'running',
      "Gate 'decide' resolved with choice 'approve'.",
      true,
      ['advance'],
      ['file'],
    ]);
    expect((await store.get(run.id)).record.completed_steps).not.toContain('file');
    const advanced = await advanceRun(store, d, { runId: run.id });
    expect([advanced.status, advanced.run_phase]).toEqual(['ok', 'completed']);
  });

  it("C163 line 102: advanceRun carries out the expired question's on_expiry first, then the auto steps that are ready; onExpiry is called before any step runs", async () => {
    claim(
      "Runs what a run owes the engine and returns the reply: first an expired question's declared `on_expiry`, when its time is up, then the guards and `auto` steps that are ready.",
    );
    claim('`onExpiry` (called with the expiry line before any step runs)');
    const d = gated();
    const { runId } = await atQuestion(d);
    const seen: string[] = [];
    await clock.set(LATER());
    const r = await advanceRun(store, d, {
      runId,
      onExpiry: (line) => seen.push(`expiry: ${line.slice(0, 20)}`),
      onStep: (step) => seen.push(`step: ${step}`),
    });
    // (a) red when the line comes after a step, or the step does not run; (b) prints the order.
    expect(seen.map((l) => (l.startsWith("expiry: gate '") ? 'the expiry line' : l))).toEqual([
      'the expiry line',
      'step: after',
    ]);
    expect([r.status, r.run_phase]).toEqual(['ok', 'completed']);
  });

  it('C187 (walk c8, W5-1), line 102: onGuard is called with each guard the call decides, between the step that decided it and the next step; not for a guard the expiry decided', async () => {
    // decision C193: the sentence re-quoted — it names every guard the call records (MR-147).
    claim(ONGUARD_SENTENCE);
    const d: WorkflowDefinition = {
      ...gated(),
      id: 'dc-c187',
      steps: {
        ...gated().steps,
        // `after` (auto, after the question) → guard `ok` → `fin` (auto); a guard `early` the
        // expiry's own write decides.
        early: {
          description: 'Decided by the expiry.',
          execution: 'guard',
          depends_on: ['q'],
          abort_unless: ["q.choice == 'approve'"],
        },
        ok: {
          description: 'Decided after `after`.',
          execution: 'guard',
          depends_on: ['after'],
          abort_unless: ["q.choice == 'approve'"],
        },
        fin: { description: 'Fin.', execution: 'auto', depends_on: ['ok'] },
      },
    };
    const { runId } = await atQuestion(d);
    const seen: string[] = [];
    await clock.set(LATER());
    const r = await advanceRun(store, d, {
      runId,
      onExpiry: () => seen.push('expiry'),
      onStep: (step) => seen.push(`step: ${step}`),
      onGuard: (guard) => seen.push(`guard: ${guard}`),
    });
    // (a) red when a guard is told after the next step starts, not at all, or a guard the expiry
    //     decided is told too; (b) prints the order and the reply's chained steps.
    expect({
      seen,
      chained: r.chained_auto_steps?.map((c) => c.step),
      expiryLine: r.warnings.some((w) => w.includes("Guard step 'early' passed.")),
    }).toEqual({
      seen: ['expiry', 'step: after', 'guard: ok', 'step: fin'],
      chained: ['after', 'ok', 'fin'],
      expiryLine: true,
    });
  });

  it.each([
    ['the call decides it itself', false],
    ['another call decided it first, and the call finds it already settled', true],
  ] as const)(
    'C193 (MR-147), line 102: onGuard is called for a guard decided while the call runs that no step of the call decided — %s',
    async (_kase, raced) => {
      claim(ONGUARD_SENTENCE);
      // `a` is recorded completed by a plain update (a write that decides no guard), so the guard
      // `g` is eligible when advanceRun reads the run: the call's own settle decides it.
      const d: WorkflowDefinition = {
        id: 'dc-c193',
        name: 'docs claims',
        version: 1,
        steps: {
          a: { description: 'A.', execution: 'auto', depends_on: [] },
          g: {
            description: 'Guard.',
            execution: 'guard',
            depends_on: ['a'],
            abort_unless: ['a.ok == true'],
          },
          fin: { description: 'Fin.', execution: 'auto', depends_on: ['g'] },
        },
      };
      const { record: run } = await store.create({
        workflowId: d.id,
        workflowVersion: 1,
        params: {},
      });
      const now = new Date().toISOString();
      await store.update({
        ...run,
        completed_steps: ['a'],
        evidence: [
          {
            step_id: 'a',
            started_at: now,
            completed_at: now,
            duration_ms: 0,
            input_summary: {},
            output_summary: { ok: true },
            status: 'success',
            evidence_hash: 'c193',
          },
        ],
      });
      const original = store.settleStep.bind(store);
      const settles: string[] = [];
      let first = true;
      // Another call settles `g` with the same delta just before this call's own settle reaches the
      // store (the race the code's already_settled arm meets).
      store.settleStep = async (id, delta, def) => {
        if (raced && first && delta.kind === 'settle_guard') {
          first = false;
          settles.push(`other: ${(await original(id, delta, def)).applied}`);
        }
        const mine = await original(id, delta, def);
        if (delta.kind === 'settle_guard') {
          settles.push(`this call: ${mine.applied ? 'applied' : mine.reason}`);
        }
        return mine;
      };
      const seen: string[] = [];
      const r = await advanceRun(store, d, {
        runId: run.id,
        onStep: (step) => seen.push(`step: ${step}`),
        onGuard: (guard) => seen.push(`guard: ${guard}`),
      });
      // (a) red when a guard no step of the call decided is not told, is told after the next step
      //     starts, or the race is not the one built; (b) prints the order, the settles and the reply.
      expect({
        settles,
        seen,
        chained: r.chained_auto_steps?.map((c) => c.step),
        phase: r.run_phase,
      }).toEqual({
        settles: raced ? ['other: true', 'this call: already_settled'] : ['this call: applied'],
        seen: ['guard: g', 'step: fin'],
        chained: ['g', 'fin'],
        phase: 'completed',
      });
    },
  );

  it('C186 (walk c8, W4-c): advanceRun that only carries out an expired question names every guard its write decided — two, in the plural', async () => {
    const d: WorkflowDefinition = {
      id: 'dc-c186',
      name: 'docs claims',
      version: 1,
      steps: {
        q: gated().steps['q']!,
        e1: {
          description: 'One.',
          execution: 'guard',
          depends_on: ['q'],
          abort_unless: ["q.choice == 'approve'"],
        },
        e2: {
          description: 'Two.',
          execution: 'guard',
          depends_on: ['q'],
          abort_unless: ["q.choice == 'approve'"],
        },
        w: { description: 'W.', execution: 'agent', depends_on: ['e1', 'e2'] },
      },
    };
    const { runId } = await atQuestion(d);
    await clock.set(LATER());
    const r = await advanceRun(store, d, { runId });
    // (a) red when the hint says "no step ran" beside the guards that ran, names one of two, or
    //     the singular for two; (b) prints the hint.
    expect([r.context_hint, r.names_next, nextCalls(r)]).toEqual([
      `Run '${runId}': its expired question was carried out as declared, and that decided guards 'e1', 'e2' (see warnings); no other step ran.`,
      true,
      ['run_step:w'],
    ]);
  });

  // #715 (b), C.1: the `legacy update` member of this cell (a Proxy store declaring no
  // `settleStep`) is deleted with the legacy path it tested; the settleStep member stays.
  it.each(['settleStep'] as const)(
    'round 22 finding 10 (decided in round 23): the question from the step’s prompt is rendered from the record alone — the gate-open write (%s) carries the step’s evidence entry, its output equal to the gate’s preview; #729 PR-4 (f): the reply carries no gate.display for a gate with no message',
    async (path) => {
      const d: WorkflowDefinition = {
        id: `dc-f10-${path === 'settleStep' ? 'settle' : path}`,
        name: 'docs claims',
        version: 1,
        steps: {
          draft: {
            description: 'Draft.',
            execution: 'agent',
            depends_on: [],
            trust: 'human_confirmed',
            prompt:
              'Send "{{ context.resources.draft.subject }}" ({{ context.resources.draft.lines }} lines)?',
            gate: { choices: ['send', 'discard'] },
          },
        },
      } as WorkflowDefinition;
      const s: RunStore = store;
      const { record: run } = await s.create({ workflowId: d.id, workflowVersion: 1, params: {} });
      const output = { subject: 'Office closed', lines: 3 };
      const opened = await executeStep(s, d, {
        runId: run.id,
        command: 'draft',
        input: output,
        dispatcher: async () => output,
      });
      const { record: record } = await s.get(run.id);
      const entry = [...record.evidence]
        .reverse()
        .find((e) => e.step_id === 'draft' && e.kind !== 'gate_response');
      // (a) red when the gate-open write leaves the step's evidence off the record (the record then
      //     cannot give the step's output), when that entry's output is not the preview, or — #729
      //     PR-4 (f), re-pinned — when the reply carries a display for a gate with no message (the
      //     prompt's question is `inspect`'s labelled fallback only); (b) prints all three.
      expect({
        status: opened.status,
        entryIsPreview:
          JSON.stringify(entry?.output_summary) === JSON.stringify(record.pending_gate?.preview),
        // #715 (b) (02 §D.4): the fallback renders at a read's reading.
        question: pendingGateQuestion(d, writtenSnapshot(record, new Date())),
        display: opened.gate?.display,
      }).toEqual({
        status: 'confirm_required',
        entryIsPreview: true,
        question: 'Send "Office closed" (3 lines)?',
        display: undefined,
      });
    },
  );

  // --- C156: a run advanceRun cannot read -----------------------------------------------------
  const CANNOT_READ =
    'A run it cannot read gets an error reply, as from `executeStep`, never a throw: `STATE_RUN_NOT_FOUND` for a run that does not exist; an error the store throws as a `WorkflowError` keeps its code (a `JsonFileStore` run file that cannot be read as a run, for one: `RESOURCE_FORMAT_INVALID`, `STATE_LEGACY_FORMAT` or `ENGINE_STORE_FAILED`, naming the file and its way out), and any other is `ENGINE_STORE_FAILED`, naming its cause.';
  /** issue #719: a store whose every read throws something that is not a Realm error. */
  const untyped = () => {
    const raw = Object.create(store) as RunStore;
    Object.assign(raw, {
      get: async () => {
        throw new Error('the disk is gone');
      },
    });
    return raw;
  };
  it.each(['advanceRun', 'executeStep'] as const)(
    'C156, W1-Y2: %s on a run that does not exist — an error reply STATE_RUN_NOT_FOUND, run_version 0, never a throw',
    async (fn) => {
      claim(CANNOT_READ);
      const d = gated();
      const r =
        fn === 'advanceRun'
          ? await advanceRun(store, d, { runId: 'nope' })
          : await executeStep(store, d, { runId: 'nope', command: 'after', input: {}, dispatcher });
      // (a) red when advanceRun throws again, or its reply differs from executeStep's; (b) prints it.
      expect([r.status, r.error_code, r.run_id, r.run_version, agentActionFor(r)]).toEqual([
        'error',
        'STATE_RUN_NOT_FOUND',
        'nope',
        0,
        'report_to_user',
      ]);
      expect(r.command).toBe(fn === 'advanceRun' ? 'advanceRun' : 'after');
    },
  );

  it('C156: advanceRun on a run file that is not JSON — RESOURCE_FORMAT_INVALID naming the file; a WorkflowError the store throws keeps its code; any other is ENGINE_STORE_FAILED naming its cause', async () => {
    claim(CANNOT_READ);
    const d = gated();
    // A run FILE that is not JSON: this cell's own JSON store (the docs sentence names one).
    const json = await clockedJsonStore('realm-dc-625-file-');
    const jsonDir = json.runsDirPath;
    await writeFile(join(jsonDir, 'broken.json'), '{not json');
    const broken = await advanceRun(json, d, { runId: 'broken' });
    const lost = await advanceRun(untyped(), d, { runId: 'r' });
    const typed = Object.create(json) as RunStore;
    Object.assign(typed, {
      get: async () => {
        throw new WorkflowError('the store is offline', {
          code: 'ENGINE_STORE_FAILED',
          category: 'ENGINE',
          agentAction: 'wait_for_service',
          retryable: true,
        });
      },
    });
    const offline = await advanceRun(typed, d, { runId: 'r' });
    // (a) red when advanceRun throws, or loses the store's own code; (b) prints the replies.
    expect([broken.status, broken.error_code]).toEqual(['error', 'RESOURCE_FORMAT_INVALID']);
    expect(broken.errors[0]).toMatch(/^The run file '.*broken\.json' is not JSON\. Restore /);
    expect([offline.status, offline.error_code, offline.errors]).toEqual([
      'error',
      'ENGINE_STORE_FAILED',
      ['the store is offline'],
    ]);
    expect([lost.status, lost.error_code, lost.errors]).toEqual([
      'error',
      'ENGINE_STORE_FAILED',
      ['Failed to load run from store: the disk is gone'],
    ]);
  });

  // #616 PR-2c c12: the row now describes the SQLite store — the JSON store's EBUSY / EIO clause is gone
  // from the page with that store; the untyped wrap is still not worth retrying, and a store that stays
  // busy is the SQLite store's own refusal (`STATE_RUN_BUSY`, store-sqlite connection.ts and its busy cells).
  it('issue #719 (C2), #616 PR-2c c12, error-codes.md: `Failed to load run from store: …` is not worth retrying', () => {
    const sentence =
      '`Failed to load run from store: …` is not worth retrying; a store that stays busy past its wait is reported by the SQLite store with its own line, not with this code.';
    const page = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../../../../docs/reference/error-codes.md'),
      'utf8',
    );
    expect(flat(page), `error-codes.md no longer says: ${sentence}`).toContain(flat(sentence));
    // (a) red when the untyped wrap becomes worth retrying; (b) prints it.
    expect({ untyped: runReadError(new Error('the disk is gone')).retryable }).toEqual({
      untyped: false,
    });
  });

  const STEP_CANNOT_READ =
    "`executeStep`, `executeChain` and `submitHumanResponse` answer a run they cannot read with an error reply, never a throw (`submitHumanResponse`'s names `command: submit_gate`): `STATE_RUN_NOT_FOUND` for a run that does not exist, the store's own code for an error it throws as a `WorkflowError` (a `JsonFileStore` run file that cannot be read as a run, for one: `RESOURCE_FORMAT_INVALID`, `STATE_LEGACY_FORMAT` or `ENGINE_STORE_FAILED`, naming the file and its way out), and `ENGINE_STORE_FAILED` for any other, naming its cause (`Failed to load run from store: <its message>`).";
  const NO_PHASE = 'Such a reply names no `run_phase`: no run was read.';
  /** A store whose every read throws the store's own typed error. */
  const offline = () => {
    const typed = Object.create(store) as RunStore;
    Object.assign(typed, {
      get: async () => {
        throw new WorkflowError('the store is offline', {
          code: 'ENGINE_STORE_FAILED',
          category: 'ENGINE',
          agentAction: 'wait_for_service',
          retryable: true,
        });
      },
    });
    return typed;
  };

  it.each(['executeStep', 'executeChain', 'submitHumanResponse'] as const)(
    'C156 class (finding 3 built; C168): %s on a run it cannot read — not found, the store’s own WorkflowError, a run file that is not JSON, an untyped failure — an error reply each, naming the cause, no run_phase, never a throw',
    async (fn) => {
      claim(STEP_CANNOT_READ);
      claim(NO_PHASE);
      const d = gated();
      // A run FILE that is not JSON: this cell's own JSON store (the docs sentence names one).
      const json = await clockedJsonStore('realm-dc-625-file-');
      const jsonDir = json.runsDirPath;
      await writeFile(join(jsonDir, 'broken.json'), '{not json');
      const call = (s: RunStore, runId: string) =>
        fn === 'executeStep'
          ? executeStep(s, d, { runId, command: 'after', input: {}, dispatcher })
          : fn === 'executeChain'
            ? executeChain(s, d, { runId, command: 'after', input: {}, dispatcher })
            : submitHumanResponse(s, d, { runId, gateId: 'g', choice: 'approve' });
      const replies = [
        await call(json, 'nope'),
        await call(offline(), 'r'),
        await call(json, 'broken'),
        await call(untyped(), 'r'),
      ];
      const command = fn === 'submitHumanResponse' ? 'submit_gate' : 'after';
      // (a) red when the call throws for any of them, a code changes, the cause is dropped, or the
      //     reply names a phase; (b) prints the replies.
      expect(replies.map((r) => [r.status, r.error_code, r.command, r.run_phase])).toEqual([
        ['error', 'STATE_RUN_NOT_FOUND', command, undefined],
        ['error', 'ENGINE_STORE_FAILED', command, undefined],
        ['error', 'RESOURCE_FORMAT_INVALID', command, undefined],
        ['error', 'ENGINE_STORE_FAILED', command, undefined],
      ]);
      expect(replies.map((r) => r.errors[0])).toEqual([
        'Run not found: nope',
        'the store is offline',
        expect.stringMatching(/^The run file '.*broken\.json' is not JSON\. Restore /),
        'Failed to load run from store: the disk is gone',
      ]);
    },
  );

  const NOW_ROW =
    "A call judges an open question's expiry by its store's clock: it carries out an expired question's declared `on_expiry` first only when the question's time is up at the store's reading (the `now` option that set this time is removed after version 0.48.0).";
  it.each(['executeStep', 'executeChain'] as const)(
    "C157, W1-Y3: %s judges the question by the store's clock — time up at its reading: carried out first; not up: left open",
    async (fn) => {
      claim(NOW_ROW);
      const d = gated();
      const call = async (runId: string, now: Date) => {
        await clock.set(now);
        return fn === 'executeStep'
          ? executeStep(store, d, { runId, command: 'after', input: {}, dispatcher })
          : executeChain(store, d, { runId, command: 'after', input: {}, dispatcher });
      };
      const up = await atQuestion(d);
      const carried = await call(up.runId, LATER());
      const notUp = await atQuestion(d);
      const left = await call(notUp.runId, EARLIER());
      // (a) red when the call judges by another clock than the store's; (b) prints the replies.
      expect([
        carried.status,
        carried.warnings.some((w) => w.includes(`this ${fn} call first carried out`)),
      ]).toEqual(['ok', true]);
      expect([left.status, left.warnings]).toEqual(['blocked', []]);
      expect((await store.get(notUp.runId)).record.pending_gate?.gate_id).toBe(notUp.gateId);
    },
  );

  // --- executeEngineStep, dispatcher, describePending (lines 103, 104, 117) ----------------------
  it('C163 line 104: executeEngineStep runs one auto step the way the engine runs it — ok, the step completed', async () => {
    claim('Runs one `auto` step the way the engine runs it.');
    const d: WorkflowDefinition = {
      id: 'dc-eng',
      name: 'e',
      version: 1,
      steps: { only: { description: 'O.', execution: 'auto', depends_on: [] } },
    };
    const { record: run } = await store.create({
      workflowId: d.id,
      workflowVersion: 1,
      params: {},
    });
    const r = await executeEngineStep(store, d, {
      runId: run.id,
      step: 'only',
      run: (await store.get(run.id)).record,
    });
    expect([r.status, r.run_phase, (await store.get(run.id)).record.completed_steps]).toEqual([
      'ok',
      'completed',
      ['only'],
    ]);
  });

  it('C163 line 122: submitHumanResponse takes respondedBy — the answer records that name', async () => {
    claim(
      '`submitHumanResponse` takes `runId`, `gateId`, `choice`, and optionally, among others, `registry`, `respondedBy` and `caller`.',
    );
    const d = gated();
    const { runId, gateId } = await atQuestion(d);
    const r = await submitHumanResponse(store, d, {
      runId,
      gateId,
      choice: 'approve',
      respondedBy: 'alice',
    });
    expect(r.status).toBe('ok');
    const { composeStepViews } = await import('./step-view.js');
    expect(
      composeStepViews((await store.get(runId)).record)['q']?.answers?.[0]?.answered_by,
    ).toMatchObject({
      by: 'alice',
    });
  });

  it('C169, W3-Y2: executeEngineStep, given run, answers a run that does not exist or cannot be read as executeStep does; without a run record it rejects VALIDATION_OPTION_INVALID naming the fields', async () => {
    claim(
      'A run that does not exist or cannot be read gets the error reply `executeStep` gives (below).',
    );
    claim(
      "`run` is required, and must be a run record (each of the record's required fields, with its type): otherwise the call rejects with `VALIDATION_OPTION_INVALID` before anything is read or written, naming, when `run` is an object, each field that is missing or of the wrong type.",
    );
    const d = gated();
    // A run FILE that is not JSON: this cell's own JSON store (the docs sentence names one); the
    // run at its question opened on it as `atQuestion` opens one.
    const json = await clockedJsonStore('realm-dc-625-file-');
    const jsonDir = json.runsDirPath;
    const { record: asked } = await json.create({
      workflowId: d.id,
      workflowVersion: 1,
      params: {},
    });
    const opened = await executeStep(json, d, {
      runId: asked.id,
      command: 'q',
      input: {},
      dispatcher,
    });
    if (opened.status !== 'confirm_required') throw new Error(`fixture: ${opened.status}`);
    const runId = asked.id;
    const { record: record } = await json.get(runId);
    await writeFile(join(jsonDir, 'broken.json'), '{not json');
    const missing = await executeEngineStep(json, d, {
      runId: 'nope',
      step: 'after',
      run: record,
    });
    const broken = await executeEngineStep(json, d, {
      runId: 'broken',
      step: 'after',
      run: record,
    });
    // (a) red when either throws or answers otherwise than executeStep; (b) prints them.
    expect([missing.error_code, missing.errors[0], broken.error_code]).toEqual([
      'STATE_RUN_NOT_FOUND',
      'Run not found: nope',
      'RESOURCE_FORMAT_INVALID',
    ]);
    expect(broken.errors[0]).toMatch(/^The run file '.*broken\.json' is not JSON\. Restore /);
    const before = JSON.stringify((await json.get(runId)).record);
    // (a) red when a call runs without a run record, or throws anything else; (b) prints the rejection.
    await expect(
      executeEngineStep(json, d, { runId, step: 'after' } as never),
    ).rejects.toMatchObject({
      code: 'VALIDATION_OPTION_INVALID',
      details: { invalid: [{ option: 'options.run', given_type: 'undefined' }] },
    });
    await expect(
      executeEngineStep(json, d, { runId, step: 'after', run: { id: runId } } as never),
    ).rejects.toMatchObject({
      code: 'VALIDATION_OPTION_INVALID',
      message: expect.stringContaining(
        'options.run must be a run record (got object) (workflow_id is missing; ',
      ),
    });
    // issue #719 (C2): the fields are named only when `run` is an object — a `null` run, none.
    const nullRun = (await executeEngineStep(json, d, {
      runId,
      step: 'after',
      run: null,
    } as never).catch((e: unknown) => e)) as WorkflowError;
    const first = (nullRun.details['invalid'] as Array<Record<string, unknown>>)[0] ?? {};
    // (a) red when a field list is claimed for a run that is not an object; (b) prints the code
    //     and whether a field list was named.
    expect({ code: nullRun.code, fieldsNamed: 'fields' in first }).toEqual({
      code: 'VALIDATION_OPTION_INVALID',
      fieldsNamed: false,
    });
    // issue #719 (C5): a boolean — a failure prints whether the record is unchanged, never it.
    expect(JSON.stringify((await json.get(runId)).record) === before).toBe(true);
    // C174: a step with no `depends_on` — the same refusal, before any read.
    const lone: WorkflowDefinition = {
      id: 'dc-lone',
      name: 'l',
      version: 1,
      steps: { only: { description: 'Only.', execution: 'auto', depends_on: [] } },
    };
    const { record: loneRun } = await json.create({
      workflowId: lone.id,
      workflowVersion: 1,
      params: {},
    });
    await expect(
      executeEngineStep(json, lone, { runId: loneRun.id, step: 'only' } as never),
    ).rejects.toMatchObject({ code: 'VALIDATION_OPTION_INVALID' });
  });

  it('C163 line 104: executeEngineStep on an agent step rejects with a WorkflowError and writes nothing', async () => {
    claim(
      'For an agent, guard or finalizer step it rejects with a `WorkflowError` and writes nothing.',
    );
    const d: WorkflowDefinition = {
      id: 'dc-agent',
      name: 'a',
      version: 1,
      steps: { a: { description: 'A.', execution: 'agent', depends_on: [] } },
    };
    const { record: run } = await store.create({
      workflowId: d.id,
      workflowVersion: 1,
      params: {},
    });
    const before = JSON.stringify((await store.get(run.id)).record);
    await expect(
      executeEngineStep(store, d, {
        runId: run.id,
        step: 'a',
        run: (await store.get(run.id)).record,
      }),
    ).rejects.toBeInstanceOf(WorkflowError);
    expect(JSON.stringify((await store.get(run.id)).record)).toBe(before);
  });

  it('C163 line 117: the dispatcher is called for the step command names (an agent step, a bare auto step), not for the steps executeChain runs after it', async () => {
    claim(
      'A function Realm calls for the step `command` names when it is an agent step, or an `auto` step with neither `uses_service` nor `handler`.',
    );
    claim('`executeChain` does not call it for the steps it runs after that one.');
    // issue #719 (C4): "as a plain value" is pinned by dispatcher-timer-719.test.ts (b) — a plain
    // object returned by the dispatcher is the step's recorded output.
    claim(
      "What it returns, as a plain value or through a promise, is recorded as the agent step's answer, or as that `auto` step's output.",
    );
    const d: WorkflowDefinition = {
      id: 'dc-disp',
      name: 'd',
      version: 1,
      steps: {
        a: { description: 'A.', execution: 'agent', depends_on: [] },
        bare: { description: 'B.', execution: 'auto', depends_on: ['a'] },
        later: { description: 'L.', execution: 'auto', depends_on: ['bare'] },
      },
    };
    const calls: string[] = [];
    const disp = async (step: string) => (calls.push(step), { ok: true });
    const { record: run } = await store.create({
      workflowId: d.id,
      workflowVersion: 1,
      params: {},
    });
    await executeChain(store, d, { runId: run.id, command: 'a', input: {}, dispatcher: disp });
    // (a) red when the dispatcher is skipped for the named agent step or called for chained steps; (b) prints the calls.
    expect(calls).toEqual(['a']);
    const { record: run2 } = await store.create({
      workflowId: d.id,
      workflowVersion: 1,
      params: {},
    });
    await executeStep(store, d, {
      runId: run2.id,
      command: 'a',
      input: {},
      dispatcher: async () => ({}),
    });
    const calls2: string[] = [];
    await executeChain(store, d, {
      runId: run2.id,
      command: 'bare',
      input: {},
      dispatcher: async (step: string) => (calls2.push(step), {}),
    });
    expect(calls2).toEqual(['bare']);
    const ev = (await store.get(run.id)).record.evidence.find(
      (e) => e.step_id === 'a',
    ) as unknown as {
      output_summary?: unknown;
    };
    const ev2 = (await store.get(run2.id)).record.evidence.find(
      (e) => e.step_id === 'bare',
    ) as unknown as { output_summary?: unknown };
    expect([JSON.stringify(ev?.output_summary), JSON.stringify(ev2?.output_summary)]).toEqual([
      '{"ok":true}',
      '{}',
    ]);
  });

  it('C163 line 103: describePending says what a run waits for, with every field the row names', async () => {
    // #715 (b) (02 §A.1): the row names the snapshot `store.get` returns, in place of `run` and `now`.
    claim(
      '`registry` may be `undefined`; `snapshot` is what `store.get(runId)` returns, `{ record, at }`, and the run is judged at its `at` (added after version 0.48.0, in place of `run` and `now`).',
    );
    claim(
      'Says what a run is waiting for, as an object with: `agent_steps` (the agent steps ready for an answer), `agent_refused` (the ready agent steps the run refuses before their claim, and why), `pending_guards` (the guard steps ready to be decided), `engine_runnable` (the `auto` steps it owes, each with `runnable_here`), `cannot_run` (every step that cannot run, and why),',
    );
    const d = gated();
    const { runId, gateId } = await atQuestion(d);
    // The row's own call: the snapshot `store.get` returns.
    const p = describePending(d, await store.get(runId), undefined);
    // (a) red when a field the row names is dropped; (b) prints the keys.
    for (const k of [
      'agent_steps',
      'owed',
      'agent_refused',
      'pending_guards',
      'engine_runnable',
      'cannot_run',
    ]) {
      expect(p, k).toHaveProperty(k);
    }
    expect(p.open_question).toMatchObject({
      step: 'q',
      gate_id: gateId,
      choices: ['approve', 'reject'],
    });
    expect(
      describePending(d, writtenSnapshot((await store.get(runId)).record, LATER()), undefined)
        .expiry_due,
    ).toBeDefined();
    // #729 PR-0 (D-L): what the engine owes is `owed` (it replaced `act`): the due expiry first.
    expect(
      describePending(d, writtenSnapshot((await store.get(runId)).record, LATER()), undefined).owed,
    ).toEqual([{ expiry: { gate_id: gateId, step: 'q', on_expiry: 'settle_default' } }]);
    expect(
      describePending(d, writtenSnapshot((await store.get(runId)).record, new Date()), undefined)
        .owed,
    ).toEqual([]);
    await submitHumanResponse(store, d, { runId, gateId, choice: 'approve' });
    const owed = describePending(
      d,
      writtenSnapshot((await store.get(runId)).record, new Date()),
      undefined,
    );
    expect(owed.engine_runnable.map((e) => [e.step, typeof e.runnable_here])).toEqual([
      ['after', 'boolean'],
    ]);
    expect(owed.owed).toEqual([{ step: 'after' }]);
  });

  // --- driver (lines 125–133) -----------------------------------------------------------------
  it.each([
    ['by', { by: '', by_source: 'stated', channel: 'cron' }, 'Invalid driver.by: empty.'],
    [
      'by_source',
      { by: 'n', by_source: 'program', channel: 'cron' },
      'Invalid driver.by_source: not one of stated, ambient, derived, key.',
    ],
    [
      'channel',
      { by: 'n', by_source: 'stated', channel: 'CRON' },
      'Invalid driver.channel: not 1–64 characters of [a-z0-9_-].',
    ],
  ] as const)(
    'C163 line 133: a driver whose %s is not one the table lists rejects VALIDATION_ACTOR_INVALID naming the field, nothing read or written — from each of the four functions',
    async (_field, driver, message) => {
      claim(
        'With any other value the call rejects with a `WorkflowError` with the code `VALIDATION_ACTOR_INVALID` before anything is read or written, naming the field',
      );
      claim(
        "`executeStep`, `executeChain`, `submitHumanResponse` and `advanceRun` take an optional `driver`, your program's name: `{ by, by_source, channel }`.",
      );
      const d = gated();
      const { runId, gateId } = await atQuestion(d);
      const before = JSON.stringify((await store.get(runId)).record);
      const dr = driver as never;
      for (const call of [
        () => advanceRun(store, d, { runId, driver: dr }),
        () => executeStep(store, d, { runId, command: 'after', input: {}, dispatcher, driver: dr }),
        () =>
          executeChain(store, d, { runId, command: 'after', input: {}, dispatcher, driver: dr }),
        () => submitHumanResponse(store, d, { runId, gateId, choice: 'approve', driver: dr }),
      ]) {
        await expect(call()).rejects.toMatchObject({ code: 'VALIDATION_ACTOR_INVALID', message });
      }
      expect(JSON.stringify((await store.get(runId)).record)).toBe(before);
    },
  );

  it('C163 lines 129–131: a driver with values the table takes is accepted and written as driven_by on the auto step the call runs', async () => {
    claim('The name: text of 1 to 200 characters, not only spaces, with no control character.');
    claim(
      'Your own word for the way the call came in: 1 to 64 characters of `a`–`z`, `0`–`9`, `_` and `-`, such as `cron`.',
    );
    claim(
      'How the name is known: `stated` (your program says it), `ambient` (from the environment, as `REALM_OPERATOR` is), `derived` (from the OS user) or `key` (the name of a `realm serve` key the caller presented; added after version 0.50.0).',
    );
    const plain: WorkflowDefinition = {
      id: 'dc-drv',
      name: 'p',
      version: 1,
      steps: { only: { description: 'O.', execution: 'auto', depends_on: [] } },
    };
    for (const by_source of ['stated', 'ambient', 'derived', 'key'] as const) {
      const { record: run } = await store.create({
        workflowId: plain.id,
        workflowVersion: 1,
        params: {},
      });
      const r = await advanceRun(store, plain, {
        runId: run.id,
        driver: { by: 'n'.repeat(200), by_source, channel: 'a_b-9' },
      });
      expect([r.status, r.run_phase]).toEqual(['ok', 'completed']);
      const ev = (await store.get(run.id)).record.evidence.find(
        (e) => e.step_id === 'only',
      ) as unknown as { driven_by?: { by: string } };
      expect(ev?.driven_by?.by).toBe('n'.repeat(200));
    }
  });
});

describe('#625 PR-2a, C174 — the sweep’s corrected sentences about the library', () => {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
  const page = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\s+/g, ' ');
  let clock: SettableClock;
  let store: InMemoryStore;

  it('handlers.md (#729 PR-0, Amendment 12): the agentAction row lists exactly the AgentAction type’s members', () => {
    const types = readFileSync(join(ROOT, 'packages/core/src/types/workflow-error.ts'), 'utf8');
    const decl = types.slice(types.indexOf('export type AgentAction'));
    const members = [...decl.slice(0, decl.indexOf(';')).matchAll(/'([a-z_]+)'/g)].map(
      (m) => m[1]!,
    );
    const row =
      page('docs/reference/handlers.md').match(/\| `agentAction` \| Yes \|([^|]*)\|/)?.[1] ?? '';
    const listed = [...row.split('(')[0]!.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]!);
    // (a) red when the page's list and the type's members differ (a member added or renamed in one
    //     only — `wait_for_human`, `await`); (b) prints both, sorted.
    expect(listed.sort()).toEqual(members.sort());
    // Not vacuous: the type has its seven members, `await` and `wait_for_service` among them.
    expect(members).toEqual(expect.arrayContaining(['await', 'wait_for_service']));
    expect(members).toHaveLength(7);
  });
  beforeEach(() => {
    clock = settableClock(new Date());
    store = new InMemoryStore({ clock });
  });
  async function atQuestion(d: WorkflowDefinition) {
    // #715 (b): each question opens at the host's time (a cell may have moved the store's clock).
    await clock.set(new Date());
    const { record: run } = await store.create({
      workflowId: d.id,
      workflowVersion: 1,
      params: {},
    });
    await executeStep(store, d, { runId: run.id, command: 'q', input: {}, dispatcher });
    return { runId: run.id };
  }

  it('packages/core/README.md: the reply is an EngineReply — its ways say what can be done next: agent steps, the engine’s owed work, the open question (#729 PR-0; buildNextActions died)', async () => {
    const sentence =
      "Each `executeStep` call advances the run and returns an `EngineReply`: the run's state, and in `ways` what can be done next (in `unavailable`, what cannot, and why).";
    expect(page('packages/core/README.md'), 'README no longer says it').toContain(sentence);
    const owes: WorkflowDefinition = {
      id: 'dc-owes',
      name: 'o',
      version: 1,
      steps: {
        x: { description: 'X.', execution: 'agent', depends_on: [] },
        y: { description: 'Y.', execution: 'auto', depends_on: [] },
      },
    };
    const { record: run } = await store.create({
      workflowId: owes.id,
      workflowVersion: 1,
      params: {},
    });
    const d = gated();
    const { runId } = await atQuestion(d);
    const reply = await executeStep(store, owes, {
      runId: run.id,
      command: 'zz-not-a-step',
      input: {},
      dispatcher,
    });
    // (a) red when the agent step, the owed work or the question's answer is left out of the ways;
    //     (b) prints both lists.
    expect([
      nextCalls(reply),
      nextCalls(
        composeWaysAt((await store.get(runId)).record, new Date(), {
          persistsClaims: false,
          definition: d,
        }),
      ),
    ]).toEqual([['run_step:x', 'advance'], ['respond']]);
    // The call's own verdict rides `refusal` (D-A); the reply's ways stay the run's.
    expect(reply.refusal?.code).toBe('not_a_step');
  });

  it('packages/core/README.md (C184, walk c8, W3-a): the Engine table lists advanceRun — it carries out an expired question, then the guards and auto steps owed', async () => {
    const sentence =
      "| `advanceRun` | Run what a run owes the engine — an expired question's declared `on_expiry`, then its guards and `auto` steps. Returns `EngineReply`. |";
    // (a) red when the README's Engine table drops the row or rewords it; (b) prints the row.
    expect(
      page('packages/core/README.md').replace(/ +\|/g, ' |'),
      'README no longer says it',
    ).toContain(sentence);
    const d: WorkflowDefinition = {
      ...gated(),
      id: 'dc-c184',
      steps: {
        ...gated().steps,
        ok: {
          description: 'Only if approved.',
          execution: 'guard',
          depends_on: ['q'],
          abort_unless: ["q.choice == 'approve'"],
        },
        after: { description: 'After.', execution: 'auto', depends_on: ['ok'] },
      },
    };
    const { runId } = await atQuestion(d);
    await clock.set(LATER());
    const reply = await advanceRun(store, d, { runId });
    // (a) red when advanceRun does not carry out the expired question first, or leaves the guard or
    //     the auto step it made owed; (b) prints the reply's fields.
    expect({
      status: reply.status,
      expiry: reply.warnings.some((w) => w.includes('this advanceRun call first carried out')),
      ran: reply.chained_auto_steps?.map((c) => c.step),
      phase: (await store.get(runId)).record.run_phase,
    }).toEqual({ status: 'ok', expiry: true, ran: ['after'], phase: 'completed' });
  });

  it('error-codes.md: the page counts every code the ErrorCode type defines', () => {
    const types = readFileSync(join(ROOT, 'packages/core/src/types/workflow-error.ts'), 'utf8');
    const lines = types.slice(types.indexOf('export type ErrorCode')).split('\n');
    const end = lines.findIndex((l) => /^\s*\| '[A-Z0-9_]+';/.test(l));
    const defined = new Set(
      lines
        .slice(0, end + 1)
        .map((l) => /^\s*\| '([A-Z0-9_]+)'/.exec(l)?.[1])
        .filter((c) => c !== undefined),
    );
    const text = page('docs/reference/error-codes.md');
    // (a) red when the page's count is not the type's; (b) prints both.
    expect(text).toContain(`This page lists all ${defined.size} codes that Realm defines`);
  });
  it('run-record-and-export.md: the page counts the evidence entry’s fields as the type defines them', () => {
    const types = readFileSync(join(ROOT, 'packages/core/src/types/run-record.ts'), 'utf8');
    const body = types.slice(types.indexOf('export interface EvidenceSnapshot {'));
    const fields = body
      .slice(0, body.indexOf('\n}'))
      .split('\n')
      .filter((l) => /^ {2}[a-z_]+\??:/.test(l)).length;
    // (a) red when the page's count is not the type's, or its rows are not the fields less the
    //     two rows that hold two fields each; (b) prints both.
    expect(page('docs/reference/run-record-and-export.md')).toContain(
      `the ${fields} fields of an evidence entry (${fields - 2} rows below: two rows hold two fields each),`,
    );
  });
});

// issue #760: the sentences `docs/reference/handlers.md` adds or changes about `check_quotes` and
// `locateQuote`, each quoted and then executed; and the CHANGELOG's #760 bullets under their
// headings. What a failing cell prints: the sentence, or the values it compares.
describe('#760 — handlers.md: check_quotes and locateQuote', () => {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
  const HANDLERS = 'docs/reference/handlers.md';
  const raw = (p: string) => readFileSync(join(ROOT, p), 'utf8');
  const flatten = (t: string) => t.replace(/\s+/g, ' ');
  /** (a) red when the page no longer holds the sentence word for word; (b) prints it. */
  const claimOn = (p: string, sentence: string): void => {
    expect(flatten(raw(p)), `${p} no longer says: ${sentence}`).toContain(flatten(sentence));
  };
  /** The fenced block of the page that holds `marker`. */
  const block = (p: string, marker: string): string => {
    const blocks = raw(p)
      .split(/^```[a-z]*\n/m)
      .filter((_, i) => i % 2 === 1);
    return blocks.find((b) => b.includes(marker)) ?? '';
  };
  /** The body rows of the page's table whose header row starts with `header`, as cell lists. */
  const rows = (p: string, header: string): string[][] => {
    const lines = raw(p).split('\n');
    const top = lines.findIndex((l) => l.startsWith(`| ${header}`));
    const body: string[][] = [];
    for (let i = top + 2; top >= 0 && lines[i]?.startsWith('|'); i++) {
      body.push(
        lines[i]!.split('|')
          .slice(1, -1)
          .map((c) => c.trim()),
      );
    }
    return body;
  };

  const DOC = 'The rent is €48,000 a year, paid quarterly in advance on the usual quarter days.';

  it(':135 — `realm run inspect` prints a handler warning on its Warn: line; `realm agent` does not', () => {
    // The Warn: line itself is pinned by the CLI's `inspect.test.ts` ("the Warn: line (issue #760)").
    claimOn(
      HANDLERS,
      "A caller over MCP gets it in the reply's `warnings` list. `realm run inspect` prints it on the step's `Warn:` line; `realm agent` does not print it. To read it afterwards, use `realm run export`.",
    );
  });

  it(':339 — check_quotes is registered; a step naming an old name is blocked, the run kept open (correction 1, 05 item 1)', async () => {
    claimOn(
      HANDLERS,
      '`check_quotes` is registered, added after version 0.47.1 (see [Built-in handlers](#built-in-handlers)). `validate_verbatim_quotes` and `validate_field_match` were never registered: a step naming them is blocked, as any unregistered handler is (above).',
    );
    const registry = createDefaultRegistry();
    const def = {
      id: 'docs-760-old',
      name: 'O',
      version: 1,
      steps: {
        extract: { description: 'E', execution: 'agent', depends_on: [] },
        verify: {
          description: 'V',
          execution: 'auto',
          handler: 'validate_verbatim_quotes',
          depends_on: ['extract'],
        },
      },
    } as unknown as WorkflowDefinition;
    const store = new InMemoryStore({ clock: settableClock(new Date()) });
    const { record: run } = await store.create({
      workflowId: def.id,
      workflowVersion: 1,
      params: {},
    });
    const reply = await executeChain(store, def, {
      runId: run.id,
      command: 'extract',
      registry,
      input: { text: 'x' },
      dispatcher: async (_n, i) => ({ ...i }),
    });
    const { record: after } = await store.get(run.id);
    // (a) red when check_quotes is not registered, an old name is, or a step naming it ends the run;
    //     (b) prints three booleans, the code and the run's end.
    expect({
      registered: [
        registry.has('handler', 'check_quotes'),
        registry.has('handler', 'validate_verbatim_quotes'),
        registry.has('handler', 'validate_field_match'),
      ],
      code: reply.error_code,
      ended: after.terminal_state === true,
    }).toEqual({
      registered: [true, false, false],
      code: 'ENGINE_HANDLER_NOT_REGISTERED',
      ended: false,
    });
  });

  it(':5, :7 and :343 — the 6 helpers; one built-in handler; every default registry has it, a bare one does not (correction 1, 05 items 2, 13)', () => {
    claimOn(HANDLERS, 'and the 6 helper functions that `@sensigo/realm` exports for handlers.');
    claimOn(
      HANDLERS,
      'Realm has one handler of its own, `check_quotes` (see [Built-in handlers](#built-in-handlers)); every other handler a workflow names comes from the project.',
    );
    claimOn(
      HANDLERS,
      'Every registry `createDefaultRegistry()` returns has them: the CLI, `realm agent`, `realm listen`, the MCP server and the testing runner. A registry built with `new ExtensionRegistry()` does not.',
    );
    const helpers = [
      'resolveResource',
      'walkField',
      'partitionBySubstring',
      'countResults',
      'compareStrings',
      'locateQuote',
    ];
    const exported = core as unknown as Record<string, unknown>;
    // (a) red when the count, the handler list or a registry drifts; (b) prints the count, the
    //     handler names and a boolean. (The door list is the census's reading, F760-PIN-09: every
    //     one of them builds its registry with createDefaultRegistry.)
    expect({
      helpers: helpers.filter((n) => typeof exported[n] === 'function').length,
      handlers: createDefaultRegistry().names('handler'),
      bare: new ExtensionRegistry().has('handler', 'check_quotes'),
    }).toEqual({ helpers: 6, handlers: ['check_quotes'], bare: false });
  });

  it('core-library.md and deployment-manifest.md name the built-in handler (correction 1, 05 items 14, 15)', () => {
    claimOn(
      'docs/reference/core-library.md',
      'Returns an `ExtensionRegistry` that holds the `filesystem` adapter and the `check_quotes` handler.',
    );
    claimOn(
      'docs/reference/core-library.md',
      'The adapters and handlers the steps can use. Without it, only the `filesystem` adapter and the `check_quotes` handler.',
    );
    claimOn(
      'docs/reference/deployment-manifest.md',
      'The manifest has no catalogue for handlers or processors; the built-in handler `check_quotes` needs no entry.',
    );
    const registry = createDefaultRegistry();
    // (a) red when the default registry holds another handler set, or loses the adapter; (b) prints
    //     the names.
    expect({
      handlers: registry.names('handler'),
      adapter: registry.has('adapter', 'filesystem'),
    }).toEqual({
      handlers: ['check_quotes'],
      adapter: true,
    });
  });

  it(':343 — six helper functions, the import block names them, and each is exported', () => {
    claimOn(HANDLERS, '`@sensigo/realm` exports 6 functions for use inside handlers.');
    const names = [...block(HANDLERS, '  partitionBySubstring,').matchAll(/^ {2}(\w+),$/gm)].map(
      (m) => m[1]!,
    );
    const exported = core as unknown as Record<string, unknown>;
    // (a) red when the count, the list or an export drifts; (b) prints the names and their kinds.
    expect(names.map((n) => [n, typeof exported[n]])).toEqual(
      [
        'resolveResource',
        'walkField',
        'partitionBySubstring',
        'countResults',
        'compareStrings',
        'locateQuote',
      ].map((n) => [n, 'function']),
    );
  });

  it('the config table lists the handler’s keys, with its defaults', async () => {
    const table = rows(HANDLERS, '`config` key');
    const result = await new CheckQuotesHandler().execute(
      { params: {} },
      {
        run_id: 'r',
        run_params: {},
        config: { source_step: 'doc', candidates_step: 'extract' },
        resources: {
          doc: { text: DOC },
          extract: {
            candidates: [{ field: 'f', quote: 'paid quarterly in advance on the usual' }],
          },
        },
      },
    );
    const state = (result.data?.['results'] as Array<{ quote_check: { state: string } }>)[0]!
      .quote_check.state;
    // (a) red when a key is missing from the table, a default differs, or the defaults are not the
    //     handler's (the defaulted fields would not be read); (b) prints the rows' key and default,
    //     and the state.
    expect({ table: table.map((c) => [c[0], c[1]]), state }).toEqual({
      table: [
        ['`source_step`', 'required'],
        ['`source_field`', '`text`'],
        ['`candidates_step`', 'required'],
        ['`candidates_field`', '`candidates`'],
        ['`quote_field`', '`quote`'],
        ['`min_part_chars`', '`20`'],
      ],
      state: 'exact',
    });
  });

  it('the states table lists the six states, in order', () => {
    claimOn(HANDLERS, "The state describes the quote's match, never the value's correctness.");
    // (a) red when a state is renamed, added or dropped on one side only; (b) prints both lists.
    expect(rows(HANDLERS, 'State').map((c) => c[0]!.replace(/`/g, ''))).toEqual([...QUOTE_STATES]);
  });

  it('the record and the warning shown are what the step returns for that document', async () => {
    const shown = JSON.parse(block(HANDLERS, '"candidates_found"')) as {
      results: Array<Record<string, unknown>>;
    };
    const candidates = shown.results.map(({ quote_check: _qc, ...c }) => c);
    const result = await new CheckQuotesHandler().execute(
      { params: {} },
      {
        run_id: 'r',
        run_params: {},
        // Correction 1 (05 item 11): the guard pattern's own config, so the warning names the
        // source the workflow below reads.
        config: {
          source_step: 'fetch_document',
          candidates_step: 'extract_fields',
          candidates_field: 'fields',
        },
        resources: { fetch_document: { text: DOC }, extract_fields: { fields: candidates } },
      },
    );
    claimOn(HANDLERS, `The step's output, for a document \`${DOC}\` and two values:`);
    // (a) red when the shown output or warning drifts from what the step returns; (b) prints both.
    expect({ data: result.data, warning: result.warn?.message }).toEqual({
      data: shown,
      warning: block(HANDLERS, 'Quote check: 1 of 2').trim(),
    });
  });

  it('the guard pattern: the guard depends on the check, and the pattern stops the run `aborted`', async () => {
    claimOn(
      HANDLERS,
      "The guard needs `depends_on: [quote_check]`. Without it the guard is checked when the run starts, before the check has an output, and the run ends `failed` with a resolution error instead of `aborted`. With it, the run ends `aborted` and the check's record is kept.",
    );
    // "Without it … `failed`" is pinned by `check-quotes.test.ts` ("without depends_on the guard
    // runs first and the run FAILS"). Correction 1 (05 item 13b): the block is a whole workflow —
    // loaded as registering loads it, and run once with an altered quote.
    claimOn(
      HANDLERS,
      "A whole workflow: the document's text comes in the run's params, the agent extracts the values, the check reads both, and the guard stops the run:",
    );
    const def = loadWorkflowFromString(block(HANDLERS, 'handler: check_quotes'));
    const store = new InMemoryStore({ clock: settableClock(new Date()) });
    const { record: run } = await store.create({
      workflowId: def.id,
      workflowVersion: 1,
      params: { text: DOC },
    });
    await advanceRun(store, def, { runId: run.id, registry: createDefaultRegistry() });
    // Correction 2 (03, D4): the agent step's prompt carries the document, read from the record
    // after `advanceRun` ran `fetch_document` (the record as first created renders none).
    // #715 (b) (02 §D.4): the brief renders at the read's own reading.
    const prompt = stepBrief(def, await store.get(run.id), 'extract_fields').prompt;
    const reply = await executeChain(store, def, {
      runId: run.id,
      command: 'extract_fields',
      registry: createDefaultRegistry(),
      input: {
        fields: [
          { field: 'annual_rent', value: '48000', quote: 'The rent is €48,000 a year' },
          { field: 'payment', value: 'quarterly', quote: 'the rent is paid quarterly' },
        ],
      },
      dispatcher: async (_n, i) => ({ ...i }),
    });
    const { record: after } = await store.get(run.id);
    const check = after.evidence.find((e) => e.step_id === 'quote_check');
    // (a) red when the workflow does not load, its agent step's prompt does not carry the document,
    //     its guard cannot stop the run, the record is lost, or the warning does not reach the reply;
    //     (b) prints two booleans, the phase, the seal and the flag.
    expect({
      promptHasDocument: typeof prompt === 'string' && prompt.includes(DOC),
      phase: after.run_phase,
      sealedBy: after.sealed_by?.arm,
      all_found: (check?.output_summary as { all_found?: boolean } | undefined)?.all_found,
      warned: reply.warnings.some((w) =>
        w.startsWith("Quote check: 1 of 2 values not found in 'fetch_document.text'"),
      ),
    }).toEqual({
      promptHasDocument: true,
      phase: 'aborted',
      sealedBy: 'guard_abort',
      all_found: false,
      warned: true,
    });
  });

  it('the locateQuote table is what it returns', () => {
    const text = 'Payment is due in 30 days.';
    const table = raw(HANDLERS)
      .split('\n')
      .filter((l) => l.startsWith('| `locateQuote('))
      .map((l) =>
        l
          .split('|')
          .slice(1, -1)
          .map((c) => c.trim()),
      );
    const results = table.map(([call, returns]) => {
      const quote = /locateQuote\('([^']*)'/.exec(call!)![1]!;
      return [JSON.stringify(locateQuote(quote, text)), returns!.replace(/`/g, '')];
    });
    // (a) red when a row's result drifts from the function's; (b) prints each pair.
    expect(results.map(([got]) => got)).toEqual(results.map(([, shown]) => shown));
    expect(results).toHaveLength(3);
  });

  it('what the step does not check, the quote instruction, and where the record is read', () => {
    claimOn(
      HANDLERS,
      'The step checks quotes, not meaning. A value whose quote is in the document may still be wrong: the quote can say `4.5%` while the value says `5%`.',
    );
    claimOn(
      HANDLERS,
      "Ask the model for one contiguous span copied character for character, or two spans joined by `…`; each span after the first starts where a sentence or clause of the document starts, or at a new line after a finished sentence, a finished clause or a blank line; after a full stop, or after a blank line inside a sentence, a span starts only at a word that begins with a capital letter, past one opening mark, or, at a line's start, one label followed by at most one opening mark.",
    );
    // Correction 2 (03): the instruction is true of the rule — a second span that starts a sentence
    // stitches; one that starts mid-sentence does not.
    const doc =
      'The Tenant shall pay the rent quarterly in advance. The Landlord shall repair the roof.';
    // (a) red when the instruction's second span may start mid-sentence, or may not start a sentence;
    //     (b) prints the two states.
    expect([
      locateQuote(
        'The Tenant shall pay the rent quarterly … The Landlord shall repair the roof',
        doc,
      ).state,
      locateQuote('The Tenant shall pay the rent quarterly … shall repair the roof', doc).state,
    ]).toEqual(['stitched', 'not_found']);
    // Correction 3 (03): a new line after a finished sentence counts; after a full stop a lowercase
    // span does not start a sentence.
    const lines =
      'The Tenant shall pay the rent quarterly in advance.\nThe Landlord shall repair the roof.';
    // (a) red when a span at a new line after a finished sentence is refused, or a lowercase span
    //     after a full stop is accepted; (b) prints the two states.
    expect([
      locateQuote(
        'The Tenant shall pay the rent quarterly … The Landlord shall repair the roof',
        lines,
      ).state,
      locateQuote(
        'The Tenant shall pay the rent quarterly … the roof is repaired by the Landlord',
        'The Tenant shall pay the rent quarterly in advance. the roof is repaired by the Landlord.',
      ).state,
    ]).toEqual(['stitched', 'not_found']);
    // #845 1b-i (B3): after a blank line inside a sentence, a span starts with a capital letter.
    const blank = 'The Tenant shall pay the rent quarterly in advance and shall\n\n';
    // (a) red when a capital span after such a blank line is refused, or a lowercase one is accepted;
    //     (b) prints the two states.
    expect([
      locateQuote(
        'The Tenant shall pay the rent quarterly … The Landlord shall repair the roof',
        `${blank}The Landlord shall repair the roof.`,
      ).state,
      locateQuote(
        'The Tenant shall pay the rent quarterly … the Landlord shall repair the roof',
        `${blank}the Landlord shall repair the roof.`,
      ).state,
    ]).toEqual(['stitched', 'not_found']);
    // #845 1b-i-n correction 1: "past one opening mark, or, at a line's start, one label followed by
    // at most one opening mark". (a) red when a span past a label and one mark is refused, or one past
    // two opening marks, or a lowercase one past a label and a mark, is accepted; (b) prints the
    // three states.
    expect([
      locateQuote(
        'The Tenant shall pay the rent quarterly … The Landlord shall repair the roof',
        `${blank}(a) \u{201c}The Landlord shall repair the roof.`,
      ).state,
      locateQuote(
        'The Tenant shall pay the rent quarterly … ((The Landlord shall repair the roof',
        `${blank}((The Landlord shall repair the roof.`,
      ).state,
      locateQuote(
        'The Tenant shall pay the rent quarterly … the Landlord shall repair the roof',
        `${blank}(a) \u{201c}the Landlord shall repair the roof.`,
      ).state,
    ]).toEqual(['stitched', 'not_found', 'not_found']);
    // "at a line's start": after a full stop, a label skipped at the next line passes; one skipped in
    // mid-line does not (a label is skipped only at a line start). (a) red when either flips;
    // (b) prints the two states.
    expect([
      locateQuote(
        'The Tenant shall pay the rent quarterly … The Landlord shall repair the roof',
        'The Tenant shall pay the rent quarterly in advance.\n(a) The Landlord shall repair the roof.',
      ).state,
      locateQuote(
        'The Tenant shall pay the rent quarterly … The Landlord shall repair the roof',
        'The Tenant shall pay the rent quarterly in advance. (a) The Landlord shall repair the roof.',
      ).state,
    ]).toEqual(['stitched', 'not_found']);
    // `realm run export` is pinned by the CLI's `docs-claims-625.test.ts` (#760 cell); `get_run_state`
    // carrying no step output by `step-view.ts`'s StepView (F760-AUD-06).
    claimOn(
      HANDLERS,
      // Correction 1 (05 item 12): the 120-character Output: cut and the whole Warn: line are
      // executed by the CLI's docs-claims-625 (#760 cell).
      "The per-value record is the step's output: read it afterwards with `realm run export <run-id>`, which writes the whole run. `get_run_state` does not carry a step's output, and `realm run inspect` prints the step's output cut at 120 characters and its warning whole, on the `Warn:` line.",
    );
  });

  it('CHANGELOG: the #760 bullets sit under [Unreleased], or [0.48.0] once released → Added and → Changed', () => {
    const log = raw('CHANGELOG.md');
    // the section that holds them: `[Unreleased]` until 0.48.0's release renames it, then `[0.48.0]`
    const start = log.includes('\n## [0.48.0]')
      ? log.indexOf('\n## [0.48.0]') + 1
      : log.indexOf('## [Unreleased]');
    const unreleased = log.slice(start, log.indexOf('\n## [', start + 1));
    const section = (h: string) => {
      const at = unreleased.indexOf(`\n### ${h}\n`);
      const next = unreleased.indexOf('\n### ', at + 1);
      return unreleased.slice(at, next < 0 ? undefined : next);
    };
    const count = (h: string) => (section(h).match(/\(issue #760\)/g) ?? []).length;
    // (a) red when a bullet lands under the wrong heading or is lost; (b) prints the counts.
    expect({ added: count('Added'), changed: count('Changed'), fixed: count('Fixed') }).toEqual({
      added: 3,
      changed: 1,
      fixed: 0,
    });
  });
});

// issue #760 correction 1 (part 05): every sentence the correction changes in handlers.md, quoted and
// then executed. What a failing cell prints: states, booleans and the sentence.
describe('#760 correction 1 — handlers.md, sentence by sentence (05)', () => {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
  const HANDLERS = 'docs/reference/handlers.md';
  const flatten = (t: string) => t.replace(/\s+/g, ' ');
  const claimOn = (p: string, sentence: string): void => {
    expect(
      flatten(readFileSync(join(ROOT, p), 'utf8')),
      `${p} no longer says: ${sentence}`,
    ).toContain(flatten(sentence));
  };
  /** The page's fenced block that holds `marker` (correction 2: D2 runs the page's own workflow). */
  const block = (p: string, marker: string): string =>
    readFileSync(join(ROOT, p), 'utf8')
      .split(/^```[a-z]*\n/m)
      .filter((_, i) => i % 2 === 1)
      .find((b) => b.includes(marker)) ?? '';
  /** The states table's row text for `state` (#855's correction: an escaped `\|` is the list mark `|`). */
  const stateRow = (state: string): string => {
    const line = readFileSync(join(ROOT, HANDLERS), 'utf8')
      .split('\n')
      .find((l) => l.startsWith(`| \`${state}\``));
    return (line ?? '')
      .split(/(?<!\\)\|/)[2]!
      .replace(/\\\|/g, '|')
      .trim();
  };
  const handler = new CheckQuotesHandler();
  const SOURCE =
    'The Tenant shall pay the rent quarterly in advance. The Landlord shall repair the roof.';
  const run = async (candidates: unknown[], config: Record<string, unknown> = {}) =>
    handler.execute(
      { params: {} },
      {
        run_id: 'r',
        run_params: {},
        config: { source_step: 'doc', candidates_step: 'extract', ...config },
        resources: { doc: { text: SOURCE }, extract: { candidates } },
      },
    );

  it(':347 and the keys sentence — a missing quote never stops the run; the keys each value is read by', async () => {
    claimOn(
      HANDLERS,
      'A missing quote never stops the run, and the step never judges whether a value is correct; a guard on its `all_found` stops the run (below).',
    );
    claimOn(
      HANDLERS,
      'Each value is an object: its `quote_field` holds the quote, its `value` key the value, and its `field` key its name in the warning; a value with no `value` key and no quote counts as `not_found`.',
    );
    const result = await run([
      { field: 'rent', value: 'x', quote: 'nothing like this at all' },
      { name: 'deposit', answer: '24000', quote: '' },
    ]);
    const states = (result.data?.['results'] as Array<{ quote_check: { state: string } }>).map(
      (r) => r.quote_check.state,
    );
    // (a) red when a missing quote aborts, the field is not the warning's name, or a value with no
    //     `value` key and no quote is not counted; (b) prints the abort's presence, the states and
    //     two booleans.
    expect({
      aborted: result.abort !== undefined,
      states,
      named: result.warn?.message.includes('rent — "nothing like this at all"'),
      second: result.warn?.message.includes('candidate 2 — no quote given'),
    }).toEqual({ aborted: false, states: ['not_found', 'not_found'], named: true, second: true });
  });

  it("the fault sentence and the depends_on sentence — every fault named; the docs' workflow without the check's depends_on completes with the guard skipped (walk 4)", async () => {
    claimOn(
      HANDLERS,
      'ends the step `failed` with `ENGINE_HANDLER_FAILED` and a message saying what to change; every fault in the config is named at once.',
    );
    // #845 1b-ii-c (A1): the step-level fault, run below (`stepLevel`) and word for word, each kind of
    // output for both steps, by check-quotes.test.ts's "#845 1b-ii-c check 3" rows; the way back
    // (a new run, never resume) by its "the way back" cell.
    claimOn(
      HANDLERS,
      'a step whose output is not an object with fields (`{}`, `[]`, a list or a string: start a new run once it gives one),',
    );
    const stepLevel = await Promise.all(
      [{}, [], [{ text: SOURCE }], SOURCE].map(async (output) => {
        try {
          await handler.execute(
            { params: {} },
            {
              run_id: 'r',
              run_params: {},
              config: { source_step: 'doc', candidates_step: 'extract' },
              resources: { doc: output, extract: { candidates: [] } },
            },
          );
          return 'not refused';
        } catch (err) {
          const m = err instanceof WorkflowError ? err.message : '';
          return `${err instanceof WorkflowError ? err.code : 'untyped'} ${m.includes('then start a new run: this run keeps that output') ? 'new run' : m}`;
        }
      }),
    );
    // Correction 2 (03, D2): walk 4 — the guard needs the check, yet the run completes.
    claimOn(
      HANDLERS,
      'List the steps the check reads in its own `depends_on`. Without it the check can run first, before the values exist, and fail; the run goes on, every step that depends on the check under the default `all_success` trigger rule is skipped (a guard on `all_found` included), and the run can end `completed` with nothing checked.',
    );
    let message = '';
    try {
      await run([], { quote_feild: 'q', min_part_chars: 3 });
    } catch (err) {
      message = err instanceof WorkflowError ? err.message : '';
    }
    // The page's own whole workflow, its prompt included, with the check's `depends_on` taken out.
    const shown = block(HANDLERS, 'handler: check_quotes');
    const without = shown.replace('    depends_on: [fetch_document, extract_fields]\n', '');
    const def = loadWorkflowFromString(without);
    const store = new InMemoryStore({ clock: settableClock(new Date()) });
    const { record: created } = await store.create({
      workflowId: def.id,
      workflowVersion: 1,
      params: { text: SOURCE },
    });
    await advanceRun(store, def, { runId: created.id, registry: createDefaultRegistry() });
    await executeChain(store, def, {
      runId: created.id,
      command: 'extract_fields',
      registry: createDefaultRegistry(),
      input: { fields: [{ field: 'rent', value: 'x', quote: 'nothing like this at all' }] },
      dispatcher: async (_n, i) => ({ ...i }),
    });
    const { record: after } = await store.get(created.id);
    // (a) red when only the first fault is named, the depends_on line was not the one taken out, or
    //     the run does not complete with the check failed and the guard skipped by its trigger rule;
    //     (b) prints two booleans, the phase, the failed steps, the guard's skip kind and the seal.
    expect({
      both:
        message.includes("'quote_feild'") &&
        message.includes('min_part_chars must be a whole number'),
      removed: without !== shown,
      phase: after.run_phase,
      failed: after.failed_steps,
      guard: after.skip_details?.['stop_if_not_found']?.kind,
      sealedBy: after.sealed_by?.arm,
      stepLevel,
    }).toEqual({
      both: true,
      removed: true,
      phase: 'completed',
      failed: ['quote_check'],
      guard: 'trigger_rule_unsatisfiable',
      sealedBy: 'complete',
      stepLevel: Array(4).fill('ENGINE_HANDLER_FAILED new run'),
    });
  });

  it('the states table: reformatted, stitched, out of order, not_found, unquoted — each row executed', async () => {
    claimOn(HANDLERS, stateRow('reformatted'));
    expect(stateRow('reformatted')).toContain('and `<5%` is not `>5%`.');
    expect(stateRow('stitched')).toContain(
      'A piece ends where the quote breaks: at `…` or `...`, a sentence end, `;` or `:` (not one between two digits, as in `9:30`), a double quotation mark or a line break.',
    );
    // Correction 2 (03): the skip rule's sentences, run below (`skipMidSentence`, `skipToLine`).
    expect(stateRow('stitched')).toContain(
      // Correction 3 (03, D2): rule rev 3, run by locate-quote.test.ts's "correction 3, 01" cells.
      "After each skip, the next piece starts where the document starts a sentence, a clause (after `;` or `:`, but not a `:` between two digits, even across a line break) or a line. A line counts only after a line that ends a sentence, a clause or a table row (a line that ends with `|` and holds another `|`), or after a blank line; after a blank line that follows a line ending none of those, the next piece's first word, past one opening mark, or one clause number or list mark followed by at most one opening mark (a `+`, `>`, `|`, `∙`, `⦾` or `⦿` list mark only when the quote leaves it out), at the line's start, begins with a capital letter; a clause number (`6.2`, `12.`, `(a)`, never bare digits such as `12`) or a list mark with a blank after it is skipped only at such a line start, and a clause number only before a capital letter or an opening mark (an opening mark, below). After a full stop, `!` or `?`, on the same line or at the end of the line before, the next piece begins with a capital letter or an opening mark (an opening mark, below), or starts right after one in the document; at a new line that counts, other than after a blank line under a line that ends none of those, an item after a list mark (a list mark, below) may open with any word, and a line quoted with its own clause number before a capital letter (`2. Send…`) passes. The piece before a skip may end mid-sentence. A `.` ends a sentence only when the word before it holds a letter or a digit (a spacing accent is neither): `2024. The` does, `§. Keep` and `ͺ. Keep` do not; after a blank line under a line that ends none of those, the `.` that closes the line's first word, when that is a clause number or a word of up to four letters (`2.`, `b.`, `IV.`), ends a sentence only before a capital letter, past any opening marks.",
    );
    // Correction 2 (03): the exact row's edges, run below (`exactMidWord`); correction 3 (03, D2):
    // the invisible character, run below (`exactInvisible`); the follow-up (§1): a format character
    // (`Cf`) only, the combining ones run by its own cell. The language unit re-pin (§5.1): a combining
    // mark makes no word edge either, and a quote never splits a letter from its visible mark — run
    // by locate-quote-language-0480.test.ts's §3 cells (Thai `ไม` in `ไม้`, the 263-mark sweep, the
    // `the Tenant` control).
    expect(stateRow('exact')).toBe(
      "The quote is in the document character for character, and starts and ends at word and number edges; an invisible character inside a word (a soft hyphen, a zero-width space, U+FEFF, U+034F, a variation selector) does not make a word edge, and neither does a visible combining mark (an accent); a contraction ending in `'t` or `'nt`, written with any contraction apostrophe, makes no word edge either (`CAN` is not found in `CAN'T`, nor `can` in `can´t`, nor `did` in `did'nt`, nor `t make` in `won't make`), and neither does a word hyphen or a soft hyphen that breaks a word across one line (`paid` is not found after `un-` ending a line); the quote never starts or ends between a letter and a visible mark on it.",
    );
    // Correction 2 (03): the kept list, its `±` and `☒` members run below.
    expect(stateRow('reformatted')).toContain(
      'Digits, the separators between two digits, `%`, `‰`, `°`, `‱`, currency signs, the 13 number signs (U+0600–U+0605 and the others the glossary names), every mathematical sign (`<` `>` `≤` `≥` `+` `=` `±` …), primes (`′` `″`), ballot boxes and check marks (`☐` `☒` `✓` `✗`), superscripts and fractions never are',
    );
    expect(stateRow('stitched_out_of_order')).toBe('The same, with the pieces in another order.');
    expect(stateRow('not_found')).toBe(
      'A piece is not in the document, or a part is shorter than `min_part_chars`, or locating the quote took more than 1,000 substring searches; or the quote joins text across a blank line where the `stitched` row does not allow it, recorded with `cause` and `join_at` when nothing else refuses it; or the value has no quote.',
    );
    expect(stateRow('unquoted')).toBe(
      'The value has no quote, and its `value` key holds `null` or an empty string. It does not count as missing.',
    );
    const lease = 'First, the rent. Second, the repairs and the roof are the Landlord’s own duty.';
    const unquoted = await run([{ field: 'g', value: null, quote: '' }]);
    // (a) red when a row's behaviour drifts: a sign dropped, an abbreviation or `9:30` read as a
    //     break, a drop inside a piece found, reversed pieces not labelled, the budget not applied, an
    //     empty value not unquoted; (b) prints the states.
    expect({
      signs: locateQuote('the deposit is <5% of the rent', 'the deposit is >5% of the rent').state,
      breaks: [segmentsOf('see e.g. the roof').length, segmentsOf('at 9:30 on Monday').length],
      inOrder: locateQuote(
        'The Tenant shall pay the rent quarterly… The Landlord shall repair the roof',
        SOURCE,
      ).state,
      dropInside: locateQuote('The Tenant shall pay the rent in advance', SOURCE).state,
      reversed: locateQuote(
        'The Landlord shall repair the roof. The Tenant shall pay the rent quarterly',
        SOURCE,
      ).state,
      tooShort: locateQuote('First, the rent… the roof', lease).state,
      slow: locateQuote('a1'.repeat(200), 'a1'.repeat(4_000)).state,
      unquoted: (unquoted.data?.['results'] as Array<{ quote_check: { state: string } }>)[0]!
        .quote_check.state,
      skipMidSentence: locateQuote(
        'The Tenant shall pay the rent quarterly… shall repair the roof',
        SOURCE,
      ).state,
      skipToLine: locateQuote(
        'The account manager owns the renewal … Escalate any discount above ten per cent',
        // Correction 3: the line before ends with `:`, so the list line counts (a line ending
        // `and` does not, under rule rev 3); the text between the pieces is what the skip leaves.
        'The account manager owns the renewal and its terms:\n- Escalate any discount above ten per cent.',
      ).state,
      exactMidWord: [
        locateQuote('solvent, the Landlord', 'if the Tenant is insolvent, the Landlord').state,
        locateQuote('the Landlord', 'if the Tenant is insolvent, the Landlord').state,
      ],
      exactInvisible: [0xad, 0x200b, 0xfeff].map(
        (code) =>
          locateQuote(
            'lawful use of the Premises',
            `any un${String.fromCharCode(code)}lawful use of the Premises`,
          ).state,
      ),
      plusMinus: locateQuote('a tolerance of ±5 mm', 'a tolerance of 5 mm').state,
      ballot: locateQuote('☒ The Tenant may keep pets', '☐ The Tenant may keep pets').state,
    }).toEqual({
      signs: 'not_found',
      breaks: [1, 1],
      inOrder: 'stitched',
      dropInside: 'not_found',
      reversed: 'stitched_out_of_order',
      tooShort: 'not_found',
      slow: 'not_found',
      unquoted: 'unquoted',
      skipMidSentence: 'not_found',
      skipToLine: 'stitched',
      exactMidWord: ['not_found', 'exact'],
      // #845 (R-C1) re-pin: U+FEFF is invisible like the other two, so it makes no word edge
      exactInvisible: ['not_found', 'not_found', 'not_found'],
      plusMinus: 'not_found',
      ballot: 'not_found',
    });
  });

  it("the stitched row's abbreviations and the not_found row's 1,000 searches are the code's own (L1, A8)", () => {
    const row = stateRow('stitched');
    // #845 (R-A3): the list is its own sentence; the initialisms' sentence follows it
    // #845 1b-ii-b correction 1: the list ends at ", in any letter case (…)", whose examples run below
    const list = row.slice(
      row.indexOf('after an initial or one of '),
      row.indexOf(', in any letter case ('),
    );
    const listed = [...list.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
    const anyCase = row.slice(
      row.indexOf(', in any letter case ('),
      row.indexOf(' is not a sentence end.'),
    );
    const caseExamples = [...anyCase.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
    const tail = row.slice(row.indexOf(' is not a sentence end.'));
    const initialisms = [...tail.matchAll(/`([^`]+)`/g)].map((m) => m[1]!).filter((a) => a !== '.');
    // (a) red when the row's list and the code's differ, a listed abbreviation or an initial ends a
    //     piece, a letter-case example the row names ends one, or the budget is not the row's figure;
    //     (b) prints the two lists, the abbreviations that split a quote, the initial's piece count
    //     and the budget.
    expect({
      listed,
      splits: listed.filter((a) => segmentsOf(`see ${a} the roof`).length !== 1),
      caseExamples,
      caseSplits: caseExamples.filter((a) => segmentsOf(`see ${a} the roof`).length !== 1),
      initial: segmentsOf('signed by J. Smith today').length,
      initialisms,
      initialismSplits: initialisms.filter(
        (a) => segmentsOf(`made in the ${a} The roof`).length !== 1,
      ),
      budget: QUOTE_SEARCH_BUDGET,
    }).toEqual({
      listed: [...NOT_SENTENCE_ENDS],
      splits: [],
      caseExamples: ['NO.', 'INC.'],
      caseSplits: [],
      initial: 1,
      initialisms: ['U.S.', 'U.K.', 'J.R.R.'],
      initialismSplits: [],
      budget: 1_000,
    });
    expect(stateRow('not_found')).toContain('more than 1,000 substring searches');
  });

  it('cut_short, the number sentence and `nearest` — each executed', () => {
    claimOn(
      HANDLERS,
      "A quote that ends a sentence where the document's sentence goes on is marked `cut_short`, with where; the reviewer reads the rest.",
    );
    // Correction 2 (03, N8): each example is run below (`numbers`, `signs`, `words`).
    claimOn(
      HANDLERS,
      'A number written in digits is one unit: a digit never matches inside a longer number or next to a letter, and a quote never starts or ends on a number\'s separator or beside a group of thousands. `clause 9` is not found in `clause 9a`, `9,20` not in `9,200`, `€48` not in `€48,000`, `18` and `18.` not in `18.5`, `1 200` not in `1 200 000`, and `75%` not in `.75%`. A currency or mathematical sign, a dash, or one of the 13 number signs (U+0600–U+0605, U+06DD, U+070F, U+0890, U+0891, U+08E2, U+110BD, U+110CD), written right before a number belongs to it (the exceptions are listed under "What `check_quotes` does not catch"): `48,000` is not found in `€48,000`, and `5` not in `-5`. A number written in words is matched as words: `five hundred thousand euro` is found inside `six million five hundred thousand euro`.',
    );
    // #866 correction 1 (C2): what `nearest` reads — run by locate-quote-language-0480.test.ts's
    // "the review’s correction: nearest" cells (`كُتِبَ`, `abcdefgh rent`, `старый замок`,
    // `qqq ndlord shall repair`). #845 1b-ii-c (A4): a word the piece cuts left out, each example run
    // below (`nearestWords`), and by locate-quote-rules-845.test.ts's "#845 1b-ii-c check 1" and E5.
    claimOn(
      HANDLERS,
      "`nearest` is where the longest piece of the quote that is in the document lies (an Arabic or Hebrew piece, and the document, read without their Arabic or Hebrew marks); it is absent when that piece holds no whole word, and on a quote refused for joining text across a blank line. It leaves out a word that piece cuts at either end, so it never starts or ends inside a word of the document; a number keeps its sign or symbol (`€48,000`, `-5`, `4%`), and words joined by punctuation with no space between them count as one (`twenty-four`, `and/or`, `Landlord's`, `U.K.`).",
    );
    /** The document's text at a not-found quote's `nearest`, or `none`. */
    const at = (quote: string, source: string): string => {
      const n = locateQuote(quote, source).nearest;
      return n === undefined ? 'none' : source.slice(n.start, n.end);
    };
    // (a) red when a word the piece cuts is kept (`ndlord`, `four`, `and`, `Landlord`, `U`) or a
    //     sign or symbol at its edge is dropped (`€`, `-`, `%`); (b) prints the text at each.
    expect({
      cutStart: at('qqq ndlord shall repair', 'The Landlord shall repair the roof.'),
      euro: at('zzz €48,000 a year', 'The rent is €48,000 a year.'),
      minus: at('qqq -5 degrees at night', 'The reading is -5 degrees today.'),
      percent: at('the rate of 4% qqq', 'Interest at the rate of 4% per annum.'),
      twentyFour: at('qqq four thousand euro', 'a deposit of twenty-four thousand euro'),
      andOr: at('the Landlord and the Tenant agree', 'the Landlord and/or the Tenant may agree'),
      possessive: at('the Landlord shall pay', "the Landlord's agent shall pay"),
      uk: at('made in the U zzz', 'made in the U.K. today'),
    }).toEqual({
      cutStart: 'shall repair',
      euro: '€48,000 a year',
      minus: '-5 degrees',
      percent: 'the rate of 4%',
      twentyFour: 'thousand euro',
      andOr: 'the Landlord',
      possessive: 'the',
      uk: 'made in the',
    });
    claimOn(
      HANDLERS,
      '`all_found` is true when no value is `not_found`: `exact`, `reformatted`, `stitched` and `stitched_out_of_order` count as found, and `unquoted` is not counted.',
    );
    const cut = locateQuote('The Tenant shall pay the rent.', SOURCE);
    // (a) red when the label is missing, a shorter number is found inside a longer one, or a
    //     one-letter `nearest` is kept; (b) prints the label and the states.
    expect({
      cut: cut.cut_short,
      numbers: [
        locateQuote('see clause 9', 'see clause 9a').state,
        locateQuote('a cap of 9,20', 'a cap of 9,200 a year').state,
        locateQuote('a rent of €48', 'a rent of €48,000').state,
        locateQuote('being 18', 'being 18.5 per cent').state,
        locateQuote('being 18.', 'being 18.5 per cent').state,
        locateQuote('the rent is 1 200', 'the rent is 1 200 000 euro').state,
        // Correction 3 (03, D2): true after 02 C — the quote's own trailing space is no edge.
        locateQuote('the rent is 1 200 ', 'the rent is 1 200 000 euro').state,
        locateQuote('75%', 'a margin of .75% above').state,
      ],
      signs: [locateQuote('48,000', '€48,000').state, locateQuote('5', '-5').state],
      words: locateQuote(
        'five hundred thousand euro',
        'a limit of six million five hundred thousand euro',
      ).state,
      nearest: locateQuote('zzzz qqqq', SOURCE).nearest,
    }).toEqual({
      cut: true,
      numbers: [
        'not_found',
        'not_found',
        'not_found',
        'not_found',
        'not_found',
        'not_found',
        'not_found',
        'not_found',
      ],
      signs: ['not_found', 'not_found'],
      words: 'exact',
      nearest: undefined,
    });
  });

  it('the warning sentence — the quote as the model gave it, cut at 80, and offsets; never text read from the document', async () => {
    // #866 correction 1 (C6): the warning's phrases and its cut. Each is run in check-quotes.test.ts:
    // `no nearby match` by "a quote with nothing nearby says so…" (:287, asserted at :296; absent
    // after no search, H3's `noSearchClaimed`, :606); `no quote given` and `the quote is not text` by
    // "H3: a value with no quote says…" (:594, asserted at :604 and :605); the cut with `…` by "names
    // each missing value…" (:246) and "H4: a quote head of 81 characters…" (:610); one line, with
    // control characters written out, by "H2: the warning is one terminal-safe line…" (:569,
    // `escWrittenOut`); the cut moved back before a letter or symbol it would split (#845 1b-ii-c, A6)
    // run below (`cuts`), and by "#845 1b-ii-c check 2" and "the review’s correction (#866, C1)…"
    // (`cutTail`).
    claimOn(
      HANDLERS,
      "When any quote is not found, the step completes with a warning that names each one: its field, the quote's first 80 characters, and the offsets of its nearest match, or `no nearby match`; a value with no quote reads `no quote given`, and one whose quote is not a string `the quote is not text`; a quote refused for joining text across a blank line reads `(this quote joins text across a blank line; quote each part separately)` in place of its nearest match.",
    );
    claimOn(
      HANDLERS,
      "It prints the quote as the model gave it, on one line, with control characters written out (`\\u001b`), and cut after its 80th character with `…` (or, where that cut would split a letter or symbol written with several characters, such as an accented letter or a joined emoji, before it, unless that one letter or symbol alone runs from the quote's start past the 80th), and offsets; it never prints text it read from the document.",
    );
    const x = (n: number): string => 'x'.repeat(n);
    const cutQuotes: Record<string, string> = {
      accented: `${x(79)}e\u0301yy`,
      emoji: `${x(79)}\u{1f468}\u200d\u{1f469}yy`,
      alone: `e${'\u0301'.repeat(100)}yy`,
    };
    const cutWarn = (
      await handler.execute(
        { params: {} },
        {
          run_id: 'r',
          run_params: {},
          config: { source_step: 'doc', candidates_step: 'extract' },
          resources: {
            doc: { text: 'The Tenant shall pay the rent.' },
            extract: {
              candidates: Object.entries(cutQuotes).map(([field, quote]) => ({
                field,
                value: 'v',
                quote,
              })),
            },
          },
        },
      )
    ).warn?.message;
    /** The quote the warning shows for `field`: whether it is `want` exactly. */
    const shows = (field: string, want: string): boolean =>
      (cutWarn ?? '').includes(`${field} — "${want}" (`);
    // (a) red when the cut splits the accented letter or the joined emoji, or the one letter that
    //     alone runs past the 80th is not cut at the 80th; (b) prints three booleans.
    expect({
      accented: shows('accented', `${x(79)}…`),
      emoji: shows('emoji', `${x(79)}…`),
      alone: shows('alone', `e${'\u0301'.repeat(79)}…`),
    }).toEqual({ accented: true, emoji: true, alone: true });
    const long = `${'The Landlord shall repaint every window each spring and every door each autumn'} and more`;
    // Correction 2 (ride-along, F760-C1R-B-09): the source spells the shared words its own way, so
    // its text at `nearest` differs from the quote and the check below can fail.
    const source = 'the LANDLORD, shall repair the roof and the structure at its own cost.';
    const result = await handler.execute(
      { params: {} },
      {
        run_id: 'r',
        run_params: {},
        config: { source_step: 'doc', candidates_step: 'extract' },
        resources: {
          doc: { text: source },
          extract: { candidates: [{ field: 'paint', value: 'v', quote: long }] },
        },
      },
    );
    const near = (
      result.data?.['results'] as Array<{
        quote_check: { nearest?: { start: number; end: number } };
      }>
    )[0]!.quote_check.nearest;
    const sourceSpan = near === undefined ? '' : source.slice(near.start, near.end);
    // (a) red when the warning prints the source at `nearest`, or more than 80 characters of the
    //     quote; (b) prints booleans.
    expect({
      head: result.warn?.message.includes(`"${long.slice(0, 80)}…"`),
      sourceSpanDiffers: sourceSpan !== '' && !long.includes(sourceSpan),
      sourceText: result.warn?.message.includes(sourceSpan),
    }).toEqual({ head: true, sourceSpanDiffers: true, sourceText: false });
  });

  it("the locateQuote section — the ladder's stitched, out-of-order and not_found items, and the kept characters", () => {
    claimOn(
      HANDLERS,
      '1. `exact`: `quote` is a substring of `source`, starting and ending at word and number edges.',
    );
    claimOn(
      HANDLERS,
      "3. `stitched`: the quote's pieces, split where it breaks (`…` or `...`, a sentence end, `;`, a `:` not between two digits, a double quotation mark or a line break), are each found whole, at word edges, and in order; pieces next to each other in `source` count as one part, and every part is at least `options.minPartChars` long (default `20`, at least `4`). After each skip, the next piece starts where the document starts a sentence, a clause (after `;` or `:`, but not a `:` between two digits, even across a line break) or a line. A line counts only after a line that ends a sentence, a clause or a table row (a line that ends with `|` and holds another `|`), or after a blank line; after a blank line that follows a line ending none of those, the next piece's first word, past one opening mark, or one clause number or list mark followed by at most one opening mark (a `+`, `>`, `|`, `∙`, `⦾` or `⦿` list mark only when the quote leaves it out), at the line's start, begins with a capital letter; a clause number (`6.2`, `12.`, `(a)`, never bare digits such as `12`) or a list mark with a blank after it is skipped only at such a line start, and a clause number only before a capital letter or an opening mark (an opening mark, as the glossary above defines it). After a full stop, `!` or `?`, on the same line or at the end of the line before, the next piece begins with a capital letter or an opening mark (an opening mark, as the glossary above defines it), or starts right after one in the document; at a new line that counts, other than after a blank line under a line that ends none of those, an item after a list mark (a list mark, as the glossary above defines it) may open with any word, and a line quoted with its own clause number before a capital letter (`2. Send…`) passes. The piece before a skip may end mid-sentence. A `.` ends a sentence only when the word before it holds a letter or a digit (a spacing accent is neither): `2024. The` does, `§. Keep` and `ͺ. Keep` do not; after a blank line under a line that ends none of those, the `.` that closes the line's first word, when that is a clause number or a word of up to four letters (`2.`, `b.`, `IV.`), ends a sentence only before a capital letter, past any opening marks. A quote with no break is never stitched.",
    );
    claimOn(HANDLERS, '4. `stitched_out_of_order`: the same, with the parts in another order.');
    // #866 correction 1 (C2): only the longest piece is read, and Arabic and Hebrew are read bare —
    // the same cells
    claimOn(
      HANDLERS,
      "5. `not_found`: otherwise, with `nearest` when the longest piece of the quote that is in `source` holds a whole word (an Arabic or Hebrew piece, and `source`, read without their Arabic or Hebrew marks); otherwise it is absent; a quote refused for joining text across a blank line carries `cause: 'blank_line_join'` and `join_at` instead of `nearest`.",
    );
    // The language unit re-pin (§5.3): a letter keeps its visible marks; the Arabic and Hebrew vowel
    // marks a quote leaves out — run by locate-quote-language-0480.test.ts's §2 and §4 cells.
    claimOn(
      HANDLERS,
      "with every dash and hyphen read as `-` (a soft hyphen is not a dash: it is invisible, and makes no word edge), every punctuation mark and quotation mark dropped, and every spacing accent not next to a digit, and spaces collapsed, keeping letters with their visible combining marks (a mark is part of its letter, so a quote must carry it; an Arabic or Hebrew vowel mark a quote leaves out is optional, and one it writes must match; a mark on anything but a letter is dropped), digits, `%`, `‰`, `°`, `‱`, currency signs, the 13 number signs (U+0600–U+0605 and the others the glossary names), every mathematical sign (`<` `>` `≤` `≥` `+` `=` `±` …), primes (`′` `″`), ballot boxes and check marks (`☐` `☒` `✓` `✗`), superscripts and fractions (never folded into digits), a `-` directly before a digit, a `.` or `,` directly before a digit that follows no letter or digit, and the separators between two digits (a spacing accent between two digits is one, kept as itself). A number written in digits is one unit: a digit never matches inside a longer number of `source`, or next to its letters, and a quote never starts or ends on a number's separator or beside a group of thousands.",
    );
    // (a) red when a mid-word quote or piece is found, a skip lands mid-sentence, a quote with no
    //     break stitches, a sign, a superscript, a dash or a leading decimal is folded, or a number
    //     is cut at its separator; (b) prints the states.
    expect([
      locateQuote('solvent, the Landlord', 'if the Tenant is insolvent, the Landlord').state,
      locateQuote('The Tenant shall pa… y the rent quarterly', SOURCE).state,
      locateQuote('The Tenant shall pay the rent quarterly … shall repair the roof', SOURCE).state,
      locateQuote('The Tenant shall pay the roof', SOURCE).state,
      locateQuote('a fee of ≥ 10%', 'a fee of ≤ 10%').state,
      locateQuote('clause 91', 'clause 9¹').state,
      locateQuote('a balance of 5 units', 'a balance of \u20115 units').state,
      locateQuote('a margin of 75%', 'a margin of .75%').state,
      locateQuote('being 18.', 'being 18.5 per cent').state,
    ]).toEqual([
      'not_found',
      'not_found',
      'not_found',
      'not_found',
      'not_found',
      'not_found',
      'not_found',
      'not_found',
      'not_found',
    ]);
  });

  it('the `compareStrings` `exact` row says what the mode does (correction 2, D1)', () => {
    claimOn(HANDLERS, '| `exact`  | `a` and `b` are the same string.');
    // (a) red when the row carries another function's text, or the mode drifts; (b) prints the two
    //     results.
    expect([
      compareStrings('INV-2041', 'INV-20', 'exact'),
      compareStrings('INV-20', 'INV-20', 'exact'),
    ]).toEqual([false, true]);
  });

  it("the CHANGELOG's `locateQuote` bullet, sentence by sentence, each state it names run (correction 2, D3)", () => {
    const CL = 'CHANGELOG.md';
    claimOn(
      CL,
      // The follow-up (§4): the rule. #855's correction (§6, S3): the pointer to its exceptions now
      // ends the paragraph; the §4 cell claims it there.
      'A quote may skip document text only where it breaks (at `…` or `...`, a sentence end, `;`, a `:` not between two digits, a double quotation mark or a line break), and by the rule only to where the document starts a sentence, a clause or a line.',
    );
    claimOn(
      CL,
      // Correction 3 (03, D2): rule rev 3, run by locate-quote.test.ts's "correction 3, 01" cells.
      // The follow-up (§1): the capital condition as the code reads it, run by its own cell.
      'A line counts only after a blank line, or a line that ends a sentence, a clause or a table row, so text whose lines break inside sentences is read correctly; a clause number or a list mark is skipped only at such a line start, and after a full stop the next piece must begin with a capital letter or an opening mark (`"` `“` `„` `«` `\'` `‘` `(` `[`), or start right after one in the document; at a new line that counts, an item after a list mark (`-` `*` `•` `◦` `▪` `‣` `·` `–` `—` `|`, or a run of `#`) may open with any word, and a line quoted with its own clause number before a capital letter (`2. Send…`) passes.',
    );
    // Correction 3 (03, D2): run by locate-quote.test.ts's "correction 3, 02 B" and "02 C" cells.
    claimOn(
      CL,
      // The follow-up (§1, walk M3): format characters only, and what a soft hyphen does.
      "every dash and hyphen reads as `-` (two hyphens outside the Basic Multilingual Plane excepted); a soft hyphen is not a dash: it, like every other invisible format character (Unicode's `Cf`) but U+FEFF (which the canonical form reads as a space), makes no word edge. A quote's own leading or trailing space never counts as an edge.",
    );
    // The joined-clause gap is pinned by locate-quote.test.ts ("a known gap: the part BEFORE a skip
    // may end mid-sentence…"), and run here too.
    claimOn(
      CL,
      'The part before a skip may still end mid-sentence, so a clause can be joined to a later sentence and read `stitched`.',
    );
    claimOn(
      CL,
      'Whole sentences quoted from far apart read `stitched` (`stitched_out_of_order` when reversed).',
    );
    claimOn(
      CL,
      "A number written in digits is one unit: a digit never matches inside a longer number or next to a letter, and a quote never starts or ends on a number's separator or beside a group of thousands. A currency or mathematical sign, or a dash, written right before a number belongs to it. A number written in words is matched as words.",
    );
    claimOn(
      CL,
      'Mathematical signs, primes, ballot boxes and check marks, superscripts and fractions are kept,',
    );
    const doc =
      'The Tenant shall pay the Rent, subject to payment of the Service Charge,\nwhen due.\n\nThe Landlord shall insure the Building. The Landlord shall repair the roof.\n\nThe Tenant shall keep the Premises clean.';
    const first = 'The Landlord shall insure the Building.';
    const last = 'The Tenant shall keep the Premises clean.';
    // (a) red when a skip lands inside a sentence, the joined clause is refused (the gap closed
    //     without the docs saying so), or whole far sentences do not stitch; (b) prints the states.
    expect({
      intoSentence: locateQuote('The Tenant shall pay the Rent … when due.', doc).state,
      joinedClause: locateQuote(
        'subject to payment of the Service Charge, … The Landlord shall repair the roof.',
        doc,
      ).state,
      far: locateQuote(`${first} … ${last}`, doc).state,
      reversed: locateQuote(`${last} … ${first}`, doc).state,
    }).toEqual({
      intoSentence: 'not_found',
      joinedClause: 'stitched',
      far: 'stitched',
      reversed: 'stitched_out_of_order',
    });
  });
});

// issue #760 correction 3 (03, D1): the handlers page's "What `check_quotes` does not catch", each
// sentence quoted and then run; and how to register the page's whole workflow. What a failing cell
// prints: states and booleans.
describe('#760 correction 3 — handlers.md: what check_quotes does not catch, and registering the workflow (03, D1)', () => {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
  const HANDLERS = 'docs/reference/handlers.md';
  const flatten = (t: string) => t.replace(/\s+/g, ' ');
  const claimOn = (sentence: string): void => {
    expect(
      flatten(readFileSync(join(ROOT, HANDLERS), 'utf8')),
      `${HANDLERS} no longer says: ${sentence}`,
    ).toContain(flatten(sentence));
  };
  const block = (marker: string): string =>
    readFileSync(join(ROOT, HANDLERS), 'utf8')
      .split(/^```[a-z]*\n/m)
      .filter((_, i) => i % 2 === 1)
      .find((b) => b.includes(marker)) ?? '';
  const FIRST = 'The Landlord shall insure the Building';
  const skipTo = (join: string, second: string): [string, string] => [
    `${FIRST} … ${second}`,
    `${FIRST} for its full reinstatement cost${join}${second} at the end of each year.`,
  ];
  const CAPITAL = 'The Tenant shall pay the insurance rent';
  const ch = String.fromCharCode;
  const state = (quote: string, source: string) => locateQuote(quote, source).state;

  it('the bar: built for the mistakes models make; a quote written to mislead it can read found', () => {
    claimOn(
      '`check_quotes` is built to catch the mistakes models make when they quote: a word dropped or added, a number cut short, a piece resumed in the middle of a sentence. A quote written on purpose to mislead it can still read found in the cases below.',
    );
    const doc =
      'The Tenant shall not pay the Rent late. The cap is €9,200 for each year of the term.';
    // (a) red when one of the three mistakes is found; (b) prints the three states.
    expect([
      state('The Tenant shall pay the Rent late.', doc),
      state('The cap is €9,', doc),
      state('The Tenant shall not pay … for each year of the term.', doc),
    ]).toEqual(['not_found', 'not_found', 'not_found']);
  });

  it("what can still read found — each bullet run (the test set's T2 rows pin them too)", () => {
    for (const sentence of [
      'A clause joined to a later sentence (`stitched`) or an earlier one (`stitched_out_of_order`): the piece before a skip may end mid-sentence.',
      'A number written in words, matched as words: `five hundred thousand euro` is found inside `six million five hundred thousand euro`.',
      'A true quote that stops before its sentence ends is found. It is marked `cut_short` only at a `.`, `!` or `?` the quote itself carries.',
      "An abbreviation that is not on the check's list (`e.g.`, `i.e.`, `etc.`, `No.`, `Nos.`, `cl.`, `para.`, `Sch.`, `Ltd.`, `Co.`, `Inc.`, `St.`, `Mr.`, `Mrs.`, `Ms.`, `Dr.`, in any letter case, an initial, and an initialism), before a capital letter or an opening mark, is read as a sentence end (`a.m. Monday`, `excl. VAT`): a skip may land there.",
      'A grouped amount written with a letter prefix (`500 euro` in `EUR2 500 euro`), and a middle-dot decimal (`·5`).',
      // The follow-up (§2): which enclosed letters read as letters, run by its own cell. The language
      // unit re-pin (§5.2): a mark on a letter stays with it, so the bullet keeps marks on digits and
      // signs only (#845's 2.1 drops them).
      'Circled, squared and parenthesised letters read as letters (`ⓃⓄⓉ` reads `not`). Negative squared and negative circled letters (`🅽🅾🆃`, `🅝🅞🅣`) and regional indicators are set aside like other symbols, so a quote reads found whether it carries them or leaves them out.',
      // The stray-mark line (the owner's yes, 2026-10-25): a mark on no letter is set aside — at a
      // quote's start, after a space, after an invisible format character (#845 drops it in code).
      "A combining mark on no letter is set aside too, at a quote's start (U+0301 then `lawful use of the Premises` is found in `lawful use of the Premises`) or after a space.",
      'Symbols other than the kept ones (bullets, emoji) are set aside.',
      // #845 (R-C1): the U+FEFF line goes (an invisible character leaves first, so `lawful use`
      // in `un`, U+FEFF, `lawful use` is not found: `feff` below); the non-joiner line comes in.
      'A Persian word that differs from another only by the zero-width non-joiner (U+200C) reads `reformatted` against it: `تنها` ("alone") against `تن‌ها` ("bodies"). The non-joiner is set aside like every invisible character.',
    ])
      claimOn(sentence);
    const stop = locateQuote('The area is approx.', 'The area is approx. 412 square metres.');
    const open = locateQuote(
      'The Tenant shall pay the Rent',
      'The Tenant shall pay the Rent on each quarter day.',
    );
    // (a) red when one of these behaviours changes (a gap closed, or a true quote no longer found);
    //     (b) prints the states and the two labels.
    expect({
      joinedClause: state(
        'subject to payment of the Service Charge, … The Landlord shall repair the roof.',
        'The Tenant shall pay the Rent, subject to payment of the Service Charge,\nwhen due.\n\nThe Landlord shall insure the Building. The Landlord shall repair the roof.',
      ),
      words: state(
        'five hundred thousand euro',
        'a limit of six million five hundred thousand euro',
      ),
      stopsShort: [open.state, open.cut_short === true, stop.state, stop.cut_short === true],
      abbreviations: [
        state(
          'The Tenant and its contractors shall … Monday to Friday use the loading bay or the goods lift.',
          'The Tenant and its contractors shall not before 9 a.m. Monday to Friday use the loading bay or the goods lift.',
        ),
        state(
          'The Tenant shall pay an annual rent of €48,000 … VAT and the Service Charge on each quarter day.',
          'The Tenant shall pay an annual rent of €48,000 excl. VAT and the Service Charge on each quarter day.',
        ),
      ],
      amounts: [
        state('500 euro', 'the deposit is EUR2 500 euro'),
        state('is 5 percent higher', 'the rent is ·5 percent higher'),
      ],
      marks: [
        // #845 (R-D) re-pin: a mark on a digit or a sign leaves before the number rules, so `-́5`
        // reads `-5` and `5 degrees` is not found in it (the bullet's first sentence goes)
        state('5 degrees', 'The reading is -́5 degrees today.'),
        state(
          'The Landlord shall 🅽🅾🆃 insure the Building',
          'The Landlord shall insure the Building.',
        ),
      ],
      // the stray-mark line's four shapes: a mark on no letter is set aside, so the first two read
      // found; #845 (R-C1, R-D) re-pin: after an invisible character the mark is not on no letter —
      // the invisible character leaves first, so the mark lands on `e` and the last two read
      // `not_found` (the line's "after an invisible format character" goes) — (a) red when such a
      // mark is kept, or the invisible character is left in; (b) prints the four states
      strayMarks: [
        state(
          `${ch(0x301)}lawful use of the Premises`,
          'The Tenant shall make lawful use of the Premises.',
        ),
        state('the cafe', `the ${ch(0x301)}cafe here`),
        state('cafe', `the cafe${ch(0x200b)}${ch(0x301)} here`),
        state(`cafe${ch(0x200b)}${ch(0x301)}`, 'the cafe here'),
      ],
      symbols: [
        state(
          'The Tenant shall pay the Rent and keep the Premises',
          'The Tenant shall pay the Rent ■ and keep the Premises',
        ),
        state('⭐ The Tenant may keep pets', '🔥 The Tenant may keep pets'),
      ],
      feff: state('lawful use of the Premises', `any un${ch(0xfeff)}lawful use of the Premises`),
      persian: [state('تنها', 'او تن‌ها را دید'), state('تن‌ها', 'او تنها را دید')],
    }).toEqual({
      joinedClause: 'stitched',
      words: 'exact',
      stopsShort: ['exact', false, 'exact', true],
      abbreviations: ['stitched', 'stitched'],
      amounts: ['exact', 'reformatted'],
      marks: ['not_found', 'reformatted'],
      strayMarks: ['reformatted', 'reformatted', 'not_found', 'not_found'],
      symbols: ['reformatted', 'reformatted'],
      feff: 'not_found',
      persian: ['reformatted', 'reformatted'],
    });
  });

  it('what reads not found although it is honest — each bullet run', () => {
    for (const sentence of [
      'A quote that skips into the middle of a sentence, with or without `…`.',
      'A skip onto a sentence that opens with a digit, a currency sign, a lowercase word (`iPhones…`), or a script with no capital letters.',
      'A skip onto a clause number in the middle of a line after a sentence end.',
      'A zero-width space or U+FEFF used as the only separator between two words.',
      'A skip onto a new line, a list item included, after a line that ends mid-sentence, or onto a line under a heading with no stop.',
      'A sentence after a footnote marker; a tab-separated row with no stop; a skip past the labels `a)`, `A)` and `A.`, which are not read as clause numbers; `Ltd.`, `Inc.` or `etc.` ending a sentence; `Schedule A.` (read as an initial, as any single capital before `.` is); a bullet in the middle of a line after a sentence end.',
    ])
      claimOn(sentence);
    const cases: Array<[string, string, string]> = [
      [
        'into a sentence, with …',
        `${FIRST} … for its full reinstatement cost`,
        `${FIRST} and the roof, for its full reinstatement cost.`,
      ],
      [
        'into a sentence, at a line break',
        `${FIRST}\nfor its full reinstatement cost`,
        `${FIRST} and the roof, for its full reinstatement cost.`,
      ],
      ['opens with a digit', ...skipTo('. ', '12 payments of the insurance rent are due')],
      ['opens with a currency sign', ...skipTo('. ', '€500 of the insurance rent is due')],
      ['opens with a lowercase word', ...skipTo('. ', 'iPhones are not covered by the insurance')],
      ['a script with no capital letters', ...skipTo('. ', 'השוכר ישלם את דמי הביטוח')],
      ['a clause number mid-line', ...skipTo('. 6.2 ', CAPITAL)],
      ['a list item after a line ending mid-sentence', ...skipTo(' and\n- ', CAPITAL)],
      [
        'a line under a heading with no stop',
        'The following words have these meanings … "Rent" means the rent specified in clause 3.1',
        'The following words have these meanings in this Lease\n"Rent" means the rent specified in clause 3.1.',
      ],
      // #845 (R-B) re-pin: a sentence after a no-break space or a form feed is no longer refused
      // (U+00A0 is a blank, U+000C a line break), so those two cases left the bullet
      ['after a footnote marker', ...skipTo('.¹ ', CAPITAL)],
      [
        'a tab-separated row with no stop',
        'Rent\tforty-eight thousand euro a year … Service Charge\tnine thousand two hundred euro',
        'Rent\tforty-eight thousand euro a year\nDeposit\ttwenty-four thousand euro\nService Charge\tnine thousand two hundred euro',
      ],
      // #845 (R-B) re-pin: `●`, U+F0B7 and `>` are list marks now; an item that opens with a mark
      // that is not one is still refused
      ['a mark that is not a list mark (★)', ...skipTo(':\n★ ', CAPITAL)],
      ['the label a)', ...skipTo('.\n\na) ', CAPITAL)],
      ['the label A)', ...skipTo('.\n\nA) ', CAPITAL)],
      ['the label A.', ...skipTo('.\n\nA. ', CAPITAL)],
      ['Ltd. ending a sentence', ...skipTo(' by Northwind Analytics Ltd. ', CAPITAL)],
      ['Inc. ending a sentence', ...skipTo(' by Northwind Analytics Inc. ', CAPITAL)],
      ['etc. ending a sentence', ...skipTo(', the roof, the lifts etc. ', CAPITAL)],
      ['Schedule A.', ...skipTo(' set out in Schedule A. ', CAPITAL)],
      ['a bullet mid-line after a sentence end', ...skipTo('. • ', CAPITAL)],
    ];
    // (a) red when one of these honest shapes starts to read found (its bullet would then be false);
    //     (b) prints every case that reads found, and the zero-width case's state.
    expect({
      found: cases
        .filter(([, quote, source]) => state(quote, source) !== 'not_found')
        .map(([n]) => n),
      zeroWidth: [
        state('the Tenant', `the Tenant${ch(0x200b)}shall pay`),
        state('the Tenant', `the Tenant${ch(0xfeff)}shall pay`),
      ],
    }).toEqual({ found: [], zeroWidth: ['not_found', 'not_found'] });
  });

  it('the whole workflow: "Register it with `realm workflow register <file>`" — it registers', async () => {
    claimOn('Register it with `realm workflow register <file>`.');
    const { definition, warnings } = loadWorkflowFromStringWithDiagnostics(
      block('handler: check_quotes'),
    );
    const store = new JsonWorkflowStore(await mkdtemp(join(tmpdir(), 'realm-dc-760-reg-')));
    await store.register(definition);
    const stored = await store.get(definition.id);
    // (a) red when the page's workflow carries an error the register command refuses, or does not
    //     register; (b) prints the error codes and the registered id.
    expect({
      errors: warnings.filter((w) => w.severity === 'error').map((w) => w.code),
      registered: stored.id,
    }).toEqual({ errors: [], registered: 'lease-quotes' });
  });
});

// issue #760, the words-and-tests follow-up (MA 3, 2026-10-20; the owner's "yes" on #818): every
// sentence it changes or adds in handlers.md and the CHANGELOG, quoted and then run. What a failing
// cell prints: states, booleans and the sentence.
describe('#760 follow-up — the words and tests: each changed sentence quoted, then run', () => {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
  const HANDLERS = 'docs/reference/handlers.md';
  const CL = 'CHANGELOG.md';
  const raw = (p: string) => readFileSync(join(ROOT, p), 'utf8');
  // #855's correction: a table cell writes the list mark `|` as `\|`; the reader sees `|`.
  const flatten = (t: string) => t.replace(/\\\|/g, '|').replace(/\s+/g, ' ');
  /** (a) red when the page no longer holds the sentence word for word; (b) prints it. */
  const claimOn = (p: string, sentence: string): void => {
    expect(flatten(raw(p)), `${p} no longer says: ${sentence}`).toContain(flatten(sentence));
  };
  const stateRow = (state: string): string =>
    (
      raw(HANDLERS)
        .split('\n')
        .find((l) => l.startsWith(`| \`${state}\``)) ?? ''
    )
      .split(/(?<!\\)\|/)[2]!
      .replace(/\\\|/g, '|')
      .trim();
  const state = (quote: string, source: string) => locateQuote(quote, source).state;
  const ch = String.fromCodePoint;
  const F = 'The Landlord shall insure the Building';
  /** A skip from F onto `second`, the document joining them with `join`. */
  const skipTo = (join: string, second: string, quoted = second): [string, string] => [
    `${F} … ${quoted}`,
    `${F} for its full reinstatement cost${join}${second} at the end of each year.`,
  ];

  it('§1 the exact row: a format character (`Cf`) inside a word makes no word edge, and neither does a combining one (U+034F, a variation selector)', () => {
    // The language unit re-pin (§5.1): the read before a match steps past every mark (§3).
    expect(stateRow('exact')).toContain(
      "an invisible character inside a word (a soft hyphen, a zero-width space, U+FEFF, U+034F, a variation selector) does not make a word edge, and neither does a visible combining mark (an accent); a contraction ending in `'t` or `'nt`, written with any contraction apostrophe, makes no word edge either (`CAN` is not found in `CAN'T`, nor `can` in `can´t`, nor `did` in `did'nt`, nor `t make` in `won't make`), and neither does a word hyphen or a soft hyphen that breaks a word across one line (`paid` is not found after `un-` ending a line); the quote never starts or ends between a letter and a visible mark on it.",
    );
    const inside = (code: number) =>
      state(
        'lawful use of the Premises',
        `The Tenant shall not permit any un${ch(code)}lawful use of the Premises.`,
      );
    // (a) red when a soft hyphen, U+034F or a variation selector makes an edge again (the read before
    //     a match no longer stepping past marks); (b) prints the three states.
    expect([inside(0xad), inside(0x034f), inside(0xfe0f)]).toEqual([
      'not_found',
      'not_found',
      'not_found',
    ]);
  });

  it('§1 the capital condition: an opening mark (`"` `“` `„` `«` `\'` `‘` `(` `[`), or right after one in the document; a list item may open with any word; `2. Send…` passes', () => {
    // #845 (R-B) re-pin: the stitched row and rule 3 name the two sets by their glossary words now
    // (each set grew to Unicode's classes), the row "below", rule 3 "as the glossary above defines
    // it". (a) red when either loses its sentence; the sets themselves are run by the glossary cells.
    for (const where of ['below', 'as the glossary above defines it']) {
      claimOn(
        HANDLERS,
        `the next piece begins with a capital letter or an opening mark (an opening mark, ${where}), or starts right after one in the document; at a new line that counts, other than after a blank line under a line that ends none of those, an item after a list mark (a list mark, ${where}) may open with any word,`,
      );
      claimOn(
        HANDLERS,
        `a clause number only before a capital letter or an opening mark (an opening mark, ${where}).`,
      );
    }
    claimOn(
      CL,
      'after a full stop the next piece must begin with a capital letter or an opening mark (`"` `“` `„` `«` `\'` `‘` `(` `[`), or start right after one in the document;',
    );
    // The reader's four inputs (F760-C3R-02), and the two that must not read found (F760-DTA-02).
    const lowercase = 'the Tenant shall pay the insurance rent';
    // (a) red when an input the sentence admits is refused, or one it does not is found; (b) prints
    //     the states.
    expect({
      afterMark: state(
        `${F} … ${lowercase}`,
        `${F} for its cost. (${lowercase} at the end of each year.)`,
      ),
      listItem: state(
        `${F} … ${lowercase}`,
        `${F} for its cost.\n- ${lowercase} at the end of each year.`,
      ),
      ownNumber: state(
        `${F} … 2. Send the notice to the Tenant at once`,
        `${F} for its cost.\n2. Send the notice to the Tenant at once.`,
      ),
      labelThenMark: state(
        `${F} … ${lowercase}`,
        `${F} for its cost.\n\n6.2 (${lowercase} at the end of each year.)`,
      ),
      ownNumberLowercase: state(
        `${F} … 2. send the notice to the Tenant at once`,
        `${F} for its cost.\n2. send the notice to the Tenant at once.`,
      ),
      listItemAfterMidSentence: state(...skipTo(' and\n- ', lowercase)),
      notOpeningMarks: [
        state(`${F} … ${lowercase}`, `${F} for its cost. {${lowercase} at the end of each year.}`),
        state(`${F} … ${lowercase}`, `${F} for its cost. <${lowercase} at the end of each year.>`),
      ],
    }).toEqual({
      afterMark: 'stitched',
      listItem: 'stitched',
      ownNumber: 'stitched',
      labelThenMark: 'stitched',
      ownNumberLowercase: 'not_found',
      listItemAfterMidSentence: 'not_found',
      notOpeningMarks: ['not_found', 'not_found'],
    });
  });

  it('§2 can still read found: a blank line inside a sentence, or a header between blank lines, before a word that begins with a capital letter, past one opening mark, or one clause number or list mark followed by at most one opening mark (#845 1b-i-n: no longer a lowercase word after an opening mark or a short first word’s `.`)', () => {
    claimOn(
      HANDLERS,
      'A blank line inside a sentence, or a header between blank lines, counts as a line start, as at a PDF page break, before a word that begins with a capital letter, past one opening mark, or one clause number or list mark followed by at most one opening mark (a `+`, `>`, `|`, `∙`, `⦾` or `⦿` list mark only when the quote leaves it out): a skip may land there.',
    );
    const Rest =
      'The Landlord is not responsible for repairs to the structure, roof, foundations or exterior';
    const doc = (between: string, after: string) =>
      `${F} for its full reinstatement cost. The Tenant shall${between}${after}.`;
    const header = '\n\nLease of Office Premises — page 4\n\n';
    const lower = 'not be responsible for repairs to the structure, roof, foundations or exterior';
    const withCause = (quote: string, source: string) => {
      const c = locateQuote(quote, source);
      return `${c.state}${c.cause === undefined ? '' : `+${c.cause}`}`;
    };
    // #845 1b-i (B3) re-pin: main let a skip land on any word after such a blank line; now only on
    // what the bullet names. #845 1b-i-n re-pin: a lowercase word after an opening mark, or after a
    // short first word's `.`, is refused there too, with `cause` (main: `stitched`). (a) red when
    // the gap closes for one of the found ones (the bullet would then be false), or a lowercase
    // word, with or without an opening mark before it, is admitted again; (b) prints the states.
    expect({
      capital: state(`${F} … ${Rest}`, doc('\n\n', Rest)),
      header: state(`${F} … ${Rest}`, doc(header, Rest)),
      openingMark: state(`${F} … (${Rest}`, doc('\n\n', `(${Rest}`)),
      clauseNumber: state(`${F} … 2. ${Rest}`, doc('\n\n', `2. ${Rest}`)),
      listMark: state(`${F} … ${Rest}`, doc('\n\n', `- ${Rest}`)),
      lowercase: state(`${F} … ${Rest.toLowerCase()}`, doc('\n\n', Rest.toLowerCase())),
      formFeed: state(`${F} … ${Rest}`, doc('\f', Rest)),
      // 1b-i's "also", now refused: a lowercase word right after an opening mark, the mark quoted
      // or not, and after a line's first word and its `.` (the label skipped)
      afterBracket: withCause(
        `${F} … (subject to clause 5) ${lower}`,
        doc('\n\n', `(subject to clause 5) ${lower}`),
      ),
      afterQuoteMarkKept: withCause(`${F} … “${lower}`, doc('\n\n', `“${lower}”`)),
      afterQuoteMarkDropped: withCause(`${F} … ${lower}`, doc('\n\n', `“${lower}”`)),
      afterFirstWordAndStop: withCause(`${F} … “${lower}`, doc('\n\n', `2. “${lower}”`)),
    }).toEqual({
      capital: 'stitched',
      header: 'stitched',
      openingMark: 'stitched',
      clauseNumber: 'stitched',
      listMark: 'stitched',
      lowercase: 'not_found',
      formFeed: 'not_found',
      afterBracket: 'not_found+blank_line_join',
      afterQuoteMarkKept: 'not_found+blank_line_join',
      afterQuoteMarkDropped: 'not_found+blank_line_join',
      afterFirstWordAndStop: 'not_found+blank_line_join',
    });
    // #845 1b-i-n correction 1: what "one opening mark, or one clause number or list mark followed by
    // at most one opening mark (a `+`, `>`, `|`, `∙`, `⦾` or `⦿` list mark only when the quote leaves it out)"
    // passes, and what it does not. (a) red when a label and its one mark, skipped, stop being passed
    // (`(a)`: the line's head decides, not a `.`), or a `>` list mark the quote leaves out is not
    // passed (408a0073 refused it: the canonical form keeps the sign), or one the quote includes is,
    // or two opening marks, or a mark before a label, are passed; (b) prints the states.
    expect({
      labelThenMark: state(`${F} … ${Rest}`, doc('\n\n', `(a) “${Rest}`)),
      keptListMarkSkipped: state(`${F} … ${Rest}`, doc('\n\n', `> ${Rest}`)),
      keptListMarkQuoted: state(`${F} … > ${Rest}`, doc('\n\n', `> ${Rest}`)),
      twoMarks: state(`${F} … ((${Rest}`, doc('\n\n', `((${Rest}`)),
      markBeforeLabel: state(`${F} … “(a) ${Rest}`, doc('\n\n', `“(a) ${Rest}`)),
    }).toEqual({
      labelThenMark: 'stitched',
      keptListMarkSkipped: 'stitched',
      keptListMarkQuoted: 'not_found',
      twoMarks: 'not_found',
      markBeforeLabel: 'not_found',
    });
  });

  it('§2 can still read found: a dotted decimal before a capitalised word at a line start that counts', () => {
    claimOn(
      HANDLERS,
      'A dotted decimal before a capitalised word at a line start that counts reads as a clause label (`2.5 Million`): a skip may land after it.',
    );
    const million = 'Million euro is payable on completion';
    // (a) red when the gap closes, or a line that does not count admits it; (b) prints the states.
    expect([
      state(...skipTo(':\n2.5 ', million)),
      state(...skipTo('.\n\n2.5 ', million)),
      state(...skipTo(' and\n2.5 ', million)),
    ]).toEqual(['stitched', 'stitched', 'not_found']);
  });

  it('§2 #845 closed (R-C1): an invisible character inside a number, or between a sign and its number, no longer lets part of it read found', () => {
    // #845 re-pin: the bullet went from "What can still read found" (an invisible character leaves
    // before the number rules, so the number is whole).
    expect(flatten(raw(HANDLERS))).not.toContain(
      flatten(
        'An invisible format character (`Cf`) inside a number, between a leading decimal point',
      ),
    );
    // (a) red when the gap opens again, or the plain number stops being one unit; (b) prints the
    //     states.
    expect([
      state('the fee is 12', `the fee is 12${ch(0xad)}500 euro`),
      state('5 degrees', `-${ch(0x200b)}5 degrees`),
      state('the fee is 12', 'the fee is 12500 euro'),
      state('5 degrees', '-5 degrees'),
    ]).toEqual(['not_found', 'not_found', 'not_found', 'not_found']);
  });

  it("§2 can still read found: a contraction misspelled with a space beside its apostrophe; other contractions cut at their apostrophe (#845 1b-ii-a re-pin: a contraction ending in `'t` or `'nt` no longer)", () => {
    claimOn(
      HANDLERS,
      "A contraction misspelled with a space beside its apostrophe: `can` is found in `can' t` and `can 't`. Refusing it would refuse honest plural possessives, such as `Tenants' t…`. Other contractions cut at their apostrophe are found too: `you` in `you'll`, `it` in `it's`.",
    );
    // #845 1b-ii-a re-pin: `CAN` in `CAN'T`, `can` in `can´t`, `did` in `did'nt` and `t make` in
    // `won't make` now read `not_found` (the exact row's sentence). (a) red when one of these
    // changes (a gap closed, or the rule that holds broken); (b) prints the states.
    expect({
      found: [
        state('The Landlord can', "The Landlord can' t refuse consent."),
        state('The Landlord can', "The Landlord can 't refuse consent."),
        state('the Tenants', "the Tenants' terms apply"),
        state('If you', "If you'll pay the rent."),
        state('It', "It's due on the first day."),
      ],
      holds: [
        state('The Landlord can', "The Landlord can't refuse consent."),
        state('THE LANDLORD CAN', "THE LANDLORD CAN'T REFUSE CONSENT."),
      ],
    }).toEqual({
      found: ['exact', 'exact', 'exact', 'exact', 'exact'],
      holds: ['not_found', 'not_found'],
    });
  });

  it('§2 can still read found: a hyphen that breaks a word across two line breaks or more; a page break alone is one line break (#845 1b-ii-a wording 1 re-pin)', () => {
    claimOn(
      HANDLERS,
      'A hyphen that breaks a word across two line breaks or more (CR LF counts as one), such as a blank line or a line break next to a page break (U+000A U+000C): `paid` is found after `un-` and a blank line. A page break alone (U+000C) is one line break, so there `paid` reads not found.',
    );
    // #845 1b-ii-a wording 1 re-pin: each break the sentence names, and the three single line
    // breaks. (a) red when the gap closes across two line breaks, CR LF stops counting as one, or a
    // lone page break (or one CR LF, or one LF) lets `paid` read found; (b) prints each state.
    const after = (gap: string) =>
      state(
        'paid for twenty-one days',
        `If any Rent shall at any time remain un-${gap}paid for twenty-one days.`,
      );
    expect({
      'LF LF (a blank line)': after('\n\n'),
      'LF FF': after('\n\f'),
      'FF LF': after('\f\n'),
      'CR LF CR LF': after('\r\n\r\n'),
      'LF, blanks, LF': after('\n  \n'),
      'CR LF FF': after('\r\n\f'),
      'FF alone': after('\f'),
      'CR LF alone': after('\r\n'),
      'LF alone': after('\n'),
    }).toEqual({
      'LF LF (a blank line)': 'exact',
      'LF FF': 'exact',
      'FF LF': 'exact',
      'CR LF CR LF': 'exact',
      'LF, blanks, LF': 'exact',
      'CR LF FF': 'exact',
      'FF alone': 'not_found',
      'CR LF alone': 'not_found',
      'LF alone': 'not_found',
    });
  });

  it("§2 can still read found: an abbreviation not on the check's list, before a capital letter or an opening mark, is read as a sentence end (every member: #855's correction §4); an initialism is not (#845 R-A3)", () => {
    // #855's correction (§4): `:396`'s `U.S.` sentence merged into the abbreviation bullet.
    claimOn(
      HANDLERS,
      "An abbreviation that is not on the check's list (`e.g.`, `i.e.`, `etc.`, `No.`, `Nos.`, `cl.`, `para.`, `Sch.`, `Ltd.`, `Co.`, `Inc.`, `St.`, `Mr.`, `Mrs.`, `Ms.`, `Dr.`, in any letter case, an initial, and an initialism), before a capital letter or an opening mark, is read as a sentence end (`a.m. Monday`, `excl. VAT`): a skip may land there.",
    );
    const capital = 'Capital rules apply to the Tenant at all times';
    // (a) red when the gap closes for `a.m.`, or an initial or an initialism starts ending a sentence
    //     (#845 R-A3 re-pin: `U.S.` and `U.S.A.` no longer do), or (#845 1b-ii-b correction 1: "in
    //     any letter case") a listed abbreviation in capitals does; (b) prints the states.
    expect([
      state(...skipTo(' before 9 a.m. ', capital)),
      state(...skipTo(' in the U.S. ', capital)),
      state(...skipTo(' in the U.S.A. ', capital)),
      state(...skipTo(' by J. ', 'Smith shall pay the insurance rent at once')),
      state(...skipTo(' as in Clause NO. ', capital)),
    ]).toEqual(['stitched', 'not_found', 'not_found', 'not_found', 'not_found']);
  });

  it('§2 #845 closed (R-B, Outside-b): a group of thousands spaced with any `\\p{Zs}` space, and a `:` at a line end before a digit', () => {
    // #845 re-pin: every `\p{Zs}` space groups thousands now, so the group-space bullet went from
    // "What can still read found"; #845 1b-i (Outside-b) re-pin: a `:` between two digits ends no
    // clause, even across a line break, so the `:` bullet went too (main: `stitched`).
    expect(flatten(raw(HANDLERS))).not.toContain(
      flatten('A group of thousands spaced with any space but a plain space'),
    );
    expect(flatten(raw(HANDLERS))).not.toContain(
      flatten(
        "A `:` at a line's end before a digit (`at 9:` ending a line and `30` starting the next)",
      ),
    );
    const grouped = (space: number) =>
      state(`the rent is 1${ch(space)}200`, `the rent is 1${ch(space)}200${ch(space)}000 euro`);
    // (a) red when one of these gaps opens again, or a plain group space stops being one number;
    //     (b) prints the states.
    expect({
      groups: [grouped(0x2007), grouped(0x2002), grouped(0x2008), grouped(0x3000), grouped(0x20)],
      colon: state(
        `${F} … 30 minutes before the Tenant arrives at the Building`,
        `${F} for its cost at 9:\n30 minutes before the Tenant arrives at the Building.`,
      ),
    }).toEqual({
      groups: ['not_found', 'not_found', 'not_found', 'not_found', 'not_found'],
      colon: 'not_found',
    });
  });

  it('§2 the enclosed letters: circled, squared and parenthesised read as letters; negative squared and circled letters and regional indicators are set aside', () => {
    // The language unit re-pin (§5.2); #845 (R-D) re-pin: the clause on marks on digits and signs
    // went (such a mark leaves before the number rules), so the sentence opens with the letters.
    claimOn(
      HANDLERS,
      'Circled, squared and parenthesised letters read as letters (`ⓃⓄⓉ` reads `not`). Negative squared and negative circled letters (`🅽🅾🆃`, `🅝🅞🅣`) and regional indicators are set aside like other symbols, so a quote reads found whether it carries them or leaves them out.',
    );
    const without = `${F}.`;
    const kinds = {
      circled: 'ⓃⓄⓉ',
      squared: '🄽🄾🅃',
      parenthesised: '⒩⒪⒯',
      negativeSquared: '🅽🅾🆃',
      negativeCircled: '🅝🅞🅣',
      regional: '🇳🇴🇹',
    };
    const asLetters = Object.values(kinds).map((w) =>
      state(
        'The Landlord shall not insure the Building',
        `The Landlord shall ${w} insure the Building.`,
      ),
    );
    const carried = Object.values(kinds).map((w) =>
      state(`The Landlord shall ${w} insure the Building`, without),
    );
    const left = Object.values(kinds).map((w) =>
      state(F, `The Landlord shall ${w} insure the Building.`),
    );
    // (a) red when one kind is read otherwise than the bullet says; (b) prints the states, in the
    //     order circled, squared, parenthesised, negative squared, negative circled, regional.
    expect({ asLetters, carried, left }).toEqual({
      asLetters: [
        'reformatted',
        'reformatted',
        'reformatted',
        'not_found',
        'not_found',
        'not_found',
      ],
      carried: ['not_found', 'not_found', 'not_found', 'reformatted', 'reformatted', 'reformatted'],
      left: ['not_found', 'not_found', 'not_found', 'reformatted', 'reformatted', 'reformatted'],
    });
  });

  it("§2 `cut_short`: an `exact` quote is marked at its stop, past the whitespace it carries, when the document goes on with a lowercase letter or a digit (every member: #855's correction §1; #845 1b-ii-b re-pin)", () => {
    // #845 1b-ii-b re-pin: the paragraph replaced whole (its walk M8 sentence is claimed by its own
    // cell, "#845 1b-i — the words of rule 7").
    claimOn(
      HANDLERS,
      "A quote that ends a sentence where the document's sentence goes on is marked `cut_short`, with where; the reviewer reads the rest. An `exact` quote ends a sentence at its last character other than whitespace and invisible characters, when that is `.`, `!` or `?`; in every other state, it ends one at each `.`, `!` or `?` inside the quote, but the dots of `...` and a `.` right after `…`, that whitespace or the quote's end follows past any invisible characters. A `.` that ends an abbreviation on the check's list, an initial, an initialism or a word with no letter or digit ends no sentence (`Clause No.`, `e.g.`, `U.S.`, `20 °.`). From there the check reads the document, past closing marks and invisible characters. Where the document has its own `.`, `!` or `?` and the quote stops there (an exact quote's end, a part's end in a `stitched` or `stitched_out_of_order` quote, a reformatted quote's end), the quote is marked when, past that stop, closing marks and whitespace other than a line break, a lowercase letter or a digit follows (`approx. 412`); inside a quote that goes on with the document's own next words, that stop marks nothing. Where the document has no stop, the quote is marked unless whitespace other than a line break, then a line break or the text's end, follows. Whitespace the quote carries after its stop changes nothing.",
    );
    // #866 correction 1 (C4): the handlers paragraph carries the CHANGELOG's `….` words too.
    // the owner's word, 2026-10-24 ("i agree"): a `.` right after `…` is no sentence end inside a
    // quote — the `…` run takes it (locate-quote.ts, `segmentsWithin`); its row: B1 and M5
    claimOn(
      CL,
      "A quote that ends a sentence where the document's goes on is marked `cut_short`, with `cut_short_at`; an `exact` quote is marked when its last character is its `.`, `!` or `?` and the document goes on, past the closing marks `\"` `'` `)` `]` `}` `»` `’` `”`, U+0020 and U+0009, with a lowercase letter (`\\p{Ll}`) or a digit (`\\p{Nd}`) of the Basic Multilingual Plane, and every other state at each `.`, `!` or `?` inside the quote, but the dots of `...` and a `.` right after `…`, that whitespace (`\\s`) or the quote's end follows, unless it ends an abbreviation on the check's list or an initial, where the document has no stop and goes on. The handlers reference lists what a crafted quote can still get read as found, and what an honest quote is still refused (\"What `check_quotes` does not catch\").",
    );
    const doc = 'The area is not less than approx. 412 square metres.';
    const marked = (q: string) => {
      const r = locateQuote(q, doc);
      return [r.state, r.cut_short === true, r.cut_short_at];
    };
    // #845 1b-ii-b re-pin: the released CHANGELOG line above ([0.48.0]) is claimed as written; the
    // run follows the new paragraph ("Whitespace the quote carries after its stop changes nothing"),
    // so the quote carrying a space is marked, right after its stop, as the one without it. (a) red
    // when either loses the mark, or the space case's mark falls at the quote's end (34); (b) prints
    // the states, labels and offsets.
    expect([
      marked('The area is not less than approx.'),
      marked('The area is not less than approx. '),
    ]).toEqual([
      ['exact', true, [33]],
      ['exact', true, [33]],
    ]);
  });

  it("§2 honest refusals: a skip past a clause number onto a lowercase first word; quoting the label too reads stitched after `:` (every member: #855's correction §2)", () => {
    claimOn(
      HANDLERS,
      'A skip past a clause number onto a lowercase first word (`… keep the Premises` after `(b)`); quoting the label as well reads `stitched` after a line that ends with `;` or `:`, or after a blank line that follows a line ending a sentence or a clause; after a line that ends a sentence, a label that opens with an opening mark or a capital letter does (`(b) keep…`, `A) keep…`, `IV. keep…`), and one that opens with a digit needs a capital letter or an opening mark after it (`2. Send…`). `b.` and `a)` are not read as labels.',
    );
    const item = 'keep the Premises in good and substantial repair';
    // (a) red when the skip past the label reads found (the bullet would then be false), or the label
    //     quoted too is refused; (b) prints the two states.
    expect([state(...skipTo(':\n(b) ', item)), state(...skipTo(':\n', `(b) ${item}`))]).toEqual([
      'not_found',
      'stitched',
    ]);
  });

  it('§2 honest refusals: a page header crossed without `…`, and a whole word quoted across a hyphen that breaks it over a line', () => {
    // #855's correction (§5, M3): two bullets now; the header's every form runs in its own cell.
    claimOn(
      HANDLERS,
      "A page header crossed without `…`, joined with a space; a quote that keeps the line break, or skips the header with `…`, reads `stitched` only when a blank line follows the header, or the header ends with `;`, `:` or a table row's `|`, or ends a sentence and the line after it opens with a capital letter, an opening mark, a list mark or a run of U+0023; a line that opens with `;` or `:` reads `stitched` after any header, since a clause starts there.",
    );
    claimOn(
      HANDLERS,
      'A whole word quoted across a hyphen that breaks it over a line (`substantial` across `sub-` ending a line and `stantial` starting the next).',
    );
    const page = `${F} for its full reinstatement cost. The Tenant shall\n\nLease of Office Premises — page 4\n\nnot be responsible for repairs to the structure.`;
    // #845 1b-i (B3, Q-C) re-pin: the header line ends nothing and `not` is lowercase, so the `…` skip
    // over it joins text across a blank line and is refused (the new bullet: "A `…` skip over a page
    // header onto a lowercase word…"); main read it `stitched`.
    // (a) red when one of these reads found (its bullet would then be false); (b) prints the states.
    expect({
      headerCrossed: state(
        `${F} for its full reinstatement cost. The Tenant shall not be responsible for repairs to the structure`,
        page,
      ),
      headerSkipped: state(
        `${F} for its full reinstatement cost. The Tenant shall … not be responsible for repairs to the structure`,
        page,
      ),
      hyphenWord: [
        state(
          'keep the Premises in good and substantial repair',
          'The Tenant shall keep the Premises in good and sub-\nstantial repair.',
        ),
        state(
          'keep the Premises in good and substantial repair',
          `The Tenant shall keep the Premises in good and sub${ch(0xad)}\nstantial repair.`,
        ),
      ],
    }).toEqual({
      headerCrossed: 'not_found',
      headerSkipped: 'not_found',
      hyphenWord: ['not_found', 'not_found'],
    });
  });

  it("honest not found: a quote that starts or ends beside a word hyphen right after a word at a line's end, where it breaks no word (#845 1b-ii-a wording 1 re-pin)", () => {
    claimOn(
      HANDLERS,
      "A quote that starts or ends beside a word hyphen written right after a word at a line's end, where it breaks no word: one that starts after a suspended hyphen (`and long-term liabilities` after `all short-` ending a line) or ends at the suspended word (`The accounts show all short-`), and one that starts on the line after a heading whose hyphen is a dash (`The Tenant shall pay…` after `4. RENT-`). The hyphen reads as breaking one word. A dash with a space before it, or an en or em dash, keeps the edge (`4. RENT -`, `4. RENT–`).",
    );
    const accounts = 'The accounts show all short-\nand long-term liabilities of the Company.';
    const lease = (heading: string) =>
      `4. ${heading}\r\nThe Tenant shall pay the Rent on the usual quarter days.\r\n5. REPAIR\r\n`;
    const pay = 'The Tenant shall pay the Rent on the usual quarter days.';
    // (a) red when one of the bullet's honest quotes reads found (the bullet would then be false),
    //     a control loses its edge, or the quote that spans the hyphen stops reading found; (b)
    //     prints each state.
    expect({
      'starts after `all short-`': state('and long-term liabilities', accounts),
      'ends at `all short-`': state('The accounts show all short-', accounts),
      'the line after `4. RENT-`': state(pay, lease('RENT-')),
      'control `4. RENT -`': state(pay, lease('RENT -')),
      'control `4. RENT\u2013`': state(pay, lease('RENT\u2013')),
      'control `4. RENT\u2014`': state(pay, lease('RENT\u2014')),
      'spans the hyphen': state('all short- and long-term liabilities', accounts),
    }).toEqual({
      'starts after `all short-`': 'not_found',
      'ends at `all short-`': 'not_found',
      'the line after `4. RENT-`': 'not_found',
      'control `4. RENT -`': 'exact',
      'control `4. RENT\u2013`': 'exact',
      'control `4. RENT\u2014`': 'exact',
      'spans the hyphen': 'reformatted',
    });
  });

  it('§4 the CHANGELOG states the skip rule, and its `locateQuote` paragraph ends by pointing at the docs’ list of exceptions', () => {
    claimOn(
      CL,
      'and by the rule only to where the document starts a sentence, a clause or a line.',
    );
    // #855's correction (§6, S3): the pointer moved to the end of the #760 `locateQuote` paragraph.
    const pointer =
      'The handlers reference lists what a crafted quote can still get read as found, and what an honest quote is still refused ("What `check_quotes` does not catch").';
    const text = raw(CL);
    const start = text.indexOf('- **`locateQuote`, the sixth helper');
    const paragraph = flatten(text.slice(start, text.indexOf('\n- **', start + 1))).trim();
    // (a) red when the pointer is gone or is not the paragraph's last sentence, or the list it points
    //     at is gone or renamed; (b) prints the paragraph's closing words and a boolean.
    expect({ start: start >= 0, last: paragraph.slice(-flatten(pointer).length) }).toEqual({
      start: true,
      last: flatten(pointer),
    });
    expect(raw(HANDLERS).includes('\n#### What `check_quotes` does not catch\n')).toBe(true);
  });

  it("§4 the example workflow's agent prompt gives the prose's quoting instruction, word for word", () => {
    const prose =
      "Ask the model for one contiguous span copied character for character, or two spans joined by `…`; each span after the first starts where a sentence or clause of the document starts, or at a new line after a finished sentence, a finished clause or a blank line; after a full stop, or after a blank line inside a sentence, a span starts only at a word that begins with a capital letter, past one opening mark, or, at a line's start, one label followed by at most one opening mark.";
    claimOn(HANDLERS, prose);
    const yaml = raw(HANDLERS)
      .split(/^```[a-z]*\n/m)
      .filter((_, i) => i % 2 === 1)
      .find((b) => b.includes('handler: check_quotes'))!;
    const prompt = flatten(loadWorkflowFromString(yaml).steps['extract_fields']!.prompt ?? '');
    // The prose speaks to the reader ("Ask the model for") and marks `…` as code; the prompt speaks
    // to the model. Every word from "one contiguous span" on is the same.
    const instruction = prose.slice('Ask the model for '.length).replaceAll('`', '');
    // (a) red when the prompt's instruction drifts from the prose's; (b) prints a boolean.
    expect(prompt.includes(instruction)).toBe(true);
  });

  it('§5 exact matching, not a model: the claim, beside a `4.5%` quote that reads found while the value says `5%`', async () => {
    claimOn(
      HANDLERS,
      'The step checks quotes, not meaning. A value whose quote is in the document may still be wrong: the quote can say `4.5%` while the value says `5%`. Realm matches quotes exactly, because exact matching is what makes the check reliable. It does not judge meaning with a model, which is a different approach that some tools take and Realm declines.',
    );
    const result = await new CheckQuotesHandler().execute(
      { params: {} },
      {
        run_id: 'r',
        run_params: {},
        config: { source_step: 'doc', candidates_step: 'extract' },
        resources: {
          doc: { text: 'The interest rate is 4.5% a year above the Base Rate.' },
          extract: {
            candidates: [{ field: 'rate', value: '5%', quote: 'The interest rate is 4.5% a year' }],
          },
        },
      },
    );
    // (a) red when the check reads the value, not the quote (the wrong value would then be refused);
    //     (b) prints the state and the flag.
    expect({
      state: (result.data?.['results'] as Array<{ quote_check: { state: string } }>)[0]!.quote_check
        .state,
      all_found: result.data?.['all_found'],
    }).toEqual({ state: 'exact', all_found: true });
  });
});

// #855's correction (MA 3, 2026-10-22): a sentence that names a set is true only for the members its
// cell runs. #855's second correction (the owner's option A, 2026-10-22): every cell iterates its
// WHOLE group — Unicode's own property walked over the code points the sentence covers (the BMP
// unless it says every plane), or the code's own list (exported, or copied with its file:line and run
// over the whole range) — asserts that the list it iterates is the whole group (computed again
// inside the assertion), asserts each member's state and never a count, and when red prints only the
// rows that differ: the member as `U+XXXX` (or a short label) and the state it read. A big group is
// split into `it.each` rows along one axis, so no single `it` nears the 5 s `testTimeout`. Every
// document is fictional.
describe("#855's correction: each sentence's members", () => {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
  const HANDLERS = 'docs/reference/handlers.md';
  const CL = 'CHANGELOG.md';
  const raw = (p: string) => readFileSync(join(ROOT, p), 'utf8');
  // A table cell writes the list mark `|` as `\|`; the reader sees `|`.
  const flatten = (t: string) => t.replace(/\\\|/g, '|').replace(/\s+/g, ' ');
  /** (a) red when the page no longer holds the sentence word for word; (b) prints it. */
  const claimOn = (p: string, sentence: string): void => {
    expect(flatten(raw(p)), `${p} no longer says: ${sentence}`).toContain(flatten(sentence));
  };
  const ch = String.fromCodePoint;
  const cp = (c: string) => c.codePointAt(0)!;
  const hex = (c: number) => `U+${c.toString(16).toUpperCase().padStart(4, '0')}`;
  const BMP = 0xffff;
  /** Every code point from `from` to `to` (surrogates skipped) that `re` matches. */
  const codePoints = (re: RegExp, from = 0, to = 0x10ffff): number[] => {
    const out: number[] = [];
    for (let c = from; c <= to; c++) {
      if (c >= 0xd800 && c <= 0xdfff) continue;
      if (re.test(ch(c))) out.push(c);
    }
    return out;
  };
  /** (a) red when `list` leaves out a member of the group `re` names over `from`–`to`, or holds one
   *  outside it; (b) prints those members as `U+XXXX`. The group is computed again here. */
  const whole = (list: readonly number[], re: RegExp, from = 0, to = 0x10ffff): void => {
    const group = codePoints(re, from, to);
    const listed = new Set(list);
    const inGroup = new Set(group);
    expect({
      missing: group.filter((c) => !listed.has(c)).map(hex),
      extra: list.filter((c) => !inGroup.has(c)).map(hex),
    }).toEqual({ missing: [], extra: [] });
  };
  /** A located quote's state, with `+cut_short` when it is marked. */
  const read = (quote: string, source: string): string => {
    const r = locateQuote(quote, source);
    return r.cut_short === true ? `${r.state}+cut_short` : r.state;
  };
  type Row = readonly [member: string, got: string, want: string];
  /** The rows whose state is not the one wanted, as `member: state (want …)`; empty when all hold. */
  const misses = (rows: readonly Row[]): string[] =>
    rows
      .filter(([, got, want]) => got !== want)
      .map(([member, got, want]) => `${member}: ${got} (want ${want})`);
  const F = 'The Landlord shall insure the Building';
  /** `\p{Cf}`, every plane: the format characters the invisible set (`isInvisible`) takes in. */
  const CF = codePoints(/^\p{Cf}$/u);
  /** #845 (R-C1): the 13 Prepend format characters, which `isInvisible` leaves out (visible number
   *  signs; `PREPEND_SIGNS`, copied: the code does not export it). */
  const PREPEND = [
    0x0600, 0x0601, 0x0602, 0x0603, 0x0604, 0x0605, 0x06dd, 0x070f, 0x0890, 0x0891, 0x08e2, 0x110bd,
    0x110cd,
  ];
  /** `isDash` (`locate-quote.ts:98-101`): every BMP `\p{Pd}`, and these three, copied. */
  const DASH_ADDED = [0x2212, 0x2796, 0x02d7];
  const DASHES = [...codePoints(/^\p{Pd}$/u, 0, BMP), ...DASH_ADDED];
  /** U+207B and U+208B read as a minus: NFKC makes them U+2212. */
  const NFKC_MINUS = [0x207b, 0x208b];
  /** Every BMP `\p{Sc}` and `\p{Sm}`: `isNumberSymbol`'s `CURRENCY` and `MATH` (`:157`). */
  const SIGNS = codePoints(/^[\p{Sc}\p{Sm}]$/u, 0, BMP);
  /** Every `\p{White_Space}` (`SPACE`), every plane — #845 (R-C1) re-pin: it was JavaScript's `\s`,
   *  which holds U+FEFF (invisible now) and not U+0085. */
  const WS = codePoints(/^\p{White_Space}$/u);
  /** The opening marks, `isOpeningMark`, copied: the code does not export it — #845 (R-B) re-pin:
   *  every BMP `\p{Ps}` and `\p{Pi}`, and `"` and `'`, `{` left out (it was a hand list of eight). */
  const OPENING = codePoints(/^[\p{Ps}\p{Pi}"']$/u, 0, BMP).filter((c) => c !== 0x7b);
  /** The punctuation the opening marks are told apart from: every BMP `Ps`, `Pi`, `Pf`, `Pe`, and
   *  the two plain quotation marks. */
  const MARK_GROUP = /^[\p{Ps}\p{Pi}\p{Pf}\p{Pe}"']$/u;
  const MARKS = codePoints(MARK_GROUP, 0, BMP);
  /** `CAPITAL` (`locate-quote.ts:665`): every BMP `\p{Lu}` and `\p{Lt}`. */
  const CAPITALS = codePoints(/^[\p{Lu}\p{Lt}]$/u, 0, BMP);
  /** #855's last commit: the glossary under "What `check_quotes` does not catch", word → its set's
   *  cell, read from the page. */
  const GLOSSARY = ((): Map<string, string> => {
    const lines = raw(HANDLERS).split('\n');
    const head = lines.findIndex((l) => /^\|\s*word\s*\|\s*set\s*\|$/.test(l));
    const rows = new Map<string, string>();
    for (const line of lines.slice(head + 1)) {
      if (!line.startsWith('|')) break;
      if (/^\|[\s-]+\|[\s-]+\|$/.test(line)) continue;
      const [word, set] = line
        .split('|')
        .slice(1, -1)
        .map((c) => c.trim());
      rows.set(word!, set!);
    }
    return rows;
  })();
  /** A glossary row's properties (its `\p{…}` names, before `upTo`), as one BMP set. */
  const glossaryProps = (word: string, upTo?: string): number[] => {
    const cell = GLOSSARY.get(word) ?? '';
    const names = [
      ...cell
        .slice(0, upTo === undefined ? undefined : cell.indexOf(upTo))
        .matchAll(/\\p\{(\w+)\}/g),
    ];
    if (names.length === 0) return [];
    return codePoints(new RegExp(`^[${names.map((m) => `\\p{${m[1]!}}`).join('')}]$`, 'u'), 0, BMP);
  };
  /** The `U+XXXX` entries of a text, a range (`U+0009 to U+000D`, `U+0600–U+0605`) as its members. */
  const listedCodes = (text: string): number[] =>
    [...text.matchAll(/U\+([0-9A-F]{4,6})(?:(?: to |–)U\+([0-9A-F]{4,6}))?/g)].flatMap((m) => {
      const from = parseInt(m[1]!, 16);
      const to = m[2] === undefined ? from : parseInt(m[2], 16);
      return Array.from({ length: to - from + 1 }, (_, k) => from + k);
    });
  /** A glossary row's members: its `U+XXXX` entries and ranges, and — #845 (R-B) re-pin: the rows
   *  now name sets by property — the BMP members of each `\p{…}` it names, less the members it
   *  names after "; not". */
  const glossaryCodes = (word: string): number[] => {
    const cell = GLOSSARY.get(word) ?? '';
    const cut = cell.indexOf('; not ');
    const named = new Set([
      ...listedCodes(cut < 0 ? cell : cell.slice(0, cut)),
      ...glossaryProps(word, cut < 0 ? undefined : '; not '),
    ]);
    for (const c of cut < 0 ? [] : listedCodes(cell.slice(cut))) named.delete(c);
    return [...named].sort((a, b) => a - b);
  };

  it('§1 `cut_short`: every member of both tests, each its own row', () => {
    const approx = 'The area is not less than approx.';
    const at = (rest: string) => `The area is not less than approx.${rest}`;
    const rent = 'The Tenant shall pay the Rent';
    const d1 = 'THE TENANT SHALL PAY THE RENT ON DEMAND AND PROMPTLY.';
    const d4 = `${F} for its full reinstatement cost. The Tenant shall pay the insurance rent on demand and without deduction.`;
    const d5 = `${F} for its full reinstatement cost. The Tenant shall pay the insurance rent. Then more.`;
    const d2 = `${F} for its full reinstatement cost. The Tenant shall pay the insurance rent, on demand, and promptly. Then more.`;
    const ins = 'The Tenant shall pay the insurance rent';
    const rows: Row[] = [
      // `exact`: the quote's last character other than whitespace and invisible characters is its
      // stop (#845 1b-ii-b: `exactSentenceEnd`); past closing marks and blanks in any order, the
      // document goes on with a lowercase letter or a digit.
      [
        'exact, a lowercase letter next',
        read(approx, at(' four hundred square metres.')),
        'exact+cut_short',
      ],
      [
        'exact, a digit next (approx. 412)',
        read(approx, at(' 412 square metres.')),
        'exact+cut_short',
      ],
      [
        'exact, a tab then a digit next',
        read(approx, at('\t412 square metres.')),
        'exact+cut_short',
      ],
      [
        'exact, `!` then a lowercase letter',
        read(`${rent}!`, `${rent}! and more on demand.`),
        'exact+cut_short',
      ],
      ['exact, `?` then a digit', read(`${rent}?`, `${rent}? 12 more.`), 'exact+cut_short'],
      [
        'exact, past a closing `"`',
        read(`${rent.slice(0, -4)}"Rent.`, `${rent.slice(0, -4)}"Rent." and more on demand.`),
        'exact+cut_short',
      ],
      [
        'exact, past a closing `)`',
        read(`${rent}.`, `${rent}.) and more on demand.`),
        'exact+cut_short',
      ],
      ['exact, a capital next', read(approx, at(' Four hundred square metres.')), 'exact'],
      // #845 (R-B) re-pin: U+00A0 is a blank (whitespace other than a line break), walked past
      [
        'exact, a no-break space before the digit',
        read(approx, at('\u00a0412 square metres.')),
        'exact+cut_short',
      ],
      [
        'exact, a line break before a lowercase word',
        read(`${rent}.`, `${rent}.\nand more on demand.`),
        'exact',
      ],
      // #845 1b-ii-b re-pin: whitespace the quote carries after its stop changes nothing
      [
        'exact, the quote carries a space after its stop',
        read(`${approx} `, at(' 412 square metres.')),
        'exact+cut_short',
      ],
      [
        'exact, the quote carries a tab (the document too)',
        read(`${approx}\t`, at('\t412 square metres.')),
        'exact+cut_short',
      ],
      [
        'exact, the quote carries a line break (the document too)',
        read(`${approx}\n`, at('\n412 square metres.')),
        'exact',
      ],
      // #845 1b-ii-b re-pin: the quote's last piece ends at the document's own stop, before a digit
      [
        'the quote carries a tab, the document a space',
        read(`${approx}\t`, at(' 412 square metres.')),
        'reformatted+cut_short',
      ],
      [
        'the quote carries a line break, the document a space',
        read(`${approx}\n`, at(' 412 square metres.')),
        'reformatted+cut_short',
      ],
      // Every other state (`sentenceGoesOn`): at each sentence end inside the quote where the document
      // has no stop and does not end its line or its text; #845 1b-ii-b: and at the quote's last
      // piece, or a part's, where the document has the same stop before a lowercase letter or a digit.
      ['reformatted, the document has no stop (B1)', read(`${rent}.`, d1), 'reformatted+cut_short'],
      ['reformatted, `!`', read(`${rent}!`, d1), 'reformatted+cut_short'],
      ['reformatted, `?`', read(`${rent}?`, d1), 'reformatted+cut_short'],
      [
        'reformatted, an inner stop',
        read('the tenant shall pay the rent. on demand and promptly', d1),
        'reformatted+cut_short',
      ],
      // #845 1b-ii-b re-pin: marked, the document's own stop then a digit
      [
        'reformatted, the document has the same stop',
        read('the area is not less than approx.', at(' 412 square metres.')),
        'reformatted+cut_short',
      ],
      ['reformatted, a trailing space', read(`${rent}. `, d1), 'reformatted+cut_short'],
      ['reformatted, a trailing tab', read(`${rent}.\t`, d1), 'reformatted+cut_short'],
      ['reformatted, a trailing line break', read(`${rent}.\n`, d1), 'reformatted+cut_short'],
      [
        'reformatted, the document goes on with `,`',
        read(`${rent}.`, 'THE TENANT SHALL PAY THE RENT, ON DEMAND.'),
        'reformatted+cut_short',
      ],
      [
        'reformatted, the document goes on with a capital',
        read(`${rent}.`, 'THE TENANT SHALL PAY THE RENT ON DEMAND'),
        'reformatted+cut_short',
      ],
      [
        'reformatted, the document ends its line',
        read(`${rent}.`, 'THE TENANT SHALL PAY THE RENT\nON DEMAND.'),
        'reformatted',
      ],
      [
        'reformatted, the document ends its text',
        read(`${rent}.`, 'THE TENANT SHALL PAY THE RENT'),
        'reformatted',
      ],
      [
        'stitched, an inner `.` the document lacks',
        read(`${F}. … ${ins}`, d4),
        'stitched+cut_short',
      ],
      ['stitched, an inner `!`', read(`${F}! … ${ins}`, d4), 'stitched+cut_short'],
      ['stitched, an inner `?`', read(`${F}? … ${ins}`, d4), 'stitched+cut_short'],
      [
        "stitched, the quote ends at the document's own stop",
        read(`${F} … ${ins}.`, d5),
        'stitched',
      ],
      [
        "stitched, a trailing space (the reader's input)",
        read(`${F} … ${ins}. `, d2),
        'stitched+cut_short',
      ],
      ['stitched, no trailing space', read(`${F} … ${ins}.`, d2), 'stitched+cut_short'],
      ['stitched, a trailing tab', read(`${F} … ${ins}.\t`, d4), 'stitched+cut_short'],
      [
        'stitched, the document ends its line',
        read(`${F} … ${ins}.`, `${F} for its full reinstatement cost. ${ins}\non demand.`),
        'stitched',
      ],
      [
        'stitched, the document ends its text',
        read(`${F} … ${ins}.`, `${F} for its full reinstatement cost. ${ins}`),
        'stitched',
      ],
      [
        'stitched_out_of_order, marked',
        read(`${ins}. … ${F}`, `${F} for its full reinstatement cost. ${ins} on demand.`),
        'stitched_out_of_order+cut_short',
      ],
    ];
    // (1) red when the read accepts a capital after the stop (the capital row), or either test moves;
    // (2) prints each differing row's label and state.
    expect(misses(rows)).toEqual([]);
  });

  // ─── #855's second correction: the fifteen ─────────────────────────────────────────────────────

  it("B1 the CHANGELOG's `exact` sentence: marked at the quote's stop, past the whitespace it carries, never past a closing mark it carries (#845 1b-ii-b re-pin)", () => {
    // The sentence is claimed by the re-pinned "§2 `cut_short` …" cell (#760 follow-up). #845 1b-ii-b
    // re-pin: the released line keeps its words; the run follows the new paragraph, where whitespace
    // the quote carries after its stop changes nothing.
    const set = (stop: string) => `The fee is set${stop}`;
    const rows: Row[] = [
      // F760-855CR-01: a quote whose last character is not its stop is not marked; #845 1b-ii-b
      // re-pin: a space is no such character
      [
        'a space after the stop',
        read('The fee is approx. ', 'The fee is approx. 412 euro.'),
        'exact+cut_short',
      ],
      [
        'a closing `"` after the stop',
        read('The fee is approx."', 'The fee is approx." and 412 euro.'),
        'exact',
      ],
      ...['.', '!', '?'].flatMap((stop): Row[] => [
        [
          `${stop} then a lowercase letter`,
          read(set(stop), `${set(stop)} and paid monthly.`),
          'exact+cut_short',
        ],
        [
          `${stop} then a digit`,
          read(set(stop), `${set(stop)} 412 euro a month.`),
          'exact+cut_short',
        ],
      ]),
    ];
    // (1) red when an `exact` quote whose last character other than whitespace is not its stop is
    //     marked, the quote carrying a space loses the mark, or a stop the sentence names stops
    //     marking; (2) prints each differing row's label and state.
    expect(misses(rows)).toEqual([]);
  });

  const LOWER = codePoints(/^\p{Ll}$/u, 0, BMP);
  const DIGITS = codePoints(/^\p{Nd}$/u, 0, BMP);

  it('B1 the groups after the stop: every BMP `\\p{Ll}` and `\\p{Nd}` (`LOWERCASE`, `isDigit`, `:1023`)', () => {
    // (1) red when a member is left out of its row's iteration; (2) prints the members missing.
    whole(LOWER, /^\p{Ll}$/u, 0, BMP);
    whole(DIGITS, /^\p{Nd}$/u, 0, BMP);
  });

  it.each([
    ['a lowercase letter, `\\p{Ll}`', LOWER],
    ['a digit, `\\p{Nd}`', DIGITS],
  ] as const)('B1 an `exact` quote is marked when the document goes on with %s', (_, group) => {
    const approx = 'The area is not less than approx.';
    const rows = group.map((c): Row => [
      hex(c),
      read(approx, `${approx} ${ch(c)}12 square metres.`),
      'exact+cut_short',
    ]);
    // (1) red when one member does not mark the quote; (2) prints each differing code point and state.
    expect(misses(rows)).toEqual([]);
  });

  it('B2 the groups: every `Cf`; every BMP `Sc` and `Sm`, the sentence’s signs among them; and its example, `48,000` in `€`, U+FEFF, `48,000` (#845: not found)', () => {
    // #845 (R-C1) re-pin: U+FEFF is invisible and leaves before the number rules, so the example's
    // `€` binds `48,000` and it is not found (the sentence went). (1) red when a member is left out
    // of an iteration, a named sign is not in its group, or the example reads found; (2) prints the
    // members missing, the signs outside and the state.
    whole(CF, /^\p{Cf}$/u);
    whole(SIGNS, /^[\p{Sc}\p{Sm}]$/u, 0, BMP);
    expect({
      outside: ['€', '$', '+', '±', '<'].filter((s) => !SIGNS.includes(cp(s))),
      example: read('48,000 a year', `The rent is €${ch(0xfeff)}48,000 a year.`),
    }).toEqual({ outside: [], example: 'not_found' });
  });

  it.each(CF.map((x) => [hex(x), x] as const))(
    'B2 %s between every BMP `Sc` or `Sm` and `5`: #845 (R-C1) re-pin, never found (U+FEFF and a minus sign included)',
    (_, x) => {
      // #845 re-pin: every `Cf` but the 13 Prepend signs is invisible and leaves before the number
      // rules; a Prepend sign is a number symbol itself. Either way the sign binds `5`.
      const rows = SIGNS.map((s): Row => [
        hex(s),
        read('5 degrees', `The reading is ${ch(s)}${ch(x)}5 degrees today.`),
        'not_found',
      ]);
      // (1) red when an invisible character lets a sign come apart from its number again; (2)
      //     prints each differing sign's code point and state.
      expect(misses(rows)).toEqual([]);
    },
  );

  it('B3 the groups after a header that ends a sentence: every BMP capital (`CAPITAL`), and the opening marks against every other BMP `Ps` `Pi` `Pf` `Pe`', () => {
    // (1) red when a member is left out of an iteration; (2) prints the members missing.
    whole(CAPITALS, /^[\p{Lu}\p{Lt}]$/u, 0, BMP);
    whole(MARKS, MARK_GROUP, 0, BMP);
  });

  it('B3 a page header: the line break kept, or `…`, reads `stitched` only when a blank line follows it, or it ends with `;`, `:` or `|`, or ends a sentence before a capital letter or an opening mark', () => {
    const A = `${F} for its full reinstatement cost. The Tenant shall`;
    const rest = 'not be responsible for repairs to the structure';
    const H = 'Lease of Office Premises — page 4';
    // #845 1b-i (B3) re-pin: the header line ends nothing, so after the blank line a lowercase word
    // is refused (main: `stitched`); a capital next still reads `stitched`.
    const Capital = 'The Landlord shall be responsible for repairs to the structure';
    const headers: Record<string, readonly [between: string, after: string, kept: string]> = {
      'between blank lines': [`\n\n${H}\n\n`, rest, 'not_found'],
      'a blank line after it only': [`\n${H}\n\n`, rest, 'not_found'],
      'between blank lines, a capital next': [`\n\n${H}\n\n`, Capital, 'stitched'],
      'a blank line after it only, a capital next': [`\n${H}\n\n`, Capital, 'stitched'],
      'ending with `:`': [`\n${H}:\n`, rest, 'stitched'],
      'ending with `;`': [`\n${H};\n`, rest, 'stitched'],
      'ending with `|`': [`\n| ${H} |\n`, rest, 'stitched'],
      'ending a sentence, a capital next': [
        `\n${H}.\n`,
        'The Landlord shall be responsible for repairs to the structure',
        'stitched',
      ],
      'ending a sentence, an opening mark next': [`\n${H}.\n`, `(${rest}`, 'stitched'],
      'between single line breaks': [`\n${H}\n`, rest, 'not_found'],
      'ending a sentence, a lowercase word next': [
        '\nLease of Office Premises. Page 4.\n',
        rest,
        'not_found',
      ],
    };
    const rows: Row[] = Object.entries(headers).flatMap(([name, [between, after, kept]]): Row[] => {
      const doc = `${A}${between}${after}.`;
      return [
        [`${name}, joined with a space`, read(`${A} ${after}`, doc), 'not_found'],
        [`${name}, the line break kept`, read(`${A}\n${after}`, doc), kept],
        [`${name}, skipped with …`, read(`${A} … ${after}`, doc), kept],
      ];
    });
    // (1) red when `|` stops ending a line that counts (`lineStart`), or one of the other endings
    //     moves; (2) prints each differing row's label and state.
    expect(misses(rows)).toEqual([]);
  });

  it.each([
    ['`.`', '.'],
    ['`!`', '!'],
    ['`?`', '?'],
  ] as const)(
    'B3 a header ending with %s: every BMP capital, and each opening mark, next reads `stitched`; every other mark, and a lowercase word, not',
    (_, stop) => {
      const A = 'The Tenant shall keep the Premises in good and substantial repair';
      const tail = 'he Landlord shall insure the building at its own cost';
      const header = `Page 3 of 9${stop}\n`;
      const both = (B: string): string => {
        const doc = `${A}\n${header}${B} and expense.`;
        return `${read(`${A}\n${B}`, doc)}/${read(`${A} … ${B}`, doc)}`;
      };
      const rows: Row[] = [
        ...CAPITALS.map((c): Row => [hex(c), both(`${ch(c)}${tail}`), 'stitched/stitched']),
        ...MARKS.map((m): Row => [
          hex(m),
          both(`${ch(m)}t${tail}`),
          OPENING.includes(m) ? 'stitched/stitched' : 'not_found/not_found',
        ]),
        ['a lowercase word', both(`t${tail}`), 'not_found/not_found'],
      ];
      // (1) red when a capital or an opening mark stops opening a sentence (`isSentenceOpening`), or
      //     another mark starts to; (2) prints each differing code point and the two states.
      expect(misses(rows)).toEqual([]);
    },
  );

  it('S1 every dash reads as `-`: every `\\p{Pd}` in every plane, `isDash`’s additions and the NFKC minus signs (#845 R-A2: the two outside the BMP too)', () => {
    const outside = codePoints(/^\p{Pd}$/u, 0x10000);
    whole(DASHES.slice(0, -DASH_ADDED.length), /^\p{Pd}$/u, 0, BMP);
    whole(outside, /^\p{Pd}$/u, 0x10000);
    const minus5 = (d: number) => read('-5 degrees', `The reading is ${ch(d)}5 degrees today.`);
    const rows: Row[] = [
      ...[...DASHES, ...NFKC_MINUS].map((d): Row => [
        hex(d),
        minus5(d),
        d === 0x2d ? 'exact' : 'reformatted',
      ]),
      // #845 (R-A2) re-pin: the two dashes outside the BMP are dashes, read as `-`
      ...outside.map((d): Row => [hex(d), minus5(d), 'reformatted']),
    ];
    // #855's last commit (M7): the whole-BMP walk against the glossary's dash set is the glossary
    // describe's "a dash" rows; the copy's own check, true by construction, is gone.
    // (1) red when a member is left out of an iteration, or a dash in any plane stops reading as
    //     `-`; (2) prints the members missing and each differing code point and
    //     state.
    expect({
      named: [0x10d6e, 0x10ead].filter((d) => !outside.includes(d)).map(hex),
      misses: misses(rows),
    }).toEqual({ named: [], misses: [] });
  });

  it('S2 every `\\p{Zs}` space in a group of thousands: `1 200` written with the same space is not found (#845: every `Zs` is a group space); written with a plain space it is not found', () => {
    const spaces = codePoints(/^\p{Zs}$/u);
    whole(spaces, /^\p{Zs}$/u);
    const doc = (s: number) => `the rent is 1${ch(s)}200${ch(s)}000 euro`;
    // #845 (R-B) re-pin: the group spaces are every `\p{Zs}`, so no same-space row reads found.
    const rows: Row[] = spaces.flatMap((s): Row[] => [
      [`${hex(s)}, the same space`, read(`the rent is 1${ch(s)}200`, doc(s)), 'not_found'],
      [`${hex(s)}, a plain space`, read('the rent is 1 200', doc(s)), 'not_found'],
    ]);
    // (1) red when a member is left out of the iteration, a `Zs` space stops grouping thousands (its
    //     row reads found), or a plain-space quote is found in a document grouped otherwise; (2)
    //     prints the members missing and each differing row.
    expect({
      named: [0x2007, 0x2002, 0x3000].filter((s) => !spaces.includes(s)).map(hex),
      misses: misses(rows),
    }).toEqual({ named: [], misses: [] });
  });

  it('S3 a sign or a dash written right before a number belongs to it: every BMP `Sc` and `Sm` and every dash `isDash` reads, before `5`; a dash after `5` does not; outside the BMP every sign and both hyphens bind it too (#845 R-A2)', () => {
    // #845 (R-A2) re-pin, Words item 11a: the page no longer says an astral hyphen leaves its number
    // found; both bind it, as every other dash does.
    expect(
      flatten(raw(HANDLERS)).includes(
        flatten(
          'A hyphen outside the Basic Multilingual Plane (U+10D6E, U+10EAD) does not belong to its number',
        ),
      ),
    ).toBe(false);
    whole(SIGNS, /^[\p{Sc}\p{Sm}]$/u, 0, BMP);
    const astral = codePoints(/^[\p{Sc}\p{Sm}\p{Pd}]$/u, 0x10000);
    whole(astral, /^[\p{Sc}\p{Sm}\p{Pd}]$/u, 0x10000);
    const before5 = (between: string) =>
      read('5 degrees', `The reading is ${between}5 degrees today.`);
    const rows: Row[] = [
      ...[...SIGNS, ...DASHES].map((s): Row => [`${hex(s)} before 5`, before5(ch(s)), 'not_found']),
      // F760-DTC2A-05: written after the number, a dash is not right before it
      ...DASHES.map((d): Row => [
        `${hex(d)} after 5`,
        read('reads 5', `The gauge reads 5${ch(d)} today.`),
        'exact',
      ]),
      // the language unit (§3): the character before a match is read by code point, so a sign outside
      // the BMP is a sign; #845 (R-A2): its two hyphens (U+10D6E, U+10EAD) are dashes and bind too
      ...astral.map((s): Row => [`${hex(s)} before 5`, before5(ch(s)), 'not_found']),
    ];
    // (1) red when a member is left out of an iteration, currency signs leave `isNumberSymbol` (every
    //     `Sc` row), a dash after the number starts to bind, or a sign outside the BMP starts to;
    //     (2) prints the members missing and each differing code point and state.
    expect({
      named: [0x1e2ff, 0x11fdd, 0x10d6e, 0x10ead].filter((s) => !astral.includes(s)).map(hex),
      misses: misses(rows),
    }).toEqual({ named: [], misses: [] });
  });

  it('S3 can still read found: a sign set apart from its number by a space (`48,000` in `€ 48,000`); #845: not across U+FEFF', () => {
    claimOn(HANDLERS, 'A sign set apart from its number by a space (`48,000` in `€ 48,000`).');
    const rent = (doc: string, quote = '48,000 a year') =>
      read(quote, `The rent is ${doc} a year.`);
    const rows: Row[] = [
      ['€ 48,000', rent('€ 48,000'), 'exact'],
      ['€ U+00A0 48,000', rent('€\u00a048,000'), 'exact'],
      ['€ U+202F 48,000', rent('€\u202f48,000'), 'exact'],
      // #845 (R-C1) re-pin: U+FEFF is invisible, no space, so `€` binds the number
      ['€ U+FEFF 48,000', rent('€\ufeff48,000'), 'not_found'],
      ['48,000 €', read('48,000', 'The rent is 48,000 € a year.'), 'exact'],
      ['€ 48.000', read('48.000', 'The rent is € 48.000 a year.'), 'exact'],
    ];
    // (1) red when a spaced sign starts to bind (the bullet would then be false); (2) prints each
    //     differing row's label and state.
    expect(misses(rows)).toEqual([]);
  });

  it('S3 the group: every `\\p{White_Space}` (`SPACE`), every plane', () => {
    // (1) red when a member is left out of the iteration; (2) prints the members missing.
    whole(WS, /^\p{White_Space}$/u);
  });

  it.each(WS.map((w) => [hex(w), w] as const))(
    'S3 every BMP sign and every dash, then %s, then `5`: the number is found',
    (_, w) => {
      const rows = [...SIGNS, ...DASHES].map((s): Row => [
        hex(s),
        read('5', `The deposit is ${ch(s)}${ch(w)}5 of the rent.`),
        // #845 re-pin: U+FEFF is no longer in the group (it is invisible, so it binds; its own
        // rows are B2's)
        'exact',
      ]);
      // (1) red when a sign set apart by this space starts to bind; (2) prints each differing sign's
      //     code point and state.
      expect(misses(rows)).toEqual([]);
    },
  );

  it('M1 past the closing marks: an exact quote is marked past each closing mark (`\\p{Pe}`, `\\p{Pf}`, `"`, `\'`; #845), and past no other BMP `Ps` `Pi` mark', () => {
    // #845 (R-B) re-pin: the closing marks are Unicode's closing brackets and quotation marks with
    // `"` and `'`, as the glossary's "a closing mark" says; the page names the set, and the released
    // CHANGELOG keeps the list it shipped with.
    const RELEASED = ['"', '”', '»', "'", '’', ')', ']', '}'].map(cp);
    const CLOSER = /^[\p{Pe}\p{Pf}"']$/u;
    const printed = (p: string) => {
      const t = flatten(raw(p));
      const from = t.indexOf('past the closing marks ') + 'past the closing marks '.length;
      const list = t.slice(from).split(/, (?:plain spaces and tabs|U\+0020 and U\+0009)/)[0]!;
      return [...list.matchAll(/`([^`]+)`/g)].map((m) => cp(m[1]!)).sort((a, b) => a - b);
    };
    // #845 1b-ii-b re-pin: the paragraph's new words for the same read
    claimOn(
      HANDLERS,
      'From there the check reads the document, past closing marks and invisible characters.',
    );
    claimOn(
      HANDLERS,
      'the quote is marked when, past that stop, closing marks and whitespace other than a line break, a lowercase letter or a digit follows (`approx. 412`)',
    );
    whole(MARKS, MARK_GROUP, 0, BMP);
    const rent = 'The Tenant shall pay the Rent';
    const rows = MARKS.map((c): Row => [
      hex(c),
      read(`${rent}.`, `${rent}.${ch(c)} and more on demand.`),
      CLOSER.test(ch(c)) ? 'exact+cut_short' : 'exact',
    ]);
    // (1) red when a member is left out of the iteration, a closing mark stops being walked past (its
    //     row reads unmarked), an opening one starts to be, or the released list changes; (2) prints
    //     the list and each differing row.
    expect({
      changelog: printed(CL).map(hex),
      misses: misses(rows),
    }).toEqual({ changelog: [...RELEASED].sort((a, b) => a - b).map(hex), misses: [] });
  });

  it("M2 each `.`, `!` or `?` inside the quote, but the dots of `...`, that whitespace or the quote's end follows past any invisible characters marks it, unless it ends an abbreviation on the check's list, an initial or an initialism (#845 R-C2, R-A3)", () => {
    whole(WS, /^\p{White_Space}$/u);
    const doc = 'THE TENANT SHALL PAY THE RENT AND THE RATES ON THE USUAL QUARTER DAYS.';
    const lease = (a: string) =>
      `THE RENT IS SET OUT IN ${a.replace(/\./g, '').toUpperCase()} FOUR OF THE LEASE AND NOWHERE ELSE.`;
    const abbreviation = (v: string, a: string) =>
      read(`The rent is set out in ${v} four of the lease`, lease(a));
    const rows: Row[] = [
      ...['.', '!', '?'].flatMap((stop): Row[] => [
        ...WS.map((w): Row => [
          `${stop} then ${hex(w)}`,
          read(`The Tenant shall pay the Rent${stop}${ch(w)}and the rates`, doc),
          'reformatted+cut_short',
        ]),
        // #845 (R-C2): the read past the stop steps over invisible characters
        [
          `${stop} then U+200B then a space`,
          read(`The Tenant shall pay the Rent${stop}\u{200b} and the rates`, doc),
          'reformatted+cut_short',
        ],
        [
          `${stop} at the quote's end`,
          read(`The Tenant shall pay the Rent${stop}`, doc),
          'reformatted+cut_short',
        ],
        [
          `${stop} then \`"\``,
          read(`The Tenant shall pay the Rent${stop}" and the rates`, doc),
          'reformatted',
        ],
        [
          `${stop} then \`)\``,
          read(`The Tenant shall pay the Rent${stop}) and the rates`, doc),
          'reformatted',
        ],
      ]),
      ...NOT_SENTENCE_ENDS.flatMap((a): Row[] =>
        [a, a.toUpperCase(), a.toLowerCase()].map((v): Row => [
          v,
          abbreviation(v, a),
          'reformatted',
        ]),
      ),
      // an initial: a single capital letter's (a lowercase `j.` is none, and ends a sentence)
      ['J.', abbreviation('J.', 'J.'), 'reformatted'],
      // off the list: it ends a sentence
      ['approx.', abbreviation('approx.', 'approx.'), 'reformatted+cut_short'],
      // #845 (R-A3) re-pin: an initialism ends none
      ...['U.S.', 'U.K.', 'J.R.R.'].map((a): Row => [a, abbreviation(a, a), 'reformatted']),
    ];
    // (1) red when a member is left out of the iteration, a `.` followed by a quotation mark starts to
    //     end a sentence, or an entry or an initial ends one; (2) prints the members missing and each
    //     differing row.
    expect(misses(rows)).toEqual([]);
  });

  /** `KEPT_SYMBOLS` (`locate-quote.ts:106-129`), copied: the code does not export it. */
  const KEPT = [
    '%',
    '‰',
    '°',
    '\u2031',
    '\u2032',
    '\u2033',
    '\u2034',
    '\u2035',
    '\u2036',
    '\u2037',
    '\u2610',
    '\u2611',
    '\u2612',
    '\u2713',
    '\u2714',
    '\u2715',
    '\u2716',
    '\u2717',
    '\u2718',
    '\u2705',
    '\u274c',
    '\u274e',
  ].map(cp);
  /** The kept signs, every plane: `\p{Sc}`, `\p{Sm}` and `KEPT_SYMBOLS`. */
  const KEPT_SIGNS = [...new Set([...codePoints(/^[\p{Sc}\p{Sm}]$/u), ...KEPT])];

  it('M4 the kept signs: every `\\p{Sc}` and `\\p{Sm}`, every plane, and `KEPT_SYMBOLS`, each as the code reads it over every BMP `\\p{P}` and `\\p{S}` but `\\p{Sc}` and `\\p{Sm}`', () => {
    claimOn(
      HANDLERS,
      'An item that opens with a mark that is not a list mark, at any line start; quoting a kept sign other than a minus sign (`=` …) with the item reads `stitched` after a line ending with `;` or `:`, or a blank line that follows a line ending a sentence or a clause.',
    );
    whole(
      KEPT_SIGNS.filter((c) => !KEPT.includes(c)),
      /^[\p{Sc}\p{Sm}]$/u,
    );
    // The copied list against the code (#855's last commit, M7): over every BMP `\p{P}` and `\p{S}`
    // but `\p{Sc}` and `\p{Sm}`, a character binds to its number exactly when it is kept, a dash (the
    // glossary's set), `,` or `.`.
    const binds = (c: number) =>
      read('5 degrees', `The reading is ${ch(c)}5 degrees today.`) === 'not_found'
        ? 'binds'
        : 'set aside';
    const dash = glossaryCodes('a dash');
    const rows: Row[] = codePoints(/^[\p{P}\p{S}]$/u, 0, BMP)
      .filter((c) => !/^[\p{Sc}\p{Sm}]$/u.test(ch(c)))
      .map((c): Row => [
        hex(c),
        binds(c),
        KEPT.includes(c) || dash.includes(c) || c === 0x2c || c === 0x2e ? 'binds' : 'set aside',
      ]);
    // (1) red when a member is left out of the iteration, the copied list differs from the code's,
    //     or a named sign is not kept; (2) prints the members missing and each differing row.
    expect({
      named: ['+', '>', '='].filter((s) => !KEPT_SIGNS.includes(cp(s))),
      misses: misses(rows),
    }).toEqual({ named: [], misses: [] });
  });

  it.each([
    [
      ':⏎',
      'The Tenant covenants with the Landlord as follows:\n',
      'The Tenant covenants with the Landlord',
    ],
    [
      ';⏎',
      'The Tenant shall pay the Rent on the usual quarter days;\n',
      'The Tenant shall pay the Rent on the usual',
    ],
    // #845 1b-i (B3) re-pin: a blank line counts so only under a line that ends a sentence or a
    // clause (main: any blank line); under one that ends nothing it is refused (extra2 rows 25–28).
    [
      'a blank line under a clause',
      'The Tenant shall pay the Rent on the usual quarter days;\n\n',
      'The Tenant shall pay the Rent on the usual',
    ],
    [
      '|⏎',
      '| The Landlord shall insure the building at its own cost |\n',
      'The Landlord shall insure the building',
    ],
  ] as const)(
    'M4 every kept sign quoted with the item after %s reads `stitched`, the superscript and subscript minus excepted (#845: U+2212 is a list mark)',
    (_, before, first) => {
      const item = 'keep the Premises in good and substantial repair';
      // #845 (R-B) re-pin: the list marks take every dash `isDash` reads, U+2212 among them, so the
      // minus sign's item now reads `stitched` like the others; U+207B and U+208B are no list marks.
      const rows = KEPT_SIGNS.map((m): Row => [
        hex(m),
        read(`${first} … ${ch(m)} ${item}`, `${before}${ch(m)} ${item} at all times.`),
        NFKC_MINUS.includes(m) ? 'not_found' : 'stitched',
      ]);
      // (1) red when a kept sign quoted with its item stops reading `stitched` here, or a minus sign
      //     starts to; (2) prints each differing sign's code point and state.
      expect(misses(rows)).toEqual([]);
    },
  );

  it.each([
    ['with a lowercase form', true],
    ['with no lowercase form', false],
  ] as const)(
    'M5 an initial, one capital letter: every BMP `\\p{Lu}`/`\\p{Lt}` %s (#845 R-A3: every one is an initial)',
    (_, lowers) => {
      const A = 'The Landlord shall insure the building at its own cost';
      const B = 'The Tenant shall keep the Premises in good and substantial repair';
      const after = (abbr: string) => read(`${A} … ${B}`, `${A} under ${abbr} ${B} at all times.`);
      const LOWERS = /^\p{Changes_When_Lowercased}$/u;
      const rows = CAPITALS.filter((c) => LOWERS.test(ch(c)) === lowers).map((c): Row => [
        hex(c),
        after(`${ch(c)}.`),
        // an initial ends no sentence, so the skip after it is refused; #845 (R-A3) re-pin: a capital
        // with no lowercase form is one too (main read only a letter that changes when lowercased)
        'not_found',
      ]);
      void lowers;
      // (1) red when a capital, with or without a lowercase form, ends a sentence; (2) prints each differing code point and state.
      expect(misses(rows)).toEqual([]);
    },
  );

  it('M5 the group: every BMP capital; a decomposed `É` and U+1D400 are initials too (#845 R-A3)', () => {
    whole(CAPITALS, /^[\p{Lu}\p{Lt}]$/u, 0, BMP);
    const A = 'The Landlord shall insure the building at its own cost';
    const B = 'The Tenant shall keep the Premises in good and substantial repair';
    const after = (abbr: string) => read(`${A} … ${B}`, `${A} under ${abbr} ${B} at all times.`);
    // (1) red when a member is left out of an iteration, or a capital with a visible mark, or one
    //     outside the BMP, ends a sentence; (2) prints the two states.
    expect({ decomposed: after('E\u0301.'), outside: after(`${ch(0x1d400)}.`) }).toEqual({
      decomposed: 'not_found',
      outside: 'not_found',
    });
  });

  it('§3 a dash and an invisible format character: the groups are every BMP dash `isDash` reads, the NFKC minus signs, and every `Cf`', () => {
    // (1) red when a member is left out of an iteration; (2) prints the members missing. #855's last
    // commit (M7): the additions are checked by the glossary's "a dash" rows, not against their copy.
    whole(DASHES.slice(0, -DASH_ADDED.length), /^\p{Pd}$/u, 0, BMP);
    whole(CF, /^\p{Cf}$/u);
  });

  it.each([...DASHES, ...NFKC_MINUS].map((d) => [hex(d), d] as const))(
    '§3 the dash %s, then every `Cf`, then `5`: #845 (R-C1) re-pin, part of the number is not found',
    (_, d) => {
      // #845 re-pin: the `Cf` leaves before the number rules (a Prepend sign stays, as a number
      // symbol), so the dash, or the sign, binds `5`.
      const rows = CF.map((x): Row => [
        hex(x),
        read('5 degrees', `The reading is ${ch(d)}${ch(x)}5 degrees today.`),
        'not_found',
      ]);
      // (1) red when an invisible character splits a dash from its number again; (2) prints each
      //     differing `Cf`'s code point and state.
      expect(misses(rows)).toEqual([]);
    },
  );

  it('§3 an invisible format character inside a number: `12`+X+`500` for every `Cf`, U+FEFF before `5000`, a leading decimal point or comma before every `Cf` (#845: none found)', () => {
    whole(CF, /^\p{Cf}$/u);
    const inside = (x: number, digits: string) =>
      read('the fee is 12', `the fee is 12${ch(x)}${digits} euro`);
    // #845 (R-C1) re-pin: every `Cf` but the 13 Prepend signs leaves before the number rules, and a
    // Prepend sign is a number symbol, so no part of the number reads found.
    const rows: Row[] = [
      ...CF.map((x): Row => [`12 ${hex(x)} 500`, inside(x, '500'), 'not_found']),
      ['12 U+FEFF 5000', inside(0xfeff, '5000'), 'not_found'],
      // M9: every `Cf` after a leading `.` or `,`
      ...['.', ','].flatMap((p) =>
        CF.map((x): Row => [
          `${p}${hex(x)}75%`,
          read('75% of the cost', `The Tenant pays ${p}${ch(x)}75% of the cost.`),
          'not_found',
        ]),
      ),
      [
        '.75%, nothing between',
        read('75% of the cost', 'The Tenant pays .75% of the cost.'),
        'not_found',
      ],
    ];
    // (1) red when a member is left out of the iteration, or an invisible character splits a
    //     number again; (2) prints the members missing and each differing row's code point and state.
    expect(misses(rows)).toEqual([]);
  });

  it('§4 the opening marks pass, and every other BMP `Ps` `Pi` `Pf` `Pe` and quotation mark fails, after `. ` and after a clause number', () => {
    whole(MARKS, MARK_GROUP, 0, BMP);
    const lc = 'the Tenant shall pay the insurance rent';
    const rows: Row[] = MARKS.flatMap((m): Row[] => {
      const want = OPENING.includes(m) ? 'stitched' : 'not_found';
      return [
        [
          `${hex(m)} after ". "`,
          read(`${F} … ${ch(m)}${lc}`, `${F} for its cost. ${ch(m)}${lc} at the end of each year.`),
          want,
        ],
        [
          `${hex(m)} after .⏎6.2`,
          read(
            `${F} … 6.2 ${ch(m)}${lc}`,
            `${F} for its cost.\n6.2 ${ch(m)}${lc} at the end of each year.`,
          ),
          want,
        ],
      ];
    });
    // (1) red when a member is left out of the iteration, `«` leaves `START_OPENING` (its two rows),
    //     or another mark starts to open; (2) prints the members missing and each differing row.
    expect(misses(rows)).toEqual([]);
  });

  /** The list marks, `isListMark`, copied, and a run of `#` — #845 (R-B) re-pin: every BMP dash
   *  `isDash` reads, `*` `+` `>` `|`, the characters Unicode names a bullet, `○` `●` `■` `▪` `·` and
   *  U+F0B7 (it was a hand list of ten). */
  const LIST = [
    ...[...codePoints(/^\p{Pd}$/u, 0, BMP), 0x2212, 0x2796, 0x02d7].map((c) => ch(c)),
    '*',
    '+',
    '>',
    '|',
    ...[0x2022, 0x2023, 0x2043, 0x204c, 0x204d, 0x2219, 0x25d8, 0x25e6, 0x29be, 0x29bf].map((c) =>
      ch(c),
    ),
    ...[0x2619, 0x2765, 0x2767, 0x25cb, 0x25cf, 0x25a0, 0x25aa, 0x00b7, 0xf0b7].map((c) => ch(c)),
  ];
  const LIST_LINES = {
    '.⏎': '.\n',
    ':⏎': ':\n',
    ';⏎': ';\n',
    'a blank line': '.\n\n',
  } as const;
  /** The closing marks walked back over, `isClosingMark`, copied: with the opening marks, `;` and
   *  `:`, these open an item for their own reasons — #845 (R-B) re-pin: every BMP `\p{Pe}` and
   *  `\p{Pf}`, `"` and `'` (it was a hand list of seven). */
  const CLOSING_BACK = codePoints(/^[\p{Pe}\p{Pf}"']$/u, 0, BMP).map((c) => ch(c));
  const LIST_GROUP = /^[\p{P}\p{S}]$/u;
  const NOT_LIST = codePoints(LIST_GROUP, 0, BMP).filter(
    (c) => ![...LIST, '#', ';', ':', ...CLOSING_BACK].map(cp).includes(c) && !OPENING.includes(c),
  );

  it("§4 the list marks and a run of `#` pass at every line start; a mark that is not a list mark is refused, `=` quoted excepted (#845: the list marks are Unicode's dashes and bullets)", () => {
    const lc = 'the Tenant shall pay the insurance rent';
    const Cap = 'The Tenant shall pay the insurance rent';
    const doc = (before: string, m: string, it: string) =>
      `${F} for its cost${before}${m} ${it} at the end of each year.`;
    // #845 (R-B) re-pin: `+` `○` `●` `■` `>` and U+F0B7 are list marks now; the sentence names no
    // other mark, so two that are none stand for the rest (`=` a kept sign, `★` one set aside)
    const refused = ['=', '★'];
    const rows: Row[] = [];
    for (const [name, before] of Object.entries(LIST_LINES)) {
      for (const m of [...LIST, '#', '##', '###'])
        rows.push([
          `${hex(cp(m))}${m.length > 1 ? ` ×${m.length}` : ''} after ${name}`,
          read(`${F} … ${lc}`, doc(before, m, lc)),
          'stitched',
        ]);
      for (const m of refused) {
        const label = hex(cp(m));
        rows.push([
          `${label} after ${name}, lowercase`,
          read(`${F} … ${lc}`, doc(before, m, lc)),
          'not_found',
        ]);
        rows.push([
          `${label} after ${name}, capital`,
          read(`${F} … ${Cap}`, doc(before, m, Cap)),
          'not_found',
        ]);
        const quotedPasses = m === '=' && name !== '.⏎';
        rows.push([
          `${label} quoted after ${name}`,
          read(`${F} … ${m} ${lc}`, doc(before, m, lc)),
          quotedPasses ? 'stitched' : 'not_found',
        ]);
      }
    }
    // (1) red when `•` leaves `LIST_MARKS` (its four rows); (2) prints each differing mark and state.
    expect(misses(rows)).toEqual([]);
  });

  it('§4 the list marks against the rest: the group is every BMP `\\p{P}` and `\\p{S}`, less the list marks, `#`, the opening and closing marks, `;` and `:`; each member is in exactly one kind', () => {
    // (1) red when a member is left out of the iteration, or falls in no kind's rows or in two
    //     (#855's last commit, M8); (2) prints the members missing and those code points.
    expect(
      NOT_LIST.filter((c) => NOT_LIST_KINDS.filter(([, re]) => re.test(ch(c))).length !== 1).map(
        hex,
      ),
    ).toEqual([]);
    // #845 (R-B) re-pin: U+F0B7 is a list mark outside the group (a private-use character), so the
    // group is checked over its own members
    whole(
      [...NOT_LIST, ...[...LIST, '#', ';', ':', ...CLOSING_BACK].map(cp), ...OPENING].filter(
        (c, i, all) => all.indexOf(c) === i && LIST_GROUP.test(ch(c)),
      ),
      LIST_GROUP,
      0,
      BMP,
    );
  });

  /** The rest, split by kind so that no row nears the timeout. */
  const NOT_LIST_KINDS = [
    ['`\\p{P}`', /^\p{P}$/u],
    ['`\\p{So}`', /^\p{So}$/u],
    ['`\\p{Sc}` `\\p{Sm}` `\\p{Sk}`', /^[\p{Sc}\p{Sm}\p{Sk}]$/u],
  ] as const;

  it.each(
    Object.entries(LIST_LINES).flatMap(([line, before]) =>
      NOT_LIST_KINDS.map(([kind, re]) => [kind, line, before, re] as const),
    ),
  )(
    '§4 every other BMP %s mark opening an item after %s: a skip onto its lowercase item is refused',
    (_, __, before, re) => {
      const lc = 'the Tenant shall pay the insurance rent';
      const rows = NOT_LIST.filter((m) => re.test(ch(m))).map((m): Row => [
        hex(m),
        read(`${F} … ${lc}`, `${F} for its cost${before}${ch(m)} ${lc} at the end of each year.`),
        'not_found',
      ]);
      // (1) red when a mark outside `LIST_MARKS` starts to open a list item; (2) prints each
      //     differing mark's code point and state.
      expect(misses(rows)).toEqual([]);
    },
  );

  it('§4 the abbreviations: the printed list is `NOT_SENTENCE_ENDS`; each entry, an initial and an initialism ends no sentence; each example does', () => {
    const text = raw(HANDLERS);
    const sentence = text.slice(
      text.indexOf("- An abbreviation that is not on the check's list ("),
    );
    const printed = sentence.slice(0, sentence.indexOf(', an initial, and an initialism'));
    const listed = [...printed.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
    const Cap = 'Capital rules apply to the Tenant at all times';
    const skip = (ab: string, second = Cap) =>
      read(
        `${F} … ${second}`,
        `${F} for its full reinstatement cost ${ab} ${second} at the end of each year.`,
      );
    const rows: Row[] = [
      ...NOT_SENTENCE_ENDS.flatMap((a): Row[] => [
        [a, skip(a), 'not_found'],
        [a.toUpperCase(), skip(a.toUpperCase()), 'not_found'],
        [a.toLowerCase(), skip(a.toLowerCase()), 'not_found'],
      ]),
      ...['J.', 'A.', 'É.'].map((a): Row => [a, skip(a), 'not_found']),
      // The sentence's two examples (`a.m. Monday`, `excl. VAT`), each read as a sentence end.
      ['a.m. Monday', skip('a.m.', 'Monday rules apply to the Tenant at all times'), 'stitched'],
      ['excl. VAT', skip('excl.', 'VAT rules apply to the Tenant at all times'), 'stitched'],
      // #845 (R-A3) re-pin: an initialism ends no sentence, so the skip after it is refused
      ['U.S. The', skip('U.S.', 'The rules apply to the Tenant at all times'), 'not_found'],
      ['U.K. The', skip('U.K.', 'The rules apply to the Tenant at all times'), 'not_found'],
      ['U.S.A. The', skip('U.S.A.', 'The rules apply to the Tenant at all times'), 'not_found'],
      ['U.S. (the', skip('U.S.', '(the rules apply to the Tenant at all times'), 'not_found'],
    ];
    // (1) red when an entry leaves `NOT_SENTENCE_ENDS` (`Ltd.`: the two lists differ) or the printed
    // list loses one, or an entry or an initial ends a sentence, or an example stops ending one;
    // (2) prints the two lists' differences and each differing row.
    expect({
      onlyPrinted: listed.filter((a) => !(NOT_SENTENCE_ENDS as readonly string[]).includes(a)),
      onlyInCode: NOT_SENTENCE_ENDS.filter((a) => !listed.includes(a)),
      misses: misses(rows),
    }).toEqual({ onlyPrinted: [], onlyInCode: [], misses: [] });
  });

  it('§5 M5: a clause joined to a later sentence reads `stitched`, to an earlier one `stitched_out_of_order`', () => {
    const d = `${F} for its full reinstatement cost. The Tenant shall pay the insurance rent on demand and without deduction.`;
    const rows: Row[] = [
      [
        'a clause, then a later sentence',
        read(`${F} … The Tenant shall pay the insurance rent`, d),
        'stitched',
      ],
      [
        'a clause, then an earlier sentence',
        read(`The Tenant shall pay the insurance rent on demand … ${F}`, d),
        'stitched_out_of_order',
      ],
    ];
    // (1) red when reversed pieces read `stitched`; (2) prints each differing row's label and state.
    expect(misses(rows)).toEqual([]);
  });

  it('§5 U+FEFF inside a word (#845: invisible): a quote that starts or ends at it is not found; the whole word reads `reformatted`', () => {
    // #845 (R-C1) re-pin: U+FEFF is invisible like U+200B, so it makes no word edge (the two lines
    // that said otherwise went from the docs).
    const doc = `The Tenant shall not permit any un${ch(0xfeff)}lawful use of the Premises.`;
    const rows: Row[] = [
      ['starts at it', read('lawful use of the Premises', doc), 'not_found'],
      ['ends at it', read('The Tenant shall not permit any un', doc), 'not_found'],
      ['the whole word', read('unlawful use of the Premises', doc), 'reformatted'],
    ];
    // (1) red when U+FEFF makes a word edge again; (2) prints each differing row's label and state.
    expect(misses(rows)).toEqual([]);
  });

  it('§5 the exact row and T2 `u034f-inside-a-word`: every `Cf` (the 13 Prepend signs excepted; #845), the Hangul fillers and every combining mark (`\\p{M}`, every plane, U+034F and the variation selectors among them) make no word edge', () => {
    const marks = codePoints(/^\p{M}$/u);
    whole(CF, /^\p{Cf}$/u);
    whole(marks, /^\p{M}$/u);
    const inside = (c: number) =>
      read(
        'lawful use of the Premises',
        `The Tenant shall not permit any un${ch(c)}lawful use of the Premises.`,
      );
    const rows: Row[] = [
      // #845 (R-C1) re-pin: U+FEFF is invisible like every other `Cf` but the 13 Prepend signs,
      // which are visible number signs, so they make an edge and the cut quote reads `exact`
      ...CF.map((c): Row => [hex(c), inside(c), PREPEND.includes(c) ? 'exact' : 'not_found']),
      // The Hangul fillers are letters (`\p{Lo}`) that show nothing.
      ...[0x115f, 0x1160, 0x3164, 0xffa0].map((c): Row => [hex(c), inside(c), 'not_found']),
      // the language unit re-pin (§3): the read before a match steps past every mark, by code point
      ...marks.map((c): Row => [hex(c), inside(c), 'not_found']),
    ];
    // (1) red when a member is left out of an iteration, a combining mark makes a word edge again (the
    //     read before a match not stepping past it, or reading code units: the astral rows), or a named
    //     one leaves its group; (2) prints the members missing and each differing code point and state.
    expect({
      named: [0x034f, 0xfe0f, 0xe0100].filter((c) => !marks.includes(c)).map(hex),
      misses: misses(rows),
    }).toEqual({ named: [], misses: [] });
  });
  // ─── #855's last commit (the owner's option A, 2026-10-23): the glossary, four sentences in its
  //     words, and the stop rule (in the PR body). Each glossary row is checked against the code's
  //     BEHAVIOUR over the BMP, by the test named beside it, never against a copy of the code's set.
  //     A big walk is split into blocks of 4,096 code points. ─────────────────────────────────────

  describe("#855's last commit: the glossary", () => {
    const WORDS = [
      'a plain space',
      'a tab',
      'whitespace',
      // #845 1b-i (M8r): a new row, the blank a list mark needs after it
      'a blank',
      'a line break',
      // #845 (R-C1, R-D3): two new rows
      'an invisible character',
      'a spacing accent',
      'a closing mark',
      'an opening mark',
      'a list mark',
      'a dash',
      // #845 1b-ii-a wording 1: two new rows, the sets R-F and S1/F1 read
      'a contraction apostrophe',
      'a word hyphen',
      'a capital letter',
      'a lowercase letter',
      'a digit',
      'an initial',
    ];
    /** The BMP in blocks, each `[label, from, to]`. */
    const BLOCKS = Array.from({ length: 16 }, (_, i) => {
      const from = i * 0x1000;
      return [`${hex(from)}–${hex(from + 0xfff)}`, from, from + 0xfff] as const;
    });
    /** Every code point from `from` to `to` (surrogates skipped). */
    const range = (from: number, to: number) => codePoints(/^[^]$/u, from, to);
    /** What `got` holds and `want` does not, and the reverse, within `from`–`to`, as `U+XXXX`. */
    const differ = (got: readonly number[], want: readonly number[], from = 0, to = 0x10ffff) => {
      const has = new Set(got);
      const wanted = new Set(want.filter((c) => c >= from && c <= to));
      return {
        extra: got.filter((c) => !wanted.has(c)).map(hex),
        missing: [...wanted].filter((c) => !has.has(c)).map(hex),
      };
    };
    const NONE = { extra: [], missing: [] };
    const state = (quote: string, source: string) => locateQuote(quote, source).state;
    const approx = 'The area is not less than approx.';
    /** A label quoted with its item after a line that ends a sentence. */
    const label = (lb: string, item: string) =>
      state(
        `The Landlord shall insure the building … ${lb} ${item}`,
        `The Landlord shall insure the building at its own cost and expense.\n${lb} ${item} at all times.`,
      );
    const keep = 'keep the Premises in good and substantial repair';
    const Keep = 'Keep the Premises in good and substantial repair';
    /** A header ending with `end`, then a line opening with `m`: both quote forms, kept and with `…`. */
    const header = (end: string, m: string) => {
      const A = `${F} for its full reinstatement cost. The Tenant shall`;
      const rest = 'not be responsible for repairs to the structure';
      const doc = `${A}\nLease of Office Premises — page 4${end}\n${m} ${rest}.`;
      return `${state(`${A}\n${rest}`, doc)}/${state(`${A} … ${rest}`, doc)}`;
    };
    /** `;` and `:` start a clause wherever they stand (the B3 sentence's last clause, and `:368`). */
    const CLAUSE = [0x3a, 0x3b];
    const PS = codePoints(/^[\p{P}\p{S}]$/u, 0, BMP);
    /** `PS` split by kind, so that no row nears the timeout. */
    const PS_KINDS = [
      ['`\\p{P}`', /^\p{P}$/u],
      ['`\\p{So}`', /^\p{So}$/u],
      ['`\\p{Sc}` `\\p{Sm}` `\\p{Sk}`', /^[\p{Sc}\p{Sm}\p{Sk}]$/u],
    ] as const;

    it('the paragraph, the words, and the note under the table (#845: the line-break note went)', () => {
      claimOn(
        HANDLERS,
        'The words below name exact sets, here and in the `cut_short` paragraph above, so they can be applied as written. Each is the set the check uses, as the running Node.js reads Unicode (Node 24: Unicode 17.0); anything outside it is not one.',
      );
      claimOn(HANDLERS, 'U+2053 SWUNG DASH is not a dash here.');
      // (1) red when the table loses or renames a word, or the initial row's rule (run below) changes
      //     its words; (2) prints the words and a boolean.
      expect({
        words: [...GLOSSARY.keys()],
        initialRule: (GLOSSARY.get('an initial') ?? '').includes(
          'one capital letter, with any accents on it (`Q́`), with neither a letter nor `.` right before it, followed by `.`',
        ),
      }).toEqual({ words: WORDS, initialRule: true });
    });

    it.each(BLOCKS)(
      'whitespace: the characters a `.` ends a sentence before (`segmentsOf`), %s',
      (_, from, to) => {
        const got = range(from, to).filter(
          (c) => segmentsOf(`Alpha beta.${ch(c)}gamma`)[0]?.endsSentence === true,
        );
        // (1) red when the page's whitespace row and the code's sentence end differ here; (2) prints
        //     the code points each has and the other lacks.
        expect(differ(got, glossaryCodes('whitespace'), from, to)).toEqual(NONE);
      },
    );

    it.each(BLOCKS)(
      'a dash: the characters `-5 degrees` reads found against, %s',
      (_, from, to) => {
        const got = range(from, to).filter((c) =>
          ['exact', 'reformatted'].includes(state('-5 degrees', `${ch(c)}5 degrees`)),
        );
        // (1) red when the page's dash row and the characters read as `-` differ here (U+2053 is not
        //     one); (2) prints the code points each has and the other lacks.
        expect(differ(got, glossaryCodes('a dash'), from, to)).toEqual(NONE);
      },
    );

    it.each(BLOCKS)(
      'a closing mark, whitespace other than a line break, an invisible character, a lowercase letter, a digit: what an `exact` `approx.` is marked before, %s',
      (_, from, to) => {
        const got = range(from, to).filter(
          (c) => read(approx, `${approx}${ch(c)}412 square metres.`) === 'exact+cut_short',
        );
        // #845 (R-B) re-pin: the walk takes every whitespace other than a line break, not only a
        // plain space and a tab, as the `cut_short` paragraph now says
        const lineBreaks = glossaryCodes('a line break');
        const want = [
          ...glossaryCodes('a closing mark'),
          ...glossaryCodes('whitespace').filter((w) => !lineBreaks.includes(w)),
          // #845 (R-C2) re-pin: the walk steps over invisible characters, so the `4` after one marks
          ...glossaryCodes('an invisible character'),
          // a combining mark with the Lowercase property (U+0345, the only one) attaches to the
          // stop, so no exact quote ends before it (UAX #29 GB9)
          ...glossaryProps('a lowercase letter').filter((c) => !/^\p{M}$/u.test(ch(c))),
          ...glossaryProps('a digit', ';'),
        ];
        // (1) red when the five rows together and what marks the quote differ here; (2) prints the
        //     code points each has and the other lacks.
        expect(differ(got, want, from, to)).toEqual(NONE);
      },
    );

    it.each(BLOCKS)(
      'a capital letter: the BMP letters `X) keep…` reads `stitched` with, after a line that ends a sentence, %s',
      (_, from, to) => {
        const got = codePoints(/^\p{L}$/u, from, to).filter(
          (c) => label(`${ch(c)})`, keep) === 'stitched',
        );
        // (1) red when the page's capital row and the letters that open a sentence differ here; (2)
        //     prints the code points each has and the other lacks.
        expect(differ(got, glossaryProps('a capital letter'), from, to)).toEqual(NONE);
      },
    );

    it('a digit: the BMP numbers `N) Keep…` reads `stitched` with, after a line that ends a sentence', () => {
      const got = codePoints(/^\p{N}$/u, 0, BMP).filter(
        (c) => label(`${ch(c)})`, Keep) === 'stitched',
      );
      // (1) red when the page's digit row (before its `;`) and the digits a clause number opens with
      //     differ; (2) prints the code points each has and the other lacks.
      expect(differ(got, glossaryProps('a digit', ';'))).toEqual(NONE);
    });

    it.each(PS_KINDS)(
      'a list mark and an opening mark: what opens the line after a header that ends a sentence (with `;` and `:`), among the BMP %s marks',
      (_, re) => {
        const got = PS.filter((c) => re.test(ch(c)) && header('.', ch(c)) === 'stitched/stitched');
        const want = [
          ...glossaryCodes('a list mark'),
          ...glossaryCodes('an opening mark'),
          ...CLAUSE,
        ].filter((c) => re.test(ch(c)));
        // (1) red when the page's list-mark and opening-mark rows and what opens that line differ; (2)
        //     prints the code points each has and the other lacks.
        expect(differ(got, want)).toEqual(NONE);
      },
    );

    it('a list mark: a run of U+0023 opens the line after a header that ends a sentence', () => {
      // (1) red when a run of `#` stops opening it; (2) prints the two states.
      expect(header('.', '##')).toBe('stitched/stitched');
    });

    it('an opening mark: what opens a sentence in the middle of a line after `. ` (with `;` and `:`)', () => {
      const lc = 'the Tenant shall pay the insurance rent';
      const got = PS.filter(
        (c) =>
          state(
            `${F} … ${ch(c)}${lc}`,
            `${F} for its cost. ${ch(c)}${lc} at the end of each year.`,
          ) === 'stitched',
      );
      // (1) red when the page's opening-mark row and what opens a sentence there differ; (2) prints
      //     the code points each has and the other lacks.
      expect(differ(got, [...glossaryCodes('an opening mark'), ...CLAUSE])).toEqual(NONE);
    });

    it('a line break: the whitespace after which a stop inside a reformatted quote is not marked, where the document has it', () => {
      const quote = 'The Tenant shall pay the Rent. and the rates';
      const doc = (c: number) =>
        `THE TENANT SHALL PAY THE RENT${ch(c)}AND THE RATES ON THE USUAL QUARTER DAYS.`;
      const pool = [...glossaryCodes('whitespace'), 0x85];
      const got = pool.filter((c) => read(quote, doc(c)) === 'reformatted');
      // #845 (R-B) re-pin: U+000B, U+000C and U+0085 are line breaks now (the note that said
      // otherwise went). (1) red when the page's line-break row and what ends a line here differ,
      // or one of the three stops ending one; (2) prints the code points each has and the other lacks.
      expect({
        lineBreak: differ(got, glossaryCodes('a line break')),
        uax14: [0x0b, 0x0c, 0x85].filter((c) => !got.includes(c)).map(hex),
      }).toEqual({ lineBreak: NONE, uax14: [] });
    });

    it.each(BLOCKS)(
      'an initial: the BMP letters `segmentsOf` ends no sentence after, as `Alpha X. Gamma`, %s',
      (_, from, to) => {
        const initial = (x: string) =>
          segmentsOf(`Alpha ${x}. Gamma`).every((p) => !p.endsSentence);
        const got = codePoints(/^\p{L}$/u, from, to).filter((c) => initial(ch(c)));
        // #845 (R-A3) re-pin: the row's rule, one capital letter, as the capital row reads it; #845
        // 1b-i (item 14) re-pin: plus the letters a `.` never ends a sentence after since the word
        // holds no letter — a letter that is a spacing accent (U+037A, the 14 Arabic isolated forms),
        // and one that is invisible (the Hangul fillers), read past as rule 3 reads every walk.
        const accentOrInvisible = codePoints(/^\p{L}$/u, from, to).filter(
          (c) =>
            /^ \p{M}+$/u.test(ch(c).normalize('NFKC')) ||
            /^[\p{Cf}\p{Default_Ignorable_Code_Point}]$/u.test(ch(c)),
        );
        const want = [...new Set([...glossaryProps('a capital letter'), ...accentOrInvisible])];
        // (1) red when the page's initial row and the letters read as an initial differ here; (2)
        //     prints the code points each has and the other lacks.
        expect(differ(got, want, from, to)).toEqual(NONE);
      },
    );

    it('an initial in context: a letter with a letter or `.` right before it is none (`xA.`); `U.S.` is an initialism, which ends no sentence either (#845 R-A3); `2A.` is one', () => {
      const ends = (q: string) => segmentsOf(q)[0]!.endsSentence;
      // (1) red when the row's context clause no longer holds; (2) prints the three booleans.
      expect({
        'U.S.': ends('Alpha U.S. Gamma'),
        'xA.': ends('Alpha xA. Gamma'),
        '2A.': ends('Alpha 2A. Gamma'),
      }).toEqual({ 'U.S.': false, 'xA.': true, '2A.': false });
    });

    it('B1 and M5: whitespace other than a line break marks, a line break does not (#845); a `\\p{Ll}` or `\\p{Nd}` character outside the BMP marks it too (#845 R-A2); the dots of `...` and a `.` right after `…` do not mark', () => {
      // #845 (R-B) re-pin: every whitespace other than a line break marks now, not only a plain space
      // and a tab
      const lineBreaks = glossaryCodes('a line break');
      const marking = glossaryCodes('whitespace').filter((w) => !lineBreaks.includes(w));
      const doc = 'THE TENANT SHALL PAY THE RENT AND THE RATES ON THE USUAL QUARTER DAYS.';
      const rows: Row[] = [
        ...glossaryCodes('whitespace').map((w): Row => [
          hex(w),
          read(approx, `${approx}${ch(w)}412 square metres.`),
          marking.includes(w) ? 'exact+cut_short' : 'exact',
        ]),
        // #845 (R-A2) re-pin, item 13: `exactGoesOn` reads by code point, so these mark
        ...codePoints(/^[\p{Ll}\p{Nd}]$/u, 0x10000).map((c): Row => [
          hex(c),
          read(approx, `${approx} ${ch(c)}12 square metres.`),
          'exact+cut_short',
        ]),
        [
          '`...` before a space',
          read('The Tenant shall pay the Rent... and the rates', doc),
          'reformatted',
        ],
        ['`...` at the quote’s end', read('The Tenant shall pay the Rent...', doc), 'reformatted'],
        [
          'a `.` right after `…`',
          read('The Tenant shall pay the Rent…. and the rates', doc),
          'reformatted',
        ],
      ];
      // (1) red when whitespace other than a line break stops marking the quote, an astral letter or
      //     digit leaves it unmarked (read as one UTF-16 unit), or the dots of `...` or a `.` right
      //     after `…` mark (the `…` run no longer taking the dots after it); (2) prints each differing
      //     row.
      expect(misses(rows)).toEqual([]);
    });

    it("B2 a label quoted with its item: the sentence's own rule over the glossary's sets, never the code's states", () => {
      const open = glossaryCodes('an opening mark');
      const capital = glossaryProps('a capital letter');
      const digit = glossaryProps('a digit', ';');
      const opensWith = (t: string, set: readonly number[]) => set.includes(cp(t));
      // The sentence (`:410`): after a line that ends with `;` or `:`, or after a blank line that
      // follows a line ending a sentence or a clause, quoting the label as well reads `stitched`; after a line that ends a sentence, a label that opens with
      // an opening mark or a capital letter does, and one that opens with a digit needs a capital
      // letter or an opening mark after it; any other label is refused there.
      const rule = (lb: string, item: string): string =>
        opensWith(lb, open) || opensWith(lb, capital)
          ? 'stitched'
          : opensWith(lb, digit) && (opensWith(item, capital) || opensWith(item, open))
            ? 'stitched'
            : 'not_found';
      // #845 1b-i-n: after a blank line under a line that ends nothing, the sentence's clause
      // number (`6.2`, `12.`, `(a)`, never bare digits; `a)`, `A)` and `A.` are none) is passed and
      // the word after it decides; any other label is itself the first word.
      const CLAUSE_NUMBER = /^(?:\([\p{L}\p{N}]{1,4}\)|\p{N}+(?:\.\p{N}+)+\.?|\p{N}+[.)])$/u;
      const blankRule = (lb: string, item: string): string =>
        (CLAUSE_NUMBER.test(lb) ? opensWith(item, capital) : opensWith(lb, capital))
          ? 'stitched'
          : 'not_found';
      const name = (lb: string, item: string) =>
        `${[...lb].map((c) => hex(cp(c))).join(' ')} before ${item.slice(0, 4)}`;
      const afterStop: Array<[string, string]> = [
        ...capital.flatMap((c): Array<[string, string]> => [
          [`${ch(c)})`, keep],
          [`${ch(c)}.`, keep],
        ]),
        ...open.map((m): [string, string] => [`${ch(m)}b)`, keep]),
        ...['2.', '2)', '6.2', '12.', '3.4.1', 'b.', 'a)', 'iv.', 'iv)', 'ab)'].flatMap(
          (l): Array<[string, string]> => [
            [l, Keep],
            [l, keep],
          ],
        ),
      ];
      const free = {
        ':⏎': [
          'The Tenant covenants with the Landlord as follows:\n',
          'The Tenant covenants with the Landlord',
        ],
        ';⏎': [
          'The Tenant shall pay the Rent on the usual quarter days;\n',
          'The Tenant shall pay the Rent on the usual',
        ],
        // #845 1b-i (B3) re-pin: main's "after a blank line" holds now only under a line that ends a
        // sentence or a clause; under one that ends nothing it is refused (below).
        'a blank line under a clause': [
          'The Tenant shall pay the Rent on the usual quarter days;\n\n',
          'The Tenant shall pay the Rent on the usual',
        ],
        'a blank line under a sentence': [
          'The Tenant shall pay the Rent on the usual quarter days.\n\n',
          'The Tenant shall pay the Rent on the usual',
        ],
      } as const;
      const rows: Row[] = [
        ...afterStop.map(([lb, item]): Row => [name(lb, item), label(lb, item), rule(lb, item)]),
        ...Object.entries(free).flatMap(([line, [before, first]]) =>
          ['(b)', '(iv)', '2.', '12.', '2)', '6.2', 'b.', 'a)', 'A)'].map((lb): Row => [
            `${name(lb, keep)} after ${line}`,
            state(`${first} … ${lb} ${keep}`, `${before}${lb} ${keep} at all times.`),
            'stitched',
          ]),
        ),
        // #845 1b-i-n (re-pinning 1b-i's B3 block): after a blank line under a line that ends
        // nothing, the piece's first word, past opening marks and one clause number or list mark at
        // the line's start, begins with a capital letter (the stitched row's sentence; `blankRule`).
        // A clause number is passed, so the lowercase item decides: `(b)` and `(iv)` are now refused
        // (1b-i: `stitched`, by their opening `(`). A label that is no clause number is the word.
        ...['(b)', '(iv)', '2.', '12.', '2)', '6.2', 'b.', 'a)', 'A)'].map((lb): Row => [
          `${name(lb, keep)} after a blank line under a line that ends nothing`,
          state(
            `The Tenant shall pay the Rent on the usual … ${lb} ${keep}`,
            `The Tenant shall pay the Rent on the usual quarter days\n\n${lb} ${keep} at all times.`,
          ),
          blankRule(lb, keep),
        ]),
      ];
      // (1) red when the code and the sentence part, for a label the sentence names; (2) prints each
      //     differing label's code points and state.
      expect(misses(rows)).toEqual([]);
    });

    it.each(
      (['.', '!'] as const).flatMap((end) =>
        PS_KINDS.map(([kind, re]) => [`\`${end}\``, kind, end, re] as const),
      ),
    )(
      'B3 a header ending with %s, then a line opening with a BMP %s mark: `stitched` for a list mark, an opening mark, `;` or `:`, and for no other',
      (_, __, end, re) => {
        const opens = new Set([
          ...glossaryCodes('a list mark'),
          ...glossaryCodes('an opening mark'),
          ...CLAUSE,
        ]);
        const rows = PS.filter((c) => re.test(ch(c))).map((c): Row => [
          hex(c),
          header(end, ch(c)),
          opens.has(c) ? 'stitched/stitched' : 'not_found/not_found',
        ]);
        // (1) red when a mark the sentence names stops opening the line, or another starts to; (2)
        //     prints each differing mark's code point and the two states.
        expect(misses(rows)).toEqual([]);
      },
    );

    it('B3 a run of U+0023 after a header that ends a sentence, and `;` and `:` after a header with no stop, read `stitched`', () => {
      // (1) red when one of these stops opening its line; (2) prints the three states.
      expect({
        run: [header('.', '##'), header('!', '##')],
        semicolon: header('', ';'),
        colon: header('', ':'),
      }).toEqual({
        run: ['stitched/stitched', 'stitched/stitched'],
        semicolon: 'stitched/stitched',
        colon: 'stitched/stitched',
      });
    });

    // ─── #845 unit 1a-i: the two new rows, the canonical form's new clauses, the offsets sentence and
    //     the CHANGELOG's two lines, each quoted, then run (check 10) ──────────────────────────────

    /** The cut quote and the whole word across `c` inside `unlawful`: an invisible character makes
     *  no edge, so the cut quote is not found and the whole word reads `reformatted`. */
    const acrossInside = (c: number) =>
      `${state('lawful use of the Premises', `any un${ch(c)}lawful use of the Premises`)}/${state(
        'unlawful use of the Premises',
        `any un${ch(c)}lawful use of the Premises`,
      )}`;
    /** The hyphens that join two letters into one word (`WORD_HYPHENS`, copied): they make the same
     *  pair of states for their own reason. */
    const WORD_HYPHENS = [0x2d, 0x2010, 0x2011, 0xfe63, 0xff0d];

    it.each(BLOCKS)(
      'an invisible character: the characters inside a word that make no edge in either layer, %s',
      (_, from, to) => {
        // a spacing accent that is a letter (U+037A, the Arabic isolated forms U+FC5E… and U+FE70…)
        // reads the same pair, as the spacing-accent row says: it is that row's
        const got = range(from, to).filter(
          (c) =>
            !WORD_HYPHENS.includes(c) &&
            !/^ \p{M}+$/u.test(ch(c).normalize('NFKC')) &&
            acrossInside(c) === 'not_found/reformatted',
        );
        // (1) red when the page's row and the characters the check reads as absent differ here (a
        //     Prepend sign read as invisible, or U+FEFF as a space); (2) prints the code points each
        //     has and the other lacks.
        expect(differ(got, glossaryCodes('an invisible character'), from, to)).toEqual(NONE);
      },
    );

    it('an invisible character, outside the BMP: every astral `\\p{Cf}` and default-ignorable code point but U+110BD and U+110CD', () => {
      const astral = codePoints(/^[\p{Cf}\p{Default_Ignorable_Code_Point}]$/u, 0x10000).filter(
        (c) => ch(c).length === 2,
      );
      const named = ['U+110BD', 'U+110CD'];
      const row = GLOSSARY.get('an invisible character') ?? '';
      const rows: Row[] = astral.map((c): Row => [
        hex(c),
        acrossInside(c),
        named.includes(hex(c)) ? 'exact/not_found' : 'not_found/reformatted',
      ]);
      // (1) red when an astral member reads otherwise, or the row stops naming the two astral Prepend
      //     signs as visible; (2) prints the missing names and each differing member.
      expect({
        named: named.filter((n) => !row.slice(row.indexOf('; not ')).includes(n)),
        misses: misses(rows),
      }).toEqual({ named: [], misses: [] });
    });

    it('a spacing accent: 50 characters Unicode turns into a space and a mark; between two digits a separator kept as itself, next to one digit a space, elsewhere dropped like punctuation', () => {
      const row = GLOSSARY.get('a spacing accent') ?? '';
      const accents = codePoints(/^[^]$/u, 0, 0x10ffff).filter((c) =>
        /^ \p{M}+$/u.test(ch(c).normalize('NFKC')),
      );
      const rows: Row[] = accents.flatMap((c): Row[] => [
        [
          `${hex(c)} between digits, part`,
          state('Price CHF 1', `Price CHF 1${ch(c)}000${ch(c)}000 net.`),
          'not_found',
        ],
        [
          `${hex(c)} between digits, spaced`,
          state('PRICE CHF 1 000 000', `Price CHF 1${ch(c)}000${ch(c)}000 net.`),
          'not_found',
        ],
        [
          `${hex(c)} next to one digit`,
          state('THE TEMPERATURE IS 25', `The temperature is 25${ch(c)}C at noon.`),
          'reformatted',
        ],
        [
          `${hex(c)} elsewhere`,
          state("the tenant can't", `the Tenant can${ch(c)}t`),
          'reformatted',
        ],
      ]);
      // (1) red when the count the row names, an example it names, or one member's reading in one of
      //     the three places differs from the row; (2) prints the count, the examples outside and
      //     each differing row.
      expect({
        count: row.includes(`${accents.length} as Node 24 reads Unicode 17.0`),
        examples: ['´', '¸', '˚', '゛'].filter((e) => !accents.includes(cp(e))),
        noBreakSpace: state('the rent', 'the rent'),
        misses: misses(rows),
      }).toEqual({ count: true, examples: [], noBreakSpace: 'reformatted', misses: [] });
    });

    // #845 1b-ii-a wording 1: the two new rows, each member and each named non-member run.
    it('a contraction apostrophe: each listed member and each spacing accent, right after `can` and before `t`, makes no word edge; U+02BC is a letter; U+201B and U+0022 make one', () => {
      const row = GLOSSARY.get('a contraction apostrophe') ?? '';
      const cut = row.indexOf(', or a spacing accent');
      const listed = cut < 0 ? [] : listedCodes(row.slice(0, cut));
      const accents = codePoints(/^[^]$/u, 0, 0x10ffff).filter((c) =>
        /^ \p{M}+$/u.test(ch(c).normalize('NFKC')),
      );
      const cutAt = (c: number) =>
        state('The Landlord can', `The Landlord can${ch(c)}t refuse consent.`);
      const rows: Row[] = [
        ...listed.map((c): Row => [`${hex(c)}, listed`, cutAt(c), 'not_found']),
        ...accents.map((c): Row => [`${hex(c)}, a spacing accent`, cutAt(c), 'not_found']),
        ['U+02BC, a letter', cutAt(0x2bc), 'not_found'],
        ['U+201B, not a member', cutAt(0x201b), 'exact'],
        ['U+0022, not a member', cutAt(0x22), 'exact'],
      ];
      // (1) red when the row lists other members (its read is pinned: six of six), names an
      //     example that is no spacing accent, or stops saying U+02BC is a letter, or when one
      //     member makes a word edge, or a named non-member stops making one; (2) prints the
      //     listed members, the examples outside, a boolean and each differing row.
      expect({
        listed: listed.map(hex),
        examples: ['´', '¨'].filter((e) => !accents.includes(cp(e))),
        letter:
          /^\p{L}$/u.test(ch(0x2bc)) &&
          row.includes(
            'U+02BC MODIFIER LETTER APOSTROPHE is a letter, so a word goes on across it anyway',
          ),
        misses: misses(rows),
      }).toEqual({
        listed: ['U+0027', 'U+0060', 'U+2018', 'U+2019', 'U+2032', 'U+FF07'],
        examples: [],
        letter: true,
        misses: [],
      });
    });

    it("a word hyphen: each listed member, right after `un` at a line's end, breaks the word, so `paid` after it is not found; an en or em dash, U+2012 and U+2212 do not", () => {
      const row = GLOSSARY.get('a word hyphen') ?? '';
      const cut = row.indexOf('; never');
      const listed = cut < 0 ? [] : listedCodes(row.slice(0, cut));
      const atEnd = (c: number) =>
        state(
          'paid for twenty-one days',
          `If any Rent shall remain un${ch(c)}\npaid for twenty-one days.`,
        );
      const rows: Row[] = [
        ...listed.map((c): Row => [`${hex(c)}, listed`, atEnd(c), 'not_found']),
        ['U+2013 EN DASH, named', atEnd(0x2013), 'exact'],
        ['U+2014 EM DASH, named', atEnd(0x2014), 'exact'],
        ['U+2012 FIGURE DASH', atEnd(0x2012), 'exact'],
        ['U+2212 MINUS SIGN', atEnd(0x2212), 'exact'],
      ];
      // (1) red when the row lists other members (its read is pinned: five of five) or drops its
      //     "never" clause, or when one member stops breaking the word or a dash starts to; (2)
      //     prints the listed members, a boolean and each differing row.
      expect({
        listed: listed.map(hex),
        never: row.endsWith('; never an en or em dash'),
        misses: misses(rows),
      }).toEqual({
        listed: ['U+002D', 'U+2010', 'U+2011', 'U+FE63', 'U+FF0D'],
        never: true,
        misses: [],
      });
    });

    it("the canonical form's new clauses (#845): invisible characters left out first, a spacing accent dropped unless next to a digit, a mark on anything but a letter dropped, a spacing accent between two digits kept as itself", () => {
      for (const clause of [
        'The canonical form is the text with its invisible characters left out, then after Unicode NFKC normalisation,',
        'every punctuation mark and quotation mark dropped, and every spacing accent not next to a digit, and spaces collapsed,',
        'and one it writes must match; a mark on anything but a letter is dropped)',
        'and the separators between two digits (a spacing accent between two digits is one, kept as itself).',
      ])
        claimOn(HANDLERS, clause);
      // (1) red when a clause's example reads otherwise; (2) prints each canonical form.
      expect({
        invisible: [canonicalForm('un​lawful'), canonicalForm('e͏́')],
        accentElsewhere: canonicalForm('can´t'),
        accentNextToOne: canonicalForm('25˚C'),
        markOnNoLetter: [canonicalForm('-́5'), canonicalForm('١َ٢')],
        accentBetween: canonicalForm('1´000'),
      }).toEqual({
        invisible: ['unlawful', 'é'],
        accentElsewhere: 'cant',
        accentNextToOne: '25 c',
        markOnNoLetter: ['-5', '١٢'],
        accentBetween: '1´000',
      });
    });

    it('the offsets: UTF-16 code units, a character outside the Basic Multilingual Plane counting as two', () => {
      claimOn(
        HANDLERS,
        '`parts` are where each part was found, as offsets into the document in UTF-16 code units, the unit JavaScript strings use (`text.slice(start, end)`; a character outside the Basic Multilingual Plane, such as an emoji, counts as two).',
      );
      const doc = 'x😀 rent';
      // (1) red when an offset counts the emoji as one; (2) prints the parts and the slice.
      expect({
        parts: locateQuote('rent', doc).parts,
        slice: doc.slice(4, 8),
      }).toEqual({ parts: [{ start: 4, end: 8 }], slice: 'rent' });
    });

    it("the CHANGELOG's two #845 lines (1a-i, 1a-ii): each example run", () => {
      claimOn(
        CL,
        "check_quotes reads each character by Unicode's rules: an invisible character or a mark can no longer split a number or a word, U+FEFF is invisible like a zero-width space, a spacing accent between two digits joins them, the sets of capitals, lowercase letters, spaces and line breaks follow Unicode's properties in every plane, the list, opening and closing marks follow Unicode's punctuation classes with a short named list, and initialisms such as U.S. do not end a sentence (#845).",
      );
      claimOn(
        CL,
        'check_quotes now reads some quotes not_found that read found before, on purpose: part of a number with a mark on it (`5` in `-́5`), part of a number whose digits a spacing accent separates (`1` in `1´000`), part of a number after a dash outside the Basic Multilingual Plane (`5` after U+10D6E), two words that only U+FEFF separates, and a skip onto the sentence after an initialism (`…the U.S. The…`) (#845).',
      );
      // (1) red when an example reads otherwise; (2) prints each state.
      expect({
        splitNumber: state('the fee is 12', 'the fee is 12­500 euro'),
        splitWord: state('lawful use of the Premises', 'any un​lawful use of the Premises'),
        feffLikeZwsp: [state('the rent', 'the﻿rent'), state('the rent', 'the​rent')],
        accentJoins: state('the price is 1', 'the price is 1´000 euro'),
        lowercase: read('The area is approx.', 'The area is approx. ª square metres.'),
        lineBreak: read(
          'The Tenant shall pay the Rent. and the rates',
          'THE TENANT SHALL PAY THE RENT\u000cAND THE RATES.',
        ),
        listMark: state(
          `${F} … the Tenant shall pay the insurance rent`,
          `${F} for its cost:\n○ the Tenant shall pay the insurance rent at the end of each year.`,
        ),
        markOnNumber: state('5 degrees', 'It is -́5 degrees.'),
        // #845 1a-ii: the two new clauses
        astralDash: state('5 degrees', `It is ${String.fromCodePoint(0x10d6e)}5 degrees.`),
        astralLowercase: read(
          'The area is approx.',
          `The area is approx. ${String.fromCodePoint(0x1d41a)} square metres.`,
        ),
        initialism: state(
          'We deliver across … The Landlord shall repair the roof.',
          'We deliver across the U.S. The Landlord shall repair the roof.',
        ),
      }).toEqual({
        splitNumber: 'not_found',
        splitWord: 'not_found',
        feffLikeZwsp: ['not_found', 'not_found'],
        accentJoins: 'not_found',
        lowercase: 'exact+cut_short',
        lineBreak: 'reformatted',
        listMark: 'stitched',
        markOnNumber: 'not_found',
        astralDash: 'not_found',
        astralLowercase: 'exact+cut_short',
        initialism: 'not_found',
      });
    });

    // ─── #845 1a-ii (check 6's half outside the BMP, check 10): the rows items 3–7 make "in any
    //     plane", each walked over its members outside the Basic Multilingual Plane with one control;
    //     and the two new sentences of rule 5 (items 1 and 10), each pinned and run. ─────────────
    /** A row's properties' members outside the BMP (`glossaryProps` reads the BMP). */
    const astralProps = (word: string, upTo?: string): number[] => {
      const cell = GLOSSARY.get(word) ?? '';
      const names = [
        ...cell
          .slice(0, upTo === undefined ? undefined : cell.indexOf(upTo))
          .matchAll(/\\p\{(\w+)\}/g),
      ];
      if (names.length === 0) return [];
      return codePoints(
        new RegExp(`^[${names.map((m) => `\\p{${m[1]!}}`).join('')}]$`, 'u'),
        0x10000,
      );
    };
    const marksApprox = (c: string) => read(approx, `${approx}${c}412 square metres.`);

    it('a capital letter, outside the BMP: every member opens a labelled item after a sentence; control U+1D41A', () => {
      const members = astralProps('a capital letter');
      const rows: Row[] = [
        ...members.map((c): Row => [hex(c), label(`${ch(c)})`, keep), 'stitched']),
        ['control U+1D41A', label('\u{1d41a})', keep), 'not_found'],
      ];
      // (1) red when the capital read is limited to the BMP, or the row stops saying "in any plane";
      //     (2) prints the count and each differing row.
      expect({
        anyPlane: (GLOSSARY.get('a capital letter') ?? '').includes('in any plane'),
        count: members.length > 700,
        misses: misses(rows),
      }).toEqual({ anyPlane: true, count: true, misses: [] });
    });

    it('a lowercase letter and a digit, outside the BMP: what an `exact` `approx.` is marked before; control U+10400', () => {
      const lower = astralProps('a lowercase letter').filter((c) => !/^\p{M}$/u.test(ch(c)));
      const digits = astralProps('a digit', ';');
      const rows: Row[] = [
        ...[...lower, ...digits].map((c): Row => [hex(c), marksApprox(ch(c)), 'exact+cut_short']),
        ['control U+10400', marksApprox('\u{10400}'), 'exact'],
      ];
      // (1) red when the lowercase or digit read is limited to the BMP, or a row stops saying "in any
      //     plane"; (2) prints the counts and each differing row.
      expect({
        anyPlane: ['a lowercase letter', 'a digit'].map((w) =>
          (GLOSSARY.get(w) ?? '').includes('in any plane'),
        ),
        counts: [lower.length > 900, digits.length > 390],
        misses: misses(rows),
      }).toEqual({ anyPlane: [true, true], counts: [true, true], misses: [] });
    });

    it('a digit, outside the BMP: every member opens a clause number before a capital after a sentence; control U+10107', () => {
      const members = astralProps('a digit', ';');
      const rows: Row[] = [
        ...members.map((c): Row => [hex(c), label(`${ch(c)})`, Keep), 'stitched']),
        ['control U+10107', label('\u{10107})', Keep), 'not_found'],
      ];
      // (1) red when the digit read is limited to the BMP; (2) prints the count and each differing row.
      expect({ count: members.length > 390, misses: misses(rows) }).toEqual({
        count: true,
        misses: [],
      });
    });

    it('a dash and a list mark, outside the BMP: U+10D6E and U+10EAD read as `-` and open the line after a header; control U+1D400', () => {
      const dashes = glossaryCodes('a dash').filter((c) => c > 0xffff);
      const listDashes = astralProps('a list mark');
      const rows: Row[] = [
        ...dashes.map((c): Row => [
          `${hex(c)} as -`,
          state('-5 degrees', `${ch(c)}5 degrees`),
          'reformatted',
        ]),
        ...listDashes.map((c): Row => [
          `${hex(c)} a list mark`,
          header('.', ch(c)),
          'stitched/stitched',
        ]),
        ['control U+1D400 as -', state('-5 degrees', '\u{1d400}5 degrees'), 'not_found'],
        ['control U+1D400 a list mark', header('.', '\u{1d400}'), 'not_found/not_found'],
      ];
      // (1) red when the dash read is limited to the BMP, the two rows stop naming them, or the list
      //     mark row limits its dashes to the BMP again (Words item 3); (2) prints the members named
      //     and each differing row.
      expect({
        listRow: (GLOSSARY.get('a list mark') ?? '').startsWith('a dash (`\\p{Pd}`),'),
        dashes: dashes.map(hex),
        listDashes: listDashes.map(hex),
        misses: misses(rows),
      }).toEqual({
        listRow: true,
        dashes: ['U+10D6E', 'U+10EAD'],
        listDashes: ['U+10D6E', 'U+10EAD'],
        misses: [],
      });
    });

    it("the stitched row's initialism sentence (Words item 1): each one named ends no sentence, a lowercase one does", () => {
      claimOn(
        HANDLERS,
        'Neither is the `.` after each capital of an initialism (`U.S.`, `U.K.`, `J.R.R.`).',
      );
      // (1) red when an initialism ends a sentence, or `a.m.` stops ending one; (2) prints each
      //     initialism's piece count.
      expect(
        Object.fromEntries(
          ['U.S.', 'U.K.', 'J.R.R.', 'a.m.'].map((a) => [
            a,
            segmentsOf(`made in the ${a} The roof`).length,
          ]),
        ),
      ).toEqual({ 'U.S.': 1, 'U.K.': 1, 'J.R.R.': 1, 'a.m.': 2 });
    });

    it('a skip after an initialism (Words item 10): onto the next sentence, or onto the next line, reads `not_found`; after an ordinary stop it is `stitched`', () => {
      claimOn(
        HANDLERS,
        'A skip onto the sentence after one that ends with an initialism (`…the U.S. The…`), and a skip onto the line after a line that ends with one: its `.` is read as part of the initialism, not as a sentence end.',
      );
      const A = 'The Tenant shall pay the rent.';
      const B = 'The Landlord shall repair the roof.';
      // (1) red when a skip lands after an initialism, or after an ordinary stop it is refused; (2)
      //     prints the four states.
      expect({
        sentence: read(`${A} … ${B}`, `${A} We deliver across the U.S. ${B}`),
        line: read(`${A} … ${B}`, `${A}\nDelivery is made within the U.S.\n${B}`),
        controlSentence: read(`${A} … ${B}`, `${A} We deliver across the country. ${B}`),
        controlLine: read(`${A} … ${B}`, `${A}\nDelivery is made within the country.\n${B}`),
      }).toEqual({
        sentence: 'not_found',
        line: 'not_found',
        controlSentence: 'stitched',
        controlLine: 'stitched',
      });
    });
  });

  // ─── #845 1a-i correction 1 (`prompts/fix-845-1a-i-correction-1.md`, Words): the sentences the walk
  //     and the audit found incomplete, each pinned and its claim run over every member. ──────────
  describe('#845 1a-i correction 1: the number signs and the letter accents, in the words', () => {
    const ACCENTS = codePoints(/^[^]$/u).filter((c) => /^ \p{M}+$/u.test(ch(c).normalize('NFKC')));
    const LETTER_ACCENTS = ACCENTS.filter((c) => /^\p{L}$/u.test(ch(c)));

    it('the number paragraph: one of the 13 number signs written right before a number belongs to it', () => {
      claimOn(
        HANDLERS,
        'A currency or mathematical sign, a dash, or one of the 13 number signs (U+0600–U+0605, U+06DD, U+070F, U+0890, U+0891, U+08E2, U+110BD, U+110CD), written right before a number belongs to it',
      );
      const rows: Row[] = PREPEND.flatMap((s): Row[] =>
        ['250', '٢٥٠'].flatMap((digits): Row[] => {
          const doc = `The fee is ${ch(s)}${digits} in cash.`;
          return [
            [`${hex(s)} ${digits} alone`, read(digits, doc), 'not_found'],
            [
              `${hex(s)} ${digits}, the words without the sign`,
              read(`The fee is ${digits}`, doc),
              'not_found',
            ],
            [
              `${hex(s)} ${digits}, with the sign`,
              read(`The fee is ${ch(s)}${digits}`, doc),
              'exact',
            ],
          ];
        }),
      );
      // (1) red when the count differs, or a sign does not bind the number after it; (2) prints the
      //     count and each differing row.
      expect({ count: PREPEND.length, misses: misses(rows) }).toEqual({ count: 13, misses: [] });
    });

    it('the kept characters (the `reformatted` row and the canonical form): the 13 number signs are kept, so a word quoted without one is not found', () => {
      const rows: Row[] = PREPEND.flatMap((s): Row[] => {
        const doc = `The code is ab${ch(s)}cd here.`;
        return [
          [`${hex(s)} kept`, String(canonicalForm(`ab${ch(s)}cd`).includes(ch(s))), 'true'],
          [`${hex(s)} quoted without it`, read('The code is abcd here.', doc), 'not_found'],
          [`${hex(s)} quoted with it`, read(`The code is ab${ch(s)}cd here.`, doc), 'exact'],
        ];
      });
      // (1) red when a number sign is set aside by the canonical form; (2) prints each differing row.
      expect(misses(rows)).toEqual([]);
    });

    it('the glossary row "a spacing accent": 15 of them are also letters, and inside a word they join it as an invisible character does', () => {
      const row = GLOSSARY.get('a spacing accent') ?? '';
      const quotes = ['The Tenant can', 'The Tenant cant sublet.'];
      const rows: Row[] = LETTER_ACCENTS.flatMap((c): Row[] => {
        const doc = `The Tenant can${ch(c)}t sublet.`;
        const zwsp = 'The Tenant can\u{200b}t sublet.';
        return quotes.map((q): Row => [`${hex(c)} ${q}`, read(q, doc), read(q, zwsp)]);
      });
      // (1) red when the count or a named member differs, the row does not say so, or a letter accent
      //     reads otherwise than U+200B inside the word; (2) prints the members and each differing row.
      expect({
        says: row.includes(
          `elsewhere it is dropped like punctuation. ${String(LETTER_ACCENTS.length)} of them are also letters (U+037A and 14 Arabic isolated forms, such as U+FE70, as Node 24 reads Unicode 17.0); inside a word these join it, as an invisible character does`,
        ),
        named: [0x37a, 0xfe70].every((c) => LETTER_ACCENTS.includes(c)),
        arabic: LETTER_ACCENTS.filter((c) => /^\p{Script=Arabic}$/u.test(ch(c))).length,
        part: read(quotes[0]!, `The Tenant can${ch(0xfe70)}t sublet.`),
        whole: read(quotes[1]!, `The Tenant can${ch(0xfe70)}t sublet.`),
        misses: misses(rows),
      }).toEqual({
        says: true,
        named: true,
        arabic: 14,
        part: 'not_found',
        whole: 'reformatted',
        misses: [],
      });
    });

    it('the Chinese, Japanese and Thai bullet: a spacing accent sets two runs apart, except the 15 that are letters, which join them', () => {
      claimOn(
        HANDLERS,
        'a spacing accent (`´`, `゛`) counts as such a punctuation mark, except next to a digit, and except the 15 that are letters, which join the runs beside them.',
      );
      const rows: Row[] = ACCENTS.map((c): Row => [
        hex(c),
        // The whole run before the accent: `東京` alone is part of that run, `not_found` either way.
        read('我们在東京', `我们在東京${ch(c)}大阪工作。`),
        LETTER_ACCENTS.includes(c) ? 'not_found' : 'exact',
      ]);
      // (1) red when a letter accent sets the runs apart, or another accent joins them; (2) prints
      //     the counts and each differing row.
      expect({
        accents: ACCENTS.length,
        letters: LETTER_ACCENTS.length,
        misses: misses(rows),
      }).toEqual({ accents: 50, letters: 15, misses: [] });
    });
  });
});

// ---------------------------------------------------------------------------------------------------
// #845 unit 1b-i (`prompts/fix-845-1b-i-lines-and-joins.md`, check 12): each sentence the unit
// changes, quoted, then run against the code.

describe('#845 1b-i — the words of rules 1 and 2 (B3, a blank line inside a sentence; Q-C, the refusal), each executed', () => {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
  const HANDLERS = 'docs/reference/handlers.md';
  const CL = 'CHANGELOG.md';
  const raw = (p: string) => readFileSync(join(ROOT, p), 'utf8');
  const flatten = (t: string) => t.replace(/\\\|/g, '|').replace(/\s+/g, ' ');
  /** (a) red when the page no longer holds the sentence word for word; (b) prints it. */
  const claimOn = (p: string, sentence: string): void => {
    expect(flatten(raw(p)), `${p} no longer says: ${sentence}`).toContain(flatten(sentence));
  };
  const state = (quote: string, source: string) => locateQuote(quote, source).state;
  const F = 'The Landlord shall insure the Building';
  const rest =
    'not be responsible for repairs to the structure, roof, foundations or exterior of the Building';
  const shall = `${F} for its full reinstatement cost. The Tenant shall`;

  it('the `not_found` row, the record, `locateQuote`’s return and its item 5: a quote joined across a blank line is `not_found` with `cause` and `join_at` (the quote’s offset), no `nearest`; each part, quoted alone, is found', () => {
    claimOn(
      HANDLERS,
      'or the quote joins text across a blank line where the `stitched` row does not allow it, recorded with `cause` and `join_at` when nothing else refuses it; or the value has no quote.',
    );
    claimOn(
      HANDLERS,
      "`cause` and `join_at` appear only on a `not_found` quote that joins text across a blank line: `cause` is `blank_line_join`, and `join_at` holds the quote's offsets where each refused join sits. Each part, quoted on its own, may still be found.",
    );
    claimOn(
      HANDLERS,
      'it is absent when that piece holds no whole word, and on a quote refused for joining text across a blank line',
    );
    claimOn(
      HANDLERS,
      "It returns `{ state, parts, occurrences, nearest?, cut_short?, cut_short_at?, cause?, join_at? }`, with the offsets into `source` (`join_at`'s into `quote`)",
    );
    claimOn(
      HANDLERS,
      "a quote refused for joining text across a blank line carries `cause: 'blank_line_join'` and `join_at` instead of `nearest`.",
    );
    const quote = `${F} … ${rest}`;
    const doc = `${shall}\n\n${rest}.`;
    const refused = locateQuote(quote, doc);
    // "when nothing else refuses it": a made-up third part, a part under the floor, and a skip that
    // also passes a label, each across the same kind of blank line, give `nearest` and no `cause`.
    const P = 'The Tenant shall pay the Rent on the usual';
    const item = 'keep the Premises in good and substantial repair';
    const other = (q: string, d: string) => {
      const c = locateQuote(q, d);
      return `${c.state}${c.cause === undefined ? '' : `+${c.cause}`}${c.nearest === undefined ? '' : '+nearest'}`;
    };
    // (a) red when the refusal is not recorded so, `join_at` is not the quote's offset after the `…`,
    //     a `nearest` is kept, a part alone is refused, or a quote something else refuses carries
    //     `cause`; (b) prints the record, the quote's text from `join_at`, each part's state alone,
    //     and the three others.
    expect({
      refused,
      fromJoin: quote.slice(refused.join_at?.[0] ?? 0),
      partsAlone: [state(F, doc), state(rest, doc)],
      madeUpThird: other(
        `${quote} … The Tenant shall pay a deposit of twenty-four thousand euro`,
        doc,
      ),
      underFloor: other(`${F} … not be liable`, `${shall}\n\nnot be liable for repairs.`),
      labelSkipped: other(`${P} … ${item}`, `${P} quarter days\n\n(b) ${item} at all times.`),
    }).toEqual({
      refused: {
        state: 'not_found',
        parts: [],
        occurrences: 0,
        cause: 'blank_line_join',
        join_at: [quote.indexOf('…') + 1],
      },
      fromJoin: ` ${rest}`,
      partsAlone: ['exact', 'exact'],
      madeUpThird: 'not_found+nearest',
      underFloor: 'not_found+nearest',
      labelSkipped: 'not_found+nearest',
    });
  });

  it('the warning paragraph: a refused quote reads `(this quote joins text across a blank line; quote each part separately)` in place of its nearest match', async () => {
    claimOn(
      HANDLERS,
      'a quote refused for joining text across a blank line reads `(this quote joins text across a blank line; quote each part separately)` in place of its nearest match',
    );
    const result = await new CheckQuotesHandler().execute(
      { params: {} },
      {
        run_id: 'r',
        run_params: {},
        config: { source_step: 'doc', candidates_step: 'extract' },
        resources: {
          doc: { text: `${shall}\n\n${rest}.` },
          extract: { candidates: [{ field: 'joined', value: 'v', quote: `${F} … ${rest}` }] },
        },
      },
    );
    // (a) red when the refusal prints a nearest-match parenthesis instead; (b) prints the warning's tail.
    const tail = '…" (this quote joins text across a blank line; quote each part separately).';
    expect(result.warn?.message.slice(-tail.length)).toBe(tail);
  });

  it('the CHANGELOG names `QuoteCheck`’s two fields under [Unreleased], Added', () => {
    claimOn(
      CL,
      "`QuoteCheck` gains `cause` and `join_at`: a quote that check_quotes refuses for joining text across a blank line is `not_found` with `cause: 'blank_line_join'` and the quote's offsets of each refused join, and its warning says to quote each part separately (#845).",
    );
    const text = raw(CL);
    const start = text.indexOf('## [Unreleased]');
    const unreleased = text.slice(start, text.indexOf('\n## [', start + 1));
    const added = unreleased.slice(
      unreleased.indexOf('### Added'),
      unreleased.indexOf('### Changed'),
    );
    // (a) red when the line leaves [Unreleased]'s Added section; (b) prints a boolean.
    expect(added.includes('- `QuoteCheck` gains `cause` and `join_at`:')).toBe(true);
  });

  it('the two new honest refusals: a `…` skip over a page header onto a lowercase word, or one that keeps only the line break; a `…` skip onto a piece whose first word, past one opening mark, or one label and at most one opening mark, does not begin with a capital letter, after a blank line under a line that ends nothing, an item after `; and` or `; or` included; straight past a label, `nearest` and no `cause`; with an opening mark between, `cause` (#845 1b-i-n)', () => {
    claimOn(
      HANDLERS,
      '- A `…` skip over a page header onto a lowercase word, or one that keeps only the line break (`…shall`, a blank line, `Page 3`, a blank line, `pay the rent…`): it joins text across a blank line. Quote each part separately.',
    );
    claimOn(
      HANDLERS,
      '- A `…` skip that lands, after a blank line under a line that ends no sentence, clause or table row, on a piece whose first word, past one opening mark, or one clause number or list mark followed by at most one opening mark, does not begin with a capital letter (`The Tenant shall pay the rent on the usual quarter days`, a blank line, `- keep the Premises in good repair…`, quoted `The Tenant shall pay the rent … keep the Premises in good repair`; also `2. keep…`, `b. keep…`, `(b) keep…`, `(a) 30 days…` and `(subject to clause 5) not…` quoted as written, and `“the Landlord…`): refused the same way. A lettered item after a list item that ends with `; and` or `; or` (`(ii) …; and`, a blank line, `(iii) not to allow…`) is refused the same way: such a line ends no clause, so quote each item separately. A skip that also passes a label straight onto the lowercase word (`(b)`, `2.`, `b.`, `IV.`, then `keep…`) reads `not_found` with its nearest match and no `cause`; with an opening mark between (`2. “not be…`, or `b. (subject to clause 5) not…` landing on `subject`), it is refused the same way.',
    );
    const A = 'The Landlord says that the Tenant shall';
    const B = 'pay the rent quarterly in advance';
    const page = `${A}\n\nPage 3\n\n${B} on the usual days.`;
    const P = 'The Tenant shall pay the Rent on the usual';
    const item = 'keep the Premises in good and substantial repair';
    const cause = (quote: string, source: string) => locateQuote(quote, source).cause ?? 'none';
    // The bullet's own example, and its labels quoted or skipped.
    const R = 'The Tenant shall pay the rent';
    const K = 'keep the Premises in good repair';
    const rent = (label: string) => `${R} on the usual quarter days\n\n${label}${K} at all times.`;
    // #845 1b-i-n: the new examples, each on its own line after the blank line
    const line = (text: string) => `${R} on the usual quarter days\n\n${text} at all times.`;
    const NOT = 'not be responsible for repairs';
    const SUB = `(subject to clause 5) ${NOT}`;
    const DAYS = '(a) 30 days after the date of the invoice';
    const LL = 'the Landlord shall keep the structure in repair';
    const read = (quote: string, source: string) => {
      const c = locateQuote(quote, source);
      return `${c.state}${c.cause === undefined ? '' : `+${c.cause}${JSON.stringify(c.join_at)}`}${c.nearest === undefined ? '' : '+nearest'}`;
    };
    // (a) red when one of these reads found (its bullet would then be false), is refused without
    //     the cause, or a skip past a label carries `cause` or loses `nearest`; (b) prints each.
    expect({
      headerSkipped: cause(`${A} … ${B}`, page),
      lineBreakKept: cause(`${A}\n${B}`, page),
      listItem: cause(`${P} … ${item}`, `${P} quarter days\n\n- ${item} at all times.`),
      theExample: read(`${R} … ${K}`, rent('- ')),
      numberQuoted: read(`${R} … 2. ${K}`, rent('2. ')),
      letterQuoted: read(`${R} … b. ${K}`, rent('b. ')),
      pastBracket: read(`${R} … ${K}`, rent('(b) ')),
      pastNumber: read(`${R} … ${K}`, rent('2. ')),
      pastLetter: read(`${R} … ${K}`, rent('b. ')),
      pastRoman: read(`${R} … ${K}`, rent('IV. ')),
      bracketQuoted: read(`${R} … (b) ${K}`, rent('(b) ')),
      daysQuoted: read(`${R} … ${DAYS}`, line(DAYS)),
      subjectQuoted: read(`${R} … ${SUB}`, line(SUB)),
      openingMarkSkipped: read(`${R} … ${LL}`, line(`“${LL}`)),
      numberThenMarkSkipped: read(`${R} … ${NOT}`, line(`2. “${NOT}`)),
      letterThenMarkSkipped: read(`${R} … ${SUB}`, line(`b. ${SUB}`)),
    }).toEqual({
      headerSkipped: 'blank_line_join',
      lineBreakKept: 'blank_line_join',
      listItem: 'blank_line_join',
      theExample: `not_found+blank_line_join[${R.length + 2}]`,
      numberQuoted: `not_found+blank_line_join[${R.length + 2}]`,
      letterQuoted: `not_found+blank_line_join[${R.length + 2}]`,
      pastBracket: 'not_found+nearest',
      pastNumber: 'not_found+nearest',
      pastLetter: 'not_found+nearest',
      pastRoman: 'not_found+nearest',
      bracketQuoted: `not_found+blank_line_join[${R.length + 2}]`,
      daysQuoted: `not_found+blank_line_join[${R.length + 2}]`,
      subjectQuoted: `not_found+blank_line_join[${R.length + 2}]`,
      openingMarkSkipped: `not_found+blank_line_join[${R.length + 2}]`,
      numberThenMarkSkipped: `not_found+blank_line_join[${R.length + 2}]`,
      letterThenMarkSkipped: `not_found+blank_line_join[${R.length + 2}]`,
    });
    // #845 1b-i-n correction 1: the "also" list's lettered item after `; and` or `; or` (the walk's
    // FR1), and the second sentence's `b. (subject to clause 5) not…` landing on `subject`. (a) red
    // when one reads found, or is refused without the cause; (b) prints each.
    const LEAD = 'The Tenant covenants with the Landlord as follows:';
    const ITEM = '(iii) not to allow any person to sleep on the Premises';
    const list = (end: string) =>
      `${LEAD}\n\n(i) to pay the rent on the usual quarter days;\n\n(ii) to keep the Premises clean and tidy${end}\n\n${ITEM}.`;
    expect({
      afterAnd: read(`${LEAD} … ${ITEM}`, list('; and')),
      afterOr: read(`${LEAD} … ${ITEM}`, list('; or')),
      landingOnSubject: read(`${R} … subject to clause 5) ${NOT}`, line(`b. ${SUB}`)),
    }).toEqual({
      afterAnd: `not_found+blank_line_join[${LEAD.length + 2}]`,
      afterOr: `not_found+blank_line_join[${LEAD.length + 2}]`,
      landingOnSubject: `not_found+blank_line_join[${R.length + 2}]`,
    });
  });

  it('the `stitched` row and item 3: an item after a list mark may open with any word at a new line that counts, other than after a blank line under a line that ends none of those', () => {
    const P = 'The Tenant shall pay the Rent on the usual';
    const item = 'keep the Premises in good and substantial repair';
    // (a) red when the list item after a blank line under a line that ends a sentence is refused, or
    //     the one under a line that ends nothing is admitted; (b) prints the two states.
    expect([
      state(`${P} … ${item}`, `${P} quarter days.\n\n- ${item} at all times.`),
      state(`${P} … ${item}`, `${P} quarter days\n\n- ${item} at all times.`),
    ]).toEqual(['stitched', 'not_found']);
  });
});

describe('#845 1b-i — the words of rule 4 (Outside-b, a `:` between two digits), each executed', () => {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
  const HANDLERS = 'docs/reference/handlers.md';
  const raw = (p: string) => readFileSync(join(ROOT, p), 'utf8');
  const flatten = (t: string) => t.replace(/\\\|/g, '|').replace(/\s+/g, ' ');
  /** (a) red when the page no longer holds the sentence word for word; (b) prints it. */
  const claimOn = (p: string, sentence: string): void => {
    expect(flatten(raw(p)), `${p} no longer says: ${sentence}`).toContain(flatten(sentence));
  };
  const F = 'The Landlord shall insure the Building';

  it('the `stitched` row and item 3: a clause starts after `;` or `:`, but not a `:` between two digits, even across a line break; the new honest refusal: a numbered item quoted with its number after `Clause 4:`', () => {
    claimOn(
      HANDLERS,
      'a clause (after `;` or `:`, but not a `:` between two digits, even across a line break)',
    );
    claimOn(
      HANDLERS,
      '- A skip onto a numbered item quoted with its number, after a line ending with a digit and `:` (`Clause 4:`, then `1. The Tenant…`).',
    );
    const thirty = '30 minutes before the Tenant arrives at the Building';
    const item = '1. The Tenant shall pay the insurance rent';
    // (a) red when a `:` between two digits across a line break ends a clause again, or the numbered
    //     item after `Clause 4:` reads found (the bullet would then be false); (b) prints the states.
    expect({
      sameLine: locateQuote(`${F} … ${thirty}`, `${F} for its cost at 9:${thirty}.`).state,
      acrossLine: locateQuote(`${F} … ${thirty}`, `${F} for its cost at 9:\n${thirty}.`).state,
      clause4: locateQuote(
        `${F} … ${item}`,
        `${F} as set out in Clause 4:\n${item} at the end of each year.`,
      ).state,
    }).toEqual({ sameLine: 'not_found', acrossLine: 'not_found', clause4: 'not_found' });
  });
});

describe('#845 1b-i — the words of rule 5 (M8r, a list mark with a blank after it), each executed', () => {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
  const HANDLERS = 'docs/reference/handlers.md';
  const raw = (p: string) => readFileSync(join(ROOT, p), 'utf8');
  const flatten = (t: string) => t.replace(/\\\|/g, '|').replace(/\s+/g, ' ');
  /** (a) red when the page no longer holds the sentence word for word; (b) prints it. */
  const claimOn = (p: string, sentence: string): void => {
    expect(flatten(raw(p)), `${p} no longer says: ${sentence}`).toContain(flatten(sentence));
  };
  const F = 'The Landlord shall insure the Building';
  const item = 'the Tenant shall pay the insurance rent';
  const after = (mark: string) =>
    locateQuote(
      `${F} … ${item}`,
      `${F} for its full reinstatement cost:\n${mark}${item} at the end of each year.`,
    ).state;

  it('the `stitched` row, item 3 and the glossary: a list mark with a blank after it is skipped; a blank is whitespace other than a line break, a no-break space one, an invisible character not', () => {
    claimOn(HANDLERS, 'or a list mark with a blank after it is skipped');
    claimOn(
      HANDLERS,
      '| a blank | whitespace other than a line break; a no-break space is one, an invisible character is not |',
    );
    // Every blank the row names: `\p{White_Space}` but the seven line breaks (all at or below U+3000).
    const breaks = [0x0a, 0x0b, 0x0c, 0x0d, 0x85, 0x2028, 0x2029];
    const blanks = Array.from({ length: 0x3001 }, (_, c) => c).filter(
      (c) => /^\p{White_Space}$/u.test(String.fromCodePoint(c)) && !breaks.includes(c),
    );
    const notOpening = blanks.filter((c) => after(`-${String.fromCodePoint(c)}`) !== 'stitched');
    // (a) red when a blank after a mark stops opening an item, or nothing, U+200B or U+FEFF after it
    //     opens one; (b) prints the blanks that fail and the states.
    expect({
      blanks: blanks.length,
      notOpening,
      feff: after('-\u{feff}'),
      space: after('- '),
      noBreakSpace: after('-\u{a0}'),
      nothing: after('-'),
      zeroWidthSpace: after('-\u{200b}'),
    }).toEqual({
      blanks: 18,
      notOpening: [],
      feff: 'not_found',
      space: 'stitched',
      noBreakSpace: 'stitched',
      nothing: 'not_found',
      zeroWidthSpace: 'not_found',
    });
  });

  it('the new honest refusal: an item whose list mark has no blank after it (`-the Tenant`, `-“the Tenant`)', () => {
    claimOn(
      HANDLERS,
      '- An item whose list mark has no blank after it (`-the Tenant`, `-“the Tenant`).',
    );
    // (a) red when one of them reads found (the bullet would then be false); (b) prints the states.
    expect([after('-'), after('-\u{201c}')]).toEqual(['not_found', 'not_found']);
  });
});

describe('#845 1b-i — the words of rule 6 (item 14, a `.` after a word with no letter or digit), each executed', () => {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
  const HANDLERS = 'docs/reference/handlers.md';
  const raw = (p: string) => readFileSync(join(ROOT, p), 'utf8');
  const flatten = (t: string) => t.replace(/\\\|/g, '|').replace(/\s+/g, ' ');
  /** (a) red when the page no longer holds the sentence word for word; (b) prints it. */
  const claimOn = (p: string, sentence: string): void => {
    expect(flatten(raw(p)), `${p} no longer says: ${sentence}`).toContain(flatten(sentence));
  };
  const F = 'The Landlord shall insure the Building';

  it('the `stitched` row and item 3: a `.` ends a sentence only when the word before it holds a letter or a digit; the new honest refusal: a stop after a sign set apart by a space', () => {
    claimOn(
      HANDLERS,
      "A `.` ends a sentence only when the word before it holds a letter or a digit (a spacing accent is neither): `2024. The` does, `§. Keep` and `\u{37a}. Keep` do not; after a blank line under a line that ends none of those, the `.` that closes the line's first word, when that is a clause number or a word of up to four letters (`2.`, `b.`, `IV.`), ends a sentence only before a capital letter, past any opening marks.",
    );
    claimOn(
      HANDLERS,
      '- A skip after a stop that follows a sign set apart by a space (`20 °. The`).',
    );
    const keep = 'Keep the Premises in good and substantial repair';
    const tenant = 'The Tenant shall pay the insurance rent';
    // (a) red when one of the examples reads otherwise (a sentence would then end, or not, against
    //     the sentence); (b) prints the six states.
    expect({
      year: locateQuote(`${F} … ${tenant}`, `${F} signed in 2024. ${tenant} at once.`).state,
      section: locateQuote(`${F} … ${keep}`, `${F} for its cost.\n\u{a7}. ${keep} at once.`).state,
      accent: locateQuote(`${F} … ${keep}`, `${F} for its cost.\n\u{37a}. ${keep} at once.`).state,
      degree: locateQuote(`${F} … ${tenant}`, `${F} at 20 \u{b0}. ${tenant} at once.`).state,
      // #845 1b-i-n: after a blank line under a line that ends nothing, a short first word's `.`
      blankLineStop: locateQuote(
        `${F} … (subject to clause 5) not be responsible for repairs`,
        `${F} for its full reinstatement cost and the Tenant shall\n\nb. (subject to clause 5) not be responsible for repairs.`,
      ).state,
      blankLineStopCapital: locateQuote(
        `${F} … ${tenant}`,
        `${F} for its full reinstatement cost and the Tenant shall\n\nb. \u{201c}${tenant} at once.`,
      ).state,
    }).toEqual({
      year: 'stitched',
      section: 'not_found',
      accent: 'not_found',
      degree: 'not_found',
      blankLineStop: 'not_found',
      blankLineStopCapital: 'stitched',
    });
  });
});

describe('#845 1b-i — the words of rule 7 (walk M8) and the CHANGELOG’s Changed line, each executed', () => {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
  const HANDLERS = 'docs/reference/handlers.md';
  const CL = 'CHANGELOG.md';
  const raw = (p: string) => readFileSync(join(ROOT, p), 'utf8');
  const flatten = (t: string) => t.replace(/\\\|/g, '|').replace(/\s+/g, ' ');
  /** (a) red when the page no longer holds the sentence word for word; (b) prints it. */
  const claimOn = (p: string, sentence: string): void => {
    expect(flatten(raw(p)), `${p} no longer says: ${sentence}`).toContain(flatten(sentence));
  };
  const F = 'The Landlord shall insure the Building';
  const read = (quote: string, source: string) => {
    const c = locateQuote(quote, source);
    return `${c.state}${c.cut_short === true ? '+cut_short' : ''}`;
  };

  it('the `cut_short` paragraph: a part that sits in two places that fit equally is placed where its sentence ends, if the rest of the quote still follows it in order', () => {
    claimOn(
      HANDLERS,
      'When a part sits in two places that fit equally, the one where its sentence ends is chosen, if the rest of the quote still follows it in order.',
    );
    const quote =
      'The Tenant shall pay the rent … The Landlord shall repair the roof. The Tenant may assign the lease';
    const follows =
      'The Tenant shall pay the rent quarterly. The Landlord shall repair the roof and walls. The Landlord shall repair the roof. The Tenant may assign the lease with consent.';
    const doesNot =
      'The Tenant shall pay the rent quarterly. The Landlord shall repair the roof and walls. The Tenant may assign the lease with consent. The Landlord shall repair the roof.';
    // (a) red when the place where the sentence ends is not chosen though the rest follows it, or is
    //     chosen though the rest does not; (b) prints the two states.
    expect([read(quote, follows), read(quote, doesNot)]).toEqual([
      'stitched',
      'stitched+cut_short',
    ]);
  });

  it('the CHANGELOG’s Changed line: each skip it names reads not_found, and a part found in two places is placed where its sentence ends', () => {
    claimOn(
      CL,
      'check_quotes reads more skips as not_found, on purpose: one across a blank line under a line that does not end a sentence, a clause or a table row, onto a piece whose first word, past one opening mark, or one clause number or list mark followed by at most one opening mark, does not begin with a capital letter; an item whose list mark has no blank after it (`-the`); a `|` that ends a prose line; a `:` between two digits across a line break; and a `.` after a word with no letter or digit (`§. Keep`). A stitched part found in two places is placed where its sentence ends when the rest of the quote still follows it, so fewer quotes are marked `cut_short` (#845).',
    );
    const item = 'the Tenant shall pay the insurance rent';
    const Keep = 'Keep the Premises in good and substantial repair';
    const skip = (between: string, second = item) =>
      read(`${F} … ${second}`, `${F} for its full reinstatement cost${between}${second} at once.`);
    // (a) red when one of these reads found (the line would then be false), the ones the line excepts
    //     (a first word that begins with a capital letter, past an opening mark too) are refused, or
    //     the stitched part is still cut short; (b) prints the states. #845 1b-i-n re-pin: a piece
    //     right after an opening mark, on a lowercase word, is no longer excepted (main: `stitched`).
    expect({
      blankLine: skip('\n\n'),
      blankLineCapital: skip('\n\n', `T${item.slice(1)}`),
      blankLineAfterMark: read(
        `${F} … ${item}`,
        `${F} for its full reinstatement cost\n\n“${item}” at once.`,
      ),
      blankLineAfterMarkCapital: read(
        `${F} … T${item.slice(1)}`,
        `${F} for its full reinstatement cost\n\n“T${item.slice(1)}” at once.`,
      ),
      listMark: skip(':\n-'),
      prosePipe: skip(' or |\n'),
      colon: read(
        `${F} … 30 minutes before the Tenant arrives at the Building`,
        `${F} for its cost at 9:\n30 minutes before the Tenant arrives at the Building.`,
      ),
      noLetter: skip('.\n\u{a7}. ', Keep),
      twoPlaces: read(
        'The Tenant shall pay … Monday rent is waived.',
        'The Tenant shall pay by 9 a.m. Monday rent is waived on holidays only. Monday rent is waived.',
      ),
    }).toEqual({
      blankLine: 'not_found',
      blankLineCapital: 'stitched',
      blankLineAfterMark: 'not_found',
      blankLineAfterMarkCapital: 'stitched',
      listMark: 'not_found',
      prosePipe: 'not_found',
      colon: 'not_found',
      noLetter: 'not_found',
      twoPlaces: 'stitched',
    });
    // #845 1b-i-n correction 1: "past one opening mark, or one clause number or list mark followed by
    // at most one opening mark". (a) red when a label and its one mark stop being passed, or a piece
    // after two opening marks reads found (its first word, past one mark, is `(T…`); (b) prints both.
    expect({
      labelThenMarkCapital: read(
        `${F} … T${item.slice(1)}`,
        `${F} for its full reinstatement cost\n\n(a) “T${item.slice(1)}” at once.`,
      ),
      twoMarksCapital: read(
        `${F} … ((T${item.slice(1)}`,
        `${F} for its full reinstatement cost\n\n((T${item.slice(1)} at once.`,
      ),
    }).toEqual({ labelThenMarkCapital: 'stitched', twoMarksCapital: 'not_found' });
  });
});

describe('#845 1b-ii-a — the words, each executed', () => {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
  const HANDLERS = 'docs/reference/handlers.md';
  const CL = 'CHANGELOG.md';
  const raw = (p: string) => readFileSync(join(ROOT, p), 'utf8');
  const flatten = (t: string) => t.replace(/\\\|/g, '|').replace(/\s+/g, ' ');
  /** (a) red when the page no longer holds the sentence word for word; (b) prints it. */
  const claimOn = (p: string, sentence: string): void => {
    expect(flatten(raw(p)), `${p} no longer says: ${sentence}`).toContain(flatten(sentence));
  };
  const state = (quote: string, source: string) => locateQuote(quote, source).state;
  /** Every example the exact row's new sentence and the CHANGELOG line give, as each reads. */
  const examples = () => ({
    contractions: [
      state('THE LANDLORD CAN', "THE LANDLORD CAN'T REFUSE CONSENT."),
      state('The Landlord can', 'The Landlord can\u00b4t refuse consent.'),
      state('The Tenant did', "The Tenant did'nt pay the rent."),
      state('t make structural alterations.', "The Tenant won't make structural alterations."),
    ],
    hyphen: state(
      'paid twenty-one (21) days after becoming payable',
      'If any Rent is un-\npaid twenty-one (21) days after becoming payable.',
    ),
  });
  const refused = {
    contractions: ['not_found', 'not_found', 'not_found', 'not_found'],
    hyphen: 'not_found',
  };

  it("the exact row: a contraction ending in `'t` or `'nt`, with any contraction apostrophe, makes no word edge, nor a word hyphen or a soft hyphen that breaks a word across one line (wording 1 re-pin; the two glossary words run by their own cells)", () => {
    claimOn(
      HANDLERS,
      "a contraction ending in `'t` or `'nt`, written with any contraction apostrophe, makes no word edge either (`CAN` is not found in `CAN'T`, nor `can` in `can´t`, nor `did` in `did'nt`, nor `t make` in `won't make`), and neither does a word hyphen or a soft hyphen that breaks a word across one line (`paid` is not found after `un-` ending a line);",
    );
    // (a) red when one of the examples reads found (R-F or S1/F1 removed); (b) prints the states, and
    //     the soft hyphen's.
    expect(examples()).toEqual(refused);
    expect(
      state(
        'paid twenty-one (21) days after becoming payable',
        'If any Rent is un\u00ad\npaid twenty-one (21) days after becoming payable.',
      ),
    ).toBe('not_found');
  });

  it("the CHANGELOG's Changed line: a quote that cuts a contraction ending in `'t` or `'nt`, or starts or ends at a hyphen breaking a word across a line, reads not_found; so does one beside such a hyphen where it breaks no word (wording 1 re-pin)", () => {
    claimOn(
      CL,
      "check_quotes reads a quote that cuts a contraction ending in `'t` or `'nt` (`CAN` in `CAN'T`, `can` in `can´t`, `did` in `did'nt`, `t make` in `won't make`) or that starts or ends at a hyphen breaking a word across a line (`paid` after `un-` ending a line) as not_found, on purpose; so does a quote beside such a hyphen where it breaks no word (`and long-term liabilities` after `all short-` ending a line, or the line after a heading `4. RENT-`) (#845).",
    );
    // (a) red when one of the examples reads found; (b) prints the states, and the end edge's, and
    //     (wording 1) the two quotes beside a hyphen that breaks no word.
    expect(examples()).toEqual(refused);
    expect(state('The Landlord can', 'The Landlord can-\nnot refuse consent.')).toBe('not_found');
    expect([
      state(
        'and long-term liabilities',
        'The accounts show all short-\nand long-term liabilities of the Company.',
      ),
      state(
        'The Tenant shall pay the Rent on the usual quarter days.',
        '4. RENT-\r\nThe Tenant shall pay the Rent on the usual quarter days.\r\n5. REPAIR\r\n',
      ),
    ]).toEqual(['not_found', 'not_found']);
  });
});

describe('#845 1b-ii-b — the words, each executed', () => {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
  const HANDLERS = 'docs/reference/handlers.md';
  const CL = 'CHANGELOG.md';
  const raw = (p: string) => readFileSync(join(ROOT, p), 'utf8');
  const flatten = (t: string) => t.replace(/\\\|/g, '|').replace(/\s+/g, ' ');
  /** (a) red when the page no longer holds the sentence word for word; (b) prints it. */
  const claimOn = (p: string, sentence: string): void => {
    expect(flatten(raw(p)), `${p} no longer says: ${sentence}`).toContain(flatten(sentence));
  };
  const ch = String.fromCodePoint;
  /** A quote's state, `@` and its cut-short offsets when marked. */
  const cut = (quote: string, source: string): string => {
    const c = locateQuote(quote, source);
    return `${c.state}${c.cut_short === true ? `@${(c.cut_short_at ?? []).join(',')}` : ''}`;
  };
  const A = 'The rent is payable at approx.';
  const S = `${A} 412 pounds a month. The Tenant shall pay it on time.`;
  const DOTS = ch(0x2026);
  const tail = ' The Tenant shall pay it on time.';

  it('the paragraph, where a quote ends a sentence: an `exact` quote at its last character other than whitespace and invisible characters; a `.` an abbreviation, an initial, an initialism or a word with no letter or digit ends is none; whitespace the quote carries changes nothing', () => {
    claimOn(
      HANDLERS,
      'An `exact` quote ends a sentence at its last character other than whitespace and invisible characters, when that is `.`, `!` or `?`;',
    );
    claimOn(
      HANDLERS,
      "A `.` that ends an abbreviation on the check's list, an initial, an initialism or a word with no letter or digit ends no sentence (`Clause No.`, `e.g.`, `U.S.`, `20 °.`).",
    );
    claimOn(HANDLERS, 'Whitespace the quote carries after its stop changes nothing.');
    // (a) red when one of the sentences' examples reads otherwise; (b) prints each read.
    expect({
      'approx. 412': cut(A, S),
      'approx. and a space': cut(`${A} `, S),
      'approx. and U+200B': cut(`${A}${ch(0x200b)}`, `${A}${ch(0x200b)} 412 pounds a month.`),
      'Clause No.': cut(
        'as set out in Clause No.',
        'The rent is as set out in Clause No. 5 of this lease.',
      ),
      'e.g.': cut(
        'such as rates, e.g.',
        'The Tenant pays outgoings such as rates, e.g. the water rates.',
      ),
      'U.S.': cut(
        'the rules of the U.S.',
        'The parties follow the rules of the U.S. and the parties agree.',
      ),
      '20 °.': cut(
        `The heating rises to 20 ${ch(0xb0)}.`,
        `The heating rises to 20 ${ch(0xb0)}. the Landlord keeps it on.`,
      ),
    }).toEqual({
      'approx. 412': 'exact@30',
      'approx. and a space': 'exact@30',
      'approx. and U+200B': 'exact@30',
      'Clause No.': 'exact',
      'e.g.': 'exact',
      'U.S.': 'exact',
      '20 °.': 'exact',
    });
  });

  it("the paragraph, the document's own stop: it marks a quote only where the quote stops there, in each state that has one; inside a quote that goes on with the document's next words, it marks nothing", () => {
    claimOn(
      HANDLERS,
      "Where the document has its own `.`, `!` or `?` and the quote stops there (an exact quote's end, a part's end in a `stitched` or `stitched_out_of_order` quote, a reformatted quote's end), the quote is marked when, past that stop, closing marks and whitespace other than a line break, a lowercase letter or a digit follows (`approx. 412`); inside a quote that goes on with the document's own next words, that stop marks nothing.",
    );
    // (a) red when one producing branch loses the mark, a stop inside the quote marks it, or a line
    //     break or a capital after the stop marks it; (b) prints each read.
    expect({
      exact: cut(A, S),
      'a stitched part, not the last': cut(
        `${A} ${DOTS} The Tenant shall pay it on time.`,
        `${A} 412 pounds a month.${tail}`,
      ),
      'a stitched_out_of_order part': cut(
        `The Landlord shall insure the Building. ${DOTS} ${A}`,
        `${A} 412 pounds a month. The Landlord shall insure the Building.`,
      ),
      reformatted: cut(
        A,
        'the rent is payable at approx. 412 pounds a month and the tenant shall pay',
      ),
      'inside a reformatted quote': cut(
        'THE RENT IS PAYABLE AT APPROX. 412 POUNDS A MONTH',
        'The rent is payable at approx. 412 pounds a month and the Tenant shall pay it on time.',
      ),
      'inside a part': cut(
        `The Tenant covenants as follows ${DOTS} 2. keep the Premises in repair`,
        'The Tenant covenants as follows: 1. pay the rent; 2. keep the Premises in repair.',
      ),
      'a line break after the stop': cut(
        'The rent is due.',
        'The rent is due.\nthe Tenant shall pay it.',
      ),
      'a capital after the stop': cut(
        'The rent is due.',
        'The rent is due. The Tenant shall pay it.',
      ),
    }).toEqual({
      exact: 'exact@30',
      'a stitched part, not the last': 'stitched@30',
      'a stitched_out_of_order part': 'stitched_out_of_order@30',
      reformatted: 'reformatted@30',
      'inside a reformatted quote': 'reformatted',
      'inside a part': 'stitched',
      'a line break after the stop': 'exact',
      'a capital after the stop': 'exact',
    });
  });

  it('the paragraph, where the document has no stop: marked unless whitespace, then a line break or the text’s end, follows', () => {
    claimOn(
      HANDLERS,
      "Where the document has no stop, the quote is marked unless whitespace other than a line break, then a line break or the text's end, follows.",
    );
    // (a) red when the no-stop read changes; (b) prints each read.
    expect({
      'the line goes on': cut('The Rent is payable.', 'the rent is payable monthly in advance'),
      'blanks, then a line break': cut(
        'The Rent is payable.',
        'the rent is payable  \nmonthly in advance',
      ),
      "the text's end": cut('The Rent is payable.', 'the rent is payable'),
    }).toEqual({
      'the line goes on': 'reformatted@19',
      'blanks, then a line break': 'reformatted',
      "the text's end": 'reformatted',
    });
  });

  it("the CHANGELOG's Changed line: `cut_short` is read one way in every state", () => {
    claimOn(
      CL,
      'check_quotes reads `cut_short` one way in every state: a reformatted quote or a stitched part that stops where the document has its own stop and then a lowercase letter or a digit is now marked, and so is an exact quote that carries whitespace or an invisible character after its stop; an exact quote that ends an abbreviation, an initial, an initialism or a word with no letter or digit (`Clause No.`, `e.g.`, `U.S.`, `20 °.`) is no longer marked (#845).',
    );
    // (a) red when one of the line's examples reads otherwise; (b) prints each read.
    expect({
      'a reformatted quote, then a lowercase letter': cut(
        'The Rent is payable.',
        'the rent is payable. monthly in advance',
      ),
      'a stitched part, then a digit': cut(
        `${A} ${DOTS} The Tenant shall pay it on time.`,
        `${A} 412 pounds a month.${tail}`,
      ),
      'an exact quote and whitespace': cut(`${A} `, S),
      'an exact quote and an invisible character': cut(
        `${A}${ch(0x34f)}`,
        `${A}${ch(0x34f)} 412 pounds a month.`,
      ),
      'Clause No.': cut(
        'as set out in Clause No.',
        'The rent is as set out in Clause No. 5 of this lease.',
      ),
      'e.g.': cut(
        'such as rates, e.g.',
        'The Tenant pays outgoings such as rates, e.g. the water rates.',
      ),
      'U.S.': cut(
        'the rules of the U.S.',
        'The parties follow the rules of the U.S. and the parties agree.',
      ),
      '20 °.': cut(
        `The heating rises to 20 ${ch(0xb0)}.`,
        `The heating rises to 20 ${ch(0xb0)}. the Landlord keeps it on.`,
      ),
    }).toEqual({
      'a reformatted quote, then a lowercase letter': 'reformatted@20',
      'a stitched part, then a digit': 'stitched@30',
      'an exact quote and whitespace': 'exact@30',
      'an exact quote and an invisible character': 'exact@30',
      'Clause No.': 'exact',
      'e.g.': 'exact',
      'U.S.': 'exact',
      '20 °.': 'exact',
    });
  });
});

describe('#845 1b-ii-c — the words, each executed', () => {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
  const CL = 'CHANGELOG.md';
  const raw = (p: string) => readFileSync(join(ROOT, p), 'utf8');
  const flatten = (t: string) => t.replace(/\\\|/g, '|').replace(/\s+/g, ' ');
  /** (a) red when the page no longer holds the sentence word for word; (b) prints it. */
  const claimOn = (p: string, sentence: string): void => {
    expect(flatten(raw(p)), `${p} no longer says: ${sentence}`).toContain(flatten(sentence));
  };

  it("the CHANGELOG's Changed line: `nearest` without a cut word, the warning's cut, the step-level refusal", async () => {
    claimOn(
      CL,
      "check_quotes gives a not-found quote's `nearest` without a word the piece it covers cuts at either end, never part of a word, and keeps a number's sign or symbol; its warning cuts a long quote and a field label before a letter or symbol the cut would split (an accented letter, a joined emoji), not inside it, unless one alone runs past the 80th character; and a source or candidates step whose output is not an object with fields is refused with words saying what it gave and to start a new run (#845).",
    );
    const nearAt = (quote: string, source: string): string => {
      const n = locateQuote(quote, source).nearest;
      return n === undefined ? 'none' : source.slice(n.start, n.end);
    };
    const handler = new CheckQuotesHandler();
    const x = (n: number): string => 'x'.repeat(n);
    const execute = (resources: Record<string, unknown>) =>
      handler.execute(
        { params: {} },
        {
          run_id: 'r',
          run_params: {},
          config: { source_step: 'fetch', candidates_step: 'extract' },
          resources,
        },
      );
    const warn = (
      await execute({
        fetch: { text: 'The Tenant shall pay the rent.' },
        extract: {
          candidates: [
            { field: 'accented', value: 'v', quote: `${x(79)}e\u0301yy` },
            { field: 'emoji', value: 'v', quote: `${x(79)}\u{1f468}\u200d\u{1f469}yy` },
            { field: 'alone', value: 'v', quote: `e${'\u0301'.repeat(100)}yy` },
            { field: `${x(79)}e\u0301yy`, value: 'v', quote: 'nothing like it' },
          ],
        },
      })
    ).warn?.message;
    const refusal = async (resources: Record<string, unknown>): Promise<string> => {
      try {
        await execute(resources);
        return 'not refused';
      } catch (err) {
        return err instanceof WorkflowError ? err.message : 'untyped';
      }
    };
    const NEW_RUN = 'then start a new run: this run keeps that output';
    const source = await refusal({ fetch: [], extract: { candidates: [] } });
    const candidates = await refusal({ fetch: { text: 'The rent.' }, extract: 'rent' });
    // (a) red when one of the line's examples reads otherwise; (b) prints each read.
    expect({
      cutWord: nearAt('qqq ndlord shall repair', 'The Landlord shall repair the roof.'),
      sign: nearAt('zzz €48,000 a year', 'The rent is €48,000 a year.'),
      accented: (warn ?? '').includes(`accented — "${x(79)}…" (`),
      emoji: (warn ?? '').includes(`emoji — "${x(79)}…" (`),
      alone: (warn ?? '').includes(`alone — "e${'\u0301'.repeat(79)}…" (`),
      fieldLabel: (warn ?? '').includes(`; ${x(79)}… — "nothing like it"`),
      source: [
        source.includes("the source step 'fetch' gave no output (got an empty list)"),
        source.includes(NEW_RUN),
      ],
      candidates: [
        candidates.includes(
          "the candidates step 'extract' gave a string, not an object with fields",
        ),
        candidates.includes(NEW_RUN),
      ],
    }).toEqual({
      cutWord: 'shall repair',
      sign: '€48,000 a year',
      accented: true,
      emoji: true,
      alone: true,
      fieldLabel: true,
      source: [true, true],
      candidates: [true, true],
    });
  });
});
