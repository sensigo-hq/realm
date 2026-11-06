// commit-faults.ts — issue #616 unit 9, test support: THE DRIVER-SEAM FAULT WRAPPER (withdrawn
// prompt's decision 14). The native fault shims of the reference build are lost, so a cell that
// needs SQLite to fail where the real library cannot be made to fail here (an I/O error at COMMIT
// after the data reached the file, a full disk at COMMIT, a recovery-busy on a read) wraps a real
// connection in this and arms a fault: the statements it names throw an error in the exact shape
// the built-in SQLite throws. Everything else runs on the real connection.
//
// A store opens its connections through `RealmDb.open`'s `openFile` seam: `faultyFiles()` gives that
// seam, keeps every connection it opened (the open's own, then each reopen's), and can make the next
// open fail. The package's `files` leave `dist/**/test-support/**` out of the published package.
import type { DatabaseLike, StatementLike } from '../driver.js';

/**
 * An error in the exact shape the built-in SQLite throws: `code` `ERR_SQLITE_ERROR`, SQLite's
 * `errcode`, `errstr` (SQLite's text for the code) and `message` (SQLite's text for this error).
 * Captured on Node 24.21.0 / SQLite 3.53.4 and Node 22.23.3 / SQLite 3.51.3:
 * `plans/issue-616/ia2-u08/probes/shapes.out` and `plans/issue-616/ia2-u09/probes/pending.out`.
 */
export function sqliteError(errcode: number, message: string, errstr: string): Error {
  return Object.assign(new Error(message), { code: 'ERR_SQLITE_ERROR', errcode, errstr });
}

/** SQLite's own errors that the cells inject, each in the shape above. */
export const SQLITE = {
  /** An I/O error (10, `SQLITE_IOERR`); its text is SQLite's for the code (`sqlite3ErrStr`). */
  ioError: (): Error => sqliteError(10, 'disk I/O error', 'disk I/O error'),
  /** A full disk or size limit (13), as captured. */
  full: (): Error => sqliteError(13, 'database or disk is full', 'database or disk is full'),
  /** A COMMIT with a statement still pending (5), as captured: the transaction stays open. */
  pending: (): Error =>
    sqliteError(5, 'cannot commit transaction - SQL statements in progress', 'database is locked'),
  /** A deferred constraint failed at COMMIT (787), as captured: the transaction stays open. */
  deferredConstraint: (): Error =>
    sqliteError(787, 'FOREIGN KEY constraint failed', 'constraint failed'),
  /** A recovery-busy (261, `SQLITE_BUSY_RECOVERY`), the first read after a crash; text as for 5. */
  busyRecovery: (): Error => sqliteError(261, 'database is locked', 'database is locked'),
  /** The file cannot be opened (14, `SQLITE_CANTOPEN`); its text is SQLite's for the code. */
  cantOpen: (): Error =>
    sqliteError(14, 'unable to open database file', 'unable to open database file'),
};

/** A fault armed on a connection. */
export interface Fault {
  /** The statements it hits, by their SQL text as `exec` or `prepare` received it. */
  readonly at: (sql: string) => boolean;
  /** How many hits it fires on (`Infinity`: every one); later hits run normally. */
  readonly times: number;
  /**
   * What the connection does before the error is thrown:
   *   - `'nothing'`: the statement does not run (at COMMIT, the transaction stays open);
   *   - `'run'`: the statement runs, then the error (at COMMIT: the data reached the file);
   *   - `'rollback'`: the transaction is rolled back, then the error (SQLite rolled it back itself).
   */
  readonly first: 'nothing' | 'run' | 'rollback';
  /** What the cell does at that moment, after `first` and before the error (another writer acts). */
  readonly also?: () => void;
  /** The error thrown. */
  readonly error: () => Error;
}

/** A real connection with faults that can be armed; `hits` counts each armed fault's firings. */
export interface FaultyConnection {
  readonly connection: DatabaseLike;
  arm(fault: Fault): void;
  /** How many times the faults armed so far fired. */
  hits(): number;
}

/** Wraps `real`: every statement runs on it unless an armed fault hits it. */
export function withFaults(real: DatabaseLike): FaultyConnection {
  const armed: Array<{ fault: Fault; left: number }> = [];
  let hits = 0;
  const fire = (sql: string, run: () => void): void => {
    const entry = armed.find((a) => a.left > 0 && a.fault.at(sql));
    if (entry === undefined) {
      run();
      return;
    }
    entry.left -= 1;
    hits += 1;
    if (entry.fault.first === 'run') run();
    else if (entry.fault.first === 'rollback') real.exec('ROLLBACK');
    entry.fault.also?.();
    throw entry.fault.error();
  };
  const connection: DatabaseLike = {
    exec(sql) {
      fire(sql, () => real.exec(sql));
    },
    prepare(sql): StatementLike {
      const statement = real.prepare(sql);
      const through =
        <R>(call: () => R) =>
        (): R => {
          let out: R | undefined;
          fire(sql, () => {
            out = call();
          });
          return out as R;
        };
      return {
        run: (...p) => through(() => statement.run(...p))(),
        get: (...p) => through(() => statement.get(...p))(),
        all: (...p) => through(() => statement.all(...p))(),
      };
    },
    close: () => real.close(),
    get isTransaction() {
      return real.isTransaction;
    },
  };
  return {
    connection,
    arm: (fault) => armed.push({ fault, left: fault.times }),
    hits: () => hits,
  };
}

/** `RealmDb.open`'s `openFile` seam over `open`, keeping each connection it opened, faults armable. */
export interface FaultyFiles {
  /** The seam: opens through `open` and wraps the connection. */
  readonly openFile: (path: string) => DatabaseLike;
  /** Every connection opened so far, in order: the open's own first, then each reopen's. */
  readonly opened: readonly FaultyConnection[];
  /** The next open throws `error()` before it opens anything. */
  failNextOpen(error: () => Error): void;
}

/** A `FaultyFiles` over `open` (the one loader's `openDatabase` in the cells). */
export function faultyFiles(open: (path: string) => DatabaseLike): FaultyFiles {
  const opened: FaultyConnection[] = [];
  let failNext: (() => Error) | undefined;
  return {
    openFile: (path) => {
      if (failNext !== undefined) {
        const error = failNext;
        failNext = undefined;
        throw error();
      }
      const faulty = withFaults(open(path));
      opened.push(faulty);
      return faulty.connection;
    },
    opened,
    failNextOpen: (error) => {
      failNext = error;
    },
  };
}
