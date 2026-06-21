// listen.ts — `realm listen` server.
//
// A thin, fail-closed webhook server: it loads workflows that declare a `trigger:` block, builds a
// path→workflow route table, and turns each verified inbound webhook into a Realm run + a detached
// `realm agent --run-id` child. Verification is per the workflow's `trigger.auth` (shared_secret for
// Gorgias-style header tokens; github/stripe/hmac body signatures; `none` escape hatch).
//
// Hardening kept deliberately small (the rest is a reverse-proxy concern, documented in --help):
//   - loopback bind by default; non-loopback host → startup TLS warning
//   - body cap + timeout enforced BEFORE any verification work (fixes the legacy webhook DoS)
//   - --max-concurrent 503 floor (the only fail-closed DoS floor independent of proxy hygiene)
//   - SIGTERM/SIGINT → server.close(); the agent child is detached and survives.
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn as nodeSpawn } from 'node:child_process';
import { join } from 'node:path';
import { Command } from 'commander';
import {
  loadWorkflowFromFile,
  JsonFileStore,
  JsonWorkflowStore,
  validateInputSchema,
  WorkflowError,
} from '@sensigo/realm';
import type {
  WorkflowDefinition,
  WebhookTrigger,
  TriggerFilter,
  FilterCondition,
  DedupConfig,
  RunStore,
  WorkflowRegistrar,
} from '@sensigo/realm';
import {
  verifyGithub,
  verifyStripe,
  verifyHmac,
  verifySharedSecret,
} from '../lib/webhook-verifiers.js';
import { extractParams, extractDedupId, resolveDotPath } from '../lib/webhook-params.js';
import { FileDedupStore, InMemoryDedupStore, type DedupStore } from '../lib/dedup-store.js';

const DEFAULT_TTL_MINUTES = 60;
// Fixed signature-header names for the body-signature presets.
const GITHUB_SIG_HEADER = 'x-hub-signature-256';
const STRIPE_SIG_HEADER = 'stripe-signature';

export interface Logger {
  debug(msg: string, data?: unknown): void;
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
}

/** Result of an agent spawn — a pid on success, or an error to record as spawn_failed. */
export type SpawnResult = { pid: number } | { error: Error };

/** Injected I/O dependencies — everything that touches disk, the clock, or child processes. */
export interface ListenDeps {
  workflowStore: Pick<WorkflowRegistrar, 'register'>;
  runStore: Pick<RunStore, 'create' | 'get' | 'update'>;
  dedupStoreFor: (workflowId: string) => DedupStore;
  spawnAgent: (runId: string, cwd: string) => SpawnResult;
  clock: () => number;
  logger: Logger;
}

/** A mounted workflow: its definition, trigger, source directory, and pre-resolved secret. */
export interface WorkflowEntry {
  path: string;
  definition: WorkflowDefinition;
  trigger: WebhookTrigger;
  workflowDir: string;
  /** Resolved from env[auth.secret_from] at startup. undefined only for mode 'none'. */
  secret?: string;
}

export interface HandlerOptions {
  maxConcurrent: number;
  maxBodyBytes: number;
  bodyTimeoutMs: number;
}

const DEFAULT_HANDLER_OPTIONS: HandlerOptions = {
  maxConcurrent: 20,
  maxBodyBytes: 1_048_576,
  bodyTimeoutMs: 5000,
};

/**
 * Normalises raw Node request headers into a Record<string,string> with lowercased keys and a null
 * prototype (prototype-pollution safe). Duplicated headers (array values) are DROPPED — a duplicated
 * security-relevant header (e.g. the shared_secret header) then resolves to undefined and fails
 * verification, which is the intended fail-closed behaviour (never join a security header).
 */
export function normalizeHeaders(raw: IncomingMessage['headers']): Record<string, string> {
  const out = Object.create(null) as Record<string, string>;
  for (const key of Object.keys(raw)) {
    const value = raw[key];
    if (typeof value === 'string') {
      out[key.toLowerCase()] = value;
    }
    // array (duplicated header) and undefined are intentionally omitted → treated as absent.
  }
  return out;
}

