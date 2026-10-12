// Tests for `realm listen` — the full request pipeline (mock req/res, injected deps) + startup.
//
// issue #409: `node:child_process` is mocked FILE-WIDE, deliberately and safely. Vitest hoists
// every `vi.mock` to the top of the file whatever AST depth it is written at, so a
// describe-scoped one would silently be file-wide anyway — better to say so than to look scoped.
// issue #744: the mock follows the folder it is given, as Node does (`fakeChild` below): a start
// in an existing folder succeeds with pid 4242, one in a missing folder fails ENOENT with none. It
// never starts a process. The only real spawns in this file are A1 (through a guard that refuses
// any other `cwd`, so it can only fail in a missing folder) and the #744 contract cell (its
// arguments swapped to `-e 0`). Every other cell doubles the `spawnAgent` deps seam, which sits
// ABOVE the spawn.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { InvalidArgumentError } from 'commander';

const spawnMock = vi.hoisted(() => vi.fn((_cmd, args, opts) => fakeChild(opts.cwd, args)));
vi.mock('node:child_process', () => ({ spawn: spawnMock }));
import { EventEmitter } from 'node:events';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { createHmac } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { InMemoryStore } from '@sensigo/realm-testing';
import { CURRENT_WORKFLOW_SCHEMA_VERSION, abandonRun, JsonFileStore } from '@sensigo/realm';
import type { WorkflowDefinition, WebhookTrigger, WorkflowRegistrar } from '@sensigo/realm';
import { homedir, tmpdir } from 'node:os';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
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
  type ListenDeps,
  type Logger,
  type WorkflowEntry,
  type SpawnResult,
} from './listen.js';
import { InMemoryDedupStore } from '../lib/dedup-store.js';
import { purgeRuns } from './purge.js';
import type { loadProjectExtensions } from '../extensions/load-project-extensions.js';

/**
 * issue #744: a stand-in for Node's child process that follows the folder it is started in, as
 * Node does: a start in an existing folder has its pid at once and sends `'spawn'` on the next
 * tick, then each of `lateErrors` as `'error'`; a start in a missing folder has no pid and sends
 * Node's `'error'` (ENOENT) on the next tick, kept as `sentError`. Any other folder state (a file,
 * mode 000) is not modelled and throws. `impossible: 'spawn-without-pid'` is the one state Node
 * never produces (`'spawn'` with no pid), named so a reader sees it is deliberate (A5 alone).
 */
