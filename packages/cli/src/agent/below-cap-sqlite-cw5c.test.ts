// below-cap-sqlite-cw5c.test.ts — #729 CW-5c check 6, on a SQLite home with the built CLI and real
// lease files: a `realm agent` drive is killed in the middle of its model call (its worker by its PID:
// the relay forwards only INT, TERM and HUP). `realm run inspect` and `realm run advance` then name
// `realm agent`; the command they name, run as printed (a provider module stands in for `--provider`
// and `--model`), takes the step back and completes it with one model call, and inspect then names
// nothing. In a second run of the same shape the drive that took the step back is killed too, mid-call,
// before it completes: inspect then shows today's words (the cap, on real leases).
//
// Each assertion carries the two questions of `~/.claude/TESTING-RULES.md` rule 8 next to it: (1) the
// change that turns it red; (2) what it prints when it fails.
import { describe, it, expect, afterEach } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CURRENT_WORKFLOW_SCHEMA_VERSION, type WorkflowDefinition } from '@sensigo/realm';
import { makeTempHome, type TempHome } from '../test-support/temp-home.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '../../dist/index.js');
const LLM_PROVIDER = pathToFileURL(join(HERE, '../../dist/agent/providers/llm-provider.js')).href;

const DEF = {
  id: 'below-cap-sqlite-cw5c',
  name: 'below-cap-sqlite-cw5c',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: { s: { description: 'An agent step.', execution: 'agent', depends_on: [] } },
} as WorkflowDefinition;

/** The provider module: `{ ok: true }`; with CW5C_READY, its pid written there and a long wait. */
const PROVIDER =
  `import { LlmProvider } from ${JSON.stringify(LLM_PROVIDER)};\n` +
  "import { appendFileSync, writeFileSync } from 'node:fs';\n" +
  'class P extends LlmProvider {\n' +
  '  async callStep() {\n' +
  "    appendFileSync(process.env.CW5C_CALLS, 'call\\n');\n" +
  '    if (process.env.CW5C_READY) {\n' +
  '      writeFileSync(process.env.CW5C_READY, String(process.pid));\n' +
  '      await new Promise((r) => setTimeout(r, 120000));\n' +
  '    }\n' +
  '    return { ok: true };\n' +
  '  }\n' +
  '}\n' +
  'export default new P();\n';

let h: TempHome & { readonly root: string };
let project: string;
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const c of children.splice(0))
    if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
  await h.cleanup();
  rmSync(project, { recursive: true, force: true });
});

const env = (operator: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  PATH: process.env['PATH'] ?? '',
  HOME: h.root,
  NO_COLOR: '1',
  REALM_NO_NUDGE: '1',
  REALM_OPERATOR: operator,
  CW5C_CALLS: join(project, 'calls'),
  ...extra,
});
const realm = (args: string[], operator = 'operator', extra: Record<string, string> = {}) => {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: project,
    env: env(operator, extra),
    encoding: 'utf8',
    timeout: 90_000,
  });
  return { code: r.status, out: r.stdout.split('\n').filter(Boolean), err: r.stderr };
};
async function until(test: () => boolean, ms = 30_000): Promise<void> {
  const by = Date.now() + ms;
  while (!test()) {
    if (Date.now() > by) throw new Error('fixture: timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
}
const calls = (): number =>
  existsSync(join(project, 'calls'))
    ? readFileSync(join(project, 'calls'), 'utf8').split('\n').filter(Boolean).length
    : 0;

async function home(): Promise<string> {
  h = await makeTempHome();
  project = realpathSync(mkdtempSync(join(tmpdir(), 'realm-cw5c-project-')));
  writeFileSync(join(project, 'p.mjs'), PROVIDER);
  await h.home.workflowStore.register(DEF);
  const { record } = await h.home.runStore.create({
    workflowId: DEF.id,
    workflowVersion: 1,
    params: {},
  });
  return record.id;
}

/** A built `realm agent` on the run, killed by its worker's PID once its model call has started. */
async function killedMidCall(runId: string, operator: string, ready: string): Promise<void> {
  const child = spawn(
    process.execPath,
    [CLI, 'agent', '--run-id', runId, '--provider-module', './p.mjs'],
    { cwd: project, env: env(operator, { CW5C_READY: ready }) },
  );
  children.push(child);
  const ended = new Promise<void>((r) => child.on('exit', () => r()));
  await until(() => existsSync(ready));
  process.kill(Number(readFileSync(ready, 'utf8')), 'SIGKILL');
  await ended;
}

/** The `realm agent` command a screen names, with a provider module for `--provider`/`--model`. */
const named = (lines: readonly string[]): string[] | undefined => {
  const m = /Or let (realm agent --run-id \S+) --provider <provider> --model <model> take/.exec(
    lines.join('\n'),
  );
  return m === null ? undefined : [...m[1]!.split(' ').slice(1), '--provider-module', './p.mjs'];
};

describe('#729 CW-5c check 6 — a killed drive’s step, on real leases', () => {
  it('below the cap: inspect and advance name realm agent; that command takes the step back with one model call; inspect then names nothing', async () => {
    const runId = await home();
    await killedMidCall(runId, 'drive-a', join(project, 'ready-a'));
    const inspect = realm(['run', 'inspect', runId]);
    const advance = realm(['run', 'advance', runId]);
    const command = named(inspect.out);
    const before = calls();
    const ran = command !== undefined ? realm(command, 'drive-b') : undefined;
    const after = realm(['run', 'inspect', runId]);
    // (1) red when inspect or advance does not name realm agent for a killed drive's step, or the
    //     command it names does not take the step back and run it; (2) prints the screens.
    expect(
      {
        inspectNames: command !== undefined,
        advanceNames: (advance.out.at(-1) ?? '').includes('Or let realm agent --run-id'),
        ranCode: ran?.code,
        tookBack: (ran?.out ?? []).some((l) => l.includes('so this drive took it back')),
        calls: calls() - before,
        completed: after.out.some((l) => l.startsWith('Completed: s')),
        afterNames: after.out.some((l) => l.includes('Or let realm agent')),
      },
      [...inspect.out, '---', ...advance.out, '---', ...(ran?.out ?? []), '---', ...after.out].join(
        '\n',
      ),
    ).toEqual({
      inspectNames: true,
      advanceNames: true,
      ranCode: 0,
      tookBack: true,
      calls: 1,
      completed: true,
      afterNames: false,
    });
  }, 150_000);

  it('at the cap: the drive that took the step back is killed too, mid-call — inspect shows today’s words', async () => {
    const runId = await home();
    await killedMidCall(runId, 'drive-a', join(project, 'ready-a'));
    // The next drive takes the step back (line (i)), starts its model call, and is killed in it.
    await killedMidCall(runId, 'drive-c', join(project, 'ready-c'));
    const inspect = realm(['run', 'inspect', runId]);
    const takeBacks = (await h.home.runStore.get(runId)).record.evidence.filter(
      (e) => e.output_summary?.['reason'] === 'lease_not_held',
    ).length;
    // (1) red when inspect names realm agent for a step already taken back since a person last
    //     reclaimed it (the drive would refuse at the cap); (2) prints the screen.
    expect(
      {
        takeBacks,
        names: inspect.out.some((l) => l.includes('Or let realm agent')),
        reclaim: inspect.out.some((l) =>
          l.trim().startsWith(`To free it, run: realm run reclaim ${runId} --step s`),
        ),
      },
      inspect.out.join('\n'),
    ).toEqual({ takeBacks: 1, names: false, reclaim: true });
  }, 150_000);
});
