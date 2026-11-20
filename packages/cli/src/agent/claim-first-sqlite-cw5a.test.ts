// claim-first-sqlite-cw5a.test.ts — #729 CW-5a on a real SQLite home: the hold closes (check 3, G1),
// a lease folder this program cannot write (check 7), the signals (check 8), a drive killed during its
// model call and the next drive (check 10), and cleanup while a drive holds its step (check 13).
//
// The drives are the built `realm agent` in a child process (its relay, then its worker), except
// check 3, which runs `runAgent` in this process (the listener count can only be read in the drive's
// own process). The model is a provider module: it answers `{ ok: true }`, or, with CW5A_READY set,
// writes its process id there and waits, so a cell acts while the drive holds the step.
//
// Each assertion carries the two questions of `~/.claude/TESTING-RULES.md` rule 8 next to it: (1) the
// change that turns it red; (2) what it prints when it fails.
import { describe, it, expect, afterEach } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  ExtensionRegistry,
  advanceRun,
  claimStepForDrive,
  createDefaultRegistry,
  executeStep,
  type RunRecord,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { makeTempHome, type TempHome } from '../test-support/temp-home.js';
import { runAgent } from './run-agent.js';
import { LlmProvider } from './providers/llm-provider.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../../../..');
const CLI = join(HERE, '../../dist/index.js');
const LLM_PROVIDER = pathToFileURL(join(HERE, '../../dist/agent/providers/llm-provider.js')).href;
const MCP_SERVER = pathToFileURL(
  join(ROOT, 'node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js'),
).href;
const MCP_STDIO = pathToFileURL(
  join(ROOT, 'node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js'),
).href;

const agent = (over: Record<string, unknown> = {}) => ({
  description: 'An agent step.',
  execution: 'agent',
  depends_on: [],
  ...over,
});
const wf = (id: string, steps: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({
    id,
    name: id,
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps,
    ...extra,
  }) as WorkflowDefinition;
const ONE = wf('claim-first-sqlite-cw5a', { s: agent() });

/** The provider module: `{ ok: true }`, or with CW5A_READY, its pid written there and a long wait. */
const PROVIDER =
  `import { ToolCapableLlmProvider } from ${JSON.stringify(LLM_PROVIDER)};\n` +
  "import { closeSync, openSync, readdirSync, writeFileSync } from 'node:fs';\n" +
  "import { join } from 'node:path';\n" +
  'const wait = () => new Promise((r) => setTimeout(r, 120000));\n' +
  "import { appendFileSync } from 'node:fs';\n" +
  'class P extends ToolCapableLlmProvider {\n' +
  '  async callStep() {\n' +
  "    if (process.env.CW5A_CALLS) appendFileSync(process.env.CW5A_CALLS, 'call\\n');\n" +
  "    if (process.env.CW5A_TOUCH) { const dir = join(process.env.HOME, '.realm', 'claim-leases'); for (const f of readdirSync(dir)) closeSync(openSync(join(dir, f), 'r')); }\n" +
  '    if (process.env.CW5A_READY) { writeFileSync(process.env.CW5A_READY, String(process.pid)); await wait(); }\n' +
  '    return { ok: true };\n' +
  '  }\n' +
  '  async callStepWithTools(prompt, tools, executor) {\n' +
  '    await executor(tools[0].id, {});\n' +
  '    return { output: { ok: true }, toolCalls: [] };\n' +
  '  }\n' +
  '}\n' +
  'export default new P();\n';
/** An MCP server whose one tool says it started, then never answers. */
const TOOL_SERVER =
  `import { McpServer } from ${JSON.stringify(MCP_SERVER)};\n` +
  `import { StdioServerTransport } from ${JSON.stringify(MCP_STDIO)};\n` +
  "import { writeFileSync } from 'node:fs';\n" +
  "const server = new McpServer({ name: 'cw5a-wait', version: '1.0.0' });\n" +
  "server.tool('wait', 'Waits.', async () => { writeFileSync(process.argv[2], 'started'); await new Promise((r) => setTimeout(r, 120000)); return { content: [] }; });\n" +
  'await server.connect(new StdioServerTransport());\n';
/** A handler `slow` for an auto step: says it started (inside the save), then waits for CW5A_GO. */
const EXTENSIONS =
  "import { existsSync, writeFileSync } from 'node:fs';\n" +
  'export default { handlers: { slow: { id: "slow", execute: async () => {\n' +
  "  writeFileSync(process.env.CW5A_SAVE, 'started');\n" +
  '  while (!existsSync(process.env.CW5A_GO)) await new Promise((r) => setTimeout(r, 20));\n' +
  '  return { data: {} };\n' +
  '} } } };\n';

let h: TempHome & { readonly root: string };
let project: string;
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const c of children.splice(0))
    if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
  await h.cleanup();
  rmSync(project, { recursive: true, force: true });
});

