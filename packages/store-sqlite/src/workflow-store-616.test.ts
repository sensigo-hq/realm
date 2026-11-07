// workflow-store-616.test.ts — issue #616 PR-1b B3: THE WORKFLOW REGISTRY ON SQLITE. A Realm home is
// opened through the package's own open (the one loader, the real schema, the open's seams for the
// cells that inject a fault), and its `workflowStore` is driven the way a host drives it: `register`
// on every save (`realm watch` registers on every save), `get` when a run starts, `list` for a
// listing. What is stored is read on a connection of the cell's own.
//
// The guard cells (the 4-series) act as a writer that is not Realm: a second connection on the
// home's file (`openForeignConnection`, `recursive_triggers` off, SQLite's default) sending plain
// SQL. The 11-series is a database such a writer changed after removing a guard of the file (the cell
// drops that guard itself, on its own file).
//
// Faults: SQLite cannot be made to fail at COMMIT here, so the 8-series injects the COMMIT error at
// the driver seam (`test-support/commit-faults.ts`, SQLite's own error shape); the read-back, the
// resolving commit and the other connection are real.
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadWorkflowFromFile,
  loadWorkflowFromString,
  WorkflowError,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { steppingClock } from '@sensigo/realm-testing';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type DatabaseLike } from './driver.js';
import { DATABASE_FILE } from './home.js';
import { openHome, type RealmHome } from './open-realm-home.js';
import { faultyFiles, SQLITE, type Fault, type FaultyFiles } from './test-support/commit-faults.js';
import { openForeignConnection } from './test-support/foreign-connection.js';

/** The guards' messages, written out so a changed message is a red cell (the prompt's table). */
const G = {
  pointsOwn: 'realm.db: a workflow can only point at one of its own versions',
  idFixed: "realm.db: a workflow's id cannot change",
  noDelete: 'realm.db: a registered workflow cannot be deleted',
  version: 'realm.db: a workflow version must be a JSON object that carries its own id',
  versionFixed: 'realm.db: a workflow version cannot change',
  registration: "realm.db: a registration can only name one of its own workflow's versions",
  history: 'realm.db: the registration history cannot change',
  rowNumber: 'realm.db: a row number must be 1 or more',
} as const;

/** The damaged-pointer refusal's words, written out (the prompt's "Words a user reads"). */
const damagedPointer = (id: string): string =>
  `The registered copy of workflow '${id}' is missing from the store or is not JSON: something ` +
  'other than Realm changed the database. Register the workflow again from its source; if this ' +
  'message comes back, restore the database from a backup.';

const START = '2026-11-07T09:00:00.000Z';
const STEP_MS = 1_000;
/** The k-th reading of a cell's clock (the open spends the first), in the store's one text shape. */
const readingAt = (k: number): string => new Date(Date.parse(START) + k * STEP_MS).toISOString();

