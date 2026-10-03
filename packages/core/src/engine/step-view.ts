// step-view.ts — issue #600 PR 1b: one cost view per step, derived ONCE in core, rendered by
// EVERY operator/agent surface that shows what a run's model calls cost (`realm run inspect`,
// `get_run_state`'s `include_steps`).
//
// Before this file, `packages/cli/src/commands/inspect.ts` computed its own sums directly off
// `StepDiagnostics.cache`/`DriveFailureRecord.usage`, and `get_run_state` had no per-step surface
// at all. Two independent implementations of "how do you sum a per-request counter honestly" is
// how the two surfaces could disagree about one number; this file is the ONE place that rule
// lives now.
//
// TOTALITY, following the `buildEntry` precedent (drive-failure.ts): no input a store can hand
// these functions — a non-array, `null` entries, non-object entries, `evidence` or
// `drive_failures` shaped wrong — makes any of them throw. A malformed record degrades to an
// absence or an `'unknown'` field, never an exception that takes the whole render down with it.
import type { RunRecord } from '../types/run-record.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
import {
  readDrivenBy,
  readGateClaimVerdict,
  readStoredName,
  type ActorAbsent,
  type Attributed,
  type ClaimProofAbsentCause,
  type GateClaimVerdict,
} from './holder.js';

/**
 * One figure and the scope it was summed over. Never a guess, never a default — `value` is the sum
 * over ONLY the requests that reported the counter (`typeof === 'number'`; `null` is one of the
 * two absence spellings a provider's own type allows and is never coerced to `0`). A counter no
 * request reported has no `CostFigure` at all — the caller's absence, never a manufactured zero.
 */
export interface CostFigure {
  /** Sum over the requests that REPORTED this counter. */
  value: number;
  /** How many requests reported it. Always >= 1 — a figure nobody reported is ABSENT, not zero. */
  reported: number;
  /** How many requests this cost holds, whether or not each one reported this counter. */
  of: number;
  /** 0-based index into the requests. Present iff `reported === 1` — the one request it came from. */
  only_request_index?: number;
}

export interface CostView {
  requests: number;
  /** Verbatim when a string; absent when absent or `null` — never a re-derived guess. */
  basis?: string;
  /** Verbatim when a string; absent otherwise. */
  state?: string;
  /** `UsageRecord.prompt_tokens`. */
  prompt?: CostFigure;
  /** `UsageRecord.uncached_input_tokens`. */
  uncached_input?: CostFigure;
  /** `UsageRecord.cache_read_input_tokens`. */
  cache_read?: CostFigure;
  /**
   * `cache_creation_input_tokens`, else `cache_write_tokens` — the first one PRESENT per request,
   * never summed together (the two are alternative spellings of one provider fact, never two
   * components of it).
   */
  cache_write?: CostFigure;
  /** `UsageRecord.output_tokens`. */
  output?: CostFigure;
}

/**
 * The closed set of reasons a step's evidence entry carries no `cache` at all. Classification only
 * ever picks between these two — it never asserts a model call happened (see `composeStepViews`
 * rule 5): `tool_calling_step` when the entry declares `tool_calls` (the tool-calling path records
 * no usage yet, issue #610); `not_driven_by_realm` for an agent step whose calls realm's own driver
 * never saw (an outside agent over MCP `execute_step`, an answer typed at a `realm workflow run`
 * prompt, or a record written before usage was measured).
 */
export const COST_UNRECORDED_CAUSES = ['tool_calling_step', 'not_driven_by_realm'] as const;
export type CostUnrecordedCause = (typeof COST_UNRECORDED_CAUSES)[number];

export interface AttemptView {
  /** 1-based position among the step's EXECUTION entries (gate_response entries are never attempts). */
  attempt: number;
  /** The entry's `status`, verbatim when a string, else `'unknown'`. */
  status: string;
  cost?: CostView;
  cost_unrecorded?: CostUnrecordedCause;
  /** The entry carried a `cache` whose `requests` is not an array — present, not readable. */
  cost_unreadable?: true;
  /**
   * Issue #625 (the holder slice): the host PROGRAM whose code and credentials did this attempt's
   * work — read by the one reader every stored `Attributed` goes through. `driver_not_recorded`
   * when the entry carries none (it predates the field, or no host passed a name);
   * `name_unreadable` when what it carries is not a readable name with its source.
   */
  driven_by: Attributed | ActorAbsent;
}

/**
 * Issue #625 (the holder slice): one human answer to a step's question — read off a
 * `gate_response` entry. `answered_by` is the caller-STATED, unverified name (`stated` is true by
 * construction: the field's only producer is a caller-declared string), or why there is none.
 * `claim_proof` is the verdict recorded on the entry; when there is none, `claim_proof_absent`
 * says why — never a blank.
 */
export interface AnswerView {
  choice?: string;
  answered_by: { by: string; by_source: 'stated' } | ActorAbsent;
  claim_proof?: GateClaimVerdict;
  claim_proof_absent?: ClaimProofAbsentCause;
}

