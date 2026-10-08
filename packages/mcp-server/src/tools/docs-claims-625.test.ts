// docs-claims-625.test.ts — issue #625 PR-2a, decision C163 (the method): each sentence about reply
// behaviour that #625 PR-2a adds or changes in `docs/reference/mcp/tools.md` and
// `docs/reference/workflow/gates.md` is pinned here, one cell per tool and case it covers. Each
// cell quotes its sentence exactly and asserts the page still holds it (read from the repository),
// then drives the case over a real MCP client (`createRealmMcpServer`, in-memory transport) and
// asserts what the sentence states — so neither the page nor the behaviour can change alone.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  JsonFileStore,
  JsonWorkflowStore,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  executeStep,
  loadWorkflowFromString,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createRealmMcpServer } from '../server.js';

const DOCS = join(dirname(fileURLToPath(import.meta.url)), '../../../../docs/reference');
const flat = (t: string) => t.replace(/\s+/g, ' ');

/** (a) red when the page no longer holds the sentence word for word; (b) prints the sentence. */
function claim(
  page: 'mcp/tools.md' | 'workflow/gates.md' | 'core-library.md',
  sentence: string,
): void {
  expect(
    flat(readFileSync(join(DOCS, page), 'utf8')),
    `${page} no longer says: ${sentence}`,
  ).toContain(flat(sentence));
}

type Reply = Record<string, unknown> & { _isError?: boolean; _text?: string };

async function connect() {
  const dir = await mkdtemp(join(tmpdir(), 'realm-docs-625-'));
  const runStore = new JsonFileStore(join(dir, 'runs'));
  const workflowStore = new JsonWorkflowStore(join(dir, 'wf'));
  const server = createRealmMcpServer({ runStore, workflowStore });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'docs-claims-625', version: '0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const call = async (name: string, args: Record<string, unknown>): Promise<Reply> => {
    const raw = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    const text = raw.content[0]!.text;
    try {
      return { ...(JSON.parse(text) as Record<string, unknown>), _isError: raw.isError === true };
    } catch {
      return { _text: text, _isError: raw.isError === true };
    }
  };
  return { call, runStore, workflowStore, dir };
}

const next = (r: Reply): string[] =>
  (
    (r['next_actions'] as Array<{
      instruction?: { tool?: string; params?: Record<string, unknown> };
    }>) ?? []
  ).map((n) => `${n.instruction?.tool}:${String(n.instruction?.params?.['command'] ?? '')}`);

/** `confirm` (a question; `on_expiry` as given, 1 s), then a bare `auto` step `after`. */
function gated(id: string, onExpiry?: 'settle_default' | 'abort'): WorkflowDefinition {
  return {
    id,
    name: id,
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps: {
      confirm: {
        description: 'Confirm.',
        execution: 'auto',
        trust: 'human_confirmed',
        depends_on: [],
        gate: {
          choices: ['approve', 'reject'],
          ...(onExpiry !== undefined ? { timeout_seconds: 1, on_expiry: onExpiry } : {}),
          ...(onExpiry === 'settle_default' ? { default_choice: 'approve' } : {}),
        },
      },
      after: { description: 'After.', execution: 'auto', depends_on: ['confirm'] },
    },
  } as WorkflowDefinition;
}

/** An agent step `ask` whose answer must be `{ n: integer }`. */
const SCHEMA: WorkflowDefinition = {
  id: 'docs-schema',
  name: 'docs-schema',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    ask: {
      description: 'Ask.',
      execution: 'agent',
      depends_on: [],
      input_schema: { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] },
    },
  },
} as WorkflowDefinition;

/**
 * `a` (agent) → `b` (agent); `skipme` (auto, `when: a.go == true`); `fails` (auto, reads the file
 * `run.params.path` names — a missing one fails it, and the run goes on).
 */
const STEPS: WorkflowDefinition = loadWorkflowFromString(
  [
    'id: docs-steps',
    'name: docs-steps',
    'version: 1',
    'services:',
    '  files:',
    '    adapter: filesystem',
    '    trust: engine_delivered',
    'steps:',
    '  a:',
    '    description: A.',
    '    execution: agent',
    '  b:',
    '    description: B.',
    '    execution: agent',
    '    depends_on: [a]',
    '  skipme:',
    '    description: S.',
    '    execution: auto',
    '    depends_on: [a]',
    "    when: 'a.go == true'",
    '  fails:',
    '    description: F.',
    '    execution: auto',
    '    depends_on: [a]',
    '    uses_service: files',
    '    operation: read',
    '    input_map:',
    '      path: run.params.path',
    '',
  ].join('\n'),
);

/** A completed run of `gated('docs-ended')`: its gate answered `approve`, `after` ran. */
async function endedRun() {
  const h = await connect();
  await h.workflowStore.register(gated('docs-ended'));
  const s = await h.call('start_run', { workflow_id: 'docs-ended' });
  const runId = s['run_id'] as string;
  const gateId = (await h.runStore.get(runId)).pending_gate!.gate_id;
  await h.call('submit_human_response', { run_id: runId, gate_id: gateId, choice: 'approve' });
  const done = await h.call('advance_run', { run_id: runId });
  expect(done['run_phase'], 'fixture: the run did not complete').toBe('completed');
  return { ...h, runId, gateId };
}

const RUN_ID_ROW =
  'The run: the ID the call named, also when no run has that ID (the refusal is `STATE_RUN_NOT_FOUND`).';
const RUN_VERSION_ZERO =
  '`0` when the reply names no run\'s state: a run ID that does not exist, and every refusal that replies `run_id: ""`.';
const RUN_VERSION_PRESENT = 'Yes, except on a refusal from `get_run_state` or `abandon_run`';
const EMPTY_RUN_ID =
  'Empty (`""`) when `start_run`, `start_run_batch` or `create_workflow` refuses the call, which then makes no run: a workflow that is not registered (`STATE_WORKFLOW_NOT_FOUND`), params its `params_schema` refuses (`VALIDATION_INPUT_SCHEMA` from `start_run`, `VALIDATION_BATCH_ITEMS` from `start_run_batch`), a batch over `max_items` (`VALIDATION_BATCH_TOO_LARGE`), an `idempotency_key` that a run still going holds when `on_live_match` is `fail` (`STATE_RUN_ALREADY_ACTIVE`, whose `errors` name that run), and `create_workflow` refusing its steps.';

describe('#625 PR-2a, C163 — tools.md: the reply table, sentence by sentence, over a real MCP client', () => {
  it.each([
    ['execute_step', { command: 'a', params: {} }],
    ['submit_human_response', { gate_id: 'g', choice: 'approve' }],
    ['advance_run', {}],
    ['append_trace', { step_id: 'a', entries: [] }],
    ['get_run_state', {}],
    ['abandon_run', {}],
  ] as const)(
    'C163 run_id/run_version, a run ID that does not exist — %s: the ID named, STATE_RUN_NOT_FOUND, run_version 0 (absent from get_run_state and abandon_run)',
    async (tool, args) => {
      claim('mcp/tools.md', RUN_ID_ROW);
      claim('mcp/tools.md', RUN_VERSION_ZERO);
      claim('mcp/tools.md', RUN_VERSION_PRESENT);
      const { call } = await connect();
      const r = await call(tool, { run_id: 'no-such-run', ...args });
      // (a) red when the reply empties the ID, uses another code, or reports a version; (b) prints it.
      expect({ run_id: r['run_id'], error_code: r['error_code'], status: r['status'] }).toEqual({
        run_id: 'no-such-run',
        error_code: 'STATE_RUN_NOT_FOUND',
        status: 'error',
      });
      if (tool === 'get_run_state' || tool === 'abandon_run')
        expect('run_version' in r).toBe(false);
      else expect(r['run_version']).toBe(0);
    },
  );

  it.each([
    ['start_run, a workflow that is not registered', 'STATE_WORKFLOW_NOT_FOUND'],
    ['start_run, params its params_schema refuses', 'VALIDATION_INPUT_SCHEMA'],
    ['start_run_batch, a workflow that is not registered', 'STATE_WORKFLOW_NOT_FOUND'],
    ['start_run_batch, an item its params_schema refuses', 'VALIDATION_BATCH_ITEMS'],
    ['start_run_batch, a batch over max_items', 'VALIDATION_BATCH_TOO_LARGE'],
    [
      'start_run, an idempotency_key a run still going holds, on_live_match fail',
      'STATE_RUN_ALREADY_ACTIVE',
    ],
    ['create_workflow refusing its steps', undefined],
  ] as const)('C162, W4-Y2: run_id "" and run_version 0 — %s', async (kase, code) => {
    claim('mcp/tools.md', EMPTY_RUN_ID);
    claim('mcp/tools.md', RUN_VERSION_ZERO);
    const { call, workflowStore, runStore } = await connect();
    const ps = {
      ...gated('docs-ps'),
      params_schema: {
        type: 'object',
        properties: { total: { type: 'number' } },
        required: ['total'],
      },
    } as WorkflowDefinition;
    await workflowStore.register(ps);
    await workflowStore.register(gated('docs-live'));
    let r: Reply;
    let owner: string | undefined;
    switch (kase) {
      case 'start_run, a workflow that is not registered':
        r = await call('start_run', { workflow_id: 'nope' });
        break;
      case 'start_run, params its params_schema refuses':
        r = await call('start_run', { workflow_id: 'docs-ps', params: { total: 'x' } });
        break;
      case 'start_run_batch, a workflow that is not registered':
        r = await call('start_run_batch', { workflow_id: 'nope', items: [{ params: {} }] });
        break;
      case 'start_run_batch, an item its params_schema refuses':
        r = await call('start_run_batch', {
          workflow_id: 'docs-ps',
          items: [{ params: { total: 'x' } }],
        });
        break;
      case 'start_run_batch, a batch over max_items':
        r = await call('start_run_batch', {
          workflow_id: 'docs-live',
          items: [{ params: {} }, { params: {} }],
          max_items: 1,
        });
        break;
      case 'start_run, an idempotency_key a run still going holds, on_live_match fail':
        owner = (await call('start_run', { workflow_id: 'docs-live', idempotency_key: 'k' }))[
          'run_id'
        ] as string;
        r = await call('start_run', {
          workflow_id: 'docs-live',
          idempotency_key: 'k',
          on_live_match: 'fail',
        });
        break;
      default:
        r = await call('create_workflow', {
          name: 'dup',
          steps: [
            { id: 'x', description: 'x' },
            { id: 'x', description: 'y' },
          ],
        });
    }
    // (a) red when such a refusal names a run or a version, or its code changes; (b) prints it.
    expect({
      status: r['status'],
      run_id: r['run_id'],
      run_version: r['run_version'],
      code: r['error_code'],
    }).toEqual({
      status: 'error',
      run_id: '',
      run_version: 0,
      code,
    });
    if (owner !== undefined) {
      expect(String((r['errors'] as string[])[0])).toContain(owner);
      expect((await runStore.list()).length).toBe(1);
    }
  });

  it('C161, W4-Y1: a schema refusal replies the number from before its write; the next reply that reads the run shows one at least one higher', async () => {
    claim(
      'mcp/tools.md',
      "A refusal of an agent step's answer for its `input_schema` or `output_schema` (`VALIDATION_INPUT_SCHEMA`, `VALIDATION_OUTPUT_SCHEMA`) counts the refusal on the run, a write, and replies the number from before that write, so the next reply that reads the run shows a number at least one higher even when nothing else changed it.",
    );
    const { call, workflowStore, runStore } = await connect();
    await workflowStore.register(SCHEMA);
    const runId = (await call('start_run', { workflow_id: SCHEMA.id }))['run_id'] as string;
    const first = await call('execute_step', { run_id: runId, command: 'ask', params: { n: 'x' } });
    const stored = (await runStore.get(runId)).version;
    const second = await call('execute_step', {
      run_id: runId,
      command: 'ask',
      params: { n: 'x' },
    });
    // (a) red when the refusal stops writing its count, or replies the number after it; (b) prints them.
    expect({ code: first['error_code'], reply: first['run_version'], stored }).toEqual({
      code: 'VALIDATION_INPUT_SCHEMA',
      reply: stored - 1,
      stored,
    });
    expect(second['run_version'] as number).toBeGreaterThanOrEqual(
      (first['run_version'] as number) + 1,
    );
  });

  it('C163 run_version: the refusal that uses up the limit (VALIDATION_EXHAUSTED) replies the number after its writes', async () => {
    claim(
      'mcp/tools.md',
      "The refusal that uses up the step's limit (`VALIDATION_EXHAUSTED`) replies the number after its writes.",
    );
    const { call, workflowStore, runStore } = await connect();
    await workflowStore.register(SCHEMA);
    const runId = (await call('start_run', { workflow_id: SCHEMA.id }))['run_id'] as string;
    let r: Reply = {};
    for (let i = 0; i < 10 && r['error_code'] !== 'VALIDATION_EXHAUSTED'; i += 1) {
      r = await call('execute_step', { run_id: runId, command: 'ask', params: { n: 'x' } });
    }
    // (a) red when the exhausting refusal reports a number from before its writes; (b) prints it.
    expect({ code: r['error_code'], reply: r['run_version'] }).toEqual({
      code: 'VALIDATION_EXHAUSTED',
      reply: (await runStore.get(runId)).version,
    });
  });

  it('C163 error_code: on an error — except create_workflow refusing its steps, whose errors say what is wrong', async () => {
    claim(
      'mcp/tools.md',
      "On an error, except `create_workflow`'s refusal of its steps (its `errors` say what is wrong) and an `abandon_run` refusal of an error that carries no code",
    );
    const { call } = await connect();
    const r = await call('create_workflow', {
      name: 'dup',
      steps: [
        { id: 'x', description: 'x' },
        { id: 'x', description: 'y' },
      ],
    });
    // (a) red when create_workflow's refusal gains a code, or loses its errors; (b) prints it.
    expect({ status: r['status'], has_code: 'error_code' in r, errors: r['errors'] }).toEqual({
      status: 'error',
      has_code: false,
      errors: ["Duplicate step id: 'x'"],
    });
    const nf = await call('execute_step', { run_id: 'nope', command: 'a', params: {} });
    expect(nf['error_code']).toBe('STATE_RUN_NOT_FOUND');
  });

  it.each(['abandon_run'])(
    'C163 error_code: a %s refusal of an error that carries no code (a record that is not JSON) has none',
    async (tool) => {
      claim(
        'mcp/tools.md',
        "On an error, except `create_workflow`'s refusal of its steps (its `errors` say what is wrong) and an `abandon_run` refusal of an error that carries no code",
      );
      const { call, dir } = await connect();
      mkdirSync(join(dir, 'runs'), { recursive: true });
      writeFileSync(join(dir, 'runs', 'broken.json'), '{not json');
      const r = await call(tool, { run_id: 'broken' });
      // (a) red when such a refusal invents a code; (b) prints it.
      expect({ status: r['status'], has_code: 'error_code' in r, run_id: r['run_id'] }).toEqual({
        status: 'error',
        has_code: false,
        run_id: 'broken',
      });
    },
  );

  it('C163 agent_action: on every error and blocked reply; never on confirm_required', async () => {
    claim('mcp/tools.md', 'On every `error` and `blocked` reply.');
    claim('mcp/tools.md', 'Never on `confirm_required`');
    const { call, workflowStore } = await connect();
    await workflowStore.register(gated('docs-aa'));
    await workflowStore.register(STEPS);
    const opened = await call('start_run', { workflow_id: 'docs-aa' });
    const error = await call('execute_step', { run_id: 'nope', command: 'a', params: {} });
    const runId = (await call('start_run', { workflow_id: STEPS.id, params: { path: '/x' } }))[
      'run_id'
    ] as string;
    const blocked = await call('execute_step', { run_id: runId, command: 'b', params: {} });
    // (a) red when an error or a blocked reply drops it, or the question's reply gains one; (b) prints them.
    expect([
      [opened['status'], 'agent_action' in opened],
      [error['status'], typeof error['agent_action']],
      [blocked['status'], typeof blocked['agent_action']],
    ]).toEqual([
      ['confirm_required', false],
      ['error', 'string'],
      ['blocked', 'string'],
    ]);
  });
});

