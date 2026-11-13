// listen-read-r11.ts — test support for R1.1 (the read address of `realm listen`): a real listen
// server on loopback (`startListen`, port 0) over the in-memory store, with a fake agent start and an
// injected disclosure set, and a raw HTTP client that reads what a caller sees (the status, every
// header but `date`, the body as sent). Runs are put in each phase by the engine itself
// (`executeStep`, `abandonRun`), as `realm agent` would leave them.
import { request, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { onTestFinished, vi } from 'vitest';
import { InMemoryStore } from '@sensigo/realm-testing';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  compileDisclosure,
  executeStep,
  type DisclosureEntry,
  type DisclosureSet,
  type RunStore,
  type WorkflowDefinition,
  type WebhookTrigger,
} from '@sensigo/realm';
import {
  buildRouteTable,
  prepareListenWorkflows,
  startListen,
  type ListenDeps,
  type Logger,
  type SpawnResult,
  type WorkflowEntry,
} from '../commands/listen.js';
import { InMemoryDedupStore } from '../lib/dedup-store.js';
import { readCode } from '../lib/run-read-address.js';
import type { loadProjectExtensions } from '../extensions/load-project-extensions.js';

/** Every secret is fake. 22, 22 and 15 characters. */
export const ENV: Record<string, string> = {
  READ_SECRET: 'read-secret-0123456789',
  OTHER_SECRET: 'othr-secret-abcdefghij',
  SHORT_SECRET: 'short-secret-15',
  HMAC_SECRET: 'hmac-secret-0123456789',
  GH_SECRET: 'gh-secret-0123456789xx',
  STRIPE_SECRET: 'whsec_test_0123456789',
};

/** A shared_secret trigger at `path` reading `secretFrom`, with dedup by `body.id`. */
export function sharedSecretTrigger(
  path: string,
  resultMap: Record<string, string> | undefined,
  secretFrom = 'READ_SECRET',
): WebhookTrigger {
  return {
    type: 'webhook',
    path,
    auth: { mode: 'shared_secret', header: 'X-Token', secret_from: secretFrom },
    dedup: { id_from: 'body.id' },
    ...(resultMap !== undefined ? { result_map: resultMap } : {}),
  };
}

/** A one-step workflow (`review`, an agent step) behind `trigger`. */
export function workflow(
  id: string,
  trigger: WebhookTrigger,
  over: Partial<WorkflowDefinition> = {},
): WorkflowDefinition {
  return {
    id,
    name: id,
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps: { review: { description: 'Review.', execution: 'agent', depends_on: [] } },
    trigger,
    ...over,
  };
}

/** A disclosure set built with core's own constructor: nothing declared, nothing to hide. */
export function emptySet(entries: DisclosureEntry[] = []): DisclosureSet {
  return compileDisclosure(entries, {
    declared: 'resolved',
    audience: 'agent',
    environment: 'swept',
  }).set;
}

const noExtensions = (async () => ({
  registry: {} as never,
  manifest: { modules: [], adapters: [], handlers: [], processors: [] },
})) as unknown as typeof loadProjectExtensions;

/** What a listen line logged: its level, message and data. */
export interface Line {
  level: 'debug' | 'info' | 'warn' | 'error';
  msg: string;
  data?: unknown;
}

