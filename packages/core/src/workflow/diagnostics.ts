// diagnostics.ts — structured loader-warning channel (issue #169).
//
// Turns the loader's fire-and-forget console.warn calls into a structured, code-tagged type
// (LoaderWarning) with a resolvable severity policy. This is what powers `validate`/`register
// --strict`, feeds create_workflow's agent-facing `diagnostics` field, and pre-wires issue #170
// (hard-reject at the next major version) as a dormant per-code policy flip — DEFAULT_POLICY is
// the single datum #170 changes; nothing else in this module encodes the reject/warn decision.

/**
 * Every warning code the loader (or an MCP tool wrapping the same allow-list mechanism) can
 * emit. Deliberately excludes ORPHANED_MANIFEST — that condition already throws a WorkflowError
 * (`Invalid:` + exit 1) at the CLI layer; it is a hard error, never a warning.
 */
import type { SourcePosition } from './source-positions.js';

export type WarningCode =
  | 'UNKNOWN_WORKFLOW_KEY'
  | 'UNKNOWN_STEP_KEY'
  | 'UNKNOWN_CREATE_WORKFLOW_KEY'
  | 'IDEMPOTENT_INERT_IN_FINALIZER'
  | 'DUAL_SCHEMA_DECLARED'
  | 'RETRY_NO_TIMEOUT'
  | 'EXTENSION_SENTINEL'
  // issue #140 (retryable timeout + total-time cap):
  | 'UNKNOWN_RETRY_KEY'
  | 'ON_TIMEOUT_SINGLE_ATTEMPT'
  | 'TOTAL_TIMEOUT_BELOW_ATTEMPT'
  | 'TOTAL_TIMEOUT_NON_AUTO'
  // issue #218 (extends the #140 W5 family: bare retry sub-keys, not just the cap, on a
  // non-auto step):
  | 'RETRY_INERT_NON_AUTO'
  // issue #220 PR-2 (declared fail-open validation_exhaustion.mode/default_output):
  | 'UNKNOWN_VALIDATION_EXHAUSTION_KEY'
  | 'DEAD_VALIDATION_EXHAUSTION_CONFIG'
  // issue #291 (authorable gate timeout — the FIRST gate sub-key validation the loader has ever
  // had; new codes are the precedent — #140 UNKNOWN_RETRY_KEY / #220 UNKNOWN_VALIDATION_
  // EXHAUSTION_KEY, not a noun-override reuse):
  | 'UNKNOWN_GATE_KEY'
  | 'DEAD_GATE_CONFIG';

/**
 * A single structured diagnostic. `message` is the full human-readable text (matching, for every
 * unknown-key code, exactly what `renderLoaderWarning` would independently reconstruct from the
 * structured fields — kept in sync by construction, not by convention: see `findUnknownKeys`
 * below). `scope`/`id`/`step`/`key`/`did_you_mean` are populated only by the unknown-key family;
 * other codes carry just `code`/`severity`/`message`.
 */
export interface LoaderWarning {
  code: WarningCode;
  severity: 'warn' | 'error';
  message: string;
  scope: 'workflow' | 'step';
  id?: string;
  step?: string;
  key?: string;
  did_you_mean?: string;
  /**
   * Where the offending key sits in the source YAML, 1-based (issue #392). Present only when the
   * warning came from a parsed file AND the key's position could be resolved exactly.
   *
   * ALL FOUR OR NONE — never a partial position. A range with a start and no end is not a range,
   * and a consumer that has to check four fields separately will eventually forget one.
   *
   * ABSENT, never null (the #311 precedent): "this parse could not place the key" and "the key is
   * at line 0" are different facts and the channel keeps them different. Structurally absent for
   * anything not parsed from source text — `create_workflow` builds definitions from structured
   * arguments, so there is no file for a line number to point into.
   */
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
}

/**
 * Issue #170, FLIPPED: `UNKNOWN_WORKFLOW_KEY` / `UNKNOWN_STEP_KEY` are `'error'`, which makes the
 * dormant boundary-reject at validate/register/watch (see yaml-loader.ts consumers) live — those
 * three commands now REFUSE a workflow carrying an unrecognised key.
 *
 * The refusal is BOUNDARY-GATED, not global: run/agent/listen load through the lenient
 * `loadWorkflowFromFile`, so an already-deployed workflow carrying an unknown key keeps executing
 * and keeps printing its warning. That asymmetry is the #169 design, deliberately preserved — the
 * flip stops new offenders entering, it does not strand running ones.
 *
 * UNKNOWN_CREATE_WORKFLOW_KEY is deliberately never flipped — create_workflow stays lenient for
 * agents forever (a distinct, permanent design decision, not an oversight).
 */
