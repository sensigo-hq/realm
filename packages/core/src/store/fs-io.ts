// fs-io.ts — the ENOENT-discriminating filesystem primitive (issue #183).
//
// Every store I/O site must distinguish three outcomes, never conflate them:
//   1. ENOENT → absence → success (idempotent: a delete of a missing file succeeds; a read of a
//      missing file returns "absent").
//   2. Any OTHER errno (EACCES/EPERM/EIO/EROFS/EBUSY/EISDIR/ENOTDIR/…) → THROW a typed error.
//      ENOTDIR is corruption, not absence — it must be loud.
//   3. Parse/JSON corruption → RECOVER (per-line skip / self-heal) + a loud structured warning.
//      Never silence, never throw. This is the CALLER's job — these primitives return raw
//      bytes/booleans/stats only, never parse.
//
// A `process.platform === 'win32'`-gated bounded retry absorbs transient EBUSY/EPERM/ENOTEMPTY —
// the same shape Node's own `fs.rm` uses (`maxRetries`/`retryDelay`) — because Windows
// file-locking (an antivirus scan, an open handle from another process) can make a delete/read
// transiently fail where POSIX would succeed immediately. No retry/delay on POSIX: a genuine
// EACCES there is not transient, and retrying would only slow down a real permission failure.
import { unlink, readFile, stat } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { WorkflowError } from '../types/workflow-error.js';

const WIN32_RETRY_COUNT = 3;
const WIN32_RETRY_DELAY_MS = 50;
const WIN32_RETRYABLE_CODES = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY']);

/** Errno classified as transient (worth retrying) for the ENGINE_ARTIFACT_DELETE_FAILED
 *  aggregate's `retryable` field — a lock held elsewhere, a flaky disk read. */
const RETRYABLE_ARTIFACT_ERRNO = new Set(['EBUSY', 'EIO']);
/** Errno classified as permanent (retrying will not help — same permission/mount state). Listed
 *  explicitly (rather than "everything else") so the default for an unrecognized/unknown errno
 *  stays the conservative `false` — never advertise a retry that might not help. */
const NON_RETRYABLE_ARTIFACT_ERRNO = new Set(['EACCES', 'EISDIR', 'EPERM', 'EROFS']);

function errnoCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

/**
 * Thrown by the fs-io primitives for any non-ENOENT errno. Callers map this to a typed,
 * domain-specific `WorkflowError` (e.g. `ENGINE_ARTIFACT_DELETE_FAILED` via
 * {@link toArtifactDeleteFailedError} below) at the aggregate layer — this class exists only to
 * carry the raw path + errno + cause across that boundary without losing information.
 */
export class FsIoError extends Error {
  readonly path: string;
  readonly code: string;

  constructor(op: string, path: string, cause: unknown) {
    const code = errnoCode(cause) ?? 'UNKNOWN';
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    super(`${op} failed for '${path}' (${code}): ${causeMessage}`);
    this.name = 'FsIoError';
    this.path = path;
    this.code = code;
    if (cause instanceof Error) this.cause = cause;
  }
}

/**
 * Exported ONLY so the retry policy itself can be unit-tested directly with an injected fake
 * `op` (mocking `node:fs/promises`'s real `unlink`/`readFile`/`stat` under Vitest+ESM is brittle —
 * "Cannot spy on export ... Module namespace is not configurable in ESM" — so the policy is
 * decoupled from any specific fs call and tested in isolation instead). Not part of the module's
 * intended per-call public surface (`deleteIfExists`/`readIfExists`/`statIfExists` are).
 */
export async function withWin32Retry<T>(op: () => Promise<T>): Promise<T> {
  if (process.platform !== 'win32') return op();
  let lastErr: unknown;
  for (let attempt = 0; attempt <= WIN32_RETRY_COUNT; attempt++) {
    try {
      return await op();
    } catch (err) {
      lastErr = err;
      const code = errnoCode(err);
      if (code === undefined || !WIN32_RETRYABLE_CODES.has(code)) throw err;
      if (attempt < WIN32_RETRY_COUNT) {
        await new Promise((resolve) => setTimeout(resolve, WIN32_RETRY_DELAY_MS));
      }
    }
  }
  throw lastErr;
}

