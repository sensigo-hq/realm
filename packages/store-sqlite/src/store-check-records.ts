// store-check-records.ts — issue #616 PR-2c, unit c8b1 (design d4-frozen-r3 §8 `realm db check`;
// DELTAS 54): the check's one pass over every run's stored record. It reads, in ONE read transaction
// (`snapshot`, no reading taken), three things, each its own scan:
//   1. the runs, paged by rowid: each stored record parsed once and judged in hand (its phase stamp at
//      the running fingerprint, its key hash, its filter columns as SQLite stores them, the
//      placeholders it holds); a row stamped by another derivation is counted;
//   2. the evidence, through the ladder's one re-check (`checkEvidenceEntries`): each entry's text
//      hashed, never parsed, and each run's rows numbered;
//   3. the blobs, by name only.
// Then each run's placeholders are matched with its evidence rows and blobs. A row whose run is gone
// is not judged here (the orphans read below judges it), nor is a run whose record is not JSON.
//
// In the same transaction, the reads that compare the tables (c8b2): the meta row's purge counter and
// horizon with the count of purged ids; the rows of the five tables whose run is gone; each workflow's
// pointer with its newest registration; and each stored workflow version's hash with its text.
//
// Every per-row judgement is kept from throwing: one bad row is one entry in a finding. A scan that
// meets SQLite's corrupt error (`errcode & 0xff` 11) is stopped and says so, and the scans after it
// still run; the results live outside the transaction's body, because after such an error SQLite
// reports it again at the transaction's COMMIT (AUD-C8B1-17), which `snapshot` makes after the body.
// A stored integer too large for the driver to read stops its scan the same way (correction 1; DELTAS
// "Row 54 addendum"): exactly the driver's `RangeError` with `code: 'ERR_OUT_OF_RANGE'`. Any other
// error (the store's busy refusal included) is passed on. The check (`store-check.ts`) composes every
// word of the report from what this returns.
import {
  deriveRunPhase,
  REALM_STORE_SCHEMA,
  WRITE_ONCE_RUN_FIELDS,
  type RunRecord,
} from '@sensigo/realm';
import { isBusy, type RealmDb } from './connection.js';
import type { DatabaseLike } from './driver.js';
import { isEvidencePlaceholder, isFieldPlaceholder, keyHashOf } from './run-rows.js';
import { checkEvidenceEntries } from './schema-ladder.js';
import { workflowVersionHash } from './workflow-store.js';

/**
 * One scan of the pass: it ran to its end, or SQLite's corrupt error stopped it (its code), or a stored
 * integer too large for the driver to read did.
 */
export type ScanOutcome =
  | { readonly done: true }
  | { readonly done: false; readonly errcode: number }
  | { readonly done: false; readonly tooLarge: true };

/** The purge counter, the horizon and the count of purged ids, as stored. */
export interface Horizon {
  readonly tombSeq: unknown;
  readonly since: unknown;
  readonly throughSeq: unknown;
  readonly purgedIds: unknown;
}

/** A workflow whose pointer does not match its newest registration; `null` where a side is missing. */
export interface PointerWrong {
  readonly workflowId: string;
  readonly pointer: string | null;
  readonly pointerAt: string | null;
  readonly newest: string | null;
  readonly newestAt: string | null;
  /** A stored copy of its own workflow sits under the pointer's hash. */
  readonly copy: boolean;
}

