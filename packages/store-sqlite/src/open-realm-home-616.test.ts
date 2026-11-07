// open-realm-home-616.test.ts — issue #616 PR-1a unit 11: `openRealmHome`, the package's entry, on real
// homes in a temp directory. The real cases: a host (an MCP server, `realm serve`) that opens the same
// home from several places at once, or through a symbolic link (macOS's temp folder is one); a first
// open refused (an old store, a network drive, an old Node) that the user fixes and retries in the same
// process; a test location's clock file; a test that passes its own clock to a home something else
// already opened; callers that share a handle each closing it; a second package that re-exports the
// opener (two caches, two connections on one file); and the package README's sentences, each tied to
// the behaviour it states.
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  deriveRunPhase,
  WorkflowError,
  writeTestClockFile,
  type Clock,
  type EvidenceSnapshot,
  type RunRecord,
} from '@sensigo/realm';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { RealmDb } from './connection.js';
import { createSqliteLoader, openDatabase, type DatabaseLike } from './driver.js';
import { SYSTEM_PROBE } from './filesystem-gate.js';
import { DATABASE_FILE } from './home.js';
import { openRealmHome } from './index.js';
import type { OpenSeams } from './open-file.js';
import { openHome, type RealmHome } from './open-realm-home.js';
import { insertRunRecord } from './run-rows.js';
import { openForeignConnection } from './test-support/foreign-connection.js';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = join(PACKAGE_ROOT, '..', '..');

/** A caller's own clock: a fixed instant, so a stamp shows which clock made it. */
const AT = '2001-02-03T04:05:06.789Z';
const clock: Clock = { now: () => new Date(AT), at: () => () => undefined };
/** A second clock, another object with the same answers. */
const otherClock: Clock = { now: () => new Date(AT), at: () => () => undefined };
/** The instant of a test clock file. */
const FILE_AT = '2002-03-04T05:06:07.890Z';
/**
 * How far a stamp from the system clock may lie outside the cell's own readings: this machine's
 * clock has stepped back about a second at a time (HEAVY-RUN-RULE, "The clock").
 */
const SLACK_MS = 2_000;

const dirs: string[] = [];
const handles: RealmHome[] = [];
const connections: DatabaseLike[] = [];
afterEach(() => {
  for (const c of connections.splice(0)) {
    try {
      c.close();
    } catch {
      // closed by its cell
    }
  }
  for (const h of handles.splice(0)) h.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'realm-616-u11-'));
  dirs.push(dir);
  return dir;
}

/** A handle the cleanup closes if its cell does not. */
async function track(opening: Promise<RealmHome>): Promise<RealmHome> {
  const handle = await opening;
  handles.push(handle);
  return handle;
}

/** A refusal as a reader sees it: a typed refusal's code, or a plain error's message. */
function describeError(err: unknown): string {
  return err instanceof WorkflowError
    ? err.code
    : `${(err as Error).name}: ${(err as Error).message}`;
}

/**
 * What a call to the opener does, telling a synchronous throw from a rejection: `'opened'` (the
 * handle is closed again), `{ rejected }` or `{ thrownSynchronously }`.
 */
async function settle(call: () => Promise<RealmHome>): Promise<unknown> {
  let opening: Promise<RealmHome>;
  try {
    opening = call();
  } catch (err) {
    return { thrownSynchronously: describeError(err) };
  }
  try {
    (await opening).close();
    return 'opened';
  } catch (err) {
    return { rejected: describeError(err) };
  }
}

/** What a synchronous call does: `'no error'`, or the error as a reader sees it. */
function settleSync(call: () => void): string {
  try {
    call();
    return 'no error';
  } catch (err) {
    return describeError(err);
  }
}

/** The open's seams with a counter of the connections it opens on the store file. */
function counting(): { seams: OpenSeams; opened: () => number } {
  let n = 0;
  return {
    seams: {
      openFile: (path) => {
        n += 1;
        return openDatabase(path);
      },
    },
    opened: () => n,
  };
}

