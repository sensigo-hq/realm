// docs-claims-625.test.ts — issue #625 PR-2a, decision C163 (the method): each sentence about
// function behaviour that #625 PR-2a adds or changes in `docs/reference/core-library.md` is pinned
// here, one cell per function and case it covers. Each cell quotes its sentence exactly and asserts
// the page still holds it (read from the repository), then drives the case through the library and
// asserts what the sentence states — so neither the page nor the behaviour can change alone.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
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
import { unreadableRunFileError } from '../store/run-file.js';
import { WorkflowError } from '../types/workflow-error.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
import type { RunStore } from '../store/store-interface.js';
import { agentActionFor, nextCalls, owedOf } from '../test-support/ways-view.js';
import { composeWaysAt, stepBrief } from './ways.js';
import { compareStrings } from '../handlers/primitives/compare-strings.js';

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
  let store: JsonFileStore;
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'realm-dc-625-'));
    store = new JsonFileStore(dir);
  });

  async function atQuestion(d: WorkflowDefinition = gated()) {
    const { run } = await store.create({ workflowId: d.id, workflowVersion: 1, params: {} });
    const opened = await executeStep(store, d, {
      runId: run.id,
      command: 'q',
      input: {},
      dispatcher,
    });
    if (opened.status !== 'confirm_required') throw new Error(`fixture: ${opened.status}`);
    return { runId: run.id, gateId: (await store.get(run.id)).pending_gate!.gate_id };
  }

  // --- the expiry line names the call (line 80) -----------------------------------------------
  const NAMES_THE_CALL =
    "When a call carries out an expired question's `on_expiry`, the library prints nothing: the line that says so is in the reply's `warnings`, and names the call — for your program's own call, the function: `this advanceRun call first carried out its declared …` (`enacted_via: advanceRun`), and likewise `executeStep`, `executeChain`, `submitHumanResponse` and `executeEngineStep`";
  it.each([
    [
      'advanceRun',
      (d: WorkflowDefinition, runId: string) => advanceRun(store, d, { runId, now: LATER() }),
    ],
    [
      'executeStep',
      (d: WorkflowDefinition, runId: string) =>
        executeStep(store, d, { runId, command: 'after', input: {}, dispatcher, now: LATER() }),
    ],
    [
      'executeChain',
      (d: WorkflowDefinition, runId: string) =>
        executeChain(store, d, { runId, command: 'after', input: {}, dispatcher, now: LATER() }),
    ],
    [
      'executeEngineStep',
      async (d: WorkflowDefinition, runId: string) =>
        executeEngineStep(store, d, {
          runId,
          step: 'after',
          run: await store.get(runId),
          now: LATER(),
        }),
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
        `gate '${gateId}' on 'q' had expired 1m before this call — this ${fn} call first carried out its declared settle_default: the default choice 'approve' was recorded (enacted_via: ${fn}).`,
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
    const reply = await submitHumanResponse(store, d, {
      runId,
      gateId,
      choice: 'reject',
      now: LATER(),
    });
    expect(reply.warnings).toContain(
      `gate '${gateId}' on 'q' had expired 1m before this call — this submitHumanResponse call first carried out its declared settle_default: the default choice 'approve' was recorded (enacted_via: submitHumanResponse).`,
    );
  });

  // --- callers (lines 102, 104, 119, 121) -----------------------------------------------------
  it.each([
    [
      'advanceRun',
      "`caller` is one of five words: `advanceRun` (the default, a program's own call), `advance_run`, `advance`, `start_run` or `agent`.",
      ['advanceRun', 'advance_run', 'advance', 'start_run', 'agent'],
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
              run: await store.get(runId),
              caller: c,
            });
        }
      };
      const before = JSON.stringify(await store.get(runId));
      // (a) red when a listed word is refused, or another word is taken; (b) prints the throw.
      await expect(call('nightly')).rejects.toMatchObject({
        code: 'VALIDATION_CALLER_INVALID',
        message: expect.stringMatching(
          new RegExp(`^${fn}'s caller is one of ${words.join(', ')}; `),
        ),
      });
      expect(JSON.stringify(await store.get(runId))).toBe(before);
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
    const named = await advanceRun(store, d, { runId: a.runId, caller: 'advance', now: LATER() });
    const b = await atQuestion(d);
    const labelled = await advanceRun(store, d, {
      runId: b.runId,
      caller: 'advance',
      command: 'nightly',
      now: LATER(),
    });
    // (a) red when caller stops labelling the reply, or command renames the line; (b) prints them.
    expect([named.command, labelled.command]).toEqual(['advance', 'nightly']);
    expect(labelled.warnings.some((w) => w.includes('this advance call first carried out'))).toBe(
      true,
    );
  });

  // --- answering, then advanceRun (lines 82, 101, 102) ----------------------------------------
  it('C163 lines 82, 101: submitHumanResponse runs no auto step — ok, running, the owed sentence, advance_run offered; advanceRun then runs it', async () => {
    claim('Answering a question does not run an `auto` step that comes after it.');
    claim('Then `submitHumanResponse` replies `status: ok` with `run_phase: running`.');
    claim(
      "Its `context_hint` says `Gate 'decide' resolved with choice 'approve'.`, and its `ways` hold an `advance` way whose `owed` names `file`.",
    );
    claim('It runs no `auto` step: call `advanceRun` for the steps the answer made ready.');
    claim(
      'The replies are `EngineReply`: the fields of an MCP tool reply (see [MCP tools](mcp/tools.md)) without `next_actions`, `agent_action` and `blocked_reason.suggestion`, and with what can be done next as data',
    );
    claim(
      'A program reads the run with `store.get(runId)`, and takes a way with the function that matches it: `executeStep` for a `run_step` way, `advanceRun` for an `advance` way, `submitHumanResponse` for a `respond` way; `LIBRARY_WORDS` says each way in those words.',
    );
    claim(
      'Your program then calls `advanceRun` (also imported from `@sensigo/realm`), which runs `file`:',
    );
    claim(
      'Say the workflow has one more step, `file` (`execution: auto`, `depends_on: [decide]`).',
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
    const { run } = await store.create({ workflowId: d.id, workflowVersion: 1, params: {} });
    await executeStep(store, d, { runId: run.id, command: 'decide', input: {}, dispatcher });
    const gateId = (await store.get(run.id)).pending_gate!.gate_id;
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
    expect((await store.get(run.id)).completed_steps).not.toContain('file');
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
    const r = await advanceRun(store, d, {
      runId,
      now: LATER(),
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
    const r = await advanceRun(store, d, {
      runId,
      now: LATER(),
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
      const { run } = await store.create({ workflowId: d.id, workflowVersion: 1, params: {} });
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
      store.settleStep = async (id, delta, def, o) => {
        if (raced && first && delta.kind === 'settle_guard') {
          first = false;
          settles.push(`other: ${(await original(id, delta, def, o)).applied}`);
        }
        const mine = await original(id, delta, def, o);
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
    const r = await advanceRun(store, d, { runId, now: LATER() });
    // (a) red when the hint says "no step ran" beside the guards that ran, names one of two, or
    //     the singular for two; (b) prints the hint.
    expect([r.context_hint, r.names_next, nextCalls(r)]).toEqual([
      `Run '${runId}': its expired question was carried out as declared, and that decided guards 'e1', 'e2' (see warnings); no other step ran.`,
      true,
      ['run_step:w'],
    ]);
  });

  it.each(['settleStep', 'legacy update'] as const)(
    'round 22 finding 10 (decided in round 23): the question from the step’s prompt is rendered from the record alone — the gate-open write (%s) carries the step’s evidence entry, its output equal to the gate’s preview, so the prompt’s question equals the reply’s gate.display',
    async (path) => {
      const d: WorkflowDefinition = {
        id: `dc-f10-${path === 'settleStep' ? 'settle' : 'legacy'}`,
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
      // A store whose gate-open write takes the legacy path: it declares no `settleStep`.
      const s: RunStore =
        path === 'settleStep'
          ? store
          : new Proxy(store, {
              get(target, key) {
                if (key === 'settleStep') return undefined;
                const value: unknown = Reflect.get(target, key, target);
                return typeof value === 'function'
                  ? (value as (...a: unknown[]) => unknown).bind(target)
                  : value;
              },
            });
      const { run } = await s.create({ workflowId: d.id, workflowVersion: 1, params: {} });
      const output = { subject: 'Office closed', lines: 3 };
      const opened = await executeStep(s, d, {
        runId: run.id,
        command: 'draft',
        input: output,
        dispatcher: async () => output,
      });
      const record = await s.get(run.id);
      const entry = [...record.evidence]
        .reverse()
        .find((e) => e.step_id === 'draft' && e.kind !== 'gate_response');
      // (a) red when the gate-open write leaves the step's evidence off the record (the record then
      //     cannot give the step's output), when that entry's output is not the preview, or when the
      //     question differs from the reply's display; (b) prints all three.
      expect({
        status: opened.status,
        entryIsPreview:
          JSON.stringify(entry?.output_summary) === JSON.stringify(record.pending_gate?.preview),
        question: pendingGateQuestion(d, record),
        display: opened.gate?.display,
      }).toEqual({
        status: 'confirm_required',
        entryIsPreview: true,
        question: 'Send "Office closed" (3 lines)?',
        display: 'Send "Office closed" (3 lines)?',
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
    await writeFile(join(dir, 'broken.json'), '{not json');
    const broken = await advanceRun(store, d, { runId: 'broken' });
    const lost = await advanceRun(untyped(), d, { runId: 'r' });
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

  it('issue #719 (C2), error-codes.md: which ENGINE_STORE_FAILED reads are worth retrying — EBUSY and EIO; not another errno, nor the untyped wrap', () => {
    const sentence =
      'A JSON-store read that failed with `EBUSY` or `EIO` is worth retrying; any other read is not, nor is `Failed to load run from store: …`.';
    const page = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../../../../docs/reference/error-codes.md'),
      'utf8',
    );
    expect(flat(page), `error-codes.md no longer says: ${sentence}`).toContain(flat(sentence));
    const read = (errno: string) =>
      unreadableRunFileError({
        resource: 'run_file',
        class: 'unreadable',
        path: '/r/x.json',
        errno,
      }).retryable;
    // (a) red when the retry rule the sentence states changes for any of them; (b) prints the four.
    expect({
      EBUSY: read('EBUSY'),
      EIO: read('EIO'),
      EACCES: read('EACCES'),
      untyped: runReadError(new Error('the disk is gone')).retryable,
    }).toEqual({ EBUSY: true, EIO: true, EACCES: false, untyped: false });
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
      await writeFile(join(dir, 'broken.json'), '{not json');
      const call = (s: RunStore, runId: string) =>
        fn === 'executeStep'
          ? executeStep(s, d, { runId, command: 'after', input: {}, dispatcher })
          : fn === 'executeChain'
            ? executeChain(s, d, { runId, command: 'after', input: {}, dispatcher })
            : submitHumanResponse(s, d, { runId, gateId: 'g', choice: 'approve' });
      const replies = [
        await call(store, 'nope'),
        await call(offline(), 'r'),
        await call(store, 'broken'),
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

  // --- now (lines 102, 119: C150, C157) -------------------------------------------------------
  it('C163 line 102: advanceRun given a number, a string or an invalid Date as now rejects VALIDATION_OPTION_INVALID before anything is read or written — at an open question and on a run with none', async () => {
    claim(
      "`now` is a `Date`, the time the call judges a question's expiry by (default: the current time).",
    );
    claim(
      'Given anything else (a number, a string, or a `Date` that is not a valid time), the call rejects with `VALIDATION_OPTION_INVALID` before anything is read or written.',
    );
    const d = gated();
    const { runId } = await atQuestion(d);
    const before = JSON.stringify(await store.get(runId));
    const plain: WorkflowDefinition = {
      id: 'dc-plain',
      name: 'p',
      version: 1,
      steps: { only: { description: 'O.', execution: 'auto', depends_on: [] } },
    };
    const { run } = await store.create({ workflowId: plain.id, workflowVersion: 1, params: {} });
    const plainBefore = JSON.stringify(await store.get(run.id));
    for (const [now, type] of [
      [Date.now(), 'number'],
      [new Date().toISOString(), 'string'],
      [new Date(Number.NaN), 'Date (invalid)'],
    ] as const) {
      // (a) red when a call runs on such a `now`, or throws anything else; (b) prints the rejection.
      for (const [def, id] of [
        [d, runId],
        [plain, run.id],
      ] as const) {
        await expect(
          advanceRun(store, def, { runId: id, now: now as never }),
        ).rejects.toMatchObject({
          code: 'VALIDATION_OPTION_INVALID',
          details: { invalid: [{ option: 'options.now', given_type: type }] },
        });
      }
    }
    // issue #719 (C5): booleans — a failure prints whether each record is unchanged, never it.
    expect([
      JSON.stringify(await store.get(runId)) === before,
      JSON.stringify(await store.get(run.id)) === plainBefore,
    ]).toEqual([true, true]);
  });

  const NOW_ROW =
    "A `Date`, the time the call judges an open question's expiry by (default: the current time): the call carries out an expired question's declared `on_expiry` first only when the question's time is up at `now`.";
  it.each(['executeStep', 'executeChain'] as const)(
    'C157, W1-Y3: %s judges the question by now — time up at now: carried out first; not up at now: left open',
    async (fn) => {
      claim(NOW_ROW);
      const d = gated();
      const call = (runId: string, now: Date) =>
        fn === 'executeStep'
          ? executeStep(store, d, { runId, command: 'after', input: {}, dispatcher, now })
          : executeChain(store, d, { runId, command: 'after', input: {}, dispatcher, now });
      const up = await atQuestion(d);
      const carried = await call(up.runId, LATER());
      const notUp = await atQuestion(d);
      const left = await call(notUp.runId, EARLIER());
      // (a) red when the call judges by the clock instead of `now`; (b) prints the replies.
      expect([
        carried.status,
        carried.warnings.some((w) => w.includes(`this ${fn} call first carried out`)),
      ]).toEqual(['ok', true]);
      expect([left.status, left.warnings]).toEqual(['blocked', []]);
      expect((await store.get(notUp.runId)).pending_gate?.gate_id).toBe(notUp.gateId);
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
    const { run } = await store.create({ workflowId: d.id, workflowVersion: 1, params: {} });
    const r = await executeEngineStep(store, d, {
      runId: run.id,
      step: 'only',
      run: await store.get(run.id),
    });
    expect([r.status, r.run_phase, (await store.get(run.id)).completed_steps]).toEqual([
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
    expect(composeStepViews(await store.get(runId))['q']?.answers?.[0]?.answered_by).toMatchObject({
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
    const { runId } = await atQuestion(d);
    const record = await store.get(runId);
    await writeFile(join(dir, 'broken.json'), '{not json');
    const missing = await executeEngineStep(store, d, {
      runId: 'nope',
      step: 'after',
      run: record,
    });
    const broken = await executeEngineStep(store, d, {
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
    const before = JSON.stringify(await store.get(runId));
    // (a) red when a call runs without a run record, or throws anything else; (b) prints the rejection.
    await expect(
      executeEngineStep(store, d, { runId, step: 'after' } as never),
    ).rejects.toMatchObject({
      code: 'VALIDATION_OPTION_INVALID',
      details: { invalid: [{ option: 'options.run', given_type: 'undefined' }] },
    });
    await expect(
      executeEngineStep(store, d, { runId, step: 'after', run: { id: runId } } as never),
    ).rejects.toMatchObject({
      code: 'VALIDATION_OPTION_INVALID',
      message: expect.stringContaining(
        'options.run must be a run record (got object) (workflow_id is missing; ',
      ),
    });
    // issue #719 (C2): the fields are named only when `run` is an object — a `null` run, none.
    const nullRun = (await executeEngineStep(store, d, {
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
    expect(JSON.stringify(await store.get(runId)) === before).toBe(true);
    // C174: a step with no `depends_on` — the same refusal, before any read.
    const lone: WorkflowDefinition = {
      id: 'dc-lone',
      name: 'l',
      version: 1,
      steps: { only: { description: 'Only.', execution: 'auto', depends_on: [] } },
    };
    const { run: loneRun } = await store.create({
      workflowId: lone.id,
      workflowVersion: 1,
      params: {},
    });
    await expect(
      executeEngineStep(store, lone, { runId: loneRun.id, step: 'only' } as never),
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
    const { run } = await store.create({ workflowId: d.id, workflowVersion: 1, params: {} });
    const before = JSON.stringify(await store.get(run.id));
    await expect(
      executeEngineStep(store, d, { runId: run.id, step: 'a', run: await store.get(run.id) }),
    ).rejects.toBeInstanceOf(WorkflowError);
    expect(JSON.stringify(await store.get(run.id))).toBe(before);
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
    const { run } = await store.create({ workflowId: d.id, workflowVersion: 1, params: {} });
    await executeChain(store, d, { runId: run.id, command: 'a', input: {}, dispatcher: disp });
    // (a) red when the dispatcher is skipped for the named agent step or called for chained steps; (b) prints the calls.
    expect(calls).toEqual(['a']);
    const { run: run2 } = await store.create({ workflowId: d.id, workflowVersion: 1, params: {} });
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
    const ev = (await store.get(run.id)).evidence.find((e) => e.step_id === 'a') as unknown as {
      output_summary?: unknown;
    };
    const ev2 = (await store.get(run2.id)).evidence.find(
      (e) => e.step_id === 'bare',
    ) as unknown as { output_summary?: unknown };
    expect([JSON.stringify(ev?.output_summary), JSON.stringify(ev2?.output_summary)]).toEqual([
      '{"ok":true}',
      '{}',
    ]);
  });

  it('C163 line 103: describePending says what a run waits for, with every field the row names', async () => {
    claim('`registry` may be `undefined`; `now` is required — pass `new Date()`.');
    claim(
      'Says what a run is waiting for, as an object with: `agent_steps` (the agent steps ready for an answer), `agent_refused` (the ready agent steps the run refuses before their claim, and why), `pending_guards` (the guard steps ready to be decided), `engine_runnable` (the `auto` steps it owes, each with `runnable_here`), `cannot_run` (every step that cannot run, and why),',
    );
    const d = gated();
    const { runId, gateId } = await atQuestion(d);
    const p = describePending(d, await store.get(runId), undefined, new Date());
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
    expect(describePending(d, await store.get(runId), undefined, LATER()).expiry_due).toBeDefined();
    // #729 PR-0 (D-L): what the engine owes is `owed` (it replaced `act`): the due expiry first.
    expect(describePending(d, await store.get(runId), undefined, LATER()).owed).toEqual([
      { expiry: { gate_id: gateId, step: 'q', on_expiry: 'settle_default' } },
    ]);
    expect(describePending(d, await store.get(runId), undefined, new Date()).owed).toEqual([]);
    await submitHumanResponse(store, d, { runId, gateId, choice: 'approve' });
    const owed = describePending(d, await store.get(runId), undefined, new Date());
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
      'Invalid driver.by_source: not one of stated, ambient, derived.',
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
      const before = JSON.stringify(await store.get(runId));
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
      expect(JSON.stringify(await store.get(runId))).toBe(before);
    },
  );

  it('C163 lines 129–131: a driver with values the table takes is accepted and written as driven_by on the auto step the call runs', async () => {
    claim('The name: text of 1 to 200 characters, not only spaces, with no control character.');
    claim(
      'Your own word for the way the call came in: 1 to 64 characters of `a`–`z`, `0`–`9`, `_` and `-`, such as `cron`.',
    );
    claim(
      'How the name is known: `stated` (your program says it), `ambient` (from the environment, as `REALM_OPERATOR` is) or `derived` (from the OS user).',
    );
    const plain: WorkflowDefinition = {
      id: 'dc-drv',
      name: 'p',
      version: 1,
      steps: { only: { description: 'O.', execution: 'auto', depends_on: [] } },
    };
    for (const by_source of ['stated', 'ambient', 'derived'] as const) {
      const { run } = await store.create({ workflowId: plain.id, workflowVersion: 1, params: {} });
      const r = await advanceRun(store, plain, {
        runId: run.id,
        driver: { by: 'n'.repeat(200), by_source, channel: 'a_b-9' },
      });
      expect([r.status, r.run_phase]).toEqual(['ok', 'completed']);
      const ev = (await store.get(run.id)).evidence.find(
        (e) => e.step_id === 'only',
      ) as unknown as { driven_by?: { by: string } };
      expect(ev?.driven_by?.by).toBe('n'.repeat(200));
    }
  });
});

describe('#625 PR-2a, C174 — the sweep’s corrected sentences about the library', () => {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
  const page = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\s+/g, ' ');
  let store: JsonFileStore;

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
  beforeEach(async () => {
    store = new JsonFileStore(await mkdtemp(join(tmpdir(), 'realm-dc-sweep-625-')));
  });
  async function atQuestion(d: WorkflowDefinition) {
    const { run } = await store.create({ workflowId: d.id, workflowVersion: 1, params: {} });
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
    const { run } = await store.create({ workflowId: owes.id, workflowVersion: 1, params: {} });
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
      nextCalls(composeWaysAt(await store.get(runId), new Date(), { definition: d })),
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
    const reply = await advanceRun(store, d, { runId, now: LATER() });
    // (a) red when advanceRun does not carry out the expired question first, or leaves the guard or
    //     the auto step it made owed; (b) prints the reply's fields.
    expect({
      status: reply.status,
      expiry: reply.warnings.some((w) => w.includes('this advanceRun call first carried out')),
      ran: reply.chained_auto_steps?.map((c) => c.step),
      phase: (await store.get(runId)).run_phase,
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
    // (a) red when the page's count is not the type's; (b) prints both.
    expect(page('docs/reference/run-record-and-export.md')).toContain(
      `the ${fields} fields of an evidence entry (32 rows below: two rows hold two fields each),`,
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
    const store = new JsonFileStore(await mkdtemp(join(tmpdir(), 'realm-dc-760-old-')));
    const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
    const reply = await executeChain(store, def, {
      runId: run.id,
      command: 'extract',
      registry,
      input: { text: 'x' },
      dispatcher: async (_n, i) => ({ ...i }),
    });
    const after = await store.get(run.id);
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
    const store = new JsonFileStore(await mkdtemp(join(tmpdir(), 'realm-dc-760-')));
    const { run } = await store.create({
      workflowId: def.id,
      workflowVersion: 1,
      params: { text: DOC },
    });
    await advanceRun(store, def, { runId: run.id, registry: createDefaultRegistry() });
    // Correction 2 (03, D4): the agent step's prompt carries the document, read from the record
    // after `advanceRun` ran `fetch_document` (the record as first created renders none).
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
    const after = await store.get(run.id);
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
      'Ask the model for one contiguous span copied character for character, or two spans joined by `…`; each span after the first starts where a sentence or clause of the document starts, or at a new line after a finished sentence, a finished clause or a blank line; after a full stop, a sentence starts with a capital letter.',
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
    // `realm run export` is pinned by the CLI's `docs-claims-625.test.ts` (#760 cell); `get_run_state`
    // carrying no step output by `step-view.ts`'s StepView (F760-AUD-06).
    claimOn(
      HANDLERS,
      // Correction 1 (05 item 12): the 120-character Output: cut and the whole Warn: line are
      // executed by the CLI's docs-claims-625 (#760 cell).
      "The per-value record is the step's output: read it afterwards with `realm run export <run-id>`, which writes the whole run. `get_run_state` does not carry a step's output, and `realm run inspect` prints the step's output cut at 120 characters and its warning whole, on the `Warn:` line.",
    );
  });

  it('CHANGELOG: the #760 bullets sit under [Unreleased] → Added and → Changed', () => {
    const log = raw('CHANGELOG.md');
    const start = log.indexOf('## [Unreleased]');
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
  /** The states table's row text for `state`. */
  const stateRow = (state: string): string => {
    const line = readFileSync(join(ROOT, HANDLERS), 'utf8')
      .split('\n')
      .find((l) => l.startsWith(`| \`${state}\``));
    return (line ?? '').split('|')[2]!.trim();
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
    const store = new JsonFileStore(await mkdtemp(join(tmpdir(), 'realm-dc-760-w4-')));
    const { run: created } = await store.create({
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
    const after = await store.get(created.id);
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
    }).toEqual({
      both: true,
      removed: true,
      phase: 'completed',
      failed: ['quote_check'],
      guard: 'trigger_rule_unsatisfiable',
      sealedBy: 'complete',
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
      'After each skip, the next piece starts where the document starts a sentence, a clause (after `;` or `:`) or a line. A line counts only after a blank line, or a line that ends a sentence, a clause or a table row; a clause number (`6.2`, `12.`, `(a)`, never bare digits such as `12`) or a list mark is skipped only at such a line start, and a clause number only before a capital letter or an opening mark (a quotation mark, `(` or `[`). After a full stop, `!` or `?`, on the same line or at the end of the line before, the next piece begins with a capital letter or an opening mark (a quotation mark, `(` or `[`), or starts right after one in the document; at a new line that counts, an item after a list mark (`-`, `*`, `•` …) may open with any word, and a line quoted with its own clause number before a capital letter (`2. Send…`) passes. The piece before a skip may end mid-sentence.',
    );
    // Correction 2 (03): the exact row's edges, run below (`exactMidWord`); correction 3 (03, D2):
    // the invisible character, run below (`exactInvisible`); the follow-up (§1): a format character
    // (`Cf`) only, the combining ones run by its own cell.
    expect(stateRow('exact')).toBe(
      'The quote is in the document character for character, and starts and ends at word and number edges; an invisible format character (`Cf`) inside a word, such as a soft hyphen or a zero-width space, does not make a word edge (U+FEFF excepted: the canonical form reads it as a space); some other invisible characters, the combining ones (U+034F, a variation selector), still do.',
    );
    // Correction 2 (03): the kept list, its `±` and `☒` members run below.
    expect(stateRow('reformatted')).toContain(
      'Digits, the separators between two digits, `%`, `‰`, `°`, `‱`, currency signs, every mathematical sign (`<` `>` `≤` `≥` `+` `=` `±` …), primes (`′` `″`), ballot boxes and check marks (`☐` `☒` `✓` `✗`), superscripts and fractions never are',
    );
    expect(stateRow('stitched_out_of_order')).toBe('The same, with the pieces in another order.');
    expect(stateRow('not_found')).toBe(
      'A piece is not in the document, or a part is shorter than `min_part_chars`, or locating the quote took more than 1,000 substring searches; or the value has no quote.',
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
      exactInvisible: ['not_found', 'not_found', 'reformatted'],
      plusMinus: 'not_found',
      ballot: 'not_found',
    });
  });

  it("the stitched row's abbreviations and the not_found row's 1,000 searches are the code's own (L1, A8)", () => {
    const row = stateRow('stitched');
    const listed = [...row.slice(row.indexOf('one of ')).matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
    // (a) red when the row's list and the code's differ, a listed abbreviation or an initial ends a
    //     piece, or the budget is not the row's figure; (b) prints the two lists, the abbreviations
    //     that split a quote, the initial's piece count and the budget.
    expect({
      listed,
      splits: listed.filter((a) => segmentsOf(`see ${a} the roof`).length !== 1),
      initial: segmentsOf('signed by J. Smith today').length,
      budget: QUOTE_SEARCH_BUDGET,
    }).toEqual({ listed: [...NOT_SENTENCE_ENDS], splits: [], initial: 1, budget: 1_000 });
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
      "A number written in digits is one unit: a digit never matches inside a longer number or next to a letter, and a quote never starts or ends on a number's separator or beside a group of thousands. `clause 9` is not found in `clause 9a`, `9,20` not in `9,200`, `€48` not in `€48,000`, `18` and `18.` not in `18.5`, `1 200` not in `1 200 000`, and `75%` not in `.75%`. A sign belongs to its number: `48,000` is not found in `€48,000`, and `5` not in `-5`. A number written in words is matched as words: `five hundred thousand euro` is found inside `six million five hundred thousand euro`.",
    );
    claimOn(
      HANDLERS,
      '`nearest` is where the longest piece of the quote that is in the document lies; it is absent when no whole word of the quote is found.',
    );
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
    claimOn(
      HANDLERS,
      'It prints the quote as the model gave it, cut at 80 characters, and offsets; it never prints text it read from the document.',
    );
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
      "3. `stitched`: the quote's pieces, split where it breaks (`…` or `...`, a sentence end, `;`, a `:` not between two digits, a double quotation mark or a line break), are each found whole, at word edges, and in order; pieces next to each other in `source` count as one part, and every part is at least `options.minPartChars` long (default `20`, at least `4`). After each skip, the next piece starts where the document starts a sentence, a clause (after `;` or `:`) or a line. A line counts only after a blank line, or a line that ends a sentence, a clause or a table row (`|`); a clause number (`6.2`, `12.`, `(a)`, never bare digits such as `12`) or a list mark is skipped only at such a line start, and a clause number only before a capital letter or an opening mark (a quotation mark, `(` or `[`). After a full stop, `!` or `?`, on the same line or at the end of the line before, the next piece begins with a capital letter or an opening mark (a quotation mark, `(` or `[`), or starts right after one in the document; at a new line that counts, an item after a list mark (`-`, `*`, `•` …) may open with any word, and a line quoted with its own clause number before a capital letter (`2. Send…`) passes. The piece before a skip may end mid-sentence. A quote with no break is never stitched.",
    );
    claimOn(HANDLERS, '4. `stitched_out_of_order`: the same, with the parts in another order.');
    claimOn(
      HANDLERS,
      '5. `not_found`: otherwise, with `nearest` when a piece of the quote holding a whole word is in `source`; it is absent when no whole word of the quote is found.',
    );
    claimOn(
      HANDLERS,
      "with every dash and hyphen read as `-` (two hyphens outside the Basic Multilingual Plane excepted; a soft hyphen is not a dash: it is invisible, and makes no word edge), every punctuation mark and quotation mark dropped and spaces collapsed, keeping letters, digits, `%`, `‰`, `°`, `‱`, currency signs, every mathematical sign (`<` `>` `≤` `≥` `+` `=` `±` …), primes (`′` `″`), ballot boxes and check marks (`☐` `☒` `✓` `✗`), superscripts and fractions (never folded into digits), a `-` directly before a digit, a `.` or `,` directly before a digit that follows no letter or digit, and the separators between two digits. A number written in digits is one unit: a digit never matches inside a longer number of `source`, or next to its letters, and a quote never starts or ends on a number's separator or beside a group of thousands.",
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
      // The follow-up (§4): the rule, and where its exceptions are listed (its own cell runs them).
      'A quote may skip document text only where it breaks (at `…` or `...`, a sentence end, `;`, a `:` not between two digits, a double quotation mark or a line break), and by the rule only to where the document starts a sentence, a clause or a line; the handlers reference lists where a crafted quote can still land elsewhere ("What `check_quotes` does not catch").',
    );
    claimOn(
      CL,
      // Correction 3 (03, D2): rule rev 3, run by locate-quote.test.ts's "correction 3, 01" cells.
      // The follow-up (§1): the capital condition as the code reads it, run by its own cell.
      'A line counts only after a blank line, or a line that ends a sentence, a clause or a table row, so text whose lines break inside sentences is read correctly; a clause number or a list mark is skipped only at such a line start, and after a full stop the next piece must begin with a capital letter or an opening mark (a quotation mark, `(` or `[`), or start right after one in the document; at a new line that counts, an item after a list mark (`-`, `*`, `•` …) may open with any word, and a line quoted with its own clause number before a capital letter (`2. Send…`) passes.',
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
      "A number written in digits is one unit: a digit never matches inside a longer number or next to a letter, and a quote never starts or ends on a number's separator or beside a group of thousands. A sign belongs to its number. A number written in words is matched as words.",
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
      'A clause joined to a later sentence: the piece before a skip may end mid-sentence.',
      'A number written in words, matched as words: `five hundred thousand euro` is found inside `six million five hundred thousand euro`.',
      'A true quote that stops before its sentence ends is found. It is marked `cut_short` only when the quote ends with its own `.`, `!` or `?`.',
      'An abbreviation the check does not know, followed by a capitalised word (`a.m. Monday`, `excl. VAT`): a skip may land there.',
      'A grouped amount written with a letter prefix (`500 euro` in `EUR2 500 euro`), and a middle-dot decimal (`·5`).',
      // The follow-up (§2): which enclosed letters read as letters, run by its own cell.
      'Combining marks read as the letters they carry (`n̶o̶t̶` reads `not`), and so do circled, squared and parenthesised letters (`ⓃⓄⓉ` reads `not`). Negative squared and negative circled letters (`🅽🅾🆃`, `🅝🅞🅣`) and regional indicators are set aside like other symbols, so a quote reads found whether it carries them or leaves them out.',
      'Symbols other than the kept ones (bullets, emoji) are set aside.',
      'U+FEFF inside a word reads `reformatted`, since the canonical form reads it as a space.',
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
        state('The Tenant shall n̶o̶t̶ pay the Rent', 'The Tenant shall not pay the Rent late.'),
        state(
          'The Landlord shall 🅽🅾🆃 insure the Building',
          'The Landlord shall insure the Building.',
        ),
      ],
      symbols: [
        state(
          'The Tenant shall pay the Rent and keep the Premises',
          'The Tenant shall pay the Rent ■ and keep the Premises',
        ),
        state('⭐ The Tenant may keep pets', '🔥 The Tenant may keep pets'),
      ],
      feff: state('lawful use of the Premises', `any un${ch(0xfeff)}lawful use of the Premises`),
    }).toEqual({
      joinedClause: 'stitched',
      words: 'exact',
      stopsShort: ['exact', false, 'exact', true],
      abbreviations: ['stitched', 'stitched'],
      amounts: ['exact', 'reformatted'],
      marks: ['reformatted', 'reformatted'],
      symbols: ['reformatted', 'reformatted'],
      feff: 'reformatted',
    });
  });

  it('what reads not found although it is honest — each bullet run', () => {
    for (const sentence of [
      'A quote that skips into the middle of a sentence, with or without `…`.',
      'A skip onto a sentence that opens with a digit, a currency sign, a lowercase word (`iPhones…`), or a script with no capital letters.',
      'A skip onto a clause number in the middle of a line after a sentence end.',
      'A zero-width space used as the only separator between two words.',
      'A skip onto a new line, a list item included, after a line that ends mid-sentence, or onto a line under a heading with no stop.',
      'A sentence after a no-break space or a form feed; a sentence after a footnote marker; a tab-separated row with no stop; the bullets `●`, U+F0B7 and `>`; the labels `a)`, `A)` and `A.`; `Ltd.`, `Inc.` or `etc.` ending a sentence; `Schedule A.` (read as an initial); a bullet in the middle of a line after a sentence end.',
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
      ['after a no-break space', ...skipTo(`.${ch(0xa0)}`, CAPITAL)],
      ['after a form feed', ...skipTo(`.${ch(0x0c)}`, CAPITAL)],
      ['after a footnote marker', ...skipTo('.¹ ', CAPITAL)],
      [
        'a tab-separated row with no stop',
        'Rent\tforty-eight thousand euro a year … Service Charge\tnine thousand two hundred euro',
        'Rent\tforty-eight thousand euro a year\nDeposit\ttwenty-four thousand euro\nService Charge\tnine thousand two hundred euro',
      ],
      ['the bullet ●', ...skipTo(':\n● ', CAPITAL)],
      ['the bullet U+F0B7', ...skipTo(`:\n${ch(0xf0b7)} `, CAPITAL)],
      ['the bullet >', ...skipTo(':\n> ', CAPITAL)],
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
      zeroWidth: state('the Tenant', `the Tenant${ch(0x200b)}shall pay`),
    }).toEqual({ found: [], zeroWidth: 'not_found' });
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
  const flatten = (t: string) => t.replace(/\s+/g, ' ');
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
      .split('|')[2]!
      .trim();
  const state = (quote: string, source: string) => locateQuote(quote, source).state;
  const ch = String.fromCodePoint;
  const F = 'The Landlord shall insure the Building';
  /** A skip from F onto `second`, the document joining them with `join`. */
  const skipTo = (join: string, second: string, quoted = second): [string, string] => [
    `${F} … ${quoted}`,
    `${F} for its full reinstatement cost${join}${second} at the end of each year.`,
  ];

  it('§1 the exact row: a format character (`Cf`) inside a word makes no word edge; a combining one (U+034F, a variation selector) still does', () => {
    expect(stateRow('exact')).toContain(
      'an invisible format character (`Cf`) inside a word, such as a soft hyphen or a zero-width space, does not make a word edge (U+FEFF excepted: the canonical form reads it as a space); some other invisible characters, the combining ones (U+034F, a variation selector), still do.',
    );
    const inside = (code: number) =>
      state(
        'lawful use of the Premises',
        `The Tenant shall not permit any un${ch(code)}lawful use of the Premises.`,
      );
    // (a) red when a soft hyphen makes an edge, or the stated gap closes (a combining invisible
    //     no longer makes one: then the row's last clause is false); (b) prints the three states.
    expect([inside(0xad), inside(0x034f), inside(0xfe0f)]).toEqual(['not_found', 'exact', 'exact']);
  });

  it('§1 the capital condition: an opening mark (a quotation mark, `(` or `[`), or right after one in the document; a list item may open with any word; `2. Send…` passes', () => {
    const sentence = flatten(
      'the next piece begins with a capital letter or an opening mark (a quotation mark, `(` or `[`), or starts right after one in the document; at a new line that counts, an item after a list mark (`-`, `*`, `•` …) may open with any word, and a line quoted with its own clause number before a capital letter (`2. Send…`) passes.',
    );
    // The stitched row and rule 3 both say it. (a) red when either loses it; (b) prints the count.
    expect(flatten(raw(HANDLERS)).split(sentence).length - 1).toBe(2);
    claimOn(
      HANDLERS,
      'a clause number only before a capital letter or an opening mark (a quotation mark, `(` or `[`).',
    );
    claimOn(
      CL,
      'after a full stop the next piece must begin with a capital letter or an opening mark (a quotation mark, `(` or `[`), or start right after one in the document;',
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

  it('§2 can still read found: a blank line inside a sentence, or a header between blank lines', () => {
    claimOn(
      HANDLERS,
      'A blank line inside a sentence, or a header between blank lines, counts as a line start, as at a PDF page break: a skip may land on the words after it.',
    );
    const rest =
      'not be responsible for repairs to the structure, roof, foundations or exterior of the Building';
    const doc = (between: string) =>
      `${F} for its full reinstatement cost. The Tenant shall${between}${rest}.`;
    // (a) red when the gap closes (the bullet would then be false); (b) prints the three states.
    expect([
      state(`${F} … ${rest}`, doc('\n\n')),
      state(`${F} … ${rest}`, doc('\n\nLease of Office Premises — page 4\n\n')),
      state(`${F} … ${rest}`, doc('\f')),
    ]).toEqual(['stitched', 'stitched', 'not_found']);
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

  it('§2 can still read found: an invisible format character inside a number, or between a sign and its number', () => {
    claimOn(
      HANDLERS,
      'An invisible format character inside a number, or between a sign and its number, so part of the number reads found: `12` in a `12500` with a soft hyphen after `12`, and `5` in a `-5` with a zero-width space after the sign.',
    );
    // (a) red when the gap closes, or the plain number stops being one unit; (b) prints the states.
    expect([
      state('the fee is 12', `the fee is 12${ch(0xad)}500 euro`),
      state('5 degrees', `-${ch(0x200b)}5 degrees`),
      state('the fee is 12', 'the fee is 12500 euro'),
      state('5 degrees', '-5 degrees'),
    ]).toEqual(['reformatted', 'reformatted', 'not_found', 'not_found']);
  });

  it("§2 can still read found: contractions in capitals, with another apostrophe, misspelled, or cut at the start; `can` is not found in `can't` or `can’t`", () => {
    claimOn(
      HANDLERS,
      "A contraction written in capitals, with another apostrophe, misspelled, or cut at its start: `CAN` is found in `CAN'T`, `can` in `can´t` and `can' t`, `did` in `did'nt`, and `t make` in `won't make`. A lowercase `can` is not found in `can't` or `can’t`.",
    );
    // (a) red when one of these changes (a gap closed, or the rule that holds broken); (b) prints the
    //     states.
    expect({
      found: [
        state('THE LANDLORD CAN', "THE LANDLORD CAN'T REFUSE CONSENT."),
        state('The Landlord can', 'The Landlord can´t refuse consent.'),
        state('The Landlord can', "The Landlord can' t refuse consent."),
        state('The Tenant did', "The Tenant did'nt pay."),
        state('t make structural alterations.', "The Tenant won't make structural alterations."),
      ],
      holds: [
        state('The Landlord can', "The Landlord can't refuse consent."),
        state('The Landlord can', 'The Landlord can’t refuse consent.'),
      ],
    }).toEqual({
      found: ['exact', 'exact', 'exact', 'exact', 'exact'],
      holds: ['not_found', 'not_found'],
    });
  });

  it('§2 can still read found: a quote that starts or ends at a hyphen breaking a word across a line', () => {
    claimOn(
      HANDLERS,
      "A quote that starts or ends at a hyphen breaking a word across a line: `paid` is found in `un-` at a line's end followed by `paid`.",
    );
    // (a) red when the gap closes; (b) prints the two states.
    expect([
      state(
        'paid twenty-one (21) days after becoming payable',
        'If any Rent is un-\npaid twenty-one (21) days after becoming payable.',
      ),
      state('The Landlord can', 'The Landlord can-\nnot refuse.'),
    ]).toEqual(['exact', 'exact']);
  });

  it('§2 can still read found: `U.S.` or `U.S.A.` before a capital letter is read as a sentence end', () => {
    claimOn(
      HANDLERS,
      '`U.S.` or `U.S.A.` followed by a capital letter is read as a sentence end: a skip may land there.',
    );
    const capital = 'Capital rules apply to the Tenant at all times';
    // (a) red when the gap closes, or an initial starts ending a sentence; (b) prints the states.
    expect([
      state(...skipTo(' in the U.S. ', capital)),
      state(...skipTo(' in the U.S.A. ', capital)),
      state(...skipTo(' by J. ', 'Smith shall pay the insurance rent at once')),
    ]).toEqual(['stitched', 'stitched', 'not_found']);
  });

  it('§2 can still read found: a group of thousands spaced with U+2007, U+2008 or U+3000, and a `:` at a line end before a digit', () => {
    claimOn(
      HANDLERS,
      "A group of thousands spaced with U+2007, U+2008 or U+3000 (`1 200` is found in such a `1 200 000`), and a `:` at a line's end before a digit (`at 9:` ending a line and `30` starting the next): a skip may land on the digit.",
    );
    const grouped = (space: number) =>
      state(`the rent is 1${ch(space)}200`, `the rent is 1${ch(space)}200${ch(space)}000 euro`);
    // (a) red when one of these gaps closes, or a plain group space stops being one number; (b)
    //     prints the states.
    expect({
      groups: [grouped(0x2007), grouped(0x2008), grouped(0x3000), grouped(0x20)],
      colon: state(
        `${F} … 30 minutes before the Tenant arrives at the Building`,
        `${F} for its cost at 9:\n30 minutes before the Tenant arrives at the Building.`,
      ),
    }).toEqual({ groups: ['exact', 'exact', 'exact', 'not_found'], colon: 'stitched' });
  });

  it('§2 the enclosed letters: circled, squared and parenthesised read as letters; negative squared and circled letters and regional indicators are set aside', () => {
    claimOn(
      HANDLERS,
      'Combining marks read as the letters they carry (`n̶o̶t̶` reads `not`), and so do circled, squared and parenthesised letters (`ⓃⓄⓉ` reads `not`). Negative squared and negative circled letters (`🅽🅾🆃`, `🅝🅞🅣`) and regional indicators are set aside like other symbols, so a quote reads found whether it carries them or leaves them out.',
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

  it('§2 `cut_short`: a quote that carries a trailing space after its stop is not marked', () => {
    claimOn(
      HANDLERS,
      "A quote that ends a sentence where the document's sentence goes on is marked `cut_short`, with where; the reviewer reads the rest. A quote that carries a trailing space after its stop is not marked.",
    );
    claimOn(
      CL,
      "A quote that ends a sentence where the document's goes on is marked `cut_short`, with `cut_short_at`; a quote that carries a trailing space after its stop is not marked.",
    );
    const doc = 'The area is not less than approx. 412 square metres.';
    const marked = (q: string) => {
      const r = locateQuote(q, doc);
      return [r.state, r.cut_short === true];
    };
    // (a) red when the space case gets the label (the sentence would then be false; its code fix is
    //     #845's), or the stop case loses it; (b) prints the states and labels.
    expect([
      marked('The area is not less than approx.'),
      marked('The area is not less than approx. '),
    ]).toEqual([
      ['exact', true],
      ['exact', false],
    ]);
  });

  it('§2 honest refusals: a skip past a lettered or numbered label onto a lowercase first word; quoting the label too reads stitched', () => {
    claimOn(
      HANDLERS,
      'A skip past a lettered or numbered label onto a lowercase first word (`… keep the Premises` after `(b)`); quoting the label as well (`(b) keep the Premises…`) reads `stitched`.',
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
    claimOn(
      HANDLERS,
      'A page header crossed without `…`, and a whole word quoted across a hyphen that breaks it over a line (`substantial` across `sub-` ending a line and `stantial` starting the next).',
    );
    const page = `${F} for its full reinstatement cost. The Tenant shall\n\nLease of Office Premises — page 4\n\nnot be responsible for repairs to the structure.`;
    // (a) red when one of these reads found (its bullet would then be false), or the page header with
    //     `…` is refused; (b) prints the states.
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
      headerSkipped: 'stitched',
      hyphenWord: ['not_found', 'not_found'],
    });
  });

  it('§4 the CHANGELOG states the skip rule and points at the docs’ list of exceptions', () => {
    claimOn(
      CL,
      'and by the rule only to where the document starts a sentence, a clause or a line; the handlers reference lists where a crafted quote can still land elsewhere ("What `check_quotes` does not catch").',
    );
    // (a) red when the list it points at is gone or renamed; (b) prints a boolean.
    expect(raw(HANDLERS).includes('\n#### What `check_quotes` does not catch\n')).toBe(true);
  });

  it("§4 the example workflow's agent prompt gives the prose's quoting instruction, word for word", () => {
    const prose =
      'Ask the model for one contiguous span copied character for character, or two spans joined by `…`; each span after the first starts where a sentence or clause of the document starts, or at a new line after a finished sentence, a finished clause or a blank line; after a full stop, a sentence starts with a capital letter.';
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
