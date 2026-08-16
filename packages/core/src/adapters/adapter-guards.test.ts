// adapter-guards.test.ts — issue #287: the class guard for silent scalar-param drops.
//
// THE CLASS: an adapter type-guards a param inline (`if (typeof params['x'] === 'string')`) and,
// when the guard fails, silently OMITS the param. A structurally broken value then degrades into
// "the caller didn't pass this" — which for a filter param means the query runs UNFILTERED and
// the step reports success. That is not a hypothetical: it ran for five weeks in production and
// corrupted 907 records before anyone noticed, because every layer looked healthy.
//
// Ten such sites were converted to `takeParam`, which throws on present-but-mistyped. This test
// keeps them converted: it reads every adapter's source and fails if the pattern comes back.
//
// HONEST BOUNDARY — what this does and does not kill. It kills the SCALAR-typeof drop class.
// It does NOT cover `Array.isArray(params[...])` drops, of which two remain by design
// (airtable's `fields` and `sort`); those are boarded on #357, whose per-operation Ajv param
// schemas subsume this whole approach. A green run here means "no new scalar-typeof drop", never
// "no silent drops anywhere".
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ADAPTERS_DIR = dirname(fileURLToPath(import.meta.url));

/** Every shipped adapter implementation: `*-adapter.ts`, excluding tests and probe scratch. */
function adapterSourceFiles(): string[] {
  return readdirSync(ADAPTERS_DIR).filter(
    (f) => f.endsWith('-adapter.ts') && !f.endsWith('.test.ts') && !f.endsWith('.probe.ts'),
  );
}

describe('adapter guards — the scalar-typeof silent-drop class stays dead (issue #287)', () => {
  it('no adapter reads a param through a bare `typeof params[...]` guard', () => {
    // Deliberately BARE, not `if (typeof params[`: the `if`-prefixed form misses the ternary
    // shape (`typeof params['x'] === 'number' ? … : undefined`), which is exactly how two of the
    // motivating gorgias sites were written. Matching the bare token catches both.
    const BANNED = 'typeof params[';
    const offenders: string[] = [];

    for (const file of adapterSourceFiles()) {
      const source = readFileSync(join(ADAPTERS_DIR, file), 'utf8');
      source.split('\n').forEach((line, i) => {
        if (line.includes(BANNED)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }

    expect(
      offenders,
      `Use takeParam() from adapter-utils instead — it returns undefined for an absent or ` +
        `nullish param and THROWS on a present-but-mistyped one. A bare typeof guard silently ` +
        `drops the mistyped value, which reads downstream as "not provided" (issue #287).`,
    ).toEqual([]);
  });

  it('the sweep actually reads adapter sources (guarding the guard against a silent empty glob)', () => {
    const files = adapterSourceFiles();
    expect(files.length).toBeGreaterThan(3);
    // A file the sweep must be reading, with content — so a broken path can never pass as clean.
    expect(files).toContain('airtable-adapter.ts');
    expect(readFileSync(join(ADAPTERS_DIR, 'airtable-adapter.ts'), 'utf8').length).toBeGreaterThan(
      1000,
    );
  });

  it('the converted params genuinely route through takeParam (the positive half)', () => {
    // The sweep above is a negative check; on its own it would stay green if a site were deleted
    // rather than converted. This asserts the conversion actually happened.
    const airtable = readFileSync(join(ADAPTERS_DIR, 'airtable-adapter.ts'), 'utf8');
    expect(airtable).toContain("takeParam(params, 'filter_by_formula', 'string'");
    const gorgias = readFileSync(join(ADAPTERS_DIR, 'gorgias-adapter.ts'), 'utf8');
    expect(gorgias).toContain("takeParam(params, 'limit', 'number'");
  });
});
