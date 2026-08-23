// drive-failure.ts — recording a failed drive attempt on the run (issue #401).
//
// THE PROBLEM. Any failure while `realm agent` drives a step — a connection error, a timeout, an
// MCP discovery failure, a missing SDK, an engine throw mid-loop, a schema-rejection wedge — used
// to write NOTHING to the store. The console said what happened and the process exited; the run
// read healthy on every operator surface until `never_claimed_idle` noticed 24 hours later.
//
// THE INVARIANT this module serves: a failed drive attempt on an EXISTING run, whose process
// survives to a catch inside `runAgent`, is visible on every operator surface within one minute.
//
// The write itself is what makes that true twice over: it records the failure AND, because
// `update()` bumps `version`/`updated_at`, it resets the idle clock — so the run stops looking
// untouched at exactly the moment it stopped being driven.
import {
  WorkflowError,
  type DriveFailureRecord,
  type DriveFailuresField,
  type RunStore,
} from '@sensigo/realm';
import { sanitizeError, extractHttpStatus } from './providers/agent-utils.js';

/** At most this many entries are retained, most-recent-last. */
const RING_CAP = 5;
/**
 * Messages are capped so one enormous provider error cannot dominate a run record. Exported so
 * run-agent's own validation mint uses THIS number rather than a second literal that could drift.
 */
export const MESSAGE_CAP = 500;
/** How deep the cause chain is walked looking for a payload. */
const CAUSE_DEPTH = 8;
/** How many times the fence re-reads and re-applies before giving up loudly. */
const WRITE_ATTEMPTS = 3;

/**
 * What a provider attaches to an error it throws, when it knows more than the error itself says.
 * A plain property on the SAME object, which is what survives every wrap point in the providers.
 */
export interface DriveCallPayload {
  error_class?: DriveFailureRecord['error_class'];
  attempts_sdk?: number;
  elapsed_ms?: number;
  last_observed_status?: number;
  retry_after_observed_ms?: number;
  declared_per_attempt_ms?: number;
  derived_ceiling_ms?: number;
}

/**
 * Walks the cause chain looking for an attached payload, PAYLOAD-FIRST and depth-bounded.
 *
 * The walk is the point: a provider's retry ladder wraps the original error in another one, so the
 * payload that knows what actually happened is a `cause` or two down. Reading only the outermost
 * error would classify every wrapped failure as `other`.
 */
