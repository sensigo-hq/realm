// step-view.ts — issue #600 PR 1b: one cost view per step, derived ONCE in core, rendered by
// EVERY operator/agent surface that shows what a run's model calls cost (`realm run inspect`,
// `get_run_state`'s `include_steps`).
//
// Before this file, `packages/cli/src/commands/inspect.ts` computed its own sums directly off
// `StepDiagnostics.cache`/`DriveFailureRecord.usage`, and `get_run_state` had no per-step surface
// at all. Two independent implementations of "how do you sum a per-request counter honestly" is
// how the two surfaces could disagree about one number; this file is the ONE place that rule
// lives now.
//
// TOTALITY, following the `buildEntry` precedent (drive-failure.ts): no input a store can hand
// these functions — a non-array, `null` entries, non-object entries, `evidence` or
// `drive_failures` shaped wrong — makes any of them throw. A malformed record degrades to an
// absence or an `'unknown'` field, never an exception that takes the whole render down with it.
import type {
  CacheAuto,
  CacheAutoPricesView,
  RequestFactAbsentCause,
  RunRecord,
} from '../types/run-record.js';
import { normalizeCacheAuto } from '../economics/cache-lifetime.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
import {
  priceRequest,
  type NotPricedCause,
  type PricedBy,
  type PriceResult,
  type PriceSource,
} from '../economics/price-source.js';
import {
  readDrivenBy,
  readGateClaimVerdict,
  readStoredName,
  type ActorAbsent,
  type Attributed,
  type ClaimProofAbsentCause,
  type GateClaimVerdict,
} from './holder.js';

/**
 * One figure and the scope it was summed over. Never a guess, never a default — `value` is the sum
 * over ONLY the requests that reported the counter (`typeof === 'number'`; `null` is one of the
 * two absence spellings a provider's own type allows and is never coerced to `0`). A counter no
 * request reported has no `CostFigure` at all — the caller's absence, never a manufactured zero.
 */
export interface CostFigure {
  /** Sum over the requests that REPORTED this counter. */
  value: number;
  /** How many requests reported it. Always >= 1 — a figure nobody reported is ABSENT, not zero. */
  reported: number;
  /** How many requests this cost holds, whether or not each one reported this counter. */
  of: number;
  /** 0-based index into the requests. Present iff `reported === 1` — the one request it came from. */
  only_request_index?: number;
}

export interface CostView {
  requests: number;
  /** Verbatim when a string; absent when absent or `null` — never a re-derived guess. */
  basis?: string;
  /** Verbatim when a string; absent otherwise. */
  state?: string;
  /** `UsageRecord.prompt_tokens`. */
  prompt?: CostFigure;
  /** `UsageRecord.uncached_input_tokens`. */
  uncached_input?: CostFigure;
  /** `UsageRecord.cache_read_input_tokens`. */
  cache_read?: CostFigure;
  /**
   * `cache_creation_input_tokens`, else `cache_write_tokens` — the first one PRESENT per request,
   * never summed together (the two are alternative spellings of one provider fact, never two
   * components of it).
   */
  cache_write?: CostFigure;
  /** `UsageRecord.output_tokens`. */
  output?: CostFigure;
  /**
   * Issue #600 PR 2 — the models the provider's responses named (`UsageRecord.model`), or why none
   * is readable. Present iff `requests > 0`.
   */
  models?: CostModels;
  /**
   * Issue #600 PR 2 — what realm asked the provider to cache, per distinct ask, or why none is
   * readable. Present iff `requests > 0`.
   */
  cache_requested?: CostCacheRequested;
  /** Issue #600 PR 2 — `cache_creation.ephemeral_5m_input_tokens`: cache writes kept for 5 minutes. */
  cache_write_5m?: CostFigure;
  /** Issue #600 PR 2 — `cache_creation.ephemeral_1h_input_tokens`: cache writes kept for 1 hour. */
  cache_write_1h?: CostFigure;
  /**
   * Issue #600 caching PR P — how many requests went to a custom endpoint (`custom`) out of all
   * (`of`), from each request's `endpoint`; when no request records one, the typed absence by cause
   * (PR 2's rule). Present iff `requests > 0`.
   */
  endpoints?: CostEndpoints;
  /**
   * Issue #600 caching PR P — what the requests cost, priced at read by the host's price source.
   * Present only when a price source was given and `requests > 0`; never stored.
   */
  money?: Money;
}

