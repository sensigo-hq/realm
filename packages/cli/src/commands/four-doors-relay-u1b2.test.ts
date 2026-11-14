// four-doors-relay-u1b2.test.ts — U1b Unit 2: `realm run drain`, `realm run advance`, `realm run
// respond` and `realm workflow run` relay as `realm agent` does since Unit 1 when their output goes to
// a file or a pipe: the first process masks what reaches the file or pipe, a program a handler
// starts included; on a terminal each runs in-process as before. Each cell drives the BUILT CLI with
// real files, pipes or a pseudo-terminal; the handlers are the project's own (`handlers.mjs`), the
// declared fake comes from the project's `.env`, which sits OFF the command's cwd (`--project`
// elsewhere), so only the manifest's resolution can hide it. `workflow run`'s cells give the command
// a pseudo-terminal on STDIN (Unit 1's runner gives `/dev/null` there): `TALK_RUN` below types the
// answers and sends Ctrl-Z the way a shell's terminal does. Every assertion names (a) the break that
// turns it red and (b) what it prints when it fails: counts, kinds, codes, process states — never a
// fake value.
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
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  executeStep,
  type RunStore,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { makeTempHome, type TempHome } from '../test-support/temp-home.js';

// The words an operator reads, as written (Unit 1's constants; the docs quote them).
const DRAIN_LINE =
  "A program started by a handler kept the output open after the command's work ended; it has been stopped, and what it printed after that is not in this log.";
const AGENT_SPAWN_FAILED =
  'Error: realm agent could not start the process that runs its drive (EAGAIN). Nothing was started.';
const AGENT_NOT_BLOCKING =
  'Error: realm agent cannot hide what its programs print here: this Node.js cannot make the output pipe blocking. Nothing was started.';

const CLI = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const CLI_PACKAGE = fileURLToPath(new URL('../../package.json', import.meta.url));
const RELAY_JS = pathToFileURL(
  fileURLToPath(new URL('../../dist/output/relay.js', import.meta.url)),
).href;
const WRITER_JS = pathToFileURL(
  fileURLToPath(new URL('../../dist/output/writer.js', import.meta.url)),
).href;
/** The declared fake: in the project's `.env` only. */
const DECLARED = 'CANARY-u1b2-declared-4e9b-xxxxxxx';
/** How many times the fake shows in `text` — what a failing cell prints instead of the text. */
const shown = (text: string): number => text.split(DECLARED).length - 1;
const disclosureLines = (text: string): number =>
  text.split('\n').filter((l) => l.startsWith('Disclosure:')).length;

const HANDLERS = `import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (id, execute) => ({ id, execute });
export const makeGrand = ({ id, config }) => step(id, async () => {
  spawnSync('sh', ['-c', 'echo "grandchild: $0 end"', config.token], { stdio: 'inherit' });
  return { data: { note: 'a grandchild printed' } };
});
export const makeHold = ({ id }) => step(id, async () => {
  const sleeper = spawn('sleep', ['30'], { stdio: 'inherit' });
  sleeper.unref();
  process.stdout.write('held: sleep=' + sleeper.pid + '\\n');
  return { data: { note: 'held, released' } };
});
export const makeKeep = ({ id }) => step(id, async () => {
  spawn('sh', ['-c', 'sleep 8; echo "late: kept end"'], { stdio: 'inherit' });
  process.stdout.write('kept\\n');
  return { data: { note: 'kept' } };
});
export const makeWho = ({ id }) => step(id, async () => {
  process.stdout.write(\`who: pid=\${process.pid} ppid=\${process.ppid} markers=\${typeof process.env.REALM_RELAY_CHILD},\${typeof process.env.REALM_RELAY_KEY}\\n\`);
  return { data: { note: 'who' } };
});
export const makeQuiet = ({ id }) => step(id, async () => ({ data: { note: 'quiet' } }));
export const makeSlow = ({ id }) => step(id, async () => {
  process.stderr.write('slow: running\\n');
  while (!existsSync(process.env.U1B2_GO)) await sleep(50);
  return { data: { note: 'went on' } };
});
`;
const HANDLER_NAMES: Record<string, string> = {
  grand: 'makeGrand',
  hold: 'makeHold',
  keep: 'makeKeep',
  who: 'makeWho',
  quiet: 'makeQuiet',
  slow: 'makeSlow',
};

/** A pseudo-terminal runner (Unit 1's): `mode` names the streams on the terminal (`out`, `err`,
 *  `both`); the other stream is a pipe; stdin `/dev/null`. Prints `{ pid, code, tty, pipe }`. */
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

