// foreign-connection.ts — issue #616 PR-1a unit 10 (SEAMS S15), test support only (the package's
// `files` leave `dist/**/test-support/**` out except this file and the `./test-support` entry that
// re-exports it, #616 PR-2c c9a, and the source law that keeps one opener of the store file scans
// production code only): a SECOND connection on a home's `realm.db`, opened through the one
// loader. It is the hostile writer of the guard cells, and the connection PR-1b's in-transaction fence
// adapter puts runs on (`BEGIN IMMEDIATE`, `insertRunRecord`, `COMMIT`). The open is async; every
// statement on the connection is synchronous.
import { join } from 'node:path';
import { DEFAULT_BUSY_BUDGET_MS } from '../connection.js';
import { openDatabase, type DatabaseLike } from '../driver.js';
import { DATABASE_FILE } from '../home.js';

/**
 * Opens another connection on `<home>/realm.db` with `busy_timeout` (a store call's whole busy budget:
 * this connection has no wait loop of its own), `foreign_keys = ON` and `trusted_schema = OFF`.
 */
export async function openForeignConnection(home: string): Promise<DatabaseLike> {
  const db = openDatabase(join(home, DATABASE_FILE));
  try {
    db.exec(`PRAGMA busy_timeout = ${DEFAULT_BUSY_BUDGET_MS}`);
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA trusted_schema = OFF');
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}
