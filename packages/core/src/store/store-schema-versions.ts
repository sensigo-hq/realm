// store-schema-versions.ts — issue #616 (PR-1a unit 6c; design D4 r3 §2 "Schema evolution"): every
// schema version of the SQLite store this Realm knows, and the step that brings a file to each one. Data
// only, like the schema constant: the store package's ladder runs a step's statements over an open
// connection, and the open (unit 7b) compares a file at a known version with that version's schema.
//
// Version 1 IS `REALM_STORE_SCHEMA`, the same array and never a copy of its text, so the units that
// append to version 1 before the first release change nothing here. After the first release a schema
// change adds the next version: its whole schema, and the statements that move a file to it from the
// version before.
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

/** This Realm's versions of the store's schema. */
export const REALM_STORE_VERSIONS: StoreSchemaVersions = new Map([
  [1, { schema: REALM_STORE_SCHEMA, upgrade: [] }],
]);
