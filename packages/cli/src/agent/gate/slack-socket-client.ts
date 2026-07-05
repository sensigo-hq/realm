// slack-socket-client.ts — Slack Socket Mode WebSocket client for gate thread event delivery.
// Opens a persistent WebSocket connection to Slack (no public URL required).
// Used when notifiers.slack_gate.app_token (xapp-...) is configured alongside bot_token.
import type { SlackGateEvent } from './slack-gate-server.js';

export interface SlackSocketConfig {
  /** App-level token (starts with xapp-) — notifiers.slack_gate.app_token. */
  appToken: string;
  /** Gate thread timestamp — only events in this thread are forwarded to onEvent. */
  threadTs: string;
  /** Called for each valid human message in the gate thread. */
  onEvent: (event: SlackGateEvent) => void;
  /** When aborted, the connection is closed and no reconnects are attempted. */
  signal?: AbortSignal;
}

/**
 * Opens a Slack Socket Mode WebSocket connection and begins delivering gate thread events.
 * Handles reconnection transparently on drops or Slack-requested refreshes.
 * Returns a handle to close the connection immediately.
 */
export function connectSocketMode(config: SlackSocketConfig): { close(): void } {
  const { appToken, threadTs, onEvent, signal } = config;
  let stopped = false;
  let currentWs: WebSocket | undefined;
  let backoffMs = 1000;

  const stop = (): void => {
    stopped = true;
    currentWs?.close();
  };

  const connect = async (): Promise<void> => {
    if (stopped || signal?.aborted) return;

    // Step 1 — obtain the WebSocket URL from Slack.
    let wsUrl: string;
    try {
      const response = await fetch('https://slack.com/api/apps.connections.open', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${appToken}`,
        },
      });
      const data = (await response.json()) as { ok: boolean; url?: string; error?: string };
      if (!data.ok || data.url === undefined) {
        const delay = backoffMs;
        backoffMs = Math.min(backoffMs * 2, 30_000);
        console.warn(
          `  ⚠  Socket Mode: apps.connections.open failed (${data.error ?? 'unknown'}) — retrying in ${delay}ms.`,
        );
        setTimeout(() => {
          if (!stopped && !signal?.aborted) {
            void connect();
          }
        }, delay);
        return;
      }
      wsUrl = data.url;
    } catch (err) {
      const delay = backoffMs;
      backoffMs = Math.min(backoffMs * 2, 30_000);
      console.warn(
        `  ⚠  Socket Mode: failed to obtain WebSocket URL — ${err instanceof Error ? err.message : String(err)}. Retrying in ${delay}ms.`,
      );
      setTimeout(() => {
        if (!stopped && !signal?.aborted) {
          void connect();
        }
      }, delay);
      return;
    }

    if (stopped || signal?.aborted) return;

    // Step 2 — open the WebSocket connection.
    const ws = new WebSocket(wsUrl);
    currentWs = ws;
    // Tracks deliberate closes (disconnect message) to skip backoff on the close event.
    let intentionalClose = false;

    ws.addEventListener('message', (event: MessageEvent) => {
      // A successful message indicates a live connection — reset backoff.
      backoffMs = 1000;

      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(event.data as string) as Record<string, unknown>;
      } catch {
        return;
      }

      const type = msg['type'] as string | undefined;

      if (type === 'hello') {
        console.log('  ℹ  Socket Mode connected.');
        return;
      }

      // Slack requesting a reconnect — close and reconnect immediately, no backoff.
      if (type === 'disconnect') {
        intentionalClose = true;
        ws.close();
        if (!stopped && !signal?.aborted) {
          void connect();
        }
        return;
      }

      if (type === 'events_api') {
        const envelopeId = msg['envelope_id'] as string | undefined;

        // ACK immediately (within 3 s as required by Slack).
        if (envelopeId !== undefined) {
          ws.send(JSON.stringify({ envelope_id: envelopeId }));
        }

        const payload = msg['payload'] as Record<string, unknown> | undefined;
        if (payload === undefined) return;

        const msgEvent = payload['event'] as Record<string, unknown> | undefined;
        if (msgEvent === undefined) return;

        // Use envelope_id as the dedup event_id (outer envelope is the authoritative key).
        const eventId = envelopeId ?? (payload['event_id'] as string | undefined);
        if (!eventId) return;

        // Apply all required filters before forwarding to onEvent.
        if (msgEvent['type'] !== 'message') return;
        if (msgEvent['bot_id'] !== undefined) return;
        if (msgEvent['subtype'] === 'bot_message') return;
        if (msgEvent['thread_ts'] !== threadTs) return;

        const user = msgEvent['user'] as string | undefined;
        if (!user) return;
        const text = msgEvent['text'] as string | undefined;
        if (!text) return;
        const ts = msgEvent['ts'] as string | undefined;
        if (!ts) return;

        onEvent({ event_id: eventId, thread_ts: threadTs, user, text, ts });
      }
    });

    ws.addEventListener('close', () => {
      if (stopped || signal?.aborted || intentionalClose) return;
      // Unexpected close — reconnect with exponential backoff (max 30 s).
      const delay = backoffMs;
      backoffMs = Math.min(backoffMs * 2, 30_000);
      setTimeout(() => {
        if (!stopped && !signal?.aborted) {
          void connect();
        }
      }, delay);
    });

    signal?.addEventListener(
      'abort',
      () => {
        stopped = true;
        ws.close();
      },
      { once: true },
    );
  };

  void connect();
  return { close: stop };
}
