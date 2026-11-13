// graceful-stop.ts — issue #960: how `realm serve` and `realm listen` stop on Ctrl+C or SIGTERM.
//
// `server.close()` alone stops accepting and then waits for every open connection, and Node ends by
// itself only a connection that finished a request and is waiting for the next. One connection that
// had sent nothing kept either program running until it was killed. The tracker below knows every
// connection the server accepted and, at the stop, ends each one by its state:
//   - waiting between requests (it finished one, none is being answered; also one that has begun
//     the headers of its next request, which Node's own idle test misses): ended at once;
//   - young (no request received yet, silent or partway through its first headers): kept until
//     `youngMs` (5 s) after it was accepted, never past the grace, then ended; a request that
//     arrives on it in that time is answered like one in flight;
//   - in flight (a request's headers received, its response not finished): left alone until the
//     grace ends. Every answer whose head is written after the stop carries `Connection: close`, so
//     Node ends the connection once the answer is written; an answer whose head was written before
//     the stop is changed by nothing, and its connection is ended the moment it finishes;
//   - a held stream (a `GET` answered with `Content-Type: text/event-stream`, the notification
//     stream an MCP client opens and holds): ended at once, and not a cut request.
// When the grace ends, or on `cutAll()` (a second signal), everything still open is destroyed, and
// each response not finished on it counts as cut. A `cutAll()` before `stop()` (a second signal
// during `--shutdown-drain`, #960 U2) begins the stop with no grace, and its cause is the signal.
// A client that hangs up ends its own request: that is not a cut, so the count is read when the
// stop destroys, never from close events.
//
// The tracker observes the server's events by wrapping its `emit`, passing every event through
// unchanged: it adds no listener of its own, because a `checkContinue` or `checkExpectation`
// listener changes what Node does with `Expect` (with one, Node no longer answers `100 Continue`
// itself). It must be attached before the server listens, so that it sees every connection.
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';

/** How long a connection that has sent no request yet is kept after it was accepted (Go's 5 s). */
export const YOUNG_WINDOW_MS = 5000;

/** What ended the requests still open: the grace running out, or a second signal. */
export type StopCause = 'grace_ran_out' | 'second_signal';

export interface StopOutcome {
  /** The requests the stop destroyed before their response finished. */
  readonly cut: number;
  /** What destroyed what was left; undefined when everything ended by itself. */
  readonly because: StopCause | undefined;
}

export interface ConnectionTracker {
  /**
   * Stops the server: it accepts no connection from now on, and each open one is ended by its state
   * (the file's header). Resolves once the server has closed and every connection has gone. Called
   * once; a later call returns the same promise.
   */
  stop(graceMs: number): Promise<StopOutcome>;
  /**
   * A second signal: destroys everything still open now, cause `second_signal`, and returns the
   * stop's promise. Before `stop()` (a second signal during a drain) it begins the stop, with no
   * grace.
   */
  cutAll(): Promise<StopOutcome>;
}

/** One connection the server accepted. */
interface Conn {
  readonly socket: Socket;
  /** `performance.now()` when it was accepted. */
  readonly acceptedAt: number;
  /** Requests whose headers arrived on it. */
  requests: number;
  /** Its requests in flight: headers received, response not finished. */
  readonly inFlight: Set<ServerResponse>;
  /** The held stream it carries, if any. */
  held: ServerResponse | undefined;
  /** Ends it when its young window closes (set only during the stop). */
  youngTimer: NodeJS.Timeout | undefined;
}

/** The headers argument of a `writeHead` call: after the status code, or after the status message. */
function headersIndex(args: unknown[]): number {
  return typeof args[1] === 'string' ? 2 : 1;
}

const isConnection = (key: unknown): boolean => String(key).toLowerCase() === 'connection';

