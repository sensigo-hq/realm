// run-read-address.ts — R1.1: the caller of `realm listen` reads the run it started.
//
// A workflow that declares `trigger.result_map` (only with `auth.mode: shared_secret`, the loader's
// rule) gets a read address: its `202` carries `status_path` (`<its path, trailing slashes
// stripped>/runs/<run id>`) and `token`, a code for that one run. `GET` or `HEAD` of that address with
// `Authorization: Bearer <token>` answers the run's phase and, once the run has completed, the
// values the map declares, through the same disclosure walk as an MCP reply. Each value is walked
// inside its own path's fields, so a value kept under `token` in the run's output is hidden whether
// the map reaches it through the whole step or by its path.
//
// The code is `hex(HMAC-SHA256(readKey, run id))`, where `readKey` is derived once at start from the
// workflow's own secret by scrypt (salted with the workflow's id), so nothing is stored and a code
// opens one run of one workflow only; a secret change ends every code. Every way a read can be
// refused (no such address, no key, no or wrong code, an unknown, purged or foreign run) is the same
// `403`, so a caller cannot tell them apart. A failing store or disclosure set is `503`.
import { createHmac, scrypt, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  REDACTED_MARKER,
  WITHHELD_WORDS,
  WorkflowError,
  buildEvidenceByStep,
  deriveRunPhase,
  discloseValue,
  withheldCauseOf,
  type DisclosureSet,
  type RunRecord,
  type Snapshot,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { requestPath } from './health-address.js';

/** The scrypt cost: N = 2^15 needs 32 MiB, above Node's default `maxmem`, which makes it throw. */
const SCRYPT_OPTIONS = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
/** The serialised result's limit: the MCP door's reply limit (`REPLY_CEILING_CHARS`, render-reply.ts). */
export const RESULT_MAX_CHARS = 40_000;
/** How long a running or waiting run's phase is answered from memory, and how many are kept. */
const PHASE_CACHE_MS = 1000;
const PHASE_CACHE_SIZE = 1000;

/** The part of a mounted workflow the read address needs (listen's `WorkflowEntry` has these). */
export interface ReadEntry {
  path: string;
  definition: WorkflowDefinition;
  /** Derived at start for a workflow with `result_map`; absent, every read is refused. */
  readKey?: Buffer;
}

/** Derives a workflow's read key from its secret (asynchronous: about 100 ms of work each). */
export function deriveReadKey(secret: string, workflowId: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(secret, `realm-run-read\0${workflowId}`, 32, SCRYPT_OPTIONS, (err, key) =>
      err !== null ? reject(err) : resolve(key),
    );
  });
}

/** The read code of one run: 64 lowercase hex characters. */
export function readCode(key: Buffer, runId: string): string {
  return createHmac('sha256', key).update(runId).digest('hex');
}

/** A workflow path with its trailing slashes stripped: `/` becomes the empty string. */
export function readPrefix(path: string): string {
  return path.replace(/\/+$/, '');
}

/** Whether `entry` declares a `result_map`. */
export function optedIn(entry: ReadEntry): boolean {
  return entry.definition.trigger?.result_map !== undefined;
}

/** What an opted-in workflow's replies about a run add: its read address and code; else nothing. */
export function readFields(
  entry: ReadEntry,
  runId: string,
): { status_path?: string; token?: string } {
  if (!optedIn(entry) || entry.readKey === undefined) return {};
  return {
    status_path: `${readPrefix(entry.path)}/runs/${runId}`,
    token: readCode(entry.readKey, runId),
  };
}

const READ_PATH = /^(.*)\/runs\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** The address prefix and run id of a read request (`GET` or `HEAD`), or undefined. */
export function readRequestOf(req: IncomingMessage): { prefix: string; runId: string } | undefined {
  if (req.method !== 'GET' && req.method !== 'HEAD') return undefined;
  const match = READ_PATH.exec(requestPath(req));
  return match === null ? undefined : { prefix: match[1]!, runId: match[2]! };
}

/** The monotonic clock the phase cache reads. */
function monotonicNow(): number {
  return performance.now();
}

type Phase = ReturnType<typeof deriveRunPhase>;

