// prompt-cache-600.test.ts — issue #600 PR 2 through the BUILT CLI: what `realm agent` asks
// Anthropic to cache, what each request records, and the refusals of a setting that can never apply.
//
// The harness is `no-default-model-676.test.ts`'s: every cell runs `dist/index.js` with a scratch
// HOME and working folder and a minimal environment (PATH, HOME and only the dummy keys the cell
// names), so no real key or `.env` is used. Every provider address is local — the in-test Anthropic
// stand-in (`test-support/anthropic-stub.ts`, which answers 200) or a closed local port — so a red
// build never sends a request to a real provider. Every command is stopped after 20 s. On a failing
// CI host a cell prints the command's output, the request's `system` field or the stored request
// facts: no environment, header or key.
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  JsonFileStore,
  JsonWorkflowStore,
  type RunRecord,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { startAnthropicStub } from '../agent/test-support/anthropic-stub.js';

const CLI_ENTRY = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const CLOSED_PORT = 'http://127.0.0.1:9';
const DATED = 'claude-x-20260101';

const C3B =
  'Error: --prompt-cache sets caching only for Anthropic; Realm asks OpenAI for no caching, so the flag would change nothing. ' +
  'Remove --prompt-cache, or use --provider anthropic with an Anthropic model.';
const C3E = (id: string) =>
  `Error: --prompt-cache has nothing to apply to: workflow '${id}' has no agent step that sends its instructions in one request ` +
  '(steps that call tools are not cached yet), so the flag would change nothing. Remove --prompt-cache; it applies once the ' +
  'workflow has an agent step without tools.';

const AGENT_WF = [
  'id: prompt-cache-600',
  'name: Prompt cache 600',
  'version: 1',
  'steps:',
  '  ask:',
  '    description: Answer with a short summary.',
  '    execution: agent',
  '',
].join('\n');
/** No agent step: one engine step whose handler is not registered (the drive blocks on it). */
const NO_AGENT_WF = [
  'id: prompt-cache-600-auto',
  'name: Prompt cache 600 auto',
  'version: 1',
  'steps:',
  '  publish:',
  '    description: Publish.',
  '    execution: auto',
  '    handler: publish_answer',
  '',
].join('\n');
/** Every agent step calls tools. */
const ALL_TOOLS_WF = [
  'id: prompt-cache-600-tools',
  'name: Prompt cache 600 tools',
  'version: 1',
  'mcp_servers:',
  '  - id: srv',
  '    transport: stdio',
  '    command: node',
  "    args: ['-e', '0']",
  'steps:',
  '  t:',
  '    description: Use the tool.',
  '    execution: agent',
  "    tools: ['srv:op']",
  '    input_schema:',
  '      type: object',
  '',
].join('\n');
/** An engine step that blocks the drive, then an agent step after it: no model call is made. */
const BLOCKED_WF = [
  'id: prompt-cache-600-blocked',
  'name: Prompt cache 600 blocked',
  'version: 1',
  'steps:',
  '  publish:',
  '    description: Publish.',
  '    execution: auto',
  '    handler: publish_answer',
  '  ask:',
  '    description: Answer.',
  '    execution: agent',
  '    depends_on: [publish]',
  '',
].join('\n');

let root: string;
let home: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'realm-600-cli-'));
  home = join(root, 'home');
  mkdirSync(home);
  for (const [dir, text] of [
    ['wf', AGENT_WF],
    ['auto', NO_AGENT_WF],
    ['tools', ALL_TOOLS_WF],
    ['blocked', BLOCKED_WF],
  ] as const) {
    mkdirSync(join(root, dir));
    writeFileSync(join(root, dir, 'workflow.yaml'), text, 'utf8');
  }
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function env(extra: Record<string, string> = {}): Record<string, string> {
  return { PATH: process.env['PATH'] ?? '', HOME: home, ...extra };
}

type Done = { code: number | null; stdout: string; stderr: string };

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
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

const runsDir = () => join(home, '.realm', 'runs');
function runFiles(): string[] {
  if (!existsSync(runsDir())) return [];
  return readdirSync(runsDir()).filter((f) => f.endsWith('.json'));
}
function onlyRun(): { text: string; record: RunRecord } {
  const files = runFiles();
  expect(files, 'exactly one run file').toHaveLength(1);
  const text = readFileSync(join(runsDir(), files[0]!), 'utf8');
  return { text, record: JSON.parse(text) as RunRecord };
}
const wf = (dir: string) => ['--workflow', join(dir, 'workflow.yaml')];
const ANTHROPIC = (baseUrl: string) =>
  env({ ANTHROPIC_API_KEY: 'k-600', ANTHROPIC_BASE_URL: baseUrl });
