// workspace-print-1122.test.ts — issue #1122, the line where an operator sees it: `realm agent`'s
// drive (`runAgent`) with the REAL `AnthropicProvider` and the real SDK against the in-process stub,
// which answers with Anthropic's exact R1 refusal (AW-11). The line rides #676's path
// (`explainFailure` → `safeExplainFailure`), so it prints on its own line, indented two spaces,
// right under `✗ Step '<id>' LLM call failed: …` or `✗ Step '<id>' (tools) failed: …`, and the
// run's record keeps Anthropic's own message (AUD1122-12, -19). The key is a fake. Beside each: (a)
// the change that turns it red; (b) what it prints when it fails — stderr's lines and the entry.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryStore } from '@sensigo/realm-testing';
import { ExtensionRegistry } from '@sensigo/realm';
import type { WorkflowDefinition } from '@sensigo/realm';
import { runAgent } from './run-agent.js';
import type { AgentDeps } from './run-agent.js';
import { AnthropicProvider } from './providers/anthropic-provider.js';
import { startAnthropicStub } from './test-support/anthropic-stub.js';
import { runsOf } from '../test-support/temp-home.js';

const ENV_KEYS = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_WORKSPACE_ID'] as const;
const saved = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  vi.restoreAllMocks();
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const R1_NOW =
  'This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header with the ID of the workspace to use. Add the header, or use an API key that is scoped to a workspace.';
const W1 =
  'Anthropic refused this API key because it is not tied to a workspace. Set ANTHROPIC_WORKSPACE_ID to the ID of the workspace to use (in the Claude Console, Settings → Workspaces, the ID column), or use a key made inside a workspace.';

const SINGLE_SHOT_WF = {
  id: 'print-1122',
  name: 'Print 1122',
  version: 1,
  schema_version: 1,
  steps: {
    classify: {
      description: 'Classify',
      execution: 'agent',
      depends_on: [],
      input_schema: { type: 'object', properties: { summary: { type: 'string' } } },
    },
  },
} as unknown as WorkflowDefinition;

const TOOLS_WF = {
  id: 'print-1122-tools',
  name: 'Print 1122 tools',
  version: 1,
  schema_version: 1,
  mcp_servers: [{ id: 'srv', transport: 'stdio', command: 'node', args: [] }],
  steps: {
    ask: {
      description: 'Ask',
      execution: 'agent',
      depends_on: [],
      tools: ['srv:op'],
      output_schema: {
        type: 'object',
        properties: { summary: { type: 'string' } },
        required: ['summary'],
      },
    },
  },
} as unknown as WorkflowDefinition;

type Site = { name: string; wf: WorkflowDefinition; failureLine: string };
const SITES: Site[] = [
  {
    name: 'single-shot',
    wf: SINGLE_SHOT_WF,
    failureLine: "✗ Step 'classify' LLM call failed: 400 ",
  },
  { name: 'tools', wf: TOOLS_WF, failureLine: "✗ Step 'ask' (tools) failed: 400 " },
];

/** Drives one run against the stub answering R1; returns stderr's lines and the failure entry. */
async function drive(site: Site) {
  const stub = await startAnthropicStub({
    finalContent: { summary: 'unused' },
    failure: {
      status: 400,
      headers: {},
      body: {
        type: 'error',
        error: { type: 'invalid_request_error', message: R1_NOW },
        request_id: 'req_011Fake1122',
      },
    },
  });
  try {
    process.env['ANTHROPIC_BASE_URL'] = stub.baseUrl;
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-fake-print-1122-0000';
    delete process.env['ANTHROPIC_WORKSPACE_ID'];
    const store = new InMemoryStore();
    const errors: string[] = [];
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation((m: unknown) => {
      errors.push(String(m));
    });
    const deps = {
      store,
      workflowStore: {
        register: async () => {},
        get: async () => {
          throw new Error('not registered');
        },
        list: async () => [],
      },
      provider: new AnthropicProvider('claude-x', {
        endpoint: 'default',
        promptCache: { value: 'short', source: 'stated', by: 'realm agent' },
        cacheDiagnostics: true,
      }),
      registry: new ExtensionRegistry(),
      mcpClientFactory: () =>
        ({
          connect: async () => {},
          disconnect: async () => {},
          getTools: async () => [
            { name: 'op', description: 'op', inputSchema: { type: 'object', properties: {} } },
          ],
        }) as never,
    } as unknown as AgentDeps;
    const result = await runAgent(deps, { definition: site.wf, params: {} });
    vi.restoreAllMocks();
    const runs = (await runsOf(store)).map((s) => s.record);
    const { record: run } = await store.get(runs[0]!.id);
    const entry = run.drive_failures!.entries[0]!;
    return { result, stderr: errors.join('\n').split('\n'), message: entry.message };
  } finally {
    await stub.close();
  }
}

describe('#1122 — the workspace line under the failure line, on both paths', () => {
  for (const site of SITES) {
    // Real case: the owner's key, not tied to a workspace, with no setting. (a) red when the
    // provider gives no line for R1, or it prints elsewhere; (b) prints stderr's lines.
    it(`${site.name}: W1 on its own line, indented two spaces, right after the failure line; the record keeps Anthropic's message`, async () => {
      const d = await drive(site);
      expect(d.result).toBe('failed');
      const at = d.stderr.findIndex((l) => l.startsWith(site.failureLine));
      expect(at, d.stderr.join('\n')).toBeGreaterThanOrEqual(0);
      expect(d.stderr[at + 1]).toBe(`  ${W1}`);
      expect({
        anthropic: d.message.includes(R1_NOW),
        realm: d.message.includes('ANTHROPIC_WORKSPACE_ID'),
      }).toEqual({ anthropic: true, realm: false });
    });
  }
});
