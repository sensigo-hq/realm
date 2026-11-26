// get-run-state tool — returns the current state summary of a run.
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  type DriveFailuresField,
  NAMES_SHOWN,
  SEAL_ARMS,
  SEAL_DOORS,
  readAttributed,
  WorkflowError,
  capText,
  getWorkflowForRun,
  buildPreExecutionErrorEnvelope,
  classifyInProgressClaims,
  findCapabilityBlockedSteps,
  classifyRunHealth,
  persistsField,
  deriveDefaultedSteps,
  deriveRunPhase,
  describeClaimHolder,
  composeStepViews,
  composeFailures,
  composeDriveFailureCosts,
  composeRunCost,
  describePending,
  composeNextActionsStatusWord,
  composeWaysOn,
  waysStoreOf,
  definitionAbsenceOf,
  dueExpiry,
  loadSnapshot,
  leaseFactOf,
  agentActionOf,
  offeredResumeWay,
  pendingCleanupWay,
  waitingOnAnswer as waitingOnAnswerOf,
  assertRegistryLine,
  ExtensionRegistry,
  type EngineRunnable,
  type RunPhase,
  type ClaimState,
  type AgentAction,
  type Basis,
  type WaysContext,
  type LoadErrorCode,
  escapedBoundedValue,
  type SkipDetail,
  type ClassTable,
  type DisclosureClass,
  RUN_RECORD_TABLE,
  type RunStore,
  type WorkflowDefinition,
  type RunHealthFinding,
  type StepView,
  type FailureView,
  type DriveFailureCost,
  type Money,
  type PreconditionFacts,
  type PriceSource,
  type RunCost,
  type Attributed,
  type ActorAbsent,
  runReadError,
  type WorkflowRegistrar,
  type DisclosureSet,
  type NextActionsStatus,
  failedRequestSends,
  failureTextShape,
  terminalReasonHidingFailureText,
  abortMessageHidingFailureText,
  carriesFailureWords,
  isFailureWordsThrow,
  conditionValueHidingFailureText,
  withPreconditionHidingFailureText,
  questionHidingFailureText,
  type RunRecord,
} from '@sensigo/realm';
import { mcpHostOf } from './start-run.js';
import type { McpDoor } from '../door.js';
import { toolMeta } from '../tool-annotations.js';
import {
  ALSO_TABLE,
  MCP_ENVELOPE_TABLE,
  NEXT_ACTION_TABLE,
  PERSON_BLOCK,
  disclosureOfTool,
  renderReply,
  renderWaysOf,
  replyPlanOf,
  safeTool,
  toolContentWithTwinOf,
  type WithDoorDisclosure,
  type McpAlsoEntry,
  type McpElsewhereEntry,
  type McpNextAction,
  type Merged,
  type OperatorRoute,
  type PollReason,
  type WithPersonBlock,
  FAILURE_TEXT_SHAPED,
  replySubject,
  setForSubject,
  SAFE_TOOL_CONSTANT_RUNLESS,
} from '../render-reply.js';
import {
  assertToolStores,
  isReleaseLineRefusal,
  markServedByTool,
  registryRole,
} from './assert-tool-stores.js';
import { boundedLines, boundedRefusal } from './refusal-format.js';
import { runStateWireFloor, runStateWireSchema } from './run-state-wire.js';

/** issue #558 PR-T — the store's own classification, passed through to classifyRunHealth. */
function toDefinitionError(err: unknown): { code: string; message: string; class?: string } {
  // Narrowed with `instanceof` — never duck-typed on `err.code` (house rule).
  if (err instanceof WorkflowError) {
    const cls = (err.details as Record<string, unknown> | undefined)?.['class'];
    return {
      code: err.code,
      message: err.message,
      ...(typeof cls === 'string' ? { class: cls } : {}),
    };
  }
  // The class slot is a word on every surface (review fold C15 — the CLI's closure says
  // `unknown` for the same escape).
  return {
    code: 'ENGINE_INTERNAL',
    message: err instanceof Error ? err.message : String(err),
    class: 'unknown',
  };
}

export interface HandleRunStateStores {
  /** Any `RunStore` implementation (issue #188, PR-1 — was `JsonFileStore`-only). #616 PR-2a (ii-b):
   *  required — the handler builds no store. */
  runStore: RunStore;
  /**
   * Optional workflow store used to compute `next_actions`. When absent (or the workflow is not
   * registered), `next_actions_status` is `'workflow_unresolved'`. Intentionally NOT defaulted to a
   * fresh JsonWorkflowStore so the function stays hermetic for tests/programmatic callers.
   */
  workflowStore?: WorkflowRegistrar;
  /**
   * issue #625 PR-2a (decision C8): the server's registry, so the run's view can judge the
   * capability check (`describePending`). Absent ⇒ the capability check is `'unknown'` and the act
   * stays offered.
   */
  registry?: ExtensionRegistry;
  /** Per-definition registry resolution; wins over `registry`. A failure falls back to none. */
  registryProvider?: (definition: WorkflowDefinition) => Promise<ExtensionRegistry>;
  /** issue #729 PR-0 (P-6): the operator route the launching program injected, if any. */
  operatorRoute?: OperatorRoute;
  /**
   * #627 W: this server's door — its gate answers and form facts. A read renders the await entry
   * from them and NEVER sends a form (`get_run_state` stays read-only).
   */
  door?: McpDoor;
  /**
   * Issue #600 caching PR P: per-definition price resolution (the run's deployment root names its
   * economics file). Absent ⇒ every request is `no_price_source`: this function defaults nothing
   * (`createRealmMcpServer` does). A failure prices nothing: `economics_unreachable`, with its reason.
   */
  priceSourceProvider?: (definition: WorkflowDefinition) => Promise<PriceSource>;
}

/** Issue #600 caching PR P: every answer the same not-priced cause, with its reason. */
function notPriced(
  cause: 'economics_unreachable' | 'no_price_source',
  detail?: string,
): PriceSource {
  return {
    price: () => ({ not_priced: cause, ...(detail !== undefined ? { detail } : {}) }),
  };
}

/**
 * Issue #600 caching PR P: the price source for this run's view. Never throws. Gap 2, unit (iv-b2b):
 * under the failure-text setting `hidden`, a not-priced `detail` that is a failure's words — from a
 * source the provider marked (its load failed on the project's code), or a throw the one rule calls
 * one — is handed on as its shape, and each shape is kept in `shaped` for the receipt.
 */
async function priceSourceFor(
  stores: HandleRunStateStores | undefined,
  definition: WorkflowDefinition | undefined,
  shaped: Set<string>,
): Promise<PriceSource> {
  const provider = stores?.priceSourceProvider;
  if (provider === undefined) return notPriced('no_price_source');
  if (definition === undefined) {
    return notPriced(
      'economics_unreachable',
      "the run's workflow copy could not be read, so its deployment root is unknown",
    );
  }
  const hidden = stores?.door?.failureText.value === 'hidden';
  try {
    const source = await provider(definition);
    return hidden && carriesFailureWords(source) ? detailShaped(source, shaped) : source;
  } catch (err) {
    if (isReleaseLineRefusal(err)) throw err;
    const detail = err instanceof Error ? err.message : String(err);
    if (!hidden || !isFailureWordsThrow(err, provider)) {
      return notPriced('economics_unreachable', detail);
    }
    return detailShaped(notPriced('economics_unreachable', detail), shaped);
  }
}

/** Gap 2, unit (iv-b2b): `source` with each not-priced `detail` as its shape, kept in `shaped`. */
function detailShaped(source: PriceSource, shaped: Set<string>): PriceSource {
  return {
    price: (input) => {
      const result = source.price(input);
      if (!('not_priced' in result) || result.detail === undefined) return result;
      const shape = failureTextShape(result.detail);
      shaped.add(shape);
      return { ...result, detail: shape };
    },
  };
}

/**
 * Gap 2, unit (iv-b2b): the paths, in the walk's own spelling, of `node`'s fields that hold a
 * not-priced `detail` shown as its shape (one of `shaped`): down `table`'s nested rows to the
 * `detail` itself, or to the row that is not a table and holds one (`steps`; a drive failure's
 * `cost`), as the walk lists only the rows it meets.
 */
function shapedDetailPaths(
  node: unknown,
  table: Readonly<Record<string, DisclosureClass>>,
  path: string,
  shaped: ReadonlySet<string>,
): string[] {
  if (Array.isArray(node)) {
    return node.flatMap((child, i) => shapedDetailPaths(child, table, `${path}[${i}]`, shaped));
  }
  if (typeof node !== 'object' || node === null) return [];
  return Object.entries(node).flatMap(([key, child]) => {
    const at = path === '' ? key : `${path}.${key}`;
    const row = Object.hasOwn(table, key) ? table[key] : undefined;
    if (typeof row === 'object' && 'nested' in row) {
      const nested = typeof row.nested === 'function' ? row.nested(child) : row.nested;
      return shapedDetailPaths(child, nested, at, shaped);
    }
    const holds =
      table === NOT_PRICED_TABLE && key === 'detail'
        ? typeof child === 'string' && shaped.has(child)
        : holdsShapedDetail(child, shaped);
    return holds ? [at] : [];
  });
}

/** Whether `node` holds, at any depth, a not-priced entry whose `detail` is one of `shaped`. */
function holdsShapedDetail(node: unknown, shaped: ReadonlySet<string>): boolean {
  if (Array.isArray(node)) return node.some((child) => holdsShapedDetail(child, shaped));
  if (typeof node !== 'object' || node === null) return false;
  return Object.entries(node).some(([key, child]) =>
    key === 'not_priced' && Array.isArray(child)
      ? child.some((entry) => shaped.has((entry as { detail?: string }).detail ?? ''))
      : holdsShapedDetail(child, shaped),
  );
}

// Q1 (#592) d1: the `next_actions_status` words are core's (`NEXT_ACTIONS_STATUS`); the type's name
// stays on this subpath.
export type { NextActionsStatus };

/** F18: the failed expression is the author's text (a fact); the value it read is a value. */
export const PRECONDITION_FACTS_TABLE = {
  expression: 'fact',
  value: 'value',
} as const satisfies Record<keyof PreconditionFacts, DisclosureClass>;

/** A table that reads every key of `node` (an object, or an array of objects) as a value, except
 *  the rows given. */
function valueRowsBut(node: unknown, rows: ClassTable): ClassTable {
  const keys = new Set<string>();
  for (const item of Array.isArray(node) ? node : [node]) {
    if (item !== null && typeof item === 'object') for (const k of Object.keys(item)) keys.add(k);
  }
  return Object.fromEntries([...keys].map((k) => [k, Object.hasOwn(rows, k) ? rows[k]! : 'value']));
}

/**
 * #729 PR-3 correction 2 (G3, DQ 2): a run-health finding's evidence. Its `refused` entries (each
 * refused step's facts, `cannot_go_on`) read their precondition as `engine_runnable` does — the
 * expression shown, the value it read masked — so one reply never shows one text two ways. A leased
 * claim's `lease` fact is a fact (#729 CW-3a). Every other part of the evidence is a value.
 */
