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
import { ElicitRequestSchema, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
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

// How long Realm waits for an answer to its form, in seconds (0.50.0 allows 30 to 3600). One value:
// the server's `formWaitSeconds`, and the client's limit for every call the page makes is this plus
// 60 s, so the page never gives up before Realm does, and Realm's reply after its withdrawal still
// arrives. The SDK's own default limit is 60 s per call; left as it is, it would cut a visitor off a
// minute after Send.
export const FORM_WAIT_SECONDS = 3600;
const callLimitMs = (waitSeconds) => (waitSeconds + 60) * 1000;
// The errors the SDK client raises itself, with no reply from Realm: its time limit, a closed connection.
const NO_REPLY = new Set([ErrorCode.RequestTimeout, ErrorCode.ConnectionClosed]);

// A failed-attempt store that writes nothing, with every method of the engine's file store for
// failed attempts (`JsonFileFailedAttemptStore` in the 0.50.0 this demo runs): the engine still
// counts refusals in the run; there is just no .attempts.jsonl sidecar.
const noFailedAttempts = () => ({
  append: async () => {},
  read: async () => ({ records: [], capped: false }),
  deleteAllForRun: async () => ({ bytes_deleted: 0 }),
  statAllForRun: async () => ({ bytes: 0 }),
  listOrphans: async () => [],
});

// The form response the page sends back for a pressed choice.
export const formAnswer = (choice) => ({ action: 'accept', content: { choice } });

// opts.driver exists only so the guard can prove a refused start is caught (N3), and
// opts.formWaitSeconds only so the guard can see Realm withdraw a form in 30 s; the page passes neither.
export async function start(opts = {}) {
  const wait = opts.formWaitSeconds ?? FORM_WAIT_SECONDS;
  const timeout = callLimitMs(wait);
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
    // `gateAnswers` is left at 0.50.0's default, `asked`: Realm sends the gate's question to the
    // app as a form, and the agent has no tool that answers it.
    formWaitSeconds: wait,
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  // The page plays the person's app: it declares form support, so Realm sends its question as a form
  // inside the call that reaches the gate, and that call stays open until the form comes back.
  const client = new Client(
    { name: 'realm-website-demo', version: '1' },
    { capabilities: { elicitation: { form: {} } } },
  );
  // The current form: { status: 'open' | 'answered' | 'withdrawn', message, choices, response }.
  // Each form Realm sends replaces it, with its own settle function.
  let form = null,
    settle = null;
  const listeners = new Set();
  const changed = () => listeners.forEach((f) => f({ ...form }));
  client.setRequestHandler(
    ElicitRequestSchema,
    (req, extra) =>
      new Promise((resolve) => {
        const choices = req.params.requestedSchema?.properties?.choice?.enum ?? [];
        const mine = (form = { status: 'open', message: req.params.message, choices });
        settle = (response) => {
          settle = null;
          resolve(response);
        };
        // Realm withdraws the form when its wait runs out, or when the call holding it is cut.
        extra.signal.addEventListener('abort', () => {
          if (form !== mine || mine.status !== 'open') return;
          settle = null;
          mine.status = 'withdrawn';
          resolve({ action: 'cancel' });
          changed();
        });
        changed();
      }),
  );
  await client.connect(b);
  // The page's answer: settles the open form with the pressed choice. False when no form is open.
  const answer = (choice) => {
    if (!settle || form?.status !== 'open') return false;
    form.status = 'answered';
    form.response = formAnswer(choice);
    settle(form.response);
    changed();
    return true;
  };
  // Returns { kind: 'json' | 'text' | 'thrown', value, isError } — the page classifies, never rewrites.
  // A thrown reply says whether the SDK client raised it itself (`noReply`: its time limit, a closed
  // connection), so Realm sent no reply.
  const call = async (name, args) => {
    let r;
    try {
      r = await client.callTool({ name, arguments: args }, undefined, { timeout });
    } catch (e) {
      return {
        kind: 'thrown',
        value: String(e?.message ?? e),
        isError: true,
        noReply: NO_REPLY.has(e?.code) || typeof e?.code !== 'number',
      };
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
    answer,
    form: () => (form ? { ...form } : null),
    // Called with the form whenever one opens, is answered or is withdrawn; returns the unsubscribe.
    onForm: (f) => (listeners.add(f), () => listeners.delete(f)),
    // What the server announced at connect, and its tool names (the guard reads both).
    capabilities: () => client.getServerCapabilities(),
    tools: async () => (await client.listTools(undefined, { timeout })).tools.map((t) => t.name),
    // The store returns a snapshot, { record, at } (0.50.0); the page reads the record.
    run: async (id) => (await runStore.get(id)).record,
    evidence: async (id) => (await runStore.get(id)).record.evidence,
    close: async () => {
      await client.close();
      await server.close?.();
    },
  };
}
