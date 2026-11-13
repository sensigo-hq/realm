// listen-stop-960.test.ts — issue #960, through the built `realm`: `realm listen` stops when asked.
// On Ctrl+C or SIGTERM it stops accepting, ends a connection waiting between requests at once,
// gives a connection that has sent nothing up to 5 s, gives requests being answered
// `--shutdown-grace` seconds (30 by default), cuts everything on a second signal, and exits 0, or 1
// after one line at level `error` when it had to cut requests.
// Each cell starts `realm listen` on one webhook workflow (`--port 0`, a fresh HOME), talks to it
// over a raw socket on loopback, and reads what an operator and a sender see: the exit code and when
// it came, the stop line, and the answer's status and `connection` header. The request is always a
// `POST` to the trigger's path with `Content-Type: text/plain`: listen reads its body whole, then
// answers `415` (any `GET` it refuses with `405` before reading anything, so a `GET` cell could not
// be red on the base).
// Every time is `performance.now()`; each bound is set so that a loaded machine can only make a cell
// later, within its upper bound. On a failing host a cell prints those facts and the
// `listen: shutdown cut requests` lines of standard error, never the environment (the child gets
// PATH, HOME, a fake key and nothing else).
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', '..', 'dist', 'index.js');

/** One agent step behind a webhook trigger (no auth: loopback only). No run is ever started here. */
const WORKFLOW =
  'id: stop-960\nname: stop 960\nversion: 1\ntrigger:\n  type: webhook\n  path: /hook-960\n  auth:\n    mode: none\nsteps:\n  ask:\n    description: Answer with a short summary.\n    execution: agent\n';

let root: string;
let home: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'realm-960-listen-'));
  home = join(root, 'home');
  mkdirSync(home);
  mkdirSync(join(root, 'wf'));
  writeFileSync(join(root, 'wf', 'workflow.yaml'), WORKFLOW, 'utf8');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const env = (): Record<string, string> => ({
  PATH: process.env['PATH'] ?? '',
  HOME: home,
  ANTHROPIC_API_KEY: 'k-fake-960',
});
const round = (n: number | undefined): number | undefined =>
  n === undefined ? undefined : Math.round(n);

interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
  at: number;
}

interface Listen {
  readonly proc: ChildProcess;
  readonly port: number;
  /** The lines of standard error that start with `listen: shutdown cut requests` (the stop lines). */
  stopLines(): string[];
  /** Sends a signal; returns when. */
  signal(sig: 'SIGTERM' | 'SIGINT'): number;
  /** The exit, once it has come within `ms`, or undefined. */
  exitWithin(ms: number): Promise<Exit | undefined>;
}

const LISTEN = ['listen', 'wf', '--model', 'm', '--provider', 'anthropic', '--port', '0'];

