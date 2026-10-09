// docs-pages-625-reference.test.ts — issue #625 PR-2a, decision C174 (round 22), lane F: the rows of
// `docs/reference/mcp/tools.md` that #625 PR-2a adds or changes and that no cell quoted yet. Each
// cell quotes its sentence or its table row (whole, or from its start) word for word, asserts the
// page still holds it (read from the repository, whitespace folded), and drives the case over a real
// MCP client (`createRealmMcpServer`, in-memory transport); each example reply the page shows is
// compared with the real reply, its IDs put in place — so neither the page nor the reply can change
// alone.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  JsonFileStore,
  JsonWorkflowStore,
  createDefaultRegistry,
  loadWorkflowFromString,
  type ExtensionRegistry,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createRealmMcpServer } from '../server.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const TOOLS = 'docs/reference/mcp/tools.md';
const flat = (t: string) => t.replace(/\s+/g, ' ');

/** (a) red when the page no longer holds the sentence word for word; (b) prints the sentence. */
function claim(page: string, sentence: string): void {
  expect(
    flat(readFileSync(join(ROOT, page), 'utf8')),
    `${page} no longer says: ${sentence}`,
  ).toContain(flat(sentence));
}

/** The lines of the page's first fenced block that holds `marker`. */
function block(page: string, marker: string): string[] {
  const text = readFileSync(join(ROOT, page), 'utf8');
  const blocks = text.split(/^```[a-z]*\n/m).filter((_, i) => i % 2 === 1);
  const found = blocks.find((b) => b.includes(marker));
  if (found === undefined) throw new Error(`${page} has no block with: ${marker}`);
  return found.replace(/\n```[\s\S]*$/, '').split('\n');
}

/** The page's JSON block that holds `marker`, parsed, with each page ID replaced by the real one. */
function shown(marker: string, ids: Record<string, string>): Record<string, unknown> {
  const text = Object.entries(ids).reduce(
    (t, [from, to]) => t.replaceAll(from, to),
    block(TOOLS, marker).join('\n'),
  );
  return JSON.parse(text) as Record<string, unknown>;
}

/** The real reply cut to the fields the page's example shows, `next_actions` shown as `["…"]`. */
function asShown(real: Reply, page: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.keys(page).map((k) => [
      k,
      k === 'next_actions' && Array.isArray(real[k]) && (real[k] as unknown[]).length > 0
        ? ['…']
        : real[k],
    ]),
  );
}

type Reply = Record<string, unknown>;