/** What the pass found. A list of a scan that did not finish is not to be read. */
export interface RecordPass {
  readonly runs: ScanOutcome;
  readonly evidence: ScanOutcome;
  readonly blobs: ScanOutcome;
  /** The runs whose stored record is not JSON, in rowid order. */
  readonly unreadable: readonly string[];
  /** The evidence entries whose text does not match their stored hash, in rowid order. */
  readonly evidenceMismatches: readonly { readonly runId: string; readonly seq: unknown }[];
  /** The runs at the running fingerprint whose stored phase differs; `derived` absent: it threw. */
  readonly phaseWrong: readonly {
    readonly runId: string;
    readonly stored: unknown;
    readonly derived?: string;
  }[];
  /** The runs whose key hash does not match their key; `derived` absent: it cannot be computed. */
  readonly keyHashWrong: readonly {
    readonly runId: string;
    readonly stored: unknown;
    readonly derived?: string | null;
  }[];
  /** Each filter column that differs from its record, by run and column. */
  readonly filterDiffers: readonly {
    readonly runId: string;
    readonly column: string;
    readonly stored: unknown;
    readonly record: unknown;
  }[];
  /** Each placeholder that does not match its rows, by run and field (`evidence` or a field's name). */
  readonly placeholderMismatch: readonly { readonly runId: string; readonly field: string }[];
  /** The tombstone reads (c8b2): the meta row, and the count of purged ids. */
  readonly tombstones: ScanOutcome;
  /** What the tombstone reads found; absent when the store has no meta row. */
  readonly horizon?: Horizon;
  /** The five orphan reads (c8b2). */
  readonly orphans: ScanOutcome;
  /** Rows whose run is gone, by table and run, in {@link ORPHAN_TABLES}' order. */
  readonly orphanRows: readonly {
    readonly table: string;
    readonly runId: string;
    readonly rows: number;
  }[];
  /** The pointer read (c8b2). */
  readonly pointers: ScanOutcome;
  /** Each workflow whose pointer does not match its newest registration. */
  readonly pointerWrong: readonly PointerWrong[];
  /** The versions read (c8b2). */
  readonly versions: ScanOutcome;
  /** Each stored workflow version whose hash is not its text's. */
  readonly versionWrong: readonly { readonly workflowId: string; readonly hash: string }[];
  /** How many runs another phase derivation stamped. */
  readonly otherStamps: number;
}

/** How many runs one page of the runs scan reads (the driver pages with `all()`; AUD-C8B1-09). */
export const RECORDS_PAGE = 500;

/** A generated column of `runs`: its name, the record's path it reads, and its type affinity. */
interface FilterColumn {
  readonly name: string;
  readonly path: readonly string[];
  readonly affinity: 'TEXT' | 'INTEGER';
}

const GENERATED =
  /^\s*(\w+) (TEXT|INTEGER) GENERATED ALWAYS AS \(json_extract\(record, '\$\.([\w.]+)'\)\) STORED,?$/gm;

let columns: readonly FilterColumn[] | undefined;

/** The generated columns of `runs`, as this version's schema declares them (`store-schema.ts`). */
export function filterColumns(): readonly FilterColumn[] {
  if (columns !== undefined) return columns;
  const runs = REALM_STORE_SCHEMA.find((statement) => statement.startsWith('CREATE TABLE runs ('));
  const found = [...(runs ?? '').matchAll(GENERATED)].map((m) => ({
    name: m[1]!,
    path: m[3]!.split('.'),
    affinity: m[2] as 'TEXT' | 'INTEGER',
  }));
  if (found.length === 0) {
    throw new Error(
      "The runs table's generated columns cannot be read from the schema. This is a bug in the store.",
    );
  }
  columns = found;
  return found;
}

/** What a path reads when a parent on it is not an object, or its key is not there. */
const ABSENT = Symbol('absent');

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The record's value at `path`, as `json_extract` walks it: through objects only. */
function at(record: unknown, path: readonly string[]): unknown {
  let value = record;
  for (const key of path) {
    if (!isObject(value) || !Object.hasOwn(value, key)) return ABSENT;
    value = value[key];
  }
  return value;
}

/** A number in SQLite's text form for a numeric literal (what TEXT or INTEGER affinity converts). */
const NUMERIC = /^\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?\s*$/;

/** A surrogate with no partner: in `u` mode a pair is one code point, outside this range. */
const LONE_SURROGATE = /[\uD800-\uDFFF]/gu;

/**
 * Text as the driver reads it back from a column (correction 1): `JSON.stringify` writes a lone
 * surrogate as an escape, SQLite stores it as three bytes that are not UTF-8 (ED A0 BD), and the
 * driver decodes each of them as U+FFFD (AUD-C8B1C1-01).
 */
function asReadBack(text: string): string {
  return text.replace(LONE_SURROGATE, '\uFFFD\uFFFD\uFFFD');
}

