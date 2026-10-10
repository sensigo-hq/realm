// input-way-out-625.test.ts — issue #625 PR-2a, the last prompt's F15 (review F-R6 = G6-R7) on the CLI:
// `realm run advance`'s way out of a run that cannot go on is true for both kinds of input-schema
// refusal — a step with no `depends_on` (the engine gives it the run's params): a run with params that
// fit, or a corrected `input_schema`; with `depends_on` (no input): a corrected `input_schema`. A trust
// or precondition refusal keeps "correct the workflow". Each refused step's own way, in the workflow's
// order, then the run's once.
//
// In-process: the command's body (`advanceRunFromShell`) on a fresh store.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
import { advanceRunFromShell } from './run-advance.js';

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

/** `realm run advance` on a fresh run of `def`; its last line, the run id as `<run>`, and its exit. */
async function advance(def: WorkflowDefinition, params: Record<string, unknown>) {
  const home = mkdtempSync(join(tmpdir(), 'realm-f15-cli-'));
  try {
    const runs = new JsonFileStore(join(home, 'runs'));
    const workflows = new JsonWorkflowStore(join(home, 'wf'));
    await workflows.register(def);
    const { run } = await runs.create({ workflowId: def.id, workflowVersion: 1, params });
    const lines: string[] = [];
    const code = await advanceRunFromShell(
      run.id,
      { project: home },
      runs,
      workflows,
      undefined,
      (l) => lines.push(l),
      new ExtensionRegistry(),
    );
    return { code, last: lines.at(-1)!.split(run.id).join('<run>') };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const RUN_WAY = 'then, after a fix, realm run advance <run> — or end it: realm run abandon <run>';

describe('#625 PR-2a, F15 — realm run advance: the input-schema way out is true for both kinds of step', () => {
  it('a step with no depends_on: a run with params that fit, or a corrected input_schema', async () => {
    claim(
      'docs/reference/cli/realm-run-acting.md',
      "for an input its schema refuses, the line names each such step's own way (a new run with params that fit, or a corrected `input_schema`; with `depends_on` the engine gives the step no input, so a corrected `input_schema`):",
    );
    const r = await advance(
      wf('f15-cli-params', {
        first: { description: 'F.', execution: 'auto', depends_on: [], input_schema: NEEDS_N },
      }),
      { n: 'five' },
    );
    // (a) red when the way out says only "correct the workflow" for an input the run's params decide
    //     (F-R6); (b) prints the last line and the exit.
    expect(r).toEqual({
      code: 1,
      last: `Run <run> stays open (phase 'running'): for 'first', start a run with params that fit, or correct its input_schema and register the workflow again; ${RUN_WAY}`,
    });
  });

  it('a step with depends_on: the engine gives it no input — a corrected input_schema', async () => {
    const r = await advance(
      wf('f15-cli-deps', {
        a: { description: 'A.', execution: 'auto', depends_on: [] },
        second: { description: 'S.', execution: 'auto', depends_on: ['a'], input_schema: NEEDS_N },
      }),
      { n: 5 },
    );
    // (a) red when the way out sends the operator to a new run's params, which this step never gets;
    //     (b) prints the last line and the exit.
    expect(r).toEqual({
      code: 1,
      last: `Run <run> stays open (phase 'running'): for 'second', the engine gives it no input, so correct its input_schema and register the workflow again; ${RUN_WAY}`,
    });
  });

  it('a trust refusal and an input-schema refusal together: each step’s own way, in order, then the run’s way once', async () => {
    claim(
      'docs/concepts/step-kinds.md',
      "When a step that cannot run is refused for its input, the line gives each such step's own way out instead, in the workflow's order,",
    );
    const r = await advance(
      wf('f15-cli-both', {
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
    // (a) red when a step's way is left out, the order is not the workflow's, or the run's way is
    //     said more than once; (b) prints the last line.
    expect(r).toEqual({
      code: 1,
      last: `Run <run> stays open (phase 'running'): for 't', correct the workflow and register it again; for 'first', start a run with params that fit, or correct its input_schema and register the workflow again; ${RUN_WAY}`,
    });
  });
});
