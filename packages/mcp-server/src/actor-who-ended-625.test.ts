// actor-who-ended-625.test.ts — #625 PR-2b, the actor unit: who ended a run, on the MCP side.
//
// The assistant's `abandon_run` now records the program the server runs as and the tool, and every
// reply that says how the run ended names them. On this side the name is masked as an OS user name
// is: an assistant reads the reply, and a derived name is `<OS user>@<host>`. These cells run the
// real server in process (`createRealmMcpServer` over `InMemoryTransport`) with a derived driver
// whose OS user part is `abcdefgh` (8 characters, the environment floor) and `USER` stubbed to it,
// so the reply's own masking decides what shows. Every assertion carries (a) the change that turns
// it red and (b) what it prints.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  abandonRun,
  createDefaultRegistry,
  type Attributed,
  type ExtensionRegistry,
  type StepDefinition,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { createRealmMcpServer } from './server.js';
import { makeTempHome, type TempHome } from './test-support/temp-home.js';

const DRIVER: Attributed = { by: 'abcdefgh@box', by_source: 'derived', channel: 'mcp-stdio' };
const USER_PART = 'abcdefgh';

const wf = (id: string, steps: Record<string, StepDefinition>): WorkflowDefinition => ({
  id,
  name: id,
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps,
});

const homes: TempHome[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const h of homes.splice(0).reverse()) await h.cleanup();
});

type Reply = Record<string, unknown> & {
  context_hint?: string;
  run_id?: string;
  run_phase?: string;
  gate_claim?: Record<string, unknown>;
  next_actions?: Array<{
    instruction: { tool: string; call_with: Record<string, unknown> } | null;
  }>;
};

/** The real server in process, with this driver, the given registry and gate-answers setting. */
async function connected(
  defs: WorkflowDefinition[],
  opts: { registry?: ExtensionRegistry; gateAnswers?: 'permitted' } = {},
) {
  const h = await makeTempHome();
  homes.push(h);
  for (const d of defs) await h.stores.workflowStore.register(d);
  const server = createRealmMcpServer({
    ...h.stores,
    driver: DRIVER,
    ...(opts.registry !== undefined ? { registry: opts.registry } : {}),
    ...(opts.gateAnswers !== undefined ? { gateAnswers: opts.gateAnswers } : {}),
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'actor-625', version: '0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const call = async (name: string, args: Record<string, unknown>) => {
    const raw = (await client.callTool({ name, arguments: args }, undefined, {
      timeout: 600_000,
    })) as { content: Array<{ text?: string }> };
    const text = raw.content[0]?.text ?? '{}';
    return { text, reply: JSON.parse(text) as Reply };
  };
  return { h, call };
}

const occurrences = (text: string, part: string) => text.split(part).length - 1;

/**
 * USER is the OS user part; REALM_NOT_SECRET is cleared, because the suite's environment pin
 * (scripts/vitest-pin-environment.mjs) names every variable the test process starts with in it, so
 * a cell about masking sets it itself.
 */
/** Every path in `value` whose string holds `part`, sorted. */
function pathsHolding(value: unknown, part: string, path = ''): string[] {
  if (typeof value === 'string') return value.includes(part) ? [path] : [];
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value)
    .flatMap(([k, v]) => pathsHolding(v, part, path === '' ? k : `${path}.${k}`))
    .sort();
}

function stubUser(): void {
  vi.stubEnv('REALM_NOT_SECRET', '');
  vi.stubEnv('USER', USER_PART);
}

