// create-workflow.ts — Mode 2: agent creates and registers a workflow at runtime, then starts a run.
import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  capText,
  listWords,
  quotedNames,
  compileSchema,
  isStrictModeRefusal,
  isAsyncSchemaRefusal,
  asyncSchemaValidity,
  describeSchemaFailure,
  SCHEMA_KEY_CONSEQUENCE,
  composeSchemaFailure,
  JsonWorkflowStore,
  WorkflowError,
  resolvePreExecutionAgentAction,
  findUnknownKeys,
  renderLoaderWarning,
  assessStructuredOutputEligibility,
  renderIneligibleMessage,
  type WorkflowDefinition,
  type JsonSchema,
  type LoaderWarning,
  type RunStore,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
} from '@sensigo/realm';
// #729 PR-0 (Amendment 12): the MCP wire's reply type (the core reply is `EngineReply`).
import {
  disclosureOfTool,
  safeTool,
  toolContentOf,
  MCP_ENVELOPE_TABLE,
  type McpEnvelope,
  type WithDoorDisclosure,
  replySubject,
  setForSubject,
  SAFE_TOOL_CONSTANT_RUNLESS,
} from '../render-reply.js';
import { handleStartRun, type HandleRunStores } from './start-run.js';
import { ArgsNumbersRefusal, checkArgsNumbersJoined } from './args-numbers.js';
import { toolMeta } from '../tool-annotations.js';
import { assertToolStores } from './assert-tool-stores.js';
import {
  boundedLines,
  boundedRefusal,
  MAX_PLACE_LINES,
  moreUnknownKeys,
} from './refusal-format.js';

/**
 * The step-shape allow-list (issue #169): `Object.keys(stepSchema.shape)` is the single source
 * of truth for detecting unknown step keys in create_workflow submissions — no hand-maintained
 * list, no drift from the real accepted fields. Module-scoped (hoisted from its previous home
 * function-local to `registerCreateWorkflow`) so `handleCreateWorkflow` can reach it.
 * `.describe()` is the "soft-teach" half of the fix (prevention complementing detection): it
 * enumerates the valid field set directly in the tool's parameter schema, so an agent learns the
 * shape upfront instead of only discovering a typo after submitting it.
 */
/**
 * Z3 (the zod 4 unit): the most steps one `create_workflow` call may carry. The size check comes
 * FIRST on each array, so zod 4.6.6+ refuses an over-long array before it parses a single element
 * (GHSA-mrhx-c7xc-m3w5; the early stop reads only leading size checks).
 */
export const MAX_WORKFLOW_STEPS = 200;

/**
 * The zod 4 unit, R3: the most `depends_on` names one step may list. The door builds a chain — each
 * step waits for the step just before it (`buildWorkflowDefinition`, which writes
 * `depends_on: [the previous step]` and never uses the names sent) — so one name, that step, is all
 * it can honour; the engine itself takes any number (the DAG door, #554, raises this).
 */
export const MAX_CREATE_WORKFLOW_PREDECESSORS = 1;

export const stepSchema = z
  .object({
    id: z.string(),
    description: z.string(),
    depends_on: z
      .array(z.string())
      .max(MAX_CREATE_WORKFLOW_PREDECESSORS, {
        error:
          'depends_on lists more than one step; create_workflow takes at most one — the step just before this one (steps run in list order)',
      })
      .describe(
        'Optional. At most one name: the step listed just before this one. create_workflow runs steps one at a time in list order, so each step already waits for every step above it.',
      )
      .optional(),
    input_schema: z.record(z.string(), z.unknown()).optional(),
    // issue #412: `timeout_seconds` was REMOVED here, not renamed. Every step this tool mints is
    // `execution: 'agent'`, where nothing enforces it — the loader now rejects the same shape
    // (#402). `llm_timeout_seconds` is the key that actually bounds an agent step's model
    // request (#401), per ATTEMPT.
    // The zod 4 unit, R2 (O1): realm's words for a non-finite number (`1e400` arrives as Infinity);
    // every other branch keeps zod's own words (`undefined`).
    llm_timeout_seconds: z
      .number({
        error: (iss) =>
          iss.code === 'invalid_type' &&
          typeof iss.input === 'number' &&
          !Number.isFinite(iss.input)
            ? 'llm_timeout_seconds is not a finite number (a value such as 1e400 arrives as Infinity) — send a finite number of seconds'
            : undefined,
      })
      .optional(),
    // issue #236 (L0 prevention layer): opt in to Anthropic strict/grammar-constrained decoding
    // for this step's submit tool. Gated at PRE-register time by assessStructuredOutputEligibility
    // — see validateArgs below.
    structured_output: z.literal('strict').optional(),
  })
  .loose()
  .describe(
    'A single workflow step. Valid fields: id, description, depends_on, input_schema, ' +
      "llm_timeout_seconds (positive integer seconds; the PER-ATTEMPT ceiling on this step's " +
      'model request), structured_output (the literal "strict" — opts into constrained ' +
      'decoding; rejected pre-register if the input_schema is ineligible). Any other field is ' +
      'dropped and returned as a warning — do not invent step fields.',
  );

