// run-scan.ts — issue #616 PR-2c unit c3 (design d4-frozen-r3 §6 "The read API"; §3 "Who reads the
// column" and "The key's resolution is truthful"; laws L-READ-COLD, L-PHASE, L-TIME): the SQLite run
// store's paged read, and the key's three-way answer. Package-internal: `SqliteRunStore`'s `scan`,
// `tombstonesSince` and `resolveKey` call it; the package's entry exports none of it. The statements
// are exported so the read-cold cells plan exactly what the store runs.
//
// A page is ONE read transaction, the caller's `snapshot`. It is a merge by id of every walk its filter
// needs, cut at the page size. Each walk reads one named index in id order, under `INDEXED BY`: unaided,
// the planner picks a sibling that tests the range on every row of the workflow.
//   - No phase, no key: ONE walk over the filter's index, picked by this precedence: workflow + range,
//     range, workflow, terminal; with no filter, the primary key. Every other filter given is a
//     residual WHERE term.
//   - `phase`: the TRUSTED walk over `runs_by_phase` (the rows the running derivation stamped), plus
//     one sub-walk per STALE stamp over `runs_by_phase_version`. The stale stamps are found by a loose
//     index scan: `MIN(phase_version) … > ?`, repeated from `''`, the running stamp skipped. A stale
//     row is derived and kept only when its derived phase matches. Such a walk reads on, a page size
//     at a time, until it holds a page size of matches or ends. So every walk reaches the cut, and no
//     matching row below it is skipped. `phase` is never a WHERE term on `runs`: one walk of
//     `phase_version != ?` is the primary key over every row (§3).
//   - `key` (with `workflow`): every run that carries the key, over `runs_by_key`. `id` is fifth in
//     that index, so the key's rows are read whole, sorted by id here and cut at the cursor. A `phase`
//     beside it is judged after the read.
//   - `include_purged`: one more walk, over `purged_runs` by id (by the key's index under `key`),
//     filtered by what a tombstone carries: `workflow`, the phase stamped at purge, and `key`.
// Ids never collide across walks: a purged id is never created again (`runs_insert_not_purged`), and a
// live id is never recorded as purged (`purged_ids_not_live`). Only a walk filtered after its read
// needs to read past a page; the others return candidates only, so their `LIMIT` is their reach.
import {
  deriveRunPhase,
  runPhaseDerivationFingerprint,
  SCAN_MAX_PAGE_SIZE,
  type KeyAnswer,
  type PurgedItem,
  type RunPhase,
  type RunRecord,
  type RunRow,
  type ScanFilter,
  type ScanItem,
  type ScanOptions,
  type ScanPage,
  type Snapshot,
} from '@sensigo/realm';
import type { DatabaseLike } from './driver.js';
import { findKeyHolder, keyHashOf } from './run-rows.js';

/**
 * Refuses, before any read, a scan its caller got wrong, with a plain error (a caller's mistake, not a
 * store state): a page size that is not a whole number from 1 to {@link SCAN_MAX_PAGE_SIZE}, and a
 * `key` with no `workflow` (a key's hash is taken with its workflow's id, so a key is a key of one
 * workflow).
 */
export function assertScanArguments(filter: ScanFilter, options: ScanOptions): void {
  const { pageSize } = options;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > SCAN_MAX_PAGE_SIZE) {
    throw new Error(
      `A scan's page size must be a whole number from 1 to ${SCAN_MAX_PAGE_SIZE}; it was ${String(pageSize)}.`,
    );
  }
  if (filter.key !== undefined && filter.workflow === undefined) {
    throw new Error(
      "A scan's key filter needs a workflow: an idempotency key belongs to one workflow, so give `workflow` with `key`.",
    );
  }
}

/**
 * The columns every walk over `runs` selects: the row's fields, and the stored core document of a row
 * stamped by another derivation (`stale_record`; NULL for a row the running derivation stamped), which
 * that row's phase is derived from. Its one parameter, bound first, is the running fingerprint.
 */
