# Changelog

All notable changes to this project are documented here.

---

## [Unreleased]

### Added

- `output_schema` field on `StepDefinition` — an optional JSON Schema that
  validates the params an agent submits to `execute_step` before the engine
  claims the step. Symmetric to `input_schema`. Only valid on
  `execution: 'agent'` steps; declaring it on `execution: 'auto'` steps is a
  loader error (`VALIDATION_WORKFLOW_SCHEMA`). Failed validation returns
  `agent_action: 'provide_input'` and leaves the step unclaimed — fully
  re-submittable. Implemented via new `validateOutputSchema` in
  `validation/input-schema.ts` and new error code `VALIDATION_OUTPUT_SCHEMA`.
- `gate.message` template field on gate config — a developer-authored human-facing message resolved at gate-open from step output (and self-reference via `{{ context.resources.MY_GATE_STEP.field }}`). Fail-fast: if any `{{ }}` placeholder cannot be resolved, the engine returns `agent_action: stop` with error code `GATE_MESSAGE_UNRESOLVABLE` and the gate does not open. Resolved message stored as `PendingGate.resolved_message` in the run record and as a dedicated `gate_message` field on `kind: gate_response` evidence snapshots — creating a permanent verbatim record of exactly what the human read at decision time.
- `gate.display` fallback chain (MCP): `gate.message` resolved → `step.prompt` resolved → absent. Present whichever is non-null to the user verbatim.
- `realm run inspect` now renders a `Message:` line under `Choice:` in gate_response evidence entries when `gate_message` is set.
- New error codes: `GATE_MESSAGE_UNRESOLVABLE` (post-resolution `{{ }}` detected in gate.message), `ENGINE_GATE_OPEN_FAILED` (gate-open precondition failed).
- Step templates: `templates:` top-level block and `use_template:` step field. Define
  reusable named step groups with `{{ param }}` placeholders; instantiate them with
  `prefix:` and `params:` at the call site. Resolved at load time — zero runtime overhead.
- `create_workflow` MCP tool — Mode 2 self-directed execution. An agent calls `create_workflow` with a `steps` array and optional `metadata` to register a dynamic workflow and immediately start a run in a single call. Returns a `ResponseEnvelope` with `data.workflow_id` and a populated `next_action` pointing at the first step. The agent then drives the run to completion with `execute_step` exactly as it would for a YAML-registered workflow.
- Dynamic workflow ID derivation — when `metadata.name` is provided, the ID is `<slug>-<6-char-hex-fragment>` (e.g. `jsDoc-audit-a1b2c3`); when omitted, `dynamic-<8-char-hex>`. IDs are deterministic from a UUID fragment and collision-safe in practice.
- Validation on `create_workflow` input: step IDs must be unique, non-empty, and contain no spaces; step descriptions must be non-empty; `timeout_seconds` must be a positive integer if set; `depends_on` entries must reference step IDs that appear earlier in the array; `depends_on` supports at most one predecessor (linear engine). All validation errors are returned in a single `agent_action: 'provide_input'` response.
- Hard error when `agent_profile` is set on any step of a dynamic workflow — the feature requires a registered YAML workflow with a `profiles_dir`. The error message names the step and instructs the agent to use `realm register` with a YAML file instead.
- `list_workflows` hint updated — the response now includes a note directing agents to call `create_workflow` when no registered workflow matches their task.
- `agent_profile` field on `StepDefinition` — associates a named agent persona with an
  `execution: agent` step. The profile content is loaded at register time from a Markdown file
  under the workflow's `profiles_dir` (defaults to `<workflow-dir>/profiles/`). Using `agent_profile`
  on an `execution: auto` step is a hard validation error.
- `profiles_dir` field on `WorkflowDefinition` — optional path (relative to the workflow YAML
  file) pointing to the directory that contains `.md` profile files. Defaults to `profiles/` adjacent
  to the workflow YAML when omitted.
- `resolved_profiles` on `WorkflowDefinition` (runtime-only) — populated by `loadWorkflowFromFile`
  after register-time resolution. Each entry holds `{ content, content_hash }` where `content_hash`
  is the SHA-256 hex digest of the profile file at load time.
- `agent_profile_instructions` field on `ProtocolStep` in the MCP protocol — when a step has a
  resolved profile, the full profile content is included in the workflow protocol so the consuming
  agent loads the persona before executing the step.
- `agent_profile` and `agent_profile_hash` fields on `EvidenceSnapshot` — when a step ran with a
  profile, the snapshot records both the profile name and the SHA-256 content hash for auditability.
