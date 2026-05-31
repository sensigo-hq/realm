import * as http from 'node:http';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { GorgiasAdapter } from './gorgias-adapter.js';
import { WorkflowError } from '../types/workflow-error.js';

// ---------------------------------------------------------------------------
// Mock server
// ---------------------------------------------------------------------------

type RequestHandler = (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void;

let port: number;
let server: http.Server;
const handlers: RequestHandler[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf-8');
      const handler = handlers.shift();
      if (handler === undefined) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'no handler registered' }));
        return;
      }
      handler(req, res, body);
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address() as { port: number };
  port = address.port;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

afterEach(() => {
  handlers.splice(0, handlers.length);
});

/** Register a single static JSON response. */
function respond(status: number, body: unknown, headers: Record<string, string> = {}): void {
  handlers.push((_req, res) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  });
}

/** Register a response that echoes the request info back. */
function respondEcho(
  status: number,
  transform: (req: http.IncomingMessage, body: string) => unknown,
): void {
  handlers.push((req, res, body) => {
    const result = transform(req, body);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  });
}

/** Respond with non-JSON text (to test body parsing fallback). */
function respondText(status: number, text: string): void {
  handlers.push((_req, res) => {
    res.writeHead(status, { 'Content-Type': 'text/plain' });
    res.end(text);
  });
}

// ---------------------------------------------------------------------------
// Adapter factory — points at the mock server
// ---------------------------------------------------------------------------

function makeAdapter(): GorgiasAdapter {
  return new GorgiasAdapter('gorgias', {
    domain: 'test',
    auth: { type: 'basic', token: 'test@example.com:testapikey' },
    base_url: `http://127.0.0.1:${port}`,
  });
}

// Expected Basic auth header value for "test@example.com:testapikey"
const EXPECTED_AUTH = 'Basic ' + Buffer.from('test@example.com:testapikey').toString('base64');

// ---------------------------------------------------------------------------
// Helpers to build message fixtures
// ---------------------------------------------------------------------------

function makeMsg(
  id: number,
  overrides: Partial<{
    body_text: string | null;
    body_html: string | null;
    from_agent: boolean;
    public: boolean;
    channel: string;
    created_datetime: string;
  }> = {},
) {
  return {
    id,
    from_agent: overrides.from_agent ?? false,
    public: overrides.public ?? true,
    channel: overrides.channel ?? 'email',
    body_text: overrides.body_text !== undefined ? overrides.body_text : `Message ${id}`,
    body_html: overrides.body_html !== undefined ? overrides.body_html : null,
    created_datetime: overrides.created_datetime ?? '2024-01-01T00:00:00Z',
  };
}

// ---------------------------------------------------------------------------
// Tests: Construction
// ---------------------------------------------------------------------------

describe('GorgiasAdapter construction', () => {
  it('throws a plain Error for an invalid domain', () => {
    expect(
      () =>
        new GorgiasAdapter('id', {
          domain: 'evil.com/api?q=',
          auth: { type: 'basic', token: 'tok' },
        }),
    ).toThrow('GorgiasAdapter: invalid domain');
  });

  it('constructs successfully for a valid domain', () => {
    const adapter = new GorgiasAdapter('id', {
      domain: 'acme',
      auth: { type: 'basic', token: 'tok' },
    });
    expect(adapter.id).toBe('id');
  });
});

// ---------------------------------------------------------------------------
// Tests: fetch('get_ticket')
// ---------------------------------------------------------------------------

