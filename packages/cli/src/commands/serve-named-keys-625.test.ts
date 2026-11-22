// serve-named-keys-625.test.ts — #625 PR-2b, named keys unit 1: `realm serve` lets a caller in by
// one of its named keys, names the key on every act, and keeps the shared token as it was (prompt
// feat-625-named-keys-unit1.md rev 4, checks 2–9, 11's serve cells and 15).
//
// The per-request cells run the server in this process (`startHttpMcpServer`, the stores of a temp
// home, the key file of that home) and talk to it over HTTP: through the MCP SDK's own client, or a
// raw POST where a cell reads the 401 itself. The start cells run the built `realm serve` with a fresh
// HOME. Keys are written into the home's key file by the key file module's own writer (the commands
// that make keys come in unit 1b). Every assertion carries (1) the
// break that turns it red and (2) what it prints when it fails: statuses, the recorded fields, the
// lines, never a key's text.
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { advanceRun, loadWorkflowFromString, type Attributed } from '@sensigo/realm';
import { createTestHome } from '@sensigo/realm-testing';
import {
  keyFingerprint,
  newServeKey,
  readServeKeys,
  serveKeysPath,
  writeServeKeys,
} from '../lib/serve-keys.js';
import { makeTempHome, type TempHome } from '../test-support/temp-home.js';
import { startHttpMcpServer } from './serve.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', '..', 'dist', 'index.js');
const TOKEN = 'nk1-test-token-not-a-secret';
/** The program the in-process server runs as (what `resolveProgramIdentity` gives `realm serve`). */
const SERVER: Attributed = { by: 'svc@nk1-host', by_source: 'stated', channel: 'mcp-http' };

const STEP_YAML =
  'id: nk1\nname: nk1\nversion: 1\nsteps:\n  work:\n    description: Work.\n    execution: agent\n';
const GATE_YAML = [
  'id: nk1g',
  'name: nk1g',
  'version: 1',
  'steps:',
  '  q:',
  '    description: Ask.',
  '    execution: auto',
  '    trust: human_confirmed',
  '    gate:',
  '      choices: [approve, reject]',
  '  after:',
  '    description: After.',
  '    execution: agent',
  '    depends_on: [q]',
].join('\n');

const homes: TempHome[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
  for (const h of homes.splice(0)) await h.cleanup();
});

async function tempHome(options: { home?: string } = {}): Promise<TempHome> {
  const h =
    options.home === undefined ? await makeTempHome() : await makeTempHome({ home: options.home });
  homes.push(h);
  return h;
}

/**
 * Writes a key named `name` into `h`'s key file, made at the home clock's now and ending `days` days
 * later (no end by default), through the key file module's writer; returns its text.
 */
async function addKey(h: TempHome, name: string, days?: number): Promise<string> {
  const text = newServeKey();
  const now = h.home.runStore.clock.now();
  const read = readServeKeys(serveKeysPath(h.home.path));
  const keys = read.state === 'valid' ? read.keys : [];
  writeServeKeys(h.home.path, [
    ...keys,
    {
      name,
      sha256: keyFingerprint(text),
      created_at: now.toISOString(),
      expires_at:
        days === undefined ? null : new Date(now.getTime() + days * 86_400_000).toISOString(),
    },
  ]);
  return text;
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

/** A raw `tools/list` POST with `auth` as the Authorization header: the status the caller sees. */
async function post(port: number, auth?: string): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${port}/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(auth !== undefined ? { Authorization: auth } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  await res.text();
  return res.status;
}

/** Calls one tool through the SDK's own client, with `bearer` as the token. */
async function callTool(
  port: number,
  bearer: string,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const client = new Client({ name: 'nk1', version: '0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/`), {
      requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
    }) as unknown as Parameters<typeof client.connect>[0],
  );
  try {
    const raw = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ text: string }>;
    };
    return raw.content[0]?.text ?? '';
  } finally {
    await client.close();
  }
}

/** A run of the one-step workflow, opened on `h`. */
async function stepRun(h: TempHome): Promise<string> {
  await h.home.workflowStore.register(loadWorkflowFromString(STEP_YAML));
  const { record } = await h.home.runStore.create({
    workflowId: 'nk1',
    workflowVersion: 1,
    params: {},
  });
  return record.id;
}

/** A run of the gate workflow, at its open question. */
async function gateRun(h: TempHome): Promise<{ runId: string; gateId: string }> {
  const def = loadWorkflowFromString(GATE_YAML);
  await h.home.workflowStore.register(def);
  const { record } = await h.home.runStore.create({
    workflowId: def.id,
    workflowVersion: 1,
    params: {},
  });
  await advanceRun(h.home.runStore, def, { runId: record.id });
  return {
    runId: record.id,
    gateId: (await h.home.runStore.get(record.id)).record.pending_gate!.gate_id,
  };
}

