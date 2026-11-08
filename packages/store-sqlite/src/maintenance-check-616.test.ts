// maintenance-check-616.test.ts — #616 PR-2c c8a1: the maintenance entry opened for `'check'`. It
// reads a store file the open accepts through a read-only connection, writes nothing to it, and
// returns the published report (`store-check.ts`); every refusal of the open stays a refusal.
//
// Real files throughout, except where SQLite cannot be made to answer so: the SQLite floor and a
// network filesystem through the open's seams (`loadSqlite`, `probe`), and the integrity check's
// corrupt error with an extended code (267) through `openFile`. The integrity findings come from one
// index page overwritten at its end (its cells, the page's structure kept), on a closed store.
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import {
  chmodSync,
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { systemClock } from '@sensigo/realm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createSqliteLoader, openDatabase, type DatabaseLike } from './driver.js';
import { SYSTEM_PROBE } from './filesystem-gate.js';
import { openRealmHome, type RealmHome } from './index.js';
import { openMaintenance } from './maintenance.js';
import { openForCheck } from './open-file.js';
import {
  CHECK_FINDING_CODES,
  CHECK_IDS,
  INTEGRITY_CHECK_LIMIT,
  type CheckReport,
} from './store-check.js';
import { openForeignConnection } from './test-support/foreign-connection.js';
import { ladder } from './test-support/schema-versions.js';

const dirs: string[] = [];
const homes: RealmHome[] = [];
const connections: DatabaseLike[] = [];
afterEach(() => {
  for (const c of connections.splice(0)) c.close();
  for (const h of homes.splice(0)) h.close();
});
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A fresh folder, removed after the file's cells. */
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'realm-616-c8a1-'));
  dirs.push(dir);
  return dir;
}

/** Every report a cell built, for the contract's laws (check 8, the last cell). */
const built: CheckReport[] = [];

/** The entry opened for `'check'` on `home`, its report, and the handle closed. */
async function check(home: string, seams = {}): Promise<CheckReport> {
  const m = await openMaintenance({ home, verb: 'check' }, seams);
  try {
    const report = await m.check();
    built.push(report);
    return report;
  } finally {
    m.close();
  }
}

/** What a call refused with: its code, message and details. */
async function refusal(promise: Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    await promise;
    return { resolved: true };
  } catch (err) {
    const e = err as { code?: unknown; message?: unknown; details?: unknown };
    return { code: e.code, message: e.message, details: e.details };
  }
}

/** A home with a healthy store holding `runs` runs, closed. */
async function storeHome(runs = 1): Promise<string> {
  const home = join(tmp(), '.realm');
  const h = await openRealmHome({ home });
  for (let i = 0; i < runs; i++) {
    await h.runStore.create({
      workflowId: `wf${String(i % 5)}`,
      workflowVersion: 1,
      params: { pad: 'x'.repeat(200), i },
    });
  }
  h.close();
  return home;
}

/** The home's entries and their sizes, by name. */
function entries(home: string): string[] {
  return readdirSync(home)
    .sort()
    .map((name) => `${name} ${String(statSync(join(home, name)).size)}`);
}

describe('#616 PR-2c c8a1 — opened for check, every refusal of the open stays a refusal, and there is no handle', () => {
  // #616 PR-2c c8a3: the 'uninitialised' member left (its file is c8a3's version_unknown-0 cell).
  it.each(['link', 'floor', 'network'] as const)('check 2: %s', async (state) => {
    let home: string;
    const seams: Record<string, unknown> = {};
    let expected: Record<string, unknown>;
    if (state === 'link') {
      // realm.db a symbolic link to a healthy store file elsewhere: SQLite would read through it.
      const store = await storeHome();
      home = join(tmp(), '.realm');
      mkdirSync(home);
      symlinkSync(join(store, 'realm.db'), join(home, 'realm.db'));
      const path = join(home, 'realm.db');
      expected = {
        code: 'STATE_STORE_SETTINGS_REFUSED',
        message:
          `The store file ${path} is not a Realm store this Realm can use: it is a symbolic link; ` +
          'link the home folder instead, never the store file. Realm does not change or replace ' +
          'a store file by itself.',
      };
    } else if (state === 'floor') {
      home = await storeHome();
      // Node 24.13.1's built-in, as the loader reads it: its in-memory database answers 3.51.2.
      const below = createSqliteLoader({
        loadBuiltin: () => ({
          DatabaseSync: class {
            prepare() {
              return { get: () => ({ v: '3.51.2' }) };
            }
            close() {}
          },
        }),
        nodeVersion: 'v24.13.1',
      });
      seams['loadSqlite'] = () => below.load();
      expected = { code: 'STATE_STORE_DRIVER_UNAVAILABLE' };
    } else {
      home = await storeHome();
      seams['probe'] = { ...SYSTEM_PROBE, platform: 'linux', env: {}, statfsType: () => 0x6969 };
      expected = { code: 'STATE_STORE_FILESYSTEM_REFUSED' };
    }
    const file = readFileSync(join(home, 'realm.db'));
    const got = await refusal(openMaintenance({ home, verb: 'check' }, seams));
    // (1) red when the read-only path skips one of the open's checks (a link is read through, or
    //     the floor, the filesystem gate or the application id is not judged), or when the check
    //     sets an uninitialised file up; (2) prints the refusal and whether the file changed.
    expect({
      code: got['code'],
      ...('message' in expected ? { message: got['message'] } : {}),
      unchanged: file.equals(readFileSync(join(home, 'realm.db'))),
    }).toEqual({ ...expected, unchanged: true });
  });
});

