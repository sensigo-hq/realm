// home.test.ts — issue #616 PR-1a unit 7a: preparing a Realm home before its database is opened
// (the folder, the old-store guard, the fences, the owner-only file) and the read-only refusal, on
// real folders in a temp directory. The write path's read-only rows run through `RealmDb` over a
// real connection made here through the one loader: the open (unit 7b) does not exist yet.
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WorkflowError } from '@sensigo/realm';
import type { Clock } from '@sensigo/realm';
import { afterEach, describe, expect, it } from 'vitest';
import { mapSqliteError, RealmDb } from './connection.js';
import { openDatabase } from './driver.js';
import type { DatabaseLike } from './driver.js';
import { prepareHome } from './home.js';
import { VERSION } from './version.js';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const AS_ROOT = process.getuid?.() === 0;
if (AS_ROOT) {
  console.warn(
    '#616 unit 7a: the cells of folders Realm cannot write are skipped: root can write to any folder.',
  );
}

const dirs: string[] = [];
const locked: string[] = [];
const connections: DatabaseLike[] = [];

afterEach(() => {
  for (const c of connections.splice(0)) {
    try {
      c.close();
    } catch {
      // already closed by the test
    }
  }
  for (const p of locked.splice(0)) chmodSync(p, 0o755);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A fresh temp folder, removed after the test. */
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'realm-616-u07a-'));
  dirs.push(dir);
  return dir;
}

/** Sets a folder's or a file's mode; the folder (or file) is made writable again after the test. */
function lock(path: string, mode: number): void {
  chmodSync(path, mode);
  locked.push(path);
}

/** A connection to `file` through the one loader. */
function connect(file: string): DatabaseLike {
  const c = openDatabase(file);
  connections.push(c);
  return c;
}

/** A store at `home` as a first open leaves it, with one row written: WAL, table `t`. */
function storeWithData(home: string): string {
  const file = prepareHome(home);
  const c = openDatabase(file);
  c.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (x); INSERT INTO t VALUES ('kept')");
  c.close();
  return file;
}

/** Each entry of a folder: what it is and its permission bits (`file 444`, `dir 755`, `link`). */
function contents(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir).sort()) {
    const s = lstatSync(join(dir, name));
    const kind = s.isSymbolicLink()
      ? 'link'
      : s.isDirectory()
        ? 'dir'
        : s.isFile()
          ? 'file'
          : s.isFIFO()
            ? 'pipe'
            : 'other';
    out[name] = kind === 'link' ? kind : `${kind} ${(s.mode & 0o777).toString(8)}`;
  }
  return out;
}

/** A file's bytes (as base64) and its inode: what "replaced" would change. */
function identity(file: string): { bytes: string; inode: number } {
  return { bytes: readFileSync(file).toString('base64'), inode: statSync(file).ino };
}

/** The parts of an error a test compares (store errors: never a credential). */
function summary(err: unknown): Record<string, unknown> {
  const e = err as { code?: unknown; errcode?: unknown; message?: unknown };
  return {
    workflowError: err instanceof WorkflowError,
    code: e?.code,
    message: e?.message,
    ...(err instanceof WorkflowError ? { details: err.details } : { errcode: e?.errcode }),
  };
}

/** What `prepareHome` returned or threw. */
function prepared(home: string): { returned?: string; error?: Record<string, unknown> } {
  try {
    return { returned: prepareHome(home) };
  } catch (err) {
    return { error: summary(err) };
  }
}

/** The fence text this Realm writes at `name` (MA 3's words, the version substituted). */
function fence(name: string): string {
  return (
    'realm store fence 1\n' +
    `Realm ${VERSION} placed this file. Realm keeps its store in realm.db in this folder. ` +
    `Versions before the SQLite store kept a folder named ${name} here; this file stops them from ` +
    'writing here, so they fail at once instead of starting a second store. Do not delete it ' +
    'while Realm uses this folder.\n'
  );
}

const NAMES = ['runs', 'workflows', 'replays', 'dedup'];

