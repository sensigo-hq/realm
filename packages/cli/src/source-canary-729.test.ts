// #729 PR-3 — the source-canary proof suite (RECORD 05 "the proof", I3; prompt 04 "The proof first").
//
// Canaries are planted at the SOURCES, one per tier and source field: a declared secret (the
// project's `.env`, named by its `realm.yaml`), an environment value, a value under a credential's
// name (`api_token`) and a value after an anchor (`Bearer `), each in a run's params, a step's output,
// a failed step's error, and an open question's preview; and, in the question's text, an environment
// value (allowed whole there, R2) and a declared one (never). The runs are made by the real engine.
// Real flows are then driven on each door, and EVERY egress byte is captured: `realm run inspect`'s
// stdout and stderr, `realm run export`'s file, the MCP messages and stderr of `realm mcp` (stdio)
// and `realm serve` (HTTP), the Slack bodies, and `realm agent`'s provider requests and its output
// in log mode. Every value is fake. A failure prints the door and the leaked canaries' LABELS
// (tier/field), never a canary.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  JsonFileStore,
  ExtensionRegistry,
  JsonWorkflowStore,
  executeChain,
  executeStep,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startAnthropicStub } from './agent/test-support/anthropic-stub.js';
import { postGateViaApi } from './agent/gate/slack-gate-notifier.js';
import { addDeclaredDisclosure, installWriter, writerTestSeams } from './output/writer.js';

const CLI_ENTRY = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const FIELDS = ['PARAMS', 'OUTPUT', 'ERROR', 'PREVIEW', 'PROMPT', 'WEBHOOK'] as const;
const TIERS = ['DECL', 'ENV', 'NAME', 'ANCH'] as const;
type Field = (typeof FIELDS)[number];
type Tier = (typeof TIERS)[number];

/** The canary of one tier in one field: fake, 8+ characters, no pattern meaning of its own. */
const canary = (tier: Tier, field: Field): string => `FAKECAN${tier}${field}0729`;
/** The question's own canaries: an environment value (allowed there) and a declared one. */
const Q_ENV = 'FAKECANQUESTIONENV0729';
const Q_DECL = 'FAKECANQUESTIONDECL0729';
/** SC-F6: the environment value a tool server writes to its stderr. */
const TOOL_CANARY = 'FAKECANENVTOOLSTDERR0729';

/** Every canary that must never leave, with its label. */
const FORBIDDEN: Array<{ label: string; value: string }> = [
  ...FIELDS.flatMap((f) => TIERS.map((t) => ({ label: `${t}/${f}`, value: canary(t, f) }))),
  { label: 'DECL/QUESTION', value: Q_DECL },
];
const leaked = (bytes: string): string[] =>
  FORBIDDEN.filter((c) => bytes.includes(c.value)).map((c) => c.label);

/** The four tiers of one field, as the source holds them. */
const planted = (f: Field): Record<string, unknown> => ({
  text: `${canary('DECL', f)} ${canary('ENV', f)}`,
  api_token: canary('NAME', f),
  auth: `Bearer ${canary('ANCH', f)}`,
});