/** Starts the built `realm listen … --port 0`, waits for its start line, and kills it after the cell. */
async function startListen(extra: string[] = []): Promise<Listen> {
  const proc = spawn(process.execPath, [CLI, ...LISTEN, ...extra], {
    cwd: root,
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
    const m = /realm listen on 127\.0\.0\.1:(\d+) /.exec(out);
    if (m !== null) port = Number(m[1]);
    else await sleep(20);
  }
  if (port === undefined) {
    throw new Error(
      `listen did not start: exit ${JSON.stringify(exit)}; stderr ${err.slice(0, 400)}`,
    );
  }
  return {
    proc,
    port,
    stopLines: () => err.split('\n').filter((l) => l.startsWith('listen: shutdown cut requests')),
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
  /** Whether the socket has closed. */
  closed(): boolean;
  /** When the received text first matched `re`. */
  seenAt(re: RegExp): number | undefined;
}

/** A raw connection to the server; destroyed after the cell. */
function raw(port: number): Promise<Raw> {
  return new Promise((resolve) => {
    let bytes = '';
    let closed = false;
    const seen = new Map<RegExp, number>();
    const watch: RegExp[] = [];
    const socket = connect(port, '127.0.0.1', () =>
      resolve({
        socket,
        connectedAt: performance.now(),
        text: () => bytes,
        closed: () => closed,
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
    socket.on('close', () => (closed = true));
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

/** `listen`'s request in these cells: a POST to the trigger's path, its body plain text. */
const POST_HEAD = (length: number): string =>
  'POST /hook-960 HTTP/1.1\r\nHost: x\r\nContent-Type: text/plain\r\n' +
  `Content-Length: ${length}\r\n\r\n`;
const WHOLE = POST_HEAD(8) + 'not-json';
/** The end of listen's answer (it carries its length): its JSON body. */
const ANSWER_END = /\{"error":"unsupported_media_type"\}$/;
/** The stop line, as listen's logger writes it at level `error`. */
const CUT = (because: string, grace: number): string =>
  `listen: shutdown cut requests {"cut":1,"because":"${because}","grace_seconds":${grace}}`;

/** Waits until `pred` holds or `ms` passes. */
async function until(pred: () => boolean, ms: number): Promise<void> {
  const end = performance.now() + ms;
  while (!pred() && performance.now() < end) await sleep(10);
}

describe('#960 `realm listen` stops when asked (built CLI)', { timeout: 120_000 }, () => {
  it('B1: a connection that has sent nothing: exit 0 about 5 s after it connected, no stop line', async () => {
    const s = await startListen();
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
    const s = await startListen();
    const c = await raw(s.port);
    c.socket.write('POST /hook-960 HTTP/1.1\r\nHost: x\r\n');
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
    const s = await startListen();
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
    ).toEqual({ status: 415, connection: 'close', code: 0, afterAnswerMs: true });
  });

  it('B4: one answered request, then half the headers of a second: exit 0 at once', async () => {
    const s = await startListen();
    const c = await raw(s.port);
    c.socket.write(WHOLE);
    await until(() => c.seenAt(ANSWER_END) !== undefined, 5000);
    c.socket.write('POST /hook-960 HTTP/1.1\r\nHost: x\r\n');
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
      status: 415,
      code: 0,
      ms: true,
    });
  });

  it('B5: a body that finishes 2 s after SIGTERM: its answer (415) comes whole with `connection: close`, then exit 0', async () => {
    const s = await startListen();
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
    // The answer carries its length, so a body equal to it came whole.
    const facts = {
      ...head(c.text()),
      body: c.text().split('\r\n\r\n')[1],
      code: exit?.code,
      afterAnswerMs: round(exit && exit.at - (c.seenAt(ANSWER_END) ?? Infinity)),
    };
    expect(
      { ...facts, afterAnswerMs: facts.afterAnswerMs! <= 2000 },
      JSON.stringify(facts),
    ).toEqual({
      status: 415,
      connection: 'close',
      body: '{"error":"unsupported_media_type"}',
      code: 0,
      afterAnswerMs: true,
    });
  });

  it('B6: `--shutdown-grace 1` and a body that never completes: exit 1 after the grace, one line saying one request was cut', async () => {
    const s = await startListen(['--shutdown-grace', '1']);
    const c = await raw(s.port);
    c.socket.write(POST_HEAD(8) + 'not-');
    await sleep(300);
    const t = s.signal('SIGTERM');
    const exit = await s.exitWithin(8000);
    await until(() => c.closed(), 2000);
    // (1) Red when the grace's timer does nothing (still running at 8 s); on the base the option
    //     is refused. The sender's side is the page's sentence "A delivery that is cut gets no
    //     answer: `realm listen` closes its connection without replying.": red when a cut delivery
    //     gets bytes (listen's own body timeout, 5 s by default, would answer `408` first if it were
    //     shorter than the grace) or its connection stays open.
    // (2) Prints the exit code, when it came after the signal (ms), the stop lines, and how many
    //     bytes the sender got and whether its connection closed.
    const facts = {
      code: exit?.code,
      ms: round(exit && exit.at - t),
      lines: s.stopLines(),
      senderGot: c.text().length,
      senderClosed: c.closed(),
    };
    expect({ ...facts, ms: facts.ms! >= 800 && facts.ms! <= 5000 }, JSON.stringify(facts)).toEqual({
      code: 1,
      ms: true,
      lines: [CUT('grace_ran_out', 1)],
      senderGot: 0,
      senderClosed: true,
    });
  });

  it('B7: `--shutdown-grace 600` and a second SIGTERM 300 ms later: exit 1 at once, the second-signal line', async () => {
    const s = await startListen(['--shutdown-grace', '600']);
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
      lines: [CUT('second_signal', 600)],
    });
  });

  it('B7b: without the flag, a second SIGTERM: the line names the default grace, 30 s', async () => {
    const s = await startListen();
    const c = await raw(s.port);
    c.socket.write(POST_HEAD(8) + 'not-');
    await sleep(300);
    s.signal('SIGTERM');
    await sleep(300);
    const t = s.signal('SIGTERM');
    const exit = await s.exitWithin(8000);
    // (1) Red when the default is read as anything but 30 (the page and `--help` say 30).
    // (2) Prints the exit code, when it came after the second signal (ms) and the stop lines.
    const facts = { code: exit?.code, ms: round(exit && exit.at - t), lines: s.stopLines() };
    expect({ ...facts, ms: facts.ms! <= 2000 }, JSON.stringify(facts)).toEqual({
      code: 1,
      ms: true,
      lines: [CUT('second_signal', 30)],
    });
  });

  it('B8: SIGINT as the first signal works as SIGTERM: `--shutdown-grace 1`, exit 1 after the grace, the line', async () => {
    const s = await startListen(['--shutdown-grace', '1']);
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
      lines: [CUT('grace_ran_out', 1)],
    });
  });

  it('B9: `--shutdown-grace 0`: a request in flight is cut at once (exit 1); with only a silent connection, exit 0 at once', async () => {
    const busy = await startListen(['--shutdown-grace', '0']);
    const c1 = await raw(busy.port);
    c1.socket.write(POST_HEAD(8) + 'not-');
    await sleep(300);
    const t1 = busy.signal('SIGTERM');
    const exit1 = await busy.exitWithin(8000);
    const silent = await startListen(['--shutdown-grace', '0']);
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
        lines: [CUT('grace_ran_out', 0)],
      },
      silent: { code: 0, ms: true, lines: [] },
    });
  });

  it('B10: a value that is not a whole number from 0 to 2147483 ends the command with one line; 0, 30 and 2147483 start and stop', async () => {
    const refused = ['abc', '-1', '1.5', '', '2147484', '--port'].map((value) => {
      const r = spawnSync(process.execPath, [CLI, ...LISTEN, '--shutdown-grace', value], {
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
      const s = await startListen(['--shutdown-grace', value]);
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
    const r = spawnSync(process.execPath, [CLI, 'listen', '--help'], {
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
});
