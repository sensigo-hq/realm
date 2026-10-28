// disclosure-tables.ts — #729 PR-3 (RECORD 01 #6; prompt 01 C-3): core's class tables, beside the
// types they describe, and the three door functions that walk by them. Each table is written
// `satisfies Record<keyof T, DisclosureClass>` (per discriminant on a union), so a new field fails the
// compile until it is classified here. The door's own tables (the MCP envelope and the tool results)
// live in the MCP server, beside their types.
import type { Attributed } from '../engine/holder.js';
import type { GateInfo } from '../types/response-envelope.js';
import type { ExtensionIdentityEntry } from '../types/extension-identity.js';
import type {
  CapabilityBlock,
  ClaimRecord,
  DriveFailureRecord,
  DriveFailuresField,
  EvidenceSnapshot,
  PendingGate,
  RunRecord,
  SealedBy,
  SkipDetail,
  StepCacheDetail,
  StepDiagnostics,
  StructuredOutputMeta,
  UsageRecord,
  WorkflowContextSnapshot,
} from '../types/run-record.js';
import type { DisclosureAudience, DisclosureSet } from './redaction.js';
import {
  discloseByTable,
  disclosureReceipt,
  withheldCauseOf,
  type ClassTable,
  type ChosenClass,
  type DisclosureClass,
  type DisclosureReceipt,
  type DisclosureTally,
  type FactProducers,
  type WalkOptions,
  deriveOf,
} from './disclosure-walk.js';

type Row<T> = Record<keyof T, DisclosureClass>;
type Element<T> = T extends readonly (infer E)[] ? E : never;

// ── The gate ──────────────────────────────────────────────────────────────────────────────────

/** A stored gate: the question at the declared tier, the preview as a value, the choices as facts
 *  (they are acts, never masked), the owner as a stated name (a fact, m-b). */
export const PENDING_GATE_TABLE = {
  gate_id: 'fact',
  step_name: 'fact',
  preview: 'value',
  choices: 'fact',
  opened_at: 'fact',
  owner: 'fact',
  resolved_message: 'question',
  resolution_messages: 'question',
  expires_at: 'fact',
  on_expiry: 'fact',
  default_choice: 'fact',
  reminder_seconds: 'fact',
  reminder_max: 'fact',
} as const satisfies Row<PendingGate>;

/** A reply's gate: `display` is the question; `response_spec` is the author's. `agent_hint` is the
 *  step's `instructions` RENDERED with run values (F1), so it is a value. */
export const GATE_INFO_TABLE = {
  gate_id: 'fact',
  step_name: 'fact',
  preview: 'value',
  choices: 'fact',
  display: 'question',
  agent_hint: 'value',
  response_spec: 'fact',
  expires_at: 'fact',
  first_reminder_due_at: 'fact',
} as const satisfies Row<GateInfo>;

// ── The record views (inspect, export) ────────────────────────────────────────────────────────

/** A provider's per-request usage. `model` is a value (the model a provider answered with can be
 *  anything a configuration says); realm agent's own prints, where the requested model is known,
 *  show it (01 #16). */
export const USAGE_RECORD_TABLE = {
  request_index: 'fact',
  request_start: 'fact',
  prompt_tokens: 'fact',
  uncached_input_tokens: 'fact',
  cache_read_input_tokens: 'fact',
  cache_creation_input_tokens: 'fact',
  cache_write_tokens: 'fact',
  output_tokens: 'fact',
  cache_creation: 'fact',
  model: 'value',
  cache_requested: 'fact',
  cache_lifetime_s: 'fact',
  cache_ttl_sent: 'fact',
  cache_requested_source: 'fact',
  cache_requested_by: 'fact',
  cache_auto: 'fact',
  provider: 'fact',
  endpoint: 'fact',
  cache_split_offered: 'fact',
} as const satisfies Row<UsageRecord>;