const dirs: string[] = [];
const homes: RealmHome[] = [];
const connections: DatabaseLike[] = [];
afterEach(() => {
  for (const c of connections.splice(0)) {
    try {
      if (c.isTransaction) c.exec('ROLLBACK');
      c.close();
    } catch {
      // closed by its cell
    }
  }
  for (const h of homes.splice(0)) h.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Opened {
  readonly home: RealmHome;
  readonly path: string;
  readonly clock: ReturnType<typeof steppingClock>;
  readonly files: FaultyFiles;
}

/** A fresh Realm home on a stepping clock, opened through the open's seam so faults can be armed. */
async function open(): Promise<Opened> {
  const dir = mkdtempSync(join(tmpdir(), 'realm-616-b3-'));
  dirs.push(dir);
  const path = join(dir, '.realm');
  const clock = steppingClock(START, STEP_MS);
  const files = faultyFiles((file) => openDatabase(file));
  const home = await openHome({ home: path, clock }, { openFile: files.openFile });
  homes.push(home);
  return { home, path, clock, files };
}

/** Arms `fault` on the connection the home uses now. */
function arm(o: Opened, fault: Fault): void {
  o.files.opened[o.files.opened.length - 1]!.arm(fault);
}

/** A second connection on the home's file: the writer that is not Realm. */
async function foreign(o: Opened): Promise<DatabaseLike> {
  const c = await openForeignConnection(o.path);
  connections.push(c);
  return c;
}

/** What is stored, read on a connection of its own: the three tables, every row, in key order. */
function stored(o: Opened): {
  workflows: Record<string, unknown>[];
  versions: Record<string, unknown>[];
  registrations: Record<string, unknown>[];
} {
  const c = openDatabase(join(o.path, DATABASE_FILE));
  try {
    return {
      workflows: c.prepare('SELECT * FROM workflows ORDER BY id').all(),
      versions: c
        .prepare(
          'SELECT rowid, hash, id, definition, first_registered_at FROM workflow_versions ORDER BY rowid',
        )
        .all(),
      registrations: c.prepare('SELECT * FROM workflow_registrations ORDER BY id, seq').all(),
    };
  } finally {
    c.close();
  }
}

/** The lowercase hex sha256 of a definition's text (the stored shape's rule). */
const hashOf = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** A workflow as core's loader makes it, with its steps in the order given. */
function workflow(id: string, steps: readonly string[], version = 1): WorkflowDefinition {
  return loadWorkflowFromString(
    `id: ${id}\nname: ${id}\nversion: ${version}\nsteps:\n` +
      steps
        .map(
          (s) => `  ${s}:\n    description: step ${s}\n    execution: agent\n    depends_on: []\n`,
        )
        .join(''),
  );
}

/** What a statement on the foreign connection does: `'landed'`, or the message it was refused with. */
function attempt(c: DatabaseLike, sql: string, ...params: unknown[]): string {
  try {
    c.prepare(sql).run(...params);
    return 'landed';
  } catch (err) {
    return (err as Error).message;
  }
}

/** Registers `text` for `id` the way Realm does, as plain SQL on a foreign connection, at `at`. */
function foreignRegister(c: DatabaseLike, id: string, text: string, at: string): void {
  const hash = hashOf(text);
  c.exec('BEGIN IMMEDIATE');
  try {
    if (c.prepare('SELECT 1 FROM workflow_versions WHERE hash = ?').get(hash) === undefined) {
      c.prepare(
        'INSERT INTO workflow_versions (hash, id, definition, first_registered_at) VALUES (?, ?, ?, ?)',
      ).run(hash, id, text, at);
    }
    const newest = c
      .prepare('SELECT max(seq) AS seq FROM workflow_registrations WHERE id = ?')
      .get(id) as { seq: number | null };
    c.prepare(
      'INSERT INTO workflow_registrations (id, seq, hash, registered_at) VALUES (?, ?, ?, ?)',
    ).run(id, newest.seq === null ? 0 : newest.seq + 1, hash, at);
    if (c.prepare('SELECT 1 FROM workflows WHERE id = ?').get(id) === undefined) {
      c.prepare('INSERT INTO workflows (id, current_hash, registered_at) VALUES (?, ?, ?)').run(
        id,
        hash,
        at,
      );
    } else {
      c.prepare('UPDATE workflows SET current_hash = ?, registered_at = ? WHERE id = ?').run(
        hash,
        at,
        id,
      );
    }
    c.exec('COMMIT');
  } catch (err) {
    c.exec('ROLLBACK');
    throw err;
  }
}

/** What a call settled with: its value, or its error. */
async function settle<T>(p: Promise<T>): Promise<{ value?: T; error?: unknown }> {
  try {
    return { value: await p };
  } catch (error) {
    return { error };
  }
}

/** The parts of a store refusal a cell compares (no credential in any of them). */
function refusal(err: unknown): Record<string, unknown> {
  if (!(err instanceof WorkflowError)) return { notWorkflowError: String(err) };
  return {
    code: err.code,
    message: err.message,
    category: err.category,
    agentAction: err.agentAction,
    retryable: err.retryable,
    details: err.details,
    facts: err.facts,
  };
}

/** The damaged-pointer refusal, whole. */
const damagedPointerRefusal = (id: string): Record<string, unknown> => ({
  code: 'RESOURCE_FORMAT_INVALID',
  message: damagedPointer(id),
  category: 'RESOURCE',
  agentAction: 'stop',
  retryable: false,
  details: { workflowId: id },
  facts: undefined,
});

describe('#616 B3 — register keeps each distinct text once, and moves the pointer', () => {
  it('check 1: a workflow whose steps are reordered is a new text: get returns the new order, and two versions are stored', async () => {
    const o = await open();
    await o.home.workflowStore.register(workflow('wf', ['a', 'b']));
    await o.home.workflowStore.register(workflow('wf', ['b', 'a']));
    const got = await o.home.workflowStore.get('wf');
    // (1) red when the hash is taken over a key-sorted form ([b, a] then shares [a, b]'s hash and the
    //     second register is refused or the order is lost); (2) prints the step order read back and
    //     the number of stored versions.
    expect({ order: Object.keys(got.steps), versions: stored(o).versions.length }).toEqual({
      order: ['b', 'a'],
      versions: 2,
    });
  });

  it('check 2: A, then B, then A again (an undo in `realm watch`): the pointer names A, and no third version is stored', async () => {
    const o = await open();
    const a = workflow('wf', ['a']);
    await o.home.workflowStore.register(a);
    await o.home.workflowStore.register(workflow('wf', ['b']));
    await o.home.workflowStore.register(a);
    // (1) red when the pointer is not moved because A's version already exists (get answers B);
    //     (2) prints the definition read back and the number of stored versions.
    expect({
      got: await o.home.workflowStore.get('wf'),
      versions: stored(o).versions.length,
    }).toEqual({ got: a, versions: 2 });
  });

  it("check 3: the same file loaded twice through core's loader, the clock moved on in between: nothing is written the second time", async () => {
    const o = await open();
    const file = join(dirs[0]!, 'wf.yaml');
    writeFileSync(
      file,
      'id: wf\nname: wf\nversion: 1\nsteps:\n  a:\n    description: a\n    execution: agent\n    depends_on: []\n',
    );
    await o.home.workflowStore.register(loadWorkflowFromFile(file));
    const first = stored(o);
    await o.home.workflowStore.get('wf'); // the clock moves on
    await o.home.workflowStore.register(loadWorkflowFromFile(file));
    // (1) red when the pointer is written (stamped with this write's reading) on every register
    //     (Airflow's version inflation); (2) prints the stored rows after the second register
    //     against the rows after the first.
    expect(stored(o)).toEqual(first);
  });

  it("check 9: every time a register stores is its one reading of the clock, in the store's text shape", async () => {
    const o = await open();
    const before = o.clock.reads;
    await o.home.workflowStore.register(workflow('wf', ['a']));
    const rows = stored(o);
    const at = readingAt(before);
    // (1) red when the body reads the clock a second time (the stamps are a later reading, and the
    //     clock was read twice); (2) prints the readings spent and the three stamps.
    expect({
      readings: o.clock.reads - before,
      first_registered_at: rows.versions[0]?.['first_registered_at'],
      registration: rows.registrations[0]?.['registered_at'],
      pointer: rows.workflows[0]?.['registered_at'],
    }).toEqual({ readings: 1, first_registered_at: at, registration: at, pointer: at });
  });
});

describe('#616 B3 — the history of the pointer (#493 reads it; nothing here does)', () => {
  it("H1: A, B, then A: three rows, 0, 1 and 2, naming A, B and A, each with its own write's reading", async () => {
    const o = await open();
    const a = workflow('wf', ['a']);
    const b = workflow('wf', ['b']);
    const at: string[] = [];
    for (const d of [a, b, a]) {
      at.push(readingAt(o.clock.reads));
      await o.home.workflowStore.register(d);
    }
    const ha = hashOf(JSON.stringify(a));
    const hb = hashOf(JSON.stringify(b));
    // (1) red when no row is appended for a text whose version already exists (the third move is
    //     lost, or refused by the pointer's guard); (2) prints the history rows.
    expect(stored(o).registrations).toEqual([
      { id: 'wf', seq: 0, hash: ha, registered_at: at[0] },
      { id: 'wf', seq: 1, hash: hb, registered_at: at[1] },
      { id: 'wf', seq: 2, hash: ha, registered_at: at[2] },
    ]);
  });

  it("README: the package README carries the registry's sentence (pinned by checks 1, 2, 3 and H1)", () => {
    const readme = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'README.md'),
      'utf8',
    ).replace(/\s+/g, ' ');
    // (1) red when the sentence is changed or removed; (2) prints whether it is there.
    expect(
      readme.includes(
        'The workflow registry stores each distinct definition text once, under its hash, with a ' +
          'pointer per workflow to its current text and a record of every move of that pointer; an ' +
          'identical re-register writes nothing.',
      ),
    ).toBe(true);
  });
});

