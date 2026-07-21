// Loader validation for issue #220 §4c (PR-3) — the `$settlement.<dep>.<field>` reference on the
// three condition surfaces (when/abort_unless/preconditions). Letter labels match the design
// record's §5 pin set (dd, kk, cc) for mechanical diffing against mutation probes.
import { describe, it, expect } from 'vitest';
import { loadWorkflowFromString } from './yaml-loader.js';
import { WorkflowError } from '../types/workflow-error.js';

function expectThrows(yaml: string, substring: string): void {
  expect(() => loadWorkflowFromString(yaml)).toThrow(WorkflowError);
  try {
    loadWorkflowFromString(yaml);
    throw new Error('expected loadWorkflowFromString to throw');
  } catch (err) {
    expect((err as WorkflowError).message).toContain(substring);
  }
}

function expectRegistersClean(yaml: string): void {
  expect(() => loadWorkflowFromString(yaml)).not.toThrow();
}

describe('yaml-loader — issue #220 §4c $settlement references', () => {
  describe('(dd) isPathShaped carve-out is prefix-EXACT — never a general $ allowance', () => {
    it('a bare `$foo` (not $settlement) on `when` is refused by the GENERIC path-shape check, not the $settlement one', () => {
      expectThrows(
        `
id: settlement-dd-foo-wf
name: Settlement DD Foo
version: 1
steps:
  a:
    description: A
    execution: auto
    handler: h
    depends_on: []
  b:
    description: B
    execution: auto
    handler: h
    depends_on: [a]
    when: ["$foo"]
`,
        'is not a valid path or comparison',
      );
    });

    it('a bare `$` alone on `when` is refused', () => {
      expectThrows(
        `
id: settlement-dd-bare-wf
name: Settlement DD Bare
version: 1
steps:
  a:
    description: A
    execution: auto
    handler: h
    depends_on: []
  b:
    description: B
    execution: auto
    handler: h
    depends_on: [a]
    when: ["$"]
`,
        'is not a valid path or comparison',
      );
    });

    it('$settlement.a b (garbage remainder — an internal space) is refused via the $settlement-SPECIFIC path-shape message, not the generic one', () => {
      expectThrows(
        `
id: settlement-dd-garbage-wf
name: Settlement DD Garbage
version: 1
steps:
  a:
    description: A
    execution: auto
    handler: h
    depends_on: []
  b:
    description: B
    execution: auto
    handler: h
    depends_on: [a]
    when: ["$settlement.a b"]
`,
        "invalid '$settlement' reference",
      );
    });
  });

  describe('(kk) one-hop load-refusal fires on ALL THREE surfaces', () => {
    it('`when`: $settlement.<non-dep> is load-refused with the one-hop/depends_on message', () => {
      expectThrows(
        `
id: settlement-kk-when-wf
name: Settlement KK When
version: 1
steps:
  a:
    description: A
    execution: auto
    handler: h
    depends_on: []
  other:
    description: Other
    execution: auto
    handler: h
    depends_on: []
  b:
    description: B
    execution: auto
    handler: h
    depends_on: [a]
    when: ["$settlement.other.settled_by_default == false"]
`,
        'one-hop rule',
      );
    });

    it('`abort_unless` (guard): $settlement.<non-dep> is load-refused with the one-hop/depends_on message', () => {
      expectThrows(
        `
id: settlement-kk-guard-wf
name: Settlement KK Guard
version: 1
steps:
  a:
    description: A
    execution: auto
    handler: h
    depends_on: []
  other:
    description: Other
    execution: auto
    handler: h
    depends_on: []
  guard_step:
    description: Guard
    execution: guard
    depends_on: [a]
    abort_unless: ["$settlement.other.settled_by_default == false"]
`,
        'one-hop rule',
      );
    });

    it('`preconditions`: $settlement.<non-dep> (COMPARISON spelling, not a bare path) is load-refused with the one-hop/depends_on message — NOT the must-be-comparison message', () => {
      expectThrows(
        `
id: settlement-kk-precond-wf
name: Settlement KK Precondition
version: 1
steps:
  a:
    description: A
    execution: auto
    handler: h
    depends_on: []
  other:
    description: Other
    execution: auto
    handler: h
    depends_on: []
  b:
    description: B
    execution: auto
    handler: h
    depends_on: [a]
    preconditions: ["$settlement.other.settled_by_default == false"]
`,
        'one-hop rule',
      );
    });

    it('`preconditions`: a BARE $settlement path (no comparison) is refused for the PRE-EXISTING must-be-comparison reason, not the one-hop reason (the wrong-reason pass this pin guards against)', () => {
      expectThrows(
        `
id: settlement-kk-precond-bare-wf
name: Settlement KK Precondition Bare
version: 1
steps:
  a:
    description: A
    execution: auto
    handler: h
    depends_on: []
  b:
    description: B
    execution: auto
    handler: h
    depends_on: [a]
    preconditions: ["$settlement.a.settled_by_default"]
`,
        'must be a comparison',
      );
    });
  });

  describe('positive registration — a valid $settlement.<dep>.<field> leaf registers clean on all three surfaces', () => {
    it('`when`', () => {
      expectRegistersClean(`
id: settlement-pos-when-wf
name: Settlement Positive When
version: 1
steps:
  a:
    description: A
    execution: auto
    handler: h
    depends_on: []
  b:
    description: B
    execution: auto
    handler: h
    depends_on: [a]
    when: ["$settlement.a.settled_by_default == false"]
`);
    });

    it('`abort_unless` (guard)', () => {
      expectRegistersClean(`
id: settlement-pos-guard-wf
name: Settlement Positive Guard
version: 1
steps:
  a:
    description: A
    execution: auto
    handler: h
    depends_on: []
  guard_step:
    description: Guard
    execution: guard
    depends_on: [a]
    abort_unless: ["$settlement.a.settled_by_default == false"]
`);
    });

    it('`preconditions`', () => {
      expectRegistersClean(`
id: settlement-pos-precond-wf
name: Settlement Positive Precondition
version: 1
steps:
  a:
    description: A
    execution: auto
    handler: h
    depends_on: []
  b:
    description: B
    execution: auto
    handler: h
    depends_on: [a]
    preconditions: ["$settlement.a.settled_by_default == false"]
`);
    });
  });

  describe('(cc) reserved-name refusal still holds (PR-1, verify only)', () => {
    it('$settlement is still refused as a step id', () => {
      expectThrows(
        `
id: settlement-cc-wf
name: Settlement CC
version: 1
steps:
  $settlement:
    description: Work
    execution: auto
    handler: h
`,
        "Step name '$settlement' is reserved",
      );
    });
  });
});
