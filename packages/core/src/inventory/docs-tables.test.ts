// docs-tables.test.ts — Q1 (#592) d1: two reference pages kept equal to core's word lists.
// `scripts/generate-docs-tables.mjs` writes the counts of `docs/reference/mcp/run-state-and-health.md`
// and `docs/reference/error-codes.md` and error-codes.md's list of codes nothing raises, from the
// lists of the BUILT core (`NEXT_ACTIONS_STATUS`, `RUN_HEALTH_KINDS`, `ERROR_CODES`) and a scan of
// where Realm's code writes each code, and checks the pages' rows against the lists both ways. This
// test runs it as a process on temporary copies of the two pages.
//
// THE CELLS: (a) the committed pages are the script's output, byte for byte; (b)–(d) a row removed,
// a row for a word outside its list, and a code both in a table and in the list each stop the script
// with a line naming the word and its page; (e) a code moved by hand into the list, and a count
// edited by hand, are written back; (f) a second run changes nothing; (g) a count whose sentence is
// reworded stops the script; (h) the words error-codes.md says about the script.
//
// TO REGENERATE (a change made on purpose — a new word, a code first raised):
// `npm run build`, then `npm run docs:tables` (both from the repository root), and commit the pages.
//
// Each cell carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const SCRIPT = join(ROOT, 'scripts/generate-docs-tables.mjs');
const REGENERATE = '`npm run build`, then `npm run docs:tables` (from the repository root)';
const RUN_STATE = 'mcp/run-state-and-health.md';
const ERROR_PAGE = 'error-codes.md';
const PAGES = [RUN_STATE, ERROR_PAGE] as const;
type Page = (typeof PAGES)[number];
// The script reads the built core and scans every package's source: a few seconds on a loaded machine.
const BUDGET = 60_000;

const committed = (page: Page): string => readFileSync(join(ROOT, 'docs/reference', page), 'utf8');

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
  pages: Record<Page, string>;
}

