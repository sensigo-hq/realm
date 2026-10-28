// docs-pages-625-guides.test.ts — issue #625 PR-2a, decision C174 (round 22), pin lane E2: the
// guides, the other reference pages and the core and MCP READMEs. Each sentence on those pages that
// says what an MCP tool or a library function does, and that #625 PR-2a added or changed, is quoted
// here (read from the repository, whitespace folded) and the case it states is driven over a real
// MCP client (`createRealmMcpServer`, in-memory transport) or on the library, so neither the page
// nor the behaviour can change alone. An example reply is compared line by line with its IDs put in
// place.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  JsonFileStore,
  JsonWorkflowStore,
  ExtensionRegistry,
  advanceRun,
  createDefaultRegistry,
  executeChain,
  executeEngineStep,
  executeStep,
  loadWorkflowFromString,
  submitHumanResponse,
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
  return found
    .replace(/\n```[\s\S]*$/, '')
    .split('\n')
    .filter((l) => l !== '');
}

type Reply = Record<string, unknown>;

async function connect(registry?: ExtensionRegistry) {
  const dir = await mkdtemp(join(tmpdir(), 'realm-pages-625-e2-'));
  const runStore = new JsonFileStore(join(dir, 'runs'));
  const workflowStore = new JsonWorkflowStore(join(dir, 'wf'));
  const server = createRealmMcpServer({
    runStore,
    workflowStore,
    ...(registry !== undefined ? { registry } : {}),
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'docs-pages-625-e2', version: '0' });
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
const nextCall = (r: Reply): string => {
  const n = (r['next_actions'] as Array<{ instruction: { tool: string; params: Reply } }>)[0]!;
  return `${n.instruction.tool} ${String(n.instruction.params['command'])}`;
};

const wf = (lines: string[]): WorkflowDefinition =>
  loadWorkflowFromString([...lines, ''].join('\n'));

describe('#625 PR-2a, C174 lane E2 — guides, reference pages and READMEs: MCP replies and the library', () => {
  it('agent-created-workflows.md: create_workflow’s reply and the refusal of a step called too early, line by line', async () => {
    const page = 'docs/guides/agent-created-workflows.md';
    const plan = JSON.parse(block(page, '"task_description"').join('\n')) as Reply;
    const { call } = await connect();
    const c = await call('create_workflow', plan);
    const runId = c['run_id'] as string;
    // (a) red when the reply's lines are not the page's (the run ID aside) — its status, the
    //     workflow ID made from the plan, the sentence that names the ready step, or the next
    //     call; (b) prints both.
    expect([
      `status: ${String(c['status'])}`,
      `workflow_id: ${String((c['data'] as Reply)['workflow_id'])}`,
      `run_id: ${runId}`,
      String(c['context_hint']),
      `next: ${nextCall(c)}`,
    ]).toEqual(
      block(page, 'status: ok').map((l) =>
        l.replaceAll('4fe4f2e3-14b4-4f9c-9e8c-b96052cb8ed9', runId),
      ),
    );
    const g = await call('execute_step', { run_id: runId, command: 'group', params: {} });
    // (a) red when the refusal is not the page's: its status, its reason, or the step it says is
    //     ready; (b) prints both.
    expect([
      `status: ${String(g['status'])}`,
      String(g['context_hint']),
      `eligible_steps: ${((g['blocked_reason'] as Reply)['eligible_steps'] as string[]).join(', ')}`,
    ]).toEqual(block(page, 'status: blocked'));
  });

  // pre-Q3 title: call-a-service.md: without realm.yaml the step that uses the adapter is blocked and the run waits; execute_step is refused with the page’s line
  it('call-a-service.md: without realm.yaml the step that uses the adapter is blocked and the run waits; after the first attempt advance_run says it cannot run here, and execute_step naming the step is refused before any attempt', async () => {
    const page = 'docs/guides/call-a-service.md';
    claim(
      page,
      'If `realm.yaml` is missing, a step that uses the adapter is blocked, and the run waits.',
    );
    claim(
      page,
      "After that attempt, `advance_run` says the step cannot run here (capability) without attempting it again. `execute_step` naming the step is refused before any attempt: it is the engine's step.",
    );
    // No realm.yaml: the server has only the built-in adapters, as `realm mcp` in a folder without one.
    const { call, workflowStore, runStore } = await connect(createDefaultRegistry());
    await workflowStore.register(
      wf([
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
      ]),
    );
    // start_run's chain is the first attempt (it records the step's capability block).
    const s = await call('start_run', { workflow_id: 'issues' });
    const runId = s['run_id'] as string;
    const attempted = await runStore.get(runId);
    const a = await call('advance_run', { run_id: runId });
    const e = await call('execute_step', { run_id: runId, command: 'open', params: {} });
    const after = await runStore.get(runId);
    const state = await call('get_run_state', { run_id: runId });
    const CAPABILITY =
      "'open' cannot run here (capability): adapter 'github' is not registered here — load the missing extension, or run the step on a runner that has it.";
    // (a) red when the run fails or ends; when advance_run attempts the step again or names no
    //     capability; or when execute_step naming the step is attempted (a claim or a new write)
    //     instead of refused as the engine's step; (b) prints what each said and the record's facts.
    expect({
      waits: [state['run_phase'], state['terminal_state'], state['failed_steps']],
      advance: [a['status'], a['context_hint']],
      execute: [
        e['status'],
        String(e['context_hint']).startsWith(
          "Step 'open' cannot be called now: it is an automatic step: the engine runs it when it is owed.",
        ),
        String(e['context_hint']).endsWith(CAPABILITY),
      ],
      written: [after.version === attempted.version, Object.keys(after.claims ?? {})],
    }).toEqual({
      waits: ['running', false, []],
      advance: ['ok', `Run '${runId}': nothing ran. ${CAPABILITY}`],
      execute: ['blocked', true, true],
      written: [true, []],
    });
  });

  it('connect-an-mcp-client.md, glossary.md, packages/mcp-server/README.md: the server has 11 tools, advance_run among them, each in the guide’s table', async () => {
    claim(
      'docs/guides/connect-an-mcp-client.md',
      // Correction 2 (6.5): by value.
      "The assistant now has ten tools under `withheld` (the value step 1's example sets); eleven under `asked` or `offered` (`advance_run` was added after version 0.46.0, which has ten). The table lists the eleven:",
    );
    claim(
      'docs/reference/glossary.md',
      'Realm is an MCP server with 11 tools, 10 under `withheld` (10 in version 0.46.0).',
    );
    claim(
      'packages/mcp-server/README.md',
      // Correction 2 (4.4): listed per value, and what is REGISTERED under asked.
      "Creates the MCP server with its tools registered. A client is listed 11, or 10 under `withheld`; under `asked` both answer tools are registered, and the session's forms enable one.",
    );
    const { client } = await connect();
    const listed = (await client.listTools()).tools.map((t) => t.name);
    const guide = readFileSync(join(ROOT, 'docs/guides/connect-an-mcp-client.md'), 'utf8');
    const rows = [...guide.matchAll(/^\| `([a-z_]+)` +\|/gm)].map((m) => m[1]!);
    // (a) red when a tool is added or removed without the pages, or the guide's table differs
    //     from the server's list; (b) prints both.
    expect([listed.length, listed.includes('advance_run'), [...rows].sort()]).toEqual([
      11,
      true,
      [...listed].sort(),
    ]);
    // Correction 2 (4.4): the REGISTERED set per value — the SDK's own table of the server's tools.
    const registered = (gateAnswers: 'asked' | 'offered' | 'withheld') =>
      Object.keys(
        (createRealmMcpServer({ gateAnswers }) as unknown as { _registeredTools: object })
          ._registeredTools,
      );
    const answerTools = (names: string[]) =>
      names.filter((n) => n === 'submit_human_response' || n === 'present_question').sort();
    // (a) red when a value registers another set than the README says (both answer tools under
    //     asked, one under offered, none under withheld); (b) prints each count and answer tools.
    expect({
      asked: [registered('asked').length, answerTools(registered('asked'))],
      offered: [registered('offered').length, answerTools(registered('offered'))],
      withheld: [registered('withheld').length, answerTools(registered('withheld'))],
    }).toEqual({
      asked: [12, ['present_question', 'submit_human_response']],
      offered: [11, ['submit_human_response']],
      withheld: [10, []],
    });
  });

  it('connect-an-mcp-client.md: execute_step submits the answer to an agent step; an automatic step is the engine’s — advance_run runs it (#729, the Q3 unit)', async () => {
    claim(
      'docs/guides/connect-an-mcp-client.md',
      "| `execute_step` | Submits the answer to an agent step. An automatic step is the engine's: `advance_run` runs it. |",
    );
    const { call, workflowStore, runStore } = await connect();
    await workflowStore.register(
      wf([
        'id: guide-q3',
        'name: guide-q3',
        'version: 1',
        'steps:',
        '  ask:',
        '    description: Ask.',
        '    execution: agent',
        '  tally:',
        '    description: Tally.',
        '    execution: auto',
      ]),
    );
    const batch = await call('start_run_batch', {
      workflow_id: 'guide-q3',
      items: [{ params: {} }],
    });
    const runId = (batch['started'] as Array<{ run_id: string }>)[0]!.run_id;
    const answer = await call('execute_step', { run_id: runId, command: 'ask', params: {} });
    const batch2 = await call('start_run_batch', {
      workflow_id: 'guide-q3',
      items: [{ params: {} }],
    });
    const second = (batch2['started'] as Array<{ run_id: string }>)[0]!.run_id;
    const named = await call('execute_step', { run_id: second, command: 'tally', params: {} });
    const notRun = (await runStore.get(second)).completed_steps.includes('tally');
    await call('advance_run', { run_id: second });
    // (a) red when the agent's answer is not recorded, execute_step runs the automatic step, or
    //     advance_run does not; (b) prints the statuses, the calls offered and what ran.
    expect({
      answer: answer['status'],
      named: [named['status'], tools(named), notRun],
      advanced: (await runStore.get(second)).completed_steps.includes('tally'),
    }).toEqual({
      answer: 'ok',
      named: ['blocked', ['execute_step', 'advance_run'], false],
      advanced: true,
    });
  });

  it('connect-an-mcp-client.md: advance_run runs the guards and automatic steps a run owes, when next_actions names it', async () => {
    claim(
      'docs/guides/connect-an-mcp-client.md',
      '| `advance_run` | Runs the guards and automatic steps a run owes (when named). |',
    );
    const { call, workflowStore } = await connect();
    await workflowStore.register(
      wf([
        'id: owes',
        'name: owes',
        'version: 1',
        'steps:',
        '  read:',
        '    description: Read the order.',
        '    execution: auto',
        '  check:',
        '    description: Go on only for a live order.',
        '    execution: guard',
        '    depends_on: [read]',
        '    abort_unless: ["read.live == true"]',
        '  ship:',
        '    description: Ship.',
        '    execution: auto',
        '    depends_on: [check]',
      ]),
    );
    // A batch run runs no step: it owes the engine `read`, the guard `check` and `ship`.
    const batch = await call('start_run_batch', {
      workflow_id: 'owes',
      items: [{ params: { live: true } }],
    });
    const entry = (batch['started'] as Array<{ run_id: string; next_actions: unknown[] }>)[0]!;
    const r = await call('advance_run', { run_id: entry.run_id });
    const state = await call('get_run_state', { run_id: entry.run_id });
    // (a) red when advance_run is not named, or leaves the guard or an automatic step unrun;
    //     (b) prints what each said.
    expect({
      named: tools({ next_actions: entry.next_actions }),
      ran: (r['chained_auto_steps'] as Array<{ step: string }>).map((c) => c.step),
      phase: r['run_phase'],
      completed: state['completed_steps'],
    }).toEqual({
      named: ['advance_run'],
      ran: ['read', 'check', 'ship'],
      phase: 'completed',
      completed: ['read', 'check', 'ship'],
    });
  });

  it('connect-an-mcp-client.md: after a gate is answered, the auto steps that follow do not start by themselves', async () => {
    claim(
      'docs/guides/connect-an-mcp-client.md',
      'The `auto` steps that follow do not start by themselves.',
    );
    const { call, workflowStore, runStore } = await connect();
    await workflowStore.register(
      wf([
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
      ]),
    );
    const runId = (await call('start_run', { workflow_id: 'ann' }))['run_id'] as string;
    const gateId = (await runStore.get(runId)).pending_gate!.gate_id;
    const r = await call('submit_human_response', {
      run_id: runId,
      gate_id: gateId,
      choice: 'send',
    });
    const after = await runStore.get(runId);
    // (a) red when the answer's call runs `send` itself; (b) prints the reply and the steps.
    expect([r['run_phase'], after.completed_steps, after.in_progress_steps]).toEqual([
      'running',
      ['review'],
      [],
    ]);
  });

  it('connect-an-mcp-client.md: if the run does not finish, the assistant calls what next_actions names — execute_step for an agent step, advance_run for the engine’s (#729 Q3 correction 1, C5)', async () => {
    claim(
      'docs/guides/connect-an-mcp-client.md',
      "If the run does not finish, tell the assistant to call what `next_actions` names: `execute_step` for an agent step, `advance_run` for the engine's.",
    );
    const { call, workflowStore, runStore } = await connect();
    await workflowStore.register(
      wf([
        'id: c5-next',
        'name: c5-next',
        'version: 1',
        'steps:',
        '  first:',
        '    description: First.',
        '    execution: agent',
        '  review:',
        '    description: Review.',
        '    execution: auto',
        '    depends_on: [first]',
        '    trust: human_confirmed',
        '    gate:',
        '      choices: [send, discard]',
        '  send:',
        '    description: Send.',
        '    execution: auto',
        '    depends_on: [review]',
      ]),
    );
    const started = await call('start_run', { workflow_id: 'c5-next' });
    const runId = started['run_id'] as string;
    await call('execute_step', { run_id: runId, command: 'first', params: { done: true } });
    const gateId = (await runStore.get(runId)).pending_gate!.gate_id;
    const answered = await call('submit_human_response', {
      run_id: runId,
      gate_id: gateId,
      choice: 'send',
    });
    const before = await runStore.get(runId);
    const byName = await call('execute_step', { run_id: runId, command: 'send', params: {} });
    const untouched = (await runStore.get(runId)).version === before.version;
    const advanced = await call('advance_run', { run_id: runId });
    // (a) red when the agent step is not offered as execute_step, the owed engine step is not
    //     offered as advance_run, execute_step naming it runs it, or advance_run does not run it;
    //     (b) prints the tools offered, the by-name reply's status and the phases.
    expect({
      agentStep: nextCall(started),
      engineStep: tools(answered),
      byName: [byName['status'], tools(byName), untouched],
      advanced: [advanced['run_phase'], (await runStore.get(runId)).completed_steps],
    }).toEqual({
      agentStep: 'execute_step first',
      engineStep: ['advance_run'],
      byName: ['blocked', ['advance_run'], true],
      advanced: ['completed', ['first', 'review', 'send']],
    });
  });

  it('human-gates.md: a step behind the open gate is refused with the question it waits on, and next_actions holds the answer', async () => {
    const page = 'docs/guides/human-gates.md';
    claim(page, 'Its `next_actions` holds that answer, `submit_human_response`.');
    const text = readFileSync(join(ROOT, page), 'utf8');
    const yaml = text.slice(
      text.indexOf('```yaml\n') + 8,
      text.indexOf('\n```', text.indexOf('```yaml\n')),
    );
    const { call, workflowStore } = await connect();
    await workflowStore.register(loadWorkflowFromString(yaml));
    const runId = (await call('start_run', { workflow_id: 'announce' }))['run_id'] as string;
    const opened = await call('execute_step', {
      run_id: runId,
      command: 'draft',
      params: { subject: 'Office closed Friday', body: 'The office is closed this Friday.' },
    });
    expect(opened['status'], 'fixture: the draft opens the gate').toBe('confirm_required');
    const r = await call('execute_step', { run_id: runId, command: 'send', params: {} });
    // (a) red when the refusal is not the page's two lines, or next_actions holds anything but
    //     the answer; (b) prints both.
    expect([`status: ${String(r['status'])}`, String(r['context_hint'])]).toEqual(
      block(page, "Step 'send' cannot be called now:"),
    );
    expect(tools(r)).toEqual(['submit_human_response']);
  });

  it('#729 PR-0 correction (C2): human-gates.md — at the gate the driver is told the pause only; the choices are the gate’s', async () => {
    const page = 'docs/guides/human-gates.md';
    claim(
      page,
      "The choices are the gate's (`send`, `discard`); the line named them up to version 0.47.0.",
    );
    const text = readFileSync(join(ROOT, page), 'utf8');
    const yaml = text.slice(
      text.indexOf('```yaml\n') + 8,
      text.indexOf('\n```', text.indexOf('```yaml\n')),
    );
    const { call, workflowStore } = await connect();
    await workflowStore.register(loadWorkflowFromString(yaml));
    const runId = (await call('start_run', { workflow_id: 'announce' }))['run_id'] as string;
    const r = await call('execute_step', {
      run_id: runId,
      command: 'draft',
      params: { subject: 'Office closed Friday', body: 'The office is closed this Friday.' },
    });
    const gate = r['gate'] as { gate_id: string; choices: string[] };
    // (a) red when what the driver is told is not the page's three lines (the hint naming the
    //     choices again, as up to 0.47.0), or the gate's choices are not the page's; (b) prints both,
    //     the gate's id put as the page's.
    expect({
      told: [
        `status: ${String(r['status'])}`,
        `run_phase: ${String(r['run_phase'])}`,
        String(r['context_hint']).split(gate.gate_id).join('39792a3a-f9c3-470a-b94c-c314fb254234'),
      ],
      choices: gate.choices,
    }).toEqual({
      told: block(page, 'run_phase: gate_waiting'),
      choices: ['send', 'discard'],
    });
  });

  it('idempotency-and-batches.md: a repeat with the same key returns the run and says what comes next, as the first reply did', async () => {
    const page = 'docs/guides/idempotency-and-batches.md';
    claim(
      page,
      "The caller can carry on with that run as if it had started it: the reply also says what comes next for it, as the first one did (here, `sync`'s first step, `fetch`, is ready for the assistant).",
    );
    const { call, workflowStore } = await connect();
    await workflowStore.register(
      wf([
        'id: sync',
        'name: sync',
        'version: 1',
        'steps:',
        '  fetch:',
        '    description: Fetch.',
        '    execution: agent',
      ]),
    );
    const args = { workflow_id: 'sync', params: {}, idempotency_key: 'order-4417' };
    const first = await call('start_run', args);
    const again = await call('start_run', args);
    const runId = first['run_id'] as string;
    // (a) red when the repeat's lines are not the page's (the run ID aside); (b) prints both.
    expect([
      `status: ${String(again['status'])}`,
      `deduped: ${String(again['deduped'])}`,
      `run_id: ${String(again['run_id'])}`,
      String(again['context_hint']),
    ]).toEqual(
      block(page, 'deduped: true').map((l) =>
        l.replaceAll('6c48086c-cb0f-47ea-9c33-6279fe42ffdc', runId),
      ),
    );
    // (a) red when the repeat's next call is not the first reply's (`fetch`); (b) prints both.
    expect([nextCall(again), again['next_actions']]).toEqual([
      'execute_step fetch',
      first['next_actions'],
    ]);
  });

  it('step-handlers.md: a handler that is not registered — the block is in start_run’s warnings and in the hint of advance_run and execute_step when they attempt the step', async () => {
    const page = 'docs/guides/step-handlers.md';
    claim(
      page,
      "- **`Step 'total' is blocked: its handler 'order_totl' is not registered in this runner.`** (on the MCP reply of the call that attempted the step: its `context_hint` for `advance_run` and `execute_step`, its `warnings` for `start_run`; `realm agent` prints `⚠ Step 'total' is blocked: handler 'order_totl' is not registered in this runner. The run is NOT failed — add handler 'order_totl' and re-attach (…)`).",
    );
    claim(page, 'The `handler` name on the step does not match a key in your `handlers` map.');
    const sentence =
      "Step 'total' is blocked: its handler 'order_totl' is not registered in this runner.";
    // The `handlers` map has `order_total`; the step names `order_totl`.
    const registry = createDefaultRegistry();
    registry.register('handler', 'order_total', {
      async execute() {
        return { data: { total: 50 } };
      },
    } as never);
    const { call, workflowStore, runStore } = await connect(registry);
    await workflowStore.register(
      wf([
        'id: price',
        'name: price',
        'version: 1',
        'steps:',
        '  total:',
        '    description: Work out the order total.',
        '    execution: auto',
        '    handler: order_totl',
        '  confirm:',
        '    description: Say whether the total looks right.',
        '    execution: agent',
        '    depends_on: [total]',
      ]),
    );
    const s = await call('start_run', { workflow_id: 'price', params: { quantity: 4 } });
    // #729 (the Q3 unit, E2 (a)): `total` is the engine's step — execute_step attempts it when its
    // chain reaches it (after the agent step before it); naming it is refused (q3-729.test.ts).
    await workflowStore.register(
      wf([
        'id: price-after-ask',
        'name: price-after-ask',
        'version: 1',
        'steps:',
        '  ask:',
        '    description: Ask for the quantity.',
        '    execution: agent',
        '  total:',
        '    description: Work out the order total.',
        '    execution: auto',
        '    handler: order_totl',
        '    depends_on: [ask]',
      ]),
    );
    const asked = await call('start_run', { workflow_id: 'price-after-ask' });
    const e = await call('execute_step', {
      run_id: asked['run_id'] as string,
      command: 'ask',
      params: { quantity: 4 },
    });
    // advance_run attempts the step on a run nothing has attempted it on yet (a batch run).
    const batch = await call('start_run_batch', {
      workflow_id: 'price',
      items: [{ params: { quantity: 4 } }],
    });
    const batchId = (batch['started'] as Array<{ run_id: string }>)[0]!.run_id;
    const a = await call('advance_run', { run_id: batchId });
    const record = await runStore.get(s['run_id'] as string);
    // (a) red when start_run refuses or leaves the block out of warnings, a hint leaves it out,
    //     or the run is failed; (b) prints what each said.
    expect({
      start: [s['status'], ((s['warnings'] as string[]) ?? []).some((w) => w.startsWith(sentence))],
      execute: String(e['context_hint']).startsWith(sentence),
      advance: String(a['context_hint']).startsWith(sentence),
      phase: [record.run_phase, record.failed_steps],
    }).toEqual({
      start: ['ok', true],
      execute: true,
      advance: true,
      phase: ['running', []],
    });
  });

  it('step-fields.md: a guard is never called by name — execute_step on it is refused, ready or decided', async () => {
    claim('docs/reference/workflow/step-fields.md', 'A guard is never called by name.');
    const { call, workflowStore } = await connect();
    await workflowStore.register(
      wf([
        'id: gname',
        'name: gname',
        'version: 1',
        'steps:',
        '  read:',
        '    description: Read.',
        '    execution: auto',
        '  check:',
        '    description: Check.',
        '    execution: guard',
        '    depends_on: [read]',
        '    abort_unless: ["read.live == true"]',
        '  ship:',
        '    description: Ship.',
        '    execution: agent',
        '    depends_on: [check]',
      ]),
    );
    // Ready and not yet decided: a batch run, after `read` has run by name.
    const batch = await call('start_run_batch', {
      workflow_id: 'gname',
      items: [{ params: { live: true } }],
    });
    const id = (batch['started'] as Array<{ run_id: string }>)[0]!.run_id;
    const ready = await call('execute_step', { run_id: id, command: 'check', params: {} });
    // Decided: start_run runs `read`, and the write that makes the guard ready decides it.
    const s = await call('start_run', { workflow_id: 'gname', params: { live: true } });
    const decided = await call('execute_step', {
      run_id: s['run_id'] as string,
      command: 'check',
      params: {},
    });
    // (a) red when execute_step decides or runs the guard; (b) prints both replies.
    expect([
      [
        ready['status'],
        String(ready['context_hint']).startsWith("Step 'check' cannot be called now:"),
      ],
      [
        decided['status'],
        String(decided['context_hint']).startsWith("Step 'check' cannot be called now:"),
      ],
    ]).toEqual([
      ['blocked', true],
      ['blocked', true],
    ]);
  });

  it('top-level-fields.md: the opening instruction without protocol, and the six standard rules', async () => {
    const page = 'docs/reference/workflow/top-level-fields.md';
    claim(page, 'and the six standard rules are:');
    const opening = block(page, "Call start_run with workflow_id 'review-note'.")[0]!;
    const rules = block(page, 'Follow the instruction in each next_actions entry');
    const { call, workflowStore } = await connect();
    await workflowStore.register(
      wf([
        'id: review-note',
        'name: review-note',
        'version: 1',
        'steps:',
        '  a:',
        '    description: A.',
        '    execution: agent',
      ]),
    );
    const p = await call('get_workflow_protocol', { workflow_id: 'review-note' });
    // (a) red when the opening instruction or the six rules are not the page's; (b) prints both.
    expect([p['quick_start'], (p['rules'] as string[]).slice(0, 6)]).toEqual([opening, rules]);
    expect(rules).toHaveLength(6);
  });

  it("top-level-fields.md: rules replaces the six standard rules, after the author's label; Realm's own rules follow yours (#627 W)", async () => {
    const page = 'docs/reference/workflow/top-level-fields.md';
    claim(
      page,
      "| `rules` | list of strings | Replaces the six standard rules, after the line `Rules from the workflow's author:`. Realm's own rules are always added after yours: the rule for an `awaiting` entry, a line for the server's gate-answers value (none under `offered`), and two rules about concurrent attempts. |",
    );
    const standard = block(page, 'Follow the instruction in each next_actions entry');
    const { call, workflowStore } = await connect();
    await workflowStore.register(
      wf([
        'id: own-rules',
        'name: own-rules',
        'version: 1',
        'protocol:',
        '  rules:',
        '    - Never state a fact that is not in the note.',
        'steps:',
        '  a:',
        '    description: A.',
        '    execution: agent',
      ]),
    );
    const got = (await call('get_workflow_protocol', { workflow_id: 'own-rules' }))[
      'rules'
    ] as string[];
    // (a) red when a standard rule survives, the workflow's rule is not right after the author's
    //     label, or Realm's four rules (the default server, a client with no forms) are not after it,
    //     in order, the two about attempts last; (b) prints the rules.
    expect({
      label: got[0],
      first: got[1],
      count: got.length,
      standardLeft: got.filter((r) => standard.includes(r)),
      awaitRule: got[2]?.startsWith('When a next_actions entry has `awaiting`'),
      valueLine: got[3]?.startsWith('Answers to gates go through submit_human_response'),
      attempts: got.slice(4).every((r) => /attempt/.test(r)),
    }).toEqual({
      label: "Rules from the workflow's author:",
      first: 'Never state a fact that is not in the note.',
      count: 6,
      standardLeft: [],
      awaitRule: true,
      valueLine: true,
      attempts: true,
    });
  });

  it('run-record-and-export.md: output_source — on a bare auto step’s entry only, from the four sources', async () => {
    claim(
      'docs/reference/run-record-and-export.md',
      "| `output_source` | text | No | On a bare `auto` step's entry only, where its output came from: `driven_step` (the output the caller that named the step gave), `dependency` (its one `depends_on` step's output), `run_params` (the run's params; it has no `depends_on`) or `none` (nothing to copy, so `{}`: the engine ran a step that depends on several steps, or whose one dependency has no successful entry).",
    );
    const registry = createDefaultRegistry();
    registry.register('handler', 'count', {
      async execute() {
        return { data: { n: 1 } };
      },
    } as never);
    const { call, workflowStore, runStore } = await connect(registry);
    await workflowStore.register(
      wf([
        'id: sources',
        'name: sources',
        'version: 1',
        'steps:',
        '  a:',
        '    description: A.',
        '    execution: agent',
        '  b:',
        '    description: B.',
        '    execution: agent',
        '  from_params:',
        '    description: From the params.',
        '    execution: auto',
        '  from_dep:',
        '    description: From its dependency.',
        '    execution: auto',
        '    depends_on: [a]',
        '  from_none:',
        '    description: Two dependencies.',
        '    execution: auto',
        '    depends_on: [a, b]',
        '  counted:',
        '    description: A handler step.',
        '    execution: auto',
        '    handler: count',
      ]),
    );
    // A batch run runs no step, so a caller can name the bare `from_params` itself — the library
    // (an embedder: no party); #729 (the Q3 unit, E2 (a)): an agent's execute_step naming it is
    // refused, and the engine's own run records `run_params` (below).
    const batch = await call('start_run_batch', {
      workflow_id: 'sources',
      items: [{ params: { p: 1 } }],
    });
    const named = (batch['started'] as Array<{ run_id: string }>)[0]!.run_id;
    await executeStep(runStore, await workflowStore.get('sources'), {
      runId: named,
      command: 'from_params',
      input: { given: 2 },
      dispatcher: async () => ({ given: 2 }),
    });
    // start_run runs the owed bare steps itself; the answers to `a` and `b` let the engine run the rest.
    const s = await call('start_run', { workflow_id: 'sources', params: { p: 1 } });
    const runId = s['run_id'] as string;
    await call('execute_step', { run_id: runId, command: 'a', params: { fromA: 3 } });
    await call('execute_step', { run_id: runId, command: 'b', params: { fromB: 4 } });
    const of = (rec: { evidence: ReadonlyArray<object> }) =>
      Object.fromEntries(
        (rec.evidence as Array<Record<string, unknown>>).map((e) => [
          e['step_id'],
          [e['output_source'] ?? null, e['output_summary']],
        ]),
      );
    // (a) red when a source is recorded wrong, its output is not the one the page names, or an
    //     agent or handler step's entry carries the field; (b) prints the entries.
    expect([of(await runStore.get(named))['from_params'], of(await runStore.get(runId))]).toEqual([
      ['driven_step', { given: 2 }],
      {
        from_params: ['run_params', { p: 1 }],
        counted: [null, { n: 1 }],
        a: [null, { fromA: 3 }],
        from_dep: ['dependency', { fromA: 3 }],
        b: [null, { fromB: 4 }],
        from_none: ['none', {}],
      },
    ]);
  });

  it('error-codes.md: 90 codes defined — 75 raised, 15 that nothing raises', () => {
    claim(
      'docs/reference/error-codes.md',
      'This page lists all 90 codes that Realm defines: the 75 it raises, with when each is raised and what it tells the caller to do, and the 15 that nothing raises.',
    );
    const types = readFileSync(join(ROOT, 'packages/core/src/types/workflow-error.ts'), 'utf8');
    const lines = types.slice(types.indexOf('export type ErrorCode')).split('\n');
    const end = lines.findIndex((l) => /^\s*\| '[A-Z0-9_]+';/.test(l));
    const defined = lines
      .slice(0, end + 1)
      .map((l) => /^\s*\| '([A-Z0-9_]+)'/.exec(l)?.[1])
      .filter((c): c is string => c !== undefined);
    const text = readFileSync(join(ROOT, 'docs/reference/error-codes.md'), 'utf8');
    const raisedPart = text.slice(
      text.indexOf('## The codes Realm raises'),
      text.indexOf('## The codes nothing raises'),
    );
    const listedRaised = [...raisedPart.matchAll(/^\| `([A-Z0-9_]+)` +\|/gm)].map((m) => m[1]!);
    const listedUnraised = block('docs/reference/error-codes.md', 'NETWORK_TIMEOUT, ')
      .join(' ')
      .split(/[,\s]+/)
      .filter((c) => c !== '');
    // Realm's own code, every file but tests and the type itself: where a code is written in it.
    const sources: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          if (name !== 'node_modules' && name !== 'test-support') walk(path);
        } else if (/\.ts$/.test(name) && !/\.(test|d)\.ts$/.test(name)) {
          if (!path.endsWith(join('types', 'workflow-error.ts')))
            sources.push(readFileSync(path, 'utf8'));
        }
      }
    };
    for (const pkg of readdirSync(join(ROOT, 'packages'))) {
      const src = join(ROOT, 'packages', pkg, 'src');
      try {
        if (statSync(src).isDirectory()) walk(src);
      } catch {
        // a package with no src
      }
    }
    const written = (code: string) => sources.some((s) => s.includes(`'${code}'`));
    // (a) red when a code is added to the type without the page, the page's two lists stop
    //     covering the type, a code the page says nothing raises is written in Realm's code, or a
    //     code it says is raised is written nowhere; (b) prints the counts and the strays.
    expect({
      defined: defined.length,
      raised: listedRaised.length,
      unraised: listedUnraised.length,
      cover: [...listedRaised, ...listedUnraised].sort(),
      unraisedWritten: listedUnraised.filter(written),
      raisedNowhere: listedRaised.filter((c) => !written(c)),
    }).toEqual({
      defined: 90,
      raised: 75,
      unraised: 15,
      cover: [...defined].sort(),
      unraisedWritten: [],
      raisedNowhere: [],
    });
  });

  it('error-codes.md: VALIDATION_CALLER_INVALID — each of the five functions given a caller not its own; nothing read or written', async () => {
    const page = 'docs/reference/error-codes.md';
    claim(
      page,
      "A program passed `advanceRun`, `executeStep`, `executeChain`, `submitHumanResponse` or `executeEngineStep` a `caller` that is not one of that function's own words (see [Core library](core-library.md)).",
    );
    claim(page, 'Nothing was read or written. Added after version 0.46.0.');
    const dir = await mkdtemp(join(tmpdir(), 'realm-pages-625-e2-lib-'));
    const store = new JsonFileStore(dir);
    const def = wf([
      'id: lib',
      'name: lib',
      'version: 1',
      'steps:',
      '  a:',
      '    description: A.',
      '    execution: agent',
      '  go:',
      '    description: Go.',
      '    execution: auto',
      '    depends_on: [a]',
    ]);
    const { run } = await store.create({ workflowId: 'lib', workflowVersion: 1, params: {} });
    const before = JSON.stringify(await store.get(run.id));
    const bad = { caller: 'not-a-caller' } as never;
    const dispatcher = async () => ({});
    // A run that does not exist: had the call read the store, it would say STATE_RUN_NOT_FOUND.
    const calls: Array<[string, (runId: string) => Promise<unknown>]> = [
      ['advanceRun', (runId) => advanceRun(store, def, { runId, ...(bad as object) })],
      [
        'executeStep',
        (runId) =>
          executeStep(store, def, {
            runId,
            command: 'a',
            input: {},
            dispatcher,
            ...(bad as object),
          }),
      ],
      [
        'executeChain',
        (runId) =>
          executeChain(store, def, {
            runId,
            command: 'a',
            input: {},
            dispatcher,
            ...(bad as object),
          }),
      ],
      [
        'submitHumanResponse',
        (runId) =>
          submitHumanResponse(store, def, { runId, gateId: 'g', choice: 'x', ...(bad as object) }),
      ],
      [
        'executeEngineStep',
        async (runId) =>
          executeEngineStep(store, def, {
            runId,
            step: 'go',
            run: await store.get(run.id),
            ...(bad as object),
          }),
      ],
    ];
    const codes: Record<string, unknown[]> = {};
    for (const [name, fn] of calls) {
      const outcome: unknown[] = [];
      for (const runId of [run.id, 'no-such-run-625-e2']) {
        try {
          const r = (await fn(runId)) as { error_code?: string };
          outcome.push(`replied ${String(r.error_code)}`);
        } catch (err) {
          outcome.push((err as { code?: string }).code);
        }
      }
      codes[name] = outcome;
    }
    const allRefused = ['VALIDATION_CALLER_INVALID', 'VALIDATION_CALLER_INVALID'];
    // (a) red when a function accepts a word not its own, raises another code, reads the store
    //     first (STATE_RUN_NOT_FOUND on the missing run) or writes the record; (b) prints each.
    expect([codes, JSON.stringify(await store.get(run.id)) === before]).toEqual([
      {
        advanceRun: allRefused,
        executeStep: allRefused,
        executeChain: allRefused,
        submitHumanResponse: allRefused,
        executeEngineStep: allRefused,
      },
      true,
    ]);
  });

  it('packages/core/README.md: a run_step way names the next step; when an advance way is offered, call advanceRun — repeat until neither is offered (#729 PR-0: the library reply’s ways)', async () => {
    claim(
      'packages/core/README.md',
      // decision C192: the comment gives the call.
      '// response.ways says what can be done next: a run_step way names a step to execute; when an\n// advance way is offered, call advanceRun(store, definition, { runId: run.id }) (import it beside\n// executeStep). Repeat until neither is offered: the run has ended, or response.unavailable says\n// why nothing can run.',
    );
    const dir = await mkdtemp(join(tmpdir(), 'realm-pages-625-e2-readme-'));
    const store = new JsonFileStore(dir);
    const def = wf([
      'id: readme',
      'name: readme',
      'version: 1',
      'steps:',
      '  my_step:',
      '    description: Answer.',
      '    execution: agent',
      '  publish:',
      '    description: Publish.',
      '    execution: auto',
      '    depends_on: [my_step]',
      '  last:',
      '    description: Last.',
      '    execution: agent',
      '    depends_on: [publish]',
    ]);
    // A program's own run: nothing runs the engine's step until advanceRun is called.
    const { run } = await store.create({
      workflowId: def.id,
      workflowVersion: def.version,
      params: { input: 'hello' },
    });
    const seen: string[] = [];
    let response = await executeStep(store, def, {
      runId: run.id,
      command: 'my_step',
      input: { answer: 'done' },
      dispatcher: async (_stepName, stepInput) => stepInput,
    });
    const nextWay = () =>
      response.ways.find((w) => w.verb === 'advance') ??
      response.ways.find((w) => w.verb === 'run_step');
    for (let i = 0; i < 5 && nextWay() !== undefined; i++) {
      const next = nextWay()!;
      seen.push(next.verb === 'run_step' ? next.step : 'advance');
      response =
        next.verb === 'run_step'
          ? await executeStep(store, def, {
              runId: run.id,
              command: next.step,
              input: {},
              dispatcher: async (_stepName, stepInput) => stepInput,
            })
          : await advanceRun(store, def, { runId: run.id });
    }
    // (a) red when no advance way is offered while the engine owes `publish`, or the loop does not
    //     end the run with neither offered; (b) prints the calls made.
    expect([seen, (await store.get(run.id)).run_phase, nextWay()]).toEqual([
      ['advance', 'last'],
      'completed',
      undefined,
    ]);
  });
});

