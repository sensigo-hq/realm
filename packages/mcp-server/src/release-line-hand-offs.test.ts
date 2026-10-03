// issue #620 PR-C — H1 (createRealmMcpServer) and the published tool entries.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  JsonFileStore,
  JsonWorkflowStore,
  REALM_BRAND,
  RELEASE_LINE_KEY,
  createRealmBrand,
  declareReleaseLine,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  WorkflowError,
} from '@sensigo/realm';
import { createRealmMcpServer } from './server.js';
import { handleGetRunState } from './tools/get-run-state.js';
import { handleStartRun, registerStartRun } from './tools/start-run.js';
import { handleAbandonRun } from './tools/abandon-run.js';
import { handleListWorkflows } from './tools/list-workflows.js';
import { handleAppendTrace } from './tools/append-trace.js';
import { handleCreateWorkflow } from './tools/create-workflow.js';
import {
  handleExecuteStep,
  handleExecuteStepTool,
  registerExecuteStep,
} from './tools/execute-step.js';
import { handleGetWorkflowProtocol } from './tools/get-workflow-protocol.js';
import { handleStartRunBatch, registerStartRunBatch } from './tools/start-run-batch.js';
import {
  handleSubmitHumanResponse,
  registerSubmitHumanResponse,
} from './tools/submit-human-response.js';
import { JsonTraceBufferStore } from './json-trace-buffer-store.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const OTHER = createRealmBrand('@sensigo/realm', '9.9.9', 'file:///tmp/other-realm/');
const V = REALM_BRAND.version;
const LOCAL_PATH = fileURLToPath(REALM_BRAND.url!).replace(/\/$/, '');
/** The noun a hand-off refusal's remedy takes from its role (issue #620 PR-C round 3). */
function nounOf(role: string): string {
  return /\bregistry\b/.test(role) ? 'registry' : /\breader\b/.test(role) ? 'reader' : 'store';
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'realm-h1-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function plain(): Record<string, unknown> {
  return { get: async () => ({}), list: async () => [] };
}
function other(): Record<string, unknown> {
  const s = plain();
  Object.defineProperty(s, RELEASE_LINE_KEY, { value: OTHER });
  return s;
}
function messageOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (err) {
    return (err as Error).message;
  }
}
function mismatchText(role: string, cls: string): string {
  return `${role} (${cls}) belongs to realm 9.9.9 (/tmp/other-realm); this engine runs realm ${V} (${LOCAL_PATH}). Realm objects do not cross versions. Hand realm a ${nounOf(role)} from @sensigo/realm ${V}, or install every @sensigo package at one version (npm ls @sensigo/realm in the project, or npm ls -g @sensigo/realm for a global install, lists the copies).`;
}
function undeclaredText(role: string): string {
  return `${role} (a plain object) declares no realm release line. Realm identifies store errors by class, so every store it runs against must belong to the realm it runs on (${V}). Declare it once: declareReleaseLine(store), imported from the @sensigo/realm your store imports its errors from.`;
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (err) {
    return (err as { code?: string }).code;
  }
}

