// @sensigo/realm-store-sqlite (issue #616): SQLite-backed stores for Realm, published with the
// engine's other packages (c13a). The entry exports `openRealmHome` (unit 11), the one place a caller
// opens a Realm home, with its option and result types, and the type of the handle's run store (unit
// 12a; only `openRealmHome` constructs one). Every other module is internal.
export { openRealmHome, type OpenRealmHomeOptions, type RealmHome } from './open-realm-home.js';
export type { SqliteRunStore } from './run-store.js';
