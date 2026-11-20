// Types for an active or historical workflow run record stored on disk.
import type { ToolCallRecord } from './mcp-types.js';
import type { ExtensionIdentityEntry } from './extension-identity.js';
import type { TriggerRule } from './workflow-definition.js';
import type { Attributed, GateClaimVerdict } from '../engine/holder.js';
import type { AgentAction, ErrorCategory, ErrorCode } from './workflow-error.js';

/**
 * A single trace entry submitted by the agent. Submitted as-is; the engine
 * canonicalizes and assigns seq before persisting.
 * @public
 */
export interface AgentTraceEntry {
  event: string;
  timestamp?: string | undefined;
  data?: Record<string, string | number | boolean | null> | undefined;
}

/**
 * A single stored trace entry after canonicalization.
 * seq is engine-assigned: 1-based, monotonically increasing in stored order.
 * @public
 */
export interface TraceEntry {
  seq: number;
  event: string;
  timestamp?: string;
  data?: Record<string, string | number | boolean | null>;
}

/**
 * Discard and truncation accounting produced by the trace normalizer.
 * @public
 */
export interface TraceNormalizationSummary {
  submitted_entries: number;
  stored_entries: number;
  discarded_entries: number;
  discarded_reserved_event_entries: number;
  discarded_overflow_entries: number;
  truncated: boolean;
  truncation_reason?: 'count_limit' | 'byte_limit';
  /** Whether trace_schema validation was applied to the canonical entries. */
  schema_applied?: boolean;
  /** Validation mode that was applied ('warn' or 'enforce'). Present when schema_applied is true. */
  validation_mode?: 'warn' | 'enforce';
  /** Number of Ajv validation errors found. Zero means schema-conformant. Present when schema_applied is true. */
  validation_errors?: number;
  /**
   * Issue #185 (honest seal); issue #197 PR-2 (narrowed): the count of buffer/WAL lines adopted
   * into this canonical trace THAT CANNOT BE ATTRIBUTED to this claimant — i.e., adopted under
   * the ⊥ (bare/anonymous) writer class. Present ONLY when > 0. The agent trace buffer is not
   * owned by any one writer, so a bare-adopted line may have been appended by a PRIOR execution
   * attempt (e.g. a crashed run this one resumed) or by a CONCURRENT one racing on the same
   * (run, step). The engine records this as an honest fact rather than silently asserting single
   * authorship over content it cannot verify the provenance of. Absent (never `0` or `false`)
   * when canonical trace was built entirely from this execution's own `execute_step` submission,
   * or entirely from own-nonce-attributed lines (see `attributed_lines_adopted` below) — no
   * caveat is warranted there. For all-bare traffic (no client ever mints a `writer_nonce`) this
   * field is numerically IDENTICAL to its pre-#197 meaning — every buffered line was, and still
   * is, bare-adopted. Faithful per-writer separation shipped in #197: see
   * `attributed_lines_adopted` (own-nonce adoption, no caveat) and `foreign_lines_preserved`
   * (a different writer's lines, preserved not adopted) below.
   */
  buffered_lines_adopted?: number;
  /**
   * Issue #197 PR-2 (design §2/§6): count of buffer/WAL lines adopted under the SAME nonce this
   * claimant presented at claim time. Present ONLY when > 0. Unlike `buffered_lines_adopted`,
   * this carries NO caveat — wording (verbatim, never varied): "writer continuity verified (same
   * nonce as presented at claim); strength conditional on nonce secrecy." NEVER worded as
   * "attribution is faithful" — a leaked/guessed nonce lets a different writer's lines pass this
   * same check, so the guarantee is conditional on the nonce actually staying secret to its
   * minter, not an unconditional identity proof.
   */
  attributed_lines_adopted?: number;
  /**
   * Issue #197 PR-2 (design §2/§4): count of buffer/WAL lines found at this claimant's read that
   * belong to a DIFFERENT writer (nonce mismatch, including a bare claimant seeing nonced lines
   * or vice versa) — PRESERVED (sealed, on a store that supports it), never adopted into
   * canonical evidence, never merged, never gating this claimant's `trace_schema` enforce check.
   * Present ONLY when > 0. Retrieve the preserved content via `realm run export`. Foreign nonce
   * VALUES never appear anywhere in this record or any envelope — only this count.
   */
  foreign_lines_preserved?: number;
}

/**
 * What a step's attempt under `structured_output: 'strict'` records about strict mode: only what
 * Realm can observe, never whether the provider enforced it (`EvidenceSnapshot.structured_output`).
 * Deliberately carries NO `applied`
 * field (unwitnessable — a silently-stripping proxy could accept `strict` on the wire and never
 * honor it; `sent` only ever claims "realm placed strict on the request handed to the SDK", never
 * that the API enforced it). Per-attempt: a retry-configured step's evidence array can carry a
 * different value per attempt. `requested` is always `true` when this object is present at all —
 * it exists ONLY on a step that declared `structured_output: 'strict'`.
 *
 * SCOPE (issue #311 truth pass): every field on this object EXCEPT `tool_args` describes ONE
 * dimension — the step's own OUTPUT request (the submit tool realm sends for the step's answer).
 * That was the only dimension #236 shipped, so the original wording did not need to say so;
 * it does now. `tool_args` describes the independent TOOL-ARGUMENTS dimension, and the two
 * legitimately disagree on the same attempt: a tools-bearing step is permanently
 * `sent: false` / `unsupported_context_tools` at the OUTPUT level while simultaneously carrying
 * genuine per-tool `strict_sent: true` entries under `tool_args`. When reading a single field,
 * check which dimension it belongs to before concluding "strict was off".
 * @public
 */
export interface StructuredOutputMeta {
  /** Always `true` — this object's mere presence already implies it; kept explicit so a reader
   *  never has to special-case "object present but requested:false". */
  requested: true;
  /** Whether realm actually placed `strict: true` on the request it handed to the SDK for the
   *  attempt THIS diagnostics object describes. Issue #316 correction: a synthesized stamp
   *  (`external_agent`) sets this to `false` explicitly — never absent — since no request was
   *  ever made by realm at all; all three mint sites (execution-loop.ts) construct
   *  `{requested: true, sent: false, downgrade_reason: 'external_agent'}` verbatim. */
  sent?: boolean;
  /** Caveat codes from `assessStructuredOutputEligibility`'s `eligible_with_caveats` verdict —
   *  present whenever the Phase-B eligibility verdict carried them, REGARDLESS of what the live
   *  attempt then did (issue #332 correction: the mint is right, this doc was wrong). The verdict
   *  is computed once, at eligibility time (run-agent.ts:498-502), and its caveats are spread
   *  onto the meta unconditionally (run-agent.ts:690-695) — including onto a `sent: false` meta
   *  when the schema passed eligibility but the LIVE call then downgraded (a 400/503). `caveats`
   *  therefore records an eligibility-time fact about the SCHEMA; `sent`/`downgrade_reason`
   *  record the ATTEMPT's own outcome — the two can legitimately co-occur, and a reader
   *  disambiguates via the co-present fields, never via caveats' mere presence. Never present on
   *  a `gate_ineligible`/`external_agent` attempt (no eligibility verdict with caveats was ever
   *  computed for either). */
  caveats?: string[];
  /**
   * Why `sent` is `false` (absent when `sent` is `true`):
   * - `gate_ineligible` — the Phase-B verdict was `ineligible`; strict was never attempted.
   * - `api_rejected_schema` — a live 400 on a strict-carrying request; realm dropped strict and
   *   retried once.
   * - `grammar_unavailable` — a live 503 whose message matched Anthropic's captured
   *   grammar-compilation-unavailable text.
   * - `service_unavailable` — a live 503 that did NOT match the grammar text (a generic overload
   *   — fail-safe default label for any non-matching 503).
   * - `provider_unsupported` — the configured LLM provider does not implement `callStepWithMeta`
   *   (a third-party `--provider-module` that only implements the base `callStep`). Both in-repo
   *   strict-capable providers override it, so at the STEP level this now names third-party
   *   modules specifically.
   * - `unsupported_context_tools` — the step declares `tools`, so its OUTPUT is produced on the
   *   tools path, where realm sends no grammar-constrained submit call. That is a PER-PROVIDER
   *   DESIGN DECISION, not an API limitation: composing a step-output grammar with strict tool
   *   arguments in one request is unprobed on both providers, and doing it blind would make a
   *   400 impossible to attribute to the right dimension. A future version wanting it starts
   *   with the probe. Issue #311 truth pass: this no
   *   longer means "strict is unsupported on this step" — strict may well have been attached to
   *   that step's TOOL-CALL ARGUMENTS on the very same attempt (see `tool_args`). It means only
   *   that the step's own output was not grammar-constrained.
   * - `external_agent` — the step declared `structured_output: 'strict'` but was driven by
   *   something other than `realm agent` (e.g. an external agent calling `execute_step` over
   *   MCP directly) — no `stepMeta.structuredOutput` was ever attached, so realm cannot know
   *   whether strict was honored at all.
   * - `compat_endpoint` (issue #313) — the provider is pointed at an OpenAI-COMPATIBLE endpoint
   *   via `--base-url`, and the author has not attested that it enforces strict. Realm declines
   *   to send strict rather than send it into an endpoint that may accept and ignore it. The
   *   remedy is `--strict-base-url` (an author attestation) or a native endpoint. Unlike
   *   `external_agent`, this is realm's own CHOICE, which is why the run-health finding
   *   includes it.
   */
  downgrade_reason?:
    | 'gate_ineligible'
    | 'api_rejected_schema'
    | 'grammar_unavailable'
    | 'service_unavailable'
    | 'provider_unsupported'
    | 'unsupported_context_tools'
    | 'external_agent'
    | 'compat_endpoint';
  /** The raw API error message, when a live 400/503 drove a downgrade — attached verbatim,
   *  never rewritten, so an operator can compare against the provider's own documented error text. */
  api_message?: string;
  /**
   * Issue #313 — the provider's own machine-readable error fields, captured VERBATIM alongside
   * `api_message` when a live 400 drove a downgrade. `null` is meaningful and preserved: OpenAI
   * returns `param: null, code: null` for the model-unsupported class (probe P8), where the
   * message is prose-only. Realm never KEYS any decision on these — they are capture-only, for
   * an operator comparing against the provider's documented error taxonomy.
   */
  api_param?: string | null;
  api_code?: string | null;
  /**
   * Issue #313 — which provider produced this attempt. Minted at a single run-agent chokepoint,
   * so every meta run-agent writes carries it.
   *
   * The open `module:${string}` member names a third-party `--provider-module` by its module
   * basename: such providers are assessed under the ANTHROPIC rule profile (realm cannot know a
   * module's strict dialect), and this field is what makes that assumption detectable if the
   * module in fact targets a different API.
   *
   * BY CONSTRUCTION absent on the engine's synthesized `external_agent` stamps: realm did not
   * drive those attempts, so it has no provider to name.
   */
  provider?: 'anthropic' | 'openai' | 'openai-reasoning' | `module:${string}`;
  /** Whether the model's output arrived via the submit tool (`tool_use.input`, pre-parsed) or as
   *  extracted text — the standing dodge detector (design record R-B): a schema shaped to make
   *  the model prefer a text answer over the strict-constrained tool would show up here. */
  submission_channel?: 'tool' | 'text';
  /**
   * Issue #311 — the TOOL-ARGUMENTS dimension. Present only on a `structured_output: 'strict'`
   * step that ran the tools path with at least one declared tool.
   *
   * Read this alongside the step-level fields above, which describe a DIFFERENT question. The
   * step-level `sent`/`downgrade_reason` answer "did realm grammar-constrain this step's own
   * OUTPUT?" — on the tools path that answer is permanently no (`unsupported_context_tools`),
   * because the step's output still arrives through the unconstrained submit/extraction path.
   * `tool_args` answers "did realm grammar-constrain the ARGUMENTS realm's model passes to each
   * MCP tool?", which on the same attempt can be yes for some tools and no for others. The two
   * co-occur by design; neither supersedes the other.
   *
   * Enforcement caveat: a strict grammar constrains what the model can EMIT. There is no Ajv on
   * the tools path — realm does not post-hoc validate tool arguments — so for any tool that
   * rides unconstrained, enforcement falls entirely to the MCP server at call time. Strict's
   * guarantee also covers tool-NAME selection, not arguments alone.
   *
   * One entry per DECLARED tool, in declared order, whether or not strict was attached to it.
   */
  tool_args?: {
    tools: Array<{
      /** The bare tool name as declared by the MCP server (the wire name). */
      name: string;
      /** Always `true` — present iff this entry exists (house style, mirroring `requested`). */
      strict_requested: true;
      /** Whether realm placed `strict: true` on THIS tool in the request it handed to the SDK —
       *  the FINAL posture of the attempt (a mid-attempt drop rewrites this to `false`). Same
       *  observables-only discipline as `sent`: never a claim that the API honored it. */
      strict_sent: boolean;
      /**
       * Why strict was not attached (or was dropped). Plural — codes co-occur. Values are the
       * verdict codes from `assessStructuredOutputEligibility` verbatim
       * (`no_schema` | `missing_additional_properties` | `unsupported_keyword` |
       * `too_many_optionals` | `too_many_unions` | `unsupported_context_tools`), plus these
       * non-verdict literals:
       * - `budget_excluded` — eligible, but the API's per-request limits (≤20 strict tools,
       *   ≤24 summed optional properties) were already spent by earlier declared tools.
       * - `api_rejected_schema` — a live 400 on a strict-carrying request dropped strict for
       *   this step's tools.
       * - `grammar_unavailable` — a live 503 matching the grammar-compilation-unavailable text.
       * - `service_unavailable` — a live 503 that did not match it (fail-safe generic label).
       * - `provider_unsupported` — the configured provider does not place per-tool strict on the
       *   wire at all, so strict was never attached to ANY tool on this attempt and no per-tool
       *   eligibility was assessed. Since issue #313 both in-repo tool-capable providers DO place
       *   it, so at the per-tool level this now names third-party `--provider-module` providers
       *   specifically. Reuses the step-level literal of the same name.
       * - `compat_endpoint` (issue #313) — the provider is pointed at an OpenAI-compatible
       *   endpoint without the `--strict-base-url` attestation, so no tool was sent strict. An
       *   ENDPOINT fact, never conflated with `provider_unsupported`: this provider CAN place the
       *   marker, realm chose not to have it do so here.
       * - `not_all_required` (issue #313) — an OpenAI-profile verdict code: a property outside
       *   `required`. Reached on the tools path whenever an OpenAI-driven step assesses a tool
       *   schema; it is the dominant per-tool ineligibility code on that profile.
       * - `exceeds_provider_limit` (issue #313) — an OpenAI-profile verdict code: the schema
       *   exceeds a documented size limit (nesting depth, property count, total characters, or
       *   enum values). The specific limit and measured value are in the verdict's remediation.
       */
      reasons?: string[];
      /** Caveat codes from this tool's own eligibility verdict (e.g. `unenforced_keyword`,
       *  `optional_emission`) — an eligibility-time fact about the tool's schema, independent of
       *  what the live attempt then did. */
      caveats?: string[];
    }>;
    /**
     * Present only when a live 400/503 dropped strict PART-WAY THROUGH this attempt. Absent on
     * an attempt that never attached strict at all — including every attempt after a sticky 400
     * (there was no drop to describe; the tools simply started unconstrained).
     */
    dropped_mid_attempt?: {
      /** `api_rejected_schema` | `grammar_unavailable` | `service_unavailable`. */
      reason: string;
      /** The raw API error message, verbatim. Lives HERE, never on the step-level
       *  `api_message` — that field describes the step-output dimension only. */
      api_message?: string;
      /** Issue #313 — the provider's machine-readable error fields, captured verbatim beside
       *  `api_message` (same capture-only, never-keyed discipline as the step-level pair).
       *  Minted by the OpenAI tools ladder; `null` is preserved and meaningful. */
      api_param?: string | null;
      api_code?: string | null;
      /** How many strict-decorated requests returned 200 before the drop. `0` means the very
       *  first strict-carrying turn of this attempt was rejected. */
      strict_turns_before_drop: number;
    };
  };
}

