// db-migrate-616.test.ts — issue #616 PR-2c, unit c7: `realm db migrate --backup <path> | --no-backup`
// as an operator runs it. The cells run the BUILT `realm` (tests run after the build) with PATH, HOME
// and REALM_NO_NUDGE only, in a scratch working folder; HOME is a scratch folder whose `.realm` the
// test first opens through the store package's own `openRealmHome` (the CLI's test helper opens the
// JSON store until unit c10a) and closes. The real cases: an operator who types neither flag, or both;
// a store already at this Realm's version, with and without a backup; a home with no store; the help;
// and (#597 D1c-1) the first real step, version 1 to 2, on a home an older Realm left (N). The store's
// cells climb the synthetic ladder through the open's seams for the step's failure modes. The cells
// that need a second raw connection on the home's `realm.db` (a
// store whose runs an older derivation stamped; a file a newer Realm migrated; another writer holding
// the store through the re-stamp) open it with `openForeignConnection` from the store package's
// `./test-support` subpath (c9a), the one lawful route: no CLI source names the built-in SQLite (the
// store package's one-loader law).
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REALM_STORE_SCHEMA_VERSION } from '@sensigo/realm';
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
  `${file} is already at schema version 2; no schema step to run.\n`;
const RESTAMPED = (runs: number): string =>
  `Re-stamped the phase index of ${runs} run(s) with the current derivation.\n`;

