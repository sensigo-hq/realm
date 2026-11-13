// health-address.ts — #960 U2: the health address of `realm serve` and `realm listen`.
//
// A load balancer or a monitor asks `GET /health` (or `HEAD`) whether the program is accepting
// connections and is not stopping. Running: `200` `{"status":"ok"}`. From the first Ctrl+C or
// `SIGTERM`: `503` `{"status":"shutting_down"}` with `Connection: close`. The body never carries
// anything else (no version, process id, path, workflow, store or setting), and the address does
// not look at the store: it says the process is up and not stopping, never that a request would
// succeed. It takes no token and no signature, and nothing about it is logged.
//
// ONE function decides what the address is, for both commands: `isHealthRequest`. A path is read
// the way `realm listen` has always read a request's path (`requestPath`, moved here unchanged), so
// `/./health`, `/a/../health`, `//x/health` and an absolute-form target `http://x/health` are the
// address, and `//health`, `/Health`, `/health/`, `/healthz`, `/health;x` are not.
import type { IncomingMessage, ServerResponse } from 'node:http';

/** The address's path. `realm listen` refuses to start a workflow mounted at it. */
export const HEALTH_PATH = '/health';

/** The two bodies, word for word. */
export const HEALTH_OK_BODY = '{"status":"ok"}';
export const HEALTH_STOPPING_BODY = '{"status":"shutting_down"}';

/**
 * A request's path: the pathname only, never the query string (which can carry a token), even for
 * an address the URL parser refuses (one starting with `//`, for one).
 */
export function requestPath(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://localhost').pathname;
  } catch {
    const raw = req.url ?? '/';
    const cut = raw.search(/[?#]/);
    return cut === -1 ? raw : raw.slice(0, cut);
  }
}

/** True for a `GET` or a `HEAD` whose path, read as `requestPath` reads it, is `/health`. */
export function isHealthRequest(req: IncomingMessage): boolean {
  return (req.method === 'GET' || req.method === 'HEAD') && requestPath(req) === HEALTH_PATH;
}

/**
 * Answers `req` when it is the health address and returns true; returns false, having done
 * nothing, for any other request. `isStopping` is the command's own state for this server, read
 * per request. It never throws: a failure while answering destroys the response instead, because
 * on `realm serve` this runs outside the request handler's `try`.
 */
export function answerHealth(
  req: IncomingMessage,
  res: ServerResponse,
  isStopping: () => boolean,
): boolean {
  // Total: `requestPath` catches what the URL parser throws.
  if (!isHealthRequest(req)) return false;
  try {
    const stopping = isStopping();
    const body = stopping ? HEALTH_STOPPING_BODY : HEALTH_OK_BODY;
    res.writeHead(stopping ? 503 : 200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      // The length of the `GET` body, `HEAD` included: a reply to an HTTP/1.0 sender that keeps its
      // connection open does not end it (the reason `realm listen`'s replies carry it, #744).
      'Content-Length': Buffer.byteLength(body),
      ...(stopping ? { Connection: 'close' } : {}),
    });
    if (req.method === 'HEAD') res.end();
    else res.end(body);
  } catch {
    try {
      res.destroy();
    } catch {
      // Nothing more can be done for this request.
    }
  }
  return true;
}
