// create-workflow.ts — Mode 2: agent creates and registers a workflow at runtime, then starts a run.
import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  JsonWorkflowStore,
  WorkflowError,
  resolvePreExecutionAgentAction,
  findUnknownKeys,
  renderLoaderWarning,
  assessStructuredOutputEligibility,
  renderIneligibleMessage,
  type WorkflowDefinition,
  type ResponseEnvelope,
  type JsonSchema,
  type LoaderWarning,
  type RunStore,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
} from '@sensigo/realm';
import { handleStartRun, type HandleRunStores } from './start-run.js';
import { sseJsonStringify } from '../sse-json.js';

/**
 * The step-shape allow-list (issue #169): `Object.keys(stepSchema.shape)` is the single source
 * of truth for detecting unknown step keys in create_workflow submissions — no hand-maintained
 * list, no drift from the real accepted fields. Module-scoped (hoisted from its previous home
 * function-local to `registerCreateWorkflow`) so `handleCreateWorkflow` can reach it.
 * `.describe()` is the "soft-teach" half of the fix (prevention complementing detection): it
 * enumerates the valid field set directly in the tool's parameter schema, so an agent learns the
 * shape upfront instead of only discovering a typo after submitting it.
 */
const stepSchema = z
  .object({
    id: z.string(),
    description: z.string(),
    depends_on: z.array(z.string()).optional(),
    input_schema: z.record(z.unknown()).optional(),
    timeout_seconds: z.number().optional(),
    // issue #236 (L0 prevention layer): opt in to Anthropic strict/grammar-constrained decoding
    // for this step's submit tool. Gated at PRE-register time by assessStructuredOutputEligibility
    // — see validateArgs below.
    structured_output: z.literal('strict').optional(),
  })
  .passthrough()
  .describe(
    'A single workflow step. Valid fields: id, description, depends_on, input_schema, ' +
      'timeout_seconds, structured_output (the literal "strict" — opts into constrained ' +
      'decoding; rejected pre-register if the input_schema is ineligible). Any other field is ' +
      'dropped and returned as a warning — do not invent step fields.',
  );

export interface CreateWorkflowStep {
  id: string;
  description: string;
  depends_on?: string[];
  input_schema?: Record<string, unknown>;
  timeout_seconds?: number;
  structured_output?: 'strict';
}

