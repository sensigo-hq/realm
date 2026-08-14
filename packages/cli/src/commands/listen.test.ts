// Tests for `realm listen` — the full request pipeline (mock req/res, injected deps) + startup.
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createHmac } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { InMemoryStore } from '@sensigo/realm-testing';
import { CURRENT_WORKFLOW_SCHEMA_VERSION } from '@sensigo/realm';
import type { WorkflowDefinition, WebhookTrigger, WorkflowRegistrar } from '@sensigo/realm';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  makeListenHandler,
  buildRouteTable,
  normalizeHeaders,
  prepareListenWorkflows,
  defaultDedupBase,
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
  const res = {
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
  } as unknown as ServerResponse & { statusCode: number; jsonBody: () => Record<string, unknown> };
  return res;
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
    const handler = makeListenHandler(routesFor(def), makeDeps());
    const { status, body } = await invoke(handler, {
      url: '/wf',
      headers: { ...JSON_CT, authorization: SECRET },
      body: JSON.stringify({ no_id: true }),
    });
    expect(status).toBe(400);
    expect(body['error']).toBe('params_invalid');
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
    // No dedup record on failure (so the provider's retry can re-create the run).
    expect(recordSpy).not.toHaveBeenCalled();

    // In-flight counter was freed (finally) — a follow-up request is not 503.
    const second = await invoke(handler, reqOpts);
    expect(second.status).toBe(500); // still spawn_failed, NOT 503
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
