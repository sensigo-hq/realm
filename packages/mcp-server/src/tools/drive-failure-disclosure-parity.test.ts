// drive-failure-disclosure-parity.test.ts — the get_run_state half of the #401 guard.
//
// The sibling of the inspect guard, same trigger and same rule: add a field to
// `DriveFailureRecord` and BOTH surface packages stop compiling until someone routes it. This
// surface carries the record as stored, so every probe reads the field off the emitted object
// rather than out of prose — which is the point of routing it as stored for an agent consumer.
//
// Gap 1, unit A2a: it waives one field, `model_text` (the model calls' texts), which get_run_state
// never shows; get-run-state-drive-failure-text-a2a.test.ts asserts its absence directly, because a
// waiver skips its field's probe.
import { declared } from '../test-support/declared.js';
import { describe, it, expect } from 'vitest';
import type {
  DriveFailureRecord,
  ModelAttempt,
  RunRecord,
  RunStore,
  UsageRecord,
} from '@sensigo/realm';
import { handleGetRunState } from './get-run-state.js';
import {
  snap,
  doubleClock,
  noSettle,
  neverPurges,
  notScanned,
} from '../test-support/snapshot-double.js';

type DisclosureRoute =
  | { surface: 'rendered'; probe: (entry: DriveFailureRecord) => void }
  | { surface: 'waived'; reason: string };

const USAGE: UsageRecord[] = [
  {
    request_index: 0,
    request_start: '2026-01-01T00:03:59.000Z',
    prompt_tokens: 1200,
    output_tokens: 40,
  },
];

/** Gap 2, unit (i-a): a failure's failed model tries, every member and both optional ones. */
const ATTEMPTS: ModelAttempt[] = [
  {
    request: 0,
    kind: 'transient',
    error_class: 'api_status',
    status: 429,
    wait_ms: 30000,
    retry_after_ms: 30000,
  },
  {
    request: 0,
    kind: 'transient',
    error_class: 'api_status',
    status: 429,
    wait_ms: null,
    retry_after_ms: 30000,
    exhausted_by: 'attempts',
  },
  {
    request: 1,
    kind: null,
    error_class: null,
    status: null,
    wait_ms: 0,
    retry_after_ms: null,
    then: 'gateway',
  },
];

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
  // #715 (b) (02 §D.2): the finding's fence, passed verbatim like every other field.
  evidence_count: 2,
  gate_id: 'gate-parity',
  usage: USAGE,
  model_attempts: ATTEMPTS,
};

/** Gap 1, unit A2a: why get_run_state does not show a drive failure's `model_text`. */
const MODEL_TEXT_WAIVER =
  "the model calls' texts a drive failure keeps (gap 1, unit A2a): get_run_state never shows them, and a listing of runs leaves them out; `realm run export` carries them, masked as values";

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
  // issue #600 PR 1a (D9): this surface passes `drive_failures` as stored, but for `model_text` and
  // the bound on `usage` (the doc comment on `DriveFailureRecord.usage` says so), so `usage` needs
  // no new plumbing here — only the row that proves it, same as every field above.
  usage: { surface: 'rendered', probe: (e) => expect(e.usage).toEqual(USAGE) },
  evidence_count: { surface: 'rendered', probe: (e) => expect(e.evidence_count).toBe(2) },
  gate_id: { surface: 'rendered', probe: (e) => expect(e.gate_id).toBe('gate-parity') },
  model_text: { surface: 'waived', reason: MODEL_TEXT_WAIVER },
  // Gap 2, unit (i-a): passed as stored (`boundedDriveFailures` keeps every key but model_text).
  model_attempts: {
    surface: 'rendered',
    probe: (e) => expect(e.model_attempts).toEqual(ATTEMPTS),
  },
} satisfies Record<keyof DriveFailureRecord, DisclosureRoute>;

function makeStore(run: RunRecord): RunStore {
  return declared({
    clock: doubleClock,
    settleStep: noSettle,
    persistsClaims: true,
    get: async () => snap(run),
    create: async () => {
      throw new Error('not exercised');
    },
    update: async () => {
      throw new Error('not exercised');
    },
    scan: notScanned,
    ...neverPurges,
    claimStep: async () => {
      throw new Error('not exercised');
    },
  } as unknown as RunStore);
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

  it('the registry covers every field, and waives only model_text, for its written reason', () => {
    // #715 (b) (02 §D.2): + evidence_count and gate_id, passed as stored like the rest. Gap 1, unit
    // A2a: + model_text, waived. Gap 2, unit (i-a): + model_attempts, passed as stored.
    expect(Object.keys(DRIVE_FAILURE_DISCLOSURE)).toHaveLength(16);
    expect(
      Object.entries(DRIVE_FAILURE_DISCLOSURE as Record<string, DisclosureRoute>)
        .filter(([, r]) => r.surface === 'waived')
        .map(([key, r]) => [key, (r as { reason: string }).reason]),
    ).toEqual([['model_text', MODEL_TEXT_WAIVER]]);
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

  it("gap 2, unit (i-b): Realm's attempt number as `attempt`, right after `attempts_sdk`, for an entry whose failure ended its last request; none for one that does not", async () => {
    // Correction 1: ENTRY's tries end with request 1's failed send, which a gateway re-send
    // answered, so request 1 got its answer and ENTRY's failure is something else: no `attempt`.
    // Without that last try, the list ends with request 0's two sends, the second of which ended
    // it (its tries used up): `attempt` 2. An entry with no tries has none.
    const { model_attempts: _tries, ...bare } = ENTRY;
    const ended = { ...ENTRY, model_attempts: ATTEMPTS.slice(0, 2) };
    const all = {
      ...run,
      drive_failures: { first_failed_at: ENTRY.at, total: 3, entries: [ended, ENTRY, bare] },
    } as unknown as RunRecord;
    const summary = await handleGetRunState({ run_id: 'r1' }, { runStore: makeStore(all) });
    const [withEnded, recovered, without] = summary.drive_failures?.entries ?? [];
    const keys = Object.keys(withEnded ?? {});
    // (a) red when the derived field is missing, counts every entry or the client's count, sits
    //     elsewhere, or appears on an entry whose last request got its answer (correction 1) or
    //     on one with no tries; (b) prints the fields and keys.
    expect({
      attempt: withEnded?.attempt,
      attemptsSdk: withEnded?.attempts_sdk,
      next: keys[keys.indexOf('attempts_sdk') + 1],
      recovered: recovered !== undefined && 'attempt' in recovered,
      without: without !== undefined && 'attempt' in without,
    }).toEqual({ attempt: 2, attemptsSdk: 3, next: 'attempt', recovered: false, without: false });
  });
});