const RUN_COLUMNS =
  'id, workflow_id, run_phase, phase_version, terminal_state, sealed_by_arm, created_at, updated_at, ' +
  'idempotency_key, rerun_of, version, pending_gate_id, ' +
  "json_extract(record, '$.completed_steps') AS completed_steps, " +
  "json_extract(record, '$.in_progress_steps') AS in_progress_steps, " +
  "json_extract(record, '$.failed_steps') AS failed_steps, " +
  'CASE WHEN phase_version = ? THEN NULL ELSE record END AS stale_record';

/** The columns a walk over `purged_runs` selects: a tombstone's detail. */
const PURGED_COLUMNS = 'id, workflow_id, purged_at, sealed_by_arm, run_phase, phase_version';

/** The loose index scan's probe: the lowest stamp above `?`, one index search (§3). */
export const STAMP_PROBE =
  'SELECT MIN(phase_version) AS stamp FROM runs INDEXED BY runs_by_phase_version WHERE phase_version > ?';

/** A key's tombstones, by id: every row `purged_runs` holds for the key (no horizon predicate). */
export const KEY_TOMBSTONES =
  'SELECT id, purged_at FROM purged_runs INDEXED BY purged_runs_by_key WHERE workflow_id = ? AND key_hash = ? ORDER BY id';

/** The tombstone horizon: the store's meta row's `tombstones_since`. */
const HORIZON = 'SELECT tombstones_since FROM store_meta WHERE one = 1';

/** One WHERE term of a walk, and the value it binds. */
interface Term {
  readonly sql: string;
  readonly value: unknown;
}

/** One read a page makes (see the module comment). */
export interface Walk {
  /** What it reads: `runs` rows, or tombstones. */
  readonly table: 'runs' | 'purged_runs';
  /** The statement, under `INDEXED BY` its index. */
  readonly sql: string;
  /** The values its terms bind, in order; an ordered walk binds the cursor and the limit after them. */
  readonly params: readonly unknown[];
  /** True: `id > ? ORDER BY id LIMIT ?`, read a page size at a time; false: every row at once. */
  readonly ordered: boolean;
  /** The phase a row must have, judged after the read; absent when every row read is a candidate. */
  readonly phase?: RunPhase;
}

/** The filter's terms a run walk tests, in one order: workflow, key, terminal, the two ranges. */
function runTerms(filter: ScanFilter): Term[] {
  const terms: Term[] = [];
  if (filter.workflow !== undefined) terms.push({ sql: 'workflow_id = ?', value: filter.workflow });
  if (filter.key !== undefined) {
    terms.push({ sql: 'key_hash = ?', value: keyHashOf(filter.workflow!, filter.key) });
  }
  // A record with no `terminal_state` reads NULL in the column and matches neither value.
  if (filter.terminal !== undefined) {
    terms.push({ sql: 'terminal_state = ?', value: filter.terminal ? 1 : 0 });
  }
  if (filter.created_since !== undefined) {
    terms.push({ sql: 'created_at >= ?', value: filter.created_since });
  }
  if (filter.updated_since !== undefined) {
    terms.push({ sql: 'updated_at >= ?', value: filter.updated_since });
  }
  return terms;
}

/** The index the one walk of a filter with no phase and no key reads (the precedence above). */
function runIndexOf(filter: ScanFilter): string {
  const workflow = filter.workflow !== undefined;
  if (workflow && filter.updated_since !== undefined) return 'runs_by_workflow_updated';
  if (workflow && filter.created_since !== undefined) return 'runs_by_workflow_created';
  if (filter.updated_since !== undefined) return 'runs_by_updated';
  if (filter.created_since !== undefined) return 'runs_by_created';
  // `(workflow_id, id)` is a prefix of both workflow indexes.
  if (workflow) return 'runs_by_workflow_updated';
  if (filter.terminal !== undefined) return 'runs_by_terminal';
  return 'sqlite_autoindex_runs_1';
}

