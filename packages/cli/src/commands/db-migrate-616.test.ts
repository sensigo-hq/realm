// db-migrate-616.test.ts — issue #616 PR-2c, unit c7: `realm db migrate --backup <path> | --no-backup`
// as an operator runs it. The cells run the BUILT `realm` (tests run after the build) with PATH, HOME
// and REALM_NO_NUDGE only, in a scratch working folder; HOME is a scratch folder whose `.realm` the
// test first opens through the store package's own `openRealmHome` (the CLI's test helper opens the
// JSON store until unit c10a) and closes. The real cases: an operator who types neither flag, or both;
// a store already at this Realm's version, with and without a backup; a home with no store; the help.
// Schema steps cannot run here (only version 1 exists; the store's cells climb the synthetic ladder
// through the open's seams). The cells that need a second raw connection on the home's `realm.db` (a
// store whose runs an older derivation stamped; a file a newer Realm migrated; another writer holding
// the store through the re-stamp) open it with `openForeignConnection` from the store package's
// `./test-support` subpath (c9a), the one lawful route: no CLI source names the built-in SQLite (the
// store package's one-loader law).
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openRealmHome } from '@sensigo/realm-store-sqlite';
import { openForeignConnection } from '@sensigo/realm-store-sqlite/test-support';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lineOf } from './db-migrate.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST_CLI = join(HERE, '..', '..', 'dist', 'index.js');
const ROOT = join(HERE, '..', '..', '..', '..');
const PAGE = 'docs/reference/cli/realm-db.md';

let root = '';
let base = '';
let home = '';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'realm-616-c7-home-'));
  base = mkdtempSync(join(tmpdir(), 'realm-616-c7-cwd-'));
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

