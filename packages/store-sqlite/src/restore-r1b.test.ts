// restore-r1b.test.ts — #616 R1b part one (prompts/feat-616-r1b-restore.md, -split.md): the entry opened for
// `'restore'`, `realm db restore`'s store half. The real cases, one cell each: a restore over a store
// whose runs changed since the backup (the counts, the kept file, no side file left); its undo; another
// process on the store (a real child); the backup argument; a backup that is not a store, is damaged
// or newer; a backup in DELETE journal mode, 0644 or in a read-only folder; an older backup; a stale
// write-ahead log; the crash window (a real kill at the `rename` seam); an opener of the new file
// right after the rename (a real child); failures before the swap; (R1c) a home with no store, or an
// empty one; the damaged-file rule, its side files looked at before any open; an opener waiting on the
// raw hold (a real child); the raw path's own guard; a store file written by a newer Realm. Every home nests
// (`<tmp>/h/.realm`), so its backups folder is its own scratch folder's, never `/tmp/.realm-backups`.
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkflowError, type CreateRunOptions } from '@sensigo/realm';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type DatabaseLike } from './driver.js';
import { backupStamp, openMaintenance, type MaintenanceSeams } from './maintenance.js';
import { openHome } from './open-realm-home.js';
import type { RestoreProgress, RestoreReport } from './restore.js';

const RUN: CreateRunOptions = {
  workflowId: 'triage',
  workflowVersion: 1,
  params: {},
  extensionIdentity: [],
};

/** The package's root: a child process resolves the package (and its built files) from there. */
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const dirs: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  for (const d of dirs.splice(0)) {
    try {
      chmodSync(d, 0o700);
    } catch {
      // gone
    }
    rmSync(d, { recursive: true, force: true });
  }
});

/** A scratch folder and the home nested in it: `<tmp>/h/.realm`, its backups folder beside it. */
function nestedHome(): { root: string; home: string; file: string; folder: string } {
  const root = mkdtempSync(join(tmpdir(), 'realm-616-r1b-'));
  dirs.push(root);
  const home = join(root, 'h', '.realm');
  return { root, home, file: join(home, 'realm.db'), folder: join(root, 'h', '.realm-backups') };
}

/** A store in `home` with `runs` runs, at schema version `version`; their ids. */
async function makeStore(home: string, runs: number, version?: number): Promise<string[]> {
  const h = await openHome({ home }, version === undefined ? {} : { schemaVersion: version });
  const ids: string[] = [];
  for (let i = 0; i < runs; i++) ids.push((await h.runStore.create(RUN)).record.id);
  h.close();
  return ids;
}

/** `realm db backup`'s copy of the home's store file at `path`. */
async function backupTo(home: string, path: string): Promise<void> {
  const m = await openMaintenance({ home, verb: 'backup' }, {});
  try {
    await m.backup(path);
  } finally {
    m.close();
  }
}

/** One run created, one changed and one removed (sealed, then deleted) on the home's store. */
async function changeRuns(home: string, change: string, remove: string): Promise<string> {
  const h = await openHome({ home }, {});
  try {
    const created = (await h.runStore.create(RUN)).record.id;
    const changing = (await h.runStore.get(change)).record;
    await h.runStore.update({ ...changing, params: { changed: true } });
    const removing = (await h.runStore.get(remove)).record;
    await h.runStore.update({
      ...removing,
      terminal_state: true,
      sealed_by: { arm: 'complete' },
      terminal_reason: 'Workflow completed.',
    });
    await h.runStore.deleteAllForRun(remove);
    return created;
  } finally {
    h.close();
  }
}

/** The runs a store file holds, each id with its stored record, read through a raw connection. */
function runsOf(file: string): Record<string, string> {
  const db = openDatabase(file);
  try {
    const out: Record<string, string> = {};
    for (const row of db.prepare('SELECT id, record FROM runs ORDER BY id').all()) {
      out[String(row['id'])] = String(row['record']);
    }
    return out;
  } finally {
    db.close();
  }
}

/** Whether a store file records `id` as purged (its tombstone in `purged_runs`). */
function purged(file: string, id: string): boolean {
  const db = openDatabase(file);
  try {
    return (
      Number(db.prepare('SELECT count(*) AS n FROM purged_runs WHERE id = ?').get(id)?.['n']) === 1
    );
  } finally {
    db.close();
  }
}

/** The sha-256 of a file's bytes, so any change to it shows. */
function hashOf(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** Which of a file's side files exist. */
function sideFiles(file: string): string[] {
  return ['-wal', '-shm', '-journal'].filter((s) => existsSync(`${file}${s}`));
}

/** The names in a folder (none when it does not exist). */
function names(folder: string): string[] {
  return existsSync(folder) ? readdirSync(folder).sort() : [];
}

/** What a restore came to: its report and its events, or its refusal's code and words. */
interface Outcome {
  readonly report?: RestoreReport;
  readonly refused?: { readonly code: unknown; readonly message: string };
  readonly events: RestoreProgress[];
}

/** Runs one restore of `backup` into `home`, with `seams`. */
async function restore(
  home: string,
  backup: string,
  seams: MaintenanceSeams = {},
): Promise<Outcome> {
  const events: RestoreProgress[] = [];
  const handle = await openMaintenance({ home, verb: 'restore' }, seams);
  try {
    return { report: await handle.restore(backup, (e) => events.push(e)), events };
  } catch (err) {
    if (!(err instanceof WorkflowError)) throw err;
    return { refused: { code: err.code, message: err.message }, events };
  } finally {
    handle.close();
  }
}

/** A finished restore's report, or the test fails with the refusal. */
function reported(outcome: Outcome): RestoreReport {
  if (outcome.report === undefined) {
    throw new Error(`the restore was refused: ${JSON.stringify(outcome.refused)}`);
  }
  return outcome.report;
}

/**
 * Damages page 13 of a store file as a bad sector would: the b-tree page's type byte 0x00 and its
 * cell count 0xffff (as the backup cells do: maintenance-616.test.ts, damagePage13). The store's open
 * still reads the file; SQLite's copy and its quick check do not.
 */
function damagePage13(file: string): void {
  const fd = openSync(file, 'r+');
  try {
    const page = 12 * 16384;
    writeSync(fd, Buffer.from([0x00]), 0, 1, page);
    writeSync(fd, Buffer.from([0xff, 0xff]), 0, 2, page + 3);
  } finally {
    closeSync(fd);
  }
}

/**
 * Waits until the wall clock's UTC second moves on, so the next restore's kept file gets a name of
 * its own (the name holds the second; the global `Date` is never faked here: the source law of
 * test-time-715b forbids it beside child processes).
 */
async function nextSecond(): Promise<void> {
  const second = Math.floor(Date.now() / 1000);
  while (Math.floor(Date.now() / 1000) === second) await new Promise((r) => setTimeout(r, 20));
}

/** Sets a store file's schema version (`user_version`) through a raw connection. */
function setVersion(file: string, version: number): void {
  const db = openDatabase(file);
  try {
    db.exec(`PRAGMA user_version = ${version}`);
  } finally {
    db.close();
  }
}

// Another PROCESS that has the store file open and does nothing: one read, then idle (R1's holder).
const HOLDER =
  "import { openForeignConnection } from '@sensigo/realm-store-sqlite/test-support';" +
  'const db = await openForeignConnection(process.argv[1]);' +
  "db.prepare('SELECT count(*) FROM sqlite_master').get();" +
  "process.stdout.write('ready\\n');" +
  'setInterval(() => {}, 1000);';

// Another PROCESS that is in a write transaction on the store file and stays there (a file in
// rollback mode, such as a zero-length one, gives an idle connection no lock).
const WRITING =
  "import { openForeignConnection } from '@sensigo/realm-store-sqlite/test-support';" +
  'const db = await openForeignConnection(process.argv[1]);' +
  "db.exec('BEGIN IMMEDIATE');" +
  "process.stdout.write('ready\\n');" +
  'setInterval(() => {}, 1000);';

/** Starts a child running `script` on `home`; resolves once it says it is ready. */
function startChild(script: string, home: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, home], {
    cwd: PACKAGE_ROOT,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  children.push(child);
  return new Promise((resolve, reject) => {
    child.stdout!.once('data', () => resolve(child));
    child.once('exit', (code) =>
      reject(new Error(`the child exited (${code}) before it was ready`)),
    );
  });
}

// A PROCESS that creates one run through the store's entry and is killed before it closes: its
// committed rows stay in `realm.db-wal`, beside `realm.db-shm` (a crashed writer).
const KILLED_WRITER =
  "import { writeSync } from 'node:fs';" +
  "import { openRealmHome } from '@sensigo/realm-store-sqlite';" +
  'const h = await openRealmHome({ home: process.argv[1] });' +
  "const { record } = await h.runStore.create({ workflowId: 'triage', workflowVersion: 1, params: {}, extensionIdentity: [] });" +
  "writeSync(1, record.id + '\\n');" +
  "process.kill(process.pid, 'SIGKILL');";

/** Runs the killed writer on `home`; the id of the run it committed. */
function killedWriter(home: string): string {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', KILLED_WRITER, home], {
    cwd: PACKAGE_ROOT,
    encoding: 'utf8',
  });
  const id = r.stdout.trim();
  if (id === '') throw new Error(`the writer committed nothing: ${r.stderr}`);
  return id;
}

