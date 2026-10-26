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
  endedRunWaysSentence,
  TERMINAL_PHASES,
  type Attributed,
  type ActorAbsent,
} from '@sensigo/realm';
import { formCallOf, formDepsOf, mcpHostOf, type HandleRunStores } from './start-run.js';
import { withQuestionForm, type FormCall } from '../form-path.js';
import { toolMeta } from '../tool-annotations.js';
import {
  disclosureOfTool,
  mcpReplyOf,
  withHintTail,
  renderReply,
  safeTool,
  toolContentOf,
  MCP_ENVELOPE_TABLE,
  type McpEnvelope,
  type WithDoorDisclosure,
  type WithPersonBlock,
  replySubject,
  setForSubject,
} from '../render-reply.js';
import { assertToolStores, markServedByTool, registryRole } from './assert-tool-stores.js';
import {
  assertRegistryLine,
  ExtensionRegistry as RealmExtensionRegistry,
  runReadError,
} from '@sensigo/realm';
import { boundedLines, boundedRefusal, moreUnknownKeys } from './refusal-format.js';

/** The arguments this tool takes. Anything else is named in the reply's `warnings`, not dropped. */
const KNOWN_ARGS = ['run_id'] as const;

/**
 * One warning per argument this tool does not take (the house unknown-key warning) — the first ten,
 * then the count (the zod 4 unit's reply bounds, M2).
 */
export function advanceRunUnknownKeyWarnings(args: Record<string, unknown>): string[] {
  return boundedLines(
    Object.keys(args).filter((key) => !(KNOWN_ARGS as readonly string[]).includes(key)),
    (key) => `advance_run: unknown argument '${key}' was ignored.`,
    moreUnknownKeys,
  );
}

/** The tool's input schema. Pass-through, so an unknown key reaches the handler and is named. */
export const advanceRunArgsSchema = z.object({ run_id: z.string() }).loose();

/** `advanceRun`'s reply as the MCP door renders it, plus who ran the steps: this server's driver. */
export type AdvanceRunReply = WithPersonBlock<McpEnvelope> & {
  continued_by: Attributed | ActorAbsent;
};

/**
 * Business logic for the advance_run tool: run what the engine owes on the run — its pending
 * guards, then its runnable `auto` steps — in this server's environment. A repeat with nothing
 * owed runs nothing and returns the run's view, never an error.
 */
export async function handleAdvanceRun(
  args: { run_id: string },
  stores?: HandleRunStores,
  call?: FormCall,
): Promise<AdvanceRunReply> {
  assertToolStores(stores, 'handleAdvanceRun');
  const workflowStore = stores?.workflowStore ?? new JsonWorkflowStore();
  const runStore = stores?.runStore ?? new JsonFileStore();
  // decision C172: a run that cannot be read is answered as the library answers it — the store's own
  // WorkflowError (issue #719: a damaged JSON-store run file is RESOURCE_FORMAT_INVALID,
  // STATE_LEGACY_FORMAT or ENGINE_STORE_FAILED, naming the file and its way out), or, for an
  // untyped throw, ENGINE_STORE_FAILED naming its cause — never ENGINE_INTERNAL.
  const run = await runStore.get(args.run_id).catch((err: unknown) => {
    throw runReadError(err);
  });
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
    caller: 'advance_run',
    ...(registry !== undefined ? { registry } : {}),
    ...(stores?.traceBufferStore !== undefined
      ? { traceBufferStore: stores.traceBufferStore }
      : {}),
    ...(stores?.driver !== undefined ? { driver: stores.driver } : {}),
  });
  // #627 W (§5.2b): a reply that reached a question this process never sent sends its form here.
  const reply = await withQuestionForm(
    result,
    formDepsOf(stores, runStore, definition, registry),
    call,
  );
  // decision C205: a reply on a run that ended with a failed step `realm run resume` takes — this
  // call's own step failed, or the run had ended before it — ends with the way back in.
  // decision C211: a run that ended with cleanup steps left pending says the command that runs
  // them too — any ending.
  const ended =
    reply.run_phase !== undefined && TERMINAL_PHASES.has(reply.run_phase)
      ? await runStore.get(args.run_id).catch(() => undefined)
      : undefined;
  // #729 PR-0: the MCP door's one renderer (next_actions, agent_action, the way sentence); the ended
  // run's ways back in follow the door's next sentence, as before.
  const tail = ended === undefined ? '' : endedRunWaysSentence(ended, definition, new Date());
  return {
    ...mcpReplyOf(withHintTail(renderReply(reply, mcpHostOf(stores)), tail)),
    continued_by:
      stores?.driver !== undefined
        ? stores.driver
        : { by: null, absent_cause: 'driver_not_recorded' },
  };
}

/** Registers the advance_run MCP tool on the server. */
export function registerAdvanceRun(
  server: McpServer,
  opts?: HandleRunStores & WithDoorDisclosure,
): void {
  markServedByTool(opts);
  const door = disclosureOfTool(opts);
  server.registerTool(
    'advance_run',
    {
      ...toolMeta('advance_run'),
      description:
        "Run what a run owes the engine — an expired question's declared on_expiry, then its guards and automatic steps — in this server's environment. Call it when next_actions names it.",
      inputSchema: boundedRefusal(advanceRunArgsSchema),
    },
    safeTool(
      async (rawArgs, extra) => {
        const args = rawArgs as z.infer<typeof advanceRunArgsSchema>;
        const result = await handleAdvanceRun(args, opts, formCallOf(opts, extra));
        const unknown = advanceRunUnknownKeyWarnings(args as Record<string, unknown>);
        // decision C119: `data` and `evidence` are empty in MCP replies, as `execute_step`'s — the
        // run's evidence is read with get_run_state.
        return toolContentOf(
          {
            ...result,
            data: {},
            evidence: [],
            ...(unknown.length > 0 ? { warnings: [...unknown, ...result.warnings] } : {}),
          },
          {
            set: await setForSubject(door, await replySubject(opts, { runId: args.run_id })),
            audience: 'agent',
            table: MCP_ENVELOPE_TABLE,
          },
        );
      },
      async (err, rawArgs) => {
        const args = rawArgs as z.infer<typeof advanceRunArgsSchema>;
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
        const envelope = renderReply(
          buildPreExecutionErrorEnvelope('advance_run', args.run_id, 0, workflowErr, contextHint),
          mcpHostOf(opts),
        );
        return toolContentOf(mcpReplyOf(envelope), {
          set: await setForSubject(door, await replySubject(opts, { runId: args.run_id })),
          audience: 'agent',
          table: MCP_ENVELOPE_TABLE,
        });
      },
    ),
  );
}
