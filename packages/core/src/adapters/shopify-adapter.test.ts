import * as http from 'node:http';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { ShopifyAdapter } from './shopify-adapter.js';
import type { ShopifyAdapterConfig } from './shopify-adapter.js';
import { WorkflowError } from '../types/workflow-error.js';

// ---------------------------------------------------------------------------
// Mock server
// ---------------------------------------------------------------------------

type RequestHandler = (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void;

let port: number;
let server: http.Server;
const handlers: RequestHandler[] = [];

// Last received request details for assertions
let lastRequestHeaders: http.IncomingHttpHeaders = {};
let lastRequestBody = '';
let lastRequestMethod = '';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf-8');
      lastRequestHeaders = req.headers;
      lastRequestBody = body;
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

/** Register a static JSON response. */
function respondWith(
  statusCode: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  handlers.push((_req, res) => {
    res.writeHead(statusCode, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  });
}

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

const VALID_CONFIG: ShopifyAdapterConfig = {
  stores: {
    mystore: {
      shop_domain: 'mystore.myshopify.com',
      access_token: 'shpat_test_token',
    },
  },
  base_url: `http://127.0.0.1:${port}`,
};

function makeAdapter(overrides: Partial<ShopifyAdapterConfig> = {}): ShopifyAdapter {
  return new ShopifyAdapter('shopify', {
    ...VALID_CONFIG,
    base_url: `http://127.0.0.1:${port}`,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Tests: Constructor validation
// ---------------------------------------------------------------------------

describe('ShopifyAdapter construction', () => {
  it('throws when stores is empty', () => {
    expect(() => new ShopifyAdapter('id', { stores: {}, base_url: 'http://localhost' })).toThrow(
      'ShopifyAdapter: stores must not be empty',
    );
  });

  it('throws for invalid shop_domain', () => {
    expect(
      () =>
        new ShopifyAdapter('id', {
          stores: { a: { shop_domain: 'not-a-shopify-domain.com', access_token: 'tok' } },
          base_url: 'http://localhost',
        }),
    ).toThrow('ShopifyAdapter: invalid shop_domain for store "a"');
  });

  it('throws for empty access_token', () => {
    expect(
      () =>
        new ShopifyAdapter('id', {
          stores: { a: { shop_domain: 'mystore.myshopify.com', access_token: '' } },
          base_url: 'http://localhost',
        }),
    ).toThrow('ShopifyAdapter: access_token must not be empty for store "a"');
  });

  it('throws for invalid api_version', () => {
    expect(
      () =>
        new ShopifyAdapter('id', {
          stores: { a: { shop_domain: 'mystore.myshopify.com', access_token: 'tok' } },
          api_version: 'foobar',
          base_url: 'http://localhost',
        }),
    ).toThrow('ShopifyAdapter: invalid api_version');
  });

  it('constructs successfully with valid config', () => {
    const adapter = makeAdapter();
    expect(adapter.id).toBe('shopify');
  });
});

// ---------------------------------------------------------------------------
// Tests: fetch('query') — param validation
// ---------------------------------------------------------------------------

describe("ShopifyAdapter fetch('query') param validation", () => {
  it('throws ADAPTER_VALIDATION_FAILED when store is a number', async () => {
    const adapter = makeAdapter();
    await expect(
      adapter.fetch('query', { store: 42, query: '{ shop { name } }' }, {}),
    ).rejects.toMatchObject({ code: 'ADAPTER_VALIDATION_FAILED' });
  });

  it('throws ADAPTER_VALIDATION_FAILED when store is empty string', async () => {
    const adapter = makeAdapter();
    await expect(
      adapter.fetch('query', { store: '', query: '{ shop { name } }' }, {}),
    ).rejects.toMatchObject({ code: 'ADAPTER_VALIDATION_FAILED' });
  });

  it('throws ADAPTER_VALIDATION_FAILED with details.store when store not in map', async () => {
    const adapter = makeAdapter();
    const err = await adapter
      .fetch('query', { store: 'unknown', query: '{ shop { name } }' }, {})
      .catch((e: unknown) => e as WorkflowError);
    expect(err).toBeInstanceOf(WorkflowError);
    expect(err.code).toBe('ADAPTER_VALIDATION_FAILED');
    expect(err.details['store']).toBe('unknown');
  });

  it('throws ADAPTER_VALIDATION_FAILED when query is missing', async () => {
    const adapter = makeAdapter();
    await expect(adapter.fetch('query', { store: 'mystore' }, {})).rejects.toMatchObject({
      code: 'ADAPTER_VALIDATION_FAILED',
    });
  });

  it('throws ADAPTER_VALIDATION_FAILED when query is empty string', async () => {
    const adapter = makeAdapter();
    await expect(adapter.fetch('query', { store: 'mystore', query: '' }, {})).rejects.toMatchObject(
      { code: 'ADAPTER_VALIDATION_FAILED' },
    );
  });
});

// ---------------------------------------------------------------------------
// Tests: fetch('query') — HTTP errors
// ---------------------------------------------------------------------------

describe("ShopifyAdapter fetch('query') HTTP errors", () => {
  it('throws SERVICE_AUTH_FAILED on HTTP 401', async () => {
    respondWith(401, { errors: 'Unauthorized' });
    const adapter = makeAdapter();
    await expect(
      adapter.fetch('query', { store: 'mystore', query: '{ shop { name } }' }, {}),
    ).rejects.toMatchObject({ code: 'SERVICE_AUTH_FAILED' });
  });

  it('throws SERVICE_RATE_LIMITED on HTTP 429 with Retry-After header', async () => {
    respondWith(429, { errors: 'Too Many Requests' }, { 'Retry-After': '10' });
    const adapter = makeAdapter();
    const err = await adapter
      .fetch('query', { store: 'mystore', query: '{ shop { name } }' }, {})
      .catch((e: unknown) => e as WorkflowError);
    expect(err).toBeInstanceOf(WorkflowError);
    expect(err.code).toBe('SERVICE_RATE_LIMITED');
    expect(err.agentAction).toBe('wait_and_proceed');
    expect(err.retry_after).toBe(10);
    expect(err.details['retry_after']).toBeUndefined();
  });

  it('throws SERVICE_RATE_LIMITED on HTTP 429 without Retry-After header, retry_after is undefined (resolved by callAdapter)', async () => {
    respondWith(429, { errors: 'Too Many Requests' });
    const adapter = makeAdapter();
    const err = await adapter
      .fetch('query', { store: 'mystore', query: '{ shop { name } }' }, {})
      .catch((e: unknown) => e as WorkflowError);
    expect(err).toBeInstanceOf(WorkflowError);
    expect(err.code).toBe('SERVICE_RATE_LIMITED');
    expect(err.agentAction).toBe('wait_and_proceed');
    expect(err.retry_after).toBeUndefined();
    expect(adapter.defaultRetryAfterSeconds).toBe(30);
  });

  it('throws SERVICE_HTTP_4XX on HTTP 403', async () => {
    respondWith(403, { errors: 'Forbidden' });
    const adapter = makeAdapter();
    const err = await adapter
      .fetch('query', { store: 'mystore', query: '{ shop { name } }' }, {})
      .catch((e: unknown) => e as WorkflowError);
    expect(err).toBeInstanceOf(WorkflowError);
    expect(err.code).toBe('SERVICE_HTTP_4XX');
    expect(err.retryable).toBe(false);
    expect(err.agentAction).toBe('stop');
  });

  it('throws SERVICE_HTTP_4XX on HTTP 422', async () => {
    respondWith(422, { errors: 'Unprocessable Entity' });
    const adapter = makeAdapter();
    await expect(
      adapter.fetch('query', { store: 'mystore', query: '{ shop { name } }' }, {}),
    ).rejects.toMatchObject({ code: 'SERVICE_HTTP_4XX' });
  });

  it('throws SERVICE_HTTP_5XX on HTTP 503', async () => {
    respondWith(503, { errors: 'Service Unavailable' });
    const adapter = makeAdapter();
    await expect(
      adapter.fetch('query', { store: 'mystore', query: '{ shop { name } }' }, {}),
    ).rejects.toMatchObject({ code: 'SERVICE_HTTP_5XX', retryable: true });
  });
});

// ---------------------------------------------------------------------------
// Tests: fetch('query') — GraphQL errors
// ---------------------------------------------------------------------------

describe("ShopifyAdapter fetch('query') GraphQL errors", () => {
  it('throws SERVICE_RATE_LIMITED when errors[0].extensions.code === "THROTTLED"', async () => {
    respondWith(200, {
      errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }],
    });
    const adapter = makeAdapter();
    const err = await adapter
      .fetch('query', { store: 'mystore', query: '{ shop { name } }' }, {})
      .catch((e: unknown) => e as WorkflowError);
    expect(err).toBeInstanceOf(WorkflowError);
    expect(err.code).toBe('SERVICE_RATE_LIMITED');
    expect(err.agentAction).toBe('wait_and_proceed');
    expect(err.retry_after).toBe(2);
  });

  it('resolves with raw body when GraphQL errors are non-THROTTLED', async () => {
    const rawBody = {
      data: null,
      errors: [{ message: 'Field not found', extensions: { code: 'FIELD_ERROR' } }],
    };
    respondWith(200, rawBody);
    const adapter = makeAdapter();
    const result = await adapter.fetch(
      'query',
      { store: 'mystore', query: '{ shop { name } }' },
      {},
    );
    expect(result.status).toBe(200);
    expect(result.data).toEqual(rawBody);
  });
});

// ---------------------------------------------------------------------------
// Tests: fetch('query') — request forwarding
// ---------------------------------------------------------------------------

describe("ShopifyAdapter fetch('query') request forwarding", () => {
  it('forwards query string verbatim to request body', async () => {
    const gqlQuery = 'query TestQuery { shop { name } }';
    respondWith(200, { data: { shop: { name: 'My Store' } } });
    const adapter = makeAdapter();
    await adapter.fetch('query', { store: 'mystore', query: gqlQuery }, {});
    expect(lastRequestMethod).toBe('POST');
    const body = JSON.parse(lastRequestBody) as { query: string };
    expect(body.query).toBe(gqlQuery);
  });

  it('forwards variables when provided', async () => {
    respondWith(200, { data: { orders: { edges: [] } } });
    const adapter = makeAdapter();
    const vars = { orderId: 'gid://shopify/Order/123' };
    await adapter.fetch(
      'query',
      { store: 'mystore', query: '{ shop { name } }', variables: vars },
      {},
    );
    const body = JSON.parse(lastRequestBody) as { variables: unknown };
    expect(body.variables).toEqual(vars);
  });

  it('omits variables from request body when not provided', async () => {
    respondWith(200, { data: { shop: { name: 'My Store' } } });
    const adapter = makeAdapter();
    await adapter.fetch('query', { store: 'mystore', query: '{ shop { name } }' }, {});
    const body = JSON.parse(lastRequestBody) as Record<string, unknown>;
    expect(body['variables']).toBeUndefined();
  });

  it('uses correct X-Shopify-Access-Token header per store', async () => {
    const multiAdapter = new ShopifyAdapter('shopify', {
      stores: {
        store_a: { shop_domain: 'store-a.myshopify.com', access_token: 'token_a' },
        store_b: { shop_domain: 'store-b.myshopify.com', access_token: 'token_b' },
      },
      base_url: `http://127.0.0.1:${port}`,
    });

    respondWith(200, { data: { shop: { name: 'A' } } });
    await multiAdapter.fetch('query', { store: 'store_a', query: '{ shop { name } }' }, {});
    expect(lastRequestHeaders['x-shopify-access-token']).toBe('token_a');

    respondWith(200, { data: { shop: { name: 'B' } } });
    await multiAdapter.fetch('query', { store: 'store_b', query: '{ shop { name } }' }, {});
    expect(lastRequestHeaders['x-shopify-access-token']).toBe('token_b');
  });
});

// ---------------------------------------------------------------------------
// Tests: fetch('query') — response passthrough
// ---------------------------------------------------------------------------

describe("ShopifyAdapter fetch('query') response passthrough", () => {
  it('returns raw GraphQL response body — data field preserved as-is', async () => {
    const rawBody = {
      data: {
        orders: { edges: [{ node: { id: 'gid://shopify/Order/123', name: '#1001' } }] },
      },
    };
    respondWith(200, rawBody);
    const adapter = makeAdapter();
    const result = await adapter.fetch(
      'query',
      { store: 'mystore', query: '{ shop { name } }' },
      {},
    );
    expect(result.status).toBe(200);
    expect(result.data).toEqual(rawBody);
  });

  it('returns raw body including errors array when GraphQL errors are non-THROTTLED', async () => {
    const rawBody = {
      data: null,
      errors: [{ message: 'Field not found', extensions: { code: 'FIELD_ERROR' } }],
    };
    respondWith(200, rawBody);
    const adapter = makeAdapter();
    const result = await adapter.fetch(
      'query',
      { store: 'mystore', query: '{ shop { name } }' },
      {},
    );
    expect(result.status).toBe(200);
    expect(result.data).toEqual(rawBody);
  });
});

// ---------------------------------------------------------------------------
// Tests: create and update
// ---------------------------------------------------------------------------

describe('ShopifyAdapter create and update', () => {
  it('create throws ADAPTER_OP_UNSUPPORTED', async () => {
    const adapter = makeAdapter();
    await expect(adapter.create('anything', {}, {})).rejects.toMatchObject({
      code: 'ADAPTER_OP_UNSUPPORTED',
    });
    await expect(adapter.create('anything', {}, {})).rejects.toBeInstanceOf(WorkflowError);
  });

  it('update throws ADAPTER_OP_UNSUPPORTED', async () => {
    const adapter = makeAdapter();
    await expect(adapter.update('anything', {}, {})).rejects.toMatchObject({
      code: 'ADAPTER_OP_UNSUPPORTED',
    });
    await expect(adapter.update('anything', {}, {})).rejects.toBeInstanceOf(WorkflowError);
  });
});

// ---------------------------------------------------------------------------
// Tests: AbortSignal
// ---------------------------------------------------------------------------

describe('ShopifyAdapter AbortSignal', () => {
  it('pre-aborted signal throws STEP_ABORTED without making a network call', async () => {
    const adapter = makeAdapter();
    const controller = new AbortController();
    controller.abort();
    await expect(
      adapter.fetch(
        'query',
        { store: 'mystore', query: '{ shop { name } }' },
        {},
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: 'STEP_ABORTED' });
    // No handler was consumed — confirms no network call was made
    expect(handlers).toHaveLength(0);
  });
});
