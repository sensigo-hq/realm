// no-default-model-676.test.ts — issue #676 through the BUILT CLI: realm has no default model.
//
// Every cell runs `dist/index.js` with a scratch HOME and working folder, and a minimal
// environment (PATH, HOME and only the keys the cell names), so no real key or `.env` is used.
// Every provider address is local — an in-test server on ANTHROPIC_BASE_URL, or a closed local
// port — so a red build never sends a request to a real provider. Every command is stopped if it
// has not exited after 20 s, so a red build leaves no server running.
import { spawn, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JsonFileStore } from '@sensigo/realm';

const CLI_ENTRY = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const ANTHROPIC_LIST = 'https://platform.claude.com/docs/en/models/overview';
const OPENAI_LIST = 'https://developers.openai.com/api/docs/models';
const CLOSED_PORT = 'http://127.0.0.1:9';

const ONLY_ANTHROPIC =
  '--model is required: realm has no default model. ANTHROPIC_API_KEY is set, so the provider is Anthropic; ' +
  `name one of its models (Anthropic lists them at ${ANTHROPIC_LIST}).`;
const ANTHROPIC_KEY_MISSING =
  '--provider anthropic was given, but ANTHROPIC_API_KEY is not set or is empty (only OPENAI_API_KEY is set). ' +
  'Set ANTHROPIC_API_KEY, or use --provider openai with an OpenAI model.';
const LISTEN_ANTHROPIC =
  'Error: --model is required: realm has no default model, and realm listen starts realm agent --provider anthropic for every run. ' +
  `Name an Anthropic model; Anthropic lists them at ${ANTHROPIC_LIST}. Nothing was started.`;
const LISTEN_NO_PROVIDER =
  'Error: --model is required: realm has no default model, and realm listen starts realm agent for every run. ' +
  'Each one picks its provider from the API key it finds (OpenAI when both are set; choose one with --provider). ' +
  `Anthropic lists its models at ${ANTHROPIC_LIST}; OpenAI at ${OPENAI_LIST}. Nothing was started.`;

/** One agent step behind a webhook trigger (no auth: a test on loopback only). */
const WORKFLOW = [
  'id: no-default-model-676',
  'name: No default model 676',
  'version: 1',
  'trigger:',
  '  type: webhook',
  '  path: /hook-676',
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
let wfDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'realm-676-cli-'));
  home = join(root, 'home');
  wfDir = join(root, 'wf');
  mkdirSync(home);
  mkdirSync(wfDir);
  writeFileSync(join(wfDir, 'workflow.yaml'), WORKFLOW, 'utf8');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function env(extra: Record<string, string> = {}): Record<string, string> {
  return { PATH: process.env['PATH'] ?? '', HOME: home, ...extra };
}

type Done = { code: number | null; stdout: string; stderr: string; timedOut: boolean };

/** Runs the built CLI to its end (async: an in-test server must be able to answer). */
function runCli(args: string[], childEnv: Record<string, string>): Promise<Done> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
      cwd: root,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, 20_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

/** Starts `realm listen` in `cwd` and resolves with the port from its `listening` line (20 s limit). */
function startListen(
  args: string[],
  childEnv: Record<string, string>,
  cwd: string = root,
): Promise<{ child: ChildProcess; port: number; output: () => string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_ENTRY, 'listen', ...args], {
      cwd,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const output = (): string => out;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`realm listen never printed its listening line. Output:\n${out}`));
    }, 20_000);
    const onData = (c: Buffer): void => {
      out += c.toString();
      const m = /realm listen on 127\.0\.0\.1:(\d+)/.exec(out);
      if (m !== null) {
        clearTimeout(timer);
        resolve({ child, port: Number(m[1]), output });
      }
    };
    child.stdout!.on('data', onData);
    child.stderr!.on('data', onData);
    child.on('close', (code) => {
      clearTimeout(timer);
      reject(new Error(`realm listen exited (${String(code)}) before listening. Output:\n${out}`));
    });
  });
}