describe('#616 B3 — get and list read the current copy through the one shared checker', () => {
  it("check 6: get of a workflow never registered refuses with today's words", async () => {
    const o = await open();
    const got = await settle(o.home.workflowStore.get('nope'));
    // (1) red when an absent workflow resolves (undefined) instead of being refused; (2) prints the
    //     refusal's parts.
    expect(refusal(got.error)).toEqual({
      code: 'STATE_WORKFLOW_NOT_FOUND',
      message: 'Workflow not found: nope',
      category: 'STATE',
      agentAction: 'report_to_user',
      retryable: false,
      details: {},
      facts: undefined,
    });
  });

  it('check 5a: a copy an older Realm registered (two Realm versions sharing one home) is refused, named by its id, with no path', async () => {
    const o = await open();
    const legacy = {
      id: 'old',
      name: 'Old',
      version: 1,
      steps: {},
    } as unknown as WorkflowDefinition;
    await o.home.workflowStore.register(legacy);
    const got = await settle(o.home.workflowStore.get('old'));
    // (1) red when a legacy copy is read as readable; (2) prints the refusal's parts.
    expect(refusal(got.error)).toEqual({
      code: 'STATE_LEGACY_FORMAT',
      message:
        'This workflow was registered with an older version of Realm. Re-register it with: realm ' +
        'workflow register <path-to-workflow>',
      category: 'STATE',
      agentAction: 'report_to_user',
      retryable: false,
      details: { workflowId: 'old' },
      facts: undefined,
    });
  });

  it('check 5b: a copy a later Realm registered is refused, with its format facts and no path', async () => {
    const o = await open();
    const newer = {
      id: 'new',
      name: 'New',
      version: 1,
      schema_version: 2,
      steps: {},
    } as unknown as WorkflowDefinition;
    await o.home.workflowStore.register(newer);
    const got = await settle(o.home.workflowStore.get('new'));
    // (1) red when a newer copy is read as readable; (2) prints the refusal's parts.
    expect(refusal(got.error)).toEqual({
      code: 'STATE_NEWER_FORMAT',
      message:
        "Workflow 'new' was registered by a later version of Realm (definition format 2; this " +
        'version reads up to 1) — refused: this version would ignore requirements it cannot read. ' +
        "Use the Realm version that registered it, or register the workflow's source again with " +
        'this version. Nothing was run.',
      category: 'STATE',
      agentAction: 'report_to_user',
      retryable: false,
      details: {},
      facts: { scope: 'newer_definition', schema_version: 2, reads_up_to: 1 },
    });
  });

  it('check 5c: a foreign write of valid JSON that is not a workflow is refused as damaged, by its id', async () => {
    const o = await open();
    foreignRegister(await foreign(o), 'odd', '{"id":"odd"}', readingAt(9));
    const got = await settle(o.home.workflowStore.get('odd'));
    // (1) red when the parsed value is returned unchecked; (2) prints the refusal's parts.
    expect(refusal(got.error)).toEqual({
      code: 'RESOURCE_FORMAT_INVALID',
      message:
        "the registered copy of 'odd' is JSON but not a workflow object (it has no schema_version, " +
        'and is not the shape older versions of Realm wrote (a string name and a number version))',
      category: 'RESOURCE',
      agentAction: 'stop',
      retryable: false,
      details: { workflowId: 'odd', fault: { kind: 'not_a_workflow', fault: 'not_legacy_shape' } },
      facts: undefined,
    });
  });

  it('list: every registered workflow, ordered by id', async () => {
    const o = await open();
    for (const id of ['c', 'a', 'b']) await o.home.workflowStore.register(workflow(id, ['s']));
    // (1) red when the listing reads one row only; (2) prints the ids listed.
    expect((await o.home.workflowStore.list()).map((d) => d.id)).toEqual(['a', 'b', 'c']);
  });

  it('check 7a: list leaves out the copies an older or a later Realm registered, as the JSON listing does', async () => {
    const o = await open();
    await o.home.workflowStore.register(workflow('readable', ['s']));
    await o.home.workflowStore.register({ id: 'old', name: 'Old', version: 1, steps: {} } as never);
    await o.home.workflowStore.register({
      id: 'new',
      name: 'New',
      version: 1,
      schema_version: 2,
      steps: {},
    } as never);
    // (1) red when every row is returned; (2) prints the ids listed.
    expect((await o.home.workflowStore.list()).map((d) => d.id)).toEqual(['readable']);
  });

  it('check 7b: a broken current copy makes list throw; it does not vanish from the listing', async () => {
    const o = await open();
    await o.home.workflowStore.register(workflow('readable', ['s']));
    foreignRegister(await foreign(o), 'odd', '{"id":"odd"}', readingAt(9));
    const got = await settle(o.home.workflowStore.list());
    // (1) red when a damaged row is skipped (list answers the readable one only); (2) prints what
    //     the listing settled with.
    expect({ value: got.value, code: refusal(got.error)['code'] }).toEqual({
      value: undefined,
      code: 'RESOURCE_FORMAT_INVALID',
    });
  });

  it('check 7c: a listing whose read fails rejects with the read\'s error, never "no workflows" (#617)', async () => {
    const o = await open();
    await o.home.workflowStore.register(workflow('readable', ['s']));
    arm(o, {
      at: (sql) => sql.includes('ORDER BY w.id'),
      times: 1,
      first: 'nothing',
      error: SQLITE.ioError,
    });
    const got = await settle(o.home.workflowStore.list());
    // (1) red when a failed read is caught and answered with []; (2) prints what the listing
    //     settled with: never the damaged-copy words for a read error (#719).
    expect({ value: got.value, error: String(got.error) }).toEqual({
      value: undefined,
      error: 'Error: disk I/O error (SQLite error 10)',
    });
  });

  it("check 10: one connection per home: after home.close(), the registry's calls reject", async () => {
    const o = await open();
    await o.home.workflowStore.register(workflow('wf', ['a']));
    o.home.close();
    const got = await settle(o.home.workflowStore.get('wf'));
    // (1) red when the registry is built on a connection of its own (it still answers); (2) prints
    //     what get settled with.
    expect({ value: got.value, rejected: got.error !== undefined }).toEqual({
      value: undefined,
      rejected: true,
    });
  });
});

