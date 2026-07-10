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

// Captured on every request regardless of which response helper is used (see central handler).
let lastRequestMethod = '';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf-8');
      lastRequestMethod = req.method ?? '';
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

/**
 * Registers a handler that captures the request's method + URL (path + query string) and
 * responds with `body` (default: a harmless empty page, satisfying get_messages' pagination
 * termination and passing through as raw JSON for every other operation). The returned object is
 * populated once the request lands — read its fields AFTER awaiting the adapter call.
 */
function captureRequest(body: unknown = { data: [], meta: { next_cursor: null } }): {
  method: string;
  url: string;
} {
  const captured = { method: '', url: '' };
  handlers.push((req, res) => {
    captured.method = req.method ?? '';
    captured.url = req.url ?? '';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  return captured;
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
    sender: {
      id?: number;
      email?: string | null;
      name?: string | null;
      firstname?: string | null;
      lastname?: string | null;
    } | null;
    subject: string | null;
    stripped_text: string | null;
    via: string | null;
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
    sender: overrides.sender !== undefined ? overrides.sender : null,
    subject: overrides.subject !== undefined ? overrides.subject : null,
    stripped_text: overrides.stripped_text !== undefined ? overrides.stripped_text : null,
    via: overrides.via !== undefined ? overrides.via : null,
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
    expect(lastRequestMethod).toBe('GET');
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

  it('mock returns 429 without Retry-After header → retry_after is undefined (resolved by callAdapter)', async () => {
    respond(429, { error: 'Too Many Requests' });
    const adapter = makeAdapter();
    const err = await adapter
      .fetch('get_ticket', { ticket_id: 1 }, {})
      .catch((e: unknown) => e as WorkflowError);
    expect(err).toBeInstanceOf(WorkflowError);
    expect(err.code).toBe('SERVICE_RATE_LIMITED');
    expect(err.agentAction).toBe('wait_and_proceed');
    expect(err.retry_after).toBeUndefined();
    expect(adapter.defaultRetryAfterSeconds).toBe(60);
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

  // A4: the error body echoed into details.body must never leak PII (e.g. a customer email
  // submitted in the request and echoed back by a 4xx validation response) into the user-facing
  // response envelope. Mutation-probe (report it): storing the raw body instead of
  // redactErrorBody(body) must redden this test.
  it('4xx body containing an email → details.body is redacted, not the raw email', async () => {
    respond(400, { error: 'Invalid request', email: 'customer@example.com' });
    const adapter = makeAdapter();
    const err = await adapter
      .fetch('get_ticket', { ticket_id: 1 }, {})
      .catch((e: unknown) => e as WorkflowError);
    expect(err).toBeInstanceOf(WorkflowError);
    const body = err.details['body'] as string;
    expect(body).toContain('[REDACTED_EMAIL]');
    expect(body).not.toContain('customer@example.com');
  });
});

// ---------------------------------------------------------------------------
// Tests: fetch('list_tickets')
// ---------------------------------------------------------------------------

describe("GorgiasAdapter fetch('list_tickets')", () => {
  it('returns raw ticket list from GET /tickets', async () => {
    respond(200, { data: [{ id: 1, status: 'open' }], meta: { next_cursor: null } });
    const adapter = makeAdapter();
    const result = await adapter.fetch('list_tickets', {}, {});
    expect(result.status).toBe(200);
    const data = result.data as { data: unknown[]; meta: unknown };
    expect(data.data).toHaveLength(1);
  });

  it('passes scalar params as query string', async () => {
    let capturedUrl = '';
    handlers.push((req, res) => {
      capturedUrl = req.url ?? '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [], meta: { next_cursor: null } }));
    });
    const adapter = makeAdapter();
    await adapter.fetch('list_tickets', { order_by: 'created_datetime:desc', limit: 10 }, {});
    expect(capturedUrl).toContain('order_by=created_datetime%3Adesc');
    expect(capturedUrl).toContain('limit=10');
  });

  it('rejects a non-scalar param (array) with ADAPTER_VALIDATION_FAILED (issue A6)', async () => {
    const adapter = makeAdapter();
    await expect(
      adapter.fetch('list_tickets', { limit: 10, tags: ['vip', 'new'] }, {}),
    ).rejects.toMatchObject({ code: 'ADAPTER_VALIDATION_FAILED' });
    await expect(
      adapter.fetch('list_tickets', { limit: 10, tags: ['vip', 'new'] }, {}),
    ).rejects.toBeInstanceOf(WorkflowError);
  });

  it('null/undefined params are still omitted (not thrown) alongside scalar params', async () => {
    let capturedUrl = '';
    handlers.push((req, res) => {
      capturedUrl = req.url ?? '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [], meta: { next_cursor: null } }));
    });
    const adapter = makeAdapter();
    await adapter.fetch('list_tickets', { limit: 10, order_by: undefined, cursor: null }, {});
    expect(capturedUrl).toContain('limit=10');
    expect(capturedUrl).not.toContain('order_by=');
    expect(capturedUrl).not.toContain('cursor=');
  });

  it('no params: URL path has no query string', async () => {
    let capturedUrl = '';
    handlers.push((req, res) => {
      capturedUrl = req.url ?? '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [], meta: { next_cursor: null } }));
    });
    const adapter = makeAdapter();
    await adapter.fetch('list_tickets', {}, {});
    expect(lastRequestMethod).toBe('GET');
    expect(capturedUrl).toBe('/tickets');
  });

  it('has_more is true when meta.next_cursor is present (issue A5)', async () => {
    respond(200, { data: [{ id: 1, status: 'open' }], meta: { next_cursor: 'abc123' } });
    const adapter = makeAdapter();
    const result = await adapter.fetch('list_tickets', {}, {});
    const data = result.data as { data: unknown[]; meta: unknown; has_more: boolean };
    expect(data.has_more).toBe(true);
    // data.data and data.meta are preserved untouched (additive field only).
    expect(data.data).toEqual([{ id: 1, status: 'open' }]);
    expect(data.meta).toEqual({ next_cursor: 'abc123' });
  });

  it('has_more is false when meta.next_cursor is null (issue A5)', async () => {
    respond(200, { data: [{ id: 1, status: 'open' }], meta: { next_cursor: null } });
    const adapter = makeAdapter();
    const result = await adapter.fetch('list_tickets', {}, {});
    const data = result.data as { data: unknown[]; meta: unknown; has_more: boolean };
    expect(data.has_more).toBe(false);
    expect(data.data).toEqual([{ id: 1, status: 'open' }]);
    expect(data.meta).toEqual({ next_cursor: null });
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
    expect(lastRequestMethod).toBe('GET');
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

  // ---------------------------------------------------------------------
  // A1 regression (MA-probe made permanent): the loop used to check next_cursor === null
  // FIRST and unconditionally set truncated: false there, so a single over-limit page with no
  // next page silently dropped the surplus while reporting success. Mutation check: restoring
  // that check-order must redden the second test below.
  // ---------------------------------------------------------------------
  it('single page of 45 messages, no limit (per-ticket default): returns all 45, truncated: false', async () => {
    const page = Array.from({ length: 45 }, (_, i) => makeMsg(i + 1));
    respond(200, { data: page, meta: { next_cursor: null } });
    const adapter = makeAdapter();
    const result = await adapter.fetch('get_messages', { ticket_id: 10 }, {});
    const data = result.data as { messages: unknown[]; truncated: boolean };
    expect(data.messages).toHaveLength(45);
    expect(data.truncated).toBe(false);
  });

  it('single page of 45 messages, explicit limit: 30, next_cursor: null: returns 30, truncated: true (honest — dropped within the page)', async () => {
    const page = Array.from({ length: 45 }, (_, i) => makeMsg(i + 1));
    respond(200, { data: page, meta: { next_cursor: null } });
    const adapter = makeAdapter();
    const result = await adapter.fetch('get_messages', { ticket_id: 10, limit: 30 }, {});
    const data = result.data as { messages: unknown[]; truncated: boolean };
    expect(data.messages).toHaveLength(30);
    expect(data.truncated).toBe(true);
  });

  // ---------------------------------------------------------------------
  // A2: per-ticket default is now the full thread (was capped at 30), with a 500-message
  // safety ceiling guarding a pathological thread (not a normal-operation cap).
  // ---------------------------------------------------------------------
  it('multi-page thread (100+100+50), no limit: returns the full 250-message thread, truncated: false', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => makeMsg(i + 1));
    const page2 = Array.from({ length: 100 }, (_, i) => makeMsg(i + 101));
    const page3 = Array.from({ length: 50 }, (_, i) => makeMsg(i + 201));
    respond(200, { data: page1, meta: { next_cursor: 'cursor-p2' } });
    respond(200, { data: page2, meta: { next_cursor: 'cursor-p3' } });
    respond(200, { data: page3, meta: { next_cursor: null } });

    const adapter = makeAdapter();
    const result = await adapter.fetch('get_messages', { ticket_id: 10 }, {});
    const data = result.data as { messages: unknown[]; truncated: boolean };
    expect(data.messages).toHaveLength(250);
    expect(data.truncated).toBe(false);
  });

  // Replaces the old "hard cap of 200" test — A2 raised the per-ticket ceiling to 500.
  it('no-limit per-ticket fetch is guarded at the 500 default (truncated: true)', async () => {
    // 5 pages of 100 (500 total); the 5th page's own cursor proves more exist past the ceiling —
    // a correct implementation breaks immediately on reaching the ceiling and never fetches a 6th.
    for (let page = 0; page < 5; page++) {
      const isLast = page === 4;
      const messages = Array.from({ length: 100 }, (_, i) => makeMsg(page * 100 + i + 1));
      respond(200, {
        data: messages,
        meta: { next_cursor: isLast ? 'cursor-p6' : `cursor-p${page + 2}` },
      });
    }

    const adapter = makeAdapter();
    const result = await adapter.fetch('get_messages', { ticket_id: 10 }, {});
    const data = result.data as { messages: unknown[]; truncated: boolean };
    expect(data.messages).toHaveLength(500);
    expect(data.truncated).toBe(true);
  });

  // Correction: the 500 guard is a no-limit DEFAULT, not an absolute cap — an explicit caller
  // `limit` is authoritative and honored as-is, even above 500.
  it('explicit limit above the default is honored, not clamped: limit 600 → 600 messages', async () => {
    // 6 pages of 100 (600 total), last page next_cursor null.
    for (let page = 0; page < 6; page++) {
      const isLast = page === 5;
      const messages = Array.from({ length: 100 }, (_, i) => makeMsg(page * 100 + i + 1));
      respond(200, {
        data: messages,
        meta: { next_cursor: isLast ? null : `cursor-p${page + 2}` },
      });
    }
    const adapter = makeAdapter();
    const result = await adapter.fetch('get_messages', { ticket_id: 10, limit: 600 }, {});
    const data = result.data as { messages: unknown[]; truncated: boolean };
    expect(data.messages).toHaveLength(600); // NOT clamped to 500
    expect(data.truncated).toBe(false); // fetched the whole thread the caller asked for
  });

  it('body_text and body_html are returned as-is', async () => {
    respond(200, {
      data: [makeMsg(1, { body_text: 'plain text', body_html: '<p>html</p>' })],
      meta: { next_cursor: null },
    });
    const adapter = makeAdapter();
    const result = await adapter.fetch('get_messages', { ticket_id: 10 }, {});
    const data = result.data as { messages: Array<Record<string, unknown>> };
    const msg = data.messages[0]!;
    expect(msg['body_text']).toBe('plain text');
    expect(msg['body_html']).toBe('<p>html</p>');
  });

  it('body_html is returned verbatim without HTML stripping', async () => {
    respond(200, {
      data: [makeMsg(1, { body_text: null, body_html: '<p>Hello &amp; world</p>' })],
      meta: { next_cursor: null },
    });
    const adapter = makeAdapter();
    const result = await adapter.fetch('get_messages', { ticket_id: 10 }, {});
    const data = result.data as { messages: Array<Record<string, unknown>> };
    const msg = data.messages[0]!;
    expect(msg['body_text']).toBeNull();
    expect(msg['body_html']).toBe('<p>Hello &amp; world</p>');
  });

  it('does not add a computed body field to messages', async () => {
    respond(200, {
      data: [makeMsg(1)],
      meta: { next_cursor: null },
    });
    const adapter = makeAdapter();
    const result = await adapter.fetch('get_messages', { ticket_id: 10 }, {});
    const data = result.data as { messages: Array<Record<string, unknown>> };
    expect('body' in (data.messages[0] ?? {})).toBe(false);
  });

  it('sender fields pass through to message output', async () => {
    respond(200, {
      data: [makeMsg(1, { sender: { id: 100, email: 'customer@example.com', name: 'Alice' } })],
      meta: { next_cursor: null },
    });
    const adapter = makeAdapter();
    const result = await adapter.fetch('get_messages', { ticket_id: 10 }, {});
    const data = result.data as { messages: Array<Record<string, unknown>> };
    const sender = data.messages[0]!['sender'] as Record<string, unknown>;
    expect(sender['email']).toBe('customer@example.com');
    expect(sender['name']).toBe('Alice');
  });

  it('null sender is preserved in output', async () => {
    respond(200, {
      data: [makeMsg(1, { sender: null })],
      meta: { next_cursor: null },
    });
    const adapter = makeAdapter();
    const result = await adapter.fetch('get_messages', { ticket_id: 10 }, {});
    const data = result.data as { messages: Array<Record<string, unknown>> };
    expect(data.messages[0]!['sender']).toBeNull();
  });

  it('extra fields not in the interface are preserved', async () => {
    const msgWithExtra = { ...makeMsg(1), some_future_field: 'future_value' };
    respond(200, { data: [msgWithExtra], meta: { next_cursor: null } });
    const adapter = makeAdapter();
    const result = await adapter.fetch('get_messages', { ticket_id: 10 }, {});
    const data = result.data as { messages: Array<Record<string, unknown>> };
    expect(data.messages[0]!['some_future_field']).toBe('future_value');
  });

  it('subject and stripped_text pass through', async () => {
    respond(200, {
      data: [makeMsg(1, { subject: 'Order help', stripped_text: 'stripped body' })],
      meta: { next_cursor: null },
    });
    const adapter = makeAdapter();
    const result = await adapter.fetch('get_messages', { ticket_id: 10 }, {});
    const data = result.data as { messages: Array<Record<string, unknown>> };
    const msg = data.messages[0]!;
    expect(msg['subject']).toBe('Order help');
    expect(msg['stripped_text']).toBe('stripped body');
  });

  it('omits order_by from URL when not supplied', async () => {
    let capturedUrl = '';
    handlers.push((req, res) => {
      capturedUrl = req.url ?? '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [], meta: { next_cursor: null } }));
    });
    const adapter = makeAdapter();
    await adapter.fetch('get_messages', { ticket_id: 10 }, {});
    expect(capturedUrl).not.toContain('order_by=');
  });

  it('caller-supplied order_by is forwarded in the URL', async () => {
    let capturedUrl = '';
    handlers.push((req, res) => {
      capturedUrl = req.url ?? '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [], meta: { next_cursor: null } }));
    });
    const adapter = makeAdapter();
    await adapter.fetch('get_messages', { ticket_id: 10, order_by: 'created_datetime:desc' }, {});
    expect(capturedUrl).toContain('order_by=created_datetime%3Adesc');
  });

  // ---------------------------------------------------------------------
  // Bug fix regression: get_messages must use the per-ticket endpoint, not the flat
  // /messages?ticket_id= filter (inconsistent on Gorgias's side — see gorgias-get-messages-
  // per-ticket-endpoint.md). Mutation check: reverting the conditional URL-path change back to
  // the flat `/messages?...` must redden BOTH of the next two tests.
  // ---------------------------------------------------------------------
  it('per-ticket path: fetch({ ticket_id: 10 }) requests GET /tickets/10/messages, not the flat ticket_id filter', async () => {
    const captured = captureRequest();
    const adapter = makeAdapter();
    await adapter.fetch('get_messages', { ticket_id: 10 }, {});
    expect(captured.url.split('?')[0]).toBe('/tickets/10/messages');
    expect(captured.url).not.toContain('ticket_id=');
  });

  it('acceptance case: ticket 71355453 returns the complete 4-message thread via the per-ticket endpoint', async () => {
    const captured = captureRequest({
      data: [makeMsg(1), makeMsg(2), makeMsg(3), makeMsg(4)],
      meta: { next_cursor: null },
    });
    const adapter = makeAdapter();
    const result = await adapter.fetch('get_messages', { ticket_id: 71355453 }, {});
    const data = result.data as { messages: unknown[]; truncated: boolean };
    expect(data.messages.length).toBe(4);
    expect(data.truncated).toBe(false);
    expect(captured.url.split('?')[0]).toBe('/tickets/71355453/messages');
  });

  it('omits ticket_id from URL when not provided', async () => {
    let capturedUrl = '';
    handlers.push((req, res) => {
      capturedUrl = req.url ?? '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [], meta: { next_cursor: null } }));
    });
    const adapter = makeAdapter();
    await adapter.fetch('get_messages', {}, {});
    expect(capturedUrl).not.toContain('ticket_id=');
    expect(capturedUrl).toContain('limit=');
    expect(capturedUrl.split('?')[0]).toBe('/messages');
  });

  it('returns messages when ticket_id is not provided', async () => {
    respond(200, {
      data: [makeMsg(1), makeMsg(2)],
      meta: { next_cursor: null },
    });
    const adapter = makeAdapter();
    const result = await adapter.fetch('get_messages', {}, {});
    expect(result.status).toBe(200);
    const data = result.data as { messages: unknown[]; truncated: boolean };
    expect(data.messages).toHaveLength(2);
    expect(data.truncated).toBe(false);
  });

  it('throws ADAPTER_VALIDATION_FAILED when ticket_id is provided but invalid', async () => {
    const adapter = makeAdapter();
    await expect(adapter.fetch('get_messages', { ticket_id: -1 }, {})).rejects.toMatchObject({
      code: 'ADAPTER_VALIDATION_FAILED',
    });
    await expect(adapter.fetch('get_messages', { ticket_id: 'bad' }, {})).rejects.toMatchObject({
      code: 'ADAPTER_VALIDATION_FAILED',
    });
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

  it('GET still follows a redirect (issue A7 — GET keeps the default follow, unchanged)', async () => {
    // First response: a real 301 pointing back at this same mock server. Since GET's
    // fetchOptions still use the default redirect: 'follow' (unlike POST/PUT), the underlying
    // fetch() transparently issues the follow-up GET itself — the adapter only sees the final
    // response. Two handlers are queued: one for the 301, one for the followed request.
    handlers.push((_req, res) => {
      res.writeHead(301, {
        'Content-Type': 'application/json',
        Location: `http://127.0.0.1:${port}/tickets/10/messages?redirected=true`,
      });
      res.end(JSON.stringify({ moved: true }));
    });
    respond(200, { data: [makeMsg(1)], meta: { next_cursor: null } });
    const adapter = makeAdapter();
    const result = await adapter.fetch('get_messages', { ticket_id: 10 }, {});
    const data = result.data as { messages: unknown[]; truncated: boolean };
    expect(data.messages).toHaveLength(1);
    expect(data.truncated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: fetch('get_customer')
// ---------------------------------------------------------------------------

describe("GorgiasAdapter fetch('get_customer')", () => {
  it('returns raw customer data from GET /customers/{id}', async () => {
    respond(200, { id: 42, email: 'test@example.com', name: 'Test User' });
    const adapter = makeAdapter();
    const result = await adapter.fetch('get_customer', { customer_id: 42 }, {});
    expect(lastRequestMethod).toBe('GET');
    expect(result.status).toBe(200);
    const data = result.data as Record<string, unknown>;
    expect(data['id']).toBe(42);
    expect(data['email']).toBe('test@example.com');
  });

  it('throws ADAPTER_VALIDATION_FAILED when customer_id is missing', async () => {
    const adapter = makeAdapter();
    await expect(adapter.fetch('get_customer', {}, {})).rejects.toMatchObject({
      code: 'ADAPTER_VALIDATION_FAILED',
    });
  });

  it('throws ADAPTER_VALIDATION_FAILED for invalid customer_id (0 and string)', async () => {
    const adapter = makeAdapter();
    await expect(adapter.fetch('get_customer', { customer_id: 0 }, {})).rejects.toMatchObject({
      code: 'ADAPTER_VALIDATION_FAILED',
    });
    await expect(adapter.fetch('get_customer', { customer_id: 'abc' }, {})).rejects.toMatchObject({
      code: 'ADAPTER_VALIDATION_FAILED',
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: fetch('list_customers')
// ---------------------------------------------------------------------------

describe("GorgiasAdapter fetch('list_customers')", () => {
  it('returns raw customer list from GET /customers', async () => {
    respond(200, { data: [{ id: 1, email: 'a@example.com' }], meta: { next_cursor: null } });
    const adapter = makeAdapter();
    const result = await adapter.fetch('list_customers', {}, {});
    expect(result.status).toBe(200);
    const data = result.data as { data: unknown[]; meta: unknown };
    expect(data.data).toHaveLength(1);
  });

  it('passes scalar params as query string', async () => {
    let capturedUrl = '';
    handlers.push((req, res) => {
      capturedUrl = req.url ?? '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [], meta: { next_cursor: null } }));
    });
    const adapter = makeAdapter();
    await adapter.fetch('list_customers', { email: 'test@example.com', limit: 5 }, {});
    expect(lastRequestMethod).toBe('GET');
    expect(capturedUrl).toContain('email=test%40example.com');
    expect(capturedUrl).toContain('limit=5');
  });

  it('rejects a non-scalar param (array) with ADAPTER_VALIDATION_FAILED (issue A6)', async () => {
    const adapter = makeAdapter();
    await expect(
      adapter.fetch('list_customers', { limit: 10, tags: ['vip', 'new'] }, {}),
    ).rejects.toMatchObject({ code: 'ADAPTER_VALIDATION_FAILED' });
    await expect(
      adapter.fetch('list_customers', { limit: 10, tags: ['vip', 'new'] }, {}),
    ).rejects.toBeInstanceOf(WorkflowError);
  });

  it('rejects a non-scalar param (object) with ADAPTER_VALIDATION_FAILED (issue A6)', async () => {
    const adapter = makeAdapter();
    await expect(
      adapter.fetch('list_customers', { limit: 10, nested: { key: 'val' } }, {}),
    ).rejects.toMatchObject({ code: 'ADAPTER_VALIDATION_FAILED' });
  });

  it('null/undefined params are still omitted (not thrown) alongside scalar params', async () => {
    let capturedUrl = '';
    handlers.push((req, res) => {
      capturedUrl = req.url ?? '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [], meta: { next_cursor: null } }));
    });
    const adapter = makeAdapter();
    await adapter.fetch('list_customers', { limit: 10, email: undefined, tags: null }, {});
    expect(capturedUrl).toContain('limit=10');
    expect(capturedUrl).not.toContain('email=');
    expect(capturedUrl).not.toContain('tags=');
  });

  it('no params: URL path has no query string', async () => {
    let capturedUrl = '';
    handlers.push((req, res) => {
      capturedUrl = req.url ?? '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [], meta: { next_cursor: null } }));
    });
    const adapter = makeAdapter();
    await adapter.fetch('list_customers', {}, {});
    expect(capturedUrl).toBe('/customers');
  });

  it('has_more is true when meta.next_cursor is present (issue A5)', async () => {
    respond(200, { data: [{ id: 1, email: 'a@example.com' }], meta: { next_cursor: 'xyz789' } });
    const adapter = makeAdapter();
    const result = await adapter.fetch('list_customers', {}, {});
    const data = result.data as { data: unknown[]; meta: unknown; has_more: boolean };
    expect(data.has_more).toBe(true);
    // data.data and data.meta are preserved untouched (additive field only).
    expect(data.data).toEqual([{ id: 1, email: 'a@example.com' }]);
    expect(data.meta).toEqual({ next_cursor: 'xyz789' });
  });

  it('has_more is false when meta.next_cursor is null (issue A5)', async () => {
    respond(200, { data: [{ id: 1, email: 'a@example.com' }], meta: { next_cursor: null } });
    const adapter = makeAdapter();
    const result = await adapter.fetch('list_customers', {}, {});
    const data = result.data as { data: unknown[]; meta: unknown; has_more: boolean };
    expect(data.has_more).toBe(false);
    expect(data.data).toEqual([{ id: 1, email: 'a@example.com' }]);
    expect(data.meta).toEqual({ next_cursor: null });
  });
});

// ---------------------------------------------------------------------------
// Tests: create('create_message')
// ---------------------------------------------------------------------------

describe("GorgiasAdapter create('create_message')", () => {
  it('returns the raw Gorgias message response', async () => {
    respond(201, {
      id: 999,
      channel: 'note',
      public: false,
      from_agent: true,
      body_html: '<p>hi</p>',
      created_datetime: '2024-01-01T00:00:00Z',
    });
    const adapter = makeAdapter();
    const result = await adapter.create(
      'create_message',
      { ticket_id: 42, body_html: '<p>hi</p>', channel: 'note', public: false, from_agent: true },
      {},
    );
    expect(lastRequestMethod).toBe('POST');
    expect(result.status).toBe(201);
    const data = result.data as Record<string, unknown>;
    expect(data['id']).toBe(999);
    expect(data['channel']).toBe('note');
  });

  it('passes caller-supplied fields as the request body (ticket_id excluded)', async () => {
    let capturedBody: unknown;
    handlers.push((_req, res, body) => {
      capturedBody = JSON.parse(body);
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 1, channel: 'email' }));
    });
    const adapter = makeAdapter();
    await adapter.create(
      'create_message',
      {
        ticket_id: 42,
        channel: 'email',
        public: true,
        from_agent: true,
        body_html: '<p>reply</p>',
        subject: 'Re: your order',
      },
      {},
    );
    expect(capturedBody).toEqual({
      channel: 'email',
      public: true,
      from_agent: true,
      body_html: '<p>reply</p>',
      subject: 'Re: your order',
    });
  });

  it('channel: "note" works when caller supplies it', async () => {
    let capturedBody: unknown;
    handlers.push((_req, res, body) => {
      capturedBody = JSON.parse(body);
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 2 }));
    });
    const adapter = makeAdapter();
    await adapter.create(
      'create_message',
      { ticket_id: 42, channel: 'note', public: false, from_agent: true, body_html: '<p>note</p>' },
      {},
    );
    expect((capturedBody as Record<string, unknown>)['channel']).toBe('note');
    expect((capturedBody as Record<string, unknown>)['public']).toBe(false);
  });

  it('mock returns 403 → throws SERVICE_HTTP_4XX with message containing "permission"', async () => {
    respond(403, { error: 'Forbidden' });
    const adapter = makeAdapter();
    const err = await adapter
      .create('create_message', { ticket_id: 42, body_html: '<p>hi</p>' }, {})
      .catch((e: unknown) => e as WorkflowError);
    expect(err).toBeInstanceOf(WorkflowError);
    expect(err.code).toBe('SERVICE_HTTP_4XX');
    expect(err.message).toContain('permission');
  });

  it('channel: "email" is forwarded — not restricted to note', async () => {
    respond(201, { id: 3, channel: 'email' });
    const adapter = makeAdapter();
    const result = await adapter.create(
      'create_message',
      { ticket_id: 42, channel: 'email', public: true, body_html: '<p>reply</p>' },
      {},
    );
    expect(result.status).toBe(201);
    expect((result.data as Record<string, unknown>)['channel']).toBe('email');
  });

  it('ticket_id missing → throws ADAPTER_VALIDATION_FAILED', async () => {
    const adapter = makeAdapter();
    await expect(adapter.create('create_message', {}, {})).rejects.toMatchObject({
      code: 'ADAPTER_VALIDATION_FAILED',
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: create('create_ticket')
// ---------------------------------------------------------------------------

describe("GorgiasAdapter create('create_ticket')", () => {
  it('returns raw ticket response', async () => {
    respond(201, { id: 100, status: 'open', channel: 'email' });
    const adapter = makeAdapter();
    const result = await adapter.create(
      'create_ticket',
      { messages: [{ channel: 'email', from_agent: false }] },
      {},
    );
    expect(lastRequestMethod).toBe('POST');
    expect(result.status).toBe(201);
    const data = result.data as Record<string, unknown>;
    expect(data['id']).toBe(100);
  });

  it('passes all params as request body', async () => {
    let capturedBody: unknown;
    handlers.push((_req, res, body) => {
      capturedBody = JSON.parse(body);
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 1 }));
    });
    const adapter = makeAdapter();
    await adapter.create(
      'create_ticket',
      {
        messages: [{ channel: 'email', from_agent: false }],
        subject: 'Help needed',
        status: 'open',
      },
      {},
    );
    expect(capturedBody).toEqual({
      messages: [{ channel: 'email', from_agent: false }],
      subject: 'Help needed',
      status: 'open',
    });
  });

  it('a 301 on POST throws a non-retryable redirect error instead of following (issue A7)', async () => {
    respond(301, { moved: true }, { Location: 'https://test.gorgias.com/api/tickets/123' });
    const adapter = makeAdapter();
    await expect(
      adapter.create('create_ticket', { messages: [{ channel: 'email', from_agent: false }] }, {}),
    ).rejects.toMatchObject({ code: 'SERVICE_UNEXPECTED_REDIRECT', retryable: false });
  });

  it('a normal 201 write still succeeds unchanged (redirect: manual does not affect non-redirect responses)', async () => {
    respond(201, { id: 100, status: 'open', channel: 'email' });
    const adapter = makeAdapter();
    const result = await adapter.create(
      'create_ticket',
      { messages: [{ channel: 'email', from_agent: false }] },
      {},
    );
    expect(result.status).toBe(201);
    const data = result.data as Record<string, unknown>;
    expect(data['id']).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// Tests: create('create_customer')
// ---------------------------------------------------------------------------

describe("GorgiasAdapter create('create_customer')", () => {
  it('returns raw customer response', async () => {
    respond(201, { id: 55, email: 'new@example.com' });
    const adapter = makeAdapter();
    const result = await adapter.create(
      'create_customer',
      { channels: [{ type: 'email', address: 'new@example.com' }] },
      {},
    );
    expect(lastRequestMethod).toBe('POST');
    expect(result.status).toBe(201);
    const data = result.data as Record<string, unknown>;
    expect(data['id']).toBe(55);
  });

  it('passes all params as request body', async () => {
    let capturedBody: unknown;
    handlers.push((_req, res, body) => {
      capturedBody = JSON.parse(body);
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 2 }));
    });
    const adapter = makeAdapter();
    await adapter.create(
      'create_customer',
      { channels: [{ type: 'email', address: 'x@y.com' }], name: 'Jane', language: 'en' },
      {},
    );
    expect(capturedBody).toEqual({
      channels: [{ type: 'email', address: 'x@y.com' }],
      name: 'Jane',
      language: 'en',
    });
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
// Tests: update('update_ticket')
// ---------------------------------------------------------------------------

describe("GorgiasAdapter update('update_ticket')", () => {
  it('returns 202 with raw updated ticket', async () => {
    respond(202, { id: 10, status: 'closed' });
    const adapter = makeAdapter();
    const result = await adapter.update('update_ticket', { ticket_id: 10, status: 'closed' }, {});
    expect(lastRequestMethod).toBe('PUT');
    expect(result.status).toBe(202);
    const data = result.data as Record<string, unknown>;
    expect(data['status']).toBe('closed');
  });

  it('throws ADAPTER_VALIDATION_FAILED when ticket_id is missing', async () => {
    const adapter = makeAdapter();
    await expect(adapter.update('update_ticket', { status: 'closed' }, {})).rejects.toMatchObject({
      code: 'ADAPTER_VALIDATION_FAILED',
    });
  });

  it('strips ticket_id from the PUT body', async () => {
    let capturedBody: unknown;
    handlers.push((_req, res, body) => {
      capturedBody = JSON.parse(body);
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 10 }));
    });
    const adapter = makeAdapter();
    await adapter.update(
      'update_ticket',
      { ticket_id: 10, status: 'closed', tags: [{ name: 'resolved' }] },
      {},
    );
    expect(capturedBody).toEqual({ status: 'closed', tags: [{ name: 'resolved' }] });
    expect((capturedBody as Record<string, unknown>)['ticket_id']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: update('update_customer')
// ---------------------------------------------------------------------------

describe("GorgiasAdapter update('update_customer')", () => {
  it('returns 202 with raw updated customer', async () => {
    respond(202, { id: 42, name: 'Updated Name' });
    const adapter = makeAdapter();
    const result = await adapter.update(
      'update_customer',
      { customer_id: 42, name: 'Updated Name' },
      {},
    );
    expect(result.status).toBe(202);
    const data = result.data as Record<string, unknown>;
    expect(data['name']).toBe('Updated Name');
  });

  it('throws ADAPTER_VALIDATION_FAILED when customer_id is missing', async () => {
    const adapter = makeAdapter();
    await expect(adapter.update('update_customer', { name: 'X' }, {})).rejects.toMatchObject({
      code: 'ADAPTER_VALIDATION_FAILED',
    });
  });

  it('strips customer_id from the PUT body', async () => {
    let capturedBody: unknown;
    handlers.push((_req, res, body) => {
      capturedBody = JSON.parse(body);
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 42 }));
    });
    const adapter = makeAdapter();
    await adapter.update('update_customer', { customer_id: 42, name: 'Jane', language: 'fr' }, {});
    expect(lastRequestMethod).toBe('PUT');
    expect(capturedBody).toEqual({ name: 'Jane', language: 'fr' });
    expect((capturedBody as Record<string, unknown>)['customer_id']).toBeUndefined();
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

// ---------------------------------------------------------------------------
// URL contract — every operation asserts method + path.
//
// Anti-recurrence: the get_messages bug this file's earlier tests catch shipped because its
// tests asserted the HTTP *method* but never the URL *path* — method-was-asserted, path-was-not.
// This matrix is the enumerable enforcement point: a new Gorgias operation MUST be added here
// with its method + path, or it has no path coverage.
// ---------------------------------------------------------------------------

type GorgiasDispatch = 'fetch' | 'create' | 'update';

interface UrlContractRow {
  dispatch: GorgiasDispatch;
  operation: string;
  args: Record<string, unknown>;
  method: string;
  /** Expected URL path — the portion before `?`. */
  path: string;
}

const URL_CONTRACT_MATRIX: UrlContractRow[] = [
  {
    dispatch: 'fetch',
    operation: 'get_ticket',
    args: { ticket_id: 42 },
    method: 'GET',
    path: '/tickets/42',
  },
  {
    dispatch: 'fetch',
    operation: 'get_messages',
    args: { ticket_id: 10 },
    method: 'GET',
    path: '/tickets/10/messages',
  },
  { dispatch: 'fetch', operation: 'get_messages', args: {}, method: 'GET', path: '/messages' },
  { dispatch: 'fetch', operation: 'list_tickets', args: {}, method: 'GET', path: '/tickets' },
  {
    dispatch: 'fetch',
    operation: 'get_customer',
    args: { customer_id: 7 },
    method: 'GET',
    path: '/customers/7',
  },
  { dispatch: 'fetch', operation: 'list_customers', args: {}, method: 'GET', path: '/customers' },
  {
    dispatch: 'create',
    operation: 'create_message',
    args: { ticket_id: 10, body_text: 'x' },
    method: 'POST',
    path: '/tickets/10/messages',
  },
  {
    dispatch: 'create',
    operation: 'create_ticket',
    args: { subject: 'x' },
    method: 'POST',
    path: '/tickets',
  },
  {
    dispatch: 'create',
    operation: 'create_customer',
    args: { email: 'a@b.c' },
    method: 'POST',
    path: '/customers',
  },
  {
    dispatch: 'update',
    operation: 'update_ticket',
    args: { ticket_id: 10, status: 'closed' },
    method: 'PUT',
    path: '/tickets/10',
  },
  {
    dispatch: 'update',
    operation: 'update_customer',
    args: { customer_id: 7, name: 'X' },
    method: 'PUT',
    path: '/customers/7',
  },
];

describe('URL contract — every operation asserts method + path', () => {
  it('every operation in the matrix hits its documented HTTP method + URL path', async () => {
    const adapter = makeAdapter();
    for (const row of URL_CONTRACT_MATRIX) {
      const captured = captureRequest();
      await adapter[row.dispatch](row.operation, row.args, {});
      expect(captured.method).toBe(row.method);
      expect(captured.url.split('?')[0]).toBe(row.path);
    }
  });
});
