// store-format-v2-d1c1.test.ts — issue #597, D1c-1: the store file's format version 2, the `outbound`
// table, and the ladder's first real step. The real cases: a user who ran 0.49.0 (a version-1 file
// holding runs, evidence and a question still open) upgrades Realm and runs `realm db migrate --backup`;
// a file whose evidence another program changed, which the step must refuse while leaving version 1 as
// it was; the ordinary open of a version-1 file, refused until the migrate; and the purge of a run with
// outbound rows, which go with it. Every cell works on real files through the loader; the version-1
// file is written by this package's own stores at the version-1 seam (`schemaVersion: 1`), from
// version 1's statements, whose hash the cell checks first, so the file is not built from the live
// constant. PR #1180's real 0.49.0 file is the independent byte witness (`corpus.test.ts`).
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  REALM_STORE_VERSIONS,
  WorkflowError,
  type EvidenceSnapshot,
  type RunRecord,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { afterEach, describe, expect, it } from 'vitest';
import type { DatabaseLike } from './driver.js';
import { openRealmHome } from './index.js';
import { openMaintenance } from './maintenance.js';
import { openHome, type RealmHome } from './open-realm-home.js';
import { openForeignConnection } from './test-support/foreign-connection.js';

/** Version 1's statements as 0.49.0 published them (registry D1-D1C-02). */
const V1_SHA256 = 'a81f82833b7a48a34b1b0f22e359267e2642129e8708c01fa96e112a07b4a286';
const V1 = { schemaVersion: 1 } as const;

const dirs: string[] = [];
const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) {
    try {
      close();
    } catch {
      // closed by its cell
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'realm-597-d1c1-'));
  dirs.push(dir);
  return dir;
}

/** `review` is a person's question after `draft`, as a workflow with a gate has it. */
const GATED: WorkflowDefinition = {
  id: 'release-check',
  name: 'Release check',
  version: 1,
  steps: {
    draft: { description: 'draft', execution: 'agent', depends_on: [] },
    review: { description: 'review', execution: 'agent', depends_on: ['draft'] },
  },
};

function evidenceOf(step: string): EvidenceSnapshot {
  return {
    step_id: step,
    started_at: '2030-05-06T07:00:00.000Z',
    completed_at: '2030-05-06T07:00:00.000Z',
    duration_ms: 0,
    input_summary: {},
    output_summary: { answer: `the answer of ${step}` },
    status: 'success',
    evidence_hash: 'e'.repeat(64),
  };
}

/** Writes two runs through `h`: each with `draft` settled and its evidence; the second at an open gate. */
async function writeRuns(h: RealmHome): Promise<string[]> {
  const ids: string[] = [];
  for (const n of [1, 2]) {
    const { record } = await h.runStore.create({
      workflowId: GATED.id,
      workflowVersion: 1,
      params: { release: `1.${n}.0` },
    });
    const claimed = (await h.runStore.claimStep(record.id, 'draft', GATED)).record;
    await h.runStore.settleStep(
      record.id,
      {
        kind: 'settle_step',
        step: 'draft',
        outcome: 'complete',
        claimToken: claimed.claims!['draft']!.token!,
        evidence: [evidenceOf('draft')],
      },
      GATED,
    );
    ids.push(record.id);
  }
  const gated = (await h.runStore.claimStep(ids[1]!, 'review', GATED)).record;
  await h.runStore.settleStep(
    ids[1]!,
    {
      kind: 'open_gate',
      step: 'review',
      claimToken: gated.claims!['review']!.token!,
      pendingGate: {
        gate_id: 'gate-review',
        step_name: 'review',
        preview: { notes: 'Release 1.2.0' },
        choices: ['approve', 'reject'],
      },
      evidence: [evidenceOf('review')],
    },
    GATED,
  );
  return ids;
}

/** A version-1 home holding the two runs, closed; their ids. */
async function versionOneHome(home: string): Promise<string[]> {
  const h = await openHome({ home }, V1);
  try {
    return await writeRuns(h);
  } finally {
    h.close();
  }
}

