// driver.test.ts — issue #616 unit 4: the one loader of Node's built-in SQLite. The real cases: a Node
// whose SQLite has the WAL-reset corruption bug (24.13.1 bundles 3.51.2), a Node with no built-in
// SQLite (20.x), and the "ExperimentalWarning: SQLite is an experimental feature…" line Node 22 prints
// on stderr when the built-in loads. Most cells go through `createSqliteLoader` with a module of their
// own (the seam that injects the version and the load); two use this process's real Node.
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createSqliteLoader, openDatabase, type SqliteLoaderDeps } from './driver.js';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FLOORS =
  "Realm's store needs Node 22.22.3 or a later 22.x release, or Node 24.15.0 or later.";

/** A built-in module whose in-memory database reports `version`, as Node's would. */
function builtinReporting(version: string): unknown {
  return {
    DatabaseSync: class {
      prepare() {
        return { get: () => ({ v: version }) };
      }
      close() {}
    },
  };
}

/** What a loader refuses with: its code, message and details (or `accepted`). */
function verdict(deps: SqliteLoaderDeps): unknown {
  try {
    return { accepted: createSqliteLoader(deps).load().version };
  } catch (err) {
    const e = err as { code?: string; message?: string; details?: unknown };
    return { code: e.code, message: e.message, details: e.details };
  }
}

describe('#616 unit 4 — the version check', () => {
  it('accepts exactly the releases without the WAL-reset bug: 3.51.3 and later, 3.44.6+, 3.50.7+', () => {
    const versions = [
      '3.44.5',
      '3.44.6',
      '3.45.0',
      '3.49.9',
      '3.50.6',
      '3.50.7',
      '3.51.2',
      '3.51.3',
      '3.53.4',
    ];
    const accepted = versions.filter((v) => {
      const result = verdict({ loadBuiltin: () => builtinReporting(v), nodeVersion: 'v24.0.0' });
      return (result as { accepted?: string }).accepted === v;
    });
    // (1) red when a boundary is written `>` for `>=` (3.44.6, 3.50.7 or 3.51.3 drops out), or a
    //     version in neither backport line below 3.51.3 is let in; (2) prints the accepted list.
    expect(accepted).toEqual(['3.44.6', '3.50.7', '3.51.3', '3.53.4']);
  });

  it('refuses a SQLite with the bug, naming its version, the bug and the Node floors', () => {
    // (1) red when the refusal's words, code or details change (the sentence an operator reads on Node
    //     24.13.1); (2) prints the code, message and details.
    expect(
      verdict({ loadBuiltin: () => builtinReporting('3.51.2'), nodeVersion: 'v24.13.1' }),
    ).toEqual({
      code: 'STATE_STORE_DRIVER_UNAVAILABLE',
      message: `This Node bundles SQLite 3.51.2, which has a bug that can, in rare cases, corrupt a database that two connections write at the same moment (the WAL-reset bug, fixed in SQLite 3.51.3). ${FLOORS}`,
      details: { node: 'v24.13.1', sqlite: '3.51.2' },
    });
  });

  it('refuses a version string it cannot read, naming the string', () => {
    // (1) red when an unreadable version is let in, or the refusal stops naming what SQLite said; (2)
    //     prints the code and message.
    const result = verdict({
      loadBuiltin: () => builtinReporting('3.51'),
      nodeVersion: 'v22.22.3',
    });
    expect(result).toMatchObject({
      code: 'STATE_STORE_DRIVER_UNAVAILABLE',
      message: expect.stringContaining('This Node bundles SQLite 3.51, which has a bug'),
    });
  });

  it('loads once: a second call gets the first result, a refusal too, without loading again', () => {
    let loads = 0;
    const loader = createSqliteLoader({
      loadBuiltin: () => {
        loads += 1;
        return builtinReporting('3.51.2');
      },
      nodeVersion: 'v24.13.1',
    });
    const first = (() => {
      try {
        return loader.load();
      } catch (err) {
        return err;
      }
    })();
    const second = (() => {
      try {
        return loader.load();
      } catch (err) {
        return err;
      }
    })();
    // (1) red when the built-in is loaded again (the warning filter would run twice) or a later call
    //     gets another error object; (2) prints the load count and whether both are the same.
    expect({ loads, same: first === second }).toEqual({ loads: 1, same: true });
  });
});