const STEP_CACHE_TABLE = {
  state: 'fact',
  basis: 'fact',
  requests: { nested: USAGE_RECORD_TABLE },
} as const satisfies Row<StepCacheDetail>;

type ToolArgs = NonNullable<StructuredOutputMeta['tool_args']>;
type DroppedMidAttempt = NonNullable<ToolArgs['dropped_mid_attempt']>;

const DROPPED_MID_ATTEMPT_TABLE = {
  reason: 'fact',
  api_message: 'bounded',
  api_param: 'bounded',
  api_code: 'bounded',
  strict_turns_before_drop: 'fact',
} as const satisfies Row<DroppedMidAttempt>;

const TOOL_ARGS_TABLE = {
  tools: 'fact',
  dropped_mid_attempt: { nested: DROPPED_MID_ATTEMPT_TABLE },
} as const satisfies Row<ToolArgs>;

/** A provider's answer about structured output: its own words are diagnostic copies. */
const STRUCTURED_OUTPUT_TABLE = {
  requested: 'fact',
  sent: 'fact',
  caveats: 'fact',
  downgrade_reason: 'fact',
  api_message: 'bounded',
  api_param: 'bounded',
  api_code: 'bounded',
  provider: 'fact',
  submission_channel: 'fact',
  tool_args: { nested: TOOL_ARGS_TABLE },
} as const satisfies Row<StructuredOutputMeta>;

const PRECONDITION_TRACE_TABLE = {
  expression: 'fact',
  passed: 'fact',
  resolved_value: 'value',
} as const satisfies Row<Element<StepDiagnostics['precondition_trace']>>;

const GUARD_CONDITION_TABLE = {
  condition: 'fact',
  resolved_value: 'value',
  passed: 'fact',
} as const satisfies Row<Element<NonNullable<StepDiagnostics['guard_conditions']>>>;

export const STEP_DIAGNOSTICS_TABLE = {
  input_token_estimate: 'fact',
  precondition_trace: { nested: PRECONDITION_TRACE_TABLE },
  guard_conditions: { nested: GUARD_CONDITION_TABLE },
  validation_rejections: 'fact',
  settled_by_default: 'fact',
  structured_output: { nested: STRUCTURED_OUTPUT_TABLE },
  cache: { nested: STEP_CACHE_TABLE },
} as const satisfies Row<StepDiagnostics>;

const ATTRIBUTED_TABLE = {
  by: 'fact',
  by_source: 'fact',
  channel: 'fact',
} as const satisfies Row<Attributed>;

/** One evidence snapshot: its inputs and outputs are values, its error a diagnostic copy, the gate
 *  message the question it asked. #729 PR-3 correction 4 (I-9): a digest of value content is a value
 *  (`evidence_hash` of the output, `trace_digest` of the trace) — a short value's digest would
 *  confirm a guess; the agent profile FILE's digest is a fact (its content is not in the record). */
export const EVIDENCE_TABLE = {
  step_id: 'fact',
  started_at: 'fact',
  completed_at: 'fact',
  duration_ms: 'fact',
  input_summary: 'value',
  output_summary: 'value',
  status: 'fact',
  error: 'bounded',
  evidence_hash: 'value',
  attempt: 'fact',
  kind: 'fact',
  gate_message: 'question',
  responded_by: 'fact',
  driven_by: { nested: ATTRIBUTED_TABLE },
  output_source: 'fact',
  supplied_by: 'fact',
  claim_proof: 'fact',
  resolution: 'fact',
  diagnostics: { nested: STEP_DIAGNOSTICS_TABLE },
  agent_profile: 'fact',
  agent_profile_hash: 'fact',
  tool_calls: 'value',
  resolved_params: 'value',
  warn: 'bounded',
  debug_output: 'value',
  trace: 'value',
  trace_digest: 'value',
  trace_summary: 'fact',
  effective_timeout_seconds: 'fact',
  clipped_to_ms: 'fact',
  exhausted_by: 'fact',
  // #627 W: how an answer arrived (a door's route id, a renderer's name), whether the client was asked
  // to have its user approve, and what the door's transport authenticated (an API key's id, a kind).
  answer: 'fact',
  client_prompt_requested: 'fact',
  principal: 'fact',
} as const satisfies Row<EvidenceSnapshot>;

