// run-file.ts — issue #719: ONE reader for a run file of the JSON store, and ONE composer for what
// a damaged stored JSON file says — a run file here, a registered workflow copy in the registrar.
// A damaged file is classified by what its bytes ARE, never by the parser's message: that message
// quotes the file around the fault, and a run file's params can hold a token.
import { basename, dirname } from 'node:path';
import { readIfExists, FsIoError, errnoCode, isRetryableArtifactErrno } from './fs-io.js';
import { WorkflowError } from '../types/workflow-error.js';
import type { RunRecord } from '../types/run-record.js';
import {
  runRecordFieldProblems,
  runRecordProblemClause,
  type RunRecordFieldProblem,
} from '../types/run-record-shape.js';
import { withFullStop } from '../engine/pending.js';

/**
 * What a damaged stored JSON file is (issue #719, R7) — the shipped vocabulary of the registrar's
 * listing, plus the run-only classes:
 *  - `empty`: zero bytes, or whitespace only;
 *  - `parse`: not JSON, or JSON that is not an object (`shape` says what it is);
 *  - `not_a_run`: an object that is not a run record (`fields` names what is missing or mistyped);
 *  - `mismatched`: a run record whose `id` is not the file's name (`held_id`);
 *  - `legacy`: written by an earlier Realm (`state` without `completed_steps`);
 *  - `unreadable`: the file cannot be read (`errno`).
 */
export const STORED_FILE_CLASSES = [
  'empty',
  'parse',
  'not_a_run',
  'mismatched',
  'legacy',
  'unreadable',
] as const;
export type StoredFileClass = (typeof STORED_FILE_CLASSES)[number];

/**
 * The facts of one damaged stored file (issue #719, R7): names, classes and type words — never its
 * content. Written as the `details` of every such error, on run files and on the registrar's
 * `empty` and `parse` failures. The `details` slot is temporary: #729 PR-0 moves these facts to
 * `error.facts`; read them through {@link unreadableFactsOf}.
 */
export interface UnreadableFileFacts {
  resource: 'run_file' | 'workflow_copy';
  class: StoredFileClass;
  path: string;
  /** `unreadable` only: the operating system's error code. */
  errno?: string;
  /** `parse` only, for JSON that is not an object: `null`, `array`, `string`, `number` or `boolean`. */
  shape?: string;
  /** `mismatched` only: the run id the file holds. */
  held_id?: string;
  /** `not_a_run` only: each required field missing or of the wrong type (names only). */
  fields?: RunRecordFieldProblem[];
}

/** The facts a damaged-file error carries, or `undefined` for any other error — the ONE reader. */
export function unreadableFactsOf(err: unknown): UnreadableFileFacts | undefined {
  if (!(err instanceof WorkflowError)) return undefined;
  const resource = err.details['resource'];
  if (resource !== 'run_file' && resource !== 'workflow_copy') return undefined;
  return err.details as unknown as UnreadableFileFacts;
}

/** The file's name without `.json` — a run file's run id, a registered copy's workflow id. */
function fileId(path: string): string {
  const name = basename(path);
  return name.endsWith('.json') ? name.slice(0, -'.json'.length) : name;
}

/** JSON that is not an object, as one word. */
export function jsonShapeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** At most this many fields are named in a `not_a_run` clause; the rest are counted. */
const NAMED_FIELDS = 3;

/**
 * What is wrong with the file, as a clause after its subject (issue #719, R8): no parser text and
 * no position, ever. A registered copy keeps its shipped nouns ("not a workflow object", "empty
 * (0 bytes) — not a workflow").
 */
export function describeStoredFileFault(facts: UnreadableFileFacts): string {
  const workflow = facts.resource === 'workflow_copy';
  switch (facts.class) {
    case 'empty':
      return workflow ? 'is empty (0 bytes) — not a workflow' : 'is empty';
    case 'parse':
      return facts.shape === undefined
        ? 'is not JSON'
        : `is JSON but not ${workflow ? 'a workflow object' : 'an object'} (it is ${facts.shape})`;
    case 'not_a_run': {
      const fields = facts.fields ?? [];
      const named = fields.slice(0, NAMED_FIELDS).map(runRecordProblemClause);
      const more = fields.length - named.length;
      const tail = more > 0 ? `; …and ${more} more` : '';
      return `is JSON but not a run record (${named.join('; ')}${tail})`;
    }
    case 'mismatched':
      return `holds run '${facts.held_id ?? ''}', not '${fileId(facts.path)}'`;
    case 'legacy':
      return 'is in the format of an earlier Realm';
    case 'unreadable':
      return `cannot be read (${facts.errno ?? 'unknown'})`;
  }
}

