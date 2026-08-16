// structured-output-eligibility.test.ts — issue #236 verdict function tests.
// Fixture classes C1-C14 are SYNTHETIC clones per design record §10 / prompt Deliverable 10 — never
// derived from ~/.realm, invented domains, anonymized. Class letters/numbers below mirror the
// prompt's own C1-C14 table verbatim so the mapping is auditable.
import { describe, it, expect } from 'vitest';
import { assessStructuredOutputEligibility } from './structured-output-eligibility.js';
import type { JsonSchema } from '../types/workflow-definition.js';

describe('assessStructuredOutputEligibility — Phase A (step-definition entry)', () => {
  // C1: AP-missing-only (else clean; 2 required, 1 optional) ⇒ ineligible(G1), sole failure.
  it('C1: missing additionalProperties, otherwise clean ⇒ ineligible(G1) alone', () => {
    const v = assessStructuredOutputEligibility({
      output_schema: {
        type: 'object',
        required: ['category', 'priority'],
        properties: {
          category: { type: 'string' },
          priority: { type: 'string' },
          note: { type: 'string' },
        },
      },
    });
    expect(v.verdict).toBe('ineligible');
    if (v.verdict !== 'ineligible') throw new Error('unreachable');
    expect(v.reasons).toHaveLength(1);
    expect(v.reasons[0]?.code).toBe('missing_additional_properties');
    expect(v.caveats).toBeUndefined();
  });

  // C2: AP-missing + minLength ⇒ G1 + caveat-class keyword.
  it('C2: missing AP + minLength ⇒ ineligible(G1) carrying the minLength caveat too', () => {
    const v = assessStructuredOutputEligibility({
      output_schema: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string', minLength: 3 } },
      },
    });
    expect(v.verdict).toBe('ineligible');
    if (v.verdict !== 'ineligible') throw new Error('unreachable');
    expect(v.reasons.map((r) => r.code)).toEqual(['missing_additional_properties']);
    expect(v.caveats).toBeDefined();
    expect(v.caveats?.[0]?.code).toBe('unenforced_keyword');
  });

  // C3: AP-missing + minimum/maximum ⇒ G1 + G2-hard.
  it('C3: missing AP + minimum/maximum ⇒ ineligible with BOTH G1 and G2-hard reasons', () => {
    const v = assessStructuredOutputEligibility({
      output_schema: {
        type: 'object',
        required: ['age'],
        properties: { age: { type: 'integer', minimum: 0, maximum: 120 } },
      },
    });
    expect(v.verdict).toBe('ineligible');
    if (v.verdict !== 'ineligible') throw new Error('unreachable');
    const codes = v.reasons.map((r) => r.code);
    expect(codes).toContain('missing_additional_properties');
    expect(codes.filter((c) => c === 'unsupported_keyword')).toHaveLength(2); // minimum + maximum
  });

  // C4: AP-missing + both (minimum/maximum AND minLength) ⇒ G1+G2h+caveat.
  it('C4: missing AP + minimum + minLength ⇒ ineligible(G1+G2h) carrying the minLength caveat', () => {
    const v = assessStructuredOutputEligibility({
      output_schema: {
        type: 'object',
        required: ['age', 'name'],
        properties: {
          age: { type: 'integer', minimum: 0 },
          name: { type: 'string', minLength: 1 },
        },
      },
    });
    expect(v.verdict).toBe('ineligible');
    if (v.verdict !== 'ineligible') throw new Error('unreachable');
    const codes = v.reasons.map((r) => r.code);
    expect(codes).toContain('missing_additional_properties');
    expect(codes).toContain('unsupported_keyword');
    expect(v.caveats?.some((c) => c.code === 'unenforced_keyword')).toBe(true);
  });

  // C5: AP-present + minimum/maximum only ⇒ ineligible(G2-hard) alone.
  it('C5: AP present + minimum/maximum only ⇒ ineligible(G2-hard) alone, no G1', () => {
    const v = assessStructuredOutputEligibility({
      output_schema: {
        type: 'object',
        additionalProperties: false,
        required: ['age'],
        properties: { age: { type: 'integer', minimum: 0, maximum: 120 } },
      },
    });
    expect(v.verdict).toBe('ineligible');
    if (v.verdict !== 'ineligible') throw new Error('unreachable');
    expect(v.reasons.every((r) => r.code === 'unsupported_keyword')).toBe(true);
  });

  // C6: ALL-pass with an optional reasoning-like property LAST ⇒ eligible_with_caveats(optional_emission).
  it('C6: fully clean schema with an optional reasoning-like property LAST ⇒ eligible_with_caveats(optional_emission)', () => {
    const v = assessStructuredOutputEligibility({
      output_schema: {
        type: 'object',
        additionalProperties: false,
        required: ['category'],
        properties: {
          category: { type: 'string' },
          reasoning: { type: 'string' },
        },
      },
    });
    expect(v.verdict).toBe('eligible_with_caveats');
    if (v.verdict !== 'eligible_with_caveats') throw new Error('unreachable');
    expect(v.caveats.map((c) => c.code)).toEqual(['optional_emission']);
  });

  // C7: no required key + AP missing ⇒ G1 (required-absence is LEGAL — assert no reason for it).
  it('C7: no `required` key at all + AP missing ⇒ ONLY G1 — absent `required` is legal, no reason for it', () => {
    const v = assessStructuredOutputEligibility({
      output_schema: {
        type: 'object',
        properties: { note: { type: 'string' } },
      },
    });
    expect(v.verdict).toBe('ineligible');
    if (v.verdict !== 'ineligible') throw new Error('unreachable');
    expect(v.reasons).toHaveLength(1);
    expect(v.reasons[0]?.code).toBe('missing_additional_properties');
  });

  // C8 (INVERTED by issue #311): a tools-bearing step is ACCEPTED at Phase A with the
  // `tools_runtime_assessed` nudge instead of being rejected. This doubles as the COMPOSITE cell
  // — the step-level output_schema here would ALSO be G1+G2-hard, and the tools arm must still
  // short-circuit BEFORE the schema walk, because that schema is never grammar-constrained on
  // the tools fork. Exactly one caveat, no reasons, and no walk-derived findings leak in.
  it('C8: tools-bearing step ⇒ eligible_with_caveats(tools_runtime_assessed) exactly — short-circuits the schema walk even when that schema is itself ineligible', () => {
    const v = assessStructuredOutputEligibility({
      output_schema: {
        type: 'object',
        required: ['age'],
        properties: { age: { type: 'integer', minimum: 0 } }, // would ALSO be G1+G2-hard
      },
      tools: ['srv:tool'],
    });
    expect(v.verdict).toBe('eligible_with_caveats');
    if (v.verdict !== 'eligible_with_caveats') throw new Error('unreachable');
    expect(v.caveats).toHaveLength(1);
    expect(v.caveats[0]?.code).toBe('tools_runtime_assessed');
    // The walk never ran, so no optional count is reported (never a false 0).
    expect(v.optional_count).toBeUndefined();
  });

  // C9: pattern (supported subset) + enum ⇒ caveat(G5) — enum here is simple, no G2-hard.
  it('C9: pattern + a simple enum ⇒ eligible_with_caveats(unenforced_pattern) only', () => {
    const v = assessStructuredOutputEligibility({
      output_schema: {
        type: 'object',
        additionalProperties: false,
        required: ['code', 'status'],
        properties: {
          code: { type: 'string', pattern: '^[A-Z]{3}$' },
          status: { type: 'string', enum: ['open', 'closed'] },
        },
      },
    });
    expect(v.verdict).toBe('eligible_with_caveats');
    if (v.verdict !== 'eligible_with_caveats') throw new Error('unreachable');
    expect(v.caveats.map((c) => c.code)).toEqual(['unenforced_pattern']);
  });

  // C10a: opted step with no schema at all ⇒ G0 (absent remediation).
  it('C10a: no schema at all ⇒ ineligible(G0), the "add output_schema" remediation', () => {
    const v = assessStructuredOutputEligibility({});
    expect(v.verdict).toBe('ineligible');
    if (v.verdict !== 'ineligible') throw new Error('unreachable');
    expect(v.reasons).toHaveLength(1);
    expect(v.reasons[0]?.code).toBe('no_schema');
    expect(v.reasons[0]?.remediation).toContain('add output_schema');
  });

  // C10b: root type:'array' ⇒ G0 (non-object remediation) — a DIFFERENT remediation string.
  it("C10b: root type:'array' ⇒ ineligible(G0), the \"declare type: 'object'\" remediation", () => {
    const v = assessStructuredOutputEligibility({
      output_schema: { type: 'array', items: { type: 'string' } },
    });
    expect(v.verdict).toBe('ineligible');
    if (v.verdict !== 'ineligible') throw new Error('unreachable');
    expect(v.reasons).toHaveLength(1);
    expect(v.reasons[0]?.code).toBe('no_schema');
    expect(v.reasons[0]?.remediation).toContain("type: 'object'");
    // The two G0 remediations must be textually distinct (R2-5 — TWO remediation strings).
    const absentMsg = (
      assessStructuredOutputEligibility({}) as { reasons: { remediation: string }[] }
    ).reasons[0]!.remediation;
    expect(v.reasons[0]?.remediation).not.toBe(absentMsg);
  });

  // C11: 25 optionals ⇒ G3.
  it('C11: 25 optional properties ⇒ ineligible(too_many_optionals)', () => {
    const properties: Record<string, JsonSchema> = {};
    for (let i = 0; i < 25; i++) properties[`field_${i}`] = { type: 'string' };
    const v = assessStructuredOutputEligibility({
      output_schema: { type: 'object', additionalProperties: false, properties },
    });
    expect(v.verdict).toBe('ineligible');
    if (v.verdict !== 'ineligible') throw new Error('unreachable');
    expect(v.reasons.map((r) => r.code)).toEqual(['too_many_optionals']);
  });

  // C12: root $ref:'#' AND a circular $defs pair ⇒ G2-hard BOTH (the root-ref case must NOT fall
  // to the caveat class).
  it('C12: root $ref:"#" AND a circular $defs pair ⇒ ineligible with BOTH hard reasons', () => {
    const v = assessStructuredOutputEligibility({
      output_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          node: { $ref: '#/$defs/nodeA' },
        },
        $defs: {
          nodeA: {
            type: 'object',
            additionalProperties: false,
            properties: { next: { $ref: '#/$defs/nodeB' } },
          },
          nodeB: {
            type: 'object',
            additionalProperties: false,
            properties: { next: { $ref: '#/$defs/nodeA' } },
          },
        },
        // A DIRECT root self-reference, distinct from the $defs cycle above.
        allOf: [{ $ref: '#' }],
      },
    });
    expect(v.verdict).toBe('ineligible');
    if (v.verdict !== 'ineligible') throw new Error('unreachable');
    expect(v.reasons.length).toBeGreaterThanOrEqual(2);
    // At least one reason must be the root self-ref, and at least one the $defs cycle — neither
    // collapses into the generic caveat class.
    expect(v.reasons.some((r) => r.remediation.includes("$ref: '#'"))).toBe(true);
    expect(v.reasons.some((r) => r.remediation.toLowerCase().includes('circular'))).toBe(true);
  });

  // C13: 16+1 (17) union-typed ⇒ G3.
  it('C13: 17 union-typed (anyOf) optional properties ⇒ ineligible(too_many_unions)', () => {
    const properties: Record<string, JsonSchema> = {};
    for (let i = 0; i < 17; i++) {
      properties[`u_${i}`] = { anyOf: [{ type: 'string' }, { type: 'integer' }] };
    }
    const v = assessStructuredOutputEligibility({
      output_schema: { type: 'object', additionalProperties: false, properties },
    });
    expect(v.verdict).toBe('ineligible');
    if (v.verdict !== 'ineligible') throw new Error('unreachable');
    expect(v.reasons.map((r) => r.code)).toEqual(['too_many_unions']);
  });

  it('C13-boundary: exactly 16 union-typed properties ⇒ eligible (with the optional_emission caveat)', () => {
    const properties: Record<string, JsonSchema> = {};
    for (let i = 0; i < 16; i++) {
      properties[`u_${i}`] = { anyOf: [{ type: 'string' }, { type: 'integer' }] };
    }
    const v = assessStructuredOutputEligibility({
      output_schema: { type: 'object', additionalProperties: false, properties },
    });
    expect(v.verdict).toBe('eligible_with_caveats');
  });

  // C14: boundary trio.
  describe('C14: boundary trio', () => {
    it("format: 'custom-x' ⇒ caveat(G4)", () => {
      const v = assessStructuredOutputEligibility({
        output_schema: {
          type: 'object',
          additionalProperties: false,
          required: ['when'],
          properties: { when: { type: 'string', format: 'custom-x' } },
        },
      });
      expect(v.verdict).toBe('eligible_with_caveats');
      if (v.verdict !== 'eligible_with_caveats') throw new Error('unreachable');
      expect(v.caveats.map((c) => c.code)).toEqual(['unenforced_format']);
    });

    it('external $ref (http://…) ⇒ G2-hard', () => {
      const v = assessStructuredOutputEligibility({
        output_schema: {
          type: 'object',
          additionalProperties: false,
          properties: { ref: { $ref: 'http://example.com/schema.json' } },
        },
      });
      expect(v.verdict).toBe('ineligible');
      if (v.verdict !== 'ineligible') throw new Error('unreachable');
      expect(v.reasons[0]?.remediation).toContain('external $ref');
    });

    it('an enum with an object member ⇒ G2-hard', () => {
      const v = assessStructuredOutputEligibility({
        output_schema: {
          type: 'object',
          additionalProperties: false,
          required: ['choice'],
          properties: { choice: { enum: ['a', { nested: true }] } },
        },
      });
      expect(v.verdict).toBe('ineligible');
      if (v.verdict !== 'ineligible') throw new Error('unreachable');
      expect(v.reasons[0]?.remediation).toContain('enum');
    });
  });

  it('a fully clean, no-optional schema ⇒ eligible (no caveats)', () => {
    const v = assessStructuredOutputEligibility({
      output_schema: {
        type: 'object',
        additionalProperties: false,
        required: ['category'],
        properties: { category: { type: 'string' } },
      },
    });
    // issue #311: `optional_count` is an additive verdict field (0 here — every property is
    // required); the budget walk in run-agent consumes it to sum optionals across strict-attached
    // tools without re-walking each schema.
    expect(v).toEqual({ verdict: 'eligible', optional_count: 0 });
  });

  it('input_schema is used when output_schema is absent (the effective-schema collapse)', () => {
    const v = assessStructuredOutputEligibility({
      input_schema: {
        type: 'object',
        additionalProperties: false,
        required: ['x'],
        properties: { x: { type: 'string' } },
      },
    });
    expect(v).toEqual({ verdict: 'eligible', optional_count: 0 });
  });

  it('output_schema wins over input_schema when both are declared', () => {
    const v = assessStructuredOutputEligibility({
      output_schema: { type: 'array' }, // ineligible root
      input_schema: {
        type: 'object',
        additionalProperties: false,
        required: ['x'],
        properties: { x: { type: 'string' } },
      }, // would be eligible alone
    });
    expect(v.verdict).toBe('ineligible'); // output_schema's shape governs
  });
});

