import { describe, it, expect, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The compiled entry point — turbo runs test after build, so dist/ exists.
const DIST_SERVER = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'server.js');

const INITIALIZE_REQUEST = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'entry-test', version: '0.0.0' },
  },
});

/**
 * Spawns `node <entryPath>`, sends an initialize request over stdio, and resolves
 * with the first response line. Rejects immediately if the process exits without
 * responding — the silent-exit failure mode this test suite exists to catch.
 */
function initializeVia(entryPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entryPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    let settled = false;
    let stdout = '';
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error('no initialize response within 8s'));
    }, 8000);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      const newline = stdout.indexOf('\n');
      if (newline !== -1 && !settled) {
        settled = true;
        clearTimeout(timer);
        child.kill();
        resolve(stdout.slice(0, newline));
      }
    });
    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`server exited (code ${String(code)}) without responding to initialize`));
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.stdin.write(INITIALIZE_REQUEST + '\n');
  });
}

describe('server entry point', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'realm-mcp-entry-'));
  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('responds to initialize when run directly', async () => {
    const line = await initializeVia(DIST_SERVER);
    const response = JSON.parse(line) as { result?: { serverInfo?: { name?: string } } };
    expect(response.result?.serverInfo?.name).toBe('realm');
  }, 15000);

  it('responds to initialize when invoked through a bin-shim symlink', async () => {
    // npm/npx expose bin entries as symlinks (node_modules/.bin/realm-mcp -> dist/server.js);
    // process.argv[1] is then the symlink path while import.meta.url is the resolved target.
    const shim = join(tempDir, 'realm-mcp');
    symlinkSync(DIST_SERVER, shim);
    const line = await initializeVia(shim);
    const response = JSON.parse(line) as { result?: { serverInfo?: { name?: string } } };
    expect(response.result?.serverInfo?.name).toBe('realm');
  }, 15000);

  it('does not start the stdio server when imported as a module', async () => {
    // Importing under vitest means argv[1] is the test runner, not server.js —
    // the entry guard must stay false and the import must not hijack stdio.
    const mod = await import('./server.js');
    expect(typeof mod.createRealmMcpServer).toBe('function');
  }, 15_000); // heavy dynamic import of the built server — matches its two spawn siblings above
});
