// graceful-stop.test.ts — issue #960: the tracker that stops `realm serve` and `realm listen`, on a
// plain Node server with real sockets on loopback and short windows. Each cell drives the server the
// way a client does (bytes on a socket) and reads what the client sees: the answer's status, its
// `connection` header, when the socket closed, and the stop's outcome (`cut`, `because`).
// On a failing host each cell prints those facts (times in ms, statuses, header values, counts);
// nothing here is a secret.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { describe, expect, it, onTestFinished } from 'vitest';
import { trackConnections, type ConnectionTracker, type StopOutcome } from './graceful-stop.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const GET = 'GET / HTTP/1.1\r\nHost: x\r\n\r\n';

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

/** A server with the tracker attached before it listens; closed after the cell, whatever happens. */
async function start(
  handler: Handler,
  opts: { youngMs?: number; on?: (server: Server) => void } = {},
): Promise<{ server: Server; tracker: ConnectionTracker; port: number }> {
  const server = createServer(handler);
  opts.on?.(server);
  const tracker = trackConnections(server, { youngMs: opts.youngMs ?? 5000 });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  onTestFinished(() => {
    server.closeAllConnections();
    server.close();
  });
  return { server, tracker, port };
}

interface Client {
  readonly socket: Socket;
  /** `performance.now()` when the connection was made. */
  readonly connectedAt: number;
  /** Every byte received so far. */
  text(): string;
  /** When the socket closed, or undefined while it is open. */
  closedAt(): number | undefined;
  /** When the first byte arrived. */
  firstByteAt(): number | undefined;
  /** Resolves when the socket closes. */
  readonly closed: Promise<void>;
}

function client(port: number): Promise<Client> {
  return new Promise((resolve) => {
    let bytes = '';
    let closedAt: number | undefined;
    let firstByteAt: number | undefined;
    let done: () => void = () => {};
    const closed = new Promise<void>((r) => (done = r));
    const socket = connect(port, '127.0.0.1', () => {
      resolve({
        socket,
        connectedAt: performance.now(),
        text: () => bytes,
        closedAt: () => closedAt,
        firstByteAt: () => firstByteAt,
        closed,
      });
    });
    socket.on('data', (d: Buffer) => {
      firstByteAt ??= performance.now();
      bytes += d.toString('latin1');
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      closedAt = performance.now();
      done();
    });
    onTestFinished(() => {
      socket.destroy();
    });
  });
}

/** The first answer's status and `connection` header, as the client read them. */
function head(text: string): { status: number | 'no answer'; connection: string | undefined } {
  const m = /^HTTP\/1\.1 (\d{3})/.exec(text);
  const top = text.split('\r\n\r\n')[0] ?? '';
  const connection = /\r\nconnection: *([^\r\n]*)/i.exec(top)?.[1]?.toLowerCase();
  return { status: m === null ? 'no answer' : Number(m[1]), connection };
}

/** Waits for the stop, at most `ms`; `'still waiting'` when it has not ended by then. */
async function within(
  stop: Promise<StopOutcome>,
  ms: number,
): Promise<StopOutcome | 'still waiting'> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<'still waiting'>(
    (r) => (timer = setTimeout(() => r('still waiting'), ms)),
  );
  try {
    return await Promise.race([stop, late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Waits, at most `ms`, for the clients to see their sockets close: the server's side has closed when
 * the stop ends, and the client reads the last bytes and the close a moment later. A close time is
 * taken when its event fires, so waiting here never changes it.
 */
async function closedAll(clients: Client[], ms = 2000): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    Promise.all(clients.map((c) => c.closed)),
    new Promise<void>((r) => (timer = setTimeout(r, ms))),
  ]);
  clearTimeout(timer);
}

/** Waits until `pred` holds or `ms` passes. */
async function until(pred: () => boolean, ms: number): Promise<void> {
  const end = performance.now() + ms;
  while (!pred() && performance.now() < end) await sleep(5);
}

const round = (n: number | undefined): number | undefined =>
  n === undefined ? undefined : Math.round(n);