const OPENAI = () =>
  env({
    OPENAI_API_KEY: 'k-600',
    OPENAI_BASE_URL: CLOSED_PORT,
    ANTHROPIC_BASE_URL: CLOSED_PORT,
  });

/** One drive of the agent workflow against the 200 stand-in; returns what was sent and stored. */
async function driveAgainstStandIn(extra: string[]) {
  const stub = await startAnthropicStub({
    finalContent: { summary: 'ok' },
    answeredModel: DATED,
    usage: {
      input_tokens: 20,
      output_tokens: 3,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  });
  try {
    const r = await runCli(
      ['agent', ...wf('wf'), '--model', 'claude-x', ...extra],
      ANTHROPIC(stub.baseUrl),
    );
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const { text, record } = onlyRun();
    const request = record.evidence[0]!.diagnostics!.cache!.requests[0]!;
    return { r, stub, text, request, port: new URL(stub.baseUrl).port };
  } finally {
    await stub.close();
  }
}

describe('realm agent asks Anthropic to cache, and records the ask (issue #600 PR 2)', () => {
  // G15. (a) red when an operator's drive resolves as a listen child (1h, realm listen); (b) prints
  // the system field sent, the stored request facts and the start line.
  it('G15 no flag: 5m is asked (no ttl), and the record holds lifetime, 300, false, runner_default, realm agent, the answered model, anthropic', async () => {
    const { r, stub, text, request, port } = await driveAgainstStandIn([]);
    expect(
      (stub.requests[0]!['system'] as Array<{ cache_control: unknown }>)[0]!.cache_control,
    ).toEqual({
      type: 'ephemeral',
    });
    expect({
      model: request.model,
      cache_requested: request.cache_requested,
      cache_lifetime_s: request.cache_lifetime_s,
      cache_ttl_sent: request.cache_ttl_sent,
      cache_requested_source: request.cache_requested_source,
      cache_requested_by: request.cache_requested_by,
      provider: request.provider,
      endpoint: request.endpoint,
      cache_split_offered: request.cache_split_offered,
    }).toEqual({
      model: DATED,
      cache_requested: 'lifetime',
      cache_lifetime_s: 300,
      cache_ttl_sent: false,
      cache_requested_source: 'runner_default',
      cache_requested_by: 'realm agent',
      provider: 'anthropic',
      endpoint: 'custom',
      cache_split_offered: true,
    });
    // The stand-in's address is behind ANTHROPIC_BASE_URL; no part of it is stored.
    expect({ address: text.includes('127.0.0.1'), port: text.includes(`:${port}`) }).toEqual({
      address: false,
      port: false,
    });
    expect(r.stdout).toContain(
      "Caching: Anthropic is asked to cache each step's fixed instructions for 5m (realm agent's default; turn it off with --prompt-cache off).",
    );
  }, 30_000);

  // G16. (a) red when resolveProvider drops the value; (b) prints the system field and the facts.
  it("G16 --prompt-cache 1h: ttl '1h' is sent, and the source is stated", async () => {
    const { r, stub, request } = await driveAgainstStandIn(['--prompt-cache', '1h']);
    expect(
      (stub.requests[0]!['system'] as Array<{ cache_control: unknown }>)[0]!.cache_control,
    ).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    });
    expect([
      request.cache_lifetime_s,
      request.cache_ttl_sent,
      request.cache_requested_source,
    ]).toEqual([3600, true, 'stated']);
    expect(r.stdout).toContain(
      "Caching: Anthropic is asked to cache each step's fixed instructions for 1h (set by --prompt-cache 1h).",
    );
  }, 30_000);
});