let root: string;
let home: string;
let project: string;
let childEnv: Record<string, string>;
let gateRun: string;
let failedRun: string;
let agentRun: string;
let definition: WorkflowDefinition;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'realm-canary-729-'));
  home = join(root, 'home');
  project = join(root, 'project');
  mkdirSync(join(home, '.realm'), { recursive: true });
  mkdirSync(project);
  // The declared tier: the project's `.env`, named by its manifest.
  const declared: Record<string, string> = Object.fromEntries([
    ...FIELDS.map((f) => [`D_${f}`, canary('DECL', f)]),
    ['D_QUESTION', Q_DECL],
  ]);
  writeFileSync(
    join(project, 'realm.yaml'),
    `version: 1\nadapters:\n  svc:\n    use: github\n    config:\n${Object.keys(declared)
      .map((k) => `      ${k.toLowerCase()}: "\${secret:${k}}"`)
      .join('\n')}\n`,
    'utf8',
  );
  writeFileSync(
    join(project, '.env'),
    Object.entries(declared)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n') + '\n',
    'utf8',
  );
  // The environment tier: every door's process environment.
  childEnv = {
    PATH: process.env['PATH'] ?? '',
    HOME: home,
    NO_COLOR: '1',
    REALM_NOT_SECRET: 'HOME',
    ...Object.fromEntries(FIELDS.map((f) => [`CAN_ENV_${f}`, canary('ENV', f)])),
    CAN_Q_ENV: Q_ENV,
  };
  definition = {
    id: 'canary',
    name: 'canary',
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    trust_root: project,
    source_dir: project,
    steps: {
      a: {
        description: 'A.',
        execution: 'agent',
        depends_on: [],
        prompt: 'Summarise {{ run.params.prompt_text }}, key {{ run.params.prompt_key }}.',
      },
      g: {
        description: 'G.',
        execution: 'auto',
        trust: 'human_confirmed',
        depends_on: ['a'],
        gate: {
          choices: ['approve', 'reject'],
          message: 'Approve {{ run.params.q_env }} and {{ run.params.q_decl }}?',
        },
      },
    },
  } as WorkflowDefinition;
  const workflows = new JsonWorkflowStore(join(home, '.realm', 'workflows'));
  await workflows.register(definition);
  // The agent's run: the same prompt step, and no question after it, so the drive ends by itself.
  await workflows.register({
    ...definition,
    id: 'canary-agent',
    steps: { a: definition.steps['a']! },
  } as WorkflowDefinition);
  const store = new JsonFileStore(join(home, '.realm', 'runs'));
  const params = {
    ...planted('PARAMS'),
    q_env: Q_ENV,
    q_decl: Q_DECL,
    prompt_text: `${canary('DECL', 'PROMPT')} ${canary('ENV', 'PROMPT')}`,
    prompt_key: `Bearer ${canary('ANCH', 'PROMPT')} api_token=${canary('NAME', 'PROMPT')}`,
  };
  // An open question: params, a step's output, the gate's preview and question.
  gateRun = (await store.create({ workflowId: 'canary', workflowVersion: 1, params })).run.id;
  await executeStep(store, definition, {
    runId: gateRun,
    command: 'a',
    input: planted('OUTPUT'),
    dispatcher: async (_c, input) => input,
  });
  await executeStep(store, definition, {
    runId: gateRun,
    command: 'g',
    input: {},
    dispatcher: async () => planted('PREVIEW'),
  });
  // A failed step: its error.
  failedRun = (await store.create({ workflowId: 'canary', workflowVersion: 1, params })).run.id;
  await executeStep(store, definition, {
    runId: failedRun,
    command: 'a',
    input: {},
    dispatcher: async () => {
      const p = planted('ERROR');
      throw new Error(
        `failed: ${String(p['text'])} api_token=${String(p['api_token'])} ${String(p['auth'])}`,
      );
    },
  }).catch(() => undefined);
  // An agent step ready: the prompt.
  agentRun = (await store.create({ workflowId: 'canary-agent', workflowVersion: 1, params })).run
    .id;
}, 60_000);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function cli(args: string[], env: Record<string, string> = childEnv, cwd = project) {
  const r = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 60_000,
  });
  return `${r.stdout}\n${r.stderr}`;
}

/** A CLI run that does not block this process (the stub provider answers from it). */
function cliAsync(args: string[], env: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], { cwd: project, env });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    const timer = setTimeout(() => child.kill(), 50_000);
    child.on('error', reject);
    child.on('close', () => {
      clearTimeout(timer);
      resolve(out);
    });
  });
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

async function mcpReads(client: Client): Promise<string> {
  const texts: string[] = [];
  for (const run_id of [gateRun, failedRun]) {
    const r = (await client.callTool({
      name: 'get_run_state',
      arguments: { run_id, include_steps: true },
    })) as { content: Array<{ text: string }> };
    texts.push(...r.content.map((c) => c.text));
  }
  return texts.join('\n');
}

