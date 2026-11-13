// slack-race-receipt-729-pr6a.test.ts — #729 PR-6a (B9, B3's last row): the Slack thread, as
// `realm agent` attends it. A reply inside the listening window that was not recorded and whose reply
// carries an `outcome` gets ONE post, in the people's words through the one sentence-maker — never
// "Try again", never "✅", and no second closing line; a failure a retry can fix still says "Try
// again"; a question answered elsewhere closes with the whole winning answer; a stated name cannot
// ping anyone. Acceptance checks 11–17, against the test copy of Slack the suite already uses (the
// stubbed `fetch`; the reply reaches the notifier through the captured event callback).
//
// A real store and the real engine. The attending timer is stopped (it returns a cancel and never
// fires), so the cells decide which call carries an expiry out.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  executeStep,
  instantText,
  submitHumanResponse,
  WorkflowError,
  type PendingGate,
  type RunStore,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { handleBidirectionalGate } from './slack-gate-notifier.js';
import { startSlackGateServer } from './slack-gate-server.js';
import type { SlackGateEvent } from './slack-gate-server.js';
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

/** `confirm` (a question; a time limit with `on_expiry` when given), then `after` (`auto`). */
function gated(id: string, onExpiry?: 'settle_default' | 'abort'): WorkflowDefinition {
  return {
    id,
    name: id,
    version: 1,
    steps: {
      confirm: {
        description: 'Confirm',
        execution: 'auto',
        trust: 'human_confirmed',
        depends_on: [],
        gate: {
          choices: ['approve', 'reject'],
          ...(onExpiry !== undefined
            ? {
                timeout_seconds: 3600,
                on_expiry: onExpiry,
                ...(onExpiry === 'settle_default' ? { default_choice: 'approve' } : {}),
              }
            : {}),
        },
      },
      after: { description: 'After', execution: 'agent', depends_on: ['confirm'] },
    },
  };
}