/** Returns true when a resolved scalar matches the expected string / string[]. Arrays/objects → false. */
function matchFilterValue(actual: unknown, expected: string | string[]): boolean {
  if (actual === null || actual === undefined) return false;
  if (typeof actual === 'object') return false; // arrays/objects never match a scalar allow-list
  const s = String(actual);
  return Array.isArray(expected) ? expected.includes(s) : s === expected;
}

/** Evaluates filter.all (AND). Header conditions read the normalized header map; path conditions
 *  resolve a dot-path against { headers, body }. Any failing condition → false (request ignored). */
export function evaluateFilter(
  filter: TriggerFilter,
  headers: Record<string, string>,
  body: unknown,
): boolean {
  for (const cond of filter.all as FilterCondition[]) {
    const actual =
      'header' in cond
        ? headers[cond.header.toLowerCase()]
        : resolveDotPath({ headers, body }, cond.path);
    if (!matchFilterValue(actual, cond.value)) {
      return false;
    }
  }
  return true;
}

function verifyRequest(
  entry: WorkflowEntry,
  rawBody: Buffer,
  headers: Record<string, string>,
): boolean {
  const auth = entry.trigger.auth;
  const secret = entry.secret ?? '';
  switch (auth.mode) {
    case 'none':
      return true;
    case 'shared_secret':
      return verifySharedSecret(headers, auth.header, secret);
    case 'github':
      return verifyGithub(rawBody, headers[GITHUB_SIG_HEADER] ?? '', secret);
    case 'stripe':
      return verifyStripe(rawBody, headers[STRIPE_SIG_HEADER] ?? '', secret, auth.max_age_seconds);
    case 'hmac':
      return verifyHmac(rawBody, headers[auth.header.toLowerCase()] ?? '', secret, {
        ...(auth.algorithm !== undefined ? { algorithm: auth.algorithm } : {}),
        ...(auth.encoding !== undefined ? { encoding: auth.encoding } : {}),
        ...(auth.timestamp_header !== undefined ? { timestamp_header: auth.timestamp_header } : {}),
        ...(auth.max_age_seconds !== undefined ? { max_age_seconds: auth.max_age_seconds } : {}),
        headers,
      });
  }
}

/** The header a given auth mode reads — used to reject a duplicated (array) security header. */
function authHeaderName(trigger: WebhookTrigger): string | undefined {
  switch (trigger.auth.mode) {
    case 'shared_secret':
    case 'hmac':
      return trigger.auth.header.toLowerCase();
    case 'github':
      return GITHUB_SIG_HEADER;
    case 'stripe':
      return STRIPE_SIG_HEADER;
    case 'none':
      return undefined;
  }
}

interface BodyOk {
  body: Buffer;
}
interface BodyErr {
  error: 'too_large' | 'timeout' | 'stream';
}

/** Reads the request body with a byte cap and a timeout, before any verification work. */
function readBody(
  req: IncomingMessage,
  maxBytes: number,
  timeoutMs: number,
): Promise<BodyOk | BodyErr> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (result: BodyOk | BodyErr): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      finish({ error: 'timeout' });
      req.destroy();
    }, timeoutMs);
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        finish({ error: 'too_large' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish({ body: Buffer.concat(chunks) }));
    req.on('error', () => finish({ error: 'stream' }));
  });
}

function respond(res: ServerResponse, status: number, payload: Record<string, unknown>): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

/**
 * Builds the request handler. The handler runs the linear, fail-closed pipeline for each request.
 * All I/O is injected via `deps`; no global state except the in-flight concurrency counter.
 */
