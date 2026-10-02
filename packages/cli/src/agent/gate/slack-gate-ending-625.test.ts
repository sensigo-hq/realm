// slack-gate-ending-625.test.ts — issue #625 (PR-1): what the Slack notifier posts after an
// answer whose own write settled a guard.
//
// The answer's write settles the guards it makes eligible, and one of them may END the run. The
// authored resolution message (and the default's "run continuing") is posted only when the
// answer did not end the run; when it did, the post is the ending — the guard's sentence, its
// reason, each cleanup step's outcome.
//
// A real store and the real engine: the gate is opened by `executeStep`, the Slack reply reaches
// the notifier through the captured event callback, and the post is read off the stubbed `fetch`.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  JsonFileStore,
  executeStep,
  deriveRunPhase,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
} from '@sensigo/realm';
import type { PendingGate, StepDefinition, WorkflowDefinition } from '@sensigo/realm';
import { handleBidirectionalGate } from './slack-gate-notifier.js';
import { startSlackGateServer } from './slack-gate-server.js';
import type { SlackGateEvent } from './slack-gate-server.js';
import { LlmProvider } from '../providers/llm-provider.js';

vi.mock('./slack-gate-server.js', () => ({
  startSlackGateServer: vi.fn().mockReturnValue({ close: vi.fn() }),
}));
vi.mock('./slack-socket-client.js', () => ({
  connectSocketMode: vi.fn().mockReturnValue({ close: vi.fn() }),
}));

const AUTHORED = {
  approve: 'Approved — the run continues.',
  reject: 'Rejected — thanks, nothing further happens.',
};
const NOT_APPROVED = 'Not approved — stopping the run.';

/** gate `confirm` → guard `check` (aborts unless approved) [→ agent step `finish`]. */
function gateThenGuard(id: string, more?: Record<string, StepDefinition>): WorkflowDefinition {
  return {
    id,
    name: id,
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps: {
      confirm: {
        description: 'Confirm',
        execution: 'auto',
        trust: 'human_confirmed',
        depends_on: [],
        gate: { choices: ['approve', 'reject'], resolution_messages: AUTHORED },
      },
      check: {
        description: 'Check',
        execution: 'guard',
        depends_on: ['confirm'],
        abort_unless: ["confirm.choice == 'approve'"],
        abort_message: NOT_APPROVED,
      },
      ...more,
    },
  };
}

describe('issue #625 — the Slack notifier after an answer whose write settled a guard', () => {
  let dir: string;
  let store: JsonFileStore;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'realm-625-slack-'));
    store = new JsonFileStore(dir);
    fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchSpy);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Opens the gate through the engine and returns the frozen gate the notifier is handed. */
  async function openGate(def: WorkflowDefinition): Promise<{ runId: string; gate: PendingGate }> {
    const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
    const opened = await executeStep(store, def, {
      runId: run.id,
      command: 'confirm',
      input: {},
      dispatcher: async () => ({}),
    });
    if (opened.status !== 'confirm_required') {
      throw new Error(`fixture: the gate did not open (status ${opened.status})`);
    }
    return { runId: run.id, gate: (await store.get(run.id)).pending_gate! };
  }

  /** Answers the gate from the Slack thread and returns the text of every thread reply posted. */
  async function answerInThread(
    def: WorkflowDefinition,
    runId: string,
    gate: PendingGate,
    text: string,
  ): Promise<string[]> {
    let onEvent: ((event: SlackGateEvent) => void) | undefined;
    vi.mocked(startSlackGateServer).mockImplementationOnce((opts) => {
      onEvent = opts.onEvent;
      return { close: vi.fn() };
    });
    const waiting = handleBidirectionalGate({
      gate,
      runId,
      definition: def,
      store,
      provider: new (class extends LlmProvider {
        callStep = vi.fn();
      })(),
      slackBotToken: 'xoxb-test',
      slackChannelId: 'C123',
      gateThreadTs: '1234567890.000',
      slackSigningSecret: 'secret',
      slackEventsPort: 3100,
      gateReminderIntervalMs: 999_999,
      gateEscalationThresholdMs: 999_999,
      pollIntervalMs: 0,
    });
    if (onEvent === undefined) throw new Error('fixture: the notifier registered no event handler');
    onEvent({
      event_id: 'E1',
      thread_ts: '1234567890.000',
      user: 'U1',
      text,
      ts: '1234567890.001',
    });
    await waiting;
    return fetchSpy.mock.calls
      .filter(([url]) => String(url).includes('postMessage'))
      .map(([, init]) => (JSON.parse((init as { body: string }).body) as { text: string }).text);
  }

  it('the answer ENDED the run (the guard aborted): the post is the ending and its Reason — never the authored resolution message', async () => {
    const def = gateThenGuard('slack-625-abort');
    const { runId, gate } = await openGate(def);

    const posts = await answerInThread(def, runId, gate, 'reject');

    // (a) red when the notifier posts the authored resolution message (or "run continuing")
    //     over a run the answer's guard aborted; (b) prints every thread reply posted.
    expect(posts).toEqual([
      [
        'Gate resolved: `reject`.',
        "Guard step 'check' aborted the run.",
        `Reason: ${NOT_APPROVED}`,
      ].join('\n'),
    ]);
    // (a) red when the answer's write did not settle the guard; (b) prints the derived phase.
    expect(deriveRunPhase(await store.get(runId))).toBe('aborted');
  });

  it('the answer ENDED the run (the guard passed and completed it): the post says the run completed', async () => {
    const def = gateThenGuard('slack-625-complete');
    const { runId, gate } = await openGate(def);

    const posts = await answerInThread(def, runId, gate, 'approve');

    // (a) red when the authored "the run continues" is posted for a run the answer completed, or
    //     a Reason line is invented for a completing pass; (b) prints every thread reply posted.
    expect(posts).toEqual([
      ['Gate resolved: `approve`.', "Guard step 'check' passed and completed the run."].join('\n'),
    ]);
    expect(deriveRunPhase(await store.get(runId))).toBe('completed');
  });

  it('the guard PASSED and the run goes on: the authored resolution message, unchanged', async () => {
    const def = gateThenGuard('slack-625-pass', {
      finish: { description: 'Finish', execution: 'agent', depends_on: ['check'] },
    });
    const { runId, gate } = await openGate(def);

    const posts = await answerInThread(def, runId, gate, 'approve');

    // The control. (a) red when a guard that merely passed changes the Slack post;
    //     (b) prints every thread reply posted.
    expect(posts).toEqual([AUTHORED.approve]);
    // (a) red when the guard was not settled by the answer's write; (b) prints the completed
    //     steps.
    expect((await store.get(runId)).completed_steps).toEqual(['confirm', 'check']);
  });
});
