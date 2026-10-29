// Structured, categorized error class used throughout the engine.
import type { LoaderWarning } from '../workflow/diagnostics.js';
import type { UnreadableFileFacts, UnreadableRunFilesFacts } from '../store/run-file.js';
import type { WayOn } from '../engine/ways.js';
import type { ErrorObject } from 'ajv';
import { brandClass, REALM_BRAND } from '../brand.js';

export type ErrorCategory = 'NETWORK' | 'SERVICE' | 'STATE' | 'VALIDATION' | 'ENGINE' | 'RESOURCE';

/**
 * What an agent does next (engine-owned, R3). `wait_for_service`: an outside service is unavailable —
 * wait, then try again (issue #729 PR-0, D4 P-2: renamed from `wait_for_human`, every vocabulary read
 * uses "human" for a person). `await`: the run waits on someone else — a person's answer or another
 * program's step (D3 A-2); its replies carry `poll_after_ms` and, when the record states one, `until`.
 */
export type AgentAction =
  | 'report_to_user'
  | 'provide_input'
  | 'resolve_precondition'
  | 'stop'
  | 'wait_for_service'
  | 'wait_and_proceed'
  | 'await';

/** Every {@link AgentAction}, in declaration order — the closed list a renderer's table is checked against. */
export const AGENT_ACTIONS = [
  'report_to_user',
  'provide_input',
  'resolve_precondition',
  'stop',
  'wait_for_service',
  'wait_and_proceed',
  'await',
] as const satisfies readonly AgentAction[];