/** Correction 4 (I-9b, R43'): the output's digest derives from the output, the trace's from the
 *  trace — each shown as its shape wherever the law hid anything inside what it digests. */
export const EVIDENCE_DERIVED_OF = deriveOf(EVIDENCE_TABLE, {
  evidence_hash: 'output_summary',
  trace_digest: 'trace',
});

type WhenFalse = Extract<SkipDetail, { kind: 'when_false' }>;
const WHEN_FALSE_LEAF_TABLE = {
  leaf: 'fact',
  lhs_present: 'fact',
  resolved_value: 'value',
  passed: 'fact',
} as const satisfies Row<Element<WhenFalse['leaves']>>;

/** One table per `SkipDetail` kind. */
const SKIP_DETAIL_TABLES = {
  when_false: {
    kind: 'fact',
    expression: 'fact',
    leaves: { nested: WHEN_FALSE_LEAF_TABLE },
  } satisfies Row<WhenFalse>,
  trigger_rule_unsatisfiable: {
    kind: 'fact',
    rule: 'fact',
    blocking_deps: 'fact',
  } satisfies Row<Extract<SkipDetail, { kind: 'trigger_rule_unsatisfiable' }>>,
  handler_abort: { kind: 'fact' } satisfies Row<Extract<SkipDetail, { kind: 'handler_abort' }>>,
  guard_abort: { kind: 'fact' } satisfies Row<Extract<SkipDetail, { kind: 'guard_abort' }>>,
  gate_cancelled_by_abort: { kind: 'fact', gate_id: 'fact' } satisfies Row<
    Extract<SkipDetail, { kind: 'gate_cancelled_by_abort' }>
  >,
  gate_expired: { kind: 'fact', gate_id: 'fact' } satisfies Row<
    Extract<SkipDetail, { kind: 'gate_expired' }>
  >,
} as const satisfies Record<SkipDetail['kind'], ClassTable>;

/** An unknown kind (a record from a later release) has no table: every key is walked as a value. */
const UNKNOWN_KIND_TABLE: ClassTable = {};

function skipDetailTable(value: unknown): ClassTable {
  const kind = (value as { kind?: unknown } | null)?.kind;
  return typeof kind === 'string' && Object.hasOwn(SKIP_DETAIL_TABLES, kind)
    ? SKIP_DETAIL_TABLES[kind as SkipDetail['kind']]
    : UNKNOWN_KIND_TABLE;
}

/** A claim: its token is the claim's proof, shown as a fact on record views as it is today; export
 *  replaces a live one with its own marker. */
const CLAIM_TABLE = {
  deadline: 'fact',
  token: 'fact',
  holder: { nested: ATTRIBUTED_TABLE },
  since: 'fact',
} as const satisfies Row<ClaimRecord>;

const CAPABILITY_BLOCK_TABLE = {
  requirement: 'fact',
  code: 'fact',
  at: 'fact',
} as const satisfies Row<CapabilityBlock>;

const DRIVE_FAILURE_TABLE = {
  at: 'fact',
  step: 'fact',
  provider: 'fact',
  error_class: 'fact',
  message: 'bounded',
  attempts_sdk: 'fact',
  elapsed_ms: 'fact',
  declared_per_attempt_ms: 'fact',
  derived_ceiling_ms: 'fact',
  last_observed_status: 'fact',
  retry_after_observed_ms: 'fact',
  usage: { nested: USAGE_RECORD_TABLE },
} as const satisfies Row<DriveFailureRecord>;

const DRIVE_FAILURES_TABLE = {
  first_failed_at: 'fact',
  total: 'fact',
  entries: { nested: DRIVE_FAILURE_TABLE },
} as const satisfies Row<DriveFailuresField>;

