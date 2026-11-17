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
  /**
   * #616 R2: the statements that move a file from this version back to the one before, run in order in
   * one transaction (`realm db migrate --to`). Absent: the step to this version cannot be undone, and
   * `cannotUndo` says why. Above version 1, a version has exactly one of the two.
   */
  readonly downgrade?: readonly string[];
  /**
   * #616 R2: what the step back drops, said after it (only with `downgrade`). `count`, when given, is a
   * query read on the file before the step whose one value is the number `words` names as `{count}`;
   * `none` is said instead when that number is 0.
   */
  readonly loses?: { readonly words: string; readonly count?: string; readonly none?: string };
  /** #616 R2: why the step to this version cannot be undone, as a clause. Only without `downgrade`. */
  readonly cannotUndo?: string;
  /**
   * #616 R2: the npm range of the Realm releases that write exactly this format, for the install line a
   * step back prints. Closed below the newest version (`0.49`, `>=0.50.0 <0.52.0`), open at the newest
   * (`>=0.50.0`): the release that adds a version closes the one before.
   */
  readonly writtenBy?: string;
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
  [1, { schema: REALM_STORE_SCHEMA, upgrade: [], writtenBy: '0.49' }],
  // #597 D1c-1: the first real step, one statement in the ladder's one transaction. #616 R2: its step
  // back drops the table, and with it the record of the reminders and escalations sent.
  [
    2,
    {
      schema: REALM_STORE_SCHEMA_V2,
      upgrade: [OUTBOUND_TABLE],
      downgrade: ['DROP TABLE outbound'],
      loses: {
        words:
          'The outbound table was dropped: the record of {count} reminder(s) and escalation(s) sent is no longer in the file.',
        count: "SELECT COUNT(*) FROM outbound WHERE status = 'sent'",
        none: 'The outbound table was dropped; it held no record of a reminder or escalation sent.',
      },
      writtenBy: '>=0.50.0',
    },
  ],
]);