export const DEFAULT_POLICY: Record<WarningCode, 'warn' | 'error'> = {
  UNKNOWN_WORKFLOW_KEY: 'error',
  UNKNOWN_STEP_KEY: 'error',
  UNKNOWN_CREATE_WORKFLOW_KEY: 'warn',
  IDEMPOTENT_INERT_IN_FINALIZER: 'warn',
  DUAL_SCHEMA_DECLARED: 'warn',
  RETRY_NO_TIMEOUT: 'warn',
  EXTENSION_SENTINEL: 'warn',
  UNKNOWN_RETRY_KEY: 'warn',
  ON_TIMEOUT_SINGLE_ATTEMPT: 'warn',
  TOTAL_TIMEOUT_BELOW_ATTEMPT: 'warn',
  TOTAL_TIMEOUT_NON_AUTO: 'warn',
  RETRY_INERT_NON_AUTO: 'warn',
  UNKNOWN_VALIDATION_EXHAUSTION_KEY: 'warn',
  DEAD_VALIDATION_EXHAUSTION_CONFIG: 'warn',
  UNKNOWN_GATE_KEY: 'warn',
  DEAD_GATE_CONFIG: 'warn',
};

/**
 * Pure lookup: resolves a warning code's severity against a policy table. `--strict` passes an
 * all-'error' policy; issue #170 changes DEFAULT_POLICY itself; the dormant boundary-reject and
 * tests inject a selective policy (e.g. only UNKNOWN_WORKFLOW_KEY/UNKNOWN_STEP_KEY → 'error').
 */
export function resolveSeverity(
  code: WarningCode,
  policy: Record<WarningCode, 'warn' | 'error'> = DEFAULT_POLICY,
): 'warn' | 'error' {
  return policy[code];
}

/**
 * Levenshtein (edit) distance between two strings. Small, iterative, single-row DP — no
 * dependency, kept internal to this module.
 */
function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prevRow = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const currRow = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      currRow.push(Math.min(currRow[j - 1]! + 1, prevRow[j]! + 1, prevRow[j - 1]! + cost));
    }
    prevRow = currRow;
  }
  return prevRow[b.length]!;
}

/**
 * Suggests the closest allow-list entry to `key`, or undefined when nothing is close enough to
 * be a plausible typo. Threshold: min(2, floor(key.length/3)+1) — tuned so a one-character-off
 * typo like 'dependson' (missing the underscore in 'depends_on') hits, but an unrelated key from
 * a different vocabulary entirely (e.g. the retired 'produces_state', 14 chars, edit-distance
 * far from every current StepDefinition field) suggests nothing rather than a misleading guess.
 * On a tie, the first allow-list entry (in its declared order) at the minimum distance wins —
 * deterministic, not alphabetical.
 */
export function closestKey(key: string, allowList: readonly string[]): string | undefined {
  const threshold = Math.min(2, Math.floor(key.length / 3) + 1);
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const candidate of allowList) {
    const distance = levenshteinDistance(key, candidate);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best !== undefined && bestDistance <= threshold ? best : undefined;
}

/**
 * Builds the templated "unknown key" message text (everything after the `⚠ ` prefix).
 *
 * The position is spliced in HERE, at the mint, rather than at any render site (issue #392). Two
 * reasons. `renderLoaderWarning` is the single source of the `⚠ ` line format and stays
 * byte-untouched, so nothing downstream has to learn about positions. And the CLI's #170
 * substitution rewrites `— ignored` at print time for a refusing boundary — inserting before that
 * anchor leaves it intact, whereas inserting after it would leave the two edits fighting over the
 * same span.
 *
 * The prose carries the START line only. A human reading an error wants somewhere to look, not a
 * range; the range lives on the structured channel where a span-editing agent can use it.
 */
function renderUnknownKeyMessage(
  target: string,
  key: string,
  didYouMean: string | undefined,
  noun: string,
  line: number | undefined,
): string {
  const at = line === undefined ? '' : ` (line ${line})`;
  // Punctuation deliberately differs by form, matching the design's own literal examples exactly:
  // the no-suggestion form ends with a period (byte-identical to the pre-#169 text); the
  // did_you_mean form's trailing '?)' is the sentence's natural end — no additional period.
  if (didYouMean !== undefined) {
    return `${target}: unknown key '${key}'${at} — ignored (did you mean '${didYouMean}'?)`;
  }
  return `${target}: unknown key '${key}'${at} — ignored (not a recognized ${noun} field).`;
}