async function home(
  defOrMake: WorkflowDefinition | ((project: string) => WorkflowDefinition) = ONE,
): Promise<string> {
  h = await makeTempHome();
  project = realpathSync(mkdtempSync(join(tmpdir(), 'realm-cw5a-project-')));
  const def = typeof defOrMake === 'function' ? defOrMake(project) : defOrMake;
  writeFileSync(join(project, 'p.mjs'), PROVIDER);
  writeFileSync(join(project, 'tool-server.mjs'), TOOL_SERVER);
  writeFileSync(join(project, 'ext.mjs'), EXTENSIONS);
  await h.home.workflowStore.register(def);
  const { record } = await h.home.runStore.create({
    workflowId: def.id,
    workflowVersion: 1,
    params: {},
  });
  return record.id;
}
const env = (operator: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  PATH: process.env['PATH'] ?? '',
  HOME: h.root,
  NO_COLOR: '1',
  REALM_NO_NUDGE: '1',
  REALM_OPERATOR: operator,
  ...extra,
});
const agentArgs = (runId: string, extra: string[] = []): string[] => [
  CLI,
  'agent',
  '--run-id',
  runId,
  '--provider-module',
  './p.mjs',
  ...extra,
];

/** The built `realm agent` in a child process, with its output and its end. */
function start(
  runId: string,
  e: NodeJS.ProcessEnv,
  extra: string[] = [],
): {
  child: ChildProcess;
  out: () => string;
  ended: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
} {
  const child = spawn(process.execPath, agentArgs(runId, extra), { cwd: project, env: e });
  children.push(child);
  let out = '';
  child.stdout!.on('data', (d: Buffer) => (out += d.toString()));
  child.stderr!.on('data', (d: Buffer) => (out += d.toString()));
  const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.on('exit', (code, signal) => resolve({ code, signal })),
  );
  return { child, out: () => out, ended };
}
async function until(test: () => boolean, ms = 30_000): Promise<void> {
  const by = Date.now() + ms;
  while (!test()) {
    if (Date.now() > by) throw new Error('fixture: timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
}
const record = async (runId: string): Promise<RunRecord> =>
  (await h.home.runStore.get(runId)).record;
const takeBacks = (run: RunRecord) =>
  run.evidence.filter((e) => e.output_summary?.['reason'] === 'lease_not_held');
const leaseFiles = (): string[] => {
  const folder = join(h.path, 'claim-leases');
  return existsSync(folder) ? readdirSync(folder) : [];
};

describe('#729 CW-5a check 3 — G1: the hold closes after each save', () => {
  it('a drive completes two agent steps on a SQLite home: claim-leases/ is empty after it, and the signal listeners are as before', async () => {
    const def = wf('claim-first-g1', { a: agent(), b: agent({ depends_on: ['a'] }) });
    const runId = await home(def);
    const before = ['SIGINT', 'SIGTERM', 'SIGHUP'].map((s) => process.listenerCount(s));
    const during: number[] = [];
    const provider = new (class extends LlmProvider {
      async callStep(): Promise<Record<string, unknown>> {
        during.push(process.listenerCount('SIGINT'));
        return { ok: true };
      }
    })();
    const result = await runAgent(
      {
        store: h.home.runStore,
        workflowStore: h.home.workflowStore,
        provider,
        registry: createDefaultRegistry(),
        driver: { by: 'drive-g1', by_source: 'stated', channel: 'agent' },
      },
      { definition: def, existingRunId: runId, params: {} },
    );
    // (1) red when the hold is not closed after a save (its lease file stays, and a listener per
    //     step stays on each signal); (2) prints the files and the listener counts.
    expect({
      result,
      files: leaseFiles(),
      after: ['SIGINT', 'SIGTERM', 'SIGHUP'].map((s) => process.listenerCount(s)),
      heldDuring: during.map((n) => n - before[0]!),
    }).toEqual({ result: 'completed', files: [], after: before, heldDuring: [1, 1] });
  });
});

describe('#729 CW-5a check 7 — a lease folder this program cannot write', () => {
  it('claim-leases/ at mode 0500: the line names the folder; nothing claimed, no model call, exit 1', async () => {
    const runId = await home();
    mkdirSync(join(h.path, 'claim-leases'), { mode: 0o500 });
    chmodSync(join(h.path, 'claim-leases'), 0o500);
    // HOME is not a secret here, so the folder prints whole (as the docs' examples are made).
    const r = spawnSync(process.execPath, agentArgs(runId), {
      cwd: project,
      env: env('drive-b', { REALM_NOT_SECRET: 'HOME' }),
      encoding: 'utf8',
      timeout: 60_000,
    });
    chmodSync(join(h.path, 'claim-leases'), 0o700);
    const run = await record(runId);
    // (1) red when the drive calls the model without a claim, or the line names no folder or the
    //     wrong one; (2) prints the exit and the output.
    expect(
      {
        code: r.status,
        line: r.stderr.split('\n').find((l) => l.startsWith('• ')),
        claim: run.claims?.['s'],
        evidence: run.evidence.length,
      },
      `${r.stdout}\n${r.stderr}`,
    ).toEqual({
      code: 1,
      line: `• Step 's' was not started: this drive could not take a lease in ${join(h.path, 'claim-leases')} (this program cannot write there); nothing was claimed and the model was not called.`,
      claim: undefined,
      evidence: 0,
    });
  }, 90_000);
});

describe('#729 CW-5a check 8 — the signals', () => {
  it.each(['SIGINT', 'SIGTERM', 'SIGHUP'] as const)(
    '%s while the model works: the give-back line, then the drive dies by that signal; the step is free and no take-back is spent',
    async (signal) => {
      const runId = await home();
      const ready = join(project, 'ready');
      const a = start(runId, env('drive-b', { CW5A_READY: ready }));
      await until(() => existsSync(ready));
      a.child.kill(signal);
      const end = await a.ended;
      const run = await record(runId);
      // (1) red when the drive has no handler (it dies holding the step: the claim stays), exits
      //     128+n instead of dying by the signal, gives back twice, or records a drive failure;
      //     (2) prints the end, the output and the record.
      expect(
        {
          end,
          gaveBack: a
            .out()
            .split('\n')
            .filter((l) => l.includes('let its claim go')),
          claim: run.claims?.['s'],
          inFlight: run.in_progress_steps,
          takeBacks: takeBacks(run).length,
          failures: run.drive_failures?.entries.length ?? 0,
          files: leaseFiles(),
        },
        a.out(),
      ).toEqual({
        end: { code: null, signal },
        gaveBack: [
          `• Step 's': this drive let its claim go (it was stopped by ${signal}), so the step can run again.`,
        ],
        claim: undefined,
        inFlight: [],
        takeBacks: 0,
        failures: 0,
        files: [],
      });
    },
    90_000,
  );

  it('SIGINT with an MCP tool call in flight: one give-back line, no drive-failure entry, the signal’s death', async () => {
    const runId = await home((project) =>
      wf(
        'claim-first-tool',
        { s: agent({ tools: ['srv:wait'] }) },
        {
          mcp_servers: [
            {
              id: 'srv',
              transport: 'stdio',
              command: process.execPath,
              // The stdio client gives its server a short default environment: the path goes as an
              // argument.
              args: [join(project, 'tool-server.mjs'), join(project, 'tool-started')],
            },
          ],
        },
      ),
    );
    const tool = join(project, 'tool-started');
    const a = start(runId, env('drive-b'));
    await until(() => existsSync(tool) || a.child.exitCode !== null).catch(() => undefined);
    if (!existsSync(tool)) throw new Error(`fixture: the tool never started:\n${a.out()}`);
    a.child.kill('SIGINT');
    const end = await a.ended;
    const run = await record(runId);
    // (1) red when the tool's failure (its server dies with the signal) writes a drive-failure entry,
    //     gives back a second time, prints its own cause, or the drive exits 1; (2) prints the output.
    expect(
      {
        end,
        gaveBack: a
          .out()
          .split('\n')
          .filter((l) => l.includes('claim go') || l.includes('claim was removed')),
        failures: run.drive_failures?.entries.length ?? 0,
        claim: run.claims?.['s'],
      },
      a.out(),
    ).toEqual({
      end: { code: null, signal: 'SIGINT' },
      gaveBack: [
        "• Step 's': this drive let its claim go (it was stopped by SIGINT), so the step can run again.",
      ],
      failures: 0,
      claim: undefined,
    });
  }, 90_000);

  it('SIGINT during the save: the step stays saved with no give-back line, the next step is not claimed, the signal’s death', async () => {
    const runId = await home(
      wf('claim-first-save', {
        s: agent(),
        x: { description: 'x', execution: 'auto', depends_on: ['s'], handler: 'slow' },
        t: agent({ depends_on: ['x'] }),
      }),
    );
    const save = join(project, 'save-started');
    const go = join(project, 'go');
    const a = start(runId, env('drive-b', { CW5A_SAVE: save, CW5A_GO: go }), [
      '--extensions-module',
      './ext.mjs',
    ]);
    await until(() => existsSync(save));
    const at = Date.now();
    a.child.kill('SIGINT');
    // Correction 1: the drive waits only for s's own save, never for the step the chain runs after
    // it, so it dies while `x` still runs; `x` keeps its claim to its deadline, as on 0.50.0.
    const end = await a.ended;
    const tookMs = Date.now() - at;
    writeFileSync(go, 'go');
    const run = await record(runId);
    // (1) red when the drive waits for the chain (it then dies only when `x` returns), gives back
    //     a step it saved (a removed-claim line), claims the next step after the signal, or exits
    //     128+n; (2) prints the output and the record.
    expect(
      {
        end,
        within5s: tookMs < 5_000,
        giveBack: a
          .out()
          .split('\n')
          .filter((l) => l.includes('claim go') || l.includes('claim was removed')),
        completed: run.completed_steps,
        inFlight: run.in_progress_steps,
        tClaim: run.claims?.['t'],
      },
      a.out(),
    ).toEqual({
      end: { code: null, signal: 'SIGINT' },
      within5s: true,
      giveBack: [],
      completed: ['s'],
      inFlight: ['x'],
      tClaim: undefined,
    });
  }, 90_000);

  it('a shell loop over runs stops at Ctrl-C (the shell sees the drive die by SIGINT)', async () => {
    const runId = await home();
    const ready = join(project, 'ready');
    const line = `${JSON.stringify(process.execPath)} ${agentArgs(runId)
      .map((a) => JSON.stringify(a))
      .join(' ')}`;
    const bash = spawn('bash', ['-c', `for i in 1 2; do ${line}; echo "next-$i"; done`], {
      cwd: project,
      env: env('drive-b', { CW5A_READY: ready }),
      detached: true,
    });
    children.push(bash);
    let out = '';
    bash.stdout!.on('data', (d: Buffer) => (out += d.toString()));
    bash.stderr!.on('data', (d: Buffer) => (out += d.toString()));
    const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      bash.on('exit', (code, signal) => resolve({ code, signal })),
    );
    await until(() => existsSync(ready));
    // As a terminal's Ctrl-C: to the foreground process group (the shell and the drive).
    process.kill(-bash.pid!, 'SIGINT');
    const end = await ended;
    // (1) red when the drive exits 130 instead of dying by SIGINT (the shell then goes on with the
    //     next run); (2) prints the shell's end and output.
    expect({ end, next: out.includes('next-1') }, out).toEqual({
      end: { code: null, signal: 'SIGINT' },
      next: false,
    });
  }, 90_000);
});

describe('#729 CW-5a correction 1, check 4 — the drive’s output through a pipe', () => {
  it('a shell loop over two runs, each drive piped to tee: Ctrl-C stops the loop, one model call, no stack trace', async () => {
    const r1 = await home();
    const { record: second } = await h.home.runStore.create({
      workflowId: ONE.id,
      workflowVersion: 1,
      params: {},
    });
    const ready = join(project, 'ready');
    const calls = join(project, 'calls');
    const log = join(project, 'drive.log');
    // The drive's stdout is a pipe, so its relay runs; tee is a reader the same Ctrl-C ends.
    const drive = `${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} agent --run-id "$r" --provider-module ./p.mjs | tee -a ${JSON.stringify(log)}`;
    const bash = spawn(
      'bash',
      ['-c', `for r in ${r1} ${second.id}; do ${drive}; echo "next-$r"; done`],
      {
        cwd: project,
        env: env('drive-b', { CW5A_READY: ready, CW5A_CALLS: calls }),
        detached: true,
      },
    );
    children.push(bash);
    let out = '';
    let err = '';
    bash.stdout!.on('data', (d: Buffer) => (out += d.toString()));
    bash.stderr!.on('data', (d: Buffer) => (err += d.toString()));
    const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      bash.on('exit', (code, signal) => resolve({ code, signal })),
    );
    await until(() => existsSync(ready));
    // A person presses Ctrl-C during the model call, after the step's lines are on the screen: the
    // relay has passed them on (they are in tee's log). Earlier, a line still on its way through the
    // relay meets the closed pipe before the relay's own handler has run (correction 2's accepted
    // window), and the relay ends as on main.
    await until(() => existsSync(log) && readFileSync(log, 'utf8').includes('An agent step.'));
    // As a terminal's Ctrl-C: to the foreground process group (the shell, the relay and tee).
    process.kill(-bash.pid!, 'SIGINT');
    const end = await Promise.race([
      ended,
      new Promise<'still running'>((r) => setTimeout(() => r('still running'), 30_000)),
    ]);
    const callCount = existsSync(calls)
      ? readFileSync(calls, 'utf8').split('\n').filter(Boolean).length
      : 0;
    // (1) red when the relay dies on the closed pipe (its exit is then an ordinary one, so the
    //     shell starts the next run's drive and pays for its call), or prints a stack trace;
    //     (2) prints the shell's end, its output and its errors.
    expect(
      {
        end,
        next: out.includes('next-'),
        calls: callCount,
        stack: err.split('\n').filter((l) => /EPIPE|^\s+at /.test(l)),
      },
      `stdout:\n${out}\nstderr:\n${err}`,
    ).toEqual({ end: { code: null, signal: 'SIGINT' }, next: false, calls: 1, stack: [] });
  }, 90_000);
});