export function makeListenHandler(
  routes: Map<string, WorkflowEntry>,
  deps: ListenDeps,
  options: Partial<HandlerOptions> = {},
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const opts: HandlerOptions = { ...DEFAULT_HANDLER_OPTIONS, ...options };
  let inFlight = 0;

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // 1. Non-POST → 405.
    if (req.method !== 'POST') {
      respond(res, 405, { error: 'method_not_allowed' });
      return;
    }

    // 2. Path lookup → miss → 403 (never 404 — no path enumeration).
    const path = (() => {
      try {
        return new URL(req.url ?? '/', 'http://localhost').pathname;
      } catch {
        return req.url ?? '/';
      }
    })();
    const entry = routes.get(path);
    if (entry === undefined) {
      respond(res, 403, { error: 'forbidden' });
      return;
    }

    // 3. Concurrency floor → 503.
    if (inFlight >= opts.maxConcurrent) {
      respond(res, 503, { error: 'busy', status: 'rejected' });
      return;
    }

    inFlight += 1;
    try {
      // 4. Read body with cap (413) + timeout (408) BEFORE any verification.
      const bodyResult = await readBody(req, opts.maxBodyBytes, opts.bodyTimeoutMs);
      if ('error' in bodyResult) {
        if (bodyResult.error === 'too_large') {
          respond(res, 413, { error: 'payload_too_large' });
        } else if (bodyResult.error === 'timeout') {
          respond(res, 408, { error: 'request_timeout' });
        } else {
          respond(res, 400, { error: 'bad_request' });
        }
        return;
      }
      const rawBody = bodyResult.body;

      const headers = normalizeHeaders(req.headers);

      // 5. Content-Type must be application/json (media type is case-insensitive per RFC 7231).
      const contentType = (headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
      if (contentType !== 'application/json') {
        respond(res, 415, { error: 'unsupported_media_type' });
        return;
      }

      // A duplicated (array) security header was dropped by normalizeHeaders → reject explicitly.
      const secHeader = authHeaderName(entry.trigger);
      if (secHeader !== undefined && Array.isArray(req.headers[secHeader])) {
        deps.logger.warn('webhook: duplicated security header', { path, header: secHeader });
        respond(res, 403, { error: 'forbidden' });
        return;
      }

      // 6. Verify per auth.mode → 403 on failure.
      if (!verifyRequest(entry, rawBody, headers)) {
        deps.logger.warn('webhook: verification failed', { path, mode: entry.trigger.auth.mode });
        respond(res, 403, { error: 'forbidden' });
        return;
      }

      // Parse JSON body (needed for filter / dedup / params).
      let body: unknown;
      try {
        body = JSON.parse(rawBody.toString('utf-8'));
      } catch {
        respond(res, 400, { error: 'invalid_json' });
        return;
      }

      // 7. Filter (AND). Any condition fails → 200 ignored.
      if (
        entry.trigger.filter !== undefined &&
        !evaluateFilter(entry.trigger.filter, headers, body)
      ) {
        deps.logger.debug('webhook: filtered out', { path });
        respond(res, 200, { status: 'ignored' });
        return;
      }

      // 8. Dedup (default on unless dedup === false).
      // TOCTOU note: the window between check() here and record() after a successful spawn is
      // intentional at-least-once semantics — two near-simultaneous duplicate deliveries can both
      // pass check() and create runs. The run store's idempotencyKey (passed at create, = dedupId)
      // is the cross-restart backstop; the in-flight dedup store is the primary, best-effort guard.
      const dedup = entry.trigger.dedup;
      let dedupId: string | undefined;
      let ttlMs = 0;
      // Resolved once and reused for both check() and record() so correctness does not depend on
      // dedupStoreFor caching identical stores across calls.
      let dedupStore: DedupStore | undefined;
      if (dedup !== undefined && dedup !== false) {
        const dedupConfig = dedup as DedupConfig;
        ttlMs = (dedupConfig.ttl_minutes ?? DEFAULT_TTL_MINUTES) * 60_000;
        dedupId = extractDedupId({ headers, body }, dedupConfig);
        if (dedupId === undefined) {
          if ((dedupConfig.on_missing_id ?? 'skip') === 'reject') {
            respond(res, 400, { error: 'dedup_id_unresolvable', status: 'rejected' });
            return;
          }
          deps.logger.warn('webhook: dedup id unresolvable, proceeding without dedup', { path });
        } else {
          dedupStore = deps.dedupStoreFor(entry.definition.id);
          if (dedupStore.check(dedupId, ttlMs)) {
            deps.logger.debug('webhook: deduplicated', { path });
            respond(res, 200, { status: 'deduplicated' });
            return;
          }
        }
      }

      // 9. Params: extract + validate against params_schema.
      const params = entry.trigger.params_map
        ? extractParams({ headers, body }, entry.trigger.params_map, deps.logger)
        : {};
      if (entry.definition.params_schema !== undefined) {
        try {
          validateInputSchema(params, entry.definition.params_schema, entry.definition.id);
        } catch (err) {
          const message = err instanceof WorkflowError ? err.message : 'invalid params';
          respond(res, 400, { error: 'params_invalid', message, status: 'rejected' });
          return;
        }
      }

      // 10. Create run via Realm's own infra. dedupId doubles as the run store's idempotency backstop.
      await deps.workflowStore.register(entry.definition);
      let run;
      try {
        run = await deps.runStore.create({
          workflowId: entry.definition.id,
          workflowVersion: entry.definition.version,
          params,
          ...(dedupId !== undefined ? { idempotencyKey: dedupId } : {}),
        });
      } catch (err) {
        deps.logger.error('webhook: run creation failed', { path, error: String(err) });
        respond(res, 500, { error: 'store_error', status: 'failed' });
        return;
      }

      // 11. Spawn detached agent.
      // A thrown spawnAgent (contract violation) is funnelled into the same spawn_failed handling
      // below — so the created run is always marked and the response always carries a run_id,
      // never a generic 500 that strands the run unmarked.
      let spawnResult: SpawnResult;
      try {
        spawnResult = deps.spawnAgent(run.id, entry.workflowDir);
      } catch (err) {
        spawnResult = { error: err instanceof Error ? err : new Error(String(err)) };
      }
      if ('error' in spawnResult) {
        deps.logger.error('webhook: spawn failed', {
          path,
          run_id: run.id,
          error: String(spawnResult.error),
        });
        try {
          run.terminal_state = true;
          run.terminal_reason = 'spawn_failed';
          run.run_phase = 'failed';
          await deps.runStore.update(run);
        } catch (err) {
          deps.logger.error('webhook: failed to mark spawn_failed', {
            run_id: run.id,
            error: String(err),
          });
        }
        respond(res, 500, { error: 'spawn_failed', run_id: run.id, status: 'failed' });
        return;
      }

      // Record agent pid/started_at (non-critical metadata), then the dedup record.
      try {
        run.agent_pid = spawnResult.pid;
        run.agent_started_at = new Date(deps.clock()).toISOString();
        await deps.runStore.update(run);
      } catch (err) {
        deps.logger.error('webhook: failed to record agent pid', {
          run_id: run.id,
          error: String(err),
        });
      }
      if (dedupId !== undefined && dedupStore !== undefined) {
        try {
          dedupStore.record(dedupId, ttlMs);
        } catch (err) {
          deps.logger.error('webhook: failed to record dedup id', {
            run_id: run.id,
            error: String(err),
          });
        }
      }

      deps.logger.info('webhook: dispatched', { path, run_id: run.id, pid: spawnResult.pid });
      // 12. Accepted.
      respond(res, 202, { run_id: run.id, status: 'accepted' });
    } finally {
      inFlight -= 1;
    }
  };
}

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost' || host.startsWith('127.');
}

