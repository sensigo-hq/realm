// store-schema-versions.ts — issue #616 (PR-1a unit 6c; design D4 r3 §2 "Schema evolution"): every
// schema version of the SQLite store this Realm knows, and the step that brings a file to each one. Data
// only, like the schema constant: the store package's ladder runs a step's statements over an open
// connection, and the open (unit 7b) compares a file at a known version with that version's schema.
//
// Version 1 IS `REALM_STORE_SCHEMA`, the same array and never a copy of its text: the schema 0.49.0
// published, frozen, its hash pinned by `store-schema-versions.test.ts`. A schema change adds the next
// version: its whole schema (the version before's statements, then the new ones) and the statements
// that move a file to it from the version before. #597 D1c-1 adds version 2: the `outbound` table.
import { REALM_STORE_SCHEMA } from './store-schema.js';

/** One schema version: what a file at it holds, and how a file reaches it from the version before. */
export interface StoreSchemaVersion {
  /** The schema a file at this version holds: one statement per element, as `sqlite_master` stores it. */
  readonly schema: readonly string[];
  /**
   * The statements that move a file from the version before to this one, run in order in one
   * transaction. Empty for version 1: a file is created at version 1, never upgraded to it.
   */
  readonly upgrade: readonly string[];
}

/** The versions a Realm knows, by the `user_version` a file at each one carries. */
export type StoreSchemaVersions = ReadonlyMap<number, StoreSchemaVersion>;

// ---- outbound (#597 D1c-1; design D1 rev 5 §2): what a sender leased and sent of a run's open
// question, one row per run and key, kept beside the run record and never in it, and deleted with its
// run. The key is the run and the entry, so its rows are small and found by run: WITHOUT ROWID, as
// `webhook_dedup` is. No CHECK on `status` or `type`: a CHECK would freeze the words, and widening it
// later would rebuild the table; core's `leaseOutbound`/`markOutbound` write only their own words ----
const OUTBOUND_TABLE = `CREATE TABLE outbound (
  run_id TEXT NOT NULL,
  entry_key TEXT NOT NULL,
  type TEXT NOT NULL,
  occurrence INTEGER,
  of_max INTEGER,
  status TEXT NOT NULL,
  lease_token TEXT NOT NULL,
  lease_deadline TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  last_at TEXT,
  last_outcome TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, entry_key)
) WITHOUT ROWID`;

/** Version 2's schema: version 1's statements, then the `outbound` table. Not exported from core. */
const REALM_STORE_SCHEMA_V2: readonly string[] = [...REALM_STORE_SCHEMA, OUTBOUND_TABLE];

/** This Realm's versions of the store's schema. */
export const REALM_STORE_VERSIONS: StoreSchemaVersions = new Map([
  [1, { schema: REALM_STORE_SCHEMA, upgrade: [] }],
  // #597 D1c-1: the first real step, one statement in the ladder's one transaction.
  [2, { schema: REALM_STORE_SCHEMA_V2, upgrade: [OUTBOUND_TABLE] }],
]);
