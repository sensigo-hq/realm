// price-source.test.ts — issue #600 caching PR P (G8): `loadPriceSource` reads the economics file,
// imports the price list, and asks the file first. The list's absence and its failure are injected
// (the list is installed in this repo as a devDependency). On a failing CI host each cell prints the
// price result: causes, source names and test figures only.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PriceInput, PriceResult } from '@sensigo/realm';
import { loadPriceSource, readCacheEconomics } from './price-source.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'realm-prices-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const input = (model: string): PriceInput => ({
  model,
  at: '2026-10-01T00:00:00.000Z',
  endpoint: 'default',
  provider: 'anthropic',
  usage: { prompt_tokens: 1000000, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
});
const summary = (r: PriceResult): unknown =>
  'not_priced' in r
    ? r.not_priced
    : [r.priced_by.source_class, r.priced_by.matched_model, Number(r.priced.total.toFixed(9))];
const ECONOMICS = [
  'version: 1',
  'currency: USD',
  'models:',
  '  claude-sonnet-5-5:',
  '    prices:',
  '      - per_million_tokens: { input: 7, output: 15 }',
  '',
].join('\n');
const notFound = (): Promise<unknown> =>
  Promise.reject(
    Object.assign(new Error("Cannot find package '@pydantic/genai-prices'"), {
      code: 'ERR_MODULE_NOT_FOUND',
    }),
  );

describe('loadPriceSource (issue #600 caching PR P, G8)', () => {
  // (a) red when the list is asked before the file; (b) prints both results.
  it('the economics file first; the list for a model the file does not have', async () => {
    const path = join(dir, 'economics.yaml');
    writeFileSync(path, ECONOMICS, 'utf8');
    const source = await loadPriceSource({
      economicsPath: path,
      importList: () => import('@pydantic/genai-prices'),
    });
    const fromFile = source.price(input('claude-sonnet-5-5'));
    expect([
      summary(fromFile),
      'priced' in fromFile && fromFile.priced_by.source_ref,
      summary(source.price(input('claude-haiku-5-5'))),
    ]).toEqual([
      ['economics', 'claude-sonnet-5-5', 7],
      path,
      ['price_list', 'claude-haiku-5-5', 0.5],
    ]);
  });

  // (a) red when the importer's not-found is mapped to price_list_error; (b) prints the causes.
  it('the list not installed: no price source without a file; model_unknown for a model the file lacks', async () => {
    const path = join(dir, 'economics.yaml');
    writeFileSync(path, ECONOMICS, 'utf8');
    const none = await loadPriceSource({ importList: notFound });
    const fileOnly = await loadPriceSource({ economicsPath: path, importList: notFound });
    expect([
      summary(none.price(input('claude-sonnet-5-5'))),
      summary(fileOnly.price(input('claude-haiku-5-5'))),
    ]).toEqual(['no_price_source', 'model_unknown']);
  });

  it('the list failing to load in another way: price_list_error, with its message', async () => {
    const source = await loadPriceSource({ importList: () => Promise.reject(new Error('boom')) });
    expect(source.price(input('claude-sonnet-5-5'))).toEqual({
      not_priced: 'price_list_error',
      detail: 'boom',
    });
  });

  it('a file that cannot be read, and one that does not parse, price nothing — naming the file', async () => {
    const missing = join(dir, 'missing.yaml');
    const broken = join(dir, 'broken.yaml');
    writeFileSync(broken, 'version: 2\ncurrency: USD\nmodels: {}\n', 'utf8');
    const a = (await loadPriceSource({ economicsPath: missing, importList: notFound })).price(
      input('m'),
    );
    const b = (await loadPriceSource({ economicsPath: broken, importList: notFound })).price(
      input('m'),
    );
    expect([a, b]).toEqual([
      { not_priced: 'economics_unreachable', detail: `cannot read '${missing}': ENOENT` },
      {
        not_priced: 'economics_unreadable',
        detail: `'${broken}': economics/version: must be equal to constant`,
      },
    ]);
  });

  // (a) red when the source is not cached per path (an edited file is read at once); (b) prints the
  // totals before and after the edit.
  it('cached per path for the process: an edited file is read again only after a restart', async () => {
    const path = join(dir, 'economics.yaml');
    writeFileSync(path, ECONOMICS, 'utf8');
    const first = await loadPriceSource({ economicsPath: path });
    writeFileSync(path, ECONOMICS.replace('input: 7', 'input: 9'), 'utf8');
    const second = await loadPriceSource({ economicsPath: path });
    expect([second === first, summary(second.price(input('claude-sonnet-5-5')))]).toEqual([
      true,
      ['economics', 'claude-sonnet-5-5', 7],
    ]);
  });
});

// issue #600 caching PR 5 (Δ6): the economics file has ONE reader. Pricing and validate's cache floor
// both read it through `readCacheEconomics`, so a failure says the same thing on both. On a failing
// host each cell prints the cause and the detail with the file's path replaced by `<path>`.
describe('readCacheEconomics, the one reader (caching PR 5, Δ6)', () => {
  // (a) red when buildPriceSource composes its own detail for either failure (a different quote
  //     mark, a different word) instead of the reader's; (b) prints both routes' causes and details.
  it("a file that cannot be read, and one that does not parse: the reader's detail is the price source's", async () => {
    const missing = join(dir, 'missing.yaml');
    const broken = join(dir, 'broken.yaml');
    writeFileSync(broken, 'version: 2\ncurrency: USD\nmodels: {}\n', 'utf8');
    const shown = (path: string, r: { cause?: string; not_priced?: string; detail?: string }) => [
      r.cause ?? r.not_priced,
      (r.detail ?? '').split(path).join('<path>'),
    ];
    const routes = async (path: string) => [
      shown(path, (await readCacheEconomics(path)) as { cause: string; detail: string }),
      shown(
        path,
        (await loadPriceSource({ economicsPath: path, importList: notFound })).price(
          input('m'),
        ) as { not_priced: string; detail?: string },
      ),
    ];
    expect([await routes(missing), await routes(broken)]).toEqual([
      [
        ['economics_unreachable', "cannot read '<path>': ENOENT"],
        ['economics_unreachable', "cannot read '<path>': ENOENT"],
      ],
      [
        ['economics_unreadable', "'<path>': economics/version: must be equal to constant"],
        ['economics_unreadable', "'<path>': economics/version: must be equal to constant"],
      ],
    ]);
  });

  // (a) red when the reader caches (the edited file is not read again) or loses the economics;
  //     (b) prints the input rate read each time.
  it('uncached: an edited file is read again on the next call', async () => {
    const path = join(dir, 'economics.yaml');
    writeFileSync(path, ECONOMICS, 'utf8');
    const rate = async (): Promise<unknown> => {
      const read = await readCacheEconomics(path);
      return 'economics' in read
        ? read.economics.models['claude-sonnet-5-5']!.prices[0]!.per_million_tokens.input
        : read.cause;
    };
    const first = await rate();
    writeFileSync(path, ECONOMICS.replace('input: 7', 'input: 9'), 'utf8');
    expect([first, await rate()]).toEqual([7, 9]);
  });
});
