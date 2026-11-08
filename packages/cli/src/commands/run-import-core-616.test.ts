// run-import-core-616.test.ts — issue #616 PR-2c, unit c11a: the importer's core, one file in, one of
// six words out. The real cases: an operator moving a JSON store's `runs/` folder, which holds bare
// run records (current ones, finished ones whose stored phase went stale, the old `state` shape,
// stubs, files that are not runs), and export bundles of every version Realm wrote, masked as an
// export is; the same runs imported twice; a run that diverged from the stored one, at another
// version, with other content, or under a key a live run holds; a run deleted on purpose; a store
// that fails under the import; and a file whose strings try to forge a line. Every cell imports into
// a REAL scratch store (`openRealmHome` in a temp folder); `save()` is stubbed only for the store-wide
// errors, which a scratch store cannot be made to raise on demand.
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails: the
// file's line, never a record's content.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildDisclosureSet,
  WorkflowError,
  type Clock,
  type ErrorCode,
  type RunRecord,
} from '@sensigo/realm';
import { openRealmHome, type RealmHome } from '@sensigo/realm-store-sqlite';
import { InMemoryStore } from '@sensigo/realm-testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildExportBundle } from './export.js';
import { importFile, importLine } from './run-import-core.js';

const AS_ROOT = process.getuid?.() === 0;
if (AS_ROOT) {
  console.warn(
    '#616 PR-2c c11a: the cell of a file Realm may not read is skipped: root reads any file.',
  );
}

const CREATED = '2026-11-01T10:00:00.000Z';
const UPDATED = '2026-11-01T10:10:00.000Z';
/** The home's clock: a run deleted through it is deleted on 2026-10-30. */
const OCT_30: Clock = {
  now: () => new Date('2026-10-30T09:15:00.000Z'),
  at: () => () => undefined,
};
/** A declared secret, in the fake form the suite's other disclosure cells use. */
const DECLARED = 'FAKE-DECLARED-c11a';

const roots: string[] = [];
const homes: RealmHome[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const home of homes.splice(0)) home.close();
  for (const root of roots.splice(0)) {
    try {
      chmodSync(join(root, 'runs'), 0o700);
    } catch {
      // no runs folder
    }
    rmSync(root, { recursive: true, force: true });
  }
});

/** A scratch folder with a `runs/` folder for the files, and a real store home opened in it. */
async function scratch(clock?: Clock): Promise<{ root: string; home: RealmHome }> {
  const root = mkdtempSync(join(tmpdir(), 'realm-616-c11a-'));
  roots.push(root);
  mkdirSync(join(root, 'runs'));
  const home = await openRealmHome({ home: join(root, '.realm'), ...(clock ? { clock } : {}) });
  homes.push(home);
  return { root, home };
}

/** Writes a file under `<root>/runs/`: text as it is, anything else as pretty JSON. */
function file(root: string, name: string, content: unknown): string {
  const path = join(root, 'runs', name);
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  return path;
}

/** A live run another store exported, in the record's own shape, with `extra` laid over. */
function record(extra: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'run-1',
    workflow_id: 'wf-import',
    workflow_version: 1,
    completed_steps: [],
    in_progress_steps: [],
    failed_steps: [],
    skipped_steps: [],
    run_phase: 'running',
    version: 3,
    params: { ticket: 'T-1' },
    evidence: [],
    created_at: CREATED,
    updated_at: UPDATED,
    terminal_state: false,
    ...extra,
  };
}

/** The same run finished: its one step done, sealed by completion, its phase `completed`. */
function finished(extra: Partial<RunRecord> = {}): RunRecord {
  return record({
    completed_steps: ['a'],
    run_phase: 'completed',
    version: 4,
    terminal_state: true,
    terminal_reason: 'All steps completed',
    sealed_by: { arm: 'complete', step: 'a' },
    ...extra,
  });
}

/** A file's result as its line, or the stop's kind and code. */
async function lineOf(path: string, home: RealmHome): Promise<string> {
  const result = await importFile(path, home);
  if (result.kind === 'word') return importLine(result);
  return `STOP ${result.stop}: ${(result.error as { code?: string }).code ?? String(result.error)}`;
}

/**
 * An export bundle `realm run export` writes for `run`, built by its own `buildExportBundle` over an
 * in-memory store seeded with the run, masked for the file audience with `DECLARED` declared, and
 * carrying `wal`, `attempts` and `sealed` from stubs of the two artifact stores.
 */
