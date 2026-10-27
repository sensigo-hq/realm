// slack-gate-notifier.test.ts — Tests for the gate post's view block, owner Slack notification,
// startGateReminderTimers, postSlackReply, postGateViaApi, and bidirectional gate handling.
import { declared } from '../../test-support/declared.js';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  renderSlack,
  slackView,
  slackEscape,
  slackOwner,
  SLACK_ESCAPES,
  SLACK_SECTION_TEXT_LIMIT,
  postGateNotificationToSlack,
  postGateViaApi,
  startGateReminderTimers,
  postSlackReply,
  handleBidirectionalGate,
  createSlackGateHandler,
} from './slack-gate-notifier.js';
import { createServer } from 'node:http';
import { rm, writeFile } from 'node:fs/promises';
import type { BidirectionalGateParams } from './slack-gate-notifier.js';
import type {
  EvidenceSnapshot,
  PendingGate,
  RunStore,
  WorkflowDefinition,
  StepHandler,
} from '@sensigo/realm';
import {
  JsonFileStore,
  ExtensionRegistry,
  executeStep,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  answerArrivalOf,
  answerViaOf,
  buildDisclosureSet,
  composePersonNotice,
  respondWayOfGate,
  CUT_SENTENCE,
  VIEW_BUDGET,
  type PersonNotice,
  type RunRecord,
} from '@sensigo/realm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { renderOutcome } from '@sensigo/realm-mcp';
import { renderAnswerLine } from '../../lib/holder-render.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LlmProvider } from '../providers/llm-provider.js';
import { startSlackGateServer } from './slack-gate-server.js';
import type { SlackGateEvent } from './slack-gate-server.js';
import { connectSocketMode } from './slack-socket-client.js';
import { slackResponse } from '../test-support/slack-response.js';

// Module-level mocks are hoisted by vitest — slack-gate-notifier.ts will receive these stubs for
// its internal imports of slack-gate-server and slack-socket-client.
vi.mock('./slack-gate-server.js', () => ({
  startSlackGateServer: vi.fn().mockReturnValue({ close: vi.fn() }),
}));
vi.mock('./slack-socket-client.js', () => ({
  connectSocketMode: vi.fn().mockReturnValue({ close: vi.fn() }),
}));

// #729 PR-4 (02; re-pinned from `formatGatePreviewForSlack`, which composed its own preview): the
// view block shows core's composed view — for a message-less gate on this broadcast surface, the
// output body as its shapes, through the composer's chain; Slack only escapes and fences it.
describe('the gate post’s view block (the composer’s preview, rendered)', () => {
  const viewBlock = (preview: Record<string, unknown>): string => {
    const gate: PendingGate = {
      gate_id: 'g0',
      step_name: 's',
      preview,
      choices: ['approve'],
      opened_at: new Date().toISOString(),
    };
    const { blocks } = renderSlack(
      {
        kind: 'question_opened',
        run_id: 'r1',
        gate_id: 'g0',
        step: 's',
        view: slackView(gate),
        respond: {
          verb: 'respond',
          conditions: [],
          run_id: 'r1',
          gate_id: 'g0',
          oneOf: ['approve'],
        } as never,
      },
      { mode: 'bot' },
    );
    return (blocks[1] as { text: { text: string } }).text.text;
  };

  it('headline and message: joined by a blank line (their shapes, on broadcast)', () => {
    // (a) red when the composer's join is replaced (the old bold headline); (b) prints the text.
    expect(
      viewBlock({ headline: 'Deploy failed', message: 'The pipeline failed at step 3.' }),
    ).toBe('‹string, 13 characters›\n\n‹string, 30 characters›');
  });

  it('headline alone: the headline, never "undefined"', () => {
    // (a) red when an absent message renders as text; (b) prints the text.
    expect(viewBlock({ headline: 'Deploy failed' })).toBe('‹string, 13 characters›');
  });

  it('any other output: its JSON, in a code fence', () => {
    // (a) red when the fence or the JSON's indentation is lost; (b) prints the text.
    expect(viewBlock({ risk: 'high' })).toBe('```\n{\n  "risk": "‹string, 4 characters›"\n}\n```');
  });

  it('an empty output: `(no output)`', () => {
    // (a) red when an empty body posts nothing or throws; (b) prints the text.
    expect(viewBlock({})).toBe('(no output)');
  });
});

describe('postGateNotificationToSlack — owner field', () => {
  it('uses resolved_message when present instead of formatGatePreviewForSlack fallback', async () => {
    const mockFetch = vi.fn().mockResolvedValue(slackResponse({ text: 'ok' }));
    vi.stubGlobal('fetch', mockFetch);

    const gate: PendingGate = {
      gate_id: 'g0',
      step_name: 'human_review',
      preview: { headline: 'Draft', message: 'Body text' },
      choices: ['approve'],
      opened_at: new Date().toISOString(),
      resolved_message: 'Approve this draft?',
    };
    await postGateNotificationToSlack('https://hooks.slack.com/test', gate, 'r1');

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const bodyStr = init.body as string;
    expect(bodyStr).toContain('Approve this draft?');
    // The fallback formatGatePreviewForSlack headline must NOT be used.
    expect(bodyStr).not.toContain('*Draft*');

    vi.unstubAllGlobals();
  });

  it('a message-less gate: the view block is the output body, as its shapes', async () => {
    const mockFetch = vi.fn().mockResolvedValue(slackResponse({ text: 'ok' }));
    vi.stubGlobal('fetch', mockFetch);

    const gate: PendingGate = {
      gate_id: 'g0b',
      step_name: 'human_review',
      preview: { headline: 'Draft', message: 'Body text' },
      choices: ['approve'],
      opened_at: new Date().toISOString(),
      // no resolved_message
    };
    await postGateNotificationToSlack('https://hooks.slack.com/test', gate, 'r1');

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const bodyStr = init.body as string;
    // #729 PR-3 (owner Q6; RECORD 05 "Slack"); #729 PR-4 ((f), re-pinned: the composer's chain, no
    // bold headline): a message-less gate's body is posted as its shapes on this broadcast surface,
    // never its text. (a) red when the raw preview is posted; (b) prints booleans.
    expect({
      shapedHeadline: bodyStr.includes('‹string, 5 characters›'),
      rawHeadline: bodyStr.includes('Draft'),
    }).toEqual({ shapedHeadline: true, rawHeadline: false });
    expect(bodyStr).not.toContain('undefined');

    vi.unstubAllGlobals();
  });

  it('includes *Owner:* line when gate.owner is set', async () => {
    const mockFetch = vi.fn().mockResolvedValue(slackResponse({ text: 'ok' }));
    vi.stubGlobal('fetch', mockFetch);

    const gate: PendingGate = {
      gate_id: 'g1',
      step_name: 'human_review',
      preview: { headline: 'My PR' },
      choices: ['approve'],
      opened_at: new Date().toISOString(),
      owner: '@mihai.lupu',
    };
    await postGateNotificationToSlack('https://hooks.slack.com/test', gate, 'r1');

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { blocks: unknown[] };
    expect(JSON.stringify(body.blocks)).toContain('*Owner:*');
    expect(JSON.stringify(body.blocks)).toContain('@mihai.lupu');

    vi.unstubAllGlobals();
  });

  it('omits *Owner:* line when gate.owner is absent', async () => {
    const mockFetch = vi.fn().mockResolvedValue(slackResponse({ text: 'ok' }));
    vi.stubGlobal('fetch', mockFetch);

    const gate: PendingGate = {
      gate_id: 'g2',
      step_name: 'human_review',
      preview: { headline: 'My PR' },
      choices: ['approve'],
      opened_at: new Date().toISOString(),
    };
    await postGateNotificationToSlack('https://hooks.slack.com/test', gate, 'r1');

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { blocks: unknown[] };
    expect(JSON.stringify(body.blocks)).not.toContain('*Owner:*');

    vi.unstubAllGlobals();
  });

  it('posts the correct request body to the webhook URL', async () => {
    const mockFetch = vi.fn().mockResolvedValue(slackResponse({ text: 'ok' }));
    vi.stubGlobal('fetch', mockFetch);

    const gate: PendingGate = {
      gate_id: 'gate-001',
      step_name: 'human_review',
      preview: { title: 'My PR' },
      choices: ['approve'],
      opened_at: new Date().toISOString(),
    };
    await postGateNotificationToSlack('https://hooks.slack.com/test', gate, 'abc');

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://hooks.slack.com/test');
    const body = JSON.parse(init.body as string) as { text: string; blocks: unknown[] };
    expect(body.text).toContain('gate');
    expect(JSON.stringify(body.blocks)).toContain('human_review');
    expect(JSON.stringify(body.blocks)).toContain('realm run respond abc');

    vi.unstubAllGlobals();
  });

  it('swallows network errors without throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    const gate: PendingGate = {
      gate_id: 'g1',
      step_name: 's1',
      preview: {},
      choices: ['approve'],
      opened_at: new Date().toISOString(),
    };
    // #729 PR-4 (re-pinned): the post reports whether it stood — `false` here, never a throw.
    await expect(
      postGateNotificationToSlack('https://hooks.slack.com/test', gate, 'run-id'),
    ).resolves.toBe(false);

    vi.unstubAllGlobals();
  });
});

