// false-sentences-625.test.ts — issue #625 PR-2a, the last prompt's F17 in core (review G5-3, G5-13):
// sentences of `core-library.md` made true as the build behaves. `submitHumanResponse` decides a
// guard the answer makes ready in the same write (G5-13).
// #715 (b): G5-3's cell (a `now` option that is not a valid `Date` is rejected) is DELETED with the
// option (01 §C.4: the store's clock decides what is due); so is G5-13's store-without-`settleStep`
// member (C.1: `settleStep` is required).
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { advanceRun, executeStep, submitHumanResponse } from './execution-loop.js';
import { JsonFileStore } from '../store/json-file-store.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
import type { RunStore } from '../store/store-interface.js';
import { owedOf } from '../test-support/ways-view.js';
import { writeTestClockFile } from '../store/test-clock-file.js';

/** #715 (b) (01 §C.4): the store's clock decides what is due — a JSON store on a test location: its
 *  runs folder sits beside the location's clock file, set to the host's reading. */
async function testLocationRuns(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  await writeTestClockFile(root, new Date());
  return join(root, 'runs');
}
async function clockedJsonStore(prefix: string): Promise<JsonFileStore> {
  return new JsonFileStore(await testLocationRuns(prefix));
}

const PAGE = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../docs/reference/core-library.md',
);

/** (a) red when the page no longer holds the sentence word for word; (b) prints it. */
function claim(sentence: string): void {
  const flat = (t: string) => t.replace(/\s+/g, ' ');
  expect(flat(readFileSync(PAGE, 'utf8')), `core-library.md no longer says: ${sentence}`).toContain(
    flat(sentence),
  );
}

async function store(): Promise<JsonFileStore> {
  return await clockedJsonStore('realm-f17-core-');
}

/** `q` opens a question (60 s, with or without `on_expiry`); `g`, a guard on its answer. */
function asked(onExpiry: 'abort' | undefined): WorkflowDefinition {
  return {
    id: `f17-${onExpiry ?? 'plain'}`,
    name: 'f17',
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
          ...(onExpiry !== undefined ? { on_expiry: onExpiry } : {}),
        },
      },
      g: {
        description: 'Decide.',
        execution: 'guard',
        depends_on: ['q'],
        abort_unless: ['q.ok == true'],
      },
    },
  };
}

/** A run of `d` at its open question; returns the run id and the question's id. */
async function atQuestion(s: RunStore, d: WorkflowDefinition): Promise<[string, string]> {
  const { record: run } = await s.create({ workflowId: d.id, workflowVersion: 1, params: {} });
  const opened = await executeStep(s, d, {
    runId: run.id,
    command: 'q',
    input: {},
    dispatcher: async () => ({ ok: true }),
  });
  if (opened.status !== 'confirm_required') throw new Error(`fixture: ${opened.status}`);
  return [run.id, (await s.get(run.id)).record.pending_gate!.gate_id];
}

describe('#625 PR-2a, F17 — core-library.md says what the build does', () => {
  // #715 (b): `settleStep` is required — the store without it (the legacy two-write shape) is gone,
  // and with it this cell's `without settleStep` member.
  it('G5-13: submitHumanResponse on a store with settleStep — the guard the answer makes ready', async () => {
    claim(
      "Answers a gate. A guard step the answer makes ready is decided in the same write, and the reply's `guards` names it.",
    );
    const s = await store();
    const d = asked(undefined);
    const [id, gateId] = await atQuestion(s, d);
    const answered = await submitHumanResponse(s, d, { runId: id, gateId, choice: 'approve' });
    const afterAnswer = [...(await s.get(id)).record.completed_steps];
    const advanced = await advanceRun(s, d, { runId: id });
    // (a) red when the answer's write does not decide the guard (G5-13); (b) prints the answer's
    //     guards and hint, and what advance ran.
    expect({
      guards: answered.guards,
      hint: answered.context_hint,
      owed: owedOf(answered),
      afterAnswer,
      advance: (advanced.chained_auto_steps ?? []).map((c) => c.step),
      phase: (await s.get(id)).record.run_phase,
    }).toEqual({
      guards: [{ step: 'g', outcome: 'pass' }],
      hint: "Guard step 'g' passed and completed the run.",
      owed: undefined,
      afterAnswer: ['q', 'g'],
      advance: [],
      phase: 'completed',
    });
  });
});
