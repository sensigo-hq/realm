// run-rows-616.test.ts — issue #616 PR-1a unit 10: a run record written as the store's rows and read
// back. The real cases: every run the engine saves goes through this split, and every `get()`, settle
// and fence reads it back; real records hold their split keys in the MIDDLE (on this machine's 2,660
// stored runs: `run_phase` 8th, `evidence` 11th, `workflow_context_snapshots` 16th of 21 keys), so a
// read that moves them changes the record; a stored phase can disagree with the derivation (an older
// Realm, or a re-stamp not yet run); a record too deep or too long must be refused before anything is
// written; a writer that is not Realm (a SQLite shell) can drop a guard and delete a row; and PR-1b's
// fence adapter puts runs from a second connection.
//
// Every cell works on a real home through the store's own open. Each assertion carries (1) the break
// that turns it red and (2) what it prints when it fails.
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deriveRunPhase,
  WorkflowError,
  type Clock,
  type EvidenceSnapshot,
  type RunRecord,
} from '@sensigo/realm';
import { afterEach, describe, expect, it } from 'vitest';
import { RealmDb } from './connection.js';
import type { DatabaseLike } from './driver.js';
import {
  assertRunRecordWithinLimits,
  insertRunRecord,
  readRunInTransaction,
  RUN_RECORD_MAX_BYTES,
} from './run-rows.js';
import { openForeignConnection } from './test-support/foreign-connection.js';

const AT = '2026-11-06T09:00:00.000Z';
const clock: Clock = { now: () => new Date(AT), at: () => () => undefined };

