// db-migrate-r1.test.ts — #616 R1 (prompts/feat-616-r1-migrate-record.md), on the BUILT CLI: the
// shorter `realm db migrate`. With no flag and a schema step pending it backs up into the backups
// folder beside the home and records the migrate there; while another process has the store file open
// it refuses and changes nothing; with no step pending it takes no hold and makes nothing. Each cell's
// printed lines are held to the docs' sentences that quote them (`docs/reference/cli/realm-db.md`, the
// upgrade guide's "A store version change"). The home is `<scratch>/.realm` with HOME set to the scratch
// folder, so its backups folder is `<scratch>/.realm-backups`, never a folder other cells share.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { VERSION } from '@sensigo/realm';
import { openRealmHome } from '@sensigo/realm-store-sqlite';
import { openForeignConnection } from '@sensigo/realm-store-sqlite/test-support';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
const children: ChildProcess[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'realm-616-r1-cli-'));
  base = mkdtempSync(join(tmpdir(), 'realm-616-r1-cwd-'));
  home = join(root, '.realm');
  file = join(home, 'realm.db');
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

const ENV = (): NodeJS.ProcessEnv => ({
  PATH: process.env['PATH'] ?? '',
  HOME: root,
  REALM_NO_NUDGE: '1',
});

/** Runs the built `realm` with HOME set to the scratch root; a run that hangs is killed (a red). */
function realm(args: string[]): Run {
  const r = spawnSync(process.execPath, [DIST_CLI, ...args], {
    cwd: base,
    env: ENV(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
    killSignal: 'SIGKILL',
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** The same, started without waiting: two of them race. */
function realmAsync(args: string[]): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [DIST_CLI, ...args], {
      cwd: base,
      env: ENV(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** A path as the CLI prints it when its output is piped: the scratch HOME's path is masked. */
function shown(path: string): string {
  return path.replace(root, '[REDACTED]');
}

/** The home's store file is the one 0.49.0's release recorded: schema version 1. */
function recordedHome(): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(file, gunzipSync(readFileSync(CORPUS_049)), { mode: 0o600 });
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

/** The store file's schema version, from its header (`user_version`, bytes 60–63). */
function versionOf(path: string): number {
  return readFileSync(path).readUInt32BE(60);
}

/** The sha-256 of a file's bytes, so any change to it shows. */
function hashOf(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** The record file's lines, parsed. */
function records(): Array<Record<string, unknown>> {
  const path = join(root, '.realm-backups', 'migrations.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

// Another process that has the store file open and does nothing: one read, then idle. It opens the
// file through the store package's test entry; its standard error is dropped.
const HOLDER =
  "import { openForeignConnection } from '@sensigo/realm-store-sqlite/test-support';" +
  'const db = await openForeignConnection(process.argv[1]);' +
  "db.prepare('SELECT count(*) FROM sqlite_master').get();" +
  "process.stdout.write('ready\\n');" +
  'setInterval(() => {}, 1000);';

/** Starts a process that holds the home's store file open, idle; resolves once it has read it. */
function holdOpen(): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['--input-type=module', '-e', HOLDER, home], {
    cwd: CLI_ROOT,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  children.push(child);
  return new Promise((resolve, reject) => {
    child.stdout.once('data', () => resolve(child));
    child.once('exit', (code) => reject(new Error(`the holder exited (${code}) before it read`)));
  });
}

/** Stops a holder and waits until it is gone. */
function stop(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once('exit', () => resolve());
    child.kill('SIGKILL');
  });
}

const flat = (t: string): string => t.replace(/\s+/g, ' ');
/** (1) red when the page no longer holds the sentence word for word; (2) prints the sentence. */
function claim(page: string, sentence: string): void {
  expect(
    flat(readFileSync(join(ROOT, page), 'utf8')),
    `${page} no longer says: ${sentence}`,
  ).toContain(flat(sentence));
}

/** A default copy's time stamp, as the guide's example shows one. */
const STAMP = /\d{8}T\d{6}Z/g;

/** The upgrade guide's step 3 example block, its lines unindented. */
function guideExample(): string {
  const text = readFileSync(join(ROOT, GUIDE), 'utf8');
  const at = text.indexOf('3. **Migrate**: `realm db migrate`.');
  const open = text.indexOf('```text\n', at);
  const close = text.indexOf('```', open + 8);
  return text
    .slice(open + 8, close)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .join('\n');
}

const STEP = (evidence: number): string =>
  `Migrated ${shown(file)} from schema version 1 to 2: 1 statement(s) ran, the schema matches ` +
  `version 2's, ${evidence} evidence entries match their stored hashes.`;
const RESTAMPED = 'Re-stamped the phase index of 0 run(s) with the current derivation.';
const IN_USE = (): string =>
  `Another process has ${shown(file)} open (a Realm agent, server, MCP server or command, or ` +
  'another program such as a SQLite browser). Stop it and run this again. Nothing was changed.';

// Each cell starts the built CLI (a cold start each time), so the describe carries its own budget.
describe('#616 R1 — the shorter realm db migrate, on the built CLI', { timeout: 120_000 }, () => {
  it("no flag on the home 0.49.0's release recorded: the copy beside the home passes the quick check, the file is at 2, one record line with its six fields, and the lines are the guide's example", async () => {
    recordedHome();
    const run = realm(['db', 'migrate']);
    const folder = join(root, '.realm-backups');
    const names = existsSync(folder) ? readdirSync(folder).sort() : [];
    const copyName = names.find((n) => n.endsWith('.db')) ?? 'no copy';
    const copy = join(folder, copyName);
    // The copy, checked by SQLite in a home of its own (the store's test entry opens a home's realm.db).
    const check = join(base, 'check');
    mkdirSync(check);
    if (existsSync(copy)) copyFileSync(copy, join(check, 'realm.db'));
    const opened = await openForeignConnection(check);
    const quick = opened.prepare('PRAGMA quick_check').get();
    opened.close();
    const [record] = records();
    const lines = run.stdout.split('\n').filter((l) => l !== '');
    // (1) red when no default copy is made or it is put or named otherwise, when the copy fails the
    //     check, when the file is not moved to 2, when the record is missing, misnamed or misordered,
    //     or when a printed line differs from the guide's example; (2) prints the run, the folder, the
    //     copy's check, the record and the guide's block.
    expect({
      code: run.code,
      stderr: run.stderr,
      lines,
      names,
      quick,
      copyVersion: existsSync(copy) ? versionOf(copy) : 'no copy',
      version: versionOf(file),
      keys: Object.keys(record ?? {}),
      record: { ...record, at: typeof record?.['at'] },
      guide: guideExample().replace(STAMP, '<stamp>'),
    }).toEqual({
      code: 0,
      stderr: '',
      lines: [
        `Backed up ${shown(file)} (schema version 1, 638976 bytes) to ${shown(copy)}; the copy passes SQLite's quick check.`,
        STEP(6),
        `Recorded this migrate in ${shown(join(folder, 'migrations.jsonl'))}.`,
        RESTAMPED,
      ],
      names: ['migrations.jsonl', expect.stringMatching(/^realm-v1-to-v2-\d{8}T\d{6}Z\.db$/)],
      quick: { quick_check: 'ok' },
      copyVersion: 1,
      version: 2,
      keys: ['at', 'home', 'from_format', 'to_format', 'backup', 'migrated_by'],
      record: {
        at: 'string',
        home: realpathSync(home),
        from_format: 1,
        to_format: 2,
        backup: copy,
        migrated_by: VERSION,
      },
      guide: lines.join('\n').replace(STAMP, '<stamp>'),
    });
    // The guide's description of that home: two finished runs (`realm run list`), six evidence entries
    // (the step line above).
    const list = realm(['run', 'list']);
    expect(list.stdout.split('\n').filter((l) => / completed /.test(l)).length).toBe(2);
    claim(
      GUIDE,
      "On the home 0.49.0's release recorded, holding two finished runs and six evidence entries:",
    );
    claim(PAGE, '`Recorded this migrate in <backups folder>/migrations.jsonl.`');
  });

  it('the same home with another process idle on the store file: refused STATE_STORE_IN_USE in its words, and nothing changed (no copy, no record, no backups folder, no temporary file, every byte of realm.db)', async () => {
    recordedHome();
    const holder = await holdOpen();
    const before = hashOf(file);
    const run = realm(['db', 'migrate']);
    await stop(holder);
    // (1) red when the hold is missing (the migrate goes ahead), taken after the backup (the folder
    //     and the copy exist), or left to the store's busy wait (STATE_RUN_BUSY's line); (2) prints the
    //     run, what the scratch root holds and whether realm.db changed.
    expect({ run, root: readdirSync(root), unchanged: hashOf(file) === before }).toEqual({
      run: { code: 1, stdout: '', stderr: `Error: ${IN_USE()}\n` },
      root: ['.realm'],
      unchanged: true,
    });
    claim(
      PAGE,
      '`Another process has <home>/realm.db open (a Realm agent, server, MCP server or command, or another program such as a SQLite browser). Stop it and run this again. Nothing was changed.`',
    );
  });

  it('a file at this Realm’s version with another process idle on it: no hold is taken, the already-at line, exit 0, nothing made', async () => {
    await currentHome();
    const holder = await holdOpen();
    const run = realm(['db', 'migrate']);
    await stop(holder);
    // (1) red when the hold is taken at the open or for every migrate (refused here); (2) prints the
    //     run and the scratch root.
    expect({ run, root: readdirSync(root) }).toEqual({
      run: {
        code: 0,
        stdout:
          `${shown(file)} is already at schema version 2; no schema step to run.\n` +
          `${RESTAMPED}\n`,
        stderr: '',
      },
      root: ['.realm'],
    });
  });

  it('the backups folder cannot be made (a file where it should be): no flag is refused in its words with nothing changed; --no-backup migrates and the record is a warning on standard error, exit 0', () => {
    recordedHome();
    const folder = join(root, '.realm-backups');
    writeFileSync(folder, 'not a folder');
    const before = hashOf(file);
    const refused = realm(['db', 'migrate']);
    const unchanged = hashOf(file) === before;
    const noBackup = realm(['db', 'migrate', '--no-backup']);
    const reason = 'not a directory';
    // (1) red when the default refuses otherwise or changes the file, when --no-backup is refused too,
    //     or when the record's failure fails the migrate or goes to standard output; (2) prints both runs.
    expect({ refused, unchanged, noBackup, version: versionOf(file) }).toEqual({
      refused: {
        code: 1,
        stdout: '',
        stderr:
          `Error: Cannot make the backups folder ${shown(folder)}: ${reason}. Nothing was changed. ` +
          'Use --backup <path> to name another place, or --no-backup.\n',
      },
      unchanged: true,
      noBackup: {
        code: 0,
        stdout: `${STEP(6)}\n${RESTAMPED}\n`,
        stderr:
          `Could not record this migrate in ${shown(join(folder, 'migrations.jsonl'))}: ${reason}. ` +
          'The file is migrated; the record is only a note for going back.\n',
      },
      version: 2,
    });
    claim(
      PAGE,
      "`Cannot make the backups folder <folder>: <the system's reason>. Nothing was changed. Use --backup <path> to name another place, or --no-backup.`",
    );
    claim(
      PAGE,
      "`Could not record this migrate in <path>: <the system's reason>. The file is migrated; the record is only a note for going back.` on standard error",
    );
  });

  it('the record cannot be written (a folder where migrations.jsonl should be): the warning on standard error, exit 0, the file migrated', () => {
    recordedHome();
    mkdirSync(join(root, '.realm-backups', 'migrations.jsonl'), { recursive: true });
    const run = realm(['db', 'migrate']);
    // (1) red when a failed record fails the migrate; (2) prints the run and the file's version.
    expect({
      code: run.code,
      lines: run.stdout.split('\n').filter((l) => l !== '').length,
      stderr: run.stderr,
      version: versionOf(file),
    }).toEqual({
      code: 0,
      lines: 3,
      stderr:
        `Could not record this migrate in ${shown(join(root, '.realm-backups', 'migrations.jsonl'))}: ` +
        'illegal operation on a directory. The file is migrated; the record is only a note for going back.\n',
      version: 2,
    });
  });

  it('two migrates racing in two processes: the file is migrated once and recorded once; the other is refused, fails at its open, or finds nothing to do', async () => {
    recordedHome();
    const [a, b] = await Promise.all([
      realmAsync(['db', 'migrate', '--no-backup']),
      realmAsync(['db', 'migrate', '--no-backup']),
    ]);
    const outcome = (r: Run): string =>
      r.code === 0 && r.stdout.includes('Migrated ')
        ? 'migrated'
        : r.code === 0 && r.stdout.includes('is already at schema version 2')
          ? 'nothing to do'
          : r.code === 1 && r.stderr.includes('Another process has ')
            ? 'refused in use'
            : r.code === 1 && r.stderr.includes('The store was busy for ')
              ? 'busy at its open'
              : `other: ${r.code} ${r.stdout} ${r.stderr}`;
    const outcomes = [outcome(a), outcome(b)].sort();
    // (1) red when both run the step (two step lines, two records), or the loser fails some other
    //     way; (2) prints both outcomes, the record count and the file's version.
    expect({
      migrated: outcomes.filter((o) => o === 'migrated').length,
      other: ['busy at its open', 'nothing to do', 'refused in use'].includes(
        outcomes.find((o) => o !== 'migrated') ?? 'none',
      )
        ? 'allowed'
        : outcomes,
      records: records().length,
      version: versionOf(file),
    }).toEqual({ migrated: 1, other: 'allowed', records: 1, version: 2 });
  });
});
