// @sensigo/realm-store-sqlite (issue #616): SQLite-backed stores for Realm. Not yet released: a later
// change wires them in; the package is private until the change that publishes it. The entry exports
// `openRealmHome` (unit 11), the one place a caller opens a Realm home, with its option and result
// types. Every other module is internal.
export { openRealmHome, type OpenRealmHomeOptions, type RealmHome } from './open-realm-home.js';
