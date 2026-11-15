// drive-claim-cw2a.test.ts — issue #729, the claim window, unit CW-2a: the two engine entries a drive
// uses to take a step's claim under a lease it holds (`claimStepForDrive`), and to give it back
// (`releaseDriveClaim`). Every cell runs the real entries on `InMemoryStore` with the lease double as its
// port, unless it names another store; a lease's state after the call is read from the double
// (`live`, `removed`: closed and its file deleted, `closed_kept`: closed and its file kept).
//
// Each assertion carries the two questions of `~/.claude/TESTING-RULES.md` rule 8 next to it.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InMemoryStore, createLeaseDouble, type LeaseDouble } from '@sensigo/realm-testing';
import { claimStepForDrive, releaseDriveClaim, type DriveClaim } from './drive-claim.js';
import { abandonRun } from './abandon-run.js';
import { reclaimStep } from './reclaim-step.js';
import { createDefaultRegistry } from '../extensions/default-registry.js';
import { JsonFileStore } from '../store/json-file-store.js';
import { jsonAsRunStore } from '../test-support/json-as-run-store.js';
import type { LeasePort } from '../store/lease-port.js';
import type { RunStore } from '../store/store-interface.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
import type { Attributed } from './holder.js';

const DEF: WorkflowDefinition = {
  id: 'wf-cw2a',
  name: 'cw2a',
  version: 1,
  steps: {
    work: { description: 'w', execution: 'agent', depends_on: [] },
    // Runs only when the run's `mode` is `go`; it has no dependency, so they are all settled.
    gated: {
      description: 'g',
      execution: 'agent',
      depends_on: [],
      when: ["run.params.mode == 'go'"],
    },
    after: { description: 'a', execution: 'agent', depends_on: ['work'] },
  },
};
const registry = createDefaultRegistry();
const DRIVE_A: Attributed = { by: 'drive-a', by_source: 'derived', channel: 'agent' };
const DRIVE_B: Attributed = { by: 'drive-b', by_source: 'derived', channel: 'agent' };
const HELD = { state: 'held', basis: 'kernel_lock' };

/** A store with the lease double, and a run of `DEF` in it (`mode` is `stop`). */
async function leased(): Promise<{ store: InMemoryStore; double: LeaseDouble; runId: string }> {
  const double = createLeaseDouble();
  const store = new InMemoryStore({ leases: double });
  const { record } = await store.create({
    workflowId: DEF.id,
    workflowVersion: 1,
    params: { mode: 'stop' },
  });
  return { store, double, runId: record.id };
}

const drive = (store: RunStore, runId: string, step: string, driver?: Attributed) =>
  claimStepForDrive(store, runId, step, {
    definition: DEF,
    registry,
    ...(driver !== undefined ? { driver } : {}),
  });

/** The id of the lease an answer holds; throws for any other answer. */
function heldId(answer: DriveClaim): string {
  if (answer.kind !== 'claimed') throw new Error(`expected claimed, got ${JSON.stringify(answer)}`);
  return answer.hold.id;
}

