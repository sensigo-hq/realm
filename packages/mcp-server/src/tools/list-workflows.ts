// list-workflows tool — returns all registered workflows, and names every registered copy the
// listing could not read (issue #558 PR-T, review fold R5: the agent's discovery surface said
// `[]` + "use create_workflow" over an unreadable registry — steering the agent into minting a
// duplicate of a workflow that still exists).
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { JsonWorkflowStore } from '@sensigo/realm';
import { sseJsonStringify } from '../sse-json.js';

export interface HandleStores {
  workflowStore?: JsonWorkflowStore;
}

/** A registered copy the listing could not read — the same census `realm workflow list` prints. */
export interface UnreadableWorkflowEntry {
  /** The registry file (its basename), or the registry directory for `registry_broken`. */
  file: string;
  /** `unreadable` · `not_a_file` · `empty` · `parse` · `registry_broken` (never an error code). */
  class: string;
  /** Present only for the OS-error classes — never fabricated. */
  errno?: string;
  /** The store's own sentence for the failure. */
  reason: string;
  /** The repair act for the class — an operator's act (a shell command), named so the agent can
   *  relay it; absent only for a class with no act. */
  repair?: string;
}

export type ListWorkflowsResult =
  | {
      status: 'ok';
      workflows: Array<{ id: string; name: string; version: number }>;
      unreadable: UnreadableWorkflowEntry[];
      /** Non-empty exactly when `unreadable` is — the envelope grammar's channel a client reads
       *  before `hint` (walk 2: a `status: ok` guard skipped the hint entirely). */
      warnings: string[];
      hint: string;
    }
  | {
      /** The registry DIRECTORY itself could not be read: nothing can be listed or started. */
      status: 'error';
      error_code: 'STATE_WORKFLOW_UNREADABLE';
      error_details: { class: 'registry_broken'; errno?: string; path: string };
      errors: string[];
      agent_action: 'stop';
      workflows: [];
      unreadable: [];
      hint: string;
    };

const HEALTHY_HINT =
  'Call get_workflow_protocol with a workflow_id before calling start_run. If no workflow matches your task, use create_workflow to define and start your own plan.';

/**
 * Business logic for the list_workflows tool.
 * Returns a summary of all registered workflows AND every registered copy that could not be read.
 * The "use create_workflow" steer is offered only when every copy was read: a copy that could not
 * be read may still be a registered workflow that only needs its file repaired, and realm cannot
 * tell which until an operator looks — so the steer is withdrawn rather than guessed.
 */
export async function handleListWorkflows(stores?: HandleStores): Promise<ListWorkflowsResult> {
  const store = stores?.workflowStore ?? new JsonWorkflowStore();
  const { workflows, unreadable } = await store.listWithDiagnostics();
  const broken = unreadable.find((u) => u.class === 'registry_broken');
  if (broken !== undefined) {
    return {
      status: 'error',
      error_code: 'STATE_WORKFLOW_UNREADABLE',
      error_details: {
        class: 'registry_broken',
        ...(broken.errno !== undefined ? { errno: broken.errno } : {}),
        path: broken.file,
      },
      errors: [
        `${broken.reason}.${broken.repair !== undefined ? ` To repair: ${broken.repair}.` : ''}`,
      ],
      agent_action: 'stop',
      workflows: [],
      unreadable: [],
      // (audit round 2, S1: no claim about what the registry holds — realm could not read it.)
      hint: 'Realm could not read the registry directory, so it cannot tell you what is registered there; nothing can be listed or started until an operator repairs it. Do not create a workflow to work around it.',
    };
  }
  const entries: UnreadableWorkflowEntry[] = unreadable.map((u) => ({
    file: u.file,
    class: u.class,
    ...(u.errno !== undefined ? { errno: u.errno } : {}),
    reason: u.reason,
    ...(u.repair !== undefined ? { repair: u.repair } : {}),
  }));
  const count = `${String(entries.length)} registered workflow ${entries.length === 1 ? 'copy' : 'copies'} could not be read`;
  return {
    status: 'ok',
    workflows: workflows.map((w) => ({ id: w.id, name: w.name, version: w.version })),
    unreadable: entries,
    warnings: entries.length === 0 ? [] : [`${count} — see 'unreadable'.`],
    hint:
      entries.length === 0
        ? HEALTHY_HINT
        : `${count} — 'unreadable' names each file, the reason and the repair (an operator's act). Do not create a workflow to replace one listed there until an operator has looked: the entry may be a registered workflow that only needs its file repaired. Call get_workflow_protocol with a workflow_id before calling start_run.`,
  };
}

/** Registers the list_workflows MCP tool on the server. */
export function registerListWorkflows(server: McpServer, opts?: HandleStores): void {
  server.tool(
    'list_workflows',
    'List all registered Realm workflows; names every registered copy that could not be read, and refuses when the registry directory itself cannot be read.',
    async () => {
      const result = await handleListWorkflows(opts);
      return { content: [{ type: 'text' as const, text: sseJsonStringify(result) }] };
    },
  );
}