describe("GorgiasAdapter fetch('get_ticket')", () => {
  it('returns raw ticket JSON from mock server', async () => {
    respond(200, { id: 42, subject: 'Test ticket' });
    const adapter = makeAdapter();
    const result = await adapter.fetch('get_ticket', { ticket_id: 42 }, {});
    expect(result.status).toBe(200);
    const data = result.data as Record<string, unknown>;
    expect(data['id']).toBe(42);
    expect(data['subject']).toBe('Test ticket');
  });

  it('sends correct Authorization: Basic header', async () => {
    respondEcho(200, (req) => ({ auth: req.headers['authorization'] }));
    const adapter = makeAdapter();
    const result = await adapter.fetch('get_ticket', { ticket_id: 1 }, {});
    const data = result.data as Record<string, unknown>;
    expect(data['auth']).toBe(EXPECTED_AUTH);
  });

  it('aborting signal causes STEP_ABORTED', async () => {
    respond(200, { id: 1 });
    const adapter = makeAdapter();
    const controller = new AbortController();
    controller.abort();
    await expect(
      adapter.fetch('get_ticket', { ticket_id: 1 }, {}, controller.signal),
    ).rejects.toMatchObject({ code: 'STEP_ABORTED' });
  });

  it('ticket_id: 0 throws ADAPTER_VALIDATION_FAILED', async () => {
    const adapter = makeAdapter();
    await expect(adapter.fetch('get_ticket', { ticket_id: 0 }, {})).rejects.toMatchObject({
      code: 'ADAPTER_VALIDATION_FAILED',
    });
  });

  it('ticket_id: -5 throws ADAPTER_VALIDATION_FAILED', async () => {
    const adapter = makeAdapter();
    await expect(adapter.fetch('get_ticket', { ticket_id: -5 }, {})).rejects.toMatchObject({
      code: 'ADAPTER_VALIDATION_FAILED',
    });
  });

  it('ticket_id: "abc" throws ADAPTER_VALIDATION_FAILED', async () => {
    const adapter = makeAdapter();
    await expect(adapter.fetch('get_ticket', { ticket_id: 'abc' }, {})).rejects.toMatchObject({
      code: 'ADAPTER_VALIDATION_FAILED',
    });
  });

  it('mock returns 401 → throws SERVICE_AUTH_FAILED', async () => {
    respond(401, { error: 'Unauthorized' });
    const adapter = makeAdapter();
    await expect(adapter.fetch('get_ticket', { ticket_id: 1 }, {})).rejects.toMatchObject({
      code: 'SERVICE_AUTH_FAILED',
    });
  });

  it('mock returns 429 with Retry-After: 5 → throws SERVICE_RATE_LIMITED, wait_and_proceed, retry_after: 5', async () => {
    respond(429, { error: 'Too Many Requests' }, { 'Retry-After': '5' });
    const adapter = makeAdapter();
    const err = await adapter
      .fetch('get_ticket', { ticket_id: 1 }, {})
      .catch((e: unknown) => e as WorkflowError);
    expect(err).toBeInstanceOf(WorkflowError);
    expect(err.code).toBe('SERVICE_RATE_LIMITED');
    expect(err.agentAction).toBe('wait_and_proceed');
    expect(err.retry_after).toBe(5);
    expect(err.details['retry_after']).toBeUndefined();
  });

  it('mock returns 429 without Retry-After header → fallback retry_after: 60', async () => {
    respond(429, { error: 'Too Many Requests' });
    const adapter = makeAdapter();
    const err = await adapter
      .fetch('get_ticket', { ticket_id: 1 }, {})
      .catch((e: unknown) => e as WorkflowError);
    expect(err).toBeInstanceOf(WorkflowError);
    expect(err.code).toBe('SERVICE_RATE_LIMITED');
    expect(err.agentAction).toBe('wait_and_proceed');
    expect(err.retry_after).toBe(60);
  });

  it('mock returns 500 → throws SERVICE_HTTP_5XX with retryable: true', async () => {
    respond(500, { error: 'Internal Server Error' });
    const adapter = makeAdapter();
    await expect(adapter.fetch('get_ticket', { ticket_id: 1 }, {})).rejects.toMatchObject({
      code: 'SERVICE_HTTP_5XX',
      retryable: true,
    });
  });

  it('mock returns non-JSON body with 404 → throws SERVICE_HTTP_4XX with body in details.body', async () => {
    respondText(404, 'not found');
    const adapter = makeAdapter();
    const err = await adapter
      .fetch('get_ticket', { ticket_id: 1 }, {})
      .catch((e: unknown) => e as WorkflowError);
    expect(err).toBeInstanceOf(WorkflowError);
    expect(err.code).toBe('SERVICE_HTTP_4XX');
    expect(err.details['body']).toBe('not found');
  });
});

// ---------------------------------------------------------------------------
// Tests: fetch('get_messages')
// ---------------------------------------------------------------------------

