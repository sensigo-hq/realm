// false-sentences-625.test.ts — issue #625 PR-2a, the last prompt's F17 over MCP (review G6-R4, G6-R5,
// G6-R6, F-R1, F-R2, F-R3): sentences of `tools.md`, `how-a-run-moves.md`, `top-level-fields.md` and
// the CHANGELOG made true as the build behaves, each driven here over a real MCP client.
//
//   - G6-R4: the `advance_run` act is offered for engine work this server can run; a step that needs
//     a handler this server lacks gets none (a `start_run_batch` entry's `next_actions` is empty).
//   - G6-R5: `advance_owed` is set exactly when the act is present and no agent step is ready —
//     except beside a claim past its time, where the status is `claim_stale` and the act stays.
//   - G6-R6: a step the engine refuses before its claim stops nothing; a step that fails, or a step
//     called by name that is refused, does.
//   - F-R1: five standard rules, plus two about concurrent attempts that are always added.
//   - F-R2: the protocol no longer forbids `execute_step` for an `auto` step — called by name, it
//     runs it.
//   - F-R3: `create_workflow`, `submit_human_response` and `advance_run` name an unknown argument;
//     the other eight tools drop it without a word.
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
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  type StepDefinition,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createRealmMcpServer } from '../server.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const TOOLS = 'docs/reference/mcp/tools.md';

/** (a) red when the page no longer holds the sentence word for word; (b) prints it. */
function claim(page: string, sentence: string): void {
  const flat = (t: string) => t.replace(/\s+/g, ' ');
  expect(
    flat(readFileSync(join(ROOT, page), 'utf8')),
    `${page} no longer says: ${sentence}`,
  ).toContain(flat(sentence));
}

type Reply = Record<string, unknown>;