async function foreign(home: string): Promise<DatabaseLike> {
  const c = await openForeignConnection(home);
  connections.push(c);
  return c;
}

/** The store's meta row's `created_at`: the instant its first open stamped. */
async function createdAt(home: string): Promise<string> {
  const c = await foreign(home);
  return String(c.prepare('SELECT created_at FROM store_meta').get()?.['created_at']);
}

/** Whether an instant read from the system clock lies within the cell's own readings. */
function withinSystemClock(stamp: string, before: number, after: number): boolean {
  const ms = Date.parse(stamp);
  return ms >= before - SLACK_MS && ms <= after + SLACK_MS;
}

/** A finished run record in the real key order, its phase what the derivation says. */
function finishedRun(id: string, params: Record<string, unknown>): RunRecord {
  const record: Record<string, unknown> = {
    id,
    workflow_id: 'support-reply',
    workflow_version: 3,
    completed_steps: ['classify'],
    in_progress_steps: [],
    failed_steps: [],
    skipped_steps: [],
    run_phase: 'running',
    version: 4,
    params,
    evidence: [] as EvidenceSnapshot[],
    created_at: '2026-11-06T09:00:00.000Z',
    updated_at: '2026-11-06T09:00:05.000Z',
    terminal_state: true,
    terminal_reason: 'completed',
    claims: {},
    extension_identity: [],
    skip_details: {},
  };
  record['run_phase'] = deriveRunPhase(record as unknown as RunRecord);
  return record as unknown as RunRecord;
}

/** Writes and then deletes a run on a connection, each in its own write transaction. */
function writeThenDelete(c: DatabaseLike, record: RunRecord): void {
  c.exec('BEGIN IMMEDIATE');
  insertRunRecord(c, record);
  c.exec('COMMIT');
  c.exec('BEGIN IMMEDIATE');
  // The file's guards: the run row first, then what hangs off it.
  c.prepare('DELETE FROM runs WHERE id = ?').run(record.id);
  c.prepare('DELETE FROM evidence WHERE run_id = ?').run(record.id);
  c.prepare('DELETE FROM run_blobs WHERE run_id = ?').run(record.id);
  c.exec('COMMIT');
}

/** The package README, its whitespace folded, and whether it carries a sentence. */
const README = readFileSync(join(PACKAGE_ROOT, 'README.md'), 'utf8').replace(/\s+/g, ' ');
const says = (sentence: string): boolean => README.includes(sentence);

/** The README's sentences, each with the cell below that pins its behaviour. */
const SENTENCES = {
  opens:
    '`openRealmHome({ home, clock })` opens a Realm home and resolves to a handle with `runStore`, `dedupStoreFor`, `workflowStore`, `failedAttemptStore`, `replayStore`, `traceBufferStore` and `close()`.',
  shared:
    'Callers in one process that open the same home share one handle and one connection, so a `close()` by any of them ends it for all.',
  file: 'Realm keeps run records in one SQLite file, `realm.db`, in the Realm home. Never delete, move or replace `realm.db` or its side files `realm.db-wal` and `realm.db-shm` while a Realm process is running.',
  deleted:
    "Text of a deleted run may stay readable in `realm.db`'s free pages and in `realm.db-wal` until the file is vacuumed and checkpointed (purge, a later unit, does both).",
  foreignDelete:
    "One exception to Realm stamping every time itself: a run deleted by SQL outside Realm is stamped with SQLite's own clock.",
  filesystem:
    "Realm refuses a home on a network drive or on a filesystem it does not recognise, including WSL's `/mnt/c`, because SQLite's write-ahead log does not work there. Set `REALM_STORE_FS=local` to use such a folder anyway.",
  floors:
    "The store uses Node's built-in SQLite, which Node 22 labels as in development and Node 24.15.0 and later as a release candidate. Realm needs Node 22.22.3 or a later 22.x release, or Node 24.15.0 or later: the releases that carry the fix for SQLite's WAL-reset bug.",
} as const;

/** The gate's probe of this machine, with the filesystem answering WSL's `/mnt/c` (9p). */
const NINE_P = { ...SYSTEM_PROBE, platform: 'linux', env: {}, statfsType: () => 0x01021997 };