/** Reads on a foreign connection to the home's file, which it then closes. */
async function onFile<T>(home: string, read: (c: DatabaseLike) => T): Promise<T> {
  const c = await openForeignConnection(home);
  try {
    return read(c);
  } finally {
    c.close();
  }
}

/** Every row of every run table, as stored: what "nothing changed" is compared on. */
function storedRows(c: DatabaseLike): Record<string, unknown[]> {
  const all = (sql: string): unknown[] =>
    c
      .prepare(sql)
      .all()
      .map((r) => ({ ...r }));
  return {
    runs: all('SELECT * FROM runs ORDER BY id'),
    evidence: all('SELECT * FROM evidence ORDER BY run_id, seq'),
    run_blobs: all('SELECT * FROM run_blobs ORDER BY run_id, name'),
    store_meta: all('SELECT * FROM store_meta'),
  };
}

/** The file's schema objects, as `sqlite_master` stores them. */
function storedSchema(c: DatabaseLike): unknown[] {
  return c
    .prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    )
    .all()
    .map((r) => ({ ...r }));
}

const userVersion = (c: DatabaseLike): number =>
  Number(c.prepare('PRAGMA user_version').get()?.['user_version']);
const hasOutbound = (c: DatabaseLike): boolean =>
  c.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'outbound'").get() !==
  undefined;

/** A promise's outcome: `resolved`, a typed refusal's code and message, or a plain error's message. */
async function outcome(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'resolved';
  } catch (err) {
    return err instanceof WorkflowError ? `${err.code}: ${err.message}` : String(err);
  }
}

