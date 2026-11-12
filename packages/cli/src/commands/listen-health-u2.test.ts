// listen-health-u2.test.ts — #960 U2, through the built `realm`: `realm listen`'s health address,
// `--shutdown-drain`, and the path it reserves. `GET`/`HEAD` `/health` answers `200`
// `{"status":"ok"}` without a signature, outside `--max-concurrent`, with no log line; from the first
// Ctrl+C or `SIGTERM` it answers `503` `{"status":"shutting_down"}` with `Connection: close`; with
// `--shutdown-drain N` the server goes on accepting and answering for N seconds before U1's stop
// begins; a second signal ends the drain and the grace at once; a workflow at `/health` stops the
// start.
// Each cell starts `realm listen` on webhook workflows (`--port 0`, a fresh HOME, a fake key), talks
// to it over a raw socket on loopback, and reads what a load balancer, a sender and an operator see:
// the status, headers and body, whether a connection is accepted, the exit code and when it came,
// and listen's lines. Every time is `performance.now()`; each bound is set so that a loaded machine
// can only make a cell later, within its upper bound. On a failing host a cell prints those facts,
// never the environment (the child gets PATH, HOME, a fake key and, where a cell needs it, the test
// secret).
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', '..', 'dist', 'index.js');
const SECRET = 'sec-u2-health';

/** A workflow with one agent step behind a webhook trigger. No run is ever started here. */
const workflow = (id: string, trigger: string): string =>
  `id: ${id}\nname: ${id}\nversion: 1\ntrigger:\n  type: webhook\n${trigger}steps:\n  ask:\n    description: Answer with a short summary.\n    execution: agent\n`;
const NONE = '  auth:\n    mode: none\n';
const at = (path: string): string => `  path: ${path}\n${NONE}`;

let root: string;
let home: string;
/** Writes a workflow folder under the cell's root; returns its name. */
function folder(name: string, text: string): string {
  mkdirSync(join(root, name));
  writeFileSync(join(root, name, 'workflow.yaml'), text, 'utf8');
  return name;
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'realm-u2-listen-'));
  home = join(root, 'home');
  mkdirSync(home);
  folder('wf', workflow('hook-u2', at('/hook-960')));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const env = (): Record<string, string> => ({
  PATH: process.env['PATH'] ?? '',
  HOME: home,
  ANTHROPIC_API_KEY: 'k-fake-u2',
  WH_SECRET: SECRET,
});
const round = (n: number | undefined): number | undefined =>
  n === undefined ? undefined : Math.round(n);

interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
  at: number;
}

interface Listen {
  readonly port: number;
  /** Every line listen wrote after its start line, standard output and error. */
  lines(): string[];
  /** The `listen: shutdown cut requests` lines. */
  cutLines(): string[];
  /** All of standard error. */
  stderr(): string;
  /** Sends a signal; returns when. */
  signal(sig: 'SIGTERM' | 'SIGINT'): number;
  /** The exit, once it has come within `ms`, or undefined. */
  exitWithin(ms: number): Promise<Exit | undefined>;
}

const LISTEN = (dirs: string[]): string[] => [
  'listen',
  ...dirs,
  '--model',
  'm',
  '--provider',
  'anthropic',
  '--port',
  '0',
];

