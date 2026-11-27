// serve-limits-625-u2.test.ts — #625 named keys unit 2b: a key made with `realm serve key add
// --read-only | --allow <tools> | --workflows <ids>` is held to its limits by `realm serve`, over HTTP
// (prompt feat-625-named-keys-u2-limits.md rev 2.1, checks 1 and 3 over HTTP, and check 4's
// serve row; MA 2's SPLIT-U2.md).
//
// Checks 1 and 4 run the server in this process (`startHttpMcpServer` on a temp home, keys made by
// `realm serve key add`'s body) and call it through the MCP SDK's own client. Check 3 runs the built
// `realm serve`, which installs the CLI's writer and so its disclosure provider, the one that reads a
// run's `realm.yaml` (the audit's p2 setup): only there could a refusal rendered with the run's
// subject show that the run exists. The names, keys and secrets are fictional.
// Beside each assertion: (1) the break that turns it red; (2) what it prints when it fails.
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadWorkflowFromString, type Attributed } from '@sensigo/realm';
import { takeServeKeysLock } from '@sensigo/realm-store-sqlite';
import { serveKeysPath } from '../lib/serve-keys.js';
import { makeTempHome, type TempHome } from '../test-support/temp-home.js';
import { startHttpMcpServer } from './serve.js';
import { serveKeyAdd, type ServeKeyLimitFlags } from './serve-key.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', '..', 'dist', 'index.js');
const TOKEN = 'nk2-test-token-not-a-secret';
const SERVER: Attributed = { by: 'svc@nk2-host', by_source: 'stated', channel: 'mcp-http' };
const BUDGET = 120_000;
const ASK = "Ask the server's operator for a key that allows it.";

type Json = Record<string, unknown>;
interface Result {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Json;
  isError?: boolean;
}

const STEP_YAML =
  'id: nk2\nname: nk2\nversion: 1\nsteps:\n  work:\n    description: Work.\n    execution: agent\n';

/** Each tool `realm serve` offers (under `--gate-answers permitted`), with valid arguments. */
const ARGS = (runId: string): Record<string, Json> => ({
  list_workflows: {},
  get_workflow_protocol: { workflow_id: 'nk2' },
  start_run: { workflow_id: 'nk2' },
  start_run_batch: { workflow_id: 'nk2', items: [{ params: {} }] },
  execute_step: { run_id: runId, command: 'work', params: {} },
  advance_run: { run_id: runId },
  submit_human_response: { run_id: runId, gate_id: 'gate-none', choice: 'approve' },
  get_run_state: { run_id: runId },
  abandon_run: { run_id: runId },
  create_workflow: { steps: [{ id: 's1', description: 'Do it.' }] },
  append_trace: { run_id: runId, step_id: 'work', entries: [] },
});
const TOOLS = Object.keys(ARGS(''));
const RUN_TOOLS = [
  'execute_step',
  'advance_run',
  'submit_human_response',
  'get_run_state',
  'abandon_run',
  'append_trace',
];

const homes: TempHome[] = [];
const servers: Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
  for (const h of homes.splice(0)) await h.cleanup();
});

/** Makes a key on `h` through `realm serve key add`'s body, with `flags`; returns its text. */
async function addKey(h: TempHome, name: string, flags: ServeKeyLimitFlags = {}): Promise<string> {
  const out = vi.spyOn(console, 'log').mockImplementation(() => {});
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const code = await serveKeyAdd(
      name,
      undefined,
      {
        home: () => h.home.path,
        // The cell's own handle stays open for the server: the command's close is a no-op here.
        openHome: () => Promise.resolve({ ...h.home, close: () => Promise.resolve() }),
        takeLock: (dir) => takeServeKeysLock(dir),
      },
      flags,
    );
    if (code !== 0)
      throw new Error(`add ${name} failed: ${err.mock.calls.map((c) => String(c[0])).join(' | ')}`);
    return String(out.mock.calls[0]![0]);
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
}

/** Starts the server in this process on `h`'s stores and key file; returns its port. */
async function serveOn(h: TempHome, token?: string): Promise<number> {
  const server = await startHttpMcpServer({
    port: 0,
    host: '127.0.0.1',
    devMode: false,
    token,
    workflowStore: h.home.workflowStore,
    runStore: h.home.runStore,
    traceBufferStore: h.home.traceBufferStore,
    failedAttemptStore: h.home.failedAttemptStore,
    driver: SERVER,
    gateAnswersFlag: 'permitted',
    keys: { path: serveKeysPath(h.home.path) },
  });
  servers.push(server);
  const address = server.address();
  return typeof address === 'object' && address !== null ? address.port : 0;
}