/** The prepared state of a fresh home: four fences and an empty owner-only database file. */
const PREPARED = {
  dedup: 'file 444',
  'realm.db': 'file 600',
  replays: 'file 444',
  runs: 'file 444',
  workflows: 'file 444',
};

function readOnlyRefusal(path: string, reason: string): Record<string, unknown> {
  return {
    workflowError: true,
    code: 'STATE_STORE_READONLY',
    message: `Realm cannot write to ${path}: ${reason}. The store needs a home that Realm can write to.`,
    details: { path, reason },
  };
}

function legacySentence(home: string, names: string[]): string {
  return (
    `This Realm keeps its store in realm.db and does not read the old JSON directories ` +
    `(${names.join(', ')}) in ${home}. Move them out of the home, then import what you want to keep ` +
    'with `save()` or `realm run import`.'
  );
}

function otherSentence(home: string, name: string): string {
  return (
    `${home}/${name} exists and is neither a Realm fence file nor an old store directory. Realm ` +
    'will not touch it. Move or remove it, then open the store again.'
  );
}

function guardRefusal(home: string, legacy: string[], other: string[]): Record<string, unknown> {
  return {
    workflowError: true,
    code: 'STATE_HOME_HOLDS_LEGACY_STORE',
    message: [
      ...(legacy.length > 0 ? [legacySentence(home, legacy)] : []),
      ...other.map((n) => otherSentence(home, n)),
    ].join(' '),
    details: { home, legacy, other },
  };
}

const T0 = Date.parse('2026-11-06T12:00:00.000Z');
const fixedClock: Clock = { now: () => new Date(T0), at: () => () => undefined };

/** A write through the write path on `connection`: what it threw. */
async function writeThrough(file: string, connection: DatabaseLike): Promise<unknown> {
  const db = new RealmDb(connection, {
    path: file,
    clock: fixedClock,
    reopen: () => connect(file),
  });
  try {
    await db.immediate(
      (d) => {
        d.prepare("INSERT INTO t VALUES ('new')").run();
      },
      () => true,
    );
    return undefined;
  } catch (err) {
    return err;
  }
}

describe('#616 unit 7a — a home that does not exist', () => {
  it('a missing home, with missing folders above it, is made and prepared: four fences and an empty owner-only realm.db', () => {
    const home = join(tmp(), 'new', '.realm');
    const result = prepared(home);
    const file = join(home, 'realm.db');
    // (1) red when the folder is not made (its writability check then fails ENOENT, so the open is
    //     refused as not writable), or a fence or the database file is not placed; (2) prints what
    //     was returned or thrown, the home's entries and the database file's size.
    expect({
      result,
      contents: existsSync(home) ? contents(home) : 'no such folder',
      databaseBytes: existsSync(file) ? statSync(file).size : 'no such file',
    }).toEqual({
      result: { returned: join(home, 'realm.db') },
      contents: PREPARED,
      databaseBytes: 0,
    });
  });

  it.skipIf(AS_ROOT)(
    'a home under a folder Realm cannot write to is refused with STATE_STORE_READONLY, naming the home and the reason',
    () => {
      const parent = join(tmp(), 'locked');
      mkdirSync(parent);
      lock(parent, 0o555);
      const home = join(parent, 'new', '.realm');
      const result = prepared(home);
      // (1) red when the folder step's error leaves raw (an EACCES with no code of Realm's) or is
      //     mapped to another code or sentence; (2) prints the error and what the parent holds.
      expect({ result, parent: contents(parent) }).toEqual({
        result: { error: readOnlyRefusal(home, 'permission denied') },
        parent: {},
      });
    },
  );
});

