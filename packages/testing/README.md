# @sensigo/realm-testing

`@sensigo/realm-testing` — testing utilities for Realm workflows. Use this package to write unit and integration tests against your workflow definitions without making real service calls or writing to disk.

## Installation

```
npm install --save-dev @sensigo/realm-testing
```

Requires `@sensigo/realm` at the same version to be installed in your project.

> **Version note (issue #367).** This release grows the published conformance suites, so a custom
> `RunStore` that passed the previous version can fail this one — by design. A store declaring
> `settleStep` must now also declare and round-trip `sealed_by` (the recorded seal arm), and must
> REFUSE four write-integrity violations: an unstamped fresh seal, a resume that keeps the stamp, a
> terminal rewrite that drops it, and an arm outside `SEAL_ARMS`. The new laws are
> `SEAL_FRESH_WRITE_REFUSED`, `SEAL_ORPHAN_REFUSED`, `SEAL_ERASE_REFUSED`,
> `SEAL_UNKNOWN_ARM_REFUSED` and `SEALED_BY_ROUNDTRIP`. They bind DECLARING stores only — a store
> that declares neither `settleStep` nor the field passes them vacuously, exactly as before.
> `assertFinalState` also now DERIVES the run phase instead of reading the persisted `run_phase`,
> so a test whose fixture carried a stale label may start failing honestly.

## Usage — YAML Fixture Tests

Fixture tests are the fastest way to test a complete workflow. Each fixture file declares the initial params, mock service responses, agent step outputs, and the expected final state. The `runFixtureTests` runner loads your workflow, drives it to completion using the fixture data, and returns a result for each fixture.

```ts
// workflow-test.ts
import { describe, it, expect } from 'vitest';
import { runFixtureTests } from '@sensigo/realm-testing';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('my-workflow fixtures', async () => {
  const results = await runFixtureTests({
    workflowPath: path.join(__dirname, '../my-workflow'), // accepts workflow.yaml path OR its containing directory
    fixturesPath: path.join(__dirname, '../my-workflow/fixtures'),
  });

  for (const result of results) {
    it(result.name, () => {
      expect(result.passed, result.error).toBe(true);
    });
  }
});
```

## Usage — Programmatic Tests

Use programmatic tests when you need fine-grained control over a single step, a specific execution path, or assertions on individual evidence entries.

```ts
import { describe, it, expect } from 'vitest';
import { InMemoryStore, assertFinalState } from '@sensigo/realm-testing';
import { loadWorkflowFromFile } from '@sensigo/realm'; // NOTE: from @sensigo/realm, not @sensigo/realm-testing
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('my-workflow programmatic', () => {
  it('run reaches expected final state', async () => {
    const store = new InMemoryStore();
    const definition = await loadWorkflowFromFile(
      path.join(__dirname, '../my-workflow/workflow.yaml'),
    );
    const run = await store.create({
      workflowId: definition.id,
      workflowVersion: definition.version,
      params: { input: 'hello' },
    });

    // drive the run to completion first — see examples/02-ticket-classifier/ for a full test
    assertFinalState(run, 'completed');
  });
});
```

## API Reference

### Store

| Symbol          | Description                                                                             |
| --------------- | --------------------------------------------------------------------------------------- |
| `InMemoryStore` | In-memory `RunStore` implementation. No I/O, no locking. Safe to use in parallel tests. |

### Fixtures

| Symbol                  | Description                                        |
| ----------------------- | -------------------------------------------------- |
| `loadFixtureFromFile`   | Load a single fixture from a `.yaml` file path.    |
| `loadFixtureFromString` | Parse a fixture from a YAML string.                |
| `loadFixturesFromDir`   | Load all `*.yaml` fixtures from a directory.       |
| `TestFixture`           | Type — a parsed fixture object.                    |
| `MockOperations`        | Type — the mock service call map within a fixture. |

### Mocks

| Symbol                  | Description                                                                      |
| ----------------------- | -------------------------------------------------------------------------------- |
| `MockServiceRecorder`   | Records adapter calls for later assertion.                                       |
| `createAgentDispatcher` | Creates a dispatcher that returns fixture-defined agent step outputs.            |
| `createGateResponder`   | Creates a gate responder that auto-resolves gates using fixture-defined choices. |

### Assertions

| Symbol                | Description                                                    |
| --------------------- | -------------------------------------------------------------- |
| `assertFinalState`    | Assert the run reached a specific terminal state.              |
| `assertStepSucceeded` | Assert a named step completed without error.                   |
| `assertStepFailed`    | Assert a named step is in the failed steps list.               |
| `assertStepOutput`    | Assert the output of a completed step matches a value.         |
| `assertEvidenceHash`  | Assert the evidence hash for a step matches an expected value. |

### Unit test helpers

| Symbol            | Description                                                          |
| ----------------- | -------------------------------------------------------------------- |
| `testStepHandler` | Run a single step handler in isolation and return its output.        |
| `testProcessor`   | Run a processor function against a run record and return the result. |
| `testAdapter`     | Invoke an adapter operation and return the `ServiceResponse`.        |

### Runner

| Symbol                   | Description                                                                             |
| ------------------------ | --------------------------------------------------------------------------------------- |
| `runFixtureTests`        | Drive a workflow to completion for all fixtures in a directory. Returns `TestResult[]`. |
| `RunFixtureTestsOptions` | Type — options for `runFixtureTests` (`workflowPath`, `fixturesPath`, `registry?`).     |
| `TestResult`             | Type — result of a single fixture run (`name`, `passed`, `error?`).                     |

### Servers

| Symbol                   | Description                                                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `startGitHubMockServer`  | Integration testing helper for workflows that use the GitHub adapter. See the `examples/08-pr-review/` example for usage. |
| `GitHubMockServerHandle` | Type — handle returned by `startGitHubMockServer` (`url`, `close()`).                                                     |

## Full documentation

Full documentation: https://github.com/sensigo-hq/realm
