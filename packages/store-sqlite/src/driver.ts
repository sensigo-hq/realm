// driver.ts — issue #616 unit 4: THE ONE LOADER of Node's built-in SQLite. No other module in Realm
// loads `node:sqlite` (a source scan pins it, tests included): every database the package opens is
// opened through `openDatabase`, after the version check below has passed once in this process.
//
// What it does, once per process (the result is cached, a refusal too):
//   1. loads the built-in through `process.getBuiltinModule('node:sqlite')` (a Node without it is
//      refused with `STATE_STORE_DRIVER_UNAVAILABLE`), dropping exactly one warning while it loads:
//      Node 22 (and 24 before 24.21) prints "ExperimentalWarning: SQLite is an experimental feature
//      …" on stderr at that moment, through `process.emitWarning`;
//   2. asks an in-memory database for SQLite's version and refuses a version with the WAL-reset bug
//      (sqlite.org/wal.html §11: it can, in rare cases, corrupt a database that two connections write
//      or checkpoint at the same instant; it affects 3.7.0 through 3.51.2 and is fixed in 3.51.3, with
//      backports 3.44.6 and 3.50.7). It never touches a file or a home itself.
//
// The rest of the package sees only `DatabaseLike` and `StatementLike`: the few functions of Node's
// `DatabaseSync` and `StatementSync` it uses, as structural types (no type is imported from
// `node:sqlite`).
import { WorkflowError } from '@sensigo/realm';

/** The part of Node's `StatementSync` the package uses. */
export interface StatementLike {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}

/** The part of Node's `DatabaseSync` the package uses. */
export interface DatabaseLike {
  exec(sql: string): void;
  prepare(sql: string): StatementLike;
  close(): void;
  /** Whether a transaction is open on this connection. */
  readonly isTransaction: boolean;
}

/** The options a sibling module may pass when it opens a database (those of Node's constructor). */
export type OpenOptions = Record<string, unknown>;

interface DatabaseConstructor {
  new (path: string, options?: OpenOptions): DatabaseLike;
}

/** What a loader reads from Node. The process's loader reads `process`; a test passes its own. */
export interface SqliteLoaderDeps {
  /** Node's built-in SQLite module, or `undefined` (or a throw) when this Node has none. */
  loadBuiltin(): unknown;
  /** This Node's version, as `process.version` says it (`v22.22.3`). */
  nodeVersion: string;
}

/** A loader: its first use loads and checks; every later use gets that same result. */
export interface SqliteLoader {
  /** The SQLite version this Node bundles, when it is safe; throws the refusal otherwise. */
  load(): { version: string };
  /** Opens a database at `path` through the loader (after the check). */
  open(path: string, options?: OpenOptions): DatabaseLike;
}

/** The floors a refusal names: the first releases of each Node line that bundle SQLite 3.51.3. */
const NODE_FLOORS =
  "Realm's store needs Node 22.22.3 or a later 22.x release, or Node 24.15.0 or later.";

function noBuiltinSqlite(nodeVersion: string): WorkflowError {
  return new WorkflowError(`This Node (${nodeVersion}) has no built-in SQLite. ${NODE_FLOORS}`, {
    code: 'STATE_STORE_DRIVER_UNAVAILABLE',
    category: 'STATE',
    agentAction: 'report_to_user',
    retryable: false,
    details: { node: nodeVersion },
  });
}

function unsafeSqlite(nodeVersion: string, version: string): WorkflowError {
  return new WorkflowError(
    `This Node bundles SQLite ${version}, which has a bug that can, in rare cases, corrupt a database ` +
      'that two connections write at the same moment (the WAL-reset bug, fixed in SQLite 3.51.3). ' +
      NODE_FLOORS,
    {
      code: 'STATE_STORE_DRIVER_UNAVAILABLE',
      category: 'STATE',
      agentAction: 'report_to_user',
      retryable: false,
      details: { node: nodeVersion, sqlite: version },
    },
  );
}

