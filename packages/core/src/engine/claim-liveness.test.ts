// Unit tests for the per-claim liveness clock + 3-state classification (issue #101).
import { describe, it, expect } from 'vitest';
import {
  computeClaimDeadline,
  classifyClaim,
  classifyInProgressClaims,
  omitClaim,
  RECLAIM_FLOOR_SECONDS,
  RECLAIM_MARGIN_SECONDS,
  DEFAULT_EXECUTION_TIMEOUT_SECONDS,
  shouldEnforceTimeout,
  worstCaseScheduleSeconds,
  resolveCapMs,
  sleepWouldExceedCap,
} from './claim-liveness.js';
import type { WorkflowDefinition, RetryConfig } from '../types/workflow-definition.js';
import type { RunRecord } from '../types/run-record.js';

const NOW = new Date('2026-07-07T12:00:00.000Z');

function wf(steps: WorkflowDefinition['steps']): WorkflowDefinition {
  return { id: 'wf', name: 'WF', version: 1, steps };
}

describe('computeClaimDeadline', () => {
  it('auto step in a finalizer-free workflow → concrete deadline (floor when timeout is small)', () => {
    const def = wf({
      work: { description: 'w', execution: 'auto', depends_on: [], timeout_seconds: 10 },
    });
    const deadline = computeClaimDeadline(def, 'work', NOW);
    expect(deadline).not.toBeNull();
    // max(floor=900, 10+60) = 900s horizon.
    expect(new Date(deadline!).getTime()).toBe(NOW.getTime() + RECLAIM_FLOOR_SECONDS * 1000);
  });

  it('auto step with a large timeout → timeout + margin dominates the floor', () => {
    const def = wf({
      work: { description: 'w', execution: 'auto', depends_on: [], timeout_seconds: 2000 },
    });
    const deadline = computeClaimDeadline(def, 'work', NOW);
    expect(new Date(deadline!).getTime()).toBe(
      NOW.getTime() + (2000 + RECLAIM_MARGIN_SECONDS) * 1000,
    );
  });

  it('auto step with no timeout_seconds → uses the default execution timeout (3600s dominates the floor)', () => {
    const def = wf({ work: { description: 'w', execution: 'auto', depends_on: [] } });
    const deadline = computeClaimDeadline(def, 'work', NOW);
    // max(900, 3600+60) = 3660 — detection now tracks the real A3 enforcement bound.
    const expected =
      NOW.getTime() +
      Math.max(RECLAIM_FLOOR_SECONDS, DEFAULT_EXECUTION_TIMEOUT_SECONDS + RECLAIM_MARGIN_SECONDS) *
        1000;
    expect(new Date(deadline!).getTime()).toBe(expected);
  });

  it('agent step → null (no reliable wall-clock bound)', () => {
    const def = wf({ work: { description: 'w', execution: 'agent', depends_on: [] } });
    expect(computeClaimDeadline(def, 'work', NOW)).toBeNull();
  });

  it('auto step in a FINALIZER-BEARING workflow → null (claim may span the drain)', () => {
    const def = wf({
      work: { description: 'w', execution: 'auto', depends_on: [], timeout_seconds: 10 },
      cleanup: { description: 'c', execution: 'finalizer', on_outcome: 'always', handler: 'h' },
    });
    expect(computeClaimDeadline(def, 'work', NOW)).toBeNull();
  });

  it('unknown step → null', () => {
    const def = wf({ work: { description: 'w', execution: 'auto', depends_on: [] } });
    expect(computeClaimDeadline(def, 'nope', NOW)).toBeNull();
  });

  it('auto step with retry: horizon is max_attempts × per-attempt-timeout + backoffs, not a single attempt (issue #101 follow-up)', () => {
    const def = wf({
      work: {
        description: 'w',
        execution: 'auto',
        depends_on: [],
        timeout_seconds: 300,
        retry: { max_attempts: 5, backoff: 'fixed', base_delay_ms: 1000 },
      },
    });
    const deadline = computeClaimDeadline(def, 'work', NOW);
    // n=5, perAttempt=300s: 5*300=1500s. 'fixed' backoff is 1000ms regardless of attempt number,
    // applied between the 4 gaps (a=1..4): 4*1000ms = 4000ms = 4s. worstCase = 1500+4 = 1504.
    // horizon = max(900, 1504+60) = max(900, 1564) = 1564.
    const expected = NOW.getTime() + 1564 * 1000;
    expect(new Date(deadline!).getTime()).toBe(expected);
  });

  it('auto step with exponential backoff retry → horizon matches computeBackoff’s schedule', () => {
    const def = wf({
      work: {
        description: 'w',
        execution: 'auto',
        depends_on: [],
        timeout_seconds: 300,
        retry: {
          max_attempts: 3,
          backoff: 'exponential',
          base_delay_ms: 1000,
          max_delay_ms: 4000,
        },
      },
    });
    const deadline = computeClaimDeadline(def, 'work', NOW);
    // n=3, perAttempt=300s: 3*300=900s. Backoffs for a=1,2: base*2^(a-1) = 1000ms, 2000ms — both
    // under the 4000ms cap, so uncapped: 1000+2000 = 3000ms = 3s. worstCase = 900+3 = 903.
    // horizon = max(900, 903+60) = max(900, 963) = 963.
    const expected = NOW.getTime() + 963 * 1000;
    expect(new Date(deadline!).getTime()).toBe(expected);
  });

  it('max_delay_ms cap is respected in the backoff sum (a backoff that would exceed the cap contributes only the cap)', () => {
    const def = wf({
      work: {
        description: 'w',
        execution: 'auto',
        depends_on: [],
        timeout_seconds: 300,
        retry: {
          max_attempts: 4,
          backoff: 'exponential',
          base_delay_ms: 1000,
          max_delay_ms: 3000,
        },
      },
    });
    const deadline = computeClaimDeadline(def, 'work', NOW);
    // n=4, perAttempt=300s: 4*300=1200s. Backoffs for a=1,2,3: uncapped base*2^(a-1) would be
    // 1000/2000/4000ms — the a=3 value exceeds the 3000ms cap, so it contributes 3000ms, not 4000ms:
    // 1000+2000+3000 = 6000ms = 6s (an uncapped sum would wrongly give 7s). worstCase = 1200+6 = 1206.
    // horizon = max(900, 1206+60) = max(900, 1266) = 1266.
    const expected = NOW.getTime() + 1266 * 1000;
    expect(new Date(deadline!).getTime()).toBe(expected);
  });

  it('B1 horizon pin — a retry block with NO max_attempts RETURNS (never throws) exactly max(FLOOR, perAttempt + MARGIN)', () => {
    // The loader ADMITS an absent max_attempts (W1's own comment says so) — the shipped
    // `const n = retry.max_attempts;` (no `?? 1` guard) makes n undefined here, cascading to
    // NaN capMs/horizonSeconds and `new Date(NaN).toISOString()` THROWING. n=1 default: worstCase
    // = 1*2000 + 0 (no backoff gaps at n=1) = 2000; horizon = max(900, 2000+60) = 2060 —
    // deliberately NOT floor-dominated, so this pin is a genuine formula check, not just a
    // no-throw check.
    const def = wf({
      work: {
        description: 'w',
        execution: 'auto',
        depends_on: [],
        timeout_seconds: 2000,
        retry: { backoff: 'fixed', base_delay_ms: 5000 } as RetryConfig, // max_attempts absent
      },
    });
    expect(() => computeClaimDeadline(def, 'work', NOW)).not.toThrow();
    const deadline = computeClaimDeadline(def, 'work', NOW);
    expect(new Date(deadline!).getTime()).toBe(NOW.getTime() + 2060 * 1000);
  });

  it('B2 — an EXPLICIT total_timeout_seconds ABOVE the worst-case schedule widens the horizon to cap + margin (not the bare worst-case schedule)', () => {
    // n=3, perAttempt=300s, fixed backoff 1000ms (2 gaps): worstCase = 3*300 + 2*1 = 902s (clears
    // RECLAIM_FLOOR_SECONDS=900, so this isn't floor-masked either). An explicit cap of 7200s is
    // ABOVE that 902s schedule — the legitimate long-wait opt-in this feature exists to support.
    // Pre-B2-fix, computeClaimDeadline called worstCaseScheduleSeconds directly, ignoring the
    // cap entirely: horizon would read max(900, 902+60) = 962 — a premature claim_stale horizon
    // for a step that legitimately intends to wait up to 7200s. Post-fix: max(900, 7200+60) = 7260.
    const def = wf({
      work: {
        description: 'w',
        execution: 'auto',
        depends_on: [],
        timeout_seconds: 300,
        retry: {
          max_attempts: 3,
          backoff: 'fixed',
          base_delay_ms: 1000,
          total_timeout_seconds: 7200,
        },
      },
    });
    const deadline = computeClaimDeadline(def, 'work', NOW);
    expect(new Date(deadline!).getTime()).toBe(NOW.getTime() + 7260 * 1000);
  });
});

