// who-answered-603b.test.ts — #603 A3b: the MCP answer tool's sentence names the account a channel
// reported for the answer that stands, labelled as the channel's statement (the one sentence-maker,
// `renderOutcome`, through its one "by" part); the answer instruction offers `responded_by` (G5), and a
// placeholder copied into it names no one. Acceptance checks 2 (the MCP reply to a later answer),
// 4 (an account that cannot be shown), 5 (another route's account) and 9 (G5).
//
// The answers with an account are recorded the way a door or a library call records them
// (`submitHumanResponse` with a route and `channelEvidence`); the Slack door's own cells are in the
// CLI. Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  UNSHOWABLE_NAME,
  executeStep,
  instantText,
  submitHumanResponse,
  type RunStore,
  type SubmitGateOptions,
  type WorkflowDefinition,
  type WorkflowRegistrar,
} from '@sensigo/realm';
import { handleSubmitHumanResponse } from './submit-human-response.js';
import { handleAdvanceRun } from './advance-run.js';
import { RESPONDED_BY_PLACEHOLDER } from '../render-reply.js';
import { makeTempHome, type TempHome } from '../test-support/temp-home.js';

/** `confirm` (a question that names no one), then `after`. */
const d: WorkflowDefinition = {
  id: 'who-answered-603b-mcp',
  name: 'who-answered-603b-mcp',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    confirm: {
      description: 'Confirm.',
      execution: 'auto',
      trust: 'human_confirmed',
      depends_on: [],
      gate: { choices: ['approve', 'reject'] },
    },
    after: { description: 'After.', execution: 'auto', depends_on: ['confirm'] },
  },
};

/** Slack's statement of who replied, as the Slack door passes it. */
const SLACK: Partial<SubmitGateOptions> = {
  route: 'slack',
  channelEvidence: {
    user: 'U0ALICE',
    forms: ['U0ALICE', '<@U0ALICE>'],
    ts: '1.2',
    thread_ts: '1.1',
  },
};

describe('#603 A3b — the MCP answer tool names the account that answered, as its channel reports it', () => {
  let h: TempHome;
  let runStore: RunStore;
  let workflowStore: WorkflowRegistrar;
  beforeEach(async () => {
    h = await makeTempHome();
    runStore = h.stores.runStore;
    workflowStore = h.stores.workflowStore;
    await workflowStore.register(d);
  });
  afterEach(async () => {
    await h.cleanup();
  });

  async function atQuestion(): Promise<{ runId: string; gateId: string }> {
    const { record: run } = await runStore.create({
      workflowId: d.id,
      workflowVersion: 1,
      params: {},
    });
    await executeStep(runStore, d, {
      runId: run.id,
      command: 'confirm',
      input: {},
      dispatcher: async () => ({}),
    });
    return { runId: run.id, gateId: (await runStore.get(run.id)).record.pending_gate!.gate_id };
  }
  /** The answer `approve` recorded with `opts`; its time, as the sentence prints it. */
  async function answered(runId: string, gateId: string, opts: Partial<SubmitGateOptions>) {
    const r = await submitHumanResponse(runStore, d, { runId, gateId, choice: 'approve', ...opts });
    if (r.status !== 'ok') throw new Error(`fixture: ${r.status} ${r.errors[0]}`);
    const entry = (await runStore.get(runId)).record.evidence.find(
      (e) => e.kind === 'gate_response',
    );
    return instantText(Date.parse(entry!.completed_at));
  }
  /** The tool's sentence for a later answer `reject`. */
  async function later(opts: Partial<SubmitGateOptions>): Promise<{ error: string; at: string }> {
    const { runId, gateId } = await atQuestion();
    const at = await answered(runId, gateId, opts);
    const reply = await handleSubmitHumanResponse(
      { run_id: runId, gate_id: gateId, choice: 'reject' },
      { runStore, workflowStore },
    );
    return { error: reply.errors[0]!, at };
  }
  const beaten = (by: string, door: string, at: string): string =>
    `Not recorded: your choice 'reject'. The question on step 'confirm' was already answered — approve${by}, ${door}, at ${at}.`;

  it('check 2 (MCP): a Slack answer stands — the sentence says ", by U0ALICE (as Slack reports it)"', async () => {
    const { error, at } = await later(SLACK);
    // (a) red when `renderOutcome` ignores the account (", by" left out), or labels it otherwise;
    //     (b) prints the sentence.
    expect(error).toBe(beaten(', by U0ALICE (as Slack reports it)', 'through a Slack thread', at));
  });

  it('one rule: a stated name first, then the account — `, by "Ana" (as stated), U0ALICE (as Slack reports it)`', async () => {
    // No shipped door passes both; a library call can.
    const { error, at } = await later({ ...SLACK, respondedBy: 'Ana' });
    // (a) red when the account comes first, or replaces the name; (b) prints the sentence.
    expect(error).toBe(
      beaten(', by "Ana" (as stated), U0ALICE (as Slack reports it)', 'through a Slack thread', at),
    );
  });

  it('check 5 (MCP): another route’s account — "(as its channel reports it)", never "as Slack reports it"', async () => {
    const { error, at } = await later({
      route: 'teams',
      channelEvidence: { user: 'U0ALICE' },
    });
    // (a) red when the label is keyed on the account alone; (b) prints the sentence.
    expect(error).toBe(
      beaten(', by U0ALICE (as its channel reports it)', "through route 'teams'", at),
    );
  });

  it('check 4 (MCP): an account that cannot be shown — the one unshowable phrase, with no label', async () => {
    const { error, at } = await later({
      ...SLACK,
      channelEvidence: { user: 'U0\u0007ALICE', forms: ['U0\u0007ALICE'] },
    });
    // (a) red when the raw value is printed, or a label follows the phrase; (b) prints the sentence.
    expect({ error, raw: error.includes('\u0007') }).toEqual({
      error: beaten(`, by ${UNSHOWABLE_NAME}`, 'through a Slack thread', at),
      raw: false,
    });
  });

  it('a route a door declared as `account` is another route, never the label maker', async () => {
    // The door words gained an `account` member (the label by route); a route of that name is not it.
    const { error, at } = await later({ route: 'account', respondedBy: 'alice' });
    // (a) red when the route's words are read from the label maker; (b) prints the sentence.
    expect(error).toBe(beaten(', by "alice" (as stated)', "through route 'account'", at));
  });

  it('without an account the sentence is today’s, word for word', async () => {
    const { error, at } = await later({ route: 'cli', respondedBy: 'alice' });
    // (a) red when an answer with no account gains a part; (b) prints the sentence.
    expect(error).toBe(beaten(', by "alice" (as stated)', 'through a terminal', at));
  });
});

