// input-way-out-625.test.ts — issue #625 PR-2a, the last prompt's F15 (review F-R6 = G6-R7): the way out
// of a run that cannot go on is true for both kinds of input-schema refusal. The engine's input for an
// `auto` step is the run's params when it has no `depends_on`, and nothing when it has: the first is
// fixed by a run with params that fit (or a corrected `input_schema`), the second only by a corrected
// `input_schema`. A trust or precondition refusal keeps "correct the workflow". Each refused step's own
// way, in the view's order, then the run's once. Over MCP `advance_run`, as a client reads it. Each
// step's own way reads the same on every surface: it never tells a caller to supply an engine step's
// input (owner, 2026-10-11).
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  JsonFileStore,
  JsonWorkflowStore,
  ExtensionRegistry,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  type StepDefinition,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { handleAdvanceRun } from './advance-run.js';
import { handleExecuteStep } from './execute-step.js';
import { handleStartRun } from './start-run.js';
import { handleStartRunBatch } from './start-run-batch.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

/** (a) red when the page no longer holds the sentence word for word; (b) prints it. */
function claim(page: string, sentence: string): void {
  const flat = (t: string) => t.replace(/\s+/g, ' ');
  expect(
    flat(readFileSync(join(ROOT, page), 'utf8')),
    `${page} no longer says: ${sentence}`,
  ).toContain(flat(sentence));
}

const NEEDS_N = { type: 'object', required: ['n'], properties: { n: { type: 'number' } } };
const wf = (id: string, steps: Record<string, StepDefinition>): WorkflowDefinition => ({
  id,
  name: id,
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps,
});
const RUN_WAY = 'then, after a fix, call advance_run; or end the run with abandon_run.';
// #729 PR-0 (T-20 (i)): when a new run is a way out, the run's way says THIS run stays open.
const RUN_WAY_NEW_RUN =
  'this run stays open — after a fix, call advance_run on it; or end it with abandon_run.';

/** `advance_run` on a fresh run of `def` with `params`; the reply's hint after its refusal lines. */
async function advance(def: WorkflowDefinition, params: Record<string, unknown>) {
  const dir = await mkdtemp(join(tmpdir(), 'f15-mcp-'));
  const runStore = new JsonFileStore(join(dir, 'runs'));
  const workflowStore = new JsonWorkflowStore(join(dir, 'wf'));
  await workflowStore.register(def);
  const { run } = await runStore.create({ workflowId: def.id, workflowVersion: 1, params });
  const reply = await handleAdvanceRun({ run_id: run.id }, { runStore, workflowStore });
  return { reply, runStore, workflowStore, id: run.id };
}

