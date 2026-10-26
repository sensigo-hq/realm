// The zod 4 unit, R1: a tool call's refusal at a size an agent can read. A per-value-typed record
// yields one zod issue per wrong value and the SDK prints every issue (10,000 wrong values → 369 KB,
// which a client cuts to its head and tail, the count lost). Realm bounds the text at its own layer,
// the advertised schema unchanged: one issue prints as zod words it; two or more are replaced by one
// summary — the count first, then up to ten places, every line cut at 200 characters. Paths, keys,
// counts and expected types only: a value is never echoed. The reply bounds (07): the lists of
// unknown keys and of steps the runner cannot serve that a reply carries in `warnings` are bounded the
// same way — `boundedLines`, the first ten named, then the count (as the number lists are).
import { z } from 'zod';

/** The most place lines a summary prints before `and N more places`. */
export const MAX_PLACE_LINES = 10;
/** The longest summary line before its `…` (a path or a key is the agent's own word, and may be long). */
export const MAX_SUMMARY_LINE = 200;

/**
 * A list a reply carries, bounded: the first {@link MAX_PLACE_LINES} items' lines, then — when there
 * are more — one count line, `more(rest, total)`. The reply's size no longer follows the count.
 */
export function boundedLines<T>(
  items: readonly T[],
  line: (item: T) => string,
  more: (rest: number, total: number) => string,
): string[] {
  const out = items.slice(0, MAX_PLACE_LINES).map((item) => line(item));
  if (items.length > MAX_PLACE_LINES) out.push(more(items.length - MAX_PLACE_LINES, items.length));
  return out;
}

/** The count line of an unknown-key list (`create_workflow`, `advance_run`, `submit_human_response`). */
export const moreUnknownKeys = (rest: number, total: number): string =>
  `and ${rest} more unknown ${rest === 1 ? 'key was' : 'keys were'} ignored (${total} in all)`;

/** The count line of a capability pre-flight list (`start_run`, `start_run_batch`). */
export const moreUnmetSteps = (rest: number, total: number): string =>
  `and ${rest} more ${rest === 1 ? 'step needs' : 'steps need'} a handler or adapter this runner lacks (${total} in all)`;

type RawIssue = z.core.$ZodRawIssue;

/** A path as the SDK renders it: `run_id`, `steps[3].id`, `trace[0].data`. */
function pathText(path: readonly PropertyKey[]): string {
  let out = '';
  for (const segment of path) {
    if (typeof segment === 'number') out += `[${segment}]`;
    else out += out === '' ? String(segment) : `.${String(segment)}`;
  }
  return out;
}

function cut(line: string): string {
  return line.length > MAX_SUMMARY_LINE ? `${line.slice(0, MAX_SUMMARY_LINE)}…` : line;
}

/** What a place expected: realm's `expected <type>` for a wrong type (one line however many types
 *  arrived); zod's finalized words for any other code (a schema's own `error` honoured). */
function expectedOf(issue: RawIssue): string {
  if (issue.code === 'invalid_type') return `expected ${String(issue.expected)}`;
  return z.core.util.finalizeIssue(issue, undefined, z.core.config()).message;
}

/** The summary of `issues` (two or more), one line each, joined by `\n`. */
export function refusalSummary(issues: readonly RawIssue[]): string {
  // A PLACE: the issue's parent path and the schema instance that raised it.
  const instIds = new Map<unknown, number>();
  const places = new Map<string, { parent: readonly PropertyKey[]; members: RawIssue[] }>();
  for (const issue of issues) {
    const path = issue.path ?? [];
    const parent = path.slice(0, -1);
    const inst: unknown = issue.inst ?? issue.code;
    if (!instIds.has(inst)) instIds.set(inst, instIds.size);
    const key = `${JSON.stringify(parent.map(String))}\u0000${instIds.get(inst)!}`;
    const place = places.get(key);
    if (place === undefined) places.set(key, { parent, members: [issue] });
    else place.members.push(issue);
  }
  const total = issues.length;
  const lines = [`${total} problems in ${places.size} ${places.size === 1 ? 'place' : 'places'}`];
  let shown = 0;
  for (const { parent, members } of places.values()) {
    if (shown === MAX_PLACE_LINES) break;
    const first = members[0]!;
    if (members.length === 1) {
      lines.push(`${pathText(first.path ?? []) || 'arguments'}: ${expectedOf(first)}`);
    } else {
      const keys = members.slice(0, 3).map((m) => String((m.path ?? []).at(-1) ?? ''));
      lines.push(
        `${pathText(parent) || 'arguments'}: ${members.length} problems — ${expectedOf(first)} (first: ${keys.join(', ')})`,
      );
    }
    shown++;
  }
  const rest = places.size - shown;
  if (rest > 0) lines.push(`and ${rest} more ${rest === 1 ? 'place' : 'places'} (${total} in all)`);
  return lines.map(cut).join('\n');
}

/**
 * Every tool's input schema, bounded: a check that runs although the call already holds issues
 * (`when`), sees the root's list (`ctx.issues`), and — at two or more — replaces them with one root
 * issue carrying {@link refusalSummary}. One issue is left as zod words it. A parse an issue aborted
 * (a list over its bound, a non-integer `max_items`) runs no check: zod's few lines print as they
 * are. `superRefine` returns the same object (`.shape` intact), so `tools/list` is unchanged.
 */
export function boundedRefusal<T extends z.ZodObject>(schema: T): T {
  return schema.superRefine(
    (_value, ctx) => {
      if (ctx.issues.length <= 1) return;
      const message = refusalSummary(ctx.issues);
      ctx.issues.splice(0, ctx.issues.length);
      ctx.addIssue({ code: 'custom', message, path: [] });
    },
    { when: () => true },
  );
}