/** Starts the built `realm listen … --port 0`, waits for its start line, and kills it after the cell. */
async function startListen(extra: string[] = [], dirs = ['wf']): Promise<Listen> {
  const proc: ChildProcess = spawn(process.execPath, [CLI, ...LISTEN(dirs), ...extra], {
    cwd: root,
    env: env(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  onTestFinished(() => {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
  });
  let out = '';
  let err = '';
  const after: string[] = [];
  let started = false;
  const take = (chunk: string): void => {
    if (started) after.push(...chunk.split('\n').filter((l) => l !== ''));
  };
  proc.stdout!.on('data', (d: Buffer) => {
    out += d.toString();
    take(d.toString());
  });
  proc.stderr!.on('data', (d: Buffer) => {
    err += d.toString();
    take(d.toString());
  });
  let exit: Exit | undefined;
  const exited = new Promise<Exit>((r) =>
    proc.once('exit', (code, signal) => r((exit = { code, signal, at: performance.now() }))),
  );
  const startedBy = performance.now() + 20_000;
  let port: number | undefined;
  while (port === undefined && exit === undefined && performance.now() < startedBy) {
    const m = /realm listen on 127\.0\.0\.1:(\d+) /.exec(out);
    if (m !== null) port = Number(m[1]);
    else await sleep(20);
  }
  if (port === undefined) {
    throw new Error(
      `listen did not start: exit ${JSON.stringify(exit)}; stderr ${err.slice(0, 400)}`,
    );
  }
  started = true;
  return {
    port,
    lines: () => [...after],
    cutLines: () => err.split('\n').filter((l) => l.startsWith('listen: shutdown cut requests')),
    stderr: () => err,
    signal: (sig) => {
      const when = performance.now();
      proc.kill(sig);
      return when;
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
    const colon = line.indexOf(':');
    const name = line.slice(0, colon).toLowerCase();
    if (['content-type', 'cache-control', 'connection'].includes(name)) {
      headers[name] = line
        .slice(colon + 1)
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

/** Every answer listen sends carries its length: its JSON body ends it. */
const END = /\}$/;
const HEAD_END = /\r\n\r\n$/;

/** Sends one request on a new connection; resolves once `done` matches what arrived, the connection
 *  closes, or `ms` passes. */
async function ask(port: number, request: string, done = END, ms = 3000): Promise<Raw> {
  const c = await raw(port);
  c.socket.write(request);
  const end = performance.now() + ms;
  while (c.seenAt(done) === undefined && c.closedAt() === undefined && performance.now() < end) {
    await sleep(10);
  }
  return c;
}

const GET_HEALTH = 'GET /health HTTP/1.1\r\nHost: x\r\n\r\n';
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
/** `listen`'s request in these cells: a POST to the trigger's path, its body plain text (`415`). */
const POST_HEAD = (length: number, path = '/hook-960'): string =>
  `POST ${path} HTTP/1.1\r\nHost: x\r\nContent-Type: text/plain\r\nContent-Length: ${length}\r\n\r\n`;
const WHOLE = POST_HEAD(8) + 'not-json';
/** The stop line, as listen's logger writes it at level `error`. */
const CUT = (because: string, grace: number): string =>
  `listen: shutdown cut requests {"cut":1,"because":"${because}","grace_seconds":${grace}}`;

describe(
  '#960 U2 `realm listen`: the health address and `--shutdown-drain` (built CLI)',
  { timeout: 120_000 },
  () => {
    it('H1: running, `GET`, `HEAD` and `GET ?x=1` of `/health` answer 200 `{"status":"ok"}`, `application/json`, `no-store` (HEAD without a body)', async () => {
      const s = await startListen();
      const get = answer((await ask(s.port, GET_HEALTH)).text());
      const head = answer(
        (await ask(s.port, 'HEAD /health HTTP/1.1\r\nHost: x\r\n\r\n', HEAD_END)).text(),
      );
      const query = answer(
        (await ask(s.port, 'GET /health?x=1 HTTP/1.1\r\nHost: x\r\n\r\n')).text(),
      );
      // (1) Red on the base (any `GET` is refused 405), with another body, and when the query string
      //     defeats the match.
      // (2) Prints each answer's status, its three headers and its body.
      const facts = { get, head, query };
      expect(facts, JSON.stringify(facts)).toEqual({
        get: { status: 200, headers: OK, body: '{"status":"ok"}' },
        head: { status: 200, headers: OK, body: '' },
        query: { status: 200, headers: OK, body: '{"status":"ok"}' },
      });
    });

    it('H2: with a `shared_secret` workflow mounted, `GET /health` is 200 without the secret while an unsigned delivery is refused 403', async () => {
      folder(
        'secret',
        workflow(
          'secret-u2',
          '  path: /secret\n  auth:\n    mode: shared_secret\n    header: X-Webhook-Token\n    secret_from: WH_SECRET\n',
        ),
      );
      const s = await startListen([], ['secret']);
      const health = answer((await ask(s.port, GET_HEALTH)).text());
      const body = '{"a":1}';
      const unsigned = answer(
        (
          await ask(
            s.port,
            `POST /secret HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body}`,
          )
        ).text(),
      );
      // (1) Red when the address is answered after the method check (405).
      // (2) Prints both statuses and the health body.
      const facts = { health: health.status, body: health.body, unsigned: unsigned.status };
      expect(facts, JSON.stringify(facts)).toEqual({
        health: 200,
        body: '{"status":"ok"}',
        unsigned: 403,
      });
    });

    it('H3: `--max-concurrent 1` full: `GET /health` is 200 and its connection stays open, the next delivery is 503, and nothing about the probe is logged at `debug`', async () => {
      const s = await startListen([
        '--max-concurrent',
        '1',
        '--log-level',
        'debug',
        '--body-timeout-ms',
        '30000',
      ]);
      const busy = await raw(s.port);
      busy.socket.write(POST_HEAD(8) + 'not-');
      await sleep(300);
      const probe = await ask(s.port, GET_HEALTH);
      await sleep(300);
      const probeOpen = probe.closedAt() === undefined;
      const next = answer((await ask(s.port, WHOLE)).text());
      // (1) Red when the probe counts toward the limit (503) or goes through the refusal path (a
      //     `webhook: refused` line, its connection closed), and when it is logged.
      // (2) Prints the probe's answer, whether its connection stayed open, the next delivery's
      //     status, and every line listen wrote that mentions `health`.
      const facts = {
        probe: [answer(probe.text()).status, answer(probe.text()).body],
        probeOpen,
        next: next.status,
        mentions: s.lines().filter((l) => l.toLowerCase().includes('health')),
      };
      expect(facts, JSON.stringify(facts)).toEqual({
        probe: [200, '{"status":"ok"}'],
        probeOpen: true,
        next: 503,
        mentions: [],
      });
    });

    it('H4: `/./health` and `http://x/health` are the address; `POST /health` 403, `GET /health/` 405, an HTTP/1.1 `GET /health` without `Host` 400 `host_required`', async () => {
      const s = await startListen();
      const dot = answer((await ask(s.port, 'GET /./health HTTP/1.1\r\nHost: x\r\n\r\n')).text());
      const absolute = answer(
        (await ask(s.port, 'GET http://x/health HTTP/1.1\r\nHost: x\r\n\r\n')).text(),
      );
      const post = answer((await ask(s.port, POST_HEAD(0, '/health'))).text());
      const slash = answer((await ask(s.port, 'GET /health/ HTTP/1.1\r\nHost: x\r\n\r\n')).text());
      const noHost = answer((await ask(s.port, 'GET /health HTTP/1.1\r\n\r\n')).text());
      // (1) Red with a prefix match (`/health/` answered 200), with a match on the raw target
      //     (`/./health`, `http://x/health` refused 405), when `POST /health` is taken by the
      //     address, and when the address comes before the `Host` check.
      // (2) Prints each answer's status and body.
      const facts = {
        dot: [dot.status, dot.body],
        absolute: [absolute.status, absolute.body],
        post: [post.status, post.body],
        slash: [slash.status, slash.body],
        noHost: [noHost.status, noHost.body],
      };
      expect(facts, JSON.stringify(facts)).toEqual({
        dot: [200, '{"status":"ok"}'],
        absolute: [200, '{"status":"ok"}'],
        post: [403, '{"error":"forbidden"}'],
        slash: [405, '{"error":"method_not_allowed"}'],
        noHost: [400, '{"error":"host_required"}'],
      });
    });

    it('H5: with no drain, a new connection is refused after SIGTERM, and a connection open before it that sends `GET /health` after it gets 503 `{"status":"shutting_down"}`, `connection: close`, then exit 0', async () => {
      const s = await startListen();
      const c = await raw(s.port);
      s.signal('SIGTERM');
      await sleep(150);
      // With no drain the listener closes at the signal: a new connection is refused.
      const newRefused = !(await accepts(s.port));
      await sleep(150);
      c.socket.write(GET_HEALTH);
      const end = performance.now() + 3000;
      while (c.seenAt(END) === undefined && c.closedAt() === undefined && performance.now() < end) {
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
        afterAnswerMs: round(exit && exit.at - (c.seenAt(END) ?? Infinity)),
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

    it('H6: `--shutdown-drain 3`: /health is 503 at 0.5 s, a new connection at 1 s is answered as usual, none is accepted at 4 s, exit 0 between 3 and 5 s, `listen: draining` once after `listen: shutting down`', async () => {
      const s = await startListen(['--shutdown-drain', '3']);
      const t = s.signal('SIGTERM');
      await sleep(500);
      const health = answer((await ask(s.port, GET_HEALTH)).text());
      await sleep(Math.max(0, t + 1000 - performance.now()));
      const late = answer((await ask(s.port, WHOLE)).text());
      await sleep(Math.max(0, t + 4000 - performance.now()));
      const acceptedAt4s = await accepts(s.port);
      const exit = await s.exitWithin(8000);
      // (1) Red when the listener closes at the signal (the 1 s connection is refused), when the
      //     address flips only after the drain (200 at 0.5 s), and when the drain is ignored (exit at
      //     once).
      // (2) Prints the two answers, whether the 4 s connection was accepted, the exit code, when it
      //     came after the signal (ms) and the stop's lines.
      const facts = {
        health: [health.status, health.body],
        late,
        acceptedAt4s,
        code: exit?.code,
        ms: round(exit && exit.at - t),
        lines: s.lines().filter((l) => /^listen: (shutting down|draining)/.test(l)),
      };
      expect(
        { ...facts, ms: facts.ms! >= 3000 && facts.ms! <= 5000 },
        JSON.stringify(facts),
      ).toEqual({
        health: [503, '{"status":"shutting_down"}'],
        late: {
          status: 415,
          headers: { 'content-type': 'application/json', connection: 'keep-alive' },
          body: '{"error":"unsupported_media_type"}',
        },
        acceptedAt4s: false,
        code: 0,
        ms: true,
        lines: ['listen: shutting down {"reason":"SIGTERM"}', 'listen: draining {"seconds":3}'],
      });
    });

    it('H7: a drain closes nothing: a connection silent for 4 s is open 2 s into a drain of 3, and is ended by the stop when the drain ends; exit 0, no cut line', async () => {
      // `--body-timeout-ms 30000`: listen's header timeout is its body timeout, and the default 5 s
      // would end the silent connection itself.
      const s = await startListen(['--shutdown-drain', '3', '--body-timeout-ms', '30000']);
      // Silent for 4 s at the signal: without the drain its 5 s young window would end 1 s after it.
      const silent = await raw(s.port);
      await sleep(4000);
      const t = s.signal('SIGTERM');
      await sleep(2000);
      const openAt2s = silent.closedAt() === undefined;
      // The drain's end: the first moment a new connection is refused.
      let refusedAt: number | undefined;
      while (refusedAt === undefined && performance.now() < t + 9000) {
        if (!(await accepts(s.port))) refusedAt = performance.now();
        else await sleep(30);
      }
      const exit = await s.exitWithin(10_000);
      // (1) Red when every connection is closed at the signal (closed before 2 s), and when the
      //     drain is ignored (closed about 1 s after the signal).
      // (2) Prints whether it was open at 2 s, when it closed and when the first connection was
      //     refused after the signal (ms), the exit code and the cut lines.
      const facts = {
        openAt2s,
        closedMs: round((silent.closedAt() ?? Infinity) - t),
        refusedMs: round((refusedAt ?? Infinity) - t),
        code: exit?.code,
        cut: s.cutLines(),
      };
      expect(
        {
          ...facts,
          closedMs: facts.closedMs! >= 2900 && facts.closedMs! <= facts.refusedMs! + 300,
          refusedMs: facts.refusedMs! >= 2900,
        },
        JSON.stringify(facts),
      ).toEqual({ openAt2s: true, closedMs: true, refusedMs: true, code: 0, cut: [] });
    });

    it('H8: `--shutdown-drain 20` and a second signal during it: exit 1 within 2 s with the second-signal line when a request is in flight; exit 0 within 2 s when none is', async () => {
      const busy = await startListen(['--shutdown-drain', '20']);
      const c = await raw(busy.port);
      c.socket.write(POST_HEAD(8) + 'not-');
      await sleep(300);
      busy.signal('SIGTERM');
      await sleep(300);
      const t1 = busy.signal('SIGTERM');
      const exit1 = await busy.exitWithin(8000);
      const idle = await startListen(['--shutdown-drain', '20']);
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
        busy: { code: 1, ms: true, cut: [CUT('second_signal', 30)] },
        idle: { code: 0, ms: true, cut: [] },
      });
    });

    it('H9: the budget (`--body-timeout-ms 30000`): drain 2 + grace 3 with a request that never finishes exits 1 between 4.5 and 7 s; drain 2 with a silent connection opened at 1.8 s exits 0 by 7.3 s', async () => {
      const slow = ['--body-timeout-ms', '30000', '--shutdown-drain', '2'];
      const busy = await startListen([...slow, '--shutdown-grace', '3']);
      const c = await raw(busy.port);
      c.socket.write(POST_HEAD(8) + 'not-');
      await sleep(300);
      const t1 = busy.signal('SIGTERM');
      const exit1 = await busy.exitWithin(10_000);
      const young = await startListen(slow);
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
        busy: { code: 1, ms: true, cut: [CUT('grace_ran_out', 3)] },
        young: { code: 0, ms: true, cut: [] },
      });
    });

    it('H10: `-1` and `--port` end the command with one line; 0 starts and stops; 2147483 starts with no overflow warning and a second signal ends it; `--help` shows the text and `(default: 0)`', async () => {
      const refused = ['-1', '--port'].map((value) => {
        const r = spawnSync(process.execPath, [CLI, ...LISTEN(['wf']), '--shutdown-drain', value], {
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
      const zero = await startListen(['--shutdown-drain', '0']);
      const tz = zero.signal('SIGTERM');
      const exitZero = await zero.exitWithin(8000);
      const max = await startListen(['--shutdown-drain', '2147483']);
      max.signal('SIGTERM');
      await sleep(300);
      const drainLine = max.lines().filter((l) => l.startsWith('listen: draining')).length;
      const tm = max.signal('SIGTERM');
      const exitMax = await max.exitWithin(8000);
      const help = spawnSync(process.execPath, [CLI, 'listen', '--help'], {
        cwd: root,
        env: env(),
        encoding: 'utf8',
        timeout: 20_000,
      });
      const text =
        '--shutdown-drain <seconds> Seconds the program keeps serving, with /health answering 503, after Ctrl+C or SIGTERM before the stop begins and it stops accepting connections; a whole number from 0 to 2147483. 0 begins the stop at once. (default: 0)';
      const line = (v: string): string =>
        `error: option '--shutdown-drain <seconds>' argument '${v}' is invalid. --shutdown-drain must be a whole number from 0 to 2147483.`;
      // (1) Red on the base (`unknown option`), when the value is not checked, when 0 waits or logs
      //     a drain line, when 2147483 overflows Node's timer (`TimeoutOverflowWarning`, and the
      //     drain would end at once), and when the help's default changes.
      // (2) Prints each refusal's exit code and output, each start's exit code and time (ms), the
      //     drain lines, whether the warning appeared, and whether the help holds the text.
      const facts = {
        refused,
        zero: {
          code: exitZero?.code,
          ms: round(exitZero && exitZero.at - tz),
          drain: zero.lines().filter((l) => l.startsWith('listen: draining')),
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
        zero: { code: 0, ms: true, drain: [] },
        max: { drainLine: 1, code: 0, ms: true, overflow: false },
        help: { code: 0, holds: true },
      });
    });

    it('H11: a workflow at `/health` (its `trigger.path`, or the id `health` with no path) stops the start with one line; `/hooks/health`, `/health/` and `/healthz` start; the collision line is unchanged', async () => {
      folder('reserved', workflow('r-u2', at('/health')));
      folder('byid', workflow('health', NONE));
      folder('open', workflow('open', NONE));
      folder('dup', workflow('dup', at('/open')));
      const refusal = (dirs: string[]) => {
        const r = spawnSync(process.execPath, [CLI, ...LISTEN(dirs)], {
          cwd: root,
          env: env(),
          encoding: 'utf8',
          timeout: 20_000,
        });
        return {
          code: r.status,
          errors: r.stderr.split('\n').filter((l) => l.startsWith('Error:')),
          listened: r.stdout.includes('realm listen on'),
        };
      };
      const reserved = (id: string): string =>
        `Error: listen: path '/health' is reserved for the health address — workflow '${id}' cannot use it; give it another trigger.path`;
      const started: Record<string, number | null | undefined> = {};
      for (const [name, path] of [
        ['under', '/hooks/health'],
        ['slash', '/health/'],
        ['z', '/healthz'],
      ] as const) {
        folder(name, workflow(`ok-${name}`, at(path)));
        const s = await startListen([], [name]);
        s.signal('SIGTERM');
        started[path] = (await s.exitWithin(8000))?.code;
      }
      // (1) Red on the base (a workflow at `/health` starts), when the default path of the id
      //     `health` is not checked, with a prefix check (`/hooks/health`, `/health/`, `/healthz`
      //     refused), and when the collision line changes.
      // (2) Prints each refusal's exit code, its `Error:` lines and whether it listened, and each
      //     start's exit code.
      const facts = {
        byPath: refusal(['reserved']),
        byId: refusal(['byid']),
        collision: refusal(['open', 'dup']),
        started,
      };
      expect(facts, JSON.stringify(facts)).toEqual({
        byPath: { code: 1, errors: [reserved('r-u2')], listened: false },
        byId: { code: 1, errors: [reserved('health')], listened: false },
        collision: {
          code: 1,
          errors: [
            "Error: listen: path collision on '/open' — workflow 'dup' conflicts with 'open'",
          ],
          listened: false,
        },
        started: { '/hooks/health': 0, '/health/': 0, '/healthz': 0 },
      });
    });
  },
);
