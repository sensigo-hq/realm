// run-state-schema.ts — Q1 (#592) unit d2a: what `get_run_state` replies, as one zod tree built from
// the engine's word lists. `scripts/generate-run-state-schema.mjs` renders it to
// `docs/reference/mcp/run-state.schema.json` and writes `run-state.added-after.json`; the ok arm is
// the object a later unit registers as the tool's output schema. Nothing here is on the wire yet,
// and no entry re-exports this module.
//
// Every list is open (`openWord`: its words, or any other string); every object is a `looseObject`
// (a key it does not know is accepted); a union of object variants is ONE object, its keys merged; a
// one-word field is that word or any other string. A number or true/false the door shows as its shape
// when it withholds values (`withholdable`) also admits a string.
import { z } from 'zod';
import {
  ACCOUNT_ABSENT_CAUSES,
  ACTOR_ABSENT_CAUSES,
  CACHE_AUTO_BASES,
  CACHE_AUTO_PRICE_CAUSES,
  CACHE_AUTO_PRICE_EXCLUSIONS,
  CACHE_AUTO_PRICES_FROM_WORDS,
  CACHE_AUTO_RATES,
  CACHE_CONTROL_FIELDS,
  CACHE_CONTROLS_PROVEN_WORDS,
  CACHE_DIAGNOSTICS_WORDS,
  CACHE_LIFETIME_SOURCES,
  CACHE_MARKED_PARTS,
  CACHE_MISS_CAUSES,
  CACHE_MISS_RULES,
  CACHE_MISS_TYPES,
  CACHE_REFERENCE_SOURCES,
  CACHE_REQUEST_SOURCES,
  CACHE_REQUESTS,
  EXHAUSTED_BY,
  MODEL_ATTEMPT_THEN_WORDS,
  MODEL_FAILURE_KINDS,
  NOT_PRICED_CAUSES,
  PREDECESSOR_FROM_WORDS,
  PRICE_SOURCE_CLASSES,
  PROVIDER_MISS_REASONS,
  REQUEST_ENDPOINTS,
  REQUEST_FACT_ABSENT_CAUSES,
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
 * A number or true/false under a field the reply's disclosure table marks `bounded` (`steps`,
 * `drive_failure_costs[].cost`): when
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

/** The paths the file describes loosely, as the sidecar's `described_loosely` names them: none. */
export const RUN_STATE_DESCRIBED_LOOSELY = [] as const;

/** The release the first publication stamps on every field and word ("added after 0.50.0"). */
export const RUN_STATE_FIRST_PUBLISHED = '0.50.0';

/**
 * Fields and words added AFTER the first publication, with the release each arrived after; the
 * script merges them into the sidecar. A path is the sidecar's (dotted keys, `[]`, `.*`).
 */
export const RUN_STATE_ADDED_AFTER: Record<
  'ok' | 'refusal',
  { fields: Record<string, string>; words: Record<string, Record<string, string>> }
> = {
  // #625 named keys unit 2: the code of a call outside the caller's limits.
  ok: { fields: {}, words: { 'basis.enactor.error_code': { CALL_OUTSIDE_LIMITS: '0.50.0' } } },
  refusal: { fields: {}, words: { error_code: { CALL_OUTSIDE_LIMITS: '0.50.0' } } },
};

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

// ─── The cost view (d2b) ────────────────────────────────────────────────────────────────────────
// Under `steps` and `drive_failure_costs[].cost` the door shows a withheld value as its shape, so
// those shapes are built with `shaped` true; `run_cost` and a drive failure's `usage` and
// `model_attempts` are facts.

/** A number or a true/false of the cost view, as it arrives under a shaped or a plain root. */
const num = (shaped: boolean) => (shaped ? withholdable(z.number()) : z.number());
const bool = (shaped: boolean) => (shaped ? withholdable(z.boolean()) : z.boolean());

/** `CostFigure`: a token count, how many requests reported it, of how many. */
const costFigure = z.looseObject({
  value: num(true),
  reported: num(true),
  of: num(true),
  only_request_index: num(true).optional(),
});

/** `CacheAuto`: the basis of the `auto` cache choice, the gaps it read, where its prices came from. */
const cacheAutoOf = (shaped: boolean) =>
  z.looseObject({
    basis: openWord(CACHE_AUTO_BASES),
    gaps_s: z.array(num(shaped)).optional(),
    prices: z
      .looseObject({
        from: openWord(CACHE_AUTO_PRICES_FROM_WORDS),
        excluded: z.array(openWord(CACHE_AUTO_PRICE_EXCLUSIONS)).optional(),
        missing: z.array(openWord(CACHE_AUTO_RATES)).optional(),
        cause: openWord(CACHE_AUTO_PRICE_CAUSES).optional(),
      })
      .optional(),
  });