/**
 * The metadata allow-list (issue #419), same pattern as `stepSchema` above: `Object.keys(shape)`
 * is the single source of truth for detecting unknown metadata keys, so the accepted fields and
 * the sweep can never drift apart.
 *
 * `.loose()` is load-bearing, not decoration. A nested plain `z.object` strips
 * independently of its parent: even under a loose top level, `metadata: { name, author }`
 * arrived at the handler as `{ name }` with `author` gone and nothing said. Metadata was a
 * SECOND silent surface; `.loose()` is what lets the sweep below ever see the key.
 */
export const metadataSchema = z
  .object({
    name: z.string().optional(),
    description: z.string().optional(),
    task_description: z.string().optional(),
    model: z.string().optional(),
    agent: z.string().optional(),
  })
  .loose();

/**
 * The top-level argument allow-list (issue #419). Before this schema existed the tool passed a
 * raw zod SHAPE to `server.tool()`, which the SDK wraps in a default-mode `z.object` — STRIP —
 * so an unknown top-level key (`workflow_id`, the one an agent most plausibly invents) died
 * inside the SDK before the handler ran: `warnings: []`, a workflow registered under a minted id
 * the caller never saw, and a follow-up `start_run` with the self-chosen id failing
 * `STATE_WORKFLOW_NOT_FOUND` with no hint anywhere. The per-step sweep (#169) only ever worked
 * because `stepSchema` is `.loose()`; this is the same fix one level up.
 */
export const createWorkflowArgsSchema = z
  .object({
    steps: z.array(stepSchema).min(1).max(MAX_WORKFLOW_STEPS),
    metadata: metadataSchema.optional(),
    // Declared so a submitted value is NOT silently stripped by the schema — validateArgs
    // rejects it with an actionable "register-time, operator-only" error (mirrors the
    // per-step agent_profile rejection).
    extensions: z.unknown().optional(),
  })
  .loose();

