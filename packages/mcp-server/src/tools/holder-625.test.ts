// holder-625.test.ts — issue #625 (the holder slice, PR-H): the MCP tools' half.
//
//   * `start_run` / `execute_step` pass the host's `driver` to the claim; the reply that opens a
//     question hands the claim's token out (ONE door), and `get_run_state` shows who took each step
//     — never the token.
//   * `submit_human_response` takes the token back as `claim_token`, never requires it, names
//     unknown arguments, bounds `responded_by` exactly as the CLI bounds `--by`, and reports the
//     verdict on every ok reply.
//   * the protocol text tells the model to copy `call_with`.
//
// Handler cells call the exported handler against real stores in scratch directories; the cells that
// need the REGISTERED tool (the SDK's argument handling, `tools/list`) go through an in-memory
// client. Real stdio and the `realm-mcp` bin are celled in the CLI package's journeys. No `$HOME`.
// Each assertion carries (a) the change that turns it red and (b) what it prints on failure —
// synthetic ids and tokens only.
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { JsonFileStore, JsonWorkflowStore, CURRENT_WORKFLOW_SCHEMA_VERSION } from '@sensigo/realm';
import type { Attributed, ResponseEnvelope, WorkflowDefinition } from '@sensigo/realm';
import { handleStartRun } from './start-run.js';
import {
  handleSubmitHumanResponse,
  registerSubmitHumanResponse,
  unknownKeyWarnings,
} from './submit-human-response.js';
import { handleGetRunState } from './get-run-state.js';
import { handleAbandonRun } from './abandon-run.js';
import { generateProtocol } from '../protocol/generator.js';
import { createRealmMcpServer } from '../server.js';

const DRIVER: Attributed = { by: 'server@host', by_source: 'derived', channel: 'mcp-stdio' };

const definition: WorkflowDefinition = {
  id: 'holder-mcp-wf',
  name: 'Holder MCP',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    'step-one': {
      description: 'Auto step with a gate',
      execution: 'auto',
      trust: 'human_confirmed',
      gate: { choices: ['approve', 'reject'] },
    },
    finish: { description: 'Finish', execution: 'agent', depends_on: ['step-one'] },
  },
};

let runStore: JsonFileStore;
let workflowStore: JsonWorkflowStore;

beforeEach(async () => {
  runStore = new JsonFileStore(await mkdtemp(join(tmpdir(), 'realm-holder-mcp-run-')));
  workflowStore = new JsonWorkflowStore(await mkdtemp(join(tmpdir(), 'realm-holder-mcp-wf-')));
  await workflowStore.register(definition);
});

interface Opened {
  runId: string;
  gateId: string;
  token: string;
  reply: ResponseEnvelope;
}

/** Starts the run (the gate opens in the chained reply), taken by `driver`. */
async function openGate(driver: Attributed | null = DRIVER): Promise<Opened> {
  const reply = await handleStartRun(
    { workflow_id: definition.id },
    { runStore, workflowStore, ...(driver !== null ? { driver } : {}) },
  );
  const run = await runStore.get(reply.run_id);
  return {
    runId: reply.run_id,
    gateId: run.pending_gate!.gate_id,
    token: reply.gate?.claim_token ?? '',
    reply,
  };
}

