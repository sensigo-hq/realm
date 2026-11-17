// rollback-r3.test.ts — #616 R3 (prompts/feat-616-r3-rollback.md), on the BUILT CLI: `realm rollback`,
// the undo of the last migrate recorded for this home. The home 0.49.0's release recorded is migrated
// forward by the built CLI, then rolled back: the progress line, R2's step back with its lines, the
// record, the install line, and every run kept. Then each state the command refuses: no store file,
// a record that cannot be read, no valid line for this home, a file at another version than the last
// line's, a last line that is a step back. The cells that need a seam (the versions, `beforeHold`) or a
// holding process are the store package's (`maintenance-rollback-r3.test.ts`). The home is
// `<scratch>/.realm` with HOME set to the scratch folder, so its backups folder is
// `<scratch>/.realm-backups`, never a folder other cells share.
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { openRealmHome, openRealmHomeForMaintenance } from '@sensigo/realm-store-sqlite';
import { openForeignConnection } from '@sensigo/realm-store-sqlite/test-support';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { storeTopLevelCommands, topLevelCommands } from '../commands-registry.js';

const AS_ROOT = process.getuid?.() === 0;
const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = join(HERE, '..', '..');
const DIST_CLI = join(CLI_ROOT, 'dist', 'index.js');
const ROOT = join(CLI_ROOT, '..', '..');
const CORPUS_049 = join(HERE, '..', 'corpus', '0.49.0', 'realm.db.gz');
const PAGE = 'docs/reference/cli/realm-db.md';
const GUIDE = 'docs/guides/upgrade.md';