describe('#625 PR-2a, C154 — tools.md and gates.md: every tool on a run that has ended, as measured', () => {
  const ENDED_ROW =
    "Never on `confirm_required`, and never on another `ok` reply: on a run that has ended, `advance_run` replies `ok` without it, and so does `submit_human_response` repeating the choice its gate recorded (`… was already resolved with choice '<c>' — no action was taken.`, or the expiry's sentence when the question's expiry recorded it).";
  const OK_STOP =
    'On an `ok` reply only as `stop`: from `execute_step` on a run that has already ended, and from a call whose guard step finds the run ended by another process meanwhile';

  it('C154 execute_step: ok with stop, no steps executed', async () => {
    claim('mcp/tools.md', OK_STOP);
    claim(
      'mcp/tools.md',
      '`ok` with `agent_action: "stop"`: `Run \'<id>\' is already terminal (<phase>); no steps executed.`',
    );
    const { call, runId } = await endedRun();
    const r = await call('execute_step', { run_id: runId, command: 'after', params: {} });
    // (a) red when the reply changes status, action or words; (b) prints it.
    expect([r['status'], r['agent_action'], r['context_hint']]).toEqual([
      'ok',
      'stop',
      `Run '${runId}' is already terminal (completed); no steps executed.`,
    ]);
  });

  it('C154 advance_run: ok without agent_action, nothing ran', async () => {
    claim('mcp/tools.md', ENDED_ROW);
    claim(
      'mcp/tools.md',
      "`ok` without `agent_action`: `Run '<id>' is already terminal (<phase>); nothing ran.`",
    );
    const { call, runId } = await endedRun();
    const r = await call('advance_run', { run_id: runId });
    expect([r['status'], 'agent_action' in r, r['context_hint']]).toEqual([
      'ok',
      false,
      `Run '${runId}' is already terminal (completed); nothing ran.`,
    ]);
  });

  it('C154, W4-R1 submit_human_response repeating the recorded choice: ok without agent_action, no action taken', async () => {
    claim('mcp/tools.md', ENDED_ROW);
    claim(
      'mcp/tools.md',
      "`ok` without `agent_action` when it repeats the choice its gate recorded: `Gate '<gate>' was already resolved with choice '<c>' — no action was taken.`",
    );
    const { call, runId, gateId } = await endedRun();
    const r = await call('submit_human_response', {
      run_id: runId,
      gate_id: gateId,
      choice: 'approve',
    });
    expect([r['status'], 'agent_action' in r, r['context_hint']]).toEqual([
      'ok',
      false,
      `Gate '${gateId}' was already resolved with choice 'approve' — no action was taken.`,
    ]);
  });

  it.each(['reject', 'maybe'])(
    "C154, W4-R1 submit_human_response, any other choice ('%s') on the gate that recorded one: STATE_BLOCKED, report_to_user",
    async (choice) => {
      claim(
        'mcp/tools.md',
        "Any other choice on that gate is refused with `STATE_BLOCKED`: `… your choice '<other>' was not recorded.`",
      );
      claim(
        'mcp/tools.md',
        "`Gate '70d76b3b-…' was already resolved with choice 'send' — your choice 'discard' was not recorded.`",
      );
      claim('mcp/tools.md', 'Each refusal carries `report_to_user`.');
      const { call, runId, gateId } = await endedRun();
      const r = await call('submit_human_response', { run_id: runId, gate_id: gateId, choice });
      expect([r['status'], r['error_code'], r['agent_action'], r['context_hint']]).toEqual([
        'error',
        'STATE_BLOCKED',
        'report_to_user',
        `Gate '${gateId}' was already resolved with choice 'approve' — your choice '${choice}' was not recorded.`,
      ]);
    },
  );

  it('C154, W4-R1 submit_human_response, another gate ID: STATE_RUN_TERMINAL, report_to_user', async () => {
    claim(
      'mcp/tools.md',
      "Another gate ID, or the gate of a question that recorded no choice (its `on_expiry: abort` ended the run), is refused with `STATE_RUN_TERMINAL`: `Run '<id>' is terminal (<phase>); cannot submit a gate response — …`, ending with the way out for that kind of ending:",
    );
    const { call, runId } = await endedRun();
    const r = await call('submit_human_response', {
      run_id: runId,
      gate_id: 'another',
      choice: 'approve',
    });
    expect([r['status'], r['error_code'], r['agent_action'], r['command']]).toEqual([
      'error',
      'STATE_RUN_TERMINAL',
      'report_to_user',
      'submit_gate',
    ]);
    // decision C170: a completed run — nothing is owed, and `realm run resume` (which refuses it) is not offered.
    expect(r['context_hint']).toBe(
      `Run '${runId}' is terminal (completed); cannot submit a gate response — it completed, and nothing is owed.`,
    );
  });

  it('C154 submit_human_response on the gate of a question whose abort ended the run: STATE_RUN_TERMINAL, without answer_recorded (gates.md)', async () => {
    claim(
      'mcp/tools.md',
      "Another gate ID, or the gate of a question that recorded no choice (its `on_expiry: abort` ended the run), is refused with `STATE_RUN_TERMINAL`: `Run '<id>' is terminal (<phase>); cannot submit a gate response — …`, ending with the way out for that kind of ending:",
    );
    claim(
      'workflow/gates.md',
      'An answer that arrives after something else carried out the abort is refused with `STATE_RUN_TERMINAL`, without that field — as is every answer to a question that recorded no choice on a run that has ended',
    );
    const { call, workflowStore, runStore } = await connect();
    await workflowStore.register(gated('docs-abort', 'abort'));
    const runId = (await call('start_run', { workflow_id: 'docs-abort' }))['run_id'] as string;
    const gateId = (await runStore.get(runId)).pending_gate!.gate_id;
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const carried = await call('advance_run', { run_id: runId });
    expect(carried['run_phase'], 'fixture: the abort was not carried out').toBe('aborted');
    const r = await call('submit_human_response', {
      run_id: runId,
      gate_id: gateId,
      choice: 'approve',
    });
    expect([r['status'], r['error_code'], r['agent_action'], 'answer_recorded' in r]).toEqual([
      'error',
      'STATE_RUN_TERMINAL',
      'report_to_user',
      false,
    ]);
  });

  it('C154 append_trace: STATE_STEP_NOT_ELIGIBLE, report_to_user', async () => {
    claim(
      'mcp/tools.md',
      "Refused with `STATE_STEP_NOT_ELIGIBLE` and `report_to_user`: `Run '<id>' is terminal (phase: '<phase>') — trace entries can no longer be adopted by any step.`",
    );
    const { call, runId } = await endedRun();
    const r = await call('append_trace', { run_id: runId, step_id: 'after', entries: [] });
    expect([r['status'], r['error_code'], r['agent_action'], (r['errors'] as string[])[0]]).toEqual(
      [
        'error',
        'STATE_STEP_NOT_ELIGIBLE',
        'report_to_user',
        `Run '${runId}' is terminal (phase: 'completed') — trace entries can no longer be adopted by any step.`,
      ],
    );
  });

  it('C154 abandon_run: STATE_RUN_TERMINAL, report_to_user', async () => {
    claim(
      'mcp/tools.md',
      "A completed, aborted or failed run is refused with `STATE_RUN_TERMINAL` and `report_to_user`: `Run '<id>' is already terminal (<phase>); cannot abandon a finished run.`",
    );
    const { call, runId } = await endedRun();
    const r = await call('abandon_run', { run_id: runId });
    expect([r['status'], r['error_code'], r['agent_action'], (r['errors'] as string[])[0]]).toEqual(
      [
        'error',
        'STATE_RUN_TERMINAL',
        'report_to_user',
        `Run '${runId}' is already terminal (completed); cannot abandon a finished run.`,
      ],
    );
  });

  it('C154 get_run_state: the run state, terminal_state true, next_actions empty', async () => {
    claim(
      'mcp/tools.md',
      "The run's state, as for a run that goes on, with `terminal_state: true` and empty `next_actions`.",
    );
    const { call, runId } = await endedRun();
    const r = await call('get_run_state', { run_id: runId });
    expect([r['run_id'], r['terminal_state'], r['next_actions'], r['run_phase']]).toEqual([
      runId,
      true,
      [],
      'completed',
    ]);
  });
});

describe('#625 PR-2a, C163 — tools.md: blocked and resolve_precondition, sentence by sentence', () => {
  async function atB() {
    const h = await connect();
    await h.workflowStore.register(STEPS);
    const runId = (
      await h.call('start_run', { workflow_id: STEPS.id, params: { path: '/no/such/file-625' } })
    )['run_id'] as string;
    await h.call('execute_step', { run_id: runId, command: 'a', params: { go: false } });
    await h.call('advance_run', { run_id: runId });
    return { ...h, runId };
  }

  it.each([
    ['completed', 'it has already completed'],
    ['skipped', 'it was skipped'],
    ['failed', 'it has already failed'],
  ] as const)(
    'C148/C160: a step that has %s is refused — resolve_precondition, the reason, the ready step offered — and does not run again',
    async (kind, why) => {
      claim(
        'mcp/tools.md',
        'The step you called does not run again if it has already completed or been skipped; one that has failed runs again only after [`realm run resume --from <step>`](../cli/realm-run-acting.md#resume) makes it runnable, and `resume` takes only a run that has ended (`failed` or `abandoned`): while the run goes on, end it first with `abandon_run`;',
      );
      const { call, runStore, runId } = await atB();
      const before = await runStore.get(runId);
      const step = kind === 'completed' ? 'a' : kind === 'skipped' ? 'skipme' : 'fails';
      expect(
        kind === 'completed'
          ? before.completed_steps
          : kind === 'skipped'
            ? before.skipped_steps
            : before.failed_steps,
        'fixture',
      ).toContain(step);
      expect(before.run_phase, 'fixture: the run goes on').toBe('running');
      const r = await call('execute_step', { run_id: runId, command: step, params: {} });
      // (a) red when the step runs again, or the reply drops the reason or the ready step; (b) prints it.
      expect([r['status'], r['agent_action'], next(r)]).toEqual([
        'blocked',
        'resolve_precondition',
        ['execute_step:b'],
      ]);
      expect(String(r['context_hint'])).toBe(
        `Step '${step}' cannot be called now: ${why}. Ready for the agent: 'b'.`,
      );
      expect((await runStore.get(runId)).version).toBe(before.version);
    },
  );

  it('C163 blocked: the suggestion for steps only', async () => {
    claim('mcp/tools.md', '`Call one of the steps indicated in next_actions instead.` for steps');
    claim(
      'mcp/tools.md',
      '`eligible_steps`, the steps that can be called by name, and a `suggestion`.',
    );
    claim('mcp/tools.md', 'On a run that has ended, each tool replies as follows:');
    const { call, runId } = await atB();
    const r = await call('execute_step', { run_id: runId, command: 'a', params: {} });
    expect((r['blocked_reason'] as { suggestion: string }).suggestion).toBe(
      'Call one of the steps indicated in next_actions instead.',
    );
  });

  it('C163 blocked: the suggestion for the answer to an open question', async () => {
    claim('mcp/tools.md', '`Answer the open question first, as next_actions says.` for the answer');
    const { call, workflowStore } = await connect();
    await workflowStore.register(gated('docs-q'));
    const runId = (await call('start_run', { workflow_id: 'docs-q' }))['run_id'] as string;
    const r = await call('execute_step', { run_id: runId, command: 'after', params: {} });
    expect([
      r['status'],
      next(r),
      (r['blocked_reason'] as { suggestion: string }).suggestion,
    ]).toEqual([
      'blocked',
      ['submit_human_response:'],
      'Answer the open question first, as next_actions says.',
    ]);
  });

  it('C163 blocked: the suggestion for advance_run alone', async () => {
    claim('mcp/tools.md', '`Call advance_run, as next_actions says.` for `advance_run` alone');
    const { call, workflowStore, runStore } = await connect();
    await workflowStore.register(gated('docs-act'));
    const runId = (await call('start_run', { workflow_id: 'docs-act' }))['run_id'] as string;
    const gateId = (await runStore.get(runId)).pending_gate!.gate_id;
    await call('submit_human_response', { run_id: runId, gate_id: gateId, choice: 'approve' });
    const r = await call('execute_step', { run_id: runId, command: 'confirm', params: {} });
    expect([
      r['status'],
      next(r),
      (r['blocked_reason'] as { suggestion: string }).suggestion,
    ]).toEqual(['blocked', ['advance_run:'], 'Call advance_run, as next_actions says.']);
  });
});

