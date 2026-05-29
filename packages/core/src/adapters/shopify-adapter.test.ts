import * as http from 'node:http';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { ShopifyAdapter } from './shopify-adapter.js';
import type { ShopifyAdapterConfig, NormalizedOrder } from './shopify-adapter.js';
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

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf-8');
      lastRequestHeaders = req.headers;
      lastRequestBody = body;
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
// Complete order fixture
// ---------------------------------------------------------------------------

const FULL_ORDER_NODE = {
  id: 'gid://shopify/Order/450789469',
  legacyResourceId: '450789469',
  number: 1234,
  name: '#1234',
  displayFinancialStatus: 'PAID',
  displayFulfillmentStatus: 'FULFILLED',
  cancelledAt: null,
  cancelReason: null,
  createdAt: '2024-01-15T10:30:00Z',
  customer: {
    firstName: 'Jane',
    lastName: 'Doe',
    email: 'jane@example.com',
  },
  currentTotalPriceSet: { shopMoney: { amount: '99.99', currencyCode: 'EUR' } },
  currentSubtotalPriceSet: { shopMoney: { amount: '89.99' } },
  currentShippingPriceSet: { shopMoney: { amount: '5.00' } },
  discountCodes: ['SUMMER10'],
  lineItems: {
    edges: [
      {
        node: {
          name: 'Blue T-Shirt',
          quantity: 2,
          originalUnitPriceSet: { shopMoney: { amount: '44.99' } },
        },
      },
    ],
  },
};

function gqlSuccess(node: unknown) {
  return {
    data: {
      orders: {
        edges: [{ node }],
      },
    },
  };
}

function gqlEmpty() {
  return { data: { orders: { edges: [] } } };
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
// Tests: fetch('get_order') — param validation
// ---------------------------------------------------------------------------

describe("ShopifyAdapter fetch('get_order') param validation", () => {
  it('throws ADAPTER_VALIDATION_FAILED when store is a number', async () => {
    const adapter = makeAdapter();
    await expect(
      adapter.fetch('get_order', { store: 42, order_name: '#1234' }, {}),
    ).rejects.toMatchObject({ code: 'ADAPTER_VALIDATION_FAILED' });
  });

  it('throws ADAPTER_VALIDATION_FAILED with details.store when store not in map', async () => {
    const adapter = makeAdapter();
    const err = await adapter
      .fetch('get_order', { store: 'unknown', order_name: '#1234' }, {})
      .catch((e: unknown) => e as WorkflowError);
    expect(err).toBeInstanceOf(WorkflowError);
    expect(err.code).toBe('ADAPTER_VALIDATION_FAILED');
    expect(err.details['store']).toBe('unknown');
  });

  it('throws ADAPTER_VALIDATION_FAILED when order_name is empty string', async () => {
    const adapter = makeAdapter();
    await expect(
      adapter.fetch('get_order', { store: 'mystore', order_name: '' }, {}),
    ).rejects.toMatchObject({ code: 'ADAPTER_VALIDATION_FAILED' });
  });

  it('normalizes "1234" to "#1234" before sending to API', async () => {
    respondWith(200, gqlSuccess(FULL_ORDER_NODE));
    const adapter = makeAdapter();
    await adapter.fetch('get_order', { store: 'mystore', order_name: '1234' }, {});
    const reqBody = JSON.parse(lastRequestBody) as { variables: { query: string } };
    expect(reqBody.variables.query).toBe('name:#1234');
  });
});

// ---------------------------------------------------------------------------
// Tests: fetch('get_order') — HTTP errors
// ---------------------------------------------------------------------------

describe("ShopifyAdapter fetch('get_order') HTTP errors", () => {
  it('throws SERVICE_AUTH_FAILED on HTTP 401', async () => {
    respondWith(401, { errors: 'Unauthorized' });
    const adapter = makeAdapter();
    await expect(
      adapter.fetch('get_order', { store: 'mystore', order_name: '#1234' }, {}),
    ).rejects.toMatchObject({ code: 'SERVICE_AUTH_FAILED' });
  });

  it('throws SERVICE_RATE_LIMITED on HTTP 429 with retry_after in details', async () => {
    respondWith(429, { errors: 'Too Many Requests' }, { 'Retry-After': '10' });
    const adapter = makeAdapter();
    const err = await adapter
      .fetch('get_order', { store: 'mystore', order_name: '#1234' }, {})
      .catch((e: unknown) => e as WorkflowError);
    expect(err).toBeInstanceOf(WorkflowError);
    expect(err.code).toBe('SERVICE_RATE_LIMITED');
    expect(err.details['retry_after']).toBe('10');
  });

  it('throws SERVICE_HTTP_4XX on HTTP 422', async () => {
    respondWith(422, { errors: 'Unprocessable Entity' });
    const adapter = makeAdapter();
    await expect(
      adapter.fetch('get_order', { store: 'mystore', order_name: '#1234' }, {}),
    ).rejects.toMatchObject({ code: 'SERVICE_HTTP_4XX' });
  });

  it('throws SERVICE_HTTP_5XX on HTTP 503', async () => {
    respondWith(503, { errors: 'Service Unavailable' });
    const adapter = makeAdapter();
    await expect(
      adapter.fetch('get_order', { store: 'mystore', order_name: '#1234' }, {}),
    ).rejects.toMatchObject({ code: 'SERVICE_HTTP_5XX', retryable: true });
  });
});

// ---------------------------------------------------------------------------
// Tests: fetch('get_order') — GraphQL errors
// ---------------------------------------------------------------------------

describe("ShopifyAdapter fetch('get_order') GraphQL errors", () => {
  it('throws SERVICE_RATE_LIMITED when errors[0].extensions.code === "THROTTLED"', async () => {
    respondWith(200, {
      errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }],
    });
    const adapter = makeAdapter();
    await expect(
      adapter.fetch('get_order', { store: 'mystore', order_name: '#1234' }, {}),
    ).rejects.toMatchObject({ code: 'SERVICE_RATE_LIMITED' });
  });

  it('throws SERVICE_RESPONSE_INVALID for non-throttle GraphQL error', async () => {
    respondWith(200, {
      errors: [{ message: 'Field not found', extensions: { code: 'FIELD_ERROR' } }],
    });
    const adapter = makeAdapter();
    await expect(
      adapter.fetch('get_order', { store: 'mystore', order_name: '#1234' }, {}),
    ).rejects.toMatchObject({ code: 'SERVICE_RESPONSE_INVALID' });
  });
});

