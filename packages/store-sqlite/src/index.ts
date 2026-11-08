// @sensigo/realm-store-sqlite (issue #616): SQLite-backed stores for Realm, published with the
// engine's other packages (c13a). The entry exports `openRealmHome` (unit 11), the one place a caller
// opens a Realm home, with its option and result types, and the type of the handle's run store (unit
// 12a; only `openRealmHome` constructs one); and `openRealmHomeForMaintenance` (PR-2c c6), the entry
// of the verbs that act on the store file (`realm db backup`, `realm db migrate`), with its handle's,
// its verbs' and its reports' types. Every other module is internal.
export { openRealmHome, type OpenRealmHomeOptions, type RealmHome } from './open-realm-home.js';
export {
  openRealmHomeForMaintenance,
  type BackupReport,
  type MaintenanceHome,
  type MaintenanceVerb,
  type MigrateOptions,
  type MigrateProgress,
  type MigrateReport,
} from './maintenance.js';
export type { SqliteRunStore } from './run-store.js';