/** Issue #600 caching PR P — the requests sent to a custom endpoint, or why none records one. */
export type CostEndpoints =
  { custom: number; of: number } | { absent_cause: RequestFactAbsentCause };

/**
 * Issue #600 caching PR P — one source of the priced requests: what priced them (`PricedBy`'s
 * fields), how many it priced (`count`) and how many of those at the call's date (`dated`).
 */
export interface MoneySource {
  source_class: PricedBy['source_class'];
  source_ref: string;
  version?: string;
  matched_provider?: string;
  matched_model: string;
  count: number;
  dated: number;
  endpoint_note?: string;
  source_note?: string;
}

/**
 * Issue #600 caching PR P — money, derived at read and never stored, in USD and unrounded. `total`
 * and `uncached_counterfactual` (what the same requests would cost with no caching) are sums over
 * the PRICED requests only; `net` = counterfactual − total (what caching saved; negative when it
 * cost more). `priced` of `of` requests were priced; every other request is counted under the
 * cause it was not priced for.
 */
export interface Money {
  total: number;
  uncached_counterfactual: number;
  net: number;
  priced: number;
  of: number;
  /** How many of the priced requests were priced at the call's date (a dated price). */
  dated: number;
  /** One per source and model priced: what priced them, how many, how many at the call's date. */
  sources: MoneySource[];
  /**
   * The same counts per source alone (the economics file, or one price list version), whatever
   * model each priced: what a surface names when several sources priced the requests.
   */
  source_totals: MoneySourceTotal[];
  not_priced?: Array<{ cause: NotPricedCause; count: number; detail?: string }>;
}

/** Issue #600 caching PR P — one source's counts over every model it priced. */
export interface MoneySourceTotal {
  source_class: PricedBy['source_class'];
  source_ref: string;
  version?: string;
  count: number;
  dated: number;
}

/**
 * Issue #600 caching PR P — what a run cost: every step's total and every failed drive's billed
 * requests on the record; how many failed drives are not on the record any more (the record keeps
 * the last 5); how many on the record carry no usage figures; and how many attempts realm has no
 * usage for, by cause.
 */
export interface RunCost {
  total: Money;
  failed_drives_not_on_record: number;
  /**
   * Failed drives on the record whose `usage` is not an array or is empty: realm has nothing to
   * price for them, and a request may have billed (one that failed on the wire, or a tools-step
   * drive that Realm 0.48.0 or earlier recorded).
   */
  failed_drives_without_usage: number;
  unmeasured: { tool_calling_step: number; not_measured_by_realm: number; cost_unreadable: number };
}

/**
 * Issue #600 PR 2 — the models a step's requests named: the distinct readable names in request
 * order, with how many requests named a readable one (`reported`, at least 1) out of all (`of`).
 * When no request names a readable one, the typed absence by cause (framework §5 E1) instead.
 */
export type CostModels =
  { names: string[]; reported: number; of: number } | { absent_cause: RequestFactAbsentCause };

/**
 * Issue #600 PR 2 — one distinct ask: `value` (a `CACHE_REQUESTS` word, verbatim when a string),
 * `lifetime_s` (kept when a number, of any value — the render judges it), `ttl_sent` (kept when a
 * boolean), `source` (verbatim when a string), `by` (read through `readStoredName`) and — the
 * lifetime unit — `auto` (what `--prompt-cache auto` chose on, read through `normalizeCacheAuto`).
 * Issue #898: `auto.prices` is where the choice took its prices; a request with kept gaps that
 * recorded none (written before Realm priced `auto` from the price file) reads `{ from:
 * 'not_recorded' }`, derived here once for every carrier. No `prices` with no kept gaps means "not
 * needed".
 */
export interface CacheRequestedEntry {
  value: string;
  lifetime_s?: number;
  ttl_sent?: boolean;
  source?: string;
  by?: string;
  auto?: Omit<CacheAuto, 'prices'> & { prices?: CacheAutoPricesView };
}

/**
 * Issue #600 PR 2 — the asks a step's requests made: the distinct entries in request order, with how
 * many requests recorded one (`reported`, at least 1) out of all (`of`); else the typed absence by
 * cause.
 */
export type CostCacheRequested =
  | { entries: CacheRequestedEntry[]; reported: number; of: number }
  | { absent_cause: RequestFactAbsentCause };