/** One in-memory client against the REGISTERED submit_human_response tool. */
async function withTool<T>(
  fn: (client: Client) => Promise<T>,
  driver: Attributed | null = DRIVER,
): Promise<T> {
  const server = new McpServer({ name: 'test', version: '0' });
  registerSubmitHumanResponse(server, {
    runStore,
    workflowStore,
    ...(driver !== null ? { driver } : {}),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0' });
  await client.connect(clientTransport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

async function callTool(
  client: Client,
  args: Record<string, unknown>,
): Promise<ResponseEnvelope & Record<string, unknown>> {
  const result = await client.callTool({ name: 'submit_human_response', arguments: args });
  const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
  return JSON.parse(text) as ResponseEnvelope & Record<string, unknown>;
}

describe('the opening reply hands the claim’s token out — ONE door — and the claim names the program', () => {
  it('start_run: gate.claim_token and both instruction renderings carry the same token; the claim names the driver', async () => {
    const o = await openGate();
    expect(o.token).not.toBe('');
    const action = o.reply.next_actions[0]!;
    // (a) red when the opening reply stops carrying the token, or carries it in only one rendering;
    //     (b) prints the reply’s actions (synthetic ids only).
    expect((action.instruction as { params: Record<string, unknown> }).params['claim_token']).toBe(
      o.token,
    );
    expect(
      (action.instruction as { call_with: Record<string, unknown> }).call_with['claim_token'],
    ).toBe(o.token);
    const run = await runStore.get(o.runId);
    expect(run.claims?.['step-one']?.holder).toEqual(DRIVER);
    expect(typeof run.claims?.['step-one']?.since).toBe('string');
    expect(run.claims?.['step-one']?.token).toBe(o.token);
  });

  it('start_run with NO driver: the claim carries since and no holder; the token is still handed out', async () => {
    const o = await openGate(null);
    expect(o.token).not.toBe('');
    const claim = (await runStore.get(o.runId)).claims!['step-one']!;
    expect('holder' in claim).toBe(false);
    expect(typeof claim.since).toBe('string');
  });
});

describe('submit_human_response — the verdict on every ok reply, the answer decided by the gate id alone', () => {
  it('the token passed back: matched, the opener named, no sentence', async () => {
    const o = await openGate();
    const reply = await handleSubmitHumanResponse(
      { run_id: o.runId, gate_id: o.gateId, choice: 'approve', claim_token: o.token },
      { runStore, workflowStore },
    );
    expect(reply.status).toBe('ok');
    expect(reply.gate_claim).toEqual({ proof: 'matched', opened_by: DRIVER });
    expect(reply.warnings).toEqual([]);
  });

  it('no token: absent, the answer recorded, ONE sentence', async () => {
    const o = await openGate();
    const reply = await handleSubmitHumanResponse(
      { run_id: o.runId, gate_id: o.gateId, choice: 'approve' },
      { runStore, workflowStore },
    );
    expect(reply.status).toBe('ok');
    expect(reply.gate_claim?.proof).toBe('absent');
    expect(reply.warnings).toEqual([
      'No claim_token was passed; the answer was recorded. Only the conversation that opened the question has one to pass.',
    ]);
    expect((await runStore.get(o.runId)).pending_gate).toBeUndefined();
  });

  it('a wrong token and the EMPTY token: mismatch, and the answer is recorded all the same', async () => {
    for (const wrong of ['not-the-token', '']) {
      const o = await openGate();
      const reply = await handleSubmitHumanResponse(
        { run_id: o.runId, gate_id: o.gateId, choice: 'approve', claim_token: wrong },
        { runStore, workflowStore },
      );
      // (a) red when a wrong token refuses or alters the answer; (b) prints the reply’s status.
      expect(reply.status).toBe('ok');
      expect(reply.gate_claim?.proof).toBe('mismatch');
      expect((await runStore.get(o.runId)).pending_gate).toBeUndefined();
    }
  });
});

describe('the REGISTERED tool — the SDK’s argument handling, never a reason to lose an answer', () => {
  it('an empty claim_token over the tool is accepted (no minimum length) and judged mismatch', async () => {
    const o = await openGate();
    const reply = await withTool((client) =>
      callTool(client, { run_id: o.runId, gate_id: o.gateId, choice: 'approve', claim_token: '' }),
    );
    // (a) red when the schema gains `.min(1)` — the SDK would answer MCP error -32602 and record
    //     nothing; (b) prints the status.
    expect(reply.status).toBe('ok');
    expect(reply.gate_claim?.proof).toBe('mismatch');
    expect((await runStore.get(o.runId)).pending_gate).toBeUndefined();
  });

  it('a misnamed `claimToken`: absent, and the reply names the key and the near miss', async () => {
    const o = await openGate();
    const reply = await withTool((client) =>
      callTool(client, {
        run_id: o.runId,
        gate_id: o.gateId,
        choice: 'approve',
        claimToken: o.token,
      }),
    );
    expect(reply.status).toBe('ok');
    expect(reply.gate_claim?.proof).toBe('absent');
    expect(reply.warnings).toContain(
      "submit_human_response: unknown argument 'claimToken' was ignored — did you mean 'claim_token'?",
    );
  });

  it('an unrelated unknown key is named, with no near miss', async () => {
    const o = await openGate();
    const reply = await withTool((client) =>
      callTool(client, { run_id: o.runId, gate_id: o.gateId, choice: 'approve', whatever: 1 }),
    );
    expect(reply.warnings).toContain(
      "submit_human_response: unknown argument 'whatever' was ignored.",
    );
  });

  it('unknownKeyWarnings: the explicit alias map reaches `token` (the house closestKey cannot)', () => {
    expect(unknownKeyWarnings({ run_id: 'r', token: 't' })).toEqual([
      "submit_human_response: unknown argument 'token' was ignored — did you mean 'claim_token'?",
    ]);
    expect(unknownKeyWarnings({ run_id: 'r', choice: 'a' })).toEqual([]);
  });

  it('tools/list: the claim_token and responded_by descriptions are visible, and claim_token has no minimum', async () => {
    const tools = await withTool((client) => client.listTools());
    const tool = tools.tools.find((t) => t.name === 'submit_human_response')!;
    const props = (tool.inputSchema as { properties: Record<string, Record<string, unknown>> })
      .properties;
    expect(props['claim_token']!['description']).toBe(
      'The value from gate.claim_token on the reply that opened this question. Pass it back unchanged; it shows this answer comes from the conversation that opened the question. Never required.',
    );
    expect(props['responded_by']!['description']).toBe(
      'Who made the choice, as the caller states it — not verified. At most 200 characters, no control characters.',
    );
    expect(props['claim_token']!['minLength']).toBeUndefined();
    expect((tool.inputSchema as { required?: string[] }).required).not.toContain('claim_token');
  });
});

describe('responded_by is bounded exactly as `realm run respond --by` is — refused before anything is recorded', () => {
  const REFUSAL = (reason: string): string =>
    `responded_by: ${reason}; nothing was recorded. Give a name of at most 200 characters with no control characters, or leave it out.`;

  it.each([
    ['a control character', '\u001b[2J', 'contains a control character'],
    ['an empty name', '', 'empty'],
    ['a whitespace-only name', '   ', 'empty'],
    ['a 201-character name', 'x'.repeat(201), 'longer than 200 characters'],
  ])(
    '%s ⇒ the one-mint line, VALIDATION_ACTOR_INVALID, the answer NOT recorded',
    async (_label, name, reason) => {
      const o = await openGate();
      const reply = await withTool((client) =>
        callTool(client, {
          run_id: o.runId,
          gate_id: o.gateId,
          choice: 'approve',
          responded_by: name,
        }),
      );
      // (a) red when the tool stores a name the CLI refuses; (b) prints the refusal and the run.
      expect(reply.status).toBe('error');
      expect((reply as unknown as { errors: string[] }).errors).toContain(REFUSAL(reason));
      expect((reply as unknown as { error_code?: string }).error_code).toBe(
        'VALIDATION_ACTOR_INVALID',
      );
      const after = await runStore.get(o.runId);
      expect(after.pending_gate?.gate_id).toBe(o.gateId);
      expect(after.evidence.filter((e) => e.kind === 'gate_response')).toEqual([]);
    },
  );

  it('a good name is stored as given and read back by get_run_state as a stated name', async () => {
    const o = await openGate();
    await handleSubmitHumanResponse(
      { run_id: o.runId, gate_id: o.gateId, choice: 'approve', responded_by: 'alice' },
      { runStore, workflowStore },
    );
    const summary = await handleGetRunState(
      { run_id: o.runId, include_steps: true },
      { runStore, workflowStore },
    );
    expect(summary.steps?.['step-one']?.answers?.[0]?.answered_by).toEqual({
      by: 'alice',
      by_source: 'stated',
    });
  });
});

describe('get_run_state — who took each step; the token has one door and this is not it', () => {
  it('step_claims names the driver and the time, and no byte of the token appears anywhere', async () => {
    const o = await openGate();
    const summary = await handleGetRunState(
      { run_id: o.runId, include_steps: true },
      { runStore, workflowStore },
    );
    expect(summary.step_claims).toEqual([
      { step: 'step-one', holder: DRIVER, since: expect.any(String) },
    ]);
    // (a) red when step_claims (or any field) starts carrying the token; (b) prints the response.
    expect(JSON.stringify(summary)).not.toContain(o.token);
  });

  it('a claim written with no driver: holder_not_recorded, the time kept', async () => {
    const o = await openGate(null);
    const summary = await handleGetRunState({ run_id: o.runId }, { runStore, workflowStore });
    expect(summary.step_claims).toEqual([
      {
        step: 'step-one',
        holder: { by: null, absent_cause: 'holder_not_recorded' },
        since: expect.any(String),
      },
    ]);
  });

  it('a HAND-PLANTED holder carrying an escape sequence is withheld: name_unreadable, never the string', async () => {
    const o = await openGate();
    const run = await runStore.get(o.runId);
    await runStore.update({
      ...run,
      claims: {
        ...run.claims,
        'step-one': {
          ...run.claims!['step-one']!,
          holder: { by: '\u001b[2Jevil', by_source: 'stated', channel: 'x' },
        },
      },
    });
    const summary = await handleGetRunState({ run_id: o.runId }, { runStore, workflowStore });
    expect(summary.step_claims?.[0]?.holder).toEqual({ by: null, absent_cause: 'name_unreadable' });
    expect(JSON.stringify(summary)).not.toContain('evil');
  });

  it('after the answer: steps.<step>.answers names the answerer and the proof, as data', async () => {
    const o = await openGate();
    await handleSubmitHumanResponse(
      { run_id: o.runId, gate_id: o.gateId, choice: 'approve', claim_token: o.token },
      { runStore, workflowStore },
    );
    const summary = await handleGetRunState(
      { run_id: o.runId, include_steps: true },
      { runStore, workflowStore },
    );
    expect(summary.steps?.['step-one']?.answers).toEqual([
      {
        choice: 'approve',
        answered_by: { by: null, absent_cause: 'not_stated' },
        claim_proof: { proof: 'matched' },
      },
    ]);
  });
});

describe('createRealmMcpServer({ driver }) threads the program’s name to the tools', () => {
  it('a run started through the SERVER’S start_run carries the server’s identity on its claim', async () => {
    const server = createRealmMcpServer({ runStore, workflowStore, driver: DRIVER });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test-client', version: '0' });
    await client.connect(clientTransport);
    try {
      const result = await client.callTool({
        name: 'start_run',
        arguments: { workflow_id: definition.id },
      });
      const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
      const reply = JSON.parse(text) as ResponseEnvelope;
      expect((await runStore.get(reply.run_id)).claims?.['step-one']?.holder).toEqual(DRIVER);
    } finally {
      await client.close();
    }
  });
});

describe('the protocol text tells the model to copy the call', () => {
  it('rule 2 and the per-step gate text both say to copy next_actions[0].instruction.call_with', () => {
    const protocol = generateProtocol(definition);
    const text = JSON.stringify(protocol);
    // (a) red when either sentence goes back to naming the tool and its arguments; (b) prints it.
    expect(
      protocol.rules.some((r) =>
        r.includes('copying the call in next_actions[0].instruction.call_with'),
      ),
    ).toBe(true);
    expect(text).toContain('by copying the call in `next_actions[0].instruction.call_with`');
  });
});

describe('CLAIM_TOKEN_ONE_DOOR — on the MCP surface the token is where the opening reply puts it, and nowhere else', () => {
  it('start_run’s opening reply carries it in EXACTLY three places; chained_auto_steps and every other field carry none', async () => {
    const o = await openGate();
    // (a) red when a fourth place (chained_auto_steps, context_hint, a finding) starts carrying it;
    //     (b) prints the count.
    expect(JSON.stringify(o.reply).split(o.token).length - 1).toBe(3);
    expect(JSON.stringify(o.reply.chained_auto_steps ?? [])).not.toContain(o.token);
  });

  it('abandon_run’s refusal (the run waits at a gate) names no token', async () => {
    const o = await openGate();
    const outcome = await handleAbandonRun({ run_id: o.runId }, { runStore }).then(
      () => 'resolved',
      (err: unknown) => err,
    );
    expect(outcome).not.toBe('resolved');
    const err = outcome as Error & { details?: unknown };
    expect(JSON.stringify({ message: err.message, details: err.details })).not.toContain(o.token);
  });
});

describe('the answer as data — an answer-only step, a planted name, a long name', () => {
  async function planted(extra: Record<string, unknown>, withExecution = true) {
    const o = await openGate();
    await handleSubmitHumanResponse(
      { run_id: o.runId, gate_id: o.gateId, choice: 'approve' },
      { runStore, workflowStore },
    );
    const run = await runStore.get(o.runId);
    await runStore.update({
      ...run,
      evidence: run.evidence
        .filter((e) => withExecution || e.kind === 'gate_response')
        .map((e) => (e.kind === 'gate_response' ? { ...e, ...extra } : e)),
    });
    return handleGetRunState({ run_id: o.runId, include_steps: true }, { runStore, workflowStore });
  }

  it('a step with an answer and NO execution entry still has a view: attempts [] and the answer', async () => {
    const summary = await planted({ responded_by: 'alice' }, false);
    expect(summary.steps?.['step-one']).toEqual({
      attempts: [],
      answers: [
        {
          choice: 'approve',
          answered_by: { by: 'alice', by_source: 'stated' },
          claim_proof: { proof: 'absent' },
        },
      ],
    });
  });

  it('a HAND-PLANTED responded_by with an escape sequence is withheld: name_unreadable, never the string', async () => {
    const summary = await planted({ responded_by: '\u001b[2Jevil' });
    expect(summary.steps?.['step-one']?.answers?.[0]?.answered_by).toEqual({
      by: null,
      absent_cause: 'name_unreadable',
    });
    expect(JSON.stringify(summary)).not.toContain('evil');
  });

  it('a HAND-PLANTED 300-character name is shown capped with the house marker, not withheld', async () => {
    const summary = await planted({ responded_by: 'n'.repeat(300) });
    expect(summary.steps?.['step-one']?.answers?.[0]?.answered_by).toEqual({
      by: `${'n'.repeat(200)}…[truncated]`,
      by_source: 'stated',
    });
  });
});
