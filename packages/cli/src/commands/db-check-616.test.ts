// db-check-616.test.ts — issue #616 PR-2c, unit c8a2: `realm db check [--json]` as a user runs it. The
// cells run the BUILT `realm` (tests run after the build) with PATH, HOME and REALM_NO_NUDGE only, in a
// scratch working folder. HOME is a scratch folder whose `.realm` the store package's own open makes.
// The real cases: an operator reading a store with nothing wrong, and a script reading the same report;
// a store with damage, whose report must say how much it found and what it could not check; a read-only
// copy; a home with no store to check. Each state is seeded on a real file: by writes to the closed
// file's header, or by a plain SQLite connection on the closed file. The store's own cells
// (`packages/store-sqlite/src/maintenance-check-616.test.ts`) pin what each finding says and stops; these
// pin what the command prints from them, its exit code, and the page.
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails. Each
// describe whose cells start the built CLI carries its own budget (spawn-budget-guard.test.ts).
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CHECK_FINDING_CODES,
  openRealmHome,
  openRealmHomeForMaintenance,
  type CheckReport,
} from '@sensigo/realm-store-sqlite';
import { openForeignConnection } from '@sensigo/realm-store-sqlite/test-support';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST_CLI = join(HERE, '..', '..', 'dist', 'index.js');
const ROOT = join(HERE, '..', '..', '..', '..');
const PAGE = 'docs/reference/cli/realm-db.md';
const AS_ROOT = process.getuid?.() === 0;

/** The store's page size, as the file's header holds it. */
const PAGE_SIZE = 16384;

const NOT_CHECKED = [
  "Other Realm processes' connection settings cannot be read from here.",
  "A purged run's phase cannot be verified: its record is gone.",
  "A purged run's key hash cannot be recomputed: no key is kept.",
  'A run deleted while a finalizer was still owed cannot be detected: the purge record keeps no finalizer field.',
];
const NOT_CHECKED_LINES = NOT_CHECKED.map((why) => `Not checked in this version: ${why}`);
const RULE =
  'Never delete, move or replace realm.db or its side files while a Realm process is running.';

let root = '';
let base = '';
let home = '';
let file = '';
const locked: string[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'realm-616-c8a2-home-'));
  base = mkdtempSync(join(tmpdir(), 'realm-616-c8a2-cwd-'));
  home = join(root, '.realm');
  file = join(home, 'realm.db');
});
afterEach(() => {
  for (const path of locked.splice(0)) chmodSync(path, 0o644);
  rmSync(root, { recursive: true, force: true });
  rmSync(base, { recursive: true, force: true });
});

