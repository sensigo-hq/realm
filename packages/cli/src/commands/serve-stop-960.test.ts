// serve-stop-960.test.ts — issue #960, through the built `realm`: `realm serve` stops when asked.
// On Ctrl+C or SIGTERM it stops accepting, ends a connection waiting between requests at once,
// gives a connection that has sent nothing up to 5 s, gives requests being answered
// `--shutdown-grace` seconds (30 by default), cuts everything on a second signal, and exits 0, or 1
// after one line when it had to cut requests.
// Each cell starts `realm serve --dev --port 0` with a fresh HOME, talks to it over a raw socket on
// loopback (or with the MCP SDK's own client), and reads what an operator and a client see: the
// exit code and when it came, the stop line, and the answer's status and `connection` header.
// Every time is `performance.now()`; each bound is set so that a loaded machine can only make a cell
// later, within its upper bound. On a failing host a cell prints those facts and the `realm serve:`
// lines of standard error, never the environment (the child gets PATH, HOME and the test's own
// folder only).
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', '..', 'dist', 'index.js');

let root: string;
let home: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'realm-960-serve-'));
  home = join(root, 'home');
  mkdirSync(home);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const env = (): Record<string, string> => ({
  PATH: process.env['PATH'] ?? '',
  HOME: home,
  STOP960_DIR: root,
});
const round = (n: number | undefined): number | undefined =>
  n === undefined ? undefined : Math.round(n);

interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
  at: number;
}

interface Serve {
  readonly proc: ChildProcess;
  readonly port: number;
  /** The lines of standard error that start with `realm serve:` (the stop lines). */
  stopLines(): string[];
  /** Sends a signal; returns when. */
  signal(sig: 'SIGTERM' | 'SIGINT'): number;
  /** The exit, once it has come within `ms`, or undefined. */
  exitWithin(ms: number): Promise<Exit | undefined>;
}

