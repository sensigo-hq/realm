// Tests for `realm listen` — the full request pipeline (mock req/res, injected deps) + startup.
//
// issue #409: `node:child_process` is mocked FILE-WIDE, deliberately and safely. Vitest hoists
// every `vi.mock` to the top of the file whatever AST depth it is written at, so a
// describe-scoped one would silently be file-wide anyway — better to say so than to look scoped.
// issue #744: the mock follows Node's own rule for the folder it is given (`fakeChild` below): the
// code a chdir into it would hit decides — none, and the start succeeds with pid 4242; ENOENT or
// EACCES, and it fails on the next tick with no pid; any other code, and `spawn` throws at once. It
// never starts a process. The only real spawns in this file are A1 (through a guard that refuses
// any other `cwd`, so it can only fail in a missing folder) and the #744 contract cell (guarded,
// its arguments swapped to `-e 0`, over nine folder states). Every other cell doubles the
// `spawnAgent` deps seam, which sits ABOVE the spawn.
import { describe, it, expect, vi, afterEach, onTestFinished } from 'vitest';
import { InvalidArgumentError } from 'commander';

const spawnMock = vi.hoisted(() => vi.fn((cmd, args, opts) => fakeChild(cmd, opts.cwd, args)));
vi.mock('node:child_process', () => ({ spawn: spawnMock }));
import { EventEmitter } from 'node:events';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { connect as netConnect, type AddressInfo } from 'node:net';
import { Worker } from 'node:worker_threads';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { InMemoryStore } from '@sensigo/realm-testing';
import { CURRENT_WORKFLOW_SCHEMA_VERSION, abandonRun, JsonFileStore } from '@sensigo/realm';
import type { WorkflowDefinition, WebhookTrigger, WorkflowRegistrar } from '@sensigo/realm';
import { homedir, tmpdir, constants as osConstants } from 'node:os';
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  makeListenHandler,
  buildRouteTable,
  normalizeHeaders,
  prepareListenWorkflows,
  defaultDedupBase,
  buildAgentArgv,
  defaultSpawnAgent,
  makeAgentSpawner,
  listenCommand,
  startListen,
  type ListenDeps,
  type Logger,
  type WorkflowEntry,
  type SpawnResult,
} from './listen.js';
import { InMemoryDedupStore } from '../lib/dedup-store.js';
import { purgeRuns } from './purge.js';
import type { loadProjectExtensions } from '../extensions/load-project-extensions.js';

/**
 * issue #744: a stand-in for Node's child process that follows Node's own rule for the folder.
 * It finds the code a chdir into `cwd` would hit: `statSync` (throwing form) → its code; not a
 * directory → ENOTDIR; else `accessSync(X_OK)` → its code, or none. Node sends EACCES and ENOENT
 * (with EAGAIN, EMFILE, ENFILE) to a next-tick `'error'` and throws every other code at once, so:
 * - no code → pid 4242, `'spawn'` on the next tick, then each of `lateErrors` as `'error'` (the
 *   agent's later exit is not modelled: #747 adds it when it needs it);
 * - ENOENT or EACCES → no pid; on the next tick Node's `'error'` (`spawn <cmd> CODE`, kept as
 *   `sentError`), then `'close'` with `(errno, null)`;
 * - any other code `os.constants.errno` knows → `spawn` throws at once (`spawn CODE`, syscall
 *   `spawn`), as Node does for ENOTDIR, ELOOP, ENAMETOOLONG;
 * - anything else — a code `os.constants.errno` does not know, or `lateErrors`/`impossible` with
 *   a start that fails — throws `fakeChild: state not modelled`.
 * `impossible: 'spawn-without-pid'` is the one state Node never produces (`'spawn'` with no pid),
 * named so a reader sees it is deliberate (A5 alone). The contract cell checks this rule against
 * the real spawn over nine folder states.
 */
type FakeChild = EventEmitter & {
  pid: number | undefined;
  unref: ReturnType<typeof vi.fn>;
  sentError?: Error;
};
/** The code a chdir into `cwd` would hit, or `undefined` when it would succeed. */
function chdirCode(cwd: string): string | undefined {
  let state;
  try {
    state = statSync(cwd);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code ?? 'UNKNOWN';
  }
  if (!state.isDirectory()) return 'ENOTDIR';
  try {
    accessSync(cwd, fsConstants.X_OK);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code ?? 'UNKNOWN';
  }
  return undefined;
}
function fakeChild(
  cmd: string,
  cwd: string,
  args: readonly string[],
  opts: { lateErrors?: Error[]; impossible?: 'spawn-without-pid' } = {},
): FakeChild {
  const code = chdirCode(cwd);
  if (code === undefined) {
    const child = Object.assign(new EventEmitter(), {
      pid: opts.impossible === 'spawn-without-pid' ? undefined : 4242,
      unref: vi.fn(),
    });
    process.nextTick(() => {
      child.emit('spawn');
      for (const err of opts.lateErrors ?? []) child.emit('error', err);
    });
    return child;
  }
  const known = (osConstants.errno as Record<string, number | undefined>)[code];
  if (known === undefined || opts.lateErrors !== undefined || opts.impossible !== undefined) {
    throw new Error(`fakeChild: state not modelled: ${code} at ${cwd}`);
  }
  const errno = -known;
  if (code === 'ENOENT' || code === 'EACCES') {
    const sentError = Object.assign(new Error(`spawn ${cmd} ${code}`), {
      code,
      errno,
      syscall: `spawn ${cmd}`,
      path: cmd,
      spawnargs: [...args],
    });
    const child = Object.assign(new EventEmitter(), { pid: undefined, unref: vi.fn(), sentError });
    process.nextTick(() => {
      child.emit('error', sentError);
      child.emit('close', errno, null);
    });
    return child;
  }
  throw Object.assign(new Error(`spawn ${code}`), { code, errno, syscall: 'spawn' });
}

// issue #744: temp folders for the spawn cells, removed after each cell. A cell that locks a
// folder first pushes the undo into `restores`, which runs before the removal, so a cell that fails
// part-way leaves nothing locked (`rmSync` throws EACCES on a mode-000 tree). Each undo and each
// removal runs in its own `try`: one failure cannot skip the rest, and the first is thrown after.
const made: string[] = [];
const restores: Array<() => void> = [];
afterEach(() => {
  let failed = false;
  let first: unknown;
  const keep = (err: unknown): void => {
    if (!failed) {
      failed = true;
      first = err;
    }
  };
  for (const restore of restores.splice(0)) {
    try {
      restore();
    } catch (err) {
      keep(err);
    }
  }
  for (const dir of made.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      keep(err);
    }
  }
  if (failed) throw first;
});
/** A folder that does not exist, under a fresh temp dir. */
function missingFolder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'listen-744-'));
  made.push(dir);
  return join(dir, 'no-such-folder');
}
/** A fresh temp folder that exists. */
function existingFolder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'listen-744-'));
  made.push(dir);
  return dir;
}

const SECRET = 'Bearer s3cr3t';
const ENV = { GORGIAS_TOKEN: SECRET, HMAC_SECRET: 'hmac-key', GH_SECRET: 'gh-key' };

const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

function wf(trigger: WebhookTrigger, extra: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    id: 'gorgias-wf',
    name: 'Gorgias WF',
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps: { handle: { execution: 'agent', description: 'handle' } },
    trigger,
    ...extra,
  };
}

const SHARED_SECRET_TRIGGER: WebhookTrigger = {
  type: 'webhook',
  path: '/wf',
  auth: { mode: 'shared_secret', header: 'Authorization', secret_from: 'GORGIAS_TOKEN' },
};

function makeDeps(overrides: Partial<ListenDeps> = {}): ListenDeps & {
  runStore: InMemoryStore;
  spawnAgent: ReturnType<typeof vi.fn>;
} {
  const runStore = new InMemoryStore();
  const dedup = new InMemoryDedupStore();
  const workflowStore: Pick<WorkflowRegistrar, 'register'> = { register: vi.fn(async () => {}) };
  const spawnAgent = vi.fn(async (): Promise<SpawnResult> => ({ pid: 4242 }));
  return {
    workflowStore,
    runStore,
    dedupStoreFor: () => dedup,
    spawnAgent,
    clock: () => 1_700_000_000_000,
    logger: silentLogger,
    ...overrides,
  } as ListenDeps & { runStore: InMemoryStore; spawnAgent: ReturnType<typeof vi.fn> };
}

function routesFor(def: WorkflowDefinition): Map<string, WorkflowEntry> {
  return buildRouteTable([{ definition: def, workflowDir: '/tmp/wf' }], {
    env: ENV,
    logger: silentLogger,
  });
}

function makeReq(opts: {
  method?: string;
  url?: string;
  headers?: Record<string, string | string[]>;
  body?: string;
  noEnd?: boolean;
}): IncomingMessage {
  const req = new EventEmitter() as unknown as IncomingMessage & { destroy: () => void };
  req.method = opts.method ?? 'POST';
  req.url = opts.url ?? '/wf';
  req.headers = (opts.headers ?? {}) as IncomingMessage['headers'];
  (req as unknown as { destroy: () => void }).destroy = () => req.emit('close');
  (req as unknown as { resume: () => IncomingMessage }).resume = () => req;
  setImmediate(() => {
    if (opts.body !== undefined && opts.body !== '') req.emit('data', Buffer.from(opts.body));
    if (opts.noEnd !== true) req.emit('end');
  });
  return req;
}

function makeRes(): ServerResponse & {
  statusCode: number;
  jsonBody: () => Record<string, unknown>;
} {
  let raw = '';
  // The literal is typed up front so `this` inside writeHead resolves to the mock's own shape.
  // (Untyped, TS infers `this: {}` — the methods' mutual reference makes the inference circular.)
  interface MockRes {
    headersSent: boolean;
    statusCode: number;
    writeHead(status: number): MockRes;
    end(chunk?: string): void;
    jsonBody(): Record<string, unknown>;
  }
  const res: MockRes = {
    headersSent: false,
    statusCode: 0,
    writeHead(status: number) {
      this.statusCode = status;
      this.headersSent = true;
      return this;
    },
    end(chunk?: string) {
      if (chunk !== undefined) raw = chunk;
    },
    jsonBody() {
      return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    },
  };
  return res as unknown as ServerResponse & {
    statusCode: number;
    jsonBody: () => Record<string, unknown>;
  };
}

const JSON_CT = { 'content-type': 'application/json' };

async function invoke(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  reqOpts: Parameters<typeof makeReq>[0],
): Promise<{ status: number; body: Record<string, unknown> }> {
  const req = makeReq(reqOpts);
  const res = makeRes();
  await handler(req, res);
  return { status: res.statusCode, body: res.jsonBody() };
}

describe('normalizeHeaders', () => {
  it('lowercases keys, drops array (duplicated) values, null-prototype', () => {
    const h = normalizeHeaders({
      Authorization: 'x',
      'X-Dup': ['a', 'b'],
      'Content-Type': 'application/json',
    } as never);
    expect(h['authorization']).toBe('x');
    expect(h['x-dup']).toBeUndefined();
    expect(h['content-type']).toBe('application/json');
    expect(Object.getPrototypeOf(h)).toBeNull();
  });
});

