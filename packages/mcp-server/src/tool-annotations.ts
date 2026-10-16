// tool-annotations.ts — #627 W (§5.5): every MCP tool's annotations, in one table (the baseline was
// none — W-CENSUS-05). Reads carry `readOnlyHint: true`; every write, and the answer tool, carries
// `destructiveHint: true`; each has a title. `present_question` only shows a form — the person's
// accept records the answer — so it is neither read-only nor destructive, and `openWorldHint: false`
// (without it Codex treats the unset hint as true and asks the person to approve the call before the
// form appears: the double ask). It carries no `idempotentHint`: each call spends an ask.
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';

export const TOOL_ANNOTATIONS = {
  list_workflows: { title: 'List workflows', readOnlyHint: true },
  get_workflow_protocol: { title: "Read a workflow's protocol", readOnlyHint: true },
  get_run_state: { title: 'Read a run', readOnlyHint: true },
  start_run: { title: 'Start a run', destructiveHint: true },
  start_run_batch: { title: 'Start several runs', destructiveHint: true },
  execute_step: { title: 'Run a step', destructiveHint: true },
  advance_run: { title: 'Run what the engine owes', destructiveHint: true },
  append_trace: { title: "Add to a step's trace", destructiveHint: true },
  abandon_run: { title: 'End a run', destructiveHint: true },
  create_workflow: { title: 'Create a workflow', destructiveHint: true },
  submit_human_response: { title: "Record a gate's answer", destructiveHint: true },
  present_question: {
    title: "Show the question in the user's app",
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
  },
} as const satisfies Record<string, ToolAnnotations>;

/** A tool's name, as the table keys it. */
export type ToolName = keyof typeof TOOL_ANNOTATIONS;

/** A tool's `title` and `annotations`, as `registerTool` takes them. */
export function toolMeta(name: ToolName): { title: string; annotations: ToolAnnotations } {
  const annotations = TOOL_ANNOTATIONS[name];
  return { title: annotations.title, annotations };
}