/** A context file's snapshot: its content is a value; its path is configuration. Correction 4 (I-9):
 *  the content's digest is a value with it. */
const CONTEXT_SNAPSHOT_TABLE = {
  source_path: 'fact',
  content: 'value',
  content_hash: 'value',
  loaded_at: 'fact',
  error: 'bounded',
} as const satisfies Row<WorkflowContextSnapshot>;

/** Correction 4 (I-9b, R43'): the context file's digest derives from its content. */
export const CONTEXT_SNAPSHOT_DERIVED_OF = deriveOf(CONTEXT_SNAPSHOT_TABLE, {
  content_hash: 'content',
});

const SEALED_BY_TABLE = {
  arm: 'fact',
  step: 'fact',
  classified: 'fact',
  adjudicated: {
    nested: {
      by: 'fact',
      at: 'fact',
      previous_arm: 'fact',
      reason: 'bounded',
    } satisfies Row<NonNullable<SealedBy['adjudicated']>>,
  },
} as const satisfies Row<SealedBy>;

/** `abort_message` is a handler's runtime message (F2): a diagnostic copy. */
const ABORTED_AT_TABLE = {
  step_id: 'fact',
  conditions: { nested: GUARD_CONDITION_TABLE },
  abort_message: 'bounded',
} as const satisfies Row<NonNullable<RunRecord['aborted_at']>>;

/** One extension identity entry: hashes, paths and names realm recorded, and `error`, a load error's
 *  text (F3), a diagnostic copy. */
const EXTENSION_IDENTITY_TABLE = {
  captured_at: 'fact',
  pid: 'fact',
  modules: 'fact',
  tree: 'fact',
  signals: 'fact',
  coverage: 'fact',
  manifest: 'fact',
  secret_names: 'fact',
  override_active: 'fact',
  error: 'bounded',
  // #729 PR-3 correction 5 (J-5): `'start'` — realm's own word.
  origin: 'fact',
} as const satisfies Row<ExtensionIdentityEntry>;

/**
 * #729 PR-3 correction 2 (E-11''): the fixed `terminal_reason` sentences — core's one literal, the
 * CLI's one default (`realm run abandon` with no `--reason`) and (correction 3, H-8) the MCP door's
 * one default (`abandon_run` with no `reason`). A record whose reason is exactly one of them shows it
 * as realm's own words, so a variable holding the same word cannot hide it; any other reason
 * (rendered with run values) is a diagnostic copy.
 */
export const FIXED_TERMINAL_REASONS: readonly string[] = [
  'Workflow completed.',
  'Abandoned via realm run abandon',
  'Abandoned via abandon_run',
];

/** E-11'': `terminal_reason`'s row, chosen by its value. */
export const TERMINAL_REASON_ROW: ChosenClass = {
  choose: (value) =>
    typeof value === 'string' && FIXED_TERMINAL_REASONS.includes(value) ? 'fact' : 'bounded',
};

/** A stored run: params and every step's data are values; ids, step sets, times and ledgers are
 *  facts; the terminal reason is a diagnostic copy. */
export const RUN_RECORD_TABLE = {
  id: 'fact',
  workflow_id: 'fact',
  workflow_version: 'fact',
  parent_run_id: 'fact',
  idempotency_key: 'value',
  rerun_of: 'fact',
  completed_steps: 'fact',
  in_progress_steps: 'fact',
  failed_steps: 'fact',
  skipped_steps: 'fact',
  skip_details: { map: skipDetailTable },
  claims: { map: CLAIM_TABLE },
  capability_blocks: { map: CAPABILITY_BLOCK_TABLE },
  run_phase: 'fact',
  version: 'fact',
  params: 'value',
  evidence: { nested: EVIDENCE_TABLE },
  workflow_context_snapshots: { map: CONTEXT_SNAPSHOT_TABLE },
  extension_identity: { nested: EXTENSION_IDENTITY_TABLE },
  agent_pid: 'fact',
  agent_started_at: 'fact',
  drive_failures: { nested: DRIVE_FAILURES_TABLE },
  created_at: 'fact',
  updated_at: 'fact',
  terminal_state: 'fact',
  terminal_reason: TERMINAL_REASON_ROW,
  sealed_by: { nested: SEALED_BY_TABLE },
  pending_gate: { nested: PENDING_GATE_TABLE },
  aborted_at: { nested: ABORTED_AT_TABLE },
  abandoned_at: 'fact',
  validation_rejections: 'fact',
  defaulted_steps: 'fact',
  settled: 'fact',
  finalizer_ledger: 'fact',
} as const satisfies Row<RunRecord>;