/**
 * Whether a column's stored value is what SQLite stores for the record's value there (Behaviour 2):
 * the value mapped first (a boolean to 1 or 0, null or absent to NULL, an object or array to its JSON
 * text), then given the column's affinity. An object or array is compared as JSON, both texts read
 * back by `JSON.parse`, so the key order and number spelling SQLite keeps do not count as a difference;
 * it keeps a lone surrogate's escape as written, so only plain text is mapped to its read-back form.
 */
function storedAs(stored: unknown, value: unknown, affinity: 'TEXT' | 'INTEGER'): boolean {
  if (value === ABSENT || value === null) return stored === null;
  if (typeof value === 'object') {
    if (typeof stored !== 'string') return false;
    try {
      return JSON.stringify(JSON.parse(stored)) === JSON.stringify(value);
    } catch {
      return false;
    }
  }
  const mapped =
    typeof value === 'boolean'
      ? value
        ? 1
        : 0
      : typeof value === 'string'
        ? asReadBack(value)
        : value;
  if (affinity === 'TEXT') {
    return typeof mapped === 'number' ? stored === String(mapped) : stored === mapped;
  }
  // INTEGER affinity: a text that reads as a number is stored as that number.
  if (typeof mapped === 'string' && NUMERIC.test(mapped)) return stored === Number(mapped);
  return stored === mapped;
}

/** SQLite's corrupt error (11) and its extended codes (267, 523, 779), as a code; `undefined` for any
 *  other error. The check's integrity check reads it too. */
export function corruptCode(err: unknown): number | undefined {
  const errcode = (err as { errcode?: unknown }).errcode;
  return typeof errcode === 'number' && (errcode & 0xff) === 11 ? errcode : undefined;
}

/** What one run's record holds that its rows must match. */
interface Expected {
  /** The evidence rows its placeholder counts; absent when the placeholder is not well formed. */
  readonly rows: number | undefined;
  /** The write-once fields it holds as well-formed placeholders. */
  readonly blobs: Set<string>;
  /** The fields already wrong in the record itself (`evidence`, a write-once field's name). */
  readonly wrong: string[];
}

/** One run's evidence rows: how many, and their lowest and highest seq; `odd` when one is not an integer. */
interface Numbered {
  count: number;
  min: number;
  max: number;
  odd: boolean;
}

type Row = Record<string, unknown>;

/** A pass under way: what the scans collected so far. */
interface Collected {
  runs: ScanOutcome;
  evidence: ScanOutcome;
  blobs: ScanOutcome;
  unreadable: string[];
  evidenceMismatches: { runId: string; seq: unknown }[];
  phaseWrong: { runId: string; stored: unknown; derived?: string }[];
  keyHashWrong: { runId: string; stored: unknown; derived?: string | null }[];
  filterDiffers: { runId: string; column: string; stored: unknown; record: unknown }[];
  placeholderMismatch: { runId: string; field: string }[];
  otherStamps: number;
  tombstones: ScanOutcome;
  horizon?: Horizon;
  orphans: ScanOutcome;
  orphanRows: { table: string; runId: string; rows: number }[];
  pointers: ScanOutcome;
  pointerWrong: PointerWrong[];
  versions: ScanOutcome;
  versionWrong: { workflowId: string; hash: string }[];
}

const NOT_RUN: ScanOutcome = { done: false, errcode: 0 };

function collected(): Collected {
  return {
    runs: NOT_RUN,
    evidence: NOT_RUN,
    blobs: NOT_RUN,
    unreadable: [],
    evidenceMismatches: [],
    phaseWrong: [],
    keyHashWrong: [],
    filterDiffers: [],
    placeholderMismatch: [],
    otherStamps: 0,
    tombstones: NOT_RUN,
    orphans: NOT_RUN,
    orphanRows: [],
    pointers: NOT_RUN,
    pointerWrong: [],
    versions: NOT_RUN,
    versionWrong: [],
  };
}

