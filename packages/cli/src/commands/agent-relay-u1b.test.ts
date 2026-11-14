// agent-relay-u1b.test.ts — U1b Unit 1: in log mode `realm agent` runs its drive in a second process
// (the worker) and keeps the first (the relay) to own the piped streams, so what a program a step's
// handler starts prints there is masked as the handler's own prints are (U1's pass, with its carry).
// Each cell drives the BUILT CLI with real pipes, files or a pseudo-terminal; the handlers are the
// project's own (`handlers.mjs`), the secrets fakes from the project's `.env`, which sits OFF the
// command's cwd (`--project` elsewhere), so the declared value is never in `process.env` and only
// the manifest's resolution can hide it. Every assertion names (a) the break that turns it red and
// (b) what it prints when it fails: counts, kinds, exit codes, line shapes — never a fake value.
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { abandonRun } from '@sensigo/realm';
import { startAnthropicStub } from '../agent/test-support/anthropic-stub.js';
import { makeTempHome, runsOf, type TempHome } from '../test-support/temp-home.js';

// The words an operator reads, as written (the docs quote them; `docs-u1b.test.ts`).
const DRAIN_LINE =
  "A program started by a handler kept the output open after the command's work ended; it has been stopped, and what it printed after that is not in this log.";
const RELAY_STANDING_UNKNOWN_WORDS = 'declared values unknown (the drive ended before it said)';
const RELAY_WALKS_NOT_COUNTED_WORDS =
  'values shown as their type and size: not counted (the drive ended before it said)';
const NOT_BLOCKING_LINE =
  'Error: realm agent cannot hide what its programs print here: this Node.js cannot make the output pipe blocking. Nothing was started.';

const CLI = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
/** The declared fake: 33 characters, in the project's `.env` only. */
const DECLARED = 'CANARY-u1b-declared-7a3c-xxxxxxxx';
/** The environment fake: in the command's environment only. */
const ENV_FAKE = 'CANARY-u1b-environment-5d1e-xxxx';
/** How many times each fake shows in `text` — what a failing cell prints instead of the text. */
const shown = (text: string): { declared: number; environment: number } => ({
  declared: text.split(DECLARED).length - 1,
  environment: text.split(ENV_FAKE).length - 1,
});

const HANDLERS = `import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
const say = (line) => process.stdout.write(line + '\\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (id, execute) => ({ id, execute });
export const makeGrand = ({ id, config }) => step(id, async () => {
  spawnSync('sh', ['-c', 'echo "grandchild: $0 end"', config.token], { stdio: 'inherit' });
  return { data: { note: 'a grandchild printed' } };
});
export const makeEnvGrand = ({ id }) => step(id, async () => {
  spawnSync('sh', ['-c', 'echo "env grandchild: $U1B_ENV_FAKE end"'], { stdio: 'inherit' });
  return { data: { note: 'an env grandchild printed' } };
});
export const makeSplit = ({ id, config }) => step(id, async () => {
  const v = config.token;
  process.stdout.write('split: ' + v.slice(0, 10));
  process.stdout.write(v.slice(10) + ' end\\n');
  return { data: { ok: true } };
});
export const makeChild = ({ id, config }) => step(id, () => new Promise((resolve) => {
  const v = config.token;
  const child = spawn(process.execPath, ['-e', \`process.stdout.write('x'.repeat(65530) + \${JSON.stringify(v)} + ' end\\\\n')\`], { stdio: ['ignore', 'pipe', 'inherit'] });
  let chunks = 0;
  child.stdout.on('data', (d) => { chunks += 1; process.stdout.write(d); });
  child.on('close', () => { process.stdout.write(\`child chunks: \${chunks}\\n\`); resolve({ data: { chunks } }); });
}));
export const makeWho = ({ id }) => step(id, async () => {
  say(\`who: pid=\${process.pid} ppid=\${process.ppid} markers=\${typeof process.env.REALM_RELAY_CHILD},\${typeof process.env.REALM_RELAY_KEY}\`);
  return { data: { note: 'who' } };
});
export const makeOwn = ({ id, config }) => step(id, async () => {
  console.log(\`own out: \${config.token} end\`);
  console.error(\`own err: \${config.token} end\`);
  return { data: { note: 'own prints' } };
});
export const makeFail = ({ id }) => step(id, async () => { throw new Error('the step failed on purpose'); });
export const makeWait = ({ id }) => step(id, async () => {
  if (process.env.U1B_GRACEFUL === '1') process.on('SIGINT', () => {});
  if (process.env.U1B_SAY_SIGNAL !== undefined) {
    const signal = process.env.U1B_SAY_SIGNAL;
    process.once(signal, () => {
      process.stderr.write('got ' + signal + '\\n');
      process.kill(process.pid, signal);
    });
  }
  if (process.env.U1B_LAST_WORDS === '1') {
    process.once('SIGTERM', () => {
      process.stderr.write('last words, no newline');
      process.kill(process.pid, 'SIGTERM');
    });
  }
  say(\`ready: pid=\${process.pid}\`);
  await new Promise(() => {});
});
export const makeGo = ({ id }) => step(id, async () => {
  say(\`ready: pid=\${process.pid}\`);
  while (!existsSync(process.env.U1B_GO)) await sleep(50);
  return { data: { note: 'went on' } };
});
export const makeHold = ({ id }) => step(id, async () => {
  spawn('sleep', ['30'], { stdio: 'inherit' });
  say('held');
  return { data: { note: 'held' } };
});
export const makeBackground = ({ id }) => step(id, async () => {
  spawnSync('sh', ['-c', 'sleep 30 >/dev/null 2>&1 & echo $! > "$U1B_PIDFILE"'], { stdio: 'inherit' });
  return { data: { note: 'backgrounded' } };
});
export const makeSelfKill = ({ id }) => step(id, async () => {
  process.kill(process.pid, 'SIGKILL');
  await new Promise(() => {});
});
export const makeFatal = ({ id }) => step(id, () => {
  setImmediate(() => { throw new Error('fatal on purpose'); });
  return new Promise(() => {});
});
export const makeStdin = ({ id }) => step(id, async () => {
  say('stdin: ' + readFileSync(0, 'utf8').trim());
  return { data: { note: 'read stdin' } };
});
export const makeFlood = ({ id }) => step(id, async () => {
  const line = 'f'.repeat(1023) + '\\n';
  for (let i = 0; i < 65536; i++) process.stdout.write(line);
  say('flood done');
  return { data: { note: 'flooded' } };
});
export const makeLines = ({ id }) => step(id, async () => {
  say('line 1');
  await sleep(300);
  say('line 2');
  await sleep(3000);
  say('line 3');
  return { data: { note: 'three lines' } };
});
export const makeOrder = ({ id }) => step(id, async () => {
  for (let i = 1; i <= 3; i++) { process.stdout.write(\`out \${i}\\n\`); process.stderr.write(\`err \${i}\\n\`); }
  return { data: { note: 'ordered' } };
});
`;

const HANDLER_NAMES: Record<string, string> = {
  grand: 'makeGrand',
  env_grand: 'makeEnvGrand',
  split_writes: 'makeSplit',
  child_chunks: 'makeChild',
  who: 'makeWho',
  own: 'makeOwn',
  fail: 'makeFail',
  wait: 'makeWait',
  go: 'makeGo',
  hold: 'makeHold',
  background: 'makeBackground',
  self_kill: 'makeSelfKill',
  fatal: 'makeFatal',
  stdin: 'makeStdin',
  flood: 'makeFlood',
  lines: 'makeLines',
  order: 'makeOrder',
};

/** A pseudo-terminal runner: `mode` names the streams on the terminal (`out`, `err`, `both`); the
 *  other stream is a pipe. Prints `{ pid, code, tty, pipe }` as JSON. */
const PTY_RUN = `import json, os, pty, select, subprocess, sys
mode, cmd = sys.argv[1], sys.argv[2:]
master, slave = pty.openpty()
out = slave if mode in ('out', 'both') else subprocess.PIPE
err = slave if mode in ('err', 'both') else subprocess.PIPE
p = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=out, stderr=err)
os.close(slave)
pipe = p.stdout if mode == 'err' else (p.stderr if mode == 'out' else None)
fds = {master: b''}
if pipe is not None: fds[pipe.fileno()] = b''
live = set(fds)
while live:
    ready, _, _ = select.select(list(live), [], [], 60)
    if not ready: break
    for fd in ready:
        try: data = os.read(fd, 65536)
        except OSError: data = b''
        if not data: live.discard(fd)
        else: fds[fd] += data
code = p.wait()
pipe_text = fds[pipe.fileno()].decode('utf-8', 'replace') if pipe is not None else ''
print(json.dumps({'pid': p.pid, 'code': code, 'tty': fds[master].decode('utf-8', 'replace').replace('\\r', ''), 'pipe': pipe_text}))
`;

/** Ctrl-Z the way a shell does it: the relay in a process group of its own in this session (whose
 *  parent, this script, is in another group, so the group is never orphaned), SIGTSTP to it, its
 *  stop read with waitpid(WUNTRACED), then SIGCONT. Prints what it saw as JSON. */
