// asked-person-729.test.ts — #729 PR-4 at the MCP door (01, 03; 04 B2 and the cut line's way): the
// door builds its disclosure set BEFORE the engine call, so a gate a call opens mints its question
// masked with it — through start_run, execute_step and advance_run — and the reply is disclosed with
// the SAME set (the provider asked once); a question cut when it opened carries the way to the whole
// output only in the block addressed to the person. Every value is a fake. Each assertion names (a) the
// change that turns it red and (b) what it prints: stored questions (fakes), counts, booleans.
import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  JsonFileStore,
  JsonWorkflowStore,
  buildDisclosureSet,
  endsWithCutSentence,
  VIEW_BUDGET,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createRealmMcpServer } from './server.js';

const FAKE = 'CANARY-declared-mcp-7d31-0123456789';
const set = buildDisclosureSet({
  env: {},
  declared: { SECRET_X: FAKE },
  declaredState: 'resolved',
  audience: 'agent',
}).set;

const def = (id: string, steps: Record<string, unknown>) =>
  ({
    id,
    name: id,
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps,
  }) as unknown as WorkflowDefinition;
const autoGate = (message: string) => ({
  review: {
    description: 'The gate.',
    execution: 'auto',
    trust: 'human_confirmed',
    depends_on: [],
    gate: { choices: ['approve', 'reject'], message },
  },
});

async function connect(extra: Record<string, unknown> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'realm-asked-729-'));
  const runStore = new JsonFileStore(join(dir, 'runs'));
  const workflowStore = new JsonWorkflowStore(join(dir, 'wf'));
  let asked = 0;
  const server = createRealmMcpServer({
    runStore,
    workflowStore,
    disclosureProvider: async () => {
      asked += 1;
      return set;
    },
    ...extra,
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'asked-729', version: '0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const raw = async (name: string, args: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: args })) as {
      content: Array<{ text: string; annotations?: { audience?: string[] } }>;
    };
  const call = async (name: string, args: Record<string, unknown>) =>
    JSON.parse((await raw(name, args)).content[0]!.text) as Record<string, unknown>;
  return { runStore, workflowStore, call, raw, asked: () => asked };
}

describe('#729 PR-4 — the MCP door mints a question with its set (B2)', () => {
  it('start_run: the stored question is masked, the reply shows it, and the provider is asked once', async () => {
    const door = await connect();
    await door.workflowStore.register(def('a729', autoGate('Approve {{ run.params.token }}?')));
    const before = door.asked();
    const started = await door.call('start_run', { workflow_id: 'a729', params: { token: FAKE } });
    const stored = (await door.runStore.get(started['run_id'] as string)).pending_gate
      ?.resolved_message;
    // (a) red when the set is built after the engine call (the fake stored raw), or the reply's set
    //     is built again (the provider asked twice); (b) prints the stored question, the display,
    //     the receipt's state and the count.
    expect({
      stored,
      display: (started['gate'] as { display?: string }).display,
      receipt: (started['disclosure'] as { declared: string }).declared,
      asked: door.asked() - before,
    }).toEqual({
      stored: 'Approve [REDACTED]?',
      display: 'Approve [REDACTED]?',
      receipt: 'resolved',
      asked: 1,
    });
  });

  it('execute_step: an agent step’s gate mints its question with the set', async () => {
    const door = await connect();
    await door.workflowStore.register(
      def('e729', {
        ask: {
          description: 'Ask.',
          execution: 'agent',
          trust: 'human_confirmed',
          depends_on: [],
          gate: { choices: ['approve', 'reject'], message: 'Send {{ context.resources.ask.v }}?' },
        },
      }),
    );
    const started = await door.call('start_run', { workflow_id: 'e729', params: {} });
    const runId = started['run_id'] as string;
    await door.call('execute_step', { run_id: runId, command: 'ask', params: { v: FAKE } });
    // (a) red when execute_step's handler passes no set to executeChain; (b) prints the stored text.
    expect((await door.runStore.get(runId)).pending_gate?.resolved_message).toBe(
      'Send [REDACTED]?',
    );
  });

  it('advance_run: a gate the call opens mints its question with the set', async () => {
    const door = await connect();
    await door.workflowStore.register(def('v729', autoGate('Approve {{ run.params.token }}?')));
    const { run } = await door.runStore.create({
      workflowId: 'v729',
      workflowVersion: 1,
      params: { token: FAKE },
    });
    await door.call('advance_run', { run_id: run.id });
    // (a) red when advance_run's handler, or advanceRun's forwarding, drops the set; (b) prints the
    //     stored question.
    expect((await door.runStore.get(run.id)).pending_gate?.resolved_message).toBe(
      'Approve [REDACTED]?',
    );
  });
});