let root = '';
let base = '';
let home = '';
let file = '';
let folder = '';
let record = '';
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'realm-616-r3-cli-')));
  base = mkdtempSync(join(tmpdir(), 'realm-616-r3-cwd-'));
  home = join(root, '.realm');
  file = join(home, 'realm.db');
  folder = join(root, '.realm-backups');
  record = join(folder, 'migrations.jsonl');
});
afterEach(() => {
  for (const path of [folder, record]) {
    try {
      chmodSync(path, 0o700);
    } catch {
      // not there
    }
  }
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

/** A path as the CLI prints it when its output is piped: the scratch HOME's path is masked. */
function shown(path: string): string {
  return path.replace(root, '[REDACTED]');
}

/** The home's store file is the one 0.49.0's release recorded: schema version 1. */
function recordedHome(at: string = home): void {
  mkdirSync(at, { recursive: true });
  writeFileSync(join(at, 'realm.db'), gunzipSync(readFileSync(CORPUS_049)), { mode: 0o600 });
}

/** A home whose store file is at this Realm's version (2), made by the store package's open. */
async function currentHome(): Promise<void> {
  const h = await openRealmHome({ home });
  await h.runStore.create({
    workflowId: 'triage',
    workflowVersion: 1,
    params: {},
    extensionIdentity: [],
  });
  h.close();
}

/** What a cell reads of the store file by SQL: the counts and the schema's statements. */
async function readFile(at: string = home): Promise<{
  runs: number;
  evidence: number;
  schema: string[];
}> {
  const db = await openForeignConnection(at);
  try {
    const count = (sql: string): number => Number(Object.values(db.prepare(sql).get() ?? {})[0]);
    return {
      runs: count('SELECT COUNT(*) FROM runs'),
      evidence: count('SELECT COUNT(*) FROM evidence'),
      // Every object's text as `sqlite_master` stores it (the indexes behind keys have none).
      schema: db
        .prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*'")
        .all()
        .map((row) => String(row['sql']))
        .sort(),
    };
  } finally {
    db.close();
  }
}

/** The store file's schema version, from its header (`user_version`, bytes 60–63). */
function versionOf(path: string): number {
  return readFileSync(path).readUInt32BE(60);
}

/** The sha-256 of a file's bytes, so any change to it shows. */
function hashOf(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** The record file's lines, parsed (the cells that write invalid lines do not call it). */
function records(): Array<Record<string, unknown>> {
  if (!existsSync(record)) return [];
  return readFileSync(record, 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** What a refusal leaves to compare: the store file's bytes, and the backups folder's names. */
function state(): unknown {
  return {
    hash: existsSync(file) ? hashOf(file) : 'no file',
    backups: !existsSync(folder)
      ? 'no folder'
      : statSync(folder).isDirectory()
        ? readdirSync(folder).sort()
        : `a file of ${statSync(folder).size} bytes`,
  };
}

const lines = (t: string): string[] => t.split('\n').filter((l) => l !== '');
const flat = (t: string): string => t.replace(/\s+/g, ' ');
/** (1) red when the page no longer holds the sentence word for word; (2) prints the sentence. */
function claim(page: string, sentence: string): void {
  expect(
    flat(readFileSync(join(ROOT, page), 'utf8')),
    `${page} no longer says: ${sentence}`,
  ).toContain(flat(sentence));
}

// The lines, as the command prints them; the docs quote the same templates (the words cell).
const ROLLING = (at: string, from: number, to: number, by: string): string =>
  `Rolling back the migrate recorded at ${at} (schema version ${from} to ${to}, by Realm ${by}): ` +
  `stepping the store file back to schema version ${from}.`;
const NO_RECORD = (): string =>
  `Error: No record of a migrate of ${shown(home)} was found in ${shown(record)}, so Realm does not ` +
  'know which version to go back to. Use realm db migrate --to <n> to choose the version yourself, ' +
  'or realm db restore <backup> to put a backup back. Nothing was changed.';
const UNREADABLE = (reason: string): string =>
  `Error: Cannot read ${shown(record)}: ${reason}. Nothing was changed. Use realm db migrate --to ` +
  '<n> to choose the version yourself, or realm db restore <backup> to put a backup back.';
const MISMATCH = (at: string, from: number, to: number, v: number): string =>
  `Error: The last record for ${shown(home)} (${at}) took the store file from schema version ` +
  `${from} to ${to}, but it is at schema version ${v} now. Realm does not know what to roll back. ` +
  'Use realm db migrate --to <n> to choose the version yourself, or realm db restore <backup>. ' +
  'Nothing was changed.';
const STEPPED_BACK = (at: string, to: number): string =>
  `Error: The last record for ${shown(home)} is a step back to schema version ${to} (${at}). There ` +
  'is nothing to roll back: to go back further, use realm db migrate --to <n>. Nothing was changed.';

/** A record line as R1 writes it, for this home unless another is named. */
function line(fields: Record<string, unknown> = {}): string {
  return JSON.stringify({
    at: '2026-11-17T10:00:00.000Z',
    home,
    from_format: 1,
    to_format: 2,
    backup: null,
    migrated_by: '0.50.0',
    ...fields,
  });
}

// Each cell starts the built CLI (a cold start each time), so the describe carries its own budget.
describe('#616 R3 — realm rollback, on the built CLI', { timeout: 120_000 }, () => {
  it("the home 0.49.0's release recorded, migrated by this build, then rolled back: the lines, every run kept, the file exactly version 1's, the copy, the record, and run list refusing", async () => {
    recordedHome();
    const before = await readFile();
    expect(realm(['db', 'migrate']).code).toBe(0);
    const forward = records()[0]!;
    const rolled = realm(['rollback']);
    const after = await readFile();
    const last = records().at(-1);
    const copy = String(last?.['backup']);
    const list = realm(['run', 'list']);
    // (1) red when a step is missing (the file stays at 2), the target is wrong, the progress line or
    //     the install line is not printed, a run or an entry is lost, or no record line is written;
    //     (2) prints every line, the counts, the schema's difference and the record line.
    expect({
      code: rolled.code,
      stdout: lines(rolled.stdout),
      stderr: rolled.stderr,
      version: versionOf(file),
      kept: { runs: after.runs, evidence: after.evidence },
      schema: after.schema,
      record: { from: last?.['from_format'], to: last?.['to_format'], lines: records().length },
      copy: { name: copy.replace(/\d{8}T\d{6}Z/, '<stamp>'), version: versionOf(copy) },
      list: { code: list.code, stderr: list.stderr },
    }).toEqual({
      code: 0,
      stdout: [
        ROLLING(String(forward['at']), 1, 2, String(forward['migrated_by'])),
        `Backed up ${shown(file)} (schema version 2, ${readFileSync(copy).length} bytes) to ` +
          `${shown(copy)}; the copy passes SQLite's quick check.`,
        `Stepped ${shown(file)} back from schema version 2 to 1: 1 statement(s) ran, the schema ` +
          "matches version 1's. The outbound table was dropped; it held no record of a reminder or " +
          'escalation sent.',
        `Recorded this migrate in ${shown(record)}.`,
        'Every command of this Realm that uses the store, except `realm db check`, `realm db ' +
          'backup`, `realm db migrate` and `realm db restore`, now refuses the file, because it is ' +
          'at schema version 1 and this Realm writes version 2. To use it, install a Realm that ' +
          'writes schema version 1: npm install -g "@sensigo/realm-cli@0.49" (in a project that ' +
          'lists Realm packages, give every one of them the same exact version within 0.49; see ' +
          '"Upgrade every package together" in the upgrade guide).',
      ],
      stderr: '',
      version: 1,
      kept: { runs: before.runs, evidence: before.evidence },
      schema: before.schema,
      record: { from: 2, to: 1, lines: 2 },
      copy: { name: join(folder, 'realm-v2-to-v1-<stamp>.db'), version: 2 },
      list: {
        code: 1,
        stderr:
          "Error: This store's file is at schema version 1; this Realm writes version 2. Run " +
          '`realm db migrate` with Realm stopped to upgrade it.\n',
      },
    });
    expect(before.runs).toBeGreaterThan(0);
  });

  it('state 1: no store file, an empty one, a newer one: the store file’s own refusal, nothing created', async () => {
    const none = realm(['rollback']);
    const noneLeft = existsSync(root) ? readdirSync(root) : [];
    mkdirSync(home, { recursive: true });
    writeFileSync(file, '');
    const empty = realm(['rollback']);
    const emptyLeft = readdirSync(home).sort();
    rmSync(home, { recursive: true, force: true });
    await currentHome();
    const db = await openForeignConnection(home);
    db.exec('PRAGMA user_version = 3');
    db.close();
    const newer = realm(['rollback']);
    // (1) red when a missing or empty file takes the migrate's words, a stack escapes, or the open
    //     creates a store; (2) prints the three refusals and what is left.
    expect({ none, noneLeft, empty, emptyLeft, newer }).toEqual({
      none: {
        code: 1,
        stdout: '',
        stderr: `Error: There is no store file at ${shown(file)} to roll back.\n`,
      },
      noneLeft: [],
      empty: {
        code: 1,
        stdout: '',
        stderr: `Error: ${shown(file)} holds no store yet: there is nothing to roll back.\n`,
      },
      emptyLeft: ['realm.db'],
      newer: {
        code: 1,
        stdout: '',
        stderr:
          'Error: This store was migrated by a newer Realm: its schema is version 3 and this Realm ' +
          'writes version 2. Upgrade Realm to read or write it.\n',
      },
    });
  });

  it('state 2: the record is a folder, cannot be read, or sits under a file: the system’s reason, nothing changed', async () => {
    await currentHome();
    const outcomes: Record<string, unknown> = {};
    // A folder in the record's place.
    mkdirSync(record, { recursive: true });
    let before = state();
    outcomes['a folder'] = {
      r: realm(['rollback']),
      unchanged: JSON.stringify(state()) === JSON.stringify(before),
    };
    rmSync(folder, { recursive: true, force: true });
    // A file where the backups folder should be.
    writeFileSync(folder, 'not a folder');
    before = state();
    outcomes['under a file'] = {
      r: realm(['rollback']),
      unchanged: JSON.stringify(state()) === JSON.stringify(before),
    };
    rmSync(folder, { force: true });
    // (1) red when an error other than a missing file escapes as a stack, or is read as no record;
    //     (2) prints each refusal and whether anything changed.
    expect(outcomes).toEqual({
      'a folder': {
        r: { code: 1, stdout: '', stderr: `${UNREADABLE('illegal operation on a directory')}\n` },
        unchanged: true,
      },
      'under a file': {
        r: { code: 1, stdout: '', stderr: `${UNREADABLE('not a directory')}\n` },
        unchanged: true,
      },
    });
  });

  it.skipIf(AS_ROOT || process.platform === 'win32')(
    'state 2: a record that cannot be read (no permission): the system’s reason, nothing changed',
    async () => {
      await currentHome();
      mkdirSync(folder, { recursive: true });
      writeFileSync(record, `${line()}\n`);
      chmodSync(record, 0o000);
      const before = state();
      const r = realm(['rollback']);
      chmodSync(record, 0o600);
      // (1) red when EACCES escapes as a stack or is read as no record; (2) prints the refusal.
      expect({ r, after: state() }).toEqual({
        r: { code: 1, stdout: '', stderr: `${UNREADABLE('permission denied')}\n` },
        after: before,
      });
    },
  );

  it('state 3: no record file, an empty one, another home’s lines only, only invalid lines: no record, nothing changed', async () => {
    await currentHome();
    const outcomes: Record<string, unknown> = {};
    const noFile = realm(['rollback']);
    outcomes['no record file'] = { r: noFile, folder: existsSync(folder) ? 'made' : 'none' };
    mkdirSync(folder, { recursive: true });
    const cases: Array<[string, string]> = [
      ['an empty record', ''],
      ['another home only', `${line({ home: join(root, 'other') })}\n`],
      ['not JSON', `${line().slice(0, -1)}\n`],
      ['a missing field', `${JSON.stringify({ ...JSON.parse(line()), migrated_by: undefined })}\n`],
      ['a format of 1.5', `${line({ from_format: 1.5 })}\n`],
      ['a format of 0', `${line({ from_format: 0 })}\n`],
      ['a format this Realm does not know', `${line({ from_format: 9 })}\n`],
      ['from equal to to', `${line({ from_format: 2 })}\n`],
      ['a field of the wrong type', `${line({ backup: 7 })}\n`],
    ];
    for (const [name, text] of cases) {
      writeFileSync(record, text);
      const before = state();
      outcomes[name] = {
        r: realm(['rollback']),
        unchanged: JSON.stringify(state()) === JSON.stringify(before),
      };
    }
    const expected = { code: 1, stdout: '', stderr: `${NO_RECORD()}\n` };
    // (1) red when the command rolls back without a record, reads another home's line, or trusts
    //     an invalid one (each case alone, so the last line is the one judged); (2) prints each
    //     outcome by name.
    expect(outcomes).toEqual({
      'no record file': { r: expected, folder: 'none' },
      ...Object.fromEntries(cases.map(([name]) => [name, { r: expected, unchanged: true }])),
    });
  });

  it('two homes in one parent folder: only the home asked for steps back, by its own line; the other is untouched', async () => {
    recordedHome();
    expect(realm(['db', 'migrate']).code).toBe(0);
    const mine = records()[0]!;
    // The other home, beside it, migrated by the store API with no backup (two default copies in
    // one second would collide): its line is the LAST one in the shared record.
    const other = join(root, 'other');
    recordedHome(other);
    const m = await openRealmHomeForMaintenance({ home: other, verb: 'migrate' });
    await m.migrate({ backup: false });
    m.close();
    const otherHash = hashOf(join(other, 'realm.db'));
    expect(records().at(-1)?.['home']).toBe(other);
    const rolled = realm(['rollback']);
    // (1) red when the record is read without the home filter (the other home's line would be the
    //     one named); (2) prints the first line, both versions and whether the other changed.
    expect({
      code: rolled.code,
      first: lines(rolled.stdout)[0],
      mine: versionOf(file),
      other: {
        version: versionOf(join(other, 'realm.db')),
        untouched: hashOf(join(other, 'realm.db')) === otherHash,
      },
    }).toEqual({
      code: 0,
      first: ROLLING(String(mine['at']), 1, 2, String(mine['migrated_by'])),
      mine: 1,
      other: { version: 2, untouched: true },
    });
  });

  it('state 4: the migrate’s own backup restored, or an invalid later line after a step back: nothing changed', async () => {
    recordedHome();
    expect(realm(['db', 'migrate']).code).toBe(0);
    const forward = records()[0]!;
    expect(realm(['db', 'restore', String(forward['backup'])]).code).toBe(0);
    const before = state();
    const restored = realm(['rollback']);
    const restoredAfter = state();
    // An invalid later line after a step back: forward, back, forward again (no copy: the same
    // second), then the last line damaged. The last VALID line is the step back, to version 1, and
    // the file is at 2.
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    recordedHome();
    expect(realm(['db', 'migrate']).code).toBe(0);
    expect(realm(['db', 'migrate', '--to', '1']).code).toBe(0);
    expect(realm(['db', 'migrate', '--no-backup']).code).toBe(0);
    const [, back] = records();
    const text = readFileSync(record, 'utf8').split('\n');
    writeFileSync(record, [...text.slice(0, 2), '{"at": "damaged', ''].join('\n'));
    const before2 = state();
    const damaged = realm(['rollback']);
    // (1) red when a file the record does not describe is rolled back, or the stale step-back line
    //     decides (state 5's words); (2) prints both refusals and whether anything changed.
    expect({
      restored: {
        r: restored,
        unchanged: JSON.stringify(restoredAfter) === JSON.stringify(before),
      },
      damaged: { r: damaged, unchanged: JSON.stringify(state()) === JSON.stringify(before2) },
    }).toEqual({
      restored: {
        r: { code: 1, stdout: '', stderr: `${MISMATCH(String(forward['at']), 1, 2, 1)}\n` },
        unchanged: true,
      },
      damaged: {
        r: { code: 1, stdout: '', stderr: `${MISMATCH(String(back!['at']), 2, 1, 2)}\n` },
        unchanged: true,
      },
    });
  });

  it('a version-2 backup restored after the migrate: the file is at the line’s version, so it rolls back', async () => {
    recordedHome();
    expect(realm(['db', 'migrate']).code).toBe(0);
    const forward = records()[0]!;
    const copy = join(root, 'v2.db');
    expect(realm(['db', 'backup', copy]).code).toBe(0);
    expect(realm(['db', 'restore', copy]).code).toBe(0);
    const rolled = realm(['rollback']);
    // (1) red when a "was it restored" check refuses it (no such history exists: the version is
    //     compared); (2) prints the outcome and the version.
    expect({ code: rolled.code, first: lines(rolled.stdout)[0], version: versionOf(file) }).toEqual(
      {
        code: 0,
        first: ROLLING(String(forward['at']), 1, 2, String(forward['migrated_by'])),
        version: 1,
      },
    );
  });

  it('state 5: the last line is a step back and the file is at its version: nothing to roll back', () => {
    recordedHome();
    expect(realm(['db', 'migrate']).code).toBe(0);
    expect(realm(['db', 'migrate', '--to', '1']).code).toBe(0);
    const back = records().at(-1)!;
    const before = state();
    const r = realm(['rollback']);
    // (1) red when a second step back is attempted (a forward step from 1, or `--to 0`); (2) prints
    //     the refusal and whether anything changed.
    expect({ r, unchanged: JSON.stringify(state()) === JSON.stringify(before) }).toEqual({
      r: { code: 1, stdout: '', stderr: `${STEPPED_BACK(String(back['at']), 1)}\n` },
      unchanged: true,
    });
  });

  it('--help, the registry and the command tree: top-level, no options, not in the list realm-cloud registers', () => {
    const help = realm(['rollback', '--help']);
    const top = realm(['--help']);
    const flag = realm(['rollback', '--to', '1']);
    const [command] = storeTopLevelCommands;
    // (1) red when the command is missing, gains an option, or is put in `topLevelCommands`
    //     (realm-cloud's CLI registers that list); (2) prints the help, the lists and the refusal.
    expect({
      help: help.stdout.replace(/\s+/g, ' ').trim(),
      listed: /^ {2}rollback +Undo the last migrate/m.test(top.stdout),
      store: storeTopLevelCommands.map((c) => c.name()),
      cloud: topLevelCommands.map((c) => c.name()).includes('rollback'),
      options: command?.options.map((o) => o.long),
      flag: { code: flag.code, stderr: flag.stderr },
    }).toEqual({
      help:
        'Usage: realm rollback [options] Undo the last migrate of this home: step the store file ' +
        'back to the version before it, using the record realm db migrate kept; stop every Realm ' +
        'process first Options: -h, --help display help for command',
      listed: true,
      store: ['rollback'],
      cloud: false,
      options: [],
      flag: { code: 1, stderr: "error: unknown option '--to'\n" },
    });
  });

  it('the words: the page, the guide, the changelog and the error codes say what the command prints and does', () => {
    // Each line a run prints is held to these by the cells above (built from the same templates).
    for (const sentence of [
      '`Rolling back the migrate recorded at <at> (schema version <from_format> to <to_format>, by Realm <migrated_by>): stepping the store file back to schema version <from_format>.`',
      '`There is no store file at <home>/realm.db to roll back.`',
      '`<home>/realm.db holds no store yet: there is nothing to roll back.`',
      "`Cannot read <backups folder>/migrations.jsonl: <the system's reason>. Nothing was changed. Use realm db migrate --to <n> to choose the version yourself, or realm db restore <backup> to put a backup back.`",
      '`No record of a migrate of <home> was found in <backups folder>/migrations.jsonl, so Realm does not know which version to go back to. Use realm db migrate --to <n> to choose the version yourself, or realm db restore <backup> to put a backup back. Nothing was changed.`',
      '`The last record for <home> (<at>) took the store file from schema version <from_format> to <to_format>, but it is at schema version <v> now. Realm does not know what to roll back. Use realm db migrate --to <n> to choose the version yourself, or realm db restore <backup>. Nothing was changed.`',
      '`The last record for <home> is a step back to schema version <to_format> (<at>). There is nothing to roll back: to go back further, use realm db migrate --to <n>. Nothing was changed.`',
      '`The step from schema version <v> to <v-1> cannot be undone: <why>. Nothing was changed. To go back anyway, restore the backup that migrate made: realm db restore <path>.`',
      '`The step from schema version <v> to <v-1> cannot be undone: <why>. Nothing was changed. That migrate made no backup: restore one of your own with realm db restore <backup> (the backups realm db migrate makes are in <backups folder>/).`',
      "`Cannot make the backups folder <folder>: <the system's reason>. Nothing was changed. Use realm db migrate --to <from_format> with --backup <path> to name another place, or --no-backup.`",
    ]) {
      claim(PAGE, sentence);
    }
    claim(GUIDE, '`realm rollback` finds the version for you');
    claim(
      'CHANGELOG.md',
      '- **`realm rollback` undoes the last migrate of this home, using the record it left** (#616)',
    );
    claim('CHANGELOG.md', '`realm rollback --help`');
    for (const code of [
      'STATE_STORE_MIGRATE_REFUSED',
      'STATE_STORE_MIGRATE_FAILED',
      'STATE_STORE_IN_USE',
    ]) {
      const row = readFileSync(join(ROOT, 'docs/reference/error-codes.md'), 'utf8')
        .split('\n')
        .find((l) => l.startsWith(`| \`${code}\``));
      // (1) red when an error-code row stops naming `realm rollback`; (2) prints the row.
      expect(row, `the ${code} row`).toContain('`realm rollback`');
    }
  });
});