/**
 * An Anthropic stand-in: answers every request with the captured 404, echoing the model asked.
 *
 * With `hold`, it records the model as soon as a request arrives, then waits to answer until the
 * test calls `release()` — so the agent is still waiting on it, and alive, until then. `release()` is
 * sticky: once called, every request, also one that arrives later, is answered at once; calling it
 * again, or with nothing waiting, does nothing. Without `hold`, every request is answered at once.
 */
async function notFoundStub(options: { hold?: boolean } = {}): Promise<{
  server: Server;
  url: string;
  models: string[];
  release: () => void;
}> {
  const models: string[] = [];
  let released = options.hold !== true;
  const waiting: Array<() => void> = [];
  const release = (): void => {
    released = true;
    for (const answer of waiting.splice(0)) answer();
  };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      let model = '';
      try {
        model = String((JSON.parse(body) as { model?: unknown }).model);
      } catch {
        /* not JSON: answer anyway */
      }
      models.push(model);
      const answer = (): void => {
        res.writeHead(404, { 'content-type': 'application/json', 'request-id': 'req_676' });
        res.end(
          JSON.stringify({
            type: 'error',
            error: { type: 'not_found_error', message: `model: ${model}` },
            request_id: 'req_676',
          }),
        );
      };
      if (released) answer();
      else waiting.push(answer);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as { port: number };
  return { server, url: `http://127.0.0.1:${port}`, models, release };
}

function runFiles(): string[] {
  const dir = join(home, '.realm', 'runs');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json'));
}

/** The fields E5 reads from the one run record (`drive_failures` is written only after the 404). */
interface E5Record {
  agent_pid?: number;
  drive_failures?: { entries?: Array<{ declared_per_attempt_ms?: number }> };
}

/** The one run record: the only `*.json` directly under the runs folder (temp files end `.tmp`). */
function readOnlyRun(): E5Record | undefined {
  const files = runFiles();
  if (files.length !== 1) return undefined;
  return JSON.parse(readFileSync(join(home, '.realm', 'runs', files[0]!), 'utf8')) as E5Record;
}

/** Whether a process with this pid exists (`kill(pid, 0)` does not throw). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Polls `done` every 50 ms until it holds or `ms` pass; returns whether it held. */
async function waitUntil(done: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
  return true;
}

const WF_ARG = ['--workflow', join('wf', 'workflow.yaml')];