describe('assessStructuredOutputEligibility — Phase B ({schema, tools} entry)', () => {
  it('Phase B mirrors Phase A verdicts for the identical resolved schema', () => {
    const schema = {
      type: 'object',
      additionalProperties: false,
      required: ['category'],
      properties: { category: { type: 'string' }, note: { type: 'string' } },
    };
    const phaseA = assessStructuredOutputEligibility({ output_schema: schema });
    const phaseB = assessStructuredOutputEligibility({ schema, tools: false });
    expect(phaseB).toEqual(phaseA);
  });

  // issue #311: Phase B NO LONGER mirrors Phase A here — the assertion is unchanged, the premise
  // is not. Phase A now accepts a tools-bearing step with a caveat (strict applies to tool-call
  // ARGUMENTS); Phase B asks the different, runtime question "may realm grammar-constrain THIS
  // STEP's output?", whose answer on the tools fork is still no. Zero production callers pass
  // `tools: true` today — this arm stays defensive, and it is what the #332
  // `unsupported_context_tools` mint discloses.
  it('Phase B: tools:true ⇒ G6 ineligible (the step-OUTPUT question — deliberately NOT mirroring Phase A since #311)', () => {
    const v = assessStructuredOutputEligibility({ schema: { type: 'object' }, tools: true });
    expect(v.verdict).toBe('ineligible');
    if (v.verdict !== 'ineligible') throw new Error('unreachable');
    expect(v.reasons[0]?.code).toBe('unsupported_context_tools');
  });

  it('Phase B: schema undefined ⇒ G0 absent-remediation', () => {
    const v = assessStructuredOutputEligibility({ schema: undefined, tools: false });
    expect(v.verdict).toBe('ineligible');
    if (v.verdict !== 'ineligible') throw new Error('unreachable');
    expect(v.reasons[0]?.code).toBe('no_schema');
  });
});

