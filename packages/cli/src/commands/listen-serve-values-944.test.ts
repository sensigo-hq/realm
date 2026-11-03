// listen-serve-values-944.test.ts — issues #944 and #949, through the built `realm`: `realm listen`
// and `realm serve` refuse a bad value of `--port`, `--host`, `--dedup-store`, `--log-level` or
// `--sweep-expired-gates` when the command line is read, and accept the good ones; the sweeper's
// interval is seconds, never milliseconds; a failure to listen is one line; `serve`'s start line
// names the port the server is on, with an IPv6 host in brackets.
// On a failing host each cell prints the run's exit code, standard error and standard output, with
// the scratch folder written `<dir>`; the values printed are the test's own (fake key, fixture
// names), never the environment.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { connect, createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createDefaultRegistry,
  executeChain,
  JsonFileStore,
  JsonWorkflowStore,
  loadWorkflowFromString,
  type PendingGate,
  type RunStore,
} from '@sensigo/realm';
import { sweepIntervalMs } from './listen.js';
import { serveStartLine } from './serve.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', '..', 'dist', 'index.js');

/** One agent step behind a webhook trigger (no auth: a test on loopback only). */
const WORKFLOW = [
  'id: values-944',
  'name: values 944',
  'version: 1',
  'trigger:',
  '  type: webhook',
  '  path: /hook-944',
  '  auth:',
  '    mode: none',
  'steps:',
  '  ask:',
  '    description: Answer with a short summary.',
  '    execution: agent',
  '',
].join('\n');

let root: string;
let home: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'realm-944-cli-'));
  home = join(root, 'home');
  mkdirSync(home);
  mkdirSync(join(root, 'wf'));
  writeFileSync(join(root, 'wf', 'workflow.yaml'), WORKFLOW, 'utf8');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

type Done = { code: number | null; out: string[]; err: string[] };
/** The run's lines, the scratch folder written `<dir>`. */
const lines = (text: string): string[] =>
  text
    .split(root)
    .join('<dir>')
    .split('\n')
    .filter((l) => l !== '');
const env = (): Record<string, string> => ({
  PATH: process.env['PATH'] ?? '',
  HOME: home,
  ANTHROPIC_API_KEY: 'k-fake-944',
});

/** Runs the built `realm` to its end; a run still alive after 20 s is killed (and shows as such). */
function runToEnd(args: string[]): Promise<Done> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: root,
      env: env(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString()));
    child.stderr.on('data', (c: Buffer) => (err += c.toString()));
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out: lines(out), err: lines(err) });
    });
  });
}

/** Starts the built `realm`, waits for a stdout line that `ready` accepts, then stops it with
 *  SIGTERM; `started` says whether that line came within 20 s. */
function startThenStop(
  args: string[],
  ready: (line: string) => boolean,
): Promise<Done & { started: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: root,
      env: env(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    let started = false;
    child.stdout.on('data', (c: Buffer) => {
      out += c.toString();
      if (!started && out.split('\n').some(ready)) {
        started = true;
        child.kill('SIGTERM');
      }
    });
    child.stderr.on('data', (c: Buffer) => (err += c.toString()));
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out: lines(out), err: lines(err), started });
    });
  });
}

const LISTEN = ['listen', 'wf', '--model', 'm', '--provider', 'anthropic'];
const refusal = (flags: string, word: string, sentence: string): string =>
  `error: option '${flags}' argument '${word}' is invalid. ${sentence}`;
const PORT_L = ['--port <n>', '--port must be a whole number from 0 to 65535.'] as const;
const HOST_L = ['--host <addr>', '--host must be an IP address or a host name.'] as const;
const SWEEP = [
  '--sweep-expired-gates <seconds>',
  '--sweep-expired-gates must be a whole number from 1 to 2147483.',
] as const;

