// #729 PR-3 correction 5 (J-5): the manifest reference recorded at run START. A run created by a
// program that loaded a project is born with that program's identity entry (`origin: 'start'`, the
// manifest reference included), so a run that never executed a step still names its manifest and
// the read commands withhold its values when that manifest is gone (round 5 W1). A start entry with
// no manifest proves none was declared (R41's marker). Built CLI and the MCP door, a fresh HOME, run
// from outside the project. Each cell's break is named beside it (the red-first log runs it).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  JsonWorkflowStore,
  createDefaultRegistry,
  type ExtensionIdentityEntry,
  type LoadBearingRunRecordField,
  type RunRecord,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { InMemoryStore } from '@sensigo/realm-testing';
import { buildRouteTable, makeListenHandler, prepareListenWorkflows } from './listen.js';
import { clearProjectExtensionsCache } from '../extensions/load-project-extensions.js';
import { runAgent } from '../agent/run-agent.js';
import { LlmProvider } from '../agent/providers/llm-provider.js';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';

const CLI_ENTRY = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
/** The manifest's one declared secret: a fake canary. */
const DECLARED = 'FAKE-C5-J5-DECLARED-0001';

let root: string;
let home: string;
let proj: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'realm-c5-j5-'));
  home = join(root, 'home');
  mkdirSync(join(home, '.realm'), { recursive: true });
  proj = join(root, 'proj');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** The built CLI, piped, from `cwd` (default: outside the project). */
function realm(args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) {
  const r = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd: opts.cwd ?? root,
    env: {
      PATH: process.env['PATH'] ?? '',
      HOME: home,
      NO_COLOR: '1',
      REALM_NOT_SECRET: 'HOME',
      ...opts.env,
    },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

/**
 * A project: `package.json` (its root), and — `manifest` — a realm.yaml declaring one secret
 * ({@link DECLARED}); — `code` — an extension module the workflow declares; the workflow (one agent
 * step whose `when` is never true, so no model is ever called; `steps` replaces it) registered from
 * the project folder.
 */
function project(opts: {
  manifest: boolean;
  code?: boolean;
  steps?: string[];
  value?: string;
}): string {
  mkdirSync(join(proj, 'workflows', 'wf'), { recursive: true });
  writeFileSync(join(proj, 'package.json'), JSON.stringify({ type: 'module' }));
  if (opts.manifest) {
    writeFileSync(
      join(proj, 'realm.yaml'),
      'version: 1\nadapters:\n  svc:\n    use: github\n    config: { token: "${secret:SVC_TOKEN}" }\n',
    );
    writeFileSync(join(proj, '.env'), `SVC_TOKEN=${opts.value ?? DECLARED}\n`);
  }
  if (opts.code === true) {
    mkdirSync(join(proj, 'dist'), { recursive: true });
    writeFileSync(
      join(proj, 'dist', 'registry.js'),
      "export default { handlers: { c5h: { id: 'c5h', execute: async () => ({ data: {} }) } } };\n",
    );
  }
  writeFileSync(
    join(proj, 'workflows', 'wf', 'workflow.yaml'),
    [
      'id: c5j5',
      'name: c5j5',
      'version: 1',
      ...(opts.code === true ? ['extensions:', '  - ../../dist/registry.js'] : []),
      'steps:',
      ...(opts.steps ?? [
        '  first:',
        '    description: First',
        '    execution: agent',
        '    depends_on: []',
        '    when: "run.params.go == true"',
      ]),
      '',
    ].join('\n'),
  );
  const reg = realm(['workflow', 'register', 'workflows/wf/workflow.yaml'], { cwd: proj });
  if (reg.status !== 0) throw new Error(`fixture: register failed: ${reg.err}`);
  return 'c5j5';
}

/** Every run record in HOME's store. */
function records(): RunRecord[] {
  const dir = join(home, '.realm', 'runs');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as RunRecord);
}

/** A record's identity entries, as `<origin>:<manifest path, relative to the project, or none>`. */
const entriesOf = (run: RunRecord | undefined): string[] =>
  (run?.extension_identity ?? []).map(
    (e: ExtensionIdentityEntry) =>
      `${e.origin ?? 'execution'}:${e.manifest !== undefined ? e.manifest.path.replace(proj, '<proj>') : 'none'}`,
  );

