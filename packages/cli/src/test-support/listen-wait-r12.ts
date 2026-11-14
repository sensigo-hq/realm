// listen-wait-r12.ts — test support for R1.2 (a caller of `realm listen` asks the reply to wait):
// two real servers on loopback over the in-memory store, built on R1.1's support
// (`listen-read-r11.ts`). `serveListen` is `startListen` itself, with its stop (`handle.shutdown`)
// and a second signal in reach; `serveHandler` is the request handler on a plain server, with a stop
// signal the cell owns and every request's handling awaitable, so a cell can count what a request
// left behind.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { getEventListeners } from 'node:events';
import { onTestFinished, vi } from 'vitest';
import { InMemoryStore } from '@sensigo/realm-testing';
import type { DisclosureSet, RunStore, WorkflowDefinition } from '@sensigo/realm';
import {
  buildRouteTable,
  makeListenHandler,
  prepareListenWorkflows,
  startListen,
  type ListenDeps,
  type ListenHandle,
  type SpawnResult,
  type WorkflowEntry,
} from '../commands/listen.js';
import { InMemoryDedupStore } from '../lib/dedup-store.js';
import { readCode } from '../lib/run-read-address.js';
import type { loadProjectExtensions } from '../extensions/load-project-extensions.js';
import { ENV, capturingLogger, emptySet } from './listen-read-r11.js';

const noExtensions = (async () => ({
  registry: {} as never,
  manifest: { modules: [], adapters: [], handlers: [], processors: [] },
})) as unknown as typeof loadProjectExtensions;

export interface WaitOptions {
  store?: RunStore;
  over?: Partial<ListenDeps>;
  maxConcurrent?: number;
  maxWaitSeconds?: number;
  maxWaiting?: number;
  provider?: () => Promise<DisclosureSet>;
  /** Each workflow's folder (an agent is started in it); default a path that need not exist. */
  workflowDir?: string;
}

export interface Common {
  port: number;
  store: RunStore;
  routes: Map<string, WorkflowEntry>;
  deps: ListenDeps;
  logger: ReturnType<typeof capturingLogger>;
  /** The read code of `runId` at the workflow mounted on `path`. */
  code(path: string, runId: string): string;
  /** The `webhook: wait ended` lines' data, in order. */
  waits(): Array<Record<string, unknown>>;
}

async function prepared(definitions: WorkflowDefinition[], opts: WaitOptions) {
  const store = opts.store ?? new InMemoryStore();
  const logger = capturingLogger();
  const routes = buildRouteTable(
    definitions.map((definition) => ({
      definition,
      workflowDir: opts.workflowDir ?? '/tmp/r12-wf',
    })),
    { env: ENV, logger },
  );
  const dedup = new Map<string, InMemoryDedupStore>();
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
    disclosureProvider: vi.fn(opts.provider ?? (async () => emptySet())),
    ...opts.over,
  };
  await prepareListenWorkflows(routes, deps, noExtensions);
  const common = (port: number): Common => ({
    port,
    store,
    routes,
    deps,
    logger,
    code: (path, runId) => readCode(routes.get(path)!.readKey!, runId),
    waits: () =>
      logger.lines
        .filter((l) => l.msg === 'webhook: wait ended')
        .map((l) => l.data as Record<string, unknown>),
  });
  return { store, routes, deps, common };
}

/**
 * `startListen` on a free loopback port. Its signal listeners are taken off the process: `stop()` is
 * the first signal's work (`handle.shutdown`), never an exit. After the cell, a stop and then the
 * second signal (which ends a drain and the grace) close it at once.
 */
export async function serveListen(
  definitions: WorkflowDefinition[],
  opts: WaitOptions & { shutdownDrainSeconds?: number } = {},
): Promise<Common & { handle: ListenHandle }> {
  const { routes, deps, common } = await prepared(definitions, opts);
  const before = process.listeners('SIGTERM');
  const beforeInt = process.listeners('SIGINT');
  const handle = await startListen(
    routes,
    {
      port: 0,
      host: '127.0.0.1',
      bodyTimeoutMs: 5000,
      maxBodyBytes: 10_000_000,
      maxConcurrent: opts.maxConcurrent ?? 20,
      ...(opts.maxWaitSeconds !== undefined ? { maxWaitSeconds: opts.maxWaitSeconds } : {}),
      ...(opts.maxWaiting !== undefined ? { maxWaiting: opts.maxWaiting } : {}),
      ...(opts.shutdownDrainSeconds !== undefined
        ? { shutdownDrainSeconds: opts.shutdownDrainSeconds }
        : {}),
    },
    deps,
  );
  const added = process.listeners('SIGTERM').filter((l) => !before.includes(l));
  for (const l of added) process.removeListener('SIGTERM', l);
  for (const l of process.listeners('SIGINT').filter((x) => !beforeInt.includes(x))) {
    process.removeListener('SIGINT', l);
  }
  onTestFinished(async () => {
    handle.server.closeAllConnections();
    const stopped = handle.shutdown('test');
    // The listener's second-signal branch (the stop has begun, so it never exits the process).
    for (const l of added) (l as () => void)();
    await stopped;
  });
  return { ...common((handle.server.address() as AddressInfo).port), handle };
}

/**
 * The request handler on a plain loopback server, given a stop signal the cell aborts. `settled()`
 * resolves once every request's handling has ended; `timers()` counts the process's active timers;
 * `abortListeners()` counts the listeners on the stop signal.
 */
export async function serveHandler(
  definitions: WorkflowDefinition[],
  opts: WaitOptions = {},
): Promise<
  Common & {
    stop: AbortController;
    settled(): Promise<void>;
    abortListeners(): number;
  }
> {
  const { routes, deps, common } = await prepared(definitions, opts);
  const stop = new AbortController();
  const handler = makeListenHandler(routes, deps, {
    maxConcurrent: opts.maxConcurrent ?? 20,
    maxBodyBytes: 10_000_000,
    ...(opts.maxWaitSeconds !== undefined ? { maxWaitSeconds: opts.maxWaitSeconds } : {}),
    ...(opts.maxWaiting !== undefined ? { maxWaiting: opts.maxWaiting } : {}),
    stopSignal: stop.signal,
  });
  const pending = new Set<Promise<void>>();
  const server: Server = createServer((req, res) => {
    const p = handler(req, res);
    pending.add(p);
    void p.finally(() => pending.delete(p));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  onTestFinished(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return {
    ...common((server.address() as AddressInfo).port),
    stop,
    settled: async () => {
      while (pending.size > 0) await Promise.all([...pending]);
    },
    abortListeners: () => getEventListeners(stop.signal, 'abort').length,
  };
}

/** The process's active timers (`process._getActiveHandles()` does not list them). */
export function timers(): number {
  return process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
}

/** `ms` milliseconds. */
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
