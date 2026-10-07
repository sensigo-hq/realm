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
import {
  advanceRun,
  executeChain,
  executeEngineStep,
  executeStep,
  submitHumanResponse,
} from './execution-loop.js';
import { describePending } from './pending.js';
import { JsonFileStore } from '../store/json-file-store.js';
import { WorkflowError } from '../types/workflow-error.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
import type { RunStore } from '../store/store-interface.js';

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
        `gate '${gateId}' on 'q' had expired — this ${fn} call first carried out its declared settle_default: the default choice 'approve' was recorded (enacted_via: ${fn}).`,
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
      `gate '${gateId}' on 'q' had expired — this submitHumanResponse call first carried out its declared settle_default: the default choice 'approve' was recorded (enacted_via: submitHumanResponse).`,
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
      '`executeStep` takes `executeStep` (the default), `executeEngineStep` or `agent`',
      ['executeStep', 'executeEngineStep', 'agent'],
    ],
    [
      'executeChain',
      '`executeChain` takes `executeChain` (the default), `execute_step`, `agent` or `run`.',
      ['executeChain', 'execute_step', 'agent', 'run'],
    ],
    [
      'submitHumanResponse',
      '`submitHumanResponse` (the default), `submit_human_response`, `respond`, `run` or `agent`; any other value throws as above',
      ['submitHumanResponse', 'submit_human_response', 'respond', 'run', 'agent'],
    ],
    [
      'executeEngineStep',
      'optionally `caller`: `executeEngineStep` (the default), `executeStep` or `agent`; any other value throws a `WorkflowError` with the code `VALIDATION_CALLER_INVALID`, naming `executeEngineStep`, before anything is read or written.',
      ['executeEngineStep', 'executeStep', 'agent'],
    ],
  ] as const)(
    'C155/C163: %s takes exactly the words its row lists; any other throws VALIDATION_CALLER_INVALID naming it, nothing read or written',
    async (fn, sentence, words) => {
      claim(sentence);
      claim(
        'Each of these functions takes a `caller` option for a host that names the call itself; see below.',
      );
      claim('The call the expiry line names when this call carries out an expired question first.');
      claim(
        'Any other value throws a `WorkflowError` with the code `VALIDATION_CALLER_INVALID` before anything is read or written.',
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
      "Its `context_hint` says `Gate 'decide' resolved with choice 'approve'. Owed to the engine: 'file' — call advance_run.`, and its `next_actions` holds `advance_run`.",
    );
    claim('It runs no `auto` step: call `advanceRun` for the steps the answer made ready.');
    claim(
      'Their hints and `next_actions` name MCP tools — `get_run_state` to read the run, `advance_run` to run what the engine owes — which a program does not have.',
    );
    claim(
      'A program reads the run with `store.get(runId)`, asks `describePending` what the run is waiting for, and calls `advanceRun` where a hint names `advance_run`, or `submitHumanResponse` where `next_actions` names `submit_human_response`',
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
    // (a) red when the answer runs `file`, or its hint or next_actions change; (b) prints the reply.
    expect([
      answered.status,
      answered.run_phase,
      answered.context_hint,
      answered.next_actions.map((n) => n.instruction?.tool),
    ]).toEqual([
      'ok',
      'running',
      "Gate 'decide' resolved with choice 'approve'. Owed to the engine: 'file' — call advance_run.",
      ['advance_run'],
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

  // --- C156: a run advanceRun cannot read -----------------------------------------------------
  const CANNOT_READ =
    'A run it cannot read gets an error reply, as from `executeStep`, never a throw: `STATE_RUN_NOT_FOUND` for a run that does not exist; an error the store throws as a `WorkflowError` keeps its code, and any other is `ENGINE_STORE_FAILED` (a `JsonFileStore` record that is not JSON, for one).';
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
      expect([r.status, r.error_code, r.run_id, r.run_version, r.agent_action]).toEqual([
        'error',
        'STATE_RUN_NOT_FOUND',
        'nope',
        0,
        'report_to_user',
      ]);
      expect(r.command).toBe(fn === 'advanceRun' ? 'advanceRun' : 'after');
    },
  );

  it('C156: advanceRun on a record that is not JSON — ENGINE_STORE_FAILED; a WorkflowError the store throws keeps its code', async () => {
    claim(CANNOT_READ);
    const d = gated();
    await writeFile(join(dir, 'broken.json'), '{not json');
    const broken = await advanceRun(store, d, { runId: 'broken' });
    const typed = Object.create(store) as RunStore;
    Object.assign(typed, {
      get: async () => {
        throw new WorkflowError('the store is offline', {
          code: 'ENGINE_STORE_FAILED',
          category: 'ENGINE',
          agentAction: 'wait_for_human',
          retryable: true,
        });
      },
    });
    const offline = await advanceRun(typed, d, { runId: 'r' });
    // (a) red when advanceRun throws, or loses the store's own code; (b) prints the replies.
    expect([broken.status, broken.error_code, broken.errors]).toEqual([
      'error',
      'ENGINE_STORE_FAILED',
      ['Failed to load run from store'],
    ]);
    expect([offline.status, offline.error_code, offline.errors]).toEqual([
      'error',
      'ENGINE_STORE_FAILED',
      ['the store is offline'],
    ]);
  });

  const STEP_CANNOT_READ =
    "`executeStep` and `executeChain` answer a run they cannot read with an error reply, never a throw: `STATE_RUN_NOT_FOUND` for a run that does not exist, the store's own code for an error it throws as a `WorkflowError`, and `ENGINE_STORE_FAILED` for any other (a `JsonFileStore` record that is not JSON, for one).";
  it.each(['executeStep', 'executeChain'] as const)(
    'C156 class: %s on a run it cannot read — not found, the store’s own WorkflowError, a record that is not JSON — an error reply each, never a throw',
    async (fn) => {
      claim(STEP_CANNOT_READ);
      const d = gated();
      const call = (s: RunStore, runId: string) =>
        fn === 'executeStep'
          ? executeStep(s, d, { runId, command: 'after', input: {}, dispatcher })
          : executeChain(s, d, { runId, command: 'after', input: {}, dispatcher });
      await writeFile(join(dir, 'broken.json'), '{not json');
      const typed = Object.create(store) as RunStore;
      Object.assign(typed, {
        get: async () => {
          throw new WorkflowError('the store is offline', {
            code: 'ENGINE_STORE_FAILED',
            category: 'ENGINE',
            agentAction: 'wait_for_human',
            retryable: true,
          });
        },
      });
      const replies = [
        await call(store, 'nope'),
        await call(typed, 'r'),
        await call(store, 'broken'),
      ];
      // (a) red when the call throws for any of them, or a code changes; (b) prints the replies.
      expect(replies.map((r) => [r.status, r.error_code, r.errors[0], r.command])).toEqual([
        ['error', 'STATE_RUN_NOT_FOUND', 'Run not found: nope', 'after'],
        ['error', 'ENGINE_STORE_FAILED', 'the store is offline', 'after'],
        ['error', 'ENGINE_STORE_FAILED', 'Failed to load run from store', 'after'],
      ]);
    },
  );

  // --- now (lines 102, 119: C150, C157) -------------------------------------------------------
  it('C163 line 102: advanceRun given a number or a string as now throws a TypeError at an open question, before anything is written; with none it runs its steps', async () => {
    claim(
      "`now` is a `Date`, the time the call judges a question's expiry by (default: the current time).",
    );
    claim(
      'Pass a `Date`: given a number or a string, a call that meets an open question throws a `TypeError` (`now.getTime is not a function`) before anything is written, and a call that meets none runs its steps.',
    );
    const d = gated();
    const { runId } = await atQuestion(d);
    const before = JSON.stringify(await store.get(runId));
    for (const now of [Date.now(), new Date().toISOString()]) {
      await expect(advanceRun(store, d, { runId, now: now as never })).rejects.toThrow(
        'now.getTime is not a function',
      );
    }
    expect(JSON.stringify(await store.get(runId))).toBe(before);
    const plain: WorkflowDefinition = {
      id: 'dc-plain',
      name: 'p',
      version: 1,
      steps: { only: { description: 'O.', execution: 'auto', depends_on: [] } },
    };
    const { run } = await store.create({ workflowId: plain.id, workflowVersion: 1, params: {} });
    const ran = await advanceRun(store, plain, { runId: run.id, now: Date.now() as never });
    expect([ran.status, ran.run_phase]).toEqual(['ok', 'completed']);
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

  it('C163 line 104: executeEngineStep on an agent step throws a WorkflowError and writes nothing', async () => {
    claim('For an agent, guard or finalizer step it throws a `WorkflowError` and writes nothing.');
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
    claim(
      "What it returns is recorded as the agent step's answer, or as that `auto` step's output.",
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
      'Says what a run is waiting for, as an object with: `agent_steps` (the agent steps ready for an answer) and `agent_actions` (the call for each), `agent_refused` (the ready agent steps the run refuses before their claim, and why), `pending_guards` (the guard steps ready to be decided), `engine_runnable` (the `auto` steps it owes, each with `runnable_here`), `cannot_run` (every step that cannot run, and why),',
    );
    const d = gated();
    const { runId, gateId } = await atQuestion(d);
    const p = describePending(d, await store.get(runId), undefined, new Date());
    // (a) red when a field the row names is dropped; (b) prints the keys.
    for (const k of [
      'agent_steps',
      'agent_actions',
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
    expect(describePending(d, await store.get(runId), undefined, LATER()).act).toBeDefined();
    expect(describePending(d, await store.get(runId), undefined, new Date()).act).toBeUndefined();
    await submitHumanResponse(store, d, { runId, gateId, choice: 'approve' });
    const owed = describePending(d, await store.get(runId), undefined, new Date());
    expect(owed.engine_runnable.map((e) => [e.step, typeof e.runnable_here])).toEqual([
      ['after', 'boolean'],
    ]);
    expect(owed.act).toBeDefined();
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
    'C163 line 133: a driver whose %s is not one the table lists throws VALIDATION_ACTOR_INVALID naming the field, nothing read or written — from each of the four functions',
    async (_field, driver, message) => {
      claim(
        'Any other value throws a `WorkflowError` with the code `VALIDATION_ACTOR_INVALID` before anything is read or written, naming the field',
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
