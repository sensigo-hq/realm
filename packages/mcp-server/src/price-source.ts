// price-source.ts — issue #600 caching PR P (C1): the one place a host LOADS its prices. Core owns
// the economics format and the arithmetic, and reads no file; this file reads the runner's economics
// file (`runner.cache.economics`) and imports the price list (`@pydantic/genai-prices`, an optional
// peer dependency), and composes them into one `PriceSource`: the runner's file first, the list for
// a model the file does not have. `realm mcp`, `realm serve`, the `realm-mcp` bin and `realm run
// inspect` all load through it, so nothing is built twice.
import { readFile } from 'node:fs/promises';
import {
  parseCacheEconomics,
  priceFromEconomics,
  type CacheEconomics,
  type PriceInput,
  type PriceResult,
  type PriceSource,
} from '@sensigo/realm';
import { isPriceList, listPriceSource, readPriceListVersion } from './price-source-list.js';

/** A source whose every answer is the same not-priced cause. */
export function notPricedSource(
  cause: 'economics_unreachable' | 'economics_unreadable' | 'no_price_source',
  detail?: string,
): PriceSource {
  const result: PriceResult = { not_priced: cause, ...(detail !== undefined ? { detail } : {}) };
  return { price: () => result };
}

/** The default importer: the list's specifier in a variable, so a bundler leaves it alone. */
async function importInstalledList(): Promise<unknown> {
  const specifier = '@pydantic/genai-prices';
  return import(/* webpackIgnore: true */ /* @vite-ignore */ specifier);
}

function errorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

function boundedMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.length > 200 ? `${message.slice(0, 200)}…` : message;
}

/** One load per economics path for the process's life (the default importer only). */
const cache = new Map<string, Promise<PriceSource>>();

/**
 * Loads a host's prices: the economics file at `economicsPath` (when given) and the installed price
 * list. The file's bytes are read here and parsed by core (`parseCacheEconomics`): a file that
 * cannot be read makes every answer `economics_unreachable`, and one that does not parse makes every
 * answer `economics_unreadable`, both naming the file — no request is priced around a broken file.
 * The list is imported through `importList` (default: a dynamic import of `@pydantic/genai-prices`):
 * not installed (`ERR_MODULE_NOT_FOUND`) ⇒ no list; any other failure ⇒ every list answer is
 * `price_list_error`. The composed source asks the file first, and the list only for a model the
 * file does not have; with neither, `no_price_source`. With the default importer, the result is
 * cached by `economicsPath` for the process's life: an edited file is read again after a restart.
 */
export function loadPriceSource(
  opts: { economicsPath?: string; importList?: () => Promise<unknown> } = {},
): Promise<PriceSource> {
  if (opts.importList !== undefined) return buildPriceSource(opts.economicsPath, opts.importList);
  const key = opts.economicsPath ?? '';
  let loaded = cache.get(key);
  if (loaded === undefined) {
    loaded = buildPriceSource(opts.economicsPath, importInstalledList);
    cache.set(key, loaded);
  }
  return loaded;
}

async function buildPriceSource(
  economicsPath: string | undefined,
  importList: () => Promise<unknown>,
): Promise<PriceSource> {
  let economics: CacheEconomics | undefined;
  if (economicsPath !== undefined) {
    let text: string;
    try {
      text = await readFile(economicsPath, 'utf8');
    } catch (err) {
      return notPricedSource(
        'economics_unreachable',
        `cannot read '${economicsPath}': ${errorCode(err) ?? boundedMessage(err)}`,
      );
    }
    const parsed = parseCacheEconomics(text);
    if ('error' in parsed) {
      const at =
        parsed.error.line !== undefined
          ? ` (line ${parsed.error.line}${parsed.error.column !== undefined ? `, column ${parsed.error.column}` : ''})`
          : '';
      return notPricedSource(
        'economics_unreadable',
        `'${economicsPath}'${at}: ${parsed.error.reason}`,
      );
    }
    economics = parsed.economics;
  }

  let list: PriceSource | undefined;
  let listError: string | undefined;
  try {
    const mod = await importList();
    if (isPriceList(mod)) list = listPriceSource(mod, readPriceListVersion());
    else listError = 'the installed price list has no calcPrice';
  } catch (err) {
    if (errorCode(err) !== 'ERR_MODULE_NOT_FOUND') listError = boundedMessage(err);
  }

  if (economics === undefined && list === undefined && listError === undefined) {
    return notPricedSource('no_price_source');
  }
  return {
    price(input: PriceInput): PriceResult {
      if (economics !== undefined) {
        const fromFile = priceFromEconomics(economics, input.model, input.at, input.usage);
        if (!('not_priced' in fromFile)) {
          return { ...fromFile, priced_by: { ...fromFile.priced_by, source_ref: economicsPath! } };
        }
        if (fromFile.not_priced !== 'model_unknown') return fromFile;
      }
      if (list !== undefined) return list.price(input);
      if (listError !== undefined) return { not_priced: 'price_list_error', detail: listError };
      return { not_priced: 'model_unknown' };
    },
  };
}

/**
 * A source whose answers carry a host's note: every priced figure gets it as `source_note`, and
 * every not-priced answer without a detail gets it as `detail`. The server's list-only default says
 * through it that no economics file is configured on that server.
 */
export function withSourceNote(source: PriceSource, note: string): PriceSource {
  return {
    price(input: PriceInput): PriceResult {
      const result = source.price(input);
      if ('not_priced' in result)
        return result.detail !== undefined ? result : { ...result, detail: note };
      return { ...result, priced_by: { ...result.priced_by, source_note: note } };
    },
  };
}