describe('makeListenHandler — request pipeline', () => {
  it('non-POST → 405', async () => {
    const handler = makeListenHandler(routesFor(wf(SHARED_SECRET_TRIGGER)), makeDeps());
    const { status } = await invoke(handler, { method: 'GET', url: '/wf' });
    expect(status).toBe(405);
  });

  it('unknown path → 403 (not 404)', async () => {
    const handler = makeListenHandler(routesFor(wf(SHARED_SECRET_TRIGGER)), makeDeps());
    const { status } = await invoke(handler, { url: '/nope', headers: JSON_CT });
    expect(status).toBe(403);
  });

  it('at max-concurrent → 503', async () => {
    const handler = makeListenHandler(routesFor(wf(SHARED_SECRET_TRIGGER)), makeDeps(), {
      maxConcurrent: 0,
    });
    const { status } = await invoke(handler, { url: '/wf', headers: JSON_CT });
    expect(status).toBe(503);
  });

  it('body over cap → 413', async () => {
    const handler = makeListenHandler(routesFor(wf(SHARED_SECRET_TRIGGER)), makeDeps(), {
      maxBodyBytes: 4,
    });
    const { status } = await invoke(handler, {
      url: '/wf',
      headers: JSON_CT,
      body: 'way too long',
    });
    expect(status).toBe(413);
  });

  it('body timeout → 408', async () => {
    const handler = makeListenHandler(routesFor(wf(SHARED_SECRET_TRIGGER)), makeDeps(), {
      bodyTimeoutMs: 20,
    });
    const { status } = await invoke(handler, {
      url: '/wf',
      headers: JSON_CT,
      body: '{}',
      noEnd: true,
    });
    expect(status).toBe(408);
  });

  it('wrong content-type → 415', async () => {
    const handler = makeListenHandler(routesFor(wf(SHARED_SECRET_TRIGGER)), makeDeps());
    const { status } = await invoke(handler, {
      url: '/wf',
      headers: { 'content-type': 'text/plain', authorization: SECRET },
      body: '{}',
    });
    expect(status).toBe(415);
  });

  it('shared_secret verify fail → 403', async () => {
    const handler = makeListenHandler(routesFor(wf(SHARED_SECRET_TRIGGER)), makeDeps());
    const { status } = await invoke(handler, {
      url: '/wf',
      headers: { ...JSON_CT, authorization: 'Bearer wrong' },
      body: '{}',
    });
    expect(status).toBe(403);
  });

  it('duplicated auth header → 403', async () => {
    const handler = makeListenHandler(routesFor(wf(SHARED_SECRET_TRIGGER)), makeDeps());
    const { status } = await invoke(handler, {
      url: '/wf',
      headers: { 'content-type': 'application/json', authorization: [SECRET, SECRET] },
      body: '{}',
    });
    expect(status).toBe(403);
  });

  it('github verify fail (bad signature) → 403', async () => {
    const trigger: WebhookTrigger = {
      type: 'webhook',
      path: '/wf',
      auth: { mode: 'github', secret_from: 'GH_SECRET' },
    };
    const handler = makeListenHandler(routesFor(wf(trigger)), makeDeps());
    const { status } = await invoke(handler, {
      url: '/wf',
      headers: { ...JSON_CT, 'x-hub-signature-256': 'sha256=deadbeef' },
      body: '{}',
    });
    expect(status).toBe(403);
  });

  it('hmac verify success → 202', async () => {
    const trigger: WebhookTrigger = {
      type: 'webhook',
      path: '/wf',
      auth: { mode: 'hmac', secret_from: 'HMAC_SECRET', header: 'x-signature' },
    };
    const body = '{"id":1}';
    const sig = createHmac('sha256', 'hmac-key').update(Buffer.from(body)).digest('hex');
    const handler = makeListenHandler(routesFor(wf(trigger)), makeDeps());
    const { status } = await invoke(handler, {
      url: '/wf',
      headers: { ...JSON_CT, 'x-signature': sig },
      body,
    });
    expect(status).toBe(202);
  });

  it('filter no match → 200 ignored', async () => {
    const trigger: WebhookTrigger = {
      ...SHARED_SECRET_TRIGGER,
      filter: { all: [{ path: 'body.type', value: 'ticket-created' }] },
    };
    const handler = makeListenHandler(routesFor(wf(trigger)), makeDeps());
    const { status, body } = await invoke(handler, {
      url: '/wf',
      headers: { ...JSON_CT, authorization: SECRET },
      body: JSON.stringify({ type: 'ticket-closed' }),
    });
    expect(status).toBe(200);
    expect(body['status']).toBe('ignored');
  });

  it('filter match → 202', async () => {
    const trigger: WebhookTrigger = {
      ...SHARED_SECRET_TRIGGER,
      filter: { all: [{ path: 'body.type', value: ['ticket-created', 'ticket-updated'] }] },
    };
    const handler = makeListenHandler(routesFor(wf(trigger)), makeDeps());
    const { status } = await invoke(handler, {
      url: '/wf',
      headers: { ...JSON_CT, authorization: SECRET },
      body: JSON.stringify({ type: 'ticket-created' }),
    });
    expect(status).toBe(202);
  });

  it('dedup hit → 200 deduplicated', async () => {
    const trigger: WebhookTrigger = { ...SHARED_SECRET_TRIGGER, dedup: { id_from: 'body.id' } };
    const deps = makeDeps();
    const handler = makeListenHandler(routesFor(wf(trigger)), deps);
    const reqOpts = {
      url: '/wf',
      headers: { ...JSON_CT, authorization: SECRET },
      body: JSON.stringify({ id: 'evt-1' }),
    };
    const first = await invoke(handler, reqOpts);
    expect(first.status).toBe(202);
    const second = await invoke(handler, reqOpts);
    expect(second.status).toBe(200);
    expect(second.body['status']).toBe('deduplicated');
    // issue #735, cell 4 (preservation): inside the window the reply stays the bare one — the
    // run's id is said only when the run store matched the delivery.
    expect(second.body).not.toHaveProperty('run_id');
  });

  it('dedup id unresolvable + on_missing_id reject → 400', async () => {
    const trigger: WebhookTrigger = {
      ...SHARED_SECRET_TRIGGER,
      dedup: { id_from: 'body.id', on_missing_id: 'reject' },
    };
    const handler = makeListenHandler(routesFor(wf(trigger)), makeDeps());
    const { status, body } = await invoke(handler, {
      url: '/wf',
      headers: { ...JSON_CT, authorization: SECRET },
      body: JSON.stringify({ no_id: true }),
    });
    expect(status).toBe(400);
    expect(body['error']).toBe('dedup_id_unresolvable');
  });

  it('params invalid against params_schema → 400', async () => {
    const trigger: WebhookTrigger = {
      ...SHARED_SECRET_TRIGGER,
      params_map: { ticket_id: 'body.id' },
    };
    const def = wf(trigger, {
      params_schema: {
        type: 'object',
        required: ['ticket_id'],
        properties: { ticket_id: { type: 'string' } },
      },
    });
    // issue #586 (walk J6-a) — the refusal must also be visible SERVER-side: the 400 body lives
    // in the caller's process, and an operator whose upstream posts the wrong shape had nothing to
    // look at at any log level. `info`, the same level as `webhook: dispatched`.
    const info = vi.fn();
    const handler = makeListenHandler(
      routesFor(def),
      makeDeps({ logger: { ...silentLogger, info } }),
    );
    const { status, body } = await invoke(handler, {
      url: '/wf',
      headers: { ...JSON_CT, authorization: SECRET },
      body: JSON.stringify({ no_id: true }),
    });
    expect(status).toBe(400);
    expect(body['error']).toBe('params_invalid');
    expect(info).toHaveBeenCalledWith(
      "webhook: rejected params_invalid — Invalid params for workflow 'gorgias-wf': (root) must " +
        "have required property 'ticket_id'",
      { path: '/wf', workflow: 'gorgias-wf' },
    );
    // issue #586 — the 400 body's `message` is the params voice, not the step voice. Before #586
    // `listen` called `validateInputSchema`, which minted `Invalid input for step '<workflow id>'`
    // — it named a step that was never validated and a workflow id in the step slot.
    expect(body['message']).toBe(
      "Invalid params for workflow 'gorgias-wf': (root) must have required property 'ticket_id'",
    );
    expect(String(body['message'])).not.toContain('Invalid input for step');
    expect(body['status']).toBe('rejected');
  });

  it('success → 202, run created, agent spawned, pid recorded', async () => {
    const trigger: WebhookTrigger = {
      ...SHARED_SECRET_TRIGGER,
      params_map: { ticket_id: 'body.id' },
    };
    const deps = makeDeps();
    const handler = makeListenHandler(routesFor(wf(trigger)), deps);
    const { status, body } = await invoke(handler, {
      url: '/wf',
      headers: { ...JSON_CT, authorization: SECRET },
      body: JSON.stringify({ id: 'ticket-99' }),
    });
    expect(status).toBe(202);
    expect(body['status']).toBe('accepted');
    expect(deps.spawnAgent).toHaveBeenCalledOnce();
    const run = await deps.runStore.get(body['run_id'] as string);
    expect(run.params['ticket_id']).toBe('ticket-99');
    expect(run.agent_pid).toBe(4242);
    expect(run.agent_started_at).toBeDefined();
  });

  it('spawn failure → 500 + run marked spawn_failed', async () => {
    const deps = makeDeps({
      spawnAgent: vi.fn(async (): Promise<SpawnResult> => ({ error: new Error('boom') })),
    });
    const handler = makeListenHandler(routesFor(wf(SHARED_SECRET_TRIGGER)), deps);
    const { status, body } = await invoke(handler, {
      url: '/wf',
      headers: { ...JSON_CT, authorization: SECRET },
      body: '{}',
    });
    expect(status).toBe(500);
    expect(body['error']).toBe('spawn_failed');
    const run = await deps.runStore.get(body['run_id'] as string);
    expect(run.terminal_reason).toBe('spawn_failed');
    expect(run.terminal_state).toBe(true);
    // issue #367 census path: a spawn death is a FAILURE, recorded as one. Before the substrate it
    // derived `abandoned` — nothing had failed and the prose was not the completed literal — which
    // is the #372 misfiling this closes.
    expect(run.sealed_by).toEqual({ arm: 'spawn_failure' });
    expect(run.run_phase).toBe('failed');
  });

  it('auth mode none → 202 without any header', async () => {
    const trigger: WebhookTrigger = { type: 'webhook', path: '/wf', auth: { mode: 'none' } };
    const handler = makeListenHandler(routesFor(wf(trigger)), makeDeps());
    const { status } = await invoke(handler, { url: '/wf', headers: JSON_CT, body: '{}' });
    expect(status).toBe(202);
  });

  it('Content-Type matching is case-insensitive (Application/JSON → accepted)', async () => {
    const handler = makeListenHandler(routesFor(wf(SHARED_SECRET_TRIGGER)), makeDeps());
    const { status } = await invoke(handler, {
      url: '/wf',
      headers: { 'content-type': 'Application/JSON; charset=utf-8', authorization: SECRET },
      body: '{}',
    });
    expect(status).toBe(202);
  });

  it('thrown spawnAgent → handled as spawn_failed (500 + run_id, marked, no dedup record, counter freed)', async () => {
    const recordSpy = vi.fn();
    const checkSpy = vi.fn(() => false);
    const dedupStore = { check: checkSpy, record: recordSpy, cleanup: () => {} };
    const warns: Array<[string, unknown]> = [];
    const deps = makeDeps({
      spawnAgent: vi.fn(() => {
        throw new Error('exec failed');
      }),
      dedupStoreFor: () => dedupStore,
      logger: { ...silentLogger, warn: (m: string, d?: unknown) => warns.push([m, d]) },
    });
    const trigger: WebhookTrigger = { ...SHARED_SECRET_TRIGGER, dedup: { id_from: 'body.id' } };
    // One request at a time: if the first request did not free the in-flight counter, the retry
    // below would be refused `503`.
    const handler = makeListenHandler(routesFor(wf(trigger)), deps, { maxConcurrent: 1 });
    const reqOpts = {
      url: '/wf',
      headers: { ...JSON_CT, authorization: SECRET },
      body: JSON.stringify({ id: 'evt-1' }),
    };

    const first = await invoke(handler, reqOpts);
    const { status, body } = first;
    expect(status).toBe(500);
    expect(body['error']).toBe('spawn_failed');
    expect(body['run_id']).toBeDefined();
    const run = await deps.runStore.get(body['run_id'] as string);
    expect(run.terminal_reason).toBe('spawn_failed');
    expect(run.terminal_state).toBe(true);
    // No dedup record on failure. A retry with the same id still does not get a fresh run: the
    // run store matches the run the spawn failure sealed (below; issue #735, residual 1).
    expect(recordSpy).not.toHaveBeenCalled();

    // issue #735, cell 6 (F1): the retry reuses `evt-1`; the run store matches the run the failed
    // start sealed (`created: false`), and the retry gets the FIRST reply again — the same `500`
    // — with nothing spawned, nothing written, the delivery id not recorded (so the next retry
    // reaches the store again), and one `warn` line. With `maxConcurrent: 1`, a `503` here would
    // mean the first request did not free the in-flight counter.
    const versionBefore = run.version;
    const recordsBefore = recordSpy.mock.calls.length;
    const warnsBefore = warns.length;
    const second = await invoke(handler, reqOpts);
    const after = await deps.runStore.get(body['run_id'] as string);
    // (a) red when the retry is answered with anything but the first reply (before this
    //     correction: `200 deduplicated, run_phase failed`; a leaked counter: `503`), when it
    //     spawns, writes the run, records the delivery id, or logs no `matched_spawn_failed_run`
    //     line; (b) prints both replies, the spawn count, the versions, the `record` calls made by
    //     the retry and the retry's warn lines.
    expect({
      second: { status: second.status, body: second.body },
      spawns: deps.spawnAgent.mock.calls.length,
      version: [versionBefore, after.version],
      retryRecords: recordSpy.mock.calls.length - recordsBefore,
      retryWarns: warns.slice(warnsBefore),
    }).toEqual({
      second: { status: first.status, body: first.body },
      spawns: 1,
      version: [versionBefore, versionBefore],
      retryRecords: 0,
      retryWarns: [
        [
          'webhook: deduplicated',
          {
            path: '/wf',
            run_id: body['run_id'],
            run_phase: 'failed',
            reason: 'matched_spawn_failed_run',
          },
        ],
      ],
    });
  });

  // ── issue #735: a delivery the run store matches starts nothing and writes nothing ──────────
  // The window expires by the clock the dedup stores read (`Date.now()`), so only Date is faked:
  // a bare vi.useFakeTimers() also fakes setImmediate, which makeReq uses, and hangs the handler.
  // `deps.clock` stamps only `agent_started_at`; it does not expire the window.
  // Beside each cell: (a) the change that turns it red; (b) what it prints when it fails.
  const DEDUP_1M: WebhookTrigger = {
    ...SHARED_SECRET_TRIGGER,
    dedup: { id_from: 'body.id', ttl_minutes: 1 },
  };
  const T0 = Date.UTC(2026, 9, 10, 12, 0, 0);
  const evt = (extra: Record<string, unknown> = {}) => ({
    url: '/wf',
    headers: { ...JSON_CT, authorization: SECRET },
    body: JSON.stringify({ id: 'evt-735', ...extra }),
  });
  type Logged = [string, unknown];

  /**
   * One delivery; then `between`; then the same delivery once the 1-minute window has passed; then,
   * when `third`, the same delivery again right away. The spawn stub returns pid 4242, then 4243.
   */
  async function afterTheWindow(
    opts: {
      trigger?: WebhookTrigger;
      between?: (deps: ReturnType<typeof makeDeps>, runId: string) => Promise<unknown>;
      first?: Record<string, unknown>;
      second?: Record<string, unknown>;
      third?: boolean;
    } = {},
  ) {
    const infos: Logged[] = [];
    const warns: Logged[] = [];
    let pid = 4242;
    const deps = makeDeps({
      spawnAgent: vi.fn(async (): Promise<SpawnResult> => ({ pid: pid++ })),
      logger: {
        ...silentLogger,
        info: (m: string, d?: unknown) => infos.push([m, d]),
        warn: (m: string, d?: unknown) => warns.push([m, d]),
      },
    });
    const create = vi.spyOn(deps.runStore, 'create');
    const handler = makeListenHandler(routesFor(wf(opts.trigger ?? DEDUP_1M)), deps);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(T0);
      const first = await invoke(handler, evt(opts.first));
      const runId = first.body['run_id'] as string;
      await opts.between?.(deps, runId);
      const before = await deps.runStore.get(runId);
      const kept = { version: before.version, agent_pid: before.agent_pid };
      vi.setSystemTime(T0 + 60_001);
      const second = await invoke(handler, evt(opts.second));
      const spawns = deps.spawnAgent.mock.calls.length;
      const after = await deps.runStore.get(runId);
      const record = { version: after.version, agent_pid: after.agent_pid };
      const third = opts.third === true ? await invoke(handler, evt(opts.second)) : undefined;
      const deduplicated = infos.filter(([m]) => m === 'webhook: deduplicated');
      const deduplicatedWarn = warns.filter(([m]) => m === 'webhook: deduplicated');
      return {
        runId,
        first,
        second,
        third,
        spawns,
        kept,
        record,
        create,
        deduplicated,
        deduplicatedWarn,
      };
    } finally {
      vi.useRealTimers();
    }
  }

  it('#735 cell 1: a redelivery after the window on a RUNNING run → 200 deduplicated with the run; no second agent, the record untouched', async () => {
    const r = await afterTheWindow();
    // (a) red when listen ignores `created` and spawns onto the matched run (before #735: 202, a
    //     second spawn, agent_pid 4243, the version bumped); (b) prints the reply, the spawn
    //     count and the record's version and agent_pid before and after.
    expect({ second: r.second, spawns: r.spawns, kept: r.kept, record: r.record }).toEqual({
      second: {
        status: 200,
        body: { status: 'deduplicated', run_id: r.runId, run_phase: 'running' },
      },
      spawns: 1,
      kept: { version: 1, agent_pid: 4242 },
      record: { version: 1, agent_pid: 4242 },
    });
  });

  it('#735 cell 2: the same on an ENDED (abandoned) run → 200 deduplicated, run_phase abandoned; no agent, the sealed record not written', async () => {
    const r = await afterTheWindow({ between: (deps, runId) => abandonRun(deps.runStore, runId) });
    // The other arm of F1: an ended run that did NOT fail to start is answered `200`.
    // (a) red when listen spawns onto the ended run and writes the sealed record (before #735:
    //     202, a spawn, the version bumped), or writes its `agent_pid` at all — the in-memory store
    //     hands back its stored object, so a write that bumps no version shows only here;
    //     (b) prints the reply, the spawn count, the versions and the agent_pid before and after.
    expect({
      second: r.second,
      spawns: r.spawns,
      version: [r.kept.version, r.record.version],
      agent_pid: [r.kept.agent_pid, r.record.agent_pid],
    }).toEqual({
      second: {
        status: 200,
        body: { status: 'deduplicated', run_id: r.runId, run_phase: 'abandoned' },
      },
      spawns: 1,
      version: [r.kept.version, r.kept.version],
      agent_pid: [r.kept.agent_pid, r.kept.agent_pid],
    });
  });

  it('#735 cell 3: the matched branch records the delivery id — a third copy right away is answered inside the window without reaching the store', async () => {
    const r = await afterTheWindow({ third: true });
    // Green on the code before #735 too (it also recorded after a matched spawn). (a) red when the
    // matched branch's `dedupStore.record` is deleted: the third copy reaches `create` again;
    // (b) prints the third reply and the number of `create` calls.
    expect({ third: r.third, creates: r.create.mock.calls.length }).toEqual({
      third: { status: 200, body: { status: 'deduplicated' } },
      creates: 2,
    });
  });

  it('#735 correction 2: a matched run that FAILED for another reason (a failed step) keeps the 200 — only a failed START replays its 500', async () => {
    const r = await afterTheWindow({
      third: true,
      // The run ends as the engine ends a failed step (settlement.ts): sealed `step_failure` with its
      // step, the step in `failed_steps`, the engine's one-failure `terminal_reason`. Its phase
      // derives `failed`, as a failed start's does; its first copy was answered `202`.
      between: async (deps, runId) => {
        const run = await deps.runStore.get(runId);
        await deps.runStore.update({
          ...run,
          terminal_state: true,
          sealed_by: { arm: 'step_failure', step: 'handle' },
          failed_steps: [...run.failed_steps, 'handle'],
          terminal_reason: "Step 'handle' failed: the handler threw",
        });
      },
    });
    // (a) red when the replay check keys on the phase `failed` instead of the arm `spawn_failure`
    //     (then this run's retry gets `500 spawn_failed`, a `warn` line, and no recorded id);
    //     (b) prints the reply, the spawn count, the logged info and warn lines, the third reply
    //     and the number of `create` calls.
    expect({
      second: r.second,
      spawns: r.spawns,
      logged: r.deduplicated,
      warned: r.deduplicatedWarn,
      third: r.third,
      creates: r.create.mock.calls.length,
    }).toEqual({
      second: {
        status: 200,
        body: { status: 'deduplicated', run_id: r.runId, run_phase: 'failed' },
      },
      spawns: 1,
      logged: [
        [
          'webhook: deduplicated',
          { path: '/wf', run_id: r.runId, run_phase: 'failed', reason: 'matched_existing_run' },
        ],
      ],
      warned: [],
      third: { status: 200, body: { status: 'deduplicated' } },
      creates: 2,
    });
  });

  it.each([
    ['running', undefined],
    [
      'abandoned',
      (deps: ReturnType<typeof makeDeps>, runId: string) => abandonRun(deps.runStore, runId),
    ],
  ] as const)(
    '#735 cell 7: the matched delivery is logged at info — webhook: deduplicated, reason matched_existing_run, the run and its phase (%s)',
    async (phase, between) => {
      const r = await afterTheWindow(between !== undefined ? { between } : {});
      // (a) red when the matched delivery is not logged, or logged without its reason, run or
      //     phase (before #735: only `webhook: dispatched`); (b) prints the logged lines' data.
      expect(r.deduplicated).toEqual([
        [
          'webhook: deduplicated',
          { path: '/wf', run_id: r.runId, run_phase: phase, reason: 'matched_existing_run' },
        ],
      ]);
    },
  );

  it.each([
    ['the same params', { note: 'a' }, 'info', {}],
    ['other mapped params', { note: 'b' }, 'warn', { params_differ: true }],
  ] as const)(
    '#735: a matched delivery with %s — params_differ said, at warn and on the reply, only when the mapped params differ',
    async (_label, second, level, extra) => {
      const r = await afterTheWindow({
        trigger: { ...DEDUP_1M, params_map: { ticket_id: 'body.id', note: 'body.note' } },
        first: { note: 'a' },
        second,
      });
      const line = [
        'webhook: deduplicated',
        {
          path: '/wf',
          run_id: r.runId,
          run_phase: 'running',
          reason: 'matched_existing_run',
          ...extra,
        },
      ];
      // (a) other params: red when the delivery is logged at `info`, or its reply or line lacks
      //     `params_differ: true` (before this correction: `info`, and no field on the reply).
      //     The same params: red when the flag is said, or the line leaves `info` — green on the
      //     code before this correction too (it pins today's behaviour); forcing the flag on in
      //     listen.ts turns it red. (b) prints the info and warn lines and the reply.
      expect({ info: r.deduplicated, warn: r.deduplicatedWarn, reply: r.second }).toEqual({
        info: level === 'info' ? [line] : [],
        warn: level === 'warn' ? [line] : [],
        reply: {
          status: 200,
          body: { status: 'deduplicated', run_id: r.runId, run_phase: 'running', ...extra },
        },
      });
    },
  );

  it('#735 cell 8: two copies of one delivery arriving together → one run and ONE agent; the second copy is told the run that won', async () => {
    const deps = makeDeps();
    // Both deliveries are held at the store until both have reached it (a two-party barrier):
    // in this harness the in-memory stores never yield, so without it the first finishes first.
    let n = 0;
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => (open = resolve));
    const inner = deps.runStore.create.bind(deps.runStore);
    deps.runStore.create = async (o) => {
      if (++n === 2) open();
      await gate;
      return inner(o);
    };
    const handler = makeListenHandler(
      routesFor(wf({ ...SHARED_SECRET_TRIGGER, dedup: { id_from: 'body.id' } })),
      deps,
    );
    // The barrier opens only when both copies reach the store. Raced against a 2-second timer, so
    // that when fewer than two arrive the cell fails saying what it saw, never a bare timeout.
    const seen: Array<{ status: number; body: Record<string, unknown> }> = [];
    const both = Promise.all(
      [evt(), evt()].map((o) =>
        invoke(handler, o).then((reply) => {
          seen.push(reply);
          return reply;
        }),
      ),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), 2_000);
    });
    const raced = await Promise.race([both, timedOut]);
    clearTimeout(timer);
    if (raced === undefined) {
      open();
      // (a) red when fewer than two copies reach the run store together (a delivery answered
      //     before `create`, for one); (b) prints the creates that arrived, the replies so far and
      //     the spawn count.
      expect.unreachable(
        `fewer than two copies reached the run store within 2 s: creates=${n}, replies so far=${JSON.stringify(seen)}, spawns=${deps.spawnAgent.mock.calls.length}`,
      );
    }
    const replies = raced!;
    const won = replies.find((x) => x.status === 202)?.body['run_id'];
    // (a) red when both copies start an agent (before #735: two 202s with the same run id, two
    //     spawns); (b) prints both replies, sorted by status, and the spawn count.
    expect({
      replies: [...replies].sort((x, y) => y.status - x.status),
      spawns: deps.spawnAgent.mock.calls.length,
    }).toEqual({
      replies: [
        { status: 202, body: { run_id: won, status: 'accepted' } },
        { status: 200, body: { status: 'deduplicated', run_id: won, run_phase: 'running' } },
      ],
      spawns: 1,
    });
  });

  it('#735 cell 9 (preservation): a seal landing between the create and the pid write — the write fails on the version check; the run stays sealed with no agent_pid', async () => {
    // A JsonFileStore: the in-memory store's create returns the object it keeps, so agent_pid would
    // appear on it before the write (a shared-object artefact).
    const dir = mkdtempSync(join(tmpdir(), 'listen-735-'));
    try {
      const inner = new JsonFileStore(dir);
      const store = new JsonFileStore(dir);
      const realUpdate = store.update.bind(store);
      store.update = async (record) => {
        if (record.agent_pid !== undefined) await abandonRun(inner, record.id);
        return realUpdate(record);
      };
      const errors: Logged[] = [];
      const deps = makeDeps({
        runStore: store,
        logger: { ...silentLogger, error: (m: string, d?: unknown) => errors.push([m, d]) },
      });
      const handler = makeListenHandler(routesFor(wf(SHARED_SECRET_TRIGGER)), deps);
      const reply = await invoke(handler, {
        url: '/wf',
        headers: { ...JSON_CT, authorization: SECRET },
        body: '{}',
      });
      const runId = reply.body['run_id'] as string;
      const run = await inner.get(runId);
      // (a) red when listen's pid write lands on the sealed record, or a seal stops being refused
      //     by the version check; (b) prints the reply, the seal, agent_pid, the version and the
      //     logged lines (each with whether it names the version conflict).
      expect({
        reply,
        sealed_by: run.sealed_by?.arm,
        agent_pid: run.agent_pid,
        version: run.version,
        logged: errors.map(([m, d]) => [
          m,
          String((d as { error?: unknown } | undefined)?.error).includes('Version conflict'),
        ]),
      }).toEqual({
        reply: { status: 202, body: { run_id: runId, status: 'accepted' } },
        sealed_by: 'abandon_requested',
        agent_pid: undefined,
        version: 1,
        logged: [['webhook: failed to record agent pid', true]],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('#735: after a failed start, purging the run and delivering again starts a new run at once', async () => {
    // A JsonFileStore over a temp folder: `realm run purge <id> --force` calls `purgeRuns` with
    // the run store as its anchor, which needs the store's folder (the in-memory store has none).
    const dir = mkdtempSync(join(tmpdir(), 'listen-735-purge-'));
    try {
      const store = new JsonFileStore(dir);
      let attempt = 0;
      const deps = makeDeps({
        runStore: store,
        spawnAgent: vi.fn(async (): Promise<SpawnResult> =>
          ++attempt === 1 ? { error: new Error('ENOTDIR') } : { pid: 4250 },
        ),
      });
      const handler = makeListenHandler(
        routesFor(wf({ ...SHARED_SECRET_TRIGGER, dedup: { id_from: 'body.id' } })),
        deps,
      );
      const first = await invoke(handler, evt());
      const failedRun = first.body['run_id'] as string;
      const purged = await purgeRuns({ runId: failedRun, dryRun: false }, store, []);
      const again = await invoke(handler, evt());
      // Green before this correction too: a failed start records no duplicate id, and purge
      // removes the run and its key. (a) red when the run is not purged (the retry then matches the
      // failed run), or when a failed start leaves a duplicate record behind (the retry is then
      // answered `200 deduplicated`); (b) prints the first reply's status, what purge removed,
      // the second reply (whether its run is new) and the spawn count.
      expect({
        first: first.status,
        purged: purged.purged,
        again: {
          status: again.status,
          accepted: again.body['status'],
          newRun: typeof again.body['run_id'] === 'string' && again.body['run_id'] !== failedRun,
        },
        spawns: deps.spawnAgent.mock.calls.length,
      }).toEqual({
        first: 500,
        purged: [failedRun],
        again: { status: 202, accepted: 'accepted', newRun: true },
        spawns: 2,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('buildRouteTable — startup (fail-closed)', () => {
  it('path collision across workflows → throws', () => {
    const a = wf(SHARED_SECRET_TRIGGER);
    const b = wf(SHARED_SECRET_TRIGGER, { id: 'other-wf' }); // same path '/wf'
    expect(() =>
      buildRouteTable(
        [
          { definition: a, workflowDir: '/a' },
          { definition: b, workflowDir: '/b' },
        ],
        { env: ENV, logger: silentLogger },
      ),
    ).toThrow(/collision/);
  });

  it('missing secret env var → throws at startup', () => {
    expect(() =>
      buildRouteTable([{ definition: wf(SHARED_SECRET_TRIGGER), workflowDir: '/a' }], {
        env: {},
        logger: silentLogger,
      }),
    ).toThrow(/GORGIAS_TOKEN/);
  });

  it("auth mode 'none' → startup warn, mounts with no secret", () => {
    const warn = vi.fn();
    const logger: Logger = { ...silentLogger, warn };
    const trigger: WebhookTrigger = { type: 'webhook', path: '/wf', auth: { mode: 'none' } };
    const routes = buildRouteTable([{ definition: wf(trigger), workflowDir: '/a' }], {
      env: {},
      logger,
    });
    expect(routes.size).toBe(1);
    expect(routes.get('/wf')?.secret).toBeUndefined();
    expect(warn.mock.calls.some((c) => String(c[0]).includes('none'))).toBe(true);
  });

  it('workflow without trigger → skipped (not mounted)', () => {
    const def = wf(SHARED_SECRET_TRIGGER);
    delete (def as { trigger?: unknown }).trigger;
    const routes = buildRouteTable([{ definition: def, workflowDir: '/a' }], {
      env: ENV,
      logger: silentLogger,
    });
    expect(routes.size).toBe(0);
  });

  it('default path is /<workflow-id> when trigger.path omitted', () => {
    const trigger: WebhookTrigger = { type: 'webhook', auth: { mode: 'none' } };
    const routes = buildRouteTable([{ definition: wf(trigger), workflowDir: '/a' }], {
      env: {},
      logger: silentLogger,
    });
    expect(routes.has('/gorgias-wf')).toBe(true);
  });
});

describe('project extensions — listen startup and webhook pipeline', () => {
  const okLoader = (): typeof loadProjectExtensions =>
    vi.fn(async () => ({
      registry: {} as never,
      manifest: { modules: [], adapters: [], handlers: [], processors: [] },
    })) as unknown as typeof loadProjectExtensions;

  it('prepareListenWorkflows registers each routed workflow ONCE and loads its extensions', async () => {
    const deps = makeDeps();
    const routes = routesFor(wf(SHARED_SECRET_TRIGGER));
    const loader = okLoader();
    await prepareListenWorkflows(routes, deps, loader);
    expect(deps.workflowStore.register).toHaveBeenCalledTimes(1);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('prepareListenWorkflows fails fast on a broken extensions module', async () => {
    const deps = makeDeps();
    const routes = routesFor(wf(SHARED_SECRET_TRIGGER));
    const brokenLoader = vi.fn(async () => {
      throw new Error('broken extensions module');
    }) as unknown as typeof loadProjectExtensions;
    await expect(prepareListenWorkflows(routes, deps, brokenLoader)).rejects.toThrow(
      'broken extensions module',
    );
  });

  it('a dispatched webhook does NOT re-register the workflow (per-webhook register removed)', async () => {
    const deps = makeDeps();
    const handler = makeListenHandler(routesFor(wf(SHARED_SECRET_TRIGGER)), deps);
    const { status } = await invoke(handler, {
      url: '/wf',
      headers: { ...JSON_CT, authorization: SECRET },
      body: '{}',
    });
    expect(status).toBe(202);
    expect(deps.spawnAgent).toHaveBeenCalledOnce();
    expect(deps.workflowStore.register).not.toHaveBeenCalled();
  });
});

describe('defaultDedupBase (issue #332 item 3 — call-time, never module-scope, the #285 class)', () => {
  it("HOME set: resolves under homedir(), byte-compatible with the old ?? '.' expression (which agreed with homedir() whenever HOME was set)", () => {
    // Read-only path assertion — never a write (the #285 caution).
    expect(defaultDedupBase()).toBe(join(homedir(), '.realm', 'dedup'));
  });

  it("HOME UNSET: the discriminating cell — defaultDedupBase() still resolves under the OS home (via os.homedir()'s /etc/passwd fallback), NEVER under '.' (the old expression's silent-CWD failure mode)", () => {
    // The set-HOME cell above is confirmation theater on its own: `?? '.'` and `homedir()` AGREE
    // whenever HOME is set, so it can't distinguish the fix from the old expression. Only
    // deleting HOME discriminates — the old code would have resolved to './.realm/dedup' (CWD);
    // the fix must still resolve under the real OS home.
    const savedHome = process.env['HOME'];
    delete process.env['HOME'];
    try {
      const resolved = defaultDedupBase();
      expect(resolved).toBe(join(homedir(), '.realm', 'dedup'));
      expect(resolved.startsWith('.')).toBe(false);
      expect(resolved).not.toBe(join('.', '.realm', 'dedup'));
    } finally {
      if (savedHome !== undefined) process.env['HOME'] = savedHome;
    }
  });
});

// =================================================================================================
// issue #409 — the operator's fallback clock reaches spawned drives
//
// A step's own `llm_timeout_seconds` already wins, read inside the drive. What the listen operator
// had no way to set was the fallback for steps that author none: every spawned drive got the 600s
// default and nothing could change it.
// =================================================================================================
describe('--llm-timeout on listen (issue #409)', () => {
  // issue #620 PR-C: every child also carries the hidden --no-release-line-advisory (listen tells
  // the operator once at startup; a child per webhook must not repeat it).
  // issue #676: every argv now carries --model (realm has no default model).
  it('buildAgentArgv without the flag: the run id, the model and the advisory silencer only', () => {
    expect(buildAgentArgv('run-1', { model: 'm-676' })).toEqual([
      'agent',
      '--run-id',
      'run-1',
      '--model',
      'm-676',
      '--no-release-line-advisory',
    ]);
  });

  it('buildAgentArgv with the flag appends it as a string pair', () => {
    expect(buildAgentArgv('run-1', { model: 'm-676', llmTimeoutSeconds: 45 })).toEqual([
      'agent',
      '--run-id',
      'run-1',
      '--model',
      'm-676',
      '--llm-timeout',
      '45',
      '--no-release-line-advisory',
    ]);
  });

  // The WIRED pair. `buildAgentArgv` being right proves nothing about the spawn using it — that
  // is the #353 flag-drop class, where every cell stayed green while the closure was never wired.
  // Each cell also asserts the RETURN: an auto-mock returning undefined would throw inside
  // defaultSpawnAgent, be CAUGHT, and return `{error}` with the args already captured — so an
  // args-only assertion would pass against a broken mock.
  // issue #744: the WIRED cells cover `makeAgentSpawner`, the one factory that maps listen's
  // options to the agent's flags; the command passes its parsed options to it unchanged, and E5
  // (`no-default-model-676.test.ts`) checks that the provider it was given reaches the agent. Each
  // starts in an existing folder through the file's mock, which follows the folder and so starts
  // with pid 4242. (a) red when the factory drops a flag (deleting its `llmTimeoutSeconds` line
  // turns the first cell red, its `provider` line the third), or the spawn settles without a pid;
  // (b) prints the result and the argv.
  it('WIRED — the spawn carries the flag when the operator set one', async () => {
    spawnMock.mockClear();
    const result = await makeAgentSpawner({ model: 'm-676', llmTimeout: 45 }, silentLogger)(
      'run-42',
      existingFolder(),
    );
    expect(result).toEqual({ pid: 4242 });

    const [cmd, argv] = spawnMock.mock.calls[0]! as unknown as [string, string[]];
    expect(cmd).toBe(process.execPath);
    // Never pin this literal — under vitest it is the worker entry, not the realm binary.
    expect(argv[0]).toBe(process.argv[1] ?? '');
    expect(argv.slice(1)).toEqual([
      'agent',
      '--run-id',
      'run-42',
      '--model',
      'm-676',
      '--llm-timeout',
      '45',
      '--no-release-line-advisory',
    ]);
  });

  it('WIRED — the spawn is unchanged when the operator set none', async () => {
    spawnMock.mockClear();
    const result = await makeAgentSpawner({ model: 'm-676' }, silentLogger)(
      'run-43',
      existingFolder(),
    );
    expect(result).toEqual({ pid: 4242 });

    const [, argv] = spawnMock.mock.calls[0]! as unknown as [string, string[]];
    expect(argv.slice(1)).toEqual([
      'agent',
      '--run-id',
      'run-43',
      '--model',
      'm-676',
      '--no-release-line-advisory',
    ]);
    expect(argv).not.toContain('--llm-timeout');
  });

  it('WIRED — the spawn carries the provider, the model and the timeout when the operator set all three', async () => {
    spawnMock.mockClear();
    const result = await makeAgentSpawner(
      { model: 'm-676', provider: 'openai', llmTimeout: 45 },
      silentLogger,
    )('run-44', existingFolder());
    expect(result).toEqual({ pid: 4242 });

    const [cmd, argv] = spawnMock.mock.calls[0]! as unknown as [string, string[]];
    expect(cmd).toBe(process.execPath);
    expect(argv).toEqual([
      process.argv[1] ?? '',
      'agent',
      '--run-id',
      'run-44',
      '--provider',
      'openai',
      '--model',
      'm-676',
      '--llm-timeout',
      '45',
      '--no-release-line-advisory',
    ]);
  });

  // The parser's FIRST refusal cells anywhere — mirroring the --schema-retries trio. Driven by
  // Option introspection rather than parseAsync: a flagless parseAsync on this shared singleton
  // RUNS the action, which loads a workflow.yaml from the cwd and can start a real server.
  //
  // Commander 15 consumes a required option-argument unconditionally, so `--llm-timeout -5` on a
  // real argv genuinely delivers '-5' here — these represent reachable input, not a synthetic one.
  describe('the flag refuses what it should', () => {
    const opt = (): NonNullable<ReturnType<typeof findOpt>> => {
      const found = findOpt();
      expect(found).toBeDefined();
      return found!;
    };
    const findOpt = (): (typeof listenCommand.options)[number] | undefined =>
      listenCommand.options.find((o) => o.long === '--llm-timeout');

    for (const bad of ['0', '-5', 'abc']) {
      it(`rejects '${bad}'`, () => {
        expect(() => opt().parseArg!(bad, undefined)).toThrow(InvalidArgumentError);
        expect(() => opt().parseArg!(bad, undefined)).toThrow(
          '--llm-timeout must be a positive integer number of seconds.',
        );
      });
    }

    it('accepts a positive integer', () => {
      expect(opt().parseArg!('45', undefined)).toBe(45);
    });

    it('carries NO default — a defaulted flag would record a declaration nobody made', () => {
      // With a default, listen would pass `--llm-timeout 600` to every child and every spawned
      // drive would persist `declared_per_attempt_ms: 600000`. Absent means absent.
      expect(opt().defaultValue).toBeUndefined();
      expect(opt().parseArg).toBeDefined();
    });
  });
});

// =================================================================================================
// issue #676 — realm has no default model: listen passes --model to every drive it starts, and
// --provider only when the operator gave one. Exact argvs (`toEqual` on the whole argv), never a
// `not.toContain`: on the base `buildAgentArgv` takes the options object as the timeout and prints
// `--llm-timeout [object Object]`, so an absence check there would pass for the wrong reason.
// =================================================================================================
describe('--provider and --model on listen (issue #676)', () => {
  it('buildAgentArgv with --provider passes it before --model', () => {
    expect(buildAgentArgv('run-1', { model: 'm-676', provider: 'anthropic' })).toEqual([
      'agent',
      '--run-id',
      'run-1',
      '--provider',
      'anthropic',
      '--model',
      'm-676',
      '--no-release-line-advisory',
    ]);
  });

  it('buildAgentArgv without --provider passes none: the child picks from the API keys', () => {
    expect(buildAgentArgv('run-2', { model: 'gpt-x' })).toEqual([
      'agent',
      '--run-id',
      'run-2',
      '--model',
      'gpt-x',
      '--no-release-line-advisory',
    ]);
  });

  it('buildAgentArgv with every option: --provider, --model, --llm-timeout, then the silencer', () => {
    expect(
      buildAgentArgv('run-3', { model: 'm-676', provider: 'openai', llmTimeoutSeconds: 30 }),
    ).toEqual([
      'agent',
      '--run-id',
      'run-3',
      '--provider',
      'openai',
      '--model',
      'm-676',
      '--llm-timeout',
      '30',
      '--no-release-line-advisory',
    ]);
  });
});

// ── issue #744: listen waits for its agent to start or fail, and never stops on a start that fails
// later ─────────────────────────────────────────────────────────────────────────────────────────
// Node reports a missing `cwd` (ENOENT) or one it has no permission to enter (EACCES) as an
// `'error'` event on the next tick, not as a throw; a file in the folder's place (ENOTDIR), a link
// loop or a name too long throws at once. No cell here starts `node <vitest worker> agent …`: the
// fakes never start a process; A1's real spawn goes through a guard that refuses any `cwd` but its
// missing folder, so it can only fail; the contract cell's real spawns are guarded the same way and
// run `node -e 0`. The fakes are handed in by `fakeSpawn`, so each reads the `cwd` and the command
// defaultSpawnAgent really passes, and A2–A5 and L1 print `called: false` if it stops using them.
// The handler cells (B1, B2, C1, C2) stub the `spawnAgent` deps seam, which sits above the spawn.
// B1 and B2 get a folder Node agrees with their stub (B2 existing, B1 missing then created). C1 (a
// stub that throws) and C2 (a stub that rejects) are states the real spawner never produces —
// `defaultSpawnAgent` catches every throw and only resolves — kept on purpose to cover the
// handler's `catch`, the way A5 names `impossible`.
// Beside each cell: (a) the change that turns it red; (b) what it prints when it fails.
describe('issue #744 — an agent start that fails later', () => {
  type SpawnFn = NonNullable<Parameters<typeof defaultSpawnAgent>[4]>;
  type Line = [string, unknown];
  /** A spawn function handing out fakes that read the `cwd` they are really given. */
  const fakeSpawn = (
    opts?: Parameters<typeof fakeChild>[3],
  ): { spawnFn: SpawnFn; child: () => FakeChild | undefined } => {
    let last: FakeChild | undefined;
    const spawnFn = ((cmd: string, args: readonly string[], o: SpawnOptions) =>
      (last = fakeChild(cmd, String(o.cwd), args, opts))) as unknown as SpawnFn;
    return { spawnFn, child: () => last };
  };
  /**
   * Settles with the result, or `'never settled'` after `ms` (2 s by default) — a failure says so,
   * never hangs.
   */
  async function settledWithin(p: Promise<SpawnResult> | SpawnResult, ms = 2_000) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'never settled'>((resolve) => {
      timer = setTimeout(() => resolve('never settled'), ms);
    });
    try {
      return await Promise.race([Promise.resolve(p), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
  /** The result as printed: its pid, or its error's code (the message when it has none). */
  const shown = (r: SpawnResult | 'never settled') =>
    r === 'never settled'
      ? r
      : 'error' in r
        ? { error: (r.error as NodeJS.ErrnoException).code ?? String(r.error) }
        : { pid: r.pid };
  const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

  it('A1 — a REAL start in a missing folder resolves { error } ENOENT, and nothing is left unhandled', async () => {
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    const cwd = missingFolder();
    spawnMock.mockClear();
    let realCalls = 0;
    // The real spawn only through this guard: if a change to defaultSpawnAgent stopped passing the
    // folder, the guard throws and nothing starts — never `node <vitest worker> agent …`.
    const guarded = ((cmd: string, args: readonly string[], opts: SpawnOptions) => {
      realCalls++;
      if (opts.cwd !== cwd) throw new Error('A1 guard: cwd not passed to spawn');
      return actual.spawn(cmd, args, opts);
    }) as unknown as SpawnFn;
    const result = await settledWithin(
      defaultSpawnAgent('run-a1', cwd, { model: 'm-744' }, () => {}, guarded),
    );
    // Let the child's later events pass inside this cell: an unhandled `'error'` is reported here.
    await nextTurn();
    // (a) red when defaultSpawnAgent settles before Node answers, attaches no `'error'` listener
    //     (on the real spawn, the unhandled `'error'` that ended `realm listen`), stops passing the
    //     folder (the guard's error), or stops using the spawn function it is given (`realCalls` 0,
    //     `spawnMock` called); (b) prints the result (its pid, its error code — the guard's message
    //     when it has none — or "never settled"), the guard's call count and the mock's.
    expect({
      result: shown(result),
      realCalls,
      mockCalls: spawnMock.mock.calls.length,
    }).toEqual({ result: { error: 'ENOENT' }, realCalls: 1, mockCalls: 0 });
  });

  it('A2 — the fake in a missing folder resolves { error }, the error the child sent', async () => {
    const cwd = missingFolder();
    const fake = fakeSpawn();
    const result = await settledWithin(
      defaultSpawnAgent('run-a2', cwd, { model: 'm-744' }, () => {}, fake.spawnFn),
    );
    // (a) red when an `'error'` before `'spawn'` does not settle `{ error }`, settles another
    //     error than the one the child sent, or defaultSpawnAgent stops using the spawn function it
    //     is given (`called: false`); (b) prints the result, whether the fake was called, and
    //     whether the error is the child's `sentError`.
    const child = fake.child();
    expect({
      result: shown(result),
      called: child !== undefined,
      same: result !== 'never settled' && 'error' in result && result.error === child?.sentError,
    }).toEqual({ result: { error: 'ENOENT' }, called: true, same: true });
  });

  it("A3 — the fake in an existing folder resolves { pid }, and is unref'd", async () => {
    const cwd = existingFolder();
    const fake = fakeSpawn();
    const result = await settledWithin(
      defaultSpawnAgent('run-a3', cwd, { model: 'm-744' }, () => {}, fake.spawnFn),
    );
    // (a) red when the result carries no pid, the child is not unref'd, the folder is not passed
    //     to spawn (the fake then fails in a folder that does not exist), or defaultSpawnAgent stops
    //     using the spawn function it is given (`called: false`); (b) prints the result (or "never
    //     settled"), whether the fake was called, and the `unref` call count.
    const child = fake.child();
    expect({
      result: shown(result),
      called: child !== undefined,
      unref: child?.unref.mock.calls.length,
    }).toEqual({ result: { pid: 4242 }, called: true, unref: 1 });
  });

  it("A4 — every 'error' AFTER 'spawn' goes to onLateError; nothing is left unhandled", async () => {
    const cwd = existingFolder();
    const onLateError = vi.fn();
    const fake = fakeSpawn({ lateErrors: [new Error('late one'), new Error('late two')] });
    const result = await settledWithin(
      defaultSpawnAgent('run-a4', cwd, { model: 'm-744' }, onLateError, fake.spawnFn),
    );
    await nextTurn();
    // (a) red when the `'error'` listener goes once the child has started or after its first late
    //     error (`once` instead of `on`: `late two` is not received, and is reported unhandled), a
    //     late error is dropped, the folder is not passed to spawn, or the spawn function is not
    //     used (`called: false`); (b) prints the result, whether the fake was called, and the
    //     messages the callback received.
    expect({
      result: shown(result),
      called: fake.child() !== undefined,
      received: onLateError.mock.calls.map(([e]) => (e as Error).message),
    }).toEqual({ result: { pid: 4242 }, called: true, received: ['late one', 'late two'] });
  });

  it("A5 — a 'spawn' with no process id resolves { error } saying so", async () => {
    const cwd = existingFolder();
    const fake = fakeSpawn({ impossible: 'spawn-without-pid' });
    const result = await settledWithin(
      defaultSpawnAgent('run-a5', cwd, { model: 'm-744' }, () => {}, fake.spawnFn),
    );
    // The one state Node never produces, made on purpose: the guard covers the type checker's
    // `number | undefined`. (a) red when the guard's message changes, a pid-less start is
    //     answered `{ pid }`, or the spawn function is not used (`called: false`); (b) prints the
    //     result, whether the fake was called, and the result's message.
    expect({
      result: result === 'never settled' ? result : 'error' in result ? 'error' : 'pid',
      called: fake.child() !== undefined,
      message: result !== 'never settled' && 'error' in result ? result.error.message : undefined,
    }).toEqual({
      result: 'error',
      called: true,
      message: "Node reported the agent's start without a process id",
    });
  });

  it("L1 — the command's spawner logs an error after the start once, as webhook: agent process error", async () => {
    const cwd = existingFolder();
    const calls: Array<[string, string, unknown]> = [];
    const logger: Logger = {
      debug: (m, d) => calls.push(['debug', m, d]),
      info: (m, d) => calls.push(['info', m, d]),
      warn: (m, d) => calls.push(['warn', m, d]),
      error: (m, d) => calls.push(['error', m, d]),
    };
    const late = new Error('late one');
    const fake = fakeSpawn({ lateErrors: [late] });
    const result = await settledWithin(
      makeAgentSpawner({ model: 'm-744' }, logger, fake.spawnFn)('run-l1', cwd),
    );
    await nextTurn();
    // (a) red when the factory's late-error callback is not wired to the logger, logs at another
    //     level, under another message, or without the run, the folder or the error, the folder is
    //     not passed to spawn, or the spawn function is not used (`called: false`); (b) prints the
    //     result, whether the fake was called, and every logger call (level, message, data).
    expect({ result: shown(result), called: fake.child() !== undefined, calls }).toEqual({
      result: { pid: 4242 },
      called: true,
      calls: [
        [
          'error',
          'webhook: agent process error',
          { run_id: 'run-l1', cwd, error: 'Error: late one' },
        ],
      ],
    });
  });

  it('contract — the fake and the real spawn agree, state by state, over nine folder states (Node’s own rule)', async () => {
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    const node = process.execPath;
    // The nine states, built here under a fresh folder; every mode is restored in `finally`, and
    // again by the shared `afterEach` through `restores`, before the folder cleanup (`rmSync`
    // throws EACCES on a mode-000 tree). `restores` closes the cell failing before its `try`; it is
    // also meant for vitest timing the cell out while it waits inside its `try`: `afterEach` then
    // runs while the cell is still pending (vitest's order; not run on this cell). A real start
    // settles in milliseconds, so each half waits at most 500 ms (9 states × 2 halves × 0.5 s = 9 s
    // at worst, within the cell's own 15 s budget).
    const base = existingFolder();
    const enterable = join(base, 'enterable');
    mkdirSync(enterable);
    const mode000 = join(base, 'mode000');
    mkdirSync(mode000);
    const lockedParent = join(base, 'locked');
    mkdirSync(join(lockedParent, 'inner'), { recursive: true });
    const file = join(base, 'file');
    writeFileSync(file, 'not a folder\n');
    symlinkSync(join(base, 'nowhere'), join(base, 'dangling'));
    symlinkSync(join(base, 'loop-b'), join(base, 'loop-a'));
    symlinkSync(join(base, 'loop-a'), join(base, 'loop-b'));
    const states: Array<[string, string]> = [
      ['missing', join(base, 'missing')],
      ['a dangling link', join(base, 'dangling')],
      ['an enterable folder', enterable],
      ['no permission to enter (mode 000)', mode000],
      ['inside a parent with no permission', join(lockedParent, 'inner')],
      ['a file in its place', file],
      ['a path through a file', join(file, 'inner')],
      ['a link loop', join(base, 'loop-a')],
      ['a name too long', join(base, 'n'.repeat(300))],
    ];
    /** Records a child's events, written `spawn`, `error:CODE`, `close:CODE`, `exit:CODE`. */
    const record = (c: EventEmitter, into: string[]): void => {
      c.on('spawn', () => into.push('spawn'));
      c.on('error', (e: NodeJS.ErrnoException) => into.push(`error:${e.code}`));
      c.on('close', (code: number) => into.push(`close:${code}`));
      c.on('exit', (code: number) => into.push(`exit:${code}`));
    };
    const shownPath = (v: unknown) => (typeof v === 'string' ? v.split(node).join('<node>') : v);
    /** One row: how the start settled, its code, the pid's type right after the spawn function
     *  returned (`threw` when it threw), the events to the settle, and the settled error's shape. */
    const row = (r: SpawnResult | 'never settled', pidAtReturn: string, events: string[]) => {
      const err =
        r !== 'never settled' && 'error' in r ? (r.error as NodeJS.ErrnoException) : undefined;
      return {
        settled: r === 'never settled' ? r : 'error' in r ? 'error' : 'pid',
        code: err?.code,
        pidAtReturn,
        events,
        error:
          err === undefined
            ? undefined
            : {
                message: shownPath(err.message),
                syscall: shownPath(err.syscall),
                errno: err.errno,
                path: shownPath(err.path),
              },
      };
    };
    let realCalls = 0;
    const real: Record<string, unknown> = {};
    const fake: Record<string, unknown> = {};
    spawnMock.mockClear();
    restores.push(() => chmodSync(mode000, 0o755));
    chmodSync(mode000, 0o000);
    restores.push(() => chmodSync(lockedParent, 0o755));
    chmodSync(lockedParent, 0o000);
    // Whether the locks hold for this process: as root, Node starts in the two permission states
    // (`X_OK` passes), and the fake does too; for a normal user on Linux the check below requires
    // that they hold.
    let locksHold = false;
    try {
      accessSync(mode000, fsConstants.X_OK);
    } catch {
      locksHold = true;
    }
    if (process.platform === 'linux' && process.getuid?.() !== 0) {
      // This cell is the only test of the fake's EACCES path. (a) red when the locks do not take
      //     for a normal user on Linux (the two `chmodSync(…, 0o000)` lines dropped, or a temp
      //     folder on a mount that ignores modes): both halves would then start in the two
      //     permission states and the cell would stay green; (b) prints `locksHold` and the uid.
      expect({ locksHold, uid: process.getuid?.() }).toEqual({
        locksHold: true,
        uid: process.getuid?.(),
      });
    }
    try {
      for (const [name, cwd] of states) {
        // The REAL half: Node's own spawn, guarded to this state's folder, the options as
        // defaultSpawnAgent passes them, the arguments swapped to `-e 0` — never
        // `node <vitest worker> agent …`.
        const realEvents: string[] = [];
        let realPid = 'not called';
        const realSpawn = ((cmd: string, _args: readonly string[], opts: SpawnOptions) => {
          realCalls++;
          if (opts.cwd !== cwd) throw new Error('contract guard: cwd not passed to spawn');
          let c: ChildProcess;
          try {
            c = actual.spawn(cmd, ['-e', '0'], opts);
          } catch (err) {
            realPid = 'threw';
            throw err;
          }
          realPid = typeof c.pid;
          record(c, realEvents);
          return c;
        }) as unknown as SpawnFn;
        const realResult = await settledWithin(
          defaultSpawnAgent('run-c', cwd, { model: 'm-744' }, () => {}, realSpawn),
          500,
        );
        real[name] = row(realResult, realPid, [...realEvents]);
        // The FAKE half: no spawn function, so it goes through the file-wide mock.
        const fakeEvents: string[] = [];
        const callsBefore = spawnMock.mock.results.length;
        const fakePending = defaultSpawnAgent('run-c', cwd, { model: 'm-744' }, () => {});
        let fakePid = 'threw';
        if (spawnMock.mock.results.length === callsBefore) {
          // The mock was not called: say so, instead of reading the previous state's call.
          fakePid = 'not called';
          fakeEvents.push('not called');
        } else {
          const lastCall = spawnMock.mock.results.at(-1)!;
          if (lastCall.type === 'return') {
            const c = lastCall.value as FakeChild;
            fakePid = typeof c.pid;
            record(c, fakeEvents);
          }
        }
        const fakeResult = await settledWithin(fakePending, 500);
        fake[name] = row(fakeResult, fakePid, [...fakeEvents]);
      }
    } finally {
      chmodSync(mode000, 0o755);
      chmodSync(lockedParent, 0o755);
    }
    await nextTurn();
    // (a) red when the fake stops following Node's rule for any state (no `accessSync` step: mode
    //     000 starts; `statSync`'s no-throw form: a path through a file fails ENOENT instead of
    //     throwing ENOTDIR; an escaping EACCES: the locked parent throws), stops sending `'close'`,
    //     changes the error's shape, or the mock stops passing its command and options; also when
    //     Node's own behaviour changes; (b) prints the fake's and the real table, state by state
    //     (settled, code, the pid's type at return, the events to the settle, the error's message,
    //     syscall, errno and path, with `<node>` for the Node program), and the call counts.
    expect({ fake, mockCalls: spawnMock.mock.calls.length }).toEqual({
      fake: real,
      mockCalls: states.length,
    });
    expect(realCalls).toBe(states.length);
    // The table Node gives on Linux (checked there only: no macOS run is recorded). Seven rows do
    // not depend on permissions; the two permission rows follow the access check above: EACCES when
    // the locks hold, a start when they do not (as root; for a normal user on Linux the check above
    // fails first). (a) red when Node's own behaviour changes, or the permission rows stop
    // following the check; (b) prints the real table.
    if (process.platform === 'linux') {
      const failedLater = (code: string, errno: number) => ({
        settled: 'error',
        code,
        pidAtReturn: 'undefined',
        events: [`error:${code}`, `close:${errno}`],
        error: { message: `spawn <node> ${code}`, syscall: 'spawn <node>', errno, path: '<node>' },
      });
      const threwAtOnce = (code: string, errno: number) => ({
        settled: 'error',
        code,
        pidAtReturn: 'threw',
        events: [],
        error: { message: `spawn ${code}`, syscall: 'spawn', errno, path: undefined },
      });
      const started = {
        settled: 'pid',
        code: undefined,
        pidAtReturn: 'number',
        events: ['spawn'],
        error: undefined,
      };
      const locked = locksHold ? failedLater('EACCES', -13) : started;
      expect(real).toEqual({
        missing: failedLater('ENOENT', -2),
        'a dangling link': failedLater('ENOENT', -2),
        'an enterable folder': started,
        'no permission to enter (mode 000)': locked,
        'inside a parent with no permission': locked,
        'a file in its place': threwAtOnce('ENOTDIR', -20),
        'a path through a file': threwAtOnce('ENOTDIR', -20),
        'a link loop': threwAtOnce('ELOOP', -osConstants.errno.ELOOP),
        'a name too long': threwAtOnce('ENAMETOOLONG', -osConstants.errno.ENAMETOOLONG),
      });
    }
  }, 15_000);

  it('not modelled — the fake refuses late errors after a start that fails', () => {
    // (a) red when the fake's "not modelled" guard is removed (it then builds a child Node would
    //     never give, whose `'error'` nothing listens to — vitest reports it unhandled); (b) prints
    //     what was thrown, or that nothing was.
    expect(() =>
      fakeChild(process.execPath, missingFolder(), [], { lateErrors: [new Error('x')] }),
    ).toThrow('state not modelled');
  });

  it('not modelled — the fake refuses a spawn without a pid after a start that fails', () => {
    // (a) red when the guard's `impossible` condition is removed (the fake then builds a failed
    //     start whose `'error'` nothing listens to — vitest reports `spawn <node> ENOENT` unhandled);
    //     (b) prints what was thrown, or that nothing was.
    expect(() =>
      fakeChild(process.execPath, missingFolder(), [], { impossible: 'spawn-without-pid' }),
    ).toThrow('state not modelled');
  });

  it('not modelled — the fake refuses a code os.constants.errno does not know (a NUL in the path)', () => {
    // `statSync` throws `ERR_INVALID_ARG_VALUE`, which `os.constants.errno` does not know. (a) red
    //     when the guard's `known === undefined` condition is removed (the fake then throws
    //     `spawn ERR_INVALID_ARG_VALUE`); (b) prints what was thrown, or that nothing was.
    expect(() => fakeChild(process.execPath, 'a\0b', [])).toThrow('state not modelled');
  });

  it('types — a start result is a pid or an error, never both', () => {
    // A type-level cell: it runs nothing. (a) red when `SpawnResult` lets both be written (remove
    //     its `?: never` fields: `npm run typecheck:tests` fails on the unused directive, TS2578);
    //     (b) prints the type checker's error.
    // @ts-expect-error — a start result is a pid or an error, never both
    const _both: SpawnResult = { pid: 1, error: new Error('x') };
  });

  const routesIn = (cwd: string): Map<string, WorkflowEntry> =>
    buildRouteTable([{ definition: wf(SHARED_SECRET_TRIGGER), workflowDir: cwd }], {
      env: ENV,
      logger: silentLogger,
    });
  const delivery = (id: string) => ({
    url: '/wf',
    headers: { ...JSON_CT, authorization: SECRET },
    body: JSON.stringify({ id }),
  });

  it('B1 — the handler: a start that fails later → 500 spawn_failed, sealed spawn_failure, no agent_pid, the line names the folder; the next delivery → 202', async () => {
    const cwd = missingFolder();
    const errors: Line[] = [];
    let call = 0;
    const deps = makeDeps({
      spawnAgent: vi.fn((): Promise<SpawnResult> =>
        ++call === 1
          ? Promise.resolve({
              error: Object.assign(new Error('spawn …node ENOENT'), { code: 'ENOENT' }),
            })
          : Promise.resolve({ pid: 4243 }),
      ),
      logger: { ...silentLogger, error: (m: string, d?: unknown) => errors.push([m, d]) },
    });
    const handler = makeListenHandler(routesIn(cwd), deps);
    const first = await invoke(handler, delivery('evt-744-a'));
    const runId = first.body['run_id'] as string;
    const run = await deps.runStore.get(runId);
    // The folder comes back before the second delivery, as the stub's `{ pid }` then claims.
    mkdirSync(cwd);
    const second = await invoke(handler, delivery('evt-744-b'));
    // (a) red when the spawn result is not awaited (before #744: the Promise has no `error` key,
    //     so `202` with `agent_pid` undefined and the run left running), or the line loses `cwd`;
    //     (b) prints the first reply, the run's seal, phase and agent_pid, the spawn-failed lines'
    //     data, and the second reply (whether its run is new).
    expect({
      first,
      sealed_by: run.sealed_by,
      run_phase: run.run_phase,
      agent_pid: run.agent_pid,
      logged: errors.filter(([m]) => m === 'webhook: spawn failed'),
      second: {
        status: second.status,
        accepted: second.body['status'],
        newRun: typeof second.body['run_id'] === 'string' && second.body['run_id'] !== runId,
      },
    }).toEqual({
      first: { status: 500, body: { error: 'spawn_failed', run_id: runId, status: 'failed' } },
      sealed_by: { arm: 'spawn_failure' },
      run_phase: 'failed',
      agent_pid: undefined,
      logged: [
        [
          'webhook: spawn failed',
          { path: '/wf', run_id: runId, cwd, error: 'Error: spawn …node ENOENT' },
        ],
      ],
      second: { status: 202, accepted: 'accepted', newRun: true },
    });
  });

  it('B2 — the handler: a start that succeeds later → 202, agent_pid recorded', async () => {
    const cwd = existingFolder();
    const deps = makeDeps({
      spawnAgent: vi.fn((): Promise<SpawnResult> => Promise.resolve({ pid: 4242 })),
    });
    const handler = makeListenHandler(routesIn(cwd), deps);
    const reply = await invoke(handler, delivery('evt-744-c'));
    const run = await deps.runStore.get(reply.body['run_id'] as string);
    // (a) red when the spawn result is not awaited (before #744: `agent_pid` undefined); (b) prints
    //     the reply's status and the run's agent_pid.
    expect({ status: reply.status, agent_pid: run.agent_pid }).toEqual({
      status: 202,
      agent_pid: 4242,
    });
  });

  it('C1 — the handler: a spawnAgent that throws logs webhook: spawn failed with the folder', async () => {
    // A stub that throws: a state the real spawner never produces (`defaultSpawnAgent` catches
    // every throw and only resolves), kept to cover the handler's `catch`. The folder's path holds
    // a file.
    const cwd = missingFolder();
    writeFileSync(cwd, 'not a folder\n');
    const errors: Line[] = [];
    const deps = makeDeps({
      spawnAgent: vi.fn(() => {
        throw new Error('spawn ENOTDIR');
      }),
      logger: { ...silentLogger, error: (m: string, d?: unknown) => errors.push([m, d]) },
    });
    const handler = makeListenHandler(routesIn(cwd), deps);
    const reply = await invoke(handler, delivery('evt-744-d'));
    // The synchronous branch of the changed line (guardrail 7 (a)); B1 is the asynchronous one.
    // (a) red when the line loses `cwd` (before #744: no `cwd`); (b) prints the reply's status and
    //     the spawn-failed lines' data.
    expect({
      status: reply.status,
      logged: errors.filter(([m]) => m === 'webhook: spawn failed'),
    }).toEqual({
      status: 500,
      logged: [
        [
          'webhook: spawn failed',
          { path: '/wf', run_id: reply.body['run_id'], cwd, error: 'Error: spawn ENOTDIR' },
        ],
      ],
    });
  });

  it('C2 — the handler: a spawnAgent that rejects → 500 spawn_failed, sealed spawn_failure, the line with the folder', async () => {
    const cwd = missingFolder();
    const errors: Line[] = [];
    const deps = makeDeps({
      spawnAgent: vi.fn(() => Promise.reject(new Error('rejected start'))),
      logger: { ...silentLogger, error: (m: string, d?: unknown) => errors.push([m, d]) },
    });
    const handler = makeListenHandler(routesIn(cwd), deps);
    const reply = await invoke(handler, delivery('evt-744-e'));
    const runId = reply.body['run_id'] as string;
    const run = await deps.runStore.get(runId);
    // (a) red when the awaited spawn is not inside the handler's `try` (the rejection escapes the
    //     handler and fails this cell; through the real server, `500 internal_error`); (b) prints
    //     the reply, the run's seal and agent_pid, and the spawn-failed lines' data.
    expect({
      reply,
      sealed_by: run.sealed_by,
      agent_pid: run.agent_pid,
      logged: errors.filter(([m]) => m === 'webhook: spawn failed'),
    }).toEqual({
      reply: { status: 500, body: { error: 'spawn_failed', run_id: runId, status: 'failed' } },
      sealed_by: { arm: 'spawn_failure' },
      agent_pid: undefined,
      logged: [
        [
          'webhook: spawn failed',
          { path: '/wf', run_id: runId, cwd, error: 'Error: rejected start' },
        ],
      ],
    });
  });
});

// ── #744 follow-up E2: listen's early replies reach the sender ───────────────────────────────────
// Every cell starts a real server (`startListen`) on a free loopback port and sends to it with a
// real client, because the fake harness above has no socket: its 413/408 cells pass while no sender
// receives the reply. `lingerMs` is 500 here (2 s in the CLI). "The server closes the socket" is that
// connection's server-side `'close'`, timed from the status line the sender received.
describe('E2 — early replies reach the sender', () => {
  type ServeOptions = Partial<Parameters<typeof startListen>[1]>;
  const LINGER = 500;
  // Every time in this block is `performance.now()`, never `Date.now()`: the wall clock can step
  // (on one WSL2 machine, about 1 s forward twice every 30 s), and a wait or an interval measured
  // across a step is wrong by that much. Timers already run on the monotonic clock.
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (pred: () => boolean, ms: number): Promise<boolean> => {
    const deadline = performance.now() + ms;
    while (!pred() && performance.now() < deadline) await sleep(10);
    return pred();
  };

  /** A real listen server with the E2 defaults; each server-side socket's close time by port. */
  async function serve(over: ServeOptions = {}, deps = makeDeps()) {
    const signals = ['SIGTERM', 'SIGINT'] as const;
    const before = new Map(signals.map((sig) => [sig, process.listeners(sig)]));
    const handle = await startListen(
      routesFor(wf(SHARED_SECRET_TRIGGER)),
      {
        port: 0,
        host: '127.0.0.1',
        maxBodyBytes: 100,
        bodyTimeoutMs: 400,
        maxConcurrent: 2,
        lingerMs: LINGER,
        ...over,
      } as Parameters<typeof startListen>[1],
      deps,
    );
    onTestFinished(() => {
      handle.server.closeAllConnections();
      return handle.shutdown('test');
    });
    for (const sig of signals) {
      for (const l of process.listeners(sig)) {
        if (!before.get(sig)!.includes(l)) process.removeListener(sig, l);
      }
    }
    const closedAt = new Map<number, number>();
    handle.server.on('connection', (sock) => {
      const port = sock.remotePort;
      sock.once('close', () => {
        if (port !== undefined) closedAt.set(port, performance.now());
      });
    });
    const port = (handle.server.address() as AddressInfo).port;
    return { handle, port, closedAt, deps };
  }

  /** The reply as the sender saw it: the status, the `connection` header and the JSON body. */
  const parse = (raw: string) => {
    const m = /^HTTP\/1\.1 (\d{3})/.exec(raw);
    const head = raw.split('\r\n\r\n')[0] ?? '';
    const connection = /\r\nconnection: *([^\r\n]*)/i.exec(head)?.[1]?.toLowerCase();
    const json = /\{[^{}]*\}/.exec(raw.slice(head.length))?.[0];
    let body: unknown;
    try {
      body = json === undefined ? undefined : JSON.parse(json);
    } catch {
      body = json;
    }
    return { status: m === null ? 'no reply' : Number(m[1]), connection, body };
  };

  /**
   * S-raw: a half-open socket (`allowHalfOpen`, so the server's FIN does not end its own side),
   * which writes `head`, then `chunk` every `everyMs` on its own schedule, after the reply too.
   */
  function rawSender(port: number, head: string, chunk?: string | Buffer, everyMs = 50) {
    const sock = netConnect({ host: '127.0.0.1', port, allowHalfOpen: true });
    const state = {
      raw: '',
      localPort: undefined as number | undefined,
      statusAt: undefined as number | undefined,
      /** One arrival time per status line received, in order. */
      statusTimes: [] as number[],
      endAt: undefined as number | undefined,
      error: undefined as string | undefined,
    };
    let timer: ReturnType<typeof setInterval> | undefined;
    const stop = (): void => {
      clearInterval(timer);
      sock.destroy();
    };
    onTestFinished(stop);
    sock.on('connect', () => {
      state.localPort = sock.localPort;
      sock.write(head);
      if (chunk !== undefined) {
        timer = setInterval(() => {
          if (!sock.destroyed && sock.writable) sock.write(chunk);
        }, everyMs);
      }
    });
    sock.on('data', (d: Buffer) => {
      state.raw += d.toString('latin1');
      if (state.statusAt === undefined && state.raw.startsWith('HTTP/1.1 ')) {
        state.statusAt = performance.now();
      }
      const lines = state.raw.match(/HTTP\/1\.1 \d{3}/g)?.length ?? 0;
      while (state.statusTimes.length < lines) state.statusTimes.push(performance.now());
    });
    sock.on('end', () => {
      state.endAt = performance.now();
    });
    sock.on('error', (e: NodeJS.ErrnoException) => {
      state.error ??= e.code ?? e.message;
    });
    sock.on('close', () => clearInterval(timer));
    return { state, stop, sock };
  }

  /** A request head for S-raw. */
  const headOf = (method: string, path: string, length: number, extra = ''): string =>
    `${method} ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n` +
    `Content-Length: ${length}\r\n${extra}\r\n`;

  /** How long after its status line the server closed this sender's socket (or why it is not known). */
  const closedAfter = async (
    closedAt: Map<number, number>,
    state: { localPort?: number | undefined; statusAt?: number | undefined },
    waitMs: number,
  ): Promise<number | string> => {
    if (!(await waitFor(() => state.statusAt !== undefined, 3_000))) return 'no status line';
    await waitFor(() => closedAt.has(state.localPort!), waitMs);
    const at = closedAt.get(state.localPort!);
    return at === undefined ? `still open after ${waitMs} ms` : at - state.statusAt!;
  };

  /** S-http / S-stream: a sender in its own thread, which posts back what it received. */
  async function inWorker(src: string, port: number) {
    const worker = new Worker(src, { eval: true, workerData: { port } });
    onTestFinished(() => worker.terminate().then(() => undefined));
    return await new Promise<Record<string, unknown>>((resolve) => {
      const timer = setTimeout(() => resolve({ error: 'no answer within 20 s' }), 20_000);
      worker.once('message', (m: Record<string, unknown>) => {
        clearTimeout(timer);
        resolve(m);
      });
      worker.once('error', (e: Error) => {
        clearTimeout(timer);
        resolve({ error: `worker: ${e.message}` });
      });
    });
  }

  it('C1 — a 5000-byte Buffer sent with fetch gets 413 with its JSON and Connection: close', async () => {
    const { port } = await serve();
    const got = await fetch(`http://127.0.0.1:${port}/wf`, {
      method: 'POST',
      headers: JSON_CT,
      body: Buffer.alloc(5000, 97),
    }).then(
      async (res) => ({
        status: res.status,
        body: (await res.json()) as unknown,
        connection: res.headers.get('connection'),
      }),
      (e: Error & { cause?: { code?: string } }) => ({ error: e.cause?.code ?? e.message }),
    );
    // (a) red when the 413 never reaches the sender (`readBody` destroys the request first), or
    //     the reply does not carry `Connection: close`; (b) prints the status, body and header,
    //     or the sender's error.
    expect(got).toEqual({
      status: 413,
      body: { error: 'payload_too_large', max_body_bytes: 100 },
      connection: 'close',
    });
  }, 15_000);

  const BIG = 50 * 1024 * 1024;
  it('C4 — http.request writing 50 MiB in 64 KiB chunks, no Content-Length, gets 413 with its JSON', async () => {
    const { port } = await serve();
    const got = await inWorker(
      `const { parentPort, workerData } = require('node:worker_threads');
       const http = require('node:http');
       const req = http.request({ host: '127.0.0.1', port: workerData.port, path: '/wf', method: 'POST',
         headers: { 'content-type': 'application/json' } }, (res) => {
         let body = ''; res.setEncoding('utf8');
         res.on('data', (d) => (body += d));
         res.on('end', () => parentPort.postMessage({ status: res.statusCode, body }));
         res.on('error', (e) => parentPort.postMessage({ error: e.code || e.message }));
       });
       req.on('error', (e) => parentPort.postMessage({ error: e.code || e.message }));
       const chunk = Buffer.alloc(64 * 1024, 97); let sent = 0;
       const pump = () => { while (sent < ${BIG}) { sent += chunk.length;
         if (!req.write(chunk)) { req.once('drain', pump); return; } } req.end(); };
       pump();`,
      port,
    );
    // (a) red when the sender sees the connection reset (ECONNRESET/EPIPE) instead of the reply:
    //     a sender that writes its whole body before reading needs the server to keep reading
    //     after the reply; (b) prints the status and body, or the sender's error code.
    expect(got).toEqual({
      status: 413,
      body: JSON.stringify({ error: 'payload_too_large', max_body_bytes: 100 }),
    });
  }, 30_000);

  it('C5 — fetch with a streamed 50 MiB body gets 413 with its JSON', async () => {
    const { port } = await serve();
    const got = await inWorker(
      `const { parentPort, workerData } = require('node:worker_threads');
       let sent = 0;
       const body = new ReadableStream({ pull(c) {
         if (sent >= ${BIG}) { c.close(); return; }
         sent += 65536; c.enqueue(new Uint8Array(65536).fill(97)); } });
       fetch('http://127.0.0.1:' + workerData.port + '/wf', { method: 'POST',
         headers: { 'content-type': 'application/json' }, body, duplex: 'half' })
         .then(async (r) => parentPort.postMessage({ status: r.status, body: await r.text() }),
               (e) => parentPort.postMessage({ error: (e.cause && e.cause.code) || e.message }));`,
      port,
    );
    // (a) red when the streamed sender sees the connection end before the reply; (b) prints the
    //     status and body, or the sender's error.
    expect(got).toEqual({
      status: 413,
      body: JSON.stringify({ error: 'payload_too_large', max_body_bytes: 100 }),
    });
  }, 30_000);

  it('C6 — a body arriving 1 byte every 300 ms gets 408 with its JSON, and the socket is closed within the linger', async () => {
    const { port, closedAt } = await serve();
    const s = rawSender(port, headOf('POST', '/wf', 10), 'a', 300);
    const after = await closedAfter(closedAt, s.state, LINGER + 1_500);
    const reply = parse(s.state.raw);
    // (a) red when the 408 never reaches the sender, or the server holds the socket past
    //     `lingerMs` + 1500 ms; (b) prints the reply (status, connection, body) and the close time.
    expect({
      ...reply,
      closedInTime: typeof after === 'number' && after <= LINGER + 1_500,
      after,
    }).toEqual({
      status: 408,
      connection: 'close',
      body: { error: 'request_timeout', body_timeout_ms: 400 },
      closedInTime: true,
      after: expect.any(Number),
    });
  }, 15_000);

  it.each([
    ['C7', 'an unknown address', 'POST', '/nope', 403],
    ['C8', 'a method other than POST', 'PUT', '/wf', 405],
  ] as const)(
    '%s — %s (%s %s) gets %i while the sender keeps sending, and the server closes within the linger',
    async (_cell, _what, method, path, status) => {
      const { port, closedAt } = await serve();
      const s = rawSender(port, headOf(method, path, 1_000_000), Buffer.alloc(1024, 97), 50);
      const after = await closedAfter(closedAt, s.state, LINGER + 1_500);
      // (a) red when the reply is not sent, the server keeps the socket open past `lingerMs` +
      //     1500 ms while the sender keeps sending (Node would read the whole body over a kept-alive
      //     connection), or the server closes it before `lingerMs` − 200 ms (no linger: a sender
      //     still writing may see a reset instead of the reply); (b) prints the status and the
      //     close time (or "still open after …").
      expect({ status: parse(s.state.raw).status, after }).toEqual({
        status,
        after: expect.any(Number),
      });
      expect(after as number).toBeLessThanOrEqual(LINGER + 1_500);
      expect(after as number).toBeGreaterThanOrEqual(LINGER - 200);
    },
    15_000,
  );

  it('C9 — at the concurrency limit, a second request gets 503 while it keeps sending, and is closed within the linger', async () => {
    const { port, closedAt } = await serve({ maxConcurrent: 1, bodyTimeoutMs: 3_000 });
    // The first request is held inside its body timeout by a slow body (1 byte every 300 ms).
    const held = rawSender(port, headOf('POST', '/wf', 50), 'a', 300);
    await waitFor(() => held.state.localPort !== undefined, 2_000);
    await sleep(200);
    const s = rawSender(port, headOf('POST', '/wf', 1_000_000), Buffer.alloc(1024, 97), 50);
    const after = await closedAfter(closedAt, s.state, LINGER + 1_500);
    // (a) red when the 503 is not sent, its socket stays open past `lingerMs` + 1500 ms, or it
    //     closes before `lingerMs` − 200 ms (no linger); (b) prints the second request's status and
    //     close time, and whether the first is still waiting (no reply).
    expect({
      status: parse(s.state.raw).status,
      after,
      firstStillWaiting: held.state.statusAt === undefined,
    }).toEqual({ status: 503, after: expect.any(Number), firstStillWaiting: true });
    expect(after as number).toBeLessThanOrEqual(LINGER + 1_500);
    expect(after as number).toBeGreaterThanOrEqual(LINGER - 200);
  }, 15_000);

  it('C10 — at most --max-concurrent connections linger: the first lingers, the second is closed at once', async () => {
    const { port, closedAt } = await serve({ maxConcurrent: 1 });
    const first = rawSender(port, headOf('POST', '/nope', 1_000_000), Buffer.alloc(1024, 97), 50);
    await waitFor(() => first.state.statusAt !== undefined, 3_000);
    const second = rawSender(port, headOf('POST', '/nope', 1_000_000), Buffer.alloc(1024, 97), 50);
    const secondAfter = await closedAfter(closedAt, second.state, LINGER + 1_500);
    const firstAfter = await closedAfter(closedAt, first.state, LINGER + 1_500);
    // (a) red when the cap lets the second connection linger too (it then closes no sooner than
    //     the first), or the first does not linger, or neither is closed; (b) prints both close
    //     times after their status lines.
    expect({
      firstLingered: typeof firstAfter === 'number' && firstAfter >= LINGER - 200,
      secondAtOnce: typeof secondAfter === 'number' && secondAfter < LINGER / 2,
      firstAfter,
      secondAfter,
    }).toEqual({
      firstLingered: true,
      secondAtOnce: true,
      firstAfter: expect.any(Number),
      secondAfter: expect.any(Number),
    });
  }, 15_000);

  it('C12 — a flooding sender gets 413, then the half-close at once, and the server reads for the linger before it closes', async () => {
    const { port, closedAt } = await serve();
    const s = rawSender(port, headOf('POST', '/wf', 5_000_000), Buffer.alloc(16 * 1024, 97), 10);
    const after = await closedAfter(closedAt, s.state, LINGER + 1_500);
    const halfClose =
      s.state.endAt !== undefined && s.state.statusAt !== undefined
        ? s.state.endAt - s.state.statusAt
        : 'no FIN';
    // (a) red when the 413 is not sent, the server does not half-close at once (its FIN), does
    //     not keep reading for the linger, or holds the socket past `lingerMs` + 1500 ms;
    //     (b) prints the status, the FIN's delay and the close time after the status line.
    expect({
      status: parse(s.state.raw).status,
      halfCloseAtOnce: typeof halfClose === 'number' && halfClose <= 200,
      lingered: typeof after === 'number' && after >= LINGER - 200 && after <= LINGER + 1_500,
      halfClose,
      after,
    }).toEqual({
      status: 413,
      halfCloseAtOnce: true,
      lingered: true,
      halfClose: expect.any(Number),
      after: expect.any(Number),
    });
  }, 15_000);

  it('C13 — a request pipelined after a refusal is never handed to a run; alone, it is', async () => {
    const deps = makeDeps();
    const { port, closedAt } = await serve({}, deps);
    const valid =
      `POST /wf HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n` +
      `Authorization: ${SECRET}\r\nContent-Length: 2\r\n\r\n{}`;
    const s = rawSender(port, headOf('POST', '/nope', 2) + '{}' + valid);
    await waitFor(() => s.state.statusAt !== undefined, 3_000);
    await sleep(LINGER + 300);
    // The sender pipelines at once, so the guarded request follows the 403's status line directly:
    // the guard closes the socket at once rather than leaving it to the linger.
    const closedMs = closedAt.has(s.state.localPort!)
      ? closedAt.get(s.state.localPort!)! - s.state.statusAt!
      : 'still open';
    const pipelined = {
      status: parse(s.state.raw).status,
      spawns: deps.spawnAgent.mock.calls.length,
      closedAtOnce: typeof closedMs === 'number' && closedMs <= 200,
    };
    // The positive control: the same request alone, on a new socket.
    const alone = rawSender(port, valid);
    await waitFor(() => alone.state.statusAt !== undefined, 3_000);
    await sleep(100);
    // (a) red when the pipelined request reaches the pipeline (a run is created and an agent is
    //     spawned), when the guard leaves the socket open instead of closing it within 200 ms of
    //     the 403, or when the control is refused; (b) prints the first reply's status, the spawn
    //     count after it, whether the socket closed at once and when, and the control's status and
    //     spawn count.
    expect({
      pipelined,
      closedMs,
      alone: { status: parse(alone.state.raw).status, spawns: deps.spawnAgent.mock.calls.length },
    }).toEqual({
      pipelined: { status: 403, spawns: 0, closedAtOnce: true },
      closedMs: expect.anything(),
      alone: { status: 202, spawns: 1 },
    });
  }, 15_000);

  it('C13b — at the cap, a request pipelined after a refusal is not handled either', async () => {
    const deps = makeDeps();
    const { port, closedAt } = await serve({ maxConcurrent: 1 }, deps);
    // The one linger slot is held by a sender to an unknown address that keeps uploading.
    const first = rawSender(port, headOf('POST', '/nope', 1_000_000), Buffer.alloc(1024, 97), 50);
    await waitFor(() => first.state.statusAt !== undefined, 3_000);
    const valid =
      `POST /wf HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n` +
      `Authorization: ${SECRET}\r\nContent-Length: 2\r\n\r\n{}`;
    const second = rawSender(port, headOf('POST', '/nope', 2) + '{}' + valid);
    await waitFor(() => second.state.statusAt !== undefined, 3_000);
    // The cap held when the second refusal was sent: the first socket was still open.
    const firstOpenAt403 =
      first.state.localPort !== undefined &&
      second.state.statusAt !== undefined &&
      (closedAt.get(first.state.localPort) ?? Infinity) > second.state.statusAt;
    await sleep(LINGER + 300);
    // (a) red when a refused socket that gets no linger slot is not guarded (the pipelined request
    //     starts a run), or the cap was not full when the second refusal was sent; (b) prints the
    //     second reply's status, whether the first socket was still open then, and the spawn count.
    expect({
      status: parse(second.state.raw).status,
      firstOpenAt403,
      spawns: deps.spawnAgent.mock.calls.length,
    }).toEqual({ status: 403, firstOpenAt403: true, spawns: 0 });
  }, 15_000);

  /** A spawn that answers `LINGER` + 300 ms later, so an accepted request's 202 comes late. */
  const slowSpawnDeps = (over: Partial<ListenDeps> = {}) =>
    makeDeps({
      spawnAgent: vi.fn(async (): Promise<SpawnResult> => {
        await sleep(LINGER + 300);
        return { pid: 4242 };
      }),
      ...over,
    });
  /** A request the route accepts (202). */
  const VALID_ONE =
    `POST /wf HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n` +
    `Authorization: ${SECRET}\r\nContent-Length: 2\r\n\r\n{}`;
  const VALID_THEN_GET = VALID_ONE + `GET /wf HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`;
  /** A tiny request. It carries `Host`: without it, Node answers a 400 itself and never hands it over. */
  const TINY = `GET /x HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`;
  /**
   * A spawn that waits for the test to open its gate, so the order of events is fixed whatever the
   * machine's speed. The gate also opens when the test finishes, so no test hangs.
   */
  const gatedSpawnDeps = (over: Partial<ListenDeps> = {}) => {
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    onTestFinished(() => open());
    const deps = makeDeps({
      spawnAgent: vi.fn(async (): Promise<SpawnResult> => {
        await gate;
        return { pid: 4242 };
      }),
      ...over,
    });
    return { deps, open: () => open() };
  };
  /** Every status line the sender received, in order. */
  const statuses = (raw: string): number[] =>
    [...raw.matchAll(/HTTP\/1\.1 (\d{3})/g)].map((m) => Number(m[1]));
  /** A logger that keeps the data of every `webhook: refused` line, in order. */
  const refusedLines = () => {
    const lines: unknown[] = [];
    const logger: Logger = {
      ...silentLogger,
      warn: (msg: string, data?: unknown) => {
        if (msg === 'webhook: refused') lines.push(data);
      },
    };
    return { lines, logger };
  };

  it('C15 — a refusal queued behind a slow accepted request: both replies arrive, then the socket closes', async () => {
    const { port, closedAt } = await serve({}, slowSpawnDeps());
    const s = rawSender(port, VALID_THEN_GET);
    const after = await closedAfter(closedAt, s.state, LINGER + 1_500);
    await waitFor(() => statuses(s.state.raw).length >= 2, 1_000);
    // The server keeps the socket at least `lingerMs` − 200 ms after the 405: the queued refusal
    // took the free linger slot when it was written.
    const at405 = s.state.statusTimes[1];
    const closed = closedAt.get(s.state.localPort!);
    const after405 = at405 === undefined || closed === undefined ? 'unknown' : closed - at405;
    // (a) red when the linger timer starts before the queued refusal is written (the socket is
    //     destroyed with the 202 still unwritten), when the queued refusal never closes the socket,
    //     or when it closes the way Node does instead of lingering; (b) prints the statuses received,
    //     the close time after the first status line, and the close time after the 405.
    expect({
      statuses: statuses(s.state.raw),
      closedInTime: typeof after === 'number' && after <= LINGER + 1_500,
      lingeredAfter405: typeof after405 === 'number' && after405 >= LINGER - 200,
      after,
      after405,
    }).toEqual({
      statuses: [202, 405],
      closedInTime: true,
      lingeredAfter405: true,
      after: expect.any(Number),
      after405: expect.any(Number),
    });
  }, 15_000);

  it('C15b — a queued refusal holds no linger slot while it waits', async () => {
    const { port, closedAt } = await serve({ maxConcurrent: 1 }, slowSpawnDeps());
    const pair = rawSender(port, VALID_THEN_GET);
    await waitFor(() => pair.state.localPort !== undefined, 2_000);
    await sleep(100);
    // While the 202 is still pending, a sender to an unknown address that keeps uploading.
    const s = rawSender(port, headOf('POST', '/nope', 1_000_000), Buffer.alloc(1024, 97), 50);
    const after = await closedAfter(closedAt, s.state, LINGER + 1_500);
    // The pair's 202 was still pending when this sender's 403 arrived: its refusal was queued.
    const pairPendingAt403 =
      s.state.statusAt !== undefined &&
      (pair.state.statusAt === undefined || pair.state.statusAt > s.state.statusAt);
    // (a) red when the queued refusal takes the one slot before it is written (this sender is then
    //     closed at once), or the 202 was no longer pending; (b) prints the status, whether the 202
    //     was pending, whether the socket lingered, and the close time after the status line.
    expect({
      status: parse(s.state.raw).status,
      pairPendingAt403,
      lingered: typeof after === 'number' && after >= LINGER - 200,
      after,
    }).toEqual({ status: 403, pairPendingAt403: true, lingered: true, after: expect.any(Number) });
  }, 15_000);

  it('C14 — a request pipelined after a queued refusal: the earlier replies still arrive, in order', async () => {
    const { port, closedAt, deps } = await serve({}, slowSpawnDeps());
    const s = rawSender(port, VALID_THEN_GET + VALID_ONE);
    await waitFor(() => s.state.statusTimes.length >= 2, 3_000);
    await waitFor(() => closedAt.has(s.state.localPort!), LINGER + 1_500);
    const at405 = s.state.statusTimes[1];
    const closed = closedAt.get(s.state.localPort!);
    const after405 = at405 === undefined || closed === undefined ? 'unknown' : closed - at405;
    // (a) red when the request after the refusal destroys the socket while the 202 and the 405 are
    //     still unwritten (no reply arrives), when it is handled (a second spawn), or when the socket
    //     is not closed within the linger after the 405; (b) prints the statuses, the spawn count and
    //     the close time after the 405.
    expect({
      statuses: statuses(s.state.raw),
      spawns: deps.spawnAgent.mock.calls.length,
      closedInTime: typeof after405 === 'number' && after405 <= LINGER + 1_500,
      after405,
    }).toEqual({
      statuses: [202, 405],
      spawns: 1,
      closedInTime: true,
      after405: expect.any(Number),
    });
  }, 15_000);

  it('C14b — up to 32 requests after a queued refusal are ignored, and the earlier replies arrive', async () => {
    const { port } = await serve({}, slowSpawnDeps());
    const s = rawSender(port, VALID_THEN_GET + TINY.repeat(32));
    await waitFor(() => s.state.statusTimes.length >= 2, 3_000);
    await sleep(200);
    // (a) red when a request after the refusal destroys the socket before the 32nd (a cap under 32,
    //     or no ignoring at all), or one of them is answered; (b) prints the statuses.
    expect({ statuses: statuses(s.state.raw) }).toEqual({ statuses: [202, 405] });
  }, 15_000);

  it('C16 — past 32 requests after a queued refusal, the socket is closed at once', async () => {
    const { port, closedAt } = await serve({}, slowSpawnDeps());
    const started = performance.now();
    const s = rawSender(port, VALID_THEN_GET + TINY.repeat(40));
    await waitFor(() => s.state.localPort !== undefined, 2_000);
    await waitFor(() => closedAt.has(s.state.localPort!), 1_500);
    const closed = closedAt.get(s.state.localPort!);
    const afterStart = closed === undefined ? 'still open' : closed - started;
    // Long enough for the 202 (`LINGER` + 300 ms) to have been written, had the socket survived.
    await sleep(LINGER + 600);
    // (a) red when the ignoring has no cap (the socket stays open until the replies are written and
    //     the linger ends, 1300 ms or later); (b) prints the close time after the sender started
    //     and the statuses (none: a reply not yet sent is lost past the cap, as the docs say). The
    //     bound is 800 ms: sender and server share one event loop, and timers here run up to about
    //     1 s late.
    expect({
      closedAtOnce: typeof afterStart === 'number' && afterStart <= 800,
      afterStart,
      statuses: statuses(s.state.raw),
    }).toEqual({ closedAtOnce: true, afterStart: expect.any(Number), statuses: [] });
  }, 15_000);

  it('C16b — the 33rd request after a queued refusal closes the socket at once: the cap is exactly 32', async () => {
    const { port, closedAt } = await serve({}, slowSpawnDeps());
    const started = performance.now();
    const s = rawSender(port, VALID_THEN_GET + TINY.repeat(33));
    await waitFor(() => s.state.localPort !== undefined, 2_000);
    await waitFor(() => closedAt.has(s.state.localPort!), 1_500);
    const closed = closedAt.get(s.state.localPort!);
    const afterStart = closed === undefined ? 'still open' : closed - started;
    // Long enough for the 202 (`LINGER` + 300 ms) to have been written, had the socket survived.
    await sleep(LINGER + 600);
    // With C14b's 32 (the replies arrive), this pins the boundary. (a) red when the cap is over 32
    // (the 33rd request is ignored, and the socket stays open until the replies are written and the
    // linger ends); (b) prints the close time after the sender started and the statuses.
    expect({
      closedAtOnce: typeof afterStart === 'number' && afterStart <= 800,
      afterStart,
      statuses: statuses(s.state.raw),
    }).toEqual({ closedAtOnce: true, afterStart: expect.any(Number), statuses: [] });
  }, 15_000);

  it('C15c — a queued refusal written while the one linger slot is taken closes the way Node does', async () => {
    const { deps, open } = gatedSpawnDeps();
    const { port, closedAt } = await serve({ maxConcurrent: 1 }, deps);
    const pair = rawSender(port, VALID_THEN_GET);
    await waitFor(() => deps.spawnAgent.mock.calls.length >= 1, 3_000);
    const uploader = rawSender(
      port,
      headOf('POST', '/nope', 1_000_000),
      Buffer.alloc(1024, 97),
      50,
    );
    await waitFor(() => uploader.state.statusAt !== undefined, 3_000);
    open();
    await waitFor(() => pair.state.statusTimes.length >= 2, 3_000);
    await waitFor(() => closedAt.has(pair.state.localPort!), LINGER + 1_500);
    const at405 = pair.state.statusTimes[1];
    const uploaderClosed = closedAt.get(uploader.state.localPort!);
    const uploaderOpenAt405 =
      at405 !== undefined && (uploaderClosed === undefined || uploaderClosed > at405);
    const last = pair.state.statusTimes[pair.state.statusTimes.length - 1];
    const pairClosed = closedAt.get(pair.state.localPort!);
    const pairAfter =
      last === undefined || pairClosed === undefined ? 'unknown' : pairClosed - last;
    // (a) red when the queued refusal lingers although the one slot is taken (its socket then closes
    //     only at the end of the linger), or the uploader no longer held the slot when the 405 was
    //     written; (b) prints the statuses, whether the uploader was open then, and the pair's close
    //     time after its last status line.
    expect({
      statuses: statuses(pair.state.raw),
      uploaderOpenAt405,
      closedLikeNode: typeof pairAfter === 'number' && pairAfter < LINGER / 2,
      pairAfter,
    }).toEqual({
      statuses: [202, 405],
      uploaderOpenAt405: true,
      closedLikeNode: true,
      pairAfter: expect.any(Number),
    });
  }, 15_000);

  it('C15d — a queued refusal takes the free linger slot when it is written, and gives it back', async () => {
    const { deps, open } = gatedSpawnDeps();
    const { port, closedAt } = await serve({ maxConcurrent: 1 }, deps);
    const pair = rawSender(port, VALID_THEN_GET);
    await waitFor(() => deps.spawnAgent.mock.calls.length >= 1, 3_000);
    open();
    await waitFor(() => pair.state.statusTimes.length >= 2, 3_000);
    await waitFor(() => closedAt.has(pair.state.localPort!), LINGER + 1_500);
    const at405 = pair.state.statusTimes[1];
    const pairClosed = closedAt.get(pair.state.localPort!);
    const pairAfter405 =
      at405 === undefined || pairClosed === undefined ? 'unknown' : pairClosed - at405;
    const uploader = rawSender(
      port,
      headOf('POST', '/nope', 1_000_000),
      Buffer.alloc(1024, 97),
      50,
    );
    const uploaderAfter = await closedAfter(closedAt, uploader.state, LINGER + 1_500);
    // (a) red when the queued refusal closes the way Node does although the slot is free (i), or its
    //     socket's close does not give the slot back (ii: the fresh uploader is then closed at
    //     once); (b) prints both close times.
    expect({
      pairLingered: typeof pairAfter405 === 'number' && pairAfter405 >= LINGER - 200,
      uploaderLingered: typeof uploaderAfter === 'number' && uploaderAfter >= LINGER - 200,
      pairAfter405,
      uploaderAfter,
    }).toEqual({
      pairLingered: true,
      uploaderLingered: true,
      pairAfter405: expect.any(Number),
      uploaderAfter: expect.any(Number),
    });
  }, 15_000);

  // ── Part B: the limits at listen's edge ─────────────────────────────────────────────────────

  it('C2e — a body declared over the limit is refused unread, and no 100 Continue is sent', async () => {
    const { port } = await serve();
    const s = rawSender(port, headOf('POST', '/wf', 5000, 'Expect: 100-continue\r\n'));
    await waitFor(() => s.state.statusAt !== undefined, 1_000);
    await sleep(100);
    // (a) red when the declared size is not checked before reading (Node or the handler invites the
    //     body, or the refusal comes only once the body is read or times out), when Node sends
    //     `100 Continue` on its own, or the 413 does not name its limit; (b) prints how the reply
    //     starts, whether a 100 was sent, and the body.
    expect({
      startsWith413: s.state.raw.startsWith('HTTP/1.1 413'),
      sent100: s.state.raw.includes('100 Continue'),
      body: parse(s.state.raw).body,
    }).toEqual({
      startsWith413: true,
      sent100: false,
      body: { error: 'payload_too_large', max_body_bytes: 100 },
    });
  }, 15_000);

  it('C3 — a request that passes the checks is still invited with 100 Continue, and accepted', async () => {
    const deps = makeDeps();
    const { port } = await serve({}, deps);
    const sock = netConnect({ host: '127.0.0.1', port, allowHalfOpen: true });
    onTestFinished(() => {
      sock.destroy();
    });
    let raw = '';
    sock.on('data', (d: Buffer) => {
      raw += d.toString('latin1');
    });
    sock.on('error', () => {});
    sock.on('connect', () => {
      sock.write(headOf('POST', '/wf', 2, `Expect: 100-continue\r\nAuthorization: ${SECRET}\r\n`));
    });
    const invited = await waitFor(() => raw.includes('HTTP/1.1 100 Continue'), 1_000);
    sock.write('{}');
    await waitFor(() => statuses(raw).length >= 2, 3_000);
    const all = statuses(raw);
    // (a) red when the 100 is never sent to a request that passes the checks (the body is then
    //     never invited), or the request is not accepted; (b) prints whether the 100 arrived, the
    //     final status and the spawn count.
    expect({
      invited,
      finalStatus: all[all.length - 1],
      spawns: deps.spawnAgent.mock.calls.length,
    }).toEqual({ invited: true, finalStatus: 202, spawns: 1 });
  }, 15_000);

  it('C3b — an HTTP/1.0 sender is never invited with 100 Continue (RFC 9110 §15.2), and is accepted', async () => {
    const { port } = await serve();
    const s = rawSender(
      port,
      `POST /wf HTTP/1.0\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n` +
        `Authorization: ${SECRET}\r\nExpect: 100-continue\r\nContent-Length: 2\r\n\r\n{}`,
    );
    await waitFor(() => statuses(s.state.raw).includes(202), 3_000);
    await sleep(100);
    // (a) red when the handler invites by the `Expect` header alone (a `100` goes to an HTTP/1.0
    //     sender, which may not get one), or the request is not accepted; (b) prints whether a 100
    //     was sent, and the statuses.
    expect({
      sent100: s.state.raw.includes('100 Continue'),
      statuses: statuses(s.state.raw),
    }).toEqual({ sent100: false, statuses: [202] });
  }, 15_000);

  it('C3c — an Expect that lists 100-continue among others is invited, and accepted', async () => {
    const deps = makeDeps();
    const { port } = await serve({}, deps);
    const sock = netConnect({ host: '127.0.0.1', port, allowHalfOpen: true });
    onTestFinished(() => {
      sock.destroy();
    });
    let raw = '';
    sock.on('data', (d: Buffer) => {
      raw += d.toString('latin1');
    });
    sock.on('error', () => {});
    sock.on('connect', () => {
      sock.write(
        headOf('POST', '/wf', 2, `Expect: 100-continue, foo\r\nAuthorization: ${SECRET}\r\n`),
      );
    });
    const invited = await waitFor(() => raw.includes('HTTP/1.1 100 Continue'), 1_000);
    sock.write('{}');
    await waitFor(() => statuses(raw).length >= 2, 3_000);
    const all = statuses(raw);
    // (a) red when the handler invites only an `Expect` exactly equal to `100-continue` (this one
    //     is then never invited, and its body times out); (b) prints whether the 100 arrived, and
    //     the final status.
    expect({ invited, finalStatus: all[all.length - 1] }).toEqual({
      invited: true,
      finalStatus: 202,
    });
  }, 15_000);

  it('C11 — headers that never end are closed within the body timeout, with a 408', async () => {
    const { port, closedAt } = await serve();
    const started = performance.now();
    // It keeps sending, so the connection is never idle: only the header timeout can close it.
    const s = rawSender(port, 'POST /wf HTTP/1.1\r\nHost: 127.0.0.1\r\n', 'X', 300);
    await waitFor(() => s.state.localPort !== undefined, 2_000);
    await waitFor(() => closedAt.has(s.state.localPort!), 400 + 1_000 + 1_500);
    const closed = closedAt.get(s.state.localPort!);
    const afterStart = closed === undefined ? 'still open' : closed - started;
    // The reply is read by the sender a moment after the server's side has closed.
    await waitFor(() => s.state.statusAt !== undefined, 500);
    // (a) red when the server applies no header timeout (Node's default holds slow headers for
    //     about 90 s), or the 408 is Node's own bare one (no body) instead of listen's JSON naming
    //     both limits; (b) prints the close time after the sender started, how the reply starts,
    //     and its body.
    expect({
      closedInTime: typeof afterStart === 'number' && afterStart <= 400 + 1_000 + 1_500,
      afterStart,
      replyIs408: s.state.raw.startsWith('HTTP/1.1 408'),
      body: parse(s.state.raw).body,
    }).toEqual({
      closedInTime: true,
      afterStart: expect.any(Number),
      replyIs408: true,
      body: { error: 'request_timeout', headers_timeout_ms: 400, request_timeout_ms: 300_000 },
    });
  }, 15_000);

  it("C17 — the request timeout never cuts a 408's linger", async () => {
    const { port, closedAt } = await serve({ lingerMs: 1_500 });
    const s = rawSender(port, headOf('POST', '/wf', 10), 'a', 300);
    const after = await closedAfter(closedAt, s.state, 1_500 + 1_500);
    // (a) red when the whole-request timeout fires before listen's body timer and the linger have
    //     run (a `requestTimeout` equal to the body timeout closes the socket about 1 s in); (b)
    //     prints the status and the close time after the 408.
    expect({
      status: parse(s.state.raw).status,
      lingered: typeof after === 'number' && after >= 1_300 && after <= 1_500 + 1_500,
      after,
    }).toEqual({ status: 408, lingered: true, after: expect.any(Number) });
  }, 15_000);

  it('C17b — a refusal queued behind a slow delivery keeps its linger past the old whole-request limit', async () => {
    const { deps, open } = gatedSpawnDeps();
    const { port, closedAt } = await serve({}, deps);
    const started = performance.now();
    // An accepted request, then one to an unknown address whose body is still uploading.
    const s = rawSender(
      port,
      VALID_ONE + headOf('POST', '/nope', 1_000_000),
      Buffer.alloc(1024, 97),
      50,
    );
    await waitFor(() => deps.spawnAgent.mock.calls.length >= 1, 3_000);
    // The gate opens 3500 ms after the sender started: past the old limit (400 × 2 + 500 + 1000 =
    // 2300 ms, counted from the refused request's first byte) plus Node's 1 s check.
    await sleep(Math.max(0, started + 3_500 - performance.now()));
    open();
    await waitFor(() => s.state.statusTimes.length >= 2, 3_000);
    await waitFor(() => closedAt.has(s.state.localPort!), LINGER + 1_500);
    const at403 = s.state.statusTimes[1];
    const closed = closedAt.get(s.state.localPort!);
    const after403 = at403 === undefined || closed === undefined ? 'unknown' : closed - at403;
    // (a) red when the whole-request timeout fires while the refusal waits behind the slow reply
    //     (Node then answers its own 408 and closes, and neither reply is sent); (b) prints the
    //     statuses and the close time after the 403.
    expect({
      statuses: statuses(s.state.raw),
      lingered:
        typeof after403 === 'number' && after403 >= LINGER - 200 && after403 <= LINGER + 1_500,
      after403,
    }).toEqual({ statuses: [202, 403], lingered: true, after403: expect.any(Number) });
  }, 15_000);

  it('C17c — a body timeout over 5 minutes still starts, and the request timeout exceeds it', async () => {
    const started = await serve({ bodyTimeoutMs: 400_000 }).then(
      ({ handle }) => ({ requestTimeout: handle.server.requestTimeout }),
      (e: NodeJS.ErrnoException) => ({ error: e.code ?? e.message }),
    );
    // (a) red when the request timeout is a flat 5 minutes (`createServer` then refuses a header
    //     timeout longer than it, and listen does not start); (b) prints the request timeout, or
    //     the start error's code.
    // 2 × 400 000 + `LINGER` (500) + 1000.
    expect(started).toEqual({ requestTimeout: 801_500 });
  }, 15_000);

  it('C18 — a delivery handled for longer than the old idle limit still gets its reply', async () => {
    const { deps, open } = gatedSpawnDeps();
    const { port, closedAt } = await serve({}, deps);
    const s = rawSender(port, VALID_ONE);
    await waitFor(() => deps.spawnAgent.mock.calls.length >= 1, 3_000);
    // Longer than the old idle limit (400 × 2 + 500 + 1000 = 2300 ms), with nothing sent or
    // received.
    await sleep(3_000);
    open();
    await waitFor(() => s.state.statusAt !== undefined, 2_000);
    const closed = closedAt.get(s.state.localPort!);
    // (a) red when an idle timeout closes the connection while its delivery is handled (the run
    //     starts, and the sender gets no reply); (b) prints the statuses and whether the server
    //     closed the socket before the reply.
    expect({
      statuses: statuses(s.state.raw),
      closedBeforeReply:
        closed !== undefined && (s.state.statusAt === undefined || closed < s.state.statusAt),
    }).toEqual({ statuses: [202], closedBeforeReply: false });
  }, 15_000);

  it('C19 — an HTTP/1.0 sender that keeps its connection gets both replies', async () => {
    const { port } = await serve({}, slowSpawnDeps());
    const s = rawSender(
      port,
      `POST /wf HTTP/1.0\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n` +
        `Content-Type: application/json\r\nAuthorization: ${SECRET}\r\nContent-Length: 2\r\n\r\n{}` +
        `GET /wf HTTP/1.0\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n`,
    );
    await waitFor(() => statuses(s.state.raw).length >= 2, 3_000);
    await sleep(200);
    // (a) red when a reply carries no length (Node then ends the connection after it, and the
    //     queued refusal is never sent); (b) prints the statuses.
    expect({ statuses: statuses(s.state.raw) }).toEqual({ statuses: [202, 405] });
  }, 15_000);

  it.each([
    ['HTTP/1.0 without keep-alive', 'HTTP/1.0', ''],
    ['HTTP/1.1 with Connection: close', 'HTTP/1.1', 'Connection: close\r\n'],
  ] as const)(
    'C19b — %s: a second request on the connection is not answered, and the first reply is still sent',
    async (_row, version, extra) => {
      const { lines, logger } = refusedLines();
      const deps = slowSpawnDeps({ logger });
      const { port, closedAt } = await serve({}, deps);
      const s = rawSender(
        port,
        `POST /wf ${version}\r\nHost: 127.0.0.1\r\n${extra}Content-Type: application/json\r\n` +
          `Authorization: ${SECRET}\r\nContent-Length: 2\r\n\r\n{}` +
          `GET /wf ${version}\r\nHost: 127.0.0.1\r\n\r\n`,
      );
      await waitFor(() => s.state.statusAt !== undefined, 3_000);
      await waitFor(() => closedAt.has(s.state.localPort!), LINGER + 1_500);
      await sleep(200);
      // (a) red when Node's own bare 400 answers the second request (the 202 is then lost, though
      //     its run starts), when the second request is handled, when the connection is not closed
      //     after the 202, or when the unanswered request logs no line; (b) prints the statuses,
      //     the spawn count, whether the server closed the socket, and the refusal lines' data.
      expect({
        statuses: statuses(s.state.raw),
        spawns: deps.spawnAgent.mock.calls.length,
        closed: closedAt.has(s.state.localPort!),
        lines,
      }).toEqual({
        statuses: [202],
        spawns: 1,
        closed: true,
        lines: [{ status: 400, error: 'bad_request', code: 'HPE_CLOSED_CONNECTION', sent: false }],
      });
    },
    15_000,
  );

  it.each([
    ['405', { method: 'GET' }, {}, { path: '/wf', status: 405, error: 'method_not_allowed' }],
    ['403', { url: '/nope?token=s3cret' }, {}, { path: '/nope', status: 403, error: 'forbidden' }],
    [
      '403, an address starting //',
      { url: '//?token=s3cret' },
      {},
      { path: '//', status: 403, error: 'forbidden' },
    ],
    ['503', {}, { maxConcurrent: 0 }, { path: '/wf', status: 503, error: 'busy' }],
    [
      '413, declared',
      { headers: { 'content-length': '5000' } },
      { maxBodyBytes: 4 },
      { path: '/wf', status: 413, error: 'payload_too_large', max_body_bytes: 4 },
    ],
    [
      '413, read',
      { body: 'way too long' },
      { maxBodyBytes: 4 },
      { path: '/wf', status: 413, error: 'payload_too_large', max_body_bytes: 4 },
    ],
    [
      '408',
      { body: '{}', noEnd: true },
      { bodyTimeoutMs: 20 },
      { path: '/wf', status: 408, error: 'request_timeout', body_timeout_ms: 20 },
    ],
    ['400', { noEnd: true }, {}, { path: '/wf', status: 400, error: 'bad_request' }],
  ] as const)(
    'C20 — the %s refusal logs one webhook: refused line',
    async (row, reqOpts, options, data) => {
      const warns: unknown[][] = [];
      const logger: Logger = { ...silentLogger, warn: (...args: unknown[]) => warns.push(args) };
      const handler = makeListenHandler(
        routesFor(wf(SHARED_SECRET_TRIGGER)),
        makeDeps({ logger }),
        options,
      );
      const req = makeReq({ method: 'POST', ...reqOpts });
      const done = handler(req, makeRes());
      if (row === '400') {
        await sleep(5);
        req.emit('error', new Error('broken body'));
      }
      await done;
      // (a) red when a refusal logs no line, logs twice, or logs the query string (the 403 row:
      //     `path` is the pathname only), or a limit field is missing; (b) prints the refusal lines
      //     logged and whether the query's token appears in any of them.
      expect({
        lines: warns.filter((w) => w[0] === 'webhook: refused'),
        queryLogged: JSON.stringify(warns).includes('s3cret'),
      }).toEqual({ lines: [['webhook: refused', data]], queryLogged: false });
    },
  );

  // ── Requests Node cannot read: listen's reply and line, not Node's bare one ─────────────────

  it.each([
    [
      '431',
      `POST /wf HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Big: ${'a'.repeat(20_000)}\r\n\r\n`,
      false,
      431,
      { error: 'header_fields_too_large', max_header_bytes: 16_384 },
      {
        status: 431,
        error: 'header_fields_too_large',
        code: 'HPE_HEADER_OVERFLOW',
        max_header_bytes: 16_384,
      },
    ],
    [
      '413',
      `POST /wf HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n` +
        `Authorization: ${SECRET}\r\nTransfer-Encoding: chunked\r\n\r\n` +
        `5;${'a'.repeat(20_000)}\r\nhello\r\n0\r\n\r\n`,
      false,
      413,
      { error: 'chunk_extensions_too_large' },
      { status: 413, error: 'chunk_extensions_too_large', code: 'HPE_CHUNK_EXTENSIONS_OVERFLOW' },
    ],
    [
      '400',
      'BAD\x01 / HTTP/1.1\r\n\r\n',
      false,
      400,
      { error: 'bad_request' },
      { status: 400, error: 'bad_request', code: 'HPE_INVALID_METHOD' },
    ],
    [
      '400 at end of input',
      'POST /w',
      true,
      400,
      { error: 'bad_request' },
      { status: 400, error: 'bad_request', code: 'HPE_INVALID_EOF_STATE' },
    ],
  ] as const)(
    "C22 — %s: a request that is not valid HTTP gets listen's JSON reply and one line",
    async (_row, head, endAfterHead, status, body, data) => {
      const { lines, logger } = refusedLines();
      const { port, closedAt } = await serve({}, makeDeps({ logger }));
      const s = rawSender(port, head);
      // The sender ends its side (a FIN) right after the half request line.
      if (endAfterHead) s.sock.once('connect', () => s.sock.end());
      await waitFor(() => s.state.localPort !== undefined, 2_000);
      await waitFor(() => closedAt.has(s.state.localPort!), 3_000);
      await waitFor(() => s.state.statusAt !== undefined, 500);
      // Counted 200 ms after the close: a second line (the request's own refusal) would come then.
      await sleep(200);
      const reply = parse(s.state.raw);
      const replyHead = s.state.raw.split('\r\n\r\n')[0] ?? '';
      // (a) red when Node sends its own bare reply (no JSON, no length, no line), when the reply
      //     is written into a reply already on the wire, when nothing is logged, or when the
      //     request being handled adds a second reply and line (the 413 row); (b) prints the
      //     status, the body, whether the head carries `Content-Length`, the `Connection` header,
      //     whether the server closed the socket, and the refusal lines' data.
      expect({
        status: reply.status,
        body: reply.body,
        contentLength: /\r\ncontent-length: *\d+/i.test(replyHead),
        connection: reply.connection,
        closed: closedAt.has(s.state.localPort!),
        lines,
      }).toEqual({
        status,
        body,
        contentLength: true,
        connection: 'close',
        closed: true,
        lines: [data],
      });
    },
    15_000,
  );

  it('C22b — a socket error is not a refusal: a reset logs no line', async () => {
    const { lines, logger } = refusedLines();
    const { port, closedAt } = await serve({}, makeDeps({ logger }));
    const s = rawSender(port, 'POST /w');
    await waitFor(() => s.state.localPort !== undefined, 2_000);
    await sleep(100);
    s.sock.resetAndDestroy();
    await waitFor(() => closedAt.has(s.state.localPort!), 500);
    await sleep(500);
    // (a) red when a socket error (here `ECONNRESET`) is taken for a refusal (a line is logged);
    //     (b) prints whether the server's socket closed, and the refusal lines' data.
    expect({ closed: closedAt.has(s.state.localPort!), lines }).toEqual({
      closed: true,
      lines: [],
    });
  }, 15_000);

  it('C22c — garbage after a refused request: no second reply, no second line, and the linger still bounds the close', async () => {
    const { lines, logger } = refusedLines();
    const { port, closedAt } = await serve({}, makeDeps({ logger }));
    const s = rawSender(port, headOf('POST', '/nope', 2) + '{}' + 'BAD\x01 / HTTP/1.1\r\n\r\n');
    const after = await closedAfter(closedAt, s.state, LINGER + 1_500);
    await sleep(200);
    // Nothing is logged for the garbage: a request sent after a refusal is not handled, and the
    // refusal's own line already covers the connection.
    // (a) red when the garbage gets a line of its own, a second reply, or a reply written into the
    //     closing connection, or when the connection is not closed within the refusal's linger;
    //     (b) prints the statuses, the refusal lines' data, and the close time after the 403.
    expect({
      statuses: statuses(s.state.raw),
      lines,
      closedInTime: typeof after === 'number' && after <= LINGER + 1_500,
      after,
    }).toEqual({
      statuses: [403],
      lines: [{ path: '/nope', status: 403, error: 'forbidden' }],
      closedInTime: true,
      after: expect.any(Number),
    });
  }, 15_000);

  it("C23 — an unknown Expect gets listen's 417, which lingers, and one line", async () => {
    const { lines, logger } = refusedLines();
    const { port, closedAt } = await serve({}, makeDeps({ logger }));
    const s = rawSender(
      port,
      `POST /wf HTTP/1.1\r\nHost: 127.0.0.1\r\nExpect: foo\r\nContent-Length: 1000000\r\n\r\n`,
      Buffer.alloc(1024, 97),
      50,
    );
    const after = await closedAfter(closedAt, s.state, LINGER + 1_500);
    // (a) red when Node sends its own bare 417 (no JSON, no `Connection: close`, no linger, no
    //     line); (b) prints the reply (status, connection, body), the close time after it, and the
    //     refusal lines' data.
    expect({
      ...parse(s.state.raw),
      lingered: typeof after === 'number' && after >= LINGER - 200,
      after,
      lines,
    }).toEqual({
      status: 417,
      connection: 'close',
      body: { error: 'expectation_failed' },
      lingered: true,
      after: expect.any(Number),
      lines: [{ path: '/wf', status: 417, error: 'expectation_failed' }],
    });
  }, 15_000);

  it("C24 — an HTTP/1.1 request without Host gets listen's 400 and one line", async () => {
    const { lines, logger } = refusedLines();
    const { port } = await serve({}, makeDeps({ logger }));
    const s = rawSender(
      port,
      `POST /wf HTTP/1.1\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}`,
    );
    await waitFor(() => s.state.statusAt !== undefined, 3_000);
    await sleep(100);
    // (a) red when Node answers its own bare 400 (no JSON, no line); (b) prints the reply (status,
    //     connection, body) and the refusal lines' data.
    expect({ ...parse(s.state.raw), lines }).toEqual({
      status: 400,
      connection: 'close',
      body: { error: 'host_required' },
      lines: [{ path: '/wf', status: 400, error: 'host_required' }],
    });
  }, 15_000);

  // ── A broken message on a connection that still carries a reply of listen's ──────────────────

  it.each([
    [
      '403',
      headOf('POST', '/nope', 1_000),
      403,
      { path: '/nope', status: 403, error: 'forbidden' },
    ],
    [
      '413',
      headOf('POST', '/wf', 5_000),
      413,
      { path: '/wf', status: 413, error: 'payload_too_large', max_body_bytes: 100 },
    ],
  ] as const)(
    'C25 — a %s whose sender gives up on its owed body (a FIN) logs one line, its own',
    async (_row, head, status, line) => {
      const { lines, logger } = refusedLines();
      const { port, closedAt } = await serve({}, makeDeps({ logger }));
      const s = rawSender(port, head);
      await waitFor(() => s.state.statusAt !== undefined, 3_000);
      // The sender ends its side without the body it still owes, as curl does after a 413.
      s.sock.end();
      await waitFor(() => closedAt.has(s.state.localPort!), LINGER + 1_500);
      // Counted 200 ms after the close.
      await sleep(200);
      // (a) red when the sender's end of input after the refusal logs a second refusal, one that
      //     never happened; (b) prints the status, whether the server closed the socket, and the
      //     refusal lines' data.
      expect({
        status: parse(s.state.raw).status,
        closed: closedAt.has(s.state.localPort!),
        lines,
      }).toEqual({ status, closed: true, lines: [line] });
    },
    15_000,
  );

  it('C26 — garbage after an accepted request: its 202 is still sent, and the connection then closes', async () => {
    const { lines, logger } = refusedLines();
    const { deps, open } = gatedSpawnDeps({ logger });
    const { port, closedAt } = await serve({}, deps);
    const s = rawSender(port, VALID_ONE + 'BAD\x01 / HTTP/1.1\r\n\r\n');
    await waitFor(() => deps.spawnAgent.mock.calls.length >= 1, 3_000);
    open();
    const after = await closedAfter(closedAt, s.state, LINGER + 1_500);
    await sleep(200);
    // (a) red when listen answers the garbage in place of the pending 202 (whose run has started),
    //     when the garbage logs no line, or when the connection is not closed after the 202;
    //     (b) prints the statuses, the refusal lines' data, and the close time after the 202.
    expect({
      statuses: statuses(s.state.raw),
      lines,
      closedInTime: typeof after === 'number' && after <= LINGER + 1_500,
      after,
    }).toEqual({
      statuses: [202],
      lines: [{ status: 400, error: 'bad_request', code: 'HPE_INVALID_METHOD', sent: false }],
      closedInTime: true,
      after: expect.any(Number),
    });
  }, 15_000);

  it('C26b — garbage after a refusal that is waiting its turn: the 202 and the 405 are still sent', async () => {
    const { lines, logger } = refusedLines();
    const { deps, open } = gatedSpawnDeps({ logger });
    const { port, closedAt } = await serve({}, deps);
    const s = rawSender(
      port,
      VALID_ONE + `GET /wf HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n` + 'BAD\x01 / HTTP/1.1\r\n\r\n',
    );
    await waitFor(() => deps.spawnAgent.mock.calls.length >= 1, 3_000);
    open();
    await waitFor(() => s.state.statusTimes.length >= 2, 3_000);
    await waitFor(() => closedAt.has(s.state.localPort!), LINGER + 1_500);
    await sleep(200);
    const at405 = s.state.statusTimes[1];
    const closed = closedAt.get(s.state.localPort!);
    const after405 = at405 === undefined || closed === undefined ? 'unknown' : closed - at405;
    // (a) red when listen answers the garbage in place of the pending 202 and the queued 405, when
    //     the garbage logs a line of its own after the refusal, or when the connection is not
    //     closed after the 405; (b) prints the statuses, the refusal lines' data, and the close
    //     time after the 405.
    expect({
      statuses: statuses(s.state.raw),
      lines,
      closedInTime: typeof after405 === 'number' && after405 <= LINGER + 1_500,
      after405,
    }).toEqual({
      statuses: [202, 405],
      lines: [{ path: '/wf', status: 405, error: 'method_not_allowed' }],
      closedInTime: true,
      after405: expect.any(Number),
    });
  }, 15_000);

  it('C26c — headers that never end behind a slow accepted request: the 202 is still sent, and the connection then closes', async () => {
    const { lines, logger } = refusedLines();
    const { deps, open } = gatedSpawnDeps({ logger });
    const { port, closedAt } = await serve({}, deps);
    const s = rawSender(port, VALID_ONE + 'POST /wf HTTP/1.1\r\nHost: 127.0.0.1\r\n', 'X', 300);
    await waitFor(() => deps.spawnAgent.mock.calls.length >= 1, 3_000);
    const timedOut = (): boolean =>
      lines.some(
        (l) =>
          (l as { code?: unknown }).code === 'ERR_HTTP_REQUEST_TIMEOUT' &&
          (l as { sent?: unknown }).sent === false,
      );
    await waitFor(timedOut, 2_500);
    open();
    const after = await closedAfter(closedAt, s.state, LINGER + 1_500);
    // (a) red when listen answers the header timeout in place of the pending 202, or when the
    //     connection stays open after the 202 (Node reports a header timeout once, and each
    //     trickled byte refreshes its keep-alive timer); (b) prints the statuses, the refusal
    //     lines' data, and the close time after the 202.
    expect({
      statuses: statuses(s.state.raw),
      lines,
      closedInTime: typeof after === 'number' && after <= LINGER + 1_500,
      after,
    }).toEqual({
      statuses: [202],
      lines: [
        {
          status: 408,
          error: 'request_timeout',
          headers_timeout_ms: 400,
          request_timeout_ms: 300_000,
          code: 'ERR_HTTP_REQUEST_TIMEOUT',
          sent: false,
        },
      ],
      closedInTime: true,
      after: expect.any(Number),
    });
  }, 15_000);

  it('C26d — a later request whose body breaks while a reply is pending: the 202, then its own 408, and one line', async () => {
    const { lines, logger } = refusedLines();
    const { deps, open } = gatedSpawnDeps({ logger });
    const { port, closedAt } = await serve({}, deps);
    const s = rawSender(
      port,
      VALID_ONE +
        `POST /wf HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n` +
        `Authorization: ${SECRET}\r\nTransfer-Encoding: chunked\r\n\r\n` +
        `5;${'a'.repeat(20_000)}\r\nhello\r\n0\r\n\r\n`,
    );
    await waitFor(() => deps.spawnAgent.mock.calls.length >= 1, 3_000);
    open();
    await waitFor(() => s.state.statusTimes.length >= 2, 3_000);
    await waitFor(() => closedAt.has(s.state.localPort!), LINGER + 1_500);
    await sleep(200);
    const at408 = s.state.statusTimes[1];
    const closed = closedAt.get(s.state.localPort!);
    const after408 = at408 === undefined || closed === undefined ? 'unknown' : closed - at408;
    // (a) red when listen answers the broken body in place of the pending 202, or when the broken
    //     body logs a line of its own besides its request's 408; (b) prints the statuses, the
    //     refusal lines' data, and the close time after the 408.
    expect({
      statuses: statuses(s.state.raw),
      lines,
      closedInTime: typeof after408 === 'number' && after408 <= LINGER + 1_500,
      after408,
    }).toEqual({
      statuses: [202, 408],
      lines: [{ path: '/wf', status: 408, error: 'request_timeout', body_timeout_ms: 400 }],
      closedInTime: true,
      after408: expect.any(Number),
    });
  }, 15_000);
});
