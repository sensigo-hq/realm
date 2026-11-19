// lease-words-cw4a.test.ts — #729 CW-4a (prompt feat-729-cw4a-lease-words.md; checks 1 and 3, the MCP
// door): a step held by another drive under a lease whose check could not answer — the lease file absent,
// or each reason the check is unknown — is told by what the check found, never as a claim with no
// deadline. Each result through the door's three sentences: `advance_run`'s next sentence (the agent's),
// `get_run_state`'s operator entry (the condition), and `execute_step`'s by-name hint. The run store is
// `InMemoryStore` with the lease double, so a case sets each result; the claims are taken through
// `claimStepForDrive` (beta), as a drive takes them.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect, afterEach } from 'vitest';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  InMemoryTraceBufferStore,
  claimStepForDrive,
  createDefaultRegistry,
  type LeaseFact,
  type WayOn,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { InMemoryStore, createLeaseDouble } from '@sensigo/realm-testing';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createRealmMcpServer } from './server.js';
import { makeTempHome, type TempHome } from './test-support/temp-home.js';

type Reply = Record<string, unknown>;

const handles: TempHome[] = [];
afterEach(async () => {
  for (const h of handles.splice(0).reverse()) await h.cleanup();
});

/** Agent steps not declared idempotent: a drive's claim of one has no deadline. */
const DEF: WorkflowDefinition = {
  id: 'lease-words-cw4a-mcp',
  name: 'lease-words-cw4a-mcp',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    a: { description: 'An agent step.', execution: 'agent', depends_on: [] },
    b: { description: 'An agent step.', execution: 'agent', depends_on: [] },
    c: { description: 'An agent step.', execution: 'agent', depends_on: [] },
    d: { description: 'An agent step.', execution: 'agent', depends_on: [] },
  },
} as WorkflowDefinition;

const ROUTE = {
  render: (way: WayOn) => (way.verb === 'reclaim' ? `RECLAIM ${way.step}` : null),
  source: { kind: 'default' as const, ref: 'lease-words-cw4a' },
};
const NOT_DECLARED = 'It is not declared idempotent, so running it again may repeat its effects.';
const KERNEL = 'kernel_lock' as const;

/** The six results the check can give for a lease it could not answer for, with the phrase P. */
const RESULTS: Array<{ name: string; fact: LeaseFact; phrase: string }> = [
  {
    name: 'absent',
    fact: { state: 'absent', basis: KERNEL },
    phrase:
      'this home has no lease file the claim names, so whether its program still holds it is not known',
  },
  {
    name: 'unknown, not_checked',
    fact: { state: 'unknown', basis: KERNEL, reason: 'not_checked' },
    phrase: "whether its program still holds the claim's lease was not checked on this read",
  },
  {
    name: 'unknown, cannot_open',
    fact: { state: 'unknown', basis: KERNEL, reason: 'cannot_open' },
    phrase:
      "whether its program still holds the claim's lease could not be checked: its lease file could not be opened",
  },
  {
    name: 'unknown, not_a_lease',
    fact: { state: 'unknown', basis: KERNEL, reason: 'not_a_lease' },
    phrase:
      "whether its program still holds the claim's lease could not be checked: the file the claim names is not a lease file",
  },
  {
    name: 'unknown, permission',
    fact: { state: 'unknown', basis: KERNEL, reason: 'permission' },
    phrase:
      "whether its program still holds the claim's lease could not be checked: this program cannot open its lease file for writing, which checking needs",
  },
  {
    name: 'unknown, io_error',
    fact: { state: 'unknown', basis: KERNEL, reason: 'io_error' },
    phrase:
      "whether its program still holds the claim's lease could not be checked: reading its lease file failed",
  },
];
/** The condition form C of a phrase. */
const condition = (phrase: string): string =>
  `${phrase.charAt(0).toUpperCase()}${phrase.slice(1)}; if the claim's program still holds it, the step runs twice.`;

