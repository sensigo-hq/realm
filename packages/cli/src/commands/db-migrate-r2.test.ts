// db-migrate-r2.test.ts — #616 R2 (prompts/feat-616-r2-step-back.md), on the BUILT CLI: `realm db migrate
// --to <n>`, the step back. The home 0.49.0's release recorded is migrated forward, given `outbound`
// rows by SQL (one per status: the ledger would refuse them, the recorded runs hold no open gate), and
// stepped back to 1: every run and evidence entry kept, the file exactly version 1's, the copy and the
// record, the page's lines, and the refusal every other command then prints. Each printed line is held
// to the docs' sentence that quotes it. The home is `<scratch>/.realm` with HOME set to the scratch
// folder, so its backups folder is `<scratch>/.realm-backups`, never a folder other cells share.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { REALM_STORE_SCHEMA_VERSION, REALM_STORE_VERSIONS } from '@sensigo/realm';
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
let folder = '';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'realm-616-r2-cli-'));
  base = mkdtempSync(join(tmpdir(), 'realm-616-r2-cwd-'));
  home = join(root, '.realm');
  file = join(home, 'realm.db');
  folder = join(root, '.realm-backups');
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

/** What a cell reads of the store file by SQL: the counts, the schema's statements and the version. */
async function readFile(): Promise<{
  runs: number;
  evidence: number;
  outbound: string;
  schema: string[];
}> {
  const db = await openForeignConnection(home);
  try {
    const count = (sql: string): number => Number(Object.values(db.prepare(sql).get() ?? {})[0]);
    const hasOutbound =
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'outbound'").get() !== undefined;
    return {
      runs: count('SELECT COUNT(*) FROM runs'),
      evidence: count('SELECT COUNT(*) FROM evidence'),
      outbound: hasOutbound ? `${count('SELECT COUNT(*) FROM outbound')} row(s)` : 'no table',
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

/** Writes one `outbound` row per status (`pending`, `sent`, `failed`) by SQL. */
async function outboundRows(): Promise<void> {
  const db = await openForeignConnection(home);
  try {
    const insert = db.prepare(
      'INSERT INTO outbound (run_id, entry_key, type, status, lease_token, lease_deadline, attempts, ' +
        "created_at) VALUES ('r', ?, 'reminder', ?, 't', '2026-01-01T00:00:00.000Z', 1, " +
        "'2026-01-01T00:00:00.000Z')",
    );
    for (const [key, status] of [
      ['a', 'pending'],
      ['b', 'sent'],
      ['c', 'failed'],
    ]) {
      insert.run(key, status);
    }
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

/** The record file's lines, parsed. */
function records(): Array<Record<string, unknown>> {
  const path = join(folder, 'migrations.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
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

/** A default copy's time stamp, as the guide's example shows one. */
const STAMP = /\d{8}T\d{6}Z/g;

/** The guide's "Going back without losing runs" example block, its lines unindented. */
function guideExample(): string {
  const text = readFileSync(join(ROOT, GUIDE), 'utf8');
  const at = text.indexOf('## Going back without losing runs');
  const open = text.indexOf('```text\n', at);
  const close = text.indexOf('```', open + 8);
  return text
    .slice(open + 8, close)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .join('\n');
}

const STEPPED = (from: number, to: number, loses: string, statements = 1): string =>
  `Stepped ${shown(file)} back from schema version ${from} to ${to}: ${statements} statement(s) ran, the ` +
  `schema matches version ${to}'s. ${loses}`;
const SENT = (k: number): string =>
  `The outbound table was dropped: the record of ${k} reminder(s) and escalation(s) sent is no longer in the file.`;
const NONE = 'The outbound table was dropped; it held no record of a reminder or escalation sent.';
/** Callback B1a: version 3's step back (two statements) on a file with no callback row or key. */
const NONE_3 =
  'The callbacks and callback_keys tables were dropped; they held no undelivered callback and no signing key.';
const INSTALL = (n: number, r: number, range: string): string =>
  'Every command of this Realm that uses the store, except `realm db check`, `realm db backup`, ' +
  '`realm db migrate` and `realm db restore`, now refuses the file, because it is at schema ' +
  `version ${n} and this Realm writes version ${r}. To use it, install a Realm that writes schema ` +
  `version ${n}: npm install -g "@sensigo/realm-cli@${range}" (in a project that lists Realm ` +
  `packages, give every one of them the same exact version within ${range}; see "Upgrade every ` +
  'package together" in the upgrade guide).';
const UNKNOWN = (value: string): string =>
  `Error: Cannot step back to ${value}: give a whole number that is a schema version this Realm ` +
  `knows (1 to ${REALM_STORE_SCHEMA_VERSION}).`;
const OLDER =
  `Error: This store's file is at schema version 1; this Realm writes version ${REALM_STORE_SCHEMA_VERSION}. Run \`realm db ` +
  'migrate` with Realm stopped to upgrade it.';

// Each cell starts the built CLI (a cold start each time), so the describe carries its own budget.
describe('#616 R2 — realm db migrate --to, on the built CLI', { timeout: 120_000 }, () => {
  it("the home 0.49.0's release recorded, migrated, given outbound rows, stepped back to 1: every run and evidence entry kept, the file exactly version 1's, the copy, one record line from this Realm's version to 1, the page's lines, and every command then refuses the file", async () => {
    recordedHome();
    const forward = realm(['db', 'migrate', '--no-backup']);
    await outboundRows();
    const before = await readFile();
    const run = realm(['db', 'migrate', '--to', '1']);
    const after = await readFile();
    const names = existsSync(folder) ? readdirSync(folder).sort() : [];
    const copy = join(folder, names.find((n) => n.endsWith('.db')) ?? 'no copy');
    const listed = realm(['run', 'list']);
    const last = records().at(-1);
    // (1) red when a step is missing or a run or an evidence entry is lost, when the schema is not
    //     version 1's, when the copy or the record is missing or misnamed, when a printed line differs
    //     from the page's (the count, the range), or when the file is left at 2; (2) prints the runs,
    //     the counts and schemas, the folder, the record and `run list`'s answer.
    expect({
      forward: forward.code,
      code: run.code,
      stderr: run.stderr,
      lines: lines(run.stdout),
      runsKept: after.runs === before.runs && after.evidence === before.evidence,
      counts: { runs: after.runs, evidence: after.evidence },
      outbound: { before: before.outbound, after: after.outbound },
      schemaIsVersion1:
        after.schema.join('\n') === [...REALM_STORE_VERSIONS.get(1)!.schema].sort().join('\n'),
      version: versionOf(file),
      names,
      copyVersion: existsSync(copy) ? versionOf(copy) : 'no copy',
      record: { from: last?.['from_format'], to: last?.['to_format'], backup: last?.['backup'] },
      listed: { code: listed.code, stderr: lines(listed.stderr) },
    }).toEqual({
      forward: 0,
      code: 0,
      stderr: '',
      lines: [
        `Backed up ${shown(file)} (schema version ${REALM_STORE_SCHEMA_VERSION}, ${existsSync(copy) ? statSync(copy).size : 0} bytes) to ${shown(copy)}; the copy passes SQLite's quick check.`,
        // Callback B1a: version 3's step back first, then version 2's.
        STEPPED(3, 2, NONE_3, 2),
        STEPPED(2, 1, SENT(1)),
        `Recorded this migrate in ${shown(join(folder, 'migrations.jsonl'))}.`,
        INSTALL(1, REALM_STORE_SCHEMA_VERSION, '0.49'),
      ],
      runsKept: true,
      counts: { runs: 2, evidence: 6 },
      outbound: { before: '3 row(s)', after: 'no table' },
      schemaIsVersion1: true,
      version: 1,
      names: [
        'migrations.jsonl',
        expect.stringMatching(
          new RegExp(`^realm-v${REALM_STORE_SCHEMA_VERSION}-to-v1-\\d{8}T\\d{6}Z\\.db$`),
        ),
      ],
      copyVersion: REALM_STORE_SCHEMA_VERSION,
      record: { from: REALM_STORE_SCHEMA_VERSION, to: 1, backup: copy },
      listed: { code: 1, stderr: [OLDER] },
    });
  });

  it("the guide's example: the recorded home, migrated, then stepped back with no outbound rows, prints the guide's block", () => {
    recordedHome();
    realm(['db', 'migrate', '--no-backup']);
    const run = realm(['db', 'migrate', '--to', '1']);
    // (1) red when a printed line differs from the guide's example (the zero sentence, the range);
    //     (2) prints the run and the guide's block, the copy's time stamps masked.
    expect({
      code: run.code,
      printed: lines(run.stdout).join('\n').replace(STAMP, '<stamp>'),
    }).toEqual({ code: 0, printed: guideExample().replace(STAMP, '<stamp>') });
    expect(lines(run.stdout).slice(1, 3)).toEqual([STEPPED(3, 2, NONE_3, 2), STEPPED(2, 1, NONE)]);
  });

  it('--to equal to the file’s version: the nothing-to-undo line, exit 0; no copy (a --backup path ignored), no record, no folder', async () => {
    await currentHome();
    const before = hashOf(file);
    const top = String(REALM_STORE_SCHEMA_VERSION);
    const plain = realm(['db', 'migrate', '--to', top]);
    const target = join(base, 'asked-for.db');
    const withTarget = realm(['db', 'migrate', '--to', top, '--backup', target]);
    const already = `${shown(file)} is already at schema version ${top}; no step to undo.`;
    // (1) red when a copy, a record or the folder is made for a file already there; (2) prints both
    //     runs, the scratch folder and the target.
    expect({
      plain: { code: plain.code, stdout: lines(plain.stdout), stderr: plain.stderr },
      withTarget: { code: withTarget.code, stdout: lines(withTarget.stdout) },
      root: readdirSync(root),
      target: existsSync(target),
      unchanged: hashOf(file) === before,
    }).toEqual({
      plain: { code: 0, stdout: [already], stderr: '' },
      withTarget: { code: 0, stdout: [already] },
      root: ['.realm'],
      target: false,
      unchanged: true,
    });
  });

  it("refusals: --to above the file's version, 0, a word and 99, each one Error line in its own words, exit 1, nothing changed", () => {
    recordedHome();
    const before = hashOf(file);
    const runs = Object.fromEntries(
      ['2', '0', 'abc', '99'].map((value) => {
        const r = realm(['db', 'migrate', '--to', value]);
        return [value, { code: r.code, stdout: r.stdout, stderr: lines(r.stderr) }];
      }),
    );
    // (1) red when a step is run on a file below the version asked for, or a stack trace replaces
    //     the words; (2) prints each run and the scratch folder.
    expect({ runs, root: readdirSync(root), unchanged: hashOf(file) === before }).toEqual({
      runs: {
        '2': {
          code: 1,
          stdout: '',
          stderr: [
            'Error: The store file is at schema version 1; --to steps back only. Run realm db ' +
              'migrate, without --to, to go forward.',
          ],
        },
        '0': { code: 1, stdout: '', stderr: [UNKNOWN('0')] },
        abc: { code: 1, stdout: '', stderr: [UNKNOWN('abc')] },
        '99': { code: 1, stdout: '', stderr: [UNKNOWN('99')] },
      },
      root: ['.realm'],
      unchanged: true,
    });
  });

  it("--to followed by a flag: --to --backup is the value's own refusal; --to --backup x is Commander's refusal of the extra word; nothing changed", () => {
    // The prompt expected `--to --backup x` to print the value's refusal: Commander takes `--backup`
    // as `--to`'s value and `x` as an argument `migrate` does not take, and refuses that first, as it
    // does for `realm run list --status --older-than 3d` (MA 3, 2026-11-17: pin it as it behaves).
    recordedHome();
    const before = hashOf(file);
    const flag = realm(['db', 'migrate', '--to', '--backup']);
    const extra = realm(['db', 'migrate', '--to', '--backup', 'x']);
    // (1) red when `--to`'s value is not checked (the open runs: the older-file refusal), or the
    //     extra word is accepted; (2) prints both runs and the scratch folder.
    expect({
      flag: { code: flag.code, stderr: lines(flag.stderr) },
      extra: { code: extra.code, stderr: lines(extra.stderr) },
      root: readdirSync(root),
      unchanged: hashOf(file) === before,
    }).toEqual({
      flag: { code: 1, stderr: [UNKNOWN('--backup')] },
      extra: {
        code: 1,
        stderr: ["error: too many arguments for 'migrate'. Expected 0 arguments but got 1: x."],
      },
      root: ['.realm'],
      unchanged: true,
    });
  });

  it('the words: the page, the guide and the changelog say what the command prints and does', () => {
    // Each line a run prints is held to these by the cells above (built from the same templates).
    for (const sentence of [
      "`Stepped <home>/realm.db back from schema version <v> to <v-1>: <s> statement(s) ran, the schema matches version <v-1>'s. <what the step dropped>`",
      '`The outbound table was dropped: the record of <k> reminder(s) and escalation(s) sent is no longer in the file.`',
      '`The outbound table was dropped; it held no record of a reminder or escalation sent.`',
      '``Every command of this Realm that uses the store, except `realm db check`, `realm db backup`, `realm db migrate` and `realm db restore`, now refuses the file, because it is at schema version <n> and this Realm writes version <r>. To use it, install a Realm that writes schema version <n>: npm install -g "@sensigo/realm-cli@<range>" (in a project that lists Realm packages, give every one of them the same exact version within <range>; see "Upgrade every package together" in the upgrade guide).``',
      '`<range>` is `0.49` for schema version 1.',
      '`<home>/realm.db is already at schema version <n>; no step to undo.`',
      '`Cannot step back to <value>: give a whole number that is a schema version this Realm knows (<lowest> to <highest>).`',
      '`The store file is at schema version <v>; --to steps back only. Run realm db migrate, without --to, to go forward.`',
      '`The step from schema version <v> to <v-1> cannot be undone: <why>. Nothing was changed. To go back anyway, restore a backup made before the upgrade: realm db restore <backup> (the backups realm db migrate makes are in <backups folder>/).`',
      '`The step back from schema version <v> to <v-1> failed: <the reason>. <home>/realm.db is at schema version <v>; nothing of the step is in it. Run the command again once the cause is fixed.`',
    ]) {
      claim(PAGE, sentence);
    }
    claim(
      GUIDE,
      '`realm db migrate --to 1` takes a file at version 2 back to version 1, the version 0.49.0 writes.',
    );
    claim(
      'CHANGELOG.md',
      '- **`realm db migrate --to` steps the store file back to an older schema version and keeps every run** (#616)',
    );
    // Each older "to go back, restore" pointer also names the way that keeps the runs.
    for (const page of [PAGE, GUIDE, 'CHANGELOG.md']) {
      claim(
        page,
        'A file that is already migrated can instead be stepped back without losing a run: `realm db migrate --to 1` (see [Going back without losing runs](',
      );
    }
    claim(
      'docs/reference/environment-and-files.md',
      'a step back (`--to`) has `from_format` above `to_format`.',
    );
  });
});
