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
/**
 * What a store reports about the artifacts it just deleted (issue #189).
 *
 * Bytes are a STORE-DEFINED, internally-consistent measure — exact on-disk bytes for the
 * filesystem stores, a documented approximation elsewhere (a Postgres store uses the same
 * `SUM(octet_length(...))` expression on both its stat and its delete). The only guarantee ACROSS
 * the two methods is the L6 identity below. Cross-store sums are meaningful where the wired stores
 * share a measure, which the CLI's filesystem stores do.
 */
export interface ArtifactDeletionReport {
  bytes_deleted: number;
}

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
   *
   * ACCOUNTING RULE for the returned report (issue #189): stat, then delete. An artifact that
   * vanishes between the two still counts as deleted — the bytes are best-effort and the figure
   * is a floor, which is the documented choice. Reporting nothing would be worse: an operator
   * would read a concurrent purge as "nothing was there".
   */
  deleteAllForRun(runId: string, dirEntries?: readonly string[]): Promise<ArtifactDeletionReport>;

  /**
   * Reports the bytes this store holds for `runId`, WITHOUT deleting anything (issue #189).
   *
   * THE INVARIANT this exists for: every byte figure an operator is shown must be a number a
   * STORE reported about its OWN artifacts. Before this, `realm run purge` previewed bytes by
   * substring-scanning another store's filename layout — which under-counted content-addressed
   * artifacts and made the preview and the receipt two different kinds of claim.
   *
   * **L6 — preview equals receipt.** On an UNCHANGED run, `statAllForRun(id).bytes` equals the
   * `bytes_deleted` a subsequent `deleteAllForRun(id)` reports. This is a quiescent-store
   * property: across separate invocations a stale projection may differ, and the receipt is
   * independently true either way.
   *
   * Absent run ⇒ `{ bytes: 0 }`. Unreachability THROWS, symmetrically with the delete contract
   * above (issue #183): a stat reporting 0 for an artifact it cannot read is the same lie as a
   * delete reporting success for one it cannot remove.
   *
   * Deliberately LOCK-FREE and racy, and deliberately WITHOUT the delete path's terminal
   * refusals: this answers a dry run, which must never fail with `RUN_BUSY` where the old
   * filename scan would happily have reported a number.
   */
  statAllForRun(runId: string, dirEntries?: readonly string[]): Promise<{ bytes: number }>;
}