describe('#616 unit 7a — the old-store guard', () => {
  it('an old store directory, or a link to one, is refused naming each, and nothing is written', () => {
    // A user's old JSON store: a runs folder holding a run file.
    const dirAtRuns = join(tmp(), '.realm');
    mkdirSync(join(dirAtRuns, 'runs'), { recursive: true });
    writeFileSync(join(dirAtRuns, 'runs', 'run-1.json'), '{}');
    // A home whose old workflows folder was moved elsewhere and linked back.
    const linkAtWorkflows = join(tmp(), '.realm');
    const moved = join(tmp(), 'workflows-moved');
    mkdirSync(linkAtWorkflows);
    mkdirSync(moved);
    symlinkSync(moved, join(linkAtWorkflows, 'workflows'));
    // Two old folders at once: both are named.
    const two = join(tmp(), '.realm');
    mkdirSync(join(two, 'runs'), { recursive: true });
    mkdirSync(join(two, 'dedup'));

    const rows = [dirAtRuns, linkAtWorkflows, two].map((home) => {
      const before = contents(home);
      const result = prepared(home);
      return { result, unchanged: JSON.stringify(contents(home)) === JSON.stringify(before) };
    });
    // (1) red when the guard's `lstat` of the four names is skipped: the fences are then placed in
    //     name order and a later name is met by its `link` (a fence placed at runs before the link at
    //     workflows refuses, so something was written; two old folders are named only one at a
    //     time), or when a refusal names the wrong entries or writes a fence or the database file;
    //     (2) prints each row's refusal and whether the home's entries stayed as they were.
    expect(rows).toEqual([
      { result: { error: guardRefusal(dirAtRuns, ['runs'], []) }, unchanged: true },
      { result: { error: guardRefusal(linkAtWorkflows, ['workflows'], []) }, unchanged: true },
      { result: { error: guardRefusal(two, ['runs', 'dedup'], []) }, unchanged: true },
    ]);
  });

  it("a fence file at an old name is fine; anything else there is refused as 'something else', together with any old folder, and nothing is written", () => {
    // A fence another Realm version placed: the marker line, other words after it.
    const otherVersionFence = join(tmp(), '.realm');
    mkdirSync(otherVersionFence);
    writeFileSync(join(otherVersionFence, 'runs'), 'realm store fence 1\nPlaced by Realm 9.9.9.\n');
    // A regular file with other content; a link to a file; a link to nothing; a named pipe.
    const homes: Record<string, string> = {};
    const other = (label: string, name: string, make: (path: string) => void): void => {
      const home = join(tmp(), '.realm');
      mkdirSync(home);
      make(join(home, name));
      homes[label] = home;
    };
    other('json file', 'runs', (p) => writeFileSync(p, '{}'));
    other('link to a file', 'workflows', (p) => {
      const target = join(dirname(dirname(p)), 'a-file');
      writeFileSync(target, 'realm store fence 1\n');
      symlinkSync(target, p);
    });
    other('dangling link', 'replays', (p) => symlinkSync(join(dirname(dirname(p)), 'gone'), p));
    other('pipe', 'dedup', (p) => execFileSync('mkfifo', [p]));
    // An old folder and two other entries in one home: one refusal names all three.
    const mixed = join(tmp(), '.realm');
    mkdirSync(join(mixed, 'runs'), { recursive: true });
    symlinkSync(join(mixed, 'nowhere'), join(mixed, 'replays'));
    writeFileSync(join(mixed, 'dedup'), '');

    const fine = prepared(otherVersionFence);
    const fineRunsKept = readFileSync(join(otherVersionFence, 'runs'), 'utf8');
    const refused = Object.fromEntries(
      [...Object.entries(homes), ['mixed', mixed] as const].map(([label, home]) => {
        const before = contents(home);
        const result = prepared(home);
        return [
          label,
          { result, unchanged: JSON.stringify(contents(home)) === JSON.stringify(before) },
        ];
      }),
    );
    // (1) red when any regular file counts as a fence (the json file row is then prepared), when a
    //     fence of another version is refused (the check reads past the marker line), when a link or
    //     a pipe is opened or followed into a verdict other than "something else" (a pipe opened
    //     without non-blocking hangs the cell), when one refusal does not name every entry in the
    //     order runs, workflows, replays, dedup, or when a refusal writes anything; (2) prints each
    //     row's result and whether its home stayed as it was.
    expect({ fine, fineRunsKept, refused }).toEqual({
      fine: { returned: join(otherVersionFence, 'realm.db') },
      fineRunsKept: 'realm store fence 1\nPlaced by Realm 9.9.9.\n',
      refused: {
        'json file': {
          result: { error: guardRefusal(homes['json file']!, [], ['runs']) },
          unchanged: true,
        },
        'link to a file': {
          result: { error: guardRefusal(homes['link to a file']!, [], ['workflows']) },
          unchanged: true,
        },
        'dangling link': {
          result: { error: guardRefusal(homes['dangling link']!, [], ['replays']) },
          unchanged: true,
        },
        pipe: { result: { error: guardRefusal(homes['pipe']!, [], ['dedup']) }, unchanged: true },
        mixed: {
          result: { error: guardRefusal(mixed, ['runs'], ['replays', 'dedup']) },
          unchanged: true,
        },
      },
    });
  }, 30_000); // it starts mkfifo, a child process
});

