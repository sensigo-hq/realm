// key-holder.ts — issue #616 PR-1a unit 2 (the withdrawn PR-1a prompt's decision 9; #715 (a) D6-51,
// D6-58): the rules a run store shares for a key's holder (which of an idempotency key's runs is its
// canonical run) and for a version conflict. Moved out of `json-file-store.ts` with no change in
// behaviour; the two ordering functions are typed over only the fields they read, so a store that
// reads only those columns can call them without building a whole record.
import { parseStamp } from '../engine/instants.js';
import type { RunRecord } from '../types/run-record.js';
import { WorkflowError } from '../types/workflow-error.js';

/** The fields of a run the key-holder ordering reads. */
export type KeyHolderFields = Pick<RunRecord, 'id' | 'created_at' | 'terminal_state'>;

/**
 * Newest-first comparator: by `created_at` descending, tie-broken by lexicographically
 * greatest `id`. Used to deterministically pick a canonical run for a key.
 *
 * issue #715 (a) (D6-51, D6-58): the stamps are compared by VALUE (parsed), never as
 * strings — an ISO string compare sorts `…:00Z` after `…:00.001Z`. A `created_at` that does not
 * parse ({@link parseStamp} gives `undefined`) is OLDER than every one that does; equal values (or two unparseable stamps) tie-break by
 * id, so the order never depends on the input order.
 */
export function compareCanonical(
  a: Pick<KeyHolderFields, 'id' | 'created_at'>,
  b: Pick<KeyHolderFields, 'id' | 'created_at'>,
): number {
  // #715 (b) (D-25): through the one stamp parser; `undefined` sorts OLDEST (D6-58).
  const ta = parseStamp(a.created_at);
  const tb = parseStamp(b.created_at);
  if ((ta === undefined) !== (tb === undefined)) return ta !== undefined ? -1 : 1;
  if (ta !== undefined && tb !== undefined && ta !== tb) return ta < tb ? 1 : -1;
  return a.id < b.id ? 1 : -1;
}

/**
 * The version conflict `update()` refuses with, and `deleteAllForRun`'s `expectVersion` guard
 * (issue #715 (a)): one builder, so the two refusals carry the same message and `details`.
 */
export function versionConflictError(
  runId: string,
  expected: number,
  actual: number,
): WorkflowError {
  return new WorkflowError('Version conflict — run was modified by another process', {
    code: 'STATE_SNAPSHOT_MISMATCH',
    category: 'STATE',
    agentAction: 'report_to_user',
    retryable: true,
    details: { runId, expected, actual },
  });
}

/**
 * Canonical-pick rule (decision on record): exactly one live (non-terminal) run → it;
 * multiple live → newest live by created_at (the rest are reported as extraLive); else
 * the newest terminal by created_at (tie-break: greatest id).
 */
export function pickCanonical<T extends KeyHolderFields>(
  runs: readonly T[],
): { canonical: T; extraLive: T[] } {
  const live = runs.filter((r) => !r.terminal_state);
  if (live.length === 1) return { canonical: live[0]!, extraLive: [] };
  if (live.length > 1) {
    const sorted = [...live].sort(compareCanonical);
    return { canonical: sorted[0]!, extraLive: sorted.slice(1) };
  }
  const sorted = [...runs].sort(compareCanonical);
  return { canonical: sorted[0]!, extraLive: [] };
}