describe('#616 unit 4 — a Node with no built-in SQLite', () => {
  it('Node 20: the module is undefined, or the load throws ERR_UNKNOWN_BUILTIN_MODULE → the refusal naming this Node', () => {
    const unknownBuiltin = Object.assign(new Error('No such built-in module'), {
      code: 'ERR_UNKNOWN_BUILTIN_MODULE',
    });
    const expected = {
      code: 'STATE_STORE_DRIVER_UNAVAILABLE',
      message: `This Node (v20.20.0) has no built-in SQLite. ${FLOORS}`,
      details: { node: 'v20.20.0' },
    };
    // (1) red when the raw error or `undefined` is let through (a TypeError, or Node's own
    //     ERR_UNKNOWN_BUILTIN_MODULE, in place of Realm's refusal); (2) prints both verdicts.
    expect({
      undefinedModule: verdict({ loadBuiltin: () => undefined, nodeVersion: 'v20.20.0' }),
      loadThrows: verdict({
        loadBuiltin: () => {
          throw unknownBuiltin;
        },
        nodeVersion: 'v20.20.0',
      }),
    }).toEqual({ undefinedModule: expected, loadThrows: expected });
  });
});

describe('#616 unit 4 — the ExperimentalWarning Node prints while the built-in loads', () => {
  const heard: string[] = [];
  const listener = (w: Error): void => {
    heard.push(`${w.name}: ${w.message}`);
  };
  afterEach(() => {
    process.off('warning', listener);
    heard.length = 0;
  });

  /** Lets the `warning` events of `process.emitWarning` (emitted on the next tick) arrive. */
  const settle = (): Promise<void> => new Promise((r) => setImmediate(r));

  it("drops Node's own SQLite warning during the load, and passes on every other warning", async () => {
    process.on('warning', listener);
    const before = process.emitWarning;
    createSqliteLoader({
      loadBuiltin: () => {
        // Node's own call (22.23.3 and 24.13.1, executed): the type is a string argument.
        process.emitWarning(
          'SQLite is an experimental feature and might change at any time',
          'ExperimentalWarning',
        );
        process.emitWarning(
          '#616 u4 probe: another feature is experimental',
          'ExperimentalWarning',
        );
        process.emitWarning('#616 u4 probe: an unrelated warning', 'DeprecationWarning');
        return builtinReporting('3.53.4');
      },
      nodeVersion: 'v22.23.3',
    }).load();
    const after = process.emitWarning;
    await settle();
    // (1) red with no filter (the SQLite line is heard), with a filter too wide (the other
    //     ExperimentalWarning or the DeprecationWarning is lost), or when `process.emitWarning` is
    //     not put back; (2) prints what the listener heard and whether `emitWarning` is the original.
    expect({
      heard: heard.filter((h) => h.includes('SQLite') || h.includes('#616 u4 probe')),
      restored: after === before,
    }).toEqual({
      heard: [
        'ExperimentalWarning: #616 u4 probe: another feature is experimental',
        'DeprecationWarning: #616 u4 probe: an unrelated warning',
      ],
      restored: true,
    });
  });

  it('drops it in its Error form too, and puts process.emitWarning back when the load throws', async () => {
    process.on('warning', listener);
    const before = process.emitWarning;
    const warning = new Error('SQLite is an experimental feature and might change at any time');
    warning.name = 'ExperimentalWarning';
    const result = verdict({
      loadBuiltin: () => {
        process.emitWarning(warning);
        throw new Error('#616 u4 probe: the load failed');
      },
      nodeVersion: 'v22.23.3',
    });
    const after = process.emitWarning;
    await settle();
    // (1) red when the Error form gets through, or the original is not restored after a throw; (2)
    //     prints what was heard, whether `emitWarning` is the original, and the load's refusal code.
    expect({
      heard: heard.filter((h) => h.includes('SQLite')),
      restored: after === before,
      code: (result as { code?: string }).code,
    }).toEqual({ heard: [], restored: true, code: 'STATE_STORE_DRIVER_UNAVAILABLE' });
  });

  it('a child that loads and opens an in-memory database through the loader prints nothing on stderr', () => {
    // On the CI floor (Node 22.22.3) Node prints the warning while the built-in loads; on Node 24.21
    // it prints nothing either way, so this cell can fail only where the warning exists.
    const driver = pathToFileURL(join(PACKAGE_ROOT, 'dist', 'driver.js')).href;
    const script =
      `import { loadSqlite, openDatabase } from ${JSON.stringify(driver)};` +
      "try { loadSqlite(); openDatabase(':memory:').close(); console.log('opened'); }" +
      ' catch (e) { console.log(e.code); }';
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      timeout: 20_000,
    });
    // (1) red when the filter is gone on a Node that prints the warning (stderr holds it), or the
    //     loader cannot open a database on this Node; (2) prints the exit status, stderr and stdout.
    expect({ status: child.status, stderr: child.stderr, stdout: child.stdout.trim() }).toEqual({
      status: 0,
      stderr: '',
      stdout: 'opened',
    });
  }, 30_000);
});

