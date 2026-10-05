# Testing package

<!-- description: Reference for @sensigo/realm-testing, the package for testing workflows, handlers, adapters and stores: every value and type it exports. -->

`@sensigo/realm-testing` is the package for testing workflows, handlers, adapters and stores from your own test files. It exports 25 values and 23 types. This page lists every one, with its signature and what it returns. The lists come from the package's built `index.js` and `index.d.ts`, and every output shown came from a call to the built package.

```bash
npm install --save-dev @sensigo/realm-testing
```

This page describes the package on the `main` branch. Version 0.45.0 exports 23 values: `createFenceRunSource` and `fenceTestRun` were added after it, and the adapter that `fencedTraceBufferContract` takes changed with them (`fenceRuns` and `fenceRunPark` are new, and `fenceForm` has other values).

Nothing in the package depends on a test framework. A function that checks something throws an `Error` when the check fails, which any framework reports as a failed test.

To test a workflow from the command line, with no test file, see [Test a workflow](../guides/test-a-workflow.md).

## The exports

| Group                               | Values                                                                                                                                                                           |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Fixtures](#fixtures)               | `loadFixtureFromFile`, `loadFixtureFromString`, `loadFixturesFromDir`, `runFixtureTests`                                                                                         |
| [Driving a run](#driving-a-run)     | `InMemoryStore`, `MockServiceRecorder`, `createAgentDispatcher`, `createGateResponder`                                                                                           |
| [Assertions](#assertions)           | `assertFinalState`, `assertStepSucceeded`, `assertStepFailed`, `assertStepOutput`, `assertEvidenceHash`                                                                          |
| [Unit helpers](#unit-helpers)       | `testStepHandler`, `testAdapter`, `testProcessor`                                                                                                                                |
| [GitHub stand-in](#github-stand-in) | `startGitHubMockServer`                                                                                                                                                          |
| [Store contracts](#store-contracts) | `runStoreFidelityContract`, `settlementContract`, `defaultSettlementFixture`, `perRunArtifactStoreContract`, `fencedTraceBufferContract`, `createFenceRunSource`, `fenceTestRun` |
| Version                             | `VERSION`, the package's version as a string: `"0.45.0"`.                                                                                                                        |

The 23 types are named in the group that uses them.

## Fixtures

A fixture is one test of a workflow: the run's parameters, a stand-in reply for each service call and each agent step, and what to expect at the end.

### `TestFixture`

```yaml
name: approved refund
params: { order: A-17 }
mocks:
  orders:
    get_order: { status: 200, data: { total: 40 } }
agent_responses:
  decide: { refund: true }
gate_responses:
  decide: approve
expected:
  final_state: completed
  evidence:
    - { step_id: fetch, status: success }
    - { step_id: decide }
```

| Field                    | Required | Default     | Holds                                                                                                          |
| ------------------------ | -------- | ----------- | -------------------------------------------------------------------------------------------------------------- |
| `name`                   | Yes      |             | The test's name. A non-empty string.                                                                           |
| `params`                 | No       | `{}`        | The run's parameters.                                                                                          |
| `mocks`                  | No       | `{}`        | Replies by service name, then by operation. Each reply is `{ status, data }`. The type is `MockOperations`.    |
| `agent_responses`        | No       | `{}`        | The answer each agent step gives, by step name.                                                                |
| `agent_errors`           | No       | None        | By step name, a list of error messages. The step fails with each in turn before it gives its answer.           |
| `gate_responses`         | No       | `approve`   | The choice given at each gate, by step name.                                                                   |
| `expected.final_state`   | Yes      |             | The phase the run must end in.                                                                                 |
| `expected.skipped_steps` | No       | Not checked | The exact set of skipped steps.                                                                                |
| `expected.evidence`      | No       | Not checked | Entries the run's record must have: a `step_id`, and optionally a `status` of `success`, `error` or `skipped`. |

`mocks` is keyed by the name of the service in the workflow's `services` block, not by the adapter's name.

### `loadFixtureFromFile(filePath)`, `loadFixtureFromString(content)`

Each returns a `TestFixture`, with the defaults filled in:

```js
loadFixtureFromString('name: x\nexpected: { final_state: completed }');
```

```json
{
  "name": "x",
  "params": {},
  "mocks": {},
  "agent_responses": {},
  "expected": { "final_state": "completed" }
}
```

| The fixture                    | Throws                                                     |
| ------------------------------ | ---------------------------------------------------------- |
| Has no `name`, or an empty one | `Fixture must have a non-empty string "name" field`        |
| Has no `expected.final_state`  | `Fixture must have an "expected.final_state" string field` |

No other field is checked.

### `loadFixturesFromDir(dirPath)`

Returns a `TestFixture` for each file in the folder that ends in `.yaml` or `.yml`. Folders inside it are not read. If the folder is not there, it throws `Fixture directory does not exist: nope`.

### `runFixtureTests(options)`

```ts
runFixtureTests(options: RunFixtureTestsOptions): Promise<TestResult[]>
```

Runs the workflow once for each fixture in a folder and returns one `TestResult` for each.

| Option         | Required | Holds                                                                                                                                             |
| -------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workflowPath` | Yes      | The workflow file, or the folder that holds `workflow.yaml`.                                                                                      |
| `fixturesPath` | Yes      | The folder of fixture files.                                                                                                                      |
| `registry`     | No       | An `ExtensionRegistry` with handlers and adapters of your own, used when a fixture has no stand-in for them.                                      |
| `extensions`   | No       | The project code loaded for the workflow. Handlers and processors run as they are. An adapter with no stand-in in the fixture throws when called. |
| `definition`   | No       | A workflow already loaded. With it, `workflowPath` is not read.                                                                                   |

| `TestResult` field | Holds                                 |
| ------------------ | ------------------------------------- |
| `name`             | The fixture's name.                   |
| `passed`           | `true` or `false`.                    |
| `error`            | The reason, when `passed` is `false`. |

```js
await runFixtureTests({ workflowPath: 'flow', fixturesPath: 'flow/fixtures' });
```

```json
[
  { "name": "approved refund", "passed": true },
  {
    "name": "expects the wrong ending",
    "passed": false,
    "error": "assertFinalState: expected phase 'failed' but run is in phase 'completed'"
  }
]
```

Each fixture gets a run in a new `InMemoryStore`. Nothing is written to disk. An agent step's input is the fixture's answer for it. An `auto` step gets what the engine gives it in a real run: the run's params when the step has no `depends_on`, and nothing otherwise. Added after version 0.46.0, which gives every `auto` step nothing, so a fixture whose first `auto` step needs the params fails there with `Invalid input for step '<step>'`.

A fixture's `error` for each kind of failure:

| The fixture                                                                                                                                                  | `error`                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Expects another ending                                                                                                                                       | `assertFinalState: expected phase 'failed' but run is in phase 'completed'`                                                                  |
| Expects a status the step did not have                                                                                                                       | `Expected evidence for step 'fetch' with status 'error' not found`                                                                           |
| Expects a step that has no entry                                                                                                                             | `Expected evidence for step 'nope' not found`                                                                                                |
| Expects another set of skipped steps                                                                                                                         | `Expected skipped_steps ["fetch"] but got []`                                                                                                |
| Has no answer for an agent step, or one the schema refuses                                                                                                   | `Invalid input for step 'decide'`                                                                                                            |
| Has no stand-in for a service the run calls, and another step can still run                                                                                  | `Adapter 'orders_api' for service 'orders' is not registered. Declare this adapter under 'adapters:' in realm.yaml at your deployment root.` |
| Reaches a point where nothing else can run: a failed precondition, an invalid `trust`, an input its schema refuses, or a handler or adapter with no stand-in | `Workflow stalled: nothing else can run.`, then one line per step that cannot run and the line that ends the run (see below)                 |
| Gives a gate a choice it does not have                                                                                                                       | `Choice 'maybe' is not valid. Expected one of: approve, reject`                                                                              |

A fixture that reaches a point where nothing else can run fails with the lines `realm workflow run` prints in the same state, joined by newlines. For a step whose precondition fails:

```text
Workflow stalled: nothing else can run.
'compute' cannot run (precondition): Precondition failed for step 'compute'. Precondition failed: 'run.params.ok == true'. Resolved value: undefined.
Run 9c0bd1a4-77f3-4a3c-9d0e-0c4d9e0b6b1f stays open (phase 'running'): correct the workflow, register it again, then realm run advance 9c0bd1a4-77f3-4a3c-9d0e-0c4d9e0b6b1f; or end it: realm run abandon 9c0bd1a4-77f3-4a3c-9d0e-0c4d9e0b6b1f.
```

Added after version 0.46.0, which fails such a fixture with `Workflow stalled: exceeded maximum loop iterations` when a precondition fails, and with the step's own error otherwise.

`runFixtureTests` itself throws when the workflow file or the fixtures folder is not there.

## Driving a run

These 4 exports let a test file drive a run step by step with the functions of `@sensigo/realm`.

```js
import {
  InMemoryStore,
  MockServiceRecorder,
  createAgentDispatcher,
  createGateResponder,
} from '@sensigo/realm-testing';
import { ExtensionRegistry, loadWorkflowFromFile, executeChain } from '@sensigo/realm';

const definition = loadWorkflowFromFile('flow/workflow.yaml');
const store = new InMemoryStore();
const orders = new MockServiceRecorder('orders_api', {
  get_order: { status: 200, data: { total: 40 } },
});
const registry = new ExtensionRegistry();
registry.register('adapter', 'orders_api', orders);
const dispatcher = createAgentDispatcher(definition, registry, { decide: { refund: true } });

const { run } = await store.create({
  workflowId: definition.id,
  workflowVersion: definition.version,
  params: { order: 'A-17' },
});
await executeChain(store, definition, {
  runId: run.id,
  command: 'fetch',
  input: {},
  dispatcher,
  registry,
});
await executeChain(store, definition, {
  runId: run.id,
  command: 'decide',
  input: { refund: true },
  dispatcher,
  registry,
});
await createGateResponder(store, definition, run.id, { decide: 'approve' });
```

| After the call        | `status`           | The run's phase |
| --------------------- | ------------------ | --------------- |
| `executeChain` fetch  | `ok`               | `running`       |
| `executeChain` decide | `confirm_required` | `gate_waiting`  |
| `createGateResponder` | `ok`               | `completed`     |

### `InMemoryStore`

```ts
new InMemoryStore();
```

A run store that keeps runs in memory. It has the 7 functions of a run store: `create`, `get`, `update`, `claimStep`, `settleStep`, `stampSeal` and `list`. It keeps every field of a run's record. See [Core library](core-library.md) for what each function does.

### `MockServiceRecorder`

```ts
new MockServiceRecorder(id: string, responses: Record<string, ServiceResponse>)
```

An adapter that returns the reply set for an operation and records each call. It has `fetch`, `create` and `update`, and no `delete`.

| Member                      | Holds                                                                                        |
| --------------------------- | -------------------------------------------------------------------------------------------- |
| `calls`                     | A list of `RecordedCall`: `{ method, operation, params }`, in the order the calls were made. |
| `fetch`, `create`, `update` | Each returns the reply for the operation.                                                    |

```js
await orders.fetch('get_order', { id: 'A-17' }, {});
orders.calls;
```

```json
[{ "method": "fetch", "operation": "get_order", "params": { "id": "A-17" } }]
```

An operation with no reply throws a `WorkflowError`: `MockServiceRecorder: no response configured for operation 'cancel'`. The call is still recorded.

### `createAgentDispatcher`

```ts
createAgentDispatcher(
  definition: WorkflowDefinition,
  registry: ExtensionRegistry,
  agentResponses: Record<string, Record<string, unknown>>,
  fallbackRegistry?: ExtensionRegistry,
  agentErrors?: Record<string, string[]>,
): StepDispatcher
```

Returns the function that `executeChain` takes as `dispatcher`. For each step it is called for:

| The step          | It returns                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------ |
| Is an agent step  | The step's entry in `agentResponses`. Before that, one error for each message in `agentErrors` for the step. |
| Names a `handler` | What the handler returns as `data`, with the handler taken from `registry`, then `fallbackRegistry`.         |
| Names a service   | What the adapter's `fetch` returns as `data`.                                                                |
| Is none of these  | `{}`                                                                                                         |

It throws a `WorkflowError` when an agent step has no entry, or the handler or adapter is in neither registry.

### `createGateResponder`

```ts
createGateResponder(
  store: RunStore,
  definition: WorkflowDefinition,
  runId: string,
  gateResponses: Record<string, string>,
  registry?: ExtensionRegistry,
): Promise<ResponseEnvelope>
```

Answers the run's open gate with the choice in `gateResponses` for the gate's step, or `approve` if there is none, and returns the engine's reply. Pass `registry` if the answer can complete the run and the workflow has cleanup steps. If the run has no open gate, it throws `createGateResponder: run has no pending gate`.

## Assertions

Each takes a run's record, or its `evidence` list, and returns nothing. It throws when the check fails.

| Function                                       | Passes when                                                          | Message when it fails                                                        |
| ---------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `assertFinalState(run, phase)`                 | The run's phase is `phase`.                                          | `assertFinalState: expected phase 'failed' but run is in phase 'completed'`  |
| `assertStepSucceeded(evidence, stepId)`        | The step has an entry with the status `success`.                     | `assertStepSucceeded: no 'success' snapshot found for step 'nope'`           |
| `assertStepFailed(evidence, stepId)`           | The step has an entry with the status `error`.                       | `assertStepFailed: no 'error' snapshot found for step 'fetch'`               |
| `assertStepOutput(evidence, stepId, expected)` | Each key of `expected` has the same value in the step's last output. | `assertStepOutput: step 'fetch' output_summary.total expected 41 but got 40` |
| `assertEvidenceHash(evidence, stepId, hash)`   | The step's last entry has that hash.                                 | `assertEvidenceHash: step 'fetch' expected hash 'abc' but got '78312715…'`   |

`assertFinalState` works out the phase from the record, as Realm's commands do. `assertStepOutput` compares the top-level keys with `===`, so an object or list value never matches. The 4 that take `evidence` ignore the entries that record a gate's answer. `assertStepOutput` and `assertEvidenceHash` throw `no snapshot found for step 'nope'` for a step with no entry.

## Unit helpers

Each calls one function of a thing you wrote, with defaults for the arguments a test seldom cares about.

| Function                                     | Calls                                  | Defaults                                                                                     |
| -------------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------- |
| `testStepHandler(handler, inputs, context?)` | `handler.execute(inputs, context)`     | `context` is `{ run_id: 'test-run', run_params: {}, config: {} }`, with your fields over it. |
| `testAdapter(adapter, operation, params?)`   | `adapter.fetch(operation, params, {})` | `params` is `{}`.                                                                            |
| `testProcessor(processor, content, config?)` | `processor.process(content, config)`   | `config` is `{}`.                                                                            |

```js
await testStepHandler(
  handler,
  { params: {} },
  { config: { unit_price: 2 }, resources: { fetch: { total: 40 } } },
);
```

The handler received this `context`:

```json
{
  "run_id": "test-run",
  "run_params": {},
  "config": { "unit_price": 2 },
  "resources": { "fetch": { "total": 40 } }
}
```

`testStepHandler` passes no signal. `testAdapter` calls `fetch` only.

## GitHub stand-in

### `startGitHubMockServer(fixturePath, port?)`

```ts
startGitHubMockServer(fixturePath: string, port = 0): Promise<GitHubMockServerHandle>
```

Starts a web server on this machine that answers from a JSON file. Point an adapter's `base_url` at it to test GitHub steps without GitHub.

| `GitHubMockServerHandle` member | Holds                                                   |
| ------------------------------- | ------------------------------------------------------- |
| `url`                           | The server's address, such as `http://localhost:49213`. |
| `close()`                       | Stops the server. Returns a promise.                    |

With `port` left out, the system picks a free port. The file maps a method and a path to a reply. A part of the path that starts with `:` matches any text:

```json
{
  "GET /repos/:owner/:repo/pulls/:pr": {
    "status": 200,
    "body": { "number": 7, "title": "Fix the total" }
  },
  "POST /repos/:owner/:repo/issues/:n/comments": { "status": 201, "echo": ["body"] }
}
```

| Entry has | The reply's body                                               |
| --------- | -------------------------------------------------------------- |
| `body`    | That value.                                                    |
| `echo`    | The named fields of the request's JSON body, and nothing else. |

| Request                                                                          | Reply                                         |
| -------------------------------------------------------------------------------- | --------------------------------------------- |
| `GET /repos/acme/shop/pulls/7?per_page=1`                                        | `200` `{"number":7,"title":"Fix the total"}`  |
| `POST /repos/acme/shop/issues/7/comments` with `{"body":"Looks good","extra":1}` | `201` `{"body":"Looks good"}`                 |
| The same `POST` with a body that is not JSON                                     | `400` `{"error":"invalid JSON body"}`         |
| `GET /repos/acme/shop`                                                           | `404` `{"error":"no matching fixture route"}` |

The query string is not matched. The file is read once, when the server starts. A port in use gives `GitHubMockServer: cannot bind to port 4871: listen EADDRINUSE: address already in use 127.0.0.1:4871`.

## Store contracts

A store contract is a set of tests for a store you wrote. Each of the 4 contract functions takes an adapter that describes your store and returns a list of cases. A case has a `law`, a `name`, and a `run` function that throws if your store breaks the law.

```js
import { it } from 'vitest';
import { runStoreFidelityContract, InMemoryStore } from '@sensigo/realm-testing';

const makeCases = () =>
  runStoreFidelityContract({ store: new InMemoryStore(), definition, stepName: 'work' });

for (const [i, c] of makeCases().entries()) {
  it(`${c.law}: ${c.name}`, async () => {
    await makeCases()[i].run();
  });
}
```

Build a new adapter and store for each case, as above. Several cases delete or damage what they are given.

| Contract                      | For a store that implements                  | Laws | Cases with Realm's own store        |
| ----------------------------- | -------------------------------------------- | ---- | ----------------------------------- |
| `runStoreFidelityContract`    | `RunStore`                                   | 6    | 13, with `InMemoryStore`            |
| `settlementContract`          | `RunStore` with `settleStep`                 | 56   | 146, with `InMemoryStore`           |
| `perRunArtifactStoreContract` | `PerRunArtifactStore`                        | 7    | 7, with `FailedAttemptStore`        |
| `fencedTraceBufferContract`   | `TraceBufferStore` with the fenced functions | 12   | 74, with `InMemoryTraceBufferStore` |

Every case in the last column passed. The store interfaces are in [Core library](core-library.md).

Each contract has the law `STORE_RELEASE_LINE_TRUE`: the release line your store declares must be the line of the errors it throws. The case makes your store refuse something (a run that does not exist, an injected failure, a fence that refuses) and compares the two. `storeReleaseLineLaw(store, provokeRefusal)` runs the same check for any store kind: `provokeRefusal` must make the store throw one of its own errors. A test runner that takes its laws from the exported list (below) runs it with no edit; one that lists its laws by hand must list it, or the case is never run. The law and `storeReleaseLineLaw` were added after version 0.45.0; the counts above include them.

#### Running every law

Each of four contracts exports the names of its laws as a list, so that a test file does not keep its own copy of them: `RUN_STORE_FIDELITY_LAWS`, `SETTLEMENT_LAWS`, `ARTIFACT_STORE_LAWS` and `FENCED_TRACE_BUFFER_LAWS`. They were added after version 0.45.0. Run the list, minus the laws that the file names in a `NOT_RUN` object with a reason for each:

```js
import { SETTLEMENT_LAWS } from '@sensigo/realm-testing';

const NOT_RUN = {
  ADAPTER_WIRING: 'has a case only when the adapter is mis-wired, and this file wires it',
};
const LAWS = SETTLEMENT_LAWS.filter((law) => !(law in NOT_RUN));
```

A law added to the contract then runs in the file with no edit, and a law the file leaves out is named in the file, with its reason.

### `runStoreFidelityContract(adapter)`

| Adapter field | Holds                                          |
| ------------- | ---------------------------------------------- |
| `store`       | The store.                                     |
| `definition`  | A workflow with one step that can run at once. |
| `stepName`    | That step's name.                              |

| Law                               | A store passes when                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FIDELITY_HONESTY`                | Each record field it lists in `persistedRunRecordFields` comes back unchanged after a create, an update and a read. One case for each field.                                                                                                                                                                                                                                                              |
| `SEALED_BY_ROUNDTRIP`             | The record of how a run ended comes back unchanged.                                                                                                                                                                                                                                                                                                                                                       |
| `CLAIM_SINGLE_OWNER`              | Of 2 claims of one step made at the same time, exactly 1 succeeds.                                                                                                                                                                                                                                                                                                                                        |
| `CLAIM_NAMES_HOLDER`              | A claim made with a program's name reads back with that name as `holder`, and with a `since` between the moment before the call and the moment after it. A claim made without one reads back with `since` and no `holder`. Needs `persistsClaims`; a store that does not declare it gets one case, named `SKIPPED — store does not declare 'persistsClaims': claim holder round-trip`, that does nothing. |
| `EVIDENCE_KEEPS_DRIVER_AND_PROOF` | An evidence entry written with `driven_by`, and a gate answer written with `claim_proof`, come back with both.                                                                                                                                                                                                                                                                                            |
| `STORE_RELEASE_LINE_TRUE`         | The release line the store declares is the line of the error it throws for a run that does not exist.                                                                                                                                                                                                                                                                                                     |

`claimStep` takes the program's name as an optional fourth argument, `claimant`; a store writes it as the claim's `holder`, and stamps `since` on every claim it makes. The two new laws were added after version 0.45.0. A store that lists no fields gets no `FIDELITY_HONESTY` cases. `CLAIM_SINGLE_OWNER` races 2 calls in one process. It does not show that a store is safe across machines.

Types: `RunStoreFidelityContractAdapter`, `RunStoreFidelityContractCase`, `RunStoreFidelityLaw`.

### `settlementContract(adapter)`

| Adapter field        | Required                      | Holds                                                                                                          |
| -------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `store`              | Yes                           | The store.                                                                                                     |
| `storeName`          | Yes                           | A label used in case names.                                                                                    |
| `settlementFixture`  | If the store has `settleStep` | Builds the workflows the cases use. `defaultSettlementFixture` suits a store that does not check workflow IDs. |
| `seedLegacyTerminal` | If the store has `stampSeal`  | Writes an ended run that has no record of how it ended, past the store's own checks, and returns it.           |

| The store                                        | Cases                                        |
| ------------------------------------------------ | -------------------------------------------- |
| Has neither `settleStep` nor `stampSeal`         | 0.                                           |
| Has `settleStep`, and the adapter has no fixture | 1, of the law `ADAPTER_WIRING`, which fails. |
| Has `settleStep` and a fixture                   | All of them.                                 |

The failing case says what to do:

```text
[Mine] settlementContract: adapter.store declares settleStep, but adapter.settlementFixture is undefined — this is a WIRING GAP in the calling test file, not a store defect. Pass 'defaultSettlementFixture' from this module …
```

The 55 laws:

```text
FRESH_APPLICATION, CONDITIONAL_NOOP, CONDITIONAL_NOOP_GRANDFATHERED, OWNERSHIP_REFUSAL,
LEDGER_MINT_ATOMICITY, DRAIN_MARK_DEDUP, TERMINAL_REFUSAL, TERMINAL_STATE_ONLY, CS_PURITY,
NEVER_DOWNGRADE, SETTLE_OUTCOME_INTEGRITY, SETTLED_ORPHAN_OVERWRITE, TRANSFORM_FIDELITY,
RESULT_AS_APPLIED, MARK_MEMBERSHIP, REFUSAL_SWEEP, MINT_FRESH, SELF_IMAGE_IDEMPOTENCE,
TERMINAL_GATE_EXCLUSION, COMPLETE_SEAL_PHASE, WHEN_ROUTED_TERMINALIZATION, G1_GATE_COEXISTENCE,
GATE_OPEN_IDEMPOTENT, GATE_RESOLUTION_CONFLICT, GATE_MISMATCH, GUARD_OUTCOME_DIVERGENCE,
GUARD_WAITS_ON_OPEN_GATE, GUARD_PASS_COMPLETE_OUTCOME, GUARD_ABORT_CASCADE, GUARD_NO_ENTRY,
GUARD_CASCADE_ONE_WRITE, GUARD_CASCADE_TOTAL,
RELEASE_IDEMPOTENT, PHASE_IS_GENERATED, CWFS_FIRES_PER_ARM, CWFS_NEGATIVES,
SEAL_FRESH_WRITE_REFUSED, SEAL_ORPHAN_REFUSED, SEAL_ERASE_REFUSED, SEAL_UNKNOWN_ARM_REFUSED,
STAMP_PRESERVES_UPDATED_AT, STAMP_BUMPS_VERSION_ONCE, STAMP_REFUSES_ON_VERSION_MOVE,
STAMP_RETURNS_NOT_THROWS_PREDICATES, STAMP_IDEMPOTENT, STAMP_CLASSIFIED_ROUNDTRIP,
SEAL_REWRITE_REFUSED, CWFS_SECOND_EPOCH, CWFS_ARRAY_ONCE, CURRENT_BEHAVIOR_PINNED,
EXPIRE_ARM_MATRIX, EXPIRE_ABORT_CASCADE, EXPIRE_DEFAULT_RESOLVE, GATE_PROOF_NEVER_GATES_THE_ANSWER,
ADAPTER_WIRING, STORE_RELEASE_LINE_TRUE
```

Each case's `name` says in a sentence what the law requires. With `InMemoryStore`, 55 of the laws have cases. `ADAPTER_WIRING` has one only when the adapter is incomplete.

`GATE_PROOF_NEVER_GATES_THE_ANSWER` was added after version 0.45.0. It answers one question: does a token passed with a gate answer change anything but the `claim_proof` on the answer's entry? For each way a token can relate to the claim (`matched`, `absent`, `mismatch`, and each cause of `unverifiable` and `spent`), the record after the answer must equal the record after the same answer with no token, except for that field. It also checks that the verdict survives a guard settled in the same write, that `gateClaim.claim` carries `holder` and `since` and never the token, and that a store declaring `persistsClaims: false` gets `store_keeps_no_claims`. A store's `settleStep` must return the `gateClaim` that `applySettlement` computed, and must pass `storeKeepsClaims: store.persistsClaims === true` to it.

`defaultSettlementFixture` has 3 functions: `minimalDefinition(stepNames)`, `withFinalizer(definition, name, onOutcome)` and `withGuard(definition, name, abortUnless, options?)`.

Types: `SettlementContractAdapter`, `SettlementContractCase`, `SettlementFixture`, `SettlementLaw`.

### `perRunArtifactStoreContract(adapter)`

| Adapter field       | Holds                                                                                        |
| ------------------- | -------------------------------------------------------------------------------------------- |
| `store`             | The store.                                                                                   |
| `runIdWithArtifact` | The ID of a run the store holds something for, put there before the case runs.               |
| `runIdAbsent`       | The ID of a run the store holds nothing for.                                                 |
| `injectFailure`     | A function that makes what the store holds for a run unreachable, so that deleting it fails. |
| `reseed`            | A function that puts back what the store holds for `runIdWithArtifact`.                      |

| Law                         | The case's name                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------ |
| `L1_ABSENCE_RESOLVES`       | deleteAllForRun resolves (never rejects) for a run that owns no artifact                   |
| `L2_IDEMPOTENT`             | deleteAllForRun is idempotent — a second call after a successful delete still resolves     |
| `L3_FAILURE_REJECTS`        | deleteAllForRun rejects when the artifact exists but is genuinely unreachable (non-ENOENT) |
| `L4_TYPED_REJECTION`        | the L3 rejection is a WorkflowError carrying a code and details.failures                   |
| `L5_REPORT_SHAPE`           | both methods report zero for an absent run, and a positive figure for a seeded one         |
| `L6_PREVIEW_EQUALS_RECEIPT` | on an unchanged run, statAllForRun equals the bytes a subsequent delete reports            |
| `STORE_RELEASE_LINE_TRUE`   | the store's declared release line is the line of its own refusal (the L4 injected failure) |

Types: `PerRunArtifactStoreContractAdapter`, `ArtifactStoreContractCase`, `ArtifactStoreLaw`.

### `fencedTraceBufferContract(adapter)`

| Adapter field                                  | Required                 | Holds                                                                                                                                                |
| ---------------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `store`                                        | Yes                      | The store, built over the `reader` of a run source.                                                                                                  |
| `fenceRuns`                                    | Yes                      | The run source's `control`. The cases use it to create, change and remove the runs the store reads.                                                  |
| `makeKey`                                      | Yes                      | A function that returns a new `{ runId, stepId }` on each call.                                                                                      |
| `fenceForm`                                    | Yes                      | `'injected-reader'` for a store that reads runs through a reader it is given, `'in-transaction'` for one that reads them inside its own transaction. |
| `fenceRunPark`                                 | With `'injected-reader'` | The run source's `park`. The cases use it to hold or fail the store's next read of a run.                                                            |
| `lockProfile`, `bytesOracle`, raw byte readers | No                       | Optional extras. Without one, the checks that need it are skipped, and the case says so.                                                             |

The 12 laws: `STRUCTURAL`, `FENCE_REFUSES`, `FENCE_DATA`, `CS_OCCUPANCY`, `PER_KEY_INDEPENDENCE`, `NO_SILENT_LOSS`, `CARRIAGE_ROUND_TRIP`, `SEAL`, `SEAL_BUDGET`, `PER_WRITER_BUDGET`, `VERBATIM`, `STORE_RELEASE_LINE_TRUE`.

Types: `FencedTraceBufferContractAdapter`, `FencedTraceBufferContractCase`, `FencedTraceBufferLaw`.

### `createFenceRunSource()`

Returns a `FenceRunSource`: a place to keep runs for the fenced contract, with 3 parts.

| Part      | Type              | Has                                                                                                               |
| --------- | ----------------- | ----------------------------------------------------------------------------------------------------------------- |
| `reader`  |                   | `get(runId)`, which returns a copy of the run, or throws Realm's `Run not found` error.                           |
| `control` | `FenceRunControl` | `put(run)`, `remove(runId)` and `readCount(runId)`.                                                               |
| `park`    | `FenceRunPark`    | `parkNextRead(runId)`, which returns a `ParkedRead` with `entered` and `release`, and `failNextRead(runId, err)`. |

```js
const source = createFenceRunSource();
source.control.put(fenceTestRun('r1'));
(await source.reader.get('r1')).id; // 'r1'
source.control.readCount('r1'); // 1
source.control.remove('r1');
await source.reader.get('r1'); // throws WorkflowError STATE_RUN_NOT_FOUND: Run not found: r1
```

### `fenceTestRun(runId, overrides?)`

Returns a small run record for those cases: an open run at version 1 with no steps in any list. With `{ terminal: true }` it is a completed run.

```json
{
  "id": "r1",
  "workflow_id": "fenced-tck-workflow",
  "workflow_version": 1,
  "completed_steps": [],
  "in_progress_steps": [],
  "failed_steps": [],
  "skipped_steps": [],
  "run_phase": "running",
  "version": 1,
  "params": {},
  "evidence": [],
  "created_at": "2026-01-01T00:00:00.000Z",
  "updated_at": "2026-01-01T00:00:00.000Z",
  "terminal_state": false
}
```

## See also

- [Test a workflow](../guides/test-a-workflow.md) covers fixture files and `realm workflow test`.
- [Handlers](handlers.md) and [Project extensions](project-extensions.md)
- [Core library](core-library.md) covers the store interfaces the contracts test.
