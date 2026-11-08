// run-import-core.ts — issue #616 PR-2c, unit c11a (design d4-frozen-r3 §5 "Importing runs";
// `plans/issue-616/pr2c/c11/DESIGN-c11.md` §3 and §6): the importer's CORE. One file in, one result
// out: the file is read whole, classified, its run given to the home's `save()`, and the answer is
// one of six words — `imported`, `unchanged`, `diverged`, `purged`, `legacy`, `not_a_run` — with a
// reason and notes, or a STOP. `importLine` turns a word into the file's output line. Nothing here is
// a command: `realm run import` (c11b) prints the lines, walks folders and sets the exit code.
//
// The two documents it reads are Realm's own: a bare run record, and an export bundle
// (`realm run export`), an object whose `realm_export_version` is a number. Versions 4 and 5 are read
// (4 lacks only `disclosure`; the `run` is the same); an older one is `legacy`, a newer one
// `not_a_run`. Everything else that is not a run is `not_a_run`, with what it is. `save()` decides the
// rest; its refusals that are the RECORD's own map to a word, by their code and details. Its refusals
// that are the STORE's own (busy, fenced, full, read-only, a newer file) are a STOP of kind `store`:
// they are not a file's outcome, and re-running the import is safe. Any other error is a STOP of
// kind `unexpected` (the same file would stop it again). The core never maps a stop to a word.
//
// Notes say what a line does not: a run phase the record carried that its derivation does not give
// (the store keeps the derived one), values the export hid (a file's values are imported as they
// are), and what a bundle carries that this import does not take (its write-ahead log, its failed
// attempts, its sealed artifacts). Every string from a file's content or name goes through core's
// `escapedBoundedValue`, its quotes taken off, so no file can make a second line or drive a terminal.
// It reads no clock, caches nothing between files and prints nothing.
import { readFile } from 'node:fs/promises';
import { getSystemErrorMap } from 'node:util';
import { deriveRunPhase, escapedBoundedValue, type RunRecord } from '@sensigo/realm';
import type { SqliteRunStore } from '@sensigo/realm-store-sqlite';

/** What became of one file. */
export type ImportWord = 'imported' | 'unchanged' | 'diverged' | 'purged' | 'legacy' | 'not_a_run';

/** A file's outcome: its word, the reason when there is one, and its notes. */
export interface ImportOutcome {
  readonly kind: 'word';
  /** The file's path, as it was given. */
  readonly path: string;
  readonly word: ImportWord;
  /** Why, for every word but `imported` and `unchanged`. */
  readonly reason: string | undefined;
  /** What the line also says, in order; never on `not_a_run`. */
  readonly notes: readonly string[];
}

/** The import must stop at this file: the store's own failure, or an error nothing expects. */
export interface ImportStop {
  readonly kind: 'stop';
  /** The file's path, as it was given. */
  readonly path: string;
  /** `store`: the store's own refusal (re-running is safe); `unexpected`: anything else. */
  readonly stop: 'store' | 'unexpected';
  /** The error, as `save()` threw it. */
  readonly error: unknown;
}

/** One file's result. */
export type ImportResult = ImportOutcome | ImportStop;

/** The home the core imports into: its run store, the concrete class (`save()` is not on core's). */
export interface ImportHome {
  readonly runStore: SqliteRunStore;
}

/** The oldest and newest export bundle versions this Realm reads. */
const OLDEST_BUNDLE = 4;
const NEWEST_BUNDLE = 5;

/** `save()`'s refusals that are the store's own: not a file's outcome. */
const STORE_STOPS: ReadonlySet<string> = new Set([
  'STATE_RUN_BUSY',
  'STATE_STORE_WRITES_FENCED',
  'STATE_STORE_FULL',
  'STATE_STORE_READONLY',
  'STATE_STORE_VERSION_NEWER',
]);

/** A value from a file, as one printable line piece: escaped and bounded, its JSON quotes taken off. */
function shown(value: unknown): string {
  const text = escapedBoundedValue(value);
  return text.length >= 2 && text.startsWith('"') && text.endsWith('"') ? text.slice(1, -1) : text;
}