describe('#616 PR-2c c8a1 — the check writes nothing to the store file', () => {
  it('check 3: a store copied alone into a fresh home (no fences) beside a WAL holding frames: realm.db and the WAL are byte-identical after, realm.db keeps its mtime, and the home gains only realm.db-shm', async () => {
    // The live home stays open, so its WAL keeps frames no checkpoint has copied.
    const live = join(tmp(), '.realm');
    const h = await openRealmHome({ home: live });
    homes.push(h);
    for (let i = 0; i < 5; i++) {
      await h.runStore.create({ workflowId: 'wf', workflowVersion: 1, params: { i } });
    }
    const home = join(tmp(), '.realm');
    mkdirSync(home);
    copyFileSync(join(live, 'realm.db'), join(home, 'realm.db'));
    copyFileSync(join(live, 'realm.db-wal'), join(home, 'realm.db-wal'));
    const db = join(home, 'realm.db');
    const before = {
      db: readFileSync(db),
      wal: readFileSync(`${db}-wal`),
      mtime: statSync(db).mtimeMs,
      entries: entries(home),
    };
    expect(before.wal.length).toBeGreaterThan(0);
    const report = await check(home);
    // (1) red when the check runs the normal open (its fences appear in the home) or opens a
    //     read-write connection (its close copies the WAL into realm.db and removes the WAL); (2)
    //     prints whether each file is unchanged and what the home holds.
    expect({
      status: report.status,
      db: before.db.equals(readFileSync(db)),
      wal: before.wal.equals(readFileSync(`${db}-wal`)),
      mtime: statSync(db).mtimeMs === before.mtime,
      entries: entries(home).filter((e) => !e.startsWith('realm.db-shm ')),
      shm: existsSync(`${db}-shm`),
    }).toEqual({
      status: 'ok',
      db: true,
      wal: true,
      mtime: true,
      entries: before.entries,
      shm: true,
    });
  });
});

describe('#616 PR-2c c8a1 — the integrity findings', () => {
  // One closed store of 400 runs; each cell overwrites the end of the runs_by_phase index's root
  // page in its own copy. Every run has the same phase, so the index's layout does not depend on
  // the runs' ids or times.
  let base: string;
  // 400 writes, each flushed to the disk: on a loaded machine they outlast the default hook budget.
  beforeAll(async () => {
    base = await storeHome(400);
  }, 120_000);
  function damaged(bytes: number): string {
    const home = join(tmp(), '.realm');
    cpSync(base, home, { recursive: true });
    const file = join(home, 'realm.db');
    const raw = openDatabase(file, { readOnly: true });
    const root = Number(
      raw.prepare("SELECT rootpage FROM sqlite_master WHERE name = 'runs_by_phase'").get()?.[
        'rootpage'
      ],
    );
    const pageSize = Number(raw.prepare('PRAGMA page_size').get()?.['page_size']);
    raw.close();
    const fd = openSync(file, 'r+');
    writeSync(fd, Buffer.alloc(bytes, 0x5a), 0, bytes, root * pageSize - bytes);
    closeSync(fd);
    return home;
  }

  it('check 4: integrity_failed — the integrity check returns a row other than ok', async () => {
    const report = await check(damaged(16));
    // (1) red when the rows are not made a finding, or the finding's parts change; (2) prints the
    //     status and the findings.
    expect({ status: report.status, findings: report.findings }).toEqual({
      status: 'findings',
      findings: [
        {
          check: 'integrity',
          code: 'integrity_failed',
          message: "SQLite's integrity check reported 1 problem.",
          count: 1,
          examples: [expect.stringMatching(/^row \d+ missing from index runs_by_phase$/)],
        },
      ],
    });
  });

  it("check 5: N problems in N rows (an index's) — `count` N, `count_is_lower_bound: true`, and 'at least N'", async () => {
    const report = await check(damaged(64));
    const finding = report.findings[0];
    // (1) red when the count is reported as a total (no lower-bound field, no "at least"); (2)
    //     prints the finding's count, its bound, its message and how many examples it carries.
    expect({
      code: finding?.code,
      count: finding?.count,
      bound: finding?.count_is_lower_bound,
      message: finding?.message,
      examples: finding?.examples?.length,
    }).toEqual({
      code: 'integrity_failed',
      count: INTEGRITY_CHECK_LIMIT,
      bound: true,
      message: `SQLite's integrity check reported at least ${String(INTEGRITY_CHECK_LIMIT)} problems.`,
      examples: 10,
    });
  });

  it("check 4: integrity_unreadable — the integrity check fails with SQLite's corrupt error, an extended code (267) included", async () => {
    const home = await storeHome();
    // The open's seam: the real read-only connection, whose integrity check throws SQLite's error
    // shape with errcode 267 (SQLITE_CORRUPT_VTAB, an extended corrupt code).
    const openFile = (path: string, options?: { readonly readOnly: true }): DatabaseLike => {
      const real = openDatabase(path, options);
      const corrupt = Object.assign(new Error('database disk image is malformed'), {
        code: 'ERR_SQLITE_ERROR',
        errcode: 267,
        errstr: 'database disk image is malformed',
      });
      return {
        exec: (sql: string) => real.exec(sql),
        prepare: (sql: string) =>
          sql.startsWith('PRAGMA integrity_check')
            ? ({
                all: () => {
                  throw corrupt;
                },
              } as unknown as ReturnType<DatabaseLike['prepare']>)
            : real.prepare(sql),
        close: () => real.close(),
        get isTransaction() {
          return real.isTransaction;
        },
      };
    };
    const report = await check(home, { openFile });
    // (1) red when the corrupt error is not made a finding (check() rejects), or when it is read as
    //     an exact 11 (267 is then not a corrupt error); (2) prints the status and the findings.
    expect({ status: report.status, findings: report.findings }).toEqual({
      status: 'findings',
      findings: [
        {
          check: 'integrity',
          code: 'integrity_unreadable',
          message:
            'SQLite could not finish its integrity check: SQLite error 267, the file is damaged.',
        },
      ],
    });
  });
});

