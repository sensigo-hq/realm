// own-act-a1a.test.ts — issue #625 PR-2b (A1a), over a real MCP client: a reply that did an act and
// then ran the chain keeps the act's own result.
//
// An assistant runs step `draft`; Realm then runs `send` by itself, and `send` cannot run here, or
// fails, or opens a question. Today's reply names only `send`, so the assistant tells the user its
// draft failed. After A1a the reply keeps every member it has today, adds
// `own_act: { command, recorded: true }` (the MCP door strips its `evidence`, as it strips
// `evidence` itself), and its text opens with the act's words exactly once.
//
// These cells are the prompt's acceptance checks 1 (the real harm, through the tool), 7 (start_run,
// with its four controls) and 8 (the answer form's arms). Every assertion carries (a) the change
// that turns it red and (b) what it prints.
import { describe, it, expect, afterEach } from 'vitest';
import {
  ExtensionRegistry,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  type RunStore,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createRealmMcpServer } from './server.js';
import { makeTempHome, runsOf, type TempHome } from './test-support/temp-home.js';

type Reply = Record<string, unknown>;
type ElicitReply = { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> };

const def = (id: string, steps: WorkflowDefinition['steps']): WorkflowDefinition =>
  ({
    id,
    name: id,
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps,
  }) as WorkflowDefinition;

/** `draft`, then `send`, whose handler this server lacks (a capability block). */
const BLOCKED = def('a1a-blocked', {
  draft: { description: 'Draft.', execution: 'agent', depends_on: [] },
  send: { description: 'Send.', execution: 'auto', depends_on: ['draft'], handler: 'mailer' },
} as WorkflowDefinition['steps']);

/** start_run's run: `head` runs, then `boom`, whose handler throws. */
const SECOND_FAILS = def('a1a-second-fails', {
  head: { description: 'Head.', execution: 'auto', depends_on: [], handler: 'ok' },
  boom: { description: 'Boom.', execution: 'auto', depends_on: ['head'], handler: 'boom' },
} as WorkflowDefinition['steps']);

/** start_run's run that ends `ok`: `head` runs, then the agent's `finish` is next. */
const HEAD_THEN_AGENT = def('a1a-head-agent', {
  head: { description: 'Head.', execution: 'auto', depends_on: [] },
  finish: { description: 'Finish.', execution: 'agent', depends_on: ['head'] },
} as WorkflowDefinition['steps']);

/** start_run's capability-block creation reply (C52): `enrich`'s handler is missing, `ask` is ready. */
const HEAD_BLOCKED = def('a1a-head-blocked', {
  enrich: { description: 'Enrich.', execution: 'auto', depends_on: [], handler: 'h' },
  ask: { description: 'Ask.', execution: 'agent', depends_on: [] },
} as WorkflowDefinition['steps']);

/** tools.md's guard example: the agent step `assess`, then the guard `only_low_risk`. */
const REFUNDS = def('a1a-refunds', {
  assess: { description: 'Assess.', execution: 'agent', depends_on: [] },
  only_low_risk: {
    description: 'Stop the run unless the refund is low risk.',
    execution: 'guard',
    depends_on: ['assess'],
    abort_unless: ["assess.risk == 'low'"],
    abort_message: 'High-risk refunds are not paid automatically.',
  },
} as WorkflowDefinition['steps']);

/** `draft`, then the question `q`, then the agent's `after`. `timeout` gives `q` a deadline. */
const ASKS = (timeout?: number) =>
  def('a1a-asks', {
    draft: { description: 'Draft.', execution: 'agent', depends_on: [] },
    q: {
      description: 'Ask.',
      execution: 'auto',
      trust: 'human_confirmed',
      depends_on: ['draft'],
      gate: {
        choices: ['approve', 'reject'],
        message: 'Ship it?',
        ...(timeout !== undefined ? { timeout_seconds: timeout, on_expiry: 'abort' } : {}),
      },
    },
    after: { description: 'After.', execution: 'agent', depends_on: ['q'] },
  } as WorkflowDefinition['steps']);

function registry(): ExtensionRegistry {
  const r = new ExtensionRegistry();
  r.register('handler', 'ok', { id: 'ok', execute: async () => ({ data: { ran: 'ok' } }) });
  r.register('handler', 'boom', {
    id: 'boom',
    execute: async () => {
      throw new Error('boom failed');
    },
  });
  return r;
}