/** The built `realm mcp`, bare (no --project), from outside the project: `calls` run in order. */
async function door<T>(
  calls: (call: (name: string, args: Record<string, unknown>) => Promise<string>) => Promise<T>,
): Promise<T> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI_ENTRY, 'mcp'],
    env: { PATH: process.env['PATH'] ?? '', HOME: home, REALM_NOT_SECRET: 'HOME' },
    cwd: root,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'c5-j5', version: '0' });
  await client.connect(transport);
  try {
    return await calls(async (name, args) => {
      const raw = (await client.callTool({ name, arguments: args })) as {
        content: Array<{ text: string }>;
      };
      return raw.content[0]!.text;
    });
  } finally {
    await client.close();
  }
}

const runIdOf = (reply: string): string =>
  /"run_id":\s*"([^"]+)"/.exec(reply)?.[1] ?? '<no run_id>';

describe('#729 PR-3 correction 5 (J-5) — each creator writes the start entry with the run', () => {
  // The break for every cell here: `startIdentityEntry` returns `undefined` (→ no entry — red).
  it('`realm agent --workflow` (a project with a manifest)', () => {
    project({ manifest: true });
    realm(['agent', '--workflow', 'workflows/wf/workflow.yaml', '--model', 'anthropic:fake-c5'], {
      cwd: proj,
      env: { ANTHROPIC_API_KEY: 'fake-c5-key' },
    });
    // (b) prints each record's entries (origins and manifest paths).
    expect(records().map(entriesOf)).toEqual([['start:<proj>/realm.yaml']]);
  }, 60_000);

  it("the door's `start_run` and `start_run_batch`", async () => {
    const id = project({ manifest: true });
    await door(async (call) => {
      await call('start_run', { workflow_id: id });
      await call('start_run_batch', { workflow_id: id, items: [{ params: {} }] });
    });
    // (b) prints each record's entries.
    expect(records().map(entriesOf)).toEqual([
      ['start:<proj>/realm.yaml'],
      ['start:<proj>/realm.yaml'],
    ]);
  }, 60_000);

  it('`create_workflow` on a bare `realm mcp`: no project loaded, no entry (S5: never a made-up identity)', async () => {
    const reply = await door((call) =>
      call('create_workflow', { steps: [{ id: 'a', description: 'A.' }] }),
    );
    // (a) red when a creator with no loaded project writes an entry; (b) prints whether a run was
    //     made and its entries.
    expect({ made: runIdOf(reply) !== '<no run_id>', entries: records().map(entriesOf) }).toEqual({
      made: true,
      entries: [[]],
    });
  }, 60_000);
});

describe('#729 PR-3 correction 5 (J-5) — round 5 W1: a run that never executed a step withholds when its manifest is gone', () => {
  it('started on the door, abandoned with a declared value in its reason; realm.yaml removed → every read withholds; restored → hidden as declared', async () => {
    const id = project({ manifest: true });
    const runId = runIdOf(await door((call) => call('start_run', { workflow_id: id })));
    realm(['run', 'abandon', runId, '--reason', `token ${DECLARED}`]);
    const off = join(proj, 'realm.yaml.off');
    renameSync(join(proj, 'realm.yaml'), off);
    const inspected = realm(['run', 'inspect', runId]);
    const again = realm(['run', 'abandon', runId]);
    const attached = realm(['agent', '--run-id', runId, '--model', 'anthropic:fake-c5'], {
      env: { ANTHROPIC_API_KEY: 'fake-c5-key' },
    });
    const state = await door((call) => call('get_run_state', { run_id: runId }));
    renameSync(off, join(proj, 'realm.yaml'));
    const restored = realm(['run', 'inspect', runId]);
    const line = (text: string, start: string): string | undefined =>
      text.split('\n').find((l) => l.startsWith(start));
    const reply = JSON.parse(state) as {
      terminal_reason?: string;
      disclosure?: { values?: string };
    };
    // (a) red when the door writes no start entry (`resolved (no manifest)` everywhere, the
    //     canary in the clear), or a read does not withhold; (b) prints each surface's line that
    //     carries the reason, the receipt's declared part, and booleans — never the canary itself.
    expect({
      inspectCause: line(inspected.out, 'Cause:'),
      inspectReceipt: line(inspected.out, 'Disclosure:')?.split(';')[0],
      againReason: line(again.out, `Run '${runId}'`)?.split('Reason: ')[1],
      againWithheld: again.err.startsWith('Values withheld (declared values changed)'),
      attachedReason: line(attached.err, 'Reason:'),
      doorReason: reply.terminal_reason,
      doorValues: reply.disclosure?.values,
      restoredCause: line(restored.out, 'Cause:'),
      shown:
        [inspected, again, attached, restored].some((r) => `${r.out}${r.err}`.includes(DECLARED)) ||
        state.includes(DECLARED),
    }).toEqual({
      inspectCause: 'Cause: ‹string, 30 characters›',
      inspectReceipt: 'Disclosure: declared values partial (manifest changed)',
      againReason: '‹string, 30 characters›.',
      againWithheld: true,
      attachedReason: 'Reason: ‹string, 30 characters›',
      doorReason: '‹string, 30 characters›',
      doorValues: 'withheld',
      restoredCause: 'Cause: token [REDACTED]',
      shown: false,
    });
  }, 120_000);
});

