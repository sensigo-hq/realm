// drive-failure-disclosure-parity.test.ts — issue #401: every field of `DriveFailureRecord` must
// reach an operator through `realm run inspect`, or carry a written reason why it does not.
//
// Same guard, same reasoning, as the sealed-by sibling: a provenance field that ships with no read
// surface is invisible, and nothing — not the type system, not any test — can see "we added a
// field and forgot to show it". The `satisfies Record<keyof DriveFailureRecord, …>` below is the
// trigger: add a field and this stops compiling until someone routes it.
//
// v1 waives NOTHING. Every field renders.
import { describe, it, expect } from 'vitest';
import type { DriveFailureRecord, RunRecord } from '@sensigo/realm';
import { inspectRun } from './inspect.js';

type DisclosureRoute =
  { surface: 'rendered'; probe: (out: string) => void } | { surface: 'waived'; reason: string };

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
  at: { surface: 'rendered', probe: (out) => expect(out).toContain(ENTRY.at) },
  step: { surface: 'rendered', probe: (out) => expect(out).toContain('classify') },
  provider: { surface: 'rendered', probe: (out) => expect(out).toContain('anthropic') },
  error_class: { surface: 'rendered', probe: (out) => expect(out).toContain('api_status') },
  message: {
    surface: 'rendered',
    probe: (out) => expect(out).toContain('rate limited by upstream'),
  },
  attempts_sdk: { surface: 'rendered', probe: (out) => expect(out).toContain('(attempt 3)') },
  elapsed_ms: { surface: 'rendered', probe: (out) => expect(out).toContain('after 1200ms') },
  declared_per_attempt_ms: {
    surface: 'rendered',
    probe: (out) => expect(out).toContain('declared 600000ms'),
  },
  derived_ceiling_ms: {
    surface: 'rendered',
    probe: (out) => expect(out).toContain('ceiling 1860000ms'),
  },
  last_observed_status: {
    surface: 'rendered',
    probe: (out) => expect(out).toContain('(status 429)'),
  },
  retry_after_observed_ms: {
    surface: 'rendered',
    probe: (out) => expect(out).toContain('(Retry-After 30000ms observed)'),
  },
} satisfies Record<keyof DriveFailureRecord, DisclosureRoute>;

const run = {
  id: 'run_test1',
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

const store = {
  get: async () => run,
  list: async () => [run],
} as never;
const workflowStore = {
  get: async () => {
    throw new Error('not registered');
  },
  register: async () => {},
  list: async () => [],
} as never;

describe('#401 — every DriveFailureRecord field reaches an inspect reader', () => {
  it('runs each field OWN probe against the real rendered output', async () => {
    const out = await inspectRun('run_test1', store, workflowStore);
    for (const [field, route] of Object.entries(DRIVE_FAILURE_DISCLOSURE) as Array<
      [string, DisclosureRoute]
    >) {
      if (route.surface === 'rendered') route.probe(out);
      else
        expect(
          route.reason.trim().length,
          `waiver for '${field}' has an empty reason`,
        ).toBeGreaterThan(0);
    }
  });

  it('the registry covers every field, and v1 waives none', () => {
    expect(Object.keys(DRIVE_FAILURE_DISCLOSURE).sort()).toEqual(
      [
        'at',
        'attempts_sdk',
        'declared_per_attempt_ms',
        'derived_ceiling_ms',
        'elapsed_ms',
        'error_class',
        'last_observed_status',
        'message',
        'provider',
        'retry_after_observed_ms',
        'step',
      ].sort(),
    );
    expect(
      Object.values(DRIVE_FAILURE_DISCLOSURE as Record<string, DisclosureRoute>).filter(
        (r) => r.surface === 'waived',
      ),
    ).toEqual([]);
  });
});