/**
 * The new harness (U1b Unit 2): a pseudo-terminal on STDIN. The command runs in a process group of
 * its own in this script's session (never orphaned, so a stop signal stops it, as under a shell).
 * `mode`: `log` — stdout a file, stdin and stderr the terminal; `tty` — all three the terminal;
 * `errlog` — stdout and stderr the file. The script's steps: `expect` (a literal text seen `nth`
 * times on the terminal, within a time), `send` (bytes typed; `\\x1a` is Ctrl-Z), `stopped` (the
 * command's stop read with waitpid(WUNTRACED), its signal), `state` (the `/proc` state of the first
 * process and of its child, the worker), `fg` (SIGCONT to the command's group, as a shell's `fg`),
 * `kill`, `touch`, `sleep`, `worker`. Prints what it saw as JSON; a command still running after
 * `exitTimeout` is killed and reported `timedOut`.
 */
const TALK_RUN = `import json, os, pty, select, signal, sys, time
cfg = json.loads(open(sys.argv[1]).read())
mode, cmd = cfg['mode'], cfg['cmd']
master, slave = pty.openpty()
pid = os.fork()
if pid == 0:
    os.setpgid(0, 0)
    os.dup2(slave, 0)
    if mode == 'tty':
        os.dup2(slave, 1); os.dup2(slave, 2)
    else:
        f = os.open(cfg['log'], os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        os.dup2(f, 1); os.dup2(f if mode == 'errlog' else slave, 2); os.close(f)
    os.close(master); os.close(slave)
    os.execvp(cmd[0], cmd)
os.close(slave)
buf = b''
eof = False
def pump(timeout):
    global buf, eof
    if eof:
        time.sleep(timeout); return
    r, _, _ = select.select([master], [], [], timeout)
    if r:
        try: d = os.read(master, 65536)
        except OSError: d = b''
        if d: buf += d
        else: eof = True
def state(p):
    try: return open('/proc/%d/stat' % p).read().rsplit(') ', 1)[1].split(' ', 1)[0]
    except OSError: return None
def worker():
    try: kids = open('/proc/%d/task/%d/children' % (pid, pid)).read().split()
    except OSError: return None
    return int(kids[0]) if kids else None
events = {}
exited = None
seen_worker = None
for step in cfg['script']:
    op = step[0]
    if op == 'expect':
        _, name, text, nth, timeout = step
        end = time.time() + timeout
        ok = False
        while time.time() < end:
            if buf.count(text.encode()) >= nth: ok = True; break
            pump(0.05)
        events[name] = ok
    elif op == 'send': os.write(master, step[1].encode())
    elif op == 'sleep':
        end = time.time() + step[1]
        while time.time() < end: pump(0.05)
    elif op == 'state':
        w = worker() or seen_worker
        events[step[1]] = {'first': state(pid), 'worker': state(w) if w else None}
    elif op == 'stopped':
        _, name, timeout = step
        end = time.time() + timeout; got = None
        while time.time() < end:
            w, st = os.waitpid(pid, os.WNOHANG | os.WUNTRACED)
            if w == pid:
                if os.WIFSTOPPED(st): got = signal.Signals(os.WSTOPSIG(st)).name
                else: exited = st
                break
            pump(0.05)
        events[name] = got
    elif op == 'fg': os.killpg(pid, signal.SIGCONT)
    elif op == 'kill': os.kill(pid, getattr(signal, step[1]))
    elif op == 'worker':
        seen_worker = worker()
        events[step[1]] = seen_worker
    elif op == 'touch': open(step[1], 'w').close()
end = time.time() + cfg.get('exitTimeout', 30)
while exited is None and time.time() < end:
    pump(0.05)
    w, st = os.waitpid(pid, os.WNOHANG)
    if w == pid: exited = st
timed_out = exited is None
if timed_out:
    for g in (pid, worker(), seen_worker):
        if g:
            try: os.killpg(g, signal.SIGKILL)
            except OSError: pass
    _, exited = os.waitpid(pid, 0)
pump(0.2)
gone = None
if seen_worker:
    end = time.time() + 2
    while state(seen_worker) not in (None, 'Z') and time.time() < end: time.sleep(0.02)
    gone = state(seen_worker) in (None, 'Z')
code = os.WEXITSTATUS(exited) if os.WIFEXITED(exited) else None
sig = signal.Signals(os.WTERMSIG(exited)).name if os.WIFSIGNALED(exited) else None
print(json.dumps({'pid': pid, 'events': events, 'timedOut': timed_out, 'code': code, 'signal': sig, 'workerGone': gone, 'tty': buf.decode('utf-8', 'replace').replace('\\r', '')}))
`;