describe('realm agent refuses without --model, before any run (issue #676)', () => {
  it('E1 --workflow, ANTHROPIC_API_KEY set, no --model → the refusal + "Nothing was started.", no run file', async () => {
    const r = await runCli(
      ['agent', ...WF_ARG],
      env({ ANTHROPIC_API_KEY: 'k-676', ANTHROPIC_BASE_URL: CLOSED_PORT }),
    );
    expect(r.code).toBe(1);
    expect(r.stderr.trim()).toBe(`Error: ${ONLY_ANTHROPIC} Nothing was started.`);
    expect(runFiles()).toEqual([]);
  }, 30_000);

  it('E2 --run-id of an existing run, no --model → "If run <id> exists, it was not changed.", the run file unchanged', async () => {
    const store = new JsonFileStore(join(home, '.realm', 'runs'));
    const { run } = await store.create({
      workflowId: 'no-default-model-676',
      workflowVersion: 1,
      params: {},
    });
    const file = join(home, '.realm', 'runs', `${run.id}.json`);
    const before = readFileSync(file);
    const r = await runCli(
      ['agent', '--run-id', run.id],
      env({ ANTHROPIC_API_KEY: 'k-676', ANTHROPIC_BASE_URL: CLOSED_PORT }),
    );
    expect(r.code).toBe(1);
    expect(r.stderr.trim()).toBe(
      `Error: ${ONLY_ANTHROPIC} If run ${run.id} exists, it was not changed.`,
    );
    expect(r.stderr).not.toContain('Nothing was started.');
    expect(readFileSync(file).equals(before)).toBe(true);
  }, 30_000);

  it('E2b --run-id of a run that does not exist, no --model → the same ending, which does not say the run exists; no run file', async () => {
    const r = await runCli(
      ['agent', '--run-id', 'no-such-run-676'],
      env({ ANTHROPIC_API_KEY: 'k-676', ANTHROPIC_BASE_URL: CLOSED_PORT }),
    );
    expect(r.code).toBe(1);
    expect(r.stderr.trim()).toBe(
      `Error: ${ONLY_ANTHROPIC} If run no-such-run-676 exists, it was not changed.`,
    );
    expect(runFiles()).toEqual([]);
  }, 30_000);

  it("E7 --model '' → the same refusal as a missing --model, no run file", async () => {
    const r = await runCli(
      ['agent', ...WF_ARG, '--model', ''],
      env({ ANTHROPIC_API_KEY: 'k-676', ANTHROPIC_BASE_URL: CLOSED_PORT }),
    );
    expect(r.code).toBe(1);
    expect(r.stderr.trim()).toBe(`Error: ${ONLY_ANTHROPIC} Nothing was started.`);
    expect(runFiles()).toEqual([]);
  }, 30_000);

  it("E7 --model '   ' → the same refusal as a missing --model, no run file", async () => {
    const r = await runCli(
      ['agent', ...WF_ARG, '--model', '   '],
      env({ ANTHROPIC_API_KEY: 'k-676', ANTHROPIC_BASE_URL: CLOSED_PORT }),
    );
    expect(r.code).toBe(1);
    expect(r.stderr.trim()).toBe(`Error: ${ONLY_ANTHROPIC} Nothing was started.`);
    expect(runFiles()).toEqual([]);
  }, 30_000);

  it('E6 --provider anthropic --model m with only OPENAI_API_KEY → the key refusal, no run file', async () => {
    const r = await runCli(
      ['agent', ...WF_ARG, '--provider', 'anthropic', '--model', 'm'],
      env({
        OPENAI_API_KEY: 'k-676',
        ANTHROPIC_BASE_URL: CLOSED_PORT,
        OPENAI_BASE_URL: CLOSED_PORT,
      }),
    );
    expect(r.code).toBe(1);
    expect(r.stderr.trim()).toBe(`Error: ${ANTHROPIC_KEY_MISSING} Nothing was started.`);
    expect(runFiles()).toEqual([]);
  }, 30_000);
});

describe('the model-not-found sentence, against a local stand-in (issue #676)', () => {
  it('E3 --model claude-does-not-exist → the failure line, then the sentence; the record keeps the 404', async () => {
    const stub = await notFoundStub();
    try {
      const r = await runCli(
        ['agent', ...WF_ARG, '--model', 'claude-does-not-exist'],
        env({ ANTHROPIC_API_KEY: 'k-676', ANTHROPIC_BASE_URL: stub.url }),
      );
      expect(r.code, r.stderr).toBe(1);
      const lines = r.stderr.split('\n');
      const at = lines.findIndex((l) => l.startsWith("✗ Step 'ask' LLM call failed: 404 "));
      expect(at, r.stderr).toBeGreaterThanOrEqual(0);
      expect(lines[at + 1]).toBe(
        '  Anthropic offers no model named claude-does-not-exist to this API key. Check the name given to --model; ' +
          `current models are listed at ${ANTHROPIC_LIST} and retired ones at ` +
          'https://platform.claude.com/docs/en/about-claude/model-deprecations.',
      );
      expect(stub.models).toContain('claude-does-not-exist');

      const files = runFiles();
      expect(files).toHaveLength(1);
      const run = JSON.parse(readFileSync(join(home, '.realm', 'runs', files[0]!), 'utf8')) as {
        drive_failures?: {
          entries: Array<{ error_class: string; last_observed_status?: number; message: string }>;
        };
      };
      const entry = run.drive_failures!.entries[0]!;
      expect(entry.error_class).toBe('api_status');
      expect(entry.last_observed_status).toBe(404);
      // The provider's own words: the 404 and its body, not realm's sentence.
      expect(entry.message.startsWith('404 ')).toBe(true);
      expect(entry.message).toContain('model: claude-does-not-exist');
      expect(entry.message).not.toContain('Anthropic offers no model');
    } finally {
      stub.server.closeAllConnections();
      await new Promise<void>((r) => stub.server.close(() => r()));
    }
  }, 30_000);
});

