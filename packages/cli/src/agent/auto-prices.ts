// auto-prices.ts — issue #898: `--prompt-cache auto` reads its prices from the runner's price file
// (`runner.cache.economics`). `realm agent` builds the Anthropic provider before the workflow and
// `realm.yaml` load, so a drive `realm listen` started with measured gaps leaves the provider's choice
// PENDING; after the load, `realm agent` reads the file once here and settles it. Nothing here can stop
// a run: every failure of the file is a named cause, and the choice falls back by the owner's rule.
import {
  selectEconomicsRates,
  type AutoPriceInput,
  type CacheAutoPrices,
  type CacheChoice,
} from '@sensigo/realm';

/** The two file causes, with the reader's own detail (the path, the position, the reason). */
type FileCause = { cause: 'economics_unreachable' | 'economics_unreadable'; detail: string };

/**
 * What `auto`'s choice is priced from, for the requested `model` on the UTC day of `at`: `no_file`
 * when `runner.cache.economics` is not set; the reader's cause, with its detail, when the file cannot
 * be read or is not a valid price file; `model_unknown` when it has no entry for the model; else the
 * base rates of the row in force (`selectEconomicsRates` with no prompt size). The lookup adds no
 * suffix to `model`. Never throws for the file: `readCacheEconomics` returns its causes. An `at` that
 * does not parse throws a plain `Error` — a fresh `toISOString()` always parses.
 */
export async function readAutoPrices(
  path: string | undefined,
  model: string,
  at: string,
): Promise<AutoPriceInput | FileCause> {
  if (path === undefined) return { cause: 'no_file' };
  const { readCacheEconomics } = await import('@sensigo/realm-mcp');
  const read = await readCacheEconomics(path);
  if ('cause' in read) return { cause: read.cause, detail: read.detail };
  const selected = selectEconomicsRates(read.economics, model, at);
  if ('not_priced' in selected) {
    if (selected.not_priced === 'model_unknown') return { cause: 'model_unknown' };
    throw new Error(`readAutoPrices: the time '${at}' does not parse`);
  }
  return { rates: selected.rates };
}

/** A line break (any of the usual forms) and the spaces after it. */
const LINE_BREAK = /(?:\r\n|\r|\n|\u2028|\u2029)[ \t]*/g;

/**
 * The one stderr line for a price file that could not be used, in the reader's own words, on ONE
 * line: every line break, and the spaces after it, becomes one space. A file that cannot be read:
 * the path and the code. A file that does not parse: the path, the position and the reason — except
 * a reason that holds js-yaml's full message (a blank line, then a quoted snippet of the file), where
 * only the path and the position are printed: the line never quotes the file.
 */
export function priceFileWarning(path: string, read: FileCause): string {
  let text = read.detail;
  if (read.cause === 'economics_unreadable') {
    const quoted = `'${path}'`;
    const rest = read.detail.startsWith(quoted) ? read.detail.slice(quoted.length) : undefined;
    const parts =
      rest === undefined ? null : /^( \(line \d+(?:, column \d+)?\))?: ([\s\S]*)$/.exec(rest);
    if (parts === null) {
      text = quoted;
    } else {
      const position = parts[1] ?? '';
      const reason = parts[2] ?? '';
      const quotesTheFile =
        /(?:\r\n|\r|\n)[ \t]*(?:\r\n|\r|\n)/.test(reason) || /\n\s*\d+\s*\|/.test(reason);
      text = quotesTheFile ? `${quoted}${position}` : `${quoted}${position}: ${reason}`;
    }
  }
  return `  ⚠ the price file could not be used: ${text.replace(LINE_BREAK, ' ')}. auto chose without prices.`;
}

/**
 * Settles a pending `auto` choice from the runner's price file (C.2): the wall clock is read once
 * (C.3 — class `outside`: the provider bills on its own day, as `request_start` does), the file is
 * read once, and the provider's `settleAutoChoice` (`settleAuto`) chooses. Returns its outcome and,
 * when the file could not be read or is not valid, the one stderr line for `realm agent` to print.
 * Reads no `RunRecord` instant.
 */
export async function settleAutoFromPriceFile(
  settleAuto: (prices: AutoPriceInput) => { choice: CacheChoice; prices?: CacheAutoPrices },
  path: string | undefined,
  model: string,
): Promise<{ choice: CacheChoice; prices?: CacheAutoPrices; warning?: string }> {
  const at = new Date().toISOString();
  const read = await readAutoPrices(path, model, at);
  if ('detail' in read) {
    const outcome = settleAuto({ cause: read.cause });
    return path !== undefined ? { ...outcome, warning: priceFileWarning(path, read) } : outcome;
  }
  return settleAuto(read);
}