describe('postGateViaApi — resolved_message', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses resolved_message when present instead of formatGatePreviewForSlack fallback', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(slackResponse({ json: { ok: true, ts: '1234567890.000' } }));
    vi.stubGlobal('fetch', mockFetch);

    const gate: PendingGate = {
      gate_id: 'gv1',
      step_name: 'review_step',
      preview: { headline: 'Draft headline' },
      choices: ['send', 'reject'],
      opened_at: new Date().toISOString(),
      resolved_message: 'Approve this draft?',
    };
    await postGateViaApi('xoxb-test', 'C123', gate, 'r1');

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const bodyStr = init.body as string;
    expect(bodyStr).toContain('Approve this draft?');
    expect(bodyStr).not.toContain('*Draft headline*');
  });

  it('a message-less gate: the view block is the output body, as its shapes', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(slackResponse({ json: { ok: true, ts: '1234567890.001' } }));
    vi.stubGlobal('fetch', mockFetch);

    const gate: PendingGate = {
      gate_id: 'gv2',
      step_name: 'review_step',
      preview: { headline: 'Draft headline' },
      choices: ['send', 'reject'],
      opened_at: new Date().toISOString(),
      // no resolved_message
    };
    await postGateViaApi('xoxb-test', 'C123', gate, 'r1');

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const bodyStr = init.body as string;
    // #729 PR-3 (owner Q6); #729 PR-4 ((f), re-pinned: no bold headline): the message-less body as
    // its shapes. (a) red when the raw preview is posted; (b) prints booleans.
    expect({
      shapedHeadline: bodyStr.includes('‹string, 14 characters›'),
      rawHeadline: bodyStr.includes('Draft headline'),
    }).toEqual({ shapedHeadline: true, rawHeadline: false });
    expect(bodyStr).not.toContain('undefined');
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGate(overrides: Partial<PendingGate> = {}): PendingGate {
  return {
    gate_id: 'g1',
    step_name: 'review_step',
    preview: { headline: 'Deploy v2.0' },
    choices: ['approve', 'reject'],
    opened_at: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// startGateReminderTimers
// ---------------------------------------------------------------------------

describe('startGateReminderTimers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('posts reminder text at the configured interval', async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as { text: string };
        calls.push(body.text);
        return Promise.resolve(slackResponse({ json: { ok: true } }));
      }),
    );

    const gate = makeGate({ step_name: 'review_step' });
    const clearTimers = startGateReminderTimers(
      'xoxb-test',
      'C123',
      '1234567890.000',
      gate,
      500, // reminderIntervalMs
      5000, // escalationThresholdMs
    );

    await vi.advanceTimersByTimeAsync(600);
    clearTimers();

    // #729 PR-4 (re-pinned: the `reminder` notice's words). (a) red when the plain firing loses its
    // words; (b) prints the posted texts.
    expect(calls).toEqual(['⏰ gate `review_step` has been open for 0s. Please respond.']);
  });

  it('includes owner mention in escalation message when gate.owner is set', async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as { text: string };
        calls.push(body.text);
        return Promise.resolve(slackResponse({ json: { ok: true } }));
      }),
    );

    const gate = makeGate({ step_name: 'review_step', owner: '@prod-oncall' });
    const clearTimers = startGateReminderTimers(
      'xoxb-test',
      'C123',
      '1234567890.000',
      gate,
      10, // reminderIntervalMs — fires fast
      20, // escalationThresholdMs — fires even faster for escalation
    );

    await vi.advanceTimersByTimeAsync(50);
    clearTimers();

    // #729 PR-4 (re-pinned: the escalation is the `reminder` notice with its owner named first).
    // (a) red when the mention is dropped; (b) prints the posted texts.
    expect(
      calls.filter((t) => t.startsWith('@prod-oncall — ⏰ gate `review_step` has been open for')),
    ).toHaveLength(1);
  });

  it('posts generic escalation message (no @ mention) when gate.owner is absent', async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as { text: string };
        calls.push(body.text);
        return Promise.resolve(slackResponse({ json: { ok: true } }));
      }),
    );

    const gate = makeGate({ step_name: 'review_step' }); // no owner
    const clearTimers = startGateReminderTimers(
      'xoxb-test',
      'C123',
      '1234567890.000',
      gate,
      10,
      20,
    );

    await vi.advanceTimersByTimeAsync(50);
    clearTimers();

    // #729 PR-4 (re-pinned): the plain reminder and the escalation both post; with no owner,
    // neither names anyone. (a) red when a mention is invented; (b) prints the posted texts.
    expect({
      posts: calls.filter((t) => t.startsWith('⏰ gate `review_step` has been open for')).length,
      mention: calls.some((t) => t.includes('@')),
    }).toEqual({ posts: 2, mention: false });
  });

  it('does not fire after clearTimers() is called', async () => {
    vi.useFakeTimers();
    const mockFetch = vi.fn().mockResolvedValue(slackResponse({ json: { ok: true } }));
    vi.stubGlobal('fetch', mockFetch);

    const gate = makeGate();
    const clearTimers = startGateReminderTimers(
      'xoxb-test',
      'C123',
      '1234567890.000',
      gate,
      200,
      400,
    );

    // Clear before any timers fire.
    clearTimers();
    await vi.advanceTimersByTimeAsync(600);

    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// postSlackReply
// ---------------------------------------------------------------------------

describe('postSlackReply', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not throw when the fetch call fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Should not throw — postSlackReply is best-effort.
    await expect(
      postSlackReply('xoxb-test', 'C123', '1234567890.000', 'Hello'),
    ).resolves.not.toThrow();

    expect(warnSpy).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// handleBidirectionalGate
// ---------------------------------------------------------------------------

function makeMinimalStore(): RunStore {
  return declared({
    get: vi.fn(async () => ({ terminal_state: 'completed', pending_gate: undefined })),
  } as unknown as RunStore);
}

/**
 * Store that mimics a gate-waiting run for the first get() call, then returns
 * completed. Includes a patch() stub so submitHumanResponse can write evidence.
 */
function makeGateStore(gate: PendingGate): RunStore {
  const completedRun = {
    id: 'run1',
    terminal_state: 'completed',
    pending_gate: undefined,
    run_phase: 'completed',
    version: 2,
    in_progress_steps: [],
    completed_steps: [gate.step_name],
    // #729 PR-0: every reply composes the run's ways from the record, which reads its step lists —
    // a record always has them.
    failed_steps: [],
    skipped_steps: [],
    evidence: [],
  };
  const openRun = {
    id: 'run1',
    terminal_state: undefined,
    pending_gate: gate,
    run_phase: 'waiting_for_human',
    version: 1,
    in_progress_steps: [gate.step_name],
    completed_steps: [],
    failed_steps: [],
    skipped_steps: [],
    evidence: [],
  };
  // F9: every read before the answer is written sees the open run (the notifier now reads it before
  // the answer too, for its finalizer lines), and every read after it the completed one.
  let answered = false;
  const get = vi.fn().mockImplementation(async () => (answered ? completedRun : openRun));
  const update = vi.fn().mockImplementation(async () => {
    answered = true;
    return completedRun;
  });
  return declared({ get, update } as unknown as RunStore);
}

/** #819 (item 28): the answer's entry in the store's last write — the record the answer wrote. */
function slackAnswerOf(store: RunStore): EvidenceSnapshot | undefined {
  const written = vi.mocked(store.update).mock.calls.at(-1)?.[0] as
    { evidence?: EvidenceSnapshot[] } | undefined;
  return (written?.evidence ?? []).filter((e) => e.kind === 'gate_response').at(-1);
}

function makeMinimalDefinition(): WorkflowDefinition {
  return { id: 'wf1', name: 'Test WF', version: '1', steps: {} } as unknown as WorkflowDefinition;
}

// issue #337: `slackSigningSecret`'s override is widened (not plain `Partial<T>`) to admit an
// EXPLICIT `undefined` — several call sites deliberately pass `slackSigningSecret: undefined` to
// erase the base fixture's value and exercise the "secret absent" path (e.g. Socket Mode
// selection). Under exactOptionalPropertyTypes, `Partial<T>` only admits "present or omitted",
// never an explicit `undefined` for an optional field — and OMITTING the override key instead
// (case-(a) fix) would silently fall back to the base's `slackSigningSecret: 'secret'`, turning
// the "absent" test into a duplicate of the "present" one. Scoped to just this one field (unlike
// a repo-wide `Partial<T>` mapped-type widening) because widening every field breaks the base
// object literal's own type inference below — `{...defaults, ...overrides}`'s merged property
// types include `undefined` for every widened field, which then conflicts with this function's
// own non-optional return fields (e.g. `gate: PendingGate`) even when no override is passed.
function makeGateParams(
  overrides: Partial<Omit<BidirectionalGateParams, 'slackSigningSecret'>> & {
    slackSigningSecret?: string | undefined;
  } = {},
): BidirectionalGateParams {
  const { slackSigningSecret: secretOverride, ...restOverrides } = overrides;
  return {
    gate: {
      gate_id: 'g1',
      step_name: 'review_step',
      preview: { headline: 'Deploy v2.0' },
      choices: ['approve', 'reject'],
      opened_at: new Date().toISOString(),
    },
    runId: 'run1',
    definition: makeMinimalDefinition(),
    store: makeMinimalStore(),
    provider: new (class extends LlmProvider {
      callStep = vi.fn();
    })(),
    slackBotToken: 'xoxb-test',
    slackChannelId: 'C123',
    gateThreadTs: '1234567890.000',
    // issue #337: three-way handling, not a plain field — 'secret' overridden with a real value
    // (spread it), overridden explicitly to `undefined` (OMIT the key — the source under test
    // only ever does `slackSigningSecret !== undefined`, so an omitted key and an explicit
    // `undefined` value are runtime-indistinguishable to it), or not mentioned at all (the base
    // default). Never assign `slackSigningSecret: undefined` directly — that violates
    // exactOptionalPropertyTypes for this optional-without-`|undefined` field.
    ...(secretOverride !== undefined
      ? { slackSigningSecret: secretOverride }
      : 'slackSigningSecret' in overrides
        ? {}
        : { slackSigningSecret: 'secret' }),
    slackEventsPort: 3100,
    gateReminderIntervalMs: 999_999,
    gateEscalationThresholdMs: 999_999,
    pollIntervalMs: 0,
    ...restOverrides,
  };
}

describe('handleBidirectionalGate', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals(); // restore the repeated stubGlobal('fetch', …)
    vi.restoreAllMocks(); // restore console spies between tests
    // Belt-and-suspenders (issue #172): the bounded-drain test above uses fake timers. Harmless
    // when real timers are already active; prevents any fake-timer leak into sibling tests here.
    vi.useRealTimers();
  });

  it('does not start Events server when gateThreadTs is undefined', async () => {
    await handleBidirectionalGate(makeGateParams({ gateThreadTs: undefined }));

    expect(startSlackGateServer).not.toHaveBeenCalled();
  });

  it('no thread anchor (the opening post failed): the person’s respond lines are printed, never "shown above"', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleBidirectionalGate(makeGateParams({ gateThreadTs: undefined }));

    const output = logSpy.mock.calls.flat().join('\n');
    // #729 PR-4 (02 §Transport (3), re-pinned): the terminal's way, one command per choice, as
    // `realm agent` prints it with no handler. (a) red when the false "shown above" line returns or
    // the respond lines are not printed; (b) prints the output's lines (fakes).
    expect({
      approve: output.includes('   Approve: realm run respond run1 --gate g1 --choice approve'),
      reject: output.includes('   Reject: realm run respond run1 --gate g1 --choice reject'),
      shownAbove: output.includes('shown above'),
    }).toEqual({ approve: true, reject: true, shownAbove: false });

    logSpy.mockRestore();
  });

  it('duplicate event_id triggers only one candidate processing attempt', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(slackResponse({ json: { ok: true } })));

    let capturedOnEvent: ((event: SlackGateEvent) => void) | undefined;
    vi.mocked(startSlackGateServer).mockImplementationOnce((opts) => {
      capturedOnEvent = opts.onEvent;
      return { close: vi.fn() };
    });

    // Use a fetch spy to count how many clarification replies are sent.
    const fetchSpy = vi.fn().mockResolvedValue(slackResponse({ json: { ok: true } }));
    vi.stubGlobal('fetch', fetchSpy);

    const promise = handleBidirectionalGate(makeGateParams());

    // startSlackGateServer ran synchronously before the first await — onEvent captured.
    expect(capturedOnEvent).toBeDefined();

    const event: SlackGateEvent = {
      event_id: 'Ev001',
      thread_ts: '1234567890.000',
      user: 'U1',
      text: 'maybe approve', // not an exact choice — triggers one clarification reply
      ts: '1234567890.001',
    };

    capturedOnEvent!(event); // first delivery
    capturedOnEvent!(event); // duplicate — must be ignored

    // The finally's bounded drain guarantees in-flight replies have landed — no wall-clock barrier.
    await promise;

    // Only one clarification reply should have been sent (dedupe is working).
    const replyCalls = fetchSpy.mock.calls.filter(([url]) =>
      (url as string).includes('postMessage'),
    );
    expect(replyCalls).toHaveLength(1);
  });

  it('selects Socket Mode (connectSocketMode) when slackAppToken is set and slackSigningSecret is absent', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(slackResponse({ json: { ok: true } })));

    await handleBidirectionalGate(
      makeGateParams({ slackSigningSecret: undefined, slackAppToken: 'xapp-test' }),
    );

    expect(connectSocketMode).toHaveBeenCalledOnce();
    expect(startSlackGateServer).not.toHaveBeenCalled();
  });

  it('selects Socket Mode over Events API when both slackAppToken and slackSigningSecret are set', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(slackResponse({ json: { ok: true } })));

    await handleBidirectionalGate(
      makeGateParams({ slackSigningSecret: 'secret', slackAppToken: 'xapp-test' }),
    );

    expect(connectSocketMode).toHaveBeenCalledOnce();
    expect(startSlackGateServer).not.toHaveBeenCalled();
  });

  it('exact match resolves gate and posts confirmation reply', async () => {
    const gate: PendingGate = {
      gate_id: 'g1',
      step_name: 'confirm_review',
      preview: { headline: 'PR #42' },
      choices: ['approve', 'request_changes'],
      opened_at: new Date().toISOString(),
    };
    const mockFetch = vi.fn().mockResolvedValue(slackResponse({ json: { ok: true } }));
    vi.stubGlobal('fetch', mockFetch);

    let capturedOnEvent: ((event: SlackGateEvent) => void) | undefined;
    vi.mocked(startSlackGateServer).mockImplementationOnce((opts) => {
      capturedOnEvent = opts.onEvent;
      return { close: vi.fn() };
    });

    const store = makeGateStore(gate);
    const promise = handleBidirectionalGate(makeGateParams({ gate, store }));
    expect(capturedOnEvent).toBeDefined();

    capturedOnEvent!({
      event_id: 'E1',
      thread_ts: '1234567890.000',
      user: 'U1',
      text: 'approve',
      ts: '1234567890.001',
    });

    await promise;

    const replyCalls = mockFetch.mock.calls.filter(([url]) =>
      (url as string).includes('postMessage'),
    );
    expect(replyCalls.length).toBeGreaterThan(0);
    const replyBody = JSON.parse(replyCalls[replyCalls.length - 1]![1].body as string) as {
      text: string;
    };
    expect(replyBody.text).toContain('approve');
    // #819 (item 28): the answer records how it arrived — the store's write carries the answer's
    // entry. (a) red when the notifier passes no route (`route_not_declared`, though the page says
    // every answer records how it arrived); (b) prints the choice and the route recorded.
    const entry = slackAnswerOf(store);
    expect({
      choice: (entry?.input_summary as Record<string, unknown> | undefined)?.['choice'],
      route:
        entry?.answer !== undefined && 'route' in entry.answer ? entry.answer.route : undefined,
    }).toEqual({
      choice: 'approve',
      route: 'slack',
    });
  });

  it('#819 (item 28) the cross cell: a run answered in Slack reads "a Slack thread" in the answer line `realm run inspect` renders (renderAnswerLine, from the recorded route) and in the agent\'s text after the form path', async () => {
    const gate: PendingGate = {
      gate_id: 'g1',
      step_name: 'confirm_review',
      preview: { headline: 'PR #42' },
      choices: ['approve', 'request_changes'],
      opened_at: new Date().toISOString(),
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(slackResponse({ json: { ok: true } })));
    let onEvent: ((event: SlackGateEvent) => void) | undefined;
    vi.mocked(startSlackGateServer).mockImplementationOnce((opts) => {
      onEvent = opts.onEvent;
      return { close: vi.fn() };
    });
    const store = makeGateStore(gate);
    const promise = handleBidirectionalGate(makeGateParams({ gate, store }));
    onEvent!({
      event_id: 'E2',
      thread_ts: '1234567890.000',
      user: 'U1',
      text: 'approve',
      ts: '1234567890.002',
    });
    await promise;
    const entry = slackAnswerOf(store)!;
    // (a) red per carrier when 'slack' takes the fallback branch (`route "slack"` on inspect,
    //     `route 'slack'` to the agent): one assertion per carrier, two carriers, one recorded
    //     answer; (b) prints both texts.
    expect({
      inspect: renderAnswerLine(
        {
          choice: 'approve',
          answered_by: { by: null, absent_cause: 'not_stated' },
          claim_proof_absent: 'proof_not_recorded',
        },
        answerArrivalOf(entry),
      ).includes(' · through a Slack thread (as its door declared), '),
      agent: renderOutcome({
        step: gate.step_name,
        attempted: false,
        by: { kind: 'answer', basis: 'stated' },
        choice: 'approve',
        via: answerViaOf(entry),
      }),
    }).toEqual({
      inspect: true,
      agent:
        "Meanwhile, the question on step 'confirm_review' was answered — approve, through a Slack thread.",
    });
  });

  it('non-exact input sends a clarification reply listing valid choices', async () => {
    const gate: PendingGate = {
      gate_id: 'g1',
      step_name: 'confirm_review',
      preview: { headline: 'PR #42' },
      choices: ['approve', 'request_changes'],
      opened_at: new Date().toISOString(),
    };
    const mockFetch = vi.fn().mockResolvedValue(slackResponse({ json: { ok: true } }));
    vi.stubGlobal('fetch', mockFetch);

    let capturedOnEvent: ((event: SlackGateEvent) => void) | undefined;
    vi.mocked(startSlackGateServer).mockImplementationOnce((opts) => {
      capturedOnEvent = opts.onEvent;
      return { close: vi.fn() };
    });

    const promise = handleBidirectionalGate(makeGateParams({ gate }));
    expect(capturedOnEvent).toBeDefined();

    // 'reject' is not a valid choice — gate must not be resolved
    capturedOnEvent!({
      event_id: 'E2',
      thread_ts: '1234567890.000',
      user: 'U1',
      text: 'reject',
      ts: '1234567890.002',
    });

    // The finally's bounded drain guarantees in-flight replies have landed — no wall-clock barrier.
    await promise;

    const replyCalls = mockFetch.mock.calls.filter(([url]) =>
      (url as string).includes('postMessage'),
    );
    expect(replyCalls).toHaveLength(1); // EXACT — the drain closes the dedupe-masking window
    const replyBody = JSON.parse(replyCalls[replyCalls.length - 1]![1].body as string) as {
      text: string;
    };
    expect(replyBody.text).toContain('approve');
    expect(replyBody.text).toContain('request_changes');
    // Must not silently resolve with a guessed choice
    expect(replyBody.text).not.toContain('Changes requested');
    expect(replyBody.text).not.toContain('Gate resolved');
  });

  // Sig-1: the tests above drive the Events API (startSlackGateServer). Prove the Socket Mode
  // dispatch site (connectSocketMode) is ALSO tracked+drained, else it silently drops in production.
  it('Socket Mode: an exact match is tracked+drained → confirmation reply landed, gate resolved', async () => {
    const gate: PendingGate = {
      gate_id: 'g1',
      step_name: 'confirm_review',
      preview: { headline: 'PR #7' },
      choices: ['approve', 'request_changes'],
      opened_at: new Date().toISOString(),
    };
    const mockFetch = vi.fn().mockResolvedValue(slackResponse({ json: { ok: true } }));
    vi.stubGlobal('fetch', mockFetch);

    let capturedOnEvent: ((event: SlackGateEvent) => void) | undefined;
    vi.mocked(connectSocketMode).mockImplementationOnce((opts) => {
      capturedOnEvent = opts.onEvent;
      return { close: vi.fn() };
    });

    const promise = handleBidirectionalGate(
      makeGateParams({
        gate,
        store: makeGateStore(gate),
        slackSigningSecret: undefined,
        slackAppToken: 'xapp-test', // selects Socket Mode
      }),
    );
    expect(connectSocketMode).toHaveBeenCalledOnce();
    expect(capturedOnEvent).toBeDefined();

    capturedOnEvent!({
      event_id: 'S1',
      thread_ts: '1234567890.000',
      user: 'U1',
      text: 'approve',
      ts: '1234567890.001',
    });

    await promise; // bounded drain guarantees the reply landed — no wall-clock barrier

    const replyCalls = mockFetch.mock.calls.filter(([url]) =>
      (url as string).includes('postMessage'),
    );
    expect(replyCalls).toHaveLength(1); // the confirmation reply (only posted on submit success)
    const body = JSON.parse(replyCalls[0]![1].body as string) as { text: string };
    expect(body.text).toContain('approve');
  });

  // Bounded drain: a hung Slack (postSlackReply's fetch never resolves) must NOT stall the run loop.
  // Deterministic, fake-timer version (issue #172) — the old real-timer/Date.now() version was
  // flaky under full-suite CPU contention (once observed a negative elapsed time). The source's
  // drain is setTimeout-driven (slack-gate-notifier.ts:410-417, DRAIN_TIMEOUT_MS = 2000, not
  // exported — mirrored below since this file may not touch source), so it's fully drivable with
  // vi.advanceTimersByTimeAsync, same pattern as this file's other fake-timer tests (~line 272).
  it('bounded drain: a never-resolving reply does not hang the gate handler (returns within the bound)', async () => {
    const DRAIN_TIMEOUT_MS = 2000; // mirrors the source's private (unexported) constant

    vi.useFakeTimers();
    const gate: PendingGate = {
      gate_id: 'g1',
      step_name: 'confirm_review',
      preview: { headline: 'PR #9' },
      choices: ['approve', 'request_changes'],
      opened_at: new Date().toISOString(),
    };
    // fetch (used by postSlackReply's confirmation) never resolves → processCandidate hangs after
    // the store write; the finally's bounded drain must give up after DRAIN_TIMEOUT_MS.
    // issue #337: a zero-arg implementation narrows vi.fn()'s inferred Args to `[]`, which makes
    // `.mock.calls` a `[][]` — the `[url]` destructure below then has no element to read. The rest
    // param widens Args to `unknown[]` (matching every other mockFetch in this file) with zero
    // change to runtime behaviour — the implementation still ignores whatever it's called with.
    const mockFetch = vi.fn((..._args: unknown[]) => new Promise(() => {}));
    vi.stubGlobal('fetch', mockFetch);

    let capturedOnEvent: ((event: SlackGateEvent) => void) | undefined;
    vi.mocked(startSlackGateServer).mockImplementationOnce((opts) => {
      capturedOnEvent = opts.onEvent;
      return { close: vi.fn() };
    });

    let settled = false;
    const promise = handleBidirectionalGate(
      makeGateParams({ gate, store: makeGateStore(gate) }),
    ).then((r) => {
      settled = true;
      return r;
    });
    expect(capturedOnEvent).toBeDefined();
    capturedOnEvent!({
      event_id: 'H1',
      thread_ts: '1234567890.000',
      user: 'U1',
      text: 'approve',
      ts: '1234567890.001',
    });

    // Flush up to (but not across) the drain timeout: the poll loop resolves almost immediately
    // (0ms poll interval), the candidate blocks on the never-resolving fetch, and the ONLY thing
    // that can still unblock the handler from here is the drain timer itself.
    await vi.advanceTimersByTimeAsync(DRAIN_TIMEOUT_MS - 1);
    expect(settled).toBe(false); // not settled — proves the reply itself never unblocked it

    // Cross the drain timeout — this is what actually unblocks the handler.
    await vi.advanceTimersByTimeAsync(1);
    await promise; // must now resolve via the bounded drain, not the never-resolving reply
    expect(settled).toBe(true);

    // The confirmation reply was attempted exactly once (the never-resolving fetch we stubbed) —
    // the drain gave up waiting for it to settle rather than blocking forever, and did not retry
    // or double-post while waiting.
    const replyCalls = mockFetch.mock.calls.filter(([url]) =>
      (url as string).includes('postMessage'),
    );
    expect(replyCalls).toHaveLength(1);

    vi.useRealTimers();
  });

  // Submit failure (submitHumanResponse returns an error envelope) must surface ONE error reply,
  // NOT a confirmation, and NOT resolve/abort the gate — and never post twice.
  it('submit failure posts exactly one error reply, no confirmation, and does not abort the gate', async () => {
    const gate: PendingGate = {
      gate_id: 'g1',
      step_name: 'confirm_review',
      preview: { headline: 'PR #11' },
      choices: ['approve', 'request_changes'],
      opened_at: new Date().toISOString(),
    };
    const mockFetch = vi.fn().mockResolvedValue(slackResponse({ json: { ok: true } }));
    vi.stubGlobal('fetch', mockFetch);

    // Our gate g1 is open until update is attempted, which throws (submit fails) → submitHumanResponse
    // returns an error envelope; then the run reads terminal so the poll loop returns. Order-independent.
    let updateAttempted = false;
    const openRun = {
      id: 'run1',
      terminal_state: undefined,
      pending_gate: gate,
      run_phase: 'waiting_for_human',
      version: 1,
      in_progress_steps: [gate.step_name],
      completed_steps: [],
      skipped_steps: [],
      evidence: [],
    };
    const terminalRun = {
      ...openRun,
      terminal_state: 'failed',
      pending_gate: undefined,
      run_phase: 'failed',
    };
    const store = declared({
      get: vi.fn(async () => (updateAttempted ? terminalRun : openRun)),
      update: vi.fn(async () => {
        updateAttempted = true;
        throw new Error('persist failed');
      }),
    } as unknown as RunStore);

    let capturedOnEvent: ((event: SlackGateEvent) => void) | undefined;
    vi.mocked(startSlackGateServer).mockImplementationOnce((opts) => {
      capturedOnEvent = opts.onEvent;
      return { close: vi.fn() };
    });

    const promise = handleBidirectionalGate(makeGateParams({ gate, store }));
    expect(capturedOnEvent).toBeDefined();

    // Fire the same exact match twice (distinct event_ids) → the at-most-once guard must hold.
    capturedOnEvent!({
      event_id: 'F1',
      thread_ts: '1234567890.000',
      user: 'U1',
      text: 'approve',
      ts: '1234567890.001',
    });
    capturedOnEvent!({
      event_id: 'F2',
      thread_ts: '1234567890.000',
      user: 'U1',
      text: 'approve',
      ts: '1234567890.002',
    });

    await promise;

    const texts = mockFetch.mock.calls
      .filter(([url]) => (url as string).includes('postMessage'))
      .map(
        ([, init]) => (JSON.parse((init as RequestInit).body as string) as { text: string }).text,
      );
    // #729 PR-4 (re-pinned): exactly ONE refusal reply (the at-most-once guard), then — the run
    // having ended with the question unanswered — the closed line; never a confirmation. (a) red
    // when the refusal posts twice, a confirmation posts, or the closed line is missing; (b) prints
    // the posted texts (fakes).
    expect({
      refusals: texts.filter((t) => t.includes("Couldn't record your response")).length,
      confirmed: texts.some((t) => t.includes('run continuing') || t.includes('Gate resolved')),
      closed: texts.at(-1),
    }).toEqual({
      refusals: 1,
      confirmed: false,
      closed: 'This question is closed: the run stopped.',
    });
  });
});

