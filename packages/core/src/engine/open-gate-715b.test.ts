// open-gate-715b.test.ts — issue #715 (b) A.8 (i) (D-20, D6-12, D6-25 (i)): the opening delta carries
// DURATIONS; the store's write mints the gate's instants from its own reading. The MR-114 shape,
// inverted: before (b) the engine minted `opened_at` from the host's clock while the store judged the
// answer at ITS reading, so on a store two hours ahead the reply offered an answer the store then
// refused as late. Every store here is a JSON store on a test location whose clock file says T.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileStore } from '../store/json-file-store.js';
import { writeTestClockFile } from '../store/test-clock-file.js';
import { executeStep, submitHumanResponse } from './execution-loop.js';
import { nextCalls } from '../test-support/ways-view.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** A JSON store on a test location whose clock says `t` (core cannot import the testing package). */
async function location(t: Date): Promise<JsonFileStore> {
  const root = await mkdtemp(join(tmpdir(), 'realm-715b-open-'));
  roots.push(root);
  await writeTestClockFile(root, t);
  return new JsonFileStore(join(root, 'runs'));
}

/** One agent step with a question: 300 s to answer (abort on expiry), a reminder every 60 s. */
const ASK: WorkflowDefinition = {
  id: 'open-715b',
  name: 'open gate 715b',
  version: 1,
  steps: {
    ask: {
      description: 'Ask.',
      execution: 'agent',
      trust: 'human_confirmed',
      depends_on: [],
      gate: {
        choices: ['approve', 'reject'],
        timeout_seconds: 300,
        on_expiry: 'abort',
        reminder_seconds: 60,
      },
    },
  },
} as WorkflowDefinition;

/** The store's clock two hours ahead of the host's, to the millisecond. */
const aheadOfWall = (): Date => new Date(Math.floor(Date.now() / 1000) * 1000 + 2 * 3_600_000);

async function opened(t: Date) {
  const store = await location(t);
  const { record: run } = await store.create({
    workflowId: ASK.id,
    workflowVersion: 1,
    params: {},
  });
  const reply = await executeStep(store, ASK, {
    runId: run.id,
    command: 'ask',
    input: {},
    dispatcher: async () => ({}),
  });
  const { record } = await store.get(run.id);
  return { store, runId: run.id, reply, record, gate: record.pending_gate! };
}

describe('#715 (b) A.8 (i) — the opening write mints the gate’s instants from the store’s reading', () => {
  it('MR-114 inverted: a store two hours ahead of the wall opens a gate — opened_at is the store’s reading; the reply offers the answer and the store takes it', async () => {
    // (a) red when the engine mints opened_at itself again (opened_at is the wall's, two hours
    //     before the write; the answer then lands past expires_at and the run aborts);
    //     (b) prints the instants, the reply's ways and the answer's outcome.
    const T = aheadOfWall();
    const o = await opened(T);
    const answered = await submitHumanResponse(o.store, ASK, {
      runId: o.runId,
      gateId: o.gate.gate_id,
      choice: 'approve',
    });
    const { record: after } = await o.store.get(o.runId);
    expect({
      status: o.reply.status,
      opened_at: o.gate.opened_at,
      written: o.record.updated_at,
      as_of: o.reply.basis?.as_of,
      offered: nextCalls(o.reply).some((c) => c.startsWith('respond')),
      answer: answered.status,
      recorded: answered.answer_recorded ?? true,
      phase: after.run_phase,
    }).toEqual({
      status: 'confirm_required',
      opened_at: T.toISOString(),
      written: T.toISOString(),
      as_of: T.toISOString(),
      offered: true,
      answer: 'ok',
      recorded: true,
      phase: 'completed',
    });
  });

  it('timeout_seconds 300 ⇒ expires_at = opened_at + 300 s exactly — no gate is born expired', async () => {
    // (a) red when expires_at is minted from another instant than opened_at (the old probe-5 case:
    //     a gate born 437 ms expired); (b) prints both instants.
    const T = aheadOfWall();
    const { gate } = await opened(T);
    expect({ opened_at: gate.opened_at, expires_at: gate.expires_at }).toEqual({
      opened_at: T.toISOString(),
      expires_at: new Date(T.getTime() + 300_000).toISOString(),
    });
  });

  it('a gate with reminders keeps its frozen reminder pair (reminder_seconds, reminder_max defaulted to 3) and its frozen disposition', async () => {
    // (a) red when the opening gate drops a frozen field the delta used to carry (the OpeningGate
    //     must carry everything but the two instants); (b) prints the frozen fields.
    const { gate } = await opened(aheadOfWall());
    expect({
      reminder_seconds: gate.reminder_seconds,
      reminder_max: gate.reminder_max,
      on_expiry: gate.on_expiry,
    }).toEqual({ reminder_seconds: 60, reminder_max: 3, on_expiry: 'abort' });
  });
});