/** Starts the built `realm serve --dev --port 0`, waits for its start line, and kills it after the cell. */
async function startServe(extra: string[] = [], cwd = root): Promise<Serve> {
  const proc = spawn(process.execPath, [CLI, 'serve', '--dev', '--port', '0', ...extra], {
    cwd,
    env: env(),
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
  return {
    proc,
    port,
    stopLines: () => err.split('\n').filter((l) => l.startsWith('realm serve:')),
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
  /** When the received text first matched `re`. */
  seenAt(re: RegExp): number | undefined;
}

/** A raw connection to the server; destroyed after the cell. */
function raw(port: number): Promise<Raw> {
  return new Promise((resolve) => {
    let bytes = '';
    const seen = new Map<RegExp, number>();
    const watch: RegExp[] = [];
    const socket = connect(port, '127.0.0.1', () =>
      resolve({
        socket,
        connectedAt: performance.now(),
        text: () => bytes,
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

/** `serve`'s request in these cells: a POST to `/`, as an MCP client sends it. */
const POST_HEAD = (length: number): string =>
  'POST / HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n' +
  `Accept: application/json, text/event-stream\r\nContent-Length: ${length}\r\n\r\n`;
const TOOLS_LIST = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}';
const WHOLE = POST_HEAD(Buffer.byteLength(TOOLS_LIST)) + TOOLS_LIST;
/** The end of an answer: a chunked body's last chunk, or a body with its length. */
const ANSWER_END = /\r\n0\r\n\r\n$|"error":"Invalid JSON in request body"\}$/;

/** Waits until `pred` holds or `ms` passes. */
async function until(pred: () => boolean, ms: number): Promise<void> {
  const end = performance.now() + ms;
  while (!pred() && performance.now() < end) await sleep(10);
}

describe('#960 `realm serve` stops when asked (built CLI)', { timeout: 120_000 }, () => {
  it('B1: a connection that has sent nothing: exit 0 about 5 s after it connected, no stop line', async () => {
    const s = await startServe();
    const c = await raw(s.port);
    s.signal('SIGTERM');
    const exit = await s.exitWithin(10_000);
    // (1) Red on the base (it is still running at 15 s), with no young window (exit at once), and
    //     with a 10 s window.
    // (2) Prints the exit code, when it came after the connection (ms) and the stop lines.
    const facts = {
      code: exit?.code,
      ms: round(exit && exit.at - c.connectedAt),
      lines: s.stopLines(),
    };
    expect(
      { code: facts.code, inWindow: facts.ms! >= 4500 && facts.ms! <= 8000, lines: facts.lines },
      JSON.stringify(facts),
    ).toEqual({ code: 0, inWindow: true, lines: [] });
  });

  it("B2: half of the first request's headers: exit 0 about 5 s after it connected, no stop line", async () => {
    const s = await startServe();
    const c = await raw(s.port);
    c.socket.write('POST / HTTP/1.1\r\nHost: x\r\n');
    await sleep(100);
    s.signal('SIGTERM');
    const exit = await s.exitWithin(10_000);
    // (1) Red on the base (still running), with no window, and with a 10 s window.
    // (2) Prints the exit code, when it came after the connection (ms) and the stop lines.
    const facts = {
      code: exit?.code,
      ms: round(exit && exit.at - c.connectedAt),
      lines: s.stopLines(),
    };
    expect(
      { code: facts.code, inWindow: facts.ms! >= 4500 && facts.ms! <= 8000, lines: facts.lines },
      JSON.stringify(facts),
    ).toEqual({ code: 0, inWindow: true, lines: [] });
  });

  it('B3: a whole request sent 500 ms after SIGTERM on a silent connection is answered with `connection: close`, then exit 0', async () => {
    const s = await startServe();
    const c = await raw(s.port);
    s.signal('SIGTERM');
    await sleep(500);
    c.socket.write(WHOLE);
    await until(() => c.seenAt(ANSWER_END) !== undefined, 5000);
    const exit = await s.exitWithin(5000);
    // (1) Red on the base: the answer says `keep-alive` and the exit comes about 6 s later.
    // (2) Prints the answer's status and header, the exit code and when it came after the answer.
    const facts = {
      ...head(c.text()),
      code: exit?.code,
      afterAnswerMs: round(exit && exit.at - (c.seenAt(ANSWER_END) ?? Infinity)),
    };
    expect(
      { ...facts, afterAnswerMs: facts.afterAnswerMs! <= 2000 },
      JSON.stringify(facts),
    ).toEqual({ status: 200, connection: 'close', code: 0, afterAnswerMs: true });
  });

  it('B4: one answered request, then half the headers of a second: exit 0 at once', async () => {
    const s = await startServe();
    const c = await raw(s.port);
    c.socket.write(WHOLE);
    await until(() => c.seenAt(ANSWER_END) !== undefined, 5000);
    c.socket.write('POST / HTTP/1.1\r\nHost: x\r\n');
    await sleep(100);
    const t = s.signal('SIGTERM');
    const exit = await s.exitWithin(8000);
    // (1) Red on the base (exit about 5.9 s later: Node's keep-alive timeout).
    // (2) Prints the first answer's status, the exit code and when it came after the signal.
    const facts = {
      status: head(c.text()).status,
      code: exit?.code,
      ms: round(exit && exit.at - t),
    };
    expect({ ...facts, ms: facts.ms! <= 2000 }, JSON.stringify(facts)).toEqual({
      status: 200,
      code: 0,
      ms: true,
    });
  });

  it('B5: a body that finishes 2 s after SIGTERM: its answer (400) comes whole with `connection: close`, then exit 0', async () => {
    const s = await startServe();
    const c = await raw(s.port);
    c.socket.write(POST_HEAD(8) + 'not-');
    await sleep(300);
    s.signal('SIGTERM');
    await sleep(2000);
    c.socket.write('json');
    await until(() => c.seenAt(ANSWER_END) !== undefined, 5000);
    const exit = await s.exitWithin(5000);
    // (1) Red on the base: the answer says `keep-alive` and the exit comes about 6 s later.
    // (2) Prints the answer's status, header and body, the exit code and when it came after it.
    // The answer is chunked: its JSON, then the last chunk (`0`), so it came whole.
    const rest = c.text().split('\r\n\r\n').slice(1).join('\r\n\r\n');
    const facts = {
      ...head(c.text()),
      body: /\{[^{}]*\}/.exec(rest)?.[0],
      whole: rest.endsWith('\r\n0\r\n\r\n'),
      code: exit?.code,
      afterAnswerMs: round(exit && exit.at - (c.seenAt(ANSWER_END) ?? Infinity)),
    };
    expect(
      { ...facts, afterAnswerMs: facts.afterAnswerMs! <= 2000 },
      JSON.stringify(facts),
    ).toEqual({
      status: 400,
      connection: 'close',
      body: '{"error":"Invalid JSON in request body"}',
      whole: true,
      code: 0,
      afterAnswerMs: true,
    });
  });

  it('B6: `--shutdown-grace 1` and a body that never completes: exit 1 after the grace, one line saying one request was cut', async () => {
    const s = await startServe(['--shutdown-grace', '1']);
    const c = await raw(s.port);
    c.socket.write(POST_HEAD(8) + 'not-');
    await sleep(300);
    const t = s.signal('SIGTERM');
    const exit = await s.exitWithin(8000);
    // (1) Red when the grace's timer does nothing (still running at 8 s); on the base the option
    //     is refused.
    // (2) Prints the exit code, when it came after the signal (ms) and the stop lines.
    const facts = { code: exit?.code, ms: round(exit && exit.at - t), lines: s.stopLines() };
    expect(
      { code: facts.code, inGrace: facts.ms! >= 800 && facts.ms! <= 5000, lines: facts.lines },
      JSON.stringify(facts),
    ).toEqual({
      code: 1,
      inGrace: true,
      lines: ['realm serve: --shutdown-grace 1 ran out. Requests cut: 1.'],
    });
  });

  it('B7: `--shutdown-grace 600` and a second SIGTERM 300 ms later: exit 1 at once, the second-signal line', async () => {
    const s = await startServe(['--shutdown-grace', '600']);
    const c = await raw(s.port);
    c.socket.write(POST_HEAD(8) + 'not-');
    await sleep(300);
    s.signal('SIGTERM');
    await sleep(300);
    const t = s.signal('SIGTERM');
    const exit = await s.exitWithin(8000);
    // (1) Red when the second signal is not wired (the stop waits its 600 s grace).
    // (2) Prints the exit code, when it came after the second signal (ms) and the stop lines.
    const facts = { code: exit?.code, ms: round(exit && exit.at - t), lines: s.stopLines() };
    expect({ ...facts, ms: facts.ms! <= 2000 }, JSON.stringify(facts)).toEqual({
      code: 1,
      ms: true,
      lines: ['realm serve: a second signal arrived. Requests cut: 1.'],
    });
  });

  it('B8: SIGINT as the first signal works as SIGTERM: `--shutdown-grace 1`, exit 1 after the grace, the line', async () => {
    const s = await startServe(['--shutdown-grace', '1']);
    const c = await raw(s.port);
    c.socket.write(POST_HEAD(8) + 'not-');
    await sleep(300);
    const t = s.signal('SIGINT');
    const exit = await s.exitWithin(8000);
    // (1) Red when SIGINT keeps the old handler (`server.close()` alone: still running at 8 s).
    // (2) Prints the exit code, when it came after the signal (ms) and the stop lines.
    const facts = { code: exit?.code, ms: round(exit && exit.at - t), lines: s.stopLines() };
    expect(
      { code: facts.code, inGrace: facts.ms! >= 800 && facts.ms! <= 5000, lines: facts.lines },
      JSON.stringify(facts),
    ).toEqual({
      code: 1,
      inGrace: true,
      lines: ['realm serve: --shutdown-grace 1 ran out. Requests cut: 1.'],
    });
  });

  it('B9: `--shutdown-grace 0`: a request in flight is cut at once (exit 1); with only a silent connection, exit 0 at once', async () => {
    const busy = await startServe(['--shutdown-grace', '0']);
    const c1 = await raw(busy.port);
    c1.socket.write(POST_HEAD(8) + 'not-');
    await sleep(300);
    const t1 = busy.signal('SIGTERM');
    const exit1 = await busy.exitWithin(8000);
    const silent = await startServe(['--shutdown-grace', '0']);
    await raw(silent.port);
    await sleep(100);
    const t2 = silent.signal('SIGTERM');
    const exit2 = await silent.exitWithin(8000);
    // (1) Red when 0 is read as 30 (the request waits 30 s; the silent connection 5 s).
    // (2) Prints each exit code, when it came after the signal (ms) and the stop lines.
    const facts = {
      busy: { code: exit1?.code, ms: round(exit1 && exit1.at - t1), lines: busy.stopLines() },
      silent: { code: exit2?.code, ms: round(exit2 && exit2.at - t2), lines: silent.stopLines() },
    };
    expect(
      {
        busy: { ...facts.busy, ms: facts.busy.ms! <= 2000 },
        silent: { ...facts.silent, ms: facts.silent.ms! <= 2000 },
      },
      JSON.stringify(facts),
    ).toEqual({
      busy: {
        code: 1,
        ms: true,
        lines: ['realm serve: --shutdown-grace 0 ran out. Requests cut: 1.'],
      },
      silent: { code: 0, ms: true, lines: [] },
    });
  });

  it('B10: a value that is not a whole number from 0 to 2147483 ends the command with one line; 0, 30 and 2147483 start and stop', async () => {
    const refused = ['abc', '-1', '1.5', '', '2147484', '--port'].map((value) => {
      const r = spawnSync(process.execPath, [CLI, 'serve', '--dev', '--shutdown-grace', value], {
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
    const accepted: { value: string; code: number | null | undefined }[] = [];
    for (const value of ['0', '30', '2147483']) {
      const s = await startServe(['--shutdown-grace', value]);
      s.signal('SIGTERM');
      accepted.push({ value, code: (await s.exitWithin(8000))?.code });
    }
    const line = (v: string): string =>
      `error: option '--shutdown-grace <seconds>' argument '${v}' is invalid. --shutdown-grace must be a whole number from 0 to 2147483.`;
    // (1) Red on the base (`unknown option`), when the range or the digits-only check changes, or
    //     when an accepted value no longer starts.
    // (2) Prints each value's exit code, standard error and standard output.
    expect({ refused, accepted }, JSON.stringify({ refused, accepted })).toEqual({
      refused: ['abc', '-1', '1.5', '', '2147484', '--port'].map((value) => ({
        value,
        code: 1,
        err: [line(value)],
        out: '',
      })),
      accepted: [
        { value: '0', code: 0 },
        { value: '30', code: 0 },
        { value: '2147483', code: 0 },
      ],
    });
  });

  it('B11: `--help` shows the option, its text and its default of 30', () => {
    const r = spawnSync(process.execPath, [CLI, 'serve', '--help'], {
      cwd: root,
      env: env(),
      encoding: 'utf8',
      timeout: 20_000,
    });
    const help = r.stdout.replace(/\s+/g, ' ');
    const text =
      '--shutdown-grace <seconds> Seconds that requests being answered get to finish after Ctrl+C or SIGTERM, a whole number from 0 to 2147483. When it runs out they are cut and the exit code is 1; 0 cuts them at once. (default: 30)';
    // (1) Red on the base (no such option), and when the text or the default changes.
    // (2) Prints the exit code and whether the help holds the text.
    const facts = { code: r.status, holds: help.includes(text) };
    expect(facts, JSON.stringify(facts)).toEqual({ code: 0, holds: true });
  });

  it('B12: a real MCP client that stays connected (its notification stream open): SIGTERM, exit 0 at once, no stop line', async () => {
    const s = await startServe();
    const client = new Client({ name: 'stop-960', version: '0' });
    client.onerror = () => {};
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${s.port}/`),
      ) as unknown as Parameters<Client['connect']>[0],
    );
    onTestFinished(() => client.close().catch(() => {}));
    const tools = (await client.listTools()).tools.length;
    await sleep(500);
    const t = s.signal('SIGTERM');
    const exit = await s.exitWithin(8000);
    // (1) Red on the base (still running after 10 s, AUD-960-22), and when a held stream is
    //     counted as a request in flight (exit 1 after the grace).
    // (2) Prints how many tools were listed, the exit code, when it came (ms) and the stop lines.
    const facts = {
      listed: tools > 0,
      code: exit?.code,
      ms: round(exit && exit.at - t),
      lines: s.stopLines(),
    };
    expect({ ...facts, ms: facts.ms! <= 3000 }, JSON.stringify(facts)).toEqual({
      listed: true,
      code: 0,
      ms: true,
      lines: [],
    });
  });

  describe('B13: a tool call held in flight, its step an `auto` step whose handler waits for the test', () => {
    const PROJ = (): string => join(root, 'proj');
    /** Registers `stop-960` (one `auto` step, `slow`) in this HOME; `slow` waits for `<root>/release`. */
    function project(): void {
      mkdirSync(PROJ());
      writeFileSync(
        join(PROJ(), 'workflow.yaml'),
        'id: stop-960\nname: stop 960\nversion: 1\nsteps:\n  slow:\n    description: Wait for the test.\n    execution: auto\n    handler: slow\n',
        'utf8',
      );
      writeFileSync(
        join(PROJ(), 'slow.mjs'),
        [
          "import { existsSync, writeFileSync } from 'node:fs';",
          'const dir = process.env.STOP960_DIR;',
          "export default { handlers: { slow: { id: 'slow', async execute() {",
          "  writeFileSync(dir + '/started', 'x');",
          "  while (!existsSync(dir + '/release')) await new Promise((r) => setTimeout(r, 20));",
          '  return { data: { ok: true } };',
          '} } } };',
          '',
        ].join('\n'),
        'utf8',
      );
      const reg = realm(['workflow', 'register', 'workflow.yaml']);
      if (reg.code !== 0) throw new Error(`fixture: register failed: ${reg.err.join(' | ')}`);
    }
    function realm(args: string[]): { code: number | null; out: string[]; err: string[] } {
      const r = spawnSync(process.execPath, [CLI, ...args], {
        cwd: PROJ(),
        env: env(),
        encoding: 'utf8',
        timeout: 30_000,
      });
      const lines = (t: string): string[] =>
        t
          .split(root)
          .join('<dir>')
          .split('\n')
          .filter((l) => l !== '');
      return { code: r.status, out: lines(r.stdout), err: lines(r.stderr) };
    }
    const START_RUN = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'start_run', arguments: { workflow_id: 'stop-960' } },
    });

    /** serve with the module, the `start_run` call sent, and the handler running. */
    async function held(grace: string): Promise<{ s: Serve; c: Raw }> {
      project();
      const s = await startServe(
        ['--extensions-module', join(PROJ(), 'slow.mjs'), '--shutdown-grace', grace],
        PROJ(),
      );
      const c = await raw(s.port);
      c.socket.write(POST_HEAD(Buffer.byteLength(START_RUN)) + START_RUN);
      await until(() => existsSync(join(root, 'started')), 20_000);
      await sleep(200);
      return { s, c };
    }

    it("(a) SIGTERM with a long grace: the call's answer comes when the step finishes, then exit 0 at once, no stop line", async () => {
      const { s, c } = await held('600');
      s.signal('SIGTERM');
      await sleep(300);
      writeFileSync(join(root, 'release'), 'x');
      const ANSWERED = /\\"status\\": \\"ok\\"/;
      await until(() => c.seenAt(ANSWERED) !== undefined, 5000);
      const exit = await s.exitWithin(5000);
      // (1) Red on the base (the client's connection keeps it running), and when an answer whose
      //     head was written before the signal is left open after it ends (exit 1 at 600 s).
      // (2) Prints whether the answer came, the exit code, when it came after the answer (ms) and
      //     the stop lines.
      const facts = {
        answered: c.seenAt(ANSWERED) !== undefined,
        code: exit?.code,
        afterAnswerMs: round(exit && exit.at - (c.seenAt(ANSWERED) ?? Infinity)),
        lines: s.stopLines(),
      };
      expect(
        { ...facts, afterAnswerMs: facts.afterAnswerMs! <= 2000 },
        JSON.stringify(facts),
      ).toEqual({ answered: true, code: 0, afterAnswerMs: true, lines: [] });
    });

    it('(b) cut with `--shutdown-grace 0`: what `realm run inspect`, `realm run list --stuck` and `realm run reclaim` then show, and the reclaim that frees the step', async () => {
      const { s } = await held('0');
      s.signal('SIGTERM');
      const exit = await s.exitWithin(8000);
      const id = /^([0-9a-f-]{36}) /.exec(realm(['run', 'list']).out[0] ?? '')?.[1] ?? '<no run>';
      const inspect = realm(['run', 'inspect', id]).out;
      const stuck = realm(['run', 'list', '--stuck']).out;
      const reclaim = realm(['run', 'reclaim', id]).out;
      const forced = realm(['run', 'reclaim', id, '--step', 'slow', '--force']);
      const after = realm(['run', 'inspect', id]).out;
      // (1) Red when the cut no longer leaves the step taken by `realm serve`, when `--stuck` starts
      //     listing such a run at once, when reclaim no longer shows the claim as healthy with its
      //     deadline, or when `--step … --force` no longer frees it: the page's sentence is then
      //     untrue. On the base `--shutdown-grace` is refused.
      // (2) Prints the exit, the stop lines and each command's lines, the run id and the folder as
      //     placeholders.
      const facts = {
        code: exit?.code,
        lines: s.stopLines(),
        inProgress: inspect.filter((l) => l.startsWith('In Progress:') || l.startsWith('  slow:')),
        stuck,
        reclaimSays: reclaim.filter((l) => l.startsWith('  • slow:')),
        forced: { code: forced.code, out: forced.out },
        owed: after.filter((l) => l.startsWith('Owed to the engine:')),
      };
      const shown = JSON.stringify(facts).split(id).join('<run>');
      expect(
        {
          code: facts.code,
          lines: facts.lines,
          inProgress: facts.inProgress.map((l) =>
            l.replace(/taken by .*\(.*via (\S+)\), .*/, 'taken by … via $1'),
          ),
          stuck: facts.stuck,
          reclaimSays: facts.reclaimSays.map((l) =>
            l.replace(/\(deadline: [^)]+\)/, '(deadline: …)'),
          ),
          forced: facts.forced,
          owed: facts.owed.map((l) => l.split(id).join('<run>')),
        },
        shown,
      ).toEqual({
        code: 1,
        lines: ['realm serve: --shutdown-grace 0 ran out. Requests cut: 1.'],
        inProgress: ['In Progress: slow', '  slow: taken by … via mcp-http'],
        stuck: ['No stuck runs found (threshold 24h).'],
        reclaimSays: ['  • slow: healthy  (deadline: …)'],
        forced: {
          code: 0,
          out: [
            "Reclaimed 'slow' (was healthy). It is eligible again — the next driver will re-drive it.",
          ],
        },
        owed: [
          "Owed to the engine: 'slow' — from a program that has handler 'slow': realm run advance <run>",
        ],
      });
    });
  });
});
