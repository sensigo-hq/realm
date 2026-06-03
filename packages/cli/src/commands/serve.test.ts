// Tests for realm serve: auth logic and HTTP server behaviour.
import { describe, it, expect, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { JsonWorkflowStore } from '@sensigo/realm';
import { checkBearerToken, startHttpMcpServer } from './serve.js';

// ---------------------------------------------------------------------------
// Pure unit tests for checkBearerToken
// ---------------------------------------------------------------------------

describe('checkBearerToken', () => {
  it('returns false when header is undefined', () => {
    expect(checkBearerToken(undefined, 'secret')).toBe(false);
  });

  it('returns false when header lacks the Bearer scheme', () => {
    expect(checkBearerToken('Basic dXNlcjpwYXNz', 'secret')).toBe(false);
  });

  it('returns false when token is wrong', () => {
    expect(checkBearerToken('Bearer wrong', 'secret')).toBe(false);
  });

  it('returns false when token length differs (prevents padding oracle)', () => {
    expect(checkBearerToken('Bearer sec', 'secret')).toBe(false);
  });

  it('returns true when token matches', () => {
    expect(checkBearerToken('Bearer secret', 'secret')).toBe(true);
  });

  it('is case-sensitive for the token value', () => {
    expect(checkBearerToken('Bearer Secret', 'secret')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Integration tests for the HTTP server
// ---------------------------------------------------------------------------

function makeTempStore(): JsonWorkflowStore {
  const dir = join(tmpdir(), `realm-serve-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return new JsonWorkflowStore(dir);
}

/** Starts the server on a random OS-assigned port and returns it + the base URL. */
async function startTestServer(opts: {
  devMode?: boolean;
  token?: string;
}): Promise<{ server: Server; url: string }> {
  const workflowStore = makeTempStore();
  const server = await startHttpMcpServer({
    port: 0,
    host: '127.0.0.1',
    devMode: opts.devMode ?? false,
    token: opts.token,
    workflowStore,
  });
  const addr = server.address() as { port: number };
  return { server, url: `http://127.0.0.1:${addr.port}` };
}

/** Closes the HTTP server and waits for it to finish. */
function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

/** Sends a minimal MCP JSON-RPC POST and returns the response. */
async function postMcp(url: string, authHeader?: string): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (authHeader !== undefined) headers['Authorization'] = authHeader;
  return fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
}

describe('realm serve — HTTP auth', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      await closeServer(server);
      server = undefined;
    }
  });

  it('returns 401 when no Authorization header is sent', async () => {
    ({ server } = await startTestServer({ token: 'mysecret' }));
    const addr = server.address() as { port: number };
    const res = await postMcp(`http://127.0.0.1:${addr.port}`);
    expect(res.status).toBe(401);
  });

  it('returns 401 with WWW-Authenticate header on failure', async () => {
    ({ server } = await startTestServer({ token: 'mysecret' }));
    const addr = server.address() as { port: number };
    const res = await postMcp(`http://127.0.0.1:${addr.port}`);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
  });

  it('returns 401 for the wrong token', async () => {
    ({ server } = await startTestServer({ token: 'mysecret' }));
    const addr = server.address() as { port: number };
    const res = await postMcp(`http://127.0.0.1:${addr.port}`, 'Bearer wrongtoken');
    expect(res.status).toBe(401);
  });

  it('returns a non-401 response for the correct token', async () => {
    ({ server } = await startTestServer({ token: 'mysecret' }));
    const addr = server.address() as { port: number };
    const res = await postMcp(`http://127.0.0.1:${addr.port}`, 'Bearer mysecret');
    expect(res.status).not.toBe(401);
  });

  it('accepts requests without a token in dev mode', async () => {
    ({ server } = await startTestServer({ devMode: true }));
    const addr = server.address() as { port: number };
    const res = await postMcp(`http://127.0.0.1:${addr.port}`);
    expect(res.status).not.toBe(401);
  });
});

describe('realm serve — HTTP protocol', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      await closeServer(server);
      server = undefined;
    }
  });

  it('returns 400 for non-JSON body with correct token', async () => {
    ({ server } = await startTestServer({ token: 'tok' }));
    const addr = server.address() as { port: number };
    const res = await fetch(`http://127.0.0.1:${addr.port}`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer tok',
        'Content-Type': 'application/json',
      },
      body: 'this is not json{',
    });
    expect(res.status).toBe(400);
  });

  it('tools/list returns a valid MCP response', async () => {
    ({ server } = await startTestServer({ devMode: true }));
    const addr = server.address() as { port: number };
    const res = await postMcp(`http://127.0.0.1:${addr.port}`);
    expect(res.status).toBe(200);
    // StreamableHTTP responds with an SSE stream. Read chunks until we see a
    // data line rather than buffering the full body — the stream may stay open.
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let dataLine: string | undefined;
    for (;;) {
      const { done, value } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: !done });
      dataLine = buffer.split(/\r?\n/).find((line) => line.startsWith('data: '));
      if (dataLine !== undefined || done) break;
    }
    reader.releaseLock();
    expect(dataLine).toBeDefined();
    const parsed = JSON.parse(dataLine!.slice(6)) as Record<string, unknown>;
    const result = parsed['result'] as Record<string, unknown> | undefined;
    expect(Array.isArray(result?.['tools'])).toBe(true);
  });

  it('rejects if the port is already in use (EADDRINUSE)', async () => {
    const first = await startTestServer({ devMode: true });
    const addr = first.server.address() as { port: number };
    try {
      await expect(
        startHttpMcpServer({
          port: addr.port,
          host: '127.0.0.1',
          devMode: true,
          token: undefined,
          workflowStore: makeTempStore(),
        }),
      ).rejects.toThrow();
    } finally {
      await closeServer(first.server);
    }
  });
});