/**
 * Builds the path→workflow route table from loaded workflows. Fail-closed at startup:
 *  - workflows without a `trigger:` block are skipped (logged);
 *  - a path collision across workflows throws;
 *  - every referenced secret env var is resolved now (missing → throws);
 *  - `auth.mode === 'none'` emits a prominent warning.
 */
export function buildRouteTable(
  inputs: Array<{ definition: WorkflowDefinition; workflowDir: string }>,
  deps: { env: Record<string, string | undefined>; logger: Logger },
): Map<string, WorkflowEntry> {
  const routes = new Map<string, WorkflowEntry>();
  for (const { definition, workflowDir } of inputs) {
    const trigger = definition.trigger;
    if (trigger === undefined) {
      deps.logger.info('listen: workflow has no trigger block — not mounted', {
        workflow: definition.id,
      });
      continue;
    }
    const path = trigger.path ?? `/${definition.id}`;
    if (routes.has(path)) {
      throw new Error(
        `listen: path collision on '${path}' — workflow '${definition.id}' conflicts with '${routes.get(path)!.definition.id}'`,
      );
    }

    let secret: string | undefined;
    const auth = trigger.auth;
    if (auth.mode === 'none') {
      deps.logger.warn(
        `listen: workflow '${definition.id}' uses auth.mode 'none' — webhook verification is DISABLED for path '${path}'. Use only on a trusted network.`,
      );
    } else {
      const value = deps.env[auth.secret_from];
      if (value === undefined || value === '') {
        throw new Error(
          `listen: workflow '${definition.id}' references secret env var '${auth.secret_from}' which is not set`,
        );
      }
      secret = value;
    }

    routes.set(path, {
      path,
      definition,
      trigger,
      workflowDir,
      ...(secret !== undefined ? { secret } : {}),
    });
    deps.logger.info('listen: mounted', { workflow: definition.id, path, mode: auth.mode });
  }
  return routes;
}

