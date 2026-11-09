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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  type RunRecord,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { startAnthropicStub } from '../agent/test-support/anthropic-stub.js';
import { makeTempHome, type TempHome, runIds } from '../test-support/temp-home.js';

const CLI_ENTRY = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const CLOSED_PORT = 'http://127.0.0.1:9';
const DATED = 'claude-x-20260101';

const C3E = (id: string) =>
  `Error: --prompt-cache has nothing to apply to: workflow '${id}' has no agent step, so the flag would change nothing. ` +
  'Remove --prompt-cache.';

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
let h: TempHome & { readonly root: string };
let home: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'realm-600-cli-'));
  h = await makeTempHome();
  home = h.root;
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

afterEach(async () => {
  await h.cleanup();
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

/** caching 3-B (D4): the start line of an OpenAI drive to a custom endpoint given `long`. */
const OPENAI_CUSTOM_LONG =
  "Caching: this endpoint caches by its own rules; Realm sends a cache key that helps repeated steps reach the same cache (this endpoint treats it as a hint). Realm cannot set this endpoint's lifetime or turn its caching off. --prompt-cache long sets no lifetime on this endpoint.";

/** The runs on the handle's home, by id, read through its store (#616 PR-2c, c0). */
async function runFiles(): Promise<string[]> {
  return runIds(h.home.runStore);
}
/** The one run and its record's text, read through the handle's store. */
async function onlyRun(): Promise<{ text: string; record: RunRecord }> {
  const files = await runFiles();
  expect(files, 'exactly one run file').toHaveLength(1);
  const { record } = await h.home.runStore.get(files[0]!);
  return { text: JSON.stringify(record), record };
}
const wf = (dir: string) => ['--workflow', join(dir, 'workflow.yaml')];
/** stderr's first line when it is the C3E refusal of workflow `id`, else `'not the refusal'`. */
const notTheRefusal = (stderr: string, id: string): string => {
  const first = stderr.trim().split('\n')[0] ?? '';
  return first.startsWith(C3E(id)) ? first : 'not the refusal';
};
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
    const { text, record } = await onlyRun();
    const request = record.evidence[0]!.diagnostics!.cache!.requests[0]!;
    return { r, stub, text, request, port: new URL(stub.baseUrl).port };
  } finally {
    await stub.close();
  }
}

describe('realm agent asks Anthropic to cache, and records the ask (issue #600 PR 2)', () => {
  // G15. (a) red when an operator's drive resolves as a listen child (its long prior, realm listen),
  // or `auto`'s basis is not recorded; (b) prints the system field sent, the stored request facts
  // and the start line.
  it('G15 no flag: auto asks for the short lifetime (no ttl), and the record holds lifetime, 300, false, runner_default, realm agent, cache_auto no_measurement, the answered model, anthropic', async () => {
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
      cache_auto: request.cache_auto,
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
      cache_auto: { basis: 'no_measurement' },
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
      "Caching: Anthropic is asked to cache each step's fixed instructions and the stable start of its prompt for 5 minutes (auto: a drive realm agent starts on its own has no trigger history; realm agent's default; turn it off with --prompt-cache off).",
    );
  }, 30_000);

  // G16. (a) red when resolveProvider drops the value; (b) prints the system field and the facts.
  it("G16 --prompt-cache long: ttl '1h' is sent, the source is stated, and no cache_auto is recorded", async () => {
    const { r, stub, request } = await driveAgainstStandIn(['--prompt-cache', 'long']);
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
      request.cache_auto,
    ]).toEqual([3600, true, 'stated', undefined]);
    expect(r.stdout).toContain(
      "Caching: Anthropic is asked to cache each step's fixed instructions and the stable start of its prompt for 1 hour (set by --prompt-cache long).",
    );
  }, 30_000);
});

