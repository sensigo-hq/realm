// db-restore-r1b.test.ts — #616 R1b part one (prompts/feat-616-r1b-restore.md, -split.md), on the
// BUILT CLI: `realm db restore <backup>` as a person runs it. The real cases: a restore over a store
// whose runs changed (the kept copy's line, the restored line, the counts); a backup that holds the
// same runs; an older backup (0.49.0's recorded store); a home with no store file, and a store file
// SQLite cannot read, refused (part two restores over both); the refusals of the backup argument, each
// one `Error:` line and exit 1; another process on the store; the help. Each printed line is held to
// the page's sentence that quotes it (`docs/reference/cli/realm-db.md`), and the guide's and the
// changelog's sentences about going back are held to the cells that execute them. The home is
// `<scratch>/h/.realm` with HOME set to `<scratch>/h`, so its backups folder is
// `<scratch>/h/.realm-backups`, never one other cells share.
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { REALM_STORE_SCHEMA_VERSION } from '@sensigo/realm';
import { openRealmHome, openRealmHomeForMaintenance } from '@sensigo/realm-store-sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = join(HERE, '..', '..');
const DIST_CLI = join(CLI_ROOT, 'dist', 'index.js');
const ROOT = join(CLI_ROOT, '..', '..');
const CORPUS_049 = join(HERE, '..', 'corpus', '0.49.0', 'realm.db.gz');
const PAGE = 'docs/reference/cli/realm-db.md';
const GUIDE = 'docs/guides/upgrade.md';
const CHANGELOG = 'CHANGELOG.md';
const STORE_CELLS = 'packages/store-sqlite/src/restore-r1b.test.ts';

let root = '';
let user = '';
let base = '';
let home = '';
let file = '';
let folder = '';
const children: ChildProcess[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'realm-616-r1b-cli-'));
  base = mkdtempSync(join(tmpdir(), 'realm-616-r1b-cwd-'));
  user = join(root, 'h');
  home = join(user, '.realm');
  file = join(home, 'realm.db');
  folder = join(user, '.realm-backups');
});
afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  rmSync(root, { recursive: true, force: true });
  rmSync(base, { recursive: true, force: true });
});