// =================================================================================================
// issue #313 — the OpenAI rule profile.
//
// These cells cover the ROWS. The profile SELECTION (that run-agent actually passes 'openai' for
// an OpenAI provider) is pinned end-to-end, against the wire, in the cli package — a cell here
// that passes `profile: 'openai'` explicitly cannot catch a dropped argument at the call site.
// =================================================================================================
describe('assessStructuredOutputEligibility — OpenAI profile (issue #313)', () => {
  const openai = { tools: false, profile: 'openai' as const };

  it('not_all_required: any property outside `required` is INELIGIBLE (probe-derived, the S1 discriminator)', () => {
    const v = assessStructuredOutputEligibility({
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['a'],
        properties: { a: { type: 'string' }, b: { type: 'string' } },
      },
      ...openai,
    });
    expect(v.verdict).toBe('ineligible');
    if (v.verdict !== 'ineligible') throw new Error('unreachable');
    expect(v.reasons.map((r) => r.code)).toEqual(['not_all_required']);
    // The remediation names the sanctioned fix AND carries the measured numbers, so an author
    // can weigh it rather than take it on faith.
    expect(v.reasons[0]!.remediation).toContain("type: ['string', 'null']");
    expect(v.reasons[0]!.remediation).toContain('24/24');
  });

  it('null_union_emission: an all-required null-union schema is ELIGIBLE with the measured caveat', () => {
    const v = assessStructuredOutputEligibility({
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['a', 'b'],
        properties: { a: { type: 'string' }, b: { type: ['string', 'null'] } },
      },
      ...openai,
    });
    expect(v.verdict).toBe('eligible_with_caveats');
    if (v.verdict !== 'eligible_with_caveats') throw new Error('unreachable');
    expect(v.caveats.map((c) => c.code)).toEqual(['null_union_emission']);
    expect(v.caveats[0]!.remediation).toContain('null');
  });

  it('allOf is HARD-rejected (400-EXECUTED provenance) while Anthropic allows it — the clearest profile inversion', () => {
    const schema = {
      type: 'object',
      additionalProperties: false,
      required: ['a'],
      properties: { a: { allOf: [{ type: 'string' }] } },
    };
    const oa = assessStructuredOutputEligibility({ schema, ...openai });
    expect(oa.verdict).toBe('ineligible');
    if (oa.verdict !== 'ineligible') throw new Error('unreachable');
    expect(oa.reasons[0]!.code).toBe('unsupported_keyword');
    // Anthropic's own allowlist includes allOf — the same schema passes there.
    expect(assessStructuredOutputEligibility({ schema, tools: false }).verdict).toBe('eligible');
  });

  it('minLength/pattern/format/minimum are NOT flagged under OpenAI — and ARE under Anthropic (the inverse direction)', () => {
    const schema = {
      type: 'object',
      additionalProperties: false,
      required: ['a'],
      properties: {
        a: { type: 'string', minLength: 3, pattern: '^x', format: 'uuid' },
        b: { type: 'number', minimum: 1 },
      },
    };
    const allRequired = { ...schema, required: ['a', 'b'] };
    expect(assessStructuredOutputEligibility({ schema: allRequired, ...openai }).verdict).toBe(
      'eligible',
    );
    // Anthropic: `minimum` is hard, `pattern` is a caveat — the profiles genuinely disagree.
    const an = assessStructuredOutputEligibility({ schema: allRequired, tools: false });
    expect(an.verdict).toBe('ineligible');
  });

  it('depth cap: 11 levels is ineligible, 10 is fine (boundary-executed against the live API)', () => {
    const leaf = () => ({
      type: 'object',
      additionalProperties: false,
      required: ['x'],
      properties: { x: { type: 'string' } },
    });
    const nest = (levels: number): Record<string, unknown> => {
      let node: Record<string, unknown> = leaf();
      for (let i = 1; i < levels; i += 1) {
        node = {
          type: 'object',
          additionalProperties: false,
          required: ['n'],
          properties: { n: node },
        };
      }
      return node;
    };
    expect(assessStructuredOutputEligibility({ schema: nest(10), ...openai }).verdict).toBe(
      'eligible',
    );
    const deep = assessStructuredOutputEligibility({ schema: nest(11), ...openai });
    expect(deep.verdict).toBe('ineligible');
    if (deep.verdict !== 'ineligible') throw new Error('unreachable');
    expect(deep.reasons.map((r) => r.code)).toContain('exceeds_provider_limit');
  });

  it('enum cap: 1001 values is ineligible, 1000 is fine (boundary-executed)', () => {
    const enumOf = (n: number) => ({
      type: 'object',
      additionalProperties: false,
      required: ['a'],
      properties: { a: { type: 'string', enum: Array.from({ length: n }, (_, i) => `v${i}`) } },
    });
    expect(assessStructuredOutputEligibility({ schema: enumOf(1000), ...openai }).verdict).toBe(
      'eligible',
    );
    const over = assessStructuredOutputEligibility({ schema: enumOf(1001), ...openai });
    expect(over.verdict).toBe('ineligible');
    if (over.verdict !== 'ineligible') throw new Error('unreachable');
    expect(over.reasons[0]!.remediation).toContain('1001');
  });

  it("G7' optional_emission is SUPPRESSED under OpenAI — its hazard is structurally impossible there", () => {
    // All-required, so nothing can be omitted; the Anthropic caveat would be meaningless.
    const v = assessStructuredOutputEligibility({
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['a'],
        properties: { a: { type: 'string' } },
      },
      ...openai,
    });
    expect(v.verdict).toBe('eligible');
  });

  it('shared rows still apply: a missing additionalProperties is ineligible under BOTH profiles', () => {
    const schema = { type: 'object', required: ['a'], properties: { a: { type: 'string' } } };
    for (const args of [{ tools: false }, openai]) {
      const v = assessStructuredOutputEligibility({ schema, ...args });
      expect(v.verdict).toBe('ineligible');
      if (v.verdict !== 'ineligible') throw new Error('unreachable');
      expect(v.reasons.map((r) => r.code)).toContain('missing_additional_properties');
    }
  });

  it('ANTHROPIC ZERO-DIFF: omitting the profile is byte-identical to asking for anthropic', () => {
    const schema = {
      type: 'object',
      additionalProperties: false,
      required: ['a'],
      properties: { a: { type: 'string', pattern: '^x' }, b: { type: 'string' } },
    };
    expect(assessStructuredOutputEligibility({ schema, tools: false })).toEqual(
      assessStructuredOutputEligibility({ schema, tools: false, profile: 'anthropic' }),
    );
  });
});