// A PROCESS that restores and is killed at the rename seam: between the unlink of the old side
// files and the rename, with nothing closed (the crash window). Built code: the package's dist.
const KILLED_RESTORE =
  "import { openMaintenance } from './dist/maintenance.js';" +
  "const h = await openMaintenance({ home: process.argv[1], verb: 'restore' }, { rename: () => process.kill(process.pid, 'SIGKILL') });" +
  'await h.restore(process.argv[2]);';

/**
 * Runs a restore of `backup` into `home` that is killed at the rename seam, with `temporary` as its
 * system temporary folder (`TMPDIR`); its signal.
 */
function killedRestore(home: string, backup: string, temporary = tmpdir()): string | null {
  const r = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', KILLED_RESTORE, home, backup],
    { cwd: PACKAGE_ROOT, encoding: 'utf8', env: { ...process.env, TMPDIR: temporary } },
  );
  return r.signal;
}

// A PROCESS that opens the home through the store's entry the moment a file appears at `go` (while
// a restore holds the store file), reads two runs, writes one, and prints what it saw and wrote.
const WAITER =
  "import { existsSync, writeSync } from 'node:fs';" +
  "import { openRealmHome } from '@sensigo/realm-store-sqlite';" +
  'const [home, go, oldRun, restoredRun] = process.argv.slice(1);' +
  "writeSync(1, 'ready\\n');" +
  'while (!existsSync(go)) await new Promise((r) => setTimeout(r, 10));' +
  'const h = await openRealmHome({ home });' +
  'const has = async (id) => { try { await h.runStore.get(id); return true; } catch { return false; } };' +
  'const seen = { old: await has(oldRun), restored: await has(restoredRun) };' +
  "const { record } = await h.runStore.create({ workflowId: 'triage', workflowVersion: 1, params: {}, extensionIdentity: [] });" +
  'h.close();' +
  "writeSync(1, JSON.stringify({ ...seen, wrote: record.id }) + '\\n');";