describe('#616 PR-2c c8a1 — a problem is a line, not a row (rev 3, AUD-C8A2-01/-02)', () => {
  /** A healthy closed store with `pages` zero pages appended and the header's page count raised
   *  (offset 28): the integrity check then names each as "Page k: never used", one line each, in one
   *  row. Returns the lines it should name. */
  async function zeroPages(pages: number): Promise<{ home: string; lines: string[] }> {
    const home = await storeHome();
    const file = join(home, 'realm.db');
    const fd = openSync(file, 'r+');
    try {
      const head = Buffer.alloc(100);
      readSync(fd, head, 0, 100, 0);
      const pageSize = head.readUInt16BE(16) === 1 ? 65_536 : head.readUInt16BE(16);
      const count = head.readUInt32BE(28);
      writeSync(fd, Buffer.alloc(pages * pageSize), 0, pages * pageSize, count * pageSize);
      const raised = Buffer.alloc(4);
      raised.writeUInt32BE(count + pages);
      writeSync(fd, raised, 0, 4, 28);
      const lines = Array.from(
        { length: pages },
        (_, i) => `Page ${String(count + 1 + i)}: never used`,
      );
      return { home, lines };
    } finally {
      closeSync(fd);
    }
  }

  it('check 5: several problems in one row — `count` is the number of problem lines, never 1', async () => {
    const { home, lines } = await zeroPages(3);
    const report = await check(home);
    // (1) red when rows are counted (one row: "1 problem", its one example the whole row); (2)
    //     prints the finding.
    expect(report.findings).toEqual([
      {
        check: 'integrity',
        code: 'integrity_failed',
        message: "SQLite's integrity check reported 3 problems.",
        count: 3,
        examples: lines,
      },
    ]);
  });

  it("check 5: N or more problems in one row — `count` N, `count_is_lower_bound: true`, and 'at least N'", async () => {
    const { home, lines } = await zeroPages(INTEGRITY_CHECK_LIMIT + 20);
    const report = await check(home);
    // (1) red when rows are counted, or the count is reported as a total (no lower-bound field, no
    //     "at least"); (2) prints the finding.
    expect(report.findings).toEqual([
      {
        check: 'integrity',
        code: 'integrity_failed',
        message: `SQLite's integrity check reported at least ${String(INTEGRITY_CHECK_LIMIT)} problems.`,
        count: INTEGRITY_CHECK_LIMIT,
        count_is_lower_bound: true,
        examples: lines.slice(0, 10),
      },
    ]);
  });
});

