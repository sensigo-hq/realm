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
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { REALM_STORE_SCHEMA_VERSION, writeTestClockFile } from '@sensigo/realm';
import { openForeignConnection } from '@sensigo/realm-store-sqlite/test-support';
import { openMcpHome } from './home.js';

const DIST_SERVER = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'bin.js');

let scratch = '';
let home = '';

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'realm-mcp-c6-'));
  const made = join(scratch, 'made-here', '.realm');
  mkdirSync(made, { recursive: true });
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
  it('exits 1 with one realm-mcp line and no start line, no stack, nothing on stdout or in its folder', () => {
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
        refusal: lines,
        stack: /^ {4}at /m.test(r.stderr),
        created: readdirSync(cwd),
      };
      // (1) red when the catch rethrows STATE_HOME_UNUSABLE again (a stack, no refusal line), the start
      //     line moves back before the open (#616 PR-2c c10b-2), or the refusal's words change;
      // (2) prints the exit code, stdout, the start line's presence, the lines after it, and what was
      //     created in the working directory.
      expect(got, JSON.stringify(got, null, 1)).toEqual({
        code: 1,
        stdout: '',
        startLine: false,
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

// #616 PR-2c c10b-2: what the SQLite open can refuse, at the bin. Each is the store's own sentence behind
// the `realm-mcp: ` prefix, one line, exit 1, never a start line, nothing on stdout. Mode bits do not
// bind root.
const NOT_BOUND_BY_MODES = process.getuid?.() === 0;

describe('#616 PR-2c c10b-2 — realm-mcp on the SQLite home', () => {
  const start = (homeDir: string) => {
    const r = spawnSync(process.execPath, [DIST_SERVER], {
      cwd: scratch,
      env: { PATH: process.env['PATH'] ?? '', HOME: homeDir },
      encoding: 'utf8',
      input: '',
      timeout: 20_000,
    });
    const lines = r.stderr.split('\n').filter((l) => l !== '');
    return {
      code: r.status,
      stdout: r.stdout,
      lines: lines.length,
      first: lines[0] ?? '',
      startLine: lines.some((l) => l.startsWith('Gate answers over MCP:')),
      stack: /^ {4}at /m.test(r.stderr),
    };
  };
  /** The parts every refusal shares; `first` is judged by its start. */
  const refused = { code: 1, stdout: '', lines: 1, startLine: false, stack: false };

  it('a home holding the old JSON store: the store’s one line, no start line, and nothing is created', () => {
    const legacy = join(scratch, 'legacy');
    mkdirSync(join(legacy, '.realm', 'runs'), { recursive: true });
    const { first, ...rest } = start(legacy);
    // (1) red when the catch narrows back to two codes (a raw stack) or the start line moves before
    //     the open; (2) prints the exit, the line counts, the first line's start and the home's entries.
    expect({
      ...rest,
      starts: first.startsWith(
        'realm-mcp: This Realm keeps its store in realm.db and does not read the old JSON directories (runs) in ',
      ),
      entries: readdirSync(join(legacy, '.realm')),
    }).toEqual({ ...refused, starts: true, entries: ['runs'] });
  }, 20_000);

  it.skipIf(NOT_BOUND_BY_MODES)(
    'a home the login cannot write: the store’s one line, no start line (skipped as root: mode bits do not bind there)',
    () => {
      const locked = join(scratch, 'locked');
      mkdirSync(join(locked, '.realm'), { recursive: true });
      chmodSync(join(locked, '.realm'), 0o555);
      try {
        const { first, ...rest } = start(locked);
        // (1) red when the catch narrows back to two codes (a raw stack); (2) prints the exit, the line
        //     counts and whether the first line is the store's.
        expect({ ...rest, starts: first.startsWith('realm-mcp: Realm cannot write to ') }).toEqual({
          ...refused,
          starts: true,
        });
      } finally {
        chmodSync(join(locked, '.realm'), 0o755);
      }
    },
    20_000,
  );

  it('a file a newer Realm migrated: the store’s one line, no start line', async () => {
    const newer = join(scratch, 'newer');
    const realmHome = join(newer, '.realm');
    mkdirSync(newer);
    const home = await openMcpHome({ home: realmHome });
    home.close();
    const foreign = await openForeignConnection(realmHome);
    try {
      foreign.exec(`PRAGMA user_version = ${REALM_STORE_SCHEMA_VERSION + 1}`);
    } finally {
      foreign.close();
    }
    const { first, ...rest } = start(newer);
    // (1) red when the catch narrows back to two codes (a raw stack); (2) prints the exit, the line
    //     counts and whether the first line is the store's.
    expect({
      ...rest,
      starts: first.startsWith('realm-mcp: This store was migrated by a newer Realm'),
    }).toEqual({ ...refused, starts: true });
  }, 20_000);

  it('a good fresh home: the start line on stderr, the store made, and exit 0 when stdin closes', () => {
    const fresh = join(scratch, 'fresh');
    mkdirSync(fresh);
    const { first, ...rest } = start(fresh);
    // (1) red when the start line stops printing on a good home, or the store is not opened there; (2)
    //     prints the exit, the line counts and the home's entries.
    expect({
      ...rest,
      firstIsStart: first.startsWith('Gate answers over MCP:'),
      entries: readdirSync(join(fresh, '.realm'))
        .filter((e) => e !== 'realm.db-wal' && e !== 'realm.db-shm')
        .sort(),
    }).toEqual({
      code: 0,
      stdout: '',
      lines: 1,
      startLine: true,
      stack: false,
      firstIsStart: true,
      entries: ['dedup', 'realm.db', 'replays', 'runs', 'workflows'],
    });
  }, 20_000);

  // #616 PR-2c c10b-3b, packaging law (B): the program serves a tool over a home it has just made.
  it('a good fresh home serves get_run_state: an unknown run id is the reply that says so', async () => {
    const fresh = join(scratch, 'fresh-serving');
    mkdirSync(fresh);
    const runId = '00000000-0000-4000-8000-000000000000';
    const client = new Client({ name: 'foreign-test-clock-715', version: '0' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [DIST_SERVER],
        env: { PATH: process.env['PATH'] ?? '', HOME: fresh },
        stderr: 'pipe',
      }),
    );
    const raw = (await client
      .callTool({ name: 'get_run_state', arguments: { run_id: runId } })
      .finally(() => client.close())) as { content: Array<{ text: string }> };
    const reply = JSON.parse(raw.content[0]!.text) as Record<string, unknown>;
    // (1) red when the program stops serving get_run_state over the home it opened (an unknown-tool
    //     error has no such hint); (2) prints the reply's status and hint.
    expect({ status: reply['status'], hint: reply['context_hint'] }).toEqual({
      status: 'error',
      hint: `Run '${runId}' not found.`,
    });
  }, 20_000);
});
