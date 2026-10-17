// t22-729.test.ts — issue #729 PR-0 (D4 T-22; the owner, 2026-10-15): an `ok` reply on an open run
// whose rendered list holds nothing callable takes D-8 row 4's tail — `report_to_user`, or `await`
// (with `poll_after_ms`) when the only blocker is a step held elsewhere. On W2's workflow (#745's walk,
// `plans/issue-688/walk-745-raw.md`: an agent step, then a mapped step whose input the agent's answer
// does not supply), the three replies that meet the stuck run say `report_to_user`; the negatives
// (an ended run; a step in flight elsewhere) never do. The protocol's `report_to_user` sentence is
// held to the reply that produces it, claim by claim.
//
// Red-first by ONE break: D-8 row 2 restored to `none` (agentActionOf's T-22 tail removed).
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure: tool
// names, statuses, action words and booleans — never a value a run holds.
import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  JsonFileStore,
  JsonWorkflowStore,
  ExtensionRegistry,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createRealmMcpServer } from '../server.js';
import { generateProtocol } from '../protocol/generator.js';

/** W2: `summarize` (agent), then `publish` — its input built by its map from `summarize`'s answer. */
const W2: WorkflowDefinition = {
  id: 'w2-t22',
  name: 'w2',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    summarize: { description: 'Summarize the text.', execution: 'agent', depends_on: [] },
    publish: {
      description: 'Publish.',
      execution: 'auto',
      depends_on: ['summarize'],
      handler: 'h',
      input_map: { text: 'context.resources.summarize.summary' },
      input_schema: {
        type: 'object',
        required: ['text'],
        properties: { text: { type: 'string' } },
      },
    },
  },
} as WorkflowDefinition;

type Reply = Record<string, unknown>;

async function connect() {
  const dir = await mkdtemp(join(tmpdir(), 'realm-t22-729-'));
  const runStore = new JsonFileStore(join(dir, 'runs'));
  const workflowStore = new JsonWorkflowStore(join(dir, 'wf'));
  const registry = new ExtensionRegistry();
  registry.register('handler', 'h', {
    id: 'h',
    execute: async (i) => ({ data: { got: i.params } }),
  });
  await workflowStore.register(W2);
  const server = createRealmMcpServer({ runStore, workflowStore, registry });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 't22-729', version: '0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const call = async (name: string, args: Record<string, unknown>): Promise<Reply> => {
    const raw = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ text: string }>;
    };
    return JSON.parse(raw.content[0]!.text) as Reply;
  };
  return { call, runStore };
}

const tools = (r: Reply): string[] =>
  ((r['next_actions'] as Array<{ instruction?: { tool?: string } | null }>) ?? []).map(
    (n) => n.instruction?.tool ?? 'null',
  );

/** A W2 run whose agent step was answered without `summary`: `publish` cannot run. */
async function stuck(h: Awaited<ReturnType<typeof connect>>) {
  const started = await h.call('start_run', { workflow_id: W2.id });
  const runId = started['run_id'] as string;
  const firstMeet = await h.call('execute_step', {
    run_id: runId,
    command: 'summarize',
    params: { other: 'x' },
  });
  return { runId, firstMeet };
}