- `realm inspect` profile display — when a step's evidence snapshot includes `agent_profile`, the
  step name is followed by a cyan `[profile: <name>]` annotation.
- `code-review` example agent profiles — `profiles/security-reviewer.md` and
  `profiles/quality-reviewer.md` added; `review_security` and `assess_quality` steps reference them
  via `agent_profile`.
- Hard validation error on missing profiles — `realm validate` and `realm register` fail immediately
  with the searched path in the error message when a referenced profile file cannot be found.
- `chained_auto_steps: Array<{ step: string; produced_state: string }>` on `ResponseEnvelope` — when
  `start_run` or `execute_step` chains through one or more `execution: auto` steps, the response
  includes an ordered record of every auto step that ran silently. Omitted when no auto steps were
  chained. Gives consuming agents visibility into engine-driven state advances without agent involvement.
- `hint` field on `list_workflows` response — instructs agents to call `get_workflow_protocol` with a
  `workflow_id` before calling `start_run`.
- Protocol generator: `agent_involvement` for `execution: agent` steps now includes a forward-looking
  note when the step's produced state leads immediately into an `execution: auto` + gate step. The note
  names the downstream step and tells the agent to expect `status: confirm_required` directly in
  response to their `execute_step` call — not `status: ok`. Guards ensure the note is omitted for
  terminal-producing steps and for plain auto steps with no gate trust.
- `call_with` field on `NextAction.instruction` — a ready-to-use flat argument object for calling the
  tool. For agent steps, `call_with.params` is a minimal schema skeleton object derived from
  `input_schema` (e.g. `{ findings: [{ severity: "<critical|high|medium|low>", description: "" }] }`)
  rather than a bare `<YOUR_PARAMS>` string — the agent can navigate and fill it in directly. For human
  gate responses, the placeholder remains a string (e.g. `<approve|reject>`).
- Optional `get_workflow_protocol` call documented as step 0 in the code-review skill — agents that
  prefer upfront schema discovery can call it before `start_run`.
- Optional `location` field added to `assess_quality.findings` items in the code-review example
  workflow (symmetric with the existing `location` field in `review_security`).
- `STEP_ABORTED` error code added to the `ErrorCode` union (after `STEP_TIMEOUT`). Adapters throw
  `STEP_ABORTED` when they observe a cancelled signal; the engine throws `STEP_TIMEOUT` when the
  timeout fires. This separation lets callers distinguish "the transport was cancelled" from "the
  step ran too long".
- `signal?: AbortSignal` as 4th parameter on `StepDispatcher` — the execution engine now passes the
  timeout controller's signal to every dispatcher call. Handler code and inline test lambdas that
  care about cancellation can check `signal?.aborted` at yield points.
- `signal?: AbortSignal` as 4th parameter on `ServiceAdapter.fetch`, `ServiceAdapter.create`, and
  `ServiceAdapter.update` — the signal is forwarded through the adapter chain to the underlying
  transport. JSDoc on the interface documents that implementations are responsible for checking the
  signal at yield points.
- `signal?: AbortSignal` as optional 3rd parameter on `StepHandler.execute()` — allows handler
  implementations to propagate the cancellation signal to nested async operations.
- `withTimeout` refactored — creates an `AbortController` before dispatching, aborts it when the
  timeout fires, and passes `controller.signal` to the dispatcher callback. Previously used
  `Promise.race` without signalling the losing branch; the abandoned branch could hold open
  connection slots and produce duplicate side effects on retried steps.
- `GenericHttpAdapter` now forwards `signal` to `fetch()` and converts native `AbortError` to a
  structured `STEP_ABORTED` `WorkflowError` before the generic error catch, preventing
  mis-classification as `NETWORK_UNREACHABLE`.
- `MockAdapter` abort check — all three methods inspect `signal?.aborted` at entry and throw
  `STEP_ABORTED` immediately if the signal is already aborted, enabling deterministic abort
  testing without real HTTP calls.
- `context_hint` promoted to a required top-level field on `ResponseEnvelope` — every response now
  carries orientation about the current run state and what just happened, including error and blocked
  responses where `next_action` is `null`. Previously only appeared inside `next_action`.
- JSDoc on `ResponseEnvelope.snapshot_id` (audit-only — do not parse) and `ResponseEnvelope.evidence`
  (debugging and CLI inspection only) to reduce agent confusion about opaque fields.
- `GateInfo.display` — the human-facing summary text for a gate (renamed from `GateInfo.prompt`).
- `GateInfo.agent_hint` — optional agent-facing instruction text derived from the gate step's
  `instructions:` field in the workflow YAML. Tells the agent how to present the gate to the user.
