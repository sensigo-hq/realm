// run-file.ts — issue #719: ONE reader for a run file of the JSON store, and ONE composer for what
// a damaged stored JSON file says — a run file and the runs folder here, a registered workflow
// copy in the registrar. A damaged file is classified by what its bytes ARE, never by the parser's
// message: that message quotes the file around the fault, and a run file's params can hold a token.
import { readdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { readIfExists, FsIoError, errnoCode, isRetryableArtifactErrno } from './fs-io.js';
import { SIDECAR_SUFFIX } from './failed-attempt-store.js';
import { WorkflowError } from '../types/workflow-error.js';
import type { RunRecord } from '../types/run-record.js';
import {
  runRecordFieldProblems,
  runRecordProblemClause,
  type RunRecordFieldProblem,
} from '../types/run-record-shape.js';
import { withFullStop } from '../engine/pending.js';
import { quotedCommand } from '../utils/shell-word.js';

/**
 * What a damaged stored JSON file is (issue #719, R7) — the shipped vocabulary of the registrar's
 * listing, plus the run-only classes:
 *  - `empty`: zero bytes, or whitespace only;
 *  - `parse`: not JSON, or JSON that is not an object (`shape` says what it is);
 *  - `not_a_run`: an object that is not a run record (`fields` names what is missing or mistyped);
 *  - `mismatched`: a run record whose `id` is not the file's name (`held_id`, `held_file`);
 *  - `legacy`: written by an earlier Realm (`state` without `completed_steps`);
 *  - `unreadable`: the file (or the runs folder) cannot be read (`errno`).
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
 * The trace files the MCP server writes beside a run's file, by name (issue #719, C2): a step's
 * write-ahead buffer `trace-buffer-<runId>-<step>.jsonl` and its sealed copies
 * `sealed-trace-<runId>-<step>.<seq>.jsonl`. Defined once here, in core, because the way out of a
 * damaged run file names them; `json-trace-buffer-store.ts` (mcp-server) imports them.
 */
export const TRACE_BUFFER_FILE_PREFIX = 'trace-buffer-';
export const SEALED_TRACE_FILE_PREFIX = 'sealed-trace-';
export const TRACE_FILE_SUFFIX = '.jsonl';
/**
 * issue #719 (F4): the length of a run id. Realm mints run ids as UUIDs (`uuidv4()`, 36 characters
 * in their string form); the trace store recovers a run id from a file name by this length, and a
 * damaged run file's side files are looked for only when its name is a run id of this length.
 */
export const RUN_ID_LENGTH = 36;

/** issue #719 (F4): the kinds of side file a run keeps beside its file, in its runs folder —
 *  exported by name as one const and its type (#729 PR-0, PR0-CONTRACT Amendment 7d). */
export const SIDE_FILE_KINDS = ['attempts', 'trace_buffer', 'sealed_trace'] as const;
/** One of {@link SIDE_FILE_KINDS}. */
export type SideFileKind = (typeof SIDE_FILE_KINDS)[number];

/**
 * The facts of one damaged stored file (issue #719, R7; #729 PR-0 Amendments 7, 7e): names, classes
 * and type words — never its content. Written as the typed `facts` of every such error
 * (`{ scope: 'file', …facts }`), on run files, on the runs folder and on the registrar's `empty` and
 * `parse` failures; read them through {@link unreadableFactsOf}. {@link renderUnreadableStoredFile}
 * builds every message from them alone.
 */
export interface UnreadableFileFacts {
  resource: 'run_file' | 'workflow_copy' | 'run_folder';
  class: StoredFileClass;
  path: string;
  /** `unreadable` only: the operating system's error code. */
  errno?: string;
  /** `parse` only, for JSON that is not an object: `null`, `array`, `string`, `number` or `boolean`. */
  shape?: string;
  /** `mismatched` only: the run id the file holds. */
  held_id?: string;
  /** `mismatched` only: what the held run's own file (`<held_id>.json`, same folder) is when it is
   *  looked up — `reads_as_run`: it reads as that run; `absent`: there is no such file (ENOENT);
   *  `unreadable`: anything else (damaged, in an earlier format, not readable by this user, holding
   *  another run). UNSET only when the held id is not one text may show ({@link displayId}), which
   *  is never looked up — unset means not judged. */
  held_file?: 'reads_as_run' | 'absent' | 'unreadable';
  /** `empty`, `parse`, `not_a_run` and `legacy` only: the kinds of side file present in the run's
   *  folder for this run id (`<id>.attempts.jsonl`; `trace-buffer-<id>-*.jsonl`;
   *  `sealed-trace-<id>-*.jsonl`). UNSET means not judged — the file's name is not a run id of
   *  {@link RUN_ID_LENGTH} characters, or the folder could not be listed; `[]` means judged, none
   *  present. The way out names none in both. */
  side_files?: SideFileKind[];
  /** `not_a_run` only: each required field missing or of the wrong type (names only). */
  fields?: RunRecordFieldProblem[];
  /** A keyed create only: what the file refuses — every new idempotency key on the store (what it
   *  holds cannot be read), or the one key it carries. */
  refused?: 'every_new_key' | 'this_key';
}

/** The facts a damaged-file error carries, or `undefined` for any other error — the ONE reader
 *  (#729 PR-0: it keys on the facts' `scope`, Amendment 7e). */
export function unreadableFactsOf(err: unknown): UnreadableFileFacts | undefined {
  if (!(err instanceof WorkflowError) || err.facts?.scope !== 'file') return undefined;
  const { scope: _scope, ...facts } = err.facts;
  return facts;
}

/** What {@link unreadableRunFilesError} carries: the command that did not run, the runs folder, and
 *  every run file it could not read. */
export interface UnreadableRunFilesFacts {
  command: string;
  folder: string;
  files: UnreadableFileFacts[];
}

/** The facts of a decision that failed closed over damaged run files, or `undefined` for any other
 *  error — the ONE reader of {@link unreadableRunFilesError}'s facts (#729 PR-0: keyed on `scope`). */
export function unreadableRunFilesOf(err: unknown): UnreadableRunFilesFacts | undefined {
  if (!(err instanceof WorkflowError) || err.facts?.scope !== 'files') return undefined;
  const { scope: _scope, ...facts } = err.facts;
  return facts;
}

/** An id a file holds, as text may show it (issue #719, C6): one made of letters, digits, `.`,
 *  `_` and `-`, at most 64 characters, as it is; any other as `another run id (not shown)` — a
 *  file's content can hold anything, a newline or a terminal escape included. */
export function displayId(id: string): string {
  return /^[A-Za-z0-9._-]{1,64}$/.test(id) ? id : 'another run id (not shown)';
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
      return workflow ? 'is empty — not a workflow' : 'is empty';
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
    case 'mismatched': {
      const held = facts.held_id ?? '';
      const shown = displayId(held);
      return shown === held
        ? `holds run '${held}', not '${fileId(facts.path)}'`
        : `holds ${shown}, not '${fileId(facts.path)}'`;
    }
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

/** A run file's (or the runs folder's) fault, as its sentence — the one place its path is shown:
 *  `The run file '<path>' <fault clause>.` */
export function runFileFaultSentence(facts: UnreadableFileFacts): string {
  const subject = facts.resource === 'run_folder' ? 'The runs folder' : 'The run file';
  return withFullStop(`${subject} '${facts.path}' ${describeStoredFileFault(facts)}`);
}

/** The side files a run keeps beside its file that are present, named exactly (issue #719, C2,
 *  F4): only the kinds `side_files` lists — none when it is unset (not judged) or empty. */
function sideFilesList(id: string, kinds: readonly SideFileKind[]): string | undefined {
  const named = [
    ...(kinds.includes('attempts') ? [`'${id}${SIDECAR_SUFFIX}'`] : []),
    ...(kinds.includes('trace_buffer')
      ? [`every '${TRACE_BUFFER_FILE_PREFIX}${id}-*${TRACE_FILE_SUFFIX}' file`]
      : []),
    ...(kinds.includes('sealed_trace')
      ? [`every '${SEALED_TRACE_FILE_PREFIX}${id}-*${TRACE_FILE_SUFFIX}' file`]
      : []),
  ];
  if (named.length === 0) return undefined;
  return named.length === 1
    ? named[0]
    : `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`;
}

/** `move it out of '<folder>'`, with the side files present and what moving them alone does. */
function moveOut(facts: UnreadableFileFacts): string {
  const folder = dirname(facts.path);
  const list = sideFilesList(fileId(facts.path), facts.side_files ?? []);
  return list === undefined
    ? `move it out of '${folder}'`
    : `move it out of '${folder}' together with ${list} (moved alone, they become orphans that ` +
        `'realm run gc --older-than <age> --force' deletes)`;
}

/** The way out of a file, or of the runs folder, that cannot be read — by its errno. */
function unreadableWayOut(facts: UnreadableFileFacts): string {
  const folder = facts.resource === 'run_folder';
  const unchanged = folder ? 'nothing in it was changed' : 'this file was not changed';
  const errno = facts.errno ?? 'UNKNOWN';
  let text: string;
  if (errno === 'EACCES' || errno === 'EPERM') {
    // issue #719 (F6.5): a runs folder that does not exist yet fails its creation the same way.
    text = folder
      ? `Give this user read access to it (or, if it does not exist yet, write access to the folder that holds it); ${unchanged}.`
      : `Give this user read access to it; ${unchanged}.`;
  } else if (errno === 'EISDIR' && !folder) {
    text = `It is a folder, not a file: move it out of '${dirname(facts.path)}'; nothing was changed.`;
  } else if (errno === 'EBUSY' || errno === 'EIO') {
    text = withFullStop(
      `${unchanged.charAt(0).toUpperCase()}${unchanged.slice(1)}; the read may succeed if retried`,
    );
  } else {
    text = `Check that it is a ${folder ? 'folder' : 'file'} this user can read; ${unchanged}.`;
  }
  return retryableFor(facts) ? `${text} Then retry.` : text;
}

/**
 * The way out for a damaged run file (issue #719, B5, C2): what to do, and what it does to the
 * run's key and its side files. No new command and no new state — a restore, a repair or a move.
 * The file's path is shown once, in the fault sentence; the way out says "it".
 */
export function runFileWayOut(facts: UnreadableFileFacts): string {
  if (facts.class === 'unreadable') return unreadableWayOut(facts);
  const folder = dirname(facts.path);
  const keyEffect =
    'If it held an idempotency key, the next delivery with that key starts a new run.';
  switch (facts.class) {
    case 'empty':
    case 'parse':
    case 'not_a_run':
      return (
        `Restore it from a backup or repair it: the run keeps its record and its idempotency ` +
        `key. Or ${moveOut(facts)}. ${keyEffect}`
      );
    case 'legacy':
      // issue #719 (F6.1): the fault sentence already says what the file is — not said twice.
      return `This version cannot read it: ${moveOut(facts)}. ${keyEffect}`;
    case 'mismatched': {
      const held = facts.held_id ?? '';
      // issue #719 (F1, F6.1): advice by what the held run's own file IS — never a rename over a
      // file that is there (damaged, earlier format, unreadable): only an absent one is restored.
      if (facts.held_file === 'reads_as_run') {
        return `That run's own file is readable, so this is a copy: move it out of '${folder}' — nothing else changes.`;
      }
      if (facts.held_file === 'absent') {
        return (
          `That run's own file is missing: rename this file to '${held}.json' to restore the run, ` +
          `or move it out of '${folder}'.`
        );
      }
      return `Move it out of '${folder}'.`;
    }
  }
}

/** The sentence a keyed create adds (issue #719, B4, C2), by what the file refuses. The key itself
 *  is never echoed. */
function keyedCreateSentence(
  refused: NonNullable<UnreadableFileFacts['refused']>,
  cls: StoredFileClass,
): string {
  // issue #719 (F6.2): a file that cannot be read is made readable, not repaired.
  const until = cls === 'unreadable' ? 'can be read or is moved out' : 'is repaired or moved out';
  return refused === 'every_new_key'
    ? `A run with a new idempotency key cannot be created on this store until the file ${until}.`
    : `A run with this idempotency key cannot be created until the file ${until}.`;
}

/**
 * issue #719 — the ONE composer for a damaged stored file's message, from its facts alone (no error
 * object, no record, no parser text, no options), so every surface — and #729 PR-0's renderers —
 * says the same words. A run file or the runs folder: its fault sentence, the keyed-create
 * sentence when the facts carry `refused`, and the way out. A registered workflow copy: the
 * registrar's subject and the fault clause (its repair act is the registrar's own, `repairActFor`).
 */
export function renderUnreadableStoredFile(facts: UnreadableFileFacts): string {
  if (facts.resource === 'workflow_copy') {
    return `the registered copy of '${fileId(facts.path)}' ${describeStoredFileFault(facts)}`;
  }
  return [
    runFileFaultSentence(facts),
    ...(facts.refused !== undefined ? [keyedCreateSentence(facts.refused, facts.class)] : []),
    runFileWayOut(facts),
  ].join(' ');
}

/**
 * The typed error for a damaged run file or an unreadable runs folder (issue #719, B2):
 * `unreadable` → `ENGINE_STORE_FAILED` (retryable by its errno); `legacy` → `STATE_LEGACY_FORMAT`;
 * every other class → `RESOURCE_FORMAT_INVALID`. Its facts are typed (`{ scope: 'file', … }`, #729
 * PR-0); its message is the composer's. Exported so no caller restates core's retry rule (#729 PR-0,
 * Amendment 7d).
 */
export function unreadableRunFileError(facts: UnreadableFileFacts): WorkflowError {
  const message = renderUnreadableStoredFile(facts);
  const typed = { scope: 'file' as const, ...facts };
  if (facts.class === 'unreadable') {
    return new WorkflowError(message, {
      code: 'ENGINE_STORE_FAILED',
      category: 'ENGINE',
      agentAction: 'stop',
      retryable: retryableFor(facts),
      facts: typed,
    });
  }
  if (facts.class === 'legacy') {
    return new WorkflowError(message, {
      code: 'STATE_LEGACY_FORMAT',
      category: 'STATE',
      agentAction: 'report_to_user',
      retryable: false,
      facts: typed,
    });
  }
  return new WorkflowError(message, {
    code: 'RESOURCE_FORMAT_INVALID',
    category: 'RESOURCE',
    agentAction: 'stop',
    retryable: false,
    facts: typed,
  });
}

/**
 * The runs folder itself cannot be read, or made (issue #719, B1, C3): `ENGINE_STORE_FAILED` naming
 * the folder, retryable by its errno, through the one composer.
 */
export function runsFolderUnreadableError(folder: string, err: unknown): WorkflowError {
  const errno = err instanceof FsIoError ? err.code : (errnoCode(err) ?? 'UNKNOWN');
  return unreadableRunFileError({
    resource: 'run_folder',
    class: 'unreadable',
    path: folder,
    errno,
  });
}

/**
 * issue #719 (R10, B3, C3) — a decision over EVERY run (`realm run reconcile`,
 * `realm run gc --heal`) fails closed when any run file cannot be read: ONE error naming every such file, and nothing is
 * written. `RESOURCE_FORMAT_INVALID` when every file's fault is in its bytes, else
 * `ENGINE_STORE_FAILED`. `command` is the exact command the operator ran, flags included, as its
 * caller passes it. Its facts are typed (`{ scope: 'files', …}` — {@link UnreadableRunFilesFacts});
 * read them through {@link unreadableRunFilesOf}.
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
    `Repair, restore or move each one out ('realm run list' shows each file's way out), then ` +
      `run ${quotedCommand(command)} again.`,
  ];
  const facts: UnreadableRunFilesFacts = {
    command,
    folder: runsFolder,
    files: files.map((f) => ({ ...f })),
  };
  return new WorkflowError(lines.join('\n'), {
    code: anyUnreadable ? 'ENGINE_STORE_FAILED' : 'RESOURCE_FORMAT_INVALID',
    category: anyUnreadable ? 'ENGINE' : 'RESOURCE',
    agentAction: 'stop',
    retryable: files.length > 0 && files.every(retryableFor),
    facts: { scope: 'files', ...facts },
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
 * issue #719 (C1): whether a damaged run file can concern a workflow — the ONE scope predicate of
 * the keyed fallback scan and of every workflow-scoped read. False when the file is JSON that is
 * not an object (it names no workflow and holds no key), when it is a folder named like a run file
 * (`unreadable` with `EISDIR`: it holds no run and no key, F6.3), and when its object names ANOTHER
 * workflow by a string `workflow_id`; true otherwise — a file whose content cannot be read
 * (`unreadable`, `empty`, not JSON), an object with no string `workflow_id`, or one naming this
 * workflow.
 */
export function damagedFileConcerns(
  reading: { facts: UnreadableFileFacts; object?: Record<string, unknown> },
  workflowId: string,
): boolean {
  if (reading.facts.class === 'parse' && reading.facts.shape !== undefined) return false;
  // issue #719 (F6.3): a folder named like a run file holds no run and no key.
  if (reading.facts.class === 'unreadable' && reading.facts.errno === 'EISDIR') return false;
  const named = reading.object?.['workflow_id'];
  return !(typeof named === 'string' && named !== workflowId);
}

/**
 * issue #719 (F5): whether a damaged run file is a copy of a run whose own file reads — a file
 * holding another run (`mismatched`) whose held run's file reads as that run. Such a file is not a
 * damaged run: every listing puts it with the copies (`RunListing.copies`), and no decision over
 * the runs, no keyed create and no scoped read counts or refuses over it.
 */
export function isCopyOfReadableRun(facts: UnreadableFileFacts): boolean {
  return facts.class === 'mismatched' && facts.held_file === 'reads_as_run';
}

/**
 * Reads one run file and says what it holds, in this order (issue #719, B1): a read error other
 * than `ENOENT` → `unreadable`; `ENOENT` → absent; zero bytes or whitespace only → `empty`; not
 * JSON, or JSON that is not an object → `parse`; an object with `state` and without
 * `completed_steps` → `legacy`; an object that is not a run record → `not_a_run`; a record whose
 * `id` is not the file's name → `mismatched`, with whether the run it holds reads from its own file
 * (`held_file`), and for the classes whose way out moves the file, the side files present
 * (`side_files`). No class is decided from the parser's message.
 */
export async function inspectRunFile(path: string, expectedId: string): Promise<RunFileReading> {
  const reading = await classifyRunFile(path, expectedId);
  if (reading.kind !== 'damaged') return reading;
  const { facts } = reading;
  if (facts.class === 'mismatched') {
    const held = facts.held_id ?? '';
    // Only an id that names a file in this folder (no separator, no `..` path) is looked up; any
    // other leaves `held_file` unset (not judged).
    if (displayId(held) !== held) return reading;
    const heldReading = await classifyRunFile(join(dirname(path), `${held}.json`), held);
    const held_file =
      heldReading.kind === 'record'
        ? 'reads_as_run'
        : heldReading.kind === 'absent'
          ? 'absent'
          : 'unreadable';
    return { ...reading, facts: { ...facts, held_file } };
  }
  // `unreadable`: its way out names no side file.
  if (facts.class === 'unreadable') return reading;
  const side_files = await sideFilesOf(path);
  return side_files === undefined ? reading : { ...reading, facts: { ...facts, side_files } };
}

/**
 * issue #719 (F4): the side-file kinds present beside a run file, from ONE listing of its folder —
 * only when its name is a run id of {@link RUN_ID_LENGTH} characters (otherwise a prefix could
 * match another run's files); `undefined` (not judged) for any other name, or when the folder
 * cannot be listed.
 */
async function sideFilesOf(path: string): Promise<SideFileKind[] | undefined> {
  const id = fileId(path);
  if (id.length !== RUN_ID_LENGTH) return undefined;
  let names: string[];
  try {
    names = await readdir(dirname(path));
  } catch {
    return undefined;
  }
  const kinds: SideFileKind[] = [];
  if (names.includes(`${id}${SIDECAR_SUFFIX}`)) kinds.push('attempts');
  const tracePrefix = `${TRACE_BUFFER_FILE_PREFIX}${id}-`;
  const sealedPrefix = `${SEALED_TRACE_FILE_PREFIX}${id}-`;
  if (names.some((n) => n.startsWith(tracePrefix) && n.endsWith(TRACE_FILE_SUFFIX))) {
    kinds.push('trace_buffer');
  }
  if (names.some((n) => n.startsWith(sealedPrefix) && n.endsWith(TRACE_FILE_SUFFIX))) {
    kinds.push('sealed_trace');
  }
  return kinds;
}

/** {@link inspectRunFile}'s classes, without the held run's look-up (so a chain of copies never
 *  reads more than one more file). */
async function classifyRunFile(path: string, expectedId: string): Promise<RunFileReading> {
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