const STOP_RUN = `import json, os, signal, sys, time
go, cmd = sys.argv[1], sys.argv[2:]
r, w = os.pipe()
pid = os.fork()
if pid == 0:
    os.setpgid(0, 0)
    os.dup2(w, 1); os.dup2(w, 2); os.close(r); os.close(w)
    os.execvp(cmd[0], cmd)
os.close(w)
buf = b''
while b'ready: pid=' not in buf or b'\\n' not in buf.split(b'ready: pid=', 1)[1]:
    chunk = os.read(r, 65536)
    if not chunk: break
    buf += chunk
worker = int(buf.split(b'ready: pid=', 1)[1].split(b'\\n', 1)[0])
state = lambda p: open('/proc/%d/stat' % p).read().rsplit(') ', 1)[1].split(' ', 1)[0]
os.kill(pid, signal.SIGTSTP)
_, status = os.waitpid(pid, os.WUNTRACED)
stopped = os.WIFSTOPPED(status)
stop_signal = signal.Signals(os.WSTOPSIG(status)).name if stopped else None
time.sleep(0.4)
worker_stopped = state(worker)
os.kill(pid, signal.SIGCONT)
time.sleep(0.4)
worker_resumed = state(worker)
open(go, 'w').close()
while True:
    chunk = os.read(r, 65536)
    if not chunk: break
    buf += chunk
_, status = os.waitpid(pid, 0)
print(json.dumps({'stopped': stopped, 'stopSignal': stop_signal, 'workerWhileStopped': worker_stopped, 'workerAfterCont': worker_resumed, 'code': os.WEXITSTATUS(status) if os.WIFEXITED(status) else None, 'out': buf.decode('utf-8', 'replace')}))
`;

let root: string;
let project: string;
/** A project with no `realm.yaml`: no declared value, no manifest. */
let bare: string;
/** A project whose handler module prints at its top level. */
let topLevel: string;
let cwd: string;
let home: TempHome & { readonly root: string };
let ptyRun: string;
let stopRun: string;

const wf = (dir: string, name: string, lines: string[], head: string[] = []): string => {
  const at = join(dir, `wf-${name}`);
  mkdirSync(at, { recursive: true });
  writeFileSync(
    join(at, 'workflow.yaml'),
    [`id: u1b-${name}`, `name: u1b ${name}`, 'version: 1', ...head, 'steps:', ...lines, ''].join(
      '\n',
    ),
    'utf8',
  );
  return at;
};
/** A workflow of the project without `realm.yaml`: one step its own extension module serves. */
const bareStep = (name: string): string =>
  wf(
    bare,
    name,
    ['  s:', '    description: One step.', '    execution: auto', '    handler: quiet'],
    ['extensions: ../ext.mjs'],
  );
/** One auto step running `handler`. */
/** An agent step the Anthropic stand-in answers: its Result prints, shaped under --log-mode. */
const ASK = ['  ask:', '    description: Answer with a short summary.', '    execution: agent'];
/** The stand-in for a cell, closed after it; the drive's environment pointed at it. */
async function standIn(): Promise<Record<string, string>> {
  const stub = await startAnthropicStub({ finalContent: { summary: 'all done here' } });
  onTestFinished(() => stub.close());
  return env({ ANTHROPIC_BASE_URL: stub.baseUrl });
}
const oneStep = (name: string, handler: string, extra: string[] = []): string =>
  wf(project, name, [
    '  s:',
    '    description: One step.',
    '    execution: auto',
    `    handler: ${handler}`,
    ...extra,
  ]);

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'realm-u1b-'));
  home = await makeTempHome();
  cwd = join(root, 'cwd');
  mkdirSync(cwd);
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
      ...Object.entries(HANDLER_NAMES).flatMap(([name, factory]) => [
        `  ${name}:`,
        `    use: ./handlers.mjs#${factory}`,
        '    config:',
        "      token: '${secret:U1B_TOKEN}'",
      ]),
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(join(project, '.env'), `U1B_TOKEN=${DECLARED}\n`, 'utf8');
  writeFileSync(join(project, 'handlers.mjs'), HANDLERS, 'utf8');
  writeFileSync(join(project, 'package.json'), '{ "type": "module" }\n', 'utf8');

  topLevel = join(root, 'top-level');
  mkdirSync(topLevel);
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
  // A module whose top-level code reads the project's secret and starts a program that prints it.
  writeFileSync(
    join(topLevel, 'top.mjs'),
    `import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const fake = /U1B_TOKEN=(.*)/.exec(readFileSync(new URL('./.env', import.meta.url), 'utf8'))[1];
spawnSync('sh', ['-c', 'echo "top level: $0 end"', fake], { stdio: 'inherit' });
export const makeTop = ({ id }) => ({ id, execute: async () => ({ data: { note: 'top' } }) });
`,
    'utf8',
  );

  bare = join(root, 'bare');
  mkdirSync(bare);
  writeFileSync(join(bare, 'package.json'), '{ "type": "module" }\n', 'utf8');
  writeFileSync(
    join(bare, 'ext.mjs'),
    "export default { handlers: { quiet: { id: 'quiet', execute: async () => ({ data: { note: 'quiet' } }) } } };\n",
    'utf8',
  );
  ptyRun = join(root, 'pty_run.py');
  writeFileSync(ptyRun, PTY_RUN, 'utf8');
  stopRun = join(root, 'stop_run.py');
  writeFileSync(stopRun, STOP_RUN, 'utf8');
}, 60_000);

afterAll(async () => {
  await home.cleanup();
  rmSync(root, { recursive: true, force: true });
});

/** The drive's environment: a fresh HOME (listed as not secret, so paths print whole), the fake
 *  provider key, no real address. */
const env = (extra: Record<string, string> = {}): Record<string, string> => ({
  PATH: process.env['PATH'] ?? '',
  HOME: home.root,
  NO_COLOR: '1',
  REALM_NOT_SECRET: 'HOME',
  ANTHROPIC_API_KEY: 'fake-u1b-key-0000',
  ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
  ...extra,
});
const agentArgs = (workflow: string, dir = project, extra: string[] = []): string[] => [
  CLI,
  'agent',
  '--workflow',
  workflow,
  '--project',
  dir,
  '--provider',
  'anthropic',
  '--model',
  'fake-model',
  ...extra,
];

interface Ran {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  pid: number;
}

interface Started {
  child: ChildProcess;
  out(): string;
  err(): string;
  /** Resolves when `re` matches stdout or stderr (within `ms`), with the match. */
  waitFor(re: RegExp, ms?: number): Promise<RegExpExecArray>;
  done: Promise<Ran>;
}