export type ErrorCode =
  // NETWORK
  | 'NETWORK_TIMEOUT'
  | 'NETWORK_UNREACHABLE'
  | 'NETWORK_DNS_FAILED'
  | 'NETWORK_CONNECTION_RESET'
  // SERVICE
  | 'SERVICE_HTTP_4XX'
  | 'SERVICE_HTTP_5XX'
  | 'SERVICE_RATE_LIMITED'
  | 'SERVICE_AUTH_FAILED'
  | 'SERVICE_NOT_FOUND'
  | 'SERVICE_RESPONSE_INVALID'
  // a 3xx redirect where a direct response was required (e.g. on a write) — non-retryable
  | 'SERVICE_UNEXPECTED_REDIRECT'
  // STATE
  | 'STATE_BLOCKED'
  | 'STATE_PRECONDITION_FAILED'
  | 'STATE_RUN_NOT_FOUND'
  | 'STATE_WORKFLOW_NOT_FOUND'
  // issue #558 PR-T: the registered copy EXISTS (or its registry does) but cannot be read —
  // permission, a directory where a file belongs, or an unreadable registry directory.
  | 'STATE_WORKFLOW_UNREADABLE'
  | 'STATE_RUN_TERMINAL'
  | 'STATE_SNAPSHOT_MISMATCH'
  | 'STATE_RUN_LOCKED'
  // a deleteAllForRun-owning store could not acquire its run-file (or key) lock (ELOCKED), or —
  // under that lock — found the run is no longer terminal (a concurrent resume raced the purge).
  // Retryable: a live writer self-heals, and a stale lock is eventually stolen (issue #184).
  | 'STATE_RUN_BUSY'
  | 'STATE_TRANSITION_DENIED'
  // gc's orphan-artifact sweep (issue #207 PR-2): the store's fresh read under the `run_absent`
  // fence found the run EXISTS AGAIN — a JsonFileStore.save() re-import landed between the
  // sweep's snapshot and the reap. Purely an internal signal between that fence (core's
  // `evaluateFence`) and gc's own catch (routes it to the `resurrected` bucket, never
  // `failed`/an aborted sweep) — not expected to surface in any envelope.
  | 'STATE_RUN_RESURRECTED'
  | 'STATE_LEGACY_FORMAT'
  // #627 W (R25, W-r2): a registered workflow written by a LATER Realm (its `schema_version` is above
  // what this version reads) — refused at read, since this version would ignore requirements it
  // cannot read. Its facts are typed (`NewerDefinitionFacts`); `details` is empty.
  | 'STATE_NEWER_FORMAT'
  | 'STATE_STEP_ALREADY_CLAIMED'
  | 'STATE_STEP_NOT_ELIGIBLE'
  // issue #279 (increment 1, PR-B): a settle_step delta refused because the step's settled entry
  // already carries a DIFFERENT token (already_settled_by_other) or a DIFFERENT outcome
  // (settled_outcome_divergence) — the persisted outcome is disclosed in `details`. Never thrown
  // for the SAME-token/SAME-outcome retry, which is an ok-shaped no-op (design record §7).
  | 'STATE_STEP_ALREADY_SETTLED'
  // issue #279 (increment 1, PR-B): a settle_step delta refused `claim_lost` — this attempt's
  // outcome was NOT recorded (the claim was lost to a concurrent settle, or the run advanced).
  | 'STATE_CLAIM_LOST'
  | 'STATE_RUN_DIVERGED'
  | 'STATE_RUN_ALREADY_ACTIVE'
  | 'STATE_IDEMPOTENCY_KEY_USED'
  // issue #715 (a) (D6-53): a run store was opened on a directory whose test clock file was created
  // for ANOTHER location (a copied test location) — refused at construction, so a copy never runs on
  // another location's test clock.
  | 'STATE_TEST_CLOCK_FOREIGN'
  | 'RUN_ABORTING'
  // VALIDATION
  | 'VALIDATION_INPUT_SCHEMA'
  | 'VALIDATION_OUTPUT_SCHEMA'
  | 'VALIDATION_TRACE_SCHEMA'
  // issue #220: a persistently-rejected agent step's bounded rejection count reached its
  // threshold — a REAL terminal step failure (kept separate from #140's `exhausted_by` taxonomy:
  // disjoint lifecycles — this is a validation-rejection count, not a retry/timeout budget).
  | 'VALIDATION_EXHAUSTED'
  | 'VALIDATION_WORKFLOW_SCHEMA'
  | 'VALIDATION_HASH_MISMATCH'
  | 'VALIDATION_QUOTE_NOT_FOUND'
  | 'VALIDATION_FIELD_UNKNOWN'
  | 'VALIDATION_FIELD_EXCLUDED'
  | 'VALIDATION_EMPTY_VALUE'
  | 'VALIDATION_BATCH_TOO_LARGE'
  | 'VALIDATION_BATCH_ITEMS'
  // issue #508 (L2): a step's `trust` value is neither absent nor a recognized TRUST_LEVELS
  // member (a typo, a ServiceTrust value in the wrong place, or the retired 'human_notified'
  // tombstone) — caught at dispatch as the fail-closed backstop for definitions that bypassed
  // the loader's L1 refusal (registrar read-back, direct embedder use). Deliberately NOT added
  // to VALIDATION_TELEMETRY_CODES (execute-step.ts) — that set is for agent-repairable
  // submission defects; a bad `trust` is an authoring defect no agent can repair.
  | 'VALIDATION_TRUST_VALUE'
  // issue #625 / holder slice (PR-H): a program's name (a `driver`, a stated `responded_by`, an
  // environment-supplied name) is malformed — empty, over 200 characters, carrying a control
  // character, or not a well-formed `Attributed`. Refused before anything is read or written.
  | 'VALIDATION_ACTOR_INVALID'
  // issue #625 PR-2a (decisions C144, C151): a `caller` a host passed to an engine entry is not one
  // of that entry's words (`ENTRY_CALLERS`). Refused before anything is read or written.
  | 'VALIDATION_CALLER_INVALID'
  // issue #719: a part a host handed an engine entry is missing or has the wrong type (an option,
  // the definition, a `run` that is not a run record, the dispatcher a step needs). Every defect
  // of those parts is named at once; refused before anything is read or written.
  | 'VALIDATION_OPTION_INVALID'
  // #872 (b1): `get_run_state`'s `cursor` refused — given without the steps it pages, or naming no
  // step the run has attempted. The agent fixes its own call (`provide_input`); the same call fails again.
  | 'VALIDATION_CURSOR'
  | 'STEP_HANDLER_ERROR'
  // ENGINE
  | 'ENGINE_INTERNAL'
  | 'ENGINE_STORE_FAILED'
  // a PerRunArtifactStore.deleteAllForRun implementation could not delete (or could not even
  // confirm the presence/absence of) an artifact it owns for a run — a genuine non-ENOENT I/O
  // failure, never used for a plain "already gone" (issue #183)
  | 'ENGINE_ARTIFACT_DELETE_FAILED'
  | 'ENGINE_ADAPTER_FAILED'
  | 'ENGINE_ADAPTER_NOT_REGISTERED'
  | 'ENGINE_PROCESSOR_FAILED'
  | 'ENGINE_HANDLER_FAILED'
  | 'ENGINE_HANDLER_NOT_REGISTERED'
  | 'ENGINE_STEP_FAILED'
  | 'ENGINE_GATE_OPEN_FAILED'
  // issue #620 PR-C: an object from another realm version (proof: it carries realm's identity key
  // with another generation) — a store, a registry, or a WorkflowError a handler/adapter/dispatcher
  // threw. Minted only in release-line.ts.
  | 'ENGINE_RELEASE_LINE_MISMATCH'
  // issue #620 PR-C: a store a host handed realm declares no release line (a fact, not a guess).
  | 'ENGINE_RELEASE_LINE_UNDECLARED'
  | 'GATE_MESSAGE_UNRESOLVABLE'
  | 'FILTER_UNKNOWN'
  | 'ADAPTER_OP_UNSUPPORTED'
  | 'ADAPTER_VALIDATION_FAILED'
  | 'ADAPTER_REQUEST_FAILED'
  | 'STEP_TIMEOUT'
  | 'STEP_ABORTED'
  | 'STEP_RETRY_EXHAUSTED'
  | 'STATE_STEP_PENDING'
  // issue #367 — the seal-integrity boundary (`assertSealIntegrity`, installed in both in-repo
  // stores' update AND settle write tails). All five THROW (retryable: false): this store already
  // throws on write integrity (STATE_SNAPSHOT_MISMATCH / STATE_RUN_DIVERGED), and an advisory
  // would persist the violating record into the permanent legacy population and report success on
  // a write that violated its own invariant — the #183 fsync-gate sin. #119's WARN-never-gate
  // governs advisory findings, not store integrity. The escape hatch is `abandon_run`, itself a
  // stamped writer.
  //
  // A fresh seal (non-terminal -> terminal write) carries no `sealed_by` — a writer gap.
  // Transition-scoped, so legacy terminal records re-written while terminal pass untouched.
  | 'STATE_SEAL_UNSTAMPED'
  // A non-terminal write RETAINS `sealed_by` across a terminal -> live transition — an in-version
  // stripper bug (resume/re-drive paths must strip the stamp in the same write). Transition-scoped
  // so a pre-existing orphan (an old binary's resume) is not wedged by every subsequent write.
  | 'STATE_SEAL_ORPHANED'
  // A terminal rewrite DROPS a previously-stored `sealed_by` — a field-enumerating rewriter
  // silently draining the stamped population back to prose. Zero legacy cost: no pre-#367 stored
  // record carries the field.
  | 'STATE_SEAL_ERASED'
  // `sealed_by.arm` is outside SEAL_ARMS — a foreign or corrupt stamp. The read side treats it as
  // absent (falls through to the classifier); the write side refuses it loudly here.
  | 'STATE_SEAL_UNKNOWN_ARM'
  // A terminal write's stamp DISAGREES at phase level with what the record's own markers/prose
  // classify to — a stale arm preserved by spread (the old-binary re-seal channel) or a
  // mis-stamped writer.
  //
  // EXEMPT: a seal carrying an adjudication. This check catches SILENT drift, and an operator's
  // ruling is loud, attributed and erase-proof while terminal — it supersedes the record's prose
  // rather than contradicting it, and the prose is never rewritten to match.
  | 'STATE_SEAL_INCOHERENT'
  // A stored `sealed_by.arm` is rewritten unlawfully. Which arm sealed a run is a fact about
  // something that already happened, so quietly re-attributing it is the silent re-attribution
  // this design exists to end — and the exception is the opposite of quiet.
  //
  // The ONE lawful way an arm changes while terminal is an adjudication write carrying FRESH
  // truthful provenance: `previous_arm` naming the arm being replaced, or `null` on a first stamp
  // of a record that was already terminal (the parked-legacy channel). Riding a prior ruling's
  // provenance is a rewrite, not a ruling. A lying claim, a fabricated first-seal ruling on a live
  // run, and dropping a stored ruling are all refused under this code too.
  //
  // Zero legacy cost: no pre-#367 record carries either field.
  | 'STATE_SEAL_REWRITTEN'
  | 'STEP_NOT_FOUND'
  | 'GUARD_RESOLUTION_ERROR'
  | 'INPUT_MAP_DEPTH_EXCEEDED'
  // Issue #287: an input_map node carries a `$`-prefixed key that is not a supported directive,
  // or `$literal` with sibling keys. The loader rejects both at authoring; this code is the
  // RUNTIME mirror, which is what catches an ALREADY-REGISTERED workflow (a stored definition
  // re-executes its corruption on every run) and any raw-parse path that bypasses the loader.
  | 'INPUT_MAP_UNKNOWN_DIRECTIVE'
  // RESOURCE
  | 'RESOURCE_FETCH_FAILED'
  | 'RESOURCE_TOO_LARGE'
  | 'RESOURCE_FORMAT_INVALID'
  | 'RESOURCE_NOT_ACCESSIBLE'
  // TRACE BUFFER
  | 'BUFFER_FULL'
  // issue #197 PR-1: validateTraceCapabilities' typed fail-loud when a TraceBufferStore declares
  // a capability-ladder rung ('seal'/'writer_nonce_carriage') whose required methods are NOT
  // actually all present (declared-but-inconsistent) — a construction-time wiring defect, never
  // a runtime condition. Undeclared is always silent success (the honest floor); this code is
  // reserved for the declared-but-lying case only.
  | 'TRACE_CAPABILITY_INCONSISTENT'
  // MCP
  | 'MCP_CONNECTION_FAILED'
  | 'MCP_TOOL_NOT_FOUND'
  | 'MCP_TOOL_NAME_COLLISION';

