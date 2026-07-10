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
} from './claim-liveness.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
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
