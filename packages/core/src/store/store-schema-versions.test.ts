// store-schema-versions.test.ts — issue #597, D1c-1: the store's schema versions. Version 1 is the text
// 0.49.0 published, frozen (its hash was executed on the v0.49.0 tag, on main and on the npm 0.49.0
// tarball: registry D1-D1C-02), and every later version starts with the one before. A release that ships
// a new version appends its row to RELEASED, so no released version's text can change after it ships.
//
// Each assertion carries (a) the change that turns it red and (b) what it prints then.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { REALM_STORE_SCHEMA, REALM_STORE_SCHEMA_VERSION } from './store-schema.js';
import { REALM_STORE_VERSIONS } from './store-schema-versions.js';

/** The sha256 of a schema's statements, as `JSON.stringify` writes the array. */
function hashOf(schema: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(schema)).digest('hex');
}

/** Every released schema version, as its release published it. A release that ships one appends it. */
const RELEASED: readonly {
  readonly release: string;
  readonly version: number;
  readonly statements: number;
  readonly sha256: string;
}[] = [
  {
    release: '0.49.0',
    version: 1,
    statements: 74,
    sha256: 'a81f82833b7a48a34b1b0f22e359267e2642129e8708c01fa96e112a07b4a286',
  },
];

describe('#597 D1c-1 — the store schema versions', () => {
  it('version 1 is the schema 0.49.0 published, and it is REALM_STORE_SCHEMA itself', () => {
    // (a) red when a statement is appended to or changed in version 1, or version 1 is a copy of the
    //     constant; (b) prints the length, the hash and whether the map holds the constant itself.
    expect({
      statements: REALM_STORE_SCHEMA.length,
      sha256: hashOf(REALM_STORE_SCHEMA),
      mapHoldsTheConstant: REALM_STORE_VERSIONS.get(1)?.schema === REALM_STORE_SCHEMA,
      upgrade: REALM_STORE_VERSIONS.get(1)?.upgrade,
    }).toEqual({
      statements: 74,
      sha256: 'a81f82833b7a48a34b1b0f22e359267e2642129e8708c01fa96e112a07b4a286',
      mapHoldsTheConstant: true,
      upgrade: [],
    });
  });

  it('every released version keeps the text its release published', () => {
    // (a) red when a released version's statements change; (b) prints each release's figures.
    const found = RELEASED.map(({ release, version }) => {
      const schema = REALM_STORE_VERSIONS.get(version)?.schema ?? [];
      return { release, version, statements: schema.length, sha256: hashOf(schema) };
    });
    expect(found).toEqual(RELEASED);
  });

  it('the versions run from 1 to this Realm’s with no gap, and each starts with the one before', () => {
    const keys = [...REALM_STORE_VERSIONS.keys()].sort((a, b) => a - b);
    const extensions = keys.slice(1).map((v) => {
      const before = REALM_STORE_VERSIONS.get(v - 1)!.schema;
      const at = REALM_STORE_VERSIONS.get(v)!;
      return {
        version: v,
        startsWithTheOneBefore: before.every((statement, i) => at.schema[i] === statement),
        longer: at.schema.length > before.length,
        hasAStep: at.upgrade.length > 0,
      };
    });
    // (a) red when a version is missing or the constant names one the map lacks, when a version's
    //     schema does not start with the one before (version 2 not an extension of version 1), or when
    //     a version above 1 has no step; (b) prints the keys and each version's figures.
    expect({ keys, extensions }).toEqual({
      keys: Array.from({ length: REALM_STORE_SCHEMA_VERSION }, (_, i) => i + 1),
      extensions: keys.slice(1).map((version) => ({
        version,
        startsWithTheOneBefore: true,
        longer: true,
        hasAStep: true,
      })),
    });
    expect(REALM_STORE_SCHEMA_VERSION).toBeGreaterThanOrEqual(2);
  });
});
