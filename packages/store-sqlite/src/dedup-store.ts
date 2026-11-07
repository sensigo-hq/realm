// dedup-store.ts — issue #616 PR-1b B8: the duplicate-webhook memory on the home's database. `realm
// listen` asks it whether a webhook id was seen (at-least-once delivery sends one event twice) and
// records the id once the run it started exists. It is the best-effort window in front of the real
// guard, the run's own idempotency key (Trigger.dev's two layers; n8n's "dispatch, then record").
//
// One instance per scope, the scope being the workflow id (`RealmHome.dedupStoreFor`). A row of
// `webhook_dedup` is one id in one scope: the id's hash (never the raw id), the write's reading when
// it was recorded, and its expiry, fixed then. Every instant comes from the reading the primitive hands
// the call; the store reads no clock. An id is live while its expiry is later than the reading.
//
// `record` also deletes up to EXPIRED_PER_RECORD of its scope's expired rows, in the same write:
// nothing calls `cleanup` in production, and without this sweep the table would only grow (where a
// key-value store would expire them by itself).
import { createHash } from 'node:crypto';
import { brandClass, type DedupStore } from '@sensigo/realm';
import { REALM_STORE_SQLITE_BRAND } from './brand.js';
import type { RealmDb } from './connection.js';
import type { DatabaseLike } from './driver.js';

/** How many of its scope's expired rows one `record` deletes, at most: it keeps the write short. */
export const EXPIRED_PER_RECORD = 100;

/** A live row for a key: its expiry is later than the reading. */
const LIVE =
  'SELECT expires_at FROM webhook_dedup WHERE scope = ? AND key_hash = ? AND expires_at > ?';

/** The stored hash of a webhook id: the first 32 hex characters of its sha256 (the file store's). */
export function dedupKeyHash(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 32);
}

/** An instant in the store's one text shape (`YYYY-MM-DDTHH:MM:SS.sssZ`): text order is time order. */
function stamp(ms: number): string {
  return new Date(ms).toISOString();
}

/** Whether `scope` holds a live row for `hash` at the instant `at`. */
function isLive(db: DatabaseLike, scope: string, hash: string, at: string): boolean {
  return db.prepare(LIVE).get(scope, hash, at) !== undefined;
}

/**
 * The duplicate-webhook memory of one workflow on a Realm home's database (see the module comment).
 * A store failure rejects with the primitive's mapped error, `cleanup` included.
 */
export class SqliteDedupStore implements DedupStore {
  readonly #db: RealmDb;
  readonly #scope: string;

  constructor(db: RealmDb, scope: string) {
    this.#db = db;
    this.#scope = scope;
  }

  /**
   * Resolves true when this scope holds a row for `key` whose expiry is later than the reading.
   * `ttlMs` is ignored: the window was fixed when the id was recorded.
   */
  async check(key: string, _ttlMs?: number): Promise<boolean> {
    const hash = dedupKeyHash(key);
    return this.#db.snapshot((db, reading) =>
      isLive(db, this.#scope, hash, stamp(reading.getTime())),
    );
  }

  /**
   * Records `key` for `ttlMs` from the reading: first deletes up to {@link EXPIRED_PER_RECORD} of
   * this scope's expired rows; then keeps a live row for the key as it is (a second record inside
   * the window resolves and never moves it), or inserts the row, after removing an expired one.
   */
  async record(key: string, ttlMs: number): Promise<void> {
    const hash = dedupKeyHash(key);
    const scope = this.#scope;
    await this.#db.immediate(
      (db, reading) => {
        const at = stamp(reading.getTime());
        db.prepare(
          `DELETE FROM webhook_dedup WHERE scope = ? AND key_hash IN (
  SELECT key_hash FROM webhook_dedup WHERE scope = ? AND expires_at <= ? ORDER BY expires_at LIMIT ?
)`,
        ).run(scope, scope, at, EXPIRED_PER_RECORD);
        if (!isLive(db, scope, hash, at)) {
          db.prepare('DELETE FROM webhook_dedup WHERE scope = ? AND key_hash = ?').run(scope, hash);
          db.prepare(
            'INSERT INTO webhook_dedup (scope, key_hash, recorded_at, expires_at) VALUES (?, ?, ?, ?)',
          ).run(scope, hash, at, stamp(reading.getTime() + ttlMs));
        }
        return at;
      },
      // The write is there when a live row for the key is: true on the keep branch too.
      (db, at) => isLive(db, scope, hash, at),
    );
  }

  /**
   * Deletes this scope's rows that have expired at the reading, or were recorded more than
   * `maxAgeMs` before it.
   */
  async cleanup(maxAgeMs: number): Promise<void> {
    const scope = this.#scope;
    const doomed = 'scope = ? AND (expires_at <= ? OR recorded_at < ?)';
    await this.#db.immediate(
      (db, reading) => {
        const bounds = [stamp(reading.getTime()), stamp(reading.getTime() - maxAgeMs)] as const;
        db.prepare(`DELETE FROM webhook_dedup WHERE ${doomed}`).run(scope, ...bounds);
        return bounds;
      },
      (db, bounds) =>
        db.prepare(`SELECT 1 FROM webhook_dedup WHERE ${doomed} LIMIT 1`).get(scope, ...bounds) ===
        undefined,
    );
  }
}

brandClass(
  SqliteDedupStore,
  Symbol.for('@sensigo/realm-store-sqlite/SqliteDedupStore'),
  REALM_STORE_SQLITE_BRAND,
);
