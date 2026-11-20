// callback-keys.ts — callback B1a (R1.3; the callback design, owner 896326ed): the signing keys of a
// SQLite home on the `callback_keys` table (store format 3), core's `CallbackKeyStore`
// (`SqliteCallbackKeys`). Package-internal: the run store builds the one instance of a handle
// (`keys`); callback B1b puts it on the home's callback store.
//
// The key's text never reaches the file. A slot holds what the home's SEALER made of the text
// (`OpenRealmHomeOptions.sealer`, injected at the open and carried on the primitive like its clock),
// with the key's fingerprint and the sealer's master-key fingerprint beside it. A slot the sealer
// cannot unseal, or any slot of a home opened without a sealer, reads `unreadable` with its row's
// master-key fingerprint. Without a sealer the two writes that must seal (a `make` of a new key and
// a `replace`) throw; `rotate` never reaches a seal there, since every current reads unreadable.
//
// The store re-implements no rule of the keys: each method checks the request (core's
// `checkCallbackKeyRequest`) before its transaction, so a malformed one takes no reading. Then ONE
// write transaction reads the pair's rows, unseals each, calls core's pure decider with the
// transaction's one reading, and writes the slots it returns, sealing each key it writes. `read` and
// `list` (callback K2a-1) are each one read transaction with its one reading; `delete` takes none.
import { isDeepStrictEqual } from 'node:util';
import {
  brandClass,
  callbackKeyFingerprint,
  callbackKeyListingAt,
  callbackKeyPairAt,
  checkCallbackKeyRequest,
  decideCallbackKeyEndPrevious,
  decideCallbackKeyMake,
  decideCallbackKeyReplace,
  decideCallbackKeyRotate,
  type CallbackKeyDecision,
  type CallbackKeyDeleteResult,
  type CallbackKeyEndResult,
  type CallbackKeyListing,
  type CallbackKeyMakeResult,
  type CallbackKeyPair,
  type CallbackKeyReplaceResult,
  type CallbackKeyRotateRequest,
  type CallbackKeyRotateResult,
  type CallbackKeySlot,
  type CallbackKeySlotName,
  type CallbackKeyStore,
} from '@sensigo/realm';
import { REALM_STORE_SQLITE_BRAND } from './brand.js';
import type { RealmDb } from './connection.js';
import type { DatabaseLike } from './driver.js';

/** Where a sealed key belongs: its pair and its slot. */
type SealContext = {
  readonly workflow_id: string;
  readonly host: string;
  readonly slot: CallbackKeySlotName;
};

/**
 * Seals a signing key's text for the store file and unseals it again (callback B1a). A home takes it
 * at its open (`OpenRealmHomeOptions.sealer`). The blob's format, and what it binds the key to beyond
 * `ctx`, are the sealer's own. `unseal` answers `undefined` for a blob it cannot read: one sealed
 * under another master key, or damaged. Both run inside the store's write transaction, so both are
 * synchronous.
 */
export interface CallbackKeySealer {
  /** The fingerprint of the master key it seals under, stored beside every slot it writes. */
  readonly masterFp: string;
  seal(text: string, ctx: SealContext): Uint8Array;
  unseal(blob: Uint8Array, ctx: SealContext): string | undefined;
}

const SELECT_PAIR =
  'SELECT slot, sealed, key_fp, master_fp, created_at, expires_at FROM callback_keys WHERE workflow_id = ? AND host = ?';

/** Writes one slot whole: a new slot is inserted, a stored one gets every column replaced. */
const UPSERT =
  'INSERT INTO callback_keys (workflow_id, host, slot, sealed, key_fp, master_fp, created_at, expires_at) ' +
  'VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (workflow_id, host, slot) DO UPDATE SET ' +
  'sealed = excluded.sealed, key_fp = excluded.key_fp, master_fp = excluded.master_fp, ' +
  'created_at = excluded.created_at, expires_at = excluded.expires_at';

const DROP_SLOT = 'DELETE FROM callback_keys WHERE workflow_id = ? AND host = ? AND slot = ?';

/** The thrown error of a write that must seal on a home opened without a sealer. Names no key. */
function noSealer(): Error {
  return new Error(
    'This Realm home was opened without a callback key sealer, so it cannot write a signing key.',
  );
}

