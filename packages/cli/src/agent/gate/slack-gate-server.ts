// slack-gate-server.ts — Minimal HTTP server for Slack Events API callbacks.
// Handles POST /slack/events with HMAC-SHA256 signature verification.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';

/** A verified, filtered Slack message event from the gate thread. */
export interface SlackGateEvent {
  /** Dedupe key from the Slack event envelope. */
  event_id: string;
  /** Thread timestamp — must match the gate notification message ts. */
  thread_ts: string;
  /** Slack user ID of the message author. */
  user: string;
  /** Raw message text to be interpreted. */
  text: string;
  /** Slack event timestamp (format: '1234567890.123456'). */
  ts: string;
}

export interface SlackGateServerOptions {
  /** Local port to listen on. Default: 3100. Configured via notifiers.slack_gate.events_port in realm.yaml. */
  port: number;
  /** Slack signing secret for HMAC-SHA256 verification. Never logged. */
  signingSecret: string;
  /** Called for each valid, non-bot message event that passes verification. */
  onEvent: (event: SlackGateEvent) => void;
}

/**
 * Starts a local HTTP server that receives Slack Events API callbacks.
 * Verifies request signatures before processing any payload.
 * Returns a handle to close the server.
 */
export function startSlackGateServer(options: SlackGateServerOptions): { close(): void } {
  const { port, signingSecret, onEvent } = options;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'POST' || req.url !== '/slack/events') {
      res.writeHead(404);
      res.end();
      return;
    }

    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      const timestamp = req.headers['x-slack-request-timestamp'];
      const signature = req.headers['x-slack-signature'];

      if (typeof timestamp !== 'string' || typeof signature !== 'string') {
        res.writeHead(403);
        res.end('Missing Slack signature headers');
        return;
      }

      // Reject stale requests before performing HMAC — prevents replay attacks.
      const requestTime = parseInt(timestamp, 10);
      if (isNaN(requestTime)) {
        res.writeHead(400);
        res.end('Invalid timestamp');
        return;
      }
      const nowSec = Math.floor(Date.now() / 1000);
      if (Math.abs(nowSec - requestTime) > 300) {
        res.writeHead(403);
        res.end('Stale request');
        return;
      }

      // Verify HMAC-SHA256 signature using timing-safe comparison.
      const baseString = `v0:${timestamp}:${rawBody}`;
      const expected = 'v0=' + createHmac('sha256', signingSecret).update(baseString).digest('hex');
      const expectedBuf = Buffer.from(expected, 'utf8');
      const receivedBuf = Buffer.from(signature, 'utf8');
      const signaturesMatch =
        expectedBuf.length === receivedBuf.length && timingSafeEqual(expectedBuf, receivedBuf);

      if (!signaturesMatch) {
        res.writeHead(403);
        res.end('Invalid signature');
        return;
      }

      // Parse the verified payload.
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(rawBody) as Record<string, unknown>;
      } catch {
        res.writeHead(400);
        res.end('Invalid JSON');
        return;
      }

      // Handle Slack URL verification challenge.
      if (payload['type'] === 'url_verification') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ challenge: payload['challenge'] }));
        return;
      }

      // Acknowledge immediately — Slack requires a response within 3 seconds.
      res.writeHead(200);
      res.end();

      if (payload['type'] !== 'event_callback') return;

      const event = payload['event'] as Record<string, unknown> | undefined;
      if (event === undefined) return;
      if (event['type'] !== 'message') return;

      // Filter bot messages — only route human replies.
      if (event['subtype'] === 'bot_message' || event['bot_id'] !== undefined) return;

      const threadTs = event['thread_ts'] as string | undefined;
      const user = event['user'] as string | undefined;
      const text = event['text'] as string | undefined;
      const ts = event['ts'] as string | undefined;
      const eventId = payload['event_id'] as string | undefined;

      if (!threadTs || !user || !text || !ts || !eventId) return;

      onEvent({ event_id: eventId, thread_ts: threadTs, user, text, ts });
    });
  });

  server.listen(port);

  return {
    close() {
      server.close();
    },
  };
}