/** `b` (agent) → `a` (agent, precondition `b.output.go == true`): `go: false` leaves nothing to run. */
const STUCK: WorkflowDefinition = {
  id: 'docs-stuck',
  name: 'docs-stuck',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    b: { description: 'B.', execution: 'agent', depends_on: [] },
    a: {
      description: 'A.',
      execution: 'agent',
      depends_on: ['b'],
      preconditions: ['b.output.go == true'],
    },
  },
} as WorkflowDefinition;

/** `g` (a question) → `d` (agent) and `e` (auto), both after `g`. */
const FORK: WorkflowDefinition = {
  id: 'docs-fork',
  name: 'docs-fork',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    g: {
      description: 'G.',
      execution: 'auto',
      trust: 'human_confirmed',
      depends_on: [],
      gate: { choices: ['yes', 'no'] },
    },
    d: { description: 'D.', execution: 'agent', depends_on: ['g'] },
    e: { description: 'E.', execution: 'auto', depends_on: ['g'] },
  },
} as WorkflowDefinition;

/** `ok` (agent) ready beside `t` (agent, `trust: human_confirm` — not a trust Realm knows). */
const TRUSTY: WorkflowDefinition = {
  id: 'docs-trust',
  name: 'docs-trust',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    ok: { description: 'OK.', execution: 'agent', depends_on: [] },
    t: { description: 'T.', execution: 'agent', depends_on: [], trust: 'human_confirm' },
  },
} as unknown as WorkflowDefinition;

const WAY_OUT =
  'Correct the workflow and register it again, then call advance_run; or end the run with abandon_run.';