/** The driver's refusal of a stored integer past 2^53: exactly this error, no other `RangeError`. */
function isTooLargeInteger(err: unknown): boolean {
  return err instanceof RangeError && (err as { code?: unknown }).code === 'ERR_OUT_OF_RANGE';
}

/** Runs one scan: done, or stopped by SQLite's corrupt error or a too-large integer; any other error
 *  is passed on. */
function scan(read: () => void): ScanOutcome {
  try {
    read();
    return { done: true };
  } catch (err) {
    if (isTooLargeInteger(err)) return { done: false, tooLarge: true };
    const errcode = isBusy(err) ? undefined : corruptCode(err);
    if (errcode === undefined) throw err;
    return { done: false, errcode };
  }
}

/** Judges one run's row in hand; nothing it finds throws. */
function judgeRun(
  row: Row,
  running: string,
  out: Collected,
  expected: Map<string, Expected>,
): void {
  const runId = String(row['id']);
  const stamped = row['phase_version'] === running;
  if (!stamped) out.otherStamps += 1;
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(row['record']));
  } catch {
    out.unreadable.push(runId);
    return;
  }
  // A record that is JSON but not an object has no fields, as SQLite reads it.
  const record: Record<string, unknown> = isObject(parsed) ? parsed : {};

  // The phase stamp: only a row the running derivation stamped claims the derivation's answer.
  if (stamped) {
    let derived: string | undefined;
    try {
      derived = deriveRunPhase(record as unknown as RunRecord);
    } catch {
      derived = undefined;
    }
    if (derived === undefined || derived !== row['run_phase']) {
      out.phaseWrong.push({
        runId,
        stored: row['run_phase'],
        ...(derived === undefined ? {} : { derived }),
      });
    }
  }

  // The key hash, judged on the parsed values: no key, no hash; a key or workflow id that is not
  // text has no hash Realm could have made.
  const key = record['idempotency_key'];
  const workflowId = record['workflow_id'];
  const derived =
    key === undefined || key === null
      ? null
      : typeof key === 'string' && typeof workflowId === 'string'
        ? keyHashOf(workflowId, key)
        : undefined;
  if (derived === undefined || row['key_hash'] !== derived) {
    out.keyHashWrong.push({
      runId,
      stored: row['key_hash'],
      ...(derived === undefined ? {} : { derived }),
    });
  }

  // Each filter column, compared as SQLite stores the record's value there.
  for (const column of filterColumns()) {
    const value = at(record, column.path);
    if (!storedAs(row[column.name], value, column.affinity)) {
      out.filterDiffers.push({
        runId,
        column: column.name,
        stored: row[column.name],
        record: value === ABSENT ? null : value,
      });
    }
  }

  // What the record's placeholders say its rows are.
  const evidence = record['evidence'];
  const wrong: string[] = [];
  const rows = isEvidencePlaceholder(evidence)
    ? ((evidence as Record<string, unknown>)['$realm_rows'] as number)
    : undefined;
  if (rows === undefined) wrong.push('evidence');
  const blobs = new Set<string>();
  for (const name of WRITE_ONCE_RUN_FIELDS) {
    if (!Object.hasOwn(record, name)) continue;
    if (isFieldPlaceholder(record[name], name)) blobs.add(name);
    else wrong.push(name);
  }
  expected.set(runId, { rows, blobs, wrong });
}

function runsSelect(where: string): string {
  const generated = filterColumns()
    .map((column) => column.name)
    .join(', ');
  return `SELECT rowid AS r, id, record, run_phase, phase_version, key_hash, ${generated} FROM runs ${where} ORDER BY rowid LIMIT ?`;
}

/** The runs scan: every run's row, a page at a time in rowid order. */
function scanRuns(
  c: DatabaseLike,
  running: string,
  out: Collected,
  expected: Map<string, Expected>,
): void {
  const next = c.prepare(runsSelect('WHERE rowid > ?'));
  let page = c.prepare(runsSelect('')).all(RECORDS_PAGE);
  while (page.length > 0) {
    for (const row of page) judgeRun(row, running, out, expected);
    if (page.length < RECORDS_PAGE) break;
    page = next.all(page[page.length - 1]!['r'], RECORDS_PAGE);
  }
}

