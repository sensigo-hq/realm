// @sensigo/realm-store-sqlite (issue #616): SQLite-backed stores for Realm, published with the
// engine's other packages (c13a). The entry exports `openRealmHome` (unit 11), the one place a caller
// opens a Realm home, with its option and result types, and the type of the handle's run store (unit
// 12a; only `openRealmHome` constructs one); and `openRealmHomeForMaintenance` (PR-2c c6), the entry
// of the verbs that act on the store file (`realm db backup`, `realm db migrate`, and its check,
// c8a1), with its handles', its verbs' and its reports' types. Every other module is internal.
export { openRealmHome, type OpenRealmHomeOptions, type RealmHome } from './open-realm-home.js';
export {
  openRealmHomeForMaintenance,
  type BackupReport,
  type MaintenanceCheckHome,
  type MaintenanceHome,
  type MaintenanceVerb,
  type MigrateOptions,
  type MigrateProgress,
  type MigrateReport,
} from './maintenance.js';
// #616 PR-2c c8a1: the check's published report, its parts, and its two lists.
export {
  CHECK_FINDING_CODES,
  CHECK_IDS,
  INTEGRITY_CHECK_LIMIT,
  type CheckFacts,
  type CheckFinding,
  type CheckNotChecked,
  type CheckNotRun,
  type CheckReport,
} from './store-check.js';
export type { SqliteRunStore } from './run-store.js';