describe('#616 PR-2c c8a1 — the report on a healthy home, and the WAL counts', () => {
  // #616 PR-2c c8a3: two not-checked entries (refused_files left: those files are reported now).
  it('check 6: a healthy home — ok, nothing found, the two not-checked entries, and every fact present with its type', async () => {
    const home = await storeHome();
    const report = await check(home);
    const f = report.facts;
    const integer = (v: unknown): string => (Number.isInteger(v) ? 'integer' : typeof v);
    // (1) red when a fact is missing or of another type, the status is not ok, or the not-checked
    //     list changes; (2) prints the report's parts and each fact's type.
    expect({
      status: report.status,
      path: report.path,
      versions: [report.schema_version, report.reads_up_to],
      findings: report.findings,
      not_run: report.not_run,
      not_checked: report.not_checked.map((n) => n.check),
      facts: {
        sqlite_version: typeof f.sqlite_version,
        node_version: f.node_version,
        filesystem: f.filesystem,
        durability: Object.fromEntries(
          Object.entries(f.durability ?? {}).map(([k, v]) => [k, integer(v)]),
        ),
        file_bytes: integer(f.file_bytes),
        page_size: integer(f.page_size),
        page_count: integer(f.page_count),
        freelist_count: integer(f.freelist_count),
        wal_bytes: integer(f.wal_bytes),
        wal_frames: f.wal_frames,
        wal_frames_copied: f.wal_frames_copied,
      },
    }).toEqual({
      status: 'ok',
      path: join(home, 'realm.db'),
      versions: [1, 1],
      findings: [],
      not_run: [],
      not_checked: ['other_processes', 'data_checks'],
      facts: {
        sqlite_version: 'string',
        node_version: process.version,
        filesystem: { escaped: false, type: expect.any(String) as unknown },
        durability: {
          synchronous: 'integer',
          foreign_keys: 'integer',
          trusted_schema: 'integer',
          secure_delete: 'integer',
          journal_size_limit: 'integer',
          ...(process.platform === 'darwin'
            ? { fullfsync: 'integer', checkpoint_fullfsync: 'integer' }
            : {}),
        },
        file_bytes: 'integer',
        page_size: 'integer',
        page_count: 'integer',
        freelist_count: 'integer',
        wal_bytes: 'integer',
        // A clean close leaves no WAL; the read-only open makes an empty one: 0 and 0, measured.
        wal_frames: 0,
        wal_frames_copied: 0,
      },
    });
  });

  it("check 7: a WAL reset and written again (its file still sized for the old frames) — `wal_frames` is the frames written since the reset, never the file's size over the frame size", async () => {
    const home = join(tmp(), '.realm');
    const h = await openRealmHome({ home });
    homes.push(h);
    for (let i = 0; i < 40; i++) {
      await h.runStore.create({
        workflowId: 'wf',
        workflowVersion: 1,
        params: { pad: 'x'.repeat(2000), i },
      });
    }
    const c = await openForeignConnection(home);
    connections.push(c);
    c.exec('PRAGMA wal_checkpoint(RESTART)');
    await h.runStore.create({ workflowId: 'wf', workflowVersion: 1, params: {} });
    // The frames since the reset, read by another connection just before the check.
    const noop = c.prepare('PRAGMA wal_checkpoint(NOOP)').get() ?? {};
    const report = await check(home);
    const { wal_bytes: bytes = 0, page_size: page = 0 } = report.facts;
    const sizedFor = Math.floor((bytes - 32) / (page + 24));
    // (1) red when the count is derived from the WAL file's size, or read by a checkpoint mode a
    //     read-only connection refuses (the count is then absent); (2) prints both counts, the
    //     other connection's reading and what the file's size would give.
    expect({
      wal_frames: report.facts.wal_frames,
      wal_frames_copied: report.facts.wal_frames_copied,
      sizedForMore: sizedFor > Number(noop['log']),
    }).toEqual({
      wal_frames: Number(noop['log']),
      wal_frames_copied: Number(noop['checkpointed']),
      sizedForMore: true,
    });
  });
});

// ---- #616 PR-2c c8a3: the open's refusals reported as findings. Real files, except `open_failed`
// and the connection setting (the open's `openFile` seam). ----

const AS_ROOT = process.getuid?.() === 0;
/** Paths whose mode a cell changed, with the mode they get back after it. */
const locked: Array<[string, number]> = [];
afterEach(() => {
  for (const [p, mode] of locked.splice(0)) chmodSync(p, mode);
});
function lock(path: string, mode: number, back: number): void {
  chmodSync(path, mode);
  locked.push([path, back]);
}

/** Runs `statements` on the home's store file through the one loader, then closes it. */
function rawly(home: string, ...statements: string[]): void {
  const c = openDatabase(join(home, 'realm.db'));
  try {
    for (const statement of statements) c.exec(statement);
  } finally {
    c.close();
  }
}