/** The loader's version check on a Node whose built-in answers `version` (an in-memory database). */
function loaderReporting(version: string, nodeVersion: string): () => { version: string } {
  const loader = createSqliteLoader({
    loadBuiltin: () => ({
      DatabaseSync: class {
        prepare() {
          return { get: () => ({ v: version }) };
        }
        close() {}
      },
    }),
    nodeVersion,
  });
  return () => loader.load();
}

describe('#616 unit 11 — one connection per home per process', () => {
  it('check 1: two concurrent first opens of a home share one open and one connection; a later call shares it; after close() the next call opens afresh', async () => {
    const home = join(tmp(), '.realm');
    const { seams, opened } = counting();
    const [a, b] = await Promise.all([
      track(openHome({ home, clock }, seams)),
      track(openHome({ home, clock }, seams)),
    ]);
    const later = await openHome({ home, clock }, seams);
    const opensWhileOpen = opened();
    a.close();
    const afresh = await track(openHome({ home, clock }, seams));
    // (1) red when the opens are not cached (each call its own open: two handles, three connections
    //     while open), when the cache is keyed per call or the pending open is not shared (the two
    //     first callers race to two connections), or when close() does not let go of the home (the
    //     next call gets the closed handle); (2) prints which handles are the same object and the
    //     connections opened on the file.
    expect({
      concurrentShare: a === b,
      laterShares: later === a,
      opensWhileOpen,
      afreshIsNew: afresh !== a,
      opensAfterClose: opened(),
    }).toEqual({
      concurrentShare: true,
      laterShares: true,
      opensWhileOpen: 1,
      afreshIsNew: true,
      opensAfterClose: 2,
    });
  });

  it('a home not made yet, reached through a symbolic link and through its real path, is one home: its key is the real path of the folder above plus the rest', async () => {
    const real = join(tmp(), 'real');
    mkdirSync(real);
    const link = join(tmp(), 'link');
    symlinkSync(real, link);
    const [viaLink, viaReal] = await Promise.all([
      track(openRealmHome({ home: join(link, '.realm') })),
      track(openRealmHome({ home: join(real, '.realm') })),
    ]);
    const afterMade = await openRealmHome({ home: join(link, '.realm') });
    // (1) red when the cache keys a home by the path as given (two handles and two connections on
    //     one file), or keys a home that does not exist yet by anything but its folder's real path
    //     plus the rest; (2) prints whether the handles are the same object.
    expect({ concurrent: viaLink === viaReal, afterMade: afterMade === viaReal }).toEqual({
      concurrent: true,
      afterMade: true,
    });
  });

  it('a refused first open is not cached: after the user moves the old store out, the next call in the same process opens the home', async () => {
    const home = join(tmp(), '.realm');
    mkdirSync(join(home, 'runs'), { recursive: true });
    const refused = await settle(() => openRealmHome({ home }));
    rmSync(join(home, 'runs'), { recursive: true });
    const retried = await settle(() => openRealmHome({ home }));
    // (1) red when a failed open stays in the cache (the retry gets the same refusal); (2) prints
    //     both outcomes.
    expect({ refused, retried }).toEqual({
      refused: { rejected: 'STATE_HOME_HOLDS_LEGACY_STORE' },
      retried: 'opened',
    });
  });
});

