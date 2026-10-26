// get-workflow-protocol tool — returns the agent protocol for a workflow.
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  JsonWorkflowStore,
  WorkflowError,
  answersRowOf,
  AUTHOR_RULES_LABEL,
  type DisclosureClass,
} from '@sensigo/realm';
import {
  disclosureOfTool,
  safeTool,
  toolContentOf,
  type WithDoorDisclosure,
  replySubject,
  setForSubject,
  SAFE_TOOL_CONSTANT_RUNLESS,
} from '../render-reply.js';
import { toolMeta } from '../tool-annotations.js';
import {
  generateProtocol,
  type EffectiveWay,
  type WorkflowProtocol,
} from '../protocol/generator.js';
import type { HandleStores } from './list-workflows.js';
import type { McpDoor } from '../door.js';
import { assertToolStores } from './assert-tool-stores.js';
import { boundedRefusal } from './refusal-format.js';

/**
 * Issue #197 PR-2 (design §6): one brief affordance line teaching cooperating agents to mint
 * `writer_nonce` — consistent with `append_trace`'s own opt-in posture (an affordance, never a
 * requirement). Appended to `rules` here (in the TOOL layer) rather than in
 * `protocol/generator.ts` itself, since that module is off this PR's touch list — this keeps the
 * generator's own output byte-identical for any OTHER consumer that calls it directly.
 */
const WRITER_NONCE_PROTOCOL_RULE =
  'Optional: mint a fresh UUIDv4 writer_nonce per step-attempt (the same value on every ' +
  'append_trace call for that attempt, a new one next attempt, on BOTH append_trace and ' +
  'execute_step or neither) to get your own buffered trace lines faithfully attributed instead ' +
  'of the honest-but-unattributed floor.';

/**
 * Issue #279 (increment 1, PR-B), design record §6: ONE appended TOOL-layer rule (the
 * WRITER_NONCE_PROTOCOL_RULE precedent above) — a concurrent settlement of the SAME step by a
 * sibling attempt resolves automatically (no operator action needed); on the specific
 * STATE_STEP_ALREADY_SETTLED error, the agent should call get_run_state and continue from the
 * run's actual state rather than treating it as a genuine failure. The generator itself is
 * untouched — same rationale as the writer_nonce rule above.
 */
const CONCURRENT_SETTLEMENT_PROTOCOL_RULE =
  'A concurrent completion of the same step by a sibling attempt resolves automatically — on a ' +
  "STATE_STEP_ALREADY_SETTLED error, call get_run_state and continue from the run's actual " +
  'state rather than treating it as a failure.';

/**
 * #627 W (W-p4): the await rule — Realm's own, carried under every way and after a workflow's own
 * `protocol.rules`, so an author's text that names an answer tool is overridden by it.
 */
export const AWAIT_PROTOCOL_RULE =
  'When a next_actions entry has `awaiting` instead of `instruction`, follow its text, even where gate.agent_hint or a workflow rule says otherwise: do not call anything to answer the question.';

/**
 * #627 W: the value line — what this session's way means for gate answers (W-p5 `withheld`, W-p6
 * the fallback, W-p9 `asked` with forms; W-p7 `offered`: none). It names no route and no command.
 */
export function valueLineOf(way: EffectiveWay): string | undefined {
  switch (way) {
    case 'withheld':
      return 'This server records no gate answers. Workflow text that mentions answering tools refers to tools this session does not have.';
    case 'fallback':
      return 'Answers to gates go through submit_human_response; your client may ask the user to approve each call.';
    case 'asked_forms':
      return "Gate questions are sent to the user's app as a form when start_run, execute_step or advance_run first reaches the gate, or when you call present_question; you cannot answer them. Follow the await entry: it says whether a form was sent in this session.";
    case 'offered':
      return undefined;
  }
}

/**
 * Business logic for the get_workflow_protocol tool.
 * Returns the full agent protocol for the specified workflow. #627 W: composed for this session's
 * way (the door's answers row; `offered` without a door), a workflow's own `protocol.rules` marked
 * as the author's (W-t1), then Realm's own rules after them — the await rule, the value line, and the
 * two trace rules.
 */
export async function handleGetWorkflowProtocol(
  args: { workflow_id: string },
  stores?: HandleStores & { door?: McpDoor },
): Promise<WorkflowProtocol> {
  assertToolStores(stores, 'handleGetWorkflowProtocol');
  const store = stores?.workflowStore ?? new JsonWorkflowStore();
  const definition = await store.get(args.workflow_id);
  const way: EffectiveWay = answersRowOf(stores?.door?.answers()) ?? 'offered';
  const protocol = generateProtocol(definition, way);
  const authored = definition.protocol?.rules !== undefined;
  const valueLine = valueLineOf(way);
  return {
    ...protocol,
    rules: [
      ...(authored ? [AUTHOR_RULES_LABEL] : []),
      ...protocol.rules,
      AWAIT_PROTOCOL_RULE,
      ...(valueLine !== undefined ? [valueLine] : []),
      WRITER_NONCE_PROTOCOL_RULE,
      CONCURRENT_SETTLEMENT_PROTOCOL_RULE,
    ],
  };
}

/** #729 PR-3 (M-1): the protocol is the definition's author text and realm's rules: facts. */
export const WORKFLOW_PROTOCOL_TABLE = {
  workflow_id: 'fact',
  name: 'fact',
  description: 'fact',
  params_schema: 'fact',
  steps: 'fact',
  agent_steps_summary: 'fact',
  rules: 'fact',
  error_handling: 'fact',
  quick_start: 'fact',
} as const satisfies Record<keyof WorkflowProtocol, DisclosureClass>;

/** Registers the get_workflow_protocol MCP tool on the server. */
export function registerGetWorkflowProtocol(
  server: McpServer,
  opts?: HandleStores & { door?: McpDoor } & WithDoorDisclosure,
): void {
  const door = disclosureOfTool(opts);
  server.registerTool(
    'get_workflow_protocol',
    {
      ...toolMeta('get_workflow_protocol'),
      description: 'Get the full agent protocol briefing for a registered workflow.',
      inputSchema: boundedRefusal(z.object({ workflow_id: z.string() })),
    },
    safeTool(
      async (args) => {
        const result = await handleGetWorkflowProtocol(args, opts);
        return toolContentOf(
          { ...result },
          {
            set: await setForSubject(
              door,
              await replySubject(opts, { workflowId: args.workflow_id }),
            ),
            audience: 'agent',
            table: WORKFLOW_PROTOCOL_TABLE,
          },
        );
      },
      async (err, args) => {
        // The error's text goes through the door too: masked with every tier (M-2).
        const message = err instanceof WorkflowError ? err.message : String(err);
        return {
          ...toolContentOf(`Error: ${message}`, {
            set: await setForSubject(
              door,
              await replySubject(opts, { workflowId: args.workflow_id }),
            ),
            audience: 'agent',
            table: WORKFLOW_PROTOCOL_TABLE,
          }),
          isError: true,
        };
      },
      SAFE_TOOL_CONSTANT_RUNLESS,
    ),
  );
}