/** A running or waiting run's phase, by run id, for one second; bounded, least recently used out. */
export class PhaseCache {
  private readonly entries = new Map<string, { workflowId: string; phase: Phase; at: number }>();

  get(runId: string): { workflowId: string; phase: Phase } | undefined {
    const hit = this.entries.get(runId);
    if (hit === undefined) return undefined;
    this.entries.delete(runId);
    if (monotonicNow() - hit.at >= PHASE_CACHE_MS) return undefined;
    this.entries.set(runId, hit);
    return hit;
  }

  set(runId: string, workflowId: string, phase: Phase): void {
    this.entries.delete(runId);
    this.entries.set(runId, { workflowId, phase, at: monotonicNow() });
    if (this.entries.size > PHASE_CACHE_SIZE) {
      this.entries.delete(this.entries.keys().next().value as string);
    }
  }
}

/** What answering a read needs from listen. */
export interface ReadContext {
  /** The opted-in workflows by address prefix. */
  readonly entries: ReadonlyMap<string, ReadEntry>;
  get(runId: string): Promise<Snapshot>;
  disclosureProvider(definition: WorkflowDefinition, run: RunRecord): Promise<DisclosureSet>;
  logger: { error(msg: string, data?: unknown): void };
  readonly cache: PhaseCache;
}

/** The opted-in entries of a route table, by address prefix. */
export function readEntriesOf(routes: Iterable<ReadEntry>): Map<string, ReadEntry> {
  const out = new Map<string, ReadEntry>();
  for (const entry of routes) if (optedIn(entry)) out.set(readPrefix(entry.path), entry);
  return out;
}

const FORBIDDEN = { error: 'forbidden' } as const;
const UNAVAILABLE = { error: 'unavailable' } as const;

function send(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  payload: Record<string, unknown>,
): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  if (req.method === 'HEAD') res.end();
  else res.end(body);
}

/** Whether `header` is `Bearer` (any case), one space, then exactly `expected` (constant time). */
function codeMatches(header: string | undefined, expected: string): boolean {
  if (header === undefined || header.slice(0, 7).toLowerCase() !== 'bearer ') return false;
  const given = Buffer.from(header.slice(7), 'utf8');
  const want = Buffer.from(expected, 'utf8');
  return given.length === want.length && timingSafeEqual(given, want);
}

/** One own property of an object, or one element of an array by its index; else nothing. */
function child(node: unknown, segment: string): { value: unknown } | undefined {
  if (node === null || typeof node !== 'object') return undefined;
  if (Array.isArray(node) && !/^(0|[1-9]\d*)$/.test(segment)) return undefined;
  if (!Object.prototype.hasOwnProperty.call(node, segment)) return undefined;
  return { value: (node as Record<string, unknown>)[segment] };
}

/** One declared value found in a completed run: its name, its value, and the fields that led to it. */
interface Found {
  name: string;
  value: unknown;
  /** The path's segments after the step: the walk sees the value under them. */
  fields: string[];
}

/**
 * The declared values of a completed run, in the map's order: each path walked over the step's
 * recorded output (a gate's answer merged in, as `buildEvidenceByStep` gives it), own properties and
 * array indexes only; a path that does not resolve is left out, a `null` is kept.
 */
function foundValues(run: RunRecord, map: Readonly<Record<string, string>>): Found[] {
  const byStep = buildEvidenceByStep(run);
  const found: Found[] = [];
  for (const [name, path] of Object.entries(map)) {
    const [, , step, ...fields] = path.split('.');
    let node = step === undefined ? undefined : child(byStep, step);
    for (const segment of fields)
      node = node === undefined ? undefined : child(node.value, segment);
    if (node !== undefined && node.value !== undefined)
      found.push({ name, value: node.value, fields });
  }
  return found;
}

/**
 * One found value as the walk shows it where the run's output keeps it: the value inside plain
 * objects built from its path's fields, walked, and read back out. A text or a number under a
 * credential-named field on the path is hidden, as when the whole step is mapped; an ancestor the walk
 * hid leaves the path unresolved, and the value is the walk's marker.
 */
