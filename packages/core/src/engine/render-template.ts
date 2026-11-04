// Renders {{ }} template expressions against live run state.
// Syntax: {{ path | filter1: arg | filter2 }} or {{ path }}
// Also handles {{ workflow.context.NAME }} and {{ workflow.context.NAME.raw }}.
// Unknown references are left as-is. Object/array values are JSON-stringified.
import type { WorkflowContextSnapshot } from '../types/run-record.js';
import type { ContextWrapperFormat } from '../types/workflow-definition.js';
import { splitOnUnquotedDelimiter } from './comparison-expr.js';

/**
 * Resolves a dot-path like "context.resources.review_security.findings"
 * against the given root object. Returns undefined if any segment is missing.
 */
export function resolvePath(path: string, root: Record<string, unknown>): unknown {
  const parts = path.trim().split('.');
  let current: unknown = root;
  for (const part of parts) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

// ─── Filter system ────────────────────────────────────────────────────────────

type FilterResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: 'unknown_filter'; filterName: string }
  | { ok: false; reason: 'type_mismatch' };

/** Thrown by renderTemplate when strict mode is on and an unknown filter is encountered. */
export class UnknownFilterError extends Error {
  constructor(public readonly filterName: string) {
    super(`Unknown filter: '${filterName}'`);
    this.name = 'UnknownFilterError';
  }
}

// Static lookup table for date formatting presets used by the `date` filter.
const DATE_PRESETS: Record<string, (d: Date) => string> = {
  short: (d) =>
    new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(d),
  long: (d) =>
    new Intl.DateTimeFormat('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(d),
  iso: (d) => d.toISOString().slice(0, 10),
  time: (d) =>
    new Intl.DateTimeFormat('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZone: 'UTC',
    }).format(d),
  datetime: (d) =>
    new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZone: 'UTC',
    }).format(d),
};

/**
 * Applies a single named filter to a value and returns a FilterResult.
 * Exported for direct testing of individual filter behaviour.
 */
/**
 * #715 (b) (02 §D.4, D6-22): the instant a template is rendered at, from its caller — the filter
 * reads no clock. `{ at }`: a text rendered for one reply (a step's prompt), judged at that reply's
 * snapshot. `'stored'`: a text stored in a record (a question's message), where time is written as
 * an absolute instant (a relative phrase would be false by the time anyone reads it).
 */
export type RenderTime = { at: Date } | 'stored';

