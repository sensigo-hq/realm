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
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REALM_STORE_APPLICATION_ID } from '@sensigo/realm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createSqliteLoader, openDatabase, type DatabaseLike } from './driver.js';
import { SYSTEM_PROBE } from './filesystem-gate.js';
import { openRealmHome, type RealmHome } from './index.js';
import { openMaintenance } from './maintenance.js';
import {
  CHECK_FINDING_CODES,
  CHECK_IDS,
  INTEGRITY_CHECK_LIMIT,
  type CheckReport,
} from './store-check.js';
import { openForeignConnection } from './test-support/foreign-connection.js';

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
  it.each(['link', 'floor', 'network', 'uninitialised'] as const)('check 2: %s', async (state) => {
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
    } else if (state === 'network') {
      home = await storeHome();
      seams['probe'] = { ...SYSTEM_PROBE, platform: 'linux', env: {}, statfsType: () => 0x6969 };
      expected = { code: 'STATE_STORE_FILESYSTEM_REFUSED' };
    } else {
      // The file a first open stopped after its switch to WAL leaves (AUD-C8A1-14): no store in it.
      home = join(tmp(), '.realm');
      mkdirSync(home);
      const raw = openDatabase(join(home, 'realm.db'));
      raw.exec('PRAGMA journal_mode = WAL');
      raw.close();
      const path = join(home, 'realm.db');
      expected = {
        code: 'STATE_STORE_SETTINGS_REFUSED',
        message:
          `The store file ${path} is not a Realm store this Realm can use: its application id is ` +
          `0, not Realm's ${String(REALM_STORE_APPLICATION_ID)}. Realm does not change or ` +
          'replace a store file by itself.',
      };
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
  it('check 6: a healthy home — ok, nothing found, the three not-checked entries, and every fact present with its type', async () => {
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
      not_checked: ['other_processes', 'refused_files', 'data_checks'],
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

describe("#616 PR-2c c8a1 — the contract's laws, over every report the cells built", () => {
  it('check 8: every finding is a listed check and code, the status follows the findings, and nothing is not_run', () => {
    expect(built.length).toBeGreaterThan(0);
    // (1) red when a report carries a check or a code outside the module's lists, a status the
    //     rule does not give, or a not_run entry; (2) prints each report's violations.
    expect(
      built.map((r) => ({
        outside: r.findings
          .filter(
            (f) =>
              !(CHECK_FINDING_CODES as readonly string[]).includes(f.code) ||
              !(CHECK_IDS as readonly string[]).includes(f.check),
          )
          .map((f) => `${f.check}/${f.code}`),
        status:
          r.status === (r.findings.length === 0 && r.not_run.length === 0 ? 'ok' : 'findings'),
        not_run: r.not_run.length,
      })),
    ).toEqual(built.map(() => ({ outside: [], status: true, not_run: 0 })));
  });
});