describe('issues #944, #949 — realm listen refuses a bad option value when the command line is read', () => {
  // (a) red when the option's parser is removed: the command then starts (a line on standard
  //     output, the workflow registered) or ends in a stack; (b) prints the run.
  it.each([
    [['--port', 'abc'], ...PORT_L],
    [['--port', '65536'], ...PORT_L],
    [['--port', '3000abc'], ...PORT_L],
    [
      ['--log-level', 'bogus'],
      '--log-level <level>',
      '--log-level must be debug, info, warn or error.',
    ],
    [['--dedup-store', 'mem'], '--dedup-store <kind>', '--dedup-store must be file or memory.'],
    [['--host', ''], ...HOST_L],
    [['--host', 'a b'], ...HOST_L],
    [['--host', '--strict'], ...HOST_L],
    [['--sweep-expired-gates', 'abc'], ...SWEEP],
    [['--sweep-expired-gates', '0'], ...SWEEP],
    [['--sweep-expired-gates', '-x'], ...SWEEP],
    [['--sweep-expired-gates', '1.5'], ...SWEEP],
    [['--sweep-expired-gates', ''], ...SWEEP],
    [['--sweep-expired-gates', '2147484'], ...SWEEP],
  ] as const)(
    'listen %j: one line from the parser, nothing on standard output, nothing started',
    async (pair, flags, sentence) => {
      const r = await runToEnd([...LISTEN, ...pair]);
      expect({
        code: r.code,
        err: r.err,
        out: r.out,
        registered: existsSync(join(home, '.realm', 'workflows')),
      }).toEqual({
        code: 1,
        err: [refusal(flags, pair[1], sentence)],
        out: [],
        registered: false,
      });
    },
    30_000,
  );

  // (a) red when a parser refuses a good value, or the command no longer starts with it; (b)
  //     prints the run.
  it.each([
    [['--port', '0']],
    [['--port', '0', '--log-level', 'debug']],
    [['--port', '0', '--dedup-store', 'memory']],
    [['--port', '0', '--sweep-expired-gates', '1']],
    [['--port', '0', '--sweep-expired-gates', '2147483']],
  ] as const)(
    'listen %j: accepted, the server starts',
    async (extra) => {
      const r = await startThenStop([...LISTEN, ...extra], (l) =>
        l.startsWith('realm listen on 127.0.0.1:'),
      );
      expect({ started: r.started, code: r.code }, JSON.stringify(r)).toEqual({
        started: true,
        code: 0,
      });
    },
    30_000,
  );
});

describe('issues #944, #949 — realm serve refuses a bad option value when the command line is read', () => {
  // (a) red when the option's parser is removed: serve then prints its dev-mode warning and a
  //     refusal of its own, or binds; (b) prints the run.
  it.each([
    [['--port', 'abc'], '--port <number>', '--port must be a whole number from 0 to 65535.'],
    [['--host', ''], '--host <address>', '--host must be an IP address or a host name.'],
    [['--host', '--strict'], '--host <address>', '--host must be an IP address or a host name.'],
  ] as const)(
    'serve --dev %j: one line from the parser, nothing on standard output',
    async (pair, flags, sentence) => {
      const r = await runToEnd(['serve', '--dev', ...pair]);
      expect({ code: r.code, err: r.err, out: r.out }).toEqual({
        code: 1,
        err: [refusal(flags, pair[1], sentence)],
        out: [],
      });
    },
    30_000,
  );
});