/**
 * The closed set of reasons a step's evidence entry carries no `cache` at all. Classification only
 * ever picks between these two — it never asserts a model call happened (see `composeStepViews`
 * rule 5): `tool_calling_step` when the entry declares `tool_calls` and has no `cache` (written by
 * Realm 0.48.0 or earlier, or by a host that records tool calls without usage; issue #610);
 * `not_measured_by_realm` for an agent step realm has no usage figures
 * for — for example, an outside agent over MCP `execute_step` made it, a person typed its answer at
 * a `realm workflow run` prompt, or realm 0.45.0 or earlier recorded it.
 */
export const COST_UNRECORDED_CAUSES = ['tool_calling_step', 'not_measured_by_realm'] as const;
export type CostUnrecordedCause = (typeof COST_UNRECORDED_CAUSES)[number];

export interface AttemptView {
  /** 1-based position among the step's EXECUTION entries (gate_response entries are never attempts). */
  attempt: number;
  /** The entry's `status`, verbatim when a string, else `'unknown'`. */
  status: string;
  cost?: CostView;
  cost_unrecorded?: CostUnrecordedCause;
  /** The entry carried a `cache` whose `requests` is not an array — present, not readable. */
  cost_unreadable?: true;
  /**
   * Issue #625 (the holder slice): the host PROGRAM whose code and credentials did this attempt's
   * work — read by the one reader every stored `Attributed` goes through. `driver_not_recorded`
   * when the entry carries none (it predates the field, or no host passed a name);
   * `name_unreadable` when what it carries is not a readable name with its source.
   */
  driven_by: Attributed | ActorAbsent;
}

/**
 * Issue #625 (the holder slice): one answer to a step's question — read off a `gate_response`
 * entry. `answered_by` is the caller-STATED, unverified name, or why there is none: an entry the
 * gate's expiry wrote with its default choice (it carries `resolution`) reads `settled_by_expiry` — no
 * one answered — whatever its `responded_by` holds. The entry an `on_expiry: abort` expiry writes is
 * not an answer and has no view (`isAnswerEntry`). `claim_proof` is the verdict recorded on the entry; when there is none,
 * `claim_proof_absent` says why — never a blank.
 */
export interface AnswerView {
  choice?: string;
  answered_by: { by: string; by_source: 'stated' } | ActorAbsent;
  claim_proof?: GateClaimVerdict;
  claim_proof_absent?: ClaimProofAbsentCause;
}

export interface StepView {
  attempts: AttemptView[];
  /** One per answer entry (`isAnswerEntry`), in entry order. Absent when the step has no answer. */
  answers?: AnswerView[];
  /**
   * Issue #600 caching PR P — the money across the step's attempts. Present only when a price
   * source was given and at least one attempt has priced or unpriced requests.
   */
  total?: Money;
}

/** Reads a numeric field off an unknown entry, returning `undefined` for anything but a real number
 *  (never coercing `null`, which is one of the two absence spellings a provider's own type allows). */
function numField(entry: unknown, key: string): number | undefined {
  if (typeof entry !== 'object' || entry === null) return undefined;
  const v = (entry as Record<string, unknown>)[key];
  return typeof v === 'number' ? v : undefined;
}

/** Reads a numeric field one level down (`cache_creation.ephemeral_5m_input_tokens`), the same way. */
function nestedNumField(entry: unknown, outer: string, inner: string): number | undefined {
  if (typeof entry !== 'object' || entry === null) return undefined;
  return numField((entry as Record<string, unknown>)[outer], inner);
}

/** A field of an unknown entry, or `undefined` when the entry is not an object. */
function fieldOf(entry: unknown, key: string): unknown {
  if (typeof entry !== 'object' || entry === null) return undefined;
  return (entry as Record<string, unknown>)[key];
}

/**
 * Issue #600 PR 2 (A5) — why a request fact has no readable value: `none_readable` when realm drove
 * the requests (at least one carries `provider`, which only realm's own drive stamps), else
 * `predates_request_facts` (Realm 0.47.0 or earlier, or a host that does not record it).
 */
function requestFactAbsence(requests: readonly unknown[]): {
  absent_cause: RequestFactAbsentCause;
} {
  const drivenByRealm = requests.some((r) => typeof fieldOf(r, 'provider') === 'string');
  return { absent_cause: drivenByRealm ? 'none_readable' : 'predates_request_facts' };
}