describe("#729 PR-3 correction 5 (J-5), correction 6 (C6-1) — R41's marker never shows more than correction 4", () => {
  /** The prompt's fake declared value. */
  const CANARY = 'CANARY-declared-4f2a';
  /** `inspect`'s receipt (its declared part), `Cause:` line and whether it withheld. */
  const read = (runId: string) => {
    const out = realm(['run', 'inspect', runId]).out.split('\n');
    return {
      receipt: out.find((l) => l.startsWith('Disclosure:'))?.split(';')[0],
      cause: out.find((l) => l.startsWith('Cause:')),
      withheld: out.some((l) => l.startsWith('Values withheld')),
    };
  };
  /** A realm.yaml (and its .env) declaring `value`, written into the project now. */
  const declareNow = (value: string) => {
    writeFileSync(
      join(proj, 'realm.yaml'),
      'version: 1\nadapters:\n  svc:\n    use: github\n    config: { token: "${secret:SVC_TOKEN}" }\n',
    );
    writeFileSync(join(proj, '.env'), `SVC_TOKEN=${value}\n`);
  };
  /** The run's record rewritten with `entries` (the sanctioned legacy channel). */
  const seedEntries = (runId: string, entries: (list: ExtensionIdentityEntry[]) => unknown[]) => {
    const file = join(home, '.realm', 'runs', `${runId}.json`);
    const run = JSON.parse(readFileSync(file, 'utf8')) as RunRecord;
    writeFileSync(
      file,
      JSON.stringify({ ...run, extension_identity: entries(run.extension_identity ?? []) }),
    );
  };
  /** A start-only run of a project with code and no realm.yaml (the door's `start_run`), abandoned. */
  const startOnly = async (reason: string): Promise<{ runId: string; copy: string }> => {
    const id = project({ manifest: false, code: true });
    const runId = runIdOf(await door((call) => call('start_run', { workflow_id: id })));
    realm(['run', 'abandon', runId, '--reason', reason]);
    return { runId, copy: join(home, '.realm', 'workflows', `${id}.json`) };
  };

  it('C6-1 (1): created with no realm.yaml, one declaring the value added afterwards → hidden by what is declared now (round 6 F1, the executed show, closed)', async () => {
    const { runId } = await startOnly(`token ${CANARY}`);
    declareNow(CANARY);
    const inspected = read(runId);
    const state = await door((call) => call('get_run_state', { run_id: runId }));
    // (a) red when the creation proof answers before the root's manifest is read (the canary
    //     printed, `resolved (no manifest)`); (b) prints the receipt's declared part, the Cause line
    //     (a marker), the door's reason and booleans — never the canary.
    expect({
      ...inspected,
      door: (JSON.parse(state) as { terminal_reason?: string }).terminal_reason,
      shown: JSON.stringify(inspected).includes(CANARY) || state.includes(CANARY),
    }).toEqual({
      receipt: 'Disclosure: declared values resolved',
      cause: 'Cause: token [REDACTED]',
      withheld: false,
      door: 'token [REDACTED]',
      shown: false,
    });
  }, 120_000);

  it('C6-1 (2, control): the manifest there from the start → hidden, as before', async () => {
    const id = project({ manifest: true, value: CANARY });
    const runId = runIdOf(await door((call) => call('start_run', { workflow_id: id })));
    realm(['run', 'abandon', runId, '--reason', `token ${CANARY}`]);
    // (a) red when the run's own manifest no longer hides its value; (b) prints the read.
    expect(read(runId)).toEqual({
      receipt: 'Disclosure: declared values resolved',
      cause: 'Cause: token [REDACTED]',
      withheld: false,
    });
  }, 120_000);

  it('C6-1 (3): no realm.yaml ever, the copy intact → `declared values resolved (no manifest)` (the cause word is all the proof adds; the value shown, as correction 4 showed it)', async () => {
    const { runId } = await startOnly('held for c5');
    // (a) red when the proof is not read where the root holds no realm.yaml (`declared values
    //     resolved` without its cause); (b) prints the read and the record's entries.
    expect({ entries: records().map(entriesOf), read: read(runId) }).toEqual({
      entries: [['start:none']],
      read: {
        receipt: 'Disclosure: declared values resolved (no manifest)',
        cause: 'Cause: held for c5',
        withheld: false,
      },
    });
  }, 120_000);

  it("C6-1 (4, correction 5's damaged-copy arm re-pinned): no realm.yaml, the copy damaged → `unknown (load failed)`, withheld, as correction 4", async () => {
    const { runId, copy } = await startOnly('held for c5');
    writeFileSync(copy, 'not json');
    // (a) red when the proof speaks where nothing can be read now (`resolved (no manifest)`, the
    //     value shown); (b) prints the read (a shape, never the reason).
    expect(read(runId)).toEqual({
      receipt: 'Disclosure: declared values unknown (load failed)',
      cause: 'Cause: ‹string, 11 characters›',
      withheld: true,
    });
  }, 120_000);

  it('C6-1 (5): a start entry that records a capture error adds no cause word; its damaged-copy twin withholds', async () => {
    const { runId, copy } = await startOnly('held for c6');
    seedEntries(runId, (list) => list.map((e) => ({ ...e, error: 'capture failed' })));
    const intact = read(runId);
    writeFileSync(copy, 'not json');
    const damaged = read(runId);
    // (a) red when an error identity is read as the proof (`resolved (no manifest)`); (b) prints both
    //     reads.
    expect({ intact, damaged }).toEqual({
      intact: {
        receipt: 'Disclosure: declared values resolved',
        cause: 'Cause: held for c6',
        withheld: false,
      },
      damaged: {
        receipt: 'Disclosure: declared values unknown (load failed)',
        cause: 'Cause: ‹string, 11 characters›',
        withheld: true,
      },
    });
  }, 120_000);

  it('C6-1 (6): a copy that records no deployment root, a start-only run → `resolved (no manifest)` (the proof names the state; the value shown, as correction 4 and 5 showed it)', async () => {
    const workflows = new JsonWorkflowStore(join(home, '.realm', 'workflows'));
    await workflows.register({
      id: 'c6noroot',
      name: 'c6noroot',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: { first: { description: 'First.', execution: 'agent', depends_on: [] } },
    } as WorkflowDefinition);
    const { JsonFileStore } = await import('@sensigo/realm');
    const runs = new JsonFileStore(join(home, '.realm', 'runs'));
    const { run } = await runs.create({
      workflowId: 'c6noroot',
      workflowVersion: 1,
      params: {},
      extensionIdentity: [
        {
          captured_at: '2026-10-23T00:00:00.000Z',
          modules: [],
          tree: {
            roots: [],
            rules: 'r',
            file_count: 0,
            total_bytes: 0,
            tree_hash: 'x',
            truncated: false,
          },
          coverage: 'dir_tree_v1',
          origin: 'start',
        },
      ],
    });
    realm(['run', 'abandon', run.id, '--reason', 'held for c6']);
    // Correction 4's answer here is `unknown`, `no_manifest`, and — a run with no project — not
    // withheld (02's "withheld" was a hypothesis; MA 1's ruling: the proof makes it `resolved`,
    // `no_manifest`, the value shown in both).
    // (a) red when the proof is ignored in this sub-arm (`declared values unknown (no manifest)`);
    //     (b) prints the read (fake reason text).
    expect(read(run.id)).toEqual({
      receipt: 'Disclosure: declared values resolved (no manifest)',
      cause: 'Cause: held for c6',
      withheld: false,
    });
  }, 120_000);

  it('C6-1 (7, control): the newest entry an execution entry naming no manifest → `declared values resolved`, as before', async () => {
    const { runId } = await startOnly('held for c6');
    seedEntries(runId, (list) => [...list, ...list.map(({ origin: _origin, ...rest }) => rest)]);
    // (a) red when an execution entry is read as the proof (`resolved (no manifest)`); (b) prints the
    //     read.
    expect(read(runId)).toEqual({
      receipt: 'Disclosure: declared values resolved',
      cause: 'Cause: held for c6',
      withheld: false,
    });
  }, 120_000);
});