describe('issue #944 — the sweeper waits the seconds it is given', () => {
  // (a) red when the seconds are not turned into milliseconds; (b) prints the two delays.
  it('sweepIntervalMs: 1 second is 1000 ms, and the largest accepted value stays under 2^31 − 1', () => {
    expect({
      one: sweepIntervalMs(1),
      largest: sweepIntervalMs(2147483),
      underTimerLimit: sweepIntervalMs(2147483) < 2 ** 31 - 1,
    }).toEqual({ one: 1000, largest: 2147483000, underTimerLimit: true });
  });

  // The runaway of #944, through the built `realm listen --sweep-expired-gates 6` over a store
  // holding one run at an expired gate: the sweeper's first pass comes about 6 s after the server
  // starts. The cell requires at least 3 s between the two lines it reads (the start line, then
  // the first sweep line), which leaves about 3 s for this test process to be late reading the
  // start line; a pass every 6 ms (the interval taken as milliseconds) would come at once.
  // (a) red when the interval is taken as milliseconds (the first line comes at once) or the
  // sweeper never runs; (b) prints the delay and the run's lines.
  it('realm listen --sweep-expired-gates 6: no sweep line in the first 3 s after the start line, one afterwards', async () => {
    mkdirSync(join(home, '.realm', 'workflows'), { recursive: true });
    mkdirSync(join(home, '.realm', 'runs'), { recursive: true });
    const runStore = new JsonFileStore(join(home, '.realm', 'runs'));
    const workflowStore = new JsonWorkflowStore(join(home, '.realm', 'workflows'));
    const def = loadWorkflowFromString(
      [
        'id: values-944-gated',
        'name: values-944-gated',
        'version: 1',
        'steps:',
        '  review:',
        '    description: A person decides.',
        '    execution: auto',
        '    trust: human_confirmed',
        '    gate:',
        '      choices: [ship, hold]',
        '      timeout_seconds: 60',
        '      on_expiry: settle_default',
        '      default_choice: hold',
        '  file:',
        '    description: File.',
        '    execution: auto',
        '    depends_on: [review]',
        '',
      ].join('\n'),
    );
    await workflowStore.register(def);
    const { run } = await runStore.create({ workflowId: def.id, workflowVersion: 1, params: {} });
    await executeChain(runStore as RunStore, def, {
      runId: run.id,
      command: 'review',
      input: {},
      dispatcher: async () => ({}),
      registry: createDefaultRegistry(),
    });
    const open = await runStore.get(run.id);
    const gate = open.pending_gate as PendingGate;
    await runStore.update({
      ...open,
      pending_gate: { ...gate, expires_at: new Date(Date.now() - 5_000).toISOString() },
    });
    const seen = await new Promise<{
      startAt: number | undefined;
      sweptAt: number | undefined;
      lines: string[];
    }>((resolve) => {
      const child = spawn(
        process.execPath,
        [CLI, ...LISTEN, '--port', '0', '--sweep-expired-gates', '6'],
        { cwd: root, env: env(), stdio: ['ignore', 'pipe', 'pipe'] },
      );
      const got: string[] = [];
      let buf = '';
      let startAt: number | undefined;
      let sweptAt: number | undefined;
      const finish = (): void => {
        clearTimeout(timer);
        child.kill('SIGTERM');
        resolve({ startAt, sweptAt, lines: got.map((l) => l.split(root).join('<dir>')) });
      };
      const timer = setTimeout(finish, 20_000);
      const take = (chunk: Buffer): void => {
        const now = Date.now();
        buf += chunk.toString('utf8');
        const parts = buf.split('\n');
        buf = parts.pop() ?? '';
        for (const l of parts) {
          got.push(l);
          if (startAt === undefined && l.startsWith('realm listen on ')) startAt = now;
          if (sweptAt === undefined && l.startsWith('listen: sweeper enacted an expired gate ')) {
            sweptAt = now;
            finish();
          }
        }
      };
      child.stdout.on('data', take);
      child.stderr.on('data', take);
    });
    const delay =
      seen.startAt !== undefined && seen.sweptAt !== undefined
        ? seen.sweptAt - seen.startAt
        : undefined;
    expect(
      {
        started: seen.startAt !== undefined,
        swept: seen.sweptAt !== undefined,
        quietFor3s: delay !== undefined && delay >= 3000,
      },
      JSON.stringify({ delay, lines: seen.lines }),
    ).toEqual({ started: true, swept: true, quietFor3s: true });
  }, 30_000);
});

// ---------------------------------------------------------------------------------------------
// issue #949 (C-2): a failure to listen is one line naming the host and the port, then exit 1.
// ---------------------------------------------------------------------------------------------

/** What a test can see of a bind failure: the exit, the last line on standard error, how many
 *  lines say "cannot listen", and whether any line is a stack frame (`at …`, the real ones are
 *  indented). Earlier stderr lines may be warnings (dev mode, `auth.mode: none`, a non-loopback
 *  host), so "one line on stderr" is not asserted. */
const bindShape = (
  r: Done,
): { code: number | null; last: string | undefined; said: number; stack: boolean } => ({
  code: r.code,
  last: r.err.at(-1),
  said: r.err.filter((l) => l.startsWith('Error: cannot listen on')).length,
  stack: r.err.some((l) => l.trimStart().startsWith('at ')),
});
const IN_USE = (a: string): string =>
  `Error: cannot listen on ${a}: the port is already in use. Stop the program using it, or choose another --port.`;