- `GateInfo.response_spec` — `{ choices: string[] }` object on every gate response. Replaces the
  removed `params_required` on `NextAction.instruction` as the canonical source for valid choices.
- `orientation` field on `NextAction` — replaces `context_hint` inside `next_action`. Describes
  the current run state and what just happened from the perspective of the next step to take.
  The top-level `ResponseEnvelope.context_hint` field is unchanged.
- `instructions:` field on the `confirm_review` gate step in the code-review example workflow —
  tells the agent how to present the gate display content to the user and how to submit the response.
- `agent_action` field on `ResponseEnvelope` — every `error` and `blocked` response now includes
  `agent_action: AgentAction` (`stop`, `report_to_user`, `provide_input`, `resolve_precondition`,
  `wait_for_human`) so consuming agents can determine recovery strategy without parsing error text.
- `next_action` populated on recoverable error responses — when `agentAction !== 'stop'` and the
  run state is known, the error envelope includes a populated `next_action` pointing the agent to
  the correct next step. Agents no longer need to call `get_workflow_protocol` to recover.
- `next_action` populated on state-guard blocked responses — when the agent calls a step from the
  wrong state, the blocked response now includes `next_action` redirecting to the correct step.
  `blocked_reason.suggestion` indicates either the redirect or that no valid next step exists from
  the current state.
- `transitions` field on `StepDefinition` — declares conditional routing paths from a step.
  Two transition types are supported:
  - `on_error` — for `execution: auto` steps only: when the step's handler throws, the engine
    demotes the error to a `warnings` entry, transitions the run to `transition.produces_state`,
    and continues the chain from `transition.step`. A `status: ok` envelope is returned so the
    agent is not required to take a recovery action on its own — the engine already has.
  - Gate-response keys (`on_reject`, `on_approve`, etc.) — on `trust: human_confirmed` steps:
    when the human submits a choice, the engine looks up `on_<choice>` in `transitions` and, if
    present, routes the run to the branch target instead of the step's normal `produces_state`.
- `branched_via` field on `chained_auto_steps` entries — populated with the transition key
  (e.g. `"on_error"`, `"on_reject"`) for branch hops; omitted on normal progression entries.
- `ResponseEnvelope.status` JSDoc — documents that `status: ok` means "forward progress" (the
  chain advanced and there is a next action), not "the original requested step succeeded". An
  `on_error` branch also returns `status: ok` with the original error demoted to `warnings`.
- Protocol generator: `transitions` field added to `ProtocolStep` — when a step declares
  `transitions`, the briefing includes the full routing map so consuming agents can anticipate
  divergent paths before executing.
- YAML validation at register time for all transition constraints:
  - `on_error` is only permitted on `execution: auto` steps.
  - Non-`on_error` keys must appear in the step's `gate.choices`.
  - Transition target step must exist in the workflow.
  - Transition `produces_state` must be in the target step's `allowed_from_states`.
- `examples/document-intake/` — new end-to-end example demonstrating both branching mechanisms:
  a 5-step intake workflow where `validate_fields` routes back to `extract_fields` on `on_error`
  and `confirm_submission` routes back on `on_reject`.
- `FileSystemAdapter` — new built-in adapter in `@sensigo/realm` that reads a local file and returns
  `{ content, path, line_count, size_bytes }`. Add it to an `ExtensionRegistry` and reference it from
  a step with `uses_service: <name>` and `operation: read`. Validates that the path is non-empty and
  absolute; throws structured `WorkflowError` on ENOENT or read failure.
- `code-review` example upgraded to v2: now accepts `path: string` (absolute file path) instead of
  `code: string`. A `read_code` auto step reads the file via `FileSystemAdapter` with
  `trust: engine_delivered`; the file content is injected into the security and quality review prompts
  via `{{ context.resources.read_code.content }}`. The `assess_quality` step prompt no longer
  re-injects the file content — the agent already has the content from the `read_code` step context.
  Security review step now requires `owasp_category`, `location`, and `remediation` per finding.
  Quality review step adds a required `summary` field.

### Fixed

- MCP `start_run`: `command` in the response is now always `'start_run'`, regardless of whether the
  engine chained an initial `execution: auto` step. Previously the field reflected the internal auto
  step name (e.g. `'read_code'`), causing agents to misinterpret which tool they had called.
- Protocol generator: rewrote misleading agent guidance for `execution: auto, trust: human_confirmed`
  steps — `agent_involvement` previously read `"none — engine executes..."`. It now correctly states
  that the agent will receive `status: confirm_required` and must present `gate.display` / collect a
  choice from `gate.response_spec.choices`. `DEFAULT_RULES` updated to reference `gate.display`
  instead of vague "preview" language.