describe('realm agent refuses a setting that can never apply (issue #600 PR 2, C3)', () => {
  // G17, caching 3-B (row 4): ACCEPTED — OpenAI applies the setting (it decides the cache key).
  // (a) red when the refusal is put back; (b) prints whether it refused, the run files and the
  // start line's verdict. The stand-in endpoint is OPENAI_BASE_URL's closed port: custom, so the
  // stated `long` sends the key and says it sets no lifetime there.
  it('G17 --prompt-cache long --provider openai → accepted: the drive starts, its start line says the key goes to this endpoint', async () => {
    const r = await runCli(
      ['agent', ...wf('wf'), '--provider', 'openai', '--model', 'gpt-x', '--prompt-cache', 'long'],
      OPENAI(),
    );
    expect({
      refused: r.stderr.includes('sets caching only'),
      runs: (await runFiles()).length,
      startLine: r.stdout.includes(OPENAI_CUSTOM_LONG),
    }).toEqual({ refused: false, runs: 1, startLine: true });
  }, 30_000);

  // G18. (a) red when promptCache is dropped from the sibling condition; (b) prints stderr.
  it('G18 --provider-module with --prompt-cache → refused with the sibling message', async () => {
    const r = await runCli(
      ['agent', ...wf('wf'), '--provider-module', './p.mjs', '--prompt-cache', 'short'],
      env(),
    );
    expect({ code: r.code, stderr: r.stderr.trim(), runs: await runFiles() }).toEqual({
      code: 1,
      stderr:
        'Error: --provider-module cannot be combined with --provider, --model, --base-url, --strict-base-url, --prompt-cache, or --cache-diagnostics on',
      runs: [],
    });
  }, 30_000);

  // G19, caching 3-B (row 5): ACCEPTED — listen no longer refuses the flag; it goes on to read the
  // workflows (this fixture's has no trigger block, so it stops THERE, after the old refusal's
  // place). The caching line's words are pinned by `listen.test.ts` (listenCachingFacts). (a) red
  // when listen's refusal is put back; (b) prints both checks and stderr's first line.
  it('G19 realm listen --provider openai --prompt-cache long → accepted: listen goes on to read its workflows', async () => {
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
        'long',
        '--dedup-store',
        'memory',
      ],
      OPENAI(),
    );
    expect({
      refused: r.stderr.includes('sets caching only'),
      readWorkflows: r.stderr.includes('no workflows with a trigger'),
      first: r.stderr.trim().split('\n')[0],
    }).toEqual({
      refused: false,
      readWorkflows: true,
      first: expect.any(String),
    });
  }, 30_000);

  // G19b, the create path. (a) red when the create-path check is removed; (b) prints stderr.
  it('G19b a workflow with no agent step → refused, for any stated value, off included; no run file', async () => {
    const results = [];
    for (const [dir, id, value] of [
      ['auto', 'prompt-cache-600-auto', 'short'],
      ['auto', 'prompt-cache-600-auto', 'off'],
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
    ]);
    expect(await runFiles()).toEqual([]);
  }, 60_000);

  // M11 (issue #899), the create path: a workflow whose every agent step calls tools now has a
  // step to apply the setting to. (a) red when the refusal reads `singleShot > 0` again; (b) prints
  // the exit code, the first line of stderr and the run-file count.
  it('M11 create — a workflow whose every agent step calls tools, with --prompt-cache long → not refused; the run starts', async () => {
    const r = await runCli(
      ['agent', ...wf('tools'), '--model', 'claude-x', '--prompt-cache', 'long'],
      ANTHROPIC(CLOSED_PORT),
    );
    expect({
      code: r.code,
      stderr: notTheRefusal(r.stderr, 'prompt-cache-600-tools'),
      runFiles: (await runFiles()).length,
    }).toEqual({ code: r.code, stderr: 'not the refusal', runFiles: 1 });
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
    await h.home.workflowStore.register(definition);
    const store = h.home.runStore;
    const live = (await store.create({ workflowId: definition.id, workflowVersion: 1, params: {} }))
      .record;
    const failed = (
      await store.create({ workflowId: definition.id, workflowVersion: 1, params: {} })
    ).record;
    await store.update({
      ...failed,
      terminal_state: true,
      terminal_reason: 'extensions_load_failed',
      sealed_by: { arm: 'extensions_load_failure' },
    } as RunRecord);
    const seen = [];
    for (const run of [live, failed]) {
      const before = JSON.stringify((await h.home.runStore.get(run.id)).record);
      const r = await runCli(
        ['agent', '--run-id', run.id, '--model', 'claude-x', '--prompt-cache', 'short'],
        ANTHROPIC(CLOSED_PORT),
      );
      seen.push({
        code: r.code,
        refused:
          r.stderr.trim() ===
            `${C3E(definition.id)} If run ${run.id} exists, it was not changed.` || r.stderr.trim(),
        unchanged: JSON.stringify((await h.home.runStore.get(run.id)).record) === before,
      });
    }
    expect(seen).toEqual([
      { code: 1, refused: true, unchanged: true },
      { code: 1, refused: true, unchanged: true },
    ]);
    expect((await h.home.runStore.get(failed.id)).record.terminal_state).toBe(true);
  }, 60_000);

  // M11 (issue #899), the attach path: --run-id of a run of a workflow whose every agent step calls
  // tools is not refused, and the drive attaches (the run file changes). (a) red when the refusal
  // reads `singleShot > 0` again; (b) prints the exit code, the first line of stderr, the run-file
  // count and whether the run file changed.
  it('M11 attach — --run-id of a run whose every agent step calls tools, with --prompt-cache long → not refused; the drive attaches', async () => {
    const definition = {
      id: 'prompt-cache-600-tools',
      name: 'Prompt cache 600 tools',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      mcp_servers: [{ id: 'srv', transport: 'stdio', command: 'node', args: ['-e', '0'] }],
      steps: {
        t: {
          description: 'Use the tool.',
          execution: 'agent',
          tools: ['srv:op'],
          input_schema: { type: 'object' },
        },
      },
    } as unknown as WorkflowDefinition;
    await h.home.workflowStore.register(definition);
    const store = h.home.runStore;
    const run = (await store.create({ workflowId: definition.id, workflowVersion: 1, params: {} }))
      .record;
    const before = JSON.stringify((await store.get(run.id)).record);
    const r = await runCli(
      ['agent', '--run-id', run.id, '--model', 'claude-x', '--prompt-cache', 'long'],
      ANTHROPIC(CLOSED_PORT),
    );
    expect({
      code: r.code,
      stderr: notTheRefusal(r.stderr, definition.id),
      runFiles: (await runFiles()).length,
      changed: JSON.stringify((await store.get(run.id)).record) !== before,
    }).toEqual({ code: r.code, stderr: 'not the refusal', runFiles: 1, changed: true });
  }, 60_000);

  // G19b, the controls. (a) red when the flag-less command is refused, or the listen child's
  // exemption is removed; (b) prints both streams.
  it('G19b the same command without --prompt-cache is not refused; a --spawned-by-listen child given short is not refused and prints F4b', async () => {
    const plain = await runCli(
      ['agent', ...wf('auto'), '--model', 'claude-x'],
      ANTHROPIC(CLOSED_PORT),
    );
    expect(plain.stderr).not.toContain('--prompt-cache has nothing to apply to');
    expect(await runFiles()).toHaveLength(1);
    const child = await runCli(
      [
        'agent',
        ...wf('auto'),
        '--model',
        'claude-x',
        '--prompt-cache',
        'short',
        '--spawned-by-listen',
      ],
      ANTHROPIC(CLOSED_PORT),
    );
    expect(child.stderr).not.toContain('--prompt-cache has nothing to apply to');
    expect(child.stdout).toContain('Caching: no step is cached; this workflow has no agent step.');
    expect(await runFiles()).toHaveLength(2);
  }, 60_000);
});