export interface CreateWorkflowStep {
  id: string;
  description: string;
  depends_on?: string[];
  input_schema?: Record<string, unknown>;
  llm_timeout_seconds?: number;
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

function makeErrorEnvelope(errors: string[]): McpEnvelope {
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
 * #872 (b1): one fault in `create_workflow`'s input — the rule it breaks (one per message template:
 * R1–R17, the push sites below), the step it is about (none for a whole-workflow rule), its words.
 * Correction 1 (C4): `key` — what makes two faults the same: the rule, and the message its push site
 * writes for one fixed sentinel id ({@link FAULT_SENTINEL}) — so only the places where the producer
 * itself writes the step id are masked, never a literal that happens to equal an id.
 */
export interface ArgsFault {
  rule: string;
  step?: string;
  message: string;
  key: string;
}

/** C4: the id a fault's words are written for to build its group key (never a step id: a NUL). */
const FAULT_SENTINEL = '\u0000';

/** C4: the joined refusal lines stay at or under this many characters before the closing line. */
export const FAULT_LINES_CAP = 8_000;

/** C4: a fault, its message the push site's words for its step, its key those words for the sentinel. */
export function argsFault(
  rule: string,
  step: string | undefined,
  words: (id: string) => string,
): ArgsFault {
  return {
    rule,
    ...(step !== undefined ? { step } : {}),
    message: words(step ?? ''),
    key: `${rule}\u0000${words(FAULT_SENTINEL)}`,
  };
}

/**
 * #872 (b1): the refusal's lines. Correction 1 (C4): faults share a line only when they are the
 * same ({@link ArgsFault}'s `key`): the first fault's message, then `(also 'b', 'c' and k more)` —
 * the group's OTHER steps, each named once, two shown, then the exact count (core's one producer of
 * a bounded list in words). Lines in first-fault order; the first always, then each further one
 * while the joined lines stay at or under {@link FAULT_LINES_CAP}; every fault left goes into one
 * closing line — how many, and on which steps (three named, then how many more; a fault with no
 * step is on `the workflow`).
 */
export function groupedFaultLines(faults: readonly ArgsFault[]): string[] {
  const groups = new Map<string, ArgsFault[]>();
  for (const fault of faults) {
    const group = groups.get(fault.key);
    if (group === undefined) groups.set(fault.key, [fault]);
    else group.push(fault);
  }
  const lineOf = ([first, ...rest]: readonly ArgsFault[]): string => {
    const others = [
      ...new Set(rest.map((fault) => fault.step ?? '').filter((id) => id !== first!.step)),
    ];
    return others.length === 0
      ? first!.message
      : `${first!.message} (also ${quotedNames(others, 2)})`;
  };
  const ordered = [...groups.values()];
  const lines: string[] = [];
  let joined = -1;
  let shown = 0;
  for (const group of ordered) {
    const line = lineOf(group);
    if (lines.length > 0 && joined + 1 + line.length > FAULT_LINES_CAP) break;
    lines.push(line);
    joined += 1 + line.length;
    shown += 1;
  }
  if (shown === ordered.length) return lines;
  const leftKeys = new Set(ordered.slice(shown).map((group) => group[0]!.key));
  const left = faults.filter((fault) => leftKeys.has(fault.key));
  const names = [
    ...new Set(
      left.map((fault) => (fault.step === undefined ? 'the workflow' : `'${capText(fault.step)}'`)),
    ),
  ];
  lines.push(
    `and ${left.length} more ${left.length === 1 ? 'fault' : 'faults'} on ${listWords(names, 3)} — fix the faults above, then submit again.`,
  );
  return lines;
}

/**
 * Validates all submitted steps. Returns the faults found (empty = valid), each with its rule and
 * step (#872 (b1): the caller renders one line per rule), AND structured_output caveat lines (issue
 * #236) — render-only, never a WarningCode, threaded into the success envelope's `warnings` array by
 * the caller.
 */
function validateArgs(args: CreateWorkflowArgs): { faults: ArgsFault[]; caveats: string[] } {
  const faults: ArgsFault[] = [];
  const caveats: string[] = [];
  // Correction 1 (C4): each push site passes its words as a function of the step id.
  const fault = (rule: string, step: string | undefined, words: (id: string) => string): void => {
    faults.push(argsFault(rule, step, words));
  };

  if (args.steps.length === 0) {
    fault('R1', undefined, () => 'steps must contain at least one step');
    return { faults, caveats };
  }

  // issue #236: the gate reject joins THIS error path — PRE-register (validateArgs runs before
  // handleCreateWorkflow's own `errors.length > 0` early-return, well before register()/
  // start_run() fire) — an ineligible step never reaches a live registered workflow or run.
  for (const step of args.steps) {
    // issue #586 — create_workflow's OWN admission door. FIRST in the loop body, ABOVE the
    // `structured_output !== 'strict'` early-`continue` below: a malformed `input_schema` is fatal
    // for every step kind, not only for strict ones, and `continue` here is what keeps the
    // eligibility walk from reading a block the compile already refused.
    // (#554 — making this tool call the loader for everything else — stays #554's.)
    if (step.input_schema !== undefined) {
      try {
        compileSchema(step.input_schema);
      } catch (err) {
        // A root `$async`: refused in its own clauses, as the loader refuses it.
        if (isAsyncSchemaRefusal(err)) {
          const validity = asyncSchemaValidity(
            (step.input_schema as Record<string, unknown>)['$async'],
          );
          fault(
            'R2',
            step.id,
            (id) =>
              `Step '${id}': 'input_schema' declares ${validity}. ` +
              `${SCHEMA_KEY_CONSEQUENCE.input_schema}; remove \`$async\` from the schema.`,
          );
          continue;
        }
        const msg = err instanceof Error ? err.message : String(err);
        const strict = isStrictModeRefusal(msg);
        // The meta-schema class gets realm's own sentence and remedy (walk #13), as the loader
        // mints; the strict class keeps the validator's words here (this door is #554's).
        const failure = strict ? undefined : describeSchemaFailure(step.input_schema);
        const composed =
          failure === undefined
            ? undefined
            : composeSchemaFailure(failure, 'input_schema', step.input_schema);
        fault(
          'R3',
          step.id,
          (id) =>
            `Step '${id}': 'input_schema' ${strict ? "is refused by realm's validator" : 'is not a valid JSON Schema'} — ` +
            `${composed?.detail ?? msg}. ${SCHEMA_KEY_CONSEQUENCE.input_schema}; ` +
            `${composed?.remedy ?? 'fix the schema'}.`,
        );
        continue;
      }
    }
    if (step.structured_output !== 'strict') continue;
    const verdict = assessStructuredOutputEligibility({
      schema: step.input_schema,
      tools: false, // create_workflow's dynamic steps never declare tools (no such field exists)
    });
    if (verdict.verdict === 'ineligible') {
      fault(
        'R4',
        step.id,
        (id) =>
          `Step '${id}': 'structured_output: strict' is not eligible for this step's ` +
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
      fault(
        'R5',
        step.id,
        (id) =>
          `Step '${id}': agent_profile is not supported on dynamically-created workflows. Use realm register with a YAML workflow file for profile-based execution.`,
      );
    }
  }

  // Rule 8: extensions are not supported on dynamic workflows (register-time, operator-only).
  if ('extensions' in (args as unknown as Record<string, unknown>)) {
    fault(
      'R6',
      undefined,
      () =>
        `extensions is not supported on dynamically-created workflows. Project extensions are register-time and operator-only: declare them in workflow.yaml and register with realm workflow register.`,
    );
  }
  for (const step of args.steps) {
    if ('extensions' in (step as unknown as Record<string, unknown>)) {
      fault(
        'R7',
        step.id,
        (id) =>
          `Step '${id}': extensions is not supported on dynamically-created workflows. Project extensions are register-time and operator-only: declare them in workflow.yaml and register with realm workflow register.`,
      );
    }
  }

  // Rule 2: step IDs must be unique.
  const seenIds = new Set<string>();
  for (const step of args.steps) {
    if (seenIds.has(step.id)) {
      fault('R8', step.id, (id) => `Duplicate step id: '${id}'`);
    }
    seenIds.add(step.id);
  }

  // Rule 3: step IDs must be non-empty with no spaces.
  for (const step of args.steps) {
    if (step.id.trim() === '' || step.id.includes(' ')) {
      fault(
        'R9',
        step.id,
        (id) => `Step id '${id}' is invalid: must be a non-empty string with no spaces`,
      );
    }
  }

  // Rule 3b (issue #220 §4c): reserved step ids — a PRE-EXISTING GAP fixed in the same edit that
  // reserves `$settlement` (the PR ordering interlock: the namespace ships in a later PR, but the
  // reservation must ship NOW, else the inter-PR gap can register a `$settlement`-named step that
  // becomes load-refused the instant the mint ships). `run`/`context` mirror the YAML loader's own
  // reservation (yaml-loader.ts) — create_workflow never enforced these two at all before this fix.
  for (const step of args.steps) {
    if (step.id === 'run' || step.id === 'context' || step.id === '$settlement') {
      fault(
        'R10',
        step.id,
        (id) => `Step id '${id}' is reserved and cannot be used as a step identifier`,
      );
    }
  }

  // Rule 4: descriptions must be non-empty.
  for (const step of args.steps) {
    if (step.description.trim() === '') {
      fault('R11', step.id, (id) => `Step '${id}': description must be non-empty`);
    }
  }

  // Rule 5: llm_timeout_seconds must be a positive integer if present (issue #412 — the same
  // convention the loader applies to the key on a file-authored agent step).
  for (const step of args.steps) {
    if (step.llm_timeout_seconds !== undefined) {
      if (!Number.isInteger(step.llm_timeout_seconds) || step.llm_timeout_seconds <= 0) {
        fault(
          'R12',
          step.id,
          (id) => `Step '${id}': llm_timeout_seconds must be a positive integer`,
        );
      }
    }
  }

  // Rule 6: depends_on validation.
  const allIds = new Set(args.steps.map((s) => s.id));
  const stepPositions = new Map<string, number>();
  args.steps.forEach((s, i) => stepPositions.set(s.id, i));

  // The zod 4 unit, R3: one line per step. The door runs steps in list order (see
  // MAX_CREATE_WORKFLOW_PREDECESSORS), so the only name it can honour is the step just before; any
  // other is refused with the rewrite, never re-wired in silence.
  args.steps.forEach((step, myPos) => {
    if (step.depends_on === undefined || step.depends_on.length === 0) return;
    if (step.depends_on.length > 1) {
      // Unreachable through the door (the schema's `.max`); kept for direct callers.
      fault(
        'R13',
        step.id,
        (id) =>
          `Step '${id}': depends_on supports at most one predecessor — the step just before it (create_workflow runs steps in list order)`,
      );
      return;
    }
    const ref = step.depends_on[0]!;
    if (myPos === 0) {
      fault(
        'R14',
        step.id,
        (id) => `Step '${id}' is the first step; nothing runs before it — leave depends_on out.`,
      );
      return;
    }
    if (!allIds.has(ref)) {
      fault('R15', step.id, (id) => `Step '${id}': depends_on references unknown step '${ref}'`);
      return;
    }
    const refPos = stepPositions.get(ref)!;
    if (refPos >= myPos) {
      fault(
        'R16',
        step.id,
        (id) => `Step '${id}': depends_on must reference a step that appears earlier in the list`,
      );
      return;
    }
    const previous = args.steps[myPos - 1]!.id;
    if (ref !== previous) {
      fault(
        'R17',
        step.id,
        (id) =>
          `Step '${id}': depends_on names '${ref}', but steps run in list order, so '${id}' runs right after '${previous}'. Name '${previous}', leave depends_on out, or move '${id}' to just below '${ref}'.`,
      );
    }
  });

  return { faults, caveats };
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
    // issue #412: MUST copy — buildWorkflowDefinition copies an explicit field list (never a
    // spread), so omitting this line would advertise a bound in the tool description, accept it,
    // and register a step that carries none: exactly the silently-inert authored bound this PR
    // exists to remove, resurrected on the new key.
    if (step.llm_timeout_seconds !== undefined) {
      stepDef.llm_timeout_seconds = step.llm_timeout_seconds;
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
): Promise<McpEnvelope> {
  assertToolStores(stores, 'handleCreateWorkflow');
  const { faults, caveats: structuredOutputCaveats } = validateArgs(args);
  if (faults.length > 0) {
    // #872 (b1): one line per rule — every fault class at once, its size no longer the step count.
    return makeErrorEnvelope(groupedFaultLines(faults));
  }
  // The zod 4 unit, R2 (O2): before the id is derived and anything stored — a non-finite number in
  // a step's input_schema is refused; an integer beyond 2^53−1 draws a warning.
  let numberWarnings: string[];
  try {
    numberWarnings = checkArgsNumbersJoined(
      args.steps.map((step, i) => [`steps[${i}].input_schema`, step.input_schema] as const),
    );
  } catch (err) {
    if (err instanceof ArgsNumbersRefusal) return makeErrorEnvelope([...err.errors]);
    throw err;
  }

  const workflowStore = stores?.workflowStore ?? new JsonWorkflowStore();
  // Build the definition body first (with a placeholder id that is excluded from the hash).
  const definitionBody = buildWorkflowDefinition('__placeholder__', args);
  // Hash all content except the id to derive a stable, deterministic id.
  const { id: _placeholderId, ...definitionWithoutId } = definitionBody;
  const workflowId = deriveWorkflowId(args.metadata?.name, definitionWithoutId);
  const definition: WorkflowDefinition = { ...definitionBody, id: workflowId };

  await workflowStore.register(definition);

  // Issue #419 — the TOP-LEVEL sweep. Unknown keys survive to here now that
  // `createWorkflowArgsSchema` is `.loose()`; before, the SDK stripped them before this
  // function ran and there was nothing to find. Same code as the step sweep
  // (UNKNOWN_CREATE_WORKFLOW_KEY), so #170 never flips it and create_workflow stays lenient for
  // agents forever — this only ever warns, never rejects.
  //
  // INVARIANT: an unknown key can never leak into the registered definition.
  // `buildWorkflowDefinition` copies an explicit field list and never spreads, so a key the sweep
  // reports is a key that was dropped — the warning and the drop cannot come apart.
  //
  // The one unknown key that can never be warned about is `__proto__`: zod drops it before the
  // handler runs. The prototype is untouched (no pollution) and the silence is structural, not a
  // gap this sweep could close.
  const topLevelDiagnostics: LoaderWarning[] = findUnknownKeys(
    args as unknown as Record<string, unknown>,
    Object.keys(createWorkflowArgsSchema.shape),
    {
      scope: 'workflow',
      id: workflowId,
      code: 'UNKNOWN_CREATE_WORKFLOW_KEY',
      // The `noun` override (the UNKNOWN_RETRY_KEY precedent) — "not a recognized create_workflow
      // field", never "workflow field": the latter is the loader's definition-key vocabulary and
      // would send an agent looking at YAML fields that have nothing to do with this tool.
      noun: 'create_workflow',
    },
  ).map((w) => {
    // TARGETED messages, the same `.map()` shape the step sweep below uses for its two cases.
    if (w.key === 'workflow_id') {
      return {
        ...w,
        message: `workflow '${workflowId}': 'workflow_id' is ignored — create_workflow mints its own workflow id and returns it as data.workflow_id; a start_run with a self-chosen id fails STATE_WORKFLOW_NOT_FOUND. To influence the id's slug, set metadata.name.`,
      };
    }
    // Derived membership, no hand list: these are the tool's OWN accepted fields, submitted one
    // level too high. "Not a recognized field" would be true and useless — the field IS
    // recognized, just not there.
    if (Object.keys(metadataSchema.shape).includes(w.key ?? '')) {
      return {
        ...w,
        message: `workflow '${workflowId}': '${w.key}' belongs under metadata — submitted at the top level it is ignored; use metadata.${w.key}.`,
      };
    }
    return w;
  });

  // Issue #419 — the METADATA sweep (the second silent surface: a nested plain object strips
  // independently of its loose parent, so `metadata.author` used to vanish without a word).
  const metadataDiagnostics: LoaderWarning[] =
    args.metadata === undefined
      ? []
      : findUnknownKeys(
          args.metadata as unknown as Record<string, unknown>,
          Object.keys(metadataSchema.shape),
          {
            scope: 'workflow',
            id: workflowId,
            code: 'UNKNOWN_CREATE_WORKFLOW_KEY',
            noun: 'metadata',
          },
        );

  // Issue #169: each raw submitted step's extra keys survive stepSchema's .loose() — find
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
    .map((w) => {
      // issue #220 §3b [P-S6] and issue #412 both need a TARGETED message: the generic "not a
      // recognized field" text teaches nothing, and did-you-mean cannot bridge the distance from
      // `timeout_seconds` to `llm_timeout_seconds`. Every other unknown key keeps the generic form.
      if (w.key === 'validation_exhaustion') {
        return {
          ...w,
          message: `Step '${w.step}': 'validation_exhaustion' is register-time only — dynamic workflows use the default exhaustion posture.`,
        };
      }
      if (w.key === 'timeout_seconds') {
        // Deliberately NO structured `did_you_mean`: a blind `timeout_seconds` →
        // `llm_timeout_seconds` substitution would CHANGE semantics (a whole-step wish becomes a
        // per-attempt model-request bound), and an agent applying a suggestion mechanically would
        // author a different intent than the one it had. The replacement is named in prose so a
        // human decides.
        return {
          ...w,
          message: `step '${w.step}': 'timeout_seconds' was removed (#412) — nothing enforces it on agent steps; the model-request bound is 'llm_timeout_seconds'.`,
        };
      }
      return w;
    });

  // The zod 4 unit's reply bounds (M1, M1′): the three sweeps' finds, joined in sweep order
  // (top-level, metadata, the steps in order), are shown once — ten named, then the count — so a
  // call with 40,000 unknown keys is answered in kilobytes, not 17 MB. `diagnostics`, the structured
  // twin, carries the same first ten entries; the count is in `warnings`.
  const ignored = [...topLevelDiagnostics, ...metadataDiagnostics, ...stepDiagnostics];

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
    // Order is outermost-first (top-level, then metadata, then step) because that reads the way
    // the payload nests. It is presentation only — nothing keys on the order across groups.
    warnings: [
      ...result.warnings,
      ...boundedLines(ignored, renderLoaderWarning, moreUnknownKeys),
      ...structuredOutputCaveats,
      ...numberWarnings,
    ],
    diagnostics: [...(result.diagnostics ?? []), ...ignored.slice(0, MAX_PLACE_LINES)],
  };
}

/** Registers the create_workflow MCP tool on the server. */
export function registerCreateWorkflow(
  server: McpServer,
  opts?: HandleRunStores & WithDoorDisclosure,
): void {
  const door = disclosureOfTool(opts);
  // issue #419 — this was the repo's FIRST `registerTool` user (#627 W moved every other tool to it,
  // for their annotations); the deviation was forced rather than stylistic. `server.tool()` accepts a
  // raw shape only: handed a full `z.object` it throws ("expected a Zod schema or
  // ToolAnnotations, but received an unrecognized object"), and a raw shape is exactly what the
  // SDK wraps in a stripping `z.object`. Carrying `.loose()` to the handler therefore
  // requires `registerTool`, which takes the schema as given.
  //
  // Second consequence, also intended: `tools/list` now advertises `additionalProperties: {}` (zod 4:
  // an empty schema, any value permitted; zod 3 wrote `true`) at the top level and under `metadata`.
  // It read `false` before while the server accepted the key and dropped it — an advertised
  // falsehood. The server was always lenient (#169); the advertisement now says so.
  server.registerTool(
    'create_workflow',
    {
      ...toolMeta('create_workflow'),
      description:
        'Create a dynamic Realm workflow at runtime and immediately start a run. Use this when you have a multi-step task and want to track your own execution plan. Returns next_action pointing at your first step — proceed with execute_step as normal. Top-level fields: steps, metadata, and extensions (extensions is register-time, operator-only, and rejected here); any other field is dropped and returned as a warning.',
      inputSchema: boundedRefusal(createWorkflowArgsSchema),
    },
    safeTool(
      async (args) => {
        const result = await handleCreateWorkflow(args as CreateWorkflowArgs, opts);
        return toolContentOf(
          { ...result, command: 'create_workflow' },
          {
            set: await setForSubject(
              door,
              await replySubject(opts, { runId: result.run_id === '' ? undefined : result.run_id }),
            ),
            audience: 'agent',
            table: MCP_ENVELOPE_TABLE,
          },
        );
      },
      async (err) => {
        const agentAction =
          err instanceof WorkflowError ? resolvePreExecutionAgentAction(err) : 'report_to_user';
        const message = err instanceof Error ? err.message : String(err);
        return toolContentOf(
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
          {
            set: await setForSubject(door, await replySubject(opts, {})),
            audience: 'agent',
            table: MCP_ENVELOPE_TABLE,
          },
        );
      },
      SAFE_TOOL_CONSTANT_RUNLESS,
    ),
  );
}