describe('realm agent refuses a setting that can never apply (issue #600 PR 2, C3)', () => {
  // G17. (a) red when the capability refusal is removed; (b) prints stderr.
  it('G17 --prompt-cache 1h --provider openai → refused, no run file; with --run-id the run is not changed', async () => {
    const r = await runCli(
      ['agent', ...wf('wf'), '--provider', 'openai', '--model', 'gpt-x', '--prompt-cache', '1h'],
      OPENAI(),
    );
    expect({ code: r.code, stderr: r.stderr.trim(), runs: runFiles() }).toEqual({
      code: 1,
      stderr: `${C3B} Nothing was started.`,
      runs: [],
    });
    const store = new JsonFileStore(runsDir());
    const { run } = await store.create({
      workflowId: 'prompt-cache-600',
      workflowVersion: 1,
      params: {},
    });
    const file = join(runsDir(), `${run.id}.json`);
    const before = readFileSync(file);
    const attach = await runCli(
      [
        'agent',
        '--run-id',
        run.id,
        '--provider',
        'openai',
        '--model',
        'gpt-x',
        '--prompt-cache',
        '1h',
      ],
      OPENAI(),
    );
    expect({ code: attach.code, stderr: attach.stderr.trim() }).toEqual({
      code: 1,
      stderr: `${C3B} If run ${run.id} exists, it was not changed.`,
    });
    expect(readFileSync(file).equals(before)).toBe(true);
  }, 30_000);

  // G18. (a) red when promptCache is dropped from the sibling condition; (b) prints stderr.
  it('G18 --provider-module with --prompt-cache → refused with the sibling message', async () => {
    const r = await runCli(
      ['agent', ...wf('wf'), '--provider-module', './p.mjs', '--prompt-cache', '5m'],
      env(),
    );
    expect({ code: r.code, stderr: r.stderr.trim(), runs: runFiles() }).toEqual({
      code: 1,
      stderr:
        'Error: --provider-module cannot be combined with --provider, --model, --base-url, --strict-base-url, or --prompt-cache',
      runs: [],
    });
  }, 30_000);

  // G19. (a) red when listen's refusal is removed (listen then starts listening); (b) prints the
  // exit code and both streams.
  it('G19 realm listen --provider openai --prompt-cache 1h → refused at startup, nothing listening', async () => {
    const r = await runCli(
      [
        'listen',
        'wf',
        '--port',
        '0',
        '--provider',
        'openai',
        '--model',
        'gpt-x',
        '--prompt-cache',
        '1h',
        '--dedup-store',
        'memory',
      ],
      OPENAI(),
    );
    expect({
      code: r.code,
      stderr: r.stderr.trim(),
      listening: r.stdout.includes('realm listen on'),
    }).toEqual({
      code: 1,
      stderr:
        'Error: --prompt-cache sets caching only for Anthropic; with --provider openai every agent realm listen starts uses OpenAI, ' +
        'which Realm asks for no caching, so the flag would change nothing. Remove --prompt-cache, or use --provider anthropic.',
      listening: false,
    });
  }, 30_000);

  // G19b, the create path. (a) red when the create-path check is removed; (b) prints stderr.
  it('G19b a workflow with no agent step, or only tool-calling ones → refused, for any stated value, off included; no run file', async () => {
    const results = [];
    for (const [dir, id, value] of [
      ['auto', 'prompt-cache-600-auto', '5m'],
      ['auto', 'prompt-cache-600-auto', 'off'],
      ['tools', 'prompt-cache-600-tools', '1h'],
    ] as const) {
      const r = await runCli(
        ['agent', ...wf(dir), '--model', 'claude-x', '--prompt-cache', value],
        ANTHROPIC(CLOSED_PORT),
      );
      results.push({
        code: r.code,
        stderr: r.stderr.trim(),
        expected: `${C3E(id)} Nothing was started.`,
      });
    }
    expect(results.map((x) => [x.code, x.stderr === x.expected ? 'refused' : x.stderr])).toEqual([
      [1, 'refused'],
      [1, 'refused'],
      [1, 'refused'],
    ]);
    expect(runFiles()).toEqual([]);
  }, 60_000);

  // G19b, the attach path. (a) red when the attach-path check runs after resolveRunAttach (the
  // extensions_load_failed run is re-opened, so its file changes) or is removed; (b) prints stderr
  // and whether each file is unchanged.
  it('G19b --run-id of such a run → refused before anything is changed, an extensions_load_failed run included', async () => {
    const definition = {
      id: 'prompt-cache-600-auto',
      name: 'Prompt cache 600 auto',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: { publish: { description: 'Publish.', execution: 'auto', handler: 'publish_answer' } },
    } as unknown as WorkflowDefinition;
    await new JsonWorkflowStore(join(home, '.realm', 'workflows')).register(definition);
    const store = new JsonFileStore(runsDir());
    const live = (await store.create({ workflowId: definition.id, workflowVersion: 1, params: {} }))
      .run;
    const failed = (
      await store.create({ workflowId: definition.id, workflowVersion: 1, params: {} })
    ).run;
    await store.update({
      ...failed,
      terminal_state: true,
      terminal_reason: 'extensions_load_failed',
      sealed_by: { arm: 'extensions_load_failure' },
    } as RunRecord);
    const seen = [];
    for (const run of [live, failed]) {
      const file = join(runsDir(), `${run.id}.json`);
      const before = readFileSync(file);
      const r = await runCli(
        ['agent', '--run-id', run.id, '--model', 'claude-x', '--prompt-cache', '5m'],
        ANTHROPIC(CLOSED_PORT),
      );
      seen.push({
        code: r.code,
        refused:
          r.stderr.trim() ===
            `${C3E(definition.id)} If run ${run.id} exists, it was not changed.` || r.stderr.trim(),
        unchanged: readFileSync(file).equals(before),
      });
    }
    expect(seen).toEqual([
      { code: 1, refused: true, unchanged: true },
      { code: 1, refused: true, unchanged: true },
    ]);
    expect(
      (JSON.parse(readFileSync(join(runsDir(), `${failed.id}.json`), 'utf8')) as RunRecord)
        .terminal_state,
    ).toBe(true);
  }, 60_000);

  // G19b, the controls. (a) red when the flag-less command is refused, or the listen child's
  // exemption is removed; (b) prints both streams.
  it('G19b the same command without --prompt-cache is not refused; a --spawned-by-listen child given 5m is not refused and prints F4b', async () => {
    const plain = await runCli(
      ['agent', ...wf('auto'), '--model', 'claude-x'],
      ANTHROPIC(CLOSED_PORT),
    );
    expect(plain.stderr).not.toContain('--prompt-cache has nothing to apply to');
    expect(runFiles()).toHaveLength(1);
    const child = await runCli(
      [
        'agent',
        ...wf('auto'),
        '--model',
        'claude-x',
        '--prompt-cache',
        '5m',
        '--spawned-by-listen',
      ],
      ANTHROPIC(CLOSED_PORT),
    );
    expect(child.stderr).not.toContain('--prompt-cache has nothing to apply to');
    expect(child.stdout).toContain('Caching: no step is cached; this workflow has no agent step.');
    expect(runFiles()).toHaveLength(2);
  }, 60_000);
});

