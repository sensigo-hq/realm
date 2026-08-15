// slack-socket-client.test.ts — Unit tests for the Slack Socket Mode WebSocket client.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { connectSocketMode } from './slack-socket-client.js';
import type { SlackGateEvent } from './slack-gate-server.js';

// Flush the microtask queue to let async operations inside connect() complete.
const flushPromises = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

/** Minimal WebSocket mock — captures listeners and exposes an emit() helper. */
class MockWebSocket {
  static instances: MockWebSocket[] = [];
  private handlers: Map<string, Array<(e: unknown) => void>> = new Map();
  sent: string[] = [];

  constructor() {
    MockWebSocket.instances.push(this);
  }

  addEventListener(type: string, handler: (e: unknown) => void): void {
    const list = this.handlers.get(type) ?? [];
    list.push(handler);
    this.handlers.set(type, list);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    // noop — tests drive close events manually via emit('close')
  }

  /** Trigger all listeners registered for the given event type. */
  emit(type: string, data?: unknown): void {
    for (const h of this.handlers.get(type) ?? []) {
      h(data ?? {});
    }
  }
}

/** Build a valid events_api WebSocket message payload. */
function makeMessage(eventOverrides: Record<string, unknown> = {}): { data: string } {
  const event = {
    type: 'message',
    user: 'U123',
    text: 'approve',
    ts: '1704067300.001',
    thread_ts: 'gate.ts',
    ...eventOverrides,
  };
  return {
    data: JSON.stringify({
      type: 'events_api',
      envelope_id: 'Ev123',
      payload: { event_id: 'Ev123', event, type: 'events_api' },
    }),
  };
}

describe('connectSocketMode', () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal('WebSocket', MockWebSocket);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        json: (): Promise<{ ok: boolean; url: string }> =>
          Promise.resolve({ ok: true, url: 'wss://test' }),
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('calls onEvent for a valid human reply in the gate thread', async () => {
    const onEvent = vi.fn<(event: SlackGateEvent) => void>();
    connectSocketMode({ appToken: 'xapp-test', threadTs: 'gate.ts', onEvent });

    await flushPromises();

    MockWebSocket.instances[0]!.emit('message', makeMessage());

    expect(onEvent).toHaveBeenCalledOnce();
    expect(onEvent.mock.calls[0]![0]).toMatchObject({
      text: 'approve',
      user: 'U123',
      thread_ts: 'gate.ts',
    });
  });

  it('sends ACK with envelope_id after receiving a message', async () => {
    const onEvent = vi.fn<(event: SlackGateEvent) => void>();
    connectSocketMode({ appToken: 'xapp-test', threadTs: 'gate.ts', onEvent });

    await flushPromises();

    MockWebSocket.instances[0]!.emit('message', makeMessage());

    expect(MockWebSocket.instances[0]!.sent).toContain(JSON.stringify({ envelope_id: 'Ev123' }));
  });

  it('does not call onEvent for bot messages (bot_id present)', async () => {
    const onEvent = vi.fn();
    connectSocketMode({ appToken: 'xapp-test', threadTs: 'gate.ts', onEvent });

    await flushPromises();

    MockWebSocket.instances[0]!.emit('message', makeMessage({ bot_id: 'B123' }));

    expect(onEvent).not.toHaveBeenCalled();
  });

  it('does not call onEvent for bot_message subtype', async () => {
    const onEvent = vi.fn();
    connectSocketMode({ appToken: 'xapp-test', threadTs: 'gate.ts', onEvent });

    await flushPromises();

    MockWebSocket.instances[0]!.emit('message', makeMessage({ subtype: 'bot_message' }));

    expect(onEvent).not.toHaveBeenCalled();
  });

  it('does not call onEvent for messages in a different thread', async () => {
    const onEvent = vi.fn();
    connectSocketMode({ appToken: 'xapp-test', threadTs: 'gate.ts', onEvent });

    await flushPromises();

    MockWebSocket.instances[0]!.emit('message', makeMessage({ thread_ts: 'different.ts' }));

    expect(onEvent).not.toHaveBeenCalled();
  });

  it('reconnects when WebSocket close event fires (non-abort)', async () => {
    vi.useFakeTimers();
    const onEvent = vi.fn();
    connectSocketMode({ appToken: 'xapp-test', threadTs: 'gate.ts', onEvent });

    await flushPromises();
    expect(MockWebSocket.instances).toHaveLength(1);

    // Simulate an unexpected close.
    MockWebSocket.instances[0]!.emit('close');

    // Advance past the initial 1 s backoff and flush the new connect() promise chain.
    await vi.advanceTimersByTimeAsync(1100);
    await flushPromises();

    expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(2);
  });

  it('does not reconnect after abort signal fires', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const onEvent = vi.fn();
    connectSocketMode({
      appToken: 'xapp-test',
      threadTs: 'gate.ts',
      onEvent,
      signal: controller.signal,
    });

    await flushPromises();
    expect(MockWebSocket.instances).toHaveLength(1);

    controller.abort();
    MockWebSocket.instances[0]!.emit('close');

    await vi.advanceTimersByTimeAsync(2000);
    await flushPromises();

    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('retries with backoff when apps.connections.open returns ok: false', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        json: (): Promise<{ ok: boolean; error: string }> =>
          Promise.resolve({ ok: false, error: 'server_error' }),
      }),
    );
    const onEvent = vi.fn();
    connectSocketMode({
      appToken: 'xapp-test',
      threadTs: 'gate.ts',
      onEvent,
      signal: controller.signal,
    });

    await flushPromises();

    // No WebSocket should be created — URL fetch failed.
    expect(MockWebSocket.instances).toHaveLength(0);
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);

    // Advance past the 1 s backoff — a retry should be scheduled.
    await vi.advanceTimersByTimeAsync(1100);
    await flushPromises();

    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
    expect(MockWebSocket.instances).toHaveLength(0);

    controller.abort();
  });

  it('retries with backoff when fetch throws', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));
    const onEvent = vi.fn();
    connectSocketMode({
      appToken: 'xapp-test',
      threadTs: 'gate.ts',
      onEvent,
      signal: controller.signal,
    });

    await flushPromises();

    // No WebSocket should be created — fetch threw.
    expect(MockWebSocket.instances).toHaveLength(0);
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);

    // Advance past the 1 s backoff — a retry should be scheduled.
    await vi.advanceTimersByTimeAsync(1100);
    await flushPromises();

    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
    expect(MockWebSocket.instances).toHaveLength(0);

    controller.abort();
  });
});