describe('#616 unit 7a — the fences', () => {
  it("each fence is a read-only regular file holding exactly the fence text, with this Realm's version", () => {
    const home = join(tmp(), '.realm');
    prepareHome(home);
    const fences = Object.fromEntries(
      NAMES.map((n) => [n, { text: readFileSync(join(home, n), 'utf8'), mode: contents(home)[n] }]),
    );
    // (1) red when a word of the fence text changes, the version is not this package's, a name is
    //     not substituted, or a fence is writable or not a regular file; (2) prints each fence's
    //     text and mode.
    expect(fences).toEqual(
      Object.fromEntries(NAMES.map((n) => [n, { text: fence(n), mode: 'file 444' }])),
    );
  });

  it('openers racing on fresh homes leave one full fence at each name, a reader never sees an empty or partial one, and no temporary file is left', async () => {
    const home = pathToFileURL(join(PACKAGE_ROOT, 'dist', 'home.js')).href;
    const homes = [0, 1, 2, 3].map(() => join(tmp(), '.realm'));
    const plan = JSON.stringify({ homes, start: Date.now() + 3_000, gap: 200 });
    const opener =
      `import { prepareHome } from ${JSON.stringify(home)};` +
      'const { homes, start, gap } = JSON.parse(process.env.U07A_RACE); const out = [];' +
      'for (let i = 0; i < homes.length; i++) { while (Date.now() < start + i * gap) {}' +
      ' try { prepareHome(homes[i]); out.push("ok"); } catch (e) { out.push(String(e.code ?? e.message)); } }' +
      'console.log(JSON.stringify(out));';
    const reader =
      `import { fenceText, LEGACY_STORE_NAMES } from ${JSON.stringify(home)};` +
      "import { readFileSync } from 'node:fs'; import { join } from 'node:path';" +
      'const { homes, start, gap } = JSON.parse(process.env.U07A_RACE); const seen = new Set();' +
      'for (let i = 0; i < homes.length; i++) { const left = new Set(LEGACY_STORE_NAMES);' +
      ' const deadline = start + i * gap + 5000;' +
      ' while (left.size > 0 && Date.now() < deadline) { for (const n of [...left]) { let t;' +
      '  try { t = readFileSync(join(homes[i], n), "utf8"); } catch (e) { if (e.code !== "ENOENT") { seen.add(n + ": " + e.code); left.delete(n); } continue; }' +
      '  if (t === fenceText(n)) left.delete(n); else seen.add(n + ": " + JSON.stringify(t.slice(0, 24))); } }' +
      ' for (const n of left) seen.add(n + ": never full"); }' +
      'console.log(JSON.stringify([...seen]));';
    const run = (script: string): Promise<{ status: number | null; out: string; err: string }> =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
          env: { ...process.env, U07A_RACE: plan },
          timeout: 30_000,
        });
        let out = '';
        let err = '';
        child.stdout.on('data', (d: Buffer) => (out += d.toString()));
        child.stderr.on('data', (d: Buffer) => (err += d.toString()));
        child.on('close', (status) => resolve({ status, out: out.trim(), err }));
      });
    const OPENERS = 6;
    const [seen, ...openers] = await Promise.all([
      run(reader),
      ...Array.from({ length: OPENERS }, () => run(opener)),
    ]);
    // (1) red when a fence is written in place instead of linked from a full temporary file (the
    //     reader then sees the name empty, and an opener that meets it refuses it as "something
    //     else"), when a racing opener refuses a fence another placed, or when a temporary file is
    //     left; (2) prints the reader's findings, each opener's results and exit status, and every
    //     home's entries.
    expect({
      reader: { status: seen.status, seen: seen.out, stderr: seen.err },
      openers: openers.map((o) => ({ status: o.status, out: o.out })),
      homes: homes.map((h) => contents(h)),
    }).toEqual({
      reader: { status: 0, seen: '[]', stderr: '' },
      openers: Array.from({ length: OPENERS }, () => ({
        status: 0,
        out: JSON.stringify(homes.map(() => 'ok')),
      })),
      homes: homes.map(() => PREPARED),
    });
  }, 60_000);

  it("an older Realm's mkdir at a fence's name fails with EEXIST, and a folder or file inside it with ENOTDIR", () => {
    const home = join(tmp(), '.realm');
    prepareHome(home);
    const code = (f: () => unknown): string => {
      try {
        f();
        return 'made';
      } catch (err) {
        return String((err as NodeJS.ErrnoException).code);
      }
    };
    // The JSON stores' own calls: a recursive mkdir of the folder, a folder inside it, a run file.
    const results = Object.fromEntries(
      NAMES.map((n) => [
        n,
        [
          code(() => mkdirSync(join(home, n), { recursive: true })),
          code(() => mkdirSync(join(home, n, 'keys'), { recursive: true })),
          code(() => writeFileSync(join(home, n, 'run-1.json'), '{}')),
        ],
      ]),
    );
    // (1) red when a fence is not placed at a name (the older Realm's mkdir then makes its folder
    //     and writes beside realm.db); (2) prints each name's three results.
    expect(results).toEqual(
      Object.fromEntries(NAMES.map((n) => [n, ['EEXIST', 'ENOTDIR', 'ENOTDIR']])),
    );
  });
});