const handles: TempHome[] = [];
afterEach(async () => {
  for (const h of handles.splice(0).reverse()) await h.cleanup();
});

/**
 * A real MCP server on a home of its own and a client. With `form`, the client shows forms and
 * answers each with `form` (which may act on the store first); the server keeps the gate-answers
 * default. Without it, the client shows none and the answer tool is listed (`permitted`).
 */
async function connect(
  defs: WorkflowDefinition[],
  form?: (ctx: { runStore: RunStore }) => Promise<ElicitReply>,
) {
  const h = await makeTempHome();
  handles.push(h);
  const { runStore, workflowStore } = h.stores;
  for (const d of defs) await workflowStore.register(d);
  const server = createRealmMcpServer({
    ...h.stores,
    ...(form === undefined ? { gateAnswers: 'permitted' as const } : {}),
    registry: registry(),
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: 'own-act-a1a', version: '0' },
    form !== undefined ? { capabilities: { elicitation: { form: {} } } } : {},
  );
  let forms = 0;
  if (form !== undefined) {
    client.setRequestHandler(ElicitRequestSchema, async () => {
      forms += 1;
      return form({ runStore });
    });
  }
  await Promise.all([server.connect(st), client.connect(ct)]);
  const call = async (name: string, args: Record<string, unknown>): Promise<Reply> => {
    const raw = (await client.callTool({ name, arguments: args }, undefined, {
      timeout: 600_000,
    })) as { content: Array<{ text: string }> };
    return JSON.parse(raw.content[0]!.text) as Reply;
  };
  return { call, runStore, forms: () => forms };
}

async function freshRun(runStore: RunStore, d: WorkflowDefinition): Promise<string> {
  const { record } = await runStore.create({ workflowId: d.id, workflowVersion: 1, params: {} });
  return record.id;
}

/** How many times `words` appears in `text`. */
const occurrences = (text: unknown, words: string): number => String(text).split(words).length - 1;