describe('#960 the stop tracker', { timeout: 30_000 }, () => {
  it('A1: a keep-alive connection holding half the headers of a second request is ended at once', async () => {
    const { tracker, port } = await start((_req, res) => res.end('ok'));
    const c = await client(port);
    c.socket.write(GET);
    await until(() => head(c.text()).status === 200, 2000);
    c.socket.write('GET / HTTP/1.1\r\nHost: x\r\n');
    await sleep(100);
    const t = performance.now();
    const outcome = await within(tracker.stop(10_000), 2000);
    await closedAll([c]);
    // (1) Red when the stop leaves an idle connection to Node's own idle test, which misses a
    //     half-sent next request: the connection then lasts until the grace ends (10 s).
    // (2) Prints when the socket closed after the stop (ms) and the outcome.
    const facts = { closedAfterMs: round((c.closedAt() ?? Infinity) - t), outcome };
    expect(
      { closedWithin200: facts.closedAfterMs! <= 200, outcome },
      JSON.stringify(facts),
    ).toEqual({ closedWithin200: true, outcome: { cut: 0, because: undefined } });
  });

  it('A2: a silent connection and one with half its first headers are kept until the young window closes, then ended; not cut', async () => {
    const { tracker, port } = await start((_req, res) => res.end('ok'), { youngMs: 600 });
    const silent = await client(port);
    const partial = await client(port);
    partial.socket.write('GET / HTTP/1.1\r\nHost: x\r\n');
    await sleep(50);
    const outcome = await within(tracker.stop(10_000), 3000);
    await closedAll([silent, partial]);
    // (1) Red with no window (each is ended at the stop, about 50 ms after it connected) and with a
    //     window that never ends (each stays open and the stop never ends).
    // (2) Prints when each closed after it connected (ms) and the outcome.
    const facts = {
      silentMs: round((silent.closedAt() ?? Infinity) - silent.connectedAt),
      partialMs: round((partial.closedAt() ?? Infinity) - partial.connectedAt),
      outcome,
    };
    const inWindow = (ms: number | undefined): boolean => ms! >= 575 && ms! <= 900;
    expect(
      { silent: inWindow(facts.silentMs), partial: inWindow(facts.partialMs), outcome },
      JSON.stringify(facts),
    ).toEqual({ silent: true, partial: true, outcome: { cut: 0, because: undefined } });
  });

  it('A3: a request that arrives on a young connection after the stop, whole or in two pieces, is answered with `connection: close`, then the connection ends; not cut', async () => {
    const { tracker, port } = await start((_req, res) => res.end('ok'), { youngMs: 2000 });
    const whole = await client(port);
    const split = await client(port);
    const stop = tracker.stop(10_000);
    await sleep(300);
    whole.socket.write(GET);
    split.socket.write('GET / HTTP/1.1\r\n');
    await sleep(150);
    split.socket.write('Host: x\r\n\r\n');
    const outcome = await within(stop, 1500);
    await closedAll([whole, split]);
    // (1) Red when a request on a young connection is dropped after the stop (the connection is
    //     destroyed instead of answered).
    // (2) Prints each answer's status and header, whether its socket closed, and the outcome.
    const facts = {
      whole: { ...head(whole.text()), closed: whole.closedAt() !== undefined },
      split: { ...head(split.text()), closed: split.closedAt() !== undefined },
      outcome,
    };
    expect(facts, JSON.stringify(facts)).toEqual({
      whole: { status: 200, connection: 'close', closed: true },
      split: { status: 200, connection: 'close', closed: true },
      outcome: { cut: 0, because: undefined },
    });
  });

  it('A4: a request answered 400 ms after the stop gets its whole answer with `connection: close`, and its connection ends at once; not cut', async () => {
    const waiting: ServerResponse[] = [];
    const { tracker, port } = await start((_req, res) => void waiting.push(res));
    const c = await client(port);
    c.socket.write(GET);
    await until(() => waiting.length === 1, 2000);
    const stop = tracker.stop(10_000);
    await sleep(400);
    const answeredAt = performance.now();
    waiting[0]!.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': '2' });
    waiting[0]!.end('ok');
    const outcome = await within(stop, 2000);
    await closedAll([c]);
    // (1) Red when the answer is left to Node's keep-alive: its head then says `keep-alive`.
    // (2) Prints the status, the header, the body, when the socket closed after the answer (ms)
    //     and the outcome.
    const facts = {
      ...head(c.text()),
      body: c.text().split('\r\n\r\n')[1],
      closedAfterAnswerMs: round((c.closedAt() ?? Infinity) - answeredAt),
      outcome,
    };
    expect(
      { ...facts, closedAfterAnswerMs: facts.closedAfterAnswerMs! <= 200 },
      JSON.stringify(facts),
    ).toEqual({
      status: 200,
      connection: 'close',
      body: 'ok',
      closedAfterAnswerMs: true,
      outcome: { cut: 0, because: undefined },
    });
  });

  it('A5: a request still in flight when the grace ends is destroyed and counted as cut', async () => {
    const { tracker, port } = await start(() => {});
    const c = await client(port);
    c.socket.write(GET);
    await sleep(100);
    const t = performance.now();
    const outcome = await within(tracker.stop(300), 3000);
    await closedAll([c]);
    // (1) Red when the grace's timer does nothing: the stop never ends.
    // (2) Prints the outcome and when the socket closed after the stop (ms).
    const facts = { outcome, closedAfterMs: round((c.closedAt() ?? Infinity) - t) };
    expect(
      { outcome, closedInGrace: facts.closedAfterMs! >= 290 && facts.closedAfterMs! <= 1000 },
      JSON.stringify(facts),
    ).toEqual({ outcome: { cut: 1, because: 'grace_ran_out' }, closedInGrace: true });
  });

  it('A6: a second signal cuts what is in flight at once; a grace of 0 cuts it in the first turn, and with only a silent connection cuts nothing', async () => {
    // The second signal.
    const one = await start(() => {});
    const c1 = await client(one.port);
    c1.socket.write(GET);
    await sleep(100);
    const stop1 = one.tracker.stop(60_000);
    await sleep(50);
    const t = performance.now();
    one.tracker.cutAll();
    const second = await within(stop1, 2000);
    await closedAll([c1]);
    const secondMs = round((c1.closedAt() ?? Infinity) - t);
    // Grace 0 with a request in flight: the server's socket is destroyed before `stop` returns.
    let serverSocket: Socket | undefined;
    const two = await start((req) => void (serverSocket = req.socket));
    const c2 = await client(two.port);
    c2.socket.write(GET);
    await until(() => serverSocket !== undefined, 2000);
    const stop2 = two.tracker.stop(0);
    const firstTurn = serverSocket!.destroyed;
    const zero = await within(stop2, 2000);
    // Grace 0 with only a silent connection.
    const three = await start(() => {});
    await client(three.port);
    await sleep(50);
    const silent = await within(three.tracker.stop(0), 2000);
    // (1) Red when the second signal is not wired (the first stop waits its 60 s grace), when a
    //     grace of 0 waits for a later turn, or when a silent connection is counted as cut.
    // (2) Prints the three outcomes, the time to close after the second signal (ms) and whether
    //     the grace-0 socket was destroyed before `stop` returned.
    const facts = { second, secondMs, firstTurn, zero, silent };
    expect({ ...facts, secondMs: facts.secondMs! <= 300 }, JSON.stringify(facts)).toEqual({
      second: { cut: 1, because: 'second_signal' },
      secondMs: true,
      firstTurn: true,
      zero: { cut: 1, because: 'grace_ran_out' },
      silent: { cut: 0, because: 'grace_ran_out' },
    });
  });

  it('A7: the young window never lasts past the grace', async () => {
    const { tracker, port } = await start(() => {}, { youngMs: 2000 });
    const c = await client(port);
    await sleep(50);
    const t = performance.now();
    const outcome = await within(tracker.stop(300), 3000);
    await closedAll([c]);
    // (1) Red when the young window is the same whatever the grace: the connection then lasts
    //     2 s, past the 300 ms grace (nothing is in flight, so the grace's own timer is not armed).
    // (2) Prints when the socket closed after the stop (ms) and the outcome.
    const facts = { closedAfterMs: round((c.closedAt() ?? Infinity) - t), outcome };
    expect(
      { closedAtGrace: facts.closedAfterMs! >= 290 && facts.closedAfterMs! <= 900, outcome },
      JSON.stringify(facts),
    ).toEqual({ closedAtGrace: true, outcome: { cut: 0, because: undefined } });
  });

  it('A8: an `Expect: 100-continue` request is in flight, not young; and with no `checkContinue` listener Node still sends `100 Continue` and the handler gets the body, with and without a stop', async () => {
    const EXPECT =
      'POST / HTTP/1.1\r\nHost: x\r\nExpect: 100-continue\r\nContent-Length: 4\r\n\r\n';
    // A server that listens for `checkContinue` (as `realm listen` does) and never answers.
    const held = await start(() => {}, {
      youngMs: 200,
      on: (s) => s.on('checkContinue', (_req, res) => res.writeContinue()),
    });
    const c1 = await client(held.port);
    c1.socket.write(EXPECT);
    await sleep(100);
    const stop1 = held.tracker.stop(700);
    await sleep(400);
    const openAt400 = c1.closedAt() === undefined;
    const counted = await within(stop1, 2000);
    // A server with no such listener: Node answers `100 Continue` itself, then the handler reads
    // the body and answers with it.
    const echo: Handler = (req, res) => {
      let body = '';
      req.on('data', (d: Buffer) => (body += d.toString()));
      req.on('end', () => res.end(body));
    };
    const plain = await start(echo);
    const c2 = await client(plain.port);
    c2.socket.write(EXPECT);
    await until(() => c2.text().includes('100 Continue'), 1000);
    c2.socket.write('ping');
    await until(() => c2.text().includes('ping'), 1000);
    const without = {
      continued: c2.text().startsWith('HTTP/1.1 100 Continue'),
      echoed: c2.text().endsWith('ping'),
    };
    const stopped = await start(echo);
    const c3 = await client(stopped.port);
    c3.socket.write(EXPECT);
    await until(() => c3.text().includes('100 Continue'), 1000);
    const stop3 = stopped.tracker.stop(5000);
    c3.socket.write('ping');
    await until(() => c3.text().includes('ping'), 1000);
    const withStop = {
      continued: c3.text().startsWith('HTTP/1.1 100 Continue'),
      echoed: c3.text().endsWith('ping'),
      outcome: await within(stop3, 2000),
    };
    // (1) Red when the tracker adds a `checkContinue` listener of its own (Node then sends no
    //     `100 Continue` and the handler never runs), or does not see the requests Node routes to
    //     `checkContinue` (the request is then ended as young at 200 ms, and not cut).
    // (2) Prints whether the first socket was open at 400 ms, its outcome, and for each plain
    //     server whether `100 Continue` came and the body was echoed.
    const facts = { openAt400, counted, without, withStop };
    expect(facts, JSON.stringify(facts)).toEqual({
      openAt400: true,
      counted: { cut: 1, because: 'grace_ran_out' },
      without: { continued: true, echoed: true },
      withStop: { continued: true, echoed: true, outcome: { cut: 0, because: undefined } },
    });
  });

  it('A9: a held event stream is ended at once and not cut, also one whose head is written after the stop; a POST answered with an event stream is in flight and finishes', async () => {
    const waiting: ServerResponse[] = [];
    const { tracker, port } = await start((req, res) => {
      if (req.method === 'GET' && req.url === '/now') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: open\n\n');
      } else waiting.push(res);
    });
    const now = await client(port);
    now.socket.write('GET /now HTTP/1.1\r\nHost: x\r\n\r\n');
    const later = await client(port);
    later.socket.write('GET /later HTTP/1.1\r\nHost: x\r\n\r\n');
    const post = await client(port);
    post.socket.write('POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\n\r\n');
    await until(() => now.text().includes('data: open') && waiting.length === 2, 2000);
    const [laterRes, postRes] = [
      waiting.find((r) => r.req.url === '/later')!,
      waiting.find((r) => r.req.url === '/')!,
    ];
    postRes.writeHead(200, { 'Content-Type': 'text/event-stream' });
    postRes.write('data: one\n\n');
    const t = performance.now();
    const stop = tracker.stop(10_000);
    await sleep(100);
    const laterAt = performance.now();
    laterRes.writeHead(200, { 'Content-Type': 'text/event-stream' });
    await sleep(300);
    postRes.end('data: two\n\n');
    const outcome = await within(stop, 2000);
    await closedAll([now, later, post]);
    // (1) Red when every event stream counts as held (the POST's answer is then cut short at the
    //     stop), and when a held stream whose head comes after the stop is left open (it lasts
    //     until the grace ends).
    // (2) Prints when each GET stream closed (ms after the stop, and after its head), whether the
    //     POST's answer came whole, and the outcome.
    const facts = {
      nowMs: round((now.closedAt() ?? Infinity) - t),
      laterMs: round((later.closedAt() ?? Infinity) - laterAt),
      postWhole: post.text().includes('data: one') && post.text().includes('data: two'),
      outcome,
    };
    expect(
      { ...facts, nowMs: facts.nowMs! <= 200, laterMs: facts.laterMs! <= 200 },
      JSON.stringify(facts),
    ).toEqual({
      nowMs: true,
      laterMs: true,
      postWhole: true,
      outcome: { cut: 0, because: undefined },
    });
  });

  it('A10: an answer written after the stop says `connection: close`, whichever form of headers `writeHead` was given', async () => {
    const waiting: ServerResponse[] = [];
    const { tracker, port } = await start((_req, res) => void waiting.push(res));
    const clients = await Promise.all([client(port), client(port), client(port)]);
    for (const [i, c] of clients.entries()) c.socket.write(`GET /${i} HTTP/1.1\r\nHost: x\r\n\r\n`);
    await until(() => waiting.length === 3, 2000);
    const byPath = (p: string): ServerResponse => waiting.find((r) => r.req.url === p)!;
    const stop = tracker.stop(10_000);
    byPath('/0').writeHead(200, { Connection: 'keep-alive', 'Content-Length': '1' });
    byPath('/1').writeHead(200, [
      ['Connection', 'keep-alive'],
      ['Content-Length', '1'],
    ]);
    byPath('/2').writeHead(200, ['Connection', 'keep-alive', 'Content-Length', '1']);
    for (const r of waiting) r.end('x');
    const outcome = await within(stop, 2000);
    await closedAll(clients);
    // (1) Red when the header is forced only with `setHeader` before the call: the call's own
    //     `Connection: keep-alive` then wins (object and flat forms), or Node refuses the array of
    //     pairs.
    // (2) Prints each form's status and header, and the outcome.
    const facts = {
      object: head(clients[0]!.text()),
      pairs: head(clients[1]!.text()),
      flat: head(clients[2]!.text()),
      outcome,
    };
    expect(facts, JSON.stringify(facts)).toEqual({
      object: { status: 200, connection: 'close' },
      pairs: { status: 200, connection: 'close' },
      flat: { status: 200, connection: 'close' },
      outcome: { cut: 0, because: undefined },
    });
  });

  it('A11: an answer whose head said `keep-alive` before the stop ends its connection the moment it finishes', async () => {
    const waiting: ServerResponse[] = [];
    const { tracker, port } = await start((_req, res) => {
      res.writeHead(200, { Connection: 'keep-alive', 'Transfer-Encoding': 'chunked' });
      res.write('part');
      waiting.push(res);
    });
    const c = await client(port);
    c.socket.write(GET);
    await until(() => waiting.length === 1 && c.text().includes('part'), 2000);
    const stop = tracker.stop(10_000);
    await sleep(400);
    const endAt = performance.now();
    waiting[0]!.end('rest');
    const outcome = await within(stop, 2000);
    await closedAll([c]);
    // (1) Red when the stop relies on the forced header alone: this head was written before the
    //     stop, so Node keeps the connection open after the answer.
    // (2) Prints the header the client saw, when the socket closed after the answer's end (ms),
    //     and the outcome.
    const facts = {
      connection: head(c.text()).connection,
      closedAfterEndMs: round((c.closedAt() ?? Infinity) - endAt),
      outcome,
    };
    expect(
      { ...facts, closedAfterEndMs: facts.closedAfterEndMs! <= 200 },
      JSON.stringify(facts),
    ).toEqual({
      connection: 'keep-alive',
      closedAfterEndMs: true,
      outcome: { cut: 0, because: undefined },
    });
  });

  it('A12: a client that hangs up during the grace is not a cut request', async () => {
    const { tracker, port } = await start(() => {});
    const a = await client(port);
    const b = await client(port);
    a.socket.write(GET);
    b.socket.write(GET);
    await sleep(100);
    const stop = tracker.stop(1000);
    await sleep(200);
    a.socket.destroy();
    const outcome = await within(stop, 3000);
    // (1) Red when cut requests are counted from close events: the hang-up then counts too (2).
    // (2) Prints the outcome.
    expect(outcome, JSON.stringify(outcome)).toEqual({ cut: 1, because: 'grace_ran_out' });
  });

  it('A13: once the stop has ended, none of its timers is left', async () => {
    const timers = (): number =>
      process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
    const before = timers();
    const waiting: ServerResponse[] = [];
    const { tracker, port } = await start((_req, res) => void waiting.push(res), {
      youngMs: 5000,
    });
    const young = await client(port);
    const busy = await client(port);
    busy.socket.write(GET);
    await until(() => waiting.length === 1, 2000);
    const stop = tracker.stop(10_000);
    // The young connection leaves by itself; the request in flight is answered within the grace.
    young.socket.destroy();
    await young.closed;
    waiting[0]!.end('ok');
    const outcome = await within(stop, 2000);
    await busy.closed;
    const after = timers();
    // (1) Red when the stop leaves its grace timer (10 s) or a young window's timer (5 s) running
    //     after it has ended.
    // (2) Prints the count of active timers before and after, and the outcome.
    const facts = { before, after, outcome };
    expect(facts, JSON.stringify(facts)).toEqual({
      before,
      after: before,
      outcome: { cut: 0, because: undefined },
    });
  });

  it('A14: a second signal before the stop (during `--shutdown-drain`) begins it and cuts what is in flight at once, cause `second_signal`; with nothing open it ends cutting nothing', async () => {
    const one = await start(() => {});
    const c1 = await client(one.port);
    c1.socket.write(GET);
    await sleep(100);
    const t = performance.now();
    const cut = await within(one.tracker.cutAll(), 2000);
    await closedAll([c1]);
    const closedMs = round((c1.closedAt() ?? Infinity) - t);
    // The server accepts nothing after it, and a later `stop()` returns the same outcome.
    const refused = await new Promise<boolean>((r) => {
      const probe = connect(one.port, '127.0.0.1');
      probe.on('connect', () => {
        probe.destroy();
        r(false);
      });
      probe.on('error', () => r(true));
    });
    const again = await within(one.tracker.stop(30_000), 1000);
    const two = await start(() => {});
    const empty = await within(two.tracker.cutAll(), 2000);
    // (1) Red with U1's `cutAll()`, which did nothing before `stop()` (no outcome, the request
    //     left open), and when it begins the stop as a grace of 0 (`because: grace_ran_out`).
    // (2) Prints the outcomes, when the client's socket closed after the cut (ms) and whether a
    //     new connection was refused.
    const facts = { cut, closedMs, refused, again, empty };
    expect({ ...facts, closedMs: facts.closedMs! <= 1000 }, JSON.stringify(facts)).toEqual({
      cut: { cut: 1, because: 'second_signal' },
      closedMs: true,
      refused: true,
      again: { cut: 1, because: 'second_signal' },
      empty: { cut: 0, because: 'second_signal' },
    });
  });
});