function walkedInPlace(
  found: Found,
  set: DisclosureSet,
): { value: unknown; hidden: { declared: number; environment: number; pattern: number } } {
  let wrapper: unknown = found.value;
  // A computed key defines an own property, `__proto__` included.
  for (const field of [...found.fields].reverse()) wrapper = { [field]: wrapper };
  const walked = discloseValue(wrapper, set, 'agent');
  let node: { value: unknown } | undefined = { value: walked.value };
  for (const field of found.fields)
    node = node === undefined ? undefined : child(node.value, field);
  return { value: node === undefined ? REDACTED_MARKER : node.value, hidden: walked.tally.hidden };
}

/** The completed run's reply fields after `run_phase` (the result, or why there is none). */
async function completedFields(
  entry: ReadEntry,
  run: RunRecord,
  ctx: ReadContext,
): Promise<Record<string, unknown>> {
  const map = entry.definition.trigger?.result_map ?? {};
  const differs = run.workflow_version !== entry.definition.version;
  const flag = differs ? { workflow_version_differs: true } : {};
  if (Object.keys(map).length === 0) return flag;
  const found = foundValues(run, map);
  // `fromEntries` defines each name as an own property, so a name such as `__proto__` is a key.
  // Measured before any masking walk, which costs seconds on a value of megabytes.
  const raw = Object.fromEntries(found.map((f) => [f.name, f.value]));
  if (JSON.stringify(raw).length > RESULT_MAX_CHARS) return { result_error: 'too_large', ...flag };
  const set = await ctx.disclosureProvider(entry.definition, run);
  const withheld = withheldCauseOf(set);
  if (withheld !== undefined) {
    return { result_error: 'values_withheld', because: WITHHELD_WORDS[withheld], ...flag };
  }
  const masked = { declared: 0, environment: 0, pattern: 0 };
  const result: Array<[string, unknown]> = [];
  for (const f of found) {
    const shown = walkedInPlace(f, set);
    masked.declared += shown.hidden.declared;
    masked.environment += shown.hidden.environment;
    masked.pattern += shown.hidden.pattern;
    result.push([f.name, shown.value]);
  }
  return { result: Object.fromEntries(result), result_masked: masked, ...flag };
}

/**
 * Answers a read request (`readRequestOf` gave `read`). It takes no `--max-concurrent` slot and is
 * not a refusal: the connection is kept, and only a failure is logged.
 */
export async function answerRead(
  req: IncomingMessage,
  res: ServerResponse,
  read: { prefix: string; runId: string },
  ctx: ReadContext,
): Promise<void> {
  const entry = ctx.entries.get(read.prefix);
  if (
    entry === undefined ||
    entry.readKey === undefined ||
    !codeMatches(req.headers.authorization, readCode(entry.readKey, read.runId))
  ) {
    send(req, res, 403, FORBIDDEN);
    return;
  }
  const workflowId = entry.definition.id;
  const cached = ctx.cache.get(read.runId);
  if (cached !== undefined) {
    // The cache is keyed by run id alone, so this compare is what keeps another workflow's code out.
    if (cached.workflowId !== workflowId) send(req, res, 403, FORBIDDEN);
    else send(req, res, 200, { run_id: read.runId, run_phase: cached.phase });
    return;
  }
  const fail = (err: unknown): void => {
    ctx.logger.error('webhook: read failed', {
      path: requestPath(req),
      run_id: read.runId,
      error: String(err),
    });
    send(req, res, 503, UNAVAILABLE);
  };
  let run: RunRecord;
  try {
    run = (await ctx.get(read.runId)).record;
  } catch (err) {
    if (err instanceof WorkflowError && err.code === 'STATE_RUN_NOT_FOUND') {
      send(req, res, 403, FORBIDDEN);
    } else fail(err);
    return;
  }
  if (run.workflow_id !== workflowId) {
    send(req, res, 403, FORBIDDEN);
    return;
  }
  const phase = deriveRunPhase(run);
  if (phase === 'running' || phase === 'gate_waiting') ctx.cache.set(run.id, workflowId, phase);
  if (phase !== 'completed') {
    send(req, res, 200, { run_id: run.id, run_phase: phase });
    return;
  }
  let fields: Record<string, unknown>;
  try {
    fields = await completedFields(entry, run, ctx);
  } catch (err) {
    fail(err);
    return;
  }
  send(req, res, 200, { run_id: run.id, run_phase: phase, ...fields });
}