/**
 * Diagnostic metadata captured during step execution. Written once; read by inspect.
 * @public
 */
export interface StepDiagnostics {
  /**
   * Rough token count estimate: Math.ceil(JSON.stringify(input).length / 4). A CHARACTER-based
   * approximation of this step's resolved input, computed whether or not a model call happens —
   * distinct from `cache`'s measured prompt size below, which is a real provider-reported count
   * of the whole wire request and exists only for a step that actually called a model.
   */
  input_token_estimate: number;
  /** Ordered list of precondition evaluations for this step. Empty array if no preconditions. */
  precondition_trace: Array<{
    expression: string;
    passed: boolean;
    resolved_value: unknown;
  }>;
  /**
   * #729 PR-3: a guard step's evaluated `abort_unless` conditions, every one (no short-circuit),
   * each with its resolved value. Present on a guard's pass and abort snapshots; absent on every
   * other step's, and on a guard snapshot written before #729 PR-3, which carried them in
   * `output_summary.conditions`.
   */
  guard_conditions?: Array<{ condition: string; resolved_value: unknown; passed: boolean }>;
  /**
   * Issue #220: stamped on a SUCCESS settle evidence snapshot when the step's accrued
   * `RunRecord.validation_rejections` count was > 0 at settle time ("succeeded after N
   * rejections") — free diagnostic, never gates anything. Also present on the synthesized
   * evidence snapshot a `VALIDATION_EXHAUSTED` terminalization mints (the just-persisted count),
   * and on the synthesized SUCCESS snapshot a declared default-settle mints (issue #220 PR-2 —
   * see `settled_by_default` below). Optional-additive: absent on every pre-#220 snapshot and on
   * any snapshot for a step that was never rejected.
   */
  validation_rejections?: number;
  /**
   * Issue #220 PR-2 (declared fail-open): `true` on the ONE synthesized SUCCESS evidence snapshot
   * minted when a step's exhausted schema-rejection budget is settled via its declared
   * `validation_exhaustion.default_output` rather than by the agent's own submission. Never present
   * on any other snapshot (absent, never `false`) — a step that succeeded on its own submission,
   * even one that previously accrued rejections, carries only `validation_rejections` here.
   */
  settled_by_default?: boolean;
  /** Issue #236 — disclosure for a `structured_output: 'strict'`-declared step's attempt. See
   *  {@link StructuredOutputMeta}. Absent on a step that never declared `structured_output`. */
  structured_output?: StructuredOutputMeta;
  /**
   * Issue #600 PR 1a — what the provider said this step's model calls cost, per WIRE REQUEST.
   * PRESENT when the driver supplied the step's usage — `realm agent` does for every model call it
   * makes through `callStepWithMeta` or `callStepWithTools` (the tool-calling path since issue #610)
   * — with `state: 'unobservable'` when the provider reported nothing. ABSENT when nothing was
   * recorded for the step, which happens three ways: the step made no model call (a handler step,
   * or one answered at a `realm workflow run` prompt); an external agent drove it over MCP
   * `execute_step`, so its model calls were never realm's to see; or the entry is a tool-calling
   * step that an older Realm (0.48.0 and earlier) wrote, before that path recorded. Absence alone
   * therefore never proves that no model call happened. A step realm's driver repaired (the #217
   * schema-repair loop) records every call, the rejected ones included.
   *
   * Issue #600 PR 1b — never re-summed at a render site. `composeStepViews`
   * (`engine/step-view.ts`) is the ONE derivation of a step's cost from this field, shared by
   * `realm run inspect` and `get_run_state`'s `include_steps`.
   */
  cache?: StepCacheDetail;
}

/**
 * The words a step's cache state takes (`StepCacheDetail.state`).
 *
 * Observation is per DIRECTION (read, write), never per object. `'never_engaged'` and
 * `'write_only'` each make a claim about BOTH directions, so each is mintable only when both were
 * reported; a provider that reports one counter and withholds the other yields
 * `'partially_observed'`, because there is no true four-word answer for that data and forcing one
 * would be the very coercion `CACHE_BASES` forbids one level up.
 * @public
 */
export const CACHE_STATES = [
  'engaged',
  'never_engaged',
  'write_only',
  'partially_observed',
  'unobservable',
] as const;
/**
 * One of the words in `CACHE_STATES`: a step's cache state, judged per direction from what the
 * provider reported (`StepCacheDetail.state`).
 * @public
 */
export type CacheState = (typeof CACHE_STATES)[number];

/**
 * How a cache number is known: reported by the provider, or not observable
 * (`StepCacheDetail.basis`).
 * Never a zero standing in for an absence.
 *
 * PR 1a ships exactly TWO members: `'provider_reported'` and `'unobservable'`. Nothing in this PR
 * DERIVES a cache number (it reads what the provider reported, or records that it could not see) —
 * so a `'derived'` member would be a declared member with no producer, and a type consumer would
 * reasonably believe realm derives these numbers today. `'derived'` arrives in the PR that derives
 * something (a vocabulary ships its producers with it — the same rule every const in this PR obeys).
 * @public
 */
export const CACHE_BASES = ['provider_reported', 'unobservable'] as const;
/**
 * One of the words in `CACHE_BASES`: how a step's cache numbers are known, reported by the provider
 * or not observable (`StepCacheDetail.basis`).
 * @public
 */
export type CacheBasis = (typeof CACHE_BASES)[number];

/**
 * Issue #600 — the words `--prompt-cache` takes (`realm agent`, `realm listen`): `auto` (the default:
 * realm chooses per step, caching 3-M D-2 — {@link CACHE_AUTO_BASES}), `short` and `long` (the provider's own
 * shortest and longest lifetimes), `off`. Produced by the CLI's `parsePromptCache`; never stored —
 * the record stores the class it resolves to ({@link CACHE_REQUESTS}) and the seconds asked for
 * (`UsageRecord.cache_lifetime_s`).
 */
export const PROMPT_CACHE_SETTINGS = ['auto', 'short', 'long', 'off'] as const;
export type PromptCacheSetting = (typeof PROMPT_CACHE_SETTINGS)[number];

/**
 * What Realm asked a provider to cache on a request, as stored (`UsageRecord.cache_requested`). The
 * words: `off` (asked for nothing; the Anthropic adapter with `--prompt-cache off`, or `auto`
 * choosing off), `lifetime` (asked for a cache lifetime; the Anthropic adapter with `short`,
 * `long`, or `auto` choosing one), `provider_rules` (realm asks for nothing and the provider's own
 * caching rules apply; the OpenAI and o1 adapters; with `cache_key_sent`, realm also sent a cache
 * key).
 * #896: the OpenAI adapter on GPT-5.6 and later at OpenAI's own address records `lifetime` (30
 * minutes) or `off` for a single-shot request, and `off` for a tool step's requests under `off`.
 * @public
 */
export const CACHE_REQUESTS = ['off', 'lifetime', 'provider_rules'] as const;
/**
 * One of the words in `CACHE_REQUESTS`: what Realm asked a provider to cache on a request, as
 * stored (`UsageRecord.cache_requested`).
 * @public
 */
export type CacheRequest = (typeof CACHE_REQUESTS)[number];

/**
 * Where a request's cache setting came from: `stated` (`--prompt-cache` was given) or
 * `runner_default` (the runner's own default) (`UsageRecord.cache_requested_source`).
 * Produced by
 * the CLI's `resolvePromptCache` and written by the Anthropic adapter it is handed to.
 * @public
 */
export const CACHE_REQUEST_SOURCES = ['stated', 'runner_default'] as const;
/**
 * One of the words in `CACHE_REQUEST_SOURCES`: whether a request's cache setting was stated with
 * `--prompt-cache` or was the runner's default (`UsageRecord.cache_requested_source`).
 * @public
 */
export type CacheRequestSource = (typeof CACHE_REQUEST_SOURCES)[number];

/**
 * The runners that choose a request's cache setting (`UsageRecord.cache_requested_by`): `realm
 * agent`, or `realm listen` for a drive it spawned. Produced by the CLI's `resolvePromptCache`. The
 * record's field stays a `string`: a provider module may write any text there, which is then
 * checked as text, never shown as one of these words.
 */
export const CACHE_REQUESTERS = ['realm agent', 'realm listen'] as const;

/**
 * On what `--prompt-cache auto` chose a request's cache lifetime (`UsageRecord.cache_auto.basis`).
 * The bases:
 * - `no_measurement` — produced by the CLI's `resolvePromptCache` for the setting `auto`, which the
 *   adapter writes on a request that carries no choice of its own (a host that passes none): no gaps
 *   were measured, so the runner's prior is asked for (caching 3-M D-3: older records too);
 * Caching 3-M (D-2): the other three are produced by the CLI's `chooseStepCaches`, one choice per
 * agent step, which `realm agent` passes on each of the step's calls:
 * - `step_gaps` — a step without tools, chosen by the provider's rule over the gaps between the
 *   step's requests in the workflow's earlier runs (`stepCacheGaps`; possibly none — the runner's
 *   prior is then asked for);
 * - `step_gaps_unreadable` — the read of the earlier runs failed; the runner's prior is asked for and
 *   the drive goes on;
 * - `tool_step` — a step that calls tools, on Anthropic: its own turns reuse the entry, so the short
 *   lifetime is asked for whatever its gaps.
 * @public
 */
export const CACHE_AUTO_BASES = [
  'no_measurement',
  'step_gaps',
  'step_gaps_unreadable',
  'tool_step',
] as const;
/**
 * One of the words in `CACHE_AUTO_BASES`: what `--prompt-cache auto` based a request's chosen cache
 * lifetime on (`CacheAuto.basis`).
 * @public
 */
export type CacheAutoBasis = (typeof CACHE_AUTO_BASES)[number];

/**
 * Why `--prompt-cache auto` chose without prices (`CacheAuto.prices.cause`, with `from: 'none'`).
 * Each member's producer:
 * - `no_file` — `runner.cache.economics` is not set (the CLI's `readAutoPrices`);
 * - `economics_unreachable` — the file could not be read (`readCacheEconomics`);
 * - `economics_unreadable` — the file is not a valid price file (`readCacheEconomics`);
 * - `model_unknown` — the file has no entry for the requested model (`selectEconomicsRates`);
 * - `input_zero` — the row prices input at 0, or at no finite positive number
 *   (`chooseAutoLifetime`, row 3);
 * - `rate_missing` — the row has no read rate, or no write rate for either lifetime
 *   (`chooseAutoLifetime`, row 4; `missing` names them); #896 unit B: for a provider with one
 *   lifetime, no read rate or no `cache_write` (`chooseAutoOneLifetime`).
 * @public
 */
