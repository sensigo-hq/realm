// listen-wait-r12-cli.test.ts — R1.2 on the built `realm listen`: a caller sends `Prefer: wait=N`
// and the reply waits for the run. A real `realm agent` drives each run: a bare `auto` step finishes
// with no model call; an agent step whose model never answers (`--provider openai`, the model's
// address a local stand-in that accepts and never replies) does not finish. The stop cells send
// `SIGTERM` to the process; the option cells read what the command prints. A failing cell prints
// the statuses, times, exit codes and listen's lines (fake secrets and keys only; a code never).
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import { deriveReadKey, readCode } from '../lib/run-read-address.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', '..', 'dist', 'index.js');
const SECRET = 'fake-r12-hook-secret-0729';

const trigger = (id: string) =>
  `id: ${id}\nname: ${id}\nversion: 1\ntrigger:\n  type: webhook\n  path: /refunds\n  auth:\n    mode: shared_secret\n    header: X-Token\n    secret_from: R12_SECRET\n  params_map:\n    approved: body.approved\n  result_map:\n    approved: context.resources.`;
/** One `auto` step: it records the run's params as its output and ends the run, no model call. */
const FINISHES = `${trigger('refunds-auto')}record.approved\nsteps:\n  record:\n    description: Record.\n    execution: auto\n`;
/** One agent step: its model never answers, so the run does not finish. */
const NEVER = `${trigger('refunds-agent')}answer.approved\nsteps:\n  answer:\n    description: Answer with a short summary.\n    execution: agent\n`;