async function bundleOf(
  run: RunRecord,
  carried: {
    wal?: Record<string, unknown[]>;
    attempts?: number;
    sealed?: boolean;
  } = {},
): Promise<Record<string, unknown>> {
  const store = new InMemoryStore();
  store.seed(run);
  const attempt = {
    run_id: run.id,
    workflow_id: run.workflow_id,
    step_id: 'a',
    ts: CREATED,
    error_code: 'VALIDATION_FAILED',
    validation_error_summary: [],
    submitted_key_count: 0,
    submitted_keys: [],
    submitted_bytes: 0,
    trace_entry_count: 0,
  };
  const { bundle } = await buildExportBundle(
    run.id,
    {
      runStore: store,
      failedAttemptStore: {
        read: async () => ({
          records: Array.from({ length: carried.attempts ?? 0 }, () => attempt),
          capped: false,
        }),
      },
      traceBufferStore: {
        readAllForRun: async () => carried.wal ?? {},
        listSealedForRun: async () =>
          carried.sealed === true
            ? [{ step_id: 'a', seq: 1, lines: [{ ts: 1, entries: [] }] }]
            : [],
      },
    },
    new Date(UPDATED),
    buildDisclosureSet({
      env: {},
      declared: { S: DECLARED },
      declaredState: 'resolved',
      audience: 'file',
    }).set,
  );
  return bundle as unknown as Record<string, unknown>;
}

/** Two write-ahead log lines of step `a`, as the trace buffer keeps them. */
const TWO_WAL_LINES = {
  a: [
    { ts: 1, entries: [] },
    { ts: 2, entries: [] },
  ],
};

describe('#616 PR-2c c11a — check 1: the classification of a file, through to the real store', () => {
  const rows: ReadonlyArray<readonly [string, string, unknown, (p: string) => string]> = [
    ['not JSON', 'e.json', '{ "id": ', (p) => `not_a_run  ${p}: not JSON`],
    ['an empty file', 'empty.json', '', (p) => `not_a_run  ${p}: not JSON`],
    ['an array', 'array.json', '[]', (p) => `not_a_run  ${p}: not a run: it is not an object`],
    [
      'an empty object',
      'empty-object.json',
      '{}',
      (p) => `not_a_run  ${p}: neither a run record nor an export (it has no id)`,
    ],
    ['a string', 'string.json', '"x"', (p) => `not_a_run  ${p}: not a run: it is not an object`],
    [
      'an object with no id',
      'no-id.json',
      { workflow_id: 'wf-import', run_phase: 'running' },
      (p) => `not_a_run  ${p}: neither a run record nor an export (it has no id)`,
    ],
    [
      'the old state shape with a string id',
      'old-shape.json',
      {
        id: 'run-old',
        workflow_id: 'wf-import',
        workflow_version: 1,
        state: 'completed',
        created_at: CREATED,
        updated_at: UPDATED,
      },
      (p) => `legacy  ${p}: not in the current run format`,
    ],
    [
      'an object with a string id and a bad created_at',
      'bad-created.json',
      { id: 'run-y', created_at: 'yesterday' },
      (p) => `legacy  ${p}: not in the current run format`,
    ],
    [
      'a version-3 bundle',
      'v3.json',
      { realm_export_version: 3, run: record({ id: 'run-v3' }) },
      (p) =>
        `legacy  ${p}: an export of version 3, older than the versions this Realm reads (4 and 5)`,
    ],
    [
      'a version-3 bundle with no run (the version comes first)',
      'v3-no-run.json',
      { realm_export_version: 3 },
      (p) =>
        `legacy  ${p}: an export of version 3, older than the versions this Realm reads (4 and 5)`,
    ],
    [
      'a version-4 bundle (run only)',
      'v4.json',
      { realm_export_version: 4, run: record({ id: 'run-v4' }) },
      (p) => `imported  ${p}`,
    ],
    [
      'a version-5 bundle',
      'v5.json',
      {
        realm_export_version: 5,
        run: record({ id: 'run-v5' }),
        attempts: [],
        wal: {},
        sealed: null,
        disclosure: { hidden: { declared: 0, environment: 0, pattern: 0 } },
      },
      (p) => `imported  ${p}`,
    ],
    [
      'a version-6 bundle',
      'v6.json',
      { realm_export_version: 6, run: record({ id: 'run-v6' }) },
      (p) =>
        `not_a_run  ${p}: an export of version 6, written by a later Realm (this one reads 4 and 5)`,
    ],
    [
      'a bundle without a run',
      'no-run.json',
      { realm_export_version: 5 },
      (p) => `not_a_run  ${p}: an export without a run`,
    ],
    [
      'a bundle whose run has no id',
      'run-no-id.json',
      { realm_export_version: 5, run: { workflow_id: 'wf-import' } },
      (p) => `not_a_run  ${p}: an export whose run has no id`,
    ],
    [
      'a version-6 bundle with values hidden (no note on a not_a_run line)',
      'v6-hidden.json',
      {
        realm_export_version: 6,
        run: record({ id: 'run-v6h' }),
        disclosure: { hidden: { declared: 2, environment: 0, pattern: 0 } },
      },
      (p) =>
        `not_a_run  ${p}: an export of version 6, written by a later Realm (this one reads 4 and 5)`,
    ],
    [
      'a bundle without a run, with values hidden',
      'no-run-hidden.json',
      {
        realm_export_version: 5,
        disclosure: { hidden: { declared: 1, environment: 0, pattern: 0 } },
      },
      (p) => `not_a_run  ${p}: an export without a run`,
    ],
  ];

  it.each(rows)('%s', async (_, name, content, expected) => {
    const { root, home } = await scratch();
    const path = file(root, name, content);
    // (1) red when a file is classified by save()'s code alone (`{}` and the no-id rows read
    //     `legacy`), when the version test is `<=` (the version-4 row reads legacy) or comes after the
    //     run test (the version-3 bundle with no run reads "an export without a run"), or when a
    //     not_a_run line carries the hidden note; (2) prints the line got and the line expected.
    expect(await lineOf(path, home)).toBe(expected(path));
  });

  it.skipIf(AS_ROOT)(
    'an unreadable file is not_a_run, in the system’s words (skipped as root: root reads any file)',
    async () => {
      const { root, home } = await scratch();
      const path = file(root, 'locked.json', record({ id: 'run-locked' }));
      chmodSync(path, 0o000);
      // (1) red when a read failure escapes as an error or another word; (2) prints the line.
      expect(await lineOf(path, home)).toBe(
        `not_a_run  ${path}: cannot be read: permission denied`,
      );
    },
  );
});

