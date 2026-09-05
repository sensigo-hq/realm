// Loader validation for issue #291: the `gate.timeout_seconds` / `gate.on_expiry` /
// `gate.default_choice` / `gate.reminder_seconds` / `gate.reminder_max` sub-keys — the FIRST
// gate sub-key validation the loader has ever had. Deliverable 1.
import { describe, it, expect } from 'vitest';
import { loadWorkflowFromString, loadWorkflowFromStringWithDiagnostics } from './yaml-loader.js';
import { WorkflowError } from '../types/workflow-error.js';
import { renderLoaderWarning } from './diagnostics.js';

function expectThrows(yaml: string, substring: string): void {
  expect(() => loadWorkflowFromString(yaml)).toThrow(WorkflowError);
  try {
    loadWorkflowFromString(yaml);
    throw new Error('expected loadWorkflowFromString to throw');
  } catch (err) {
    expect((err as WorkflowError).message).toContain(substring);
  }
}

/** Like `expectThrows`, but pins several fragments of the SAME thrown message at once (issue
 *  #433's four-clause errors — one substring check per clause). Additive; `expectThrows` above
 *  is untouched. */
function expectThrowsAll(yaml: string, substrings: readonly string[]): void {
  expect(() => loadWorkflowFromString(yaml)).toThrow(WorkflowError);
  try {
    loadWorkflowFromString(yaml);
    throw new Error('expected loadWorkflowFromString to throw');
  } catch (err) {
    const message = (err as WorkflowError).message;
    for (const s of substrings) {
      expect(message).toContain(s);
    }
  }
}

function gateWorkflow(gateBlock: string, extra = ''): string {
  return `
id: gate-timeout-wf
name: Gate Timeout Fixture
version: 1
steps:
  approve:
    description: Approve
    execution: auto
    handler: h
    trust: human_confirmed
    gate:
${gateBlock}
${extra}
`;
}