describe('#603 A3b — G5: the answer instruction offers `responded_by`; its placeholder names no one', () => {
  let h: TempHome;
  let runStore: RunStore;
  let workflowStore: WorkflowRegistrar;
  beforeEach(async () => {
    h = await makeTempHome();
    runStore = h.stores.runStore;
    workflowStore = h.stores.workflowStore;
    await workflowStore.register(d);
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it('check 9: the slot is offered; the placeholder copied and `<Ana>` record no name; `Ana` is recorded', async () => {
    const recordedName = async (respondedBy: string): Promise<unknown> => {
      const { record: run } = await runStore.create({
        workflowId: d.id,
        workflowVersion: 1,
        params: {},
      });
      // The engine runs the `auto` step and opens its question; its reply carries the instruction.
      const opened = await handleAdvanceRun({ run_id: run.id }, { runStore, workflowStore });
      const respond = opened.next_actions.find(
        (a) => a.instruction?.tool === 'submit_human_response',
      );
      const gateId = (await runStore.get(run.id)).record.pending_gate!.gate_id;
      const reply = await handleSubmitHumanResponse(
        { run_id: run.id, gate_id: gateId, choice: 'approve', responded_by: respondedBy },
        { runStore, workflowStore },
      );
      if (reply.status !== 'ok') throw new Error(`fixture: ${reply.status} ${reply.errors[0]}`);
      const entry = (await runStore.get(run.id)).record.evidence.find(
        (e) => e.kind === 'gate_response',
      );
      return {
        slot: respond?.instruction?.call_with?.['responded_by'],
        asks: respond?.human_readable.endsWith(
          "Pass the person's own name as responded_by when they gave one; never a guess.",
        ),
        recorded: entry?.responded_by ?? null,
      };
    };
    // (a) red when the instruction drops the slot or the sentence, or the placeholder (or a value
    //     wrapped whole in `<` `>`) is recorded as a person's name; (b) prints each answer's facts.
    expect({
      copied: await recordedName(RESPONDED_BY_PLACEHOLDER),
      angled: await recordedName('  <Ana>  '),
      named: await recordedName('Ana'),
    }).toEqual({
      copied: { slot: RESPONDED_BY_PLACEHOLDER, asks: true, recorded: null },
      angled: { slot: RESPONDED_BY_PLACEHOLDER, asks: true, recorded: null },
      named: { slot: RESPONDED_BY_PLACEHOLDER, asks: true, recorded: 'Ana' },
    });
  });
});