describe('#616 B3 — a register whose COMMIT reports an error (the COMMIT outcome protocol)', () => {
  it('check 8a: the write landed although its COMMIT reported an error: register answers landed', async () => {
    const o = await open();
    arm(o, { at: (sql) => sql === 'COMMIT', times: 1, first: 'run', error: SQLITE.ioError });
    const got = await settle(o.home.workflowStore.register(workflow('wf', ['a'])));
    // (1) red when the write's check says it is not there (register rejects); (2) prints what
    //     register settled with and the history rows.
    expect({ error: got.error, rows: stored(o).registrations.length }).toEqual({
      error: undefined,
      rows: 1,
    });
  });

  it('check 8b: the disk fills while `realm watch` saves an undo (A, B, then A): register rejects, and the pointer and the history agree on B', async () => {
    const o = await open();
    const a = workflow('wf', ['a']);
    const b = workflow('wf', ['b']);
    await o.home.workflowStore.register(a);
    await o.home.workflowStore.register(b);
    // The COMMIT of the write that moves the pointer, the last COMMIT a register makes: SQLite rolled
    // the transaction back by itself, as it does on a full disk.
    let moved = false;
    arm(o, {
      at: (sql) => {
        if (/^(UPDATE|INSERT INTO) workflows /.test(sql)) moved = true;
        return moved && sql === 'COMMIT';
      },
      times: 1,
      first: 'rollback',
      error: SQLITE.full,
    });
    const got = await settle(o.home.workflowStore.register(a));
    const rows = stored(o);
    const newest = rows.registrations[rows.registrations.length - 1];
    // (1) red when the check reads only the version row (A's version exists, so it answers landed),
    //     or when the history row is appended in a write of its own (it stays while the pointer does
    //     not move); (2) prints the code, the pointer and the newest history row's hash.
    expect({
      code: refusal(got.error)['code'],
      pointer: rows.workflows[0]?.['current_hash'],
      newest: newest?.['hash'],
    }).toEqual({
      code: 'STATE_STORE_FULL',
      pointer: hashOf(JSON.stringify(b)),
      newest: hashOf(JSON.stringify(b)),
    });
  });

  it('check 8c: the write landed, then another writer registered another text before the read-back: register still answers landed', async () => {
    const o = await open();
    await o.home.workflowStore.register(workflow('wf', ['a']));
    const other = await foreign(o);
    const later = JSON.stringify(workflow('wf', ['c']));
    arm(o, {
      at: (sql) => sql === 'COMMIT',
      times: 1,
      first: 'run',
      also: () => foreignRegister(other, 'wf', later, readingAt(99)),
      error: SQLITE.ioError,
    });
    const got = await settle(o.home.workflowStore.register(workflow('wf', ['b'])));
    // (1) red when the check reads the pointer (it names the other writer's text, so the answer is
    //     "not landed"); (2) prints what register settled with and the history's hashes.
    expect({ error: got.error, seqs: stored(o).registrations.map((r) => r['seq']) }).toEqual({
      error: undefined,
      seqs: [0, 1, 2],
    });
  });
});