describe('#625 A1a — over MCP: the act recorded, then the chain', () => {
  it('check 1 — the real harm: execute_step on `draft`, whose chained `send` cannot run here → today’s error members, plus exactly own_act, and the opening', async () => {
    const c = await connect([BLOCKED]);
    const runId = await freshRun(c.runStore, BLOCKED);

    const r = await c.call('execute_step', {
      run_id: runId,
      command: 'draft',
      params: { body: 'Hello' },
    });

    // (a) red when the member is left out, carries the act's evidence past the door, or the error
    //     members become the act's; (b) prints them.
    expect({
      status: r['status'],
      agent_action: r['agent_action'],
      stopped_step: r['stopped_step'],
      own_act: r['own_act'],
    }).toEqual({
      status: 'error',
      agent_action: 'report_to_user',
      stopped_step: 'send',
      own_act: { command: 'draft', recorded: true },
    });
    // (a) red when the opening is left out or doubled; (b) prints the hint.
    expect(
      String(r['context_hint']).startsWith("Step 'draft' completed. Step 'send' is blocked:"),
    ).toBe(true);
    expect(occurrences(r['context_hint'], "Step 'draft' completed.")).toBe(1);
    // The run: `draft` recorded, `send` still owed.
    const { record } = await c.runStore.get(runId);
    expect({ completed: record.completed_steps, failed: record.failed_steps }).toEqual({
      completed: ['draft'],
      failed: [],
    });
  });

  it('tools.md’s guard example — execute_step on `assess`, whose answer makes the guard abort the run: the hint opens with the step, own_act names it', async () => {
    const c = await connect([REFUNDS]);
    const runId = await freshRun(c.runStore, REFUNDS);

    const r = await c.call('execute_step', {
      run_id: runId,
      command: 'assess',
      params: { risk: 'high' },
    });

    // (a) red when the guard-ending sentence is not opened with the called step's words, or the
    //     member is missing; (b) prints the example's members as the page shows them.
    expect({
      command: r['command'],
      status: r['status'],
      context_hint: r['context_hint'],
      run_phase: r['run_phase'],
      guards: r['guards'],
      ended_by: r['ended_by'],
      chained_auto_steps: r['chained_auto_steps'],
      own_act: r['own_act'],
    }).toEqual({
      command: 'assess',
      status: 'ok',
      context_hint: "Step 'assess' completed. Guard step 'only_low_risk' aborted the run.",
      run_phase: 'aborted',
      guards: [{ step: 'only_low_risk', outcome: 'abort' }],
      ended_by: {
        arm: 'guard_abort',
        step: 'only_low_risk',
        reason: 'High-risk refunds are not paid automatically.',
      },
      chained_auto_steps: [{ step: 'only_low_risk', run_phase: 'aborted' }],
      own_act: { command: 'assess', recorded: true },
    });
  });

  it('check 7 — start_run: a run whose second auto step fails → own_act for start_run, the creation sentence once', async () => {
    const c = await connect([SECOND_FAILS]);

    const r = await c.call('start_run', { workflow_id: SECOND_FAILS.id, params: {} });

    const creation = `Run '${String(r['run_id'])}' created for workflow '${SECOND_FAILS.id}'.`;
    // (a) red when the member is computed only in executeChain (start_run then has none), or the
    //     reply's members become the creation's; (b) prints them.
    expect({
      status: r['status'],
      stopped_step: r['stopped_step'],
      own_act: r['own_act'],
      opens: String(r['context_hint']).startsWith(`${creation} Step 'boom' failed.`),
      once: occurrences(r['context_hint'], 'created for workflow'),
    }).toEqual({
      status: 'error',
      stopped_step: 'boom',
      own_act: { command: 'start_run', recorded: true },
      opens: true,
      once: 1,
    });
  });

  it('correction 1 (RD-06) — a rerun whose head step fails again: the reply opens with the plain creation sentence and says the supersede once', async () => {
    const c = await connect([SECOND_FAILS]);
    const first = await c.call('start_run', {
      workflow_id: SECOND_FAILS.id,
      params: {},
      idempotency_key: 'again',
    });
    const rerun = await c.call('start_run', {
      workflow_id: SECOND_FAILS.id,
      params: {},
      idempotency_key: 'again',
      on_terminal_match: 'rerun_if_failed',
    });
    const supersede = `This run supersedes run '${String(first['run_id'])}' under the same idempotency key (on_terminal_match).`;
    // (a) red when the opening is the rerun arm of the creation sentence (the supersede then said
    //     twice); (b) prints the hint's start, the count and its end.
    expect({
      first: first['status'],
      rerun: [rerun['status'], rerun['rerun_of'], rerun['own_act']],
      opens: String(rerun['context_hint']).startsWith(
        `Run '${String(rerun['run_id'])}' created for workflow '${SECOND_FAILS.id}'. Step 'boom' failed.`,
      ),
      supersedes: occurrences(rerun['context_hint'], 'supersedes run'),
      ends: String(rerun['context_hint']).endsWith(supersede),
    }).toEqual({
      first: 'error',
      rerun: ['error', first['run_id'], { command: 'start_run', recorded: true }],
      opens: true,
      supersedes: 1,
      ends: true,
    });
  });

  it('check 7 controls — a de-duplicated repeat, the C52 creation reply, an ok ran reply and advance_run carry no own_act, their hints as today', async () => {
    const c = await connect([SECOND_FAILS, HEAD_THEN_AGENT, HEAD_BLOCKED]);

    const first = await c.call('start_run', {
      workflow_id: SECOND_FAILS.id,
      params: {},
      idempotency_key: 'k',
    });
    const repeat = await c.call('start_run', {
      workflow_id: SECOND_FAILS.id,
      params: {},
      idempotency_key: 'k',
    });
    const blocked = await c.call('start_run', { workflow_id: HEAD_BLOCKED.id, params: {} });
    const ok = await c.call('start_run', { workflow_id: HEAD_THEN_AGENT.id, params: {} });
    const owed = await freshRun(c.runStore, SECOND_FAILS);
    const advanced = await c.call('advance_run', { run_id: owed });

    // (a) red when a de-duplicated repeat, the capability-block creation reply (C52), an `ok` ran
    //     reply or advance_run (computing the member in the loop that advance_run shares) carries
    //     it; (b) prints the members and the hints.
    expect({
      first: first['own_act'] !== undefined,
      repeat: [repeat['deduped'], repeat['own_act']],
      blocked: [blocked['status'], blocked['own_act'], blocked['context_hint']],
      ok: [ok['status'], ok['own_act'], ok['context_hint']],
      advanced: [advanced['status'], advanced['own_act'], advanced['context_hint']],
    }).toEqual({
      first: true,
      repeat: [true, undefined],
      blocked: [
        'ok',
        undefined,
        // As owed-call-625.test.ts's C52 cell pins it.
        `Run '${String(blocked['run_id'])}' created for workflow '${HEAD_BLOCKED.id}'. Ready for the agent: 'ask'. 'enrich' cannot run here (capability): handler 'h' is not registered here — load the missing extension, or run the step on a runner that has it.`,
      ],
      ok: ['ok', undefined, "Step 'head' completed. Ready for the agent: 'finish'."],
      advanced: [
        'error',
        undefined,
        `Step 'boom' failed. Run is terminated. To make the failed step runnable again: realm run resume ${owed} --from boom`,
      ],
    });
  });

  it('check 8 — the answer form, answered inside the call: the recorded answer’s ok reply carries own_act and no stopped_step', async () => {
    const d = ASKS();
    const c = await connect([d], async () => ({
      action: 'accept',
      content: { choice: 'approve' },
    }));
    const runId = await freshRun(c.runStore, d);

    const r = await c.call('execute_step', { run_id: runId, command: 'draft', params: {} });

    // (a) red when `before.stopped_step` (the question's step) is copied onto the recorded answer's
    //     `ok` reply, or the member is dropped; (b) prints them.
    expect({
      forms: c.forms(),
      status: r['status'],
      stopped_step: r['stopped_step'],
      own_act: r['own_act'],
      once: occurrences(r['context_hint'], "Step 'draft' completed."),
      opens: String(r['context_hint']).startsWith("Step 'draft' completed."),
    }).toEqual({
      forms: 1,
      status: 'ok',
      stopped_step: undefined,
      own_act: { command: 'draft', recorded: true },
      once: 1,
      opens: true,
    });
  });

  it('check 8 — a form that came back without an answer: the arm keeps the question’s status and its stopped_step, own_act, the opening once', async () => {
    const d = ASKS();
    const c = await connect([d], async () => ({ action: 'decline' }));
    const runId = await freshRun(c.runStore, d);

    const r = await c.call('execute_step', { run_id: runId, command: 'draft', params: {} });

    // (a) red when the came-back arm drops `before.stopped_step` or the member, or opens twice;
    //     (b) prints them.
    expect({
      forms: c.forms(),
      status: r['status'],
      stopped_step: r['stopped_step'],
      own_act: r['own_act'],
      hint: r['context_hint'],
    }).toEqual({
      forms: 1,
      status: 'confirm_required',
      stopped_step: 'q',
      own_act: { command: 'draft', recorded: true },
      hint: "Step 'draft' completed. Not recorded: the person closed the form without answering. The question on step 'q' is still waiting. To show it again, call present_question (3 left in this session).",
    });
  });

  it('check 8 — the question came due while the form was open: the arm keeps the reply’s own text, which opens with the act once', async () => {
    const d = ASKS(600);
    const c = await connect([d], async ({ runStore }) => {
      // While the form is open, the question's deadline passes.
      const [run] = (await runsOf(runStore)).map((snap) => snap.record);
      await runStore.update({
        ...run!,
        pending_gate: {
          ...run!.pending_gate!,
          expires_at: new Date(Date.now() - 60_000).toISOString(),
        },
      });
      return { action: 'decline' };
    });
    const runId = await freshRun(c.runStore, d);

    const r = await c.call('execute_step', { run_id: runId, command: 'draft', params: {} });

    // (a) red when the opening is applied again on top of the hint the reply kept (twice), or the
    //     member is dropped; (b) prints the hint and the member.
    expect({
      forms: c.forms(),
      own_act: r['own_act'],
      once: occurrences(r['context_hint'], "Step 'draft' completed."),
      opens: String(r['context_hint']).startsWith("Step 'draft' completed. Run is paused at gate"),
    }).toEqual({
      forms: 1,
      own_act: { command: 'draft', recorded: true },
      once: 1,
      opens: true,
    });
  });
});