/**
 * Every walk a page of `filter` makes, given the running fingerprint and, for a phase filter, the stale
 * stamps the page's probe found (see the module comment). The store builds its statements here and
 * nowhere else.
 */
export function scanWalks(
  filter: ScanFilter,
  running: string,
  staleStamps: readonly unknown[],
): Walk[] {
  const terms = runTerms(filter);
  const runWalk = (index: string, lead: Term[], ordered: boolean, phase?: RunPhase): Walk => {
    const all = [...lead, ...terms];
    const where = [...all.map((term) => term.sql), ...(ordered ? ['id > ?'] : [])];
    return {
      table: 'runs',
      sql:
        `SELECT ${RUN_COLUMNS} FROM runs INDEXED BY ${index} WHERE ${where.join(' AND ')}` +
        (ordered ? ' ORDER BY id LIMIT ?' : ''),
      params: [running, ...all.map((term) => term.value)],
      ordered,
      ...(phase !== undefined ? { phase } : {}),
    };
  };
  const walks: Walk[] = [];
  if (filter.key !== undefined) {
    walks.push(runWalk('runs_by_key', [], false, filter.phase));
  } else if (filter.phase !== undefined) {
    const trusted: Term[] = [
      { sql: 'phase_version = ?', value: running },
      { sql: 'run_phase = ?', value: filter.phase },
    ];
    walks.push(runWalk('runs_by_phase', trusted, true));
    for (const stamp of staleStamps) {
      walks.push(
        runWalk(
          'runs_by_phase_version',
          [{ sql: 'phase_version = ?', value: stamp }],
          true,
          filter.phase,
        ),
      );
    }
  } else {
    walks.push(runWalk(runIndexOf(filter), [], true));
  }
  if (filter.include_purged === true) walks.push(tombstoneWalk(filter));
  return walks;
}

/** The walk over `purged_runs`: by id, or by the key's index under `key`. */
function tombstoneWalk(filter: ScanFilter): Walk {
  const terms: Term[] = [];
  if (filter.workflow !== undefined) terms.push({ sql: 'workflow_id = ?', value: filter.workflow });
  if (filter.key !== undefined) {
    terms.push({ sql: 'key_hash = ?', value: keyHashOf(filter.workflow!, filter.key) });
  }
  // A tombstone's phase is the one stamped when its run was purged: it cannot be derived again.
  if (filter.phase !== undefined) terms.push({ sql: 'run_phase = ?', value: filter.phase });
  const index = filter.key !== undefined ? 'purged_runs_by_key' : 'sqlite_autoindex_purged_runs_1';
  const where = [...terms.map((term) => term.sql), 'id > ?'];
  return {
    table: 'purged_runs',
    sql: `SELECT ${PURGED_COLUMNS} FROM purged_runs INDEXED BY ${index} WHERE ${where.join(' AND ')} ORDER BY id LIMIT ?`,
    params: terms.map((term) => term.value),
    ordered: true,
  };
}

/** A row as SQLite returns it. */
type Row = Record<string, unknown>;

/**
 * The stale stamps a phase filter's page walks, in one snapshot: the distinct `phase_version` values
 * other than `running`, found one index probe at a time (§3). The maintenance handle's re-stamp
 * (`realm db migrate`, c7) finds the stamps it re-stamps here too.
 */
export function staleStampsOf(db: DatabaseLike, running: string): unknown[] {
  const probe = db.prepare(STAMP_PROBE);
  const stamps: unknown[] = [];
  let from: unknown = '';
  for (;;) {
    const stamp = probe.get(from)?.['stamp'];
    if (stamp === null || stamp === undefined) return stamps;
    if (stamp !== running) stamps.push(stamp);
    from = stamp;
  }
}