describe('realm listen requires --model and checks no API key (issue #676)', () => {
  it('E4 --provider anthropic, no --model, only OPENAI_API_KEY → the --provider anthropic line; nothing registered', async () => {
    const r = await runCli(
      ['listen', 'wf', '--port', '0', '--provider', 'anthropic'],
      env({
        OPENAI_API_KEY: 'k-676',
        ANTHROPIC_BASE_URL: CLOSED_PORT,
        OPENAI_BASE_URL: CLOSED_PORT,
      }),
    );
    expect(r.code).toBe(1);
    expect(r.stderr.trim()).toBe(LISTEN_ANTHROPIC);
    expect(existsSync(join(home, '.realm', 'workflows'))).toBe(false);
  }, 30_000);

  it('E4b no --provider, no --model, no key at all → the no---provider line (refused for the model, never a key)', async () => {
    const r = await runCli(
      ['listen', 'wf', '--port', '0'],
      env({ ANTHROPIC_BASE_URL: CLOSED_PORT, OPENAI_BASE_URL: CLOSED_PORT }),
    );
    expect(r.code).toBe(1);
    expect(r.stderr.trim()).toBe(LISTEN_NO_PROVIDER);
    expect(existsSync(join(home, '.realm', 'workflows'))).toBe(false);
  }, 30_000);

  it("E7 listen --model '' → the no---provider line; nothing registered", async () => {
    const r = await runCli(
      ['listen', 'wf', '--port', '0', '--model', ''],
      env({ ANTHROPIC_API_KEY: 'k-676', ANTHROPIC_BASE_URL: CLOSED_PORT }),
    );
    expect(r.code).toBe(1);
    expect(r.stderr.trim()).toBe(LISTEN_NO_PROVIDER);
    expect(existsSync(join(home, '.realm', 'workflows'))).toBe(false);
  }, 30_000);

  it('E4c no key in listen’s own environment, ANTHROPIC_API_KEY only in the workflow folder’s .env → listen starts', async () => {
    // Example 09's documented shape: each child loads the workflow folder's `.env` itself.
    writeFileSync(
      join(wfDir, '.env'),
      `ANTHROPIC_API_KEY=k-676\nANTHROPIC_BASE_URL=${CLOSED_PORT}\n`,
      'utf8',
    );
    const listen = await startListen(
      [
        'wf',
        '--port',
        '0',
        '--provider',
        'anthropic',
        '--model',
        'm-676',
        '--dedup-store',
        'memory',
      ],
      env(),
    );
    try {
      expect(listen.port).toBeGreaterThan(0);
    } finally {
      listen.child.kill('SIGKILL');
    }
  }, 30_000);

  // issue #744: both keys are set, so the agent picks its provider only from `--provider`: without
  // it, OpenAI wins (`llm-provider.ts:292`) and its client asks the closed local port. The stand-in
  // holds its 404 until the cell has seen the agent running, so the agent is alive at the hit by
  // construction; after the 404 the run record holds the timeout the agent was given
  // (`drive_failures.entries[0].declared_per_attempt_ms`). (a) red when listen stops passing the
  // model, the provider or the timeout to the agent, when `aliveAtHit` is read only after the agent
  // has finished (it then reads false), or when it stops waiting for its agent; (b) prints the
  // models asked for, `aliveAtHit`, the declared timeout, `agentExited` and listen's output (its
  // environment holds only PATH, HOME and the stand-in keys); a request that gets no answer within
  // 20 s fails with listen's output.
  it('E5 the model, the provider and the timeout reach the child: one webhook → the spawned realm agent asks the Anthropic stand-in for m-676 with a 45 s timeout, and exits', async () => {
    const stub = await notFoundStub({ hold: true });
    let listen: { child: ChildProcess; port: number; output: () => string } | undefined;
    let pid: number | undefined;
    try {
      listen = await startListen(
        [
          'wf',
          '--port',
          '0',
          '--provider',
          'anthropic',
          '--model',
          'm-676',
          '--llm-timeout',
          '45',
          '--dedup-store',
          'memory',
        ],
        env({
          ANTHROPIC_API_KEY: 'k-676',
          ANTHROPIC_BASE_URL: stub.url,
          OPENAI_API_KEY: 'k-744',
          OPENAI_BASE_URL: CLOSED_PORT,
        }),
      );
      let res: Response;
      try {
        res = await fetch(`http://127.0.0.1:${listen.port}/hook-676`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
          signal: AbortSignal.timeout(20_000),
        });
      } catch (err) {
        const e = err as Error;
        throw new Error(`${e.name}: ${e.message}\nlisten's output:\n${listen.output()}`, {
          cause: err,
        });
      }
      expect(res.status, await res.text()).toBe(202);
      await waitUntil(() => stub.models.includes('m-676'), 20_000);
      // At the hit, the stand-in has not answered, so the agent is waiting on it. The record and the
      // check are read with no await in between.
      pid = readOnlyRun()?.agent_pid;
      const aliveAtHit = pid !== undefined && isAlive(pid);
      stub.release();
      let record = readOnlyRun();
      await waitUntil(() => {
        record = readOnlyRun();
        return (
          record?.drive_failures?.entries?.[0] !== undefined && pid !== undefined && !isAlive(pid)
        );
      }, 10_000);
      expect(
        {
          models: stub.models,
          aliveAtHit,
          declaredPerAttemptMs: record?.drive_failures?.entries?.[0]?.declared_per_attempt_ms,
          agentExited: pid !== undefined && !isAlive(pid),
        },
        listen.output(),
      ).toEqual({
        models: ['m-676'],
        aliveAtHit: true,
        declaredPerAttemptMs: 45000,
        agentExited: true,
      });
    } finally {
      // Let the agent finish and wait for it BEFORE listen goes: while listen lives it reaps the agent,
      // and once listen is killed an exited agent can linger as a zombie that still answers
      // `kill(pid, 0)`. An agent still alive after the bound is killed, so a failing E5 leaves nothing
      // writing under the removed temp folder.
      stub.release();
      try {
        pid ??= readOnlyRun()?.agent_pid;
      } catch {
        /* keep going */
      }
      if (pid !== undefined) {
        const agent = pid;
        if (!(await waitUntil(() => !isAlive(agent), 10_000))) {
          try {
            process.kill(agent, 'SIGKILL');
          } catch {
            /* already gone */
          }
        }
      }
      listen?.child.kill('SIGKILL');
      stub.server.closeAllConnections();
      await new Promise<void>((r) => stub.server.close(() => r()));
    }
  }, 90_000);
});