describe('#597 D1c-1 — a version-1 file moves to version 2 with `realm db migrate`, losing nothing', () => {
  it('a real migration: one step of one statement, every row as it was, `outbound` empty, the backup a readable version-1 file, and the schema a fresh version-2 file’s', async () => {
    const v1 = REALM_STORE_VERSIONS.get(1)!.schema;
    // (1) red when version 1's statements are not 0.49.0's (the cell would build from another
    //     schema); (2) prints the hash and the length.
    expect({
      statements: v1.length,
      sha256: createHash('sha256').update(JSON.stringify(v1)).digest('hex'),
    }).toEqual({ statements: 74, sha256: V1_SHA256 });
    const root = tmp();
    const home = join(root, '.realm');
    const ids = await versionOneHome(home);
    const before = await onFile(home, (c) => ({ version: userVersion(c), rows: storedRows(c) }));
    const m = await openMaintenance({ home, verb: 'migrate' }, {});
    closers.push(() => m.close());
    const backup = join(root, 'before-upgrade.db');
    const report = await m.migrate({ backup });
    m.close();
    const after = await onFile(home, (c) => ({
      version: userVersion(c),
      rows: storedRows(c),
      outboundRows: Number(c.prepare('SELECT count(*) AS n FROM outbound').get()?.['n']),
      schema: storedSchema(c),
    }));
    const opened = await openRealmHome({ home });
    closers.push(() => opened.close());
    const read: RunRecord[] = [];
    for (const id of ids) read.push((await opened.runStore.get(id)).record);
    opened.close();
    const freshHome = join(tmp(), '.realm');
    (await openRealmHome({ home: freshHome })).close();
    const fresh = await onFile(freshHome, (c) => storedSchema(c));
    // The backup, restored into a home of its own, opens under the version-1 seam and reads a run.
    const restored = join(tmp(), '.realm');
    mkdirSync(restored);
    copyFileSync(backup, join(restored, 'realm.db'));
    const backupVersion = await onFile(restored, (c) => userVersion(c));
    const atOne = await openHome({ home: restored }, V1);
    closers.push(() => atOne.close());
    const fromBackup = (await atOne.runStore.get(ids[1]!)).record.pending_gate?.gate_id;
    atOne.close();
    const evidence = (before.rows['evidence'] ?? []).length;
    // (1) red when the step is skipped (the file stays at 1, no step reported), when it changes a
    //     row (any run, evidence, blob or meta row differs), when the step's text and version 2's
    //     schema differ (the stored schema is not a fresh version-2 file's), when the backup is
    //     taken after the step (it reads at 2) or is not a usable copy, or when the open gate is
    //     lost; (2) prints the report's steps, both versions, which rows differ, the outbound rows,
    //     the schema difference, the backup's version and the gate read from it.
    expect({
      steps: report.steps,
      versions: [before.version, after.version],
      rowsAsBefore: JSON.stringify(after.rows) === JSON.stringify(before.rows),
      outboundRows: after.outboundRows,
      schemaIsAFreshVersion2File: JSON.stringify(after.schema) === JSON.stringify(fresh),
      readBack: read.map((r) => [r.id, r.evidence.length, r.pending_gate?.gate_id ?? null]),
      backupVersion,
      fromBackup,
    }).toEqual({
      steps: [{ from: 1, to: 2, statements: 1, evidenceChecked: evidence }],
      versions: [1, 2],
      rowsAsBefore: true,
      outboundRows: 0,
      schemaIsAFreshVersion2File: true,
      readBack: [
        [ids[0], 1, null],
        [ids[1], 2, 'gate-review'],
      ],
      backupVersion: 1,
      fromBackup: 'gate-review',
    });
    expect(evidence).toBe(3);
  });

  it('a failing step leaves version 1: an evidence row whose stored hash is wrong stops the step, and no `outbound` table is made', async () => {
    const root = tmp();
    const home = join(root, '.realm');
    const ids = await versionOneHome(home);
    // One EXTRA evidence row with a wrong stored hash, inserted by another program (no trigger
    // forbids an insert; rewriting a row would need `evidence_no_update` dropped, and the open
    // would refuse the file as tampered before the step).
    await onFile(home, (c) => {
      const next = Number(
        c.prepare('SELECT max(seq) AS s FROM evidence WHERE run_id = ?').get(ids[0])?.['s'],
      );
      c.prepare('INSERT INTO evidence (run_id, seq, entry, entry_sha256) VALUES (?, ?, ?, ?)').run(
        ids[0],
        next + 1,
        JSON.stringify(evidenceOf('draft')),
        '0'.repeat(64),
      );
    });
    const before = await onFile(home, (c) => storedRows(c));
    const m = await openMaintenance({ home, verb: 'migrate' }, {});
    closers.push(() => m.close());
    const result = await outcome(m.migrate({ backup: false }));
    m.close();
    const after = await onFile(home, (c) => ({
      version: userVersion(c),
      outbound: hasOutbound(c),
      rowsAsBefore: JSON.stringify(storedRows(c)) === JSON.stringify(before),
    }));
    // (1) red when the step lands half (the table made, or the version moved, though a hash
    //     failed), or when the hash re-check is skipped (the step resolves); (2) prints the code,
    //     the version, whether the table is there and whether the rows changed.
    expect({ code: result.split(':')[0], ...after }).toEqual({
      code: 'STATE_STORE_MIGRATE_FAILED',
      version: 1,
      outbound: false,
      rowsAsBefore: true,
    });
  });

  it('the ordinary open of a version-1 file is refused as older, naming `realm db migrate`, and writes nothing', async () => {
    const home = join(tmp(), '.realm');
    await versionOneHome(home);
    const file = join(home, 'realm.db');
    const bytes = readFileSync(file);
    const result = await outcome(openRealmHome({ home }));
    // (1) red when the open reads the older file (it opens, or writes: the bytes change) or refuses
    //     it in other words; (2) prints the refusal and whether the file changed.
    expect({ result, unchanged: readFileSync(file).equals(bytes) }).toEqual({
      result:
        "STATE_STORE_VERSION_OLDER: This store's file is at schema version 1; this Realm writes version 2. Run `realm db migrate` with Realm stopped to upgrade it.",
      unchanged: true,
    });
  });
});

