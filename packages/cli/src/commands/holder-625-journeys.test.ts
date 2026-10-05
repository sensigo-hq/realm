// holder-625-journeys.test.ts — issue #625 (the holder slice, PR-H): the cells that need a real
// second process.
//
//   1. HOST ROWS (MCP) — each program that serves the MCP tools names itself on the claims it takes:
//      the `realm-mcp` bin (`mcp-stdio`), `realm mcp` (`mcp-stdio`), `realm serve` (`mcp-http`).
//   2. THE PROOF OVER REAL STDIO — the token handed out on the opening reply and passed back; an
//      EMPTY token and a bad `responded_by` are never a reason to lose or mangle an answer.
//   3. THE CLI AFTER — `realm run respond --by` and `realm run inspect` on records made by (2).
//   4. A NAME THAT CANNOT BE USED — one line on stderr and exit 1 before anything starts.
//
// Every process gets a scratch HOME; nothing here reads or writes the real `~/.realm`. Children are
// spawned ASYNCHRONOUSLY — a synchronous spawn in the same process as a server it talks to blocks
// that server. Each assertion carries (a) the change that turns it red and (b) what it prints on
// failure: synthetic names only.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonFileStore, JsonWorkflowStore, CURRENT_WORKFLOW_SCHEMA_VERSION } from '@sensigo/realm';
import type { WorkflowDefinition } from '@sensigo/realm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { resolveMcpServerEntry } from '../agent/test-support/mcp-server-entry.js';

/** The built CLI. THREE `..`: commands → src → cli. */
const CLI_ENTRY = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
if (!existsSync(CLI_ENTRY)) {
  throw new Error(`cli dist not built — run \`npm run build\` first (looked for: ${CLI_ENTRY})`);
}

/** `confirm` (auto, opens a gate on start_run) → `finish` (agent). */
const gateWorkflow: WorkflowDefinition = {
  id: 'holder-journey-wf',
  name: 'holder journey',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    confirm: {
      description: 'Confirm',
      execution: 'auto',
      trust: 'human_confirmed',
      depends_on: [],
      gate: { choices: ['approve', 'reject'] },
    },
    finish: { description: 'Finish', execution: 'agent', depends_on: ['confirm'] },
  },
};

let home: string;
beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'realm-holder-journeys-'));
  await new JsonWorkflowStore(join(home, '.realm', 'workflows')).register(gateWorkflow);
});
afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

const runs = (): JsonFileStore => new JsonFileStore(join(home, '.realm', 'runs'));

type Reply = Record<string, unknown> & {
  status: string;
  run_id: string;
  gate?: { gate_id: string; claim_token?: string };
  gate_claim?: { proof: string; cause?: string; opened_by: unknown };
  warnings?: string[];
  errors?: string[];
  error_code?: string;
};

function childEnv(extra: Record<string, string | undefined> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, HOME: home, ...extra })) {
    if (v !== undefined) env[k] = v;
  }
  delete env['REALM_OPERATOR'];
  if (extra['REALM_OPERATOR'] !== undefined) env['REALM_OPERATOR'] = extra['REALM_OPERATOR'];
  return env;
}

/** An MCP client over stdio to `node <entry> <args…>`. */
async function stdioClient(
  entry: string,
  args: string[],
  operator: string,
  name: string,
): Promise<Client> {
  const client = new Client({ name, version: '0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [entry, ...args],
      env: childEnv({ REALM_OPERATOR: operator }),
    }),
  );
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<Reply> {
  const result = (await client.callTool({ name, arguments: args })) as {
    content: Array<{ type: string; text?: string }>;
  };
  const text = result.content[0]?.text ?? '';
  try {
    return JSON.parse(text) as Reply;
  } catch {
    throw new Error(`${name} did not return a reply: ${text}`);
  }
}

