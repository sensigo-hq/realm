// failed-attempt-store-616.test.ts — issue #616 PR-1b B7: the SQLite failed-attempt store, through the
// home's handle (`openHome`, the package-internal open with its seams) as a host will reach it. Store
// failures come from the driver seam (`test-support/commit-faults.ts`): a statement named by its SQL
// throws an error in the exact shape the built-in SQLite throws. Lines are what the engine writes
// (core's `buildFailedAttemptRecord` and `serializeFailedAttemptLine`), except where a cell needs a
// line of an exact size or a line that is not JSON.
//
// The JSON store's cells (core's `failed-attempt-store.test.ts`), each ported, covered or not
// applicable:
//   - one sidecar file named `.attempts.jsonl`, never `.json`: not applicable (a file layout);
//   - exactly one line per record: covered by checks 2 and 12 (the records read back, one per append);
//   - concurrent appends all land: ported as check 12;
//   - drops appends at the ceiling / appends under it / `capped` at the ceiling: covered by check 1;
//   - a missing file reads empty, `capped` false: ported ("a run with no rows");
//   - torn and unparseable lines skipped: ported as check 2;
//   - append never throws on an unwritable folder: covered by check 3 (the store fails, append
//     resolves);
//   - delete removes the run's artifact: ported ("the run's rows are gone");
//   - delete is idempotent, zero for a run with none: covered by the artifact contract's L1, L2 and
//     L5 (`failed-attempt-store.contract.test.ts`);
//   - delete ignores `dirEntries`: not applicable (a batch listing hint for file stores);
//   - delete leaves another run's artifact: ported ("another run's rows stay");
//   - B1's delete-error cell: ported as check 5b;
//   - `listOrphans` (six cells): not applicable (this store is not an `OrphanSweepableStore`; on
//     SQLite, `realm db check` reports orphaned rows).
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildFailedAttemptRecord,
  FAILED_ATTEMPT_SIDECAR_MAX_BYTES,
  serializeFailedAttemptLine,
} from '@sensigo/realm';
import type { Clock } from '@sensigo/realm';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from './driver.js';
import { openHome, type RealmHome } from './open-realm-home.js';
import { faultyFiles, SQLITE, type Fault, type FaultyFiles } from './test-support/commit-faults.js';

const clock: Clock = { now: () => new Date('2026-11-07T09:00:00.000Z'), at: () => () => undefined };
const RUN = '11111111-2222-4333-8444-555555555555';
const OTHER = '99999999-8888-4777-8666-555555555555';

const dirs: string[] = [];
const homes: RealmHome[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) h.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A fresh Realm home, opened through the open's `openFile` seam so store failures can be armed. */
async function freshHome(): Promise<{ home: RealmHome; files: FaultyFiles }> {
  const dir = mkdtempSync(join(tmpdir(), 'realm-616-b7-'));
  dirs.push(dir);
  const files = faultyFiles((path) => openDatabase(path));
  const home = await openHome({ home: join(dir, '.realm'), clock }, { openFile: files.openFile });
  homes.push(home);
  return { home, files };
}

/** Arms `fault` on the connection the home uses now. */
function arm(files: FaultyFiles, fault: Fault): void {
  files.opened[files.opened.length - 1]!.arm(fault);
}

/** A failed attempt's line as the engine writes it, for `step`. */
function line(step: string): string {
  const record = buildFailedAttemptRecord({
    run_id: RUN,
    workflow_id: 'triage',
    step_id: step,
    ts: '2026-11-07T09:00:00.000Z',
    error_code: 'VALIDATION_OUTPUT_SCHEMA',
    ajv_errors: [
      {
        instancePath: '/priority',
        keyword: 'enum',
        message: 'must be equal to one of the allowed values',
      },
    ],
    params: { priority: 'urgent', summary: 'the customer cannot log in' },
    trace_entry_count: 3,
  });
  return serializeFailedAttemptLine({ ...record }).line;
}

/** A line of exactly `bytes` UTF-8 bytes that is valid JSON (`bytes` at least 30). */
function lineOfSize(bytes: number): string {
  const head = '{"step_id":"filler","pad":"';
  const tail = '"}';
  return head + 'x'.repeat(bytes - head.length - tail.length) + tail;
}

const stepsOf = (records: readonly { step_id?: unknown }[]): unknown[] =>
  records.map((r) => r.step_id);