const DENIED = (a: string): string =>
  `Error: cannot listen on ${a}: permission denied. A port below 1024 usually needs extra rights, and on Windows the system can reserve a port. Choose another --port.`;
const NOT_HERE = (a: string, host: string): string =>
  `Error: cannot listen on ${a}: ${host} is not an address of this machine. Check --host.`;
const NO_NAME = (a: string, host: string): string =>
  `Error: cannot listen on ${a}: the name ${host} cannot be resolved. Check --host.`;

/** Whether this machine fails a listen on `host:port` with `want`, decided once when the file is
 *  collected; the reason is printed in the title of a cell it skips. */
function probeListen(
  port: number,
  host: string,
  want: string,
): Promise<{ ok: boolean; reason: string }> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once('error', (e: NodeJS.ErrnoException) => {
      resolve({
        ok: e.code === want,
        reason: `a listen on ${host}:${port} here fails with ${String(e.code)}, not ${want}`,
      });
    });
    s.listen(port, host, () => {
      s.close();
      resolve({ ok: false, reason: `a listen on ${host}:${port} here succeeds` });
    });
  });
}
const EACCES_PROBE = await probeListen(80, '127.0.0.1', 'EACCES');
const NOT_HERE_PROBE = await probeListen(0, '192.0.2.1', 'EADDRNOTAVAIL');
const skipped = (probe: { ok: boolean; reason: string }): string =>
  probe.ok ? '' : ` (skipped: ${probe.reason})`;

describe('issue #949 — realm listen and realm serve say a failure to listen in one line', () => {
  // A port held by a throwaway server in the test. (a) red when the bind failure is a stack again,
  // or the line changes; (b) prints the exit, the last line, the count and whether a stack was seen.
  it.each([
    ['listen', (port: number): string[] => [...LISTEN, '--port', String(port)]],
    ['serve --dev', (port: number): string[] => ['serve', '--dev', '--port', String(port)]],
  ] as const)(
    '%s on a port in use: the EADDRINUSE line, exit 1, no stack',
    async (_cmd, args) => {
      const busy = createServer();
      await new Promise<void>((r) => busy.listen(0, '127.0.0.1', () => r()));
      const { port } = busy.address() as AddressInfo;
      try {
        const r = await runToEnd(args(port));
        expect(bindShape(r), JSON.stringify(r)).toEqual({
          code: 1,
          last: IN_USE(`127.0.0.1:${port}`),
          said: 1,
          stack: false,
        });
      } finally {
        await new Promise<void>((r) => busy.close(() => r()));
      }
    },
    30_000,
  );

  // `.invalid` is reserved (RFC 6761) and never resolves. (a) red when the ENOTFOUND failure is a
  // stack (listen) or serve's old `realm serve: getaddrinfo …` line again; (b) as above.
  it.each([
    ['listen', [...LISTEN, '--host', 'no-such-host.invalid', '--port', '0']],
    ['serve --dev', ['serve', '--dev', '--host', 'no-such-host.invalid', '--port', '0']],
  ] as const)(
    '%s --host no-such-host.invalid: the line for a name that cannot be resolved, exit 1, no stack',
    async (_cmd, args) => {
      const r = await runToEnd([...args]);
      expect(bindShape(r), JSON.stringify(r)).toEqual({
        code: 1,
        last: NO_NAME('no-such-host.invalid:0', 'no-such-host.invalid'),
        said: 1,
        stack: false,
      });
    },
    30_000,
  );

  // Permission denied: port 80 without the rights to bind it. Runs only where a probe listen on
  // 127.0.0.1:80 fails with EACCES (not as root, not on Windows, not where port 80 is busy).
  // (a) red when the EACCES failure is a stack again or the line changes; (b) as above.
  it.skipIf(!EACCES_PROBE.ok).each([
    ['listen', [...LISTEN, '--port', '80']],
    ['serve --dev', ['serve', '--dev', '--port', '80']],
  ] as const)(
    `%s --port 80: the permission-denied line, exit 1, no stack${skipped(EACCES_PROBE)}`,
    async (_cmd, args) => {
      const r = await runToEnd([...args]);
      expect(bindShape(r), JSON.stringify(r)).toEqual({
        code: 1,
        last: DENIED('127.0.0.1:80'),
        said: 1,
        stack: false,
      });
    },
    30_000,
  );

  // An address that is not this machine's: 192.0.2.1 (TEST-NET-1, RFC 5737). Runs only where a
  // probe listen on it fails with EADDRNOTAVAIL. (a) red when that failure is a stack again or the
  // line changes; (b) as above.
  it.skipIf(!NOT_HERE_PROBE.ok).each([
    ['listen', [...LISTEN, '--host', '192.0.2.1', '--port', '0']],
    ['serve --dev', ['serve', '--dev', '--host', '192.0.2.1', '--port', '0']],
  ] as const)(
    `%s --host 192.0.2.1: the line for an address that is not this machine's, exit 1, no stack${skipped(NOT_HERE_PROBE)}`,
    async (_cmd, args) => {
      const r = await runToEnd([...args]);
      expect(bindShape(r), JSON.stringify(r)).toEqual({
        code: 1,
        last: NOT_HERE('192.0.2.1:0', '192.0.2.1'),
        said: 1,
        stack: false,
      });
    },
    30_000,
  );
});