describe('the re-attach command and a listen child (issue #600 PR 2, C6, G22)', () => {
  const blockedCommand = (r: Done): string | undefined =>
    /re-attach \(`(realm agent --run-id \S+ [^`]*)`\)/.exec(r.stderr)?.[1];

  // (a) red when the re-attach command prints --spawned-by-listen; (b) prints the command.
  it('a listen child on Anthropic given 1h: the command repeats --prompt-cache 1h, never --spawned-by-listen', async () => {
    const r = await runCli(
      [
        'agent',
        ...wf('blocked'),
        '--provider',
        'anthropic',
        '--model',
        'claude-x',
        '--prompt-cache',
        '1h',
        '--spawned-by-listen',
      ],
      ANTHROPIC(CLOSED_PORT),
    );
    const runId = runFiles()[0]!.replace(/\.json$/, '');
    expect(blockedCommand(r), r.stderr).toBe(
      `realm agent --run-id ${runId} --provider anthropic --model claude-x --prompt-cache 1h`,
    );
  }, 30_000);

  // (a) red when the command repeats a setting the provider cannot apply; (b) prints the command
  // and the start line.
  it("a listen child that picked OpenAI, given 1h: the command does not repeat it, and the start line says listen's flag applies only to Anthropic", async () => {
    const r = await runCli(
      [
        'agent',
        ...wf('blocked'),
        '--provider',
        'openai',
        '--model',
        'gpt-x',
        '--prompt-cache',
        '1h',
        '--spawned-by-listen',
      ],
      OPENAI(),
    );
    const runId = runFiles()[0]!.replace(/\.json$/, '');
    expect(blockedCommand(r), r.stderr).toBe(
      `realm agent --run-id ${runId} --provider openai --model gpt-x`,
    );
    expect(r.stdout).toContain(
      'Caching: Realm asks OpenAI for no caching; any caching it does is its own. realm listen --prompt-cache 1h applies only to Anthropic.',
    );
  }, 30_000);

  // (a) red when the command repeats the runner's default; (b) prints the command.
  it('no flag: the command never repeats the default', async () => {
    const r = await runCli(
      ['agent', ...wf('blocked'), '--model', 'claude-x'],
      ANTHROPIC(CLOSED_PORT),
    );
    const runId = runFiles()[0]!.replace(/\.json$/, '');
    expect(blockedCommand(r), r.stderr).toBe(`realm agent --run-id ${runId} --model claude-x`);
  }, 30_000);
});