export const RUN_HEALTH_EVIDENCE_TABLE = (evidence: unknown): ClassTable =>
  valueRowsBut(evidence, {
    // #729 CW-3a: a leased claim's lease fact — closed words, a fact (axis 14)
    lease: { nested: { state: 'fact', basis: 'fact', reason: 'fact' } },
    refused: {
      nested: (refused: unknown) =>
        valueRowsBut(refused, { precondition: { nested: PRECONDITION_FACTS_TABLE } }),
    },
    ...moreRowsOf(evidence),
  });

/**
 * #872 (b1) correction 1 (H5): the `<key>_more` count get_run_state sets beside a list in a
 * finding's evidence ({@link boundedEvidence}) — a fact, a number, never a value.
 */
function moreRowsOf(node: unknown): Record<string, DisclosureClass> {
  const rows: Record<string, DisclosureClass> = {};
  for (const item of Array.isArray(node) ? node : [node]) {
    if (item === null || typeof item !== 'object') continue;
    const fields = item as Record<string, unknown>;
    for (const key of Object.keys(fields)) {
      if (key.endsWith(MORE) && Array.isArray(fields[key.slice(0, -MORE.length)])) {
        rows[key] = 'fact';
      }
    }
  }
  return rows;
}

/** The suffix of a count the reply ceiling, or a bound, left out. */
const MORE = '_more';

/** #872 (b1) correction 1 (H5): at most this many findings of a kind, and entries in an evidence list. */
const RUN_HEALTH_SHOWN = NAMES_SHOWN;

/** #872 (b1) correction 1 (H7): at most this many billed requests per failed drive. */
const DRIVE_USAGE_SHOWN = 3;

/**
 * H5: a finding's evidence with every list at most ten entries; one with more keeps its first ten
 * and `<key>_more` beside it counts the rest.
 */
function boundedEvidence(evidence: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(evidence).flatMap(([key, value]) =>
      Array.isArray(value) && value.length > RUN_HEALTH_SHOWN
        ? [
            [key, value.slice(0, RUN_HEALTH_SHOWN)],
            [`${key}${MORE}`, value.length - RUN_HEALTH_SHOWN],
          ]
        : [[key, value]],
    ),
  );
}

/**
 * #872 (b1) correction 1 (H5): get_run_state's `run_health`, by construction — at most ten findings
 * of each kind, in their order, each evidence list bounded; `more` maps a kind to the exact count of
 * its findings left out. Core's findings are untouched (the warning counts them all).
 */
function boundedRunHealth(findings: readonly RunHealthFinding[]): {
  shown: RunHealthFinding[];
  more: Partial<Record<RunHealthFinding['kind'], number>>;
} {
  const seen = new Map<string, number>();
  const shown: RunHealthFinding[] = [];
  const more: Partial<Record<RunHealthFinding['kind'], number>> = {};
  for (const finding of findings) {
    const n = (seen.get(finding.kind) ?? 0) + 1;
    seen.set(finding.kind, n);
    if (n > RUN_HEALTH_SHOWN) {
      more[finding.kind] = (more[finding.kind] ?? 0) + 1;
      continue;
    }
    shown.push(
      finding.evidence !== undefined
        ? { ...finding, evidence: boundedEvidence(finding.evidence) }
        : finding,
    );
  }
  return { shown, more };
}

/**
 * H7: a failed drive as get_run_state shows it — its billed requests bounded, with the count left
 * out. Gap 1, unit A2a: without its `model_text`, which get_run_state never shows.
 */
export type DriveFailureView = Omit<DriveFailuresField['entries'][number], 'model_text'> & {
  usage_more?: number;
  /**
   * Gap 2, unit (i-b): Realm's attempt number, for an entry that carries `model_attempts` (a step
   * that declares `retry`): the sends of the request that failed last, its tries and re-sends.
   * `attempts_sdk` beside it stays the model client's own count.
   */
  attempt?: number;
};

/** H7: the run's failed drives as get_run_state shows them. */
export type DriveFailuresView = Omit<DriveFailuresField, 'entries'> & {
  entries: DriveFailureView[];
};

/**
 * #872 (b1) correction 1 (H7): the run's failed drives — the ring as stored — each entry's `usage` at
 * most three records, `usage_more` beside it counting the rest. `drive_failure_costs` keeps the
 * totals. Gap 1, unit A2a: each entry without its `model_text` (the model calls' texts), every
 * other key as stored, in its order.
 */
function boundedDriveFailures(field: DriveFailuresField): DriveFailuresView {
  return {
    ...field,
    entries: field.entries.map((entry) => {
      const { model_text: _text, ...shown } = entry;
      void _text;
      const view: DriveFailureView =
        shown.usage !== undefined && shown.usage.length > DRIVE_USAGE_SHOWN
          ? (Object.fromEntries(
              Object.entries(shown).flatMap(([key, value]) =>
                key === 'usage'
                  ? [
                      [key, shown.usage!.slice(0, DRIVE_USAGE_SHOWN)],
                      [`usage${MORE}`, shown.usage!.length - DRIVE_USAGE_SHOWN],
                    ]
                  : [[key, value]],
              ),
            ) as DriveFailureView)
          : shown;
      // Gap 2, unit (i-b): Realm's attempt number beside the client's `attempts_sdk`, for an entry
      // whose failure is the failed send that ended the last request in its `model_attempts`; at
      // the end when the entry has no `attempts_sdk`.
      const attempt = failedRequestSends(entry.model_attempts);
      if (attempt === undefined) return view;
      const pairs = Object.entries(view).flatMap(([key, value]): Array<[string, unknown]> =>
        key === 'attempts_sdk'
          ? [
              [key, value],
              ['attempt', attempt],
            ]
          : [[key, value]],
      );
      if (view.attempts_sdk === undefined) pairs.push(['attempt', attempt]);
      return Object.fromEntries(pairs) as DriveFailureView;
    }),
  };
}

/**
 * #625 PR-2b, the actor unit: the program a seal names, read as every recorded program is — an
 * unreadable one is `name_unreadable`, never a guess.
 */
function sealedByActorOf(value: unknown): NonNullable<RunStateSummary['sealed_by_actor']> {
  const read = readAttributed(value);
  return read.by === null ? { by: null, absent_cause: 'name_unreadable' } : read;
}

/** #872 (b1) correction 1 (H7): `resumable` with at most ten steps; `steps_more` counts the rest. */
function boundedResumable(way: { steps: string[]; command: string }): {
  steps: string[];
  steps_more?: number;
  command: string;
} {
  return way.steps.length > NAMES_SHOWN
    ? {
        steps: way.steps.slice(0, NAMES_SHOWN),
        steps_more: way.steps.length - NAMES_SHOWN,
        command: way.command,
      }
    : way;
}

/**
 * #872 (b1) correction 1 (H7): core's drive-failure rows, kept, with `usage_more` (a count) classed a
 * fact — core's table has no row for it, and an unclassified key is walked as a value.
 */
const CORE_DRIVE_FAILURES_TABLE = RUN_RECORD_TABLE.drive_failures.nested;
export const DRIVE_FAILURES_VIEW_TABLE = {
  ...CORE_DRIVE_FAILURES_TABLE,
  entries: {
    nested: { ...CORE_DRIVE_FAILURES_TABLE.entries.nested, usage_more: 'fact', attempt: 'fact' },
  },
} as const;

export const ENGINE_RUNNABLE_TABLE = {
  step: 'fact',
  runnable_here: 'fact',
  refused_by: 'fact',
  refusal: 'bounded',
  basis: 'fact',
  // #872 (a): the handler or adapter a capability refusal names — a kind and a name the author wrote
  // (as `capability_blocks`).
  requirement: 'fact',
  precondition: { nested: PRECONDITION_FACTS_TABLE },
} as const satisfies Record<keyof EngineRunnable, DisclosureClass>;

/** F4: a not-priced cause, with its `detail`, which can be a project load error's text or a configured
 *  name (`load-project-extensions.ts`'s price provider, `price-source.ts`): a diagnostic copy. */
export const NOT_PRICED_TABLE = {
  cause: 'fact',
  count: 'fact',
  detail: 'bounded',
} as const satisfies Record<keyof NonNullable<Money['not_priced']>[number], DisclosureClass>;

/** F4: money, with its not-priced entries. Its sources name a price list or an economics file. */
export const MONEY_TABLE = {
  total: 'fact',
  uncached_counterfactual: 'fact',
  net: 'fact',
  priced: 'fact',
  of: 'fact',
  dated: 'fact',
  sources: 'fact',
  source_totals: 'fact',
  not_priced: { nested: NOT_PRICED_TABLE },
} as const satisfies Record<keyof Money, DisclosureClass>;

/** F4: what a run cost. */
export const RUN_COST_TABLE = {
  total: { nested: MONEY_TABLE },
  failed_drives_not_on_record: 'fact',
  failed_drives_without_usage: 'fact',
  unmeasured: 'fact',
} as const satisfies Record<keyof RunCost, DisclosureClass>;

/** F4 (the same money, per failed drive): its cost view is a diagnostic copy. */
export const DRIVE_FAILURE_COST_TABLE = {
  at: 'fact',
  step: 'fact',
  error_class: 'fact',
  cost: 'bounded',
} as const satisfies Record<keyof DriveFailureCost, DisclosureClass>;

/**
 * #729 PR-3 (M-1): the run's summary, field by field. Params and the open question's preview are
 * values; the question is the declared tier; reasons and refusals are diagnostic copies; ids, step
 * sets, times, ways and costs are facts. A step's attempts are walked whole as diagnostics.
 */
