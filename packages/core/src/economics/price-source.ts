// price-source.ts — issue #600 caching PR P (A3): the port a host hands core to price a request,
// the closed set of reasons a request is not priced, and the checks core runs around every call —
// the preconditions before (so no source ever prices a request realm could not read) and the
// postcondition after (so a source never prices a model the request did not name). Pure: a source
// is a synchronous function; hosts read files and import the price list, never core.
import { readStoredName } from '../engine/holder.js';
import type { RequestEndpoint } from '../types/run-record.js';
import { withoutDateSuffix } from './cache-economics.js';

/**
 * Why a request has no price. Each member names its producer:
 * - `no_price_source`: a host priced with no source (`get_run_state` given none; a host with no
 *   economics file and no price list installed);
 * - `economics_unreadable`: the host read the economics file and `parseCacheEconomics` refused it;
 * - `economics_unreachable`: the host could not read the economics file, `realm.yaml`, or the run's
 *   deployment root;
 * - `model_not_recorded`: core's precondition — the request names no model (recorded by Realm
 *   0.47.0 or earlier, or by a provider that does not state it);
 * - `model_unknown`: the source has no price for the model, or core's postcondition refused the
 *   model the source matched;
 * - `usage_incomplete`: core's precondition (a counter missing or not a number, reads and writes
 *   above the prompt, a write split that does not add up, or writes with no split from a provider
 *   that splits them), or `priceFromEconomics`' own split check;
 * - `date_unreadable`: core's precondition — the request's `request_start` does not parse;
 * - `price_list_error`: the price list threw or answered something else than a price, or a source
 *   returned a malformed result (core's wrap);
 * - `rate_missing`: `priceFromEconomics` — the runner's file has the model but not a rate a counter
 *   above 0 needs.
 */
export const NOT_PRICED_CAUSES = [
  'no_price_source',
  'economics_unreadable',
  'economics_unreachable',
  'model_not_recorded',
  'model_unknown',
  'usage_incomplete',
  'date_unreadable',
  'price_list_error',
  'rate_missing',
] as const;
export type NotPricedCause = (typeof NOT_PRICED_CAUSES)[number];

/**
 * One request's counters as a source prices them: the prompt is the WHOLE input (reads and writes
 * inside it); a cache counter the request did not report is 0; the 5-minute and 1-hour write
 * counters are present only when the request recorded the split, and then add up to the write.
 */
export interface PriceUsage {
  prompt_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cache_write_5m_tokens?: number;
  cache_write_1h_tokens?: number;
}

export interface PriceInput {
  /** The model the response named. */
  model: string;
  /** The request's `request_start`. */
  at: string;
  /** The provider that served the request, as `realm agent` stamped it. */
  provider?: string;
  endpoint?: RequestEndpoint;
  usage: PriceUsage;
}

/** What priced a request: every figure names its source and its date basis. */
export interface PricedBy {
  source_class: 'economics' | 'price_list';
  /** The economics file's path, or the price list's package name. */
  source_ref: string;
  /** The price list's version (`version unknown` when it could not be read). */
  version?: string;
  /** The model id the source priced. */
  matched_model: string;
  /** The provider the price list matched. */
  matched_provider?: string;
  /** The model's `equals` names in the price list: the ids it is known by. */
  equals_ids?: string[];
  /** `dated` when the source has dated prices for the model (the price at the call's date), else `current`. */
  date_basis: 'dated' | 'current';
  /** A list price on a custom endpoint: the endpoint may bill differently. */
  endpoint_note?: string;
  /** A host's note on the source (a server with no economics file configured). */
  source_note?: string;
}

export type PriceResult =
  | { priced: { total: number; uncached_counterfactual: number }; priced_by: PricedBy }
  | { not_priced: NotPricedCause; detail?: string };

/** The port: a host's prices. Synchronous. */
export interface PriceSource {
  price(input: PriceInput): PriceResult;
}

/** A field of an unknown entry, or `undefined` when the entry is not an object. */
function fieldOf(entry: unknown, key: string): unknown {
  if (typeof entry !== 'object' || entry === null) return undefined;
  return (entry as Record<string, unknown>)[key];
}

/** A counter: absent (`undefined` or `null`) or a finite number ≥ 0; anything else is invalid. */
function counter(value: unknown): number | undefined | 'invalid' {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 'invalid';
  return value;
}

function isPricedBy(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as Record<string, unknown>;
  const optionalString = (k: string): boolean => p[k] === undefined || typeof p[k] === 'string';
  return (
    (p['source_class'] === 'economics' || p['source_class'] === 'price_list') &&
    typeof p['source_ref'] === 'string' &&
    typeof p['matched_model'] === 'string' &&
    (p['date_basis'] === 'dated' || p['date_basis'] === 'current') &&
    optionalString('version') &&
    optionalString('matched_provider') &&
    optionalString('endpoint_note') &&
    optionalString('source_note') &&
    (p['equals_ids'] === undefined ||
      (Array.isArray(p['equals_ids']) && p['equals_ids'].every((x) => typeof x === 'string')))
  );
}