describe('#729 CW-5a correction 2, check 3 — SIGHUP through a pipe, as a closing terminal sends it', () => {
  it('the shell, the relay and tee get SIGHUP: the relay ends by SIGHUP, never exit 1; one model call; the step given back', async () => {
    const runId = await home();
    const ready = join(project, 'ready');
    const calls = join(project, 'calls');
    const log = join(project, 'drive.log');
    // The shell traps SIGHUP, so it lives to print how the relay ended (128 + n for a signal's death).
    // A trapped signal, unlike an ignored one, is reset in the shell's children: the relay and tee
    // get SIGHUP as at a closing terminal.
    const pipeline = `${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} agent --run-id ${runId} --provider-module ./p.mjs | tee -a ${JSON.stringify(log)}`;
    const bash = spawn(
      'bash',
      ['-c', `trap 'echo shell-hup' HUP; ${pipeline}; echo "relay=\${PIPESTATUS[0]}"`],
      {
        cwd: project,
        env: env('drive-b', { CW5A_READY: ready, CW5A_CALLS: calls }),
        detached: true,
      },
    );
    children.push(bash);
    let out = '';
    let err = '';
    bash.stdout!.on('data', (d: Buffer) => (out += d.toString()));
    bash.stderr!.on('data', (d: Buffer) => (err += d.toString()));
    const ended = new Promise<void>((resolve) => bash.on('exit', () => resolve()));
    await until(() => existsSync(ready));
    // As above: the signal comes during the model call, once the step's lines are on the screen.
    await until(() => existsSync(log) && readFileSync(log, 'utf8').includes('An agent step.'));
    process.kill(-bash.pid!, 'SIGHUP');
    await Promise.race([ended, new Promise((r) => setTimeout(r, 30_000))]);
    const run = await record(runId);
    const callCount = existsSync(calls)
      ? readFileSync(calls, 'utf8').split('\n').filter(Boolean).length
      : 0;
    // (1) red when a closed pipe after the signal is the relay's fatal (it then exits 1, and the
    //     exit hook's SIGTERM ends the worker), or a stack trace is printed; (2) prints the shell's
    //     output and errors and the record.
    expect(
      {
        relay: /relay=(\d+)/.exec(out)?.[1],
        calls: callCount,
        claim: run.claims?.['s'],
        inProgress: run.in_progress_steps,
        completed: run.completed_steps,
        stack: err.split('\n').filter((l) => /EPIPE|^\s+at /.test(l)),
      },
      `stdout:\n${out}\nstderr:\n${err}\nrecord: ${JSON.stringify(run.claims)}`,
    ).toEqual({
      relay: '129',
      calls: 1,
      claim: undefined,
      inProgress: [],
      completed: [],
      stack: [],
    });
  }, 90_000);
});

