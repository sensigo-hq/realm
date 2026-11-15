// outbound-ledger.ts — issue #597, D1c-1 (design record `DESIGN-D1-rev5.md` §2): the `outbound` table
// of a SQLite home, schema version 2 (`store-schema-versions.ts`). Package-internal. This unit gives
// the home's purge the table's one deleter, so a run's ledger rows go with it; D1c-2 adds the ledger
// store (core's `OutboundLedger`) to this file.
//
// A run's STORED SIZE is the sum, over its rows, of the UTF-8 byte length of every text column but
// `run_id` (a NULL counts 0): what D1a's in-memory ledger measures (`bytesOf`), whose rows carry no
// run id. It is what the purge reports.
import type { RowsDeleted } from './artifact-delete-failure.js';
import type { DatabaseLike } from './driver.js';

/** The table, as a delete failure names its artifact. */
export const ARTIFACT = 'outbound';

/** A run's stored size: every text column's UTF-8 length but `run_id`, summed (0 for no rows). */
function storedSize(db: DatabaseLike, runId: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(
        COALESCE(octet_length(entry_key), 0) + COALESCE(octet_length(type), 0) +
        COALESCE(octet_length(status), 0) + COALESCE(octet_length(lease_token), 0) +
        COALESCE(octet_length(lease_deadline), 0) + COALESCE(octet_length(last_at), 0) +
        COALESCE(octet_length(last_outcome), 0) + COALESCE(octet_length(sent_at), 0) +
        COALESCE(octet_length(created_at), 0)), 0) AS size FROM outbound WHERE run_id = ?`,
    )
    .get(runId);
  return Number(row?.['size'] ?? 0);
}

/**
 * Deletes run `runId`'s rows in the caller's write transaction (the home's purge calls it): reads
 * their keys, measures their stored size and deletes them; its check is true when no key it saw
 * remains for the run. Synchronous; reads no clock; throws what SQLite throws, unmapped.
 */
export function deleteOutboundRowsOfRun(db: DatabaseLike, runId: string): RowsDeleted {
  const keys = db
    .prepare('SELECT entry_key FROM outbound WHERE run_id = ?')
    .all(runId)
    .map((r) => String(r['entry_key']));
  const bytes = storedSize(db, runId);
  db.prepare('DELETE FROM outbound WHERE run_id = ?').run(runId);
  return {
    bytes,
    gone: (check) =>
      keys.every(
        (key) =>
          check
            .prepare('SELECT 1 FROM outbound WHERE run_id = ? AND entry_key = ?')
            .get(runId, key) === undefined,
      ),
  };
}