// ── F5: what produces each `fact` row that can hold a string (compile-forced) ──────────────────

export const PENDING_GATE_FACTS = {
  gate_id: 'id',
  step_name: 'author_literal',
  choices: 'author_literal',
  opened_at: 'time',
  owner: 'id',
  expires_at: 'time',
  on_expiry: 'enum',
  default_choice: 'author_literal',
} as const satisfies FactProducers<typeof PENDING_GATE_TABLE, PendingGate>;

export const GATE_INFO_FACTS = {
  gate_id: 'id',
  step_name: 'author_literal',
  choices: 'author_literal',
  response_spec: 'author_literal',
  expires_at: 'time',
  first_reminder_due_at: 'time',
} as const satisfies FactProducers<typeof GATE_INFO_TABLE, GateInfo>;

export const USAGE_RECORD_FACTS = {
  request_start: 'time',
  cache_requested: 'enum',
  cache_requested_source: 'enum',
  cache_requested_by: 'enum',
  cache_auto: 'enum',
  provider: 'enum',
  endpoint: 'enum',
} as const satisfies FactProducers<typeof USAGE_RECORD_TABLE, UsageRecord>;

export const STEP_CACHE_FACTS = {
  state: 'enum',
  basis: 'enum',
} as const satisfies FactProducers<typeof STEP_CACHE_TABLE, StepCacheDetail>;

export const DROPPED_MID_ATTEMPT_FACTS = {
  reason: 'enum',
} as const satisfies FactProducers<typeof DROPPED_MID_ATTEMPT_TABLE, DroppedMidAttempt>;

export const TOOL_ARGS_FACTS = {
  tools: 'author_literal',
} as const satisfies FactProducers<typeof TOOL_ARGS_TABLE, ToolArgs>;

export const STRUCTURED_OUTPUT_FACTS = {
  caveats: 'enum',
  downgrade_reason: 'enum',
  provider: 'enum',
  submission_channel: 'enum',
} as const satisfies FactProducers<typeof STRUCTURED_OUTPUT_TABLE, StructuredOutputMeta>;

export const PRECONDITION_TRACE_FACTS = {
  expression: 'author_literal',
} as const satisfies FactProducers<
  typeof PRECONDITION_TRACE_TABLE,
  Element<StepDiagnostics['precondition_trace']>
>;

export const GUARD_CONDITION_FACTS = {
  condition: 'author_literal',
} as const satisfies FactProducers<
  typeof GUARD_CONDITION_TABLE,
  Element<NonNullable<StepDiagnostics['guard_conditions']>>
>;

export const STEP_DIAGNOSTICS_FACTS = {} as const satisfies FactProducers<
  typeof STEP_DIAGNOSTICS_TABLE,
  StepDiagnostics
>;

export const ATTRIBUTED_FACTS = {
  by: 'id',
  by_source: 'enum',
  channel: 'enum',
} as const satisfies FactProducers<typeof ATTRIBUTED_TABLE, Attributed>;

