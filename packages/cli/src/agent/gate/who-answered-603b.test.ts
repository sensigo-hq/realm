// who-answered-603b.test.ts — #603 A3b: the screens name the Slack account that answered, as Slack
// reports it. Acceptance checks 1 (`realm run inspect`'s answer line), 2 (`realm run respond`'s
// sentence for a later answer), 3 (the thread's receipt, its three forms, and the post's closing-line
// edit), 4 (an account that cannot be shown, on every line), 5 (another route's account) and 6 (an
// answer written before A3a: the corpus's 0.49.0 run, every line as before).
//
// Slack is the test copy the suite already uses (the stubbed `fetch`; a reply reaches the notifier
// through the captured event callback), on a real store and the real engine; the commands are the
// built CLI on that store's home. Each assertion carries (1) the break that turns it red and (2)
// what it prints when it fails.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  UNSHOWABLE_NAME,
  answerArrivalOf,
  composeStepViews,
  executeStep,
  instantText,
  submitHumanResponse,
  type AnswerView,
  type GateConfig,
  type PendingGate,
  type RunRecord,
  type RunStore,
  type SubmitGateOptions,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { handleBidirectionalGate } from './slack-gate-notifier.js';
import { startSlackGateServer } from './slack-gate-server.js';
import type { SlackGateEvent } from './slack-gate-server.js';
import { LlmProvider } from '../providers/llm-provider.js';
import { slackResponse } from '../test-support/slack-response.js';
import { makeTempHome, type TempHome } from '../../test-support/temp-home.js';
import { renderAnswerLine } from '../../lib/holder-render.js';
import { answererClause } from '../../commands/respond.js';

vi.mock('./slack-gate-server.js', () => ({
  startSlackGateServer: vi.fn().mockReturnValue({ close: vi.fn() }),
}));
vi.mock('./slack-socket-client.js', () => ({
  connectSocketMode: vi.fn().mockReturnValue({ close: vi.fn() }),
}));
vi.mock('./gate-expiry-timer.js', () => ({
  scheduleGateExpiryTimer: vi.fn(() => (): void => {}),
}));

const CLI = fileURLToPath(new URL('../../../dist/index.js', import.meta.url));
const THREAD = '1234567890.000';

/**
 * `confirm` (a question; owned by U0ALICE unless `gate` says otherwise), then an agent step `after`
 * (the run goes on), or, with `ends`, a guard that completes the run once `approve` is answered.
 */
function gated(
  id: string,
  gate: Partial<GateConfig> = { owner: 'U0ALICE' },
  ends = false,
): WorkflowDefinition {
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
        gate: { choices: ['approve', 'reject'], ...gate },
      },
      ...(ends
        ? {
            check: {
              description: 'Check',
              execution: 'guard' as const,
              depends_on: ['confirm'],
              abort_unless: ["confirm.choice == 'approve'"],
            },
          }
        : {
            after: { description: 'After', execution: 'agent' as const, depends_on: ['confirm'] },
          }),
    },
  };
}