/**
 * The typed facts of a damaged stored file's error (issue #729 PR-0, PR0-CONTRACT Amendments 7, 7b,
 * 7e): one file (`scope: 'file'`, #719's {@link UnreadableFileFacts}) or a decision over every run
 * that failed closed (`scope: 'files'`, {@link UnreadableRunFilesFacts}). The aggregate shares both of
 * its codes with the single-file error, so the facts carry the discriminant — never a shape told
 * apart by which keys are present.
 */
export type StoredFileErrorFacts =
  ({ scope: 'file' } & UnreadableFileFacts) | ({ scope: 'files' } & UnreadableRunFilesFacts);

/**
 * issue #759 (PR0-CONTRACT Amendment 11 — its first owner of the validation codes): the typed facts
 * of a refused answer — the validator's rows (`errors`, Ajv's own order, capped at
 * `VALIDATION_PROBLEMS_SHOWN`, never re-sorted or de-duplicated), the total before the cap
 * (`error_count`, counted once at the validator and carried — never recounted by a renderer), and,
 * for an agent step's counted rejection, the countdown (`rejections`, `threshold`).
 */
export interface ValidationErrorFacts {
  errors: readonly ErrorObject[];
  error_count: number;
  rejections?: number;
  threshold?: number;
}

/**
 * The error codes whose facts are typed (PR0-CONTRACT Amendments 7, 11): ONE facts type per code,
 * entering with the unit that types it. Every other code keeps its untyped `details` until its owning
 * unit types it (#759 typed the two validation codes; `VALIDATION_EXHAUSTED` and
 * `VALIDATION_TRACE_SCHEMA` stay untyped until their owners type them).
 */
