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
  rmSync,
  writeFileSync,
} from 'node:fs';
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

/** Starts `realm listen` and resolves with the port from its `listening` line (20 s limit). */
function startListen(
  args: string[],
  childEnv: Record<string, string>,
): Promise<{ child: ChildProcess; port: number; output: () => string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_ENTRY, 'listen', ...args], {
      cwd: root,
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

/** An Anthropic stand-in: answers every request with the captured 404, echoing the model asked. */
async function notFoundStub(): Promise<{ server: Server; url: string; models: string[] }> {
  const models: string[] = [];
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
      res.writeHead(404, { 'content-type': 'application/json', 'request-id': 'req_676' });
      res.end(
        JSON.stringify({
          type: 'error',
          error: { type: 'not_found_error', message: `model: ${model}` },
          request_id: 'req_676',
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as { port: number };
  return { server, url: `http://127.0.0.1:${port}`, models };
}

function runFiles(): string[] {
  const dir = join(home, '.realm', 'runs');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json'));
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

  it('E2 --run-id of an existing run, no --model → "Run <id> was left as it was.", the run file unchanged', async () => {
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
    expect(r.stderr.trim()).toBe(`Error: ${ONLY_ANTHROPIC} Run ${run.id} was left as it was.`);
    expect(r.stderr).not.toContain('Nothing was started.');
    expect(readFileSync(file).equals(before)).toBe(true);
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

  it('E5 the model reaches the child: one webhook → the spawned realm agent asks the stand-in for m-676', async () => {
    const stub = await notFoundStub();
    let listen: { child: ChildProcess; port: number; output: () => string } | undefined;
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
          '--dedup-store',
          'memory',
        ],
        env({ ANTHROPIC_API_KEY: 'k-676', ANTHROPIC_BASE_URL: stub.url }),
      );
      const res = await fetch(`http://127.0.0.1:${listen.port}/hook-676`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(res.status, await res.text()).toBe(202);
      const deadline = Date.now() + 20_000;
      while (stub.models.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(stub.models, listen.output()).toContain('m-676');
    } finally {
      listen?.child.kill('SIGKILL');
      stub.server.closeAllConnections();
      await new Promise<void>((r) => stub.server.close(() => r()));
    }
  }, 45_000);
});
