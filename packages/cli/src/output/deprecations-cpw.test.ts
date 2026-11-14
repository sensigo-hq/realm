// deprecations-cpw.test.ts — CP-W: the CLI's deprecation door. Every id here is a test id, raised
// through the door's seam (`setDeprecationTableForTests`): the product table ships empty.
//   (a) in-process: a `--json` command's stdout stays a JSON document; the line is on stderr, once.
//   (b) the BUILT CLI through a test-owned entry (built as the real entry is): a piped `realm agent`
//       raises the id in both of its processes, and the log holds ONE line, its fake masked.
//   (c) in-process: `realm listen`'s spawn pipeline gives every agent the marker (listen's pid and
//       the ids it said); listen's own stderr holds the line once.
//   (g) in-process: an id raised before the writer is installed is flushed at install, masked.
//   (h) an unknown id throws, naming it; a marker that names an unknown id, or a pid that is not the
//       parent's, is ignored at the writer's init (the line prints).
// Every assertion names (a) the change that turns it red and (b) what it prints: counts, kinds and
// fixture text, never a real value.
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
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
import { Command } from 'commander';
import type { DeprecationEntry } from '@sensigo/realm';
import { installWriter, writerTestSeams } from './writer.js';
import { setDeprecationTableForTests, warnDeprecated } from './deprecations.js';
import { workflowCommands } from '../commands-registry.js';
import { makeAgentSpawner } from '../commands/listen.js';
import { makeTempHome } from '../test-support/temp-home.js';

const DIST = fileURLToPath(new URL('../../dist/', import.meta.url));
const CLI_PACKAGE = fileURLToPath(new URL('../../package.json', import.meta.url));
const url = (rel: string): string => pathToFileURL(join(DIST, rel)).href;
const MARKER = 'REALM_DEPRECATIONS_SAID';
/** The environment fake: in the command's environment only. */
const FAKE = 'CANARY-cpw-environment-7f3a-xxxxxxxx';
const ENV_NAME = 'CPW_FAKE_ENV';

const entry = (id: string, used = 'You used the old switch.'): DeprecationEntry => ({
  id,
  since: '0.49.0',
  removal: 'not scheduled',
  used,
  means: 'It means nothing now.',
  instead: 'Write nothing instead.',
  when: 'It goes away in a later release.',
});
const lineOf = (e: DeprecationEntry): string =>
  `Warning: [${e.id}] ${e.used} ${e.means} ${e.instead} ${e.when}`;
const linesFor = (text: string, id: string): string[] =>
  text.split('\n').filter((l) => l.includes(`[${id}]`));

/** Captures both streams; the writer, installed after, writes through these as its originals. Under
 *  vitest `console.log` does not reach `process.stdout.write`, so what a command logs is captured as
 *  stdout too. */
function capture() {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  }) as never);
  vi.spyOn(console, 'log').mockImplementation(((...args: unknown[]) => {
    out.push(`${args.map(String).join(' ')}\n`);
  }) as never);
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
    err.push(String(chunk));
    return true;
  }) as never);
  return { out: () => out.join(''), err: () => err.join('') };
}

