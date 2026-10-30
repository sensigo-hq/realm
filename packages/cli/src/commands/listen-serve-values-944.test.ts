// listen-serve-values-944.test.ts — issues #944 and #949, through the built `realm`: `realm listen`
// and `realm serve` refuse a bad value of `--port`, `--host`, `--dedup-store`, `--log-level` or
// `--sweep-expired-gates` when the command line is read, and accept the good ones; the sweeper's
// interval is seconds, never milliseconds.
// On a failing host each cell prints the run's exit code, standard error and standard output, with
// the scratch folder written `<dir>`; the values printed are the test's own (fake key, fixture
// names), never the environment.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

  // The runaway of #944, through the built `realm listen --sweep-expired-gates 4` over a store
  // holding one run at an expired gate: the sweeper's first pass comes about 4 s after the server
  // starts, never in the first 3 s (a pass every 4 ms would come at once; a loaded machine can only
  // make it later). (a) red when the interval is taken as milliseconds (the first line comes at
  // once) or the sweeper never runs; (b) prints the delay and the run's lines.
  it('realm listen --sweep-expired-gates 4: no sweep line in the first 3 s after the start line, one afterwards', async () => {
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
        [CLI, ...LISTEN, '--port', '0', '--sweep-expired-gates', '4'],
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