export interface ListenOptions {
  port: number;
  host: string;
  bodyTimeoutMs: number;
  maxBodyBytes: number;
  maxConcurrent: number;
}

export interface ListenHandle {
  server: Server;
  shutdown(reason: string): Promise<void>;
}

/** Wires the HTTP server + SIGTERM/SIGINT handlers. Returns a handle whose shutdown() stops
 *  accepting new connections; in-flight requests finish and the detached agents survive. */
export function startListen(
  routes: Map<string, WorkflowEntry>,
  options: ListenOptions,
  deps: ListenDeps,
): Promise<ListenHandle> {
  const handler = makeListenHandler(routes, deps, {
    maxConcurrent: options.maxConcurrent,
    maxBodyBytes: options.maxBodyBytes,
    bodyTimeoutMs: options.bodyTimeoutMs,
  });
  const server = createServer((req, res) => {
    void handler(req, res).catch((err) => {
      deps.logger.error('listen: unhandled handler error', { error: String(err) });
      if (!res.headersSent) {
        respond(res, 500, { error: 'internal_error' });
      }
    });
  });

  let shuttingDown = false;
  const shutdown = (reason: string): Promise<void> => {
    if (shuttingDown) return Promise.resolve();
    shuttingDown = true;
    deps.logger.info('listen: shutting down', { reason });
    return new Promise((resolve) => server.close(() => resolve()));
  };
  const onSignal = (sig: string): void => {
    void shutdown(sig).then(() => process.exit(0));
  };
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('SIGINT', () => onSignal('SIGINT'));

  return new Promise((resolve, reject) => {
    let listening = false;
    server.on('error', (err) => {
      if (!listening) reject(err);
      else deps.logger.error('listen: server error', { error: String(err) });
    });
    server.listen(options.port, options.host, () => {
      listening = true;
      resolve({ server, shutdown });
    });
  });
}

function defaultSpawnAgent(runId: string, cwd: string): SpawnResult {
  try {
    const realmBin = process.argv[1] ?? '';
    const child = nodeSpawn(process.execPath, [realmBin, 'agent', '--run-id', runId], {
      detached: true,
      stdio: 'inherit',
      cwd,
    });
    child.unref();
    return { pid: child.pid ?? -1 };
  } catch (err) {
    return { error: err instanceof Error ? err : new Error(String(err)) };
  }
}

function resolveWorkflowFile(input: string): string {
  return input.endsWith('.yaml') || input.endsWith('.yml') ? input : join(input, 'workflow.yaml');
}

/**
 * `realm listen` — start a webhook server that turns verified inbound webhooks into Realm runs.
 *
 * Serves plaintext HTTP. TLS termination, rate limiting, and autoscaling are reverse-proxy /
 * serverless concerns and are intentionally NOT handled here — front this with nginx/Caddy/Traefik
 * for public endpoints. The built-in floors (loopback bind, body cap/timeout, --max-concurrent) are
 * the only DoS protections independent of proxy hygiene.
 */
