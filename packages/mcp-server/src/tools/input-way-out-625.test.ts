// input-way-out-625.test.ts — issue #625 PR-2a, the last prompt's F15 (review F-R6 = G6-R7): the way out
// of a run that cannot go on is true for both kinds of input-schema refusal. The engine's input for an
// `auto` step is the run's params when it has no `depends_on`, and nothing when it has: the first is
// fixed by a run with params that fit (or a corrected `input_schema`), the second only by a corrected
// `input_schema` — and over MCP either can be run by `execute_step` with input that fits. A trust or
// precondition refusal keeps "correct the workflow". Each refused step's own way, in the view's order,
// then the run's once. Over MCP `advance_run`, as a client reads it.
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
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  type StepDefinition,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { handleAdvanceRun } from './advance-run.js';
import { handleExecuteStep } from './execute-step.js';

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
  it('a step with no depends_on (the engine gives it the run’s params): a run with params that fit, a corrected input_schema, or execute_step with input that fits', async () => {
    claim(
      'docs/reference/mcp/tools.md',
      "`For '<step>', start a run with params that fit, or correct its input_schema and register the workflow again, or call execute_step for it with input that fits; then, after a fix, call advance_run; or end the run with abandon_run.` for a step with no `depends_on` (the engine gives it the run's params)",
    );
    const r = await advance(
      wf('f15-params', {
        first: { description: 'F.', execution: 'auto', depends_on: [], input_schema: NEEDS_N },
      }),
      { n: 'five' },
    );
    // (a) red when the way out says only "correct the workflow" for an input the run's params decide
    //     (F-R6); (b) prints the hint's end.
    expect(r.reply.context_hint.slice(r.reply.context_hint.indexOf(' For '))).toBe(
      ` For 'first', start a run with params that fit, or correct its input_schema and register the workflow again, or call execute_step for it with input that fits; ${RUN_WAY}`,
    );
    // The way it names is real: execute_step with input that fits runs the step.
    const ran = await handleExecuteStep(
      { run_id: r.id, command: 'first', params: { n: 5 } },
      { runStore: r.runStore, workflowStore: r.workflowStore },
    );
    // (a) red when the call the way out names does not run the step; (b) prints its status.
    expect({ status: ran.status, done: (await r.runStore.get(r.id)).completed_steps }).toEqual({
      status: 'ok',
      done: ['first'],
    });
  });

  it('a step with depends_on (the engine gives it no input): a corrected input_schema, or execute_step with input that fits — never a run with other params', async () => {
    claim(
      'docs/reference/mcp/tools.md',
      "`For '<step>', the engine gives it no input, so correct its input_schema and register the workflow again, or call execute_step for it with input that fits; …` for one with `depends_on`",
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
      ` For 'second', the engine gives it no input, so correct its input_schema and register the workflow again, or call execute_step for it with input that fits; ${RUN_WAY}`,
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
      runWay: hint.split(RUN_WAY).length - 1,
    }).toEqual({
      tail: ` For 't', correct the workflow and register it again; for 'first', start a run with params that fit, or correct its input_schema and register the workflow again, or call execute_step for it with input that fits; ${RUN_WAY}`,
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
