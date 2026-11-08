// list-workflows tool — returns all registered workflows, and names every registered copy the
// listing could not read (issue #558 PR-T, review fold R5: the agent's discovery surface said
// `[]` + "use create_workflow" over an unreadable registry — steering the agent into minting a
// duplicate of a workflow that still exists).
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  listWorkflowsDiagnosed,
  type DisclosureClass,
  type KeysOfUnion,
  type UnreadableFileEntry,
  type UnreadableRegistryEntry,
  type WorkflowRegistrar,
} from '@sensigo/realm';
import {
  disclosureOfTool,
  safeTool,
  toolContentOf,
  type WithDoorDisclosure,
  replySubject,
  setForWorkflows,
  SAFE_TOOL_CONSTANT_RUNLESS,
} from '../render-reply.js';
import { toolMeta } from '../tool-annotations.js';
import { assertToolStores } from './assert-tool-stores.js';

export interface HandleStores {
  /** The workflow registry: any `WorkflowRegistrar` (#661). Listed through core's
   *  `listWorkflowsDiagnosed`: its `listWithDiagnostics` when it has one, else `list()`. #616 PR-2a
   *  (ii-b): required — the handler builds no store. */
  workflowStore: WorkflowRegistrar;
}

/**
 * A registered copy the listing could not read — the same census `realm workflow list` prints. Each
 * entry carries exactly one of two fields (#616 PR-2c c5a), and all of one registry's entries carry
 * the same one:
 * - `file` (a registry of files, the JSON registry): the registry file's basename, or the registry
 *   directory for `registry_broken`; `errno` only for the OS-error classes, never fabricated. Its
 *   classes are eight: `missing` · `unreadable` · `not_a_file` · `empty` · `registry_broken` ·
 *   `parse` · `newer` (a later version of Realm registered it) · `legacy` (an older version did).
 * - `workflow_id` (a registry with no files, the SQLite registry): the registered workflow's id; never
 *   `file` or `errno`. Its classes are three: `legacy` · `newer` · `parse` — a copy that is not JSON
 *   or fails the checker, or a damaged pointer row, whose `repair` is absent because its `reason` names
 *   the remedy.
 *
 * On both arms `class` is never an error code, `reason` is the store's own sentence for the failure,
 * and `repair` is the repair act for it — an operator's act, named so the agent can relay it; absent
 * for a failure with no act.
 */
export type UnreadableWorkflowEntry = UnreadableRegistryEntry;

export type ListWorkflowsResult =
  | {
      status: 'ok';
      workflows: Array<{ id: string; name: string; version: number }>;
      unreadable: UnreadableWorkflowEntry[];
      /** Non-empty when `unreadable` is, or when the reply passes the ceiling (#872 (b1): the
       *  overflow line) — the envelope grammar's channel a client reads before `hint` (walk 2: a
       *  `status: ok` guard skipped the hint entirely). */
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
export async function handleListWorkflows(stores: HandleStores): Promise<ListWorkflowsResult> {
  assertToolStores(stores, 'handleListWorkflows', ['workflowStore']);
  const { workflows, unreadable } = await listWorkflowsDiagnosed(stores.workflowStore);
  const broken = unreadable.find(
    (u): u is UnreadableFileEntry => u.class === 'registry_broken' && u.file !== undefined,
  );
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
  // #616 PR-2c c5a: each entry with its own arm's fields and no other — a `workflow_id` entry never
  // carries `file`.
  const entries: UnreadableWorkflowEntry[] = unreadable.map((u) =>
    u.workflow_id !== undefined
      ? {
          workflow_id: u.workflow_id,
          class: u.class,
          reason: u.reason,
          ...(u.repair !== undefined ? { repair: u.repair } : {}),
        }
      : {
          file: u.file,
          class: u.class,
          ...(u.errno !== undefined ? { errno: u.errno } : {}),
          reason: u.reason,
          ...(u.repair !== undefined ? { repair: u.repair } : {}),
        },
  );
  const byFile = entries.some((u) => u.file !== undefined);
  const count = `${String(entries.length)} registered workflow ${entries.length === 1 ? 'copy' : 'copies'} could not be read`;
  return {
    status: 'ok',
    workflows: workflows.map((w) => ({ id: w.id, name: w.name, version: w.version })),
    unreadable: entries,
    warnings: entries.length === 0 ? [] : [`${count} — see 'unreadable'.`],
    hint:
      entries.length === 0
        ? HEALTHY_HINT
        : byFile
          ? // Correction 2 (3.5): by class — a newer or a legacy copy carries no `repair`; its reason
            // names the way out.
            `${count} — 'unreadable' names each file and the reason, with the repair where one applies (an operator's act). Do not create a workflow to replace one listed there until an operator has looked: the entry may be a registered workflow that only needs its file repaired, or one an older or a later version of Realm registered, whose reason names the way out. Call get_workflow_protocol with a workflow_id before calling start_run.`
          : // #616 PR-2c c5a: entries by workflow id (the SQLite registry) — no file to repair; a
            // damaged row's reason names what to do.
            `${count} — 'unreadable' names each workflow by its id and the reason, with the repair where one applies (an operator's act). Do not create a workflow to replace one listed there until an operator has looked: the entry may be a registered workflow that only needs registering again from its source, one an older or a later version of Realm registered, whose reason names the way out, or a registry row that was damaged, whose reason names what to do. Call get_workflow_protocol with a workflow_id before calling start_run.`,
  };
}

/** #729 PR-3 (M-1): the list's class table, over both arms. A file's reason is the error text a read
 *  gave (a diagnostic copy); paths, ids and the composed hint are facts. */
export const LIST_WORKFLOWS_TABLE = {
  status: 'fact',
  workflows: 'fact',
  unreadable: {
    nested: {
      file: 'fact',
      workflow_id: 'fact',
      class: 'fact',
      errno: 'fact',
      reason: 'bounded',
      repair: 'fact',
    } satisfies Record<KeysOfUnion<UnreadableWorkflowEntry>, DisclosureClass>,
  },
  warnings: 'bounded',
  hint: 'fact',
  error_code: 'fact',
  error_details: 'fact',
  errors: 'bounded',
  agent_action: 'fact',
} as const satisfies Record<KeysOfUnion<ListWorkflowsResult>, DisclosureClass>;

/** Registers the list_workflows MCP tool on the server. */
export function registerListWorkflows(
  server: McpServer,
  opts: HandleStores & WithDoorDisclosure,
): void {
  const door = disclosureOfTool(opts);
  server.registerTool(
    'list_workflows',
    {
      ...toolMeta('list_workflows'),
      description:
        'List all registered Realm workflows; names every registered copy that could not be read, and refuses when the registry directory itself cannot be read.',
    },
    safeTool(
      async () => {
        const result = await handleListWorkflows(opts);
        // F11 (D-11): the reply covers every listed workflow, so it reports the weakest standing.
        const subjects = await Promise.all(
          (result.workflows ?? []).map((w) => replySubject(opts, { workflowId: w.id })),
        );
        const definitions = subjects.flatMap((x) =>
          x.definition !== undefined ? [x.definition] : [],
        );
        return toolContentOf(
          { ...result },
          {
            set: await setForWorkflows(door, definitions),
            audience: 'agent',
            table: LIST_WORKFLOWS_TABLE,
          },
        );
      },
      async (err) => {
        throw err;
      },
      SAFE_TOOL_CONSTANT_RUNLESS,
    ),
  );
}