export interface StepView {
  attempts: AttemptView[];
  /** One per `gate_response` entry, in entry order. Absent when the step has no answer. */
  answers?: AnswerView[];
}

/** Reads a numeric field off an unknown entry, returning `undefined` for anything but a real number
 *  (never coercing `null`, which is one of the two absence spellings a provider's own type allows). */
function numField(entry: unknown, key: string): number | undefined {
  if (typeof entry !== 'object' || entry === null) return undefined;
  const v = (entry as Record<string, unknown>)[key];
  return typeof v === 'number' ? v : undefined;
}

/** `cache_creation_input_tokens`, else `cache_write_tokens` — first present, never summed. */
function cacheWriteField(entry: unknown): number | undefined {
  const a = numField(entry, 'cache_creation_input_tokens');
  if (a !== undefined) return a;
  return numField(entry, 'cache_write_tokens');
}

/** The one summation rule, shared by every counter this file derives. */
function sumFigure(
  requests: readonly unknown[],
  pick: (entry: unknown) => number | undefined,
): CostFigure | undefined {
  const of = requests.length;
  let total = 0;
  let reported = 0;
  let onlyIndex = 0;
  for (let i = 0; i < of; i += 1) {
    const v = pick(requests[i]);
    if (typeof v === 'number') {
      total += v;
      reported += 1;
      onlyIndex = i;
    }
  }
  if (reported === 0) return undefined;
  return {
    value: total,
    reported,
    of,
    ...(reported === 1 ? { only_request_index: onlyIndex } : {}),
  };
}

/**
 * The per-request detail, composed into one roll-up. Returns `undefined` only for a non-array
 * `requests` — an empty array yields `{ requests: 0 }`, a fact distinct from absence (D1 rule 6).
 */
export function composeCostView(
  requests: unknown,
  extra?: { basis?: unknown; state?: unknown },
): CostView | undefined {
  if (!Array.isArray(requests)) return undefined;
  const view: CostView = { requests: requests.length };
  if (typeof extra?.basis === 'string') view.basis = extra.basis;
  if (typeof extra?.state === 'string') view.state = extra.state;
  const prompt = sumFigure(requests, (r) => numField(r, 'prompt_tokens'));
  if (prompt !== undefined) view.prompt = prompt;
  const uncachedInput = sumFigure(requests, (r) => numField(r, 'uncached_input_tokens'));
  if (uncachedInput !== undefined) view.uncached_input = uncachedInput;
  const cacheRead = sumFigure(requests, (r) => numField(r, 'cache_read_input_tokens'));
  if (cacheRead !== undefined) view.cache_read = cacheRead;
  const cacheWrite = sumFigure(requests, cacheWriteField);
  if (cacheWrite !== undefined) view.cache_write = cacheWrite;
  const output = sumFigure(requests, (r) => numField(r, 'output_tokens'));
  if (output !== undefined) view.output = output;
  return view;
}

/** A stored `responded_by` as an answer view shows it. Total. */
function readAnswerer(raw: unknown): AnswerView['answered_by'] {
  if (raw === undefined || raw === null) return { by: null, absent_cause: 'not_stated' };
  if (typeof raw !== 'string') return { by: null, absent_cause: 'name_unreadable' };
  // A value the tool accepted before the name bound existed can be empty: it reads as no name.
  if (raw.trim().length === 0) return { by: null, absent_cause: 'not_stated' };
  const name = readStoredName(raw);
  if (name === undefined) return { by: null, absent_cause: 'name_unreadable' };
  return { by: name, by_source: 'stated' };
}

/** One `gate_response` entry as an answer. Total. */
function composeAnswerView(entry: Record<string, unknown>): AnswerView {
  const input = entry['input_summary'];
  const output = entry['output_summary'];
  const inputChoice =
    typeof input === 'object' && input !== null
      ? (input as Record<string, unknown>)['choice']
      : undefined;
  const outputChoice =
    typeof output === 'object' && output !== null
      ? (output as Record<string, unknown>)['choice']
      : undefined;
  const choice =
    typeof inputChoice === 'string'
      ? inputChoice
      : typeof outputChoice === 'string'
        ? outputChoice
        : undefined;
  const answer: AnswerView = { answered_by: readAnswerer(entry['responded_by']) };
  if (choice !== undefined) answer.choice = choice;
  const proof = readGateClaimVerdict(entry['claim_proof']);
  if (proof !== undefined) {
    answer.claim_proof = proof;
  } else if (entry['claim_proof'] !== undefined) {
    answer.claim_proof_absent = 'proof_unreadable';
  } else if (entry['resolution'] !== undefined) {
    answer.claim_proof_absent = 'settled_by_expiry';
  } else {
    answer.claim_proof_absent = 'proof_not_recorded';
  }
  return answer;
}

/** True when a definition resolves and names `stepId` an `execution: 'agent'` step. */
function definitionSaysAgent(
  stepId: string,
  definition: WorkflowDefinition | undefined,
): boolean | undefined {
  if (definition === undefined) return undefined;
  const stepDef = definition.steps[stepId];
  if (stepDef === undefined) return undefined;
  return stepDef.execution === 'agent';
}

