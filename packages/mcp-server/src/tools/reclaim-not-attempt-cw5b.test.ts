// reclaim-not-attempt-cw5b.test.ts — #729 CW-5b, check 8 (item 4): a reclaim's audit entry is not an
// attempt. get_run_state's steps page and the run's cost count leave out a person's reclaim and an
// automatic take-back: neither is an attempt, and neither is counted as "no usage figures".
//
// Through the door (an in-memory MCP client on a server over a real SQLite home, the workflow
// registered, the server's own price source). The entries are made by the real functions: a drive's
// claim under a lease (`claimStepForDrive`) whose hold is then closed, so no program holds it; another
// drive's `takeBackStep`; a second claim, and a person's `reclaimStep` with `--force` and the claim's
// stamp. The step's one attempt is then answered through `execute_step`.
//
// Each assertion carries the two questions of `~/.claude/TESTING-RULES.md` rule 8 next to it: (1) the
// change that turns it red; (2) what it prints when it fails.
import { describe, it, expect, afterEach } from 'vitest';
import {
  claimStepForDrive,
  createDefaultRegistry,
  reclaimStep,
  takeBackStep,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  type Attributed,
  type RunStore,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createRealmMcpServer } from '../server.js';
import { makeTempHome, type TempHome } from '../test-support/temp-home.js';

type Reply = Record<string, unknown>;
const registry = createDefaultRegistry();
const prog = (by: string): Attributed => ({ by, by_source: 'stated', channel: 'agent' });

/** `s`, an agent step not declared idempotent. */
const DEF: WorkflowDefinition = {
  id: 'reclaim-not-attempt-cw5b',
  name: 'reclaim-not-attempt-cw5b',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: { s: { description: 'Answer this step.', execution: 'agent', depends_on: [] } },
} as WorkflowDefinition;

const handles: TempHome[] = [];
afterEach(async () => {
  for (const h of handles.splice(0).reverse()) await h.cleanup();
});

async function door() {
  const h = await makeTempHome();
  handles.push(h);
  await h.stores.workflowStore.register(DEF);
  const server = createRealmMcpServer({ ...h.stores });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'reclaim-not-attempt-cw5b', version: '0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const call = async (name: string, args: Reply): Promise<Reply> => {
    const raw = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ text: string }>;
    };
    return JSON.parse(raw.content[0]!.text) as Reply;
  };
  return { call, runStore: h.stores.runStore as RunStore };
}

/** `who` claims `s` under a lease and its hold is closed: the claim names a lease no program holds. */
async function claimAndLetGo(store: RunStore, runId: string, who: Attributed) {
  const answer = await claimStepForDrive(store, runId, 's', {
    definition: DEF,
    registry,
    driver: who,
  });
  if (answer.kind !== 'claimed') throw new Error(`fixture: not claimed: ${JSON.stringify(answer)}`);
  answer.hold.close((await store.get(runId)).record);
  return (await store.get(runId)).record.claims!['s']!;
}

/** A run of DEF whose `s` was taken back automatically once, then reclaimed by a person. */
async function reclaimedTwice() {
  const d = await door();
  const runId = String((await d.call('start_run', { workflow_id: DEF.id, params: {} }))['run_id']);
  const first = await claimAndLetGo(d.runStore, runId, prog('drive-a'));
  const back = await takeBackStep(d.runStore, runId, 's', {
    expectToken: first.token!,
    drivenBy: prog('drive-c'),
  });
  if (back.kind !== 'taken_back') throw new Error(`fixture: ${JSON.stringify(back)}`);
  const second = await claimAndLetGo(d.runStore, runId, prog('drive-x'));
  await reclaimStep(d.runStore, runId, 's', {
    definition: DEF,
    force: true,
    claimed_at: second.since!,
  });
  const reasons = (await d.runStore.get(runId)).record.evidence.map(
    (e) => e.output_summary?.['reason'],
  );
  if (JSON.stringify(reasons) !== JSON.stringify(['lease_not_held', 'manual reclaim']))
    throw new Error(`fixture: the entries are ${JSON.stringify(reasons)}`);
  return { ...d, runId };
}

describe('#729 CW-5b check 8 — get_run_state: a reclaim’s audit entry is not an attempt', () => {
  it('a take-back and a person’s reclaim, then the step answered once: one attempt on the steps page, one attempt with no usage figures in the cost count', async () => {
    const { call, runId } = await reclaimedTwice();
    const answered = await call('execute_step', {
      run_id: runId,
      command: 's',
      params: { ok: true },
    });
    if (answered['status'] !== 'ok') throw new Error(`fixture: ${JSON.stringify(answered)}`);
    const state = await call('get_run_state', { run_id: runId, include_steps: true });
    const steps = state['steps'] as Record<string, { attempts: Array<Record<string, unknown>> }>;
    const cost = state['run_cost'] as { unmeasured: Record<string, number> };
    // (1) red when a reclaim's entry is counted as an attempt (three attempts, the first two by the
    //     takers, and three with no usage figures); (2) prints the attempts and the count.
    expect({
      attempts: steps['s']!.attempts.map((a) => [a['attempt'], a['status'], a['cost_unrecorded']]),
      unmeasured: cost.unmeasured,
    }).toEqual({
      attempts: [[1, 'success', 'not_measured_by_realm']],
      unmeasured: { tool_calling_step: 0, not_measured_by_realm: 1, cost_unreadable: 0 },
    });
  });

  it('a step whose only entries are reclaims: no step view, so asking for it by name warns that it was not attempted', async () => {
    const { call, runId } = await reclaimedTwice();
    const state = await call('get_run_state', {
      run_id: runId,
      include_steps: true,
      step_names: ['s'],
    });
    const cost = state['run_cost'] as { unmeasured: Record<string, number> };
    // (1) red when a reclaim's entry makes a view (the step then shows two attempts and no warning)
    //     or is counted with no usage figures; (2) prints the steps page, the warnings and the count.
    expect({
      steps: state['steps'] ?? {},
      warned: ((state['warnings'] as string[] | undefined) ?? []).filter((w) =>
        w.includes("'s' is not a step this run has attempted"),
      ),
      unmeasured: cost.unmeasured,
    }).toEqual({
      steps: {},
      warned: ["'s' is not a step this run has attempted"],
      unmeasured: { tool_calling_step: 0, not_measured_by_realm: 0, cost_unreadable: 0 },
    });
  });
});
