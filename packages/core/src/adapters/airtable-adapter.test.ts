import * as http from 'node:http';
import * as net from 'node:net';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { AirtableAdapter } from './airtable-adapter.js';
import type { AirtableAdapterConfig } from './airtable-adapter.js';
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

const VALID_CONFIG: AirtableAdapterConfig = {
  api_key: 'patXXXXXXXXXXXXXX',
  base_id: 'appXXXXXXXXXXXXXX',
};

function makeAdapter(overrides: Partial<AirtableAdapterConfig> = {}): AirtableAdapter {
  return new AirtableAdapter('airtable', {
    ...VALID_CONFIG,
    base_url: `http://127.0.0.1:${port}`,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const RECORD_FIXTURE = {
  id: 'recXXXXXXXXXXXXXX',
  createdTime: '2024-01-01T00:00:00.000Z',
  fields: { Name: 'Test', Status: 'Open' },
};

const RECORDS_FIXTURE = {
  records: [RECORD_FIXTURE],
};

const RECORDS_WITH_OFFSET_FIXTURE = {
  records: [RECORD_FIXTURE],
  offset: 'nextPageToken123',
};

// ---------------------------------------------------------------------------
// Tests: Constructor validation
// ---------------------------------------------------------------------------

describe('AirtableAdapter construction', () => {
  it('throws for empty api_key', () => {
    expect(() => new AirtableAdapter('id', { api_key: '', base_id: 'appXXXXXXXXXXXXXX' })).toThrow(
      'AirtableAdapter: api_key must not be empty',
    );
  });

  it('throws for base_id not matching /^app[a-zA-Z0-9]{14}$/ (e.g. "invalid")', () => {
    expect(() => new AirtableAdapter('id', { api_key: 'pat123', base_id: 'invalid' })).toThrow(
      'AirtableAdapter: base_id must be a valid Airtable base ID (format: appXXXXXXXXXXXXXX)',
    );
  });

  it('does not throw for a valid base_id matching the pattern', () => {
    expect(
      () => new AirtableAdapter('id', { api_key: 'pat123', base_id: 'appXXXXXXXXXXXXXX' }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Tests: Auth header
// ---------------------------------------------------------------------------

describe('AirtableAdapter auth header', () => {
  it('sends Authorization: Bearer header and no x-parcelpanel-api-key', async () => {
    respond(200, RECORD_FIXTURE);
    const adapter = makeAdapter();
    await adapter.fetch('get_record', { table: 'Tickets', record_id: 'recABC' }, {});
    expect(lastRequestHeaders['authorization']).toBe('Bearer patXXXXXXXXXXXXXX');
    expect(lastRequestHeaders['x-parcelpanel-api-key']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: get_record
// ---------------------------------------------------------------------------

describe('AirtableAdapter get_record', () => {
  it('uses correct URL path: /v0/{base_id}/{table}/{record_id}', async () => {
    let capturedUrl = '';
    handlers.push((req, res) => {
      capturedUrl = req.url ?? '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(RECORD_FIXTURE));
    });
    const adapter = makeAdapter();
    await adapter.fetch('get_record', { table: 'Tickets', record_id: 'recABC' }, {});
    expect(capturedUrl).toBe('/v0/appXXXXXXXXXXXXXX/Tickets/recABC');
  });

  it('returns data with id, createdTime, fields', async () => {
    respond(200, RECORD_FIXTURE);
    const adapter = makeAdapter();
    const result = await adapter.fetch('get_record', { table: 'Tickets', record_id: 'recABC' }, {});
    expect(result.status).toBe(200);
    const data = result.data as typeof RECORD_FIXTURE;
    expect(data.id).toBe('recXXXXXXXXXXXXXX');
    expect(data.createdTime).toBe('2024-01-01T00:00:00.000Z');
    expect(data.fields).toEqual({ Name: 'Test', Status: 'Open' });
  });

  it('throws ADAPTER_VALIDATION_FAILED when table is missing', async () => {
    const adapter = makeAdapter();
    await expect(adapter.fetch('get_record', { record_id: 'recABC' }, {})).rejects.toMatchObject({
      code: 'ADAPTER_VALIDATION_FAILED',
    });
  });

  it('throws ADAPTER_VALIDATION_FAILED when record_id is missing', async () => {
    const adapter = makeAdapter();
    await expect(adapter.fetch('get_record', { table: 'Tickets' }, {})).rejects.toMatchObject({
      code: 'ADAPTER_VALIDATION_FAILED',
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: list_records
// ---------------------------------------------------------------------------

describe('AirtableAdapter list_records', () => {
  it('returns records array and passes offset through when present', async () => {
    respond(200, RECORDS_WITH_OFFSET_FIXTURE);
    const adapter = makeAdapter();
    const result = await adapter.fetch('list_records', { table: 'Tickets' }, {});
    const data = result.data as typeof RECORDS_WITH_OFFSET_FIXTURE;
    expect(Array.isArray(data.records)).toBe(true);
    expect(data.offset).toBe('nextPageToken123');
  });

  it('empty records array is valid — not an error', async () => {
    respond(200, { records: [] });
    const adapter = makeAdapter();
    const result = await adapter.fetch('list_records', { table: 'Tickets' }, {});
    const data = result.data as { records: unknown[] };
    expect(data.records).toHaveLength(0);
  });

  it('filter_by_formula with special chars is URL-encoded in the raw query string', async () => {
    let capturedUrl = '';
    handlers.push((req, res) => {
      capturedUrl = req.url ?? '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(RECORDS_FIXTURE));
    });
    const adapter = makeAdapter();
    await adapter.fetch(
      'list_records',
      { table: 'Tickets', filter_by_formula: '{Ticket ID} = "T-1234"' },
      {},
    );
    expect(capturedUrl).toContain('filterByFormula=');
    expect(capturedUrl).not.toContain('{');
    expect(capturedUrl).not.toContain('}');
  });

  it('fields array produces repeated fields[] params, not comma-joined', async () => {
    let capturedUrl = '';
    handlers.push((req, res) => {
      capturedUrl = req.url ?? '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(RECORDS_FIXTURE));
    });
    const adapter = makeAdapter();
    await adapter.fetch('list_records', { table: 'Tickets', fields: ['Name', 'Status'] }, {});
    const decoded = decodeURIComponent(capturedUrl);
    expect(decoded).toContain('fields[]=Name');
    expect(decoded).toContain('fields[]=Status');
    expect(decoded).not.toMatch(/fields\[\]=Name,Status/);
    expect(decoded).not.toMatch(/fields\[\]=Status,Name/);
  });

  it('offset input param produces offset= in the query string', async () => {
    let capturedUrl = '';
    handlers.push((req, res) => {
      capturedUrl = req.url ?? '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(RECORDS_FIXTURE));
    });
    const adapter = makeAdapter();
    await adapter.fetch('list_records', { table: 'Tickets', offset: 'nextPageToken123' }, {});
    expect(capturedUrl).toContain('offset=nextPageToken123');
  });

  it('max_records param produces maxRecords= in the query string', async () => {
    let capturedUrl = '';
    handlers.push((req, res) => {
      capturedUrl = req.url ?? '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(RECORDS_FIXTURE));
    });
    const adapter = makeAdapter();
    await adapter.fetch('list_records', { table: 'Tickets', max_records: 50 }, {});
    expect(capturedUrl).toContain('maxRecords=50');
  });

  it('throws ADAPTER_VALIDATION_FAILED when table is missing', async () => {
    const adapter = makeAdapter();
    await expect(adapter.fetch('list_records', {}, {})).rejects.toMatchObject({
      code: 'ADAPTER_VALIDATION_FAILED',
    });
  });

  it('sort entries produce indexed sort[i][field] / sort[i][direction] params', async () => {
    let capturedUrl = '';
    handlers.push((req, res) => {
      capturedUrl = req.url ?? '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(RECORDS_FIXTURE));
    });
    const adapter = makeAdapter();
    await adapter.fetch(
      'list_records',
      { table: 'Tickets', sort: [{ field: 'Created', direction: 'desc' }, { field: 'Name' }] },
      {},
    );
    const decoded = decodeURIComponent(capturedUrl);
    expect(decoded).toContain('sort[0][field]=Created');
    expect(decoded).toContain('sort[0][direction]=desc');
    expect(decoded).toContain('sort[1][field]=Name');
    expect(decoded).not.toContain('sort[1][direction]');
  });

  it('malformed sort entries (non-object, missing field) are skipped without error', async () => {
    let capturedUrl = '';
    handlers.push((req, res) => {
      capturedUrl = req.url ?? '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(RECORDS_FIXTURE));
    });
    const adapter = makeAdapter();
    const result = await adapter.fetch(
      'list_records',
      {
        table: 'Tickets',
        sort: ['not-an-object', { direction: 'desc' }, null, { field: 'Name' }],
      },
      {},
    );
    expect(result.status).toBe(200);
    const decoded = decodeURIComponent(capturedUrl);
    expect(decoded).toContain('sort[3][field]=Name');
    expect(decoded).not.toContain('sort[0]');
    expect(decoded).not.toContain('sort[1]');
    expect(decoded).not.toContain('sort[2]');
  });
});

// ---------------------------------------------------------------------------
// Tests: search_records
// ---------------------------------------------------------------------------

describe('AirtableAdapter search_records', () => {
  function captureQuery(): { get: (key: string) => string | null } {
    let capturedUrl = '';
    handlers.push((req, res) => {
      capturedUrl = req.url ?? '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(RECORDS_FIXTURE));
    });
    return {
      get: (key: string) => new URLSearchParams(capturedUrl.split('?')[1] ?? '').get(key),
    };
  }

  it('single field → filterByFormula is FIND("term", {field})', async () => {
    const query = captureQuery();
    const adapter = makeAdapter();
    await adapter.fetch(
      'search_records',
      { table: 'Tickets', search_term: 'x', fields: ['Name'] },
      {},
    );
    expect(query.get('filterByFormula')).toBe('FIND("x", {Name})');
  });

  it('multiple fields → OR(FIND(...),FIND(...))', async () => {
    const query = captureQuery();
    const adapter = makeAdapter();
    await adapter.fetch(
      'search_records',
      { table: 'Tickets', search_term: 'billing', fields: ['Name', 'Notes'] },
      {},
    );
    expect(query.get('filterByFormula')).toBe(
      'OR(FIND("billing", {Name}),FIND("billing", {Notes}))',
    );
  });

  it('term containing " and \\ is escaped in the formula', async () => {
    const query = captureQuery();
    const adapter = makeAdapter();
    await adapter.fetch(
      'search_records',
      { table: 'Tickets', search_term: 'say "hi" \\ bye', fields: ['Name'] },
      {},
    );
    const formula = query.get('filterByFormula') ?? '';
    expect(formula).toBe('FIND("say \\"hi\\" \\\\ bye", {Name})');
    expect(formula).not.toContain('"hi"'); // no raw unescaped quote from the term
  });

  it('missing fields → ADAPTER_VALIDATION_FAILED', async () => {
    const adapter = makeAdapter();
    await expect(
      adapter.fetch('search_records', { table: 'Tickets', search_term: 'x' }, {}),
    ).rejects.toMatchObject({ code: 'ADAPTER_VALIDATION_FAILED' });
    await expect(
      adapter.fetch('search_records', { table: 'Tickets', search_term: 'x', fields: [] }, {}),
    ).rejects.toMatchObject({ code: 'ADAPTER_VALIDATION_FAILED' });
  });

  it('empty search_term → ADAPTER_VALIDATION_FAILED', async () => {
    const adapter = makeAdapter();
    await expect(
      adapter.fetch('search_records', { table: 'Tickets', search_term: '', fields: ['Name'] }, {}),
    ).rejects.toMatchObject({ code: 'ADAPTER_VALIDATION_FAILED' });
  });

  it('view and max_records pass through like list_records', async () => {
    const query = captureQuery();
    const adapter = makeAdapter();
    await adapter.fetch(
      'search_records',
      { table: 'Tickets', search_term: 'x', fields: ['Name'], view: 'Open', max_records: 25 },
      {},
    );
    expect(query.get('view')).toBe('Open');
    expect(query.get('maxRecords')).toBe('25');
  });
});

// ---------------------------------------------------------------------------
// Tests: list_records auto-pagination (fetch_all)
// ---------------------------------------------------------------------------

describe('AirtableAdapter list_records fetch_all', () => {
  function pushPage(records: unknown[], offset?: string, onRequest?: (url: string) => void): void {
    handlers.push((req, res) => {
      onRequest?.(req.url ?? '');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ records, ...(offset !== undefined ? { offset } : {}) }));
    });
  }

  it('2 pages then no offset → records concatenated, truncated: false, offset carried', async () => {
    const urls: string[] = [];
    pushPage([{ id: 'rec1' }], 'cursor-1', (u) => urls.push(u));
    pushPage([{ id: 'rec2' }], undefined, (u) => urls.push(u));

    const adapter = makeAdapter();
    const result = await adapter.fetch('list_records', { table: 'Tickets', fetch_all: true }, {});

    expect(urls).toHaveLength(2);
    expect(decodeURIComponent(urls[1] ?? '')).toContain('offset=cursor-1');
    const data = result.data as { records: unknown[]; truncated: boolean; offset?: string };
    expect(data.records).toEqual([{ id: 'rec1' }, { id: 'rec2' }]);
    expect(data.truncated).toBe(false);
    expect('truncation_reason' in data).toBe(false);
    expect('offset' in data).toBe(false);
  });

  it('max_pages: 2 with 3 pages available → truncated with page_limit and resume offset', async () => {
    pushPage([{ id: 'rec1' }], 'cursor-1');
    pushPage([{ id: 'rec2' }], 'cursor-2');
    pushPage([{ id: 'rec3' }]);

    const adapter = makeAdapter();
    const result = await adapter.fetch(
      'list_records',
      { table: 'Tickets', fetch_all: true, max_pages: 2 },
      {},
    );

    const data = result.data as {
      records: unknown[];
      truncated: boolean;
      truncation_reason?: string;
      offset?: string;
    };
    expect(data.records).toEqual([{ id: 'rec1' }, { id: 'rec2' }]);
    expect(data.truncated).toBe(true);
    expect(data.truncation_reason).toBe('page_limit');
    expect(data.offset).toBe('cursor-2');
    expect(handlers).toHaveLength(1); // third page never requested
  });

  it('tiny max_bytes → stops after first page with byte_limit', async () => {
    pushPage([{ id: 'rec1', Name: 'a record large enough to exceed ten bytes' }], 'cursor-1');
    pushPage([{ id: 'rec2' }]);

    const adapter = makeAdapter();
    const result = await adapter.fetch(
      'list_records',
      { table: 'Tickets', fetch_all: true, max_bytes: 10 },
      {},
    );

    const data = result.data as {
      records: unknown[];
      truncated: boolean;
      truncation_reason?: string;
      offset?: string;
    };
    expect(data.records).toHaveLength(1);
    expect(data.truncated).toBe(true);
    expect(data.truncation_reason).toBe('byte_limit');
    expect(data.offset).toBe('cursor-1');
    expect(handlers).toHaveLength(1); // second page never requested
  });

  it('max_pages: 50 is clamped to 10 (11 pages mocked, 10 requests made)', async () => {
    let requestCount = 0;
    for (let i = 1; i <= 11; i++) {
      pushPage([{ id: `rec${String(i)}` }], i < 11 ? `cursor-${String(i)}` : undefined, () => {
        requestCount += 1;
      });
    }

    const adapter = makeAdapter();
    const result = await adapter.fetch(
      'list_records',
      { table: 'Tickets', fetch_all: true, max_pages: 50 },
      {},
    );

    expect(requestCount).toBe(10);
    const data = result.data as { records: unknown[]; truncated: boolean };
    expect(data.records).toHaveLength(10);
    expect(data.truncated).toBe(true);
  });

  it('without fetch_all → one request, raw response returned unchanged (regression guard)', async () => {
    pushPage([{ id: 'rec1' }], 'cursor-1');
    pushPage([{ id: 'rec2' }]);

    const adapter = makeAdapter();
    const result = await adapter.fetch('list_records', { table: 'Tickets' }, {});

    expect(handlers).toHaveLength(1); // only one request consumed
    const data = result.data as Record<string, unknown>;
    expect(data['records']).toEqual([{ id: 'rec1' }]);
    expect(data['offset']).toBe('cursor-1');
    expect('truncated' in data).toBe(false);
  });

  it('abort between pages → STEP_ABORTED', async () => {
    const controller = new AbortController();
    handlers.push((_req, res) => {
      controller.abort();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ records: [{ id: 'rec1' }], offset: 'cursor-1' }));
    });
    pushPage([{ id: 'rec2' }]);

    const adapter = makeAdapter();
    await expect(
      adapter.fetch('list_records', { table: 'Tickets', fetch_all: true }, {}, controller.signal),
    ).rejects.toMatchObject({ code: 'STEP_ABORTED' });
  });
});

// ---------------------------------------------------------------------------
// Tests: create_record
// ---------------------------------------------------------------------------

describe('AirtableAdapter create_record', () => {
  it('request body contains fields key; response has data.id', async () => {
    handlers.push((_req, res, body) => {
      const parsed = JSON.parse(body) as { fields?: unknown };
      if (parsed.fields === undefined) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'no fields' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(RECORD_FIXTURE));
    });
    const adapter = makeAdapter();
    const result = await adapter.create(
      'create_record',
      { table: 'Tickets', fields: { Name: 'New ticket' } },
      {},
    );
    expect(result.status).toBe(200);
    const data = result.data as typeof RECORD_FIXTURE;
    expect(data.id).toBe('recXXXXXXXXXXXXXX');
  });

  it('with typecast: true — request body contains "typecast": true', async () => {
    respond(200, RECORD_FIXTURE);
    const adapter = makeAdapter();
    await adapter.create(
      'create_record',
      { table: 'Tickets', fields: { Name: 'Test' }, typecast: true },
      {},
    );
    const body = JSON.parse(lastRequestBody) as Record<string, unknown>;
    expect(body['typecast']).toBe(true);
  });

  it('without typecast — request body does NOT contain typecast key', async () => {
    respond(200, RECORD_FIXTURE);
    const adapter = makeAdapter();
    await adapter.create('create_record', { table: 'Tickets', fields: { Name: 'Test' } }, {});
    const body = JSON.parse(lastRequestBody) as Record<string, unknown>;
    expect('typecast' in body).toBe(false);
  });

  it('throws ADAPTER_VALIDATION_FAILED when table is missing', async () => {
    const adapter = makeAdapter();
    await expect(
      adapter.create('create_record', { fields: { Name: 'x' } }, {}),
    ).rejects.toMatchObject({ code: 'ADAPTER_VALIDATION_FAILED' });
  });

  it('throws ADAPTER_VALIDATION_FAILED when fields is missing', async () => {
    const adapter = makeAdapter();
    await expect(adapter.create('create_record', { table: 'Tickets' }, {})).rejects.toMatchObject({
      code: 'ADAPTER_VALIDATION_FAILED',
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: upsert_record
// ---------------------------------------------------------------------------

describe('AirtableAdapter upsert_record', () => {
  const UPSERT_RESPONSE = {
    records: [RECORD_FIXTURE],
    createdRecords: ['recXXXXXXXXXXXXXX'],
    updatedRecords: [],
  };

  it('request body contains records and performUpsert; createdRecords/updatedRecords passed through', async () => {
    respond(200, UPSERT_RESPONSE);
    const adapter = makeAdapter();
    const result = await adapter.update(
      'upsert_record',
      {
        table: 'Tickets',
        fields: { Name: 'New ticket', 'Ticket ID': 'T-100' },
        fields_to_merge_on: ['Ticket ID'],
      },
      {},
    );
    expect(result.status).toBe(200);
    const data = result.data as typeof UPSERT_RESPONSE;
    expect(Array.isArray(data.records)).toBe(true);
    expect(data.createdRecords).toEqual(['recXXXXXXXXXXXXXX']);
    expect(data.updatedRecords).toEqual([]);

    const body = JSON.parse(lastRequestBody) as Record<string, unknown>;
    expect(body['records']).toEqual([{ fields: { Name: 'New ticket', 'Ticket ID': 'T-100' } }]);
    expect(body['performUpsert']).toEqual({ fieldsToMergeOn: ['Ticket ID'] });
  });

  it('with typecast: true — body contains "typecast": true', async () => {
    respond(200, UPSERT_RESPONSE);
    const adapter = makeAdapter();
    await adapter.update(
      'upsert_record',
      { table: 'Tickets', fields: { Name: 'x' }, fields_to_merge_on: ['Name'], typecast: true },
      {},
    );
    const body = JSON.parse(lastRequestBody) as Record<string, unknown>;
    expect(body['typecast']).toBe(true);
  });

  it('without typecast — body does NOT contain typecast key', async () => {
    respond(200, UPSERT_RESPONSE);
    const adapter = makeAdapter();
    await adapter.update(
      'upsert_record',
      { table: 'Tickets', fields: { Name: 'x' }, fields_to_merge_on: ['Name'] },
      {},
    );
    const body = JSON.parse(lastRequestBody) as Record<string, unknown>;
    expect('typecast' in body).toBe(false);
  });

  it('fields_to_merge_on: [] (empty array) → ADAPTER_VALIDATION_FAILED', async () => {
    const adapter = makeAdapter();
    await expect(
      adapter.update(
        'upsert_record',
        { table: 'Tickets', fields: { Name: 'x' }, fields_to_merge_on: [] },
        {},
      ),
    ).rejects.toMatchObject({ code: 'ADAPTER_VALIDATION_FAILED' });
  });

  it('fields_to_merge_on: "ticket_id" (string, not array) → ADAPTER_VALIDATION_FAILED', async () => {
    const adapter = makeAdapter();
    await expect(
      adapter.update(
        'upsert_record',
        { table: 'Tickets', fields: { Name: 'x' }, fields_to_merge_on: 'ticket_id' },
        {},
      ),
    ).rejects.toMatchObject({ code: 'ADAPTER_VALIDATION_FAILED' });
  });

  it('fields_to_merge_on: [123] (non-string element) → ADAPTER_VALIDATION_FAILED', async () => {
    const adapter = makeAdapter();
    await expect(
      adapter.update(
        'upsert_record',
        { table: 'Tickets', fields: { Name: 'x' }, fields_to_merge_on: [123] },
        {},
      ),
    ).rejects.toMatchObject({ code: 'ADAPTER_VALIDATION_FAILED' });
  });
});

// ---------------------------------------------------------------------------
// Tests: update_record
// ---------------------------------------------------------------------------

describe('AirtableAdapter update_record', () => {
  it('PATCH to /v0/{base}/{table}/{id} with body { fields }', async () => {
    let capturedUrl = '';
    let capturedMethod = '';
    handlers.push((req, res) => {
      capturedUrl = req.url ?? '';
      capturedMethod = req.method ?? '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(RECORD_FIXTURE));
    });
    const adapter = makeAdapter();
    const result = await adapter.update(
      'update_record',
      { table: 'Tickets', record_id: 'recABC', fields: { Status: 'Closed' } },
      {},
    );
    expect(capturedUrl).toBe('/v0/appXXXXXXXXXXXXXX/Tickets/recABC');
    expect(capturedMethod).toBe('PATCH');
    expect(JSON.parse(lastRequestBody)).toEqual({ fields: { Status: 'Closed' } });
    expect(result.status).toBe(200);
    const data = result.data as typeof RECORD_FIXTURE;
    expect(data.id).toBe('recXXXXXXXXXXXXXX');
  });

  it('with typecast: true — body contains "typecast": true; without — key absent', async () => {
    respond(200, RECORD_FIXTURE);
    const adapter = makeAdapter();
    await adapter.update(
      'update_record',
      { table: 'Tickets', record_id: 'recABC', fields: { Name: 'x' }, typecast: true },
      {},
    );
    expect((JSON.parse(lastRequestBody) as Record<string, unknown>)['typecast']).toBe(true);

    respond(200, RECORD_FIXTURE);
    await adapter.update(
      'update_record',
      { table: 'Tickets', record_id: 'recABC', fields: { Name: 'x' } },
      {},
    );
    expect('typecast' in (JSON.parse(lastRequestBody) as Record<string, unknown>)).toBe(false);
  });

  it('missing or empty record_id → ADAPTER_VALIDATION_FAILED', async () => {
    const adapter = makeAdapter();
    await expect(
      adapter.update('update_record', { table: 'Tickets', fields: { Name: 'x' } }, {}),
    ).rejects.toMatchObject({ code: 'ADAPTER_VALIDATION_FAILED' });
    await expect(
      adapter.update(
        'update_record',
        { table: 'Tickets', record_id: '', fields: { Name: 'x' } },
        {},
      ),
    ).rejects.toMatchObject({ code: 'ADAPTER_VALIDATION_FAILED' });
  });

  it('response without id → SERVICE_RESPONSE_INVALID', async () => {
    respond(200, { createdTime: '2024-01-01T00:00:00.000Z', fields: {} });
    const adapter = makeAdapter();
    await expect(
      adapter.update(
        'update_record',
        { table: 'Tickets', record_id: 'recABC', fields: { Name: 'x' } },
        {},
      ),
    ).rejects.toMatchObject({ code: 'SERVICE_RESPONSE_INVALID' });
  });
});

// ---------------------------------------------------------------------------
// Tests: HTTP error classification
// ---------------------------------------------------------------------------

describe('AirtableAdapter HTTP error classification', () => {
  it('HTTP 401 → SERVICE_AUTH_FAILED', async () => {
    respond(401, { error: { type: 'AUTHENTICATION_REQUIRED' } });
    const adapter = makeAdapter();
    await expect(
      adapter.fetch('get_record', { table: 'T', record_id: 'recABC' }, {}),
    ).rejects.toMatchObject({ code: 'SERVICE_AUTH_FAILED' });
  });

  it('HTTP 403 → SERVICE_HTTP_4XX', async () => {
    respond(403, { error: { type: 'NOT_AUTHORIZED' } });
    const adapter = makeAdapter();
    await expect(
      adapter.fetch('get_record', { table: 'T', record_id: 'recABC' }, {}),
    ).rejects.toMatchObject({ code: 'SERVICE_HTTP_4XX' });
  });

  it('HTTP 404 → SERVICE_NOT_FOUND', async () => {
    respond(404, { error: { type: 'NOT_FOUND' } });
    const adapter = makeAdapter();
    await expect(
      adapter.fetch('get_record', { table: 'T', record_id: 'recABC' }, {}),
    ).rejects.toMatchObject({ code: 'SERVICE_NOT_FOUND' });
  });

  it('HTTP 422 → SERVICE_HTTP_4XX, details.body present', async () => {
    respond(422, { error: { type: 'INVALID_MULTIPLE_CHOICE_OPTIONS', message: 'Invalid value' } });
    const adapter = makeAdapter();
    const err = await adapter
      .create('create_record', { table: 'T', fields: { Status: 'Bad' } }, {})
      .catch((e: unknown) => e as WorkflowError);
    expect(err).toBeInstanceOf(WorkflowError);
    expect(err.code).toBe('SERVICE_HTTP_4XX');
    expect(err.details['body']).toBeDefined();
    const body = err.details['body'] as { error?: { type?: string } };
    expect(body.error?.type).toBe('INVALID_MULTIPLE_CHOICE_OPTIONS');
  });

  it('HTTP 429 → SERVICE_RATE_LIMITED, wait_and_proceed, no retry_after on error (resolved by callAdapter)', async () => {
    respond(429, { error: { type: 'RATE_LIMIT_REACHED' } });
    const adapter = makeAdapter();
    const err = await adapter
      .fetch('get_record', { table: 'T', record_id: 'recABC' }, {})
      .catch((e: unknown) => e as WorkflowError);
    expect(err).toBeInstanceOf(WorkflowError);
    expect(err.code).toBe('SERVICE_RATE_LIMITED');
    expect(err.agentAction).toBe('wait_and_proceed');
    expect(err.retry_after).toBeUndefined();
    expect(err.details['retry_after']).toBeUndefined();
    expect(adapter.defaultRetryAfterSeconds).toBe(30);
  });

  it('HTTP 500 → SERVICE_HTTP_5XX, retryable: true', async () => {
    respond(500, { error: 'Internal Server Error' });
    const adapter = makeAdapter();
    await expect(
      adapter.fetch('get_record', { table: 'T', record_id: 'recABC' }, {}),
    ).rejects.toMatchObject({ code: 'SERVICE_HTTP_5XX', retryable: true });
  });
});

// ---------------------------------------------------------------------------
// Tests: delete_records
// ---------------------------------------------------------------------------

describe('AirtableAdapter delete_records', () => {
  const DELETE_RESPONSE = {
    records: [
      { id: 'recAAA', deleted: true },
      { id: 'recBBB', deleted: true },
    ],
  };

  it('DELETE with records[] query params; response parsed', async () => {
    let capturedUrl = '';
    let capturedMethod = '';
    handlers.push((req, res) => {
      capturedUrl = req.url ?? '';
      capturedMethod = req.method ?? '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(DELETE_RESPONSE));
    });
    const adapter = makeAdapter();
    const result = await adapter.delete(
      'delete_records',
      { table: 'Tickets', record_ids: ['recAAA', 'recBBB'] },
      {},
    );
    expect(capturedMethod).toBe('DELETE');
    const decoded = decodeURIComponent(capturedUrl);
    expect(decoded).toContain('records[]=recAAA');
    expect(decoded).toContain('records[]=recBBB');
    expect(result.status).toBe(200);
    const data = result.data as typeof DELETE_RESPONSE;
    expect(data.records).toHaveLength(2);
  });

  it('11 ids → ADAPTER_VALIDATION_FAILED mentioning the 10-id limit', async () => {
    const adapter = makeAdapter();
    const ids = Array.from({ length: 11 }, (_, i) => `rec${String(i)}`);
    const err = await adapter
      .delete('delete_records', { table: 'Tickets', record_ids: ids }, {})
      .catch((e: unknown) => e as WorkflowError);
    expect(err).toBeInstanceOf(WorkflowError);
    expect(err.code).toBe('ADAPTER_VALIDATION_FAILED');
    expect(err.message).toContain('at most 10 ids');
  });

  it('empty array → ADAPTER_VALIDATION_FAILED', async () => {
    const adapter = makeAdapter();
    await expect(
      adapter.delete('delete_records', { table: 'Tickets', record_ids: [] }, {}),
    ).rejects.toMatchObject({ code: 'ADAPTER_VALIDATION_FAILED' });
  });

  it('non-array or non-string element → ADAPTER_VALIDATION_FAILED', async () => {
    const adapter = makeAdapter();
    await expect(
      adapter.delete('delete_records', { table: 'Tickets', record_ids: 'recAAA' }, {}),
    ).rejects.toMatchObject({ code: 'ADAPTER_VALIDATION_FAILED' });
    await expect(
      adapter.delete('delete_records', { table: 'Tickets', record_ids: ['recAAA', 42] }, {}),
    ).rejects.toMatchObject({ code: 'ADAPTER_VALIDATION_FAILED' });
  });

  it('response element with deleted: false or missing id → SERVICE_RESPONSE_INVALID', async () => {
    respond(200, { records: [{ id: 'recAAA', deleted: false }] });
    const adapter = makeAdapter();
    await expect(
      adapter.delete('delete_records', { table: 'Tickets', record_ids: ['recAAA'] }, {}),
    ).rejects.toMatchObject({ code: 'SERVICE_RESPONSE_INVALID' });

    respond(200, { records: [{ deleted: true }] });
    await expect(
      adapter.delete('delete_records', { table: 'Tickets', record_ids: ['recAAA'] }, {}),
    ).rejects.toMatchObject({ code: 'SERVICE_RESPONSE_INVALID' });
  });

  it('delete("unknown") → ADAPTER_OP_UNSUPPORTED', async () => {
    const adapter = makeAdapter();
    await expect(
      adapter.delete('unknown', { table: 'Tickets', record_ids: ['recAAA'] }, {}),
    ).rejects.toMatchObject({ code: 'ADAPTER_OP_UNSUPPORTED' });
  });
});

// ---------------------------------------------------------------------------
// Tests: Airtable error body preservation
// ---------------------------------------------------------------------------

describe('AirtableAdapter error body preservation', () => {
  it('400 with error body → message contains Airtable message, details has airtable_error_type', async () => {
    respond(400, {
      error: { type: 'INVALID_REQUEST_UNKNOWN', message: 'Unknown field name: "foo"' },
    });
    const adapter = makeAdapter();
    const err = await adapter
      .fetch('get_record', { table: 'T', record_id: 'recABC' }, {})
      .catch((e: unknown) => e as WorkflowError);
    expect(err).toBeInstanceOf(WorkflowError);
    expect(err.message).toContain('Unknown field name');
    expect(err.details['airtable_error_type']).toBe('INVALID_REQUEST_UNKNOWN');
  });

  it('403 with error body → message contains the Airtable message', async () => {
    respond(403, {
      error: { type: 'NOT_AUTHORIZED', message: 'You are not permitted to perform this operation' },
    });
    const adapter = makeAdapter();
    const err = await adapter
      .fetch('get_record', { table: 'T', record_id: 'recABC' }, {})
      .catch((e: unknown) => e as WorkflowError);
    expect(err.code).toBe('SERVICE_HTTP_4XX');
    expect(err.message).toContain('You are not permitted to perform this operation');
  });

  it('401 with malformed key (no dot) → message contains format hint, key value absent', async () => {
    respond(401, { error: { type: 'AUTHENTICATION_REQUIRED' } });
    const adapter = makeAdapter(); // default key 'patXXXXXXXXXXXXXX' has no dot
    const err = await adapter
      .fetch('get_record', { table: 'T', record_id: 'recABC' }, {})
      .catch((e: unknown) => e as WorkflowError);
    expect(err.code).toBe('SERVICE_AUTH_FAILED');
    expect(err.message).toContain('API key format looks wrong');
    expect(err.message).not.toContain('patXXXXXXXXXXXXXX');
  });

  it('401 with well-formed key (exactly one dot) → no format hint', async () => {
    respond(401, { error: { type: 'AUTHENTICATION_REQUIRED' } });
    const adapter = makeAdapter({ api_key: 'patXXXXXXXXXXXXXX.aaaabbbbcccc' });
    const err = await adapter
      .fetch('get_record', { table: 'T', record_id: 'recABC' }, {})
      .catch((e: unknown) => e as WorkflowError);
    expect(err.code).toBe('SERVICE_AUTH_FAILED');
    expect(err.message).not.toContain('API key format looks wrong');
  });

  it('non-JSON error body → no crash, message has no suffix (regression guard)', async () => {
    respondText(400, 'Bad Request');
    const adapter = makeAdapter();
    const err = await adapter
      .fetch('get_record', { table: 'T', record_id: 'recABC' }, {})
      .catch((e: unknown) => e as WorkflowError);
    expect(err).toBeInstanceOf(WorkflowError);
    expect(err.code).toBe('SERVICE_HTTP_4XX');
    expect(err.message).not.toContain(' — ');
    expect(err.details['airtable_error_type']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: Response validation
// ---------------------------------------------------------------------------

describe('AirtableAdapter response validation', () => {
  it('200 with non-JSON body → SERVICE_RESPONSE_INVALID', async () => {
    respondText(200, 'not valid json {{');
    const adapter = makeAdapter();
    await expect(
      adapter.fetch('get_record', { table: 'T', record_id: 'recABC' }, {}),
    ).rejects.toMatchObject({ code: 'SERVICE_RESPONSE_INVALID' });
  });

  it('get_record response missing id field → SERVICE_RESPONSE_INVALID', async () => {
    respond(200, { createdTime: '2024-01-01T00:00:00.000Z', fields: {} });
    const adapter = makeAdapter();
    await expect(
      adapter.fetch('get_record', { table: 'T', record_id: 'recABC' }, {}),
    ).rejects.toMatchObject({ code: 'SERVICE_RESPONSE_INVALID' });
  });

  it('list_records response missing records field → SERVICE_RESPONSE_INVALID', async () => {
    respond(200, { something: 'else' });
    const adapter = makeAdapter();
    await expect(adapter.fetch('list_records', { table: 'T' }, {})).rejects.toMatchObject({
      code: 'SERVICE_RESPONSE_INVALID',
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: Network errors
// ---------------------------------------------------------------------------

describe('AirtableAdapter network errors', () => {
  it('ECONNREFUSED (closed port) → NETWORK_UNREACHABLE', async () => {
    const closedPort = await new Promise<number>((resolve) => {
      const tmp = net.createServer();
      tmp.listen(0, '127.0.0.1', () => {
        const addr = tmp.address() as { port: number };
        tmp.close(() => resolve(addr.port));
      });
    });

    const adapter = new AirtableAdapter('airtable', {
      api_key: 'patTest',
      base_id: 'appXXXXXXXXXXXXXX',
      base_url: `http://127.0.0.1:${closedPort}`,
    });

    await expect(
      adapter.fetch('get_record', { table: 'T', record_id: 'recABC' }, {}),
    ).rejects.toMatchObject({ code: 'NETWORK_UNREACHABLE' });
  });
});

// ---------------------------------------------------------------------------
// Tests: AbortSignal
// ---------------------------------------------------------------------------

describe('AirtableAdapter AbortSignal', () => {
  it('pre-aborted signal throws STEP_ABORTED, no network call made (handlers still length 1)', async () => {
    respond(200, RECORD_FIXTURE);

    const adapter = makeAdapter();
    const controller = new AbortController();
    controller.abort();

    await expect(
      adapter.fetch('get_record', { table: 'T', record_id: 'recABC' }, {}, controller.signal),
    ).rejects.toMatchObject({ code: 'STEP_ABORTED' });

    expect(handlers).toHaveLength(1);
  });

  it('signal aborted during in-flight request throws STEP_ABORTED (race-tolerant)', async () => {
    const controller = new AbortController();
    handlers.push((_req, res) => {
      controller.abort();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(RECORD_FIXTURE));
    });

    const adapter = makeAdapter();
    try {
      await adapter.fetch('get_record', { table: 'T', record_id: 'recABC' }, {}, controller.signal);
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowError);
      expect((err as WorkflowError).code).toBe('STEP_ABORTED');
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: Unsupported operations
// ---------------------------------------------------------------------------

describe('AirtableAdapter unsupported operations', () => {
  it('fetch("unknown") → ADAPTER_OP_UNSUPPORTED', async () => {
    const adapter = makeAdapter();
    await expect(adapter.fetch('unknown', { table: 'T' }, {})).rejects.toMatchObject({
      code: 'ADAPTER_OP_UNSUPPORTED',
    });
  });

  it('create("unknown") → ADAPTER_OP_UNSUPPORTED', async () => {
    const adapter = makeAdapter();
    await expect(adapter.create('unknown', { table: 'T', fields: {} }, {})).rejects.toMatchObject({
      code: 'ADAPTER_OP_UNSUPPORTED',
    });
  });

  it('update("unknown") → ADAPTER_OP_UNSUPPORTED', async () => {
    const adapter = makeAdapter();
    await expect(
      adapter.update('unknown', { table: 'T', fields: {}, fields_to_merge_on: ['x'] }, {}),
    ).rejects.toMatchObject({ code: 'ADAPTER_OP_UNSUPPORTED' });
  });
});