export const RUN_STATE_SUMMARY_TABLE = {
  run_id: 'fact',
  workflow_id: 'fact',
  run_phase: 'fact',
  terminal_state: 'fact',
  // E-11'': one row for one text — the record table's, chosen by the value.
  terminal_reason: RUN_RECORD_TABLE.terminal_reason,
  rerun_of: 'fact',
  sealed_by_arm: 'fact',
  sealed_by_adjudicated: {
    nested: { by: 'fact', at: 'fact', previous_arm: 'fact', reason: 'bounded' },
  },
  sealed_by_classified: 'fact',
  sealed_by_step: 'fact',
  // #625 PR-2b, the actor unit: the program that ended the run — its name is the host's text, bounded
  // (masked as environment values are: the part of it that matches an environment value of 8
  // characters or more, such as a long OS user name, shows as `[REDACTED]`; REALM_OPERATOR's own
  // value is not counted); how it is known, its channel and why there is none are realm's words. The
  // command or tool is realm's word.
  sealed_by_actor: {
    nested: {
      by: 'bounded',
      by_source: 'fact',
      channel: 'fact',
      absent_cause: 'fact',
    } satisfies Record<
      keyof Merged<NonNullable<RunStateSummary['sealed_by_actor']>>,
      DisclosureClass
    >,
  },
  sealed_by_door: 'fact',
  // #872 (b1) correction 1 (H7): core's rows, with `usage_more` a fact.
  drive_failures: { nested: DRIVE_FAILURES_VIEW_TABLE },
  completed_steps: 'fact',
  in_progress_steps: 'fact',
  failed_steps: 'fact',
  // Q1 (#592) unit b: one view per failed step, from the record. Realm's words and the step are
  // facts; the message is a diagnostic copy, bounded as `terminal_reason`'s non-fixed arm is.
  failures: {
    nested: {
      step: 'fact',
      code: 'fact',
      category: 'fact',
      stop_reason: 'fact',
      agent_action: 'fact',
      // Gap 2, unit (ii-b1): the failure's kind, a closed word: a fact, also under `hidden`.
      failure_kind: 'fact',
      attempt: 'fact',
      message: 'bounded',
      unknown: 'fact',
      absent: 'fact',
    } satisfies Record<keyof Merged<FailureView>, DisclosureClass>,
  },
  skipped_steps: 'fact',
  pending_gate: RUN_RECORD_TABLE.pending_gate,
  evidence_count: 'fact',
  last_step: 'fact',
  created_at: 'fact',
  updated_at: 'fact',
  params: 'value',
  abort_context: RUN_RECORD_TABLE.aborted_at,
  next_actions: { nested: NEXT_ACTION_TABLE },
  next_actions_status: 'fact',
  agent_action: 'fact',
  poll_after_ms: 'fact',
  poll_reason: 'fact',
  until: 'fact',
  also: { nested: ALSO_TABLE },
  elsewhere: 'fact',
  basis: 'fact',
  stuck_claims: 'fact',
  step_claims: 'fact',
  capability_blocks: 'fact',
  skip_details: RUN_RECORD_TABLE.skip_details,
  run_health: {
    nested: {
      kind: 'fact',
      step: 'fact',
      reason: 'bounded',
      since: 'fact',
      idle_ms: 'fact',
      evidence: { nested: RUN_HEALTH_EVIDENCE_TABLE },
    } satisfies Record<keyof RunHealthFinding, DisclosureClass>,
  },
  defaulted_steps: 'fact',
  warnings: 'bounded',
  steps: 'bounded',
  // #872 (b1): what the reply ceiling left out — exact counts (numbers: no F5 producer) — and the
  // cursor to the next page of `steps` (the last shown step's own id).
  steps_more: 'fact',
  next_cursor: 'fact',
  skip_details_more: 'fact',
  engine_runnable_more: 'fact',
  agent_refused_more: 'fact',
  capability_blocks_more: 'fact',
  next_actions_more: 'fact',
  // #872 (b1) correction 1 (H4, H5): the run's lists the reply ceiling cut, and the run-health
  // findings left out per kind — counts (numbers: no F5 producer).
  defaulted_steps_more: 'fact',
  skipped_steps_more: 'fact',
  completed_steps_more: 'fact',
  waiting_on_answer_more: 'fact',
  pending_guards_more: 'fact',
  step_claims_more: 'fact',
  stuck_claims_more: 'fact',
  in_progress_steps_more: 'fact',
  failures_more: 'fact',
  failed_steps_more: 'fact',
  run_health_more: 'fact',
  drive_failure_costs: { nested: DRIVE_FAILURE_COST_TABLE },
  run_cost: { nested: RUN_COST_TABLE },
  pending_guards: 'fact',
  engine_runnable: { nested: ENGINE_RUNNABLE_TABLE },
  agent_refused: { nested: ENGINE_RUNNABLE_TABLE },
  resumable: 'fact',
  cleanup_pending: 'fact',
  waiting_on_answer: 'fact',
} as const satisfies Record<keyof RunStateSummary, DisclosureClass>;

export interface RunStateSummary {
  run_id: string;
  workflow_id: string;
  run_phase: RunPhase;
  terminal_state: boolean;
  /**
   * The run's own terminal-seal reason string, verbatim (issue #302 — disclosure gaps), e.g.
   * `'Workflow completed.'`. Present only when the underlying `RunRecord.terminal_reason` is set —
   * absent on a live (non-terminal) run, never a synthesized/default string. This is what
   * `deriveRunPhase`'s LEGACY leg keys the `'completed'` phase on — on a stamped record the arm
   * derives and this string is read by nobody (issue #367) — so an MCP
   * consumer that wants to distinguish "completed cleanly" from "completed with failed_steps
   * carried" (issue #302's `completed_with_failed_steps` run-health class — CLI-only; this run's
   * own `get_run_state` terminal guard below stays byte-untouched, see `run_health`'s own doc)
   * now has the raw signal to combine with `failed_steps` and the derived `run_phase` itself,
   * without needing the run-health surface this response deliberately does not inherit.
   */
  terminal_reason?: string;
  /**
   * Issue #558 PR-C: the id of the terminal run this run SUPERSEDED under the same idempotency key
   * (`on_terminal_match: 'rerun' | 'rerun_if_failed'`). Absent for a first run and for a `reuse`.
   * Stamped by the store at creation; never caller-settable.
   */
  rerun_of?: string;
  /**
   * Issue #367: WHICH arm of the engine sealed this run — the recorded fact, not a re-reading of
   * the prose. Present on any terminal run written since #367, and absent on the legacy population
   * (where `run_phase` is recovered by the read-path classifier instead). Normally absent on a
   * live run — with ONE honest exception: an ORPHANED stamp awaiting self-heal, which an old
   * binary's resume produces by flipping the run live while keeping the seal. Such a record
   * renders an arm beside `run_phase: 'running'`, and that IS the truth about it; the derivation
   * deliberately ignores the stamp there, and the next settle write strips it. An arm this binary
   * does not recognise renders as `unrecognized arm '<value>'` rather than being omitted, so a
   * newer writer's record is never silently reported as unsealed.
   *
   * Prefer this over parsing `terminal_reason`: the prose is for people.
   */
  sealed_by_arm?: string;
  /**
   * Issue #367: an operator's RULING on this run's arm, verbatim — who ruled, when, which arm it
   * replaced (`null` when the ruling was a first stamp of a record that had none), and their
   * stated reason. Never summarised and never truncated: a ruling is provenance, and half a
   * provenance record is worse than none.
   *
   * `by` is a recorded CLAIM of identity, not a verified one — there is no auth model behind it.
   * Absent when the run carries no ruling.
   */
  sealed_by_adjudicated?: {
    by: string;
    at: string;
    previous_arm: string | null;
    reason?: string;
  };
  /**
   * Issue #367: present iff this arm was RECOVERED by the classifier (the migration vehicle)
   * rather than asserted by the writer that sealed the run. Absent otherwise — never `false`.
   */
  sealed_by_classified?: true;
  /**
   * Issue #367: the step whose settlement sealed the run — emitted ONLY for arms where that step
   * is the seal's deterministic identity (`guard_*`, `gate_*`, `handler_abort`), mirroring the
   * same fork `realm run inspect` applies.
   *
   * For `complete` and `step_failure` the recorded step is whichever one happened to settle LAST,
   * a scheduling artifact — and this surface's consumers are agents, the readers most likely to
   * take a named step as THE culprit. That is precisely the misreading issue #373 exists to
   * prevent, so the key is absent there. The record still carries it; `export` still ships it.
   */
  sealed_by_step?: string;
  /**
   * #625 PR-2b, the actor unit: the program that ended the run, as its seal records it — its name,
   * how the name is known (`stated`, `ambient` from REALM_OPERATOR, `derived` from the OS user, `key`
   * from a `realm serve` named key the caller presented) and its channel. Recorded by `realm run abandon`, `realm run cleanup` and this server's `abandon_run`
   * when a name is known. A name that cannot be read is `{ by: null, absent_cause: 'name_unreadable' }`.
   * Absent — never null — when the seal names no program. Realm names a program, never a person; on
   * this surface the name is masked as environment values are: the part of it that matches an
   * environment value of 8 characters or more, such as a long OS user name, shows as `[REDACTED]`;
   * REALM_OPERATOR's own value is not counted.
   */
  sealed_by_actor?: Attributed | { by: null; absent_cause: 'name_unreadable' };
  /**
   * #625 PR-2b, the actor unit: the command or tool that ended the run, as its seal records it —
   * `realm_run_abandon`, `abandon_run` or `realm_run_cleanup`. A word this binary does not recognise
   * renders as `unrecognized door '<value>'`, as `sealed_by_arm` does. Absent — never null — when the
   * seal records none.
   */
  sealed_by_door?: string;

