# Testing Reference — `@sensigo/realm-testing`

`@sensigo/realm-testing` provides everything needed to test Realm workflows without making
real service calls or writing to disk: an in-memory store, fixture-driven runners, mock
adapters, gate responders, assertion helpers, and a GitHub mock server. Install it as a dev
dependency alongside `@sensigo/realm`.

```bash
npm install --save-dev @sensigo/realm-testing
```

---

## Fixture tests — `runFixtureTests`

The fastest way to test a workflow end-to-end. Each fixture file declares params, mock service
responses, agent step outputs, gate choices, and the expected final state. The runner drives
the workflow to completion and returns one `TestResult` per fixture.

```typescript
// workflow.test.ts
import { describe, it, expect } from 'vitest';
import { runFixtureTests } from '@sensigo/realm-testing';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('issue-triage fixtures', async () => {
  const results = await runFixtureTests({
    workflowPath: path.join(__dirname, '../workflow.yaml'), // or the directory containing workflow.yaml
    fixturesPath: path.join(__dirname, '../fixtures'),
  });

  for (const result of results) {
    it(result.name, () => {
      expect(result.passed, result.error).toBe(true);
    });
  }
});
```

### `runFixtureTests(options)`

| Parameter      | Type                | Required | Description                                                                               |
| -------------- | ------------------- | -------- | ----------------------------------------------------------------------------------------- |
| `workflowPath` | string              | Yes      | Path to `workflow.yaml` or the directory containing it.                                   |
| `fixturesPath` | string              | Yes      | Path to a directory of `*.yaml` fixture files.                                            |
| `registry`     | `ExtensionRegistry` | No       | Registry with custom handlers/adapters used as a fallback. Fixture mocks take precedence. |

Returns `Promise<TestResult[]>`. One `TestResult` per fixture file.

### `TestResult`

| Field    | Type    | Description                                       |
| -------- | ------- | ------------------------------------------------- |
| `name`   | string  | Fixture `name` field.                             |
| `passed` | boolean | `true` when all assertions passed.                |
| `error`  | string  | Error message when `passed` is `false`. Optional. |

---

## Fixture file format — `TestFixture`

Each fixture file is a YAML document that describes one test scenario. The runner loads all
`*.yaml` files in `fixturesPath` and runs each one independently.

```yaml
# fixtures/approve-critical-issue.yaml
name: critical memory leak — approved

params:
  repo: acme/api-service
  issue_number: 123

mocks:
  github:
    get_issue:
      status: 200
      data:
        number: 123
        title: 'Memory leak under high load'
        body: 'Under sustained load the request handler leaks ~50MB per hour.'
        state: open
        labels: []
    post_comment:
      status: 201
      data: {}
    apply_labels:
      status: 200
      data: {}

agent_responses:
  triage_issue:
    severity: critical
    labels: [bug, P1, memory]
    comment_draft: 'Triaged as critical. Assigned to platform team.'

gate_responses:
  triage_issue: approve

expected:
  final_state: completed
  evidence:
    - step_id: fetch_issue
      status: success
    - step_id: triage_issue
      status: success
    - step_id: post_comment
      status: success
    - step_id: apply_labels
      status: success
```

### `TestFixture` fields