/** Runs the built CLI to completion. Async spawn, stdin closed. */
function cli(
  args: string[],
  extra: Record<string, string | undefined> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
      env: childEnv(extra),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

async function startGate(
  client: Client,
): Promise<{ runId: string; gateId: string; token: string }> {
  const started = await call(client, 'start_run', { workflow_id: gateWorkflow.id, params: {} });
  if (started.gate === undefined)
    throw new Error(`fixture: no gate opened: ${JSON.stringify(started)}`);
  return {
    runId: started.run_id,
    gateId: started.gate.gate_id,
    token: started.gate.claim_token ?? '',
  };
}

describe('HOST ROWS — each program that serves the MCP tools names itself on the claims it takes', () => {
  it('the realm-mcp bin: channel mcp-stdio, the name from REALM_OPERATOR', async () => {
    const client = await stdioClient(resolveMcpServerEntry(), [], 'bin-row', 'row-bin');
    try {
      const { runId } = await startGate(client);
      const claim = (await runs().get(runId)).claims!['confirm']!;
      // (a) red when the bin stops composing/passing its identity, or uses another channel; (b)
      //     prints the claim’s holder.
      expect(claim.holder).toEqual({ by: 'bin-row', by_source: 'ambient', channel: 'mcp-stdio' });
      expect(typeof claim.since).toBe('string');
    } finally {
      await client.close();
    }
  }, 30_000);

  it('`realm mcp`: channel mcp-stdio, the name from REALM_OPERATOR', async () => {
    const client = await stdioClient(CLI_ENTRY, ['mcp'], 'mcp-row', 'row-mcp');
    try {
      const { runId } = await startGate(client);
      expect((await runs().get(runId)).claims!['confirm']!.holder).toEqual({
        by: 'mcp-row',
        by_source: 'ambient',
        channel: 'mcp-stdio',
      });
    } finally {
      await client.close();
    }
  }, 30_000);

  it('`realm agent`: channel agent — the step it took, its claim, and the evidence of the gate it opened', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'realm-holder-agent-row-'));
    const file = join(dir, 'workflow.yaml');
    writeFileSync(
      file,
      [
        'id: holder-agent-row-wf',
        'name: holder agent row',
        'version: 1',
        'steps:',
        '  confirm:',
        '    description: Confirm',
        '    execution: auto',
        '    trust: human_confirmed',
        '    depends_on: []',
        '    gate:',
        '      choices: [approve, reject]',
        '  finish:',
        '    description: Finish',
        '    execution: agent',
        '    depends_on: [confirm]',
        '',
      ].join('\n'),
      'utf8',
    );
    // No agent step runs before the gate, so no model is called; the key is never used.
    const child = spawn(
      process.execPath,
      [CLI_ENTRY, 'agent', '--workflow', file, '--provider', 'openai', '--model', 'test-model'],
      {
        env: childEnv({ REALM_OPERATOR: 'agent-row', OPENAI_API_KEY: 'not-a-real-key' }),
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    try {
      let out = '';
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`agent never reached the gate. Output so far:\n${out}`)),
          25_000,
        );
        child.stdout.on('data', (d: Buffer) => {
          out += d.toString();
          if (out.includes('Waiting for approval')) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.on('error', reject);
        child.on('close', () => reject(new Error(`agent exited before the gate. Output:\n${out}`)));
      });
      const runId = /Run ID: (\S+)/.exec(out)?.[1];
      expect(runId).toBeDefined();
      const run = await runs().get(runId!);
      // (a) red when `agent.ts` stops passing its identity down to the drive, or uses another
      //     channel; (b) prints the claim and the entry.
      const expected = { by: 'agent-row', by_source: 'ambient', channel: 'agent' };
      expect(run.claims!['confirm']!.holder).toEqual(expected);
      expect(run.evidence.find((e) => e.step_id === 'confirm')?.driven_by).toEqual(expected);
    } finally {
      child.kill('SIGTERM');
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40_000);

  it('`realm serve`: channel mcp-http — made once, outside the per-request handler', async () => {
    const port = await new Promise<number>((resolve, reject) => {
      const probe = createServer();
      probe.on('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const address = probe.address();
        const free = typeof address === 'object' && address !== null ? address.port : 0;
        probe.close(() => resolve(free));
      });
    });
    const child = spawn(
      process.execPath,
      [CLI_ENTRY, 'serve', '--dev', '--port', String(port), '--host', '127.0.0.1'],
      { env: childEnv({ REALM_OPERATOR: 'serve-row' }), stdio: ['ignore', 'pipe', 'pipe'] },
    );
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('serve never announced it was listening')),
          20_000,
        );
        child.stdout.on('data', (d: Buffer) => {
          if (d.toString().includes('listening on')) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.on('error', reject);
        child.on('close', () => reject(new Error('serve exited before listening')));
      });
      const client = new Client({ name: 'row-serve', version: '0' });
      await client.connect(
        new StreamableHTTPClientTransport(
          new URL(`http://127.0.0.1:${port}/`),
        ) as unknown as Parameters<Client['connect']>[0],
      );
      try {
        const { runId } = await startGate(client);
        expect((await runs().get(runId)).claims!['confirm']!.holder).toEqual({
          by: 'serve-row',
          by_source: 'ambient',
          channel: 'mcp-http',
        });
      } finally {
        await client.close();
      }
    } finally {
      child.kill('SIGTERM');
    }
  }, 40_000);
});

