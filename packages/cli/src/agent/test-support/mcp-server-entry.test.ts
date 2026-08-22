// mcp-server-entry.test.ts — the resolver's own cells (issue #398, DQ3 from the harness PR).
import { describe, it, expect } from 'vitest';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import {
  resolveMcpServerEntry,
  DEFAULT_MCP_SERVER_ENTRY,
  MCP_SERVER_DIST_ABSENT,
} from './mcp-server-entry.js';

describe('resolveMcpServerEntry (issue #398)', () => {
  it('throws a message naming the real problem when the dist is absent', () => {
    // The whole reason this function exists: without it the caller gets an ENOENT from `spawn`
    // several layers down, which reads like a broken test rather than a missing build.
    const absent = join(tmpdir(), 'realm-absent-dist', 'server.js');
    expect(() => resolveMcpServerEntry(absent)).toThrow(MCP_SERVER_DIST_ABSENT);
    // The path it looked for is in the message — otherwise a wrong path and an unbuilt dist are
    // indistinguishable to the person reading the failure.
    expect(() => resolveMcpServerEntry(absent)).toThrow(absent);
  });

  it('CONTROL — returns the default entry when it exists', () => {
    // Green only because turbo built mcp-server before this ran, which is the guarantee the
    // message describes.
    expect(resolveMcpServerEntry()).toBe(DEFAULT_MCP_SERVER_ENTRY);
  });

  it('DEPTH PIN — the default path really points at packages/mcp-server/dist/server.js', () => {
    // The off-by-one this catches: four `..` from test-support, three from one level up. Copy the
    // wrong one and the resolver throws "not built" about a path that was never right — a message
    // that sends the reader to rebuild something that is already built. Pinned on the tail rather
    // than the whole path so it holds wherever the repo is checked out.
    expect(
      DEFAULT_MCP_SERVER_ENTRY.endsWith(join('packages', 'mcp-server', 'dist', 'server.js')),
    ).toBe(true);
    expect(
      DEFAULT_MCP_SERVER_ENTRY.startsWith(sep) || /^[A-Za-z]:/.test(DEFAULT_MCP_SERVER_ENTRY),
    ).toBe(true);
  });
});
