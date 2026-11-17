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
        `Backed up ${shown(file)} (schema version 2, ${readFileSync(kept).length} bytes) to ` +
        `${shown(kept)}; the copy passes SQLite's quick check.\n` +
        `Restored ${shown(file)} from ${backup} (schema version 2).\n` +
        'The file it replaced had 1 run(s) the backup lacks and 0 that differ; the backup has 0 it ' +
        'lacked (they are back). The replaced file is the copy above. Only runs are counted.\n',
      stderr: '',
    });
    claim(PAGE, '`Restored <home>/realm.db from <backup> (schema version <m>).`', 'cell 1');
    claim(
      PAGE,
      '`The file it replaced had <a> run(s) the backup lacks and <b> that differ; the backup has <c> it lacked (they are back). The replaced file is the copy above. Only runs are counted.`',
      `cell 1; the counts' values: ${STORE_CELLS}, the first cell`,
    );
    claim(PAGE, "It prints `realm db backup`'s line for the kept file, then:", 'cell 1');
  });

  it('(2) a backup that holds the same runs, then the undo by the kept file', async () => {
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
        'This backup is at schema version 1 and this Realm writes version 2. To use it with this ' +
        'Realm, run `realm db migrate`; to use it with an older Realm, install that Realm now.',
      migrate: 0,
    });
    claim(
      PAGE,
      'When the backup is at an older schema version than this Realm writes, a last line says what comes next: ``This backup is at schema version <m> and this Realm writes version <r>. To use it with this Realm, run `realm db migrate`; to use it with an older Realm, install that Realm now.``',
      'cell 3',
    );
  });

  it('(4) a home with no store file, and a store file SQLite cannot read: refused in one Error line, nothing changed (part two restores over both)', async () => {
    const source = join(root, 'src', '.realm');
    await makeStore(source, 1);
    const backup = join(base, 'b.db');
    await backupTo(source, backup);
    const noStore = realm(['db', 'restore', backup]);
    mkdirSync(home, { recursive: true });
    writeFileSync(file, 'not a database '.repeat(500), { mode: 0o600 });
    const garbage = realm(['db', 'restore', backup]);
    // (1) red when either is restored over, or its refusal is not one line; (2) prints both runs.
    expect({
      noStore,
      garbage: garbage.stderr.split(':')[0],
      code: garbage.code,
      kept: existsSync(folder),
    }).toEqual({
      noStore: {
        code: 1,
        stdout: '',
        stderr: `Error: There is no store file at ${shown(file)} to restore over.\n`,
      },
      garbage: 'Error',
      code: 1,
      kept: false,
    });
    claim(
      PAGE,
      'the home has no store file: `There is no store file at <home>/realm.db to restore over.`; an empty one: `<home>/realm.db holds no store yet: there is nothing to restore over.` Nothing is changed; put the backup in place by hand for now ([Restoring a copy](#restoring-a-copy)).',
      `cell 4; the empty file: ${STORE_CELLS}, the cell of a home with no store file`,
    );
    claim(
      PAGE,
      "the store file cannot be opened (it is damaged, not a Realm store, or written by a newer Realm): the store's own message. Nothing is changed; over a damaged store file, put the backup in place by hand for now.",
      `cell 4; ${STORE_CELLS}, the cells of a file the open cannot read and of a newer file`,
    );
  });

  it('(5) refusals: one Error line on standard error, exit 1, nothing on standard output, nothing made', async () => {
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
    c.exec('PRAGMA user_version = 3');
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
          `Cannot restore from ${newer}: Written by a later version of Realm (schema version 3; this version reads up to 2). Nothing was changed.`,
        ),
      },
      folder: false,
    });
    claim(
      PAGE,
      "`Cannot restore from <backup>: <the system's reason>. Nothing was changed.`",
      'cell 5',
    );
    claim(
      PAGE,
      '`Cannot restore from <backup>: it is a symbolic link. Nothing was changed.`',
      'cell 5',
    );
    claim(PAGE, '`Cannot restore from <backup>: it is not a file. Nothing was changed.`', 'cell 5');
    claim(
      PAGE,
      '`Cannot restore from <backup>: it is the store file itself. Nothing was changed.`',
      'cell 5; the hard link and the symlinked home: the store cell of the backup argument',
    );
    claim(
      PAGE,
      '`Cannot restore from <backup>: Written by a later version of Realm (schema version <n>; this version reads up to <m>). Nothing was changed.`',
      'cell 5',
    );
  });

  it('(6) another process on the store: refused STATE_STORE_IN_USE, in one Error line', async () => {
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
        `Error: Another process has ${shown(file)} open (a Realm agent, server, MCP server or ` +
        'command, or another program such as a SQLite browser). Stop it and run this again. ' +
        'Nothing was changed.\n',
    });
  });

  it('(7) realm db --help lists restore, and realm db restore --help names its argument', () => {
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