describe('#616 unit 11 — refusals are rejections', () => {
  it('check 2: every refusal is a rejected promise, never a synchronous throw, and the open’s refusals pass through unchanged', async () => {
    const legacy = join(tmp(), '.realm');
    mkdirSync(join(legacy, 'runs'), { recursive: true });
    const aFile = join(tmp(), 'realm-home-file');
    writeFileSync(aFile, 'not a folder\n');
    // A test clock file made for another folder, copied into this home.
    const elsewhere = tmp();
    await writeTestClockFile(elsewhere, new Date(FILE_AT));
    const copied = join(tmp(), '.realm');
    mkdirSync(copied);
    copyFileSync(join(elsewhere, '.realm-test-clock'), join(copied, '.realm-test-clock'));
    const openWithClock = join(tmp(), '.realm');
    await track(openRealmHome({ home: openWithClock, clock }));
    // What the open itself says for a home that is a file and one under a file (no openRealmHome).
    const underAFile = join(aFile, '.realm');
    const direct = async (home: string): Promise<string> => {
      try {
        (await RealmDb.open(home, { clock })).close();
        return 'opened';
      } catch (err) {
        return describeError(err);
      }
    };
    const opens = { isAFile: await direct(aFile), underAFile: await direct(underAFile) };
    const outcomes = {
      relativeHome: await settle(() => openRealmHome({ home: 'relative/.realm' })),
      homeIsAFile: await settle(() => openRealmHome({ home: aFile })),
      homeUnderAFile: await settle(() => openRealmHome({ home: underAFile })),
      legacyHome: await settle(() => openRealmHome({ home: legacy })),
      networkDrive: await settle(() =>
        openHome({ home: join(tmp(), '.realm') }, { probe: NINE_P }),
      ),
      sqliteBelowFloor: await settle(() =>
        openHome(
          { home: join(tmp(), '.realm') },
          { loadSqlite: loaderReporting('3.51.2', 'v24.14.1') },
        ),
      ),
      foreignClockFile: await settle(() => openRealmHome({ home: copied })),
      anotherClock: await settle(() => openRealmHome({ home: openWithClock, clock: otherClock })),
    };
    // (1) red when the opener throws synchronously (its own steps run before it returns a promise:
    //     the relative home and the other clock are then thrown), or when something before the open
    //     answers for a home that is a file or under one (the clock file's reader, when it counts
    //     only ENOENT as absent: "cannot be read (ENOTDIR)"), or when the opener maps or rewords the
    //     open's refusals; (2) prints each case's outcome and what the open itself says.
    expect({ outcomes, opens }).toEqual({
      outcomes: {
        relativeHome: { rejected: 'STATE_HOME_UNUSABLE' },
        homeIsAFile: { rejected: opens.isAFile },
        homeUnderAFile: { rejected: opens.underAFile },
        legacyHome: { rejected: 'STATE_HOME_HOLDS_LEGACY_STORE' },
        networkDrive: { rejected: 'STATE_STORE_FILESYSTEM_REFUSED' },
        sqliteBelowFloor: { rejected: 'STATE_STORE_DRIVER_UNAVAILABLE' },
        foreignClockFile: { rejected: 'STATE_TEST_CLOCK_FOREIGN' },
        anotherClock: {
          rejected: `Error: The Realm home ${openWithClock} is already open in this process with another clock; close it first.`,
        },
      },
      // The open's own answers: the home's preparation refuses a home that is a file; the
      // filesystem gate's lstat of a home under a file fails ENOTDIR, passed up with its code
      // (unit 5's rule).
      opens: {
        isAFile: 'STATE_STORE_READONLY',
        underAFile: expect.stringMatching(/^Error: ENOTDIR: not a directory, lstat /),
      },
    });
  });
});

