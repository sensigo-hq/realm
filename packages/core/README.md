# @sensigo/realm

`@sensigo/realm` — the Realm workflow execution engine. Use this package to load, register, and execute YAML-defined workflows programmatically, or to build custom service adapters and step handlers.

## Installation

```
npm install @sensigo/realm
```

## Usage — Execute a Workflow

Load a workflow definition and drive it step by step. Each `executeStep` call advances the run and returns a `ResponseEnvelope` with the current state and what comes next.

```ts
import { loadWorkflowFromFile, JsonFileStore, executeStep } from '@sensigo/realm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const definition = loadWorkflowFromFile(path.join(__dirname, 'my-workflow/workflow.yaml'));

const store = new JsonFileStore(); // defaults to ~/.realm/runs/
const { run } = await store.create({
  workflowId: definition.id,
  workflowVersion: definition.version,
  params: { input: 'hello' },
});

const response = await executeStep(store, definition, {
  runId: run.id,
  command: 'my_step',
  input: { answer: 'done' },
  dispatcher: async (_stepName, stepInput) => stepInput, // replace with real agent/handler
});

console.log(response.status);
// response.next_actions[0] carries the next step to execute; when it names advance_run, call
// advanceRun(store, definition, { runId: run.id }) (import it beside executeStep) —
// repeat until next_actions is empty
```

## Usage — Custom Service Adapter

Implement `ServiceAdapter` to connect a workflow step to any external API, then register it with `ExtensionRegistry` before executing.

```ts
import {
  ExtensionRegistry,
  executeStep,
  type ServiceAdapter,
  type ServiceResponse,
} from '@sensigo/realm';

// callMyApi: your own client for the API, not defined here
const myAdapter: ServiceAdapter = {
  id: 'my-api',
  async fetch(operation, params, _config): Promise<ServiceResponse> {
    const data = await callMyApi(operation, params);
    return { status: 200, data };
  },
  async create(operation, params, _config): Promise<ServiceResponse> {
    return this.fetch(operation, params, _config);
  },
  async update(operation, params, _config): Promise<ServiceResponse> {
    return this.fetch(operation, params, _config);
  },
};

const registry = new ExtensionRegistry();
registry.register('adapter', 'my-adapter', myAdapter);

// Pass registry to executeStep or executeChain:
// await executeStep(store, definition, { ..., registry });
```

## API Reference

### Engine

| Symbol                | Notes                                                                                                                                                                        |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `executeStep`         | Advance a run by one step. Returns `ResponseEnvelope`.                                                                                                                       |
| `executeChain`        | Auto-chain through auto steps until an agent step is reached.                                                                                                                |
| `submitHumanResponse` | Resolve an open human gate.                                                                                                                                                  |
| `advanceRun`          | Run what a run owes the engine — an expired question's declared `on_expiry`, then its guards and `auto` steps. Returns `ResponseEnvelope`.                                   |
| `buildNextActions`    | Build `NextAction[]` for what the run waits on: the agent steps that can be called, `advance_run` when the engine owes work, or the open question's `submit_human_response`. |
| `findEligibleSteps`   | Return names of steps ready to execute given current run state.                                                                                                              |
| `propagateSkips`      | Propagate skip flags through dependent steps.                                                                                                                                |

### Store

| Symbol              | Notes                                                  |
| ------------------- | ------------------------------------------------------ |
| `JsonFileStore`     | File-backed `RunStore`. Defaults to `~/.realm/runs/`.  |
| `JsonWorkflowStore` | File-backed store for registered workflow definitions. |

### Workflow

| Symbol                   | Notes                                                  |
| ------------------------ | ------------------------------------------------------ |
| `loadWorkflowFromFile`   | Synchronous. Parses `workflow.yaml` at the given path. |
| `loadWorkflowFromString` | Parse a workflow from a raw YAML string.               |

### Adapters

| Symbol               |
| -------------------- |
| `FileSystemAdapter`  |
| `GitHubAdapter`      |
| `SlackAdapter`       |
| `GenericHttpAdapter` |
| `MockAdapter`        |

### Registry

| Symbol                  |
| ----------------------- |
| `ExtensionRegistry`     |
| `createDefaultRegistry` |

### Types

| Symbol               |
| -------------------- |
| `WorkflowDefinition` |
| `RunRecord`          |
| `ResponseEnvelope`   |
| `ServiceAdapter`     |
| `ServiceResponse`    |
| `RunStore`           |
| `WorkflowError`      |

### Processors

| Symbol          |
| --------------- |
| `normalizeText` |
| `computeHash`   |

### Handler primitives

| Symbol                 |
| ---------------------- |
| `resolveResource`      |
| `walkField`            |
| `partitionBySubstring` |
| `countResults`         |
| `compareStrings`       |

## Full documentation

Full documentation: https://github.com/sensigo-hq/realm