describe('THE PROOF OVER REAL STDIO — the token is handed out once, passed back, judged; never a reason to lose an answer', () => {
  it('start_run → the token on the opening reply → submit_human_response with it ⇒ matched, the opener named; a replay ⇒ spent with its sentence', async () => {
    const client = await stdioClient(resolveMcpServerEntry(), [], 'proof-row', 'row-proof');
    try {
      const { runId, gateId, token } = await startGate(client);
      expect(token).not.toBe('');
      const first = await call(client, 'submit_human_response', {
        run_id: runId,
        gate_id: gateId,
        choice: 'approve',
        claim_token: token,
      });
      expect(first.status).toBe('ok');
      expect(first.gate_claim).toEqual({
        proof: 'matched',
        opened_by: { by: 'proof-row', by_source: 'ambient', channel: 'mcp-stdio' },
      });
      expect(first.warnings ?? []).toEqual([]);

      const again = await call(client, 'submit_human_response', {
        run_id: runId,
        gate_id: gateId,
        choice: 'approve',
        claim_token: token,
      });
      expect(again.status).toBe('ok');
      expect(again.gate_claim?.proof).toBe('spent');
      expect(again.gate_claim?.cause).toBe('answered');
      expect(again.warnings).toContain(
        'The claim_token could not be checked: this question was already settled by an earlier answer.',
      );
    } finally {
      await client.close();
    }
  }, 30_000);

  it('an EMPTY claim_token over the wire is recorded with `mismatch` and `status: ok` (never the SDK’s -32602)', async () => {
    const client = await stdioClient(resolveMcpServerEntry(), [], 'empty-row', 'row-empty');
    try {
      const { runId, gateId } = await startGate(client);
      const reply = await call(client, 'submit_human_response', {
        run_id: runId,
        gate_id: gateId,
        choice: 'approve',
        claim_token: '',
      });
      // (a) red when the schema refuses an empty token; (b) prints the reply.
      expect(reply.status).toBe('ok');
      expect(reply.gate_claim?.proof).toBe('mismatch');
      expect((await runs().get(runId)).pending_gate).toBeUndefined();
    } finally {
      await client.close();
    }
  }, 30_000);

  it.each([
    ['an escape sequence', '\u001b[2J', 'contains a control character'],
    ['an empty name', '', 'empty'],
    ['a 300-character name', 'n'.repeat(300), 'longer than 200 characters'],
  ])(
    'responded_by with %s ⇒ the one-mint line, the answer NOT recorded',
    async (_label, name, reason) => {
      const client = await stdioClient(resolveMcpServerEntry(), [], 'by-row', 'row-by');
      try {
        const { runId, gateId } = await startGate(client);
        const reply = await call(client, 'submit_human_response', {
          run_id: runId,
          gate_id: gateId,
          choice: 'approve',
          responded_by: name,
        });
        expect(reply.status).toBe('error');
        expect(reply.error_code).toBe('VALIDATION_ACTOR_INVALID');
        expect(reply.errors).toContain(
          `responded_by: ${reason}; nothing was recorded. Give a name of at most 200 characters with no control characters, or leave it out.`,
        );
        const after = await runs().get(runId);
        expect(after.pending_gate?.gate_id).toBe(gateId);
        expect(after.evidence.some((e) => e.kind === 'gate_response')).toBe(false);
      } finally {
        await client.close();
      }
    },
    30_000,
  );
});

