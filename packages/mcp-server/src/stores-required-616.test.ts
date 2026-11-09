// stores-required-616.test.ts — issue #616 PR-2a, unit (ii-b): the MCP library has no default store.
// A JavaScript embedder that omitted a store used to get a silent default on the user's real home
// (`~/.realm`); a host that calls a published tool handler directly (bradley-max's reader calls
// `handleGetRunState`) and omits the store it needs would now crash inside the handler. Both are
// refused by name, before anything is opened or read. HOME points at a temp folder in every cell, so a
// default store that survived would create `<HOME>/.realm` and the cell would see it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRealmMcpServer } from './server.js';
import { handleGetRunState } from './tools/get-run-state.js';
import { handleStartRun } from './tools/start-run.js';
import { makeTempHome, type TempHome } from './test-support/temp-home.js';

const REMEDY =
  'The library has no default store, so no server was built and nothing was opened. Pass runStore, workflowStore, traceBufferStore and failedAttemptStore, opened once per process (a test may use InMemoryStore from @sensigo/realm-testing and InMemoryTraceBufferStore from @sensigo/realm for the run and trace stores), or open a Realm home with createRealmMcpServerOnHome from @sensigo/realm-mcp/home.';

let home: string;
let stores: TempHome;
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'realm-stores-616-home-'));
  vi.stubEnv('HOME', home);
  stores = await makeTempHome();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await stores.cleanup();
  rmSync(home, { recursive: true, force: true });
});

/** What a refusal carries, and whether the HOME holds a `.realm` afterwards. */
function refusalOf(build: () => unknown) {
  try {
    build();
    return { refused: false, realmUnderHome: existsSync(join(home, '.realm')) };
  } catch (err) {
    const e = err as {
      code?: string;
      message?: string;
      category?: string;
      agentAction?: string;
      retryable?: boolean;
      details?: unknown;
    };
    return {
      code: e.code,
      message: e.message,
      shape: [e.category, e.agentAction, e.retryable],
      details: e.details,
      realmUnderHome: existsSync(join(home, '.realm')),
    };
  }
}

/** The four stores without the named ones (a JavaScript caller's object). */
function without(...names: string[]): never {
  const given: Record<string, unknown> = { ...stores.stores };
  for (const name of names) delete given[name];
  return given as never;
}

describe('#616 PR-2a (ii-b) — createRealmMcpServer refuses a missing store by name', () => {
  it('one store missing: the one name', () => {
    // (1) red when the factory checks no member for presence (a server is built) or skips the run
    //     store's check, or a default store is built (the HOME then holds a `.realm`);
    // (2) prints the code, the message, the shape, the details and whether the HOME has a `.realm`.
    expect(refusalOf(() => createRealmMcpServer(without('runStore')))).toEqual({
      code: 'VALIDATION_OPTION_INVALID',
      message: `createRealmMcpServer: no runStore was given. ${REMEDY}`,
      shape: ['VALIDATION', 'report_to_user', false],
      details: { missing: ['runStore'] },
      realmUnderHome: false,
    });
  });

  it('two missing: joined with "or", in option order', () => {
    // (1) red when the check skips a member (one name only) or the join changes; (2) as above.
    expect(refusalOf(() => createRealmMcpServer(without('traceBufferStore', 'runStore')))).toEqual({
      code: 'VALIDATION_OPTION_INVALID',
      message: `createRealmMcpServer: no runStore or traceBufferStore was given. ${REMEDY}`,
      shape: ['VALIDATION', 'report_to_user', false],
      details: { missing: ['runStore', 'traceBufferStore'] },
      realmUnderHome: false,
    });
  });

  it('three missing: joined with ", " and "or"', () => {
    // (1) red when the check skips a member or either joiner changes; (2) as above.
    expect(
      refusalOf(() =>
        createRealmMcpServer(without('workflowStore', 'traceBufferStore', 'failedAttemptStore')),
      ),
    ).toEqual({
      code: 'VALIDATION_OPTION_INVALID',
      message: `createRealmMcpServer: no workflowStore, traceBufferStore or failedAttemptStore was given. ${REMEDY}`,
      shape: ['VALIDATION', 'report_to_user', false],
      details: { missing: ['workflowStore', 'traceBufferStore', 'failedAttemptStore'] },
      realmUnderHome: false,
    });
  });

  it('nothing passed: "no options were given", all four in the details', () => {
    // (1) red when an absent options object is read as an object (a crash) or as `{}` (the four
    //     names), or a default store is built; (2) as above.
    expect(refusalOf(() => createRealmMcpServer(undefined as never))).toEqual({
      code: 'VALIDATION_OPTION_INVALID',
      message: `createRealmMcpServer: no options were given. ${REMEDY}`,
      shape: ['VALIDATION', 'report_to_user', false],
      details: { missing: ['runStore', 'workflowStore', 'traceBufferStore', 'failedAttemptStore'] },
      realmUnderHome: false,
    });
  });
});

