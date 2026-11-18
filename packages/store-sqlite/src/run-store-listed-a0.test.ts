// Gap 1, unit A0 — the SQLite store's `scanListed`: a listing of runs reads no model call's text. The
// SELECTs remove `model_text` from each evidence row and from each of the five drive-failure entries
// of the run's core document (`json_remove`), every other value comes back as `get` reads it, and
// each run carries the lease facts `scan('record')` gives it.
//
// Each cell names the break that turns it red (prompts/gap1-a0-listed-scan.md, checks 1 and 6).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyInProgressClaims,
  systemClock,
  type DriveFailureRecord,
  type EvidenceSnapshot,
  type LeaseHold,
  type RunRecord,
  type Snapshot,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { afterEach, describe, expect, it } from 'vitest';
import { createLeasePort } from './claim-lease.js';
import { RealmDb } from './connection.js';
import { SqliteRunStore } from './run-store.js';

const roots: string[] = [];
const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A SQLite store in a home of its own, with its real claim leases. */
async function openStore(): Promise<SqliteRunStore> {
  const root = mkdtempSync(join(tmpdir(), 'realm-a0-listed-'));
  roots.push(root);
  const home = join(root, 'home');
  const db = await RealmDb.open(home, { clock: systemClock });
  closers.push(() => db.close());
  return new SqliteRunStore(db, createLeasePort(home));
}

/** A stand-in for a model call's text: the listing must leave it out, whatever it holds. */
const TEXT = { recorded: true, sent: [{ role: 'user', content: 'a prompt with a secret' }] };

/** `record` with `model_text` taken out of copies of its entries: what a listing should give. */
function withoutTexts(record: RunRecord): unknown {
  const drop = (entry: object): object => {
    const copy = { ...entry } as Record<string, unknown>;
    delete copy['model_text'];
    return copy;
  };
  const failures = record.drive_failures;
  return {
    ...record,
    evidence: record.evidence.map(drop),
    ...(failures !== undefined
      ? { drive_failures: { ...failures, entries: failures.entries.map(drop) } }
      : {}),
  };
}

/** How many `"model_text"` keys the JSON of `value` holds. */
const texts = (value: unknown): number => JSON.stringify(value).split('"model_text"').length - 1;

/** Every run of `workflow` as `scanListed` gives it. */
async function listed(store: SqliteRunStore, workflow: string) {
  const runs = [];
  for await (const page of store.scanListed({ workflow }, { pageSize: 1000 })) {
    for (const item of page.items) if (item.kind === 'run') runs.push(item.run);
  }
  return runs;
}

describe('gap 1, unit A0 — the SQLite store lists runs without their model calls’ texts', () => {
  it('check 1: scanListed leaves model_text out of every evidence row and all five drive-failure entries, every other value as get reads it', async () => {
    const store = await openStore();
    const { record: run } = await store.create({
      workflowId: 'a0-values',
      workflowVersion: 1,
      params: {},
    });
    const entry = (step_id: string, withText: boolean): EvidenceSnapshot =>
      ({
        step_id,
        started_at: '2026-01-01T00:00:00.000Z',
        completed_at: '2026-01-01T00:00:01.000Z',
        duration_ms: 1,
        input_summary: { note: 'café \u0000 ☕', big: 9007199254740991 },
        output_summary: { answer: 'kept', list: [1, 2.5, -3e-7] },
        status: 'success',
        evidence_hash: `a0-${step_id}`,
        ...(withText ? { model_text: TEXT } : {}),
      }) as unknown as EvidenceSnapshot;
    const failure = (i: number): DriveFailureRecord =>
      ({
        at: `2026-01-01T00:00:0${i}.000Z`,
        step: 'work',
        provider: 'a0-provider',
        error_class: 'other',
        message: `failure ${i}`,
        elapsed_ms: i,
        model_text: TEXT,
      }) as unknown as DriveFailureRecord;
    await store.update({
      ...run,
      evidence: [entry('first', true), entry('second', false)],
      drive_failures: {
        first_failed_at: '2026-01-01T00:00:00.000Z',
        total: 5,
        entries: [0, 1, 2, 3, 4].map(failure),
      },
    });
    const { record: stored } = await store.get(run.id);
    const [got] = await listed(store, 'a0-values');
    // (1) red when the evidence path is dropped from the SELECT (the first entry keeps its text) or
    //     the drive-failure paths are (the five entries keep theirs), or another value changes; (2)
    //     prints the texts counted on both sides and the two records.
    expect({
      storedTexts: texts(stored),
      listedTexts: texts(got?.record),
      record: JSON.stringify(got?.record),
    }).toEqual({ storedTexts: 6, listedTexts: 0, record: JSON.stringify(withoutTexts(stored)) });
  });

  it('check 6: a run whose claim names a lease is judged to the same claim state through scanListed as through scan', async () => {
    const store = await openStore();
    const definition: WorkflowDefinition = {
      id: 'a0-leased',
      name: 'A0 leased',
      version: 1,
      steps: { work: { description: 'Work.', execution: 'agent', depends_on: [] } },
    };
    const { record: run } = await store.create({
      workflowId: definition.id,
      workflowVersion: 1,
      params: {},
    });
    const made = await store.leases!.hold();
    if (!('held' in made)) throw new Error(`no lease could be held: ${JSON.stringify(made)}`);
    const hold: LeaseHold = made.held;
    closers.unshift(() => hold.close());
    await store.claimStep(run.id, 'work', definition, undefined, hold);
    const scanned: Snapshot[] = [];
    for await (const page of store.scan({ workflow: definition.id }, { pageSize: 1000 })) {
      for (const item of page.items) if (item.kind === 'run') scanned.push(item.run);
    }
    const [viaListing] = await listed(store, definition.id);
    // (1) red when scanListed skips the lease-fact step (the claim reads `not_checked` there); (2)
    //     prints both judgements and both facts.
    expect({
      listing: classifyInProgressClaims(viaListing!),
      facts: viaListing!.lease_facts,
    }).toEqual({
      listing: classifyInProgressClaims(scanned[0]!),
      facts: scanned[0]!.lease_facts,
    });
    // The instrument: the claim does name a lease the store holds, so a missing fact would show.
    expect(classifyInProgressClaims(scanned[0]!)[0]).toMatchObject({
      lease: { state: 'held', basis: 'kernel_lock' },
    });
  });
});