// Each cell starts the built CLI (a cold start each time), so the describe carries its own budget
// (spawn-budget-guard.test.ts).
describe('#616 PR-2c c7 — realm db migrate, on the built CLI', { timeout: 120_000 }, () => {
  it('(I) both flags, in either order, are the usage line, exit 1, and the home is as it was; #616 R1: neither flag is no longer refused (a current file: the two lines, no backups folder)', async () => {
    await makeStore();
    const before = holds(home);
    const copy = join(base, 'copy.db');
    const file = shown(join(home, 'realm.db'));
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
    //     wins, so both runs go ahead and migrate), or when neither flag is still refused, or makes a
    //     copy or a folder for a file with no step pending; (2) prints each run, what the home holds,
    //     what the working folder holds and what the scratch root holds.
    expect({
      ...runs,
      home: holds(home),
      base: readdirSync(base),
      root: readdirSync(root),
    }).toEqual({
      neither: { code: 0, stdout: ALREADY(file) + RESTAMPED(0), stderr: '' },
      both,
      bothReversed: both,
      home: before,
      base: [],
      root: ['.realm'],
    });
  });

  it('(J) a store at this Realm’s version (2): with --backup, the backup line, the already-at line and a re-stamp of 0, exit 0, and the copy made; with --no-backup, the two lines and nothing at any path', async () => {
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
          `Backed up ${file} (schema version 2, ${bytes} bytes) to ${copy}; the copy passes SQLite's quick check.\n` +
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
      foreign.exec(`PRAGMA user_version = ${REALM_STORE_SCHEMA_VERSION + 1}`);
    } finally {
      foreign.close();
    }
    const copy = join(base, 'copy.db');
    const noBackup = realm(['db', 'migrate', '--no-backup']);
    const withBackup = realm(['db', 'migrate', '--backup', copy]);
    const refused = {
      code: 1,
      stdout: '',
      stderr: `Error: This store was migrated by a newer Realm: its schema is version ${REALM_STORE_SCHEMA_VERSION + 1} and this Realm writes version ${REALM_STORE_SCHEMA_VERSION}. Upgrade Realm to read or write it.\n`,
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

  it('(N) #597 D1c-1, the first real step: a home an older Realm left at version 1 is refused until `realm db migrate --backup` moves it to 2, then every command works, and a second migrate has nothing to do', async () => {
    // The version-1 file (no export is added; `openRealmHome` takes no seams): a home made by this
    // Realm, closed, then the one statement of version 2 taken back on a foreign connection. Its
    // schema then equals 0.49.0's, not its bytes (the corpus of PR #1180 is the byte witness).
    const ids = await storeWithRuns(2);
    const foreign = await openForeignConnection(home);
    try {
      foreign.exec('DROP TABLE outbound');
      foreign.exec('PRAGMA user_version = 1');
    } finally {
      foreign.close();
    }
    const file = shown(join(home, 'realm.db'));
    const copy = join(base, 'realm-before-upgrade.db');
    const checkOlder = realm(['db', 'check']);
    const listOlder = realm(['run', 'list']);
    const migrated = realm(['db', 'migrate', '--backup', copy]);
    const bytes = existsSync(copy) ? statSync(copy).size : 'no copy';
    const copyVersion = existsSync(copy) ? readFileSync(copy).readUInt32BE(60) : 'no copy';
    const listAfter = realm(['run', 'list']);
    const checkAfter = realm(['db', 'check']);
    const again = realm(['db', 'migrate', '--no-backup']);
    const lines = (t: string): string[] => t.split('\n').filter((l) => l !== '');
    const olderLines = lines(checkOlder.stdout);
    // (1) red when the older file is not refused (the step skipped, or the open reads version 1 as
    //     2), when the check runs a data check on it, when the step line differs from the page's
    //     (`lineOf`), when the backup is not the version-1 file, when a run is lost, or when the
    //     second migrate runs a step; (2) prints every run's code and the lines that matter.
    expect({
      checkOlder: {
        code: checkOlder.code,
        first: olderLines[0],
        finding: olderLines[1],
        notRun: olderLines
          .filter((l) => l.startsWith('Not run: '))
          .every((l) => l.endsWith('(because of older_version).')),
      },
      listOlder,
      migrated,
      copyVersion,
      listAfter: { code: listAfter.code, runs: ids.every((id) => listAfter.stdout.includes(id)) },
      checkAfter: {
        code: checkAfter.code,
        clean: lines(checkAfter.stdout).includes('No problems found by the checks that ran.'),
      },
      again,
    }).toEqual({
      checkOlder: {
        code: 1,
        first: `Checked ${file} (schema version 1; this version of Realm reads up to 2).`,
        finding:
          '✗ Written by an earlier version: schema version 1; this version needs 2; run `realm db migrate`.',
        notRun: true,
      },
      listOlder: {
        code: 1,
        stdout: '',
        stderr:
          "Error: This store's file is at schema version 1; this Realm writes version 2. Run `realm db migrate` with Realm stopped to upgrade it.\n",
      },
      migrated: {
        code: 0,
        stdout:
          `Backed up ${file} (schema version 1, ${bytes} bytes) to ${copy}; the copy passes SQLite's quick check.\n` +
          lineOf(file, {
            kind: 'step',
            report: { from: 1, to: 2, statements: 1, evidenceChecked: 0 },
          }) +
          '\n' +
          // #616 R1: a migrate that ran a step records it beside the home.
          `Recorded this migrate in ${shown(join(root, '.realm-backups', 'migrations.jsonl'))}.\n` +
          RESTAMPED(0),
        stderr: '',
      },
      copyVersion: 1,
      listAfter: { code: 0, runs: true },
      checkAfter: { code: 0, clean: true },
      again: { code: 0, stdout: ALREADY(file) + RESTAMPED(0), stderr: '' },
    });
  });

  it('(N2) #597 D1c-1: a home that `realm run import` creates is at version 2 and needs no migrate', () => {
    const runs = join(base, 'old-runs');
    mkdirSync(runs);
    writeFileSync(
      join(runs, 'r.json'),
      JSON.stringify({
        id: 'run-imported',
        workflow_id: 'wf-import',
        workflow_version: 1,
        completed_steps: [],
        in_progress_steps: [],
        failed_steps: [],
        skipped_steps: [],
        run_phase: 'running',
        version: 3,
        params: {},
        evidence: [],
        created_at: '2026-11-01T10:00:00.000Z',
        updated_at: '2026-11-01T10:10:00.000Z',
        terminal_state: false,
      }),
    );
    const imported = realm(['run', 'import', runs]);
    const migrate = realm(['db', 'migrate', '--no-backup']);
    // (1) red when a fresh home is created at another version than this Realm's (the migrate then
    //     runs a step or is refused); (2) prints both runs.
    expect({ imported: imported.code, migrate }).toEqual({
      imported: 0,
      migrate: {
        code: 0,
        stdout: ALREADY(shown(join(home, 'realm.db'))) + RESTAMPED(0),
        stderr: '',
      },
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
    // I: the both-flags usage line; J: the already-at and re-stamp lines; the step line: the next cell.
    claim(PAGE, 'It has three subcommands.');
    claim(
      PAGE,
      'both flags: `Cannot combine --backup with --no-backup. Use one or the other.` Nothing is opened.',
    );
    claim(PAGE, '`<home>/realm.db is already at schema version <n>; no schema step to run.`');
    claim(PAGE, '`Re-stamped the phase index of <k> run(s) with the current derivation.`');
    // E (store): the backup's refusal and an unverified copy end the verb before any step.
    claim(
      PAGE,
      "Unless `--no-backup` is given, it makes the copy and prints `realm db backup`'s line. When the copy cannot be made, or fails SQLite's quick check, the command stops there: nothing is migrated.",
    );
    // D (store): the record untouched, and the count.
    claim(PAGE, 'It changes no run record.');
  });

  it("the step line the command prints is the page's, word for word", () => {
    // The command's own line-maker held to the page's sentence, for any step (#597 D1c-1: cell N runs
    // the real step from version 1 to 2 on the built CLI and holds its printed line too).
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