/** Issue #600 PR 2 — the models the requests named, each read through `readStoredName`. */
function composeModels(requests: readonly unknown[]): CostModels {
  const names: string[] = [];
  let reported = 0;
  for (const r of requests) {
    const name = readStoredName(fieldOf(r, 'model'));
    if (name === undefined) continue;
    reported += 1;
    if (!names.includes(name)) names.push(name);
  }
  if (reported === 0) return requestFactAbsence(requests);
  return { names, reported, of: requests.length };
}

/**
 * Issue #898 — the view's typed absence (framework §5 E1): a stored `cache_auto` with kept gaps and
 * no `prices` was written before Realm priced `auto` from the price file, so its view says
 * `{ from: 'not_recorded' }`. Every other value passes as stored.
 */
function withPricesAbsence(auto: CacheAuto | undefined): CacheRequestedEntry['auto'] | undefined {
  if (
    auto !== undefined &&
    auto.basis === 'listen_trigger_gaps' &&
    (auto.gaps_s?.length ?? 0) > 0 &&
    auto.prices === undefined
  ) {
    return { ...auto, prices: { from: 'not_recorded' } };
  }
  return auto;
}

/** Issue #600 PR 2 — the distinct asks the requests recorded. */
function composeCacheRequested(requests: readonly unknown[]): CostCacheRequested {
  const entries: CacheRequestedEntry[] = [];
  const seen = new Set<string>();
  let reported = 0;
  for (const r of requests) {
    const value = fieldOf(r, 'cache_requested');
    if (typeof value !== 'string') continue;
    reported += 1;
    const lifetime = fieldOf(r, 'cache_lifetime_s');
    const ttlSent = fieldOf(r, 'cache_ttl_sent');
    const source = fieldOf(r, 'cache_requested_source');
    const by = readStoredName(fieldOf(r, 'cache_requested_by'));
    const auto = withPricesAbsence(normalizeCacheAuto(fieldOf(r, 'cache_auto')));
    const entry: CacheRequestedEntry = {
      value,
      ...(typeof lifetime === 'number' ? { lifetime_s: lifetime } : {}),
      ...(typeof ttlSent === 'boolean' ? { ttl_sent: ttlSent } : {}),
      ...(typeof source === 'string' ? { source } : {}),
      ...(by !== undefined ? { by } : {}),
      ...(auto !== undefined ? { auto } : {}),
    };
    // `auto` is normalised (its keys in one order) and its typed absence derived deterministically
    // (#898), so two requests with the same basis, gaps and prices make one entry whatever key
    // order the store returned.
    const key = JSON.stringify([
      entry.value,
      entry.lifetime_s,
      entry.ttl_sent,
      entry.source,
      entry.by,
      entry.auto,
    ]);
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(entry);
  }
  if (reported === 0) return requestFactAbsence(requests);
  return { entries, reported, of: requests.length };
}

/** Issue #600 caching PR P — the custom-endpoint count, or the typed absence by PR 2's rule. */
function composeEndpoints(requests: readonly unknown[]): CostEndpoints {
  let custom = 0;
  let recorded = 0;
  for (const r of requests) {
    const endpoint = fieldOf(r, 'endpoint');
    if (endpoint !== 'default' && endpoint !== 'custom') continue;
    recorded += 1;
    if (endpoint === 'custom') custom += 1;
  }
  if (recorded === 0) return requestFactAbsence(requests);
  return { custom, of: requests.length };
}

/** Issue #600 caching PR P — money with nothing in it. */
function emptyMoney(): Money {
  return {
    total: 0,
    uncached_counterfactual: 0,
    net: 0,
    priced: 0,
    of: 0,
    dated: 0,
    sources: [],
    source_totals: [],
  };
}

/** Issue #600 caching PR P — the money of each request's price result, summed over the priced ones. */
function moneyOf(results: readonly PriceResult[]): Money {
  const money = emptyMoney();
  for (const result of results) {
    money.of += 1;
    if ('not_priced' in result) {
      const entry = {
        cause: result.not_priced,
        count: 1,
        ...(result.detail !== undefined ? { detail: result.detail } : {}),
      };
      mergeNotPriced(money, [entry]);
      continue;
    }
    money.priced += 1;
    if (result.priced_by.date_basis === 'dated') money.dated += 1;
    money.total += result.priced.total;
    money.uncached_counterfactual += result.priced.uncached_counterfactual;
    const by = result.priced_by;
    mergeSources(money, [
      {
        source_class: by.source_class,
        source_ref: by.source_ref,
        ...(by.version !== undefined ? { version: by.version } : {}),
        ...(by.matched_provider !== undefined ? { matched_provider: by.matched_provider } : {}),
        matched_model: by.matched_model,
        count: 1,
        dated: by.date_basis === 'dated' ? 1 : 0,
        ...(by.endpoint_note !== undefined ? { endpoint_note: by.endpoint_note } : {}),
        ...(by.source_note !== undefined ? { source_note: by.source_note } : {}),
      },
    ]);
  }
  money.net = money.uncached_counterfactual - money.total;
  return money;
}

