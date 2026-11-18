// callback-store.ts — callback B1a (R1.3): the `callbacks` table of a SQLite home (store format 3),
// and its one deleter, which the home's purge calls in its batch, in the same transaction as the run.
// Callback B1b adds the rows store here, core's `CallbackStore`, whose `deleteAllForRun` calls the
// same deleter. Package-internal: the package's entry does not export it.
//
// Nothing writes the table yet: the open and `realm db migrate` create it empty. A run's STORED SIZE
// is the UTF-8 byte length of its row's `url` and `body` (a NULL counts 0), what core's in-memory
// callback store measures, and what the purge reports.
import type { RowsDeleted } from './artifact-delete-failure.js';
import type { DatabaseLike } from './driver.js';

/** The table, as a delete failure names its artifact. */
export const ARTIFACT = 'callbacks';

/**
 * Deletes run `runId`'s callback row in the caller's write transaction (the home's purge calls it),
 * after measuring its stored size; its check is true when the run has no row left. Synchronous; reads
 * no clock; throws what SQLite throws, unmapped.
 */
export function deleteCallbackRowsOfRun(db: DatabaseLike, runId: string): RowsDeleted {
  const row = db
    .prepare(
      'SELECT COALESCE(octet_length(url), 0) + COALESCE(octet_length(body), 0) AS size FROM callbacks WHERE run_id = ?',
    )
    .get(runId);
  db.prepare('DELETE FROM callbacks WHERE run_id = ?').run(runId);
  return {
    bytes: Number(row?.['size'] ?? 0),
    gone: (check) =>
      check.prepare('SELECT 1 FROM callbacks WHERE run_id = ?').get(runId) === undefined,
  };
}