/** Whether a run row was stamped by another derivation (its document then rides along). */
function isStale(row: Row): boolean {
  return row['stale_record'] !== null;
}

/** A run row's phase: its stamp when the running derivation made it, else derived from its record. */
function phaseOf(row: Row): RunPhase {
  if (!isStale(row)) return row['run_phase'] as RunPhase;
  // The derivation reads seven core fields, none an evidence entry or a write-once field.
  return deriveRunPhase(JSON.parse(String(row['stale_record'])) as RunRecord);
}

/** SQLite's own order of two ids (its BINARY collation compares the UTF-8 bytes). */
function utf8(id: string): Buffer {
  return Buffer.from(id, 'utf8');
}

/** What one walk read for a page: the rows it keeps, and how many stale rows it read. */
interface WalkRead {
  readonly rows: Row[];
  readonly stale: number;
}

/**
 * One walk's rows for the page that starts after `after`. An ordered walk with no phase reads one page
 * size. An ordered walk whose rows are judged after the read reads a page size at a time from its last
 * READ id, until it holds a page size of matches or ends. The key walk reads every row of the key and
 * keeps those after `after`, in SQLite's id order.
 */
function readWalk(db: DatabaseLike, walk: Walk, after: string, pageSize: number): WalkRead {
  const statement = db.prepare(walk.sql);
  const matches = (row: Row): boolean => walk.phase === undefined || phaseOf(row) === walk.phase;
  const staleIn = (rows: readonly Row[]): number =>
    walk.table === 'runs' ? rows.filter(isStale).length : 0;
  if (!walk.ordered) {
    const rows = statement.all(...walk.params);
    const cursor = utf8(after);
    const kept = rows
      .map((row) => ({ row, id: utf8(String(row['id'])) }))
      .filter(({ row, id }) => Buffer.compare(id, cursor) > 0 && matches(row))
      .sort((a, b) => Buffer.compare(a.id, b.id))
      .map(({ row }) => row);
    return { rows: kept, stale: staleIn(rows) };
  }
  if (walk.phase === undefined) {
    const rows = statement.all(...walk.params, after, pageSize);
    return { rows, stale: staleIn(rows) };
  }
  const kept: Row[] = [];
  let stale = 0;
  let from = after;
  for (;;) {
    const batch = statement.all(...walk.params, from, pageSize);
    stale += staleIn(batch);
    for (const row of batch) if (matches(row)) kept.push(row);
    if (batch.length < pageSize || kept.length >= pageSize) return { rows: kept, stale };
    from = String(batch[batch.length - 1]!['id']);
  }
}

/** A stored text column, or `null`. */
function textOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

/** One of the record's three step lists, as `json_extract` gives it (its JSON text). */
function stepList(value: unknown): string[] {
  return value === null || value === undefined ? [] : (JSON.parse(String(value)) as string[]);
}

/** A run row as the `'row'` projection gives it (design §6's facts row). */
function runRow(row: Row): RunRow {
  // eslint-disable-next-line no-restricted-syntax -- a read of the stored column for a scan's row; it reaches no store and carries no seal
  return {
    id: String(row['id']),
    workflow_id: String(row['workflow_id']),
    run_phase: phaseOf(row),
    terminal_state: row['terminal_state'] === 1,
    sealed_by_arm: textOrNull(row['sealed_by_arm']),
    created_at: String(row['created_at']),
    updated_at: String(row['updated_at']),
    idempotency_key: textOrNull(row['idempotency_key']),
    rerun_of: textOrNull(row['rerun_of']),
    run_version: Number(row['version']),
    pending_gate: textOrNull(row['pending_gate_id']),
    completed_steps: stepList(row['completed_steps']),
    in_progress_steps: stepList(row['in_progress_steps']),
    failed_steps: stepList(row['failed_steps']),
  };
}