describe('THE CLI AFTER — `realm run respond --by`, and `realm run inspect` reading the record', () => {
  it('respond --by alice, then inspect: the question was OPENED through the server, ANSWERED by alice, no claim_token passed', async () => {
    const client = await stdioClient(resolveMcpServerEntry(), [], 'opener-row', 'row-cli');
    let runId: string;
    let gateId: string;
    try {
      ({ runId, gateId } = await startGate(client));
    } finally {
      await client.close();
    }
    const answered = await cli(
      ['run', 'respond', runId, '--gate', gateId, '--choice', 'approve', '--by', 'alice'],
      {
        REALM_OPERATOR: 'cli-row',
      },
    );
    expect(answered.code).toBe(0);
    expect(answered.stdout).toContain(`Responded: ${runId}`);
    const inspected = await cli(['run', 'inspect', runId], {});
    expect(inspected.code).toBe(0);
    // (a) red when the answer line or the opened-through line changes wording, or the answer
    //     is dropped for a one-execution gate step; (b) prints inspect's output.
    expect(inspected.stdout).toContain(
      'Question opened through: opener-row (from REALM_OPERATOR, via mcp-stdio)',
    );
    expect(inspected.stdout).toContain(
      'Answer: approve · answered by alice (as stated, not verified) · proof: no claim_token passed (the CLI never passes one; over MCP, only the conversation that opened the question has one to pass)',
    );
    expect(inspected.stdout.indexOf('Question opened through')).toBeLessThan(
      inspected.stdout.indexOf('Answer: approve'),
    );
  }, 60_000);

  it('respond without --by: the same line with `(not stated)`; nothing derived from the OS account or REALM_OPERATOR', async () => {
    const client = await stdioClient(resolveMcpServerEntry(), [], 'opener-row', 'row-cli2');
    let runId: string;
    let gateId: string;
    try {
      ({ runId, gateId } = await startGate(client));
    } finally {
      await client.close();
    }
    const answered = await cli(['run', 'respond', runId, '--gate', gateId, '--choice', 'reject'], {
      REALM_OPERATOR: 'cli-row',
    });
    expect(answered.code).toBe(0);
    const inspected = await cli(['run', 'inspect', runId], {});
    expect(inspected.stdout).toContain(
      'Answer: reject · answered by (not stated) · proof: no claim_token passed',
    );
    expect(inspected.stdout).not.toContain('answered by cli-row');
  }, 60_000);

  it('an MCP answer with no token renders the SAME door-neutral phrase as the CLI’s', async () => {
    const client = await stdioClient(resolveMcpServerEntry(), [], 'opener-row', 'row-cli3');
    let runId: string;
    try {
      const { runId: id, gateId } = await startGate(client);
      runId = id;
      await call(client, 'submit_human_response', {
        run_id: id,
        gate_id: gateId,
        choice: 'approve',
      });
    } finally {
      await client.close();
    }
    const inspected = await cli(['run', 'inspect', runId], {});
    expect(inspected.stdout).toContain(
      'proof: no claim_token passed (the CLI never passes one; over MCP, only the conversation that opened the question has one to pass)',
    );
  }, 60_000);

  it.each([
    ['an empty name', '', 'empty'],
    ['a whitespace-only name', '  ', 'empty'],
    ['an escape sequence', '\u001b[2J', 'contains a control character'],
    ['a 300-character name', 'n'.repeat(300), 'longer than 200 characters'],
  ])(
    'respond --by with %s ⇒ the one-mint line on stderr, exit 1, nothing recorded',
    async (_label, name, reason) => {
      const client = await stdioClient(resolveMcpServerEntry(), [], 'opener-row', 'row-cli4');
      let ids: { runId: string; gateId: string };
      try {
        ids = await startGate(client);
      } finally {
        await client.close();
      }
      const refused = await cli(
        ['run', 'respond', ids.runId, '--gate', ids.gateId, '--choice', 'approve', '--by', name],
        {},
      );
      expect(refused.code).toBe(1);
      expect(refused.stderr.trim().split('\n')).toEqual([
        `--by: ${reason}; nothing was recorded. Give a name of at most 200 characters with no control characters, or leave it out.`,
      ]);
      expect((await runs().get(ids.runId)).pending_gate?.gate_id).toBe(ids.gateId);
    },
    60_000,
  );
});

