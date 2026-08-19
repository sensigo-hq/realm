# Changelog

All notable changes to this project are documented here.

---

## [Unreleased]

### Changed

- **BREAKING (`@sensigo/realm`): a run now RECORDS which arm of the engine sealed it, and every
  judgement about the run derives from that fact** (issue #367, part 1 — the substrate).
  Until now realm's most important fact — did this run succeed — was not in the record. Two runs
  identical in every field except `terminal_reason` derived opposite phases, because the oracle was
  the English sentence `'Workflow completed.'`. That is why a startup death filed itself as
  "abandoned" (issue #372), and why the answer could move when nothing about the run had.
  Every terminal write now carries `sealed_by: { arm }` — one value per seal site, from a closed,
  APPEND-ONLY vocabulary of 13 — and `run_phase` derives from it ahead of the markers and the prose.
  Records written before this keep working forever: a permanent read-path classifier recovers their
  arm, so correctness never depends on a migration having run.
  Three things enforce it, because the type system cannot: the store boundary REFUSES a fresh seal
  with no arm, a resume that keeps one, a terminal rewrite that drops one, an unknown arm, and a
  stamp that contradicts the record's own markers (five new `STATE_SEAL_*` error codes, all
  throwing). The published TCK gains laws for all four refusals plus a round-trip law, so a store
  that silently drops the field fails conformance before it ships. And `get_run_state` and
  `realm run inspect` now show the arm — `inspect` also shows the run's one-line cause for the
  first time.
  Export bundles are now `realm_export_version: 4`; in a v3 bundle the absence of `sealed_by` was
  three-way ambiguous.
  **Read before running `realm run gc --heal` after upgrading**: heal rewrites records whose
  derived phase moved, and each rewrite resets `updated_at` — the clock retention reads. The
  stamp-seals migration ships in the next PR; until then, skip `--heal` if those clocks matter.

### Fixed

- A run that ends with several failures now says so, instead of blaming one of them (issue #373).
  `terminal_reason` named whichever step settled LAST — so the same two failures produced a
  different named culprit depending on the order they finished in, and under real concurrency the
  lock race picked it. The sentence now leads with the count and lists every failed step, deduped
  and sorted lexically, each with its own message read verbatim from that step's evidence:
  `2 steps failed: fail_a ("..."), fail_b ("...").` A step with no recorded message appears as a
  bare name — never fabricated. Long output is capped (120 characters per message, 1024 for the
  whole sentence, each ending in `...`), and the count always survives truncation.
  The sentence also **re-renders when a finalizer's own failure joins the record**. A finalizer
  runs after the seal, so its failure used to land in `failed_steps` beside a sentence that had
  already been written and could no longer see it — a run could hold three failed steps while its
  cause line named one. Both the guard `resolution_error` seal and the legacy dormancy path get the
  same treatment, and the two layers emit byte-identical sentences.
  **A run with exactly ONE failure is unchanged**, including the wording of the guard sentence — the
  single-failure shape was never the bug.

### Added

- The loader now REJECTS a failure condition that can never be true (issue #362). Writing
  `when: ['$settlement.extract.failed == true']` on a step that depends on `extract` reads exactly
  like "run this when extract fails" — and it never runs, because the trigger gate is evaluated
  before the condition and the default `all_success` requires `extract` NOT to have failed. The run
  record then blames `trigger_rule_unsatisfiable` and names the rule, never the condition, so the
  diagnosis points away from the mistake. Such a workflow **no longer loads**: the error names the
  step, the surface, the condition verbatim, the effective rule (saying "default" when it was
  omitted, since that omission is the whole bug), what actually happens at runtime on that
  particular surface, and the trigger rules that would genuinely run the step — computed for that
  step, since `all_failed` is a valid remedy at one dependency and a trap at two. Guards get a
  different message: they cannot declare a trigger rule at all, so the remedy there is an
  `execution: finalizer` step rather than a rule change.
  Scope is deliberately narrow: only the exactly-decidable case (`all_success`/`none_failed` with
  the exact `$settlement.<dep>.failed` shape, where the dependency is declared). The subtler
  `one_success`-at-one-dependency case and the `== false` mirror are tracked separately.
  **Asymmetry worth knowing:** file-loaded paths (`run`, `agent`, `listen`, `register`, `validate`)
  now hard-fail on this shape, while an already-registered workflow is read back without
  re-validation. That is safe here only because `.failed` itself shipped in v0.38.0 the same day —
  no stored workflow can carry the shape yet.

### Fixed

- Two documentation defects shipped in v0.38.0, both corrected loudly. The absence test
  (`failed == null`) was documented surface-agnostically; it is **`when`-only** —
  `preconditions` and `abort_unless` use an evaluator with no `null` literal, so the right-hand
  side becomes the string `'null'`, which never matches: on `preconditions` the step never settles
  and the run wedges, on `abort_unless` the guard aborts every run. And the multi-dependency
  routing example recommended "use `all_done` (or `all_failed`)" — `all_failed` requires EVERY
  dependency to fail, so on that two-dependency example it would not have fired when only one
  failed, and the compensation would still never have run.

---

## [0.38.0] — 2026-08-17

### Added

- `$settlement.<step>.failed` — a cleanup step can now see WHICH steps failed (issue #305). The
  marker is a plain boolean beside the existing settlement fields, and it closes a real gap: a
  finalizer HANDLER previously received `{settled_by_default, validation_rejections}` per step and
  no failure status at all, so a run that sealed complete while carrying failed steps gave its
  cleanup nothing to branch on. Finalizers read it as
  `ctx.resources['$settlement'][<step>].failed` in handler code — `when`/`depends_on`/`input_map`
  are refused on `execution: finalizer`, so branching is imperative there today (issue #360 tracks
  widening that). Ordinary steps additionally gain declarative routing:
  `when: ['$settlement.extract.failed == true']` on a multi-dependency step, which is the marker's
  real increment over `trigger_rule: one_failed` — knowing which dependency failed, not merely that
  one did. Such a step needs `trigger_rule: all_done`, since the default `all_success` marks it
  unsatisfiable before the condition is ever evaluated; the docs say so.
  Deliberately STATUS only — no messages, no causes. Per-unit status is the field's in-band floor;
  failure detail in a declarative payload is shipped by no surveyed orchestrator, and it would fork
  the truth away from the append-only run record. Detail stays in `realm run inspect`.

### Fixed

- Unknown `$`-directives in an `input_map` no longer resolve silently to garbage (issue #287). A
  key like `{ $template: "…" }` — a directive that has never existed — was accepted at load, then
  resolved as a context path yielding `undefined`, and finally dropped by the adapter's type guard,
  so the step reported success with the param effectively unset. In production this ran an Airtable
  query **unfiltered** for five weeks and corrupted 907 downstream records while every layer looked
  healthy. Three layers now close it: the loader rejects an unknown `$`-key (naming the step, the
  param path, the key, the supported set, and the fix, with a did-you-mean for near misses); the
  runtime refuses it as a loud attributed step failure (`INPUT_MAP_UNKNOWN_DIRECTIVE`), which is
  what catches workflows registered before this shipped; and `$literal` with sibling keys — which
  previously fell through and resolved the literal's own value as a path — is refused at both.
- Adapter scalar params that are **present but mistyped** now raise `ADAPTER_VALIDATION_FAILED`
  naming the adapter, operation, param, expected type and found type, instead of being silently
  omitted (issue #287). Ten sites across the Airtable, Notion and Gorgias adapters read params
  through a shared helper that generalizes the discipline the Gorgias list params already used. An
  absent, `null`, or `undefined` param is still simply omitted — unresolved optional `input_map`
  paths arrive that way routinely — and Slack's `text` keeps its required-param contract unchanged.
  A source-sweep test keeps the class dead: it fails on any new bare `typeof params[…]` guard in an
  adapter. **Honest boundary:** that kills the scalar-typeof drop class only; two `Array.isArray`
  drops (Airtable's `fields` and `sort`) remain and are tracked separately.

### Changed

- Workflows **already registered** that carry an unknown `$`-directive in an `input_map` now FAIL
  LOUDLY at execution rather than running with a silently-broken param. This is deliberate: such a
  workflow was already producing wrong results, and a stored definition re-executes that on every
  run. Recommended sequence after upgrading: run `realm validate` against every workflow you still
  have the source for — that is now a free fleet-wide detector — then resume runs. Be aware that
  `realm validate` is file-based: a workflow registered without its YAML retained cannot be checked
  ahead of time and will instead surface at its first execution via the runtime refusal.

---

## [0.37.0] — 2026-08-16

### Added

- OpenAI structured-output parity — the TOOL-ARGUMENTS dimension, completing issue #313. A
  strict-declared tools step driven by `--provider openai` now sends grammar-constrained ARGUMENTS
  per tool: eligible tools carry `strict` on OpenAI's wire, assessed under the OpenAI profile, and
  ineligible ones ride unconstrained in the same request (mixing is legal). There is no budget walk
  on this provider — OpenAI publishes no strict-tool or optional cap (128 strict tools in one
  request were executed successfully), so every eligible tool is marked; `budget_excluded` is an
  Anthropic-only outcome. A compat endpoint without `--strict-base-url` reports `compat_endpoint`
  per tool, and a tools-fork 400 drops strict, retries the turn once, and records the drop with the
  provider's own `api_param`/`api_code`. A new conformance suite makes the capability a checked
  promise rather than a claim: every provider declaring `toolArgsStrict` must provably place it on
  the wire, and a provider added without a table row fails the suite.
  **Measured yield, corpus-qualified** (262 tools across 17 public MCP servers, both profiles run
  against the same corpus): **5.3% (14/262) strict-attachable as written under OpenAI's rules, vs
  20.6% (54/262) under Anthropic's** — the difference is not ecosystem drift but OpenAI's stricter
  structural requirement, since all 40 profile flips are Anthropic-pass→OpenAI-fail and every one
  of them is `not_all_required`. The entire OpenAI fail mass is structural: a missing explicit
  `additionalProperties: false` (82.3% of ineligibles) and properties outside `required` (68.1%),
  with **zero** keyword failures and **zero** cap failures. GitHub's own 116-tool server: 0% under
  both. On the subset shaped like the original #311 corpus the earlier 8.8% figure reproduces
  (9.7%, playwright having grown 20→24 tools). Injecting `additionalProperties: false` alone would
  lift Anthropic to 77.1% but OpenAI only to 35.5% — the all-required rule is an independent second
  barrier, which is why no transform ships.
- OpenAI structured-output parity — the OUTPUT dimension (issue #313). A `structured_output: strict`
  step driven by `--provider openai` is now genuinely grammar-enforced via Chat Completions
  `response_format: json_schema` (with `strict` always explicit — omitting it is a silent
  non-enforcement mode, not a neutral default), where it previously fell back to prompt-only JSON.
  Schemas are assessed against an OpenAI-specific rule profile built from executed probes, because
  the two providers disagree in both directions: OpenAI accepts and enforces `minLength`/`pattern`/
  numeric bounds and supports recursion, but requires EVERY property to be in `required` and rejects
  `allOf`/`not`/`dependent*`/`if-then-else` outright. The sanctioned fix for optional fields —
  keeping them required and widening to a null union — ships with its measured behaviour rather than
  reassurance: over 24 real inputs a load-bearing field stayed filled 24/24 while a low-salience one
  shifted to null 21/24, so consumers must treat null as equivalent to absent.
  Also: `--strict-base-url`, an author attestation that an OpenAI-compatible `--base-url` endpoint
  actually enforces strict (without it, strict is never sent there and every attempt records the new
  `compat_endpoint` disclosure, which the run-health downgrade finding includes); a `provider` field
  on every attempt's evidence, naming `anthropic`/`openai`/`openai-reasoning`/`module:<name>`; the
  provider's own `api_param`/`api_code` captured verbatim beside `api_message`; and a drive-time
  stderr nudge that prints the remediation when a strict-declared step is downgraded or caveated —
  which fires on Anthropic drives too, where such steps were previously silent.
  **Tool-call ARGUMENTS on OpenAI are unchanged in this release** and still report
  `provider_unsupported` per tool — accurate, since that wire path still ignores the per-tool
  marker. Parity for that dimension lands in the follow-up PR (now shipped — see the tool-arguments
  entry above).

### Changed

- The per-tool `provider_unsupported` disclosure now names third-party `--provider-module` providers
  specifically (issue #313). Both in-repo tool-capable providers place the per-tool strict marker on
  their own wire, so on OpenAI a tool that rides unconstrained now reports the real reason — its own
  eligibility verdict, or `compat_endpoint` — instead of "this provider doesn't support it".

### Fixed

- Per-tool strict evidence no longer claims wire placement on providers that cannot deliver it
  (issue #311, ahead of #313). Strict tool-call arguments shipped gated only on the step's
  declaration, so a strict-declared tools step driven by any provider other than Anthropic
  recorded `tool_args[].strict_sent: true` while that provider's wire builder ignored the marker
  entirely — evidence asserting realm had placed strict on a request where it had not. Per-tool
  strict is now gated on a new, conservative-by-default provider capability (`toolArgsStrict`,
  declared only by `AnthropicProvider`): a provider that cannot consume the marker gets no
  marking, no re-sorting, no eligibility assessment, and an honest `provider_unsupported` entry
  per declared tool. Anthropic behaviour is unchanged.

---

## [0.36.0] — 2026-08-16

### Added

- `structured_output: strict` is now accepted on agent steps that declare `tools`, where it constrains
  the **tool-call arguments** realm's model passes to each MCP tool (issue #311). Strict is assessed and
  attached **per tool, only where the tool's published schema is compliant as written** — realm never
  rewrites a third-party schema — with non-compliant tools riding unconstrained in the same request, and
  a declared-order budget walk honouring Anthropic's 20-strict-tool / 24-summed-optional limits. The
  step's own output is unaffected: it stays post-hoc validated (L1) and continues to disclose
  `unsupported_context_tools`, which is now an output-dimension statement rather than "strict was
  unavailable". Evidence gains a per-tool `tool_args` block (which tools carried strict, which were
  skipped and why, and any mid-attempt 400/503 drop), and the `structured_output_downgraded` run-health
  finding gains exactly one dimension-marked reason, `tool_args:api_rejected_schema`.
  **Honest yield:** measured against 238 real tools across 14 public MCP servers, only **8.8%** are
  strict-attachable as written today — **0.5%** excluding one server whose pass is an accident of its
  schema converter's defaults (GitHub's 116-tool server: 0%). The near-universal blocker is a missing
  explicit `additionalProperties: false`, which is the publishing server's to fix, not yours. This
  ships as an evidence-first capability whose ceiling rises as upstream schemas improve (issue #344);
  on most servers today, opting in will attach strict to few or no tools — and will say so per tool.

### Changed

- `realm listen`'s webhook dedup store default base directory now resolves via `homedir()` instead of
  a bare `process.env['HOME'] ?? '.'` check (issue #332) — matches the house pattern every other store
  default uses, resolves correctly on Windows (`HOME` is POSIX-only), and never silently falls back to
  writing under the current working directory when `HOME` is unset.
- A strict-declared, tools-bearing agent step now discloses `unsupported_context_tools` instead of the
  engine's synthesized `external_agent` stamp (issue #332) — `external_agent` claims realm made no
  request at all, which was never true for a step realm's own agent drove via the tools path; this is a
  disclosure change, not a wording change: such runs now newly appear in the `structured_output_downgraded`
  run-health finding, where they were previously invisible (`external_agent` is that finding's
  load-bearing exclusion). A watchdog that saw these runs as clean will now see the downgrade.

---

## [0.35.0] — 2026-08-14

### Added

- `realm run gc --heal` (issue #293): an opt-in, one-shot pass that rewrites grandfathered run records
  whose persisted `run_phase` disagrees with the phase re-derived today — a no-op rewrite through the
  store's own versioned write, safe at any age, composable with the existing temp/orphan-artifact
  sweeps.
- A run-health finding class (`structured_output_downgraded`, issue #316): one aggregated finding per
  run disclosing every step that declared `structured_output: strict` but ran without it — informational
  only, visible on live runs via `get_run_state`/`list --stuck` (excluded from stuck selection) and on
  terminal runs via `realm run inspect`.

### Changed

- `@sensigo/realm` drops its unused `dotenv` dependency (issue #327) — nothing in core's source imports it;
  the real consumer is `@sensigo/realm-cli`, which already declares its own. Behavior-neutral for consumers.

### Fixed

- `JsonFileStore` and `JsonFileReplayStore` (issue #285) now resolve their default `~/.realm/{runs,replays}`
  directory at construction time instead of module load, matching `JsonWorkflowStore`'s existing pattern —
  a store constructed after `$HOME` changes now sees the new value.
- `@sensigo/realm-mcp` (issue #327) now declares its own `proper-lockfile` dependency instead of relying on
  npm's hoisting of `@sensigo/realm`'s copy — a phantom dependency is a latent crash under any installer
  that doesn't hoist (e.g. strict/isolated installs).
- A late `submit_human_response` on a terminal run, in the rare concurrent-settlement race window
  (issue #319), now gets an honest terminal disclosure instead of a generic internal-error answer.

---

## [0.34.0] — 2026-08-12

### Added

- A run-health finding class (`completed_with_failed_steps`): a run that seals `completed` while still carrying
  `failed_steps` (designed recovery behavior) is now disclosed on CLI surfaces (`realm run inspect`), informational
  only — never a warning or a `--stuck` selection.
- `get_run_state` now echoes the run's own `terminal_reason` verbatim when present.
- A new, author-opt-in finalizer trigger, `completed_with_failed_steps`: fires in addition to `complete`/`always`
  on a `complete` seal that still carries `failed_steps`. Combine it with `fail` in the existing array form to
  cover both shapes with one finalizer: `on_outcome: [fail, completed_with_failed_steps]`.
- `abandon` now carries an explicit, unconditional advisory — "abandon is a kill — declared finalizers (if any)
  did NOT run; `abort` is the graceful path" — on the `abandon_run` MCP tool's response (`note`) and on
  `realm run abandon`'s success output. The behavior itself (abandon runs no finalizers) is unchanged; this
  documents and surfaces it.
- A new, author-opt-in step key, `structured_output: 'strict'` (`execution: agent` steps only): realm turns on
  Anthropic grammar-constrained ("strict") decoding for the step's submit tool, gated by a realm-owned
  eligibility check (some legal schemas are silently weakened or rejected by the API), a never-strand fallback
  ladder on live 400/503s, and full per-attempt disclosure in evidence (`diagnostics.structured_output`). See
  [`structured_output`](docs/reference/yaml-schema.md#structured_output-anthropic-strict-decoding). `realm
validate` also gains a per-step adoption nudge on its own informational channel.
- Authorable gate timeout (#291): five new `gate:` sub-keys — `timeout_seconds`/`on_expiry`/`default_choice`
  (the enforce clock) and `reminder_seconds`/`reminder_max` (the notify clock), mint-frozen into the run
  record. An expired, undisposed gate is enacted level-triggered by any of `submit_human_response`,
  `execute_step`, `realm run drain --expired` (new opt-in flag — bare `drain` stays byte-stable), the
  attending CLI process's own timer, or `realm listen --sweep-expired-gates <seconds>` (new opt-in flag) —
  every enactment point shares one idempotent arm matrix, so races between them NOOP harmlessly. A late human
  response to an already-expired gate gets an honest, disposition-specific refusal rather than being silently
  recorded as if it arrived in time. A new run-health finding, `gate_expired_awaiting_drive`, and EXPIRED/
  reminder-due-or-overdue rendering on `realm run list`/`inspect`/`get_run_state` disclose the window between
  expiry and the next drive. `realm run reclaim` never enacts a sibling gate's expiry itself — it only
  advises. See
  [`gate.timeout_seconds`](docs/reference/yaml-schema.md#gate-timeout-authorable-enforce-notify-clocks).

### Changed

- `examples/*/workflow.yaml`, the docs example schemas, and the `realm init` scaffold now declare
  `additionalProperties: false` on every object schema (congruence with the `structured_output` gate above) —
  this narrows Ajv validation at those steps (extra, previously-tolerated properties are now rejected). No
  constraint keyword (`minimum`/`maximum`/`minLength`/`maxLength`/`pattern`/etc.) was removed anywhere.
- `resolveMaxTokens` (the Anthropic provider's per-model output-token cap) no longer gives the claude-3.5
  family's own hard cap (8192) to every 4.x model too — 4.x/*-5/unknown future model ids now get 16384 (#309).

### Fixed

- `realm run list --status aborted` is no longer rejected — `aborted` was a valid `run_phase` value the
  `--status` filter's own validator had never been updated to accept (#289).

### Security

- Bumped `@modelcontextprotocol/sdk` 1.29.0 → 1.30.0 (exact-pin manifest bump, realm-mcp + realm-cli): adopts the
  upstream fix for GHSA-frvp-7c67-39w9 — the SDK's widened range now resolves `@hono/node-server` 2.1.0 (≥2.0.5,
  the patched line). **Retires the standing `not_affected` posture**: the audit-ci allowlist entry (both tiers) is
  removed and the OpenVEX document gains a `fixed` statement (v2) — the wait-for-upstream disposition set at
  v0.31.0 completes.
- Bumped `hono` 4.12.31 → 4.13.0 (lockfile-only, in-range): GHSA CORS-middleware ReDoS (moderate; realm's serve
  path uses hono core only — fixed in-range regardless).

- Bumped `fast-uri` 3.1.4 → 3.1.5 (lockfile-only, in-range via `ajv`): GHSA-7p8r-x3mc-p8w7 (HIGH, host confusion
  via backslash authority). Exposure LOW (same class as the v0.31.0 fast-uri triage: `ajv` uses fast-uri only for
  opaque `$ref` parsing and makes no trust decision on the parsed host) — fixed in-range regardless.
- Bumped `ip-address` 10.2.0 → 10.4.0 (lockfile-only, in-range via `@modelcontextprotocol/sdk`'s
  `express-rate-limit`): GHSA-mwp4-54f8-5fhr, GHSA-4xrf-jv44-h6hh, GHSA-22jq-vg5j-6vgg (HIGH, IPv4/IPv6
  parsing misclassification). Exposure LOW (used for client-IP classification in the MCP `serve` rate limiter;
  realm makes no SSRF-relevant address-trust decision) — fixed in-range regardless.
- Bumped `js-yaml` 4.3.0 → 4.3.1 (lockfile-only, in-range): GHSA-5p4m-2wfm-xmqj (HIGH, CVE-2026-59870 — quadratic
  CPU consumption in `!!omap` resolution; the 5.x fix line's backport to 4.x). Exposure LOW (same class as the
  v0.30.0 js-yaml triage: every `js-yaml` entry point in realm — the workflow loader, the extensions manifest
  loader, `realm validate`, test fixtures — parses operator/developer-authored local files, never untrusted
  network input) — fixed in-range regardless.

---

## [0.33.0] — 2026-07-27

### Fixed

- Fan-out zombie-gate resume: `realm resume` now clears a stale `pending_gate` loudly (a disclosure line) instead
  of silently carrying it forward.
- Grandfathered terminal-with-stale-gate runs (the `#282` class — genuinely terminal, but a leftover persisted
  `run_phase` still reads `gate_waiting`) were unpurgeable and unresumable.
- `rerun_if_failed` could mint a duplicate run for a completed workflow carrying a stale phase.
- `append_trace` accepted writes on terminal runs carrying a stale gate phase.
- Terminal exports falsely redacted claim nonces and suppressed the pending-finalizer warning.
- Run-phase derivation now ranks terminal markers (`terminal_state`, `aborted_at`, `abandoned_at`) above an open
  gate — stale `gate_waiting` labels heal on the next write.
- Fan-out gate-open, gate-resolution, and guard seals can no longer lose an overlap with a concurrent settle —
  deterministic CAS-loss (a stuck claim, a human decision reported "not recorded", a discarded guard
  terminalization) is now dead for stores that declare atomic settlement.
- Gate and guard terminal seals no longer fire their finalizers before the terminal commit — delivery is now
  ledger-mediated, exactly-once, and recoverable via `realm run drain` if a crash lands between commit and delivery.

### Changed

- Gate-open, gate-resolution, guard, and capability-block/compensating-release write paths migrate to atomic
  settlement (`RunStore.settleStep`); a non-declaring external store keeps the legacy write path plus an
  upgrade advisory, matching the increment-1 lockstep-upgrade posture.
- Refusal envelopes at the gate, guard, and capability-block surfaces are now uniformly typed, including a
  cancelled-gate disclosure ("your choice was NOT recorded") when a sibling abort cancelled the gate first.

### Added

- Dormant settlement delta kinds for gates/guards/release (`open_gate`, `settle_gate`, `settle_guard`,
  `release_step`) — engine-inert until the next increment — plus the settlement TCK laws covering them.
- `submit_human_response` gains an optional `responded_by` attribution pass-through (recorded, not enforced).
- Three new run-health finding classes for stale/corrupt gate states: a terminal record still carrying a
  pending gate, a settled gate entry coexisting with a live gate of the same id, and a resolved gate with a
  guard now awaiting its next drive.

## [0.32.0] — 2026-07-26

### Added

- `realm run list --stuck` now attributes cause — appends the failed-attempt count and latest validation summary
  for runs with a FailedAttemptStore sidecar (MCP-path runs; CLI-driven runs are unaffected).
- `get_run_state` and `realm inspect` now report a run's default-settled steps regardless of how the run sealed
  (complete, failed, or aborted), derived from evidence — closing the failure-path disclosure gap from #220.
- `RunStore.settleStep` (optional): atomic intent-based step settlement applied to fresh state under the store's
  own serialization, with the `applySettlement` pure transform, per-claim fencing tokens, the finalizer ledger, and
  a forcing conformance TCK.
- `realm run drain <id> [--force]` / `--all [--force]` / `--void <finalizer>`: recovers finalizers left undelivered
  by a crash between a settle's commit and its post-commit drain — dry-run by default (draining executes extension
  code), rank-pass rendering (actionable / lease-held / rank-blocked-behind-held-lease / no-pendings), and an
  operator void with lease-discriminated disclosure and full evidence provenance.
- `realm run purge` refuses (`STATE_RUN_BUSY`, reason `drain_pending`) to delete a terminal run with an undrained
  finalizer, in every mode including single-id `--force` — the escape is `realm run drain` / `--void`, never
  force-bypassing purge.
- `get_run_state` / `realm run list --stuck` / `realm inspect` gain a new run-health finding,
  `terminal_pending_finalizer`, for a terminal run carrying an undelivered finalizer — pointing at `realm run drain`.
- `start_run` (idempotent reuse) and `realm run export` now disclose undelivered finalizers on a terminal run
  ("N finalizer(s) not yet delivered — realm run drain `<id>`"); `realm agent --run-id` on a terminal run with
  pendings appends the same pointer to its refusal message.
- `get_workflow_protocol` gains one appended rule: a concurrent settlement of the same step by a sibling attempt
  resolves automatically — on `STATE_STEP_ALREADY_SETTLED`, call `get_run_state` and continue.
- Two new `WorkflowError` codes: `STATE_STEP_ALREADY_SETTLED` and `STATE_CLAIM_LOST` (the migrated seal sites'
  typed settle_step refusal envelopes).

### Fixed

- Run-file store locks now use jittered, bounded backoff (defeats thundering-herd lock contention under fan-out),
  and an exhausted lock acquisition is now a retryable `STATE_RUN_BUSY` instead of a fatal error.
- The fan-out seal wedge (issue #279): two sibling steps settling concurrently on the migrated paths now both
  record cleanly — no `STATE_SNAPSHOT_MISMATCH`, no lost outcome. Finalizers now fire strictly AFTER their
  triggering settle commits durably (post-commit drain), closing the latent fire-before-commit window the legacy
  read-then-update seal carried (a settle that lost a race could still have already fired its finalizers).
- `realm resume` now strips a stale `abandoned_at` marker in the same write that clears `terminal_state` (issue
  #281) — previously a resumed-and-re-terminalized run could still read as "abandoned" to a reader that treats
  `abandoned_at`'s presence as authoritative.

### Changed

- The engine's three seal sites (complete, fail, handler-abort) now settle via `RunStore.settleStep` when the
  store declares it — the legacy read-then-update path remains the fallback for a store that does not (fail-closed
  dormancy; this dual branch persists until a major version). **Upgrade all binaries sharing a `runsDir` together**
  — pending-finalizer guards (the purge refusal, the drain verb, the run-health finding) exist only from this
  version onward; an older binary sharing the same `runsDir` neither recognizes nor respects them.
- `realm resume` gained four refusals before its write: an aborted run is never resumable; a finalizer named via
  `--from` is refused (drain/void it instead); an unexpired drain lease refuses (bounded wait, never
  force-bypassable); and an in-progress claim now blocks resume unless it is provably stale (`--force` overrides
  only the unknown-age case, never a healthy claim).

---

## [0.31.2] — 2026-07-25

### Changed

- Bumped `uuid` from 13 to 14 (a `@sensigo/realm` core production dependency). The `v4` ID-generation API is
  unchanged, and uuid 14's raised Node floor (20) sits below realm's own `>=22` requirement — behaviour-neutral;
  consumers receive only a resolved-version update.
- Bumped `commander` from 14 to 15 (a `@sensigo/realm-cli` production dependency). realm-cli imports it as ESM, so
  commander 15's ESM migration is transparent and its `require(esm)` Node-22.12 note (which applies only to
  CommonJS `require('commander')`) does not affect realm — the `Command`/subcommand API is unchanged and the full
  CLI test suite passes. Behaviour-neutral.

---

## [0.31.1] — 2026-07-24

### Changed

- Bumped the `ajv` schema validator (a `@sensigo/realm` core production dependency) from 8.18 to 8.20.
  Routine dependency maintenance — realm's own usage is unaffected (it never enables ajv's `$data` option
  and requires Node ≥22), so there is no behaviour or API change; consumers receive only a
  resolved-version update.

---

## [0.31.0] — 2026-07-23

### Changed

- **In-conversation full-AJV correction for tool-using agent steps — the "reask layer" (issue
  #224).** A tool-using `execution: 'agent'` step whose model output has the right keys but the
  wrong types/enums/nested shapes could not be repaired before this change: the provider's
  in-conversation correction check (both `AnthropicProvider` and `OpenAIProvider`) validated only
  that required keys were present, so a type/enum/shape violation passed straight through to the
  engine's own AJV gate and died at the drive — where issue #217 deliberately declines to repair a
  tools-path step (a stateless re-call would re-execute every already-completed tool call). The
  correction loop now runs the SAME full AJV validation the engine itself uses
  (`validateAgentSubmission`, new in `@sensigo/realm`, alongside newly-exported
  `validateOutputSchema`/`RawValidationError`/`AgentSubmissionValidation`) — inside the RETAINED
  conversation, where tool results already survive and nothing re-executes. `validateAgentSubmission`
  is a provider-side REPLICA of the engine's own two throwing validators (never a unification —
  issue #220's rejection counting/exhaustion telemetry stays built on the engine's own separate
  Step 2b/2c checks, byte-unchanged), validates a declared `input_schema` and `output_schema`
  SEQUENTIALLY (never combined into one `allOf`, which would over-reject under
  `additionalProperties:false`), and mirrors the engine's `_debug`-field strip before validating
  either schema. `callStepWithTools`'s options gain two new additive-optional fields,
  `validationInputSchema`/`validationOutputSchema` (the step's raw declared schemas, consumed only
  by this correction loop) — the pre-existing `options.inputSchema` field is unchanged and keeps
  feeding the submit tool and system prompt exactly as before. The correction message itself is
  leak-safe: field paths/keywords/expected-types and schema-declared `enum`/`const` allowed values,
  **never the submitted/offending value**. Corrections draw on the same shared `maxToolCalls`
  budget as tool calls (a deliberate choice, not a gap) — a per-correction stderr breadcrumb
  (`⚠ output rejected (in-conversation); correcting (n)`) plus a new `correctionCount` on the
  cli-local `StepWithToolsResult` make that budget consumption visible instead of silent.
  Separately, **`OpenAIProvider.performFinalExtraction` no longer throws when the tool-call budget
  is exhausted and the last output is still schema-invalid — it now returns that output, exactly
  like `AnthropicProvider` already did.** This unifies both providers on the posture issue #220
  depends on: a returned (even invalid) output flows through the engine's own Step 2c
  `countRejection`, so the rejection is counted and exhaustion terminalizes normally; a thrown
  error is instead caught by `run-agent.ts`'s outer catch, which returns `'failed'` without ever
  reaching the engine — the run is never counted, never sealed, and a re-attach re-executes every
  tool call from scratch. Only a genuine PARSE failure (no usable JSON object at all) still
  throws. No behavior change for `callStep`-only (non-tool) agent steps, and no change to the
  engine's own validation gate, `execute_step` telemetry, or the #217 repair-gate's tools-path
  refusal.

### Security

- **`fast-uri` bumped 3.1.2 → 3.1.4 — fixes two HIGH host-confusion advisories**
  ([GHSA-4c8g-83qw-93j6](https://github.com/advisories/GHSA-4c8g-83qw-93j6) failed-IDN-canonicalization
  and [GHSA-v2hh-gcrm-f6hx](https://github.com/advisories/GHSA-v2hh-gcrm-f6hx) literal-backslash
  authority delimiter, both CVSS 7.5), a transitive dependency of `ajv`. Within the existing `^3.0.1`
  range (lockfile-only; no `package.json` change, no `overrides`). Realm exposure is LOW: `ajv` uses
  `fast-uri` only to parse author-controlled schema `$id`/`$ref` references, never for a host-based
  security decision, so the host-confusion path is not weaponizable in realm. Clears the
  pre-publication `npm audit` gate.
- **`hono` bumped 4.12.25 → 4.12.31 (via Dependabot #241) — clears three MODERATE advisories**
  ([GHSA-xgm2-5f3f-mvvc](https://github.com/advisories/GHSA-xgm2-5f3f-mvvc) API-Gateway-v1 header
  de-duplication, [GHSA-hvrm-45r6-mjfj](https://github.com/advisories/GHSA-hvrm-45r6-mjfj) `hono/jsx`
  per-request context isolation, [GHSA-w62v-xxxg-mg59](https://github.com/advisories/GHSA-w62v-xxxg-mg59)
  `hono/css` `cx()` JSX escaping bypass), a transitive dependency of `@modelcontextprotocol/sdk`.
  Within the SDK's existing `^4.11.4` range (lockfile-only; no `package.json` change, no `overrides`).
  **Realm exposure is NONE:** all three advisories live in optional hono entrypoints (`hono/aws-lambda`,
  `hono/jsx`, `hono/css`); realm's only HTTP surface is the SDK's `StreamableHTTPServerTransport`
  (JSON-RPC over HTTP), which exercises hono _core_ routing only — it renders no JSX, uses no `cx()`,
  and runs no API-Gateway adapter.

---

## [0.30.0] — 2026-07-21

### Added

- **Bounded validation-rejection exhaustion, PR-1 (issue #220).** A persistently schema-rejected
  `execution: 'agent'` step is no longer an unbounded wedge: `RunRecord.validation_rejections?:
Record<string, number>` (additive, joins the #188 `LoadBearingRunRecordField` closed set) counts
  the two model-attributable rejection codes (`VALIDATION_INPUT_SCHEMA`/`VALIDATION_OUTPUT_SCHEMA`)
  per step, pooled across writers, never reset. `countRejection` (the engine's single counting
  chokepoint) persists the count via a bump-and-report CAS write — the rejection's own envelope
  keeps reporting the pre-write version, so the #217 in-drive repair gate's `run_version`
  comparison stays sound across repeated repairs. At `count ≥ threshold`
  (`DEFAULT_VALIDATION_EXHAUSTION_THRESHOLD = 6`, exported; per-step override via
  `validation_exhaustion: { threshold }`, integer ≥ 1) the engine mints a NEW `VALIDATION_EXHAUSTED`
  error and falls through to a REAL step failure — claims, fails, drains `on_outcome: fail`
  finalizers when the run completes, seals, exactly like any other dispatch failure. On a later
  SUCCESS settle with an accrued count > 0, the settle evidence is stamped
  `diagnostics.validation_rejections: N` ("succeeded after N rejections"). `VALIDATION_EXHAUSTED`
  joins the MCP `execute_step` telemetry set (its `ajv_errors` sourced from
  `error_details.last_ajv_errors`). `realm agent` warns once per step, at drive time, when
  `--schema-retries`'s own repair budget exceeds the step's effective exhaustion threshold
  (operator intent would otherwise be silently truncated mid-loop). Advisory-only elsewhere (#119):
  a store not declaring `validation_rejections` draws a softened durability caveat on every counted
  rejection; `create_workflow` draws a targeted "register-time only" warning for a submitted
  `validation_exhaustion` key (dynamic workflows are still auto-enrolled at the default posture).
  `$settlement` is reserved as a step name NOW (both the YAML loader and `create_workflow`) ahead
  of a later PR's namespace mint — the PR-ordering interlock that prevents an inter-PR gap from
  registering a step name that would become load-refused the instant the mint ships. PR-2
  (fail-open `mode`/`default_output`) and PR-3 (the `$settlement` mint) are separate, later
  changes — this PR is counting + terminalization only.

- **Declared fail-open for bounded validation-rejection exhaustion, PR-2 (issue #220).**
  `validation_exhaustion` gains `mode?: 'fail' | 'default'` and `default_output?: unknown` —
  **strictly opt-in; every existing workflow keeps PR-1's `mode: 'fail'` behavior byte-for-byte,
  with zero change to counting, terminalization, or #217's repair gate.** An author opting a step
  into `mode: 'default'` must also declare `output_schema` and a `default_output` that validates
  against it — enforced at LOAD TIME by reusing the exact runtime AJV validator
  (`validateOutputSchema`), so a fallback that would itself fail runtime validation is refused
  before the workflow ever registers. On exhaustion, the engine SETTLES the step successfully with
  `default_output` instead of failing the run: the settle evidence is stamped
  `diagnostics.settled_by_default: true` alongside `diagnostics.validation_rejections: N`; the
  success `ResponseEnvelope` carries a matching top-level `settled_by_default: true` and a
  human-readable disclosure line in `warnings` (both survive the MCP tool wrapper's strip). A
  `human_confirmed`/`human_reviewed` step opens its gate on the `default_output` preview instead
  (fail-safe — the human sees the substitution before it settles; a `reject` choice still settles
  the step with that output — a rejecting human does not "un-default"). `RunRecord` gains an
  additive-optional `defaulted_steps?: string[]` — a run-level convenience list of every step that
  settled via its declared default in this run, stamped onto the sealed record ONLY on the
  `'complete'` terminal transition (a run that later fails after a mid-workflow default-settle
  does not carry this field on its `'fail'`-sealed record; the per-step evidence stamp is the
  durable per-step truth regardless). `defaulted_steps` joins the #188
  `LoadBearingRunRecordField` closed set under a new membership class (a write-site
  disclosure-integrity advisory, alongside the existing read-site-consumer class) — a store that
  doesn't declare it durable draws an explicit warning rather than silently losing the marker.

- **The `$settlement` evaluation-root namespace, PR-3 (issue #220) — the final piece.** Exposes
  PR-2's fallback-provenance disclosure to every workflow evaluation surface: for each step that
  has SETTLED (`completed_steps ∪ failed_steps`), `$settlement.<step>.settled_by_default` and
  `$settlement.<step>.validation_rejections` let an author branch on whether a dependency
  default-settled — `when: ["$settlement.<dep>.settled_by_default == false"]`,
  `abort_unless: [...]` on a guard, a `precondition`, or (via the nested
  `context.resources.$settlement.<dep>.…` spelling) `input_map`/gate messages/template filters.
  Minted by a new pure exported helper, `buildSettlementNamespace(run)`
  (`packages/core/src/engine/eligibility.ts`), called from the ONE core chokepoint
  (`buildEvidenceByStep`) so every engine surface inherits it for free, and separately from
  `realm replay` (which builds its own evidence map) so a replayed precondition can never diverge
  from the live verdict. A `$settlement.<dep>` reference where `<dep>` is not a direct dependency
  of the referencing step is **load-refused** on `when`/`abort_unless`/`preconditions` (the same
  one-hop rule `when` already enforces for ordinary step references) — see the new `$settlement`
  section in `docs/reference/yaml-schema.md` for the full per-root spelling table and the named
  residual (a bad FIELD name, as opposed to a bad dependency name, is not load-refused anywhere;
  `input_map`/templates resolve it to `undefined` silently, matching their existing behavior for
  any other unresolvable reference).

### Changed

- **AUTO-ENROLLMENT (issue #220): every `execution: 'agent'` step with a countable schema now
  terminalizes after 6 persistent rejections by default — there is no reachable per-step opt-out
  in PR-1.** This is deliberate: an unbounded, silently-write-free rejection wedge is strictly
  worse than an honest, finalizer-visible failure (the #138/#140 precedent). Override the default
  via `validation_exhaustion: { threshold: N }` (`N ≥ 1`; `1` disables in-drive schema-repair,
  since the very first rejection already meets it).
- **`create_workflow`'s step-id reservation gains a pre-existing gap fix (issue #220): `run` and
  `context` are now refused as step ids, mirroring the YAML loader's own long-standing reservation
  (`create_workflow` never enforced either before this change).** `$settlement` joins both
  reservations as a new refusal on a name that was previously loader-legal (see the PR-ordering
  interlock note above).
- **Two new loader `WarningCode`s for `validation_exhaustion`, PR-2 (issue #220):
  `UNKNOWN_VALIDATION_EXHAUSTION_KEY` replaces PR-1's reuse of `UNKNOWN_STEP_KEY` for an
  unrecognized sub-key (closes an incoherence against the structurally identical retry-key
  family, which stays `warn`); `DEAD_VALIDATION_EXHAUSTION_CONFIG` warns when `default_output` is
  declared without `mode: 'default'` (inert, not an error).** Both default to `warn` — no existing
  workflow's load behavior changes.
- **`ResponseEnvelope` gains two additive-optional top-level fields (issue #220 PR-2):
  `settled_by_default?: boolean` (set only on the success envelope of a step that just settled via
  its declared default, never on a gate-open or human-response envelope) and `defaulted_steps?:
string[]` (mirrors `RunRecord.defaulted_steps` on a terminal `complete` envelope).** Both are
  absent on every envelope for a workflow that doesn't use `mode: 'default'` — no observable change
  for existing consumers.
- **`buildEvidenceByStep` (a PUBLIC core export, issue #220 PR-3) now always includes a
  `$settlement` key in its returned map — any external consumer iterating its keys as step ids
  will now also see `$settlement`.** No workflow BEHAVIOUR changes: a workflow that never
  references `$settlement` evaluates identically to before (the added key is inert unless
  referenced) — but the public-export OUTPUT SHAPE does gain the key on every call, hence the
  `Changed` grade rather than a claim of byte-identical output.

### Security

- **`js-yaml` bumped 4.2.0 → 4.3.0 — fixes a HIGH-severity denial-of-service in the workflow YAML
  parser ([GHSA-52cp-r559-cp3m](https://github.com/advisories/GHSA-52cp-r559-cp3m) / CVE-2026-59869,
  CVSS 7.5).** A crafted chain of YAML merge keys (`<<: *anchor`, each mapping merging the previous)
  could force quadratic CPU on linearly-sized input. 4.3.0 backports the `maxTotalMergeKeys` guard
  (default 10000) — a pure resource bound, not a parsing-semantics change: every legitimate workflow
  parses identically (realm authors no merge keys anywhere), while a pathological chain now throws a
  catchable error surfaced as `RESOURCE_FORMAT_INVALID`. Within the existing `^4.2.0` range
  (lockfile-only; no `package.json` change). realm's real-world exposure was LOW — every byte reaching
  the parser is operator-trusted (workflow files, the deployment manifest); no agent/network/registry
  path routes through `js-yaml` (the MCP surface is zod/JSON end-to-end) — but the fix is free,
  behaviour-neutral, and clears the release audit gate (production `npm audit` now reports 0 high).

---

## [0.29.0] — 2026-07-20

### Added

- **`RETRY_INERT_NON_AUTO` loader advisory for bare `retry:` sub-keys on a non-auto step (issue
  #218).** Extends #140's W5 (`TOTAL_TIMEOUT_NON_AUTO`, cap-only) family: a `retry:` block with no
  `total_timeout_seconds` on an `agent`/`guard` step now also draws a warning — the built-in
  dispatch path never throws for these steps, so `max_attempts`/`backoff`/`base_delay_ms` are
  otherwise silent dead config. Mutually exclusive with W5 by construction (exactly one of the two
  fires for any non-auto retry block that loads). Advisory only (#119) — `create_workflow` stays
  lenient; `validate --strict`/`register --strict` fail on it via the existing #169 accumulators.

- **In-drive schema-feedback repair loop for `realm agent` (issue #217).** When an `execution:
'agent'` step's output is rejected by `output_schema`/`input_schema` validation
  (`VALIDATION_OUTPUT_SCHEMA`/`VALIDATION_INPUT_SCHEMA`), the drive now re-prompts the SAME step
  with the validator's errors appended — a PRISTINE copy of the original prompt plus the LATEST
  rejection's whitelisted summary only (never accumulated, never the raw Ajv error array, which
  can carry schema-declared values like `enum.allowedValues`). New `--schema-retries <n>` flag on
  `realm agent` (default `2`, non-negative integer, `0` disables and reproduces today's
  single-attempt behavior byte-for-byte); one stderr line is printed per repair attempt, and the
  eventual failure message gains an "after N schema-repair attempts" suffix once at least one
  repair ran. Applies to both the plain `callStep` path and the MCP tools path (tools-path repair
  is scoped to a ZERO-toolCall attempt only — a repair after a tool actually ran is out of scope
  for this pass; see the `ToolCapableLlmProvider.callStepWithTools` JSDoc for the provider
  contract this relies on). Auto steps and the MCP protocol path are entirely unaffected — zero
  engine change. New core export-adjacent addition: `summarizeAjvErrors` (in
  `buildFailedAttemptRecord`'s `validation_error_summary`) now carries two additional
  keyword-conditional, key-name-only fields, `additional_property`/`missing_property`, feeding the
  repair prompt's summary without ever leaking a submitted or schema-declared value. Semver:
  minor-additive.

- **Typed run-health classification with honest per-surface reporting (issue #221).** New
  `classifyRunHealth` (core, `packages/core/src/engine/run-health.ts`) is the SINGLE shared
  predicate the three READ surfaces — `get_run_state`, `realm run list --stuck`, and `realm run
inspect` — now all derive from, so none of them can silently drift from another about what
  "wedged" or "idle" means. (`realm run reclaim` reads the SAME underlying record facts — settle
  sets, `capability_blocks`, reclaim-audit evidence — via its own independent discriminator; see
  the Changed entry below.) Pure, read-only, definition-optional, `now`-injectable. Classifies a run into zero
  or more typed `RunHealthFinding`s (`never_claimed_idle` | `stale_claim` | `wedged_gate_sibling` |
  `capability_block`); a new `never_claimed_idle` kind closes the gap the issue reported — an
  advanced-but-parked run (no claimed step, idle past a threshold) is now surfaced everywhere, not
  just by `list --stuck`. Default age threshold: `DEFAULT_IDLE_THRESHOLD_MS` (24h, exported,
  engine-minted — detection never requires an operator-supplied threshold). `get_run_state` gains
  an additive `run_health?: RunHealthFinding[]` field (present only when non-empty) plus a single
  advisory `warnings[]` line when findings exist; the pre-existing `stuck_claims`/
  `capability_blocks` arrays are kept for backward compatibility, with `run_health` documented as
  their canonical superset. `get_run_state` also gains a claims-field store-fidelity caveat
  (mirrors the existing issue #188 `capability_blocks` caveat) — when the configured run store
  does not declare `persistsClaims: true`, a warning names claim-liveness state as unavailable
  rather than silently reading as healthy. `next_actions_status` is completely unaffected by this
  change (fine-maps-to-coarse, never the reverse). `realm run inspect` renders findings after the
  `Updated:` line. Semver: minor-additive.

### Changed

- **`realm run reclaim`'s outcome for a step with no active claim (issue #221).** New
  `ReclaimOutcome` member `'no_active_claim'` replaces the previous conflation of "never claimed"
  with `already_settled` for any step not currently in `in_progress_steps` and not in
  completed/failed/skipped — that conflation was misleading (a previously-reclaimed or
  capability-blocked step WAS touched, so calling it "settled" reads like a resolution when it is
  an idempotent no-op). `already_settled` is now reserved for the genuinely-settled case
  (completed/failed/skipped). An optional, evidence-earned `detail` field
  (`'previously_reclaimed'` | `'capability_blocked'`) further narrows `no_active_claim` when
  positive evidence supports it — never inferred from absence. The single-step CLI message for
  this outcome is now honest: "no active claim on 'X' and it is not settled — nothing to reclaim.
  If its dependencies are satisfied, driving the run will execute it." (never "still eligible" —
  unverifiable without the definition, which single-step reclaim does not load). Batch mode
  (`--all`) now prints the neutral `•` glyph (rather than `✓`) for every non-mutating outcome,
  reserving `✓` for the one outcome that actually mutated the run (`reclaimed`).
- **`realm run list --stuck`'s never-claimed detection is now age-gated (issue #221, disclosed
  behavior change).** Previously, `--stuck` flagged EVERY `running` run with no currently-claimed
  step — including a healthy run simply between agent drives (agent claims are call-scoped, so
  this branch matched a normal at-rest state, not just a genuine wedge). `--stuck` now adopts
  `classifyRunHealth`'s `never_claimed_idle` kind, which requires the run to have been idle for at
  least `DEFAULT_IDLE_THRESHOLD_MS` (24h) before flagging it — the reference surface was itself
  over-broad; the fix is a typed, discriminating classification rather than every surface
  converging on the old boolean. A new `--older-than <duration>` option overrides the threshold
  (reuses the shared `parseDuration` CLI leaf, e.g. `--older-than 6h`); `--older-than 0m` restores
  today's unconditional breadth (bare `0` is rejected — use `0m`). `--older-than` requires
  `--stuck`. The claim-based (`stale_claim`/`wedged_gate_sibling`) and capability-based
  (`capability_block`) detections are UNCHANGED and age-independent — only the never-claimed branch
  is newly age-gated. `list --stuck` now prints the active threshold (e.g. `(threshold 24h)`).
  This issue's own future narrowing (cause-attribution/sidecar enrichment) supersedes #219's AC-1
  ("bare `--stuck` behaves as today") with this rationale.

---

## [0.28.0] — 2026-07-19

### Added

- **Declaration-gated in-place timeout-retry with a clipping total-time cap (issue #140).**
  `retry.on_timeout: true` opts a step into retrying its own `STEP_TIMEOUT` in place, consuming a
  normal retry attempt — legal ONLY when the step also declares `idempotent: true` (a hard error
  at load otherwise, `on_timeout` requires `idempotent`; the engine independently re-checks the
  same conjunct at dispatch time as a programmatic-gate advisory for hand-built definitions that
  bypass the loader). This is a STRONGER attestation than `idempotent`'s existing sequential-reapply
  guarantee: a timeout-retry can run concurrently with the still-in-flight original attempt (the
  aborted transport request may still be executing remotely), so `on_timeout` declares that any
  number of concurrent executions — including a partial prior application (a committed prefix) —
  are harmless. `retry.total_timeout_seconds` (standalone-legal, does not require `on_timeout`)
  bounds the total wall-clock across every attempt (Temporal-`ScheduleToClose`-style); when the cap
  is reached mid-schedule, the step settles as `STEP_RETRY_EXHAUSTED` with a structured
  `exhausted_by: 'total_timeout'` (vs. `'attempts'`) discriminator, both in the dispatch-failure
  envelope's `error_details` and on the final attempt's evidence snapshot (durable even on the
  issue #134 recoverable-incapability settle path, which never wraps the error). Per-attempt
  evidence gains `effective_timeout_seconds` (now per-attempt, not step-wide) and `clipped_to_ms`
  (present on any attempt whose bound was reduced by the cap). New exported helpers
  `resolveCapMs`/`worstCaseScheduleSeconds` (core); the latter is now the single formula shared by
  the engine's cap and the claim-liveness horizon (`computeClaimDeadline`), so the two can never
  independently drift apart. New loader diagnostics: `UNKNOWN_RETRY_KEY` (unrecognized `retry:`
  key), `ON_TIMEOUT_SINGLE_ATTEMPT` (`on_timeout` with an effective `max_attempts` of 1),
  `TOTAL_TIMEOUT_BELOW_ATTEMPT` (a declared cap that can never cover even a single attempt),
  `TOTAL_TIMEOUT_NON_AUTO` (the cap is inert off `execution: 'auto'` dispatch). Semver: minor-additive.

### Changed

- **AMENDED default (issue #140):** a retry-configured `execution: 'auto'` step with no explicit
  `retry.total_timeout_seconds` is now DEFAULT-CAPPED at the shared worst-case-schedule formula
  (`max_attempts × the step's own per-attempt timeout + the declared backoffs between attempts`) —
  the same formula the claim-reclaim horizon already used. The default cap equals the step's own
  declared schedule, so the horizon number is unchanged **for the default-cap population**, and
  the cap binds only when a runtime wait (a rate-limit `retry_after`) pushes an attempt's actual
  wall-clock MATERIALLY past that declared schedule. A step declaring an EXPLICIT
  `retry.total_timeout_seconds` instead widens the horizon to `cap + margin` (record §3) — so a
  legitimate long-wait opt-in is never mislabeled `claim_stale` mid-sleep. **This is a deliberate,
  disclosed behavior change:** a retry-configured step whose runtime waits exceed its own declared
  schedule now settles as an honest `STEP_RETRY_EXHAUSTED (exhausted_by: 'total_timeout')` instead
  of sleeping past its claim horizon — closing the silent-duplicate hazard where a
  `claim_stale`-labeled, still-legitimately-sleeping step could become eligible for a premature
  `realm run reclaim --all --force` re-drive.
- The `idempotent` step hint now documents (and the loader's `IDEMPOTENT_INERT_IN_FINALIZER`
  warning now states, variant-aware on whether `retry.on_timeout` is also declared) that it gates
  TWO separate opt-in mechanisms — the pre-existing bounded-time auto-reclaim allow-list (inert in
  a finalizer-bearing workflow) and, since #140, `retry.on_timeout`'s concurrency-safety gate
  (live in every workflow, finalizer-bearing or not).
- The zombie-stacking caveat (an abandoned, abort-ignoring handler call left running behind a
  retried attempt) is sharpened: a synchronous handler can never stack one (it monopolizes the
  event loop); an asynchronous handler that ignores its abort signal can stack up to
  `max_attempts − 1` behind the currently-live attempt — now reachable from `on_timeout` alone,
  not only from a normal retryable error racing a slow-but-not-yet-timed-out prior attempt. The
  zombie count stays cap-bounded (the total-time cap bounds the ENGINE's own retry loop; it
  cannot reach into a remote server still processing an already-abandoned request).
- The agent protocol's `wait_and_proceed` prose (`generator.ts`) now notes `STEP_RETRY_EXHAUSTED`
  surfaces "on exhaustion of attempts or total-time budget" (was "on exhaustion").
- `RETRY_NO_TIMEOUT`'s advisory text now also names the compounding total-time-budget exposure
  (previously described only the per-attempt bound).

### Fixed

- Runtime `retry_after` sleeps are now bounded for every retry-configured `execution: 'auto'` step
  (default cap = the declared worst-case schedule; an explicit `retry.total_timeout_seconds`
  overrides it) — previously, an uncapped retry-configured step could sleep an arbitrarily long
  rate-limit `retry_after` well past its own claim-liveness horizon. The `claim-liveness.ts`
  `computeClaimDeadline` JSDoc's prior "does not attempt to model `retry_after`" caveat is retired
  accordingly — runtime enforcement now tracks the same declared-schedule assumption the detection
  horizon always used.

---

## [0.27.0] — 2026-07-18

### Added

- **`TraceBufferStore`'s fenced trio (issue #207, PR-1 of 2).** Three new OPTIONAL methods —
  `appendFenced`, `deleteFenced`, `deleteAllForRunFenced` — let a store fence a write or delete
  against a caller-supplied guard that re-verifies its premise inside the same critical section the
  destructive effect uses, closing the race where an unconditional `delete()` could destroy trace
  data a concurrent `append()` just committed. Declaring any one of the three requires declaring
  all three; declaring the trio also commits the store's legacy `read()`/`delete()`/
  `deleteAllForRun()` to serialize on the same per-(runId, stepId) critical sections. Both in-repo
  stores (`JsonTraceBufferStore`, `InMemoryTraceBufferStore`) now declare the trio — dormant until
  a consumer adopts it (this PR touches no call site; see #207 PR-2 for that). A new exported core
  helper, `isStepSettledOrInFlight`, centralizes four inlined four-array membership checks into one
  chokepoint (all four already covered `skipped_steps` correctly — no behavior change at these
  sites; the separate, latent `skipped_steps` omission in `append_trace`'s own eligibility check is
  closed in PR-2, when that tool adopts the helper). A new framework-agnostic
  conformance TCK (`@sensigo/realm-testing`'s `fencedTraceBufferContract`) forces any fenced-trio
  store to prove `STRUCTURAL`/`FENCE_REFUSES`/`CS_OCCUPANCY`/`PER_KEY_INDEPENDENCE`/
  `NO_SILENT_LOSS` — a store enforcing the fence via a transaction-scoped SQL predicate instead of
  an in-process critical section produces an explicit, visible documented-skip for the three
  latch-based laws rather than a silent omission (that store's own in-transaction suite must verify
  race closure — mirroring `CLAIM_SINGLE_OWNER`'s own cross-host caveat, issue #188). Semver:
  minor-additive.
- **Envelope advisory on unfenced trace stores (issue #207, PR-2 of 2).** `append_trace` warns
  (deduped per store-constructor-name, plus a `warnings` entry on every affected response) when
  the configured `traceBufferStore` does not declare the fenced trio — appended entries are not
  fenced against a concurrent settlement and may end up neither adopted nor refused. Auto-clears
  once the store declares the trio.
- **`append_trace` capacity early-warning (issue #208).** Responses now carry an advisory
  `warnings` entry once the step's trace buffer crosses 80% of either ceiling (entry count or
  bytes, whichever is closer to its own limit) — actionable before the buffer hits `BUFFER_FULL`
  outright. Purely advisory (never gates, never changes `status`) and store-agnostic (reads only
  `AppendResult`'s already-returned fields; works identically regardless of which
  `TraceBufferStore` implementation is injected).
- **`TraceBufferStore` capability ladder + sealed-WAL preservation + writer-nonce carriage (issue
  #197, PR-1 of 2 — store layer only, behaviorally INERT in production until PR-2 wires it into any
  call site).** Two new OPTIONAL, independently-declarable capability-ladder rungs a fenced-trio
  store may additionally implement — `traceCapabilities?: ReadonlySet<'seal' | 'writer_nonce_carriage'>`
  — with one authoritative predicate module (`storeDeclaresSeal`, `storeDeclaresNonceCarriage`,
  `validateTraceCapabilities`) as the only way any caller may check them: `writer_nonce_carriage`
  requires `seal` requires the fenced trio; the trio alone stays fully legal (undeclared is always
  the honest floor, never an error). `sealFenced(runId, stepId, guard)` atomically retires a live
  WAL to a new sealed artifact under the SAME per-key critical section the fenced trio uses — a
  no-clobber `link`-then-`unlink` move (never `rename`, which would silently overwrite), bytes moved
  verbatim, bounded by a new `SEALED_ARTIFACTS_LIMIT_PER_STEP` (falls back to the existing
  destructive drain on cap); `listSealedForRun(runId)` reads them back. `append`/`appendFenced` grow
  a trailing `options?: {writerNonce?: string}` — an opaque, client-minted writer identity carried
  through to `read()`'s already-existing `BufferedEntry._nonce` (never fabricated for a genuinely
  bare line). New per-WRITER budget enforcement (today's `BUFFER_LIMIT_COUNT`/`BUFFER_LIMIT_BYTES`,
  values unchanged, now documented as per-writer) alongside a new, additive whole-FILE backstop
  (`BUFFER_BACKSTOP_COUNT`/`BUFFER_BACKSTOP_BYTES`, 2×) — a `BUFFER_FULL` refusal's `details` now
  carries a structured `scope`/`binding_dimension`/count+bytes triples/file-scope occupancy
  evidence shape. **Compat law: for all-bare traffic every existing `AppendResult` field is
  numerically byte-identical to before this capability existed** (the file backstop is
  arithmetically unreachable with a single writer — emergent, not special-cased); new `file_*`
  fields are additive-only. Both in-repo stores (`JsonTraceBufferStore`, `InMemoryTraceBufferStore`)
  now declare both rungs. The fenced-trio conformance TCK (`@sensigo/realm-testing`) grows five new
  laws (`CARRIAGE_ROUND_TRIP`, `SEAL`, `SEAL_BUDGET`, `PER_WRITER_BUDGET`, `VERBATIM`), each
  producing an explicit, visible documented-skip for a store that doesn't declare the relevant
  rung — never a silent omission (mirroring the existing `fenceForm: 'native-predicate'` skip
  precedent). **Nothing in this PR mints or reads a nonce at any real call site, and no engine/
  MCP-tool/CLI behavior changes** — that adoption is PR-2.
- **Attributed adoption: the writer-nonce ladder wired everywhere (issue #197, PR-2 of 2 — the
  adoption this program exists for).** `append_trace` and `execute_step` gain an optional
  `writer_nonce` argument (opaque, client-minted, 1–128 chars, no leading/trailing whitespace —
  every shape violation routes through one typed `VALIDATION_EMPTY_VALUE` refusal, never a bare
  zod/SDK error). A new core module, `trace-adoption.ts`, exports the ONE authoritative predicate
  (`adoptsLine`/`partitionBufferedEntries`: `adopted(line) ⇔ line.nonce ≡ claimant.nonce, absent ≡
absent`) — used identically by the pre-claim `trace_schema` enforce-gate and the post-claim
  adoption split (ADOPTION_CONGRUENCE: a foreign-nonce-only WAL can never gate a nonced claimant).
  The claimant's nonce is honored ONLY when the configured `traceBufferStore` declares
  `writer_nonce_carriage` (the activation gate) — on a lesser store it is IGNORED entirely (the
  honest #185 adopt-all floor) plus a loud advisory naming the missing leg. Three-way honest split
  on `trace_summary`: `buffered_lines_adopted` (⊥-adopted, existing caveat, narrowed to bare-only —
  numerically unchanged for all-bare traffic), new `attributed_lines_adopted` (own-nonce adopted,
  NO caveat — "writer continuity verified, strength conditional on nonce secrecy", never "faithful"),
  new `foreign_lines_preserved` (a different writer's lines, preserved not adopted, with a pointer
  to `realm run export` — foreign nonce VALUES never appear in any warning/envelope). Mirrored as
  additive `adopted_own`/`adopted_anonymous`/`preserved_foreign` on the `execute_step`
  `ResponseEnvelope`, set by the engine (the MCP layer never sees per-line nonces); a half-minted
  advisory fires when a nonced claimant finds only bare lines, or a bare claimant finds every
  foreign line under one shared nonce (signature heuristics — no same-attempt rescue, ever).
  `append_trace` gains a downgrade-detector marker, `writer_nonce_applied: true`, present only when
  a nonce was both supplied and actually carried. At settle time (success and failure), a step
  whose post-claim read found foreign lines now SEALS the WAL (via PR-1's `sealFenced`) instead of
  destroying it, on any seal-declaring store — `preserved_foreign === 0` (the common case, and the
  only case on a non-seal store) keeps today's plain `delete()`, byte-identical; the run record
  carries detection counts only, never the seal outcome (that rides the envelope warning only).
  Reclaim now preserves too: on a seal-declaring store, both fenced call sites `sealFenced` the
  ENTIRE stale WAL (zero-cooperation, no partitioning) instead of draining it, with the existing
  version fence unchanged; a non-seal (trio-only) store keeps the #207 destructive drain, byte-frozen.
  `realm run`/`realm agent` gain `--mint-writer-nonce` (mints a fresh UUIDv4 per step-attempt; no
  caller-fixed value is ever accepted). `realm run export`'s bundle bumps to
  `realm_export_version: 3`, adding `sealed: Record<stepId, SealedArtifact[]> | null` (`null` =
  the store doesn't declare `seal`; `{}` = declares it but this run has none) via the new
  `listSealedForRun`; a non-terminal export redacts every `nonce` value belonging to a step
  currently in `in_progress_steps` with a fixed `"[redacted-live-claim]"` marker (claims never
  persist their own nonce, so this stateless step-liveness proxy is the only disclosure control
  available — terminal exports are always verbatim). `purge`/`gc` needed NO code changes — PR-1
  already routed sealed artifacts through `deleteAllForRun`/`listOrphans`; verified with new tests,
  not just trusted. A new dormant strict posture, `REALM_REQUIRE_WRITER_NONCE` (env, read per call,
  default off), refuses a bare agent-step call on `append_trace`/`execute_step` and force-enables
  CLI minting when set — zero behavior change while unset. `get_workflow_protocol` gains one
  affordance line teaching cooperating agents to mint a nonce (opt-in, mirroring `append_trace`'s
  own posture). **Zero-cooperation byte-identity holds for all-bare traffic through every changed
  path** (modulo additive fields appearing only when a nonce was provided) — the sole deliberate
  carve-out is reclaim, which now seals rather than drains an all-bare WAL on a seal-declaring
  store (preserve-ALL is the point, not a violation).

### Changed

- **The fenced trio is now adopted everywhere (issue #207, PR-2 of 2 — closes the race PR-1's
  interface made possible).** `append_trace`'s refusal taxonomy (`details.step_state` ∈
  `{completed, failed, skipped, in_progress, run_terminal, run_not_found}`) replaces the old
  lumped `already_claimed` value; the `in_progress` refusal's `agentAction` is now
  `resolve_precondition` (was `report_to_user` — the same state must never yield two different
  agent actions elsewhere, mirroring `claimStep`'s own `STATE_STEP_ALREADY_CLAIMED` precedent);
  a `skipped` step now correctly refuses too (the latent omission #207 identified — previously a
  skipped step could still accept a trace append). `execute_step`'s trace-store read failures now
  return a typed, retryable `ENGINE_STORE_FAILED` envelope instead of throwing uncaught: a
  pre-claim read failure consumes no claim; a post-claim read failure performs a compensating
  un-claim (built from the engine's own claim record, CAS'd against its version — a concurrent
  actor that already resolved the claim is never stomped). `reclaim`'s WAL clear now moves BEFORE
  the un-claiming update on a declaring store, version-fenced against the reclaim decision
  (skips and warns, buffer left intact, if the run changed since); it warns with the destroyed
  entry count when it proceeds (the #198 delta — previously silent). `purge` maps a busy/resumed
  run's WAL delete to its existing `blocked` bucket (extends #184's terminal-re-verify to the WAL
  artifact layer); `gc`'s orphan-artifact sweep re-verifies run absence at destruction time,
  routing a `save()`-re-import race to a new, exit-code-neutral `resurrected` bucket rather than
  reaping a file that is no longer actually orphaned.

### Fixed

- **CLI executors (`realm run`, `realm agent`) now adopt streamed WAL trace (issue #207, PR-2 of
  2).** Both constructed no `traceBufferStore` at all — an agent step's `append_trace` calls
  under a CLI-driven run were silently neither adopted nor refused. An `execute_step` success
  settlement's own WAL-cleanup failure (e.g. lock contention) no longer produces an error envelope
  on an already-durably-completed step — it degrades to a warning, as the equivalent failure
  cleanup on the failure-settle path already did.

---

## [0.26.0] — 2026-07-16

### Added

- **The `RunStore` contract now declares field fidelity (issue #188).** A store declares (via optional `persistedRunRecordFields`, fail-closed default) which load-bearing `RunRecord` fields it round-trips; the engine surfaces an honest diagnostic — instead of silently misreading a dropped field as legitimate absence — when a store doesn't persist a field it depends on (`capability_blocks` → capability-block state unavailable; `workflow_context_snapshots` → snapshot history not durable; `extension_identity` → drift detection unavailable). A framework-agnostic conformance TCK (`@sensigo/realm-testing`) forces any store to prove its declared fidelity is honest (a store that claims to persist a field but drops it fails conformance) and asserts `claimStep`'s single-owner guarantee. `JsonFileStore` declares the full set → zero behavior change locally. Prerequisite-hardening for pluggable/cloud run stores; the `claimStep` doc now states the cross-host single-owner obligation. (Partitioned artifact-reachability enforcement in purge/gc/export is tracked separately as #188 PR-3.)

### Changed

- **`append_trace` now rejects a terminal run (issue #187).** A late `append_trace` to a `completed`/`failed`/`abandoned`/`aborted` run returns a typed error (`report_to_user`) instead of writing unreadable WAL residue — closing the one orphan source correct purge ordering cannot reach (a WAL born after purge's snapshot).
- **The MCP server's `runStore` option now accepts any `RunStore` implementation (issue #188, PR-1 — internal/API-surface, non-breaking).** Was concrete `JsonFileStore`-only, which meant a Postgres/cloud-backed run store could neither satisfy the option type nor be injected at all. Artifact stores (the trace buffer, the failed-attempt sidecar) can now also be injected as objects, for backends that don't co-locate artifacts on the filesystem — with an explicit co-location contract (documented on `RealmMcpServerOptions`): inject BOTH artifact stores together (co-located with the run store's own domain), or use a `JsonFileStore` run store and let both be derived exactly as before. The local default is unchanged and byte-identical; a run store without a derivable path and no injected artifact stores now fails loudly at construction instead of silently losing every trace. Prerequisite for pluggable/cloud run stores — does not itself add any capability flags or gates (that is PR-2).

### Fixed

- **`realm run reclaim` now clears the reclaimed step's stale trace buffer (issue #198).** The `clearStaleWal` hook was inert (the CLI never passed a trace-buffer store); wiring it means a re-driven step starts from a clean buffer instead of inheriting a dead attempt's lines, and a failed clear now warns loudly instead of being silently swallowed (the #183 contract). Reduces how often #185's "may include a prior/concurrent writer" caveat fires.

---

## [0.25.0] — 2026-07-15

### Added

- **`EvidenceSnapshot.trace_summary.buffered_lines_adopted` (issue #185).** An optional count, present only when > 0, recording how many buffer/WAL lines a claiming execution adopted into its canonical trace — an honest signal that the trace may include observations from a prior or concurrent writer (the agent trace buffer has no single owner). Faithful per-writer separation via an optional client-supplied nonce is tracked as a follow-up (#197).

### Fixed

- **The agent trace buffer is no longer ownerless (issue #185).** A claiming execution's canonical trace now (1) always preserves the execution's own conclusion instead of letting older buffered lines truncate it out, (2) captures every buffered line present at settlement (closing a race that silently dropped a concurrently-appended line), and (3) carries an honest `trace_summary` caveat when it adopted buffered lines that may originate from a prior or concurrent writer — the engine no longer folds unattributable observations into a step's evidence while asserting single authorship. Faithful per-writer separation via an optional client-supplied nonce is tracked as a follow-up.

---

## [0.24.0] — 2026-07-15

### Added

- **`realm run gc` now also reaps run-less orphaned trace-buffer WAL and failed-attempt sidecar files (issue #163).** These are artifacts whose run record no longer exists — residue from a pre-#183/#184 purge or a manual `rm`, since `append_trace` always creates a run's record before its first WAL entry, so a live run's WAL/sidecar can never itself be run-less. Age-floored and dry-run-default, exactly like the existing atomic-write-temp sweep, and reported in a separate section alongside it. Fail-closed by construction: if the live-run-id enumeration fails for any reason (permissions, a torn mount), the orphan sweep aborts loudly and reaps nothing, rather than risk treating every live run's artifacts as orphaned. `.lock` directory reaping remains tracked separately (issue #164) — and `realm run gc` now exits non-zero when a sweep cannot complete (a failed reap, or an orphan-sweep enumeration failure that aborts it), matching `realm run purge`'s honest exit code, so a cron on a broken `runsDir` no longer reads success.

### Fixed

- **The store layer no longer conflates absence, unreachability, and corruption (issue #183).** `deleteAllForRun` (on `JsonFileStore`, `FailedAttemptStore`, and `JsonTraceBufferStore`), the run/pointer/WAL reads, and the WAL directory listing now treat only `ENOENT` as "not there" — idempotent, never an error. Any OTHER I/O errno (permissions, a read-only filesystem, a torn mount, disk failure) now THROWS a typed `ENGINE_ARTIFACT_DELETE_FAILED` error naming the failing artifact, instead of being silently swallowed and reported as success. This closes the `realm run purge` false-attestation bug: previously, if an artifact genuinely could not be deleted, `purge` would still report it as `purged` — the safety story `purge --force` (an irreversible, operator-invoked deletion) depends on now actually holds. Parse/JSON corruption (a torn WAL line, a garbage idempotency-key pointer) is unaffected by this change in one direction and improved in another: it still recovers (per-line skip, or self-healing to "absent") rather than throwing — but recovery is no longer silent, emitting a structured warning so an operator or log consumer can see it happened. A crash mid-write to a trace-buffer WAL file no longer discards the entire buffer — only the one torn line is skipped, and every entry recorded before the crash is preserved.
- **`realm run purge` no longer reports success while data remains, and can no longer destroy a run being resumed (issue #184).** `JsonFileStore.deleteAllForRun` now takes the same run-file lock `update()`/`claimStep()` already use and RE-VERIFIES the run is still terminal _under that lock_ — closing a real race where a concurrent `realm resume` could flip a run back to live between purge's selection and its actual delete, previously letting purge resurrect a live run with its WAL/sidecar/pointer already gone while still reporting `purged`. The idempotency-key pointer delete is now similarly key-locked, closing a second race where a concurrent supersede could repoint the key to a live successor between the read and the unlink. A run purge can't currently proceed for either of these reasons (a lock held by another writer, or a run no longer terminal) is now reported as `blocked`, not `failed` — neither halts a batch nor fails the command's exit code, since both self-heal (a live writer releases its lock; a stale lock is eventually stolen). The crash-anchor guarantee (the run record survives any earlier failure, so a crashed purge is always retried) is now enforced structurally by `purgeRuns`'s own control flow — the run file is deleted only after every other artifact store has succeeded — rather than by an array-ordering convention a future edit could silently break. Also fixed: the `bytes freed` total in `purge --force`'s report now counts only runs that were _actually_ purged, instead of summing every selected candidate regardless of outcome. **Operational note:** a purge cron that silently exited 0 on a broken `runsDir` will now exit 1 instead — that means it was quietly leaking artifacts; the error message names the file to fix. **Note:** an interrupted purge (the process killed mid-run, before it can release its lock) can now leave a `<runId>.json.lock` directory behind next to the run file — a clean, successful purge does not (its lock is released normally). `realm run gc` does not yet reap these; the companion issue #164 does, and ships in the same release as this fix.
- **`realm run export` now emits a self-describing bundle instead of all-or-nothing (issue #186).** `realm_export_version: 2` adds `complete: boolean` and `artifact_errors: Array<{ artifact, code, message }>`: an unreadable failed-attempt sidecar or WAL (a real I/O error, post-#183 — a genuine absence still yields an empty `[]`/`{}` and `complete: true`) no longer strands the operator with nothing. The run record and every readable artifact are still written to the bundle, `complete` is set to `false`, `artifact_errors` names which artifact failed and why, and the command prints an `⚠ INCOMPLETE export` warning and exits non-zero — the bundle is never withheld, only honestly marked. Only a genuinely unreadable run record (there is truly nothing to hand off) still produces no bundle at all. There is no `--allow-incomplete` flag: honesty is not opt-in. A `realm_export_version: 1` bundle predates these fields — its completeness is unknown to a reader.

---

## [0.23.0] — 2026-07-14

### Added

- **Structured loader-warning channel (issue #169).** The YAML loader's warnings — an unknown workflow/step key, an idempotent-but-inert flag, dual schema declarations — are now typed, code-tagged data (`LoaderWarning { code, severity, message, scope, key?, did_you_mean? }`) resolved through a code→severity policy, instead of fire-and-forget `console.warn`. This is what powers `--strict`, agent-facing diagnostics, and (as a tracked follow-up, issue #170) a future hard-reject expressed as a single, already-wired policy flip.
- **New public exports from `@sensigo/realm` (additive — nothing removed or changed).** `loadWorkflowFromFileWithDiagnostics` / `loadWorkflowFromStringWithDiagnostics` return `{ definition, warnings }` and print nothing, for callers that want to surface warnings themselves. Also exported: the diagnostics module itself — `DEFAULT_POLICY`, `resolveSeverity`, `findUnknownKeys`, `renderLoaderWarning`, and the `WarningCode` / `LoaderWarning` types. **Non-breaking guarantee:** `loadWorkflowFromFile` / `loadWorkflowFromString` keep their exact signatures and default `console.warn` behavior — existing callers need no change.
- **`realm workflow validate --strict` and `realm workflow register --strict` (issue #169).** Exit non-zero when any loader warning is present (unknown keys, a retry-without-timeout advisory, a sentinel-credential fallback); `register --strict` additionally refuses to persist the workflow. Opt-in CI enforcement — default (non-strict) behavior is unchanged: warnings still print, the command still succeeds.
- **"Did you mean…" suggestions on unknown keys (issue #169).** A close typo now gets a targeted suggestion — e.g. a mistyped `dependson` prints `⚠ step 'x': unknown key 'dependson' — ignored (did you mean 'depends_on'?)` — instead of just "ignored." Helps humans fix workflow YAML faster and lets an authoring agent self-correct.
- **Agent-facing structured diagnostics on `create_workflow` (issue #169).** The response envelope gains an additive `diagnostics?: LoaderWarning[]` field alongside the unchanged `warnings: string[]` — an authoring agent can now branch on `code`/`key`/`did_you_mean` instead of parsing warning text. An unrecognized step key is still only ever dropped and warned, never rejected; the workflow is created either way.

### Changed

- The YAML loader's internal parser is now pure — warnings are collected as data and handed to the caller, which decides whether to print them (the default, byte-identical behavior) or surface them structurally instead. No observable behavior change for existing callers.

### Fixed

- **An empty or whitespace-only `protocol.quick_start` no longer wipes the agent protocol's generated quick-start default (issue #178).** Whether authored directly in workflow YAML (`protocol: { quick_start: "" }`) or submitted via `create_workflow`'s `metadata.task_description: ""`, a blank value is now treated as absent instead of silently blanking the imperative "how to begin" instruction the driving agent reads from `get_workflow_protocol`. A genuinely non-empty value (including one with incidental surrounding whitespace around real content) is still used verbatim, unchanged.

---

## [0.22.0] — 2026-07-13

### Added

- **Workflow-level `description` is now a first-class field (issue #144 correction).** `#09-webhook-pr-review`'s example workflow already carried a top-level `description:` that `WorkflowDefinition` silently ignored — exactly the latent no-op the #144 unknown-key warning exists to expose. `description` is a clean, declarative complement to `protocol.quick_start` (what this workflow is for / when to use it, vs. imperative how-to-begin) — the two are never blurred, and there is **no synthesized default**: present → surfaced, absent → omitted, never fabricated. It's authorable in workflow YAML, drives the agent protocol (`get_workflow_protocol`), is settable via `create_workflow`'s `metadata.description`, and is echoed by `realm workflow validate`/`register`.

### Changed

- **`realm init` scaffold now sequences its two steps with `depends_on` (issue #144).** The generated `workflow.yaml` previously set `finalize`'s `execution: auto` with no `depends_on`, so it was eligible from run start and ran concurrently with `step_one` instead of after it — the scaffold's own steps didn't actually demonstrate sequencing. `finalize` is renamed to `step_two` and declares `depends_on: [step_one]`; the scaffold also drops the vestigial `initial_state`/`allowed_from_states`/`produces_state` fields (leftovers of an early scalar state-machine model removed when the DAG execution model — `depends_on` + the four step-sets — replaced it) and gains a comment blessing `depends_on` as the one sequencing model.

### Fixed

- **The YAML loader now warns on an unknown workflow or step key instead of silently dropping it (issue #144).** Previously any misspelled or vestigial field (e.g. a leftover `allowed_from_states`) was accepted and ignored with no signal to the author. Two new allow-lists (`KNOWN_WORKFLOW_KEYS`, `KNOWN_STEP_KEYS`) plus a compile-time drift guard against `WorkflowDefinition`/`StepDefinition` back this — a key not on the applicable list now prints `⚠ workflow '<id>': unknown key '<key>' — ignored (...)` or `⚠ step '<name>': unknown key '<key>' — ignored (...)` via the existing load-warning `console.warn` channel. Hand-authoring a runtime-only field (`schema_version`, `model`, etc.) also warns, since the loader silently overwrites it regardless. Non-breaking: still a warning, not a rejection — a hard-reject at the next major version is tracked separately (issue #170), as is a structured warnings channel / `--strict` (issue #169).

---

## [0.21.0] — 2026-07-12

### Added

- **Evidence export — `realm run export <run-id> [--out <path>]` (issue #159).** The read-only, evidence-preserving companion to `realm run purge`: archives a run's record, its failed-attempt sidecar, and any orphaned/in-flight WAL traces into one self-contained, human-readable JSON bundle (`{ realm_export_version, exported_at, run, attempts, attempts_capped, wal }`) — no tar/zip dependency. `attempts_capped` mirrors the sidecar's own truncation signal: `true` means the failed-attempt log hit its 256KB ceiling and later attempts were dropped at write time, so `attempts` is a prefix, not exhaustive — surfaced both in the bundle and as a warning printed at export time. Works on **any** run, not just terminal ones — exporting a non-terminal run prints a best-effort-snapshot warning (its artifacts are read at slightly different instants and may be mid-flight) but still produces the bundle, since export's highest-value use is handing off a _stuck_ run for debugging. Read-only and lock-free by construction: assembles the bundle purely from each store's existing public read methods, never writes into `runsDir`, never deletes anything, and refuses to overwrite an existing file at the resolved `--out` target. Deliberately excludes the idempotency-key pointer file (`keys/<hash>.json`) — a rebuildable index, not evidence; the key itself is already on the run record. CLI-only for v1, consistent with the `cleanup`/`purge`/`gc` operator family. Backed by a new `TraceBufferStore.readAllForRun(runId)` read-all method (implemented by `JsonTraceBufferStore` and `InMemoryTraceBufferStore`), torn-line-safe per WAL file. See [docs/reference/operating-runs.md](docs/reference/operating-runs.md#exporting-a-runs-evidence).

## [0.20.0] — 2026-07-12

### Added

- **Orphaned atomic-write temp sweep — `realm run gc` (issue #160, Phase 1).** The shared atomic-write primitive (`atomicWriteFile`, used for run records and idempotency-key pointers) writes a unique `.tmp` sibling then renames it over the target; a process dying mid-write orphans that temp permanently — and, for a key-pointer temp (`keys/<hash>.json.<pid>.*.tmp`), it isn't runId-keyed at all, so `realm run purge` can never reach it. `realm run gc --older-than <dur> [--force]` is a new, **CLI-only**, **dry-run-by-default** sweep that reaps them: top-level `runsDir/*.tmp` plus one level into `runsDir/keys/*.tmp`. `--older-than` has **no default** (omitting it is an error) and a **1-hour floor** enforced inside the pure `sweepOrphans` function itself, so no caller can reach a delete below it. Per-candidate handling is `lstat`-typed and conservative: a symlink is never unlinked or followed; a `*.tmp` that turns out to be a directory (or other non-regular entry) is reported as a loud failure, never silently swallowed; a benign vanish (ENOENT, e.g. a concurrent sweep) is bucketed `already_gone`, never `failed`; a future mtime is skipped. Reaping a `.tmp` is unconditionally safe by construction — an interrupted `rename` on an unlinked temp only ever produces a spurious write error, never a torn target file. The report always names the residue classes `gc` deliberately does **not** reap — orphaned `.lock` dirs (deferred, issue #164) and run-less `trace-buffer-*.jsonl` WAL files (issue #163) — so their presence isn't mistaken for a bug. A documented no-op on Windows (`atomicWriteFile` never produces a temp there). `cleanup`/`purge`/`gc` are now the three hygiene verbs under `realm run`. See [docs/reference/operating-runs.md](docs/reference/operating-runs.md#garbage-collection-orphaned-atomic-write-temps).

## [0.19.0] — 2026-07-12

### Added

- **Operator run-purge — `realm run purge` (issue #107).** Realm had no run-deletion primitive: `cleanup`/`abandon` only mark a run terminal, so a terminal run's on-disk artifacts (`<id>.json`, its idempotency-key pointer, `<id>.attempts.jsonl`, orphaned `trace-buffer-<id>-*.jsonl` WAL files) accumulated forever. `realm run purge [<id>] [--older-than <dur>] [--workflow <id>] [--force]` is a new, **CLI-only** (never an MCP tool), **dry-run-by-default**, **terminal-only** deletion of a run and every co-located artifact. Never deletes a non-terminal or `gate_waiting` run. Claim-state handling is mode-aware: a future-deadline (`healthy`) claim is never purged in either mode (no override — a runner is provably still live); an indeterminate-age (`claim_unknown_age`, no deadline recorded) claim — load-bearing for `abandoned` runs, which do not clear `claims` — is skipped with a warning in a batch/`--older-than` sweep, but purgeable via an explicit single-run `--force` naming that exact run. Batch mode reports continue-on-error as `{ purged, already_purged, failed }` (a concurrent double-purge is `already_purged`, never `failed`) plus a resumable-run count, since purging a `failed`/`abandoned` run destroys its `realm resume` path permanently. Backed by a new `PerRunArtifactStore` marker interface (`deleteAllForRun(runId, dirEntries?)`) that `JsonFileStore`, `FailedAttemptStore`, and `JsonTraceBufferStore` each implement for their own artifacts only — the `RunStore` interface itself is unchanged; a Postgres store will implement the marker orthogonally. Age-only in v1 (size/count retention selectors are a deferred fast-follow). See [docs/reference/operating-runs.md](docs/reference/operating-runs.md#purging-runs-permanent-deletion).
- **`JsonTraceBufferStore` is now exported from `@sensigo/realm-mcp`** (public-API widening, issue #107) — needed by the `realm run purge` CLI command to construct the trace-buffer artifact store directly.

## [0.18.0] — 2026-07-11

### Added

- **`when`-driven and cascade step skips are now observable (issue #111).** Runs record a `skip_details` map explaining every skipped step — a false `when` (with the expression, each leaf, and its resolved value, so a field-name typo that silently resolved to `undefined` is now visible), an unsatisfiable `trigger_rule` (the rule + the blocking deps), or a handler/guard abort. Surfaced via `get_run_state` and `realm inspect`. Additive and back-compatible: `skipped_steps` is unchanged, legacy runs read fine, and a false `when` still completes the run (observability, not a new failure).

### Fixed

- **`depends_on` cycles are now rejected at load time (issue #153).** A transitive `depends_on` cycle (`a → b → a`, or longer) previously loaded successfully — the loader validated dependencies only one hop at a time, with no graph traversal. At runtime the cyclic steps were mutually ineligible forever, and once the acyclic steps finished, the run silently sealed `completed` with the stranded steps in no step set and zero evidence — a silent-wrong-completion bug. `realm workflow validate` (and every workflow-loading command) now fails loud with a clear error naming the participating steps, before a run is ever created. Detection-only — no runtime, eligibility, or seal behavior changed.
- **Precondition and guard `resolved_value`s are now bounded and scrubbed like every other durable evidence value (issue #154).** `precondition_trace[].resolved_value` and guard `abort_unless` results (surfaced in `aborted_at.conditions` and a passing guard's recorded evidence) previously stored the raw comparison operand verbatim — a large or PII-bearing value landed unbounded in the durable, inspectable run record. Both now route through the same `boundResolvedValue` helper #111 introduced for the `when`-skip trace: oversized strings/objects are capped at 500 characters, emails are scrubbed to `[REDACTED_EMAIL]`, and scalars (numbers, booleans, `null`) pass through byte-unchanged. Consistency hardening only — no verdict, resolution-error, or pass/abort behavior changed.

## [0.17.0] — 2026-07-11

### Added

- **`GorgiasAdapter` list results now include `has_more`.** `list_tickets`/`list_customers` responses carry a derived `has_more` boolean (from `meta.next_cursor`) alongside the raw `data`/`meta`, so callers can detect further pages without hand-parsing the cursor.

### Changed

- **`GorgiasAdapter` list ops reject a non-scalar filter param.** Passing an array/object as a `list_tickets`/`list_customers` query param was silently dropped (a silently-lost filter → over-broad results); it now throws `ADAPTER_VALIDATION_FAILED`. `null`/`undefined` still omit the param.

### Fixed

- **`GorgiasAdapter` surfaces a redirect on a write.** A 301/302 on a `POST`/`PUT` could silently downgrade the method to GET; write ops now refuse an unexpected redirect loudly. GET ops still follow redirects (unchanged).
- **Atomic writes now cover the workflow registry (issue #130).** `registrar` (`register()`) and the `migrate` command wrote the registry with non-atomic `writeFileSync` (truncate-then-write), so a concurrent unlocked reader (`get`/`list`/`loadWorkflow`) could tear-read a half-written registry file — the same class as the v0.16.0 run-store fix, for `~/.realm/workflows/`. Both now write via the shared `atomicWriteFile` (unique temp + POSIX `rename`; win32 passthrough), extracted to `store/atomic-write.ts` and covered by a structural anti-recurrence guard.
- **`JsonFileStore.save()` now holds the file-path lock (issue #131).** `save()` was the only run writer not acquiring the `proper-lockfile` per-path lock that `update()`/`claimStep()` hold; its create-if-absent contract made a lost-update unreachable today, but the asymmetry was a latent trap. Its read-check-write is now serialized under the same lock. No behaviour change to `save()`'s create-if-absent / version-conflict semantics.
- **`NotionAdapter` now conforms to the rate-limit / `retry_after` contract (issue #15).** On HTTP 429 it emits `agentAction: 'wait_and_proceed'` with a top-level `retry_after` (from the `Retry-After` header, or a new `defaultRetryAfterSeconds = 30` tier-3 fallback), matching the other four service adapters and the engine's auto-retry chain. Previously it emitted `wait_for_human` and buried the delay in `details.retryAfterSeconds`, so the header value was dropped and a rate-limited Notion step could wedge on a human instead of auto-retrying.

## [0.16.0] — 2026-07-10

### Added

- **Runner-liveness reclaim recovery — Phase 1 (issue #101).** Closes the _after-claim wedge_: a step pinned in `in_progress_steps` because its runner died after `claimStep` but before settling (the v0.15.0 finalizer crash-wedge is an instance). Every wedge is now **always detectable** and **recoverable by a deliberate per-step act** — no new run phase, no daemon, no background sweep.
  - **Per-claim liveness clock.** A new additive-optional `claims?: Record<string, { deadline: string | null }>` on `RunRecord` is written ATOMICALLY in `claimStep` (the same write that adds the step to `in_progress_steps`) and deleted when the step settles. `in_progress_steps` stays authoritative for eligibility; `claims` is advisory metadata for detection/reclaim. A **concrete deadline** is set only for a reliably time-boundable claim — an `execution: auto` (handler) step in a workflow with **no** finalizer steps; agent steps and any step in a finalizer-bearing workflow get `deadline: null`.
  - **Always-on 3-state detection** (definition-free — reads the stored deadline): `healthy` (deadline in the future), `claim_stale` (deadline passed → likely-dead runner), `claim_unknown_age` (no deadline: agent / finalizer-bearing / legacy run — detect-only, never auto-reclaimed). Surfaced by `get_run_state` (`next_actions_status`, carved out of the `ok` fall-through), `realm run list --stuck` (now also flags claimed-but-idle runs, labeled with the claim state), and `realm run agent`/`listen` on attach (prints the wedge + the exact reclaim remediation before exiting — never silently parked).
  - **`realm run reclaim <run-id>`** — DRY-RUN by default (lists each in-progress claim with its state, deadline, and the per-step remediation; no mutation). `realm run reclaim <run-id> --step <name> --force` moves the stale claim out of `in_progress_steps` so the step becomes eligible again and the next driver re-drives it. At-least-once: the re-driven step's side effects may repeat — `--force` + a loud warning is the deliberate human gate. Loud-fails on a store that declares `!persistsClaims`.
  - **Recovers the finalizer crash-wedge end-to-end:** reclaiming the pinned domain step of a run that crashed mid-`buildFinalizedSeal` lets the re-drive re-reach the seal and run the finalizers.
  - Engine `reclaimStep` is a version-CAS operation (sibling of `abandonRun`, via `store.get`/`store.update` — not a new store CRUD method) that **re-evaluates staleness on a CAS mismatch** (it never blindly re-removes a claim a live driver just re-claimed). Per-claim, not per-run: a dead non-gated sibling on a `gate_waiting` run is reclaimable; the open-gate step itself is refused. `RunStore` gains one additive member, `persistsClaims: boolean` (`JsonFileStore`/`InMemoryStore` return `true`).
  - **Detection surfaces a wedged sibling on a `gate_waiting` run (fan-out).** Under fan-out a run can be `gate_waiting` (an open gate on one branch) yet carry a crashed non-gated claim on another. `realm run list --stuck` now also flags such runs (labeling the offending non-gated claim, never the gated step), and `get_run_state` adds an advisory `stuck_claims` field surfacing the non-healthy non-gated in-progress claims on every non-terminal run — while `next_actions_status` stays `awaiting_human` on the gate path (drivers key on it) and the `pending_gate` step is never treated as a wedge.
  - Bounded-time / automatic recovery (a cron + an advisory `idempotent:` hint) is explicitly **out of scope for Phase 1** — detection is always-on so nothing is silent; recovery is a deliberate human act.
- **Runner-liveness reclaim recovery — Phase 2: opt-in bounded-time auto-reclaim (issue #101).** Builds on Phase 1. An advisory per-step **`idempotent: true`** hint (valid only on `execution: auto` steps; inert — and warned at load — in finalizer-bearing workflows) opts a step into batch auto-reclaim. `realm run reclaim --all [--workflow <id>] [--older-than <dur>]` is a **DRY-RUN by default**; `--all --force` auto-reclaims (one CAS per claim, continue-on-error) **only** claims that are ALL of: author-declared `idempotent`, carrying a **concrete past `deadline`** (`claim_stale`), and **not** the gated step. `claim_unknown_age` (agent / finalizer-bearing / legacy — no concrete deadline), non-`idempotent`, healthy, and gated claims are **structurally excluded** and remain per-step `--step <name> --force`-only — so the finalizer crash-wedge (`deadline: null`) is never cron-touched (intended). `idempotent` is advisory-widen-only: it never forces a fail-seal or changes execution. Operator recipe (opt-in, daemonless — **not** an engine daemon): `*/15 * * * * realm run reclaim --all --older-than 30m --force` — **this re-executes every past-deadline `idempotent`-declared handler at-least-once with NO per-step human judgment; enable only if those handlers are genuinely idempotent.**
- **Recoverable incapability (issue #134).** A missing handler/adapter mid-run no longer terminal-burns the step into `failed_steps` (permanently un-reclaimable). When an `execution: auto` step's handler/adapter is **not registered** in the executing runner's registry, the engine now **settles the step recoverably**: it is removed from `in_progress_steps` (claim omitted in the same write), **not** added to `failed_steps`, the run is **not** terminal-sealed, and a `capability_blocks` marker (additive-optional `RunRecord` field, keyed by step) is recorded — so the step returns to the eligible set and a correctly-provisioned runner reclaims it by re-executing.
  - **New discriminating error codes** `ENGINE_HANDLER_NOT_REGISTERED` / `ENGINE_ADAPTER_NOT_REGISTERED` are minted at the not-registered throw sites ONLY. The pre-existing `ENGINE_HANDLER_FAILED` / `ENGINE_ADAPTER_FAILED` (handler ran-and-threw, service-not-found, adapter runtime, `ADAPTER_OP_UNSUPPORTED`) stay **terminal** — a genuine failure still fails the run. The recoverable envelope carries `error_code` so drivers branch structurally, not on message text, and maps to `agent_action: 'report_to_user'` (non-terminal), not `stop`.
  - **Definition-free detection + surfacing.** A pure `findCapabilityBlockedSteps(run)` (reads only `capability_blocks` + the four step sets; a settled step self-suppresses, so clearing the marker is hygiene not correctness) drives: `get_run_state` — a new `next_actions_status: 'blocked_on_capability'` (precedence `awaiting_human > blocked_on_capability > claim_stale > auto_pending/ok`) + a `capability_blocks` advisory array (coexists with `stuck_claims`; fires on the `workflow_unresolved` path and behind a healthy in-progress sibling); `realm run list --stuck` — flags a blocked step even behind a healthy sibling (fan-out mask fix), naming the missing requirement; `realm run agent` — on attach, capability-aware guidance (add the missing handler/adapter and re-attach) instead of a bare `✗ Step failed`. A pure-MCP consumer recovers a block by calling `execute_step` on the step named in the advisory.
- **Start-time capability warning (issue #134).** Run creation now **warns (never refuses)** when the effective runner registry can't satisfy the workflow's `execution: auto` handlers/adapters, phrased advisorily ("if reached, this step will block recoverably — load the missing extension"). Emitted at every run-creating path — `start_run` (rides `warnings[]`), `start_run_batch` (per item, workflow-invariant, caveated "the driving runner may differ"), `realm run`, and `realm run agent` (create path only; the `--run-id` attach path is intentionally N-A). Pre-flight shares the exact `unmetCapabilities` derivation the mid-run settle uses (via `requirementForStep`), with a hard `?? createDefaultRegistry()` fallback so a filesystem-only workflow with no supplied registry never false-warns. A behavioral enumeration test partitions every `RunStore.create` site into WARNED / N-A-with-reason, failing loudly on a new unclassified create path.
- **Default execution timeout for `auto` steps.** Every adapter/handler step is now bounded by `timeout_seconds` or a generous **3600s default**, turning an indefinite hang into a loud terminal `STEP_TIMEOUT`. `timeout_seconds` is now validated (positive integer) and the effective timeout is surfaced in step evidence.

### Changed

- **Test suite is now reliable-by-construction under parallel turbo.** `turbo run test` ran all four test-having packages at once with no concurrency cap, and each `vitest run` forked ≈`cores` workers → ≈ packages × cores competing forks (≈3–4× CPU oversubscription), so against vitest's 5s `testTimeout` the starved forks intermittently timed out (a diverse batch failed together, clean on isolated re-run). Fixed structurally with a machine-invariant resource budget: a new root `vitest.config.ts` (`maxWorkers: '50%'`, plus pinned `pool: 'forks'` / `isolate: true` / `testTimeout: 5000` / `retry: 0` — the verified vitest 4.1.8 defaults, made explicit as future-flip guards) paired with `turbo run test --concurrency=2` in the root `test` script → `2 × 0.5·C = C` (exactly full subscription, zero oversubscription, on any core count). No retry (a real hang still fails at 5s — the signal stays honest) and no test-file changes. Test-infra only; no product code.
- **A timeout consumes no retry attempts and fails the step terminally** (unchanged for authored timeouts; now also applies to the default). Steps with a `retry:` block relying on retrying a _slow_ attempt should declare a suitable `timeout_seconds`; `workflow validate` flags this. Agent steps are unaffected (bounded separately by `tool_timeout`). Finalizers keep their drain ceiling.

### Fixed

- **Slack gate replies are now reliably delivered (and submit failures surfaced).** `handleBidirectionalGate` dispatched candidate processing fire-and-forget at both the Socket Mode and Events API sites, so on a run-completing gate the confirmation reply could be truncated by `process.exit` before it flushed. In-flight candidate processing is now **tracked at both dispatch sites** and **drained (bounded by `DRAIN_TIMEOUT_MS = 2000`, timer cleared) in the `finally`** before the handler returns — the reply is guaranteed sent, while a hung Slack can never stall the run loop. A failed gate submit (an error envelope from `submitHumanResponse`, or an unexpected throw) now posts **one** operator-facing error reply and, deliberately, does **not** resolve or abort the gate (it stays open for retry / the terminal fallback) — previously a failed submit was silently `console.warn`-swallowed while a false confirmation was still posted. Test-infra: the two formerly-flaky bidirectional-gate tests are now deterministic (the `setTimeout(50)` wall-clock barriers are removed; the drain guarantees replies have landed), with added Socket-Mode, bounded-drain, and submit-error coverage.
- **JsonFileStore now writes run and key-pointer files atomically** (unique temp + POSIX `rename`), eliminating a torn read (`Unexpected end of JSON input`) that could hit any concurrent unlocked reader (`get_run_state`, `list`, gate poll loops) during a write. Reads stay lock-free. On Windows the store falls back to the prior non-atomic write (POSIX atomicity only).
- **`realm agent` drives Claude-backed agent steps robustly.** The Anthropic provider now offers a schema-typed `__realm_submit__` tool (at `tool_choice:'auto'`, so reasoning is preserved) and falls back to a fence/preamble-aware JSON extractor, eliminating the parse-failure strands from Claude's fenced/prefaced JSON. Agent steps declaring an `output_schema` now have that schema routed to the provider (previously only `input_schema` was). The extractor also hardens the OpenAI/reasoning providers' final-answer parsing.
- **`GorgiasAdapter.get_messages` now fetches per-ticket threads reliably.** `get_messages({ ticket_id })` previously read from the flat `GET /messages?ticket_id=` collection filter, which Gorgias returns inconsistently (0, 1, or all messages for the same request) — silently truncating multi-turn threads. It now uses the authoritative per-ticket endpoint `GET /tickets/{id}/messages` (the flat `/messages` path is retained only for the `ticket_id`-omitted global scan). Return shape (`{ messages, truncated }`), pagination, `limit`, `order_by`, and `cursor` are unchanged. **Behaviour change:** callers now receive the full thread; any consumer that implicitly relied on "latest message only" should select the last item after ordering (or use `ticket.last_message_id`). For a `ticket_id` fetch, the previous default silently capped the thread at 30 messages; a no-limit fetch now returns the complete thread, guarded by a 500-message default against a pathological thread — an explicit `limit` is honored as given (the caller owns the size/cost tradeoff). The `truncated` flag is now **honest**: previously it reported `false` even when messages were dropped within a single page (checking for API exhaustion before accounting for the limit); it now reports `true` whenever any returned message was excluded for lack of room.
- **`GorgiasAdapter` error responses are now length-capped and email-redacted** before being attached to `error_details`, preventing customer PII in an API error body from leaking into the response envelope/logs.
- **Adapter aborts map consistently to `STEP_ABORTED`.** The Slack adapter (was generic `ADAPTER_REQUEST_FAILED`) and the file adapter (which now threads the abort signal into its read) join every network adapter in surfacing an aborted request as `STEP_ABORTED` — so a timeout/cancellation is reported uniformly regardless of adapter.
- **`claim_stale` detection no longer fires prematurely on a retrying step (issue #101).** The claim-liveness horizon bounded a single attempt; a step with a `retry:` block has a worst-case wall-clock of `max_attempts × per-attempt-timeout + backoffs`, so a legitimately-retrying step could be labeled `claim_stale` (and, if `idempotent`, become eligible for a premature `--all --force` re-drive) while still on an early attempt. The horizon now accounts for `max_attempts` and the declared backoff schedule. Non-retry steps are unaffected.

## [0.15.0] — 2026-07-07

### Added

- **`execution: finalizer` step class — a workflow-level try/catch/finally.** A finalizer is an engine-run step the engine drains as the final steps before it seals a run, matched to the run's terminal outcome via a required `on_outcome:` matcher (`FinalizerTrigger | FinalizerTrigger[]`, where `FinalizerTrigger = 'complete' | 'fail' | 'abort' | 'always'`, OR-membership). `complete` = the success/`try` arm, `fail`/`abort` = the `catch` arm, `always` = the `finally` arm. At each terminal transition the engine drains the matching finalizers **in-memory** — outcome-specific finalizers first (declaration order), then `always` finalizers (declaration order, so `finally` runs last) — each **at most once per run**, then performs the run's existing single seal write. Realm owns only _which_ finalizers run, _when_, in what _order_, and _once_; what a finalizer does internally is the workflow developer's business (it runs its `handler` through the injected registry exactly like any other handler step).
  - **Handler-only in v1.** Allowed fields: `description`, `handler`, `on_outcome`, `timeout_seconds`. The loader rejects (per offending field) `depends_on`, `trigger_rule`, `abort_unless`, `abort_message`, `output_schema`, `agent_profile`, `tools`, `uses_service`, `service_method`, `operation`, `input_map`, `when`, `retry`, and any human-gate `trust`. `on_outcome` is required, non-empty, and every value must be a known trigger; `on_outcome` is rejected on any non-finalizer step; a step whose `depends_on` names a finalizer is rejected (would deadlock); a workflow of only finalizers is rejected.
  - **Failure is non-fatal and never changes the run outcome.** A finalizer that throws, times out (`timeout_seconds`, default 30s), or returns `{ abort }` is recorded in `failed_steps` with evidence, but never mutates `aborted_at`/`terminal_reason`/`terminal_state` and never un-terminates the run — the drain continues to the next finalizer. Finalizers are held out of the DAG: they never appear in the agent-eligible set, are never `execute_step`-able, and are excluded from DAG-completion accounting.
  - **Operator-abandon runs no finalizers** (a kill runs no `finally`), matching every runtime.
  - Workflows that declare no finalizers are byte-identical to the prior engine (zero-finalizer fast path).
  - **Gate-completed runs now fire their finalizers end-to-end.** The resolved project extension registry is threaded into `submitHumanResponse` at every gate-resolution driver — `realm run` (interactive loop), `realm respond` (`respondToGate`, with `--project`/`--extensions-module` and an injectable registry), the MCP `submit_human_response` tool (via `registry`/`registryProvider`, mirroring `execute_step`), and the Slack auto-resolver (`agent`/`listen` daemon) — so a workflow with a **gate** and a finalizer whose handler is a **project handler** runs that finalizer when resolving the gate completes the run, exactly as a normally-completing run does. (The engine gate-completion drain already honoured `SubmitGateOptions.registry`; no driver had been supplying it.) `@sensigo/realm-testing`'s `createGateResponder` now accepts an optional trailing `registry` argument (additive, backward-compatible) so gate-completed runs fire finalizers with project handlers in tests too.

### Fixed

- **Integer-like step names are now rejected by the loader** (names matching `/^\d+$/`). JS object iteration reorders integer-like keys ahead of insertion order, which would silently break the declaration-order guarantees the eligibility loops and the finalizer drain rely on (both iterate via `Object.entries`).
- **Guard-completion `context_hint` mislabel.** A passing guard that completed the run was described as "failed with a resolution error"; the three terminal guard outcomes (aborted / completed / resolution-error) are now labeled distinctly.
- **Protocol generator mis-briefed engine-run steps.** `guard` and (now) `finalizer` steps were briefed to the agent as "YOU execute this step"; they are now described as engine-run with an explicit "do NOT call `execute_step`" instruction.

---

## [0.14.1] — 2026-07-06

### Fixed

- **Orphaned deployment manifest is now a loud error** (#123). A `realm.yaml` placed in the span `[source_dir, trust_root)` — the workflow directory or an intermediate directory below the resolved deployment root — was silently ignored (manifests load only from `<trust_root>/realm.yaml`), giving a confusing downstream `adapter 'X' not registered` at execution time and no signal at all under validate/sentinel/fixture paths. Every workflow-loading command now scans that span and throws before run creation, naming the orphaned path(s), the resolved trust root, and the fix. Detection-only: manifest loading stays strict-single-location. A manifest _above_ the trust root (monorepo-root case) is intentionally not scanned. **`realm workflow validate` now also surfaces this** — a misplaced `realm.yaml` may turn a previously-green validate red; that is correct topology reporting (the manifest was never being loaded), not a regression.

---

## [0.14.0] — 2026-07-05

### BREAKING

- **The legacy env-gated adapter tier in `realm agent` is REMOVED** (completes #120): `GITHUB_TOKEN`/`SLACK_WEBHOOK_URL` no longer auto-register adapters. Declare adapters in your deployment manifest (`realm.yaml`) instead.
- **`services.auth.token_from` is REMOVED** from workflow YAML (permanent targeted rejection with a migration message); the engine injects no auth — credentials bind at adapter CONSTRUCTION time in the manifest. `ExecuteStepOptions.secrets`/`executeChain({secrets})` and core `loadSecrets`/`resolveSecret` are gone.
- **`createDefaultRegistry()` is filesystem-only** — the env-read SlackAdapter registration is gone; `slack` comes from the manifest catalog.
- **`RealmMcpServerOptions.secrets` is REMOVED** (breaking type; realm-cloud call site verified unaffected).
- **Gate-notifier config moved to the manifest** (`notifiers.slack_gate`) — the nine `SLACK_*` env reads in `realm agent` are deleted; gate presence = manifest presence. `events_port` is now per-project (no more one-global-port contention).
- `ExtensionRegistry.clone()` removed (existed solely for the deleted tier); `services:` entries are now schema-validated with a closed key set.

### Added

- **Deployment manifest** — `<deployment root>/realm.yaml` (Ajv-strict, `version: 1`): adapter construction via a **built-in catalog** (github, slack, http, airtable, gorgias, shopify, notion, parcelpanel + config-less filesystem/mock) or custom **factories** (`use: ./path.js#Export`, contract `({ id, config }) => instance`), handler/processor construction config, and gate notifiers. Manifest names and workflow-declared extension exports share one namespace/collision map.
- **Declared secret sources** — `${secret:NAME}` bindings (composite refs, `$$` escape) resolved from `secrets.sources` (default `[dotenv]`, `env` opt-in, declared order = precedence); dotenv parsed without touching `process.env`; ONE aggregated unresolved-refs error naming every binding site; constructor errors redacted (secret values never appear in logs/errors/drift records).
- **Anchors** — registered workflows anchor at their stored trust_root; agent-created/from-string definitions anchor at the daemon's `--project` root (cwd default for `agent`/`run`/`serve`; **`realm mcp` requires explicit `--project`** — its cwd is client-controlled, a recorded security decision).
- **Hot rotation** — a memory-only freshness hash over manifest+dotenv bytes is re-checked per run-start: dotenv secret rotation reaches the next run WITHOUT a daemon restart (the rebuild resets that entry's rate-limiter buckets; module code stays restart-required; concurrent rebuilds race benignly last-wins). Rotation mints zero drift entries; an edited manifest IS drift (`manifest.content_hash` joins the identity compare set; referenced secret NAMES are recorded, never compared, never values).
- **Sentinel secret mode** — `validate`/`test` run with labeled sentinel credentials (constructor failures downgrade to warnings); `register`/`watch` degrade-with-WARN when sources are unavailable; execution paths always require real resolution. `realm test` fails a fixture the first time a secret-bearing handler executes (never silently real, never fake-credential passes).
- **Manifest-secret trace redaction** — `realm agent` masks manifest-resolved secret VALUES in provider-loop tool results and tool errors (combined with the process.env pass, deduped, longest-first — fixing the fragment-leak wart when a short value sits inside a longer one). Literal-value masking only: encoded/derived forms are not caught, and handler step outputs are recorded verbatim (never return secrets from handlers). `inspect --check-drift` now also recomputes the recorded manifest's content hash (same/DIFFERS/MISSING). Secret-bearing manifest PROCESSORS are poisoned in `realm test` symmetrically to handlers.
- chore: pre-commit guard rejecting raw control bytes in source files (lefthook), after two raw-NUL near-misses.
- `realm init` scaffolds `realm.yaml` + an aligned `.env.example`; `registry.sample.js` demonstrates the factory contract. Examples 07/08/09 ship minimal manifests (09 demonstrates `notifiers:`). New docs: `docs/reference/deployment-manifest.md`.

---

## [0.13.0] — 2026-07-05

### Added

- **First-class project extensions** (issue #117). Workflows declare custom adapter/handler/processor modules in YAML — `extensions: <relative path> | <relative path>[]` — and every step-executing or config-validating entry point (`run`, `agent`, `listen` children, `serve`, `mcp`, `test`, `validate`, `register`, `watch`) resolves them through ONE shared loader. Consumers no longer need bespoke MCP wrapper servers.
  - **Core (`@sensigo/realm`)**: `extensions` schema (relative-only; string-based loading rejects the key — no directory context); `loadWorkflowFromFile` stamps `source_dir` + `trust_root` (nearest `package.json`/`.git` ancestor) on the definition — core resolves PATHS only, never imports modules; `ExtensionRegistry.has()`/`names()`; new `ExtensionManifest` type; the adapter-not-registered error now hints at `extensions:` when the definition declares none.
  - **CLI (`@sensigo/realm-cli`)**: `loadProjectExtensions()` — realpath containment within the trust root, duck-typed validation of the declarative default export (`{ adapters?, handlers?, processors? }`), collision policy (built-in override → WARN; duplicate across modules → ERROR), jiti-from-consumer-project for `.ts` modules, process-lifetime registry cache (restart to pick up module changes). `--extensions-module <path>` repair/override flag on `agent`, `run`, `serve`, `mcp`, `validate`, `test`. `agent --run-id` failure semantics: pre-execution extension-load failure writes `terminal_reason: 'extensions_load_failed'` (re-attach clears exactly that reason and retries); in-flight runs are never mutated by a failed attach.
  - **MCP (`@sensigo/realm-mcp`)**: `RealmMcpServerOptions.registryProvider` — per-definition registry resolution awaited BEFORE `runStore.create` in `start_run`/`start_run_batch` and before execution in `execute_step` (provider wins over `registry`). `create_workflow` rejects `extensions` (register-time, operator-only).
  - **Testing (`@sensigo/realm-testing`)**: `RunFixtureTestsOptions.extensions` — extension handlers/processors run REAL in fixtures; every extension adapter the fixture does not mock gets a tripwire that fails the fixture (in both the execution-loop and dispatcher-fallback paths) and enumerates unmatched mock keys.
  - Docs: new `docs/reference/project-extensions.md` (module contract, precedence, trust model), plus `yaml-schema.md` / `cli-commands.md` sections.
  - **`ExtensionRegistry.clone()`** — shallow-copies the extension instances with a fresh rate-limiter map; `realm agent` composes its per-run registry (legacy env-gated tier) on a clone, so shared loader-cache entries are never mutated.
  - **Extension-code drift evidence** (issue #119). Every run of an extension-declaring workflow records the identity of the code that executed it, captured at module-LOAD time: per-module sha256 entry hashes plus a versioned deterministic `dir_tree_v1` directory fingerprint (node_modules/.git excluded, symlinks skipped, sorted, capped with deterministic truncation), labeled advisory signals (`package_version`, `git_head` — fs reads only), and override/error flags. Recorded as an append-on-change `RunRecord.extension_identity` history via the execution loop's lazy write (CAS loser retries once then logs-and-drops); `realm agent --run-id` WARNs on divergence (never gates; no pre-claim write); `extensions_load_failed` writes carry an `error` identity entry; `realm run inspect` renders the history and `--check-drift` recomputes the last entry against disk under its RECORDED rules with pure hashing (read-only commands never load project code). JSON-file-store-only until external stores round-trip unknown optional RunRecord fields.
- **`realm init` scaffolds project-extensions templates** — a commented `extensions:` line in the generated workflow.yaml and a `registry.sample.js` with the declarative contract shape (nothing registered by default).

### Deprecated

- **Env-gated adapter registration in `realm agent`** (`GITHUB_TOKEN`/`SLACK_WEBHOOK_URL` auto-registering github/slack). A deprecation warning now fires when the tier is used; removal targeted for v0.14.0 — declare these adapters in a project extensions module instead (#120).

### Changed

- **`realm listen` no longer re-registers workflows per webhook.** Routed workflows are registered ONCE at startup (the per-webhook `workflowStore.register` silently reverted fresher registrations). Restart `realm listen` after re-registering a workflow. Startup also fail-fast loads each routed workflow's extension modules (imported in the listen parent).
- **`realm serve` constructs ONE workflow store per process** (was one per request). `JsonWorkflowStore.get()` re-reads from disk per call, so the shared instance introduces no staleness.

---

## [0.12.1] — 2026-07-04

### Fixed

- **`realm-mcp` bin entry exited silently when invoked via npm/npx bin shims** (`npx @sensigo/realm-mcp`, `node_modules/.bin/realm-mcp`). The entry-point guard compared `import.meta.url` against `process.argv[1]` with a string-suffix check; bin shims are symlinks, so `argv[1]` held the symlink path while `import.meta.url` held the resolved target — the guard never matched and the process exited 0 without connecting the stdio transport. The guard now realpath-resolves both sides. Direct `node dist/server.js` invocation and library import behavior are unchanged; all three invocation modes are covered by spawn-based regression tests. (PR #115)

---

## [0.12.0] — 2026-06-30

### Changed

- **BREAKING — corrected `when` absent-operand semantics.** When a `when` leaf's left-hand path is unresolved, the engine no longer lets `undefined` flow into the comparison (which made `undefined != null` → `true`, so a clause mis-fired). New per-operator behavior on an **absent** LHS: `== null` → **true**, `!= null` → **false** (presence tests, loose null), `!= '<non-null>'` → **false** (was `true`), relational `> < >= <=` → **false**; equality/relational on a **resolved** LHS is unchanged. A **present-`null`** LHS with a relational op is now **false** (numeric guard) instead of `true` (the old JS `null → 0` coercion). Symmetric `undefined → false` is deliberate. (External consequence: `run.params.mode != 'shadow'` now skips when `mode` is absent rather than firing — safe in practice; an external-workflow concern.)
- **BREAKING — compound `when` strings are rejected at load.** `when:` never supported boolean composition; a compound string like `"A == x and B != y"` previously misparsed silently (latched a stray operator → always-true). It is now a loud, actionable load error pointing to the list form. The same load rejection now also applies to compound `abort_unless` / `preconditions` leaves (previously silently mis-evaluated; zero such clauses in known workflows).

### Added

- **`when: string[]` (implicit AND).** `when` is now `string | string[]`; an array ANDs its leaves (mirrors `abort_unless`). An empty array is a load error. `any`/OR is not added.
- **Load-time condition validation across `when` / `abort_unless` / `preconditions`** via a shared zero-dependency quote-aware splitter (`comparison-expr.ts`): every leaf must be a single comparison (or, for `when`/`abort_unless`, a bare path) with a path-shaped LHS — compound / multi-operator / non-path leaves are rejected with actionable errors. The same splitter is used at runtime, so validation and evaluation never diverge.
- **`when` direct-`depends_on` reference check (load-time).** A `when` leaf's `step.field` must reference `run.params.*` or a step in that step's direct `depends_on` (one-hop) — a mistyped/undeclared step name is now a load error.

---

## [0.11.0] — 2026-06-27

### Added

- **`agent_step_attempt_failed` stderr telemetry** — when an agent's `execute_step` output fails pre-claim schema validation (`VALIDATION_INPUT_SCHEMA` / `VALIDATION_OUTPUT_SCHEMA` / `VALIDATION_TRACE_SCHEMA`), the MCP server now emits a structured, **metadata-only** stderr event (filter by `event`). The record carries Ajv error metadata (offending-value echoes dropped), submitted key _names_ (capped), counts, and byte size — never raw model output. This gives operators a post-mortem trail for rejections that are otherwise write-free (never reach `failed_steps[]`, never bump `version`). Exposes pure `buildFailedAttemptRecord` / `serializeFailedAttemptLine` helpers from `@sensigo/realm`. Core stays I/O-free; the live `execute_step` response is unchanged.
- **Durable failed-attempt sidecar + `realm run attempts <run-id>` CLI** — the same metadata-only record is also appended to a co-located per-run sidecar (`<runsDir>/<run-id>.attempts.jsonl`) so the failure trail survives stderr. Lock-free single-`O_APPEND` writes (each line ≤ PIPE_BUF), `stat`-based append-and-stop byte ceiling (~256 KB, keeps the first N), and operator-managed retention (co-removed with run files; no GC hook). The `.jsonl` suffix keeps it invisible to `JsonFileStore.list()`. `realm run attempts <id>` prints the records (table, or `--json`) and notes when the sidecar was capped. New `FailedAttemptStore` exported from `@sensigo/realm`. Pure side-channel — never touches the run record / `version` / `failed_steps[]`; best-effort (never throws, never alters the `execute_step` response).

---

## [0.10.1] — 2026-06-26

### Fixed

- **`AirtableAdapter.upsert_record` now uses `PATCH` (was `POST`)** — Airtable's `performUpsert` is only valid on the PATCH records endpoint, so every `update('upsert_record', …)` previously returned HTTP 422 (`"Invalid request: parameter validation failed."`). Body, validation, and response handling are unchanged. Adapter op tests now also assert the HTTP method for every operation, closing the gap that let the wrong verb ship.

---

## [0.10.0] — 2026-06-26

### Added

- **`abandon_run` MCP tool + `realm run abandon <run-id> [--reason …]` CLI** — explicitly abandon a non-terminal run (marks it terminal, phase `abandoned`) via a shared core `abandonRun()` primitive. Idempotent; refuses already-terminal runs (`STATE_RUN_TERMINAL`) and `gate_waiting` runs (`STATE_TRANSITION_DENIED` — resolve the gate via `submit_human_response` first); concurrency-safe (a live writer wins, abandon propagates `STATE_SNAPSHOT_MISMATCH` rather than corrupting). Brings the MCP tool count to 10.
- **`get_run_state` now returns `next_actions` + `next_actions_status`** (`ok` / `auto_pending` / `awaiting_human` / `workflow_unresolved` / `skipped_terminal`) — read-only recovery diagnostics that distinguish a genuinely-parked run from one with no pending agent action.
- **`realm run list --stuck`** — lists advanced-but-parked runs (phase `running` with no claimed step), with idle age.
- **`docs/reference/operating-runs.md`** — "Operating & recovering runs" decision table + recovery loop.

### Changed

- **`deriveRunPhase` honors a new authoritative `abandoned_at` marker** (set by `abandon_run` / `realm run abandon` / `realm run cleanup`): its presence makes `abandoned` the derived phase regardless of `failed_steps` / `terminal_reason`. Fixes a latent case where an idle `running` run carrying `failed_steps` would be mislabeled `failed` on cleanup.
- **`submit_human_response` now rejects a gate response on a terminal run** (`STATE_RUN_TERMINAL`) — defense-in-depth so a late response cannot re-drive a finished run.

---

## [0.9.0] — 2026-06-24

### Changed

- **`$literal` (input_map) now accepts any JSON value — arrays and objects, not just scalars — passed through verbatim** (the literal escape now covers whole subtrees, so a string leaf that looks like a dot-path inside a `$literal` object stays literal). A `$literal` node still must have exactly one key, and a **bare array** as an input_map node value remains rejected (wrap it in `$literal`).
- **Step `config` may now contain nested objects** (previously rejected at load as "nested objects are not supported in v1"). Adapter `config_schema` remains the validator for `uses_service` config; the redundant load-time ban is removed.

---

## [0.8.0] — 2026-06-24

### Changed

- **Defense-in-depth: `executeChain` now no-ops on an already-terminal run.** When invoked for a run whose phase is terminal (`completed`/`failed`/`aborted`/`abandoned`), `executeChain` returns immediately without executing a step or writing the store, instead of attempting to drive it. This is unreachable in normal operation — the eligibility guard added in 0.7.1 already prevents it — and has no observable effect on valid workflows; it hardens the chain boundary so the "terminal runs are never driven" invariant holds at the structural boundary regardless of how a caller reaches `executeChain`.
- **BREAKING — `RunStore.create()` now returns `{ run, created }` instead of `RunRecord`.** `created` is `true` for a freshly written run and `false` when an existing run matched the supplied `idempotencyKey`. In-repo callers and both bundled stores (`JsonFileStore`, `InMemoryStore`) are updated. **External `RunStore` implementations (e.g. the cloud Postgres store) must update their `create()` signature and return the new shape** — destructure `{ run }` at call sites that only need the record.

### Added

- **Idempotency keys are now a first-class, atomically-managed identity.** `JsonFileStore` resolves an `idempotencyKey` through a deterministic per-key pointer index (`<runsDir>/keys/<sha256(workflowId\0key)>.json`) under a per-key lock, instead of an O(n) `readdir` scan with a first-match race. This closes a class of latent issues at the root (TOCTOU double-insert, readdir-order nondeterminism, per-create O(n) cost, silent key↔payload mismatch, and the `save()` import back door) and is crash-safe (run file written before pointer; a pointer to a missing run self-heals; a run written without its pointer is recovered by a lazy legacy-field fallback). Behavior is otherwise equivalent to the previous default: a key match returns the existing run unchanged — nothing is re-driven.
- **`realm run reconcile`** — eagerly builds the key pointer index from existing run records (`--workflow <id>` to scope, `--dry-run` to report without writing). Idempotent and reversible (only creates `keys/`; never mutates run files). Skipping it is safe — the store self-migrates lazily on first touch.
- **Idempotency re-encounter signal.** `ResponseEnvelope` gains an optional `run_phase` (present whenever a run is loaded). `start_run` reports `deduped: boolean`, a state-accurate `context_hint` on a match, and observational warnings when the matched run is still active or was created with different params. `start_run_batch` reports the same per `started[]` item (`deduped`, `run_phase`, `terminal_reason?`, `warnings`). Dedup activity is logged at the tool boundary.
- **Idempotency re-encounter policy.** `start_run` / `start_run_batch` accept two optional, opt-in policy params that default to today's behavior:
  - `on_terminal_match` — when a key matches a **terminal** run: `reuse` _(default)_ / `reject` (throws `STATE_IDEMPOTENCY_KEY_USED`) / `rerun_if_failed` (supersede a `failed`/`aborted`/`abandoned` match with a fresh run; reuse a `completed` one) / `rerun` (always supersede).
  - `on_live_match` — when a key matches a **non-terminal** run: `use_existing` _(default)_ / `fail` (throws `STATE_RUN_ALREADY_ACTIVE`).

  Supersede repoints the key to the fresh run via a single atomic pointer overwrite (the superseded run stays on disk by id, auditable); a lost pointer self-heals to the successor. In `start_run_batch` the policy is batch-level (one policy for all items) and a rejected item is reported in a new `failed[]` array (with its original `index`) rather than aborting the batch. Defaults reproduce prior behavior exactly. `terminate` (abort-then-restart of a live run) is intentionally unsupported — a daemonless file store cannot reliably stop a detached agent.

---

## [0.7.1] — 2026-06-22

### Fixed

- **Terminal runs are no longer re-driven or un-aborted when re-encountered through an idempotency key.** `findEligibleSteps` and `findEligibleGuardSteps` now return no eligible steps for a run in a terminal state, so `start_run` / `start_run_batch` are a clean no-op on an already-processed run (previously a terminal aborted run could be silently re-driven via a permanent idempotency-key match, corrupting it on disk).
- **`deriveRunPhase` now treats `aborted_at` as authoritative.** An aborted run can no longer revert to `running` (or be silently reclassified as `completed`) if a write-path recomputes `terminal_state` while the record still carries `aborted_at`.
- **`realm resume` now actually re-enables a failed run for re-execution.** It resets the run to `running`, re-derives skipped steps, and clears the terminal reason, so the run can be driven with `realm agent --run-id <id>`. Previously it only edited `failed_steps`, leaving the run terminal and un-runnable.

---

## [0.7.0] — 2026-06-21

### Added

- **`realm listen` — general-purpose webhook server.** Routes inbound webhooks to workflows that declare a `trigger:` block: verifies authenticity per `trigger.auth`, optionally filters and deduplicates, creates a run, and spawns a detached `realm agent` for it. Loopback-bound by default (a non-loopback host warns about missing TLS); the request body is capped and timed out before any verification work, and a `--max-concurrent` 503 floor caps in-flight requests. Flags: `--port`, `--host`, `--body-timeout-ms`, `--max-body-bytes`, `--max-concurrent`, `--dedup-store`, `--log-level`. TLS termination, rate limiting, and autoscaling are delegated to a reverse proxy.
- **Workflow `trigger:` block** — a new `workflow.yaml` surface, validated at register time. `type: webhook` with an `auth` mode — `shared_secret` (header token, e.g. Gorgias), `github`, `stripe`, `hmac`, or `none` (verification disabled; trusted-network/localhost only) — plus optional `filter`, `dedup`, and `params_map`. See [YAML Schema Reference → Webhook trigger](docs/reference/yaml-schema.md#webhook-trigger).
- **New exported types** from `@sensigo/realm`: `WebhookTrigger`, `TriggerDefinition`, `WebhookAuth` (and its `AuthSharedSecret` / `AuthGithub` / `AuthStripe` / `AuthHmac` / `AuthNone` members), `FilterCondition`, `TriggerFilter`, `DedupConfig`. New `RunRecord` fields `agent_pid` and `agent_started_at`, set by `realm listen` after spawning an agent.

### Removed

- **`realm webhook` (GitHub-only webhook server) removed.** Its function is replaced by `realm listen` with a workflow `trigger:` block (`auth: { mode: github }` + a `params_map` of the PR fields), proven byte-parity-equivalent to the old hardcoded mapping. `realm webhook` now prints a migration message and exits non-zero. **Migration:** see [`docs/reference/cli-commands.md`](docs/reference/cli-commands.md) (`realm listen`) and [`examples/09-webhook-pr-review/`](examples/09-webhook-pr-review/). The duplicate `checkWebhookSignature` helper was also removed — the shared `verifyGithub` verifier covers it.

---

## [0.6.4] — 2026-06-17

### Changed

- **ShopifyAdapter — GraphQL passthrough** — the previous `fetch('get_order', { store, order_name })` operation performed a fixed query (`ORDERS_BY_NAME_QUERY`), selected specific fields, and returned a normalised `NormalizedOrder` object. Replaced with a single `fetch('query', { store, query, variables? })` operation that accepts any GraphQL query or mutation string and returns the raw GraphQL response body. The caller owns all field selection; the adapter handles authentication, store routing, and error classification only.

### Removed

- **`ShopifyNormalizedOrder` exported type removed** — callers who were typing `result.data as ShopifyNormalizedOrder` should switch to a locally defined type that matches the fields they request in their own query.
- **`get_order` operation removed** — replaced by `fetch('query', { store, query, variables? })`. Callers who were using `get_order` should rewrite the step to pass the `ORDERS_BY_NAME_QUERY` (or any query of their choice) as the `query` param.

### Added

- **Adapter reference documentation** — `docs/reference/adapters.md` now documents all seven shipped adapters. Four new sections added: `GorgiasAdapter` (10 operations), `ParcelPanelAdapter` (2 operations), `ShopifyAdapter` (1 GraphQL passthrough operation), `NotionAdapter` (8 operations). Each section covers constructor config, YAML declaration, per-operation param tables, and an error classification table.

---

## [0.6.3] — 2026-06-16

### Added

- **ParcelPanelAdapter — `fetch('get_tracking_by_id', { store, order_id })`** — look up tracking data by Shopify numeric order ID instead of order number. Same endpoint (`GET /api/v2/tracking/order`), different query param (`?order_id=`). Accepts `order_id` as either `number` or `string`; both formats are normalised to a string before the request is sent.

### Changed

- **ParcelPanelAdapter — `ParcelPanelShipment` and `ParcelPanelOrderBody` interfaces expanded** — now cover the complete ParcelPanel API response shape: `substatus`, `transit_time`, `estimated_delivery_date`, `last_mile`, `products`, `checkpoints`, `customer`, `shipping_address`, `store`, `order_tags`, and more. Both interfaces are now exported from `@sensigo/realm` so callers can type raw API responses directly.

### Fixed

- **ParcelPanelAdapter universal passthrough** — `get_tracking` previously returned a normalised 4-field `NormalizedTracking` object (`tracking_url`, `carrier`, `tracking_number`, `status`), silently discarding the entire API response including all shipments beyond the first, all checkpoint events, customer data, and shipping address. Now returns the complete raw API response as-is.

### Removed

- **`NormalizedTracking` exported interface removed** — callers who were typing `result.data as NormalizedTracking` should switch to `result.data as ParcelPanelOrderBody`, which covers the full response shape.

---

## [0.6.2] — 2026-06-16

### Added

- **GorgiasAdapter — 7 new operations** covering the full ticket and customer resource surface:
  - `fetch('list_tickets', { order_by?, cursor?, limit?, ... })` — GET `/tickets`; returns one page of raw results including `meta.next_cursor` for caller-managed pagination
  - `fetch('get_customer', { customer_id })` — GET `/customers/{id}`; follows Gorgias 301 redirects for merged customers transparently
  - `fetch('list_customers', { order_by?, cursor?, limit?, ... })` — GET `/customers`; same single-page passthrough as `list_tickets`
  - `create('create_ticket', { messages, ...ticketFields })` — POST `/tickets`; full params forwarded as body
  - `create('create_customer', { channels, ...customerFields })` — POST `/customers`; full params forwarded as body
  - `update('update_ticket', { ticket_id, ...ticketFields })` — PUT `/tickets/{id}`; `ticket_id` becomes the path param and is stripped from the body
  - `update('update_customer', { customer_id, ...customerFields })` — PUT `/customers/{id}`; same pattern

  List operations (`list_tickets`, `list_customers`) forward all scalar (`string | number | boolean`) params as URL-encoded query params; non-scalar values (arrays, objects) are silently skipped.

### Changed

- **GorgiasAdapter `get_messages` — `ticket_id` is now optional** — when absent the filter is omitted from the URL, enabling cross-ticket message queries. When present and invalid, `ADAPTER_VALIDATION_FAILED` is still thrown.
- **GorgiasAdapter `get_messages` — `order_by` is omitted when not supplied** — previously defaulted to `created_datetime:asc` regardless of caller intent. Now omitted, letting the Gorgias API apply its own default (`created_datetime:desc`). Callers who need ascending order must pass `order_by: 'created_datetime:asc'` explicitly.
- **GorgiasAdapter `GorgiasMessage` interface** — six previously undeclared fields now documented: `auth_customer_identity`, `integration_id`, `intents`, `rule_id`, `replied_by`, `replied_to`. These were always preserved at runtime via the index signature; the change is documentation only.

### Fixed

- **GorgiasAdapter universal passthrough** — `get_messages` previously cherry-picked fields and computed a derived `body` field from HTML content. All normalisation code (`normalize()`, `NormalizedMessage`, `stripHtmlTags`, `HTML_ENTITIES`) has been removed. Raw Gorgias message objects are now returned as-is, with all 35 API fields intact.
- **GorgiasAdapter `create_message` replaces `post_internal_note`** — the previous `post_internal_note` operation hardcoded `channel: 'note'`, `public: false`, `from_agent: true` regardless of caller input. Replaced with `create_message`, which forwards all caller-supplied fields unchanged.

---

## [0.6.1] — 2026-06-15

### Fixed

- **SSE JSON serialization safety** — MCP tool responses now escape U+0085 (NEXT LINE),
  U+2028 (LINE SEPARATOR), and U+2029 (PARAGRAPH SEPARATOR) as `\uXXXX` sequences in the
  JSON payload. These three characters are the only ones that `JSON.stringify` leaves
  unescaped but Python's `str.splitlines()` treats as line terminators, causing SSE `data:`
  lines to be split mid-JSON and producing `JSONDecodeError` on the client side. Ticket
  content in multilingual workflows (Dutch, Polish, French) that contains these characters
  no longer causes truncated responses. All other non-ASCII characters (accented letters,
  emoji, CJK) pass through unchanged.

---

## [0.6.0] — 2026-06-15

### Added

- `min_retry_seconds` on service `rate_limit` config — enforces a minimum retry-after floor
  for HTTP 429 responses, overriding short `Retry-After` header values.

---

## [0.5.0] — 2026-06-13

### Added

- **`update_record` operation on AirtableAdapter** — PATCH an existing record by `record_id` (`update('update_record', { table, record_id, fields, typecast? })`). Previously the only update path was `upsert_record`, which requires merge fields and can create rows.
- **`delete_records` operation on AirtableAdapter** — batch delete of 1–10 record IDs in a single API call (`delete('delete_records', { table, record_ids })`, Airtable's per-call limit). No internal chunking — more than 10 IDs is a validation error, keeping each step's evidence atomic. The adapter docs recommend `trust: human_confirmed` on delete steps.
- **`sort` support on AirtableAdapter `list_records`** — pass `sort: [{ field, direction? }]` to order results server-side; previously ordering required a pre-built Airtable view.
- **Bounded auto-pagination on AirtableAdapter `list_records`** — opt-in via `fetch_all: true` with two caps, whichever hits first: `max_pages` (default 3, hard cap 10) and `max_bytes` (default 100000 ≈ 25K LLM tokens, hard cap 1000000). On truncation the response carries `truncated: true`, a `truncation_reason` of `page_limit`/`byte_limit`, and the resume `offset`. Unbounded fetch-all is impossible by design.
- **`search_records` operation on AirtableAdapter** — text search across author-named fields, built as an Airtable `FIND`/`OR` formula with the search term escaped (`"` and `\`) to prevent formula injection. `fields` is required: the adapter has no schema discovery by design.
- **AirtableAdapter section in `docs/reference/adapters.md`** — full operation reference (params tables, YAML examples, error mapping), including context-budget guidance for `fetch_all` (~4 bytes ≈ 1 token).

### Changed

- **AirtableAdapter 4xx errors now preserve Airtable's error body** — the API's `error.message` is appended to the thrown message and `error.type` is recorded as `details.airtable_error_type` (previously discarded except on 422). 401 errors add a PAT-format hint when the configured key looks malformed (the key itself is never included). Error codes, categories, and agent actions are unchanged.

---

## [0.4.0] — 2026-06-11

### Added

- **`warn` return type on `StepHandlerResult`** — handlers can now return `{ data, warn: { message: "..." } }` to complete a step normally while recording an advisory warning. The warning is stamped on the evidence snapshot as `EvidenceSnapshot.warn` (never hashed) and surfaced in `ResponseEnvelope.warnings[]`. A warned result is unconditionally final — the retry loop does not retry it. Warnings from intermediate steps in an auto-chain are accumulated per step on `chained_auto_steps[].warnings` and folded into the final envelope's `warnings[]` in chain order.
- **`run.params` in `when:` conditions** — `when:` expressions can now reference run start params via `run.params.<field>` (e.g. `when: "run.params.mode == 'live'"`), alongside the existing `step_id.field` form. Evaluated consistently across step eligibility, guard eligibility, and skip propagation, so a step whose `when:` is statically false for the run's params is skipped cleanly and the run reaches terminal state.
- **Shadow mode convention** — documented in the YAML schema reference: pass `{ mode: "shadow" }` as a run param and annotate side-effect steps with `when: "run.params.mode == 'live'"` to run a workflow in shadow mode without maintaining a duplicate YAML copy.
- **`input_map` on handler steps** — the `uses_service` restriction on `input_map` is lifted; any `execution: auto` step (handler or adapter) can now declare `input_map`. `callHandler` resolves it against run params and prior step evidence (including `$literal` leaves) and passes the result as the handler's `params`. Resolved params are recorded on the evidence snapshot as `resolved_params`, same as adapter steps.
- **`_debug` capture on `execute_step`** — agents can submit a `_debug` field alongside business output to capture reasoning. It is extracted before schema validation and stored on the evidence snapshot as `debug_output` — never validated, never included in `evidence_hash`, never present in `input_summary`, and never forwarded to handlers, service adapters, or the dispatcher.

### Changed

- **Step names `run` and `context` are now reserved** and rejected at workflow registration time — they collide with the `run.params` namespace in `when:` conditions and the `context.resources` namespace in `input_map`. Migration: rename any step using these names (none expected in practice; such steps were never addressable in `when:` path expressions).

---

## [0.3.0] — 2026-06-04

### Added

- **`$literal` sentinel in `input_map`** — workflow YAML authors can now write `{ $literal: <value> }` as a leaf node in `input_map` to inject a static scalar value (string, number, boolean, or null) directly, without any dot-path resolution. Validated at registration time: sibling keys alongside `$literal` and non-scalar values are rejected with a clear error message.
- **Handler graceful abort via `result.abort`** — handlers can now return `{ abort: { message: "..." } }` to cleanly stop a run with `run_phase: 'aborted'` instead of throwing an `Error` (which produces `run_phase: 'failed'`). Mirrors the `execution: guard` abort path. The aborting step is recorded in evidence with `status: 'skipped'`; all downstream steps are skipped; `aborted_at.abort_message` is set on the run record.
- **`uses_resources` on `StepHandler`** — handlers can declare `readonly uses_resources?: readonly string[]` listing the step IDs they read from `context.resources`. When declared, the YAML loader validates at `realm register` time that every listed ID exists in the workflow definition. Missing IDs produce a clear error identifying the step, handler, and the missing resource step ID. Purely informational at runtime — the engine does not filter `context.resources`.

### Changed

- `StepHandlerResult.data` is now optional. Handlers that return only `abort` or `state_update` no longer need to include an empty `data: {}`.
- `RunRecord.aborted_at.conditions` is now optional. Guard aborts continue to populate it; handler aborts set `aborted_at` without a conditions array.

---

## [0.2.0] — 2026-06-03

### Added

- **`execution: guard` step type** — a new step kind that evaluates `abort_unless` conditions against resolved run state. If any condition is not met the run transitions to `run_phase: aborted` and no further steps execute. Guard steps appear in `chained_auto_steps` and always run as auto steps. See the [YAML schema reference](docs/reference/yaml-schema.md) for the full condition syntax.
- `abort_context` on `get_run_state` — when `run_phase` is `aborted`, the response now includes the guard step ID, each evaluated condition with its resolved value, and the optional `abort_message` authored in the workflow YAML.
- **`config_schema`** field on service adapter definitions — a JSON Schema that validates the `config` object passed from a step's `config` field before the adapter is invoked. Invalid configs produce a structured validation error without reaching the adapter.
- `config` pass-through on steps — workflow step definitions now accept an optional `config` object forwarded verbatim to service adapters that declare `config_schema`.
- **`start_run_batch` MCP tool** — atomically enqueues multiple child workflow runs in a single call. All items are validated before any run is created (all-or-nothing semantics). Each item accepts `workflow_id`, `params`, and an optional `idempotency_key` for safe re-runs.
- `parent_run_id` field on `RunRecord` — links child runs to their originating parent run for lineage tracking.
- `idempotency_key` field on `RunRecord` — deduplication key for `start_run` and `start_run_batch` calls. The `JsonFileStore` deduplicates by key within a workflow: a second create with the same key returns the existing run.
- `parent_run_id` and `idempotency_key` optional fields on `start_run` MCP tool.
- `max_fan_out` step field — caps the number of `start_run` / `start_run_batch` calls permitted within a single agent tool-calling loop. Validated at workflow registration (must be a positive integer).
- New error codes `VALIDATION_BATCH_TOO_LARGE` and `VALIDATION_BATCH_ITEMS` in `ErrorCode` union.
- New exported type `InputMapNode` — a recursive union type (`string | { [key: string]: InputMapNode }`) representing a leaf source-path string or a nested map used for nested object construction in `input_map`.
- `input_map` now supports nested object construction. Object nodes assemble a plain nested object by recursively resolving their children as source paths. Maximum depth is 10. Empty object nodes and non-string leaves are rejected at workflow registration time with a clear error message.
- **Agent profile runtime injection** — `agent_profile_instructions` from the MCP protocol step response is now prepended to the LLM system prompt at runtime by the Anthropic and OpenAI providers. Previously the field was present in the protocol but not consumed by the agent loop.

### Changed

- `WorkflowDefinition.input_map` value type changed from `string` to `InputMapNode` (`string | { [key: string]: InputMapNode }`). Runtime behaviour is unchanged for all-string `input_map` blocks.
- `@sensigo/realm-mcp`: individual MCP tool modules are now accessible as subpath exports (`@sensigo/realm-mcp/tools/<name>`).

### Fixed

- MCP server: version assertion now uses a semver pattern regex instead of a hardcoded string, so it no longer needs updating on each release.

### Security

- **ReDoS in `render-template`**: removed `\s*` anchors and excluded `{` from the template variable capture group (`[^}]+?` → `[^{}]+`) to eliminate polynomial backtracking on adversarial inputs containing repeated `{` characters or trailing spaces.
- **CodeQL alerts**: patched Gorgias adapter tag-stripping loop to handle nested-tag bypass patterns (e.g. `<scr<x>ipt>`); replaced sequential entity-escape calls with a single-pass regex to prevent double-unescaping; tightened precondition literal capture group (`(.+)` → `(\S.*)`) to remove leading-whitespace backtracking ambiguity.

### Breaking Changes

- TypeScript API: `StepDefinition.input_map` values are now `InputMapNode` instead of `string`. TypeScript consumers that read values as `string` must narrow: `if (typeof value === 'string') { ... }`.

---

## [0.1.0] — 2026-06-01

### Added

- **Step Trace A1 — contract hardening**: `execute_step` now accepts an optional top-level
  `trace` array of `{ event, timestamp?, data? }` entries alongside `params`. The engine
  canonicalizes submissions in a single pass (deterministic seq assignment, 100-char event cap,
  500-char string-value cap, 20-key data cap, 100-entry / 50 KB hard limits, reserved `trace.`
  prefix drop) and persists the result as `trace`, `trace_digest`, and `trace_summary` on the
  `EvidenceSnapshot`. `evidence_hash` is unaffected — it covers `output_summary` only. Trace is
  silently dropped for non-agent steps. `realm run inspect` shows a compact summary line and a
  yellow warning when the trace was truncated.
  - _Correction 1_: reserved-prefix check now runs on the normalized event (post-trim), so
    whitespace-padded variants like `"  trace.internal"` are correctly dropped. Byte limit now
    uses `Buffer.byteLength(…, 'utf8')` instead of JS string length, giving accurate enforcement
    for multi-byte Unicode payloads. `realm run inspect` truncation warning now reports total
    `discarded_entries` (reserved + overflow) rather than overflow-only.

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

1400 tests across all packages (1020 core, 278 CLI, 55 MCP, 47 testing).
