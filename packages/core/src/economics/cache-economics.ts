// cache-economics.ts — issue #600 caching PR P (A1, A2): the runner's price file, format v1, and its
// evaluator. A runner states the prices it pays in a file `realm.yaml` names
// (`runner.cache.economics`); core owns the format, its strict schema and the arithmetic, and reads
// no file (hosts read the bytes and hand them to `parseCacheEconomics`). Realm ships no price table:
// every rate here comes from the runner's file. Money is derived at read, never stored.
import { Ajv } from 'ajv';
import type { ErrorObject } from 'ajv';
import { JSON_SCHEMA, load } from 'js-yaml';
import type { PriceResult, PriceUsage } from './price-source.js';

/** Rates in USD per million tokens. `input` and `output` always; the cache rates when used. */
export interface CacheEconomicsRates {
  input: number;
  output: number;
  cache_read?: number;
  /** One write rate, for a provider that never splits its writes by lifetime (OpenAI). */
  cache_write?: number;
  /** Writes kept for 5 minutes, for a provider that splits them (Anthropic). */
  cache_write_5m?: number;
  /** Writes kept for 1 hour. */
  cache_write_1h?: number;
}

/** A tier: the WHOLE request is priced at these rates when its prompt exceeds the threshold. */
export interface CacheEconomicsTier {
  above_prompt_tokens: number;
  per_million_tokens: CacheEconomicsRates;
}

/** One price of a model: the first has no `start_date`; each later one applies from its UTC date. */
export interface CacheEconomicsPrice {
  start_date?: string;
  per_million_tokens: CacheEconomicsRates;
  tiers?: CacheEconomicsTier[];
}

/** The economics file, format v1. */
export interface CacheEconomics {
  version: 1;
  currency: 'USD';
  /** Keyed by the exact model id; a recorded id with a date suffix matches its undated entry. */
  models: Record<string, CacheEconomicsModel>;
}

/** One model's entry: its prices, and (issue #600 caching PR 5) the minimum its provider caches. */
export interface CacheEconomicsModel {
  prices: CacheEconomicsPrice[];
  /**
   * The fewest input tokens the provider caches for this model, as the runner copied it from its
   * platform's page. `realm workflow validate` judges each agent step's fixed part against it.
   */
  min_cacheable_tokens?: number;
}

const RATE = { type: 'number', minimum: 0 } as const;
const RATES_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['input', 'output'],
  properties: {
    input: RATE,
    output: RATE,
    cache_read: RATE,
    cache_write: RATE,
    cache_write_5m: RATE,
    cache_write_1h: RATE,
  },
} as const;