interface Run {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs the built `realm` with HOME set to the scratch root; a run that hangs is killed (a red). */
function realm(args: string[], env: Record<string, string> = {}): Run {
  const r = spawnSync(process.execPath, [DIST_CLI, ...args], {
    cwd: base,
    env: { PATH: process.env['PATH'] ?? '', HOME: root, REALM_NO_NUDGE: '1', ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
    killSignal: 'SIGKILL',
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** A path as the CLI prints it when its output is piped: the scratch HOME's own path is masked. */
const shown = (path: string): string => path.replace(root, '[REDACTED]');
const linesOf = (text: string): string[] => text.split('\n').slice(0, -1);

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

/** The store's own report of the home, for the cells that compare what the command prints with it. */
async function storeReport(): Promise<CheckReport> {
  const h = await openRealmHomeForMaintenance({ home, verb: 'check' });
  try {
    return await h.check();
  } finally {
    h.close();
  }
}

/** Runs `run` on a foreign connection to the closed store file. */
async function onFile(
  run: (db: Awaited<ReturnType<typeof openForeignConnection>>) => void,
): Promise<void> {
  const db = await openForeignConnection(home);
  try {
    run(db);
  } finally {
    db.close();
  }
}

/** Appends `pages` zero pages and raises the header's page count (offset 28), as a torn extend would. */
function appendZeroPages(pages: number): void {
  const fd = openSync(file, 'r+');
  try {
    const header = Buffer.alloc(4);
    readSync(fd, header, 0, 4, 28);
    const count = header.readUInt32BE(0);
    const zeros = Buffer.alloc(pages * PAGE_SIZE);
    writeSync(fd, zeros, 0, zeros.length, count * PAGE_SIZE);
    header.writeUInt32BE(count + pages, 0);
    writeSync(fd, header, 0, 4, 28);
  } finally {
    closeSync(fd);
  }
}

/** Raises the header's `user_version` (offset 60), as a newer Realm's migration leaves it. */
function setSchemaVersion(version: number): void {
  const fd = openSync(file, 'r+');
  try {
    const header = Buffer.alloc(4);
    header.writeUInt32BE(version, 0);
    writeSync(fd, header, 0, 4, 60);
  } finally {
    closeSync(fd);
  }
}

/** `failed_attempts` rows for runs that do not exist: each pair is a run id and its row count. */
async function orphanRows(pairs: ReadonlyArray<readonly [string, number]>): Promise<void> {
  await onFile((db) => {
    db.exec('BEGIN');
    const row = db.prepare('INSERT INTO failed_attempts (run_id, seq, line) VALUES (?, ?, ?)');
    for (const [run, rows] of pairs) {
      for (let seq = 0; seq < rows; seq++) row.run(run, seq, 'x');
    }
    db.exec('COMMIT');
  });
}

describe('#616 c8a2 — check 1: a home with nothing wrong', { timeout: 120_000 }, () => {
  it('the text, whole, and exit 0', async () => {
    await makeStore();
    const { facts: f, reads_up_to: m, schema_version: n } = await storeReport();
    const type = f.filesystem !== undefined && !f.filesystem.escaped ? f.filesystem.type : '';
    // (1) red when the summary claims health ("OK", "healthy"), a line moves, or exit is not 0;
    //     (2) prints the run.
    expect(realm(['db', 'check'])).toEqual({
      code: 0,
      stdout:
        [
          `Checked ${shown(file)} (schema version ${n}; this version of Realm reads up to ${m}).`,
          'No problems found by the checks that ran.',
          ...NOT_CHECKED_LINES,
          `SQLite ${f.sqlite_version} on Node ${f.node_version}; filesystem: ${type}.`,
          `File: ${f.file_bytes} bytes, ${f.page_count} pages of ${f.page_size} bytes, ${f.freelist_count} free.`,
          'WAL: 0 bytes, 0 frames, 0 of them already copied into the database.',
          'Purged runs: 0.',
          `Every run purged after ${f.tombstones_since} keeps its tombstone (compacted through seq 0).`,
          RULE,
        ].join('\n') + '\n',
      stderr: '',
    });
  });

  it("--json is the store's report with its path masked, exit 0; the JSON's path is the text's", async () => {
    await makeStore();
    const report = await storeReport();
    const json = realm(['db', 'check', '--json']);
    const text = realm(['db', 'check']);
    // (1) red when `path` is classed `fact` (the unmasked path), a key is dropped, or anything else is
    //     printed on stdout; (2) prints the code, what was parsed, stderr and the text's first line.
    expect({
      code: json.code,
      report: JSON.parse(json.stdout) as unknown,
      stderr: json.stderr,
      inText: text.stdout.startsWith(`Checked ${(JSON.parse(json.stdout) as CheckReport).path} (`),
    }).toEqual({
      code: 0,
      report: JSON.parse(JSON.stringify({ ...report, path: shown(file) })) as unknown,
      stderr: '',
      inText: true,
    });
  });

  it('with the escape: the filesystem is not judged', async () => {
    await makeStore();
    const run = realm(['db', 'check'], { REALM_STORE_FS: 'local' });
    const line = linesOf(run.stdout).find((l) => l.startsWith('SQLite '));
    // (1) red when the escape's branch prints a type, or the line is lost; (2) prints the code and it.
    expect({ code: run.code, line: line?.replace(/^.*; /, '') }).toEqual({
      code: 0,
      line: 'filesystem: not judged (REALM_STORE_FS=local).',
    });
  });

  it('runs at another phase stamp are a fact, not a finding', async () => {
    await makeStore();
    await onFile((db) => db.exec("UPDATE runs SET phase_version = 'an-earlier-derivation'"));
    const run = realm(['db', 'check']);
    // (1) red when the stamp's line is left out or worded otherwise, or exit is 1; (2) prints the code
    //     and the line.
    expect({
      code: run.code,
      line: linesOf(run.stdout).find((l) => l.startsWith('Runs stamped')),
    }).toEqual({
      code: 0,
      line: 'Runs stamped by another phase derivation: 1 (realm db migrate re-stamps them).',
    });
  });
});

describe('#616 c8a2 — check 2: a home with findings', { timeout: 120_000 }, () => {
  it('a finding whose count is a lower bound: 10 examples, "at least", and one finding counted', async () => {
    await makeStore();
    // 100 zero pages give 100 "never used" lines (AUD-C8A2-16): the integrity check stops there.
    appendZeroPages(100);
    const run = realm(['db', 'check']);
    const lines = linesOf(run.stdout);
    const start = lines.findIndex((l) => l.startsWith('✗ '));
    // (1) red when the tail drops "at least", the summary counts the problems, an example is not
    //     indented, or exit is 0; (2) prints the code and the lines around the finding.
    expect({
      code: run.code,
      finding: lines[start],
      examples: lines
        .slice(start + 1, start + 11)
        .filter((l) => /^ {4}Page \d+: never used$/.test(l)).length,
      after: lines.slice(start + 11, start + 13),
    }).toEqual({
      code: 1,
      finding: "✗ SQLite's integrity check reported at least 100 problems.",
      examples: 10,
      after: ['    … and at least 90 more.', '1 finding.'],
    });
  });

  it('examples_of: 100 rows in 3 pairs show their 3 examples and no "more" line', async () => {
    await makeStore();
    await orphanRows([
      ['gone-a', 40],
      ['gone-b', 40],
      ['gone-c', 20],
    ]);
    const run = realm(['db', 'check']);
    const json = JSON.parse(realm(['db', 'check', '--json']).stdout) as CheckReport;
    const lines = linesOf(run.stdout);
    const start = lines.findIndex((l) => l.startsWith('✗ '));
    // (1) red when the tail is computed from `count` alone (it would say 97 more), or `--json` loses
    //     the field; (2) prints the code, the lines from the finding on, and the field.
    expect({
      code: run.code,
      lines: lines.slice(start, start + 5),
      examplesOf: json.findings[0]?.examples_of,
    }).toEqual({
      code: 1,
      lines: [
        '✗ 100 rows belong to runs that are gone: failed_attempts 100.',
        '    failed_attempts, run gone-a: 40 rows',
        '    failed_attempts, run gone-b: 40 rows',
        '    failed_attempts, run gone-c: 20 rows',
        '1 finding.',
      ],
      examplesOf: 3,
    });
  });

  it('examples_of: more than 10 pairs say how many pairs are left', async () => {
    await makeStore();
    await orphanRows(Array.from({ length: 12 }, (_, i) => [`gone-${String(i + 10)}`, 2] as const));
    const run = realm(['db', 'check']);
    const lines = linesOf(run.stdout);
    const start = lines.findIndex((l) => l.startsWith('✗ '));
    // (1) red when the tail counts rows (14 more) rather than pairs; (2) prints the code and the lines.
    expect({ code: run.code, tail: lines[start + 11], summary: lines[start + 12] }).toEqual({
      code: 1,
      tail: '    … and 2 more.',
      summary: '1 finding.',
    });
  });

  it('a newer file: the checks it stops, one of them in part, each named and counted apart', async () => {
    await makeStore();
    setSchemaVersion(99);
    const run = realm(['db', 'check']);
    const lines = linesOf(run.stdout);
    const notRun = lines.filter((l) => l.startsWith('Not run: '));
    // (1) red when a `part` entry is counted as not run (13 and no "ran in part"), the part is not
    //     named, or exit is 0; (2) prints the code, the first line, the finding, the part's line, the
    //     number of Not-run lines and the summary.
    expect({
      code: run.code,
      first: lines[0],
      finding: lines[1],
      part: notRun.filter((l) => l.includes(', its ')),
      notRun: notRun.length,
      summary: lines[1 + notRun.length + 1],
    }).toEqual({
      code: 1,
      first: `Checked ${shown(file)} (schema version 99; this version of Realm reads up to 1).`,
      finding:
        '✗ Written by a later version of Realm (schema version 99; this version reads up to 1).',
      part: ['Not run: settings, its meta row part (because of newer_version).'],
      notRun: 13,
      summary: '1 finding. 12 check(s) did not run. 1 ran in part.',
    });
  });

  it('a file that is not a database: no version line, and only the facts it could measure', async () => {
    await makeStore();
    writeFileSync(file, Buffer.alloc(2 * PAGE_SIZE, 0x5a));
    const run = realm(['db', 'check']);
    const lines = linesOf(run.stdout);
    // (1) red when a schema version is claimed, a fact not measured is printed, or the WAL's line is
    //     lost; (2) prints the code, the lines that start with the three prefixes, and the rule's place.
    expect({
      code: run.code,
      first: lines[0],
      finding: lines[1],
      file: lines.find((l) => l.startsWith('File: ')),
      wal: lines.find((l) => l.startsWith('WAL: ')),
      purged: lines.filter((l) => l.startsWith('Purged') || l.startsWith('Every run')),
      last: lines.at(-1),
    }).toEqual({
      code: 1,
      first: `Checked ${shown(file)} (its schema version could not be read; this version of Realm reads up to 1).`,
      finding: '✗ The file is not a readable SQLite database: its header or schema cannot be read.',
      file: `File: ${2 * PAGE_SIZE} bytes.`,
      wal: 'WAL: 0 bytes; its frame counts could not be read.',
      purged: [],
      last: RULE,
    });
  });

  it.skipIf(AS_ROOT)('not_writable alone (a read-only copy) exits 1', async () => {
    await makeStore();
    chmodSync(file, 0o444);
    locked.push(file);
    const run = realm(['db', 'check']);
    const lines = linesOf(run.stdout);
    // (1) red when the command exits 0 with a finding; (2) prints the code, the finding and the summary.
    expect({ code: run.code, finding: lines[1], summary: lines[2] }).toEqual({
      code: 1,
      finding:
        '✗ Realm cannot write to this file or its folder: every other command that opens this store, reads included, is refused until it can, except the checks that only look at it.',
      summary: '1 finding.',
    });
  });
});

describe('#616 c8a2 — check 3: a refusal is one Error line', { timeout: 120_000 }, () => {
  const seeds = {
    'no store file': () => undefined,
    'an empty store file': () => {
      mkdirSync(home);
      writeFileSync(file, '');
    },
  } as const;
  const words = {
    'no store file': () => `There is no store file at ${shown(file)} to check.`,
    'an empty store file': () => `${shown(file)} holds no store yet: there is nothing to check.`,
  } as const;

  it.each(
    (['no store file', 'an empty store file'] as const).flatMap((state) => [
      [state, 'text', []] as const,
      [state, '--json', ['--json']] as const,
    ]),
  )('%s, as %s', (state, _form, flags) => {
    seeds[state]();
    // (1) red when STATE_STORE_CHECK_REFUSED is not in the expected set (a stack follows); (2) prints
    //     the run.
    expect(realm(['db', 'check', ...flags])).toEqual({
      code: 1,
      stdout: '',
      stderr: `Error: ${words[state]()}\n`,
    });
  });

  it.each([
    [
      'a store file that is a folder',
      () => mkdirSync(file, { recursive: true }),
      /^Error: .*realm\.db.*\n$/,
    ],
    [
      'a store file that is a symbolic link',
      () => {
        mkdirSync(home);
        writeFileSync(join(root, 'elsewhere.db'), 'x');
        symlinkSync(join(root, 'elsewhere.db'), file);
      },
      /^Error: .*it is a symbolic link; link the home folder instead, never the store file.*\n$/,
    ],
    [
      'a home holding the old JSON store',
      // The store's pre-check comes first, so the file must be there; the old store's `runs` folder
      // sits where the open keeps its fence file.
      async () => {
        await makeStore();
        rmSync(join(home, 'runs'), { force: true });
        mkdirSync(join(home, 'runs', 'some-workflow'), { recursive: true });
      },
      /^Error: .*realm run import.*\n$/,
    ],
  ] as const)('%s', async (_state, seed, line) => {
    await seed();
    const run = realm(['db', 'check']);
    // (1) red when the open's refusal is not in the expected set (a stack, more than one line); (2)
    //     prints the code, stdout, and stderr.
    expect(run.code, run.stderr).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toMatch(line);
    expect(linesOf(run.stderr)).toHaveLength(1);
  });
});

describe('#616 c8a2 — check 5: the help', { timeout: 120_000 }, () => {
  it("realm db check --help gives the command's description and its option's words", () => {
    const flat = realm(['db', 'check', '--help']).stdout.replace(/\s+/g, ' ');
    const has = (words: string): boolean => flat.includes(words);
    // (1) red when either text changes; (2) prints which is there.
    expect({
      description: has(
        "Report on the store file without writing it: SQLite's integrity check, the file's settings, version and schema, every run's stored record, the tables against each other, and what this version does not check",
      ),
      option: has('--json Print the report as JSON on stdout, and nothing else'),
    }).toEqual({ description: true, option: true });
  });
});

const flat = (t: string): string => t.replace(/\s+/g, ' ');

/** (1) red when the page no longer holds the sentence word for word; (2) prints it and its proof. */
function claim(sentence: string, provedBy: string): void {
  expect(
    flat(readFileSync(join(ROOT, PAGE), 'utf8')),
    `${PAGE} no longer says: ${sentence} (proved by: ${provedBy})`,
  ).toContain(flat(sentence));
}

const STORE = 'packages/store-sqlite/src/maintenance-check-616.test.ts';
const THIS = 'this file';

describe('#616 c8a2 — check 6: the page says what the command does', { timeout: 120_000 }, () => {
  it.each([
    ['the usage', '`realm db check [--json]`', `${THIS}, check 1`],
    [
      'it writes nothing',
      'Reports on the store file without changing it: it opens the file read-only. `db check` writes nothing to the store file; SQLite may create or update its two side files beside it (`realm.db-wal`, `realm.db-shm`), as any open of the store does.',
      `${STORE}, c8a1 check 3`,
    ],
    [
      'what it checks',
      "It runs SQLite's integrity check and reads the file's settings, schema version and schema, and whether Realm can write to it. It reads every run's stored record once, checking its evidence hashes, its phase stamp, its key hash, its filter columns and its stored placeholders, and it compares the tables with each other: the purge counter, rows whose run is gone, each workflow's pointer, and each stored workflow version's hash. A problem is reported with its reason, and every check it stops is listed as not run, or as run in part. When a read meets a damaged page, or a run whose record cannot be read, that is reported and the rest of the report is kept.",
      `${STORE}, the c8a1, c8a3, c8b1 and c8b2 cells for each check; c8b1 check 3`,
    ],
    [
      'what it refuses',
      "It refuses, with one `Error:` line, a home with no store file or an empty one, a Node.js whose built-in SQLite is below the floor, a home on a network or unrecognised filesystem or on a system other than Linux or macOS, a store file that is a folder, or a symbolic link (link the home folder instead, never the store file), and a home that still holds the old JSON store's folders (move them out of the home, then import what you want to keep with `realm run import`).",
      `${THIS}, check 3; ${STORE}, c8a1 check 2 (floor, network), c8a3 check 4 (folder, old store)`,
    ],
    [
      'the WAL counts',
      'The WAL counts are exact when read; other Realm processes move them.',
      `${STORE}, c8a1 check 7`,
    ],
    [
      'the exit code',
      '**Exit code:** 0 when every check ran and found nothing. 1 when a problem is found or a check could not run, and 1 when the command refuses, with one `Error:` line on standard error and nothing on standard output. A file Realm cannot write to exits 1, a read-only copy included (`findings[].code` is `not_writable`).',
      `${THIS}, checks 1, 2 and 3`,
    ],
    [
      '--json',
      "`--json` prints the report: `status` (`ok` or `findings`), `path`, `schema_version`, `reads_up_to`, `facts`, `findings`, `not_run` and `not_checked`. A finding's `examples_of`, present only when it differs from `count`, says how many examples exist: `orphaned_rows` counts rows, and its examples are one per table and run.",
      `${THIS}, checks 1 and 2 (examples_of)`,
    ],
    [
      'the operator rule',
      'Never delete, move or replace `realm.db` or its side files while a Realm process is running.',
      `${THIS}, check 1 (the line the command prints)`,
    ],
    ['the opening', 'It has three subcommands.', 'commands-registry.ts: dbCommands'],
    [
      'the table row',
      '| [`check`](#check) | Reports on the store file without writing it. |',
      `${THIS}, check 1`,
    ],
  ])('%s', (_name, sentence, provedBy) => {
    claim(sentence, provedBy);
  });

  it("the page's description names the command", () => {
    claim(
      'and realm db check, which reports on the store file without writing it',
      `${THIS}, check 1`,
    );
  });

  it("the page's code table holds the store's code list, and nothing else", () => {
    const page = readFileSync(join(ROOT, PAGE), 'utf8');
    const codes = [...page.matchAll(/^\| `([a-z_]+)` +\|/gm)].map((m) => m[1]);
    // (1) red when the store gains or loses a code and the page does not follow, or a row is repeated;
    //     (2) prints the codes the two differ by, and the row count.
    expect({
      onlyOnPage: codes.filter(
        (c) => !(CHECK_FINDING_CODES as readonly string[]).includes(c ?? ''),
      ),
      notOnPage: CHECK_FINDING_CODES.filter((c) => !codes.includes(c)),
      rows: codes.length,
    }).toEqual({ onlyOnPage: [], notOnPage: [], rows: CHECK_FINDING_CODES.length });
  });

  // Proved by the store's cell for each code, in packages/store-sqlite/src/maintenance-check-616.test.ts.
  it("the table's rows, word for word: each code, its check, its message, and what it stops", () => {
    const rows = [
      "| `integrity_failed` | integrity | `SQLite's integrity check reported 1 problem.` / `SQLite's integrity check reported <n> problems.` / `SQLite's integrity check reported at least <n> problems.` | nothing |",
      '| `integrity_unreadable` | integrity | `SQLite could not finish its integrity check: SQLite error <code>, the file is damaged.` | nothing |',
      "| `open_failed` | open | `SQLite could not open the file: <SQLite's message> (SQLite error <n>).` | every other check but writable |",
      '| `header_damaged` | header | `The file is not a readable SQLite database: its header or schema cannot be read.` | version, schema, settings, integrity, the data checks |',
      "| `newer_version` | version | `Written by a later version of Realm (schema version <n>; this version reads up to <m>).` | schema, the data checks; the settings' meta row |",
      '| `older_version` | version | ``Written by an earlier version: schema version <n>; this version needs <m>; run `realm db migrate`.`` | the data checks |',
      "| `version_unknown` | version | `The file's schema version is 0: it was never set up (a first open was interrupted) or it is not a Realm store.` / `The file's schema version is <n>, which no version of Realm writes.` | schema, the data checks; the settings' meta row |",
      "| `schema_differs` | schema | `The schema differs from schema version <n>'s: missing <names>; extra <names>; changed <names>.` | the data checks; the settings' meta row, when it is the meta table |",
      "| `settings_differ` | settings | `A store setting differs: <setting> is <found>, expected <expected>.` | nothing; the settings' meta row and `tombstones`, when the meta row is missing |",
      '| `not_writable` | writable | `Realm cannot write to this file or its folder: every other command that opens this store, reads included, is refused until it can, except the checks that only look at it.` | nothing |',
      "| `data_unreadable` | data_read | `SQLite could not read the store's data: SQLite error <code>, the file is damaged.` / `Realm could not read the store's data: a stored integer is too large for Realm to read.` | the data checks whose read failed |",
      '| `record_unreadable` | records | `1 run holds a stored record that is not JSON; the checks that read a record skipped it.` / `<n> runs hold a stored record that is not JSON; the checks that read a record skipped them.` | the other record checks, for those runs |',
      '| `evidence_hash_mismatch` | evidence_hashes | `1 evidence entry does not match its stored hash.` / `<n> evidence entries do not match their stored hash.` | nothing |',
      "| `phase_index_wrong` | phase_index | `1 run carries a phase that differs from its record's.` / `<n> runs carry a phase that differs from their record's.` | nothing |",
      '| `key_hash_mismatch` | key_hashes | `1 run carries a key hash that does not match its key.` / `<n> runs carry a key hash that does not match their key.` | nothing |',
      '| `filter_column_differs` | filter_columns | `1 run holds a filter column that differs from its record.` / `<n> runs hold a filter column that differs from their record.` | nothing |',
      '| `placeholder_mismatch` | placeholders | `1 run holds stored placeholders that do not match their rows.` / `<n> runs hold stored placeholders that do not match their rows.` | nothing |',
      '| `purged_count_mismatch` | tombstones | `The purged-run count (<a>) differs from the purge counter (<b>).` | nothing |',
      '| `orphaned_rows` | orphans | `1 row belongs to a run that is gone: <table> 1.` / `<n> rows belong to runs that are gone: <table> <k>, ….` | nothing |',
      "| `workflow_pointer_mismatch` | workflow_pointers | `1 workflow's pointer does not match its newest registration.` / `<n> workflows' pointers do not match their newest registration.` | nothing |",
      '| `workflow_version_hash_mismatch` | workflow_version_hashes | `1 stored workflow version does not match its hash.` / `<n> stored workflow versions do not match their hash.` | nothing |',
    ];
    const page = flat(readFileSync(join(ROOT, PAGE), 'utf8'));
    // (1) red when a message or what it stops differs on the page; (2) prints every row it no longer holds.
    expect(rows.filter((row) => !page.includes(row))).toEqual([]);
  });

  it('the CHANGELOG says what shipped', () => {
    const log = flat(readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8'));
    const lines = [
      // Proved by this file's checks 1 and 2, and the store's cell for each check.
      "- **`realm db check [--json]` reports on the store file without writing it**: SQLite's integrity check; the file's settings, version and schema, and whether Realm can write to it; every run's stored record (evidence hashes, phase stamp, key hash, filter columns, placeholders); and the tables against each other (the purge counter, rows whose run is gone, workflow pointers, workflow version hashes). Each problem comes with its reason, along with each check it stopped and what this version does not check; exit 0 only when every check ran and found nothing (#616).",
      // Proved by this file's check 3.
      '- **One error code for it: `STATE_STORE_CHECK_REFUSED`** (a home with no store file, or an empty one; nothing is created) (#616).',
    ];
    // (1) red when either bullet changes or is gone; (2) prints the bullets it no longer holds.
    expect(lines.filter((line) => !log.includes(line))).toEqual([]);
  });

  it("the built CLI's not-checked lines are the page's four sentences", async () => {
    await makeStore();
    const printed = linesOf(realm(['db', 'check']).stdout)
      .filter((l) => l.startsWith('Not checked in this version: '))
      .map((l) => l.replace('Not checked in this version: ', ''));
    const page = readFileSync(join(ROOT, PAGE), 'utf8');
    const start = page.indexOf('Each report lists what this version cannot check:');
    const listed = page
      .slice(start)
      .split('\n')
      .slice(2, 6)
      .map((l) => l.replace(/^- /, ''));
    // (1) red when the store's sentences change and the page does not follow; (2) prints both lists.
    expect({ printed, listed }).toEqual({ printed: NOT_CHECKED, listed: NOT_CHECKED });
  });
});
