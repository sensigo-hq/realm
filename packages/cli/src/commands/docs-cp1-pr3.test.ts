// docs-cp1-pr3.test.ts — CP-1 PR 3 (guardrails 7(f) and 9): the sentences the internal entry's PR
// writes, quoted word for word and asserted to be on their page, read from the repository, with the
// cell that executes what they say named beside them. Each assertion names (1) the change that turns
// it red and (2) what it prints when it fails.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const flat = (t: string): string => t.replace(/\s+/g, ' ');
const read = (page: string): string => readFileSync(join(ROOT, page), 'utf8');

describe('CP-1 PR 3 — the words of the internal entry', () => {
  it('core-library.md: the paragraph after the package line, before the package table', () => {
    // packages/core and packages/mcp-server `internal-entry.test.ts` (the same names, the same
    // objects, from the same files); the compatibility page names what is promised.
    const paragraph =
      '`@sensigo/realm/internal` exports everything the main entry exports, from the same files. Until 1.0 every name is importable from either entry; a name Realm promises (the [compatibility page](compatibility.md) says which) is promised on both, and the rest may change in a minor release. From 1.0 on, the names Realm does not promise live only on the internal entry, which also changes only in a minor release. `@sensigo/realm-mcp/internal` is the same for the MCP package.';
    const page = read('docs/reference/core-library.md');
    // (1) red when the paragraph is reworded, or moved after the table (an H3 there would swallow
    //     the table); (2) prints `found`, `beforeTable`, `afterLine` (when the paragraph is absent
    //     `indexOf` is −1, so `afterLine` reads false too — `found: false` is the cause).
    expect(
      {
        found: flat(page).includes(flat(paragraph)),
        beforeTable: page.indexOf(paragraph) < page.indexOf('| Package '),
        afterLine:
          page.indexOf(paragraph) >
          page.indexOf('The package exports many more names than this page covers.'),
      },
      'core-library.md no longer carries the internal-entry paragraph after the "more than 200 values" line and before the package table',
    ).toEqual({ found: true, beforeTable: true, afterLine: true });
  });

  it('CHANGELOG.md: the Added line under [Unreleased]', () => {
    // The same two cells.
    const text = read('CHANGELOG.md');
    const start = text.indexOf('## [Unreleased]');
    const unreleased = text.slice(start, text.indexOf('\n## [', start + 1));
    const added = unreleased.slice(
      unreleased.indexOf('### Added'),
      unreleased.indexOf('\n### ', unreleased.indexOf('### Added') + 1),
    );
    const line =
      "- `@sensigo/realm/internal` and `@sensigo/realm-mcp/internal`: each exports everything its main entry exports, from the same files, so a class is one object whichever entry imports it. Nothing moves: the main entries are unchanged before 1.0 (the compatibility page's road to 1.0 says what moves then).";
    // (1) red when the line is reworded or not under `### Added`; (2) prints the line.
    expect(flat(added), `the Added section no longer says: ${line}`).toContain(flat(line));
  });
});