describe('H1 createRealmMcpServer', () => {
  for (const [field, role] of [
    ['workflowStore', 'The workflow store handed to createRealmMcpServer'],
    ['runStore', 'The run store handed to createRealmMcpServer'],
    ['traceBufferStore', 'The trace buffer handed to createRealmMcpServer'],
    ['failedAttemptStore', 'The failed-attempt store handed to createRealmMcpServer'],
  ] as const) {
    it(`${field}: the whole messages name this hand-off`, () => {
      expect(messageOf(() => createRealmMcpServer({ [field]: plain() } as never))).toBe(
        undeclaredText(role),
      );
      expect(messageOf(() => createRealmMcpServer({ [field]: other() } as never))).toBe(
        mismatchText(role, 'a plain object'),
      );
    });
  }
  for (const field of ['workflowStore', 'runStore', 'traceBufferStore', 'failedAttemptStore']) {
    it(`${field}: no line → UNDECLARED; another release → MISMATCH`, () => {
      expect(codeOf(() => createRealmMcpServer({ [field]: plain() } as never))).toBe(
        'ENGINE_RELEASE_LINE_UNDECLARED',
      );
      expect(codeOf(() => createRealmMcpServer({ [field]: other() } as never))).toBe(
        'ENGINE_RELEASE_LINE_MISMATCH',
      );
    });
  }
  it('runs before the trace buffer is derived: an undeclared run store is refused, not the runsDirPath error', () => {
    // Today an undeclared non-JsonFileStore run store reaches the runsDirPath derivation and throws
    // ENGINE_INTERNAL; the hand-off check refuses it first.
    expect(codeOf(() => createRealmMcpServer({ runStore: plain() } as never))).toBe(
      'ENGINE_RELEASE_LINE_UNDECLARED',
    );
  });
  it('a static registry of another release: refused at construction, the whole message names createRealmMcpServer', () => {
    const reg = {};
    Object.defineProperty(reg, Symbol.for('@sensigo/realm/ExtensionRegistry'), { value: OTHER });
    expect(codeOf(() => createRealmMcpServer({ registry: reg } as never))).toBe(
      'ENGINE_RELEASE_LINE_MISMATCH',
    );
    expect(messageOf(() => createRealmMcpServer({ registry: reg } as never))).toBe(
      mismatchText('The registry handed to createRealmMcpServer', 'class ExtensionRegistry'),
    );
  });
  it('a registryProvider is not called at construction; its other-release result is refused per call', async () => {
    const reg = {};
    Object.defineProperty(reg, Symbol.for('@sensigo/realm/ExtensionRegistry'), { value: OTHER });
    let calls = 0;
    const registryProvider = async (): Promise<never> => {
      calls += 1;
      return reg as never;
    };
    expect(() => createRealmMcpServer({ registryProvider })).not.toThrow();
    expect(calls).toBe(0);
    const runStore = new JsonFileStore(dir);
    const workflowStore = new JsonWorkflowStore(join(dir, 'wf'));
    await workflowStore.register({
      id: 'w',
      name: 'w',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: { a: { description: 'a', execution: 'agent', depends_on: [] } },
    } as never);
    await expect(
      handleStartRun({ workflow_id: 'w' }, { runStore, workflowStore, registryProvider } as never),
    ).rejects.toMatchObject({
      code: 'ENGINE_RELEASE_LINE_MISMATCH',
      message: mismatchText('The registry handed to handleStartRun', 'class ExtensionRegistry'),
    });
  });
  it('a plain-object or unmarked registry is accepted at construction (registries are refused only on proof)', () => {
    class ExtensionRegistry {}
    expect(() => createRealmMcpServer({ registry: {} } as never)).not.toThrow();
    expect(() =>
      createRealmMcpServer({ registry: new ExtensionRegistry() } as never),
    ).not.toThrow();
  });
  it('realm’s own stores and a declared host class are accepted', () => {
    class TenantScopedRunStore {}
    declareReleaseLine(TenantScopedRunStore);
    const host = Object.assign(new TenantScopedRunStore(), plain());
    expect(() =>
      createRealmMcpServer({
        runStore: new JsonFileStore(dir),
        workflowStore: new JsonWorkflowStore(join(dir, 'wf')),
      }),
    ).not.toThrow();
    expect(codeOf(() => createRealmMcpServer({ runStore: host } as never))).toBe(
      'ENGINE_INTERNAL', // got past the check; the runsDirPath derivation refuses a non-JsonFileStore
    );
  });
});

