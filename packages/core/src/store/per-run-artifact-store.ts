// per-run-artifact-store.ts — marker interface for the operator run-purge primitive (issue #107).
//
// Deliberately SEPARATE from RunStore: purge is a destructive capability every persistence layer
// must opt into explicitly, not a method every RunStore implementation is forced to carry. A
// Postgres RunStore implements PerRunArtifactStore orthogonally (DELETE row + cascade) without
// the RunStore interface itself ever knowing deletion exists.

/**
 * A store that owns one class of on-disk (or otherwise persisted) per-run artifact and can
 * delete every artifact it owns for a given run. Implemented by `JsonFileStore` (run + idempotency
 * pointer files), `FailedAttemptStore` (the `.attempts.jsonl` sidecar), and `JsonTraceBufferStore`
 * (orphaned WAL files) — each store deletes ONLY its own artifacts; no store or caller hard-codes
 * another store's filename layout.
 */
export interface PerRunArtifactStore {
  /**
   * Delete every on-disk artifact this store holds for `runId`. Idempotent (ENOENT-safe: a second
   * call, or a call after a concurrent purge already removed the artifact, is a no-op, never an
   * error).
   *
   * Corollary contract (issue #183): **a store MUST NOT report success for artifacts it cannot
   * see. Absence (ENOENT) is success; unreachability (any other errno) MUST throw.** A store that
   * silently swallows a real I/O error (permissions, a torn mount, disk failure) and resolves
   * anyway is lying to every caller — most consequentially `realm run purge`, whose entire
   * safety story rests on `purged` meaning the artifact is actually gone.
   *
   * @param dirEntries Optional pre-scanned `readdir(runsDir)` listing, supplied by a BATCH purge so
   *   glob-based stores avoid one `readdir` per run (O(N×dir) → O(dir)). This is a filesystem-only
   *   optimization — non-fs stores (e.g. Postgres) and exact-path stores ignore it. When omitted, a
   *   store that needs a directory listing performs its own `readdir`.
   */
  deleteAllForRun(runId: string, dirEntries?: readonly string[]): Promise<void>;
}