export const CACHE_AUTO_PRICE_CAUSES = [
  'no_file',
  'economics_unreachable',
  'economics_unreadable',
  'model_unknown',
  'input_zero',
  'rate_missing',
] as const;
/**
 * One of the words in `CACHE_AUTO_PRICE_CAUSES`: why `--prompt-cache auto` chose without prices
 * (`CacheAutoPrices`'s `cause` when `from` is `none`).
 * @public
 */
export type CacheAutoPriceCause = (typeof CACHE_AUTO_PRICE_CAUSES)[number];

/**
 * The price-file rates the `auto` choice reads, in the order a `missing` list names them (the price
 * file's own order).
 * #896 unit B: `cache_write`, the one write rate of a provider with one
 * lifetime (OpenAI). Anthropic's `missing` names only `cache_read`, `cache_write_5m` and
 * `cache_write_1h`; OpenAI's only `cache_read` and `cache_write`.
 * @public
 */
export const CACHE_AUTO_RATES = [
  'cache_read',
  'cache_write',
  'cache_write_5m',
  'cache_write_1h',
] as const;
/**
 * One of the words in `CACHE_AUTO_RATES`: a price-file rate the `auto` choice reads, as a `missing`
 * list in `CacheAutoPrices` names it.
 * @public
 */
export type CacheAutoRate = (typeof CACHE_AUTO_RATES)[number];

/**
 * Where the `auto` choice took its prices: the runner's price file (`economics`), or none, with the
 * cause (`CacheAuto.prices`). From the price file, the one lifetime it could not cost is excluded.
 * Closed-set words only: no model id, no path.
 * @public
 */
export type CacheAutoPrices =
  | { from: 'economics'; excluded?: ['short'] | ['long']; missing?: [CacheAutoRate] }
  | { from: 'none'; cause: CacheAutoPriceCause; missing?: CacheAutoRate[] };

/**
 * A request's `cache_auto`: the basis of the `auto` choice, the gaps it read, and where its prices
 * came from. `prices` is absent when no price was needed (no kept gap).
 * Normalised where it enters the record (`normalizeCacheAuto`).
 * @public
 */
export interface CacheAuto {
  basis: CacheAutoBasis;
  gaps_s?: number[];
  prices?: CacheAutoPrices;
}

/**
 * Which kind of address a request went to: the provider SDK's default (`default`) or another one
 * (`custom`) (`UsageRecord.endpoint`). `custom` is set by `--base-url`, `ANTHROPIC_BASE_URL` or
 * `OPENAI_BASE_URL`.
 * Produced by each adapter from its SDK client's
 * `baseURL`; the address itself is never stored.
 * @public
 */
export const REQUEST_ENDPOINTS = ['default', 'custom'] as const;
/**
 * One of the words in `REQUEST_ENDPOINTS`: whether a request went to the provider's own default
 * address or a custom one (`UsageRecord.endpoint`).
 * @public
 */
export type RequestEndpoint = (typeof REQUEST_ENDPOINTS)[number];

/**
 * Issue #600 PR 2 — why a step's `CostView` has no readable value for a request fact (`models`,
 * `cache_requested`), derived at read and never written (framework §5 E1): `none_readable` (realm
 * drove the requests — at least one carries `provider` — and holds no readable value: none was
 * stated, or the one stated was refused) or `predates_request_facts` (written by Realm 0.47.0 or
 * earlier, or by a host that does not record it). Produced by core's `composeCostView`.
 */
export const REQUEST_FACT_ABSENT_CAUSES = ['predates_request_facts', 'none_readable'] as const;
export type RequestFactAbsentCause = (typeof REQUEST_FACT_ABSENT_CAUSES)[number];

/**
 * Issue #600 — one entry per wire request a step made, in wire order. The token counters and
 * `cache_creation` are what THE PROVIDER REPORTED: an absent one was not reported, and none is ever
 * defaulted to `0`. `model` is what the provider's response named. The other request fields (issue
 * #600 PR 2) are what realm asked for and where it sent the request.
 *
 * ENGINE semantics, not either provider's own field names — no consumer of this record may need to
 * know which provider produced it (R21). The two providers' "input tokens" mean OPPOSITE things:
 * Anthropic's `input_tokens` is the portion of the prompt AFTER the last cache breakpoint that
 * isn't cached (so the prompt total is the disjoint three-term sum `uncached_input_tokens +
 * cache_read_input_tokens + cache_creation_input_tokens`); OpenAI's `prompt_tokens` IS the total,
 * and its `cached_tokens` is a SUBSET already included in it (summing would double-count). Each
 * adapter maps its own provider's fields onto `prompt_tokens` and `uncached_input_tokens` using its
 * own provider's semantics — this record's own arithmetic must never be re-derived at a render site.
 */
/**
 * The cache fields Realm itself adds to a request: Anthropic's `cache_control` markers and OpenAI's
 * `prompt_cache_key`; the closed set a recorded refusal names.
 * Normalised at the write: any other name drops the fact.
 * @public
 */
export const CACHE_CONTROL_FIELDS = ['cache_control', 'prompt_cache_key'] as const;
/**
 * One of the words in `CACHE_CONTROL_FIELDS`: a cache field Realm itself adds to a request, as
 * `CacheControlsRejected.fields` names the ones a custom endpoint refused.
 * @public
 */
export type CacheControlField = (typeof CACHE_CONTROL_FIELDS)[number];

/**
 * What carried a cache marker, or OpenAI's key, on one request (`UsageRecord.cache_marked`). The
 * parts: the `system` text and the prompt's head block (Anthropic's markers, and OpenAI's marks on
 * GPT-5.6 and later), or OpenAI's `key`.
 * Caching 3-M (A-0): or the `conversation` so far — the marker Anthropic's tool
 * main turns put on a copy of the last message (#899).
 * @public
 */
export const CACHE_MARKED_PARTS = ['system', 'prompt', 'key', 'conversation'] as const;
/**
 * One of the words in `CACHE_MARKED_PARTS`: a part of a request that carried a cache marker, or
 * OpenAI's key (`UsageRecord.cache_marked`).
 * @public
 */
export type CacheMarkedPart = (typeof CACHE_MARKED_PARTS)[number];

/**
 * A SHA-256 (64 lowercase hex) of each part a request sent: `system`, and `tools`, `prompt` and
 * `format` where it had them (`UsageRecord.prefix_parts`). `prompt` is the first characters Realm
 * cut as the head on a split request, even when it went out whole; else the prompt as that request
 * sent it. `cache_marked` says which parts carried a marker.
 * @public
 */
export interface PrefixParts {
  tools?: string;
  system: string;
  prompt?: string;
  format?: string;
}

/**
 * Anthropic's reasons a request's cache read fell short, and `unknown` for a reason Realm does not
 * know, recorded as such and never verbatim (`CacheMissReason.type`).
 * @public
 */
export const CACHE_MISS_TYPES = [
  'messages_changed',
  'model_changed',
  'system_changed',
  'tools_changed',
  'previous_message_not_found',
  'unavailable',
  'unknown',
] as const;
/**
 * One of the words in `CACHE_MISS_TYPES`: Anthropic's reason a request's cache read fell short
 * (`CacheMissReason.type`).
 * @public
 */
export type CacheMissType = (typeof CACHE_MISS_TYPES)[number];

/**
 * What Anthropic said in words for a request that named an earlier answer: `no_divergence`,
 * `pending` or `not_returned`. `no_divergence`: it found none; `pending`: it has not worked it out
 * yet; `not_returned`: the answer carried nothing Realm can read.
 * @public
 */
export const CACHE_DIAGNOSTICS_WORDS = ['no_divergence', 'pending', 'not_returned'] as const;
/**
 * One of the words in `CACHE_DIAGNOSTICS_WORDS`: what Anthropic said in words about a cache miss,
 * for a request that named an earlier answer.
 * @public
 */
export type CacheDiagnosticsWord = (typeof CACHE_DIAGNOSTICS_WORDS)[number];

/**
 * Anthropic's reason for a cache miss, with its approximate token count when given.
 * @public
 */
export interface CacheMissReason {
  type: CacheMissType;
  cache_missed_input_tokens?: number;
}

/**
 * A request's question to Anthropic about a cache miss, and its answer
 * (`UsageRecord.cache_diagnostics`). One of three shapes: it did not ask because Anthropic refused
 * the question in this drive; it asked with no earlier message (a call's first request); or it
 * named an earlier answer, with what came back.
 * @public
 */
export type CacheDiagnostics =
  | { asked: false; cause: 'rejected' }
  | { asked: true; reference_id: null }
  | { asked: true; reference_id: string; result: CacheDiagnosticsWord | CacheMissReason };

/**
 * Where a request's copied predecessor came from: `run` (this run's record) or `earlier_run`
 * (another run's) (`CacheReference.from`). `run`: the first request of the same step's last call
 * there, from an earlier drive; `earlier_run`: the same step's first request there.
 * Normalised at the write: any other word drops the reference.
 * @public
 */
export const CACHE_REFERENCE_SOURCES = ['run', 'earlier_run'] as const;
/**
 * One of the words in `CACHE_REFERENCE_SOURCES`: where the copy of a request's predecessor was
 * found, in this run or an earlier one (`CacheReference.from`).
 * @public
 */
export type CacheReferenceSource = (typeof CACHE_REFERENCE_SOURCES)[number];

/**
 * A copy of a request's predecessor, the same step's previous request, kept when it is not an
 * earlier entry of the same stored list (`UsageRecord.reference`). It is the first request of the
 * step's last call on the run's record, or the same step's first request in another run
 * (`earlier_run`).
 * `from` says where it was found,
 * `request_start` is required, and each other field but one is the predecessor's own, copied when it
 * had one; `cache_requested` says whether it asked the provider to cache (piece A-1b). The one
 * exception is `agent_profile_changed` (piece C3), which is no field of the predecessor: `true` when
 * the step's agent profile differs between the two requests and both are known, worked out where the
 * copy is made, and absent otherwise. `prefix_sha256` is not copied (it equals
 * `prefix_parts.prompt` on both providers). Never a `reference` of its own, never a `request_index`
 * (an index is not identity, #715 (R)), never a `request_in_call` (the copy is always a call's first
 * request).
 * @public
 */
export type CacheReference = { from: CacheReferenceSource } & Pick<UsageRecord, 'request_start'> &
  Partial<
    Pick<
      UsageRecord,
      | 'request_id'
      | 'provider'
      | 'model'
      | 'endpoint'
      | 'cache_requested'
      | 'cache_read_input_tokens'
      | 'cache_creation_input_tokens'
      | 'cache_write_tokens'
      | 'cache_creation'
      | 'cache_lifetime_s'
      | 'cache_ttl_sent'
      | 'cache_auto'
      | 'prefix_chars'
      | 'prefix_parts'
      | 'cache_marked'
      | 'request_strict_sent'
    >
  > & { agent_profile_changed?: true };

/**
 * A custom endpoint answered 400 naming a cache field Realm added, and a retry without the cache
 * fields worked (`UsageRecord.cache_controls_rejected`).
 * `proven` is `cache_fields` when the request that worked
 * dropped only the cache fields, `none` when it also dropped strict (#311's ladder ran on the retry's
 * 400). What the provider said stays in the verbatim error facts (`api_param`, `api_code`, #313).
 * @public
 */
export interface CacheControlsRejected {
  status: 400;
  dropped: 'cache_fields'[];
  proven: 'cache_fields' | 'none';
  fields: readonly CacheControlField[];
}

/**
 * One request a step sent to a model provider, as the record keeps it: its index and start, its
 * token counts and its cache facts (`StepCacheDetail.requests`, `DriveFailureRecord.usage`).
 * @public
 */
