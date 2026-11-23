// serve-token-unchanged-625.test.ts — #625 PR-2b, named keys unit 1, check 5 (a): with
// REALM_SERVE_TOKEN set and no key file, `realm serve` is what it was at fcbcad3f — its start lines,
// its replies (the 401 included) and every field of the entry a step records (ids and times aside).
// Through the built `realm serve` with a fresh HOME. This file imports nothing the unit adds, so it
// runs unchanged on fcbcad3f's build: its expected values are that build's (GROUNDING for the base,
// acceptance for the head). Every assertion carries (1) the break that turns it red and (2) what it
// prints when it fails: the lines, statuses and fields, never the token.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, onTestFinished } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadWorkflowFromString } from '@sensigo/realm';
import { openCliHome } from '../lib/home.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', '..', 'dist', 'index.js');
const TOKEN = 'nk1-test-token-not-a-secret';
const YAML =
  'id: nk1t\nname: nk1t\nversion: 1\nsteps:\n  work:\n    description: Work.\n    execution: agent\n';

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** The entry's fields with every id and time replaced by its kind. */
function shape(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shape);
  if (typeof value !== 'object' || value === null) {
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) return '<instant>';
    if (typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(value)) return '<id>';
    if (typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)) return '<hash>';
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => [k, k === 'by' ? '<program>' : k === 'duration_ms' ? '<ms>' : shape(v)]),
  );
}

describe('check 5 (a) — the shared token alone is unchanged', () => {
  it('the start lines, the 401, a step through the token and its recorded entry are as at fcbcad3f', async () => {
    const root = mkdtempSync(join(tmpdir(), 'realm-nk1-token-'));
    roots.push(root);
    const home = await openCliHome({ home: join(root, '.realm') });
    await home.workflowStore.register(loadWorkflowFromString(YAML));
    const { record } = await home.runStore.create({
      workflowId: 'nk1t',
      workflowVersion: 1,
      params: {},
    });
    const proc = spawn(process.execPath, [CLI, 'serve', '--port', '0'], {
      cwd: root,
      env: { PATH: process.env['PATH'] ?? '', HOME: root, REALM_SERVE_TOKEN: TOKEN },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    onTestFinished(() => {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
    });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d: Buffer) => (out += d.toString()));
    proc.stderr.on('data', (d: Buffer) => (err += d.toString()));
    const by = performance.now() + 30_000;
    let port: number | undefined;
    while (port === undefined && performance.now() < by) {
      const m = /listening on http:\/\/127\.0\.0\.1:(\d+)\//.exec(out);
      if (m !== null) port = Number(m[1]);
      else await new Promise((r) => setTimeout(r, 20));
    }
    if (port === undefined) throw new Error(`serve did not start: ${err.slice(0, 400)}`);
    const refused = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: 'Bearer wrong',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    const client = new Client({ name: 'nk1t', version: '0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/`), {
        requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
      }) as unknown as Parameters<typeof client.connect>[0],
    );
    let tools: string[];
    try {
      tools = (await client.listTools()).tools.map((t) => t.name).sort();
      await client.callTool({
        name: 'execute_step',
        arguments: { run_id: record.id, command: 'work', params: {} },
      });
    } finally {
      await client.close();
    }
    const entry = (await home.runStore.get(record.id)).record.evidence.find(
      (e) => e.step_id === 'work',
    );
    await home.close();
    const startLines = out
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => l.replace(/:\d+\//, ':<port>/'));
    // (1) red when the token goes down the key path (it is refused, or recorded otherwise), or a start
    //     line changes; (2) prints the lines, the 401's parts, the tools and the entry's shape.
    expect({
      startLines,
      stderr: err,
      refused: {
        status: refused.status,
        authenticate: refused.headers.get('www-authenticate'),
        type: refused.headers.get('content-type'),
        body: await refused.text(),
      },
      tools,
      entry: shape(entry),
    }).toEqual(EXPECTED);
  }, 60_000);
});

const EXPECTED = {
  startLines: [
    'Realm MCP server listening on http://127.0.0.1:<port>/',
    'Authentication: Bearer token (REALM_SERVE_TOKEN)',
    'Gate answers over MCP: asked (the default). No tool on this server records a gate answer, and this server sends no forms. To answer a waiting question, a person runs, in a terminal on this machine as the user that runs this server: realm run inspect <run_id>, then realm run respond <run_id> --gate <gate_id> --choice <choice>; the agent tells the user the run id. Another Realm server or CLI on the same store can still record answers. To let the agent answer, set --gate-answers permitted.',
  ],
  stderr: '',
  refused: {
    status: 401,
    authenticate: 'Bearer',
    type: 'application/json',
    body: '{"error":"Unauthorized"}',
  },
  tools: [
    'abandon_run',
    'advance_run',
    'append_trace',
    'create_workflow',
    'execute_step',
    'get_run_state',
    'get_workflow_protocol',
    'list_workflows',
    'start_run',
    'start_run_batch',
  ],
  entry: {
    attempt: 1,
    completed_at: '<instant>',
    diagnostics: { input_token_estimate: 1, precondition_trace: [] },
    driven_by: { by: '<program>', by_source: 'derived', channel: 'mcp-http' },
    duration_ms: '<ms>',
    evidence_hash: '<hash>',
    input_summary: {},
    output_summary: {},
    started_at: '<instant>',
    status: 'success',
    step_id: 'work',
    supplied_by: 'agent',
  },
};
