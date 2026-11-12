// serve-health-u2.test.ts — #960 U2, through the built `realm`: `realm serve`'s health address and
// `--shutdown-drain`. `GET`/`HEAD` `/health` answers `200` `{"status":"ok"}` without a token; from
// the first Ctrl+C or `SIGTERM` it answers `503` `{"status":"shutting_down"}` with
// `Connection: close`; with `--shutdown-drain N` the server goes on accepting and answering for N
// seconds before U1's stop begins; a second signal ends the drain and the grace at once.
// Each cell starts `realm serve --port 0` with a fresh HOME (`--dev`, or with `REALM_SERVE_TOKEN`),
// talks to it over a raw socket on loopback (or with the MCP SDK's own client), and reads what a
// load balancer, a client and an operator see: the status, headers and body, whether a connection is
// accepted, the exit code and when it came, and the `realm serve:` lines of standard error.
// Every time is `performance.now()`; each bound is set so that a loaded machine can only make a cell
// later, within its upper bound. On a failing host a cell prints those facts, never the environment
// (the child gets PATH, HOME and, where a cell needs it, the test token).
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', '..', 'dist', 'index.js');
const TOKEN = 'tok-u2-health';

let root: string;
let home: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'realm-u2-serve-'));
  home = join(root, 'home');
  mkdirSync(home);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const env = (token?: string): Record<string, string> => ({
  PATH: process.env['PATH'] ?? '',
  HOME: home,
  ...(token !== undefined ? { REALM_SERVE_TOKEN: token } : {}),
});
const round = (n: number | undefined): number | undefined =>
  n === undefined ? undefined : Math.round(n);

interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
  at: number;
}

interface Serve {
  readonly port: number;
  /** The `realm serve:` lines of standard error that report a cut. */
  cutLines(): string[];
  /** The `realm serve:` lines of standard error that report the drain. */
  drainLines(): string[];
  /** All of standard error. */
  stderr(): string;
  /** Sends a signal; returns when. */
  signal(sig: 'SIGTERM' | 'SIGINT'): number;
  /** The exit, once it has come within `ms`, or undefined. */
  exitWithin(ms: number): Promise<Exit | undefined>;
}

/** Starts the built `realm serve --port 0` (`--dev` unless `token` is given), waits for its start
 *  line, and kills it after the cell. */