describe('#729 PR-4 — the cut line’s way, in the person’s block only (C6 (d))', () => {
  it('a question cut when it opened: the inspect way in the block addressed to the person; no agent text names it', async () => {
    const route = {
      render: (way: { verb: string; run_id?: string }) =>
        way.verb === 'inspect' ? `realm run inspect ${way.run_id}` : null,
      source: { kind: 'default' as const, ref: 'test' },
    };
    const door = await connect({ operatorRoute: route });
    await door.workflowStore.register(def('c729', autoGate('W'.repeat(700))));
    const result = await door.raw('start_run', { workflow_id: 'c729', params: {} });
    const agent = result.content[0]!.text;
    const runId = (JSON.parse(agent) as { run_id: string }).run_id;
    const person = result.content.find((c) => c.annotations?.audience?.includes('user'))?.text;
    // (a) red when the way is put in the question's text or the agent's JSON, or left out of the
    //     person's block; (b) prints booleans.
    expect({
      cut: endsWithCutSentence((JSON.parse(agent) as { gate: { display: string } }).gate.display),
      person: person?.includes(`realm run inspect ${runId}`) ?? false,
      agent: agent.includes(`realm run inspect ${runId}`),
    }).toEqual({ cut: true, person: true, agent: false });
  });
});

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const flat = (t: string): string => t.replace(/\s+/g, ' ');
/** (a) red when the page no longer holds the sentence word for word; (b) prints the sentence. */
function claim(page: string, sentence: string): void {
  expect(
    flat(readFileSync(join(ROOT, page), 'utf8')),
    `${page} no longer says: ${sentence}`,
  ).toContain(flat(sentence));
}

describe('#729 PR-4 — a gate with no message, whose prompt changed after it opened (f)', () => {
  it('the fresh open carries no `display`; after the prompt changes, a second call is refused while the question is open — the prompt, old or new, is never the question', async () => {
    const door = await connect();
    const step = (prompt: string) => ({
      ask: {
        description: 'Ask.',
        execution: 'agent',
        prompt,
        trust: 'human_confirmed',
        depends_on: [],
        gate: { choices: ['approve', 'reject'] },
      },
    });
    await door.workflowStore.register(def('f729', step('PROMPT-ONE-0729')));
    const runId = (await door.call('start_run', { workflow_id: 'f729', params: {} }))[
      'run_id'
    ] as string;
    const fresh = await door.call('execute_step', {
      run_id: runId,
      command: 'ask',
      params: { body: 'B' },
    });
    await door.workflowStore.register(def('f729', step('PROMPT-TWO-0729')));
    const again = await door.call('execute_step', {
      run_id: runId,
      command: 'ask',
      params: { body: 'B' },
    });
    claim(
      'docs/reference/workflow/gates.md',
      "An assistant receives the rendered message as `gate.display`. Without `message`, `gate.display` is absent: no question is made from the step's `prompt`, and every surface shows the step's output as the gate's body.",
    );
    claim(
      'docs/reference/mcp/tools.md',
      "`display` is the gate's `message` as it was stored when the gate opened, cut to the view budget when longer; a gate with no `message` has none.",
    );
    // (a) red when the fresh open renders the prompt as `display`, or the second call re-renders
    //     it from the current definition; (b) prints the display, the statuses and a boolean. (The
    //     engine's `already_open` arm — a second caller's own gate-open — is w-627.test.ts's cell.)
    expect({
      fresh: (fresh['gate'] as { display?: string } | undefined)?.display,
      statuses: [fresh['status'], again['status']],
      prompt: JSON.stringify([fresh, again]).includes('PROMPT-'),
    }).toEqual({ fresh: undefined, statuses: ['confirm_required', 'blocked'], prompt: false });
  });

  it('a gate with a message: `display` is the stored question, cut to the view budget when longer', async () => {
    const door = await connect();
    await door.workflowStore.register(def('m729', autoGate('Q'.repeat(700))));
    const started = await door.call('start_run', { workflow_id: 'm729', params: {} });
    const stored = (await door.runStore.get(started['run_id'] as string)).pending_gate
      ?.resolved_message;
    const display = (started['gate'] as { display: string }).display;
    // (a) red when `display` is re-rendered rather than the stored text, or the cut is lost; (b)
    //     prints booleans and the length.
    expect({
      same: display === stored,
      cut: endsWithCutSentence(display),
      within: display.length <= VIEW_BUDGET,
    }).toEqual({
      same: true,
      cut: true,
      within: true,
    });
  });
});