| Field                    | Type                                      | Required | Description                                                                                                                                                                                             |
| ------------------------ | ----------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                   | string                                    | Yes      | Human-readable test name used in runner output.                                                                                                                                                         |
| `params`                 | `Record<string, unknown>`                 | No       | Params passed to `store.create`. Defaults to `{}`.                                                                                                                                                      |
| `mocks`                  | `Record<string, MockOperations>`          | No       | Mock service responses. Keyed by service name (as declared in `services:` in the workflow), then by operation name. See below.                                                                          |
| `agent_responses`        | `Record<string, Record<string, unknown>>` | No       | Pre-built outputs for `execution: agent` steps, keyed by step ID. The runner uses these in place of a real LLM.                                                                                         |
| `gate_responses`         | `Record<string, string>`                  | No       | Gate choices keyed by step ID. Defaults to `"approve"` for any step not listed.                                                                                                                         |
| `agent_errors`           | `Record<string, string[]>`                | No       | Optional ordered error messages injected for a step before its normal response. Used to test retry behaviour. The runner resets the run state after each injected error, simulating `realm run resume`. |
| `expected.final_state`   | string                                    | Yes      | Expected `run_phase` at run completion.                                                                                                                                                                 |
| `expected.skipped_steps` | string[]                                  | No       | Exact set of step IDs expected in `skipped_steps`. Set equality — order does not matter.                                                                                                                |
| `expected.evidence`      | `Array<{step_id, status?}>`               | No       | Evidence entries that must exist in the final evidence chain. Each entry must have a matching snapshot; `status` is optional.                                                                           |

### `MockOperations`

A map from operation name to the `ServiceResponse` the mock returns for that operation:

```yaml
mocks:
  github: # service name (matches workflow services: key)
    get_issue: # operation name
      status: 200
      data:
        title: 'example'
    post_comment: # a second operation
      status: 201
      data: {}
```

`status` and `data` match the `ServiceResponse` interface. The runner creates a
`MockServiceRecorder` from these entries — the recorder intercepts adapter calls and returns
the configured responses, eliminating all real network calls.

---

## Fixture loader functions

Use these when you need to load fixtures programmatically rather than via `runFixtureTests`.

### `loadFixtureFromFile(filePath)`

Reads and parses a single `*.yaml` fixture from disk. Throws if the file is unreadable or
missing required fields (`name`, `expected.final_state`).

```typescript
import { loadFixtureFromFile } from '@sensigo/realm-testing';
const fixture = loadFixtureFromFile('./fixtures/happy-path.yaml');
```

### `loadFixtureFromString(content)`

Parses a YAML string into a `TestFixture`. Useful when fixtures are fetched from another
source or generated programmatically.

### `loadFixturesFromDir(dirPath)`

Loads all `*.yaml` and `*.yml` files from a directory and returns `TestFixture[]`. Throws if
the directory does not exist.

---

## InMemoryStore

An in-memory `RunStore` with no I/O, no locking, and no on-disk state. Safe to instantiate
per-test and safe to use in parallel tests — each instance is completely isolated.

```typescript
import { InMemoryStore } from '@sensigo/realm-testing';

const store = new InMemoryStore();
const run = await store.create({
  workflowId: 'my-workflow',
  workflowVersion: 1,
  params: { input: 'hello' },
});
```

Implements the full `RunStore` interface from `@sensigo/realm`: `create`, `get`, `update`,
`claimStep`, `list`. The `update` method enforces optimistic concurrency — passes the version
check in single-threaded test code and throws `STATE_SNAPSHOT_MISMATCH` if two updates race.

