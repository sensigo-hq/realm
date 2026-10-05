// model-not-found-print-676.test.ts — issue #676: `realm agent` prints the provider's one-sentence
// explanation of a failed model call, on its own line under the failure line, at both sites:
// `✗ Step '<step>' (tools) failed: …` and `✗ Step '<step>' LLM call failed: …`.
//
// The method is optional and may come from a third-party provider, so the driver asks through
// `safeExplainFailure`: a method that throws, returns a non-string, '' or only spaces must leave
// stderr exactly as it is for a provider with no such method — and the drive-failure entry must
// never change.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryStore } from '@sensigo/realm-testing';
import { ExtensionRegistry } from '@sensigo/realm';
import type { WorkflowDefinition } from '@sensigo/realm';
import { runAgent } from './run-agent.js';
import type { AgentDeps } from './run-agent.js';
import { ToolCapableLlmProvider } from './providers/llm-provider.js';

/** The real 404 Anthropic answers for a model it does not offer (captured 2026-10-04). */
function notFound(): Error {
  const body = {
    type: 'error',
    error: { type: 'not_found_error', message: 'model: claude-does-not-exist' },
    request_id: 'req_011CfgzxrwYbWHkh1JH7p62o',
  };
  return Object.assign(new Error(`404 ${JSON.stringify(body)}`), { status: 404, error: body });
}

const SENTENCE = 'The provider has no model by that name.';

/** Throws the captured 404 from both calls; `explain` (when given) is its `explainFailure`. */
class FailingProvider extends ToolCapableLlmProvider {
  constructor(explain?: (err: unknown) => unknown) {
    super();
    if (explain !== undefined) {
      this.explainFailure = explain as (err: unknown) => string | undefined;
    }
  }
  async callStep(): Promise<Record<string, unknown>> {
    throw notFound();
  }
  async callStepWithTools(): Promise<never> {
    throw notFound();
  }
}

const SINGLE_SHOT_WF = {
  id: 'print-676',
  name: 'Print 676',
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
  id: 'print-676-tools',
  name: 'Print 676 tools',
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
  { name: 'tools', wf: TOOLS_WF, failureLine: "✗ Step 'ask' (tools) failed: 404 " },
  {
    name: 'single-shot',
    wf: SINGLE_SHOT_WF,
    failureLine: "✗ Step 'classify' LLM call failed: 404 ",
  },
];

/** Drives one run to its failure; returns stderr's lines and the run's drive-failure entry. */
async function drive(site: Site, provider: FailingProvider) {
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
    provider,
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
  const runs = await store.list();
  const run = await store.get(runs[0]!.id);
  const entry = run.drive_failures!.entries[0]!;
  return {
    result,
    stderr: errors.join('\n').split('\n'),
    entry: {
      step: entry.step,
      provider: entry.provider,
      error_class: entry.error_class,
      message: entry.message,
      last_observed_status: entry.last_observed_status,
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the model-not-found sentence under the failure line (issue #676)', () => {
  for (const site of SITES) {
    it(`${site.name}: the sentence is printed on its own line, indented two spaces, right after the failure line`, async () => {
      const d = await drive(site, new FailingProvider(() => SENTENCE));
      expect(d.result).toBe('failed');
      const at = d.stderr.findIndex((l) => l.startsWith(site.failureLine));
      expect(at, d.stderr.join('\n')).toBeGreaterThanOrEqual(0);
      expect(d.stderr[at + 1]).toBe(`  ${SENTENCE}`);
      // The record keeps the provider's own words.
      const today = await drive(site, new FailingProvider());
      expect(d.entry).toEqual(today.entry);
      expect(d.entry.error_class).toBe('api_status');
    });
  }

  const unusable: Array<[string, (err: unknown) => unknown]> = [
    [
      'a method that throws',
      () => {
        throw new Error('explainFailure exploded');
      },
    ],
    ['a method that returns a non-string', () => 42],
    ["a method that returns ''", () => ''],
    ["a method that returns '   '", () => '   '],
  ];
  for (const site of SITES) {
    for (const [label, explain] of unusable) {
      it(`${site.name}: ${label} → stderr exactly as today, and the drive-failure entry unchanged`, async () => {
        const today = await drive(site, new FailingProvider());
        const d = await drive(site, new FailingProvider(explain));
        expect(d.result).toBe('failed');
        expect(d.stderr).toEqual(today.stderr);
        expect(d.entry).toEqual(today.entry);
      });
    }
  }
});
