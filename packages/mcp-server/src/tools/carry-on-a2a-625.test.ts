// carry-on-a2a-625.test.ts — #625 PR-2b unit A2a (prompt feat-625-a2a-carry-on.md), the MCP door: an
// answer through `submit_human_response` that passes back the opening reply's claim_token carries the
// run on in the same call, starting no step later than 240 seconds after the call began.
//
// Check 9 runs a real `realm-mcp` over stdio under `REALM_MCP_GATE_ANSWERS=permitted` (the one setting
// that lists the answer tool); checks 5 and 6 at the door run in process, the door's clock injected.
// Synthetic ids and tokens only. Each assertion carries the two questions of
// `~/.claude/TESTING-RULES.md` rule 8: (a) the change that turns it red; (b) what it prints.
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  abandonRun,
  createDefaultRegistry,
  judgeFormWait,
  judgeGateAnswers,
  type Attributed,
  type StepDefinition,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { printChildrenWhenATestFails } from '../test-support/child-output.js';
import { makeTempHome, type TempHome } from '../test-support/temp-home.js';
import { McpDoor } from '../door.js';
import { handleStartRun } from './start-run.js';
import { handleSubmitHumanResponse } from './submit-human-response.js';

const SERVER_ENTRY = fileURLToPath(new URL('../../dist/bin.js', import.meta.url));
if (!existsSync(SERVER_ENTRY)) {
  throw new Error(`mcp-server dist not built — run the build first (looked for: ${SERVER_ENTRY})`);
}
const children = printChildrenWhenATestFails();

const DRIVER: Attributed = { by: 'server@host', by_source: 'derived', channel: 'mcp-stdio' };

type Reply = Record<string, unknown> & {
  status: string;
  run_id?: string;
  run_phase?: string;
  context_hint?: string;
  warnings?: string[];
  error_code?: string;
  gate_claim?: Record<string, unknown>;
  chained_auto_steps?: Array<{ step: string }>;
  next_actions?: Array<{
    instruction: { tool: string; call_with: Record<string, unknown> } | null;
  }>;
};

const wf = (id: string, steps: Record<string, StepDefinition>): WorkflowDefinition => ({
  id,
  name: id,
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps,
});
const gate = (depends_on: string[], choices = ['approve', 'reject']): StepDefinition => ({
  description: 'Confirm.',
  execution: 'auto',
  trust: 'human_confirmed',
  depends_on,
  gate: { choices },
});
const auto = (depends_on: string[]): StepDefinition => ({
  description: 'Auto.',
  execution: 'auto',
  depends_on,
});

/** gate `confirm`, then `send` (auto): the run ends with `send`. */
const SEND = wf('carry-on-send', { confirm: gate([]), send: auto(['confirm']) });
/** gate `confirm`, then `a` (auto), then gate `review`, then agent step `finish`. */
const TWO_GATES = wf('carry-on-two-gates', {
  confirm: gate([]),
  a: auto(['confirm']),
  review: gate(['a'], ['ship', 'hold']),
  finish: { description: 'Finish.', execution: 'agent', depends_on: ['review'] },
});

const OWED_SEND = "Owed to the engine: 'send' — call advance_run.";
const occurrences = (text: string, part: string) => text.split(part).length - 1;

// ---------------------------------------------------------------------------------------------
// Check 9 — end to end, over stdio
// ---------------------------------------------------------------------------------------------

async function withServer<T>(
  defs: WorkflowDefinition[],
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'realm-carry-on-a2a-'));
  const h = await makeTempHome({ home: join(home, '.realm') });
  for (const d of defs) await h.stores.workflowStore.register(d);
  const client = new Client({ name: 'carry-on-a2a', version: '0' });
  await client.connect(
    children.watch(
      'the MCP server',
      new StdioClientTransport({
        command: process.execPath,
        args: [SERVER_ENTRY],
        env: { ...process.env, HOME: home, REALM_MCP_GATE_ANSWERS: 'permitted' } as Record<
          string,
          string
        >,
        stderr: 'pipe',
      }),
    ),
  );
  try {
    return await fn(client);
  } finally {
    await client.close();
    await h.cleanup();
    rmSync(home, { recursive: true, force: true });
  }
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<Reply> {
  const result = (await client.callTool({ name, arguments: args })) as {
    content: Array<{ text?: string }>;
  };
  return JSON.parse(result.content[0]?.text ?? '{}') as Reply;
}

