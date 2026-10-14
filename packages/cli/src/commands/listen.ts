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
//   - a refusal before the body is read closes in stages (#744 E2): `Connection: close`, at most
//     `lingerMs` (2 s) of reading and discarding after the refusal is sent, at most
//     --max-concurrent such sockets at once
//   - a body declared over the cap (by its `Content-Length`) is refused unread (#744)
//   - `100-continue` is answered only after the checks before the body (#744)
//   - headers must arrive within the body timeout; a whole request within Node's 5-minute request
//     timeout, or twice the body timeout plus `lingerMs` plus 1 s if that is longer (#744)
//   - SIGTERM/SIGINT → server.close(); the agent child is detached and survives.
import {
  createServer,
  maxHeaderSize,
  STATUS_CODES,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { Socket } from 'node:net';
import { spawn as nodeSpawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { Command, InvalidArgumentError } from 'commander';
// issue #409: the SAME parser `realm agent --llm-timeout` uses — never a second copy, so the two
// flags cannot drift on what they accept. The listen→agent edge is one-way and cycle-free.
import { parseLlmTimeout, parseProvider } from './agent.js';
import { hasText, listenModelRefusal, type ProviderName } from '../agent/providers/llm-provider.js';
import {
  loadWorkflowFromFile,
  JsonFileStore,
  JsonWorkflowStore,
  validateRunParams,
  WorkflowError,
  sealRunLevel,
  renderLoaderWarning,
  describePending,
  owedNames,
  cannotGoOnLines,
  deriveRunPhase,
  hashParams,
} from '@sensigo/realm';
import type {
  WorkflowDefinition,
  WebhookTrigger,
  TriggerFilter,
  FilterCondition,
  DedupConfig,
  RunStore,
  RunListing,
  UnreadableRunFileEntry,
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
import { listRunsDiagnosed } from './list.js';
import {
  loadProjectExtensions,
  onceReleaseLineSink,
} from '../extensions/load-project-extensions.js';

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
export type SpawnResult = { pid: number; error?: never } | { error: Error; pid?: never };

/** Injected I/O dependencies — everything that touches disk, the clock, or child processes. */
export interface ListenDeps {
  // issue #291 (Deliverable 4f): widened to add 'get' — the sweep loop resolves each expired
  // gate's workflow definition before it can construct an expire_gate delta.
  workflowStore: Pick<WorkflowRegistrar, 'register' | 'get'>;
  // issue #291 (Deliverable 4f): widened to add 'list' (the sweep's own store-scan) + 'settleStep'
  // (the enactment write). Both OPTIONAL-shaped on the real RunStore interface already — Pick
  // preserves that optionality, so a store that doesn't declare settleStep still satisfies this.
  // issue #719 (B3): the JSON store's `listWithDiagnostics`, optional — when present the sweep acts
  // on the readable runs and logs each run file it cannot read instead of failing every pass.
  runStore: Pick<RunStore, 'create' | 'get' | 'update' | 'list' | 'settleStep'> & {
    listWithDiagnostics?: (workflowId?: string) => Promise<RunListing>;
  };
  dedupStoreFor: (workflowId: string) => DedupStore;
  // issue #744: settles once Node has said whether the agent started (`'spawn'`) or not
  // (`'error'`, which for a missing or unenterable folder comes on the next tick, not as a throw).
  spawnAgent: (runId: string, cwd: string) => Promise<SpawnResult>;
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
  /** #744 E2: how long a refused socket keeps reading and discarding before it is destroyed. */
  lingerMs: number;
}

const DEFAULT_HANDLER_OPTIONS: HandlerOptions = {
  maxConcurrent: 20,
  maxBodyBytes: 1_048_576,
  bodyTimeoutMs: 5000,
  lingerMs: 2000,
};

/** #744 E2: requests ignored on one connection after its unsent refusal, before it is destroyed. */
const MAX_IGNORED_AFTER_REFUSAL = 32;

/**
 * #744: every socket listen has refused on. A socket belongs to one server, so one set serves every
 * handler; the server's 'clientError' listener reads it.
 */
const refusedSockets = new WeakSet<Socket>();

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
    // #744 E2: on the cap or the timeout, stop buffering but do not destroy the request: the
    // handler's 413/408 must still reach the sender. The rest of the body is discarded as it arrives
    // (`resume()`), and the refusal closes the connection in stages (`refuse` below).
    const stopBuffering = (): void => {
      req.removeListener('data', onData);
      req.resume();
    };
    const timer = setTimeout(() => {
      finish({ error: 'timeout' });
      stopBuffering();
    }, timeoutMs);
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > maxBytes) {
        finish({ error: 'too_large' });
        stopBuffering();
        return;
      }
      chunks.push(chunk);
    };
    req.on('data', onData);
    req.on('end', () => finish({ body: Buffer.concat(chunks) }));
    req.on('error', () => finish({ error: 'stream' }));
  });
}

