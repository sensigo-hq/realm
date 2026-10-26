// The zod 4 unit, R2 (O2): the numbers JSON cannot carry, found in the free-form records after
// validation and before anything is stored. A non-finite number (Infinity, -Infinity, NaN — from a
// raw-text caller; a JavaScript client sends it as null) would be stored as null, so the call is
// refused; an integer beyond 2^53−1 may already have been rounded on its way in, so it draws a
// warning (a legitimate large float looks the same as a rounded identifier). Paths and keys are
// named, never a value. Correction 1: each list a reply shows is bounded as R1 bounds zod's — the
// first ten named, then the count — and a long path is cut so its line keeps the diagnostic whole.
import { brandClass } from '@sensigo/realm';
import { REALM_MCP_BRAND } from '../brand.js';
import type { McpEnvelope } from '../render-reply.js';
import { boundedLines, MAX_SUMMARY_LINE } from './refusal-format.js';

/** The numbers a walk found, each by its path. */
export interface NumbersFound {
  nonFinite: string[];
  beyondSafe: string[];
}

/**
 * Every non-finite number, and every integer-valued number beyond 2^53−1, in `value`, by path
 * (`params.ids[2]`, `trace[0].data.k`). Iterative, so a deep record cannot overflow the stack; the
 * call's element cap bounds its size.
 */
export function walkNumbers(value: unknown, path: string): NumbersFound {
  const found: NumbersFound = { nonFinite: [], beyondSafe: [] };
  const stack: Array<[unknown, string]> = [[value, path]];
  while (stack.length > 0) {
    const [v, p] = stack.pop()!;
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) found.nonFinite.push(p);
      else if (Number.isInteger(v) && Math.abs(v) > Number.MAX_SAFE_INTEGER)
        found.beyondSafe.push(p);
    } else if (Array.isArray(v)) {
      for (let i = v.length - 1; i >= 0; i--) stack.push([v[i], `${p}[${i}]`]);
    } else if (v !== null && typeof v === 'object') {
      const keys = Object.keys(v);
      for (let i = keys.length - 1; i >= 0; i--)
        stack.push([(v as Record<string, unknown>)[keys[i]!], `${p}.${keys[i]!}`]);
    }
  }
  return found;
}

const NON_FINITE_SUFFIX =
  ' is not a finite number; JSON cannot carry Infinity or NaN, and it would be stored as null — send a finite number';
const BEYOND_SAFE_SUFFIX =
  ' is an integer beyond 2^53−1; JSON numbers past it are rounded, so it may not be what you sent — send identifiers as strings';

/**
 * The longest path a line shows whole (75): a longer one is shown as its first 75 characters and
 * `…`, so every line fits {@link MAX_SUMMARY_LINE} with its diagnostic whole — the path is cut,
 * never the words after it.
 */
export const MAX_SHOWN_PATH =
  MAX_SUMMARY_LINE - Math.max(NON_FINITE_SUFFIX.length, BEYOND_SAFE_SUFFIX.length) - 1;

function shownPath(path: string): string {
  return path.length > MAX_SHOWN_PATH ? `${path.slice(0, MAX_SHOWN_PATH)}…` : path;
}

/** The refusal's line for one non-finite number. */
export function nonFiniteText(path: string): string {
  return `${shownPath(path)}${NON_FINITE_SUFFIX}`;
}

/** The warning's line for one integer beyond 2^53−1. */
export function beyondSafeWarning(path: string): string {
  return `${shownPath(path)}${BEYOND_SAFE_SUFFIX}`;
}

const moreNonFinite = (rest: number, total: number): string =>
  `and ${rest} more ${rest === 1 ? 'value is not a finite number' : 'values are not finite numbers'} (${total} in all)`;

/** The warnings' count line; `root` names the record on the batch, where each item counts alone. */
const moreBeyondSafe =
  (root?: string) =>
  (rest: number, total: number): string =>
    `and ${rest} more ${rest === 1 ? 'integer' : 'integers'} beyond 2^53−1${root === undefined ? '' : ` in ${root}`} (${total} in all)`;

/**
 * Thrown before a tool's first store write when a record holds a non-finite number. `paths` is
 * every one (its length is the count); `errors` is what a reply shows — the first ten lines, then
 * `and N more values are not finite numbers (T in all)` — built once here, so every renderer
 * prints the same bounded list.
 */
export class ArgsNumbersRefusal extends Error {
  readonly errors: readonly string[];
  constructor(readonly paths: readonly string[]) {
    super();
    this.errors = boundedLines(paths, nonFiniteText, moreNonFinite);
    this.message = this.errors.join('; ');
    this.name = 'ArgsNumbersRefusal';
  }
}

brandClass(
  ArgsNumbersRefusal,
  Symbol.for('@sensigo/realm-mcp/ArgsNumbersRefusal'),
  REALM_MCP_BRAND,
);

/** Every root walked; throws {@link ArgsNumbersRefusal} when any holds a non-finite number. */
function walkRoots(roots: ReadonlyArray<readonly [string, unknown]>): NumbersFound[] {
  const found = roots.map(([path, value]) => walkNumbers(value, path));
  const nonFinite = found.flatMap((f) => f.nonFinite);
  if (nonFinite.length > 0) throw new ArgsNumbersRefusal(nonFinite);
  return found;
}

/**
 * The walk over a call's free-form records, `[path, value]` each, for a tool whose records each
 * belong to their own run (`start_run_batch`'s items): throws {@link ArgsNumbersRefusal} when any
 * holds a non-finite number; otherwise returns each root's warning lines, in the roots' order, each
 * list bounded on its own — the count line names its root.
 */
export function checkArgsNumbers(roots: ReadonlyArray<readonly [string, unknown]>): string[][] {
  return walkRoots(roots).map((f, i) =>
    boundedLines(f.beyondSafe, beyondSafeWarning, moreBeyondSafe(roots[i]![0])),
  );
}

/**
 * The same walk for a tool whose records make one reply: one warning list over every root — the
 * first ten in the roots' order, then `and N more integers beyond 2^53−1 (T in all)`, T counting
 * every number walked.
 */
export function checkArgsNumbersJoined(roots: ReadonlyArray<readonly [string, unknown]>): string[] {
  return boundedLines(
    walkRoots(roots).flatMap((f) => f.beyondSafe),
    beyondSafeWarning,
    moreBeyondSafe(),
  );
}

/**
 * The refusal in the door's own argument-refusal shape (`create_workflow`'s `makeErrorEnvelope`):
 * `status: 'error'`, the lines in `errors`, `agent_action: 'provide_input'`, the tool's own
 * `command`, and no `error_code` — nothing is minted in core's closed `ErrorCode` union.
 */
export function argsNumbersEnvelope(
  command: string,
  refusal: ArgsNumbersRefusal,
  runId = '',
): McpEnvelope {
  return {
    command,
    run_id: runId,
    run_version: 0,
    status: 'error',
    data: {},
    evidence: [],
    warnings: [],
    errors: [...refusal.errors],
    agent_action: 'provide_input',
    context_hint: `Invalid ${command} input. Fix the errors and retry.`,
    next_actions: [],
  };
}
