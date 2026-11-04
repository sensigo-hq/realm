// one-reading-715b.test.ts — issue #715 (b) 02 §B.2, B2's cells (ii) and (iii) restated without `now`
// (D6-25), on a STEPPING store clock (each reading one second after the last, so two readings never
// coincide):
//   (ii) one `advanceRun` over three steps — each write's instant is its own reading, and the
//        readings are counted (one per store read or write, none by the engine itself);
//   (iii) one `get_run_state` judges ONE snapshot — it takes exactly one reading, and the reply's
//        stated instant is that reading.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, expect, it } from 'vitest';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  JsonWorkflowStore,
  advanceRun,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { InMemoryStore, steppingClock } from '@sensigo/realm-testing';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleGetRunState } from './get-run-state.js';

const T = new Date('2031-05-06T07:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

const THREE: WorkflowDefinition = {
  id: 'one-reading-715b',
  name: 'one-reading-715b',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    a: { description: 'A.', execution: 'auto', depends_on: [] },
    b: { description: 'B.', execution: 'auto', depends_on: ['a'] },
    c: { description: 'C.', execution: 'auto', depends_on: ['b'] },
    d: { description: 'D.', execution: 'agent', depends_on: ['c'] },
  },
};

describe('#715 (b) §B.2 — one reading per read or write, on a stepping clock', () => {
  it('(ii) one advance over three steps: each settle is stamped with its own reading, taken after the write before it', async () => {
    // (a) red when a write is stamped with another call's reading (a settle reusing the record's
    //     earlier stamp, or the loop's entry reading); (b) prints each settle's reading and stamp.
    const clock = steppingClock(T, 1_000);
    const store = new InMemoryStore({ clock });
    // Every write's reading, in order: each claim and each settle.
    const writes: Array<{ kind: string; at: string; stamped: string }> = [];
    const settles = writes;
    const settle = store.settleStep.bind(store);
    (store as { settleStep: typeof store.settleStep }).settleStep = (async (
      ...a: Parameters<typeof store.settleStep>
    ) => {
      const out = await settle(...a);
      writes.push({ kind: 'settle', at: out.at.toISOString(), stamped: out.run.updated_at });
      return out;
    }) as typeof store.settleStep;
    const claim = store.claimStep.bind(store);
    (store as { claimStep: typeof store.claimStep }).claimStep = (async (
      ...a: Parameters<typeof store.claimStep>
    ) => {
      const out = await claim(...a);
      writes.push({ kind: 'claim', at: out.at.toISOString(), stamped: out.record.updated_at });
      return out;
    }) as typeof store.claimStep;
    const { record } = await store.create({ workflowId: THREE.id, workflowVersion: 1, params: {} });
    await advanceRun(store, THREE, { runId: record.id });
    const { record: after } = await store.get(record.id);
    expect({
      ran: after.completed_steps,
      settles: settles.filter((x) => x.kind === 'settle').length,
      eachItsOwn: writes.every((x) => x.at === x.stamped),
      // Each write's reading is taken after the write before it: strictly increasing.
      eachAfterTheLast: writes.every(
        (x, i) => i === 0 || Date.parse(x.at) > Date.parse(writes[i - 1]!.at),
      ),
    }).toEqual({ ran: ['a', 'b', 'c'], settles: 3, eachItsOwn: true, eachAfterTheLast: true });
  });

  it('(iii) get_run_state takes one reading, and states it', async () => {
    // (a) red when get_run_state reads the store (or a clock) more than once, or states another
    //     instant than its one reading; (b) prints the readings taken and the stated instant.
    const clock = steppingClock(T, 1_000);
    const store = new InMemoryStore({ clock });
    const { record } = await store.create({ workflowId: THREE.id, workflowVersion: 1, params: {} });
    const workflowStore = new JsonWorkflowStore(mkdtempSync(join(tmpdir(), 'realm-715b-one-wf-')));
    await workflowStore.register(THREE);
    const before = clock.reads;
    const state = await handleGetRunState(
      { run_id: record.id },
      {
        runStore: store,
        workflowStore,
      },
    );
    const taken = clock.reads - before;
    expect({
      taken,
      statedAt: (state as { basis?: { as_of?: string } }).basis?.as_of,
    }).toEqual({ taken: 1, statedAt: iso(T.getTime() + before * 1_000) });
  });
});
