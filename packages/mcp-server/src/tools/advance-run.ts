// advance-run tool — runs the guards and automatic steps a run owes (issue #625 PR-2a).
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  JsonWorkflowStore,
  JsonFileStore,
  advanceRun,
  WorkflowError,
  buildPreExecutionErrorEnvelope,
  getWorkflowForRun,
  type ResponseEnvelope,
  type Attributed,
  type ActorAbsent,
} from '@sensigo/realm';
import type { HandleRunStores } from './start-run.js';
import { sseJsonStringify } from '../sse-json.js';
import { assertToolStores, markServedByTool, registryRole } from './assert-tool-stores.js';
import { assertRegistryLine, ExtensionRegistry as RealmExtensionRegistry } from '@sensigo/realm';

/** The arguments this tool takes. Anything else is named in the reply's `warnings`, not dropped. */
const KNOWN_ARGS = ['run_id'] as const;

/** One warning per argument this tool does not take (the house unknown-key warning). */
export function advanceRunUnknownKeyWarnings(args: Record<string, unknown>): string[] {
  return Object.keys(args)
    .filter((key) => !(KNOWN_ARGS as readonly string[]).includes(key))
    .map((key) => `advance_run: unknown argument '${key}' was ignored.`);
}

/** The tool's input schema. Pass-through, so an unknown key reaches the handler and is named. */
export const advanceRunArgsSchema = z.object({ run_id: z.string() }).passthrough();

/** `advanceRun`'s envelope plus who ran the steps: this server's driver. */
export type AdvanceRunReply = ResponseEnvelope & { continued_by: Attributed | ActorAbsent };

/**
 * Business logic for the advance_run tool: run what the engine owes on the run — its pending
 * guards, then its runnable `auto` steps — in this server's environment. A repeat with nothing
 * owed runs nothing and returns the run's view, never an error.
 */
export async function handleAdvanceRun(
  args: { run_id: string },
  stores?: HandleRunStores,
): Promise<AdvanceRunReply> {
  assertToolStores(stores, 'handleAdvanceRun');
  const workflowStore = stores?.workflowStore ?? new JsonWorkflowStore();
  const runStore = stores?.runStore ?? new JsonFileStore();
  const run = await runStore.get(args.run_id);
  const definition = await getWorkflowForRun(workflowStore, run, {
    retryVerb: 'retry',
    verb: 'retry',
  });
  const registry =
    stores?.registryProvider !== undefined
      ? await stores.registryProvider(definition)
      : stores?.registry;
  assertRegistryLine(
    registry,
    registryRole(stores, 'advance_run', 'handleAdvanceRun'),
    RealmExtensionRegistry,
  );
  const result = await advanceRun(runStore, definition, {
    runId: args.run_id,
    command: 'advance_run',
    ...(registry !== undefined ? { registry } : {}),
    ...(stores?.traceBufferStore !== undefined
      ? { traceBufferStore: stores.traceBufferStore }
      : {}),
    ...(stores?.driver !== undefined ? { driver: stores.driver } : {}),
  });
  return {
    ...result,
    continued_by:
      stores?.driver !== undefined
        ? stores.driver
        : { by: null, absent_cause: 'driver_not_recorded' },
  };
}

/** Registers the advance_run MCP tool on the server. */
export function registerAdvanceRun(server: McpServer, opts?: HandleRunStores): void {
  markServedByTool(opts);
  server.registerTool(
    'advance_run',
    {
      description:
        "Run the guards and automatic steps a run owes, in this server's environment. Call it when next_actions names it.",
      inputSchema: advanceRunArgsSchema,
    },
    async (rawArgs) => {
      const args = rawArgs as z.infer<typeof advanceRunArgsSchema>;
      try {
        const result = await handleAdvanceRun(args, opts);
        const unknown = advanceRunUnknownKeyWarnings(args as Record<string, unknown>);
        return {
          content: [
            {
              type: 'text' as const,
              text: sseJsonStringify({
                ...result,
                ...(unknown.length > 0 ? { warnings: [...unknown, ...result.warnings] } : {}),
              }),
            },
          ],
        };
      } catch (err) {
        const workflowErr =
          err instanceof WorkflowError
            ? err
            : new WorkflowError(err instanceof Error ? err.message : String(err), {
                code: 'ENGINE_INTERNAL',
                category: 'ENGINE',
                agentAction: 'stop',
                retryable: false,
              });
        const contextHint =
          workflowErr.code === 'STATE_WORKFLOW_NOT_FOUND'
            ? `Workflow definition for run '${args.run_id}' not found.`
            : workflowErr.code === 'STATE_RUN_NOT_FOUND'
              ? `Run '${args.run_id}' not found.`
              : `An error occurred before the run could be advanced.`;
        const envelope: ResponseEnvelope = buildPreExecutionErrorEnvelope(
          'advance_run',
          args.run_id,
          0,
          workflowErr,
          contextHint,
        );
        return { content: [{ type: 'text' as const, text: sseJsonStringify(envelope) }] };
      }
    },
  );
}
