// Tests for the #508 trust vocabulary: TRUST_LEVELS/GATE_TRUST_LEVELS/SERVICE_TRUST_LEVELS,
// classifyStepTrust, and isGateTrust. The compile-time drift guards (Missing/Extra/subset checks
// on the three `as const satisfies` arrays) are TYPE-LEVEL and verified by deleting a member and
// confirming a real tsc error — that verification is a one-time manual RAIL, not something
// expressible as a runtime assertion, so it is not re-encoded here; these cells cover the pure
// runtime behavior classifyStepTrust/isGateTrust actually execute.
import { describe, it, expect } from 'vitest';
import {
  TRUST_LEVELS,
  GATE_TRUST_LEVELS,
  SERVICE_TRUST_LEVELS,
  classifyStepTrust,
  isGateTrust,
} from './workflow-definition.js';

describe('TRUST_LEVELS / GATE_TRUST_LEVELS / SERVICE_TRUST_LEVELS', () => {
  it('TRUST_LEVELS is exactly the three-member vocabulary (human_notified retired)', () => {
    expect(TRUST_LEVELS).toEqual(['auto', 'human_confirmed', 'human_reviewed']);
  });

  it('GATE_TRUST_LEVELS is the proper subset that actually gates — auto excluded', () => {
    expect(GATE_TRUST_LEVELS).toEqual(['human_confirmed', 'human_reviewed']);
    expect(GATE_TRUST_LEVELS).not.toContain('auto');
  });

  it('SERVICE_TRUST_LEVELS is the separate service-level vocabulary — disjoint from TRUST_LEVELS', () => {
    expect(SERVICE_TRUST_LEVELS).toEqual(['engine_delivered', 'engine_managed', 'agent_provided']);
    for (const v of SERVICE_TRUST_LEVELS) {
      expect((TRUST_LEVELS as readonly string[]).includes(v)).toBe(false);
    }
  });
});

describe('classifyStepTrust — arm order is normative (issue #508 design review, mutant iii)', () => {
  // GATE_TRUST_LEVELS membership is tested BEFORE the 'auto' shortcut on auto/agent. This cell is
  // the direct pin for that ordering: 'auto' resolves via the shortcut (GATE_TRUST_LEVELS does
  // NOT contain 'auto', so membership-first correctly falls through to the shortcut) — but a
  // mutant that collapsed GATE_TRUST_LEVELS into TRUST_LEVELS at this call site (not just at the
  // execution-loop.ts mint, which mutant (iii) covers separately) would make 'auto' match
  // TRUST_LEVELS-membership FIRST and misclassify it as 'gates'.
  it("classifyStepTrust('auto', 'auto') === 'lawful_no_gate' — not 'gates'", () => {
    expect(classifyStepTrust('auto', 'auto')).toBe('lawful_no_gate');
    expect(classifyStepTrust('agent', 'auto')).toBe('lawful_no_gate');
  });

  it("classifyStepTrust(kind, 'human_confirmed'/'human_reviewed') === 'gates' on auto/agent", () => {
    expect(classifyStepTrust('auto', 'human_confirmed')).toBe('gates');
    expect(classifyStepTrust('auto', 'human_reviewed')).toBe('gates');
    expect(classifyStepTrust('agent', 'human_confirmed')).toBe('gates');
    expect(classifyStepTrust('agent', 'human_reviewed')).toBe('gates');
  });

  it('absence classifies lawful_no_gate on EVERY kind, including undefined kind and guard', () => {
    expect(classifyStepTrust('auto', undefined)).toBe('lawful_no_gate');
    expect(classifyStepTrust('agent', undefined)).toBe('lawful_no_gate');
    expect(classifyStepTrust('guard', undefined)).toBe('lawful_no_gate');
    expect(classifyStepTrust('finalizer', undefined)).toBe('lawful_no_gate');
    expect(classifyStepTrust(undefined, undefined)).toBe('lawful_no_gate');
  });

  it('any non-auto value on auto/agent that is not a gate literal is refuse', () => {
    expect(classifyStepTrust('auto', 'engine_delivered')).toBe('refuse');
    expect(classifyStepTrust('agent', 'human_notified')).toBe('refuse');
    expect(classifyStepTrust('auto', 'nope')).toBe('refuse');
    expect(classifyStepTrust('agent', null)).toBe('refuse');
    expect(classifyStepTrust('auto', 123)).toBe('refuse');
  });

  it("finalizer: only 'auto' is lawful, everything else — including the gate literals — refuses", () => {
    expect(classifyStepTrust('finalizer', 'auto')).toBe('lawful_no_gate');
    expect(classifyStepTrust('finalizer', 'human_confirmed')).toBe('refuse');
    expect(classifyStepTrust('finalizer', 'human_reviewed')).toBe('refuse');
    expect(classifyStepTrust('finalizer', 'engine_delivered')).toBe('refuse');
  });

  it('guard: any DECLARED value refuses, including a value that would be lawful elsewhere', () => {
    expect(classifyStepTrust('guard', 'auto')).toBe('refuse');
    expect(classifyStepTrust('guard', 'human_confirmed')).toBe('refuse');
    expect(classifyStepTrust('guard', 'nope')).toBe('refuse');
    // Absence stays lawful even on guard — the absence-first arm in the module doc.
    expect(classifyStepTrust('guard', undefined)).toBe('lawful_no_gate');
  });

  it('an out-of-range kind (a malformed execution the loader would itself refuse) refuses any declared value, same as guard', () => {
    expect(classifyStepTrust('bogus' as never, 'auto')).toBe('refuse');
    expect(classifyStepTrust('bogus' as never, undefined)).toBe('lawful_no_gate');
  });
});

describe('isGateTrust — the single-sourced gate-mint predicate', () => {
  it('true for exactly the two gate literals', () => {
    expect(isGateTrust('human_confirmed')).toBe(true);
    expect(isGateTrust('human_reviewed')).toBe(true);
  });

  it('false for auto, absence, and any unrecognized value — never throws', () => {
    expect(isGateTrust('auto')).toBe(false);
    expect(isGateTrust(undefined)).toBe(false);
    expect(isGateTrust(null)).toBe(false);
    expect(isGateTrust('')).toBe(false);
    expect(isGateTrust(123)).toBe(false);
    expect(isGateTrust([])).toBe(false);
    expect(isGateTrust('human_notified')).toBe(false);
    expect(isGateTrust('engine_delivered')).toBe(false);
  });
});
