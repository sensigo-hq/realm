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
import { load as loadYaml } from 'js-yaml';
import * as core from '../index.js';
import { CheckQuotesHandler } from '../handlers/check-quotes.js';
import { QUOTE_STATES, locateQuote } from '../handlers/primitives/locate-quote.js';
import { createDefaultRegistry } from '../extensions/default-registry.js';
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
import { composeWaysAt } from './ways.js';

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

  it(':339 — check_quotes is registered; the two old names never were', () => {
    claimOn(
      HANDLERS,
      '`check_quotes` is registered from this release (see [Built-in handlers](#built-in-handlers)). `validate_verbatim_quotes` and `validate_field_match` were never registered: a step naming them fails at execute as any missing handler does.',
    );
    const registry = createDefaultRegistry();
    // (a) red when check_quotes is not registered, or an old name is; (b) prints three booleans.
    expect([
      registry.has('handler', 'check_quotes'),
      registry.has('handler', 'validate_verbatim_quotes'),
      registry.has('handler', 'validate_field_match'),
    ]).toEqual([true, false, false]);
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
        config: {
          source_step: 'extract_fields',
          source_field: 'document',
          candidates_step: 'extract_fields',
          candidates_field: 'fields',
        },
        resources: { extract_fields: { document: DOC, fields: candidates } },
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
    // runs first and the run FAILS").
    const pattern = loadYaml(block(HANDLERS, 'handler: check_quotes')) as Record<string, unknown>;
    const def = {
      id: 'docs-760',
      name: 'D',
      version: 1,
      steps: {
        fetch_document: { description: 'F', execution: 'agent', depends_on: [] },
        extract_fields: { description: 'E', execution: 'agent', depends_on: ['fetch_document'] },
        ...pattern,
      },
    } as unknown as WorkflowDefinition;
    const store = new JsonFileStore(await mkdtemp(join(tmpdir(), 'realm-dc-760-')));
    const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
    const drive = (command: string, input: Record<string, unknown>) =>
      executeChain(store, def, {
        runId: run.id,
        command,
        registry: createDefaultRegistry(),
        input,
        dispatcher: async (_n, i) => ({ ...i }),
      });
    await drive('fetch_document', { text: DOC });
    await drive('extract_fields', {
      fields: [{ field: 'payment', value: 'quarterly', quote: 'the rent is paid quarterly' }],
    });
    const after = await store.get(run.id);
    const check = after.evidence.find((e) => e.step_id === 'quote_check');
    // (a) red when the pattern's guard cannot stop the run, or the record is lost; (b) prints the
    //     phase, the seal and the record's flag.
    expect({
      phase: after.run_phase,
      sealedBy: after.sealed_by?.arm,
      all_found: (check?.output_summary as { all_found?: boolean } | undefined)?.all_found,
    }).toEqual({ phase: 'aborted', sealedBy: 'guard_abort', all_found: false });
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
      'Ask the model for one contiguous span copied character for character, or two spans joined by `…`.',
    );
    // `realm run export` is pinned by the CLI's `docs-claims-625.test.ts` (#760 cell); `get_run_state`
    // carrying no step output by `step-view.ts`'s StepView (F760-AUD-06).
    claimOn(
      HANDLERS,
      "The per-value record is the step's output: read it afterwards with `realm run export <run-id>`, which writes the whole run. `get_run_state` does not carry a step's output, and `realm run inspect` prints only the warning, on the step's `Warn:` line.",
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
