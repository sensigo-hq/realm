import * as http from 'node:http';
import * as net from 'node:net';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { NotionAdapter } from './notion-adapter.js';
import type { NotionAdapterConfig } from './notion-adapter.js';
import { WorkflowError } from '../types/workflow-error.js';

// ---------------------------------------------------------------------------
// Mock server
// ---------------------------------------------------------------------------

type RequestHandler = (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void;

let port: number;
let server: http.Server;
const handlers: RequestHandler[] = [];

let lastRequestHeaders: http.IncomingHttpHeaders = {};
let lastRequestBody = '';
let lastRequestMethod = '';
let lastRequestUrl = '';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf-8');
      lastRequestHeaders = req.headers;
      lastRequestBody = body;
      lastRequestMethod = req.method ?? '';
      lastRequestUrl = req.url ?? '';
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

function respond(statusCode: number, body: unknown, headers: Record<string, string> = {}): void {
  handlers.push((_req, res) => {
    res.writeHead(statusCode, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  });
}

function respondText(statusCode: number, text: string): void {
  handlers.push((_req, res) => {
    res.writeHead(statusCode, { 'Content-Type': 'text/plain' });
    res.end(text);
  });
}

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

const VALID_CONFIG: NotionAdapterConfig = {
  api_key: 'secret_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
};

function makeAdapter(overrides: Partial<NotionAdapterConfig> = {}): NotionAdapter {
  return new NotionAdapter('notion', {
    ...VALID_CONFIG,
    base_url: `http://127.0.0.1:${port}`,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PAGE_FIXTURE = {
  id: 'page-uuid-1234',
  object: 'page',
  properties: {},
};

const LIST_FIXTURE = {
  object: 'list',
  results: [{ id: 'block-1', type: 'paragraph' }],
  has_more: false,
  next_cursor: null,
};

// ---------------------------------------------------------------------------
// Tests: Constructor validation
// ---------------------------------------------------------------------------

describe('NotionAdapter construction', () => {
  it('throws for empty api_key', () => {
    expect(() => new NotionAdapter('id', { api_key: '' })).toThrow(
      'NotionAdapter: api_key must not be empty',
    );
  });

  it('does not throw for a valid config', () => {
    expect(() => new NotionAdapter('id', { api_key: 'secret_xxx' })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Tests: Auth headers
// ---------------------------------------------------------------------------

describe('NotionAdapter auth headers', () => {
  it('sends Authorization: Bearer header and Notion-Version header', async () => {
    respond(200, PAGE_FIXTURE);
    const adapter = makeAdapter();
    await adapter.fetch('get_page', { page_id: 'page-123' }, {});
    expect(lastRequestHeaders['authorization']).toBe(
      'Bearer secret_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    );
    expect(lastRequestHeaders['notion-version']).toBe('2026-03-11');
  });
});

// ---------------------------------------------------------------------------
// Tests: get_page
// ---------------------------------------------------------------------------

describe('NotionAdapter get_page', () => {
  it('uses correct URL path: /v1/pages/{page_id}', async () => {
    respond(200, PAGE_FIXTURE);
    const adapter = makeAdapter();
    await adapter.fetch('get_page', { page_id: 'page-abc' }, {});
    expect(lastRequestUrl).toBe('/v1/pages/page-abc');
    expect(lastRequestMethod).toBe('GET');
  });

  it('returns data with id', async () => {
    respond(200, PAGE_FIXTURE);
    const adapter = makeAdapter();
    const result = await adapter.fetch('get_page', { page_id: 'page-abc' }, {});
    expect(result.status).toBe(200);
    const data = result.data as typeof PAGE_FIXTURE;
    expect(data.id).toBe('page-uuid-1234');
  });

  it('filter_properties produces repeated filter_properties params', async () => {
    respond(200, PAGE_FIXTURE);
    const adapter = makeAdapter();
    await adapter.fetch('get_page', { page_id: 'p1', filter_properties: ['title', 'status'] }, {});
    const decoded = decodeURIComponent(lastRequestUrl);
    expect(decoded).toContain('filter_properties=title');
    expect(decoded).toContain('filter_properties=status');
  });

  it('missing page_id → ADAPTER_VALIDATION_FAILED', async () => {
    const adapter = makeAdapter();
    await expect(adapter.fetch('get_page', {}, {})).rejects.toMatchObject({
      code: 'ADAPTER_VALIDATION_FAILED',
    });
  });

  it('HTTP 401 → SERVICE_AUTH_FAILED', async () => {
    respond(401, { message: 'Unauthorized' });
    const adapter = makeAdapter();
    await expect(adapter.fetch('get_page', { page_id: 'p1' }, {})).rejects.toMatchObject({
      code: 'SERVICE_AUTH_FAILED',
    });
  });

  it('HTTP 404 → SERVICE_NOT_FOUND', async () => {
    respond(404, { message: 'Not found' });
    const adapter = makeAdapter();
    await expect(adapter.fetch('get_page', { page_id: 'p1' }, {})).rejects.toMatchObject({
      code: 'SERVICE_NOT_FOUND',
    });
  });

  it('HTTP 429 → SERVICE_RATE_LIMITED, agentAction: wait_for_human', async () => {
    respond(429, { message: 'Rate limited' });
    const adapter = makeAdapter();
    const err = await adapter
      .fetch('get_page', { page_id: 'p1' }, {})
      .catch((e: unknown) => e as WorkflowError);
    expect(err).toBeInstanceOf(WorkflowError);
    expect(err.code).toBe('SERVICE_RATE_LIMITED');
    expect(err.agentAction).toBe('wait_for_human');
  });

  it('HTTP 429 with Retry-After header → retryAfterSeconds in details', async () => {
    respond(429, { message: 'Rate limited' }, { 'Retry-After': '60' });
    const adapter = makeAdapter();
    const err = await adapter
      .fetch('get_page', { page_id: 'p1' }, {})
      .catch((e: unknown) => e as WorkflowError);
    expect(err.code).toBe('SERVICE_RATE_LIMITED');
    expect(err.details['retryAfterSeconds']).toBe(60);
  });

  it('HTTP 503 → SERVICE_HTTP_5XX, agentAction: wait_for_human', async () => {
    respond(503, { message: 'unavailable' });
    const adapter = makeAdapter();
    const err = await adapter
      .fetch('get_page', { page_id: 'p1' }, {})
      .catch((e: unknown) => e as WorkflowError);
    expect(err.code).toBe('SERVICE_HTTP_5XX');
    expect(err.agentAction).toBe('wait_for_human');
  });

  it('HTTP 503 with additional_data → additionalData in details', async () => {
    respond(503, { message: 'timeout', additional_data: { retry_after: 30 } });
    const adapter = makeAdapter();
    const err = await adapter
      .fetch('get_page', { page_id: 'p1' }, {})
      .catch((e: unknown) => e as WorkflowError);
    expect(err.code).toBe('SERVICE_HTTP_5XX');
    expect(err.details['additionalData']).toEqual({ retry_after: 30 });
  });

  it('HTTP 500 → SERVICE_HTTP_5XX, agentAction: report_to_user', async () => {
    respond(500, { message: 'Internal Server Error' });
    const adapter = makeAdapter();
    await expect(adapter.fetch('get_page', { page_id: 'p1' }, {})).rejects.toMatchObject({
      code: 'SERVICE_HTTP_5XX',
      agentAction: 'report_to_user',
    });
  });

  it('HTTP 400 → SERVICE_HTTP_4XX, message from body', async () => {
    respond(400, { message: 'path.field is invalid' });
    const adapter = makeAdapter();
    const err = await adapter
      .fetch('get_page', { page_id: 'p1' }, {})
      .catch((e: unknown) => e as WorkflowError);
    expect(err.code).toBe('SERVICE_HTTP_4XX');
    expect(err.message).toContain('path.field is invalid');
    expect(err.details['body']).toBeDefined();
  });

  it('x-notion-request-id header is included in error details', async () => {
    respond(404, { message: 'Not found' }, { 'x-notion-request-id': 'req-id-xyz' });
    const adapter = makeAdapter();
    const err = await adapter
      .fetch('get_page', { page_id: 'p1' }, {})
      .catch((e: unknown) => e as WorkflowError);
    expect(err.details['notionRequestId']).toBe('req-id-xyz');
  });
});

// ---------------------------------------------------------------------------
// Tests: list_block_children
// ---------------------------------------------------------------------------

describe('NotionAdapter list_block_children', () => {
  it('uses correct URL path: /v1/blocks/{block_id}/children', async () => {
    respond(200, LIST_FIXTURE);
    const adapter = makeAdapter();
    await adapter.fetch('list_block_children', { block_id: 'block-abc' }, {});
    expect(lastRequestUrl).toMatch(/^\/v1\/blocks\/block-abc\/children/);
    expect(lastRequestMethod).toBe('GET');
  });

  it('start_cursor and page_size produce query params', async () => {
    respond(200, LIST_FIXTURE);
    const adapter = makeAdapter();
    await adapter.fetch(
      'list_block_children',
      { block_id: 'b1', start_cursor: 'cursor-xyz', page_size: 25 },
      {},
    );
    expect(lastRequestUrl).toContain('start_cursor=cursor-xyz');
    expect(lastRequestUrl).toContain('page_size=25');
  });

  it('returns results array', async () => {
    respond(200, LIST_FIXTURE);
    const adapter = makeAdapter();
    const result = await adapter.fetch('list_block_children', { block_id: 'b1' }, {});
    const data = result.data as typeof LIST_FIXTURE;
    expect(Array.isArray(data.results)).toBe(true);
    expect(data.has_more).toBe(false);
  });

  it('missing block_id → ADAPTER_VALIDATION_FAILED', async () => {
    const adapter = makeAdapter();
    await expect(adapter.fetch('list_block_children', {}, {})).rejects.toMatchObject({
      code: 'ADAPTER_VALIDATION_FAILED',
    });
  });

  it('HTTP 401 → SERVICE_AUTH_FAILED', async () => {
    respond(401, { message: 'Unauthorized' });
    const adapter = makeAdapter();
    await expect(
      adapter.fetch('list_block_children', { block_id: 'b1' }, {}),
    ).rejects.toMatchObject({ code: 'SERVICE_AUTH_FAILED' });
  });

  it('HTTP 404 → SERVICE_NOT_FOUND', async () => {
    respond(404, { message: 'Not found' });
    const adapter = makeAdapter();
    await expect(
      adapter.fetch('list_block_children', { block_id: 'b1' }, {}),
    ).rejects.toMatchObject({ code: 'SERVICE_NOT_FOUND' });
  });
});

// ---------------------------------------------------------------------------
// Tests: query_data_source
// ---------------------------------------------------------------------------

describe('NotionAdapter query_data_source', () => {
  it('uses correct URL path and method: POST /v1/data_sources/{id}/query', async () => {
    respond(200, LIST_FIXTURE);
    const adapter = makeAdapter();
    await adapter.fetch('query_data_source', { data_source_id: 'ds-abc' }, {});
    expect(lastRequestUrl).toMatch(/^\/v1\/data_sources\/ds-abc\/query/);
    expect(lastRequestMethod).toBe('POST');
  });

  it('body includes only present optional fields', async () => {
    respond(200, LIST_FIXTURE);
    const adapter = makeAdapter();
    await adapter.fetch(
      'query_data_source',
      { data_source_id: 'ds-1', filter: { property: 'Status', equals: 'Done' }, page_size: 10 },
      {},
    );
    const body = JSON.parse(lastRequestBody) as Record<string, unknown>;
    expect(body['filter']).toEqual({ property: 'Status', equals: 'Done' });
    expect(body['page_size']).toBe(10);
    expect('sorts' in body).toBe(false);
    expect('start_cursor' in body).toBe(false);
  });

  it('filter_properties produces repeated query params', async () => {
    respond(200, LIST_FIXTURE);
    const adapter = makeAdapter();
    await adapter.fetch(
      'query_data_source',
      { data_source_id: 'ds-1', filter_properties: ['Name', 'Status'] },
      {},
    );
    const decoded = decodeURIComponent(lastRequestUrl);
    expect(decoded).toContain('filter_properties=Name');
    expect(decoded).toContain('filter_properties=Status');
  });

  it('missing data_source_id → ADAPTER_VALIDATION_FAILED', async () => {
    const adapter = makeAdapter();
    await expect(adapter.fetch('query_data_source', {}, {})).rejects.toMatchObject({
      code: 'ADAPTER_VALIDATION_FAILED',
    });
  });

  it('HTTP 403 → SERVICE_HTTP_4XX', async () => {
    respond(403, { message: 'Forbidden' });
    const adapter = makeAdapter();
    await expect(
      adapter.fetch('query_data_source', { data_source_id: 'ds-1' }, {}),
    ).rejects.toMatchObject({ code: 'SERVICE_HTTP_4XX' });
  });

  it('HTTP 503 → SERVICE_HTTP_5XX, agentAction: wait_for_human', async () => {
    respond(503, { message: 'Backend timeout' });
    const adapter = makeAdapter();
    const err = await adapter
      .fetch('query_data_source', { data_source_id: 'ds-1' }, {})
      .catch((e: unknown) => e as WorkflowError);
    expect(err.code).toBe('SERVICE_HTTP_5XX');
    expect(err.agentAction).toBe('wait_for_human');
  });

  it('returns results array', async () => {
    respond(200, LIST_FIXTURE);
    const adapter = makeAdapter();
    const result = await adapter.fetch('query_data_source', { data_source_id: 'ds-1' }, {});
    const data = result.data as typeof LIST_FIXTURE;
    expect(Array.isArray(data.results)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: search
// ---------------------------------------------------------------------------

describe('NotionAdapter search', () => {
  it('uses correct URL and method: POST /v1/search', async () => {
    respond(200, LIST_FIXTURE);
    const adapter = makeAdapter();
    await adapter.fetch('search', {}, {});
    expect(lastRequestUrl).toBe('/v1/search');
    expect(lastRequestMethod).toBe('POST');
  });

  it('body includes only present params', async () => {
    respond(200, LIST_FIXTURE);
    const adapter = makeAdapter();
    await adapter.fetch('search', { query: 'hello', page_size: 5 }, {});
    const body = JSON.parse(lastRequestBody) as Record<string, unknown>;
    expect(body['query']).toBe('hello');
    expect(body['page_size']).toBe(5);
    expect('filter' in body).toBe(false);
  });

  it('valid filter passes through to body', async () => {
    respond(200, LIST_FIXTURE);
    const adapter = makeAdapter();
    await adapter.fetch('search', { filter: { property: 'object', value: 'page' } }, {});
    const body = JSON.parse(lastRequestBody) as Record<string, unknown>;
    expect(body['filter']).toEqual({ property: 'object', value: 'page' });
  });

  it('filter with invalid value → ADAPTER_VALIDATION_FAILED (bad value)', async () => {
    const adapter = makeAdapter();
    await expect(
      adapter.fetch('search', { filter: { property: 'object', value: 'invalid' } }, {}),
    ).rejects.toMatchObject({ code: 'ADAPTER_VALIDATION_FAILED' });
  });

  it('filter with wrong property → ADAPTER_VALIDATION_FAILED', async () => {
    const adapter = makeAdapter();
    await expect(
      adapter.fetch('search', { filter: { property: 'type', value: 'page' } }, {}),
    ).rejects.toMatchObject({ code: 'ADAPTER_VALIDATION_FAILED' });
  });

  it('filter as array → ADAPTER_VALIDATION_FAILED', async () => {
    const adapter = makeAdapter();
    await expect(
      adapter.fetch('search', { filter: [{ property: 'object', value: 'page' }] }, {}),
    ).rejects.toMatchObject({ code: 'ADAPTER_VALIDATION_FAILED' });
  });

  it('filter: data_source is a valid value', async () => {
    respond(200, LIST_FIXTURE);
    const adapter = makeAdapter();
    await expect(
      adapter.fetch('search', { filter: { property: 'object', value: 'data_source' } }, {}),
    ).resolves.toBeDefined();
  });

  it('returns results array', async () => {
    respond(200, LIST_FIXTURE);
    const adapter = makeAdapter();
    const result = await adapter.fetch('search', {}, {});
    const data = result.data as typeof LIST_FIXTURE;
    expect(Array.isArray(data.results)).toBe(true);
  });

  it('HTTP 401 → SERVICE_AUTH_FAILED', async () => {
    respond(401, { message: 'Unauthorized' });
    const adapter = makeAdapter();
    await expect(adapter.fetch('search', {}, {})).rejects.toMatchObject({
      code: 'SERVICE_AUTH_FAILED',
    });
  });

  it('HTTP 500 → SERVICE_HTTP_5XX, agentAction: report_to_user', async () => {
    respond(500, { message: 'Internal error' });
    const adapter = makeAdapter();
    await expect(adapter.fetch('search', {}, {})).rejects.toMatchObject({
      code: 'SERVICE_HTTP_5XX',
      agentAction: 'report_to_user',
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: create_page
// ---------------------------------------------------------------------------

describe('NotionAdapter create_page', () => {
  it('uses correct URL and method: POST /v1/pages', async () => {
    respond(200, PAGE_FIXTURE);
    const adapter = makeAdapter();
    await adapter.create('create_page', { parent: { page_id: 'p-parent' } }, {});
    expect(lastRequestUrl).toBe('/v1/pages');
    expect(lastRequestMethod).toBe('POST');
  });

  it('parent { page_id } normalised to wire format', async () => {
    respond(200, PAGE_FIXTURE);
    const adapter = makeAdapter();
    await adapter.create('create_page', { parent: { page_id: 'p-abc' } }, {});
    const body = JSON.parse(lastRequestBody) as Record<string, unknown>;
    expect(body['parent']).toEqual({ type: 'page_id', page_id: 'p-abc' });
  });

  it('parent { data_source_id } normalised to wire format', async () => {
    respond(200, PAGE_FIXTURE);
    const adapter = makeAdapter();
    await adapter.create('create_page', { parent: { data_source_id: 'ds-abc' } }, {});
    const body = JSON.parse(lastRequestBody) as Record<string, unknown>;
    expect(body['parent']).toEqual({ type: 'data_source_id', data_source_id: 'ds-abc' });
  });

  it('parent { workspace: true } normalised to wire format', async () => {
    respond(200, PAGE_FIXTURE);
    const adapter = makeAdapter();
    await adapter.create('create_page', { parent: { workspace: true } }, {});
    const body = JSON.parse(lastRequestBody) as Record<string, unknown>;
    expect(body['parent']).toEqual({ type: 'workspace', workspace: true });
  });

  it('invalid parent → ADAPTER_VALIDATION_FAILED', async () => {
    const adapter = makeAdapter();
    await expect(
      adapter.create('create_page', { parent: { unknown_key: 'x' } }, {}),
    ).rejects.toMatchObject({ code: 'ADAPTER_VALIDATION_FAILED' });
  });

  it('missing parent → ADAPTER_VALIDATION_FAILED', async () => {
    const adapter = makeAdapter();
    await expect(adapter.create('create_page', {}, {})).rejects.toMatchObject({
      code: 'ADAPTER_VALIDATION_FAILED',
    });
  });

  it('children and markdown both present → ADAPTER_VALIDATION_FAILED', async () => {
    const adapter = makeAdapter();
    await expect(
      adapter.create(
        'create_page',
        {
          parent: { page_id: 'p1' },
          children: [{ type: 'paragraph' }],
          markdown: '# Hello',
        },
        {},
      ),
    ).rejects.toMatchObject({ code: 'ADAPTER_VALIDATION_FAILED' });
  });

  it('children > 100 → ADAPTER_VALIDATION_FAILED with count in message', async () => {
    const adapter = makeAdapter();
    const children = Array.from({ length: 101 }, () => ({ type: 'paragraph' }));
    const err = await adapter
      .create('create_page', { parent: { page_id: 'p1' }, children }, {})
      .catch((e: unknown) => e as WorkflowError);
    expect(err.code).toBe('ADAPTER_VALIDATION_FAILED');
    expect(err.message).toContain('101');
  });

  it('children exactly 100 is allowed', async () => {
    respond(200, PAGE_FIXTURE);
    const adapter = makeAdapter();
    const children = Array.from({ length: 100 }, () => ({ type: 'paragraph' }));
    await expect(
      adapter.create('create_page', { parent: { page_id: 'p1' }, children }, {}),
    ).resolves.toBeDefined();
  });

  it('optional fields are included only when present', async () => {
    respond(200, PAGE_FIXTURE);
    const adapter = makeAdapter();
    await adapter.create(
      'create_page',
      { parent: { page_id: 'p1' }, properties: { Title: {} }, icon: { type: 'emoji' } },
      {},
    );
    const body = JSON.parse(lastRequestBody) as Record<string, unknown>;
    expect(body['properties']).toEqual({ Title: {} });
    expect(body['icon']).toEqual({ type: 'emoji' });
    expect('cover' in body).toBe(false);
    expect('children' in body).toBe(false);
  });

  it('returns data with id on success', async () => {
    respond(200, PAGE_FIXTURE);
    const adapter = makeAdapter();
    const result = await adapter.create('create_page', { parent: { page_id: 'p1' } }, {});
    expect(result.status).toBe(200);
    const data = result.data as typeof PAGE_FIXTURE;
    expect(data.id).toBe('page-uuid-1234');
  });

  it('HTTP 401 → SERVICE_AUTH_FAILED', async () => {
    respond(401, { message: 'Unauthorized' });
    const adapter = makeAdapter();
    await expect(
      adapter.create('create_page', { parent: { page_id: 'p1' } }, {}),
    ).rejects.toMatchObject({ code: 'SERVICE_AUTH_FAILED' });
  });

  it('HTTP 404 → SERVICE_NOT_FOUND', async () => {
    respond(404, { message: 'Parent not found' });
    const adapter = makeAdapter();
    await expect(
      adapter.create('create_page', { parent: { page_id: 'nonexistent' } }, {}),
    ).rejects.toMatchObject({ code: 'SERVICE_NOT_FOUND' });
  });

  it('HTTP 429 → SERVICE_RATE_LIMITED', async () => {
    respond(429, { message: 'Rate limited' });
    const adapter = makeAdapter();
    await expect(
      adapter.create('create_page', { parent: { page_id: 'p1' } }, {}),
    ).rejects.toMatchObject({ code: 'SERVICE_RATE_LIMITED' });
  });

  it('HTTP 409 → SERVICE_HTTP_4XX with body in details and message from body', async () => {
    respond(409, { message: 'Conflict with existing page' });
    const adapter = makeAdapter();
    const err = await adapter
      .create('create_page', { parent: { page_id: 'p1' } }, {})
      .catch((e: unknown) => e as WorkflowError);
    expect(err.code).toBe('SERVICE_HTTP_4XX');
    expect(err.message).toContain('Conflict with existing page');
    expect(err.details['body']).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: append_block_children
// ---------------------------------------------------------------------------

describe('NotionAdapter append_block_children', () => {
  it('uses correct URL and HTTP method PATCH /v1/blocks/{id}/children', async () => {
    respond(200, LIST_FIXTURE);
    const adapter = makeAdapter();
    await adapter.create(
      'append_block_children',
      { block_id: 'block-abc', children: [{ type: 'paragraph' }] },
      {},
    );
    expect(lastRequestUrl).toBe('/v1/blocks/block-abc/children');
    expect(lastRequestMethod).toBe('PATCH');
  });

  it('returns results array on success', async () => {
    respond(200, LIST_FIXTURE);
    const adapter = makeAdapter();
    const result = await adapter.create(
      'append_block_children',
      { block_id: 'b1', children: [{ type: 'paragraph' }] },
      {},
    );
    const data = result.data as typeof LIST_FIXTURE;
    expect(Array.isArray(data.results)).toBe(true);
  });

  it('missing block_id → ADAPTER_VALIDATION_FAILED', async () => {
    const adapter = makeAdapter();
    await expect(
      adapter.create('append_block_children', { children: [{ type: 'paragraph' }] }, {}),
    ).rejects.toMatchObject({ code: 'ADAPTER_VALIDATION_FAILED' });
  });

  it('empty children array → ADAPTER_VALIDATION_FAILED', async () => {
    const adapter = makeAdapter();
    await expect(
      adapter.create('append_block_children', { block_id: 'b1', children: [] }, {}),
    ).rejects.toMatchObject({ code: 'ADAPTER_VALIDATION_FAILED' });
  });

  it('children > 100 → ADAPTER_VALIDATION_FAILED with count in message', async () => {
    const adapter = makeAdapter();
    const children = Array.from({ length: 101 }, () => ({ type: 'paragraph' }));
    const err = await adapter
      .create('append_block_children', { block_id: 'b1', children }, {})
      .catch((e: unknown) => e as WorkflowError);
    expect(err.code).toBe('ADAPTER_VALIDATION_FAILED');
    expect(err.message).toContain('101');
  });

  it('child without type → ADAPTER_VALIDATION_FAILED', async () => {
    const adapter = makeAdapter();
    await expect(
      adapter.create(
        'append_block_children',
        { block_id: 'b1', children: [{ not_a_type: 'paragraph' }] },
        {},
      ),
    ).rejects.toMatchObject({ code: 'ADAPTER_VALIDATION_FAILED' });
  });

  it('child with empty type string → ADAPTER_VALIDATION_FAILED', async () => {
    const adapter = makeAdapter();
    await expect(
      adapter.create('append_block_children', { block_id: 'b1', children: [{ type: '' }] }, {}),
    ).rejects.toMatchObject({ code: 'ADAPTER_VALIDATION_FAILED' });
  });

  it('position: end is valid', async () => {
    respond(200, LIST_FIXTURE);
    const adapter = makeAdapter();
    await expect(
      adapter.create(
        'append_block_children',
        { block_id: 'b1', children: [{ type: 'paragraph' }], position: { type: 'end' } },
        {},
      ),
    ).resolves.toBeDefined();
  });

  it('position: invalid type → ADAPTER_VALIDATION_FAILED', async () => {
    const adapter = makeAdapter();
    await expect(
      adapter.create(
        'append_block_children',
        { block_id: 'b1', children: [{ type: 'p' }], position: { type: 'middle' } },
        {},
      ),
    ).rejects.toMatchObject({ code: 'ADAPTER_VALIDATION_FAILED' });
  });

  it('position: after_block without after_block.id → ADAPTER_VALIDATION_FAILED', async () => {
    const adapter = makeAdapter();
    await expect(
      adapter.create(
        'append_block_children',
        {
          block_id: 'b1',
          children: [{ type: 'p' }],
          position: { type: 'after_block', after_block: {} },
        },
        {},
      ),
    ).rejects.toMatchObject({ code: 'ADAPTER_VALIDATION_FAILED' });
  });

  it('position: after_block with valid id is accepted', async () => {
    respond(200, LIST_FIXTURE);
    const adapter = makeAdapter();
    await expect(
      adapter.create(
        'append_block_children',
        {
          block_id: 'b1',
          children: [{ type: 'paragraph' }],
          position: { type: 'after_block', after_block: { id: 'block-ref-id' } },
        },
        {},
      ),
    ).resolves.toBeDefined();
  });

  it('position is included in request body when present', async () => {
    respond(200, LIST_FIXTURE);
    const adapter = makeAdapter();
    await adapter.create(
      'append_block_children',
      {
        block_id: 'b1',
        children: [{ type: 'paragraph' }],
        position: { type: 'start' },
      },
      {},
    );
    const body = JSON.parse(lastRequestBody) as Record<string, unknown>;
    expect(body['position']).toEqual({ type: 'start' });
  });

  it('HTTP 401 → SERVICE_AUTH_FAILED', async () => {
    respond(401, { message: 'Unauthorized' });
    const adapter = makeAdapter();
    await expect(
      adapter.create('append_block_children', { block_id: 'b1', children: [{ type: 'p' }] }, {}),
    ).rejects.toMatchObject({ code: 'SERVICE_AUTH_FAILED' });
  });
});

// ---------------------------------------------------------------------------
// Tests: update_page
// ---------------------------------------------------------------------------

describe('NotionAdapter update_page', () => {
  it('uses correct URL and method: PATCH /v1/pages/{page_id}', async () => {
    respond(200, PAGE_FIXTURE);
    const adapter = makeAdapter();
    await adapter.update('update_page', { page_id: 'p-abc' }, {});
    expect(lastRequestUrl).toBe('/v1/pages/p-abc');
    expect(lastRequestMethod).toBe('PATCH');
  });

  it('returns data with id on success', async () => {
    respond(200, PAGE_FIXTURE);
    const adapter = makeAdapter();
    const result = await adapter.update('update_page', { page_id: 'p-abc' }, {});
    const data = result.data as typeof PAGE_FIXTURE;
    expect(data.id).toBe('page-uuid-1234');
  });

  it('optional fields included only when present', async () => {
    respond(200, PAGE_FIXTURE);
    const adapter = makeAdapter();
    await adapter.update('update_page', { page_id: 'p1', in_trash: true }, {});
    const body = JSON.parse(lastRequestBody) as Record<string, unknown>;
    expect(body['in_trash']).toBe(true);
    expect('is_locked' in body).toBe(false);
    expect('properties' in body).toBe(false);
  });

  it("'archived' key → ADAPTER_VALIDATION_FAILED with deprecation message", async () => {
    const adapter = makeAdapter();
    const err = await adapter
      .update('update_page', { page_id: 'p1', archived: true }, {})
      .catch((e: unknown) => e as WorkflowError);
    expect(err.code).toBe('ADAPTER_VALIDATION_FAILED');
    expect(err.message).toContain("'archived' is deprecated");
    expect(err.message).toContain('in_trash');
  });

  it('missing page_id → ADAPTER_VALIDATION_FAILED', async () => {
    const adapter = makeAdapter();
    await expect(adapter.update('update_page', {}, {})).rejects.toMatchObject({
      code: 'ADAPTER_VALIDATION_FAILED',
    });
  });

  it('HTTP 401 → SERVICE_AUTH_FAILED', async () => {
    respond(401, { message: 'Unauthorized' });
    const adapter = makeAdapter();
    await expect(adapter.update('update_page', { page_id: 'p1' }, {})).rejects.toMatchObject({
      code: 'SERVICE_AUTH_FAILED',
    });
  });

  it('HTTP 503 → SERVICE_HTTP_5XX, agentAction: wait_for_human', async () => {
    respond(503, { message: 'Service unavailable' });
    const adapter = makeAdapter();
    await expect(adapter.update('update_page', { page_id: 'p1' }, {})).rejects.toMatchObject({
      code: 'SERVICE_HTTP_5XX',
      agentAction: 'wait_for_human',
    });
  });

  it('HTTP 500 → SERVICE_HTTP_5XX, agentAction: report_to_user', async () => {
    respond(500, { message: 'Server error' });
    const adapter = makeAdapter();
    await expect(adapter.update('update_page', { page_id: 'p1' }, {})).rejects.toMatchObject({
      code: 'SERVICE_HTTP_5XX',
      agentAction: 'report_to_user',
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: delete_block
// ---------------------------------------------------------------------------

describe('NotionAdapter delete_block', () => {
  it('uses correct URL and method: DELETE /v1/blocks/{block_id}', async () => {
    respond(200, { id: 'block-abc', archived: true });
    const adapter = makeAdapter();
    await adapter.delete!('delete_block', { block_id: 'block-abc' }, {});
    expect(lastRequestUrl).toBe('/v1/blocks/block-abc');
    expect(lastRequestMethod).toBe('DELETE');
  });

  it('no Content-Type header on DELETE request', async () => {
    respond(200, { id: 'block-abc', archived: true });
    const adapter = makeAdapter();
    await adapter.delete!('delete_block', { block_id: 'block-abc' }, {});
    expect(lastRequestHeaders['content-type']).toBeUndefined();
  });

  it('returns data with id on success (archived block object)', async () => {
    const archived = { id: 'block-xyz', archived: true, type: 'paragraph' };
    respond(200, archived);
    const adapter = makeAdapter();
    const result = await adapter.delete!('delete_block', { block_id: 'block-xyz' }, {});
    const data = result.data as typeof archived;
    expect(data.id).toBe('block-xyz');
    expect(data.archived).toBe(true);
  });

  it('missing block_id → ADAPTER_VALIDATION_FAILED', async () => {
    const adapter = makeAdapter();
    await expect(adapter.delete!('delete_block', {}, {})).rejects.toMatchObject({
      code: 'ADAPTER_VALIDATION_FAILED',
    });
  });

  it('HTTP 404 → SERVICE_NOT_FOUND', async () => {
    respond(404, { message: 'Block not found' });
    const adapter = makeAdapter();
    await expect(adapter.delete!('delete_block', { block_id: 'b1' }, {})).rejects.toMatchObject({
      code: 'SERVICE_NOT_FOUND',
    });
  });

  it('HTTP 401 → SERVICE_AUTH_FAILED', async () => {
    respond(401, { message: 'Unauthorized' });
    const adapter = makeAdapter();
    await expect(adapter.delete!('delete_block', { block_id: 'b1' }, {})).rejects.toMatchObject({
      code: 'SERVICE_AUTH_FAILED',
    });
  });

  it('HTTP 429 → SERVICE_RATE_LIMITED, agentAction: wait_for_human', async () => {
    respond(429, { message: 'Rate limited' });
    const adapter = makeAdapter();
    await expect(adapter.delete!('delete_block', { block_id: 'b1' }, {})).rejects.toMatchObject({
      code: 'SERVICE_RATE_LIMITED',
      agentAction: 'wait_for_human',
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: Response validation
// ---------------------------------------------------------------------------

describe('NotionAdapter response validation', () => {
  it('get_page: 200 with non-JSON body → SERVICE_RESPONSE_INVALID', async () => {
    respondText(200, 'not valid json {{');
    const adapter = makeAdapter();
    await expect(adapter.fetch('get_page', { page_id: 'p1' }, {})).rejects.toMatchObject({
      code: 'SERVICE_RESPONSE_INVALID',
    });
  });

  it('get_page: response missing id field → SERVICE_RESPONSE_INVALID', async () => {
    respond(200, { object: 'page', properties: {} });
    const adapter = makeAdapter();
    await expect(adapter.fetch('get_page', { page_id: 'p1' }, {})).rejects.toMatchObject({
      code: 'SERVICE_RESPONSE_INVALID',
    });
  });

  it('list_block_children: response missing results field → SERVICE_RESPONSE_INVALID', async () => {
    respond(200, { object: 'list', has_more: false });
    const adapter = makeAdapter();
    await expect(
      adapter.fetch('list_block_children', { block_id: 'b1' }, {}),
    ).rejects.toMatchObject({ code: 'SERVICE_RESPONSE_INVALID' });
  });
});

// ---------------------------------------------------------------------------
// Tests: Network errors
// ---------------------------------------------------------------------------

describe('NotionAdapter network errors', () => {
  it('ECONNREFUSED → NETWORK_UNREACHABLE', async () => {
    const closedPort = await new Promise<number>((resolve) => {
      const tmp = net.createServer();
      tmp.listen(0, '127.0.0.1', () => {
        const addr = tmp.address() as { port: number };
        tmp.close(() => resolve(addr.port));
      });
    });

    const adapter = new NotionAdapter('notion', {
      api_key: 'secret_test',
      base_url: `http://127.0.0.1:${closedPort}`,
    });

    await expect(adapter.fetch('get_page', { page_id: 'p1' }, {})).rejects.toMatchObject({
      code: 'NETWORK_UNREACHABLE',
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: AbortSignal
// ---------------------------------------------------------------------------

describe('NotionAdapter AbortSignal', () => {
  it('pre-aborted signal throws STEP_ABORTED, no network call made', async () => {
    respond(200, PAGE_FIXTURE);

    const adapter = makeAdapter();
    const controller = new AbortController();
    controller.abort();

    await expect(
      adapter.fetch('get_page', { page_id: 'p1' }, {}, controller.signal),
    ).rejects.toMatchObject({ code: 'STEP_ABORTED' });

    expect(handlers).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Tests: Unsupported operations
// ---------------------------------------------------------------------------

describe('NotionAdapter unsupported operations', () => {
  it('fetch("unknown") → ADAPTER_OP_UNSUPPORTED', async () => {
    const adapter = makeAdapter();
    await expect(adapter.fetch('unknown', {}, {})).rejects.toMatchObject({
      code: 'ADAPTER_OP_UNSUPPORTED',
    });
  });

  it('create("unknown") → ADAPTER_OP_UNSUPPORTED', async () => {
    const adapter = makeAdapter();
    await expect(adapter.create('unknown', {}, {})).rejects.toMatchObject({
      code: 'ADAPTER_OP_UNSUPPORTED',
    });
  });

  it('update("unknown") → ADAPTER_OP_UNSUPPORTED', async () => {
    const adapter = makeAdapter();
    await expect(adapter.update('unknown', {}, {})).rejects.toMatchObject({
      code: 'ADAPTER_OP_UNSUPPORTED',
    });
  });

  it('update("update_block") → ADAPTER_OP_UNSUPPORTED', async () => {
    const adapter = makeAdapter();
    await expect(adapter.update('update_block', { block_id: 'b1' }, {})).rejects.toMatchObject({
      code: 'ADAPTER_OP_UNSUPPORTED',
    });
  });

  it('delete("unknown") → ADAPTER_OP_UNSUPPORTED', async () => {
    const adapter = makeAdapter();
    await expect(adapter.delete!('unknown', {}, {})).rejects.toMatchObject({
      code: 'ADAPTER_OP_UNSUPPORTED',
    });
  });
});