/** A door on `InMemoryStore` with the lease double, and a run of DEF. */
async function door() {
  const leases = createLeaseDouble();
  const runStore = new InMemoryStore({ leases });
  const h = await makeTempHome();
  handles.push(h);
  await h.stores.workflowStore.register(DEF);
  const server = createRealmMcpServer({
    gateAnswers: 'permitted',
    runStore,
    workflowStore: h.stores.workflowStore,
    traceBufferStore: new InMemoryTraceBufferStore(runStore),
    failedAttemptStore: h.stores.failedAttemptStore,
    operatorRoute: ROUTE,
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'lease-words-cw4a', version: '0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const call = async (name: string, args: Reply): Promise<Reply> => {
    const raw = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ text: string }>;
    };
    return JSON.parse(raw.content[0]!.text) as Reply;
  };
  const { record } = await runStore.create({ workflowId: DEF.id, workflowVersion: 1, params: {} });
  /** `step` taken by another drive under a lease, set in the double to `fact`. */
  const leased = async (step: string, fact: LeaseFact): Promise<void> => {
    const answer = await claimStepForDrive(runStore, record.id, step, {
      definition: DEF,
      registry: createDefaultRegistry(),
      driver: { by: 'other-drive', by_source: 'stated', channel: 'agent' },
    });
    if (answer.kind !== 'claimed')
      throw new Error(`fixture: not claimed: ${JSON.stringify(answer)}`);
    leases.set(answer.hold.id, { forced: fact });
  };
  /** `step` taken with no lease (an agent step's claim: no deadline). */
  const unleased = async (step: string): Promise<string> => {
    await runStore.claimStep(record.id, step, DEF);
    return (await runStore.get(record.id)).record.claims![step]!.since!;
  };
  return { call, runId: record.id, leased, unleased };
}

const elsewhereOf = (r: Reply, step: string): string | undefined =>
  (r['elsewhere'] as Array<{ verb: string; step?: string; human_readable: string }>).find(
    (e) => e.verb === 'reclaim' && e.step === step,
  )?.human_readable;

describe('#729 CW-4a — check 1: each result of the lease check, through the MCP door’s three sentences', () => {
  it.each(RESULTS)('$name', async ({ fact, phrase }) => {
    const d = await door();
    // The other steps are taken too, so that `a` is the one step a reply can name as held.
    for (const step of ['b', 'c', 'd']) await d.unleased(step);
    await d.leased('a', fact);
    const advanced = await d.call('advance_run', { run_id: d.runId });
    const state = await d.call('get_run_state', { run_id: d.runId });
    const byName = await d.call('execute_step', { run_id: d.runId, command: 'a', params: {} });
    const hint = String(advanced['context_hint']);
    // (a) red when a door gives the unknown-age words ("no deadline") for a leased claim, or one
    //     result's words for another; (b) prints each door's sentence for `a`.
    expect(
      {
        agent: hint.includes(
          `'a' is held; ${phrase}. Wait for it. If its program has stopped, a person can free it.`,
        ),
        operator: elsewhereOf(state, 'a'),
        byName: String(byName['context_hint']).includes(
          `Step 'a' cannot be called now: it is held; ${phrase} — if its program has stopped, a person can free it.`,
        ),
        noDeadline: [hint, String(byName['context_hint'])].some((t) =>
          /'a'[^.]*no deadline/.test(t),
        ),
      },
      `${hint}\n${String(byName['context_hint'])}`,
    ).toEqual({
      agent: true,
      operator: `An operator can free step 'a', outside this conversation. ${condition(phrase)} ${NOT_DECLARED}`,
      byName: true,
      noDeadline: false,
    });
  });
});

describe('#729 CW-4a — check 3: held steps are grouped by state and by the lease’s result', () => {
  it('unleased with no deadline, absent, cannot_open and io_error: four groups, each in its own words', async () => {
    const d = await door();
    const since = await d.unleased('a');
    await d.leased('b', RESULTS[0]!.fact);
    await d.leased('c', RESULTS[2]!.fact);
    await d.leased('d', RESULTS[5]!.fact);
    const hint = String((await d.call('advance_run', { run_id: d.runId }))['context_hint']);
    const sentence = hint.slice(hint.indexOf('No step is ready: ') + 'No step is ready: '.length);
    // (a) red when the groups are keyed on the reason alone (the unleased claim and the absent lease
    //     merge) or on the lease's state alone (the two unknown reasons merge); (b) prints the
    //     sentence.
    expect(sentence, hint).toBe(
      [
        `'a' has been held since ${since} by a claim with no deadline; wait for it. If its program has stopped, a person can free it.`,
        `'b' is held; ${RESULTS[0]!.phrase}. Wait for it. If its program has stopped, a person can free it.`,
        `'c' is held; ${RESULTS[2]!.phrase}. Wait for it. If its program has stopped, a person can free it.`,
        `'d' is held; ${RESULTS[5]!.phrase}. Wait for it. If its program has stopped, a person can free it.`,
      ].join(' '),
    );
  });
});