export interface UsageRecord {
  /**
   * 0-based, in wire order — across a step's schema-repair calls too. A step is 1 to 21+ wire
   * requests, never assume 2 or 3.
   */
  request_index: number;
  /** ISO, when this request left. */
  request_start: string;
  /** The WHOLE prompt this request billed (engine semantics — see the interface doc above). */
  prompt_tokens?: number;
  /** Of that prompt, the part not served from cache. */
  uncached_input_tokens?: number;
  /** Of that prompt, the part served from cache. */
  cache_read_input_tokens?: number;
  /** Of that prompt, the part written to cache. */
  cache_creation_input_tokens?: number;
  /**
   * Where a provider reports cache writes as a separate counter from
   * `cache_creation_input_tokens`. The two are ALTERNATIVE SPELLINGS of one quantity (Anthropic
   * reports the first, OpenAI the second), never two additive components — a reader takes
   * whichever is present and never sums them.
   */
  cache_write_tokens?: number;
  output_tokens?: number;
  /**
   * The TTL split of `cache_creation_input_tokens`. Anthropic's response reports BOTH ephemeral
   * counters as required numbers on every response (its own `CacheCreation` type) — a `'5m'|'1h'`
   * enum is the REQUEST-side `cache_control.ttl` and cannot express a response that reports both.
   * `cache_creation_input_tokens` equals the sum of this split when both are present (the
   * provider's own documented invariant — see `deriveCacheDetail`'s doc comment for the citation);
   * this record never needs to re-derive that sum from the split.
   */
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
  /**
   * Issue #600 PR 2 — the model the provider's response named (a dated id, for one), when the
   * response named one. Written by the adapter; bounded where it enters the record
   * (`boundRequestFacts`). Not redacted.
   */
  model?: string;
  /**
   * Issue #600 PR 2 — what realm asked the provider to cache on this request. Written by the
   * adapter; bounded where it enters the record (`boundRequestFacts`).
   */
  cache_requested?: CacheRequest;
  /** Issue #600 PR 2 — the lifetime asked for, in seconds; present iff `cache_requested` is `lifetime`. */
  cache_lifetime_s?: number;
  /**
   * Issue #600 PR 2 — whether realm sent that lifetime on the wire (`true`), or asked for the
   * provider's default one (`false`); present iff `cache_requested` is `lifetime`.
   */
  cache_ttl_sent?: boolean;
  /**
   * Issue #600 PR 2 — where the setting came from, when the adapter was given it. Bounded where it
   * enters the record (`boundRequestFacts`).
   */
  cache_requested_source?: CacheRequestSource;
  /**
   * Issue #600 PR 2 — the runner that chose the setting (`realm agent`, `realm listen`), when given.
   * Bounded where it enters the record (`boundRequestFacts`).
   */
  cache_requested_by?: string;
  /**
   * Issue #600 (the lifetime unit) — present iff the setting was `auto`: the basis of the choice,
   * and the gaps it read. `gaps_s` is present iff `basis` is `step_gaps` (caching 3-M D-2): 0 to 5
   * whole seconds, each from 0 to 604 800, oldest first. Issue #898: `prices` says where the choice took
   * its prices, present only when gaps were kept. Normalised where it enters the record
   * (`boundRequestFacts` → `normalizeCacheAuto`).
   */
  cache_auto?: CacheAuto;
  /**
   * Issue #600 PR 2 — the provider that served the request. Stamped by `realm agent` from its one
   * provider fact (`anthropic`, `openai`, `openai-reasoning`, `module:<file>`), never by an adapter.
   * Bounded where it enters the record (`boundRequestFacts`).
   */
  provider?: string;
  /** Issue #600 PR 2 — which kind of endpoint the request went to. Written by the adapter. */
  endpoint?: RequestEndpoint;
  /**
   * Issue #600 PR 2 — whether the provider reports a lifetime split of its cache writes
   * (`cache_creation`). Written by the adapter whenever it writes `cache_requested`.
   */
  cache_split_offered?: boolean;
  /**
   * Issue #715 (R; decisions D6-28, D6-44) — this request's identity: a random UUID (version 4)
   * realm mints once per request, where a provider's answer enters realm's records
   * (`mintRequestIds`, called at `realm agent`'s receiving sites). It ALWAYS overwrites any value a
   * provider's own usage carried. It is the key `sameRequest` matches on and nothing else — never a
   * time, a count, an index or a version — and it guards one decision: whether a call is attached to
   * a drive-failure entry or is already on the step's record (`callsAlreadyRecorded`). It does not
   * de-duplicate the cost totals a reader computes. It is NOT a provider's request id (`request-id`,
   * `x-request-id`, an SDK's `_request_id`) and NOT Temporal's request de-dupe id; the id of a
   * provider's answer is `response_id`; a provider's request id is not kept. Absent on a record
   * written by an earlier process, or by a host that embeds the engine and records usage itself: no
   * reader derives anything from it, and `sameRequest` answers `false` for such a record.
   */
  request_id?: string;
  /**
   * Caching 3-M (piece B1) — the id of the provider's answer to this request (Anthropic's `msg_…`),
   * kept for piece B2, which will name the earlier message when it asks Anthropic about a cache
   * miss. It is not Realm's `request_id` (identity), and not a provider's request id. Kept only when
   * it passes `normalizeResponseId` (it starts `msg_`, is at most 256 characters and holds no
   * control character), at the adapter and again where the record is written. Absent for OpenAI's
   * requests, for an answer that carried none, and for an id that fails the check; a provider
   * module's own `response_id` obeys the same check.
   */
  response_id?: string;
  /**
   * Caching 3-M (piece B3a) — what this request asked Anthropic about a cache miss, and what Anthropic
   * answered, in closed form. Absent on every request that was never going to ask: asking off, a
   * custom address, another provider, a tool step's final extraction, a settled `off`. Kept only in
   * one of {@link CacheDiagnostics}'s shapes where the record is written (`normalizeCacheDiagnostics`):
   * every word is closed and the one id is checked, so no provider text reaches a broadcast surface.
   */
  cache_diagnostics?: CacheDiagnostics;
  /**
   * Caching 3-M (piece A-1b): this request's place, from 0, among the recorded requests of the one
   * provider call that made it. A call's first recorded request is 0: a single-shot step's request
   * and a tool step's first turn. A retry that answered in place of a refused send takes that send's
   * place (the refused send has no record): 0 when the refused send was the call's first request,
   * otherwise that turn's place. A tool step's later turns, the JSON retry and a tool step's final
   * request are 1 and up. A step's attempt is one call; a #217 repair attempt is a new one, starting
   * at 0. Minted by `realm agent` where a call's usage enters the record (`mintRequestIds`), from the
   * request's slot in the call's array; normalised where it enters the record (`boundRequestFacts`).
   * It is not identity (an index is not identity, #715's rule): only its zero is read, to find where
   * a call begins. Absent on a request recorded before this field existed.
   */
  request_in_call?: number;
  /**
   * Caching 3-B (A6, B2): the SHA-256 of the prompt's cached HEAD as sent (its UTF-8 bytes), as 64
   * lowercase hex characters with no prefix. On OpenAI it is also the cache key. On Anthropic's
   * one-block shape the head is the whole prompt text. The system text's hash is
   * `prefix_parts.system`'s. Written only on a request whose prompt was split.
   */
  prefix_sha256?: string;
  /** Caching 3-B (A6): the head's length as sent, after disclosure, in UTF-16 code units. */
  prefix_chars?: number;
  /** Caching 3-B (A6), 3-M (A-0): a SHA-256 for each part of what the request sent: `system`, and
   *  `tools`, `prompt` (the first characters Realm cut as the head on a split request, even when it
   *  went out whole; else the prompt as that request sent it) and `format` where it had them;
   *  `cache_marked` says which parts carried a marker. */
  prefix_parts?: PrefixParts;
  /** Caching 3-B (A6): what carried a cache marker or the key on this request. Absent when nothing
   *  did: under `--prompt-cache off`, after the endpoint refused the cache fields, on Anthropic's
   *  tool-loop final request, and on an OpenAI request that carried neither a mark nor the key. */
  cache_marked?: CacheMarkedPart[];
  /** Caching 3-B (A6, C5): whether this request carried strict structured output or strict tool
   *  arguments (D3's `strict_sent`, renamed: `tool_args.tools[].strict_sent` already uses that
   *  word). */
  request_strict_sent?: boolean;
  /** Caching 3-B (A6, E3): the endpoint's refusal of Realm's cache fields, recorded on the request
   *  whose retry without them worked, and on every later request of the drive. */
  cache_controls_rejected?: CacheControlsRejected;
  /** Caching 3-B (A6, D2): this OpenAI request carried the cache key, a hint, not an ask: beside
   *  `provider_rules`, or (#896) beside the 30-minute ask on GPT-5.6 and later. */
  cache_key_sent?: true;
  /**
   * Caching 3-M (piece A-1): a copy of this request's predecessor, the same step's previous
   * request. Set only on a step's first request in a drive, when its predecessor is on the run's
   * record (an earlier drive that failed the step, or a step resumed and driven again): the first
   * request of the step's last call there (piece A-1b), `from: 'run'`; or on another run's record,
   * `from: 'earlier_run'` (piece C2 writes it). Every other request's
   * predecessor is an earlier entry of the same stored list, so nothing is copied for it. It never
   * holds a `reference` of its own, never `request_index` (an index is not identity, #715's rule),
   * and never `request_in_call` (the copy is always a call's first request). Minted by `realm
   * agent` (`attachRecordedReference`); normalised where it enters the record (`boundRequestFacts`).
   */
  reference?: CacheReference;
}

/**
 * A step's cache facts: its state, how they are known, and each request's detail
 * (`EvidenceSnapshot.cache`).
 * @public
 */
export interface StepCacheDetail {
  state: CacheState;
  basis: CacheBasis;
  requests: UsageRecord[];
}

/**
 * The parties that supply a step's input or output, as an evidence entry records them
 * (`EvidenceSnapshot.supplied_by`).
 * PR-0's producer is the agent's answer to an agent step; a door
 * through which an operator supplies an engine step's input adds `operator` with it (the membership
 * rule — no member is reserved).
 * @public
 */
export const SUPPLIER_ROLES = ['agent'] as const;
/**
 * One of the words in `SUPPLIER_ROLES`: who supplied a step's input or output, as an evidence entry
 * records it (`EvidenceSnapshot.supplied_by`).
 * @public
 */
export type SupplierRole = (typeof SUPPLIER_ROLES)[number];

/**
 * Why an evidence entry names no supplier.
 * @public
 */
export const SUPPLIER_ABSENT_CAUSES = ['engine_input', 'not_recorded'] as const;
/**
 * One of the words in `SUPPLIER_ABSENT_CAUSES`: why an evidence entry names no supplier
 * (`readSupplier`'s `absent`).
 * @public
 */
export type SupplierAbsentCause = (typeof SUPPLIER_ABSENT_CAUSES)[number];

/**
 * Where a bare `auto` step's recorded output came from (`EvidenceSnapshot.output_source`).
 * A bare `auto` step has no handler and no service.
 *  - `driven_step`: what the caller that named the step returned through its dispatcher;
 *  - `dependency`: its single `depends_on` step's recorded output (the engine ran it);
 *  - `run_params`: the run's params (the step has no `depends_on`);
 *  - `none`: nothing to copy, so the step recorded `{}` — the engine ran a step that depends on more
 *    than one step, or whose single dependency has no successful entry (a trigger rule let it run
 *    after that step failed or was skipped).
 * @public
 */
export const OUTPUT_SOURCES = ['driven_step', 'dependency', 'run_params', 'none'] as const;
/**
 * One of the words in `OUTPUT_SOURCES`: where a bare `auto` step's recorded output came from
 * (`EvidenceSnapshot.output_source`).
 * @public
 */
export type OutputSource = (typeof OUTPUT_SOURCES)[number];

/**
 * The text of each model call made for a step, on its evidence entry
 * (`EvidenceSnapshot.model_text`). `realm agent` and `realm listen` write it; a program that embeds
 * the engine can pass its own in `StepMeta.modelText`.
 *
 * `recorded: true` holds the texts. `messages` holds each distinct message once, and `tools` each
 * distinct tool list (the request's tools as JSON). `realm agent` and `realm listen` mask each text
 * for known secret values (`hidden` counts what that mask hid), then cut it at 64 KB of UTF-8 on a
 * code-point boundary (`cut` gives the bytes kept and the text's full size). The engine stores a
 * `StepMeta.modelText` as it is given: it neither masks nor cuts it. Each of `requests` names what
 * one request sent and what came back by their places in `messages`, its tool list by its place in
 * `tools`, and carries its `request_id` (the id of its entry in `diagnostics.cache.requests`).
 *
 * A message's text is its parts in order with no separator: a text part as it is; any other part
 * as compact JSON, of a tool part's `type`, `id`, `tool_use_id`, `tool_call_id`, `name`, `input`,
 * `content` and `is_error`, of a thinking part's `type` and `thinking`, of any other part's `type`.
 * Cache marks, signatures and the data of a redacted thinking part are not kept.
 *
 * `recorded: false` says why a step Realm drove has no texts: recording was switched off
 * (`--no-record-model-text`), or the provider module reported none it could read.
 * @public
 */
export type ModelText =
  | {
      recorded: true;
      messages: Array<{
        role: 'system' | 'user' | 'assistant' | 'tool';
        text: string;
        cut?: { kept_bytes: number; full_bytes: number };
        hidden?: number;
      }>;
      tools: Array<{
        json: string;
        cut?: { kept_bytes: number; full_bytes: number };
        hidden?: number;
      }>;
      requests: Array<{
        request_id: string | null;
        sent: number[];
        tools?: number;
        reply: number[] | null;
      }>;
    }
  | { recorded: false; why: 'switched_off' | 'provider_did_not_report' };

/**
 * One evidence entry of a run's record (`RunRecord.evidence`): what one step run or one answered
 * question recorded, with its times, its input and output, its status and its hash.
 * @public
 */