describe('#625 PR-2a, C163 — tools.md: the rest of the reply sections, sentence by sentence', () => {
  it('C163: the server has 11 tools, advance_run among them', async () => {
    claim('mcp/tools.md', "Realm's MCP server has 11 tools.");
    claim(
      'core-library.md',
      '`createRealmMcpServer` returns the MCP server that `realm mcp` runs, with the 11 tools',
    );
    const dir = await mkdtemp(join(tmpdir(), 'realm-docs-625-'));
    const server = createRealmMcpServer({
      runStore: new JsonFileStore(join(dir, 'runs')),
      workflowStore: new JsonWorkflowStore(join(dir, 'wf')),
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'docs-claims-625', version: '0' });
    await Promise.all([server.connect(st), client.connect(ct)]);
    const tools = (await client.listTools()).tools.map((t) => t.name);
    // (a) red when a tool is added or dropped without the page; (b) prints the list.
    expect(tools).toHaveLength(11);
    expect(tools).toContain('advance_run');
  });

  it.each([
    'start_run',
    'execute_step',
    'submit_human_response',
    'advance_run',
    'create_workflow',
  ] as const)('C163: %s replies with the shared shape', async (tool) => {
    claim(
      'mcp/tools.md',
      '`start_run`, `execute_step`, `submit_human_response`, `advance_run` and `create_workflow` reply with one JSON object of the same shape.',
    );
    const { call, workflowStore, runStore } = await connect();
    await workflowStore.register(gated('docs-shape'));
    const started = await call('start_run', { workflow_id: 'docs-shape' });
    const runId = started['run_id'] as string;
    const gateId = (await runStore.get(runId)).pending_gate!.gate_id;
    const r =
      tool === 'start_run'
        ? started
        : tool === 'execute_step'
          ? await call('execute_step', { run_id: runId, command: 'after', params: {} })
          : tool === 'submit_human_response'
            ? await call('submit_human_response', {
                run_id: runId,
                gate_id: gateId,
                choice: 'approve',
              })
            : tool === 'advance_run'
              ? await call('advance_run', { run_id: runId })
              : await call('create_workflow', {
                  name: 'shape',
                  steps: [{ id: 'x', description: 'x' }],
                });
    // (a) red when the tool's reply drops a field of the shared shape; (b) prints its keys.
    for (const k of [
      'command',
      'run_id',
      'run_version',
      'status',
      'context_hint',
      'next_actions',
      'warnings',
      'errors',
      'data',
      'evidence',
    ]) {
      expect(r, `${tool}: ${k}`).toHaveProperty(k);
    }
  });

  it.each(['start_run_batch', 'append_trace', 'get_run_state', 'abandon_run'] as const)(
    'C163: %s refuses with the shared shape (get_run_state and abandon_run without run_version)',
    async (tool) => {
      claim(
        'mcp/tools.md',
        '`start_run_batch`, `append_trace`, `get_run_state` and `abandon_run` use that shape when they refuse a call, except that a refusal from `get_run_state` or `abandon_run` has no `run_version`.',
      );
      const { call } = await connect();
      const r =
        tool === 'start_run_batch'
          ? await call('start_run_batch', { workflow_id: 'nope', items: [{ params: {} }] })
          : tool === 'append_trace'
            ? await call('append_trace', { run_id: 'nope', step_id: 'a', entries: [] })
            : await call(tool, { run_id: 'nope' });
      // (a) red when the refusal leaves the shape, or gains or loses run_version; (b) prints its keys.
      for (const k of [
        'command',
        'run_id',
        'status',
        'error_code',
        'errors',
        'agent_action',
        'next_actions',
      ]) {
        expect(r, `${tool}: ${k}`).toHaveProperty(k);
      }
      expect('run_version' in r).toBe(tool === 'start_run_batch' || tool === 'append_trace');
    },
  );

  it('C163: get_workflow_protocol refuses with plain text, marked as an error; list_workflows refuses with its own fields', async () => {
    claim(
      'mcp/tools.md',
      '`list_workflows` refuses with its own fields — `status`, `error_code`, `error_details`, `errors`, `agent_action` and `hint`, with `workflows` and `unreadable` empty — and `get_workflow_protocol` refuses with plain text, marked as an error, as the MCP layer does (above).',
    );
    const { call, dir } = await connect();
    const protocol = await call('get_workflow_protocol', { workflow_id: 'nope' });
    expect([protocol._text, protocol._isError]).toEqual(['Error: Workflow not found: nope', true]);
    // The registry directory itself cannot be read: here it is a file.
    rmSync(join(dir, 'wf'), { recursive: true, force: true });
    writeFileSync(join(dir, 'wf'), 'not a directory');
    const listed = await call('list_workflows', {});
    // (a) red when list_workflows' refusal gains or loses a field; (b) prints its keys.
    expect(listed['status']).toBe('error');
    expect(
      Object.keys(listed)
        .filter((k) => !k.startsWith('_'))
        .sort(),
    ).toEqual([
      'agent_action',
      'error_code',
      'error_details',
      'errors',
      'hint',
      'status',
      'unreadable',
      'workflows',
    ]);
    expect([listed['workflows'], listed['unreadable'], listed['error_code']]).toEqual([
      [],
      [],
      'STATE_WORKFLOW_UNREADABLE',
    ]);
  });

  it('C163 command: a refused answer that names no step says submit_gate — a gate ID that is not the open one, and a run with no question open', async () => {
    claim(
      'mcp/tools.md',
      'A refused answer that names no step — a gate ID that is not the open one, a run with no question open — says `submit_gate`, a word older than `submit_human_response`.',
    );
    const { call, workflowStore } = await connect();
    await workflowStore.register(gated('docs-cmd'));
    await workflowStore.register(STUCK);
    const open = (await call('start_run', { workflow_id: 'docs-cmd' }))['run_id'] as string;
    const wrong = await call('submit_human_response', {
      run_id: open,
      gate_id: 'other',
      choice: 'approve',
    });
    const none = (await call('start_run', { workflow_id: STUCK.id }))['run_id'] as string;
    const noQuestion = await call('submit_human_response', {
      run_id: none,
      gate_id: 'g',
      choice: 'approve',
    });
    expect([
      wrong['command'],
      wrong['status'],
      noQuestion['command'],
      noQuestion['status'],
    ]).toEqual(['submit_gate', 'error', 'submit_gate', 'error']);
  });

  it('C163 command: an answer refused before the engine reads the run says submit_human_response — a run ID that does not exist, a record that cannot be read, a workflow that cannot be read', async () => {
    claim(
      'mcp/tools.md',
      'An answer the tool refuses before the engine reads the run says `submit_human_response`: a run ID that does not exist (`STATE_RUN_NOT_FOUND`), or a run or workflow that cannot be read.',
    );
    const { call, dir, runStore } = await connect();
    const missing = await call('submit_human_response', {
      run_id: 'nope',
      gate_id: 'g',
      choice: 'x',
    });
    mkdirSync(join(dir, 'runs'), { recursive: true });
    writeFileSync(join(dir, 'runs', 'broken.json'), '{not json');
    const unreadable = await call('submit_human_response', {
      run_id: 'broken',
      gate_id: 'g',
      choice: 'x',
    });
    const { run } = await runStore.create({
      workflowId: 'never-registered',
      workflowVersion: 1,
      params: {},
    });
    const noWorkflow = await call('submit_human_response', {
      run_id: run.id,
      gate_id: 'g',
      choice: 'x',
    });
    // (a) red when one of these says submit_gate or a step; (b) prints them.
    expect([
      [missing['command'], missing['error_code']],
      [unreadable['command'], unreadable['status']],
      [noWorkflow['command'], noWorkflow['status']],
    ]).toEqual([
      ['submit_human_response', 'STATE_RUN_NOT_FOUND'],
      ['submit_human_response', 'error'],
      ['submit_human_response', 'error'],
    ]);
  });

  it('C163 next_actions: an open question is named by its answer; empty when nothing can be called now', async () => {
    claim(
      'mcp/tools.md',
      'The calls that can be made next; an open question is named by its answer.',
    );
    claim('mcp/tools.md', 'Empty when nothing can be called now (see `ok` below).');
    claim(
      'mcp/tools.md',
      'Follow `next_actions`; an open question is named there by its answer, `submit_human_response`.',
    );
    const { call, workflowStore } = await connect();
    await workflowStore.register(gated('docs-next'));
    const opened = await call('start_run', { workflow_id: 'docs-next' });
    const { call: call2, runId } = await endedRun();
    const ended = await call2('advance_run', { run_id: runId });
    expect([next(opened), next(ended)]).toEqual([['submit_human_response:'], []]);
    void call;
  });

  it('C163 ok: next_actions empty when a step cannot run — the hint names it and why, and ends with the way out', async () => {
    claim(
      'mcp/tools.md',
      "When it is empty, nothing can be called now: the run has ended, a step cannot run (`context_hint` names it and why, and ends with the way out when the workflow must be corrected), or nothing is ready while a step is in flight in another process (`No step is ready.`; `get_run_state`'s `step_claims` names the step).",
    );
    const { call, workflowStore } = await connect();
    await workflowStore.register(STUCK);
    const runId = (await call('start_run', { workflow_id: STUCK.id }))['run_id'] as string;
    const r = await call('execute_step', { run_id: runId, command: 'b', params: { go: false } });
    expect([r['status'], next(r)]).toEqual(['ok', []]);
    expect(String(r['context_hint'])).toContain("'a' cannot run (precondition)");
    expect(String(r['context_hint']).endsWith(WAY_OUT)).toBe(true);
  });

  it('C163 ok: next_actions empty while a step is in flight in another process — No step is ready., step_claims names it', async () => {
    claim(
      'mcp/tools.md',
      "When it is empty, nothing can be called now: the run has ended, a step cannot run (`context_hint` names it and why, and ends with the way out when the workflow must be corrected), or nothing is ready while a step is in flight in another process (`No step is ready.`; `get_run_state`'s `step_claims` names the step).",
    );
    const { call, workflowStore, runStore } = await connect();
    await workflowStore.register(STUCK);
    const runId = (await call('start_run', { workflow_id: STUCK.id }))['run_id'] as string;
    await runStore.claimStep(runId, 'b', STUCK);
    const r = await call('advance_run', { run_id: runId });
    const state = await call('get_run_state', { run_id: runId });
    expect([r['status'], next(r), r['context_hint']]).toEqual([
      'ok',
      [],
      `Run '${runId}': nothing ran. No step is ready.`,
    ]);
    expect(JSON.stringify(state['step_claims'])).toContain('"b"');
  });

  it('C163 blocked: next_actions names the answer, advance_run, or steps; eligible_steps may differ — the engine owes an auto step: advance_run offered, the step named', async () => {
    claim('mcp/tools.md', 'The step cannot be called now, and `context_hint` says why.');
    claim(
      'mcp/tools.md',
      '`next_actions` names what can be done instead: the agent steps that can be called, `advance_run` when the engine owes work, or the answer to an open question.',
    );
    claim(
      'mcp/tools.md',
      '`blocked_reason.eligible_steps` lists the steps that can be called by name, and may differ from `next_actions`: for example, when the engine owes an `auto` step it can run, `next_actions` offers `advance_run` and `eligible_steps` names the step.',
    );
    const { call, workflowStore, runStore } = await connect();
    await workflowStore.register(gated('docs-owed'));
    const runId = (await call('start_run', { workflow_id: 'docs-owed' }))['run_id'] as string;
    const gateId = (await runStore.get(runId)).pending_gate!.gate_id;
    await call('submit_human_response', { run_id: runId, gate_id: gateId, choice: 'approve' });
    const r = await call('execute_step', { run_id: runId, command: 'confirm', params: {} });
    expect([
      r['status'],
      next(r),
      (r['blocked_reason'] as { eligible_steps: string[] }).eligible_steps,
    ]).toEqual(['blocked', ['advance_run:'], ['after']]);
    expect(String(r['context_hint'])).toMatch(/^Step 'confirm' cannot be called now: /);
  });

  it('C163 blocked: the suggestion for steps and advance_run together', async () => {
    claim(
      'mcp/tools.md',
      '`Call one of the steps indicated in next_actions, or advance_run, instead.` for both',
    );
    const { call, workflowStore, runStore } = await connect();
    await workflowStore.register(FORK);
    const runId = (await call('start_run', { workflow_id: FORK.id }))['run_id'] as string;
    const gateId = (await runStore.get(runId)).pending_gate!.gate_id;
    await call('submit_human_response', { run_id: runId, gate_id: gateId, choice: 'yes' });
    const r = await call('execute_step', { run_id: runId, command: 'g', params: {} });
    expect([next(r), (r['blocked_reason'] as { suggestion: string }).suggestion]).toEqual([
      ['execute_step:d', 'advance_run:'],
      'Call one of the steps indicated in next_actions, or advance_run, instead.',
    ]);
  });

  it('C163 blocked: nothing can be done — next_actions empty, report_to_user, the suggestion says no other step', async () => {
    claim('mcp/tools.md', 'It is empty when nothing can be done.');
    claim('mcp/tools.md', '`No other step can be called now.` when it is empty');
    claim(
      'mcp/tools.md',
      '`agent_action: "resolve_precondition"` (`"report_to_user"` when nothing else can be done: no step to call, no question to answer;',
    );
    const { call, workflowStore } = await connect();
    await workflowStore.register(STUCK);
    const runId = (await call('start_run', { workflow_id: STUCK.id }))['run_id'] as string;
    await call('execute_step', { run_id: runId, command: 'b', params: { go: false } });
    const r = await call('execute_step', { run_id: runId, command: 'b', params: {} });
    expect([
      r['status'],
      r['agent_action'],
      next(r),
      (r['blocked_reason'] as { suggestion: string }).suggestion,
    ]).toEqual(['blocked', 'report_to_user', [], 'No other step can be called now.']);
  });

  it('C163 blocked: stop when the run has ended — including when this call ended it, carrying out an expired abort first', async () => {
    claim(
      'mcp/tools.md',
      '`"stop"` when the run has ended — including when this call ended it, carrying out an expired question\'s declared `abort` first), `blocked_reason`, and in `context_hint` why.',
    );
    const { call, workflowStore } = await connect();
    await workflowStore.register(gated('docs-stop', 'abort'));
    const runId = (await call('start_run', { workflow_id: 'docs-stop' }))['run_id'] as string;
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const r = await call('execute_step', { run_id: runId, command: 'after', params: {} });
    expect([r['status'], r['agent_action'], r['run_phase']]).toEqual([
      'blocked',
      'stop',
      'aborted',
    ]);
    expect(
      (r['warnings'] as string[]).some((w) =>
        w.includes('this execute_step call first carried out its declared abort'),
      ),
    ).toBe(true);
  });

  it('C163 resolve_precondition: a step whose dependencies are not settled runs only once they hold — the reply names them and the ready step', async () => {
    claim(
      'mcp/tools.md',
      'Do what `next_actions` names instead: call what it names (a step, or `advance_run`), or answer the open question it names.',
    );
    claim(
      'mcp/tools.md',
      'any other step runs only once what it waits on holds (its precondition, its dependencies, the answer), and this reply does not promise that it will.',
    );
    claim(
      'mcp/tools.md',
      'or its dependencies are not settled (named — then the steps that are ready).',
    );
    const { call, workflowStore, runStore } = await connect();
    await workflowStore.register(STEPS);
    const runId = (await call('start_run', { workflow_id: STEPS.id, params: { path: '/x' } }))[
      'run_id'
    ] as string;
    const before = (await runStore.get(runId)).version;
    const r = await call('execute_step', { run_id: runId, command: 'b', params: {} });
    expect([r['status'], r['agent_action'], next(r), r['context_hint']]).toEqual([
      'blocked',
      'resolve_precondition',
      ['execute_step:a'],
      "Step 'b' cannot be called now: its dependencies are not settled ('a'). Ready for the agent: 'a'.",
    ]);
    expect((await runStore.get(runId)).version).toBe(before);
  });

  it('C163 not ready: a step that waits on the question — its choices, answer it with submit_human_response, the answer in next_actions without a claim_token', async () => {
    claim(
      'mcp/tools.md',
      "it waits on the question on step '<q>' (its choices and `answer it with submit_human_response`, with that answer in `next_actions`, without a `claim_token`)",
    );
    const { call, workflowStore } = await connect();
    await workflowStore.register(gated('docs-waits'));
    const runId = (await call('start_run', { workflow_id: 'docs-waits' }))['run_id'] as string;
    const r = await call('execute_step', { run_id: runId, command: 'after', params: {} });
    expect(String(r['context_hint'])).toContain(
      "Step 'after' cannot be called now: it waits on the question on step 'confirm' (choices: approve, reject) — answer it with submit_human_response.",
    );
    const answer = (
      r['next_actions'] as Array<{ instruction: { tool: string; params: Record<string, unknown> } }>
    )[0]!;
    expect([answer.instruction.tool, 'claim_token' in answer.instruction.params]).toEqual([
      'submit_human_response',
      false,
    ]);
  });

  it('C163: a step refused before its claim (invalid trust) — the refusal, the other step offered, never itself; blocked_reason on the refusal; agent_refused in get_run_state', async () => {
    claim(
      'mcp/tools.md',
      'A step called by name that the engine refuses before its claim, for a failed precondition or an invalid `trust` — an `auto` step, or an agent step (added after version 0.46.0) — returns that refusal.',
    );
    claim(
      'mcp/tools.md',
      'Its `next_actions` and `blocked_reason.eligible_steps` name the steps that can be called instead — never the refused step — and its `agent_action` is `resolve_precondition`, or `report_to_user` when no other step can be called',
    );
    claim('mcp/tools.md', 'With `blocked`, and on a refusal for an invalid `trust`');
    claim(
      'mcp/tools.md',
      'An agent step the run refuses before its claim (a failed precondition, an invalid `trust`) is listed in `agent_refused`, never in `next_actions` (added after version 0.46.0).',
    );
    const { call, workflowStore } = await connect();
    await workflowStore.register(TRUSTY);
    const runId = (await call('start_run', { workflow_id: TRUSTY.id }))['run_id'] as string;
    const r = await call('execute_step', { run_id: runId, command: 't', params: {} });
    expect([
      r['status'],
      r['agent_action'],
      next(r),
      (r['blocked_reason'] as { eligible_steps: string[] }).eligible_steps,
    ]).toEqual(['error', 'resolve_precondition', ['execute_step:ok'], ['ok']]);
    expect(typeof (r['blocked_reason'] as { suggestion: string }).suggestion).toBe('string');
    const state = await call('get_run_state', { run_id: runId });
    expect(JSON.stringify(state['agent_refused'])).toContain('"t"');
    expect(next(state)).not.toContain('execute_step:t');
  });

  it('C163: a step refused before its claim with nothing else to run — report_to_user and the way out', async () => {
    claim(
      'mcp/tools.md',
      "When nothing else can run, its `context_hint` ends with the way out: `Correct the workflow and register it again, then call advance_run; or end the run with abandon_run.` An input its schema refuses is the caller's own input, and that reply is unchanged.",
    );
    const { call, workflowStore } = await connect();
    await workflowStore.register(STUCK);
    const runId = (await call('start_run', { workflow_id: STUCK.id }))['run_id'] as string;
    await call('execute_step', { run_id: runId, command: 'b', params: { go: false } });
    const r = await call('execute_step', { run_id: runId, command: 'a', params: {} });
    expect([r['agent_action'], next(r)]).toEqual(['report_to_user', []]);
    expect(String(r['context_hint']).endsWith(WAY_OUT)).toBe(true);
    await workflowStore.register(SCHEMA);
    const s = (await call('start_run', { workflow_id: SCHEMA.id }))['run_id'] as string;
    const refused = await call('execute_step', { run_id: s, command: 'ask', params: { n: 'x' } });
    expect([refused['error_code'], refused['agent_action']]).toEqual([
      'VALIDATION_INPUT_SCHEMA',
      'provide_input',
    ]);
  });
});

/** `pre` (auto, needs handler `missing`) ready at start; `ask` (agent) ready beside it. */
const NEEDS_HANDLER: WorkflowDefinition = {
  id: 'docs-handler',
  name: 'docs-handler',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    pre: { description: 'Pre.', execution: 'auto', depends_on: [], handler: 'missing' },
  },
} as unknown as WorkflowDefinition;

/** `blk` (auto, a precondition no evidence can meet) is the only step. */
const CANNOT_GO_ON: WorkflowDefinition = {
  id: 'docs-cannot',
  name: 'docs-cannot',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    blk: {
      description: 'Blk.',
      execution: 'auto',
      depends_on: [],
      preconditions: ['nothing.ok == true'],
    },
  },
} as WorkflowDefinition;

/** `ask` (agent) → `work` (auto, bare). */
const AGENT_THEN_AUTO: WorkflowDefinition = {
  id: 'docs-chain',
  name: 'docs-chain',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    ask: { description: 'Ask.', execution: 'agent', depends_on: [] },
    work: { description: 'Work.', execution: 'auto', depends_on: ['ask'] },
  },
} as WorkflowDefinition;