`InMemoryStore` is a **faithful, fully-conformant reference `RunStore`**: it declares
`persistsClaims: true` (the issue #101 per-claim liveness clock round-trips) and the full
`persistedRunRecordFields` set (issue #188 — see the RunStore conformance section below), so
nothing it does is ever flagged by the engine's honesty diagnostics.

`claimStep` also carries a cross-cutting obligation every `RunStore` implementation — including
a future cloud/Postgres store — must satisfy: **it must be atomic and single-owner across all
processes/hosts sharing the store.** Two concurrent `claimStep` calls for the same `(runId,
step)` must not both succeed; a store that can't guarantee this breaks the resurrect-race
protection (issue #184) and the trace-buffer epoch minting (issue #185). `InMemoryStore`
satisfies this for same-process concurrency by construction (no internal `await` between its
read and write, so one call's `claimStep` body always runs to completion before another can
observe the record). The `CLAIM_SINGLE_OWNER` conformance law below verifies this same-process
guarantee for any store — see its own caveat for what it does _not_ prove.

---

## RunStore conformance — `runStoreFidelityContract`

A framework-agnostic conformance kit (issue #188) that **any** `RunStore` implementation —
including an external store built for a future deployment (e.g. a cloud/Postgres-backed store)
— can be run against to prove it satisfies the store contract. It returns plain case
descriptors, not test-runner assertions: no `describe`/`it`/`expect` import, so it carries no
test-framework dependency into `@sensigo/realm-testing`'s published `dist`. Each calling test
file wires the returned cases into whatever framework it already uses.

**Why it exists:** a store that silently drops a load-bearing `RunRecord` field, or lies about
what it claims to persist, corrupts the engine in ways that are easy to miss in review —
capability-block state goes silently unreported, snapshot history disappears, or drift
detection never fires. The TCK catches that dishonesty **before the store ships**, rather than
relying on the engine's runtime diagnostics (which only ever say "this store doesn't declare
persisting X," never "this store lied about persisting X").

**The capability it verifies:** `RunStore` carries an optional
`persistedRunRecordFields?: ReadonlySet<LoadBearingRunRecordField>` (both exported from
`@sensigo/realm`) — the set of load-bearing `RunRecord` fields a store guarantees to round-trip
through `create`/`update`/`get`. `LoadBearingRunRecordField` is a closed set of three fields,
each with a real engine read-site: `capability_blocks` (capability-block state),
`workflow_context_snapshots` (context-snapshot history), and `extension_identity` (drift-detection
baseline). The default is **fail-closed**: `undefined` (or a field simply absent from the
declared set) means the engine must _not_ treat that field's absence on a read as authoritative
— it surfaces an honest diagnostic instead of silently trusting an empty result. A store that
persists every `RunRecord` field it's given — like `JsonFileStore` and `InMemoryStore`, both by
generic serialize/deserialize or by never dropping anything on write — declares the **full**
set, which keeps every honesty gate dormant: zero behavior change. This is the inverse of a
_required_ capability, so adding it can never retroactively break an external store implementer
that predates it — it only makes a pre-existing silent field-drop finally visible. An external
`RunStore` implementer should declare `persistedRunRecordFields` honestly and verify that
honesty with the TCK below.

```typescript
import { runStoreFidelityContract, type RunStoreFidelityLaw } from '@sensigo/realm-testing';
import { JsonFileStore } from '@sensigo/realm';
import type { WorkflowDefinition } from '@sensigo/realm';

// A minimal workflow definition carrying exactly one step, immediately eligible on a fresh run
// (no unmet depends_on) — CLAIM_SINGLE_OWNER races two concurrent claimStep calls against it.
const definition: WorkflowDefinition = {
  id: 'my-store-tck-wf',
  name: 'My Store TCK WF',
  version: 1,
  steps: {
    work: { description: 'Immediately eligible step', execution: 'agent', depends_on: [] },
  },
};

const store = new JsonFileStore('/tmp/my-store-under-test');
const cases = runStoreFidelityContract({ store, definition, stepName: 'work' });

for (const testCase of cases) {
  it(`${testCase.law}: ${testCase.name}`, async () => {
    await testCase.run(); // rejects (throws) on failure
  });
}
```

### `runStoreFidelityContract(adapter)`

| Parameter            | Type                 | Description                                                                                        |
| -------------------- | -------------------- | -------------------------------------------------------------------------------------------------- |
| `adapter.store`      | `RunStore`           | The store under test.                                                                              |
| `adapter.definition` | `WorkflowDefinition` | A definition with exactly one step, named `adapter.stepName`, immediately eligible on a fresh run. |
| `adapter.stepName`   | string               | The eligible step's name.                                                                          |

Returns `RunStoreFidelityContractCase[]` — each case is `{ law: RunStoreFidelityLaw, name: string,
run: () => Promise<void> }`. `run()` rejects on failure; any test framework's `await run()` (a
rejection fails the test) or `expect(run()).rejects...` maps directly onto this.

### The two laws

| Law                  | What it checks                                                                                                                                                                             | A store fails when...                                                                                                                                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FIDELITY_HONESTY`   | For **each field the store declares** in `persistedRunRecordFields`, a real sample value is written through `create`/`update` and read back through `get`; the round-trip must byte-match. | It declares a field but drops, mutates, or fails to persist it. (A store that declares nothing generates zero `FIDELITY_HONESTY` cases — that combination is correct-by-design, not a gap; such a store instead relies on the engine's runtime honesty gates.) |
| `CLAIM_SINGLE_OWNER` | Two concurrent `claimStep(runId, sameStep)` calls against a fresh run.                                                                                                                     | More than one call succeeds, or a losing call rejects with anything other than a `WorkflowError` carrying `STATE_STEP_ALREADY_CLAIMED`.                                                                                                                        |

**Cross-host caveat:** `CLAIM_SINGLE_OWNER` only exercises and asserts the **same-process
(same-host) guarantee** — for an in-memory store this is same-process by construction; for a
lock-based store like `JsonFileStore` it exercises same-host multi-process safety via the real
OS-level lock the two concurrent calls contend on. But the TCK run itself happens within one
test process, so it does not and cannot exercise true cross-host concurrency. The cross-host
single-owner obligation stated on `RunStore.claimStep`'s own contract can only be verified by a
store's **own** conformance suite against its real concurrent backend (e.g. a Postgres store's
suite exercising genuine multi-connection contention) — a green run of this TCK is not proof of
cross-host safety.

---

## createAgentDispatcher

Creates a `StepDispatcher` that returns pre-built results without calling a real LLM or
external service.

```typescript
import { createAgentDispatcher, InMemoryStore } from '@sensigo/realm-testing';
import { loadWorkflowFromFile, ExtensionRegistry, executeChain } from '@sensigo/realm';

const definition = loadWorkflowFromFile('./workflow.yaml');
const store = new InMemoryStore();
const registry = new ExtensionRegistry();

const dispatch = createAgentDispatcher(definition, registry, {
  // agent step outputs, keyed by step ID
  triage_issue: {
    severity: 'critical',
    labels: ['bug', 'P1'],
    comment_draft: 'Critical — assign immediately.',
  },
});
```

### Signature

```typescript
createAgentDispatcher(
  definition: WorkflowDefinition,
  registry: ExtensionRegistry,
  agentResponses: Record<string, Record<string, unknown>>,
  fallbackRegistry?: ExtensionRegistry,
  agentErrors?: Record<string, string[]>,
): StepDispatcher
```

### Dispatch priority per step

1. **`execution: agent`** — injects errors from `agentErrors[stepName]` in call order first; then returns `agentResponses[stepName]`. Throws `ENGINE_HANDLER_FAILED` if no response is configured.
2. **`handler`** — calls `handler.execute()` from `registry`, falling back to `fallbackRegistry`.
3. **`uses_service`** — calls `adapter.fetch()` from `registry`, falling back to `fallbackRegistry`.
4. **Everything else** — returns `{}`.

The `fallbackRegistry` parameter is useful when combining fixture mock adapters (in `registry`)
with custom handlers provided by the test suite.

### Injecting agent errors

Use `agentErrors` to test that your workflow handles transient agent failures and retries correctly. The dispatcher returns each error message as a `WorkflowError` in order, one per call to that step. After the queue is exhausted, the step receives its normal `agentResponses` entry.

```typescript
const dispatch = createAgentDispatcher(
  definition,
  registry,
  { classify: { category: 'bug', priority: 'high' } },
  undefined,
  { classify: ['provider timed out after 30s'] }, // one error before success
);
```

---

## createGateResponder

Automatically resolves an open human gate on a run. Reads `pending_gate` from the run record,
looks up the choice in `gateResponses`, and calls `submitHumanResponse`.

```typescript
import { createGateResponder } from '@sensigo/realm-testing';

// After executeChain returns confirm_required:
await createGateResponder(store, definition, run.id, {
  triage_issue: 'approve', // step name → gate choice
});
```

### Signature

```typescript
createGateResponder(
  store: RunStore,
  definition: WorkflowDefinition,
  runId: string,
  gateResponses: Record<string, string>,
): Promise<ResponseEnvelope>
```

`gateResponses` maps step names to gate choice strings. If the open gate's step name is not in
the map, the default choice `'approve'` is used. Throws `Error` if the run has no pending gate.

Returns the `ResponseEnvelope` from `submitHumanResponse` — check `.status` before continuing.

---

## MockServiceRecorder

A `ServiceAdapter` that returns pre-configured responses and records every call for later
inspection. Use it when you need to assert that specific operations were called with the
expected params.

```typescript
import { MockServiceRecorder } from '@sensigo/realm-testing';
import { ExtensionRegistry } from '@sensigo/realm';

const recorder = new MockServiceRecorder('github', {
  get_issue: { status: 200, data: { title: 'Bug report', body: '...' } },
  post_comment: { status: 201, data: {} },
  apply_labels: { status: 200, data: {} },
});

const registry = new ExtensionRegistry();
registry.register('adapter', 'github', recorder);

// ... run the workflow ...

expect(recorder.calls).toHaveLength(3);
expect(recorder.calls[0]).toMatchObject({ method: 'fetch', operation: 'get_issue' });
expect(recorder.calls[2]).toMatchObject({
  method: 'create',
  operation: 'apply_labels',
  params: { labels: ['bug', 'P1'] },
});
```

### Constructor

```typescript
new MockServiceRecorder(id: string, responses: Record<string, ServiceResponse>)
```

| Parameter   | Type                              | Description                                                                                              |
| ----------- | --------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `id`        | string                            | Adapter ID. Must match the registered name.                                                              |
| `responses` | `Record<string, ServiceResponse>` | Response map keyed by operation name. Throws `ENGINE_ADAPTER_FAILED` if an unmapped operation is called. |

### `recorder.calls`

`RecordedCall[]` — ordered list of all calls made to the recorder. Each entry:

| Field       | Type                              | Description                                                |
| ----------- | --------------------------------- | ---------------------------------------------------------- |
| `method`    | `'fetch' \| 'create' \| 'update'` | Which adapter method was called.                           |
| `operation` | string                            | Operation name passed by the engine.                       |
| `params`    | `Record<string, unknown>`         | Params passed by the engine, after `input_map` resolution. |

---

## Assertions

All assertion helpers throw `Error` on failure and return `void` on success. They are
framework-agnostic — they work with Vitest, Jest, Node's built-in `assert`, or any test
runner that catches thrown errors.

### `assertFinalState(run, expectedPhase)`

Throws if `run.run_phase !== expectedPhase`.

```typescript
assertFinalState(run, 'completed');
assertFinalState(run, 'failed');
```

Takes a `RunRecord`. Call `await store.get(run.id)` after driving the workflow to get the
current state — `run.run_phase` does not update in place.

### `assertStepSucceeded(evidence, stepId)`

Throws if no non-gate-response evidence snapshot for `stepId` has `status: 'success'`.

```typescript
assertStepSucceeded(run.evidence, 'fetch_issue');
```

### `assertStepFailed(evidence, stepId)`

Throws if no non-gate-response evidence snapshot for `stepId` has `status: 'error'`.

```typescript
assertStepFailed(run.evidence, 'validate_fields');
```

### `assertStepOutput(evidence, stepId, expected)`

Throws if the last non-gate-response snapshot for `stepId` does not contain all keys in
`expected` at their expected values. Shallow check — only top-level fields are compared.

```typescript
assertStepOutput(run.evidence, 'triage_issue', {
  severity: 'critical',
  labels: ['bug', 'P1'],
});
```

### `assertEvidenceHash(evidence, stepId, expectedHash)`

Throws if the last non-gate-response snapshot for `stepId` does not have
`evidence_hash === expectedHash`. Use to verify that output has not changed across runs — the
hash covers all evidence up to and including the step.

```typescript
assertEvidenceHash(run.evidence, 'generate_report', 'sha256:abcd1234...');
```

---

## Unit test helpers

Three single-step helpers for testing individual components in isolation. None of them require
a store or a workflow definition — they call the implementation directly.

### `testStepHandler(handler, inputs, context?)`

Calls `handler.execute(inputs, context)` and returns the `StepHandlerResult`. `context`
defaults to `{ run_id: 'test-run', run_params: {}, config: {} }`.

```typescript
import { testStepHandler } from '@sensigo/realm-testing';
import { checkRequiredFields } from './handlers/check-required-fields.js';

const result = await testStepHandler(checkRequiredFields, {
  params: { name: 'Alice', email: 'alice@example.com' },
});
expect(result.data.validated).toBe(true);
```

Pass a partial `context` to supply `run_params`, `config`, or `resources`:

```typescript
const result = await testStepHandler(handler, inputs, {
  run_params: { doc_path: '/data/report.pdf' },
  resources: { fetch_step: { text: 'source content' } },
});
```

### `testAdapter(adapter, operation, params?)`

Calls `adapter.fetch(operation, params, {})` and returns the `ServiceResponse`. `params`
defaults to `{}`. Only tests the `fetch` method — for `create` or `update` operations, call
the adapter method directly.

```typescript
import { testAdapter } from '@sensigo/realm-testing';
import { FileSystemAdapter } from '@sensigo/realm';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'realm-test-'));
const file = path.join(dir, 'doc.txt');
fs.writeFileSync(file, 'document contents');

const adapter = new FileSystemAdapter('filesystem');
const response = await testAdapter(adapter, 'read', { path: file });
expect(response.status).toBe(200);
expect((response.data as Record<string, unknown>)['content']).toBe('document contents');
```

---

## startGitHubMockServer

Starts a local HTTP server that serves pre-defined GitHub API responses from a JSON fixture
file. Use this to test `GitHubAdapter`-based workflows without network calls.

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startGitHubMockServer, type GitHubMockServerHandle } from '@sensigo/realm-testing';
import { GitHubAdapter } from '@sensigo/realm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('GitHubAdapter', () => {
  let handle: GitHubMockServerHandle;
  let adapter: GitHubAdapter;

  beforeAll(async () => {
    handle = await startGitHubMockServer(
      path.join(__dirname, './fixtures/github-fixture-data.json'),
    );
    adapter = new GitHubAdapter('github', {
      base_url: handle.url,
      auth: { token: 'test-token' },
    });
  });

  afterAll(() => handle.close());

  it('fetches pr diff', async () => {
    const result = await adapter.fetch('get_pr_diff', { repo: 'owner/repo', pr_number: 1 }, {});
    expect(result.status).toBe(200);
  });
});
```

### `startGitHubMockServer(fixturePath, port?)`

| Parameter     | Type   | Required | Description                                                      |
| ------------- | ------ | -------- | ---------------------------------------------------------------- |
| `fixturePath` | string | Yes      | Absolute path to a JSON fixture file. Read once at server start. |
| `port`        | number | No       | Port to bind to. Defaults to `3032`.                             |

Returns `Promise<GitHubMockServerHandle>`.

### `GitHubMockServerHandle`

| Field   | Type                  | Description                                |
| ------- | --------------------- | ------------------------------------------ |
| `url`   | string                | Base URL, e.g. `http://localhost:3032`.    |
| `close` | `() => Promise<void>` | Shuts the server down. Call in `afterAll`. |

Pass `handle.url` as `base_url` in the `GitHubAdapter` constructor or in the workflow YAML
`config.base_url` field to redirect all GitHub API calls to the local server.

### Fixture file format

The JSON fixture file maps `"METHOD /path/with/:params"` keys to response entries:

```json
{
  "GET /repos/:owner/:repo/pulls/:pr/files": {
    "status": 200,
    "body": [{ "filename": "src/main.ts", "patch": "@@ -1,4 +1,5 @@\n+// new" }]
  },
  "GET /repos/:owner/:repo/pulls/:pr": {
    "status": 200,
    "body": {
      "title": "Add feature",
      "base": { "ref": "main" },
      "head": { "sha": "abc123" }
    }
  },
  "PATCH /repos/:owner/:repo/pulls/:pr": {
    "status": 200,
    "echo": ["body"]
  }
}
```

`:param` segments match any non-empty path segment. Two entry types:

| Type   | Field  | Description                                                                                                                      |
| ------ | ------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Static | `body` | Returns the given body as JSON.                                                                                                  |
| Echo   | `echo` | Array of field names. Parses the request body and reflects those fields in the response. Used for write operations like `PATCH`. |

Unmatched requests return HTTP 404 `{ "error": "no matching fixture route" }`.

See `packages/core/src/adapters/fixtures/github-fixture-data.json` for a complete example covering all `GitHubAdapter` operations.

---

## Programmatic test walkthrough

For scenarios where `runFixtureTests` does not provide enough control — fine-grained step-level
assertions, multi-run scenarios, custom handler verification — drive the workflow manually:

```typescript
import { describe, it, expect } from 'vitest';
import {
  InMemoryStore,
  createAgentDispatcher,
  createGateResponder,
  assertFinalState,
  assertStepOutput,
  assertStepSucceeded,
} from '@sensigo/realm-testing';
import { loadWorkflowFromFile, ExtensionRegistry, executeChain } from '@sensigo/realm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const definition = loadWorkflowFromFile(path.join(__dirname, '../workflow.yaml'));

describe('issue-triage programmatic', () => {
  it('approve path reaches completed', async () => {
    const store = new InMemoryStore();
    const registry = new ExtensionRegistry();
    const dispatch = createAgentDispatcher(definition, registry, {
      triage_issue: { severity: 'critical', labels: ['bug', 'P1'], comment_draft: 'Critical.' },
    });

    const run = await store.create({
      workflowId: definition.id,
      workflowVersion: definition.version,
      params: { repo: 'acme/api-service', issue_number: 123 },
    });

    // Execute each step in order. The runner pattern: loop until terminal.
    let envelope = await executeChain(store, definition, {
      runId: run.id,
      command: 'fetch_issue',
      input: {},
      dispatcher: dispatch,
      registry,
    });

    // Continue through agent step, then respond to gate.
    envelope = await executeChain(store, definition, {
      runId: run.id,
      command: 'triage_issue',
      input: { severity: 'critical', labels: ['bug', 'P1'], comment_draft: 'Critical.' },
      dispatcher: dispatch,
      registry,
    });
    expect(envelope.status).toBe('confirm_required');

    // Respond to gate.
    await createGateResponder(store, definition, run.id, { triage_issue: 'approve' });

    const finalRun = await store.get(run.id);
    assertFinalState(finalRun, 'completed');
    assertStepSucceeded(finalRun.evidence, 'fetch_issue');
    assertStepOutput(finalRun.evidence, 'triage_issue', { severity: 'critical' });
  });
});
```

For multi-step workflows, run the loop until `terminal_state`:

```typescript
while (!currentRun.terminal_state) {
  if (currentRun.pending_gate !== undefined) {
    await createGateResponder(store, definition, run.id, gateChoices);
    currentRun = await store.get(run.id);
    continue;
  }
  const [nextStep] = findEligibleSteps(definition, currentRun);
  const input = agentResponses[nextStep] ?? {};
  await executeChain(store, definition, {
    runId: run.id,
    command: nextStep,
    input,
    dispatcher,
    registry,
  });
  currentRun = await store.get(run.id);
}
```

`findEligibleSteps` is exported from `@sensigo/realm`.
