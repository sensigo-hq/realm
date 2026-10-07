// agent-expired-question-625.test.ts — issue #625 PR-2a, decision C159 (walk c5, W2-Y3): `realm agent`
// on a run whose question is already past its time, with an `on_expiry` the engine carries out,
// never announces the question as live (`Waiting for approval…`, `--choice` commands an answer could
// no longer be recorded through): it carries the expiry out first, printing the line that says so,
// and then runs what that made owed. A question whose time is not up is announced as before.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryStore } from '@sensigo/realm-testing';
import {
  createDefaultRegistry,
  executeChain,
  loadWorkflowFromString,
  submitHumanResponse,
  type PendingGate,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { runAgent } from './run-agent.js';
import { LlmProvider } from './providers/llm-provider.js';

const workflowStore = (def: WorkflowDefinition) => ({
  async register() {},
  async get() {
    return def;
  },
  async list() {
    return [def];
  },
});

/** review (a question, `on_expiry` as given) → file (auto). */
function gated(onExpiry: 'settle_default' | 'abort'): WorkflowDefinition {
  return loadWorkflowFromString(
    [
      `id: c159-${onExpiry}`,
      `name: c159-${onExpiry}`,
      'version: 1',
      'steps:',
      '  review:',
      '    description: A person decides whether the order ships.',
      '    execution: auto',
      '    trust: human_confirmed',
      '    gate:',
      '      choices: [ship, hold]',
      '      timeout_seconds: 60',
      `      on_expiry: ${onExpiry}`,
      ...(onExpiry === 'settle_default' ? ['      default_choice: hold'] : []),
      '  file:',
      '    description: File the order.',
      '    execution: auto',
      '    depends_on: [review]',
      '',
    ].join('\n'),
  );
}

/** A run at the question; `expired` moves its deadline into the past. */
async function atQuestion(def: WorkflowDefinition, expired: boolean) {
  const store = new InMemoryStore();
  const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
  await executeChain(store, def, {
    runId: run.id,
    command: 'review',
    input: {},
    dispatcher: async () => ({}),
    registry: createDefaultRegistry(),
  });
  const open = await store.get(run.id);
  const gate = open.pending_gate as PendingGate;
  if (expired) {
    await store.update({
      ...open,
      pending_gate: { ...gate, expires_at: new Date(Date.now() - 5_000).toISOString() },
    });
  }
  return { store, runId: run.id, gateId: gate.gate_id };
}

/** C159: (a) red when realm-agent.md no longer holds the row's words; (b) prints them. */
const AGENT_ROW =
  "The expiry it carried out, in place of the gate's lines: such a question is not shown, since an answer could no longer be recorded.";
function claimAgentRow(): void {
  const page = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../../../../docs/reference/cli/realm-agent.md'),
    'utf8',
  ).replace(/\s+/g, ' ');
  expect(page, `realm-agent.md no longer says: ${AGENT_ROW}`).toContain(AGENT_ROW);
}

const provider = () =>
  new (class extends LlmProvider {
    callStep = vi.fn();
  })();

afterEach(() => {
  vi.restoreAllMocks();
});

describe('#625 PR-2a, C159 — realm agent carries out a question that is already past its time before announcing anything', () => {
  it.each([
    [
      'settle_default',
      "this agent call first carried out its declared settle_default: the default choice 'hold' was recorded (enacted_via: agent).",
      'completed',
      ['→ [auto] file', '  ✓ → completed'],
    ],
    [
      'abort',
      'this agent call first carried out its declared abort: the run ended (enacted_via: agent).',
      'aborted',
      [],
    ],
  ] as const)(
    'C159, W2-Y3: %s — the expiry line first, no `Waiting for approval…`, no `--choice` command; then what it made owed',
    async (kind, tail, phase, after) => {
      claimAgentRow();
      const def = gated(kind);
      const { store, runId, gateId } = await atQuestion(def, true);
      const llm = provider();
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await runAgent(
        {
          store,
          workflowStore: workflowStore(def),
          provider: llm,
          registry: createDefaultRegistry(),
        },
        { definition: def, existingRunId: runId, params: {}, pollIntervalMs: 20 },
      );
      const out = [...logSpy.mock.calls, ...errSpy.mock.calls].map((c) => String(c[0]));
      const line = `⚠ gate '${gateId}' on 'review' had expired — ${tail}`;
      // (a) red when the question is announced before its expiry is carried out (the gate block,
      //     `Waiting for approval...`, a `realm run respond … --choice` command) or when the expiry
      //     line is not printed; (b) prints what the drive printed.
      expect(
        out.filter(
          (l) =>
            l.includes('Waiting for approval') || l.includes('--choice') || l.includes('⏸  Gate'),
        ),
      ).toEqual([]);
      expect(out.filter((l) => l === line)).toHaveLength(1);
      const at = out.indexOf(line);
      expect(out.slice(at + 1, at + 1 + after.length)).toEqual(after);
      expect((await store.get(runId)).run_phase).toBe(phase);
      // (a) red when the drive asked the model anything; (b) prints the calls.
      expect(llm.callStep).not.toHaveBeenCalled();
    },
    15_000,
  );

  it('C159 control: a question whose time is not up is announced as before, and the answer it gets is recorded', async () => {
    const def = gated('settle_default');
    const { store, runId, gateId } = await atQuestion(def, false);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const gateHandler = vi.fn(async () => {
      await submitHumanResponse(store, def, { runId, gateId, choice: 'ship' });
    });
    await runAgent(
      {
        store,
        workflowStore: workflowStore(def),
        provider: provider(),
        registry: createDefaultRegistry(),
        gateHandler,
      },
      { definition: def, existingRunId: runId, params: {} },
    );
    const out = logSpy.mock.calls.map((c) => String(c[0]));
    // (a) red when a live question is no longer announced, or is carried out as if expired; (b)
    //     prints what the drive printed.
    expect(out).toContain(`\n⏸  Gate: review | ID: ${gateId}`);
    expect(gateHandler).toHaveBeenCalledTimes(1);
    expect(out.filter((l) => l.includes('had expired'))).toEqual([]);
    expect((await store.get(runId)).settled?.['review']).toMatchObject({ choice: 'ship' });
  }, 15_000);
});
