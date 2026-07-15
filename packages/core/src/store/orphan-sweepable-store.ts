// orphan-sweepable-store.ts — marker interface for run-less orphan-artifact remediation (#163).
//
// Its OWN marker, deliberately separate from PerRunArtifactStore/TraceBufferStore (the same split
// PerRunArtifactStore itself got from RunStore, issue #107): FailedAttemptStore needs this and
// isn't a trace buffer, so it can't live on TraceBufferStore; a future Postgres-backed store has
// no filesystem-orphan analogue at all (there is no glob, no mtime, no filename to parse a runId
// out of) and must not be forced to implement a meaningless no-op just to satisfy an interface it
// has nothing to contribute to.
//
// The correctness backbone this marker exists to serve (issue #163): `append_trace` calls
// `runStore.get(runId)` FIRST, so a WAL's `<runId>.json` provably existed at WAL-creation time and
// exists for the run's entire life. "Artifact present, run file absent" is therefore ONLY true
// after the run file has been deleted (a pre-#183 purge, a manual `rm`, disk corruption) or DURING
// the sub-second atomic-write temp-rename window (the run file is a `<id>.json.<pid>.tmp`, not yet
// renamed to `<id>.json`). The age floor `gc` already enforces for temps covers that second,
// narrow window; a genuinely run-less artifact older than the floor is the first, real case.

/** One candidate orphan artifact — an absolute path this store owns, plus enough metadata for the
 *  caller (gc) to apply its own age floor. */
export interface OrphanArtifact {
  /** Absolute path. The store owns its own filename layout — the caller never reconstructs one. */
  path: string;
  /** The run ID this artifact's filename encodes — NOT validated against `liveRunIds` again by
   *  the caller; the store has already filtered on it. Carried through purely for reporting. */
  runId: string;
  /** `Stats.mtimeMs` at enumeration time — the caller applies the age floor against this. */
  mtimeMs: number;
}

export interface OrphanSweepableStore {
  /**
   * Returns this store's artifacts whose `runId` is NOT in `liveRunIds` — candidate orphans, each
   * with its absolute path and mtime. Does NOT apply an age floor and does NOT delete anything —
   * both of those are the caller's (gc's) job, so every `OrphanSweepableStore` implementation
   * shares one age-floor policy instead of each re-implementing it.
   *
   * FAIL-CLOSED, load-bearing: an enumeration or per-artifact stat failure that is NOT `ENOENT`
   * MUST throw — never fabricate an empty (or partial) list. A caught-and-swallowed failure here
   * would make every live run's artifacts look orphaned to the caller, which is the single most
   * dangerous failure mode this whole feature exists to avoid (the exact "same code, opposite
   * blast radius" trap the temp sweep's `readdir(...).catch(() => [])` is safe for and this is
   * not). `ENOENT` on the store's OWN base directory (no `runsDir` at all — a fresh install, or
   * one that never wrote this kind of artifact) legitimately yields `[]`.
   */
  listOrphans(liveRunIds: ReadonlySet<string>): Promise<OrphanArtifact[]>;
}