export function applyFilter(
  value: unknown,
  filterName: string,
  args: string[],
  // #715 (b) (02 §D.4): the render instant; with none, `from_now` leaves its placeholder (no clock).
  time?: RenderTime,
): FilterResult {
  switch (filterName) {
    case 'bullets': {
      if (!Array.isArray(value)) return { ok: false, reason: 'type_mismatch' };
      if (value.length === 0) return { ok: true, value: undefined };
      return { ok: true, value: value.map((item) => `• ${String(item)}`).join('\n') };
    }

    case 'join': {
      if (!Array.isArray(value)) return { ok: false, reason: 'type_mismatch' };
      const sep = args[0] ?? ', ';
      return { ok: true, value: value.map((item) => String(item)).join(sep) };
    }

    case 'default': {
      const fallback = args[0] ?? '';
      if (value === null || value === undefined) return { ok: true, value: fallback };
      return { ok: true, value };
    }

    case 'upper': {
      if (typeof value !== 'string') return { ok: false, reason: 'type_mismatch' };
      return { ok: true, value: value.toUpperCase() };
    }

    case 'lower': {
      if (typeof value !== 'string') return { ok: false, reason: 'type_mismatch' };
      return { ok: true, value: value.toLowerCase() };
    }

    case 'capitalize': {
      if (typeof value !== 'string') return { ok: false, reason: 'type_mismatch' };
      if (value.length === 0) return { ok: true, value: '' };
      return { ok: true, value: value.charAt(0).toUpperCase() + value.slice(1) };
    }

    case 'truncate': {
      if (typeof value !== 'string') return { ok: false, reason: 'type_mismatch' };
      const rawArg = args[0];
      if (rawArg === undefined) return { ok: false, reason: 'type_mismatch' };
      const limit = parseInt(rawArg, 10);
      if (isNaN(limit)) return { ok: false, reason: 'type_mismatch' };
      if (value.length <= limit) return { ok: true, value };
      // Find last word boundary at or before limit.
      const sub = value.slice(0, limit);
      const boundary = sub.lastIndexOf(' ');
      const cut = boundary > 0 ? sub.slice(0, boundary) : sub;
      return { ok: true, value: `${cut}…` };
    }

    // ─── Tier 2 filters ───────────────────────────────────────────────────

    case 'pluck': {
      if (!Array.isArray(value)) return { ok: false, reason: 'type_mismatch' };
      const key = args[0];
      if (!key) return { ok: false, reason: 'type_mismatch' };
      const result: unknown[] = [];
      for (const item of value) {
        if (typeof item !== 'object' || item === null) continue;
        const record = item as Record<string, unknown>;
        if (Object.prototype.hasOwnProperty.call(record, key)) {
          result.push(record[key]);
        }
      }
      return { ok: true, value: result };
    }

    case 'count': {
      if (!Array.isArray(value)) return { ok: false, reason: 'type_mismatch' };
      return { ok: true, value: String(value.length) };
    }

    case 'limit': {
      if (!Array.isArray(value)) return { ok: false, reason: 'type_mismatch' };
      const rawLimit = args[0];
      if (rawLimit === undefined) return { ok: false, reason: 'type_mismatch' };
      const n = parseInt(rawLimit, 10);
      if (isNaN(n)) return { ok: false, reason: 'type_mismatch' };
      return { ok: true, value: value.slice(0, n) };
    }

    case 'compact': {
      if (!Array.isArray(value)) return { ok: false, reason: 'type_mismatch' };
      return { ok: true, value: value.filter((item) => item !== null && item !== undefined) };
    }

    case 'round': {
      if (typeof value !== 'number') return { ok: false, reason: 'type_mismatch' };
      const rawDecimals = args[0];
      let decimals = 0;
      if (rawDecimals !== undefined && rawDecimals !== '') {
        const parsed = parseInt(rawDecimals, 10);
        if (isNaN(parsed)) return { ok: false, reason: 'type_mismatch' };
        decimals = parsed;
      }
      return { ok: true, value: value.toFixed(decimals) };
    }

    case 'floor': {
      if (typeof value !== 'number') return { ok: false, reason: 'type_mismatch' };
      return { ok: true, value: String(Math.floor(value)) };
    }

    case 'ceil': {
      if (typeof value !== 'number') return { ok: false, reason: 'type_mismatch' };
      return { ok: true, value: String(Math.ceil(value)) };
    }

    case 'abs': {
      if (typeof value !== 'number') return { ok: false, reason: 'type_mismatch' };
      return { ok: true, value: String(Math.abs(value)) };
    }

    case 'number_format': {
      if (typeof value !== 'number') return { ok: false, reason: 'type_mismatch' };
      const rawDecimals = args[0];
      let decimals = 0;
      if (rawDecimals !== undefined && rawDecimals !== '') {
        const parsed = parseInt(rawDecimals, 10);
        if (isNaN(parsed)) return { ok: false, reason: 'type_mismatch' };
        decimals = parsed;
      }
      const opts: Intl.NumberFormatOptions =
        decimals === 0
          ? { maximumFractionDigits: 0 }
          : { minimumFractionDigits: decimals, maximumFractionDigits: decimals };
      return { ok: true, value: new Intl.NumberFormat('en-US', opts).format(value) };
    }

    case 'percent': {
      if (typeof value !== 'number') return { ok: false, reason: 'type_mismatch' };
      const rawDecimals = args[0];
      let decimals = 0;
      if (rawDecimals !== undefined && rawDecimals !== '') {
        const parsed = parseInt(rawDecimals, 10);
        if (isNaN(parsed)) return { ok: false, reason: 'type_mismatch' };
        decimals = parsed;
      }
      return { ok: true, value: `${(value * 100).toFixed(decimals)}%` };
    }

    case 'replace': {
      if (typeof value !== 'string') return { ok: false, reason: 'type_mismatch' };
      const search = args[0];
      const replacement = args[1];
      if (search === undefined || replacement === undefined)
        return { ok: false, reason: 'type_mismatch' };
      if (search === '') return { ok: false, reason: 'type_mismatch' };
      return { ok: true, value: value.replaceAll(search, replacement) };
    }

    case 'yesno': {
      if (typeof value !== 'boolean') return { ok: false, reason: 'type_mismatch' };
      if (args.length >= 2) {
        return { ok: true, value: value ? args[0] : args[1] };
      }
      // zero or one arg: fall back to defaults (preserves Phase 43b promise)
      return { ok: true, value: value ? 'yes' : 'no' };
    }

    case 'and_join': {
      if (!Array.isArray(value)) return { ok: false, reason: 'type_mismatch' };
      if (value.length === 0) return { ok: true, value: undefined };
      const strs = value.map((item) => String(item));
      if (strs.length === 1) return { ok: true, value: strs[0] };
      if (strs.length === 2) return { ok: true, value: `${strs[0]} and ${strs[1]}` };
      const last = strs[strs.length - 1];
      const rest = strs.slice(0, -1);
      return { ok: true, value: `${rest.join(', ')}, and ${last}` };
    }

    case 'trim': {
      if (typeof value !== 'string') return { ok: false, reason: 'type_mismatch' };
      return { ok: true, value: value.trim() };
    }

    case 'first': {
      if (!Array.isArray(value)) return { ok: false, reason: 'type_mismatch' };
      if (value.length === 0) return { ok: true, value: undefined };
      return { ok: true, value: value[0] };
    }

    case 'last': {
      if (!Array.isArray(value)) return { ok: false, reason: 'type_mismatch' };
      if (value.length === 0) return { ok: true, value: undefined };
      return { ok: true, value: value[value.length - 1] };
    }

    case 'sum': {
      if (!Array.isArray(value)) return { ok: false, reason: 'type_mismatch' };
      if (value.length === 0) return { ok: true, value: '0' };
      let total = 0;
      for (const item of value) {
        if (typeof item !== 'number') return { ok: false, reason: 'type_mismatch' };
        total += item;
      }
      return { ok: true, value: String(total) };
    }

    case 'flatten': {
      if (!Array.isArray(value)) return { ok: false, reason: 'type_mismatch' };
      return { ok: true, value: value.flat(1) };
    }

    case 'split': {
      if (typeof value !== 'string') return { ok: false, reason: 'type_mismatch' };
      const delimiter = args[0];
      if (delimiter === undefined || delimiter === '')
        return { ok: false, reason: 'type_mismatch' };
      return { ok: true, value: value.split(delimiter) };
    }

    case 'sort': {
      if (!Array.isArray(value)) return { ok: false, reason: 'type_mismatch' };
      const sorted = [...value].sort((a, b) => String(a).localeCompare(String(b)));
      return { ok: true, value: sorted };
    }

    case 'unique': {
      if (!Array.isArray(value)) return { ok: false, reason: 'type_mismatch' };
      const seen = new Set<string>();
      const result: unknown[] = [];
      for (const item of value) {
        const key = JSON.stringify(item);
        if (!seen.has(key)) {
          seen.add(key);
          result.push(item);
        }
      }
      return { ok: true, value: result };
    }

    case 'title': {
      if (typeof value !== 'string') return { ok: false, reason: 'type_mismatch' };
      return {
        ok: true,
        value: value.replace(/\S+/g, (word) => word.charAt(0).toUpperCase() + word.slice(1)),
      };
    }

    case 'code': {
      if (typeof value !== 'string') return { ok: false, reason: 'type_mismatch' };
      return { ok: true, value: `\`${value}\`` };
    }

    case 'indent': {
      if (typeof value !== 'string') return { ok: false, reason: 'type_mismatch' };
      const raw = args[0];
      if (raw === undefined) return { ok: false, reason: 'type_mismatch' };
      const n = parseInt(raw, 10);
      if (isNaN(n)) return { ok: false, reason: 'type_mismatch' };
      if (n === 0) return { ok: true, value };
      const prefix = ' '.repeat(n);
      return {
        ok: true,
        value: value
          .split('\n')
          .map((line) => (line.length > 0 ? prefix + line : line))
          .join('\n'),
      };
    }

    case 'date': {
      if (typeof value !== 'string') return { ok: false, reason: 'type_mismatch' };
      const d = new Date(value);
      if (isNaN(d.getTime())) return { ok: false, reason: 'type_mismatch' };
      const preset = args[0] ?? 'short';
      const formatter = DATE_PRESETS[preset];
      if (!formatter) return { ok: false, reason: 'type_mismatch' };
      return { ok: true, value: formatter(d) };
    }

    case 'from_now': {
      if (typeof value !== 'string') return { ok: false, reason: 'type_mismatch' };
      const d = new Date(value);
      if (isNaN(d.getTime())) return { ok: false, reason: 'type_mismatch' };
      // #715 (b) (02 §D.4, D6-22): no clock read — the caller's instant, or the absolute instant
      // in a stored text; with neither, the placeholder stays.
      if (time === undefined) return { ok: false, reason: 'type_mismatch' };
      if (time === 'stored') return { ok: true, value: d.toISOString() };
      const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
      const diffMs = d.getTime() - time.at.getTime();
      const diffSec = Math.round(diffMs / 1000);
      const absSec = Math.abs(diffSec);
      if (absSec < 60) return { ok: true, value: rtf.format(diffSec, 'second') };
      const diffMin = Math.round(diffMs / 60000);
      const absMin = Math.abs(diffMin);
      if (absMin < 60) return { ok: true, value: rtf.format(diffMin, 'minute') };
      const diffHr = Math.round(diffMs / 3600000);
      const absHr = Math.abs(diffHr);
      if (absHr < 24) return { ok: true, value: rtf.format(diffHr, 'hour') };
      const diffDay = Math.round(diffMs / 86400000);
      return { ok: true, value: rtf.format(diffDay, 'day') };
    }

    case 'duration': {
      if (typeof value !== 'number') return { ok: false, reason: 'type_mismatch' };
      if (value < 0) return { ok: false, reason: 'type_mismatch' };
      const totalSec = Math.floor(value / 1000);
      if (totalSec < 60) return { ok: true, value: `${totalSec}s` };
      const mins = Math.floor(totalSec / 60);
      const secs = totalSec % 60;
      return { ok: true, value: `${mins}m ${secs}s` };
    }

    default:
      return { ok: false, reason: 'unknown_filter', filterName };
  }
}