describe('yaml-loader — issue #291 gate.* sub-keys', () => {
  describe('unknown key warning', () => {
    it("warns on a typo'd gate sub-key, never rejects", () => {
      const { warnings } = loadWorkflowFromStringWithDiagnostics(
        gateWorkflow('      timeout_secondz: 60'),
      );
      const gateWarning = warnings.find((w) => w.code === 'UNKNOWN_GATE_KEY');
      expect(gateWarning).toBeDefined();
      expect(renderLoaderWarning(gateWarning!)).toContain("unknown key 'timeout_secondz'");
      expect(renderLoaderWarning(gateWarning!)).toContain('did you mean');
    });
  });

  describe('E2 positive-integer checks', () => {
    it('rejects timeout_seconds: 0', () => {
      expectThrows(
        gateWorkflow('      timeout_seconds: 0'),
        "'gate.timeout_seconds' must be a positive integer",
      );
    });
    it('rejects timeout_seconds: -1', () => {
      expectThrows(
        gateWorkflow('      timeout_seconds: -1'),
        "'gate.timeout_seconds' must be a positive integer",
      );
    });
    it('rejects reminder_seconds: 0', () => {
      expectThrows(
        gateWorkflow('      reminder_seconds: 0'),
        "'gate.reminder_seconds' must be a positive integer",
      );
    });
    it('rejects reminder_max: 0', () => {
      expectThrows(
        gateWorkflow(
          '      timeout_seconds: 600\n      reminder_seconds: 60\n      reminder_max: 0',
        ),
        "'gate.reminder_max' must be a positive integer",
      );
    });
  });

  describe('on_expiry enum', () => {
    it('rejects an invalid on_expiry value', () => {
      expectThrows(
        gateWorkflow('      timeout_seconds: 60\n      on_expiry: retry'),
        "'gate.on_expiry' must be 'settle_default' or 'abort'",
      );
    });
    it('accepts on_expiry: abort with no default_choice', () => {
      const def = loadWorkflowFromString(
        gateWorkflow('      timeout_seconds: 60\n      on_expiry: abort'),
      );
      expect(def.steps['approve']!.gate?.on_expiry).toBe('abort');
    });
  });

  describe('default_choice required-iff settle_default (hard error both directions)', () => {
    it('rejects settle_default with no default_choice', () => {
      expectThrows(
        gateWorkflow('      timeout_seconds: 60\n      on_expiry: settle_default'),
        "'gate.on_expiry: settle_default' requires 'gate.default_choice'",
      );
    });
    it('accepts settle_default with a valid default_choice from the builtin fallback set', () => {
      const def = loadWorkflowFromString(
        gateWorkflow(
          '      timeout_seconds: 60\n      on_expiry: settle_default\n      default_choice: approve',
        ),
      );
      expect(def.steps['approve']!.gate?.default_choice).toBe('approve');
    });
    it('rejects a default_choice not in the declared gate.choices set', () => {
      expectThrows(
        gateWorkflow(
          '      choices: [yes, no]\n      timeout_seconds: 60\n      on_expiry: settle_default\n      default_choice: approve',
        ),
        "'gate.default_choice' (\"approve\") is not one of the step's effective choices: yes, no",
      );
    });
    it('accepts a default_choice matching the declared gate.choices set', () => {
      const def = loadWorkflowFromString(
        gateWorkflow(
          '      choices: [yes, no]\n      timeout_seconds: 60\n      on_expiry: settle_default\n      default_choice: yes',
        ),
      );
      expect(def.steps['approve']!.gate?.default_choice).toBe('yes');
    });
    it('validates default_choice against input_schema.properties.choice.enum when gate.choices is absent', () => {
      const def = loadWorkflowFromString(
        gateWorkflow(
          '      timeout_seconds: 60\n      on_expiry: settle_default\n      default_choice: ship',
          `    input_schema:
      type: object
      properties:
        choice:
          type: string
          enum: [ship, hold]
      required: [choice]`,
        ),
      );
      expect(def.steps['approve']!.gate?.default_choice).toBe('ship');
    });
  });

  describe('the two LEGAL cells (must NOT warn or error)', () => {
    it('timeout_seconds WITHOUT on_expiry is LEGAL finding-only mode — no warning at all', () => {
      const { warnings } = loadWorkflowFromStringWithDiagnostics(
        gateWorkflow('      timeout_seconds: 60'),
      );
      expect(warnings.filter((w) => w.code === 'DEAD_GATE_CONFIG')).toEqual([]);
    });
    it('reminder_seconds WITHOUT timeout_seconds is LEGAL pure-notify mode — no warning at all', () => {
      const { warnings } = loadWorkflowFromStringWithDiagnostics(
        gateWorkflow('      reminder_seconds: 300'),
      );
      expect(warnings.filter((w) => w.code === 'DEAD_GATE_CONFIG')).toEqual([]);
    });
  });

  describe('dead-config warn cells (never reject)', () => {
    it('warns: on_expiry declared without timeout_seconds', () => {
      const { warnings } = loadWorkflowFromStringWithDiagnostics(
        gateWorkflow('      on_expiry: abort'),
      );
      const w = warnings.find((x) => x.code === 'DEAD_GATE_CONFIG');
      expect(w?.message).toContain("'gate.on_expiry' is ignored without 'gate.timeout_seconds'");
    });
    it('warns: default_choice with on_expiry: abort', () => {
      const { warnings } = loadWorkflowFromStringWithDiagnostics(
        gateWorkflow(
          '      timeout_seconds: 60\n      on_expiry: abort\n      default_choice: approve',
        ),
      );
      const w = warnings.find((x) => x.code === 'DEAD_GATE_CONFIG');
      expect(w?.message).toContain("'gate.default_choice' is ignored without");
    });
    it('warns: default_choice with no on_expiry at all', () => {
      const { warnings } = loadWorkflowFromStringWithDiagnostics(
        gateWorkflow('      default_choice: approve'),
      );
      const w = warnings.find((x) => x.code === 'DEAD_GATE_CONFIG');
      expect(w?.message).toContain("'gate.default_choice' is ignored without");
    });
    it('warns [F-A2-5]: reminder_seconds >= timeout_seconds (dead notification)', () => {
      const { warnings } = loadWorkflowFromStringWithDiagnostics(
        gateWorkflow('      timeout_seconds: 60\n      reminder_seconds: 60'),
      );
      const w = warnings.find((x) => x.code === 'DEAD_GATE_CONFIG');
      expect(w?.message).toContain('the first reminder would never fire before the gate expires');
    });
    it('does NOT warn when reminder_seconds < timeout_seconds', () => {
      const { warnings } = loadWorkflowFromStringWithDiagnostics(
        gateWorkflow('      timeout_seconds: 600\n      reminder_seconds: 60'),
      );
      expect(warnings.filter((w) => w.code === 'DEAD_GATE_CONFIG')).toEqual([]);
    });
  });

  describe('a step with no gate: block at all is unaffected', () => {
    it('no gate warnings or errors on a plain gated step', () => {
      const { warnings } = loadWorkflowFromStringWithDiagnostics(`
id: plain-gate-wf
name: Plain Gate
version: 1
steps:
  approve:
    description: Approve
    execution: auto
    handler: h
    trust: human_confirmed
`);
      expect(
        warnings.filter((w) => w.code === 'UNKNOWN_GATE_KEY' || w.code === 'DEAD_GATE_CONFIG'),
      ).toEqual([]);
    });
  });
});