describe('#616 B3 — a database a writer changed after removing a guard of the file', () => {
  /** Workflow `wf` registered as A, then its pointer moved by SQL to text X's hash, which has no version. */
  async function pointerToMissingVersion(): Promise<{ o: Opened; x: WorkflowDefinition }> {
    const o = await open();
    await o.home.workflowStore.register(workflow('wf', ['a']));
    const x = workflow('wf', ['x']);
    const c = await foreign(o);
    c.exec('DROP TRIGGER workflows_insert_own');
    c.exec('DROP TRIGGER workflows_update_own');
    c.prepare('UPDATE workflows SET current_hash = ? WHERE id = ?').run(
      hashOf(JSON.stringify(x)),
      'wf',
    );
    return { o, x };
  }

  it('check 11a: a pointer naming a missing version: get refuses with the damaged-pointer words, never "not found"', async () => {
    const { o } = await pointerToMissingVersion();
    const got = await settle(o.home.workflowStore.get('wf'));
    // (1) red when the version is inner-joined and the workflow answered "not found"; (2) prints the
    //     refusal's parts.
    expect(refusal(got.error)).toEqual(damagedPointerRefusal('wf'));
  });

  it('check 11b: the same database: list refuses with the same words; the pointer is not left out', async () => {
    const { o } = await pointerToMissingVersion();
    const got = await settle(o.home.workflowStore.list());
    // (1) red when the listing skips the pointer (answers []); (2) prints the refusal's parts.
    expect(refusal(got.error)).toEqual(damagedPointerRefusal('wf'));
  });

  it("check 11d: the same database repaired by registering that workflow's text: the version is stored, get returns it, and the history's newest row names it", async () => {
    const { o, x } = await pointerToMissingVersion();
    await o.home.workflowStore.register(x);
    const rows = stored(o);
    // (1) red when a pointer that already names the hash is taken as nothing to write; (2) prints
    //     the definition read back and the newest history row's hash.
    expect({
      got: await o.home.workflowStore.get('wf'),
      newest: rows.registrations[rows.registrations.length - 1]?.['hash'],
    }).toEqual({ got: x, newest: hashOf(JSON.stringify(x)) });
  });

  it('check 11c: a current copy whose text is not JSON: get refuses with the damaged-pointer words', async () => {
    const o = await open();
    const c = await foreign(o);
    c.exec('DROP TRIGGER workflow_versions_insert_valid');
    foreignRegister(c, 'wf', '{"id": "wf", not json', readingAt(9));
    const got = await settle(o.home.workflowStore.get('wf'));
    // (1) red when JSON.parse's error leaves unwrapped; (2) prints the refusal's parts.
    expect(refusal(got.error)).toEqual(damagedPointerRefusal('wf'));
  });

  it('the leak cell (ported from the JSON registry): text near the fault never reaches the refusal, its details, its stack or its cause', async () => {
    const o = await open();
    const c = await foreign(o);
    c.exec('DROP TRIGGER workflow_versions_insert_valid');
    foreignRegister(c, 'wf', 'CANARY-B3-NOT-A-SECRET {', readingAt(9));
    const got = await settle(o.home.workflowStore.get('wf'));
    const e = got.error as Error & { details?: unknown; cause?: unknown };
    const cause = e.cause as Error | undefined;
    const surfaces = {
      message: e.message,
      details: JSON.stringify(e.details),
      stack: String(e.stack),
      cause: `${String(cause?.message)} ${String(cause?.stack)}`,
    };
    // (1) red when JSON.parse's error (which quotes the text around the fault) is kept as the
    //     refusal's cause; (2) prints only the names of the surfaces that carry the text.
    expect(
      Object.entries(surfaces)
        .filter(([, v]) => v.includes('CANARY'))
        .map(([k]) => k),
    ).toEqual([]);
  });

  it('check 11e: a version rewritten under its own hash: registering the true text is refused with the damaged-pointer words', async () => {
    const o = await open();
    const a = workflow('wf', ['a']);
    await o.home.workflowStore.register(a);
    const c = await foreign(o);
    c.exec('DROP TRIGGER workflow_versions_no_update');
    c.prepare('UPDATE workflow_versions SET definition = ? WHERE hash = ?').run(
      JSON.stringify({ ...a, description: 'rewritten' }),
      hashOf(JSON.stringify(a)),
    );
    const got = await settle(o.home.workflowStore.register(a));
    // (1) red when register resolves because a version row exists under the hash; (2) prints the
    //     refusal's parts.
    expect(refusal(got.error)).toEqual(damagedPointerRefusal('wf'));
  });
});

