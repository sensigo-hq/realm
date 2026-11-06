// composers-715b.test.ts — issue #715 (b) 02 §B.1-B.2 (D6-17, D6-25): the CLI's composers judge at the
// reading of the record they describe — the read's own, or the snapshot the engine judged its reply
// on — and never read the run again for what they print. The instants are in 2020 on a settable
// store clock, so a composer that judged at the host's clock (years later) would say otherwise.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, expect, it, afterEach } from 'vitest';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  ExtensionRegistry,
  advanceRun,
  describePending,
  writtenSnapshot,
  stripSpanMarks,
  type RunRecord,
  type RunStore,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { InMemoryStore, settableClock } from '@sensigo/realm-testing';
import { inspectRun } from './inspect.js';
import { respondToGate } from './respond.js';
import { resumeRun } from './resume.js';
import { renderDetachMap } from './run.js';
import { makeTempHome, type TempHome } from '../test-support/temp-home.js';

const T = Date.parse('2020-01-01T00:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

/** A question `q` (60 s, abort on expiry), then `after`, an agent step. */
const ASK: WorkflowDefinition = {
  id: 'composers-715b',
  name: 'composers-715b',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    q: {
      description: 'Q.',
      execution: 'auto',
      trust: 'human_confirmed',
      depends_on: [],
      gate: { choices: ['approve', 'reject'], timeout_seconds: 60, on_expiry: 'abort' },
    },
    after: { description: 'After.', execution: 'agent', depends_on: ['q'] },
  },
};

/** Every handle a cell opened, cleaned after it. */
const homes: TempHome[] = [];
afterEach(async () => {
  for (const t of homes.splice(0)) await t.cleanup();
});

async function atQuestion() {
  const clock = settableClock(new Date(T));
  const store = new InMemoryStore({ clock });
  const h = await makeTempHome();
  homes.push(h);
  const workflowStore = h.home.workflowStore;
  await workflowStore.register(ASK);
  const { record } = await store.create({ workflowId: ASK.id, workflowVersion: 1, params: {} });
  await advanceRun(store, ASK, { runId: record.id });
  const { record: atGate } = await store.get(record.id);
  return { clock, store, workflowStore, runId: record.id, gateId: atGate.pending_gate!.gate_id };
}

/** A run that FAILED on `x` (its handler throws), through the engine; `y` never ran. */
async function failedOnX(store: InMemoryStore, def: WorkflowDefinition) {
  const registry = new ExtensionRegistry();
  registry.register('handler', 'boom', {
    id: 'boom',
    execute: async () => {
      throw new Error('boom');
    },
  });
  const { record } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
  await advanceRun(store, def, { runId: record.id, registry });
  return (await store.get(record.id)).record;
}

