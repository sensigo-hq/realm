// Bundle entry for the live demo (#624): the published engine + MCP server, in memory, in the page.
// The workflow is src/live/workflow.yaml (the copy at the pinned tag) and the GitHub stand-in's
// fixture is scripts/replay/github-fixture.json: the recorder's own inputs (one source each).
// Substitutions are only those named in the design's clause 2 (see scripts/live/build.mjs for the
// build-level ones); configuration-level ones live here: InMemoryStore (realm-testing) for runs, a
// hand-made in-memory workflow store holding this one workflow, Realm's own InMemoryTraceBufferStore
// for traces, and a no-op failed-attempt store (no .attempts.jsonl sidecar; refusals are still
// counted in the run).
import * as core from '@sensigo/realm';
import { createRealmMcpServer } from '@sensigo/realm-mcp';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryStore } from '@sensigo/realm-testing';
import WF from './workflow.yaml';
import { log } from './shims/log.mjs';
// The page's decisions, bundled with the engine so the guard tests the bytes the page runs.
export * from './view.mjs';

export const version = core.VERSION;
// N3: the full Attributed shape (by_source + channel are required).
export const DRIVER = { by: 'website demo', by_source: 'stated', channel: 'browser' };

export function diagnostics() {
  return {
    stubCalls: [...log.stubCalls],
    fetches: [...log.fetches],
    unrouted: [...log.unrouted],
    byteLengthCalls: log.byteLengthCalls,
  };
}

// A failed-attempt store that writes nothing, with every method of the engine's FailedAttemptStore:
// the engine still counts refusals in the run; there is just no .attempts.jsonl sidecar.
const noFailedAttempts = () => ({
  append: async () => {},
  read: async () => ({ records: [], capped: false }),
  deleteAllForRun: async () => ({ bytes_deleted: 0 }),
  statAllForRun: async () => ({ bytes: 0 }),
  listOrphans: async () => [],
});

// opts.driver exists only so the guard can prove a refused start is caught (N3); the page never passes it.
export async function start(opts = {}) {
  const def = core.loadWorkflowFromString(WF);
  const decl = (o) => {
    core.declareReleaseLine(o);
    return o;
  };
  const workflowStore = decl({
    get: async () => def,
    getSync: () => def,
    probe: () => ({ kind: 'present' }),
    list: async () => [def],
    register: async () => {},
  });
  // N13: createDefaultRegistry() registers only `filesystem`; the real GitHubAdapter is added here.
  const registry = core.createDefaultRegistry();
  registry.register('adapter', 'github', new core.GitHubAdapter('github', {}));
  const runStore = new InMemoryStore();
  const server = createRealmMcpServer({
    workflowStore,
    registry,
    runStore,
    // Realm's own in-memory trace store; its fences read the run store above.
    traceBufferStore: new core.InMemoryTraceBufferStore(runStore),
    failedAttemptStore: decl(noFailedAttempts()),
    driver: opts.driver ?? DRIVER,
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'realm-website-demo', version: '1' });
  await client.connect(b);
  // Returns { kind: 'json' | 'text' | 'thrown', value, isError } — the page classifies, never rewrites.
  const call = async (name, args) => {
    let r;
    try {
      r = await client.callTool({ name, arguments: args });
    } catch (e) {
      return { kind: 'thrown', value: String(e?.message ?? e), isError: true };
    }
    const txt = r.content?.[0]?.text ?? '';
    try {
      return { kind: 'json', value: JSON.parse(txt), isError: r.isError ?? false };
    } catch {
      return { kind: 'text', value: txt, isError: r.isError ?? false };
    }
  };
  return {
    workflowId: def.id,
    steps: Object.keys(def.steps ?? {}),
    call,
    run: async (id) => runStore.get(id),
    evidence: async (id) => (await runStore.get(id)).evidence,
    close: async () => {
      await client.close();
      await server.close?.();
    },
  };
}