/** One slot as the row holds it: readable when the sealer unseals it, unreadable otherwise. */
function slotOf(
  row: Readonly<Record<string, unknown>>,
  sealer: CallbackKeySealer | undefined,
  workflowId: string,
  host: string,
): CallbackKeySlot {
  const slot = String(row['slot']) as CallbackKeySlotName;
  const created_at = String(row['created_at']);
  const ends = row['expires_at'];
  const expires = ends === null || ends === undefined ? {} : { expires_at: String(ends) };
  const text = sealer?.unseal(row['sealed'] as Uint8Array, { workflow_id: workflowId, host, slot });
  if (text === undefined)
    return {
      slot,
      state: 'unreadable',
      master_fp: String(row['master_fp']),
      created_at,
      ...expires,
    };
  return {
    slot,
    state: 'readable',
    key: text,
    key_fp: String(row['key_fp']),
    created_at,
    ...expires,
  };
}

/** The pair's slots as stored, in the caller's transaction: an absent slot is left out. */
function pairOf(
  db: DatabaseLike,
  sealer: CallbackKeySealer | undefined,
  workflowId: string,
  host: string,
): CallbackKeyPair {
  const pair: { current?: CallbackKeySlot; previous?: CallbackKeySlot } = {};
  for (const row of db.prepare(SELECT_PAIR).all(workflowId, host)) {
    const slot = slotOf(row, sealer, workflowId, host);
    if (slot.slot === 'current' || slot.slot === 'previous') pair[slot.slot] = slot;
  }
  return pair;
}

/** A slot as written: the columns the COMMIT-outcome check reads back, or `undefined` for a drop. */
type Written = readonly [slot: CallbackKeySlotName, columns: readonly unknown[] | undefined];

/**
 * Applies a decider's writes in order, in the caller's transaction, sealing each key it writes. A
 * write that must seal, on a home without a sealer, throws before anything is written.
 */
function apply(
  db: DatabaseLike,
  sealer: CallbackKeySealer | undefined,
  workflowId: string,
  host: string,
  decision: CallbackKeyDecision<unknown>,
): Written[] {
  if (sealer === undefined && decision.writes.some((write) => 'set' in write)) throw noSealer();
  const written: Written[] = [];
  for (const write of decision.writes) {
    if ('drop' in write) {
      db.prepare(DROP_SLOT).run(workflowId, host, write.drop);
      written.push([write.drop, undefined]);
      continue;
    }
    const slot = write.set;
    // The deciders write readable slots only: they carry the text the seal needs.
    if (slot.state !== 'readable') throw new Error('A callback key write carried no key text.');
    const ctx = { workflow_id: workflowId, host, slot: slot.slot };
    const columns = [
      sealer!.seal(slot.key, ctx),
      callbackKeyFingerprint(slot.key),
      sealer!.masterFp,
      slot.created_at,
      slot.expires_at ?? null,
    ];
    db.prepare(UPSERT).run(workflowId, host, slot.slot, ...columns);
    written.push([slot.slot, columns]);
  }
  return written;
}

/**
 * The write's own check after an error at its COMMIT (the primitive's protocol): true when every slot
 * it wrote reads back as written and every slot it dropped is gone.
 */
function landed(db: DatabaseLike, workflowId: string, host: string, written: Written[]): boolean {
  return written.every(([slot, columns]) => {
    const row = db
      .prepare(
        'SELECT sealed, key_fp, master_fp, created_at, expires_at FROM callback_keys WHERE workflow_id = ? AND host = ? AND slot = ?',
      )
      .get(workflowId, host, slot);
    if (columns === undefined) return row === undefined;
    if (row === undefined) return false;
    const stored = [
      new Uint8Array(row['sealed'] as Uint8Array),
      row['key_fp'],
      row['master_fp'],
      row['created_at'],
      row['expires_at'],
    ];
    return isDeepStrictEqual(stored, [
      new Uint8Array(columns[0] as Uint8Array),
      ...columns.slice(1),
    ]);
  });
}

/** Core's signing-key store on a SQLite home (see the module comment). */
export class SqliteCallbackKeys implements CallbackKeyStore {
  readonly #db: RealmDb;

  /** Package-internal: the run store builds the one instance of a handle over the home's primitive. */
  constructor(db: RealmDb) {
    this.#db = db;
  }