// ---------------------------------------------------------------------------
// Tests: fetch('get_order') — not found
// ---------------------------------------------------------------------------

describe("ShopifyAdapter fetch('get_order') not found", () => {
  it('throws SERVICE_NOT_FOUND with details when edges is empty', async () => {
    respondWith(200, gqlEmpty());
    const adapter = makeAdapter();
    const err = await adapter
      .fetch('get_order', { store: 'mystore', order_name: '#1234' }, {})
      .catch((e: unknown) => e as WorkflowError);
    expect(err).toBeInstanceOf(WorkflowError);
    expect(err.code).toBe('SERVICE_NOT_FOUND');
    expect(err.details['store']).toBe('mystore');
    expect(err.details['order_name']).toBe('#1234');
  });
});

// ---------------------------------------------------------------------------
// Tests: fetch('get_order') — successful normalization
// ---------------------------------------------------------------------------

describe("ShopifyAdapter fetch('get_order') normalization", () => {
  it('returns { status: 200, data: NormalizedOrder } with all fields populated', async () => {
    respondWith(200, gqlSuccess(FULL_ORDER_NODE));
    const adapter = makeAdapter();
    const result = await adapter.fetch('get_order', { store: 'mystore', order_name: '#1234' }, {});
    expect(result.status).toBe(200);
    const data = result.data as NormalizedOrder;
    expect(data.id).toBe('gid://shopify/Order/450789469');
    expect(data.legacy_id).toBe('450789469');
    expect(data.order_number).toBe(1234);
    expect(data.name).toBe('#1234');
    expect(data.financial_status).toBe('PAID');
    expect(data.fulfillment_status).toBe('FULFILLED');
    expect(data.cancelled_at).toBeNull();
    expect(data.cancel_reason).toBeNull();
    expect(data.created_at).toBe('2024-01-15T10:30:00Z');
    expect(data.customer).toEqual({
      first_name: 'Jane',
      last_name: 'Doe',
      email: 'jane@example.com',
    });
    expect(data.total_price).toBe('99.99');
    expect(data.subtotal_price).toBe('89.99');
    expect(data.shipping_total).toBe('5.00');
    expect(data.currency).toBe('EUR');
    expect(data.discount_codes).toEqual(['SUMMER10']);
    expect(data.line_items).toEqual([{ name: 'Blue T-Shirt', quantity: 2, price: '44.99' }]);
  });

  it('customer is null for guest checkout (node.customer is null)', async () => {
    const node = { ...FULL_ORDER_NODE, customer: null };
    respondWith(200, gqlSuccess(node));
    const adapter = makeAdapter();
    const result = await adapter.fetch('get_order', { store: 'mystore', order_name: '#1234' }, {});
    expect((result.data as NormalizedOrder).customer).toBeNull();
  });

  it('customer.email is null when node.customer.email is empty string', async () => {
    const node = {
      ...FULL_ORDER_NODE,
      customer: { firstName: 'Jo', lastName: 'Blank', email: '' },
    };
    respondWith(200, gqlSuccess(node));
    const adapter = makeAdapter();
    const result = await adapter.fetch('get_order', { store: 'mystore', order_name: '#1234' }, {});
    expect((result.data as NormalizedOrder).customer?.email).toBeNull();
  });

  it('discount_codes is [] when node.discountCodes is []', async () => {
    const node = { ...FULL_ORDER_NODE, discountCodes: [] };
    respondWith(200, gqlSuccess(node));
    const adapter = makeAdapter();
    const result = await adapter.fetch('get_order', { store: 'mystore', order_name: '#1234' }, {});
    expect((result.data as NormalizedOrder).discount_codes).toEqual([]);
  });

  it('shipping_total is "0.00" when currentShippingPriceSet.shopMoney.amount is "0.00"', async () => {
    const node = {
      ...FULL_ORDER_NODE,
      currentShippingPriceSet: { shopMoney: { amount: '0.00' } },
    };
    respondWith(200, gqlSuccess(node));
    const adapter = makeAdapter();
    const result = await adapter.fetch('get_order', { store: 'mystore', order_name: '#1234' }, {});
    expect((result.data as NormalizedOrder).shipping_total).toBe('0.00');
  });

  it('uses correct X-Shopify-Access-Token header per store (multi-store)', async () => {
    const multiAdapter = new ShopifyAdapter('shopify', {
      stores: {
        store_a: { shop_domain: 'store-a.myshopify.com', access_token: 'token_a' },
        store_b: { shop_domain: 'store-b.myshopify.com', access_token: 'token_b' },
      },
      base_url: `http://127.0.0.1:${port}`,
    });

    // First: store_a
    respondWith(200, gqlSuccess(FULL_ORDER_NODE));
    await multiAdapter.fetch('get_order', { store: 'store_a', order_name: '#1234' }, {});
    expect(lastRequestHeaders['x-shopify-access-token']).toBe('token_a');

    // Second: store_b
    respondWith(200, gqlSuccess(FULL_ORDER_NODE));
    await multiAdapter.fetch('get_order', { store: 'store_b', order_name: '#1234' }, {});
    expect(lastRequestHeaders['x-shopify-access-token']).toBe('token_b');
  });
});

// ---------------------------------------------------------------------------
// Tests: request construction
// ---------------------------------------------------------------------------

describe("ShopifyAdapter fetch('get_order') request construction", () => {
  it('request body contains correct variables: { query: "name:#1234" }', async () => {
    respondWith(200, gqlSuccess(FULL_ORDER_NODE));
    const adapter = makeAdapter();
    await adapter.fetch('get_order', { store: 'mystore', order_name: '#1234' }, {});
    const body = JSON.parse(lastRequestBody) as { variables: { query: string } };
    expect(body.variables).toEqual({ query: 'name:#1234' });
  });

  it('request body query field contains "OrderByName"', async () => {
    respondWith(200, gqlSuccess(FULL_ORDER_NODE));
    const adapter = makeAdapter();
    await adapter.fetch('get_order', { store: 'mystore', order_name: '#1234' }, {});
    const body = JSON.parse(lastRequestBody) as { query: string };
    expect(body.query).toContain('OrderByName');
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
      adapter.fetch('get_order', { store: 'mystore', order_name: '#1234' }, {}, controller.signal),
    ).rejects.toMatchObject({ code: 'STEP_ABORTED' });
    // No handler was consumed — confirms no network call was made
    expect(handlers).toHaveLength(0);
  });
});