async function startServe(extra: string[] = [], token?: string): Promise<Serve> {
  const args = [CLI, 'serve', ...(token === undefined ? ['--dev'] : []), '--port', '0', ...extra];
  const proc: ChildProcess = spawn(process.execPath, args, {
    cwd: root,
    env: env(token),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  onTestFinished(() => {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
  });
  let out = '';
  let err = '';
  proc.stdout!.on('data', (d: Buffer) => (out += d.toString()));
  proc.stderr!.on('data', (d: Buffer) => (err += d.toString()));
  let exit: Exit | undefined;
  const exited = new Promise<Exit>((r) =>
    proc.once('exit', (code, signal) => r((exit = { code, signal, at: performance.now() }))),
  );
  const startedBy = performance.now() + 20_000;
  let port: number | undefined;
  while (port === undefined && exit === undefined && performance.now() < startedBy) {
    const m = /listening on http:\/\/127\.0\.0\.1:(\d+)\//.exec(out);
    if (m !== null) port = Number(m[1]);
    else await sleep(20);
  }
  if (port === undefined) {
    throw new Error(
      `serve did not start: exit ${JSON.stringify(exit)}; stderr ${err.slice(0, 400)}`,
    );
  }
  const lines = (): string[] => err.split('\n').filter((l) => l.startsWith('realm serve:'));
  return {
    port,
    cutLines: () => lines().filter((l) => l.includes('Requests cut')),
    drainLines: () => lines().filter((l) => l.includes('--shutdown-drain')),
    stderr: () => err,
    signal: (sig) => {
      const at = performance.now();
      proc.kill(sig);
      return at;
    },
    exitWithin: async (ms) => {
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise<undefined>((r) => (timer = setTimeout(() => r(undefined), ms)));
      try {
        return await Promise.race([exited, late]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

interface Raw {
  readonly socket: Socket;
  readonly connectedAt: number;
  text(): string;
  /** When the socket closed, or undefined while it is open. */
  closedAt(): number | undefined;
  /** When the received text first matched `re`. */
  seenAt(re: RegExp): number | undefined;
}

/** A raw connection to the server; destroyed after the cell. */
function raw(port: number): Promise<Raw> {
  return new Promise((resolve) => {
    let bytes = '';
    let closedAt: number | undefined;
    const seen = new Map<RegExp, number>();
    const watch: RegExp[] = [];
    const socket = connect(port, '127.0.0.1', () =>
      resolve({
        socket,
        connectedAt: performance.now(),
        text: () => bytes,
        closedAt: () => closedAt,
        seenAt: (re) => {
          if (!watch.includes(re)) {
            watch.push(re);
            if (re.test(bytes)) seen.set(re, performance.now());
          }
          return seen.get(re);
        },
      }),
    );
    socket.on('data', (d: Buffer) => {
      bytes += d.toString('latin1');
      for (const re of watch) if (!seen.has(re) && re.test(bytes)) seen.set(re, performance.now());
    });
    socket.on('error', () => {});
    socket.on('close', () => (closedAt = performance.now()));
    onTestFinished(() => {
      socket.destroy();
    });
  });
}

/** Whether a new connection to the port is accepted (true) or refused (false). */
function accepts(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = connect(port, '127.0.0.1');
    probe.on('connect', () => {
      probe.destroy();
      resolve(true);
    });
    probe.on('error', () => resolve(false));
  });
}

/** One answer as the client read it: its status, the headers these cells read, and its body. */
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
    if (['content-type', 'cache-control', 'connection'].includes(name)) {
      headers[name] = line
        .slice(at + 1)
        .trim()
        .toLowerCase();
    }
  }
  return {
    status: status === null ? 'no answer' : Number(status[1]),
    headers,
    body: rest.join(''),
  };
}

/** Sends one request on a new keep-alive connection; resolves with the answer once `done` matches
 *  what arrived, the connection closes, or `ms` passes. */
async function ask(port: number, request: string, done: RegExp, ms = 3000): Promise<Raw> {
  const c = await raw(port);
  c.socket.write(request);
  const end = performance.now() + ms;
  while (c.seenAt(done) === undefined && c.closedAt() === undefined && performance.now() < end) {
    await sleep(10);
  }
  return c;
}

const GET_HEALTH = 'GET /health HTTP/1.1\r\nHost: x\r\n\r\n';
/** The end of a health answer (both bodies end with `"}`), or the end of an answer's head. */
const HEALTH_END = /"\}$/;
const HEAD_END = /\r\n\r\n$/;
const OK = {
  'content-type': 'application/json',
  'cache-control': 'no-store',
  connection: 'keep-alive',
};
const STOPPING = {
  'content-type': 'application/json',
  'cache-control': 'no-store',
  connection: 'close',
};

/** `serve`'s request in these cells: a POST to `/`, as an MCP client sends it. */
const POST_HEAD = (length: number, path = '/', auth = false): string =>
  `POST ${path} HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n` +
  (auth ? `Authorization: Bearer ${TOKEN}\r\n` : '') +
  `Accept: application/json, text/event-stream\r\nContent-Length: ${length}\r\n\r\n`;
const TOOLS_LIST = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}';
/** The end of the 400 a non-JSON body gets, or of an MCP answer's last chunk. */
const ANSWER_END = /"error":"Invalid JSON in request body"\}$|\r\n0\r\n\r\n$|\}\]\}\}\r\n\r\n$/;

/** The MCP SDK's fetch, watching the client's first `GET` event stream: when it opened and ended. */
function watchedFetch(): {
  fetch: typeof fetch;
  opened(): number | undefined;
  ended(): number | undefined;
} {
  let openedAt: number | undefined;
  let endedAt: number | undefined;
  const watched: typeof fetch = async (input, init) => {
    const res = await fetch(input, init);
    const isStream =
      (init?.method ?? 'GET') === 'GET' &&
      res.status === 200 &&
      (res.headers.get('content-type') ?? '').startsWith('text/event-stream');
    if (!isStream || res.body === null || openedAt !== undefined) return res;
    openedAt = performance.now();
    const reader = res.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(ctrl) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            endedAt ??= performance.now();
            ctrl.close();
          } else ctrl.enqueue(value);
        } catch (err) {
          endedAt ??= performance.now();
          ctrl.error(err);
        }
      },
      cancel(reason) {
        endedAt ??= performance.now();
        return reader.cancel(reason);
      },
    });
    return new Response(body, { status: res.status, headers: res.headers });
  };
  return { fetch: watched, opened: () => openedAt, ended: () => endedAt };
}