describe('#616 PR-2c c11a — check 2: what save() answers, mapped to a word, on the real store', () => {
  // The old shape with an id (`legacy`) and without one (`not_a_run`) are check 1's rows "the old
  // state shape with a string id" and "an object with no id" (the same files and lines, written once:
  // TESTING-RULES rule 5; MA 3, 2026-11-08).
  const rows: ReadonlyArray<
    readonly [string, string, readonly RunRecord[], RunRecord, (p: string) => string]
  > = [
    ['an unseen record', 'a.json', [], record({ id: 'run-a' }), (p) => `imported  ${p}`],
    [
      'the same record again',
      'a-again.json',
      [record({ id: 'run-a' })],
      record({ id: 'run-a' }),
      (p) => `unchanged  ${p}`,
    ],
    [
      'the same id, newer in the file (stored 3, file 4)',
      'newer.json',
      [record({ id: 'run-c', version: 3 })],
      record({ id: 'run-c', version: 4, completed_steps: ['a'] }),
      (p) => `diverged  ${p}: the stored run is at version 3; the file is at version 4`,
    ],
    [
      'the same id, older in the file (stored 4, file 3)',
      'older.json',
      [record({ id: 'run-c', version: 4, completed_steps: ['a'] })],
      record({ id: 'run-c', version: 3 }),
      (p) => `diverged  ${p}: the stored run is at version 4; the file is at version 3`,
    ],
    [
      'the same version with other content',
      'content.json',
      [record({ id: 'run-e' })],
      record({ id: 'run-e', params: { ticket: 'T-2' } }),
      (p) => `diverged  ${p}: the stored run has this version and other content`,
    ],
    [
      'a live record whose key a different live run holds',
      'key.json',
      [record({ id: 'run-holder', idempotency_key: 'order-7' })],
      record({ id: 'run-k', idempotency_key: 'order-7' }),
      (p) => `diverged  ${p}: the live run run-holder already holds this run's idempotency key`,
    ],
    [
      'a record with a bad timestamp and a string id',
      'bad-timestamp.json',
      [],
      record({ id: 'run-t', created_at: 'yesterday' }),
      (p) => `legacy  ${p}: created_at is not in the current time format`,
    ],
  ];

  it.each(rows)('%s', async (_, name, stored, given, expected) => {
    const { root, home } = await scratch();
    for (const run of stored) await home.runStore.save(run);
    const path = file(root, name, given);
    // (1) red when DIVERGED is mapped to `unchanged`, when the version arm is decided by `<` (the
    //     older-file row reads as the content arm), or when an arm's sentence is another's; (2)
    //     prints the line got and the line expected.
    expect(await lineOf(path, home)).toBe(expected(path));
  });

  it('a run deleted on purpose, saved again, is purged with the day it was deleted', async () => {
    const { root, home } = await scratch(OCT_30);
    await home.runStore.save(finished({ id: 'run-d' }));
    await home.runStore.deleteAllForRun('run-d');
    const path = file(root, 'd.json', finished({ id: 'run-d' }));
    // (1) red when the day is the whole instant, or PURGED maps to another word; (2) prints the line.
    expect(await lineOf(path, home)).toBe(`purged  ${path}: this run was deleted on 2026-10-30`);
  });
});

