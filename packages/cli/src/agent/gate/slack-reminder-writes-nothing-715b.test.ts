// slack-reminder-writes-nothing-715b.test.ts — issue #715 (b) 02 §D.3 (D6-21) with Amendment 9: the
// basis clause the `inspect`/`list` reminder views print — "no send is recorded; reminders are sent
// only while a process attends this question" — is TRUE by execution: the process attending the
// question (`realm agent`'s Slack gate handler) posts its reminders and writes NOTHING to the run
// record for them. Real timers: an authored reminder every second, three of them.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { executeStep, submitHumanResponse, type RunStore } from '@sensigo/realm';
import type { WorkflowDefinition } from '@sensigo/realm';
import { handleBidirectionalGate } from './slack-gate-notifier.js';
import { LlmProvider } from '../providers/llm-provider.js';
import { slackResponse } from '../test-support/slack-response.js';
import { makeTempHome, type TempHome } from '../../test-support/temp-home.js';

vi.mock('./slack-gate-server.js', () => ({
  startSlackGateServer: vi.fn().mockReturnValue({ close: vi.fn() }),
}));
vi.mock('./slack-socket-client.js', () => ({
  connectSocketMode: vi.fn().mockReturnValue({ close: vi.fn() }),
}));
vi.mock('./gate-expiry-timer.js', () => ({
  scheduleGateExpiryTimer: vi.fn(() => (): void => {}),
}));

const DEF: WorkflowDefinition = {
  id: 'reminders-715b',
  name: 'reminders-715b',
  version: 1,
  steps: {
    confirm: {
      description: 'Confirm',
      execution: 'auto',
      trust: 'human_confirmed',
      depends_on: [],
      gate: { choices: ['approve', 'reject'], reminder_seconds: 1, reminder_max: 3 },
    },
  },
} as WorkflowDefinition;

describe('#715 (b) §D.3 — a reminder send writes nothing to the run', () => {
  let h: TempHome;
  let store: RunStore;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    h = await makeTempHome();
    store = h.home.runStore;
    fetchSpy = vi.fn().mockResolvedValue(slackResponse({ json: { ok: true } }));
    vi.stubGlobal('fetch', fetchSpy);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await h.cleanup();
  });

  it('the attending process posts its reminders; the run record is unchanged by them', async () => {
    // (a) red when a reminder send writes to the run (its version or record changes while only
    //     reminders were posted), or no reminder is posted (the cell would prove nothing); (b) prints
    //     the count of reminder posts and whether the record changed.
    const { record: run } = await store.create({
      workflowId: DEF.id,
      workflowVersion: 1,
      params: {},
    });
    const opened = await executeStep(store, DEF, {
      runId: run.id,
      command: 'confirm',
      input: {},
      dispatcher: async () => ({}),
    });
    if (opened.status !== 'confirm_required') throw new Error(`fixture: ${opened.status}`);
    const { record: before } = await store.get(run.id);
    const waiting = handleBidirectionalGate({
      gate: before.pending_gate!,
      runId: run.id,
      definition: DEF,
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
      pollIntervalMs: 50,
    });
    // Three authored reminders, one a second; then read the record before anyone answers.
    await new Promise((resolve) => setTimeout(resolve, 3_400));
    const { record: during } = await store.get(run.id);
    const reminders = fetchSpy.mock.calls
      .filter(([url]) => String(url).includes('postMessage'))
      .map(([, init]) => (JSON.parse((init as { body: string }).body) as { text: string }).text)
      // the reminder's words (`⏰ gate <step> … Please respond.`), the matcher gate-notify-clock uses.
      .filter((text) => text.includes('Please respond.') && !text.includes('expired')).length;
    // Another process answers, so the handler ends.
    await submitHumanResponse(store, DEF, {
      runId: run.id,
      gateId: before.pending_gate!.gate_id,
      choice: 'approve',
      route: 'cli',
    });
    await waiting;
    expect({
      reminders: reminders >= 2,
      recordUnchanged: JSON.stringify(during) === JSON.stringify(before),
    }).toEqual({ reminders: true, recordUnchanged: true });
  }, 15_000);
});