/** `Money`: what the requests cost, priced at read, with the sources that priced them. */
const moneyOf = (shaped: boolean) => {
  const source = {
    source_class: openWord(PRICE_SOURCE_CLASSES),
    source_ref: z.string(),
    version: z.string().optional(),
  };
  return z.looseObject({
    total: num(shaped),
    uncached_counterfactual: num(shaped),
    net: num(shaped),
    priced: num(shaped),
    of: num(shaped),
    dated: num(shaped),
    sources: z.array(
      z.looseObject({
        ...source,
        matched_provider: z.string().optional(),
        matched_model: z.string(),
        count: num(shaped),
        dated: num(shaped),
        endpoint_note: z.string().optional(),
        source_note: z.string().optional(),
      }),
    ),
    source_totals: z.array(z.looseObject({ ...source, count: num(shaped), dated: num(shaped) })),
    not_priced: z
      .array(
        z.looseObject({
          cause: openWord(NOT_PRICED_CAUSES),
          count: num(shaped),
          detail: z.string().optional(),
        }),
      )
      .optional(),
  });
};
const moneyShaped = moneyOf(true);

/** A count with how many requests reported it, or why none did (`models`, `cache_requested`, …). */
const reportedOf = {
  reported: num(true).optional(),
  of: num(true).optional(),
  absent_cause: openWord(REQUEST_FACT_ABSENT_CAUSES).optional(),
};

/** `CostView`: one attempt's (or one failed drive's) model-call cost. */
const costView = z.looseObject({
  requests: num(true),
  basis: z.string().optional(),
  state: z.string().optional(),
  prompt: costFigure.optional(),
  uncached_input: costFigure.optional(),
  cache_read: costFigure.optional(),
  cache_write: costFigure.optional(),
  output: costFigure.optional(),
  models: z.looseObject({ names: z.array(z.string()).optional(), ...reportedOf }).optional(),
  cache_requested: z
    .looseObject({
      entries: z
        .array(
          z.looseObject({
            value: z.string(),
            lifetime_s: num(true).optional(),
            ttl_sent: bool(true).optional(),
            source: z.string().optional(),
            by: z.string().optional(),
            auto: cacheAutoOf(true).optional(),
            key_sent: bool(true).optional(),
            provider: z.string().optional(),
          }),
        )
        .optional(),
      ...reportedOf,
    })
    .optional(),
  cache_write_5m: costFigure.optional(),
  cache_write_1h: costFigure.optional(),
  endpoints: z
    .looseObject({
      custom: num(true).optional(),
      of: num(true).optional(),
      absent_cause: openWord(REQUEST_FACT_ABSENT_CAUSES).optional(),
    })
    .optional(),
  cache_head: z
    .looseObject({
      entries: z.array(
        z.looseObject({
          chars: num(true),
          marked: z.array(openWord(CACHE_MARKED_PARTS)).optional(),
        }),
      ),
    })
    .optional(),
  cache_fields_refused: z.looseObject({ refused: num(true), of: num(true) }).optional(),
  money: moneyShaped.optional(),
  misses: z
    .array(
      z.looseObject({
        position: num(true),
        derived: z.looseObject({
          cause: openWord(CACHE_MISS_CAUSES),
          rule: openWord(CACHE_MISS_RULES),
          expected_tokens: num(true),
          shortfall_tokens: num(true),
          predecessor: z.looseObject({
            from: openWord(PREDECESSOR_FROM_WORDS),
            at: num(true).optional(),
          }),
          gap_s: num(true).optional(),
          lifetime_s: num(true).optional(),
          lifetime_from: openWord(CACHE_LIFETIME_SOURCES).optional(),
        }),
        provider: z
          .looseObject({
            reason: openWord(PROVIDER_MISS_REASONS),
            cache_missed_input_tokens: num(true).optional(),
          })
          .optional(),
        extra_usd: num(true).optional(),
      }),
    )
    .optional(),
});

/** `RunCost`: what the run cost, priced at read. */
const runCost = z.looseObject({
  total: moneyOf(false),
  failed_drives_not_on_record: z.number(),
  failed_drives_without_usage: z.number(),
  unmeasured: z.looseObject({
    tool_calling_step: z.number(),
    not_measured_by_realm: z.number(),
    cost_unreadable: z.number(),
  }),
});