describe('the re-attach command and a listen child (issue #600 PR 2, C6, G22)', () => {
  const blockedCommand = (r: Done): string | undefined =>
    /re-attach \(`(realm agent --run-id \S+ [^`]*)`\)/.exec(r.stderr)?.[1];

  // (a) red when the re-attach command prints --spawned-by-listen; (b) prints the command.
  it('a listen child on Anthropic given long: the command repeats --prompt-cache long, never --spawned-by-listen', async () => {
    const r = await runCli(
      [
        'agent',
        ...wf('blocked'),
        '--provider',
        'anthropic',
        '--model',
        'claude-x',
        '--prompt-cache',
        'long',
        '--spawned-by-listen',
      ],
      ANTHROPIC(CLOSED_PORT),
    );
    const runId = (await runFiles())[0]!;
    expect(blockedCommand(r), r.stderr).toBe(
      `realm agent --run-id ${runId} --provider anthropic --model claude-x --prompt-cache long`,
    );
  }, 30_000);

  // caching 3-B (row 1): OpenAI applies the setting now, so the command repeats it. (a) red when
  // the command drops a setting OpenAI applies, or the start line keeps the old words; (b) prints
  // the command and the start line's verdict.
  it('a listen child that picked OpenAI, given long: the command repeats --prompt-cache long, and the start line says the key goes to this endpoint', async () => {
    const r = await runCli(
      [
        'agent',
        ...wf('blocked'),
        '--provider',
        'openai',
        '--model',
        'gpt-x',
        '--prompt-cache',
        'long',
        '--spawned-by-listen',
      ],
      OPENAI(),
    );
    const runId = (await runFiles())[0]!;
    expect(blockedCommand(r), r.stderr).toBe(
      `realm agent --run-id ${runId} --provider openai --model gpt-x --prompt-cache long`,
    );
    expect(r.stdout).toContain(OPENAI_CUSTOM_LONG);
  }, 30_000);

  // caching 3-B (row 1): OpenAI's re-attach and Go on: lines on a drive the operator started.
  // (a) red when the command drops the stated setting; (b) prints the command.
  it('an OpenAI drive given long: the re-attach command repeats --prompt-cache long', async () => {
    const r = await runCli(
      [
        'agent',
        ...wf('blocked'),
        '--provider',
        'openai',
        '--model',
        'gpt-x',
        '--prompt-cache',
        'long',
      ],
      OPENAI(),
    );
    const runId = (await runFiles())[0]!;
    expect(blockedCommand(r), r.stderr).toBe(
      `realm agent --run-id ${runId} --provider openai --model gpt-x --prompt-cache long`,
    );
  }, 30_000);

  // (a) red when the command repeats the runner's default; (b) prints the command.
  it('guard: no flag: the command never repeats the default', async () => {
    const r = await runCli(
      ['agent', ...wf('blocked'), '--model', 'claude-x'],
      ANTHROPIC(CLOSED_PORT),
    );
    const runId = (await runFiles())[0]!;
    expect(blockedCommand(r), r.stderr).toBe(`realm agent --run-id ${runId} --model claude-x`);
  }, 30_000);
});

describe('realm agent --cache-diagnostics: a flag that cannot act is refused at load (caching 3-M B2b)', () => {
  const KEY = () => env({ ANTHROPIC_API_KEY: 'k-600' });
  const BOTH_KEYS = () =>
    env({
      ANTHROPIC_API_KEY: 'k-600',
      OPENAI_API_KEY: 'k-600',
      OPENAI_BASE_URL: CLOSED_PORT,
      ANTHROPIC_BASE_URL: CLOSED_PORT,
    });
  const ACTS = 'has nothing to act on';
  const COMBINED = 'cannot be combined';
  const refused = (why: string, remedy: string): string =>
    `Error: --cache-diagnostics on has nothing to act on: ${why} ${remedy}`;
  const OTHER_PROVIDER = refused(
    'only Anthropic answers this question, and this drive uses openai.',
    'Remove --cache-diagnostics, or use --provider anthropic.',
  );
  const NO_CACHING = refused(
    '--prompt-cache off asks for no caching, so no request can miss.',
    'Remove --cache-diagnostics, or choose another --prompt-cache.',
  );
  const OTHER_ADDRESS = refused(
    "only Anthropic's own address answers this question, and ANTHROPIC_BASE_URL points elsewhere.",
    'Remove --cache-diagnostics, or unset ANTHROPIC_BASE_URL.',
  );
  const noAgentStep = (id: string): string =>
    refused(
      `workflow '${id}' has no agent step, so the flag would change nothing.`,
      'Remove --cache-diagnostics.',
    );
  const STARTED = 'Nothing was started.';
  const notChanged = (id: string): string => `If run ${id} exists, it was not changed.`;
  const AUTO_ID = 'prompt-cache-600-auto';
  const NO_RUN = 'run_b2b_none';

  /** Registers a workflow with no agent step and returns a run of it (G19b's form). */
  async function registeredNoAgentRun(): Promise<string> {
    const definition = {
      id: AUTO_ID,
      name: 'Prompt cache 600 auto',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: { publish: { description: 'Publish.', execution: 'auto', handler: 'publish_answer' } },
    } as unknown as WorkflowDefinition;
    await h.home.workflowStore.register(definition);
    const { record } = await h.home.runStore.create({
      workflowId: definition.id,
      workflowVersion: 1,
      params: {},
    });
    return record.id;
  }

  // Check 3. Real case: an operator states `on` where nothing can answer, and believes it worked.
  // Every drive uses a workflow that blocks before any model call, so no provider is reached.
  // (a) red when a branch is removed (its `on` row), when the rule reads `--provider` instead of the
  // chosen provider (the keys row), or when a refusal fires without its reason (its `off` half);
  // (b) prints the argv, the exit code, the message and the run count.
  it.each([
    {
      name: '--provider openai',
      args: [...wf('blocked'), '--provider', 'openai', '--model', 'gpt-x'],
      childEnv: OPENAI,
      words: `${OTHER_PROVIDER} ${STARTED}`,
    },
    {
      name: 'no --provider with both keys set: the keys choose OpenAI',
      args: [...wf('blocked'), '--model', 'gpt-x'],
      childEnv: BOTH_KEYS,
      words: `${OTHER_PROVIDER} ${STARTED}`,
    },
    {
      name: '--provider openai --model o1: a model that routes to openai-reasoning',
      args: [...wf('blocked'), '--provider', 'openai', '--model', 'o1'],
      childEnv: OPENAI,
      words: `${OTHER_PROVIDER} ${STARTED}`,
    },
    {
      name: '--prompt-cache off, no address set',
      args: [...wf('blocked'), '--model', 'claude-x', '--prompt-cache', 'off'],
      childEnv: KEY,
      words: `${NO_CACHING} ${STARTED}`,
    },
    {
      name: 'a workflow with no agent step, no address set',
      args: [...wf('auto'), '--model', 'claude-x'],
      childEnv: KEY,
      words: `${noAgentStep(AUTO_ID)} ${STARTED}`,
    },
    {
      name: '--run-id with --provider openai: the other closing sentence',
      args: ['--run-id', NO_RUN, '--provider', 'openai', '--model', 'gpt-x'],
      childEnv: OPENAI,
      words: `${OTHER_PROVIDER} ${notChanged(NO_RUN)}`,
    },
  ])(
    '$name: on is refused with its reason and starts nothing; off is accepted',
    async ({ args, childEnv, words }) => {
      const on = await runCli(['agent', ...args, '--cache-diagnostics', 'on'], childEnv());
      const runs = (await runFiles()).length;
      const off = await runCli(['agent', ...args, '--cache-diagnostics', 'off'], childEnv());
      expect({
        args,
        code: on.code,
        message: on.stderr.trim(),
        runs,
        offRefused: off.stderr.includes(ACTS) || off.stderr.includes(COMBINED),
      }).toEqual({ args, code: 1, message: words, runs: 0, offRefused: false });
    },
    60_000,
  );

  // Check 3, a custom address: read from the built provider. (a) red when the address branch is
  // removed; (b) prints the exit code, the message, the runs and the requests the stand-in received.
  it('ANTHROPIC_BASE_URL at the stand-in: on is refused, no request and no run; off is accepted', async () => {
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
      const args = [...wf('blocked'), '--model', 'claude-x'];
      const on = await runCli(
        ['agent', ...args, '--cache-diagnostics', 'on'],
        ANTHROPIC(stub.baseUrl),
      );
      const runs = (await runFiles()).length;
      const off = await runCli(
        ['agent', ...args, '--cache-diagnostics', 'off'],
        ANTHROPIC(stub.baseUrl),
      );
      expect({
        code: on.code,
        message: on.stderr.trim(),
        runs,
        offRefused: off.stderr.includes(ACTS),
        requests: stub.requests.length,
      }).toEqual({
        code: 1,
        message: `${OTHER_ADDRESS} ${STARTED}`,
        runs: 0,
        offRefused: false,
        requests: 0,
      });
    } finally {
      await stub.close();
    }
  }, 60_000);

  // Check 3, --provider-module: the sentence has no closing sentence, today or now. (a) red when
  // `--cache-diagnostics on` is dropped from the condition, or `off` is caught by it; (b) prints the
  // exit code and the message.
  it('--provider-module: on is refused with the sibling sentence; off passes that check', async () => {
    const args = [...wf('blocked'), '--provider-module', './p.mjs'];
    const on = await runCli(['agent', ...args, '--cache-diagnostics', 'on'], env());
    const off = await runCli(['agent', ...args, '--cache-diagnostics', 'off'], env());
    expect({
      code: on.code,
      message: on.stderr.trim(),
      runs: (await runFiles()).length,
      offRefused: off.stderr.includes(COMBINED),
    }).toEqual({
      code: 1,
      message:
        'Error: --provider-module cannot be combined with --provider, --model, --base-url, --strict-base-url, --prompt-cache, or --cache-diagnostics on',
      runs: 0,
      offRefused: false,
    });
  }, 60_000);

  // Check 3, --run-id of a registered run with no agent step: a separate site. (a) red when the
  // --run-id guard is not widened (the drive attaches); (b) prints the exit code, the message and
  // whether the run changed.
  it('--run-id of a run with no agent step: on is refused and the run is unchanged; off is accepted', async () => {
    const id = await registeredNoAgentRun();
    const before = JSON.stringify((await h.home.runStore.get(id)).record);
    const args = ['--run-id', id, '--model', 'claude-x'];
    const on = await runCli(['agent', ...args, '--cache-diagnostics', 'on'], KEY());
    const unchanged = JSON.stringify((await h.home.runStore.get(id)).record) === before;
    const off = await runCli(['agent', ...args, '--cache-diagnostics', 'off'], KEY());
    expect({
      code: on.code,
      message: on.stderr.trim(),
      unchanged,
      offRefused: off.stderr.includes(ACTS),
    }).toEqual({
      code: 1,
      message: `${noAgentStep(AUTO_ID)} ${notChanged(id)}`,
      unchanged: true,
      offRefused: false,
    });
  }, 60_000);

  // Check 3, the accepted direction. No address is set, and the workflow blocks before any model
  // call, so accepted means one run and no refusal line; the blocked drive itself exits 1.
  // (a) red when `on` is refused for a setting that can act; (b) prints the setting and what ran.
  it.each([
    [[]],
    [['--prompt-cache', 'auto']],
    [['--prompt-cache', 'short']],
    [['--prompt-cache', 'long']],
  ])(
    "on at Anthropic's own address, with %j: accepted",
    async (extra: string[]) => {
      const r = await runCli(
        ['agent', ...wf('blocked'), '--model', 'claude-x', '--cache-diagnostics', 'on', ...extra],
        KEY(),
      );
      expect({
        extra,
        refused: r.stderr.includes(ACTS),
        code: r.code,
        runs: (await runFiles()).length,
      }).toEqual({ extra, refused: false, code: 1, runs: 1 });
    },
    30_000,
  );

  // Check 4. Real case: listen has already answered 202, so a refusal would exit a child and leave
  // the run undriven. (a) red when the exemption is missing on one branch; (b) prints the row, the
  // first line of stderr and the run count.
  it.each([
    ['on OpenAI', [...wf('blocked'), '--provider', 'openai', '--model', 'gpt-x'], OPENAI],
    [
      'ANTHROPIC_BASE_URL set',
      [...wf('blocked'), '--model', 'claude-x'],
      () => ANTHROPIC(CLOSED_PORT),
    ],
    ['--prompt-cache off', [...wf('blocked'), '--model', 'claude-x', '--prompt-cache', 'off'], KEY],
    ['a workflow with no agent step', [...wf('auto'), '--model', 'claude-x'], KEY],
  ] as const)(
    '--spawned-by-listen, %s: not refused',
    async (name, args, childEnv) => {
      const r = await runCli(
        ['agent', ...args, '--cache-diagnostics', 'on', '--spawned-by-listen'],
        childEnv(),
      );
      expect({
        name,
        refused: r.stderr.includes(ACTS),
        first: r.stderr.includes(ACTS) ? r.stderr.trim().split('\n')[0] : '',
        runs: (await runFiles()).length,
      }).toEqual({ name, refused: false, first: '', runs: 1 });
    },
    30_000,
  );
});