describe('#872 (b1) B11 — error-codes.md, agent-created-workflows.md, connect-an-mcp-client.md', () => {
  it('error-codes.md: the VALIDATION_CURSOR row', () => {
    // Pinned by execution in get-run-state-cursor-872.test.ts (B6: its code, action and words).
    claim(
      'docs/reference/error-codes.md',
      "| `VALIDATION_CURSOR` | `get_run_state` was given a `cursor` without `include_steps: true` or `step_names`, or a `cursor` that names no step the run has attempted. The reply's `errors[0]` says which, and how to call again. Added after version 0.48.0. | `provide_input` | No |",
    );
  });
  it('agent-created-workflows.md: one line per fault — the page’s example is the real line', async () => {
    // Correction 1 (C4): the grouping only of the same fault, the 8,000-character cap and the closing
    // line are pinned by execution in create-workflow-faults-872.test.ts (AC4).
    claim(
      'docs/guides/agent-created-workflows.md',
      "The refusal names each fault once: steps with the same fault share one line — the first step's message, then the other steps' names, `Step 'a': description must be non-empty (also 'b', 'c' and 4 more)`, two more names, then how many more. Steps share a line only when their fault is the same, so every fault shows at once; past about 8,000 characters, the last line counts the rest and names their steps (added after version 0.48.0).",
    );
    const { handleCreateWorkflow } = await import('./create-workflow.js');
    const dir = await mkdtemp(join(tmpdir(), 'realm-guides-872-'));
    const reply = await handleCreateWorkflow(
      { steps: ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => ({ id, description: '' })) },
      {
        workflowStore: new JsonWorkflowStore(join(dir, 'wf')),
        runStore: new JsonFileStore(join(dir, 'runs')),
      },
    );
    // (a) red when the page's example and the real line part; (b) prints the line.
    expect(reply.errors).toEqual([
      "Step 'a': description must be non-empty (also 'b', 'c' and 4 more)",
    ]);
  });
  it('connect-an-mcp-client.md: "## Other clients" — Codex’s per-tool limit (a third-party fact, pinned as text with its checked note)', () => {
    // Realm's half — the guarantee, and the three tools that shorten nothing yet — is pinned by
    // execution in reply-ceiling-correction-872.test.ts (AC3, the guard arm).
    claim(
      'docs/guides/connect-an-mcp-client.md',
      "Codex keeps only the first and the last part of a long tool reply unless that tool's limit is raised: set `mcp_servers.<id>.tools.<tool>.output_token_limit` in its config (checked against Codex's source at 73bdd06f, 2026-10-27). The limit is set per tool as `output_token_limit`, in tokens; without it, Codex applies its own default, as little as 10,000 bytes. Realm keeps a reply at or under 40,000 characters when shortening its lists can make it fit (three tools shorten nothing yet — see [The reply](../reference/mcp/tools.md#the-reply)).",
    );
  });
});
