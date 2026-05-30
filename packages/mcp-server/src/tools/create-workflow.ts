// create-workflow.ts — Mode 2: agent creates and registers a workflow at runtime, then starts a run.
import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  JsonWorkflowStore,
  JsonFileStore,
  WorkflowError,
  resolvePreExecutionAgentAction,
  type WorkflowDefinition,
  type ResponseEnvelope,
  type JsonSchema,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
} from '@sensigo/realm';
import { handleStartRun, type HandleRunStores } from './start-run.js';

export interface CreateWorkflowStep {
  id: string;
  description: string;
  depends_on?: string[];
  input_schema?: Record<string, unknown>;
  timeout_seconds?: number;
}

export interface CreateWorkflowArgs {
  steps: CreateWorkflowStep[];
  metadata?: {
    name?: string;
    task_description?: string;
    model?: string;
    agent?: string;
  };
}

function makeErrorEnvelope(errors: string[]): ResponseEnvelope {
  return {
    command: 'create_workflow',
    run_id: '',
    run_version: 0,
    status: 'error',
    data: {},
    evidence: [],
    warnings: [],
    errors,
    agent_action: 'provide_input',
    context_hint: 'Invalid create_workflow input. Fix the errors and retry.',
    next_actions: [],
  };
}

/** Validates all submitted steps. Returns collected error strings (empty = valid). */
function validateArgs(args: CreateWorkflowArgs): string[] {
  const errors: string[] = [];

  if (args.steps.length === 0) {
    errors.push('steps must contain at least one step');
    return errors;
  }

  // Rule 7: agent_profile is not supported on dynamic workflows.
  for (const step of args.steps) {
    if ('agent_profile' in (step as unknown as Record<string, unknown>)) {
      errors.push(
        `Step '${step.id}': agent_profile is not supported on dynamically-created workflows. Use realm register with a YAML workflow file for profile-based execution.`,
      );
    }
  }

  // Rule 2: step IDs must be unique.
  const seenIds = new Set<string>();
  for (const step of args.steps) {
    if (seenIds.has(step.id)) {
      errors.push(`Duplicate step id: '${step.id}'`);
    }
    seenIds.add(step.id);
  }

  // Rule 3: step IDs must be non-empty with no spaces.
  for (const step of args.steps) {
    if (step.id.trim() === '' || step.id.includes(' ')) {
      errors.push(`Step id '${step.id}' is invalid: must be a non-empty string with no spaces`);
    }
  }

  // Rule 4: descriptions must be non-empty.
  for (const step of args.steps) {
    if (step.description.trim() === '') {
      errors.push(`Step '${step.id}': description must be non-empty`);
    }
  }

  // Rule 5: timeout_seconds must be a positive integer if present.
  for (const step of args.steps) {
    if (step.timeout_seconds !== undefined) {
      if (!Number.isInteger(step.timeout_seconds) || step.timeout_seconds <= 0) {
        errors.push(`Step '${step.id}': timeout_seconds must be a positive integer`);
      }
    }
  }

  // Rule 6: depends_on validation.
  const allIds = new Set(args.steps.map((s) => s.id));
  const stepPositions = new Map<string, number>();
  args.steps.forEach((s, i) => stepPositions.set(s.id, i));

  for (const step of args.steps) {
    if (step.depends_on !== undefined) {
      if (step.depends_on.length > 1) {
        errors.push(
          `Step '${step.id}': depends_on supports at most one predecessor (this engine is linear)`,
        );
      }
      for (const ref of step.depends_on) {
        if (!allIds.has(ref)) {
          errors.push(`Step '${step.id}': depends_on references unknown step '${ref}'`);
        } else {
          const refPos = stepPositions.get(ref)!;
          const myPos = stepPositions.get(step.id)!;
          if (refPos >= myPos) {
            errors.push(
              `Step '${step.id}': depends_on must reference a step that appears earlier in the list`,
            );
          }
        }
      }
    }
  }

  return errors;
}

/**
 * Derives a deterministic workflow ID from a slug of the optional name and a
 * 16-hex-char SHA-256 prefix of the definition content (excluding the `id`
 * field to avoid circular dependency). Identical definition content always
 * produces the same ID, making `create_workflow` retries idempotent with the
 * existing file-overwrite semantics of `JsonWorkflowStore.register`.
 */
function deriveWorkflowId(name: string | undefined, definitionWithoutId: object): string {
  const hash = createHash('sha256')
    .update(JSON.stringify(definitionWithoutId))
    .digest('hex')
    .slice(0, 16);
  if (name !== undefined && name.trim() !== '') {
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return `${slug}-${hash}`;
  }
  return `dynamic-${hash}`;
}