describe('#729 CW-2a — claimStepForDrive', () => {
  it('1. claimed: the claim names the hold, its holder is the driver, and the answer carries no token', async () => {
    const { store, double, runId } = await leased();
    const answer = await drive(store, runId, 'work', DRIVE_A);
    const { record } = await store.get(runId);
    const claim = record.claims?.['work'];
    // (1) red when the hold is not passed to claimStep (the claim names no lease), the driver is not
    //     the holder, or the answer carries the token; (2) prints the answer's keys, the claim's lease
    //     and holder, whether the token appears in the answer, and the lease's state.
    expect({
      kind: answer.kind,
      keys: Object.keys(answer).sort(),
      lease: claim?.lease,
      holder: claim?.holder,
      since: answer.kind === 'claimed' ? answer.since === claim?.since : 'not claimed',
      token: JSON.stringify(answer).includes(String(claim?.token)),
      state: double.state(heldId(answer)),
    }).toEqual({
      kind: 'claimed',
      keys: ['hold', 'kind', 'since'],
      lease: { id: heldId(answer) },
      holder: DRIVE_A,
      since: true,
      token: false,
      state: 'live',
    });
  });

  it('2. two drives at once on one step: one claimed; the other is told who holds it, and its lease is removed', async () => {
    const { store, double, runId } = await leased();
    const answers = await Promise.all([
      drive(store, runId, 'work', DRIVE_A),
      drive(store, runId, 'work', DRIVE_B),
    ]);
    const winner = answers.find((a) => a.kind === 'claimed');
    const loser = answers.find((a) => a.kind !== 'claimed');
    const { record } = await store.get(runId);
    const claim = record.claims?.['work'];
    const winnerId = winner === undefined ? 'none' : heldId(winner);
    const loserId = ['lease-double-1', 'lease-double-2'].find((id) => id !== winnerId)!;
    // (1) red when the loser's hold is not closed (its lease stays live), or its answer lacks the
    //     winner's holder, since or held lease; (2) prints both answers' kinds, the loser's answer and
    //     both leases' states.
    expect({
      kinds: answers.map((a) => a.kind).sort(),
      loser,
      states: { winner: double.state(winnerId), loser: double.state(loserId) },
    }).toEqual({
      kinds: ['claimed', 'held_by'],
      loser: { kind: 'held_by', holder: claim?.holder, since: claim?.since, lease: HELD },
      states: { winner: 'live', loser: 'removed' },
    });
  });

  it('3. a second drive after the first holds the step: told who holds it, and its lease is removed', async () => {
    const { store, double, runId } = await leased();
    const first = await drive(store, runId, 'work', DRIVE_A);
    const second = await drive(store, runId, 'work', DRIVE_B);
    const { record } = await store.get(runId);
    const claim = record.claims?.['work'];
    // (1) red when `held_elsewhere` maps to `refused`, or the second lease stays live; (2) prints the
    //     second answer, the leases' states and the claim's holder.
    expect({
      second,
      states: [double.state(heldId(first)), double.state('lease-double-2')],
      holder: claim?.holder,
    }).toEqual({
      second: { kind: 'held_by', holder: DRIVE_A, since: claim?.since, lease: HELD },
      states: ['live', 'removed'],
      holder: DRIVE_A,
    });
  });

  it('4. lease_unavailable: the store cannot make a lease — that reason, and no claim taken', async () => {
    const double = createLeaseDouble();
    const port: LeasePort = {
      hold: async () => ({ unavailable: 'permission' }),
      probe: (id) => double.probe(id),
    };
    const store = new InMemoryStore({ leases: port });
    const { record } = await store.create({ workflowId: DEF.id, workflowVersion: 1, params: {} });
    const answer = await drive(store, record.id, 'work', DRIVE_A);
    const after = (await store.get(record.id)).record;
    // (1) red when the claim is taken before `hold()` (the step is then in progress), or the reason is
    //     not the port's; (2) prints the answer, the in-progress steps and the version.
    expect({ answer, inProgress: after.in_progress_steps, version: after.version }).toEqual({
      answer: { kind: 'lease_unavailable', reason: 'permission' },
      inProgress: [],
      version: record.version,
    });
  });

  it('5. unleased_store: leases absent, null, and the JSON-file store — nothing held, read or written', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'realm-cw2a-'));
    try {
      const stores: Array<[string, RunStore]> = [
        ['absent', new InMemoryStore()],
        ['null', new InMemoryStore({ leases: null })],
        ['JsonFileStore', jsonAsRunStore(new JsonFileStore(dir))],
      ];
      const seen = [];
      for (const [label, store] of stores) {
        const { record } = await store.create({
          workflowId: DEF.id,
          workflowVersion: 1,
          params: {},
        });
        let reads = 0;
        const counted = Object.create(store) as RunStore;
        counted.get = (id) => {
          reads += 1;
          return store.get(id);
        };
        const answer = await drive(counted, record.id, 'work', DRIVE_A);
        const after = (await store.get(record.id)).record;
        seen.push({ label, answer, reads, version: after.version - record.version });
      }
      // (1) red when an absent `leases` is read other than as `null` (the call then reaches the
      //     port), or any of the three is read or written; (2) prints each store's answer, its reads
      //     and how far its version moved.
      expect(seen).toEqual(
        ['absent', 'null', 'JsonFileStore'].map((label) => ({
          label,
          answer: { kind: 'unleased_store' },
          reads: 0,
          version: 0,
        })),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('6a. not_eligible: a step whose when is false while its dependencies are settled — the lease removed', async () => {
    const { store, double, runId } = await leased();
    const answer = await drive(store, runId, 'gated', DRIVE_A);
    // (1) red when `not_eligible` maps to `refused`, or the hold is left live; (2) prints the answer
    //     and the lease's state.
    expect({ answer, state: double.state('lease-double-1') }).toEqual({
      answer: { kind: 'not_eligible' },
      state: 'removed',
    });
  });

  it('6b. refused: a step whose dependency is unsettled (deps_unsettled) — the lease removed', async () => {
    const { store, double, runId } = await leased();
    const answer = await drive(store, runId, 'after', DRIVE_A);
    // (1) red when the code is not passed on, or the hold is left live; (2) prints the answer and the
    //     lease's state.
    expect({ answer, state: double.state('lease-double-1') }).toEqual({
      answer: { kind: 'refused', code: 'deps_unsettled' },
      state: 'removed',
    });
  });

  it('6c. refused: an ended run (run_ended) — the lease removed', async () => {
    const { store, double, runId } = await leased();
    await abandonRun(store, runId);
    const answer = await drive(store, runId, 'work', DRIVE_A);
    // (1) red when the code is not passed on, or the hold is left live; (2) prints the answer and the
    //     lease's state.
    expect({ answer, state: double.state('lease-double-1') }).toEqual({
      answer: { kind: 'refused', code: 'run_ended' },
      state: 'removed',
    });
  });

  it('7. another error from claimStep: the same error reaches the caller, and the lease file is kept', async () => {
    const { store: real, double, runId } = await leased();
    const failure = new Error('the disk went away');
    const store = Object.create(real) as InMemoryStore;
    store.claimStep = async () => {
      throw failure;
    };
    const thrown = await drive(store, runId, 'work', DRIVE_A).then(
      () => 'resolved',
      (err: unknown) => err,
    );
    // (1) red when the hold is closed with the pre-claim record (its file is then deleted:
    //     `removed`), or another error reaches the caller; (2) prints whether the error is the same
    //     object, and the lease's state.
    expect({ same: thrown === failure, state: double.state('lease-double-1') }).toEqual({
      same: true,
      state: 'closed_kept',
    });
  });
});

describe('#729 CW-2a — releaseDriveClaim', () => {
  it('8. released: the claim is gone, the step can run again, and the lease is still held until the caller closes it', async () => {
    const { store, double, runId } = await leased();
    const claimed = await drive(store, runId, 'work', DRIVE_A);
    if (claimed.kind !== 'claimed') throw new Error(`not claimed: ${JSON.stringify(claimed)}`);
    const answer = await releaseDriveClaim(store, runId, 'work', {
      definition: DEF,
      hold: claimed.hold,
    });
    const again = await drive(store, runId, 'work', DRIVE_B);
    // (1) red when the release is keyed on the step alone (no token: the store refuses it,
    //     `claim_lost`), or the entry closes the hold (the lease then reads `closed_kept` or
    //     `removed`); (2) prints the answer's kind, the claim and in-progress steps it returned, the
    //     first lease's state, and whether a second drive can then claim the step.
    expect({
      kind: answer.kind,
      claim: answer.snapshot.record.claims?.['work'],
      inProgress: answer.snapshot.record.in_progress_steps,
      state: double.state(claimed.hold.id),
      again: again.kind,
    }).toEqual({
      kind: 'released',
      claim: undefined,
      inProgress: [],
      state: 'live',
      again: 'claimed',
    });
  });

  it('8c. not_released: the run is abandoned while the drive gives its step back — the store refuses the release, with its reason and the run it judged', async () => {
    const { store: real, double, runId } = await leased();
    const claimed = await drive(real, runId, 'work', DRIVE_A);
    if (claimed.kind !== 'claimed') throw new Error(`not claimed: ${JSON.stringify(claimed)}`);
    // Another program (`realm run abandon`, for example) ends the run after the give-back has read it
    // and before its write: the read still shows the drive's claim, the write meets an ended run.
    const store = Object.create(real) as InMemoryStore;
    store.get = async (id) => {
      const read = await real.get(id);
      await abandonRun(real, id);
      return read;
    };
    const answer = await releaseDriveClaim(store, runId, 'work', {
      definition: DEF,
      hold: claimed.hold,
    });
    // (1) red when a refused settle is answered as `not_ours` (or `released`), or the answer drops the
    //     store's reason or the run it was judged on; (2) prints the answer's kind and reason, the
    //     snapshot's phase, whether it ended, its claim, and the lease's state.
    expect({
      kind: answer.kind,
      reason: answer.kind === 'not_released' ? answer.reason : 'none',
      phase: answer.snapshot.record.run_phase,
      ended: answer.snapshot.record.terminal_state,
      claim: answer.snapshot.record.claims?.['work'],
      state: double.state(claimed.hold.id),
    }).toEqual({
      kind: 'not_released',
      reason: 'run_terminal',
      phase: 'abandoned',
      ended: true,
      claim: undefined,
      state: 'live',
    });
  });

  it("9. not_ours after another program took the step: the late give-back writes nothing, and the other's claim stays", async () => {
    const { store, double, runId } = await leased();
    const first = await drive(store, runId, 'work', DRIVE_A);
    if (first.kind !== 'claimed') throw new Error(`not claimed: ${JSON.stringify(first)}`);
    // The first drive's program ends without closing its lease; a person takes the step back; a
    // second drive claims it under a lease of its own.
    double.set(first.hold.id, 'dead');
    await reclaimStep(store, runId, 'work');
    const second = await drive(store, runId, 'work', DRIVE_B);
    const before = (await store.get(runId)).record;
    const answer = await releaseDriveClaim(store, runId, 'work', {
      definition: DEF,
      hold: first.hold,
    });
    const after = (await store.get(runId)).record;
    // (1) red when the give-back checks no lease (it then releases the second drive's claim, or
    //     writes); (2) prints the answer's kind, how far the version moved, and the claim's lease and
    //     holder afterwards.
    expect({
      kind: answer.kind,
      moved: after.version - before.version,
      lease: after.claims?.['work']?.lease,
      holder: after.claims?.['work']?.holder,
    }).toEqual({
      kind: 'not_ours',
      moved: 0,
      lease: { id: heldId(second) },
      holder: DRIVE_B,
    });
  });
});