function respond(res: ServerResponse, status: number, payload: Record<string, unknown>): void {
  // #744: every reply carries its length, so a reply to an HTTP/1.0 sender that keeps its
  // connection open does not end it.
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * A request's path: the pathname only, never the query string (which can carry a token), even for
 * an address the URL parser refuses (one starting with `//`, for one).
 */
function requestPath(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://localhost').pathname;
  } catch {
    const raw = req.url ?? '/';
    const cut = raw.search(/[?#]/);
    return cut === -1 ? raw : raw.slice(0, cut);
  }
}

/**
 * issue #735 (F1): the ONE reply to a delivery whose agent failed to start — the first copy's, and
 * every retry of that delivery that matches the run the failure sealed. A replayed request gets its
 * FIRST verdict, never a success for work that never ran.
 */
function spawnFailedReply(runId: string): {
  status: 500;
  body: { error: 'spawn_failed'; run_id: string; status: 'failed' };
} {
  return { status: 500, body: { error: 'spawn_failed', run_id: runId, status: 'failed' } };
}

/**
 * Builds the request handler. The handler runs the linear, fail-closed pipeline for each request.
 * All I/O is injected via `deps`; no global state except the in-flight concurrency counter.
 */
export function makeListenHandler(
  routes: Map<string, WorkflowEntry>,
  deps: ListenDeps,
  options: Partial<HandlerOptions> = {},
): (
  req: IncomingMessage,
  res: ServerResponse,
  via?: { continueExpected?: boolean; expectationFailed?: boolean },
) => Promise<void> {
  const opts: HandlerOptions = { ...DEFAULT_HANDLER_OPTIONS, ...options };
  let inFlight = 0;
  // #744 E2: every socket closing after a refusal, mapped to that refusal's reply and the number of
  // later requests ignored on it; and how many of them linger (close in stages).
  const closingSockets = new WeakMap<Socket, { refusal: ServerResponse; ignored: number }>();
  let lingeringCount = 0;

  /**
   * #744 E2: the one way to refuse while the body is unread or only partly read: 417, 400
   * (`host_required`), 405, 403 (unknown address), 503, 413 and 408. The 400 for a broken body is
   * never sent: its connection is already gone, and the check below returns at once. The reply
   * carries `Connection: close`; the rest of the body is discarded as it arrives; and, while fewer
   * than `maxConcurrent` sockets linger, the socket closes in stages (RFC 9112 §9.6): the FIN after
   * the reply, then reading and discarding what the sender still sends, then a destroy `lingerMs`
   * after the refusal can be written. A close with unread data makes the kernel send a reset,
   * which a sender still writing its body sees instead of the reply. At the cap, Node closes the
   * socket as it always has.
   */
  const refuse = (
    req: IncomingMessage,
    res: ServerResponse,
    status: number,
    payload: Record<string, unknown>,
  ): void => {
    const socket = req.socket as Socket | undefined;
    // One refusal, one reply, one line: a connection that is already ending gets neither. Either
    // the server's 'clientError' listener has just sent Node's refusal and ended the socket, or the
    // sender went away mid-body, and a 400 for the broken body could never be sent (#744).
    if (socket !== undefined && !socket.writable) return;
    // Recorded first, whether or not it lingers: the handler's guard then handles no request sent
    // on this connection after this one.
    if (socket !== undefined) {
      closingSockets.set(socket, { refusal: res, ignored: 0 });
      refusedSockets.add(socket);
    }
    // #744: one line per refusal. The path is the pathname only, never the query string (which can
    // carry a token), and no header or body. The reply's own fields follow, except the 503's
    // `status: 'rejected'`, which would overwrite the status code.
    const fields = Object.fromEntries(Object.entries(payload).filter(([key]) => key !== 'status'));
    deps.logger.warn('webhook: refused', { path: requestPath(req), status, ...fields });
    const body = JSON.stringify(payload);
    // `writeHead`, not `setHeader`: the header must be set where the reply is written.
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      Connection: 'close',
    });
    req.resume();
    if (socket !== undefined && !socket.destroyed && res.socket === null) {
      // The reply is queued behind an earlier reply on this connection (Node's queue,
      // `_http_server.js:1228-1232` @ v24.21.0). It takes no linger slot while it waits. Node calls
      // `destroySoon()` once a reply that ends the connection has been written. That reply is this
      // refusal: every reply listen sends carries its length, and a connection the sender asked to
      // close never hands over a later request. Only then does it take a slot, if one is free, and
      // start the timer; otherwise it closes the way Node does (#744).
      socket.destroySoon = () => {
        if (lingeringCount < opts.maxConcurrent) {
          lingeringCount += 1;
          const timer = setTimeout(() => socket.destroy(), opts.lingerMs);
          socket.once('close', () => {
            clearTimeout(timer);
            lingeringCount -= 1;
          });
          socket.end();
        } else {
          Socket.prototype.destroySoon.call(socket);
        }
      };
    } else if (socket !== undefined && !socket.destroyed && lingeringCount < opts.maxConcurrent) {
      lingeringCount += 1;
      // The reply has its socket now. Here the time bound does not depend on Node: the socket is
      // destroyed `lingerMs` after this refusal unless it has closed by then.
      const timer = setTimeout(() => socket.destroy(), opts.lingerMs);
      // The seam: Node's server calls `socket.destroySoon()` after a reply carrying
      // `Connection: close` (`_http_server.js:1124-1128` @ v24.21.0), which ends the socket and
      // destroys it once the FIN is out. On this socket only, it now only half-closes, so the socket
      // keeps reading until the timer above. If a later Node stops calling it, the FIN is lost and
      // the E2 cell C12's half-close check goes red.
      socket.destroySoon = () => {
        socket.end();
      };
      socket.once('close', () => {
        clearTimeout(timer);
        lingeringCount -= 1;
      });
    }
    res.end(body);
  };

  return async function handle(
    req: IncomingMessage,
    res: ServerResponse,
    via?: { continueExpected?: boolean; expectationFailed?: boolean },
  ): Promise<void> {
    // #744 E2: a request sent on a connection that is closing after a refusal is not handled (RFC
    // 9112 §9.6 allows no further request after a close; Node still hands a pipelined one to the
    // handler). When nothing is pending the socket is destroyed at once. Nothing is pending once
    // the refusal is written, or once it holds the socket with all its bytes handed to the kernel:
    // `'finish'` comes a tick after that, so a request in the same read still sees
    // `writableFinished` false. While a reply ahead of the refusal is still unwritten, the request
    // is ignored instead (read, no reply): the replies before the refusal, and the refusal itself,
    // are then written in order, and the connection closes at the end of the refusal's linger, or
    // at once when no linger slot is free. Past `MAX_IGNORED_AFTER_REFUSAL` such requests the
    // socket is destroyed: that bounds the work one connection can make listen hold, since
    // ignoring without a bound let one connection create requests without limit (#744).
    const closing = closingSockets.get(req.socket);
    if (closing !== undefined) {
      const { refusal } = closing;
      if (
        refusal.writableFinished ||
        (refusal.socket === req.socket && req.socket.writableLength === 0)
      ) {
        req.socket.destroy();
      } else if (closing.ignored < MAX_IGNORED_AFTER_REFUSAL) {
        closing.ignored += 1;
        req.resume();
      } else {
        req.socket.destroy();
      }
      return;
    }

    // Refusals Node used to make itself, now made in listen's form, and logged (#744): an
    // HTTP/1.1 `Expect` other than `100-continue` (the server's 'checkExpectation' listener), and
    // an HTTP/1.1 request without `Host`, which RFC 9112 §3.2 requires (the server's
    // `requireHostHeader: false`).
    if (via?.expectationFailed === true) {
      refuse(req, res, 417, { error: 'expectation_failed' });
      return;
    }
    if (
      req.httpVersionMajor === 1 &&
      req.httpVersionMinor === 1 &&
      req.headers.host === undefined
    ) {
      refuse(req, res, 400, { error: 'host_required' });
      return;
    }

    // 1. Non-POST → 405.
    if (req.method !== 'POST') {
      refuse(req, res, 405, { error: 'method_not_allowed' });
      return;
    }

    // 2. Path lookup → miss → 403 (never 404 — no path enumeration).
    const path = requestPath(req);
    const entry = routes.get(path);
    if (entry === undefined) {
      refuse(req, res, 403, { error: 'forbidden' });
      return;
    }

    // 3. Concurrency floor → 503.
    if (inFlight >= opts.maxConcurrent) {
      refuse(req, res, 503, { error: 'busy', status: 'rejected' });
      return;
    }

    inFlight += 1;
    try {
      // 4. The body, BEFORE any verification. A body declared larger than the cap is refused before
      //    any of it is read (#744); Node has already refused a malformed Content-Length with its
      //    own 400.
      const declared = req.headers['content-length'];
      if (declared !== undefined && Number(declared) > opts.maxBodyBytes) {
        refuse(req, res, 413, { error: 'payload_too_large', max_body_bytes: opts.maxBodyBytes });
        return;
      }
      // Only now is the body invited: the server's 'checkContinue' listener stops Node sending
      // `100 Continue` on its own. Node routes to 'checkContinue' exactly the requests that may be
      // invited: HTTP/1.1, and an `Expect` matching `100-continue` (`_http_server.js:1244`,
      // `:1275-1278` @ v24.21.0) (#744).
      if (via?.continueExpected === true) res.writeContinue();
      // Then it is read with the cap (413) and the timeout (408).
      const bodyResult = await readBody(req, opts.maxBodyBytes, opts.bodyTimeoutMs);
      if ('error' in bodyResult) {
        if (bodyResult.error === 'too_large') {
          refuse(req, res, 413, { error: 'payload_too_large', max_body_bytes: opts.maxBodyBytes });
        } else if (bodyResult.error === 'timeout') {
          refuse(req, res, 408, { error: 'request_timeout', body_timeout_ms: opts.bodyTimeoutMs });
        } else {
          refuse(req, res, 400, { error: 'bad_request' });
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
      // This check answers a delivery whose id was recorded inside the window. It does not see two
      // copies of one delivery arriving together (both pass check() before either is recorded), nor
      // a copy redelivered after the window. The run store does: dedupId is passed to create() as
      // the idempotency key, so the second copy matches the first copy's run — ONE run — and listen
      // reads create()'s `created` (step 10): only the copy that created the run starts an agent.
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
          // issue #586: `validateRunParams` — the old call said `Invalid input for step '<id>'`,
          // naming a step where the thing validated was the workflow's params.
          validateRunParams(params, entry.definition.params_schema, entry.definition.id);
        } catch (err) {
          const message = err instanceof WorkflowError ? err.message : 'invalid params';
          // issue #586 (walk J6-a): the 400 is the ONLY witness to this refusal, and it lives in
          // the caller's process — a third-party webhook sender that may discard it. An operator
          // whose upstream is posting the wrong shape saw "no runs are being created" and had
          // nothing server-side to look at, at any `--log-level` including debug. Logged at the
          // same level as `webhook: dispatched`, so the accepted and the refused POST are on the
          // same line of the same log.
          deps.logger.info(`webhook: rejected params_invalid — ${message}`, {
            path,
            workflow: entry.definition.id,
          });
          respond(res, 400, { error: 'params_invalid', message, status: 'rejected' });
          return;
        }
      }

      // 10. Create run via Realm's own infra. dedupId doubles as the run store's idempotency backstop.
      // Workflows are registered ONCE at startup (prepareListenWorkflows) — the old per-webhook
      // register silently reverted fresher registrations. Restart listen after re-registering.
      let run;
      let created: boolean | undefined;
      try {
        // After the window, and when two copies of one delivery arrive together, check() above
        // does not recognise the delivery; the run store's match on the idempotency key (= dedupId)
        // does. So listen reads `created`: a delivery that matched an existing run starts nothing
        // and writes nothing to it (below).
        ({ run, created } = await deps.runStore.create({
          workflowId: entry.definition.id,
          workflowVersion: entry.definition.version,
          params,
          ...(dedupId !== undefined ? { idempotencyKey: dedupId } : {}),
        }));
      } catch (err) {
        deps.logger.error('webhook: run creation failed', { path, error: String(err) });
        respond(res, 500, { error: 'store_error', status: 'failed' });
        return;
      }

      // 10b. The store matched an existing run by the delivery id, live or ended (issue #735).
      // Compared with `false` by name: a store whose create() gives no `created` is not a match.
      if (created === false) {
        const runPhase = deriveRunPhase(run);
        // F1: the matched run was sealed by a failed start — its agent never ran. The retry gets the
        // first copy's reply again, and nothing is spawned or written. The delivery id is NOT
        // recorded, so every retry keeps reaching the store and keeps getting that reply; a recorded
        // id would answer the next retry `200 deduplicated`.
        if (run.sealed_by?.arm === 'spawn_failure') {
          deps.logger.warn('webhook: deduplicated', {
            path,
            run_id: run.id,
            run_phase: runPhase,
            reason: 'matched_spawn_failed_run',
          });
          const failed = spawnFailedReply(run.id);
          respond(res, failed.status, failed.body);
          return;
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
        // F2: a later delivery under the same id whose MAPPED params differ from the run's — a
        // sender that reuses one id for events whose mapped values change, for one — is said, never
        // dropped without a word: a `warn` line and `params_differ: true` on the reply. Only the
        // mapped params are compared, so an id reused for events that map to the same params (an id
        // taken from a ticket's own id, with that id the only mapped value, for one) is not seen.
        // The run's record is never changed.
        const paramsDiffer = hashParams(params) !== hashParams(run.params);
        const logged = {
          path,
          run_id: run.id,
          run_phase: runPhase,
          reason: 'matched_existing_run',
          ...(paramsDiffer ? { params_differ: true } : {}),
        };
        if (paramsDiffer) deps.logger.warn('webhook: deduplicated', logged);
        else deps.logger.info('webhook: deduplicated', logged);
        respond(res, 200, {
          status: 'deduplicated',
          run_id: run.id,
          run_phase: runPhase,
          ...(paramsDiffer ? { params_differ: true } : {}),
        });
        return;
      }

      // 11. Spawn detached agent.
      // A thrown spawnAgent (contract violation) is funnelled into the same spawn_failed handling
      // below — so the created run is always marked and the response always carries a run_id,
      // never a generic 500 that strands the run unmarked. issue #744: awaited inside the same
      // `try`, so a start Node refuses later, or a rejection, takes the same path.
      let spawnResult: SpawnResult;
      try {
        spawnResult = await deps.spawnAgent(run.id, entry.workflowDir);
      } catch (err) {
        spawnResult = { error: err instanceof Error ? err : new Error(String(err)) };
      }
      if ('error' in spawnResult) {
        // issue #744: `cwd` names the workflow folder — Node's message names only the Node binary.
        deps.logger.error('webhook: spawn failed', {
          path,
          run_id: run.id,
          cwd: entry.workflowDir,
          error: String(spawnResult.error),
        });
        try {
          // issue #367: run-level seal through the ONE bypass-writer chokepoint — it stamps
          // sealed_by {arm: 'spawn_failure'}; the fossil hand-written run_phase is retired (the
          // store write tail derives it) and the field-assignment writer shape is gone.
          await deps.runStore.update(sealRunLevel(run, 'spawn_failure', 'spawn_failed'));
        } catch (err) {
          // issue #367 residual: this catch used to swallow the store's throw anonymously. The
          // seal-integrity boundary throws TYPED codes (STATE_SEAL_*), so log the code explicitly
          // — a writer regression here must not read as a generic spawn bookkeeping failure.
          deps.logger.error('webhook: failed to mark spawn_failed', {
            run_id: run.id,
            error_code: err instanceof WorkflowError ? err.code : undefined,
            error: String(err),
          });
        }
        const failed = spawnFailedReply(run.id);
        respond(res, failed.status, failed.body);
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
 * issue #332 item 3: the webhook dedup store's default base directory — resolved at CALL time
 * (never module load; the #285 class), exported so the `.action` closure below and any future
 * consumer/test can call it without constructing a full `listen` invocation. Previously an inline
 * `process.env['HOME'] ?? '.'` expression in the closure — house-pattern-inconsistent (every other
 * store's default resolves via `homedir()`, matching `JsonFileStore`/`JsonFileReplayStore`),
 * Windows-blind (`HOME` is a POSIX-only env var; Windows sets `USERPROFILE`, so a bare `HOME`
 * check silently falls through to `'.'` on every Windows install), and silently wrote under the
 * CURRENT WORKING DIRECTORY rather than failing loudly when `HOME` was unset for any reason.
 * `homedir()` resolves correctly on both platforms and never returns an empty/undefined value.
 */
export function defaultDedupBase(): string {
  return join(homedir(), '.realm', 'dedup');
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

/**
 * Startup preparation for the routed workflows (fail-fast — any error must abort startup):
 *  - registers each routed workflow ONCE (the per-webhook `workflowStore.register` was removed:
 *    it silently reverted fresher registrations; restart listen after re-registering);
 *  - loads each workflow's project extension modules. NOTE: the modules are imported in the
 *    LISTEN PARENT process here — top-level side effects run in the parent (the cost of
 *    fail-fast). Children re-resolve at spawn via `realm agent --run-id`; their failure branch
 *    writes terminal_reason 'extensions_load_failed' on the run.
 */
export async function prepareListenWorkflows(
  routes: Map<string, WorkflowEntry>,
  deps: Pick<ListenDeps, 'workflowStore' | 'logger'>,
  loadExtensions: typeof loadProjectExtensions = loadProjectExtensions,
): Promise<void> {
  // issue #620 PR-C: a project realm of another version is told once per distinct copy, through
  // listen's own logger (its children are silenced with --no-release-line-advisory).
  const onReleaseLineWarning = onceReleaseLineSink((w) => deps.logger.warn(renderLoaderWarning(w)));
  for (const entry of routes.values()) {
    await deps.workflowStore.register(entry.definition);
    const { manifest } = await loadExtensions(entry.definition, { onReleaseLineWarning });
    if (manifest.modules.length > 0) {
      deps.logger.info('listen: extensions loaded', {
        workflow: entry.definition.id,
        modules: manifest.modules.map((m) => m.resolved),
        adapters: manifest.adapters,
        handlers: manifest.handlers,
        processors: manifest.processors,
      });
    }
  }
}

export interface ListenOptions {
  port: number;
  host: string;
  bodyTimeoutMs: number;
  maxBodyBytes: number;
  maxConcurrent: number;
  /**
   * #744 E2: how long a socket refused before its body was read keeps reading and discarding before
   * it is destroyed. It exists for tests; the CLI does not expose it, and it defaults to 2 s.
   */
  lingerMs?: number;
  /**
   * Issue #291 (Deliverable 4f, Amendment 4): opt-in interval (ms) for the expired-gate sweeper —
   * the USER-CHOSEN always-on enactor (the `realm listen` process becomes the daemon-analogue,
   * launchd-precedent: realm itself still ships no daemon, but a user MAY run `listen` as one).
   * Absent (the default) = the sweeper never runs — byte-identical to pre-#291 `listen` behavior.
   */
  sweepExpiredGatesIntervalMs?: number;
}

/** Per-pass sweep outcome (issue #291) — returned for tests/logging; the CLI action itself only
 *  logs it. */
export interface SweepResult {
  scanned: number;
  enacted: number;
  skipped_unregistered: number;
  skipped_locked: number;
  errors: number;
}

/**
 * issue #719 (B3): the run files the expiry sweeper has already logged, by path — so a damaged file
 * is logged on first sight and again only when its class, size, mtime or way out changes, never
 * once per pass. The listen server makes one and hands it to every pass.
 */
export type SweepSeenFiles = Map<
  string,
  { class: string; size: number | undefined; mtimeMs: number | undefined; repair: string }
>;

/**
 * Logs the run files a sweep pass could not read (issue #719, B3, C2): `warn` for a file not seen
 * before, or changed since, with its way out; one `debug` line with the count when the pass skipped
 * any. Called on EVERY pass, so a file no longer damaged is forgotten even on a pass that skipped
 * none.
 */
async function logSkippedRunFiles(
  logger: Logger,
  unreadable: readonly UnreadableRunFileEntry[],
  seen: SweepSeenFiles | undefined,
): Promise<void> {
  const now = new Set(unreadable.map((u) => u.path));
  if (seen !== undefined) {
    for (const path of [...seen.keys()]) if (!now.has(path)) seen.delete(path);
  }
  for (const entry of unreadable) {
    let size: number | undefined;
    let mtimeMs: number | undefined;
    try {
      const st = await stat(entry.path);
      size = st.size;
      mtimeMs = st.mtimeMs;
    } catch {
      // A file that cannot be stat'ed is compared by its class alone.
    }
    const prior = seen?.get(entry.path);
    // issue #719 (F6.9): its way out too — a copy whose held file changes (missing, then present
    // but damaged) keeps its own bytes, and its last logged advice must not outlive the change.
    const changed =
      prior === undefined ||
      prior.class !== entry.class ||
      prior.size !== size ||
      prior.mtimeMs !== mtimeMs ||
      prior.repair !== entry.repair;
    if (changed) {
      logger.warn('listen: run file skipped by the expiry sweeper', {
        path: entry.path,
        class: entry.class,
        reason: entry.reason,
        repair: entry.repair,
      });
      seen?.set(entry.path, { class: entry.class, size, mtimeMs, repair: entry.repair });
    }
  }
  if (unreadable.length > 0) {
    logger.debug('listen: expiry sweeper skipped run files', { count: unreadable.length });
  }
}

/**
 * Issue #291 (Deliverable 4f, Amendment 4 — the `realm listen` opt-in sweeper): one store-wide
 * scan for expired, enactable gates across EVERY run this store holds (not just the workflows
 * THIS `listen` process has mounted — a gate opened by any process on the same store is
 * enactable). [F7]: listen is reclaim-like — it enacts (unlike reclaim), but NEVER drains
 * finalizers itself (no `ExtensionRegistry` for a workflow this process hasn't mounted) —
 * a terminalizing enactment logs an advisory pointing at `realm run drain --expired` (or plain
 * `drain`) instead. Multi-process safe: races with ANY other enactment point (submit/
 * execute_step/reclaim/drain --expired/another listen process/the attending timer) resolve via
 * the [F1] arm matrix's NOOPs — this function absorbs every refusal silently. Dormant when the
 * store declares no `settleStep` (nothing to enact with — a fast no-op). Pure I/O orchestration,
 * `now`-injectable for deterministic tests.
 */
export async function sweepExpiredGates(
  deps: Pick<ListenDeps, 'runStore' | 'workflowStore' | 'logger'> & {
    sweepSeen?: SweepSeenFiles;
  },
  now: Date = new Date(),
): Promise<SweepResult> {
  const result: SweepResult = {
    scanned: 0,
    enacted: 0,
    skipped_unregistered: 0,
    skipped_locked: 0,
    errors: 0,
  };
  if (deps.runStore.settleStep === undefined) return result;

  // issue #719 (B3): the readable runs are swept; a run file that cannot be read is logged, never
  // allowed to fail the whole pass.
  const { records: runs, unreadable } = await listRunsDiagnosed(deps.runStore);
  await logSkippedRunFiles(deps.logger, unreadable, deps.sweepSeen);
  for (const run of runs) {
    if (run.terminal_state || run.pending_gate === undefined) continue;
    const gate = run.pending_gate;
    // Finding-only (no on_expiry) or no enforce clock at all — nothing this sweep can enact.
    if (gate.expires_at === undefined || gate.on_expiry === undefined) continue;
    if (now.getTime() < new Date(gate.expires_at).getTime()) continue;

    result.scanned += 1;

    // Unregistered-workflow skip arm: this store may hold runs for workflows this `listen`
    // process's own workflowStore has never registered.
    let definition: WorkflowDefinition;
    try {
      definition = await deps.workflowStore.get(run.workflow_id);
    } catch {
      result.skipped_unregistered += 1;
      continue;
    }

    try {
      const outcome = await deps.runStore.settleStep(
        run.id,
        { kind: 'expire_gate', gateId: gate.gate_id },
        definition,
        { now },
      );
      if (outcome.applied) {
        result.enacted += 1;
        // issue #625 PR-2a (D7.7): an expiry that leaves the run open with engine work owed names
        // it — nothing else is attending a run the sweeper just moved on.
        const owedView = outcome.run.terminal_state
          ? undefined
          : describePending(definition, outcome.run, undefined, now);
        // decision C64: an expiry that leaves nothing able to run from here names the steps and the
        // way out — core's lines.
        const cannotGoOn =
          owedView === undefined ? [] : cannotGoOnLines(outcome.run, owedView, definition);
        deps.logger.info('listen: sweeper enacted an expired gate', {
          run_id: run.id,
          gate_id: gate.gate_id,
          disposition: gate.on_expiry,
          ...(owedView?.act !== undefined ? { owed: owedNames(owedView) } : {}),
          ...(cannotGoOn.length > 0 ? { cannot_go_on: cannotGoOn } : {}),
        });
        if (outcome.transitioned) {
          deps.logger.info(
            'listen: the enactment terminalized the run — it may carry pending finalizers; ' +
              "run 'realm run drain --expired' (or plain drain, once terminal) to deliver them " +
              '(the sweeper never drains finalizers itself — no extension registry for an ' +
              'unmounted workflow)',
            { run_id: run.id },
          );
        }
      }
      // Any refusal (already_settled/not_expired/gate_mismatch/run_terminal) is a benign race
      // with another enactment point — silently absorbed, exactly like every other enactment
      // point's own advisory-not-crash posture.
    } catch (err) {
      // ELOCKED catch-and-continue arm: another writer holds this run's lock right now.
      if (err instanceof WorkflowError && err.code === 'STATE_RUN_BUSY') {
        result.skipped_locked += 1;
        continue;
      }
      result.errors += 1;
      deps.logger.error('listen: sweeper failed to enact an expired gate', {
        run_id: run.id,
        gate_id: gate.gate_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
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
  const lingerMs = options.lingerMs ?? DEFAULT_HANDLER_OPTIONS.lingerMs;
  const handler = makeListenHandler(routes, deps, {
    maxConcurrent: options.maxConcurrent,
    maxBodyBytes: options.maxBodyBytes,
    bodyTimeoutMs: options.bodyTimeoutMs,
    lingerMs,
  });
  // #744: the last request handed to the handler on each socket; the 'clientError' listener reads
  // it.
  const lastRequest = new WeakMap<Socket, IncomingMessage>();
  const onRequest = (
    req: IncomingMessage,
    res: ServerResponse,
    via: { continueExpected?: boolean; expectationFailed?: boolean } = {},
  ): void => {
    lastRequest.set(req.socket, req);
    void handler(req, res, via).catch((err) => {
      deps.logger.error('listen: unhandled handler error', { error: String(err) });
      if (!res.headersSent) {
        respond(res, 500, { error: 'internal_error' });
      }
    });
  };
  // #744: the server's own limits.
  //   - `headersTimeout`: the headers must arrive within the body timeout (Node's default allows
  //     about 90 s).
  //   - `requestTimeout`: Node's own default, 5 minutes, unless twice the body timeout plus the
  //     linger plus 1 s is longer. It must be at least the header timeout, or `createServer`
  //     throws. It counts from a request's first byte, so a short one cut the linger of a refusal
  //     that had waited behind a slow reply (#744).
  //   - No idle timeout: every wait except listen's own handling already has a bound (the headers,
  //     the body, a refusal's linger, Node's keep-alive timeout). An idle timeout cut the handling
  //     of an accepted delivery whose run had started, and lost its reply (#744).
  //   - `connectionsCheckingInterval`: Node checks the first two every second.
  //   - `requireHostHeader: false`: an HTTP/1.1 request without `Host` reaches the handler, which
  //     refuses it in listen's form (see `handle`).
  //   - The clamp keeps the value in range.
  const requestTimeoutMs = Math.min(
    Math.max(300_000, options.bodyTimeoutMs * 2 + lingerMs + 1000),
    2_147_483_647,
  );
  const server = createServer(
    {
      headersTimeout: options.bodyTimeoutMs,
      requestTimeout: requestTimeoutMs,
      connectionsCheckingInterval: 1000,
      requireHostHeader: false,
    },
    onRequest,
  );
  // With a 'checkContinue' listener Node no longer answers `Expect: 100-continue` itself: the
  // handler invites the body only after the checks before it (#744).
  server.on('checkContinue', (req, res) => onRequest(req, res, { continueExpected: true }));
  // With a 'checkExpectation' listener Node no longer answers any other `Expect` with its own bare
  // 417 (`_http_server.js:1283-1288` @ v24.21.0): the handler refuses it in listen's form (#744).
  server.on('checkExpectation', (req, res) => onRequest(req, res, { expectationFailed: true }));

  // #744: requests Node cannot read. With a 'clientError' listener Node sends nothing itself
  // (`_http_server.js:1007` @ v24.21.0): listen sends its own JSON refusal, naming the limit where
  // there is one, and logs one line; but never on a connection that still carries a reply of its
  // own (rules 3 and 5 below). The line never carries `err.message` or `err.rawPacket`, nor
  // anything from the request, which was never read (so it has no `path`).
  const clientErrorReply = (code: string): { status: number; payload: Record<string, unknown> } => {
    switch (code) {
      case 'ERR_HTTP_REQUEST_TIMEOUT':
        // Node gives the header timeout and the whole-request timeout one code, so both are named.
        return {
          status: 408,
          payload: {
            error: 'request_timeout',
            headers_timeout_ms: options.bodyTimeoutMs,
            request_timeout_ms: requestTimeoutMs,
          },
        };
      case 'HPE_HEADER_OVERFLOW':
        return {
          status: 431,
          payload: { error: 'header_fields_too_large', max_header_bytes: maxHeaderSize },
        };
      case 'HPE_CHUNK_EXTENSIONS_OVERFLOW':
        return { status: 413, payload: { error: 'chunk_extensions_too_large' } };
      default:
        return { status: 400, payload: { error: 'bad_request' } };
    }
  };
  const failedSockets = new WeakSet<Socket>();
  server.on('clientError', (err, duplex) => {
    const socket = duplex as Socket & { _httpMessage?: ServerResponse | null };
    const code = (err as NodeJS.ErrnoException).code ?? '';
    // 1. A socket error (`ECONNRESET`, `EPIPE`, …) is not a refusal.
    if (!code.startsWith('HPE_') && code !== 'ERR_HTTP_REQUEST_TIMEOUT') {
      socket.destroy();
      return;
    }
    // 2. Once per socket: Node calls this again for every later chunk on a socket whose parser has
    //    failed (`_http_server.js:938`, `:1040` @ v24.21.0).
    if (failedSockets.has(socket)) return;
    failedSockets.add(socket);
    const { status, payload } = clientErrorReply(code);
    const log = (sent: boolean): void => {
      deps.logger.warn('webhook: refused', {
        status,
        ...payload,
        code,
        ...(sent ? {} : { sent: false }),
      });
    };
    // The reply of rules 4 and 7: write it, then close once it is handed to the kernel, or after
    // `lingerMs`.
    const reply = (): void => {
      const body = JSON.stringify(payload);
      const timer = setTimeout(() => socket.destroy(), lingerMs);
      socket.once('finish', () => {
        clearTimeout(timer);
        socket.destroy();
      });
      socket.once('close', () => clearTimeout(timer));
      socket.end(
        `HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nContent-Type: application/json\r\n` +
          `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
      );
      log(true);
    };
    // The reply Node has attached to the socket, if any.
    const pending = socket._httpMessage;
    // 3. The connection is closing after a refusal of listen's: nothing is sent, nothing is logged,
    //    and the socket is left alone. The refusal's own line already covers the connection; a
    //    request after a refusal is not handled, and the handler's guard logs none either; and the
    //    refusal's linger, or Node's own close, bounds the connection.
    if (refusedSockets.has(socket)) return;
    // 4. The request being answered is itself broken (its body broke while the handler reads it):
    //    reply, as Node does. `res.req` is public, and `req.complete` turns true only once that
    //    request's body has fully arrived.
    if (pending != null && pending.req.complete === false && !pending.headersSent) {
      reply();
      return;
    }
    // 5. A reply of listen's is pending or being written: nothing is sent, so the replies already
    //    owed go out in order, and the connection then closes in stages once nothing is pending.
    //    Node's own 'finish' listener on a reply runs first, so `_httpMessage` is already the next
    //    queued reply, or absent. Without this close, a header timeout that fired while a reply was
    //    pending would leave the connection open with no bound: Node reports a header timeout
    //    once, and each trickled byte refreshes its keep-alive timer (#744).
    if (pending != null) {
      const closeWhenDone = (): void => {
        const next = socket._httpMessage;
        if (next != null) {
          next.once('finish', closeWhenDone);
          return;
        }
        if (socket.writable) {
          socket.end();
          setTimeout(() => socket.destroy(), lingerMs);
        }
      };
      pending.once('finish', closeWhenDone);
      // One line, unless the broken message is the body of a request the handler already holds:
      // its body timer then refuses it with 408, which logs the one line.
      if (lastRequest.get(socket)?.complete !== false) log(false);
      return;
    }
    // 6. The connection is ending: nothing can be sent.
    if (!socket.writable) {
      log(false);
      return;
    }
    // 7. Otherwise, reply.
    reply();
  });

  // issue #291 (Deliverable 4f): the opt-in expired-gate sweeper — a coarse setInterval, started
  // only when the operator explicitly requested it. A pass's own errors never crash the server:
  // each run's failure is caught and logged inside the pass, and a pass that throws (its listing
  // failed — issue #719: e.g. the runs folder cannot be read; a damaged run FILE is logged and
  // skipped, never thrown) is caught and logged here. One `sweepSeen` map for the server's life,
  // so a damaged file is logged once until it changes.
  const sweepSeen: SweepSeenFiles = new Map();
  const sweepTimer =
    options.sweepExpiredGatesIntervalMs !== undefined
      ? setInterval(() => {
          sweepExpiredGates({ ...deps, sweepSeen }).catch((err) => {
            deps.logger.error('listen: sweeper pass failed', { error: String(err) });
          });
        }, options.sweepExpiredGatesIntervalMs)
      : undefined;

  let shuttingDown = false;
  const shutdown = (reason: string): Promise<void> => {
    if (shuttingDown) return Promise.resolve();
    shuttingDown = true;
    deps.logger.info('listen: shutting down', { reason });
    if (sweepTimer !== undefined) clearInterval(sweepTimer);
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

/** What listen passes to each `realm agent` it starts (issue #676: an options object, so the
 *  next flag does not change `buildAgentArgv`'s signature again). */
export type AgentArgvOptions = {
  model: string;
  provider?: ProviderName;
  llmTimeoutSeconds?: number;
};

/**
 * The argv a spawned drive is launched with, minus the interpreter and the realm binary.
 *
 * Pure and exported so the passthrough is pinnable without spawning anything: the deps seam that
 * listen's own tests double sits ABOVE this, so nothing else would notice the flag going missing.
 *
 * MODEL FLAGS (issue #676): realm has no default model, so listen ALWAYS passes `--model`. It
 * passes the operator's `--provider` only when one was given; without it the child picks the
 * provider from the API keys it finds, as `realm agent` does.
 *
 * PROVENANCE: a listen-passed value makes the child derive `perAttemptSource: 'flag'` for its
 * in-memory clock, which is true — the operator did set it. That label is never persisted; what
 * the run record carries is the CONSEQUENCE: `declared_per_attempt_ms` present, and a fired
 * ceiling naming `--llm-timeout` as the lever.
 */
export function buildAgentArgv(runId: string, opts: AgentArgvOptions): string[] {
  const argv = ['agent', '--run-id', runId];
  if (opts.provider !== undefined) argv.push('--provider', opts.provider);
  argv.push('--model', opts.model);
  if (opts.llmTimeoutSeconds !== undefined) {
    argv.push('--llm-timeout', String(opts.llmTimeoutSeconds));
  }
  // issue #620 PR-C: listen tells the operator once at startup; a child per webhook would repeat it.
  argv.push('--no-release-line-advisory');
  return argv;
}

/**
 * Start the detached agent for `runId` in `cwd`, and settle only when Node has answered.
 *
 * issue #744: Node reports a `cwd` that is missing (ENOENT) or that the process has no permission
 * to enter (EACCES) as an `'error'` event on the next tick, not as a throw; a start that succeeds
 * emits `'spawn'` on the next tick. With no `'error'` listener, that event ended `realm listen`. So
 * this resolves `{pid}` on `'spawn'`, `{error}` on `'error'` or on a synchronous throw (a `cwd`
 * that is a file, ENOTDIR), and keeps its `'error'` listener for the child's whole life: a later
 * error goes to `onLateError`, and never ends listen. `spawnFn` lets a test hand in a real spawn or
 * a fake child.
 */
export function defaultSpawnAgent(
  runId: string,
  cwd: string,
  opts: AgentArgvOptions,
  onLateError: (err: Error) => void,
  spawnFn: typeof nodeSpawn = nodeSpawn,
): Promise<SpawnResult> {
  return new Promise<SpawnResult>((resolve) => {
    let settled = false;
    const settle = (result: SpawnResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    try {
      const realmBin = process.argv[1] ?? '';
      const child = spawnFn(process.execPath, [realmBin, ...buildAgentArgv(runId, opts)], {
        detached: true,
        stdio: 'inherit',
        cwd,
      });
      child.on('error', (err: Error) => {
        if (!settled) {
          settle({ error: err });
          return;
        }
        onLateError(err);
      });
      child.once('spawn', () => {
        const pid = child.pid;
        settle(
          pid !== undefined
            ? { pid }
            : { error: new Error("Node reported the agent's start without a process id") },
        );
      });
      child.unref();
    } catch (err) {
      settle({ error: err instanceof Error ? err : new Error(String(err)) });
    }
  });
}

/**
 * The spawn listen's request pipeline calls: listen's options mapped, once, to each agent it starts.
 * The command passes its parsed options here unchanged; the WIRED cells test this mapping, and E5
 * (`no-default-model-676.test.ts`) checks that the provider and the timeout the command was given
 * reach the agent.
 *
 * issue #409: the operator's fallback clock reaches every drive listen spawns. The deps SIGNATURE is
 * unchanged — the value is closed over here rather than threaded through it.
 * issue #676: and the model (always) and the provider (when given), the same way.
 * issue #744: an error the agent process reports after it started is logged, never fatal.
 */
export function makeAgentSpawner(
  listenOpts: { model: string; provider?: ProviderName; llmTimeout?: number },
  logger: Logger,
  spawnFn: typeof nodeSpawn = nodeSpawn,
): (runId: string, cwd: string) => Promise<SpawnResult> {
  const agentOpts: AgentArgvOptions = {
    model: listenOpts.model,
    ...(listenOpts.provider !== undefined ? { provider: listenOpts.provider } : {}),
    ...(listenOpts.llmTimeout !== undefined ? { llmTimeoutSeconds: listenOpts.llmTimeout } : {}),
  };
  return (runId, cwd) =>
    defaultSpawnAgent(
      runId,
      cwd,
      agentOpts,
      (err) =>
        logger.error('webhook: agent process error', { run_id: runId, cwd, error: String(err) }),
      spawnFn,
    );
}

function resolveWorkflowFile(input: string): string {
  return input.endsWith('.yaml') || input.endsWith('.yml') ? input : join(input, 'workflow.yaml');
}

/**
 * Commander argParser for `realm listen`'s limit flags (`--body-timeout-ms`, `--max-body-bytes`,
 * `--max-concurrent`; issue #744), in the idiom of `parseLlmTimeout`. A limit is a whole number
 * from 1 to 2147483647: until now `parseInt` took anything, and a `--max-concurrent` that was not a
 * number applied no limit. The upper bound is also the largest timer Node accepts.
 */
export function parseListenLimit(flag: string): (value: string) => number {
  return (value: string): number => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > 2_147_483_647) {
      throw new InvalidArgumentError(`${flag} must be a whole number from 1 to 2147483647.`);
    }
    return n;
  };
}

/**
 * `realm listen` — start a webhook server that turns verified inbound webhooks into Realm runs.
 *
 * Serves plaintext HTTP. TLS termination, rate limiting, and autoscaling are reverse-proxy /
 * serverless concerns and are intentionally NOT handled here — front this with nginx/Caddy/Traefik
 * for public endpoints. The built-in floors (loopback bind, body cap/timeout, header timeout,
 * --max-concurrent) are the only DoS protections independent of proxy hygiene.
 */
export const listenCommand = new Command('listen')
  .description(
    'Start a webhook server that creates runs from inbound webhooks (per each workflow trigger: block)',
  )
  .argument('[workflows...]', 'Workflow files or directories to mount (default: ./workflow.yaml)')
  .option('--port <n>', 'Port to listen on', '3000')
  .option('--host <addr>', 'Host/interface to bind (default loopback)', '127.0.0.1')
  .option(
    '--body-timeout-ms <n>',
    "Max time (ms) for a request's headers, then its body, to arrive",
    parseListenLimit('--body-timeout-ms'),
    5000,
  )
  .option(
    '--max-body-bytes <n>',
    'Max request body size in bytes; a body declared larger is refused unread',
    parseListenLimit('--max-body-bytes'),
    1048576,
  )
  .option(
    '--max-concurrent <n>',
    'Max in-flight requests before 503; also the max refused connections closed in stages at a time',
    parseListenLimit('--max-concurrent'),
    20,
  )
  .option('--dedup-store <kind>', 'Dedup store: file | memory', 'file')
  .option('--log-level <level>', 'Log level: debug | info | warn | error', 'info')
  // issue #676: no Commander default for either. Realm has no default model; `--provider` absent
  // means each child picks the provider from the API key it finds.
  .option(
    '--provider <provider>',
    'LLM provider passed to each realm agent it starts: openai or anthropic (default: the agent chooses from the API key that is set; OpenAI when both are)',
    parseProvider,
  )
  .option(
    '--model <model>',
    'The model passed to each realm agent it starts, as the provider names it. Required.',
  )
  // issue #409. NO Commander default, and here that is not style. A defaulted flag would make
  // listen pass `--llm-timeout 600` to every child, and every spawned drive would then persist
  // `declared_per_attempt_ms: 600000` — a declaration nobody made. Absent flag ⇒ no argv
  // passthrough ⇒ the child derives its own default and the record carries no declared value at
  // all, which is the truth.
  .option(
    '--llm-timeout <seconds>',
    'Per-attempt fallback ceiling for model requests on spawned drives (issue #409). A step ' +
      "that authors its own `llm_timeout_seconds` WINS; this fills in for those that don't. " +
      'No default: absent means each drive uses its own 600s fallback.',
    parseLlmTimeout,
  )
  .option(
    '--sweep-expired-gates <seconds>',
    'OPT-IN (issue #291): store-wide sweep interval (seconds) that enacts expired, enactable ' +
      'gates across every run this store holds. Default OFF — listen never touches gates ' +
      'unless this is set. Never drains finalizers itself — see: realm run drain --expired.',
  )
  .action(
    async (
      workflows: string[],
      opts: {
        port?: string;
        host?: string;
        bodyTimeoutMs?: number;
        maxBodyBytes?: number;
        maxConcurrent?: number;
        dedupStore?: string;
        logLevel?: string;
        sweepExpiredGates?: string;
        llmTimeout?: number;
        provider?: ProviderName;
        model?: string;
      },
    ) => {
      // issue #676: first, before any workflow is loaded, registered or mounted. Every run listen
      // creates is driven by a `realm agent` that refuses without a model. No API key is checked
      // here. Every agent starts with listen's environment, which includes the keys listen loaded
      // from the `.env` of the folder it is started in (or from the file `DOTENV_CONFIG_PATH`
      // names). Those win over a workflow folder's `.env`, which only adds unset keys, unless
      // `DOTENV_CONFIG_OVERRIDE` is set. `DOTENV_CONFIG_OVERRIDE` and `DOTENV_CONFIG_PATH` are read
      // from the environment a process starts with: set in the shell that starts listen, they apply
      // to listen and to every agent; written as a line in the `.env` listen loads, they leave
      // listen's own load alone but apply to every agent, which inherits them. With
      // `DOTENV_CONFIG_PATH` set to a full path in the shell that starts listen, no workflow
      // folder's `.env` reaches the environment (a relative path is read from each agent's own
      // folder; as a line in listen's `.env`, it applies only to the agents). By default a
      // `${secret:NAME}` in `realm.yaml` is read from the `.env` beside it either way; with `env`
      // listed before `dotenv` in `secrets.sources` (or alone), the agent's environment — listen's,
      // plus what its folder's `.env` added — comes first (#748).
      const model = opts.model;
      if (!hasText(model)) {
        console.error(listenModelRefusal(opts.provider));
        process.exit(1);
        return;
      }

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
          inputs.push({ definition, workflowDir: resolve(filePath, '..') });
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
      const dedupBase = defaultDedupBase();
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
        spawnAgent: makeAgentSpawner({ ...opts, model }, logger),
        clock: () => Date.now(),
        logger,
      };

      // Register routed workflows once + load their extension modules — fail-fast on any error.
      try {
        await prepareListenWorkflows(routes, deps);
      } catch (err) {
        console.error(
          `Error: listen startup failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(1);
        return;
      }

      const sweepExpiredGatesSeconds =
        opts['sweepExpiredGates'] !== undefined
          ? parseInt(opts['sweepExpiredGates'], 10)
          : undefined;
      const handle = await startListen(
        routes,
        {
          port: parseInt(opts['port'] ?? '3000', 10),
          host,
          bodyTimeoutMs: opts['bodyTimeoutMs'] ?? 5000,
          maxBodyBytes: opts['maxBodyBytes'] ?? 1048576,
          maxConcurrent: opts['maxConcurrent'] ?? 20,
          ...(sweepExpiredGatesSeconds !== undefined
            ? { sweepExpiredGatesIntervalMs: sweepExpiredGatesSeconds * 1000 }
            : {}),
        },
        deps,
      );

      const addr = handle.server.address() as { port: number } | null;
      logger.info(
        `realm listen on ${host}:${addr?.port ?? opts['port']} — ${routes.size} workflow(s) mounted`,
      );
    },
  );