/**
 * Finds every own-key of `obj` not present in `allowList` and returns one LoaderWarning per
 * offender. Pure — no printing, no throwing. Severity is resolved against DEFAULT_POLICY at
 * construction time (a caller applying a different policy, e.g. `--strict`, re-resolves
 * `code`/nothing-else via `resolveSeverity` rather than mutating this result).
 */
export function findUnknownKeys(
  obj: Record<string, unknown>,
  allowList: readonly string[],
  ctx: {
    scope: 'workflow' | 'step';
    code: WarningCode;
    id?: string;
    step?: string;
    /**
     * Overrides the "not a recognized ___ field" noun independently of `scope` — e.g.
     * UNKNOWN_RETRY_KEY keeps `scope: 'step'` (the LoaderWarning's own scope union has no 'retry'
     * value) but reads "not a recognized retry field", not "step field". Defaults to `scope`,
     * byte-identical to pre-#140 behavior for every other unknown-key code.
     */
    noun?: string;
    /**
     * Resolves a key's position in the source YAML (issue #392). The caller supplies it because
     * only the caller knows the semantic path this object sits at — `findUnknownKeys` sees a bare
     * record and could not construct `steps.s1` on its own.
     *
     * Optional, so every existing caller compiles and behaves byte-identically. Returning
     * `undefined` for a key is the normal, expected answer (an unparsed definition, a shape the
     * position map declined to place) and produces exactly the pre-#392 warning.
     */
    positionOf?: (key: string) => SourcePosition | undefined;
  },
): LoaderWarning[] {
  const warnings: LoaderWarning[] = [];
  const target =
    ctx.scope === 'workflow' ? `workflow '${ctx.id ?? '<unknown>'}'` : `step '${ctx.step}'`;
  const noun = ctx.noun ?? ctx.scope;
  for (const key of Object.keys(obj)) {
    if (allowList.includes(key)) continue;
    const did_you_mean = closestKey(key, allowList);
    const pos = ctx.positionOf?.(key);
    const warning: LoaderWarning = {
      code: ctx.code,
      severity: resolveSeverity(ctx.code),
      message: renderUnknownKeyMessage(target, key, did_you_mean, noun, pos?.line),
      scope: ctx.scope,
      key,
    };
    if (ctx.id !== undefined) warning.id = ctx.id;
    if (ctx.step !== undefined) warning.step = ctx.step;
    if (did_you_mean !== undefined) warning.did_you_mean = did_you_mean;
    // All four or none — assigned together so a partial position is not expressible here.
    if (pos !== undefined) {
      warning.line = pos.line;
      warning.column = pos.column;
      warning.endLine = pos.endLine;
      warning.endColumn = pos.endColumn;
    }
    warnings.push(warning);
  }
  return warnings;
}

const UNKNOWN_KEY_CODES = new Set<WarningCode>([
  'UNKNOWN_WORKFLOW_KEY',
  'UNKNOWN_STEP_KEY',
  'UNKNOWN_CREATE_WORKFLOW_KEY',
  'UNKNOWN_RETRY_KEY',
  'UNKNOWN_VALIDATION_EXHAUSTION_KEY',
  'UNKNOWN_GATE_KEY',
]);

/**
 * The SINGLE source of the `⚠ ` line format — every printer (the core plain wrappers in
 * yaml-loader.ts, and the CLI's `printLoaderWarnings` helper) renders through this, never by
 * hand-rolling a `⚠ ` string itself.
 *
 * Every code in `UNKNOWN_KEY_CODES` is templated fresh from the structured fields (so the
 * `did_you_mean` suggestion is appended only when present) and always carries the `⚠ ` prefix —
 * byte-identical to the pre-#169 console.warn text (UNKNOWN_RETRY_KEY, issue #140, and
 * UNKNOWN_VALIDATION_EXHAUSTION_KEY, issue #220, both follow the same rendering exactly, just with
 * a different noun instead of 'step'/'workflow'). Every other code
 * (IDEMPOTENT_INERT_IN_FINALIZER, DUAL_SCHEMA_DECLARED, RETRY_NO_TIMEOUT, EXTENSION_SENTINEL,
 * ON_TIMEOUT_SINGLE_ATTEMPT, TOTAL_TIMEOUT_BELOW_ATTEMPT, TOTAL_TIMEOUT_NON_AUTO,
 * RETRY_INERT_NON_AUTO, DEAD_VALIDATION_EXHAUSTION_CONFIG) returns `message` verbatim: these are
 * free-text warnings whose exact current prefix (or lack of one) is preserved byte-for-byte by
 * whatever constructed them, not re-derived here.
 */
export function renderLoaderWarning(w: LoaderWarning): string {
  if (UNKNOWN_KEY_CODES.has(w.code)) {
    return `⚠ ${w.message}`;
  }
  return w.message;
}