/** Ajv-strict JSON schema of the economics file, format v1 (`additionalProperties: false` at every level). */
export const CACHE_ECONOMICS_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['version', 'currency', 'models'],
  properties: {
    version: { const: 1 },
    currency: { enum: ['USD'] },
    models: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        additionalProperties: false,
        required: ['prices'],
        properties: {
          min_cacheable_tokens: { type: 'integer', minimum: 1 },
          prices: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['per_million_tokens'],
              properties: {
                start_date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
                per_million_tokens: RATES_SCHEMA,
                tiers: {
                  type: 'array',
                  minItems: 1,
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['above_prompt_tokens', 'per_million_tokens'],
                    properties: {
                      above_prompt_tokens: { type: 'integer', minimum: 1 },
                      per_million_tokens: RATES_SCHEMA,
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

/** The deployment manifest's error form (`formatAjvError` there), for this file. */
function formatAjvError(err: ErrorObject): string {
  const where = err.instancePath === '' ? 'economics' : `economics${err.instancePath}`;
  const detail =
    err.keyword === 'additionalProperties'
      ? `unknown key '${String((err.params as { additionalProperty?: string }).additionalProperty)}'`
      : (err.message ?? 'invalid');
  return `${where}: ${detail}`;
}

/** True when `date` (`YYYY-MM-DD`) names a day on the calendar. */
function onCalendar(date: string): boolean {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

const RATE_NAMES = [
  'input',
  'output',
  'cache_read',
  'cache_write',
  'cache_write_5m',
  'cache_write_1h',
] as const;

/** The checks after the schema: dates, their order, tier order, and tiers carrying every base rate. */
function checkAfterSchema(economics: CacheEconomics): string | undefined {
  for (const [model, { prices }] of Object.entries(economics.models)) {
    const where = `economics/models/${model}/prices`;
    let previous: string | undefined;
    for (let i = 0; i < prices.length; i += 1) {
      const price = prices[i]!;
      if (i === 0 && price.start_date !== undefined) {
        return `${where}/0: the first price has no start_date (it applies before every dated one)`;
      }
      if (i > 0) {
        if (price.start_date === undefined) {
          return `${where}/${i}: every price after the first needs a start_date`;
        }
        if (!onCalendar(price.start_date)) {
          return `${where}/${i}: start_date '${price.start_date}' is not a date on the calendar`;
        }
        if (previous !== undefined && price.start_date <= previous) {
          return `${where}/${i}: start_date '${price.start_date}' must come after '${previous}' (dates ascending, each once)`;
        }
        previous = price.start_date;
      }
      let threshold: number | undefined;
      for (let t = 0; t < (price.tiers ?? []).length; t += 1) {
        const tier = price.tiers![t]!;
        if (threshold !== undefined && tier.above_prompt_tokens <= threshold) {
          return `${where}/${i}/tiers/${t}: above_prompt_tokens must be above ${threshold} (thresholds ascending, each once)`;
        }
        threshold = tier.above_prompt_tokens;
        for (const rate of RATE_NAMES) {
          if (
            price.per_million_tokens[rate] !== undefined &&
            tier.per_million_tokens[rate] === undefined
          ) {
            return `${where}/${i}/tiers/${t}: the tier has no '${rate}', which its price has (a tier carries every rate of its price)`;
          }
        }
      }
    }
  }
  return undefined;
}

/** js-yaml's own message, cut at 200 characters. */
function boundedYamlMessage(message: string): string {
  return message.length > 200 ? `${message.slice(0, 200)}…` : message;
}

/**
 * Parses an economics file's text. Pure. YAML is read with js-yaml's JSON schema, so an unquoted
 * date stays a string. The reason on an error is the first schema error (the deployment manifest's
 * form), the first check after the schema that fails, or js-yaml's message cut at 200 characters,
 * with its line and column (1-based) when js-yaml gives them.
 */
export function parseCacheEconomics(
  text: string,
): { economics: CacheEconomics } | { error: { reason: string; line?: number; column?: number } } {
  let raw: unknown;
  try {
    raw = load(text, { schema: JSON_SCHEMA });
  } catch (err) {
    const mark = (err as { mark?: { line?: unknown; column?: unknown } }).mark;
    const reason = (err as { reason?: unknown }).reason;
    const message =
      typeof reason === 'string' ? reason : err instanceof Error ? err.message : String(err);
    return {
      error: {
        reason: boundedYamlMessage(message),
        ...(typeof mark?.line === 'number' ? { line: mark.line + 1 } : {}),
        ...(typeof mark?.column === 'number' ? { column: mark.column + 1 } : {}),
      },
    };
  }
  const ajv = new Ajv({ strict: true, allErrors: true });
  if (!ajv.validate(CACHE_ECONOMICS_JSON_SCHEMA, raw)) {
    const first = ajv.errors?.[0];
    return {
      error: { reason: first !== undefined ? formatAjvError(first) : 'economics: invalid' },
    };
  }
  const economics = raw as CacheEconomics;
  const after = checkAfterSchema(economics);
  if (after !== undefined) return { error: { reason: after } };
  return { economics };
}

/**
 * A model id's date suffix (`-YYYYMMDD` or `-YYYY-MM-DD`, a day on the calendar), removed;
 * `undefined` when it has none, or when its tail is digits that are not a day (`-12345678`,
 * `-2026-02-30`).
 */
export function withoutDateSuffix(model: string): string | undefined {
  const match = /^(.+)-(?:(\d{4})(\d{2})(\d{2})|(\d{4}-\d{2}-\d{2}))$/.exec(model);
  if (match === null) return undefined;
  const day = match[5] ?? `${match[2]}-${match[3]}-${match[4]}`;
  return onCalendar(day) ? match[1] : undefined;
}

/**
 * The entry a model id names in the runner's economics file: an exact entry wins; else the id with
 * its date suffix removed; else `undefined`. Pricing and the cache floor read a model through this
 * one match, so a dated id finds the same entry for both.
 */
export function matchModel(economics: CacheEconomics, model: string): string | undefined {
  if (Object.hasOwn(economics.models, model)) return model;
  const stripped = withoutDateSuffix(model);
  if (stripped !== undefined && Object.hasOwn(economics.models, stripped)) return stripped;
  return undefined;
}

/**
 * Issue #600 caching PR 5 — the minimum a model caches, as the runner's economics file states it.
 * Pure. `model_unknown` when the file has no entry for the model (through {@link matchModel});
 * `no_minimum_stated` when its entry has no `min_cacheable_tokens`.
 */
export function minCacheableTokensFor(
  economics: CacheEconomics,
  model: string,
): { tokens: number } | { absent: 'model_unknown' | 'no_minimum_stated' } {
  const matched = matchModel(economics, model);
  if (matched === undefined) return { absent: 'model_unknown' };
  const tokens = economics.models[matched]!.min_cacheable_tokens;
  return tokens !== undefined ? { tokens } : { absent: 'no_minimum_stated' };
}

/**
 * Prices one request from the runner's economics file. Pure.
 * - The model: an exact entry wins; else the recorded id with its date suffix removed; else
 *   `model_unknown`.
 * - The price: the last whose `start_date` is on or before the UTC date of `at`; the undated first
 *   one applies before every dated one. `date_basis` is `current` when the model has one price
 *   (it never changed), `dated` when it has dated ones (the undated base included: it is the price
 *   before the first dated one).
 * - The tier: the whole request at the highest tier whose `above_prompt_tokens` its prompt exceeds
 *   (strictly), else the price's own rates; the counterfactual at the same tier.
 * - Uncached input = prompt − cache read − cache write (never the record's `uncached_input_tokens`).
 * - The writes: the 5-minute and 1-hour rates when the usage carries the split, else the single
 *   write rate. A rate needed for a counter above 0 that the file lacks is `rate_missing`, named.
 */
export function priceFromEconomics(
  economics: CacheEconomics,
  model: string,
  at: string,
  usage: PriceUsage,
): PriceResult {
  const matched = matchModel(economics, model);
  if (matched === undefined) return { not_priced: 'model_unknown' };
  const entry = economics.models[matched]!;
  const time = Date.parse(at);
  if (Number.isNaN(time)) return { not_priced: 'date_unreadable' };
  const day = new Date(time).toISOString().slice(0, 10);
  let price = entry.prices[0]!;
  for (const candidate of entry.prices) {
    if (candidate.start_date === undefined || candidate.start_date <= day) price = candidate;
  }
  const dateBasis = entry.prices.length > 1 ? 'dated' : 'current';

  const prompt = usage.prompt_tokens;
  let rates = price.per_million_tokens;
  for (const tier of price.tiers ?? []) {
    if (prompt > tier.above_prompt_tokens) rates = tier.per_million_tokens;
  }

  const read = usage.cache_read_tokens;
  const write = usage.cache_write_tokens;
  const split =
    usage.cache_write_5m_tokens !== undefined || usage.cache_write_1h_tokens !== undefined;
  const w5m = usage.cache_write_5m_tokens ?? 0;
  const w1h = usage.cache_write_1h_tokens ?? 0;
  if (split && w5m + w1h !== write) return { not_priced: 'usage_incomplete' };

  const needs: Array<[keyof CacheEconomicsRates, number]> = [
    ['cache_read', read],
    ...(split
      ? ([
          ['cache_write_5m', w5m],
          ['cache_write_1h', w1h],
        ] as Array<[keyof CacheEconomicsRates, number]>)
      : ([['cache_write', write]] as Array<[keyof CacheEconomicsRates, number]>)),
  ];
  let cacheCost = 0;
  for (const [rate, tokens] of needs) {
    if (tokens <= 0) continue;
    const per = rates[rate];
    if (per === undefined) {
      return { not_priced: 'rate_missing', detail: `has no '${rate}' rate for '${matched}'` };
    }
    cacheCost += tokens * per;
  }
  const uncached = prompt - read - write;
  const total = (uncached * rates.input + cacheCost + usage.output_tokens * rates.output) / 1e6;
  const counterfactual = (prompt * rates.input + usage.output_tokens * rates.output) / 1e6;
  return {
    priced: { total, uncached_counterfactual: counterfactual },
    priced_by: {
      source_class: 'economics',
      // The host that read the file replaces this with the file's path.
      source_ref: 'economics',
      matched_model: matched,
      date_basis: dateBasis,
    },
  };
}