/** Whether a damaged file's error is worth retrying: only a read error, by the store's errno rule. */
function retryableFor(facts: UnreadableFileFacts): boolean {
  return facts.class === 'unreadable' && isRetryableArtifactErrno(facts.errno ?? 'UNKNOWN');
}

/** A run file's fault, as its sentence: `The run file '<path>' <fault clause>.` */
export function runFileFaultSentence(facts: UnreadableFileFacts): string {
  return withFullStop(`The run file '${facts.path}' ${describeStoredFileFault(facts)}`);
}

/**
 * The way out for a damaged run file (issue #719, B5): what to do, and what it does to the run's
 * key and its side files. No new command and no new state — a restore, a repair or a move.
 */
export function runFileWayOut(facts: UnreadableFileFacts): string {
  const folder = dirname(facts.path);
  const id = fileId(facts.path);
  const moveWithSideFiles = `move it out of '${folder}' together with every file there whose name contains '${id}'`;
  const keyEffect =
    'If it held an idempotency key, the next delivery with that key starts a new run.';
  switch (facts.class) {
    case 'empty':
    case 'parse':
    case 'not_a_run':
      return withFullStop(
        `Restore '${facts.path}' from a backup or repair it; the run and its key are kept. Or ` +
          `${moveWithSideFiles} (its attempt log and trace files; moved alone, they become ` +
          `orphans that 'realm run gc --force' deletes). ${keyEffect}`,
      );
    case 'mismatched': {
      const held = facts.held_id ?? '';
      return withFullStop(
        `It is named '${id}' but holds run '${held}'. If it is a copy, move it out of ` +
          `'${folder}'; run '${held}' is not affected`,
      );
    }
    case 'legacy':
      return withFullStop(
        `It was written by an earlier Realm. Restore it from a backup of that version, or ` +
          `${moveWithSideFiles}. ${keyEffect}`,
      );
    case 'unreadable':
      return (
        withFullStop(
          `Check that '${facts.path}' is a file this user can read; this file was not changed`,
        ) + (retryableFor(facts) ? ' Then retry.' : '')
      );
  }
}

/** The sentence a keyed create adds (issue #719, B4). */
const KEYED_CREATE_SENTENCE =
  'A run with a new idempotency key cannot be created on this store until the file is repaired or moved out.';

/**
 * issue #719 — the ONE composer for a damaged stored file's message, data in: built from the facts
 * alone (no error object, no record, no parser text), so every surface — and #729 PR-0's renderers
 * — says the same words. A run file: its fault sentence, the keyed-create sentence when asked, and
 * the way out. A registered workflow copy: the registrar's subject and the fault clause (its repair
 * act is the registrar's own, `repairActFor`).
 */
export function renderUnreadableStoredFile(
  facts: UnreadableFileFacts,
  options: { keyedCreate?: boolean } = {},
): string {
  if (facts.resource === 'workflow_copy') {
    return `the registered copy of '${fileId(facts.path)}' ${describeStoredFileFault(facts)}`;
  }
  return [
    runFileFaultSentence(facts),
    ...(options.keyedCreate === true ? [KEYED_CREATE_SENTENCE] : []),
    runFileWayOut(facts),
  ].join(' ');
}

/**
 * The typed error for a damaged run file (issue #719, B2): `unreadable` → `ENGINE_STORE_FAILED`
 * (retryable by its errno); `legacy` → `STATE_LEGACY_FORMAT`; every other class →
 * `RESOURCE_FORMAT_INVALID`. Its details are the facts.
 */
export function unreadableRunFileError(
  facts: UnreadableFileFacts,
  options: { keyedCreate?: boolean } = {},
): WorkflowError {
  const message = renderUnreadableStoredFile(facts, options);
  const details = { ...facts } as unknown as Record<string, unknown>;
  if (facts.class === 'unreadable') {
    return new WorkflowError(message, {
      code: 'ENGINE_STORE_FAILED',
      category: 'ENGINE',
      agentAction: 'stop',
      retryable: retryableFor(facts),
      details,
    });
  }
  if (facts.class === 'legacy') {
    return new WorkflowError(message, {
      code: 'STATE_LEGACY_FORMAT',
      category: 'STATE',
      agentAction: 'report_to_user',
      retryable: false,
      details,
    });
  }
  return new WorkflowError(message, {
    code: 'RESOURCE_FORMAT_INVALID',
    category: 'RESOURCE',
    agentAction: 'stop',
    retryable: false,
    details,
  });
}

/**
 * The runs folder itself cannot be read (issue #719, B1): `ENGINE_STORE_FAILED` naming the folder,
 * retryable by its errno.
 */
