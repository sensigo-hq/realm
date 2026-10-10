// docs-sweep-625.test.ts — issue #625 PR-2a, decision C174 (round 22): the falsified-statement sweep
// over every doc page that describes a surface #625 PR-2a changes. Each sentence the sweep corrected
// that says what an MCP tool replies is quoted here (read from the repository, whitespace folded) and
// the case it states is driven over a real MCP client (`createRealmMcpServer`, in-memory transport),
// so neither the page nor the reply can change alone. C163's rule, widened to every page.
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
  ExtensionRegistry,
  createDefaultRegistry,
  loadWorkflowFromString,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createRealmMcpServer } from '../server.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
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

type Reply = Record<string, unknown>;

async function connect(registry?: ExtensionRegistry) {
  const dir = await mkdtemp(join(tmpdir(), 'realm-sweep-625-'));
  const runStore = new JsonFileStore(join(dir, 'runs'));
  const workflowStore = new JsonWorkflowStore(join(dir, 'wf'));
  const server = createRealmMcpServer({
    runStore,
    workflowStore,
    ...(registry !== undefined ? { registry } : {}),
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'docs-sweep-625', version: '0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const call = async (name: string, args: Record<string, unknown>): Promise<Reply> => {
    const raw = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ text: string }>;
    };
    const text = raw.content[0]!.text;
    try {
      return JSON.parse(text) as Reply;
    } catch {
      return { _text: text };
    }
  };
  return { call, client, runStore, workflowStore };
}

const tools = (r: Reply): string[] =>
  ((r['next_actions'] as Array<{ instruction?: { tool?: string } }>) ?? []).map(
    (n) => n.instruction?.tool ?? '',
  );

const wf = (yaml: string): WorkflowDefinition => loadWorkflowFromString(yaml);

