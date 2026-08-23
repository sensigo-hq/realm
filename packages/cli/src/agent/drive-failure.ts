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
/** Messages are capped so one enormous provider error cannot dominate a run record. */
const MESSAGE_CAP = 500;
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
export function classifyDriveError(err: unknown): DriveCallPayload & {
  error_class: DriveFailureRecord['error_class'];
} {
  const payload = findDriveCall(err);
  if (payload !== undefined) return { error_class: 'other', ...payload };

  const name = (err as { name?: unknown } | null)?.name;
  if (name === 'APIConnectionTimeoutError') return { error_class: 'connection_timeout' };
  if (name === 'APIConnectionError') return { error_class: 'connection_error' };

  const status = extractHttpStatus(err);
  if (status !== undefined) return { error_class: 'api_status', last_observed_status: status };

  return { error_class: 'other' };
}

/** Builds the record for one failed attempt. */
export function buildEntry(
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
    // What actually protects a payload's genuine 0ms span is the `...classified` SPREAD BELOW,
    // which overwrites this field. For a payload-bearing error this line is dead — so an `||`
    // here would be an EQUIVALENT mutant, not a caught one. The `??` still matters for the
    // no-payload case, and the SPREAD ORDER is what a test can pin.
    elapsed_ms: classified.elapsed_ms ?? Date.now() - attemptStartedAt,
    ...classified,
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
