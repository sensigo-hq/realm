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
      'After each skip, the next piece starts where the document starts a sentence, a clause (after `;` or `:`) or a line. A line counts only after a blank line, or a line that ends a sentence, a clause or a table row; a clause number (`6.2`, `12.`, `(a)`, never bare digits such as `12`) or a list mark is skipped only at such a line start, and a clause number only before a capital letter or an opening mark (`"` `“` `„` `«` `\'` `‘` `(` `[`). After a full stop, `!` or `?`, on the same line or at the end of the line before, the next piece begins with a capital letter or an opening mark (`"` `“` `„` `«` `\'` `‘` `(` `[`), or starts right after one in the document; at a new line that counts, an item after a list mark (`-` `*` `•` `◦` `▪` `‣` `·` `–` `—` `|`, or a run of `#`) may open with any word, and a line quoted with its own clause number before a capital letter (`2. Send…`) passes. The piece before a skip may end mid-sentence.',
    );
    // Correction 2 (03): the exact row's edges, run below (`exactMidWord`); correction 3 (03, D2):
    // the invisible character, run below (`exactInvisible`); the follow-up (§1): a format character
    // (`Cf`) only, the combining ones run by its own cell. The language unit re-pin (§5.1): a combining
    // mark makes no word edge either, and a quote never splits a letter from its visible mark — run
    // by locate-quote-language-0480.test.ts's §3 cells (Thai `ไม` in `ไม้`, the 263-mark sweep, the
    // `the Tenant` control).
    expect(stateRow('exact')).toBe(
      'The quote is in the document character for character, and starts and ends at word and number edges; an invisible format character (`Cf`) inside a word, such as a soft hyphen or a zero-width space, does not make a word edge (U+FEFF excepted: the canonical form reads it as a space), and neither does a combining mark, visible or not (an accent, U+034F, a variation selector); the quote never starts or ends between a letter and a visible mark on it.',
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
      'A number written in digits is one unit: a digit never matches inside a longer number or next to a letter, and a quote never starts or ends on a number\'s separator or beside a group of thousands. `clause 9` is not found in `clause 9a`, `9,20` not in `9,200`, `€48` not in `€48,000`, `18` and `18.` not in `18.5`, `1 200` not in `1 200 000`, and `75%` not in `.75%`. A currency or mathematical sign, or a dash, written right before a number belongs to it (the exceptions are listed under "What `check_quotes` does not catch"): `48,000` is not found in `€48,000`, and `5` not in `-5`. A number written in words is matched as words: `five hundred thousand euro` is found inside `six million five hundred thousand euro`.',
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
      "3. `stitched`: the quote's pieces, split where it breaks (`…` or `...`, a sentence end, `;`, a `:` not between two digits, a double quotation mark or a line break), are each found whole, at word edges, and in order; pieces next to each other in `source` count as one part, and every part is at least `options.minPartChars` long (default `20`, at least `4`). After each skip, the next piece starts where the document starts a sentence, a clause (after `;` or `:`) or a line. A line counts only after a blank line, or a line that ends a sentence, a clause or a table row (`|`); a clause number (`6.2`, `12.`, `(a)`, never bare digits such as `12`) or a list mark is skipped only at such a line start, and a clause number only before a capital letter or an opening mark (`\"` `“` `„` `«` `'` `‘` `(` `[`). After a full stop, `!` or `?`, on the same line or at the end of the line before, the next piece begins with a capital letter or an opening mark (`\"` `“` `„` `«` `'` `‘` `(` `[`), or starts right after one in the document; at a new line that counts, an item after a list mark (`-` `*` `•` `◦` `▪` `‣` `·` `–` `—` `|`, or a run of `#`) may open with any word, and a line quoted with its own clause number before a capital letter (`2. Send…`) passes. The piece before a skip may end mid-sentence. A quote with no break is never stitched.",
    );
    claimOn(HANDLERS, '4. `stitched_out_of_order`: the same, with the parts in another order.');
    claimOn(
      HANDLERS,
      '5. `not_found`: otherwise, with `nearest` when a piece of the quote holding a whole word is in `source`; it is absent when no whole word of the quote is found.',
    );
    // The language unit re-pin (§5.3): a letter keeps its visible marks; the Arabic and Hebrew vowel
    // marks a quote leaves out — run by locate-quote-language-0480.test.ts's §2 and §4 cells.
    claimOn(
      HANDLERS,
      "with every dash and hyphen read as `-` (two hyphens outside the Basic Multilingual Plane excepted; a soft hyphen is not a dash: it is invisible, and makes no word edge), every punctuation mark and quotation mark dropped and spaces collapsed, keeping letters with their visible combining marks (a mark is part of its letter, so a quote must carry it; an Arabic or Hebrew vowel mark a quote leaves out is optional, and one it writes must match), digits, `%`, `‰`, `°`, `‱`, currency signs, every mathematical sign (`<` `>` `≤` `≥` `+` `=` `±` …), primes (`′` `″`), ballot boxes and check marks (`☐` `☒` `✓` `✗`), superscripts and fractions (never folded into digits), a `-` directly before a digit, a `.` or `,` directly before a digit that follows no letter or digit, and the separators between two digits. A number written in digits is one unit: a digit never matches inside a longer number of `source`, or next to its letters, and a quote never starts or ends on a number's separator or beside a group of thousands.",
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
      "An abbreviation that is not on the check's list (`e.g.`, `i.e.`, `etc.`, `No.`, `Nos.`, `cl.`, `para.`, `Sch.`, `Ltd.`, `Co.`, `Inc.`, `St.`, `Mr.`, `Mrs.`, `Ms.`, `Dr.`, and an initial), before a capital letter or an opening mark, is read as a sentence end (`a.m. Monday`, `excl. VAT`, `U.S. The`, `U.K. The`, `U.S.A. The`, `U.S. (the`): a skip may land there.",
      'A grouped amount written with a letter prefix (`500 euro` in `EUR2 500 euro`), and a middle-dot decimal (`·5`).',
      // The follow-up (§2): which enclosed letters read as letters, run by its own cell. The language
      // unit re-pin (§5.2): a mark on a letter stays with it, so the bullet keeps marks on digits and
      // signs only (#845's 2.1 drops them).
      'A combining mark on a digit or a sign is set aside (`5 degrees` reads found in `-́5 degrees`), and circled, squared and parenthesised letters read as letters (`ⓃⓄⓉ` reads `not`). Negative squared and negative circled letters (`🅽🅾🆃`, `🅝🅞🅣`) and regional indicators are set aside like other symbols, so a quote reads found whether it carries them or leaves them out.',
      'Symbols other than the kept ones (bullets, emoji) are set aside.',
      'A quote that starts or ends at a U+FEFF inside a word reads `reformatted` (`lawful use` in `un`, U+FEFF, `lawful use`), since the canonical form reads it as a space.',
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
        // the language unit re-pin: the bullet's own example (was `n̶o̶t̶`, which reads not_found now)
        state('5 degrees', 'The reading is -́5 degrees today.'),
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
      'A sentence after a no-break space or a form feed; a sentence after a footnote marker; a tab-separated row with no stop; a skip past the labels `a)`, `A)` and `A.`, which are not read as clause numbers; `Ltd.`, `Inc.` or `etc.` ending a sentence; `Schedule A.` (read as an initial); a bullet in the middle of a line after a sentence end.',
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
      'an invisible format character (`Cf`) inside a word, such as a soft hyphen or a zero-width space, does not make a word edge (U+FEFF excepted: the canonical form reads it as a space), and neither does a combining mark, visible or not (an accent, U+034F, a variation selector); the quote never starts or ends between a letter and a visible mark on it.',
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
    const sentence = flatten(
      'the next piece begins with a capital letter or an opening mark (`"` `“` `„` `«` `\'` `‘` `(` `[`), or starts right after one in the document; at a new line that counts, an item after a list mark (`-` `*` `•` `◦` `▪` `‣` `·` `–` `—` `|`, or a run of `#`) may open with any word, and a line quoted with its own clause number before a capital letter (`2. Send…`) passes.',
    );
    // The stitched row and rule 3 both say it. (a) red when either loses it; (b) prints the count.
    expect(flatten(raw(HANDLERS)).split(sentence).length - 1).toBe(2);
    claimOn(
      HANDLERS,
      'a clause number only before a capital letter or an opening mark (`"` `“` `„` `«` `\'` `‘` `(` `[`).',
    );
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
      'An invisible format character (`Cf`) inside a number, between a leading decimal point and its digits, or between a dash and its number (every dash reads as `-`), so part of the number reads found: `12` in a `12500` with a soft hyphen after `12`, `75%` in a `.75%` with a zero-width space after the `.`, and `5` in a `-5` with a zero-width space after the `-`. U+FEFF reads as a space, so `12` is not found in `12`, U+FEFF, `500`, which reads as a group of thousands. After `€`, `$`, `+`, `±` or `<` the number is not found, except across U+FEFF, which reads as a space: `48,000` is found in `€`, U+FEFF, `48,000`.',
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

  it("§2 can still read found: an abbreviation not on the check's list, before a capital letter or an opening mark, is read as a sentence end (every member: #855's correction §4)", () => {
    // #855's correction (§4): `:396`'s `U.S.` sentence merged into the abbreviation bullet.
    claimOn(
      HANDLERS,
      "An abbreviation that is not on the check's list (`e.g.`, `i.e.`, `etc.`, `No.`, `Nos.`, `cl.`, `para.`, `Sch.`, `Ltd.`, `Co.`, `Inc.`, `St.`, `Mr.`, `Mrs.`, `Ms.`, `Dr.`, and an initial), before a capital letter or an opening mark, is read as a sentence end (`a.m. Monday`, `excl. VAT`, `U.S. The`, `U.K. The`, `U.S.A. The`, `U.S. (the`): a skip may land there.",
    );
    const capital = 'Capital rules apply to the Tenant at all times';
    // (a) red when the gap closes, or an initial starts ending a sentence; (b) prints the states.
    expect([
      state(...skipTo(' in the U.S. ', capital)),
      state(...skipTo(' in the U.S.A. ', capital)),
      state(...skipTo(' by J. ', 'Smith shall pay the insurance rent at once')),
    ]).toEqual(['stitched', 'stitched', 'not_found']);
  });

  it('§2 can still read found: a group of thousands spaced with any space but the four group spaces (U+2007, U+2002, U+3000 …), and a `:` at a line end before a digit', () => {
    // #855's correction (§5, M2): the space sentence names the four; every `Zs` runs in its own cell.
    claimOn(
      HANDLERS,
      'A group of thousands spaced with any space but a plain space, a no-break space (U+00A0), a thin space (U+2009) or a narrow no-break space (U+202F) — such as U+2007, U+2002 or U+3000: `1 200` written with the same space is found in `1 200 000` written with one of them.',
    );
    claimOn(
      HANDLERS,
      "A `:` at a line's end before a digit (`at 9:` ending a line and `30` starting the next): a skip may land on the digit.",
    );
    const grouped = (space: number) =>
      state(`the rent is 1${ch(space)}200`, `the rent is 1${ch(space)}200${ch(space)}000 euro`);
    // (a) red when one of these gaps closes, or a plain group space stops being one number; (b)
    //     prints the states.
    expect({
      groups: [grouped(0x2007), grouped(0x2002), grouped(0x2008), grouped(0x3000), grouped(0x20)],
      colon: state(
        `${F} … 30 minutes before the Tenant arrives at the Building`,
        `${F} for its cost at 9:\n30 minutes before the Tenant arrives at the Building.`,
      ),
    }).toEqual({ groups: ['exact', 'exact', 'exact', 'exact', 'not_found'], colon: 'stitched' });
  });

  it('§2 the enclosed letters: circled, squared and parenthesised read as letters; negative squared and circled letters and regional indicators are set aside', () => {
    // The language unit re-pin (§5.2): the sentence's first clause names marks on digits and signs.
    claimOn(
      HANDLERS,
      'A combining mark on a digit or a sign is set aside (`5 degrees` reads found in `-́5 degrees`), and circled, squared and parenthesised letters read as letters (`ⓃⓄⓉ` reads `not`). Negative squared and negative circled letters (`🅽🅾🆃`, `🅝🅞🅣`) and regional indicators are set aside like other symbols, so a quote reads found whether it carries them or leaves them out.',
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

  it("§2 `cut_short`: an `exact` quote is marked when its last character is its stop and the document goes on with a lowercase letter or a digit, not when the quote carries a space after it (every member: #855's correction §1)", () => {
    claimOn(
      HANDLERS,
      "A quote that ends a sentence where the document's sentence goes on is marked `cut_short`, with where; the reviewer reads the rest. An `exact` quote is marked when its last character is its `.`, `!` or `?` and the document, past the closing marks `\"` `'` `)` `]` `}` `»` `’` `”`, plain spaces and tabs, goes on with a lowercase letter or a digit (`approx. 412`); any other whitespace there, a `\\p{Ll}` or `\\p{Nd}` character outside the Basic Multilingual Plane, or whitespace the quote carries after its stop, leaves it unmarked. In every other state, the mark falls at each `.`, `!` or `?` inside the quote, but the dots of `...`, that whitespace or the quote's end follows, unless it ends an abbreviation on the check's list or an initial, where the document has no stop and does not end its line or its text there; a space, tab or line break the quote carries changes nothing.",
    );
    // the owner's word, 2026-10-24 ("i agree"): a `.` right after `…` is no sentence end inside a
    // quote — the `…` run takes it (locate-quote.ts, `segmentsWithin`); its row: B1 and M5
    claimOn(
      CL,
      "A quote that ends a sentence where the document's goes on is marked `cut_short`, with `cut_short_at`; an `exact` quote is marked when its last character is its `.`, `!` or `?` and the document goes on, past the closing marks `\"` `'` `)` `]` `}` `»` `’` `”`, U+0020 and U+0009, with a lowercase letter (`\\p{Ll}`) or a digit (`\\p{Nd}`) of the Basic Multilingual Plane, and every other state at each `.`, `!` or `?` inside the quote, but the dots of `...` and a `.` right after `…`, that whitespace (`\\s`) or the quote's end follows, unless it ends an abbreviation on the check's list or an initial, where the document has no stop and goes on. The handlers reference lists what a crafted quote can still get read as found, and what an honest quote is still refused (\"What `check_quotes` does not catch\").",
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

  it("§2 honest refusals: a skip past a clause number onto a lowercase first word; quoting the label too reads stitched after `:` (every member: #855's correction §2)", () => {
    claimOn(
      HANDLERS,
      'A skip past a clause number onto a lowercase first word (`… keep the Premises` after `(b)`); quoting the label as well reads `stitched` after a line that ends with `;` or `:`, or after a blank line; after a line that ends a sentence, a label that opens with an opening mark or a capital letter does (`(b) keep…`, `A) keep…`, `IV. keep…`), and one that opens with a digit needs a capital letter or an opening mark after it (`2. Send…`). `b.` and `a)` are not read as labels.',
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
      'A page header crossed without `…`, joined with a space; a quote that keeps the line break, or skips the header with `…`, reads `stitched` only when a blank line follows the header, or the header ends with `;`, `:` or `|`, or ends a sentence and the line after it opens with a capital letter, an opening mark, a list mark or a run of U+0023; a line that opens with `;` or `:` reads `stitched` after any header, since a clause starts there.',
    );
    claimOn(
      HANDLERS,
      'A whole word quoted across a hyphen that breaks it over a line (`substantial` across `sub-` ending a line and `stantial` starting the next).',
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
  /** `\p{Cf}`, the class `FORMAT` (`locate-quote.ts:304`) reads, every plane. */
  const CF = codePoints(/^\p{Cf}$/u);
  /** `isDash` (`locate-quote.ts:98-101`): every BMP `\p{Pd}`, and these three, copied. */
  const DASH_ADDED = [0x2212, 0x2796, 0x02d7];
  const DASHES = [...codePoints(/^\p{Pd}$/u, 0, BMP), ...DASH_ADDED];
  /** U+207B and U+208B read as a minus: NFKC makes them U+2212. */
  const NFKC_MINUS = [0x207b, 0x208b];
  /** Every BMP `\p{Sc}` and `\p{Sm}`: `isNumberSymbol`'s `CURRENCY` and `MATH` (`:157`). */
  const SIGNS = codePoints(/^[\p{Sc}\p{Sm}]$/u, 0, BMP);
  /** The minus signs among `SIGNS`, which the check reads as a dash. */
  const MINUS = [0x2212, ...NFKC_MINUS];
  /** Every `\s` (`SPACE`, `locate-quote.ts:140`), every plane. */
  const WS = codePoints(/^\s$/u);
  /** `START_OPENING` (`locate-quote.ts:660`), copied: the code does not export it. */
  const OPENING = ['"', '“', '„', '«', "'", '‘', '(', '['].map(cp);
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
  /** A glossary row's listed members: its `U+XXXX` entries. */
  const glossaryCodes = (word: string): number[] =>
    [...(GLOSSARY.get(word) ?? '').matchAll(/U\+([0-9A-F]{4,6})/g)].map((m) => parseInt(m[1]!, 16));
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
      // `exact` (`exactGoesOn`): the quote's last character is its stop; past closing marks, spaces and
      // tabs, the document goes on with a lowercase letter or a digit.
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
      [
        'exact, a no-break space before the digit',
        read(approx, at('\u00a0412 square metres.')),
        'exact',
      ],
      [
        'exact, a line break before a lowercase word',
        read(`${rent}.`, `${rent}.\nand more on demand.`),
        'exact',
      ],
      [
        'exact, the quote carries a space after its stop',
        read(`${approx} `, at(' 412 square metres.')),
        'exact',
      ],
      [
        'exact, the quote carries a tab (the document too)',
        read(`${approx}\t`, at('\t412 square metres.')),
        'exact',
      ],
      [
        'exact, the quote carries a line break (the document too)',
        read(`${approx}\n`, at('\n412 square metres.')),
        'exact',
      ],
      [
        'the quote carries a tab, the document a space',
        read(`${approx}\t`, at(' 412 square metres.')),
        'reformatted',
      ],
      [
        'the quote carries a line break, the document a space',
        read(`${approx}\n`, at(' 412 square metres.')),
        'reformatted',
      ],
      // Every other state (`sentenceGoesOn`): at each sentence end inside the quote where the document
      // has no stop and does not end its line or its text.
      ['reformatted, the document has no stop (B1)', read(`${rent}.`, d1), 'reformatted+cut_short'],
      ['reformatted, `!`', read(`${rent}!`, d1), 'reformatted+cut_short'],
      ['reformatted, `?`', read(`${rent}?`, d1), 'reformatted+cut_short'],
      [
        'reformatted, an inner stop',
        read('the tenant shall pay the rent. on demand and promptly', d1),
        'reformatted+cut_short',
      ],
      [
        'reformatted, the document has the same stop',
        read('the area is not less than approx.', at(' 412 square metres.')),
        'reformatted',
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
    // (1) red when `exactGoesOn` accepts a capital (the capital row), or either test moves; (2) prints
    // each differing row's label and state.
    expect(misses(rows)).toEqual([]);
  });

  // ─── #855's second correction: the fifteen ─────────────────────────────────────────────────────

  it("B1 the CHANGELOG's `exact` sentence: marked only when the quote's last character is its `.`, `!` or `?`", () => {
    // The sentence is claimed by the re-pinned "§2 `cut_short` …" cell (#760 follow-up).
    const set = (stop: string) => `The fee is set${stop}`;
    const rows: Row[] = [
      // F760-855CR-01: a quote whose last character is not its stop is not marked
      [
        'a space after the stop',
        read('The fee is approx. ', 'The fee is approx. 412 euro.'),
        'exact',
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
    // (1) red when an `exact` quote whose last character is not its stop is marked, or a stop the
    //     sentence names stops marking; (2) prints each differing row's label and state.
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

  it('B2 the groups: every `Cf`; every BMP `Sc` and `Sm`, the sentence’s signs among them; and its example, `48,000` in `€`, U+FEFF, `48,000`', () => {
    // (1) red when a member is left out of an iteration, a named sign is not in its group, or the
    //     example is not found; (2) prints the members missing, the signs outside and the state.
    whole(CF, /^\p{Cf}$/u);
    whole(SIGNS, /^[\p{Sc}\p{Sm}]$/u, 0, BMP);
    expect({
      outside: ['€', '$', '+', '±', '<'].filter((s) => !SIGNS.includes(cp(s))),
      example: read('48,000 a year', `The rent is €${ch(0xfeff)}48,000 a year.`),
    }).toEqual({ outside: [], example: 'reformatted' });
  });

  it.each(CF.map((x) => [hex(x), x] as const))(
    'B2 %s between every BMP `Sc` or `Sm` and `5`: found across U+FEFF, and after a minus sign; otherwise not',
    (_, x) => {
      const rows = SIGNS.map((s): Row => [
        hex(s),
        read('5 degrees', `The reading is ${ch(s)}${ch(x)}5 degrees today.`),
        x === 0xfeff || MINUS.includes(s) ? 'reformatted' : 'not_found',
      ]);
      // (1) red when U+FEFF stops reading as a space, a minus sign stops reading as a dash, or another
      //     sign stops belonging to its number across this `Cf`; (2) prints each differing sign's code
      //     point and state.
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
    const headers: Record<string, readonly [between: string, after: string, kept: string]> = {
      'between blank lines': [`\n\n${H}\n\n`, rest, 'stitched'],
      'a blank line after it only': [`\n${H}\n\n`, rest, 'stitched'],
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

  it('S1 every dash in the Basic Multilingual Plane reads as `-`: every BMP `\\p{Pd}`, `isDash`’s additions and the NFKC minus signs; the dashes outside it do not', () => {
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
      ...outside.map((d): Row => [hex(d), minus5(d), 'not_found']),
    ];
    // #855's last commit (M7): the whole-BMP walk against the glossary's dash set is the glossary
    // describe's "a dash" rows; the copy's own check, true by construction, is gone.
    // (1) red when a member is left out of an iteration, a BMP dash stops reading as `-`, or one
    //     outside the BMP starts to; (2) prints the members missing and each differing code point and
    //     state.
    expect({
      named: [0x10d6e, 0x10ead].filter((d) => !outside.includes(d)).map(hex),
      misses: misses(rows),
    }).toEqual({ named: [], misses: [] });
  });

  it('S2 every `\\p{Zs}` space in a group of thousands: `1 200` written with the same space is found unless it is one of the group spaces; written with a plain space it is not found', () => {
    const spaces = codePoints(/^\p{Zs}$/u);
    whole(spaces, /^\p{Zs}$/u);
    /** `GROUP_SPACES` (`locate-quote.ts:134`), copied; its members are read over every `Zs` below. */
    const GROUP = [0x20, 0xa0, 0x2009, 0x202f];
    const doc = (s: number) => `the rent is 1${ch(s)}200${ch(s)}000 euro`;
    const rows: Row[] = spaces.flatMap((s): Row[] => [
      [
        `${hex(s)}, the same space`,
        read(`the rent is 1${ch(s)}200`, doc(s)),
        GROUP.includes(s) ? 'not_found' : 'exact',
      ],
      [`${hex(s)}, a plain space`, read('the rent is 1 200', doc(s)), 'not_found'],
    ]);
    // (1) red when a member is left out of the iteration, U+2009 leaves `GROUP_SPACES` (its row reads
    //     found), or a plain-space quote is found in a document grouped otherwise; (2) prints the
    //     members missing and each differing row.
    expect({
      named: [0x2007, 0x2002, 0x3000]
        .filter((s) => !spaces.includes(s) || GROUP.includes(s))
        .map(hex),
      misses: misses(rows),
    }).toEqual({ named: [], misses: [] });
  });

  it('S3 a sign or a dash written right before a number belongs to it: every BMP `Sc` and `Sm` and every dash `isDash` reads, before `5`; a dash after `5` does not; a sign outside the BMP does too, a hyphen outside it does not', () => {
    // The language unit re-pin (§5.4): the sentence names the two astral hyphens only.
    claimOn(
      HANDLERS,
      'A hyphen outside the Basic Multilingual Plane (U+10D6E, U+10EAD) does not belong to its number: `5` is found after it.',
    );
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
      // the BMP is a sign; its two hyphens (U+10D6E, U+10EAD) are no number symbols and stay `exact`
      ...astral.map((s): Row => [
        `${hex(s)} before 5`,
        before5(ch(s)),
        /^\p{Pd}$/u.test(ch(s)) ? 'exact' : 'not_found',
      ]),
    ];
    // (1) red when a member is left out of an iteration, currency signs leave `isNumberSymbol` (every
    //     `Sc` row), a dash after the number starts to bind, or a sign outside the BMP starts to;
    //     (2) prints the members missing and each differing code point and state.
    expect({
      named: [0x1e2ff, 0x11fdd, 0x10d6e, 0x10ead].filter((s) => !astral.includes(s)).map(hex),
      misses: misses(rows),
    }).toEqual({ named: [], misses: [] });
  });

  it('S3 can still read found: a sign set apart from its number by a space (`48,000` in `€ 48,000`; U+FEFF reads as a space)', () => {
    claimOn(
      HANDLERS,
      'A sign set apart from its number by a space (`48,000` in `€ 48,000`; U+FEFF reads as a space).',
    );
    const rent = (doc: string, quote = '48,000 a year') =>
      read(quote, `The rent is ${doc} a year.`);
    const rows: Row[] = [
      ['€ 48,000', rent('€ 48,000'), 'exact'],
      ['€ U+00A0 48,000', rent('€\u00a048,000'), 'exact'],
      ['€ U+202F 48,000', rent('€\u202f48,000'), 'exact'],
      ['€ U+FEFF 48,000', rent('€\ufeff48,000'), 'reformatted'],
      ['48,000 €', read('48,000', 'The rent is 48,000 € a year.'), 'exact'],
      ['€ 48.000', read('48.000', 'The rent is € 48.000 a year.'), 'exact'],
    ];
    // (1) red when a spaced sign starts to bind (the bullet would then be false); (2) prints each
    //     differing row's label and state.
    expect(misses(rows)).toEqual([]);
  });

  it('S3 the group: every `\\s` (`SPACE`, `:140`), every plane', () => {
    // (1) red when a member is left out of the iteration; (2) prints the members missing.
    whole(WS, /^\s$/u);
  });

  it.each(WS.map((w) => [hex(w), w] as const))(
    'S3 every BMP sign and every dash, then %s, then `5`: the number is found',
    (_, w) => {
      const rows = [...SIGNS, ...DASHES].map((s): Row => [
        hex(s),
        read('5', `The deposit is ${ch(s)}${ch(w)}5 of the rent.`),
        w === 0xfeff ? 'reformatted' : 'exact',
      ]);
      // (1) red when a sign set apart by this space starts to bind; (2) prints each differing sign's
      //     code point and state.
      expect(misses(rows)).toEqual([]);
    },
  );

  it('M1 past the closing marks `"` `\'` `)` `]` `}` `»` `’` `”`: an exact quote is marked past each of them, and past no other BMP `Ps` `Pi` `Pf` `Pe` or quotation mark', () => {
    /** `CLOSING` (`locate-quote.ts:963`) less `.`, which `exactGoesOn` skips (`:1018`), copied. */
    const CLOSERS = ['"', '”', '»', "'", '’', ')', ']', '}'].map(cp);
    const printed = (p: string) => {
      const t = flatten(raw(p));
      const from = t.indexOf('past the closing marks ') + 'past the closing marks '.length;
      const list = t.slice(from).split(/, (?:plain spaces and tabs|U\+0020 and U\+0009)/)[0]!;
      return [...list.matchAll(/`([^`]+)`/g)].map((m) => cp(m[1]!)).sort((a, b) => a - b);
    };
    whole(MARKS, MARK_GROUP, 0, BMP);
    const rent = 'The Tenant shall pay the Rent';
    const rows = MARKS.map((c): Row => [
      hex(c),
      read(`${rent}.`, `${rent}.${ch(c)} and more on demand.`),
      CLOSERS.includes(c) ? 'exact+cut_short' : 'exact',
    ]);
    const sorted = [...CLOSERS].sort((a, b) => a - b).map(hex);
    // (1) red when a member is left out of the iteration, `»` leaves `CLOSING` (its row reads
    //     unmarked), or a page prints another list; (2) prints the lists and each differing row.
    expect({
      handlers: printed(HANDLERS).map(hex),
      changelog: printed(CL).map(hex),
      misses: misses(rows),
    }).toEqual({ handlers: sorted, changelog: sorted, misses: [] });
  });

  it("M2 each `.`, `!` or `?` inside the quote, but the dots of `...`, that whitespace or the quote's end follows marks it, unless it ends an abbreviation on the check's list or an initial", () => {
    whole(WS, /^\s$/u);
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
      // off the list: each ends a sentence
      ...['approx.', 'U.S.'].map((a): Row => [a, abbreviation(a, a), 'reformatted+cut_short']),
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
      'An item that opens with another mark (`+`, `○`, `●`, `■`, `>`, U+F0B7), at any line start; quoting a kept sign other than a minus sign (`+`, `>`, `=` …) with the item reads `stitched` after a line ending with `;` or `:` or a blank line.',
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
    [
      'a blank line',
      'The Tenant shall pay the Rent on the usual quarter days\n\n',
      'The Tenant shall pay the Rent on the usual',
    ],
    [
      '|⏎',
      '| The Landlord shall insure the building at its own cost |\n',
      'The Landlord shall insure the building',
    ],
  ] as const)(
    'M4 every kept sign quoted with the item after %s reads `stitched`, a minus sign excepted',
    (_, before, first) => {
      const item = 'keep the Premises in good and substantial repair';
      const rows = KEPT_SIGNS.map((m): Row => [
        hex(m),
        read(`${first} … ${ch(m)} ${item}`, `${before}${ch(m)} ${item} at all times.`),
        MINUS.includes(m) ? 'not_found' : 'stitched',
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
    'M5 an initial, one capital letter: every BMP `\\p{Lu}`/`\\p{Lt}` %s',
    (_, lowers) => {
      const A = 'The Landlord shall insure the building at its own cost';
      const B = 'The Tenant shall keep the Premises in good and substantial repair';
      const after = (abbr: string) => read(`${A} … ${B}`, `${A} under ${abbr} ${B} at all times.`);
      const LOWERS = /^\p{Changes_When_Lowercased}$/u;
      const rows = CAPITALS.filter((c) => LOWERS.test(ch(c)) === lowers).map((c): Row => [
        hex(c),
        after(`${ch(c)}.`),
        // an initial ends no sentence, so the skip after it is refused
        lowers ? 'not_found' : 'stitched',
      ]);
      // (1) red when an initial with a lowercase form ends a sentence, or a capital with none stops
      //     ending one; (2) prints each differing code point and state.
      expect(misses(rows)).toEqual([]);
    },
  );

  it('M5 the group: every BMP capital; a decomposed `É` and U+1D400 end a sentence (their code half is on #845)', () => {
    whole(CAPITALS, /^[\p{Lu}\p{Lt}]$/u, 0, BMP);
    const A = 'The Landlord shall insure the building at its own cost';
    const B = 'The Tenant shall keep the Premises in good and substantial repair';
    const after = (abbr: string) => read(`${A} … ${B}`, `${A} under ${abbr} ${B} at all times.`);
    // (1) red when a member is left out of an iteration, or one of these two moves (then #845's code
    //     half has landed, and the sentence may say more); (2) prints the two states.
    expect({ decomposed: after('E\u0301.'), outside: after(`${ch(0x1d400)}.`) }).toEqual({
      decomposed: 'stitched',
      outside: 'stitched',
    });
  });

  it('§3 a dash and an invisible format character: the groups are every BMP dash `isDash` reads, the NFKC minus signs, and every `Cf`', () => {
    // (1) red when a member is left out of an iteration; (2) prints the members missing. #855's last
    // commit (M7): the additions are checked by the glossary's "a dash" rows, not against their copy.
    whole(DASHES.slice(0, -DASH_ADDED.length), /^\p{Pd}$/u, 0, BMP);
    whole(CF, /^\p{Cf}$/u);
  });

  it.each([...DASHES, ...NFKC_MINUS].map((d) => [hex(d), d] as const))(
    '§3 the dash %s, then every `Cf`, then `5`: part of the number reads found',
    (_, d) => {
      const rows = CF.map((x): Row => [
        hex(x),
        read('5 degrees', `The reading is ${ch(d)}${ch(x)}5 degrees today.`),
        'reformatted',
      ]);
      // (1) red when U+2212 leaves `isDash` (its row, and U+207B's and U+208B's); (2) prints each
      //     differing `Cf`'s code point and state.
      expect(misses(rows)).toEqual([]);
    },
  );

  it('§3 an invisible format character inside a number: `12`+X+`500` for every `Cf`, U+FEFF before `5000`, a leading decimal point or comma before every `Cf`', () => {
    whole(CF, /^\p{Cf}$/u);
    const inside = (x: number, digits: string) =>
      read('the fee is 12', `the fee is 12${ch(x)}${digits} euro`);
    const rows: Row[] = [
      // U+FEFF reads as a space, so `12`, U+FEFF, `500` reads as a group of thousands.
      ...CF.map((x): Row => [
        `12 ${hex(x)} 500`,
        inside(x, '500'),
        x === 0xfeff ? 'not_found' : 'reformatted',
      ]),
      ['12 U+FEFF 5000', inside(0xfeff, '5000'), 'reformatted'],
      // M9: every `Cf` after a leading `.` or `,`
      ...['.', ','].flatMap((p) =>
        CF.map((x): Row => [
          `${p}${hex(x)}75%`,
          read('75% of the cost', `The Tenant pays ${p}${ch(x)}75% of the cost.`),
          'reformatted',
        ]),
      ),
      [
        '.75%, nothing between',
        read('75% of the cost', 'The Tenant pays .75% of the cost.'),
        'not_found',
      ],
    ];
    // (1) red when a member is left out of the iteration, or U+FEFF stops reading as a space (the
    //     U+FEFF rows); (2) prints the members missing and each differing row's code point and state.
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

  /** `LIST_MARKS` (`locate-quote.ts:664`), copied, and a run of `#` (`:741`). */
  const LIST = ['-', '*', '•', '◦', '▪', '‣', '·', '–', '—', '|'];
  const LIST_LINES = {
    '.⏎': '.\n',
    ':⏎': ':\n',
    ';⏎': ';\n',
    'a blank line': '.\n\n',
  } as const;
  /** `START_CLOSING` (`locate-quote.ts:662`), copied: with the opening marks, `;` and `:`, these
   *  open an item for their own reasons. */
  const CLOSING_BACK = ['"', '”', '’', "'", ')', ']', '»'];
  const LIST_GROUP = /^[\p{P}\p{S}]$/u;
  const NOT_LIST = codePoints(LIST_GROUP, 0, BMP).filter(
    (c) => ![...LIST, '#', ';', ':', ...CLOSING_BACK].map(cp).includes(c) && !OPENING.includes(c),
  );

  it('§4 the list marks and a run of `#` pass at every line start; the other marks named are refused, `+` and `>` quoted excepted', () => {
    const lc = 'the Tenant shall pay the insurance rent';
    const Cap = 'The Tenant shall pay the insurance rent';
    const doc = (before: string, m: string, it: string) =>
      `${F} for its cost${before}${m} ${it} at the end of each year.`;
    const refused = ['+', '○', '●', '■', '>', '\uf0b7'];
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
        const quotedPasses = (m === '+' || m === '>') && name !== '.⏎';
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
    whole(
      [...NOT_LIST, ...[...LIST, '#', ';', ':', ...CLOSING_BACK].map(cp), ...OPENING].filter(
        (c, i, all) => all.indexOf(c) === i,
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

  it('§4 the abbreviations: the printed list is `NOT_SENTENCE_ENDS`; each entry and an initial ends no sentence; each example does', () => {
    const text = raw(HANDLERS);
    const sentence = text.slice(
      text.indexOf("- An abbreviation that is not on the check's list ("),
    );
    const printed = sentence.slice(0, sentence.indexOf(', and an initial'));
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
      // The sentence's six examples (`a.m. Monday`, `excl. VAT`, `U.S. The`, `U.K. The`, `U.S.A. The`,
      // `U.S. (the`), each read as a sentence end.
      ['a.m. Monday', skip('a.m.', 'Monday rules apply to the Tenant at all times'), 'stitched'],
      ['excl. VAT', skip('excl.', 'VAT rules apply to the Tenant at all times'), 'stitched'],
      ['U.S. The', skip('U.S.', 'The rules apply to the Tenant at all times'), 'stitched'],
      ['U.K. The', skip('U.K.', 'The rules apply to the Tenant at all times'), 'stitched'],
      ['U.S.A. The', skip('U.S.A.', 'The rules apply to the Tenant at all times'), 'stitched'],
      ['U.S. (the', skip('U.S.', '(the rules apply to the Tenant at all times'), 'stitched'],
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

  it('§5 U+FEFF inside a word: a quote that starts or ends at it reads `reformatted`; the whole word is not found', () => {
    const doc = `The Tenant shall not permit any un${ch(0xfeff)}lawful use of the Premises.`;
    const rows: Row[] = [
      ['starts at it', read('lawful use of the Premises', doc), 'reformatted'],
      ['ends at it', read('The Tenant shall not permit any un', doc), 'reformatted'],
      ['the whole word', read('unlawful use of the Premises', doc), 'not_found'],
    ];
    // (1) red when U+FEFF stops reading as a space; (2) prints each differing row's label and state.
    expect(misses(rows)).toEqual([]);
  });

  it('§5 the exact row and T2 `u034f-inside-a-word`: every `Cf` (U+FEFF excepted), the Hangul fillers and every combining mark (`\\p{M}`, every plane, U+034F and the variation selectors among them) make no word edge', () => {
    const marks = codePoints(/^\p{M}$/u);
    whole(CF, /^\p{Cf}$/u);
    whole(marks, /^\p{M}$/u);
    const inside = (c: number) =>
      read(
        'lawful use of the Premises',
        `The Tenant shall not permit any un${ch(c)}lawful use of the Premises.`,
      );
    const rows: Row[] = [
      ...CF.map((c): Row => [hex(c), inside(c), c === 0xfeff ? 'reformatted' : 'not_found']),
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
      'a line break',
      'a closing mark',
      'an opening mark',
      'a list mark',
      'a dash',
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

    it('the paragraph, the words, and the two notes under the table', () => {
      claimOn(
        HANDLERS,
        'The words below name exact sets, here and in the `cut_short` paragraph above, so they can be applied as written. Each is the set the check uses, as the running Node.js reads Unicode (Node 24: Unicode 17.0); anything outside it is not one.',
      );
      claimOn(
        HANDLERS,
        'U+2053 SWUNG DASH is not a dash here. U+000B, U+000C and U+0085 are not line breaks here.',
      );
      // (1) red when the table loses or renames a word, or the initial row's rule (run below) changes
      //     its words; (2) prints the words and a boolean.
      expect({
        words: [...GLOSSARY.keys()],
        initialRule: (GLOSSARY.get('an initial') ?? '').includes(
          'that changes when lowercased, with neither a letter nor `.` right before it, followed by `.`',
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
      'a closing mark, a plain space, a tab, a lowercase letter, a digit: what an `exact` `approx.` is marked before, %s',
      (_, from, to) => {
        const got = range(from, to).filter(
          (c) => read(approx, `${approx}${ch(c)}412 square metres.`) === 'exact+cut_short',
        );
        const want = [
          ...glossaryCodes('a closing mark'),
          ...glossaryCodes('a plain space'),
          ...glossaryCodes('a tab'),
          ...glossaryProps('a lowercase letter'),
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
      // (1) red when the page's line-break row and what ends a line here differ, or a note's member
      //     ends one; (2) prints the code points each has and the other lacks.
      expect({
        lineBreak: differ(got, glossaryCodes('a line break')),
        notes: [0x0b, 0x0c, 0x85].filter((c) => got.includes(c)).map(hex),
      }).toEqual({ lineBreak: NONE, notes: [] });
    });

    it.each(BLOCKS)(
      'an initial: the BMP letters `segmentsOf` ends no sentence after, as `Alpha X. Gamma`, %s',
      (_, from, to) => {
        const initial = (x: string) =>
          segmentsOf(`Alpha ${x}. Gamma`).every((p) => !p.endsSentence);
        const got = codePoints(/^\p{L}$/u, from, to).filter((c) => initial(ch(c)));
        // the row's rule: a letter of its property that changes when lowercased
        const want = glossaryProps('an initial').filter((c) => ch(c).toLowerCase() !== ch(c));
        // (1) red when the page's initial row and the letters read as an initial differ here; (2)
        //     prints the code points each has and the other lacks.
        expect(differ(got, want, from, to)).toEqual(NONE);
      },
    );

    it('an initial in context: a letter with a letter or `.` right before it is none (`U.S.`, `xA.`); `2A.` is one', () => {
      const ends = (q: string) => segmentsOf(q)[0]!.endsSentence;
      // (1) red when the row's context clause no longer holds; (2) prints the three booleans.
      expect({
        'U.S.': ends('Alpha U.S. Gamma'),
        'xA.': ends('Alpha xA. Gamma'),
        '2A.': ends('Alpha 2A. Gamma'),
      }).toEqual({ 'U.S.': true, 'xA.': true, '2A.': false });
    });

    it('B1 and M5: plain spaces and tabs mark, other whitespace does not; a `\\p{Ll}` or `\\p{Nd}` character outside the BMP leaves the quote unmarked; the dots of `...` and a `.` right after `…` do not mark', () => {
      const marking = [...glossaryCodes('a plain space'), ...glossaryCodes('a tab')];
      const doc = 'THE TENANT SHALL PAY THE RENT AND THE RATES ON THE USUAL QUARTER DAYS.';
      const rows: Row[] = [
        ...glossaryCodes('whitespace').map((w): Row => [
          hex(w),
          read(approx, `${approx}${ch(w)}412 square metres.`),
          marking.includes(w) ? 'exact+cut_short' : 'exact',
        ]),
        // pinned: the code half is #845 item 13 (`exactGoesOn` reads one UTF-16 unit)
        ...codePoints(/^[\p{Ll}\p{Nd}]$/u, 0x10000).map((c): Row => [
          hex(c),
          read(approx, `${approx} ${ch(c)}12 square metres.`),
          'exact',
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
      // (1) red when whitespace other than a plain space or a tab marks the quote, an astral letter or
      //     digit starts to (then #845's code half has landed), or the dots of `...` or a `.` right
      //     after `…` mark (the `…` run no longer taking the dots after it); (2) prints each differing
      //     row.
      expect(misses(rows)).toEqual([]);
    });

    it("B2 a label quoted with its item: the sentence's own rule over the glossary's sets, never the code's states", () => {
      const open = glossaryCodes('an opening mark');
      const capital = glossaryProps('a capital letter');
      const digit = glossaryProps('a digit', ';');
      const opensWith = (t: string, set: readonly number[]) => set.includes(cp(t));
      // The sentence (`:410`): after a line that ends with `;` or `:`, or after a blank line, quoting
      // the label as well reads `stitched`; after a line that ends a sentence, a label that opens with
      // an opening mark or a capital letter does, and one that opens with a digit needs a capital
      // letter or an opening mark after it; any other label is refused there.
      const rule = (lb: string, item: string): string =>
        opensWith(lb, open) || opensWith(lb, capital)
          ? 'stitched'
          : opensWith(lb, digit) && (opensWith(item, capital) || opensWith(item, open))
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
        'a blank line': [
          'The Tenant shall pay the Rent on the usual quarter days\n\n',
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
  });
});