/** The response's `Content-Type`, from the call's headers (any of their three forms) or its own. */
function contentTypeOf(res: ServerResponse, args: unknown[]): string {
  const headers = args[headersIndex(args)];
  let value: unknown;
  if (Array.isArray(headers)) {
    const pairs: unknown[][] = Array.isArray(headers[0])
      ? (headers as unknown[][])
      : Array.from({ length: Math.floor(headers.length / 2) }, (_, i) => [
          headers[2 * i],
          headers[2 * i + 1],
        ]);
    value = pairs.find(([key]) => String(key).toLowerCase() === 'content-type')?.[1];
  } else if (headers !== null && typeof headers === 'object') {
    const key = Object.keys(headers).find((k) => k.toLowerCase() === 'content-type');
    value = key === undefined ? undefined : (headers as Record<string, unknown>)[key];
  }
  if (value === undefined) value = res.getHeader('content-type');
  return String(Array.isArray(value) ? value[0] : (value ?? '')).toLowerCase();
}

/**
 * The same `writeHead` arguments with any `Connection` header replaced by `Connection: close`, in
 * the form the caller used: an object, an array of pairs or a flat array; with no headers given, a
 * `Connection` set earlier with `setHeader` is replaced instead. The MCP SDK writes
 * `Connection: keep-alive` in the call itself, so the header is forced here, where the head is
 * written.
 */
function withConnectionClose(res: ServerResponse, args: unknown[]): unknown[] {
  const at = headersIndex(args);
  const headers = args[at];
  if (res.hasHeader('connection')) res.removeHeader('connection');
  const out = [...args];
  if (headers === undefined || headers === null) {
    res.setHeader('Connection', 'close');
    return out;
  }
  if (Array.isArray(headers)) {
    if (headers.length > 0 && Array.isArray(headers[0])) {
      out[at] = [
        ...(headers as unknown[][]).filter(([key]) => !isConnection(key)),
        ['Connection', 'close'],
      ];
    } else {
      const flat: unknown[] = [];
      for (let i = 0; i + 1 < headers.length; i += 2) {
        if (!isConnection(headers[i])) flat.push(headers[i], headers[i + 1]);
      }
      out[at] = [...flat, 'Connection', 'close'];
    }
    return out;
  }
  out[at] = {
    ...Object.fromEntries(Object.entries(headers as object).filter(([key]) => !isConnection(key))),
    Connection: 'close',
  };
  return out;
}

/**
 * Attaches the tracker to `server`, which must not be listening yet. `youngMs` is the young window
 * (tests shorten it).
 */