describe('#729 CW-5a check 10 — a drive killed during its model call, then the next drive', () => {
  it('A is SIGKILLed during its model call: the next drive prints line (i) after its own claim, and completes the step with one model call', async () => {
    const runId = await home();
    const ready = join(project, 'ready');
    const a = start(runId, env('drive-a', { CW5A_READY: ready }));
    await until(() => existsSync(ready));
    const since = (await record(runId)).claims?.['s']?.since;
    // The worker holds the lease: it is killed by its pid (the relay follows it).
    process.kill(Number(readFileSync(ready, 'utf8')), 'SIGKILL');
    await a.ended;
    const r = spawnSync(process.execPath, agentArgs(runId), {
      cwd: project,
      env: env('drive-b'),
      encoding: 'utf8',
      timeout: 90_000,
    });
    const out = r.stdout.split('\n');
    const back = out.findIndex((l) => l.startsWith("• Step 's' was taken by drive-a"));
    const run = await record(runId);
    // (1) red when the killed drive's claim carries no lease (the next drive then waits 60 s and
    //     stops), or line (i) is not followed by the step running here; (2) prints the output.
    expect(
      {
        code: r.status,
        line: out[back],
        ranAfter: out.slice(back).some((l) => l.includes('→ [agent] s')),
        takeBacks: takeBacks(run).map((e) => e.driven_by),
        completed: run.completed_steps,
        // Correction 1 (environment-and-files.md): the killed drive's file stays after the take-back.
        leaseFiles: leaseFiles().length,
      },
      `${r.stdout}\n${r.stderr}`,
    ).toEqual({
      code: 0,
      line: `• Step 's' was taken by drive-a (from REALM_OPERATOR, via agent) at ${since}; no program held the claim's lease when it was checked, so this drive took it back (this step's one automatic take-back until a person reclaims it). Its model and tools run here, so any side effects of the first program's calls may repeat.`,
      ranAfter: true,
      takeBacks: [{ by: 'drive-b', by_source: 'ambient', channel: 'agent' }],
      completed: ['s'],
      leaseFiles: 1,
    });
  }, 150_000);
});