/** A closed store with one zero page appended and the header's page count raised: one problem. */
function neverUsedPage(home: string): void {
  const fd = openSync(join(home, 'realm.db'), 'r+');
  try {
    const head = Buffer.alloc(100);
    readSync(fd, head, 0, 100, 0);
    const pageSize = head.readUInt16BE(16);
    const count = head.readUInt32BE(28);
    writeSync(fd, Buffer.alloc(pageSize), 0, pageSize, count * pageSize);
    const raised = Buffer.alloc(4);
    raised.writeUInt32BE(count + 1);
    writeSync(fd, raised, 0, 4, 28);
  } finally {
    closeSync(fd);
  }
}

/** What the c8a3 cells assert of a report: whether its version is there, and the rest. */
function verdict(r: CheckReport): Record<string, unknown> {
  return {
    status: r.status,
    schema_version: 'schema_version' in r ? r.schema_version : 'absent',
    findings: r.findings,
    not_run: r.not_run,
  };
}

const NOT_WRITABLE = {
  check: 'writable',
  code: 'not_writable',
  message:
    'Realm cannot write to this file or its folder: every other command that opens this store, reads included, is refused until it can, except the checks that only look at it.',
};
const newer = (n: number, m: number): Record<string, unknown> => ({
  check: 'version',
  code: 'newer_version',
  message: `Written by a later version of Realm (schema version ${String(n)}; this version reads up to ${String(m)}).`,
});
const stopped = (because: string, ...checks: string[]): Array<Record<string, unknown>> =>
  checks.map((c) => ({ check: c, because }));
const metaRow = (because: string): Record<string, unknown> => ({
  check: 'settings',
  because,
  part: 'meta row',
});