describe('A NAME THAT CANNOT BE USED — one line on stderr and exit 1 before anything starts', () => {
  const BAD = 'x'.repeat(201);
  const LINE = (consequence: string): string =>
    `REALM_OPERATOR: longer than 200 characters; ${consequence}. Unset it or give it a name of at most 200 characters with no control characters.`;

  it('`realm mcp`: nothing is written to stdout (a stdio server speaks only when spoken to)', async () => {
    const refused = await cli(['mcp'], { REALM_OPERATOR: BAD });
    expect(refused.code).toBe(1);
    expect(refused.stdout).toBe('');
    expect(refused.stderr.trim()).toBe(LINE('nothing was started'));
  }, 30_000);

  it('`realm run respond` says it recorded nothing — and refuses BEFORE it reads the run', async () => {
    const refused = await cli(
      ['run', 'respond', 'no-such-run', '--gate', 'g', '--choice', 'approve'],
      { REALM_OPERATOR: BAD },
    );
    expect(refused.code).toBe(1);
    // (a) red when the run is read first (a "Run not found" would print instead); (b) prints stderr.
    // The consequence says why an answer depends on REALM_OPERATOR at all (it names the program on
    // the cleanup steps the answer lets run — never the person who answered) and why it refuses on
    // a workflow with no cleanup steps (it is checked before the run is read).
    expect(refused.stderr.trim()).toBe(
      LINE(
        "it is written as the program's name on any cleanup steps the answer lets run, and respond checks it before reading the run, so nothing was recorded",
      ),
    );
  }, 30_000);

  it('`realm agent`, `realm serve` and `realm run drain` refuse the same way with their own consequence', async () => {
    for (const args of [
      ['agent', '--workflow', 'x.yaml'],
      ['serve', '--dev'],
      ['run', 'drain', 'no-such-run'],
    ]) {
      const refused = await cli(args, { REALM_OPERATOR: BAD });
      expect(refused.code, args.join(' ')).toBe(1);
      expect(refused.stderr.trim().split('\n')[0], args.join(' ')).toBe(
        LINE('nothing was started'),
      );
    }
  }, 60_000);

  it('the realm-mcp bin refuses too, before the transport opens', async () => {
    const refused = await new Promise<{ code: number; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn(process.execPath, [resolveMcpServerEntry()], {
          env: childEnv({ REALM_OPERATOR: BAD }),
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
        child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
        child.on('error', reject);
        child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
      },
    );
    expect(refused.code).toBe(1);
    expect(refused.stdout).toBe('');
    expect(refused.stderr.trim()).toBe(LINE('nothing was started'));
  }, 30_000);
});