/** One source's identity: what priced it, and the notes its figure carries. */
function sourceKey(s: MoneySource): string {
  return JSON.stringify([
    s.source_class,
    s.source_ref,
    s.version,
    s.matched_provider,
    s.matched_model,
    s.endpoint_note,
    s.source_note,
  ]);
}

function mergeSources(into: Money, sources: readonly MoneySource[]): void {
  for (const source of sources) {
    const same = into.sources.find((s) => sourceKey(s) === sourceKey(source));
    if (same !== undefined) {
      same.count += source.count;
      same.dated += source.dated;
    } else {
      into.sources.push({ ...source });
    }
    const totals = into.source_totals.find(
      (t) =>
        t.source_class === source.source_class &&
        t.source_ref === source.source_ref &&
        t.version === source.version,
    );
    if (totals !== undefined) {
      totals.count += source.count;
      totals.dated += source.dated;
    } else {
      into.source_totals.push({
        source_class: source.source_class,
        source_ref: source.source_ref,
        ...(source.version !== undefined ? { version: source.version } : {}),
        count: source.count,
        dated: source.dated,
      });
    }
  }
}

function mergeNotPriced(
  into: Money,
  entries: ReadonlyArray<{ cause: NotPricedCause; count: number; detail?: string }>,
): void {
  for (const entry of entries) {
    const list = (into.not_priced ??= []);
    const same = list.find((e) => e.cause === entry.cause && e.detail === entry.detail);
    if (same !== undefined) same.count += entry.count;
    else list.push({ ...entry });
  }
}

/** Issue #600 caching PR P — two moneys summed (the net re-derived from the sums). */
function addMoney(into: Money, more: Money): void {
  into.total += more.total;
  into.uncached_counterfactual += more.uncached_counterfactual;
  into.priced += more.priced;
  into.of += more.of;
  into.dated += more.dated;
  mergeSources(into, more.sources);
  if (more.not_priced !== undefined) mergeNotPriced(into, more.not_priced);
  into.net = into.uncached_counterfactual - into.total;
}

/** `cache_creation_input_tokens`, else `cache_write_tokens` — first present, never summed. */
function cacheWriteField(entry: unknown): number | undefined {
  const a = numField(entry, 'cache_creation_input_tokens');
  if (a !== undefined) return a;
  return numField(entry, 'cache_write_tokens');
}

/** The one summation rule, shared by every counter this file derives. */
function sumFigure(
  requests: readonly unknown[],
  pick: (entry: unknown) => number | undefined,
): CostFigure | undefined {
  const of = requests.length;
  let total = 0;
  let reported = 0;
  let onlyIndex = 0;
  for (let i = 0; i < of; i += 1) {
    const v = pick(requests[i]);
    if (typeof v === 'number') {
      total += v;
      reported += 1;
      onlyIndex = i;
    }
  }
  if (reported === 0) return undefined;
  return {
    value: total,
    reported,
    of,
    ...(reported === 1 ? { only_request_index: onlyIndex } : {}),
  };
}

/**
 * The per-request detail, composed into one roll-up. Returns `undefined` only for a non-array
 * `requests` — an empty array yields `{ requests: 0 }`, a fact distinct from absence (D1 rule 6).
 * With `deps.priceSource` (issue #600 caching PR P), each request is priced through core's checks
 * (`priceRequest`) and the view carries `money`; with none, no `money` key is written.
 */