describe('#616 B7 — the SQLite failed-attempt store', () => {
  it('check 1: an agent failing at one step in a loop: appends until the stored size reaches the ceiling, then the next append writes nothing and read says capped; one line under the ceiling still appends', async () => {
    const { home } = await freshHome();
    const store = home.failedAttemptStore;
    const each = Buffer.byteLength(line('classify')) + 1;
    let size = 0;
    let appended = 0;
    // The engine's lines while the room left stays above one of them and a filler.
    while (size + each <= FAILED_ATTEMPT_SIDECAR_MAX_BYTES - 1 - 64) {
      await store.append(RUN, line('classify'));
      size += each;
      appended += 1;
    }
    // Then a line that brings the stored size to one byte under the ceiling.
    await store.append(RUN, lineOfSize(FAILED_ATTEMPT_SIDECAR_MAX_BYTES - 1 - size - 1));
    appended += 1;
    const underCeiling = await store.statAllForRun(RUN);
    const beforeLast = await store.read(RUN);
    // One byte under the ceiling, a line still appends (append-and-stop judges the size before it).
    await store.append(RUN, line('classify'));
    const atCeiling = await store.statAllForRun(RUN);
    const capped = await store.read(RUN);
    // At the ceiling, the next append writes nothing.
    await store.append(RUN, line('classify'));
    const after = await store.statAllForRun(RUN);
    const afterRead = await store.read(RUN);
    // (1) red when append skips the size check (the named break: the last append writes, so the size
    //     and the record count grow), when the stored size is not each line's bytes plus one (the
    //     size under the ceiling is not one byte short), or when `capped` is not judged by the size;
    //     (2) prints each stored size, each record count and each `capped`.
    expect({
      underCeiling: underCeiling.bytes,
      beforeLast: { records: beforeLast.records.length, capped: beforeLast.capped },
      lastUnder: { bytes: atCeiling.bytes, records: capped.records.length, capped: capped.capped },
      atCeiling: {
        bytes: after.bytes,
        records: afterRead.records.length,
        capped: afterRead.capped,
      },
    }).toEqual({
      underCeiling: FAILED_ATTEMPT_SIDECAR_MAX_BYTES - 1,
      beforeLast: { records: appended, capped: false },
      lastUnder: {
        bytes: FAILED_ATTEMPT_SIDECAR_MAX_BYTES - 1 + each,
        records: appended + 1,
        capped: true,
      },
      atCeiling: {
        bytes: FAILED_ATTEMPT_SIDECAR_MAX_BYTES - 1 + each,
        records: appended + 1,
        capped: true,
      },
    });
  });

  it('check 2: a torn or foreign line: read returns the lines in seq order and skips a blank and an unparseable line', async () => {
    const { home } = await freshHome();
    const store = home.failedAttemptStore;
    await store.append(RUN, line('first'));
    await store.append(RUN, '{ this is not valid json');
    await store.append(RUN, '   ');
    await store.append(RUN, line('second'));
    await store.append(RUN, line('third'));
    const { records, capped } = await store.read(RUN);
    // (1) red when read parses without skipping (the named break: the unparseable line throws and
    //     read rejects), or reads in another order than `seq`; (2) prints the step ids read back and
    //     `capped`.
    expect({ steps: stepsOf(records), capped }).toEqual({
      steps: ['first', 'second', 'third'],
      capped: false,
    });
  });

  it('check 3: a full disk while a failure is recorded: append resolves and writes nothing when the store fails with SQLITE_FULL', async () => {
    const { home, files } = await freshHome();
    const store = home.failedAttemptStore;
    await store.append(RUN, line('first'));
    arm(files, {
      at: (sql) => sql.startsWith('INSERT INTO failed_attempts'),
      times: 1,
      first: 'nothing',
      error: SQLITE.full,
    });
    const outcome = await store.append(RUN, line('second')).then(
      () => 'resolved',
      (err: unknown) => `rejected: ${err instanceof Error ? err.message : String(err)}`,
    );
    const { records } = await store.read(RUN);
    // (1) red when append rethrows the store's failure (the named break), or when the failed append
    //     wrote its line anyway; (2) prints how append settled and the step ids stored.
    expect({ outcome, fired: files.opened[0]!.hits(), steps: stepsOf(records) }).toEqual({
      outcome: 'resolved',
      fired: 1,
      steps: ['first'],
    });
  });

  it('check 4: #183, a read failure looked like "no failed attempts": read rejects when the read fails', async () => {
    const { home, files } = await freshHome();
    const store = home.failedAttemptStore;
    await store.append(RUN, line('first'));
    arm(files, {
      at: (sql) => sql.startsWith('SELECT line FROM failed_attempts'),
      times: 1,
      first: 'nothing',
      error: SQLITE.ioError,
    });
    const settled = await store.read(RUN).then(
      (result) => ({ resolved: result }),
      (err: unknown) => ({ rejected: err instanceof Error ? err.message : String(err) }),
    );
    // (1) red when a failed read answers `{ records: [], capped: false }` (the named break); (2) prints
    //     what read resolved to, or the message it rejected with.
    expect(settled).toEqual({ rejected: 'disk I/O error (SQLite error 10)' });
  });

  it('check 5b: an operator reads a delete failure (B1 cell, ported): it opens "SqliteFailedAttemptStore failed to delete artifact(s) for run …: failed_attempts (SQLITE_IOERR)" and details.store names the store', async () => {
    const { home, files } = await freshHome();
    const store = home.failedAttemptStore;
    await store.append(RUN, line('first'));
    arm(files, {
      at: (sql) => sql.startsWith('DELETE FROM failed_attempts'),
      times: 1,
      first: 'nothing',
      error: SQLITE.ioError,
    });
    const err = (await store.deleteAllForRun(RUN).catch((e: unknown) => e)) as {
      code?: string;
      message?: string;
      details?: { store?: string; failures?: unknown };
    };
    const opening = `SqliteFailedAttemptStore failed to delete artifact(s) for run '${RUN}': failed_attempts (SQLITE_IOERR)`;
    // (1) red when the error names the JSON class (break (a)), names the bare mapped code instead of
    //     SQLite's name for it (break (b): "(10)"), or the delete does not fail; (2) prints the code,
    //     the message's opening, `details.store` and the failure entries.
    expect({
      code: err.code,
      opening: err.message?.slice(0, opening.length),
      store: err.details?.store,
      failures: err.details?.failures,
    }).toEqual({
      code: 'ENGINE_ARTIFACT_DELETE_FAILED',
      opening,
      store: 'SqliteFailedAttemptStore',
      failures: [
        {
          artifact: 'failed_attempts',
          code: 'SQLITE_IOERR',
          message: 'disk I/O error (SQLite error 10)',
        },
      ],
    });
  });

  it('check 6 (delete): a delete whose COMMIT reached the file and then reported an error is answered landed (review R4)', async () => {
    const { home, files } = await freshHome();
    const store = home.failedAttemptStore;
    await store.append(RUN, line('first'));
    await store.append(RUN, line('second'));
    const preview = await store.statAllForRun(RUN);
    arm(files, { at: (sql) => sql === 'COMMIT', times: 1, first: 'run', error: SQLITE.ioError });
    const settled = await store.deleteAllForRun(RUN).then(
      (report) => ({ resolved: report }),
      (err: unknown) => ({ rejected: err instanceof Error ? err.message : String(err) }),
    );
    const left = await store.read(RUN);
    // (1) red when the delete's verify answers false for a landed delete (the named break: the
    //     protocol then calls it not landed and the delete rejects), or when the COMMIT did not fire;
    //     (2) prints how the delete settled, the fault's firings and the records left.
    expect({ settled, fired: files.opened[0]!.hits(), left: left.records.length }).toEqual({
      settled: { resolved: { bytes_deleted: preview.bytes } },
      fired: 1,
      left: 0,
    });
  });

  it('check 12: two failing steps of one run recorded at once (the file store cell, ported): N appends started together give N records, none lost', async () => {
    const { home } = await freshHome();
    const store = home.failedAttemptStore;
    const n = 25;
    await Promise.all(Array.from({ length: n }, (_, i) => store.append(RUN, line(`s${i}`))));
    const { records } = await store.read(RUN);
    // (1) red when the next seq is taken outside the write (the named break: the appends started
    //     together take one seq, all but one are refused by the key and swallowed); (2) prints the
    //     number of records and of distinct step ids read back.
    expect({ records: records.length, distinct: new Set(stepsOf(records)).size }).toEqual({
      records: n,
      distinct: n,
    });
  });

  it('a run with no rows reads empty and not capped (the file store cell "missing file", ported)', async () => {
    const { home } = await freshHome();
    await home.failedAttemptStore.append(OTHER, line('elsewhere'));
    const result = await home.failedAttemptStore.read(RUN);
    // (1) red when read of a run with no rows answers anything else (break: read the whole table, not
    //     the run's rows); (2) prints what read resolved to.
    expect(result).toEqual({ records: [], capped: false });
  });

  it("delete removes the run's rows and leaves another run's (the file store cells, ported)", async () => {
    const { home } = await freshHome();
    const store = home.failedAttemptStore;
    await store.append(RUN, line('mine'));
    await store.append(OTHER, line('theirs'));
    const report = await store.deleteAllForRun(RUN);
    const mine = await store.read(RUN);
    const theirs = await store.read(OTHER);
    // (1) red when the delete leaves the run's rows (break: the DELETE not run) or removes another
    //     run's (break: a DELETE with no run in its WHERE); (2) prints the report and the step ids
    //     left for each run.
    expect({
      deleted: report.bytes_deleted,
      mine: stepsOf(mine.records),
      theirs: stepsOf(theirs.records),
    }).toEqual({
      deleted: Buffer.byteLength(line('mine')) + 1,
      mine: [],
      theirs: ['theirs'],
    });
  });

  it("README: failed attempts' sentence is there, and its claims are the cells above (append order: 2, 12; the ceiling: 1; never fails the step: 3)", () => {
    const readme = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'README.md'),
      'utf8',
    ).replace(/\s+/g, ' ');
    const sentence =
      "Failed attempts are kept per run in append order; recording stops once a run's records reach 256 KiB, and recording one never fails the step.";
    // (1) red when the sentence is removed or reworded without this cell; (2) prints the sentence
    //     looked for.
    expect(readme.includes(sentence), sentence).toBe(true);
    // The figure in the sentence is the ceiling the store applies.
    expect(FAILED_ATTEMPT_SIDECAR_MAX_BYTES).toBe(256 * 1024);
  });
});