beforeEach(() => {
  // The vitest setup names every inherited variable not secret; these cells sweep on purpose.
  vi.stubEnv('REALM_NOT_SECRET', '');
  vi.stubEnv(ENV_NAME, FAKE);
});
afterEach(() => {
  writerTestSeams.reset();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('CP-W — the CLI door', () => {
  it('(a) `realm workflow list --json`, a test id raised from its action’s hook: stdout is a JSON document, stderr holds the line once', async () => {
    const e = entry('REALM-D901');
    onTestFinished(setDeprecationTableForTests([e]));
    const home = await makeTempHome();
    onTestFinished(() => home.cleanup());
    vi.stubEnv('HOME', home.root);
    const io = capture();
    const program = new Command('realm');
    const group = new Command('workflow');
    for (const cmd of workflowCommands) group.addCommand(cmd);
    program.addCommand(group);
    // The writer's own hook (attached at the registry's load) runs first: the writer is installed
    // when the test's hook raises the id.
    const list = workflowCommands.find((c) => c.name() === 'list')!;
    list.hook('preAction', () => {
      warnDeprecated(e.id);
      warnDeprecated(e.id);
    });
    await program.parseAsync(['node', 'realm', 'workflow', 'list', '--json']);
    let json: unknown = 'not JSON';
    try {
      // What the writer shows on stdout: the document's data span without its marks.
      json = JSON.parse(writerTestSeams.visible(io.out()));
    } catch {
      // Stays 'not JSON'.
    }
    // (a) red when the door writes to stdout (the document no longer parses, and stderr lacks the
    //     line); red when the line is said twice; (b) prints the document's keys and stderr's lines.
    expect({
      document: json !== null && typeof json === 'object' ? Object.keys(json).sort() : json,
      stdoutHasTheLine: io.out().includes(`[${e.id}]`),
      stderrLines: linesFor(io.err(), e.id),
    }).toEqual({
      document: ['mismatched', 'unreadable', 'workflows'],
      stdoutHasTheLine: false,
      stderrLines: [lineOf(e)],
    });
  }, 60_000);

  it('(c) `realm listen`’s spawn pipeline, two deliveries: each agent’s environment carries the marker (listen’s pid and the id); listen’s own stderr holds the line once', async () => {
    const e = entry('REALM-D903');
    onTestFinished(setDeprecationTableForTests([e]));
    const io = capture();
    installWriter('broadcast');
    const seen: Array<Record<string, string | undefined> | undefined> = [];
    const fakeSpawn = ((_cmd: string, _args: string[], opts: { env?: Record<string, string> }) => {
      seen.push(opts.env);
      const child = Object.assign(new EventEmitter(), { pid: 4242, unref: () => {} });
      queueMicrotask(() => child.emit('spawn'));
      return child;
    }) as never;
    const spawnAgent = makeAgentSpawner(
      { model: 'm-cpw' },
      { info: () => {}, warn: () => {}, error: () => {} } as never,
      fakeSpawn,
    );
    for (const runId of ['run-1', 'run-2']) {
      // A flag listen forwards to every agent is raised by listen once per delivery.
      warnDeprecated(e.id);
      await spawnAgent(runId, process.cwd());
    }
    // (a) red when listen's spawn sets no marker (each agent would say the id again); red when
    //     listen says it twice; (b) prints the markers and listen's lines.
    // The said-set is the process's: an id another cell said may be in the marker too.
    const marker = (env: Record<string, string | undefined> | undefined) => {
      const [pid, ids = ''] = (env?.[MARKER] ?? '').split(':');
      return { pid: Number(pid), hasTheId: ids.split(',').includes(e.id) };
    };
    expect({
      markers: seen.map(marker),
      listenLines: linesFor(io.err(), e.id),
    }).toEqual({
      markers: [
        { pid: process.pid, hasTheId: true },
        { pid: process.pid, hasTheId: true },
      ],
      listenLines: [lineOf(e)],
    });
  });

  it('(g) an id raised before the writer is installed is flushed at install, on stderr, masked', () => {
    const e = entry('REALM-D904', `You used the switch with ${FAKE}.`);
    onTestFinished(setDeprecationTableForTests([e]));
    const io = capture();
    warnDeprecated(e.id);
    const beforeInstall = io.err();
    installWriter('default');
    // (a) red when the queue drains before the writer's stderr patch (the fake whole) or never
    //     (no line); (b) prints what stderr held before and after, and the fake's count.
    expect({
      beforeInstall,
      lines: linesFor(io.err(), e.id),
      fake: io.err().split(FAKE).length - 1,
    }).toEqual({
      beforeInstall: '',
      lines: [lineOf(entry(e.id, 'You used the switch with [REDACTED].'))],
      fake: 0,
    });
  });

  it('(h) an id not in the table throws, naming it', () => {
    onTestFinished(setDeprecationTableForTests([entry('REALM-D905')]));
    // (a) red when an unknown id is said (or silently dropped) instead; (b) prints the message.
    expect(() => warnDeprecated('REALM-D999')).toThrow(
      "warnDeprecated: REALM-D999 is not in Realm's deprecation table",
    );
  });

  it('(h) the marker at the writer’s init: honoured from the parent with known ids; ignored for an unknown id, another pid or a malformed value; deleted either way', () => {
    // A process with no writer: the line is queued and drains to stderr at exit.
    const script = `const door = await import(${JSON.stringify(url('output/deprecations.js'))});
door.setDeprecationTableForTests([${JSON.stringify(entry('REALM-D906'))}]);
await import(${JSON.stringify(url('output/writer.js'))});
process.stdout.write(typeof process.env.${MARKER});
door.warnDeprecated('REALM-D906');`;
    const run = (marker: string) => {
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        env: { PATH: process.env['PATH'] ?? '', [MARKER]: marker },
        encoding: 'utf8',
        timeout: 30_000,
      });
      return {
        code: r.status,
        markerLeft: r.stdout,
        lines: linesFor(r.stderr, 'REALM-D906').length,
      };
    };
    // (a) red when the marker is honoured from a pid that is not the parent's, or with an id the
    //     table lacks (the line is silenced), or a known one from the parent is not (the line
    //     prints); red when the marker is left in the environment or a bad one throws; (b) prints
    //     each case's exit code, the marker's type afterwards and the line count.
    expect({
      fromTheParent: run(`${process.pid}:REALM-D906`),
      unknownId: run(`${process.pid}:REALM-D906,REALM-D998`),
      anotherPid: run('1:REALM-D906'),
      malformed: run('not a marker'),
    }).toEqual({
      fromTheParent: { code: 0, markerLeft: 'undefined', lines: 0 },
      unknownId: { code: 0, markerLeft: 'undefined', lines: 1 },
      anotherPid: { code: 0, markerLeft: 'undefined', lines: 1 },
      malformed: { code: 0, markerLeft: 'undefined', lines: 1 },
    });
  }, 60_000);
});