describe('#729 CW-5a — realm-agent.md: a provider module that opens a lease file', () => {
  it('the drive’s own provider module opens and closes its lease file: a second drive takes the step back while the first still works, and both are paid', async () => {
    const runId = await home();
    const ready = join(project, 'ready');
    const a = start(runId, env('drive-a', { CW5A_READY: ready, CW5A_TOUCH: '1' }));
    await until(() => existsSync(ready));
    const r = spawnSync(process.execPath, agentArgs(runId), {
      cwd: project,
      env: env('drive-b'),
      encoding: 'utf8',
      timeout: 90_000,
    });
    const aStillWorks = a.child.exitCode === null && a.child.signalCode === null;
    process.kill(Number(readFileSync(ready, 'utf8')), 'SIGKILL');
    await a.ended;
    const run = await record(runId);
    // (1) red when opening and closing a lease file in the holding process keeps the lock (the
    //     second drive then waits and stops); (2) prints the second drive's output.
    expect(
      {
        code: r.status,
        aStillWorks,
        takeBacks: takeBacks(run).map((e) => e.driven_by?.by),
        completedBy: run.evidence
          .filter(
            (e) =>
              e.step_id === 's' &&
              e.status === 'success' &&
              e.output_summary?.['reclaimed'] !== true,
          )
          .map((e) => e.driven_by?.by),
      },
      `${r.stdout}\n${r.stderr}`,
    ).toEqual({ code: 0, aStillWorks: true, takeBacks: ['drive-b'], completedBy: ['drive-b'] });
  }, 150_000);
});