export function findDriveCall(err: unknown): DriveCallPayload | undefined {
  let e: unknown = err;
  for (let depth = 0; e != null && depth < CAUSE_DEPTH; depth++) {
    if (typeof e === 'object' && 'driveCall' in e) {
      return (e as { driveCall: DriveCallPayload }).driveCall;
    }
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Classifies a thrown error, in strict precedence order.
 *
 * 1. an attached payload — the producer knew more than the error's shape says, so it wins;
 * 2. the SDK's own error names — `APIConnectionTimeoutError` is a timeout even if a status is also
 *    somehow present, which is why the name is checked before the status;
 * 3. an HTTP status, which also carries the status VALUE forward as a discriminator;
 * 4. `other`.
 */
const ERROR_CLASSES: ReadonlySet<string> = new Set([
  'connection_timeout',
  'connection_error',
  'api_status',
  'sdk_missing',
  'validation_rejected',
  'aborted_by_budget',
  'other',
]);

const NUMERIC_PAYLOAD_FIELDS = [
  'attempts_sdk',
  'elapsed_ms',
  'last_observed_status',
  'retry_after_observed_ms',
  'declared_per_attempt_ms',
  'derived_ceiling_ms',
] as const;

/**
 * Picks the known fields out of an attached payload, key-filtered and typeof-checked.
 *
 * The payload is an UNTYPED boundary into a record realm persists, so a raw spread would let any
 * key a provider happened to attach land in the store forever. Filtering is per FIELD, not
 * whole-payload: the numbers are measurements and are kept when they are numbers, while the class
 * is a CLAIM — an out-of-union value is dropped and shape classification decides instead.
 */
function pickPayload(payload: DriveCallPayload): {
  error_class?: DriveFailureRecord['error_class'];
  [k: string]: unknown;
} {
  const out: Record<string, unknown> = {};
  for (const field of NUMERIC_PAYLOAD_FIELDS) {
    const value = (payload as Record<string, unknown>)[field];
    if (typeof value === 'number' && Number.isFinite(value)) out[field] = value;
  }
  const cls = (payload as Record<string, unknown>)['error_class'];
  if (typeof cls === 'string' && ERROR_CLASSES.has(cls)) out['error_class'] = cls;
  return out as { error_class?: DriveFailureRecord['error_class'] };
}

export function classifyDriveError(err: unknown): DriveCallPayload & {
  error_class: DriveFailureRecord['error_class'];
} {
  const payload = findDriveCall(err);
  if (payload !== undefined) {
    const picked = pickPayload(payload);
    // A payload whose class did not survive the pick falls through to shape classification —
    // the measurements it carried are still kept.
    return { error_class: picked.error_class ?? shapeClassify(err), ...picked };
  }

  // `constructor.name`, not just `.name`: neither installed SDK sets `.name` on its error
  // classes, so a real connection failure or request timeout reports `name === 'Error'` and was
  // recorded as `other` — the two classes an operator most needs told apart from a hang, silently
  // collapsed. `.name` is kept for wrappers that re-throw with a copied name. Deliberately NOT
  // wrapped in try/catch: `buildEntry`'s own catch is this path's totality, and a hostile value
  // that throws here is meant to reach it.
  const name = (err as { name?: unknown } | null)?.name;
  const ctor = (err as { constructor?: { name?: unknown } } | null)?.constructor?.name;
  if (name === 'APIConnectionTimeoutError' || ctor === 'APIConnectionTimeoutError') {
    return { error_class: 'connection_timeout' };
  }
  if (name === 'APIConnectionError' || ctor === 'APIConnectionError') {
    return { error_class: 'connection_error' };
  }

  const status = extractHttpStatus(err);
  if (status !== undefined) return { error_class: 'api_status', last_observed_status: status };

  return { error_class: 'other' };
}

/**
 * The class an error's SHAPE implies, for a payload whose own claim did not survive the pick.
 *
 * The same constructor check as the arm above, and the easiest of the three to overlook: a
 * payload carrying measurements but no usable class lands here, so leaving it on `.name` would
 * have kept the whole defect alive on that one path. Same totality boundary — `buildEntry`'s
 * catch, not a guard here.
 */
function shapeClassify(err: unknown): DriveFailureRecord['error_class'] {
  const name = (err as { name?: unknown } | null)?.name;
  const ctor = (err as { constructor?: { name?: unknown } } | null)?.constructor?.name;
  if (name === 'APIConnectionTimeoutError' || ctor === 'APIConnectionTimeoutError') {
    return 'connection_timeout';
  }
  if (name === 'APIConnectionError' || ctor === 'APIConnectionError') return 'connection_error';
  if (extractHttpStatus(err) !== undefined) return 'api_status';
  return 'other';
}

/**
 * Builds the record for one failed attempt.
 *
 * TOTAL BY CONSTRUCTION, and this is not defensive habit — it closes a real hole. `buildEntry`
 * runs OUTSIDE the fence's try at every chokepoint, and every step of it touches the thrown value:
 * `classifyDriveError` reads `err.name` (a throwing getter throws here), `findDriveCall` does
 * `'driveCall' in e` (a proxy with a `has` trap throws), and `sanitizeError` calls `String(err)`
 * (a poisoned `toString` throws). A hostile thrown object would therefore make the MINT throw
 * from inside a catch — replacing the operator's actual error with a secondary one, and at
 * chokepoints (1)/(2) escalating it to (3), which would then re-mint against the WRONG error.
 *
 * So: the mint must never out-throw the failure it records. When the value cannot be rendered,
 * the degraded entry below carries all six required fields and says plainly that it could not.
 */
export function buildEntry(
  err: unknown,
  step: string,
  provider: string,
  attemptStartedAt: number,
): DriveFailureRecord {
  try {
    return buildEntryUnsafe(err, step, provider, attemptStartedAt);
  } catch {
    return {
      at: new Date().toISOString(),
      step,
      provider,
      error_class: 'other',
      message: 'unrenderable thrown value',
      elapsed_ms: Date.now() - attemptStartedAt,
    };
  }
}

function buildEntryUnsafe(
  err: unknown,
  step: string,
  provider: string,
  attemptStartedAt: number,
): DriveFailureRecord {
  const classified = classifyDriveError(err);
  return {
    at: new Date().toISOString(),
    step,
    provider,
    message: sanitizeError(err).slice(0, MESSAGE_CAP),
    // The spread goes ABOVE the computed span deliberately (issue #401): a payload key that is
    // PRESENT but undefined-valued would otherwise clobber a real measurement with nothing. With
    // this order the `??` below is the live protector of a payload's genuine 0ms span, which also
    // makes an `||` there a caught mutant rather than an equivalent one.
    ...classified,
    elapsed_ms: classified.elapsed_ms ?? Date.now() - attemptStartedAt,
  };
}

/** The one loud line printed when a failure could not be recorded — never replaces the original. */
export function lostLine(runId: string, entry: DriveFailureRecord): string {
  return `⚠ drive-failure record LOST for run ${runId} (${entry.error_class} at ${entry.at}, step '${entry.step}'): ${entry.message}`;
}

function workflowErrorCode(err: unknown): string | undefined {
  return err instanceof WorkflowError ? err.code : undefined;
}

/**
 * THE FENCE. Appends one entry to the run's drive-failure ring, and never lets its own failure
 * become the operator's problem.
 *
 * Everything here is subordinate to one rule: this must never replace, hide, or crash on top of
 * the operator's actual error. So a terminal run is a silent skip (the seal is already the
 * visibility), a vanished run is a silent skip (disposal is the visibility), contention is
 * retried, and anything else prints ONE line naming exactly what was lost.
 *
 * That line lands BESIDE the original, not always after it: chokepoints (1), (2) and (4) print
 * their error first, so the lost line follows — but chokepoint (3) mints BEFORE its re-throw
 * reaches the CLI's printer, so there the lost line comes first. Either way the operator has both.
 */
export async function recordDriveFailure(
  store: Pick<RunStore, 'get' | 'update'>,
  runId: string,
  entry: DriveFailureRecord,
): Promise<void> {
  try {
    for (let i = 0; i < WRITE_ATTEMPTS; i++) {
      const run = await store.get(runId);
      // A sealed run already tells its story; adding to it would be noise, and writing to it
      // would reopen a settled record.
      if (run.terminal_state) return;

      const prev: DriveFailuresField | undefined = run.drive_failures;
      const field: DriveFailuresField = {
        first_failed_at: prev?.first_failed_at ?? entry.at,
        // Monotonic and OUTSIDE the ring: a run that failed forty times must not read as five.
        total: (prev?.total ?? 0) + 1,
        entries: [...(prev?.entries ?? []), entry].slice(-RING_CAP),
      };

      try {
        // The record carries its own CAS version, read a few lines above. `update()` bumps
        // version and updated_at — the latter is what resets the idle clock.
        await store.update({ ...run, drive_failures: field });
        return;
      } catch (err) {
        const code = workflowErrorCode(err);
        // Contention, either flavour: re-read and re-apply against the newer record.
        if (code === 'STATE_SNAPSHOT_MISMATCH' || code === 'STATE_RUN_BUSY') continue;
        if (code === 'STATE_RUN_NOT_FOUND') return; // concurrently purged — disposal is visibility
        throw err;
      }
    }
    // Lost to contention after every retry.
    console.error(lostLine(runId, entry));
  } catch (err) {
    if (workflowErrorCode(err) === 'STATE_RUN_NOT_FOUND') return;
    console.error(lostLine(runId, entry));
  }
}
