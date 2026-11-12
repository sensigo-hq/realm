// health-address.test.ts — #960 U2: the health address of `realm serve` and `realm listen`, on a
// plain Node server with real sockets on loopback. Every request goes through Node's own parser, so
// the table below holds only targets Node delivers to a handler (it refuses `\health` itself). Each
// cell reads what a load balancer reads: the status, the headers and the body.
// On a failing host each cell prints the targets it got wrong, or the answer it read; nothing here is
// a secret.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { describe, expect, it, onTestFinished } from 'vitest';
import {
  answerHealth,
  HEALTH_OK_BODY,
  HEALTH_STOPPING_BODY,
  isHealthRequest,
  requestPath,
} from './health-address.js';

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

async function start(handler: Handler): Promise<number> {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  onTestFinished(() => {
    server.closeAllConnections();
    server.close();
  });
  return (server.address() as AddressInfo).port;
}

/** Sends `text` on a new connection; resolves with every byte received once the server closes it or
 *  `ms` passes. */
function send(port: number, text: string, ms = 1000): Promise<string> {
  return new Promise((resolve) => {
    let bytes = '';
    const socket = connect(port, '127.0.0.1', () => socket.write(text));
    const done = (): void => {
      clearTimeout(timer);
      socket.destroy();
      resolve(bytes);
    };
    const timer = setTimeout(done, ms);
    socket.on('data', (d: Buffer) => (bytes += d.toString('latin1')));
    socket.on('error', () => {});
    socket.on('close', done);
  });
}

/** One answer as a client reads it: status, the headers that matter here, the body. */
function answer(text: string): {
  status: number | 'no answer';
  headers: Record<string, string>;
  body: string;
} {
  const [top = '', ...rest] = text.split('\r\n\r\n');
  const status = /^HTTP\/1\.1 (\d{3})/.exec(top);
  const headers: Record<string, string> = {};
  for (const line of top.split('\r\n').slice(1)) {
    const at = line.indexOf(':');
    const name = line.slice(0, at).toLowerCase();
    if (['content-type', 'cache-control', 'content-length', 'connection'].includes(name)) {
      headers[name] = line.slice(at + 1).trim();
    }
  }
  return {
    status: status === null ? 'no answer' : Number(status[1]),
    headers,
    body: rest.join(''),
  };
}

