// lease-facts-reach-cw1b2.test.ts — issue #729, the claim window, unit CW-1b part 2a: the lease facts a
// store returns reach core's own judges. Each cell holds a claim's lease `live` in the lease double
// (`InMemoryStore({ leases })`), with the claim's deadline already passed: only the lease branch can
// make the answer `held` or `healthy` (without the fact the claim reads `not_checked`, so
// `claim_unknown_age`; by its deadline, `claim_stale`).
//   (e) `reclaimStep`'s decision read: `priorState` is `healthy`;
//   (f) `advanceRun`'s `onTaken` and `onNotRecorded`: the snapshot each receives reads `held`;
//   (g) `executeStep` on a step in progress under the held lease: `refusal.facts.lease` is `held`;
//   and `composeWaysAt`'s `lease_facts` input (the CHANGELOG's sentence): its `held_elsewhere` entry
//   carries the fact.
//
// Each assertion carries the two questions of `~/.claude/TESTING-RULES.md` rule 8 next to it.
import { describe, expect, it } from 'vitest';
import { InMemoryStore, createLeaseDouble } from '@sensigo/realm-testing';
import { advanceRun, executeStep } from './execution-loop.js';
import { reclaimStep } from './reclaim-step.js';
import { composeWaysAt } from './ways.js';
import { leaseFactOf } from '../store/lease-facts.js';
import { ExtensionRegistry } from '../extensions/registry.js';
import type { Snapshot } from './snapshot.js';
import type { RunRecord } from '../types/run-record.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';

const LEASE = 'lease-cw1b2-held';
/** A deadline long passed: by its deadline alone, the claim is stale. */
const PAST = '2020-01-02T03:04:05.000Z';
const HELD = { state: 'held', basis: 'kernel_lock' };

/** A store whose lease port is the double, with `LEASE` held by a program that runs. */
function leasedStore(): InMemoryStore {
  const double = createLeaseDouble();
  double.set(LEASE, 'live');
  return new InMemoryStore({ leases: double });
}

/** Writes, through the store's own `update`, a claim of `step` by another program, naming `LEASE`. */
async function claimUnderLease(store: InMemoryStore, runId: string, step: string): Promise<void> {
  const { record } = await store.get(runId);
  await store.update({
    ...record,
    in_progress_steps: [...record.in_progress_steps.filter((s) => s !== step), step],
    claims: {
      ...record.claims,
      [step]: { deadline: PAST, token: `other-${step}`, since: PAST, lease: { id: LEASE } },
    },
  });
}

const AGENT: WorkflowDefinition = {
  id: 'wf-cw1b2-agent',
  name: 'cw1b2 agent',
  version: 1,
  steps: { a: { description: 'a', execution: 'agent', depends_on: [] } },
};
const AUTO: WorkflowDefinition = {
  id: 'wf-cw1b2-auto',
  name: 'cw1b2 auto',
  version: 1,
  steps: { s: { description: 's', execution: 'auto', depends_on: [], handler: 'h' } },
};

/** The lease fact the claim of `step` reads on `snapshot`, through the one reader. */
function factOn(snapshot: Snapshot | undefined, step: string): unknown {
  return snapshot === undefined
    ? 'no snapshot'
    : leaseFactOf(snapshot, snapshot.record.claims?.[step]);
}