describe("#616 unit 11 — the home's clock", () => {
  it('check 3: a home with a test clock file stamps from the file; a home without one, from the system clock', async () => {
    const withFile = join(tmp(), '.realm');
    mkdirSync(withFile);
    await writeTestClockFile(withFile, new Date(FILE_AT));
    (await openRealmHome({ home: withFile })).close();
    const without = join(tmp(), '.realm');
    const before = Date.now();
    (await openRealmHome({ home: without })).close();
    const after = Date.now();
    const systemStamp = await createdAt(without);
    // (1) red when the opener ignores the home's clock file (the stamp is the system's time) or
    //     reads a clock file when there is none; (2) prints the file home's stamp and the other's.
    expect({
      withFile: await createdAt(withFile),
      without: withinSystemClock(systemStamp, before, after) ? 'the system clock' : systemStamp,
    }).toEqual({ withFile: FILE_AT, without: 'the system clock' });
  });

  it('a caller with another clock than the one the home is open with is refused, naming the home; so is a clock brought to a home opened on its default clock', async () => {
    const home = join(tmp(), '.realm');
    await track(openRealmHome({ home, clock }));
    const onDefault = join(tmp(), '.realm');
    await track(openRealmHome({ home: onDefault }));
    // (1) red when the opener ignores the clock (the caller silently gets the first caller's
    //     handle and every stamp from the first clock), or compares the clock with the default one
    //     it resolved (the clock is then shared with a home on the system clock); (2) prints each
    //     outcome.
    expect({
      other: await settle(() => openRealmHome({ home, clock: otherClock })),
      onDefault: await settle(() => openRealmHome({ home: onDefault, clock })),
    }).toEqual({
      other: {
        rejected: `Error: The Realm home ${home} is already open in this process with another clock; close it first.`,
      },
      onDefault: {
        rejected: `Error: The Realm home ${onDefault} is already open in this process with another clock; close it first.`,
      },
    });
  });

  it('a caller with another clock while the first open is still pending is refused; the first open completes', async () => {
    const home = join(tmp(), '.realm');
    const first = openRealmHome({ home, clock });
    const second = await settle(() => openRealmHome({ home, clock: otherClock }));
    const firstHandle = await track(first);
    // (1) red when the pending open's clock is not compared (the second caller shares the pending
    //     open); (2) prints the second caller's outcome and whether the first opened.
    expect({ second, firstOpened: typeof firstHandle.close }).toEqual({
      second: {
        rejected: `Error: The Realm home ${home} is already open in this process with another clock; close it first.`,
      },
      firstOpened: 'function',
    });
  });

  it('a caller with the same clock object shares the home', async () => {
    const home = join(tmp(), '.realm');
    const first = await track(openRealmHome({ home, clock }));
    const again = await openRealmHome({ home, clock });
    // (1) red when any caller bringing a clock is refused (the check tests that a clock was given
    //     rather than which); (2) prints whether the handles are the same object.
    expect(again === first).toBe(true);
  });

  it('a caller with no clock shares a home that was opened with a clock', async () => {
    const home = join(tmp(), '.realm');
    const first = await track(openRealmHome({ home, clock }));
    const again = await openRealmHome({ home });
    // (1) red when a caller with no clock is compared too (no clock is not the opener's clock, so
    //     it would be refused); (2) prints whether the handles are the same object.
    expect(again === first).toBe(true);
  });
});

describe('#616 unit 11 — close()', () => {
  it('a second close() of a handle does nothing, and an old handle closed again leaves a newer open of the home cached', async () => {
    const home = join(tmp(), '.realm');
    const old = await openRealmHome({ home });
    old.close();
    const secondClose = settleSync(() => old.close());
    const newer = await track(openRealmHome({ home }));
    const oldAgain = settleSync(() => old.close());
    const shared = await openRealmHome({ home });
    // (1) red when close() is not idempotent (a second close reaches SQLite's "database is not
    //     open"), or when an old handle's close lets go of a newer open's cache entry (the next call
    //     then opens a third connection beside the newer one); (2) prints each close's outcome and
    //     whether the newer handle is still the one callers get.
    expect({ secondClose, oldAgain, newerShared: shared === newer }).toEqual({
      secondClose: 'no error',
      oldAgain: 'no error',
      newerShared: true,
    });
  });

  it('check 8 (#616 unit 12a; MA 2 on #998): a caller whose shared open resolves after another caller closed the home gets a fresh handle, not the closed one', async () => {
    const home = join(tmp(), '.realm');
    const a = await openRealmHome({ home });
    // B asks while the home is open and has not awaited; A closes; then B awaits.
    const late = openRealmHome({ home });
    a.close();
    const b = await track(late);
    const used = await b.runStore.get('no-such-run').then(() => 'resolved', describeError);
    // (1) red when B is handed A's closed handle (its first use then meets a closed connection);
    //     (2) prints whether B got another handle and what its first read gave.
    expect({ another: b !== a, used }).toEqual({ another: true, used: 'STATE_RUN_NOT_FOUND' });
  });
});

