// library-on-node20.mjs — issue #616 PR-2c c10b-3b: what CI's `node20-library` job runs, design-d4's
// packaging law (A): a host that injects its own stores can use `@sensigo/realm-mcp` on a Node that has
// no SQLite at all. It checks three things, in order, and exits 1 at the first that differs:
//   1. this Node cannot load `node:sqlite` (so the leg checks something: on a Node that can, the
//      library could reach SQLite and everything below would still pass);
//   2. the built library loads;
//   3. `createRealmMcpServer` with four injected in-memory stores serves one `list_workflows` call.
// It prints what it saw. Run it on Node 20, after building the library and the testing package:
//   npx turbo run build --filter=@sensigo/realm-mcp --filter=@sensigo/realm-testing
//   node packages/mcp-server/ci/library-on-node20.mjs
// Every package is imported inside a check, so that a failure is this script's own line.

/** Prints what the script saw and the failure, and exits 1. */
function fail(seen, failure) {
  console.log(JSON.stringify(seen, null, 2));
  console.error(`library-on-node20 check FAILED: ${failure}`);
  process.exit(1);
}

const seen = { node: process.version };

// 1. This Node has no SQLite.
try {
  await import('node:sqlite');
  seen.sqlite = 'loaded';
} catch (err) {
  seen.sqlite = err?.code ?? String(err);
}
if (seen.sqlite !== 'ERR_UNKNOWN_BUILTIN_MODULE') {
  fail(
    seen,
    seen.sqlite === 'loaded'
      ? `this Node (${process.version}) can load node:sqlite, so this leg would prove nothing; run it on Node 20`
      : `importing node:sqlite failed with ${seen.sqlite}, not ERR_UNKNOWN_BUILTIN_MODULE`,
  );
}

// 2. The built library loads on it.
let packages;
try {
  packages = {
    mcp: await import('@sensigo/realm-mcp'),
    core: await import('@sensigo/realm'),
    testing: await import('@sensigo/realm-testing'),
  };
  seen.library = 'loaded';
} catch (err) {
  seen.library = `${err?.code ?? 'no code'}: ${err?.message ?? String(err)}`;
  fail(seen, 'the built library did not load on this Node');
}
const { createRealmMcpServer } = packages.mcp;
const { declareReleaseLine, InMemoryTraceBufferStore } = packages.core;
const { InMemoryStore } = packages.testing;

// 3. It serves a tool call with injected stores. The run store and the trace store are the two
// in-memory stores Realm publishes; the registrar and the failed-attempt store are written here.
const definitions = new Map();
const workflowStore = {
  async register(definition) {
    definitions.set(definition.id, definition);
  },
  async get(workflowId) {
    const definition = definitions.get(workflowId);
    if (definition === undefined) throw new Error(`no workflow ${workflowId}`);
    return definition;
  },
  async list() {
    return [...definitions.values()];
  },
};
const attempts = new Map();
const failedAttemptStore = {
  async append(runId, attempt) {
    attempts.set(runId, [...(attempts.get(runId) ?? []), attempt]);
  },
  async read(runId) {
    return attempts.get(runId) ?? [];
  },
  async deleteAllForRun(runId) {
    attempts.delete(runId);
  },
};
declareReleaseLine(workflowStore);
declareReleaseLine(failedAttemptStore);

try {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const runStore = new InMemoryStore();
  const server = createRealmMcpServer({
    runStore,
    workflowStore,
    traceBufferStore: new InMemoryTraceBufferStore(runStore),
    failedAttemptStore,
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'library-on-node20', version: '0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const raw = await client.callTool({ name: 'list_workflows', arguments: {} });
  await client.close();
  seen.listWorkflows = JSON.parse(raw.content[0].text).status;
} catch (err) {
  seen.listWorkflows = `${err?.code ?? 'no code'}: ${err?.message ?? String(err)}`;
}
if (seen.listWorkflows !== 'ok') {
  fail(seen, 'list_workflows over the injected stores did not answer ok');
}

console.log(JSON.stringify(seen, null, 2));
console.log(
  `library-on-node20 check passed: Node ${process.version} has no SQLite, the library loaded, and list_workflows answered ok.`,
);
