# CLI Reference

All `@sensigo/realm-cli` commands. Run `realm <group> <command> --help` for full option details.

---

## Project extensions across commands

Workflows may declare custom adapters/handlers/processors via a top-level `extensions:` key —
see the [Project extensions guide](project-extensions.md). Command behavior:

| Command                        | Behavior                                                                                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `run`, `agent` (fresh)         | Extensions load **before the run is created** — a broken module means no run.                                                                    |
| `agent --run-id`               | Extensions load before the run is claimed. Pre-execution failure marks the run `terminal_reason: 'extensions_load_failed'` (see recovery below). |
| `listen`                       | Loads every routed workflow's extensions at startup (fail-fast); registers each workflow **once** at startup. Children re-resolve at spawn.      |
| `serve`, `mcp`                 | Per-definition registries via a **process-lifetime cache** — restart the process to pick up module content changes.                              |
| `workflow register`, `watch`   | Full module load + validation + `config_schema` two-pass **before persisting** (each watch reload re-validates).                                 |
| `workflow test`                | Extension handlers run real; unmocked extension adapters fail the fixture (tripwire).                                                            |
| `workflow validate`            | Declaring workflows get two-pass `config_schema` validation against the resolved registry.                                                       |
| `run replay/inspect/list/diff` | Never load extension code.                                                                                                                       |

**`--project <dir>`** (on `agent`, `run`, `serve`, `mcp`) — the CONFIG anchor: the
deployment root whose [realm.yaml](deployment-manifest.md) applies to definitions without a
stored trust_root (agent-created, from-string). Defaults to the current directory for the
operator-launched `agent`/`run`/`serve`; **`realm mcp` has NO default** — its stdio cwd is
client-controlled, so the manifest loads only when `--project` is explicitly configured
(recorded security decision).

**Sentinel secret mode:** `validate` and `test` resolve `${secret:NAME}` references to
labeled sentinels (no real credentials; constructor failures become warnings);
`register`/`watch` resolve real secrets when available and degrade with a loud WARN when
not. Execution paths always require real resolution.

**`--extensions-module <path>`** (on `agent`, `run`, `serve`, `mcp`, `validate`, `test`)
REPLACES the workflow's declared modules for that invocation — a loudly-logged repair/override
tool, not the primary mechanism.

**Recovering `extensions_load_failed`:** fix the module (or pass `--extensions-module`), then
re-run `realm agent --run-id <id>` — attaching to a run whose terminal reason is exactly
`extensions_load_failed` clears that marker and retries (nothing executed before the failure).
All other terminal reasons keep the normal refusal.