  /**
   * Failed drive attempts for this run (issue #401), as stored, except that each entry's `usage`
   * shows at most three records (`usage_more` counts the rest) and its `model_text` is left out.
   * Absent — never null — when the run has had none.
   */
  drive_failures?: DriveFailuresView;
  completed_steps: string[];
  in_progress_steps: string[];
  failed_steps: string[];
  /**
   * Q1 (#592) unit b: one entry per step in `failed_steps`, in its order, from the step's last
   * failed evidence entry (core's `composeFailures`, the one derivation `realm run inspect` prints
   * too). `[]` when nothing failed.
   */
  failures: FailureView[];
  skipped_steps: string[];
  // Gap 2, unit (iv-a2-ii): the gate's twin is never on the wire (its question is served in
  // `resolved_message` under `hidden`).
  pending_gate: Omit<import('@sensigo/realm').PendingGate, 'resolved_message_shaped'> | undefined;
  evidence_count: number;
  last_step: string | null;
  created_at: string;
  updated_at: string;
  params: Record<string, unknown>;
  abort_context?: {
    step_id: string;
    conditions?: Array<{ condition: string; resolved_value: unknown; passed: boolean }>;
    abort_message?: string;
  };
  /**
   * Eligible agent/handler steps for this run. Empty unless `next_actions_status` is `'ok'` —
   * except a `claim_stale` status may accompany still-actionable steps when a claim past its deadline
   * coexists with eligible work mid-fan-out (it overrides the status but does not hide the work).
   */
  next_actions: McpNextAction[];
  /** Diagnostic classification — distinguishes a genuinely-stuck run from "nothing pending". */
  next_actions_status: NextActionsStatus;
  /**
   * issue #729 PR-0 (D-8, T-22): the agent's next act on this run, read as an `ok` reply reads it —
   * `report_to_user` when nothing can be called and the run cannot go on, `await` when it waits on
   * another program's step; absent when a way is offered or the run has ended.
   */
  agent_action?: AgentAction;
  /** issue #729 PR-0 (P-2): on an `await` read — read the run again no sooner than this. */
  poll_after_ms?: number;
  /** #715 (b) (03 §C): which deadline set `poll_after_ms`. */
  poll_reason?: PollReason;
  /** issue #729 PR-0 (P-2): on an `await` read, the deadline the record states for the blocker. */
  until?: string;
  /** issue #729 PR-0 (A-1): reading and ending the run — never counted as a next step. */
  also?: McpAlsoEntry[];
  /** issue #729 PR-0 (D2 §5): ways only an operator can take, with why — never a command. */
  elsewhere?: McpElsewhereEntry[];
  /** issue #729 PR-0 (D-9): what the ways were judged on. */
  basis?: Basis;
  /**
   * Advisory (issue #101): non-healthy in-progress claims that are NOT the open-gate step —
   * present on any non-terminal run whenever such claims exist. This surfaces an after-claim wedge
   * even when the aggregate `next_actions_status` cannot show it: notably a `gate_waiting` run
   * (status stays `awaiting_human`) that carries a crashed sibling claim on another fan-out branch.
   * The `pending_gate` step is never included (it is legitimately pinned while its gate is open).
   */
  stuck_claims?: Array<{ step: string; state: ClaimState }>;
  /**
   * Issue #625 (the holder slice): who took each in-progress step — the host PROGRAM, how its name
   * is known, and the channel — or why there is no name (`holder_not_recorded`, `pre_lease_claim`,
   * `store_keeps_no_claims`, `name_unreadable`). `since` is when the claim was taken. Present on
   * any non-terminal run with an in-progress step. A step waiting on a person's answer names the
   * program through which the question was OPENED, and says nothing about anyone working on it now
   * (liveness is #592's). Never carries the claim's token.
   */
  step_claims?: Array<{ step: string; holder: Attributed | ActorAbsent; since?: string }>;
  /**
   * Advisory (issue #134): steps parked by a not-registered handler/adapter that are still eligible —
   * present on any non-terminal run whenever such markers exist. Definition-free (via
   * `findCapabilityBlockedSteps`), so it surfaces even on the `workflow_unresolved` path and behind a
   * healthy in-progress sibling. May coexist with `stuck_claims` on a fan-out run. Names the missing
   * requirement so an operator (or a pure-MCP consumer, via `execute_step` on the named step) can recover.
   */
  capability_blocks?: Array<{
    step: string;
    requirement: { kind: 'handler' | 'adapter'; name: string };
    code: string;
  }>;
  /**
   * Reason detail for each skipped step (issue #111) — present only when non-empty. Additive:
   * `skipped_steps` above stays the authoritative set; a skipped step may still lack an entry
   * here (a legacy run, or a skip family not yet carrying a detail).
   */
  skip_details?: Record<string, SkipDetail>;
  /**
   * Typed run-health findings (issue #221) — present only when non-empty. Computed by
   * `classifyRunHealth`, the SAME shared predicate the three READ surfaces (`get_run_state`,
   * `realm run list --stuck`, `realm run inspect`) derive from, so none of them can silently drift
   * from another about what "wedged" or "idle" means. (`realm run reclaim` reads the SAME
   * underlying record facts — settle sets, capability_blocks, reclaim-audit evidence — via its
   * own independent discriminator, `classifyNoActiveClaim`; it does not call this function.) This
   * is the CANONICAL SUPERSET of `stuck_claims`/`capability_blocks` above — those two legacy
   * arrays are KEPT for backward compatibility (existing consumers), but a new consumer should
   * prefer `run_health`. Never alters `next_actions_status` (fine-maps-to-coarse, never the
   * reverse — the systemd invariant): a wedge is surfaced here even when the aggregate status
   * cannot show it (notably a `gate_waiting` run, whose status MUST stay `awaiting_human`).
   */
  run_health?: RunHealthFinding[];
  /**
   * Names of steps that settled via their declared `validation_exhaustion.default_output`
   * substitution (issue #232) — present only when non-empty. Derived on demand from
   * `evidence[].diagnostics.settled_by_default` via the SAME shared `deriveDefaultedSteps` helper
   * `RunRecord.defaulted_steps` itself is stamped from (issue #220 PR-2), so this field is exact
   * (AC-2) and — for a `'complete'` run — identical to the persisted field (AC-4). Unlike the
   * persisted field, this is computed UNIFORMLY regardless of how the run sealed (complete,
   * failed, or aborted): a run that default-settles a step and then fails still surfaces it here,
   * closing the failure-path disclosure gap `defaulted_steps`'s complete-only stamping leaves.
   */
  defaulted_steps?: string[];
  /**
   * Advisory diagnostics for this response (issue #119: WARN-never-gate — never a throw, never a
   * behavior change). Independent sources, any subset may be present:
   *  - Store-fidelity caveats (issue #188): the configured run store does NOT declare it persists
   *    a load-bearing field this response depends on (`capability_blocks`) or the per-claim
   *    liveness clock (`claims`, via `persistsClaims`) — so a field reading absent/empty may be a
   *    store limitation rather than genuine absence (absence ≡ Unknown, never healthy-false).
   *  - A run-health presence line (issue #221): fires whenever `run_health` above is non-empty, so
   *    a consumer reading only `warnings` (not `run_health`) still learns something needs
   *    attention.
   */
  warnings?: string[];
  /**
   * Issue #600 PR 1b — one composed cost view per step (`step-view.ts`), present iff
   * `include_steps` was asked AND non-empty. Carried on terminal runs too — the same rule as
   * `drive_failures`. See `composeStepViews`'s own doc for the derivation.
   */
  steps?: Record<string, StepView>;
  /**
   * #872 (b1): how many asked steps after the last one shown the reply ceiling left out — read them
   * with `cursor` set to `next_cursor`. Present only with `next_cursor`.
   */
  steps_more?: number;
  /** #872 (b1): the last shown step's own id, when the reply ceiling left steps out: the next page's `cursor`. */
  next_cursor?: string;
  /** #872 (b1): how many `skip_details` entries the reply ceiling left out (an exact count). */
  skip_details_more?: number;
  /** #872 (b1): how many `engine_runnable` entries the reply ceiling left out (an exact count). */
  engine_runnable_more?: number;
  /** #872 (b1): how many `agent_refused` entries the reply ceiling left out (an exact count). */
  agent_refused_more?: number;
  /** #872 (b1): how many `capability_blocks` entries the reply ceiling left out (an exact count). */
  capability_blocks_more?: number;
  /** #872 (b1): how many `next_actions` entries beyond the first the reply ceiling left out. */
  next_actions_more?: number;
  /** #872 (b1) correction 1 (H4): how many `defaulted_steps` the reply ceiling left out. */
  defaulted_steps_more?: number;
  /** #872 (b1) correction 1 (H4): how many `skipped_steps` the reply ceiling left out. */
  skipped_steps_more?: number;
  /** #872 (b1) correction 1 (H4): how many `completed_steps` the reply ceiling left out. */
  completed_steps_more?: number;
  /** #872 (b1) correction 1 (H4): how many `waiting_on_answer` steps the reply ceiling left out. */
  waiting_on_answer_more?: number;
  /** #872 (b1) correction 1 (H4): how many `pending_guards` the reply ceiling left out. */
  pending_guards_more?: number;
  /** #872 (b1) correction 1 (H4): how many `step_claims` the reply ceiling left out. */
  step_claims_more?: number;
  /** #872 (b1) correction 1 (H4): how many `stuck_claims` the reply ceiling left out. */
  stuck_claims_more?: number;
  /** #872 (b1) correction 1 (H4): how many `in_progress_steps` the reply ceiling left out. */
  in_progress_steps_more?: number;
  /** Q1 (#592) unit b: how many `failures` the reply ceiling left out. */
  failures_more?: number;
  /** #872 (b1) correction 1 (H4): how many `failed_steps` the reply ceiling left out. */
  failed_steps_more?: number;
  /**
   * #872 (b1) correction 1 (H5): per kind, how many `run_health` findings were left out — at most
   * ten of a kind are shown. Absent when none was.
   */
  run_health_more?: Partial<Record<RunHealthFinding['kind'], number>>;
  /**
   * Issue #600 PR 1b (#611) — one cost per `drive_failures` entry, in the same order, present iff
   * `include_steps` was asked AND `drive_failures` is present. Lines up 1:1 with
   * `drive_failures.entries` — see `composeDriveFailureCosts`'s own doc.
   */
  drive_failure_costs?: DriveFailureCost[];
  /**
   * Issue #600 caching PR P — what the run cost, priced at read (`composeRunCost`): present iff
   * `include_steps` was asked. Unrounded USD; never stored.
   */
  run_cost?: RunCost;
  /** issue #625 PR-2a: guards the engine owes (a call to `advance_run` settles them); absent when none. */
  pending_guards?: string[];
  /**
   * issue #625 PR-2a: each eligible `auto` step the engine could run, judged for this server's
   * registry — `runnable_here` false names the check that refuses it (`refused_by`, `refusal`);
   * a capability refusal also says what it was judged from (`basis`: `registry` — this server's
   * registry lacks it; `marker` — no registry, the run's own record; decision C41);
   * `'unknown'` when the server has no registry to judge the capability check. Absent when none.
   */
  engine_runnable?: EngineRunnable[];
  /**
   * issue #625 PR-2a (decision C82): each eligible agent step the run refuses before its claim — a
   * failed precondition, or a `trust` value it refuses — in definition order, shaped as
   * `engine_runnable`'s refused entries (`step`, `runnable_here: false`, `refused_by`, `refusal`).
   * Such a step is never in `next_actions`. Absent when none.
   */
  agent_refused?: EngineRunnable[];
  /**
   * issue #625 PR-2a (decision C211): on a run an engine failure ended (phase `failed`), the failed
   * steps `realm run resume --from` takes and the command that makes them runnable again (core's
   * `offeredResumeWay`, F2 — never a cleanup step, never a run an operator ended: its
   * `terminal_reason` and `sealed_by_arm` say who ended it and why). Absent when it takes none, or
   * the run's workflow cannot be read.
   */
  resumable?: { steps: string[]; steps_more?: number; command: string };
  /**
   * issue #625 PR-2a (decision C211): on a run that has ended, the cleanup steps its ending left
   * `pending`, in the order the engine runs them, and the command that runs them (`realm run drain
   * <id> --force`, with code that has their handlers). Absent when none is pending. F12: `held_until`,
   * when another drainer's lease on one of them has not passed — the command runs nothing until that
   * time; realm cannot tell whether that drainer is still running.
   */
  cleanup_pending?: { steps: string[]; command: string; held_until?: string };
  /**
   * issue #625 PR-2a (decision C211): at an open question, the steps it holds — eligible by their
   * dependencies, they go on after the answer. Absent when none waits, or the run's workflow cannot
   * be read.
   */
  waiting_on_answer?: string[];
}

/**
 * #729 PR-0 (A-5, F-Y11; Amendment 16, Q19): the warning a read carries when this server could not
 * load the project's code — its code first (or that it carries none), then the loader's message
 * through the one escaped, bounded value renderer (E1 (b)).
 */
function loadFailureWarning(
  workflowId: string,
  code: LoadErrorCode,
  err: unknown,
  hideFailureText = false,
): string {
  const message = err instanceof Error ? err.message : String(err);
  // Gap 2, unit (iv-b1) correction 1, narrowed by (iv-b2b): a throw the door's rule marked as a
  // failure's words (the project's code threw while loading) shows as its shape, N its length as
  // thrown, in Realm's sentence; the code stays, and so does a sentence Realm wrote about the project.
  const shown = hideFailureText ? failureTextShape(message) : escapedBoundedValue(message);
  return `this server could not load the project code for workflow '${workflowId}' (${code === 'uncoded' ? 'no error code' : code}): ${shown}; no step can be run or advanced from this server until it loads.`;
}