describe('#625 the actor unit, check 4 — abandon_run records the server’s program and the tool; the replies mask its name', () => {
  it('check 4 — abandon_run records the driver and door abandon_run; advance_run’s sentence and get_run_state’s sealed_by_actor show no byte of the OS user', async () => {
    stubUser();
    const def = wf('actor-mcp', { a: { description: 'A.', execution: 'agent', depends_on: [] } });
    const { h, call } = await connected([def]);
    const started = await call('start_run', { workflow_id: def.id });
    const runId = String(started.reply.run_id);
    await call('abandon_run', { run_id: runId, reason: 'duplicate order' });
    const seal = (await h.stores.runStore.get(runId)).record.sealed_by;
    const advanced = await call('advance_run', { run_id: runId });
    const state = await call('get_run_state', { run_id: runId });
    const actor = state.reply['sealed_by_actor'] as Record<string, unknown> | undefined;
    // (a) red when abandon_run passes no driver or another door, the sentence is not the tool's,
    //     or `sealed_by_actor.by` is classed `fact` (the OS user then shows); (b) prints them.
    expect({
      seal,
      said: occurrences(
        advanced.reply.context_hint ?? '',
        "It was abandoned with the assistant's 'abandon_run' tool, on the Realm server running as ",
      ),
      reason: (advanced.reply.context_hint ?? '').includes(
        '(from the OS user), with the reason "duplicate order".',
      ),
      door: state.reply['sealed_by_door'],
      how: [actor?.['by_source'], actor?.['channel']],
      shownAdvance: advanced.text.includes(USER_PART),
      shownState: state.text.includes(USER_PART),
    }).toEqual({
      seal: { arm: 'abandon_requested', by: DRIVER, door: 'abandon_run' },
      said: 1,
      reason: true,
      door: 'abandon_run',
      how: ['derived', 'mcp-stdio'],
      shownAdvance: false,
      shownState: false,
    });
  });

  it('check 4 — a run ended with no program recorded has neither field on get_run_state', async () => {
    const def = wf('actor-mcp-none', {
      a: { description: 'A.', execution: 'agent', depends_on: [] },
    });
    const { h, call } = await connected([def]);
    const runId = String((await call('start_run', { workflow_id: def.id })).reply.run_id);
    await abandonRun(h.stores.runStore, runId, 'x');
    const state = await call('get_run_state', { run_id: runId });
    // (a) red when an absent member is rendered as null or as a placeholder; (b) prints the keys.
    expect([
      'sealed_by_actor' in state.reply,
      'sealed_by_door' in state.reply,
      state.reply['sealed_by_arm'],
    ]).toEqual([false, false, 'abandon_requested']);
  });
});

describe('#625 the actor unit, check 5 — the cross cell: a carried-on answer meets another program’s abandon', () => {
  it('check 5 — through an MCP client with gateAnswers permitted: the carried-on reply says the abandon with its program once, and no byte of the OS user', async () => {
    stubUser();
    const target: { runId?: string; store?: Parameters<typeof abandonRun>[0] } = {};
    const registry = createDefaultRegistry();
    registry.register('handler', 'end_it', {
      id: 'end_it',
      execute: async () => {
        await abandonRun(target.store!, target.runId!, 'another program', {
          by: DRIVER,
          door: 'realm_run_abandon',
        });
        return { data: {} };
      },
    } as never);
    const def = wf('actor-cross', {
      confirm: {
        description: 'Confirm.',
        execution: 'auto',
        trust: 'human_confirmed',
        depends_on: [],
        gate: { choices: ['approve', 'reject'] },
      },
      a: { description: 'A.', execution: 'auto', depends_on: ['confirm'], handler: 'end_it' },
      finish: { description: 'Finish.', execution: 'agent', depends_on: ['a'] },
    });
    const { h, call } = await connected([def], { registry, gateAnswers: 'permitted' });
    const opened = await call('start_run', { workflow_id: def.id });
    target.runId = String(opened.reply.run_id);
    target.store = h.stores.runStore;
    const action = opened.reply.next_actions?.[0]?.instruction;
    if (action?.tool !== 'submit_human_response') throw new Error('fixture: no answer instruction');
    const answered = await call('submit_human_response', {
      ...action.call_with,
      choice: 'approve',
    });
    // (a) red when the carried-on tail drops the program's clause, says the ending twice, or the
    //     sentence shows the OS user; (b) prints the count, the phase, the claim and where the
    //     name shows. Reality pinned (the prompt asked for no byte anywhere in the reply, which cannot
    //     hold without changing other units' classes): `gate_claim.opened_by.by` and
    //     `gate_claim.continued_by.by` are A2a's and the holder slice's `fact` rows, unchanged here;
    //     they carry the server's own driver as recorded (ACT-AUR-03; MA 2 is filing the question).
    expect({
      said: occurrences(
        answered.reply.context_hint ?? '',
        "It was abandoned with 'realm run abandon', by ",
      ),
      reason: (answered.reply.context_hint ?? '').includes(
        '(from the OS user), with the reason "another program".',
      ),
      phase: answered.reply.run_phase,
      carried: answered.reply.gate_claim?.['carried_on'],
      shownInSentence: (answered.reply.context_hint ?? '').includes(USER_PART),
      shownAt: pathsHolding(answered.reply, USER_PART),
    }).toEqual({
      said: 1,
      reason: true,
      phase: 'abandoned',
      carried: true,
      shownInSentence: false,
      shownAt: ['gate_claim.continued_by.by', 'gate_claim.opened_by.by'],
    });
  });
});