describe('#729 CW-5a correction 1 — environment-and-files.md: the lease files that stay', () => {
  it('a run that ended while a drive held its step: the file stays, named as realm run export shows the lease id, also after realm run purge; then, named by no claim, deleting it changes nothing', async () => {
    // `s` held by a drive; `p` another program's; `f`, after `p`, a handler that aborts the run: an
    // end does not clear another step's claim, so `s`'s claim (and its lease) stays on the record.
    const def = wf('claim-first-files', {
      s: agent(),
      p: agent(),
      f: { description: 'f', execution: 'auto', depends_on: ['p'], handler: 'ends' },
    });
    const runId = await home(def);
    const answer = await claimStepForDrive(h.home.runStore, runId, 's', {
      definition: def,
      registry: createDefaultRegistry(),
      driver: { by: 'drive-a', by_source: 'stated', channel: 'agent' },
    });
    if (answer.kind !== 'claimed') throw new Error(`fixture: ${JSON.stringify(answer)}`);
    const ending = new ExtensionRegistry();
    ending.register('handler', 'ends', {
      id: 'ends',
      execute: async () => ({ data: {}, abort: { message: 'the other branch ended the run' } }),
    } as never);
    const p = await executeStep(h.home.runStore, def, {
      runId,
      command: 'p',
      input: {},
      dispatcher: async () => ({}),
    });
    if (p.status !== 'ok') throw new Error(`fixture: ${JSON.stringify(p)}`);
    await advanceRun(h.home.runStore, def, { runId, registry: ending });
    const ended = await record(runId);
    if (ended.terminal_state !== true) throw new Error('fixture: the run did not end');
    // As the drive closes its hold on an ended run: with the record it has, which names the lease.
    answer.hold.close(ended);
    const realm = (args: string[]) =>
      spawnSync(process.execPath, [CLI, ...args], {
        cwd: project,
        env: env('operator'),
        encoding: 'utf8',
        timeout: 60_000,
      });
    const bundlePath = join(project, 'bundle.json');
    // This run was made in the store, with no project, so the export needs the flag that writes it
    // masked with what is known (a run started from a project needs none).
    const exported = realm([
      'run',
      'export',
      runId,
      '--out',
      bundlePath,
      '--accept-partial-disclosure',
    ]);
    const id = (JSON.parse(readFileSync(bundlePath, 'utf8')) as { run: RunRecord }).run.claims?.[
      's'
    ]?.lease?.id;
    const atEnd = leaseFiles();
    const purge = realm(['run', 'purge', runId, '--force']);
    const purged = await h.home.runStore.get(runId).then(
      () => false,
      () => true,
    );
    const afterPurge = leaseFiles();
    unlinkSync(join(h.path, 'claim-leases', `${id}.lease`));
    const cleanup = realm(['run', 'cleanup', '--older-than', '0m', '--dry-run']);
    // (1) red when the file is not named `<id>.lease` for the id the export shows, purge removes the
    //     file (or keeps the run), or a command fails once the file no claim names is gone;
    //     (2) prints the outputs.
    expect(
      {
        exportCode: exported.status,
        atEnd,
        purgeCode: purge.status,
        purged,
        afterPurge,
        cleanup: [cleanup.status, cleanup.stdout.split('\n')[0]],
      },
      [exported.stderr, purge.stdout, purge.stderr, cleanup.stdout, cleanup.stderr].join('\n---\n'),
    ).toEqual({
      exportCode: 0,
      atEnd: [`${id}.lease`],
      purgeCode: 0,
      purged: true,
      afterPurge: [`${id}.lease`],
      cleanup: [0, 'Would mark 0 run(s) as abandoned.'],
    });
  }, 120_000);
});

