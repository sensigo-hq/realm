// @sensigo/realm-store-sqlite (issue #616): SQLite-backed stores for Realm, published with the
// engine's other packages (c13a). The entry exports `openRealmHome` (unit 11), the one place a caller
// opens a Realm home, with its option and result types, and the type of the handle's run store (unit
// 12a; only `openRealmHome` constructs one), and the types of the handle's purge (PR-2c c9); and
// `openRealmHomeForMaintenance` (PR-2c c6), the entry of the verbs that act on the store file
// (`realm db backup`, `realm db migrate`, its check, c8a1, and `realm db restore`, #616 R1b), with its
// handles', its verbs' and its reports' types; and `readRegisteredWorkflows` (PR-2c c10a-3b-i, DELTAS 56), the separation check's
// one read-only look at the registered workflows, with its result types. Every other module is internal.
export { openRealmHome, type OpenRealmHomeOptions, type RealmHome } from './open-realm-home.js';
export {
  openRealmHomeForMaintenance,
  // #616 R2: `realm db migrate --to`'s value, read before the store is opened.
  stepBackTarget,
  type BackupReport,
  type MaintenanceCheckHome,
  type MaintenanceHome,
  type MaintenanceVerb,
  type MigrateOptions,
  type MigrateProgress,
  type MigrateReport,
} from './maintenance.js';
export type {
  MaintenanceRestoreHome,
  RestoreProgress,
  RestoreReplaced,
  RestoreReport,
  RunDifference,
} from './restore.js';
// #616 PR-2c c8a1: the check's published report, its parts, and its two lists.
export {
  CHECK_FINDING_CODES,
  CHECK_IDS,
  INTEGRITY_CHECK_LIMIT,
  type CheckFacts,
  type CheckFinding,
  type CheckNotChecked,
  type CheckNotRun,
  type CheckOptions,
  type CheckReport,
} from './store-check.js';
// The filter-mask fix, PR 2: the kinds of changed form the `declared_forms` check names.
export { FORM_KINDS, type FormKind } from './store-check-forms.js';
export type { SqliteRunStore } from './run-store.js';
export type {
  PurgeCheckpoint,
  PurgeReport,
  PurgeRunOutcome,
  PurgeSelection,
  PurgeVacuum,
} from './home-purge.js';
// #616 PR-2c c10a-3b-i (DELTAS 56): the separation check's read-only look at the registered workflows.
export {
  readRegisteredWorkflows,
  type RegisteredWorkflow,
  type RegisteredWorkflowsRead,
} from './read-registered-workflows.js';