/**
 * One `StepView` per `step_id` that has at least one EXECUTION entry (rule 3) — or at least one
 * ANSWER (issue #625): a `gate_response` entry is never an attempt, but it is a fact the step's view
 * must carry, so it creates the step's view with `attempts: []` when no execution entry exists. An
 * entry that is not an object, or has no string `step_id`, is skipped entirely (rule 1's totality).
 *
 * Cost comes from `cache` alone, never from classification (rule 4) — this holds whatever the
 * definition says, and whether or not one exists at all: an `execution: 'auto'` step whose entry
 * still carries a `cache` object gets its cost rendered exactly like an agent step's would.
 * Classification (rule 5) only picks the ABSENCE cause for an entry with no `cache`.
 */
export function composeStepViews(
  run: RunRecord,
  deps?: { definition?: WorkflowDefinition },
): Record<string, StepView> {
  const evidence: unknown = run.evidence;
  const list: readonly unknown[] = Array.isArray(evidence) ? evidence : [];
  const result: Record<string, StepView> = {};
  for (const raw of list) {
    if (typeof raw !== 'object' || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    const stepId = entry['step_id'];
    if (typeof stepId !== 'string') continue;
    const kind = entry['kind'];
    if (kind === 'gate_response') {
      // Never an attempt; an answer. It creates the step's view when there is no execution entry.
      const answerStep = (result[stepId] ??= { attempts: [] });
      (answerStep.answers ??= []).push(composeAnswerView(entry));
      continue;
    }
    const isExecution = kind === undefined || kind === 'execution';
    if (!isExecution) continue; // any other kind — never an attempt.

    const view = (result[stepId] ??= { attempts: [] });
    const statusRaw = entry['status'];
    const status = typeof statusRaw === 'string' ? statusRaw : 'unknown';
    const attempt: AttemptView = {
      attempt: view.attempts.length + 1,
      status,
      driven_by: readDrivenBy(entry),
    };

    const diagnostics = entry['diagnostics'];
    const diag = typeof diagnostics === 'object' && diagnostics !== null ? diagnostics : undefined;
    const cache = (diag as Record<string, unknown> | undefined)?.['cache'];
    if (typeof cache === 'object' && cache !== null) {
      const cacheObj = cache as Record<string, unknown>;
      const requestsField = cacheObj['requests'];
      if (Array.isArray(requestsField)) {
        const cv = composeCostView(requestsField, {
          basis: cacheObj['basis'],
          state: cacheObj['state'],
        });
        if (cv !== undefined) attempt.cost = cv;
      } else {
        attempt.cost_unreadable = true;
      }
    } else {
      // Rule 5 — classification, only ever for an entry with no `cache` at all.
      if (entry['tool_calls'] !== undefined) {
        attempt.cost_unrecorded = 'tool_calling_step';
      } else {
        const byDefinition = definitionSaysAgent(stepId, deps?.definition);
        const isAgentStep = byDefinition ?? entry['agent_profile'] !== undefined;
        if (isAgentStep) attempt.cost_unrecorded = 'not_driven_by_realm';
        // Otherwise: a handler step. Nothing was ever going to be recorded — no annotation at all.
      }
    }
    view.attempts.push(attempt);
  }
  return result;
}

/** One drive-failure entry's cost. Named once here; `get_run_state` reuses it, never re-declares it. */
export interface DriveFailureCost {
  at?: string;
  step?: string;
  error_class?: string;
  cost?: CostView;
}

/**
 * Lines up 1:1 with `run.drive_failures.entries` (rule 6): one element per entry, in order, even a
 * malformed one — its string fields are simply absent rather than a hand-typed field holding
 * `undefined`. `cost` is present iff the entry's `usage` is an array; a `composeCostView` built from
 * a bare `usage` carries no `basis`/`state` (a drive failure's usage carries no classification).
 */
export function composeDriveFailureCosts(run: RunRecord): DriveFailureCost[] {
  const driveFailures: unknown = run.drive_failures;
  if (typeof driveFailures !== 'object' || driveFailures === null) return [];
  const entriesField = (driveFailures as Record<string, unknown>)['entries'];
  if (!Array.isArray(entriesField)) return [];
  const result: DriveFailureCost[] = [];
  for (const raw of entriesField) {
    const out: DriveFailureCost = {};
    if (typeof raw === 'object' && raw !== null) {
      const rec = raw as Record<string, unknown>;
      if (typeof rec['at'] === 'string') out.at = rec['at'];
      if (typeof rec['step'] === 'string') out.step = rec['step'];
      if (typeof rec['error_class'] === 'string') out.error_class = rec['error_class'];
      const usage = rec['usage'];
      if (Array.isArray(usage)) {
        const cv = composeCostView(usage);
        if (cv !== undefined) out.cost = cv;
      }
    }
    result.push(out);
  }
  return result;
}