describe('#625 PR-2a, C163 — tools.md: start_run, start_run_batch, submit_human_response, advance_run, sentence by sentence', () => {
  it('C163 start_run: when no step ran the hint says what comes next — the steps ready for the assistant', async () => {
    claim(
      'mcp/tools.md',
      "When no step ran, the reply's `context_hint` says what comes next after `Run '<id>' created for workflow '<workflow>'.`: the steps ready for the assistant, the work owed to the engine, and each step that cannot run",
    );
    const { call, workflowStore } = await connect();
    await workflowStore.register(AGENT_THEN_AUTO);
    const r = await call('start_run', { workflow_id: AGENT_THEN_AUTO.id });
    expect(r['context_hint']).toBe(
      `Run '${String(r['run_id'])}' created for workflow '${AGENT_THEN_AUTO.id}'. Ready for the agent: 'ask'.`,
    );
  });

  it('C163 start_run: a new run that cannot go on — the step that cannot run, then the way out', async () => {
    claim(
      'mcp/tools.md',
      'When the new run cannot go on until its workflow is corrected — its only owed steps are refused before their claim and nothing else is ready — the hint ends with the way out: `Correct the workflow and register it again, then call advance_run; or end the run with abandon_run.`',
    );
    const { call, workflowStore } = await connect();
    await workflowStore.register(CANNOT_GO_ON);
    const r = await call('start_run', { workflow_id: CANNOT_GO_ON.id });
    expect(String(r['context_hint'])).toContain("'blk' cannot run (precondition)");
    expect(String(r['context_hint']).endsWith(WAY_OUT)).toBe(true);
    expect(r['status']).toBe('ok');
  });

  it('C163 start_run: a step needing a handler this server lacks — status ok, the hint names it, the block in warnings in place of its pre-flight warning', async () => {
    claim(
      'mcp/tools.md',
      "When the step it attempts needs a handler or adapter this server lacks, the reply is still the one that created the run (`status: ok`): its `context_hint` names the step (`'<step>' cannot run here (capability): handler '<name>' is not registered here — load the missing extension, or run the step on a runner that has it.`), and the block's own message (`Step '<step>' is blocked: …`) is in `warnings`, in place of that step's pre-flight warning (`… If reached it will block …`): the step was reached.",
    );
    const { call, workflowStore } = await connect();
    await workflowStore.register(NEEDS_HANDLER);
    const r = await call('start_run', { workflow_id: NEEDS_HANDLER.id });
    expect(r['status']).toBe('ok');
    expect(String(r['context_hint'])).toContain(
      "'pre' cannot run here (capability): handler 'missing' is not registered here — load the missing extension, or run the step on a runner that has it.",
    );
    const warnings = r['warnings'] as string[];
    expect(warnings.some((w) => w.startsWith("Step 'pre' is blocked: "))).toBe(true);
    expect(warnings.some((w) => w.includes('If reached it will block'))).toBe(false);
  });

  it('C163 start_run: a pre-flight warning for a step not reached stays', async () => {
    claim('mcp/tools.md', 'A pre-flight warning for a step not reached stays.');
    const { call, workflowStore } = await connect();
    const def = {
      ...NEEDS_HANDLER,
      id: 'docs-preflight',
      steps: {
        ...NEEDS_HANDLER.steps,
        post: { description: 'Post.', execution: 'auto', depends_on: ['pre'], handler: 'missing2' },
      },
    } as unknown as WorkflowDefinition;
    await workflowStore.register(def);
    const r = await call('start_run', { workflow_id: def.id });
    const warnings = r['warnings'] as string[];
    // (a) red when the not-reached step loses its pre-flight warning, or the reached one keeps it; (b) prints them.
    expect(
      warnings.some((w) => w.includes("'post'") && w.includes('If reached it will block')),
    ).toBe(true);
    expect(
      warnings.some((w) => w.includes("'pre'") && w.includes('If reached it will block')),
    ).toBe(false);
  });

  it('C163 start_run: a step that fails is returned as the error it is', async () => {
    claim('mcp/tools.md', 'A step that fails is returned as the error it is.');
    const { call, workflowStore } = await connect();
    const def = loadWorkflowFromString(
      [
        'id: docs-fails',
        'name: docs-fails',
        'version: 1',
        'services:',
        '  files:',
        '    adapter: filesystem',
        '    trust: engine_delivered',
        'steps:',
        '  read:',
        '    description: R.',
        '    execution: auto',
        '    uses_service: files',
        '    operation: read',
        '    input_map:',
        '      path: run.params.path',
        '',
      ].join('\n'),
    );
    await workflowStore.register(def);
    const r = await call('start_run', {
      workflow_id: def.id,
      params: { path: '/no/such/file-625' },
    });
    expect([r['status'], r['error_code'], r['stopped_step']]).toEqual([
      'error',
      'RESOURCE_FETCH_FAILED',
      'read',
    ]);
  });

  it('C163 start_run: a repeat matched by idempotency_key runs nothing and says what comes next for that run', async () => {
    claim(
      'mcp/tools.md',
      "A repeat matched by `idempotency_key` runs nothing: its `context_hint` opens `Matched existing run '<id>' (idempotent) in phase '<phase>'; no new run created.` and then says what comes next for that run in the same words, the way out included.",
    );
    const { call, workflowStore, runStore } = await connect();
    await workflowStore.register(AGENT_THEN_AUTO);
    const first = await call('start_run', {
      workflow_id: AGENT_THEN_AUTO.id,
      idempotency_key: 'k',
    });
    const version = (await runStore.get(first['run_id'] as string)).version;
    const again = await call('start_run', {
      workflow_id: AGENT_THEN_AUTO.id,
      idempotency_key: 'k',
    });
    expect(again['context_hint']).toBe(
      `Matched existing run '${String(first['run_id'])}' (idempotent) in phase 'running'; no new run created. Ready for the agent: 'ask'.`,
    );
    expect((await runStore.get(first['run_id'] as string)).version).toBe(version);
  });

  it("C163 start_run_batch: each entry's next_actions names its run's first call, its hint the creation sentence and what comes next", async () => {
    claim(
      'mcp/tools.md',
      "Each entry's `next_actions` names its run's first call, and its `context_hint` is the sentence `start_run`'s reply carries for a run on which nothing ran: `Run '<id>' created for workflow '<workflow>'.` (or `Matched existing run …` for a repeat), then what comes next",
    );
    const { call, workflowStore } = await connect();
    await workflowStore.register(AGENT_THEN_AUTO);
    const r = await call('start_run_batch', {
      workflow_id: AGENT_THEN_AUTO.id,
      items: [{ params: {} }, { params: {} }],
    });
    const started = r['started'] as Reply[];
    expect(started).toHaveLength(2);
    for (const e of started) {
      expect([next(e), e['context_hint']]).toEqual([
        ['execute_step:ask'],
        `Run '${String(e['run_id'])}' created for workflow '${AGENT_THEN_AUTO.id}'. Ready for the agent: 'ask'.`,
      ]);
    }
  });

  it('C163 chained_auto_steps and stopped_step: from execute_step — the auto step that ran is listed; a step that stopped the call is in stopped_step', async () => {
    claim(
      'mcp/tools.md',
      'From `start_run`, `execute_step` and `advance_run` (added after version 0.46.0).',
    );
    claim(
      'mcp/tools.md',
      "From `execute_step`, `start_run` and `advance_run` (added after version 0.46.0), on an `error`, `blocked` or `confirm_required` reply that a step's call produced",
    );
    const { call, workflowStore } = await connect();
    await workflowStore.register(AGENT_THEN_AUTO);
    const runId = (await call('start_run', { workflow_id: AGENT_THEN_AUTO.id }))[
      'run_id'
    ] as string;
    const r = await call('execute_step', { run_id: runId, command: 'ask', params: {} });
    expect((r['chained_auto_steps'] as Array<{ step: string }>).map((e) => e.step)).toEqual([
      'work',
    ]);
    await workflowStore.register(gated('docs-stopped'));
    const opened = await call('start_run', { workflow_id: 'docs-stopped' });
    expect([opened['status'], opened['stopped_step']]).toEqual(['confirm_required', 'confirm']);
  });

  it("C163 chained_auto_steps: an auto step's entry carries the expiry line of the execute_step call that carried out an expired question first; the reply's warnings list it too", async () => {
    claim(
      'mcp/tools.md',
      "An `auto` step's entry also has `warnings` when that step's own call gave any (such as the expiry line of an `execute_step` call that carried out an expired question first); the reply's `warnings` lists them too.",
    );
    const { call, workflowStore, runStore } = await connect();
    await workflowStore.register(gated('docs-chained', 'settle_default'));
    const runId = (await call('start_run', { workflow_id: 'docs-chained' }))['run_id'] as string;
    const gateId = (await runStore.get(runId)).pending_gate!.gate_id;
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const r = await call('execute_step', { run_id: runId, command: 'after', params: {} });
    const line = `gate '${gateId}' on 'confirm' had expired — this execute_step call first carried out its declared settle_default: the default choice 'approve' was recorded (enacted_via: execute_step).`;
    const entry = (r['chained_auto_steps'] as Array<{ step: string; warnings?: string[] }>).find(
      (e) => e.step === 'after',
    );
    expect(entry?.warnings).toContain(line);
    expect(r['warnings']).toContain(line);
  });

  it('C163 submit_human_response: a gate ID that is not the open one — STATE_BLOCKED, the open question named and its answer offered, resolve_precondition', async () => {
    claim(
      'mcp/tools.md',
      "`Gate 'x' is not the open gate and matches no committed resolution.` See below.",
    );
    claim(
      'mcp/tools.md',
      'A gate ID that is not the open one is refused, and the reply names the question that is open.',
    );
    claim(
      'mcp/tools.md',
      "Its `next_actions` holds that question's answer — or, when the question's time is up and it declares `on_expiry`, `advance_run`, since an answer could no longer be recorded — and its `agent_action` is `resolve_precondition` (`report_to_user` when `next_actions` is empty).",
    );
    claim(
      'mcp/tools.md',
      "Its `context_hint` follows the message with `The open question is on step '<step>' (gate '<gate>') — answer it as next_actions says.`, or `The question on step '<step>' (gate '<gate>') can no longer be answered: its time is up — call advance_run to carry out its declared <on_expiry>.`, or `No question is open on this run.`",
    );
    const { call, workflowStore, runStore } = await connect();
    await workflowStore.register(gated('docs-wrong'));
    await workflowStore.register(gated('docs-wrong-exp', 'settle_default'));
    await workflowStore.register(STUCK);
    const open = (await call('start_run', { workflow_id: 'docs-wrong' }))['run_id'] as string;
    const g = (await runStore.get(open)).pending_gate!.gate_id;
    const r = await call('submit_human_response', {
      run_id: open,
      gate_id: 'x',
      choice: 'approve',
    });
    expect([r['error_code'], r['agent_action'], next(r), r['context_hint']]).toEqual([
      'STATE_BLOCKED',
      'resolve_precondition',
      ['submit_human_response:'],
      `Gate 'x' is not the open gate and matches no committed resolution. The open question is on step 'confirm' (gate '${g}') — answer it as next_actions says.`,
    ]);
    const exp = (await call('start_run', { workflow_id: 'docs-wrong-exp' }))['run_id'] as string;
    const ge = (await runStore.get(exp)).pending_gate!.gate_id;
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const late = await call('submit_human_response', {
      run_id: exp,
      gate_id: 'x',
      choice: 'approve',
    });
    expect([late['agent_action'], next(late)]).toEqual(['resolve_precondition', ['advance_run:']]);
    expect(String(late['context_hint'])).toContain(
      `The question on step 'confirm' (gate '${ge}') can no longer be answered: its time is up — call advance_run to carry out its declared settle_default.`,
    );
    const none = (await call('start_run', { workflow_id: STUCK.id }))['run_id'] as string;
    const n = await call('submit_human_response', {
      run_id: none,
      gate_id: 'x',
      choice: 'approve',
    });
    expect(String(n['context_hint'])).toContain('No question is open on this run.');
    expect(n['agent_action']).toBe(
      next(n).length === 0 ? 'report_to_user' : 'resolve_precondition',
    );
  });

  it('C163 submit_human_response: an answer the expiry settled another choice for — report_to_user, the hint says what the run owes, next_actions holds it; the line names the tool', async () => {
    claim(
      'mcp/tools.md',
      'An answer refused because its choice was not recorded — another choice was recorded first, or the gate\'s time was up and it settled another choice (below) — keeps `agent_action: "report_to_user"`: the person must hear that their choice was not recorded.',
    );
    claim(
      'mcp/tools.md',
      "When the run goes on, its `context_hint` follows the message with what the run owes, in the words a recorded answer uses — `… your choice 'discard' was not recorded. Owed to the engine: 'send' — call advance_run.` — and `next_actions` holds it.",
    );
    claim(
      'mcp/tools.md',
      'When the answer is refused and the run goes on, what the run owes follows it, as above.',
    );
    claim(
      'mcp/tools.md',
      "this submit_human_response call first carried out its declared settle_default: the default choice 'hold' was recorded (enacted_via: submit_human_response).",
    );
    const { call, workflowStore, runStore } = await connect();
    await workflowStore.register(gated('docs-late', 'settle_default'));
    const runId = (await call('start_run', { workflow_id: 'docs-late' }))['run_id'] as string;
    const gateId = (await runStore.get(runId)).pending_gate!.gate_id;
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const r = await call('submit_human_response', {
      run_id: runId,
      gate_id: gateId,
      choice: 'reject',
    });
    expect([
      r['status'],
      r['error_code'],
      r['agent_action'],
      r['answer_recorded'],
      next(r),
      r['context_hint'],
    ]).toEqual([
      'error',
      'STATE_BLOCKED',
      'report_to_user',
      false,
      ['advance_run:'],
      `Gate '${gateId}' was settled by timeout with choice 'approve' — your choice 'reject' was not recorded. Owed to the engine: 'after' — call advance_run.`,
    ]);
    expect(r['warnings']).toContain(
      `gate '${gateId}' on 'confirm' had expired — this submit_human_response call first carried out its declared settle_default: the default choice 'approve' was recorded (enacted_via: submit_human_response).`,
    );
  });

  it("C163 submit_human_response: an answer in time — the hint says what the run owes, as the page's example", async () => {
    claim(
      'mcp/tools.md',
      "\"context_hint\": \"Gate 'draft' resolved with choice 'send'. Owed to the engine: 'send' — call advance_run.\",",
    );
    const { call, workflowStore, runStore } = await connect();
    await workflowStore.register(gated('docs-intime'));
    const runId = (await call('start_run', { workflow_id: 'docs-intime' }))['run_id'] as string;
    const gateId = (await runStore.get(runId)).pending_gate!.gate_id;
    const r = await call('submit_human_response', {
      run_id: runId,
      gate_id: gateId,
      choice: 'approve',
    });
    expect([r['status'], r['context_hint'], next(r)]).toEqual([
      'ok',
      "Gate 'confirm' resolved with choice 'approve'. Owed to the engine: 'after' — call advance_run.",
      ['advance_run:'],
    ]);
  });

  it("C163 create_workflow: the new run's hint names the step ready for the agent", async () => {
    claim('mcp/tools.md', "Ready for the agent: 'collect'.\",");
    const { call } = await connect();
    const r = await call('create_workflow', {
      name: 'collect it',
      steps: [{ id: 'collect', description: 'Collect.' }],
    });
    expect(String(r['context_hint'])).toMatch(
      /^Run '[^']+' created for workflow '[^']+'\. Ready for the agent: 'collect'\.$/,
    );
  });

  it('C163 advance_run: carries out an expired question first (the line names advance_run), then the ready auto steps; chained_auto_steps lists what ran; data and evidence empty; continued_by without a driver', async () => {
    claim(
      'mcp/tools.md',
      'Runs the guards and automatic steps a run owes (added after version 0.46.0).',
    );
    claim(
      'mcp/tools.md',
      "first, when the open question's time is up and it declares `on_expiry`, it carries out that default or abort (a line in its `warnings` says so: `gate '<gate>' on '<step>' had expired — this advance_run call first carried out its declared settle_default: the default choice '<choice>' was recorded (enacted_via: advance_run).`, or `… its declared abort: the run ended …`); then the guards and `auto` steps that are ready.",
    );
    claim(
      'mcp/tools.md',
      "The reply has the same shape as a step's, with `data` and `evidence` empty as in every MCP reply (read the run with `get_run_state`): `chained_auto_steps` lists what ran, guards included, `guards` and `ended_by` what a guard that ended the run settled",
    );
    claim(
      'mcp/tools.md',
      'The run ended (<phase>).`), and when a step opens a question the reply is `confirm_required` with the gate.',
    );
    claim(
      'mcp/tools.md',
      "It also carries `continued_by`: the name of the program that ran the steps (`{ by: null, absent_cause: 'driver_not_recorded' }` when the host passed none).",
    );
    const { call, workflowStore, runStore } = await connect();
    await workflowStore.register(gated('docs-adv', 'settle_default'));
    const runId = (await call('start_run', { workflow_id: 'docs-adv' }))['run_id'] as string;
    const gateId = (await runStore.get(runId)).pending_gate!.gate_id;
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const r = await call('advance_run', { run_id: runId });
    expect(r['warnings']).toContain(
      `gate '${gateId}' on 'confirm' had expired — this advance_run call first carried out its declared settle_default: the default choice 'approve' was recorded (enacted_via: advance_run).`,
    );
    expect([
      (r['chained_auto_steps'] as Array<{ step: string }>).map((e) => e.step),
      r['data'],
      r['evidence'],
      r['run_phase'],
    ]).toEqual([['after'], {}, [], 'completed']);
    expect(r['continued_by']).toEqual({ by: null, absent_cause: 'driver_not_recorded' });
  });

  it('C163 advance_run: an abort line; a question whose time is not up, or with no on_expiry, is never touched', async () => {
    claim(
      'mcp/tools.md',
      'A question whose time is not up, or that declares no `on_expiry`, is never touched.',
    );
    const { call, workflowStore, runStore } = await connect();
    await workflowStore.register(gated('docs-adv-abort', 'abort'));
    await workflowStore.register(gated('docs-adv-none'));
    const a = (await call('start_run', { workflow_id: 'docs-adv-abort' }))['run_id'] as string;
    const none = (await call('start_run', { workflow_id: 'docs-adv-none' }))['run_id'] as string;
    const notUp = await call('advance_run', { run_id: a });
    expect([notUp['status'], (await runStore.get(a)).pending_gate !== undefined]).toEqual([
      'ok',
      true,
    ]);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const ended = await call('advance_run', { run_id: a });
    expect(
      (ended['warnings'] as string[]).some((w) =>
        w.includes('this advance_run call first carried out its declared abort: the run ended'),
      ),
    ).toBe(true);
    const untouched = await call('advance_run', { run_id: none });
    expect([untouched['status'], (await runStore.get(none)).pending_gate !== undefined]).toEqual([
      'ok',
      true,
    ]);
  });

  it('C163 advance_run: at an open question — nothing ran, the answer offered without a claim_token; nothing owed is never an error', async () => {
    claim(
      'mcp/tools.md',
      "A call with nothing owed runs nothing and returns the run's view — never an error.",
    );
    claim(
      'mcp/tools.md',
      "At an open question its `next_actions` holds the question's answer (`submit_human_response`, without a `claim_token`) and its `context_hint` reads `Run '<id>': nothing ran. Waiting on the question on step '<q>' (choices: <a>, <b>) — answer it with submit_human_response.` (added after version 0.46.0).",
    );
    const { call, workflowStore } = await connect();
    await workflowStore.register(gated('docs-adv-q'));
    const runId = (await call('start_run', { workflow_id: 'docs-adv-q' }))['run_id'] as string;
    const r = await call('advance_run', { run_id: runId });
    expect([r['status'], r['context_hint']]).toEqual([
      'ok',
      `Run '${runId}': nothing ran. Waiting on the question on step 'confirm' (choices: approve, reject) — answer it with submit_human_response.`,
    ]);
    const answer = (
      r['next_actions'] as Array<{ instruction: { tool: string; params: Record<string, unknown> } }>
    )[0]!;
    expect([answer.instruction.tool, 'claim_token' in answer.instruction.params]).toEqual([
      'submit_human_response',
      false,
    ]);
  });

  it('C163 advance_run: otherwise the hint says why — nothing ran, then the agent step that is ready', async () => {
    claim(
      'mcp/tools.md',
      "Otherwise its `context_hint` says why: `Run '<id>': nothing ran.`, then the agent steps that are ready, the work still owed, and each step that cannot run",
    );
    const { call, workflowStore } = await connect();
    await workflowStore.register(AGENT_THEN_AUTO);
    const runId = (await call('start_run', { workflow_id: AGENT_THEN_AUTO.id }))[
      'run_id'
    ] as string;
    const r = await call('advance_run', { run_id: runId });
    expect(r['context_hint']).toBe(`Run '${runId}': nothing ran. Ready for the agent: 'ask'.`);
  });

  it('C163 advance_run: a run that cannot go on — the step that cannot run, then the way out; the step is not run and the act is not offered for it', async () => {
    claim(
      'mcp/tools.md',
      'When the run cannot go on until its workflow is corrected — every owed step is refused before its claim (an invalid `trust`, a failed precondition, an input its schema refuses) and nothing else is ready — the hint ends with the way out:',
    );
    claim(
      'mcp/tools.md',
      "is not run; `get_run_state`'s `engine_runnable` names it and why, and the act is no longer offered for it.",
    );
    const { call, workflowStore, runStore } = await connect();
    await workflowStore.register(CANNOT_GO_ON);
    const runId = (await call('start_run', { workflow_id: CANNOT_GO_ON.id }))['run_id'] as string;
    const r = await call('advance_run', { run_id: runId });
    expect(String(r['context_hint'])).toBe(
      `Run '${runId}': nothing ran. 'blk' cannot run (precondition): ${String(r['context_hint']).split('cannot run (precondition): ')[1]}`,
    );
    expect(String(r['context_hint']).endsWith(WAY_OUT)).toBe(true);
    expect(next(r)).toEqual([]);
    expect((await runStore.get(runId)).completed_steps).not.toContain('blk');
    const state = await call('get_run_state', { run_id: runId });
    expect(JSON.stringify(state['engine_runnable'])).toContain('"blk"');
  });

  it('C163 advance_run: a handler that is not registered is attempted once — an error reply, and the act is no longer offered for that step', async () => {
    claim(
      'mcp/tools.md',
      'A handler or adapter that is not registered is attempted once, after every other owed step, so the run records which one is missing; that reply is an error, and its `next_actions` no longer offer the act for that step.',
    );
    const { call, workflowStore } = await connect();
    await workflowStore.register({ ...NEEDS_HANDLER, id: 'docs-handler-2' } as WorkflowDefinition);
    const runId = (
      (await call('start_run_batch', {
        workflow_id: 'docs-handler-2',
        items: [{ params: {} }],
      })) as Reply & { started: Reply[] }
    ).started[0]!['run_id'] as string;
    const r = await call('advance_run', { run_id: runId });
    expect([r['status'], next(r)]).toEqual(['error', []]);
    const again = await call('advance_run', { run_id: runId });
    expect(again['status']).toBe('ok');
  });

  it('C163 advance_run: an unknown argument is named in warnings', async () => {
    claim(
      'mcp/tools.md',
      "An unknown argument is named in `warnings` (`advance_run: unknown argument 'x' was ignored.`).",
    );
    const { call, workflowStore } = await connect();
    await workflowStore.register(AGENT_THEN_AUTO);
    const runId = (await call('start_run', { workflow_id: AGENT_THEN_AUTO.id }))[
      'run_id'
    ] as string;
    const r = await call('advance_run', { run_id: runId, x: 1 });
    expect(r['warnings']).toContain("advance_run: unknown argument 'x' was ignored.");
  });

  it('C163 advance_run: offered LAST in next_actions after an answer, its human_readable and orientation as the page shows; for an expired question its own words', async () => {
    claim(
      'mcp/tools.md',
      'It is always LAST: `next_actions[0]` stays the agent step when one is ready.',
    );
    claim(
      'mcp/tools.md',
      '"human_readable": "Call advance_run to run the step the engine owes: \'post_approval\'. It runs it with this server\'s extensions and environment.",',
    );
    claim('mcp/tools.md', "Engine work is owed: 'post_approval'.\"");
    claim(
      'mcp/tools.md',
      "For an expired question the act reads `Call advance_run to carry out the expired question on '<step>' (its declared <on_expiry>), then run what it leaves owed. It runs with this server's extensions and environment.`",
    );
    claim(
      'mcp/tools.md',
      "Call it when `next_actions` names it: every reply and `get_run_state` end `next_actions` with this act whenever engine work is owed and nobody is running it — after a gate is answered, when a question's time is up and it declares `on_expiry`, after `resume`, and for a run `start_run_batch` created.",
    );
    const { call, workflowStore, runStore } = await connect();
    await workflowStore.register(FORK);
    const runId = (await call('start_run', { workflow_id: FORK.id }))['run_id'] as string;
    const gateId = (await runStore.get(runId)).pending_gate!.gate_id;
    const r = await call('submit_human_response', {
      run_id: runId,
      gate_id: gateId,
      choice: 'yes',
    });
    expect(next(r)).toEqual(['execute_step:d', 'advance_run:']);
    const act = (r['next_actions'] as Array<{ human_readable: string; orientation: string }>)[1]!;
    claim('mcp/tools.md', '"tool": "advance_run",');
    claim('mcp/tools.md', '"call_with": { "run_id": "<run>" }');
    claim('mcp/tools.md', '"params": { "run_id": "<run>" },');
    const actInstruction = (
      r['next_actions'] as Array<{
        instruction: { tool: string; params: unknown; call_with: unknown };
      }>
    )[1]!.instruction;
    expect(actInstruction).toMatchObject({
      tool: 'advance_run',
      params: { run_id: runId },
      call_with: { run_id: runId },
    });
    expect([act.human_readable, act.orientation]).toEqual([
      "Call advance_run to run the step the engine owes: 'e'. It runs it with this server's extensions and environment.",
      expect.stringContaining("Engine work is owed: 'e'."),
    ]);
    const state = await call('get_run_state', { run_id: runId });
    expect(next(state)).toEqual(['execute_step:d', 'advance_run:']);
    await workflowStore.register(gated('docs-act-exp', 'settle_default'));
    const exp = (await call('start_run', { workflow_id: 'docs-act-exp' }))['run_id'] as string;
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const expState = await call('get_run_state', { run_id: exp });
    const expAct = (expState['next_actions'] as Array<{ human_readable: string }>).at(-1)!;
    expect(expAct.human_readable).toBe(
      "Call advance_run to carry out the expired question on 'confirm' (its declared settle_default), then run what it leaves owed. It runs with this server's extensions and environment.",
    );
    await workflowStore.register({
      ...gated('docs-act-batch'),
      steps: { only: { description: 'O.', execution: 'auto', depends_on: [] } },
    } as WorkflowDefinition);
    const batch = (await call('start_run_batch', {
      workflow_id: 'docs-act-batch',
      items: [{ params: {} }],
    })) as Reply & { started: Reply[] };
    expect(next(batch.started[0]!)).toEqual(['advance_run:']);
  });
});

