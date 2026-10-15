// price-source-list.ts — issue #600 caching PR P (C2): the price list adapter. `@pydantic/genai-prices`
// is an optional peer dependency a runner may install beside realm; this file turns one request into
// the list's own usage keys, asks it twice (the request, and the same request with no caching), and
// answers the port's shape. Core runs its checks around every answer (`priceRequest`); this file
// never decides on its own that a model id is the one the request named.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { PriceInput, PriceResult, PriceSource } from '@sensigo/realm';

/** The list's package name, the `source_ref` of every list figure. */
export const PRICE_LIST_PACKAGE = '@pydantic/genai-prices';

/** The note a list figure carries on a custom endpoint. */
export const LIST_ENDPOINT_NOTE = 'list price, your endpoint may bill differently';

/** What realm reads from the list's answer (its `PriceCalculation`, 0.1.12). */
interface ListAnswer {
  total_price?: unknown;
  model?: { id?: unknown; match?: unknown; prices?: unknown };
  provider?: { id?: unknown };
}

/** The one function realm calls on the list. */
export interface PriceList {
  calcPrice(
    usage: Record<string, number>,
    modelId: string,
    options?: { providerId?: string; timestamp?: Date },
  ): unknown;
}

/** True when `value` is a module that exports the list's `calcPrice`. */
export function isPriceList(value: unknown): value is PriceList {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { calcPrice?: unknown }).calcPrice === 'function'
  );
}

/**
 * The installed list's version: its `package.json` found in the first `node_modules` folder Node
 * would search from this file (`createRequire(import.meta.url).resolve.paths`); never
 * `import.meta.resolve`, which a bundler cannot evaluate; `version unknown` when none is found.
 */
export function readPriceListVersion(): string {
  try {
    const paths = createRequire(import.meta.url).resolve.paths(PRICE_LIST_PACKAGE) ?? [];
    for (const p of paths) {
      let pkg: { name?: unknown; version?: unknown };
      try {
        pkg = JSON.parse(
          readFileSync(join(p, '@pydantic', 'genai-prices', 'package.json'), 'utf8'),
        );
      } catch {
        continue; // no list in this folder
      }
      if (pkg.name === PRICE_LIST_PACKAGE && typeof pkg.version === 'string') return pkg.version;
    }
  } catch {
    // nothing to search
  }
  return 'version unknown';
}

/** The `equals` names reachable in a list model's match clause (through `or` and `and`). */
function equalsIds(match: unknown, into: string[] = []): string[] {
  if (typeof match !== 'object' || match === null) return into;
  const m = match as Record<string, unknown>;
  if (typeof m['equals'] === 'string' && !into.includes(m['equals'])) into.push(m['equals']);
  for (const key of ['or', 'and']) {
    const list = m[key];
    if (Array.isArray(list)) for (const inner of list) equalsIds(inner, into);
  }
  return into;
}

/** `dated` when the list has dated prices for the model (the S1 rule), else `current`. */
function dateBasis(prices: unknown): 'dated' | 'current' {
  if (!Array.isArray(prices)) return 'current';
  return prices.some(
    (p) =>
      typeof p === 'object' &&
      p !== null &&
      (p as { constraint?: { type?: unknown } }).constraint?.type === 'start_date',
  )
    ? 'dated'
    : 'current';
}

function boundedMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.length > 200 ? `${message.slice(0, 200)}…` : message;
}

/**
 * The list as a price source. The usage, in the list's own keys only: `input_tokens` is the whole
 * prompt (the list subtracts reads and writes itself), `cache_read_tokens`, `cache_write_tokens`
 * (the write total), and — when the request recorded the lifetime split — `cache_write_5m_tokens`
 * and `cache_write_1h_tokens` beside the total (the total alone would price every write at the
 * 5-minute rate); `output_tokens`. The counterfactual: the prompt and output alone. The provider hint
 * only on the provider's own endpoint (on a custom one it can make a gateway's model unpriceable).
 */
export function listPriceSource(list: PriceList, version: string): PriceSource {
  return {
    price(input: PriceInput): PriceResult {
      const u = input.usage;
      const usage: Record<string, number> = {
        input_tokens: u.prompt_tokens,
        cache_read_tokens: u.cache_read_tokens,
        cache_write_tokens: u.cache_write_tokens,
        ...(u.cache_write_5m_tokens !== undefined
          ? { cache_write_5m_tokens: u.cache_write_5m_tokens }
          : {}),
        ...(u.cache_write_1h_tokens !== undefined
          ? { cache_write_1h_tokens: u.cache_write_1h_tokens }
          : {}),
        output_tokens: u.output_tokens,
      };
      const options = {
        timestamp: new Date(input.at),
        ...(input.endpoint === 'default' && input.provider !== undefined
          ? { providerId: input.provider }
          : {}),
      };
      let answer: ListAnswer | null;
      let counterfactual: ListAnswer | null;
      try {
        answer = list.calcPrice(usage, input.model, options) as ListAnswer | null;
        if (answer === null || answer === undefined) return { not_priced: 'model_unknown' };
        counterfactual = list.calcPrice(
          { input_tokens: u.prompt_tokens, output_tokens: u.output_tokens },
          input.model,
          options,
        ) as ListAnswer | null;
      } catch (err) {
        return { not_priced: 'price_list_error', detail: boundedMessage(err) };
      }
      const total = answer.total_price;
      const cf = counterfactual?.total_price;
      const modelId = answer.model?.id;
      if (typeof total !== 'number' || typeof cf !== 'number' || typeof modelId !== 'string') {
        return {
          not_priced: 'price_list_error',
          detail: 'the price list answered without a price',
        };
      }
      const providerId = answer.provider?.id;
      const ids = equalsIds(answer.model?.match);
      return {
        priced: { total, uncached_counterfactual: cf },
        priced_by: {
          source_class: 'price_list',
          source_ref: PRICE_LIST_PACKAGE,
          version,
          matched_model: modelId,
          ...(typeof providerId === 'string' ? { matched_provider: providerId } : {}),
          ...(ids.length > 0 ? { equals_ids: ids } : {}),
          date_basis: dateBasis(answer.model?.prices),
          ...(input.endpoint === 'custom' ? { endpoint_note: LIST_ENDPOINT_NOTE } : {}),
        },
      };
    },
  };
}
