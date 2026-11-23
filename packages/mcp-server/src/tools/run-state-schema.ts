// run-state-schema.ts — Q1 (#592) unit d2a: what `get_run_state` replies, as one zod tree built from
// the engine's word lists. `scripts/generate-run-state-schema.mjs` renders it to
// `docs/reference/mcp/run-state.schema.json` and writes `run-state.added-after.json`; the ok arm is
// the object a later unit registers as the tool's output schema. Nothing here is on the wire yet,
// and no entry re-exports this module.
//
// Every list is open (`openWord`: its words, or any other string); every object is a `looseObject`
// (a key it does not know is accepted); a union of object variants is ONE object, its keys merged; a
// one-word field is that word or any other string. The cost view is a loose placeholder until d2b.
import { z } from 'zod';
import {
  ACCOUNT_ABSENT_CAUSES,
  ACTOR_ABSENT_CAUSES,
  ADMITTED_BY_ABSENT_CAUSES,
  ADMITTED_BY_WORDS,
  AGENT_ACTIONS,
  BLOCKING_DEP_STATES,
  BY_SOURCE_CLASSES,
  CAPABILITY_BASES,
  CLAIM_PROOF_ABSENT_CAUSES,
  CLAIM_STATES,
  COST_UNRECORDED_CAUSES,
  DECLARED_CAUSES,
  DECLARED_STATES,
  DEFINITION_ABSENCES,
  DISCLOSURE_QUESTIONS,
  ENACTOR_KINDS,
  ENVIRONMENT_STATES,
  ERROR_CLASSES,
  ERROR_CODES,
  FAILURE_ABSENT_CAUSES,
  FAILURE_UNKNOWN_WORDS,
  GATE_ON_EXPIRY_WORDS,
  GATE_PROOFS,
  GATE_PROOF_CAUSES,
  LOAD_ERROR_CODES,
  NEXT_ACTIONS_STATUS,
  PRE_CLAIM_REFUSALS,
  REQUIREMENT_KINDS,
  RUN_HEALTH_KINDS,
  RUN_PHASES,
  RUN_STATUSES,
  SKIP_KINDS,
  TRIGGER_RULES,
  WAY_VERBS,
  type DisclosureReceipt,
} from '@sensigo/realm';
import { ALSO_VERBS, POLL_REASONS, type McpEnvelope } from '../render-reply.js';
import type { RunStateSummary } from './get-run-state.js';

/** A word list rendered open: one of its words, or any other string (`anyOf: [{enum}, {string}]`). */
function openWord<const T extends readonly [string, ...string[]]>(words: T) {
  return z.enum(words).or(z.string());
}

/**
 * A number or true/false under a field the reply's disclosure table marks `bounded` (`steps`): when
 * the door withholds values (the receipt's `values` is `withheld`) it arrives as its shape, a string
 * such as `‹number›` or `‹boolean›`, so the schema admits a string beside it. The string carries a
 * description so zod renders `anyOf` (a bare `.or(z.string())` folds into `type: [number, string]`,
 * which Ajv in strict mode refuses to load).
 */
function withholdable<T extends z.ZodNumber | z.ZodBoolean>(leaf: T) {
  return leaf.or(
    z.string().describe('Its shape, such as ‹number› or ‹boolean›, when Realm withholds values.'),
  );
}

/** The cost view's placeholders (d2b describes them): an object, and a list. */
const looseMap = z.record(z.string(), z.unknown());
const looseList = z.array(z.unknown());

/** The placeholder paths, as the sidecar's `described_loosely` names them. */
export const RUN_STATE_DESCRIBED_LOOSELY = [
  'drive_failures.entries[].usage',
  'drive_failures.entries[].model_attempts',
  'steps.*.attempts[].cost',
  'steps.*.total',
  'drive_failure_costs[].cost',
  'run_cost',
] as const;

