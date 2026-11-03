// auto-prices.test.ts — issue #898: what `realm agent` reads from the runner's price file for `--prompt-
// cache auto` (`readAutoPrices`), the one stderr line when the file cannot be used (`priceFileWarning`,
// S7b), and the settle (`settleAutoFromPriceFile`). Real files in a temp folder; no network. Beside
// each: (a) the change that turns it red; (b) what it prints when it fails — the line and its
// line-break count, the cause, never an environment or a key.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AutoPriceInput } from '@sensigo/realm';
import { priceFileWarning, readAutoPrices, settleAutoFromPriceFile } from './auto-prices.js';

let dir: string;
const at = '2026-10-29T12:00:00.000Z';
const FULL_ROW = {
  per_million_tokens: {
    input: 3,
    output: 15,
    cache_read: 0.3,
    cache_write_5m: 3.75,
    cache_write_1h: 6,
  },
  tiers: [
    {
      above_prompt_tokens: 200_000,
      per_million_tokens: {
        input: 6,
        output: 22.5,
        cache_read: 0.6,
        cache_write_5m: 7.5,
        cache_write_1h: 12,
      },
    },
  ],
};
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'realm-898-prices-'));
  writeFileSync(
    join(dir, 'full.json'),
    JSON.stringify({ version: 1, currency: 'USD', models: { 'claude-x': { prices: [FULL_ROW] } } }),
  );
  // A model key holding a line break: the parser's reason then spans lines (no position: a schema
  // error has none).
  writeFileSync(
    join(dir, 'reason-spans-lines.json'),
    JSON.stringify({ version: 1, currency: 'USD', models: { 'a\n   b': { prices: [] } } }),
  );
  writeFileSync(join(dir, 'bad-indent.yaml'), 'version: 1\n\tcurrency: USD\n');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Line breaks of any form in a text. */
const breaks = (t: string): number => (t.match(/\r\n|\r|\n|\u2028|\u2029/g) ?? []).length;

describe('#898 readAutoPrices — what auto is priced from', () => {
  // (a) red when a file cause is lost, the lookup adds a suffix or reads a tier, or a missing file
  //     opens anything; (b) prints each case's cause or rates.
  it('no path → no_file; a missing file → economics_unreachable; an invalid file → economics_unreadable; no entry → model_unknown; else the base row', async () => {
    const shape = (r: Awaited<ReturnType<typeof readAutoPrices>>) =>
      'rates' in r ? { rates: r.rates } : { cause: r.cause, detail: 'detail' in r };
    expect({
      none: shape(await readAutoPrices(undefined, 'claude-x', at)),
      missing: shape(await readAutoPrices(join(dir, 'missing.yaml'), 'claude-x', at)),
      invalid: shape(await readAutoPrices(join(dir, 'bad-indent.yaml'), 'claude-x', at)),
      unknown: shape(await readAutoPrices(join(dir, 'full.json'), 'claude-y', at)),
      priced: shape(await readAutoPrices(join(dir, 'full.json'), 'claude-x', at)),
      dated: shape(await readAutoPrices(join(dir, 'full.json'), 'claude-x-20261029', at)),
    }).toEqual({
      none: { cause: 'no_file', detail: false },
      missing: { cause: 'economics_unreachable', detail: true },
      invalid: { cause: 'economics_unreadable', detail: true },
      unknown: { cause: 'model_unknown', detail: false },
      priced: { rates: FULL_ROW.per_million_tokens },
      dated: { rates: FULL_ROW.per_million_tokens },
    });
  });

  // (a) red when an unreadable time is read as a day; (b) prints what was thrown.
  it('an unreadable time throws a plain Error (a fresh toISOString() always parses)', async () => {
    await expect(readAutoPrices(join(dir, 'full.json'), 'claude-x', 'not a date')).rejects.toThrow(
      "readAutoPrices: the time 'not a date' does not parse",
    );
  });
});

describe("#898 S7b — the stderr line: one line, in the reader's words, never a quoted line of the file", () => {
  // (a) red when the detail is printed as given (its line breaks then reach stderr); (b) prints the
  //     line and its line-break count.
  it('a file whose reason spans lines → one line holding the path and the reason, each break one space', async () => {
    const path = join(dir, 'reason-spans-lines.json');
    const read = await readAutoPrices(path, 'claude-x', at);
    const line =
      'detail' in read ? priceFileWarning(path, read) : `not a file cause: ${JSON.stringify(read)}`;
    expect({
      line,
      breaks: breaks(line),
      detailBreaks: 'detail' in read ? breaks(read.detail) : 0,
    }).toEqual({
      line: `  ⚠ the price file could not be used: '${path}': economics/models/a b/prices: must NOT have fewer than 1 items. auto chose without prices.`,
      breaks: 0,
      detailBreaks: 1,
    });
  });

  // (a) red when js-yaml's full message (a blank line, then a quoted snippet of the file) is
  //     printed; (b) prints the line and its line-break count.
  it("a reason holding js-yaml's full message → the path and the position only", () => {
    const path = '/runner/prices.yaml';
    const detail = `'${path}' (line 3, column 5): bad indentation of a mapping entry (3:5)\n\n 2 | currency: USD\n 3 |     models: secret-line\n----------^`;
    const line = priceFileWarning(path, { cause: 'economics_unreadable', detail });
    expect({ line, breaks: breaks(line), quotes: line.includes('secret-line') }).toEqual({
      line: `  ⚠ the price file could not be used: '${path}' (line 3, column 5). auto chose without prices.`,
      breaks: 0,
      quotes: false,
    });
  });

  // (a) red when the code is dropped or the line breaks; (b) prints the line.
  it('a file that cannot be read → the path and the code', async () => {
    const path = join(dir, 'missing.yaml');
    const read = await readAutoPrices(path, 'claude-x', at);
    const line =
      'detail' in read ? priceFileWarning(path, read) : `not a file cause: ${JSON.stringify(read)}`;
    expect(line).toBe(
      `  ⚠ the price file could not be used: cannot read '${path}': ENOENT. auto chose without prices.`,
    );
  });
});

describe('#898 settleAutoFromPriceFile — the settle reads the file once and hands the provider its prices', () => {
  // (a) red when the file's rates do not reach the settle, or the warning is lost or printed for a
  //     cause that is not the file's; (b) prints what the settle was handed and the warning's presence.
  it('passes the rates, or the cause without its detail; a warning only for the two file causes', async () => {
    const handed: AutoPriceInput[] = [];
    const settle = (prices: AutoPriceInput) => {
      handed.push(prices);
      return { choice: 'long' as const };
    };
    const priced = await settleAutoFromPriceFile(settle, join(dir, 'full.json'), 'claude-x');
    const noFile = await settleAutoFromPriceFile(settle, undefined, 'claude-x');
    const unreadable = await settleAutoFromPriceFile(
      settle,
      join(dir, 'bad-indent.yaml'),
      'claude-x',
    );
    expect({
      handed,
      warnings: [
        priced.warning,
        noFile.warning,
        unreadable.warning?.startsWith('  ⚠ the price file could not be used: '),
      ],
    }).toEqual({
      handed: [
        { rates: FULL_ROW.per_million_tokens },
        { cause: 'no_file' },
        { cause: 'economics_unreadable' },
      ],
      warnings: [undefined, undefined, true],
    });
  });
});
