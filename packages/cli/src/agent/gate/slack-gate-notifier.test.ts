// slack-gate-notifier.test.ts — Tests for formatGatePreviewForSlack, owner Slack notification,
// startGateReminderTimers, postSlackReply, postGateViaApi, and bidirectional gate handling.
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  formatGatePreviewForSlack,
  postGateNotificationToSlack,
  postGateViaApi,
  startGateReminderTimers,
  postSlackReply,
  handleBidirectionalGate,
} from './slack-gate-notifier.js';
import type { BidirectionalGateParams } from './slack-gate-notifier.js';
import type { PendingGate, RunStore, WorkflowDefinition, StepHandler } from '@sensigo/realm';
import {
  JsonFileStore,
  ExtensionRegistry,
  executeStep,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
} from '@sensigo/realm';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LlmProvider } from '../providers/llm-provider.js';
import { startSlackGateServer } from './slack-gate-server.js';
import type { SlackGateEvent } from './slack-gate-server.js';
import { connectSocketMode } from './slack-socket-client.js';

// Module-level mocks are hoisted by vitest — slack-gate-notifier.ts will receive these stubs for
// its internal imports of slack-gate-server and slack-socket-client.
vi.mock('./slack-gate-server.js', () => ({
  startSlackGateServer: vi.fn().mockReturnValue({ close: vi.fn() }),
}));
vi.mock('./slack-socket-client.js', () => ({
  connectSocketMode: vi.fn().mockReturnValue({ close: vi.fn() }),
}));

describe('formatGatePreviewForSlack', () => {
  it('renders headline and message as formatted mrkdwn', () => {
    const preview = { headline: 'Deploy failed', message: 'The pipeline failed at step 3.' };
    const result = formatGatePreviewForSlack(preview);
    expect(result).toBe('*Deploy failed*\n\nThe pipeline failed at step 3.');
  });

  it('renders only headline when message is absent', () => {
    const preview = { headline: 'Deploy failed' };
    const result = formatGatePreviewForSlack(preview);
    expect(result).toBe('*Deploy failed*');
    expect(result).not.toContain('undefined');
  });

  it('falls back to formatted multi-line JSON when neither headline nor message is present', () => {
    const preview = { risk: 'high', title: 'Add feature' };
    const result = formatGatePreviewForSlack(preview);
    // Multi-line formatted JSON — not a single-line stringify
    expect(result).toContain('\n');
    expect(result).toContain('risk');
    expect(result).not.toBe(JSON.stringify(preview));
  });

  it('handles empty preview without throwing', () => {
    expect(() => formatGatePreviewForSlack({})).not.toThrow();
  });
});

describe('postGateNotificationToSlack — owner field', () => {
  it('uses resolved_message when present instead of formatGatePreviewForSlack fallback', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
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

  it('falls back to formatGatePreviewForSlack when resolved_message is absent', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
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
    // formatGatePreviewForSlack produces *Draft* for headline
    expect(bodyStr).toContain('*Draft*');
    expect(bodyStr).not.toContain('undefined');

    vi.unstubAllGlobals();
  });

  it('includes *Owner:* line when gate.owner is set', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
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
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
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
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
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
    await expect(
      postGateNotificationToSlack('https://hooks.slack.com/test', gate, 'run-id'),
    ).resolves.toBeUndefined();

    vi.unstubAllGlobals();
  });
});