- `command` in `executeChain` responses now echoes the step name submitted by the caller, not the
  internally chained step name. Previously, chain-wrapped responses reported the wrong `command`,
  which caused agents to misinterpret which step had just completed.
- Terminal `context_hint` (emitted when a run reaches a terminal state) now explicitly directs the
  agent to call `get_run_state` with the run ID to retrieve the full evidence record, instead of
  ending without guidance.
- MCP `start_run`: returns a populated `next_action` when the first step is an agent step (previously
  returned `null`, causing the agent to stall on the very first call).
- MCP `execute_step`: evidence payloads in MCP tool responses are now truncated to avoid injecting
  oversized context into the agent's context window.
- MCP `confirm_required` responses now include a populated `next_action` with the correct
  `submit_human_response` instruction (previously `next_action` was `null`).
- `realm inspect`: step input/output fields are now truncated to 120 characters to prevent
  overwhelming terminal output on evidence-heavy runs.
- MCP tool catch handlers (`start_run`, `execute_step`, `submit_human_response`) now return
  structured JSON on unexpected exceptions instead of a bare `Error: <message>` string. All MCP
  responses are now JSON-parseable on every code path.
- `get_run_state`: error path replaced — was `isError: true` with plain-text `"Error: <message>"`;
  now returns a structured JSON envelope with `status: 'error'`, `agent_action: 'stop'`, and
  `context_hint`. No MCP tool now uses `isError: true`.
- `submit_human_response`: success path now strips `data` and `evidence` (same guard already applied
  by `execute_step`) — gate approval responses are no longer larger than regular step responses.
- `start_run`: all three return paths (no-steps, agent-step-first, auto-chain) now return a full
  `ResponseEnvelope` including `command`, `snapshot_id`, `evidence`, and `warnings`. Previously the
  non-auto paths returned a narrower object missing several envelope fields.
- `slimEvidence` extracted from `execute-step.ts` into a shared MCP utility; that utility has
  since been removed — MCP tools now return `evidence: []` unconditionally. Evidence is available
  via `get_run_state` (count) or `realm inspect` (full data); it is never needed in MCP tool
  responses and was inflating context window usage.
- `snapshot_id` removed from all MCP tool response envelopes — the field was annotated
  "audit-only", was confusing agents that tried to parse it, and is not needed by any tool caller.
- Dead code removed from `execution-loop.ts`: the unreachable `throw err` branch in the
  `validateInputSchema` catch block (which could only be reached if `validateInputSchema` threw a
  non-`WorkflowError` — it does not) has been removed.
- Stale `"Acceptable for Phase 1"` comment removed from `execution-loop.ts` alongside the
  `withTimeout` refactor that resolved the underlying issue.
- `SimpleTransition` and `OnSuccessTransition` types exported from `@sensigo/realm` —
  `SimpleTransition` is the shared `{ step, produces_state }` shape used by `on_error` and
  gate-response transitions; `OnSuccessTransition` is `{ field, routes, default }` for output-field
  routing. `StepDefinition.transitions` is now a named-key + index-signature type rather than a plain
  `Record<string, ...>`, which makes all three transition forms individually typed.
- `on_success` routing on `execution: auto` steps — when a step defines
  `transitions.on_success`, the engine reads the named `field` from the handler's output, looks up
  the string value in `routes`, and falls back to `default` when no key matches. The winning
  `produces_state` is written to the store; the run chain continues from the winning `step`.
  `on_success` is restricted to `execution: auto` steps — using it on an `execution: agent` step
  is a hard validation error at register time.
- YAML loader extended for `on_success` — the reachability pre-pass now adds
  `routes[*].produces_state` and `default.produces_state` to reachable states and skips the
  top-level `produces_state` fallback when `on_success` is present. The uniqueness check applies
  the same exclusion. The transitions validator adds a dedicated `on_success` branch that checks:
  non-empty `field`, at least one `routes` key, a `default` present, all target steps exist in the
  workflow, and each route's `produces_state` is in the target step's `allowed_from_states`.
- `branched_via: 'on_success'` on `chained_auto_steps` entries — when a route is taken, the
  chain accumulator records `branched_via: 'on_success'` alongside the step name and the actual
  persisted `produced_state` (the accumulator push was also moved to after `store.get` so it always
  reflects the committed state, not the definition fallback).
- `ProtocolStep.transitions` type in the MCP protocol generator updated to match the named-key
  `StepDefinition.transitions` shape, importing `SimpleTransition` and `OnSuccessTransition` from
  `@sensigo/realm`.