export const EVIDENCE_FACTS = {
  step_id: 'author_literal',
  started_at: 'time',
  completed_at: 'time',
  status: 'enum',
  kind: 'enum',
  responded_by: 'id',
  output_source: 'enum',
  supplied_by: 'enum',
  claim_proof: 'enum',
  resolution: 'enum',
  agent_profile: 'author_literal',
  agent_profile_hash: 'hash',
  trace_summary: 'enum',
  exhausted_by: 'enum',
  answer: 'id',
  principal: 'id',
} as const satisfies FactProducers<typeof EVIDENCE_TABLE, EvidenceSnapshot>;

export const WHEN_FALSE_LEAF_FACTS = {
  leaf: 'author_literal',
} as const satisfies FactProducers<typeof WHEN_FALSE_LEAF_TABLE, Element<WhenFalse['leaves']>>;

export const SKIP_DETAIL_FACTS = {
  when_false: { kind: 'enum', expression: 'author_literal' } satisfies FactProducers<
    typeof SKIP_DETAIL_TABLES.when_false,
    WhenFalse
  >,
  trigger_rule_unsatisfiable: {
    kind: 'enum',
    rule: 'enum',
    blocking_deps: 'author_literal',
  } satisfies FactProducers<
    typeof SKIP_DETAIL_TABLES.trigger_rule_unsatisfiable,
    Extract<SkipDetail, { kind: 'trigger_rule_unsatisfiable' }>
  >,
  handler_abort: { kind: 'enum' } satisfies FactProducers<
    typeof SKIP_DETAIL_TABLES.handler_abort,
    Extract<SkipDetail, { kind: 'handler_abort' }>
  >,
  guard_abort: { kind: 'enum' } satisfies FactProducers<
    typeof SKIP_DETAIL_TABLES.guard_abort,
    Extract<SkipDetail, { kind: 'guard_abort' }>
  >,
  gate_cancelled_by_abort: { kind: 'enum', gate_id: 'id' } satisfies FactProducers<
    typeof SKIP_DETAIL_TABLES.gate_cancelled_by_abort,
    Extract<SkipDetail, { kind: 'gate_cancelled_by_abort' }>
  >,
  gate_expired: { kind: 'enum', gate_id: 'id' } satisfies FactProducers<
    typeof SKIP_DETAIL_TABLES.gate_expired,
    Extract<SkipDetail, { kind: 'gate_expired' }>
  >,
} as const;

export const CLAIM_FACTS = {
  deadline: 'time',
  token: 'id',
  since: 'time',
} as const satisfies FactProducers<typeof CLAIM_TABLE, ClaimRecord>;

export const CAPABILITY_BLOCK_FACTS = {
  requirement: 'author_literal',
  code: 'enum',
  at: 'time',
} as const satisfies FactProducers<typeof CAPABILITY_BLOCK_TABLE, CapabilityBlock>;

export const DRIVE_FAILURE_FACTS = {
  at: 'time',
  step: 'author_literal',
  provider: 'enum',
  error_class: 'enum',
} as const satisfies FactProducers<typeof DRIVE_FAILURE_TABLE, DriveFailureRecord>;

export const DRIVE_FAILURES_FACTS = {
  first_failed_at: 'time',
} as const satisfies FactProducers<typeof DRIVE_FAILURES_TABLE, DriveFailuresField>;

export const CONTEXT_SNAPSHOT_FACTS = {
  source_path: 'path_fact',
  loaded_at: 'time',
} as const satisfies FactProducers<typeof CONTEXT_SNAPSHOT_TABLE, WorkflowContextSnapshot>;

export const SEALED_BY_FACTS = {
  arm: 'enum',
  step: 'author_literal',
} as const satisfies FactProducers<typeof SEALED_BY_TABLE, SealedBy>;

export const SEALED_BY_ADJUDICATED_FACTS = {
  by: 'id',
  at: 'time',
  previous_arm: 'enum',
} as const satisfies FactProducers<
  typeof SEALED_BY_TABLE.adjudicated.nested,
  NonNullable<SealedBy['adjudicated']>
>;