describe('a registry the server’s registry provider returned is named by the tool (round 4, walk Y6)', () => {
  it('over MCP, the four tools that resolve a registry: each reply names its tool and the provider, never the handler', async () => {
    const reg = {};
    Object.defineProperty(reg, Symbol.for('@sensigo/realm/ExtensionRegistry'), { value: OTHER });
    const runStore = new JsonFileStore(dir);
    const workflowStore = new JsonWorkflowStore(join(dir, 'wf'));
    await workflowStore.register({
      id: 'w',
      name: 'w',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: { a: { description: 'a', execution: 'agent', depends_on: [] } },
    } as never);
    // A run made without the provider, for the two tools that act on one.
    const started = (await handleStartRun({ workflow_id: 'w' }, {
      runStore,
      workflowStore,
    } as never)) as { run_id: string };
    const server = createRealmMcpServer({
      runStore,
      workflowStore,
      registryProvider: async () => reg as never,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'release-line-test-client', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const call = async (name: string, args: Record<string, unknown>) => {
      const raw = await client.callTool({ name, arguments: args });
      return JSON.parse((raw as { content: Array<{ text: string }> }).content[0]!.text) as Record<
        string,
        unknown
      >;
    };
    try {
      for (const [tool, args] of [
        ['start_run', { workflow_id: 'w' }],
        ['start_run_batch', { workflow_id: 'w', items: [{ params: {} }] }],
        ['execute_step', { run_id: started.run_id, command: 'a', params: {} }],
        ['submit_human_response', { run_id: started.run_id, gate_id: 'g', choice: 'x' }],
      ] as const) {
        const role = `the registry the server's registry provider returned for ${tool}`;
        const reply = await call(tool, args);
        expect(reply['status'], tool).toBe('error');
        expect(reply['error_code'], tool).toBe('ENGINE_RELEASE_LINE_MISMATCH');
        expect(reply['errors'], tool).toEqual([
          mismatchText(`The ${role.slice('the '.length)}`, 'class ExtensionRegistry'),
        ]);
        expect((reply['error_details'] as Record<string, unknown>)['role'], tool).toBe(role);
      }
      expect((await runStore.listRunIds()).size).toBe(1);
    } finally {
      await client.close();
    }
  });
  it('each published registerX alone on a server of the host’s: its tool’s reply names the tool and the provider', async () => {
    const reg = {};
    Object.defineProperty(reg, Symbol.for('@sensigo/realm/ExtensionRegistry'), { value: OTHER });
    const runStore = new JsonFileStore(dir);
    const workflowStore = new JsonWorkflowStore(join(dir, 'wf'));
    await workflowStore.register({
      id: 'w',
      name: 'w',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: { a: { description: 'a', execution: 'agent', depends_on: [] } },
    } as never);
    const started = (await handleStartRun({ workflow_id: 'w' }, {
      runStore,
      workflowStore,
    } as never)) as { run_id: string };
    for (const [tool, register, args] of [
      ['start_run', registerStartRun, { workflow_id: 'w' }],
      ['start_run_batch', registerStartRunBatch, { workflow_id: 'w', items: [{ params: {} }] }],
      ['execute_step', registerExecuteStep, { run_id: started.run_id, command: 'a', params: {} }],
      [
        'submit_human_response',
        registerSubmitHumanResponse,
        { run_id: started.run_id, gate_id: 'g', choice: 'x' },
      ],
    ] as const) {
      // A fresh stores object per tool, registered with that tool alone: its own mark names it.
      const server = new McpServer({ name: 'host', version: '0.0.0' });
      register(server, { runStore, workflowStore, registryProvider: async () => reg as never });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'release-line-test-client', version: '0.0.0' });
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      try {
        const raw = await client.callTool({ name: tool, arguments: args });
        const reply = JSON.parse(
          (raw as { content: Array<{ text: string }> }).content[0]!.text,
        ) as Record<string, unknown>;
        expect((reply['error_details'] as Record<string, unknown>)['role'], tool).toBe(
          `the registry the server's registry provider returned for ${tool}`,
        );
      } finally {
        await client.close();
      }
    }
  });
  it('a provider handed to a published handler directly keeps the handler’s name', async () => {
    const reg = {};
    Object.defineProperty(reg, Symbol.for('@sensigo/realm/ExtensionRegistry'), { value: OTHER });
    const runStore = new JsonFileStore(dir);
    const workflowStore = new JsonWorkflowStore(join(dir, 'wf'));
    await workflowStore.register({
      id: 'w',
      name: 'w',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: { a: { description: 'a', execution: 'agent', depends_on: [] } },
    } as never);
    const stores = { runStore, workflowStore, registryProvider: async () => reg as never };
    await expect(handleStartRun({ workflow_id: 'w' }, stores as never)).rejects.toMatchObject({
      code: 'ENGINE_RELEASE_LINE_MISMATCH',
      message: mismatchText('The registry handed to handleStartRun', 'class ExtensionRegistry'),
    });
  });
});

describe('H3 JsonTraceBufferStore', () => {
  it('refuses a run reader with no line or another release’s, the whole messages', () => {
    const role = 'The run reader handed to JsonTraceBufferStore';
    expect(messageOf(() => new JsonTraceBufferStore(join(dir, 't'), plain() as never))).toBe(
      undeclaredText(role),
    );
    expect(messageOf(() => new JsonTraceBufferStore(join(dir, 't'), other() as never))).toBe(
      mismatchText(role, 'a plain object'),
    );
  });
});

