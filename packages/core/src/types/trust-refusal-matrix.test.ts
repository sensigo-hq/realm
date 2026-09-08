// The cross-product golden for `buildTrustRefusal` (issue #508, final correction) — the
// mechanism this issue's fourth round exists to ship. Three prior rounds each found a NEW defect
// by probing whatever came to mind next (arm divergence across surfaces, mixed bare/quoted value
// rendering, an array printing as its own first element, a grammar seam) — sampling, not
// verification. Every one of those defects would have been a one-line diff in THIS file, the
// first time it existed.
//
// **The contract**: for EVERY (value × kind) pair this file first asks the real
// `classifyStepTrust` for its verdict — the SAME question every real call site asks before ever
// reaching the composer. Only a `'refuse'` verdict renders the four (surface) cells through
// `buildTrustRefusal`; `'gates'`/`'lawful_no_gate'` render a single explicit marker line instead.
// This is deliberate, not an economy: calling the composer UNCONDITIONALLY for every value
// (including the three lawful ones) was this file's own first draft, and it produced a golden
// that confidently claimed `'auto'` "is not a recognized value" on `kind: 'auto'` — a real value
// composed into a false message, caught only by reading the generated output before committing
// it. Gating on the real verdict is what keeps this golden honest about what actually reaches the
// composer, and — as a second-order effect — means a future change to `classifyStepTrust`'s own
// arm order that silently flipped a lawful value into a refusal (or the reverse) changes THIS
// file too, not just the dedicated arm-order unit test.
//
// Adding an arm, a value, a kind, or a surface to `buildTrustRefusal` — or changing ANY existing
// cell's wording, or changing which (value, kind) pairs classify as `'refuse'` — changes what
// this test generates, so it CANNOT compile-and-pass silently: the golden file changes, and a
// human reads the diff in review. This is deliberately not a targeted unit-test substitute — the
// per-arm, per-surface cells living in `yaml-loader.test.ts`, `execution-loop.test.ts`,
// `run-health.test.ts`, and `generator.test.ts` still exist and still matter (they pin that each
// REAL call site wires the composer correctly); this file exists to pin the composer's own output
// exhaustively, so nothing in that space can drift unnoticed between them.
//
// **To regenerate** after a deliberate change: `npx vitest run src/types/trust-refusal-matrix.test.ts -u`
// (or `--update`) from `packages/core`, then read the diff on
// `fixtures/trust-refusal-matrix.golden.txt` before committing it — the diff IS the review.
import { describe, it, expect } from 'vitest';
import { buildTrustRefusal, classifyStepTrust } from './workflow-definition.js';
import type { ExecutionMode } from './workflow-definition.js';
import type { TrustRefusalSurface } from './workflow-definition.js';

/**
 * The 14 values (design record: "each is a distinct member, not a representative") — the three
 * accepted values, the retired tombstone, a typo, a case variant, all three service-trust
 * literals, an unrelated string, the empty string, null, a number, and an array. `label` is the
 * golden file's own section header for the value — chosen to be unambiguous on its own (never
 * relying on a value's own JSON rendering to convey what member it is, since telling `null` apart
 * from the literal string `"null"` by eye is exactly the class of confusion this composer fixes).
 */
const VALUES: ReadonlyArray<{ label: string; value: unknown }> = [
  { label: 'auto (accepted)', value: 'auto' },
  { label: 'human_confirmed (accepted)', value: 'human_confirmed' },
  { label: 'human_reviewed (accepted)', value: 'human_reviewed' },
  { label: 'human_notified (retired)', value: 'human_notified' },
  { label: 'human_confirmd (typo)', value: 'human_confirmd' },
  { label: 'Human_Confirmed (case variant)', value: 'Human_Confirmed' },
  { label: 'engine_delivered (service)', value: 'engine_delivered' },
  { label: 'engine_managed (service)', value: 'engine_managed' },
  { label: 'agent_provided (service)', value: 'agent_provided' },
  { label: 'nope (unrelated string)', value: 'nope' },
  { label: '"" (empty string)', value: '' },
  { label: 'null', value: null },
  { label: '123 (number)', value: 123 },
  { label: '["a","b"] (array)', value: ['a', 'b'] },
];

const KINDS: readonly ExecutionMode[] = ['auto', 'agent', 'guard', 'finalizer'];

const SURFACES: readonly TrustRefusalSurface[] = ['load', 'dispatch', 'finding', 'briefing'];

/** Every (value, kind) pair actually reaching `'refuse'` — computed here once so the header's own
 *  cell count and the sanity test below derive from the SAME real classification the render loop
 *  uses, rather than a second hand-counted number that could itself drift. */
function refusingPairCount(): number {
  let count = 0;
  for (const { value } of VALUES) {
    for (const kind of KINDS) {
      if (classifyStepTrust(kind, value) === 'refuse') count++;
    }
  }
  return count;
}

