// replay-store.ts — issue #616 PR-1b B7 (page `PAGE-pr1b-cut.md`, unit B7): core's `ReplayStore` on a
// SQLite home, with the JSON store's contract (the CLI's `store/replay-store.ts`): `realm run replay
// --save` saves a replay under a fresh id, and `realm run diff` reads it back by that id.
// `openRealmHome` builds the one store of a handle over the home's primitive; the package's entry does
// not export the class.
//
// A replay is one row of `replays`: its id, its record as JSON text and its `created_at`. The store
// reads no clock: `created_at` is the write's one reading, the one the primitive takes after
// `BEGIN IMMEDIATE`. A save goes through one `immediate`, with a `verify` that reads the record back by
// content; a get through one `snapshot`. Only absence is "Replay not found": a read that fails rejects
// with the store's own error (the JSON store reports every failure as "not found").
import { randomUUID } from 'node:crypto';
import { brandClass, type ReplayRecord, type ReplayStore } from '@sensigo/realm';
import { REALM_STORE_SQLITE_BRAND } from './brand.js';
import type { RealmDb } from './connection.js';

/** Core's replay store on a SQLite home (see the module comment). */
export class SqliteReplayStore implements ReplayStore {
  readonly #db: RealmDb;

  /** Package-internal: `openRealmHome` builds the one store of a handle over the home's primitive. */
  constructor(db: RealmDb) {
    this.#db = db;
  }

  /**
   * Saves a replay in one write under a fresh id (`rpl_` and a random UUID), stamped with the write's
   * one reading, and returns the stored record: the caller's fields, then `id`, then `created_at`, the
   * JSON store's key order.
   */
  async save(record: Omit<ReplayRecord, 'id' | 'created_at'>): Promise<ReplayRecord> {
    return this.#db.immediate(
      (db, reading) => {
        const stored: ReplayRecord = {
          ...record,
          id: `rpl_${randomUUID()}`,
          created_at: reading.toISOString(),
        };
        db.prepare('INSERT INTO replays (id, record, created_at) VALUES (?, ?, ?)').run(
          stored.id,
          JSON.stringify(stored),
          stored.created_at,
        );
        return stored;
      },
      // Landed when the row under its id holds exactly the record written.
      (db, stored) =>
        db.prepare('SELECT record FROM replays WHERE id = ?').get(stored.id)?.['record'] ===
        JSON.stringify(stored),
    );
  }

  /**
   * The replay saved under `replayId`, in one read. A replay that does not exist rejects with a plain
   * `Error`, "Replay not found: <id>"; a read that fails rejects with the store's own error.
   */
  async get(replayId: string): Promise<ReplayRecord> {
    return this.#db.snapshot((db) => {
      const row = db.prepare('SELECT record FROM replays WHERE id = ?').get(replayId);
      if (row === undefined) throw new Error(`Replay not found: ${replayId}`);
      return JSON.parse(String(row['record'])) as ReplayRecord;
    });
  }
}

brandClass(
  SqliteReplayStore,
  Symbol.for('@sensigo/realm-store-sqlite/SqliteReplayStore'),
  REALM_STORE_SQLITE_BRAND,
);