export function trackConnections(
  server: Server,
  options: { youngMs?: number } = {},
): ConnectionTracker {
  const youngMs = options.youngMs ?? YOUNG_WINDOW_MS;
  const conns = new Map<Socket, Conn>();
  let stopping = false;
  let stopAt = 0;
  let graceMs = 0;
  let graceTimer: NodeJS.Timeout | undefined;
  let cut = 0;
  let because: StopCause | undefined;
  let stopped: Promise<StopOutcome> | undefined;
  /** Set by a `cutAll()` that begins the stop: what its zero grace destroys is the signal's cut. */
  let cutNow = false;

  /** Ends a connection that finished every request it had, unless it is already ending. */
  const endIfIdle = (conn: Conn): void => {
    const { socket } = conn;
    // `writableEnded`: Node has begun to close it (an answer that carried `Connection: close`), or
    // `listen`'s refusal is closing it in stages; either bounds it, so it is left alone.
    if (!socket.destroyed && !socket.writableEnded && conn.inFlight.size === 0) socket.destroy();
  };

  /** The grace's end and the second signal: everything still open is destroyed now. */
  const destroyAll = (cause: StopCause): void => {
    if (!stopping) return;
    because ??= cause;
    for (const conn of conns.values()) {
      const { socket } = conn;
      if (socket.destroyed) continue;
      // A client that has hung up (its end of the connection is closed) ended its own request.
      if (!socket.readableEnded) cut += conn.inFlight.size;
      socket.destroy();
    }
  };

  const armGrace = (): void => {
    if (graceTimer !== undefined || !stopping) return;
    graceTimer = setTimeout(
      () => destroyAll('grace_ran_out'),
      Math.max(0, stopAt + graceMs - performance.now()),
    );
  };

  /** A connection with no request yet: ended when its young window closes, never past the grace. */
  const armYoung = (conn: Conn): void => {
    const deadline = Math.min(conn.acceptedAt + youngMs, stopAt + graceMs);
    conn.youngTimer = setTimeout(
      () => {
        conn.youngTimer = undefined;
        if (conn.requests === 0) conn.socket.destroy();
      },
      Math.max(0, deadline - performance.now()),
    );
  };

  const onConnection = (socket: Socket): void => {
    const conn: Conn = {
      socket,
      acceptedAt: performance.now(),
      requests: 0,
      inFlight: new Set(),
      held: undefined,
      youngTimer: undefined,
    };
    conns.set(socket, conn);
    socket.once('close', () => {
      if (conn.youngTimer !== undefined) clearTimeout(conn.youngTimer);
      conn.youngTimer = undefined;
      conns.delete(socket);
    });
    if (stopping) armYoung(conn);
  };

  const onRequest = (req: IncomingMessage, res: ServerResponse): void => {
    const conn = conns.get(req.socket);
    if (conn === undefined) return;
    conn.requests += 1;
    conn.inFlight.add(res);
    if (conn.youngTimer !== undefined) {
      clearTimeout(conn.youngTimer);
      conn.youngTimer = undefined;
    }
    armGrace();
    const writeHead = res.writeHead;
    res.writeHead = function (this: ServerResponse, ...args: unknown[]): ServerResponse {
      const held =
        req.method === 'GET' && contentTypeOf(this, args).startsWith('text/event-stream');
      const written = Reflect.apply(
        writeHead,
        this,
        stopping && !this.headersSent ? withConnectionClose(this, args) : args,
      ) as ServerResponse;
      if (held) {
        conn.held = this;
        conn.inFlight.delete(this);
        if (stopping) conn.socket.destroy();
      }
      return written;
    } as ServerResponse['writeHead'];
    const ended = (): void => {
      conn.inFlight.delete(res);
      if (conn.held === res) conn.held = undefined;
    };
    // Node's own 'finish' listener runs first: it has already begun to close a connection whose
    // answer carried `Connection: close`.
    res.once('finish', () => {
      ended();
      if (stopping) endIfIdle(conn);
    });
    // A response that never finished: the client hung up, or the stop destroyed it (counted there).
    res.once('close', ended);
  };

  const emit = server.emit;
  server.emit = function (this: Server, event: string | symbol, ...args: unknown[]): boolean {
    if (event === 'connection') onConnection(args[0] as Socket);
    else if (event === 'request' || event === 'checkContinue' || event === 'checkExpectation') {
      onRequest(args[0] as IncomingMessage, args[1] as ServerResponse);
    }
    return Reflect.apply(emit, this, [event, ...args]) as boolean;
  } as Server['emit'];

  const tracker: ConnectionTracker = {
    stop(grace: number): Promise<StopOutcome> {
      if (stopped !== undefined) return stopped;
      stopping = true;
      stopAt = performance.now();
      graceMs = Math.max(0, grace);
      stopped = new Promise<StopOutcome>((resolve) => {
        // Every connection has gone once the server's close callback runs (an error says it was
        // not listening, and nothing is open then either).
        server.close(() => {
          if (graceTimer !== undefined) clearTimeout(graceTimer);
          graceTimer = undefined;
          for (const conn of conns.values()) {
            if (conn.youngTimer !== undefined) clearTimeout(conn.youngTimer);
            conn.youngTimer = undefined;
          }
          resolve({ cut, because });
        });
      });
      for (const conn of conns.values()) {
        if (conn.socket.destroyed) continue;
        if (conn.held !== undefined) conn.socket.destroy();
        else if (conn.inFlight.size > 0) armGrace();
        else if (conn.requests === 0) armYoung(conn);
        else endIfIdle(conn);
      }
      if (graceMs === 0) destroyAll(cutNow ? 'second_signal' : 'grace_ran_out');
      return stopped;
    },
    cutAll(): Promise<StopOutcome> {
      if (stopped === undefined) {
        cutNow = true;
        return tracker.stop(0);
      }
      destroyAll('second_signal');
      return stopped;
    },
  };
  return tracker;
}
