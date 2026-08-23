// drive-failure-disclosure-parity.test.ts — the get_run_state half of the #401 guard.
//
// The sibling of the inspect guard, same trigger and same rule: add a field to
// `DriveFailureRecord` and BOTH surface packages stop compiling until someone routes it. This
// surface carries the record VERBATIM, so every probe reads the field off the emitted object
// rather than out of prose — which is the point of routing it verbatim for an agent consumer.
//
// v1 waives NOTHING.
import { describe, it, expect } from 'vitest';
import type { DriveFailureRecord, RunRecord, RunStore } from '@sensigo/realm';
import { handleGetRunState } from './get-run-state.js';

type DisclosureRoute =
  | { surface: 'rendered'; probe: (entry: DriveFailureRecord) => void }
  | { surface: 'waived'; reason: string };

const ENTRY: DriveFailureRecord = {
  at: '2026-01-01T00:04:00.000Z',
  step: 'classify',
  provider: 'anthropic',
  error_class: 'api_status',
  message: 'rate limited by upstream',
  attempts_sdk: 3,
  elapsed_ms: 1200,
  declared_per_attempt_ms: 600000,
  derived_ceiling_ms: 1860000,
  last_observed_status: 429,
  retry_after_observed_ms: 30000,
};

const DRIVE_FAILURE_DISCLOSURE = {
  at: { surface: 'rendered', probe: (e) => expect(e.at).toBe(ENTRY.at) },
  step: { surface: 'rendered', probe: (e) => expect(e.step).toBe('classify') },
  provider: { surface: 'rendered', probe: (e) => expect(e.provider).toBe('anthropic') },
  error_class: { surface: 'rendered', probe: (e) => expect(e.error_class).toBe('api_status') },
  message: { surface: 'rendered', probe: (e) => expect(e.message).toBe(ENTRY.message) },
  attempts_sdk: { surface: 'rendered', probe: (e) => expect(e.attempts_sdk).toBe(3) },
  elapsed_ms: { surface: 'rendered', probe: (e) => expect(e.elapsed_ms).toBe(1200) },
  declared_per_attempt_ms: {
    surface: 'rendered',
    probe: (e) => expect(e.declared_per_attempt_ms).toBe(600000),
  },
  derived_ceiling_ms: {
    surface: 'rendered',
    probe: (e) => expect(e.derived_ceiling_ms).toBe(1860000),
  },
  last_observed_status: {
    surface: 'rendered',
    probe: (e) => expect(e.last_observed_status).toBe(429),
  },
  retry_after_observed_ms: {
    surface: 'rendered',
    probe: (e) => expect(e.retry_after_observed_ms).toBe(30000),
  },
} satisfies Record<keyof DriveFailureRecord, DisclosureRoute>;

function makeStore(run: RunRecord): RunStore {
  return {
    persistsClaims: true,
    get: async () => run,
    create: async () => {
      throw new Error('not exercised');
    },
    update: async () => {
      throw new Error('not exercised');
    },
    list: async () => {
      throw new Error('not exercised');
    },
    claimStep: async () => {
      throw new Error('not exercised');
    },
  } as unknown as RunStore;
}

const run = {
  id: 'r1',
  workflow_id: 'wf',
  workflow_version: 1,
  completed_steps: [],
  in_progress_steps: [],
  failed_steps: [],
  skipped_steps: [],
  run_phase: 'running',
  version: 1,
  params: {},
  evidence: [],
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  terminal_state: false,
  drive_failures: { first_failed_at: ENTRY.at, total: 1, entries: [ENTRY] },
} as unknown as RunRecord;

describe('#401 — every DriveFailureRecord field reaches a get_run_state consumer', () => {
  it('runs each field OWN probe against the emitted record', async () => {
    const summary = await handleGetRunState({ run_id: 'r1' }, { runStore: makeStore(run) });
    const entry = summary.drive_failures?.entries[0];
    expect(entry).toBeDefined();
    for (const [field, route] of Object.entries(DRIVE_FAILURE_DISCLOSURE) as Array<
      [string, DisclosureRoute]
    >) {
      if (route.surface === 'rendered') route.probe(entry!);
      else
        expect(
          route.reason.trim().length,
          `waiver for '${field}' has an empty reason`,
        ).toBeGreaterThan(0);
    }
  });

  it('the registry covers every field, and v1 waives none', () => {
    expect(Object.keys(DRIVE_FAILURE_DISCLOSURE)).toHaveLength(11);
    expect(
      Object.values(DRIVE_FAILURE_DISCLOSURE as Record<string, DisclosureRoute>).filter(
        (r) => r.surface === 'waived',
      ),
    ).toEqual([]);
  });

  it('ABSENT, never null, when the run has had no drive failures', async () => {
    // Deleted rather than set to undefined: absent and explicitly-undefined are different facts
    // under exactOptionalPropertyTypes, and this cell is about ABSENCE.
    const { drive_failures: _omitted, ...clean } = run;
    const summary = await handleGetRunState(
      { run_id: 'r1' },
      { runStore: makeStore(clean as RunRecord) },
    );
    expect('drive_failures' in summary).toBe(false);
  });
});
