// post-once.ts — R1.3 C1: ONE POST of a callback, through a connection that goes only to an address
// the classifier allowed. The URL is matched against the allow-list first; an IP literal is judged
// before any connect; a name is resolved ONCE, inside the `lookup` the request is given, and the whole
// answer is refused when any address of it is refused, so the socket connects to an address that was
// checked while the host name stays the SNI, the certificate's name and `Host`. Its own agent per try,
// TLS verification forced on, no redirect followed, one deadline for connect, TLS and headers, the
// reply body never read. Never throws for a network outcome.
import * as http from 'node:http';
import * as https from 'node:https';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import type { LookupFunction } from 'node:net';
import { networkInterfaces } from 'node:os';
import { classifyAddress, isLoopbackAddress } from './address.js';
import { isIpLiteralHost, matchCallbackEntry, type CallbackLists } from './allow-list.js';
import { deadlineSignal } from '../../agent/gate/slack-call.js';

/** Why a try did not reach a status: the closed words. */
export type PostFailureWord =
  'timeout' | 'connection' | 'redirect' | 'refused_address' | 'not_allowed';

export type PostOutcome =
  | { readonly kind: 'status'; readonly status: number; readonly retryAfterSeconds?: number }
  | { readonly kind: 'failed'; readonly word: PostFailureWord };

/** A name's addresses, as `dns.lookup(host, { all: true })` gives them. */
export type Resolve = (host: string) => Promise<ReadonlyArray<{ address: string; family: number }>>;

export interface PostOnceOptions {
  readonly url: string;
  readonly body: string | Buffer;
  readonly headers: Readonly<Record<string, string>>;
  /** The whole try's deadline, in milliseconds: an integer from 1 to 2,147,483,647. */
  readonly deadlineMs?: number;
  readonly lists: CallbackLists;
  /** The port `realm listen` itself listens on: this machine on it is never a destination. */
  readonly ownPort: number;
  /** For the cells only; neither weakens a production default. */
  readonly seams?: { readonly resolve?: Resolve; readonly tls?: { readonly ca?: string | Buffer } };
}

const MAX_TIMER_MS = 2_147_483_647;
/** The error code the lookup refuses an answer with, so the request's `error` names it. */
const REFUSED_CODE = 'ERR_CALLBACK_REFUSED_ADDRESS';

const defaultResolve: Resolve = (host) =>
  new Promise((resolve, reject) => {
    dnsLookup(host, { all: true }, (err, addresses: LookupAddress[]) => {
      if (err !== null) reject(err);
      else resolve(addresses.map((a) => ({ address: a.address, family: a.family })));
    });
  });

/** Per resolver, the lookups still running, by host name: a try for the same name joins its lookup. */
const inFlight = new WeakMap<Resolve, Map<string, ReturnType<Resolve>>>();

function resolveOnce(resolve: Resolve, host: string): ReturnType<Resolve> {
  let running = inFlight.get(resolve);
  if (running === undefined) {
    running = new Map();
    inFlight.set(resolve, running);
  }
  const joined = running.get(host);
  if (joined !== undefined) return joined;
  const table = running;
  const started = resolve(host).finally(() => table.delete(host));
  table.set(host, started);
  return started;
}

/** This machine's own addresses: the loopback ones, and every interface's (no scope ids). */
function isOwnAddress(address: string): boolean {
  if (isLoopbackAddress(address)) return true;
  const plain = address.startsWith('::ffff:') ? address.slice(7) : address;
  return Object.values(networkInterfaces()).some((list) =>
    (list ?? []).some((i) => i.address === address || i.address === plain),
  );
}

const refusal = (): Error => Object.assign(new Error('refused address'), { code: REFUSED_CODE });

/**
 * The request's `lookup`: the name resolved once (single-flight per name), the WHOLE answer refused
 * when any address is not `vetted`, only vetted addresses given back. Called as `{ all: true }`
 * (autoSelectFamily on, which the request asks for) or, with it off, `{ hints }` alone: both forms
 * are honoured. Exported for its cells only.
 */