export interface ErrorFactsByCode {
  RESOURCE_FORMAT_INVALID: StoredFileErrorFacts;
  ENGINE_STORE_FAILED: StoredFileErrorFacts;
  STATE_LEGACY_FORMAT: Extract<StoredFileErrorFacts, { scope: 'file' }>;
  VALIDATION_INPUT_SCHEMA: ValidationErrorFacts;
  VALIDATION_OUTPUT_SCHEMA: ValidationErrorFacts;
  STATE_NEWER_FORMAT: NewerDefinitionFacts;
}

/**
 * #627 W (W-r2; MA 3's decision 2026-10-16, Amendment 11's rule — a code's facts enter with its
 * owner): a registered workflow's copy written by a LATER Realm — the copy's path, the definition
 * format it states, and the latest this version reads. Its own `scope`: the copy is not damaged, so
 * the damaged-file readers (`unreadableFactsOf`, keyed on `scope: 'file'`) must never take it, and no
 * damaged-file class (`legacy` is an OLDER format) is true of it.
 */
export interface NewerDefinitionFacts {
  scope: 'newer_definition';
  path: string;
  schema_version: number;
  reads_up_to: number;
}

/** The typed facts of one error code (`never` for a code with none yet). */
export type ErrorFactsOf<C extends ErrorCode> = C extends keyof ErrorFactsByCode
  ? ErrorFactsByCode[C]
  : never;

