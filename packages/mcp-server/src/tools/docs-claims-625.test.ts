// docs-claims-625.test.ts — issue #625 PR-2a, decision C163 (the method): each sentence about reply
// behaviour that #625 PR-2a adds or changes in `docs/reference/mcp/tools.md` and
// `docs/reference/workflow/gates.md` is pinned here, one cell per tool and case it covers. Each
// cell quotes its sentence exactly and asserts the page still holds it (read from the repository),
// then drives the case over a real MCP client (`createRealmMcpServer`, in-memory transport) and
// asserts what the sentence states — so neither the page nor the behaviour can change alone.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  JsonFileStore,
  JsonWorkflowStore,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  loadWorkflowFromString,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createRealmMcpServer } from '../server.js';

const DOCS = join(dirname(fileURLToPath(import.meta.url)), '../../../../docs/reference');
const flat = (t: string) => t.replace(/\s+/g, ' ');

/** (a) red when the page no longer holds the sentence word for word; (b) prints the sentence. */
function claim(page: 'mcp/tools.md' | 'workflow/gates.md', sentence: string): void {
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
      "On an error, except `create_workflow`'s refusal of its steps (its `errors` say what is wrong) and a `get_run_state` or `abandon_run` refusal of an error that carries no code",
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

  it.each(['get_run_state', 'abandon_run'])(
    'C163 error_code: a %s refusal of an error that carries no code (a record that is not JSON) has none',
    async (tool) => {
      claim(
        'mcp/tools.md',
        "On an error, except `create_workflow`'s refusal of its steps (its `errors` say what is wrong) and a `get_run_state` or `abandon_run` refusal of an error that carries no code",
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
    "Never on `confirm_required`, and never on another `ok` reply: on a run that has ended, `advance_run` replies `ok` without it, and so does `submit_human_response` repeating the choice its gate recorded (`… was already resolved with choice '<c>' — no action was taken.`).";
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
      "Another gate ID, or the gate of a question that recorded no choice (its `on_expiry: abort` ended the run), is refused with `STATE_RUN_TERMINAL`: `Run '<id>' is terminal; cannot submit a gate response — …`.",
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
    expect(String(r['context_hint'])).toMatch(
      new RegExp(`^Run '${runId}' is terminal; cannot submit a gate response — `),
    );
  });

  it('C154 submit_human_response on the gate of a question whose abort ended the run: STATE_RUN_TERMINAL, without answer_recorded (gates.md)', async () => {
    claim(
      'mcp/tools.md',
      "Another gate ID, or the gate of a question that recorded no choice (its `on_expiry: abort` ended the run), is refused with `STATE_RUN_TERMINAL`: `Run '<id>' is terminal; cannot submit a gate response — …`.",
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
      "Refused with `STATE_RUN_TERMINAL` and `report_to_user`: `Run '<id>' is already terminal (<phase>); cannot abandon a finished run.`",
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