async function drivenBy(h: TempHome, runId: string): Promise<unknown> {
  const { record } = await h.home.runStore.get(runId);
  return record.evidence.find((e) => e.step_id === 'work')?.driven_by;
}

/** `realm run inspect <runId>`'s stdout, through the built CLI on `h`'s HOME. */
function inspect(h: TempHome, runId: string): string {
  const r = spawnSync(process.execPath, [CLI, 'run', 'inspect', runId], {
    env: { PATH: process.env['PATH'] ?? '', HOME: h.root! },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return r.stdout;
}

describe('check 2 — a keyed request works and names the key', () => {
  it('tools/list succeeds, and execute_step records driven_by { by: <name>, by_source: key }', async () => {
    const h = await tempHome();
    const key = await addKey(h, 'ana-laptop');
    const port = await serveOn(h);
    const runId = await stepRun(h);
    // (1) red when a key is not let in; (2) prints the status.
    expect(await post(port, `Bearer ${key}`)).toBe(200);
    await callTool(port, key, 'execute_step', { run_id: runId, command: 'work', params: {} });
    // (1) red when the keyed request keeps the start-time driver; (2) prints the recorded driver.
    expect(await drivenBy(h, runId)).toEqual({
      by: 'ana-laptop',
      by_source: 'key',
      channel: 'mcp-http',
    });
  }, 60_000);
});

describe('check 3 — a key taken out of the file is refused with no restart', () => {
  it('on a running server, a request with a key the file no longer holds gets the 401', async () => {
    const h = await tempHome();
    const key = await addKey(h, 'ana-laptop');
    const other = await addKey(h, 'ci-runner');
    const port = await serveOn(h);
    expect(await post(port, `Bearer ${key}`)).toBe(200);
    // The file rewritten with the other key only, as an operator's edit would leave it.
    const read = readServeKeys(serveKeysPath(h.home.path));
    if (read.state !== 'valid') throw new Error(`the key file is ${read.state}`);
    writeServeKeys(
      h.home.path,
      read.keys.filter((k) => k.name !== 'ana-laptop'),
    );
    // (1) red when the file is read once at start; (2) prints the status. The other key still works,
    //     so the 401 is this key's, not a server that stopped reading the file.
    expect(await post(port, `Bearer ${other}`)).toBe(200);
    expect(await post(port, `Bearer ${key}`)).toBe(401);
  }, 60_000);
});

describe('check 4 — an ended key is refused', () => {
  it('on the test clock: works before its end, the 401 after it', async () => {
    const root = (await tempHome()).root!;
    // A home on a test clock (the file `.realm-test-clock`), which this process's store reads.
    const clockRoot = join(root, 'clocked');
    const th = await createTestHome({
      start: '2026-11-22T12:00:00.000Z',
      root: join(clockRoot, '.realm'),
    });
    onTestFinished(() => th.remove());
    const h = await tempHome({ home: th.root });
    const key = await addKey(h, 'ana-laptop', 1);
    const port = await serveOn(h);
    expect(await post(port, `Bearer ${key}`)).toBe(200);
    await th.clock.advance(25 * 60 * 60 * 1000);
    // (1) red when the end check is dropped; (2) prints the status.
    expect(await post(port, `Bearer ${key}`)).toBe(401);
  }, 60_000);
});

describe('check 5 (b) — the shared token beside keys', () => {
  it('a keyed answer, then a token answer: the token answer records the server and shared_token', async () => {
    const h = await tempHome();
    const key = await addKey(h, 'ana-laptop');
    const port = await serveOn(h, TOKEN);
    const keyed = await gateRun(h);
    const tokened = await gateRun(h);
    await callTool(port, key, 'submit_human_response', {
      run_id: keyed.runId,
      gate_id: keyed.gateId,
      choice: 'approve',
    });
    await callTool(port, TOKEN, 'submit_human_response', {
      run_id: tokened.runId,
      gate_id: tokened.gateId,
      choice: 'approve',
    });
    const answer = async (runId: string) => {
      const entry = (await h.home.runStore.get(runId)).record.evidence.find(
        (e) => e.kind === 'gate_response',
      );
      return { driven_by: entry?.driven_by, principal: entry?.principal };
    };
    // (1) red when the key's driver is set on the shared options object; (2) prints both entries.
    expect({ keyed: await answer(keyed.runId), tokened: await answer(tokened.runId) }).toEqual({
      keyed: {
        driven_by: { by: 'ana-laptop', by_source: 'key', channel: 'mcp-http' },
        principal: { kind: 'api_key', id: 'ana-laptop' },
      },
      tokened: { driven_by: SERVER, principal: { kind: 'shared_token' } },
    });
  }, 60_000);
});

describe('check 7 — an answer through a key', () => {
  it("records the api_key principal, and inspect's answer line names the key", async () => {
    const h = await tempHome();
    const key = await addKey(h, 'ana-laptop');
    const port = await serveOn(h);
    const { runId, gateId } = await gateRun(h);
    await callTool(port, key, 'submit_human_response', {
      run_id: runId,
      gate_id: gateId,
      choice: 'approve',
    });
    const entry = (await h.home.runStore.get(runId)).record.evidence.find(
      (e) => e.kind === 'gate_response',
    );
    // (1) red when the keyed request keeps the shared principal; (2) prints it.
    expect(entry?.principal).toEqual({ kind: 'api_key', id: 'ana-laptop' });
    const line = inspect(h, runId)
      .split('\n')
      .find((l) => l.includes('recorded by'));
    // (1) red when "running as" is kept for a key; (2) prints the line (its instant replaced).
    expect(line?.trim().replace(/given at \S+/, 'given at <instant>')).toBe(ANSWER_LINE);
  }, 60_000);
});

describe('check 8 — abandon_run through a key', () => {
  it('the abandon sentence and the Ended by line name the key', async () => {
    const h = await tempHome();
    const key = await addKey(h, 'ana-laptop');
    const port = await serveOn(h);
    const runId = await stepRun(h);
    await callTool(port, key, 'abandon_run', { run_id: runId });
    const lines = inspect(h, runId)
      .split('\n')
      .map((l) => l.trim());
    // The ending's sentence, as `realm run advance` prints it for an ended run (core's composer).
    const advanced = spawnSync(process.execPath, [CLI, 'run', 'advance', runId], {
      env: { PATH: process.env['PATH'] ?? '', HOME: h.root! },
      encoding: 'utf8',
      timeout: 60_000,
    });
    const sentences = `${advanced.stdout}\n${advanced.stderr}`
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.includes('It was abandoned'));
    // (1) red when the server's sentence is kept for a key; (2) prints the lines.
    expect({
      ended: lines.filter((l) => l.startsWith('Ended by:')),
      sentence: sentences,
    }).toEqual({
      ended: ["Ended by: the assistant's abandon_run tool, by ana-laptop (from the server's key)"],
      sentence: ABANDON_LINES,
    });
  }, 60_000);
});

describe('check 9 — a file that stops parsing fails closed', () => {
  it('valid, then broken: keyed requests get the 401, the token still works, the warning prints once', async () => {
    const h = await tempHome();
    const key = await addKey(h, 'ana-laptop');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const port = await serveOn(h, TOKEN);
      expect(await post(port, `Bearer ${key}`)).toBe(200);
      writeFileSync(serveKeysPath(h.home.path), '{"format": 1, "keys": [', { mode: 0o600 });
      // (1) red when the last good key set is still served; (2) prints the statuses.
      expect([
        await post(port, `Bearer ${key}`),
        await post(port, `Bearer ${key}`),
        await post(port, `Bearer ${TOKEN}`),
      ]).toEqual([401, 401, 200]);
      // (1) red when the warning prints per request, or never; (2) prints every warning.
      expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([
        `Warning: the named keys in ${serveKeysPath(h.home.path)} cannot be read (not JSON). Every request with a named key is refused until it is fixed; REALM_SERVE_TOKEN still works.`,
      ]);
    } finally {
      warn.mockRestore();
    }
  }, 60_000);
});