describe('#729 PR-0 — T-22 on W2’s workflow: an ok reply on a run that cannot go on', () => {
  it('the first-meet reply (execute_step completing the agent step): ok, nothing callable, report_to_user', async () => {
    const h = await connect();
    const { firstMeet } = await stuck(h);
    // (a) red when row 2 gives an ok reply no word on an open run with nothing callable (the
    //     0.47.0 reply: no agent_action, `walk-745-raw.md:84`); (b) prints status, tools, word.
    expect([firstMeet['status'], tools(firstMeet), firstMeet['agent_action']]).toEqual([
      'ok',
      [],
      'report_to_user',
    ]);
    // A-1's S7 cell: ending the run is never a next step — `abandon_run` renders in `also`, outside
    // `next_actions`. (a) red when abandon is rendered as a progress way; (b) prints the verbs.
    const also =
      (firstMeet['also'] as Array<{ verb: string; instruction?: { tool?: string } }>) ?? [];
    expect({
      inNext: tools(firstMeet).includes('abandon_run'),
      also: also.map((a) => `${a.verb}:${a.instruction?.tool ?? 'null'}`),
    }).toEqual({ inNext: false, also: ['inspect:get_run_state', 'abandon:abandon_run'] });
  });

  it('advance_run on that run ("nothing ran"): report_to_user', async () => {
    const h = await connect();
    const { runId } = await stuck(h);
    const r = await h.call('advance_run', { run_id: runId });
    // (a) red when row 2 restores none; (b) prints status, tools, word.
    expect([r['status'], tools(r), r['agent_action']]).toEqual(['ok', [], 'report_to_user']);
    expect(String(r['context_hint'])).toContain('nothing ran');
  });

  it('get_run_state on that run: report_to_user', async () => {
    const h = await connect();
    const { runId } = await stuck(h);
    const r = await h.call('get_run_state', { run_id: runId });
    // (a) red when the read gives no word; (b) prints tools and word.
    expect([tools(r), r['agent_action']]).toEqual([[], 'report_to_user']);
  });

  it('NEGATIVE: an ok reply on a run that has ended — stop or none, never report_to_user (C154)', async () => {
    const h = await connect();
    const started = await h.call('start_run', { workflow_id: W2.id });
    const runId = started['run_id'] as string;
    const done = await h.call('execute_step', {
      run_id: runId,
      command: 'summarize',
      params: { summary: 'hello' },
    });
    const again = await h.call('execute_step', { run_id: runId, command: 'summarize', params: {} });
    // (a) red when T-22 fires on an ended run; (b) prints the phases and words.
    expect([done['run_phase'], done['agent_action'], again['agent_action']]).toEqual([
      'completed',
      undefined,
      'stop',
    ]);
  });

  it('NEGATIVE: an ok reply whose only blocker is a step in flight elsewhere — await with poll_after_ms, never report_to_user', async () => {
    const h = await connect();
    const started = await h.call('start_run', { workflow_id: W2.id });
    const runId = started['run_id'] as string;
    await h.runStore.claimStep(runId, 'summarize', W2);
    const r = await h.call('advance_run', { run_id: runId });
    // (a) red when a held step reads as report_to_user, or the pace is dropped; (b) prints status,
    //     tools, word and the pace.
    expect([r['status'], tools(r), r['agent_action'], r['poll_after_ms']]).toEqual([
      'ok',
      [],
      'await',
      30_000,
    ]);
    expect(String(r['context_hint'])).toContain(
      "No step is ready: 'summarize' is in flight elsewhere",
    );
  });

  it('the protocol’s report_to_user sentence, claim by claim, on the reply that produces it', async () => {
    const sentence =
      'It also comes on an `ok` reply when the run cannot go on and only a person can change that: nothing can be called, and `context_hint` names the step, the check that refused it and the way out — tell the user.';
    // (a) red when the protocol drops the sentence; (b) prints whether it is there.
    expect(generateProtocol(W2).error_handling['report_to_user']?.includes(sentence)).toBe(true);
    const h = await connect();
    const { firstMeet } = await stuck(h);
    const hint = String(firstMeet['context_hint']);
    // (a) red when any claim outgrows the reply: something callable, or the hint missing the step,
    //     the check or the way out; (b) prints each claim's truth.
    expect({
      word: firstMeet['agent_action'],
      nothingCallable: tools(firstMeet).length === 0,
      namesStep: hint.includes("'publish'"),
      namesCheck: hint.includes('(input_schema)'),
      namesWayOut: hint.includes(
        'correct its input_map or its input_schema and register the workflow again',
      ),
    }).toEqual({
      word: 'report_to_user',
      nothingCallable: true,
      namesStep: true,
      namesCheck: true,
      namesWayOut: true,
    });
  });
});