async function connect(registry?: ExtensionRegistry) {
  const dir = await mkdtemp(join(tmpdir(), 'realm-f17-mcp-'));
  const runStore = new JsonFileStore(join(dir, 'runs'));
  const workflowStore = new JsonWorkflowStore(join(dir, 'wf'));
  const server = createRealmMcpServer({
    runStore,
    workflowStore,
    ...(registry !== undefined ? { registry } : {}),
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'f17', version: '0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const call = async (name: string, args: Reply): Promise<Reply> => {
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
  return { call, runStore, workflowStore };
}

const wf = (id: string, steps: Record<string, StepDefinition>): WorkflowDefinition => ({
  id,
  name: id,
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps,
});
const tools = (r: Reply): string[] =>
  ((r['next_actions'] as Array<{ instruction?: { tool?: string } }>) ?? []).map(
    (n) => n.instruction?.tool ?? '',
  );
const NEEDS_N = { type: 'object', required: ['n'], properties: { n: { type: 'number' } } };

describe('#625 PR-2a, F17 — the MCP pages say what the build does', () => {
  it.each([
    ['lacks', false],
    ['has (preservation)', true],
  ] as const)(
    'G6-R4: an owed step whose handler this server %s — the act, the batch entry and get_run_state',
    async (_label, has) => {
      claim(
        TOOLS,
        "every reply and `get_run_state` end `next_actions` with this act whenever engine work this server can run is owed and nobody is running it — after a gate is answered, when a question's time is up and it declares `on_expiry`, after `resume`, and for a run `start_run_batch` created. A step that needs a handler or adapter this server lacks gets no act: with nothing else to do, `next_actions` is empty and `get_run_state`'s `next_actions_status` is `blocked_on_capability`.",
      );
      claim(
        TOOLS,
        "Each entry's `next_actions` names its run's first call — empty when what the run owes needs a handler or adapter this server lacks (its `context_hint` then names the step: `'<step>' cannot run here (capability): …`) — and its `context_hint` is",
      );
      const registry = new ExtensionRegistry();
      if (has) registry.register('handler', 'totl', { id: 'totl', execute: async () => ({}) });
      const { call, workflowStore } = await connect(registry);
      await workflowStore.register(
        wf('f17-price', {
          total: { description: 'T.', execution: 'auto', depends_on: [], handler: 'totl' },
        }),
      );
      const batch = await call('start_run_batch', {
        workflow_id: 'f17-price',
        items: [{ params: {} }],
      });
      const entry = (batch['started'] as Reply[])[0]!;
      const id = String(entry['run_id']);
      const state = await call('get_run_state', { run_id: id });
      // (a) red when the act is offered for a step this server cannot run, or the entry's
      //     next_actions is not empty for it, or the server that has the handler loses the act
      //     (G6-R4); (b) prints the entry's next_actions and hint end, and the state's status.
      expect({
        entry: tools(entry),
        hint: String(entry['context_hint']).split(id).join('<run>'),
        status: state['next_actions_status'],
        state: tools(state),
      }).toEqual(
        has
          ? {
              entry: ['advance_run'],
              hint: "Run '<run>' created for workflow 'f17-price'. Owed to the engine: 'total' — call advance_run.",
              status: 'advance_owed',
              state: ['advance_run'],
            }
          : {
              entry: [],
              hint: "Run '<run>' created for workflow 'f17-price'. 'total' cannot run here (capability): handler 'totl' is not registered here — load the missing extension, or run the step on a runner that has it.",
              status: 'blocked_on_capability',
              state: [],
            },
      );
    },
  );

  it('G6-R5: a claim past its time beside owed engine work — the status is claim_stale, the act still offered', async () => {
    claim(
      'CHANGELOG.md',
      "`advance_owed` is set exactly when the act is present and no agent step is ready, unless a step's claim is past its time: the status is then `claim_stale`, with the act still in the list.",
    );
    const { call, runStore, workflowStore } = await connect();
    await workflowStore.register(
      wf('f17-stale', {
        x: { description: 'X.', execution: 'auto', depends_on: [] },
        y: { description: 'Y.', execution: 'auto', depends_on: [] },
      }),
    );
    const batch = await call('start_run_batch', {
      workflow_id: 'f17-stale',
      items: [{ params: {} }],
    });
    const id = String((batch['started'] as Reply[])[0]!['run_id']);
    const fresh = await call('get_run_state', { run_id: id });
    const r = await runStore.get(id);
    await runStore.update({
      ...r,
      in_progress_steps: ['x'],
      claims: { x: { deadline: new Date(Date.now() - 60_000).toISOString() } },
    } as never);
    const stale = await call('get_run_state', { run_id: id });
    // (a) red when a stale claim drops the act or the status says advance_owed beside it; (b)
    //     prints both statuses and acts.
    expect({
      fresh: [fresh['next_actions_status'], tools(fresh)],
      stale: [stale['next_actions_status'], tools(stale)],
    }).toEqual({
      fresh: ['advance_owed', ['advance_run']],
      stale: ['claim_stale', ['advance_run']],
    });
  });

  it('G6-R6: a step the engine refuses before its claim is skipped and the rest run; a step that fails, or a step called by name that is refused, stops the call', async () => {
    claim(
      'docs/start/how-a-run-moves.md',
      'After a step that fails, or a step you called that is refused, nothing more runs in that call; a step the engine refuses before its claim is skipped, and the rest run.',
    );
    const registry = new ExtensionRegistry();
    registry.register('handler', 'boom', {
      id: 'boom',
      execute: async () => {
        throw new Error('boom');
      },
    });
    const { call, runStore, workflowStore } = await connect(registry);
    const done = async (id: string) => [...(await runStore.get(id)).completed_steps];
    // Refused before its claim: `b` (its input) beside `c`, both after `a`.
    await workflowStore.register(
      wf('f17-fork', {
        a: { description: 'A.', execution: 'agent', depends_on: [] },
        b: { description: 'B.', execution: 'auto', depends_on: ['a'], input_schema: NEEDS_N },
        c: { description: 'C.', execution: 'auto', depends_on: ['a'] },
      }),
    );
    const fork = String((await call('start_run', { workflow_id: 'f17-fork' }))['run_id']);
    const forked = await call('execute_step', { run_id: fork, command: 'a', params: {} });
    // A step that fails: `d` (its handler throws), then `e`.
    await workflowStore.register(
      wf('f17-fail', {
        d: { description: 'D.', execution: 'auto', depends_on: [], handler: 'boom' },
        e: { description: 'E.', execution: 'auto', depends_on: [] },
      }),
    );
    const failed = await call('start_run', { workflow_id: 'f17-fail' });
    const failId = String(failed['run_id']);
    // A step called by name that is refused: `b` with no input, beside the owed `c`.
    await workflowStore.register(
      wf('f17-called', {
        b: { description: 'B.', execution: 'auto', depends_on: [], input_schema: NEEDS_N },
        c: { description: 'C.', execution: 'auto', depends_on: [] },
      }),
    );
    const batch = await call('start_run_batch', {
      workflow_id: 'f17-called',
      items: [{ params: {} }],
    });
    const called = String((batch['started'] as Reply[])[0]!['run_id']);
    const refused = await call('execute_step', { run_id: called, command: 'b', params: {} });
    // (a) red when a refused sibling stops the chain (G6-R6's "nothing more runs" read as fact), or
    //     a failed step or a refused named call goes on; (b) prints what each call left done.
    expect({
      fork: [forked['status'], await done(fork)],
      fail: [failed['status'], await done(failId), (await runStore.get(failId)).failed_steps],
      called: [refused['status'], await done(called)],
    }).toEqual({
      fork: ['ok', ['a', 'c']],
      fail: ['error', [], ['d']],
      called: ['error', []],
    });
  });

  it('F-R1: without protocol.rules, five standard rules and the two always added — seven', async () => {
    claim(
      TOOLS,
      "| `rules` | The rules to follow. The workflow's `protocol.rules`, or five standard rules; two rules about concurrent attempts are always added after either. |",
    );
    const { call, workflowStore } = await connect();
    const steps = {
      a: { description: 'A.', execution: 'agent', depends_on: [] } as StepDefinition,
    };
    await workflowStore.register(wf('f17-plain', steps));
    await workflowStore.register({ ...wf('f17-own', steps), protocol: { rules: ['Mine.'] } });
    const plain = (await call('get_workflow_protocol', { workflow_id: 'f17-plain' }))[
      'rules'
    ] as string[];
    const own = (await call('get_workflow_protocol', { workflow_id: 'f17-own' }))[
      'rules'
    ] as string[];
    // (a) red when the count is not five plus two, or the two are not added after the workflow's
    //     own (F-R1: the page said six); (b) prints the counts and the shared tail.
    expect({
      plain: plain.length,
      own: own.length,
      sameTail: JSON.stringify(plain.slice(5)) === JSON.stringify(own.slice(1)),
      ownFirst: own[0],
    }).toEqual({ plain: 7, own: 3, sameTail: true, ownFirst: 'Mine.' });
  });

  it('F-R2: an auto step’s protocol text names advance_run and forbids nothing — execute_step called by name runs it', async () => {
    claim(
      'CHANGELOG.md',
      "an `auto` step's `agent_involvement` reads `none — the engine runs this step; when next_actions names advance_run, call it`. They said that only `advance_run` runs such a step and not to call `execute_step` for it, but `execute_step` called by name runs it.",
    );
    claim(
      'docs/reference/workflow/top-level-fields.md',
      'When next_actions names advance_run, call it: the engine owes steps it runs when you call advance_run.',
    );
    const { call, runStore, workflowStore } = await connect();
    await workflowStore.register(
      wf('f17-auto', {
        a: { description: 'A.', execution: 'agent', depends_on: [] },
        s: { description: 'S.', execution: 'auto', depends_on: [] },
      }),
    );
    const protocol = await call('get_workflow_protocol', { workflow_id: 'f17-auto' });
    const s = (protocol['steps'] as Array<{ id: string; agent_involvement: string }>).find(
      (x) => x.id === 's',
    )!;
    const batch = await call('start_run_batch', {
      workflow_id: 'f17-auto',
      items: [{ params: {} }],
    });
    const id = String((batch['started'] as Reply[])[0]!['run_id']);
    const ran = await call('execute_step', { run_id: id, command: 's', params: {} });
    // (a) red when the protocol forbids the call that runs the step, or execute_step by name does
    //     not run an owed auto step (F-R2); (b) prints the involvement, the status and what ran.
    expect({
      involvement: s.agent_involvement,
      status: ran['status'],
      done: (await runStore.get(id)).completed_steps,
    }).toEqual({
      involvement: 'none — the engine runs this step; when next_actions names advance_run, call it',
      status: 'ok',
      done: ['s'],
    });
  });

  it('F-R3: an unknown argument — named by create_workflow, submit_human_response and advance_run; dropped without a word by the other eight', async () => {
    claim(
      TOOLS,
      '`create_workflow`, `submit_human_response` and `advance_run` are the exceptions: each names what it ignored, in `warnings`.',
    );
    claim(
      TOOLS,
      '`create_workflow` and `advance_run` name theirs too; the other tools still drop unknown arguments without saying so.',
    );
    const { call, workflowStore } = await connect();
    await workflowStore.register(
      wf('f17-ua', {
        q: {
          description: 'Q.',
          execution: 'auto',
          trust: 'human_confirmed',
          depends_on: [],
          gate: { choices: ['approve', 'reject'] },
        } as StepDefinition,
        b: { description: 'B.', execution: 'agent', depends_on: ['q'] },
      }),
    );
    const started = await call('start_run', { workflow_id: 'f17-ua', params: {} });
    const id = String(started['run_id']);
    const gateId = String((started['gate'] as Reply)['gate_id']);
    const calls: Array<[string, Reply]> = [
      ['list_workflows', {}],
      ['get_workflow_protocol', { workflow_id: 'f17-ua' }],
      ['start_run', { workflow_id: 'f17-ua', params: {} }],
      ['start_run_batch', { workflow_id: 'f17-ua', items: [{ params: {} }] }],
      ['get_run_state', { run_id: id }],
      ['submit_human_response', { run_id: id, gate_id: gateId, choice: 'approve' }],
      ['advance_run', { run_id: id }],
      ['append_trace', { run_id: id, step_id: 'b', entries: [] }],
      ['execute_step', { run_id: id, command: 'b', params: {} }],
      ['create_workflow', { steps: [{ id: 'a', description: 'A.' }] }],
      ['abandon_run', { run_id: id, reason: 'done' }],
    ];
    const names: string[] = [];
    const refusedAtMcp: string[] = [];
    for (const [tool, args] of calls) {
      const r = await call(tool, { ...args, bogus_arg: 1 });
      // A reply that is not JSON is the MCP layer's refusal: the tool never ran.
      if (r['_text'] !== undefined)
        refusedAtMcp.push(`${tool}: ${String(r['_text']).slice(0, 120)}`);
      if (JSON.stringify(r).includes('bogus_arg')) names.push(tool);
    }
    // (a) red when a tool the page says names an unknown argument does not, or one it says drops it
    //     names it (F-R3), or a call is refused at the MCP layer; (b) prints the tools.
    expect({ names, refusedAtMcp }).toEqual({
      names: ['submit_human_response', 'advance_run', 'create_workflow'],
      refusedAtMcp: [],
    });
  });
});