  /** One write transaction: the pair, the decision at its one reading, the decided writes. */
  async #decide<R>(
    workflowId: string,
    host: string,
    decide: (pair: CallbackKeyPair, at: Date) => CallbackKeyDecision<R>,
  ): Promise<R> {
    const sealer = this.#db.sealer;
    const done = await this.#db.immediate(
      (db, reading) => {
        const decision = decide(pairOf(db, sealer, workflowId, host), reading);
        return { result: decision.result, written: apply(db, sealer, workflowId, host, decision) };
      },
      (db, result) => landed(db, workflowId, host, result.written),
    );
    return done.result;
  }

  /** The pair at the read's one reading: a previous only while live. */
  async read(workflowId: string, host: string): Promise<CallbackKeyPair> {
    checkCallbackKeyRequest({ kind: 'pair', workflowId, host });
    const sealer = this.#db.sealer;
    return this.#db.snapshot((db, reading) =>
      callbackKeyPairAt(pairOf(db, sealer, workflowId, host), reading),
    );
  }

  async make(workflowId: string, host: string, candidate: string): Promise<CallbackKeyMakeResult> {
    checkCallbackKeyRequest({ kind: 'candidate', workflowId, host, candidate });
    return this.#decide(workflowId, host, (pair, at) => decideCallbackKeyMake(pair, candidate, at));
  }

  async rotate(
    workflowId: string,
    host: string,
    request: CallbackKeyRotateRequest,
  ): Promise<CallbackKeyRotateResult> {
    checkCallbackKeyRequest({ kind: 'rotate', workflowId, host, request });
    return this.#decide(workflowId, host, (pair, at) => decideCallbackKeyRotate(pair, request, at));
  }

  async endPrevious(workflowId: string, host: string): Promise<CallbackKeyEndResult> {
    checkCallbackKeyRequest({ kind: 'pair', workflowId, host });
    return this.#decide(workflowId, host, (pair, at) => decideCallbackKeyEndPrevious(pair, at));
  }

  async replace(
    workflowId: string,
    host: string,
    candidate: string,
  ): Promise<CallbackKeyReplaceResult> {
    checkCallbackKeyRequest({ kind: 'candidate', workflowId, host, candidate });
    return this.#decide(workflowId, host, (pair, at) =>
      decideCallbackKeyReplace(pair, candidate, at),
    );
  }

  /**
   * Every pair with a live slot (core's `callbackKeyListingAt`), in one read transaction with its one
   * reading. The rows come in UTF-8 byte order: the columns' BINARY collation, on a UTF-8 file.
   */
  async list(): Promise<readonly CallbackKeyListing[]> {
    const sealer = this.#db.sealer;
    return this.#db.snapshot((db, reading) => {
      const listing: CallbackKeyListing[] = [];
      const rows = db
        .prepare(
          'SELECT workflow_id, host, slot, sealed, key_fp, master_fp, created_at, expires_at ' +
            'FROM callback_keys ORDER BY workflow_id, host',
        )
        .all();
      for (let i = 0; i < rows.length;) {
        const workflowId = String(rows[i]!['workflow_id']);
        const host = String(rows[i]!['host']);
        const pair: { current?: CallbackKeySlot; previous?: CallbackKeySlot } = {};
        for (; i < rows.length; i += 1) {
          const row = rows[i]!;
          if (row['workflow_id'] !== workflowId || row['host'] !== host) break;
          const slot = slotOf(row, sealer, workflowId, host);
          if (slot.slot === 'current' || slot.slot === 'previous') pair[slot.slot] = slot;
        }
        const entry = callbackKeyListingAt(workflowId, host, pair, reading);
        if (entry !== undefined) listing.push(entry);
      }
      return listing;
    });
  }

  /** Removes both slots of the pair, in one write that takes no reading. */
  async delete(workflowId: string, host: string): Promise<CallbackKeyDeleteResult> {
    checkCallbackKeyRequest({ kind: 'pair', workflowId, host });
    return this.#db.immediate(
      (db) => {
        const had =
          db
            .prepare(
              "SELECT 1 FROM callback_keys WHERE workflow_id = ? AND host = ? AND slot = 'current'",
            )
            .get(workflowId, host) !== undefined;
        db.prepare('DELETE FROM callback_keys WHERE workflow_id = ? AND host = ?').run(
          workflowId,
          host,
        );
        return { had_current: had };
      },
      (db) =>
        db
          .prepare('SELECT 1 FROM callback_keys WHERE workflow_id = ? AND host = ?')
          .get(workflowId, host) === undefined,
      { takesReading: false },
    );
  }
}

brandClass(
  SqliteCallbackKeys,
  Symbol.for('@sensigo/realm-store-sqlite/SqliteCallbackKeys'),
  REALM_STORE_SQLITE_BRAND,
);