describe('#729 PR-6a — the Slack thread tells a reply that was not recorded whose answer stands (B9)', () => {
  let h: TempHome;
  let store: RunStore;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    h = await makeTempHome();
    store = h.home.runStore;
    fetchSpy = vi.fn().mockResolvedValue(slackResponse({ json: { ok: true } }));
    vi.stubGlobal('fetch', fetchSpy);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await h.cleanup();
  });

  async function openQuestion(
    def: WorkflowDefinition,
  ): Promise<{ runId: string; gate: PendingGate }> {
    const { record: run } = await store.create({
      workflowId: def.id,
      workflowVersion: 1,
      params: {},
    });
    const opened = await executeStep(store, def, {
      runId: run.id,
      command: 'confirm',
      input: {},
      dispatcher: async () => ({}),
    });
    if (opened.status !== 'confirm_required') throw new Error(`fixture: ${opened.status}`);
    return { runId: run.id, gate: (await store.get(run.id)).record.pending_gate! };
  }

  /** Alice's answer from a terminal, as `realm run respond --by <name>` sends it; its time. */
  async function terminalAnswer(
    def: WorkflowDefinition,
    runId: string,
    gate: PendingGate,
    by = 'alice',
  ): Promise<string> {
    const r = await submitHumanResponse(store, def, {
      runId,
      gateId: gate.gate_id,
      choice: 'approve',
      respondedBy: by,
      route: 'cli',
      caller: 'respond',
    });
    if (r.status !== 'ok') throw new Error(`fixture: ${r.status}`);
    const { record } = await store.get(runId);
    const entry = record.evidence.find((e) => e.kind === 'gate_response');
    return instantText(Date.parse(entry!.completed_at));
  }

  /** Another call — `realm run drain --expired` — carries the question's expiry out first. */
  async function expiredElsewhere(def: WorkflowDefinition, runId: string, gate: PendingGate) {
    const { record } = await store.get(runId);
    const { record: moved } = await store.update({
      ...record,
      pending_gate: { ...record.pending_gate!, expires_at: '2020-01-01T01:00:00.000Z' },
    });
    const done = await store.settleStep(runId, { kind: 'expire_gate', gateId: gate.gate_id }, def);
    if (!done.applied) throw new Error('fixture: the expiry was not carried out');
    return moved.pending_gate!;
  }

  const posts = (): string[] =>
    fetchSpy.mock.calls
      .filter(([url]) => String(url).includes('postMessage'))
      .map(([, init]) => (JSON.parse((init as { body: string }).body) as { text: string }).text);

  /** Attends the thread; `reply` is posted in it (none: no reply); `during` runs once it is in. */
  async function attend(
    def: WorkflowDefinition,
    runId: string,
    gate: PendingGate,
    reply: string | undefined,
    opts: { store?: RunStore; during?: () => Promise<void> } = {},
  ): Promise<string[]> {
    let onEvent: ((event: SlackGateEvent) => void) | undefined;
    vi.mocked(startSlackGateServer).mockImplementationOnce((o) => {
      onEvent = o.onEvent;
      return { close: vi.fn() };
    });
    const waiting = handleBidirectionalGate({
      gate,
      runId,
      definition: def,
      store: opts.store ?? store,
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
    if (reply !== undefined) {
      onEvent({ event_id: 'E1', thread_ts: '1234567890.000', user: 'U1', text: reply, ts: '1.1' });
    }
    if (opts.during !== undefined) await opts.during();
    await waiting;
    return posts();
  }

  it('check 11: a different choice inside the window after a terminal answer — exactly one post, the beaten-different sentence; no "Try again", no second closing line', async () => {
    const def = gated('pr6a-s11');
    const { runId, gate } = await openQuestion(def);
    const at = await terminalAnswer(def, runId, gate);
    const sent = await attend(def, runId, gate, 'reject');
    // (a) red on today's two posts (`⚠️ … Try again.` and `… answered elsewhere as …`); (b) prints them.
    expect(sent).toEqual([
      `Not recorded: your choice 'reject'. The question on step 'confirm' was already answered — approve, by "alice" (as stated), from a terminal, at ${at}.`,
    ]);
  });

  it('check 12: the same choice inside the window — the beaten-same sentence; never `✅ Gate resolved`', async () => {
    const def = gated('pr6a-s12');
    const { runId, gate } = await openQuestion(def);
    const at = await terminalAnswer(def, runId, gate);
    const sent = await attend(def, runId, gate, 'approve');
    // (a) red on today's `✅ Gate resolved: \`approve\` — run continuing.` for an answer that
    //     recorded nothing; (b) prints the posts.
    expect(sent).toEqual([
      `Not recorded: the question on step 'confirm' already had this answer — approve, by "alice" (as stated), from a terminal, at ${at}.`,
    ]);
  });

  it('check 13: a failure a retry can fix (a busy store) still says "Try again" — the routing, measured with check 11', async () => {
    const def = gated('pr6a-s13');
    const { runId, gate } = await openQuestion(def);
    let busy = true;
    const busyOnce = new Proxy(store, {
      get(target, prop) {
        if (prop === 'settleStep') {
          return async (...a: Parameters<RunStore['settleStep']>) => {
            if (busy && a[1].kind === 'settle_gate') {
              busy = false;
              throw new WorkflowError(
                'The store was busy for 5 s: another writer held it. Nothing was written. Try again.',
                {
                  code: 'STATE_RUN_BUSY',
                  category: 'STATE',
                  agentAction: 'report_to_user',
                  retryable: true,
                },
              );
            }
            return target.settleStep(...a);
          };
        }
        const v = Reflect.get(target, prop, target) as unknown;
        return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(target) : v;
      },
    });
    const sent = await attend(def, runId, gate, 'approve', {
      store: busyOnce,
      // The question stays open after the refused write; a terminal answer then closes it.
      during: async () => {
        const end = Date.now() + 5_000;
        while (posts().length === 0 && Date.now() < end)
          await new Promise((r) => setTimeout(r, 10));
        await terminalAnswer(def, runId, gate);
      },
    });
    // (a) red when a retryable failure is routed to the not-recorded sentence (every not-recorded
    //     reply sent there), or "Try again" is lost; (b) prints the posts.
    expect(sent[0]).toBe("⚠️ Couldn't record your response (`STATE_RUN_BUSY`). Try again.");
  });

  it('check 14: a question answered from a terminal closes with the winner named, the door and the time', async () => {
    const def = gated('pr6a-s14');
    const { runId, gate } = await openQuestion(def);
    const at = await terminalAnswer(def, runId, gate);
    const sent = await attend(def, runId, gate, undefined);
    // (a) red on today's `This question is closed: it was answered elsewhere as \`approve\`.`;
    //     (b) prints the posts.
    expect(sent).toEqual([
      `This question is closed: it was answered — approve, by "alice" (as stated), from a terminal, at ${at}.`,
    ]);
  });

  it('check 15: a stated name of `<!channel> <@U123>` reaches the post escaped, so it pings no one', async () => {
    const def = gated('pr6a-s15');
    const { runId, gate } = await openQuestion(def);
    await terminalAnswer(def, runId, gate, '<!channel> <@U123>');
    const sent = await attend(def, runId, gate, undefined);
    // (a) red when a raw `<` reaches the post (Slack would ping the channel and the user); (b)
    //     prints the post.
    expect({
      escaped: sent[0]?.includes('by "&lt;!channel&gt; &lt;@U123&gt;" (as stated)'),
      raw: sent.some((p) => p.includes('<')),
    }).toEqual({ escaped: true, raw: false });
  });

  it('check 16: a reply inside the window after `drain --expired` carried out `on_expiry: abort` — one post, the time-limit-aborted sentence; no "Try again"', async () => {
    const def = gated('pr6a-s16', 'abort');
    const { runId, gate } = await openQuestion(def);
    const asked = await expiredElsewhere(def, runId, gate);
    const sent = await attend(def, runId, asked, 'approve');
    // (a) red on today's `⚠️ Couldn't record your response (\`STATE_RUN_TERMINAL\`). Try again.`;
    //     (b) prints the posts.
    expect(sent).toEqual([
      "Not recorded: the question on step 'confirm' reached its time limit, and the run ended as aborted.",
    ]);
  });

  it('check 17: a reply after its time limit was carried out with a default choice — one post, the settled-by-time-limit sentence, then ` The run goes on.`', async () => {
    const def = gated('pr6a-s17', 'settle_default');
    const { runId, gate } = await openQuestion(def);
    const asked = await expiredElsewhere(def, runId, gate);
    const sent = await attend(def, runId, asked, 'reject');
    // (a) red on today's `lateWords` line (`This question's time ran out before your reply
    //     arrived; …`); (b) prints the posts.
    expect(sent).toEqual([
      "Not recorded: the question on step 'confirm' reached its time limit, and the run took the default approve. The run goes on.",
    ]);
  });
});