### Fixed

- Gate response look-up in `submitHumanResponse` — after `StepDefinition.transitions` changed
  from a flat `Record<string, { step; produces_state }>` to a discriminated-key union, the
  expression `stepDef.transitions?.[transitionKey]` no longer had `.produces_state` visible to
  TypeScript. Added a `SimpleTransition` cast that is safe because gate-choice keys (`on_approve`,
  `on_reject`, etc.) can never be `on_success`.
- `Processor`, `ProcessorInput`, `ProcessorOutput` exported from `@sensigo/realm` — these
  interfaces existed in `packages/core/src/extensions/processor.ts` but were not re-exported
  from the package root, making them inaccessible to consumers that build on the processor
  extension point. Fixed as part of correcting a build failure in `@sensigo/realm-testing`
  where `testProcessor` required these types.
- `realm webhook`: Slack env vars (`SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_CHANNEL_ID`,
  `SLACK_SIGNING_SECRET`, `SLACK_EVENTS_PORT`, `SLACK_WEBHOOK_URL`,
  `SLACK_GATE_REMINDER_INTERVAL_MS`, `SLACK_GATE_ESCALATION_THRESHOLD_MS`) now propagated to
  `runAgent` in the `--run-id` branch. Previously, the branch used by `realm webhook` to
  attach to an existing run called `runAgent` with only `{ existingRunId, definition, params: {} }`,
  leaving `hasTransport` false and preventing the bidirectional Slack gate from ever connecting.
  One-way `notify_*` adapter notifications were unaffected because `SlackAdapter` registration
  in the adapter registry is independent of the transport options.
- `realm agent`: o3/o3-mini/o4-mini misrouted to `OpenAIReasoningProvider` — the `REASONING_MODELS`
  regex `/^o[1-4](-|$)/i` was too broad, sending o3, o3-mini, and o4-mini through the o1-only path.
  These models support the standard Chat Completions API including tool calling. Narrowed to
  `/^o1(-|$)/i`; o3, o3-mini, and o4-mini now route to `OpenAIProvider` and support tool-enabled steps.
- `realm agent`: missing `max_completion_tokens` on o1-series API calls — `OpenAIReasoningProvider`
  omitted the field, leaving the model to use an uncontrolled API default. Now sends
  `max_completion_tokens: 65536` for o1-mini and `32768` for o1/o1-preview.
- `realm agent`: hardcoded `max_tokens: 4096` in `AnthropicProvider` — all three call sites used a
  fixed ceiling insufficient for Claude 3.5 and Claude 4 family models (which support 8192 output
  tokens). Now resolved dynamically: Claude 3.5/Claude 4 → 8192, others → 4096.
- `realm agent`: `callStepWithTools` suppressed `response_format: json_object` when no input schema
  was present — the field was gated on `jsonMode && inputSchema !== undefined`. Schema presence and
  JSON mode are independent concerns; `response_format` now follows `jsonMode` alone, consistent
  with `callStep`.

### Tests

989 tests across all packages (639 core, 270 CLI, 33 MCP, 47 testing).

---

## [0.1.0] — 2026-04-03

Initial release.

### Packages

- **`@sensigo/realm` 0.1.0** — Core workflow execution engine: state guard, execution loop, evidence capture with SHA-256 hash chaining, JSON schema validation, human gate support, precondition evaluation, extension registry (adapters, processors, step handlers), built-in `MockAdapter` and `GenericHttpAdapter`, JSON file store, YAML workflow loader.
- **`@sensigo/realm-cli` 0.1.0** — `realm` CLI with 11 commands: `init`, `validate`, `register`, `run`, `resume`, `respond`, `inspect`, `replay`, `diff`, `cleanup`, `test`.
- **`@sensigo/realm-mcp` 0.1.0** — `realm-mcp` MCP server exposing 6 tools to AI agents: `list_workflows`, `get_workflow_protocol`, `start_run`, `execute_step`, `submit_human_response`, `get_run_state`.
- **`@sensigo/realm-testing` 0.1.0** — Testing utilities: `InMemoryStore`, `MockServiceRecorder`, `createAgentDispatcher`, `createGateResponder`, evidence assertions (`assertFinalState`, `assertStepSucceeded`, `assertStepFailed`, `assertStepOutput`, `assertEvidenceHash`), unit test helpers (`testStepHandler`, `testProcessor`, `testAdapter`), fixture-based runner (`runFixtureTests`).

### Test coverage

226 tests across all packages (133 core, 42 CLI, 11 MCP, 40 testing).