export function composeCostView(
  requests: unknown,
  extra?: { basis?: unknown; state?: unknown },
  deps?: { priceSource?: PriceSource },
): CostView | undefined {
  if (!Array.isArray(requests)) return undefined;
  const view: CostView = { requests: requests.length };
  if (typeof extra?.basis === 'string') view.basis = extra.basis;
  if (typeof extra?.state === 'string') view.state = extra.state;
  const prompt = sumFigure(requests, (r) => numField(r, 'prompt_tokens'));
  if (prompt !== undefined) view.prompt = prompt;
  const uncachedInput = sumFigure(requests, (r) => numField(r, 'uncached_input_tokens'));
  if (uncachedInput !== undefined) view.uncached_input = uncachedInput;
  const cacheRead = sumFigure(requests, (r) => numField(r, 'cache_read_input_tokens'));
  if (cacheRead !== undefined) view.cache_read = cacheRead;
  const cacheWrite = sumFigure(requests, cacheWriteField);
  if (cacheWrite !== undefined) view.cache_write = cacheWrite;
  const output = sumFigure(requests, (r) => numField(r, 'output_tokens'));
  if (output !== undefined) view.output = output;
  // issue #600 PR 2 (A4): the request facts, from every request, never guessed.
  if (requests.length > 0) {
    view.models = composeModels(requests);
    view.cache_requested = composeCacheRequested(requests);
  }
  const write5m = sumFigure(requests, (r) =>
    nestedNumField(r, 'cache_creation', 'ephemeral_5m_input_tokens'),
  );
  if (write5m !== undefined) view.cache_write_5m = write5m;
  const write1h = sumFigure(requests, (r) =>
    nestedNumField(r, 'cache_creation', 'ephemeral_1h_input_tokens'),
  );
  if (write1h !== undefined) view.cache_write_1h = write1h;
  // issue #600 caching PR P: where the requests went, and what they cost.
  if (requests.length > 0) {
    view.endpoints = composeEndpoints(requests);
    const source = deps?.priceSource;
    if (source !== undefined) view.money = moneyOf(requests.map((r) => priceRequest(r, source)));
  }
  return view;
}

/** A stored `responded_by` as an answer view shows it. Total. */
function readAnswerer(raw: unknown): AnswerView['answered_by'] {
  if (raw === undefined || raw === null) return { by: null, absent_cause: 'not_stated' };
  if (typeof raw !== 'string') return { by: null, absent_cause: 'name_unreadable' };
  // A value the tool accepted before the name bound existed can be empty: it reads as no name.
  if (raw.trim().length === 0) return { by: null, absent_cause: 'not_stated' };
  const name = readStoredName(raw);
  if (name === undefined) return { by: null, absent_cause: 'name_unreadable' };
  return { by: name, by_source: 'stated' };
}

/**
 * True when an evidence entry is an ANSWER to a step's question: a `gate_response` entry, except the
 * one an `on_expiry: abort` expiry writes (`resolution: 'expired_abort'`). That entry answers nothing
 * and settles nothing — the run ends and the step is skipped (`skip_details[step].kind:
 * 'gate_expired'` says so) — so it is never shown as an answer. One rule for every reader.
 */
export function isAnswerEntry(entry: unknown): boolean {
  if (typeof entry !== 'object' || entry === null) return false;
  const e = entry as Record<string, unknown>;
  return e['kind'] === 'gate_response' && e['resolution'] !== 'expired_abort';
}

/** One `gate_response` entry as an answer. Total. */
function composeAnswerView(entry: Record<string, unknown>): AnswerView {
  const input = entry['input_summary'];
  const output = entry['output_summary'];
  const inputChoice =
    typeof input === 'object' && input !== null
      ? (input as Record<string, unknown>)['choice']
      : undefined;
  const outputChoice =
    typeof output === 'object' && output !== null
      ? (output as Record<string, unknown>)['choice']
      : undefined;
  const choice =
    typeof inputChoice === 'string'
      ? inputChoice
      : typeof outputChoice === 'string'
        ? outputChoice
        : undefined;
  // An entry the gate's expiry wrote carries `resolution` (and the settlement's literal
  // `responded_by: 'timeout'`, never migrated): no answer was recorded in time — the expiry wrote the default
  // choice. Keyed on `resolution`, never on the literal — a caller may state `timeout` as its own
  // name. (The abort expiry's entry never reaches here: `isAnswerEntry` leaves it out.)
  const settledByExpiry = entry['resolution'] !== undefined;
  const answer: AnswerView = {
    answered_by: settledByExpiry
      ? { by: null, absent_cause: 'settled_by_expiry' }
      : readAnswerer(entry['responded_by']),
  };
  if (choice !== undefined) answer.choice = choice;
  const proof = readGateClaimVerdict(entry['claim_proof']);
  if (proof !== undefined) {
    answer.claim_proof = proof;
  } else if (entry['claim_proof'] !== undefined) {
    answer.claim_proof_absent = 'proof_unreadable';
  } else if (settledByExpiry) {
    answer.claim_proof_absent = 'settled_by_expiry';
  } else {
    answer.claim_proof_absent = 'proof_not_recorded';
  }
  return answer;
}