/** #872 (b1): a refused `cursor` — the agent's own call, fixed by the agent (`VALIDATION_CURSOR`). */
function cursorRefusal(message: string): WorkflowError {
  return new WorkflowError(message, {
    code: 'VALIDATION_CURSOR',
    category: 'VALIDATION',
    agentAction: 'provide_input',
    retryable: false,
  });
}

/**
 * #872 (b1): the asked steps' detail, in first-attempt order (`composeStepViews`' own): every
 * attempted step's, or the named steps' (`step_names`); after `cursor` when one is given — its
 * position resolved in the FULL attempted-step order, then the selection filters. A name this run
 * has not attempted is named in `warnings` (ten named, then the count).
 */
function stepsAsked(
  all: Record<string, StepView>,
  named: readonly string[] | undefined,
  cursor: string | undefined,
  warnings: string[],
): Record<string, StepView> {
  const ids = Object.keys(all);
  if (named !== undefined) {
    const unknown = [...new Set(named)].filter((name) => !Object.hasOwn(all, name));
    warnings.push(
      ...boundedLines(
        unknown,
        (name) => `'${capText(name)}' is not a step this run has attempted`,
        (rest, total) =>
          `and ${rest} more ${rest === 1 ? 'name is not a step' : 'names are not steps'} this run has attempted (${total} in all)`,
      ),
    );
  }
  let from = 0;
  if (cursor !== undefined) {
    const at = ids.indexOf(cursor);
    if (at < 0) {
      throw cursorRefusal(
        `cursor '${capText(cursor)}' names no step this run has attempted; call again without a cursor to start from the first.`,
      );
    }
    from = at + 1;
  }
  const wanted = named !== undefined ? new Set(named) : undefined;
  return Object.fromEntries(
    ids
      .slice(from)
      .filter((id) => wanted === undefined || wanted.has(id))
      .map((id) => [id, all[id]!]),
  );
}

/** A list of get_run_state's plan, with its exact count in `<key>_more`. */
const runList = (key: string) => ({ kind: 'list' as const, key, moreKey: `${key}${MORE}` });

/**
 * #872 (b1): get_run_state's plan — what the reply ceiling may shorten, first cut first. Correction 1
 * (C1, H4): what the agent acts on survives longest. The run's own lists first (what it settled,
 * then what waits, then what is held or failed), the skip details among them, then the lists it acts
 * on later (`engine_runnable`, `agent_refused`, `capability_blocks`), `next_actions` beyond the
 * first, `params` replaced whole by its size (the caller's own input; never a prefix — I4), and LAST
 * `steps` — present only when the call asked for it (`include_steps` or `step_names`): that call's
 * payload, read page by page with `next_cursor`. Correction 2 (A): it is marked `payload`, so it is
 * cut only once no part before it can shed at all — never while an earlier part could still be
 * floored (correction 1's order alone let phase 1 cut `steps` whenever an earlier part could not
 * close the gap by itself).
 */
export const RUN_STATE_PLAN = replyPlanOf([
  runList('defaulted_steps'),
  runList('skipped_steps'),
  runList('completed_steps'),
  runList('skip_details'),
  runList('waiting_on_answer'),
  runList('pending_guards'),
  runList('step_claims'),
  runList('stuck_claims'),
  runList('in_progress_steps'),
  // Q1 (#592) unit b: before the kept names — the ceiling cuts the first list in this order that
  // can close the gap alone, so the failures are shortened before `failed_steps` is.
  runList('failures'),
  runList('failed_steps'),
  runList('engine_runnable'),
  runList('agent_refused'),
  runList('capability_blocks'),
  runList('next_actions'),
  {
    kind: 'omit',
    key: 'params',
    omitted: (raw) => ({ omitted: true, chars: JSON.stringify(raw).length }),
  },
  {
    kind: 'list',
    key: 'steps',
    moreKey: 'steps_more',
    marks: (ids) => (ids.length > 0 ? { next_cursor: ids[ids.length - 1] } : {}),
    markKeys: ['next_cursor'],
    // Correction 2 (A): the call's payload — shed only once nothing before it can shed.
    payload: true,
  },
]);

/**
 * Gap 2, unit (iv-b1): the run's drive failures with each entry's message shown as its shape — the
 * record's text measured, nothing else changed. `get_run_state` shows these under the failure-text
 * setting `hidden`, and judges `run_health` on them, so the `drive_failing` reason carries the shape
 * in Realm's own sentence.
 */
function driveFailuresHidingText(
  field: NonNullable<RunRecord['drive_failures']>,
): NonNullable<RunRecord['drive_failures']> {
  return {
    ...field,
    entries: field.entries.map((entry) =>
      typeof entry.message === 'string'
        ? { ...entry, message: failureTextShape(entry.message) }
        : entry,
    ),
  };
}

/**
 * Gap 2, unit (iv-b1): the dotted paths of the fields `get_run_state` shaped under the failure-text
 * setting — the walk's own spelling (`failures[0].message`) — for the receipt.
 */
function failureTextPaths(reply: {
  terminalReasonShaped: boolean;
  failures: readonly FailureView[];
  driveFailures?: DriveFailuresView;
  runHealth: readonly RunHealthFinding[];
  abortMessageShaped: boolean;
  loadWarningShaped: boolean;
}): string[] {
  return [
    ...(reply.terminalReasonShaped ? ['terminal_reason'] : []),
    ...reply.failures.flatMap((f, i) => ('message' in f ? [`failures[${i}].message`] : [])),
    ...(reply.driveFailures?.entries ?? []).flatMap((e, i) =>
      typeof e.message === 'string' ? [`drive_failures.entries[${i}].message`] : [],
    ),
    ...reply.runHealth.flatMap((f, i) =>
      f.kind === 'drive_failing' ? [`run_health[${i}].reason`] : [],
    ),
    ...(reply.abortMessageShaped ? ['abort_context.abort_message'] : []),
    // Correction 1: the list's own path — the walk does not descend into a list of strings by row.
    ...(reply.loadWarningShaped ? ['warnings'] : []),
  ];
}

/** A guard's evaluated condition, as `aborted_at.conditions` keeps it. */
type GuardCondition = NonNullable<NonNullable<RunRecord['aborted_at']>['conditions']>[number];

/**
 * Gap 2, unit (iv-a2-i): under the failure-text setting `hidden`, the copies of a failure's message
 * this read shows, each as its shape: a value a condition read from a message path (a skipped step's
 * `when` leaves in `skip_details`, a guard's `abort_context.conditions`), and a refused step's
 * precondition that read one (`engine_runnable`, `agent_refused`, `cannot_go_on`'s refused facts),
 * with core's shaped twins of its value and its sentence. With their paths, the walk's spelling, for
 * the receipt. Under `shown`, or with nothing to shape, each part as it is.
 */
function copiesHidingFailureText(parts: {
  hidden: boolean;
  skipDetails: Record<string, SkipDetail> | undefined;
  abortConditions: readonly GuardCondition[] | undefined;
  engineRunnable: EngineRunnable[];
  agentRefused: EngineRunnable[];
  runHealth: RunHealthFinding[];
}): {
  skipDetails?: Record<string, SkipDetail>;
  abortConditions?: GuardCondition[];
  engineRunnable: EngineRunnable[];
  agentRefused: EngineRunnable[];
  runHealth: RunHealthFinding[];
  paths: string[];
} {
  const paths: string[] = [];
  const unchanged = {
    engineRunnable: parts.engineRunnable,
    agentRefused: parts.agentRefused,
    runHealth: parts.runHealth,
    paths,
  };
  if (!parts.hidden) return unchanged;
  let skipChanged = false;
  const skipDetails = Object.fromEntries(
    Object.entries(parts.skipDetails ?? {}).map(([step, detail]) => {
      if (detail.kind !== 'when_false') return [step, detail];
      let changed = false;
      const leaves = detail.leaves.map((leaf, j) => {
        const shaped = conditionValueHidingFailureText(leaf.leaf, leaf.resolved_value);
        if (shaped === undefined) return leaf;
        changed = true;
        paths.push(`skip_details.${step}.leaves[${j}].resolved_value`);
        return { ...leaf, resolved_value: shaped };
      });
      skipChanged ||= changed;
      return [step, changed ? { ...detail, leaves } : detail];
    }),
  );
  let abortChanged = false;
  const abortConditions = (parts.abortConditions ?? []).map((c, j) => {
    const shaped = conditionValueHidingFailureText(c.condition, c.resolved_value);
    if (shaped === undefined) return c;
    abortChanged = true;
    paths.push(`abort_context.conditions[${j}].resolved_value`);
    return { ...c, resolved_value: shaped };
  });
  const refusals = (list: EngineRunnable[], key: string): EngineRunnable[] =>
    list.map((entry, j) => {
      const shaped = withPreconditionHidingFailureText(entry);
      if (shaped === undefined) return entry;
      paths.push(`${key}[${j}].refusal`, `${key}[${j}].precondition.value`);
      return shaped;
    });
  const engineRunnable = refusals(parts.engineRunnable, 'engine_runnable');
  const agentRefused = refusals(parts.agentRefused, 'agent_refused');
  const runHealth = parts.runHealth.map((finding, i) => {
    const refused = finding.kind === 'cannot_go_on' ? finding.evidence?.['refused'] : undefined;
    if (!Array.isArray(refused)) return finding;
    let changed = false;
    const shown = refused.map(
      (facts: { refusal?: string; precondition?: PreconditionFacts }, k) => {
        const shaped = withPreconditionHidingFailureText(facts);
        if (shaped === undefined) return facts;
        changed = true;
        paths.push(
          `run_health[${i}].evidence.refused[${k}].refusal`,
          `run_health[${i}].evidence.refused[${k}].precondition.value`,
        );
        return shaped;
      },
    );
    return changed ? { ...finding, evidence: { ...finding.evidence, refused: shown } } : finding;
  });
  return {
    ...(skipChanged ? { skipDetails } : {}),
    ...(abortChanged ? { abortConditions } : {}),
    engineRunnable,
    agentRefused,
    runHealth,
    paths,
  };
}

/**
 * Business logic for the get_run_state tool.
 * Returns a structured summary of the run without the full evidence array.
 */
