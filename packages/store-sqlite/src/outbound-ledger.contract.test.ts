// outbound-ledger.contract.test.ts — issue #597 D1c-2 (design record `DESIGN-D1-rev5.md` §2, §5): the
// SQLite outbound ledger (`SqliteOutboundLedger`, a home's `runStore.outbound`) held to the published
// laws on a real file, and its own cells.
//   - The outbound-ledger family (`outboundLedgerContract`, `@sensigo/realm-testing`), every law it
//     exports, each case on a fresh home. The family's `seedRun` writes a run AS GIVEN, replacing a run
//     of the same id, at whatever version the case names: the store's own verbs, and the file's
//     version fence (+1 exactly), refuse that, so the planter writes on a foreign connection, with the
//     fence dropped and re-created from its exact statement around the store's own update writer (the
//     technique of `plant-registry-row.ts`; every later open compares the schema text). A new id is
//     inserted with `insertRunRecord`. The planted rows are the store's own form: it reads them.
//   - The per-run artifact contract (`perRunArtifactStoreContract`) on `runStore.outbound`, every law,
//     the release-line law included: the failure is the driver seam failing the table's DELETE with
//     SQLite's I/O error, as `failed-attempt-store.contract.test.ts` does.
//   - The ledger's own cells: a COMMIT that fails after landing, and one rolled back; two connections
//     asking for one reminder at once; the primitive's typed refusals passing through unmapped.
//
// Each assertion carries the two questions of `~/.claude/TESTING-RULES.md` rule 8 next to it:
// (1) what turns it red, (2) what it prints then.
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  REALM_STORE_SCHEMA,
  REALM_STORE_SCHEMA_VERSION,
  WorkflowError,
  type Clock,
  type OutboundLeaseRequest,
  type OutboundMarkRequest,
  type OutboundResult,
  type PendingGate,
  type RunRecord,
} from '@sensigo/realm';
import {
  ARTIFACT_STORE_LAWS,
  OUTBOUND_LEDGER_LAWS,
  outboundLedgerContract,
  perRunArtifactStoreContract,
  type ArtifactStoreLaw,
  type OutboundLedgerContractAdapter,
  type OutboundLedgerLaw,
  type PerRunArtifactStoreContractAdapter,
} from '@sensigo/realm-testing';
import { afterEach, describe, expect, it } from 'vitest';
import { RealmDb } from './connection.js';
import { openDatabase } from './driver.js';
import { openHome, type RealmHome } from './open-realm-home.js';
import { SqliteOutboundLedger } from './outbound-ledger.js';
import { insertRunRecord, splitRunRecord, writeRunUpdate } from './run-rows.js';
import { faultyFiles, SQLITE, type FaultyFiles } from './test-support/commit-faults.js';
import { openForeignConnection } from './test-support/foreign-connection.js';

/**
 * The per-run artifact laws this file does not run, each with its reason (issue #625). Empty: the
 * ledger owns one per-run artifact (a run's `outbound` rows), so every law applies.
 */
const NOT_RUN: Partial<Record<ArtifactStoreLaw, string>> = {};

/** The artifact laws this file runs: every exported law, minus the ones named above. */
const LAWS: readonly ArtifactStoreLaw[] = ARTIFACT_STORE_LAWS.filter((law) => !(law in NOT_RUN));

/** The outbound laws this file does not run, each with its reason. None: SQLite runs every one. */
const OUTBOUND_NOT_RUN: Partial<Record<OutboundLedgerLaw, string>> = {};

/** Every exported outbound law but those named above: a law added to the family runs here untouched. */
const OUTBOUND_LAWS: readonly OutboundLedgerLaw[] = OUTBOUND_LEDGER_LAWS.filter(
  (law) => !(law in OUTBOUND_NOT_RUN),
);

/** The version fence's exact statement, re-created after a plant. */
const FENCE = REALM_STORE_SCHEMA.find((s) => s.startsWith('CREATE TRIGGER runs_version_fence '));