export function capturingLogger(): Logger & { lines: Line[] } {
  const lines: Line[] = [];
  const at =
    (level: Line['level']) =>
    (msg: string, data?: unknown): void => {
      lines.push({ level, msg, ...(data !== undefined ? { data } : {}) });
    };
  return { lines, debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

export interface Served {
  port: number;
  store: RunStore;
  routes: Map<string, WorkflowEntry>;
  deps: ListenDeps;
  logger: ReturnType<typeof capturingLogger>;
  provider: ReturnType<typeof vi.fn>;
  /** The read code of `runId` at the workflow mounted on `path`. */
  code(path: string, runId: string): string;
}

/**
 * A real listen server for `definitions` (each with its own fake folder), prepared as the CLI does
 * (the read keys derived), on a free loopback port; closed after the cell.
 */
export async function serve(
  definitions: WorkflowDefinition[],
  opts: {
    store?: RunStore;
    over?: Partial<ListenDeps>;
    maxConcurrent?: number;
    env?: Record<string, string>;
    provider?: () => Promise<DisclosureSet>;
  } = {},
): Promise<Served> {
  const store = opts.store ?? new InMemoryStore();
  const logger = capturingLogger();
  const routes = buildRouteTable(
    definitions.map((definition) => ({ definition, workflowDir: '/tmp/r11-wf' })),
    { env: opts.env ?? ENV, logger },
  );
  const dedup = new Map<string, InMemoryDedupStore>();
  const provider = vi.fn(opts.provider ?? (async () => emptySet()));
  const deps: ListenDeps = {
    workflowStore: { register: async () => {}, get: async () => definitions[0]! },
    runStore: store,
    dedupStoreFor: (id) => {
      let s = dedup.get(id);
      if (s === undefined) dedup.set(id, (s = new InMemoryDedupStore()));
      return s;
    },
    spawnAgent: vi.fn(async (): Promise<SpawnResult> => ({ pid: 4242 })),
    logger,
    disclosureProvider: provider,
    ...opts.over,
  };
  await prepareListenWorkflows(routes, deps, noExtensions);
  const signals = ['SIGTERM', 'SIGINT'] as const;
  const before = new Map(signals.map((sig) => [sig, process.listeners(sig)]));
  const handle = await startListen(
    routes,
    {
      port: 0,
      host: '127.0.0.1',
      bodyTimeoutMs: 5000,
      maxBodyBytes: 10_000_000,
      maxConcurrent: opts.maxConcurrent ?? 20,
    },
    deps,
  );
  for (const sig of signals) {
    for (const l of process.listeners(sig)) {
      if (!before.get(sig)!.includes(l)) process.removeListener(sig, l);
    }
  }
  onTestFinished(() => {
    handle.server.closeAllConnections();
    return handle.shutdown('test');
  });
  return {
    port: (handle.server.address() as AddressInfo).port,
    store,
    routes,
    deps,
    logger,
    provider,
    code: (path, runId) => readCode(routes.get(path)!.readKey!, runId),
  };
}

/** What a caller saw: the status, the headers but `date`, and the body as sent. */
export interface Seen {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export function http(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<Seen> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (d: string) => (text += d));
      res.on('end', () => {
        const kept: IncomingHttpHeaders = { ...res.headers };
        delete kept['date'];
        resolve({
          status: res.statusCode ?? 0,
          headers: Object.fromEntries(Object.entries(kept).map(([k, v]) => [k, String(v)])),
          body: text,
        });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.end(body);
    else req.end();
  });
}

/** A POST of `event` to `path` with the shared secret `secret`. */
export function post(port: number, path: string, event: unknown, secret = ENV['READ_SECRET']!) {
  return http(
    port,
    'POST',
    path,
    { 'content-type': 'application/json', 'x-token': secret },
    JSON.stringify(event),
  );
}

/** A GET (or HEAD) of `<path>/runs/<runId>` with `authorization` as given (none when undefined). */
export function read(
  port: number,
  path: string,
  runId: string,
  authorization: string | undefined,
  method = 'GET',
): Promise<Seen> {
  return http(
    port,
    method,
    `${path.replace(/\/+$/, '')}/runs/${runId}`,
    authorization === undefined ? {} : { authorization },
  );
}

/** A run of `definition` created in `store` (phase `running`). */
export async function createRun(
  store: RunStore,
  definition: WorkflowDefinition,
  version = definition.version,
): Promise<string> {
  return (await store.create({ workflowId: definition.id, workflowVersion: version, params: {} }))
    .record.id;
}

/** A completed run of the one-step `definition` whose `review` step recorded `output`. */
export async function completedRun(
  store: RunStore,
  definition: WorkflowDefinition,
  output: Record<string, unknown>,
  version = definition.version,
): Promise<string> {
  const runId = await createRun(store, definition, version);
  await executeStep(store, definition, {
    runId,
    command: 'review',
    input: output,
    dispatcher: async (_c, input) => input,
  });
  return runId;
}
