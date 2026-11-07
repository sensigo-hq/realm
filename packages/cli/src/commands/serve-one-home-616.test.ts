// serve-one-home-616.test.ts — issue #616 PR-2a, unit (iii), A1: `realm serve` opens realm's home ONCE
// and hands every server it builds the same four stores. It builds one server at startup (the probe,
// never connected) and one per HTTP request. Before this unit it shared only the workflow registry,
// and the library built a fresh run store and trace buffer for every request. The library's factory
// is wrapped to record the options each server is built with (the release-line hosts test's
// passthrough mock is the shape); nothing is injected, and HOME points at a temp folder.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';

const recorded = vi.hoisted(() => ({ options: [] as Array<Record<string, unknown>> }));
vi.mock('@sensigo/realm-mcp', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@sensigo/realm-mcp')>();
  return {
    ...mod,
    createRealmMcpServer: (options: Parameters<typeof mod.createRealmMcpServer>[0]) => {
      recorded.options.push({ ...options });
      return mod.createRealmMcpServer(options);
    },
  };
});

// Imported AFTER the mock so serve.ts binds the recording factory.
import { startHttpMcpServer } from './serve.js';

const STORES = ['workflowStore', 'runStore', 'traceBufferStore', 'failedAttemptStore'] as const;

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

async function toolsList(url: string): Promise<number> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  await res.body?.cancel();
  return res.status;
}

let savedHome: string | undefined;
let home: string | undefined;
afterEach(() => {
  if (savedHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = savedHome;
  if (home !== undefined) rmSync(home, { recursive: true, force: true });
});

describe('#616 PR-2a (iii) A1 — realm serve shares one home across every server it builds', () => {
  it('the startup server and two requests are each handed the same four store objects, on HOME', async () => {
    savedHome = process.env['HOME'];
    home = mkdtempSync(join(tmpdir(), 'realm-serve-one-home-'));
    process.env['HOME'] = home;
    recorded.options.length = 0;
    const server = await startHttpMcpServer({
      port: 0,
      host: '127.0.0.1',
      devMode: true,
      token: undefined,
    });
    let statuses: number[];
    try {
      const { port } = server.address() as { port: number };
      statuses = [
        await toolsList(`http://127.0.0.1:${port}`),
        await toolsList(`http://127.0.0.1:${port}`),
      ];
    } finally {
      await closeServer(server);
    }
    const [startup, ...perRequest] = recorded.options;
    const runStore = startup?.['runStore'] as { runsDirPath?: string } | undefined;
    // (1) red when a server is built with stores of its own — the door opened inside the request
    //     handler, or any of the four left out so the library derives a fresh one per request — or
    //     when the startup stores are not this HOME's;
    // (2) prints, per store, whether every per-request server got the startup server's object, the
    //     servers built, the request statuses, and the startup run store's folder.
    expect({
      statuses,
      servers: recorded.options.length,
      shared: Object.fromEntries(
        STORES.map((s) => [
          s,
          startup?.[s] !== undefined && perRequest.every((o) => o[s] === startup[s]),
        ]),
      ),
      runsDir: runStore?.runsDirPath,
    }).toEqual({
      statuses: [200, 200],
      servers: 3,
      shared: {
        workflowStore: true,
        runStore: true,
        traceBufferStore: true,
        failedAttemptStore: true,
      },
      runsDir: join(home, '.realm', 'runs'),
    });
  }, 30_000);
});

// The words a user reads about it. Executed: this file's A1 cell (`realm serve` hands every server the
// four stores its one door built); `realm mcp` hands the library the door's four (mcp.ts, the same
// door); release-line-hosts.test.ts (a refusal names the command's own packages).
describe('#616 PR-2a (iii) — the docs', () => {
  it('realm-mcp-and-serve.md: the two commands hand the server only stores they build themselves', () => {
    const page = 'docs/reference/cli/realm-mcp-and-serve.md';
    const text = readFileSync(
      fileURLToPath(new URL(`../../../../${page}`, import.meta.url)),
      'utf8',
    ).replace(/\s+/g, ' ');
    const sentence =
      "These two commands hand the server only stores they build themselves, so a release-line refusal there means the command's own packages are at different versions";
    // (1) red when the page no longer holds the sentence word for word (or says again that only the
    //     workflow store is theirs); (2) prints the page and the sentence.
    expect(text, `${page} no longer says: ${sentence}`).toContain(sentence);
  });

  it('the CHANGELOG entry', () => {
    // Executed: "through one place, once per command" — store-door-616.test.ts (no file but the door
    // builds a store) and home.test.ts (every store under the one home);
    // "`realm serve` shares that one home" — this file's A1 cell; "nothing … changes" — the
    // suite as it stood; the exception — foreign-test-clock-715.test.ts's `realm workflow list` cell
    // on a copied test location. #871's form: `[Unreleased]` until a release renames it, then the
    // first section above [0.48.0].
    const text = readFileSync(
      fileURLToPath(new URL('../../../../CHANGELOG.md', import.meta.url)),
      'utf8',
    );
    const start = text.includes('## [Unreleased]')
      ? text.indexOf('## [Unreleased]')
      : text.indexOf('\n## [') + 1;
    const section = text.slice(start, text.indexOf('\n## [0.48.0]')).replace(/\s+/g, ' ');
    const sentence =
      '**Every `realm` command opens its stores through one place, once per command (`run gc` and `run reconcile` keep their own until they leave); `realm serve` shares that one home across every request it serves (issue #616).** Nothing a command prints, creates or refuses changes, with one exception: on a copy of a test location, the commands that only read workflows or replays (`realm workflow list`, `realm workflow register`, `realm workflow watch`, `realm workflow validate --registered`, and `realm run diff` of two replays) now stop with the same clock refusal the run commands always gave there, because every command opens its home through the one door.';
    // (1) red when the [Unreleased] section no longer holds the entry word for word; (2) prints the
    //     sentence.
    expect(section, `the CHANGELOG no longer says: ${sentence}`).toContain(sentence);
  });
});