describe('#616 PR-2c c8a3 — check 1: one cell per code', () => {
  it('header_damaged — a store file of non-database bytes', async () => {
    const home = join(tmp(), '.realm');
    mkdirSync(home);
    writeFileSync(join(home, 'realm.db'), Buffer.alloc(8192, 0x41));
    // (1) red when the branch is removed or turned back into a refusal (the check rejects), or the
    //     checks it stops are not listed; (2) prints the report's parts.
    expect(verdict(await check(home))).toEqual({
      status: 'findings',
      schema_version: 'absent',
      findings: [
        {
          check: 'header',
          code: 'header_damaged',
          message:
            'The file is not a readable SQLite database: its header or schema cannot be read.',
        },
      ],
      not_run: stopped('header_damaged', 'version', 'schema', 'settings', 'integrity'),
    });
  });

  it("newer_version — user_version raised (check 3's newer half: the meta row's part)", async () => {
    const home = await storeHome();
    rawly(home, 'PRAGMA user_version = 2');
    // (1) red when the branch is removed or turned back into a refusal, or the schema or the meta
    //     row's part is not listed; (2) prints the report's parts.
    expect(verdict(await check(home))).toEqual({
      status: 'findings',
      schema_version: 2,
      findings: [newer(2, 1)],
      not_run: [...stopped('newer_version', 'schema'), metaRow('newer_version')],
    });
  });

  it("older_version — a version-1 file under a Realm writing version 2 (the ladder's fixture)", async () => {
    const home = await storeHome();
    const report = await check(home, { schemaVersion: 2, versions: ladder() });
    // (1) red when the branch is removed or turned back into a refusal, or the schema is not held to
    //     version 1's (it would differ); (2) prints the report's parts and the versions.
    expect({ ...verdict(report), reads_up_to: report.reads_up_to }).toEqual({
      status: 'findings',
      schema_version: 1,
      findings: [
        {
          check: 'version',
          code: 'older_version',
          message:
            'Written by an earlier version: schema version 1; this version needs 2; run `realm db migrate`.',
        },
      ],
      not_run: [],
      reads_up_to: 2,
    });
  });

  it("version_unknown 0 — the file a first open leaves after its switch to WAL (c8a1's check 2 member): with the application id's entry, the file unchanged", async () => {
    const home = join(tmp(), '.realm');
    mkdirSync(home);
    const raw = openDatabase(join(home, 'realm.db'));
    raw.exec('PRAGMA journal_mode = WAL');
    raw.close();
    const file = readFileSync(join(home, 'realm.db'));
    const report = await check(home);
    // (1) red when the version 0 branch is removed, the application id is not judged in check mode,
    //     or the file is set up; (2) prints the report's parts and whether the file changed.
    expect({
      ...verdict(report),
      unchanged: file.equals(readFileSync(join(home, 'realm.db'))),
    }).toEqual({
      status: 'findings',
      schema_version: 0,
      findings: [
        {
          check: 'version',
          code: 'version_unknown',
          message:
            "The file's schema version is 0: it was never set up (a first open was interrupted) or it is not a Realm store.",
        },
        {
          check: 'settings',
          code: 'settings_differ',
          message: 'A store setting differs: application_id is 0, expected 1380270412.',
        },
        // This raw file never set auto_vacuum, as the first open does before its switch to WAL.
        {
          check: 'settings',
          code: 'settings_differ',
          message: 'A store setting differs: auto_vacuum is 0, expected 2.',
        },
      ],
      not_run: [...stopped('version_unknown', 'schema'), metaRow('version_unknown')],
      unchanged: true,
    });
  });

  it('version_unknown — another value no version writes (-3)', async () => {
    const home = await storeHome();
    rawly(home, 'PRAGMA user_version = -3');
    // (1) red when the branch is removed or turned back into a refusal; (2) prints the report's parts.
    expect(verdict(await check(home))).toEqual({
      status: 'findings',
      schema_version: -3,
      findings: [
        {
          check: 'version',
          code: 'version_unknown',
          message: "The file's schema version is -3, which no version of Realm writes.",
        },
      ],
      not_run: [...stopped('version_unknown', 'schema'), metaRow('version_unknown')],
    });
  });

  it('settings_differ — the meta row deleted, its table and the trigger guarding it as they were', async () => {
    const home = await storeHome();
    const c = openDatabase(join(home, 'realm.db'));
    const trigger = String(
      c.prepare("SELECT sql FROM sqlite_master WHERE name = 'store_meta_no_delete'").get()?.['sql'],
    );
    c.exec('DROP TRIGGER store_meta_no_delete');
    c.exec('DELETE FROM store_meta');
    c.exec(trigger);
    c.close();
    // (1) red when the missing row is not a finding, or its part of settings is not listed; (2)
    //     prints the report's parts.
    expect(verdict(await check(home))).toEqual({
      status: 'findings',
      schema_version: 1,
      findings: [
        {
          check: 'settings',
          code: 'settings_differ',
          message: 'A store setting differs: meta row is absent, expected one row.',
        },
      ],
      not_run: [metaRow('settings_differ')],
    });
  });

  it('schema_differs — a trigger dropped', async () => {
    const home = await storeHome();
    rawly(home, 'DROP TRIGGER runs_insert_once');
    // (1) red when the branch is removed or turned back into a refusal; (2) prints the report's parts.
    expect(verdict(await check(home))).toEqual({
      status: 'findings',
      schema_version: 1,
      findings: [
        {
          check: 'schema',
          code: 'schema_differs',
          message: "The schema differs from schema version 1's: missing trigger runs_insert_once.",
        },
      ],
      not_run: [],
    });
  });

  it('settings_differ — journal_mode=DELETE, and no WAL frames to count (check 4b)', async () => {
    const home = await storeHome();
    rawly(home, 'PRAGMA journal_mode = DELETE');
    const report = await check(home);
    // (1) red when the setting is not a finding, or the frame counts are not absent with no WAL;
    //     (2) prints the report's parts and the two counts.
    expect({
      ...verdict(report),
      frames: [report.facts.wal_frames, report.facts.wal_frames_copied],
    }).toEqual({
      status: 'findings',
      schema_version: 1,
      findings: [
        {
          check: 'settings',
          code: 'settings_differ',
          message: 'A store setting differs: journal_mode is delete, expected wal.',
        },
      ],
      not_run: [],
      frames: [undefined, undefined],
    });
  });

  it.skipIf(AS_ROOT)(
    'not_writable — a 0444 store file in a writable folder, which still reads',
    async () => {
      const home = await storeHome();
      lock(join(home, 'realm.db'), 0o444, 0o644);
      // (1) red when the write question is not asked in check mode, or is refused; (2) prints the
      //     report's parts.
      expect(verdict(await check(home))).toEqual({
        status: 'findings',
        schema_version: 1,
        findings: [NOT_WRITABLE],
        not_run: [],
      });
    },
  );

  it("open_failed — SQLite's own error at the connection (the open's seam), unmapped", async () => {
    const home = await storeHome();
    // A real SQLite error: a read-only open of a file that is not there (14).
    let error: unknown;
    try {
      openDatabase(join(tmp(), 'absent.db'), { readOnly: true });
    } catch (err) {
      error = err;
    }
    const openFile = (): DatabaseLike => {
      throw error;
    };
    // (1) red when the branch is removed or the error is mapped first (STATE_STORE_READONLY's
    //     text); (2) prints the report's parts.
    expect(verdict(await check(home, { openFile }))).toEqual({
      status: 'findings',
      schema_version: 'absent',
      findings: [
        {
          check: 'open',
          code: 'open_failed',
          message:
            'SQLite could not open the file: unable to open database file (SQLite error 14).',
        },
      ],
      not_run: stopped('open_failed', 'header', 'version', 'schema', 'settings', 'integrity'),
    });
  });
});