describe('classifyClaim', () => {
  it('healthy when a concrete deadline is in the future', () => {
    expect(classifyClaim({ deadline: new Date(NOW.getTime() + 1000).toISOString() }, NOW)).toBe(
      'healthy',
    );
  });
  it('claim_stale when the concrete deadline has passed', () => {
    expect(classifyClaim({ deadline: new Date(NOW.getTime() - 1000).toISOString() }, NOW)).toBe(
      'claim_stale',
    );
  });
  it('claim_unknown_age when the deadline is null', () => {
    expect(classifyClaim({ deadline: null }, NOW)).toBe('claim_unknown_age');
  });
  it('claim_unknown_age when there is no claim record (legacy run)', () => {
    expect(classifyClaim(undefined, NOW)).toBe('claim_unknown_age');
  });
});

describe('classifyInProgressClaims', () => {
  it('classifies each in-progress step; a missing claim is unknown-age', () => {
    const run = {
      in_progress_steps: ['a', 'b', 'c'],
      claims: {
        a: { deadline: new Date(NOW.getTime() + 1000).toISOString() },
        b: { deadline: new Date(NOW.getTime() - 1000).toISOString() },
        // c has no claim entry
      },
    } as unknown as RunRecord;
    const infos = classifyInProgressClaims(run, NOW);
    expect(infos).toEqual([
      { step: 'a', state: 'healthy', deadline: expect.any(String) },
      { step: 'b', state: 'claim_stale', deadline: expect.any(String) },
      { step: 'c', state: 'claim_unknown_age', deadline: null },
    ]);
  });
});