describe('the registry rule at the four handlers that resolve a registry, the whole messages', () => {
  it('handleStartRun, handleStartRunBatch, handleExecuteStep, handleSubmitHumanResponse', async () => {
    const runStore = new JsonFileStore(dir);
    const workflowStore = new JsonWorkflowStore(join(dir, 'wf'));
    await workflowStore.register({
      id: 'w',
      name: 'w',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: { a: { description: 'a', execution: 'agent', depends_on: [] } },
    } as never);
    const started = (await handleStartRun({ workflow_id: 'w' }, {
      runStore,
      workflowStore,
    } as never)) as { run_id: string };
    const reg = {};
    Object.defineProperty(reg, Symbol.for('@sensigo/realm/ExtensionRegistry'), { value: OTHER });
    const stores = { runStore, workflowStore, registry: reg } as never;
    const refusal = async (p: Promise<unknown>): Promise<string> => {
      try {
        await p;
        return 'resolved';
      } catch (err) {
        return (err as Error).message;
      }
    };
    expect(await refusal(handleStartRun({ workflow_id: 'w' }, stores))).toBe(
      mismatchText('The registry handed to handleStartRun', 'class ExtensionRegistry'),
    );
    expect(
      await refusal(handleStartRunBatch({ workflow_id: 'w', items: [{ params: {} }] }, stores)),
    ).toBe(mismatchText('The registry handed to handleStartRunBatch', 'class ExtensionRegistry'));
    expect(
      await refusal(
        handleExecuteStep({ run_id: started.run_id, command: 'a', params: {} } as never, stores),
      ),
    ).toBe(mismatchText('The registry handed to handleExecuteStep', 'class ExtensionRegistry'));
    expect(
      await refusal(
        handleSubmitHumanResponse({ run_id: started.run_id, gate_id: 'g', choice: 'x' }, stores),
      ),
    ).toBe(
      mismatchText('The registry handed to handleSubmitHumanResponse', 'class ExtensionRegistry'),
    );
    expect((await runStore.listRunIds()).size).toBe(1);
  });
});

describe('tool entries (called directly, without the server)', () => {
  it('handleGetRunState: an undeclared workflow store is refused at entry', async () => {
    await expect(
      handleGetRunState({ run_id: 'r' }, {
        runStore: new JsonFileStore(dir),
        workflowStore: plain(),
      } as never),
    ).rejects.toMatchObject({ code: 'ENGINE_RELEASE_LINE_UNDECLARED' });
  });
  it('handleAbandonRun: another release’s run store is refused at entry', async () => {
    await expect(
      handleAbandonRun({ run_id: 'r' } as never, { runStore: other() } as never),
    ).rejects.toMatchObject({
      code: 'ENGINE_RELEASE_LINE_MISMATCH',
    });
  });
  it('handleListWorkflows: an undeclared workflow store is refused at entry', async () => {
    await expect(handleListWorkflows({ workflowStore: plain() } as never)).rejects.toMatchObject({
      code: 'ENGINE_RELEASE_LINE_UNDECLARED',
    });
  });
  it('handleStartRun: another release’s registry is refused before any run is created', async () => {
    const runStore = new JsonFileStore(dir);
    const workflowStore = new JsonWorkflowStore(join(dir, 'wf'));
    await workflowStore.register({
      id: 'w',
      name: 'w',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: { a: { description: 'a', execution: 'agent', depends_on: [] } },
    } as never);
    const reg = {};
    Object.defineProperty(reg, Symbol.for('@sensigo/realm/ExtensionRegistry'), { value: OTHER });
    for (const stores of [
      { runStore, workflowStore, registry: reg },
      { runStore, workflowStore, registryProvider: async () => reg },
    ]) {
      await expect(handleStartRun({ workflow_id: 'w' }, stores as never)).rejects.toMatchObject({
        code: 'ENGINE_RELEASE_LINE_MISMATCH',
      });
    }
    expect((await runStore.listRunIds()).size).toBe(0);
  });
});

// The full tool-entry matrix: every published handler × every store field × (another release, no
// line), and a host class declared with declareReleaseLine passing the check.

