// slack-answerers-603.test.ts — #603 A3a: in Slack, a question that names who may answer is
// answered only by them. Acceptance checks 1–7, 9–11 and 14, against the test copy of Slack the
// suite already uses (the stubbed `fetch`; a reply reaches the notifier through the captured event
// callback), on a real store and the real engine. The attending timer is stopped.
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  executeStep,
  submitHumanResponse,
  type GateConfig,
  type PendingGate,
  type RunStore,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { handleBidirectionalGate, postGateViaApi } from './slack-gate-notifier.js';
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

const THREAD = '1234567890.000';
const W1 = (who: string): string =>
  `Not recorded: only ${who} can answer this question. Your reply changed nothing.`;
const W2 = "Not recorded: this question can't be answered in Slack. Your reply changed nothing.";

function gated(id: string, gate: Partial<GateConfig>): WorkflowDefinition {
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
        gate: { choices: ['approve', 'reject'], ...gate },
      },
    },
  };
}

describe('#603 A3a — who may answer a question in its Slack thread', () => {
  let h: TempHome;
  let store: RunStore;
  let fetchSpy: ReturnType<typeof vi.fn>;
  let logs: string[];
  let warns: string[];

  beforeEach(async () => {
    h = await makeTempHome();
    store = h.home.runStore;
    fetchSpy = vi.fn().mockResolvedValue(slackResponse({ json: { ok: true } }));
    vi.stubGlobal('fetch', fetchSpy);
    logs = [];
    warns = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logs.push(a.join(' ')));
    vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => void warns.push(a.join(' ')));
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

  /** Slack's calls to one method, each body as sent. */
  const calls = (method: string): Array<Record<string, unknown>> =>
    fetchSpy.mock.calls
      .filter(([url]) => String(url).endsWith(method))
      .map(([, init]) => JSON.parse((init as { body: string }).body) as Record<string, unknown>);
  const privately = (): Array<Record<string, unknown>> => calls('chat.postEphemeral');
  const posts = (): string[] => calls('chat.postMessage').map((b) => String(b['text']));

  /** Attends the thread; returns the way to send a reply and the wait itself. */
  function attend(
    def: WorkflowDefinition,
    runId: string,
    gate: PendingGate,
    projectAnswerers?: string[],
  ) {
    let onEvent: ((event: SlackGateEvent) => void) | undefined;
    vi.mocked(startSlackGateServer).mockImplementationOnce((o) => {
      onEvent = o.onEvent;
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
      gateThreadTs: THREAD,
      slackSigningSecret: 'secret',
      slackEventsPort: 3100,
      gateReminderIntervalMs: 999_999,
      gateEscalationThresholdMs: 999_999,
      pollIntervalMs: 0,
      ...(projectAnswerers !== undefined ? { projectAnswerers } : {}),
    });
    if (onEvent === undefined) throw new Error('fixture: no event handler');
    let n = 0;
    const reply = (user: string, text: string): void =>
      onEvent!({ event_id: `E${++n}`, thread_ts: THREAD, user, text, ts: `1.${n}`, team: 'T1' });
    return { reply, waiting };
  }

  /** The answer's entry on the record: how it was let through, and the account Slack reported. */
  async function recorded(runId: string) {
    const { record } = await store.get(runId);
    const entry = record.evidence.find((e) => e.kind === 'gate_response');
    const answer = entry?.answer;
    return {
      admitted_by: entry?.admitted_by,
      account: answer !== undefined && 'route' in answer ? answer.channel_evidence : undefined,
      open: record.pending_gate !== undefined,
    };
  }

  /** Bob's choice is refused privately; then `answer` ends the wait. */
  async function refusedThen(
    def: WorkflowDefinition,
    refusedUser: string,
    then: (t: {
      runId: string;
      gate: PendingGate;
      reply: (u: string, x: string) => void;
    }) => Promise<void>,
    projectAnswerers?: string[],
  ) {
    const { runId, gate } = await openQuestion(def);
    const { reply, waiting } = attend(def, runId, gate, projectAnswerers);
    const before = (await store.get(runId)).record.version;
    reply(refusedUser, 'approve');
    await vi.waitFor(() => expect(privately()).toHaveLength(1));
    const after = await store.get(runId);
    const refusal = {
      moved: after.record.version !== before,
      open: after.record.pending_gate !== undefined,
    };
    await then({ runId, gate, reply });
    await waiting;
    return { runId, refusal, privately: privately(), posts: posts() };
  }

  it('check 1: owner U0ALICE — Bob is refused privately and nothing is written; then Alice’s reply settles it', async () => {
    const def = gated('a3a-1', { owner: 'U0ALICE' });
    const r = await refusedThen(def, 'U0BOB', async ({ reply }) => reply('U0ALICE', 'approve'));
    // (1) red when the check is removed (Bob's reply settles it); (2) prints what was written, said
    //     privately and posted, and what the answer recorded.
    expect({
      refusal: r.refusal,
      privately: r.privately,
      couldNotRecord: r.posts.some((p) => p.includes("Couldn't record")),
      ...(await recorded(r.runId)),
    }).toEqual({
      refusal: { moved: false, open: true },
      privately: [{ channel: 'C123', user: 'U0BOB', thread_ts: THREAD, text: W1('<@U0ALICE>') }],
      couldNotRecord: false,
      admitted_by: 'owner',
      account: { team: 'T1', user: 'U0ALICE', ts: '1.2', thread_ts: THREAD },
      open: false,
    });
  });

  it('check 2: owner written as the mention <@U0ALICE> — Alice’s reply counts', async () => {
    const def = gated('a3a-2', { owner: '<@U0ALICE>' });
    const { runId, gate } = await openQuestion(def);
    const { reply, waiting } = attend(def, runId, gate);
    reply('U0ALICE', 'approve');
    await waiting;
    // (1) red when only the bare form is compared; (2) prints what the answer recorded.
    expect({ privately: privately(), ...(await recorded(runId)) }).toMatchObject({
      privately: [],
      admitted_by: 'owner',
      open: false,
    });
  });

  it('check 3: answerers [U1, U2] — U3 is refused naming both; U2 counts', async () => {
    const def = gated('a3a-3', { answerers: ['U1', 'U2'] });
    const r = await refusedThen(def, 'U3', async ({ reply }) => reply('U2', 'approve'));
    // (1) red when `answerers` is ignored (U3's reply counts); (2) prints the private reply and the
    //     record.
    expect({
      privately: r.privately.map((b) => b['text']),
      ...(await recorded(r.runId)),
    }).toMatchObject({
      privately: [W1('<@U1> or <@U2>')],
      admitted_by: 'answerers',
      open: false,
    });
  });

  it('check 4: owner U0ALICE with the project’s answerers [U9] — U9 is refused, naming the owner only', async () => {
    const def = gated('a3a-4', { owner: 'U0ALICE' });
    const r = await refusedThen(def, 'U9', async ({ reply }) => reply('U0ALICE', 'approve'), [
      'U9',
    ]);
    // (1) red when the project's list is added to the question's names; (2) prints the private reply.
    expect(r.privately.map((b) => b['text'])).toEqual([W1('<@U0ALICE>')]);
  });

  it('check 5: owner @ana — closed in Slack: the post says so, realm agent says so, U9 is told privately, and realm run respond answers it', async () => {
    const def = gated('a3a-5', { owner: '@ana' });
    const r = await refusedThen(
      def,
      'U9',
      async ({ runId, gate }) => {
        const answered = await submitHumanResponse(store, def, {
          runId,
          gateId: gate.gate_id,
          choice: 'approve',
          route: 'cli',
          caller: 'respond',
        });
        if (answered.status !== 'ok') throw new Error(`fixture: ${answered.status}`);
      },
      ['U9'],
    );
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(slackResponse({ json: { ok: true, ts: '9.9' } })),
    );
    const { gate } = await openQuestion(def);
    await postGateViaApi('xoxb-test', 'C123', gate, 'r5', true);
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0]![1] as { body: string }).body) as {
      blocks: Array<{ text?: { text: string } }>;
    };
    // (1) red when a non-id owner falls through to the project's list or to anyone (U9's reply
    //     counts), when the post keeps "Reply in this thread", or when no console line is printed;
    //     (2) prints the private reply, the route block, the console lines and the record.
    expect({
      privately: r.privately.map((b) => b['text']),
      route: body.blocks[2]?.text?.text.split('\n')[0],
      agentLine: logs.includes(
        "Slack: no one gate 'confirm' names is a Slack member ID, so replies in its thread are not counted.",
      ),
      ...(await recorded(r.runId)),
    }).toEqual({
      privately: [W2],
      route:
        'Replies in this thread are not counted: no one this question names is a Slack member ID. Answer it from a terminal:',
      agentLine: true,
      admitted_by: 'owner_not_checked_on_route',
      account: undefined,
      open: false,
    });
  });

  it('check 6: the project’s answerers [U9], nothing named on the question — U8 is refused; U9 counts', async () => {
    const def = gated('a3a-6', {});
    const r = await refusedThen(def, 'U8', async ({ reply }) => reply('U9', 'approve'), ['U9']);
    // (1) red when the door does not pass the project's list (U8's reply counts); (2) prints the
    //     private reply and the record.
    expect({
      privately: r.privately.map((b) => b['text']),
      ...(await recorded(r.runId)),
    }).toMatchObject({
      privately: [W1('<@U9>')],
      admitted_by: 'project_answerers',
      open: false,
    });
  });

  it('check 7: nothing named and no project list — anyone’s reply counts', async () => {
    const def = gated('a3a-7', {});
    const { runId, gate } = await openQuestion(def);
    const { reply, waiting } = attend(def, runId, gate);
    reply('U8', 'approve');
    await waiting;
    // (1) red when a reply is refused although nothing is named; (2) prints the record.
    expect({ privately: privately(), ...(await recorded(runId)) }).toMatchObject({
      privately: [],
      admitted_by: 'no_named_answerer',
      open: false,
    });
  });

  it('check 9: Bob’s other message gets nothing and uses no clarification; Alice’s gets one', async () => {
    const def = gated('a3a-9', { owner: 'U0ALICE' });
    const { runId, gate } = await openQuestion(def);
    const { reply, waiting } = attend(def, runId, gate);
    reply('U0BOB', 'what does this mean?');
    reply('U0BOB', 'and this?');
    reply('U0ALICE', 'what does this mean?');
    await vi.waitFor(() => expect(posts()).toHaveLength(1));
    await submitHumanResponse(store, def, {
      runId,
      gateId: gate.gate_id,
      choice: 'approve',
      route: 'cli',
      caller: 'respond',
    });
    await waiting;
    // (1) red when the door counts anyone's message (Bob's two use up the clarifications, Alice's
    //     gets none); (2) prints the thread's posts and the private replies.
    expect({ first: posts()[0], privately: privately() }).toEqual({
      first: 'Please reply with one of: approve, reject',
      privately: [],
    });
  });

  it('check 10: Bob’s reply after the question’s time is up carries out the expiry, not the refusal', async () => {
    const def = gated('a3a-10', { owner: 'U0ALICE', timeout_seconds: 3600, on_expiry: 'abort' });
    const { runId, gate } = await openQuestion(def);
    const { record } = await store.get(runId);
    await store.update({
      ...record,
      pending_gate: { ...record.pending_gate!, expires_at: '2020-01-01T01:00:00.000Z' },
    });
    const { reply, waiting } = attend(def, runId, gate);
    reply('U0BOB', 'approve');
    await waiting;
    const after = (await store.get(runId)).record;
    // (1) red when the check runs before the due-expiry check (Bob is refused, the run stays
    //     waiting); (2) prints the private replies and the run's ending.
    expect({
      privately: privately(),
      ended: after.terminal_state,
      expired: Object.values(after.skip_details ?? {}).some((d) => d.kind === 'gate_expired'),
    }).toEqual({ privately: [], ended: true, expired: true });
  });

  it.each([
    [
      'Slack answers an error',
      () => Promise.resolve(slackResponse({ json: { ok: false, error: 'ratelimited' } })),
      'ratelimited',
    ],
    [
      'Slack cannot be reached',
      () => Promise.reject(new Error('getaddrinfo ENOTFOUND slack.com')),
      'getaddrinfo ENOTFOUND slack.com',
    ],
  ])(
    'check 11: the private reply fails (%s) — a console line, and the question stays open',
    async (_label, fail, cause) => {
      fetchSpy.mockImplementation((url: string) =>
        String(url).endsWith('chat.postEphemeral')
          ? fail()
          : Promise.resolve(slackResponse({ json: { ok: true } })),
      );
      const def = gated('a3a-11', { owner: 'U0ALICE' });
      const r = await refusedThen(def, 'U0BOB', async ({ reply }) => reply('U0ALICE', 'approve'));
      // (1) red when the failure is swallowed without the line; (2) prints the console's warnings.
      expect({
        line: warns.includes(
          `Slack: could not tell U0BOB privately that their reply to gate 'confirm' was not recorded: ${cause}.`,
        ),
        openAfterBob: r.refusal.open,
      }).toEqual({ line: true, openAfterBob: true });
    },
  );

  it('check 14: a bare member ID owner is shown as a mention in the post, so it pings', async () => {
    const def = gated('a3a-14', { owner: 'U0ALICE' });
    const { gate } = await openQuestion(def);
    fetchSpy.mockResolvedValue(slackResponse({ json: { ok: true, ts: '9.9' } }));
    await postGateViaApi('xoxb-test', 'C123', gate, 'r14', true);
    const body = calls('chat.postMessage')[0] as { blocks: Array<{ text?: { text: string } }> };
    // (1) red when the bare ID is escaped as before; (2) prints the post's first block.
    expect(body.blocks[0]?.text?.text).toBe('*Gate:* `confirm`\n*Owner:* <@U0ALICE>');
  });
});