type FakeChild = EventEmitter & {
  pid: number | undefined;
  unref: ReturnType<typeof vi.fn>;
  sentError?: Error;
};
function fakeChild(
  cwd: string,
  args: readonly string[],
  opts: { lateErrors?: Error[]; impossible?: 'spawn-without-pid' } = {},
): FakeChild {
  const state = statSync(cwd, { throwIfNoEntry: false });
  if (state === undefined) {
    const sentError = Object.assign(new Error(`spawn ${process.execPath} ENOENT`), {
      code: 'ENOENT',
      errno: -2,
      syscall: `spawn ${process.execPath}`,
      path: process.execPath,
      spawnargs: [...args],
    });
    const child = Object.assign(new EventEmitter(), { pid: undefined, unref: vi.fn(), sentError });
    process.nextTick(() => child.emit('error', sentError));
    return child;
  }
  if (!state.isDirectory()) throw new Error('fakeChild: state not modelled: ' + cwd);
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

// issue #744: temp folders for the spawn cells, removed after each cell.
const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
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
// Node reports a missing `cwd` (ENOENT) or one it may not enter (EACCES) as an `'error'` event on
// the next tick, not as a throw. No cell here starts `node <vitest worker> agent …`: the fakes
// never start a process; A1's real spawn goes through a guard that refuses any `cwd` but its
// missing folder, so it can only fail; the contract cell's real spawns run `node -e 0`. The fakes
// are handed in by `fakeSpawn`, so each reads the `cwd` defaultSpawnAgent really passes. The
// handler cells (B1, B2, C1, C2) stub the `spawnAgent` deps seam, which sits above the spawn and
// does not depend on the folder; their folder only names the route's `cwd` in the log line.
// Beside each cell: (a) the change that turns it red; (b) what it prints when it fails.
describe('issue #744 — an agent start that fails later', () => {
  type SpawnFn = NonNullable<Parameters<typeof defaultSpawnAgent>[4]>;
  type Line = [string, unknown];
  /** A spawn function handing out fakes that read the `cwd` they are really given. */
  const fakeSpawn = (
    opts?: Parameters<typeof fakeChild>[2],
  ): { spawnFn: SpawnFn; child: () => FakeChild } => {
    let last: FakeChild | undefined;
    const spawnFn = ((_cmd: string, args: readonly string[], o: SpawnOptions) =>
      (last = fakeChild(String(o.cwd), args, opts))) as unknown as SpawnFn;
    return { spawnFn, child: () => last! };
  };
  /** Settles with the result, or `'never settled'` after 2 s — a failure says so, never hangs. */
  async function settledWithin(p: Promise<SpawnResult> | SpawnResult) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'never settled'>((resolve) => {
      timer = setTimeout(() => resolve('never settled'), 2_000);
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
    // (a) red when an `'error'` before `'spawn'` does not settle `{ error }`, or settles another
    //     error than the one the child sent; (b) prints the result and whether its error is the
    //     child's `sentError`.
    expect({
      result: shown(result),
      same:
        result !== 'never settled' && 'error' in result && result.error === fake.child().sentError,
    }).toEqual({ result: { error: 'ENOENT' }, same: true });
  });

  it("A3 — the fake in an existing folder resolves { pid }, and is unref'd", async () => {
    const cwd = existingFolder();
    const fake = fakeSpawn();
    const result = await settledWithin(
      defaultSpawnAgent('run-a3', cwd, { model: 'm-744' }, () => {}, fake.spawnFn),
    );
    // (a) red when the result carries no pid, the child is not unref'd, or the folder is not
    //     passed to spawn (the fake then fails in a folder that does not exist); (b) prints the
    //     result (or "never settled") and the `unref` call count.
    expect({ result: shown(result), unref: fake.child().unref.mock.calls.length }).toEqual({
      result: { pid: 4242 },
      unref: 1,
    });
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
    //     late error is dropped, or the folder is not passed to spawn; (b) prints the result and the
    //     messages the callback received.
    expect({
      result: shown(result),
      received: onLateError.mock.calls.map(([e]) => (e as Error).message),
    }).toEqual({ result: { pid: 4242 }, received: ['late one', 'late two'] });
  });

  it("A5 — a 'spawn' with no process id resolves { error } saying so", async () => {
    const cwd = existingFolder();
    const result = await settledWithin(
      defaultSpawnAgent(
        'run-a5',
        cwd,
        { model: 'm-744' },
        () => {},
        fakeSpawn({ impossible: 'spawn-without-pid' }).spawnFn,
      ),
    );
    // The one state Node never produces, made on purpose: the guard covers the type checker's
    // `number | undefined`. (a) red when the guard's message changes, or a pid-less start is
    //     answered `{ pid }`; (b) prints the result and its message.
    expect({
      result: result === 'never settled' ? result : 'error' in result ? 'error' : 'pid',
      message: result !== 'never settled' && 'error' in result ? result.error.message : undefined,
    }).toEqual({
      result: 'error',
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
    const result = await settledWithin(
      makeAgentSpawner(
        { model: 'm-744' },
        logger,
        fakeSpawn({ lateErrors: [late] }).spawnFn,
      )('run-l1', cwd),
    );
    await nextTurn();
    // (a) red when the factory's late-error callback is not wired to the logger, logs at another
    //     level, under another message, or without the run, the folder or the error, or the folder
    //     is not passed to spawn; (b) prints
    //     the result and every logger call (level, message, data).
    expect({ result: shown(result), calls }).toEqual({
      result: { pid: 4242 },
      calls: [
        [
          'error',
          'webhook: agent process error',
          { run_id: 'run-l1', cwd, error: 'Error: late one' },
        ],
      ],
    });
  });

  it('contract — the fake and the real spawn agree: an existing folder starts with a pid, a missing one fails ENOENT with none', async () => {
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    let realCalls = 0;
    let realChild: ChildProcess | undefined;
    // The REAL half: Node's own spawn, the folder and the options as defaultSpawnAgent passes them,
    // but the arguments swapped to `-e 0` — never `node <vitest worker> agent …`.
    const realSpawn = ((cmd: string, _args: readonly string[], opts: SpawnOptions) => {
      realCalls++;
      realChild = actual.spawn(cmd, ['-e', '0'], opts);
      return realChild;
    }) as unknown as SpawnFn;
    const row = (r: SpawnResult | 'never settled', pidAtReturn: string) => ({
      settled: r === 'never settled' ? r : 'error' in r ? 'error' : 'pid',
      code:
        r !== 'never settled' && 'error' in r ? (r.error as NodeJS.ErrnoException).code : undefined,
      pidAtReturn,
    });
    spawnMock.mockClear();
    const table: Record<string, unknown[]> = { real: [], fake: [] };
    for (const cwd of [existingFolder(), missingFolder()]) {
      realChild = undefined;
      const realPending = defaultSpawnAgent('run-c', cwd, { model: 'm-744' }, () => {}, realSpawn);
      const realPid = typeof realChild!.pid;
      table['real']!.push(row(await settledWithin(realPending), realPid));
      // The FAKE half: no spawn function, so it goes through the file-wide mock.
      const fakePending = defaultSpawnAgent('run-c', cwd, { model: 'm-744' }, () => {});
      const fakePid = typeof (spawnMock.mock.results.at(-1)!.value as FakeChild).pid;
      table['fake']!.push(row(await settledWithin(fakePending), fakePid));
    }
    await nextTurn();
    // (a) red when the fake stops following the folder (it then starts in a missing one), the mock
    //     stops passing its options to the fake, or Node's own behaviour changes; (b) prints both
    //     tables (settled, code, the pid's type right after the spawn returned) and the call counts.
    const expected = [
      { settled: 'pid', code: undefined, pidAtReturn: 'number' },
      { settled: 'error', code: 'ENOENT', pidAtReturn: 'undefined' },
    ];
    expect({ ...table, realCalls, mockCalls: spawnMock.mock.calls.length }).toEqual({
      real: expected,
      fake: expected,
      realCalls: 2,
      mockCalls: 2,
    });
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
    const cwd = missingFolder();
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
    const cwd = missingFolder();
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