/** Builds a linear WorkflowDefinition from the submitted steps. */
function buildWorkflowDefinition(workflowId: string, args: CreateWorkflowArgs): WorkflowDefinition {
  const { steps, metadata } = args;
  const stepsRecord: WorkflowDefinition['steps'] = {};

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const prevStepId = i === 0 ? undefined : steps[i - 1]!.id;

    const stepDef: WorkflowDefinition['steps'][string] = {
      description: step.description,
      execution: 'agent',
      depends_on: prevStepId !== undefined ? [prevStepId] : [],
    };

    if (step.input_schema !== undefined) {
      stepDef.input_schema = step.input_schema as JsonSchema;
    }
    if (step.timeout_seconds !== undefined) {
      stepDef.timeout_seconds = step.timeout_seconds;
    }

    stepsRecord[step.id] = stepDef;
  }

  const definition: WorkflowDefinition = {
    id: workflowId,
    name: metadata?.name ?? 'Dynamic Workflow',
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps: stepsRecord,
  };

  if (metadata?.task_description !== undefined) {
    definition.protocol = { quick_start: metadata.task_description };
  }

  definition.origin = 'agent';
  if (metadata?.model !== undefined) {
    definition.model = metadata.model;
  }
  if (metadata?.agent !== undefined) {
    definition.agent = metadata.agent;
  }

  return definition;
}

/**
 * Business logic for the create_workflow tool.
 * Validates steps, derives a workflow ID, registers the definition, and starts a run.
 */
export async function handleCreateWorkflow(
  args: CreateWorkflowArgs,
  stores?: { workflowStore?: JsonWorkflowStore; runStore?: JsonFileStore },
): Promise<ResponseEnvelope> {
  const errors = validateArgs(args);
  if (errors.length > 0) {
    return makeErrorEnvelope(errors);
  }

  const workflowStore = stores?.workflowStore ?? new JsonWorkflowStore();
  // Build the definition body first (with a placeholder id that is excluded from the hash).
  const definitionBody = buildWorkflowDefinition('__placeholder__', args);
  // Hash all content except the id to derive a stable, deterministic id.
  const { id: _placeholderId, ...definitionWithoutId } = definitionBody;
  const workflowId = deriveWorkflowId(args.metadata?.name, definitionWithoutId);
  const definition: WorkflowDefinition = { ...definitionBody, id: workflowId };

  await workflowStore.register(definition);

  const result = await handleStartRun(
    { workflow_id: workflowId, params: {} },
    {
      workflowStore,
      ...(stores?.runStore !== undefined ? { runStore: stores.runStore } : {}),
    },
  );

  return { ...result, command: 'create_workflow', data: { workflow_id: workflowId } };
}

/** Registers the create_workflow MCP tool on the server. */
export function registerCreateWorkflow(server: McpServer, opts?: HandleRunStores): void {
  const stepSchema = z
    .object({
      id: z.string(),
      description: z.string(),
      depends_on: z.array(z.string()).optional(),
      input_schema: z.record(z.unknown()).optional(),
      timeout_seconds: z.number().optional(),
    })
    .passthrough();

  server.tool(
    'create_workflow',
    'Create a dynamic Realm workflow at runtime and immediately start a run. Use this when you have a multi-step task and want to track your own execution plan. Returns next_action pointing at your first step — proceed with execute_step as normal.',
    {
      steps: z.array(stepSchema).min(1),
      metadata: z
        .object({
          name: z.string().optional(),
          task_description: z.string().optional(),
          model: z.string().optional(),
          agent: z.string().optional(),
        })
        .optional(),
    },
    async (args) => {
      try {
        const result = await handleCreateWorkflow(args as CreateWorkflowArgs, opts);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ ...result, command: 'create_workflow' }, null, 2),
            },
          ],
        };
      } catch (err) {
        const agentAction =
          err instanceof WorkflowError ? resolvePreExecutionAgentAction(err) : 'report_to_user';
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  command: 'create_workflow',
                  run_id: '',
                  status: 'error',
                  data: {},
                  evidence: [],
                  warnings: [],
                  errors: [message],
                  agent_action: agentAction,
                  context_hint:
                    'An error occurred before the workflow could be registered or the run could be started.',
                  next_actions: [],
                },
                null,
                2,
              ),
            },
          ],
        };
      }
    },
  );
}