describe('#603 A3b — the screens name the Slack account that answered', { timeout: 60_000 }, () => {
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
    await h.home.workflowStore.register(def);
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
  const posts = (): string[] => calls('chat.postMessage').map((b) => String(b['text']));

  /** Alice's reply `approve` in the question's thread, as Slack delivers it; the wait ends. */
  async function aliceInSlack(
    def: WorkflowDefinition,
  ): Promise<{ runId: string; gate: PendingGate }> {
    const { runId, gate } = await openQuestion(def);
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
    });
    if (onEvent === undefined) throw new Error('fixture: no event handler');
    onEvent({
      event_id: 'E1',
      thread_ts: THREAD,
      user: 'U0ALICE',
      text: 'approve',
      ts: '1.1',
      team: 'T1',
    });
    await waiting;
    return { runId, gate };
  }

  /** The built CLI on this home. */
  const realm = (args: string[]) => {
    const r = spawnSync(process.execPath, [CLI, ...args], {
      env: { PATH: process.env['PATH'] ?? '', HOME: h.root },
      encoding: 'utf8',
      timeout: 60_000,
    });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  const answerLine = (runId: string): string | undefined =>
    realm(['run', 'inspect', runId])
      .out.split('\n')
      .find((l) => l.trim().startsWith('Answer: '))
      ?.trim();
  /** When the record says the answer was given, as the sentences print it. */
  const givenAt = async (runId: string): Promise<string> => {
    const entry = (await store.get(runId)).record.evidence.find((e) => e.kind === 'gate_response');
    return instantText(Date.parse(entry!.completed_at));
  };

  it('checks 1 and 3: Alice answers in Slack — the receipt, the post’s closing line and `realm run inspect` name U0ALICE (as Slack reports it)', async () => {
    const { runId } = await aliceInSlack(gated('a3b-1'));
    const at = await givenAt(runId);
    const update = calls('chat.update').map((b) => String(b['text']));
    // (1) red when the receipt builds its own "by" part or none, the closing line ignores the
    //     account, or the view does not read `channel_evidence` (inspect says "(not stated)"); (2)
    //     prints the receipt, the edit and the answer line.
    expect({
      receipt: posts().filter((p) => p.startsWith('✅')),
      update,
      inspect: answerLine(runId)?.split(' · ').slice(0, 2).join(' · '),
    }).toEqual({
      receipt: ['✅ Gate resolved: `approve`, by U0ALICE (as Slack reports it) — run continuing.'],
      update: [
        `This question is closed: it was answered — approve, by U0ALICE (as Slack reports it), in a Slack thread, at ${at}.`,
      ],
      inspect: 'Answer: approve · answered by U0ALICE (as Slack reports it)',
    });
  });

  it('check 3: the receipt’s other two forms carry the same "by" part — the run ended, and a resolution message', async () => {
    const ended = await aliceInSlack(gated('a3b-3-ended', { owner: 'U0ALICE' }, true));
    const endedReceipt = posts().filter((p) => p.startsWith('✅'));
    fetchSpy.mockClear();
    await aliceInSlack(
      gated('a3b-3-message', {
        owner: 'U0ALICE',
        resolution_messages: { approve: 'Recorded: approve.' },
      }),
    );
    // (1) red when a form leaves the "by" part out; (2) prints both receipts.
    expect({
      ended: endedReceipt,
      message: posts().filter((p) => p.startsWith('✅')),
      runEnded: (await store.get(ended.runId)).record.terminal_state,
    }).toEqual({
      ended: ['✅ Gate resolved: `approve`, by U0ALICE (as Slack reports it). The run has ended.'],
      message: [
        '✅ Gate resolved: `approve`, by U0ALICE (as Slack reports it)\nRecorded: approve.',
      ],
      runEnded: true,
    });
  });

  it('check 2: `realm run respond` after Alice’s Slack answer — the sentence names U0ALICE (as Slack reports it)', async () => {
    const { runId, gate } = await aliceInSlack(gated('a3b-2'));
    const at = await givenAt(runId);
    const r = realm(['run', 'respond', runId, '--gate', gate.gate_id, '--choice', 'reject']);
    // (1) red when `renderOutcome` ignores the account; (2) prints the command's output.
    expect(r.out).toContain(
      `Not recorded: your choice 'reject'. The question on step 'confirm' was already answered — approve, by U0ALICE (as Slack reports it), in a Slack thread, at ${at}.`,
    );
  });

  /** An answer recorded by a library call with `opts` (a route and an account); its record. */
  async function libraryAnswer(opts: Partial<SubmitGateOptions>) {
    // A question that names no one: any account counts, an unreadable one too.
    const def = gated('a3b-lib', {});
    const { runId, gate } = await openQuestion(def);
    const r = await submitHumanResponse(store, def, {
      runId,
      gateId: gate.gate_id,
      choice: 'approve',
      ...opts,
    });
    if (r.status !== 'ok') throw new Error(`fixture: ${r.status} ${r.errors[0]}`);
    const sentence = realm(['run', 'respond', runId, '--gate', gate.gate_id, '--choice', 'reject'])
      .out.split('\n')
      .find((l) => l.startsWith('Not recorded:'));
    return { runId, sentence, at: await givenAt(runId) };
  }

  it('check 4: an account that cannot be shown — the one unshowable phrase, with no label, on the answer line and in the sentence', async () => {
    const { runId, sentence, at } = await libraryAnswer({
      route: 'slack',
      channelEvidence: { user: 'U0\u0007ALICE', forms: ['U0\u0007ALICE'] },
    });
    const line = answerLine(runId);
    // (1) red when the raw value is printed, or a label follows the phrase; (2) prints both.
    expect({
      line: line?.split(' · ').slice(0, 2).join(' · '),
      sentence,
      raw: `${line}${sentence}`.includes('\u0007'),
    }).toEqual({
      line: `Answer: approve · answered by ${UNSHOWABLE_NAME}`,
      sentence: `Not recorded: your choice 'reject'. The question on step 'confirm' was already answered — approve, by ${UNSHOWABLE_NAME}, in a Slack thread, at ${at}.`,
      raw: false,
    });
  });

  it('check 5: another route’s account — "(as its channel reports it)" on the answer line and in the sentence', async () => {
    const { runId, sentence, at } = await libraryAnswer({
      route: 'teams',
      channelEvidence: { user: 'U0ALICE' },
    });
    // (1) red when the label is keyed on the account alone ("as Slack reports it"); (2) prints both.
    expect({ line: answerLine(runId)?.split(' · ').slice(0, 2).join(' · '), sentence }).toEqual({
      line: 'Answer: approve · answered by U0ALICE (as its channel reports it)',
      sentence: `Not recorded: your choice 'reject'. The question on step 'confirm' was already answered — approve, by U0ALICE (as its channel reports it), through route "teams", at ${at}.`,
    });
  });

  it('`realm run respond`’s clause names the account as a name is; with neither, as before', () => {
    const view = (over: Partial<AnswerView>): AnswerView => ({
      choice: 'approve',
      answered_by: { by: null, absent_cause: 'not_stated' },
      ...over,
    });
    // (1) red when the clause drops the account, or adds one where none is recorded; (2) prints them.
    expect({
      account: answererClause(view({ account: { user: 'U0ALICE' } }), false, 'slack'),
      both: answererClause(
        view({ answered_by: { by: 'Ana', by_source: 'stated' }, account: { user: 'U0ALICE' } }),
        false,
        'slack',
      ),
      neither: answererClause(view({ account_absent: 'account_not_recorded' }), false, 'cli'),
      neitherGiven: answererClause(view({ account_absent: 'account_not_recorded' }), true, 'cli'),
    }).toEqual({
      account: ' | answered by U0ALICE (as Slack reports it)',
      both: ' | answered by "Ana" (as stated), U0ALICE (as Slack reports it)',
      neither: '',
      neitherGiven: ' | answered by (not stated)',
    });
  });
});

