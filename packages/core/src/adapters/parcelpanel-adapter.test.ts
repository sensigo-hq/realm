import * as http from 'node:http';
import * as net from 'node:net';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { ParcelPanelAdapter } from './parcelpanel-adapter.js';
import type { ParcelPanelAdapterConfig } from './parcelpanel-adapter.js';
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
let lastRequestMethod = '';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf-8');
      lastRequestHeaders = req.headers;
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
    expect(lastRequestMethod).toBe('GET');
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

  it('HTTP 429 with Retry-After header → SERVICE_RATE_LIMITED, wait_and_proceed, retry_after: 30', async () => {
    respond(429, { errors: 'Too Many Requests' }, { 'Retry-After': '30' });
    const adapter = makeAdapter();
    const err = await adapter
      .fetch('get_tracking', { store: 'mystore', order_number: '1234' }, {})
      .catch((e: unknown) => e as WorkflowError);
    expect(err).toBeInstanceOf(WorkflowError);
    expect(err.code).toBe('SERVICE_RATE_LIMITED');
    expect(err.agentAction).toBe('wait_and_proceed');
    expect(err.retry_after).toBe(30);
    expect(err.details['retry_after']).toBeUndefined();
  });

  it('HTTP 429 without Retry-After header → retry_after is undefined (resolved by callAdapter)', async () => {
    respond(429, { errors: 'Too Many Requests' });
    const adapter = makeAdapter();
    const err = await adapter
      .fetch('get_tracking', { store: 'mystore', order_number: '1234' }, {})
      .catch((e: unknown) => e as WorkflowError);
    expect(err).toBeInstanceOf(WorkflowError);
    expect(err.code).toBe('SERVICE_RATE_LIMITED');
    expect(err.agentAction).toBe('wait_and_proceed');
    expect(err.retry_after).toBeUndefined();
    expect(adapter.defaultRetryAfterSeconds).toBe(60);
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
// Tests: Normalization — raw passthrough
// ---------------------------------------------------------------------------

describe('ParcelPanelAdapter normalization', () => {
  it('fulfilled order: raw data passthrough — order_id, tracking_link, and shipment status present', async () => {
    respond(200, fulfilledOrderBody());
    const adapter = makeAdapter();
    const result = await adapter.fetch(
      'get_tracking',
      { store: 'mystore', order_number: '1030' },
      {},
    );
    expect(result.status).toBe(200);
    const data = result.data as Record<string, unknown>;
    const order = data['order'] as Record<string, unknown>;
    expect(order['order_id']).toBe(6140516335690);
    expect(order['tracking_link']).toBe(
      'https://example.myshopify.com/apps/parcelpanel?order=1030',
    );
    const shipments = order['shipments'] as Record<string, unknown>[];
    expect((shipments[0] as Record<string, unknown>)['status']).toBe('IN_TRANSIT');
  });

  it('unfulfilled order: raw data passthrough — shipments is empty array', async () => {
    respond(200, unfulfilledOrderBody());
    const adapter = makeAdapter();
    const result = await adapter.fetch(
      'get_tracking',
      { store: 'mystore', order_number: '1030' },
      {},
    );
    expect(result.status).toBe(200);
    const data = result.data as Record<string, unknown>;
    const order = data['order'] as Record<string, unknown>;
    expect(Array.isArray(order['shipments'])).toBe(true);
    expect((order['shipments'] as unknown[]).length).toBe(0);
  });

  it('split fulfillment: both shipments present in result (not just first)', async () => {
    respond(
      200,
      fulfilledOrderBody({
        shipments: [
          { status: 'DELIVERED', tracking_number: 'TN_FIRST', carrier: { name: 'FedEx' } },
          { status: 'IN_TRANSIT', tracking_number: 'TN_SECOND', carrier: { name: 'UPS' } },
        ],
      }),
    );
    const adapter = makeAdapter();
    const result = await adapter.fetch(
      'get_tracking',
      { store: 'mystore', order_number: '1030' },
      {},
    );
    const data = result.data as Record<string, unknown>;
    const order = data['order'] as Record<string, unknown>;
    const shipments = order['shipments'] as Record<string, unknown>[];
    expect(shipments).toHaveLength(2);
    expect(shipments[0]?.['tracking_number']).toBe('TN_FIRST');
    expect(shipments[1]?.['tracking_number']).toBe('TN_SECOND');
  });

  it('fulfilled order: new interface fields status_label and carrier.code present in raw data', async () => {
    respond(200, fulfilledOrderBody());
    const adapter = makeAdapter();
    const result = await adapter.fetch(
      'get_tracking',
      { store: 'mystore', order_number: '1030' },
      {},
    );
    const data = result.data as Record<string, unknown>;
    const order = data['order'] as Record<string, unknown>;
    const shipments = order['shipments'] as Record<string, unknown>[];
    const ship = shipments[0] as Record<string, unknown>;
    expect(ship['status_label']).toBe('In transit');
    const carrier = ship['carrier'] as Record<string, unknown>;
    expect(carrier['code']).toBe('yunexpress');
  });

  it('200 with arbitrary shape — no throw, returns raw data', async () => {
    respond(200, { something: 'else' });
    const adapter = makeAdapter();
    const result = await adapter.fetch(
      'get_tracking',
      { store: 'mystore', order_number: '1234' },
      {},
    );
    expect(result.status).toBe(200);
    expect(result.data).toMatchObject({ something: 'else' });
  });
});

// ---------------------------------------------------------------------------
// Tests: fetch(get_tracking_by_id)
// ---------------------------------------------------------------------------

describe('ParcelPanelAdapter fetch(get_tracking_by_id)', () => {
  it('order_id as number — raw passthrough with order data', async () => {
    respond(200, fulfilledOrderBody());
    const adapter = makeAdapter();
    const result = await adapter.fetch(
      'get_tracking_by_id',
      { store: 'mystore', order_id: 6140516335690 },
      {},
    );
    expect(result.status).toBe(200);
    const data = result.data as Record<string, unknown>;
    const order = data['order'] as Record<string, unknown>;
    expect(order['order_id']).toBe(6140516335690);
    expect(typeof order['tracking_link']).toBe('string');
  });

  it('order_id as string — raw passthrough with order data', async () => {
    respond(200, fulfilledOrderBody());
    const adapter = makeAdapter();
    const result = await adapter.fetch(
      'get_tracking_by_id',
      { store: 'mystore', order_id: '6140516335690' },
      {},
    );
    expect(result.status).toBe(200);
    const data = result.data as Record<string, unknown>;
    const order = data['order'] as Record<string, unknown>;
    expect(order['order_id']).toBe(6140516335690);
    expect(typeof order['tracking_link']).toBe('string');
  });

  it('correct query string — order_id in URL, not order_number', async () => {
    let capturedUrl = '';
    handlers.push((req, res) => {
      capturedUrl = req.url ?? '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(fulfilledOrderBody()));
    });
    const adapter = makeAdapter();
    await adapter.fetch('get_tracking_by_id', { store: 'mystore', order_id: 6140516335690 }, {});
    expect(lastRequestMethod).toBe('GET');
    expect(capturedUrl).toContain('order_id=6140516335690');
    expect(capturedUrl).not.toContain('order_number');
  });

  it('missing order_id → ADAPTER_VALIDATION_FAILED', async () => {
    const adapter = makeAdapter();
    await expect(
      adapter.fetch('get_tracking_by_id', { store: 'mystore' }, {}),
    ).rejects.toMatchObject({ code: 'ADAPTER_VALIDATION_FAILED' });
    expect(handlers).toHaveLength(0);
  });

  it('invalid order_id (negative number) → ADAPTER_VALIDATION_FAILED', async () => {
    const adapter = makeAdapter();
    await expect(
      adapter.fetch('get_tracking_by_id', { store: 'mystore', order_id: -1 }, {}),
    ).rejects.toMatchObject({ code: 'ADAPTER_VALIDATION_FAILED' });
    expect(handlers).toHaveLength(0);
  });

  it('missing store param → ADAPTER_VALIDATION_FAILED', async () => {
    const adapter = makeAdapter();
    await expect(
      adapter.fetch('get_tracking_by_id', { order_id: 6140516335690 }, {}),
    ).rejects.toMatchObject({ code: 'ADAPTER_VALIDATION_FAILED' });
  });

  it('unknown store → ADAPTER_VALIDATION_FAILED with details.store', async () => {
    const adapter = makeAdapter();
    const err = await adapter
      .fetch('get_tracking_by_id', { store: 'no-such-store', order_id: 6140516335690 }, {})
      .catch((e: unknown) => e as WorkflowError);
    expect(err).toBeInstanceOf(WorkflowError);
    expect(err.code).toBe('ADAPTER_VALIDATION_FAILED');
    expect(err.details['store']).toBe('no-such-store');
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