/** True when a source's answer has the port's shape. */
function isPriceResult(value: unknown): value is PriceResult {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  if ('not_priced' in r) {
    return (
      (NOT_PRICED_CAUSES as readonly unknown[]).includes(r['not_priced']) &&
      (r['detail'] === undefined || typeof r['detail'] === 'string')
    );
  }
  const priced = r['priced'];
  if (typeof priced !== 'object' || priced === null) return false;
  const total = (priced as Record<string, unknown>)['total'];
  const counterfactual = (priced as Record<string, unknown>)['uncached_counterfactual'];
  return (
    typeof total === 'number' &&
    Number.isFinite(total) &&
    typeof counterfactual === 'number' &&
    Number.isFinite(counterfactual) &&
    isPricedBy(r['priced_by'])
  );
}

/**
 * Prices one stored request through `source`, with core's checks around it. Total: never throws.
 * Preconditions, before the source is asked: the request names a model (else `model_not_recorded`);
 * its `request_start` parses (else `date_unreadable`); `prompt_tokens` and `output_tokens` are
 * present, and every counter present is a finite number ≥ 0; reads plus writes are at most the
 * prompt; a recorded 5-minute/1-hour split adds up to the write exactly; writes above 0 with no
 * split are priced only from a provider that never splits (`cache_split_offered: false`) — else
 * `usage_incomplete`. The postcondition, after: the recorded model is the model the source matched,
 * or one of its `equals_ids`, or either with a date suffix — else `model_unknown`. A source that
 * throws or answers in another shape is `price_list_error`.
 */
export function priceRequest(request: unknown, source: PriceSource): PriceResult {
  const model = readStoredName(fieldOf(request, 'model'));
  if (model === undefined) return { not_priced: 'model_not_recorded' };
  const at = fieldOf(request, 'request_start');
  if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) {
    return { not_priced: 'date_unreadable' };
  }
  const prompt = counter(fieldOf(request, 'prompt_tokens'));
  const output = counter(fieldOf(request, 'output_tokens'));
  const read = counter(fieldOf(request, 'cache_read_input_tokens'));
  const creation = counter(fieldOf(request, 'cache_creation_input_tokens'));
  const writeTokens = counter(fieldOf(request, 'cache_write_tokens'));
  const split = fieldOf(request, 'cache_creation');
  const w5m = counter(fieldOf(split, 'ephemeral_5m_input_tokens'));
  const w1h = counter(fieldOf(split, 'ephemeral_1h_input_tokens'));
  const all = [prompt, output, read, creation, writeTokens, w5m, w1h];
  if (all.includes('invalid') || typeof prompt !== 'number' || typeof output !== 'number') {
    return { not_priced: 'usage_incomplete' };
  }
  // `cache_creation_input_tokens`, else `cache_write_tokens`: the first present, never summed.
  const write = (creation as number | undefined) ?? (writeTokens as number | undefined) ?? 0;
  const readTokens = (read as number | undefined) ?? 0;
  if (readTokens + write > prompt) return { not_priced: 'usage_incomplete' };
  const hasSplit = w5m !== undefined || w1h !== undefined;
  if (
    hasSplit &&
    ((w5m as number | undefined) ?? 0) + ((w1h as number | undefined) ?? 0) !== write
  ) {
    return { not_priced: 'usage_incomplete' };
  }
  if (write > 0 && !hasSplit && fieldOf(request, 'cache_split_offered') !== false) {
    return { not_priced: 'usage_incomplete' };
  }
  const usage: PriceUsage = {
    prompt_tokens: prompt,
    output_tokens: output,
    cache_read_tokens: readTokens,
    cache_write_tokens: write,
    ...(hasSplit
      ? {
          cache_write_5m_tokens: (w5m as number | undefined) ?? 0,
          cache_write_1h_tokens: (w1h as number | undefined) ?? 0,
        }
      : {}),
  };
  const provider = readStoredName(fieldOf(request, 'provider'));
  const endpoint = fieldOf(request, 'endpoint');
  const input: PriceInput = {
    model,
    at,
    ...(provider !== undefined ? { provider } : {}),
    ...(endpoint === 'default' || endpoint === 'custom' ? { endpoint } : {}),
    usage,
  };
  let result: unknown;
  try {
    result = source.price(input);
  } catch {
    return { not_priced: 'price_list_error' };
  }
  if (!isPriceResult(result)) return { not_priced: 'price_list_error' };
  if ('not_priced' in result) return result;
  const names = [result.priced_by.matched_model, ...(result.priced_by.equals_ids ?? [])];
  const undated = withoutDateSuffix(model);
  if (!names.includes(model) && (undated === undefined || !names.includes(undated))) {
    return { not_priced: 'model_unknown' };
  }
  return result;
}