describe('#715 (b) §B.2 — the CLI composers judge at the record’s reading', () => {
  it('inspect: 30 s into a 60 s question, at the store’s reading, the answer command is offered', async () => {
    // (a) red when inspect composes its ways at the host's clock (the question is long expired
    //     there: no answer line); (b) prints the inspect output's answer line.
    const { clock, store, workflowStore, runId } = await atQuestion();
    await clock.set(new Date(T + 30_000));
    const out = stripSpanMarks(await inspectRun(runId, store, workflowStore));
    expect(out.split('\n').find((l) => l.startsWith('  To answer:')) ?? '(none)').toContain(
      'realm run respond',
    );
  });

  it('respond: another program ends the run right after the answer’s write — the last line names the phase the answer’s reply was judged on', async () => {
    // (a) red when respond reads the run again after the call (its line names the interposed
    //     ending); (b) prints the last line and the stored phase.
    const { store, workflowStore, runId, gateId } = await atQuestion();
    let fired = false;
    const racing = new Proxy(store, {
      get(target, prop) {
        if (prop === 'settleStep') {
          return async (...a: Parameters<InMemoryStore['settleStep']>) => {
            const out = await target.settleStep(...a);
            if (!fired && a[1].kind === 'settle_gate') {
              fired = true;
              const { record } = await target.get(runId);
              await target.settleStep(runId, {
                kind: 'seal_run',
                arm: 'abandon_requested',
                reason: 'ended by another program',
                expected_version: record.version,
                release_claims: true,
              });
            }
            return out;
          };
        }
        const v = Reflect.get(target, prop, target) as unknown;
        return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(target) : v;
      },
    }) as unknown as RunStore;
    const outcome = await respondToGate(
      runId,
      { gate: gateId, choice: 'approve' },
      racing,
      workflowStore,
      new ExtensionRegistry(),
    );
    const { record: stored } = await store.get(runId);
    expect({
      fired,
      last: stripSpanMarks(outcome.lastLine).split('\n')[0]!.split(runId).join('<run>'),
      storedPhase: stored.run_phase,
    }).toEqual({
      fired: true,
      last: "Responded: <run> | choice 'approve' | new state 'running'",
      storedPhase: 'abandoned',
    });
  });

  it('resume: a claim whose deadline is still ahead at the store’s reading is a live runner’s — resume refuses', async () => {
    // (a) red when resume judges the claim at the host's clock (past its deadline there: released
    //     and resumed); (b) prints the refusal (or none).
    const clock = settableClock(new Date(T));
    const store = new InMemoryStore({ clock });
    const h = await makeTempHome();
    homes.push(h);
    const workflowStore = h.home.workflowStore;
    const def: WorkflowDefinition = {
      id: 'resume-715b',
      name: 'resume-715b',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: {
        x: { description: 'X.', execution: 'auto', depends_on: [], handler: 'boom' },
        y: { description: 'Y.', execution: 'auto', depends_on: ['x'] },
      },
    };
    await workflowStore.register(def);
    const record = await failedOnX(store, def);
    // Another program holds `y` with a deadline a minute after the store's reading.
    await store.update({
      ...record,
      in_progress_steps: ['y'],
      claims: { y: { deadline: iso(T + 60_000), token: 't' } },
    } as RunRecord);
    const refused = await resumeRun(record.id, 'x', store, workflowStore).then(
      () => '(resumed)',
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    );
    expect(refused).toContain("Step 'y' has a HEALTHY claim");
  });

  it('resume: the lines after a resume are judged on the resume’s own write — the run is read once, before it', async () => {
    // (a) red when resume (or its caller) reads the run again after its write; (b) prints the reads.
    const clock = settableClock(new Date(T));
    const store = new InMemoryStore({ clock });
    const h = await makeTempHome();
    homes.push(h);
    const workflowStore = h.home.workflowStore;
    const def: WorkflowDefinition = {
      id: 'resume2-715b',
      name: 'resume2-715b',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: { x: { description: 'X.', execution: 'auto', depends_on: [], handler: 'boom' } },
    };
    await workflowStore.register(def);
    const record = await failedOnX(store, def);
    let gets = 0;
    const counting = new Proxy(store, {
      get(target, prop) {
        if (prop === 'get') {
          return async (id: string) => {
            gets += 1;
            return target.get(id);
          };
        }
        const v = Reflect.get(target, prop, target) as unknown;
        return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(target) : v;
      },
    }) as unknown as RunStore;
    const { resumed } = await resumeRun(record.id, 'x', counting, workflowStore);
    expect({ gets, failed: resumed.record.failed_steps, at: resumed.at.toISOString() }).toEqual({
      gets: 1,
      failed: [],
      at: iso(T),
    });
  });

  it('workflow run’s detach map: an ended run’s cleanup step under a lease that has not passed at the record’s reading is said to be held', () => {
    // (a) red when the map judges the lease at the host's clock (passed there: not held); (b) prints
    //     the map's cleanup line.
    const LEASE = '2020-01-01T00:00:01.000Z';
    const def: WorkflowDefinition = {
      id: 'detach-715b',
      name: 'detach-715b',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: { a: { description: 'A.', execution: 'agent', depends_on: [] } },
    };
    const ended = {
      id: 'run_detach',
      workflow_id: def.id,
      workflow_version: 1,
      completed_steps: [],
      in_progress_steps: [],
      failed_steps: ['a'],
      skipped_steps: [],
      run_phase: 'failed',
      terminal_state: true,
      version: 4,
      params: {},
      evidence: [],
      created_at: iso(T - 60_000),
      updated_at: iso(T),
      finalizer_ledger: {
        tidy: { status: 'pending', rank: 0, lease_token: 'other', lease_deadline: LEASE },
      },
    } as unknown as RunRecord;
    const at = new Date(Date.parse(LEASE) - 1_000);
    const map = renderDetachMap(ended, at, undefined, {
      pending: describePending(def, writtenSnapshot(ended, at), undefined),
      workflow: def,
    });
    expect(map.split('\n').find((l) => l.includes('Cleanup')) ?? '(no cleanup line)').toContain(
      `held by another drainer's lease until ${LEASE}`,
    );
  });
});