describe('#960 U2 the health address', { timeout: 30_000 }, () => {
  it('HA1: which requests are the address: GET and HEAD of `/health` as `realm listen` reads a path, and nothing else', async () => {
    const seen: Array<{ method: string; target: string; health: boolean; path: string }> = [];
    const port = await start((req, res) => {
      seen.push({
        method: req.method ?? '',
        target: req.url ?? '',
        health: isHealthRequest(req),
        path: requestPath(req),
      });
      res.writeHead(204).end();
    });
    const cases: Array<[method: string, target: string, health: boolean]> = [
      ['GET', '/health', true],
      ['HEAD', '/health', true],
      ['GET', '/health?x=1', true],
      ['GET', '/health#f', true],
      ['GET', '/./health', true],
      ['GET', '/a/../health', true],
      ['GET', '//x/health', true],
      ['GET', 'http://x/health', true],
      ['GET', '//health', false],
      ['GET', '/Health', false],
      ['GET', '/health/', false],
      ['GET', '/healthz', false],
      ['GET', '/health;x', false],
      ['GET', '/health%2F', false],
      ['POST', '/health', false],
      ['OPTIONS', '/health', false],
    ];
    for (const [method, target] of cases) {
      await send(port, `${method} ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
    }
    // `requestPath` moved here unchanged: a `//x/hook` target still reaches `/hook` on `listen`.
    await send(
      port,
      'POST //x/hook HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\nConnection: close\r\n\r\n',
    );
    const wrong = cases
      .map(([method, target, health], i) => ({ method, target, want: health, got: seen[i] }))
      .filter(
        (c) => c.got?.method !== c.method || c.got.target !== c.target || c.got.health !== c.want,
      );
    // (1) Red with a prefix match (`/health/`, `/healthz` become the address), with a match on the
    //     raw target (`?x=1`, `/./health` and `http://x/health` no longer are), and when POST or
    //     OPTIONS are answered.
    // (2) Prints each target whose answer was wrong (what was sent, what the server read), and the
    //     path `//x/hook` was read as.
    const facts = { wrong, hook: seen[cases.length]?.path };
    expect(facts, JSON.stringify(facts)).toEqual({ wrong: [], hook: '/hook' });
  });

  it('HA2: the answers: 200 `{"status":"ok"}` while running, 503 `{"status":"shutting_down"}` with `Connection: close` once stopping, the same for HEAD without a body; any other request is left alone', async () => {
    let stopping = false;
    const port = await start((req, res) => {
      if (answerHealth(req, res, () => stopping)) return;
      res.writeHead(204).end();
    });
    const get = 'GET /health HTTP/1.1\r\nHost: x\r\n\r\n';
    const headReq = 'HEAD /health HTTP/1.1\r\nHost: x\r\n\r\n';
    const running = {
      get: answer(await send(port, get, 300)),
      head: answer(await send(port, headReq, 300)),
    };
    const other = answer(await send(port, 'GET /other HTTP/1.1\r\nHost: x\r\n\r\n', 300));
    stopping = true;
    const stopped = { get: answer(await send(port, get)), head: answer(await send(port, headReq)) };
    const ok = {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'content-length': '15',
      connection: 'keep-alive',
    };
    const closing = {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'content-length': '26',
      connection: 'close',
    };
    // (1) Red with another body (a version, a timestamp), without `Cache-Control: no-store`, when
    //     the answer stays 200 once stopping, without `Connection: close` on the 503, when HEAD
    //     gets a body, and when a request that is not the address is answered.
    // (2) Prints each answer's status, its four headers and its body.
    const facts = { running, other, stopped };
    expect(facts, JSON.stringify(facts)).toEqual({
      running: {
        get: { status: 200, headers: ok, body: HEALTH_OK_BODY },
        head: { status: 200, headers: ok, body: '' },
      },
      other: { status: 204, headers: { connection: 'keep-alive' }, body: '' },
      stopped: {
        get: { status: 503, headers: closing, body: HEALTH_STOPPING_BODY },
        head: { status: 503, headers: closing, body: '' },
      },
    });
    expect([HEALTH_OK_BODY, HEALTH_STOPPING_BODY]).toEqual([
      '{"status":"ok"}',
      '{"status":"shutting_down"}',
    ]);
  });

  it('HA3: it never throws: when reading the state fails, the request is dropped and the server keeps serving', async () => {
    let fail = true;
    const errors: unknown[] = [];
    const onError = (err: unknown): void => void errors.push(err);
    process.on('uncaughtException', onError);
    onTestFinished(() => void process.off('uncaughtException', onError));
    let handled = 0;
    const port = await start((req, res) => {
      handled += 1;
      const answered = answerHealth(req, res, () => {
        if (fail) throw new Error('state unreadable');
        return false;
      });
      if (!answered) res.writeHead(204).end();
    });
    const dropped = answer(await send(port, 'GET /health HTTP/1.1\r\nHost: x\r\n\r\n'));
    fail = false;
    const next = answer(await send(port, 'GET /health HTTP/1.1\r\nHost: x\r\n\r\n', 300));
    // (1) Red when the failure escapes (an uncaught exception: on `realm serve` this runs outside
    //     the handler's `try`) or is answered as if the request were another one (204).
    // (2) Prints both answers, how many requests the server handled and how many errors escaped.
    const facts = { dropped: dropped.status, next: next.status, handled, escaped: errors.length };
    expect(facts, JSON.stringify(facts)).toEqual({
      dropped: 'no answer',
      next: 200,
      handled: 2,
      escaped: 0,
    });
  });
});