/** The evidence scan: the ladder's re-check, every mismatch kept, each run's rows numbered. */
function scanEvidence(c: DatabaseLike, out: Collected, numbered: Map<string, Numbered>): void {
  checkEvidenceEntries(c, (entry) => {
    if (!entry.matches) out.evidenceMismatches.push({ runId: entry.runId, seq: entry.seq });
    const seq = Number(entry.seq);
    const held = numbered.get(entry.runId);
    const odd = typeof entry.seq !== 'number' || !Number.isInteger(seq);
    if (held === undefined) {
      numbered.set(entry.runId, { count: 1, min: seq, max: seq, odd });
    } else {
      held.count += 1;
      held.min = Math.min(held.min, seq);
      held.max = Math.max(held.max, seq);
      held.odd ||= odd;
    }
  });
}

/** The blob scan: each run's blob names (never their values). */
function scanBlobs(c: DatabaseLike, names: Map<string, Set<string>>): void {
  for (const row of c.prepare('SELECT run_id, name FROM run_blobs').all()) {
    const runId = String(row['run_id']);
    const held = names.get(runId) ?? new Set<string>();
    held.add(String(row['name']));
    names.set(runId, held);
  }
}

/** Matches each judged run's placeholders with its rows (Behaviour 3). */
function judgePlaceholders(
  expected: Map<string, Expected>,
  numbered: Map<string, Numbered>,
  names: Map<string, Set<string>>,
  out: Collected,
): void {
  for (const [runId, held] of expected) {
    const wrong = new Set(held.wrong);
    const rows = numbered.get(runId);
    if (held.rows !== undefined) {
      const count = rows?.count ?? 0;
      const exact =
        count === held.rows &&
        (count === 0 ||
          (rows !== undefined && !rows.odd && rows.min === 0 && rows.max === count - 1));
      if (!exact) wrong.add('evidence');
    }
    const blobs = names.get(runId) ?? new Set<string>();
    for (const name of held.blobs) if (!blobs.has(name)) wrong.add(name);
    for (const name of blobs) if (!held.blobs.has(name)) wrong.add(name);
    for (const field of wrong) out.placeholderMismatch.push({ runId, field });
  }
}

/** The meta row's counter and horizon, and the count of purged ids (c8b2). No meta row, no horizon. */
function scanTombstones(c: DatabaseLike, out: Collected): void {
  const meta = c
    .prepare(
      'SELECT tomb_seq, tombstones_since, tombstones_through_seq FROM store_meta WHERE one = 1',
    )
    .get();
  if (meta === undefined) return;
  const purged = c.prepare('SELECT count(*) AS n FROM purged_ids').get();
  out.horizon = {
    tombSeq: meta['tomb_seq'],
    since: meta['tombstones_since'],
    throughSeq: meta['tombstones_through_seq'],
    purgedIds: purged?.['n'],
  };
}

/** The tables that hold a run's rows, each judged for rows whose run is gone. */
export const ORPHAN_TABLES = [
  'evidence',
  'run_blobs',
  'trace_buffer',
  'trace_sealed',
  'failed_attempts',
] as const;

/** Every row whose run is gone, counted by table and run (c8b2). */
function scanOrphans(c: DatabaseLike, out: Collected): void {
  for (const table of ORPHAN_TABLES) {
    const rows = c
      .prepare(
        `SELECT t.run_id AS run_id, count(*) AS n FROM ${table} t WHERE NOT EXISTS (SELECT 1 FROM runs r WHERE r.id = t.run_id) GROUP BY t.run_id ORDER BY t.run_id`,
      )
      .all();
    for (const row of rows) {
      out.orphanRows.push({ table, runId: String(row['run_id']), rows: Number(row['n']) });
    }
  }
}