describe('#729 PR-3 correction 5 (J-5) — the in-process creators', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("`realm listen`: a route's run is born with the project's start entry", async () => {
    clearProjectExtensionsCache();
    const id = project({ manifest: true });
    const registered = await new JsonWorkflowStore(join(home, '.realm', 'workflows')).get(id);
    const definition = {
      ...registered,
      trigger: {
        type: 'webhook',
        path: '/wf',
        auth: { mode: 'shared_secret', header: 'Authorization', secret_from: 'C5_HOOK_TOKEN' },
      },
    } as WorkflowDefinition;
    const logger = { debug() {}, info() {}, warn() {}, error() {} };
    const routes = buildRouteTable([{ definition, workflowDir: join(proj, 'workflows', 'wf') }], {
      env: { C5_HOOK_TOKEN: 'fake-c5-hook-token' },
      logger,
    });
    await prepareListenWorkflows(routes, {
      workflowStore: { register: async () => {} },
      logger,
    } as never);
    const runStore = new InMemoryStore();
    const handler = makeListenHandler(routes, {
      workflowStore: { register: async () => {} },
      runStore,
      dedupStoreFor: () => ({ check: () => false, record: () => {}, cleanup: () => {} }),
      spawnAgent: async () => ({ pid: 4242 }),
      clock: () => 1_700_000_000_000,
      logger,
    } as never);
    const req = new EventEmitter() as unknown as IncomingMessage;
    req.method = 'POST';
    req.url = '/wf';
    req.headers = { 'content-type': 'application/json', authorization: 'fake-c5-hook-token' };
    (req as unknown as { resume: () => IncomingMessage }).resume = () => req;
    setImmediate(() => {
      req.emit('data', Buffer.from('{}'));
      req.emit('end');
    });
    const res = {
      headersSent: false,
      writeHead() {
        return this;
      },
      end() {},
    };
    await handler(req, res as unknown as ServerResponse);
    // (a) red when the route keeps no start entry or the create is given none; (b) prints the
    //     run's entries.
    expect((await runStore.list()).map(entriesOf)).toEqual([['start:<proj>/realm.yaml']]);
  }, 60_000);

  it("a store that does not keep 'extension_identity' is given no start entry, and the run is created", async () => {
    const identity: ExtensionIdentityEntry = {
      captured_at: '2026-10-22T00:00:00.000Z',
      modules: [],
      tree: {
        roots: [],
        rules: 'r',
        file_count: 0,
        total_bytes: 0,
        tree_hash: 'x',
        truncated: false,
      },
      coverage: 'dir_tree_v1',
    };
    const registry = createDefaultRegistry();
    registry.setIdentity(identity);
    // A test store that declares every field but this one (MA 1's ruling: the in-memory store keeps
    // them all, so the cell builds a store that leaves the field out).
    const store = new (class extends InMemoryStore {
      override readonly persistedRunRecordFields: ReadonlySet<LoadBearingRunRecordField> = new Set(
        [...new InMemoryStore().persistedRunRecordFields].filter((f) => f !== 'extension_identity'),
      );
    })();
    const create = vi.spyOn(store, 'create');
    const def = {
      id: 'c5-store',
      name: 'c5-store',
      version: 1,
      steps: {
        first: {
          description: 'First.',
          execution: 'agent',
          depends_on: [],
          when: 'run.params.go == true',
        },
      },
    } as unknown as WorkflowDefinition;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await runAgent(
      {
        store,
        workflowStore: {
          async register() {},
          async get() {
            return def;
          },
          async list() {
            return [def];
          },
        },
        provider: new (class extends LlmProvider {
          async callStep(): Promise<Record<string, unknown>> {
            return {};
          }
        })(),
        registry,
      },
      { definition: def, params: {}, inFlightPollMs: 5, inFlightWatchMs: 20 },
    );
    // (a) red when the creator passes the entry to a store that does not keep it; (b) prints
    //     whether the create was given an entry and how many runs exist.
    expect({
      given: create.mock.calls.some(([options]) => options.extensionIdentity !== undefined),
      runs: (await store.list()).length,
    }).toEqual({ given: false, runs: 1 });
  });
});

describe('#729 PR-3 correction 5 (J-5) — the drift judgement is unchanged by the start entry (`realm run advance`)', () => {
  it('a run created on the door, never executed: advance says `not comparable — the run has recorded no project code yet`, as before the start entry', async () => {
    const id = project({ manifest: true, code: true });
    const runId = runIdOf(await door((call) => call('start_run', { workflow_id: id })));
    const r = realm(['run', 'advance', runId]);
    const line = r.out.split('\n').find((l) => l.startsWith('This program:')) ?? '';
    // (a) red when the fit reads the start entry (`same as the run's last record`); (b) prints the
    //     fit words.
    expect(line.slice(line.indexOf('project code: '))).toBe(
      'project code: not comparable — the run has recorded no project code yet.',
    );
  }, 60_000);
});