// Strip outer matching quotes from a single token.
function stripOuterQuotes(token: string): string {
  if (
    (token.startsWith('"') && token.endsWith('"')) ||
    (token.startsWith("'") && token.endsWith("'"))
  ) {
    return token.slice(1, -1);
  }
  return token;
}

// splitOnUnquotedDelimiter now lives in comparison-expr.ts (shared with condition splitting) and is
// imported above — keeping one quote-aware primitive across template rendering and condition parsing.

function splitOnUnquotedPipes(expr: string): string[] {
  return splitOnUnquotedDelimiter(expr, '|');
}

// Parses a comma-separated filter argument list with quote awareness.
// Calls splitOnUnquotedDelimiter, then strips outer quotes and trims each token.
// An empty or whitespace-only raw string returns [].
function parseFilterArgs(raw: string): string[] {
  if (!raw.trim()) return [];
  return splitOnUnquotedDelimiter(raw, ',').map((token) => stripOuterQuotes(token.trim()));
}

// Parse the filter chain from the pipe-separated expression tail.
// Returns an array of { name, args } entries.
function parseFilters(expr: string): Array<{ name: string; args: string[] }> {
  const segments = splitOnUnquotedPipes(expr).slice(1); // first segment is the path
  return segments.map((seg) => {
    const colonIdx = seg.indexOf(':');
    if (colonIdx === -1) {
      return { name: seg.trim(), args: [] };
    }
    const name = seg.slice(0, colonIdx).trim();
    const args = parseFilterArgs(seg.slice(colonIdx + 1));
    return { name, args };
  });
}