describe('#616 unit 7a — the database file', () => {
  it('under umask 022 realm.db is created empty and owner-only, and SQLite gives its -wal and -shm the same mode', () => {
    const home = join(tmp(), '.realm');
    const before = process.umask(0o022);
    let modes: Record<string, string>;
    let bytes: number;
    try {
      const file = prepareHome(home);
      bytes = statSync(file).size;
      const c = connect(file);
      c.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (x); INSERT INTO t VALUES ('a')");
      const all = contents(home);
      modes = {
        'realm.db': all['realm.db']!,
        'realm.db-wal': all['realm.db-wal']!,
        'realm.db-shm': all['realm.db-shm']!,
      };
    } finally {
      process.umask(before);
    }
    // (1) red when the file is created with the default mode (0644 under umask 022, and the side
    //     files follow it), or is not empty; (2) prints the three files' modes and the size.
    expect({ bytes, modes }).toEqual({
      bytes: 0,
      modes: { 'realm.db': 'file 600', 'realm.db-wal': 'file 600', 'realm.db-shm': 'file 600' },
    });
  });

  it('a realm.db that exists is left as it is: preparing the home again changes neither its bytes nor its inode', () => {
    const home = join(tmp(), '.realm');
    const file = storeWithData(home);
    const before = identity(file);
    const result = prepared(home);
    // (1) red when an existing file is opened for writing by the create (a truncating create
    //     empties the user's store) or recreated; (2) prints the result and whether the bytes and
    //     the inode stayed.
    const after = identity(file);
    expect({
      result,
      sameBytes: after.bytes === before.bytes,
      sameInode: after.inode === before.inode,
    }).toEqual({ result: { returned: file }, sameBytes: true, sameInode: true });
  });
});