describe('#616 unit 4 — the interface a sibling module gets', () => {
  it("openDatabase hands back Node's database: exec, prepare (run, get, all), isTransaction, close", () => {
    const db = openDatabase(':memory:');
    try {
      db.exec('CREATE TABLE t (x INTEGER)');
      const inserted = db.prepare('INSERT INTO t (x) VALUES (?)').run(7);
      db.exec('BEGIN');
      const during = db.isTransaction;
      db.exec('ROLLBACK');
      // (1) red when the interface names a function Node's database does not have, so a sibling's
      //     call fails at run time (`isTransaction` misnamed, `run` not returning `changes`); (2)
      //     prints what each call gave.
      expect({
        changes: Number(inserted.changes),
        one: db.prepare('SELECT x FROM t').get(),
        all: db.prepare('SELECT x FROM t').all(),
        during,
        after: db.isTransaction,
      }).toEqual({ changes: 1, one: { x: 7 }, all: [{ x: 7 }], during: true, after: false });
    } finally {
      db.close();
    }
  });
});

describe('#616 unit 4 correction — the door: open checks before it builds a database', () => {
  /** A built-in whose database reports `version` and records the arguments of every construction. */
  function recordingBuiltin(version: string): { builtin: unknown; built: unknown[][] } {
    const built: unknown[][] = [];
    return {
      built,
      builtin: {
        DatabaseSync: class {
          constructor(...args: unknown[]) {
            built.push(args);
          }
          prepare() {
            return { get: () => ({ v: version }) };
          }
          close() {}
        },
      },
    };
  }

  it('on an unsafe SQLite, open refuses with the refusal and builds no database but the in-memory one the check uses', () => {
    const { builtin, built } = recordingBuiltin('3.51.2');
    const loader = createSqliteLoader({ loadBuiltin: () => builtin, nodeVersion: 'v24.13.1' });
    const refusals = ['/home/u/.realm/realm.db', ':memory:'].map((path) => {
      try {
        loader.open(path, { timeout: 5 });
        return 'opened';
      } catch (err) {
        const e = err as { code?: string; message?: string };
        return `${e.code}: ${e.message}`;
      }
    });
    const refusal = `STATE_STORE_DRIVER_UNAVAILABLE: This Node bundles SQLite 3.51.2, which has a bug that can, in rare cases, corrupt a database that two connections write at the same moment (the WAL-reset bug, fixed in SQLite 3.51.3). ${FLOORS}`;
    // (1) red when `open` builds the database without the check passing (a constructor kept outside
    //     the checked result, so the store would open on a SQLite with the corruption bug): a
    //     construction for the given path appears, or a call returns `opened`; (2) prints each call's
    //     outcome and every construction's arguments.
    expect({ refusals, built }).toEqual({
      refusals: [refusal, refusal],
      built: [[':memory:']],
    });
  });

  it('on a safe SQLite, open hands the path and the options through, and passes no options when none were given', () => {
    const { builtin, built } = recordingBuiltin('3.53.4');
    const loader = createSqliteLoader({ loadBuiltin: () => builtin, nodeVersion: 'v24.21.0' });
    loader.open('/home/u/.realm/realm.db', { timeout: 5, readOnly: true });
    loader.open('/home/u/.realm/other.db');
    // (1) red when `open` changes the path or the options, or passes an `undefined` options argument
    //     (Node's constructor refuses it: "must be an object"); (2) prints every construction's
    //     arguments (the first is the check's own in-memory database).
    expect(built).toEqual([
      [':memory:'],
      ['/home/u/.realm/realm.db', { timeout: 5, readOnly: true }],
      ['/home/u/.realm/other.db'],
    ]);
  });
});