/** A tombstone as a scan gives it. */
function purgedItem(row: Row): PurgedItem {
  return {
    kind: 'purged',
    run_id: String(row['id']),
    workflow_id: textOrNull(row['workflow_id']),
    purged_at: String(row['purged_at']),
    sealed_by_arm: textOrNull(row['sealed_by_arm']),
    run_phase: row['run_phase'] as RunPhase,
    phase_version: String(row['phase_version']),
  };
}

/** How one page is read: its size, its projection, and the id it starts after (`''`: the start). */
export interface PageRequest {
  readonly pageSize: number;
  readonly projection: 'record' | 'row';
  readonly after: string;
}

/**
 * One page of a scan, in the caller's ONE snapshot taken at `reading`: every walk of `filter` (see the
 * module comment), merged in SQLite's id order and cut at the page size. A run in the `'record'`
 * projection is `toSnapshot`'s (the store's own read of one run, as `get()` judges it); in the `'row'`
 * projection it is its row, with no reassembly. `derived_at_read` counts the run rows read for the page
 * whose stamp is not the running derivation's, matched or not (a tombstone is never derived).
 * `next_after` is the last id when the page is full.
 */
export function readScanPage(
  db: DatabaseLike,
  reading: Date,
  filter: ScanFilter,
  request: PageRequest,
  toSnapshot: (runId: string) => Snapshot,
): ScanPage<'record' | 'row'> {
  const running = runPhaseDerivationFingerprint();
  const stamps =
    filter.phase !== undefined && filter.key === undefined ? staleStampsOf(db, running) : [];
  const candidates: Array<{ row: Row; id: Buffer; table: Walk['table'] }> = [];
  let derived = 0;
  for (const walk of scanWalks(filter, running, stamps)) {
    const read = readWalk(db, walk, request.after, request.pageSize);
    derived += read.stale;
    for (const row of read.rows) {
      candidates.push({ row, id: utf8(String(row['id'])), table: walk.table });
    }
  }
  candidates.sort((a, b) => Buffer.compare(a.id, b.id));
  const cut = candidates.slice(0, request.pageSize);
  const items = cut.map(({ row, table }): ScanItem<'record' | 'row'> => {
    if (table === 'purged_runs') return purgedItem(row);
    const id = String(row['id']);
    return { kind: 'run', run: request.projection === 'row' ? runRow(row) : toSnapshot(id) };
  });
  const page: ScanPage<'record' | 'row'> = {
    items,
    read_at: reading,
    consistent_snapshot: true,
    derived_at_read: derived,
  };
  if (cut.length === request.pageSize) page.next_after = String(cut[cut.length - 1]!.row['id']);
  return page;
}

/** The tombstone horizon, in the caller's transaction. */
export function readHorizon(db: DatabaseLike): string {
  const row = db.prepare(HORIZON).get();
  if (row === undefined)
    throw new Error("The store's meta row is missing: it has no tombstone horizon.");
  return String(row['tombstones_since']);
}

/**
 * Who holds `workflowId`'s key `key`, in the caller's ONE snapshot (design §3): the derived holder
 * ({@link findKeyHolder}) → `held`; else every tombstone `purged_runs` holds for the key → `purged`,
 * with each one's id and `purged_at`, and the horizon; else `unseen`, with the horizon. No record is
 * read, and no other run's.
 */
export function readKeyAnswer(db: DatabaseLike, workflowId: string, key: string): KeyAnswer {
  const holder = findKeyHolder(db, workflowId, key);
  if (holder !== undefined) return { state: 'held', run_id: holder.id };
  const runs = db
    .prepare(KEY_TOMBSTONES)
    .all(workflowId, keyHashOf(workflowId, key))
    .map((row) => ({ run_id: String(row['id']), purged_at: String(row['purged_at']) }));
  const since = readHorizon(db);
  return runs.length > 0 ? { state: 'purged', runs, since } : { state: 'unseen', since };
}