describe('#625 PR-2a, C163 — gates.md: what happens at expiry over MCP, sentence by sentence', () => {
  it('C163 gates.md: once the time is up on a gate with on_expiry, get_run_state offers advance_run (advance_owed), which carries it out and runs what it made ready; a gate with no on_expiry is never touched', async () => {
    claim(
      'workflow/gates.md',
      'Once the time is up on a gate that declares `on_expiry`, `get_run_state` offers `advance_run`, which carries out the declared default or abort and then runs the steps it makes ready; a gate with no `on_expiry` is never touched.',
    );
    claim(
      'workflow/gates.md',
      "The status is then `advance_owed`, or `claim_stale` when another step's claim is past its time.",
    );
    const { call, workflowStore, runStore } = await connect();
    await workflowStore.register(gated('docs-g-exp', 'settle_default'));
    await workflowStore.register({
      ...gated('docs-g-none'),
      steps: {
        ...gated('docs-g-none').steps,
        confirm: {
          ...gated('docs-g-none').steps['confirm']!,
          gate: { choices: ['approve', 'reject'], timeout_seconds: 1 },
        },
      },
    } as WorkflowDefinition);
    const exp = (await call('start_run', { workflow_id: 'docs-g-exp' }))['run_id'] as string;
    const none = (await call('start_run', { workflow_id: 'docs-g-none' }))['run_id'] as string;
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const s = await call('get_run_state', { run_id: exp });
    // (a) red when an expired question is not offered to the engine, or one without on_expiry is; (b) prints them.
    expect([next(s).at(-1), s['next_actions_status']]).toEqual(['advance_run:', 'advance_owed']);
    const done = await call('advance_run', { run_id: exp });
    expect(done['run_phase']).toBe('completed');
    const n = await call('get_run_state', { run_id: none });
    expect([next(n), n['next_actions_status']]).toEqual([
      ['submit_human_response:'],
      'awaiting_human',
    ]);
    await call('advance_run', { run_id: none });
    expect((await runStore.get(none)).pending_gate).toBeDefined();
  });

  it('C163 gates.md: the status is claim_stale when another step’s claim is past its time', async () => {
    claim(
      'workflow/gates.md',
      "The status is then `advance_owed`, or `claim_stale` when another step's claim is past its time.",
    );
    const def = {
      id: 'docs-g-stale',
      name: 'docs-g-stale',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: {
        x: { description: 'X.', execution: 'agent', depends_on: [] },
        confirm: gated('docs-g-stale', 'settle_default').steps['confirm']!,
      },
    } as WorkflowDefinition;
    const { call, workflowStore, runStore } = await connect();
    await workflowStore.register(def);
    const { run } = await runStore.create({ workflowId: def.id, workflowVersion: 1, params: {} });
    const runId = run.id;
    await runStore.claimStep(runId, 'x', def);
    const opened = await executeStep(runStore, def, {
      runId,
      command: 'confirm',
      input: {},
      dispatcher: async () => ({}),
    });
    expect(opened.status, 'fixture: the question opens beside the claim').toBe('confirm_required');
    const rec = await runStore.get(runId);
    expect(rec.pending_gate, 'fixture: the question is open').toBeDefined();
    await runStore.update({
      ...rec,
      claims: { ...rec.claims, x: { ...rec.claims!['x']!, deadline: '2000-01-01T00:00:00.000Z' } },
      pending_gate: { ...rec.pending_gate!, expires_at: '2000-01-01T00:00:00.000Z' },
    });
    const s = await call('get_run_state', { run_id: runId });
    expect(s['next_actions_status']).toBe('claim_stale');
  });

  it('C163 gates.md: a server that cannot read the workflow says workflow_unresolved', async () => {
    claim(
      'workflow/gates.md',
      'A server that cannot read the workflow says `workflow_unresolved` instead.',
    );
    const { call, runStore } = await connect();
    const { run } = await runStore.create({
      workflowId: 'never-registered',
      workflowVersion: 1,
      params: {},
    });
    const s = await call('get_run_state', { run_id: run.id });
    expect(s['next_actions_status']).toBe('workflow_unresolved');
  });

  it("C163 gates.md: get_run_state gives the answer the expiry wrote answered_by { by: null, absent_cause: 'settled_by_expiry' }", async () => {
    claim(
      'workflow/gates.md',
      'and `get_run_state` gives that answer `answered_by: { "by": null, "absent_cause": "settled_by_expiry" }`.',
    );
    const { call, workflowStore } = await connect();
    await workflowStore.register(gated('docs-g-ans', 'settle_default'));
    const runId = (await call('start_run', { workflow_id: 'docs-g-ans' }))['run_id'] as string;
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await call('advance_run', { run_id: runId });
    const s = await call('get_run_state', { run_id: runId, include_steps: true });
    const answers = (s['steps'] as Record<string, { answers?: Array<{ answered_by: unknown }> }>)[
      'confirm'
    ]?.answers;
    expect(answers?.[0]?.answered_by).toEqual({ by: null, absent_cause: 'settled_by_expiry' });
  });

  it('C163 gates.md: the call that carries out an expiry says so in its warnings, naming itself — over MCP the tool (a late answer, a step of the run, advance_run)', async () => {
    claim(
      'workflow/gates.md',
      'The call that carries out an expiry says so in its `warnings`, naming itself: over MCP the tool — for a late answer, `this submit_human_response call first carried out its declared …` (`enacted_via: submit_human_response`)',
    );
    claim(
      'workflow/gates.md',
      'A gate whose time is up stays open until a call acts on its run: a late answer, a call to another step of the run, `advance_run` (or `realm run advance`, or `advanceRun` in a program)',
    );
    const { call, workflowStore, runStore } = await connect();
    await workflowStore.register(gated('docs-g-name', 'settle_default'));
    const runs: Record<string, string> = {};
    for (const tool of ['submit_human_response', 'execute_step', 'advance_run']) {
      runs[tool] = (await call('start_run', { workflow_id: 'docs-g-name' }))['run_id'] as string;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    for (const tool of ['submit_human_response', 'execute_step', 'advance_run'] as const) {
      const runId = runs[tool]!;
      const gateId = (await runStore.get(runId)).pending_gate!.gate_id;
      expect(
        (await runStore.get(runId)).pending_gate,
        `${tool}: still open until a call acts`,
      ).toBeDefined();
      const r =
        tool === 'submit_human_response'
          ? await call(tool, { run_id: runId, gate_id: gateId, choice: 'approve' })
          : tool === 'execute_step'
            ? await call(tool, { run_id: runId, command: 'after', params: {} })
            : await call(tool, { run_id: runId });
      // (a) red when a tool's line names another call; (b) prints its warnings.
      expect(r['warnings'], tool).toContain(
        `gate '${gateId}' on 'confirm' had expired — this ${tool} call first carried out its declared settle_default: the default choice 'approve' was recorded (enacted_via: ${tool}).`,
      );
    }
  });
});

/** `b` (agent) → `a` (agent, precondition `b.output.go == true`) → `c` (agent, after `a`). */
const STUCK_CHAIN: WorkflowDefinition = {
  ...STUCK,
  id: 'docs-stuck-chain',
  name: 'docs-stuck-chain',
  steps: { ...STUCK.steps, c: { description: 'C.', execution: 'agent', depends_on: ['a'] } },
} as WorkflowDefinition;

describe('#625 PR-2a, C163 — tools.md: each tool and case a sentence names that the cells above leave out', () => {
  it('C163 chained_auto_steps: from start_run too — the auto steps it ran', async () => {
    claim(
      'mcp/tools.md',
      'From `start_run`, `execute_step` and `advance_run` (added after version 0.46.0).',
    );
    const { call, workflowStore } = await connect();
    const def = {
      id: 'docs-start-chain',
      name: 'docs-start-chain',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: {
        one: { description: 'One.', execution: 'auto', depends_on: [] },
        ask: { description: 'Ask.', execution: 'agent', depends_on: ['one'] },
      },
    } as WorkflowDefinition;
    await workflowStore.register(def);
    const r = await call('start_run', { workflow_id: def.id });
    expect((r['chained_auto_steps'] as Array<{ step: string }>).map((e) => e.step)).toEqual([
      'one',
    ]);
  });

  it('C163 stopped_step: from execute_step on an error a chained step produced, and from advance_run on the question it opened', async () => {
    claim(
      'mcp/tools.md',
      "From `execute_step`, `start_run` and `advance_run` (added after version 0.46.0), on an `error`, `blocked` or `confirm_required` reply that a step's call produced",
    );
    const { call, workflowStore, runStore } = await connect();
    await workflowStore.register(STEPS);
    const runId = (
      await call('start_run', { workflow_id: STEPS.id, params: { path: '/no/such/file-625' } })
    )['run_id'] as string;
    const r = await call('execute_step', { run_id: runId, command: 'a', params: { go: false } });
    expect([r['status'], r['stopped_step'], r['command']]).toEqual(['error', 'fails', 'a']);
    const def = {
      id: 'docs-adv-stop',
      name: 'docs-adv-stop',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: {
        ask: { description: 'Ask.', execution: 'agent', depends_on: [] },
        confirm: { ...gated('x').steps['confirm']!, depends_on: ['ask'] },
      },
    } as WorkflowDefinition;
    await workflowStore.register(def);
    const { run } = await runStore.create({ workflowId: def.id, workflowVersion: 1, params: {} });
    await executeStep(runStore, def, {
      runId: run.id,
      command: 'ask',
      input: {},
      dispatcher: async () => ({}),
    });
    const adv = await call('advance_run', { run_id: run.id });
    expect([adv['status'], adv['stopped_step']]).toEqual(['confirm_required', 'confirm']);
  });

  it('C163 start_run: an agent step refused before its claim (an invalid trust) is named as a step that cannot run and never offered', async () => {
    claim(
      'mcp/tools.md',
      '— an `auto` step, or an agent step refused before its claim for a failed precondition or an invalid `trust`, which is never offered in `next_actions`',
    );
    const { call, workflowStore } = await connect();
    await workflowStore.register(TRUSTY);
    const r = await call('start_run', { workflow_id: TRUSTY.id });
    expect(String(r['context_hint'])).toMatch(/'t' cannot run \(trust\): /);
    expect(next(r)).toEqual(['execute_step:ok']);
  });

  it('C163 not ready: a step whose dependency cannot run — named, then the way out', async () => {
    claim(
      'mcp/tools.md',
      'a step it depends on cannot run (named — then what the run can still do, or the way out);',
    );
    const { call, workflowStore } = await connect();
    await workflowStore.register(STUCK_CHAIN);
    const runId = (await call('start_run', { workflow_id: STUCK_CHAIN.id }))['run_id'] as string;
    await call('execute_step', { run_id: runId, command: 'b', params: { go: false } });
    const r = await call('execute_step', { run_id: runId, command: 'c', params: {} });
    expect(String(r['context_hint'])).toMatch(
      /^Step 'c' cannot be called now: a step it depends on cannot run \('a'\)/,
    );
    expect(String(r['context_hint']).endsWith(WAY_OUT)).toBe(true);
    expect([r['agent_action'], next(r)]).toEqual(['report_to_user', []]);
  });

  it('C163 submit_human_response: a gate ID that is not the open one with nothing to offer — report_to_user, No question is open on this run.', async () => {
    claim(
      'mcp/tools.md',
      'and its `agent_action` is `resolve_precondition` (`report_to_user` when `next_actions` is empty).',
    );
    const { call, workflowStore } = await connect();
    await workflowStore.register(STUCK);
    const runId = (await call('start_run', { workflow_id: STUCK.id }))['run_id'] as string;
    await call('execute_step', { run_id: runId, command: 'b', params: { go: false } });
    const r = await call('submit_human_response', {
      run_id: runId,
      gate_id: 'x',
      choice: 'approve',
    });
    expect([r['agent_action'], next(r)]).toEqual(['report_to_user', []]);
    expect(String(r['context_hint'])).toContain('No question is open on this run.');
  });

  it('C163 start_run_batch: a repeat matched by an item’s idempotency_key — Matched existing run …', async () => {
    claim('mcp/tools.md', '(or `Matched existing run …` for a repeat)');
    const { call, workflowStore } = await connect();
    await workflowStore.register(AGENT_THEN_AUTO);
    const first = (await call('start_run_batch', {
      workflow_id: AGENT_THEN_AUTO.id,
      items: [{ params: {}, idempotency_key: 'k' }],
    })) as Reply & { started: Reply[] };
    const again = (await call('start_run_batch', {
      workflow_id: AGENT_THEN_AUTO.id,
      items: [{ params: {}, idempotency_key: 'k' }],
    })) as Reply & { started: Reply[] };
    const runId = String(first.started[0]!['run_id']);
    expect(again.started[0]!['context_hint']).toBe(
      `Matched existing run '${runId}' (idempotent) in phase 'running'; no new run created. Ready for the agent: 'ask'.`,
    );
  });

  it('C163 advance_run: offered after resume — a failed auto step made runnable again is engine work owed', async () => {
    claim(
      'mcp/tools.md',
      "every reply and `get_run_state` end `next_actions` with this act whenever engine work is owed and nobody is running it — after a gate is answered, when a question's time is up and it declares `on_expiry`, after `resume`, and for a run `start_run_batch` created.",
    );
    const { call, workflowStore, runStore } = await connect();
    await workflowStore.register(STEPS);
    const runId = (
      await call('start_run', { workflow_id: STEPS.id, params: { path: '/no/such/file-625' } })
    )['run_id'] as string;
    await call('execute_step', { run_id: runId, command: 'a', params: { go: false } });
    await call('abandon_run', { run_id: runId });
    const { applyResume } = await import('@sensigo/realm');
    await runStore.update(applyResume(await runStore.get(runId), 'fails', STEPS).run);
    const state = await call('get_run_state', { run_id: runId });
    expect(next(state).at(-1)).toBe('advance_run:');
  });
});

describe('#625 PR-2a, round 21 — C170, C171, C172 over a real MCP client', () => {
  const PER_KIND =
    "`it completed, and nothing is owed.` for a completed run; `an aborted run is never resumed; 'realm run purge <id> --force' removes its record.` for an aborted one; `'realm run resume <id> --from <step>' makes the failed step runnable again, or 'realm run purge <id> --force' removes its record.` for a failed or abandoned one in which a step failed (that step named), and `no step failed, so 'realm run resume' has nothing to run again; 'realm run purge <id> --force' removes its record.` for one in which none did.";

  it.each([
    'completed',
    'aborted',
    'failed',
    'abandoned',
    'abandoned after a failed step',
  ] as const)(
    'C170, W4-Y1: an answer to a %s run is refused with the way out true for that kind of ending',
    async (kind) => {
      claim('mcp/tools.md', PER_KIND);
      const { call, workflowStore, runStore } = await connect();
      let runId: string;
      if (kind === 'completed') {
        const again = await endedRun();
        runId = again.runId;
        const r = await again.call('submit_human_response', {
          run_id: runId,
          gate_id: 'other',
          choice: 'approve',
        });
        expect(r['context_hint']).toBe(
          `Run '${runId}' is terminal (completed); cannot submit a gate response — it completed, and nothing is owed.`,
        );
        return;
      }
      if (kind === 'aborted') {
        await workflowStore.register(gated('r21-abort', 'abort'));
        runId = (await call('start_run', { workflow_id: 'r21-abort' }))['run_id'] as string;
        await new Promise((resolve) => setTimeout(resolve, 1_100));
        await call('advance_run', { run_id: runId });
      } else if (kind === 'failed') {
        await workflowStore.register({
          ...SCHEMA,
          id: 'r21-fail',
          steps: { ask: { ...SCHEMA.steps['ask']!, validation_exhaustion: { threshold: 1 } } },
        } as WorkflowDefinition);
        runId = (await call('start_run', { workflow_id: 'r21-fail' }))['run_id'] as string;
        for (let i = 0; i < 3; i += 1) {
          await call('execute_step', { run_id: runId, command: 'ask', params: { n: 'x' } });
        }
      } else if (kind === 'abandoned') {
        await workflowStore.register(AGENT_THEN_AUTO);
        runId = (await call('start_run', { workflow_id: AGENT_THEN_AUTO.id }))['run_id'] as string;
        await call('abandon_run', { run_id: runId });
      } else {
        await workflowStore.register(STEPS);
        runId = (
          await call('start_run', { workflow_id: STEPS.id, params: { path: '/no/such/file-625' } })
        )['run_id'] as string;
        await call('execute_step', { run_id: runId, command: 'a', params: { go: false } });
        await call('abandon_run', { run_id: runId });
      }
      const phase = kind === 'abandoned after a failed step' ? 'abandoned' : kind;
      expect((await runStore.get(runId)).run_phase, 'fixture').toBe(phase);
      const r = await call('submit_human_response', {
        run_id: runId,
        gate_id: 'other',
        choice: 'approve',
      });
      const purge = `'realm run purge ${runId} --force' removes its record`;
      const wayOut =
        kind === 'aborted'
          ? `an aborted run is never resumed; ${purge}.`
          : kind === 'failed'
            ? `'realm run resume ${runId} --from ask' makes the failed step runnable again, or ${purge}.`
            : kind === 'abandoned after a failed step'
              ? `'realm run resume ${runId} --from fails' makes the failed step runnable again, or ${purge}.`
              : `no step failed, so 'realm run resume' has nothing to run again; ${purge}.`;
      // (a) red when the refusal offers a way out that kind of ending does not have; (b) prints it.
      expect([r['error_code'], r['agent_action'], r['context_hint']]).toEqual([
        'STATE_RUN_TERMINAL',
        'report_to_user',
        `Run '${runId}' is terminal (${phase}); cannot submit a gate response — ${wayOut}`,
      ]);
    },
  );

  it('C170 (the sweep’s member): a run in which two steps failed offers `--from` with both of them to choose from', async () => {
    claim('mcp/tools.md', PER_KIND);
    const { call, workflowStore, runStore } = await connect();
    const twoFail = loadWorkflowFromString(
      [
        'id: r21-two-fail',
        'name: r21-two-fail',
        'version: 1',
        'services:',
        '  files:',
        '    adapter: filesystem',
        '    trust: engine_delivered',
        'steps:',
        '  a:',
        '    description: A.',
        '    execution: agent',
        ...['one', 'two'].flatMap((s) => [
          `  ${s}:`,
          `    description: ${s}.`,
          '    execution: auto',
          '    depends_on: [a]',
          '    uses_service: files',
          '    operation: read',
          '    input_map:',
          '      path: run.params.path',
        ]),
        '  last:',
        '    description: L.',
        '    execution: agent',
        '    depends_on: [one, two]',
        '',
      ].join('\n'),
    );
    await workflowStore.register(twoFail);
    const runId = (
      await call('start_run', {
        workflow_id: 'r21-two-fail',
        params: { path: '/no/such/file-625' },
      })
    )['run_id'] as string;
    await call('execute_step', { run_id: runId, command: 'a', params: {} });
    // `one` fails in the chain `a` starts; advance_run runs `two`, which fails too — `last` can never run.
    await call('advance_run', { run_id: runId });
    const run = await runStore.get(runId);
    expect([run.run_phase, [...run.failed_steps].sort()], 'fixture').toEqual([
      'failed',
      ['one', 'two'],
    ]);
    const r = await call('submit_human_response', {
      run_id: runId,
      gate_id: 'other',
      choice: 'approve',
    });
    // red when the refusal names one failed step as the only way back in, or none.
    expect(r['context_hint']).toBe(
      `Run '${runId}' is terminal (failed); cannot submit a gate response — 'realm run resume ${runId} --from <one of: ${run.failed_steps.join(', ')}>' makes the failed step runnable again, or 'realm run purge ${runId} --force' removes its record.`,
    );
  });

  it('C171, W4-Y2: repeating the choice the question’s expiry recorded says it was settled by timeout, as the CLI does; a person’s recorded choice repeated still says already resolved', async () => {
    claim(
      'mcp/tools.md',
      "or, when the question's expiry recorded that choice, `the outcome matches your choice, but it was settled by timeout; your response was not recorded.` with `answer_recorded: false`.",
    );
    claim(
      'mcp/tools.md',
      "(`… was already resolved with choice '<c>' — no action was taken.`, or the expiry's sentence when the question's expiry recorded it).",
    );
    const { call, workflowStore, runStore } = await connect();
    await workflowStore.register(gated('r21-exp', 'settle_default'));
    const runId = (await call('start_run', { workflow_id: 'r21-exp' }))['run_id'] as string;
    const gateId = (await runStore.get(runId)).pending_gate!.gate_id;
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await call('advance_run', { run_id: runId });
    const r = await call('submit_human_response', {
      run_id: runId,
      gate_id: gateId,
      choice: 'approve',
    });
    // (a) red when the repeat reads as a person's recorded answer; (b) prints it.
    expect([r['status'], 'agent_action' in r, r['answer_recorded'], r['context_hint']]).toEqual([
      'ok',
      false,
      false,
      'the outcome matches your choice, but it was settled by timeout; your response was not recorded.',
    ]);
    const { call: c2, runId: done, gateId: g2 } = await endedRun();
    const human = await c2('submit_human_response', {
      run_id: done,
      gate_id: g2,
      choice: 'approve',
    });
    expect([human['context_hint'], 'answer_recorded' in human]).toEqual([
      `Gate '${g2}' was already resolved with choice 'approve' — no action was taken.`,
      false,
    ]);
  });

  const CANNOT_READ_MCP =
    'A run whose record the store cannot read (a file that is not JSON, an I/O error) is refused by `execute_step`, `submit_human_response`, `advance_run` and `get_run_state` with `ENGINE_STORE_FAILED` and `agent_action: "stop"`, naming the cause — `Failed to load run from store: <its message>` — as the library answers it;';
  it.each([
    ['execute_step', { command: 'a', params: {} }],
    ['submit_human_response', { gate_id: 'g', choice: 'x' }],
    ['advance_run', {}],
    ['get_run_state', {}],
  ] as const)(
    'C172: %s on a record that is not JSON — ENGINE_STORE_FAILED naming the cause, stop',
    async (tool, args) => {
      claim('mcp/tools.md', CANNOT_READ_MCP);
      const { call, dir } = await connect();
      mkdirSync(join(dir, 'runs'), { recursive: true });
      writeFileSync(join(dir, 'runs', 'broken.json'), '{not json');
      const r = await call(tool, { run_id: 'broken', ...args });
      // (a) red when the tool answers ENGINE_INTERNAL again, or drops the cause; (b) prints it.
      expect([r['status'], r['error_code'], r['agent_action']]).toEqual([
        'error',
        'ENGINE_STORE_FAILED',
        'stop',
      ]);
      expect((r['errors'] as string[])[0]).toMatch(/^Failed to load run from store: .*JSON/);
    },
  );

  it.each([
    ['append_trace', { step_id: 'a', entries: [] }, 'ENGINE_INTERNAL'],
    ['abandon_run', {}, undefined],
  ] as const)(
    'C172 (outside #706’s files, reported): %s on a record that is not JSON — the bare message',
    async (tool, args, code) => {
      claim(
        'mcp/tools.md',
        '`append_trace` and `abandon_run` refuse it with the bare message: `append_trace` with `ENGINE_INTERNAL`, `abandon_run` with no code.',
      );
      const { call, dir } = await connect();
      mkdirSync(join(dir, 'runs'), { recursive: true });
      writeFileSync(join(dir, 'runs', 'broken.json'), '{not json');
      const r = await call(tool, { run_id: 'broken', ...args });
      expect([r['status'], r['error_code']]).toEqual(['error', code]);
      expect((r['errors'] as string[])[0]).not.toMatch(/^Failed to load run from store/);
    },
  );
});

describe('#625 PR-2a, round 22 — C177, C178 over a real MCP client', () => {
  it.each(['completed', 'abandoned'] as const)(
    'C177, W3-1: abandon_run on a %s run — refused for a run that ended otherwise, the same reply again for an abandoned one',
    async (kind) => {
      claim(
        'mcp/tools.md',
        "A completed, aborted or failed run is refused with `STATE_RUN_TERMINAL` and `report_to_user`: `Run '<id>' is already terminal (<phase>); cannot abandon a finished run.` An abandoned run is not refused: the reply is the one [`abandon_run`](#abandon_run) gives, and its `note` begins `already abandoned (no change this call).`",
      );
      let call: Awaited<ReturnType<typeof connect>>['call'];
      let runId: string;
      if (kind === 'completed') {
        ({ call, runId } = await endedRun());
      } else {
        const h = await connect();
        call = h.call;
        await h.workflowStore.register(AGENT_THEN_AUTO);
        runId = (await call('start_run', { workflow_id: AGENT_THEN_AUTO.id }))['run_id'] as string;
        const first = await call('abandon_run', { run_id: runId });
        expect(first['run_phase'], 'fixture').toBe('abandoned');
      }
      const r = await call('abandon_run', { run_id: runId });
      // (a) red when an abandoned run is refused, or another ended run is not; (b) prints the reply.
      if (kind === 'completed') {
        expect([r['error_code'], r['agent_action'], (r['errors'] as string[])[0]]).toEqual([
          'STATE_RUN_TERMINAL',
          'report_to_user',
          `Run '${runId}' is already terminal (completed); cannot abandon a finished run.`,
        ]);
      } else {
        expect([r['_isError'], r['run_phase'], r['terminal_state']]).toEqual([
          false,
          'abandoned',
          true,
        ]);
        expect(String(r['note'])).toMatch(/^already abandoned \(no change this call\)\./);
      }
    },
  );

  it('C178, W4-1: a different choice after an earlier call carried the expiry out is told the expiry chose — and error_details carries resolved_by; a person’s recorded choice is not', async () => {
    claim(
      'mcp/tools.md',
      "When an earlier call carried the expiry out, an answer that names another choice is refused with the same words and the same `error_details`, `resolved_by: \"timeout\"` included: `Gate '<gate>' was settled by timeout with choice '<c>' — your choice '<other>' was not recorded.` It has no expiry line in `warnings`; that call printed it. A choice a person recorded first is refused with `Gate '<gate>' was already resolved with choice '<c>' — your choice '<other>' was not recorded.`, and its `error_details` have no `resolved_by`.",
    );
    const { call, workflowStore, runStore } = await connect();
    await workflowStore.register(gated('r22-exp', 'settle_default'));
    const runId = (await call('start_run', { workflow_id: 'r22-exp' }))['run_id'] as string;
    const gateId = (await runStore.get(runId)).pending_gate!.gate_id;
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await call('advance_run', { run_id: runId });
    const late = await call('submit_human_response', {
      run_id: runId,
      gate_id: gateId,
      choice: 'reject',
    });
    // (a) red when the refusal reads as a person's choice, or a program cannot tell from
    //     error_details; (b) prints the reply.
    expect([
      late['error_code'],
      late['agent_action'],
      (late['errors'] as string[])[0],
      late['error_details'],
      late['answer_recorded'],
      ((late['warnings'] as string[] | undefined) ?? []).some((w) => w.includes('had expired')),
    ]).toEqual([
      'STATE_BLOCKED',
      'report_to_user',
      `Gate '${gateId}' was settled by timeout with choice 'approve' — your choice 'reject' was not recorded.`,
      { runId, gateId, winning_choice: 'approve', resolved_by: 'timeout' },
      false,
      false,
    ]);
    const { call: c2, runId: done, gateId: g2 } = await endedRun();
    const person = await c2('submit_human_response', {
      run_id: done,
      gate_id: g2,
      choice: 'reject',
    });
    expect([(person['errors'] as string[])[0], person['error_details']]).toEqual([
      `Gate '${g2}' was already resolved with choice 'approve' — your choice 'reject' was not recorded.`,
      { runId: done, gateId: g2, winning_choice: 'approve' },
    ]);
  });
});