let root: string;
let home: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'realm-r12-cli-'));
  home = join(root, 'home');
  mkdirSync(home);
  for (const [name, text] of [
    ['finishes', FINISHES],
    ['never', NEVER],
  ] as const) {
    mkdirSync(join(root, name));
    writeFileSync(join(root, name, 'workflow.yaml'), text, 'utf8');
  }
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A model address that accepts every request and never answers; closed after the cell. */
async function silentModel(): Promise<string> {
  const held: Array<{ destroy(): void }> = [];
  const server: Server = createServer((req) => {
    req.resume();
    held.push(req.socket);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  onTestFinished(
    () =>
      new Promise<void>((r) => {
        for (const s of held) s.destroy();
        server.close(() => r());
      }),
  );
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
}

interface Listen {
  readonly port: number;
  lines(): string[];
  signal(sig: 'SIGTERM'): number;
  exitWithin(ms: number): Promise<{ code: number | null; at: number } | undefined>;
}

/** The built `realm listen <dir> … --port 0`; it and every agent it started are killed after the cell. */
async function startListen(dir: string, extra: string[], model?: string): Promise<Listen> {
  const proc: ChildProcess = spawn(
    process.execPath,
    [CLI, 'listen', dir, '--provider', 'openai', '--model', 'm-r12', '--port', '0', ...extra],
    {
      cwd: root,
      env: {
        PATH: process.env['PATH'] ?? '',
        HOME: home,
        OPENAI_API_KEY: 'k-fake-r12',
        ...(model !== undefined ? { OPENAI_BASE_URL: model } : {}),
        R12_SECRET: SECRET,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let text = '';
  proc.stdout!.on('data', (d: Buffer) => (text += d.toString()));
  proc.stderr!.on('data', (d: Buffer) => (text += d.toString()));
  let exit: { code: number | null; at: number } | undefined;
  const exited = new Promise<{ code: number | null; at: number }>((r) =>
    proc.once('exit', (code) => r((exit = { code, at: performance.now() }))),
  );
  onTestFinished(() => {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
    // The agents are detached and outlive listen: each is named in a `webhook: dispatched` line.
    for (const m of text.matchAll(/webhook: dispatched .*"pid":(\d+)/g)) {
      try {
        process.kill(Number(m[1]), 'SIGKILL');
      } catch {
        // It has already ended.
      }
    }
  });
  const by = performance.now() + 20_000;
  let port: number | undefined;
  while (port === undefined && exit === undefined && performance.now() < by) {
    const m = /realm listen on 127\.0\.0\.1:(\d+) /.exec(text);
    if (m !== null) port = Number(m[1]);
    else await sleep(20);
  }
  if (port === undefined) throw new Error(`listen did not start: ${text.slice(0, 600)}`);
  return {
    port,
    lines: () => text.split('\n').filter((l) => l !== ''),
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

/** A POST to `/refunds` with `Prefer`; its status, headers it carries, body and end time, or why none. */
async function post(port: number, prefer?: string) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/refunds`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-token': SECRET,
        ...(prefer !== undefined ? { prefer } : {}),
      },
      body: JSON.stringify({ approved: true }),
      signal: AbortSignal.timeout(40_000),
    });
    const body = await res.text();
    return {
      status: res.status,
      applied: res.headers.get('preference-applied'),
      cache: res.headers.get('cache-control'),
      body,
      at: performance.now(),
    };
  } catch (err) {
    return { status: 'no answer' as const, error: (err as Error).name, at: performance.now() };
  }
}

const waitLines = (l: Listen) => l.lines().filter((x) => x.startsWith('webhook: wait ended'));

describe('R1.2 on the built realm listen', { timeout: 90_000 }, () => {
  it('B1: a run a real agent finishes inside N is answered 200 with the read’s body; Prefer: wait=100 is applied as 25, the default --max-wait', async () => {
    const l = await startListen('finishes', []);
    const t0 = performance.now();
    const a = await post(l.port, 'wait=100');
    const body = a.status === 'no answer' ? {} : (JSON.parse(a.body) as Record<string, unknown>);
    const runId = String(body['run_id']);
    const code = readCode(await deriveReadKey(SECRET, 'refunds-auto'), runId);
    const got = await fetch(`http://127.0.0.1:${l.port}/refunds/runs/${runId}`, {
      headers: { authorization: `Bearer ${code}` },
    });
    const gotBody = await got.text();
    // (a) red when the built command does not wait (the plain `202`), when the default cap is not
    //     25, or when the wait's body is not the read's; (b) prints the reply, its time, the read's
    //     body and the wait line.
    expect({
      status: a.status,
      applied: 'applied' in a ? a.applied : undefined,
      cache: 'cache' in a ? a.cache : undefined,
      body,
      sameAsRead: 'body' in a && a.body === gotBody,
      inside: a.at - t0 < 20_000,
      ended: waitLines(l).map((x) => /"ended_by":"(\w+)"/.exec(x)?.[1]),
    }).toEqual({
      status: 200,
      applied: 'wait=25',
      cache: 'no-store',
      body: {
        run_id: runId,
        run_phase: 'completed',
        result: { approved: true },
        result_masked: { declared: 0, environment: 0, pattern: 0 },
      },
      sameAsRead: true,
      inside: true,
      ended: ['terminal'],
    });
  });

  it('B2: --shutdown-drain 5 and SIGTERM at 1 s: the waiter is answered within a second of the signal, not at 5 s; exit 0 near 5 s, nothing cut', async () => {
    const model = await silentModel();
    const l = await startListen('never', ['--shutdown-drain', '5'], model);
    const pending = post(l.port, 'wait=20');
    await sleep(1000);
    const sig = l.signal('SIGTERM');
    const a = await pending;
    const exit = await l.exitWithin(15_000);
    // (a) red when the waiter is held to the drain's end (5 s) or the grace, when the stop's abort
    //     comes after the drain wait, or when an answered waiter is counted as cut; (b) prints the
    //     reply, the times from the signal, the exit and the cut and wait lines.
    expect({
      status: a.status,
      applied: 'applied' in a ? a.applied : undefined,
      answeredAfterSignalMs: a.at - sig < 1000,
      exit: exit?.code,
      exitNear5s: exit !== undefined && exit.at - sig >= 4000 && exit.at - sig < 8000,
      cut: l.lines().filter((x) => x.startsWith('listen: shutdown cut requests')),
      ended: waitLines(l).map((x) => /"ended_by":"(\w+)"/.exec(x)?.[1]),
    }).toEqual({
      status: 202,
      applied: 'wait=20',
      answeredAfterSignalMs: true,
      exit: 0,
      exitNear5s: true,
      cut: [],
      ended: ['signal'],
    });
  });

  it('B3: --shutdown-grace 0 (no drain): the waiter is cut, gets no answer, and the exit is 1; the wait says `signal`', async () => {
    const model = await silentModel();
    const l = await startListen('never', ['--shutdown-grace', '0'], model);
    const pending = post(l.port, 'wait=20');
    await sleep(1000);
    l.signal('SIGTERM');
    const a = await pending;
    const exit = await l.exitWithin(15_000);
    // (a) red when a waiter is answered although the stop cut it, or the cut is not counted; (b)
    //     prints the reply (or why none), the exit and the lines.
    expect({
      status: a.status,
      exit: exit?.code,
      cut: l.lines().filter((x) => x.startsWith('listen: shutdown cut requests')).length,
      ended: waitLines(l).map((x) => /"ended_by":"(\w+)"/.exec(x)?.[1]),
    }).toEqual({ status: 'no answer', exit: 1, cut: 1, ended: ['signal'] });
  });

  it('B4: each refusal of the two options ends the command with its line, before any workflow is read', () => {
    const run = (args: string[]) => {
      const r = spawnSync(
        process.execPath,
        [CLI, 'listen', 'missing-folder', '--model', 'm', ...args],
        {
          cwd: root,
          env: { PATH: process.env['PATH'] ?? '', HOME: home },
          encoding: 'utf8',
          timeout: 20_000,
        },
      );
      return { code: r.status, err: r.stderr.split('\n').filter((x) => x !== ''), out: r.stdout };
    };
    // (a) red when a value is taken that must be refused, a sentence differs from the page's, or
    //     the cross-option check runs after the workflow is read (the line is then the missing
    //     folder's); (b) prints each exit code and output.
    expect({
      wait: run(['--max-wait', '301']),
      waitingZero: run(['--max-waiting', '0']),
      waitingAbove: run(['--max-waiting', '5', '--max-concurrent', '5']),
      concurrentOne: run(['--max-waiting', '1', '--max-concurrent', '1']),
    }).toEqual({
      wait: {
        code: 1,
        err: [
          "error: option '--max-wait <seconds>' argument '301' is invalid. --max-wait must be a whole number from 0 to 300.",
        ],
        out: '',
      },
      waitingZero: {
        code: 1,
        err: [
          "error: option '--max-waiting <n>' argument '0' is invalid. --max-waiting must be a whole number from 1 to one less than --max-concurrent.",
        ],
        out: '',
      },
      waitingAbove: {
        code: 1,
        err: [
          'Error: --max-waiting 5 must be below --max-concurrent 5: a request that waits keeps one of its places, and this many waiting could leave none for a new event. Give --max-waiting a number from 1 to 4, or raise --max-concurrent.',
        ],
        out: '',
      },
      concurrentOne: {
        code: 1,
        err: [
          'Error: --max-concurrent is 1, so no request can wait and still leave a place for a new event. Remove --max-waiting, or raise --max-concurrent.',
        ],
        out: '',
      },
    });
  });

  it('B5: --max-concurrent 1 warns at start and answers a request that asks to wait at once; --max-wait 0 ignores the header', async () => {
    const one = await startListen('finishes', ['--max-concurrent', '1']);
    const a = await post(one.port, 'wait=20');
    const off = await startListen('finishes', ['--max-wait', '0']);
    const b = await post(off.port, 'wait=20');
    // (a) red when the warning is missing, or either setting still waits; (b) prints the warning
    //     lines, both replies' status and header, and the wait lines.
    expect({
      warned: one
        .lines()
        .filter(
          (x) =>
            x ===
            'listen: --max-concurrent is 1, so a request that asks to wait is answered at once.',
        ).length,
      offWarned: off.lines().filter((x) => x.includes('--max-concurrent is 1')).length,
      one: [a.status, 'applied' in a ? a.applied : undefined],
      off: [b.status, 'applied' in b ? b.applied : undefined],
      waits: [...waitLines(one), ...waitLines(off)],
    }).toEqual({ warned: 1, offWarned: 0, one: [202, null], off: [202, null], waits: [] });
  });

  it('B6: --help shows both options, --max-wait with its default of 25', () => {
    const r = spawnSync(process.execPath, [CLI, 'listen', '--help'], {
      cwd: root,
      env: { PATH: process.env['PATH'] ?? '', HOME: home },
      encoding: 'utf8',
      timeout: 20_000,
    });
    const help = r.stdout.replace(/\s+/g, ' ');
    // (a) red when an option is missing from the help or its default is not 25 (or `--max-waiting`
    //     shows one); (b) prints whether each text is there.
    expect({
      wait: help.includes(
        '--max-wait <seconds> Longest a request that sends Prefer: wait=N is held before it is answered, in seconds, a whole number from 0 to 300; 0 turns waiting off. A workflow without result_map ignores the header. (default: 25)',
      ),
      waiting: help.includes(
        '--max-waiting <n> How many requests may be held waiting at once, a whole number from 1 to one less than --max-concurrent; the default is 5, or one less than --max-concurrent if that is smaller. A waiting request keeps its place among --max-concurrent. --',
      ),
    }).toEqual({ wait: true, waiting: true });
  });
});