describe('#616 PR-2c c11a — check 3: a store-wide or unexpected failure is a STOP, never a word', () => {
  const store = (code: ErrorCode): Error =>
    new WorkflowError(`the store refused (${code})`, {
      code,
      category: 'STATE',
      agentAction: 'report_to_user',
      retryable: false,
    });
  const rows: ReadonlyArray<readonly [string, () => Error, 'store' | 'unexpected']> = [
    ['STATE_RUN_BUSY', () => store('STATE_RUN_BUSY'), 'store'],
    ['STATE_STORE_WRITES_FENCED', () => store('STATE_STORE_WRITES_FENCED'), 'store'],
    ['STATE_STORE_FULL', () => store('STATE_STORE_FULL'), 'store'],
    ['STATE_STORE_READONLY', () => store('STATE_STORE_READONLY'), 'store'],
    ['STATE_STORE_VERSION_NEWER', () => store('STATE_STORE_VERSION_NEWER'), 'store'],
    [
      "save()'s untyped TypeError (a non-text idempotency key)",
      () =>
        Object.assign(new TypeError('The "data" argument must be of type string.'), {
          code: 'ERR_INVALID_ARG_TYPE',
        }),
      'unexpected',
    ],
    [
      'a plain Error',
      () => new Error('does not read back as the record it was given'),
      'unexpected',
    ],
  ];

  it.each(rows)('%s', async (_, make, kind) => {
    const { root, home } = await scratch();
    const error = make();
    vi.spyOn(home.runStore, 'save').mockRejectedValueOnce(error);
    const result = await importFile(file(root, 's.json', record({ id: 'run-s' })), home);
    // (1) red when a store code is mapped to a word (`not_a_run`), when the kind is another, or when
    //     the error is not the one save() threw; (2) prints the result's kind, the stop's kind and
    //     whether the error is the one thrown (never the error's content).
    expect({
      kind: result.kind,
      stop: result.kind === 'stop' ? result.stop : 'no stop',
      theError: result.kind === 'stop' && result.error === error,
    }).toEqual({ kind: 'stop', stop: kind, theError: true });
  });
});

