// actor-who-ended-625.test.ts — #625 PR-2b, the actor unit: who ended a run, on the MCP side.
//
// The assistant's `abandon_run` now records the program the server runs as and the tool, and every
// reply that says how the run ended names them. On this side the name is masked as environment
// values are: an assistant reads the reply, and a derived name is `<OS user>@<host>`, so the part of
// it that matches an environment value of 8 characters or more shows as `[REDACTED]`;
// REALM_OPERATOR's own value is not counted. Most cells run the
// real server in process (`createRealmMcpServer` over `InMemoryTransport`) with a derived driver
// whose OS user part is `abcdefgh` (8 characters, the environment floor) and `USER` stubbed to it,
// so the reply's own masking decides what shows. Every assertion carries (a) the change that turns
// it red and (b) what it prints.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  abandonRun,
  createDefaultRegistry,
  type Attributed,
  type ExtensionRegistry,
  type RunRecord,
  type StepDefinition,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { createRealmMcpServer } from './server.js';
import { makeTempHome, type TempHome } from './test-support/temp-home.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const RUN_STATE = 'docs/reference/mcp/run-state-and-health.md';
/** The run-state page's masking sentence; check 4's three masking cells execute it, one case each. */
const MASKING =
  "The name is masked as environment values are: the part of it that matches an environment value of 8 characters or more, such as a long OS user name, shows as `[REDACTED]`; REALM_OPERATOR's own value is not counted. Added after version 0.50.0. |";