describe('#625 PR-2a, F15 — the input-schema way out is true for both kinds of step (MCP)', () => {
  it('a step with no depends_on (the engine gives it the run’s params): a run with params that fit, or a corrected input_schema', async () => {
    claim(
      'docs/reference/mcp/tools.md',
      "`For '<step>', start a run with params that fit, or correct its input_schema and register the workflow again; this run stays open — after a fix, call advance_run on it; or end it with abandon_run.` for a step with no `depends_on` (the engine gives it the run's params)",
    );
    claim(
      'docs/reference/mcp/run-state-and-health.md',
      "for a step refused for its input, a new run with params that fit (when the step has no `depends_on`: the engine gives it the run's params), or a corrected `input_schema`.",
    );
    const r = await advance(
      wf('f15-params', {
        first: { description: 'F.', execution: 'auto', depends_on: [], input_schema: NEEDS_N },
      }),
      { n: 'five' },
    );
    // (a) red when the way out says only "correct the workflow" for an input the run's params decide
    //     (F-R6), or tells the caller to supply the step's input; (b) prints the hint's end.
    expect(r.reply.context_hint.slice(r.reply.context_hint.indexOf(' For '))).toBe(
      ` For 'first', start a run with params that fit, or correct its input_schema and register the workflow again; ${RUN_WAY_NEW_RUN}`,
    );
  });

  it('execute_step named on the step with input that fits still runs it today — whether an agent door may make that call is #729 PR-0’s (preservation)', async () => {
    const r = await advance(
      wf('f15-params-run', {
        first: { description: 'F.', execution: 'auto', depends_on: [], input_schema: NEEDS_N },
      }),
      { n: 'five' },
    );
    const ran = await handleExecuteStep(
      { run_id: r.id, command: 'first', params: { n: 5 } },
      { runStore: r.runStore, workflowStore: r.workflowStore },
    );
    // (a) red when execute_step by name no longer runs an `auto` step given input its schema accepts
    //     — a behaviour this fix does not change; (b) prints its status and the completed steps.
    expect({ status: ran.status, done: (await r.runStore.get(r.id)).completed_steps }).toEqual({
      status: 'ok',
      done: ['first'],
    });
  });

  it('a step with depends_on (the engine gives it no input): a corrected input_schema — never a run with other params', async () => {
    claim(
      'docs/reference/mcp/tools.md',
      "`For '<step>', the engine gives it no input, so correct its input_schema and register the workflow again; …` for one with `depends_on`",
    );
    const r = await advance(
      wf('f15-deps', {
        a: { description: 'A.', execution: 'auto', depends_on: [] },
        second: { description: 'S.', execution: 'auto', depends_on: ['a'], input_schema: NEEDS_N },
      }),
      { n: 5 },
    );
    // (a) red when the way out sends the caller to a new run's params, which this step never gets;
    //     (b) prints the hint's end.
    expect(r.reply.context_hint.slice(r.reply.context_hint.indexOf(' For '))).toBe(
      ` For 'second', the engine gives it no input, so correct its input_schema and register the workflow again; ${RUN_WAY}`,
    );
  });

  it('a trust refusal and an input-schema refusal together: each step’s own way, in the workflow’s order, then the run’s way once', async () => {
    claim(
      'docs/reference/mcp/tools.md',
      "and `for '<step>', correct the workflow and register it again` for a refused `trust` or precondition beside it (added after version 0.46.0).",
    );
    const r = await advance(
      wf('f15-both', {
        t: {
          description: 'T.',
          execution: 'auto',
          depends_on: [],
          trust: 'bogus_trust',
        } as unknown as StepDefinition,
        first: { description: 'F.', execution: 'auto', depends_on: [], input_schema: NEEDS_N },
      }),
      { n: 'five' },
    );
    const hint = r.reply.context_hint;
    // (a) red when a step's way is left out, the order is not the workflow's, or the run's way is
    //     said more than once; (b) prints the hint's end and the count.
    expect({
      tail: hint.slice(hint.indexOf(' For ')),
      runWay: hint.split(RUN_WAY_NEW_RUN).length - 1,
    }).toEqual({
      tail: ` For 't', correct the workflow and register it again; for 'first', start a run with params that fit, or correct its input_schema and register the workflow again; ${RUN_WAY_NEW_RUN}`,
      runWay: 1,
    });
  });

  it('a trust refusal alone (preservation): the one way out, its words unchanged', async () => {
    const r = await advance(
      wf('f15-trust', {
        t: {
          description: 'T.',
          execution: 'auto',
          depends_on: [],
          trust: 'bogus_trust',
        } as unknown as StepDefinition,
      }),
      {},
    );
    // (a) red when a trust refusal loses "correct the workflow"; (b) prints the hint's end.
    expect(
      r.reply.context_hint.endsWith(
        ' Correct the workflow and register it again, then call advance_run; or end the run with abandon_run.',
      ),
    ).toBe(true);
  });
});