describe('#616 PR-2a (ii-b) — a tool handler called directly refuses a store it needs by name', () => {
  it('handleGetRunState without its run store: the handler refusal, never a TypeError or the release-line sentence', async () => {
    // (1) red when the shared check has no absence arm (a TypeError from inside the handler, or the
    //     release-line refusal "declares no realm release line" for a store that is not there);
    // (2) prints the code, the message, the shape and the details.
    const got = await handleGetRunState({ run_id: 'r' }, {} as never).then(
      () => ({ refused: false }),
      (e: {
        code?: string;
        message?: string;
        category?: string;
        agentAction?: string;
        retryable?: boolean;
        details?: unknown;
      }) => ({
        code: e.code,
        message: e.message,
        shape: [e.category, e.agentAction, e.retryable],
        details: e.details,
      }),
    );
    expect(got).toEqual({
      code: 'VALIDATION_OPTION_INVALID',
      message:
        'handleGetRunState: no runStore was given. Nothing was read or written. Pass the stores the server passes to this handler — runStore — or call the tool through createRealmMcpServer.',
      shape: ['VALIDATION', 'report_to_user', false],
      details: { missing: ['runStore'] },
    });
  });

  it('no stores object at all: every member the handler needs, named', async () => {
    // (1) red when an absent stores object is skipped (the handler then crashes on it) or names
    //     fewer than its required members; (2) prints the code and the message.
    const got = await handleStartRun({ workflow_id: 'w' }, undefined as never).then(
      () => ({ refused: false }),
      (e: { code?: string; message?: string }) => ({ code: e.code, message: e.message }),
    );
    expect(got).toEqual({
      code: 'VALIDATION_OPTION_INVALID',
      message:
        'handleStartRun: no runStore or workflowStore was given. Nothing was read or written. Pass the stores the server passes to this handler — runStore and workflowStore — or call the tool through createRealmMcpServer.',
    });
  });
});

// The words a user reads about it. Each pin names the cells that execute its claims.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const flat = (t: string): string => t.replace(/\s+/g, ' ');
function claim(page: string, sentence: string): void {
  // (1) red when the page no longer holds the sentence word for word; (2) prints the page and the
  //     sentence.
  expect(
    flat(readFileSync(join(ROOT, page), 'utf8')),
    `${page} no longer says: ${sentence}`,
  ).toContain(flat(sentence));
}

describe('#616 PR-2a (ii-b) — the docs', () => {
  it('core-library.md: no default store, and the refusal it shows is the one the library throws', () => {
    // Executed: this file's four factory cells; the program opens its home (the journeys).
    claim(
      'docs/reference/core-library.md',
      '`createRealmMcpServer` has no default store: pass all four, opened once per process; every other option can be left out. A program that only needs the server on stdio runs `realm-mcp`, which opens `~/.realm` itself.',
    );
    const shown = readFileSync(join(ROOT, 'docs/reference/core-library.md'), 'utf8').match(
      /A JavaScript program that passes no store is refused before anything is opened:\s*```text\n([^\n]*)\n```/,
    )?.[1];
    const thrown = refusalOf(() => createRealmMcpServer(without('runStore'))) as {
      message?: string;
    };
    // (1) red when the page's fenced refusal is not the text the library throws for a missing run
    //     store (either side changed), or the fence moved; (2) prints both.
    expect({ shown }).toEqual({ shown: thrown.message });
  });

  it('core-library.md and the README: a handler called without a store it needs; the four required', () => {
    // Executed: this file's two handler cells; its four factory cells.
    claim(
      'docs/reference/core-library.md',
      'A handler called without a store it needs is refused by name before anything is read.',
    );
    claim(
      'packages/mcp-server/README.md',
      'The library has no default store: a JavaScript caller that omits one of the four is refused by name, before anything is opened.',
    );
    claim(
      'packages/mcp-server/README.md',
      'Type — the four stores, required: `runStore`, `workflowStore`, `traceBufferStore`, `failedAttemptStore`; optional config:',
    );
  });

  it('#616 PR-2c c10b-3a — the texts that teach the home entry', () => {
    // Executed: home-server.test.ts (the entry, its `{ server, close }`, the home it opens);
    // docs-examples-625's `embedded` cell (the README's program, on a fresh HOME).
    claim(
      'packages/mcp-server/README.md',
      "This opens Realm's home (`~/.realm`, or the `home` you pass) and its SQLite store once for this process — the same store every `realm` command uses — and needs Node 22.22.3 or a later 22.x release, or Node 24.15.0 or later. To supply your own stores instead, call `createRealmMcpServer` with the four stores: the library then loads no SQLite and runs on any Node 22.",
    );
    claim(
      'packages/mcp-server/README.md',
      "From `@sensigo/realm-mcp/home`; opens the Realm home's store and returns `{ server, close }`.",
    );
    claim(
      'docs/reference/core-library.md',
      "The JSON file stores (`JsonFileStore`, `JsonWorkflowStore`, `JsonFileFailedAttemptStore`, `JsonTraceBufferStore`) are not how Realm keeps its data: a Realm home's fences refuse them.",
    );
    claim(
      'docs/reference/core-library.md',
      'Runs, workflows, failed attempts, trace entries, replays and dedup marks, in one `realm.db`',
    );
    claim('docs/reference/core-library.md', 'const { runStore: store } = await openRealmHome();');
  });

  it('error-codes.md: the new raisers of VALIDATION_OPTION_INVALID; the CHANGELOG entry', () => {
    // Executed: this file's factory and handler cells (the code and its shape).
    claim(
      'docs/reference/error-codes.md',
      '`reclaimStep` or `getWorkflowForRun`) — or `createRealmMcpServer` and the published tool handlers a store they need — a part that is missing',
    );
    claim(
      'CHANGELOG.md',
      '**BREAKING — `createRealmMcpServer` takes its stores (issue #616).** The library has no default store: pass `runStore`, `workflowStore`, `traceBufferStore` and `failedAttemptStore`, opened once per process; a JavaScript caller that omits one is refused at construction, before anything is opened. The published tool handlers require the stores their server passes them; a direct caller that omits one is refused by name.',
    );
  });
});