describe('#729 CW-1b part 2a — the lease facts reach core’s judges', () => {
  it('(e) reclaimStep’s decision read: a claim whose lease is held reads healthy, past its deadline', async () => {
    const store = leasedStore();
    const { record: run } = await store.create({
      workflowId: AGENT.id,
      workflowVersion: 1,
      params: {},
    });
    await claimUnderLease(store, run.id, 'a');
    const result = await reclaimStep(store, run.id, 'a');
    // (1) red when the decision read is unpacked and judged without its facts (the claim then reads
    //     claim_unknown_age: not_checked) or by its deadline (claim_stale); (2) prints the prior state.
    expect(result.priorState).toBe('healthy');
  });

  it('(f) advanceRun’s onTaken: the re-read snapshot carries the held lease of the claim another program took', async () => {
    const store = leasedStore();
    const { record: run } = await store.create({
      workflowId: AUTO.id,
      workflowVersion: 1,
      params: {},
    });
    // The store wrapper: just before this call claims `s`, another program claims it under the lease.
    let injected = false;
    const racing = new Proxy(store, {
      get(target, prop) {
        if (prop === 'claimStep') {
          return async (...a: Parameters<InMemoryStore['claimStep']>) => {
            if (a[1] === 's' && !injected) {
              injected = true;
              await claimUnderLease(target, a[0], 's');
            }
            return target.claimStep(...a);
          };
        }
        const v = Reflect.get(target, prop, target) as unknown;
        return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(target) : v;
      },
    });
    const registry = new ExtensionRegistry();
    registry.register('handler', 'h', { id: 'h', execute: async () => ({ data: {} }) });
    const taken: Array<{ step: string; run: RunRecord; snapshot: Snapshot | undefined }> = [];
    await advanceRun(racing, AUTO, {
      runId: run.id,
      caller: 'advance_run',
      registry,
      onTaken: (step, takenRun, snapshot) => taken.push({ step, run: takenRun, snapshot }),
    });
    // (1) red when the loop passes no snapshot, or one rebuilt from the re-read record without its
    //     facts (the claim then reads not_checked); (2) prints each call's step, whether the record is
    //     the snapshot's, and the fact.
    expect(
      taken.map((t) => ({
        step: t.step,
        sameRecord: t.snapshot?.record === t.run,
        fact: factOn(t.snapshot, t.step),
      })),
    ).toEqual([{ step: 's', sameRecord: true, fact: HELD }]);
  });

  it('(f) advanceRun’s onNotRecorded: the re-read snapshot carries the held lease of the claim that replaced this call’s own', async () => {
    const store = leasedStore();
    const { record: run } = await store.create({
      workflowId: AUTO.id,
      workflowVersion: 1,
      params: {},
    });
    const registry = new ExtensionRegistry();
    // While this call's handler runs, another program's claim, naming the lease, replaces this call's.
    registry.register('handler', 'h', {
      id: 'h',
      execute: async () => {
        await claimUnderLease(store, run.id, 's');
        return { data: {} };
      },
    });
    const notRecorded: Array<{ step: string; kind: string; snapshot: Snapshot | undefined }> = [];
    await advanceRun(store, AUTO, {
      runId: run.id,
      caller: 'advance_run',
      registry,
      onNotRecorded: (step, kind, _run, snapshot) => notRecorded.push({ step, kind, snapshot }),
    });
    // (1) red when the loop passes no snapshot, or one without its facts; (2) prints each call's
    //     step, kind and the fact.
    expect(
      notRecorded.map((n) => ({ step: n.step, kind: n.kind, fact: factOn(n.snapshot, n.step) })),
    ).toEqual([{ step: 's', kind: 'held_elsewhere', fact: HELD }]);
  });

  it('(g) executeStep on a step in progress under a held lease: refusal.facts.lease is held', async () => {
    const store = leasedStore();
    const { record: run } = await store.create({
      workflowId: AGENT.id,
      workflowVersion: 1,
      params: {},
    });
    await claimUnderLease(store, run.id, 'a');
    const reply = await executeStep(store, AGENT, {
      runId: run.id,
      command: 'a',
      input: {},
      dispatcher: async () => ({}),
    });
    const refusal = reply.refusal;
    // (1) red when the step's admission is judged on a snapshot rebuilt without the load's facts (the
    //     claim then reads not_checked); (2) prints the refusal's code and facts.
    expect({
      code: refusal?.code,
      lease:
        refusal !== undefined && 'facts' in refusal
          ? (refusal.facts as { lease?: unknown }).lease
          : undefined,
    }).toEqual({ code: 'held_elsewhere', lease: HELD });
  });

  it('composeWaysAt: the lease_facts of the store snapshot the record came from reach held_elsewhere', async () => {
    const store = leasedStore();
    const { record: run } = await store.create({
      workflowId: AGENT.id,
      workflowVersion: 1,
      params: {},
    });
    await claimUnderLease(store, run.id, 'a');
    const read = await store.get(run.id);
    const held = composeWaysAt(read.record, read.at, {
      persistsClaims: false,
      definition: AGENT,
      lease_facts: read.lease_facts,
    }).unavailable.find((u) => u.code === 'held_elsewhere' && u.verb === 'run_step');
    // (1) red when composeWaysAt drops its input's lease_facts (the claim then reads not_checked);
    //     (2) prints the entry's facts.
    expect(held !== undefined && 'facts' in held ? held.facts : held).toEqual({
      step: 'a',
      deadline: PAST,
      // #922: the claim's stamp.
      claimed_at: PAST,
      lease: HELD,
    });
  });
});