// ---------------------------------------------------------------------------------------------
// C-2 items 6 and 7: `serve`'s start line names the port the server is on, and writes an IPv6
// host in brackets.
// ---------------------------------------------------------------------------------------------

describe('realm serve — the start line', () => {
  // (a) red when the line prints the requested 0 (no positive port, and nothing listens on 0) or a
  //     port the server is not on (the connection fails); (b) prints the matched line and the
  //     connection's error code, both the test's own values; with no line, the run's output.
  it('serve --dev --port 0: the start line names the port the system picked, and the server is on it', async () => {
    const LINE = /^Realm MCP server listening on http:\/\/127\.0\.0\.1:(\d+)\/$/;
    const child = spawn(process.execPath, [CLI, 'serve', '--dev', '--port', '0'], {
      cwd: root,
      env: { PATH: process.env['PATH'] ?? '', HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stderr.on('data', (c: Buffer) => (err += c.toString()));
    const exited = new Promise<void>((r) => child.once('exit', () => r()));
    try {
      const line = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(
              new Error(
                `no start line in 20 s:\n${lines(out).join('\n')}\n${lines(err).join('\n')}`,
              ),
            ),
          20_000,
        );
        child.stdout.on('data', (c: Buffer) => {
          out += c.toString();
          const hit = out.split('\n').find((l) => LINE.test(l));
          if (hit !== undefined) {
            clearTimeout(timer);
            resolve(hit);
          }
        });
        child.once('exit', () => {
          clearTimeout(timer);
          reject(
            new Error(`serve exited early:\n${lines(out).join('\n')}\n${lines(err).join('\n')}`),
          );
        });
      });
      const port = Number(LINE.exec(line)![1]);
      const connected = await new Promise<{ ok: boolean; code?: string }>((resolve) => {
        const sock = connect(port, '127.0.0.1');
        sock.once('connect', () => {
          sock.destroy();
          resolve({ ok: true });
        });
        sock.once('error', (e: NodeJS.ErrnoException) => {
          sock.destroy();
          resolve({ ok: false, code: String(e.code) });
        });
      });
      expect(
        { portIsPositive: port > 0, connected: connected.ok },
        JSON.stringify({ line, connected }),
      ).toEqual({
        portIsPositive: true,
        connected: true,
      });
    } finally {
      // The test's socket is already destroyed (a silent open connection keeps `serve` from
      // exiting); then SIGTERM, up to 5 s for the exit, and SIGKILL if it is still alive.
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        await Promise.race([exited, new Promise<void>((r) => setTimeout(r, 5_000))]);
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
    }
  }, 30_000);

  // (a) red when the brackets are dropped for an IPv6 host or added for another; (b) prints the
  //     host, the port and the line.
  it.each([
    ['127.0.0.1', 'http://127.0.0.1:3001/'],
    ['localhost', 'http://localhost:3001/'],
    ['0.0.0.0', 'http://0.0.0.0:3001/'],
    ['::1', 'http://[::1]:3001/'],
    ['fe80::1%eth0', 'http://[fe80::1%eth0]:3001/'],
  ])('serveStartLine(%j, 3001) ends with %s', (host, url) => {
    expect(serveStartLine(host, 3001), `${host} 3001`).toBe(`Realm MCP server listening on ${url}`);
  });
});