/** Each workflow's pointer beside its newest registration (by seq), and whether its copy is stored. */
const POINTERS = `SELECT coalesce(w.id, n.id) AS id, w.current_hash AS pointer, w.registered_at AS pointer_at,
  n.hash AS newest, n.registered_at AS newest_at,
  EXISTS (SELECT 1 FROM workflow_versions v WHERE v.hash = w.current_hash AND v.id = w.id) AS copy
FROM workflows w FULL JOIN (
  SELECT r.id, r.hash, r.registered_at FROM workflow_registrations r
  WHERE r.seq = (SELECT max(m.seq) FROM workflow_registrations m WHERE m.id = r.id)
) n ON n.id = w.id ORDER BY 1`;

/** Text or NULL, as a pointer read returns it. */
function textOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

/** The workflows whose pointer does not match their newest registration (c8b2). */
function scanPointers(c: DatabaseLike, out: Collected): void {
  for (const row of c.prepare(POINTERS).all()) {
    const copy = row['copy'] === 1;
    const pointer = textOrNull(row['pointer']);
    const pointerAt = textOrNull(row['pointer_at']);
    const newest = textOrNull(row['newest']);
    const newestAt = textOrNull(row['newest_at']);
    if (
      pointer === null ||
      !copy ||
      newest === null ||
      pointer !== newest ||
      pointerAt !== newestAt
    ) {
      out.pointerWrong.push({
        workflowId: String(row['id']),
        pointer,
        pointerAt,
        newest,
        newestAt,
        copy,
      });
    }
  }
}

/** Every stored workflow version whose hash is not its text's, a page at a time (c8b2). */
function scanVersions(c: DatabaseLike, out: Collected): void {
  const select = (where: string): string =>
    `SELECT rowid AS r, hash, id, definition FROM workflow_versions ${where} ORDER BY rowid LIMIT ?`;
  const next = c.prepare(select('WHERE rowid > ?'));
  let page = c.prepare(select('')).all(RECORDS_PAGE);
  while (page.length > 0) {
    for (const row of page) {
      if (workflowVersionHash(String(row['definition'])) !== row['hash']) {
        out.versionWrong.push({ workflowId: String(row['id']), hash: String(row['hash']) });
      }
    }
    if (page.length < RECORDS_PAGE) break;
    page = next.all(page[page.length - 1]!['r'], RECORDS_PAGE);
  }
}

/**
 * The pass (see the module comment), on the check's read-only connection. `running` is the running
 * phase derivation's fingerprint. Rejects only with an error that is not SQLite's corrupt error.
 */
export async function readRecords(db: RealmDb, running: string): Promise<RecordPass> {
  let out = collected();
  let finished = false;
  try {
    await db.snapshot(
      (c) => {
        // The store's busy wait may run the body again: each run starts afresh.
        out = collected();
        finished = false;
        const expected = new Map<string, Expected>();
        const numbered = new Map<string, Numbered>();
        const names = new Map<string, Set<string>>();
        out.runs = scan(() => scanRuns(c, running, out, expected));
        out.evidence = scan(() => scanEvidence(c, out, numbered));
        out.blobs = scan(() => scanBlobs(c, names));
        if (out.runs.done && out.evidence.done && out.blobs.done) {
          judgePlaceholders(expected, numbered, names, out);
        }
        out.tombstones = scan(() => scanTombstones(c, out));
        out.orphans = scan(() => scanOrphans(c, out));
        out.pointers = scan(() => scanPointers(c, out));
        out.versions = scan(() => scanVersions(c, out));
        finished = true;
      },
      { takesReading: false },
    );
  } catch (err) {
    const errcode = corruptCode(err);
    if (errcode === undefined) throw err;
    // A scan that met the damage said so; SQLite then reports it again at the COMMIT, and what the
    // scans collected stands. A damage met anywhere else leaves no scan to trust.
    const all = [
      out.runs,
      out.evidence,
      out.blobs,
      out.tombstones,
      out.orphans,
      out.pointers,
      out.versions,
    ];
    const met = all.some((s) => s !== NOT_RUN && !s.done);
    if (!finished || !met) {
      const stopped: ScanOutcome = { done: false, errcode };
      out = {
        ...collected(),
        runs: stopped,
        evidence: stopped,
        blobs: stopped,
        tombstones: stopped,
        orphans: stopped,
        pointers: stopped,
        versions: stopped,
      };
    }
  }
  return out;
}