interface Run {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs the built `realm` with HOME set to `<scratch>/h`; a run that hangs is killed (a red). */
function realm(args: string[]): Run {
  const r = spawnSync(process.execPath, [DIST_CLI, ...args], {
    cwd: base,
    env: { PATH: process.env['PATH'] ?? '', HOME: user, REALM_NO_NUDGE: '1' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
    killSignal: 'SIGKILL',
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** A path as the CLI prints it when its output is piped: the scratch HOME's path is masked. */
function shown(path: string): string {
  return path.replace(user, '[REDACTED]');
}

/** A store in `at` with `runs` runs; their ids. */
async function makeStore(at: string, runs: number): Promise<string[]> {
  const h = await openRealmHome({ home: at });
  const ids: string[] = [];
  for (let i = 0; i < runs; i++) {
    ids.push(
      (
        await h.runStore.create({
          workflowId: 'triage',
          workflowVersion: 1,
          params: {},
          extensionIdentity: [],
        })
      ).record.id,
    );
  }
  h.close();
  return ids;
}

/** `realm db backup`'s copy of the home at `at`, to `path`. */
async function backupTo(at: string, path: string): Promise<void> {
  const m = await openRealmHomeForMaintenance({ home: at });
  try {
    await m.backup(path);
  } finally {
    m.close();
  }
}

/** The one kept file's path in the backups folder. */
function keptFile(suffix = '.db'): string {
  const name = readdirSync(folder).find(
    (n) => n.startsWith('realm-before-restore-') && n.endsWith(suffix),
  );
  return join(folder, name ?? 'none');
}

const flat = (t: string): string => t.replace(/\s+/g, ' ');
/** (1) red when the page no longer holds the sentence word for word; (2) prints it and its proof. */
function claim(page: string, sentence: string, provedBy: string): void {
  expect(
    flat(readFileSync(join(ROOT, page), 'utf8')),
    `${page} no longer says: ${sentence} (proved by: ${provedBy})`,
  ).toContain(flat(sentence));
}

// Each cell starts the built CLI (a cold start each time), so the describe carries its own budget
// (spawn-budget-guard.test.ts).
describe('#616 R1b — realm db restore, on the built CLI', { timeout: 120_000 }, () => {
  it('(1) over a store whose runs changed: the kept copy`s line, the restored line and the counts, on standard output', async () => {
    await makeStore(home, 2);
    const backup = join(base, 'b.db');
    await backupTo(home, backup);
    await makeStore(home, 1);
    const r = realm(['db', 'restore', backup]);
    const kept = keptFile();
    // (1) red when a line is missing or out of order, a count is wrong, or a line goes to standard
    //     error; (2) prints the run.
    expect(r).toEqual({
      code: 0,
      stdout:
        `Backed up ${shown(file)} (schema version ${REALM_STORE_SCHEMA_VERSION}, ${readFileSync(kept).length} bytes) to ` +
        `${shown(kept)}; the copy passes SQLite's quick check.\n` +
        `Restored ${shown(file)} from ${backup} (schema version ${REALM_STORE_SCHEMA_VERSION}).\n` +
        'Left out of the restored file: 1 run(s) that only the replaced file had, and the replaced ' +
        "file's version of 0 run(s) that both files hold. Brought back: 0 run(s) that only the " +
        'backup had. All of the replaced file is in the copy above. Only runs are counted.\n',
      stderr: '',
    });
    claim(PAGE, '`Restored <home>/realm.db from <backup> (schema version <m>).`', 'cell 1');
    claim(
      PAGE,
      "`Left out of the restored file: <a> run(s) that only the replaced file had, and the replaced file's version of <b> run(s) that both files hold. Brought back: <c> run(s) that only the backup had. All of the replaced file is in the copy above. Only runs are counted.`",
      `cell 1; the counts' values: ${STORE_CELLS}, the first cell`,
    );
    claim(PAGE, "It prints `realm db backup`'s line for the kept file, then:", 'cell 1');
  });

  it('(2) a backup that holds the same runs: the same-runs line (and the page`s undo sentence, executed by the store`s undo cell)', async () => {
    await makeStore(home, 1);
    const backup = join(base, 'b.db');
    await backupTo(home, backup);
    const r = realm(['db', 'restore', backup]);
    // (1) red when the same runs are not said so; (2) prints the line.
    expect(r.stdout.split('\n')[2]).toBe('The file it replaced and the backup hold the same runs.');
    claim(PAGE, '`The file it replaced and the backup hold the same runs.`', 'cell 2');
    claim(
      PAGE,
      'To undo a restore, restore the kept file: `realm db restore ~/.realm-backups/realm-before-restore-<UTC time>.db`.',
      `${STORE_CELLS}, the undo cell`,
    );
  });

  it('(3) an older backup (the store 0.49.0 recorded): restored, and the last line says what comes next', async () => {
    await makeStore(home, 1);
    const backup = join(base, 'v1.db');
    writeFileSync(backup, gunzipSync(readFileSync(CORPUS_049)), { mode: 0o600 });
    const r = realm(['db', 'restore', backup]);
    const migrate = realm(['db', 'migrate', '--no-backup']);
    // (1) red when an older backup is refused, or the line is missing; (2) prints the runs.
    expect({
      code: r.code,
      last: r.stdout.trim().split('\n').pop(),
      migrate: migrate.code,
    }).toEqual({
      code: 0,
      last:
        `This backup is at schema version 1 and this Realm writes version ${REALM_STORE_SCHEMA_VERSION}. To use it with this ` +
        'Realm, run `realm db migrate`; to use it with an older Realm, install that Realm now.',
      migrate: 0,
    });
    claim(
      PAGE,
      'When the backup is at an older schema version than this Realm writes, a last line says what comes next: ``This backup is at schema version <m> and this Realm writes version <r>. To use it with this Realm, run `realm db migrate`; to use it with an older Realm, install that Realm now.``',
      'cell 3',
    );
  });

  it('(4) a home with no store file, then one with an empty store file: the copy placed, nothing kept, each in its own words', async () => {
    const source = join(root, 'src', '.realm');
    await makeStore(source, 1);
    const backup = join(base, 'b.db');
    await backupTo(source, backup);
    const r = realm(['db', 'restore', backup]);
    const kept = existsSync(folder);
    rmSync(home, { recursive: true, force: true });
    mkdirSync(home, { recursive: true });
    writeFileSync(file, '', { mode: 0o600 });
    const empty = realm(['db', 'restore', backup]);
    // (1) red when a home with no store, or an empty store file, is refused, something is kept, or
    //     the empty file is said to be missing; (2) prints both runs.
    expect({ r, kept, empty }).toEqual({
      r: {
        code: 0,
        stdout: `Restored ${shown(file)} from ${backup} (schema version ${REALM_STORE_SCHEMA_VERSION}). The home had no store file, so nothing was replaced.\n`,
        stderr: '',
      },
      kept: false,
      empty: {
        code: 0,
        stdout: `Restored ${shown(file)} from ${backup} (schema version ${REALM_STORE_SCHEMA_VERSION}). The store file was empty, so nothing was replaced.\n`,
        stderr: '',
      },
    });
    claim(
      PAGE,
      '`Restored <home>/realm.db from <backup> (schema version <m>). The home had no store file, so nothing was replaced.`',
      'cell 4',
    );
  });

  it('(5) a store file SQLite cannot read, with no side file: the line on standard error, the as-found line, then the restored line', async () => {
    await makeStore(home, 1);
    const backup = join(base, 'b.db');
    await backupTo(home, backup);
    rmSync(file);
    writeFileSync(file, 'not a database '.repeat(500), { mode: 0o600 });
    const r = realm(['db', 'restore', backup]);
    const asFound = keptFile('-as-found.db');
    // (1) red when the line goes to standard output, the as-found line is missing, or counts are
    //     printed; (2) prints the run.
    expect(r).toEqual({
      code: 0,
      stdout:
        `${shown(file)} could not be read as a store, so it was copied as it was to ` +
        `${shown(asFound)} (and its -wal beside it, if it had one). What was in it could not be ` +
        'counted.\n' +
        `Restored ${shown(file)} from ${backup} (schema version ${REALM_STORE_SCHEMA_VERSION}).\n`,
      stderr:
        `SQLite could not check whether another process has ${shown(file)} open (it cannot read ` +
        'the file as a database) and no -wal or -shm file is beside it.\n',
    });
    claim(
      PAGE,
      '`<home>/realm.db could not be read as a store, so it was copied as it was to <as-found file> (and its -wal beside it, if it had one). What was in it could not be counted.`',
      'cell 5',
    );
    claim(
      PAGE,
      'when neither is there, it goes on, and prints on standard error `SQLite could not check whether another process has <home>/realm.db open (it cannot read the file as a database) and no -wal or -shm file is beside it.`',
      'cell 5',
    );
  });

  it('(6) refusals: one Error line on standard error, exit 1, nothing on standard output, nothing made', async () => {
    await makeStore(home, 1);
    const backup = join(base, 'b.db');
    await backupTo(home, backup);
    const link = join(base, 'link.db');
    symlinkSync(backup, link);
    const dir = join(base, 'dir.db');
    mkdirSync(dir);
    const newer = join(base, 'newer.db');
    await backupTo(home, newer);
    // A newer copy: its schema version set past this Realm's through the store's own connection.
    const { openForeignConnection } = await import('@sensigo/realm-store-sqlite/test-support');
    const scratchHome = join(root, 'n', '.realm');
    mkdirSync(scratchHome, { recursive: true });
    writeFileSync(join(scratchHome, 'realm.db'), readFileSync(newer));
    const c = await openForeignConnection(scratchHome);
    c.exec(`PRAGMA user_version = ${REALM_STORE_SCHEMA_VERSION + 1}`);
    c.close();
    writeFileSync(newer, readFileSync(join(scratchHome, 'realm.db')));
    const error = (message: string): Run => ({
      code: 1,
      stdout: '',
      stderr: `Error: ${message}\n`,
    });
    const runs = {
      missing: realm(['db', 'restore', join(base, 'missing.db')]),
      link: realm(['db', 'restore', link]),
      dir: realm(['db', 'restore', dir]),
      itself: realm(['db', 'restore', file]),
      newer: realm(['db', 'restore', newer]),
    };
    // (1) red when a refusal is not one Error line (a stack escapes: the code is not in the CLI's
    //     list), or its words change; (2) prints each run.
    expect({ runs, folder: existsSync(folder) }).toEqual({
      runs: {
        missing: error(
          `Cannot restore from ${join(base, 'missing.db')}: no such file or directory. Nothing was changed.`,
        ),
        link: error(`Cannot restore from ${link}: it is a symbolic link. Nothing was changed.`),
        dir: error(`Cannot restore from ${dir}: it is not a file. Nothing was changed.`),
        itself: error(
          `Cannot restore from ${shown(file)}: it is the store file itself. Nothing was changed.`,
        ),
        newer: error(
          `Cannot restore from ${newer}: Written by a later version of Realm (schema version ${REALM_STORE_SCHEMA_VERSION + 1}; this version reads up to ${REALM_STORE_SCHEMA_VERSION}). Nothing was changed.`,
        ),
      },
      folder: false,
    });
    claim(
      PAGE,
      "`Cannot restore from <backup>: <the system's reason>. Nothing was changed.`",
      'cell 6',
    );
    claim(
      PAGE,
      '`Cannot restore from <backup>: it is a symbolic link. Nothing was changed.`',
      'cell 6',
    );
    claim(PAGE, '`Cannot restore from <backup>: it is not a file. Nothing was changed.`', 'cell 6');
    claim(
      PAGE,
      '`Cannot restore from <backup>: it is the store file itself. Nothing was changed.`',
      'cell 6; the hard link and the symlinked home: the store cell of the backup argument',
    );
    claim(
      PAGE,
      '`Cannot restore from <backup>: Written by a later version of Realm (schema version <n>; this version reads up to <m>). Nothing was changed.`',
      'cell 6',
    );
  });

  it('(7) another process on the store: refused STATE_STORE_IN_USE, in one Error line', async () => {
    await makeStore(home, 1);
    const backup = join(base, 'b.db');
    await backupTo(home, backup);
    const holder = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "import { openForeignConnection } from '@sensigo/realm-store-sqlite/test-support';" +
          'const db = await openForeignConnection(process.argv[1]);' +
          "db.prepare('SELECT count(*) FROM sqlite_master').get();" +
          "process.stdout.write('ready\\n');" +
          'setInterval(() => {}, 1000);',
        home,
      ],
      { cwd: join(ROOT, 'packages', 'store-sqlite'), stdio: ['ignore', 'pipe', 'ignore'] },
    );
    children.push(holder);
    await new Promise((resolve) => holder.stdout.once('data', resolve));
    const r = realm(['db', 'restore', backup]);
    // (1) red when the hold is missing or its refusal is not printed as one line; (2) prints the run.
    expect(r).toEqual({
      code: 1,
      stdout: '',
      stderr:
        `Error: Another process has ${shown(file)} open: a Realm agent, server or command, an MCP ` +
        'server that an assistant or editor keeps running, or another program such as a SQLite ' +
        'browser. Stop it and run this again. Nothing was changed.\n',
    });
  });

  it('(8) realm db --help lists restore, and realm db restore --help names its argument', () => {
    const db = realm(['db', '--help']);
    const help = realm(['db', 'restore', '--help']);
    const line = (text: string, start: RegExp): string =>
      (text.split('\n').find((l) => start.test(l)) ?? 'none').trim().replace(/\s+/g, ' ');
    // (1) red when restore is not in the group, or its argument not named; (2) prints the lines.
    expect({ db: line(db.stdout, /^\s+restore\s/), usage: line(help.stdout, /^Usage:/) }).toEqual({
      db: 'restore <backup> Put a backup in place of the store file; the file it',
      usage: 'Usage: realm db restore [options] <backup>',
    });
  });
});

// The page's other sentences about `restore`, each quoted word for word with the cell that executes it.
const ENV_PAGE = 'docs/reference/environment-and-files.md';
const CODES = 'docs/reference/error-codes.md';
describe('#616 R1b — the page, the files page and the codes page say what realm db restore does', () => {
  it.each([
    [
      'step 1',
      "It copies the backup into a private folder of its own in the system's temporary folder, readable by your account only, and checks the copy there: that it is a Realm store, that SQLite's quick check passes, and that this Realm reads its schema version. The backup itself is only read: a backup in a read-only folder can be restored, and nothing is created beside it.",
      `${STORE_CELLS}: the cells of a non-store, damaged or newer backup and of a backup in DELETE journal mode, 0644 or a read-only folder`,
    ],
    [
      'step 2',
      'It puts a second copy of the checked backup in the home, as `.realm-restore-<pid>-<random>.db`, readable and writable by your account only (mode 600). A restore that was killed may leave one: it is a full copy of the backup, which you can delete when no restore is running.',
      `${STORE_CELLS}: the crash window cell (the copy a killed restore leaves: mode 600, the backup's runs)`,
    ],
    [
      'step 3',
      'It makes sure that no other process has the store file open, and keeps it so until it is done. When a Realm process has it open, even an idle one, the command refuses and changes nothing. (A program that only holds an empty store file open takes no lock, and is not seen.)',
      `cell 7; ${STORE_CELLS}: the idle process cell`,
    ],
    [
      'step 3, a command started meanwhile',
      'A Realm command started while the restore runs waits, then opens the restored file (or fails as busy after about 5 seconds).',
      `${STORE_CELLS}: the cell of an opener that connects while the restore holds the file (a real child); the busy refusal: the open's own budget, unchanged`,
    ],
    [
      'an empty backup',
      'an empty file: `Cannot restore from <backup>: it is empty: it holds no store. Nothing was changed.`',
      `${STORE_CELLS}: the backup argument cell`,
    ],
    [
      'an empty store file',
      'or, over an empty store file: `Restored <home>/realm.db from <backup> (schema version <m>). The store file was empty, so nothing was replaced.`',
      'cell 4',
    ],
    [
      'an unverified kept copy',
      "When the kept copy was made but fails SQLite's quick check, it stays under the kept name, unverified, and the file is then also copied as found, under its own names.",
      `${STORE_CELLS}: the cell of a kept copy that fails SQLite's quick check`,
    ],
    [
      'the fence files and "Nothing was changed"',
      '"Nothing was changed" is about the store file: a refusal that comes after the store\'s open, in a home that does not have them yet, may leave Realm\'s four small read-only fence files in the home (`runs`, `dedup`, `replays` and `workflows`), as any open of the store does.',
      `${STORE_CELLS}: the A1 cell (a fence-less home, a holder: the four files appear, the store file as it was)`,
    ],
    [
      'restoring a copy',
      '[`realm db restore <backup>`](#restore) puts the copy back: over the store file, over a store file that cannot be read as a store, and into a home with no store file, on a new machine for one. It refuses a store file that a newer Realm wrote, and one that Realm cannot open for another reason (a folder or a link where the file should be, a home on a network filesystem); its message says which.',
      `cells 1, 4 and 5; ${STORE_CELLS}: the damaged-file rule and the newer store file cells (a folder or a link: the store's open, unchanged)`,
    ],
    [
      'a newer store file, or one Realm cannot open',
      "the store file was written by a newer Realm, or Realm cannot open it for another reason (a folder or a link where the file should be, a home on a network filesystem): the store's own message. Nothing is changed.",
      `${STORE_CELLS}: the newer store file cell`,
    ],
    [
      'side files beside an unreadable file',
      'SQLite cannot read the store file, and a side file is beside it: `<home>/realm.db cannot be read as a store, and a -wal or -shm file is beside it: another process may have it open, or a process that was killed left them. Stop every process that uses the home; if none is running, move <home>/realm.db and those files aside by hand, then run this again. Nothing was changed.`',
      `${STORE_CELLS}: the text-garbage cell and the item-2 cell (the file and both side files as they were)`,
    ],
    [
      'side files beside a missing file',
      'the home has no store file, but a side file is there: `There is no store file at <home>/realm.db, but a -wal or -shm file is beside where it would be: they may hold the writes of a store file that was moved or deleted. Move them aside by hand, then run this again. Nothing was changed.`',
      `${STORE_CELLS}: the cell of side files beside a missing store file`,
    ],
    [
      'a store file that appeared',
      'a store file appeared in a home that had none while the restore ran: `realm.db appeared while the restore ran; nothing was replaced.`',
      `${STORE_CELLS}: the racing creator cell`,
    ],
    [
      'the damaged path',
      'It also recovers a damaged store file. When the store file cannot be read as a store (it is damaged, or it is not a Realm store), the command copies it as it was, byte for byte, into the backups folder as `realm-before-restore-<UTC time>-as-found.db`, with its write-ahead log as `realm-before-restore-<UTC time>-as-found.db-wal` when it has one, prints the line below, then restores the backup. Realm never deletes them.',
      `cell 5; ${STORE_CELLS}: the damaged-page, crash-window and non-Realm cells`,
    ],
    [
      'a killed writer`s log written in first',
      'When SQLite can read the file but it is not a Realm store, opening it may first write a write-ahead log that a killed process left beside it into the file, as any open of the store does: the as-found copy then holds those writes, and has no `-wal` of its own.',
      `${STORE_CELLS}: the cell of a database that is not a Realm store with a killed writer's log`,
    ],
    [
      'the side files looked at first',
      'The command then looks for `realm.db-wal` and `realm.db-shm` beside it, before anything opens the file:',
      `${STORE_CELLS}: the item-2 cell and the truncated-file cell`,
    ],
    [
      'step 4',
      'It keeps the file it replaces: [`realm db backup`](#backup) copies it into the backups folder beside the home, `~/.realm-backups/` for the home `~/.realm` (made owner-only when it is missing), as `realm-before-restore-<UTC time>.db`, and prints its line.',
      `cell 1; ${STORE_CELLS}: the first cell (the kept file's name and runs)`,
    ],
    [
      'step 6',
      "It writes the store's write-ahead log into the store file, removes `realm.db-wal` and `realm.db-shm`, and renames the copy over `realm.db` in one step. A stale write-ahead log is never applied to the restored file.",
      `${STORE_CELLS}: the stale log and crash window cells`,
    ],
    [
      'the purged run',
      'A run purged after the backup was made comes back, and the record of its purge is gone.',
      `${STORE_CELLS}: the first cell (purge)`,
    ],
    [
      'the same second',
      "The kept file's name holds the second it was made, so a second restore in the same second is refused by `realm db backup`'s rule, and changes nothing.",
      `${STORE_CELLS}: the same-second cell`,
    ],
    [
      'the side file backup',
      "one of its side files: `Cannot restore from <backup>: it is the store file's -wal file. Nothing was changed.` (or `-shm`).",
      `${STORE_CELLS}: the backup argument cell`,
    ],
    [
      'the in-use refusal',
      'another process has the store file open, [`STATE_STORE_IN_USE`](../error-codes.md): `Another process has <home>/realm.db open: a Realm agent, server or command, an MCP server that an assistant or editor keeps running, or another program such as a SQLite browser. Stop it and run this again. Nothing was changed.`',
      'cell 7',
    ],
    [
      'the kept copy refused',
      "the kept copy cannot be made for another reason than a store file SQLite cannot read (a full disk, a backups folder that cannot be written): `realm db backup`'s refusal, with its code, then ` Nothing was replaced.` A kept copy that SQLite cannot read the store file for, or that fails SQLite's quick check, takes the damaged-file path above instead.",
      `${STORE_CELLS}: the same-second cell (backup's refusal kept); the damaged-page cell (the damaged path instead)`,
    ],
    [
      'a failure before or after the rename',
      'another failure before the rename: `Cannot restore from <backup>: <the reason>. <home>/realm.db was not replaced.`, then ` A copy of it is at <kept file>.` when the kept copy was made. After the rename, when the folder cannot be flushed: `Cannot restore from <backup>: <the reason>. <home>/realm.db was replaced.`',
      `${STORE_CELLS}: the failure-before-the-swap and failure-after-the-rename cells`,
    ],
    [
      'the backup refused in the check words',
      'the backup is not a Realm store, is damaged, or was written by a newer Realm: `Cannot restore from <backup>:` and the words of [`realm db check`](#check), then `Nothing was changed.`',
      `cell 6; ${STORE_CELLS}: the non-store, damaged or newer backup cell`,
    ],
  ])('%s', (_name, sentence, provedBy) => {
    claim(PAGE, sentence, provedBy);
  });

  it('the files page and the codes page', () => {
    claim(
      ENV_PAGE,
      "| `.realm-restore-<pid>-<random>.db` | The checked copy of a backup that `realm db restore` puts in place of `realm.db`, owner-only (mode 0600). One left behind by a restore that was killed is a full copy of the backup, which can be deleted when no restore is running. A restore that was killed may also leave a folder `realm-restore-<random>` in the system's temporary folder, owner-only, holding a full copy of the backup: delete it. | `realm db restore` |",
      `${STORE_CELLS}: the crash window cell`,
    );
    claim(
      ENV_PAGE,
      '| `~/.realm-backups/realm-before-restore-<UTC time>.db` | The store file that `realm db restore` replaced, copied and checked by `realm db backup` before the restore (a copy that fails the check stays under this name, unverified, and the file is then also copied as found). A store file it could not read is copied as it was, as `realm-before-restore-<UTC time>-as-found.db` and its write-ahead log as `realm-before-restore-<UTC time>-as-found.db-wal`. Realm never deletes them. |',
      `cell 1; ${STORE_CELLS}: the first cell`,
    );
    claim(
      CODES,
      '| `STATE_STORE_RESTORE_REFUSED` | `realm db restore` refused: the backup is not a file, is the store file or a side file of it, is not a Realm store, is damaged or is newer; a `-wal` or `-shm` file is beside a store file it cannot read, or beside a missing one; a store file appeared while it ran; or the restore failed, and the message says whether the store file was replaced. Added after version 0.49.0. | `report_to_user` | No |',
      `cell 6; ${STORE_CELLS}: the refusal cells`,
    );
  });
});

// The guide's and the changelog's sentences about going back, each held to the cell that executes it.
describe('#616 R1b — the guide and the changelog say how to go back', () => {
  it('restore first with this Realm, then install the older one; the newer writes are in the kept copy', () => {
    claim(
      GUIDE,
      'To go back, run `realm db restore <backup>` with this Realm first, then reinstall the older Realm: writes made after the backup are not in the restored file, but are in the copy the command keeps of the file it replaced.',
      `${STORE_CELLS}, the first cell (the kept file holds the newer runs; the restored file the backup's)`,
    );
    claim(
      CHANGELOG,
      'To go back, run `realm db restore <backup>` with this Realm, then reinstall the older Realm; writes made after the backup are not in the restored file, but are in the copy it keeps of the file it replaced.',
      `${STORE_CELLS}, the first cell`,
    );
  });
});
