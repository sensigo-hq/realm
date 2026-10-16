// usage-record-law-600.test.ts — issue #600 PR 2 (A6, G27): the store TCK's USAGE_RECORD_ROUNDTRIP
// law requires a store to round-trip each request fact PR 2 adds, in a step's evidence and in a
// failed drive's usage. Green against the two stores Realm ships (InMemoryStore, JsonFileStore); red,
// for EACH of the ten fields, against a store written here that drops that one field (the
// `output-source-law-625.test.ts` pattern). The lifetime unit adds the tenth, `cache_auto`, an
// object: the law compares it by deep equality, so a store that keeps its keys in another order
// passes.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure: the
// law's message, which names the field, where it was, and the test values written and read back.
import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileStore } from '@sensigo/realm';
import type { RunRecord, RunStore, WorkflowDefinition } from '@sensigo/realm';
import { InMemoryStore } from './in-memory-store.js';
import { runStoreFidelityContract } from './run-store-fidelity-contract.js';

const agentWf: WorkflowDefinition = {
  id: 'tck-usage-record',
  name: 'tck-usage-record',
  version: 1,
  steps: { s: { description: 'S.', execution: 'agent', depends_on: [] } },
};

/** The ten request facts issue #600 adds to `UsageRecord` (PR 2's nine, the lifetime unit's `cache_auto`). */
const FIELDS = [
  'model',
  'cache_requested',
  'cache_lifetime_s',
  'cache_ttl_sent',
  'cache_requested_source',
  'cache_requested_by',
  'provider',
  'endpoint',
  'cache_split_offered',
  'cache_auto',
] as const;

/** The USAGE_RECORD_ROUNDTRIP case of the TCK, against `store`. */
function lawOf(store: RunStore) {
  const cases = runStoreFidelityContract({ store, definition: agentWf, stepName: 's' }).filter(
    (c) => c.law === 'USAGE_RECORD_ROUNDTRIP',
  );
  expect(cases, 'fixture: the law is one case').toHaveLength(1);
  return cases[0]!;
}

/** Drops `field` from every request record the store is handed, in both places. */
function dropping(field: string) {
  return changing((r) => {
    const { [field]: _gone, ...rest } = r;
    return rest;
  });
}

/** Keeps `cache_auto` with its keys in reverse order, in both places — every value unchanged. */
function reordering() {
  return changing((r) => {
    const auto = r['cache_auto'];
    if (auto === null || typeof auto !== 'object') return r;
    return {
      ...r,
      cache_auto: Object.fromEntries(Object.entries(auto as object).reverse()),
    };
  });
}

/** A store that applies `change` to every request record it is handed, in both places. */
function changing(change: (r: Record<string, unknown>) => Record<string, unknown>) {
  const strip = (requests: unknown): unknown =>
    Array.isArray(requests) ? requests.map((r: Record<string, unknown>) => change(r)) : requests;
  return class extends InMemoryStore {
    override update(record: RunRecord): Promise<RunRecord> {
      return super.update({
        ...record,
        evidence: record.evidence.map((e) =>
          e.diagnostics?.cache === undefined
            ? e
            : {
                ...e,
                diagnostics: {
                  ...e.diagnostics,
                  cache: {
                    ...e.diagnostics.cache,
                    requests: strip(e.diagnostics.cache.requests) as never,
                  },
                },
              },
        ),
        ...(record.drive_failures !== undefined
          ? {
              drive_failures: {
                ...record.drive_failures,
                entries: record.drive_failures.entries.map((d) =>
                  d.usage === undefined ? d : { ...d, usage: strip(d.usage) as never },
                ),
              },
            }
          : {}),
      });
    }
  };
}

describe('issue #600 PR 2 — USAGE_RECORD_ROUNDTRIP', () => {
  it('passes for InMemoryStore and JsonFileStore, which round-trip every request fact', async () => {
    // (a) red when a shipped store drops a request fact; (b) prints the law's message.
    await lawOf(new InMemoryStore()).run();
    await lawOf(new JsonFileStore(await mkdtemp(join(tmpdir(), 'tck-usage-600-')))).run();
  });

  for (const field of FIELDS) {
    it(`REJECTS a store that drops ${field} (red against a lossy store)`, async () => {
      const Lossy = dropping(field);
      // (a) red when the law does not check `${field}`; (b) prints the law's message.
      await expect(lawOf(new Lossy()).run()).rejects.toThrow(
        new RegExp(`round-trip a request record's ${field} `),
      );
    });
  }

  it("passes for a store that keeps cache_auto's keys in another order (deep equality)", async () => {
    const Reordered = reordering();
    const store = new Reordered();
    // (a) red when the law compares `cache_auto` by its serialised text (key order); (b) prints
    // the law's message.
    await lawOf(store).run();
    // The double did reverse the keys: the law ran against a reordered `cache_auto`.
    const runs = await store.list();
    const stored = runs
      .flatMap((r) => r.evidence)
      .flatMap((e) => e.diagnostics?.cache?.requests ?? [])
      .map((r) => Object.keys(r.cache_auto ?? {}));
    expect(stored).toContainEqual(['gaps_s', 'basis']);
  });
});
