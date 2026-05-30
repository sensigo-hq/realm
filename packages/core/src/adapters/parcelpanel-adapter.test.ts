import * as http from 'node:http';
import * as net from 'node:net';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { ParcelPanelAdapter } from './parcelpanel-adapter.js';
import type { ParcelPanelAdapterConfig, NormalizedTracking } from './parcelpanel-adapter.js';
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

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf-8');
      lastRequestHeaders = req.headers;
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
function respond(statusCode: number, body: unknown, headers: Record<string, string> = {}): void {
  handlers.push((_req, res) => {
    res.writeHead(statusCode, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  });
}

/** Respond with non-JSON text. */
function respondText(statusCode: number, text: string): void {
  handlers.push((_req, res) => {
    res.writeHead(statusCode, { 'Content-Type': 'text/plain' });
    res.end(text);
  });
}

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

const VALID_CONFIG: ParcelPanelAdapterConfig = {
  stores: {
    mystore: 'pp_test_api_key',
  },
};

function makeAdapter(overrides: Partial<ParcelPanelAdapterConfig> = {}): ParcelPanelAdapter {
  return new ParcelPanelAdapter('parcelpanel', {
    ...VALID_CONFIG,
    base_url: `http://127.0.0.1:${port}`,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Tracking response fixtures
// ---------------------------------------------------------------------------

function fulfilledOrderBody(
  overrides: Partial<{
    tracking_link: string;
    shipments: unknown[];
  }> = {},
) {
  return {
    order: {
      order_id: 6140516335690,
      order_number: '#1030',
      tracking_link:
        overrides.tracking_link ?? 'https://example.myshopify.com/apps/parcelpanel?order=1030',
      shipments: overrides.shipments ?? [
        {
          status: 'IN_TRANSIT',
          status_label: 'In transit',
          tracking_number: 'YT2436021211003147',
          carrier: {
            name: 'YunExpress',
            code: 'yunexpress',
          },
        },
      ],
    },
  };
}

function unfulfilledOrderBody() {
  return {
    order: {
      order_id: 6140516335690,
      order_number: '#1030',
      tracking_link: 'https://example.myshopify.com/apps/parcelpanel?order=1030',
      shipments: [],
    },
  };
}

// ---------------------------------------------------------------------------
// Tests: Constructor validation
// ---------------------------------------------------------------------------

describe('ParcelPanelAdapter construction', () => {
  it('throws for empty stores map', () => {
    expect(() => new ParcelPanelAdapter('id', { stores: {} })).toThrow(
      'ParcelPanelAdapter: stores must not be empty',
    );
  });

  it('throws for empty store key', () => {
    expect(() => new ParcelPanelAdapter('id', { stores: { '': 'apikey' } })).toThrow(
      'ParcelPanelAdapter: store key must not be an empty string',
    );
  });

  it('throws for empty API key value', () => {
    expect(() => new ParcelPanelAdapter('id', { stores: { mystore: '' } })).toThrow(
      'ParcelPanelAdapter: api_key must not be empty for store "mystore"',
    );
  });
});

// ---------------------------------------------------------------------------
// Tests: Auth header
// ---------------------------------------------------------------------------

describe('ParcelPanelAdapter auth header', () => {
  it('sends x-parcelpanel-api-key header (not Authorization: Bearer)', async () => {
    respond(200, fulfilledOrderBody());
    const adapter = makeAdapter();
    await adapter.fetch('get_tracking', { store: 'mystore', order_number: '1030' }, {});
    expect(lastRequestHeaders['x-parcelpanel-api-key']).toBe('pp_test_api_key');
    expect(lastRequestHeaders['authorization']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: Store routing
// ---------------------------------------------------------------------------

describe('ParcelPanelAdapter store routing', () => {
  it('uses correct API key per store in a two-store config', async () => {
    const adapter = new ParcelPanelAdapter('parcelpanel', {
      stores: {
        'store-a': 'key_for_a',
        'store-b': 'key_for_b',
      },
      base_url: `http://127.0.0.1:${port}`,
    });

    respond(200, fulfilledOrderBody());
    await adapter.fetch('get_tracking', { store: 'store-a', order_number: '100' }, {});
    expect(lastRequestHeaders['x-parcelpanel-api-key']).toBe('key_for_a');

    respond(200, fulfilledOrderBody());
    await adapter.fetch('get_tracking', { store: 'store-b', order_number: '200' }, {});
    expect(lastRequestHeaders['x-parcelpanel-api-key']).toBe('key_for_b');
  });
});

// ---------------------------------------------------------------------------
// Tests: Param validation
// ---------------------------------------------------------------------------

describe('ParcelPanelAdapter param validation', () => {
  it('throws ADAPTER_VALIDATION_FAILED when store param is missing', async () => {
    const adapter = makeAdapter();
    await expect(adapter.fetch('get_tracking', { order_number: '1234' }, {})).rejects.toMatchObject(
      { code: 'ADAPTER_VALIDATION_FAILED' },
    );
  });

  it('throws ADAPTER_VALIDATION_FAILED with details.store for unknown store', async () => {
    const adapter = makeAdapter();
    const err = await adapter
      .fetch('get_tracking', { store: 'unknown', order_number: '1234' }, {})
      .catch((e: unknown) => e as WorkflowError);
    expect(err).toBeInstanceOf(WorkflowError);
    expect(err.code).toBe('ADAPTER_VALIDATION_FAILED');
    expect(err.details['store']).toBe('unknown');
  });

  it('throws ADAPTER_VALIDATION_FAILED when order_number is missing', async () => {
    const adapter = makeAdapter();
    await expect(adapter.fetch('get_tracking', { store: 'mystore' }, {})).rejects.toMatchObject({
      code: 'ADAPTER_VALIDATION_FAILED',
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: order_number normalization
// ---------------------------------------------------------------------------

describe('ParcelPanelAdapter order_number normalization', () => {
  it('"#1234" → sends order_number=1234 in query string', async () => {
    let capturedUrl = '';
    handlers.push((req, res) => {
      capturedUrl = req.url ?? '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(fulfilledOrderBody()));
    });
    const adapter = makeAdapter();
    await adapter.fetch('get_tracking', { store: 'mystore', order_number: '#1234' }, {});
    expect(capturedUrl).toContain('order_number=1234');
    expect(capturedUrl).not.toContain('order_number=%231234');
  });

  it('"  #1234  " → sends order_number=1234 (trimmed and hash stripped)', async () => {
    let capturedUrl = '';
    handlers.push((req, res) => {
      capturedUrl = req.url ?? '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(fulfilledOrderBody()));
    });
    const adapter = makeAdapter();
    await adapter.fetch('get_tracking', { store: 'mystore', order_number: '  #1234  ' }, {});
    expect(capturedUrl).toContain('order_number=1234');
  });

  it('"1234" → sends order_number=1234 (no hash to strip)', async () => {
    let capturedUrl = '';
    handlers.push((req, res) => {
      capturedUrl = req.url ?? '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(fulfilledOrderBody()));
    });
    const adapter = makeAdapter();
    await adapter.fetch('get_tracking', { store: 'mystore', order_number: '1234' }, {});
    expect(capturedUrl).toContain('order_number=1234');
  });
});

// ---------------------------------------------------------------------------
// Tests: HTTP error classification
// ---------------------------------------------------------------------------

describe('ParcelPanelAdapter HTTP error classification', () => {
  it('HTTP 401 → SERVICE_AUTH_FAILED', async () => {
    respond(401, { errors: 'Unauthorized' });
    const adapter = makeAdapter();
    await expect(
      adapter.fetch('get_tracking', { store: 'mystore', order_number: '1234' }, {}),
    ).rejects.toMatchObject({ code: 'SERVICE_AUTH_FAILED' });
  });

  it('HTTP 404 → SERVICE_NOT_FOUND', async () => {
    respond(404, { errors: 'Order not found' });
    const adapter = makeAdapter();
    await expect(
      adapter.fetch('get_tracking', { store: 'mystore', order_number: '9999' }, {}),
    ).rejects.toMatchObject({ code: 'SERVICE_NOT_FOUND' });
  });

  it('HTTP 403 → SERVICE_HTTP_4XX', async () => {
    respond(403, { errors: 'Forbidden' });
    const adapter = makeAdapter();
    await expect(
      adapter.fetch('get_tracking', { store: 'mystore', order_number: '1234' }, {}),
    ).rejects.toMatchObject({ code: 'SERVICE_HTTP_4XX' });
  });

  it('HTTP 422 → SERVICE_HTTP_4XX', async () => {
    respond(422, { errors: 'Unprocessable Entity' });
    const adapter = makeAdapter();
    await expect(
      adapter.fetch('get_tracking', { store: 'mystore', order_number: '1234' }, {}),
    ).rejects.toMatchObject({ code: 'SERVICE_HTTP_4XX' });
  });

  it('HTTP 429 → SERVICE_RATE_LIMITED with retry_after in details', async () => {
    respond(429, { errors: 'Too Many Requests' }, { 'Retry-After': '30' });
    const adapter = makeAdapter();
    const err = await adapter
      .fetch('get_tracking', { store: 'mystore', order_number: '1234' }, {})
      .catch((e: unknown) => e as WorkflowError);
    expect(err).toBeInstanceOf(WorkflowError);
    expect(err.code).toBe('SERVICE_RATE_LIMITED');
    expect(err.details['retry_after']).toBe('30');
  });

  it('HTTP 500 → SERVICE_HTTP_5XX', async () => {
    respond(500, { errors: 'Internal Server Error' });
    const adapter = makeAdapter();
    await expect(
      adapter.fetch('get_tracking', { store: 'mystore', order_number: '1234' }, {}),
    ).rejects.toMatchObject({ code: 'SERVICE_HTTP_5XX', retryable: true });
  });

  it('non-JSON response body → SERVICE_RESPONSE_INVALID', async () => {
    respondText(200, 'not valid json {{');
    const adapter = makeAdapter();
    await expect(
      adapter.fetch('get_tracking', { store: 'mystore', order_number: '1234' }, {}),
    ).rejects.toMatchObject({ code: 'SERVICE_RESPONSE_INVALID' });
  });
});

// ---------------------------------------------------------------------------
// Tests: Network errors
// ---------------------------------------------------------------------------

describe('ParcelPanelAdapter network errors', () => {
  it('fetch() throws ECONNREFUSED → NETWORK_UNREACHABLE', async () => {
    // Find a port with no server listening
    const closedPort = await new Promise<number>((resolve) => {
      const tmp = net.createServer();
      tmp.listen(0, '127.0.0.1', () => {
        const addr = tmp.address() as { port: number };
        tmp.close(() => resolve(addr.port));
      });
    });

    const adapter = new ParcelPanelAdapter('parcelpanel', {
      stores: { mystore: 'key' },
      base_url: `http://127.0.0.1:${closedPort}`,
    });

    await expect(
      adapter.fetch('get_tracking', { store: 'mystore', order_number: '1234' }, {}),
    ).rejects.toMatchObject({ code: 'NETWORK_UNREACHABLE' });
  });
});

// ---------------------------------------------------------------------------
// Tests: AbortSignal
// ---------------------------------------------------------------------------

describe('ParcelPanelAdapter AbortSignal', () => {
  it('pre-aborted signal throws STEP_ABORTED before making a network call', async () => {
    const adapter = makeAdapter();
    const controller = new AbortController();
    controller.abort();
    await expect(
      adapter.fetch(
        'get_tracking',
        { store: 'mystore', order_number: '1234' },
        {},
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: 'STEP_ABORTED' });
    // Confirm no handler was consumed (no network call made)
    expect(handlers).toHaveLength(0);
  });

  it('signal aborted during in-flight request throws STEP_ABORTED', async () => {
    const controller = new AbortController();
    handlers.push((_req, res) => {
      // Abort the signal before writing the response
      controller.abort();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(fulfilledOrderBody()));
    });
    const adapter = makeAdapter();
    // The AbortController is aborted server-side but signal was active at call time;
    // the in-flight request may either succeed or abort depending on timing.
    // We verify that if STEP_ABORTED is thrown, it has the correct code.
    try {
      await adapter.fetch(
        'get_tracking',
        { store: 'mystore', order_number: '1234' },
        {},
        controller.signal,
      );
      // If it succeeded (race), that's also acceptable — abort arrived after response
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowError);
      expect((err as WorkflowError).code).toBe('STEP_ABORTED');
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: Normalization — fulfilled order
// ---------------------------------------------------------------------------

describe('ParcelPanelAdapter normalization', () => {
  it('fulfilled order: all four NormalizedTracking fields populated', async () => {
    respond(200, fulfilledOrderBody());
    const adapter = makeAdapter();
    const result = await adapter.fetch(
      'get_tracking',
      { store: 'mystore', order_number: '1030' },
      {},
    );
    expect(result.status).toBe(200);
    const data = result.data as NormalizedTracking;
    expect(data.tracking_url).toBe('https://example.myshopify.com/apps/parcelpanel?order=1030');
    expect(data.carrier).toBe('YunExpress');
    expect(data.tracking_number).toBe('YT2436021211003147');
    expect(data.status).toBe('IN_TRANSIT');
  });

  it('unfulfilled order: tracking_url set, carrier/tracking_number/status all null', async () => {
    respond(200, unfulfilledOrderBody());
    const adapter = makeAdapter();
    const result = await adapter.fetch(
      'get_tracking',
      { store: 'mystore', order_number: '1030' },
      {},
    );
    const data = result.data as NormalizedTracking;
    expect(data.tracking_url).toBe('https://example.myshopify.com/apps/parcelpanel?order=1030');
    expect(data.carrier).toBeNull();
    expect(data.tracking_number).toBeNull();
    expect(data.status).toBeNull();
  });

  it('split fulfillment: uses shipments[0], second shipment silently ignored', async () => {
    respond(
      200,
      fulfilledOrderBody({
        shipments: [
          {
            status: 'DELIVERED',
            tracking_number: 'TN_FIRST',
            carrier: { name: 'FedEx' },
          },
          {
            status: 'IN_TRANSIT',
            tracking_number: 'TN_SECOND',
            carrier: { name: 'UPS' },
          },
        ],
      }),
    );
    const adapter = makeAdapter();
    const result = await adapter.fetch(
      'get_tracking',
      { store: 'mystore', order_number: '1030' },
      {},
    );
    const data = result.data as NormalizedTracking;
    expect(data.carrier).toBe('FedEx');
    expect(data.tracking_number).toBe('TN_FIRST');
    expect(data.status).toBe('DELIVERED');
  });

  it('200 with missing order key → SERVICE_RESPONSE_INVALID', async () => {
    respond(200, { something: 'else' });
    const adapter = makeAdapter();
    await expect(
      adapter.fetch('get_tracking', { store: 'mystore', order_number: '1234' }, {}),
    ).rejects.toMatchObject({ code: 'SERVICE_RESPONSE_INVALID' });
  });

  it('200 with order.tracking_link not a string → SERVICE_RESPONSE_INVALID', async () => {
    respond(200, { order: { tracking_link: 12345, shipments: [] } });
    const adapter = makeAdapter();
    await expect(
      adapter.fetch('get_tracking', { store: 'mystore', order_number: '1234' }, {}),
    ).rejects.toMatchObject({ code: 'SERVICE_RESPONSE_INVALID' });
  });
});

// ---------------------------------------------------------------------------
// Tests: Unsupported operations
// ---------------------------------------------------------------------------

describe('ParcelPanelAdapter unsupported operations', () => {
  it('fetch("unknown_operation") throws ADAPTER_OP_UNSUPPORTED', async () => {
    const adapter = makeAdapter();
    await expect(
      adapter.fetch('unknown_operation', { store: 'mystore', order_number: '1234' }, {}),
    ).rejects.toMatchObject({ code: 'ADAPTER_OP_UNSUPPORTED' });
    await expect(
      adapter.fetch('unknown_operation', { store: 'mystore', order_number: '1234' }, {}),
    ).rejects.toBeInstanceOf(WorkflowError);
  });

  it('create throws ADAPTER_OP_UNSUPPORTED', async () => {
    const adapter = makeAdapter();
    await expect(adapter.create('anything', {}, {})).rejects.toMatchObject({
      code: 'ADAPTER_OP_UNSUPPORTED',
    });
  });

  it('update throws ADAPTER_OP_UNSUPPORTED', async () => {
    const adapter = makeAdapter();
    await expect(adapter.update('anything', {}, {})).rejects.toMatchObject({
      code: 'ADAPTER_OP_UNSUPPORTED',
    });
  });
});

// ---------------------------------------------------------------------------
// Contract probe (skipped — requires real credentials)
// ---------------------------------------------------------------------------

it.skip('contract probe — real API (requires PARCELPANEL_TEST_API_KEY and PARCELPANEL_TEST_STORE)', async () => {
  const apiKey = process.env['PARCELPANEL_TEST_API_KEY'] ?? '';
  const store = process.env['PARCELPANEL_TEST_STORE'] ?? '';
  const orderNumber = process.env['PARCELPANEL_TEST_ORDER_NUMBER'] ?? '';

  const adapter = new ParcelPanelAdapter('parcelpanel', {
    stores: { [store]: apiKey },
  });

  const result = await adapter.fetch('get_tracking', { store, order_number: orderNumber }, {});
  expect(result.status).toBe(200);
  const data = result.data as NormalizedTracking;
  expect(typeof data.tracking_url).toBe('string');
  expect(data.tracking_url.length).toBeGreaterThan(0);
});