/**
 * Writes `record` into the home's file AS GIVEN, past the store's boundary: a new id is inserted, a
 * stored one replaced at the record's own version (the same, +1 or +2), in one transaction on a
 * foreign connection.
 */
async function plantRun(home: string, record: RunRecord): Promise<void> {
  if (FENCE === undefined)
    throw new Error("the store's schema holds no runs_version_fence trigger");
  const c = await openForeignConnection(home);
  try {
    c.exec('BEGIN IMMEDIATE');
    try {
      if (c.prepare('SELECT 1 FROM runs WHERE id = ?').get(record.id) === undefined) {
        insertRunRecord(c, record);
      } else {
        const split = splitRunRecord(record);
        c.exec('DROP TRIGGER runs_version_fence');
        writeRunUpdate(c, record.id, split.core, {
          prepared: { entries: split.entries, fields: split.fields },
        });
        c.exec(FENCE);
      }
      c.exec('COMMIT');
    } catch (err) {
      c.exec('ROLLBACK');
      throw err;
    }
  } finally {
    c.close();
  }
}

/** A raw row of the `outbound` table, every column but `run_id`, NULL for an unset field. */
type RawRow = readonly [
  entry_key: string,
  type: string,
  occurrence: number | null,
  of_max: number | null,
  status: string,
  lease_token: string,
  lease_deadline: string,
  attempts: number,
  last_at: string | null,
  last_outcome: string | null,
  sent_at: string | null,
  created_at: string,
];

const AT = '2026-11-15T09:00:00.000Z';
const LATER = '2026-11-15T09:02:00.000Z';

/** A representative mix of one run's rows: a sent reminder, a failed one, a pending one, an escalation. */
const MIX: readonly RawRow[] = [
  ['gate:g-mix:reminder:1', 'reminder', 1, 3, 'sent', 'tok-1', LATER, 1, AT, 'ok', AT, AT],
  [
    'gate:g-mix:reminder:2',
    'reminder',
    2,
    3,
    'failed',
    'tok-2',
    LATER,
    2,
    AT,
    'refused:channel_not_found',
    null,
    AT,
  ],
  ['gate:g-mix:reminder:3', 'reminder', 3, 3, 'pending', 'tok-3', LATER, 1, null, null, null, AT],
  [
    'gate:g-mix:escalation',
    'escalation',
    null,
    null,
    'pending',
    'tok-e',
    LATER,
    1,
    null,
    null,
    null,
    AT,
  ],
];