describe('#603 A3b — check 6: an answer written before A3a (the corpus’s 0.49.0 run)', () => {
  it('reads `account_not_recorded` and `admission_not_recorded`; its answer line is as before', () => {
    const bundle = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../../corpus/0.49.0/runs/08-pr-review.realm.json', import.meta.url)),
        'utf8',
      ),
    ) as { run: RunRecord };
    const views = composeStepViews(bundle.run);
    const [step, view] = Object.entries(views).find(([, v]) => v.answers !== undefined)!;
    const answer = view.answers![0]!;
    const entry = bundle.run.evidence.find((e) => e.kind === 'gate_response' && e.step_id === step);
    const arrival = answerArrivalOf(entry);
    // The line as the base renders it: the view without A3b's members.
    const {
      account: _a,
      account_absent: _b,
      admitted_by: _c,
      admitted_by_absent: _d,
      ...before
    } = answer;
    // (1) red when a missing member is read as a value (`no_named_answerer`), or the line changes;
    //     (2) prints the pairs and both lines.
    expect({
      account_absent: answer.account_absent,
      admitted_by_absent: answer.admitted_by_absent,
      admitted_by: answer.admitted_by,
      line: renderAnswerLine(answer, arrival),
      says: renderAnswerLine(answer, arrival).includes('answered by (not stated)'),
    }).toEqual({
      account_absent: 'account_not_recorded',
      admitted_by_absent: 'admission_not_recorded',
      admitted_by: undefined,
      line: renderAnswerLine(before, arrival),
      says: true,
    });
  });
});
