// issue #620 PR-C — realm's own hosts fail readably (amendment 11: in-process). `createRealmMcpServer`
// is mocked to throw core's ENGINE_RELEASE_LINE_UNDECLARED (or another refusal the cell picks):
// `realm mcp` prints one line and exits 1; `realm serve` refuses at startup (one line, exit 1, nothing
// listening — round 3, walk R2) and still logs an error that happens while a request is handled. A
// release-line refusal naming createRealmMcpServer is the command's own split install (round 4, walk
// R1): the line says so, from the refusal's details.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import {
  JsonWorkflowStore,
  REALM_BRAND,
  RELEASE_LINE_KEY,
  assertReleaseLine,
  createRealmBrand,
} from '@sensigo/realm';

const REFUSAL = (() => {
  try {
    assertReleaseLine(
      { get: async () => undefined },
      'the run store handed to createRealmMcpServer',
    );
  } catch (err) {
    return err as Error;
  }
  throw new Error('setup: assertReleaseLine accepted a plain object');
})();

/** A workflow store from another release, refused by createRealmMcpServer (MISMATCH). */
const MISMATCH = (() => {
  const store = { get: async () => undefined };
  Object.defineProperty(store, RELEASE_LINE_KEY, {
    value: createRealmBrand('@sensigo/realm', '9.9.9', 'file:///tmp/other-realm/'),
  });
  try {
    assertReleaseLine(store, 'the workflow store handed to createRealmMcpServer');
  } catch (err) {
    return err as Error;
  }
  throw new Error('setup: assertReleaseLine accepted another release');
})();

/** Any other error: the command's line is the one it always printed. */
const OTHER = new Error('the registry provider could not\n  be built');

const V = REALM_BRAND.version;
const LOCAL_PATH = fileURLToPath(REALM_BRAND.url!).replace(/\/$/, '');
const REINSTALL =
  'Reinstall @sensigo/realm-cli so every @sensigo package it installs is one version (npm ls -g @sensigo/realm lists the copies of a global install; npm ls @sensigo/realm in a project).';
/** The whole line for the cell's UNDECLARED refusal (a run store with no line). */
function undeclaredLine(command: string): string {
  return `realm ${command}: this realm command's own packages disagree: its realm-mcp runs @sensigo/realm ${V} (${LOCAL_PATH}) and was handed a run store that carries no realm release mark, so it comes from a copy of @sensigo/realm too old to mark its classes. ${REINSTALL}`;
}
/** The whole line for a workflow store from realm 9.9.9 (MISMATCH). */
function mismatchLine(command: string): string {
  return `realm ${command}: this realm command's own packages disagree: its realm-mcp runs @sensigo/realm ${V} (${LOCAL_PATH}) and was handed a workflow store from @sensigo/realm 9.9.9 (/tmp/other-realm). ${REINSTALL}`;
}

// `always`: every construction refuses. `after-first`: the startup construction succeeds (a stand-in
// server, never connected) and every per-request construction refuses — an error that happens only
// while a request is handled.
const mode = vi.hoisted(() => ({
  value: 'always' as 'always' | 'after-first',
  calls: 0,
  refusal: undefined as Error | undefined,
}));
vi.mock('@sensigo/realm-mcp', () => ({
  createRealmMcpServer: () => {
    mode.calls += 1;
    if (mode.value === 'after-first' && mode.calls === 1) return {};
    throw mode.refusal ?? REFUSAL;
  },
}));

const { mcpCommand } = await import('./mcp.js');
const { startHttpMcpServer, serveCommand } = await import('./serve.js');

afterEach(() => {
  vi.restoreAllMocks();
  mode.value = 'always';
  mode.calls = 0;
  mode.refusal = undefined;
});

/** A port nothing listens on: bound once by the OS, then released. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', () => r()));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((r) => probe.close(() => r()));
  return port;
}

/** Resolves `true` when something answers a TCP connection on the port, `false` on ECONNREFUSED. */
function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port, method: 'GET', path: '/' }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.end();
  });
}