describe('#616 unit 11 — one exporter', () => {
  /** The workspace's packages (root `package.json` `workspaces`), each with its folder and name. */
  function workspacePackages(): Array<{ dir: string; name: string }> {
    const root = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      workspaces: string[];
    };
    const out: Array<{ dir: string; name: string }> = [];
    for (const pattern of root.workspaces) {
      const parent = join(ROOT, pattern.replace(/\/\*$/, ''));
      for (const entry of readdirSync(parent)) {
        const manifest = join(parent, entry, 'package.json');
        if (!existsSync(manifest)) continue;
        const { name } = JSON.parse(readFileSync(manifest, 'utf8')) as { name: string };
        out.push({ dir: join(parent, entry), name });
      }
    }
    return out;
  }

  /** The production source files under `dir` (`.ts`, `.mts`, `.js`, `.mjs`; no tests, no `.d.ts`). */
  function sources(dir: string, out: string[] = []): string[] {
    if (!existsSync(dir)) return out;
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        if (name !== 'node_modules' && name !== 'dist') sources(path, out);
      } else if (/\.(?:m?ts|m?js)$/.test(name) && !/\.(?:test|d)\.m?ts$/.test(name)) {
        out.push(path);
      }
    }
    return out;
  }

  /** Whether a module's top level exports something named `openRealmHome`, or re-exports the store's entry. */
  function exportsTheOpener(path: string): boolean {
    const file = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest);
    const exported = (node: ts.Node): boolean =>
      ts.canHaveModifiers(node) &&
      (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    return file.statements.some((s) => {
      if (ts.isFunctionDeclaration(s)) return exported(s) && s.name?.text === 'openRealmHome';
      if (ts.isVariableStatement(s)) {
        return (
          exported(s) &&
          s.declarationList.declarations.some(
            (d) => ts.isIdentifier(d.name) && d.name.text === 'openRealmHome',
          )
        );
      }
      if (ts.isExportDeclaration(s)) {
        if (s.exportClause !== undefined && ts.isNamedExports(s.exportClause)) {
          return s.exportClause.elements.some((e) => e.name.text === 'openRealmHome');
        }
        // `export * from '@sensigo/realm-store-sqlite'` exports what the store's entry exports.
        return (
          s.exportClause === undefined &&
          s.moduleSpecifier !== undefined &&
          ts.isStringLiteral(s.moduleSpecifier) &&
          s.moduleSpecifier.text === '@sensigo/realm-store-sqlite'
        );
      }
      return false;
    });
  }

  it('check 4: exactly one workspace package exports openRealmHome', () => {
    const packages = workspacePackages();
    const exporters: Record<string, string[]> = {};
    for (const pkg of packages) {
      const files = sources(join(pkg.dir, 'src')).filter(exportsTheOpener);
      if (files.length > 0) {
        exporters[pkg.name] = files.map((f) => relative(pkg.dir, f).split(sep).join('/')).sort();
      }
    }
    const scanned = packages.filter((p) => p.dir.split(sep).includes('packages')).length;
    // (1) red when a second package exports a function by that name or re-exports it (a host would
    //     then hold two caches, two connections on one file), and when the scan stops seeing the
    //     store's own two exports or the package folders (it would then be reading nothing);
    //     (2) prints each exporting package with its files, and the count of packages under
    //     `packages/` it read.
    expect({ exporters, scanned }).toEqual({
      exporters: { '@sensigo/realm-store-sqlite': ['src/index.ts', 'src/open-realm-home.ts'] },
      scanned: 5,
    });
  });
});

