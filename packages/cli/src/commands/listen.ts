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
//   - SIGTERM/SIGINT → the stop (`graceful-stop.ts`, #960): accept nothing more, end each open
//     connection by its state, give requests being answered `--shutdown-grace` seconds, a second
//     signal cuts everything; exit 0, or 1 when requests were cut. The agent child is detached and
//     survives.
//   - `GET`/`HEAD` `/health` → the health address (`health-address.ts`, #960 U2): 200, or 503 from
//     the first signal; `--shutdown-drain` keeps serving that many seconds before the stop begins;
//     a workflow cannot be mounted at `/health`
//   - `GET`/`HEAD` `<path>/runs/<run id>` → the read address (`run-read-address.ts`, R1.1): for a
//     workflow with `trigger.result_map`, the run's phase and declared result to the holder of the
//     run's code; the same `403` for every refusal (an id that is not a lowercase UUID is no read
//     request: `405`, as before); no `--max-concurrent` slot
//   - a POST that creates a run of such a workflow with `Prefer: wait=N` → held until the run ends,
//     reaches a gate or N seconds pass (`result-wait.ts`, R1.2), within `--max-wait` and
//     `--max-waiting`; it keeps its `--max-concurrent` slot, and the first signal answers it
//   - a POST that names a callback address in `realm-callback-url` → the door (R1.3 C2,
//     `lib/callback/door.ts`): refused with a closed word before anything is made, or registered with
//     its run in one step
import {
  createServer,
  maxHeaderSize,
  STATUS_CODES,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { Socket, type AddressInfo } from 'node:net';
import { spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { Command, InvalidArgumentError } from 'commander';
// issue #409: the SAME parser `realm agent --llm-timeout` uses — never a second copy, so the two
// flags cannot drift on what they accept. The listen→agent edge is one-way and cycle-free.
import { parseLlmTimeout, parseProvider } from './agent.js';
import {
  hasText,
  listenModelRefusal,
  openAiExplicitCacheModel,
  resolveOpenAiEndpoint,
  type ProviderName,
} from '../agent/providers/llm-provider.js';
// issue #600 PR 2: the SAME parser `realm agent --prompt-cache` uses.
import {
  autoFallbackWindowText,
  autoLongText,
  parseCacheDiagnostics,
  parsePromptCache,
  type CacheDiagnosticsSetting,
} from '../agent/prompt-cache.js';
import {
  type PromptCacheSetting,
  type RequestEndpoint,
  loadWorkflowFromFile,
  validateRunParams,
  WorkflowError,
  renderLoaderWarning,
  describePending,
  writtenSnapshot,
  owedNames,
  composeWaysAt,
  deriveRunPhase,
  hashParams,
  isPastDeadline,
  parseStamp,
  persistsField,
  startIdentityEntry,
  realmHomePath,
} from '@sensigo/realm';
import { createCallbackKeySealer } from '@sensigo/realm-store-sqlite';
import { cannotGoOnLines } from './ways-renderer.js';
import type {
  WorkflowDefinition,
  WebhookTrigger,
  TriggerFilter,
  FilterCondition,
  DedupConfig,
  DedupStore,
  RunStore,
  WorkflowRegistrar,
  ExtensionIdentityEntry,
  PendingGate,
  RunRecord,
  DisclosureSet,
  CallbackRegistration,
  CallbackKeyListing,
  CallbackStore,
} from '@sensigo/realm';
import {
  verifyGithub,
  verifyStripe,
  verifyHmac,
  verifySharedSecret,
} from '../lib/webhook-verifiers.js';
import { extractParams, extractDedupId, resolveDotPath } from '../lib/webhook-params.js';
import { InMemoryDedupStore } from '../lib/dedup-store.js';
import { parseHost, parseOneOf, parseWholeNumber } from '../lib/option-parsers.js';
import { bindFailureLine } from '../lib/bind-failure.js';
import { trackConnections, type StopOutcome } from '../lib/graceful-stop.js';
import { answerHealth, HEALTH_PATH, requestPath } from '../lib/health-address.js';
import {
  answerRead,
  deriveReadKey,
  optedIn,
  PhaseCache,
  readEntriesOf,
  readFields,
  readPrefix,
  readRequestOf,
  type ReadContext,
} from '../lib/run-read-address.js';
import { answerWait, parseWaitPreference } from '../lib/result-wait.js';
import { markSignalDeath, type ChildExit } from '../agent/startup-failure.js';
import {
  loadProjectExtensions,
  onceReleaseLineSink,
} from '../extensions/load-project-extensions.js';
import { RUN_PHASE_WORDS, cliDisclosureProvider, writerCtx } from '../output/writer.js';
import { DEPRECATIONS_SAID_ENV, addDeclaredValues } from '../output/writer.js';
import { saidIds } from '@sensigo/realm';
import { openCliHome, type CliHome } from '../lib/home.js';
import type { CallbackLists } from '../lib/callback/allow-list.js';
import { declareMasterKey } from '../lib/callback/declare-master-key.js';
import {
  CALLBACK_HEADER,
  callbackKeyCommand,
  judgeCallbackAddress,
  judgeCallbackKey,
  noKeyFix,
  type CallbackKeyVerdict,
  type CallbackRefusalWord,
} from '../lib/callback/door.js';
import { resolveMasterKey } from '../lib/callback/master-key.js';
import { readAllowFlags } from '../lib/callback/allow-flags.js';
import {
  callbackStartLines,
  listenMasterSummary,
  type ListenMasterSummary,
} from '../lib/callback/start-lines.js';
import { makeCallbackPass } from '../lib/callback/delivery-pass.js';
import {
  REMINDER_POLL_MS,
  makePollRunner,
  reminderSenderOf,
  type PollRunner,
  type ReminderSource,
} from './listen-reminders.js';
// Gap 1, unit A0: the listing that reads no model call's text.
import { scanListedRuns, type ListedRecord } from '@sensigo/realm';

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

/**
 * Result of an agent spawn — a pid on success, or an error to record as spawn_failed. R1.2: with a
 * pid, `exited` (when the spawner gives one) settles once the agent's process has exited. Q1 (#592)
 * unit c: with how it ended, Node's `'exit'` pair — the code, or the signal that killed it.
 */
export type SpawnResult =
  | { pid: number; error?: never; exited?: Promise<ChildExit> }
  | { error: Error; pid?: never; exited?: never };

/** Injected I/O dependencies — everything that touches disk, the clock, or child processes. */
export interface ListenDeps {
  // issue #291 (Deliverable 4f): widened to add 'get' — the sweep loop resolves each expired
  // gate's workflow definition before it can construct an expire_gate delta.
  workflowStore: Pick<WorkflowRegistrar, 'register' | 'get'>;
  // issue #291 (Deliverable 4f): widened to add 'list' (the sweep's own store-scan) + 'settleStep'
  // (the enactment write) — required on `RunStore` since #715 (b).
  // #729 PR-3 correction 5 (J-5): `persistedRunRecordFields` (optional) says whether the start entry
  // can be written.
  // #715 (b) (03 §A.4, D6-8): and the store's `clock` — the instants this server writes and the
  // expiry waits of the sweeper are the store's.
  // R1.1: and `resolveKey` — a repeat of an event inside the duplicate window names its run.
  runStore: Pick<
    RunStore,
    | 'create'
    | 'get'
    | 'update'
    | 'scan'
    | 'settleStep'
    | 'persistedRunRecordFields'
    | 'clock'
    | 'resolveKey'
    // #597 D3b: the ledger `--send-reminders` leases and marks through.
    | 'outbound'
    // #922: whether the store keeps claims (a held step's reclaim way is offered only then).
    | 'persistsClaims'
    // R1.3 C2: the callback rows a request registers, and the keys the door reads.
    | 'callbacks'
  >;
  dedupStoreFor: (workflowId: string) => DedupStore;
  // issue #744: settles once Node has said whether the agent started (`'spawn'`) or not
  // (`'error'`, which for a missing or unenterable folder comes on the next tick, not as a throw).
  spawnAgent: (runId: string, cwd: string) => Promise<SpawnResult>;
  logger: Logger;
  /**
   * R1.1: the disclosure set a completed run's result is walked with, built for each read from the
   * run's own manifest (what the MCP door does). Default: the CLI writer's `cliDisclosureProvider`.
   */
  disclosureProvider?: (definition: WorkflowDefinition, run: RunRecord) => Promise<DisclosureSet>;
  /** #597 D3b: the home folder (the Slack question post files are under it); absent, no sender. */
  home?: string;
  /** R1.3 C2: the callback addresses this server may register; absent or empty, it registers none. */
  callbackLists?: CallbackLists;
  /** R1.3 C2: this process's master key fingerprint, `null` when it has none; absent: unknown. */
  callbackMasterFp?: string | null;
}

/** R1.3 C2: no callback address is allowed until a later unit gives the lists. */
const NO_CALLBACK_LISTS: CallbackLists = { public: [], private: [] };

/**
 * R1.3 C3b2: how often the callback sender looks for due callbacks, in ms. It is the only way a run
 * another process finished is noticed; an agent this process started wakes it when it exits.
 */
export const CALLBACK_POLL_MS = 30_000;

/** A mounted workflow: its definition, trigger, source directory, and pre-resolved secret. */
export interface WorkflowEntry {
  path: string;
  definition: WorkflowDefinition;
  trigger: WebhookTrigger;
  workflowDir: string;
  /** Resolved from env[auth.secret_from] at startup. undefined only for mode 'none'. */
  secret?: string;
  /** #729 PR-3 correction 5 (J-5): the start entry of the project loaded at startup (its registry's
   *  identity, `origin: 'start'`), written into every run this route creates; undefined when the
   *  load carried no identity. */
  startIdentity?: ExtensionIdentityEntry;
  /** R1.1: for a workflow with `trigger.result_map`, the key its read codes are made with, derived
   *  from `secret` by `prepareListenWorkflows`; never stored. Absent, every read is refused. */
  readKey?: Buffer;
  /** #597 D3b: the workflow's resolved `notifiers.slack_gate`, kept at startup for
   *  `--send-reminders`; undefined when its manifest declares none. */
  slackGate?: NonNullable<ReminderSource['slackGate']>;
}

export interface HandlerOptions {
  maxConcurrent: number;
  maxBodyBytes: number;
  bodyTimeoutMs: number;
  /** #744 E2: how long a refused socket keeps reading and discarding before it is destroyed. */
  lingerMs: number;
  /**
   * #960 U2: whether this server is stopping (from the first Ctrl+C or `SIGTERM`), read per request
   * by the health address. `startListen` owns it; absent, the server is never stopping.
   */
  isStopping?: () => boolean;
  /** R1.2: the longest a request that sends `Prefer: wait=N` is held, in seconds; 0 turns it off. */
  maxWaitSeconds: number;
  /** R1.2: how many requests may wait at once; the handler never lets more than `maxConcurrent` − 1. */
  maxWaiting: number;
  /** R1.2: aborted at the first signal (`startListen` owns it); every wait is answered then. */
  stopSignal?: AbortSignal;
  /**
   * R1.2: each wait under way, while it lasts. `startListen`'s stop awaits them before it resolves:
   * a wait the stop cuts ends when its connection closes, a turn after the cut, and logs its line.
   */
  waits?: Set<Promise<void>>;
  /**
   * R1.3 C3b2: called once for each agent this handler started, after that agent's process has
   * exited (never for a spawner that gives no `exited`, nor for a start that failed). `startListen`
   * owns it: it wakes the callback sender, so a finished run's callback goes out at once.
   */
  onAgentExit?: () => void;
}

const DEFAULT_HANDLER_OPTIONS: HandlerOptions = {
  maxConcurrent: 20,
  maxBodyBytes: 1_048_576,
  bodyTimeoutMs: 5000,
  lingerMs: 2000,
  maxWaitSeconds: 25,
  maxWaiting: 5,
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

function respond(
  res: ServerResponse,
  status: number,
  payload: Record<string, unknown>,
  headers: Record<string, string> = {},
): void {
  // #744: every reply carries its length, so a reply to an HTTP/1.0 sender that keeps its
  // connection open does not end it.
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
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
  const isStopping = opts.isStopping ?? (() => false);
  let inFlight = 0;
  // R1.2: the requests waiting now, and how many may: each keeps its `--max-concurrent` slot, so at
  // least one slot is always left for a new event.
  let waiting = 0;
  const waitBudget = Math.min(opts.maxWaiting, opts.maxConcurrent - 1);
  // #744 E2: every socket closing after a refusal, mapped to that refusal's reply and the number of
  // later requests ignored on it; and how many of them linger (close in stages).
  const closingSockets = new WeakMap<Socket, { refusal: ServerResponse; ignored: number }>();
  let lingeringCount = 0;
  // R1.1: the read address of each workflow with `result_map`. The entries are the route table's
  // own, so a key `prepareListenWorkflows` derives later is read at each request.
  const readCtx: ReadContext = {
    entries: readEntriesOf(routes.values()),
    get: (runId) => deps.runStore.get(runId),
    disclosureProvider: deps.disclosureProvider ?? cliDisclosureProvider,
    logger: deps.logger,
    cache: new PhaseCache(),
  };
  // R1.3 C2: the (workflow, host, state, master fingerprint) whose no-key fix this process has said.
  const fixesSaid = new Set<string>();

  /**
   * R1.3 C2 (the door), step 9b: a request that names a callback address is refused (the reply) or
   * may register it (the registration). It reads the stored keys and nothing else.
   */
  const callbackDoor = async (
    entry: WorkflowEntry,
    path: string,
    value: string,
  ): Promise<
    { registration: CallbackRegistration } | { refused: Record<string, unknown> } | 'store_failed'
  > => {
    const workflow = entry.definition.id;
    const callbacks = deps.runStore.callbacks ?? undefined;
    const lists = deps.callbackLists ?? NO_CALLBACK_LISTS;
    if (
      !optedIn(entry) ||
      entry.readKey === undefined ||
      callbacks === undefined ||
      lists.public.length + lists.private.length === 0
    ) {
      deps.logger.warn('webhook: callback not enabled', { path, workflow });
      return { refused: { error: 'callback_not_enabled' } };
    }
    /** A refusal's line: the word and the host label; a no-key fix, when given, the first time. */
    const refused = (
      word: CallbackRefusalWord,
      host: string | undefined,
      fix?: { key: Exclude<CallbackKeyVerdict, { ok: true }>; cmd: string },
    ) => {
      deps.logger.warn(
        `webhook: callback refused (${word})${fix === undefined ? '' : ` — ${noKeyFix(fix.key, deps.callbackMasterFp, writerCtx().cmd(fix.cmd))}`}`,
        { path, workflow, ...(host !== undefined ? { host } : {}) },
      );
      return { refused: { error: 'callback_refused', reason: word } };
    };
    const address = judgeCallbackAddress(lists, value);
    if (!address.ok) return refused(address.word, address.host);
    let key;
    try {
      key = judgeCallbackKey(await callbacks.keys.read(workflow, address.host));
    } catch (err) {
      deps.logger.error('webhook: callback key could not be read', {
        path,
        workflow,
        host: address.host,
        error: String(err),
      });
      return 'store_failed';
    }
    if (!key.ok) {
      // The fix once per state of the pair, so a change of state says its own.
      const said = [workflow, address.host, key.state, key.state === 'none' ? '' : key.master_fp];
      if (fixesSaid.has(said.join('\0'))) return refused('no_key', address.host);
      fixesSaid.add(said.join('\0'));
      return refused('no_key', address.host, {
        key,
        cmd: callbackKeyCommand(entry.workflowDir, address.host),
      });
    }
    return { registration: { url: value, host: address.host, webhook_id: randomUUID() } };
  };

  /**
   * R1.3 C2: what a repeat that carried a callback address is told about the original run's
   * callback: `ignored_duplicate` (it has a row), `none`, or nothing when the row cannot be read.
   */
  const repeatCallback = async (
    runId: string | undefined,
    logged: Record<string, unknown>,
  ): Promise<{ callback?: 'ignored_duplicate' | 'none' }> => {
    const callbacks = deps.runStore.callbacks;
    if (runId === undefined || callbacks === undefined || callbacks === null) {
      return { callback: 'none' };
    }
    try {
      return {
        callback: (await callbacks.read(runId)) !== undefined ? 'ignored_duplicate' : 'none',
      };
    } catch (err) {
      deps.logger.warn('webhook: the callback of a repeated event could not be read', {
        ...logged,
        run_id: runId,
        error: String(err),
      });
      return {};
    }
  };

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

    // #960 U2: the health address (`GET`/`HEAD` `/health`), before the method, path and capacity
    // checks: it takes no signature, does not count toward `--max-concurrent`, is not a refusal
    // (no line, the connection kept), and logs nothing.
    if (answerHealth(req, res, isStopping)) return;

    // R1.1: a read request (`GET`/`HEAD` `<path>/runs/<run id>`), in the same place and on the same
    // terms as the health address; on every path, so an opted-in path cannot be told from another.
    const read = readRequestOf(req);
    if (read !== undefined) {
      await answerRead(req, res, read, readCtx);
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
      // R1.3 C2: the callback address, as one string (a header sent twice arrives joined).
      const callbackValue = headers[CALLBACK_HEADER];

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
          if (await dedupStore.check(dedupId, ttlMs)) {
            deps.logger.debug('webhook: deduplicated', { path });
            // R1.1: the reply names the run the event started, when the store still holds it; a
            // purged or unseen run, a run a failed start sealed (its replies are unchanged), or a
            // read that fails, gets the bare reply as before.
            let named: { run_id: string; run_phase: string } | undefined;
            try {
              const key = await deps.runStore.resolveKey(entry.definition.id, dedupId);
              if (key.state === 'held') {
                const { record } = await deps.runStore.get(key.run_id);
                if (record.sealed_by?.arm !== 'spawn_failure') {
                  named = { run_id: record.id, run_phase: deriveRunPhase(record) };
                }
              }
            } catch {
              named = undefined;
            }
            const told =
              callbackValue === undefined
                ? {}
                : await repeatCallback(named?.run_id, { path, workflow: entry.definition.id });
            respond(
              res,
              200,
              named === undefined
                ? { status: 'deduplicated', ...told }
                : { status: 'deduplicated', ...named, ...readFields(entry, named.run_id), ...told },
            );
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

      // 9b. R1.3 C2 (the door): a request that names a callback address is refused here, before
      // anything is made, or its registration goes into the run's create.
      let registration: CallbackRegistration | undefined;
      if (callbackValue !== undefined) {
        const door = await callbackDoor(entry, path, callbackValue);
        if (door === 'store_failed') {
          respond(res, 500, { error: 'store_error', status: 'failed' });
          return;
        }
        if ('refused' in door) {
          respond(res, 400, door.refused);
          return;
        }
        registration = door.registration;
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
        ({ record: run, created } = await deps.runStore.create({
          workflowId: entry.definition.id,
          workflowVersion: entry.definition.version,
          params,
          ...(dedupId !== undefined ? { idempotencyKey: dedupId } : {}),
          // #729 PR-3 correction 5 (J-5): the route's start entry, written with the record.
          ...(entry.startIdentity !== undefined &&
          persistsField(deps.runStore, 'extension_identity')
            ? { extensionIdentity: [entry.startIdentity] }
            : {}),
          // R1.3 C2: the row is written in the same transaction as the run.
          ...(registration !== undefined ? { callback: registration } : {}),
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
            run_phase: writerCtx().word(runPhase, RUN_PHASE_WORDS),
            reason: 'matched_spawn_failed_run',
          });
          const failed = spawnFailedReply(run.id);
          respond(res, failed.status, failed.body);
          return;
        }
        if (dedupId !== undefined && dedupStore !== undefined) {
          try {
            await dedupStore.record(dedupId, ttlMs);
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
        // #729 PR-3 correction 5 (J-2): the log line's phase is realm's word, spanned inside the print
        // call (the key keeps its place); the HTTP reply's below stays the plain value — it never
        // passes the writer.
        if (paramsDiffer)
          deps.logger.warn('webhook: deduplicated', {
            ...logged,
            run_phase: writerCtx().word(runPhase, RUN_PHASE_WORDS),
          });
        else
          deps.logger.info('webhook: deduplicated', {
            ...logged,
            run_phase: writerCtx().word(runPhase, RUN_PHASE_WORDS),
          });
        respond(res, 200, {
          status: 'deduplicated',
          run_id: run.id,
          run_phase: runPhase,
          ...(paramsDiffer ? { params_differ: true } : {}),
          ...readFields(entry, run.id),
          ...(callbackValue === undefined
            ? {}
            : await repeatCallback(run.id, { path, workflow: entry.definition.id })),
        });
        return;
      }
      if (registration !== undefined) {
        deps.logger.info('webhook: callback registered', {
          path,
          workflow: entry.definition.id,
          host: registration.host,
        });
      }

      // 11. Spawn detached agent.
      // A thrown spawnAgent (contract violation) is funnelled into the same spawn_failed handling
      // below — so the created run is always marked and the response always carries a run_id,
      // never a generic 500 that strands the run unmarked. issue #744: awaited inside the same
      // `try`, so a start Node refuses later, or a rejection, takes the same path.
      let spawnResult: SpawnResult;
      // Q1 (#592) unit c: a startup mark's `elapsed_ms` is measured from here.
      const spawnedAt = performance.now();
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
        // R1.3 C2: the callback row goes FIRST, while the run is live and no sender can claim it; a
        // seal first would leave a moment in which one could send for a request answered 500.
        if (registration !== undefined) {
          try {
            await deps.runStore.callbacks?.deleteAllForRun(run.id);
          } catch (err) {
            deps.logger.error(
              'webhook: failed to remove the callback of a run that did not start',
              {
                run_id: run.id,
                error: String(err),
              },
            );
          }
        }
        try {
          // issue #367: run-level seal through the ONE bypass-writer chokepoint (`sealRunLevel`) — it
          // stamps sealed_by {arm: 'spawn_failure'}. #715 (b) (D-21): through the `seal_run`
          // settlement delta, so the seal's instant is the write's own reading; a run that moved
          // since this webhook created it is thrown as STATE_SNAPSHOT_MISMATCH and logged below, as
          // update() threw. No definition (Amendment 1).
          await deps.runStore.settleStep(run.id, {
            kind: 'seal_run',
            arm: 'spawn_failure',
            reason: 'spawn_failed',
            expected_version: run.version,
            release_claims: false,
          });
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
      // R1.3 C3b2: the agent's exit wakes the callback sender (`exited` never rejects); the catch
      // keeps a throwing hook out of the handler.
      const onExit = opts.onAgentExit;
      if (onExit !== undefined && spawnResult.exited !== undefined) {
        void spawnResult.exited.then(onExit).catch(() => {});
      }

      // Record agent pid/started_at (non-critical metadata), then the dedup record.
      // Q1 (#592) unit c: the record of listen's own last write to the run is the baseline its startup
      // mark compares against — the one this write returns (it bumps the version), or the created run
      // when it failed.
      let baseline: RunRecord = { ...run };
      try {
        run.agent_pid = spawnResult.pid;
        // #715 (b) (03 §A.4): the store's clock, as every instant a run record holds.
        run.agent_started_at = deps.runStore.clock.now().toISOString();
        baseline = (await deps.runStore.update(run)).record;
      } catch (err) {
        deps.logger.error('webhook: failed to record agent pid', {
          run_id: run.id,
          error: String(err),
        });
      }
      // Q1 (#592) unit c: a child killed by a SIGNAL before it wrote anything to the run leaves a
      // startup mark (one compare-and-set write of the baseline; an exit code is never marked). The
      // write joins `waits`, so a stop awaits it; a child whose end reaches listen after the stop has
      // resolved is not marked, because listen has exited.
      if (spawnResult.exited !== undefined) {
        void spawnResult.exited.then((exit) => {
          const write = markSignalDeath(deps.runStore, deps.logger, baseline, exit, spawnedAt);
          opts.waits?.add(write);
          void write.finally(() => opts.waits?.delete(write));
        });
      }
      if (dedupId !== undefined && dedupStore !== undefined) {
        try {
          await dedupStore.record(dedupId, ttlMs);
        } catch (err) {
          deps.logger.error('webhook: failed to record dedup id', {
            run_id: run.id,
            error: String(err),
          });
        }
      }

      deps.logger.info('webhook: dispatched', { path, run_id: run.id, pid: spawnResult.pid });
      // 12. Accepted. R1.1: a workflow with `result_map` also says where, and with what code, to read
      // the run; without its key (never derived) it says nothing more, as an un-opted one.
      const read = readFields(entry, run.id);
      if (read.status_path !== undefined) {
        const location = read.status_path;
        const accepted = (runPhase: string, extra: Record<string, string> = {}): void =>
          respond(
            res,
            202,
            {
              run_id: run.id,
              status: 'accepted',
              run_phase: runPhase,
              ...read,
              ...(registration !== undefined ? { callback: 'registered' } : {}),
            },
            { Location: location, 'Retry-After': '5', ...extra },
          );
        // R1.2: `Prefer: wait=N` is honoured only here, on the request that created the run, while
        // the server is not stopping, a waiting place is free and the caller is still there.
        const asked = parseWaitPreference(req.headers.prefer);
        if (
          asked !== undefined &&
          opts.maxWaitSeconds > 0 &&
          !isStopping() &&
          waiting < waitBudget &&
          !res.destroyed &&
          !req.socket.destroyed
        ) {
          waiting += 1;
          const ended = answerWait({
            req,
            res,
            entry,
            runId: run.id,
            seconds: Math.min(asked, opts.maxWaitSeconds),
            read: async () => (await deps.runStore.get(run.id)).record,
            ...(spawnResult.exited !== undefined ? { exited: spawnResult.exited } : {}),
            ...(opts.stopSignal !== undefined ? { stopSignal: opts.stopSignal } : {}),
            disclosureProvider: readCtx.disclosureProvider,
            accepted,
            logger: deps.logger,
            path,
          });
          opts.waits?.add(ended);
          try {
            await ended;
          } finally {
            opts.waits?.delete(ended);
            waiting -= 1;
          }
        } else {
          accepted('running');
        }
      } else {
        respond(res, 202, { run_id: run.id, status: 'accepted' });
      }
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
 *  - a workflow at `/health` (the health address's path) throws, then a path collision across
 *    workflows throws;
 *  - every referenced secret env var is resolved now (missing → throws);
 *  - `auth.mode === 'none'` emits a prominent warning.
 */
export function buildRouteTable(
  inputs: Array<{ definition: WorkflowDefinition; workflowDir: string }>,
  deps: { env: Record<string, string | undefined>; logger: Logger },
): Map<string, WorkflowEntry> {
  const routes = new Map<string, WorkflowEntry>();
  // R1.1: the read address prefix of each workflow with `result_map`, and whose it is.
  const readPrefixes = new Map<string, string>();
  for (const { definition, workflowDir } of inputs) {
    const trigger = definition.trigger;
    if (trigger === undefined) {
      deps.logger.info('listen: workflow has no trigger block — not mounted', {
        workflow: definition.id,
      });
      continue;
    }
    const path = trigger.path ?? `/${definition.id}`;
    // #960 U2: the health address's path is listen's own; checked before the collision.
    if (path === HEALTH_PATH) {
      throw new Error(
        `listen: path '${HEALTH_PATH}' is reserved for the health address — workflow '${definition.id}' cannot use it; give it another trigger.path`,
      );
    }
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
      // #729 PR-3 (D3/08 m9): the webhook's secret is declared, not only swept.
      addDeclaredValues({ [`webhook:${auth.secret_from}`]: value });
    }

    // R1.1: two workflows with `result_map` whose paths differ only by trailing slashes would share
    // one read address.
    if (trigger.result_map !== undefined) {
      const prefix = readPrefix(path);
      const other = readPrefixes.get(prefix);
      if (other !== undefined) {
        throw new Error(
          `listen: the read address '${prefix}/runs/<run id>' is taken twice — workflow '${definition.id}' conflicts with '${other}'; give each workflow with a result_map its own trigger.path`,
        );
      }
      readPrefixes.set(prefix, definition.id);
      if (secret !== undefined && secret.length < 16) {
        deps.logger.warn(
          `listen: the secret for workflow '${definition.id}' has fewer than 16 characters; a read code made from it can be guessed offline from one captured code. Use a longer secret.`,
        );
      }
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
  deriveKey: typeof deriveReadKey = deriveReadKey,
): Promise<void> {
  // R1.1: each read key is about 100 ms of scrypt, so all of them are started at once, off the
  // event loop, and awaited below, before the server listens.
  const keys = Promise.all(
    [...routes.values()]
      .filter((entry) => optedIn(entry) && entry.secret !== undefined)
      .map(async (entry) => {
        entry.readKey = await deriveKey(entry.secret!, entry.definition.id);
      }),
  );
  // Awaited at the end; a start that fails before then must not leave its rejection unhandled.
  keys.catch(() => undefined);
  // issue #620 PR-C: a project realm of another version is told once per distinct copy, through
  // listen's own logger (its children are silenced with --no-release-line-advisory).
  const onReleaseLineWarning = onceReleaseLineSink((w) => deps.logger.warn(renderLoaderWarning(w)));
  for (const entry of routes.values()) {
    await deps.workflowStore.register(entry.definition);
    const { manifest, registry, notifiers } = await loadExtensions(entry.definition, {
      onReleaseLineWarning,
    });
    // #597 D3b: kept, so `--send-reminders` posts with the settings the workflow's agent would use.
    if (notifiers?.slack_gate !== undefined) entry.slackGate = notifiers.slack_gate;
    // #729 PR-3 correction 5 (J-5): kept, so each run this route creates is born naming its manifest.
    const startIdentity = startIdentityEntry(registry);
    if (startIdentity !== undefined) entry.startIdentity = startIdentity;
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
  await keys;
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
  /** #597 D3b: `--send-reminders` — remind the waiting questions whose posting agent is gone. */
  sendReminders?: boolean;
  /**
   * Issue #960: the seconds requests being answered get to finish after a stop (`--shutdown-grace`);
   * default 30. When they run out, the requests still open are cut.
   */
  shutdownGraceSeconds?: number;
  /**
   * #960 U2: the seconds the program keeps serving after the first signal, with `/health` answering
   * 503, before the stop begins (`--shutdown-drain`); default 0.
   */
  shutdownDrainSeconds?: number;
  /** R1.2: `--max-wait`, in seconds; default 25. */
  maxWaitSeconds?: number;
  /** R1.2: `--max-waiting`; default 5, and never more than `maxConcurrent` − 1. */
  maxWaiting?: number;
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
 * #715 (b) (03 §A.4): carries out one expired gate the sweeper found — the gate's workflow from this
 * process's store, the store's `settleStep` (which decides, at its own reading, that the gate is
 * due), the log lines. Counts into `result`. Refusals (another enactment point won) are absorbed;
 * a run another writer holds is skipped; any other failure is logged and counted.
 */
async function enactSweptGate(
  deps: Pick<ListenDeps, 'runStore' | 'workflowStore' | 'logger'>,
  run: ListedRecord,
  gate: PendingGate,
  result: SweepResult,
): Promise<void> {
  // Unregistered-workflow skip arm: this store may hold runs for workflows this `listen`
  // process's own workflowStore has never registered.
  let definition: WorkflowDefinition;
  try {
    definition = await deps.workflowStore.get(run.workflow_id);
  } catch {
    result.skipped_unregistered += 1;
    return;
  }

  try {
    const outcome = await deps.runStore.settleStep(
      run.id,
      { kind: 'expire_gate', gateId: gate.gate_id },
      definition,
    );
    if (outcome.applied) {
      result.enacted += 1;
      // #729 CW-1b part 2: the write's run, with the lease facts the store attached.
      const written = writtenSnapshot(outcome.run, outcome.at, outcome.lease_facts);
      // issue #625 PR-2a (D7.7): an expiry that leaves the run open with engine work owed names
      // it — nothing else is attending a run the sweeper just moved on.
      const owedView = outcome.run.terminal_state
        ? undefined
        : describePending(definition, written, undefined);
      // decision C64: an expiry that leaves nothing able to run from here names the steps and the
      // way out — the CLI renderer's lines over the ways core composes (#729 PR-0, A-10).
      const cannotGoOn =
        owedView === undefined
          ? []
          : cannotGoOnLines(
              composeWaysAt(outcome.run, outcome.at, {
                definition,
                persistsClaims: deps.runStore.persistsClaims === true,
                lease_facts: written.lease_facts,
              }),
              outcome.run.id,
              deriveRunPhase(outcome.run),
            );
      deps.logger.info('listen: sweeper enacted an expired gate', {
        run_id: run.id,
        gate_id: gate.gate_id,
        disposition: gate.on_expiry,
        ...(owedView !== undefined && owedView.owed.length > 0
          ? { owed: owedNames(owedView) }
          : {}),
        // #729 PR-3 (L-2): the lines with the writer's context, inside the print call.
        ...(cannotGoOn.length > 0
          ? {
              cannot_go_on: cannotGoOnLines(
                composeWaysAt(outcome.run, outcome.at, {
                  definition,
                  persistsClaims: deps.runStore.persistsClaims === true,
                  lease_facts: written.lease_facts,
                }),
                outcome.run.id,
                deriveRunPhase(outcome.run),
                writerCtx(),
              ),
            }
          : {}),
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
      return;
    }
    result.errors += 1;
    deps.logger.error('listen: sweeper failed to enact an expired gate', {
      run_id: run.id,
      gate_id: gate.gate_id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * U3b (#963): what one sweeper pass reads: the open gates that are due at their run's own reading,
 * and the earliest deadline among the open gates that are not due yet. The deadline index (U3a)
 * would replace this one read, not the runner.
 */
export interface SweepRead {
  due: Array<{ run: ListedRecord; gate: PendingGate }>;
  /** The earliest `expires_at` (epoch ms) among the gates not yet due; undefined when none. */
  nextDeadlineMs: number | undefined;
}

/**
 * U3b (#963): the pass's one store read: only the runs waiting at a gate, through the store's `phase`
 * filter (no schema change), every page, each record still judged by itself, because the filter only
 * narrows the read (another store filters on a stored label).
 */
export async function readWaitingGates(
  runStore: Pick<RunStore, 'scan' | 'scanListed'>,
): Promise<SweepRead> {
  const due: SweepRead['due'] = [];
  let nextDeadlineMs: number | undefined;
  // Gap 1, unit A0: listed, so no model call's text is read; each gate is enacted by run id.
  const pages = scanListedRuns(runStore, { phase: 'gate_waiting' }, { pageSize: 1000 });
  for await (const page of pages) {
    for (const item of page.items) {
      if (item.kind !== 'run') continue;
      const { record: run, at } = item.run;
      if (run.terminal_state || run.pending_gate === undefined) continue;
      const gate = run.pending_gate;
      // Finding-only (no on_expiry) or no enforce clock at all: nothing to enact or to wait for.
      if (gate.expires_at === undefined || gate.on_expiry === undefined) continue;
      // #729 PR-0 (A2): core's one due test of a stored deadline — at this row's own reading.
      if (isPastDeadline(gate.expires_at, at)) {
        due.push({ run, gate });
        continue;
      }
      // Not due yet: a candidate for the one waiter. A deadline that does not parse arms nothing.
      const expiresAtMs = parseStamp(gate.expires_at);
      if (
        expiresAtMs !== undefined &&
        (nextDeadlineMs === undefined || expiresAtMs < nextDeadlineMs)
      ) {
        nextDeadlineMs = expiresAtMs;
      }
    }
  }
  return { due, nextDeadlineMs };
}

/** One pass: the read, then each due gate carried out in turn. */
async function sweepOnce(
  deps: Pick<ListenDeps, 'runStore' | 'workflowStore' | 'logger'>,
  read: (runStore: ListenDeps['runStore']) => Promise<SweepRead>,
): Promise<{ result: SweepResult; nextDeadlineMs: number | undefined }> {
  const result = emptySweepResult();
  const { due, nextDeadlineMs } = await read(deps.runStore);
  for (const { run, gate } of due) {
    result.scanned += 1;
    await enactSweptGate(deps, run, gate, result);
  }
  return { result, nextDeadlineMs };
}

/**
 * Issue #291 (Deliverable 4f, Amendment 4 — the `realm listen` opt-in sweeper): one pass over the runs
 * waiting at a gate in this store (not just the workflows THIS `listen` process has mounted — a gate
 * opened by any process on the same store is enactable), carrying out each gate whose time has passed.
 * U3b (#963): it reads only those runs (`readWaitingGates`), and it registers no waiter itself: the
 * runner (`makeSweepRunner`) runs one pass at a time and holds the one waiter on the store's clock.
 * [F7]: listen is reclaim-like — it enacts (unlike reclaim), but NEVER drains finalizers itself (no
 * `ExtensionRegistry` for a workflow this process hasn't mounted) — a terminalizing enactment logs an
 * advisory pointing at `realm run drain --expired` (or plain `drain`) instead. Multi-process safe:
 * races with ANY other enactment point (submit/execute_step/reclaim/drain --expired/another listen
 * process/the attending timer) resolve via the [F1] arm matrix's NOOPs — this function absorbs every
 * refusal silently. #715 (b) (D-26, D6-9, D6-41): each run is judged at its OWN snapshot's reading —
 * no clock is passed in — and the store's own `settleStep` decides, at its reading, that the gate is
 * due; a test sets the store's clock.
 */
export async function sweepExpiredGates(
  deps: Pick<ListenDeps, 'runStore' | 'workflowStore' | 'logger'>,
): Promise<SweepResult> {
  return (await sweepOnce(deps, readWaitingGates)).result;
}

/** U3b (#963): the sweeper's runner, which `startListen` wakes at each interval. */
export interface SweepRunner {
  /**
   * Starts a pass, or, while one runs, asks for exactly one more after it. Resolves once the pass
   * that serves this wake has ended; never rejects.
   */
  wake(): Promise<void>;
  /** The first signal: no further pass, and the waiter cancelled; a running pass arms nothing. */
  stop(): void;
}

/**
 * U3b (#963): one pass at a time, and at most one waiter on the store's clock (`runStore.clock.at`;
 * never a host timer for a stored instant, #715 (b)) at the earliest deadline the last pass saw. The
 * waiter only wakes the runner, so a gate is carried out in one place, from a fresh read. It is
 * replaced or cancelled only by a pass whose whole read succeeded; a pass that throws is logged and
 * leaves it as it was. `read` is the pass's one store read.
 */
export function makeSweepRunner(
  deps: Pick<ListenDeps, 'runStore' | 'workflowStore' | 'logger'>,
  read: (runStore: ListenDeps['runStore']) => Promise<SweepRead> = readWaitingGates,
): SweepRunner {
  let running: Promise<void> | undefined;
  let again = false;
  let stopped = false;
  let waiter: { atMs: number; cancel: () => void } | undefined;
  const arm = (nextDeadlineMs: number | undefined): void => {
    if (stopped || waiter?.atMs === nextDeadlineMs) return;
    waiter?.cancel();
    waiter = undefined;
    if (nextDeadlineMs === undefined) return;
    const armed = { atMs: nextDeadlineMs, cancel: (): void => {} };
    armed.cancel = deps.runStore.clock.at(new Date(nextDeadlineMs), () => {
      if (waiter === armed) waiter = undefined;
      return wake();
    });
    waiter = armed;
  };
  const loop = async (): Promise<void> => {
    do {
      again = false;
      try {
        arm((await sweepOnce(deps, read)).nextDeadlineMs);
      } catch (err) {
        deps.logger.error('listen: sweeper pass failed', { error: String(err) });
      }
    } while (again && !stopped);
    running = undefined;
  };
  const wake = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (running !== undefined) {
      again = true;
      return running;
    }
    running = loop();
    return running;
  };
  return {
    wake,
    stop: () => {
      stopped = true;
      waiter?.cancel();
      waiter = undefined;
    },
  };
}

/**
 * R1.3 C3b2: the callback sender of a server listening on `ownPort`: C3a's pass over `callbacks`, run
 * one pass at a time by the poll runner. Every line the pass says is printed with the `listen: `
 * prefix the start lines have.
 */
function callbackRunnerOf(
  routes: Map<string, WorkflowEntry>,
  deps: ListenDeps,
  callbacks: CallbackStore,
  lists: CallbackLists,
  ownPort: number,
): PollRunner {
  const byWorkflow = new Map([...routes.values()].map((entry) => [entry.definition.id, entry]));
  const prefixed =
    (level: 'info' | 'warn' | 'error') =>
    (msg: string, data?: unknown): void =>
      deps.logger[level](`listen: ${msg}`, data);
  const pass = makeCallbackPass({
    callbacks,
    // As the read address: only the store's own not-found says the run is gone.
    getRun: async (runId) => {
      try {
        return (await deps.runStore.get(runId)).record;
      } catch (err) {
        if (err instanceof WorkflowError && err.code === 'STATE_RUN_NOT_FOUND') return undefined;
        throw err;
      }
    },
    entryOf: (workflowId) => byWorkflow.get(workflowId),
    disclosureProvider: deps.disclosureProvider ?? cliDisclosureProvider,
    lists,
    ownPort,
    logger: { info: prefixed('info'), warn: prefixed('warn'), error: prefixed('error') },
  });
  return makePollRunner(pass, 'callbacks', deps.logger);
}

function emptySweepResult(): SweepResult {
  return { scanned: 0, enacted: 0, skipped_unregistered: 0, skipped_locked: 0, errors: 0 };
}

export interface ListenHandle {
  server: Server;
  shutdown(reason: string): Promise<void>;
}

/** Wires the HTTP server + SIGTERM/SIGINT handlers. Returns a handle whose shutdown() stops the
 *  server (#960: `/health` answers 503 at once, the drain keeps serving for its seconds, then each
 *  open connection is ended by its state and requests being answered get the grace) and resolves
 *  once it has closed; the detached agents survive. */
export function startListen(
  routes: Map<string, WorkflowEntry>,
  options: ListenOptions,
  deps: ListenDeps,
): Promise<ListenHandle> {
  const lingerMs = options.lingerMs ?? DEFAULT_HANDLER_OPTIONS.lingerMs;
  // #960 U2: this server's own stopping state (never a module variable: one process can hold many
  // servers), set in the first signal's turn; the health address reads it per request.
  let stopping = false;
  // R1.2: aborted in the first signal's turn, with the flip above; every wait is answered then.
  const stop = new AbortController();
  const waits = new Set<Promise<void>>();
  // R1.3 C3b2: the callback sender, built once the server listens (below); the handler is built first,
  // so its agent-exit hook reads this reference when it is called.
  let callbackRunner: PollRunner | undefined;
  let callbackTimer: NodeJS.Timeout | undefined;
  const handler = makeListenHandler(routes, deps, {
    maxConcurrent: options.maxConcurrent,
    maxBodyBytes: options.maxBodyBytes,
    bodyTimeoutMs: options.bodyTimeoutMs,
    lingerMs,
    isStopping: () => stopping,
    maxWaitSeconds: options.maxWaitSeconds ?? DEFAULT_HANDLER_OPTIONS.maxWaitSeconds,
    maxWaiting: options.maxWaiting ?? DEFAULT_HANDLER_OPTIONS.maxWaiting,
    stopSignal: stop.signal,
    waits,
    onAgentExit: () => void callbackRunner?.wake(),
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
  // Issue #960: before the server listens, so it sees every connection.
  const tracker = trackConnections(server);
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
  // failed) is caught and logged by the runner. U3b (#963): the interval only wakes the runner, which
  // runs one pass at a time and holds the one waiter on the store's clock; the first pass comes one
  // period after the start.
  const sweepPeriodMs = options.sweepExpiredGatesIntervalMs;
  const sweeper = sweepPeriodMs !== undefined ? makeSweepRunner(deps) : undefined;
  const sweepTimer =
    sweeper !== undefined && sweepPeriodMs !== undefined
      ? setInterval(() => void sweeper.wake(), sweepPeriodMs)
      : undefined;
  // #597 D3b: the opt-in reminder sender — its own runner, never the sweeper's; its first pass and its
  // timer start once the server listens (below).
  const reminders =
    options.sendReminders === true
      ? reminderSenderOf([...routes.values()], {
          runStore: deps.runStore,
          home: deps.home,
          logger: deps.logger,
        })
      : undefined;
  let reminderTimer: NodeJS.Timeout | undefined;

  // Issue #960: the stop. From the first signal `/health` answers 503 (U2); with `--shutdown-drain`
  // the server then goes on serving for that many seconds; then requests being answered get the
  // grace. A second signal cuts everything at once, the drain included. The exit code is 0 when no
  // request was cut, else 1, after one line at level `error`.
  const graceSeconds = options.shutdownGraceSeconds ?? 30;
  const drainSeconds = options.shutdownDrainSeconds ?? 0;
  let stopped: Promise<void> | undefined;
  /** While the drain runs: ends it now and cuts everything (a second signal). */
  let endDrain: (() => void) | undefined;
  /** #597 D3b, R1.3 C3b2: ends the one wait for the reminder and callback passes under way (a second
   *  signal). */
  let endPassWait = (): void => {};
  let cut = 0;
  const shutdown = (reason: string): Promise<void> => {
    if (stopped !== undefined) return stopped;
    stopping = true;
    deps.logger.info('listen: shutting down', { reason });
    if (sweepTimer !== undefined) clearInterval(sweepTimer);
    sweeper?.stop();
    if (reminderTimer !== undefined) clearInterval(reminderTimer);
    if (callbackTimer !== undefined) clearInterval(callbackTimer);
    // #597 D3b: a reminder pass under way starts no new lease or probe; it is waited for at the same
    // time as the grace, and no longer (the drain and the grace from this signal), or until a second
    // signal. R1.3 C3b2: a callback pass under way finishes the row it is on and starts no other;
    // ONE wait covers both passes (a second wait would overwrite `endPassWait`).
    const passesUnderWay = [reminders?.stop(), callbackRunner?.stop()].filter(
      (pass): pass is Promise<void> => pass !== undefined,
    );
    const passWait =
      passesUnderWay.length === 0
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, (drainSeconds + graceSeconds) * 1000);
            endPassWait = () => {
              clearTimeout(timer);
              resolve();
            };
            void Promise.all(passesUnderWay).then(endPassWait);
          });
    // R1.2: the waits too, in this turn and before any drain: none is held through `--shutdown-drain`.
    stop.abort();
    let outcome: Promise<StopOutcome>;
    if (drainSeconds > 0) {
      deps.logger.info('listen: draining', { seconds: drainSeconds });
      outcome = new Promise<StopOutcome>((resolve) => {
        const timer = setTimeout(() => {
          endDrain = undefined;
          resolve(tracker.stop(graceSeconds * 1000));
        }, drainSeconds * 1000);
        endDrain = () => {
          clearTimeout(timer);
          endDrain = undefined;
          resolve(tracker.cutAll());
        };
      });
    } else {
      outcome = tracker.stop(graceSeconds * 1000);
    }
    const connections = outcome.then(async (result) => {
      cut = result.cut;
      if (result.cut > 0) {
        deps.logger.error('listen: shutdown cut requests', {
          cut: result.cut,
          because: result.because,
          grace_seconds: graceSeconds,
        });
      }
      // R1.2: a wait the stop cut ends once its connection has closed; its line comes first.
      await Promise.allSettled([...waits]);
    });
    stopped = Promise.all([connections, passWait]).then(() => undefined);
    return stopped;
  };
  const onSignal = (sig: string): void => {
    if (stopped !== undefined) {
      endPassWait();
      if (endDrain !== undefined) endDrain();
      else void tracker.cutAll();
      return;
    }
    void shutdown(sig).then(() => process.exit(cut > 0 ? 1 : 0));
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
      // #597 D3b: the first reminder pass once the server listens, never before (a failed bind starts
      // none), and nothing when the stop has already begun.
      if (reminders !== undefined && !stopping) {
        void reminders.wake();
        reminderTimer = setInterval(() => void reminders.wake(), REMINDER_POLL_MS);
      }
      // R1.3 C3b2: the callback sender, only with an allow-list flag and a store that keeps callbacks,
      // and not once the stop has begun. Built here, because its own port is the bound one
      // (`--port 0` is accepted). No pass now: a callback due from a previous process would print its
      // line before the start lines; the first pass is the first tick or an agent's exit.
      const callbacks = deps.runStore.callbacks;
      if (deps.callbackLists !== undefined && callbacks != null && !stopping) {
        const ownPort = (server.address() as AddressInfo).port;
        const runner = callbackRunnerOf(routes, deps, callbacks, deps.callbackLists, ownPort);
        callbackRunner = runner;
        callbackTimer = setInterval(() => void runner.wake(), CALLBACK_POLL_MS);
      }
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
  /** Issue #600 PR 2: listen's `--prompt-cache`, only when the operator stated it. */
  promptCache?: PromptCacheSetting;
  /** Caching 3-M (B2b): listen's `--cache-diagnostics`, only when the operator stated it. */
  cacheDiagnostics?: CacheDiagnosticsSetting;
  /** Gap 1, unit A1: `false` when listen was given `--no-record-model-text`. */
  recordModelText?: boolean;
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
 *
 * CACHING (issue #600): a stated `--prompt-cache` is passed on as given; unstated, nothing is
 * passed and the child uses `auto`, which chooses for each step from that step's own earlier runs
 * (caching 3-M D-3: listen measures nothing). `--spawned-by-listen` is always passed, so the child
 * knows listen started it: a step with no earlier run asks for the long lifetime, its runner is
 * recorded as `realm listen`, and a setting its provider cannot apply is disclosed on its start line,
 * never refused.
 */
export function buildAgentArgv(runId: string, opts: AgentArgvOptions): string[] {
  const argv = ['agent', '--run-id', runId];
  if (opts.provider !== undefined) argv.push('--provider', opts.provider);
  argv.push('--model', opts.model);
  if (opts.llmTimeoutSeconds !== undefined) {
    argv.push('--llm-timeout', String(opts.llmTimeoutSeconds));
  }
  if (opts.promptCache !== undefined) argv.push('--prompt-cache', opts.promptCache);
  if (opts.cacheDiagnostics !== undefined) {
    argv.push('--cache-diagnostics', opts.cacheDiagnostics);
  }
  // Gap 1, unit A1: each drive keeps no model text when listen was told so.
  if (opts.recordModelText === false) argv.push('--no-record-model-text');
  argv.push('--spawned-by-listen');
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
 * a fake child. R1.2: `{pid}` also carries `exited`, which settles when the child exits.
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
      // Callback K1: an agent never gets the master key the callback keys are sealed under, nor the
      // path of its file, nor (K2b) the command that prints it; every other variable is kept.
      const {
        REALM_ENCRYPTION_KEY: _masterKey,
        REALM_ENCRYPTION_KEY_FILE: _masterKeyFile,
        REALM_ENCRYPTION_KEY_COMMAND: _masterKeyCommand,
        ...inherited
      } = process.env;
      const child = spawnFn(process.execPath, [realmBin, ...buildAgentArgv(runId, opts)], {
        detached: true,
        stdio: 'inherit',
        cwd,
        // CP-W (W3): the deprecation ids listen has said, so a flag it forwards is warned once per
        // `realm listen`, not once per delivery.
        env: { ...inherited, [DEPRECATIONS_SAID_ENV]: `${process.pid}:${saidIds().join(',')}` },
      });
      // R1.2: made here, at the spawn, so an exit before any wait begins is still seen: a listener
      // added after the child has exited never fires.
      const exited = new Promise<ChildExit>((resolve) =>
        child.once('exit', (code, signal) => resolve({ code, signal })),
      );
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
            ? { pid, exited }
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
 * issue #600 PR 2: and a stated `--prompt-cache`, the same way. Caching 3-M D-3: it measures
 * nothing; each agent's `auto` reads its steps' own earlier runs.
 */
export function makeAgentSpawner(
  listenOpts: {
    model: string;
    provider?: ProviderName;
    llmTimeout?: number;
    promptCache?: PromptCacheSetting;
    cacheDiagnostics?: CacheDiagnosticsSetting;
    recordModelText?: boolean;
  },
  logger: Logger,
  spawnFn: typeof nodeSpawn = nodeSpawn,
): (runId: string, cwd: string) => Promise<SpawnResult> {
  const agentOpts: AgentArgvOptions = {
    model: listenOpts.model,
    ...(listenOpts.provider !== undefined ? { provider: listenOpts.provider } : {}),
    ...(listenOpts.llmTimeout !== undefined ? { llmTimeoutSeconds: listenOpts.llmTimeout } : {}),
    ...(listenOpts.promptCache !== undefined ? { promptCache: listenOpts.promptCache } : {}),
    ...(listenOpts.cacheDiagnostics !== undefined
      ? { cacheDiagnostics: listenOpts.cacheDiagnostics }
      : {}),
    ...(listenOpts.recordModelText === false ? { recordModelText: false } : {}),
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

/**
 * Issue #600 (D2; the lifetime unit) — what listen's startup line says each provider is asked to
 * cache. A child that uses Anthropic asks for the stated setting, or listen's default, `auto` (off,
 * 5 minutes or 1 hour for each step without tools, by that step's own earlier runs and the prices in
 * the runner's price file — #898, caching 3-M D-3; 5 minutes for a step that calls tools); caching 3-B: a child that uses OpenAI sends a cache key (a hint;
 * OpenAI caches by its own rules) as {@link openaiCachingWords} says, by the endpoint it will resolve
 * and the setting it is given. With `--provider`, only that provider's agents are started, so the
 * other is named only as `not used` (Anthropic) or not at all (OpenAI).
 */
export function listenCachingFacts(
  provider: ProviderName | undefined,
  promptCache: PromptCacheSetting | undefined,
  // Caching 3-B (MA 1's wording list): the endpoint each OpenAI agent will resolve (realm listen
  // passes no --base-url, so only OPENAI_BASE_URL can make it custom).
  openaiEndpoint: RequestEndpoint,
  // #896: listen's --model, which every agent it starts is given.
  model: string,
): Record<string, string> {
  if (provider === 'openai') {
    return {
      openai: openaiCachingWords(promptCache, openaiEndpoint, model),
      anthropic: 'not used',
    };
  }
  const words: Record<PromptCacheSetting, string> = {
    auto: "auto: off, 5 minutes or 1 hour for each step without tools, by that step's own earlier runs and the prices in runner.cache.economics; 5 minutes for a step that calls tools",
    short: '5 minutes',
    long: '1 hour',
    off: 'off',
  };
  const anthropic = {
    anthropic: words[promptCache ?? 'auto'],
    set_by: promptCache === undefined ? "realm listen's default" : `--prompt-cache ${promptCache}`,
  };
  return provider === 'anthropic'
    ? anthropic
    : { ...anthropic, openai: openaiCachingWords(promptCache, openaiEndpoint, model) };
}

/**
 * Caching 3-B (D2; MA 1's wording list, 2026-11-05) — what an OpenAI agent `realm listen` starts sends,
 * by the setting it is given (none: the runner's default) and the endpoint it will resolve: on
 * OpenAI's own endpoint the key goes out under every setting but `off`; on a custom endpoint only
 * for a stated setting other than `off`. #896: on GPT-5.6 and later at OpenAI's own address, the
 * agent also asks for 30 minutes, or for nothing under `off`; unit B: under `auto` (or no setting),
 * for 30 minutes or nothing for each step without tools, by its own earlier runs and the price file.
 */
function openaiCachingWords(
  promptCache: PromptCacheSetting | undefined,
  endpoint: RequestEndpoint,
  model: string,
): string {
  if (endpoint === 'default' && openAiExplicitCacheModel(model)) {
    if (promptCache === 'off') return 'off: OpenAI is asked to cache nothing';
    return promptCache === undefined || promptCache === 'auto'
      ? "auto: off or 30 minutes for each step without tools, by that step's own earlier runs and the prices in runner.cache.economics; a cache key, except on a step without tools when off"
      : '30 minutes, the one lifetime Realm can ask OpenAI for, and a cache key';
  }
  if (endpoint === 'custom') {
    if (promptCache === 'off') return 'off: no cache key to the custom endpoint';
    return promptCache === undefined
      ? 'no cache key to the custom endpoint (state --prompt-cache to send one)'
      : 'sends a cache key to the custom endpoint';
  }
  return promptCache === 'off'
    ? "off: no cache key on OpenAI's own endpoint"
    : "sends a cache key on OpenAI's own endpoint";
}

export function resolveWorkflowFile(input: string): string {
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
 * R1.2: `--max-waiting`'s parser. Commander reads each option alone, so the bound that depends on
 * `--max-concurrent` (one less than it) is checked in the action; here a word that is not digits,
 * 0, or a number above 2147483646 (one less than `--max-concurrent`'s largest) is refused with a
 * sentence that names the range as the help does.
 */
export function parseMaxWaiting(value: string): number {
  const n = /^[0-9]+$/.test(value) ? Number(value) : Number.NaN;
  if (!(n >= 1 && n <= 2_147_483_646)) {
    throw new InvalidArgumentError(
      '--max-waiting must be a whole number from 1 to one less than --max-concurrent.',
    );
  }
  return n;
}

/**
 * issue #944: the sweeper's timer delay for `--sweep-expired-gates <seconds>`. The option's parser
 * accepts 1 to 2147483 seconds, so the delay is a whole number of milliseconds below 2^31 − 1, the
 * largest a Node timer holds (above it, or at 0 or NaN, a timer fires about every millisecond).
 */
export function sweepIntervalMs(seconds: number): number {
  return seconds * 1000;
}

/**
 * `realm listen` — start a webhook server that turns verified inbound webhooks into Realm runs.
 *
 * Serves plaintext HTTP. TLS termination, rate limiting, and autoscaling are reverse-proxy /
 * serverless concerns and are intentionally NOT handled here — front this with nginx/Caddy/Traefik
 * for public endpoints. The built-in floors (loopback bind, body cap/timeout, header timeout,
 * --max-concurrent) are the only DoS protections independent of proxy hygiene.
 */
/**
 * R1.3 C2: `realm listen`'s one open of its home. The master key is resolved first (once: a command
 * source runs here, up to 30 seconds, before anything listens); found, it is declared to the writer
 * and seals the home's callback keys; none or invalid, the home opens without a sealer, so every key
 * reads unreadable and every callback address is refused `no_key`. `masterFp` is the sealer's
 * fingerprint, `null` without one.
 */
export async function openListenHome(o: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home?: string;
  /** C2c: whether callbacks are on (an allow-list flag given); absent: on. Off, nothing is resolved. */
  readonly callbacks?: boolean;
}): Promise<{ home: CliHome; masterFp: string | null; master?: ListenMasterSummary }> {
  const at = o.home !== undefined ? { home: o.home } : {};
  const homeDir = realmHomePath(o.home);
  const master = o.callbacks === false ? undefined : resolveMasterKey({ env: o.env, homeDir });
  const summary =
    master === undefined ? {} : { master: listenMasterSummary(master, o.env, homeDir) };
  if (master?.state !== 'found') return { home: await openCliHome(at), masterFp: null, ...summary };
  declareMasterKey(master.key);
  const sealer = createCallbackKeySealer(master.key);
  return { home: await openCliHome({ ...at, sealer }), masterFp: sealer.masterFp, ...summary };
}

/** C2c: one allow-list entry more: the values are kept as typed, in order. */
const collectEntry = (value: string, previous: readonly string[] = []): string[] => [
  ...previous,
  value,
];

export const listenCommand = new Command('listen')
  .description(
    'Start a webhook server that creates runs from inbound webhooks (per each workflow trigger: block)',
  )
  .argument('[workflows...]', 'Workflow files or directories to mount (default: ./workflow.yaml)')
  // issues #944, #949: each of these five options' value is checked when the command line is read
  // (`option-parsers.ts`), so a mistyped value is refused before anything loads or binds.
  .option(
    '--port <n>',
    'Port to listen on: a whole number from 0 to 65535; 0 lets the system pick',
    parseWholeNumber('--port', 0, 65535),
    3000,
  )
  .option(
    '--host <addr>',
    'Host/interface to bind (default loopback)',
    parseHost('--host'),
    '127.0.0.1',
  )
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
  // R1.2: checked when the command line is read; `--max-waiting` against `--max-concurrent` in the
  // action, and only when given (absent, it is derived: the smaller of 5 and one less).
  .option(
    '--max-wait <seconds>',
    'Longest a request that sends Prefer: wait=N is held before it is answered, in seconds, a whole number from 0 to 300; 0 turns waiting off. A workflow without result_map ignores the header.',
    parseWholeNumber('--max-wait', 0, 300),
    25,
  )
  .option(
    '--max-waiting <n>',
    'How many requests may be held waiting at once, a whole number from 1 to one less than --max-concurrent; the default is 5, or one less than --max-concurrent if that is smaller. A waiting request keeps its place among --max-concurrent.',
    parseMaxWaiting,
  )
  .option(
    '--dedup-store <kind>',
    "Dedup store: file (kept in the home's store across restarts) | memory (this process only)",
    parseOneOf('--dedup-store', ['file', 'memory']),
    'file',
  )
  .option(
    '--log-level <level>',
    'Log level: debug | info | warn | error',
    parseOneOf('--log-level', ['debug', 'info', 'warn', 'error']),
    'info',
  )
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
  // issue #600 PR 2: no Commander default. Unstated, nothing is passed and each child uses
  // listen's default (`auto`), recorded as `runner_default`.
  .option(
    '--prompt-cache <setting>',
    // eslint-disable-next-line no-restricted-syntax -- help prose naming the setting, not a command to copy (#729 PR-3, L-2); #898: its numbers come from the provider's constants.
    `Passed to each realm agent it starts: auto, short, long or off. auto (the default): each agent asks Anthropic for off, 5 minutes or 1 hour for each step without tools, by that step's own earlier runs, priced from runner.cache.economics (with no usable prices: ${autoLongText()} when a recent gap is under ${autoFallbackWindowText()}, else off); a step that calls tools asks for 5 minutes. short: Anthropic's 5 minutes. long: Anthropic's 1 hour. off: nothing. With \`--provider openai\`, Realm sends a cache key, a hint: to OpenAI's own endpoint under every setting but \`off\`, and to another endpoint only for a setting you state other than \`off\`. On GPT-5.6 and later at OpenAI's own address, the agent also asks OpenAI to cache the fixed part of each step without tools for 30 minutes (under \`auto\`, 30 minutes or no caching for each step without tools, by that step's own earlier runs and the prices in runner.cache.economics; without usable prices, 30 minutes when a recent gap is under 27 minutes), and \`off\` turns OpenAI's caching off. Other providers' own caching applies.`,
    parsePromptCache,
  )
  // Caching 3-M (B2b): passed on only when stated, so an unstated flag leaves each child's argv as it was.
  .option(
    '--cache-diagnostics <on|off>',
    "Whether to ask Anthropic why a request missed the cache: on or off. On by default at Anthropic's own address, for a request marked for caching. Each request that asks leaves a short-lived fingerprint of what it sent at Anthropic. Passed to each `realm agent` it starts.",
    parseCacheDiagnostics,
  )
  // Gap 1, unit A1: Commander's negated flag, passed to each `realm agent` it starts when given.
  .option(
    '--no-record-model-text',
    "Do not keep the text of each model call on the run's record. The step notes that recording was off. Passed to each `realm agent` it starts.",
  )
  .option(
    '--sweep-expired-gates <seconds>',
    'OPT-IN (issue #291): store-wide sweep interval, a whole number of seconds from 1 to 2147483, ' +
      'that enacts expired, enactable gates across every run this store holds. Default OFF — ' +
      'listen carries out no expired gate unless this is set (--send-reminders only posts ' +
      'reminders). Never drains finalizers itself — see: realm run drain --expired.',
    parseWholeNumber('--sweep-expired-gates', 1, 2_147_483),
  )
  // #597 D3b: a boolean, off by default.
  .option(
    '--send-reminders',
    "OPT-IN (issue #597): every 60 seconds, post the due Slack reminder or escalation of each waiting question whose realm agent has stopped, into the question's own thread, with the bot token and channel the workflow's notifiers.slack_gate carries. Default OFF.",
  )
  // issue #960: checked when the command line is read, like the five above.
  .option(
    '--shutdown-grace <seconds>',
    'Seconds that requests being answered get to finish after Ctrl+C or SIGTERM, a whole number from 0 to 2147483. When it runs out they are cut and the exit code is 1; 0 cuts them at once.',
    parseWholeNumber('--shutdown-grace', 0, 2_147_483),
    30,
  )
  // R1.3 C2c: the allow-list, repeatable, read in the action with C1's grammar; a flag typed as the
  // next word is refused by the option-value guard.
  .option(
    '--callback-allow <entry>',
    'A receiver a request may name as its callback address, reached on a public address: a host name, with a port if it is not 443 (http:// before it for plain http). Repeatable. Without this flag or --callback-allow-private, every callback address is refused.',
    collectEntry,
  )
  .option(
    '--callback-allow-private <entry>',
    'A receiver a request may name as its callback address that may also be on a private, local or shared address (this machine, your own network). Repeatable.',
    collectEntry,
  )
  // #960 U2: checked when the command line is read, like `--shutdown-grace`.
  .option(
    '--shutdown-drain <seconds>',
    'Seconds the program keeps serving, with /health answering 503, after Ctrl+C or SIGTERM before the stop begins and it stops accepting connections; a whole number from 0 to 2147483. 0 begins the stop at once.',
    parseWholeNumber('--shutdown-drain', 0, 2_147_483),
    0,
  )
  .action(
    async (
      workflows: string[],
      opts: {
        port?: number;
        host?: string;
        bodyTimeoutMs?: number;
        maxBodyBytes?: number;
        maxConcurrent?: number;
        maxWait?: number;
        maxWaiting?: number;
        dedupStore?: 'file' | 'memory';
        logLevel?: string;
        sweepExpiredGates?: number;
        sendReminders?: boolean;
        shutdownGrace?: number;
        shutdownDrain?: number;
        llmTimeout?: number;
        provider?: ProviderName;
        model?: string;
        promptCache?: PromptCacheSetting;
        cacheDiagnostics?: CacheDiagnosticsSetting;
        recordModelText?: boolean;
        callbackAllow?: string[];
        callbackAllowPrivate?: string[];
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
      // R1.2: a `--max-waiting` given must leave one `--max-concurrent` place for a new event; a
      // derived one never is refused. Before any workflow is loaded or the home is opened.
      const maxConcurrent = opts.maxConcurrent ?? 20;
      if (opts.maxWaiting !== undefined && opts.maxWaiting >= maxConcurrent) {
        console.error(
          maxConcurrent === 1
            ? 'Error: --max-concurrent is 1, so no request can wait and still leave a place for a new event. Remove --max-waiting, or raise --max-concurrent.'
            : `Error: --max-waiting ${opts.maxWaiting} must be below --max-concurrent ${maxConcurrent}: a request that waits keeps one of its places, and this many waiting could leave none for a new event. Give --max-waiting a number from 1 to ${maxConcurrent - 1}, or raise --max-concurrent.`,
        );
        process.exit(1);
        return;
      }
      // R1.3 C2c: the allow-list flags, read before any workflow is loaded or the home opened; the
      // first refused entry is the only one said. Without either flag nothing below changes.
      const allowed =
        opts.callbackAllow === undefined && opts.callbackAllowPrivate === undefined
          ? undefined
          : readAllowFlags(opts.callbackAllow ?? [], opts.callbackAllowPrivate ?? []);
      if (allowed !== undefined && 'refusal' in allowed) {
        console.error(allowed.refusal);
        process.exit(1);
        return;
      }
      const callbackLists = allowed?.lists;
      // caching 3-B (row 5): `--prompt-cache` with `--provider openai` is no longer refused: the
      // setting decides whether each agent sends OpenAI its cache key.

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
      const maxWait = opts.maxWait ?? 25;
      if (maxWait > 0 && maxConcurrent === 1 && [...routes.values()].some((e) => optedIn(e))) {
        logger.warn(
          'listen: --max-concurrent is 1, so a request that asks to wait is answered at once.',
        );
      }

      const dedupKind = opts['dedupStore'] ?? 'file';
      // #616 PR-2a (iii): the one door, opened once, after every refusal above; its dedup marks are
      // rows in the home's store (`--dedup-store memory` keeps its in-memory map).
      const { home, masterFp, master } = await openListenHome({
        env: process.env,
        callbacks: callbackLists !== undefined,
      });
      const memoryStores = new Map<string, DedupStore>();
      const deps: ListenDeps = {
        workflowStore: home.workflowStore,
        runStore: home.runStore,
        dedupStoreFor: (workflowId: string): DedupStore => {
          if (dedupKind === 'memory') {
            let s = memoryStores.get(workflowId);
            if (s === undefined) {
              s = new InMemoryDedupStore();
              memoryStores.set(workflowId, s);
            }
            return s;
          }
          return home.dedupStoreFor(workflowId);
        },
        spawnAgent: makeAgentSpawner({ ...opts, model }, logger),
        logger,
        home: home.path,
        callbackMasterFp: masterFp,
        ...(callbackLists !== undefined ? { callbackLists } : {}),
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

      const sweepExpiredGatesSeconds = opts['sweepExpiredGates'];
      // issue #949: a failure to listen (the port in use, permission denied, an address that is not
      // this machine's, a name that does not resolve) is one line naming the host and the port, in
      // place of a stack; any other error propagates as before.
      let handle: ListenHandle;
      try {
        handle = await startListen(
          routes,
          {
            port: opts.port ?? 3000,
            host,
            bodyTimeoutMs: opts['bodyTimeoutMs'] ?? 5000,
            maxBodyBytes: opts['maxBodyBytes'] ?? 1048576,
            maxConcurrent,
            maxWaitSeconds: maxWait,
            ...(opts.maxWaiting !== undefined ? { maxWaiting: opts.maxWaiting } : {}),
            ...(sweepExpiredGatesSeconds !== undefined
              ? { sweepExpiredGatesIntervalMs: sweepIntervalMs(sweepExpiredGatesSeconds) }
              : {}),
            ...(opts.sendReminders === true ? { sendReminders: true } : {}),
            ...(opts.shutdownGrace !== undefined
              ? { shutdownGraceSeconds: opts.shutdownGrace }
              : {}),
            ...(opts.shutdownDrain !== undefined
              ? { shutdownDrainSeconds: opts.shutdownDrain }
              : {}),
          },
          deps,
        );
      } catch (err) {
        const line = bindFailureLine(err, host, opts.port ?? 3000);
        if (line === undefined) throw err;
        console.error(line);
        process.exit(1);
        return;
      }

      // issue #600 PR 2 (D2): what each provider's agents are asked to cache.
      // Caching 3-B: the endpoint the OpenAI agents will resolve (nothing is sent to read it).
      const openaiEndpoint: RequestEndpoint =
        opts.provider === 'anthropic' ? 'default' : await resolveOpenAiEndpoint();
      logger.info(
        'listen: caching',
        listenCachingFacts(opts.provider, opts.promptCache, openaiEndpoint, model),
      );
      // R1.3 C2c: what is on, with callbacks only (`start-lines.ts`): each line printed here, a
      // pair with no usable key with its command built inside the print call.
      if (callbackLists !== undefined && master !== undefined) {
        let keys: { listing: readonly CallbackKeyListing[] } | { error: string } | undefined;
        if (master.state !== 'invalid') {
          try {
            keys = { listing: (await home.runStore.callbacks?.keys.list()) ?? [] };
          } catch (err) {
            keys = { error: err instanceof Error ? err.message : String(err) };
          }
        }
        const lines = callbackStartLines({
          lists: callbackLists,
          master,
          workflows: [...routes.values()].map((e) => ({
            id: e.definition.id,
            folder: e.workflowDir,
            takes: optedIn(e),
          })),
          ...(keys !== undefined ? { keys } : {}),
        });
        for (const line of lines) {
          if (line.kind === 'no_key') {
            deps.logger.warn(
              `listen: callbacks: ${line.workflow} → ${line.label}: ${noKeyFix(line.verdict, masterFp, writerCtx().cmd(callbackKeyCommand(line.folder, line.label)))}`,
            );
          } else if (line.level === 'warn') {
            deps.logger.warn(`listen: callbacks: ${line.text}`);
          } else {
            deps.logger.info(`listen: callbacks: ${line.text}`);
          }
        }
      }
      const addr = handle.server.address() as { port: number } | null;
      logger.info(
        // eslint-disable-next-line no-restricted-syntax -- prose naming the listener and its address, not a command to copy (#729 PR-3, L-2).
        `realm listen on ${host}:${addr?.port ?? opts['port']} — ${routes.size} workflow(s) mounted`,
      );
    },
  );