// ─── renderTemplate ────────────────────────────────────────────────────────────

/**
 * Matches {{ path }} and {{ path | filter | filter: arg }} — renderTemplate's own placeholder.
 * [^{}]+ excludes both { and } from the expression body:
 *   - Excluding } prevents the match from spanning past the closing }}.
 *   - Excluding { prevents O(N²) backtracking on adversarial inputs like many repetitions of
 *     "{{{{|" — where [^}]+ would try matching { chars repeatedly at each start position. Valid
 *     template expressions never contain { or }. Whitespace is trimmed in code below via .trim().
 * #729 PR-4: exported so the gate mint counts a message's placeholders, filtered ones included, by
 * the same rule this function substitutes them by.
 */
export const TEMPLATE_PLACEHOLDER = /\{\{([^{}]+)\}\}/g;

/** #729 PR-4: renderTemplate's options. */
export interface RenderTemplateOptions {
  strict?: boolean;
  /**
   * #729 PR-4 (01 (b)): called with each RESOLVED value, as rendered, and its path; its return is
   * substituted instead. Never called for a placeholder left unresolved (an unknown path, a type
   * mismatch, an unknown filter in lenient mode), which stays in the text as before — so a caller's
   * scan for unresolved placeholders reads the same text it read before the hook.
   */
  onSubstitution?: (rendered: string, path: string) => string;
  /**
   * Caching 3-B (C1): a pure OBSERVER, called for EVERY placeholder — resolved or not — after its
   * replacement text is final (after {@link onSubstitution} has returned). Its return is ignored: it
   * cannot change the output. `start`/`end` are the replacement's offsets in the OUTPUT, accumulated
   * from the actual replacement lengths (an unresolved placeholder's re-emitted text counts).
   */
  onPlaceholder?: (event: PlaceholderEvent) => void;
  /**
   * #715 (b) (02 §D.4, D6-22): the instant the template is rendered at — `{ at }` for a text rendered
   * for one reply, `'stored'` for a text stored in a record (time written as an absolute instant).
   * With none, a `from_now` placeholder is left as written: the filter never reads a clock.
   */
  time?: RenderTime;
}

