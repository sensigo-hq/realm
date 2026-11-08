// db-backup-616.test.ts — issue #616 PR-2c, unit c6: `realm db backup <path>` as a user runs it. The
// cells run the BUILT `realm` (tests run after the build) with PATH, HOME and REALM_NO_NUDGE only, in
// a scratch working folder; HOME is a scratch folder whose `.realm` the test first opens through the
// store package's own `openRealmHome` (the CLI's test helper opens the JSON store until unit c10a)
// and closes. The real cases: a backup that works and says so in one line; a user who types a path
// inside the home, or one where a file is; a home with no store yet; a store file that is not a
// database. Each refusal is one `Error:` line on stderr, exit code 1, nothing on stdout, and the home
// as it was. The correction (2026-11-08) adds a store with a damaged page and a target that cannot
// be written (a file-size limit), each one line and nothing left at the path or beside it; a copy
// restored by the page's steps into a home that did not exist; and the page's sentences, each
// quoted word for word with the cell that executes it. The quick check's failure line is not run here (it needs the store's quick-check seam
// inside the child): the store's cell (6) pins its words, and the CLI prints the store's message as
// it is.
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openRealmHome } from '@sensigo/realm-store-sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST_CLI = join(HERE, '..', '..', 'dist', 'index.js');
const ROOT = join(HERE, '..', '..', '..', '..');
const PAGE = 'docs/reference/cli/realm-db.md';

let root = '';
let base = '';
let home = '';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'realm-616-c6-home-'));
  base = mkdtempSync(join(tmpdir(), 'realm-616-c6-cwd-'));
  home = join(root, '.realm');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(base, { recursive: true, force: true });
});

interface Run {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs the built `realm` with HOME set to the scratch root (or `homeRoot`); a run that hangs is
 * killed (a red). With `fileLimitBlocks`, it runs under sh's `ulimit -f` (blocks of 512 or 1024
 * bytes, by the shell), so a write beyond that size fails with EFBIG, as at a file-size limit.
 */