/** Writes `rows` for `runId` on a foreign connection, replacing a row of the same key (an upsert). */
async function plantRows(home: string, runId: string, rows: readonly RawRow[]): Promise<void> {
  const c = await openForeignConnection(home);
  try {
    const insert = c.prepare(
      'INSERT OR REPLACE INTO outbound (run_id, entry_key, type, occurrence, of_max, status, lease_token, ' +
        'lease_deadline, attempts, last_at, last_outcome, sent_at, created_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    c.exec('BEGIN IMMEDIATE');
    for (const row of rows) insert.run(runId, ...row);
    c.exec('COMMIT');
  } finally {
    c.close();
  }
}

/** How many `outbound` rows the file holds, read on a foreign connection. */
async function rowCount(home: string): Promise<number> {
  const c = await openForeignConnection(home);
  try {
    return Number(c.prepare('SELECT count(*) AS n FROM outbound').get()?.['n']);
  } finally {
    c.close();
  }
}

// ---- the homes of a cell ----
const dirs: string[] = [];
const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A fresh home in a temp folder, opened on `clock`, its connection given faults when `faulty`. */
async function freshHome(
  clock: Clock,
  faulty = false,
): Promise<{ home: string; handle: RealmHome; files?: FaultyFiles }> {
  const dir = mkdtempSync(join(tmpdir(), 'realm-597-d1c2-'));
  dirs.push(dir);
  const home = join(dir, '.realm');
  const files = faulty ? faultyFiles((path) => openDatabase(path)) : undefined;
  const handle = await openHome(
    { home, clock },
    files === undefined ? {} : { openFile: files.openFile },
  );
  closers.push(() => handle.close());
  return { home, handle, ...(files === undefined ? {} : { files }) };
}

const fixed = (iso: string): Clock => ({ now: () => new Date(iso), at: () => () => undefined });

// ---- the outbound-ledger family ----

const OUTBOUND_ADAPTER: OutboundLedgerContractAdapter = {
  storeName: 'SqliteRunStore',
  makeStore: async ({ clock }) => {
    const dir = mkdtempSync(join(tmpdir(), 'realm-597-d1c2-ol-'));
    const home = join(dir, '.realm');
    const handle = await openHome({ home, clock });
    return {
      store: handle.runStore,
      seedRun: (record) => plantRun(home, record),
      dispose: async () => {
        handle.close();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  },
};

describe('#597 D1c-2 — the SQLite store runs the outbound-ledger contract', () => {
  const cases = outboundLedgerContract(OUTBOUND_ADAPTER);
  it('the contract has one case per exported law, in order', () => {
    // (1) red when a law is exported without a case, or a case is registered under another law;
    //     (2) prints both lists.
    expect(cases.map((c) => c.law)).toEqual([...OUTBOUND_LEDGER_LAWS]);
  });
  for (const law of OUTBOUND_LAWS) {
    it(`conforms to ${law}`, async () => {
      const target = cases.find((c) => c.law === law);
      // (1) red when the contract stops registering a case for a law this file runs; (2) prints the
      //     law. The case itself throws, naming the law, the step and what the store returned.
      expect(target, `no case for ${law}`).toBeDefined();
      await target!.run();
    });
  }
});

// ---- the per-run artifact contract on `runStore.outbound` ----

/** A fresh home and adapter per law: a delete removes the seeded rows, and an armed fault stays. */
async function artifactAdapter(): Promise<PerRunArtifactStoreContractAdapter> {
  const { home, handle, files } = await freshHome(fixed(AT), true);
  const runId = randomUUID();
  const reseed = (): Promise<void> => plantRows(home, runId, MIX);
  await reseed();
  return {
    store: handle.runStore.outbound,
    runIdWithArtifact: runId,
    runIdAbsent: randomUUID(),
    reseed,
    injectFailure: () => {
      files!.opened.at(-1)!.arm({
        at: (sql) => sql.startsWith('DELETE FROM outbound'),
        times: Infinity,
        first: 'nothing',
        error: SQLITE.ioError,
      });
    },
  };
}

describe('SqliteOutboundLedger — PerRunArtifactStore TCK conformance (#597 D1c-2)', () => {
  for (const law of LAWS) {
    it(law, async () => {
      const adapter = await artifactAdapter();
      const target = perRunArtifactStoreContract(adapter).find((c) => c.law === law);
      // (1) red when the contract registers no case for an exported law; (2) prints the law. The case
      //     throws its own message naming the law's broken promise (a delete that swallows the
      //     injected I/O error resolves: L3; a stat that under-counts the mix: L6).
      expect(target, `no case registered for law ${law}`).toBeDefined();
      await target!.run();
    });
  }
});

describe('SqliteOutboundLedger wiring — the run lists are derived from the contracts', () => {
  it('every exported law of both families is run or named in a NOT_RUN, and each NOT_RUN names only exported laws (issue #625)', () => {
    for (const [exported, notRun, run] of [
      [ARTIFACT_STORE_LAWS, NOT_RUN, LAWS],
      [OUTBOUND_LEDGER_LAWS, OUTBOUND_NOT_RUN, OUTBOUND_LAWS],
    ] as const) {
      const all: readonly string[] = exported;
      const named = Object.keys(notRun);
      // (1) red when a law is dropped from a run list without being named in its NOT_RUN, or a
      //     NOT_RUN names a law the contract no longer exports; (2) prints the unaccounted or unknown
      //     laws.
      expect(named.filter((name) => !all.includes(name))).toEqual([]);
      expect([...run, ...named].sort()).toEqual([...all].sort());
      for (const reason of Object.values(notRun)) expect(reason).not.toBe('');
    }
  });
});

// ---- the ledger's own cells ----

const RUN = 'run-d1c2-own';
const GATE_ID = 'gate-d1c2-own';
const OPENED = '2026-11-15T08:00:00.000Z';
const GATE: PendingGate = {
  gate_id: GATE_ID,
  step_name: 'review',
  preview: {},
  choices: ['approve', 'reject'],
  opened_at: OPENED,
  reminder_seconds: 600,
  reminder_max: 3,
};

/** Plants `RUN` with the open question `GATE`, built from a run the store under test created. */
async function runWithGate(home: string, handle: RealmHome): Promise<void> {
  const { record } = await handle.runStore.create({
    workflowId: 'wf-d1c2',
    workflowVersion: 1,
    params: {},
  });
  await plantRun(home, { ...record, id: RUN, run_phase: 'gate_waiting', pending_gate: GATE });
}

const escalation: OutboundLeaseRequest['what'] = { type: 'escalation', gateId: GATE_ID };
const reminder = (occurrence: number): OutboundLeaseRequest['what'] => ({
  type: 'reminder',
  gateId: GATE_ID,
  occurrence,
});
const leaseOf = (what: OutboundLeaseRequest['what'], leaseToken = 'A'): OutboundLeaseRequest => ({
  what,
  leaseToken,
  leaseSeconds: 120,
});
const sentMark = (what: OutboundLeaseRequest['what']): OutboundMarkRequest => ({
  what,
  leaseToken: 'A',
  result: 'sent',
  outcome: 'ok',
});

/** How a call ended: the answer's word, or the rejection's code (or text). */
async function ended(call: Promise<OutboundResult>): Promise<string> {
  return call.then(
    (r) => (r.applied ? 'applied' : r.reason),
    (err: unknown) => `rejected: ${err instanceof WorkflowError ? err.code : String(err)}`,
  );
}

describe('#597 D1c-2 — a write answered after an error at its COMMIT', () => {
  it('a COMMIT that fails after landing: an escalation lease, a reminder lease and a mark answer applied, and read shows the rows', async () => {
    const { home, handle, files } = await freshHome(fixed(AT), true);
    await runWithGate(home, handle);
    const ledger = handle.runStore.outbound;
    // Driver seam: the COMMIT runs, then SQLite's I/O error (the data reached the file). Real: the
    // protocol's read-back, which is the write's own verify.
    const failNextCommit = (): void =>
      files!.opened.at(-1)!.arm({
        at: (sql) => sql === 'COMMIT',
        times: 1,
        first: 'run',
        error: SQLITE.ioError,
      });
    failNextCommit();
    const esc = await ended(ledger.lease(RUN, leaseOf(escalation)));
    failNextCommit();
    const rem = await ended(ledger.lease(RUN, leaseOf(reminder(1))));
    failNextCommit();
    const mark = await ended(ledger.mark(RUN, sentMark(escalation)));
    const rows = (await ledger.read(RUN)).map((e) => [e.entry_key, e.status]);
    // (1) red when the verify answers false for a row that is there (a NULL column against a field
    //     core leaves unset: the escalation's occurrence and of_max, a fresh row's last_at, sent_at and
    //     last_outcome), so the protocol answers not_landed while the row stands with a live lease;
    //     (2) prints each call's end, the rows, and how many faults fired.
    expect({ esc, rem, mark, rows, hits: files!.opened.map((f) => f.hits()) }).toEqual({
      esc: 'applied',
      rem: 'applied',
      mark: 'applied',
      rows: [
        [`gate:${GATE_ID}:escalation`, 'sent'],
        [`gate:${GATE_ID}:reminder:1`, 'pending'],
      ],
      hits: [3],
    });
  });

  it('a COMMIT that SQLite rolled back: the lease rejects and nothing is written', async () => {
    const { home, handle, files } = await freshHome(fixed(AT), true);
    await runWithGate(home, handle);
    const ledger = handle.runStore.outbound;
    // Driver seam: the transaction is rolled back, then SQLite's I/O error (nothing reached the file).
    files!.opened.at(-1)!.arm({
      at: (sql) => sql === 'COMMIT',
      times: 1,
      first: 'rollback',
      error: SQLITE.ioError,
    });
    const lease = await ended(ledger.lease(RUN, leaseOf(escalation)));
    const rows = await ledger.read(RUN);
    // (1) red when the verify answers true for a row that is not there (a check that is always true):
    //     the lease then resolves applied with no row behind it, and a second sender would lease the
    //     same escalation; (2) prints how the lease ended and the rows.
    expect({ applied: lease === 'applied', rejected: lease.startsWith('rejected'), rows }).toEqual({
      applied: false,
      rejected: true,
      rows: [],
    });
  });
});

describe('#597 D1c-2 — the atomic step across connections', () => {
  it('two connections ask for the same reminder at once: exactly one is applied, the other lease_held, one row leased once', async () => {
    const clock = fixed(AT);
    const { home, handle } = await freshHome(clock);
    await runWithGate(home, handle);
    // A second connection: `openHome` would hand back the first handle for a home already open.
    const db2 = await RealmDb.open(home, { clock }, {});
    closers.push(() => db2.close());
    const second = new SqliteOutboundLedger(db2);
    const answers = await Promise.all([
      ended(handle.runStore.outbound.lease(RUN, leaseOf(reminder(1), 'A'))),
      ended(second.lease(RUN, leaseOf(reminder(1), 'B'))),
    ]);
    const rows = (await second.read(RUN)).map((e) => [e.entry_key, e.attempts]);
    // (1) red when the read of the run's rows and the write of the lease are not one write
    //     transaction (both connections read no row, and both apply); (2) prints both answers and the
    //     rows.
    expect({ answers: [...answers].sort(), rows }).toEqual({
      answers: ['applied', 'lease_held'],
      rows: [[`gate:${GATE_ID}:reminder:1`, 1]],
    });
  });
});

describe('#597 D1c-2 — the primitive’s typed refusals pass through', () => {
  it('a lease while another connection holds the write lock past the busy budget throws STATE_RUN_BUSY and writes nothing', async () => {
    const clock = fixed(AT);
    const { home, handle } = await freshHome(clock);
    await runWithGate(home, handle);
    const db2 = await RealmDb.open(home, { clock, budgetMs: 1_000 }, {});
    closers.push(() => db2.close());
    const ledger = new SqliteOutboundLedger(db2);
    const holder = await openForeignConnection(home);
    holder.exec('BEGIN IMMEDIATE');
    let lease: string;
    try {
      lease = await ended(ledger.lease(RUN, leaseOf(escalation)));
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
    }
    // (1) red when the busy refusal is swallowed or turned into a refusal word (the lease resolves),
    //     or the lease writes once the lock is let go; (2) prints how the lease ended and the rows.
    expect({ lease, rows: await rowCount(home) }).toEqual({
      lease: 'rejected: STATE_RUN_BUSY',
      rows: 0,
    });
  }, 30_000);

  it('a lease after a newer Realm migrated the file throws STATE_STORE_VERSION_NEWER and writes nothing', async () => {
    const { home, handle } = await freshHome(fixed(AT));
    await runWithGate(home, handle);
    const foreign = await openForeignConnection(home);
    try {
      foreign.exec(`PRAGMA user_version = ${REALM_STORE_SCHEMA_VERSION + 1}`);
    } finally {
      foreign.close();
    }
    const lease = await ended(handle.runStore.outbound.lease(RUN, leaseOf(escalation)));
    // (1) red when the refusal is swallowed or mapped into a refusal word (`gate_not_open`, say), or
    //     the row is written; (2) prints how the lease ended and the rows.
    expect({ lease, rows: await rowCount(home) }).toEqual({
      lease: 'rejected: STATE_STORE_VERSION_NEWER',
      rows: 0,
    });
  });
});