// ---------------------------------------------------------------------------
// handleBidirectionalGate — registry threading fires finalizers (end-to-end)
// ---------------------------------------------------------------------------

function gateFinalizerDef(): WorkflowDefinition {
  return {
    id: 'slack-gate-fin-wf',
    name: 'Slack Gate Finalizer WF',
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps: {
      'step-one': {
        description: 'Auto step with gate',
        execution: 'auto',
        trust: 'human_confirmed',
        gate: { choices: ['approve', 'reject'] },
      },
      record_outcome: {
        description: 'Record terminal outcome',
        execution: 'finalizer',
        on_outcome: 'complete',
        handler: 'record_outcome',
      },
    } as unknown as WorkflowDefinition['steps'],
  } as unknown as WorkflowDefinition;
}

describe('handleBidirectionalGate — threads the registry so gate-completed runs fire finalizers', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('runs the complete finalizer (project handler) via the threaded registry when a Slack reply completes the run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'realm-slack-fin-'));
    const store = new JsonFileStore(dir);
    const def = gateFinalizerDef();
    const { run } = await store.create({
      workflowId: def.id,
      workflowVersion: 1,
      params: {},
    });
    // Open the gate for real.
    await executeStep(store, def, {
      runId: run.id,
      command: 'step-one',
      input: {},
      dispatcher: async () => ({}),
    });
    const opened = await store.get(run.id);
    const gate = opened.pending_gate!;

    // Project handler registered ONLY in this custom registry (not the default).
    const ran = vi.fn();
    const handler: StepHandler = {
      id: 'record_outcome',
      execute: vi.fn(async () => {
        ran();
        return { data: { recorded: true } };
      }),
    };
    const registry = new ExtensionRegistry();
    registry.register('handler', 'record_outcome', handler);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(slackResponse({ json: { ok: true } })));
    let capturedOnEvent: ((event: SlackGateEvent) => void) | undefined;
    vi.mocked(startSlackGateServer).mockImplementationOnce((opts) => {
      capturedOnEvent = opts.onEvent;
      return { close: vi.fn() };
    });

    const promise = handleBidirectionalGate(
      makeGateParams({ gate, runId: run.id, definition: def, store, registry }),
    );
    expect(capturedOnEvent).toBeDefined();

    capturedOnEvent!({
      event_id: 'E1',
      thread_ts: '1234567890.000',
      user: 'U1',
      text: 'approve',
      ts: '1234567890.001',
    });

    await promise;

    const updated = await store.get(run.id);
    expect(updated.run_phase).toBe('completed');
    expect(updated.completed_steps).toContain('record_outcome');
    expect(ran).toHaveBeenCalledTimes(1);
  });
});