describe('#616 PR-2c c8a3 — checks 2 and 3: a read-only folder, a dropped meta table', () => {
  it.skipIf(AS_ROOT)(
    "check 2: a 0555 folder holding a cleanly closed store, no side files — not_writable and open_failed in SQLite's 1544 words",
    async () => {
      const home = await storeHome();
      lock(home, 0o555, 0o755);
      // (1) red when SQLite's error is mapped first (STATE_STORE_READONLY's text), or the write
      //     question is not asked; (2) prints the report's parts.
      expect(verdict(await check(home))).toEqual({
        status: 'findings',
        schema_version: 'absent',
        findings: [
          {
            check: 'open',
            code: 'open_failed',
            message:
              'SQLite could not open the file: attempt to write a readonly database (SQLite error 1544).',
          },
          NOT_WRITABLE,
        ],
        not_run: stopped('open_failed', 'header', 'version', 'schema', 'settings', 'integrity'),
      });
    },
  );

  it("check 3: the meta table dropped — schema_differs, and settings' meta row part", async () => {
    const home = await storeHome();
    rawly(home, 'DROP TABLE store_meta');
    // (1) red when settings is skipped whole or reported as run in full; (2) prints the parts.
    expect(verdict(await check(home))).toEqual({
      status: 'findings',
      schema_version: 1,
      findings: [
        {
          check: 'schema',
          code: 'schema_differs',
          // Dropping the table drops its triggers too.
          message:
            "The schema differs from schema version 1's: missing table store_meta, trigger store_meta_insert_once, trigger store_meta_no_delete, trigger store_meta_immutable, trigger store_meta_forward, trigger store_meta_insert_types, trigger store_meta_update_types.",
        },
      ],
      not_run: [metaRow('schema_differs')],
    });
  });
});

describe('#616 PR-2c c8a3 — check 4: still refused in check mode, no handle', () => {
  it.each(['folder', 'old store', 'connection setting', 'meta page'] as const)(
    '%s',
    async (state) => {
      let home: string;
      const seams: Record<string, unknown> = {};
      let expected: Record<string, unknown>;
      if (state === 'folder') {
        home = join(tmp(), '.realm');
        mkdirSync(join(home, 'realm.db'), { recursive: true });
        const path = join(home, 'realm.db');
        expected = {
          code: 'STATE_STORE_SETTINGS_REFUSED',
          message: `The store file ${path} is not a Realm store this Realm can use: it is a directory. Realm does not change or replace a store file by itself.`,
        };
      } else if (state === 'old store') {
        // The old JSON store's `runs` folder where the open placed its fence file.
        home = await storeHome();
        rmSync(join(home, 'runs'));
        mkdirSync(join(home, 'runs'));
        expected = { code: 'STATE_HOME_HOLDS_LEGACY_STORE' };
      } else if (state === 'connection setting') {
        home = await storeHome();
        // The real read-only connection, on which `synchronous` reads back 0.
        seams['openFile'] = (path: string, options?: { readonly readOnly: true }): DatabaseLike => {
          const real = openDatabase(path, options);
          return {
            exec: (sql: string) => real.exec(sql),
            prepare: (sql: string) =>
              sql === 'PRAGMA synchronous'
                ? ({ get: () => ({ synchronous: 0 }) } as unknown as ReturnType<
                    DatabaseLike['prepare']
                  >)
                : real.prepare(sql),
            close: () => real.close(),
            get isTransaction() {
              return real.isTransaction;
            },
          };
        };
        const path = join(home, 'realm.db');
        expected = {
          code: 'STATE_STORE_SETTINGS_REFUSED',
          message: `The store file ${path} is not a Realm store this Realm can use: the connection setting synchronous reads 0 after Realm set it to FULL. Realm does not change or replace a store file by itself.`,
        };
      } else {
        // The meta table's root page overwritten: only its one row lives there.
        home = await storeHome();
        const file = join(home, 'realm.db');
        const raw = openDatabase(file, { readOnly: true });
        const root = Number(
          raw.prepare("SELECT rootpage FROM sqlite_master WHERE name = 'store_meta'").get()?.[
            'rootpage'
          ],
        );
        const pageSize = Number(raw.prepare('PRAGMA page_size').get()?.['page_size']);
        raw.close();
        const fd = openSync(file, 'r+');
        writeSync(fd, Buffer.alloc(pageSize, 0x5a), 0, pageSize, (root - 1) * pageSize);
        closeSync(fd);
        expected = {
          code: 'STATE_STORE_SETTINGS_REFUSED',
          message: `The store file ${file} is not a Realm store this Realm can use: it is damaged (SQLite: database disk image is malformed). Realm does not change or replace a store file by itself.`,
        };
      }
      const got = await refusal(openMaintenance({ home, verb: 'check' }, seams));
      // (1) red when check mode reads a non-file as the store, skips the guard, turns the setting or
      //     the meta row's damage into a finding (a handle resolves), or reads that damage as
      //     header_damaged; (2) prints the refusal.
      expect({
        code: got['code'],
        ...('message' in expected ? { message: got['message'] } : {}),
      }).toEqual(expected);
    },
  );
});

