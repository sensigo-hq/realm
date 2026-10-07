// slack-gate-late-625.test.ts — issue #625 PR-2a, decision C146 (the architect's follow-up to round
// 19): an answer from the Slack thread that came after the question's time was up and carried the
// expiry out itself. The notifier's lines are the composer's (`describeAnswerEnding`, the one
// `realm run respond` and the run prompt print): first `⚠ … this agent call first carried out …`,
// then the refusal or the same-choice sentence, then what the expiry's guards did — posted to the
// thread once and printed to the terminal once, and nothing says to try again.
//
// The attending timer is stopped here (`scheduleGateExpiryTimer` returns a cancel and never fires),
// so the answer reaches the expired question before the timer does — the race the timer otherwise
// usually wins (see the round-19 report's follow-up for the unstubbed runs). A real store and the
// real engine; the Slack reply reaches the notifier through the captured event callback, the posts
// are read off the stubbed `fetch`.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonFileStore, executeStep, expiryCarriedOutLine } from '@sensigo/realm';
import type { PendingGate, RunRecord, WorkflowDefinition } from '@sensigo/realm';
import { handleBidirectionalGate } from './slack-gate-notifier.js';
import { startSlackGateServer } from './slack-gate-server.js';
import type { SlackGateEvent } from './slack-gate-server.js';
import { scheduleGateExpiryTimer } from './gate-expiry-timer.js';
import { LlmProvider } from '../providers/llm-provider.js';

/** C163: (a) red when gates.md no longer holds the sentence these cells pin, word for word; (b) prints it. */
const GATES_MD_215 = `an answer that came after the time was up and carried the expiry out prints it first too, before its refusal or the sentence that says it was not recorded — through \`realm run respond\` (\`this respond call …\`), the prompt of \`realm workflow run\` (\`this run call …\`) or a reply in the gate's Slack thread to \`realm agent\` (\`this agent call …\`, posted in the thread).`;
function claimGates215(): void {
  const page = readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      '../../../../../docs/reference/workflow/gates.md',
    ),
    'utf8',
  ).replace(/\s+/g, ' ');
  expect(page, `gates.md no longer says: ${GATES_MD_215}`).toContain(GATES_MD_215);
}

vi.mock('./slack-gate-server.js', () => ({
  startSlackGateServer: vi.fn().mockReturnValue({ close: vi.fn() }),
}));
vi.mock('./slack-socket-client.js', () => ({
  connectSocketMode: vi.fn().mockReturnValue({ close: vi.fn() }),
}));
vi.mock('./gate-expiry-timer.js', () => ({
  scheduleGateExpiryTimer: vi.fn(() => (): void => {}),
}));

/** `confirm` (a question, `on_expiry` as given, default `approve`), then `check`, a guard, and `finish`. */
function gated(id: string, onExpiry: 'settle_default' | 'abort'): WorkflowDefinition {
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
          timeout_seconds: 3600,
          on_expiry: onExpiry,
          ...(onExpiry === 'settle_default' ? { default_choice: 'approve' } : {}),
        },
      },
      check: {
        description: 'Check',
        execution: 'guard',
        depends_on: ['confirm'],
        abort_unless: ["confirm.choice == 'approve'"],
        abort_message: 'Not approved.',
      },
      finish: { description: 'Finish', execution: 'agent', depends_on: ['check'] },
    },
  };
}

