// artifact-delete-failure.ts — issue #616 PR-1b (MA 4's rulings, 2026-11-07: REVIEW-1006 and
// REVIEW-1008): the delete-failure rule the SQLite per-run artifact stores share, B7's failed-attempt
// store and B4's trace buffer. Package-internal; the package's entry does not export it.
//
// A store's per-run delete reports a failure of its own statements, or a COMMIT that did not land, as
// core's `ENGINE_ARTIFACT_DELETE_FAILED`, naming the store, the artifact and the failure's code.
// Everything else passes through unchanged: a busy store after the busy budget, writes fenced after a
// write of unknown outcome, a file a newer Realm migrated, a COMMIT whose outcome is unknown, and,
// for a fenced delete, the fence's refusal and a failed read of its run. None of the primitive's own
// refusals comes with a failed statement of the store's or a COMMIT that did not land (an unknown
// outcome is not one), so none of them is wrapped.
import { artifactDeleteFailedError, WorkflowError } from '@sensigo/realm';
import { isBusy } from './connection.js';

/** SQLite's primary result codes by number (`errcode & 0xff`), the names SQLite gives them. */
const PRIMARY_RESULT_CODES: Readonly<Record<number, string>> = {
  1: 'SQLITE_ERROR',
  2: 'SQLITE_INTERNAL',
  3: 'SQLITE_PERM',
  4: 'SQLITE_ABORT',
  5: 'SQLITE_BUSY',
  6: 'SQLITE_LOCKED',
  7: 'SQLITE_NOMEM',
  8: 'SQLITE_READONLY',
  9: 'SQLITE_INTERRUPT',
  10: 'SQLITE_IOERR',
  11: 'SQLITE_CORRUPT',
  12: 'SQLITE_NOTFOUND',
  13: 'SQLITE_FULL',
  14: 'SQLITE_CANTOPEN',
  15: 'SQLITE_PROTOCOL',
  16: 'SQLITE_EMPTY',
  17: 'SQLITE_SCHEMA',
  18: 'SQLITE_TOOBIG',
  19: 'SQLITE_CONSTRAINT',
  20: 'SQLITE_MISMATCH',
  21: 'SQLITE_MISUSE',
  22: 'SQLITE_NOLFS',
  23: 'SQLITE_AUTH',
  24: 'SQLITE_FORMAT',
  25: 'SQLITE_RANGE',
  26: 'SQLITE_NOTADB',
  27: 'SQLITE_NOTICE',
  28: 'SQLITE_WARNING',
};

/**
 * The code a delete failure names: the mapped error's code when it is a `WorkflowError`, else the
 * name of SQLite's primary result code for the error's `errcode` (or its COMMIT outcome's).
 */
function failureCode(err: unknown): string {
  if (err instanceof WorkflowError) return err.code;
  const carried = err as { errcode?: unknown; commitOutcome?: { errcode?: unknown } } | null;
  const errcode = carried?.errcode ?? carried?.commitOutcome?.errcode;
  if (typeof errcode !== 'number') return 'UNKNOWN';
  return PRIMARY_RESULT_CODES[errcode & 0xff] ?? `SQLITE_${String(errcode & 0xff)}`;
}

/**
 * Whether an error one of the delete's own statements threw is the delete's failure: every error but
 * SQLite's busy answer, which the primitive waits out and retries (as the primitive judges it).
 */
export function isOwnStatementFailure(err: unknown): boolean {
  return !isBusy(err);
}

/** Who a delete failure names. */
export interface DeleteFailureNames {
  readonly runId: string;
  /** The store class's name. */
  readonly store: string;
  /** The artifact the store keeps. */
  readonly artifact: string;
}

/**
 * What a per-run delete rejects with, given the error its call rejected with and whether one of its
 * own statements failed (see the module comment): `artifactDeleteFailedError` for a failure of its own
 * statements or a COMMIT that did not land, else the error itself, unchanged.
 */
export function deleteFailure(
  err: unknown,
  ownStatementFailed: boolean,
  names: DeleteFailureNames,
): unknown {
  const outcome = (err as { commitOutcome?: { outcome?: unknown } } | null)?.commitOutcome;
  if (!ownStatementFailed && outcome?.outcome !== 'not_landed') return err;
  const message = err instanceof Error ? err.message : String(err);
  return artifactDeleteFailedError(
    names.runId,
    names.store,
    [],
    [{ artifact: names.artifact, code: failureCode(err), message }],
  );
}