describe('check 15 — two entries with one fingerprint make the file invalid', () => {
  it('on a running server the key gets the 401', async () => {
    const h = await tempHome();
    const key = await addKey(h, 'ana-laptop');
    const path = serveKeysPath(h.home.path);
    const port = await serveOn(h, TOKEN);
    const file = JSON.parse((await import('node:fs')).readFileSync(path, 'utf8')) as {
      format: 1;
      keys: Array<Record<string, unknown>>;
    };
    file.keys.push({ ...file.keys[0]!, name: 'copy' });
    writeFileSync(path, `${JSON.stringify(file)}\n`, { mode: 0o600 });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // (1) red when the repeated-sha256 rule is dropped (the key is let in); (2) prints the status.
      expect(await post(port, `Bearer ${key}`)).toBe(401);
    } finally {
      warn.mockRestore();
    }
  }, 60_000);
});

// ---- The built `realm serve`, through its start ----

interface Started {
  readonly port: number | undefined;
  readonly proc: ChildProcess;
  stdout(): string;
  stderr(): string;
  exited(): Promise<number | null>;
}

/** Starts the built `realm serve --port 0` on HOME `root`, with `token` when given. */
async function startServe(root: string, extra: string[], token?: string): Promise<Started> {
  const proc = spawn(process.execPath, [CLI, 'serve', '--port', '0', ...extra], {
    cwd: root,
    env: {
      PATH: process.env['PATH'] ?? '',
      HOME: root,
      ...(token !== undefined ? { REALM_SERVE_TOKEN: token } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  onTestFinished(() => {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
  });
  let out = '';
  let err = '';
  proc.stdout!.on('data', (d: Buffer) => (out += d.toString()));
  proc.stderr!.on('data', (d: Buffer) => (err += d.toString()));
  let code: number | null | undefined;
  const exited = new Promise<number | null>((r) => proc.once('exit', (c) => r((code = c))));
  const by = performance.now() + 30_000;
  let port: number | undefined;
  while (port === undefined && code === undefined && performance.now() < by) {
    // The start lines end with the gate-answers line: they are read whole before a cell looks.
    const m = /listening on http:\/\/127\.0\.0\.1:(\d+)\/[\s\S]*Gate answers over MCP/.exec(out);
    if (m !== null) port = Number(m[1]);
    else await new Promise((r) => setTimeout(r, 20));
  }
  return { port, proc, stdout: () => out, stderr: () => err, exited: () => exited };
}

describe('check 6 — a server on keys alone', () => {
  it('starts with a key that works and no token; a key is let in; Bearer x gets the 401 and it keeps running', async () => {
    const h = await tempHome();
    const key = await addKey(h, 'ana-laptop');
    const s = await startServe(h.root!, []);
    // (1) red under today's start check (no token: refused); (2) prints stderr.
    expect({
      started: s.port !== undefined,
      stderr: s.port === undefined ? s.stderr() : '',
    }).toEqual({
      started: true,
      stderr: '',
    });
    expect(s.stdout()).toContain(
      `Authentication: Bearer token (named keys in ${serveKeysPath(h.home.path)})`,
    );
    expect(await post(s.port!, `Bearer ${key}`)).toBe(200);
    // (1) red when the token is compared as today with none set (the handler throws: no reply, or
    //     the process exits); (2) prints the status and whether the process still runs.
    const refused = await post(s.port!, 'Bearer x').catch((e: unknown) => String(e));
    expect({ refused, running: s.proc.exitCode === null && s.proc.signalCode === null }).toEqual({
      refused: 401,
      running: true,
    });
  }, 60_000);

  it('with neither a token nor a key, it refuses to start, naming the case', async () => {
    const h = await tempHome();
    const s = await startServe(h.root!, []);
    // (1) red when serve starts with nothing to check a caller by; (2) prints the exit and stderr.
    expect({ code: await s.exited(), stderr: s.stderr() }).toEqual({
      code: 1,
      stderr:
        'Error: REALM_SERVE_TOKEN is not set and there is no named key.\n' +
        'Set it to a secret token, or use --dev / REALM_DEV=1 for local development only.\n',
    });
  }, 60_000);
});

describe("check 11 — the mode warning, on serve's start", () => {
  it('a 0644 file gives the house warning on serve, and none in dev mode', async () => {
    const h = await tempHome();
    await addKey(h, 'ana-laptop');
    const path = serveKeysPath(h.home.path);
    chmodSync(path, 0o644);
    const warning = `Warning: ${path} is open to other users (mode 0644). Fix that with: chmod 600 ${path}`;
    const served = await startServe(h.root!, [], TOKEN);
    const dev = await startServe(h.root!, ['--dev']);
    const warnings = (text: string): string[] =>
      text.split('\n').filter((l) => l.includes('is open to other users'));
    // (1) red when the check is dropped, or dev mode reads the key file; (2) prints the lines.
    expect({ served: warnings(served.stderr()), dev: warnings(dev.stderr()) }).toEqual({
      served: [warning],
      dev: [],
    });
  }, 60_000);
});

const ANSWER_LINE =
  "Answer: approve · answered by (not stated) · through Realm's MCP answer tool (as its door declared), recorded by mcp-http, for ana-laptop (from the server's key) · given at <instant> · authenticated by API key ana-laptop · no claim token passed (a token is passed only from the conversation that opened the question — by Realm's MCP answer tool, or by the form sent by the call that opened it — or by a program that calls the library with it)";
const ABANDON_LINES: string[] = [
  "Nothing is owed to the engine: the run has ended (abandoned). It was abandoned with the assistant's 'abandon_run' tool, by ana-laptop (from the server's key); no reason was given. To run the work again, start a new run.",
];
