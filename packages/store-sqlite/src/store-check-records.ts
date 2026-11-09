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
// is not judged (c8b2's orphans judge it), nor is a run whose record is not JSON.
//
// Every per-row judgement is kept from throwing: one bad row is one entry in a finding. A scan that
// meets SQLite's corrupt error (`errcode & 0xff` 11) is stopped and says so, and the scans after it
// still run; the results live outside the transaction's body, because after such an error SQLite
// reports it again at the transaction's COMMIT (AUD-C8B1-17), which `snapshot` makes after the body.
// Any other error (the store's busy refusal included) is passed on. The check (`store-check.ts`)
// composes every word of the report from what this returns.
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

/** One scan of the pass: it ran to its end, or SQLite's corrupt error stopped it (its code). */
export type ScanOutcome =
  { readonly done: true } | { readonly done: false; readonly errcode: number };

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

/**
 * Whether a column's stored value is what SQLite stores for the record's value there (Behaviour 2):
 * the value mapped first (a boolean to 1 or 0, null or absent to NULL, an object or array to its JSON
 * text), then given the column's affinity. An object or array is compared as JSON, both texts read
 * back by `JSON.parse`, so the key order and number spelling SQLite keeps do not count as a difference.
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
  const mapped = typeof value === 'boolean' ? (value ? 1 : 0) : value;
  const held = typeof stored === 'bigint' ? Number(stored) : stored;
  if (affinity === 'TEXT') {
    return typeof mapped === 'number' ? held === String(mapped) : held === mapped;
  }
  // INTEGER affinity: a text that reads as a number is stored as that number.
  if (typeof mapped === 'string' && NUMERIC.test(mapped)) return held === Number(mapped);
  return held === mapped;
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
  };
}

/** Runs one scan: done, or stopped by SQLite's corrupt error; any other error is passed on. */
function scan(read: () => void): ScanOutcome {
  try {
    read();
    return { done: true };
  } catch (err) {
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
        finished = true;
      },
      { takesReading: false },
    );
  } catch (err) {
    const errcode = corruptCode(err);
    if (errcode === undefined) throw err;
    // A scan that met the damage said so; SQLite then reports it again at the COMMIT, and what the
    // scans collected stands. A damage met anywhere else leaves no scan to trust.
    const met = [out.runs, out.evidence, out.blobs].some((s) => !s.done && s.errcode !== 0);
    if (!finished || !met) {
      const stopped: ScanOutcome = { done: false, errcode };
      out = { ...collected(), runs: stopped, evidence: stopped, blobs: stopped };
    }
  }
  return out;
}
