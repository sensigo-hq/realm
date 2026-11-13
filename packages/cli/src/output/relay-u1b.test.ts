// relay-u1b.test.ts — U1b Unit 1: the relay's refusals and the worker's end messages.
//
// - (l) a spawn that fails ends the relay with one line and exit 1, never an in-process run — the
//   relay is run here, in this process, with a `spawn` that fails as the OS does (EAGAIN).
// - (t-i) a stream whose pipe handle lacks `setBlocking` (another runtime; a seam removes it) makes
//   either process of the pair print one line and exit 1 — run in a child, so the line is read from
//   its real stderr.
// - (u) every exit of a worker sends exactly one end message, beside at most one error line: the
//   BUILT CLI is started as a worker of THIS test (its markers name this process, and it has a
//   channel), and the test acknowledges each piece of the declared set, as a relay does.
// Every value is a fake. Each assertion names (a) the break that turns it red and (b) what it prints:
// codes, counts and line starts, never a value.
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import { fork, spawnSync, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { abandonRun } from '@sensigo/realm';
import { makeTempHome, type TempHome } from '../test-support/temp-home.js';
import { runRelay, spawnFailedLine } from './relay.js';
import { NOT_BLOCKING_LINE } from './writer.js';

const CLI = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const RELAY_JS = pathToFileURL(
  fileURLToPath(new URL('../../dist/output/relay.js', import.meta.url)),
).href;
const WRITER_JS = pathToFileURL(
  fileURLToPath(new URL('../../dist/output/writer.js', import.meta.url)),
).href;
const DECLARED = 'CANARY-u1b-declared-7a3c-xxxxxxxx';

describe('U1b — (l) a spawn that fails', () => {
  const failing = (code: string) => () => {
    throw Object.assign(new Error(`spawn ${code}`), { code });
  };
  const SIGNALS = ['exit', 'SIGINT', 'SIGTERM', 'SIGHUP', 'SIGTSTP', 'SIGCONT'] as const;
  /** The relay in this process: its exit recorded (never taken), its lines kept; any listener it
   *  added to this process removed after. */
  async function relayWith(spawn: unknown): Promise<{ lines: string[]; exits: unknown[] }> {
    const lines: string[] = [];
    const exits: unknown[] = [];
    const before = new Map(SIGNALS.map((s) => [s, new Set(process.listeners(s as never))]));
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exits.push(code);
    }) as never);
    try {
      void runRelay({
        spawn: spawn as never,
        stdout: { isTTY: true } as never,
        stderr: { isTTY: true } as never,
      });
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      vi.restoreAllMocks();
      for (const s of SIGNALS) {
        for (const l of process.listeners(s as never)) {
          if (!before.get(s)!.has(l)) process.off(s as never, l as never);
        }
      }
    }
    return { lines, exits };
  }

  it('a spawn that throws EAGAIN → one line, exit 1, nothing run here', async () => {
    const seen = await relayWith(failing('EAGAIN'));
    // (a) red when a failed spawn falls back to an in-process run (no exit), or prints more than
    //     one line; (b) prints the lines and the exit codes.
    expect(seen).toEqual({ lines: [spawnFailedLine({ code: 'EAGAIN' })], exits: [1] });
    expect(seen.lines[0]).toBe(
      'Error: realm agent could not start the process that runs its drive (EAGAIN). Nothing was started.',
    );
  });

  it("a spawn whose child reports 'error' before 'spawn' → the same line and exit", async () => {
    const seen = await relayWith(() => {
      const child = Object.assign(new EventEmitter(), {
        pid: undefined,
        exitCode: null,
        signalCode: null,
        stdout: null,
        stderr: null,
        send: () => true,
      });
      queueMicrotask(() =>
        child.emit('error', Object.assign(new Error('spawn EAGAIN'), { code: 'EAGAIN' })),
      );
      return child;
    });
    // (a) red when an 'error' before the spawn is ignored (the relay waits forever); (b) prints the
    //     lines and the exit codes.
    expect(seen).toEqual({ lines: [spawnFailedLine({ code: 'EAGAIN' })], exits: [1] });
  });
});