describe('#616 PR-2c c8a3 — check 4c: usable and blockedBy, read as a second caller would', () => {
  type State = 'healthy' | 'newer' | 'schema differs' | 'newer, not writable';
  const expected: Record<State, Record<string, unknown>> = {
    healthy: { usable: true, blockedBy: 'absent', kinds: [] },
    newer: { usable: false, blockedBy: 'newer_version', kinds: ['newer_version'] },
    'schema differs': { usable: false, blockedBy: 'schema_differs', kinds: ['schema_differs'] },
    'newer, not writable': {
      usable: false,
      blockedBy: 'newer_version',
      kinds: ['not_writable', 'newer_version'],
    },
  };
  async function opened(state: State): Promise<Record<string, unknown>> {
    const home = await storeHome();
    if (state === 'newer' || state === 'newer, not writable') {
      rawly(home, 'PRAGMA user_version = 2');
    }
    if (state === 'schema differs') rawly(home, 'DROP TRIGGER runs_insert_once');
    if (state === 'newer, not writable') lock(join(home, 'realm.db'), 0o444, 0o644);
    const file = await openForCheck(home, { clock: systemClock });
    file.db?.close();
    return {
      usable: file.usable,
      blockedBy: 'blockedBy' in file ? file.blockedBy : 'absent',
      kinds: file.outcomes.map((o) => o.kind),
    };
  }
  // (1) red when `usable` is true on a newer file, or `blockedBy` is the first outcome of any kind
  //     (not_writable), or is there while `usable` is true; (2) prints both and the outcomes' kinds.
  it.each(['healthy', 'newer', 'schema differs'] as const)('%s', async (state) => {
    expect(await opened(state)).toEqual(expected[state]);
  });
  it.skipIf(AS_ROOT)('newer, not writable (a 0444 file in a writable folder)', async () => {
    expect(await opened('newer, not writable')).toEqual(expected['newer, not writable']);
  });
});

describe('#616 PR-2c c8a3 — check 5: one report holding newer_version, not_writable and integrity_failed', () => {
  it.skipIf(AS_ROOT)('the three findings together, each with its checks stopped', async () => {
    const home = await storeHome();
    rawly(home, 'PRAGMA user_version = 2');
    neverUsedPage(home);
    lock(join(home, 'realm.db'), 0o444, 0o644);
    const report = await check(home);
    // (1) red when one of the three is lost beside the others, or the integrity check does not run
    //     on a newer file; (2) prints the codes and not_run.
    expect({ codes: report.findings.map((f) => f.code), not_run: report.not_run }).toEqual({
      codes: ['newer_version', 'not_writable', 'integrity_failed'],
      not_run: [...stopped('newer_version', 'schema'), metaRow('newer_version')],
    });
  });
});

describe("#616 PR-2c c8a1, c8a3 — the contract's laws, over every report the cells built", () => {
  // #616 PR-2c c8a3: c8a1's check 8 holds check 5's laws now (not_run is no longer always empty).
  it("check 5 (c8a1's check 8): every code and because is a listed one, every because names a finding in its report, not_run is never non-empty without a finding, a part only on a partly-run check, and the status follows", () => {
    expect(built.length).toBeGreaterThan(0);
    const codes = CHECK_FINDING_CODES as readonly string[];
    const ids = CHECK_IDS as readonly string[];
    // (1) red when a report carries a check or a code outside the module's lists, a not_run entry
    //     whose because is no finding of its report, not_run without a finding, a part beside a
    //     whole entry of the same check, or a status the rule does not give; (2) prints each
    //     report's violations, with its codes.
    expect(
      built.map((r) => {
        const found = r.findings.map((f) => f.code as string);
        return {
          codes: found,
          outside: [
            ...r.findings.filter((f) => !codes.includes(f.code) || !ids.includes(f.check)),
            ...r.not_run.filter((n) => !codes.includes(n.because) || !ids.includes(n.check)),
          ].map((x) => JSON.stringify(x)),
          becauseNotFound: r.not_run.filter((n) => !found.includes(n.because)).map((n) => n.check),
          notRunWithoutFinding: r.not_run.length > 0 && r.findings.length === 0,
          partOnAWholeCheck: r.not_run
            .filter((n) => n.part !== undefined)
            .filter((n) => r.not_run.some((m) => m.check === n.check && m.part === undefined))
            .map((n) => n.check),
          status:
            r.status === (r.findings.length === 0 && r.not_run.length === 0 ? 'ok' : 'findings'),
        };
      }),
    ).toEqual(
      built.map((r) => ({
        codes: r.findings.map((f) => f.code),
        outside: [],
        becauseNotFound: [],
        notRunWithoutFinding: false,
        partOnAWholeCheck: [],
        status: true,
      })),
    );
  });
});
