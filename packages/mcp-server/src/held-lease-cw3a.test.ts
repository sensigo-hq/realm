// held-lease-cw3a.test.ts — #729 CW-3a (prompt feat-729-cw3a-held-state-lease.md; checks 1 and 2, the
// MCP door): on a SQLite home, a step held by another drive under a real kernel lease
// (`claimStepForDrive`, beta) — the hold open (held), then closed (not held) — is told to the agent by
// its lease, never its deadline. Held: the reply awaits with no `until`, and the operator's reclaim
// way says `lease_held`'s words first. Not held: `report_to_user`, the operator entry led by the
// not-held line, and the agent's clause for a step not declared idempotent with the rerun sentence.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect, afterEach } from 'vitest';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  claimStepForDrive,
  createDefaultRegistry,
  type LeaseHold,
  type WayOn,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createRealmMcpServer } from './server.js';
import { makeTempHome, type TempHome } from './test-support/temp-home.js';

type Reply = Record<string, unknown>;

const handles: TempHome[] = [];
const holds: LeaseHold[] = [];
afterEach(async () => {
  for (const h of holds.splice(0)) h.close();
  for (const h of handles.splice(0).reverse()) await h.cleanup();
});

/** `a` an agent step not declared idempotent: a drive's claim of it has no deadline. */
const DEF: WorkflowDefinition = {
  id: 'held-lease-cw3a-mcp',
  name: 'held-lease-cw3a-mcp',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: { a: { description: 'An agent step.', execution: 'agent', depends_on: [] } },
} as WorkflowDefinition;

const ROUTE = {
  render: (way: WayOn) => (way.verb === 'reclaim' ? `RECLAIM ${way.step}` : null),
  source: { kind: 'default' as const, ref: 'held-lease-cw3a' },
};
const NOT_DECLARED = 'It is not declared idempotent, so running it again may repeat its effects.';
const LEASE_HELD =
  "Its program held the claim's lease when it was checked; if that program is still running, the step runs twice.";
const NOT_HELD =
  "No program held the claim's lease when it was checked; no result is recorded for it.";

/** A SQLite home's door, and a run whose step `a` another drive took under a lease it holds. */
async function heldByDrive() {
  const h = await makeTempHome();
  handles.push(h);
  const runStore = h.stores.runStore;
  await h.stores.workflowStore.register(DEF);
  const server = createRealmMcpServer({
    gateAnswers: 'permitted',
    ...h.stores,
    operatorRoute: ROUTE,
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'held-lease-cw3a', version: '0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const call = async (name: string, args: Reply): Promise<{ json: Reply; person?: string }> => {
    const raw = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ text: string; annotations?: { audience?: string[] } }>;
    };
    const person = raw.content.find((c) => c.annotations?.audience?.includes('user'))?.text;
    return {
      json: JSON.parse(raw.content[0]!.text) as Reply,
      ...(person !== undefined ? { person } : {}),
    };
  };
  const { record } = await runStore.create({ workflowId: DEF.id, workflowVersion: 1, params: {} });
  const answer = await claimStepForDrive(runStore, record.id, 'a', {
    definition: DEF,
    registry: createDefaultRegistry(),
    driver: { by: 'other-drive', by_source: 'stated', channel: 'agent' },
  });
  if (answer.kind !== 'claimed') throw new Error(`fixture: not claimed: ${JSON.stringify(answer)}`);
  holds.push(answer.hold);
  const since = (await runStore.get(record.id)).record.claims!['a']!.since!;
  return { call, runId: record.id, hold: answer.hold, since };
}

const elsewhereOf = (r: Reply, step: string): string | undefined =>
  (r['elsewhere'] as Array<{ verb: string; step?: string; human_readable: string }>).find(
    (e) => e.verb === 'reclaim' && e.step === step,
  )?.human_readable;

describe('#729 CW-3a — check 1, held: a claim whose lease its program holds (SQLite, a real kernel lease)', () => {
  it('get_run_state awaits with no until; the operator’s reclaim way says lease_held’s words first', async () => {
    const d = await heldByDrive();
    const state = await d.call('get_run_state', { run_id: d.runId });
    // (a) red when the claim is classed by its deadline (none: the unknown-age words), or the held
    //     lease is offered with no condition; (b) prints the action, until and the operator lines.
    expect({
      action: state.json['agent_action'],
      until: state.json['until'] ?? null,
      elsewhere: elsewhereOf(state.json, 'a'),
      person: state.person,
    }).toEqual({
      action: 'await',
      until: null,
      elsewhere: `An operator can free step 'a', outside this conversation. ${LEASE_HELD} ${NOT_DECLARED}`,
      person: `An operator can free step 'a', outside this conversation. ${LEASE_HELD} ${NOT_DECLARED} The operator's command: RECLAIM a`,
    });
  });
});

describe('#729 CW-3a — check 2, not held: the drive let its lease go (SQLite, the hold closed)', () => {
  it('report_to_user; the operator entry leads with the not-held line; the agent’s clause carries the rerun sentence', async () => {
    const d = await heldByDrive();
    d.hold.close();
    const advanced = (await d.call('advance_run', { run_id: d.runId })).json;
    const state = await d.call('get_run_state', { run_id: d.runId });
    // (a) red when the claim is waited on, or any of these is left on `past` alone (the not-held
    //     claim has no deadline); (b) prints the hint, the action and the operator lines.
    expect({
      action: state.json['agent_action'],
      until: state.json['until'] ?? null,
      hint: advanced['context_hint'],
      wait: /wait/i.test(String(advanced['context_hint'])),
      elsewhere: elsewhereOf(state.json, 'a'),
    }).toEqual({
      action: 'report_to_user',
      until: null,
      hint: `Run '${d.runId}': nothing ran. No step is ready: 'a' was claimed, and no program held the claim's lease when it was checked; no result is recorded for it. Tell the user: a person can free it. ${NOT_DECLARED}`,
      wait: false,
      elsewhere: `An operator can free step 'a', outside this conversation. ${NOT_HELD} ${NOT_DECLARED}`,
    });
  });
});