/** Starts `node <args>` with piped stdio (unless `stdio` says otherwise); killed after the cell. */
function start(
  args: string[],
  options: { env?: Record<string, string>; input?: string } = {},
): Started {
  const child = spawn(process.execPath, args, {
    cwd,
    env: options.env ?? env(),
    stdio: [options.input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  });
  onTestFinished(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });
  if (options.input !== undefined) child.stdin!.end(options.input);
  let out = '';
  let err = '';
  child.stdout!.on('data', (d: Buffer) => (out += d.toString()));
  child.stderr!.on('data', (d: Buffer) => (err += d.toString()));
  const done = new Promise<Ran>((resolve) =>
    child.once('close', (code, signal) =>
      resolve({ code, signal, stdout: out, stderr: err, pid: child.pid! }),
    ),
  );
  const waitFor = async (re: RegExp, ms = 20_000): Promise<RegExpExecArray> => {
    const by = Date.now() + ms;
    for (;;) {
      const m = re.exec(out) ?? re.exec(err);
      if (m !== null) return m;
      if (Date.now() > by || child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`no ${String(re)} within ${ms} ms (exit ${String(child.exitCode)})`);
      }
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  return { child, out: () => out, err: () => err, waitFor, done };
}

const run = (args: string[], options: { env?: Record<string, string>; input?: string } = {}) =>
  start(args, options).done;

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const waitDead = async (pid: number, ms: number): Promise<number | undefined> => {
  const from = Date.now();
  while (Date.now() - from < ms) {
    if (!alive(pid)) return Date.now() - from;
    await new Promise((r) => setTimeout(r, 10));
  }
  return undefined;
};
const disclosureLines = (text: string): string[] =>
  text.split('\n').filter((l) => l.startsWith('Disclosure:'));
/** The `who:` line's fields. */
const who = (text: string) => {
  const m = /who: pid=(\d+) ppid=(\d+) markers=(\w+),(\w+)/.exec(text);
  return m === null
    ? undefined
    : { pid: Number(m[1]), ppid: Number(m[2]), markers: [m[3], m[4]] as const };
};

describe('U1b — a program a handler starts is masked in a piped log', () => {
  it('(a) a grandchild with inherited stdio prints a DECLARED fake (dotenv off cwd) → [REDACTED]; with --log-mode the receipt counts it declared', async () => {
    const w = oneStep('grand', 'grand');
    const plain = await run(agentArgs(w));
    const logged = await run(agentArgs(w, project, ['--log-mode']));
    const line = (text: string) => text.split('\n').find((l) => l.startsWith('grandchild: '));
    // (a) red on the base (the grandchild's bytes land whole: declared 1); red under "the relay
    //     holds no declared set" (the receipt's hidden count 0); (b) prints the exit codes, the
    //     grandchild's line (masked), the counts of the fake and the receipt.
    expect({
      codes: [plain.code, logged.code],
      lines: [line(plain.stdout), line(logged.stdout)],
      fake: shown(plain.stdout + plain.stderr + logged.stdout + logged.stderr),
      plainReceipt: disclosureLines(plain.stderr),
      hidden: disclosureLines(logged.stderr).map((l) => /hidden (\d+) declared/.exec(l)?.[1]),
    }).toEqual({
      codes: [0, 0],
      lines: ['grandchild: [REDACTED] end', 'grandchild: [REDACTED] end'],
      fake: { declared: 0, environment: 0 },
      plainReceipt: [],
      hidden: ['1'],
    });
  }, 90_000);

  it('(b) a grandchild prints an ENVIRONMENT fake → [REDACTED]; the receipt counts it environment', async () => {
    const w = oneStep('env-grand', 'env_grand');
    const ran = await run(agentArgs(w, project, ['--log-mode']), {
      env: env({ U1B_ENV_FAKE: ENV_FAKE }),
    });
    // (a) red on the base (the bytes land whole); (b) prints the code, the line, the counts.
    expect({
      code: ran.code,
      line: ran.stdout.split('\n').find((l) => l.startsWith('env grandchild: ')),
      fake: shown(ran.stdout + ran.stderr),
      hidden: disclosureLines(ran.stderr).map((l) => /(\d+) environment,/.exec(l)?.[1]),
    }).toEqual({
      code: 0,
      line: 'env grandchild: [REDACTED] end',
      fake: { declared: 0, environment: 0 },
      hidden: ['1'],
    });
  }, 60_000);

  it("(c) U1's two shapes through the relay: two writes, and a child relayed per chunk → both [REDACTED]", async () => {
    const w = wf(project, 'carry', [
      '  split:',
      '    description: Two writes.',
      '    execution: auto',
      '    handler: split_writes',
      '  child:',
      "    description: A child's chunks.",
      '    execution: auto',
      '    depends_on: [split]',
      '    handler: child_chunks',
    ]);
    const ran = await run(agentArgs(w));
    const lines = ran.stdout.split('\n');
    // (a) red when the relay masks each chunk alone (no carry per stream: the fake whole on both
    //     lines); (b) prints the two lines (the child's x run cut off) and the counts.
    expect({
      code: ran.code,
      split: lines.filter((l) => l.startsWith('split: ')),
      child: lines.filter((l) => l.startsWith('x'.repeat(65530))).map((l) => l.slice(65530)),
      chunked: Number(/child chunks: (\d+)/.exec(ran.stdout)?.[1] ?? 0) >= 2,
      fake: shown(ran.stdout + ran.stderr),
    }).toEqual({
      code: 0,
      split: ['split: [REDACTED] end'],
      child: ['[REDACTED] end'],
      chunked: true,
      fake: { declared: 0, environment: 0 },
    });
  }, 60_000);

  it('(a3) a handler module whose top-level code starts a program that prints a declared fake → [REDACTED]', async () => {
    const w = wf(topLevel, 'top', [
      '  s:',
      '    description: One step.',
      '    execution: auto',
      '    handler: top',
    ]);
    const ran = await run(agentArgs(w, topLevel));
    // (a) red with the relay's sync awaited after the module imports (the module's program prints
    //     before the relay holds the value); (b) prints the code, the line and the counts.
    expect({
      code: ran.code,
      line: ran.stdout.split('\n').find((l) => l.startsWith('top level: ')),
      fake: shown(ran.stdout + ran.stderr),
    }).toEqual({
      code: 0,
      line: 'top level: [REDACTED] end',
      fake: { declared: 0, environment: 0 },
    });
  }, 60_000);

  it("(t-iii) the relay's stdout a file (`> log`) → no guard fires, the grandchild masked in the file", async () => {
    const w = oneStep('grand-file', 'grand');
    const log = join(root, 'grand-file.log');
    const fd = openSync(log, 'w');
    let code: number | null;
    try {
      code = spawnSync(process.execPath, agentArgs(w), {
        cwd,
        env: env(),
        stdio: ['ignore', fd, 'pipe'],
        timeout: 60_000,
      }).status;
    } finally {
      closeSync(fd);
    }
    const text = readFileSync(log, 'utf8');
    // (a) red when a handle-less stream (a file) is treated as one lacking the call (one line,
    //     exit 1); (b) prints the code, the line, the guard's presence and the counts.
    expect({
      code,
      line: text.split('\n').find((l) => l.startsWith('grandchild: ')),
      guard: text.includes(NOT_BLOCKING_LINE),
      fake: shown(text),
    }).toEqual({
      code: 0,
      line: 'grandchild: [REDACTED] end',
      guard: false,
      fake: { declared: 0, environment: 0 },
    });
  }, 60_000);

  it('(a2) the `--run-id` ended-run refusal with a declared value in its reason (dotenv off cwd, `2>>log`) → [REDACTED]', async () => {
    // A run of this project ended with the declared fake in its reason: the abandon command stores
    // the reason; the run's record names the project's manifest (the drive loaded it).
    const w = oneStep('ended', 'wait');
    const first = start(agentArgs(w));
    const id = (await first.waitFor(/Run ID: ([0-9a-f-]{36})/))[1]!;
    const worker = Number((await first.waitFor(/ready: pid=(\d+)/))[1]);
    first.child.kill('SIGKILL');
    await first.done;
    await waitDead(worker, 5000);
    await abandonRun(home.home.runStore, id, `upstream refused key ${DECLARED}`);
    const log = join(root, 'ended.log');
    writeFileSync(log, '');
    const fd = openSync(log, 'a');
    let code: number | null;
    try {
      code = spawnSync(
        process.execPath,
        [CLI, 'agent', '--run-id', id!, '--provider', 'anthropic', '--model', 'fake-model'],
        { cwd, env: env(), stdio: ['ignore', 'pipe', fd], timeout: 60_000 },
      ).status;
    } finally {
      closeSync(fd);
    }
    const text = readFileSync(log, 'utf8');
    // (a) red without the relay's sync at `noteRunManifest`'s end (the reason prints before the
    //     relay holds the run's declared values); (b) prints the code, the Reason line and counts.
    expect({
      code,
      reason: text.split('\n').find((l) => l.startsWith('Reason:')),
      fake: shown(text),
    }).toEqual({
      code: 1,
      reason: 'Reason: "upstream refused key [REDACTED]"',
      fake: { declared: 0, environment: 0 },
    });
  }, 90_000);
});

describe("U1b — spans: Realm's own words through the relay", () => {
  it('(d) a blocked step under a home-dir project: the re-attach command prints the home path whole', async () => {
    const inHome = join(home.root, 'home-project');
    mkdirSync(join(inHome, 'wf'), { recursive: true });
    writeFileSync(
      join(inHome, 'wf', 'workflow.yaml'),
      [
        'id: u1b-blocked',
        'name: u1b blocked',
        'version: 1',
        'steps:',
        '  s:',
        '    description: A step no handler serves.',
        '    execution: auto',
        '    handler: not_registered_here',
        '',
      ].join('\n'),
      'utf8',
    );
    const ran = await run(agentArgs(join(inHome, 'wf'), inHome), {
      env: { ...env(), REALM_NOT_SECRET: '' },
    });
    const text = ran.stdout + ran.stderr;
    // (a) red when the worker strips its marks on a relayed stream, or the key differs per process
    //     (the span does not verify, so the home path, an environment value, is masked); (b) prints
    //     whether the command and the home path show, and the line's shape.
    expect({
      command: /re-attach \(`realm agent --run-id [0-9a-f-]{36} /.test(text),
      homeWhole: text.includes(`--project ${inHome}`),
      masked: /re-attach \(`[^`]*\[REDACTED\]/.test(text),
    }).toEqual({ command: true, homeWhole: true, masked: false });
  }, 60_000);

  it('(d) a gate question with an environment fake shows it whole (the declared tier); a declared fake in it is [REDACTED]', async () => {
    const w = wf(project, 'gate', [
      '  s:',
      '    description: A step a person confirms.',
      '    execution: auto',
      '    handler: who',
      '    trust: human_confirmed',
      '    gate:',
      '      choices: [approve, reject]',
      '      message: "Ship {{ run.params.env_fake }} with {{ run.params.declared }}?"',
    ]);
    const started = start(
      agentArgs(w, project, [
        '--params',
        JSON.stringify({ env_fake: ENV_FAKE, declared: DECLARED }),
      ]),
      { env: env({ U1B_ENV_FAKE: ENV_FAKE }) },
    );
    const question = await started.waitFor(/Ship .* with .*\?/);
    started.child.kill('SIGKILL');
    // (a) red when the key differs per process or the worker strips the question span (the line is
    //     masked at the log's tier: the environment fake hidden); (b) prints the question's shape.
    expect(question[0]).toEqual(`Ship ${ENV_FAKE} with [REDACTED]?`);
  }, 60_000);

  it("(d) Realm's phase word prints whole while an environment variable holds it", async () => {
    const w = oneStep('phase', 'who');
    const ran = await run(agentArgs(w), { env: env({ U1B_PHASE_WORD: 'completed' }) });
    // (a) red when the worker strips its marks or the key differs per process (the word, an
    //     environment value, is masked); (b) prints the line.
    expect(ran.stdout.split('\n').find((l) => l.startsWith('  ✓ → '))).toBe('  ✓ → completed');
  }, 60_000);
});

describe('U1b — the receipt: one line, the relay’s', () => {
  it('(e) ONE `Disclosure:` line counting the grandchild’s hide, the worker’s standing word and its walks', async () => {
    const w = wf(project, 'receipt', [
      '  a:',
      '    description: A grandchild prints.',
      '    execution: auto',
      '    handler: grand',
      ...ASK,
      '    depends_on: [a]',
    ]);
    const ran = await run(agentArgs(w, project, ['--log-mode']), { env: await standIn() });
    const lines = disclosureLines(ran.stderr);
    // (a) red when the worker prints its own line too (two lines); red when the relay drops the
    //     worker's tally (`0 values shown`); (b) prints the lines.
    expect({ code: ran.code, lines }).toEqual({
      code: 0,
      lines: [
        'Disclosure: declared values resolved; environment swept; hidden 1 declared, 0 environment, 0 by pattern; 0 not checked; 0 too short to hide; 1 value shown as its type and size.',
      ],
    });
  }, 60_000);

  it('(e2) the worker dies before its first piece of the declared set → the standing reads "unknown (the drive ended before it said)"', async () => {
    const module = join(root, 'dies-at-import.mjs');
    writeFileSync(module, "process.kill(process.pid, 'SIGKILL');\nexport default {};\n", 'utf8');
    const w = oneStep('dies-early', 'who');
    const ran = await run([
      CLI,
      'agent',
      '--workflow',
      w,
      '--project',
      project,
      '--provider-module',
      module,
      '--log-mode',
    ]);
    // (a) red when the relay prints the standing of a drive that said nothing (`unknown (no
    //     manifest)`), or no line at all; (b) prints the code, the signal and the lines.
    expect({ code: ran.code, signal: ran.signal, lines: disclosureLines(ran.stderr) }).toEqual({
      code: null,
      signal: 'SIGKILL',
      lines: [
        `Disclosure: ${RELAY_STANDING_UNKNOWN_WORDS}; environment swept; hidden 0 declared, 0 environment, 0 by pattern; 0 not checked; 0 too short to hide; ${RELAY_WALKS_NOT_COUNTED_WORDS}.`,
      ],
    });
  }, 60_000);

  it('(e3) an abrupt death (SIGKILL to the worker) → the receipt says the walks were not counted, no question clause', async () => {
    const w = wf(project, 'abrupt', [
      '  a:',
      '    description: A grandchild prints.',
      '    execution: auto',
      '    handler: grand',
      '  b:',
      '    description: The worker dies.',
      '    execution: auto',
      '    depends_on: [a]',
      '    handler: self_kill',
    ]);
    const ran = await run(agentArgs(w, project, ['--log-mode']));
    // (a) red when the relay prints no line after an abrupt death, or renders the walks' count as
    //     if the worker had said it; (b) prints the code, the signal and the lines.
    expect({ code: ran.code, signal: ran.signal, lines: disclosureLines(ran.stderr) }).toEqual({
      code: null,
      signal: 'SIGKILL',
      lines: [
        `Disclosure: declared values resolved; environment swept; hidden 1 declared, 0 environment, 0 by pattern; 0 not checked; 0 too short to hide; ${RELAY_WALKS_NOT_COUNTED_WORDS}.`,
      ],
    });
  }, 60_000);

  it('(e5) a project with no `realm.yaml`, a clean end → `declared values unknown (no manifest)`, as on the base', async () => {
    const ran = await run(agentArgs(bareStep('bare'), bare, ['--log-mode']));
    // (a) red under an unscoped rule (the relay's "before it said" standing whenever no piece
    //     arrived, the end message notwithstanding); (b) prints the code and the lines' standings.
    expect({
      code: ran.code,
      standing: disclosureLines(ran.stderr).map((l) => l.split(';')[0]),
    }).toEqual({ code: 0, standing: ['Disclosure: declared values unknown (no manifest)'] });
  }, 60_000);

  it('(e4) a refusal exit prints no `Disclosure:` line; a fatal error prints none', async () => {
    const refusal = await run([
      CLI,
      'agent',
      '--workflow',
      oneStep('refused', 'who'),
      '--provider-module',
      join(root, 'none.mjs'),
      '--model',
      'm',
      '--log-mode',
    ]);
    const fatal = await run(agentArgs(oneStep('fatal', 'fatal'), project, ['--log-mode']));
    // (a) red when the relay prints a line on a refusal or a fatal end (it reads `receipt: false`
    //     as an abrupt death); (b) prints the codes, the error lines' starts and the receipts.
    expect({
      codes: [refusal.code, fatal.code],
      refusal: refusal.stderr.split('\n').filter((l) => l.startsWith('Error:')).length,
      fatal: fatal.stderr.includes('Error: fatal on purpose'),
      receipts: [disclosureLines(refusal.stderr), disclosureLines(fatal.stderr)],
    }).toEqual({ codes: [1, 1], refusal: 1, fatal: true, receipts: [[], []] });
  }, 60_000);

  it('(m) --log-mode and --spawned-by-listen through the relay → values as their type and size, counted on the receipt', async () => {
    const w = wf(project, 'shaped', ASK);
    const logMode = await run(agentArgs(w, project, ['--log-mode']), { env: await standIn() });
    const listen = await run(agentArgs(w, project, ['--spawned-by-listen']), {
      env: await standIn(),
    });
    const shapes = (text: string) => /‹string, \d+ characters›/.test(text);
    const count = (text: string) =>
      disclosureLines(text).map((l) => /; (\d+) values? shown as/.exec(l)?.[1]);
    // (a) red when the worker's mode stops being `broadcast` (values print whole) or its tally is
    //     not merged (0); (b) prints the codes, whether shapes show, the counts.
    expect({
      codes: [logMode.code, listen.code],
      shapes: [shapes(logMode.stdout), shapes(listen.stdout)],
      counts: [count(logMode.stderr), count(listen.stderr)],
    }).toEqual({ codes: [0, 0], shapes: [true, true], counts: [['1'], ['1']] });
  }, 60_000);
});

describe('U1b — exits, signals and the drain', () => {
  it("(f) a failing handler step → the relay's code is the worker's", async () => {
    const ran = await run(agentArgs(oneStep('fails', 'fail')));
    // (a) red when the relay ends with a code of its own; (b) prints the code and the step line.
    expect({
      code: ran.code,
      failed: ran.stderr.includes("Step 's' failed"),
    }).toEqual({ code: 1, failed: true });
  }, 60_000);

  it('(f) SIGTERM to the relay → the group receives it, the relay dies by SIGTERM, the worker’s last partial stderr line arrives whole', async () => {
    const started = start(agentArgs(oneStep('term', 'wait')), {
      env: env({ U1B_LAST_WORDS: '1' }),
    });
    const ready = await started.waitFor(/ready: pid=(\d+)/);
    const worker = Number(ready[1]);
    started.child.kill('SIGTERM');
    const ran = await started.done;
    // (a) red when the relay re-raises before the drain and the flush (the held partial line is
    //     lost); red when the signal is not forwarded (the worker lives); (b) prints the relay's
    //     end, the worker's state and whether the last words arrived.
    expect({
      code: ran.code,
      signal: ran.signal,
      workerGone: !alive(worker),
      lastWords: ran.stderr.endsWith('last words, no newline'),
    }).toEqual({ code: null, signal: 'SIGTERM', workerGone: true, lastWords: true });
  }, 60_000);

  it.each(['SIGINT', 'SIGHUP'] as const)(
    '(f2) %s to the relay reaches the worker; the relay dies by the same signal',
    async (signal) => {
      const started = start(agentArgs(oneStep(`one-${signal.toLowerCase()}`, 'wait')), {
        env: env({ U1B_SAY_SIGNAL: signal }),
      });
      await started.waitFor(/ready: pid=(\d+)/);
      started.child.kill(signal);
      const ran = await started.done;
      // (a) red when the signal is not forwarded to the worker's group (the worker never says it
      //     got it), or the relay ends by a code of its own; (b) prints the relay's end and whether
      //     the worker said it got the signal.
      expect({
        code: ran.code,
        signal: ran.signal,
        workerGot: ran.stderr.includes(`got ${signal}\n`),
      }).toEqual({ code: null, signal, workerGot: true });
    },
    60_000,
  );

  it('(g) a second SIGINT → SIGKILL to the group within 100 ms', async () => {
    const started = start(agentArgs(oneStep('twice', 'wait')), {
      env: env({ U1B_GRACEFUL: '1' }),
    });
    const worker = Number((await started.waitFor(/ready: pid=(\d+)/))[1]);
    started.child.kill('SIGINT');
    await new Promise((r) => setTimeout(r, 300));
    const survivedFirst = alive(worker);
    started.child.kill('SIGINT');
    const deadIn = await waitDead(worker, 2000);
    const ran = await started.done;
    // (a) red without the second-signal branch (the worker lives until the 10 s bound); (b) prints
    //     whether the first SIGINT left it alive, how long the second took, the relay's end.
    expect({
      survivedFirst,
      killedFast: deadIn !== undefined && deadIn < 100,
      signal: ran.signal,
    }).toEqual({ survivedFirst: true, killedFast: true, signal: 'SIGKILL' });
  }, 60_000);

  it('(h) a handler leaves `sleep 30` holding the output → the relay ends within 5 s of the worker’s exit, one drain line, the code kept', async () => {
    const started = start(agentArgs(oneStep('hold', 'hold')));
    await started.waitFor(/Run complete/);
    const from = Date.now();
    const ran = await started.done;
    const took = Date.now() - from;
    // (a) red under "wait for close forever" (the relay lives until the sleep ends, 30 s); (b)
    //     prints the code, how many drain lines and whether it ended within the bound.
    expect({
      code: ran.code,
      drainLines: ran.stderr.split('\n').filter((l) => l === DRAIN_LINE).length,
      withinBound: took < 7000,
    }).toEqual({ code: 0, drainLines: 1, withinBound: true });
  }, 60_000);

  it('(h3) the drain bound under --log-mode → the drain line AND the receipt', async () => {
    const ran = await run(agentArgs(oneStep('hold-log', 'hold'), project, ['--log-mode']));
    // (a) red when the bound's end skips the receipt; (b) prints the code, the lines' counts.
    expect({
      code: ran.code,
      drain: ran.stderr.split('\n').filter((l) => l === DRAIN_LINE).length,
      receipts: disclosureLines(ran.stderr).length,
    }).toEqual({ code: 0, drain: 1, receipts: 1 });
  }, 60_000);

  it('(h2) a handler’s backgrounded `sleep 30 >/dev/null 2>&1 &` survives a clean drive end', async () => {
    const pidfile = join(root, 'background.pid');
    const ran = await run(agentArgs(oneStep('background', 'background')), {
      env: env({ U1B_PIDFILE: pidfile }),
    });
    const pid = Number(readFileSync(pidfile, 'utf8').trim());
    const survived = alive(pid);
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
    // (a) red under an ungated group SIGTERM at the relay's exit (the program is killed); (b)
    //     prints the code and whether it survived.
    expect({ code: ran.code, survived }).toEqual({ code: 0, survived: true });
  }, 60_000);

  it('(m2) `kill -9 <relay>` → the worker exits within 5 s (its channel closed)', async () => {
    const started = start(agentArgs(oneStep('orphan', 'wait')));
    const worker = Number((await started.waitFor(/ready: pid=(\d+)/))[1]);
    // A worker that outlives its relay (the cell's red) is not left behind.
    onTestFinished(() => {
      if (alive(worker)) process.kill(worker, 'SIGKILL');
    });
    started.child.kill('SIGKILL');
    const deadIn = await waitDead(worker, 5000);
    // (a) red when the worker ignores the disconnect (it lives on, an orphan); (b) prints how long.
    expect({ gone: deadIn !== undefined }).toEqual({ gone: true });
  }, 60_000);

  it("(m3) the relay's fatal (EPIPE on its stdout under `| head -1`) → the worker is gone within 5 s and makes no further store write", async () => {
    const isolated = await makeTempHome();
    onTestFinished(() => isolated.cleanup());
    const w = oneStep('epipe', 'lines');
    const child = spawn(process.execPath, agentArgs(w), {
      cwd,
      env: { ...env(), HOME: isolated.root },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    onTestFinished(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    });
    let err = '';
    child.stderr!.on('data', (d: Buffer) => (err += d.toString()));
    // `| head -1`: read the first line, then close the read end.
    await new Promise<void>((resolve) => {
      let out = '';
      child.stdout!.on('data', (d: Buffer) => {
        out += d.toString();
        if (out.includes('line 1')) {
          child.stdout!.destroy();
          resolve();
        }
      });
    });
    const exit = await new Promise<number | null>((r) => child.once('close', (code) => r(code)));
    await new Promise((r) => setTimeout(r, 4500));
    const record = (await runsOf(isolated.home.runStore))[0]?.record;
    // (a) red when the relay's exit leaves the worker running (it completes its step and writes the
    //     store); (b) prints the relay's code and the step lists.
    expect({
      exit,
      completed: record?.completed_steps ?? [],
      inProgress: record?.in_progress_steps ?? [],
    }).toEqual({ exit: 1, completed: [], inProgress: ['s'] });
  }, 60_000);

  it('(n2) a slow consumer → the relay’s memory stays bounded, the worker’s end waits for its writes, nothing lost', async () => {
    const child = spawn(process.execPath, agentArgs(oneStep('flood', 'flood')), {
      cwd,
      env: env(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    onTestFinished(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    });
    child.stdout!.pause();
    await new Promise((r) => setTimeout(r, 3000));
    const rss = (): number =>
      Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${child.pid}/status`, 'utf8'))?.[1] ?? 0);
    const whilePaused = rss();
    let bytes = 0;
    let tail = '';
    child.stdout!.on('data', (d: Buffer) => {
      bytes += d.length;
      tail = (tail + d.toString()).slice(-4096);
    });
    child.stdout!.resume();
    const code = await new Promise<number | null>((r) => child.once('close', (c) => r(c)));
    // (a) red when the relay buffers what it cannot write (its memory grows with the 64 MiB), or
    //     the worker's end drops pending writes; (b) prints the relay's memory while paused, the
    //     byte count's floor check and the code.
    expect(
      {
        code,
        bounded: whilePaused < 150_000,
        everyLine: bytes >= 65536 * 1024,
        ended: tail.includes('flood done'),
      },
      `relay VmRSS ${String(whilePaused)} KiB while paused; ${String(bytes)} bytes read`,
    ).toEqual({ code: 0, bounded: true, everyLine: true, ended: true });
  }, 90_000);

  it('(o) `2>&1`: the two pipes merged in poll order, each line whole — the order as built', async () => {
    const w = oneStep('order', 'order');
    const r = spawnSync('sh', ['-c', `"$0" "$@" 2>&1`, process.execPath, ...agentArgs(w)], {
      cwd,
      env: env(),
      encoding: 'utf8',
      timeout: 60_000,
    });
    const lines = r.stdout.split('\n').filter((l) => /^(out|err) \d$/.test(l));
    // (a) red when a line is cut or lost in the merge; (b) prints the six lines in the order seen.
    expect({ code: r.status, sorted: [...lines].sort(), count: lines.length }).toEqual({
      code: 0,
      sorted: ['err 1', 'err 2', 'err 3', 'out 1', 'out 2', 'out 3'],
      count: 6,
    });
    // The order as built: each stream's own lines in order (a stderr line may move ahead of a
    // stdout line written just before it, the two pipes being read in poll order).
    expect({
      out: lines.filter((l) => l.startsWith('out')),
      err: lines.filter((l) => l.startsWith('err')),
    }).toEqual({ out: ['out 1', 'out 2', 'out 3'], err: ['err 1', 'err 2', 'err 3'] });
  }, 60_000);

  it('(p) `printf data | realm agent …` → a handler reads the data', async () => {
    const ran = await run(agentArgs(oneStep('stdin', 'stdin')), { input: 'piped data\n' });
    // (a) red when the worker's stdin is not inherited (the handler reads nothing); (b) prints the
    //     code and the line.
    expect({
      code: ran.code,
      line: ran.stdout.split('\n').find((l) => l.startsWith('stdin: ')),
    }).toEqual({ code: 0, line: 'stdin: piped data' });
  }, 60_000);
});

describe('U1b — the trigger and the marker', () => {
  it('(q) stdout a terminal, stderr piped → stderr relayed, the terminal masked `private` by the worker; the mirror; both terminals → no relay; --log-mode on a terminal → a relay', async () => {
    const w = oneStep('tty', 'own');
    const wWho = oneStep('tty-who', 'who');
    const pty = (mode: string, args: string[]) => {
      const r = spawnSync('python3', [ptyRun, mode, process.execPath, ...args], {
        cwd,
        env: env(),
        encoding: 'utf8',
        timeout: 60_000,
      });
      return JSON.parse(r.stdout) as { pid: number; code: number; tty: string; pipe: string };
    };
    const outTty = pty('out', agentArgs(w));
    const errTty = pty('err', agentArgs(w));
    const both = pty('both', agentArgs(wWho));
    const bothLog = pty('both', agentArgs(wWho, project, ['--log-mode']));
    const ownLine = (text: string, which: string) =>
      text.split('\n').find((l) => l.startsWith(`own ${which}: `));
    const marks = (text: string) => /[-]/.test(text);
    const relayed = (r: { pid: number; tty: string }) => who(r.tty)?.ppid === r.pid;
    // (a) red under "the worker masks nothing" (the handler's own print on the terminal reads the
    //     fake whole); red when the trigger ignores one stream; (b) prints each layout's lines, the
    //     span-mark check and whether a relay ran.
    expect({
      codes: [outTty.code, errTty.code, both.code, bothLog.code],
      outTty: [ownLine(outTty.tty, 'out'), ownLine(outTty.pipe, 'err'), marks(outTty.tty)],
      errTty: [ownLine(errTty.pipe, 'out'), ownLine(errTty.tty, 'err'), marks(errTty.tty)],
      bothRelayed: relayed(both),
      logModeRelayed: relayed(bothLog),
      fake: shown(outTty.tty + outTty.pipe + errTty.tty + errTty.pipe),
    }).toEqual({
      codes: [0, 0, 0, 0],
      outTty: ['own out: [REDACTED] end', 'own err: [REDACTED] end', false],
      errTty: ['own out: [REDACTED] end', 'own err: [REDACTED] end', false],
      bothRelayed: false,
      logModeRelayed: true,
      fake: { declared: 0, environment: 0 },
    });
  }, 120_000);

  it('(k-i) `REALM_RELAY_CHILD=1 realm agent … > log` (no channel) → two processes, masked; a handler sees neither marker', async () => {
    const w = wf(project, 'marker', [
      '  a:',
      '    description: Who.',
      '    execution: auto',
      '    handler: who',
      '  b:',
      '    description: A grandchild prints.',
      '    execution: auto',
      '    depends_on: [a]',
      '    handler: grand',
    ]);
    const ran = await run(agentArgs(w), { env: env({ REALM_RELAY_CHILD: '1' }) });
    const seen = who(ran.stdout);
    // (a) red when the marker is honoured without its pid check (one process: the handler's parent
    //     is this test), or a marker reaches the handler; (b) prints the pids' relation, the
    //     markers' types and the counts.
    expect({
      code: ran.code,
      twoProcesses: seen?.ppid === ran.pid,
      markers: seen?.markers,
      line: ran.stdout.split('\n').find((l) => l.startsWith('grandchild: ')),
      fake: shown(ran.stdout + ran.stderr),
    }).toEqual({
      code: 0,
      twoProcesses: true,
      markers: ['undefined', 'undefined'],
      line: 'grandchild: [REDACTED] end',
      fake: { declared: 0, environment: 0 },
    });
  }, 60_000);

  it('(k-ii) a channel and both markers but a parent pid that does not match → still two processes, masked, nothing sent on the channel', async () => {
    const w = wf(project, 'marker-ipc', [
      '  a:',
      '    description: Who.',
      '    execution: auto',
      '    handler: who',
      '  b:',
      '    description: A grandchild prints.',
      '    execution: auto',
      '    depends_on: [a]',
      '    handler: grand',
    ]);
    const child = spawn(process.execPath, agentArgs(w), {
      cwd,
      env: env({ REALM_RELAY_CHILD: '1', REALM_RELAY_KEY: 'ab'.repeat(32) }),
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    onTestFinished(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    });
    let out = '';
    let err = '';
    let messages = 0;
    child.stdout!.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr!.on('data', (d: Buffer) => (err += d.toString()));
    child.on('message', () => (messages += 1));
    const code = await new Promise<number | null>((r) => child.once('close', (c) => r(c)));
    const seen = who(out);
    // (a) red when the worker honours the marker on the channel alone (one process; its pieces of
    //     the declared set sent on this test's channel); (b) prints the relation, the messages, the
    //     line and the counts.
    expect({
      code,
      twoProcesses: seen?.ppid === child.pid,
      messages,
      line: out.split('\n').find((l) => l.startsWith('grandchild: ')),
      fake: shown(out + err),
    }).toEqual({
      code: 0,
      twoProcesses: true,
      messages: 0,
      line: 'grandchild: [REDACTED] end',
      fake: { declared: 0, environment: 0 },
    });
  }, 60_000);

  it('(k2) GROUNDING — a drive that sends no piece of the declared set (no `realm.yaml`) exits within 2 s of its work', async () => {
    const started = start(agentArgs(bareStep('quiet'), bare));
    await started.waitFor(/Run complete/);
    const from = Date.now();
    const ran = await started.done;
    // GROUNDING, not acceptance: every exit of `realm agent` is explicit, so a channel that held the
    // worker's loop (no unref at init) cannot turn this red here. Its acceptance home is Unit 2's
    // `drain` door, which returns from its work. (b) prints the code and whether it ended within
    // 2 s of its last line.
    expect({ code: ran.code, quick: Date.now() - from < 2000 }).toEqual({ code: 0, quick: true });
  }, 60_000);

  it('(r) duplicates: the REALM_NOT_SECRET warning once; the identity notice once', async () => {
    const w = oneStep('dups', 'who');
    const r = spawnSync('sh', ['-c', `"$0" "$@" 2>&1`, process.execPath, ...agentArgs(w)], {
      cwd,
      env: env({ REALM_NOT_SECRET: 'NOPE' }),
      encoding: 'utf8',
      timeout: 60_000,
    });
    // The OS user cannot be read in either process (a preload makes `userInfo` throw), so a
    // process that resolves the identity prints the notice.
    const preload = join(root, 'no-user.mjs');
    writeFileSync(
      preload,
      "import os from 'node:os';\nimport { syncBuiltinESMExports } from 'node:module';\nos.userInfo = () => { throw new Error('no passwd entry'); };\nsyncBuiltinESMExports();\n",
      'utf8',
    );
    const n = spawnSync(
      'sh',
      ['-c', `"$0" "$@" 2>&1`, process.execPath, '--import', preload, ...agentArgs(w)],
      { cwd, env: env(), encoding: 'utf8', timeout: 60_000 },
    );
    const count = (text: string, needle: string) => text.split(needle).length - 1;
    // (a) red when the worker prints F32 too, or the relay resolves the identity (twice each);
    //     (b) prints the codes and the counts.
    expect({
      codes: [r.status, n.status],
      notSecret: count(r.stdout, 'REALM_NOT_SECRET lists'),
      identity: count(n.stdout, "this program's name cannot be recorded"),
    }).toEqual({ codes: [0, 0], notSecret: 1, identity: 1 });
  }, 60_000);

  it('(s) Ctrl-Z stops the worker, `fg` resumes both; the relay’s own stop signal reads SIGTSTP', () => {
    const go = join(root, 'go');
    const r = spawnSync(
      'python3',
      [stopRun, go, process.execPath, ...agentArgs(oneStep('stop', 'go'))],
      { cwd, env: env({ U1B_GO: go }), encoding: 'utf8', timeout: 60_000 },
    );
    const seen = JSON.parse(r.stdout) as Record<string, unknown>;
    // (a) red under a self-SIGSTOP (the stop signal reads SIGSTOP); red under a forwarded SIGTSTP
    //     (the worker, in its own session, never stops: state S); (b) prints what the spawner saw,
    //     the drive's output cut to its end line.
    expect({
      stopped: seen['stopped'],
      stopSignal: seen['stopSignal'],
      workerWhileStopped: seen['workerWhileStopped'],
      workerAfterCont: seen['workerAfterCont'],
      code: seen['code'],
      completed: String(seen['out']).includes('Run complete'),
    }).toEqual({
      stopped: true,
      stopSignal: 'SIGTSTP',
      workerWhileStopped: 'T',
      workerAfterCont: 'S',
      code: 0,
      completed: true,
    });
  }, 60_000);
});

describe('U1b — the crown: `realm listen` with its output a file', () => {
  it("(j) listen's log a file (bradley-max's launchd layout) → the agent it spawns relays itself; a grandchild's declared fake is [REDACTED]", async () => {
    const dir = join(root, 'crown');
    mkdirSync(join(dir, 'wf'), { recursive: true });
    for (const file of ['realm.yaml', '.env', 'handlers.mjs', 'package.json']) {
      writeFileSync(join(dir, file), readFileSync(join(project, file)));
    }
    writeFileSync(
      join(dir, 'wf', 'workflow.yaml'),
      [
        'id: u1b-crown',
        'name: u1b crown',
        'version: 1',
        'trigger:',
        '  type: webhook',
        '  path: /hook-u1b',
        '  auth:',
        '    mode: none',
        'steps:',
        '  s:',
        '    description: A grandchild prints.',
        '    execution: auto',
        '    handler: grand',
        '',
      ].join('\n'),
      'utf8',
    );
    const isolated = await makeTempHome();
    onTestFinished(() => isolated.cleanup());
    const log = join(root, 'listen.log');
    const fd = openSync(log, 'w');
    const listen = spawn(
      process.execPath,
      [CLI, 'listen', 'wf', '--model', 'fake-model', '--provider', 'anthropic', '--port', '0'],
      { cwd: dir, env: { ...env(), HOME: isolated.root }, stdio: ['ignore', fd, fd] },
    );
    closeSync(fd);
    onTestFinished(() => {
      if (listen.exitCode === null && listen.signalCode === null) listen.kill('SIGKILL');
    });
    const by = Date.now() + 20_000;
    let port: number | undefined;
    while (port === undefined && Date.now() < by) {
      const m = /realm listen on 127\.0\.0\.1:(\d+) /.exec(readFileSync(log, 'utf8'));
      if (m !== null) port = Number(m[1]);
      else await new Promise((r) => setTimeout(r, 50));
    }
    const answer = await fetch(`http://127.0.0.1:${String(port)}/hook-u1b`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const drove = Date.now() + 30_000;
    while (!readFileSync(log, 'utf8').includes('Run complete') && Date.now() < drove) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const text = readFileSync(log, 'utf8');
    // (a) red on the base (the grandchild's bytes land in listen's file whole); red when the agent
    //     a file-backed listen spawns does not relay (both its streams files, not terminals); (b)
    //     prints the answer's status, the line and the counts.
    expect({
      accepted: answer.status,
      line: text.split('\n').find((l) => l.startsWith('grandchild: ')),
      fake: shown(text),
    }).toEqual({
      accepted: 202,
      line: 'grandchild: [REDACTED] end',
      fake: { declared: 0, environment: 0 },
    });
  }, 90_000);
});

describe('U1b — the harness', () => {
  it('(t-ii) the drift detector: a piped child’s stdout handle has `setBlocking` on this Node', () => {
    const r = spawnSync(
      process.execPath,
      ['-e', 'process.stdout.write(typeof process.stdout._handle.setBlocking)'],
      { encoding: 'utf8', timeout: 30_000 },
    );
    // (a) red on a Node whose pipe handle drops the internal call (the relay then refuses every
    //     piped drive); (b) prints the type seen and the Node version.
    expect({ type: r.stdout, node: process.version.startsWith('v') }).toEqual({
      type: 'function',
      node: true,
    });
  }, 30_000);

  it('(u2) `realm run drain` with an unusable REALM_OPERATOR (the shared identity exit, no relay) → one line, exit 1, no throw', () => {
    const r = spawnSync(process.execPath, [CLI, 'run', 'drain', '--all'], {
      cwd,
      env: env({ REALM_OPERATOR: 'bad\u0007name' }),
      encoding: 'utf8',
      timeout: 30_000,
    });
    const lines = r.stderr.split('\n').filter((l) => l !== '');
    // (a) red when the identity exit throws outside a relay's worker (a stack) or sends an end
    //     message there; (b) prints the code and the line count.
    expect({
      code: r.status,
      lines: lines.length,
      refusal: /REALM_OPERATOR/.test(lines[0] ?? ''),
      stack: /\n\s+at /.test(r.stderr),
    }).toEqual({ code: 1, lines: 1, refusal: true, stack: false });
  }, 30_000);

  it('(i) `realm mcp` does not relay: its stdout is the channel, one process', async () => {
    const child = spawn(process.execPath, [CLI, 'mcp'], {
      cwd,
      env: env(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    onTestFinished(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    });
    let out = '';
    child.stdout!.on('data', (d: Buffer) => (out += d.toString()));
    child.stdin!.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'u1b', version: '1' },
        },
      }) + '\n',
    );
    const by = Date.now() + 20_000;
    while (!out.includes('"id":1') && Date.now() < by) await new Promise((r) => setTimeout(r, 20));
    const children = spawnSync('pgrep', ['-P', String(child.pid)], { encoding: 'utf8' })
      .stdout.split('\n')
      .filter((l) => l !== '').length;
    // (a) red when `realm mcp` re-spawns itself (a child process; its channel relayed); (b) prints
    //     whether it answered and its child count.
    expect({ answered: out.includes('"id":1'), children }).toEqual({ answered: true, children: 0 });
  }, 30_000);
});

// ─── Correction 1 ─────────────────────────────────────────────────────────────────────────────────

/** The fake a project module's top-level code puts into the environment (never in the command's). */
const LOADED_FAKE = 'CANARY-u1b-loaded-9f2b-xxxxxxxxxx';
/** The fake a module sets beside a REALM_NOT_SECRET entry naming it: shown whole, as on the base. */
const PUBLIC_FAKE = 'CANARY-u1b-public-3c9d-xxxxxxxxxx';
/** The fake the command lists in REALM_NOT_SECRET, which a module then removes. */
const LISTED_FAKE = 'CANARY-u1b-listed-6e4a-xxxxxxxxxx';
/** The fake a handler first sets inside `execute()`. */
const LATE_FAKE = 'CANARY-u1b-late-2b7f-xxxxxxxxxxxx';
const loadedShown = (text: string): Record<string, number> => ({
  loaded: text.split(LOADED_FAKE).length - 1,
  public: text.split(PUBLIC_FAKE).length - 1,
  listed: text.split(LISTED_FAKE).length - 1,
  late: text.split(LATE_FAKE).length - 1,
});

/** The `use:` module: its top-level code changes the environment as the command's flags say. */
const LOADED_MODULE = `import { spawn } from 'node:child_process';
if (process.env.U1B_SET_LOADED === '1') process.env.U1B_LOADED = '${LOADED_FAKE}';
if (process.env.U1B_ADD_PUBLIC === '1') {
  process.env.REALM_NOT_SECRET = process.env.REALM_NOT_SECRET + ',U1B_PUBLIC';
  process.env.U1B_PUBLIC = '${PUBLIC_FAKE}';
}
if (process.env.U1B_DROP_NOT_SECRET === '1') delete process.env.REALM_NOT_SECRET;
if (process.env.U1B_MOVE_TO !== undefined) process.chdir(process.env.U1B_MOVE_TO);
const say = (line) => process.stdout.write(line + '\\n');
const step = (id, execute) => ({ id, execute });
const printing = (label, name) => ({ id }) => step(id, async () => {
  say(label + ': ' + process.env[name] + ' end');
  return { data: { note: label } };
});
export const makeLoaded = printing('loaded', 'U1B_LOADED');
export const makePublic = printing('public', 'U1B_PUBLIC');
export const makeListed = printing('listed', 'U1B_LISTED');
export const makeOldCwd = printing('old cwd', 'U1B_OLD_CWD');
export const makeLate = ({ id }) => step(id, async () => {
  process.env.U1B_LATE = '${LATE_FAKE}';
  say('late: ' + process.env.U1B_LATE + ' end');
  return { data: { note: 'late' } };
});
export const makeHoldWait = ({ id }) => step(id, async () => {
  const sleeper = spawn('sleep', ['30'], { stdio: 'inherit' });
  say('ready: pid=' + process.pid + ' sleep=' + sleeper.pid);
  await new Promise(() => {});
});
export const makeTrapWait = ({ id }) => step(id, async () => {
  process.on('SIGTERM', () => say('trapped SIGTERM'));
  say('ready: pid=' + process.pid);
  await new Promise(() => {});
});
export const makeHoldEnd = ({ id }) => step(id, async () => {
  const sleeper = spawn('sleep', ['30'], { stdio: 'inherit' });
  say('held: sleep=' + sleeper.pid);
  return { data: { note: 'held' } };
});
`;

describe('U1b correction 1 — what a project module puts into the environment while it loads', () => {
  let loaded: string;
  let loadedExt: string;
  let elsewhere: string;
  const LOADED_HANDLERS: Record<string, string> = {
    loaded: 'makeLoaded',
    public_value: 'makePublic',
    listed: 'makeListed',
    old_cwd: 'makeOldCwd',
    late: 'makeLate',
    hold_wait: 'makeHoldWait',
    trap_wait: 'makeTrapWait',
    hold_end: 'makeHoldEnd',
  };

  beforeAll(() => {
    loaded = join(root, 'loaded');
    mkdirSync(loaded);
    writeFileSync(
      join(loaded, 'realm.yaml'),
      [
        'version: 1',
        'handlers:',
        ...Object.entries(LOADED_HANDLERS).flatMap(([name, factory]) => [
          `  ${name}:`,
          `    use: ./loaded.mjs#${factory}`,
        ]),
        '',
      ].join('\n'),
      'utf8',
    );
    writeFileSync(join(loaded, 'loaded.mjs'), LOADED_MODULE, 'utf8');
    writeFileSync(join(loaded, 'package.json'), '{ "type": "module" }\n', 'utf8');
    // A project with no `realm.yaml`: its workflow's `extensions:` module sets the value at its top.
    loadedExt = join(root, 'loaded-ext');
    mkdirSync(loadedExt);
    writeFileSync(join(loadedExt, 'package.json'), '{ "type": "module" }\n', 'utf8');
    writeFileSync(
      join(loadedExt, 'ext-env.mjs'),
      `process.env.U1B_LOADED = '${LOADED_FAKE}';
export default { handlers: { ext_loaded: { id: 'ext_loaded', execute: async () => {
  process.stdout.write('ext loaded: ' + process.env.U1B_LOADED + ' end\\n');
  return { data: { note: 'ext loaded' } };
} } } };
`,
      'utf8',
    );
    elsewhere = join(root, 'elsewhere');
    mkdirSync(elsewhere);
  });

  const oneStepIn = (dir: string, name: string, handler: string, head: string[] = []): string =>
    wf(
      dir,
      name,
      ['  s:', '    description: One step.', '    execution: auto', `    handler: ${handler}`],
      head,
    );
  const loadedStep = (name: string, handler: string): string => oneStepIn(loaded, name, handler);
  /** `realm agent … > file 2>&1`: both streams one file; the code and the file's text. */
  const toFile = (args: string[], extra: Record<string, string>, label: string) => {
    const log = join(root, `${label}.log`);
    const fd = openSync(log, 'w');
    let code: number | null;
    try {
      code = spawnSync(process.execPath, args, {
        cwd,
        env: env(extra),
        stdio: ['ignore', fd, fd],
        timeout: 60_000,
      }).status;
    } finally {
      closeSync(fd);
    }
    return { code, text: readFileSync(log, 'utf8') };
  };
  const lineOf = (text: string, start: string): string | undefined =>
    text.split('\n').find((l) => l.startsWith(start));
  const environmentHidden = (text: string): (string | undefined)[] =>
    disclosureLines(text).map((l) => /(\d+) environment,/.exec(l)?.[1]);

  it("(x1) a `use:` module's top-level code sets an environment value the handler prints, `> file 2>&1` → [REDACTED]; the receipt counts it environment", () => {
    const w = loadedStep('x1', 'loaded');
    const plain = toFile(agentArgs(w, loaded), { U1B_SET_LOADED: '1' }, 'x1-plain');
    const logged = toFile(
      agentArgs(w, loaded, ['--log-mode']),
      { U1B_SET_LOADED: '1' },
      'x1-logged',
    );
    // (a) red on 9cc4239c and without the piece after the `use:` loop (the relay sweeps its own
    //     environment only: the fake whole, the count 0); green on the base 59778b53 (one process
    //     reads its live environment); (b) prints the codes, the lines, the counts and the receipt's.
    expect({
      codes: [plain.code, logged.code],
      lines: [lineOf(plain.text, 'loaded: '), lineOf(logged.text, 'loaded: ')],
      fake: loadedShown(plain.text + logged.text),
      environment: environmentHidden(logged.text),
    }).toEqual({
      codes: [0, 0],
      lines: ['loaded: [REDACTED] end', 'loaded: [REDACTED] end'],
      fake: { loaded: 0, public: 0, listed: 0, late: 0 },
      environment: ['1'],
    });
  }, 90_000);

  it("(x1b) a module's top-level code moves the working folder → a variable naming the old folder is [REDACTED], as the base hides it", async () => {
    const ran = await run(agentArgs(loadedStep('x1b', 'old_cwd'), loaded), {
      env: env({ U1B_MOVE_TO: elsewhere, U1B_OLD_CWD: cwd }),
    });
    // (a) red without the working folder in the piece (the relay still reads its own folder, so
    //     the old folder is the working directory and prints whole); (b) prints the code and line.
    expect({
      code: ran.code,
      line: lineOf(ran.stdout, 'old cwd: '),
      shownWhole: ran.stdout.includes(`old cwd: ${cwd} end`),
    }).toEqual({ code: 0, line: 'old cwd: [REDACTED] end', shownWhole: false });
  }, 60_000);

  it("(x2) the same value set by an `extensions:` module's top-level code → [REDACTED]", async () => {
    const w = oneStepIn(loadedExt, 'x2', 'ext_loaded', ['extensions: ../ext-env.mjs']);
    const ran = await run(agentArgs(w, loadedExt, ['--log-mode']));
    // (a) red without the piece after the `extensions:` loop (no manifest here, so no later piece
    //     carries it); (b) prints the code, the line, the counts and the receipt's.
    expect({
      code: ran.code,
      line: lineOf(ran.stdout, 'ext loaded: '),
      fake: loadedShown(ran.stdout + ran.stderr),
      environment: environmentHidden(ran.stderr),
    }).toEqual({
      code: 0,
      line: 'ext loaded: [REDACTED] end',
      fake: { loaded: 0, public: 0, listed: 0, late: 0 },
      environment: ['1'],
    });
  }, 60_000);

  it("(x3) a module's top-level code adds a name to REALM_NOT_SECRET and sets it → shown whole, not counted, as the worker's own writer would", async () => {
    const ran = await run(agentArgs(loadedStep('x3', 'public_value'), loaded, ['--log-mode']), {
      env: env({ U1B_ADD_PUBLIC: '1' }),
    });
    // (a) red when the relay reads REALM_NOT_SECRET from its own environment only (the value
    //     [REDACTED], counted 1); (b) prints the code, the line and the receipt's count.
    expect({
      code: ran.code,
      line: ran.stdout.includes(`public: ${PUBLIC_FAKE} end`)
        ? 'whole'
        : lineOf(ran.stdout, 'public: '),
      environment: environmentHidden(ran.stderr),
    }).toEqual({ code: 0, line: 'whole', environment: ['0'] });
  }, 60_000);

  it("(x3b) a module's top-level code removes REALM_NOT_SECRET → a value it listed is [REDACTED], as the base hides it", async () => {
    const ran = await run(agentArgs(loadedStep('x3b', 'listed'), loaded), {
      env: env({
        U1B_DROP_NOT_SECRET: '1',
        REALM_NOT_SECRET: 'HOME,U1B_LISTED',
        U1B_LISTED: LISTED_FAKE,
      }),
    });
    // (a) red without the removed names in the piece (the relay still reads its own
    //     REALM_NOT_SECRET, which lists the value's name); (b) prints the code, the line, counts.
    expect({
      code: ran.code,
      line: lineOf(ran.stdout, 'listed: '),
      fake: loadedShown(ran.stdout + ran.stderr),
    }).toEqual({
      code: 0,
      line: 'listed: [REDACTED] end',
      fake: { loaded: 0, public: 0, listed: 0, late: 0 },
    });
  }, 60_000);

  it('(x4) GROUNDING — a value first set inside `execute()` prints whole, on the base and on this build (today’s limit)', async () => {
    const ran = await run(agentArgs(loadedStep('x4', 'late'), loaded));
    // GROUNDING, not acceptance: neither build rebuilds its set for a change made inside a
    // handler's `execute()`; this pins that limit. (b) prints the code and whether it was whole.
    expect({ code: ran.code, whole: ran.stdout.includes(`late: ${LATE_FAKE} end`) }).toEqual({
      code: 0,
      whole: true,
    });
  }, 60_000);

  it("(x6) `kill -9 <relay>` while a handler's program (`sleep 30`, inherited stdio) runs → the worker and the program are gone within 5 s", async () => {
    const started = start(agentArgs(loadedStep('x6', 'hold_wait'), loaded));
    const m = await started.waitFor(/ready: pid=(\d+) sleep=(\d+)/);
    const worker = Number(m[1]);
    const sleeper = Number(m[2]);
    // A worker or a program that outlives its relay (the cell's red) is not left behind.
    onTestFinished(() => {
      for (const pid of [worker, sleeper]) if (alive(pid)) process.kill(pid, 'SIGKILL');
    });
    started.child.kill('SIGKILL');
    const by = Date.now() + 5000;
    while ((alive(worker) || alive(sleeper)) && Date.now() < by) {
      await new Promise((r) => setTimeout(r, 10));
    }
    // (a) red when the worker ends only itself on its channel's close (the program lives on, an
    //     orphan); (b) prints which of the two is gone.
    expect({ worker: !alive(worker), program: !alive(sleeper) }).toEqual({
      worker: true,
      program: true,
    });
  }, 60_000);

  it('(x7) a handler that traps SIGTERM and keeps working: `kill <first process>` once → both processes gone at about 10 s, the first by SIGKILL', async () => {
    const started = start(agentArgs(loadedStep('x7', 'trap_wait'), loaded));
    const worker = Number((await started.waitFor(/ready: pid=(\d+)/))[1]);
    // A worker that outlives the bound (the cell's red) is not left behind.
    onTestFinished(() => {
      if (alive(worker)) process.kill(worker, 'SIGKILL');
    });
    const from = Date.now();
    started.child.kill('SIGTERM');
    await started.waitFor(/trapped SIGTERM/);
    await new Promise((r) => setTimeout(r, 2000));
    const livedPastTerm = alive(worker);
    while (alive(worker) && Date.now() - from < 13_000) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const workerGoneAt = alive(worker) ? undefined : Date.now() - from;
    if (workerGoneAt === undefined) started.child.kill('SIGKILL');
    const ran = await started.done;
    const relayGoneAt = Date.now() - from;
    const atTheBound = (ms: number | undefined): boolean =>
      ms !== undefined && ms >= 9_500 && ms < 11_500;
    // (a) red without the 10 s backstop after the first signal (the worker lives on past 13 s); red
    //     when the trap does not hold (the cell would prove nothing: the worker gone at once); (b)
    //     prints whether the trap held, when each process was gone, and the first's signal.
    expect(
      {
        trapped: livedPastTerm,
        worker: atTheBound(workerGoneAt),
        relay: atTheBound(relayGoneAt),
        signal: ran.signal,
      },
      `worker gone at ${String(workerGoneAt)} ms, relay at ${relayGoneAt} ms`,
    ).toEqual({ trapped: true, worker: true, relay: true, signal: 'SIGKILL' });
  }, 60_000);

  it('(x8) a handler leaves `sleep 30` holding the output → at the bound the drain line, and once the command returns the program is gone', async () => {
    const started = start(agentArgs(loadedStep('x8', 'hold_end'), loaded));
    const sleeper = Number((await started.waitFor(/held: sleep=(\d+)/))[1]);
    // A program that outlives the command (the cell's red) is not left behind.
    onTestFinished(() => {
      if (alive(sleeper)) process.kill(sleeper, 'SIGKILL');
    });
    const ran = await started.done;
    const goneIn = await waitDead(sleeper, 1000);
    // (a) red without the group kill at the bound (the program holds the output for its 30 s); (b)
    //     prints the code, how many drain lines and whether the program was gone.
    expect({
      code: ran.code,
      drainLines: ran.stderr.split('\n').filter((l) => l === DRAIN_LINE).length,
      programGone: goneIn !== undefined,
    }).toEqual({ code: 0, drainLines: 1, programGone: true });
  }, 60_000);
});