/** Waits for a child's `ready` line, at most 30 s; a child that dies first fails with its error output. */
async function childReady(out: () => string, err: () => string): Promise<void> {
  const until = Date.now() + 30_000;
  while (!out().includes('ready')) {
    if (Date.now() > until) throw new Error(`the child never said ready: ${err()}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Blocks this process (not the child) for `ms`: a seam is synchronous, and the hold is held in it. */
function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const IN_USE = (file: string): string =>
  `Another process has ${file} open (a Realm agent, server, MCP server or command, or another ` +
  'program such as a SQLite browser). Stop it and run this again. Nothing was changed.';

describe('#616 R1b — realm db restore over a store', { timeout: 120_000 }, () => {
  it('runs created, changed and removed since the backup: the restored file holds the backup, the kept file the newer runs, the counts are the real difference, and no side file is left', async () => {
    const { root, home, file, folder } = nestedHome();
    const ids = await makeStore(home, 4);
    const backup = join(root, 'b.db');
    await backupTo(home, backup);
    const inBackup = runsOf(backup);
    const created = await changeRuns(home, ids[0]!, ids[1]!);
    const before = runsOf(file);
    const outcome = await restore(home, backup);
    const report = reported(outcome);
    const kept = report.replaced.kind === 'store' ? report.replaced.kept.path : 'none';
    // The side files, looked at before anything reads the files again.
    const left = { kept: sideFiles(kept), backup: sideFiles(backup), file: sideFiles(file) };
    // The run deleted after the backup is back, and the record of its purge is gone with it.
    const purge = { restored: purged(file, ids[1]!), kept: purged(kept, ids[1]!) };
    const check = await openMaintenance({ home, verb: 'check' }, {});
    let findings: unknown;
    try {
      findings = (await check.check()).findings.map((f) => f.code);
    } finally {
      check.close();
    }
    // (1) red when a count is wrong (a NOT EXISTS turned, a count by version), when the restored file
    //     is not the backup, the kept file not the file it replaced, a side file is left beside the
    //     kept file or the backup, or the restored file fails the check; (2) prints all of it.
    expect({
      difference: report.replaced.kind === 'store' ? report.replaced.difference : report.replaced,
      restored: runsOf(file),
      kept: runsOf(kept),
      left,
      findings,
      schemaVersion: report.schemaVersion,
      events: outcome.events.map((e) => e.kind),
      keptName: kept.startsWith(`${folder}/realm-before-restore-`) && kept.endsWith('Z.db'),
      created: created in before,
      purge,
    }).toEqual({
      difference: { onlyReplaced: 1, changed: 1, onlyRestored: 1 },
      restored: inBackup,
      kept: before,
      left: { kept: [], backup: [], file: [] },
      findings: [],
      schemaVersion: 2,
      events: ['kept'],
      keptName: true,
      created: true,
      purge: { restored: false, kept: true },
    });
  });

  it('undo: restoring the kept file brings back the state before the restore, and a run changed at the same version is counted as changed', async () => {
    const { root, home, file } = nestedHome();
    const [id] = await makeStore(home, 1);
    const backup = join(root, 'b.db');
    await backupTo(home, backup);
    // Later work: the run moves to its next version.
    let h = await openHome({ home }, {});
    const v1 = (await h.runStore.get(id!)).record;
    await h.runStore.update({ ...v1, params: { later: 'work' } });
    h.close();
    const beforeRestore = runsOf(file);
    const first = reported(await restore(home, backup));
    const kept = first.replaced.kind === 'store' ? first.replaced.kept.path : 'none';
    // Work on the restored file reaches the same version with other content.
    h = await openHome({ home }, {});
    const again = (await h.runStore.get(id!)).record;
    await h.runStore.update({ ...again, params: { other: 'work' } });
    h.close();
    // The run's stored version in the kept file and in the file the undo replaces: the same.
    const version = (path: string): unknown =>
      (JSON.parse(runsOf(path)[id!] ?? '{}') as { version?: unknown }).version;
    const versions = [version(kept), version(file)];
    await nextSecond();
    const undo = reported(await restore(home, kept));
    // (1) red when the counts compare versions (the same-version run is then not counted), or the
    //     undo does not bring back the file as it was; (2) prints the counts and both run sets.
    expect({
      difference: undo.replaced.kind === 'store' ? undo.replaced.difference : undo.replaced,
      runs: runsOf(file),
      versions,
    }).toEqual({
      difference: { onlyReplaced: 0, changed: 1, onlyRestored: 0 },
      runs: beforeRestore,
      versions: [v1.version + 1, v1.version + 1],
    });
  });

  it('two restores in the same second: the second is refused by backup`s never-replace rule, and changes nothing', async () => {
    const { root, home, file, folder } = nestedHome();
    await makeStore(home, 1);
    const backup = join(root, 'b.db');
    await backupTo(home, backup);
    const first = reported(await restore(home, backup)).replaced.kept.path;
    // The second restore takes the name of the second it runs in: the first's, or, should the clock
    // move on meanwhile, one of the next three, counted from the first restore's own second (read
    // from its kept file's name, whatever second it ended in), each held by a file already.
    const stamp = /(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z\.db$/.exec(first)!.slice(1).map(Number);
    const at = Date.UTC(stamp[0]!, stamp[1]! - 1, stamp[2]!, stamp[3]!, stamp[4]!, stamp[5]!);
    const held = [1, 2, 3]
      .map((k) => join(folder, `realm-before-restore-${backupStamp(new Date(at + k * 1000))}.db`))
      .filter((path) => !existsSync(path));
    for (const path of held) writeFileSync(path, 'held');
    const before = hashOf(file);
    const firstBytes = hashOf(first);
    const second = await restore(home, backup);
    const kept = /^Cannot back up the store to (\S+\.db): /.exec(
      second.refused?.message ?? '',
    )?.[1];
    // (1) red when the second kept copy replaces a file there, or its refusal loses its sentence;
    //     (2) prints the refusal, whether the store file changed, and the files that were there.
    expect({
      refused: second.refused,
      named: kept !== undefined && [first, ...held].includes(kept),
      unchanged: hashOf(file) === before,
      there: [hashOf(first) === firstBytes, ...held.map((p) => readFileSync(p, 'utf8'))],
    }).toEqual({
      refused: {
        code: 'STATE_STORE_BACKUP_REFUSED',
        message:
          `Cannot back up the store to ${kept}: a file already exists there. Realm never replaces a ` +
          'file; name a path where nothing exists. Nothing was replaced.',
      },
      named: true,
      unchanged: true,
      there: [true, ...held.map(() => 'held')],
    });
  });

  it('another process idle on the store (a real child): refused STATE_STORE_IN_USE, nothing changed, no kept file, no copy left in the home', async () => {
    const { root, home, file, folder } = nestedHome();
    await makeStore(home, 2);
    const backup = join(root, 'b.db');
    await backupTo(home, backup);
    await makeStore(home, 1);
    const holder = await startChild(HOLDER, home);
    const before = hashOf(file);
    const outcome = await restore(home, backup);
    holder.kill('SIGKILL');
    // (1) red when the hold is not taken (the restore replaces the file under the idle process);
    //     (2) prints the refusal, whether the file changed, and what is in the home and the folder.
    expect({
      refused: outcome.refused,
      unchanged: hashOf(file) === before,
      home: names(home).filter((n) => n.startsWith('.realm-restore-')),
      folder: names(folder),
    }).toEqual({
      refused: { code: 'STATE_STORE_IN_USE', message: IN_USE(file) },
      unchanged: true,
      home: [],
      folder: [],
    });
  });
});

describe(
  '#616 R1b — the backup argument and the backup, proven before anything is touched',
  { timeout: 120_000 },
  () => {
    it('a link, a folder, a FIFO, an empty file, a missing path, the store file itself (by its path, a hard link, a symlinked home) and its -wal: each refused in its own words, and nothing is changed', async () => {
      const { root, home, file, folder } = nestedHome();
      await makeStore(home, 1);
      const backup = join(root, 'b.db');
      await backupTo(home, backup);
      const link = join(root, 'link.db');
      symlinkSync(backup, link);
      const dir = join(root, 'dir.db');
      mkdirSync(dir);
      const fifo = join(root, 'fifo.db');
      spawnSync('mkfifo', [fifo]);
      // An empty file is refused only after the store-file tests: the store's own -wal is often 0
      // bytes, and it must get the words of a side file of the store, not those of an empty file.
      const empty = join(root, 'empty.db');
      writeFileSync(empty, '');
      const hard = join(root, 'hard.db');
      linkSync(file, hard);
      const aliasRoot = join(root, 'alias');
      symlinkSync(join(root, 'h'), aliasRoot);
      // A connection open in this process keeps the store's -wal there.
      const open = openDatabase(file);
      open.prepare('SELECT count(*) FROM sqlite_master').get();
      const before = hashOf(file);
      const words = (path: string, reason: string): unknown => ({
        code: 'STATE_STORE_RESTORE_REFUSED',
        message: `Cannot restore from ${path}: ${reason}. Nothing was changed.`,
      });
      const cases = {
        link: (await restore(home, link)).refused,
        folder: (await restore(home, dir)).refused,
        fifo: (await restore(home, fifo)).refused,
        empty: (await restore(home, empty)).refused,
        missing: (await restore(home, join(root, 'missing.db'))).refused,
        itself: (await restore(home, file)).refused,
        hardLink: (await restore(home, hard)).refused,
        byLinkedPath: (await restore(home, join(aliasRoot, '.realm', 'realm.db'))).refused,
        linkedHome: (await restore(join(aliasRoot, '.realm'), file)).refused,
        wal: (await restore(home, `${file}-wal`)).refused,
      };
      open.close();
      // (1) red when an argument is judged by its text (the hard link and the symlinked home pass),
      //     when a link or a FIFO is followed, or when a refusal changes the store file, leaves a copy
      //     in the home or makes the backups folder; (2) prints each refusal and what exists.
      expect({
        cases,
        unchanged: hashOf(file) === before,
        left: names(home).filter((n) => n.startsWith('.realm-restore-')),
        folder: names(folder),
      }).toEqual({
        cases: {
          link: words(link, 'it is a symbolic link'),
          folder: words(dir, 'it is not a file'),
          fifo: words(fifo, 'it is not a file'),
          empty: words(empty, 'it is empty: it holds no store'),
          missing: words(join(root, 'missing.db'), 'no such file or directory'),
          itself: words(file, 'it is the store file itself'),
          hardLink: words(hard, 'it is the store file itself'),
          byLinkedPath: words(join(aliasRoot, '.realm', 'realm.db'), 'it is the store file itself'),
          linkedHome: words(file, 'it is the store file itself'),
          wal: words(`${file}-wal`, "it is the store file's -wal file"),
        },
        unchanged: true,
        left: [],
        folder: [],
      });
    });
  },
);

describe(
  '#616 R1b — a backup that is not a store, is damaged or newer is refused, and changes nothing',
  { timeout: 120_000 },
  () => {
    it('a valid empty SQLite file, a copy with a damaged page, a newer copy: refused in the check words naming the backup; the home and the backups folder untouched; the empty file never set up', async () => {
      const { root, home, file, folder } = nestedHome();
      await makeStore(home, 1);
      const empty = join(root, 'empty.db');
      const e = openDatabase(empty);
      e.prepare('SELECT count(*) FROM sqlite_master').get();
      e.exec('PRAGMA user_version = 0');
      e.close();
      const damaged = join(root, 'damaged.db');
      await backupTo(home, damaged);
      damagePage13(damaged);
      const newer = join(root, 'newer.db');
      await backupTo(home, newer);
      setVersion(newer, 3);
      const hashes = [empty, damaged, newer].map(hashOf);
      const before = hashOf(file);
      const homeNames = names(home);
      const refused = {
        empty: (await restore(home, empty)).refused,
        damaged: (await restore(home, damaged)).refused,
        newer: (await restore(home, newer)).refused,
      };
      // (1) red when the backup is proven by the open that sets an empty file up (it then restores a
      //     store with no runs), when a damaged copy or a newer one passes, when a refusal names the
      //     scratch copy instead of the backup, or when anything of the home, the backups folder or the
      //     backups themselves changed; (2) prints the refusals and what changed.
      expect({
        refused,
        backups: [empty, damaged, newer].map(hashOf),
        sides: [empty, damaged, newer].flatMap(sideFiles),
        unchanged: hashOf(file) === before,
        home: names(home),
        folder: names(folder),
      }).toEqual({
        refused: {
          empty: {
            code: 'STATE_STORE_RESTORE_REFUSED',
            message:
              `Cannot restore from ${empty}: The file's schema version is 0: it was never set up (a ` +
              'first open was interrupted) or it is not a Realm store. A store setting differs: ' +
              'application_id is 0, expected 1380270412. A store setting differs: journal_mode is ' +
              'delete, expected wal. A store setting differs: auto_vacuum is 0, expected 2. Nothing ' +
              'was changed.',
          },
          damaged: {
            code: 'STATE_STORE_RESTORE_REFUSED',
            message: `Cannot restore from ${damaged}: SQLite's integrity check reported 1 problem. Nothing was changed.`,
          },
          newer: {
            code: 'STATE_STORE_RESTORE_REFUSED',
            message: `Cannot restore from ${newer}: Written by a later version of Realm (schema version 3; this version reads up to 2). Nothing was changed.`,
          },
        },
        backups: hashes,
        sides: [],
        unchanged: true,
        home: homeNames,
        folder: [],
      });
    });

    it('a backup in DELETE journal mode, one readable by others (0644), one in a read-only folder: restored, the store file in WAL and owner-only, the backup untouched and nothing beside it', async () => {
      const { root, home, file } = nestedHome();
      await makeStore(home, 2);
      const plain = join(root, 'plain.db');
      await backupTo(home, plain);
      const del = openDatabase(plain);
      del.exec('PRAGMA journal_mode = DELETE');
      del.close();
      chmodSync(plain, 0o644);
      const locked = join(root, 'locked');
      mkdirSync(locked);
      const inLocked = join(locked, 'b.db');
      await backupTo(home, inLocked);
      chmodSync(locked, 0o555);
      const hashes = [plain, inLocked].map(hashOf);
      const results: unknown[] = [];
      for (const backup of [plain, inLocked]) {
        if (results.length > 0) await nextSecond();
        const outcome = await restore(home, backup);
        const mode = statSync(file).mode & 0o777;
        const db = openDatabase(file);
        const journal = db.prepare('PRAGMA journal_mode').get()?.['journal_mode'];
        db.close();
        results.push({ refused: outcome.refused, mode: mode.toString(8), journal });
      }
      chmodSync(locked, 0o700);
      // (1) red when the copy keeps the backup's mode (0644) or journal mode (delete: the open then
      //     refuses the restored file), when a read-only folder makes the proof fail, or when the backup
      //     is changed or gets a side file; (2) prints each restore's outcome, the modes and the backups.
      expect({
        results,
        backups: [plain, inLocked].map(hashOf),
        sides: [plain, inLocked].flatMap(sideFiles),
        lockedNames: names(locked),
      }).toEqual({
        results: [
          { refused: undefined, mode: '600', journal: 'wal' },
          { refused: undefined, mode: '600', journal: 'wal' },
        ],
        backups: hashes,
        sides: [],
        lockedNames: ['b.db'],
      });
    });

    it('an older backup: allowed, the report gives both versions, and realm db migrate then brings the file to this version', async () => {
      const { root, home, file } = nestedHome();
      const old = join(root, 'old', '.realm');
      const ids = await makeStore(old, 2, 1);
      const backup = join(root, 'v1.db');
      await backupTo(old, backup);
      await makeStore(home, 1);
      const report = reported(await restore(home, backup));
      const m = await openMaintenance({ home, verb: 'migrate' }, {});
      let migrated: number;
      try {
        migrated = (await m.migrate({ backup: false })).schemaVersion;
      } finally {
        m.close();
      }
      // (1) red when an older backup is refused (the check's older_version taken for a refusal), or the
      //     report does not say the versions; (2) prints the report's versions, the runs and the migrate.
      expect({
        versions: [report.schemaVersion, report.writes],
        runs: Object.keys(runsOf(file)).sort(),
        migrated,
      }).toEqual({ versions: [1, 2], runs: [...ids].sort(), migrated: 2 });
    });
  },
);

describe(
  '#616 R1b — the swap: the stale log, the crash window, an opener of the new file',
  { timeout: 120_000 },
  () => {
    it('the stale log: a -wal with frames beside the store file before the swap is never applied to the restored file', async () => {
      const { root, home, file } = nestedHome();
      await makeStore(home, 1);
      const backup = join(root, 'b.db');
      await backupTo(home, backup);
      const inBackup = runsOf(backup);
      const written = killedWriter(home);
      const framed = statSync(`${file}-wal`).size;
      const report = reported(await restore(home, backup));
      // (1) red when the log of the old file is left beside the new one (no checkpoint and no unlink:
      //     the writer's run is applied to the restored file, or the file is unreadable); (2) prints
      //     the runs and the log's size before.
      expect({
        framed: framed > 0,
        restored: runsOf(file),
        kept: report.replaced.kind === 'store' && written in runsOf(report.replaced.kept.path),
      }).toEqual({ framed: true, restored: inBackup, kept: true });
    });

    it('the crash window: a restore killed between the unlink and the rename leaves the old file whole, its rows that were only in the log included', async () => {
      const { root, home, file } = nestedHome();
      await makeStore(home, 1);
      const backup = join(root, 'b.db');
      await backupTo(home, backup);
      const written = killedWriter(home);
      const temporary = join(root, 'tmp');
      mkdirSync(temporary);
      const signal = killedRestore(home, backup, temporary);
      // The killed restore's copy beside the store file: a full copy of the backup, owner-only.
      const left = names(home).filter((n) => n.startsWith('.realm-restore-'));
      const copy = join(home, left[0] ?? 'none');
      // And its scratch folder in the system's temporary folder: owner-only, the backup's copy in it.
      const scratch = names(temporary).filter((n) => n.startsWith('realm-restore-'));
      const scratchCopy = join(temporary, scratch[0] ?? 'none', 'backup.db');
      // (1) red without the checkpoint (the unlink then drops the writer's rows, which were only in the
      //     log); (2) prints the signal, whether the run is there, the side files and what was left.
      expect({
        signal,
        has: written in runsOf(file),
        sides: sideFiles(file),
        left: left.length,
        mode: existsSync(copy) ? (statSync(copy).mode & 0o777).toString(8) : 'none',
        copy: existsSync(copy) ? runsOf(copy) : 'none',
        scratch: scratch.length,
        scratchMode: (statSync(join(temporary, scratch[0] ?? '')).mode & 0o777).toString(8),
        scratchCopy: existsSync(scratchCopy) ? runsOf(scratchCopy) : 'none',
      }).toEqual({
        signal: 'SIGKILL',
        has: true,
        sides: [],
        left: 1,
        mode: '600',
        copy: runsOf(backup),
        scratch: 1,
        scratchMode: '700',
        scratchCopy: runsOf(backup),
      });
    });

    it('an opener of the new file right after the rename (a real child that writes and is killed): its committed run survives', async () => {
      const { root, home, file } = nestedHome();
      await makeStore(home, 1);
      const backup = join(root, 'b.db');
      await backupTo(home, backup);
      let written = '';
      const report = reported(
        await restore(home, backup, {
          // The rename itself, then at once a process that opens the NEW file, writes and is killed:
          // the window between the rename and anything the restore would still do on the old names.
          rename: (from, to) => {
            renameSync(from, to);
            written = killedWriter(home);
          },
        }),
      );
      // (1) red when the old side files are unlinked after the rename (the child's log, with its
      //     committed run, is then deleted); (2) prints whether the run is there.
      expect({ kind: report.replaced.kind, has: written in runsOf(file) }).toEqual({
        kind: 'store',
        has: true,
      });
    });

    it('an opener that connects while the restore holds the file (a real child) opens the restored file after the swap: it reads and writes there, and the restore stays', async () => {
      const { root, home, file } = nestedHome();
      const [restoredRun] = await makeStore(home, 1);
      const backup = join(root, 'b.db');
      await backupTo(home, backup);
      const [oldRun] = await makeStore(home, 1);
      const go = join(root, 'go');
      const child = spawn(
        process.execPath,
        ['--input-type=module', '-e', WAITER, home, go, oldRun!, restoredRun!],
        { cwd: PACKAGE_ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      children.push(child);
      let out = '';
      let err = '';
      child.stdout.setEncoding('utf8').on('data', (d: string) => (out += d));
      child.stderr.setEncoding('utf8').on('data', (d: string) => (err += d));
      const done = new Promise((r) => child.once('exit', r));
      await childReady(
        () => out,
        () => err,
      );
      const outcome = await restore(home, backup, {
        // The hold is held here: the child connects to the OLD file and waits on it; then the rename.
        rename: (from, to) => {
          writeFileSync(go, '');
          // A fixed wait: no event says "the child has connected". On a very slow machine the child
          // may connect only after the rename, and this cell then passes without the opener's check.
          pause(800);
          renameSync(from, to);
        },
      });
      await done;
      const line = out.split('\n').find((l) => l.startsWith('{')) ?? `none: ${err}`;
      const saw = line.startsWith('{') ? (JSON.parse(line) as Record<string, unknown>) : line;
      const db = openDatabase(file);
      const quick = db.prepare('PRAGMA quick_check').get()?.['quick_check'];
      db.close();
      // (1) red without the opener's check that the path still names its file (the child reads and
      //     writes the replaced file, and the next opener sees its rows: the restore undone); (2)
      //     prints what the child saw and wrote, and the runs of the store file afterwards.
      expect({
        replaced: outcome.report?.replaced.kind,
        saw,
        runs: Object.keys(runsOf(file)).sort(),
        quick,
      }).toEqual({
        replaced: 'store',
        saw: { old: false, restored: true, wrote: expect.any(String) },
        runs: [restoredRun!, typeof saw === 'object' ? String(saw['wrote']) : 'none'].sort(),
        quick: 'ok',
      });
    });

    it('a restore whose hold comes after another restore put a new file in place is refused: nothing is unlinked, the other file stays', async () => {
      const { root, home, file } = nestedHome();
      await makeStore(home, 1);
      const backup = join(root, 'b.db');
      await backupTo(home, backup);
      const other = join(root, 'other', '.realm');
      const otherRuns = await makeStore(other, 2);
      const otherCopy = join(root, 'o.db');
      await backupTo(other, otherCopy);
      let live: DatabaseLike | undefined;
      const outcome = await restore(home, backup, {
        // Another restore's swap between this one's open and its hold, and a process already on it.
        beforeHold: async () => {
          renameSync(otherCopy, file);
          live = openDatabase(file);
          live.prepare('SELECT count(*) FROM runs').get();
        },
      });
      const sides = sideFiles(file);
      live?.close();
      // (1) red without the swap's check that the hold is on the file the open settled on (the
      //     restore then unlinks the other file's side files under its process and renames over it);
      //     (2) prints the refusal, the side files and the runs.
      expect({ refused: outcome.refused, sides, runs: Object.keys(runsOf(file)).sort() }).toEqual({
        refused: {
          code: 'STATE_STORE_RESTORE_REFUSED',
          message:
            `Cannot restore from ${backup}: another restore put a new store file in place while ` +
            `this one waited. ${file} was not replaced.`,
        },
        sides: ['-wal', '-shm'],
        runs: [...otherRuns].sort(),
      });
    });

    it('a failure before the swap (the copy beside the store file, the backups folder unwritable, the rename): the store file as it was, no copy left, the words say so', async () => {
      const { root, home, file, folder } = nestedHome();
      await makeStore(home, 2);
      const backup = join(root, 'b.db');
      await backupTo(home, backup);
      await makeStore(home, 1);
      const before = runsOf(file);
      const fail = (): never => {
        throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO', errno: -5 });
      };
      const temporary = await restore(home, backup, { syncFile: fail });
      mkdirSync(folder, { mode: 0o500 });
      const unwritable = await restore(home, backup);
      chmodSync(folder, 0o700);
      const rename = await restore(home, backup, { rename: fail });
      const kept = names(folder).filter((n) => n.startsWith('realm-before-restore-'));
      // (1) red when a failure leaves the store file half restored, leaves the copy in the home, or the
      //     words do not say that the file was not replaced and where the kept copy is; (2) prints the
      //     refusals, the runs and the names.
      expect({
        temporary: temporary.refused,
        unwritable: unwritable.refused,
        rename: rename.refused,
        runs: runsOf(file),
        left: names(home).filter((n) => n.startsWith('.realm-restore-')),
      }).toEqual({
        temporary: {
          code: 'STATE_STORE_RESTORE_REFUSED',
          message: `Cannot restore from ${backup}: i/o error. ${file} was not replaced.`,
        },
        unwritable: {
          code: 'STATE_STORE_RESTORE_REFUSED',
          message: `Cannot restore from ${backup}: the backups folder ${folder} cannot be used: permission denied. ${file} was not replaced.`,
        },
        rename: {
          code: 'STATE_STORE_RESTORE_REFUSED',
          message: `Cannot restore from ${backup}: i/o error. ${file} was not replaced. A copy of it is at ${join(folder, kept[0] ?? 'none')}.`,
        },
        runs: before,
        left: [],
      });
    });
  },
);

describe('#616 R1b — a failure after the rename', { timeout: 120_000 }, () => {
  it('the home folder cannot be flushed after the rename: refused, and the words say the store file was replaced', async () => {
    const { root, home, file } = nestedHome();
    await makeStore(home, 2);
    const backup = join(root, 'b.db');
    await backupTo(home, backup);
    await makeStore(home, 1);
    const outcome = await restore(home, backup, {
      syncFolder: (path) => {
        if (path === home)
          throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO', errno: -5 });
      },
    });
    // (1) red when a failure after the rename says the file was not replaced, or the rename did not
    //     land; (2) prints the refusal and the runs.
    expect({ refused: outcome.refused, runs: runsOf(file) }).toEqual({
      refused: {
        code: 'STATE_STORE_RESTORE_REFUSED',
        message: `Cannot restore from ${backup}: i/o error. ${file} was replaced.`,
      },
      runs: runsOf(backup),
    });
  });
});

describe('#616 R1b — a home with no store file, or an empty one', { timeout: 120_000 }, () => {
  it('a missing home folder: the home made by the store`s own preparation (folder and fences), the file placed by link, nothing kept, and the next open reads it', async () => {
    const { root, home, file, folder } = nestedHome();
    const source = join(root, 'src', '.realm');
    await makeStore(source, 2);
    const backup = join(root, 'b.db');
    await backupTo(source, backup);
    const outcome = await restore(home, backup);
    const h = await openHome({ home }, {});
    h.close();
    // (1) red when the restore refuses a home with no store file, makes it by another route than the
    //     store's preparation (no fences), keeps something, or the file cannot be opened; (2) prints it.
    expect({
      replaced: outcome.report?.replaced,
      home: names(home),
      folder: names(folder),
      runs: runsOf(file),
      mode: (statSync(file).mode & 0o777).toString(8),
    }).toEqual({
      replaced: { kind: 'nothing', empty: false },
      home: ['dedup', 'realm.db', 'replays', 'runs', 'workflows'],
      folder: [],
      runs: runsOf(backup),
      mode: '600',
    });
  });

  it('a home with no store file but a -wal or -shm where it would be: refused, and nothing made (no fence, no file)', async () => {
    const { root, home, file } = nestedHome();
    const source = join(root, 'src', '.realm');
    await makeStore(source, 1);
    const backup = join(root, 'b.db');
    await backupTo(source, backup);
    mkdirSync(home, { recursive: true });
    writeFileSync(`${file}-wal`, 'frames of a store file that was moved');
    const before = names(home);
    const outcome = await restore(home, backup);
    // (1) red when the copy is placed beside a log that is not its own (the next open would apply it),
    //     or when the home's preparation runs before the refusal (its fences then appear); (2) prints
    //     the refusal and the home's whole listing before and after.
    expect({
      refused: outcome.refused,
      before,
      after: names(home),
      wal: readFileSync(`${file}-wal`, 'utf8'),
    }).toEqual({
      refused: {
        code: 'STATE_STORE_RESTORE_REFUSED',
        message:
          `There is no store file at ${file}, but a -wal or -shm file is beside where it would be: ` +
          'they may hold the writes of a store file that was moved or deleted. Move them aside by ' +
          'hand, then run this again. Nothing was changed.',
      },
      before: ['realm.db-wal'],
      after: ['realm.db-wal'],
      wal: 'frames of a store file that was moved',
    });
  });

  it('a racing creator: realm.db appears before the link, and nothing is replaced', async () => {
    const { root, home, file } = nestedHome();
    const source = join(root, 'src', '.realm');
    await makeStore(source, 1);
    const backup = join(root, 'b.db');
    await backupTo(source, backup);
    const outcome = await restore(home, backup, {
      link: (from, to) => {
        writeFileSync(to, 'another');
        linkSync(from, to);
      },
    });
    // (1) red when the copy is placed by rename (it replaces the file that appeared); (2) prints it.
    expect({ refused: outcome.refused, file: readFileSync(file, 'utf8') }).toEqual({
      refused: {
        code: 'STATE_STORE_RESTORE_REFUSED',
        message: 'realm.db appeared while the restore ran; nothing was replaced.',
      },
      file: 'another',
    });
  });

  it('a home that holds an old JSON store folder is refused as the store refuses it', async () => {
    const { root, home } = nestedHome();
    const source = join(root, 'src', '.realm');
    await makeStore(source, 1);
    const backup = join(root, 'b.db');
    await backupTo(source, backup);
    mkdirSync(join(home, 'runs'), { recursive: true });
    const outcome = await restore(home, backup);
    // (1) red when the restore places a store beside the old store's folders; (2) prints it.
    expect({ code: outcome.refused?.code, home: names(home) }).toEqual({
      code: 'STATE_HOME_HOLDS_LEGACY_STORE',
      home: ['runs'],
    });
  });

  it('a zero-length store file: held by another process, refused STATE_STORE_IN_USE; not held, replaced and nothing kept', async () => {
    const { root, home, file, folder } = nestedHome();
    const source = join(root, 'src', '.realm');
    await makeStore(source, 1);
    const backup = join(root, 'b.db');
    await backupTo(source, backup);
    mkdirSync(home, { recursive: true });
    writeFileSync(file, '', { mode: 0o600 });
    const writer = await startChild(WRITING, home);
    const held = await restore(home, backup);
    writer.kill('SIGKILL');
    await new Promise((r) => writer.once('exit', r));
    const free = await restore(home, backup);
    // (1) red when the lock's answer is ignored on a zero-length file (it is replaced under the
    //     writer), or when a zero-length file is refused or kept; (2) prints both outcomes.
    expect({
      held: held.refused,
      free: free.report?.replaced,
      runs: runsOf(file),
      folder: names(folder),
    }).toEqual({
      held: { code: 'STATE_STORE_IN_USE', message: IN_USE(file) },
      free: { kind: 'nothing', empty: true },
      runs: runsOf(backup),
      folder: [],
    });
  });
});

describe('#616 R1b — the damaged-file rule', { timeout: 120_000 }, () => {
  it('a store file with a damaged page: it opens, its kept copy fails, so it is copied as found (byte copy) and replaced; no counts', async () => {
    const { root, home, file, folder } = nestedHome();
    await makeStore(home, 1);
    const backup = join(root, 'b.db');
    await backupTo(home, backup);
    damagePage13(file);
    const original = { hash: hashOf(file), ino: statSync(file).ino };
    const outcome = await restore(home, backup);
    const replaced = outcome.report?.replaced;
    const asFound = replaced?.kind === 'damaged' ? replaced.asFound : 'none';
    // (1) red when the as-found file is renamed instead of copied (its inode is the store file's),
    //     when it is not the original's bytes, or when counts are given; (2) prints it.
    expect({
      kind: replaced?.kind,
      sameBytes: hashOf(asFound) === original.hash,
      newInode: statSync(asFound).ino !== original.ino,
      // The store's open made an empty -wal of its own; it is not the file's and is not copied (A4).
      wal: replaced?.kind === 'damaged' ? replaced.wal : 'none',
      events: outcome.events.map((e) => e.kind),
      runs: runsOf(file),
      name:
        asFound.startsWith(`${folder}/realm-before-restore-`) && asFound.endsWith('-as-found.db'),
    }).toEqual({
      kind: 'damaged',
      sameBytes: true,
      newInode: true,
      wal: undefined,
      events: ['as_found'],
      runs: runsOf(backup),
      name: true,
    });
  });

  it('text garbage with no side file: it goes on, says SQLite could not check for another process, and replaces it; with a -wal or a -shm beside it, it refuses', async () => {
    const { root, home, file } = nestedHome();
    await makeStore(home, 1);
    const backup = join(root, 'b.db');
    await backupTo(home, backup);
    rmSync(file);
    writeFileSync(file, 'this is not a database, not even close to one'.repeat(200), {
      mode: 0o600,
    });
    const garbage = hashOf(file);
    writeFileSync(`${file}-shm`, '');
    const withShm = await restore(home, backup);
    // The side files are looked at before anything opens the file (R1c item 2): none was touched.
    const shmLeft = existsSync(`${file}-shm`);
    rmSync(`${file}-shm`);
    const without = await restore(home, backup);
    // The as-found name holds the second the restore ran in (a real clock): read it from the event.
    const found = without.events.find((e) => e.kind === 'as_found');
    const asFoundName = found?.kind === 'as_found' ? found.asFound : 'none';
    const replaced = without.report?.replaced;
    // (1) red when side files are looked at only after the raw open, or ignored; when the raw open's
    //     lock answer is taken for granted; (2) prints both outcomes.
    expect({
      withShm: withShm.refused,
      shmLeft,
      named: /^realm-before-restore-\d{8}T\d{6}Z-as-found\.db$/.test(
        asFoundName.split('/').pop() ?? '',
      ),
      events: without.events,
      kind: replaced?.kind,
      asFound: replaced?.kind === 'damaged' && hashOf(replaced.asFound) === garbage,
      runs: runsOf(file),
    }).toEqual({
      withShm: {
        code: 'STATE_STORE_RESTORE_REFUSED',
        message:
          `${file} cannot be read as a store, and a -wal or -shm file is beside it: another ` +
          'process may have it open, or a process that was killed left them. Stop every process ' +
          `that uses the home; if none is running, move ${file} and those files aside by hand, ` +
          'then run this again. Nothing was changed.',
      },
      shmLeft: true,
      named: true,
      events: [
        { kind: 'unchecked_lock', path: file },
        {
          kind: 'as_found',
          asFound: asFoundName,
          wal: undefined,
        },
      ],
      kind: 'damaged',
      asFound: true,
      runs: runsOf(backup),
    });
  });

  it('a truncated store file with a WAL header: the side files are looked at before the raw open, which makes a -wal of its own', async () => {
    const { root, home, file } = nestedHome();
    await makeStore(home, 1);
    const backup = join(root, 'b.db');
    await backupTo(home, backup);
    truncateSync(file, 1000);
    const outcome = await restore(home, backup);
    // (1) red when the side files are looked at after the raw open (its own -wal then refuses every
    //     such file); (2) prints the outcome.
    expect({ refused: outcome.refused, kind: outcome.report?.replaced.kind }).toEqual({
      refused: undefined,
      kind: 'damaged',
    });
  });

  it('a valid SQLite database that is not a Realm store: the lock is granted, it is copied as found and replaced; held by another process, refused', async () => {
    const { root, home, file } = nestedHome();
    await makeStore(home, 1);
    const backup = join(root, 'b.db');
    await backupTo(home, backup);
    rmSync(file);
    const other = openDatabase(file);
    other.exec('PRAGMA journal_mode = WAL');
    other.exec('CREATE TABLE notes (text TEXT)');
    other.close();
    const holder = await startChild(HOLDER, home);
    const held = await restore(home, backup);
    holder.kill('SIGKILL');
    await new Promise((r) => holder.once('exit', r));
    const sides = sideFiles(file);
    for (const s of sides) rmSync(`${file}${s}`);
    const free = await restore(home, backup);
    // (1) red when the lock's answer is ignored (the held file is replaced); (2) prints both.
    expect({ held: held.refused, kind: free.report?.replaced.kind, runs: runsOf(file) }).toEqual({
      held: { code: 'STATE_STORE_IN_USE', message: IN_USE(file) },
      kind: 'damaged',
      runs: runsOf(backup),
    });
  });

  it('a valid SQLite database that is not a Realm store, with a killed writer`s log: the open writes the log into it first, so the as-found copy holds those writes and has no -wal', async () => {
    const { root, home, file } = nestedHome();
    await makeStore(home, 1);
    const backup = join(root, 'b.db');
    await backupTo(home, backup);
    rmSync(file);
    const other = openDatabase(file);
    other.exec('PRAGMA journal_mode = WAL');
    other.exec('CREATE TABLE notes (text TEXT)');
    other.close();
    // A writer that commits one row and is killed: the row is only in the log. It opens the file
    // through the store's test entry (the one loader of the built-in SQLite stays the only code that
    // names it: one-loader-616.test.ts).
    spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "import { openForeignConnection } from '@sensigo/realm-store-sqlite/test-support';" +
          'const db = await openForeignConnection(process.argv[1]);' +
          'db.exec("PRAGMA journal_mode = WAL; INSERT INTO notes VALUES (\'the killed writer\')");' +
          "process.kill(process.pid, 'SIGKILL');",
        home,
      ],
      { cwd: PACKAGE_ROOT },
    );
    const logged = statSync(`${file}-wal`).size;
    const outcome = await restore(home, backup);
    const replaced = outcome.report?.replaced;
    const asFound = replaced?.kind === 'damaged' ? replaced.asFound : 'none';
    const look = openDatabase(asFound);
    const notes = look
      .prepare('SELECT text FROM notes')
      .all()
      .map((r) => r['text']);
    look.close();
    // (1) red when the page's sentence stops being true: the row missing from the as-found copy, or an
    //     as-found -wal named although the open wrote the log in; (2) prints it.
    expect({
      logged: logged > 0,
      kind: replaced?.kind,
      wal: replaced?.kind === 'damaged' ? replaced.wal : 'none',
      notes,
    }).toEqual({
      logged: true,
      kind: 'damaged',
      wal: undefined,
      notes: ['the killed writer'],
    });
  });

  it('the damaged path`s crash window: a killed writer`s -wal and -shm beside a file with a damaged page; the as-found pair is the whole original (a kill at the rename seam)', async () => {
    const { root, home, file, folder } = nestedHome();
    await makeStore(home, 1);
    const backup = join(root, 'b.db');
    await backupTo(home, backup);
    const written = killedWriter(home);
    damagePage13(file);
    const original = { main: hashOf(file), wal: hashOf(`${file}-wal`) };
    const signal = killedRestore(home, backup);
    const pair = names(folder).filter((n) => n.includes('-as-found.db'));
    const asFound = join(folder, pair.find((n) => n.endsWith('.db')) ?? 'none');
    const copies = { main: hashOf(asFound), wal: hashOf(`${asFound}-wal`) };
    // The pair, put in a home of its own as realm.db and its -wal, holds the writer's run.
    const look = join(root, 'look');
    mkdirSync(look);
    copyFileSync(asFound, join(look, 'realm.db'));
    copyFileSync(`${asFound}-wal`, join(look, 'realm.db-wal'));
    const db = openDatabase(join(look, 'realm.db'));
    const has = db.prepare('SELECT count(*) AS n FROM runs WHERE id = ?').get(written)?.['n'];
    db.close();
    // (1) red when the -wal is not copied, or the pair is named as the plain kept file; (2) prints
    //     the pair's names, whether it is the original's bytes, and whether it holds the run.
    expect({ signal, pair: pair.length, copies, has }).toEqual({
      signal: 'SIGKILL',
      pair: 2,
      copies: original,
      has: 1,
    });
  });

  it('an opener that connects while the raw hold is held (a real child, an empty store file) opens the restored file after the swap: it reads and writes there', async () => {
    const { root, home, file } = nestedHome();
    const source = join(root, 'src', '.realm');
    const [restoredRun] = await makeStore(source, 1);
    const backup = join(root, 'b.db');
    await backupTo(source, backup);
    mkdirSync(home, { recursive: true });
    writeFileSync(file, '', { mode: 0o600 });
    const go = join(root, 'go');
    const child = spawn(
      process.execPath,
      ['--input-type=module', '-e', WAITER, home, go, 'none', restoredRun!],
      { cwd: PACKAGE_ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    children.push(child);
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (out += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (err += d));
    const done = new Promise((r) => child.once('exit', r));
    await childReady(
      () => out,
      () => err,
    );
    const outcome = await restore(home, backup, {
      // The raw hold is held here: the child connects to the EMPTY file and waits; then the rename.
      rename: (from, to) => {
        writeFileSync(go, '');
        // A fixed wait: no event says "the child has connected" (see the cell above).
        pause(800);
        renameSync(from, to);
      },
    });
    await done;
    const line = out.split('\n').find((l) => l.startsWith('{')) ?? `none: ${err}`;
    const saw = line.startsWith('{') ? (JSON.parse(line) as Record<string, unknown>) : line;
    // (1) red without the opener's check that the path still names its file (the child sets the
    //     replaced empty file up as a store of its own and writes there: its run is not in the
    //     restored file); (2) prints what the child saw and wrote, and the runs afterwards.
    expect({
      replaced: outcome.report?.replaced.kind,
      saw,
      runs: Object.keys(runsOf(file)).sort(),
    }).toEqual({
      replaced: 'nothing',
      saw: { old: false, restored: true, wrote: expect.any(String) },
      runs: [restoredRun!, typeof saw === 'object' ? String(saw['wrote']) : 'none'].sort(),
    });
  });

  it('the raw path`s own guard: a file renamed over realm.db between the raw connection and its lock is refused, nothing unlinked', async () => {
    const { root, home, file } = nestedHome();
    const source = join(root, 'src', '.realm');
    await makeStore(source, 1);
    const backup = join(root, 'b.db');
    await backupTo(source, backup);
    const other = join(root, 'other', '.realm');
    const otherRuns = await makeStore(other, 2);
    const otherCopy = join(root, 'o.db');
    await backupTo(other, otherCopy);
    mkdirSync(home, { recursive: true });
    writeFileSync(file, '', { mode: 0o600 });
    let live: DatabaseLike | undefined;
    const outcome = await restore(home, backup, {
      // Another restore's swap after this one's raw connection opened, and a process already on it.
      beforeHold: async () => {
        renameSync(otherCopy, file);
        live = openDatabase(file);
        live.prepare('SELECT count(*) FROM runs').get();
      },
    });
    const sides = sideFiles(file);
    live?.close();
    // (1) red without the raw path's check of the held file (the restore unlinks the other file's
    //     side files under its process and renames over it); (2) prints the refusal and the runs.
    expect({ refused: outcome.refused, sides, runs: Object.keys(runsOf(file)).sort() }).toEqual({
      refused: {
        code: 'STATE_STORE_RESTORE_REFUSED',
        message:
          `Cannot restore from ${backup}: another restore put a new store file in place while ` +
          `this one waited. ${file} was not replaced.`,
      },
      sides: ['-wal', '-shm'],
      runs: [...otherRuns].sort(),
    });
  });

  it('item 2: a store file whose header SQLite cannot read, with a killed writer`s -wal and -shm: refused before any open, the file and both side files as they were', async () => {
    const { root, home, file, folder } = nestedHome();
    await makeStore(home, 1);
    const backup = join(root, 'b.db');
    await backupTo(home, backup);
    killedWriter(home);
    const fd = openSync(file, 'r+');
    writeSync(fd, Buffer.from('not a db header!'), 0, 16, 0);
    closeSync(fd);
    const before = [hashOf(file), hashOf(`${file}-wal`), hashOf(`${file}-shm`)];
    const outcome = await restore(home, backup);
    // (1) red when the side files are looked at only after the store's open, which applies the log
    //     to the file and deletes both when no other process holds them (the restore then goes on with
    //     no evidence); (2) prints the refusal and whether anything changed.
    expect({
      refused: outcome.refused,
      unchanged: [hashOf(file), hashOf(`${file}-wal`), hashOf(`${file}-shm`)].every(
        (h, i) => h === before[i],
      ),
      folder: names(folder),
    }).toEqual({
      refused: {
        code: 'STATE_STORE_RESTORE_REFUSED',
        message:
          `${file} cannot be read as a store, and a -wal or -shm file is beside it: another ` +
          'process may have it open, or a process that was killed left them. Stop every process ' +
          `that uses the home; if none is running, move ${file} and those files aside by hand, ` +
          'then run this again. Nothing was changed.',
      },
      unchanged: true,
      folder: [],
    });
  });

  it('the damaged route, the rename fails: the words name the as-found pair, the pair is the original byte for byte and holds its rows', async () => {
    const { root, home, file } = nestedHome();
    await makeStore(home, 1);
    const backup = join(root, 'b.db');
    await backupTo(home, backup);
    const written = killedWriter(home);
    damagePage13(file);
    const original = { main: hashOf(file), wal: hashOf(`${file}-wal`) };
    const outcome = await restore(home, backup, {
      rename: () => {
        throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO', errno: -5 });
      },
    });
    const found = outcome.events.find((e) => e.kind === 'as_found');
    const asFound = found?.kind === 'as_found' ? found.asFound : 'none';
    const look = join(root, 'look');
    mkdirSync(look);
    copyFileSync(asFound, join(look, 'realm.db'));
    copyFileSync(`${asFound}-wal`, join(look, 'realm.db-wal'));
    const db = openDatabase(join(look, 'realm.db'));
    const has = db.prepare('SELECT count(*) AS n FROM runs WHERE id = ?').get(written)?.['n'];
    db.close();
    // (1) red when the failure's words do not name the as-found pair (by then the only whole
    //     original: the side files may be unlinked); (2) prints the refusal, the pair and its rows.
    expect({
      refused: outcome.refused,
      pair: { main: hashOf(asFound), wal: hashOf(`${asFound}-wal`) },
      has,
    }).toEqual({
      refused: {
        code: 'STATE_STORE_RESTORE_REFUSED',
        message:
          `Cannot restore from ${backup}: i/o error. ${file} was not replaced. A copy of it is at ` +
          `${asFound}, and its -wal at ${asFound}-wal.`,
      },
      pair: original,
      has: 1,
    });
  });

  it.skipIf(process.getuid?.() === 0)(
    'the damaged route, the backups folder cannot be written: the damaged file untouched, nothing replaced, no copy left',
    async () => {
      const { root, home, file, folder } = nestedHome();
      await makeStore(home, 1);
      const backup = join(root, 'b.db');
      await backupTo(home, backup);
      rmSync(file);
      writeFileSync(file, 'not a database '.repeat(500), { mode: 0o600 });
      const before = hashOf(file);
      mkdirSync(folder, { mode: 0o500 });
      const outcome = await restore(home, backup);
      chmodSync(folder, 0o700);
      // (1) red when a damaged file is replaced without its as-found copy; (2) prints it.
      expect({
        code: outcome.refused?.code,
        unchanged: hashOf(file) === before,
        folder: names(folder),
        left: names(home).filter((n) => n.startsWith('.realm-restore-')),
      }).toEqual({ code: 'STATE_STORE_RESTORE_REFUSED', unchanged: true, folder: [], left: [] });
    },
  );

  it('the damaged route, the as-found copy fails midway: what was copied is removed, the words say so, the file untouched', async () => {
    const { root, home, file, folder } = nestedHome();
    await makeStore(home, 1);
    const backup = join(root, 'b.db');
    await backupTo(home, backup);
    rmSync(file);
    writeFileSync(file, 'not a database '.repeat(500), { mode: 0o600 });
    const before = hashOf(file);
    const outcome = await restore(home, backup, {
      // The flush of the as-found copy fails (a full disk); every other flush is skipped.
      syncFile: (path) => {
        if (path.includes('-as-found')) {
          throw Object.assign(new Error('ENOSPC: no space left on device'), {
            code: 'ENOSPC',
            errno: -28,
          });
        }
      },
    });
    // (1) red when a partial as-found copy is left (named as if it were the original) or the words do
    //     not say it was removed; (2) prints the refusal and what is left.
    expect({
      refused: outcome.refused,
      unchanged: hashOf(file) === before,
      asFound: names(folder).filter((n) => n.includes('-as-found')),
    }).toEqual({
      refused: {
        code: 'STATE_STORE_RESTORE_REFUSED',
        message:
          `Cannot restore from ${backup}: the copy of it as it was could not be made: no space left ` +
          `on device; what was copied was removed. ${file} was not replaced.`,
      },
      unchanged: true,
      asFound: [],
    });
  });

  it('two restores over one damaged file in the same second: the second names the as-found copy that is already there, and leaves it', async () => {
    const { root, home, file, folder } = nestedHome();
    await makeStore(home, 1);
    const backup = join(root, 'b.db');
    await backupTo(home, backup);
    rmSync(file);
    writeFileSync(file, 'not a database '.repeat(500), { mode: 0o600 });
    // The names this restore can take: this second's and the next three, each made already.
    mkdirSync(folder, { mode: 0o700 });
    const now = Date.now();
    const taken = [0, 1, 2, 3].map((k) =>
      join(folder, `realm-before-restore-${backupStamp(new Date(now + k * 1000))}-as-found.db`),
    );
    for (const path of taken) writeFileSync(path, 'the first restore');
    const outcome = await restore(home, backup);
    const named = /the as-found copy (\S+) already exists/.exec(
      outcome.refused?.message ?? '',
    )?.[1];
    // (1) red when the collision is reported in the system's bare words, or the file there is removed
    //     or touched; (2) prints the refusal and the files.
    expect({
      refused: outcome.refused,
      named: named !== undefined && taken.includes(named),
      there: taken.map((p) => readFileSync(p, 'utf8')),
    }).toEqual({
      refused: {
        code: 'STATE_STORE_RESTORE_REFUSED',
        message:
          `Cannot restore from ${backup}: the as-found copy ${named} already exists (another ` +
          `restore ran in the same second). ${file} was not replaced.`,
      },
      named: true,
      there: taken.map(() => 'the first restore'),
    });
  });

  it('a symbolic link, a folder or a FIFO at realm.db: the store`s own refusal, nothing changed, nothing copied', async () => {
    const { root, home, file, folder } = nestedHome();
    await makeStore(home, 1);
    const backup = join(root, 'b.db');
    await backupTo(home, backup);
    rmSync(file);
    const target = join(root, 'garbage.db');
    writeFileSync(target, 'not a database '.repeat(500));
    const garbage = hashOf(target);
    const kinds: Array<[string, () => void]> = [
      ['a symbolic link', () => symlinkSync(target, file)],
      ['a folder', () => mkdirSync(file)],
      ['a FIFO', () => spawnSync('mkfifo', [file])],
    ];
    for (const [kind, make] of kinds) {
      rmSync(file, { recursive: true, force: true });
      make();
      const outcome = await restore(home, backup);
      // (1) red when the guard is gone (the link is followed, copied and replaced; a FIFO blocks the
      //     copy); (2) prints the case and its outcome.
      expect({
        kind,
        code: outcome.refused?.code,
        link: lstatSync(file).isSymbolicLink() || kind !== 'a symbolic link',
        target: hashOf(target) === garbage,
        folder: names(folder),
      }).toEqual({
        kind,
        code: 'STATE_STORE_SETTINGS_REFUSED',
        link: true,
        target: true,
        folder: [],
      });
    }
  });

  it('an empty store file that a command sets up while the restore waits for its lock: refused, the runs written meanwhile intact', async () => {
    const { root, home, file } = nestedHome();
    const source = join(root, 'src', '.realm');
    await makeStore(source, 1);
    const backup = join(root, 'b.db');
    await backupTo(source, backup);
    mkdirSync(home, { recursive: true });
    writeFileSync(file, '', { mode: 0o600 });
    let written: string[] = [];
    const outcome = await restore(home, backup, {
      // Between the classification and the raw lock: a short-lived Realm command sets the file up.
      beforeHold: async () => {
        written = await makeStore(home, 2);
      },
    });
    // (1) red without the re-check under the lock (the runs written meanwhile are replaced, nothing
    //     kept); (2) prints the refusal and the runs.
    expect({ refused: outcome.refused, runs: Object.keys(runsOf(file)).sort() }).toEqual({
      refused: {
        code: 'STATE_STORE_RESTORE_REFUSED',
        message: 'realm.db appeared while the restore ran; nothing was replaced.',
      },
      runs: [...written].sort(),
    });
  });

  it('F5: a store whose only damage is an index page: the table reads, the kept copy fails, and the damaged route restores (a regression pin)', async () => {
    const { root, home, file } = nestedHome();
    await makeStore(home, 3);
    const backup = join(root, 'b.db');
    await backupTo(home, backup);
    const db = openDatabase(file);
    const rootpage = Number(
      db.prepare("SELECT rootpage FROM sqlite_master WHERE name = 'runs_by_terminal'").get()?.[
        'rootpage'
      ],
    );
    db.close();
    const fd = openSync(file, 'r+');
    writeSync(fd, Buffer.from([0x00]), 0, 1, (rootpage - 1) * 16384);
    writeSync(fd, Buffer.from([0xff, 0xff]), 0, 2, (rootpage - 1) * 16384 + 3);
    closeSync(fd);
    const read = openDatabase(file);
    const table = Number(read.prepare('SELECT count(*) AS n FROM runs NOT INDEXED').get()?.['n']);
    read.close();
    const outcome = await restore(home, backup);
    // (1) red when such a file ends "was not replaced" (a damaged index met first by the counts)
    //     instead of the damaged route; (2) prints it.
    expect({ table, kind: outcome.report?.replaced.kind, runs: runsOf(file) }).toEqual({
      table: 3,
      kind: 'damaged',
      runs: runsOf(backup),
    });
  });

  it('a kept copy that fails SQLite`s quick check: it stays under the kept name, unverified, and the file is copied as found under its own names', async () => {
    const { root, home, file, folder } = nestedHome();
    await makeStore(home, 1);
    const backup = join(root, 'b.db');
    await backupTo(home, backup);
    const original = hashOf(file);
    let calls = 0;
    const outcome = await restore(home, backup, {
      // The backup's own check first (passes), then the kept copy's (fails).
      quickCheck: (db) => {
        calls += 1;
        if (calls === 1) {
          return db
            .prepare('PRAGMA quick_check')
            .all()
            .map((r) => String(Object.values(r)[0]));
        }
        return ['row 1 missing from index runs_by_terminal'];
      },
    });
    const files = names(folder).map((n) => n.replace(/\d{8}T\d{6}Z/, '<t>'));
    const found = outcome.events.find((e) => e.kind === 'as_found');
    // (1) red when the unverified copy takes the damaged route's names, or the damaged route is not
    //     taken; (2) prints the backups folder and the outcome.
    expect({
      kind: outcome.report?.replaced.kind,
      files,
      asFound: found?.kind === 'as_found' ? hashOf(found.asFound) === original : 'none',
    }).toEqual({
      kind: 'damaged',
      files: ['realm-before-restore-<t>-as-found.db', 'realm-before-restore-<t>.db'],
      asFound: true,
    });
  });

  it('A1: a home that never had its fence files, a refusal after the store`s open: the four fence files appear, the store file is as it was', async () => {
    const { root, home, file } = nestedHome();
    await makeStore(home, 1);
    const backup = join(root, 'b.db');
    await backupTo(home, backup);
    for (const fence of ['dedup', 'replays', 'runs', 'workflows'])
      rmSync(join(home, fence), { force: true });
    const before = { names: names(home), file: hashOf(file) };
    const holder = await startChild(HOLDER, home);
    const outcome = await restore(home, backup);
    holder.kill('SIGKILL');
    // (1) red when the page's sentence stops being true (no fence made, or the store file changed);
    //     (2) prints the refusal and the home.
    expect({
      code: outcome.refused?.code,
      before: before.names,
      after: names(home).filter((n) => !n.startsWith('realm.db')),
      file: hashOf(file) === before.file,
    }).toEqual({
      code: 'STATE_STORE_IN_USE',
      before: ['realm.db'],
      after: ['dedup', 'replays', 'runs', 'workflows'],
      file: true,
    });
  });

  it('a store file written by a newer Realm: refused with the store`s message, nothing changed', async () => {
    const { root, home, file, folder } = nestedHome();
    await makeStore(home, 1);
    const backup = join(root, 'b.db');
    await backupTo(home, backup);
    setVersion(file, 3);
    const before = hashOf(file);
    const outcome = await restore(home, backup);
    // (1) red when a newer file is replaced instead of refused; (2) prints it.
    expect({
      code: outcome.refused?.code,
      unchanged: hashOf(file) === before,
      folder: names(folder),
      left: names(home).filter((n) => n.startsWith('.realm-restore-')),
    }).toEqual({ code: 'STATE_STORE_VERSION_NEWER', unchanged: true, folder: [], left: [] });
  });
});
