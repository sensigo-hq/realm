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
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
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

// #616 PR-2a (i): with HOME set but empty, realm-mcp used to keep its registry in a `.realm` folder
// under its working directory; now its first store refuses with STATE_HOME_UNUSABLE, and this catch
// prints that refusal the same way as the clock's.
describe('#616 PR-2a (i) — realm-mcp with an empty HOME', () => {
  it('exits 1 with one realm-mcp line after its start line, no stack, nothing on stdout or in its folder', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'realm-mcp-616-'));
    try {
      const r = spawnSync(process.execPath, [DIST_SERVER], {
        cwd,
        env: { PATH: process.env['PATH'] ?? '', HOME: '' },
        encoding: 'utf8',
        input: '',
        timeout: 20_000,
      });
      const lines = r.stderr.split('\n').filter((l) => l !== '');
      const got = {
        code: r.status,
        stdout: r.stdout,
        startLine: lines[0]?.startsWith('Gate answers over MCP: asked (the default).') ?? false,
        refusal: lines.slice(1),
        stack: /^ {4}at /m.test(r.stderr),
        created: readdirSync(cwd),
      };
      // (1) red when server.ts's catch rethrows STATE_HOME_UNUSABLE again (a stack, no refusal line),
      //     or the refusal's words change;
      // (2) prints the exit code, stdout, the start line's presence, the lines after it, and what was
      //     created in the working directory.
      expect(got, JSON.stringify(got, null, 1)).toEqual({
        code: 1,
        stdout: '',
        startLine: true,
        refusal: [
          'realm-mcp: no home directory: HOME is empty or unset and this account has no home, so realm cannot find ~/.realm. Set HOME to your home directory and run the command again.',
        ],
        stack: false,
        created: [],
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 20_000);
});