/** Runs the script on copies of the two pages (`edit` changes one first); returns what it left. */
function runOn(
  texts: Record<Page, string> = {
    [RUN_STATE]: committed(RUN_STATE),
    [ERROR_PAGE]: committed(ERROR_PAGE),
  },
): Run {
  const dir = mkdtempSync(join(tmpdir(), 'realm-docs-tables-'));
  try {
    mkdirSync(join(dir, 'mcp'));
    for (const page of PAGES) writeFileSync(join(dir, page), texts[page]);
    const run = spawnSync(process.execPath, [SCRIPT, '--pages', dir], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: BUDGET,
    });
    const pages = Object.fromEntries(
      PAGES.map((p) => [p, readFileSync(join(dir, p), 'utf8')]),
    ) as Record<Page, string>;
    return { status: run.status, stdout: run.stdout, stderr: run.stderr, pages };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The committed pages with one page's `from` replaced by `to` — red when `from` is not there once. */
function edited(page: Page, from: string, to: string): Record<Page, string> {
  const texts = { [RUN_STATE]: committed(RUN_STATE), [ERROR_PAGE]: committed(ERROR_PAGE) };
  expect(texts[page].split(from).length - 1, `${page} no longer holds once: ${from}`).toBe(1);
  texts[page] = texts[page].replace(from, to);
  return texts;
}

/** The committed pages with the one row of `page` that `row` matches removed — red when not once. */
function withoutRow(page: Page, row: RegExp): Record<Page, string> {
  const texts = { [RUN_STATE]: committed(RUN_STATE), [ERROR_PAGE]: committed(ERROR_PAGE) };
  const found = texts[page].match(new RegExp(row.source, 'g')) ?? [];
  expect(found.length, `${page} no longer holds once: ${row.source}`).toBe(1);
  texts[page] = texts[page].replace(row, '');
  return texts;
}

/** The first lines where two texts differ, as `-`/`+` pairs, with their line numbers. */
function lineDiff(a: string, b: string, limit = 8): string[] {
  const x = a.split('\n');
  const y = b.split('\n');
  const out: string[] = [];
  for (let i = 0; i < Math.max(x.length, y.length) && out.length < limit * 2; i++) {
    if (x[i] === y[i]) continue;
    out.push(`  ${i + 1} - ${x[i] ?? '(no line)'}`, `  ${i + 1} + ${y[i] ?? '(no line)'}`);
  }
  return out;
}

/** Red unless the script stopped (exit 1, nothing written) with a line naming `word` on `page`. */
function expectStopped(run: Run, page: Page, word: string, texts: Record<Page, string>): void {
  const line = run.stderr.split('\n').find((l) => l.startsWith(`${page}:`) && l.includes(word));
  expect(
    { status: run.status, line: line !== undefined, written: run.pages[page] !== texts[page] },
    run.stderr,
  ).toEqual({
    status: 1,
    line: true,
    written: false,
  });
}

describe('Q1 (#592) d1 — the reference pages the script keeps', () => {
  it(
    '(a) the committed pages are the script’s output, byte for byte',
    () => {
      const run = runOn();
      // (a) red when a count, the list of codes nothing raises or a row is edited by hand, a word is
      //     added to a list without its row, or the script exits non-zero; (b) prints the script's
      //     message, or each page's first differing lines and how to regenerate.
      expect(run.status, `the script failed:\n${run.stderr}`).toBe(0);
      for (const page of PAGES) {
        expect(
          run.pages[page] === committed(page),
          `docs/reference/${page} is not the script's output (${REGENERATE}):\n${lineDiff(committed(page), run.pages[page]).join('\n')}`,
        ).toBe(true);
      }
    },
    BUDGET,
  );

  it(
    '(b) a next_actions_status row removed stops the script, naming the word',
    () => {
      const t = withoutRow(RUN_STATE, /\n\| `claim_stale` +\|[^\n]*/);
      expectStopped(runOn(t), RUN_STATE, '`claim_stale`', t);
    },
    BUDGET,
  );

  it(
    '(c) a row for a word outside NEXT_ACTIONS_STATUS stops the script, naming it',
    () => {
      const row = '| `ok`                    |';
      const t = edited(RUN_STATE, row, '| `bogus` | not a status. |\n' + row);
      // (a) red when a row for a word outside the list passes; (b) prints the exit code and stderr.
      expectStopped(runOn(t), RUN_STATE, '`bogus`', t);
    },
    BUDGET,
  );

  it(
    '(d) the findings section and the error-codes tables: a row removed, a stray row, a code in both',
    () => {
      const noFinding = withoutRow(RUN_STATE, /\n\| `drive_failing` +\|[^\n]*/);
      const first = '| `never_claimed_idle`           |';
      const strayFinding = edited(RUN_STATE, first, `| \`bogus_kind\` | not a kind. |\n${first}`);
      const noProse = edited(
        RUN_STATE,
        '`record_stamped_ahead` is found on any run',
        'A record stamped ahead is found on any run',
      );
      const noCode = withoutRow(ERROR_PAGE, /\n\| `NETWORK_UNREACHABLE` +\|[^\n]*/);
      const anchor = committed(ERROR_PAGE).match(/\n\| `NETWORK_UNREACHABLE` +\|[^\n]*/)![0];
      const after = (row: string) => edited(ERROR_PAGE, anchor, `${anchor}\n${row}`);
      const strayCode = after('| `BOGUS_CODE` | never. | `stop` | `false` |');
      // STATE_RUN_LOCKED is in the list of codes nothing raises; a row for it puts it in both.
      const unraisedRow = /\n\| `STATE_RUN_LOCKED` +\|/.test(committed(ERROR_PAGE));
      const both = after('| `STATE_RUN_LOCKED` | never. | `stop` | `false` |');
      // (a) red when a kind without its row or sentence passes, a row for a word that is not a kind
      //     passes, a code with no row and not in the list passes, a row naming no ErrorCode passes, or a
      //     code in a table and in the list passes; (b) prints each case's exit code and stderr.
      expect(unraisedRow, 'STATE_RUN_LOCKED has a row: pick another code nothing raises').toBe(
        false,
      );
      expectStopped(runOn(noFinding), RUN_STATE, '`drive_failing`', noFinding);
      expectStopped(runOn(strayFinding), RUN_STATE, '`bogus_kind`', strayFinding);
      expectStopped(runOn(noProse), RUN_STATE, '`record_stamped_ahead`', noProse);
      expectStopped(runOn(noCode), ERROR_PAGE, '`NETWORK_UNREACHABLE`', noCode);
      expectStopped(runOn(strayCode), ERROR_PAGE, '`BOGUS_CODE`', strayCode);
      expectStopped(runOn(both), ERROR_PAGE, '`STATE_RUN_LOCKED`', both);
    },
    BUDGET,
  );

  it(
    '(e) a code moved by hand into the list, and a count edited by hand, are written back',
    () => {
      const moved = edited(
        ERROR_PAGE,
        '```text\nNETWORK_TIMEOUT, ',
        '```text\nNETWORK_UNREACHABLE, NETWORK_TIMEOUT, ',
      );
      const count = edited(
        RUN_STATE,
        'and the 16 health findings, which',
        'and the 14 health findings, which',
      );
      const a = runOn(moved);
      const b = runOn(count);
      // (a) red when the list is not written from the scan, or a count is not written from its list;
      //     (b) prints each run's exit code and the first differing lines.
      expect(
        { status: a.status, back: a.pages[ERROR_PAGE] === committed(ERROR_PAGE) },
        lineDiff(committed(ERROR_PAGE), a.pages[ERROR_PAGE]).join('\n') + a.stderr,
      ).toEqual({ status: 0, back: true });
      expect(
        { status: b.status, back: b.pages[RUN_STATE] === committed(RUN_STATE) },
        lineDiff(committed(RUN_STATE), b.pages[RUN_STATE]).join('\n') + b.stderr,
      ).toEqual({ status: 0, back: true });
    },
    BUDGET,
  );

  it(
    '(f) a second run changes nothing',
    () => {
      const first = runOn(
        edited(RUN_STATE, 'and the 16 health findings, which', 'and the 3 health findings, which'),
      );
      const second = runOn(first.pages);
      // (a) red when a run's output differs when run again; (b) prints the first differing lines.
      expect(
        PAGES.map((p) => second.pages[p] === first.pages[p]),
        PAGES.map((p) => lineDiff(first.pages[p], second.pages[p]).join('\n')).join('\n'),
      ).toEqual([true, true]);
    },
    BUDGET,
  );

  it(
    '(g) a count whose sentence is reworded stops the script, naming the page and the sentence',
    () => {
      const t = edited(
        RUN_STATE,
        'the 8 values of `next_actions_status`',
        'all eight values of `next_actions_status`',
      );
      const u = edited(
        ERROR_PAGE,
        'These 15 are in the `ErrorCode` type',
        'These are in the `ErrorCode` type',
      );
      // (a) red when a reworded count is skipped silently; (b) prints the exit code and stderr.
      expectStopped(runOn(t), RUN_STATE, 'the <N> values of `next_actions_status`', t);
      expectStopped(runOn(u), ERROR_PAGE, 'These <N> are in the `ErrorCode` type', u);
    },
    BUDGET,
  );

  it('(h) error-codes.md says what the script writes and what the test checks', () => {
    // Executed by (a) (the counts and the list written), (d) (a code in neither, in both, a row naming
    // no code) and (e). (a) red when the sentence is reworded; (b) prints the sentence.
    const sentence =
      "The three counts and the list of codes nothing raises are written by a script that reads Realm's `ERROR_CODES` list and every place in Realm's code that writes one, and a test fails when a code is in neither a table nor that list, is in both, or a row names a code the type has not; what each row says was written by hand.";
    expect(
      committed(ERROR_PAGE).replace(/\s+/g, ' '),
      `${ERROR_PAGE} no longer says: ${sentence}`,
    ).toContain(sentence);
  });
});