export interface EvidenceSnapshot {
  step_id: string;
  started_at: string;
  completed_at: string;
  duration_ms: number;
  input_summary: Record<string, unknown>;
  output_summary: Record<string, unknown>;
  status: 'success' | 'error' | 'skipped' | 'abandoned';
  error?: string;
  evidence_hash: string;
  attempt?: number;
  /** Distinguishes computation records from human decision records. Absent on pre-existing entries. */
  kind?: 'execution' | 'gate_response';
  /**
   * Verbatim message presented to the human reviewer when they made this gate choice.
   * Present only on gate_response evidence entries when gate.message was configured.
   * This is an evidence integrity field: it records exactly what the human read.
   */
  gate_message?: string;
  /**
   * Issue #279 (increment 2, PR-D; design record D-5): unenforced attribution passthrough for a
   * gate resolution — the caller-supplied identity of whoever made this gate choice, when
   * supplied. RECORDED, not enforced (D-5: the bearer-gateId-as-sole-credential model stays the
   * authority; no arm reads this field). Present on `gate_response` evidence entries whose caller
   * supplied `respondedBy`/`responded_by` — and on the entry the gate's EXPIRY writes, as the literal
   * `'timeout'` beside `resolution` (no answer was recorded in time; never migrated — the step view reads such an
   * entry as `settled_by_expiry`, keyed on `resolution`).
   */
  responded_by?: string;
  /**
   * Holder slice (PR-H): which PROGRAM's code and credentials did this work — the name the host
   * that ran the step gave itself (`REALM_OPERATOR`, or the OS user and host name), how that name is
   * known, and the host's channel. Written on the entries where a program's code ran (a step's own
   * entries and the cleanup steps a drain runs) and — #627 W (§5.8) — on a `gate_response` entry an
   * ANSWER wrote, naming the program that recorded it; #729 CW-3b: on an automatic take-back's entry
   * (`reason: 'lease_not_held'`), naming the program that took the step back. Absent on every other
   * entry the engine builds without running anyone's code (guards, expiries, a manual reclaim's
   * audit line), on an answer whose caller passed no driver, and on records written before this
   * field. A label for people and
   * replies — never compared, never enforced; it is not a person and not a process.
   */
  driven_by?: Attributed;
  /**
   * #627 W (§5.8): how a gate answer arrived, as the door that recorded it declared — its route
   * (`mcp_form`, `mcp`, `cli`, or another door's id), and, for a form, what showed it — or
   * `{ absent: 'route_not_declared' }` when a library caller declared none. Present only on a
   * `gate_response` entry an answer wrote from this version on: an entry without it reads
   * `recorded_without_route` (which makes no claim about when it was written — an older binary may
   * write after this one), an expiry's entry `settled_by_expiry`. Never in `evidence_hash`.
   */
  answer?: AnswerOnRecord;
  /**
   * #627 W (§5.2 row 3, F30): the answer came through the MCP door's fallback, whose answer tool asks
   * the client to have its user approve each call. Realm cannot see whether anyone approved.
   */
  client_prompt_requested?: true;
  /**
   * #627 W (§5.8, F29): what the door's transport authenticated for this answer — an API key's id,
   * `realm serve`'s one shared token (which names no one), or why the door names none. Written by the
   * door into the answer's own write; never a secret.
   */
  principal?: Principal;
  /**
   * Issue #625 PR-2a (decision C3): on a BARE `auto` step's entry only — where its output came
   * from, a member of {@link OUTPUT_SOURCES}. Absent on every other entry and on entries written
   * before the field; core's `outputSourceOf` says, for any entry, the source or why it has none.
   */
  output_source?: OutputSource;
  /**
   * issue #729 PR-0 (T-17 (ii); §5 E1): who supplied this entry's input or output — the PARTY of
   * the door the call came through, beside `driven_by` (the program). `agent`: an agent step's answer.
   * (i) Written only at its mint, on the entry of an agent step's own attempt; (ii) absent on every
   * entry whose input the engine built and on entries written before this field — read through
   * `readSupplier`, which names why (`engine_input`, `not_recorded`); (iii) said on `realm run
   * inspect`'s attribution line BY RULE — only when the role differs from the party the step is
   * designed for (an engine step given an operator's input); the expected case (an agent's answer to
   * an agent step) and every absence print nothing, and in PR-0 no path writes a differing role;
   * (iv) the run-store fidelity contract's SUPPLIER_ROUND_TRIPS law. A
   * role, never a name: realm never claims who was on the other end.
   */
  supplied_by?: SupplierRole;
  /**
   * Holder slice (PR-H): present only on a `gate_response` entry the ANSWER wrote, and only when the
   * answer was recorded (verdict rows 1–5; a settled question has no entry to carry `spent`).
   * Whether the caller passed back the claim token the reply that opened the question carried (#729
   * PR-0: its `respond` way's `proof`), as `claim_token`, judged inside the answer's own write. It
   * decides nothing: the answer is recorded the same with any token or none.
   */
  claim_proof?: GateClaimVerdict;
  /**
   * #603 A3a: present only on a `gate_response` entry the ANSWER wrote, judged inside its write — how
   * the answer's sender was let through: `owner`, `answerers` or `project_answerers` (the account the
   * channel reported is on that list), `no_named_answerer` (the question named no one, so anyone
   * counted) or `owner_not_checked_on_route` (the question names someone, and the answer carried no
   * channel evidence to compare). Absent on an expiry's entry and on entries written before it.
   */
  admitted_by?: AdmittedBy;
  /**
   * Issue #291 (D1 §5 / [F12]): present only on a `gate_response` snapshot minted by
   * `applyExpireGate` — discriminates WHICH enforce-clock disposition produced this snapshot,
   * for the late-response envelope strings to read. `responded_by` on the SAME snapshot is
   * always the literal `'timeout'` when this field is present (never a human identity).
   */
  resolution?: 'expired_default' | 'expired_abort';
  /** Diagnostic metadata. Present on snapshots captured after Week 7. */
  diagnostics?: StepDiagnostics;
  /** Name of the agent profile active at this step, if any. */
  agent_profile?: string;
  /** SHA-256 hash of the profile content at register time. Auditable even if the file changes. */
  agent_profile_hash?: string;
  /** MCP tool calls made during this step, if any. */
  tool_calls?: ToolCallRecord[];
  /**
   * Gap 1, unit A1: the text of each model call of this attempt ({@link ModelText}). Written once,
   * with the attempt's `diagnostics`: by `realm agent` and `realm listen` on every entry of an
   * attempt whose model calls they made (the texts, or a marker saying why there are none), or as a
   * program that embeds the engine passes it in `StepMeta.modelText`. Absent on any other entry,
   * and on entries written before this field. Never in `evidence_hash`, `get_run_state` or a
   * prompt.
   */
  model_text?: ModelText;
  /**
   * Present only when the step used input_map. Records the concrete params the engine
   * derived from run state and passed to the service adapter. Absent for all other step types.
   */
  resolved_params?: Record<string, unknown>;
  /**
   * Warning message emitted by the step handler. Present when the handler returned
   * a warn result. The step completed normally; this is advisory only.
   * Never included in evidence_hash.
   */
  warn?: string;
  /**
   * Optional agent-submitted reasoning or diagnostic notes.
   * Extracted from params._debug before schema validation — never validated, never hashed.
   * Present only when the agent included _debug in their execute_step params.
   */
  debug_output?: unknown;
  /**
   * Canonical stored trace entries for this step. Present only on agent execution steps
   * when the agent submitted a non-empty trace that survived normalization.
   * Excludes evidence_hash computation — integrity is tracked separately via trace_digest.
   */
  trace?: TraceEntry[];
  /**
   * SHA-256 hex digest of JSON.stringify(trace). Present when trace is non-empty.
   * Separate from evidence_hash, which covers output_summary only.
   */
  trace_digest?: string;
  /**
   * Discard and truncation accounting from the trace normalizer.
   * Present whenever the agent submitted a trace (even if all entries were dropped).
   * Absent when no trace was submitted.
   */
  trace_summary?: TraceNormalizationSummary;
  /**
   * The timeout (in seconds) actually enforced on THIS ATTEMPT's dispatch (issue A3; issue #140
   * amends the semantics — see below): the authored timeout_seconds if declared, else
   * DEFAULT_EXECUTION_TIMEOUT_SECONDS. Present ONLY when shouldEnforceTimeout(step) was true
   * (execution: auto) — additive-optional, so absent on every pre-existing snapshot and on
   * agent/guard/finalizer steps, which are never bounded by withTimeout.
   *
   * Issue #140: on a retry-configured step this is now a PER-ATTEMPT value, not a single
   * step-wide constant — a later attempt's value can be SMALLER than an earlier attempt's once
   * the step's total-time cap (`clipped_to_ms` below) starts biting. On a step with no `retry:`
   * block (or one whose cap hasn't bitten yet) every attempt's value is identical to the
   * step's own declared/default timeout, byte-unchanged from pre-#140 behavior.
   */
  effective_timeout_seconds?: number;
  /**
   * Issue #140: present ONLY on an attempt whose effective timeout was CLIPPED below the step's
   * own declared/default `timeout_seconds` by its total-time cap (`retry.total_timeout_seconds`,
   * explicit or the amended default) — the actual millisecond bound this attempt was clipped to.
   * Absent on an uncapped attempt, on any attempt the cap has not reduced, and ALWAYS on the
   * first attempt of a step whose `total_timeout_seconds` equals its `timeout_seconds` —
   * equality is bounded, never clipped (issue #573: the budget is read once, at dispatch).
   * Always a whole millisecond (issue #573).
   */
  clipped_to_ms?: number;
  /**
   * Issue #140: present ONLY on the FINAL attempt's snapshot of a step that stopped retrying
   * because either its attempt budget or its total-time cap ran out — `'attempts'` when
   * `attemptsUsed === maxAttempts` drove the stop, `'total_timeout'` when the cap did (wins the
   * both-true tie). Durable even when the settle path does NOT wrap the error into
   * `STEP_RETRY_EXHAUSTED` (the issue #134 recoverable-incapability carve-out never wraps) — this
   * evidence stamp is then the only record of *why* the step stopped.
   *
   * Issue #573: `'total_timeout'` is stamped BY CONSTRUCTION whenever the last attempt's bound
   * was the remaining budget and it timed out — for a `STEP_TIMEOUT`, never by comparing clocks
   * after the fact, because Node/libuv timers fire early against any clock (loop time is floored
   * to whole milliseconds — under 1 ms on the machines that measured it, possibly more on a host
   * with a coarse clock); `duration_ms` may therefore read slightly below the bound beside it,
   * truthfully. Any OTHER error still exhausts the cap by the elapsed-budget comparison.
   */
  exhausted_by?: 'attempts' | 'total_timeout';
  /**
   * On a failed attempt's entry (a step's, a cleanup step's or a guard's; never a guard that fired,
   * which is a skip): the error's code.
   */
  error_code?: ErrorCode;
  /**
   * On a failed attempt's entry: the code's category (`NETWORK`, `SERVICE`, `STATE`, `VALIDATION`,
   * `ENGINE`, `RESOURCE`).
   */
  error_category?: ErrorCategory;
  /**
   * On a failed attempt's entry: the error's action word (`report_to_user`, `stop`,
   * `wait_for_service`, …); on the last entry of a step that failed, where the reply wraps the
   * failure as `STEP_RETRY_EXHAUSTED`, the wrap's `report_to_user`.
   */
  agent_action?: AgentAction;
  /**
   * On the last entry of a step that failed, and on the entry of a step handed back because this
   * runner has no handler or adapter for it (the step is not failed): why Realm stopped retrying —
   * `no_retry_policy` (the step has no `retry` block), `total_timeout` (its `total_timeout_seconds`
   * ran out), `non_retryable` (the error is not retried), or `attempts` (its `max_attempts` were
   * used).
   */
  stop_reason?: 'no_retry_policy' | 'total_timeout' | 'non_retryable' | 'attempts';
}

/** Every evidence entry status (`EvidenceSnapshot['status']`); compile-checked both ways. */
export const EVIDENCE_STATUSES = [
  'success',
  'error',
  'skipped',
  'abandoned',
] as const satisfies readonly EvidenceSnapshot['status'][];
type MissingEvidenceStatus = Exclude<
  EvidenceSnapshot['status'],
  (typeof EVIDENCE_STATUSES)[number]
>;
const _everyEvidenceStatusListed: [MissingEvidenceStatus] extends [never]
  ? true
  : MissingEvidenceStatus = true;
void _everyEvidenceStatusListed;

/** The words of an evidence entry's `exhausted_by`: why a step stopped retrying, out of budget. */
export type ExhaustedBy = NonNullable<EvidenceSnapshot['exhausted_by']>;

/** Every {@link ExhaustedBy} word, in the field's order; compile-checked both ways. */
export const EXHAUSTED_BY = ['attempts', 'total_timeout'] as const satisfies readonly ExhaustedBy[];
type MissingExhaustedBy = Exclude<ExhaustedBy, (typeof EXHAUSTED_BY)[number]>;
const _everyExhaustedByListed: [MissingExhaustedBy] extends [never] ? true : MissingExhaustedBy =
  true;
void _everyExhaustedByListed;

/**
 * Q1 (#592): why a step's retrying stopped — no retry policy, the total-time cap, an error that is
 * not retried, or the attempts used up. The engine writes it on the last entry of a step that
 * failed (`EvidenceSnapshot.stop_reason`, unit a); the type is that field's words, as
 * {@link ExhaustedBy} is `exhausted_by`'s.
 */
export type StopReason = NonNullable<EvidenceSnapshot['stop_reason']>;

/** Every {@link StopReason}, in judging order; compile-checked both ways, ⊇ {@link ExhaustedBy}. */
export const STOP_REASONS = [
  'no_retry_policy',
  'total_timeout',
  'non_retryable',
  'attempts',
] as const satisfies readonly StopReason[];
type MissingStopReason = Exclude<StopReason, (typeof STOP_REASONS)[number]>;
const _everyStopReasonListed: [MissingStopReason] extends [never] ? true : MissingStopReason = true;
void _everyStopReasonListed;
type ExhaustedByNotStopReason = Exclude<ExhaustedBy, StopReason>;
const _everyExhaustedByAStopReason: [ExhaustedByNotStopReason] extends [never]
  ? true
  : ExhaustedByNotStopReason = true;
void _everyExhaustedByAStopReason;

/**
 * The question a run waits on (`RunRecord.pending_gate`): its gate id, its step, the preview and
 * choices shown to the person, when it opened, and its owner and time limit when set.
 * @public
 */