describe('#625 PR-2a, C146 — a late Slack answer that carried out the expiry says so, once, in the thread and the terminal', () => {
  let dir: string;
  let store: JsonFileStore;
  let fetchSpy: ReturnType<typeof vi.fn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'realm-625-slack-late-'));
    store = new JsonFileStore(dir);
    fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchSpy);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Opens the question, moves its expiry into the past, and returns the gate the notifier gets. */
  async function expiredQuestion(
    def: WorkflowDefinition,
  ): Promise<{ runId: string; gate: PendingGate }> {
    const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
    const opened = await executeStep(store, def, {
      runId: run.id,
      command: 'confirm',
      input: {},
      dispatcher: async () => ({}),
    });
    if (opened.status !== 'confirm_required') throw new Error(`fixture: ${opened.status}`);
    const record: RunRecord = await store.get(run.id);
    const moved = await store.update({
      ...record,
      pending_gate: {
        ...record.pending_gate!,
        opened_at: '2020-01-01T00:00:00.000Z',
        expires_at: '2020-01-01T01:00:00.000Z',
      },
    });
    return { runId: run.id, gate: moved.pending_gate! };
  }

  /** Answers in the thread; returns every thread reply posted and every terminal line. */
  async function answerInThread(
    def: WorkflowDefinition,
    runId: string,
    gate: PendingGate,
    text: string,
  ): Promise<{ posts: string[]; printed: string[] }> {
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
    return {
      posts: fetchSpy.mock.calls
        .filter(([url]) => String(url).includes('postMessage'))
        .map(([, init]) => (JSON.parse((init as { body: string }).body) as { text: string }).text),
      printed: logSpy.mock.calls.map((c: unknown[]) => String(c[0])),
    };
  }

  /** What the notifier prints before any answer (unchanged by this decision). */
  const WAITING = '   Waiting for approval...';

  const line = (
    gateId: string,
    did: { on_expiry: 'settle_default'; choice: string } | { on_expiry: 'abort' },
  ): string => `⚠ ${expiryCarriedOutLine(gateId, 'confirm', did, 'agent')}`;

  it('C146: another choice — `⚠ … this agent call first carried out …`, the refusal, the guard; posted once and printed once, no "try again"', async () => {
    claimGates215();
    const def = gated('slack-late-other', 'settle_default');
    const { runId, gate } = await expiredQuestion(def);

    const { posts, printed } = await answerInThread(def, runId, gate, 'reject');

    const lines = [
      line(gate.gate_id, { on_expiry: 'settle_default', choice: 'approve' }),
      `Gate '${gate.gate_id}' was settled by timeout with choice 'approve' — your choice 'reject' was not recorded.`,
      "Guard step 'check' passed.",
    ];
    // (a) red when the notifier drops the line, names another call, or posts "Couldn't record your
    //     response … Try again" for a gate the expiry settled; (b) prints the posts.
    expect(posts).toEqual([lines.join('\n')]);
    // (a) red when the terminal does not get the same lines, or gets the line twice; (b) prints them.
    expect(printed).toEqual([WAITING, ...lines]);
    expect(vi.mocked(scheduleGateExpiryTimer)).toHaveBeenCalledTimes(1);
  });

  it('C146: the same choice — the line, then the same-choice sentence; posted once and printed once', async () => {
    claimGates215();
    const def = gated('slack-late-same', 'settle_default');
    const { runId, gate } = await expiredQuestion(def);

    const { posts, printed } = await answerInThread(def, runId, gate, 'approve');

    const lines = [
      line(gate.gate_id, { on_expiry: 'settle_default', choice: 'approve' }),
      'the outcome matches your choice, but it was settled by timeout; your response was not recorded.',
      "Guard step 'check' passed.",
    ];
    // (a) red when the same-choice answer posts "Gate resolved … run continuing" as if recorded, or
    //     drops the line; (b) prints the posts.
    expect(posts).toEqual([lines.join('\n')]);
    expect(printed).toEqual([WAITING, ...lines]);
  });

  it('C146: abort — the line (`… its declared abort: the run ended …`), then the refusal; posted once and printed once', async () => {
    claimGates215();
    const def = gated('slack-late-abort', 'abort');
    const { runId, gate } = await expiredQuestion(def);

    const { posts, printed } = await answerInThread(def, runId, gate, 'approve');

    const lines = [
      line(gate.gate_id, { on_expiry: 'abort' }),
      `Gate '${gate.gate_id}' on 'confirm' expired and the run aborted per the workflow's declared on_expiry — your choice was NOT recorded.`,
    ];
    // (a) red when the abort's refusal is posted as a submit failure to retry; (b) prints the posts.
    expect(posts).toEqual([lines.join('\n')]);
    expect(printed).toEqual([WAITING, ...lines]);
  });
});