/**
 * Caching 3-B (C1): one placeholder as rendered. `resolved` is true exactly when a value came out of
 * it — the same funnel that calls {@link RenderTemplateOptions.onSubstitution}, never a comparison
 * of the output with `{{ … }}` (a value can be that text). `filters` is its chain's filter names, in
 * order; `path` is the text before the first `|`, trimmed.
 */
export interface PlaceholderEvent {
  path: string;
  filters: readonly string[];
  resolved: boolean;
  start: number;
  end: number;
}

/**
 * Renders all {{ ... }} expressions in a template string against the provided context.
 * Supports pipe-filter syntax: {{ path | filter1: arg | filter2 }}
 *
 * - Strings: inserted as-is (after filter chain)
 * - Objects/arrays: JSON.stringify with 2-space indent (no filters)
 * - undefined/unresolvable or type_mismatch: left as {{ expression }}
 * - unknown_filter in strict mode: throws UnknownFilterError
 * - unknown_filter in lenient mode: leaves placeholder intact
 *
 * Handles the workflow.context.* namespace when workflowContext is provided.
 */
export function renderTemplate(
  template: string,
  context: {
    evidenceByStep: Record<string, Record<string, unknown>>;
    runParams: Record<string, unknown>;
    workflowContext?: {
      snapshots: Record<string, WorkflowContextSnapshot>;
      wrapper: ContextWrapperFormat;
    };
  },
  options?: RenderTemplateOptions,
): string {
  // One placeholder's replacement, and whether a value came out of it: a resolved value passes
  // through the hook when one is given (and only a resolved one does — `resolved()` is the funnel the
  // observer's `resolved` reads).
  let came: boolean;
  const resolved = (rendered: string, path: string): string => {
    came = true;
    return options?.onSubstitution !== undefined
      ? options.onSubstitution(rendered, path)
      : rendered;
  };
  const replacementOf = (expr: string): string => {
    const pipeIdx = expr.indexOf('|');
    const hasFilters = pipeIdx !== -1;

    // Extract just the path (the part before the first pipe, or the whole expr).
    const rawPath = (hasFilters ? expr.slice(0, pipeIdx) : expr).trim();
    const fullExpr = expr.trim();

    // Workflow context namespace — handled before the generic path resolver.
    if (rawPath.startsWith('workflow.context.') && context.workflowContext) {
      if (!hasFilters) {
        const value = resolveWorkflowContextRef(rawPath, context.workflowContext);
        return value === undefined ? `{{ ${fullExpr} }}` : resolved(value, rawPath);
      }
    }

    // Generic path resolution — context.resources.* and run.params.*
    const root: Record<string, unknown> = {
      context: { resources: context.evidenceByStep },
      run: { params: context.runParams },
    };
    const rawValue =
      rawPath.startsWith('workflow.context.') && context.workflowContext
        ? resolveWorkflowContextRef(rawPath, context.workflowContext)
        : resolvePath(rawPath, root);

    if (!hasFilters) {
      // Original coercion behaviour.
      if (rawValue === undefined) return `{{ ${fullExpr} }}`;
      if (typeof rawValue === 'string') return resolved(rawValue, rawPath);
      return resolved(JSON.stringify(rawValue, null, 2), rawPath);
    }

    // Filter chain processing.
    const filters = parseFilters(expr);
    let current: unknown = rawValue;

    for (const { name, args } of filters) {
      const result = applyFilter(current, name, args, options?.time);
      if (!result.ok) {
        if (result.reason === 'unknown_filter') {
          if (options?.strict === true) {
            throw new UnknownFilterError(result.filterName);
          }
          // Lenient: leave placeholder intact.
          return `{{ ${fullExpr} }}`;
        }
        // type_mismatch: always leave placeholder intact.
        return `{{ ${fullExpr} }}`;
      }
      current = result.value;
    }

    // After filter chain — coerce to string.
    if (current === undefined || current === null) return `{{ ${fullExpr} }}`;
    if (typeof current === 'string') return resolved(current, rawPath);
    return resolved(JSON.stringify(current, null, 2), rawPath);
  };
  // The text between placeholders is copied as is, and each placeholder's replacement is inserted
  // literally (as `String.prototype.replace` inserts a replacer function's return): the output is
  // byte-identical to the former `template.replace(TEMPLATE_PLACEHOLDER, …)`, with or without an
  // observer.
  let out = '';
  let last = 0;
  for (const m of template.matchAll(TEMPLATE_PLACEHOLDER)) {
    const expr = m[1]!;
    out += template.slice(last, m.index);
    came = false;
    const text = replacementOf(expr);
    const start = out.length;
    out += text;
    last = m.index + m[0].length;
    if (options?.onPlaceholder !== undefined) {
      const pipeIdx = expr.indexOf('|');
      options.onPlaceholder({
        path: (pipeIdx === -1 ? expr : expr.slice(0, pipeIdx)).trim(),
        filters: pipeIdx === -1 ? [] : parseFilters(expr).map((f) => f.name),
        resolved: came,
        start,
        end: out.length,
      });
    }
  }
  return out + template.slice(last);
}

