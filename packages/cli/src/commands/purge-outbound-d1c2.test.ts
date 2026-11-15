// purge-outbound-d1c2.test.ts — issue #597 D1c-2: `realm run purge` on a SQLite home whose finished run
// keeps outbound ledger rows, as an operator runs it. The cell runs the BUILT `realm` (tests run after
// the build) with PATH, HOME and REALM_NO_NUDGE only, in a scratch working folder; HOME is a scratch
// folder whose `.realm` the test first fills through the store package's own `openRealmHome` and
// closes. The ledger rows are written on a second raw connection (`openForeignConnection`, the store
// package's `./test-support` subpath, the one lawful route: no CLI source names the built-in SQLite),
// because the real ledger leases only an open question, and a finished run has none.
//
// On a SQLite home the purge deletes through the home's purge, which deletes the run's ledger rows
// with it and counts them in the receipt (D1c-1); the preview sums the stores in `purge.ts`'s list.
// The real case: the preview an operator reads before `--force` is the figure the receipt reports.
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openRealmHome } from '@sensigo/realm-store-sqlite';
import { openForeignConnection } from '@sensigo/realm-store-sqlite/test-support';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST_CLI = join(HERE, '..', '..', 'dist', 'index.js');

let root = '';
let base = '';
let home = '';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'realm-597-d1c2-home-'));
  base = mkdtempSync(join(tmpdir(), 'realm-597-d1c2-cwd-'));
  home = join(root, '.realm');
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

/** A finished run with a trace line and a failed attempt beside its record; returns its id. */
async function finishedRun(): Promise<string> {
  const h = await openRealmHome({ home });
  try {
    const { record } = await h.runStore.create({
      workflowId: 'triage',
      workflowVersion: 1,
      params: {},
      extensionIdentity: [],
    });
    await h.traceBufferStore.append(record.id, 'a', [{ event: 'drafting the reply' }]);
    await h.failedAttemptStore.append(record.id, '{"attempt":1,"error":"timeout"}');
    await h.runStore.update({
      ...record,
      terminal_state: true,
      sealed_by: { arm: 'complete' },
      terminal_reason: 'Workflow completed.',
    });
    return record.id;
  } finally {
    h.close();
  }
}

/** Four ledger rows of `runId` (about 700 bytes of text): a sent, a failed and a pending reminder, an escalation. */
async function ledgerRows(runId: string): Promise<void> {
  const at = '2026-11-15T09:00:00.000Z';
  const until = '2026-11-15T09:02:00.000Z';
  const gate = 'gate-the-reviewers-question-on-the-refund-request';
  const token = (n: number): string => `lease-token-of-the-reminder-sender-${n}`;
  const db = await openForeignConnection(home);
  try {
    const insert = db.prepare(
      'INSERT INTO outbound (run_id, entry_key, type, occurrence, of_max, status, lease_token, ' +
        'lease_deadline, attempts, last_at, last_outcome, sent_at, created_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    db.exec('BEGIN IMMEDIATE');
    insert.run(
      runId,
      `gate:${gate}:reminder:1`,
      'reminder',
      1,
      3,
      'sent',
      token(1),
      until,
      1,
      at,
      'ok',
      at,
      at,
    );
    insert.run(
      runId,
      `gate:${gate}:reminder:2`,
      'reminder',
      2,
      3,
      'failed',
      token(2),
      until,
      2,
      at,
      'refused:channel_not_found',
      null,
      at,
    );
    insert.run(
      runId,
      `gate:${gate}:reminder:3`,
      'reminder',
      3,
      3,
      'pending',
      token(3),
      until,
      1,
      null,
      null,
      null,
      at,
    );
    insert.run(
      runId,
      `gate:${gate}:escalation`,
      'escalation',
      null,
      null,
      'pending',
      token(4),
      until,
      1,
      null,
      null,
      null,
      at,
    );
    db.exec('COMMIT');
  } finally {
    db.close();
  }
}

/** The run's ledger rows left in the file, and their text bytes, read on a raw connection. */
async function ledgerOf(runId: string): Promise<{ rows: number; bytes: number }> {
  const db = await openForeignConnection(home);
  try {
    const row = db
      .prepare(
        'SELECT count(*) AS rows, COALESCE(SUM(octet_length(entry_key) + octet_length(type) + ' +
          'octet_length(status) + octet_length(lease_token) + octet_length(lease_deadline) + ' +
          'COALESCE(octet_length(last_at), 0) + COALESCE(octet_length(last_outcome), 0) + ' +
          'COALESCE(octet_length(sent_at), 0) + octet_length(created_at)), 0) AS bytes ' +
          'FROM outbound WHERE run_id = ?',
      )
      .get(runId);
    return { rows: Number(row?.['rows']), bytes: Number(row?.['bytes']) };
  } finally {
    db.close();
  }
}

describe('#597 D1c-2 — realm run purge counts the outbound ledger in its preview', () => {
  it('the dry run’s figure is the receipt’s, the ledger rows go with the run, and realm db check finds nothing', async () => {
    const id = await finishedRun();
    await ledgerRows(id);
    const planted = await ledgerOf(id);
    const preview = realm(['run', 'purge', id]);
    const receipt = realm(['run', 'purge', id, '--force']);
    const previewFigure = /WOULD be purged \(([\d.]+ [KMG]?B) to free\)/.exec(preview.stdout)?.[1];
    const receiptFigure = /\(([\d.]+ [KMG]?B) freed, store-reported/.exec(receipt.stdout)?.[1];
    const check = realm(['db', 'check']);
    // (1) red when `purge.ts`'s list of stores leaves the ledger out: the preview is about 0.7 KB
    //     less than the receipt (which the home's purge counts); red too when the rows stay, or the
    //     check finds rows whose run is gone; (2) prints both figures, both outputs' exit codes, the
    //     rows planted and left, and the check's first line of findings.
    expect({
      planted: planted.rows,
      plantedBytesOver600: planted.bytes > 600,
      previewCode: preview.code,
      receiptCode: receipt.code,
      previewFigure,
      sameFigure: previewFigure !== undefined && previewFigure === receiptFigure,
      left: await ledgerOf(id),
      checkCode: check.code,
      checkFound: check.stdout.split('\n')[1],
    }).toEqual({
      planted: 4,
      plantedBytesOver600: true,
      previewCode: 0,
      receiptCode: 0,
      previewFigure: expect.stringMatching(/^\d+\.\d KB$/),
      sameFigure: true,
      left: { rows: 0, bytes: 0 },
      checkCode: 0,
      checkFound: 'No problems found by the checks that ran.',
    });
  }, 180_000);
});
