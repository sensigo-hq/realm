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
// TWO banned shapes, because the boundary is ENFORCED rather than merely documented:
//   1. the SCALAR shape (`typeof params[…]`) — zero occurrences, permanently;
//   2. the ARRAY shape (`Array.isArray(params[…])`) — two GRANDFATHERED residents, allow-listed
//      by file and param below. Any NEW one reds.
//
// Shape 2 is allow-listed rather than banned outright because `takeParam` has no array overload
// today, so an author with an array param has nowhere to go: without this arm, the obvious
// improvisation is a bare `Array.isArray` drop, invisible to the sweep and identical in effect to
// the class this whole PR exists to kill. The allowlist makes the residual finite and visible.
//
// A green run means "no NEW silent drop of either shape", never "no silent drops anywhere" — the
// two grandfathered entries are still real drops.
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

  it('no adapter introduces a NEW bare `Array.isArray(params[...])` drop', () => {
    // GRANDFATHERED — the two known array-shaped drops, matched by file + PARAM rather than raw
    // line number so an unrelated edit above them does not rot this list.
    //
    // #357's job is to EMPTY this allowlist: its per-operation Ajv param schemas validate array
    // params properly and subsume both entries. Until then, these two are known, named, and
    // deliberately not converted (takeParam is scalar-only by design).
    const GRANDFATHERED: ReadonlyArray<{ file: string; param: string }> = [
      { file: 'airtable-adapter.ts', param: 'fields' },
      { file: 'airtable-adapter.ts', param: 'sort' },
    ];
    const BANNED = 'Array.isArray(params[';
    const offenders: string[] = [];

    for (const file of adapterSourceFiles()) {
      const source = readFileSync(join(ADAPTERS_DIR, file), 'utf8');
      source.split('\n').forEach((line, i) => {
        if (!line.includes(BANNED)) return;
        const allowed = GRANDFATHERED.some(
          (g) =>
            g.file === file &&
            (line.includes(`params['${g.param}']`) || line.includes(`params["${g.param}"]`)),
        );
        if (!allowed) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }

    expect(
      offenders,
      `A new array-shaped silent drop. takeParam is scalar-only, so there is no drop-in fix — ` +
        `raise it with #357 (per-operation param schemas) rather than improvising a bare ` +
        `Array.isArray guard, which drops a mistyped array exactly as issue #287 describes.`,
    ).toEqual([]);
  });

  it('the array allowlist still describes REALITY — each grandfathered entry is actually present', () => {
    // A stale allowlist is worse than none: it would silently permit a shape nobody is tracking.
    // When #357 converts these, this cell reds and the entry must be REMOVED, not re-pointed.
    const airtable = readFileSync(join(ADAPTERS_DIR, 'airtable-adapter.ts'), 'utf8');
    expect(airtable).toContain("Array.isArray(params['fields'])");
    expect(airtable).toContain("Array.isArray(params['sort'])");
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
