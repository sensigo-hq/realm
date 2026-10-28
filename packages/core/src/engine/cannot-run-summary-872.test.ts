// cannot-run-summary-872.test.ts — issue #872 (a): the hand-back hint's grouped summary (core's
// `cannotRunSummary`), its bounded names and its sizes, on synthetic `Unavailable` entries (no run of
// 1,000 steps is built — 872-HB-05), and the one spelling of a capability refusal. The doors' cells
// (start_run, execute_step by name, the mixed hint) live beside the MCP renderer's. Beside each: (a)
// what turns it red; (b) what it prints on failure — step and requirement names, counts and sizes.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cannotRunSummary, libraryCannotRunWords, type Unavailable } from './ways.js';

/** A step that cannot run for a capability, as core composes it (`refusedEntry`'s shape). */
const cap = (
  step: string,
  kind: 'handler' | 'adapter',
  name: string,
  basis: 'registry' | 'marker' = 'registry',
): Unavailable => ({
  verb: 'run_step',
  step,
  code: 'capability_missing',
  facts: { step, requirement: { kind, name }, basis },
  remedy: [],
  no_remedy: { cause: 'requires_other_program', requirement: { kind, name } },
});

/** A name of `length` characters: `head`, padded with `pad` (the lane's real-length method). */
const padded = (head: string, length: number, pad: string): string => head.padEnd(length, pad);

const TAIL =
  ' — load the missing extensions, or run these steps on a runner that has them. get_run_state lists each one in engine_runnable.';

describe('#872 (a) — cannotRunSummary, the grouped hand-back hint', () => {
  it("B6 (a): every step judged from the run's marker — the past tense, no way out, the pointer", () => {
    const summary = cannotRunSummary([
      cap('a', 'handler', 'h', 'marker'),
      cap('b', 'handler', 'h', 'marker'),
      cap('c', 'adapter', 'g', 'marker'),
    ]);
    // (a) red when the marker branch is dropped (the present tense and the way out appear) or the
    //     pointer is lost; (b) prints the summary (step and requirement names only).
    expect(summary).toBe(
      "3 steps could not run (capability): handler 'h' ('a', 'b'); adapter 'g' ('c'). get_run_state lists each one in engine_runnable.",
    );
  });

  it('B7: a step or requirement name over 500 characters is named by its length, never cut (I4) — in the summary and in one step’s clause', () => {
    const longStep = padded('s', 600, 'x');
    const longName = padded('r', 600, 'y');
    const many = cannotRunSummary([
      cap(longStep, 'handler', longName),
      cap('b', 'handler', longName),
    ]);
    const one = libraryCannotRunWords(cap(longStep, 'handler', longName));
    // (a) red when a name bypasses the bounded renderer (`capText` in `cannotRunParts`, or the
    //     summary's own); (b) prints both texts — the names are fake.
    expect({ many, one }).toEqual({
      many: `2 steps cannot run here (capability): handler '‹600 characters, not kept›' ('‹600 characters, not kept›', 'b')${TAIL}`,
      one: "'‹600 characters, not kept›' cannot run here (capability): handler '‹600 characters, not kept›' is not registered here — load the missing extension, or run the step on a runner that has it",
    });
  });

  it('B10: the acceptance measurement — 10 steps on 10 handlers with real-length names under 1,000 characters; 1,000 steps on 1,000 under 600', () => {
    // The real workflow's median names (lane §Q4.5): step 21 characters, handler 29.5 (30 here).
    const real = Array.from({ length: 10 }, (_, i) =>
      cap(padded(`s${i}`, 21, 'y'), 'handler', padded(`h${i}`, 30, 'x')),
    );
    // The lane's probe names: step `h<i>`, handler `nope<i>`.
    const probe = Array.from({ length: 1000 }, (_, i) => cap(`h${i}`, 'handler', `nope${i}`));
    const sizes = [cannotRunSummary(real).length, cannotRunSummary(probe).length];
    // (a) red when the summary is not grouped and bounded — today's per-step clauses are 1,890 and
    //     148,780 characters; the sizes were computed before the build on A2's shape (python3 -I):
    //     843 and 446; (b) prints the two sizes.
    expect({ under: [sizes[0]! < 1000, sizes[1]! < 600], sizes }).toEqual({
      under: [true, true],
      sizes: [843, 446],
    });
  });

  it('B10b: one shared handler — one group with its exact count, under 300 characters at 10 and at 1,000 steps', () => {
    const handler = padded('h0', 30, 'x');
    const ten = cannotRunSummary(
      Array.from({ length: 10 }, (_, i) => cap(padded(`s${i}`, 21, 'y'), 'handler', handler)),
    );
    const thousand = cannotRunSummary(
      Array.from({ length: 1000 }, (_, i) => cap(`h${i}`, 'handler', handler)),
    );
    // (a) red when the per-group name cap is removed (the 1,000-name group) or the count is wrong;
    //     (b) prints the counts' presence and the sizes.
    expect({
      counts: [ten.includes(' and 7 more)'), thousand.includes("('h0', 'h1', 'h2' and 997 more)")],
      under: [ten.length < 300, thousand.length < 300],
      sizes: [ten.length, thousand.length],
    }).toEqual({ counts: [true, true], under: [true, true], sizes: [292, 239] });
  });

  it('B9: one spelling of a capability refusal — only core’s capabilityRefusalWords writes it (code, comments stripped)', () => {
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    const code = (rel: string): string =>
      readFileSync(join(root, rel), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
    const words = [
      'is not registered here',
      'was not registered in the runner that last attempted it',
    ];
    const hits: Record<string, string[]> = Object.fromEntries(words.map((w) => [w, []]));
    const walk = (rel: string): void => {
      for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
        const child = `${rel}/${e.name}`;
        if (e.isDirectory()) {
          if (e.name !== 'node_modules' && e.name !== 'dist') walk(child);
        } else if (/\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name)) {
          const text = code(child);
          for (const w of words) if (text.includes(w)) hits[w]!.push(child);
        }
      }
    };
    for (const pkg of ['core/src', 'mcp-server/src', 'cli/src', 'testing/src']) walk(pkg);
    // (a) red when a door (render-reply.ts, ways-renderer.ts) or the wire refusal (pending.ts)
    //     spells the words again; (b) prints the files that do.
    expect(hits).toEqual({
      'is not registered here': ['core/src/engine/ways.ts'],
      'was not registered in the runner that last attempted it': ['core/src/engine/ways.ts'],
    });
  });
});