describe('#616 unit 7a — a home or a store file Realm cannot write', () => {
  it.skipIf(AS_ROOT)(
    'an existing store in a folder of mode 0555 is refused with STATE_STORE_READONLY, naming the home and the reason',
    () => {
      const home = join(tmp(), '.realm');
      storeWithData(home);
      lock(home, 0o555);
      const result = prepared(home);
      // (1) red when the folder's error leaves raw, or the folder is not checked (everything in it
      //     exists, so nothing else would fail and the open would go on); (2) prints the result.
      expect(result).toEqual({ error: readOnlyRefusal(home, 'permission denied') });
    },
  );

  it.skipIf(AS_ROOT)(
    "the write path refuses a store file it cannot write or open with STATE_STORE_READONLY, naming the file and SQLite's reason",
    async () => {
      // A store file of mode 0400 (SQLite's 8).
      const fileHome = join(tmp(), '.realm');
      const readOnlyFile = storeWithData(fileHome);
      lock(readOnlyFile, 0o400);
      const fileRow = await writeThrough(readOnlyFile, connect(readOnlyFile));
      // A store in a folder of mode 0555 (SQLite's 1544: it cannot make the side files).
      const folderHome = join(tmp(), '.realm');
      const inLockedFolder = storeWithData(folderHome);
      lock(folderHome, 0o555);
      const folderRow = await writeThrough(inLockedFolder, connect(inLockedFolder));
      // A store file of mode 0000: SQLite cannot open it (14). The open that will meet it is unit
      // 7b's; its error is mapped by the same function.
      const closedHome = join(tmp(), '.realm');
      const closed = storeWithData(closedHome);
      lock(closed, 0o000);
      let cannotOpen: unknown;
      try {
        connect(closed);
      } catch (err) {
        cannotOpen = err;
      }
      const openRow = mapSqliteError(cannotOpen, closed);
      // (1) red when an 8, a 1544 or a 14 leaves as a plain error with SQLite's text, or names
      //     another path or reason; (2) prints each row's error.
      expect({
        file: summary(fileRow),
        folder: summary(folderRow),
        open: summary(openRow),
      }).toEqual({
        file: readOnlyRefusal(readOnlyFile, 'attempt to write a readonly database'),
        folder: readOnlyRefusal(inLockedFolder, 'attempt to write a readonly database'),
        open: readOnlyRefusal(closed, 'unable to open database file'),
      });
    },
  );

  it.skipIf(AS_ROOT)(
    'after every refusal the existing realm.db keeps its bytes and its inode',
    async () => {
      const rows: Record<string, unknown> = {};
      const check = async (
        label: string,
        refuse: (home: string, file: string) => Promise<unknown>,
      ) => {
        const home = join(tmp(), '.realm');
        const file = storeWithData(home);
        const before = identity(file);
        const refused = await refuse(home, file);
        const after = identity(file);
        rows[label] = {
          code: (refused as { code?: unknown })?.code,
          sameBytes: after.bytes === before.bytes,
          sameInode: after.inode === before.inode,
        };
      };
      const thrown = (f: () => unknown): unknown => {
        try {
          f();
          return undefined;
        } catch (err) {
          return err;
        }
      };
      // The old store folder moved back into a home that already has its database.
      await check('old folder', async (home) => {
        rmSync(join(home, 'runs'));
        mkdirSync(join(home, 'runs'));
        return thrown(() => prepareHome(home));
      });
      await check('something else', async (home) => {
        rmSync(join(home, 'dedup'));
        writeFileSync(join(home, 'dedup'), '{}');
        return thrown(() => prepareHome(home));
      });
      await check('folder 0555', async (home) => {
        lock(home, 0o555);
        return thrown(() => prepareHome(home));
      });
      await check('file 0400', async (_home, file) => {
        lock(file, 0o400);
        return writeThrough(file, connect(file));
      });
      // (1) red when a refusal recreates or rewrites the database file (its inode or bytes then
      //     change), or a row is not refused; (2) prints each row's code and what stayed.
      const same = (code: string) => ({ code, sameBytes: true, sameInode: true });
      expect(rows).toEqual({
        'old folder': same('STATE_HOME_HOLDS_LEGACY_STORE'),
        'something else': same('STATE_HOME_HOLDS_LEGACY_STORE'),
        'folder 0555': same('STATE_STORE_READONLY'),
        'file 0400': same('STATE_STORE_READONLY'),
      });
    },
  );
});