/**
 * Deletes `path`. ENOENT → `false` (already gone — success, idempotent). Any other errno → throws
 * {@link FsIoError}. Returns `true` if this call actually deleted the file.
 */
export async function deleteIfExists(path: string): Promise<boolean> {
  try {
    await withWin32Retry(() => unlink(path));
    return true;
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return false;
    throw new FsIoError('unlink', path, err);
  }
}

/**
 * Reads `path` as utf8. ENOENT → `undefined` (absent). Any other errno → throws {@link FsIoError}.
 * Parsing is the CALLER's job — this returns raw bytes only.
 */
export async function readIfExists(path: string): Promise<string | undefined> {
  try {
    return await withWin32Retry(() => readFile(path, 'utf8'));
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return undefined;
    throw new FsIoError('readFile', path, err);
  }
}

/**
 * Stats `path`. ENOENT → `undefined` (absent). Any other errno → throws {@link FsIoError}.
 */
export async function statIfExists(path: string): Promise<Stats | undefined> {
  try {
    return await withWin32Retry(() => stat(path));
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return undefined;
    throw new FsIoError('stat', path, err);
  }
}

/**
 * Retryable classification for the `ENGINE_ARTIFACT_DELETE_FAILED` aggregate error (issue #183):
 * `EACCES`/`EISDIR`/`EPERM`/`EROFS` are permanent (retrying won't help — same permission/mount
 * state); `EBUSY`/`EIO` are transient (a lock held elsewhere, a flaky disk read) — worth
 * retrying. Any other or unknown errno defaults to `false` — conservative, since advertising a
 * retry that might not help is worse than not advertising one that would have.
 */
export function isRetryableArtifactErrno(code: string): boolean {
  return RETRYABLE_ARTIFACT_ERRNO.has(code) && !NON_RETRYABLE_ARTIFACT_ERRNO.has(code);
}

/** One artifact this store failed to delete, at the aggregate layer. */
export interface ArtifactDeleteFailure {
  artifact: string;
  code: string;
  message: string;
}

/**
 * Builds the aggregate `ENGINE_ARTIFACT_DELETE_FAILED` `WorkflowError` every
 * `PerRunArtifactStore.deleteAllForRun` implementation throws on a genuine (non-ENOENT) failure —
 * the single typed shape `purge` (and any other caller) can rely on regardless of which store, or
 * which internal read/delete step, actually failed. `retryable` is true iff ANY listed failure is
 * itself retryable (a partial success followed by one transient failure is worth retrying as a
 * whole).
 */
export function artifactDeleteFailedError(
  runId: string,
  store: string,
  deleted: string[],
  failures: ArtifactDeleteFailure[],
): WorkflowError {
  const summary = failures.map((f) => `${f.artifact} (${f.code})`).join(', ');
  return new WorkflowError(`${store} failed to delete artifact(s) for run '${runId}': ${summary}`, {
    code: 'ENGINE_ARTIFACT_DELETE_FAILED',
    category: 'ENGINE',
    agentAction: 'report_to_user',
    retryable: failures.some((f) => isRetryableArtifactErrno(f.code)),
    details: { runId, store, deleted, failures },
  });
}

/**
 * Convenience for the common single-failure case: extracts the errno (from an {@link FsIoError}
 * or a raw `NodeJS.ErrnoException`) and message from `err`, then wraps it via
 * {@link artifactDeleteFailedError}.
 */
export function toArtifactDeleteFailedError(
  runId: string,
  store: string,
  deleted: string[],
  artifact: string,
  err: unknown,
): WorkflowError {
  const code = err instanceof FsIoError ? err.code : (errnoCode(err) ?? 'UNKNOWN');
  const message = err instanceof Error ? err.message : String(err);
  return artifactDeleteFailedError(runId, store, deleted, [{ artifact, code, message }]);
}