/** The release the first publication stamps on every field and word ("added after 0.50.0"). */
export const RUN_STATE_FIRST_PUBLISHED = '0.50.0';

/**
 * Fields and words added AFTER the first publication, with the release each arrived after; the
 * script merges them into the sidecar. A path is the sidecar's (dotted keys, `[]`, `.*`).
 */
export const RUN_STATE_ADDED_AFTER: Record<
  'ok' | 'refusal',
  { fields: Record<string, string>; words: Record<string, Record<string, string>> }
> = { ok: { fields: {}, words: {} }, refusal: { fields: {}, words: {} } };

const receipt = z.looseObject({
  declared: openWord(DECLARED_STATES),
  declared_cause: openWord(DECLARED_CAUSES).optional(),
  environment: openWord(ENVIRONMENT_STATES),
  environment_cause: z.literal('host_set').or(z.string()).optional(),
  hidden: z.looseObject({ declared: z.number(), environment: z.number(), pattern: z.number() }),
  unchecked: z.number(),
  unmaskable: z.number(),
  too_deep: z.number(),
  question: openWord(DISCLOSURE_QUESTIONS).optional(),
  values: z.literal('withheld').or(z.string()).optional(),
  failure_text: z.literal('withheld').or(z.string()).optional(),
  shaped: z.array(z.string()).optional(),
  members: z.array(z.string()).optional(),
});

const instruction = z.looseObject({
  tool: z.string(),
  params: z.record(z.string(), z.unknown()),
  call_with: z.record(z.string(), z.unknown()),
});

const nextActionShape = {
  instruction: instruction.nullable(),
  awaiting: z
    .looseObject({
      run_id: z.string(),
      gate_id: z.string(),
      step: z.string(),
      choices: z.array(z.string()),
      expires_at: z.string().optional(),
    })
    .optional(),
  human_readable: z.string(),
  orientation: z.string(),
  input_schema: z.record(z.string(), z.unknown()).optional(),
  prompt: z.string().optional(),
  stable_prefix: z
    .looseObject({ chars: z.number(), unit: z.literal('utf16').or(z.string()), sha256: z.string() })
    .optional(),
};
const nextAction = z.looseObject(nextActionShape);

/** A named actor, or why none is named (`Attributed | ActorAbsent`). */
const actor = z.looseObject({
  by: z.string().nullable(),
  by_source: openWord(BY_SOURCE_CLASSES).optional(),
  channel: z.string().optional(),
  absent_cause: openWord(ACTOR_ABSENT_CAUSES).optional(),
});

const requirement = z.looseObject({ kind: openWord(REQUIREMENT_KINDS), name: z.string() });

const engineRunnable = z.looseObject({
  step: z.string(),
  runnable_here: z.boolean().or(z.literal('unknown').or(z.string())),
  refused_by: openWord(PRE_CLAIM_REFUSALS).optional(),
  refusal: z.string().optional(),
  basis: openWord(CAPABILITY_BASES).optional(),
  requirement: requirement.optional(),
  precondition: z.looseObject({ expression: z.string(), value: z.string() }).optional(),
});

const stepView = z.looseObject({
  attempts: z.array(
    z.looseObject({
      attempt: withholdable(z.number()),
      status: z.string(),
      cost: looseMap.optional(),
      cost_unrecorded: openWord(COST_UNRECORDED_CAUSES).optional(),
      cost_unreadable: withholdable(z.boolean()).optional(),
      driven_by: actor,
    }),
  ),
  answers: z
    .array(
      z.looseObject({
        choice: z.string().optional(),
        answered_by: z.looseObject({
          by: z.string().nullable(),
          absent_cause: openWord(ACTOR_ABSENT_CAUSES).optional(),
          by_source: z.literal('stated').or(z.string()).optional(),
        }),
        at: z.string().optional(),
        claim_proof: z
          .looseObject({
            proof: openWord(GATE_PROOFS),
            cause: openWord(GATE_PROOF_CAUSES).optional(),
          })
          .optional(),
        claim_proof_absent: openWord(CLAIM_PROOF_ABSENT_CAUSES).optional(),
        account: z.looseObject({ user: z.string(), team: z.string().optional() }).optional(),
        account_absent: openWord(ACCOUNT_ABSENT_CAUSES).optional(),
        admitted_by: openWord(ADMITTED_BY_WORDS).optional(),
        admitted_by_absent: openWord(ADMITTED_BY_ABSENT_CAUSES).optional(),
      }),
    )
    .optional(),
  total: looseMap.optional(),
});

