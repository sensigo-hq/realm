// submit-human-response tool — advances a gate-waiting run with a human choice.
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  JsonWorkflowStore,
  JsonFileStore,
  submitHumanResponse,
  WorkflowError,
  boundStatedName,
  identityRefusalLine,
  buildPreExecutionErrorEnvelope,
  getWorkflowForRun,
  type ResponseEnvelope,
} from '@sensigo/realm';
import type { HandleRunStores } from './start-run.js';
import { sseJsonStringify } from '../sse-json.js';

/** The arguments this tool takes. Anything else is named in the reply's `warnings`, not dropped. */
const KNOWN_ARGS = ['run_id', 'gate_id', 'choice', 'responded_by', 'claim_token'] as const;

/**
 * Near misses for the one argument whose absence changes what a reply says. The house `closestKey`
 * (threshold 2) cannot reach `token` or `claimToken` from `claim_token`, so the map is explicit.
 */
const NEAR_MISSES: Readonly<Record<string, (typeof KNOWN_ARGS)[number]>> = {
  claimToken: 'claim_token',
  token: 'claim_token',
};

/**
 * Issue #625 (holder slice): one warning per argument this tool does not take, naming the near miss
 * when there is one. `server.tool` strips unknown keys before the handler runs, so a misnamed
 * `claimToken` used to vanish without a word and the answer read as "no claim_token passed".
 */
export function unknownKeyWarnings(args: Record<string, unknown>): string[] {
  return Object.keys(args)
    .filter((key) => !(KNOWN_ARGS as readonly string[]).includes(key))
    .map((key) => {
      const near = NEAR_MISSES[key];
      return near !== undefined
        ? `submit_human_response: unknown argument '${key}' was ignored — did you mean '${near}'?`
        : `submit_human_response: unknown argument '${key}' was ignored.`;
    });
}

/**
 * The tool's input schema. Pass-through: `registerTool` hands the handler every key, where
 * `server.tool` strips them first (the form `create_workflow` already uses and documents).
 *
 * `claim_token` has NO minimum length on purpose: with `.min(1)` the SDK would refuse an empty
 * token with `MCP error -32602` and the answer would not be recorded — the damage this argument
 * must never do. The engine judges an empty string as a wrong value (`mismatch`) and records the
 * answer.
 */
export const submitHumanResponseArgsSchema = z
  .object({
    run_id: z.string(),
    gate_id: z.string(),
    choice: z.string(),
    responded_by: z
      .string()
      .optional()
      .describe(
        'Who made the choice, as the caller states it — not verified. At most 200 characters, no control characters.',
      ),
    claim_token: z
      .string()
      .optional()
      .describe(
        'The value from gate.claim_token on the reply that opened this question. Pass it back unchanged; it shows this answer comes from the conversation that opened the question. Never required.',
      ),
  })
  .passthrough();

/**
 * Business logic for the submit_human_response tool.
 * Validates the gate_id and choice, then advances the run past the gate.
 */
export async function handleSubmitHumanResponse(
  args: {
    run_id: string;
    gate_id: string;
    choice: string;
    responded_by?: string | undefined;
    claim_token?: string | undefined;
  },
  stores?: HandleRunStores,
): Promise<ResponseEnvelope> {
  // Issue #625: `responded_by` is bounded exactly as `realm run respond --by` is — refused before
  // anything is read or written, so nothing is recorded (#604's `responded_by` member: one helper
  // guards both doors).
  if (args.responded_by !== undefined) {
    try {
      boundStatedName(args.responded_by, 'responded_by');
    } catch (err) {
      throw new WorkflowError(identityRefusalLine('responded_by', err, 'nothing was recorded'), {
        code: 'VALIDATION_ACTOR_INVALID',
        category: 'VALIDATION',
        agentAction: 'report_to_user',
        retryable: false,
        details: err instanceof WorkflowError ? err.details : {},
      });
    }
  }
  const workflowStore = stores?.workflowStore ?? new JsonWorkflowStore();
  const runStore = stores?.runStore ?? new JsonFileStore();
  const run = await runStore.get(args.run_id);
  // issue #456: code-keyed one-time-register remedy. Verb "retry" — deliberately neutral: the
  // register command in the sentence is for the human this agent's report_to_user relays to.
  const definition = await getWorkflowForRun(workflowStore, run, {
    retryVerb: 'retry',
    verb: 'retry',
  });

  // Per-definition registry (project extensions) — awaited before the call (fail-fast),
  // provider wins over `registry`. Mirrors execute-step.ts. Threaded into submitHumanResponse
  // so that resolving a gate which COMPLETES the run fires its finalizers with project handlers.
  const registry =
    stores?.registryProvider !== undefined
      ? await stores.registryProvider(definition)
      : stores?.registry;

  return submitHumanResponse(runStore, definition, {
    runId: args.run_id,
    gateId: args.gate_id,
    choice: args.choice,
    ...(registry !== undefined ? { registry } : {}),
    // issue #279 (increment 2, PR-D; design record D-5): stored as given once it passes the bound
    // above; never verified.
    ...(args.responded_by !== undefined ? { respondedBy: args.responded_by } : {}),
    // issue #625: judged inside the answer's write, never a reason to refuse it.
    ...(args.claim_token !== undefined ? { claimToken: args.claim_token } : {}),
    ...(stores?.driver !== undefined ? { driver: stores.driver } : {}),
  });
}

/** Registers the submit_human_response MCP tool on the server. */
export function registerSubmitHumanResponse(server: McpServer, opts?: HandleRunStores): void {
  // issue #625: `registerTool` with a pass-through schema — `server.tool` strips unknown keys before
  // the handler sees them (see `create-workflow.ts`), so a misnamed `claimToken` would vanish
  // without a word.
  server.registerTool(
    'submit_human_response',
    {
      description: "Advance a gate-waiting run by submitting the human's choice.",
      inputSchema: submitHumanResponseArgsSchema,
    },
    async (rawArgs) => {
      const args = rawArgs as z.infer<typeof submitHumanResponseArgsSchema>;
      try {
        const result = await handleSubmitHumanResponse(args, opts);
        const unknown = unknownKeyWarnings(args as Record<string, unknown>);
        return {
          content: [
            {
              type: 'text' as const,
              text: sseJsonStringify({
                ...result,
                data: {},
                evidence: [],
                ...(unknown.length > 0 ? { warnings: [...result.warnings, ...unknown] } : {}),
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
              : `An error occurred before gate response could be submitted.`;
        const envelope: ResponseEnvelope = buildPreExecutionErrorEnvelope(
          'submit_human_response',
          args.run_id,
          0,
          workflowErr,
          contextHint,
        );
        return {
          content: [
            {
              type: 'text' as const,
              text: sseJsonStringify(envelope),
            },
          ],
        };
      }
    },
  );
}