describe('#616 PR-2c c11a — check 4: the notes', () => {
  it('a finished record whose stored phase is stale imports with the re-derived phase noted; a current one has no note', async () => {
    const { root, home } = await scratch();
    const stale = file(root, 'stale.json', finished({ id: 'run-stale', run_phase: 'running' }));
    const current = file(root, 'current.json', finished({ id: 'run-current' }));
    // (1) red when the note is not minted, or minted for a current record; (2) prints both lines.
    expect([await lineOf(stale, home), await lineOf(current, home)]).toEqual([
      `imported  ${stale}  [run_phase re-derived: running → completed]`,
      `imported  ${current}`,
    ]);
  });

  it('a bundle of a finished run with a stale phase and two values hidden imports with both notes, in order', async () => {
    const { root, home } = await scratch();
    const run = finished({ id: 'run-b', params: { ticket: DECLARED, note: DECLARED } });
    const bundle = await bundleOf(run);
    // The run as an old export of a stale record carries it: its phase as it was stored.
    const path = file(root, 'b.json', {
      ...bundle,
      run: { ...(bundle['run'] as object), run_phase: 'running' },
    });
    // (1) red when the notes change order, or the hidden note is missing; (2) prints the line.
    expect(await lineOf(path, home)).toBe(
      `imported  ${path}  [run_phase re-derived: running → completed; exported with 2 values hidden]`,
    );
  });

  it('the same bundle over its run already stored unmasked is diverged, with the longer hidden note and none of the not-imported notes; the masked run as a bare file is diverged with no note', async () => {
    const { root, home } = await scratch();
    const run = record({ id: 'run-masked', params: { ticket: DECLARED, note: DECLARED } });
    await home.runStore.save(run);
    const bundle = await bundleOf(run, { wal: { a: [{ ts: 1, entries: [] }] } });
    const inBundle = file(root, 'c.json', bundle);
    const bare = file(root, 'c-bare.json', bundle['run']);
    // (1) red when the content arm has the short hidden note, when a not-imported note is on a
    //     diverged line (the note on every line), or when a bare record gets a hidden note; (2) prints
    //     both lines.
    expect([await lineOf(inBundle, home), await lineOf(bare, home)]).toEqual([
      `diverged  ${inBundle}: the stored run has this version and other content  [exported with 2 values hidden, so it may differ from the stored run]`,
      `diverged  ${bare}: the stored run has this version and other content`,
    ]);
  });

  it('a bundle carrying a write-ahead log, failed attempts and sealed artifacts notes the three, in order; one line is "1 line"; none when they are empty', async () => {
    const { root, home } = await scratch();
    const carrying = file(
      root,
      'carrying.realm.json',
      await bundleOf(record({ id: 'run-w' }), { wal: TWO_WAL_LINES, attempts: 3, sealed: true }),
    );
    const one = record({ id: 'run-f' });
    await home.runStore.save(one);
    const oneLine = file(
      root,
      'f.realm.json',
      await bundleOf(one, { wal: { a: [{ ts: 1, entries: [] }] } }),
    );
    const empty = file(root, 'empty.realm.json', await bundleOf(record({ id: 'run-n' })));
    // (1) red when the order changes, when "1 line" is "1 lines", or when an empty one is noted;
    //     (2) prints the three lines.
    expect([
      await lineOf(carrying, home),
      await lineOf(oneLine, home),
      await lineOf(empty, home),
    ]).toEqual([
      `imported  ${carrying}  [wal_not_imported: 2 lines; attempts_not_imported: 3 lines; sealed_not_imported]`,
      `unchanged  ${oneLine}  [wal_not_imported: 1 line]`,
      `imported  ${empty}`,
    ]);
  });
});

describe('#616 PR-2c c11a — check 5: a file cannot forge a line', () => {
  it('a run phase, a file name and a holder id holding a newline and an escape are printed escaped, one line each', async () => {
    const { root, home } = await scratch();
    const phase = file(
      root,
      'phase.json',
      record({
        id: 'run-p',
        run_phase: 'x\nimported  /v/ok.json\u001b[31m' as RunRecord['run_phase'],
      }),
    );
    const named = file(root, 'a\nimported  b.json', record({ id: 'run-n' }));
    await home.runStore.save(record({ id: 'holder\nimported  x', idempotency_key: 'order-9' }));
    const keyed = file(root, 'keyed.json', record({ id: 'run-q', idempotency_key: 'order-9' }));
    const lines = [await lineOf(phase, home), await lineOf(named, home), await lineOf(keyed, home)];
    // (1) red when a value is printed raw (a line holds a newline or an escape character, or the
    //     escaped form differs); (2) prints the three lines as JSON strings, so a raw newline shows.
    expect(lines.map((line) => JSON.stringify(line))).toEqual(
      [
        `imported  ${phase}  [run_phase re-derived: x\\nimported  /v/ok.json\\u001b[31m → running]`,
        `imported  ${join(root, 'runs')}/a\\nimported  b.json`,
        `diverged  ${keyed}: the live run holder\\nimported  x already holds this run's idempotency key`,
      ].map((line) => JSON.stringify(line)),
    );
    expect(lines.filter((line) => line.includes('\n') || line.includes('\u001b'))).toEqual([]);
  });
});