describe('postGateViaApi — resolved_message', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses resolved_message when present instead of formatGatePreviewForSlack fallback', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, ts: '1234567890.000' }),
    });
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

  it('falls back to formatGatePreviewForSlack when resolved_message is absent', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, ts: '1234567890.001' }),
    });
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
    expect(bodyStr).toContain('*Draft headline*');
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
        return Promise.resolve({ json: async () => ({ ok: true }) });
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

    expect(calls.some((t) => t.includes('review_step') && t.includes('Reminder'))).toBe(true);
  });

  it('includes owner mention in escalation message when gate.owner is set', async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as { text: string };
        calls.push(body.text);
        return Promise.resolve({ json: async () => ({ ok: true }) });
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

    const escalationMsg = calls.find((t) => t.includes('review_step') && t.includes('minutes'));
    expect(escalationMsg).toBeDefined();
    expect(escalationMsg).toContain('@prod-oncall');
  });

  it('posts generic escalation message (no @ mention) when gate.owner is absent', async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as { text: string };
        calls.push(body.text);
        return Promise.resolve({ json: async () => ({ ok: true }) });
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

    const escalationMsg = calls.find((t) => t.includes('review_step') && t.includes('minutes'));
    expect(escalationMsg).toBeDefined();
    // No @ mention without owner
    expect(escalationMsg).not.toContain('@');
  });

  it('does not fire after clearTimers() is called', async () => {
    vi.useFakeTimers();
    const mockFetch = vi.fn().mockResolvedValue({ json: async () => ({ ok: true }) });
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
  return {
    get: vi.fn().mockResolvedValue({ terminal_state: 'completed', pending_gate: undefined }),
  } as unknown as RunStore;
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
    skipped_steps: [],
    evidence: [],
  };
  const get = vi.fn().mockResolvedValueOnce(openRun).mockResolvedValue(completedRun);
  const update = vi.fn().mockResolvedValue(completedRun);
  return { get, update } as unknown as RunStore;
}

function makeMinimalDefinition(): WorkflowDefinition {
  return { id: 'wf1', name: 'Test WF', version: '1', steps: {} } as unknown as WorkflowDefinition;
}

function makeGateParams(overrides: Partial<BidirectionalGateParams> = {}): BidirectionalGateParams {
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
    slackSigningSecret: 'secret',
    slackEventsPort: 3100,
    gateReminderIntervalMs: 999_999,
    gateEscalationThresholdMs: 999_999,
    pollIntervalMs: 0,
    ...overrides,
  };
}