export interface PendingGate {
  gate_id: string;
  step_name: string;
  /** Output produced by the step dispatcher; presented to the human for review. */
  preview: Record<string, unknown>;
  choices: string[];
  opened_at: string;
  /**
   * The person expected to answer, stored as written: a Slack member ID (`U…`/`W…`), its mention
   * `<@U…>`, or any name. In Slack only a member ID matches a reply.
   * Optional — absent when the workflow step has no owner field.
   */
  owner?: string;
  /**
   * #603 A3a: Slack member IDs who may also answer in Slack — the gate's `answerers`, frozen when
   * the question opens. Absent when the gate lists none.
   */
  answerers?: string[];
  /**
   * Developer-authored gate message resolved from run data at gate-open time.
   * Present only when gate.message is configured on the step. Never derived from step.prompt.
   * Preserved into EvidenceSnapshot.gate_message at gate resolution for audit purposes.
   */
  resolved_message?: string;
  /**
   * Per-choice messages for Slack thread resolution confirmation.
   * Copied verbatim from gate.resolution_messages on the step definition.
   * The CLI reads the message for the chosen key and posts it to the thread.
   */
  resolution_messages?: Record<string, string>;
  /**
   * Issue #291 (mint-time freeze, F2 — the definition-drift-livelock cure): the gate's own
   * `GateConfig` timeout/notify fields, denormalized into the RECORD at mint
   * (execution-loop.ts's gate-open site — the `ClaimRecord.deadline`/#302 uniform-epoch-freeze
   * precedent). Every enactment/notification/read-side surface reads THESE fields, never the
   * workflow definition's `gate:` block — a definition edited after this gate opened (new
   * `choices`, a changed `default_choice`) never applies to an already-open gate. A gate minted
   * before this feature shipped (or by an old binary that silently ignored these `gate:`
   * sub-keys) has NONE of these fields — grandfathered: finding-silent, reminder-silent, never
   * enacted (R-d).
   */
  /** ISO-8601 deadline = `opened_at + gate.timeout_seconds`. Absent = no enforce clock (the gate
   *  never expires — grandfathered or the author declared no `timeout_seconds`). */
  expires_at?: string;
  /** Frozen copy of `gate.on_expiry`. Present only when `expires_at` is (a `timeout_seconds` with
   *  no `on_expiry` is LEGAL finding-only mode: `expires_at` present, this absent). */
  on_expiry?: 'settle_default' | 'abort';
  /** Frozen copy of `gate.default_choice`. Present iff `on_expiry === 'settle_default'`. */
  default_choice?: string;
  /** Frozen copy of `gate.reminder_seconds` — the authored notify clock. Standalone-legal
   *  (present without `expires_at` = a pure-notify gate). Absent = no authored reminder (the
   *  operator's `reminderIntervalMs` config, if any, is the fallback — record-keyed precedence). */
  reminder_seconds?: number;
  /** Frozen copy of `gate.reminder_max`, defaulted to 3 at mint when `reminder_seconds` is
   *  present and the author declared no explicit value. Absent iff `reminder_seconds` is. */
  reminder_max?: number;
}

/**
 * Derived phase of a workflow run. Always computed from the four step sets and run state;
 * never set directly by callers outside the engine.
 * @public
 */
export type RunPhase =
  'running' | 'gate_waiting' | 'completed' | 'failed' | 'abandoned' | 'aborted';

/** Every {@link RunPhase}, in the type's order; compile-checked both ways. */
export const RUN_PHASES = [
  'running',
  'gate_waiting',
  'completed',
  'failed',
  'abandoned',
  'aborted',
] as const satisfies readonly RunPhase[];
type MissingRunPhase = Exclude<RunPhase, (typeof RUN_PHASES)[number]>;
const _everyRunPhaseListed: [MissingRunPhase] extends [never] ? true : MissingRunPhase = true;
void _everyRunPhaseListed;

/**
 * Snapshot of a single workflow context entry taken at run start.
 * @public
 */
export interface WorkflowContextSnapshot {
  /** Absolute path the content was read from. */
  source_path: string;
  /** Raw file content. Empty string if the file could not be read. */
  content: string;
  /** SHA-256 hex hash of content. Empty string if the file could not be read. */
  content_hash: string;
  /** ISO timestamp when the snapshot was taken. */
  loaded_at: string;
  /** Set when the file could not be read. Content and hash will be empty strings. */
  error?: string;
}

/**
 * A step's claim, as the run keeps it while the step is being run: its deadline, its token and the
 * program that holds it (`RunRecord.claims`).
 * Written atomically when a step is claimed.
 * @public
 */
export interface ClaimRecord {
  /**
   * ISO-8601 timestamp after which the claim's deadline has passed (no result is recorded), or
   * `null` when the claim has no reliable wall-clock bound — an `execution: agent` step (its
   * dispatcher returns instantly; `timeout_seconds` is advisory), or ANY step in a
   * finalizer-bearing workflow (its claim can legitimately span the terminal finalizer drain).
   * A `null` deadline surfaces as `claim_unknown_age`: detect-only, human-judged, never
   * auto-reclaimed. A concrete deadline is set only for reliably time-boundable claims.
   */
  deadline: string | null;
  /**
   * Issue #279 (increment 1, PR-A): an acquirer-minted fencing token, stamped atomically in the
   * SAME `claimStep` write that creates this claim record (uuid; each store's own existing uuid
   * idiom). Additive-optional — legacy/pre-#279 claim records lack it, and `settleStep`'s
   * `tokensEqual` predicate treats absent as `null` (absent≡absent — the #197 grandfathered-claims
   * precedent), so a token-less claim is never spuriously fenced out. Dormant in this PR: nothing
   * reads or compares it until PR-B migrates the seal sites to `settleStep`.
   *
   * Holder slice (PR-H): the claim's token is also the PROOF a caller of the step's gate answer may
   * pass back (`claim_token`) to show it comes from the conversation that opened the question. It is
   * not a secret — it guards against accidents and races, not malice; anyone who can read the store
   * can read it, and realm has no authentication. It leaves the engine on ONE reply only: the reply
   * of the call whose `claimStep` minted it, inside that reply's `respond` way as `proof` (#729 PR-0,
   * A-17).
   */
  token?: string;
  /**
   * Holder slice (PR-H): the PROGRAM that TOOK this step — the name the host gave itself, how that
   * name is known, and the host's channel — written in the claim's own write when the host passed a
   * claimant. The claim of a step waiting on a person's answer says who ASKED the question, and
   * nothing about anyone working on it now. Two limits: on a shared server every caller's claims
   * carry the server's name, and two programs of one user on one machine are indistinguishable;
   * no process id is recorded (it would read as "running now", which a record cannot know).
   * Absent when the host passed none, or when the store dropped it.
   */
  holder?: Attributed;
  /**
   * Holder slice (PR-H): ISO time the claim was made. The store's own act, stamped on EVERY claim
   * (with or without a holder) inside the one write that creates it. Absent on claims written
   * before this field.
   */
  since?: string;
  /**
   * #729, the claim window (CW-1): the claim lease the program that took this step held while it
   * worked — its id, which the store's lease port probes. A store that keeps leases writes it in
   * `claimStep`'s one write when the caller passes the lease it holds (CW-2a: core's
   * `claimStepForDrive`, which no Realm command calls yet); a claim a gate keeps while it waits for a
   * person names none. No line prints it; `realm run export` and an automatic take-back's audit
   * entry (`prior_claim`) carry its id. A claim without it has no lease.
   */
  lease?: { id: string };
}

/**
 * The marker on a step that the program which last tried it could not run, because its handler or
 * adapter was not registered there, keyed by step name (`RunRecord.capability_blocks`).
 * Written when an auto step's handler/adapter is NOT REGISTERED in the executing runner's registry: the
 * step settles RECOVERABLY (removed from `in_progress_steps`, claim omitted, NOT added to `failed_steps`,
 * run NOT terminal-sealed) so a correctly-provisioned runner can reclaim it. Advisory metadata for
 * DETECTION and operator diagnostics ONLY — the four step sets stay authoritative for eligibility, so a
 * stale marker (step since completed on another runner) self-suppresses via the eligibility cross-check in
 * `findCapabilityBlockedSteps`. Clearing it on recovery is hygiene, not correctness. Additive-optional (the
 * `claims` / `extension_identity` precedent): legacy records lack it; JSON-file-store-only until external
 * stores round-trip unknown optional RunRecord fields through update().
 * @public
 */
export interface CapabilityBlock {
  requirement: { kind: 'handler' | 'adapter'; name: string };
  /** The minted discriminator: `ENGINE_HANDLER_NOT_REGISTERED` | `ENGINE_ADAPTER_NOT_REGISTERED`. */
  code: string;
  /** ISO-8601 timestamp of the block. */
  at: string;
}

/**
 * Why a step was skipped, keyed by step name (`RunRecord.skip_details`).
 * Additive-optional, definition-free surfacing metadata —
 * `skipped_steps` stays the authoritative set; this only explains *why*.
 * @public
 */
export type SkipDetail =
  | {
      kind: 'when_false';
      /** The step's `when` clause, verbatim (a single leaf or the joined array). */
      expression: string;
      /** Every leaf's evaluation, in declaration order — not just the first false one. */
      leaves: Array<{
        leaf: string;
        /** False when the LHS path resolved to `undefined` (a miss — commonly a field-name typo). */
        lhs_present: boolean;
        /** Omitted (not `undefined`) when `lhs_present` is false, so absence survives a JSON round-trip. */
        resolved_value?: unknown;
        passed: boolean;
      }>;
    }
  | {
      kind: 'trigger_rule_unsatisfiable';
      rule: TriggerRule;
      /** The deps whose settled state makes the rule provably unsatisfiable. */
      blocking_deps: Array<{ dep: string; state: 'completed' | 'failed' | 'skipped' }>;
    }
  | { kind: 'handler_abort' }
  | { kind: 'guard_abort' }
  /**
   * Issue #279 (increment 1, PR-A): stamped on a human-gated step whose gate was still open when
   * a DIFFERENT step's handler aborted the run — `applySettlement`'s settle_step abort arm cancels
   * the gate in the SAME atomic write (design record §3) rather than leaving it stranded open on
   * an otherwise-terminal run. A genuinely NEW capability the pre-#279 legacy handler-abort path
   * lacks (it preserves `pending_gate` untouched, which is exactly the class of inconsistent
   * terminal-with-an-open-gate state #279 exists to close). Dormant until PR-B migrates the seal
   * sites — no engine call site can produce this in PR-A.
   */
  | {
      kind: 'gate_cancelled_by_abort';
      /**
       * Issue #279 (increment 2, PR-D; design record §5 D-4): the cancelled gate's `gate_id` —
       * additive, so pre-PR-D cancel records (which lack this field) remain valid; the settle_gate
       * `run_terminal` envelope's cancelled-variant discriminator binds by skip-detail PRESENCE for
       * those (N10), and by `gate_id` equality once this field is populated.
       */
      gate_id?: string;
    }
  /**
   * Issue #291 (F9, day-one gate_id): stamped on a gate's OWN step by `applyExpireGate`'s abort
   * disposition — the enforce clock expired and no human responded, so the run aborted per the
   * workflow's declared `on_expiry: 'abort'`. Distinct from `gate_cancelled_by_abort` (a
   * DIFFERENT step's handler-abort cancelling this gate) — that would falsely claim "cancelled
   * when '<other step>' aborted the run" for what is actually a timeout. `gate_id` is REQUIRED
   * (not optional, unlike the cancelled variant's grandfathered-record allowance) — this kind
   * was born with the field, so the run_terminal envelope's third discriminated variant binds by
   * id equality from birth, never by presence alone.
   */
  | { kind: 'gate_expired'; gate_id: string };

/** Every {@link SkipDetail} `kind`, in the type's order; compile-checked both ways. */
export const SKIP_KINDS = [
  'when_false',
  'trigger_rule_unsatisfiable',
  'handler_abort',
  'guard_abort',
  'gate_cancelled_by_abort',
  'gate_expired',
] as const satisfies readonly SkipDetail['kind'][];
type MissingSkipKind = Exclude<SkipDetail['kind'], (typeof SKIP_KINDS)[number]>;
const _everySkipKindListed: [MissingSkipKind] extends [never] ? true : MissingSkipKind = true;
void _everySkipKindListed;

/**
 * Every way a run can be sealed, as a closed list read at run time (`SealedBy.arm`). The type
 * {@link SealArm} derives from it (the `STOP_KINDS` pattern: the const array is the runtime
 * enumeration). One value per terminal seal-site function-branch in the 21-path census.
 *
 * APPEND-ONLY (the Tekton lesson, design rev 3 §3): an arm's meaning never changes; changed seal
 * behaviour mints a NEW arm. That rule is what keeps every stored `sealed_by.arm` decodable
 * forever, and what makes a future #378 resolution land as a mapping/arm ADDITION rather than as
 * a rewrite of stored records.
 * @public
 */
export const SEAL_ARMS = [
  'complete',
  'gate_resolution_complete',
  'guard_pass_complete',
  'gate_expiry_default',
  'step_failure',
  'guard_resolution_error',
  'spawn_failure',
  'extensions_load_failure',
  'handler_abort',
  'guard_abort',
  'gate_expiry_abort',
  'abandon_requested',
  'cleanup_sweep',
] as const;

/**
 * Which code path sealed a run, named as a fact about the code, never a verdict on the run
 * (`SealedBy.arm`).
 * Never a judgement about
 * whether the run was good or bad: `arm -> RunPhase` and `arm -> outcome` are engine-owned total
 * functions over this value (`eligibility.ts`) — changing either changes a JUDGEMENT; it never
 * moves a stored record.
 * @public
 */