describe('CP-W — once per command across a relay’s two processes (the built CLI)', () => {
  it('(b) `realm agent … > log 2>&1` with the id raised in both processes: ONE line in the log, the fake inside it [REDACTED]', async () => {
    const root = mkdtempSync(join(tmpdir(), 'realm-cpw-'));
    onTestFinished(() => rmSync(root, { recursive: true, force: true }));
    const home = await makeTempHome();
    onTestFinished(() => home.cleanup());
    const project = join(root, 'project');
    mkdirSync(join(project, 'wf'), { recursive: true });
    writeFileSync(join(project, 'package.json'), '{ "type": "module" }\n', 'utf8');
    // dotenv/config reads the .env of the command's cwd, in both processes.
    writeFileSync(join(project, '.env'), `${ENV_NAME}=${FAKE}\n`, 'utf8');
    writeFileSync(
      join(project, 'ext.mjs'),
      "export default { handlers: { quiet: { id: 'quiet', execute: async () => ({ data: { note: 'quiet' } }) } } };\n",
      'utf8',
    );
    writeFileSync(
      join(project, 'wf', 'workflow.yaml'),
      'id: cpw-b\nname: cpw b\nversion: 1\nextensions: ../ext.mjs\nsteps:\n  s:\n    description: One step.\n    execution: auto\n    handler: quiet\n',
      'utf8',
    );
    // The test's entry: the real entry's program (index.ts), with the test table set before the
    // writer loads and a hook on `agent` that raises the id; the relay starts its worker with this
    // same entry (process.argv[1]).
    const entryScript = join(root, 'entry.mjs');
    writeFileSync(
      entryScript,
      `import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const req = createRequire(${JSON.stringify(CLI_PACKAGE)});
await import(pathToFileURL(req.resolve('dotenv/config')).href);
const door = await import(${JSON.stringify(url('output/deprecations.js'))});
door.setDeprecationTableForTests([{ id: 'REALM-D902', since: '0.49.0', removal: 'not scheduled', used: 'You used the switch with ' + (process.env.${ENV_NAME} ?? '') + '.', means: 'It means nothing now.', instead: 'Write nothing instead.', when: 'It goes away in a later release.' }]);
const { Command } = req('commander');
const reg = await import(${JSON.stringify(url('commands-registry.js'))});
const { declareRealmProgram } = await import(${JSON.stringify(url('output/relay.js'))});
const { reportExpectedRefusal } = await import(${JSON.stringify(url('lib/expected-refusal.js'))});
const program = new Command();
program.name('realm');
for (const [name, list] of [['workflow', reg.workflowCommands], ['run', reg.runCommands], ['db', reg.dbCommands]]) {
  const group = new Command(name);
  for (const cmd of list) group.addCommand(cmd);
  program.addCommand(group);
}
for (const cmd of reg.topLevelCommands) program.addCommand(cmd);
reg.topLevelCommands.find((c) => c.name() === 'agent').hook('preAction', () => {
  process.stdout.write('cpw-hook: raised\\n');
  door.warnDeprecated('REALM-D902');
});
reg.installClockErrorSink();
declareRealmProgram();
try {
  await program.parseAsync();
} catch (err) {
  if (!reportExpectedRefusal(err)) throw err;
}
`,
      'utf8',
    );
    const log = join(root, 'log.txt');
    const fd = openSync(log, 'w');
    const child = spawn(
      process.execPath,
      [
        entryScript,
        'agent',
        '--workflow',
        join(project, 'wf'),
        '--project',
        project,
        '--provider',
        'anthropic',
        '--model',
        'fake-model',
      ],
      {
        cwd: project,
        env: {
          PATH: process.env['PATH'] ?? '',
          HOME: home.root,
          NO_COLOR: '1',
          REALM_NOT_SECRET: 'HOME',
          ANTHROPIC_API_KEY: 'fake-cpw-key-0000',
          ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
        },
        stdio: ['ignore', fd, fd],
      },
    );
    closeSync(fd);
    onTestFinished(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    });
    const code = await new Promise<number | null>((resolve) => child.once('close', resolve));
    const text = readFileSync(log, 'utf8');
    // (a) red without the marker on the relay's spawn (the worker says it again: two lines); red
    //     when the line bypasses the writer (the fake whole); (b) prints the code, how many processes
    //     raised the id, the lines and the fake's count.
    expect({
      code,
      raisedIn: text.split('\n').filter((l) => l === 'cpw-hook: raised').length,
      lines: linesFor(text, 'REALM-D902'),
      fake: text.split(FAKE).length - 1,
    }).toEqual({
      code: 0,
      raisedIn: 2,
      lines: [
        'Warning: [REALM-D902] You used the switch with [REDACTED]. It means nothing now. Write nothing instead. It goes away in a later release.',
      ],
      fake: 0,
    });
  }, 90_000);
});