/** Runs the built `realm` with HOME set to the scratch root; a run that hangs is killed (a red). */
function realm(args: string[]): Run {
  const r = spawnSync(process.execPath, [DIST_CLI, ...args], {
    cwd: base,
    env: { PATH: process.env['PATH'] ?? '', HOME: root, REALM_NO_NUDGE: '1' },
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

/** Makes the home's store with `runs` runs, through the store package's own open, and closes it. */
async function storeWithRuns(runs: number): Promise<string[]> {
  const h = await openRealmHome({ home });
  const ids: string[] = [];
  for (let i = 0; i < runs; i++) {
    const created = await h.runStore.create({
      workflowId: 'triage',
      workflowVersion: 1,
      params: {},
      extensionIdentity: [],
    });
    ids.push(created.record.id);
  }
  h.close();
  return ids;
}

/**
 * Stamps `ids` as an older derivation would have, on a second connection (the store's cell D's
 * planting): another fingerprint and a phase their records do not derive; record and version untouched.
 */
async function plantStaleStamps(ids: readonly string[]): Promise<void> {
  const foreign = await openForeignConnection(home);
  try {
    const plant = foreign.prepare(
      "UPDATE runs SET run_phase = 'completed', phase_version = 'derivation-a' WHERE id = ?",
    );
    for (const id of ids) plant.run(id);
  } finally {
    foreign.close();
  }
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

const flat = (t: string): string => t.replace(/\s+/g, ' ');
/** (1) red when the page no longer holds the sentence word for word; (2) prints the sentence. */
function claim(page: string, sentence: string): void {
  expect(
    flat(readFileSync(join(ROOT, page), 'utf8')),
    `${page} no longer says: ${sentence}`,
  ).toContain(flat(sentence));
}

const ALREADY = (file: string): string =>
  `${file} is already at schema version 1; no schema step to run.\n`;
const RESTAMPED = (runs: number): string =>
  `Re-stamped the phase index of ${runs} run(s) with the current derivation.\n`;

// Each cell starts the built CLI (a cold start each time), so the describe carries its own budget
// (spawn-budget-guard.test.ts).
describe('#616 PR-2c c7 — realm db migrate, on the built CLI', { timeout: 120_000 }, () => {
  it('(I) one of the two flags is required: neither, or both in either order, is its usage line, exit 1, and the home is as it was', async () => {
    await makeStore();
    const before = holds(home);
    const copy = join(base, 'copy.db');
    const runs = {
      neither: realm(['db', 'migrate']),
      both: realm(['db', 'migrate', '--backup', copy, '--no-backup']),
      bothReversed: realm(['db', 'migrate', '--no-backup', `--backup=${copy}`]),
    };
    const both = {
      code: 1,
      stdout: '',
      stderr: 'Cannot combine --backup with --no-backup. Use one or the other.\n',
    };
    // (1) red when the pair is told from Commander's options (it folds them into one value, the last
    //     wins, so both runs go ahead and migrate), or when neither flag goes ahead; (2) prints each
    //     run, what the home holds and what the working folder holds.
    expect({ ...runs, home: holds(home), base: readdirSync(base) }).toEqual({
      neither: {
        code: 1,
        stdout: '',
        stderr:
          'Provide --backup <path> (a copy of the store file, made before anything changes) or --no-backup.\n',
      },
      both,
      bothReversed: both,
      home: before,
      base: [],
    });
  });

  it('(J) a store at version 1: with --backup, the backup line, the already-at line and a re-stamp of 0, exit 0, and the copy made; with --no-backup, the two lines and nothing at any path', async () => {
    await makeStore();
    const file = shown(join(home, 'realm.db'));
    const copy = join(base, 'realm-before-upgrade.db');
    const withBackup = realm(['db', 'migrate', '--backup', copy]);
    const bytes = existsSync(copy) ? statSync(copy).size : 'no copy';
    const afterBackup = readdirSync(base);
    const noBackup = realm(['db', 'migrate', '--no-backup']);
    // (1) red when a line is minted with other words or figures, when the backup is not made first,
    //     or when --no-backup makes a copy; (2) prints both runs and what the working folder holds
    //     after each.
    expect({ withBackup, afterBackup, noBackup, afterNoBackup: readdirSync(base) }).toEqual({
      withBackup: {
        code: 0,
        stdout:
          `Backed up ${file} (schema version 1, ${bytes} bytes) to ${copy}; the copy passes SQLite's quick check.\n` +
          ALREADY(file) +
          RESTAMPED(0),
        stderr: '',
      },
      afterBackup: ['realm-before-upgrade.db'],
      noBackup: { code: 0, stdout: ALREADY(file) + RESTAMPED(0), stderr: '' },
      afterNoBackup: ['realm-before-upgrade.db'],
    });
  });

  it("(L) a home with no store file is refused in migrate's words, exit 1, and nothing is created or copied", () => {
    const copy = join(base, 'copy.db');
    const none = realm(['db', 'migrate', '--backup', copy]);
    // (1) red when the command does not open the entry for migrate (backup's "to back up" words), or
    //     when the code is not printed as one line (a stack follows); (2) prints the run, whether it
    //     created the home, and what the working folder holds.
    expect({ none, noneHome: existsSync(home), base: readdirSync(base) }).toEqual({
      none: {
        code: 1,
        stdout: '',
        stderr: `Error: There is no store file at ${shown(join(home, 'realm.db'))} to migrate.\n`,
      },
      noneHome: false,
      base: [],
    });
  });

  it('(K) runs another phase derivation stamped are re-stamped and counted: 2, then 0', async () => {
    const ids = await storeWithRuns(3);
    await plantStaleStamps(ids.slice(0, 2));
    const file = shown(join(home, 'realm.db'));
    const first = realm(['db', 'migrate', '--no-backup']);
    const second = realm(['db', 'migrate', '--no-backup']);
    // (1) red when the re-stamp does not run on the command's path, or its count is not the line's
    //     (the first run says 0), or the stamps are not written (the second run says 2); (2) prints
    //     both runs.
    expect({ first, second }).toEqual({
      first: { code: 0, stdout: ALREADY(file) + RESTAMPED(2), stderr: '' },
      second: { code: 0, stdout: ALREADY(file) + RESTAMPED(0), stderr: '' },
    });
  });

  it("(L) a file a newer Realm migrated is the open's own refusal as one Error line, exit 1; with --backup nothing is copied", async () => {
    await storeWithRuns(1);
    const foreign = await openForeignConnection(home);
    try {
      foreign.exec('PRAGMA user_version = 2');
    } finally {
      foreign.close();
    }
    const copy = join(base, 'copy.db');
    const noBackup = realm(['db', 'migrate', '--no-backup']);
    const withBackup = realm(['db', 'migrate', '--backup', copy]);
    const refused = {
      code: 1,
      stdout: '',
      stderr:
        'Error: This store was migrated by a newer Realm: its schema is version 2 and this Realm writes version 1. Upgrade Realm to read or write it.\n',
    };
    // (1) red when STATE_STORE_VERSION_NEWER is not printed as one line (a stack follows), or the
    //     backup is made before the open refuses; (2) prints both runs and whether a copy exists.
    expect({ noBackup, withBackup, copied: existsSync(copy) }).toEqual({
      noBackup: refused,
      withBackup: refused,
      copied: false,
    });
  });

  it('(F2) another writer holds the store through the re-stamp: the lines so far, then the busy refusal as one Error line, exit 1, no stack', async () => {
    const ids = await storeWithRuns(2);
    await plantStaleStamps(ids);
    const holder = await openForeignConnection(home);
    let run: Run;
    try {
      // Two stale stamps, so the re-stamp opens a write transaction; the write lock held across the
      // whole run (in WAL mode the open's reads pass under it; the re-stamp's write does not).
      holder.exec('BEGIN IMMEDIATE');
      try {
        run = realm(['db', 'migrate', '--no-backup']);
      } finally {
        holder.exec('ROLLBACK');
      }
    } finally {
      holder.close();
    }
    const file = shown(join(home, 'realm.db'));
    // (1) red when STATE_RUN_BUSY is not in the expected-refusal set (a stack follows the line), or
    //     the count so far is not reported before the refusal; (2) prints the run.
    expect(run).toEqual({
      code: 1,
      stdout: ALREADY(file) + RESTAMPED(0),
      stderr:
        'Error: The store was busy for 5 s: another writer held it. Nothing was written. Try again.\n',
    });
  });

  it('(M) realm db --help lists migrate, and realm db migrate --help names both flags', () => {
    const group = realm(['db', '--help']);
    const migrate = realm(['db', 'migrate', '--help']);
    // `realm --help` listing `db` is c6's cell. (1) red when the command is not in the db group (the
    //     group does not list it, and its help is an error); (2) prints both runs' codes, whether the
    //     group lists it, and the flags its help names.
    expect({
      codes: [group.code, migrate.code],
      listed: /^\s+migrate\s/m.test(group.stdout),
      flags: ['--backup <path>', '--no-backup'].filter((flag) => migrate.stdout.includes(flag)),
    }).toEqual({ codes: [0, 0], listed: true, flags: ['--backup <path>', '--no-backup'] });
  });
});

// The page's sentences about `migrate`, each quoted word for word, and the cell that executes it.
describe('#616 PR-2c c7 — the page says what realm db migrate does', () => {
  it('the flags, the order of the work, and the lines it prints', () => {
    // I: both usage lines; J: the already-at and re-stamp lines; the step line: the next cell.
    claim(PAGE, 'It has three subcommands.');
    claim(
      PAGE,
      'neither flag: `Provide --backup <path> (a copy of the store file, made before anything changes) or --no-backup.`; both: `Cannot combine --backup with --no-backup. Use one or the other.` Nothing is opened.',
    );
    claim(PAGE, '`<home>/realm.db is already at schema version <n>; no schema step to run.`');
    claim(PAGE, '`Re-stamped the phase index of <k> run(s) with the current derivation.`');
    // E (store): the backup's refusal and an unverified copy end the verb before any step.
    claim(
      PAGE,
      "With `--backup <path>`, it makes the copy and prints `realm db backup`'s line. When the copy cannot be made, or fails SQLite's quick check, the command stops there: nothing is migrated.",
    );
    // D (store): the record untouched, and the count.
    claim(PAGE, 'It changes no run record.');
  });

  it("the step line the command prints is the page's, word for word", () => {
    // No step can run on the built CLI (only schema version 1 exists; the store's cells climb the
    // synthetic ladder), so the command's own line-maker is held to the page's sentence.
    const sentence =
      "Migrated <home>/realm.db from schema version <v> to <v+1>: <s> statement(s) ran, the schema matches version <v+1>'s, <e> evidence entries match their stored hashes.";
    claim(PAGE, `\`${sentence}\``);
    const line = lineOf('<home>/realm.db', {
      kind: 'step',
      report: { from: 1, to: 2, statements: 3, evidenceChecked: 4 },
    });
    // (1) red when the command's step line and the page's sentence differ in a word or a figure's
    //     place; (2) prints both.
    expect(line).toBe(
      sentence
        .replaceAll('<v+1>', '2')
        .replaceAll('<v>', '1')
        .replaceAll('<s>', '3')
        .replaceAll('<e>', '4'),
    );
  });

  it('the refusals and the failed step', () => {
    // L: no store file; F (store): the empty one.
    claim(
      PAGE,
      'the home has no store file: `There is no store file at <home>/realm.db to migrate.`; an empty one: `<home>/realm.db holds no store yet: there is nothing to migrate.`',
    );
    // B and B2 (store): the two sentences of a failed step, and the backup's path.
    claim(
      PAGE,
      '`The step from schema version <v> to <v+1> failed: <the reason>. <home>/realm.db is at schema version <v>; nothing of the step is in it. Run the command again once the cause is fixed.`',
    );
    claim(
      PAGE,
      '`The step from schema version <v> to <v+1> failed: <the reason>. <home>/realm.db is at schema version <n>: the step is in it. Run the command again to continue from there.`',
    );
    claim(
      PAGE,
      'Either line ends, when a copy was made, with ` The backup made before the step is at <path>.`',
    );
    // F2: the busy line after the count so far.
    claim(
      PAGE,
      'the re-stamp line with the number of runs re-stamped so far, then `The store was busy for <s> s: another writer held it. Nothing was written. Try again.`',
    );
  });
});
