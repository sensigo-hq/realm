// trace-adoption.ts — the unified writer partition (issue #197 PR-2, design record §2 —
// `plans/issue-197-design.md`, NORMATIVE).
//
// One exported predicate drives adoption, the pre-claim enforce-gate filter, and (at the store
// layer, issue #197 PR-1) per-writer budget partitioning. Congruence is mandatory: every call
// site that decides "is this line mine" — the pre-claim `trace_schema` enforce-gate, the
// post-claim adoption split, and the settle-time seal-vs-delete decision — MUST route through
// the SAME rule below, never an ad-hoc reimplementation.
//
//   adopted(line) ⇔ line.nonce ≡ claimant.nonce, with absent ≡ absent (⊥ = the bare/anonymous
//   writer class).
//
// - Bare claimant + bare lines → adopted (today's behavior, existing caveat).
// - Nonce claimant + own lines → adopted, NO caveat.
// - ANY claimant + foreign-nonced lines → preserved, NOT adopted — including the bare claimant
//   (Option A's ratified scope amendment: the dominant recovery flow is a nonced streamer
//   crashing and a bare CLI re-driving; adopting those lines would be exactly the false
//   attribution #197 removes).
// - NO same-attempt rescue heuristics, ever — server-side authorship inference was the rejected
//   #185 epoch design's sin; this predicate never guesses at provenance it cannot verify.
import type { BufferedEntry } from '../store/trace-buffer-store.js';

/**
 * The ONE authoritative adoption predicate (design §2). `undefined` on either side denotes ⊥
 * (the bare/anonymous writer class) — `undefined === undefined` is `true` in JS, so
 * `(lineNonce ?? undefined) === (claimantNonce ?? undefined)` already implements "absent ≡
 * absent" with no special-casing required.
 */
export function adoptsLine(
  claimantNonce: string | undefined,
  lineNonce: string | undefined,
): boolean {
  return (lineNonce ?? undefined) === (claimantNonce ?? undefined);
}

/** Result of partitioning a buffer/WAL read against one claimant nonce (issue #197 PR-2). */
export interface BufferedEntryPartition {
  /** Entries this claimant adopts — the ONLY entries that may flow into canonical evidence
   *  (`buildPriorityMergedTrace`) or gate the pre-claim `trace_schema` enforce check. */
  adopted: BufferedEntry[];
  /** Entries preserved but NOT adopted — belonging to a different writer. Never merged into
   *  canonical evidence and never allowed to gate the claimant; sealed (not deleted) at
   *  settle-time on a store that supports it (issue #197 PR-2, deliverable 1f). */
  foreign: BufferedEntry[];
  /**
   * Count of `adopted` entries that carry a nonce — own-writer adoption, NO caveat (design §6:
   * "writer continuity verified (same nonce as presented at claim); strength conditional on
   * nonce secrecy"). Non-zero ONLY for a nonced claimant — a ⊥ claimant's adopted set is, by
   * the predicate above, exclusively bare entries, so this is always `0` for it.
   */
  adopted_own: number;
  /**
   * Count of `adopted` entries that are bare — ⊥-writer adoption, the existing #185 caveat
   * (`buffered_lines_adopted`). Non-zero ONLY for a ⊥ (bare) claimant — a nonced claimant's
   * adopted set is exclusively its own nonce, never bare, so this is always `0` for it.
   */
  adopted_anonymous: number;
  /** Count of `foreign` entries — preserved, not adopted, from a different writer. */
  preserved_foreign: number;
}

/**
 * Partitions `entries` (a buffer/WAL read) against `claimantNonce` via `adoptsLine` — the ONE
 * partition every adoption-relevant call site (pre-claim enforce-gate, post-claim adoption,
 * settle-time seal-vs-delete decision) must use.
 *
 * `claimantNonce` should already be ACTIVATION-GATED by the caller (`undefined` when the
 * configured store doesn't declare `writer_nonce_carriage` — see `execution-loop.ts`'s own
 * activation-gate comment for why: a non-carriage store's WAL entries are bare too, so honoring
 * a real nonce there would self-demote the claimant's own bare evidence to "foreign"). This
 * function itself is unconditional and has no opinion on WHETHER a nonce should be honored —
 * only on what follows once the caller has already decided that.
 *
 * A ⊥ claimant (`claimantNonce === undefined`) can only ever produce `adopted_own === 0` — its
 * own adopted entries are, by definition, bare — with `adopted_anonymous` carrying the count
 * instead. A nonced claimant is the mirror image: `adopted_anonymous === 0`, `adopted_own`
 * carries the count. This is an invariant of the predicate above, not independently computed —
 * see each field's own doc on `BufferedEntryPartition`.
 */
export function partitionBufferedEntries(
  entries: readonly BufferedEntry[],
  claimantNonce: string | undefined,
): BufferedEntryPartition {
  const adopted: BufferedEntry[] = [];
  const foreign: BufferedEntry[] = [];
  for (const entry of entries) {
    if (adoptsLine(claimantNonce, entry._nonce)) {
      adopted.push(entry);
    } else {
      foreign.push(entry);
    }
  }
  const adopted_own = claimantNonce !== undefined ? adopted.length : 0;
  const adopted_anonymous = claimantNonce === undefined ? adopted.length : 0;
  return {
    adopted,
    foreign,
    adopted_own,
    adopted_anonymous,
    preserved_foreign: foreign.length,
  };
}
