// foreign-test-clock-715.test.ts — #715 (a) correction 1 (C-6): the bare `realm-mcp` bin on a copy of a
// test location. It refuses at startup with one line on stderr, `realm-mcp: <message>`, masked for a
// log like every other line it writes there; nothing on stdout (the MCP stdio rule), no stack trace,
// exit code 1. Before, Node printed a crash dump: the source line, the stack, and an object dump.
//
// The location is made with core's own helper (this package does not depend on the testing package)
// and copied to a scratch HOME. The child runs with PATH and HOME only. The cell names (a) the change
// that turns it red and (b) what it prints: the stderr lines and the exit code, the scratch folder
// written `<dir>`.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeTestClockFile } from '@sensigo/realm';

const DIST_SERVER = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'server.js');

let scratch = '';
let home = '';

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'realm-mcp-c6-'));
  const made = join(scratch, 'made-here', '.realm');
  mkdirSync(join(made, 'runs'), { recursive: true });
  await writeTestClockFile(made, new Date('2033-01-02T03:04:05.000Z'));
  home = join(scratch, 'home');
  cpSync(made, join(home, '.realm'), { recursive: true });
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe('#715 (a) correction 1 (C-6) — realm-mcp on a copied test location', () => {
  it('exits 1 with one realm-mcp line, no stack, nothing on stdout', () => {
    // (a) red when the entry block's catch is dropped (Node's crash dump: a stack, an object dump);
    // (b) prints the stderr lines and the exit code.
    const r = spawnSync(process.execPath, [DIST_SERVER], {
      cwd: scratch,
      env: { PATH: process.env['PATH'] ?? '', HOME: home },
      encoding: 'utf8',
      input: '',
      timeout: 20_000,
    });
    const shown = `rc ${String(r.status)}: ${r.stderr.replaceAll(scratch, '<dir>')}`;
    expect(
      {
        code: r.status,
        stdout: r.stdout,
        line: r.stderr.includes("realm-mcp: This store's clock file was created for"),
        wayOut: r.stderr.includes('delete its clock file'),
        stack: /^ {4}at /m.test(r.stderr),
      },
      shown,
    ).toEqual({ code: 1, stdout: '', line: true, wayOut: true, stack: false });
  }, 20_000);
});