describe('#616 B3 — the guards bind a writer that is not Realm (a second connection, recursive_triggers off)', () => {
  /** A home where Realm registered `a` (two versions, A then A2, the pointer on A2) and `c`. */
  async function registered(): Promise<{
    o: Opened;
    c: DatabaseLike;
    hA: string;
    hA2: string;
    hC: string;
  }> {
    const o = await open();
    const a = workflow('a', ['s']);
    const a2 = workflow('a', ['t']);
    const cw = workflow('c', ['s']);
    await o.home.workflowStore.register(a);
    await o.home.workflowStore.register(a2);
    await o.home.workflowStore.register(cw);
    return {
      o,
      c: await foreign(o),
      hA: hashOf(JSON.stringify(a)),
      hA2: hashOf(JSON.stringify(a2)),
      hC: hashOf(JSON.stringify(cw)),
    };
  }

  const AT = '2026-11-07T10:00:00.000Z';
  const INSERT_VERSION =
    'INSERT INTO workflow_versions (hash, id, definition, first_registered_at) VALUES (?, ?, ?, ?)';
  const INSERT_REGISTRATION =
    'INSERT INTO workflow_registrations (id, seq, hash, registered_at) VALUES (?, ?, ?, ?)';

  /** Runs `act` and returns its outcome with whether anything stored changed. */
  function refusedAndUnchanged(
    o: Opened,
    act: () => string,
  ): { outcome: string; unchanged: boolean } {
    const before = stored(o);
    const outcome = act();
    return { outcome, unchanged: JSON.stringify(stored(o)) === JSON.stringify(before) };
  }

  it('4a, G1: a pointer inserted for a workflow whose version exists but has no history row', async () => {
    const { o, c } = await registered();
    const text = JSON.stringify(workflow('z', ['s']));
    c.prepare(INSERT_VERSION).run(hashOf(text), 'z', text, AT);
    // (1) red when G1's "newest registration" condition is dropped; (2) prints the outcome.
    expect(
      refusedAndUnchanged(o, () =>
        attempt(c, 'INSERT INTO workflows VALUES (?, ?, ?)', 'z', hashOf(text), AT),
      ),
    ).toEqual({ outcome: G.pointsOwn, unchanged: true });
  });

  it("4a', G1: a pointer inserted at another workflow's version, after a writer that removed G6 forged its history row", async () => {
    const { o, c, hC } = await registered();
    c.exec('DROP TRIGGER workflow_registrations_insert_own');
    c.prepare(INSERT_REGISTRATION).run('z', 0, hC, AT);
    // (1) red when G1's "its own version" condition is dropped on insert; (2) prints the outcome.
    expect(
      refusedAndUnchanged(o, () =>
        attempt(c, 'INSERT INTO workflows VALUES (?, ?, ?)', 'z', hC, AT),
      ),
    ).toEqual({ outcome: G.pointsOwn, unchanged: true });
  });

  it("4b, G1: a pointer moved to ANOTHER workflow's existing version", async () => {
    const { o, c, hC } = await registered();
    // (1) red when both conditions of G1's update arm are dropped (each alone is the next two
    //     cells'); (2) prints the outcome.
    expect(
      refusedAndUnchanged(o, () =>
        attempt(c, 'UPDATE workflows SET current_hash = ? WHERE id = ?', hC, 'a'),
      ),
    ).toEqual({ outcome: G.pointsOwn, unchanged: true });
  });

  it("4b', G1: the same move after a writer that removed G6 forged the history row", async () => {
    const { o, c, hC } = await registered();
    c.exec('DROP TRIGGER workflow_registrations_insert_own');
    c.prepare(INSERT_REGISTRATION).run('a', 2, hC, AT);
    // (1) red when G1's "its own version" condition is dropped on update; (2) prints the outcome.
    expect(
      refusedAndUnchanged(o, () =>
        attempt(c, 'UPDATE workflows SET current_hash = ? WHERE id = ?', hC, 'a'),
      ),
    ).toEqual({ outcome: G.pointsOwn, unchanged: true });
  });

  it('4r, G1: a pointer moved to its own earlier version with no new history row', async () => {
    const { o, c, hA } = await registered();
    // (1) red when G1's "newest registration" condition is dropped on update; (2) prints the outcome.
    expect(
      refusedAndUnchanged(o, () =>
        attempt(c, 'UPDATE workflows SET current_hash = ? WHERE id = ?', hA, 'a'),
      ),
    ).toEqual({ outcome: G.pointsOwn, unchanged: true });
  });

  it("4c, G2: UPDATE OR REPLACE that renames a to c and points it at c's text, which would erase c", async () => {
    const { o, c, hC } = await registered();
    // (1) red when G2 is dropped (the statement lands and c's pointer row is replaced); (2) prints
    //     the outcome.
    expect(
      refusedAndUnchanged(o, () =>
        attempt(
          c,
          'UPDATE OR REPLACE workflows SET id = ?, current_hash = ? WHERE id = ?',
          'c',
          hC,
          'a',
        ),
      ),
    ).toEqual({ outcome: G.idFixed, unchanged: true });
  });

  it('4d, G3: a pointer deleted', async () => {
    const { o, c } = await registered();
    // (1) red when G3 is dropped; (2) prints the outcome.
    expect(
      refusedAndUnchanged(o, () => attempt(c, 'DELETE FROM workflows WHERE id = ?', 'a')),
    ).toEqual({ outcome: G.noDelete, unchanged: true });
  });

  it.each([
    // [cell, the condition whose drop turns it red, the row's id, its definition]
    ['4e, not JSON', 'json_valid', 'z', '{"id": "z", not json'],
    ['4g, no $.id', 'the two `$.id` tests together', 'z', '{"name": "z"}'],
    ["4h, another workflow's $.id", '$.id IS the id', 'z', '{"id": "c"}'],
    [
      "4h', a $.id that is JSON, not text, equal to the row's id",
      '$.id is text',
      '["z"]',
      '{"id":["z"]}',
    ],
    [
      '4u, a repeated id key (SQLite reads the first, JSON.parse the last)',
      'the repeated-key count',
      'z',
      '{"id":"z","id":"c"}',
    ],
  ])(
    "G4: a version that is not its own workflow's JSON object — %s",
    async (_cell, _drop, id, definition) => {
      const { o, c } = await registered();
      const text = String(definition);
      // (1) red when that condition is dropped (the row lands, or SQLite's own "malformed JSON" is
      //     the refusal); (2) prints the outcome.
      expect(
        refusedAndUnchanged(o, () => attempt(c, INSERT_VERSION, hashOf(text), id, text, AT)),
      ).toEqual({ outcome: G.version, unchanged: true });
    },
  );

  it('4v, G4: a definition stored as a BLOB of valid JSON text', async () => {
    const { o, c } = await registered();
    const bytes = Buffer.from('{"id":"z"}');
    // (1) red when the "stored as text" condition is dropped; (2) prints the outcome.
    expect(
      refusedAndUnchanged(o, () => attempt(c, INSERT_VERSION, 'f'.repeat(64), 'z', bytes, AT)),
    ).toEqual({ outcome: G.version, unchanged: true });
  });

  it("4m, G4: a connection that set ignore_check_constraints = 1 still cannot store another workflow's $.id", async () => {
    const { o, c } = await registered();
    c.exec('PRAGMA ignore_check_constraints = 1');
    const text = '{"id": "c"}';
    // (1) red when G4 is written as a CHECK only; (2) prints the outcome.
    expect(
      refusedAndUnchanged(o, () => attempt(c, INSERT_VERSION, hashOf(text), 'z', text, AT)),
    ).toEqual({ outcome: G.version, unchanged: true });
  });

  it('4i, G5: INSERT OR REPLACE of an existing hash with other text', async () => {
    const { o, c, hA } = await registered();
    // (1) red when G5's "the hash exists" condition is dropped; (2) prints the outcome.
    expect(
      refusedAndUnchanged(o, () =>
        attempt(
          c,
          'INSERT OR REPLACE INTO workflow_versions (hash, id, definition, first_registered_at) VALUES (?, ?, ?, ?)',
          hA,
          'a',
          '{"id": "a", "steps": {}}',
          AT,
        ),
      ),
    ).toEqual({ outcome: G.versionFixed, unchanged: true });
  });

  it('4j, G5: a version updated', async () => {
    const { o, c, hA } = await registered();
    // (1) red when G5's update guard is dropped; (2) prints the outcome.
    expect(
      refusedAndUnchanged(o, () =>
        attempt(c, 'UPDATE workflow_versions SET definition = ? WHERE hash = ?', '{"id": "a"}', hA),
      ),
    ).toEqual({ outcome: G.versionFixed, unchanged: true });
  });

  it('4k, G5: a version deleted', async () => {
    const { o, c, hA } = await registered();
    // (1) red when G5's delete guard is dropped; (2) prints the outcome.
    expect(
      refusedAndUnchanged(o, () => attempt(c, 'DELETE FROM workflow_versions WHERE hash = ?', hA)),
    ).toEqual({ outcome: G.versionFixed, unchanged: true });
  });

  it("4s, G5: INSERT OR REPLACE aimed at an existing version's row number, with another hash", async () => {
    const { o, c, hA } = await registered();
    const rowid = (
      c.prepare('SELECT rowid AS r FROM workflow_versions WHERE hash = ?').get(hA) as { r: number }
    ).r;
    const text = JSON.stringify(workflow('a', ['u']));
    // (1) red when G5's row-number condition is dropped (A's version row is deleted by the REPLACE,
    //     with no delete guard fired); (2) prints the outcome.
    expect(
      refusedAndUnchanged(o, () =>
        attempt(
          c,
          'INSERT OR REPLACE INTO workflow_versions (rowid, hash, id, definition, first_registered_at) VALUES (?, ?, ?, ?, ?)',
          rowid,
          hashOf(text),
          'a',
          text,
          AT,
        ),
      ),
    ).toEqual({ outcome: G.versionFixed, unchanged: true });
  });

  it("4t, G8: a version planted at row number -1 is refused, and Realm's next register still lands", async () => {
    const { o, c } = await registered();
    const text = JSON.stringify(workflow('z', ['s']));
    const planted = attempt(
      c,
      'INSERT INTO workflow_versions (rowid, hash, id, definition, first_registered_at) VALUES (-1, ?, ?, ?, ?)',
      hashOf(text),
      'z',
      text,
      AT,
    );
    const next = await settle(o.home.workflowStore.register(workflow('y', ['s'])));
    // (1) red when G8 is dropped (the row at -1 lands, and the row-number guard then refuses every
    //     later version insert); (2) prints the planting's outcome and what the next register gave.
    expect({ planted, next: next.error === undefined ? 'landed' : String(next.error) }).toEqual({
      planted: G.rowNumber,
      next: 'landed',
    });
  });

  it("4n, G6: a history row naming another workflow's version", async () => {
    const { o, c, hC } = await registered();
    // (1) red when G6's "its own version" condition is dropped; (2) prints the outcome.
    expect(refusedAndUnchanged(o, () => attempt(c, INSERT_REGISTRATION, 'a', 2, hC, AT))).toEqual({
      outcome: G.registration,
      unchanged: true,
    });
  });

  it('4o, G6: INSERT OR REPLACE of an existing history row', async () => {
    const { o, c, hA2 } = await registered();
    // (1) red when G6's "next number" condition is dropped (row 0 is rewritten); (2) prints the
    //     outcome.
    expect(
      refusedAndUnchanged(o, () =>
        attempt(
          c,
          'INSERT OR REPLACE INTO workflow_registrations (id, seq, hash, registered_at) VALUES (?, ?, ?, ?)',
          'a',
          0,
          hA2,
          AT,
        ),
      ),
    ).toEqual({ outcome: G.registration, unchanged: true });
  });

  it('4p, G7: a history row updated', async () => {
    const { o, c, hA2 } = await registered();
    // (1) red when G7's update guard is dropped; (2) prints the outcome.
    expect(
      refusedAndUnchanged(o, () =>
        attempt(c, 'UPDATE workflow_registrations SET hash = ? WHERE id = ? AND seq = 0', hA2, 'a'),
      ),
    ).toEqual({ outcome: G.history, unchanged: true });
  });

  it('4q, G7: a history row deleted', async () => {
    const { o, c } = await registered();
    // (1) red when G7's delete guard is dropped; (2) prints the outcome.
    expect(
      refusedAndUnchanged(o, () =>
        attempt(c, 'DELETE FROM workflow_registrations WHERE id = ? AND seq = 0', 'a'),
      ),
    ).toEqual({ outcome: G.history, unchanged: true });
  });
});