**Drift evidence:** runs of extension-declaring workflows carry an append-on-change
`extension_identity` history (see the
[Project extensions guide](project-extensions.md#drift-evidence)). `realm agent --run-id`
WARNs on stderr when the freshly loaded extension code differs from the run's last recorded
identity — advisory only, never a gate; the new identity is appended at the next executed
step. `realm run inspect <run-id>` renders the history; `realm run inspect <run-id>
--check-drift` recomputes the last entry against current disk state with pure hashing
(read-only commands never load project code).

**Restart semantics for long-lived processes:** `listen`, `serve`, and `mcp` cache extension
registries for the process lifetime and never re-import changed module content — restart the
process after rebuilding extension modules. Also restart `realm listen` after re-registering a
workflow: it serves the definitions snapshotted at startup (and if two listen instances mount
the same workflow from different directories, the last registration wins for `source_dir`).

---

## Workflow commands

Operations on workflow definitions and YAML files.

---

### `realm workflow init <name>`

Scaffolds a new workflow project directory.

```bash
realm workflow init my-workflow
```

Creates `my-workflow/` containing `workflow.yaml`, `schema.json`, `.env.example`, and `README.md`.

---

### `realm workflow validate <path>`

Validates a workflow YAML without registering it. Reports schema errors, duplicate step IDs,
and invalid `depends_on` references.

```bash
realm workflow validate ./my-workflow
realm workflow validate ./my-workflow --strict   # fail (exit 1) if any warning is present
```

Workflows declaring `extensions:` (or validated with `--extensions-module <path>`) are loaded
file-based, their extension modules are loaded, and step `config` is then validated against each
resolved adapter's `config_schema` (two-pass). Extension-free workflows keep the historical
string-based validation surface — a deliberate strictness asymmetry (file-context checks like
agent-profile resolution only run for declaring workflows).

**`--strict` (issue #169):** by default, a non-fatal loader warning (an unknown workflow/step key,
a retry-without-timeout advisory, a sentinel-credential fallback) is printed but the command still
exits `0` — the workflow is `Valid:` regardless. `--strict` changes that: if **any** warning is
present, the summary line names the count and the command exits `1` instead. Nothing is checked
that isn't already checked without the flag — `--strict` only changes what counts as success, so
it's meant for CI gates that want to catch a typo before it reaches `register`.

```bash
$ realm workflow validate ./my-workflow
⚠ step 'sync_data': unknown key 'dependson' (line 14) — REFUSED below (did you mean 'depends_on'?)
Invalid: 1 warning(s) present, and at least one is escalated to an error by policy.
$ echo $?
1
```

An unrecognized key is refused with or without `--strict` ([issue #170](https://github.com/sensigo-hq/realm/issues/170)),
and the policy check runs first — so this class never reaches the `failing due to --strict` line
any more. `--strict` still does its job for everything that is genuinely a warning: a retry
advisory, a dead config block, an unrecognized key inside `retry:` or `gate:`. Those keep printing
`— ignored`, because on those the key really is ignored.

`realm run`, `realm agent`, and `realm listen` are unaffected — they load leniently, so a workflow
already deployed with an unknown key keeps running.

The `(line 14)` is the line the offending key sits on ([issue #392](https://github.com/sensigo-hq/realm/issues/392)).
Step-scoped errors carry the line of their own step, so a step that trips several checks reports
one line for all of them rather than a different one per message. Workflow-scoped errors — a
dependency cycle, a missing required field, a bad `services` entry — do not carry a line yet; some
of them, like a missing field, have no key in the file to point at. A position is omitted rather
than approximated whenever it cannot be resolved exactly.

**The `structured_output` adoption nudge (issue #236):** for every `execution: agent` step with an
effective schema, `validate` also prints, on its own informational line (`ℹ`, never a `⚠`
warning), whether that step is eligible for `structured_output: strict` and what — if
anything — stands in the way. This is pure information: it never affects `--strict`'s exit code,
and it prints whether or not the step has actually opted in (an opted-in step's OWN caveats print
here too). See [`structured_output`](yaml-schema.md#structured_output-anthropic-strict-decoding)
for the full gate table.

```bash
$ realm workflow validate ./my-workflow
Valid: my-workflow v1 (2 steps)
ℹ Step 'classify': structured_output: strict — one line short: add additionalProperties: false at 'the schema root'
```

---

### `realm workflow register <path>`

Registers a workflow in the local store (`~/.realm/workflows/`). Increments the version number
on each call. Fails immediately if any agent profile declared in the workflow is not found in
`profiles_dir`.

```bash
realm workflow register ./my-workflow
realm workflow register ./my-workflow --strict   # refuse to persist if any warning is present
```

Registering **mints the trust decision** for project extensions: when the workflow declares
`extensions:`, the modules are fully loaded and duck-validated and step `config` gets the
`config_schema` two-pass — all **before** anything is persisted. See the
[Project extensions guide](project-extensions.md).

**`--strict` (issue #169):** same warning surface as `validate --strict` (see above), but the
consequence is stronger — a warning-bearing workflow is never written to the store at all
(`store.register` is not called), and the command exits `1`. Without `--strict`, registration
proceeds as always: the workflow is persisted and every warning is printed alongside the
`Registered:` line.

---

### `realm workflow watch <path>`

Watches a workflow YAML file and re-registers it into the local store on every change.
Performs an initial registration immediately on startup, then re-registers whenever the
file is modified — no manual `realm workflow register` required during active development.

```bash
realm workflow watch ./my-workflow
realm workflow watch ./my-workflow/workflow.yaml   # or point directly at the file
```

Press `Ctrl+C` to stop watching.

Errors from an invalid YAML edit are logged (with a timestamp) to stderr but do not crash
the watcher — fix the file and save again to recover.

**Development inner loop:**

1. Start `realm workflow watch ./my-workflow` in one terminal.
2. Edit `workflow.yaml` freely — every save auto-registers.
3. Run `realm workflow run ./my-workflow` or start your MCP session in another terminal.

---

### `realm workflow run <path>`

Runs a workflow interactively in development mode. For each agent step, prompts for JSON output.
For human gates, prompts for approval. Use this to exercise the full workflow without an
AI agent.

```bash
realm workflow run ./my-workflow
realm workflow run ./my-workflow --params '{"company_name":"Acme"}'
```

---

### `realm workflow test <path>`

Runs fixture-based tests against a workflow. Loads fixtures from the specified directory,
executes each scenario with mocked services and pre-built agent responses, and checks expected
final states and step outputs.

```bash
realm workflow test ./my-workflow --fixtures ./my-workflow/fixtures/
```

Fixture format (`fixtures/happy-path.yaml`):

```yaml
workflow: my-workflow
description: 'Complete happy-path run'
params: {}
steps:
  gather_input:
    output:
      summary: 'the collected information'
expected_final_state: completed
```

---

### `realm workflow migrate`

Back-fills the `origin` field on workflow definition files created before provenance tracking
was introduced. Run this once after upgrading from an older version of Realm if
`realm run inspect` shows missing `origin` values in workflow metadata.

```bash
realm workflow migrate
```

Scans `~/.realm/workflows/`, adds `origin: human` to any file that does not already have an
`origin` field, and reports how many files were migrated vs. already up to date. Safe to run
more than once — files that already have `origin` are skipped.

---

## Standalone agent

---

### `realm agent`

Runs a workflow end-to-end using a real LLM — no MCP client, no IDE, no running server.
Auto steps execute immediately; agent steps are driven by the LLM; human gates pause until
a choice is submitted.

```bash
realm agent \
  --workflow ./my-workflow \
  --params '{"key":"value"}'
```

| Option                     | Default          | Description                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--workflow <path>`        | (required)       | Path to `workflow.yaml` or its containing directory                                                                                                                                                                                                                                                                                                                                  |
| `--params <json>`          | `{}`             | Run params as a JSON string                                                                                                                                                                                                                                                                                                                                                          |
| `--provider <name>`        | auto             | LLM provider. Values: `openai`, `anthropic`. Auto-detected from whichever API key is set.                                                                                                                                                                                                                                                                                            |
| `--model <name>`           | provider default | Model name override. Default: `gpt-4o` for OpenAI, `claude-sonnet-4-5` for Anthropic.                                                                                                                                                                                                                                                                                                |
| `--base-url <url>`         | —                | Base URL for OpenAI-compatible endpoints (DeepSeek, Qwen, Groq, etc.). Only valid with `--provider openai` or when `OPENAI_API_KEY` is set.                                                                                                                                                                                                                                          |
| `--strict-base-url`        | off              | Attest that the `--base-url` endpoint genuinely enforces structured-output strict mode (issue #313). Without it, strict is never sent to a compat endpoint and every strict-declared step records `compat_endpoint`. An attestation, not a verification — realm cannot detect an endpoint that accepts strict and ignores it. Affects opted-in steps only.                           |
| `--provider-module <path>` | —                | Path to a custom provider module. Cannot be combined with `--provider`, `--model`, `--base-url`, or `--strict-base-url`. See [Custom providers](#custom-providers) below.                                                                                                                                                                                                            |
| `--register`               | off              | Persist the workflow to `~/.realm/workflows/` so `realm run inspect` resolves it by ID                                                                                                                                                                                                                                                                                               |
| `--run-id <id>`            | —                | Attach to an existing run instead of creating a new one. Mutually exclusive with `--workflow`. The run must exist, must not be in a terminal state, and its workflow must be registered (`--register` at first run, or `realm workflow register <file>`) — a run created from an unregistered file cannot be re-attached, because the definition was never persisted.                |
| `--schema-retries <n>`     | `2`              | In-drive repair attempts when an agent step's output/input is rejected by schema validation (issue #217) — the drive re-prompts with the validator's errors appended. Non-negative integer; `0` disables.                                                                                                                                                                            |
| `--llm-timeout <seconds>`  | `600`            | Per-ATTEMPT ceiling for each model request (issue #401). A step's own `llm_timeout_seconds` wins; this fills in for every step that authored nothing. Positive integer. When a request exceeds the derived ceiling the drive stops, records `aborted_by_budget` with the derived ceiling, plus the declared per-attempt value when a step or the flag set one, and names this lever. |

**LLM key:** set `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` in your shell or `.env` file. The
CLI loads `.env` automatically on startup.

**Gate handling:** when the run reaches a human gate, `realm agent` prints the gate message
and a `realm run respond` command. Optionally configure Slack so the message is delivered
there and the gate can be resolved from a Slack thread reply. The active Slack mode is
selected automatically from the env vars that are present:

| Env vars set                                                    | Gate mode                                                                             |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| (none)                                                          | Terminal-only. Gate message printed to stdout. Respond with `realm run respond`.      |
| `SLACK_WEBHOOK_URL`                                             | **Mode 1** — gate notification posted to Slack. Terminal command required to respond. |
| `SLACK_BOT_TOKEN` + `SLACK_CHANNEL_ID` + `SLACK_APP_TOKEN`      | **Mode 2** — Socket Mode. Reply in Slack thread; resolves in < 1 s.                   |
| `SLACK_BOT_TOKEN` + `SLACK_CHANNEL_ID` + `SLACK_SIGNING_SECRET` | **Mode 3** — Events API. Reply in Slack thread; resolves in < 1 s.                    |

For step-by-step Slack app setup and the full env var reference, see
[Slack Gate Modes](./realm-agent-slack.md).

**OpenAI-compatible endpoints:** use `--base-url` to point `realm agent` at any OpenAI-compatible
API, including cost-efficient alternatives:

```bash
# DeepSeek
OPENAI_API_KEY=sk-... realm agent --workflow ./my-workflow \
  --model deepseek-chat \
  --base-url https://api.deepseek.com/v1

# Groq
OPENAI_API_KEY=gsk_... realm agent --workflow ./my-workflow \
  --model llama-3.3-70b-versatile \
  --base-url https://api.groq.com/openai/v1
```

**OpenAI reasoning models:** o1-series models (o1, o1-mini, o1-preview) do not support tool
calling. If your workflow uses MCP tool-enabled steps, `realm agent` exits at startup with an
error when an o1-series model is selected. Use `--model gpt-4o` (or any non-o1 model) or
`--provider anthropic` to run tool-enabled workflows. All other OpenAI models — including o3,
o3-mini, and o4-mini — support tool-enabled steps.

**Custom providers:** use `--provider-module` to supply a fully custom LLM implementation.
The module must export an instance (not a class) extending `LlmProvider` from
`@sensigo/realm-cli/agent`:

```typescript
// my-provider.ts
import { LlmProvider } from '@sensigo/realm-cli/agent';

class MyProvider extends LlmProvider {
  async callStep(prompt: string, inputSchema?: Record<string, unknown>) {
    // call your LLM here
    return { result: '...' };
  }
}

export default new MyProvider();
```

```bash
realm agent --workflow ./my-workflow --provider-module ./my-provider.js
```

`--provider-module` cannot be combined with `--provider`, `--model`, `--base-url`, or `--strict-base-url`.
If the default export is not an instance of `LlmProvider`, `realm agent` exits with a
descriptive error before the run starts.

---

## Run commands

Operations on workflow run instances stored in `~/.realm/runs/`.

---

### `realm run list`

Lists all runs, sorted by most recent first.

```bash
realm run list
realm run list --workflow <workflow-id>   # filter by workflow
realm run list --status <phase>           # filter by run phase
realm run list --stuck                    # only wedged/idle runs (typed run-health classification)
realm run list --stuck --older-than 6h    # override the idle-age threshold (default 24h)
```

Valid `--status` values: `running`, `gate_waiting`, `completed`, `failed`, `abandoned`, `aborted`.

When filtering by `gate_waiting`, each line also shows the gate step name and gate age (time since the gate opened).

`--stuck` (mutually exclusive with `--status`) shows only runs `classifyRunHealth` (issue #221)
flags — the SAME shared predicate `get_run_state`/`inspect` (the other two READ surfaces) derive
from (`reclaim` reads the same underlying record facts via its own independent discriminator; it
does not call this function). **Nine finding kinds select a run onto this list:** a stale or
unknown-age claim, a wedged non-gated sibling on a `gate_waiting` run, a capability block, a
`running` run with no claimed step idle for at least the active threshold (default 24h — printed
in the header as `(threshold 24h)`), a terminal run with an undrained finalizer, a failing drive,
an expired gate, a corrupted gate record, and a terminal run still carrying a pending gate.

A tenth kind, `resolved_gate_with_eligible_guard`, is **structurally absent here**: its producer
requires a workflow definition and `list` classifies definition-free, so it never fires on this
surface. Two further kinds never select: `completed_with_failed_steps` (issue #302) and
`structured_output_downgraded` (issue #316) — a completed run and a degraded-assurance disclosure
are not "stuck" symptoms. Either can still appear on a run selected by one of the nine. The never-claimed check is **age-gated**: a
run simply between agent drives is no longer flagged the instant its last claim settles (a
disclosed behavior change from the prior unconditional check — see the CHANGELOG). Each flagged
line appends its idle age plus finding labels.

**The labels**, one per finding kind that carries one:

| label                                             | means                                                                                                                                 |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `<step>=claim_stale` / `<step>=claim_unknown_age` | the step's claim is past its deadline, or carries no deadline to judge by                                                             |
| `<step>=wedged_gate_sibling`                      | a non-gated sibling step is wedged behind an open gate                                                                                |
| `<step>: needs <kind> '<name>'`                   | the step is blocked on a capability the registry does not have                                                                        |
| `<step>=<reason> (realm run drain)`               | a terminal run with an undrained finalizer — the pointer is the fix                                                                   |
| `<step>=drive_failing(<class>)`                   | the drive died on this step; `<class>` is the failure class (fuller vocabulary in [mcp-protocol.md](mcp-protocol.md))                 |
| `<step>=gate_expired(<disposition>)`              | the gate is past `expires_at`; the disposition is `abort`, `settle_default`, or `finding_only` — what, if anything, will enact itself |
| `<step>=gate_corruption`                          | a settled gate entry coexists with a live pending gate of the same id — a store that diverged, not an engine path                     |
| `<step>=stale_gate (realm run purge)`             | a terminal run still carrying a pending gate (a grandfathered record); the pointer is the fix                                         |

`never_claimed_idle` carries no label of its own: it IS the reason the run is listed, and the
header's threshold already says so. `--older-than <duration>` overrides the idle-age
threshold (e.g. `30m`, `6h`, `7d`; requires `--stuck`); `--older-than 0m` restores the old
unconditional breadth (bare `0` is rejected — use `0m`). This is a different flag from `realm run
reclaim --older-than`, which is a deadline-margin add-on for `--all` auto-reclaim selection, not
an idle-age threshold. See [Operating & recovering runs](operating-runs.md).

Output per run: `run-id  workflow-id vN  run_phase  timestamp  N step(s)`

`N step(s)` is the count of distinct steps that produced evidence (retried steps count once;
gate responses are excluded). This is the same count shown in
`realm run inspect` under `Evidence (N steps):`.

State colors: green = completed, red = failed/abandoned, cyan = gate_waiting, yellow = in-progress.

---

### `realm run inspect <run-id>`

Prints the full run record and evidence chain for a workflow run. This is the primary
debugging tool — use it whenever a run fails, gets stuck, or produces unexpected output.

```bash
realm run inspect abc12345-0000-0000-0000-000000000000
realm run inspect abc12345-0000-0000-0000-000000000000 --check-drift
```

For runs of extension-declaring workflows, the output includes the `Extension Identity`
history (drift evidence: per-module entry hashes, the dir_tree_v1 fingerprint, signals,
override/error flags, and the coverage sentence). `--check-drift` recomputes the LAST
recorded entry against current disk state under its recorded rules — pure hashing, no
code loading — and prints same/DIFFERS/MISSING per component. See the
[Project extensions guide](project-extensions.md#drift-evidence).

#### Output format

```
Run: abc12345-0000-0000-0000-000000000000
Workflow: incident-response v3
Phase: completed  ✓

Created: 2026-01-15T10:30:00.000Z
Updated: 2026-01-15T10:30:42.000Z

Evidence (3 steps):

  1. read_alert                success    12ms   hash: f3a9b2c1
     Input:    {}
     Resolved: {"path":"/tmp/alert.md"}
     Output:   {"content":"## SEV-2 Alert\nDisk usage on prod-db-1 at 94%","line_count":14}
     Diagnostics: ~22 tokens | no preconditions

  2. analyze_cause             [profile: senior-sre] success   8432ms   hash: 2d7e4f81
     Input:  {"content":"## SEV-2 Alert\nDisk usage on prod-db-1 at 94%"}
     Output: {"root_cause":"log_rotation_disabled","severity":"sev2","affected_system":"prod-db-1"}
     Diagnostics: ~1840 tokens | preconditions: analyze_cause.result.content != "" → true ("")

  3. draft_response            [profile: senior-sre] success   5211ms   hash: 9c3b1a0f
     Input:  {"root_cause":"log_rotation_disabled","severity":"sev2","affected_system":"prod-db-1"}
     Output: {"message":"SEV-2 on prod-db-1: log rotation was disabled causing disk accumulation…"}
     Diagnostics: ~2100 tokens | preconditions: draft_response.result.root_cause != "" → true (log_rot…)
```

#### The seal, and any ruling on it (issue #367)

A terminal run renders the recorded fact that ended it, directly above the evidence:

```
Sealed by: guard_abort (g)
Cause: Guard 'g' aborted the run.
```

The step in parentheses appears only where the step IS the seal's identity — a guard, a gate, or a
handler abort. A run that failed in several places does not name one of them here, because the step
recorded on that kind of seal is whichever one settled last, and printing it directly above the
cause line would read as the culprit.

`(recovered by classifier)` after the arm means the run predates the seal substrate and the engine
recovered its arm on read rather than reading a stamped one. Both are the truth about the run; the
marker tells you which kind of truth it is.

When an operator has adjudicated the seal, one further line records who and when:

```
Sealed by: complete
Ruled: mihai at 2026-08-21T00:00:00.000Z (was step_failure) — the retry succeeded; the earlier failure is not the outcome
```

`(was <arm>)` names the arm the ruling replaced; a first stamp on a record that never had one reads
`(first stamp — no prior arm existed)` instead. The reason, when the ruling carries one, is printed
verbatim and never shortened.

**`by` is a recorded CLAIM of identity, not a verified one:** there is no auth model behind it, so
treat it as attribution-by-assertion. The run's own prose is never rewritten to match a ruling — it
stays as the historical evidence of what the engine said at the time.

**State colors:** green = completed, red = failed or abandoned, yellow = anything else (including gate_waiting and in-progress).

**Output truncation:** Input and Output fields are truncated at 120 characters. A `…` suffix
indicates truncation — use `realm run replay` to re-evaluate with modified values.

**Human gate steps:** A gate step appears in the evidence chain as a single entry — the same
step ID covers both the gate opening (when the engine paused for human input) and the gate
response (when a choice was submitted via `realm run respond`). The step count does not
increase when a gate is responded to. When `gate.message` is configured, the inspect output
shows a `Message:` line under `Choice:` with the exact text the human saw at decision time.

#### Field reference

| Field                          | What it tells you                                                                                                                                                                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Phase**                      | Current run phase (`run_phase`). Terminal runs show `✓` (completed) or no suffix (failed/abandoned).                                                                                                                                              |
| **Evidence (N steps)**         | Number of distinct steps that produced evidence. Steps with multiple attempts are counted once. Human gate steps are counted once regardless of whether the gate has been responded to.                                                           |
| **Step number**                | Execution order, 1-based.                                                                                                                                                                                                                         |
| **Step name**                  | The `id` of the step in your workflow YAML.                                                                                                                                                                                                       |
| **`[profile: ...]`**           | Which agent profile handled this step. Present on agent steps only; absent on auto steps and human gates.                                                                                                                                         |
| **Status**                     | `success` (green), `error` (red), or other engine-assigned state (yellow).                                                                                                                                                                        |
| **Duration**                   | Wall-clock time the step took to complete. High values on agent steps are normal.                                                                                                                                                                 |
| **`hash: XXXXXXXX`**           | First 8 characters of the SHA-256 chain hash. The hash covers all evidence up to and including this step — it changes if any prior step's output changes. Use it to detect replay divergence.                                                     |
| **Input**                      | What the caller passed to the step. For the first step: the run params. For subsequent steps: the output of the prior step. For `input_map` steps this is typically `{}` — see **Resolved** for the actual adapter params.                        |
| **Resolved**                   | The params the service adapter actually received, assembled by the engine from `input_map` dot-paths. Only present on `execution: auto` steps that declare `input_map`. The token estimate in Diagnostics is computed from this value, not Input. |
| **Output**                     | What the step produced. For agent steps: the JSON the AI returned. For auto steps: the handler return value. For adapter steps: the raw adapter response injected by the engine.                                                                  |
| **Diagnostics: `~N tokens`**   | Estimated token count of the context window passed to the agent for this step. Useful for spotting steps that approach model context limits.                                                                                                      |
| **Diagnostics: preconditions** | Each precondition expression, whether it passed (`→ true`) or failed (`→ false`), and the resolved value in parentheses. If a step ran unexpectedly or was blocked, this is where you look.                                                       |

#### What to look for

**Run failed — step shows `error`:**
Read the failed step's `Output` field. For handler steps, the error message is in the output.
For agent steps, the output may be missing required fields — compare its shape against the
`input_schema` of the step that consumes it in your workflow YAML.

**Run stuck at a gate (`gate_waiting` state):**
The state line will show `gate_waiting` in yellow. Look at the last entry in the evidence
chain — it will be the step that produced the gate. Submit the gate response with
`realm run respond <run-id>`.

**Precondition blocked a step unexpectedly:**
Find the step that was supposed to run and look at its `precondition_trace`. Each expression
shows the actual resolved value in parentheses. The value will tell you whether the prior step
produced the right field name, type, or content. Cross-reference with the prior step's
`Output` field to see what was actually returned.

**Agent returned wrong output shape:**
Find the agent step in the evidence chain and read its `Output`. Compare the field names and
types against the `input_schema` of the next step in your YAML. The mismatch will be visible
— missing keys, wrong types, or extra nesting are common causes of precondition failures.

---

### `realm run resume <run-id>`

Resets a failed or abandoned run to a state where a specific step can re-execute.

```bash
realm run resume abc123 --from <step-name>
```

---

### `realm run abandon <run-id>`

Explicitly abandons a non-terminal run — marks it terminal with phase `abandoned`. Use it on a run
that is parked and not coming back (see `realm run list --stuck`).

```bash
realm run abandon abc123
realm run abandon abc123 --reason "stale runner, no longer processing"
```

Idempotent (abandoning an already-abandoned run succeeds). Refuses an already-terminal run, and
refuses a `gate_waiting` run (resolve the gate via `realm run respond` first). To re-run the same
work afterward, use `start_run` with `on_terminal_match: 'rerun'` or a fresh idempotency key — the
default returns the abandoned run. See [Operating & recovering runs](operating-runs.md).

`abort` is the graceful path and runs finalizers; `abandon` is a kill and runs nothing — use it
only when the run cannot be aborted normally. Every successful `abandon` prints this reminder.

---

### `realm run respond <run-id>`

Submits a human gate response interactively. Prompts for the gate choice.

```bash
realm run respond abc123
```

**Expiry-WINS (issue #291):** if the gate carries an authored `gate.timeout_seconds` and has
already expired unresolved when this is called, the response is **refused** with an honest
explanation of what actually happened instead — never silently recorded as if it arrived in time.
See [`gate.timeout_seconds`](yaml-schema.md#gate-timeout-authorable-enforce-notify-clocks) for
the full disposition/disclosure table.

---

### `realm run reclaim <run-id>`

Recovers a wedged claim (issue #101) — see [Operating & recovering runs](operating-runs.md).
Never enacts an expired gate itself, even when the same run also carries one: if it does, the
result carries an advisory pointing at `realm run drain --expired` as the enactment lever.

---

### `realm run drain [<run-id>] [--all]`

Delivers post-commit finalizers for a terminal run (crash-window recovery, issue #279). Dry-run
by default; `--force` actually drains. `--all` batch-drains every terminal run with an actionable
pending finalizer.

```bash
realm run drain abc123              # dry-run: report what would run
realm run drain abc123 --force      # actually drain
realm run drain --all --force       # batch-drain every actionable terminal run
realm run drain abc123 --void <finalizer>   # void one pending finalizer instead
```

**`--expired` (issue #291, opt-in):** without this flag, `drain` is byte-stable and
terminal-only — a non-terminal run with an expired gate is completely invisible to it, on both
per-run and `--all`. With `--expired`:

```bash
realm run drain abc123 --expired            # dry-run: also reports an expired gate
realm run drain abc123 --expired --force    # also enacts it (settle_default/abort per the frozen disposition)
realm run drain --all --expired --force     # batch: enacts every expired, enactable gate store-wide
```

A `settle_default` disposition may or may not terminalize the run (depends on the workflow's own
remaining steps); an `abort` disposition always does, and its finalizer terminalization flows
into the SAME `drain` pass. A finding-only gate (`timeout_seconds` with no `on_expiry`) is listed
as `expired — finding-only` and is **never** enacted, even under `--force`.

---

### `realm run replay <run-id>`

Re-evaluates workflow preconditions with modified step outputs. Shows what would change without
executing anything. Useful for tuning extraction schemas and precondition expressions.

```bash
realm run replay abc123
realm run replay abc123 --with "step_id.field=value"
```

**`--with` syntax:** `step_id.field_path=literal_value` where `step_id` is the step name,
`field_path` is a dot-separated path into the step's output, and `literal_value` is one of:

- `true` or `false` — boolean
- A number (e.g. `0.85`, `3`) — numeric
- A quoted string (e.g. `"high"`) — string
- An unquoted string (any other value) — treated as a string

Multiple `--with` flags may be specified. Each override applies to the in-memory replay
evidence only — no run record is modified.

---

### `realm run diff <run-a> <run-b>`

Compares the evidence chains of two runs side by side. Shows which steps produced different
results and which fields changed.

```bash
realm run diff abc123 def456
```

---

### `realm run cleanup`

Marks idle non-terminal runs as abandoned.

```bash
realm run cleanup --older-than 30d   # abandon runs idle for 30+ days
realm run cleanup --dry-run          # preview without making changes
```

`--older-than` accepts: `Nd` (days), `Nh` (hours), `Nm` (minutes). Example: `7d`, `6h`, `30m`.

---

### `realm run purge [<run-id>]`

Permanently deletes a terminal run and every co-located on-disk artifact — the run file, its
idempotency-key pointer, the `<id>.attempts.jsonl` sidecar, and any orphaned `trace-buffer-*.jsonl` WAL
files. **Irreversible.** Unlike `cleanup`/`abandon`, this does not just mark a run terminal — it
removes it from disk entirely. See
[Operating & recovering runs](operating-runs.md#purging-runs-permanent-deletion) for the full
abandon-vs-purge distinction.

```bash
realm run purge abc123                                            # dry-run: report what WOULD be deleted
realm run purge abc123 --force                                    # actually delete it
realm run purge --older-than 30d                                  # dry-run over a batch of eligible runs
realm run purge --older-than 30d --force                          # actually delete the batch
realm run purge --older-than 30d --workflow my-workflow --force   # restrict the batch to one workflow
```

Dry-run by default — even naming a single `<run-id>` only reports what would happen until you add
`--force` (naming a run is selection, not consent). `--older-than` accepts the same duration format as
`cleanup`: `Nd` (days), `Nh` (hours), `Nm` (minutes). `--workflow <id>` restricts a batch to one
workflow (only valid alongside `--older-than`).

The age a batch measures is **last activity**, not last progress — and recording a drive failure
counts as activity ([issue #401](https://github.com/sensigo-hq/realm/issues/401)). A run failing
continuously therefore never ages into a batch sweep — and, being non-terminal, it is not
purge-eligible at all. Stop the flapper, make the run terminal (abandon it, or `realm run
cleanup`), then purge.

**Safety posture:**

- **Terminal-only** — never touches a non-terminal or `gate_waiting` run.
- A run with a **future-deadline (`healthy`)** in-progress claim is **never purged, in either mode** —
  a runner is provably still working it, and there is no override.
- A run with an **indeterminate-age (`claim_unknown_age`, no deadline recorded)** claim is **skipped
  with a warning in batch mode** (a cron sweep cannot prove the runner is dead), but **is** purgeable
  via an explicit single-run `realm run purge <id> --force` — the operator naming the exact run is a
  deliberate judgment call a batch sweep won't make automatically.

Batch mode reports continue-on-error as purged / already-purged (a concurrent purge beat you to it —
not a failure) / failed, plus how many of the selected runs were resumable via `realm run resume` —
purging one destroys that path permanently.

---

### `realm run migrate --stamp-seals`

Materialises the recorded seal arm on every legacy terminal run (issue #367). Records written before
the seal substrate carry no `sealed_by`; the engine recovers their arm on every read wherever one
is recoverable — and where it is not, the run's phase still derives correctly from the legacy
ladder — so they are
already correct — this command writes that arm down, which is what makes it visible to external
readers and to the phase stored on disk.

Dry-run by default; `--force` writes. Each run lands in exactly one bucket:

| bucket          | meaning                                                                                                                                                                                                                     |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| stamped         | given its arm                                                                                                                                                                                                               |
| already stamped | had an arm. The report splits these three ways: checked against the record, **ruled by an operator** (a human looked at it — the ruling stands), and unverifiable because the record holds nothing to check the arm against |
| unclassifiable  | no arm and nothing to infer one from — **printed, never written**. Exit 0 (2 with `--detailed-exitcode`)                                                                                                                    |
| incoherent      | has an arm that DISAGREES with its own prose or markers — **printed, never auto-rewritten**. Exit 0 (2 with `--detailed-exitcode`). Adjudicate these yourself; a ruled record stops appearing here                          |
| skipped         | a concurrent writer moved the record; their own next write path owns it                                                                                                                                                     |
| failed          | an infrastructure error on one record; the sweep continues, exit 1                                                                                                                                                          |

**`updated_at` is preserved on every record it touches, and that is the whole point.** Stamping is
not activity. `realm run gc --heal` materialises the same phases but resets the retention clock on
everything it rewrites, so **run this command BEFORE `--heal` after upgrading across #367** if
those clocks matter to you.

`version` is bumped on stamped records, so a writer holding a pre-stamp snapshot loses its
compare-and-swap rather than silently erasing the stamp.

**Parked incoherent records: the format for adjudicating them is already published.** A recorded
seal arm is immutable while the run is terminal — every rewrite is refused — with exactly one lawful
exception: an adjudication write carrying truthful provenance (`by`, `at`, `previous_arm`, and
optionally `reason`). A ruling that misnames the arm it overwrote is refused exactly as hard as one
carrying no provenance at all, which is what keeps the chain walkable a step at a time. A truthful
SAME-arm ruling is legal too — that is how you close out a parked record you have examined and found
correctly stamped.

**A ruling supersedes the record's own prose.** The coherence check that normally guards a stamp is
skipped once a seal carries a ruling — permanently, not just on the write that records it — because
that check exists to catch SILENT drift and a ruling is the opposite of silent. The prose is never
rewritten to match: it is the historical evidence of what the engine said at the time, and the
ruling resolves the disagreement without falsifying it. A ruled record also stops appearing in this
command's incoherent bucket, which is what actually closes the loop.

Three consequences worth knowing before building on it. There is ONE provenance slot, so a second
ruling overwrites the first: the record tells you what the previous arm was, not the whole history
of rulings, and that loss is deliberate. Changing an arm requires a FRESH ruling — re-using a
previous one's provenance is a rewrite, not a ruling. And `by` is a recorded CLAIM of identity, not
a verified one: there is no auth model behind it, so treat it as attribution-by-assertion.

An adjudication write is ordinary activity — unlike stamping, it advances `updated_at` and
`version`.

**Where a ruling shows up.** `realm run inspect` renders it as a `Ruled:` line (above), and
`get_run_state` carries it as `sealed_by_adjudicated`. `export` carries the whole record verbatim,
as it always has. `realm run list` renders none of it — that surface shows one line per run and
rides a later increment.

The operator verb itself ships when it has a customer. The record format will not change when it
does.

**Residue** is the count the report ends on: terminal runs that will still have no recorded arm when
this run finishes. That is the unclassifiable ones plus any whose write failed — and, in a dry run,
the ones that would have been stamped, since a dry run writes nothing. Skipped records are reported
separately and never counted: their arm state is genuinely unknown until their own writer settles.

**Exit codes.** `0` means the command did its job — including when it found residue and said so.
`1` means the command FAILED at its job: a write errored, or the batch was refused. Residue is
chronic by nature (an unclassifiable record stays unclassifiable), so a nonzero exit on residue
would make every scheduled run fail forever, and a chronic alarm is one that gets silenced.
Automation that wants to gate on residue opts in with **`--detailed-exitcode`**, which makes it a
three-way: `0` clean, `1` the command failed, `2` succeeded but residue remains — the same contract
`grep`, `git diff --exit-code` and Terraform's `-detailed-exitcode` use, and opt-in for the same
reason they made theirs explicit.

> **One compatibility cost, owner-accepted and disclosed here once.** An export bundle taken BEFORE
> a record was stamped, then re-imported AFTER the sweep, will fail with `STATE_RUN_DIVERGED`: the
> bundle carries the pre-stamp version and the store has moved on. Re-export after migrating if you
> keep bundles for round-tripping.

### `realm run gc`

Sweeps orphaned atomic-write `.tmp` files — crash residue from a process that died between writing a
temp and renaming it over the target (a run record or an idempotency-key pointer). Unlike `purge`,
which acts by runId, `gc` cleans up files that belong to no specific run at all. See
[Garbage collection](operating-runs.md#garbage-collection-orphaned-atomic-write-temps) for the full
picture, including what it deliberately does NOT reap.

```bash
realm run gc --older-than 1h            # dry-run: report what WOULD be reaped
realm run gc --older-than 1h --force    # actually delete it
```

`--older-than` is **required** (no default — omitting it is an error, not "reap everything") and has a
**1-hour floor**: a smaller value is rejected outright, even with `--force`. Accepts the same duration
format as `cleanup`/`purge`: `Nd` (days), `Nh` (hours), `Nm` (minutes). Dry-run by default; `--force` to
actually delete.

Reaps top-level `*.tmp` files in `runsDir` and one level into `runsDir/keys/*.tmp`. Does **not** reap
orphaned `.lock` directories (deferred — issue #164) or run-less `trace-buffer-*.jsonl` WAL files
(issue #163) — the report always names both so you don't mistake their presence for a bug. A no-op on
Windows (no temp files are ever produced there).

**`--heal`** (issue #293, opt-in) — a one-shot pass that rewrites every run record whose _persisted_
`run_phase` disagrees with the phase re-derived from the record today, curing the residue left by a
pre-#282 binary (which could mis-derive `gate_waiting` for a run that had already reached a real
terminal outcome). This is pure population hygiene, not a correctness fix — every live read path
(`get_run_state`, `realm run list --status`, the engine's own eligibility checks) already derives the
phase fresh on every read, so a stale on-disk value is cosmetic residue, invisible unless you read the
raw JSON file directly. The heal writes each mismatched record back **unmodified**; the store's own
versioned write tail corrects `run_phase` (plus `version`/`updated_at`) as its ordinary side effect —
gc itself never constructs or edits a single field.

> **Ordering trap after upgrading across #367 — read before running `--heal`.** The seal substrate
> changed what `deriveRunPhase` computes for some legacy records: a startup death that used to
> derive `abandoned` now derives `failed`. `--heal` rewrites exactly the records whose persisted
> phase disagrees with the derivation, so on the first run after the upgrade it will rewrite that
> whole population — and every rewrite resets the record's `updated_at`, which is the clock
> `--older-than`, `cleanup` and your retention policy all read. **Run
> `realm run migrate --stamp-seals` FIRST if retention clocks matter to you** — it materialises the
> same phases and leaves `updated_at` untouched, which is exactly what `--heal` cannot do. Composable with `--older-than`: `--heal` alone runs
> without it (healing is safe at any age, no 1-hour floor applies), `--older-than` alone runs the temp/
> artifact sweeps as always, and both together run all three passes in one invocation.

```bash
realm run gc --heal                        # dry-run: list records that WOULD be healed
realm run gc --heal --force                # actually rewrite them
realm run gc --heal --older-than 6h --force  # heal, plus the temp/artifact sweeps, together
```

A single unparseable run file makes `list()` throw (the store's deliberate fail-closed read — issue
#132/#183) — `--heal` aborts with a non-zero exit and heals nothing, rather than silently healing a
partial, possibly-wrong population. This mirrors the orphan-artifact sweep's own "couldn't look, abort
loudly" convention above. Postgres and other external stores are out of scope for `--heal` — their own
records heal automatically the next time anything writes to them through the store's normal path.

---

### `realm run export <run-id>`

Archives a run's evidence — its record, its failed-attempt sidecar, and any orphaned/in-flight WAL
traces — into one self-contained, human-readable JSON file. The **read-only, evidence-preserving**
companion to `purge`: keep this before (or instead of) permanently deleting the rest. See
[Exporting a run's evidence](operating-runs.md#exporting-a-runs-evidence) for the full bundle shape.

```bash
realm run export abc123                     # writes ./abc123.realm.json
realm run export abc123 --out ~/evidence/    # writes ~/evidence/abc123.realm.json
realm run export abc123 --out bug-1234.json  # writes exactly that file
```

Works on **any** run, not just terminal ones — exporting a non-terminal run prints a best-effort
snapshot warning (its artifacts are read at slightly different instants and may be mid-flight) but
still produces the bundle; a terminal run needs no warning. Read-only and lock-free: never writes
into `runsDir`, never deletes anything, and refuses to overwrite an existing file at the resolved
`--out` target (error + non-zero exit, naming the path — pick a different `--out`). Excludes the
idempotency-key pointer file by design — it's a rebuildable index, not evidence, and the key itself
is already on the run record.

---

### `realm run attempts <run-id>`

Shows failed agent-step validation attempts recorded for a run (the durable `<id>.attempts.jsonl`
sidecar — see [Operating & recovering runs](operating-runs.md#durable-sidecar--realm-run-attempts)).
These are **pre-claim** validation rejections that never reach the run record, so this is the only
post-mortem trail for them.

```bash
realm run attempts abc123          # table: ts, step, error_code, key count, validation summary
realm run attempts abc123 --json   # raw metadata-only records + capped flag
```

Records are **metadata-only** (no raw model output). A run with no recorded failures prints a
friendly message; if the sidecar reached its size ceiling, the output notes that later attempts were
dropped.

---

## MCP server commands

---

### `realm mcp`

Starts the Realm MCP server over stdio. All workflows registered via `realm workflow register`
are immediately available. Use this command in AI client configs (Claude Desktop, Cursor, VS Code
MCP) that can spawn a local subprocess.

```bash
realm mcp
```

**Claude Desktop — `claude_desktop_config.json`:**

```json
{
  "mcpServers": {
    "realm": {
      "command": "realm",
      "args": ["mcp"]
    }
  }
}
```

**Cursor — `~/.cursor/mcp.json`:**

```json
{
  "mcpServers": {
    "realm": {
      "command": "realm",
      "args": ["mcp"]
    }
  }
}
```

**VS Code — `.vscode/mcp.json`:**

```json
{
  "servers": {
    "realm": {
      "type": "stdio",
      "command": "realm",
      "args": ["mcp"]
    }
  }
}
```

---

### `realm serve`

Starts the Realm MCP server over HTTP with Bearer token authentication. Designed for hosted
agent platforms (OpenClaw, Claude.ai, LangChain cloud, custom backends) that cannot spawn a
local subprocess via stdio.

```bash
REALM_SERVE_TOKEN=<secret> realm serve
REALM_SERVE_TOKEN=<secret> realm serve --port 8080 --host 0.0.0.0
realm serve --dev   # disable auth for local development only
```

| Option             | Default     | Description                                                        |
| ------------------ | ----------- | ------------------------------------------------------------------ |
| `--port <number>`  | `3001`      | Port to listen on                                                  |
| `--host <address>` | `127.0.0.1` | Bind address                                                       |
| `--dev`            | off         | Disable auth (local development only — do not expose to a network) |

**Environment variables:**

| Variable            | Description                                                                  |
| ------------------- | ---------------------------------------------------------------------------- |
| `REALM_SERVE_TOKEN` | Bearer token clients must send in the `Authorization: Bearer <token>` header |
| `REALM_DEV`         | Set to `1` to disable auth — equivalent to the `--dev` flag                  |

The server refuses to start if neither `REALM_SERVE_TOKEN` nor `--dev` / `REALM_DEV=1` is set.

**Connecting from an HTTP MCP client (e.g. n8n, VS Code remote):**

```json
{
  "servers": {
    "realm": {
      "type": "http",
      "url": "http://127.0.0.1:3001",
      "headers": {
        "Authorization": "Bearer <your-token>"
      }
    }
  }
}
```

---

## realm listen

Starts an HTTP server that routes inbound webhooks to workflows by their `trigger:` block. For each
request it verifies authenticity per the workflow's `trigger.auth`, optionally filters and dedups,
creates a run, and spawns `realm agent --run-id` (detached) for it.

```
realm listen [workflows...] [--port <n>] [--host <addr>] [--body-timeout-ms <n>]
             [--max-body-bytes <n>] [--max-concurrent <n>] [--dedup-store file|memory]
             [--log-level debug|info|warn|error] [--sweep-expired-gates <seconds>]
```

**Arguments:**

- `[workflows...]` — workflow files or directories to mount (default: `./workflow.yaml`). Each must
  declare a `trigger:` block; workflows without one are skipped (logged).

**Flags:**

- `--port <n>` — port to listen on (default `3000`)
- `--host <addr>` — interface to bind (default `127.0.0.1`; a non-loopback host emits a TLS warning)
- `--body-timeout-ms <n>` — max time to read a request body before `408` (default `5000`)
- `--max-body-bytes <n>` — max request body size before `413` (default `1048576`)
- `--max-concurrent <n>` — in-flight request ceiling before `503` (default `20`)
- `--dedup-store file|memory` — durable file dedup (default) or in-memory best-effort
- `--log-level <level>` — `debug` | `info` | `warn` | `error` (default `info`)
- `--sweep-expired-gates <seconds>` — **opt-in** (issue #291), default OFF: runs a coarse,
  store-wide sweep every `<seconds>` that enacts every expired, enactable gate this store holds —
  not just gates on workflows this `listen` process has mounted. The **user-chosen always-on
  enactor**: realm itself still ships no daemon, but running `listen` with this flag makes that
  process one. Never drains finalizers itself (no extension registry for a workflow it hasn't
  mounted) — a terminalizing enactment logs an advisory pointing at `realm run drain --expired`
  instead. Safe to run alongside any other enactment point (submit/execute_step/drain/an
  attending process's own timer, or a second `listen` sweeper) — races resolve via the same
  idempotent arm matrix every enactment point shares.

**Verification (`trigger.auth.mode`):** `shared_secret` (header token — e.g. Gorgias `Authorization:
Bearer …`), `github` / `stripe` / `hmac` (body signature), or `none` (explicit, discouraged escape
hatch). Verification runs before filtering/dedup; failures receive `403 Forbidden` (an unknown path
also returns `403`, never `404`).

**Hardening:** binds loopback by default; caps and times out the request body _before_ any verification
work; enforces a `--max-concurrent` `503` floor. TLS termination, rate limiting, and autoscaling are
reverse-proxy concerns — front `realm listen` with nginx/Caddy/Traefik for public endpoints.

**Startup registration & project extensions:** each routed workflow is registered **once at
startup** (the old per-webhook re-register was removed — it silently reverted fresher
registrations; restart `realm listen` after re-registering a workflow). Workflows declaring
`extensions:` have their modules loaded at startup, fail-fast — note the modules are imported in
the listen **parent** process, so top-level side effects run there. Spawned children re-resolve
extensions when they attach; a child that cannot load them exits nonzero and marks its run
`terminal_reason: 'extensions_load_failed'` (recoverable — see
[Project extensions across commands](#project-extensions-across-commands)).

> **`realm webhook` (GitHub-only) has been removed.** Express the GitHub PR flow as a `trigger:` block
> with `auth: { mode: github }` and a `params_map` of the PR payload dot-paths — byte-parity-equivalent
> to the old hardcoded mapping. See `examples/09-webhook-pr-review/`.