describe('U1b — (t-i) a pipe handle without `setBlocking`', () => {
  it('the relay: one line on stderr, exit 1, never a spawn', () => {
    const script = `const { runRelay } = await import(${JSON.stringify(RELAY_JS)});
const piped = { isTTY: false, _handle: {} };
await runRelay({ spawn: () => { process.stdout.write('SPAWNED'); throw new Error('no'); }, stdout: piped, stderr: process.stderr });`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    // (a) red when the guard is removed (the relay spawns its worker and runs); (b) prints the
    //     code, the stderr and whether it spawned.
    expect({ code: r.status, stderr: r.stderr, spawned: r.stdout.includes('SPAWNED') }).toEqual({
      code: 1,
      stderr: `${NOT_BLOCKING_LINE}\n`,
      spawned: false,
    });
  }, 30_000);

  it('the worker: one line, one end message (no receipt), exit 1, never an unmasked run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'realm-u1b-guard-'));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const script = join(dir, 'worker.mjs');
    writeFileSync(
      script,
      `process.stdout._handle.setBlocking = undefined;
await import(${JSON.stringify(WRITER_JS)});
process.stdout.write('UNMASKED RUN\\n');
`,
      'utf8',
    );
    const child = fork(script, [], {
      env: {
        PATH: process.env['PATH'] ?? '',
        REALM_RELAY_CHILD: String(process.pid),
        REALM_RELAY_KEY: 'ab'.repeat(32),
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const ran = await collect(child);
    // (a) red when the worker runs on with a non-blocking pipe (the unmasked line prints, no end
    //     message); (b) prints the code, the stderr, the end messages and whether it ran on.
    expect({
      code: ran.code,
      stderr: ran.stderr,
      ends: ran.ends,
      ranOn: ran.stdout.includes('UNMASKED RUN'),
    }).toEqual({
      code: 1,
      stderr: `${NOT_BLOCKING_LINE}\n`,
      ends: [{ t: 'realm-relay-end', receipt: false }],
      ranOn: false,
    });
  }, 30_000);
});

interface WorkerRun {
  code: number | null;
  stdout: string;
  stderr: string;
  ends: Array<Record<string, unknown>>;
  deltas: number;
  /** How many pieces were sent but not yet acknowledged when `watch` first matched the output. */
  pendingAtWatch?: number;
}

interface CollectOptions {
  /** The relay's acknowledgement, this many ms after each piece arrives. */
  ackDelayMs?: number;
  /** The output that must never print while a piece waits for its acknowledgement. */
  watch?: RegExp;
}

/** Reads a worker to its end, acknowledging each piece of the declared set as a relay does. */
function collect(child: ChildProcess, options: CollectOptions = {}): Promise<WorkerRun> {
  onTestFinished(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });
  let stdout = '';
  let stderr = '';
  const ends: Array<Record<string, unknown>> = [];
  let deltas = 0;
  let acked = 0;
  let pendingAtWatch: number | undefined;
  const seen = (): void => {
    if (pendingAtWatch === undefined && options.watch?.test(stdout + stderr) === true) {
      pendingAtWatch = deltas - acked;
    }
  };
  child.stdout!.on('data', (d: Buffer) => {
    stdout += d.toString();
    seen();
  });
  child.stderr!.on('data', (d: Buffer) => {
    stderr += d.toString();
    seen();
  });
  child.on('message', (message: unknown) => {
    const m = message as Record<string, unknown>;
    if (m['t'] === 'realm-relay-end') ends.push(m);
    if (m['t'] === 'realm-relay-delta') {
      deltas += 1;
      const ack = (): void => {
        acked += 1;
        if (child.connected) child.send({ t: 'realm-relay-ack', seq: m['seq'] });
      };
      if (options.ackDelayMs === undefined) ack();
      else setTimeout(ack, options.ackDelayMs);
    }
  });
  return new Promise((resolve) =>
    child.once('close', (code) =>
      resolve({
        code,
        stdout,
        stderr,
        ends,
        deltas,
        ...(pendingAtWatch !== undefined ? { pendingAtWatch } : {}),
      }),
    ),
  );
}

let root: string;
let project: string;
let topLevel: string;
let home: TempHome & { readonly root: string };

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'realm-u1b-exits-'));
  home = await makeTempHome();
  project = join(root, 'project');
  mkdirSync(project);
  writeFileSync(
    join(project, 'realm.yaml'),
    [
      'version: 1',
      'secrets:',
      '  sources: [dotenv]',
      '  dotenv: .env',
      'handlers:',
      '  ok:',
      '    use: ./handlers.mjs#makeOk',
      '    config:',
      "      token: '${secret:U1B_TOKEN}'",
      '  fail:',
      '    use: ./handlers.mjs#makeFail',
      '  fatal:',
      '    use: ./handlers.mjs#makeFatal',
      '  hang:',
      '    use: ./handlers.mjs#makeHang',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(join(project, '.env'), `U1B_TOKEN=${DECLARED}\n`, 'utf8');
  writeFileSync(join(project, 'package.json'), '{ "type": "module" }\n', 'utf8');
  writeFileSync(
    join(project, 'handlers.mjs'),
    `export const makeOk = ({ id }) => ({ id, execute: async () => ({ data: { note: 'ok' } }) });
export const makeFail = ({ id }) => ({ id, execute: async () => { throw new Error('the step failed on purpose'); } });
export const makeFatal = ({ id }) => ({ id, execute: () => { setImmediate(() => { throw new Error('fatal on purpose'); }); return new Promise(() => {}); } });
export const makeHang = ({ id }) => ({ id, execute: () => { process.stdout.write('ready\\n'); return new Promise(() => {}); } });
`,
    'utf8',
  );
  writeFileSync(join(root, 'not-a-provider.mjs'), 'export default {};\n', 'utf8');
  topLevel = join(root, 'top-level');
  mkdirSync(join(topLevel, 'wf'), { recursive: true });
  writeFileSync(
    join(topLevel, 'realm.yaml'),
    [
      'version: 1',
      'secrets:',
      '  sources: [dotenv]',
      '  dotenv: .env',
      'handlers:',
      '  top:',
      '    use: ./top.mjs#makeTop',
      '    config:',
      "      token: '${secret:U1B_TOKEN}'",
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(join(topLevel, '.env'), `U1B_TOKEN=${DECLARED}\n`, 'utf8');
  writeFileSync(join(topLevel, 'package.json'), '{ "type": "module" }\n', 'utf8');
  writeFileSync(
    join(topLevel, 'top.mjs'),
    `import { spawnSync } from 'node:child_process';
spawnSync('sh', ['-c', 'echo "top level printed"'], { stdio: 'inherit' });
export const makeTop = ({ id }) => ({ id, execute: async () => ({ data: { note: 'top' } }) });
`,
    'utf8',
  );
  writeFileSync(
    join(topLevel, 'wf', 'workflow.yaml'),
    'id: u1b-top\nname: top\nversion: 1\nsteps:\n  s:\n    description: One step.\n    execution: auto\n    handler: top\n',
    'utf8',
  );
}, 60_000);

afterAll(async () => {
  await home.cleanup();
  rmSync(root, { recursive: true, force: true });
});

const workflow = (name: string, step: string[], head: string[] = []): string => {
  const at = join(project, `wf-${name}`);
  mkdirSync(at, { recursive: true });
  writeFileSync(
    join(at, 'workflow.yaml'),
    [`id: u1b-exit-${name}`, `name: ${name}`, 'version: 1', ...head, 'steps:', ...step, ''].join(
      '\n',
    ),
    'utf8',
  );
  return at;
};
const auto = (handler: string): string[] => [
  '  s:',
  '    description: One step.',
  '    execution: auto',
  `    handler: ${handler}`,
];

/** The built CLI as this test's worker: its markers name this process, it has a channel. */
function asWorker(
  args: string[],
  extraEnv: Record<string, string> = {},
  options: CollectOptions = {},
): Promise<WorkerRun> {
  const child = fork(CLI, args, {
    cwd: root,
    env: {
      PATH: process.env['PATH'] ?? '',
      HOME: home.root,
      NO_COLOR: '1',
      REALM_NOT_SECRET: 'HOME',
      ANTHROPIC_API_KEY: 'fake-u1b-key-0000',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
      REALM_RELAY_CHILD: String(process.pid),
      REALM_RELAY_KEY: 'cd'.repeat(32),
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  return collect(child, options);
}

const drive = (wf: string, extra: string[] = []): string[] => [
  'agent',
  '--workflow',
  wf,
  '--project',
  project,
  '--provider',
  'anthropic',
  '--model',
  'fake-model',
  ...extra,
];

type ExitRow = [
  string,
  () => string[],
  { code: number; errorLines: number; receipt: boolean },
  Record<string, string>?,
];

const EXITS: ExitRow[] = [
  ['no --workflow and no --run-id', () => ['agent'], { code: 1, errorLines: 1, receipt: false }],
  [
    '--workflow with --run-id',
    () => ['agent', '--workflow', 'x', '--run-id', 'y'],
    { code: 1, errorLines: 1, receipt: false },
  ],
  [
    '--params with --run-id',
    () => ['agent', '--run-id', 'y', '--params', '{"a":1}'],
    { code: 1, errorLines: 1, receipt: false },
  ],
  [
    'the identity exit (an unusable REALM_OPERATOR)',
    () => drive(workflow('identity', auto('ok'))),
    { code: 1, errorLines: 1, receipt: false },
    { REALM_OPERATOR: 'bad\u0007name' },
  ],
  [
    '--prompt-cache on a workflow with no agent step',
    () => drive(workflow('inert-cache', auto('ok')), ['--prompt-cache', 'short']),
    { code: 1, errorLines: 1, receipt: false },
  ],
  [
    '--cache-diagnostics on with no agent step',
    () => drive(workflow('inert-diag', auto('ok')), ['--cache-diagnostics', 'on']),
    { code: 1, errorLines: 1, receipt: false },
  ],
  [
    '--provider-module with --model',
    () => [
      'agent',
      '--workflow',
      workflow('module-model', auto('ok')),
      '--provider-module',
      join(root, 'not-a-provider.mjs'),
      '--model',
      'm',
    ],
    { code: 1, errorLines: 1, receipt: false },
  ],
  [
    'a provider module that cannot be imported',
    () => [
      'agent',
      '--workflow',
      workflow('module-missing', auto('ok')),
      '--provider-module',
      join(root, 'missing.mjs'),
    ],
    { code: 1, errorLines: 1, receipt: false },
  ],
  [
    'a provider module whose default export is no provider',
    () => [
      'agent',
      '--workflow',
      workflow('module-wrong', auto('ok')),
      '--provider-module',
      join(root, 'not-a-provider.mjs'),
    ],
    { code: 1, errorLines: 1, receipt: false },
  ],
  [
    'no --model (the provider flags refused)',
    () => [
      'agent',
      '--workflow',
      workflow('no-model', auto('ok')),
      '--project',
      project,
      '--provider',
      'anthropic',
    ],
    { code: 1, errorLines: 1, receipt: false },
  ],
  [
    'the extensions fail to load',
    () => drive(workflow('bad-ext', auto('ok'), ['extensions: ./missing-module.mjs'])),
    { code: 1, errorLines: 1, receipt: false },
  ],
  [
    'the extensions fail to load, under --log-mode (the receipt printer reached)',
    () =>
      drive(workflow('bad-ext-log', auto('ok'), ['extensions: ./missing-module.mjs']), [
        '--log-mode',
      ]),
    { code: 1, errorLines: 1, receipt: true },
  ],
  [
    'a clean drive',
    () => drive(workflow('clean', auto('ok'))),
    { code: 0, errorLines: 0, receipt: false },
  ],
  [
    'a clean drive under --log-mode',
    () => drive(workflow('clean-log', auto('ok')), ['--log-mode']),
    { code: 0, errorLines: 0, receipt: true },
  ],
  [
    'a failed step',
    () => drive(workflow('failed', auto('fail'))),
    { code: 1, errorLines: 0, receipt: false },
  ],
  [
    'a fatal error (an uncaught throw)',
    () => drive(workflow('fatal', auto('fatal')), ['--log-mode']),
    { code: 1, errorLines: 1, receipt: false },
  ],
];

describe('U1b — (u) every exit of the worker: one end message, at most one error line', () => {
  it.each(EXITS)(
    '%s',
    async (_name, args, expected, extraEnv) => {
      const ran = await asWorker(args(), extraEnv);
      const errorLines = ran.stderr.split('\n').filter((l) => /^Error[: ]/.test(l)).length;
      const identity = /REALM_OPERATOR/.test(ran.stderr.split('\n')[0] ?? '') ? 1 : 0;
      // (a) red when an exit site is left on a bare `process.exit` (no end message), sends two, or
      //     sends `receipt: true` where the receipt printer was not reached; (b) prints the code,
      //     the count of error lines, the end messages' receipts and their count.
      expect({
        code: ran.code,
        errorLines: errorLines + identity,
        ends: ran.ends.length,
        receipt: ran.ends[0]?.['receipt'],
        tally: ran.ends[0]?.['tally'] !== undefined,
      }).toEqual({
        code: expected.code,
        errorLines: expected.errorLines,
        ends: 1,
        receipt: expected.receipt,
        tally: expected.receipt,
      });
    },
    60_000,
  );

  it('a drive under a manifest sends its pieces of the declared set before the handler runs', async () => {
    const ran = await asWorker(drive(workflow('pieces', auto('ok'))));
    // (a) red when the mutators send nothing (the relay then masks no declared value); (b) prints
    //     the count of pieces and the code.
    expect({ code: ran.code, pieces: ran.deltas >= 2 }).toEqual({ code: 0, pieces: true });
  }, 60_000);
});

describe('U1b — the relay holds a declared value before the worker prints next', () => {
  // The relay installs a piece only when it arrives; these cells make the relay slow (400 ms per
  // acknowledgement) so that a print that does not wait for it shows while a piece is pending.
  it("(a2) the `--run-id` ended-run refusal's reason prints only once the run's declared values are acknowledged", async () => {
    const hung = fork(CLI, drive(workflow('hang', auto('hang'))), {
      cwd: root,
      env: {
        PATH: process.env['PATH'] ?? '',
        HOME: home.root,
        NO_COLOR: '1',
        REALM_NOT_SECRET: 'HOME',
        ANTHROPIC_API_KEY: 'fake-u1b-key-0000',
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
        REALM_RELAY_CHILD: String(process.pid),
        REALM_RELAY_KEY: 'cd'.repeat(32),
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const first = collect(hung);
    let out = '';
    hung.stdout!.on('data', (d: Buffer) => (out += d.toString()));
    const by = Date.now() + 30_000;
    while (!out.includes('ready') && Date.now() < by) await new Promise((r) => setTimeout(r, 20));
    const id = /Run ID: ([0-9a-f-]{36})/.exec(out)?.[1];
    hung.kill('SIGKILL');
    await first;
    await abandonRun(home.home.runStore, id!, `upstream refused key ${DECLARED}`);
    const refused = await asWorker(
      ['agent', '--run-id', id!, '--provider', 'anthropic', '--model', 'fake-model'],
      {},
      { ackDelayMs: 400, watch: /Reason:/ },
    );
    // (a) red without the sync at `noteRunManifest`'s end (the reason prints while the run's
    //     declared values wait for the relay); (b) prints the code, the pieces sent and how many
    //     were pending when the reason printed.
    expect({
      code: refused.code,
      pieces: refused.deltas > 0,
      pendingAtReason: refused.pendingAtWatch,
    }).toEqual({ code: 1, pieces: true, pendingAtReason: 0 });
  }, 60_000);

  it("(a3) a handler module's top-level print comes only once the manifest's values are acknowledged", async () => {
    const ran = await asWorker(
      [
        'agent',
        '--workflow',
        join(topLevel, 'wf'),
        '--project',
        topLevel,
        '--provider',
        'anthropic',
        '--model',
        'fake-model',
      ],
      {},
      { ackDelayMs: 400, watch: /top level printed/ },
    );
    // (a) red with the sync after the module imports (the module prints while the manifest's
    //     values wait for the relay); (b) prints the code, the pieces and the count pending then.
    expect({
      code: ran.code,
      pieces: ran.deltas > 0,
      pendingAtPrint: ran.pendingAtWatch,
    }).toEqual({ code: 0, pieces: true, pendingAtPrint: 0 });
  }, 60_000);
});
