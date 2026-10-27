// slack-gate-notifier.test.ts — Tests for the gate post's view block, owner Slack notification,
// startGateReminderTimers, postSlackReply, postGateViaApi, and bidirectional gate handling.
import { declared } from '../../test-support/declared.js';
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  renderSlack,
  slackView,
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
} from '@sensigo/realm';
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
    get: vi.fn().mockResolvedValue({ terminal_state: 'completed', pending_gate: undefined }),
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