export interface CreateWorkflowArgs {
  steps: CreateWorkflowStep[];
  metadata?: {
    name?: string;
    description?: string;
    task_description?: string;
    model?: string;
    agent?: string;
  };
  /**
   * Never supported — present in the schema only so a submitted value survives parsing and
   * is rejected with an actionable error (extensions are register-time, operator-only).
   */
  extensions?: unknown;
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

/**
 * Validates all submitted steps. Returns collected error strings (empty = valid) AND
 * structured_output caveat lines (issue #236) — render-only, never a WarningCode, threaded into
 * the success envelope's `warnings` array by the caller.
 */
function validateArgs(args: CreateWorkflowArgs): { errors: string[]; caveats: string[] } {
  const errors: string[] = [];
  const caveats: string[] = [];

  if (args.steps.length === 0) {
    errors.push('steps must contain at least one step');
    return { errors, caveats };
  }

  // issue #236: the gate reject joins THIS error path — PRE-register (validateArgs runs before
  // handleCreateWorkflow's own `errors.length > 0` early-return, well before register()/
  // start_run() fire) — an ineligible step never reaches a live registered workflow or run.
  for (const step of args.steps) {
    if (step.structured_output !== 'strict') continue;
    const verdict = assessStructuredOutputEligibility({
      schema: step.input_schema,
      tools: false, // create_workflow's dynamic steps never declare tools (no such field exists)
    });
    if (verdict.verdict === 'ineligible') {
      errors.push(
        `Step '${step.id}': 'structured_output: strict' is not eligible for this step's ` +
          `schema — ${renderIneligibleMessage(verdict.reasons)}`,
      );
    } else if (verdict.verdict === 'eligible_with_caveats') {
      for (const c of verdict.caveats) {
        caveats.push(`Step '${step.id}': structured_output caveat — ${c.remediation}`);
      }
    }
  }

  // Rule 7: agent_profile is not supported on dynamic workflows.
  for (const step of args.steps) {
    if ('agent_profile' in (step as unknown as Record<string, unknown>)) {
      errors.push(
        `Step '${step.id}': agent_profile is not supported on dynamically-created workflows. Use realm register with a YAML workflow file for profile-based execution.`,
      );
    }
  }

  // Rule 8: extensions are not supported on dynamic workflows (register-time, operator-only).
  if ('extensions' in (args as unknown as Record<string, unknown>)) {
    errors.push(
      `extensions is not supported on dynamically-created workflows. Project extensions are register-time and operator-only: declare them in workflow.yaml and register with realm workflow register.`,
    );
  }
  for (const step of args.steps) {
    if ('extensions' in (step as unknown as Record<string, unknown>)) {
      errors.push(
        `Step '${step.id}': extensions is not supported on dynamically-created workflows. Project extensions are register-time and operator-only: declare them in workflow.yaml and register with realm workflow register.`,
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

  // Rule 3b (issue #220 §4c): reserved step ids — a PRE-EXISTING GAP fixed in the same edit that
  // reserves `$settlement` (the PR ordering interlock: the namespace ships in a later PR, but the
  // reservation must ship NOW, else the inter-PR gap can register a `$settlement`-named step that
  // becomes load-refused the instant the mint ships). `run`/`context` mirror the YAML loader's own
  // reservation (yaml-loader.ts) — create_workflow never enforced these two at all before this fix.
  for (const step of args.steps) {
    if (step.id === 'run' || step.id === 'context' || step.id === '$settlement') {
      errors.push(`Step id '${step.id}' is reserved and cannot be used as a step identifier`);
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

  return { errors, caveats };
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
    // issue #236: MUST copy — buildWorkflowDefinition copies an explicit field list (never a
    // spread), so an omitted field here would make the registered run silently carry no
    // structured_output at all while the envelope had already disclosed its caveats/rejection —
    // a false disclosure (audit-corrected touch point 3 of 4).
    if (step.structured_output !== undefined) {
      stepDef.structured_output = step.structured_output;
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

  // issue #178: mirrors metadata.description's guard below — an empty/whitespace-only
  // task_description is treated as not-provided, so we never create a pointless
  // protocol: { quick_start: '' } object (which would otherwise blank the generated default).
  if (metadata?.task_description !== undefined && metadata.task_description.trim() !== '') {
    definition.protocol = { quick_start: metadata.task_description };
  }

  if (metadata?.description !== undefined && metadata.description.trim() !== '') {
    definition.description = metadata.description;
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
  stores?: { workflowStore?: JsonWorkflowStore; runStore?: RunStore },
): Promise<ResponseEnvelope> {
  const { errors, caveats: structuredOutputCaveats } = validateArgs(args);
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

  // Issue #169: each raw submitted step's extra keys survive stepSchema's .passthrough() — find
  // them against the SAME allow-list the schema itself declares (Object.keys(stepSchema.shape),
  // the single source of truth, no hand-maintained list). Distinct code (UNKNOWN_CREATE_WORKFLOW_KEY)
  // from the loader's UNKNOWN_STEP_KEY — #170 never flips it, so create_workflow stays lenient for
  // agents forever. The workflow is still created either way; this only ever warns, never rejects.
  const stepDiagnostics: LoaderWarning[] = args.steps
    .flatMap((step) =>
      findUnknownKeys(step as unknown as Record<string, unknown>, Object.keys(stepSchema.shape), {
        scope: 'step',
        code: 'UNKNOWN_CREATE_WORKFLOW_KEY',
        step: step.id,
      }),
    )
    // issue #220 §3b [P-S6]: `validation_exhaustion` gets its OWN targeted message — the generic
    // "not a recognized field" text doesn't teach the actual disposition (register-time-only; a
    // dynamic workflow is auto-enrolled at the default fail-at-6 posture with no reachable
    // override). Every other unknown key keeps the generic message unchanged.
    .map((w) =>
      w.key === 'validation_exhaustion'
        ? {
            ...w,
            message: `Step '${w.step}': 'validation_exhaustion' is register-time only — dynamic workflows use the default exhaustion posture.`,
          }
        : w,
    );

  const result = await handleStartRun(
    { workflow_id: workflowId, params: {} },
    {
      workflowStore,
      ...(stores?.runStore !== undefined ? { runStore: stores.runStore } : {}),
    },
  );

  return {
    ...result,
    command: 'create_workflow',
    data: { workflow_id: workflowId },
    // issue #236 [R2-4]: structured_output caveats render into the existing warnings: string[]
    // (render-only — no WarningCode minted; ALL_ERROR_POLICY never sees them).
    warnings: [
      ...result.warnings,
      ...stepDiagnostics.map(renderLoaderWarning),
      ...structuredOutputCaveats,
    ],
    diagnostics: [...(result.diagnostics ?? []), ...stepDiagnostics],
  };
}

/** Registers the create_workflow MCP tool on the server. */
export function registerCreateWorkflow(server: McpServer, opts?: HandleRunStores): void {
  server.tool(
    'create_workflow',
    'Create a dynamic Realm workflow at runtime and immediately start a run. Use this when you have a multi-step task and want to track your own execution plan. Returns next_action pointing at your first step — proceed with execute_step as normal.',
    {
      steps: z.array(stepSchema).min(1),
      metadata: z
        .object({
          name: z.string().optional(),
          description: z.string().optional(),
          task_description: z.string().optional(),
          model: z.string().optional(),
          agent: z.string().optional(),
        })
        .optional(),
      // Declared so a submitted value is NOT silently stripped by the schema — validateArgs
      // rejects it with an actionable "register-time, operator-only" error (mirrors the
      // per-step agent_profile rejection).
      extensions: z.unknown().optional(),
    },
    async (args) => {
      try {
        const result = await handleCreateWorkflow(args as CreateWorkflowArgs, opts);
        return {
          content: [
            {
              type: 'text' as const,
              text: sseJsonStringify({ ...result, command: 'create_workflow' }),
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
              text: sseJsonStringify({
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
              }),
            },
          ],
        };
      }
    },
  );
}