export const listenCommand = new Command('listen')
  .description(
    'Start a webhook server that creates runs from inbound webhooks (per each workflow trigger: block)',
  )
  .argument('[workflows...]', 'Workflow files or directories to mount (default: ./workflow.yaml)')
  .option('--port <n>', 'Port to listen on', '3000')
  .option('--host <addr>', 'Host/interface to bind (default loopback)', '127.0.0.1')
  .option('--body-timeout-ms <n>', 'Max time to read a request body', '5000')
  .option('--max-body-bytes <n>', 'Max request body size in bytes', '1048576')
  .option('--max-concurrent <n>', 'Max in-flight requests before 503', '20')
  .option('--dedup-store <kind>', 'Dedup store: file | memory', 'file')
  .option('--log-level <level>', 'Log level: debug | info | warn | error', 'info')
  .action(async (workflows: string[], opts: Record<string, string>) => {
    const levels = ['debug', 'info', 'warn', 'error'];
    const threshold = levels.indexOf(opts['logLevel'] ?? 'info');
    const log =
      (level: string) =>
      (msg: string, data?: unknown): void => {
        if (levels.indexOf(level) < threshold) return;
        const line = data !== undefined ? `${msg} ${JSON.stringify(data)}` : msg;
        if (level === 'error') console.error(line);
        else if (level === 'warn') console.warn(line);
        else console.log(line);
      };
    const logger: Logger = {
      debug: log('debug'),
      info: log('info'),
      warn: log('warn'),
      error: log('error'),
    };

    const inputs: Array<{ definition: WorkflowDefinition; workflowDir: string }> = [];
    const args = workflows.length > 0 ? workflows : ['.'];
    for (const input of args) {
      const filePath = resolveWorkflowFile(input);
      try {
        const definition = loadWorkflowFromFile(filePath);
        inputs.push({ definition, workflowDir: join(filePath, '..') });
      } catch (err) {
        console.error(
          `Error: failed to load workflow '${filePath}': ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(1);
        return;
      }
    }

    let routes: Map<string, WorkflowEntry>;
    try {
      routes = buildRouteTable(inputs, { env: process.env, logger });
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
      return;
    }
    if (routes.size === 0) {
      console.error('Error: no workflows with a trigger: block to mount.');
      process.exit(1);
      return;
    }

    const host = opts['host'] ?? '127.0.0.1';
    if (!isLoopbackHost(host)) {
      logger.warn(
        `listen: binding to non-loopback host '${host}' — this server serves plaintext HTTP. Terminate TLS at a reverse proxy before exposing it.`,
      );
    }

    const dedupKind = opts['dedupStore'] === 'memory' ? 'memory' : 'file';
    const dedupBase = join(process.env['HOME'] ?? '.', '.realm', 'dedup');
    const memoryStores = new Map<string, DedupStore>();
    const deps: ListenDeps = {
      workflowStore: new JsonWorkflowStore(),
      runStore: new JsonFileStore(),
      dedupStoreFor: (workflowId: string): DedupStore => {
        if (dedupKind === 'memory') {
          let s = memoryStores.get(workflowId);
          if (s === undefined) {
            s = new InMemoryDedupStore();
            memoryStores.set(workflowId, s);
          }
          return s;
        }
        return new FileDedupStore(dedupBase, workflowId);
      },
      spawnAgent: defaultSpawnAgent,
      clock: () => Date.now(),
      logger,
    };

    const handle = await startListen(
      routes,
      {
        port: parseInt(opts['port'] ?? '3000', 10),
        host,
        bodyTimeoutMs: parseInt(opts['bodyTimeoutMs'] ?? '5000', 10),
        maxBodyBytes: parseInt(opts['maxBodyBytes'] ?? '1048576', 10),
        maxConcurrent: parseInt(opts['maxConcurrent'] ?? '20', 10),
      },
      deps,
    );

    const addr = handle.server.address() as { port: number } | null;
    logger.info(
      `realm listen on ${host}:${addr?.port ?? opts['port']} — ${routes.size} workflow(s) mounted`,
    );
  });