describe('omitClaim', () => {
  it('removes a key and never mutates the input', () => {
    const claims = { a: { deadline: null }, b: { deadline: null } };
    const result = omitClaim(claims, 'a');
    expect(result).toEqual({ b: { deadline: null } });
    expect(claims).toEqual({ a: { deadline: null }, b: { deadline: null } }); // unmutated
  });
  it('returns {} when the last claim is removed, and tolerates undefined', () => {
    expect(omitClaim({ a: { deadline: null } }, 'a')).toEqual({});
    expect(omitClaim(undefined, 'a')).toEqual({});
  });
});

describe('shouldEnforceTimeout (issue A3 — enforcement predicate)', () => {
  it('true for execution: auto', () => {
    expect(shouldEnforceTimeout({ description: 'w', execution: 'auto' })).toBe(true);
  });
  it('false for execution: agent', () => {
    expect(shouldEnforceTimeout({ description: 'w', execution: 'agent' })).toBe(false);
  });
  it('false for execution: guard', () => {
    expect(shouldEnforceTimeout({ description: 'w', execution: 'guard' })).toBe(false);
  });
  it('false for execution: finalizer', () => {
    expect(shouldEnforceTimeout({ description: 'w', execution: 'finalizer' })).toBe(false);
  });
  it('takes a single step, not a definition — hasFinalizers cannot be conjoined by construction (the blocking-fix)', () => {
    // shouldEnforceTimeout's signature has no `definition`/`hasFinalizers` parameter to read, unlike
    // computeClaimDeadline above. An auto step must stay enforced regardless of any finalizer
    // elsewhere in its workflow — this is the Design Reviewer's blocking-fix, documented as a test.
    expect(shouldEnforceTimeout({ description: 'w', execution: 'auto' })).toBe(true);
  });
});

describe('worstCaseScheduleSeconds (issue #140 — the shared formula)', () => {
  it('n=1 (no meaningful retry): reduces to exactly perAttemptSec, no backoff', () => {
    const retry: RetryConfig = { max_attempts: 1 };
    expect(worstCaseScheduleSeconds(retry, 300)).toBe(300);
  });

  it('fixed backoff: n×perAttempt + (n-1)×base_delay_ms — matches computeClaimDeadline’s own pre-existing pin', () => {
    // Same numbers as the "auto step with retry" computeClaimDeadline test above: n=5,
    // perAttempt=300s, fixed backoff 1000ms ⇒ worstCase = 5*300 + 4*1 = 1504.
    const retry: RetryConfig = { max_attempts: 5, backoff: 'fixed', base_delay_ms: 1000 };
    expect(worstCaseScheduleSeconds(retry, 300)).toBe(1504);
  });

  it('exponential backoff with a max_delay_ms cap: matches computeClaimDeadline’s own pre-existing pin', () => {
    // n=4, perAttempt=300s: 4*300=1200. Backoffs a=1,2,3: uncapped 1000/2000/4000ms, a=3 capped to
    // 3000ms ⇒ 1000+2000+3000=6000ms=6s. worstCase = 1206.
    const retry: RetryConfig = {
      max_attempts: 4,
      backoff: 'exponential',
      base_delay_ms: 1000,
      max_delay_ms: 3000,
    };
    expect(worstCaseScheduleSeconds(retry, 300)).toBe(1206);
  });
});