export function runsFolderUnreadableError(folder: string, err: unknown): WorkflowError {
  const errno = err instanceof FsIoError ? err.code : (errnoCode(err) ?? 'UNKNOWN');
  const facts: UnreadableFileFacts = {
    resource: 'run_file',
    class: 'unreadable',
    path: folder,
    errno,
  };
  const retryable = retryableFor(facts);
  return new WorkflowError(
    `The runs folder '${folder}' cannot be read (${errno}). Check that '${folder}' is a folder ` +
      `this user can read; nothing in it was changed.${retryable ? ' Then retry.' : ''}`,
    {
      code: 'ENGINE_STORE_FAILED',
      category: 'ENGINE',
      agentAction: 'stop',
      retryable,
      details: { ...facts },
    },
  );
}

/**
 * issue #719 (R10, B3) — a decision over EVERY run (`realm run reconcile`, `realm run gc --heal`)
 * fails closed when any run file cannot be read: ONE error naming every such file, and nothing is
 * written. `RESOURCE_FORMAT_INVALID` when every file's fault is in its bytes, else
 * `ENGINE_STORE_FAILED`.
 */
export function unreadableRunFilesError(
  command: string,
  runsFolder: string,
  files: readonly UnreadableFileFacts[],
): WorkflowError {
  const anyUnreadable = files.some((f) => f.class === 'unreadable');
  const lines = [
    `${command} did not run: ${files.length} run file(s) in '${runsFolder}' could not be read:`,
    ...files.map((f) => `  ${f.path}: ${describeStoredFileFault(f)}`),
    `Repair, restore or move each one out ('realm run list' shows each file's way out), then run ${command} again.`,
  ];
  return new WorkflowError(lines.join('\n'), {
    code: anyUnreadable ? 'ENGINE_STORE_FAILED' : 'RESOURCE_FORMAT_INVALID',
    category: anyUnreadable ? 'ENGINE' : 'RESOURCE',
    agentAction: 'stop',
    retryable: files.length > 0 && files.every(retryableFor),
    details: { files: files.map((f) => ({ ...f })) },
  });
}

/** What one run file holds (issue #719, B1). */
export type RunFileReading =
  | { kind: 'record'; record: RunRecord }
  | { kind: 'absent' }
  | {
      kind: 'damaged';
      facts: UnreadableFileFacts;
      /** The parsed object, for the classes that have one (`legacy`, `not_a_run`, `mismatched`). */
      object?: Record<string, unknown>;
    };

/**
 * Reads one run file and says what it holds, in this order (issue #719, B1): a read error other
 * than `ENOENT` → `unreadable`; `ENOENT` → absent; zero bytes or whitespace only → `empty`; not
 * JSON, or JSON that is not an object → `parse`; an object with `state` and without
 * `completed_steps` → `legacy`; an object that is not a run record → `not_a_run`; a record whose
 * `id` is not the file's name → `mismatched`. No class is decided from the parser's message.
 */
export async function inspectRunFile(path: string, expectedId: string): Promise<RunFileReading> {
  let raw: string | undefined;
  try {
    raw = await readIfExists(path);
  } catch (err) {
    const errno = err instanceof FsIoError ? err.code : (errnoCode(err) ?? 'UNKNOWN');
    return { kind: 'damaged', facts: { resource: 'run_file', class: 'unreadable', path, errno } };
  }
  if (raw === undefined) return { kind: 'absent' };
  if (raw.trim() === '') {
    return { kind: 'damaged', facts: { resource: 'run_file', class: 'empty', path } };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'damaged', facts: { resource: 'run_file', class: 'parse', path } };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      kind: 'damaged',
      facts: { resource: 'run_file', class: 'parse', path, shape: jsonShapeOf(parsed) },
    };
  }
  const object = parsed as Record<string, unknown>;
  if ('state' in object && !('completed_steps' in object)) {
    return { kind: 'damaged', facts: { resource: 'run_file', class: 'legacy', path }, object };
  }
  const fields = runRecordFieldProblems(object);
  if (fields.length > 0) {
    return {
      kind: 'damaged',
      facts: { resource: 'run_file', class: 'not_a_run', path, fields },
      object,
    };
  }
  if (object['id'] !== expectedId) {
    return {
      kind: 'damaged',
      facts: { resource: 'run_file', class: 'mismatched', path, held_id: String(object['id']) },
      object,
    };
  }
  return { kind: 'record', record: object as unknown as RunRecord };
}

/**
 * The reader every run-file read of the JSON store goes through (issue #719, B1): the record, or
 * `undefined` when the file is absent (`ENOENT` — each caller decides what that means), or THROWS
 * the damaged file's typed error ({@link unreadableRunFileError}).
 */
export async function readRunFile(
  path: string,
  expectedId: string,
): Promise<RunRecord | undefined> {
  const reading = await inspectRunFile(path, expectedId);
  if (reading.kind === 'record') return reading.record;
  if (reading.kind === 'absent') return undefined;
  throw unreadableRunFileError(reading.facts);
}