async function connect(registry?: ExtensionRegistry) {
  const dir = await mkdtemp(join(tmpdir(), 'realm-pages-625-'));
  const runStore = new JsonFileStore(join(dir, 'runs'));
  const workflowStore = new JsonWorkflowStore(join(dir, 'wf'));
  const server = createRealmMcpServer({
    runStore,
    workflowStore,
    ...(registry !== undefined ? { registry } : {}),
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'docs-pages-625', version: '0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const call = async (name: string, args: Record<string, unknown>): Promise<Reply> => {
    const raw = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    const text = raw.content[0]!.text;
    try {
      return JSON.parse(text) as Reply;
    } catch {
      return { _text: text, _isError: raw.isError === true };
    }
  };
  return { call, client, runStore, workflowStore };
}

const tools = (r: Reply): string[] =>
  ((r['next_actions'] as Array<{ instruction?: { tool?: string } }>) ?? []).map(
    (n) => n.instruction?.tool ?? '',
  );

const wf = (lines: string[]): WorkflowDefinition => loadWorkflowFromString(lines.join('\n') + '\n');

/** The page's `triage`: `classify` (agent), `draft` (agent, a gate: send or discard), `send` (auto). */
const TRIAGE = wf([
  'id: triage',
  'name: triage',
  'version: 1',
  'steps:',
  '  classify:',
  '    description: Classify.',
  '    execution: agent',
  '  draft:',
  '    description: Draft.',
  '    execution: agent',
  '    depends_on: [classify]',
  '    trust: human_confirmed',
  '    gate:',
  '      choices: [send, discard]',
  '  send:',
  '    description: Send.',
  '    execution: auto',
  '    depends_on: [draft]',
]);

/** A `triage` run with its gate on `draft` open. */
async function atDraftGate(call: (n: string, a: Record<string, unknown>) => Promise<Reply>) {
  const runId = (await call('start_run', { workflow_id: 'triage' }))['run_id'] as string;
  await call('execute_step', { run_id: runId, command: 'classify', params: {} });
  const opened = await call('execute_step', { run_id: runId, command: 'draft', params: {} });
  return { runId, gateId: (opened['gate'] as { gate_id: string }).gate_id };
}

describe('#625 PR-2a, C174 lane F — tools.md rows no cell quoted yet, over a real MCP client', () => {
  it('line 15, the tools table row: advance_run is a tool, and it runs the guard and the auto steps a run owes', async () => {
    claim(
      TOOLS,
      '| [`advance_run`](#advance_run) | Runs the guards and automatic steps a run owes (added after version 0.46.0). |',
    );
    const { call, client, workflowStore, runStore } = await connect();
    await workflowStore.register(
      wf([
        'id: owes',
        'name: owes',
        'version: 1',
        'steps:',
        '  q:',
        '    description: Q.',
        '    execution: auto',
        '    trust: human_confirmed',
        '    gate:',
        '      choices: [approve, reject]',
        '  a:',
        '    description: A.',
        '    execution: auto',
        '    depends_on: [q]',
        '  check:',
        '    description: Check.',
        '    execution: guard',
        '    depends_on: [a]',
        `    abort_unless: ["q.choice == 'approve'"]`,
        '    abort_message: Stopped.',
        '  b:',
        '    description: B.',
        '    execution: auto',
        '    depends_on: [check]',
      ]),
    );
    const names = (await client.listTools()).tools.map((t) => t.name);
    // The answer runs no auto step: `a`, then the guard after it, then `b` are owed to the engine.
    const runId = (await call('start_run', { workflow_id: 'owes' }))['run_id'] as string;
    const answered = await call('submit_human_response', {
      run_id: runId,
      gate_id: (await runStore.get(runId)).pending_gate!.gate_id,
      choice: 'approve',
    });
    const r = await call('advance_run', { run_id: runId });
    // (a) red when advance_run is not a tool, or does not run the auto steps and the guard owed;
    //     (b) prints the tools and the reply's parts.
    expect([
      names.includes('advance_run'),
      tools(answered),
      r['status'],
      (r['chained_auto_steps'] as Array<{ step: string }>).map((c) => c.step),
      r['run_phase'],
    ]).toEqual([true, ['advance_run'], 'ok', ['a', 'check', 'b'], 'completed']);
  });

  it('lines 116–123, the table "A run that has ended": each tool’s row, on a completed run', async () => {
    const ROWS = {
      execute_step:
        "| `execute_step` | `ok` with `agent_action: \"stop\"`: `Run '<id>' is already terminal (<phase>); no steps executed.`, and for a run that ended with a failed step `realm run resume` takes, `'realm run resume <id> --from <step>' makes the failed step runnable again.` after it |",
      advance_run:
        "| `advance_run` | `ok` without `agent_action`: `Run '<id>' is already terminal (<phase>); nothing ran.`, and for a run that ended with a failed step `realm run resume` takes, `'realm run resume <id> --from <step>' makes the failed step runnable again.` after it |",
      submit_human_response:
        "| `submit_human_response` | `ok` without `agent_action` when it repeats the choice its gate recorded: `Gate '<gate>' was already resolved with choice '<c>' — no action was taken.`",
      append_trace:
        "| `append_trace` | Refused with `STATE_STEP_NOT_ELIGIBLE` and `report_to_user`: `Run '<id>' is terminal (phase: '<phase>') — trace entries can no longer be adopted by any step.` |",
      get_run_state:
        "| `get_run_state` | The run's state, as for a run that goes on, with `terminal_state: true` and empty `next_actions`. `resumable` names the failed steps `realm run resume` takes and its command, and `cleanup_pending` the cleanup steps left `pending` and the command that runs them (added after version 0.46.0). |",
    };
    for (const row of Object.values(ROWS)) claim(TOOLS, row);
    const { call, workflowStore } = await connect();
    await workflowStore.register(TRIAGE);
    const { runId, gateId } = await atDraftGate(call);
    await call('submit_human_response', { run_id: runId, gate_id: gateId, choice: 'send' });
    expect((await call('advance_run', { run_id: runId }))['run_phase']).toBe('completed');

    const exec = await call('execute_step', { run_id: runId, command: 'classify', params: {} });
    // (a) red when execute_step on an ended run is not ok with stop and the row's sentence;
    //     (b) prints the reply's parts.
    expect([exec['status'], exec['agent_action'], exec['context_hint']]).toEqual([
      'ok',
      'stop',
      `Run '${runId}' is already terminal (completed); no steps executed.`,
    ]);
    const adv = await call('advance_run', { run_id: runId });
    // (a) red when advance_run on an ended run carries agent_action or another sentence; (b) prints it.
    expect([adv['status'], 'agent_action' in adv, adv['context_hint']]).toEqual([
      'ok',
      false,
      `Run '${runId}' is already terminal (completed); nothing ran.`,
    ]);
    const same = await call('submit_human_response', {
      run_id: runId,
      gate_id: gateId,
      choice: 'send',
    });
    // (a) red when repeating the recorded choice is refused, carries agent_action, or says
    //     another sentence; (b) prints the reply's parts.
    expect([same['status'], 'agent_action' in same, same['context_hint']]).toEqual([
      'ok',
      false,
      `Gate '${gateId}' was already resolved with choice 'send' — no action was taken.`,
    ]);
    const trace = await call('append_trace', {
      run_id: runId,
      step_id: 'classify',
      entries: [{ event: 'late' }],
    });
    // (a) red when append_trace on an ended run is not refused as the row says; (b) prints it.
    expect([trace['error_code'], trace['agent_action'], trace['errors']]).toEqual([
      'STATE_STEP_NOT_ELIGIBLE',
      'report_to_user',
      [
        `Run '${runId}' is terminal (phase: 'completed') — trace entries can no longer be adopted by any step.`,
      ],
    ]);
    const state = await call('get_run_state', { run_id: runId });
    // (a) red when get_run_state on an ended run is not its state with terminal_state and no
    //     next_actions; (b) prints the reply's parts.
    expect([
      state['run_id'],
      state['run_phase'],
      state['terminal_state'],
      state['next_actions'],
    ]).toEqual([runId, 'completed', true, []]);
  });

  it('line 122, the abandon_run row: a completed, aborted or failed run is refused with STATE_RUN_TERMINAL; an abandoned run is not, its note begins already abandoned', async () => {
    claim(
      TOOLS,
      "| `abandon_run` | A completed, aborted or failed run is refused with `STATE_RUN_TERMINAL` and `report_to_user`: `Run '<id>' is already terminal (<phase>); cannot abandon a finished run.` An abandoned run is not refused: the reply is the one [`abandon_run`](#abandon_run) gives, and its `note` begins `already abandoned (no change this call).` |",
    );
    const registry = createDefaultRegistry();
    registry.register('handler', 'boom', {
      id: 'boom',
      async execute() {
        throw new Error('boom');
      },
    } as never);
    const { call, workflowStore, runStore } = await connect(registry);
    await workflowStore.register(TRIAGE);
    await workflowStore.register(
      wf([
        'id: ends',
        'name: ends',
        'version: 1',
        'steps:',
        '  q:',
        '    description: Q.',
        '    execution: auto',
        '    trust: human_confirmed',
        '    gate:',
        '      choices: [approve, reject]',
        '  check:',
        '    description: Check.',
        '    execution: guard',
        '    depends_on: [q]',
        `    abort_unless: ["q.choice == 'approve'"]`,
        '    abort_message: Stopped.',
      ]),
    );
    await workflowStore.register(
      wf([
        'id: fails',
        'name: fails',
        'version: 1',
        'steps:',
        '  go:',
        '    description: Go.',
        '    execution: auto',
        '    handler: boom',
      ]),
    );
    // completed
    const done = await atDraftGate(call);
    await call('submit_human_response', {
      run_id: done.runId,
      gate_id: done.gateId,
      choice: 'send',
    });
    await call('advance_run', { run_id: done.runId });
    // aborted: the guard after the question stops the run on `reject`
    const aborted = (await call('start_run', { workflow_id: 'ends' }))['run_id'] as string;
    await call('submit_human_response', {
      run_id: aborted,
      gate_id: (await runStore.get(aborted)).pending_gate!.gate_id,
      choice: 'reject',
    });
    // failed: its only step's handler throws
    const failed = (await call('start_run', { workflow_id: 'fails' }))['run_id'] as string;
    for (const [runId, phase] of [
      [done.runId, 'completed'],
      [aborted, 'aborted'],
      [failed, 'failed'],
    ] as const) {
      const r = await call('abandon_run', { run_id: runId });
      // (a) red when an ended run of this phase is abandoned, or refused otherwise; (b) prints it.
      expect([r['error_code'], r['agent_action'], r['errors']], phase).toEqual([
        'STATE_RUN_TERMINAL',
        'report_to_user',
        [`Run '${runId}' is already terminal (${phase}); cannot abandon a finished run.`],
      ]);
    }
    const open = (await call('start_run', { workflow_id: 'triage' }))['run_id'] as string;
    const first = await call('abandon_run', { run_id: open });
    const again = await call('abandon_run', { run_id: open });
    // (a) red when an abandoned run is refused, or the second reply's note does not begin so;
    //     (b) prints both replies' parts.
    expect([
      first['run_phase'],
      again['run_phase'],
      again['terminal_state'],
      'error_code' in again,
    ]).toEqual(['abandoned', 'abandoned', true, false]);
    expect(again['note']).toMatch(/^already abandoned \(no change this call\)\./);
  });

  it('line 374, the refusal row: the gate was answered with another choice — STATE_BLOCKED, the choice not recorded', async () => {
    claim(
      TOOLS,
      "| The gate was answered with another choice | `STATE_BLOCKED` | `Gate '70d76b3b-…' was already resolved with choice 'send' — your choice 'discard' was not recorded.` See below. |",
    );
    const { call, workflowStore, runStore } = await connect();
    await workflowStore.register(TRIAGE);
    const { runId, gateId } = await atDraftGate(call);
    await call('submit_human_response', { run_id: runId, gate_id: gateId, choice: 'send' });
    const r = await call('submit_human_response', {
      run_id: runId,
      gate_id: gateId,
      choice: 'discard',
    });
    // (a) red when another choice is not refused with STATE_BLOCKED and the row's message, or is
    //     recorded; (b) prints the reply's parts and the record.
    expect([r['error_code'], r['errors']]).toEqual([
      'STATE_BLOCKED',
      [
        `Gate '${gateId}' was already resolved with choice 'send' — your choice 'discard' was not recorded.`,
      ],
    ]);
    expect((await runStore.get(runId)).settled?.['draft']?.choice).toBe('send');
  });

  it('line 215, start_run’s example reply: the real reply, its run ID put in place', async () => {
    claim(
      TOOLS,
      "\"context_hint\": \"Run '7da561ee-5987-497d-83a5-1eded6dc9b63' created for workflow 'triage'. Ready for the agent: 'classify'.\",",
    );
    const { call, workflowStore } = await connect();
    await workflowStore.register(TRIAGE);
    const r = await call('start_run', { workflow_id: 'triage' });
    const page = shown('"command": "start_run"', {
      '7da561ee-5987-497d-83a5-1eded6dc9b63': r['run_id'] as string,
    });
    // (a) red when a field the example shows differs from the real reply (the run ID aside);
    //     (b) prints both.
    expect(asShown(r, page)).toEqual(page);
  });

  it('lines 243–259, start_run_batch’s example reply: the real reply, its run IDs put in place', async () => {
    claim(TOOLS, '"run_id": "2f22727f-1709-4a9d-8f04-a325cbee6c59",');
    claim(TOOLS, '"run_id": "98d5e6f1-e0f7-4609-8907-de70a11b3e62",');
    claim(
      TOOLS,
      "\"context_hint\": \"Run '2f22727f-1709-4a9d-8f04-a325cbee6c59' created for workflow 'triage'. Ready for the agent: 'classify'.\"",
    );
    claim(
      TOOLS,
      "\"context_hint\": \"Run '98d5e6f1-e0f7-4609-8907-de70a11b3e62' created for workflow 'triage'. Ready for the agent: 'classify'.\"",
    );
    const { call, workflowStore } = await connect();
    await workflowStore.register(TRIAGE);
    const r = await call('start_run_batch', {
      workflow_id: 'triage',
      items: [
        { params: { ticket: 201 }, idempotency_key: 'ticket-201' },
        { params: { ticket: 202 } },
      ],
    });
    const started = r['started'] as Reply[];
    const page = shown('"idempotency_key": "ticket-201"', {
      '2f22727f-1709-4a9d-8f04-a325cbee6c59': started[0]!['run_id'] as string,
      '98d5e6f1-e0f7-4609-8907-de70a11b3e62': started[1]!['run_id'] as string,
    });
    const pageStarted = page['started'] as Array<Record<string, unknown>>;
    // (a) red when an entry's field differs from the page's (run IDs aside), or an item fails;
    //     (b) prints both.
    expect({
      started: started.map((s, i) => asShown(s, pageStarted[i]!)),
      failed: r['failed'],
    }).toEqual(page);
  });

  it('line 553, create_workflow’s example reply: the real reply, its run and workflow IDs put in place', async () => {
    claim(
      TOOLS,
      "\"context_hint\": \"Run '05ae1756-2fe6-4152-91d1-e1ce1c381083' created for workflow 'release-notes-88c897726fbda006'.",
    );
    const { call } = await connect();
    const r = await call('create_workflow', {
      steps: [
        { id: 'collect', description: 'Collect the merged changes.' },
        { id: 'write', description: 'Write the notes.', depends_on: ['collect'] },
      ],
      metadata: { name: 'release-notes' },
    });
    const workflowId = (r['data'] as { workflow_id: string }).workflow_id;
    const page = shown('"command": "create_workflow"', {
      '05ae1756-2fe6-4152-91d1-e1ce1c381083': r['run_id'] as string,
      'release-notes-88c897726fbda006': workflowId,
    });
    // (a) red when a field the example shows differs from the real reply (IDs aside), or the
    //     made-up ID loses its slug; (b) prints both.
    expect([workflowId, asShown(r, page)]).toEqual([
      expect.stringMatching(/^release-notes-[0-9a-f]{16}$/),
      page,
    ]);
  });

  it('lines 611–613, advance_run’s parameter row: run_id, a string, required', async () => {
    claim(TOOLS, '| `run_id` | string | yes | The run. |');
    const { call, client } = await connect();
    const tool = (await client.listTools()).tools.find((t) => t.name === 'advance_run')!;
    const without = await call('advance_run', {});
    // (a) red when advance_run's run_id is not a required string, or a call without it is not
    //     refused by the MCP layer; (b) prints the schema and the reply.
    expect([tool.inputSchema.properties, tool.inputSchema.required]).toEqual([
      { run_id: { type: 'string' } },
      ['run_id'],
    ]);
    expect(without).toEqual({
      _text:
        'MCP error -32602: Input validation error: Invalid arguments for tool advance_run: Required at run_id',
      _isError: true,
    });
  });

  it('lines 617–622, the act in next_actions: the real act after an answer leaves an auto step owed, the run ID put in place', async () => {
    claim(TOOLS, 'The act in `next_actions` reads:');
    claim(TOOLS, '"tool": "advance_run",');
    const { call, workflowStore, runStore } = await connect();
    await workflowStore.register(
      wf([
        'id: approval',
        'name: approval',
        'version: 1',
        'steps:',
        '  review:',
        '    description: Review.',
        '    execution: auto',
        '    trust: human_confirmed',
        '    gate:',
        '      choices: [approve, reject]',
        '  post_approval:',
        '    description: Post the approval.',
        '    execution: auto',
        '    depends_on: [review]',
      ]),
    );
    const runId = (await call('start_run', { workflow_id: 'approval' }))['run_id'] as string;
    const r = await call('submit_human_response', {
      run_id: runId,
      gate_id: (await runStore.get(runId)).pending_gate!.gate_id,
      choice: 'approve',
    });
    const page = shown('"tool": "advance_run"', { '<run>': runId });
    // (a) red when the act differs from the page's (the run ID aside), or is not the last entry;
    //     (b) prints both.
    expect([tools(r).at(-1), (r['next_actions'] as unknown[]).at(-1)]).toEqual([
      'advance_run',
      page,
    ]);
  });
});