/** A client of the server on `port`, sending `bearer`. */
async function clientOf(port: number, bearer: string): Promise<Client> {
  const client = new Client({ name: 'nk2', version: '0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/`), {
      requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
    }) as unknown as Parameters<typeof client.connect>[0],
  );
  return client;
}

/** Calls one tool on `port` with `bearer`: the whole result. */
async function call(port: number, bearer: string, tool: string, args: Json): Promise<Result> {
  const client = await clientOf(port, bearer);
  try {
    return (await client.callTool({ name: tool, arguments: args })) as Result;
  } finally {
    await client.close();
  }
}

const textOf = (r: Result): string => r.content[0]?.text ?? '';
/** A call the limits let through: its reply is the tool's own (whatever the tool said). */
const served = (r: Result): boolean => !textOf(r).includes('CALL_OUTSIDE_LIMITS');
/** The refusal's fields, as the cells compare them; `served` for a call the limits let through. */
function refusalOf(r: Result): Json | string {
  if (served(r)) return 'served';
  const b = JSON.parse(textOf(r)) as Json;
  return {
    status: b['status'],
    error_code: b['error_code'],
    errors: b['errors'],
    context_hint: b['context_hint'],
    agent_action: b['agent_action'],
  };
}
const refused = (sentence: string): Json => ({
  status: 'error',
  error_code: 'CALL_OUTSIDE_LIMITS',
  errors: [sentence],
  context_hint: sentence,
  agent_action: 'report_to_user',
});

/** A home with the one-step workflow registered. */
async function homeWithWorkflow(): Promise<TempHome> {
  const h = await makeTempHome();
  homes.push(h);
  await h.home.workflowStore.register(loadWorkflowFromString(STEP_YAML));
  return h;
}

/** A fresh run of the one-step workflow: each call gets its own, so a served call changes no other. */
async function fresh(h: TempHome): Promise<string> {
  const { record } = await h.home.runStore.create({
    workflowId: 'nk2',
    workflowVersion: 1,
    params: {},
  });
  return record.id;
}

/** Each tool's outcome for `bearer`, one row per tool, each on a fresh run. */
async function table(h: TempHome, port: number, bearer: string): Promise<Record<string, unknown>> {
  const rows: Record<string, unknown> = {};
  for (const tool of TOOLS)
    rows[tool] = refusalOf(await call(port, bearer, tool, ARGS(await fresh(h))[tool]!));
  return rows;
}

describe('check 1 (over HTTP) — each tool under a key with a tool limit', () => {
  it(
    'a --read-only key is served the three reading tools and refused the other eight, each with the reading-tools sentence',
    async () => {
      const h = await homeWithWorkflow();
      const key = await addKey(h, 'dash', { readOnly: true });
      const port = await serveOn(h);
      const reading = ['list_workflows', 'get_workflow_protocol', 'get_run_state'];
      const sentence = (tool: string) =>
        `Key 'dash' may not call ${tool}: it may call only the reading tools (list_workflows, get_workflow_protocol, get_run_state). ${ASK}`;
      // (1) red when the shared check is skipped in a tool (that row reads 'served'), when serve does
      //     not pass the key's limits, or when read_only is not mapped; (2) prints the whole table.
      expect(await table(h, port, key)).toStrictEqual(
        Object.fromEntries(
          TOOLS.map((t) => [t, reading.includes(t) ? 'served' : refused(sentence(t))]),
        ),
      );
    },
    BUDGET,
  );

  it(
    'an --allow start_run,abandon_run key is served those two and refused the other nine, the reading tools among them',
    async () => {
      const h = await homeWithWorkflow();
      const key = await addKey(h, 'ci-runner', { allow: 'start_run, abandon_run' });
      const port = await serveOn(h);
      const allowed = ['start_run', 'abandon_run'];
      const sentence = (tool: string) =>
        `Key 'ci-runner' may not call ${tool}: it may call only start_run, abandon_run. ${ASK}`;
      // (1) red when the shared check is skipped in a tool, or when the key's tools are not mapped;
      //     (2) prints the whole table.
      expect(await table(h, port, key)).toStrictEqual(
        Object.fromEntries(
          TOOLS.map((t) => [t, allowed.includes(t) ? 'served' : refused(sentence(t))]),
        ),
      );
    },
    BUDGET,
  );

  it(
    'every tool the server offers stays listed for a --read-only key',
    async () => {
      const h = await homeWithWorkflow();
      const key = await addKey(h, 'dash', { readOnly: true });
      const port = await serveOn(h);
      const client = await clientOf(port, key);
      try {
        const names = (await client.listTools()).tools.map((t) => t.name).sort();
        // (1) red when a refused tool is hidden from tools/list; (2) prints the listed names.
        expect(names).toStrictEqual([...TOOLS].sort());
      } finally {
        await client.close();
      }
    },
    BUDGET,
  );
});