type Call = (stores: Record<string, unknown>) => Promise<unknown>;
const HANDLERS: Array<[string, Call]> = [
  ['handleAbandonRun', (s) => handleAbandonRun({ run_id: 'r' } as never, s as never)],
  [
    'handleAppendTrace',
    (s) => handleAppendTrace({ run_id: 'r', step_id: 'a', entries: [] } as never, s as never),
  ],
  ['handleCreateWorkflow', (s) => handleCreateWorkflow({} as never, s as never)],
  ['handleExecuteStep', (s) => handleExecuteStep({ run_id: 'r', command: 'a' }, s as never)],
  [
    'handleExecuteStepTool',
    (s) => handleExecuteStepTool({ run_id: 'r', command: 'a' }, s as never),
  ],
  ['handleGetRunState', (s) => handleGetRunState({ run_id: 'r' }, s as never)],
  [
    'handleGetWorkflowProtocol',
    (s) => handleGetWorkflowProtocol({ workflow_id: 'w' } as never, s as never),
  ],
  ['handleListWorkflows', (s) => handleListWorkflows(s as never)],
  [
    'handleStartRunBatch',
    (s) => handleStartRunBatch({ workflow_id: 'w', items: [] } as never, s as never),
  ],
  ['handleStartRun', (s) => handleStartRun({ workflow_id: 'w' }, s as never)],
  [
    'handleSubmitHumanResponse',
    (s) =>
      handleSubmitHumanResponse({ run_id: 'r', gate_id: 'g', choice: 'x' } as never, s as never),
  ],
];
const FIELDS: Array<[string, string]> = [
  ['workflowStore', 'the workflow store'],
  ['runStore', 'the run store'],
  ['traceBufferStore', 'the trace buffer'],
  ['failedAttemptStore', 'the failed-attempt store'],
];

async function refusal(
  call: Call,
  stores: Record<string, unknown>,
): Promise<{ code?: string | undefined; message: string } | undefined> {
  try {
    await call(stores);
    return undefined;
  } catch (err) {
    return { code: (err as { code?: string }).code, message: (err as Error).message };
  }
}

describe.each(HANDLERS)('%s', (name, call) => {
  it.each(FIELDS)(
    '%s from another release → MISMATCH naming the handler, before any work',
    async (field, store) => {
      const r = await refusal(call, { [field]: other() });
      expect(r?.code).toBe('ENGINE_RELEASE_LINE_MISMATCH');
      expect(
        r?.message.startsWith(
          `${store[0]!.toUpperCase()}${store.slice(1)} handed to ${name} (a plain object) belongs to realm 9.9.9`,
        ),
      ).toBe(true);
    },
  );
  it.each(FIELDS)(
    '%s with no line → UNDECLARED naming the handler, before any work',
    async (field, store) => {
      const r = await refusal(call, { [field]: plain() });
      expect(r?.code).toBe('ENGINE_RELEASE_LINE_UNDECLARED');
      expect(
        r?.message.startsWith(
          `${store[0]!.toUpperCase()}${store.slice(1)} handed to ${name} (a plain object) declares no realm release line.`,
        ),
      ).toBe(true);
    },
  );
  it('a host class declared with declareReleaseLine passes the check', async () => {
    class HostStore {}
    declareReleaseLine(HostStore);
    const host = Object.assign(new HostStore(), plain());
    const r = await refusal(call, { runStore: host, workflowStore: host });
    expect(r?.code ?? 'resolved').not.toMatch(/^ENGINE_RELEASE_LINE_/);
  });
});

describe('get_run_state: both catches around getWorkflowForRun rethrow a release-line refusal (M6c)', () => {
  function refusingWorkflowStore(): Record<string, unknown> {
    const s = {
      get: async () => {
        throw new WorkflowError('the store refused', {
          code: 'ENGINE_RELEASE_LINE_MISMATCH',
          category: 'ENGINE',
          agentAction: 'stop',
          retryable: false,
        });
      },
    };
    declareReleaseLine(s);
    return s;
  }
  async function makeRunIn(terminal: boolean): Promise<{ runStore: JsonFileStore; id: string }> {
    const runStore = new JsonFileStore(dir);
    const { run } = await runStore.create({ workflowId: 'w', workflowVersion: 1, params: {} });
    if (terminal) {
      await runStore.update({
        ...run,
        run_phase: 'completed',
        terminal_state: true,
        sealed_by: { arm: 'complete' },
        terminal_reason: 'Workflow completed.',
      } as never);
    }
    return { runStore, id: run.id };
  }
  it('catch 1 (a live run): the refusal is rethrown, not filed as definition_unresolvable', async () => {
    const { runStore, id } = await makeRunIn(false);
    await expect(
      handleGetRunState({ run_id: id }, {
        runStore,
        workflowStore: refusingWorkflowStore(),
      } as never),
    ).rejects.toMatchObject({ code: 'ENGINE_RELEASE_LINE_MISMATCH' });
  });
  it('catch 2 (include_steps on a terminal run): the refusal is rethrown, not discarded', async () => {
    const { runStore, id } = await makeRunIn(true);
    await expect(
      handleGetRunState(
        { run_id: id, include_steps: true } as never,
        { runStore, workflowStore: refusingWorkflowStore() } as never,
      ),
    ).rejects.toMatchObject({ code: 'ENGINE_RELEASE_LINE_MISMATCH' });
  });
});