describe(
  '#960 U2 `realm serve`: the health address and `--shutdown-drain` (built CLI)',
  { timeout: 120_000 },
  () => {
    it('H1: running, `GET`, `HEAD` and `GET ?x=1` of `/health` answer 200 `{"status":"ok"}`, `application/json`, `no-store` (HEAD without a body)', async () => {
      const s = await startServe();
      const get = answer((await ask(s.port, GET_HEALTH, HEALTH_END)).text());
      const head = answer(
        (await ask(s.port, 'HEAD /health HTTP/1.1\r\nHost: x\r\n\r\n', HEAD_END)).text(),
      );
      const query = answer(
        (await ask(s.port, 'GET /health?x=1 HTTP/1.1\r\nHost: x\r\n\r\n', HEALTH_END)).text(),
      );
      // (1) Red on the base (the MCP endpoint answers 406 and 405), with another body, and when the
      //     query string defeats the match.
      // (2) Prints each answer's status, its three headers and its body.
      const facts = { get, head, query };
      expect(facts, JSON.stringify(facts)).toEqual({
        get: { status: 200, headers: OK, body: '{"status":"ok"}' },
        head: { status: 200, headers: OK, body: '' },
        query: { status: 200, headers: OK, body: '{"status":"ok"}' },
      });
    });

    it('H2: with `REALM_SERVE_TOKEN` set and no `--dev`, `GET /health` without a token is 200 while `POST /` without one is 401', async () => {
      const s = await startServe([], TOKEN);
      const health = answer((await ask(s.port, GET_HEALTH, HEALTH_END)).text());
      const mcp = answer(
        (await ask(s.port, POST_HEAD(Buffer.byteLength(TOOLS_LIST)) + TOOLS_LIST, /"\}$/)).text(),
      );
      // (1) Red when the address is answered after the token check (401).
      // (2) Prints both statuses and the health body.
      const facts = { health: health.status, body: health.body, mcp: mcp.status };
      expect(facts, JSON.stringify(facts)).toEqual({
        health: 200,
        body: '{"status":"ok"}',
        mcp: 401,
      });
    });

    it('H4: `/./health` and `http://x/health` are the address; `POST /health` and `/health/`, `//health`, `/Health`, `/healthz` still reach the MCP endpoint', async () => {
      const s = await startServe([], TOKEN);
      const dot = answer(
        (await ask(s.port, 'GET /./health HTTP/1.1\r\nHost: x\r\n\r\n', HEALTH_END)).text(),
      );
      const absolute = answer(
        (await ask(s.port, 'GET http://x/health HTTP/1.1\r\nHost: x\r\n\r\n', HEALTH_END)).text(),
      );
      const post = (
        await ask(
          s.port,
          POST_HEAD(Buffer.byteLength(TOOLS_LIST), '/health', true) + TOOLS_LIST,
          /"tools":\[/,
        )
      ).text();
      const others: Record<string, number | 'no answer'> = {};
      for (const target of ['/health/', '//health', '/Health', '/healthz']) {
        const c = await ask(
          s.port,
          `GET ${target} HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${TOKEN}\r\n\r\n`,
          /\r\n0\r\n\r\n$/,
        );
        others[target] = answer(c.text()).status;
      }
      // (1) Red with a prefix match (`/health/`, `/healthz` answered 200), with a match on the raw
      //     target (`/./health`, `http://x/health` reach the MCP endpoint), and when `POST /health`
      //     is taken by the address.
      // (2) Prints the two address answers, whether `POST /health` got the tool list, and the status
      //     each other target got from the MCP endpoint (406: it asks for `text/event-stream`).
      const facts = {
        dot: [dot.status, dot.body],
        absolute: [absolute.status, absolute.body],
        postReachedMcp: /^HTTP\/1\.1 200/.test(post) && post.includes('"tools":['),
        others,
      };
      expect(facts, JSON.stringify(facts)).toEqual({
        dot: [200, '{"status":"ok"}'],
        absolute: [200, '{"status":"ok"}'],
        postReachedMcp: true,
        others: { '/health/': 406, '//health': 406, '/Health': 406, '/healthz': 406 },
      });
    });

    it('H5: with no drain, a new connection is refused after SIGTERM, and a connection open before it that sends `GET /health` after it gets 503 `{"status":"shutting_down"}`, `connection: close`, then exit 0', async () => {
      const s = await startServe();
      const c = await raw(s.port);
      s.signal('SIGTERM');
      await sleep(150);
      // With no drain the listener closes at the signal: a new connection is refused.
      const newRefused = !(await accepts(s.port));
      await sleep(150);
      c.socket.write(GET_HEALTH);
      const end = performance.now() + 3000;
      while (
        c.seenAt(HEALTH_END) === undefined &&
        c.closedAt() === undefined &&
        performance.now() < end
      ) {
        await sleep(10);
      }
      const exit = await s.exitWithin(5000);
      // (1) Red when the address stays 200 once the stop has begun, and when a new connection is
      //     still accepted after the signal with no drain.
      // (2) Prints the answer, whether the new connection was refused, the exit code and when it
      //     came after the answer (ms).
      const facts = {
        ...answer(c.text()),
        newRefused,
        code: exit?.code,
        afterAnswerMs: round(exit && exit.at - (c.seenAt(HEALTH_END) ?? Infinity)),
      };
      expect(
        { ...facts, afterAnswerMs: facts.afterAnswerMs! <= 2000 },
        JSON.stringify(facts),
      ).toEqual({
        status: 503,
        headers: STOPPING,
        body: '{"status":"shutting_down"}',
        newRefused: true,
        code: 0,
        afterAnswerMs: true,
      });
    });

    it('H6: `--shutdown-drain 3`: /health is 503 at 0.5 s, a new connection at 1 s is answered as usual, none is accepted at 4 s, exit 0 between 3 and 5 s, the drain line once', async () => {
      const s = await startServe(['--shutdown-drain', '3']);
      const t = s.signal('SIGTERM');
      await sleep(500);
      const health = answer((await ask(s.port, GET_HEALTH, HEALTH_END)).text());
      await sleep(Math.max(0, t + 1000 - performance.now()));
      const late = await ask(s.port, POST_HEAD(8) + 'not-json', ANSWER_END);
      await sleep(Math.max(0, t + 4000 - performance.now()));
      const acceptedAt4s = await accepts(s.port);
      const exit = await s.exitWithin(8000);
      // (1) Red when the listener closes at the signal (the 1 s connection is refused), when the
      //     address flips only after the drain (200 at 0.5 s), and when the drain is ignored (exit at
      //     once).
      // (2) Prints the two answers, whether the 4 s connection was accepted, the exit code, when it
      //     came after the signal (ms) and the drain lines.
      const facts = {
        health: [health.status, health.body],
        late: answer(late.text()),
        acceptedAt4s,
        code: exit?.code,
        ms: round(exit && exit.at - t),
        lines: s.drainLines(),
      };
      expect(
        { ...facts, ms: facts.ms! >= 3000 && facts.ms! <= 5000 },
        JSON.stringify(facts),
      ).toEqual({
        health: [503, '{"status":"shutting_down"}'],
        late: {
          status: 400,
          headers: { 'content-type': 'application/json', connection: 'keep-alive' },
          body: expect.stringContaining(
            '"error":"Invalid JSON in request body"',
          ) as unknown as string,
        },
        acceptedAt4s: false,
        code: 0,
        ms: true,
        lines: [
          'realm serve: --shutdown-drain 3 started. /health answers 503 now; connections are accepted until the drain ends. A second Ctrl+C ends it at once.',
        ],
      });
    });

    it("H7: a drain closes nothing: a connection silent for 4 s and a real MCP client's GET stream are open 2 s into a drain of 3; both end within 300 ms of the drain's end, exit 0, no cut line", async () => {
      const s = await startServe(['--shutdown-drain', '3']);
      // Silent for 4 s at the signal: without the drain its 5 s young window would end 1 s after it.
      const silent = await raw(s.port);
      const watch = watchedFetch();
      const client = new Client({ name: 'u2-health', version: '0' });
      client.onerror = () => {};
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${s.port}/`), {
          fetch: watch.fetch,
        }) as unknown as Parameters<Client['connect']>[0],
      );
      onTestFinished(() => client.close().catch(() => {}));
      const startedBy = performance.now() + 5000;
      while (watch.opened() === undefined && performance.now() < startedBy) await sleep(20);
      await sleep(Math.max(0, silent.connectedAt + 4000 - performance.now()));
      const t = s.signal('SIGTERM');
      await sleep(2000);
      const at2s = { stream: watch.ended() === undefined, silent: silent.closedAt() === undefined };
      // The drain's end: the first moment a new connection is refused.
      let refusedAt: number | undefined;
      while (refusedAt === undefined && performance.now() < t + 9000) {
        if (!(await accepts(s.port))) refusedAt = performance.now();
        else await sleep(30);
      }
      const exit = await s.exitWithin(9000);
      // (1) Red when every connection is closed at the signal, when the stop begins at the signal
      //     (the stream ended at once), and when the drain is ignored (the silent connection closed
      //     about 1 s after the signal).
      // (2) Prints whether each was open at 2 s, when the stream ended and the silent connection
      //     closed after the signal (ms), when the first connection was refused, the exit code and
      //     the cut lines.
      const facts = {
        opened: watch.opened() !== undefined,
        at2s,
        streamEndedMs: round((watch.ended() ?? Infinity) - t),
        refusedMs: round((refusedAt ?? Infinity) - t),
        silentClosedMs: round((silent.closedAt() ?? Infinity) - t),
        code: exit?.code,
        cut: s.cutLines(),
      };
      expect(
        {
          ...facts,
          streamEndedMs:
            facts.streamEndedMs! >= 2900 && facts.streamEndedMs! <= facts.refusedMs! + 300,
          refusedMs: facts.refusedMs! >= 2900,
          silentClosedMs:
            facts.silentClosedMs! >= 2900 && facts.silentClosedMs! <= facts.refusedMs! + 300,
        },
        JSON.stringify(facts),
      ).toEqual({
        opened: true,
        at2s: { stream: true, silent: true },
        streamEndedMs: true,
        refusedMs: true,
        silentClosedMs: true,
        code: 0,
        cut: [],
      });
    });

    it('H8: `--shutdown-drain 20` and a second signal during it: exit 1 within 2 s with the second-signal line when a request is in flight; exit 0 within 2 s when none is', async () => {
      const busy = await startServe(['--shutdown-drain', '20']);
      const c = await raw(busy.port);
      c.socket.write(POST_HEAD(8) + 'not-');
      await sleep(300);
      busy.signal('SIGTERM');
      await sleep(300);
      const t1 = busy.signal('SIGTERM');
      const exit1 = await busy.exitWithin(8000);
      const idle = await startServe(['--shutdown-drain', '20']);
      idle.signal('SIGINT');
      await sleep(300);
      const t2 = idle.signal('SIGTERM');
      const exit2 = await idle.exitWithin(8000);
      // (1) Red when the second signal waits for the drain (still running at 8 s), and when the cut
      //     is reported as the grace running out.
      // (2) Prints each exit code, when it came after the second signal (ms) and the cut lines.
      const facts = {
        busy: { code: exit1?.code, ms: round(exit1 && exit1.at - t1), cut: busy.cutLines() },
        idle: { code: exit2?.code, ms: round(exit2 && exit2.at - t2), cut: idle.cutLines() },
      };
      expect(
        {
          busy: { ...facts.busy, ms: facts.busy.ms! <= 2000 },
          idle: { ...facts.idle, ms: facts.idle.ms! <= 2000 },
        },
        JSON.stringify(facts),
      ).toEqual({
        busy: {
          code: 1,
          ms: true,
          cut: ['realm serve: a second signal arrived. Requests cut: 1.'],
        },
        idle: { code: 0, ms: true, cut: [] },
      });
    });

    it('H9: the budget: drain 2 + grace 3 with a request that never finishes exits 1 between 4.5 and 7 s; drain 2 with a silent connection opened at 1.8 s exits 0 by 7.3 s', async () => {
      const busy = await startServe(['--shutdown-drain', '2', '--shutdown-grace', '3']);
      const c = await raw(busy.port);
      c.socket.write(POST_HEAD(8) + 'not-');
      await sleep(300);
      const t1 = busy.signal('SIGTERM');
      const exit1 = await busy.exitWithin(10_000);
      const young = await startServe(['--shutdown-drain', '2']);
      const t2 = young.signal('SIGTERM');
      await sleep(1800);
      await raw(young.port);
      const exit2 = await young.exitWithin(10_000);
      // (1) Red when the grace is counted from the signal (exit 1 at about 3 s), and when a young
      //     connection is left open until the grace's end (exit at about 32 s).
      // (2) Prints each exit code, when it came after the signal (ms) and the cut lines.
      const facts = {
        busy: { code: exit1?.code, ms: round(exit1 && exit1.at - t1), cut: busy.cutLines() },
        young: { code: exit2?.code, ms: round(exit2 && exit2.at - t2), cut: young.cutLines() },
      };
      expect(
        {
          busy: { ...facts.busy, ms: facts.busy.ms! >= 4500 && facts.busy.ms! <= 7000 },
          young: { ...facts.young, ms: facts.young.ms! >= 2000 && facts.young.ms! <= 7300 },
        },
        JSON.stringify(facts),
      ).toEqual({
        busy: {
          code: 1,
          ms: true,
          cut: ['realm serve: --shutdown-grace 3 ran out. Requests cut: 1.'],
        },
        young: { code: 0, ms: true, cut: [] },
      });
    });

    it('H10: `-1` and `--port` end the command with one line; 0 starts and stops; 2147483 starts with no overflow warning and a second signal ends it; `--help` shows the text and `(default: 0)`', async () => {
      const refused = ['-1', '--port'].map((value) => {
        const r = spawnSync(process.execPath, [CLI, 'serve', '--dev', '--shutdown-drain', value], {
          cwd: root,
          env: env(),
          encoding: 'utf8',
          timeout: 20_000,
        });
        return {
          value,
          code: r.status,
          err: r.stderr.split('\n').filter((l) => l !== ''),
          out: r.stdout,
        };
      });
      const zero = await startServe(['--shutdown-drain', '0']);
      const tz = zero.signal('SIGTERM');
      const exitZero = await zero.exitWithin(8000);
      const max = await startServe(['--shutdown-drain', '2147483']);
      max.signal('SIGTERM');
      await sleep(300);
      const drainLine = max.drainLines().length;
      const tm = max.signal('SIGTERM');
      const exitMax = await max.exitWithin(8000);
      const help = spawnSync(process.execPath, [CLI, 'serve', '--help'], {
        cwd: root,
        env: env(),
        encoding: 'utf8',
        timeout: 20_000,
      });
      const text =
        '--shutdown-drain <seconds> Seconds the program keeps serving, with /health answering 503, after Ctrl+C or SIGTERM before the stop begins and it stops accepting connections; a whole number from 0 to 2147483. 0 begins the stop at once. (default: 0)';
      const line = (v: string): string =>
        `error: option '--shutdown-drain <seconds>' argument '${v}' is invalid. --shutdown-drain must be a whole number from 0 to 2147483.`;
      // (1) Red on the base (`unknown option`), when the value is not checked, when 0 waits or
      //     prints a drain line, when 2147483 overflows Node's timer (`TimeoutOverflowWarning`, and
      //     the drain would end at once), and when the help's default changes.
      // (2) Prints each refusal's exit code and output, each start's exit code and time (ms), the
      //     drain lines, whether the warning appeared, and whether the help holds the text.
      const facts = {
        refused,
        zero: {
          code: exitZero?.code,
          ms: round(exitZero && exitZero.at - tz),
          lines: zero.drainLines(),
        },
        max: {
          drainLine,
          code: exitMax?.code,
          ms: round(exitMax && exitMax.at - tm),
          overflow: max.stderr().includes('TimeoutOverflowWarning'),
        },
        help: { code: help.status, holds: help.stdout.replace(/\s+/g, ' ').includes(text) },
      };
      expect(
        {
          ...facts,
          zero: { ...facts.zero, ms: facts.zero.ms! <= 2000 },
          max: { ...facts.max, ms: facts.max.ms! <= 2000 },
        },
        JSON.stringify(facts),
      ).toEqual({
        refused: ['-1', '--port'].map((value) => ({ value, code: 1, err: [line(value)], out: '' })),
        zero: { code: 0, ms: true, lines: [] },
        max: { drainLine: 1, code: 0, ms: true, overflow: false },
        help: { code: 0, holds: true },
      });
    });
  },
);
