// read-registered-workflows-616.test.ts — issue #616 PR-2c c10a-3b-i (DELTAS row 56): the separation
// check's one read-only look at the registered workflows. The real cases: the check runs as a login
// that cannot write the home (the side files there or not); the home has no store yet, or still holds
// the old JSON folders; a copy is not JSON or another Realm's shape; a newer Realm migrated the file;
// a running Realm holds a handle on the same home and keeps writing. Each case on its own home in the
// system temp folder; the modes a cell changes are restored in a `finally`.
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import { createHash } from 'node:crypto';
import {
  chmodSync,
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
import { fileURLToPath } from 'node:url';
import { REALM_STORE_SCHEMA, type WorkflowDefinition } from '@sensigo/realm';
import { afterEach, describe, expect, it } from 'vitest';
import { DATABASE_FILE } from './home.js';
import { openRealmHome, readRegisteredWorkflows } from './index.js';
import { openForeignConnection } from './test-support/foreign-connection.js';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/** A login that is root reads and writes every folder whatever its mode: the mode cells cannot run. */
const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const AT = '2026-01-01T00:00:00.000Z';

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A fresh folder under the system temp folder, removed after the cell. */
function fresh(): string {
  const dir = mkdtempSync(join(tmpdir(), 'realm-616-3bi-'));
  made.push(dir);
  return dir;
}

/** A definition with the separation check's fields, each as given (typed or not). */
function definition(id: string, fields: Record<string, unknown> = {}): WorkflowDefinition {
  return {
    id,
    name: id,
    version: 1,
    schema_version: 1,
    steps: { a: { description: 'a', execution: 'agent', depends_on: [] } },
    ...fields,
  } as unknown as WorkflowDefinition;
}

/** A home whose store holds `definitions`, registered through a handle that is then closed. */
async function storeWith(definitions: readonly WorkflowDefinition[]): Promise<string> {
  const home = fresh();
  const handle = await openRealmHome({ home });
  try {
    for (const d of definitions) await handle.workflowStore.register(d);
  } finally {
    handle.close();
  }
  return home;
}

/** A folder's names, sorted, or the error's code. */
function names(dir: string): string[] | string {
  try {
    return readdirSync(dir).sort();
  } catch (err) {
    return String((err as { code?: unknown }).code);
  }
}

const sides = (home: string): boolean =>
  names(home).includes(`${DATABASE_FILE}-wal`) || names(home).includes(`${DATABASE_FILE}-shm`);

/** Runs `body` with `path` at `mode`, the mode restored to `back` after, whatever happens. */
async function withMode<T>(path: string, mode: number, back: number, body: () => Promise<T>) {
  chmodSync(path, mode);
  try {
    return await body();
  } finally {
    chmodSync(path, back);
  }
}

/** The package README, its whitespace folded, and whether it carries a sentence. */
const README = readFileSync(join(PACKAGE_ROOT, 'README.md'), 'utf8').replace(/\s+/g, ' ');
const says = (sentence: string): boolean => README.includes(sentence);
const SENTENCES = {
  read: "`readRegisteredWorkflows({ home? })` reads, for the separation check, the registered workflows' ids with their `trust_root`, `source_dir` and `extensions` where stored — read-only: it writes nothing to the store file (SQLite may create or update its two side files beside it, `realm.db-wal` and `realm.db-shm`), and answers `no_store` or `unreadable` instead of throwing.",
} as const;

describe('#616 PR-2c c10a-3b-i — readRegisteredWorkflows', () => {
  it('(a) no realm.db, or an empty one: no_store, and nothing is made — no home folder, no fence, no file', async () => {
    const parent = fresh();
    const missing = join(parent, 'home');
    const empty = fresh();
    writeFileSync(join(empty, DATABASE_FILE), '');
    const before = { parent: names(parent), empty: names(empty) };
    const read = {
      missing: await readRegisteredWorkflows({ home: missing }),
      empty: await readRegisteredWorkflows({ home: empty }),
    };
    // (1) red when the look before the open is skipped (the check's open then refuses the missing
    //     home instead, or looks into it), or when an empty file goes to the open; (2) prints both
    //     answers and both folders' names before and after.
    expect({ read, after: { parent: names(parent), empty: names(empty) } }).toEqual({
      read: { missing: { state: 'no_store' }, empty: { state: 'no_store' } },
      after: before,
    });
  });

  it('(b) the registered copies, each with its fields only when stored and of its type: a list keeps its strings, a string is one entry, a wrongly typed field is dropped', async () => {
    const home = await storeWith([
      definition('wf-full', {
        trust_root: '/srv/root',
        source_dir: '/srv/src',
        extensions: ['./a.mjs', 7],
      }),
      definition('wf-none'),
      definition('wf-one', { extensions: './one.mjs' }),
      definition('wf-wrong', { trust_root: '', source_dir: 5, extensions: { x: 1 } }),
    ]);
    // (1) red when a field is passed untyped (a number, an object or an empty root comes through),
    //     when a list's non-string member stays, or when a string is not one entry; (2) prints the
    //     answer.
    expect(await readRegisteredWorkflows({ home })).toStrictEqual({
      state: 'ok',
      workflows: [
        {
          id: 'wf-full',
          trust_root: '/srv/root',
          source_dir: '/srv/src',
          extensions: ['./a.mjs'],
        },
        { id: 'wf-none' },
        { id: 'wf-one', extensions: ['./one.mjs'] },
        { id: 'wf-wrong' },
      ],
    });
  });

  it('(c) no registered workflow: ok with an empty list', async () => {
    const home = await storeWith([]);
    // (1) red when an empty registry is not `ok` (a store with no rows read as missing or
    //     unreadable); (2) prints the answer.
    expect(await readRegisteredWorkflows({ home })).toStrictEqual({ state: 'ok', workflows: [] });
  });

  it('(d) a copy whose text is not JSON, beside a good one: both ids, the good one’s fields, no throw', async () => {
    const home = await storeWith([definition('wf-good', { trust_root: '/srv/root' })]);
    // Planted by a writer that is not Realm: the version guard dropped, the rows written, the guard
    // put back from the schema's own text, so the file's schema is this Realm's again.
    const text = 'not json {';
    const hash = createHash('sha256').update(text).digest('hex');
    const guard = REALM_STORE_SCHEMA.find((s) =>
      s.startsWith('CREATE TRIGGER workflow_versions_insert_valid'),
    );
    const c = await openForeignConnection(home);
    try {
      c.exec('BEGIN IMMEDIATE');
      c.exec('DROP TRIGGER workflow_versions_insert_valid');
      c.prepare(
        'INSERT INTO workflow_versions (hash, id, definition, first_registered_at) VALUES (?, ?, ?, ?)',
      ).run(hash, 'wf-bad', text, AT);
      c.prepare(
        'INSERT INTO workflow_registrations (id, seq, hash, registered_at) VALUES (?, 0, ?, ?)',
      ).run('wf-bad', hash, AT);
      c.prepare('INSERT INTO workflows (id, current_hash, registered_at) VALUES (?, ?, ?)').run(
        'wf-bad',
        hash,
        AT,
      );
      c.exec(String(guard));
      c.exec('COMMIT');
    } finally {
      c.close();
    }
    // (1) red when a copy that is not JSON throws out of the read (it is then unreadable, or the
    //     promise rejects), or drops its id; (2) prints the answer.
    expect(await readRegisteredWorkflows({ home })).toStrictEqual({
      state: 'ok',
      workflows: [{ id: 'wf-bad' }, { id: 'wf-good', trust_root: '/srv/root' }],
    });
  });

  it('(e) a realm.db that is not a database: unreadable with the open’s code', async () => {
    const home = fresh();
    writeFileSync(join(home, DATABASE_FILE), 'this is not a database, only bytes');
    // (1) red when the failure is swallowed into `ok` or thrown; (2) prints the answer.
    expect(await readRegisteredWorkflows({ home })).toStrictEqual({
      state: 'unreadable',
      code: 'header_damaged',
    });
  });

  it.skipIf(asRoot)(
    '(f) a login that cannot write the home: with no side files, unreadable with SQLite’s number; with the side files there, ok',
    async () => {
      const bare = await storeWith([definition('wf-f', { trust_root: '/srv/root' })]);
      const bareSides = sides(bare);
      const noSides = await withMode(bare, 0o555, 0o755, () =>
        withMode(join(bare, DATABASE_FILE), 0o444, 0o644, () =>
          readRegisteredWorkflows({ home: bare }),
        ),
      );
      // The side files there: a running Realm holds them (its handle stays open).
      const held = await storeWith([definition('wf-f', { trust_root: '/srv/root' })]);
      const handle = await openRealmHome({ home: held });
      try {
        await handle.workflowStore.register(definition('wf-g'));
        const heldSides = sides(held);
        const withSides = await withMode(held, 0o555, 0o755, () =>
          withMode(join(held, DATABASE_FILE), 0o444, 0o644, () =>
            readRegisteredWorkflows({ home: held }),
          ),
        );
        // (1) red when the check's open refuses a login that cannot write (the side files there),
        //     when `not_writable` is taken as a reason not to read, or when SQLite's number is
        //     dropped or mapped; (2) prints whether each fixture had its side files and both answers.
        expect({ bareSides, noSides, heldSides, withSides }).toStrictEqual({
          bareSides: false,
          noSides: { state: 'unreadable', code: 'open_failed', errcode: 1544 },
          heldSides: true,
          withSides: {
            state: 'ok',
            workflows: [{ id: 'wf-f', trust_root: '/srv/root' }, { id: 'wf-g' }],
          },
        });
      } finally {
        handle.close();
      }
    },
  );

  it('(g) a handle that wrote and stays open: an ok read leaves realm.db’s bytes and mtime and the WAL’s size as they were, and the handle still reads and writes', async () => {
    const home = fresh();
    const handle = await openRealmHome({ home });
    try {
      await handle.workflowStore.register(definition('wf-g1'));
      const db = join(home, DATABASE_FILE);
      const state = () => ({
        bytes: createHash('sha256').update(readFileSync(db)).digest('hex'),
        mtime: statSync(db).mtimeMs,
        wal: statSync(`${db}-wal`).size,
      });
      const before = state();
      const read = await readRegisteredWorkflows({ home });
      const after = state();
      await handle.workflowStore.register(definition('wf-g2'));
      const listed = (await handle.workflowStore.list()).map((w) => w.id);
      // (1) red when the read uses the cached handle (closing it under the caller), or checkpoints
      //     the log into the file; (2) prints the answer, the file's state before and after, and what
      //     the handle lists after a write.
      expect({ read, same: after, listed }).toEqual({
        read: { state: 'ok', workflows: [{ id: 'wf-g1' }] },
        same: before,
        listed: ['wf-g1', 'wf-g2'],
      });
    } finally {
      handle.close();
    }
  });

  it('(h) a file a newer Realm migrated (user_version raised): unreadable with the open’s newer_version, nothing read', async () => {
    const home = await storeWith([definition('wf-h', { trust_root: '/srv/root' })]);
    const c = await openForeignConnection(home);
    try {
      c.exec('PRAGMA user_version = 2');
    } finally {
      c.close();
    }
    // (1) red when the read goes on through a connection the open marked not usable, or the
    //     refusal is swallowed into `ok`; (2) prints the answer.
    expect(await readRegisteredWorkflows({ home })).toStrictEqual({
      state: 'unreadable',
      code: 'newer_version',
    });
  });

  it.skipIf(asRoot)(
    '(h2) the same newer file, read by a login that cannot write it: the code is newer_version, never not_writable',
    async () => {
      const home = await storeWith([definition('wf-h')]);
      const c = await openForeignConnection(home);
      try {
        c.exec('PRAGMA user_version = 2');
      } finally {
        c.close();
      }
      await readRegisteredWorkflows({ home }); // a read in the writable folder leaves the side files
      const withSides = sides(home);
      const read = await withMode(home, 0o555, 0o755, () => readRegisteredWorkflows({ home }));
      // (1) red when the code is the first outcome's (`not_writable` comes first for this login)
      //     instead of the open's `blockedBy`; (2) prints whether the side files were there and the
      //     answer.
      expect({ withSides, read }).toStrictEqual({
        withSides: true,
        read: { state: 'unreadable', code: 'newer_version' },
      });
    },
  );

  it.skipIf(asRoot)(
    '(i) a home folder that cannot be searched (mode 000): unreadable with EACCES, never no_store',
    async () => {
      const home = await storeWith([definition('wf-i')]);
      const read = await withMode(home, 0o000, 0o755, () => readRegisteredWorkflows({ home }));
      // (1) red when a refused look is taken for a missing store (`no_store`); (2) prints the answer.
      expect(read).toStrictEqual({ state: 'unreadable', code: 'EACCES' });
    },
  );

  it('(j) a symbolic link or a folder at realm.db: unreadable with the open’s refusal, never no_store', async () => {
    const source = await storeWith([definition('wf-j')]);
    const linked = fresh();
    symlinkSync(join(source, DATABASE_FILE), join(linked, DATABASE_FILE));
    const folder = fresh();
    mkdirSync(join(folder, DATABASE_FILE));
    // (1) red when something that is not a regular file is taken for a missing store or read
    //     through; (2) prints both answers.
    expect({
      linked: await readRegisteredWorkflows({ home: linked }),
      folder: await readRegisteredWorkflows({ home: folder }),
    }).toStrictEqual({
      linked: { state: 'unreadable', code: 'STATE_STORE_SETTINGS_REFUSED' },
      folder: { state: 'unreadable', code: 'STATE_STORE_SETTINGS_REFUSED' },
    });
  });

  it('(k) a home still holding an old JSON folder (runs/ a directory beside realm.db): unreadable with the old-store guard’s code, and nothing is made', async () => {
    const home = await storeWith([definition('wf-k')]);
    rmSync(join(home, 'runs'), { force: true });
    mkdirSync(join(home, 'runs'));
    const before = names(home);
    const read = await readRegisteredWorkflows({ home });
    // (1) red when the guard's refusal escapes as a throw, or the guard is bypassed (the copies are
    //     read); (2) prints the answer and the home's names before and after.
    expect({ read, after: names(home) }).toStrictEqual({
      read: { state: 'unreadable', code: 'STATE_HOME_HOLDS_LEGACY_STORE' },
      after: before,
    });
  });

  it('the README says what the function returns and never does, as cells (a) to (k) pin it', () => {
    // (1) red when the sentence is changed or dropped; (2) prints whether the README holds it.
    expect({ says: says(SENTENCES.read) }).toEqual({ says: true });
  });
});