const dirs: string[] = [];
const closers: Array<{ close(): void }> = [];
afterEach(() => {
  for (const c of closers.splice(0)) {
    try {
      c.close();
    } catch {
      // closed by its cell
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A fresh Realm home, opened by the store's own open. */
async function store(): Promise<{ home: string; db: RealmDb }> {
  const dir = mkdtempSync(join(tmpdir(), 'realm-616-u10-'));
  dirs.push(dir);
  const home = join(dir, '.realm');
  const db = await RealmDb.open(home, { clock });
  closers.push(db);
  return { home, db };
}

async function foreign(home: string): Promise<DatabaseLike> {
  const c = await openForeignConnection(home);
  closers.push(c);
  return c;
}

/** Writes a record as the store will: inside its own `BEGIN IMMEDIATE`. */
function put(db: RealmDb, record: RunRecord): Promise<void> {
  return db.immediate(
    (c) => insertRunRecord(c, record),
    () => true,
  );
}

/** Reads a run as `get()` will: inside a snapshot. */
function read(db: RealmDb, runId: string): Promise<RunRecord | null> {
  return db.snapshot((c) => readRunInTransaction(c, runId));
}

/** What a call threw: a typed refusal's facts, or a plain error's message. */
function thrown(call: () => unknown): unknown {
  try {
    call();
    return 'no error';
  } catch (err) {
    if (err instanceof WorkflowError) {
      return { code: err.code, message: err.message, details: err.details };
    }
    return { message: (err as Error).message };
  }
}

async function thrownAsync(call: () => Promise<unknown>): Promise<unknown> {
  try {
    await call();
    return 'no error';
  } catch (err) {
    return { message: (err as Error).message };
  }
}

/** An evidence entry with the keys a real one carries, in their order. */
function entry(i: number, extra: Record<string, unknown> = {}): EvidenceSnapshot {
  return {
    step_id: `step_${i % 4}`,
    started_at: '2026-11-06T09:00:00.000Z',
    completed_at: '2026-11-06T09:00:01.250Z',
    duration_ms: 1250,
    input_summary: { pages: i },
    output_summary: { verdict: i % 2 === 0 ? 'ok' : 'review' },
    status: 'success',
    evidence_hash: createHash('sha256').update(`entry ${i}`).digest('hex'),
    diagnostics: {},
    resolved_params: { lang: 'en' },
    effective_timeout_seconds: 300,
    attempt: 1,
    ...extra,
  } as unknown as EvidenceSnapshot;
}

/** The workflow context snapshot field, as the execution loop writes it once. */
const CONTEXT = {
  playbook: {
    source_path: '/home/op/realm/playbook.md',
    content: '# Playbook\n\nAnswer in the customer’s language.',
    content_hash: createHash('sha256').update('playbook').digest('hex'),
    loaded_at: '2026-11-06T08:59:59.000Z',
  },
};

/**
 * A run record in the real key order (split keys in the middle), its phase what the derivation says.
 * `fields` are set in place where the record has them and appended after the rest otherwise.
 */
function run(id: string, fields: Record<string, unknown> = {}): RunRecord {
  const record: Record<string, unknown> = {
    id,
    workflow_id: 'support-reply',
    workflow_version: 3,
    completed_steps: ['classify'],
    in_progress_steps: [],
    failed_steps: [],
    skipped_steps: [],
    run_phase: 'running',
    version: 4,
    params: { ticket: 'T-1042', locale: 'de' },
    evidence: [entry(0), entry(1)],
    created_at: '2026-11-06T09:00:00.000Z',
    updated_at: '2026-11-06T09:00:05.000Z',
    terminal_state: false,
    claims: {},
    workflow_context_snapshots: CONTEXT,
    extension_identity: [],
    skip_details: {},
  };
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) delete record[key];
    else record[key] = value;
  }
  record['run_phase'] = deriveRunPhase(record as unknown as RunRecord);
  return record as unknown as RunRecord;
}

/** A record with the same fields in another key order: `first` keys first, then the rest. */
function reordered(record: RunRecord, first: string[], last: string[] = []): RunRecord {
  const source = record as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of first) out[key] = source[key];
  for (const key of Object.keys(source)) {
    if (!first.includes(key) && !last.includes(key)) out[key] = source[key];
  }
  for (const key of last) out[key] = source[key];
  return out as unknown as RunRecord;
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

describe('#616 unit 10 — a run record as rows', () => {
  // ---- check 1: the round trip keeps every value and the key order ----
  const ROUND_TRIP: Array<[string, () => RunRecord]> = [
    [
      'no evidence, no write-once field, no key',
      () => run('r-empty', { evidence: [], workflow_context_snapshots: undefined }),
    ],
    [
      'split keys not last (the real order): many entries, the write-once field and a key',
      () =>
        run('r-real', {
          evidence: Array.from({ length: 40 }, (_, i) => entry(i)),
          idempotency_key: 'ticket-T-1042',
        }),
    ],
    [
      'split keys last',
      () => reordered(run('r-last'), [], ['run_phase', 'evidence', 'workflow_context_snapshots']),
    ],
    [
      'split keys first',
      () => reordered(run('r-first'), ['evidence', 'workflow_context_snapshots', 'run_phase']),
    ],
    [
      'a gate waiting and claims with and without a deadline (what the fences read)',
      () =>
        run('r-gate', {
          in_progress_steps: ['review'],
          claims: {
            review: { deadline: '2026-11-06T09:30:00.000Z', token: 'tok-1', since: AT },
            draft: { deadline: null },
          },
          pending_gate: {
            gate_id: 'g-1',
            step_name: 'review',
            preview: { reply: 'Hallo!' },
            choices: ['approve', 'reject'],
            opened_at: AT,
          },
        }),
    ],
  ];

  it.each(ROUND_TRIP)('check 1 — round trip: %s', async (_name, make) => {
    const { db } = await store();
    const record = make();
    await put(db, record);
    const back = await read(db, record.id);
    // (1) red when the read appends the split keys after the rest (the "split keys not last" and
    //     "split keys first" rows), drops or adds a field, or loses a value; (2) prints the two
    //     records' key lists and, on a value difference, vitest's diff of the records.
    expect(Object.keys(back ?? {})).toEqual(Object.keys(record));
    expect(back).toEqual(record);
    // (1) red on any difference in text, key order included; (2) prints both texts.
    expect(JSON.stringify(back)).toBe(JSON.stringify(record));
  });

  it('check 1 — an id with no run reads as null', async () => {
    const { db } = await store();
    // (1) red when an absent run throws or returns a record; (2) prints what came back.
    expect(await read(db, 'r-none')).toBeNull();
  });

  // ---- check 2: the phase is derived on every read, never the column ----
  it('check 2 — a stored phase column that disagrees with the record is not what the read returns', async () => {
    const { db } = await store();
    const record = run('r-phase', {
      completed_steps: ['classify', 'draft'],
      terminal_state: true,
      terminal_reason: 'completed',
    });
    await put(db, record);
    // A stale index: plain SQL sets the column (no guard watches it; the re-stamp writes it the same way).
    await db.immediate(
      (c) => {
        c.prepare("UPDATE runs SET run_phase = 'gate_waiting' WHERE id = ?").run(record.id);
      },
      () => true,
    );
    const column = await db.snapshot(
      (c) => c.prepare('SELECT run_phase FROM runs WHERE id = ?').get(record.id)?.['run_phase'],
    );
    const back = await read(db, record.id);
    // (1) red when the read returns the stored column ('gate_waiting') instead of the derivation's
    //     answer; also when the cell's own UPDATE did not land; (2) prints the column and both phases.
    expect({ column, phase: back?.run_phase }).toEqual({
      column: 'gate_waiting',
      phase: deriveRunPhase(record),
    });
  });

  // ---- check 3: each entry's hash is of its stored text ----
  it('check 3 — every evidence row holds the sha256 of its own stored text (keys out of order, non-ASCII)', async () => {
    const { home, db } = await store();
    const entries = [
      { zeta: 1, alpha: { y: 2, b: 3 }, step_id: 'classify' },
      entry(1, { output_summary: { reply: 'Grüße aus Köln — 東京 🎉' } }),
      { été: 'naïve', a: [3, 1, 2] },
    ] as unknown as EvidenceSnapshot[];
    await put(db, run('r-hash', { evidence: entries }));
    const rows = (await foreign(home))
      .prepare('SELECT seq, entry, entry_sha256 FROM evidence WHERE run_id = ? ORDER BY seq')
      .all('r-hash');
    // (1) red when the stored text is not the entry's compact JSON in its own key order, or the hash
    //     is of another form (the key-sorted or the indented text); (2) prints each row's seq, text
    //     and both hashes.
    expect(rows.map((r) => ({ seq: r['seq'], entry: r['entry'], sha: r['entry_sha256'] }))).toEqual(
      entries.map((e, seq) => ({ seq, entry: JSON.stringify(e), sha: sha256(JSON.stringify(e)) })),
    );
  });

  // ---- check 4: the key's hash ----
  it("check 4 — the key's hash: one per workflow and key, the separator keeps pairs apart, no key is NULL and an empty key is a key", async () => {
    const { home, db } = await store();
    const cases: Array<[string, string, string | null | undefined]> = [
      ['k-a', 'support-reply', 'ticket-1'],
      ['k-a-again', 'support-reply', 'ticket-1'],
      ['k-other-workflow', 'refund-check', 'ticket-1'],
      ['k-ab-c', 'ab', 'c'],
      ['k-a-bc', 'a', 'bc'],
      ['k-absent', 'support-reply', undefined],
      ['k-null', 'support-reply', null],
      ['k-empty', 'support-reply', ''],
    ];
    const outcomes: Record<string, unknown> = {};
    for (const [id, workflow, key] of cases) {
      const record = run(id, { workflow_id: workflow, idempotency_key: key });
      if (key === null) (record as unknown as Record<string, unknown>)['idempotency_key'] = null;
      outcomes[id] = await put(db, record).then(
        () => 'stored',
        (err: Error) => err.message,
      );
    }
    const hashes = Object.fromEntries(
      (await foreign(home))
        .prepare('SELECT id, key_hash FROM runs')
        .all()
        .map((r) => [r['id'], r['key_hash']]),
    );
    // (1) red when the empty key is treated as no key (`if (record.idempotency_key)`: its NULL hash
    //     does not pair with its key and the file refuses the row with its own message), or any row
    //     is refused; (2) prints each id's outcome or the file's message.
    expect(outcomes).toEqual(Object.fromEntries(cases.map(([id]) => [id, 'stored'])));
    // (1) red when the hash is taken without the zero byte between the workflow id and the key
    //     ('ab'+'c' and 'a'+'bc' then hash alike: the collision row), or leaves the workflow out
    //     (another workflow's same key then hashes alike); (2) prints the three comparisons.
    expect({
      sameWorkflowAndKey: hashes['k-a'] === hashes['k-a-again'],
      otherWorkflowSameKey: hashes['k-a'] === hashes['k-other-workflow'],
      collision: hashes['k-ab-c'] === hashes['k-a-bc'],
    }).toEqual({ sameWorkflowAndKey: true, otherWorkflowSameKey: false, collision: false });
    // (1) red when the hash is of another text or encoding, or written for a record with no key;
    //     (2) prints every id's stored hash against the expected one.
    expect(hashes).toEqual({
      'k-a': sha256('support-reply\0ticket-1'),
      'k-a-again': sha256('support-reply\0ticket-1'),
      'k-other-workflow': sha256('refund-check\0ticket-1'),
      'k-ab-c': sha256('ab\0c'),
      'k-a-bc': sha256('a\0bc'),
      'k-absent': null,
      'k-null': null,
      'k-empty': sha256('support-reply\0'),
    });
  });

  // ---- check 5: the limits, before any BEGIN ----
  /** A record whose `params` nests to give the record `depth` levels in all (the record is level 1). */
  function nested(id: string, depth: number): RunRecord {
    let params: Record<string, unknown> = { leaf: true };
    for (let level = 3; level <= depth; level++) params = { inner: params };
    return run(id, { params });
  }

  /** The store's sequence on a connection that records what it is sent: the limits, then the write. */
  function putChecked(
    c: DatabaseLike,
    record: RunRecord,
    maxBytes?: number,
  ): { sent: string[]; outcome: unknown } {
    const sent: string[] = [];
    const recording: DatabaseLike = {
      exec: (sql) => {
        sent.push(sql);
        c.exec(sql);
      },
      prepare: (sql) => c.prepare(sql),
      close: () => c.close(),
      get isTransaction() {
        return c.isTransaction;
      },
    };
    const outcome = thrown(() => {
      assertRunRecordWithinLimits(record, maxBytes);
      recording.exec('BEGIN IMMEDIATE');
      try {
        insertRunRecord(recording, record);
        recording.exec('COMMIT');
      } catch (err) {
        recording.exec('ROLLBACK');
        throw err;
      }
    });
    return { sent, outcome };
  }

  const DEPTH_REFUSAL = {
    code: 'STATE_STORE_LIMIT_EXCEEDED',
    message:
      'This run record is too large for the store: its nesting depth is more than 1000, and the most the store accepts is 1000. Nothing was written.',
    details: { limit: 'nesting depth', max: 1000, actual: 1001 },
  };

  it('check 5 — nesting depth: 1,000 levels are stored and read back; 1,001, 20,000, a deep evidence entry and a record that refers to itself are refused before any BEGIN', async () => {
    const { home, db } = await store();
    const c = await foreign(home);
    const deepest = nested('d-1000', 1000);
    const stored = putChecked(c, deepest);
    const selfReferring = run('d-self');
    (selfReferring.params as Record<string, unknown>)['self'] = selfReferring;
    // An evidence entry 999 deep sits 1,001 deep in the record (record, the evidence array, the entry).
    let deepEntry: Record<string, unknown> = { leaf: true };
    for (let level = 2; level <= 999; level++) deepEntry = { inner: deepEntry };
    const refused = {
      'd-1001': putChecked(c, nested('d-1001', 1001)),
      'd-20000': putChecked(c, nested('d-20000', 20000)),
      'd-self': putChecked(c, selfReferring),
      'd-entry': putChecked(c, run('d-entry', { evidence: [deepEntry] })),
    };
    // (1) red when the depth check refuses 1,000 levels (an off-by-one), or SQLite does not store
    //     them; (2) prints the statements sent and the error.
    expect(stored).toEqual({
      sent: ['BEGIN IMMEDIATE', 'SAVEPOINT realm_insert_run', 'RELEASE realm_insert_run', 'COMMIT'],
      outcome: 'no error',
    });
    // (1) red when the read loses any of the 1,000 levels; (2) prints vitest's diff.
    expect(await read(db, 'd-1000')).toEqual(deepest);
    // (1) red when the depth check is missing or late: SQLite's "malformed JSON" (1,001), a stack
    //     overflow of `JSON.stringify` (20,000), its circular-structure error (the self-referring
    //     record) or nothing at all (the deep entry, which SQLite stores) comes back in place of the
    //     refusal, after a BEGIN; (2) prints each record's statements sent and its outcome.
    expect(refused).toEqual({
      'd-1001': { sent: [], outcome: DEPTH_REFUSAL },
      'd-20000': { sent: [], outcome: DEPTH_REFUSAL },
      'd-self': { sent: [], outcome: DEPTH_REFUSAL },
      'd-entry': { sent: [], outcome: DEPTH_REFUSAL },
    });
  });

  it('check 5 — size: a record at the byte limit is stored, one byte over it is refused before any BEGIN, counted in UTF-8 bytes', async () => {
    const { home } = await store();
    const c = await foreign(home);
    const record = run('b-euro', { params: { note: '€'.repeat(200) } });
    const bytes = Buffer.byteLength(JSON.stringify(record), 'utf8');
    const atLimit = putChecked(c, record, bytes);
    const over = putChecked(c, record, bytes - 1);
    // The cell needs a record whose UTF-16 length is below the lowered limit.
    // (1) red when the record is measured by its UTF-16 length (each euro sign counts 1, not 3) or
    //     the byte check is missing; also when a record at the limit is refused; (2) prints the
    //     statements sent and each outcome.
    expect({ length: JSON.stringify(record).length < bytes - 1, atLimit, over }).toEqual({
      length: true,
      atLimit: {
        sent: [
          'BEGIN IMMEDIATE',
          'SAVEPOINT realm_insert_run',
          'RELEASE realm_insert_run',
          'COMMIT',
        ],
        outcome: 'no error',
      },
      over: {
        sent: [],
        outcome: {
          code: 'STATE_STORE_LIMIT_EXCEEDED',
          message: `This run record is too large for the store: its size in bytes is ${bytes}, and the most the store accepts is ${bytes - 1}. Nothing was written.`,
          details: { limit: 'size in bytes', max: bytes - 1, actual: bytes },
        },
      },
    });
  });

  it("check 5 — the byte limit is SQLite's own: a value of the limit's length is accepted and one byte more is refused (error 18)", async () => {
    const { home } = await store();
    const c = await foreign(home);
    const length = (n: number): unknown => {
      try {
        return c.prepare('SELECT length(zeroblob(?)) AS n').get(n)?.['n'];
      } catch (err) {
        return { errcode: (err as { errcode?: number }).errcode, message: (err as Error).message };
      }
    };
    // (1) red when the store's limit is not SQLite's: one above it (the refused half accepts) or one
    //     below; (2) prints both answers.
    expect({
      atLimit: length(RUN_RECORD_MAX_BYTES),
      over: length(RUN_RECORD_MAX_BYTES + 1),
    }).toEqual({
      atLimit: RUN_RECORD_MAX_BYTES,
      over: { errcode: 18, message: 'string or blob too big' },
    });
  });

  // ---- check 6: the file's guards bind this writer ----
  it("check 6 — the file's guards refuse an existing id and a purged id, with their own messages", async () => {
    const { db } = await store();
    const live = run('g-live');
    await put(db, live);
    const finished = run('g-purged', { terminal_state: true, terminal_reason: 'completed' });
    await put(db, finished);
    await db.immediate(
      (c) => {
        c.prepare('DELETE FROM runs WHERE id = ?').run('g-purged');
        c.prepare('DELETE FROM evidence WHERE run_id = ?').run('g-purged');
        c.prepare('DELETE FROM run_blobs WHERE run_id = ?').run('g-purged');
      },
      () => true,
    );
    const again = async (record: RunRecord): Promise<unknown> =>
      db.immediate(
        (c) => thrown(() => insertRunRecord(c, record)),
        () => true,
      );
    // (1) red when the writer swallows, replaces or maps a guard's refusal, or the purge in the cell
    //     did not land; (2) prints each refusal's message.
    expect({ existing: await again(live), purged: await again(finished) }).toEqual({
      existing: { message: 'realm.db: a run with this id already exists' },
      purged: { message: 'realm.db: a purged run id cannot be created again' },
    });
  });

  // ---- check 7: a record and rows that disagree are refused at the read ----
  it('check 7 — a foreign writer drops a guard and deletes a row: the read refuses, naming the run', async () => {
    const { home, db } = await store();
    await put(db, run('x-evidence', { evidence: [entry(0), entry(1), entry(2)] }));
    await put(db, run('x-blob'));
    const hostile = await foreign(home);
    hostile.exec('DROP TRIGGER evidence_delete_after_run');
    hostile.exec('DROP TRIGGER run_blobs_delete_after_run');
    hostile.prepare('DELETE FROM evidence WHERE run_id = ? AND seq = 2').run('x-evidence');
    hostile.prepare('DELETE FROM run_blobs WHERE run_id = ?').run('x-blob');
    // (1) red when the read skips the check and returns a record short of an entry, or one holding
    //     its placeholder in place of the field; (2) prints each read's outcome.
    expect({
      evidence: await thrownAsync(() => read(db, 'x-evidence')),
      blob: await thrownAsync(() => read(db, 'x-blob')),
    }).toEqual({
      evidence: {
        message:
          'The stored run x-evidence cannot be read back: its record holds 3 evidence entries and the store has 2 evidence rows.',
      },
      blob: {
        message:
          'The stored run x-blob cannot be read back: its record has a placeholder for field workflow_context_snapshots and the store no value.',
      },
    });
  });

  // ---- check 8: the fence adapter's put, from a second connection ----
  it("check 8 — a run put on a foreign connection (BEGIN IMMEDIATE, insert, COMMIT) reads back equal on the store's own", async () => {
    const { home, db } = await store();
    const c = await foreign(home);
    const record = run('f-put', {
      idempotency_key: 'k-9',
      evidence: [entry(0), entry(1), entry(2)],
    });
    c.exec('BEGIN IMMEDIATE');
    insertRunRecord(c, record);
    c.exec('COMMIT');
    const back = await read(db, 'f-put');
    // (1) red when a placeholder is left in place of its field or entries, or the put did not
    //     commit; (2) prints vitest's diff and both texts.
    expect(back).toEqual(record);
    expect(JSON.stringify(back)).toBe(JSON.stringify(record));
  });

  // ---- the rulings of 2026-11-06 (MA 3, SEAMS): the read's one snapshot, the foreign connection ----
  it('the read refuses a call with no transaction open', async () => {
    const { home, db } = await store();
    await put(db, run('t-none'));
    const c = await foreign(home);
    // (1) red when the read runs its three statements with no transaction (three snapshots);
    //     (2) prints what the call returned or threw.
    expect(thrown(() => readRunInTransaction(c, 't-none'))).toEqual({
      message:
        'readRunInTransaction reads a run in one snapshot, so it needs a transaction open on its connection, and none is open.',
    });
  });

  it('the foreign connection waits a whole store budget for a busy file, keeps foreign keys on and does not trust the schema', async () => {
    const { home } = await store();
    const c = await foreign(home);
    const pragma = (name: string): unknown =>
      Object.values(c.prepare(`PRAGMA ${name}`).get() ?? {})[0];
    // (1) red when a pragma is not set (Node's defaults: busy_timeout 0, which refuses a busy file at
    //     once; trusted_schema 1); (2) prints the three values.
    expect({
      busy_timeout: pragma('busy_timeout'),
      foreign_keys: pragma('foreign_keys'),
      trusted_schema: pragma('trusted_schema'),
    }).toEqual({ busy_timeout: 5000, foreign_keys: 1, trusted_schema: 0 });
  });

  // ---- the review of PR #993 (MA 3, SEAMS "unit 10 review", the amendment): all or nothing ----
  /** A record the file refuses part-way: its second entry is 1,002 levels deep, past SQLite's JSON limit. */
  function torn(id: string): RunRecord {
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let level = 2; level <= 1002; level++) deep = { d: deep };
    return run(id, { evidence: [entry(0), deep, entry(2)] as unknown as EvidenceSnapshot[] });
  }

  /** How many rows of a run a connection sees. */
  function left(c: DatabaseLike, id: string): { runs: unknown; evidence: unknown; blobs: unknown } {
    const n = (sql: string): unknown => c.prepare(sql).get(id)?.['n'];
    return {
      runs: n('SELECT count(*) AS n FROM runs WHERE id = ?'),
      evidence: n('SELECT count(*) AS n FROM evidence WHERE run_id = ?'),
      blobs: n('SELECT count(*) AS n FROM run_blobs WHERE run_id = ?'),
    };
  }

  /** What a read gave: the record, null, or the refusal's message. */
  async function readOutcome(db: RealmDb, id: string): Promise<unknown> {
    try {
      return await read(db, id);
    } catch (err) {
      return { message: (err as Error).message };
    }
  }

  const NONE = { runs: 0, evidence: 0, blobs: 0 };
  const JSON_REFUSAL = { message: 'realm.db: evidence and fields must be valid JSON' };

  it("review of #993, check 1 — a failure part-way inside the caller's BEGIN IMMEDIATE leaves none of the run in the transaction; the caller's earlier insert stays; a swallowed throw stores nothing", async () => {
    const { home, db } = await store();
    const c = await foreign(home);
    const other = await foreign(home);
    c.exec('BEGIN IMMEDIATE');
    insertRunRecord(c, run('a-earlier'));
    const failed = thrown(() => insertRunRecord(c, torn('a-torn')));
    const inTransaction = {
      torn: left(c, 'a-torn'),
      earlier: left(c, 'a-earlier'),
      isTransaction: c.isTransaction,
    };
    // (1) red when the failed call's first rows stay in the open transaction (no savepoint), or the
    //     caller's earlier insert is undone with them, or the transaction is ended; (2) prints the
    //     error and the rows each run has in the open transaction.
    expect({ failed, inTransaction }).toEqual({
      failed: JSON_REFUSAL,
      inTransaction: {
        torn: NONE,
        earlier: { runs: 1, evidence: 2, blobs: 1 },
        isTransaction: true,
      },
    });
    const fixed = run('a-torn');
    insertRunRecord(c, fixed);
    c.exec('COMMIT');
    c.exec('BEGIN IMMEDIATE');
    const swallowed = thrown(() => insertRunRecord(c, torn('a-swallowed')));
    c.exec('COMMIT');
    // (1) red when the clean record or the earlier insert is not committed, or a caller that
    //     swallowed the throw and committed stored part of the failed run; (2) prints what a second
    //     connection sees.
    expect({
      fixed: await readOutcome(db, 'a-torn'),
      earlier: left(other, 'a-earlier'),
      swallowed,
      swallowedRows: left(other, 'a-swallowed'),
    }).toEqual({
      fixed,
      earlier: { runs: 1, evidence: 2, blobs: 1 },
      swallowed: JSON_REFUSAL,
      swallowedRows: NONE,
    });
  });

  it('review of #993, check 2 — with no transaction open a failure commits nothing and leaves no transaction; a clean record then commits whole', async () => {
    const { home, db } = await store();
    const c = await foreign(home);
    const other = await foreign(home);
    const failed = thrown(() => insertRunRecord(c, torn('n-torn')));
    const afterFailure = {
      failed,
      isTransaction: c.isTransaction,
      rows: left(other, 'n-torn'),
      read: await readOutcome(db, 'n-torn'),
    };
    // (1) red when the first rows commit alone (the read then refuses "its record holds 3 evidence
    //     entries and the store has 1 evidence rows"), or the failure leaves a transaction open;
    //     (2) prints the error, the rows, the flag and the read.
    expect(afterFailure).toEqual({
      failed: JSON_REFUSAL,
      isTransaction: false,
      rows: NONE,
      read: null,
    });
    const fixed = run('n-torn');
    insertRunRecord(c, fixed);
    // (1) red when the savepoint is not released (the run stays uncommitted and the store's own
    //     connection reads null); (2) prints the flag and the read.
    expect({ isTransaction: c.isTransaction, back: await readOutcome(db, 'n-torn') }).toEqual({
      isTransaction: false,
      back: fixed,
    });
  });

  it("review of #993, check 3 — SQLite's own rollback: the trigger's error is the one thrown, and no transaction is left, in a held transaction and with none", async () => {
    const { home } = await store();
    const c = await foreign(home);
    c.exec(
      "CREATE TEMP TRIGGER test_rollback BEFORE INSERT ON evidence WHEN NEW.seq = 1 BEGIN SELECT RAISE(ROLLBACK, 'the test rolls the transaction back'); END",
    );
    c.exec('BEGIN IMMEDIATE');
    insertRunRecord(c, run('r-earlier', { evidence: [entry(0)] }));
    const held = {
      error: thrown(() => insertRunRecord(c, run('r-held'))),
      isTransaction: c.isTransaction,
    };
    const none = {
      error: thrown(() => insertRunRecord(c, run('r-none'))),
      isTransaction: c.isTransaction,
    };
    // (1) red when the cleanup sends ROLLBACK TO without asking whether a transaction is still open
    //     ("no such savepoint: realm_insert_run" then replaces the trigger's error); (2) prints each
    //     error and the flag.
    expect({ held, none }).toEqual({
      held: { error: { message: 'the test rolls the transaction back' }, isTransaction: false },
      none: { error: { message: 'the test rolls the transaction back' }, isTransaction: false },
    });
  });

  it('review of #993, check 3b — a failing RELEASE (the commit, with no transaction open) is cleaned up: the original error, no transaction left, nothing stored, and a clean insert then commits', async () => {
    const { home, db } = await store();
    const c = await foreign(home);
    const other = await foreign(home);
    const sent: string[] = [];
    let refused = false;
    const failingRelease: DatabaseLike = {
      exec: (sql) => {
        sent.push(sql);
        if (!refused && sql === 'RELEASE realm_insert_run') {
          refused = true;
          throw new Error('the test refuses the first RELEASE');
        }
        c.exec(sql);
      },
      prepare: (sql) => c.prepare(sql),
      close: () => c.close(),
      get isTransaction() {
        return c.isTransaction;
      },
    };
    const failed = thrown(() => insertRunRecord(failingRelease, run('l-release')));
    const afterFailure = {
      failed,
      sent,
      isTransaction: c.isTransaction,
      rows: left(other, 'l-release'),
    };
    // (1) red when the RELEASE sits outside the guarded region (the connection is left inside the
    //     savepoint's transaction, its rows uncommitted); (2) prints the error, every statement
    //     sent, the flag and the rows.
    expect(afterFailure).toEqual({
      failed: { message: 'the test refuses the first RELEASE' },
      sent: [
        'SAVEPOINT realm_insert_run',
        'RELEASE realm_insert_run',
        'ROLLBACK TO realm_insert_run',
        'RELEASE realm_insert_run',
      ],
      isTransaction: false,
      rows: NONE,
    });
    const fixed = run('l-release');
    insertRunRecord(c, fixed);
    // (1) red when the clean insert does not commit (a transaction left open holds it); (2) prints
    //     the flag and the read.
    expect({ isTransaction: c.isTransaction, back: await readOutcome(db, 'l-release') }).toEqual({
      isTransaction: false,
      back: fixed,
    });
  });

  // ---- the stored form's defined states (first-release facts, SEAMS 2026-11-06) ----
  it('stored form: a record with no phase is stored with the phase placeholder last and read back with the derived phase', async () => {
    const { home, db } = await store();
    const noPhase = run('s-no-phase');
    delete (noPhase as unknown as Record<string, unknown>)['run_phase'];
    await put(db, noPhase);
    const c = await foreign(home);
    const text = (id: string): unknown =>
      JSON.parse(String(c.prepare('SELECT record FROM runs WHERE id = ?').get(id)?.['record']));
    // (1) red when a record with no phase is stored without the phase's placeholder; (2) prints the
    //     stored record's last key and its value.
    expect({
      noPhaseLastKey: Object.keys(text('s-no-phase') as object).at(-1),
      noPhaseLast: (text('s-no-phase') as Record<string, unknown>)['run_phase'],
    }).toEqual({
      noPhaseLastKey: 'run_phase',
      noPhaseLast: { $realm_derived: 'run_phase' },
    });
    // (1) red when the read does not give the derived phase; (2) prints vitest's diff.
    expect(await read(db, 's-no-phase')).toEqual({
      ...noPhase,
      run_phase: deriveRunPhase(noPhase),
    });
  });

  it('stored form: evidence that is not an array is refused, naming the run', async () => {
    const { db } = await store();
    const record = run('s-not-array');
    (record as unknown as Record<string, unknown>)['evidence'] = { $realm_rows: 2 };
    // (1) red when such a record is written (a stored core document passed back in as a record would
    //     store a placeholder no row backs, and its read would fail); (2) prints what the write did.
    expect(
      await db.immediate(
        (c) => thrown(() => insertRunRecord(c, record)),
        () => true,
      ),
    ).toEqual({
      message: 'Run s-not-array is not a run record: its evidence is not an array.',
    });
  });
});