describe("check 4 (serve's row) — callers with no limits are unchanged", () => {
  it(
    'a key with no limits and REALM_SERVE_TOKEN are each served every tool',
    async () => {
      const h = await homeWithWorkflow();
      const key = await addKey(h, 'ana-laptop');
      const port = await serveOn(h, TOKEN);
      const all = Object.fromEntries(TOOLS.map((t) => [t, 'served']));
      // (1) red when serve applies a limit to a key that has none, or to the shared token; (2) prints
      //     both tables.
      expect({ key: await table(h, port, key), token: await table(h, port, TOKEN) }).toStrictEqual({
        key: all,
        token: all,
      });
    },
    BUDGET,
  );
});

// ---- Check 3: the built `realm serve`, with the CLI's disclosure provider ----

describe('check 3 (over HTTP) — a --workflows key learns nothing about runs it may not reach', () => {
  const UNKNOWN = '00000000-0000-4000-8000-000000000000';
  const SECRETS = 'secrets:\n  sources: [dotenv]\n  dotenv: .env\n';
  const ADAPTER =
    'adapters:\n  svc:\n    use: github\n    config: { token: "${secret:SVC_TOKEN}" }\n';
  const WF = (id: string): string =>
    `id: ${id}\nname: ${id}\nversion: 1\nsteps:\n  work:\n    description: Work.\n    execution: agent\n`;
  let root: string;
  let serve: ReturnType<typeof spawn> | undefined;
  let port: number;
  let key: string;
  let declRun: string;
  const manifest = (): string => join(root, 'proj', 'realm.yaml');

  /** The built `realm` on this describe's HOME. */
  const realm = (...args: string[]) =>
    spawnSync(process.execPath, [CLI, ...args], {
      cwd: root,
      env: { PATH: process.env['PATH'] ?? '', HOME: root },
      encoding: 'utf8',
      timeout: 60_000,
    });

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'realm-nk2-serve-'));
    // `plain`, the key's one workflow, has no project. `decl` is another workflow, in a project whose
    // realm.yaml names a secret (a built-in adapter's fictional token): its run records that manifest
    // and the secret's name, so a later edit reads `manifest_changed`.
    mkdirSync(join(root, 'loose'));
    writeFileSync(join(root, 'loose', 'plain.yaml'), WF('plain'));
    mkdirSync(join(root, 'proj', 'w'), { recursive: true });
    writeFileSync(join(root, 'proj', 'package.json'), '{}\n');
    writeFileSync(join(root, 'proj', '.env'), 'SVC_TOKEN=FAKE-NK2-SECRET-NOT-REAL\n');
    writeFileSync(manifest(), `version: 1\n${SECRETS}${ADAPTER}`);
    writeFileSync(join(root, 'proj', 'w', 'decl.yaml'), WF('decl'));
    for (const file of ['loose/plain.yaml', 'proj/w/decl.yaml']) {
      const r = realm('workflow', 'register', file);
      if (r.status !== 0) throw new Error(`register ${file}: ${r.status} ${r.stderr}`);
    }
    const added = realm('serve', 'key', 'add', 'plain-only', '--workflows', 'plain');
    if (added.status !== 0) throw new Error(`key add: ${added.status} ${added.stderr}`);
    key = added.stdout.trimEnd();
    serve = spawn(process.execPath, [CLI, 'serve', '--port', '0', '--gate-answers', 'permitted'], {
      cwd: root,
      env: { PATH: process.env['PATH'] ?? '', HOME: root, REALM_SERVE_TOKEN: TOKEN },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    serve.stdout!.on('data', (d: Buffer) => (out += d.toString()));
    serve.stderr!.on('data', () => {});
    const by = performance.now() + 30_000;
    let found: number | undefined;
    while (found === undefined && performance.now() < by) {
      const m = /listening on http:\/\/127\.0\.0\.1:(\d+)\/[\s\S]*Gate answers over MCP/.exec(out);
      if (m !== null) found = Number(m[1]);
      else await new Promise((r) => setTimeout(r, 20));
    }
    if (found === undefined) throw new Error(`realm serve did not start:\n${out}`);
    port = found;
    // The other workflow's run, started by the shared token (the key may not start it).
    declRun = JSON.parse(textOf(await call(port, TOKEN, 'start_run', { workflow_id: 'decl' })))[
      'run_id'
    ] as string;
  }, BUDGET);

  afterAll(() => {
    if (serve !== undefined && serve.exitCode === null) serve.kill('SIGKILL');
    try {
      chmodSync(manifest(), 0o600);
    } catch {
      // Nothing was made.
    }
    rmSync(root, { recursive: true, force: true });
  });

  /** The whole reply, as bytes the caller sees, with `id` masked: its text, twin and isError. */
  const bytes = (r: Result, id: string): string =>
    JSON.stringify({
      content: r.content,
      structuredContent: r.structuredContent,
      isError: r.isError,
    })
      .split(id)
      .join('<ID>');

  /** Each run tool's replies to the key for an unknown run, the other workflow's run, then the unknown run again. */
  async function replies(): Promise<Record<string, { codes: unknown[]; same: boolean[] }>> {
    const rows: Record<string, { codes: unknown[]; same: boolean[] }> = {};
    for (const tool of RUN_TOOLS) {
      const got: Array<[Result, string]> = [];
      for (const id of [UNKNOWN, declRun, UNKNOWN])
        got.push([await call(port, key, tool, ARGS(id)[tool]!), id]);
      const base = bytes(...got[0]!);
      rows[tool] = {
        codes: got.map(([r]) => (JSON.parse(textOf(r)) as Json)['error_code']),
        same: got.slice(1).map(([r, id]) => bytes(r, id) === base),
      };
    }
    return rows;
  }

  /** What the CLI's provider says of the other workflow's run now: the token's refused cursor read. */
  async function runState(): Promise<unknown[]> {
    const r = await call(port, TOKEN, 'get_run_state', { run_id: declRun, cursor: 'c' });
    const receipt = (JSON.parse(textOf(r)) as Json)['disclosure'] as Json;
    return [receipt['declared'], receipt['declared_cause']];
  }

  const same = Object.fromEntries(
    RUN_TOOLS.map((t) => [t, { codes: Array(3).fill('CALL_OUTSIDE_LIMITS'), same: [true, true] }]),
  );

  it(
    "its realm.yaml unreadable: every run tool gives the unknown run's reply bytes",
    async () => {
      chmodSync(manifest(), 0o000);
      try {
        const rows = await replies();
        // The instrument: the setup reaches the state a subject-rendered reply would show.
        // (1) red when the run's manifest is read anyway (running as root, say); (2) prints it.
        expect(await runState()).toStrictEqual(['unknown', 'load_failed']);
        // (1) red when the refusal is rendered with the run's subject, or a run tool is not checked;
        //     (2) prints each tool's codes and which replies matched the first.
        expect(rows).toStrictEqual(same);
      } finally {
        chmodSync(manifest(), 0o600);
      }
    },
    BUDGET,
  );

  it(
    'its realm.yaml changed since the run started (the secret it recorded is gone): the same bytes',
    async () => {
      writeFileSync(manifest(), `version: 1\n${SECRETS}`);
      const rows = await replies();
      // The instrument, as above. (1) red when the run recorded no secret name (nothing then reads
      //     changed); (2) prints the state.
      expect(await runState()).toStrictEqual(['partial', 'manifest_changed']);
      // (1) red when the refusal is rendered with the run's subject; (2) prints the rows.
      expect(rows).toStrictEqual(same);
    },
    BUDGET,
  );
});