describe('#729 CW-5a check 13 — cleanup while a drive holds its step', () => {
  it('its lease held: cleanup lists nothing; its lease file deleted: cleanup lists nothing, and the reclaim dry run says no lease file', async () => {
    const runId = await home();
    const ready = join(project, 'ready');
    const a = start(runId, env('drive-a', { CW5A_READY: ready }));
    await until(() => existsSync(ready));
    const realm = (args: string[]) =>
      spawnSync(process.execPath, [CLI, ...args], {
        cwd: project,
        env: env('operator'),
        encoding: 'utf8',
        timeout: 60_000,
      });
    const held = realm(['run', 'cleanup', '--older-than', '0m', '--dry-run']);
    const [file] = leaseFiles();
    unlinkSync(join(h.path, 'claim-leases', file!));
    const gone = realm(['run', 'cleanup', '--older-than', '0m', '--dry-run']);
    const reclaim = realm(['run', 'reclaim', runId]);
    process.kill(Number(readFileSync(ready, 'utf8')), 'SIGKILL');
    await a.ended;
    // (1) red when the drive claims at its save (with no claim during the call, cleanup lists the
    //     run), or the reclaim dry run does not say the lease file is gone; (2) prints the outputs.
    expect(
      {
        held: {
          code: held.status,
          first: held.stdout.split('\n')[0],
          listsRun: held.stdout.includes(runId),
        },
        gone: {
          code: gone.status,
          first: gone.stdout.split('\n')[0],
          listsRun: gone.stdout.includes(runId),
        },
        absent: reclaim.stdout.includes(
          'This home has no lease file the claim names, so whether its program still holds it is not known',
        ),
      },
      [held.stdout, held.stderr, gone.stdout, gone.stderr, reclaim.stdout].join('\n---\n'),
    ).toEqual({
      held: { code: 0, first: 'Would mark 0 run(s) as abandoned.', listsRun: false },
      gone: { code: 0, first: 'Would mark 0 run(s) as abandoned.', listsRun: false },
      absent: true,
    });
  }, 120_000);
});