/** The twin: the ok reply as the wire carries it (every object reply leaves with the receipt). */
type Twin = RunStateSummary & { disclosure: DisclosureReceipt };

// eslint-disable-next-line no-restricted-syntax -- the schema describing the reply's `terminal_state`, not a write: it reaches no store (Q1, #592, d2a; the terminal-writer census).
const OK_SHAPE = {
  run_id: z.string(),
  workflow_id: z.string(),
  run_phase: openWord(RUN_PHASES),
  terminal_state: z.boolean(),
  terminal_reason: z.string().optional(),
  rerun_of: z.string().optional(),
  sealed_by_arm: z.string().optional(),
  sealed_by_adjudicated: z
    .looseObject({
      by: z.string(),
      at: z.string(),
      previous_arm: z.string().nullable(),
      reason: z.string().optional(),
    })
    .optional(),
  sealed_by_classified: z.boolean().optional(),
  sealed_by_step: z.string().optional(),
  sealed_by_actor: z
    .looseObject({
      by: z.string().nullable(),
      by_source: openWord(BY_SOURCE_CLASSES).optional(),
      channel: z.string().optional(),
      absent_cause: z.literal('name_unreadable').or(z.string()).optional(),
    })
    .optional(),
  sealed_by_door: z.string().optional(),
  drive_failures: z
    .looseObject({
      first_failed_at: z.string(),
      total: z.number(),
      entries: z.array(
        z.looseObject({
          at: z.string(),
          step: z.string(),
          provider: z.string(),
          error_class: openWord(ERROR_CLASSES),
          message: z.string(),
          evidence_count: z.number().optional(),
          gate_id: z.string().optional(),
          attempts_sdk: z.number().optional(),
          elapsed_ms: z.number(),
          declared_per_attempt_ms: z.number().optional(),
          derived_ceiling_ms: z.number().optional(),
          last_observed_status: z.number().optional(),
          retry_after_observed_ms: z.number().optional(),
          usage: looseList.optional(),
          model_attempts: looseList.optional(),
          usage_more: z.number().optional(),
          attempt: z.number().optional(),
        }),
      ),
    })
    .optional(),
  completed_steps: z.array(z.string()),
  in_progress_steps: z.array(z.string()),
  failed_steps: z.array(z.string()),
  failures: z.array(
    z.looseObject({
      step: z.string(),
      code: z.string().optional(),
      category: z.string().optional(),
      stop_reason: z.string().optional(),
      agent_action: z.string().optional(),
      failure_kind: z.string().optional(),
      attempt: z.number().optional(),
      message: z.string().optional(),
      unknown: z.array(openWord(FAILURE_UNKNOWN_WORDS)).optional(),
      absent: openWord(FAILURE_ABSENT_CAUSES).optional(),
    }),
  ),
  skipped_steps: z.array(z.string()),
  // `PendingGate | undefined`: absent from the text on an ended run and on a run with no question.
  pending_gate: z
    .looseObject({
      gate_id: z.string(),
      step_name: z.string(),
      preview: z.record(z.string(), z.unknown()),
      choices: z.array(z.string()),
      opened_at: z.string(),
      owner: z.string().optional(),
      answerers: z.array(z.string()).optional(),
      resolved_message: z.string().optional(),
      resolution_messages: z.record(z.string(), z.string()).optional(),
      expires_at: z.string().optional(),
      on_expiry: openWord(GATE_ON_EXPIRY_WORDS).optional(),
      default_choice: z.string().optional(),
      reminder_seconds: z.number().optional(),
      reminder_max: z.number().optional(),
    })
    .optional(),
  evidence_count: z.number(),
  last_step: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  params: z.record(z.string(), z.unknown()),
  abort_context: z
    .looseObject({
      step_id: z.string(),
      conditions: z
        .array(
          z.looseObject({
            condition: z.string(),
            resolved_value: z.unknown(),
            passed: z.boolean(),
          }),
        )
        .optional(),
      abort_message: z.string().optional(),
    })
    .optional(),
  next_actions: z.array(nextAction),
  next_actions_status: openWord(NEXT_ACTIONS_STATUS),
  agent_action: openWord(AGENT_ACTIONS).optional(),
  poll_after_ms: z.number().optional(),
  poll_reason: openWord(POLL_REASONS).optional(),
  until: z.string().optional(),
  also: z.array(z.looseObject({ verb: openWord(ALSO_VERBS), ...nextActionShape })).optional(),
  elsewhere: z
    .array(
      z.looseObject({
        verb: openWord(WAY_VERBS),
        step: z.string().optional(),
        instruction: z.null(),
        for: z.literal('operator').or(z.string()),
        reason: z.literal('door_cannot_enact').or(z.string()),
        human_readable: z.string(),
      }),
    )
    .optional(),
  basis: z
    .looseObject({
      enactor: z.looseObject({
        kind: openWord(ENACTOR_KINDS),
        error_code: openWord(LOAD_ERROR_CODES).optional(),
      }),
      store: z.looseObject({ persists_claims: z.boolean() }),
      definition: z.looseObject({
        workflow_id: z.string().optional(),
        absent: openWord(DEFINITION_ABSENCES).optional(),
      }),
      as_of: z.string(),
      run_version: z.number(),
      as_of_basis: z.literal('test_clock').or(z.string()).optional(),
    })
    .optional(),
  stuck_claims: z
    .array(z.looseObject({ step: z.string(), state: openWord(CLAIM_STATES) }))
    .optional(),
  step_claims: z
    .array(z.looseObject({ step: z.string(), holder: actor, since: z.string().optional() }))
    .optional(),
  capability_blocks: z
    .array(z.looseObject({ step: z.string(), requirement, code: z.string() }))
    .optional(),
  skip_details: z
    .record(
      z.string(),
      z.looseObject({
        kind: openWord(SKIP_KINDS),
        expression: z.string().optional(),
        leaves: z
          .array(
            z.looseObject({
              leaf: z.string(),
              lhs_present: z.boolean(),
              resolved_value: z.unknown().optional(),
              passed: z.boolean(),
            }),
          )
          .optional(),
        rule: openWord(TRIGGER_RULES).optional(),
        blocking_deps: z
          .array(z.looseObject({ dep: z.string(), state: openWord(BLOCKING_DEP_STATES) }))
          .optional(),
        gate_id: z.string().optional(),
      }),
    )
    .optional(),
  run_health: z
    .array(
      z.looseObject({
        kind: openWord(RUN_HEALTH_KINDS),
        step: z.string().optional(),
        reason: z.string(),
        since: z.string().optional(),
        idle_ms: z.number().optional(),
        evidence: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .optional(),
  defaulted_steps: z.array(z.string()).optional(),
  warnings: z.array(z.string()).optional(),
  steps: z.record(z.string(), stepView).optional(),
  steps_more: z.number().optional(),
  next_cursor: z.string().optional(),
  skip_details_more: z.number().optional(),
  engine_runnable_more: z.number().optional(),
  agent_refused_more: z.number().optional(),
  capability_blocks_more: z.number().optional(),
  next_actions_more: z.number().optional(),
  defaulted_steps_more: z.number().optional(),
  skipped_steps_more: z.number().optional(),
  completed_steps_more: z.number().optional(),
  waiting_on_answer_more: z.number().optional(),
  pending_guards_more: z.number().optional(),
  step_claims_more: z.number().optional(),
  stuck_claims_more: z.number().optional(),
  in_progress_steps_more: z.number().optional(),
  failures_more: z.number().optional(),
  failed_steps_more: z.number().optional(),
  // A count per finding kind the ceiling left out: one key per word of the list.
  run_health_more: z
    .looseObject(Object.fromEntries(RUN_HEALTH_KINDS.map((k) => [k, z.number().optional()])))
    .optional(),
  drive_failure_costs: z
    .array(
      z.looseObject({
        at: z.string().optional(),
        step: z.string().optional(),
        error_class: z.string().optional(),
        cost: looseMap.optional(),
      }),
    )
    .optional(),
  run_cost: looseMap.optional(),
  pending_guards: z.array(z.string()).optional(),
  engine_runnable: z.array(engineRunnable).optional(),
  agent_refused: z.array(engineRunnable).optional(),
  resumable: z
    .looseObject({
      steps: z.array(z.string()),
      steps_more: z.number().optional(),
      command: z.string(),
    })
    .optional(),
  cleanup_pending: z
    .looseObject({
      steps: z.array(z.string()),
      command: z.string(),
      held_until: z.string().optional(),
    })
    .optional(),
  waiting_on_answer: z.array(z.string()).optional(),
  disclosure: receipt,
} satisfies Record<keyof Twin, z.ZodType>;

/** `get_run_state`'s ok reply: the run's state. */
export const RUN_STATE_OK = z.looseObject(OK_SHAPE);

/** A type with every `[key: string]: unknown` (a loose object's) removed, at every level. */
type Closed<T> = T extends readonly (infer E)[]
  ? readonly Closed<E>[]
  : T extends object
    ? { [K in keyof T as string extends K ? (unknown extends T[K] ? never : K) : K]: Closed<T[K]> }
    : T;
// Every reply the type allows is one the ok arm accepts (exactOptionalPropertyTypes forbids the
// reverse): a field whose zod type no longer admits the reply's type fails the build.
const _twinFits = (twin: Twin): Closed<z.input<typeof RUN_STATE_OK>> => twin;
void _twinFits;

/** `get_run_state`'s refusal: the keys its error path emits, at the shape it emits them. */
export const RUN_STATE_REFUSAL = z.looseObject({
  command: z.string(),
  run_id: z.string(),
  status: openWord(RUN_STATUSES),
  data: z.record(z.string(), z.unknown()),
  evidence: z.array(z.unknown()),
  warnings: z.array(z.string()),
  errors: z.array(z.string()),
  // Present when the thrown error is a WorkflowError; an untyped throw names no code.
  error_code: openWord(ERROR_CODES).optional(),
  error_details: z.record(z.string(), z.unknown()).optional(),
  error: z.looseObject({ about: z.string() }).optional(),
  retry_after: z.number().optional(),
  context_hint: z.string(),
  agent_action: openWord(AGENT_ACTIONS),
  next_actions: z.array(nextAction),
  disclosure: receipt,
} satisfies Partial<Record<keyof McpEnvelope | 'disclosure', z.ZodType>>);

/** The published file: both arms, a title and a description, at draft 2020-12. */
export function runStateSchemaFile(): Record<string, unknown> {
  const { $schema, ...body } = z.toJSONSchema(z.union([RUN_STATE_OK, RUN_STATE_REFUSAL]), {
    io: 'output',
    target: 'draft-2020-12',
  });
  return {
    $schema,
    title: "Realm's get_run_state reply",
    description:
      "What Realm's get_run_state MCP tool replies, the run's state or a refusal: every list in it is open, every object accepts a key it does not know, and the cost view is described loosely until a later release.",
    ...body,
  };
}
