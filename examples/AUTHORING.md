# Realm Examples — Authoring Guide

> Apply these rules when building a new example or modifying an existing one.

## Purpose

The examples are the primary vehicle for demonstrating Realm to prospective users. Each example must:

- Tell a clear **before/after story**: before = a skill or prompt file that grew through real failures; after = a Realm workflow that enforces the same logic mechanically.
- Be fully self-contained and runnable in isolation.
- Ship with its own workflow definition, sample data, test fixtures, and README.

**Target reader:** a developer already building AI agent workflows (Copilot skills, `.agent.md` files, LangChain pipelines) who is hitting the reliability wall.

---

## What Realm Does and Does Not Do

These principles apply to every example. Never violate them.

**Realm does:**

- Enforce step order via a YAML state machine
- Validate step input schemas before execution
- Enforce human gates mechanically — not by agent goodwill
- Produce an evidence chain for every run

**Realm does NOT do:**

- Parse or classify unstructured text — that is the LLM's job
- Make the agent smarter — it makes the agent's behaviour predictable
- Run domain logic in handlers — handlers are for deterministic operations only (schema validation, hash computation, verbatim-quote checking, field existence). If the logic requires language understanding, it belongs in an agent step.

---

## Design Constraints

Every example must satisfy all four:

1. **Zero credentials for the first run.** No API keys, no OAuth, no external services. A developer who just ran `npm install` can complete the example.
2. **Runnable in two modes:**
   - **Example mode: Live (MCP client):** the agent drives execution interactively; the human responds to human gate prompts. Run-ids are printed by the MCP session and can be passed to `realm run inspect`.
   - **Example mode: Fixture (simulated):** `realm workflow test <path> -f <fixtures-dir>` replays pre-recorded agent responses and gate choices without a real LLM. Reports PASS/FAIL per fixture. Uses in-memory store — no run-id is persisted; use the Live mode to generate inspectable run records.
3. **Screen-recordable.** Terminal output must tell the story without narration. `realm run inspect <run-id>` output must be visually compelling on its own.
4. **Swap-ready.** Every mock adapter is declared in the YAML and wired at startup. Replacing a mock with a real service requires changing one env var. Zero YAML changes.

---

## Data Flow Rule

**Never rely on the agent's context window to carry prior step data forward.** Context windows compress, agents lose track of data buried in earlier tool responses, and behaviour varies across LLMs.

Always reference prior step output explicitly via `context.resources.STEP_NAME.FIELD` in `step.prompt`. The engine resolves these references against the run's evidence chain before delivering the prompt — the agent receives the data at step entry, every time, regardless of what happened earlier in the conversation.

---

## Fixture Test Pattern

The fixture test runner (`realm workflow test`) follows this structure — this is how `@sensigo/realm-testing` works internally:

1. Load fixture YAML file(s) from the fixtures directory
2. Initialise `InMemoryStore` + `ExtensionRegistry`; register adapters and handlers from the fixture `mocks:` section
3. Call `startRun(definition, params, { store, registry, secrets })`
4. Loop: call `executeChain` until terminal state; inject agent response from fixture `agent_responses:` when `status` is `agent_required`; inject gate response from fixture `gate_choices:` when `status` is `gate_waiting`
5. Compare final state to fixture `expected:` block; report PASS/FAIL and exit 0 if all pass

Note: the runner uses `InMemoryStore` — runs are not persisted to disk and cannot be inspected with `realm run inspect` afterward. To generate a persisted run record, use the Live (MCP) mode.

---

## README Pattern

Every example README must have these sections in this order:

**Preamble** (no `##` heading)

- **Pain:** one paragraph describing the failure mode this example addresses.
- **After:** one paragraph stating what Realm enforces differently.

**`## What this shows`**

An ASCII DAG diagram of the workflow steps, followed by a **Key points** bullet list
explaining the mechanics worth highlighting.

**`## Install`**

```bash
# From the repo root
npm install
```

**`## Run fixture tests`**

Single `realm workflow test` command using the `-f` flag:

```bash
realm workflow test examples/NN-name/workflow.yaml -f examples/NN-name/fixtures/
```

List each fixture with a one-line description. Always include an **Expected output** block
with the exact terminal output — fixture names are taken from the `name:` field in each
YAML file, printed in alphabetical file order.

**`## Requirements`** _(only for examples that need external credentials)_

A `.env` snippet with the required variables and a brief explanation of why each is needed.
Omit entirely for credential-free examples.

**`## Run with an AI agent`**

For examples **that ship with a skill file** (e.g., `realm-name.md`):

- **Option A — VS Code + Copilot (MCP):** `realm workflow register` + `realm mcp` command,
  the custom agents blockquote, and an example Copilot prompt.
- **Option B — Skill file (default agent):** copy instruction, example prompt with "with Realm"
  trigger phrase, and **Why "with Realm"?** blockquote.
- **Option C — `realm agent` CLI:** `--workflow` + `--params` command, API key note, and a
  gate walkthrough (showing the paused output and `realm run respond` commands) for any
  workflow that has a human gate.

For examples **without a skill file**:

- **Option A — VS Code + Copilot (MCP)**
- **Option B — `realm agent` CLI**

**Example-specific sections** (optional, inserted after "Run with an AI agent")

Add sections here for unique setup or features that require extended explanation
(e.g., Agent profiles, Sample data, Slack gate modes, `display` field reference).

**`## Inspect the evidence chain`**

```bash
realm run inspect <run-id>
```

One paragraph describing what the evidence chain shows for this specific workflow.

**`## Configuration reference`**

A table of the `params_schema` fields: Field, Type, Description.

**`## What to look at next`**

Links to related examples and the relevant YAML Schema Reference page.

---

## Success Criteria

An example is complete when all of the following are true:

- [ ] `realm workflow test <path> -f <fixtures-dir>` exits 0 with all fixtures PASS
- [ ] A developer who has never seen Realm can read the README and successfully run the fixture tests in under 5 minutes
- [ ] A developer can swap the mock adapter for a real one by changing one env var — no other changes
- [ ] Running the example via MCP (Live mode) produces a run-id and `realm run inspect <run-id>` shows a compelling, human-readable audit trail

---

## Advanced Pattern: Agent-Generated Workflows

For open-ended tasks where the right step sequence is not known in advance, an agent can generate its own Realm workflow at runtime using the `create_workflow` MCP tool (already implemented). The agent analyses the request, emits a workflow definition tailored to it, then executes it step by step. Realm enforces the structure the agent itself designed — the agent cannot drift from its own plan mid-execution.

See `.github/instructions/realm-create-workflow.instructions.md` for the full protocol.