/** `<n> <unit>s`, or `1 <unit>`. */
function counted(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The operating system's words for a failed read (`errno`), or the error's own message. */
function systemWords(err: unknown): string {
  const errno = (err as { errno?: unknown }).errno;
  if (typeof errno === 'number') {
    const entry = getSystemErrorMap().get(errno);
    if (entry !== undefined) return entry[1];
  }
  return err instanceof Error ? err.message : String(err);
}

/** A typed error's code and details, read from its fields (the CLI and core can be two copies). */
function codeOf(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}
function detailsOf(err: unknown): Record<string, unknown> {
  const details = (err as { details?: unknown } | null)?.details;
  return isPlainObject(details) ? details : {};
}

/** How many values an export bundle says it hid (`disclosure.hidden`); 0 for a version-4 bundle. */
function hiddenValues(bundle: Record<string, unknown>): number {
  const disclosure = bundle['disclosure'];
  const hidden = isPlainObject(disclosure) ? disclosure['hidden'] : undefined;
  if (!isPlainObject(hidden)) return 0;
  let total = 0;
  for (const kind of ['declared', 'environment', 'pattern']) {
    const n = hidden[kind];
    if (typeof n === 'number') total += n;
  }
  return total;
}

/** How many write-ahead log lines a bundle carries: `wal` is keyed by step id, each value a list. */
function walLines(wal: unknown): number {
  if (!isPlainObject(wal)) return 0;
  let total = 0;
  for (const lines of Object.values(wal)) if (Array.isArray(lines)) total += lines.length;
  return total;
}

/**
 * A file's notes, in order: the re-derived phase (after `imported`), the values the export hid (every
 * word but `not_a_run`; the longer form on a `diverged` line of the content arm), and what a bundle
 * carries that the import does not take (after `imported` or `unchanged`).
 */
function notesFor(
  word: ImportWord,
  record: Record<string, unknown> | undefined,
  bundle: Record<string, unknown> | undefined,
  contentArm: boolean,
): string[] {
  if (word === 'not_a_run') return [];
  const notes: string[] = [];
  if (word === 'imported' && record !== undefined) {
    const derived = deriveRunPhase(record as unknown as RunRecord);
    if (record['run_phase'] !== derived) {
      notes.push(`run_phase re-derived: ${shown(record['run_phase'])} → ${derived}`);
    }
  }
  if (bundle !== undefined) {
    const hidden = hiddenValues(bundle);
    if (hidden > 0) {
      const differs = contentArm ? ', so it may differ from the stored run' : '';
      notes.push(`exported with ${counted(hidden, 'value')} hidden${differs}`);
    }
    if (word === 'imported' || word === 'unchanged') {
      const wal = walLines(bundle['wal']);
      if (wal > 0) notes.push(`wal_not_imported: ${counted(wal, 'line')}`);
      const attempts = bundle['attempts'];
      if (Array.isArray(attempts) && attempts.length > 0) {
        notes.push(`attempts_not_imported: ${counted(attempts.length, 'line')}`);
      }
      const sealed = bundle['sealed'];
      if (isPlainObject(sealed) && Object.keys(sealed).length > 0)
        notes.push('sealed_not_imported');
    }
  }
  return notes;
}

function outcome(
  path: string,
  word: ImportWord,
  reason: string | undefined,
  notes: readonly string[] = [],
): ImportOutcome {
  return { kind: 'word', path, word, reason, notes };
}

/**
 * Reads the file at `path` whole, classifies it, gives its run to `home.runStore.save()` and returns
 * what became of it (see the module comment). Never throws for a file: a refusal is a word, and a
 * store-wide or unexpected failure is a STOP carrying the error.
 */
export async function importFile(path: string, home: ImportHome): Promise<ImportResult> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    return outcome(path, 'not_a_run', `cannot be read: ${shown(systemWords(err))}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return outcome(path, 'not_a_run', 'not JSON');
  }
  if (!isPlainObject(value)) return outcome(path, 'not_a_run', 'not a run: it is not an object');

  let bundle: Record<string, unknown> | undefined;
  let record: Record<string, unknown>;
  const version = value['realm_export_version'];
  if (typeof version === 'number') {
    bundle = value;
    // The version comes first: an old bundle is `legacy` whatever it holds.
    if (version < OLDEST_BUNDLE) {
      return outcome(
        path,
        'legacy',
        `an export of version ${version}, older than the versions this Realm reads (4 and 5)`,
        notesFor('legacy', undefined, bundle, false),
      );
    }
    if (version > NEWEST_BUNDLE) {
      return outcome(
        path,
        'not_a_run',
        `an export of version ${version}, written by a later Realm (this one reads 4 and 5)`,
      );
    }
    const run = value['run'];
    if (!isPlainObject(run)) return outcome(path, 'not_a_run', 'an export without a run');
    record = run;
  } else {
    record = value;
  }

  let saved: 'imported' | 'unchanged';
  try {
    saved = (await home.runStore.save(record as unknown as RunRecord)).outcome;
  } catch (err) {
    return refused(path, err, record, bundle);
  }
  return outcome(path, saved, undefined, notesFor(saved, record, bundle, false));
}

/** What a refusal of `save()` makes of the file: a word for the record's own, a STOP for the rest. */
function refused(
  path: string,
  err: unknown,
  record: Record<string, unknown>,
  bundle: Record<string, unknown> | undefined,
): ImportResult {
  const code = codeOf(err);
  const details = detailsOf(err);
  if (code === 'STATE_RUN_DIVERGED') {
    // Three arms, told apart by the details: the key held, the version, the content.
    if (details['existingOwnerRunId'] !== undefined) {
      return outcome(
        path,
        'diverged',
        `the live run ${shown(details['existingOwnerRunId'])} already holds this run's idempotency key`,
        notesFor('diverged', record, bundle, false),
      );
    }
    if (details['localVersion'] !== details['incomingVersion']) {
      return outcome(
        path,
        'diverged',
        `the stored run is at version ${shown(details['localVersion'])}; the file is at version ` +
          `${shown(details['incomingVersion'])}`,
        notesFor('diverged', record, bundle, false),
      );
    }
    return outcome(
      path,
      'diverged',
      'the stored run has this version and other content',
      notesFor('diverged', record, bundle, true),
    );
  }
  if (code === 'STATE_RUN_PURGED') {
    const day = String(details['purged_at']).slice(0, 10);
    return outcome(
      path,
      'purged',
      `this run was deleted on ${shown(day)}`,
      notesFor('purged', record, bundle, false),
    );
  }
  if (code === 'STATE_LEGACY_FORMAT' || code === 'STATE_RUN_TIMESTAMP_INVALID') {
    if (typeof record['id'] !== 'string') {
      return outcome(
        path,
        'not_a_run',
        bundle === undefined
          ? 'neither a run record nor an export (it has no id)'
          : 'an export whose run has no id',
      );
    }
    const reason =
      code === 'STATE_LEGACY_FORMAT'
        ? 'not in the current run format'
        : `${shown(details['field'])} is not in the current time format`;
    return outcome(path, 'legacy', reason, notesFor('legacy', record, bundle, false));
  }
  return {
    kind: 'stop',
    path,
    stop: code !== undefined && STORE_STOPS.has(code) ? 'store' : 'unexpected',
    error: err,
  };
}

/**
 * The file's output line: `<word>  <path>` (two spaces), then `: <reason>` when there is one, then
 * `  [<note>; <note>]` when there are notes. The path is escaped as every file string is.
 */
export function importLine(result: ImportOutcome): string {
  const reason = result.reason === undefined ? '' : `: ${result.reason}`;
  const notes = result.notes.length === 0 ? '' : `  [${result.notes.join('; ')}]`;
  return `${result.word}  ${shown(result.path)}${reason}${notes}`;
}