/**
 * Whether a SQLite version is free of the WAL-reset bug: 3.51.3 or later, or a release of the two
 * backport lines at or after its fix (3.44.6 and later 3.44.x; 3.50.7 and later 3.50.x). A version
 * that is not three numbers is not judged safe.
 */
function isSafeSqliteVersion(version: string): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (m === null) return false;
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (major !== 3) return major > 3;
  if (minor === 44) return patch >= 6;
  if (minor === 50) return patch >= 7;
  return minor > 51 || (minor === 51 && patch >= 3);
}

/** Whether a warning is the built-in's own: an `ExperimentalWarning` whose message names SQLite. */
function isSqliteExperimentalWarning(warning: unknown, typeArgument: unknown): boolean {
  // Node's two forms: `emitWarning(message, 'ExperimentalWarning')`, or an Error whose name is the type.
  const type = warning instanceof Error ? warning.name : typeArgument;
  const message = warning instanceof Error ? warning.message : warning;
  return (
    type === 'ExperimentalWarning' && typeof message === 'string' && /\bSQLite\b/.test(message)
  );
}

/**
 * Runs `load` with `process.emitWarning` replaced: the SQLite `ExperimentalWarning` is dropped, and
 * every other warning is passed on as it was given. The original is put back in a `finally`, also
 * when `load` throws.
 */
function withoutSqliteExperimentalWarning<T>(load: () => T): T {
  const original = process.emitWarning;
  process.emitWarning = function emitWarningExceptSqlite(
    this: unknown,
    warning: string | Error,
    ...rest: unknown[]
  ): void {
    if (isSqliteExperimentalWarning(warning, rest[0])) return;
    (original as (...args: unknown[]) => void).apply(process, [warning, ...rest]);
  } as typeof process.emitWarning;
  try {
    return load();
  } finally {
    process.emitWarning = original;
  }
}

/** A loader over `deps`. The package's own is {@link openDatabase}'s; tests make their own. */
export function createSqliteLoader(deps: SqliteLoaderDeps): SqliteLoader {
  let result:
    | { ok: true; version: string; Database: DatabaseConstructor }
    | { ok: false; error: WorkflowError }
    | undefined;

  const loaded = (): { version: string; Database: DatabaseConstructor } => {
    if (result === undefined) {
      let builtin: unknown;
      try {
        builtin = withoutSqliteExperimentalWarning(() => deps.loadBuiltin());
      } catch {
        // A Node that has no such built-in (`ERR_UNKNOWN_BUILTIN_MODULE`) is a Node without SQLite.
        builtin = undefined;
      }
      const Database = (builtin as { DatabaseSync?: unknown } | undefined)?.DatabaseSync;
      if (typeof Database !== 'function') {
        result = { ok: false, error: noBuiltinSqlite(deps.nodeVersion) };
      } else {
        const memory = new (Database as DatabaseConstructor)(':memory:');
        let version: string;
        try {
          version = String(memory.prepare('SELECT sqlite_version() AS v').get()?.['v']);
        } finally {
          memory.close();
        }
        result = isSafeSqliteVersion(version)
          ? { ok: true, version, Database: Database as DatabaseConstructor }
          : { ok: false, error: unsafeSqlite(deps.nodeVersion, version) };
      }
    }
    if (!result.ok) throw result.error;
    return result;
  };

  return {
    load: () => ({ version: loaded().version }),
    // Node's constructor refuses an `options` that is `undefined` ("must be an object"): pass it only
    // when given.
    open: (path, options) => {
      const Database = loaded().Database;
      return options === undefined ? new Database(path) : new Database(path, options);
    },
  };
}

/** This process's loader: Node's own built-in, Node's own version. */
const processLoader = createSqliteLoader({
  loadBuiltin: () => process.getBuiltinModule?.('node:sqlite'),
  nodeVersion: process.version,
});

/** Loads and checks this Node's SQLite (once per process); returns its version or throws the refusal. */
export function loadSqlite(): { version: string } {
  return processLoader.load();
}

/** Opens a database at `path` (`':memory:'` for one in memory) through the one loader. */
export function openDatabase(path: string, options?: OpenOptions): DatabaseLike {
  return processLoader.open(path, options);
}
