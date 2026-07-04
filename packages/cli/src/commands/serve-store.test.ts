// H2: `realm serve` constructs ONE JsonWorkflowStore per process (at startup), not one per
// request. JsonWorkflowStore.get() is readFileSync-per-call, so the shared instance is
// staleness-free. This file mocks @sensigo/realm to count constructions on the default path.
import { describe, it, expect, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

const counter = vi.hoisted(() => ({ constructions: 0 }));

vi.mock('@sensigo/realm', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@sensigo/realm')>();
  class CountingJsonWorkflowStore extends mod.JsonWorkflowStore {
    constructor(baseDir?: string) {
      // Default-path constructions in this test must not touch the real ~/.realm/.
      super(baseDir ?? join(tmpdir(), `realm-serve-store-${randomUUID()}`));
      counter.constructions += 1;
    }
  }
  return { ...mod, JsonWorkflowStore: CountingJsonWorkflowStore };
});

// Imported AFTER the mock so serve.ts binds the counting class.
import { startHttpMcpServer } from './serve.js';

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

async function postMcp(url: string): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
}

describe('realm serve — one workflow store per process', () => {
  it('two sequential requests reuse the store constructed at startup (exactly one construction)', async () => {
    const server = await startHttpMcpServer({
      port: 0,
      host: '127.0.0.1',
      devMode: true,
      token: undefined,
      // no workflowStore injected — exercise the default path
    });
    try {
      const startupConstructions = counter.constructions;
      expect(startupConstructions).toBe(1);

      const addr = server.address() as { port: number };
      const first = await postMcp(`http://127.0.0.1:${addr.port}`);
      expect(first.status).toBe(200);
      await first.body?.cancel();
      const second = await postMcp(`http://127.0.0.1:${addr.port}`);
      expect(second.status).toBe(200);
      await second.body?.cancel();

      // No per-request store construction happened.
      expect(counter.constructions).toBe(startupConstructions);
    } finally {
      await closeServer(server);
    }
  });
});