export type SealArm = (typeof SEAL_ARMS)[number];

/**
 * Who sealed a run: the recorded fact `deriveRunPhase` reads before every marker and the terminal
 * reason's text (`RunRecord.sealed_by`).
 * @public
 */
export interface SealedBy {
  arm: SealArm;
  /**
   * The step whose settlement closed the run. ABSENT (never an `''` sentinel — a fabricated value
   * violates the false-attestation doctrine) for the run-scoped arms (`abandon_requested`,
   * `cleanup_sweep`, `spawn_failure`, `extensions_load_failure`) and for any stamp whose step is
   * unknowable.
   */
  step?: string;
  /**
   * Provenance: set by the MIGRATE VEHICLE only (`realm run migrate --stamp-seals`), NEVER by a
   * seal-site writer — a classifier-minted stamp must stay distinguishable from a writer-asserted
   * one forever. Absent on every fresh seal; present on every record the vehicle stamped.
   */
  classified?: true;
  /**
   * Issue #367: the record of a HUMAN RULING on this run's arm — and the only lawful way an arm
   * changes while the run is terminal. Every other rewrite is refused (`STATE_SEAL_REWRITTEN`),
   * because re-attributing what sealed a run is the silent re-attribution this design exists to
   * end.
   *
   * This provenance IS the key that opens that refusal, so it is held to the same standard as the
   * fact it explains: `previous_arm` must truthfully name the arm being overwritten, and a write
   * whose `previous_arm` lies is refused exactly as hard as one carrying no provenance at all.
   *
   * A truthful SAME-arm adjudication is lawful and meaningful — it is the "I looked at this and
   * ruled it stays as it is" acknowledgment, which is how a parked record that turns out to be
   * correctly stamped gets closed out rather than re-examined forever.
   *
   * **A ruling SUPERSEDES the record's own prose.** The coherence audit exists to catch SILENT
   * drift; a ruling is none of those things — it is loud, attributed, and erase-proof while
   * terminal — so a seal carrying one is exempt from that audit permanently, not just on the write
   * that records it. The prose is NEVER rewritten to match: it is historical evidence of what the
   * engine said at the time, and the ruling resolves the disagreement without falsifying it.
   *
   * ONE SLOT, and the loss is deliberate: a second ruling overwrites the first. The chain stays
   * one-step-walkable because `previous_arm` is enforced truthful, and a full ruling history is
   * machinery with no customer today. Like the arm itself, this field is erase-proof WHILE
   * TERMINAL — and that scope is the whole claim: resuming a run lawfully voids the seal, and the
   * ruling goes with it, because the sealed state it ruled on no longer exists. Resume discloses
   * that rather than doing it silently.
   *
   * Nothing in the engine writes it. The operator verb that will is boarded on #367; this contract
   * ships with the major so that law never has to be loosened afterwards.
   */
  adjudicated?: {
    /** Who ruled — the operator identity as given. Never fabricated, never defaulted. */
    by: string;
    /** ISO-8601 timestamp of the ruling. */
    at: string;
    /**
     * The arm this ruling overwrote, enforced truthful at the store boundary.
     *
     * `null` is the truthful statement "no arm existed before this ruling" — an operator's FIRST
     * stamp of a parked record the classifier refused to place. It is not a wildcard: `null` on a
     * record that HAD an arm is a lie, and the boundary refuses it exactly like any other lie. It
     * is lawful only on a record that was ALREADY terminal; a live run's first seal can never have
     * been adjudicated.
     */
    previous_arm: SealArm | null;
    /** The operator's stated reason, verbatim. */
    reason?: string;
  };
}

/**
 * The text of the model requests one drive failure covers, on its entry
 * (`DriveFailureRecord.model_text`). It is the evidence entry's {@link ModelText}, with
 * `dropped_messages`: the number of messages left out to keep the entry within its budget. A
 * request that got no answer has `request_id: null` and `reply: null`; an answered request's
 * `request_id` is the id of its record in the entry's `usage`.
 * @public
 */
export type DriveFailureModelText =
  | (Extract<ModelText, { recorded: true }> & { dropped_messages?: number })
  | Extract<ModelText, { recorded: false }>;

/**
 * One failed attempt to drive a step: when, which step and provider, what kind of failure, and its
 * message (`DriveFailuresField.entries`).
 * A "drive attempt" is realm trying to advance a step —
 * not only a provider call: an auto step whose validation rejects the submission wedges the run
 * identically and is recorded here too.
 *
 * Before this record existed, every one of these failures wrote NOTHING to the store. The console
 * said what happened, the process exited, and the run read healthy on every operator surface until
 * `never_claimed_idle` noticed it 24 hours later.
 * @public
 */
export interface DriveFailureRecord {
  /** ISO-8601 timestamp of the failure. */
  at: string;
  /**
   * The step being driven. `''` is EXPECTED for a throw that happens before a step is selected
   * (an MCP-init failure, for instance) — surfaces must render that case without a stray
   * separator rather than treating it as a missing value.
   */
  step: string;
  /**
   * THE PROVIDER DRIVING THE RUN — context, not cause. On an auto-step entry it names the drive's
   * provider, which had nothing to do with the failure; it is here so an operator reading several
   * entries knows what was driving, not to attribute blame.
   */
  provider: string;
  error_class:
    | 'connection_timeout'
    | 'connection_error'
    | 'api_status'
    | 'sdk_missing'
    | 'validation_rejected'
    /**
     * The per-create ceiling fired: realm stopped waiting on a model request that was still
     * outstanding (issue #401). Distinct from `connection_timeout`, which is the SDK's own
     * per-attempt timeout — this one is realm's bound on the whole create, retries included.
     */
    | 'aborted_by_budget'
    | 'other';
  /** Sanitized (secrets redacted) and capped at 500 characters. */
  message: string;
  /**
   * #715 (b) (02 §D.2, D6-15, D6-47): the run's evidence count when this entry was appended — read in
   * the write that appends it. `drive_failing` fires while it still equals the run's count (nothing
   * was recorded since), never by comparing stamps. Absent on an entry written before #715 (b): that
   * entry is judged by the stamp order, its basis `legacy_stamp_order`.
   */
  evidence_count?: number;
  /** #715 (b) (02 §D.2): the open question's `gate_id` when this entry was appended (absent: none). */
  gate_id?: string;
  /** Populated when the throwing error carries a driveCall payload. */
  attempts_sdk?: number;
  /**
   * Wall time for this attempt: the payload's span when one is present, else time since the
   * attempt began.
   *
   * WALL TIME, which is why it can EXCEED the ceiling beside it. A timer fires when the event
   * loop gets to it, so under load it fires late — and the payload reports what actually
   * elapsed while `derived_ceiling_ms` reports what was configured. An `aborted_by_budget` entry
   * reading `after 67785ms` against `ceiling 64500ms` is both numbers telling the truth about
   * different things, not a broken bound.
   */
  elapsed_ms: number;
  /** Populated when the throwing error carries a driveCall payload. */
  declared_per_attempt_ms?: number;
  /** Populated when the throwing error carries a driveCall payload. */
  derived_ceiling_ms?: number;
  /** The HTTP status last seen for this attempt, when the error carried one. */
  last_observed_status?: number;
  /**
   * A `Retry-After` value OBSERVED on the wire — never honored. Recording what the service asked
   * for is a diagnostic; acting on it would be a scheduling decision this layer does not make.
   * Populated when the throwing error carries a driveCall payload.
   */
  retry_after_observed_ms?: number;
  /**
   * Issue #600 PR 1a (D9) — what the provider said each billed wire request cost, before the drive
   * ended. Populated from the throwing error's driveCall payload and from the driver's earlier
   * schema-repair calls for the same step (in wire order); a `validation_rejected` entry — a wedge
   * after the repair budget ran out, not a throw — carries every call of the exhausted budget. An
   * operator must be able to see, on the screen, that money was spent on a failed drive — a number
   * on the record that renders nowhere does not discharge that (get_run_state shows each drive
   * failure without its `model_text`, and at most three of its `usage` records, with `usage_more`
   * counting the rest; the CLI render is this same field, per D9).
   *
   * ABSENT until a request returns: a failure before any request left the process (`sdk_missing`)
   * and a first request that failed on the wire (a 5xx, a timeout, a dropped connection) both
   * leave it absent, so absence never proves no request was made. A failed tool-calling drive
   * carries its billed usage like any other (issue #610); a record Realm 0.48.0 or earlier wrote
   * carries none for one. `[]` — which realm's own providers never attach; a
   * third-party provider module can — says only that the payload carried a `usage` key with no
   * requests.
   */
  usage?: UsageRecord[];
  /**
   * Gap 1, unit A2: the text of the model requests this failure covers
   * ({@link DriveFailureModelText}), or a marker saying why there is none. `realm agent` and
   * `realm listen` write it on every drive-failure entry they write. `get_run_state` never shows
   * it, and a listing of runs leaves it out.
   */
  model_text?: DriveFailureModelText;
}

/** Every {@link DriveFailureRecord} `error_class`, in the type's order; checked both ways. */
export const ERROR_CLASSES = [
  'connection_timeout',
  'connection_error',
  'api_status',
  'sdk_missing',
  'validation_rejected',
  'aborted_by_budget',
  'other',
] as const satisfies readonly DriveFailureRecord['error_class'][];
type MissingErrorClass = Exclude<DriveFailureRecord['error_class'], (typeof ERROR_CLASSES)[number]>;
const _everyErrorClassListed: [MissingErrorClass] extends [never] ? true : MissingErrorClass = true;
void _everyErrorClassListed;

/**
 * A run's recent drive failures: the last few, plus the total and the time of the first, which do
 * not reset when the oldest is dropped (`RunRecord.drive_failures`).
 *
 * `entries` holds at most 5, MOST-RECENT-LAST. `total` and `first_failed_at` live OUTSIDE the ring
 * deliberately — a run that failed forty times must not read as though it failed five, and the
 * moment trouble started is the one fact a ring cannot preserve.
 * @public
 */
export interface DriveFailuresField {
  first_failed_at: string;
  total: number;
  entries: DriveFailureRecord[];
}

/**
 * A run as its store keeps it: its workflow and version, its phase, its params, its evidence
 * entries, the question it waits on and how it ended; a store's `get` returns it inside a
 * `Snapshot`.
 * @public
 */
export interface RunRecord {
  id: string;
  workflow_id: string;
  workflow_version: number;
  /**
   * Run ID of the parent run that spawned this run via start_run_batch.
   * Absent for top-level runs.
   */
  parent_run_id?: string;
  /**
   * Caller-supplied deduplication key. When provided at creation time,
   * the store returns the existing run if one with the same (workflow_id, idempotency_key)
   * already exists instead of creating a new one.
   */
  idempotency_key?: string;
  /**
   * Run ID of the terminal run this run SUPERSEDED under the same idempotency key
   * (`on_terminal_match: 'rerun' | 'rerun_if_failed'`). Stamped by the store's supersede path at
   * creation — the one place both ids are in hand — never caller-settable (`CreateRunOptions` does
   * not carry it; a caller forging lineage is the hazard), never rewritten. Absent for a first run
   * and for a `reuse`. The reverse (which run replaced me) is a query, not a field.
   */
  rerun_of?: string;

  // DAG execution state — replaces the single `state: string` field.
  completed_steps: string[];
  in_progress_steps: string[];
  failed_steps: string[];
  /** Steps whose trigger_rule can no longer be satisfied; recorded for auditability. */
  skipped_steps: string[];

  /**
   * Reason detail for each skipped step (issue #111), keyed by step name. Additive-optional
   * (the `claims`/`capability_blocks` precedent): absent on legacy records. `skipped_steps`
   * stays authoritative — `Object.keys(skip_details) ⊆ skipped_steps` always, but a skipped step
   * MAY lack a detail entry (surfacing renders "reason unavailable" for those). Never gate DAG
   * logic on this field.
   */
  skip_details?: Record<string, SkipDetail>;

  /**
   * Per-claim liveness clock (issue #101), keyed by step name. Written ATOMICALLY in
   * `claimStep` (the same write that adds the step to `in_progress_steps`) and deleted when the
   * step settles. Advisory metadata for wedge DETECTION and reclaim ONLY — `in_progress_steps`
   * stays authoritative for eligibility. Additive-optional (the `extension_identity` precedent):
   * legacy records lack it, so their in-progress claims classify as `claim_unknown_age`. A store
   * that drops this field must declare `persistsClaims: false` so liveness recovery loud-fails
   * rather than silently no-opping.
   */
  claims?: Record<string, ClaimRecord>;

  /**
   * Recoverable-incapability markers (issue #134), keyed by step name. Written when an auto step's
   * handler/adapter is not registered in the executing runner's registry — see {@link CapabilityBlock}.
   * Advisory DETECTION metadata only; the four step sets stay authoritative for eligibility.
   * Additive-optional (the `claims` precedent): absent on legacy records and capability-clean runs.
   */
  capability_blocks?: Record<string, CapabilityBlock>;

  /**
   * Derived convenience field — set by the engine on every write, read by CLI and get_run_state.
   * NEVER an input to control flow: re-derive with `deriveRunPhase` rather than reading this
   * (issue #279's PHASE_IS_GENERATED law; a persisted value can be stale).
   * Issue #367: the derivation's FIRST input is now `sealed_by.arm`; the four step sets,
   * `terminal_state`, `pending_gate` and the markers serve the legacy population beneath it.
   */
  run_phase: RunPhase;