/** True when a definition resolves and names `stepId` an `execution: 'agent'` step. */
function definitionSaysAgent(
  stepId: string,
  definition: WorkflowDefinition | undefined,
): boolean | undefined {
  if (definition === undefined) return undefined;
  const stepDef = definition.steps[stepId];
  if (stepDef === undefined) return undefined;
  return stepDef.execution === 'agent';
}

/**
 * One `StepView` per `step_id` that has at least one EXECUTION entry (rule 3) — or at least one
 * ANSWER (issue #625): a `gate_response` entry is never an attempt, but it is a fact the step's view
 * must carry, so it creates the step's view with `attempts: []` when no execution entry exists. An
 * entry that is not an object, or has no string `step_id`, is skipped entirely (rule 1's totality).
 *
 * Cost comes from `cache` alone, never from classification (rule 4) — this holds whatever the
 * definition says, and whether or not one exists at all: an `execution: 'auto'` step whose entry
 * still carries a `cache` object gets its cost rendered exactly like an agent step's would.
 * Classification (rule 5) only picks the ABSENCE cause for an entry with no `cache`.
 */
export function composeStepViews(
  run: RunRecord,
  deps?: { definition?: WorkflowDefinition; priceSource?: PriceSource },
): Record<string, StepView> {
  const evidence: unknown = run.evidence;
  const list: readonly unknown[] = Array.isArray(evidence) ? evidence : [];
  const result: Record<string, StepView> = {};
  for (const raw of list) {
    if (typeof raw !== 'object' || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    const stepId = entry['step_id'];
    if (typeof stepId !== 'string') continue;
    const kind = entry['kind'];
    if (kind === 'gate_response') {
      // Never an attempt. An answer (see `isAnswerEntry`) creates the step's view when there is no
      // execution entry; the abort expiry's entry is not an answer and adds nothing.
      if (!isAnswerEntry(entry)) continue;
      const answerStep = (result[stepId] ??= { attempts: [] });
      (answerStep.answers ??= []).push(composeAnswerView(entry));
      continue;
    }
    const isExecution = kind === undefined || kind === 'execution';
    if (!isExecution) continue; // any other kind — never an attempt.

    const view = (result[stepId] ??= { attempts: [] });
    const statusRaw = entry['status'];
    const status = typeof statusRaw === 'string' ? statusRaw : 'unknown';
    const attempt: AttemptView = {
      attempt: view.attempts.length + 1,
      status,
      driven_by: readDrivenBy(entry),
    };

    const diagnostics = entry['diagnostics'];
    const diag = typeof diagnostics === 'object' && diagnostics !== null ? diagnostics : undefined;
    const cache = (diag as Record<string, unknown> | undefined)?.['cache'];
    if (typeof cache === 'object' && cache !== null) {
      const cacheObj = cache as Record<string, unknown>;
      const requestsField = cacheObj['requests'];
      if (Array.isArray(requestsField)) {
        const cv = composeCostView(
          requestsField,
          { basis: cacheObj['basis'], state: cacheObj['state'] },
          deps?.priceSource !== undefined ? { priceSource: deps.priceSource } : undefined,
        );
        if (cv !== undefined) attempt.cost = cv;
      } else {
        attempt.cost_unreadable = true;
      }
    } else {
      // Rule 5 — classification, only ever for an entry with no `cache` at all.
      if (entry['tool_calls'] !== undefined) {
        attempt.cost_unrecorded = 'tool_calling_step';
      } else {
        const byDefinition = definitionSaysAgent(stepId, deps?.definition);
        const isAgentStep = byDefinition ?? entry['agent_profile'] !== undefined;
        if (isAgentStep) attempt.cost_unrecorded = 'not_measured_by_realm';
        // Otherwise: a handler step. Nothing was ever going to be recorded — no annotation at all.
      }
    }
    view.attempts.push(attempt);
  }
  // issue #600 caching PR P: the money across each step's attempts, when a price source was given.
  if (deps?.priceSource !== undefined) {
    for (const view of Object.values(result)) {
      const priced = view.attempts.filter((a) => a.cost?.money !== undefined);
      if (priced.length === 0) continue;
      const total = emptyMoney();
      for (const attempt of priced) addMoney(total, attempt.cost!.money!);
      view.total = total;
    }
  }
  return result;
}

/** One drive-failure entry's cost. Named once here; `get_run_state` reuses it, never re-declares it. */
export interface DriveFailureCost {
  at?: string;
  step?: string;
  error_class?: string;
  cost?: CostView;
}

/**
 * Lines up 1:1 with `run.drive_failures.entries` (rule 6): one element per entry, in order, even a
 * malformed one — its string fields are simply absent rather than a hand-typed field holding
 * `undefined`. `cost` is present iff the entry's `usage` is an array; a `composeCostView` built from
 * a bare `usage` carries no `basis`/`state` (a drive failure's usage carries no classification).
 */
export function composeDriveFailureCosts(
  run: RunRecord,
  deps?: { priceSource?: PriceSource },
): DriveFailureCost[] {
  const driveFailures: unknown = run.drive_failures;
  if (typeof driveFailures !== 'object' || driveFailures === null) return [];
  const entriesField = (driveFailures as Record<string, unknown>)['entries'];
  if (!Array.isArray(entriesField)) return [];
  const result: DriveFailureCost[] = [];
  for (const raw of entriesField) {
    const out: DriveFailureCost = {};
    if (typeof raw === 'object' && raw !== null) {
      const rec = raw as Record<string, unknown>;
      if (typeof rec['at'] === 'string') out.at = rec['at'];
      if (typeof rec['step'] === 'string') out.step = rec['step'];
      if (typeof rec['error_class'] === 'string') out.error_class = rec['error_class'];
      const usage = rec['usage'];
      if (Array.isArray(usage)) {
        const cv = composeCostView(
          usage,
          undefined,
          deps?.priceSource !== undefined ? { priceSource: deps.priceSource } : undefined,
        );
        if (cv !== undefined) out.cost = cv;
      }
    }
    result.push(out);
  }
  return result;
}

/**
 * Issue #600 caching PR P — what a run cost, priced at read: every step's `total` and every failed
 * drive's billed requests on the record, how many failed drives are no longer on the record
 * (`drive_failures.total` − the entries kept), how many on the record carry no usage figures, and
 * the attempts realm has no usage for, by cause.
 * `undefined` with no price source. Total: a malformed record degrades, never throws.
 */
export function composeRunCost(
  run: RunRecord,
  deps?: { definition?: WorkflowDefinition; priceSource?: PriceSource },
): RunCost | undefined {
  const source = deps?.priceSource;
  if (source === undefined) return undefined;
  const total = emptyMoney();
  const unmeasured = { tool_calling_step: 0, not_measured_by_realm: 0, cost_unreadable: 0 };
  const steps = composeStepViews(run, {
    ...(deps?.definition !== undefined ? { definition: deps.definition } : {}),
    priceSource: source,
  });
  for (const view of Object.values(steps)) {
    if (view.total !== undefined) addMoney(total, view.total);
    for (const attempt of view.attempts) {
      if (attempt.cost_unreadable === true) unmeasured.cost_unreadable += 1;
      else if (attempt.cost_unrecorded !== undefined) unmeasured[attempt.cost_unrecorded] += 1;
    }
  }
  for (const failure of composeDriveFailureCosts(run, { priceSource: source })) {
    if (failure.cost?.money !== undefined) addMoney(total, failure.cost.money);
  }
  const driveFailures: unknown = run.drive_failures;
  let notOnRecord = 0;
  let withoutUsage = 0;
  if (typeof driveFailures === 'object' && driveFailures !== null) {
    const recorded = (driveFailures as Record<string, unknown>)['total'];
    const entries = (driveFailures as Record<string, unknown>)['entries'];
    if (typeof recorded === 'number' && Number.isFinite(recorded)) {
      notOnRecord = Math.max(0, recorded - (Array.isArray(entries) ? entries.length : 0));
    }
    if (Array.isArray(entries)) {
      for (const entry of entries as unknown[]) {
        const usage =
          typeof entry === 'object' && entry !== null
            ? (entry as Record<string, unknown>)['usage']
            : undefined;
        if (!Array.isArray(usage) || usage.length === 0) withoutUsage += 1;
      }
    }
  }
  return {
    total,
    failed_drives_not_on_record: notOnRecord,
    failed_drives_without_usage: withoutUsage,
    unmeasured,
  };
}