describe('issue #719 — the one-way notifier waits on a run file that cannot be read', () => {
  it('rejects with the file’s message (what realm agent prints), never its text', async () => {
    const runsDir = await mkdtemp(join(tmpdir(), 'realm-719-notifier-'));
    const server = createServer((_req, res) => {
      res.writeHead(200);
      res.end('ok');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const { port } = server.address() as { port: number };
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await writeFile(join(runsDir, 'bad.json'), '{"params":{"token": ghp_FAKE719}}');
      const handler = createSlackGateHandler({
        store: new JsonFileStore(runsDir),
        definition: {
          id: 'w',
          name: 'w',
          version: 1,
          schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
          steps: { s: { description: 'd', execution: 'auto' } },
        } as WorkflowDefinition,
        provider: {} as never,
        webhookUrl: `http://127.0.0.1:${port}/hook`,
        pollIntervalMs: 10,
      });
      const gate: PendingGate = {
        gate_id: 'g',
        step_name: 's',
        preview: {},
        choices: ['approve'],
        opened_at: new Date().toISOString(),
      };
      const err = (await handler('bad', gate).catch((e: unknown) => e)) as Error;
      const text = String(err?.message);
      // (a) red when the poll's error loses the file's message or carries the parser's text; (b)
      //     prints booleans only.
      expect({
        message: text.includes(`The run file '${join(runsDir, 'bad.json')}' is not JSON.`),
        leaked: text.includes('ghp_FAKE7'),
      }).toEqual({ message: true, leaked: false });
    } finally {
      logs.mockRestore();
      server.close();
      await rm(runsDir, { recursive: true, force: true });
    }
  });
});

describe('issue #719 C5 — the two-way notifier’s thread post on a run file that cannot be read', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('the leak cell (the Slack thread): a fault AT a token never reaches a posted text', async () => {
    const runsDir = await mkdtemp(join(tmpdir(), 'realm-719-twoway-'));
    const warns = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await writeFile(join(runsDir, 'run1.json'), '{"params":{"token": ghp_FAKE719}}');
      const mockFetch = vi.fn().mockResolvedValue(slackResponse({ json: { ok: true } }));
      vi.stubGlobal('fetch', mockFetch);
      let capturedOnEvent: ((event: SlackGateEvent) => void) | undefined;
      vi.mocked(startSlackGateServer).mockImplementationOnce((opts) => {
        capturedOnEvent = opts.onEvent;
        return { close: vi.fn() };
      });
      const promise = handleBidirectionalGate(
        makeGateParams({ store: new JsonFileStore(runsDir) }),
      );
      capturedOnEvent?.({
        event_id: 'E719',
        thread_ts: '1234567890.000',
        user: 'U1',
        text: 'approve',
        ts: '1234567890.719',
      });
      // The poll's read of the damaged file ends the wait; the finally's drain lands the post.
      await promise.catch(() => undefined);
      const posted = mockFetch.mock.calls
        .filter(([url]) => String(url).includes('postMessage'))
        .map(([, init]) => String((init as { body?: unknown }).body));
      const consoleText = warns.mock.calls.flat().map(String).join('\n');
      // (a) red when the parser's text reaches the thread or the console; #729 PR-4 (re-pinned):
      //     the thread gets the code (G9), the fault's detail goes to this console. (b) prints
      //     booleans only — whether the refusal was posted, where the fault is named, and whether
      //     any text holds the token.
      expect({
        postedTheError: posted.some((b) => b.includes("Couldn't record your response")),
        threadNamesTheFault: posted.some((b) => b.includes('is not JSON')),
        consoleNamesTheFault: consoleText.includes('is not JSON'),
        leaked: posted.some((b) => b.includes('ghp_FAKE7')) || consoleText.includes('ghp_FAKE7'),
      }).toEqual({
        postedTheError: true,
        threadNamesTheFault: false,
        consoleNamesTheFault: true,
        leaked: false,
      });
    } finally {
      warns.mockRestore();
      await rm(runsDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// #729 PR-4 — the asked person in Slack (02; 04 "The Slack arms", "Transport"). Every value is a
// fake. Each assertion names (a) the change that turns it red and (b) what it prints when it fails.
// ---------------------------------------------------------------------------

const PR4_DECLARED = 'CANARY-declared-4f2a';
const PR4_ENV_NAME = 'SLACK_FAKE_ENV_PR4';
const PR4_ENV_VALUE = 'FAKE-SLACK-ENV-PR4-0729';
const SPAN_MARKS = /[-]/;
const OPERATOR_COMMANDS = /realm run (drain|resume|register)|realm workflow register/;

const pr4Gate = (over: Partial<PendingGate> = {}): PendingGate => ({
  gate_id: 'g4',
  step_name: 'review',
  preview: { summary: 'ok' },
  choices: ['approve', 'reject'],
  opened_at: '2026-10-27T10:00:00.000Z',
  resolved_message: 'Approve the release?',
  ...over,
});
const openedNotice = (gate: PendingGate, runId = 'r4'): PersonNotice =>
  composePersonNotice({
    kind: 'question_opened',
    run_id: runId,
    gate,
    view: slackView(gate),
    respond: respondWayOfGate(runId, gate),
  });
type Block = { type: string; text?: { text: string }; elements?: Array<{ text: string }> };
const texts = (blocks: unknown[]): string[] =>
  (blocks as Block[]).map((b) => b.text?.text ?? b.elements?.[0]?.text ?? '');
/** Every body a stubbed fetch received, parsed. */
const bodiesOf = (stub: { mock: { calls: unknown[][] } }) =>
  stub.mock.calls.map(
    ([, init]) =>
      JSON.parse(String((init as RequestInit).body)) as { text?: string; blocks?: unknown[] },
  );

/** Records `outcomeOf` reads at the poll's end (the shapes `person-notice.test.ts` pins). */
const closedGate = pr4Gate({
  expires_at: '2026-10-27T11:00:00.000Z',
  on_expiry: 'settle_default',
  default_choice: 'reject',
});
const closedRecord = (over: Record<string, unknown>): RunRecord =>
  ({
    id: 'run1',
    terminal_state: false,
    pending_gate: undefined,
    evidence: [],
    completed_steps: [],
    failed_steps: [],
    skipped_steps: [],
    in_progress_steps: [],
    ...over,
  }) as unknown as RunRecord;
const CLOSED_CASES = [
  {
    how: 'its time ran out',
    record: closedRecord({
      settled: { review: { outcome: 'gate', choice: 'reject', resolved_by: 'timeout' } },
    }),
  },
  {
    how: 'the run stopped',
    record: closedRecord({
      terminal_state: true,
      evidence: [
        {
          step_id: 'review',
          completed_at: '2026-10-27T10:06:00.000Z',
          output_summary: { gate_cancelled_by_abort: true },
        },
      ],
      skip_details: { review: { kind: 'gate_cancelled_by_abort' } },
      aborted_at: { step_id: 'guard' },
    }),
  },
  {
    how: 'it was answered elsewhere as `approve`',
    record: closedRecord({
      evidence: [
        {
          step_id: 'review',
          kind: 'gate_response',
          completed_at: '2026-10-27T10:05:00.000Z',
          responded_by: 'sam',
          output_summary: { choice: 'approve' },
        },
      ],
      settled: { review: { outcome: 'gate', choice: 'approve', resolved_by: 'human' } },
    }),
  },
] as const;
const storeReading = (record: RunRecord): RunStore =>
  declared({ get: vi.fn(async () => record) } as unknown as RunStore);

describe('#729 PR-4 — the asked person in Slack: the opening post', () => {
  beforeEach(() => {
    vi.stubEnv('REALM_NOT_SECRET', '');
    vi.stubEnv(PR4_ENV_NAME, PR4_ENV_VALUE);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('question_opened, bot and webhook: the header, the view at broadcast (the output’s declared fake as its shape), the person’s route — no operator command, no span mark', async () => {
    const gate = pr4Gate({ preview: { note: PR4_DECLARED } });
    const bot = vi.fn().mockResolvedValue(slackResponse({ json: { ok: true, ts: '1.0' } }));
    vi.stubGlobal('fetch', bot);
    await postGateViaApi('xoxb-fake', 'C1', gate, 'r4');
    const hook = vi.fn().mockResolvedValue(slackResponse({ text: 'ok' }));
    vi.stubGlobal('fetch', hook);
    await postGateNotificationToSlack('https://hooks.slack.com/fake', gate, 'r4');
    const [botBody] = bodiesOf(bot);
    const [hookBody] = bodiesOf(hook);
    const raw = JSON.stringify([botBody, hookBody]);
    const view = '```\n{\n  "note": "‹string, 20 characters›"\n}\n```';
    // (a) red when the composer is handed the raw gate (the fake in the block), the route is
    //     dropped, one command per choice is rendered, or an operator command is added (G9); (b)
    //     prints the block texts and booleans.
    expect({
      bot: texts(botBody!.blocks!),
      webhookBlocks: texts(hookBody!.blocks!).slice(0, 2),
      webhookCommands: texts(hookBody!.blocks!)[2]!.match(/realm run respond/g)?.length ?? 0,
      fake: raw.includes(PR4_DECLARED),
      redacted: raw.includes('[REDACTED]'),
      operator: OPERATOR_COMMANDS.test(raw),
      marks: SPAN_MARKS.test(raw),
    }).toEqual({
      bot: [
        '*Gate:* `review`',
        `Approve the release?\n\n${view}`,
        'Reply in this thread with `approve` or `reject`',
      ],
      webhookBlocks: ['*Gate:* `review`', `Approve the release?\n\n${view}`],
      webhookCommands: 1,
      fake: false,
      redacted: false,
      operator: false,
      marks: false,
    });
  });

  it('(f): a gate with no message — the view block is the output body; the step’s prompt is never the question', async () => {
    const posts = vi.fn().mockResolvedValue(slackResponse({ json: { ok: true, ts: '1.0' } }));
    vi.stubGlobal('fetch', posts);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const definition = {
      id: 'w',
      name: 'w',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: {
        review: {
          description: 'd',
          execution: 'agent',
          prompt: 'PROMPT-TEXT-4f2a',
          gate: { choices: ['approve', 'reject'] },
        },
      },
    } as unknown as WorkflowDefinition;
    const handler = createSlackGateHandler({
      store: makeMinimalStore(),
      definition,
      provider: {} as never,
      botToken: 'xoxb-fake',
      channelId: 'C1',
      pollIntervalMs: 0,
    });
    const { resolved_message: _none, ...noMessage } = pr4Gate({ preview: { headline: 'H' } });
    await handler('r4', noMessage);
    const [opening] = bodiesOf(posts);
    // (a) red when the prompt is shown as the question; (b) prints the view block and a boolean.
    expect({
      view: texts(opening!.blocks!)[1],
      prompt: JSON.stringify(bodiesOf(posts)).includes('PROMPT-TEXT'),
    }).toEqual({ view: '‹string, 1 character›', prompt: false });
  });

  it('(g): the one table escapes the author’s and the agent’s strings — question, step name, choices — never the renderer’s markup', () => {
    const gate = pr4Gate({
      step_name: 'st<ep',
      choices: ['a<b', 'ok'],
      resolved_message: 'a & b < c > d ```x``` ‮e ​f',
      preview: { k: 'v' },
    });
    const bot = texts(renderSlack(openedNotice(gate), { mode: 'bot' }).blocks);
    // (a) red when one character is left unescaped, or the markup (`*`, backticks, the fence) is
    //     escaped; (b) prints the three block texts.
    expect(bot).toEqual([
      '*Gate:* `st&lt;ep`',
      'a &amp; b &lt; c &gt; d ` ` `x` ` ` �e �f\n\n```\n{\n  "k": "‹string, 1 character›"\n}\n```',
      'Reply in this thread with `a&lt;b` or `ok`',
    ]);
  });

  it('the owner mention (rev 8): a Slack user, user-group or special mention pings; anything else is escaped, the whole string', () => {
    const owners = [
      '<@U024BE7LH>',
      '<@W012AB3CD>',
      '<!subteam^SAZ94GDB8>',
      '<!here>',
      '<script>',
      '<@U1> <script>',
      '@ana',
    ];
    const header = (owner: string) =>
      texts(renderSlack(openedNotice(pr4Gate({ owner })), { mode: 'bot' }).blocks)[0];
    const escalation = (owner: string) =>
      renderSlack(
        composePersonNotice({
          kind: 'reminder',
          run_id: 'r4',
          gate: pr4Gate({ owner }),
          view: slackView(pr4Gate()),
          respond: respondWayOfGate('r4', pr4Gate()),
          scheduled_at: '2026-10-27T10:30:00.000Z',
          count: 1,
          escalation: true,
          now: new Date('2026-10-27T10:30:00.000Z'),
        }),
        { mode: 'bot' },
      ).text.split(' — ')[0];
    const shown = [
      '<@U024BE7LH>',
      '<@W012AB3CD>',
      '<!subteam^SAZ94GDB8>',
      '<!here>',
      '&lt;script&gt;',
      '&lt;@U1&gt; &lt;script&gt;',
      '@ana',
    ];
    // (a) red when the exception is removed (the mention escaped), widened to any `<…>`, or loses
    //     its `W` form, its special mentions or its anchoring; (b) prints the rendered owners.
    expect({
      header: owners.map(header),
      escalation: owners.map(escalation),
      direct: owners.map(slackOwner),
    }).toEqual({
      header: shown.map((o) => `*Gate:* \`review\`\n*Owner:* ${o}`),
      escalation: shown,
      direct: shown,
    });
  });

  it('the cut line’s way rides the context block, through the ways renderer', () => {
    // A question cut when it opened (its stored text ends with the sentence) is read as cut.
    const cut = pr4Gate({ resolved_message: `Approve?\n\n${CUT_SENTENCE(8, 900)}` });
    const notice = openedNotice(cut, 'run with space');
    const blocks = renderSlack(notice, { mode: 'bot' }).blocks as Block[];
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'slack-gate-notifier.ts'),
      'utf8',
    );
    // (a) red when the block is dropped, or a literal command string replaces the ways renderer
    //     (the run id renders the same either way, so the source is the witness); (b) prints the
    //     cut flag, the block's type and text, and a boolean.
    expect({
      cut: notice.kind === 'question_opened' && notice.view.cut !== undefined,
      type: blocks[3]?.type,
      text: blocks[3]?.elements?.[0]?.text,
      literal: source.includes('realm run inspect'),
    }).toEqual({
      cut: true,
      type: 'context',
      text: "The step's whole output: realm run inspect run with space",
      literal: false,
    });
  });

  it('the derivation (the channel table lives here): the worst escape MEASURED over every character the table escapes; floor(3000 / worst) carries VIEW_BUDGET', () => {
    // The channels Realm ships and their view limits, in Slack's unit (characters; every escape is
    // in the Basic Multilingual Plane, so a JS string's length — UTF-16 code units — equals its
    // character count here, measured below by code points).
    const CHANNELS = [
      { channel: 'Slack section text (mrkdwn)', limit: SLACK_SECTION_TEXT_LIMIT },
      { channel: 'terminal', limit: undefined },
      { channel: 'MCP form', limit: undefined },
    ];
    const chars = (text: string) => [...text].length;
    const ratios = Object.keys(SLACK_ESCAPES).map(
      (input) => chars(slackEscape(input)) / chars(input),
    );
    const worst = Math.max(...ratios);
    const smallest = Math.min(...CHANNELS.flatMap((c) => (c.limit !== undefined ? [c.limit] : [])));
    // (a) red when an escape grows past the budget's room (`&` → a 7-character entity: floor 428);
    //     (b) prints the measured worst case, the floor and the budget.
    expect({ worst, floor: Math.floor(smallest / worst), budget: VIEW_BUDGET }).toEqual({
      worst: 5,
      floor: 600,
      budget: 600,
    });
  });

  it('(h) on the view block: a 3,000-character `<` substitution and a 50k parameter post within 3,000 after escaping, the view after its one transform; a `<` preview is a shape (control)', async () => {
    const set = buildDisclosureSet({
      env: {},
      declared: { X: PR4_DECLARED },
      declaredState: 'resolved',
      audience: 'private',
    }).set;
    const definition = {
      id: 'h4',
      name: 'h4',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: {
        review: {
          description: 'd',
          execution: 'auto',
          trust: 'human_confirmed',
          gate: { choices: ['approve', 'reject'], message: 'Check {{ run.params.x }} now' },
        },
      },
    } as unknown as WorkflowDefinition;
    const minted = async (x: string) => {
      const store = new JsonFileStore(await mkdtemp(join(tmpdir(), 'realm-h4-')));
      const { run } = await store.create({ workflowId: 'h4', workflowVersion: 1, params: { x } });
      await executeStep(store, definition, {
        runId: run.id,
        command: 'review',
        input: {},
        dispatcher: async () => ({}),
        disclosure: set,
      });
      return (await store.get(run.id)).pending_gate!;
    };
    const blockOf = (gate: PendingGate) =>
      texts(renderSlack(openedNotice(gate), { mode: 'bot' }).blocks);
    const results = [];
    for (const x of ['<'.repeat(3000), 'y'.repeat(50_000)]) {
      const gate = await minted(x);
      const view = slackView(gate);
      const blocks = blockOf(gate);
      const expected = [slackEscape(view.question_text), slackEscape(view.preview_text)]
        .filter((part) => part !== '')
        .join('\n\n');
      results.push({
        within: blocks[1]!.length <= SLACK_SECTION_TEXT_LIMIT,
        same: blocks[1] === expected,
        separate: blocks[0] === '*Gate:* `review`' && blocks[2]!.startsWith('Reply in this thread'),
      });
    }
    const { resolved_message: _m, ...previewGate } = pr4Gate({
      preview: { blob: '<'.repeat(3000) },
    });
    const control = blockOf(previewGate)[1]!;
    // (a) red when the renderer skips the mint's fit (past 3,000), leaves `<` unescaped (the
    //     bytes differ), or folds the header into the view block; (b) prints booleans and the
    //     control's text.
    expect({ results, control }).toEqual({
      results: [
        { within: true, same: true, separate: true },
        { within: true, same: true, separate: true },
      ],
      control: '```\n{\n  "blob": "‹string, 3000 characters›"\n}\n```',
    });
  });
});

describe('#729 PR-4 — the asked person in Slack: the thread', () => {
  beforeEach(() => {
    vi.stubEnv('REALM_NOT_SECRET', '');
    vi.stubEnv(PR4_ENV_NAME, PR4_ENV_VALUE);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it('durations that cannot be read: the reminder and the expiry reminder say no duration, never `NaN` or `0s`', () => {
    const view = slackView(pr4Gate());
    const respond = respondWayOfGate('r4', pr4Gate());
    const now = new Date('2026-10-27T10:30:00.000Z');
    const reminder = renderSlack(
      composePersonNotice({
        kind: 'reminder',
        run_id: 'r4',
        gate: pr4Gate({ opened_at: 'not a time' }),
        view,
        respond,
        scheduled_at: now.toISOString(),
        count: 1,
        escalation: false,
        now,
      }),
      { mode: 'bot' },
    ).text;
    const expiry = renderSlack(
      composePersonNotice({
        kind: 'expiry_reminder',
        run_id: 'r4',
        gate: pr4Gate({ expires_at: '2026-10-27T10:30:05.000Z' }),
        view,
        respond,
        now,
      }),
      { mode: 'bot' },
    ).text;
    // (a) red when an unreadable stamp or a deadline ahead is formatted (`NaN…`, `0s ago`); (b)
    //     prints the two texts.
    expect([reminder, expiry]).toEqual([
      '⏰ gate `review` is still open. Please respond.',
      '⏰ gate `review` expired — nothing will be done automatically; it is still waiting for a response.',
    ]);
  });

  it('answer_recorded, the run goes on with no authored message: the choice and "run continuing"', () => {
    const text = renderSlack(
      composePersonNotice({
        kind: 'answer_recorded',
        run_id: 'r4',
        gate: pr4Gate(),
        choice: 'approve',
        ended: false,
      }),
      { mode: 'bot' },
    ).text;
    // (a) red when the confirmation loses its choice or invents a message; (b) prints the text.
    expect(text).toBe('✅ Gate resolved: `approve` — run continuing.');
  });

  it('answer_late per kind (answered by another, timed out with and without a choice, withdrawn) and answer_refused: the person’s words, no command', () => {
    const late = (
      outcome: Extract<PersonNotice, { kind: 'answer_late' }>['outcome'],
      ended: boolean,
    ) =>
      renderSlack(
        composePersonNotice({
          kind: 'answer_late',
          run_id: 'r4',
          gate: pr4Gate(),
          choice: 'reject',
          outcome,
          ended,
        }),
        { mode: 'bot' },
      ).text;
    const words = [
      late(
        {
          step: 'review',
          attempted: true,
          by: { kind: 'answer', basis: 'stated', name: 'sam' },
          choice: 'approve',
        } as never,
        false,
      ),
      late(
        { step: 'review', attempted: true, by: { kind: 'timeout' }, choice: 'reject' } as never,
        false,
      ),
      late({ step: 'review', attempted: true, by: { kind: 'timeout' } } as never, true),
      late({ step: 'review', attempted: true, by: { kind: 'engine' } } as never, true),
      renderSlack(
        composePersonNotice({
          kind: 'answer_refused',
          run_id: 'r4',
          gate: pr4Gate(),
          choice: 'approve',
          code: 'STATE_RUN_TERMINAL',
        }),
        { mode: 'bot' },
      ).text,
    ];
    // (a) red when a kind's words change or an operator command enters the thread; (b) prints the
    //     texts.
    expect({ words, command: words.some((w) => /realm /.test(w)) }).toEqual({
      words: [
        'This question was already answered by sam — `approve` — before your reply arrived. The run goes on.',
        "This question's time ran out before your reply arrived; it was settled as `reject`. The run goes on.",
        "This question's time ran out before your reply arrived; the run stopped. The run has ended.",
        'This question was withdrawn when the run stopped; your reply was not recorded. The run has ended.',
        "⚠️ Couldn't record your response (`STATE_RUN_TERMINAL`). Try again.",
      ],
      command: false,
    });
  });

  it('thread arms keep the `all` walk (S3): an environment fake in a resolution message, and in an outcome’s words, posts as `[REDACTED]`', async () => {
    const gate = pr4Gate({
      step_name: 'review',
      resolution_messages: { approve: `Shipping with ${PR4_ENV_VALUE}` },
    });
    const posts = vi.fn().mockResolvedValue(slackResponse({ json: { ok: true } }));
    vi.stubGlobal('fetch', posts);
    let onEvent: ((event: SlackGateEvent) => void) | undefined;
    vi.mocked(startSlackGateServer).mockImplementationOnce((opts) => {
      onEvent = opts.onEvent;
      return { close: vi.fn() };
    });
    const done = handleBidirectionalGate(makeGateParams({ gate, store: makeGateStore(gate) }));
    onEvent!({
      event_id: 'S3',
      thread_ts: '1234567890.000',
      user: 'U1',
      text: 'approve',
      ts: '1.1',
    });
    await done;
    await postSlackReply(
      'xoxb-fake',
      'C1',
      '1.0',
      renderSlack(
        composePersonNotice({
          kind: 'answer_late',
          run_id: 'r4',
          gate,
          choice: 'reject',
          outcome: {
            step: 'review',
            attempted: true,
            by: { kind: 'answer', basis: 'stated', name: PR4_ENV_VALUE },
            choice: 'approve',
          } as never,
          ended: false,
        }),
        { mode: 'bot' },
      ).text,
    );
    const replies = bodiesOf(posts).map((b) => b.text ?? '');
    // (a) red when an arm posts through the send directly (the fake in the thread); (b) prints
    //     booleans.
    expect({
      resolution: replies.some((t) => t.includes('Shipping with [REDACTED]')),
      outcome: replies.some((t) => t.includes('answered by [REDACTED]')),
      leaked: replies.some((t) => t.includes(PR4_ENV_VALUE)),
    }).toEqual({ resolution: true, outcome: true, leaked: false });
  });

  it.each(CLOSED_CASES)('question_closed in the bot poll: "$how"', async ({ how, record }) => {
    const posts = vi.fn().mockResolvedValue(slackResponse({ json: { ok: true } }));
    vi.stubGlobal('fetch', posts);
    await handleBidirectionalGate(
      makeGateParams({ gate: closedGate, store: storeReading(record) }),
    );
    // (a) red when nothing is posted at the poll's end, or `how` is mapped wrong; (b) prints the
    //     thread's texts.
    expect(bodiesOf(posts).map((b) => b.text)).toEqual([`This question is closed: ${how}.`]);
  });

  it.each(CLOSED_CASES)('question_closed in the webhook loop: "$how"', async ({ how, record }) => {
    const posts = vi.fn().mockResolvedValue(slackResponse({ text: 'ok' }));
    vi.stubGlobal('fetch', posts);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const handler = createSlackGateHandler({
      store: storeReading(record),
      definition: makeMinimalDefinition(),
      provider: {} as never,
      webhookUrl: 'https://hooks.slack.com/fake',
      pollIntervalMs: 0,
    });
    await handler('run1', closedGate);
    const bodies = bodiesOf(posts);
    // (a) red when the webhook loop posts nothing at its end, or `how` is mapped wrong; (b)
    //     prints the posts' count and the closed text.
    expect({ posts: bodies.length, closed: bodies[1]?.text }).toEqual({
      posts: 2,
      closed: `This question is closed: ${how}.`,
    });
  });

  it('control: a Slack answer recorded — no closed line follows the confirmation', async () => {
    const gate = pr4Gate();
    const posts = vi.fn().mockResolvedValue(slackResponse({ json: { ok: true } }));
    vi.stubGlobal('fetch', posts);
    let onEvent: ((event: SlackGateEvent) => void) | undefined;
    vi.mocked(startSlackGateServer).mockImplementationOnce((opts) => {
      onEvent = opts.onEvent;
      return { close: vi.fn() };
    });
    const done = handleBidirectionalGate(makeGateParams({ gate, store: makeGateStore(gate) }));
    onEvent!({
      event_id: 'C1',
      thread_ts: '1234567890.000',
      user: 'U1',
      text: 'approve',
      ts: '1.2',
    });
    await done;
    // (a) red when the closed line follows the person's own answer; (b) prints the thread's texts.
    expect(bodiesOf(posts).map((b) => b.text)).toEqual([
      '✅ Gate resolved: `approve` — run continuing.',
    ]);
  });
});

describe('#729 PR-4 — the Slack transport (02 §Transport): deadline, verdict, retry, drain', () => {
  let warns: ReturnType<typeof vi.spyOn>;
  let logs: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warns = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logs = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });
  const said = () =>
    [...warns.mock.calls, ...logs.mock.calls].map((c) => c.map(String).join(' ')).join('\n');
  const RESPOND_LINES =
    '   Approve: realm run respond run1 --gate g1 --choice approve\n   Reject: realm run respond run1 --gate g1 --choice reject';
  /** A fetch that never answers but rejects when its signal aborts (the deadline's only way out). */
  const silentSlack = () =>
    vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
  /** A fetch answering each call after `delays[i]` ms with `answers[i]` (the last repeats). */
  const timedSlack = (answers: Response[], delays: number[], delivered: boolean[] = []) =>
    vi.fn((_url: string, init: RequestInit) => {
      const i = Math.min(delivered.length, answers.length - 1);
      const n = delivered.push(false) - 1;
      return new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(
          () => {
            delivered[n] = true;
            resolve(answers[i]!);
          },
          delays[Math.min(n, delays.length - 1)],
        );
        init.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('aborted'));
        });
      });
    });
  const webhookHandler = (store: RunStore = makeMinimalStore()) =>
    createSlackGateHandler({
      store,
      definition: makeMinimalDefinition(),
      provider: {} as never,
      webhookUrl: 'https://hooks.slack.com/fake',
      pollIntervalMs: 0,
    });
  const botHandler = (store: RunStore = makeMinimalStore()) =>
    createSlackGateHandler({
      store,
      definition: makeMinimalDefinition(),
      provider: {} as never,
      botToken: 'xoxb-fake',
      channelId: 'C1',
      pollIntervalMs: 0,
      reminderIntervalMs: 1000,
      escalationThresholdMs: 1500,
    });

  it.each(['webhook', 'bot'] as const)(
    'the deadline (%s): a post Slack never answers fails at 30 s with its cause; the person’s respond lines are printed',
    async (mode) => {
      vi.useFakeTimers();
      const slack = silentSlack();
      vi.stubGlobal('fetch', slack);
      let settled = false;
      const done = (mode === 'webhook' ? webhookHandler() : botHandler())('run1', makeGate()).then(
        () => {
          settled = true;
        },
      );
      await vi.advanceTimersByTimeAsync(29_999);
      const before = settled;
      await vi.advanceTimersByTimeAsync(6_000);
      await done;
      // (a) red when the signal is not passed or AbortSignal.timeout replaces the helper (the post
      //     hangs: the cell times out), the cause line is missing, the respond lines are not
      //     printed, or (bot) a reminder timer starts without a thread; (b) prints booleans and the
      //     call count.
      expect({
        before,
        cause: said().includes('  ⚠  Slack did not answer within 30 s'),
        respond: said().includes(RESPOND_LINES),
        shownAbove: said().includes('shown above'),
        calls: slack.mock.calls.length,
      }).toEqual({ before: false, cause: true, respond: true, shownAbove: false, calls: 1 });
    },
  );

  it.each([
    ['webhook', slackResponse({ status: 400, text: 'invalid_payload' }), 'invalid_payload'],
    ['bot', slackResponse({ json: { ok: false, error: 'invalid_blocks' } }), 'invalid_blocks'],
  ] as const)(
    'the verdict (%s): a refused post names its cause and prints the respond lines; the false "shown above" is gone',
    async (mode, answer, cause) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer));
      await (mode === 'webhook' ? webhookHandler() : botHandler())('run1', makeGate());
      // (a) red when the status (webhook) or `ok` (bot) is ignored — no line, no respond lines;
      //     (b) prints booleans.
      expect({
        cause: said().includes(`  ⚠  Slack refused the post: ${cause}`),
        respond: said().includes(RESPOND_LINES),
        shownAbove: said().includes('shown above'),
      }).toEqual({ cause: true, respond: true, shownAbove: false });
    },
  );

  it('one bounded retry on 429: Retry-After 2 → one retry after 2 s with a FRESH deadline (25 s + 2 s + 10 s stands); the post stands', async () => {
    vi.useFakeTimers();
    const delivered: boolean[] = [];
    const slack = timedSlack(
      [
        slackResponse({ status: 429, headers: { 'Retry-After': '2' } }),
        slackResponse({ text: 'ok' }),
      ],
      [25_000, 10_000, 0],
      delivered,
    );
    vi.stubGlobal('fetch', slack);
    const done = webhookHandler()('run1', makeGate());
    await vi.advanceTimersByTimeAsync(40_000);
    await done;
    const retries = said().match(/Slack asked to wait 2 s before the post; retrying once/g) ?? [];
    // (a) red when there is no retry, more than one, or the second call shares the first's deadline
    //     (it would abort at 30 s: the cause line); (b) prints the counts and booleans.
    expect({
      retries: retries.length,
      openingCalls: bodiesOf(slack).filter((b) => b.blocks !== undefined).length,
      timedOut: said().includes('did not answer'),
      respond: said().includes(RESPOND_LINES),
    }).toEqual({ retries: 1, openingCalls: 2, timedOut: false, respond: false });
  });

  it('a Retry-After past the deadline (120 s): no retry, the refusal names `ratelimited`', async () => {
    const slack = vi
      .fn()
      .mockResolvedValue(slackResponse({ status: 429, headers: { 'Retry-After': '120' } }));
    vi.stubGlobal('fetch', slack);
    await webhookHandler()('run1', makeGate());
    // (a) red when a retry is made past the deadline (two calls), or the cause is not named; (b)
    //     prints the count and booleans.
    expect({
      calls: slack.mock.calls.length,
      cause: said().includes('  ⚠  Slack refused the post: ratelimited'),
      retried: said().includes('retrying once'),
    }).toEqual({ calls: 1, cause: true, retried: false });
  });

  const answeredElsewhere = CLOSED_CASES[2].record;
  it.each([
    ['bot', 500, true],
    ['bot', 5_000, false],
    ['webhook', 500, true],
    ['webhook', 5_000, false],
  ] as const)(
    'question_closed is awaited under the drain bound (%s, the post takes %i ms)',
    async (mode, delay, lands) => {
      vi.useFakeTimers();
      const delivered: boolean[] = [];
      const answers =
        mode === 'bot' ? [slackResponse({ json: { ok: true } })] : [slackResponse({ text: 'ok' })];
      // The webhook's opening post answers at once; the closed post takes `delay`.
      const slack = timedSlack(answers, mode === 'bot' ? [delay] : [0, delay], delivered);
      vi.stubGlobal('fetch', slack);
      const store = storeReading(answeredElsewhere);
      const done =
        mode === 'bot'
          ? handleBidirectionalGate(makeGateParams({ gate: closedGate, store }))
          : webhookHandler(store)('run1', closedGate);
      await vi.advanceTimersByTimeAsync(2_100);
      await done;
      const undelivered =
        said().match(/Slack thread post not delivered within 2 s; the question is closed/g) ?? [];
      // (a) red when the post is not tracked into the drain (bot) or not raced (webhook) — the
      //     500 ms post lost — when it is awaited without the bound (the 5 s case stalls), or when
      //     the line is missing as the bound fires; (b) prints booleans and the line's count.
      expect({ landed: delivered.at(-1), lines: undelivered.length }).toEqual({
        landed: lands,
        lines: lands ? 0 : 1,
      });
    },
  );

  it('the stubs: every Slack fetch stub in the four files is a full Response from `slackResponse` — no inline literal', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const files = [
      'slack-gate-notifier.test.ts',
      'slack-gate-ending-625.test.ts',
      'slack-gate-late-625.test.ts',
      'slack-disclosure-729.test.ts',
    ];
    const literal = [
      'mockResolvedValue' + '({',
      'mockResolvedValueOnce' + '({',
      'Promise.resolve' + '({',
      'json: ' + 'async',
    ];
    const count = files.map((file) => {
      const source = readFileSync(join(here, file), 'utf8');
      return {
        file,
        literals: literal.reduce((sum, form) => sum + source.split(form).length - 1, 0),
        helper: source.split('slackResponse(').length - 1 > 0,
      };
    });
    // (a) red when one inline Response literal is restored, or a file stops using the helper; (b)
    //     prints each file's counts.
    expect(count).toEqual(files.map((file) => ({ file, literals: 0, helper: true })));
  });
});