describe('#616 unit 11 — the README sentences, each tied to its behaviour', () => {
  it("README, the handle (check 9, #616 unit 12a) and the shared handle: both sentences are there, the handle carries exactly the members the sentence names, and two callers' handle is one (check 1 pins the connection count)", async () => {
    const home = join(tmp(), '.realm');
    const [a, b] = await Promise.all([track(openRealmHome({ home })), openRealmHome({ home })]);
    const carries = Object.keys(a).sort();
    a.close();
    const bAfter = settleSync(() => b.close());
    // (1) red when either sentence is changed or removed, when the handle carries other members
    //     than the sentence names, or when two callers get two handles (a close() by one would then
    //     not end the other's); (2) prints the sentence checks, the handle's members, whether the
    //     handles are the same object, and what closing the second gave.
    expect({
      says: [says(SENTENCES.opens), says(SENTENCES.shared)],
      carries,
      one: a === b,
      bAfter,
    }).toEqual({
      says: [true, true],
      carries: [
        'close',
        'dedupStoreFor',
        'failedAttemptStore',
        'replayStore',
        'runStore',
        'traceBufferStore',
        'workflowStore',
      ],
      one: true,
      bAfter: 'no error',
    });
  });

  it('README, the store file: one SQLite file, realm.db, in the home, holding the runs, with the side files realm.db-wal and realm.db-shm while it is open', async () => {
    const home = join(tmp(), '.realm');
    const handle = await openRealmHome({ home });
    const whileOpen = readdirSync(home).sort();
    const header = readFileSync(join(home, DATABASE_FILE)).subarray(0, 16).toString('latin1');
    handle.close();
    const c = await foreign(home);
    const runsTable = c
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'runs'")
      .get()?.['name'];
    // (1) red when the sentence is changed or removed, when the store's file or its side files are
    //     named otherwise (the file's constant), when the store is not in write-ahead-log mode (no
    //     side files), or when a second database file appears; (2) prints the home's entries while
    //     open, the file's header and whether it holds the runs table.
    expect({ says: says(SENTENCES.file), whileOpen, header, runsTable }).toEqual({
      says: true,
      whileOpen: [
        'dedup',
        'realm.db',
        'realm.db-shm',
        'realm.db-wal',
        'replays',
        'runs',
        'workflows',
      ],
      header: 'SQLite format 3\u0000',
      runsTable: 'runs',
    });
  });

  it("README, a deleted run's text: it stays in realm.db-wal and, after a checkpoint, in realm.db's free pages, until a vacuum and a checkpoint", async () => {
    const home = join(tmp(), '.realm');
    // The home's own connection, as its open made it (its pragmas applied).
    let own: DatabaseLike | undefined;
    const handle = await track(
      openHome(
        { home, clock },
        {
          openFile: (path) => {
            own = openDatabase(path);
            return own;
          },
        },
      ),
    );
    const c = own as DatabaseLike;
    // A record larger than a page (16 KiB), so its text sits on overflow pages, which a delete frees.
    const MARK = 'RUN-TEXT-616-U11 ';
    const record = finishedRun('deleted-run', { text: MARK.repeat(12_000) });
    writeThenDelete(c, record);
    const copies = (file: string): number => {
      const path = join(home, file);
      return existsSync(path) ? readFileSync(path).toString('latin1').split(MARK).length - 1 : 0;
    };
    const inWalAfterDelete = copies('realm.db-wal');
    const checkpoint = c.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    const inFileAfterCheckpoint = copies(DATABASE_FILE);
    c.exec('PRAGMA incremental_vacuum');
    c.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    const afterVacuum = { file: copies(DATABASE_FILE), wal: copies('realm.db-wal') };
    handle.close();
    // (1) red when the sentence is changed or removed, when the store erases deleted text by itself
    //     (the connection's `secure_delete` set to ON: no copy after the checkpoint), or when a
    //     vacuum and a checkpoint no longer clear it; (2) prints whether copies were found at each
    //     moment, the checkpoint's answer and the copies left after the vacuum.
    expect({
      says: says(SENTENCES.deleted),
      inWalAfterDelete: inWalAfterDelete > 0,
      checkpoint,
      inFileAfterCheckpoint: inFileAfterCheckpoint > 0,
      afterVacuum,
    }).toEqual({
      says: true,
      inWalAfterDelete: true,
      checkpoint: { busy: 0, log: 0, checkpointed: 0 },
      inFileAfterCheckpoint: true,
      afterVacuum: { file: 0, wal: 0 },
    });
  });

  it("README, the one clock exception: Realm stamps from the home's clock, and a run deleted by SQL outside Realm is stamped by SQLite's clock", async () => {
    const home = join(tmp(), '.realm');
    await track(openRealmHome({ home, clock }));
    const c = await foreign(home);
    const before = Date.now();
    writeThenDelete(c, finishedRun('deleted-outside', { ticket: 'T-1042' }));
    const after = Date.now();
    const purgedAt = String(
      c.prepare('SELECT purged_at FROM purged_ids WHERE id = ?').get('deleted-outside')?.[
        'purged_at'
      ],
    );
    // (1) red when the sentence is changed or removed, when the store's first stamp is not from the
    //     home's clock, or when a delete outside Realm is stamped otherwise than by SQLite's own clock
    //     (the deleting trigger's fallback); (2) prints the meta row's stamp and the tombstone's.
    expect({
      says: says(SENTENCES.foreignDelete),
      realmStamp: String(c.prepare('SELECT created_at FROM store_meta').get()?.['created_at']),
      outsideStamp: withinSystemClock(purgedAt, before, after) ? "SQLite's clock" : purgedAt,
    }).toEqual({ says: true, realmStamp: AT, outsideStamp: "SQLite's clock" });
  });

  it("README, the filesystem: a home on WSL's /mnt/c (9p) is refused, naming it, and nothing is made; REALM_STORE_FS=local opens it anyway", async () => {
    const parent = join(tmp(), 'drive');
    const refused = await settle(() =>
      openHome({ home: join(parent, '.realm') }, { probe: NINE_P }),
    );
    let message = '';
    try {
      await openHome({ home: join(parent, '.realm') }, { probe: NINE_P });
    } catch (err) {
      message = (err as Error).message;
    }
    const madeAfterRefusal = existsSync(parent);
    const escaped = await settle(() =>
      openHome(
        { home: join(tmp(), '.realm') },
        { probe: { ...NINE_P, env: { REALM_STORE_FS: 'local' } } },
      ),
    );
    // (1) red when the sentence is changed or removed, when the open no longer checks the home's
    //     filesystem (the 9p home opens), when the refusal stops naming the filesystem, or when the
    //     escape no longer works; (2) prints each outcome, the refusal's message and whether the
    //     home's folder was made.
    expect({
      says: says(SENTENCES.filesystem),
      refused,
      message,
      madeAfterRefusal,
      escaped,
    }).toEqual({
      says: true,
      refused: { rejected: 'STATE_STORE_FILESYSTEM_REFUSED' },
      message: expect.stringContaining('a network or unrecognised filesystem (9p)'),
      madeAfterRefusal: false,
      escaped: 'opened',
    });
  });

  it('README, the floors: a SQLite with the WAL-reset bug is refused naming the Node floors, the first fixed one opens, and the package says the same floors', async () => {
    let message = '';
    try {
      await openHome(
        { home: join(tmp(), '.realm') },
        { loadSqlite: loaderReporting('3.51.2', 'v24.14.1') },
      );
    } catch (err) {
      message = (err as Error).message;
    }
    const fixed = await settle(() =>
      openHome(
        { home: join(tmp(), '.realm') },
        { loadSqlite: loaderReporting('3.51.3', 'v24.15.0') },
      ),
    );
    const engines = (
      JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
        engines: { node: string };
      }
    ).engines.node;
    // (1) red when the sentence is changed or removed, when the loader's floor moves (3.51.2 opens,
    //     or 3.51.3 is refused), when the refusal stops naming the two Node floors, or when the
    //     package's `engines` says other floors; (2) prints the refusal's message, the fixed
    //     version's outcome and the package's `engines`.
    expect({ says: says(SENTENCES.floors), message, fixed, engines }).toEqual({
      says: true,
      message: expect.stringContaining(
        'needs Node 22.22.3 or a later 22.x release, or Node 24.15.0 or later',
      ),
      fixed: 'opened',
      engines: '^22.22.3 || >=24.15.0',
    });
  });
});