function realm(args: string[], homeRoot = root, fileLimitBlocks?: number): Run {
  const command =
    fileLimitBlocks === undefined
      ? [process.execPath, DIST_CLI, ...args]
      : [
          '/bin/sh',
          '-c',
          `ulimit -f ${fileLimitBlocks} && exec "$0" "$@"`,
          process.execPath,
          DIST_CLI,
          ...args,
        ];
  const [file = process.execPath, ...rest] = command;
  const r = spawnSync(file, rest, {
    cwd: base,
    env: { PATH: process.env['PATH'] ?? '', HOME: homeRoot, REALM_NO_NUDGE: '1' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
    killSignal: 'SIGKILL',
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/**
 * A path as the CLI prints it when its output is piped (a log): the scratch HOME's own path is masked
 * (`[REDACTED]`, #729 PR-3); the rest of the path is printed as it is.
 */
function shown(path: string): string {
  return path.replace(root, '[REDACTED]');
}

/** Makes the home's store through the store package's own open, with one run, and closes it. */
async function makeStore(): Promise<void> {
  const h = await openRealmHome({ home });
  await h.runStore.create({
    workflowId: 'triage',
    workflowVersion: 1,
    params: {},
    extensionIdentity: [],
  });
  h.close();
}

/**
 * Damages page 13 of the store file as a bad sector would: the b-tree page's type byte 0x00 and its
 * cell count 0xffff (the fresh reader's case, FR-C6-14; the store's cell 10a is the same).
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

const flat = (t: string): string => t.replace(/\s+/g, ' ');
/** (1) red when the page no longer holds the sentence word for word; (2) prints the sentence. */
function claim(page: string, sentence: string): void {
  expect(
    flat(readFileSync(join(ROOT, page), 'utf8')),
    `${page} no longer says: ${sentence}`,
  ).toContain(flat(sentence));
}

/** What a folder holds: each name with its bytes' hash, so any change to it shows. */
function holds(folder: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(folder).sort()) {
    const path = join(folder, name);
    out[name] = statSync(path).isFile()
      ? createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16)
      : 'folder';
  }
  return out;
}

// Each cell starts the built CLI (a cold start each time; the refusals' cell five times), so the
// describe carries its own budget (spawn-budget-guard.test.ts).
describe('#616 PR-2c c6 — realm db backup, on the built CLI', { timeout: 120_000 }, () => {
  it('a backup prints one line naming the store, its version, the bytes and the copy', async () => {
    await makeStore();
    const copy = join(base, 'copy.db');
    const r = realm(['db', 'backup', copy]);
    const bytes = statSync(copy).size;
    // (1) red when the line is minted with other words, another figure or another path, or when
    //     the command writes to stderr or exits non-zero; (2) prints the run.
    expect(r).toEqual({
      code: 0,
      stdout: `Backed up ${shown(join(home, 'realm.db'))} (schema version 1, ${bytes} bytes) to ${copy}; the copy passes SQLite's quick check.\n`,
      stderr: '',
    });
  });

  it('each refusal is one Error line, exit 1, nothing on stdout, the home as it was: inside the home, a path where a file is, no store, a store file that is not a database', async () => {
    // No store: a HOME whose .realm was never made.
    const none = realm(['db', 'backup', join(base, 'a.db')]);
    const noneHomeMade = readdirSync(root).includes('.realm');
    const noneFile = join(home, 'realm.db');

    await makeStore();
    const before = holds(home);
    const inside = join(home, 'x.db');
    const insideRun = realm(['db', 'backup', inside]);
    const insideAfter = holds(home);
    const taken = join(base, 'taken.db');
    writeFileSync(taken, 'the user keeps this');
    const takenRun = realm(['db', 'backup', taken]);
    const takenText = readFileSync(taken, 'utf8');

    // A store file that is not a database: the home made by the open (its fences in place), the
    // file then overwritten with text.
    writeFileSync(noneFile, 'not a database\n');
    const textBefore = holds(home);
    const textRun = realm(['db', 'backup', join(base, 'b.db')]);
    const textAfter = holds(home);
    // (1) red when a refusal's code is not in the CLI's set of expected refusals (the error then
    //     escapes with its stack trace), when the entry opens before it looks (the home made), when
    //     a refusal is printed with other words, or when the home or the user's file is changed;
    //     (2) prints each run and what the home held before and after.
    expect({
      none,
      noneHomeMade,
      inside: insideRun,
      insideHome: insideAfter,
      taken: takenRun,
      takenText,
      text: textRun,
      textHome: textAfter,
      made: readdirSync(base).sort(),
    }).toEqual({
      none: {
        code: 1,
        stdout: '',
        stderr: `Error: There is no store file at ${shown(noneFile)} to back up.\n`,
      },
      noneHomeMade: false,
      inside: {
        code: 1,
        stdout: '',
        stderr: `Error: Cannot back up the store to ${shown(inside)}: it is inside the Realm home ${shown(home)}. Write the copy outside the home.\n`,
      },
      insideHome: before,
      taken: {
        code: 1,
        stdout: '',
        stderr: `Error: Cannot back up the store to ${taken}: a file already exists there. Realm never replaces a file; name a path where nothing exists.\n`,
      },
      takenText: 'the user keeps this',
      text: {
        code: 1,
        stdout: '',
        stderr: `Error: The store file ${shown(noneFile)} is not a Realm store this Realm can use: it is not a SQLite database (SQLite: file is not a database). Realm does not change or replace a store file by itself.\n`,
      },
      textHome: textBefore,
      made: ['taken.db'],
    });
  });

  it('a store with a damaged page: one Error line that names the store file as possibly damaged, exit 1, nothing at the path or beside it', async () => {
    await makeStore();
    const source = join(home, 'realm.db');
    damagePage13(source);
    const copy = join(base, 'copy.db');
    const r = realm(['db', 'backup', copy]);
    // (1) red when the copy's failure escapes unconverted (SQLite's plain error and a stack on
    //     stderr), when it gets another sentence, or when anything is left in the working folder
    //     (the copy or its temporary file); (2) prints the run and what the folder holds.
    expect({ r, left: readdirSync(base) }).toEqual({
      r: {
        code: 1,
        stdout: '',
        stderr:
          `Error: Cannot back up the store to ${copy}: SQLite could not read ${shown(source)}: ` +
          'database disk image is malformed (SQLite error 11). The store file may be damaged. ' +
          `Nothing was written at ${copy}.\n`,
      },
      left: [],
    });
  });

  it.skipIf(process.platform !== 'linux')(
    'a target that cannot be written (a file-size limit): one Error line that says the copy could not be written, exit 1, nothing at the path or beside it (Linux only: sh and ulimit -f as on the deploy host)',
    async () => {
      await makeStore();
      const copy = join(base, 'copy.db');
      const r = realm(['db', 'backup', copy], root, 100);
      // (1) red when the write failure escapes unconverted ("disk I/O error (SQLite error 778)"
      //     with a stack), when it is blamed on the store file, or when anything is left in the
      //     working folder; (2) prints the run and what the folder holds.
      expect({ r, left: readdirSync(base) }).toEqual({
        r: {
          code: 1,
          stdout: '',
          stderr: `Error: Cannot back up the store to ${copy}: the copy could not be written: disk I/O error (SQLite error 778). Nothing was written at ${copy}.\n`,
        },
        left: [],
      });
    },
  );

  it("the page's restore, into a home that does not exist yet (a new machine): the restored store opens, so a second backup from it works", async () => {
    await makeStore();
    const copy = join(base, 'copy.db');
    const first = realm(['db', 'backup', copy]);
    const newRoot = mkdtempSync(join(tmpdir(), 'realm-616-c6-new-'));
    try {
      // The page's steps: create the home folder, put the copy in place of realm.db (there is
      // no realm.db-wal or realm.db-shm to remove in a new home).
      const newHome = join(newRoot, '.realm');
      mkdirSync(newHome);
      copyFileSync(copy, join(newHome, 'realm.db'));
      const again = join(base, 'again.db');
      const r = realm(['db', 'backup', again], newRoot);
      // The copy's size, read only when the run made one: a refused run prints its own line below.
      const bytes = r.code === 0 ? statSync(again).size : 0;
      // (1) red when the copy is not one Realm's open accepts in a home of its own (it is then
      //     refused, one Error line), or the first backup failed; (2) prints both runs.
      expect({ first: first.code, r }).toEqual({
        first: 0,
        r: {
          code: 0,
          stdout: `Backed up [REDACTED]/.realm/realm.db (schema version 1, ${bytes} bytes) to ${again}; the copy passes SQLite's quick check.\n`,
          stderr: '',
        },
      });
    } finally {
      rmSync(newRoot, { recursive: true, force: true });
    }
  });

  it('realm --help lists db, and realm db --help lists backup', () => {
    const top = realm(['--help']);
    const db = realm(['db', '--help']);
    // (1) red when the db group is not added to the program, or backup not to the group;
    //     (2) prints both help lines found (or none).
    const line = (text: string, start: RegExp): string =>
      (text.split('\n').find((l) => start.test(l)) ?? 'none').trim().replace(/\s+/g, ' ');
    expect({
      top: line(top.stdout, /^\s+db\s/),
      db: line(db.stdout, /^\s+backup\s/),
    }).toEqual({
      top: 'db Maintain the store file',
      db: 'backup <path> Copy the store file to a new file outside the Realm home, and',
    });
  });
});

// Each sentence the correction writes on the page is quoted word for word (guardrail 7(f), 9), with
// the cell that executes what it says. Each claim is (1) red when the page no longer holds it word for
// word; (2) it prints the sentence.
describe('#616 PR-2c c6 correction — the page says what the command does', () => {
  it('the four steps, and what the command may write besides the copy', () => {
    // Executed by the store's cells 5 (owner-only), 1 (WAL, the restored copy opens), 14a (the
    // flushes, then the link, then the folder), 12 (the link refuses a file that appeared) and 13a,
    // 13b (no hard links: one more look, then the move).
    claim(
      PAGE,
      'It creates a temporary file beside `<path>`, readable and writable by your account only (mode 600; on Linux and macOS), so the copy is never readable by others. SQLite copies the whole store into it in one step (`VACUUM INTO`).',
    );
    claim(
      PAGE,
      "It sets the copy to the journal mode Realm needs (WAL), so that Realm can open it, checks it with SQLite's quick check (`PRAGMA quick_check`), and flushes it to the disk.",
    );
    claim(
      PAGE,
      'It publishes the copy under `<path>` with a hard link, which cannot replace a file that is there; where the filesystem has no hard links (FAT, exFAT, some network filesystems), it looks at `<path>` once more and moves the copy in. Then it flushes the folder, so that the copy and its name survive a crash.',
    );
    // The fence files: the open's own preparation (store-sqlite home.test.ts, "the fences"), which
    // the maintenance entry runs; the WAL replay: SQLite's recovery at any open (the fresh reader's
    // FR-C6-10 and FR-C6-12, executed on the built command).
    claim(
      PAGE,
      'Realm writes nothing of its own to the store file. SQLite may first replay a write-ahead log that a crashed Realm left beside it, as any open of the store does. Realm may also create its four small read-only fence files in the home (`runs`, `dedup`, `replays` and `workflows`) if they are missing.',
    );
  });

  it('a killed run, the quick check, and the restore', () => {
    // Executed by the store's cells 11a and 11b (a run killed after its copy: nothing at the path,
    // only `<path>.part-` names beside it) and this file's first cell (the success line).
    claim(
      PAGE,
      'A run that printed this line published its copy. A run that was killed before it published leaves no file at `<path>`; it may leave files whose names begin `<path>.part-`, which you can delete.',
    );
    // What the quick check judges: the store's cells 6 and 10a (the copy checked; a damaged page
    // read while copying refuses it) and the fresh reader's FR-C6-15 (damage SQLite does not read
    // while copying leaves a copy that passes).
    claim(
      PAGE,
      "The quick check judges the copy. A copy that passes was rebuilt from the pages SQLite could read. To look for damage in the store itself, run SQLite's quick check on the store file.",
    );
    // Executed by this file's restore cell (a home that did not exist) and the store's cell 1.
    claim(
      PAGE,
      'If the home folder does not exist, on a new machine for one, create it. Put the copy in place of `realm.db` in the home.',
    );
  });

  it("the exit codes: the copy's failures, and the two cases that leave a copy at the path", () => {
    // Executed by this file's damaged-page cell and the store's cell 10a.
    claim(
      PAGE,
      "SQLite cannot read a page of the store file while it copies it: `Cannot back up the store to <path>: SQLite could not read <home>/realm.db: <SQLite's message>. The store file may be damaged. Nothing was written at <path>.`",
    );
    // Executed by this file's file-size-limit cell, the store's cells 10b (SQLite 10, 13) and 14d (a
    // system error at the file flush).
    claim(
      PAGE,
      'the copy cannot be written, because the disk is full or the system or SQLite reports an error: `Cannot back up the store to <path>: the copy could not be written: <the reason>. Nothing was written at <path>.`',
    );
    // Executed by the store's cell 10b (an error that is not SQLite's).
    claim(
      PAGE,
      'the copy fails for another reason: `Cannot back up the store to <path>: <the reason>. Nothing was written at <path>.`',
    );
    // Executed by the store's cell 12 (a file that appeared while the copy was made).
    claim(
      PAGE,
      'something exists at `<path>`, or appeared there while the copy was made: `Cannot back up the store to <path>: a file already exists there. Realm never replaces a file; name a path where nothing exists.`',
    );
    // Executed by the store's cells 6 (unverified, kept) and 14c (the folder flush).
    claim(
      PAGE,
      'When the copy was published but its folder could not be flushed, `STATE_STORE_BACKUP_REFUSED`: `Cannot back up the store to <path>: the copy was made and published, but its folder could not be flushed: <the reason>. Check the copy before you rely on it.`',
    );
    // The error-codes row and the CHANGELOG's list say the same, executed by the same cells.
    claim(
      'docs/reference/error-codes.md',
      'or the copy failed (a damaged page of the store file, a full disk, a write error). Nothing is written at the path, except when only its folder could not be flushed after the copy was published.',
    );
    claim('CHANGELOG.md', 'a copy that fails or cannot be written, with nothing left at the path');
  });
});