describe('the re-attach command repeats the flags the CLI was given (issue #676 review)', () => {
  it('a step blocked on a missing handler → the printed command carries every repeated flag, under the names the CLI parsed', async () => {
    const dir = join(root, 'blocked');
    mkdirSync(dir);
    writeFileSync(
      join(dir, 'workflow.yaml'),
      [
        'id: reattach-cli-676',
        'name: Reattach CLI 676',
        'version: 1',
        'steps:',
        '  publish:',
        '    description: Publish.',
        '    execution: auto',
        '    handler: publish_answer',
        '',
      ].join('\n'),
      'utf8',
    );
    writeFileSync(join(dir, 'ext.mjs'), 'export default { handlers: {} };\n', 'utf8');
    const flags = [
      '--provider',
      'anthropic',
      '--model',
      'm-676',
      '--extensions-module',
      'blocked/ext.mjs',
      '--project',
      'blocked',
      '--schema-retries',
      '3',
      '--llm-timeout',
      '45',
      '--mint-writer-nonce',
    ];
    const r = await runCli(
      ['agent', '--workflow', join('blocked', 'workflow.yaml'), ...flags],
      env({ ANTHROPIC_API_KEY: 'k-676', ANTHROPIC_BASE_URL: CLOSED_PORT }),
    );
    expect(r.code).toBe(1);
    const files = runFiles();
    expect(files).toHaveLength(1);
    const runId = files[0]!.replace(/\.json$/, '');
    const line = r.stderr.split('\n').find((l) => l.startsWith("⚠ Step 'publish' is blocked:"));
    expect(line).toBe(
      "⚠ Step 'publish' is blocked: handler 'publish_answer' is not registered in this runner. " +
        `The run is NOT failed — add handler 'publish_answer' and re-attach (\`realm agent --run-id ${runId} ${flags.join(' ')}\`).`,
    );
  }, 30_000);
});