describe('resolveCapMs (issue #140 — the engine total-time cap resolver)', () => {
  it('explicit total_timeout_seconds overrides the default formula', () => {
    const retry: RetryConfig = { max_attempts: 5, total_timeout_seconds: 42 };
    // Explicit wins even though the formula would produce something totally different.
    expect(resolveCapMs(retry, 300_000)).toBe(42_000);
  });

  it('total_timeout_seconds: 0 is honored as a PRESENT cap via `!== undefined`, never truthiness', () => {
    // A hand-built definition (E2 forbids 0 in authored YAML) — the resolver itself must not use
    // `||`/truthiness, which would incorrectly fall through to the default formula for 0.
    const retry: RetryConfig = { max_attempts: 3, total_timeout_seconds: 0 };
    expect(resolveCapMs(retry, 1000)).toBe(0);
  });

  it('absent total_timeout_seconds falls back to the shared worst-case formula, seconds-in/ms-out', () => {
    const retry: RetryConfig = { max_attempts: 3, backoff: 'fixed', base_delay_ms: 10_000 };
    // timeoutMs=50_000ms (50s) per attempt: worstCase = 3*50 + 2*10 = 170s = 170_000ms.
    expect(resolveCapMs(retry, 50_000)).toBe(170_000);
  });

  it('B1 — retry without max_attempts defaults to n=1 (no NaN cascade): default cap === perAttempt ms exactly', () => {
    // max_attempts absent — loader-legal (only validated if present), type-illegal (RetryConfig
    // declares it required), hence the cast. n=1 ⇒ zero backoff terms ⇒ cap === perAttemptMs.
    const retry = { backoff: 'fixed', base_delay_ms: 1000 } as RetryConfig;
    expect(resolveCapMs(retry, 5000)).toBe(5000);
  });

  it('congruence-by-construction: resolveCapMs and computeClaimDeadline derive from the EXACT same formula — a divergent inline copy would break this equality', () => {
    // Fixture worst case clears RECLAIM_FLOOR_SECONDS (900) so the horizon's max(FLOOR, ...) picks
    // the worst-case branch, not the floor — otherwise the floor would mask any divergence.
    const retry: RetryConfig = {
      max_attempts: 4,
      backoff: 'exponential',
      base_delay_ms: 1000,
      max_delay_ms: 3000,
    };
    const perAttemptSec = 300;
    const def = wf({
      work: {
        description: 'w',
        execution: 'auto',
        depends_on: [],
        timeout_seconds: perAttemptSec,
        retry,
      },
    });
    const deadline = computeClaimDeadline(def, 'work', NOW);
    const horizonSeconds = (new Date(deadline!).getTime() - NOW.getTime()) / 1000;
    expect(horizonSeconds).toBeGreaterThan(RECLAIM_FLOOR_SECONDS); // confirms the fixture clears the floor

    const engineDefaultCapSeconds = resolveCapMs(retry, perAttemptSec * 1000) / 1000;
    // This is also the amendment's "default-cap horizon identity" pin (issue #140 §6): for a
    // step with no explicit total_timeout_seconds, horizon === today's worstCase + MARGIN exactly.
    expect(engineDefaultCapSeconds + RECLAIM_MARGIN_SECONDS).toBe(horizonSeconds);
  });

  it('B2 congruence-by-construction WITH an explicit cap set: resolveCapMs and computeClaimDeadline still derive from the exact same formula', () => {
    // The test above (no explicit cap) cannot see a B2-class divergence: with no cap, BOTH
    // resolveCapMs and (pre-fix) computeClaimDeadline reduce to the SAME worstCaseScheduleSeconds
    // call, so they agree even when computeClaimDeadline ignores resolveCapMs entirely. Only a
    // fixture with an EXPLICIT total_timeout_seconds can distinguish "consumes resolveCapMs" from
    // "calls worstCaseScheduleSeconds directly" — this is that fixture.
    const retry: RetryConfig = {
      max_attempts: 3,
      backoff: 'fixed',
      base_delay_ms: 1000,
      total_timeout_seconds: 7200,
    };
    const perAttemptSec = 300;
    const def = wf({
      work: {
        description: 'w',
        execution: 'auto',
        depends_on: [],
        timeout_seconds: perAttemptSec,
        retry,
      },
    });
    const deadline = computeClaimDeadline(def, 'work', NOW);
    const horizonSeconds = (new Date(deadline!).getTime() - NOW.getTime()) / 1000;
    const engineCapSeconds = resolveCapMs(retry, perAttemptSec * 1000) / 1000;
    expect(engineCapSeconds + RECLAIM_MARGIN_SECONDS).toBe(horizonSeconds);
  });
});

describe('sleepWouldExceedCap (issue #140 correction, S2 — the site-(c) sleep-guard predicate, extracted so its `>=` boundary is pinnable without real-timer precision)', () => {
  it('elapsed + wait === cap ⇒ true (the exact-fit boundary — reds under a `>` regression)', () => {
    expect(sleepWouldExceedCap(70, 30, 100)).toBe(true);
  });

  it('elapsed + wait === cap − 1 ⇒ false (one ms of genuine headroom)', () => {
    expect(sleepWouldExceedCap(70, 29, 100)).toBe(false);
  });
});
