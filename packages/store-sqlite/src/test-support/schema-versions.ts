// schema-versions.ts — issue #616, test support only (moved here from `schema-ladder-616.test.ts` by
// PR-2c c6, unchanged): the synthetic schema ladder. Only version 1 exists, so tests that need a
// second or a third version build them here: version 2 adds two tables and fills the first; version 3
// rebuilds the first table with a new column, the design owner's way (the old table renamed away, the
// new one created under its final name with its exact text, the rows copied, the old one dropped),
// and adds an index. The ladder test climbs it; the maintenance entry's cells (c6) open a version-1
// file through it as an older file. Not published: the package's `files` leave out
// `dist/**/test-support/**`.
import { REALM_STORE_SCHEMA, REALM_STORE_VERSIONS, type StoreSchemaVersions } from '@sensigo/realm';

export const V2_TABLE = 'CREATE TABLE ladder_notes (k TEXT NOT NULL)';
export const V2_TAGS = 'CREATE TABLE ladder_tags (tag TEXT NOT NULL)';
export const V3_TABLE = 'CREATE TABLE ladder_notes (k TEXT NOT NULL, w TEXT)';
export const V3_INDEX = 'CREATE INDEX ladder_notes_by_k ON ladder_notes (k)';
export const STEP_2 = [
  V2_TABLE,
  V2_TAGS,
  "INSERT INTO ladder_notes (k) VALUES ('written by step 2')",
];
export const STEP_3 = [
  'ALTER TABLE ladder_notes RENAME TO ladder_notes_old',
  V3_TABLE,
  'INSERT INTO ladder_notes (k) SELECT k FROM ladder_notes_old',
  'DROP TABLE ladder_notes_old',
  V3_INDEX,
];
export const V2_SCHEMA = [...REALM_STORE_SCHEMA, V2_TABLE, V2_TAGS];
// The rebuilt table keeps its place in the schema's order; in a climbed file it lands after `ladder_tags`.
export const V3_SCHEMA = [...REALM_STORE_SCHEMA, V3_TABLE, V2_TAGS, V3_INDEX];

/** Core's versions, with the synthetic 2 and 3 after them; `step3` replaces version 3's step. */
export function ladder(step3: readonly string[] = STEP_3): StoreSchemaVersions {
  return new Map([
    ...REALM_STORE_VERSIONS,
    [2, { schema: V2_SCHEMA, upgrade: STEP_2 }],
    [3, { schema: V3_SCHEMA, upgrade: step3 }],
  ]);
}
