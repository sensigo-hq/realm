// composed-journey.ts — the provider-INDEPENDENT body of the composed journey (issue #398).
//
// The journey is: a real agent step calls a real tool on a REAL MCP stdio child (realm's own
// server), the tool fails politely with `isError: true`, and the failure has to survive the
// provider's mint, the store, and the render all the way to what an operator sees. Everything in
// that sentence except the model's answer is shipped code.
//
// WHY FACTORED. Each provider needs its own journey — the two mints are structural twins and a
// cell on one proves nothing about the other — but only the PROVIDER SEAM differs. Duplicating a
// hundred lines per provider is how the two copies drift into testing different things, which is
// the failure this whole harness exists to prevent one level down.
//
// NO ASSERTIONS LIVE HERE. This returns the artifacts; the cells assert. That keeps every
// expectation vitest-side and visible in the file a reader opens when a journey fails, and it is
// why this file imports nothing from vitest — it compiles into the published dist (`files:
// ["dist"]`), unreachable via the exports map, exactly like the sibling stub helpers.
//
// REDACTION HAZARD, INHERITED BY EVERY CALLER. `sanitizeError` (agent-utils.ts) redacts every
// `process.env` value longer than four characters as a SUBSTRING, from tool results and from
// errors alike. A cell that sets an API key for this journey must choose a value that collides
// with no text it later asserts on — otherwise the assertion reads `[REDACTED]` and the failure
// looks like a product bug. Both shipped cells use distinctive `sk-…-composed-journey-0000`
// values for this reason.
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileStore, JsonWorkflowStore, ExtensionRegistry } from '@sensigo/realm';
import type { RunRecord, ToolCallRecord, WorkflowDefinition } from '@sensigo/realm';
import type { LlmProvider } from '../providers/llm-provider.js';
import { runAgent, type AgentRunResult } from '../run-agent.js';
import { inspectRun } from '../../commands/inspect.js';
import { resolveMcpServerEntry } from './mcp-server-entry.js';

export interface ComposedJourneyOptions {
  /** The real provider under test, already pointed at its own stub seam. */
  provider: LlmProvider;
  /** Workflow id the step will ask realm about — must not exist, so the tool fails politely. */
  probeWorkflowId: string;
  /** The `summary` the scripted final answer carries; must satisfy the step's input_schema. */
  finalSummary: string;
}

export interface ComposedJourneyArtifacts {
  result: AgentRunResult;
  /**
   * How many runs the store holds afterwards. Returned rather than asserted here so the cells can
   * pin it: the journey must create EXACTLY one, and a body that quietly took `runs[0]` of several
   * would hide a duplicate-run regression behind a passing assertion about the first one.
   */
  runCount: number;
  run: RunRecord;
  toolCalls: ToolCallRecord[];
  inspectOutput: string;
  inspectVerboseOutput: string;
}

/**
 * Creates an isolated HOME for one journey run.
 *
 * ONE temp home for BOTH store surfaces, and this is load-bearing rather than tidy: the MCP child
 * inherits HOME and creates `$HOME/.realm/workflows` at STARTUP, before any tool call. Pointing
 * only the parent at a temp directory leaves the child writing into the real `~/.realm` — and a
 * real workflow that happened to share the probe id would turn the tool's polite failure into a
 * success, so the journey would go green having proved nothing.
 */
export function makeJourneyHome(prefix: string): string {
  const home = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(home, '.realm'), { recursive: true });
  return home;
}

/**
 * Runs the journey and returns its artifacts, read back from the REAL store rather than from
 * return values.
 */
export async function runComposedJourney(
  tempHome: string,
  options: ComposedJourneyOptions,
): Promise<ComposedJourneyArtifacts> {
  const definition = {
    id: 'composed-journey-wf',
    name: 'Composed Journey',
    version: 1,
    schema_version: 1,
    mcp_servers: [
      {
        id: 'realm',
        transport: 'stdio' as const,
        command: process.execPath,
        args: [resolveMcpServerEntry()],
        // MERGED over the inherited environment by the SDK, so PATH survives and `node` still
        // resolves — this redirects HOME without isolating the child from everything else.
        env: { HOME: tempHome },
      },
    ],
    steps: {
      ask: {
        description: 'Ask realm about a workflow that does not exist',
        execution: 'agent' as const,
        depends_on: [],
        tools: ['realm:get_workflow_protocol'],
        // Present so the scripted final answer has something to validate against: a mismatch
        // engages the #217 repair loop and the journey's first assertion then fails for a reason
        // unrelated to the chain under test.
        input_schema: {
          type: 'object',
          properties: { summary: { type: 'string' } },
          required: ['summary'],
        },
      },
    },
  } as unknown as WorkflowDefinition;

  const store = new JsonFileStore(join(tempHome, '.realm', 'runs'));
  const workflowStore = new JsonWorkflowStore(join(tempHome, '.realm', 'workflows'));
  await workflowStore.register(definition);

  const result = await runAgent(
    {
      store,
      workflowStore,
      provider: options.provider,
      registry: new ExtensionRegistry(),
    },
    { definition, params: {}, pollIntervalMs: 50 },
  );

  const runs = await store.list();
  const runId = runs[0]?.id ?? '';
  const run = await store.get(runId);

  return {
    result,
    runCount: runs.length,
    run,
    toolCalls: run.evidence.flatMap((snap) => snap.tool_calls ?? []),
    inspectOutput: await inspectRun(runId, store, workflowStore),
    inspectVerboseOutput: await inspectRun(runId, store, workflowStore, { verbose: true }),
  };
}
