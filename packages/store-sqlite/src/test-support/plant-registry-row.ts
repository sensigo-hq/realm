// plant-registry-row.ts — test support (issue #616 PR-2c, c10a-4a; moved here from the CLI's test
// support by c10b-2b, DELTAS 58e), published through the package's `./test-support` entry. It is not a
// production API and may change with any release.
//
// It plants a registered copy the store can never write itself, as plain SQL on a foreign connection,
// for the cells that pin what a surface says about one. `register()` keys a copy on its `id`, so a text
// with no `id` (not JSON, empty, the text `null`) can only reach the registry from outside Realm. The
// store then reads a `'{ not json'` or `''` copy as the registry's pointer arm, and a `'null'` copy as
// the checker's "it is null" clause.
//
// The registry's guard trigger refuses such text and survives `ignore_check_constraints`, so the plant
// drops it and re-creates it with its exact statement, in one transaction: every later open of the file
// compares the schema text object by object and refuses a missing trigger as tampered. The file is
// reached only through `openForeignConnection` (DELTAS 58e R2), and the two time columns take a fixed
// instant.
//
// One text plants ONCE per home: the version row's hash is its primary key and
// `workflow_versions_insert_once` refuses a second, so a second plant of the same text in one home rolls
// back.
import { REALM_STORE_SCHEMA } from '@sensigo/realm';
import { workflowVersionHash } from '../workflow-store.js';
import { openForeignConnection } from './foreign-connection.js';

const VERSION_GUARD = 'workflow_versions_insert_valid';
/** Any time column: a fixed instant, read by nothing a planted-row cell asserts. */
const PLANTED_AT = '2026-01-01T00:00:00.000Z';

/**
 * Plants `text` as the current registered copy of `id` in the home at `home` (the folder that holds
 * `realm.db`): a version row under the text's hash, a registration and the pointer, as Realm's own
 * registration writes them. `'{ not json'` or `''` reads as the registry's pointer arm; `'null'` as the
 * checker's "it is null" clause.
 */
export async function plantRegistryRow(
  home: string,
  row: { readonly id: string; readonly text: string },
): Promise<void> {
  const guard = REALM_STORE_SCHEMA.find((s) => s.startsWith(`CREATE TRIGGER ${VERSION_GUARD} `));
  if (guard === undefined) throw new Error(`the store's schema holds no ${VERSION_GUARD} trigger`);
  const hash = workflowVersionHash(row.text);
  const connection = await openForeignConnection(home);
  try {
    connection.exec('BEGIN IMMEDIATE');
    try {
      connection.exec(`DROP TRIGGER ${VERSION_GUARD}`);
      connection
        .prepare(
          'INSERT INTO workflow_versions (hash, id, definition, first_registered_at) VALUES (?, ?, ?, ?)',
        )
        .run(hash, row.id, row.text, PLANTED_AT);
      const newest = connection
        .prepare('SELECT max(seq) AS seq FROM workflow_registrations WHERE id = ?')
        .get(row.id) as { seq: number | null };
      connection
        .prepare(
          'INSERT INTO workflow_registrations (id, seq, hash, registered_at) VALUES (?, ?, ?, ?)',
        )
        .run(row.id, newest.seq === null ? 0 : newest.seq + 1, hash, PLANTED_AT);
      // A workflow already registered has its pointer moved, as a re-registration moves it.
      connection
        .prepare(
          'INSERT INTO workflows (id, current_hash, registered_at) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET current_hash = excluded.current_hash, registered_at = excluded.registered_at',
        )
        .run(row.id, hash, PLANTED_AT);
      connection.exec(guard);
      connection.exec('COMMIT');
    } catch (err) {
      connection.exec('ROLLBACK');
      throw err;
    }
  } finally {
    connection.close();
  }
}