export const ABORTED_AT_FACTS = {
  step_id: 'author_literal',
} as const satisfies FactProducers<typeof ABORTED_AT_TABLE, NonNullable<RunRecord['aborted_at']>>;

export const EXTENSION_IDENTITY_FACTS = {
  captured_at: 'time',
  modules: 'path_fact',
  tree: 'hash',
  signals: 'hash',
  coverage: 'enum',
  manifest: 'path_fact',
  secret_names: 'author_literal',
  origin: 'enum',
} as const satisfies FactProducers<typeof EXTENSION_IDENTITY_TABLE, ExtensionIdentityEntry>;

export const RUN_RECORD_FACTS = {
  id: 'id',
  workflow_id: 'author_literal',
  parent_run_id: 'id',
  rerun_of: 'id',
  completed_steps: 'author_literal',
  in_progress_steps: 'author_literal',
  failed_steps: 'author_literal',
  skipped_steps: 'author_literal',
  run_phase: 'enum',
  agent_started_at: 'time',
  created_at: 'time',
  updated_at: 'time',
  abandoned_at: 'time',
  defaulted_steps: 'author_literal',
  settled: 'enum',
  finalizer_ledger: 'enum',
} as const satisfies FactProducers<typeof RUN_RECORD_TABLE, RunRecord>;

// ── The door functions ────────────────────────────────────────────────────────────────────────

declare const shownGate: unique symbol;
/** A gate as an audience is shown it: the question at the declared tier, the preview disclosed
 *  (shaped on `broadcast`), the choices as they are. Only {@link discloseGate} mints one, so a
 *  composer that takes it (QuestionView, Slack's post) cannot be handed a raw gate. */
export type ShownGate<G extends PendingGate | GateInfo = PendingGate> = G & {
  readonly [shownGate]: true;
};

/** A gate for `audience` (D1 §3.3). #729 PR-4 (F10): `onTally` receives the walk's tally, so a
 *  host that counts what it hides (realm agent's `Disclosure:` line) walks the gate once. */
export function discloseGate<G extends PendingGate | GateInfo>(
  gate: G,
  set: DisclosureSet,
  audience: DisclosureAudience,
  options: WalkOptions & { onTally?: (tally: DisclosureTally) => void } = {},
): ShownGate<G> {
  const table: ClassTable = 'opened_at' in gate ? PENDING_GATE_TABLE : GATE_INFO_TABLE;
  const { onTally, ...walk } = options;
  const walked = discloseByTable(gate, table, set, audience, walk);
  onTally?.(walked.tally);
  return walked.value as ShownGate<G>;
}

/** A stored run for `audience` (inspect, export), with its receipt. The record is not changed. */
export function discloseRecord(
  record: RunRecord,
  set: DisclosureSet,
  audience: DisclosureAudience,
  options: WalkOptions = {},
): { record: RunRecord; receipt: DisclosureReceipt } {
  const walked = discloseByTable(record, RUN_RECORD_TABLE, set, audience, options);
  return { record: walked.value as RunRecord, receipt: disclosureReceipt(set, walked.tally) };
}

/**
 * A reply for `audience`, walked by the door's table, with the receipt as its top-level
 * `disclosure` field. The door passes its own table (the MCP envelope's, a tool result's).
 */
export function discloseReply(
  reply: object,
  set: DisclosureSet,
  audience: DisclosureAudience,
  table: ClassTable,
  options: WalkOptions = {},
): Record<string, unknown> & { disclosure: DisclosureReceipt } {
  // #729 PR-3 correction 3 (H-11'): the door has no flag to accept partial disclosure, so the set's
  // cause alone decides — a failed or changed manifest withholds; none declared never does.
  const withhold = withheldCauseOf(set);
  const walked = discloseByTable(reply, table, set, audience, {
    ...options,
    ...(withhold !== undefined ? { withhold } : {}),
  });
  return {
    ...(walked.value as Record<string, unknown>),
    disclosure: disclosureReceipt(set, walked.tally),
  };
}