let root: string;
let project: string;
let cwd: string;
let home: TempHome & { readonly root: string };
let ptyRun: string;
let talkRun: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'realm-u1b2-'));
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
        "      token: '${secret:U1B2_TOKEN}'",
      ]),
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(join(project, '.env'), `U1B2_TOKEN=${DECLARED}\n`, 'utf8');
  writeFileSync(join(project, 'handlers.mjs'), HANDLERS, 'utf8');
  writeFileSync(join(project, 'package.json'), '{ "type": "module" }\n', 'utf8');
  ptyRun = join(root, 'pty_run.py');
  writeFileSync(ptyRun, PTY_RUN, 'utf8');
  talkRun = join(root, 'talk_run.py');
  writeFileSync(talkRun, TALK_RUN, 'utf8');
}, 60_000);

afterAll(async () => {
  await home.cleanup();
  rmSync(root, { recursive: true, force: true });
});

/** The command's environment: a fresh HOME (listed as not secret, so paths print whole). */
const env = (extra: Record<string, string> = {}): Record<string, string> => ({
  PATH: process.env['PATH'] ?? '',
  HOME: home.root,
  NO_COLOR: '1',
  REALM_NOT_SECRET: 'HOME',
  ...extra,
});

let defs = 0;
/** A workflow registered in the home: `steps` as given, its id unique to the cell. */
async function register(
  steps: WorkflowDefinition['steps'],
  store = home.home,
): Promise<WorkflowDefinition> {
  defs += 1;
  const def: WorkflowDefinition = {
    id: `u1b2-${defs}`,
    name: `u1b2 ${defs}`,
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps,
  };
  await store.workflowStore.register(def);
  return def;
}
/** A completed run whose cleanup step `fin` (handler `handler`) is owed: what `drain` runs. */
async function owingCleanup(handler: string, store = home.home): Promise<string> {
  const def = await register(
    {
      work: { description: 'Work.', execution: 'agent', depends_on: [] },
      fin: { description: 'Tidy.', execution: 'finalizer', on_outcome: 'always', handler },
    },
    store,
  );
  const runs: RunStore = store.runStore;
  const { record: run } = await runs.create({ workflowId: def.id, workflowVersion: 1, params: {} });
  await runs.update({
    ...run,
    run_phase: 'completed',
    terminal_state: true,
    sealed_by: { arm: 'complete' },
    terminal_reason: 'Workflow completed.',
    finalizer_ledger: { fin: { status: 'pending', rank: 0 } },
  });
  return run.id;
}
/** A workflow file `name` under the project, for `realm workflow run`. */
const wfFile = (name: string, lines: string[]): string => {
  const at = join(project, `wf-${name}`);
  mkdirSync(at, { recursive: true });
  writeFileSync(
    join(at, 'workflow.yaml'),
    [`id: u1b2-file-${name}`, `name: u1b2 ${name}`, 'version: 1', 'steps:', ...lines, ''].join(
      '\n',
    ),
    'utf8',
  );
  return at;
};
const autoStep = (name: string, handler: string, after?: string): string[] => [
  `  ${name}:`,
  `    description: Step ${name}.`,
  '    execution: auto',
  `    handler: ${handler}`,
  ...(after !== undefined ? [`    depends_on: [${after}]`] : []),
];
const agentStep = (name: string, after?: string): string[] => [
  `  ${name}:`,
  `    description: Step ${name}.`,
  '    execution: agent',
  ...(after !== undefined ? [`    depends_on: [${after}]`] : []),
];
const runArgs = (wf: string): string[] => [CLI, 'workflow', 'run', wf, '--project', project];

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
  /** Resolves when `re` matches stdout or stderr (within `ms`), with the time it was seen. */
  waitFor(re: RegExp, ms?: number): Promise<number>;
  done: Promise<Ran & { closedAt: number }>;
}
/** Starts `node <args>` with piped stdout and stderr; killed after the cell. */
function start(args: string[], extraEnv: Record<string, string> = {}): Started {
  const child = spawn(process.execPath, args, {
    cwd,
    env: env(extraEnv),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  onTestFinished(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });
  let out = '';
  let err = '';
  child.stdout!.on('data', (d: Buffer) => (out += d.toString()));
  child.stderr!.on('data', (d: Buffer) => (err += d.toString()));
  const done = new Promise<Ran & { closedAt: number }>((resolve) =>
    child.once('close', (code, signal) =>
      resolve({ code, signal, stdout: out, stderr: err, pid: child.pid!, closedAt: Date.now() }),
    ),
  );
  const waitFor = async (re: RegExp, ms = 20_000): Promise<number> => {
    const by = Date.now() + ms;
    for (;;) {
      if (re.test(out) || re.test(err)) return Date.now();
      if (Date.now() > by) throw new Error(`no ${String(re)} within ${ms} ms`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  return { child, out: () => out, err: () => err, waitFor, done };
}
/** Runs `node <args>` with stdout and stderr both to one file (`> file 2>&1`); the file's text. */
async function toFile(args: string[]): Promise<{ code: number | null; text: string }> {
  const file = join(root, `log-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  const fd = openSync(file, 'w');
  const child = spawn(process.execPath, args, { cwd, env: env(), stdio: ['ignore', fd, fd] });
  closeSync(fd);
  onTestFinished(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });
  const code = await new Promise<number | null>((resolve) => child.once('close', resolve));
  return { code, text: readFileSync(file, 'utf8') };
}
interface Talk {
  pid: number;
  events: Record<string, unknown>;
  timedOut: boolean;
  code: number | null;
  signal: string | null;
  workerGone: boolean | null;
  tty: string;
  log: string;
}
/** Runs `node <args>` under {@link TALK_RUN}. */
function talk(
  mode: 'log' | 'tty' | 'errlog',
  args: string[],
  script: unknown[][],
  options: { exitTimeout?: number; env?: Record<string, string> } = {},
): Talk {
  const log = join(root, `talk-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  const config = join(root, `talk-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(
    config,
    JSON.stringify({
      mode,
      log,
      cmd: [process.execPath, ...args],
      script,
      exitTimeout: options.exitTimeout ?? 30,
    }),
    'utf8',
  );
  const r = spawnSync('python3', [talkRun, config], {
    cwd,
    env: env(options.env),
    encoding: 'utf8',
    timeout: 120_000,
  });
  // The runner's own failure (never the command's) is a fixture error, with its last lines.
  if (r.status !== 0) throw new Error(`fixture: the runner failed: ${r.stderr.slice(-600)}`);
  const parsed = JSON.parse(r.stdout) as Omit<Talk, 'log'>;
  let text = '';
  try {
    text = readFileSync(log, 'utf8');
  } catch {
    // `tty` mode writes no file.
  }
  return { ...parsed, log: text };
}
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const waitDead = async (pid: number, ms: number): Promise<boolean> => {
  const from = Date.now();
  while (Date.now() - from < ms) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return !alive(pid);
};
const grandLine = (text: string): string | undefined =>
  text.split('\n').find((l) => l.startsWith('grandchild: '));
/** How many times the prompt `text` was drawn on the terminal. */
const drawn = (tty: string, text: string): number => tty.split(text).length - 1;
const MOCK_PROMPT = 'Mock output (handler: ';
const AGENT_PROMPT = 'Agent output JSON (Enter for {}): ';

describe('U1b Unit 2 — a program a handler starts is masked in a log, at each of the four doors', () => {
  it('(s1) `realm run drain <id> --force > file 2>&1`: a cleanup step’s program prints a DECLARED fake → [REDACTED], no `Disclosure:` line', async () => {
    const id = await owingCleanup('grand');
    const ran = await toFile([CLI, 'run', 'drain', id, '--force', '--project', project]);
    // (a) red on the base (drain runs in-process: the grandchild's bytes land whole, fake 1); red
    //     when the door prints a receipt (D3); (b) prints the code, the line, the counts.
    expect({
      code: ran.code,
      line: grandLine(ran.text),
      fake: shown(ran.text),
      disclosure: disclosureLines(ran.text),
    }).toEqual({ code: 0, line: 'grandchild: [REDACTED] end', fake: 0, disclosure: 0 });
  }, 60_000);

  it('(s2) `realm run advance <id> > file 2>&1`: an owed step’s program prints the fake → [REDACTED], no `Disclosure:` line', async () => {
    const def = await register({
      s: { description: 'S.', execution: 'auto', handler: 'grand', depends_on: [] },
    });
    const { record: run } = await home.home.runStore.create({
      workflowId: def.id,
      workflowVersion: 1,
      params: {},
    });
    const ran = await toFile([CLI, 'run', 'advance', run.id, '--project', project]);
    // (a) red on the base (the fake whole); (b) prints the code, the line, the counts.
    expect({
      code: ran.code,
      line: grandLine(ran.text),
      fake: shown(ran.text),
      disclosure: disclosureLines(ran.text),
    }).toEqual({ code: 0, line: 'grandchild: [REDACTED] end', fake: 0, disclosure: 0 });
  }, 60_000);

  it('(s3) `realm run respond <id> --gate … --choice approve > file 2>&1`: the completing answer’s cleanup step prints the fake → [REDACTED]', async () => {
    const def = await register({
      ask: {
        description: 'Ask.',
        execution: 'auto',
        trust: 'human_confirmed',
        gate: { choices: ['approve', 'reject'] },
        depends_on: [],
      },
      fin: {
        description: 'Tidy.',
        execution: 'finalizer',
        on_outcome: 'complete',
        handler: 'grand',
      },
    } as WorkflowDefinition['steps']);
    const { record: run } = await home.home.runStore.create({
      workflowId: def.id,
      workflowVersion: 1,
      params: {},
    });
    const opened = await executeStep(home.home.runStore, def, {
      runId: run.id,
      command: 'ask',
      input: {},
      dispatcher: async () => ({}),
    });
    expect(opened.status, 'fixture: the question is open').toBe('confirm_required');
    const ran = await toFile([
      CLI,
      'run',
      'respond',
      run.id,
      '--gate',
      opened.gate!.gate_id,
      '--choice',
      'approve',
      '--project',
      project,
    ]);
    // (a) red on the base (the fake whole); (b) prints the code, the line, the counts.
    expect({
      code: ran.code,
      line: grandLine(ran.text),
      fake: shown(ran.text),
      disclosure: disclosureLines(ran.text),
    }).toEqual({ code: 0, line: 'grandchild: [REDACTED] end', fake: 0, disclosure: 0 });
  }, 60_000);

  it('(s4) `realm workflow run` with stdout a file, stdin and stderr a terminal: the prompt reaches the terminal, the typed answer is taken, the step’s program prints the fake → [REDACTED] in the file', () => {
    const wf = wfFile('s4', autoStep('s', 'grand'));
    const r = talk('log', runArgs(wf), [
      ['expect', 'prompt', MOCK_PROMPT, 1, 20],
      ['worker', 'worker'],
      ['send', '\r'],
    ]);
    // (a) red on the base (one process: the grandchild's bytes land whole in the file, fake 1, no
    //     worker); red when the worker cannot read the terminal it does not control (no answer
    //     taken: timed out); (b) prints the code, whether the prompt was drawn on the terminal,
    //     whether a worker ran, the line and the counts.
    expect({
      code: r.code,
      timedOut: r.timedOut,
      promptOnTerminal: r.events['prompt'],
      worker: typeof r.events['worker'] === 'number',
      line: grandLine(r.log),
      completed: r.log.includes('Run complete. Phase: completed'),
      fake: shown(r.log + r.tty),
      disclosure: disclosureLines(r.log),
    }).toEqual({
      code: 0,
      timedOut: false,
      promptOnTerminal: true,
      worker: true,
      line: 'grandchild: [REDACTED] end',
      completed: true,
      fake: 0,
      disclosure: 0,
    });
  }, 60_000);

  it('(h-s) `realm run drain` whose cleanup step starts `sleep 30` and lets it go, holding the output → the command returns about 5 s after its work, the drain line once, the program gone; GROUNDING: a program the step keeps is waited for', async () => {
    const released = start([
      CLI,
      'run',
      'drain',
      await owingCleanup('hold'),
      '--force',
      '--project',
      project,
    ]);
    const workDone = await released.waitFor(/Drained run/, 30_000);
    const ran = await released.done;
    const sleeper = Number(/held: sleep=(\d+)/.exec(ran.stdout)?.[1]);
    onTestFinished(() => {
      if (sleeper > 0 && alive(sleeper)) process.kill(sleeper, 'SIGKILL');
    });
    const after = ran.closedAt - workDone;
    const programGone = await waitDead(sleeper, 1000);
    // GROUNDING (amendment B1): a program the step keeps (its handle held, so the worker waits for
    // it, as today's single process does) is waited for — its late line in the log, no drain line.
    const kept = start([
      CLI,
      'run',
      'drain',
      await owingCleanup('keep'),
      '--force',
      '--project',
      project,
    ]);
    const keptDone = await kept.waitFor(/Drained run/, 30_000);
    const keptRan = await kept.done;
    const keptAfter = keptRan.closedAt - keptDone;
    const drainLines = (text: string) => text.split('\n').filter((l) => l === DRAIN_LINE).length;
    // (a) red without drain's call site (one process: it exits at once, but the released program
    //     keeps the pipes open until it ends, about 30 s, and no drain line is said); (b) prints the
    //     codes, the delay bands, the drain lines' counts, whether the program is gone and whether
    //     the kept program's late line reached the log.
    expect({
      code: ran.code,
      returnedAtTheBound: after > 4000 && after < 7500,
      drainLines: drainLines(ran.stderr),
      programGone,
      kept: {
        code: keptRan.code,
        waitedForIt: keptAfter > 7000 && keptAfter < 12_000,
        drainLines: drainLines(keptRan.stderr),
        lateLine: keptRan.stdout.includes('late: kept end'),
      },
    }).toEqual({
      code: 0,
      returnedAtTheBound: true,
      drainLines: 1,
      programGone: true,
      kept: { code: 0, waitedForIt: true, drainLines: 0, lateLine: true },
    });
  }, 90_000);

  it('(t-s) `realm run drain` with both streams a terminal → one process, today’s bytes', async () => {
    const id = await owingCleanup('who');
    const r = spawnSync(
      'python3',
      [ptyRun, 'both', process.execPath, CLI, 'run', 'drain', id, '--force', '--project', project],
      { cwd, env: env(), encoding: 'utf8', timeout: 60_000 },
    );
    const ran = JSON.parse(r.stdout) as { pid: number; code: number; tty: string };
    const m = /who: pid=(\d+) ppid=(\d+) markers=(\w+),(\w+)/.exec(ran.tty);
    const bytes = ran.tty
      .replaceAll(id, '<run-id>')
      .replace(/who: pid=\d+ ppid=\d+/, 'who: pid=<pid> ppid=<ppid>');
    // (a) red when drain relays on a terminal (an unconditional relay in drain's file: the handler
    //     runs in a worker, its pid not the command's); red when any byte on the terminal changes;
    //     (b) prints the code, whether the handler ran in the command's own process, the markers
    //     and the normalised bytes.
    expect({
      code: ran.code,
      inProcess: m !== null && Number(m[1]) === ran.pid,
      markers: m === null ? undefined : [m[3], m[4]],
      bytes,
    }).toEqual({
      code: 0,
      inProcess: true,
      markers: ['undefined', 'undefined'],
      bytes: "who: pid=<pid> ppid=<ppid> markers=undefined,undefined\nDrained run '<run-id>'.\n",
    });
  }, 60_000);
});

describe('U1b Unit 2 — what the doors keep', () => {
  it('(x1) GROUNDING — `respond --by` and `workflow run`’s stdin refusal with piped output: one line each, exit 1', () => {
    const by = spawnSync(
      process.execPath,
      [CLI, 'run', 'respond', 'some-run', '--gate', 'g', '--choice', 'ok', '--by', '   '],
      { cwd, env: env(), encoding: 'utf8', timeout: 60_000 },
    );
    const wf = wfFile('x1', autoStep('s', 'quiet'));
    const stdin = spawnSync(process.execPath, runArgs(wf), {
      cwd,
      env: env(),
      encoding: 'utf8',
      input: '',
      timeout: 60_000,
    });
    const lines = (text: string, start: string) =>
      text.split('\n').filter((l) => l.startsWith(start)).length;
    // GROUNDING: a refusal exits before any spawn either way (respond's before the relay call;
    // `workflow run`'s in the worker, after one spawn); (b) prints the codes and the counts.
    expect({
      codes: [by.status, stdin.status],
      byLines: lines(by.stderr + by.stdout, '--by: '),
      stdinLines: lines(stdin.stderr + stdin.stdout, 'Error: dev-mode run is interactive'),
    }).toEqual({ codes: [1, 1], byLines: 1, stdinLines: 1 });
  }, 60_000);

  it('(k2-s) GROUNDING — a `drain` that ends by returning exits within 2 s of its last line; one `drain --all --force > log` drains two runs', async () => {
    const id = await owingCleanup('quiet');
    const started = start([CLI, 'run', 'drain', id, '--force', '--project', project]);
    const lastLine = await started.waitFor(/Drained run/, 30_000);
    const ran = await started.done;
    const other = await makeTempHome();
    onTestFinished(() => other.cleanup());
    const ids = [await owingCleanup('quiet', other.home), await owingCleanup('quiet', other.home)];
    const file = join(root, 'drain-all.txt');
    const fd = openSync(file, 'w');
    const all = spawnSync(
      process.execPath,
      [CLI, 'run', 'drain', '--all', '--force', '--project', project],
      { cwd, env: env({ HOME: other.root }), stdio: ['ignore', fd, fd], timeout: 60_000 },
    );
    closeSync(fd);
    const statuses = await Promise.all(
      ids.map(
        async (i) => (await other.home.runStore.get(i)).record.finalizer_ledger?.['fin']?.status,
      ),
    );
    // GROUNDING: Unit 1's channel rule (unref'd at init, held only while an ack is pending) is
    // what ends the worker on a natural return; (b) prints the codes, the delay and the statuses.
    expect({
      code: ran.code,
      withinTwoSeconds: ran.closedAt - lastLine < 2000,
      allCode: all.status,
      statuses,
    }).toEqual({
      code: 0,
      withinTwoSeconds: true,
      allCode: 0,
      statuses: ['completed', 'completed'],
    });
  }, 90_000);

  it('(sig-s) GROUNDING/KEEP — `kill <first pid>` on a piped `workflow run` at an agent step’s prompt → both gone, the claim released, exit 143', async () => {
    const wf = wfFile('sig', agentStep('ask'));
    const r = talk(
      'log',
      runArgs(wf),
      [
        ['expect', 'prompt', AGENT_PROMPT, 1, 20],
        ['worker', 'worker'],
        ['kill', 'SIGTERM'],
      ],
      { exitTimeout: 15 },
    );
    const runId = /Run ID: (\S+)/.exec(r.log)?.[1];
    const record = runId === undefined ? undefined : (await home.home.runStore.get(runId)).record;
    // KEEP: the forward is Unit 1's; this pins the door's wiring — the signal exit goes through
    // `exitProcess` after the claim's release; (b) prints the code, whether both processes are
    // gone, and the step's claim and in-progress mark.
    expect({
      code: r.code,
      signal: r.signal,
      worker: typeof r.events['worker'] === 'number',
      workerGone: r.workerGone,
      claim: record?.claims?.['ask'] !== undefined,
      inProgress: record?.in_progress_steps.includes('ask'),
    }).toEqual({
      code: 143,
      signal: null,
      worker: true,
      workerGone: true,
      claim: false,
      inProgress: false,
    });
  }, 60_000);
});

describe('U1b Unit 2 — Ctrl-Z at a `realm workflow run` prompt (D5)', () => {
  it('(z) in log mode (`> log`, stdin and stderr a terminal): Ctrl-Z stops both processes, the first by SIGTSTP; `fg` resumes both, the prompt is redrawn and the answer typed then is taken', () => {
    const wf = wfFile('z', autoStep('s', 'quiet'));
    const r = talk('log', runArgs(wf), [
      ['expect', 'prompt', MOCK_PROMPT, 1, 20],
      ['worker', 'worker'],
      ['send', '\x1a'],
      ['stopped', 'stop', 3],
      ['sleep', 0.4],
      ['state', 'whileStopped'],
      ['fg'],
      ['sleep', 0.6],
      ['state', 'afterFg'],
      ['expect', 'redrawn', MOCK_PROMPT, 2, 3],
      ['send', '\r'],
    ]);
    const running = (s: unknown) => ['R', 'S'].includes(String(s));
    const after = r.events['afterFg'] as { first: unknown; worker: unknown };
    // (a) red without D5's listener (readline stops the worker alone, in its own session — or
    //     nothing — and the first process keeps running: no stop seen); (b) prints the stop signal,
    //     both states while stopped and after `fg`, the prompt's count and whether the run ended.
    expect({
      worker: typeof r.events['worker'] === 'number',
      stop: r.events['stop'],
      whileStopped: r.events['whileStopped'],
      bothRunningAfterFg: running(after.first) && running(after.worker),
      redrawn: drawn(r.tty, MOCK_PROMPT),
      code: r.code,
      completed: r.log.includes('Run complete. Phase: completed'),
    }).toEqual({
      worker: true,
      stop: 'SIGTSTP',
      whileStopped: { first: 'T', worker: 'T' },
      bothRunningAfterFg: true,
      redrawn: 2,
      code: 0,
      completed: true,
    });
  }, 60_000);

  it('(z2) on a terminal (all three streams): Ctrl-Z stops the command; `fg` → the prompt is redrawn and the answer typed then is taken', () => {
    const wf = wfFile('z2', autoStep('s', 'quiet'));
    const r = talk(
      'tty',
      runArgs(wf),
      [
        ['expect', 'prompt', MOCK_PROMPT, 1, 20],
        ['worker', 'worker'],
        ['send', '\x1a'],
        ['stopped', 'stop', 3],
        ['fg'],
        ['expect', 'redrawn', MOCK_PROMPT, 2, 3],
        ['send', '\r'],
      ],
      { exitTimeout: 10 },
    );
    // (a) red on the base: readline's own path redraws the prompt after SIGCONT but leaves its
    //     input paused, so no key is taken (the command still waits: timed out); (b) prints whether
    //     a worker ran, the stop signal, the prompt's count, whether it timed out and the ending.
    expect({
      worker: r.events['worker'],
      stop: r.events['stop'],
      redrawn: drawn(r.tty, MOCK_PROMPT),
      timedOut: r.timedOut,
      code: r.code,
      completed: r.tty.includes('Run complete. Phase: completed'),
    }).toEqual({
      worker: null,
      stop: 'SIGTSTP',
      redrawn: 2,
      timedOut: false,
      code: 0,
      completed: true,
    });
  }, 60_000);

  it('(z3) GROUNDING — Ctrl-Z while a handler runs between prompts, then `fg`: the run goes on, no prompt redrawn; Ctrl-Z at the next prompt works again', () => {
    const go = join(root, 'z3-go');
    const wf = wfFile('z3', [...autoStep('first', 'slow'), ...agentStep('second', 'first')]);
    const r = talk(
      'log',
      runArgs(wf),
      [
        ['expect', 'prompt', MOCK_PROMPT, 1, 20],
        ['send', '\r'],
        ['expect', 'handler', 'slow: running', 1, 20],
        ['send', '\x1a'],
        ['stopped', 'stop1', 3],
        ['fg'],
        ['sleep', 0.6],
        ['state', 'afterFg1'],
        ['expect', 'stale', MOCK_PROMPT, 2, 0.5],
        ['touch', go],
        ['expect', 'second', AGENT_PROMPT, 1, 20],
        ['send', '\x1a'],
        ['stopped', 'stop2', 3],
        ['fg'],
        ['expect', 'redrawn', AGENT_PROMPT, 2, 3],
        ['send', '\r'],
      ],
      { env: { U1B2_GO: go } },
    );
    const running = (s: unknown) => ['R', 'S'].includes(String(s));
    const after = r.events['afterFg1'] as { first: unknown; worker: unknown };
    // GROUNDING: the redraw is D5's, only while a question is open; (b) prints both stops, the
    //     state after the first `fg`, whether a stale prompt was drawn, the prompts' counts and the
    //     ending.
    expect({
      stop1: r.events['stop1'],
      bothRunningAfterFg: running(after.first) && running(after.worker),
      stalePrompt: r.events['stale'],
      mockPrompts: drawn(r.tty, MOCK_PROMPT),
      stop2: r.events['stop2'],
      agentPrompts: drawn(r.tty, AGENT_PROMPT),
      code: r.code,
      completed: r.log.includes('Run complete. Phase: completed'),
    }).toEqual({
      stop1: 'SIGTSTP',
      bothRunningAfterFg: true,
      stalePrompt: false,
      mockPrompts: 1,
      stop2: 'SIGTSTP',
      agentPrompts: 2,
      code: 0,
      completed: true,
    });
  }, 90_000);
});

describe('U1b Unit 2 — the two relay lines name the running command (D6)', () => {
  /** The relay in a child, after the pre-action hook recorded `realm <path…>` (none for `[]`), with
   *  a spawn that fails (EAGAIN) or a piped stream whose handle cannot be made blocking. */
  const relayLine = (
    path: string[],
    kind: 'spawn' | 'blocking',
  ): { code: number | null; stderr: string } => {
    const script = `import { createRequire } from 'node:module';
const { Command } = createRequire(${JSON.stringify(CLI_PACKAGE)})('commander');
const writer = await import(${JSON.stringify(WRITER_JS)});
const { runRelay } = await import(${JSON.stringify(RELAY_JS)});
const path = ${JSON.stringify(path)};
if (path.length > 0) {
  let parent = new Command('realm');
  const program = parent;
  for (const name of path) { const c = new Command(name); parent.addCommand(c); parent = c; }
  writer.writerHook(program, parent);
}
const tty = { isTTY: true };
const piped = { isTTY: false, _handle: {} };
await runRelay(${JSON.stringify(kind)} === 'spawn'
  ? { spawn: () => { throw Object.assign(new Error('spawn EAGAIN'), { code: 'EAGAIN' }); }, stdout: tty, stderr: tty }
  : { spawn: () => { process.stdout.write('SPAWNED'); throw new Error('no'); }, stdout: piped, stderr: process.stderr });`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    return { code: r.status, stderr: r.stderr };
  };

  it('(l-s) the spawn-failure line names `realm run drain` and its work; the not-blocking line names `realm run advance`; with no command recorded, or `realm agent`, both read `realm agent`’s text', () => {
    // (a) red when a line says `realm agent` for the four doors, or when `realm agent`'s text (the
    //     fallback) changes by a byte; (b) prints each line with its exit code.
    expect({
      drain: relayLine(['run', 'drain'], 'spawn'),
      advance: relayLine(['run', 'advance'], 'blocking'),
      noneSpawn: relayLine([], 'spawn'),
      noneBlocking: relayLine([], 'blocking'),
      agentSpawn: relayLine(['agent'], 'spawn'),
      agentBlocking: relayLine(['agent'], 'blocking'),
    }).toEqual({
      drain: {
        code: 1,
        stderr:
          'Error: realm run drain could not start the process that runs its work (EAGAIN). Nothing was started.\n',
      },
      advance: {
        code: 1,
        stderr:
          'Error: realm run advance cannot hide what its programs print here: this Node.js cannot make the output pipe blocking. Nothing was started.\n',
      },
      noneSpawn: { code: 1, stderr: `${AGENT_SPAWN_FAILED}\n` },
      noneBlocking: { code: 1, stderr: `${AGENT_NOT_BLOCKING}\n` },
      agentSpawn: { code: 1, stderr: `${AGENT_SPAWN_FAILED}\n` },
      agentBlocking: { code: 1, stderr: `${AGENT_NOT_BLOCKING}\n` },
    });
  }, 60_000);
});