/** The answer instruction the opening reply carries, as the agent copies it. */
const answerOf = (opened: Reply): Record<string, unknown> => {
  const action = opened.next_actions?.[0]?.instruction;
  if (action?.tool !== 'submit_human_response') throw new Error('fixture: no answer instruction');
  return { ...action.call_with, choice: 'approve' };
};

describe('#625 PR-2b A2a check 9 — end to end over stdio, REALM_MCP_GATE_ANSWERS=permitted', () => {
  it('an answer with the opening reply’s token runs the steps in the one call; without it, proof_absent and the owed sentence names advance_run', async () => {
    await withServer([SEND], async (client) => {
      const first = await call(client, 'start_run', { workflow_id: SEND.id });
      const carried = await call(client, 'submit_human_response', answerOf(first));
      const second = await call(client, 'start_run', { workflow_id: SEND.id });
      const { claim_token: _token, ...withoutToken } = answerOf(second);
      const owed = await call(client, 'submit_human_response', withoutToken);
      // (a) red when the token's answer leaves `send` owed (no carry-on), or the token-less answer
      //     runs it or stops naming advance_run (once); (b) prints the fields of both replies.
      expect({
        carried: {
          phase: carried.run_phase,
          claim: carried.gate_claim?.['carried_on'],
          chained: carried.chained_auto_steps?.map((c) => c.step),
          owedNamed: occurrences(carried.context_hint ?? '', 'advance_run'),
          next: carried.next_actions?.map((a) => a.instruction?.tool),
        },
        owed: {
          phase: owed.run_phase,
          claim: [owed.gate_claim?.['carried_on'], owed.gate_claim?.['not_carried_on_because']],
          owedSentence: occurrences(owed.context_hint ?? '', OWED_SEND),
          next: owed.next_actions?.map((a) => a.instruction?.tool),
          warning: owed.warnings,
        },
      }).toEqual({
        carried: { phase: 'completed', claim: true, chained: ['send'], owedNamed: 0, next: [] },
        owed: {
          phase: 'running',
          claim: [false, 'proof_absent'],
          owedSentence: 1,
          next: ['advance_run'],
          warning: [
            'No claim_token was passed; the answer was recorded. Only the conversation that opened the question has one to pass. The run was not carried on in this call.',
          ],
        },
      });
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Checks 5 and 6 at the door — in process
// ---------------------------------------------------------------------------------------------

describe('#625 PR-2b A2a checks 5 and 6 — the answer tool', () => {
  const homes: TempHome[] = [];
  afterEach(async () => {
    for (const h of homes.splice(0)) await h.cleanup();
  });
  /** A `permitted` door whose clock reads `now()` (milliseconds). */
  const doorAt = (now: () => number): McpDoor => {
    const answers = judgeGateAnswers({ option: 'permitted' });
    const wait = judgeFormWait({});
    if (!answers.ok || !wait.ok) throw new Error('fixture: the settings judge');
    return new McpDoor({
      gateAnswers: answers.setting,
      formWait: wait.setting,
      sendsForms: false,
      monotonicNow: now,
    });
  };
  const opened = async (
    def: WorkflowDefinition,
    registry: ReturnType<typeof createDefaultRegistry> = createDefaultRegistry(),
  ) => {
    const h = await makeTempHome();
    homes.push(h);
    await h.stores.workflowStore.register(def);
    // A server always has a registry (createRealmMcpServer's default); a direct handler call is given one.
    const stores = { ...h.stores, driver: DRIVER, registry };
    const reply = await handleStartRun({ workflow_id: def.id }, stores);
    const { record } = await h.stores.runStore.get(reply.run_id);
    return {
      h,
      stores,
      runId: reply.run_id,
      gateId: record.pending_gate!.gate_id,
      token: String(reply.next_actions[0]?.instruction?.params['claim_token'] ?? ''),
    };
  };

  it('check 5: 240 seconds after the call began, no step starts — the reply says why, and the owed sentence names advance_run once', async () => {
    const o = await opened(SEND);
    let now = 1_000_000;
    const door = doorAt(() => now);
    const started = now;
    now += 240_001;
    const reply = (await handleSubmitHumanResponse(
      { run_id: o.runId, gate_id: o.gateId, choice: 'approve', claim_token: o.token },
      { ...o.stores, door },
      { started },
    )) as unknown as Reply;
    const { record } = await o.h.stores.runStore.get(o.runId);
    // (a) red when the tool passes no budget (or another cap, or not from the call's start): `send`
    //     runs; or the reply stops naming what is owed; (b) prints the fields.
    expect({
      done: record.completed_steps,
      stopped: reply.gate_claim?.['chain_stopped'],
      owedSentence: occurrences(reply.context_hint ?? '', OWED_SEND),
      warnings: reply.warnings,
    }).toEqual({
      done: ['confirm'],
      stopped: 'budget',
      owedSentence: 1,
      warnings: [
        "This call's time ran out after 'confirm'; the run was not carried further in this call.",
      ],
    });
  });

  it('check 5: inside the 240 seconds the steps run — the cap is not spent at the call’s start', async () => {
    const o = await opened(SEND);
    const now = 5_000;
    const reply = (await handleSubmitHumanResponse(
      { run_id: o.runId, gate_id: o.gateId, choice: 'approve', claim_token: o.token },
      { ...o.stores, door: doorAt(() => now + 239_000) },
      { started: now },
    )) as unknown as Reply;
    // (a) red when the cap is smaller than 240 seconds, or measured from another start; (b) prints
    //     the phase and the claim.
    expect([reply.run_phase, reply.gate_claim?.['chain_stopped']]).toEqual([
      'completed',
      undefined,
    ]);
  });

  it('check 6: a question the carry-on reaches is handed on with its own token — the reply is not held back, the answer’s token nowhere', async () => {
    const o = await opened(TWO_GATES);
    const reply = (await handleSubmitHumanResponse(
      { run_id: o.runId, gate_id: o.gateId, choice: 'approve', claim_token: o.token },
      o.stores,
    )) as unknown as Reply;
    const next = reply.next_actions?.[0]?.instruction;
    const fresh = String(next?.call_with['claim_token'] ?? '');
    // (a) red when the merge copies the answer's token (the egress check holds the reply back as
    //     ENGINE_INTERNAL) or the new question loses its token; (b) prints the fields (tokens are
    //     synthetic and compared, never printed).
    expect({
      status: reply.status,
      code: reply.error_code,
      tool: next?.tool,
      fresh: fresh.length > 0 && fresh !== o.token,
      oldTokenAnywhere: JSON.stringify(reply).includes(o.token),
      carried: reply.gate_claim?.['carried_on'],
    }).toEqual({
      status: 'confirm_required',
      code: undefined,
      tool: 'submit_human_response',
      fresh: true,
      oldTokenAnywhere: false,
      carried: true,
    });
  });

  it('MA 2’s cell: a carried-on reply whose continuation meets another program ending the run says how it ended, once', async () => {
    // `a` runs in the carry-on; while it runs another program abandons the run (a `run_ended` race).
    // Set once the run exists: the handler ends that run.
    const target: { runId?: string; store?: Parameters<typeof abandonRun>[0] } = {};
    const registry = createDefaultRegistry();
    registry.register('handler', 'end_it', {
      id: 'end_it',
      execute: async () => {
        await abandonRun(target.store!, target.runId!, 'another program');
        return { data: {} };
      },
    } as never);
    const def = wf('carry-on-ended', {
      confirm: gate([]),
      a: { description: 'A.', execution: 'auto', depends_on: ['confirm'], handler: 'end_it' },
      finish: { description: 'Finish.', execution: 'agent', depends_on: ['a'] },
    });
    const o = await opened(def, registry);
    target.runId = o.runId;
    target.store = o.h.stores.runStore;
    const reply = (await handleSubmitHumanResponse(
      { run_id: o.runId, gate_id: o.gateId, choice: 'approve', claim_token: o.token },
      o.stores,
    )) as unknown as Reply;
    const said = 'It was abandoned, with the reason "another program".';
    // (a) red when the tail never says how the run ended on a carried-on reply (item 6 dropped), or
    //     says it twice; (b) prints the count, the phase and the claim.
    expect({
      said: occurrences(reply.context_hint ?? '', said),
      phase: reply.run_phase,
      carried: reply.gate_claim?.['carried_on'],
    }).toEqual({ said: 1, phase: 'abandoned', carried: true });
  });
});
