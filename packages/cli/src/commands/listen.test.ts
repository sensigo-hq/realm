// Tests for `realm listen` — the full request pipeline (mock req/res, injected deps) + startup.
//
// issue #409: `node:child_process` is mocked FILE-WIDE, deliberately and safely. Vitest hoists
// every `vi.mock` to the top of the file whatever AST depth it is written at, so a
// describe-scoped one would silently be file-wide anyway — better to say so than to look scoped.
// Safe here because no other cell in this file reaches child_process: they all double the
// `spawnAgent` deps seam, which sits ABOVE the spawn.
import { describe, it, expect, vi } from 'vitest';
import { InvalidArgumentError } from 'commander';

const spawnMock = vi.hoisted(() => vi.fn(() => ({ pid: 4242, unref: vi.fn() })));
vi.mock('node:child_process', () => ({ spawn: spawnMock }));
import { EventEmitter } from 'node:events';
import { createHmac } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { InMemoryStore } from '@sensigo/realm-testing';
import { CURRENT_WORKFLOW_SCHEMA_VERSION, abandonRun, JsonFileStore } from '@sensigo/realm';
import type { WorkflowDefinition, WebhookTrigger, WorkflowRegistrar } from '@sensigo/realm';
import { homedir, tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import {
  makeListenHandler,
  buildRouteTable,
  normalizeHeaders,
  prepareListenWorkflows,
  defaultDedupBase,
  buildAgentArgv,
  defaultSpawnAgent,
  listenCommand,
  type ListenDeps,
  type Logger,
  type WorkflowEntry,
  type SpawnResult,
} from './listen.js';
import { InMemoryDedupStore } from '../lib/dedup-store.js';
import type { loadProjectExtensions } from '../extensions/load-project-extensions.js';

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
  const spawnAgent = vi.fn((): SpawnResult => ({ pid: 4242 }));
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
    const deps = makeDeps({ spawnAgent: vi.fn((): SpawnResult => ({ error: new Error('boom') })) });
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
    const deps = makeDeps({
      spawnAgent: vi.fn(() => {
        throw new Error('exec failed');
      }),
      dedupStoreFor: () => dedupStore,
    });
    const trigger: WebhookTrigger = { ...SHARED_SECRET_TRIGGER, dedup: { id_from: 'body.id' } };
    const handler = makeListenHandler(routesFor(wf(trigger)), deps);
    const reqOpts = {
      url: '/wf',
      headers: { ...JSON_CT, authorization: SECRET },
      body: JSON.stringify({ id: 'evt-1' }),
    };

    const { status, body } = await invoke(handler, reqOpts);
    expect(status).toBe(500);
    expect(body['error']).toBe('spawn_failed');
    expect(body['run_id']).toBeDefined();
    const run = await deps.runStore.get(body['run_id'] as string);
    expect(run.terminal_reason).toBe('spawn_failed');
    expect(run.terminal_state).toBe(true);
    // No dedup record on failure. A retry with the same id still does not get a fresh run: the
    // run store matches the run the spawn failure sealed (below; issue #735, residual 1).
    expect(recordSpy).not.toHaveBeenCalled();

    // In-flight counter was freed (finally) — a follow-up request is not 503. issue #735, cell 6:
    // the retry reuses `evt-1`, the run store matches the sealed run (`created: false`), and the
    // retry is told that run — its id and phase — with nothing spawned.
    // (a) red when listen spawns onto the matched run again (before #735: a second spawn, 500);
    // (b) prints the reply and the spawn count.
    const second = await invoke(handler, reqOpts);
    expect({ second, spawns: deps.spawnAgent.mock.calls.length }).toEqual({
      second: {
        status: 200,
        body: { status: 'deduplicated', run_id: body['run_id'], run_phase: 'failed' },
      },
      spawns: 1,
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
    let pid = 4242;
    const deps = makeDeps({
      spawnAgent: vi.fn((): SpawnResult => ({ pid: pid++ })),
      logger: { ...silentLogger, info: (m: string, d?: unknown) => infos.push([m, d]) },
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
      return { runId, first, second, third, spawns, kept, record, create, deduplicated };
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
    // (a) red when listen spawns onto the ended run and writes the sealed record (before #735:
    //     202, a spawn, the version bumped); (b) prints the reply, the spawn count, the versions.
    expect({
      second: r.second,
      spawns: r.spawns,
      version: [r.kept.version, r.record.version],
    }).toEqual({
      second: {
        status: 200,
        body: { status: 'deduplicated', run_id: r.runId, run_phase: 'abandoned' },
      },
      spawns: 1,
      version: [r.kept.version, r.kept.version],
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
    ['the same params', { note: 'a' }, {}],
    ['other mapped params', { note: 'b' }, { params_differ: true }],
  ] as const)(
    '#735: a matched delivery with %s — params_differ said only when the mapped params differ',
    async (_label, second, extra) => {
      const r = await afterTheWindow({
        trigger: { ...DEDUP_1M, params_map: { ticket_id: 'body.id', note: 'body.note' } },
        first: { note: 'a' },
        second,
      });
      // (a) red when a later delivery under the same id with other params is dropped without a
      //     word, or the flag is said when the params are the same; (b) prints the logged data.
      expect(r.deduplicated).toEqual([
        [
          'webhook: deduplicated',
          {
            path: '/wf',
            run_id: r.runId,
            run_phase: 'running',
            reason: 'matched_existing_run',
            ...extra,
          },
        ],
      ]);
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
    const replies = await Promise.all([invoke(handler, evt()), invoke(handler, evt())]);
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
  it('WIRED — the spawn carries the flag when the operator set one', () => {
    spawnMock.mockClear();
    const result = defaultSpawnAgent('run-42', '/tmp/cwd', {
      model: 'm-676',
      llmTimeoutSeconds: 45,
    });
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

  it('WIRED — the spawn is unchanged when the operator set none', () => {
    spawnMock.mockClear();
    const result = defaultSpawnAgent('run-43', '/tmp/cwd', { model: 'm-676' });
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