const cacheAuto = cacheAutoOf(false);
const cacheCreation = z.looseObject({
  ephemeral_5m_input_tokens: z.number().optional(),
  ephemeral_1h_input_tokens: z.number().optional(),
});
const prefixParts = z.looseObject({
  tools: z.string().optional(),
  system: z.string(),
  prompt: z.string().optional(),
  format: z.string().optional(),
});

/** The request facts a drive failure's usage entry and its cache reference share. */
const requestFacts = {
  request_start: z.string(),
  provider: z.string().optional(),
  request_id: z.string().optional(),
  model: z.string().optional(),
  endpoint: openWord(REQUEST_ENDPOINTS).optional(),
  cache_requested: openWord(CACHE_REQUESTS).optional(),
  cache_read_input_tokens: z.number().optional(),
  cache_creation_input_tokens: z.number().optional(),
  cache_write_tokens: z.number().optional(),
  cache_creation: cacheCreation.optional(),
  cache_lifetime_s: z.number().optional(),
  cache_ttl_sent: z.boolean().optional(),
  cache_auto: cacheAuto.optional(),
  prefix_chars: z.number().optional(),
  prefix_parts: prefixParts.optional(),
  cache_marked: z.array(openWord(CACHE_MARKED_PARTS)).optional(),
  request_strict_sent: z.boolean().optional(),
};

/** `UsageRecord`: one model request of a failed drive, as the drive recorded it. */
const usageRecord = z.looseObject({
  request_index: z.number(),
  ...requestFacts,
  prompt_tokens: z.number().optional(),
  uncached_input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  cache_requested_source: openWord(CACHE_REQUEST_SOURCES).optional(),
  cache_requested_by: z.string().optional(),
  cache_split_offered: z.boolean().optional(),
  response_id: z.string().optional(),
  cache_diagnostics: z
    .looseObject({
      asked: z.boolean(),
      cause: z.literal('rejected').or(z.string()).optional(),
      reference_id: z.string().nullable().optional(),
      result: openWord(CACHE_DIAGNOSTICS_WORDS)
        .or(
          z.looseObject({
            type: openWord(CACHE_MISS_TYPES),
            cache_missed_input_tokens: z.number().optional(),
          }),
        )
        .optional(),
    })
    .optional(),
  request_in_call: z.number().optional(),
  prefix_sha256: z.string().optional(),
  cache_controls_rejected: z
    .looseObject({
      status: z.number(),
      dropped: z.array(z.literal('cache_fields').or(z.string())),
      proven: openWord(CACHE_CONTROLS_PROVEN_WORDS),
      fields: z.array(openWord(CACHE_CONTROL_FIELDS)),
    })
    .optional(),
  cache_key_sent: z.boolean().optional(),
  reference: z
    .looseObject({
      from: openWord(CACHE_REFERENCE_SOURCES),
      ...requestFacts,
      agent_profile_changed: z.boolean().optional(),
    })
    .optional(),
});

/** `ModelAttempt`: one failed model request of a drive, and what followed it. */
const modelAttempt = z.looseObject({
  request: z.number(),
  kind: openWord(MODEL_FAILURE_KINDS).nullable(),
  error_class: openWord(ERROR_CLASSES).nullable(),
  status: z.number().nullable(),
  wait_ms: z.number().nullable(),
  retry_after_ms: z.number().nullable(),
  exhausted_by: openWord(EXHAUSTED_BY).optional(),
  then: openWord(MODEL_ATTEMPT_THEN_WORDS).optional(),
});

const stepView = z.looseObject({
  attempts: z.array(
    z.looseObject({
      attempt: withholdable(z.number()),
      status: z.string(),
      cost: costView.optional(),
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
  total: moneyShaped.optional(),
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
          // A provider module's usage entry that is not an object is kept as recorded (`null` arrives).
          usage: z.array(usageRecord.nullable()).optional(),
          model_attempts: z.array(modelAttempt).optional(),
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
      // Q1 d2c: a question the door withholds arrives as one sentence in place of the map.
      resolution_messages: z
        .record(z.string(), z.string())
        .or(
          z
            .string()
            .describe(
              'One sentence, "withheld (declared values could not be read)" or "withheld (declared values changed)", in place of the messages when Realm withholds values.',
            ),
        )
        .optional(),
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
        cost: costView.optional(),
      }),
    )
    .optional(),
  run_cost: runCost.optional(),
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
      "What Realm's get_run_state MCP tool replies, the run's state or a refusal: every list in it is open and every object accepts a key it does not know.",
    ...body,
  };
}