describe('realm listen started inside its workflow folder, the folder removed (issue #744)', () => {
  it('R1 no workflow argument, the folder removed → 500 spawn_failed, and webhook: spawn failed names the folder as a full path', async () => {
    const dir = join(root, 'gone-744');
    mkdirSync(dir);
    writeFileSync(join(dir, 'workflow.yaml'), WORKFLOW, 'utf8');
    const real = realpathSync(dir);
    let listen: { child: ChildProcess; port: number; output: () => string } | undefined;
    try {
      // No workflow argument: listen loads `./workflow.yaml` from the folder it is started in, as
      // `realm listen ./` does.
      listen = await startListen(
        ['--port', '0', '--model', 'm-744', '--dedup-store', 'memory'],
        env(),
        dir,
      );
      rmSync(dir, { recursive: true, force: true });
      const named = `"cwd":${JSON.stringify(real)}`;
      const expected = {
        status: 500,
        body: { error: 'spawn_failed', status: 'failed', run_id: 'string' },
        line: expect.stringContaining(named),
      };
      let res: Response;
      try {
        res = await fetch(`http://127.0.0.1:${listen.port}/hook-676`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });
      } catch {
        // No reply: listen crashed or stopped. Wait for its exit (at most 2 s; `exitCode` is still
        // null the moment the request fails), then report the exit and its last error line.
        const child = listen.child;
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          once(child, 'exit').catch(() => undefined),
          new Promise<void>((r) => (timer = setTimeout(r, 2_000))),
        ]);
        clearTimeout(timer);
        const lastError =
          listen
            .output()
            .split('\n')
            .filter((l) => l.startsWith('Error') || l.startsWith('node:'))
            .at(-1) ?? 'no such line';
        expect({ status: 'no reply', exit: child.exitCode, line: lastError }).toEqual(expected);
        return;
      }
      const text = await res.text();
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(text) as Record<string, unknown>;
      } catch {
        body = { unparsable: text };
      }
      const spawnFailed = (): string[] =>
        listen!
          .output()
          .split('\n')
          .filter((l) => l.startsWith('webhook: spawn failed '));
      const deadline = Date.now() + 10_000;
      while (!spawnFailed().some((l) => l.includes(named)) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      // (a) red when the folder is kept relative (`202`: an agent starts in the removed folder and
      //     exits at once), when the line does not name the folder's full path, or when listen
      //     crashes (no reply); (b) prints the status, the body, and the `webhook: spawn failed` line
      //     or "no such line" — or, with no reply, `status: 'no reply'`, listen's exit code and its
      //     last `Error`/`node:` line. Never the whole output, never the environment: `startListen`
      //     prints listen's whole output only when listen never starts, and this cell's environment
      //     holds no secret (`env()` = PATH and HOME).
      expect({
        status: res.status,
        body: { error: body['error'], status: body['status'], run_id: typeof body['run_id'] },
        line: spawnFailed().find((l) => l.includes(named)) ?? spawnFailed()[0] ?? 'no such line',
      }).toEqual(expected);
    } finally {
      listen?.child.kill('SIGKILL');
    }
  }, 45_000);
});