export async function handleGetRunState(
  args: {
    run_id: string;
    include_steps?: boolean | undefined;
    step_names?: string[] | undefined;
    cursor?: string | undefined;
  },
  stores: HandleRunStateStores & WithDoorDisclosure,
): Promise<WithPersonBlock<RunStateSummary>> {
  assertToolStores(stores, 'handleGetRunState', ['runStore']);
  // #872 (b1): "asked" — every attempted step's detail, or the named steps' — read ONCE by every
  // gate below; a `cursor` pages the asked steps, so it is refused without them.
  const named =
    args.step_names !== undefined && args.step_names.length > 0 ? args.step_names : undefined;
  const asked = args.include_steps === true || named !== undefined;
  if (args.cursor !== undefined && !asked) {
    throw cursorRefusal('cursor pages steps: pass include_steps: true, or step_names, with it.');
  }
  const runStore = stores.runStore;
  // decision C172: a run that cannot be read is answered as the library answers it — the store's own
  // WorkflowError (issue #719: a damaged JSON-store run file is RESOURCE_FORMAT_INVALID,
  // STATE_LEGACY_FORMAT or ENGINE_STORE_FAILED, naming the file and its way out), or, for an
  // untyped throw, ENGINE_STORE_FAILED naming its cause. #729 PR-0 (A-9): through the one snapshot
  // constructor — the reading taken before the load is the one every judgement below uses.
  const snap = await loadSnapshot(runStore, args.run_id).catch((err: unknown) => {
    throw runReadError(err);
  });
  const run = snap.record;
  // Gap 2, unit (iv-b1): under the door's failure-text setting `hidden`, this composer shows every
  // failure's words as their shape, each field once, from the record (`failures[].message`,
  // `drive_failures.entries[].message`, the `drive_failing` reason, a handler's abort message and
  // `terminal_reason`, judged by the seal arm); the walk shapes nothing more.
  const hideFailureText = stores.door?.failureText.value === 'hidden';
  const hiddenDriveFailures =
    hideFailureText && run.drive_failures !== undefined
      ? driveFailuresHidingText(run.drive_failures)
      : undefined;
  const shownDriveFailures = hiddenDriveFailures ?? run.drive_failures;
  // Correction 1: whether the project-code load warning in `warnings` was shaped (set where it is
  // pushed).
  let loadWarningShaped = false;

  // #134 capability-block detection — definition-free (reads capability_blocks + the four step sets),
  // computed once and used both to refine the status (below) and as the advisory array (in the return).
  // Terminal guard mirrors stuck_claims: a sealed run surfaces nothing to do.
  const capabilityBlocks = run.terminal_state ? [] : findCapabilityBlockedSteps(run);

  // issue #188 field-fidelity gate: capability_blocks read above is only trustworthy if the
  // configured store actually persists it — a store that silently drops it makes a genuinely
  // blocked step look identical to "no blocks" ([] either way). Advisory only: this NEVER changes
  // capabilityBlocks/nextActionsStatus above, it only tells the consumer the read may be a store
  // limitation rather than a real absence.
  const warnings: string[] = [];
  if (!persistsField(runStore, 'capability_blocks')) {
    warnings.push(
      "this run store does not persist 'capability_blocks' — capability-block state is " +
        'unavailable and not authoritative (an empty result may mean "no blocks" or "this ' +
        'store cannot report blocks at all").',
    );
  }
  // issue #221: same pattern, for the per-claim liveness clock — NOT a LoadBearingRunRecordField
  // (persistsField would be the wrong gate; `claims` is keyed off the store's own `persistsClaims`
  // boolean instead, per RunStore's own contract). Absence ≡ Unknown, never healthy-false: a store
  // that cannot report claim liveness makes stale_claim/wedged_gate_sibling findings (and the
  // legacy stuck_claims array) unavailable, not falsely empty.
  if (runStore.persistsClaims !== true) {
    warnings.push(
      "this run store does not persist 'claims' — claim-liveness state is unavailable and not " +
        'authoritative (an empty result may mean "no wedge" or "this store cannot report claim ' +
        'liveness at all").',
    );
  }

  // Compute next_actions + diagnostic status (read-only). Precedence:
  // terminal → skipped_terminal; gate open → awaiting_human — unless its time is up and it declares
  // `on_expiry` (decision C95: carrying that out is owed engine work, read through the view below);
  // no/unresolved workflow → workflow_unresolved; else describePending → ok | advance_owed (issue
  // #625 PR-2a).
  const now = snap.at;
  // `definition` is hoisted (issue #221) so classifyRunHealth below can reuse it when resolved —
  // scoping/resolution logic here is otherwise UNCHANGED.
  let nextActionsStatus: NextActionsStatus;
  // #729 PR-0: the run's ways — composed ONCE by core's composer on this read's snapshot, with the
  // registry the view judged with (an observer when none), and rendered by the MCP door.
  let rendered: ReturnType<typeof renderWaysOf> | undefined;
  // #729 PR-0 (A-5, F-Y11; Amendment 16, Q19): this server's project code failed to load — nothing it
  // would run can be offered (`enactor_load_failed`), and a warning names the error.
  let loadFailed: LoadErrorCode | undefined;
  const waysNow = (): ReturnType<typeof renderWaysOf> => {
    rendered ??= renderWaysOf(
      composeWaysOn(snap, {
        definition: waysDefinition,
        enactor:
          loadFailed !== undefined
            ? { kind: 'load_failed', error_code: loadFailed }
            : registry !== undefined
              ? { kind: 'this_program', registry }
              : { kind: 'observer' },
        // #715 (b) (02 §C.1): with what the reply's instant stands on (`as_of_basis`).
        store: waysStoreOf(runStore),
        ...(waysSet !== undefined ? { disclosure: waysSet } : {}),
      }),
      mcpHostOf(stores),
    );
    return rendered;
  };
  // #729 PR-0 (A-5, T-21): the definition the ways are judged against, or why it is absent.
  let waysDefinition: WaysContext['definition'] = {
    absent: 'not_read',
    workflow_id: run.workflow_id,
  };
  let definition: WorkflowDefinition | undefined;
  // The filter-mask fix (B2): the door's set for the run's ways — asked once the definition is read
  // (no store read: a `run_step` way's prompt exists only with a definition).
  let waysSet: DisclosureSet | undefined;
  const waysOn = async (read: WorkflowDefinition): Promise<void> => {
    waysDefinition = { ok: read };
    waysSet ??= await disclosureOfTool(stores).setFor(read, run);
  };
  // issue #558 PR-T — the failure the definition read produced, when it produced one.
  let definitionError: { code: string; message: string; class?: string } | undefined;
  let pending: ReturnType<typeof describePending> | undefined;
  // decision C46: the registry the view judged with, passed to the run-health classifier too.
  let registry: ExtensionRegistry | undefined;
  // decision C211 (the architect's addendum; walk c14 W2-2): the read names what the record's lists
  // do not show — on a run that has ended, the failed steps `realm run resume` takes (`resumable`,
  // core's `offeredResumeWay`, F2: an engine failure only) and the cleanup steps left pending
  // (`cleanup_pending`); at an open question,
  // the steps it holds (`waiting_on_answer`). Each read of the workflow is best-effort: a workflow
  // that cannot be read leaves that field out.
  const readWorkflow = async (): Promise<WorkflowDefinition | undefined> => {
    if (stores?.workflowStore === undefined) return undefined;
    try {
      const read = await stores.workflowStore.get(run.workflow_id);
      await waysOn(read);
      return read;
    } catch (err) {
      const absence = definitionAbsenceOf(err, run);
      if (absence !== undefined) waysDefinition = absence;
      return undefined;
    }
  };
  let resumable: { steps: string[]; command: string } | undefined;
  let waitingOnAnswer: string[] = [];
  // F12: judged at this call's clock (a lease that has not passed holds the cleanup step).
  const cleanupPending = pendingCleanupWay(run, now);
  if (run.terminal_state) {
    nextActionsStatus = 'skipped_terminal';
    const ended = await readWorkflow();
    // F2: offered only for an engine failure — a run an operator ended carries its ending as data
    // (`terminal_reason`, `sealed_by_arm`), never the undo.
    resumable = ended === undefined ? undefined : offeredResumeWay(run, ended);
  } else if (run.pending_gate !== undefined && dueExpiry(run.pending_gate, now) === undefined) {
    nextActionsStatus = 'awaiting_human';
    // decision C103: the question is named by its answer — the `respond` way, never with the claim
    // token (only the reply that opened the question carries it). #729 PR-0 (T-21): answering reads
    // the definition, so the way is offered when the definition can be found.
    const held = await readWorkflow();
    waitingOnAnswer = held === undefined ? [] : waitingOnAnswerOf(held, run);
  } else {
    definition =
      stores?.workflowStore !== undefined
        ? await getWorkflowForRun(stores.workflowStore, run, {
            // R12 (walk 2): through the ONE composer, as every other surface — the raw store
            // sentence left this finding, the one an agent polls, with no way out and no repair.
            retryVerb: 'retry',
            verb: 'retry',
          }).catch((err: unknown) => {
            // issue #620 PR-C: a release-line refusal is a hand-off fault, not a definition fault.
            if (isReleaseLineRefusal(err)) throw err;
            // issue #558 PR-T — KEEP the failure: it feeds the `definition_unresolvable` finding
            // below instead of being discarded. Live runs only: the terminal guard at the
            // classify call is the pre-existing frozen R3 guard (#331), untouched here.
            definitionError = toDefinitionError(err);
            // #729 PR-0 (T-21): why the ways cannot be judged against it.
            const absence = definitionAbsenceOf(err, run);
            if (absence !== undefined) waysDefinition = absence;
            return undefined;
          })
        : undefined;
    if (definition !== undefined) await waysOn(definition);
    if (definition === undefined) {
      nextActionsStatus = 'workflow_unresolved';
    } else {
      // issue #625 PR-2a (decision C8): the registry the server resolves for every other tool, so
      // the capability check is judged; a failure falls back to none (`'unknown'`), except a
      // release-line refusal, which every registry-resolving tool raises.
      try {
        registry =
          stores?.registryProvider !== undefined
            ? await stores.registryProvider(definition)
            : stores?.registry;
        assertRegistryLine(
          registry,
          registryRole(stores, 'get_run_state', 'handleGetRunState'),
          ExtensionRegistry,
        );
      } catch (err) {
        if (isReleaseLineRefusal(err)) throw err;
        // The view keeps today's observer reading (no registry: a capability is `unknown`).
        registry = undefined;
        if (stores?.registryProvider !== undefined) {
          loadFailed = err instanceof WorkflowError ? err.code : 'uncoded';
          const words = hideFailureText && carriesFailureWords(err);
          warnings.push(loadFailureWarning(run.workflow_id, loadFailed, err, words));
          if (words) loadWarningShaped = true;
        }
      }
      pending = describePending(definition, snap, registry);
      nextActionsStatus = composeNextActionsStatusWord(pending) ?? 'ok';
    }

    // Wedge detection (issue #101) — definition-free (reads the stored per-claim deadline), so it
    // also refines the `workflow_unresolved` path. Carves the wedge states OUT of the
    // ok / advance_owed / workflow_unresolved fall-through:
    //  - a `claim_stale` claim (past its deadline) is surfaced even mid-fan-out;
    //  - when only unknown-age claims remain and there is nothing else to do, surface
    //    `claim_unknown_age` (detect-only). A `healthy` in-flight claim (its deadline ahead) stays 'ok'.
    if (run.in_progress_steps.length > 0) {
      // The open question's own step holds a claim while it waits (decision C95 reaches this block
      // with a question open, when its time is up): it is not work in flight, as `stuck_claims`
      // below says too.
      const claimStates = classifyInProgressClaims(snap)
        .filter((c) => c.step !== run.pending_gate?.step_name)
        .map((c) => c.state);
      if (claimStates.includes('claim_stale')) {
        nextActionsStatus = 'claim_stale';
      } else if (
        // F14 (review F-R5): only when a claim is left once the question's own is set aside — an
        // empty list is no claim in flight, never `claim_unknown_age`.
        claimStates.length > 0 &&
        waysNow().next_actions.length === 0 &&
        !claimStates.includes('healthy')
      ) {
        nextActionsStatus = 'claim_unknown_age';
      }
    }

    // #134 capability block outranks the claim-wedge states (a missing capability is a more specific,
    // actionable diagnosis than a stale/unknown-age claim) but ranks below `awaiting_human` — the gate
    // path returns above without entering this else block, so it wins naturally.
    //
    // issue #625 PR-2a (decision C33): with the definition, the status reads the VIEW — this
    // server's registry, or the run's marker when it has none — so a server that can run the step
    // says `advance_owed`, and one that cannot says `blocked_on_capability` before any attempt.
    // It is reported exactly when the view refuses an owed step for capability and offers no act.
    // Without the definition there is no view; the marker is then the only fact (the #134 rule).
    const blockedOnCapability =
      pending !== undefined
        ? pending.owed.length === 0 &&
          pending.engine_runnable.some((e) => e.refused_by === 'capability')
        : capabilityBlocks.length > 0;
    if (blockedOnCapability) {
      nextActionsStatus = 'blocked_on_capability';
    }
  }

  // Advisory wedge surfacing (issue #101), computed UNIFORMLY for every non-terminal path (gate,
  // workflow_unresolved, running) — definition-free. It never alters next_actions_status: on the
  // gate path the status MUST stay `awaiting_human` (drivers key on it), but a crashed non-gated
  // sibling claim on another fan-out branch is still surfaced here. The open-gate step is excluded.
  const stuckClaims = run.terminal_state
    ? []
    : classifyInProgressClaims(snap)
        .filter((c) => c.state !== 'healthy' && c.step !== run.pending_gate?.step_name)
        .map((c) => ({ step: c.step, state: c.state }));

  // issue #625 (holder slice): who took each in-progress step, read off the claim by the one reader.
  // Terminal guard as stuck_claims: a sealed run surfaces nothing to do. Never the claim's token.
  const stepClaims: Array<{ step: string; holder: Attributed | ActorAbsent; since?: string }> =
    run.terminal_state
      ? []
      : run.in_progress_steps.map((step) => {
          // #729 CW-1b part 2: the claim's lease fact, from the read's snapshot (no reply field
          // carries it: the reply is unchanged).
          const described = describeClaimHolder(
            run.claims?.[step],
            runStore.persistsClaims === true,
            leaseFactOf(snap, run.claims?.[step]),
          );
          const since = described.since !== undefined ? { since: described.since } : {};
          return 'holder' in described
            ? { step, holder: described.holder, ...since }
            : { step, holder: { by: null, absent_cause: described.absent_cause }, ...since };
        });

  // issue #600 PR 1b: the definition for the per-step cost view, resolved INDEPENDENTLY of the
  // status path above. A `definitionError` there must never suppress the view (the status path's
  // failure and the view's are different questions), and a view-resolution failure must never
  // leak into `definitionError`/`run_health`/`next_actions_status` — this block's `.catch` discards
  // its error unconditionally. Placed BEFORE `classifyRunHealth`: placed after it, a leak into
  // `definitionError` would change nothing observable, making the isolation untestable (mutant (i)
  // would be equivalent). Never called unless asked (`include_steps`) — a poll that does not ask
  // pays no extra registrar call, and a status-path failure already tried (`definitionError` set)
  // is not retried a second time — the view simply goes on without a definition.
  let viewDefinition: WorkflowDefinition | undefined = definition;
  if (
    asked &&
    viewDefinition === undefined &&
    definitionError === undefined &&
    stores?.workflowStore !== undefined
  ) {
    viewDefinition = await getWorkflowForRun(stores.workflowStore, run, {
      retryVerb: 'retry',
      verb: 'retry',
      terminalOk: true,
    }).catch((err: unknown) => {
      // issue #620 PR-C: never discard a release-line refusal.
      if (isReleaseLineRefusal(err)) throw err;
      return undefined;
    });
  }

  // issue #600 caching PR P: the run's prices, resolved only when the view is asked for.
  const shapedDetails = new Set<string>();
  const priceSource = asked
    ? await priceSourceFor(stores, viewDefinition, shapedDetails)
    : undefined;

  // issue #221: the SAME shared classifyRunHealth predicate the three READ surfaces (get_run_state,
  // list --stuck, inspect) derive from — computed definition-aware when the workflow resolved
  // above (adds eligible_steps evidence to any never_claimed_idle finding), definition-free
  // otherwise (gate / workflow_unresolved paths). Terminal guard mirrors stuck_claims/
  // capability_blocks: a sealed run surfaces nothing. `next_actions_status` above is computed and
  // finalized BEFORE this line runs — nothing below this point may write back to it.
  const runHealth: RunHealthFinding[] = run.terminal_state
    ? []
    : classifyRunHealth(
        // Gap 2, unit (iv-b1): judged on the drive failures as shown, so the `drive_failing` reason
        // is Realm's sentence around the message's shape (one call; nothing else differs).
        hiddenDriveFailures !== undefined
          ? { ...snap, record: { ...run, drive_failures: hiddenDriveFailures } }
          : snap,
        {
          ...(definition !== undefined ? { definition } : {}),
          ...(definitionError !== undefined ? { definitionError } : {}),
          // issue #625 PR-2a (decision C46): a server that can run a step is not told the step is
          // blocked by another runner's old capability marker.
          ...(registry !== undefined ? { registry } : {}),
        },
      );
  if (runHealth.length > 0) {
    warnings.push(
      `this run has ${runHealth.length} active run-health finding(s) — see 'run_health' for detail.`,
    );
  }

  const runHealthShown = boundedRunHealth(runHealth);

  // issue #232: read-time derivation (approach 2, DECIDED) — computed UNIFORMLY for every run
  // regardless of terminal state or seal outcome (no guard here, unlike stampDefaultedSteps'
  // complete-only stamping), via the SAME shared helper that stamping itself now calls.
  const defaultedSteps = deriveDefaultedSteps(run.evidence);

  // #872 (b1): the asked steps' page — composed before the reply so its unknown-name lines join
  // `warnings`. Gated non-empty below (composeStepViews returns `{}` for a step-free run).
  const stepsPage = asked
    ? stepsAsked(
        composeStepViews(run, {
          ...(viewDefinition !== undefined ? { definition: viewDefinition } : {}),
          ...(priceSource !== undefined ? { priceSource } : {}),
        }),
        named,
        args.cursor,
        warnings,
      )
    : undefined;

  // #729 PR-0 (D-8 row 2, T-22): this read's action word, as an `ok` reply on the same run reads it.
  const ways = waysNow();
  const agentAction = agentActionOf(undefined, 'ok', ways.rendered);

  // Gap 2, unit (iv-b1): the failure fields as shown — under `hidden`, each failure's words as their
  // shape, N the record's length (never the 500-character cut's); under `shown`, today's fields.
  const failures = composeFailures(run, hideFailureText ? { message: failureTextShape } : {});
  const shapedReason = hideFailureText ? terminalReasonHidingFailureText(run) : undefined;
  const shapedAbortMessage = hideFailureText ? abortMessageHidingFailureText(run) : undefined;
  const driveFailuresShown =
    shownDriveFailures !== undefined ? boundedDriveFailures(shownDriveFailures) : undefined;
  // Gap 2, unit (iv-a2-i): under `hidden`, the copies of a failure's message in condition values
  // and in a precondition's refusal, as their shape.
  const copies = copiesHidingFailureText({
    hidden: hideFailureText,
    skipDetails: run.skip_details,
    abortConditions: run.aborted_at?.conditions,
    engineRunnable: pending?.engine_runnable ?? [],
    agentRefused: pending?.agent_refused ?? [],
    runHealth: runHealthShown.shown,
  });
  // Gap 2, unit (iv-a2-ii): the live gate without its twin; under `hidden`, its question as core's
  // rule gives it (the twin, or the whole question as its shape when the store may have dropped it).
  const liveGate = run.terminal_state ? undefined : run.pending_gate;
  const gateQuestion =
    hideFailureText && liveGate !== undefined
      ? questionHidingFailureText(liveGate, run, runStore)
      : undefined;
  const pendingGate =
    liveGate === undefined
      ? undefined
      : (({ resolved_message_shaped: _twin, ...gate }) =>
          gateQuestion !== undefined ? { ...gate, resolved_message: gateQuestion } : gate)(
          liveGate,
        );
  const shapedPaths = hideFailureText
    ? [
        ...failureTextPaths({
          terminalReasonShaped: shapedReason !== undefined,
          failures,
          ...(driveFailuresShown !== undefined ? { driveFailures: driveFailuresShown } : {}),
          runHealth: copies.runHealth,
          abortMessageShaped: shapedAbortMessage !== undefined,
          loadWarningShaped,
        }),
        ...copies.paths,
        ...(gateQuestion !== undefined ? ['pending_gate.resolved_message'] : []),
      ]
    : [];

  /* eslint-disable-next-line no-restricted-syntax --
   * issue #367 (part 2), AUTHORIZED: this is an envelope ECHO of a stored value, not a writer.
   * Nothing here reaches a store — the object is the MCP response shape.
   */
  return withShapedDetailPaths(shapedDetails, {
    run_id: run.id,
    workflow_id: run.workflow_id,
    // issue #279 (increment 2, PR-C — D-3 leg vi): render the DERIVED phase, never the persisted
    // one — a grandfathered terminal-with-stale-gate record (the #282 class) must never report
    // itself as still 'gate_waiting'.
    run_phase: deriveRunPhase(run),
    terminal_state: run.terminal_state,
    completed_steps: run.completed_steps,
    in_progress_steps: run.in_progress_steps,
    failed_steps: run.failed_steps,
    failures,
    skipped_steps: run.skipped_steps,
    // Suppress a stale/leftover pending_gate on a terminal record (the #282 class) — never
    // surface a gate that no longer means anything live.
    pending_gate: pendingGate,
    evidence_count: run.evidence.length,
    last_step: run.evidence.at(-1)?.step_id ?? null,
    created_at: run.created_at,
    updated_at: run.updated_at,
    params: run.params,
    // #872 (b1): a reason over 500 characters is named by its length (I4), never echoed whole.
    ...(run.terminal_reason !== undefined
      ? { terminal_reason: capText(shapedReason ?? run.terminal_reason) }
      : {}),
    // issue #558 PR-C: the supersede link — the ONE explicit route onto this surface (there is no
    // `keyof RunRecord` disclosure registry to join, so the cell below is the parity guard).
    ...(run.rerun_of !== undefined ? { rerun_of: run.rerun_of } : {}),
    // issue #367: an unrecognised arm is DISCLOSED, never dropped — omitting it would report a
    // sealed run as unsealed, which is the false attestation this whole change exists to end.
    ...(run.sealed_by !== undefined
      ? {
          sealed_by_arm: (SEAL_ARMS as readonly string[]).includes(run.sealed_by.arm)
            ? run.sealed_by.arm
            : `unrecognized arm '${run.sealed_by.arm}'`,
          // issue #367 (part 5): the ruling, the classifier marker, and the step — each key ABSENT
          // when its field is absent, never null (walk-never-ran is not the same as no value).
          ...(run.sealed_by.adjudicated !== undefined
            ? { sealed_by_adjudicated: run.sealed_by.adjudicated }
            : {}),
          ...(run.sealed_by.classified === true ? { sealed_by_classified: true as const } : {}),
          // The deterministic-arm fork, identical to inspect's — see the field's own doc for why
          // a settle-order step must not reach an agent as if it were the culprit.
          ...(run.sealed_by.step !== undefined &&
          (run.sealed_by.arm.startsWith('guard_') ||
            run.sealed_by.arm.startsWith('gate_') ||
            run.sealed_by.arm === 'handler_abort')
            ? { sealed_by_step: run.sealed_by.step }
            : {}),
          // #625 PR-2b, the actor unit: who ended it and with what, each absent when not recorded.
          ...(run.sealed_by.by !== undefined
            ? { sealed_by_actor: sealedByActorOf(run.sealed_by.by) }
            : {}),
          ...(run.sealed_by.door !== undefined
            ? {
                sealed_by_door: (SEAL_DOORS as readonly string[]).includes(run.sealed_by.door)
                  ? run.sealed_by.door
                  : `unrecognized door '${run.sealed_by.door}'`,
              }
            : {}),
        }
      : {}),
    // issue #401: failed drive attempts, verbatim and additively — absent, never null, so an
    // agent can tell "no failures" from "this surface does not report them".
    // #872 (b1) correction 1 (H7): each entry's billed requests at most three, then the count.
    ...(driveFailuresShown !== undefined ? { drive_failures: driveFailuresShown } : {}),
    ...(run.aborted_at !== undefined
      ? {
          abort_context:
            shapedAbortMessage !== undefined || copies.abortConditions !== undefined
              ? {
                  ...run.aborted_at,
                  ...(shapedAbortMessage !== undefined
                    ? { abort_message: shapedAbortMessage }
                    : {}),
                  ...(copies.abortConditions !== undefined
                    ? { conditions: copies.abortConditions }
                    : {}),
                }
              : run.aborted_at,
        }
      : {}),
    next_actions: ways.next_actions,
    next_actions_status: nextActionsStatus,
    ...(agentAction !== undefined ? { agent_action: agentAction } : {}),
    // #715 (b) (03 §C, D6-71): the pace from the record's deadlines, at this read's reading.
    ...(agentAction === 'await'
      ? {
          poll_after_ms: ways.pace.poll_after_ms,
          poll_reason: ways.pace.poll_reason,
          ...(ways.pace.until !== undefined ? { until: ways.pace.until } : {}),
        }
      : {}),
    ...(ways.also.length > 0 ? { also: ways.also } : {}),
    ...(ways.elsewhere.length > 0 ? { elsewhere: ways.elsewhere } : {}),
    ...(ways.narrowed !== undefined ? { basis: ways.narrowed.basis } : {}),
    ...(ways.person !== undefined ? { [PERSON_BLOCK]: ways.person } : {}),
    ...(stuckClaims.length > 0 ? { stuck_claims: stuckClaims } : {}),
    ...(stepClaims.length > 0 ? { step_claims: stepClaims } : {}),
    ...(capabilityBlocks.length > 0
      ? {
          capability_blocks: capabilityBlocks.map((b) => ({
            step: b.step,
            requirement: b.requirement,
            code: b.code,
          })),
        }
      : {}),
    ...(run.skip_details !== undefined && Object.keys(run.skip_details).length > 0
      ? { skip_details: copies.skipDetails ?? run.skip_details }
      : {}),
    // #872 (b1) correction 1 (H5): at most ten findings of a kind; `run_health_more` counts the rest.
    ...(copies.runHealth.length > 0 ? { run_health: copies.runHealth } : {}),
    ...(Object.keys(runHealthShown.more).length > 0
      ? { run_health_more: runHealthShown.more }
      : {}),
    ...(defaultedSteps.length > 0 ? { defaulted_steps: defaultedSteps } : {}),
    // issue #600 PR 1b: `steps`/`drive_failure_costs`, present iff asked. `steps` is additionally
    // gated non-empty (composeStepViews returns `{}` for a step-free run); `drive_failure_costs`
    // is gated on `drive_failures` itself, never on its own emptiness (an empty array is still the
    // honest answer for a run whose drive_failures.entries carry no usage — the field's PRESENCE
    // is what "asked and there IS a drive_failures" means).
    ...(stepsPage !== undefined && Object.keys(stepsPage).length > 0 ? { steps: stepsPage } : {}),
    ...(asked && run.drive_failures !== undefined
      ? {
          drive_failure_costs: composeDriveFailureCosts(
            run,
            priceSource !== undefined ? { priceSource } : undefined,
          ),
        }
      : {}),
    ...(asked && priceSource !== undefined
      ? (() => {
          const runCost = composeRunCost(run, {
            ...(viewDefinition !== undefined ? { definition: viewDefinition } : {}),
            priceSource,
          });
          return runCost !== undefined ? { run_cost: runCost } : {};
        })()
      : {}),
    ...(pending !== undefined && pending.pending_guards.length > 0
      ? { pending_guards: pending.pending_guards }
      : {}),
    ...(pending !== undefined && pending.engine_runnable.length > 0
      ? { engine_runnable: copies.engineRunnable }
      : {}),
    ...(pending !== undefined && pending.agent_refused.length > 0
      ? { agent_refused: copies.agentRefused }
      : {}),
    // #872 (b1) correction 1 (H7): at most ten steps; the command's placeholder is core's bounded one.
    ...(resumable !== undefined ? { resumable: boundedResumable(resumable) } : {}),
    ...(cleanupPending !== undefined ? { cleanup_pending: cleanupPending } : {}),
    ...(waitingOnAnswer.length > 0 ? { waiting_on_answer: waitingOnAnswer } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
    // Gap 2, unit (iv-b1): what this composer shaped, for the receipt (never serialized).
    ...(shapedPaths.length > 0 ? { [FAILURE_TEXT_SHAPED]: shapedPaths } : {}),
  });
}

/** Gap 2, unit (iv-b2b): `reply` with the paths of its shaped not-priced details, for the receipt. */
function withShapedDetailPaths(
  shaped: ReadonlySet<string>,
  reply: WithPersonBlock<RunStateSummary>,
): WithPersonBlock<RunStateSummary> {
  const paths =
    shaped.size > 0 ? shapedDetailPaths(reply, RUN_STATE_SUMMARY_TABLE, '', shaped) : [];
  if (paths.length === 0) return reply;
  return { ...reply, [FAILURE_TEXT_SHAPED]: [...(reply[FAILURE_TEXT_SHAPED] ?? []), ...paths] };
}

/** Registers the get_run_state MCP tool on the server. */
export function registerGetRunState(
  server: McpServer,
  opts: HandleRunStateStores & WithDoorDisclosure,
): void {
  markServedByTool(opts);
  const door = disclosureOfTool(opts);
  server.registerTool(
    'get_run_state',
    {
      ...toolMeta('get_run_state'),
      description:
        'Get the current state summary of a workflow run. Pass include_steps: true for each ' +
        "step's model-call cost per attempt, or step_names for the named steps only. When the reply " +
        'leaves steps out it names next_cursor: pass it as cursor for the next page.',
      inputSchema: boundedRefusal(
        z.object({
          run_id: z.string(),
          include_steps: z.boolean().optional(),
          step_names: z.array(z.string()).optional(),
          cursor: z.string().optional(),
        }),
      ),
      // CP-2: the published schema's two shapes under one object root; every result below carries
      // the object its JSON text serializes, checked against this before it leaves.
      outputSchema: runStateWireSchema(),
    },
    safeTool(
      async (args) => {
        const result = await handleGetRunState(args, opts);
        return toolContentWithTwinOf(
          { ...result },
          {
            set: await setForSubject(door, await replySubject(opts, { runId: args.run_id })),
            audience: 'agent',
            table: RUN_STATE_SUMMARY_TABLE,
          },
          RUN_STATE_PLAN,
          runStateWireFloor,
        );
      },
      async (err, args) => {
        const workflowErr =
          err instanceof WorkflowError
            ? err
            : new WorkflowError(err instanceof Error ? err.message : String(err), {
                code: 'ENGINE_INTERNAL',
                category: 'ENGINE',
                agentAction: 'report_to_user',
                retryable: false,
              });
        const refusedCursor = err instanceof WorkflowError && err.code === 'VALIDATION_CURSOR';
        const contextHint =
          err instanceof WorkflowError && err.code === 'STATE_RUN_NOT_FOUND'
            ? `Run '${args.run_id}' not found.`
            : refusedCursor
              ? "get_run_state's cursor was refused; call again as errors[0] says."
              : `An error occurred while loading run state.`;
        // issue #625 PR-2a: the code and details, as every other tool's error reply — a release-line
        // refusal from the registry this tool now resolves names its role there. #729 PR-0
        // (Amendments 9, 11): `error_details` through the ONE carrier — a #719 error's typed facts,
        // else the untouched details.
        const rendered = renderReply(
          buildPreExecutionErrorEnvelope('get_run_state', args.run_id, 0, workflowErr, contextHint),
          mcpHostOf(opts),
        );
        // This reply's field set is as before PR-0: no run was read (no version), and an untyped
        // throw names no code.
        const { run_version: _version, error_code: _code, ...envelope } = rendered.envelope;
        // CP-2: a refusal stays an ordinary result; it carries its envelope as the second shape.
        return toolContentWithTwinOf(
          {
            ...envelope,
            ...(err instanceof WorkflowError ? { error_code: err.code } : {}),
            // #872 (b1): the agent fixes its own call — the pre-execution resolver's
            // `report_to_user` is not this refusal's way.
            ...(refusedCursor ? { agent_action: 'provide_input' as const } : {}),
          },
          {
            set: await setForSubject(door, await replySubject(opts, { runId: args.run_id })),
            audience: 'agent',
            table: MCP_ENVELOPE_TABLE,
          },
          undefined,
          runStateWireFloor,
        );
      },
      SAFE_TOOL_CONSTANT_RUNLESS,
    ),
  );
}