describe('#729 PR-3 — no canary leaves any door', () => {
  it('the sources hold every canary (non-vacuity): the run files carry them raw', () => {
    const files = [gateRun, failedRun].map((id) =>
      readFileSync(join(home, '.realm', 'runs', `${id}.json`), 'utf8'),
    );
    // The prompt's canaries reach the model only; the webhook's arrive with listen's request (its
    // own cell checks they reach the stored run).
    const held = FORBIDDEN.filter(
      (c) =>
        !c.label.endsWith('/PROMPT') &&
        !c.label.endsWith('/WEBHOOK') &&
        c.label !== 'DECL/QUESTION',
    )
      .filter((c) => !files.some((f) => f.includes(c.value)))
      .map((c) => c.label);
    // (a) red when a source stops holding its canary (the suite would pass vacuously); (b) prints
    //     the labels missing from the run files.
    expect(held).toEqual([]);
  });

  it('realm run inspect (stdout and stderr)', () => {
    // Run from outside the project: there the CLI loads the project's `.env` into its environment,
    // and the environment sweep would hide the declared canaries whatever the manifest read did.
    const bytes =
      cli(['run', 'inspect', gateRun], childEnv, root) +
      cli(['run', 'inspect', failedRun], childEnv, root);
    // (a) red when the writer's pass or the run's declared part is removed from inspect; (b)
    //     prints the leaked labels.
    expect({ door: 'inspect', leaked: leaked(bytes) }).toEqual({ door: 'inspect', leaked: [] });
  });

  it('realm run export (the file)', () => {
    const out = join(root, 'export.json');
    // From outside the project, as for inspect: the declared canaries are known only by the manifest.
    const said = cli(['run', 'export', gateRun, '--out', out], childEnv, root);
    const bytes = readFileSync(out, 'utf8') + said;
    // (a) red when the bundle is not walked or the run's manifest is not read; (b) prints the
    //     leaked labels.
    expect({ door: 'export', leaked: leaked(bytes) }).toEqual({ door: 'export', leaked: [] });
  });

  it('realm mcp over stdio (every message, and stderr)', async () => {
    let stderr = '';
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI_ENTRY, 'mcp', '--project', project],
      env: childEnv,
      cwd: project,
      stderr: 'pipe',
    });
    transport.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
    const client = new Client({ name: 'canary-stdio', version: '0' });
    await client.connect(transport);
    try {
      const bytes = (await mcpReads(client)) + stderr;
      // (a) red when a reply skips toolContentOf's walk or the CLI's set; (b) prints the labels.
      expect({ door: 'mcp-stdio', leaked: leaked(bytes) }).toEqual({
        door: 'mcp-stdio',
        leaked: [],
      });
    } finally {
      await client.close();
    }
  }, 60_000);

  it('realm serve over HTTP (every message, and its output)', async () => {
    const port = await freePort();
    const child = spawn(
      process.execPath,
      [
        CLI_ENTRY,
        'serve',
        '--dev',
        '--port',
        String(port),
        '--host',
        '127.0.0.1',
        '--project',
        project,
      ],
      { env: childEnv, cwd: project, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '';
    child.stdout.on('data', (d: Buffer) => (output += d.toString()));
    child.stderr.on('data', (d: Buffer) => (output += d.toString()));
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('serve never listened')), 30_000);
        const check = (): void => {
          if (output.includes('listening on')) {
            clearTimeout(timer);
            resolve();
          }
        };
        child.stdout.on('data', check);
        child.stderr.on('data', check);
        child.on('close', () => reject(new Error('serve exited')));
      });
      const client = new Client({ name: 'canary-http', version: '0' });
      await client.connect(
        new StreamableHTTPClientTransport(
          new URL(`http://127.0.0.1:${port}/`),
        ) as unknown as Parameters<Client['connect']>[0],
      );
      const bytes = (await mcpReads(client)) + output;
      await client.close();
      // (a) red when serve's replies skip the walk or its set; (b) prints the labels.
      expect({ door: 'mcp-http', leaked: leaked(bytes) }).toEqual({ door: 'mcp-http', leaked: [] });
    } finally {
      child.kill();
    }
  }, 60_000);

  it('the Slack notifier (every body), under the writer that loaded the manifest', async () => {
    const saved = { ...process.env };
    Object.assign(process.env, childEnv);
    const bodies: string[] = [];
    const fetchSaved = globalThis.fetch;
    globalThis.fetch = (async (_u: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return { ok: true, json: async () => ({ ok: true, ts: '1.0' }) };
    }) as unknown as typeof fetch;
    try {
      installWriter('broadcast');
      addDeclaredDisclosure(
        Object.fromEntries([
          ...FIELDS.map((f) => [`D_${f}`, canary('DECL', f)]),
          ['D_QUESTION', Q_DECL],
        ]),
        undefined,
      );
      const run = await new JsonFileStore(join(home, '.realm', 'runs')).get(gateRun);
      await postGateViaApi('xoxb-fake', 'C1', run.pending_gate!, gateRun, true);
      // (a) red when the post composes from the raw gate; (b) prints the labels.
      expect({
        door: 'slack',
        leaked: leaked(bodies.join('\n')),
        questionShown: bodies.join('').includes(Q_ENV),
      }).toEqual({
        door: 'slack',
        leaked: [],
        questionShown: true,
      });
    } finally {
      writerTestSeams.reset();
      globalThis.fetch = fetchSaved;
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });

  it('realm agent (the provider requests, and its output in log mode)', async () => {
    const stub = await startAnthropicStub({ finalContent: { summary: 'done' } });
    try {
      const out = await cliAsync(
        [
          'agent',
          '--run-id',
          agentRun,
          '--provider',
          'anthropic',
          '--model',
          'fake-model',
          '--project',
          project,
          '--log-mode',
        ],
        {
          ...childEnv,
          ANTHROPIC_API_KEY: 'fake-canary-key-0000',
          ANTHROPIC_BASE_URL: stub.baseUrl,
        },
      );
      const requests = JSON.stringify(stub.requests);
      // Non-vacuity: the model was called. The run ends with one receipt line (log mode).
      // (a) red when the provider edge or the writer's log pass is removed, or log mode stops
      //     printing its one `Disclosure:` line; (b) prints the labels, a boolean and a count.
      expect({
        door: 'agent',
        requests: stub.requests.length > 0,
        leakedToModel: leaked(requests),
        leakedToLog: leaked(out),
        receiptLines: out.split('\n').filter((l) => l.startsWith('Disclosure:')).length,
      }).toEqual({
        door: 'agent',
        requests: true,
        leakedToModel: [],
        leakedToLog: [],
        receiptLines: 1,
      });
    } finally {
      await stub.close();
    }
  }, 60_000);

  it('SC-F22: under a CI-like environment, a piped inspect and the export show what each audience may', async () => {
    const ciHome = join(root, 'cihome-0729');
    const work = join(root, 'work-0729');
    const workspace = join(root, 'ws-0729');
    mkdirSync(join(ciHome, '.realm'), { recursive: true });
    mkdirSync(work);
    const CI_CANARY = 'FAKECANCIENV0729';
    const values = {
      outside: `${work}/build.log`,
      home: `${ciHome}/cache/x`,
      ws: `${workspace}/src`,
      canary: `seen ${CI_CANARY}`,
    };
    const ci: WorkflowDefinition = {
      id: 'ci-env',
      name: 'ci-env',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: Object.fromEntries(
        Object.keys(values).map((k) => [
          k,
          { description: 'S.', execution: 'agent', depends_on: [] },
        ]),
      ),
    } as WorkflowDefinition;
    await new JsonWorkflowStore(join(ciHome, '.realm', 'workflows')).register(ci);
    const store = new JsonFileStore(join(ciHome, '.realm', 'runs'));
    const runId = (await store.create({ workflowId: 'ci-env', workflowVersion: 1, params: {} })).run
      .id;
    for (const [step, v] of Object.entries(values)) {
      await executeStep(store, ci, {
        runId,
        command: step,
        input: { v },
        dispatcher: async (_c, input) => input,
      });
    }
    // A CI runner's environment: no REALM_NOT_SECRET, the user's names, the working folder outside
    // HOME, a workspace variable, an ordinary setting and a planted value.
    const env = {
      PATH: process.env['PATH'] ?? '',
      HOME: ciHome,
      USER: 'ciuser0729x',
      LOGNAME: 'ciuser0729x',
      PWD: work,
      GITHUB_WORKSPACE: workspace,
      APP_REGION: 'eu-west-1x',
      CI_CANARY,
      NO_COLOR: '1',
    };
    const inspect = spawnSync(process.execPath, [CLI_ENTRY, 'run', 'inspect', runId], {
      cwd: work,
      env,
      encoding: 'utf8',
      timeout: 60_000,
    }).stdout;
    const file = join(work, 'bundle.json');
    spawnSync(
      process.execPath,
      [CLI_ENTRY, 'run', 'export', runId, '--out', file, '--accept-partial-disclosure'],
      { cwd: work, env, encoding: 'utf8', timeout: 60_000 },
    );
    const exported = readFileSync(file, 'utf8');
    const shows = (text: string) => ({
      outside: text.includes(values.outside),
      home: text.includes(values.home),
      ws: text.includes(workspace),
      canary: text.includes(CI_CANARY),
    });
    // (a) red when PWD is swept again (the working path hides on every surface), the home path
    //     shows in a log or hides in the export, or the workspace or the canary shows; (b) prints
    //     booleans per surface (the values are this file's own fakes).
    expect({ inspect: shows(inspect), exported: shows(exported) }).toEqual({
      inspect: { outside: true, home: false, ws: false, canary: false },
      exported: { outside: true, home: true, ws: false, canary: false },
    });
  }, 60_000);

  /** `realm mcp` over stdio: every message and its stderr while `drive` runs. */
  async function overStdio(drive: (client: Client) => Promise<void>): Promise<string> {
    let stderr = '';
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI_ENTRY, 'mcp', '--project', project],
      env: childEnv,
      cwd: project,
      stderr: 'pipe',
    });
    transport.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
    const messages: string[] = [];
    const client = new Client({ name: 'canary-flow', version: '0' });
    await client.connect(transport);
    try {
      const call = client.callTool.bind(client);
      client.callTool = (async (...args: Parameters<typeof call>) => {
        const reply = await call(...args);
        messages.push(JSON.stringify(reply));
        return reply;
      }) as typeof client.callTool;
      await drive(client);
    } finally {
      await client.close();
    }
    return `${messages.join('\n')}\n${stderr}`;
  }

  it("SC-F1: a gate's instructions that interpolate the run's params reach no realm mcp message", async () => {
    const f = 'PARAMS' as const;
    await new JsonWorkflowStore(join(home, '.realm', 'workflows')).register({
      ...definition,
      id: 'canary-hint',
      steps: {
        g: {
          description: 'G.',
          execution: 'auto',
          trust: 'human_confirmed',
          depends_on: [],
          instructions:
            'Check {{ run.params.hint }} with api_token={{ run.params.hint_token }} and {{ run.params.hint_auth }}.',
          gate: { choices: ['approve', 'reject'], message: 'Approve?' },
        },
      },
    } as WorkflowDefinition);
    const bytes = await overStdio(async (client) => {
      const started = (await client.callTool({
        name: 'start_run',
        arguments: {
          workflow_id: 'canary-hint',
          params: {
            hint: `${canary('DECL', f)} ${canary('ENV', f)}`,
            hint_token: canary('NAME', f),
            hint_auth: `Bearer ${canary('ANCH', f)}`,
          },
        },
      })) as { content: Array<{ text: string }> };
      const runId = (JSON.parse(started.content[0]!.text) as { run_id: string }).run_id;
      await client.callTool({ name: 'get_run_state', arguments: { run_id: runId } });
    });
    // Non-vacuity: the reply carried the gate's hint (the author's label marks it).
    // (a) red when `agent_hint` is a fact again (the interpolated params show); (b) prints a
    //     boolean and the leaked labels.
    expect({ hinted: bytes.includes('agent_hint'), leaked: leaked(bytes) }).toEqual({
      hinted: true,
      leaked: [],
    });
  }, 60_000);

  it("SC-F2: a handler's abort message reaches no get_run_state message, piped inspect or export", async () => {
    const f = 'ERROR' as const;
    const abortDef = {
      ...definition,
      id: 'canary-abort',
      steps: { h: { description: 'H.', execution: 'auto', handler: 'aborter', depends_on: [] } },
    } as WorkflowDefinition;
    await new JsonWorkflowStore(join(home, '.realm', 'workflows')).register(abortDef);
    const store = new JsonFileStore(join(home, '.realm', 'runs'));
    const { run } = await store.create({
      workflowId: 'canary-abort',
      workflowVersion: 1,
      params: {},
    });
    const registry = new ExtensionRegistry();
    registry.register('handler', 'aborter', {
      id: 'aborter',
      execute: async () => ({
        abort: {
          message: `stop: ${canary('DECL', f)} ${canary('ENV', f)} api_token=${canary('NAME', f)} Bearer ${canary('ANCH', f)}`,
        },
      }),
    });
    await executeChain(store, abortDef, { runId: run.id, command: 'h', input: {}, registry });
    const raw = readFileSync(join(home, '.realm', 'runs', `${run.id}.json`), 'utf8');
    const mcp = await overStdio(async (client) => {
      await client.callTool({
        name: 'get_run_state',
        arguments: { run_id: run.id, include_steps: true },
      });
    });
    const inspected = cli(['run', 'inspect', run.id], childEnv, root);
    const out = join(root, 'export-abort.json');
    const said = cli(['run', 'export', run.id, '--out', out], childEnv, root);
    const exported = readFileSync(out, 'utf8') + said;
    // Non-vacuity: the record holds the message raw, and the run ended aborted.
    // (a) red when `abort_message` is a fact again; (b) prints booleans and the leaked labels.
    expect({
      recorded: raw.includes(canary('ENV', f)) && raw.includes('"aborted_at"'),
      mcp: leaked(mcp),
      inspect: leaked(inspected),
      export: leaked(exported),
    }).toEqual({ recorded: true, mcp: [], inspect: [], export: [] });
  }, 60_000);

  it('SC-F3b: a load error an older build stored raw is hidden in the export and a piped inspect', async () => {
    const LOAD_ENV = 'FAKECANENVLOAD0729';
    const LOAD_ANCH = 'FAKECANANCHLOAD0729';
    const LOAD_NAME = 'FAKECANNAMELOAD0729';
    const store = new JsonFileStore(join(home, '.realm', 'runs'));
    const { run } = await store.create({ workflowId: 'canary', workflowVersion: 1, params: {} });
    await store.update({
      ...run,
      extension_identity: [
        {
          captured_at: '2026-10-17T00:00:00.000Z',
          modules: [],
          tree: { roots: [], tree_hash: 'fake-tree', file_count: 0 },
          coverage: 'dir_tree_v1',
          error: `identity capture failed: cannot read ${LOAD_ENV}, Bearer ${LOAD_ANCH}, api_token=${LOAD_NAME}`,
        },
      ],
    } as never);
    const env = { ...childEnv, CAN_ENV_LOAD: LOAD_ENV };
    const out = join(root, 'export-load.json');
    // From outside the project, as for the other export cell.
    const said = cli(['run', 'export', run.id, '--out', out], env, root);
    const exported = readFileSync(out, 'utf8');
    const inspected = cli(['run', 'inspect', run.id], env, root);
    const raw = readFileSync(join(home, '.realm', 'runs', `${run.id}.json`), 'utf8');
    const holds = (bytes: string) =>
      [LOAD_ENV, LOAD_ANCH, LOAD_NAME].filter((c) => bytes.includes(c)).length;
    // Non-vacuity: the record holds the three raw, and the export carries the entry's error.
    // (a) red when the record walk shows `extension_identity` as a fact (its `error` raw); (b)
    //     prints counts of fake canaries per surface and a boolean.
    expect({
      record: holds(raw),
      export: holds(exported + said),
      inspect: holds(inspected),
      errorExported: exported.includes('identity capture failed'),
    }).toEqual({ record: 3, export: 0, inspect: 0, errorExported: true });
  }, 60_000);

  it('F10: a log-mode drive counts the Result it shows as its shape on its Disclosure line', async () => {
    const runId = (
      await new JsonFileStore(join(home, '.realm', 'runs')).create({
        workflowId: 'canary-agent',
        workflowVersion: 1,
        params: {},
      })
    ).run.id;
    const stub = await startAnthropicStub({ finalContent: { summary: 'done' } });
    try {
      const out = await cliAsync(
        [
          'agent',
          '--run-id',
          runId,
          '--provider',
          'anthropic',
          '--model',
          'fake-model',
          '--project',
          project,
          '--log-mode',
        ],
        {
          ...childEnv,
          ANTHROPIC_API_KEY: 'fake-canary-key-0000',
          ANTHROPIC_BASE_URL: stub.baseUrl,
        },
      );
      const receipt = out.split('\n').find((l) => l.startsWith('Disclosure:'));
      // (a) red when the walk that shapes the Result stops adding to the line (0 shown as shapes);
      //     (b) prints whether the Result was shaped and the line's count.
      expect({
        resultShaped: out.includes('"summary": "‹string, 4 characters›"'),
        // C6: one value reads in the singular.
        shapedCount: receipt?.match(/; (\d+) values? shown as (?:its|their) type and size/)?.[1],
      }).toEqual({ resultShaped: true, shapedCount: '1' });
    } finally {
      await stub.close();
    }
  }, 60_000);

  it('C3: a log-mode drive at a gate with a message counts only what it printed, never the preview it left out', async () => {
    const store = new JsonFileStore(join(home, '.realm', 'runs'));
    const runId = (
      await store.create({
        workflowId: 'canary',
        workflowVersion: 1,
        params: { q_env: Q_ENV, q_decl: Q_DECL },
      })
    ).run.id;
    await executeStep(store, definition, {
      runId,
      command: 'a',
      input: { summary: 'done' },
      dispatcher: async (_c, input) => input,
    });
    await executeStep(store, definition, {
      runId,
      command: 'g',
      input: {},
      dispatcher: async () => planted('PREVIEW'),
    });
    const gateId = (await store.get(runId)).pending_gate!.gate_id;
    // The drive waits at the question; once it has printed it, another process answers, and the
    // drive goes on to its end and its Disclosure line.
    const out = await new Promise<string>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          CLI_ENTRY,
          'agent',
          '--run-id',
          runId,
          '--provider',
          'anthropic',
          '--model',
          'fake-model',
          '--project',
          project,
          '--log-mode',
        ],
        { cwd: project, env: { ...childEnv, ANTHROPIC_API_KEY: 'fake-canary-key-0000' } },
      );
      let text = '';
      let answered = false;
      const onData = (d: Buffer): void => {
        text += d.toString();
        if (!answered && text.includes('Gate: g')) {
          answered = true;
          spawnSync(
            process.execPath,
            [CLI_ENTRY, 'run', 'respond', runId, '--gate', gateId, '--choice', 'approve'],
            { cwd: project, env: childEnv, encoding: 'utf8', timeout: 30_000 },
          );
        }
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      const timer = setTimeout(() => child.kill(), 50_000);
      child.on('error', reject);
      child.on('close', () => {
        clearTimeout(timer);
        resolve(text);
      });
    });
    const receipt = out.split('\n').find((l) => l.startsWith('Disclosure:')) ?? '';
    const counted = Number(
      receipt.match(/; (\d+) values? shown as (?:its|their) type and size/)?.[1],
    );
    const printed = (out.match(/‹(?:string|number|boolean|array|object)[^›]*›/g) ?? []).length;
    // Non-vacuity: the gate printed its question, and the drive reached its line.
    // (a) red when the whole gate is walked for the count (the preview it does not print adds its
    //     shapes); (b) prints the two counts and two booleans.
    expect({
      question: out.includes('Approve'),
      receipt: receipt !== '',
      counted,
      printed,
    }).toEqual({ question: true, receipt: true, counted: printed, printed });
  }, 60_000);

  it('C3, correction 3: at a gate with a display template, it counts only the fields the template prints', async () => {
    const displayed = {
      ...definition,
      id: 'canary-display',
      steps: {
        g: {
          description: 'G.',
          execution: 'auto',
          trust: 'human_confirmed',
          depends_on: [],
          display: 'Check {{ text }}.',
          gate: { choices: ['approve', 'reject'] },
        },
      },
    } as WorkflowDefinition;
    await new JsonWorkflowStore(join(home, '.realm', 'workflows')).register(displayed);
    const store = new JsonFileStore(join(home, '.realm', 'runs'));
    const runId = (
      await store.create({ workflowId: 'canary-display', workflowVersion: 1, params: {} })
    ).run.id;
    await executeStep(store, displayed, {
      runId,
      command: 'g',
      input: {},
      dispatcher: async () => planted('PREVIEW'),
    });
    const gateId = (await store.get(runId)).pending_gate!.gate_id;
    const out = await new Promise<string>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          CLI_ENTRY,
          'agent',
          '--run-id',
          runId,
          '--provider',
          'anthropic',
          '--model',
          'fake-model',
          '--project',
          project,
          '--log-mode',
        ],
        { cwd: project, env: { ...childEnv, ANTHROPIC_API_KEY: 'fake-canary-key-0000' } },
      );
      let text = '';
      let answered = false;
      const onData = (d: Buffer): void => {
        text += d.toString();
        if (!answered && text.includes('Gate: g')) {
          answered = true;
          spawnSync(
            process.execPath,
            [CLI_ENTRY, 'run', 'respond', runId, '--gate', gateId, '--choice', 'approve'],
            { cwd: project, env: childEnv, encoding: 'utf8', timeout: 30_000 },
          );
        }
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      const timer = setTimeout(() => child.kill(), 50_000);
      child.on('error', reject);
      child.on('close', () => {
        clearTimeout(timer);
        resolve(text);
      });
    });
    const receipt = out.split('\n').find((l) => l.startsWith('Disclosure:')) ?? '';
    const counted = Number(
      receipt.match(/; (\d+) values? shown as (?:its|their) type and size/)?.[1],
    );
    const printed = (out.match(/‹(?:string|number|boolean|array|object)[^›]*›/g) ?? []).length;
    // Non-vacuity: the template printed its one field, and the drive reached its line.
    // (a) red when the whole preview is walked for the count (its two fields the template leaves
    //     out add their shapes); (b) prints the two counts and two booleans.
    expect({
      template: out.includes('Check ‹'),
      receipt: receipt !== '',
      counted,
      printed,
    }).toEqual({ template: true, receipt: true, counted: 1, printed: 1 });
  }, 60_000);

  it('F10: a log-mode drive that ends in an error still prints its Disclosure line', async () => {
    const out = await cliAsync(
      [
        'agent',
        '--run-id',
        'no-such-run-0729',
        '--provider',
        'anthropic',
        '--model',
        'fake-model',
        '--project',
        project,
        '--log-mode',
      ],
      { ...childEnv, ANTHROPIC_API_KEY: 'fake-canary-key-0000' },
    );
    // (a) red when the line is printed only when the drive returns (inside its `try`); (b) prints
    //     two booleans.
    expect({
      errored: out.includes('Error:'),
      receipt: out.split('\n').some((l) => l.startsWith('Disclosure:')),
    }).toEqual({ errored: true, receipt: true });
  }, 60_000);

  it("realm agent: a tool server's stderr is masked in the log, and the Disclosure line counts it (SC-F6)", async () => {
    // A real stdio MCP tool server that writes an environment value (handed to it through its
    // `env:` expansion) to its stderr when it starts.
    const require = createRequire(import.meta.url);
    const server = join(root, 'tool-server.cjs');
    writeFileSync(
      server,
      [
        "const { writeSync } = require('node:fs');",
        `const { McpServer } = require(${JSON.stringify(require.resolve('@modelcontextprotocol/sdk/server/mcp.js'))});`,
        `const { StdioServerTransport } = require(${JSON.stringify(require.resolve('@modelcontextprotocol/sdk/server/stdio.js'))});`,
        "writeSync(2, 'tool server starting, key ' + process.env.CANARY + '\\n');",
        "const server = new McpServer({ name: 'canary-tools', version: '1.0.0' });",
        "server.tool('echo', 'Echo.', async () => ({ content: [{ type: 'text', text: 'ok' }] }));",
        'server.connect(new StdioServerTransport());',
      ].join('\n'),
      'utf8',
    );
    await new JsonWorkflowStore(join(home, '.realm', 'workflows')).register({
      ...definition,
      id: 'canary-tools',
      mcp_servers: [
        {
          id: 'srv',
          transport: 'stdio',
          command: process.execPath,
          args: [server],
          env: { CANARY: '${CAN_ENV_TOOL}' },
        },
      ],
      steps: {
        t: {
          description: 'T.',
          execution: 'agent',
          depends_on: [],
          prompt: 'Use the tool.',
          tools: ['srv:echo'],
          input_schema: { type: 'object' },
        },
      },
    } as WorkflowDefinition);
    const runId = (
      await new JsonFileStore(join(home, '.realm', 'runs')).create({
        workflowId: 'canary-tools',
        workflowVersion: 1,
        params: {},
      })
    ).run.id;
    const stub = await startAnthropicStub({ finalContent: { summary: 'done' } });
    try {
      const out = await cliAsync(
        [
          'agent',
          '--run-id',
          runId,
          '--provider',
          'anthropic',
          '--model',
          'fake-model',
          '--project',
          project,
          '--log-mode',
        ],
        {
          ...childEnv,
          CAN_ENV_TOOL: TOOL_CANARY,
          ANTHROPIC_API_KEY: 'fake-canary-key-0000',
          ANTHROPIC_BASE_URL: stub.baseUrl,
        },
      );
      const receipt = out.split('\n').find((l) => l.startsWith('Disclosure:'));
      // Non-vacuity: the server started and its line reached the log, masked.
      // (a) red when the server's stderr is inherited again (the value reaches fd 2 unmasked and
      //     uncounted); (b) prints booleans and the receipt's environment count.
      expect({
        serverLine: out.includes('tool server starting, key [REDACTED]'),
        leaked: out.includes(TOOL_CANARY),
        environmentHidden: receipt?.match(/hidden \d+ declared, (\d+) environment/)?.[1],
      }).toEqual({ serverLine: true, leaked: false, environmentHidden: '1' });
    } finally {
      await stub.close();
    }
  }, 60_000);

  it('realm listen with a webhook trigger (its log, and the agent it starts)', async () => {
    // The model's answer carries output canaries, so the drive's result line holds them.
    const stub = await startAnthropicStub({
      finalContent: { summary: `${canary('DECL', 'OUTPUT')} ${canary('ENV', 'OUTPUT')}` },
    });
    const listenDir = join(root, 'listen');
    mkdirSync(listenDir, { recursive: true });
    writeFileSync(join(listenDir, 'realm.yaml'), readFileSync(join(project, 'realm.yaml'), 'utf8'));
    writeFileSync(join(listenDir, '.env'), readFileSync(join(project, '.env'), 'utf8'));
    writeFileSync(
      join(listenDir, 'workflow.yaml'),
      [
        'id: canary-listen',
        'name: canary-listen',
        'version: 1',
        'trigger:',
        '  type: webhook',
        '  path: /hook',
        '  auth:',
        '    mode: none',
        '  params_map:',
        '    text: body.text',
        '    api_token: body.api_token',
        '    auth: body.auth',
        'steps:',
        '  a:',
        '    description: A.',
        '    execution: agent',
        "    prompt: 'Summarise {{ run.params.text }} {{ run.params.auth }}.'",
        '',
      ].join('\n'),
    );
    const child = spawn(
      process.execPath,
      [
        CLI_ENTRY,
        'listen',
        '--port',
        '0',
        '--dedup-store',
        'memory',
        '--provider',
        'anthropic',
        '--model',
        'fake-model',
      ],
      {
        cwd: listenDir,
        env: {
          ...childEnv,
          ANTHROPIC_API_KEY: 'fake-canary-key-0000',
          ANTHROPIC_BASE_URL: stub.baseUrl,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '';
    child.stdout.on('data', (d: Buffer) => (output += d.toString()));
    child.stderr.on('data', (d: Buffer) => (output += d.toString()));
    try {
      const port = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('listen never listened')), 30_000);
        const check = (): void => {
          const m = /realm listen on 127\.0\.0\.1:(\d+)/.exec(output);
          if (m !== null) {
            clearTimeout(timer);
            resolve(Number(m[1]));
          }
        };
        child.stdout.on('data', check);
        child.stderr.on('data', check);
        child.on('close', () => reject(new Error(`listen exited: ${output.slice(0, 800)}`)));
      });
      const body = planted('WEBHOOK');
      const res = await fetch(`http://127.0.0.1:${port}/hook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      // Wait for the drive it started to call the model and finish.
      const deadline = Date.now() + 30_000;
      while (
        Date.now() < deadline &&
        !/exited|completed|finished/i.test(output.split('webhook: dispatched')[1] ?? '')
      ) {
        await new Promise((r) => setTimeout(r, 200));
      }
      const stored = (await new JsonFileStore(join(home, '.realm', 'runs')).list()).find(
        (r) => r.workflow_id === 'canary-listen',
      );
      // (a) red when the drive's result line loses both its walk (the output shown as its shapes,
      //     masked) and the writer's broadcast pass: either one alone hides the output canaries it
      //     carries; red too when the prompt reaches the model raw; (b) prints the status, the
      //     request count, whether the run holds the canaries raw (non-vacuity) and the labels.
      expect({
        door: 'listen',
        accepted: res.status < 300,
        storedRaw: JSON.stringify(stored?.params ?? {}).includes(canary('NAME', 'WEBHOOK')),
        outputRaw: JSON.stringify(stored?.evidence ?? []).includes(canary('ENV', 'OUTPUT')),
        requests: stub.requests.length > 0,
        leakedToModel: leaked(JSON.stringify(stub.requests)),
        leakedToLog: leaked(output),
      }).toEqual({
        door: 'listen',
        accepted: true,
        storedRaw: true,
        outputRaw: true,
        requests: true,
        leakedToModel: [],
        leakedToLog: [],
      });
    } finally {
      child.kill();
      await stub.close();
    }
  }, 90_000);
});