describe('handleBidirectionalGate', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals(); // restore the repeated stubGlobal('fetch', …)
    vi.restoreAllMocks(); // restore console spies between tests
  });

  it('does not start Events server when gateThreadTs is undefined', async () => {
    await handleBidirectionalGate(makeGateParams({ gateThreadTs: undefined }));

    expect(startSlackGateServer).not.toHaveBeenCalled();
  });

  it('emits fallback notice when gateThreadTs is undefined', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleBidirectionalGate(makeGateParams({ gateThreadTs: undefined }));

    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('Bidirectional Slack resolution unavailable');

    logSpy.mockRestore();
  });

  it('duplicate event_id triggers only one candidate processing attempt', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));

    let capturedOnEvent: ((event: SlackGateEvent) => void) | undefined;
    vi.mocked(startSlackGateServer).mockImplementationOnce((opts) => {
      capturedOnEvent = opts.onEvent;
      return { close: vi.fn() };
    });

    // Use a fetch spy to count how many clarification replies are sent.
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
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
    const replyCalls = fetchSpy.mock.calls.filter(([url]: [string]) =>
      (url as string).includes('postMessage'),
    );
    expect(replyCalls).toHaveLength(1);
  });

  it('selects Socket Mode (connectSocketMode) when slackAppToken is set and slackSigningSecret is absent', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));

    await handleBidirectionalGate(
      makeGateParams({ slackSigningSecret: undefined, slackAppToken: 'xapp-test' }),
    );

    expect(connectSocketMode).toHaveBeenCalledOnce();
    expect(startSlackGateServer).not.toHaveBeenCalled();
  });

  it('selects Socket Mode over Events API when both slackAppToken and slackSigningSecret are set', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));

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
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);

    let capturedOnEvent: ((event: SlackGateEvent) => void) | undefined;
    vi.mocked(startSlackGateServer).mockImplementationOnce((opts) => {
      capturedOnEvent = opts.onEvent;
      return { close: vi.fn() };
    });

    const promise = handleBidirectionalGate(makeGateParams({ gate, store: makeGateStore(gate) }));
    expect(capturedOnEvent).toBeDefined();

    capturedOnEvent!({
      event_id: 'E1',
      thread_ts: '1234567890.000',
      user: 'U1',
      text: 'approve',
      ts: '1234567890.001',
    });

    await promise;

    const replyCalls = mockFetch.mock.calls.filter(([url]: [string]) =>
      (url as string).includes('postMessage'),
    );
    expect(replyCalls.length).toBeGreaterThan(0);
    const replyBody = JSON.parse(replyCalls[replyCalls.length - 1][1].body as string) as {
      text: string;
    };
    expect(replyBody.text).toContain('approve');
  });

  it('non-exact input sends a clarification reply listing valid choices', async () => {
    const gate: PendingGate = {
      gate_id: 'g1',
      step_name: 'confirm_review',
      preview: { headline: 'PR #42' },
      choices: ['approve', 'request_changes'],
      opened_at: new Date().toISOString(),
    };
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
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

    const replyCalls = mockFetch.mock.calls.filter(([url]: [string]) =>
      (url as string).includes('postMessage'),
    );
    expect(replyCalls).toHaveLength(1); // EXACT — the drain closes the dedupe-masking window
    const replyBody = JSON.parse(replyCalls[replyCalls.length - 1][1].body as string) as {
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
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
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

    const replyCalls = mockFetch.mock.calls.filter(([url]: [string]) =>
      (url as string).includes('postMessage'),
    );
    expect(replyCalls).toHaveLength(1); // the confirmation reply (only posted on submit success)
    const body = JSON.parse(replyCalls[0][1].body as string) as { text: string };
    expect(body.text).toContain('approve');
  });

  // Bounded drain: a hung Slack (postSlackReply's fetch never resolves) must NOT stall the run loop.
  it('bounded drain: a never-resolving reply does not hang the gate handler (returns within the bound)', async () => {
    const gate: PendingGate = {
      gate_id: 'g1',
      step_name: 'confirm_review',
      preview: { headline: 'PR #9' },
      choices: ['approve', 'request_changes'],
      opened_at: new Date().toISOString(),
    };
    // fetch (used by postSlackReply's confirmation) never resolves → processCandidate hangs after
    // the store write; the finally's bounded drain must give up after DRAIN_TIMEOUT_MS.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {})),
    );

    let capturedOnEvent: ((event: SlackGateEvent) => void) | undefined;
    vi.mocked(startSlackGateServer).mockImplementationOnce((opts) => {
      capturedOnEvent = opts.onEvent;
      return { close: vi.fn() };
    });

    const promise = handleBidirectionalGate(makeGateParams({ gate, store: makeGateStore(gate) }));
    expect(capturedOnEvent).toBeDefined();
    capturedOnEvent!({
      event_id: 'H1',
      thread_ts: '1234567890.000',
      user: 'U1',
      text: 'approve',
      ts: '1234567890.001',
    });

    const start = Date.now();
    await promise; // must resolve via the bounded drain, not hang on the never-resolving reply
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(4500); // bounded — without the drain-timeout it would hang to 5s
    expect(elapsed).toBeGreaterThanOrEqual(1500); // the drain actually engaged (~DRAIN_TIMEOUT_MS)
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
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
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
    const store = {
      get: vi.fn(async () => (updateAttempted ? terminalRun : openRun)),
      update: vi.fn(async () => {
        updateAttempted = true;
        throw new Error('persist failed');
      }),
    } as unknown as RunStore;

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

    const replyCalls = mockFetch.mock.calls.filter(([url]: [string]) =>
      (url as string).includes('postMessage'),
    );
    expect(replyCalls).toHaveLength(1); // exactly one error reply — never posts twice
    const body = JSON.parse(replyCalls[0][1].body as string) as { text: string };
    expect(body.text).toContain("Couldn't record your response");
    // Not a confirmation → the success branch (confirmation + abort) did NOT run; gate not resolved.
    expect(body.text).not.toContain('run continuing');
    expect(body.text).not.toContain('Gate resolved');
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

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
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