describe('realm’s own hosts with a refusing createRealmMcpServer', () => {
  it('realm mcp: one stderr line `realm mcp: <message>`, exit 1, no stack, nothing on stdout', async () => {
    const errors: unknown[][] = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      errors.push(a);
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    await expect(mcpCommand.parseAsync(['node', 'mcp'])).rejects.toThrow('exit 1');
    expect(exit).toHaveBeenCalledWith(1);
    expect(errors).toEqual([[undeclaredLine('mcp')]]);
    expect(log).not.toHaveBeenCalled();
  });

  for (const [label, refusal, line] of [
    ['MISMATCH', MISMATCH, mismatchLine('mcp')],
    ['UNDECLARED', REFUSAL, undeclaredLine('mcp')],
    [
      'any other error (today’s line, one line)',
      OTHER,
      'realm mcp: the registry provider could not be built',
    ],
  ] as const) {
    it(`realm mcp, ${label}: the whole line`, async () => {
      mode.refusal = refusal;
      const errors: unknown[][] = [];
      vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
        errors.push(a);
      });
      vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
        throw new Error(`exit ${code}`);
      }) as never);
      await expect(mcpCommand.parseAsync(['node', 'mcp'])).rejects.toThrow('exit 1');
      expect(errors).toEqual([[line]]);
    });
  }

  it('startHttpMcpServer: a startup construction refusal rejects and nothing listens', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'realm-serve-host-'));
    const port = await freePort();
    try {
      await expect(
        startHttpMcpServer({
          port,
          host: '127.0.0.1',
          devMode: true,
          token: undefined,
          workflowStore: new JsonWorkflowStore(dir),
        }),
      ).rejects.toBe(REFUSAL);
      expect(mode.calls).toBe(1);
      expect(await listening(port)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('realm serve: one stderr line `realm serve: <message>`, exit 1, no `listening` line', async () => {
    const errors: unknown[][] = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      errors.push(a);
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    const port = await freePort();
    // The command builds its own default workflow store from HOME: a temp folder, never ~/.realm.
    const home = mkdtempSync(join(tmpdir(), 'realm-serve-home-'));
    const savedHome = process.env['HOME'];
    process.env['HOME'] = home;
    try {
      await expect(
        serveCommand.parseAsync(['node', 'serve', '--dev', '--port', String(port)]),
      ).rejects.toThrow('exit 1');
    } finally {
      process.env['HOME'] = savedHome;
      rmSync(home, { recursive: true, force: true });
    }
    expect(exit).toHaveBeenCalledWith(1);
    expect(errors).toEqual([[undeclaredLine('serve')]]);
    expect(log).not.toHaveBeenCalled();
    expect(await listening(port)).toBe(false);
  });

  for (const [label, refusal, line] of [
    ['MISMATCH', MISMATCH, mismatchLine('serve')],
    ['UNDECLARED', REFUSAL, undeclaredLine('serve')],
    [
      'any other error (today’s line, one line)',
      OTHER,
      'realm serve: the registry provider could not be built',
    ],
  ] as const) {
    it(`realm serve, ${label}: the whole line, exit 1`, async () => {
      mode.refusal = refusal;
      const errors: unknown[][] = [];
      vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
        errors.push(a);
      });
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
        throw new Error(`exit ${code}`);
      }) as never);
      const port = await freePort();
      const home = mkdtempSync(join(tmpdir(), 'realm-serve-home-'));
      const savedHome = process.env['HOME'];
      process.env['HOME'] = home;
      try {
        await expect(
          serveCommand.parseAsync(['node', 'serve', '--dev', '--port', String(port)]),
        ).rejects.toThrow('exit 1');
      } finally {
        process.env['HOME'] = savedHome;
        rmSync(home, { recursive: true, force: true });
      }
      expect(exit).toHaveBeenCalledWith(1);
      expect(errors).toEqual([[line]]);
    });
  }

  it('realm serve: a port in use is not a construction refusal — it propagates as before, no `realm serve:` line', async () => {
    mode.value = 'after-first';
    const errors: unknown[][] = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      errors.push(a);
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    const busy = createServer();
    await new Promise<void>((r) => busy.listen(0, '127.0.0.1', () => r()));
    const { port } = busy.address() as AddressInfo;
    const home = mkdtempSync(join(tmpdir(), 'realm-serve-home-'));
    const savedHome = process.env['HOME'];
    process.env['HOME'] = home;
    try {
      await expect(
        serveCommand.parseAsync(['node', 'serve', '--dev', '--port', String(port)]),
      ).rejects.toMatchObject({ code: 'EADDRINUSE' });
    } finally {
      process.env['HOME'] = savedHome;
      rmSync(home, { recursive: true, force: true });
      await new Promise<void>((r) => busy.close(() => r()));
    }
    expect(exit).not.toHaveBeenCalled();
    expect(errors.filter((e) => String(e[0]).startsWith('realm serve:'))).toEqual([]);
  });

  it('realm serve: an error while a request is handled → 500 and one stderr line', async () => {
    mode.value = 'after-first';
    const errors: unknown[][] = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      errors.push(a);
    });
    const dir = mkdtempSync(join(tmpdir(), 'realm-serve-host-'));
    const server = await startHttpMcpServer({
      port: 0,
      host: '127.0.0.1',
      devMode: true,
      token: undefined,
      workflowStore: new JsonWorkflowStore(dir),
    });
    try {
      const { port } = server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      });
      expect(res.status).toBe(500);
      expect(errors).toContainEqual([undeclaredLine('serve')]);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