// =================================================================================================
// issue #433 — a DECLARED-and-EMPTY gate choice source is a load error, all three member shapes:
// (a) `gate.choices: []`; (b) a gate-trusted step's `input_schema.properties.choice.enum: []`
// with no `gate.choices` list declared (nullish — `gate: {choices:}` YAML-null included); the
// engine's own mint derivation (execution-loop.ts's gate-open site) is
// `gate.choices ?? input_schema.properties.choice.enum ?? ['approve', 'reject']` — an empty ARRAY
// from EITHER source defeats the `??` default, minting a gate no response can ever resolve, with
// no disposal path short of an authored `gate.timeout_seconds` + `on_expiry` expiry (abandon,
// purge, and drain all refuse a live, non-terminal wedge).
//
// `gateWorkflow()` above always emits a `gate:` block and hardcodes `trust: human_confirmed` — it
// cannot express "no gate: block at all" (member (b)'s own live population) or an ungated step
// (C6/C7's scope-boundary controls), so those cells use standalone fixture strings, following the
// ":a step with no gate: block at all is unaffected" precedent just above.
// =================================================================================================

describe('yaml-loader — issue #433 gate choice source: declared-empty is a load error', () => {
  describe('member (a): gate.choices declared and empty', () => {
    it('C1 gate-trusted, choices: [] — the four-clause error, corrected remedy chain, key-line cite', () => {
      expectThrowsAll(gateWorkflow('      choices: []'), [
        "'gate.choices', when declared, must be non-empty",
        'no disposal path',
        "remove the key to fall back to 'input_schema.properties.choice.enum' or the default pair",
        '(line 12)',
      ]);
    });
  });

  describe('member (b): a gate-trusted step, no gate.choices list declared, empty enum', () => {
    it('C2 NO gate: block at all + enum: [] — the member-(b) error, enum key-line cite', () => {
      expectThrowsAll(
        `
id: g433b-wf
name: G433b
version: 1
steps:
  approve:
    description: Approve
    execution: auto
    handler: h
    trust: human_confirmed
    input_schema:
      type: object
      properties:
        choice:
          type: string
          enum: []
      required: [choice]
`,
        [
          "'input_schema.properties.choice.enum' is this gate's effective choice source",
          'no disposal path',
          "remove 'enum' to get the default pair (approve/reject)",
          '(line 16)',
        ],
      );
    });

    it('C2b gate: block PRESENT (timeout_seconds: 60, no choices) + enum: [] — same error', () => {
      expectThrowsAll(
        gateWorkflow(
          '      timeout_seconds: 60',
          `    input_schema:
      type: object
      properties:
        choice:
          type: string
          enum: []
      required: [choice]`,
        ),
        [
          "'input_schema.properties.choice.enum' is this gate's effective choice source",
          '(line 18)',
        ],
      );
    });

    it('C2c the third wedge: gate: {choices:} (YAML null) + enum: [] — member (b) fires (nullish keying)', () => {
      expectThrowsAll(
        gateWorkflow(
          '      choices:',
          `    input_schema:
      type: object
      properties:
        choice:
          type: string
          enum: []
      required: [choice]`,
        ),
        ["'input_schema.properties.choice.enum' is this gate's effective choice source"],
      );
    });
  });

  describe('controls (must NOT error)', () => {
    it('C3 gate-trusted, no choices, no enum — loads (the mint default: execution-loop.test.ts:1680-1681, fixture :1644)', () => {
      const def = loadWorkflowFromString(gateWorkflow('      timeout_seconds: 60'));
      expect(def.steps['approve']!.gate?.choices).toBeUndefined();
    });

    it('C3b gate-trusted, gate: {choices:} (null-valued), NO enum — loads (the nullish shape alone is legal)', () => {
      // choices: (YAML null) parses to and stays `null` on the loaded definition — it is not
      // stripped — so this asserts null, not undefined (the C3 control above, which never
      // declares the key at all, correctly asserts undefined).
      const def = loadWorkflowFromString(gateWorkflow('      choices:'));
      expect(def.steps['approve']!.gate?.choices).toBeNull();
    });

    it('C4 gate-trusted, choices: [approve, reject] — loads', () => {
      const def = loadWorkflowFromString(gateWorkflow('      choices: [approve, reject]'));
      expect(def.steps['approve']!.gate?.choices).toEqual(['approve', 'reject']);
    });

    it("C9 precedence control: choices: [approve] + enum: [] — loads (choices wins the chain, as the mint's ?? does)", () => {
      const def = loadWorkflowFromString(
        gateWorkflow(
          '      choices: [approve]',
          `    input_schema:
      type: object
      properties:
        choice:
          type: string
          enum: []
      required: [choice]`,
        ),
      );
      expect(def.steps['approve']!.gate?.choices).toEqual(['approve']);
    });
  });

  it('C5 composition: choices: [] + timeout_seconds + on_expiry: settle_default + default_choice — BOTH errors accumulate (#425)', () => {
    // Red-first (lane-executed, NOT loads-clean): on main this fixture throws TODAY with exactly
    // ONE err.errors entry (the pre-existing default_choice membership error, trailing-empty
    // list, step-line cite) — the red this cell adds is the ABSENT non-empty boundary, not a
    // clean load.
    const yaml = gateWorkflow(
      '      choices: []\n      timeout_seconds: 60\n      on_expiry: settle_default\n      default_choice: approve',
    );
    try {
      loadWorkflowFromString(yaml);
      throw new Error('expected loadWorkflowFromString to throw');
    } catch (err) {
      const errors = (err as WorkflowError).errors ?? [(err as WorkflowError).message];
      expect(
        errors.some((e) => e.includes("'gate.choices', when declared, must be non-empty")),
      ).toBe(true);
      expect(errors.some((e) => e.includes("is not one of the step's effective choices"))).toBe(
        true,
      );
      expect(errors).toHaveLength(2);
    }
  });

  it('C6 the scope boundary: UNGATED step, no gate block, enum: [] — still loads (a schema-validity question, different class)', () => {
    const def = loadWorkflowFromString(`
id: g433e-wf
name: G433e
version: 1
steps:
  step1:
    description: a
    execution: auto
    handler: h
    input_schema:
      type: object
      properties:
        choice:
          type: string
          enum: []
      required: [choice]
`);
    expect(def.steps['step1']!.trust).toBeUndefined();
  });

  it('C7 member (a) on an UNGATED step (gate: {choices: []}, no trust) — refused, SAME message (population-invariant)', () => {
    expectThrows(
      `
id: g433f-wf
name: G433f
version: 1
steps:
  step1:
    description: a
    execution: auto
    handler: h
    gate:
      choices: []
`,
      "'gate.choices', when declared, must be non-empty",
    );
  });

  // The both-declared-empty composition (`gate.choices: []` + `enum: []`): member (a) fires
  // (declaredGateChoices is `[]`, satisfying its own conjunct); member (b) stays silent (its
  // `declaredGateChoices == null` conjunct is false — an empty ARRAY is not nullish). One error,
  // not two; no dedicated cell (C1 + C9 already exercise each conjunct independently).
});