/** Any typed error facts. */
export type ErrorFacts = ErrorFactsByCode[keyof ErrorFactsByCode];

export interface WorkflowErrorOptions {
  code: ErrorCode;
  category: ErrorCategory;
  agentAction: AgentAction;
  retryable: boolean;
  details?: Record<string, unknown>;
  /**
   * issue #729 PR-0 (PR0-CONTRACT Amendment 7): the typed facts of the codes that have them
   * ({@link ErrorFactsByCode}), present exactly where their producer writes them.
   */
  facts?: ErrorFacts;
  /**
   * issue #729 PR-0 (T-1, Amendment 11): the step a stop is about when the error names no step of its
   * own call — a guard of the chain whose settle was refused. Read through `stopAbout`.
   */
  about?: string;
  /**
   * issue #729 PR-0 (PR0-CONTRACT §2): the ways that lead on from this error, as data — every one a
   * judged way; a reply built from the error carries them as `error.remedy`, and each door renders
   * them (they replace the remedy clause a message or untyped `details` carried).
   */
  remedy?: readonly WayOn[];
  stepId?: string;
  attempt?: number;
  retry_after?: number; // seconds; set only for SERVICE_RATE_LIMITED errors
  /**
   * issue #424: the loader warnings that were live when this error was thrown. Present only on
   * loader errors, and only when there were any.
   *
   * No current call site populates this — every attachment goes through
   * `attachLoaderWarnings` after construction, because the throw sites are spread across two
   * files and the warnings array is not in scope at most of them. The option exists so the
   * options shape mirrors the fields 1:1 (the `stepId`/`retry_after` convention) and so direct
   * construction stays possible.
   */
  warnings?: readonly LoaderWarning[];
  /**
   * issue #425: the individual error strings this message was joined from. Unlike `warnings`
   * above, THIS sibling is populated at construction — the collectors that join them are the
   * only place the individual strings still exist.
   */
  errors?: readonly string[];
}