/**
 * Caching 3-B (C1, D4.4-3): whether a filter's output depends only on its input. `from_now` reads
 * the clock: UNSTABLE. `date` and `sort` are STABLE per runner only — `date` parses a zone-less
 * string in the runner's zone, `sort` compares by the runner's locale — the named exceptions to the
 * differential cell, their per-runner cost recorded. Keyed by EVERY case label of
 * {@link applyFilter}'s switch (a witness cell parses the switch and compares the key sets);
 * `wrapContent`'s three are not filters. A name not in the table is UNSTABLE.
 */
export const FILTER_STABILITY = {
  bullets: 'stable',
  join: 'stable',
  default: 'stable',
  upper: 'stable',
  lower: 'stable',
  capitalize: 'stable',
  truncate: 'stable',
  pluck: 'stable',
  count: 'stable',
  limit: 'stable',
  compact: 'stable',
  round: 'stable',
  floor: 'stable',
  ceil: 'stable',
  abs: 'stable',
  number_format: 'stable',
  percent: 'stable',
  replace: 'stable',
  yesno: 'stable',
  and_join: 'stable',
  trim: 'stable',
  first: 'stable',
  last: 'stable',
  sum: 'stable',
  flatten: 'stable',
  split: 'stable',
  sort: 'stable',
  unique: 'stable',
  title: 'stable',
  code: 'stable',
  indent: 'stable',
  date: 'stable',
  from_now: 'unstable',
  duration: 'stable',
} as const satisfies Record<string, 'stable' | 'unstable'>;