describe('#625 PR-2a, C174 — the sweep’s corrected sentences about MCP replies', () => {
  it('human-gates.md, run-state-and-health.md: the answer in a later reply has no claim_token; get_run_state at the gate holds it, as the page’s example shows', async () => {
    claim(
      'docs/guides/human-gates.md',
      "In the reply that opened the gate, that call carries the gate's `claim_token`; the same call in a later reply, such as `get_run_state`'s, has none.",
    );
    const { call, workflowStore } = await connect();
    await workflowStore.register(
      wf(
        [
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
          '',
        ].join('\n'),
      ),
    );
    const s = await call('start_run', { workflow_id: 'triage', params: { ticket: 101 } });
    const runId = s['run_id'] as string;
    await call('execute_step', { run_id: runId, command: 'classify', params: {} });
    const opened = await call('execute_step', {
      run_id: runId,
      command: 'draft',
      params: { reply: 'We have refunded the charge.' },
    });
    const state = await call('get_run_state', { run_id: runId });
    const callWith = (r: Reply) =>
      (r['next_actions'] as Array<{ instruction: { call_with: Record<string, unknown> } }>)[0]!
        .instruction.call_with;
    // (a) red when the opening reply's call loses its token, or a later reply's gains one; (b) prints both.
    expect(['claim_token' in callWith(opened), 'claim_token' in callWith(state)]).toEqual([
      true,
      false,
    ]);
    // run-state-and-health.md's example: (a) red when get_run_state's next_actions at an open gate
    //     is not the page's (ids aside); (b) prints both.
    const gateId = (state['pending_gate'] as { gate_id: string }).gate_id;
    const page = block('docs/reference/mcp/run-state-and-health.md', '"run_phase": "gate_waiting"')
      .join('\n')
      .replaceAll('7da561ee-5987-497d-83a5-1eded6dc9b63', runId)
      .replaceAll('00bb04f5-1bb7-4f38-91c5-14cdb17b3f0e', gateId);
    const shown = JSON.parse(page) as Reply;
    expect([state['next_actions'], state['next_actions_status']]).toEqual([
      shown['next_actions'],
      shown['next_actions_status'],
    ]);
  });

  it('run-state-and-health.md: under ok, next_actions holds the steps that can be called, then advance_run when the engine owes work beside them', async () => {
    claim(
      'docs/reference/mcp/run-state-and-health.md',
      'The steps that can be called, then `advance_run` when the engine owes work beside them. It can be empty.',
    );
    const { call, workflowStore } = await connect();
    await workflowStore.register(
      wf(
        [
          'id: both',
          'name: both',
          'version: 1',
          'steps:',
          '  x:',
          '    description: X.',
          '    execution: agent',
          '  y:',
          '    description: Y.',
          '    execution: auto',
          '',
        ].join('\n'),
      ),
    );
    // A batch run runs no step: `x` is ready for the assistant and `y` is owed to the engine.
    const batch = await call('start_run_batch', { workflow_id: 'both', items: [{ params: {} }] });
    const runId = (batch['started'] as Array<{ run_id: string }>)[0]!.run_id;
    const state = await call('get_run_state', { run_id: runId });
    // (a) red when advance_run is left out beside a ready agent step; (b) prints the list.
    expect([state['next_actions_status'], tools(state)]).toEqual([
      'ok',
      ['execute_step', 'advance_run'],
    ]);
  });

  it('connect-an-mcp-client.md: after an answer the reply names the auto steps owed and offers advance_run', async () => {
    claim(
      'docs/guides/connect-an-mcp-client.md',
      "The reply names them, `Owed to the engine: '<step>' — call advance_run.`, and its `next_actions` holds `advance_run`, which runs them until a step opens a question, fails or ends the run (with more than one owed, the sentence says so: `… — call advance_run; it runs them until a step opens a question, fails or ends the run.`).",
    );
    const { call, workflowStore, runStore } = await connect();
    await workflowStore.register(
      wf(
        [
          'id: ann',
          'name: ann',
          'version: 1',
          'steps:',
          '  review:',
          '    description: Review.',
          '    execution: auto',
          '    trust: human_confirmed',
          '    gate:',
          '      choices: [send, discard]',
          '  send:',
          '    description: Send.',
          '    execution: auto',
          '    depends_on: [review]',
          '',
        ].join('\n'),
      ),
    );
    const runId = (await call('start_run', { workflow_id: 'ann' }))['run_id'] as string;
    const gateId = (await runStore.get(runId)).pending_gate!.gate_id;
    const r = await call('submit_human_response', {
      run_id: runId,
      gate_id: gateId,
      choice: 'send',
    });
    // (a) red when the reply does not name the owed step or offer advance_run; (b) prints both.
    expect([String(r['context_hint']), tools(r)]).toEqual([
      expect.stringContaining("Owed to the engine: 'send' — call advance_run."),
      ['advance_run'],
    ]);
    const ran = await call('advance_run', { run_id: runId });
    expect(ran['run_phase']).toBe('completed');
  });

  it('connect-an-mcp-client.md, how-a-run-moves.md (decision C207, walk c13 YELLOW-3): with two owed, the first of which opens a question, the reply says where advance_run stops; advance_run runs the first and stops at its question', async () => {
    claim(
      'docs/guides/connect-an-mcp-client.md',
      'and its `next_actions` holds `advance_run`, which runs them until a step opens a question, fails or ends the run (with more than one owed, the sentence says so: `… — call advance_run; it runs them until a step opens a question, fails or ends the run.`).',
    );
    claim(
      'docs/start/how-a-run-moves.md',
      'The `auto` steps after the gate are owed to the engine, and the reply names the one call that runs them, until a step opens a question, fails or ends the run.',
    );
    const { call, workflowStore, runStore } = await connect();
    await workflowStore.register(
      wf(
        [
          'id: ann2',
          'name: ann2',
          'version: 1',
          'steps:',
          '  review:',
          '    description: Review.',
          '    execution: auto',
          '    trust: human_confirmed',
          '    gate:',
          '      choices: [send, discard]',
          '  approve:',
          '    description: Approve.',
          '    execution: auto',
          '    depends_on: [review]',
          '    trust: human_confirmed',
          '    gate:',
          '      choices: [ship, hold]',
          '  notify:',
          '    description: Notify.',
          '    execution: auto',
          '    depends_on: [review]',
          '',
        ].join('\n'),
      ),
    );
    const runId = (await call('start_run', { workflow_id: 'ann2' }))['run_id'] as string;
    const gateId = (await runStore.get(runId)).pending_gate!.gate_id;
    const r = await call('submit_human_response', {
      run_id: runId,
      gate_id: gateId,
      choice: 'send',
    });
    const ran = await call('advance_run', { run_id: runId });
    const after = await runStore.get(runId);
    // (a) red when the reply's sentence reads as a promise that both run, or advance_run runs
    //     `notify` past the question; (b) prints them.
    expect({
      hint: String(r['context_hint']),
      status: ran['status'],
      question: after.pending_gate?.step_name,
      notifyRan: after.completed_steps.includes('notify'),
    }).toEqual({
      hint: "Gate 'review' resolved with choice 'send'. Owed to the engine: 'approve', 'notify' — call advance_run; it runs them until a step opens a question, fails or ends the run.",
      status: 'confirm_required',
      question: 'approve',
      notifyRan: false,
    });
  });

  it('call-a-service.md: a missing adapter — start_run replies ok and warns; execute_step names the service', async () => {
    claim(
      'docs/guides/call-a-service.md',
      "Over MCP, `start_run` replies `ok` and names the step in `warnings` (`Step '<step>' is blocked: …`), and `execute_step` on the step is refused with:",
    );
    const shown = block('docs/guides/call-a-service.md', "Adapter 'github' for service")[0]!;
    const { call, workflowStore } = await connect(createDefaultRegistry());
    await workflowStore.register(
      wf(
        [
          'id: issues',
          'name: issues',
          'version: 1',
          'services:',
          '  github:',
          '    adapter: github',
          '    trust: engine_delivered',
          'steps:',
          '  open:',
          '    description: Open an issue.',
          '    execution: auto',
          '    uses_service: github',
          '    operation: create_issue',
          '',
        ].join('\n'),
      ),
    );
    const s = await call('start_run', { workflow_id: 'issues' });
    const r = await call('execute_step', {
      run_id: s['run_id'] as string,
      command: 'open',
      params: {},
    });
    // (a) red when start_run refuses, does not warn, or the refusal names another service;
    //     (b) prints the replies.
    expect([
      s['status'],
      ((s['warnings'] as string[]) ?? []).some((w) => w.startsWith("Step 'open' is blocked: ")),
      String((r['errors'] as string[])[0]).startsWith(shown.replace(' …', '')),
    ]).toEqual(['ok', true, true]);
  });

  it('step-handlers.md: start_run runs the handler step and its reply says so; the next step’s prompt shows the result', async () => {
    claim(
      'docs/guides/step-handlers.md',
      "Start a run with a quantity of 4 from an assistant connected over MCP. The engine runs `total` in the first call, `start_run`, whose reply says so, and the next step's prompt shows the result:",
    );
    const shown = block('docs/guides/step-handlers.md', "Step 'total' completed.");
    const registry = createDefaultRegistry();
    registry.register('handler', 'order_total', {
      async execute(
        inputs: { params: Record<string, unknown> },
        ctx: { config: Record<string, unknown> },
      ) {
        return {
          data: { total: Number(inputs.params['quantity']) * Number(ctx.config['unit_price']) },
        };
      },
    } as never);
    const { call, workflowStore } = await connect(registry);
    await workflowStore.register(
      wf(
        [
          'id: price',
          'name: price',
          'version: 1',
          'steps:',
          '  total:',
          '    description: Work out the order total.',
          '    execution: auto',
          '    handler: order_total',
          '    config:',
          '      unit_price: 12.5',
          '    input_map:',
          '      quantity: run.params.quantity',
          '  confirm:',
          '    description: Say whether the total looks right.',
          '    execution: agent',
          '    depends_on: [total]',
          "    prompt: 'The total is {{ context.resources.total.total }}. Does that look right?'",
          '',
        ].join('\n'),
      ),
    );
    const s = await call('start_run', { workflow_id: 'price', params: { quantity: 4 } });
    // (a) red when the reply does not say the step ran and what is ready, or the prompt differs;
    //     (b) prints the reply.
    expect(s['context_hint']).toBe(shown[0]);
    expect(JSON.stringify(s['next_actions'])).toContain(shown[2]!);
  });

  it('idempotency-and-batches.md: rerun after a completed run — the new run names the run it supersedes and what comes next', async () => {
    const shown = block('docs/guides/idempotency-and-batches.md', 'rerun_of:');
    const { call, workflowStore } = await connect();
    await workflowStore.register(
      wf(
        [
          'id: sync',
          'name: sync',
          'version: 1',
          'steps:',
          '  fetch:',
          '    description: Fetch.',
          '    execution: agent',
          '',
        ].join('\n'),
      ),
    );
    const first = await call('start_run', {
      workflow_id: 'sync',
      params: {},
      idempotency_key: 'order-4417',
    });
    const old = first['run_id'] as string;
    await call('execute_step', { run_id: old, command: 'fetch', params: {} });
    const r = await call('start_run', {
      workflow_id: 'sync',
      params: {},
      idempotency_key: 'order-4417',
      on_terminal_match: 'rerun',
    });
    const id = (x: string) => `${x.slice(0, 8)}-…`;
    // (a) red when the hint is not the page's (ids aside); (b) prints both.
    expect([r['status'], r['deduped'], r['rerun_of'], r['context_hint']]).toEqual([
      'ok',
      false,
      old,
      shown[4]!
        .replace("'3fa445f0-…'", `'${id(r['run_id'] as string)}'`)
        .replace("'6c48086c-…'", `'${id(old)}'`)
        .replace(id(r['run_id'] as string), r['run_id'] as string)
        .replace(id(old), old),
    ]);
  });

  it('step-fields.md, run-state-and-health.md: a guard ready at creation — start_run decides it; a batch run names advance_run and carries the finding until advance_run decides it', async () => {
    claim(
      'docs/reference/workflow/step-fields.md',
      "A guard that is already ready when a run is created is decided by `start_run`, in the call that creates the run. One that is ready some other way — a run created by `start_run_batch` or by a program, or opened again by `realm run resume` at a failed guard — is decided by the run's next such write or by `advance_run` (`realm run advance`), which the run's `next_actions` then names. Until then the run carries the finding [`guard_awaiting_settlement`](../mcp/run-state-and-health.md#the-14-findings).",
    );
    claim(
      'docs/reference/mcp/run-state-and-health.md',
      "Such a guard is decided by the run's next finished step or gate answer, or by `advance_run`, which `next_actions` names. A call to the guard or to the step after it is refused as not eligible. A run that `start_run` creates never has this finding: `start_run` decides such a guard itself.",
    );
    const { call, workflowStore } = await connect();
    await workflowStore.register(
      wf(
        [
          'id: gfirst',
          'name: gfirst',
          'version: 1',
          'steps:',
          '  check:',
          '    description: Check.',
          '    execution: guard',
          '    abort_unless: ["run.params.go == true"]',
          '  work:',
          '    description: Work.',
          '    execution: agent',
          '    depends_on: [check]',
          '',
        ].join('\n'),
      ),
    );
    const s = await call('start_run', { workflow_id: 'gfirst', params: { go: true } });
    // The guard reads nothing it can resolve here, so deciding it fails it: decided all the same.
    const decided = (s['chained_auto_steps'] as Array<{ step: string }>).map((g) => g.step);
    const batch = await call('start_run_batch', {
      workflow_id: 'gfirst',
      items: [{ params: { go: true } }],
    });
    const entry = (batch['started'] as Array<{ run_id: string; next_actions: unknown[] }>)[0]!;
    const before = await call('get_run_state', { run_id: entry.run_id });
    const findings = JSON.stringify(before['findings'] ?? before);
    await call('advance_run', { run_id: entry.run_id });
    const after = await call('get_run_state', { run_id: entry.run_id });
    // (a) red when start_run leaves the guard undecided, a batch run does not name advance_run or
    //     carry the finding, or advance_run does not decide the guard; (b) prints what each said.
    expect({
      startDecided: decided,
      batchNext: tools({ next_actions: entry.next_actions }),
      finding: findings.includes('guard_awaiting_settlement'),
      afterAdvance: [
        ...(after['completed_steps'] as string[]),
        ...(after['failed_steps'] as string[]),
      ],
    }).toEqual({
      startDecided: ['check'],
      batchNext: ['advance_run'],
      finding: true,
      afterAdvance: ['check'],
    });
  });

  it('json-schema-blocks.md: an auto step’s input_schema is checked against the input the engine gives it, before its claim — not what input_map builds', async () => {
    claim(
      'docs/reference/workflow/json-schema-blocks.md',
      "| `input_schema` | An auto step | The input the engine gives the step: the run's params when the step has no `depends_on`, `{}` otherwise. Not what `input_map` builds. | Before the step is claimed. | The step is not run: `'<step>' cannot run (input_schema): …`, with the way out. |",
    );
    const { call, workflowStore, runStore } = await connect();
    await workflowStore.register(
      wf(
        [
          'id: ischema',
          'name: ischema',
          'version: 1',
          'steps:',
          '  order:',
          '    description: Order.',
          '    execution: agent',
          '  show:',
          '    description: Show.',
          '    execution: auto',
          '    depends_on: [order]',
          '    input_map:',
          '      sku: run.params.sku',
          '    input_schema:',
          '      type: object',
          '      required: [sku]',
          '',
        ].join('\n'),
      ),
    );
    const runId = (await call('start_run', { workflow_id: 'ischema', params: { sku: 'A-100' } }))[
      'run_id'
    ] as string;
    const r = await call('execute_step', { run_id: runId, command: 'order', params: {} });
    // (a) red when the step runs with the input_map's input, or is refused another way; (b) prints the hint.
    expect(String(r['context_hint'])).toContain(
      "'show' cannot run (input_schema): Invalid input for step 'show': the input must have required property 'sku'.",
    );
    expect((await runStore.get(runId)).completed_steps).toEqual(['order']);
  });

  it('top-level-fields.md: the five standard rules, the fifth about advance_run', async () => {
    const shown = block(
      'docs/reference/workflow/top-level-fields.md',
      'Follow the next_action instruction',
    );
    claim(
      'docs/reference/workflow/top-level-fields.md',
      'The fifth rule was added after version 0.46.0. Setting `rules` removes all five, including the two about human gates.',
    );
    const { call, workflowStore } = await connect();
    await workflowStore.register(
      wf(
        [
          'id: plain',
          'name: plain',
          'version: 1',
          'steps:',
          '  a:',
          '    description: A.',
          '    execution: agent',
          '',
        ].join('\n'),
      ),
    );
    const p = await call('get_workflow_protocol', { workflow_id: 'plain' });
    const rules = p['rules'] as string[];
    // (a) red when the standard rules are not the page's five, in order; (b) prints both.
    expect(rules.slice(0, 5)).toEqual(shown.filter((l) => l !== ''));
  });

  it('tools.md: start_run_batch’s hint names an agent step refused before its claim', async () => {
    claim(
      'docs/reference/mcp/tools.md',
      'each step that cannot run (an `auto` step, or an agent step refused before its claim)',
    );
    const { call, workflowStore } = await connect();
    await workflowStore.register(
      wf(
        [
          'id: pre',
          'name: pre',
          'version: 1',
          'steps:',
          '  ask:',
          '    description: Ask.',
          '    execution: agent',
          '    preconditions: ["run.params.ok == true"]',
          '',
        ].join('\n'),
      ),
    );
    const b = await call('start_run_batch', {
      workflow_id: 'pre',
      items: [{ params: { ok: false } }],
    });
    const hint = (b['started'] as Array<{ context_hint: string }>)[0]!.context_hint;
    // (a) red when the refused agent step is left out of the hint; (b) prints it.
    expect(hint).toContain("'ask' cannot run (precondition)");
  });

  it('error-codes.md: get_run_state on a run that does not exist carries STATE_RUN_NOT_FOUND; a record it cannot read is ENGINE_STORE_FAILED', async () => {
    claim(
      'docs/reference/error-codes.md',
      "`get_run_state`'s reply for a run that does not exist carries `STATE_RUN_NOT_FOUND` too. Up to version 0.46.0 it had the message and no `error_code`.",
    );
    claim(
      'docs/reference/error-codes.md',
      "The store failed while a step was being run, or a run's record could not be read (`execute_step`, `submit_human_response`, `advance_run`, `get_run_state`, and the library calls).",
    );
    const { call } = await connect();
    const r = await call('get_run_state', { run_id: 'no-such-run-625' });
    // (a) red when the code is missing; (b) prints the reply.
    expect(r['error_code']).toBe('STATE_RUN_NOT_FOUND');
  });

  it('what-is-realm.md: a step behind an open gate is refused with the question it waits on', async () => {
    const shown = block('docs/start/what-is-realm.md', 'it waits on the question on step')[0]!;
    const { call, workflowStore } = await connect();
    await workflowStore.register(
      wf(
        [
          'id: review',
          'name: review',
          'version: 1',
          'steps:',
          '  write_review:',
          '    description: Write.',
          '    execution: agent',
          '  confirm_review:',
          '    description: Confirm.',
          '    execution: auto',
          '    depends_on: [write_review]',
          '    trust: human_confirmed',
          '    gate:',
          '      choices: [approve, request_changes]',
          '  post_approval:',
          '    description: Post.',
          '    execution: agent',
          '    depends_on: [confirm_review]',
          '',
        ].join('\n'),
      ),
    );
    const runId = (await call('start_run', { workflow_id: 'review' }))['run_id'] as string;
    await call('execute_step', { run_id: runId, command: 'write_review', params: {} });
    const r = await call('execute_step', { run_id: runId, command: 'post_approval', params: {} });
    // (a) red when the refusal is not the page's; (b) prints it.
    expect([r['status'], r['context_hint']]).toEqual(['blocked', shown]);
  });

  it('packages/mcp-server/README.md: the server exposes 11 tools, advance_run among them', async () => {
    claim('packages/mcp-server/README.md', 'Exposes 11 workflow tools over stdio or HTTP');
    claim(
      'packages/mcp-server/README.md',
      "- `advance_run` — run what a run owes the engine: an expired question's declared `on_expiry`, then its guards and `auto` steps",
    );
    const { client } = await connect();
    const listed = (await client.listTools()).tools.map((t) => t.name);
    const readme = readFileSync(join(ROOT, 'packages/mcp-server/README.md'), 'utf8');
    const inReadme = [...readme.matchAll(/^- `([a-z_]+)` — /gm)].map((m) => m[1]);
    // (a) red when the count or the README's list differs from the server's; (b) prints both.
    expect([listed.length, [...inReadme].sort()]).toEqual([11, [...listed].sort()]);
  });
  it.each([
    ['hold', 'ends the run'],
    ['ship', 'passes'],
  ] as const)(
    'tools.md, C186 (walk c8, W4-c): advance_run carries out an expired question whose default (%s) makes a guard that %s — the hint names the guard that ran; no guards/ended_by; the guard in warnings',
    async (dflt, _outcome) => {
      claim(
        'docs/reference/mcp/tools.md',
        "(when the call carried out an expired question and a guard then ended the run, neither is there: the guard's sentence is in the expiry's `warnings` line, and the hint reads `Run '<id>': its expired question was carried out as declared, and that decided guard '<guard>' (see warnings); no other step ran. The run ended (<phase>).`; when that guard passed, the hint ends with what comes next instead, and with no guard it reads `Run '<id>': its expired question was carried out as declared (see warnings); no step ran.`, then what comes next)",
      );
      const { call, workflowStore } = await connect();
      const id = `held-${dflt}`;
      await workflowStore.register(
        wf(
          [
            `id: ${id}`,
            `name: ${id}`,
            'version: 1',
            'steps:',
            '  approve:',
            '    description: Approve.',
            '    execution: auto',
            '    trust: human_confirmed',
            '    gate:',
            '      choices: [ship, hold]',
            '      timeout_seconds: 1',
            '      on_expiry: settle_default',
            `      default_choice: ${dflt}`,
            '  only_if_shipping:',
            '    description: Ship only when approved.',
            '    execution: guard',
            '    depends_on: [approve]',
            '    abort_unless: ["approve.choice == \'ship\'"]',
            '    abort_message: The order was held.',
            '  ship:',
            '    description: Ship.',
            '    execution: agent',
            '    depends_on: [only_if_shipping]',
            '',
          ].join('\n'),
        ),
      );
      const runId = (await call('start_run', { workflow_id: id }))['run_id'] as string;
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      const r = await call('advance_run', { run_id: runId });
      const ends = dflt === 'hold';
      // (a) red when the hint says "no step ran" beside the guard that ran, the reply carries
      //     guards/ended_by, or the guard leaves warnings; (b) prints the reply.
      expect({
        guards: 'guards' in r,
        ended_by: 'ended_by' in r,
        guardInWarnings: ((r['warnings'] as string[]) ?? []).some((w) =>
          w.includes(
            ends
              ? "Guard step 'only_if_shipping' aborted the run"
              : "Guard step 'only_if_shipping' passed.",
          ),
        ),
        hint: r['context_hint'],
        phase: r['run_phase'],
      }).toEqual({
        guards: false,
        ended_by: false,
        guardInWarnings: true,
        hint: ends
          ? `Run '${runId}': its expired question was carried out as declared, and that decided guard 'only_if_shipping' (see warnings); no other step ran. The run ended (aborted).`
          : `Run '${runId}': its expired question was carried out as declared, and that decided guard 'only_if_shipping' (see warnings); no other step ran. Ready for the agent: 'ship'.`,
        phase: ends ? 'aborted' : 'running',
      });
    },
  );
  it.each([
    ['passes', true],
    ['ends the run', false],
  ] as const)(
    'tools.md: a guard advance_run decides that %s — in chained_auto_steps; in guards only when it ended the run',
    async (_case, go) => {
      claim(
        'docs/reference/mcp/tools.md',
        "| `guards` | When the call's write decided guard steps; from `advance_run`, only a guard that ended the run |",
      );
      claim(
        'docs/reference/mcp/tools.md',
        '`chained_auto_steps` lists what ran, guards included, `guards` and `ended_by` what a guard that ended the run settled',
      );
      const { call, workflowStore } = await connect();
      await workflowStore.register(
        wf(
          [
            'id: gmid',
            'name: gmid',
            'version: 1',
            'steps:',
            '  x:',
            '    description: X.',
            '    execution: auto',
            '  g:',
            '    description: G.',
            '    execution: guard',
            '    depends_on: [x]',
            '    abort_unless: ["x.go == true"]',
            '  y:',
            '    description: Y.',
            '    execution: auto',
            '    depends_on: [g]',
            '',
          ].join('\n'),
        ),
      );
      const b = await call('start_run_batch', { workflow_id: 'gmid', items: [{ params: { go } }] });
      const runId = (b['started'] as Array<{ run_id: string }>)[0]!.run_id;
      const r = await call('advance_run', { run_id: runId });
      const chained = (r['chained_auto_steps'] as Array<{ step: string }>).map((c) => c.step);
      // (a) red when a passing guard is missing from chained_auto_steps or appears in guards, or a
      //     guard that ended the run is not in guards; (b) prints the reply's fields.
      expect({
        chained: chained.includes('g'),
        guards: (r['guards'] as Array<{ step: string; outcome: string }> | undefined) ?? null,
        ended: 'ended_by' in r,
      }).toEqual(
        go
          ? { chained: true, guards: null, ended: false }
          : { chained: true, guards: [{ step: 'g', outcome: 'abort' }], ended: true },
      );
    },
  );
});