  version: number;
  params: Record<string, unknown>;
  evidence: EvidenceSnapshot[];
  /**
   * Snapshots of workflow context files loaded at run start.
   * Keyed by entry name. Separate from step evidence — not in evidence[].
   */
  workflow_context_snapshots?: Record<string, WorkflowContextSnapshot>;
  /**
   * Append-on-change history of the project-extension code identity that executed this run
   * (issue #119). Each entry is captured at module-LOAD time by the CLI and appended lazily
   * by the execution loop when it differs from the last recorded entry. Advisory evidence —
   * WARN-never-gate. Absent for extension-free runs. JSON-file-store-only until external
   * stores round-trip unknown optional RunRecord fields through update().
   */
  extension_identity?: ExtensionIdentityEntry[];
  /**
   * PID of the agent process spawned by 'realm listen' for this run.
   * Set after a successful spawn. Absent for runs not started by a webhook trigger.
   * May be stale if the agent has exited — use for diagnostic purposes only.
   */
  agent_pid?: number;
  /**
   * ISO-8601 timestamp when the agent process was spawned.
   * Set by 'realm listen' after a successful spawn.
   */
  agent_started_at?: string;
  /**
   * Failed drive attempts for this run (issue #401). Additive-optional and never stripped —
   * `applyResume` preserves it through its `...rest` spread, which is a CHOSEN behaviour: the
   * history of what went wrong survives a resume.
   */
  drive_failures?: DriveFailuresField;
  created_at: string;
  updated_at: string;
  terminal_state: boolean;
  /**
   * The run's one-line cause, as a HUMAN SENTENCE — rendered from what the sealing writer knew,
   * for an operator to read. Issue #367: on records carrying {@link RunRecord.sealed_by} it is no
   * longer a machine oracle; `deriveRunPhase` reads the arm. It stays the oracle for the legacy
   * population only, via `classifyLegacySeal`, and every new consumer should key on the arm.
   * Multi-failure runs list every failed step (issue #373).
   */
  terminal_reason?: string;
  /**
   * Issue #367: which arm of the engine sealed this run — the recorded fact `deriveRunPhase`
   * derives from FIRST, ahead of the markers and the terminal-reason prose (which are asserted
   * congruent, not consulted, once a stamp exists). FLAT OPTIONAL: written in the SAME object
   * literal as the `terminal_state: true` flip by every seal site; stripped in the same write by
   * every resume/re-drive path; enforced at the store boundary (`assertSealIntegrity` — see the
   * `STATE_SEAL_*` codes), never by the type system (a deleted writer stamp is 0 type errors —
   * the dead-end class two earlier revisions died on). Absent on every record written before
   * #367 — `classifyLegacySeal` is the permanent read oracle for those, so correctness never
   * depends on a migration having run.
   *
   * The vocabulary is APPEND-ONLY (see {@link SEAL_ARMS}).
   *
   * NOT the finalizer-selection variable: `deriveEffectiveTriggers` remains `mintOutcome`-driven
   * and the two may diverge by design.
   */
  sealed_by?: SealedBy;
  pending_gate?: PendingGate;
  /**
   * Set by the engine when a guard step fires. Contains the name of the guard step that caused
   * the abort and its evaluated conditions, and is surfaced by get_run_state. Issue #367: it is
   * ASSERTED CONGRUENT with `sealed_by` by the transforms (`SEAL_MARKERS_AGREE`) rather than read
   * by `deriveRunPhase` — on a stamped record the arm derives the phase; on the legacy population
   * this marker is still a derivation input via `classifyLegacySeal` and the ladder beneath it.
   */
  aborted_at?: {
    step_id: string;
    conditions?: Array<{ condition: string; resolved_value: unknown; passed: boolean }>;
    abort_message?: string;
  };
  /**
   * ISO timestamp set when a run is explicitly abandoned via `abandon_run` / `realm run abandon` /
   * `realm run cleanup`. Issue #367: ASSERTED CONGRUENT with `sealed_by` by the transforms
   * (`SEAL_MARKERS_AGREE`), not read by `deriveRunPhase` on a stamped record — the arm derives
   * there. On the legacy population its presence still makes `abandoned` the derived phase
   * regardless of `failed_steps` / `terminal_reason` (mirrors `aborted_at`).
   */
  abandoned_at?: string;
  /**
   * Issue #220 (bounded validation exhaustion): per-step count of COUNTED validation rejections
   * — the closed set `{VALIDATION_INPUT_SCHEMA, VALIDATION_OUTPUT_SCHEMA}` on `execution: 'agent'`
   * steps only (`VALIDATION_TRACE_SCHEMA` and any non-agent rejection are never counted here; see
   * `countRejection` in execution-loop.ts for the full mechanism). Keyed by step name, POOLED
   * across concurrent writers/nonces (deliberate — the wedge-cure goal is run-level, not
   * per-writer fairness). NEVER reset: a settled step's count is a permanent, structurally-costless
   * fact about this run (settled steps simply leave the eligible set — see the #221 derivation
   * note, TD-R12, for the reader-side "meaningful only against unsettled state" caveat).
   * Additive-optional (the `claims`/`capability_blocks` precedent): absent on legacy records and
   * on any run with zero counted rejections so far.
   */
  validation_rejections?: Record<string, number>;
  /**
   * Issue #220 PR-2 (run-level disclosure, pin r): names of steps that settled via their declared
   * `validation_exhaustion.default_output` substitution rather than the agent's own submission —
   * a run-level convenience aggregate over the per-step `EvidenceSnapshot.diagnostics
   * .settled_by_default` truth. Present only when non-empty; stamped ONLY on the terminal
   * `'complete'`-sealed record by `stampDefaultedSteps` (see execution-loop.ts) — a run that later
   * FAILS after a mid-workflow default-settle does NOT carry this field (the per-step evidence
   * snapshot remains the durable per-step truth regardless; this is a named residual, not a false
   * statement — see the design record). Additive-optional (the `validation_rejections` precedent).
   */
  defaulted_steps?: string[];
  /**
   * Issue #279 (increment 1, PR-A): per-step settlement record, keyed by step name — the durable
   * outcome of an `applySettlement` `settle_step` APPLY (`settlement.ts`; design record
   * `plans/issue-279/design-d4-increment1.md` §2/§3). `token` is the `claimToken` the settling
   * caller presented (`norm`-ed — `null` when the caller had none), used for the
   * `already_settled`/`already_settled_by_other` idempotence discrimination on a retry. `outcome`
   * uses `'skip'` (not `'abort'`) for an aborted step — it mirrors where the step PHYSICALLY
   * lands (`skipped_steps`), per the design record's `toSettledOutcome` mapping
   * (`complete↦'complete'`, `fail↦'fail'`, `abort↦'skip'`).
   *
   * ORPHAN RULE (design record §2 `entryOf`): an entry whose step is NOT (also) present in the
   * matching membership array (`completed_steps`/`failed_steps`/`skipped_steps` per its own
   * `outcome`) is treated as ABSENT by the predicate — the next settle APPLY simply overwrites it
   * (mirrors `claimStep`'s own pre-#279 overwrite-not-add-if-absent self-heal at the claims map).
   * This can never happen through `settleStep` itself (APPLY always writes both the entry and the
   * membership in the SAME atomic write) — it exists so a hand-authored fixture / an external
   * store's own divergent history cannot wedge the predicate.
   *
   * Issue #279 (increment 2, PR-C): `outcome` gains `'gate'` — a resolved human-gate entry
   * (`settleGateArms`'s APPLY writes `outcome: 'gate'` LITERALLY; `toSettledOutcome`'s own
   * `SettleStepOutcome` domain stays untouched — a `settle_step` delta can never produce a
   * `'gate'` entry, only `settle_gate` can). `choice` is set IFF `outcome === 'gate'` — the
   * human's resolved choice, mirrored from `SettleGateDelta.choice`.
   *
   * Shipped in v0.32.0 (PR-B migrated the three seal sites to `settleStep`) — the "dormant until
   * PR-B" framing below is stale for the `'complete'|'fail'|'skip'` outcomes; `'gate'` itself
   * stays dormant until PR-D migrates the gate-resolution site.
   */
  settled?: Record<
    string,
    {
      token: string | null;
      outcome: 'complete' | 'fail' | 'skip' | 'gate';
      choice?: string;
      /**
       * Issue #291 (D1 §5, carried; the module-local `SettledEntry` alias in settlement.ts
       * projects THIS field): present, and only ever `'timeout'`, on a `'gate'` entry written by
       * `applyExpireGate`'s settle_default disposition — attributes the resolution to the enforce
       * clock rather than a human. Absent = a human resolved it (backward-clean: every pre-#291
       * `'gate'` entry lacks this field). Never set by any other arm.
       */
      resolved_by?: 'timeout';
    }
  >;
  /**
   * Issue #279 (increment 1, PR-A): the record-as-outbox finalizer ledger, keyed by finalizer step
   * name — minted by `mintFresh` (settlement.ts) on the terminal false→true edge, drained via
   * `lease_finalizer`/`mark_finalizer` deltas (design record §3/§4/§6). `rank` totally orders the
   * PENDING subset only (the drain loop processes lowest-rank-first; collisions with
   * terminal-status entries are legal and inert). `lease_deadline`/`lease_token` are present only
   * while `status === 'pending'` AND a drainer currently holds the lease — a CLEAN mint (§4) never
   * seeds them, and `applyResume` (PR-B) strips them when voiding a pending entry. `status`:
   * `'pending'` (mint-not-yet-delivered) → `'completed'` | `'failed'` (delivered, terminal,
   * never rewritten — the never-downgrade guard) or `'voided'` (superseded by a resume, §5;
   * permanent unless a later terminal edge re-mints the SAME finalizer if still selected).
   *
   * Dormant in this PR — join `LoadBearingRunRecordField`/`SAMPLE_VALUES`; nothing writes this
   * field until PR-B migrates the seal sites to `settleStep`.
   */
  finalizer_ledger?: Record<
    string,
    {
      status: 'pending' | 'completed' | 'failed' | 'voided';
      rank: number;
      lease_deadline?: string;
      lease_token?: string;
    }
  >;
}

/**
 * A run as a listing of runs gives it: the record, with each evidence entry's `model_text` left
 * out and the evidence read-only. So `update` refuses it, and a listing's record is never written
 * back over the texts it left out. Every record fits into it.
 * @public
 */
export type ListedRecord = Omit<RunRecord, 'evidence'> & {
  readonly evidence: readonly Omit<EvidenceSnapshot, 'model_text'>[];
};

// ─── #627 W (§5.8): how a gate answer arrived ───────────────────────────────────────────────────

/** #627 W: the routes this version's own doors declare (a door may declare another id). #819: the
 *  Slack thread `realm agent` posts a gate to is one. */
export const ANSWER_ROUTES = ['mcp_form', 'mcp', 'cli', 'slack'] as const;
export type AnswerRoute = (typeof ANSWER_ROUTES)[number];

/**
 * A recorded answer's route as its door declared it, and what showed a form
 * (`EvidenceSnapshot.answer`).
 * @public
 */
export interface AnswerFacts {
  route: string;
  /** Present only on an answer from a form: the renderer that showed the question. */
  shown?: { renderer: string };
  /** #603 A3a: present only when the door passed it — the account that sent the answer, as the
   *  channel reports it (Slack's statement, never verified by Realm). */
  channel_evidence?: ChannelEvidence;
}

/**
 * The account a channel's door says sent an answer, as the channel reports it
 * (`AnswerFacts.channel_evidence`).
 * @public
 */
export interface ChannelEvidence {
  /** The workspace the account belongs to; absent when the channel did not say. */
  team?: string;
  user: string;
  ts?: string;
  thread_ts?: string;
}

/**
 * How an answer's sender was let through, or why it was not compared
 * (`EvidenceSnapshot.admitted_by`).
 * @public
 */
export type AdmittedBy =
  'owner' | 'answerers' | 'project_answerers' | 'no_named_answerer' | 'owner_not_checked_on_route';

/**
 * What an answer's entry holds about its route: the facts, or the absence a library caller leaves
 * (`EvidenceSnapshot.answer`).
 * @public
 */
export type AnswerOnRecord = AnswerFacts | { absent: 'route_not_declared' };

/** #627 W: why an answer's entry names no route — one vocabulary for the record and `outcome.via`. */
export const ANSWER_ROUTE_ABSENCES = [
  'settled_by_expiry',
  'recorded_without_route',
  'route_not_declared',
] as const;
export type AnswerRouteAbsence = (typeof ANSWER_ROUTE_ABSENCES)[number];

/**
 * Why a door names no principal (`Principal`'s `absent`).
 * @public
 */
export const PRINCIPAL_ABSENCES = [
  'door_authentication_disabled',
  'principal_not_passed',
  'door_authenticates_no_principal',
  'not_a_server_door',
] as const;
/**
 * One of the words in `PRINCIPAL_ABSENCES`: why a door names no principal for an answer
 * (`Principal`'s `absent`).
 * @public
 */
export type PrincipalAbsence = (typeof PRINCIPAL_ABSENCES)[number];

/**
 * What a door's transport authenticated: an API key by its id, the one shared token of `realm
 * serve`, or the door's typed absence (`EvidenceSnapshot.principal`). The shared token has no id:
 * it names no one.
 * Never a secret.
 * @public
 */
export type Principal =
  { kind: 'api_key'; id: string } | { kind: 'shared_token' } | { absent: PrincipalAbsence };