function renderMatrix(): string {
  const refusingPairs = refusingPairCount();
  const lines: string[] = [
    '# buildTrustRefusal — cross-product golden (issue #508, final correction)',
    '#',
    '# For every (value × kind) pair below, the real classifyStepTrust verdict decides what',
    "# renders: a `'refuse'` verdict renders all four (surface) cells through the real composer",
    "# (step: 'work' throughout); `'gates'`/`'lawful_no_gate'` render one explicit marker line —",
    '# no real call site ever reaches the composer for those, and rendering one anyway would be a',
    '# refusal message about a value the engine accepts. This file is generated, not hand-edited',
    '# — see trust-refusal-matrix.test.ts for the regeneration command and the reason this file',
    '# exists: three prior rounds each found a NEW trust-message defect by probing whatever came',
    '# to mind next; every one of those defects would have been a one-line diff HERE, the first',
    '# time this file existed. A change to any cell below means a human must read this diff before',
    '# it merges.',
    '#',
    `# ${VALUES.length} values × ${KINDS.length} kinds = ${VALUES.length * KINDS.length} pairs;`,
    `# ${refusingPairs} of them are 'refuse' (× ${SURFACES.length} surfaces = ${refusingPairs * SURFACES.length} rendered cells);`,
    `# ${VALUES.length * KINDS.length - refusingPairs} are 'gates'/'lawful_no_gate' (1 marker line each).`,
    '#',
    "# NOTE on the 'refuse' cells that render: kind=guard, and kind=finalizer with a surface",
    '# other than load, are cells no real call site constructs today for a NON-lawful value —',
    "# guard's trust prohibition is a KIND prohibition that never reaches this composer at all,",
    '# and dispatch/finding/briefing are structurally scoped to auto/agent by findEligibleSteps',
    "# (see each real call site's own comment). They render here anyway, deliberately: this is a",
    '# golden of the FUNCTION, not of reachability, so a future change that made one of these',
    '# cells reachable would already have a pinned, reviewed answer waiting for it.',
  ];

  for (const { label, value } of VALUES) {
    lines.push('', `## value: ${label}`);
    for (const kind of KINDS) {
      const verdict = classifyStepTrust(kind, value);
      lines.push('', `### kind: ${kind} (verdict: ${verdict})`);
      if (verdict !== 'refuse') {
        lines.push(
          `- (lawful — this pair never reaches buildTrustRefusal on any surface; no real call site would construct this cell)`,
        );
        continue;
      }
      for (const surface of SURFACES) {
        const rendered = buildTrustRefusal({ kind, value, step: 'work', surface });
        lines.push(`- ${surface}: ${rendered}`);
      }
    }
  }

  return lines.join('\n') + '\n';
}

describe('buildTrustRefusal — cross-product golden (issue #508)', () => {
  it('every (value × kind × surface) refuse-cell matches the committed golden', async () => {
    await expect(renderMatrix()).toMatchFileSnapshot('./fixtures/trust-refusal-matrix.golden.txt');
  });

  it('sanity: the matrix covers 14 values × 4 kinds = 56 pairs, and the refuse/lawful split is what classifyStepTrust actually says (guards the guard itself against a silently-shrunk axis)', () => {
    expect(VALUES).toHaveLength(14);
    expect(KINDS).toHaveLength(4);
    expect(SURFACES).toHaveLength(4);

    let refuseCount = 0;
    let lawfulCount = 0;
    for (const { value } of VALUES) {
      for (const kind of KINDS) {
        if (classifyStepTrust(kind, value) === 'refuse') refuseCount++;
        else lawfulCount++;
      }
    }
    expect(refuseCount + lawfulCount).toBe(56);
    // The three accepted values contribute exactly 5 refuse pairs between them: 'auto' refuses
    // only on guard (1); 'human_confirmed'/'human_reviewed' each refuse on guard AND finalizer
    // (2 apiece, since only 'auto' is lawful there) — every other value in the list refuses on
    // all four kinds. This is the exact arithmetic the golden's own header line states.
    expect(refuseCount).toBe(49);
    expect(lawfulCount).toBe(7);
  });

  it('no cell throws for any (value × kind × surface) combination, including kind=guard', () => {
    for (const { value } of VALUES) {
      for (const kind of KINDS) {
        for (const surface of SURFACES) {
          expect(() => buildTrustRefusal({ kind, value, step: 'work', surface })).not.toThrow();
        }
      }
    }
  });

  // issue #508 (final correction) RAIL: "a mutant swapping the load and dispatch consequences
  // must red distinctly on each surface." Executed here directly against the exported function
  // (not just relying on the golden file's own diff), so the mutant's effect is visible in an
  // assertion message, not only in a snapshot diff a reader has to interpret.
  describe('the mood/consequence distinction is load-bearing (RAILS mutant cell)', () => {
    it('load and dispatch never share their consequence wording, for the same value and kind', () => {
      for (const { value } of VALUES) {
        for (const kind of KINDS) {
          if (classifyStepTrust(kind, value) !== 'refuse') continue;
          const load = buildTrustRefusal({ kind, value, step: 'work', surface: 'load' });
          const dispatch = buildTrustRefusal({ kind, value, step: 'work', surface: 'dispatch' });
          expect(load).toContain('refused at load:');
          expect(dispatch).toContain('refused at dispatch:');
          expect(load).not.toContain('refused at dispatch:');
          expect(dispatch).not.toContain('refused at load:');
          // The two mood-specific facts, each exclusive to its own surface.
          expect(load).toContain('this workflow cannot create a run');
          expect(dispatch).not.toContain('this workflow cannot create a run');
          expect(dispatch).toContain('this run is now parked, non-terminal');
          expect(load).not.toContain('this run is now parked, non-terminal');
        }
      }
    });
  });
});
