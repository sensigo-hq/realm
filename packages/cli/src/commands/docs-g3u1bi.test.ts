// docs-g3u1bi.test.ts — gap 3, unit 1b-i, check 9: every new sentence about `remember:` paths at
// load, pinned word for word where a person reads it, each beside the cells that execute it: core's
// workflow/remember-paths-g3u1bi.test.ts (every finding's words, the own-output rules, the
// key-names words) and this package's commands/remember-paths-g3u1bi.test.ts (validate's lines,
// --json, --strict, register and run). The changed sentences' own pins (the code counts, the error
// list, the not_checked row) are in the validate-*.test.ts files that pinned them before. (a) red
// when the page no longer holds the sentence word for word; (b) prints the sentence.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

function claim(page: string, sentence: string): void {
  // In a type file, a comment's wrapped lines start with `*`, read as the space between two words.
  const flat = (t: string): string =>
    (page.endsWith('.d.ts') ? t.replace(/\n\s*\*(?!\/)/g, ' ') : t).replace(/\s+/g, ' ');
  expect(
    flat(readFileSync(join(ROOT, page), 'utf8')),
    `${page} no longer says: ${sentence}`,
  ).toContain(flat(sentence));
}

describe('gap 3 (1b-i), check 9 — the words', () => {
  it('step-fields.md: what the load checks (Words 6)', () => {
    // Executed by: check 1 and Behaviour 8 (refused at validate and register, printed by run),
    // check 8 (a warning), check 4 (not checked), check 6 (the key names).
    claim(
      'docs/reference/workflow/step-fields.md',
      'When the workflow loads, each `key` and `value` path is checked as an `input_map` path is: one that can never be found makes `validate`, `register` and `watch` refuse the file (running it prints a warning), one that may be absent gets a warning, and one into data the workflow declares no shape for is listed as not checked. Steps that remember one memory must use the same key names.',
    );
  });

  it("loader-diagnostics.md: the two codes' rows (Words 7)", () => {
    // Executed by: core's diagnostics.test.ts (the policy) and checks 1–3 and 8.
    claim(
      'docs/reference/workflow/loader-diagnostics.md',
      '| `REMEMBER_PATH_UNRESOLVABLE` | Error | A `remember` key or value path can never be found. Added after version 0.50.0. |',
    );
    claim(
      'docs/reference/workflow/loader-diagnostics.md',
      '| `REMEMBER_PATH_UNCERTAIN` | Warning | A `remember` key or value path may be absent when the step remembers. Added after version 0.50.0. |',
    );
  });

  it('CHANGELOG.md: the entry and its library clause (Words 8)', () => {
    claim(
      'CHANGELOG.md',
      "When the workflow loads, its `key` and `value` paths are checked as `input_map`'s are (`REMEMBER_PATH_UNRESOLVABLE`, `REMEMBER_PATH_UNCERTAIN`), and steps that remember one memory must use the same key names.",
    );
    claim(
      'CHANGELOG.md',
      "`WarningCode` gains `REMEMBER_PATH_UNRESOLVABLE` and `REMEMBER_PATH_UNCERTAIN`; `NotCheckedPath`'s `surface` gains `'remember'`.",
    );
  });

  it("NotCheckedPath's comments, as the built types ship them (Words 9) and the library page", () => {
    const types = 'packages/core/dist/workflow/input-map-paths.d.ts';
    claim(
      types,
      'Where the path is read: an `input_map` leaf, a `when` condition (piece 2a), a template placeholder in `gate.message`, `display`, a prompt or instructions (pieces 3a-ii-a and 3a-ii-b), or a `remember` key or value path (gap 3).',
    );
    claim(types, 'The step whose `input_map`, `when`, template or `remember` holds the path.');
    claim(
      types,
      "The map's dotted key chain; `when` for a condition; the field's name for a template; `key.<name>` or `value.<key>` for `remember`.",
    );
    // The interface's own line, which the library page prints.
    claim(
      'docs/reference/library/define-and-load-a-workflow.md',
      "An `input_map` path, a `when` condition, a template placeholder or a `remember` path that reads data the workflow declares no shape for (`validate --json`'s `not_checked`).",
    );
  });
});