describe('#597 D1c-1 — the purge deletes a run’s outbound rows with it', () => {
  /** A finished run of `h`, sealed by its update. */
  async function finished(h: RealmHome): Promise<RunRecord> {
    const { record } = await h.runStore.create({
      workflowId: 'wf',
      workflowVersion: 1,
      params: {},
    });
    return (
      await h.runStore.update({
        ...record,
        terminal_state: true,
        sealed_by: { arm: 'complete' },
        terminal_reason: 'Workflow completed.',
      })
    ).record;
  }

  /** One outbound row as a raw insert writes it (no store writes the table until D1c-2). */
  interface Row {
    readonly entry_key: string;
    readonly type: string;
    readonly occurrence: number | null;
    readonly of_max: number | null;
    readonly status: string;
    readonly lease_token: string;
    readonly lease_deadline: string;
    readonly attempts: number;
    readonly last_at: string | null;
    readonly last_outcome: string | null;
    readonly sent_at: string | null;
    readonly created_at: string;
  }
  const SENT: Row = {
    entry_key: 'gate:g:reminder:1',
    type: 'reminder',
    occurrence: 1,
    of_max: 3,
    status: 'sent',
    lease_token: 'token-é',
    lease_deadline: '2030-01-01T00:02:00.000Z',
    attempts: 1,
    last_at: '2030-01-01T00:01:00.000Z',
    last_outcome: 'ok',
    sent_at: '2030-01-01T00:01:00.000Z',
    created_at: '2030-01-01T00:00:00.000Z',
  };
  const PENDING: Row = {
    entry_key: 'gate:g:escalation',
    type: 'escalation',
    occurrence: null,
    of_max: null,
    status: 'pending',
    lease_token: 't',
    lease_deadline: '2030-01-01T00:02:00.000Z',
    attempts: 1,
    last_at: null,
    last_outcome: null,
    sent_at: null,
    created_at: '2030-01-01T00:00:00.000Z',
  };

  /** The rule's bytes of rows: every text column's UTF-8 length but `run_id`, a NULL counting 0. */
  function bytesOf(rows: readonly Row[]): number {
    let n = 0;
    for (const row of rows)
      for (const v of Object.values(row)) if (typeof v === 'string') n += Buffer.byteLength(v);
    return n;
  }

  it('a purged run’s rows go with it and are counted by the rule; another run’s stay', async () => {
    const home = join(tmp(), '.realm');
    const h = await openRealmHome({ home });
    closers.push(() => h.close());
    const purged = await finished(h);
    const kept = await finished(h);
    await onFile(home, (c) => {
      const insert = c.prepare(
        'INSERT INTO outbound (run_id, entry_key, type, occurrence, of_max, status, lease_token, lease_deadline, attempts, last_at, last_outcome, sent_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      );
      for (const [run, row] of [
        [purged.id, SENT],
        [purged.id, PENDING],
        [kept.id, SENT],
      ] as const)
        insert.run(run, ...Object.values(row));
    });
    const stores = async (id: string): Promise<number> =>
      (
        await Promise.all([
          h.runStore.statAllForRun(id),
          h.traceBufferStore.statAllForRun(id),
          h.failedAttemptStore.statAllForRun(id),
        ])
      ).reduce((sum, part) => sum + part.bytes, 0);
    const others = await stores(purged.id);
    const report = await h.purge([{ runId: purged.id, version: purged.version }]);
    const left = await onFile(home, (c) =>
      Object.fromEntries(
        [purged.id, kept.id].map((id) => [
          id,
          Number(c.prepare('SELECT count(*) AS n FROM outbound WHERE run_id = ?').get(id)?.['n']),
        ]),
      ),
    );
    const outcome0 = report.runs[0];
    // (1) red when the purge leaves the run's outbound rows (the table left out of its batch), when
    //     it deletes another run's, or when their bytes are not counted by the rule (`run_id` counted,
    //     or a NULL, or the bytes left out of the receipt); (2) prints the rows left per run and the
    //     receipt beside the other stores' figure and the rule's.
    expect({
      left,
      receipt: outcome0?.outcome === 'purged' ? outcome0.bytes_deleted : outcome0,
      others,
      rule: bytesOf([SENT, PENDING]),
    }).toEqual({
      left: { [purged.id]: 0, [kept.id]: 1 },
      receipt: others + bytesOf([SENT, PENDING]),
      others,
      rule: bytesOf([SENT, PENDING]),
    });
  });
});