export class WorkflowError extends Error {
  readonly code: ErrorCode;
  readonly category: ErrorCategory;
  readonly agentAction: AgentAction;
  readonly retryable: boolean;
  readonly details: Record<string, unknown>;
  /** issue #729 PR-0: the typed facts of this error's code, where its producer writes them. */
  readonly facts?: ErrorFacts;
  /** issue #729 PR-0 (T-1): the step a stop is about, when not this call's own. */
  readonly about?: string;
  /** issue #729 PR-0: the ways that lead on from this error (a reply's `error.remedy`). */
  readonly remedy?: readonly WayOn[];
  readonly stepId?: string;
  readonly attempt: number;
  readonly retry_after?: number;
  /**
   * issue #424: the loader warnings live at the moment this error was thrown — a typo hint, a
   * retry advisory — so a caller rendering the failure can show the whole defect set at once
   * instead of revealing the next layer on each fix.
   *
   * The SLOT is writable because the loader attaches it after construction (see
   * `attachLoaderWarnings` in yaml-loader.ts): the throw sites are spread across two files, and
   * two chokepoints catching-and-attaching cover them all — including every future one — where
   * per-site construction would not. The VALUE stays readonly, and the helper attaches at most
   * once, so an inner chokepoint's attachment survives an outer one.
   *
   * ABSENT rather than `[]` when there were no warnings: "this error carried none" and "nobody
   * looked" are different facts and the channel keeps them different.
   */
  warnings?: readonly LoaderWarning[];
  /**
   * issue #425: the errors this message was joined from, one per element, before `join('; ')`
   * flattened them. A collector accumulates several problems and throws once, so a reader gets
   * one paragraph-long line with the boundaries only implied by punctuation — and a message can
   * itself contain a semicolon (the #413 four-clause text does), so splitting the joined string
   * back apart is not a recoverable operation. Kept here instead, and the render walks the array.
   *
   * ABSENT rather than `[]` on a single-error throw, so a caller can tell "there was one" from
   * "there was a list" without counting.
   */
  errors?: readonly string[];

  constructor(message: string, options: WorkflowErrorOptions) {
    super(message);
    this.name = 'WorkflowError';
    this.code = options.code;
    this.category = options.category;
    this.agentAction = options.agentAction;
    this.retryable = options.retryable;
    this.details = options.details ?? {};
    if (options.facts !== undefined) this.facts = options.facts;
    if (options.about !== undefined) this.about = options.about;
    if (options.remedy !== undefined) this.remedy = options.remedy;
    if (options.stepId !== undefined) this.stepId = options.stepId;
    this.attempt = options.attempt ?? 1;
    if (options.retry_after !== undefined) this.retry_after = options.retry_after;
    if (options.warnings !== undefined) this.warnings = options.warnings;
    if (options.errors !== undefined) this.errors = options.errors;
  }
}

brandClass(WorkflowError, Symbol.for('@sensigo/realm/WorkflowError'), REALM_BRAND);

/**
 * The stored-file facts an error carries (#729 PR-0, Amendment 7e), or `undefined` for any other
 * error — the ONE narrowing of the facts union to its stored-file family. The union is keyed by
 * CODE (`ErrorFactsByCode`); `scope` is that family's own field, not the union's discriminant, so
 * the readers that need it narrow here by its VALUE — `'file'` or `'files'` — never by the key's
 * presence alone (issue #759: the union gained a member without `scope`; a later family may carry
 * a `scope` of its own that is not a stored file).
 */
export function storedFileFactsOf(err: WorkflowError): StoredFileErrorFacts | undefined {
  const facts = err.facts;
  if (facts === undefined || !('scope' in facts)) return undefined;
  return facts.scope === 'file' || facts.scope === 'files' ? facts : undefined;
}

/**
 * #627 W (W-r2): the facts of a copy a later Realm registered, or `undefined` for any other error —
 * narrowed by `scope`'s VALUE, as {@link storedFileFactsOf} narrows its family, so neither family's
 * reader takes the other's facts.
 */
export function newerDefinitionFactsOf(err: WorkflowError): NewerDefinitionFacts | undefined {
  const facts = err.facts;
  if (facts === undefined || !('scope' in facts)) return undefined;
  return facts.scope === 'newer_definition' ? facts : undefined;
}