/** (a) red when the page no longer holds the sentence word for word; (b) prints the sentence. */
function claim(page: string, sentence: string): void {
  const flat = (t: string): string => t.replace(/\s+/g, ' ');
  expect(
    flat(readFileSync(join(ROOT, page), 'utf8')),
    `${page} no longer says: ${sentence}`,
  ).toContain(flat(sentence));
}

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
  opts: { registry?: ExtensionRegistry; gateAnswers?: 'permitted'; driver?: Attributed } = {},
) {
  const h = await makeTempHome();
  homes.push(h);
  for (const d of defs) await h.stores.workflowStore.register(d);
  const server = createRealmMcpServer({
    ...h.stores,
    driver: opts.driver ?? DRIVER,
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
    claim(
      RUN_STATE,
      '| `sealed_by_actor` | `realm run abandon`, the `abandon_run` tool or `realm run cleanup` recorded the program that ended the run | That program: `by`, its name; `by_source`, how the name is known (`ambient` from REALM_OPERATOR, `derived` from the OS user, `stated` named by the program that runs Realm); and `channel`.',
    );
    claim(RUN_STATE, MASKING);
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
      by: actor?.['by'],
      shownAdvance: advanced.text.includes(USER_PART),
      shownState: state.text.includes(USER_PART),
    }).toEqual({
      seal: { arm: 'abandon_requested', by: DRIVER, door: 'abandon_run' },
      said: 1,
      reason: true,
      door: 'abandon_run',
      how: ['derived', 'mcp-stdio'],
      by: '[REDACTED]@box',
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

  it('check 4 — get_run_state shows the seal as stored: an unknown door as unrecognized, an unreadable name as name_unreadable', async () => {
    claim(
      RUN_STATE,
      "| `sealed_by_door` | The record names the command or tool that ended the run | `realm_run_abandon`, `abandon_run` or `realm_run_cleanup`; a word this version does not know reads `unrecognized door '<value>'`. Added after version 0.50.0. |",
    );
    claim(
      RUN_STATE,
      'A name that cannot be read is `{ "by": null, "absent_cause": "name_unreadable" }`.',
    );
    const def = wf('actor-mcp-stored', {
      a: { description: 'A.', execution: 'agent', depends_on: [] },
    });
    const { h, call } = await connected([def]);
    const runId = String((await call('start_run', { workflow_id: def.id })).reply.run_id);
    const { record } = await h.stores.runStore.get(runId);
    // A record a newer or broken writer left: a door this binary does not know, a name with a
    // control character.
    await h.stores.runStore.update({
      ...record,
      terminal_state: true,
      terminal_reason: 'x',
      abandoned_at: '2026-11-21T00:00:00.000Z',
      sealed_by: {
        arm: 'abandon_requested',
        by: { by: 'abcd\u001b[2J', by_source: 'derived', channel: 'abandon' },
        door: 'realm_run_sweeper',
      },
    } as unknown as RunRecord);
    const state = await call('get_run_state', { run_id: runId });
    // (a) red when an unknown door is dropped or shown as a member, or an unreadable name is shown
    //     or guessed at; (b) prints the two fields.
    expect([state.reply['sealed_by_door'], state.reply['sealed_by_actor']]).toEqual([
      "unrecognized door 'realm_run_sweeper'",
      { by: null, absent_cause: 'name_unreadable' },
    ]);
  });

  it('check 4 — the masking sentence, a short OS user (under the 8-character floor): advance_run’s sentence and get_run_state’s sealed_by_actor name ops@box whole', async () => {
    claim(RUN_STATE, MASKING);
    vi.stubEnv('REALM_NOT_SECRET', '');
    vi.stubEnv('USER', 'ops');
    const def = wf('actor-mcp-short', {
      a: { description: 'A.', execution: 'agent', depends_on: [] },
    });
    const short: Attributed = { by: 'ops@box', by_source: 'derived', channel: 'mcp-stdio' };
    const { call } = await connected([def], { driver: short });
    const runId = String((await call('start_run', { workflow_id: def.id })).reply.run_id);
    await call('abandon_run', { run_id: runId, reason: 'duplicate order' });
    const advanced = await call('advance_run', { run_id: runId });
    const state = await call('get_run_state', { run_id: runId });
    // (a) red when a name under the environment floor is masked (a lower floor, or the name
    //     classed as always hidden); (b) prints the sentence's clause and the field.
    expect({
      said: (advanced.reply.context_hint ?? '').includes(
        "It was abandoned with the assistant's 'abandon_run' tool, on the Realm server running as ops@box (from the OS user), with the reason \"duplicate order\".",
      ),
      by: (state.reply['sealed_by_actor'] as Record<string, unknown> | undefined)?.['by'],
    }).toEqual({ said: true, by: 'ops@box' });
  });

  it('check 4 — the masking sentence, REALM_OPERATOR of 8 or more characters: its own value shows whole on the assistant’s side', async () => {
    claim(RUN_STATE, MASKING);
    vi.stubEnv('REALM_NOT_SECRET', '');
    vi.stubEnv('REALM_OPERATOR', 'nightly-cleanup');
    const def = wf('actor-mcp-probe', {
      a: { description: 'A.', execution: 'agent', depends_on: [] },
    });
    const op: Attributed = { by: 'nightly-cleanup', by_source: 'ambient', channel: 'mcp-stdio' };
    const { call } = await connected([def], { driver: op });
    const runId = String((await call('start_run', { workflow_id: def.id })).reply.run_id);
    await call('abandon_run', { run_id: runId, reason: 'duplicate order' });
    const advanced = await call('advance_run', { run_id: runId });
    const state = await call('get_run_state', { run_id: runId });
    // (a) red when REALM_OPERATOR's value is swept with the environment's (it leaves Realm's
    //     settings list); (b) prints the sentence's clause and the field.
    expect({
      said: (advanced.reply.context_hint ?? '').includes(
        "It was abandoned with the assistant's 'abandon_run' tool, on the Realm server running as nightly-cleanup (from REALM_OPERATOR), with the reason \"duplicate order\".",
      ),
      by: (state.reply['sealed_by_actor'] as Record<string, unknown> | undefined)?.['by'],
    }).toEqual({ said: true, by: 'nightly-cleanup' });
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
