// deprecations.test.ts — CP-W: the deprecation channel's data. (e) the validator refuses a bad table,
// naming the id, and the shipped (empty) table passes; the said-set says an id once. (f) the
// compatibility page's table is pinned equal to this table. (i) the marker is one of realm's internal
// variables. Every assertion names (a) the change that turns it red and (b) what it prints.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEPRECATIONS,
  deprecationLine,
  markSaid,
  saidIds,
  seedSaid,
  validateDeprecations,
  type DeprecationEntry,
} from './deprecations.js';
import { REALM_INTERNAL_VARIABLES } from '../utils/redaction.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const entry = (id: string, over: Partial<DeprecationEntry> = {}): DeprecationEntry => ({
  id,
  since: '0.50.0',
  removal: 'not scheduled',
  used: 'You used the old flag.',
  means: 'It means the new flag.',
  instead: 'Write the new flag instead.',
  when: 'It goes away in a later release.',
  ...over,
});
const refusal = (entries: readonly DeprecationEntry[]): string | undefined => {
  try {
    validateDeprecations(entries);
    return undefined;
  } catch (err) {
    return (err as Error).message;
  }
};

describe('CP-W (e) — the table and the said-set', () => {
  it('the validator refuses a duplicate id, an id out of order, a missing clause and a bad release, naming the id; the shipped table passes', () => {
    // (a) red when a refusal is removed (that table passes) or names another id; (b) prints each
    //     table's refusal (or undefined when it passed).
    expect({
      shipped: refusal(DEPRECATIONS),
      shippedLength: DEPRECATIONS.length,
      good: refusal([entry('REALM-D001'), entry('REALM-D002')]),
      duplicate: refusal([entry('REALM-D001'), entry('REALM-D001')]),
      outOfOrder: refusal([entry('REALM-D002'), entry('REALM-D001')]),
      badId: refusal([entry('REALM-1')]),
      missingClause: refusal([entry('REALM-D003', { instead: '' })]),
      twoLineClause: refusal([entry('REALM-D004', { means: 'One.\nTwo.' })]),
      badSince: refusal([entry('REALM-D005', { since: '0.50' })]),
      badRemoval: refusal([entry('REALM-D006', { removal: 'soon' })]),
      frozen: Object.isFrozen(DEPRECATIONS),
    }).toEqual({
      shipped: undefined,
      shippedLength: 0,
      good: undefined,
      duplicate: 'deprecations: REALM-D001 is used twice',
      outOfOrder: 'deprecations: REALM-D001 comes after REALM-D002; ids are listed in order',
      badId: 'deprecations: REALM-1 is not an id of the form REALM-Dnnn',
      missingClause: 'deprecations: REALM-D003 has no "instead" clause on one line',
      twoLineClause: 'deprecations: REALM-D004 has no "means" clause on one line',
      badSince: 'deprecations: REALM-D005 since "0.50" is not a release',
      badRemoval: 'deprecations: REALM-D006 removal "soon" is not a release or "not scheduled"',
      frozen: true,
    });
  });

  it('the line is the four clauses after the id; markSaid is true once, then false; a seeded id is said', () => {
    // (a) red when markSaid says an id twice, or a seeded id is not counted as said; (b) prints the
    //     line, the answers and the ids.
    const first = markSaid('REALM-D801');
    const second = markSaid('REALM-D801');
    seedSaid(['REALM-D802']);
    expect({
      line: deprecationLine(entry('REALM-D001')),
      first,
      second,
      seededAgain: markSaid('REALM-D802'),
      said: saidIds().filter((id) => id.startsWith('REALM-D80')),
    }).toEqual({
      line: 'Warning: [REALM-D001] You used the old flag. It means the new flag. Write the new flag instead. It goes away in a later release.',
      first: true,
      second: false,
      seededAgain: false,
      said: ['REALM-D801', 'REALM-D802'],
    });
  });
});

describe('CP-W (f) — the compatibility page lists every id the table holds', () => {
  const PAGE = 'docs/reference/compatibility.md';
  /** The section's rows: each table row under "## Deprecations" as its four cells. */
  const pageRows = (page: string): string[][] => {
    const at = page.indexOf('\n## Deprecations\n');
    const section = page.slice(at, page.indexOf('\n## ', at + 1));
    return section
      .split('\n')
      .filter((l) => l.startsWith('|'))
      .slice(2)
      .map((l) =>
        l
          .slice(1, -1)
          .split('|')
          .map((c) => c.trim()),
      );
  };
  /** The rows the table makes, and "None today." when it is empty. */
  const pinned = (page: string, entries: readonly DeprecationEntry[]) => ({
    rows: pageRows(page),
    noneLine: page.slice(page.indexOf('\n## Deprecations\n')).includes('\nNone today.\n'),
    expected: entries.map((e) => [e.id, e.since, e.removal, e.used]),
    expectNone: entries.length === 0,
  });
  const same = (p: ReturnType<typeof pinned>) =>
    JSON.stringify(p.rows) === JSON.stringify(p.expected) && p.noneLine === p.expectNone;

  it('the section holds a row per entry (id, since, goes away, what) — "None today." when the table is empty', () => {
    const page = readFileSync(join(ROOT, PAGE), 'utf8');
    const extra = page.replace(
      '| --- | ----- | --------- | ---- |\n',
      '| --- | ----- | --------- | ---- |\n| REALM-D001 | 0.50.0 | not scheduled | You used the old flag. |\n',
    );
    // (a) red when a row is on the page and not in the table, or in the table and not on the page
    //     (both shown here on copies); (b) prints the page's rows and what the table expects.
    expect({
      page: same(pinned(page, DEPRECATIONS)),
      rowTooManyOnThePage: same(pinned(extra, DEPRECATIONS)),
      rowTooManyInTheTable: same(pinned(page, [entry('REALM-D001')])),
      pinned: pinned(page, DEPRECATIONS),
    }).toEqual({
      page: true,
      rowTooManyOnThePage: false,
      rowTooManyInTheTable: false,
      pinned: { rows: [], noneLine: true, expected: [], expectNone: true },
    });
  });
});

describe('CP-W (i) — the marker is internal', () => {
  it('REALM_INTERNAL_VARIABLES holds REALM_DEPRECATIONS_SAID beside the relay’s two markers', () => {
    // (a) red when the marker is not listed (the guard cell in redaction.test.ts then reds too);
    //     (b) prints the list.
    expect([...REALM_INTERNAL_VARIABLES].sort()).toEqual([
      'REALM_DEPRECATIONS_SAID',
      'REALM_RELAY_CHILD',
      'REALM_RELAY_KEY',
    ]);
  });
});
