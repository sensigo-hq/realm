// slack-gate-server.test.ts — Tests for the Slack Events API HTTP server.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { startSlackGateServer } from './slack-gate-server.js';
import type { SlackGateEvent } from './slack-gate-server.js';

const SECRET = 'test-signing-secret-x1y2z3';

// Ports are unique per test to avoid conflicts when tests run in parallel.
const BASE_PORT = 14500;

function signPayload(secret: string, timestamp: string, body: string): string {
  return 'v0=' + createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex');
}

function nowTs(): string {
  return Math.floor(Date.now() / 1000).toString();
}

async function waitForServer(port: number, maxMs = 200): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://localhost:${port}/slack/events`, { method: 'POST' });
      return;
    } catch {
      await new Promise<void>((r) => setTimeout(r, 20));
    }
  }
}

describe('startSlackGateServer', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('handles Slack URL verification challenge', async () => {
    const onEvent = vi.fn();
    const server = startSlackGateServer({ port: BASE_PORT, signingSecret: SECRET, onEvent });
    await waitForServer(BASE_PORT);

    const body = JSON.stringify({ type: 'url_verification', challenge: 'abc-xyz-challenge' });
    const ts = nowTs();
    const sig = signPayload(SECRET, ts, body);

    const response = await fetch(`http://localhost:${BASE_PORT}/slack/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Slack-Request-Timestamp': ts,
        'X-Slack-Signature': sig,
      },
      body,
    });

    expect(response.status).toBe(200);
    const result = (await response.json()) as { challenge: string };
    expect(result.challenge).toBe('abc-xyz-challenge');
    expect(onEvent).not.toHaveBeenCalled();
    server.close();
  });

  it('calls onEvent for a valid signed message event', async () => {
    const onEvent = vi.fn();
    const server = startSlackGateServer({ port: BASE_PORT + 1, signingSecret: SECRET, onEvent });
    await waitForServer(BASE_PORT + 1);

    const body = JSON.stringify({
      type: 'event_callback',
      team_id: 'T123ABC456',
      event_id: 'Ev001',
      event: {
        type: 'message',
        user: 'U123',
        text: 'approve this',
        ts: '1704067300.001',
        thread_ts: '1704067200.000',
      },
    });
    const ts = nowTs();
    const sig = signPayload(SECRET, ts, body);

    await fetch(`http://localhost:${BASE_PORT + 1}/slack/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Slack-Request-Timestamp': ts,
        'X-Slack-Signature': sig,
      },
      body,
    });

    // Allow async processing.
    await new Promise<void>((r) => setTimeout(r, 30));

    expect(onEvent).toHaveBeenCalledOnce();
    const event = onEvent.mock.calls[0]![0] as SlackGateEvent;
    expect(event.text).toBe('approve this');
    expect(event.user).toBe('U123');
    expect(event.thread_ts).toBe('1704067200.000');
    server.close();
  });

  it('returns 403 and does not call onEvent when signature is invalid', async () => {
    const onEvent = vi.fn();
    const server = startSlackGateServer({ port: BASE_PORT + 2, signingSecret: SECRET, onEvent });
    await waitForServer(BASE_PORT + 2);

    const body = JSON.stringify({
      type: 'event_callback',
      team_id: 'T123ABC456',
      event_id: 'Ev002',
      event: { type: 'message', user: 'U1', text: 'hi', ts: '1.0', thread_ts: '1.0' },
    });

    const response = await fetch(`http://localhost:${BASE_PORT + 2}/slack/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Slack-Request-Timestamp': nowTs(),
        'X-Slack-Signature': 'v0=badsignaturebadbad',
      },
      body,
    });

    expect(response.status).toBe(403);
    expect(onEvent).not.toHaveBeenCalled();
    server.close();
  });

  it('returns 403 for a stale timestamp (>5 min) before performing HMAC', async () => {
    const onEvent = vi.fn();
    const server = startSlackGateServer({ port: BASE_PORT + 3, signingSecret: SECRET, onEvent });
    await waitForServer(BASE_PORT + 3);

    const staleTs = (Math.floor(Date.now() / 1000) - 400).toString();
    const body = JSON.stringify({ type: 'url_verification', challenge: 'x' });
    // Signature is correct but timestamp is stale — server must reject before HMAC.
    const sig = signPayload(SECRET, staleTs, body);

    const response = await fetch(`http://localhost:${BASE_PORT + 3}/slack/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Slack-Request-Timestamp': staleTs,
        'X-Slack-Signature': sig,
      },
      body,
    });

    expect(response.status).toBe(403);
    expect(onEvent).not.toHaveBeenCalled();
    server.close();
  });

  it('returns 400 for a non-numeric X-Slack-Request-Timestamp before processing event', async () => {
    const onEvent = vi.fn();
    const server = startSlackGateServer({ port: BASE_PORT + 5, signingSecret: SECRET, onEvent });
    await waitForServer(BASE_PORT + 5);

    const body = JSON.stringify({ type: 'url_verification', challenge: 'x' });
    // Signature does not matter — server must reject before reaching HMAC.
    const response = await fetch(`http://localhost:${BASE_PORT + 5}/slack/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Slack-Request-Timestamp': 'not-a-number',
        'X-Slack-Signature': 'v0=irrelevant',
      },
      body,
    });

    expect(response.status).toBe(400);
    expect(onEvent).not.toHaveBeenCalled();
    server.close();
  });

  it('does not call onEvent for bot message events', async () => {
    const onEvent = vi.fn();
    const server = startSlackGateServer({ port: BASE_PORT + 4, signingSecret: SECRET, onEvent });
    await waitForServer(BASE_PORT + 4);

    const body = JSON.stringify({
      type: 'event_callback',
      team_id: 'T123ABC456',
      event_id: 'Ev003',
      event: {
        type: 'message',
        subtype: 'bot_message',
        bot_id: 'B123',
        text: 'Bot says hello',
        ts: '1704067350.001',
        thread_ts: '1704067200.000',
      },
    });
    const ts = nowTs();
    const sig = signPayload(SECRET, ts, body);

    const response = await fetch(`http://localhost:${BASE_PORT + 4}/slack/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Slack-Request-Timestamp': ts,
        'X-Slack-Signature': sig,
      },
      body,
    });

    expect(response.status).toBe(200);
    await new Promise<void>((r) => setTimeout(r, 30));
    expect(onEvent).not.toHaveBeenCalled();
    server.close();
  });

  it("#603 A3a check 15: the event's own team wins over the payload's team_id; user, ts and thread_ts are carried", async () => {
    const onEvent = vi.fn();
    const server = startSlackGateServer({ port: BASE_PORT + 6, signingSecret: SECRET, onEvent });
    await waitForServer(BASE_PORT + 6);
    // Slack's documented Events API body (docs.slack.dev, events-api.md: `team_id` beside `event`).
    const body = JSON.stringify({
      token: 'XXYYZZ',
      team_id: 'T123ABC456',
      api_app_id: 'A123ABC456',
      type: 'event_callback',
      event_id: 'Ev603',
      event_time: 1704067300,
      event: {
        type: 'message',
        team: 'T999OTHER',
        user: 'U123',
        text: 'approve',
        ts: '1704067300.001',
        thread_ts: '1704067200.000',
      },
    });
    const ts = nowTs();
    await fetch(`http://localhost:${BASE_PORT + 6}/slack/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Slack-Request-Timestamp': ts,
        'X-Slack-Signature': signPayload(SECRET, ts, body),
      },
      body,
    });
    await new Promise<void>((r) => setTimeout(r, 30));
    const { team, user, ts: at, thread_ts } = (onEvent.mock.calls[0]?.[0] ?? {}) as SlackGateEvent;
    // (1) red when this intake drops `team` (or prefers the payload's); (2) prints what it passed.
    expect({ team, user, ts: at, thread_ts }).toEqual({
      team: 'T999OTHER',
      user: 'U123',
      ts: '1704067300.001',
      thread_ts: '1704067200.000',
    });
    server.close();
  });
});