/**
 * Caching 3-B (C1, D4.4-3): a placeholder is STABLE — its replacement is the same on every run of the
 * workflow — iff a value came out of it, its path is `workflow.context.*` (the workflow's own files,
 * loaded at the run's start), and every filter in its chain is STABLE in {@link FILTER_STABILITY}. An
 * unresolved placeholder is unstable (its text may resolve on a later run), as is any other path (a
 * run's parameters, a step's evidence). `default` rescuing an absent context path is stable.
 */
export function isStablePlaceholder(event: PlaceholderEvent): boolean {
  return (
    event.resolved &&
    event.path.startsWith('workflow.context.') &&
    event.filters.every(
      (name) =>
        Object.hasOwn(FILTER_STABILITY, name) &&
        FILTER_STABILITY[name as keyof typeof FILTER_STABILITY] === 'stable',
    )
  );
}

/** Caching 3-B (C1): where a rendered text stops repeating between runs, in UTF-16 code units. */
export interface StableBoundary {
  chars: number;
  unit: 'utf16';
}

/**
 * Caching 3-B (C1): {@link renderTemplate} with an observer that finds the FIRST UNSTABLE placeholder.
 * `stable.chars` is that placeholder's `start` in the output, or the text's length when none is
 * unstable: everything before it repeats on every run, so a provider can cache it. The text is
 * byte-identical to `renderTemplate`'s (the observer cannot change it). No digest of the raw head is
 * computed: both consumers digest the DISCLOSED head (M4). The gate mint never calls this.
 */
export function renderTemplateWithBoundary(
  template: string,
  context: Parameters<typeof renderTemplate>[1],
  options?: RenderTemplateOptions,
): { text: string; stable: StableBoundary } {
  let firstUnstable: number | undefined;
  const text = renderTemplate(template, context, {
    ...options,
    onPlaceholder: (event) => {
      options?.onPlaceholder?.(event);
      if (firstUnstable === undefined && !isStablePlaceholder(event)) firstUnstable = event.start;
    },
  });
  return { text, stable: { chars: firstUnstable ?? text.length, unit: 'utf16' } };
}

function resolveWorkflowContextRef(
  path: string,
  ctx: { snapshots: Record<string, WorkflowContextSnapshot>; wrapper: ContextWrapperFormat },
): string | undefined {
  // path format: "workflow.context.NAME" or "workflow.context.NAME.raw"
  const segments = path.split('.');
  if (segments.length < 3) return undefined;

  const isRaw = segments[segments.length - 1] === 'raw';
  // Name is everything between "workflow.context." and the optional ".raw"
  const name = isRaw ? segments.slice(2, -1).join('.') : segments.slice(2).join('.');

  const snapshot = ctx.snapshots[name];
  if (!snapshot || snapshot.error !== undefined) return undefined;

  return isRaw ? snapshot.content : wrapContent(name, snapshot.content, ctx.wrapper);
}

function wrapContent(name: string, content: string, wrapper: ContextWrapperFormat): string {
  switch (wrapper) {
    case 'xml':
      return `<${name}>\n${content}\n</${name}>`;
    case 'brackets':
      return `[${name}]\n${content}\n[/${name}]`;
    case 'none':
      return content;
  }
}