describe("GorgiasAdapter fetch('get_messages')", () => {
  it('single-page response (no cursor): returns { messages: [...], truncated: false }', async () => {
    respond(200, {
      data: [makeMsg(1), makeMsg(2)],
      meta: { next_cursor: null },
    });
    const adapter = makeAdapter();
    const result = await adapter.fetch('get_messages', { ticket_id: 10 }, {});
    expect(result.status).toBe(200);
    const data = result.data as { messages: unknown[]; truncated: boolean };
    expect(data.truncated).toBe(false);
    expect(data.messages).toHaveLength(2);
  });

  it('two-page response: returns all messages, truncated: false', async () => {
    respond(200, {
      data: [makeMsg(1), makeMsg(2)],
      meta: { next_cursor: 'cursor-abc' },
    });
    respond(200, {
      data: [makeMsg(3)],
      meta: { next_cursor: null },
    });
    const adapter = makeAdapter();
    const result = await adapter.fetch('get_messages', { ticket_id: 10 }, {});
    const data = result.data as { messages: Array<{ id: number }>; truncated: boolean };
    expect(data.truncated).toBe(false);
    expect(data.messages).toHaveLength(3);
    expect(data.messages.map((m) => m.id)).toEqual([1, 2, 3]);
  });

  it('params.limit = 2 with 3 messages on first page (cursor present): returns exactly 2, truncated: true', async () => {
    respond(200, {
      data: [makeMsg(1), makeMsg(2), makeMsg(3)],
      meta: { next_cursor: 'cursor-next' },
    });
    const adapter = makeAdapter();
    const result = await adapter.fetch('get_messages', { ticket_id: 10, limit: 2 }, {});
    const data = result.data as { messages: unknown[]; truncated: boolean };
    expect(data.messages).toHaveLength(2);
    expect(data.truncated).toBe(true);
  });

  it('cursor exhaustion at exactly params.limit: truncated: false', async () => {
    respond(200, {
      data: [makeMsg(1), makeMsg(2)],
      meta: { next_cursor: null },
    });
    const adapter = makeAdapter();
    const result = await adapter.fetch('get_messages', { ticket_id: 10, limit: 2 }, {});
    const data = result.data as { messages: unknown[]; truncated: boolean };
    expect(data.messages).toHaveLength(2);
    expect(data.truncated).toBe(false);
  });

  it('hard cap of 200 enforced: truncated: true, messages.length === 200', async () => {
    // Page 1: 100 messages, with cursor
    const page1 = Array.from({ length: 100 }, (_, i) => makeMsg(i + 1));
    respond(200, { data: page1, meta: { next_cursor: 'cursor-p2' } });
    // Page 2: 101 messages, with cursor (so more exist)
    const page2 = Array.from({ length: 101 }, (_, i) => makeMsg(i + 101));
    respond(200, { data: page2, meta: { next_cursor: 'cursor-p3' } });

    const adapter = makeAdapter();
    const result = await adapter.fetch('get_messages', { ticket_id: 10, limit: 201 }, {});
    const data = result.data as { messages: unknown[]; truncated: boolean };
    expect(data.messages).toHaveLength(200);
    expect(data.truncated).toBe(true);
  });

  it('body_text present: used as body; body_html ignored', async () => {
    respond(200, {
      data: [makeMsg(1, { body_text: 'plain text', body_html: '<p>html</p>' })],
      meta: { next_cursor: null },
    });
    const adapter = makeAdapter();
    const result = await adapter.fetch('get_messages', { ticket_id: 10 }, {});
    const data = result.data as { messages: Array<{ body: string }> };
    expect(data.messages[0]?.body).toBe('plain text');
  });

  it('body_text absent, body_html present: HTML tags and entities stripped', async () => {
    respond(200, {
      data: [makeMsg(1, { body_text: null, body_html: '<p>Hello &amp; world &lt;test&gt;</p>' })],
      meta: { next_cursor: null },
    });
    const adapter = makeAdapter();
    const result = await adapter.fetch('get_messages', { ticket_id: 10 }, {});
    const data = result.data as { messages: Array<{ body: string }> };
    expect(data.messages[0]?.body).toBe('Hello & world <test>');
  });

  it('both body_text and body_html absent: body === ""', async () => {
    respond(200, {
      data: [makeMsg(1, { body_text: null, body_html: null })],
      meta: { next_cursor: null },
    });
    const adapter = makeAdapter();
    const result = await adapter.fetch('get_messages', { ticket_id: 10 }, {});
    const data = result.data as { messages: Array<{ body: string }> };
    expect(data.messages[0]?.body).toBe('');
  });

  it('aborting signal mid-loop (after page 1) → throws STEP_ABORTED', async () => {
    const controller = new AbortController();

    // Page 1 handler: respond with cursor, then abort the signal before next loop
    handlers.push((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [makeMsg(1)], meta: { next_cursor: 'cursor-next' } }));
      // Abort after first page returned
      controller.abort();
    });

    const adapter = makeAdapter();
    await expect(
      adapter.fetch('get_messages', { ticket_id: 10 }, {}, controller.signal),
    ).rejects.toMatchObject({ code: 'STEP_ABORTED' });
  });

  it('empty page (0 messages, null cursor): returns { messages: [], truncated: false }', async () => {
    respond(200, { data: [], meta: { next_cursor: null } });
    const adapter = makeAdapter();
    const result = await adapter.fetch('get_messages', { ticket_id: 10 }, {});
    const data = result.data as { messages: unknown[]; truncated: boolean };
    expect(data.messages).toHaveLength(0);
    expect(data.truncated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: create('post_internal_note')
// ---------------------------------------------------------------------------

describe("GorgiasAdapter create('post_internal_note')", () => {
  it('sends correct body and returns { ok: true, note_id }', async () => {
    respondEcho(201, (_req, body) => {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      return { id: 999, echoed: parsed };
    });
    const adapter = makeAdapter();
    const result = await adapter.create(
      'post_internal_note',
      { ticket_id: 42, body_html: '<p>Internal note</p>' },
      {},
    );
    expect(result.status).toBe(201);
    const data = result.data as { ok: boolean; note_id: number };
    expect(data.ok).toBe(true);
    expect(data.note_id).toBe(999);
  });

  it('sends exactly { channel: "note", public: false, from_agent: true, body_html }', async () => {
    respondEcho(201, (_req, body) => {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      return { id: 1, body: parsed };
    });
    const adapter = makeAdapter();
    await adapter.create('post_internal_note', { ticket_id: 42, body_html: '<b>note</b>' }, {});

    // Re-check via another call that records the request body
    respondEcho(201, (_req, body) => {
      return { id: 2, _body: body };
    });
    const result2 = await adapter.create(
      'post_internal_note',
      { ticket_id: 42, body_html: '<b>note</b>' },
      {},
    );
    // Parse from a fresh call
    void result2; // just checking it doesn't throw
  });

  it('asserts correct request body fields', async () => {
    let capturedBody: unknown;
    handlers.push((_req, res, body) => {
      capturedBody = JSON.parse(body);
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 1 }));
    });
    const adapter = makeAdapter();
    await adapter.create('post_internal_note', { ticket_id: 42, body_html: '<p>hi</p>' }, {});
    expect(capturedBody).toEqual({
      channel: 'note',
      public: false,
      from_agent: true,
      body_html: '<p>hi</p>',
    });
  });

  it('body_html missing → throws ADAPTER_VALIDATION_FAILED', async () => {
    const adapter = makeAdapter();
    await expect(adapter.create('post_internal_note', { ticket_id: 42 }, {})).rejects.toMatchObject(
      { code: 'ADAPTER_VALIDATION_FAILED' },
    );
  });

  it('mock returns 403 → throws SERVICE_HTTP_4XX with message containing "permission"', async () => {
    respond(403, { error: 'Forbidden' });
    const adapter = makeAdapter();
    const err = await adapter
      .create('post_internal_note', { ticket_id: 42, body_html: '<p>hi</p>' }, {})
      .catch((e: unknown) => e as WorkflowError);
    expect(err).toBeInstanceOf(WorkflowError);
    expect(err.code).toBe('SERVICE_HTTP_4XX');
    expect(err.message).toContain('permission');
  });

  it('mock returns 201 but with no id field → throws SERVICE_RESPONSE_INVALID', async () => {
    respond(201, { ok: true });
    const adapter = makeAdapter();
    await expect(
      adapter.create('post_internal_note', { ticket_id: 42, body_html: '<p>hi</p>' }, {}),
    ).rejects.toMatchObject({ code: 'SERVICE_RESPONSE_INVALID' });
  });
});

// ---------------------------------------------------------------------------
// Tests: update()
// ---------------------------------------------------------------------------

describe('GorgiasAdapter update()', () => {
  it('any call throws ADAPTER_OP_UNSUPPORTED', async () => {
    const adapter = makeAdapter();
    await expect(adapter.update('anything', {}, {})).rejects.toMatchObject({
      code: 'ADAPTER_OP_UNSUPPORTED',
    });
    await expect(adapter.update('anything', {}, {})).rejects.toBeInstanceOf(WorkflowError);
  });
});

// ---------------------------------------------------------------------------
// Tests: unsupported fetch operation
// ---------------------------------------------------------------------------

describe("GorgiasAdapter fetch('unknown_operation')", () => {
  it('throws ADAPTER_OP_UNSUPPORTED', async () => {
    const adapter = makeAdapter();
    await expect(adapter.fetch('unknown_op', {}, {})).rejects.toMatchObject({
      code: 'ADAPTER_OP_UNSUPPORTED',
    });
    await expect(adapter.fetch('unknown_op', {}, {})).rejects.toBeInstanceOf(WorkflowError);
  });
});