// Owner, 2026-10-11 (#729 comment 6107585956): the agent is never told to supply an engine step's
// input. Four more replies carry a step's own way out; each is driven here. Each case asserts both
// that the reply never names `execute_step for it` and that it still gives the step's own way.
describe('the way out never names execute_step for an engine step refused for its input (owner, 2026-10-11)', () => {
  const NO_DEPS_WAY =
    "for 'first', start a run with params that fit, or correct its input_schema and register the workflow again";
  const DEPS_WAY =
    "For 'second', the engine gives it no input, so correct its input_schema and register the workflow again";
  const DEPS = wf('f706-deps', {
    a: { description: 'A.', execution: 'auto', depends_on: [] },
    second: { description: 'S.', execution: 'auto', depends_on: ['a'], input_schema: NEEDS_N },
  });

  async function stores(def: WorkflowDefinition) {
    const dir = await mkdtemp(join(tmpdir(), 'f706-input-'));
    const workflowStore = new JsonWorkflowStore(join(dir, 'wf'));
    await workflowStore.register(def);
    return {
      runStore: new JsonFileStore(join(dir, 'runs')),
      workflowStore,
      registry: new ExtensionRegistry(),
    };
  }

  it('(i) execute_step on a step refused for its trust, beside one refused for its input: the reply’s way out', async () => {
    const s = await stores(
      wf('f706-mixed', {
        t: { description: 'T.', execution: 'auto', depends_on: [] },
        first: { description: 'F.', execution: 'auto', depends_on: [], input_schema: NEEDS_N },
      }),
    );
    // The loader refuses an invalid trust value in a file; a registered copy written by an older
    // version can carry one. Planted through the store's own write.
    const stored = await s.workflowStore.get('f706-mixed');
    (stored.steps['t'] as { trust?: unknown }).trust = 'bogus_trust';
    await s.workflowStore.register(stored);
    const started = await handleStartRun({ workflow_id: 'f706-mixed', params: {} }, s);
    const hint = (await handleExecuteStep({ run_id: started.run_id, command: 't', params: {} }, s))
      .context_hint;
    // (a) red when the way out tells the caller to supply the input of `first` (the clause #706
    //     added on MCP), or loses the step's own way; (b) prints the reply's context_hint.
    expect(hint).not.toContain('execute_step for it');
    expect(hint).toContain(NO_DEPS_WAY);
  });

  it('(ii) execute_step’s “cannot be called now” reply on a run whose next step is refused for its input', async () => {
    const s = await stores(DEPS);
    const started = await handleStartRun({ workflow_id: DEPS.id, params: {} }, s);
    const reply = await handleExecuteStep({ run_id: started.run_id, command: 'a', params: {} }, s);
    // (a) red when the blocked reply's way out names execute_step for `second`, or loses the step's
    //     own way; (b) prints the reply's context_hint.
    expect(reply.context_hint).not.toContain('execute_step for it');
    expect(reply.context_hint).toContain(DEPS_WAY);
  });

  it('(iii) a deduped start_run_batch entry on a run whose next step is refused for its input', async () => {
    const s = await stores(DEPS);
    await handleStartRun({ workflow_id: DEPS.id, params: {}, idempotency_key: 'k' }, s);
    const batch = await handleStartRunBatch(
      { workflow_id: DEPS.id, items: [{ params: {}, idempotency_key: 'k' }] },
      s,
    );
    const hint = batch.started[0]!.context_hint;
    // (a) red when the deduped entry's way out names execute_step for `second`, or loses the step's
    //     own way; (b) prints the entry's context_hint.
    expect(hint).not.toContain('execute_step for it');
    expect(hint).toContain(DEPS_WAY);
  });

  it('(iv) start_run’s reply on a run whose next step is refused for its input', async () => {
    const s = await stores(DEPS);
    const started = await handleStartRun({ workflow_id: DEPS.id, params: {} }, s);
    // (a) red when start_run's way out names execute_step for `second`, or loses the step's own
    //     way; (b) prints the reply's context_hint.
    expect(started.context_hint).not.toContain('execute_step for it');
    expect(started.context_hint).toContain(DEPS_WAY);
  });
});