export function vettingLookup(
  resolve: Resolve,
  vetted: (address: string) => boolean,
): LookupFunction {
  return (name, opts, cb) => {
    resolveOnce(resolve, name).then(
      (answer) => {
        // Never `cb(null, [])`: it throws inside `node:net` and would crash the process.
        if (answer.length === 0) {
          cb(Object.assign(new Error('no address'), { code: 'ENOTFOUND' }), '');
          return;
        }
        if (!answer.every((a) => vetted(a.address))) {
          cb(refusal(), '');
          return;
        }
        const addresses = answer.map((a) => ({ address: a.address, family: a.family }));
        if (opts.all === true) cb(null, addresses);
        else cb(null, addresses[0]!.address, addresses[0]!.family);
      },
      (err: unknown) => cb(err as NodeJS.ErrnoException, ''),
    );
  };
}

/** `Retry-After` in seconds, only from digits (at most 7); anything else is ignored. */
function retryAfterOf(value: string | string[] | undefined): number | undefined {
  return typeof value === 'string' && /^\d{1,7}$/.test(value) ? Number(value) : undefined;
}

/** One POST of `body` to `url`, through a connection to an address the classifier allowed. */
export function postOnce(options: PostOnceOptions): Promise<PostOutcome> {
  const { url: raw, body, headers, deadlineMs = 10_000, lists, ownPort, seams } = options;
  if (!Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > MAX_TIMER_MS) {
    throw new TypeError(`deadlineMs must be an integer from 1 to ${MAX_TIMER_MS}`);
  }
  if (typeof ownPort !== 'number' || !Number.isInteger(ownPort)) {
    throw new TypeError('ownPort must be an integer');
  }
  const failed = (word: PostFailureWord): Promise<PostOutcome> =>
    Promise.resolve({ kind: 'failed', word });
  const matched = matchCallbackEntry(lists, raw);
  if (!matched.ok) return failed('not_allowed');
  const { url, kind, host, port } = matched;
  const vetted = (address: string): boolean =>
    classifyAddress(address, kind).allowed && !(port === ownPort && isOwnAddress(address));
  const literal = isIpLiteralHost(host);
  if (literal && !vetted(host)) return failed('refused_address');

  const lookup = vettingLookup(seams?.resolve ?? defaultResolve, vetted);

  const secure = url.protocol === 'https:';
  const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  const deadline = deadlineSignal(deadlineMs);
  return new Promise<PostOutcome>((settle) => {
    let done = false;
    const finish = (outcome: PostOutcome): void => {
      if (done) return;
      done = true;
      deadline.clear();
      settle(outcome);
    };
    const common = {
      host,
      port,
      method: 'POST',
      path: `${url.pathname}${url.search}`,
      headers: { ...headers, 'content-length': String(bytes.length) },
      signal: deadline.signal,
      autoSelectFamily: true,
      ...(literal ? {} : { lookup }),
    };
    const onResponse = (res: http.IncomingMessage): void => {
      const status = res.statusCode ?? 0;
      const retryAfter = retryAfterOf(res.headers['retry-after']);
      // The reply body is never read: the connection goes at the status line and headers.
      res.destroy();
      req.destroy();
      if (status >= 300 && status < 400) finish({ kind: 'failed', word: 'redirect' });
      else {
        finish({
          kind: 'status',
          status,
          ...(retryAfter !== undefined ? { retryAfterSeconds: retryAfter } : {}),
        });
      }
    };
    const req = secure
      ? https.request(
          {
            ...common,
            agent: new https.Agent({ keepAlive: false }),
            rejectUnauthorized: true,
            ...(seams?.tls?.ca !== undefined ? { ca: seams.tls.ca } : {}),
          },
          onResponse,
        )
      : http.request({ ...common, agent: new http.Agent({ keepAlive: false }) }, onResponse);
    req.on('error', (err: NodeJS.ErrnoException) => {
      if (deadline.signal.aborted) finish({ kind: 'failed', word: 'timeout' });
      else if (err.code === REFUSED_CODE) finish({ kind: 'failed', word: 'refused_address' });
      else finish({ kind: 'failed', word: 'connection' });
    });
    req.end(bytes);
  });
}
