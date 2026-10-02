# Project extensions

A project gives Realm its own code in files that a workflow names with `extensions`. A file can provide 3 kinds of thing: adapters, handlers and processors. This page gives what a file must export, what each kind must have, every refusal, which commands load the code and when, and what a run records about the code that ran it. Every message shown came from a run of `realm` against a project at `/srv/shop`.

The same 3 kinds can also be built from settings in `realm.yaml`. See [Deployment manifest](deployment-manifest.md).

## Naming the files

```yaml
extensions: ../ext/a.mjs
```

```yaml
extensions:
  - ../ext/a.mjs
  - ../ext/b.mjs
```

`extensions` is one path or a list of paths. Each path is taken from the workflow's folder, and each file must be inside the workflow's project. The field is described in [Workflow file: top-level fields](workflow/top-level-fields.md).

## What a file exports

The file's default export is an object with up to 3 keys. Each is a map from a name to a thing:

```js
export default {
  adapters: { crm: crmAdapter },
  handlers: { order_total: orderTotal },
  processors: {},
};
```

| Key          | Each thing must have                          | Type exported by `@sensigo/realm` | A workflow uses it with              |
| ------------ | --------------------------------------------- | --------------------------------- | ------------------------------------ |
| `adapters`   | The functions `fetch`, `create` and `update`. | `ServiceAdapter`                  | `adapter: <name>` in `services`.     |
| `handlers`   | The function `execute`.                       | `StepHandler`                     | `handler: <name>` on a step.         |
| `processors` | The function `process`.                       | `Processor`                       | Nothing. No workflow field uses one. |

Realm checks that those functions are there, and checks nothing else about the thing. It does not have to be made from a class.

`realm workflow validate` counts what the files gave:

```text
Valid: flow v1 (1 step)
Extensions: ../ext/a.mjs, ../ext/b.mjs (adapters: 0, handlers: 2, processors: 0)
```

### Names

The name of a thing is its key in the map.

| Case                                            | What happens                                                                                                                                                           |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The thing has an `id` that differs from its key | The key is used. `[realm] extension handler registered as 'hello' (map key) but its instance id is 'x' (module '../ext/a.mjs'). The registration name is the map key.` |
| An adapter is named `filesystem`                | It replaces the built-in one. `[realm] extension adapter 'filesystem' from '../ext/a.mjs' overrides the built-in adapter 'filesystem'.`                                |
| Two files give the same name                    | Refused. `Extension handler 'hello' is declared by both '../ext/a.mjs' and '../ext/b.mjs' — extension names must be unique across declared modules.`                   |
| A file and `realm.yaml` give the same name      | Refused. See [Deployment manifest](deployment-manifest.md#refusals).                                                                                                   |

Adapters, handlers and processors are named apart: an adapter and a handler may have the same name.

### File formats

| File                                     | Loaded as                                                        | Recorded as |
| ---------------------------------------- | ---------------------------------------------------------------- | ----------- |
| `.mjs`, or `.js` in an ES-module project | An ES module.                                                    | `esm`       |
| `.cjs`                                   | A CommonJS module. `module.exports` is the object.               | `cjs`       |
| `.ts`, `.mts`, `.cts`                    | TypeScript, through the `jiti` package installed in the project. | `ts-jiti`   |

Without `jiti` in the project, a TypeScript file is refused:

```text
Error loading extensions: Module '../ext/e.ts' (/srv/shop/ext/e.ts) is TypeScript, but 'jiti' is not installed in your project. Install jiti in your project (npm install --save-dev jiti), or compile the module to JS and declare the compiled path.
```

### Refusals

Each message follows `Error loading extensions:`.

| The file                                                    | Message                                                                                                                                                                                                 |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Is not there                                                | `Cannot resolve extension module '../ext/a.mjs' of workflow 'flow' (resolved: /srv/shop/ext/a.mjs): ENOENT: no such file or directory, lstat '/srv/shop/ext/a.mjs'`                                     |
| Is outside the project, or is a link to a file outside it   | `Extension module '../../outside.mjs' resolves to '/srv/outside.mjs', which is OUTSIDE the workflow's trust root '/srv/shop'. Extension modules must live within the project containing the workflow …` |
| Throws when it is loaded                                    | `Failed to import module '../ext/a.mjs' (/srv/shop/ext/a.mjs): DATABASE_URL is not set`                                                                                                                 |
| Has a syntax error                                          | `Failed to import module '../ext/a.mjs' (/srv/shop/ext/a.mjs): Unexpected end of input`                                                                                                                 |
| Imports a package that is not installed                     | `Failed to import module '../ext/a.mjs' (/srv/shop/ext/a.mjs): Cannot find package 'not-installed-pkg' imported from /srv/shop/ext/a.mjs`                                                               |
| Has no default export                                       | `Extension module '../ext/a.mjs' has no default export — export a declarative object: export default { adapters: { name: instance }, handlers: { ... }, processors: { ... } }`                          |
| Exports a list or a function                                | `Extension module '../ext/a.mjs': default export must be a plain object ({ adapters?, handlers?, processors? }), got array.`                                                                            |
| Exports an object with `register` or `getAdapter` functions | `Extension module '../ext/a.mjs': default export looks like an ExtensionRegistry instance. Export a declarative object instead: …`                                                                      |
| Has a key other than the 3                                  | `Extension module '../ext/a.mjs': unknown key 'helpers' in default export — allowed keys are 'adapters', 'handlers', 'processors'.`                                                                     |
| Has a list where a map belongs                              | `Extension module '../ext/a.mjs': 'handlers' must be an object map of name → instance, got array.`                                                                                                      |
| Has an entry that is not an object                          | `Extension handler 'hello' in '../ext/a.mjs': expected an object instance, got null.`                                                                                                                   |
| Has a handler without `execute`                             | `Extension handler 'hello' in '../ext/a.mjs': missing callable 'execute' — handlers must implement 'execute' per the @sensigo/realm StepHandler interface.`                                             |
| Has an adapter without one of its 3 functions               | `Extension adapter 'crm' in '../ext/a.mjs': missing callable 'create' — adapters must implement 'fetch'/'create'/'update' per the @sensigo/realm ServiceAdapter interface.`                             |
| Has a processor without `process`                           | `Extension processor 'clean' in '../ext/a.mjs': missing callable 'process' — processors must implement 'process' per the @sensigo/realm Processor interface.`                                           |

A value of `extensions` that is not a path or a list of paths is refused by the workflow loader:

```text
Invalid workflow: 'extensions' must be a non-empty module path or a non-empty array of module paths (e.g. extensions: ./dist/registry.js)
```

## Handlers

See [Handlers](handlers.md).

## Adapters

```ts
interface ServiceAdapter {
  readonly id: string;
  readonly config_schema?: Record<string, unknown>;
  readonly defaultRetryAfterSeconds?: number;
  fetch(operation, params, config, signal?): Promise<ServiceResponse>;
  create(operation, params, config, signal?): Promise<ServiceResponse>;
  update(operation, params, config, signal?): Promise<ServiceResponse>;
  delete?(operation, params, config, signal?): Promise<ServiceResponse>;
}

interface ServiceResponse {
  status: number;
  data: unknown;
}
```

A step chooses the function with `service_method`: `fetch`, `create`, `update` or `delete`. Without it, `fetch` is called.

### What a function receives

| Argument    | Holds                                                                               |
| ----------- | ----------------------------------------------------------------------------------- |
| `operation` | The step's `operation`. The step's name if it has none.                             |
| `params`    | The values the step's `input_map` resolved to. `{}` without one.                    |
| `config`    | `adapter` and `trust` from the service, then the keys of the step's `config` block. |
| `signal`    | An `AbortSignal` that fires when the step's time limit passes.                      |

This step:

```yaml
only:
  description: Call the adapter.
  execution: auto
  uses_service: crm
  operation: get_customer
  config: { region: eu }
  input_map:
    id: run.params.id
```

in a run started with `{"id":"C-9"}`, called `fetch` with:

```json
{
  "operation": "get_customer",
  "params": { "id": "C-9" },
  "config": { "adapter": "crm", "trust": "engine_delivered", "region": "eu" }
}
```

### What a function returns

| The function                                        | The step                                                                            |
| --------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Returns `{ status, data }` with an object as `data` | Completes. Its output is `data`.                                                    |
| Returns `{ status: 200, data: 42 }`                 | Completes. Its output is `{"data":42,"status":200}`.                                |
| Throws an `Error`                                   | Fails: `Step 'only' failed: Adapter 'crm' threw: the CRM is down`                   |
| Throws a `WorkflowError`                            | Fails with that error. See [Handlers](handlers.md#what-a-thrown-error-does).        |
| Is `delete`, and the adapter has none               | Fails: `Step 'only' failed: Adapter 'crm' does not support service_method 'delete'` |

Realm does not read `status`. An adapter reports a failure by throwing.

### `config_schema`

A step may have a `config` block only if its adapter has a `config_schema`, a JSON Schema for that block. `realm workflow validate` and `realm workflow register` check the block against it:

| The step                                               | Message                                                                                                                                               |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Has a `config` the schema refuses                      | `Invalid workflow: Step 'only': config validation failed against adapter config_schema: must be equal to one of the allowed values (step at line 10)` |
| Has a `config`, and the adapter has no `config_schema` | `Invalid workflow: Step 'only': 'config' declared but adapter 'plain' does not declare 'config_schema' (step at line 10)`                             |

`realm agent --workflow` does not make this check. It ran both workflows above, and the adapter received the refused `config`.

## When each command loads the code

| Command                                                             | Loads the code                                    | If loading fails         |
| ------------------------------------------------------------------- | ------------------------------------------------- | ------------------------ |
| `realm workflow validate`, `register`, `watch`                      | Before it accepts the workflow.                   | The workflow is refused. |
| `realm workflow test`                                               | Before the fixtures run.                          | The command fails.       |
| `realm agent --workflow`, `realm workflow run`                      | Before the run is created.                        | No run is created.       |
| `realm agent --run-id`                                              | Before it continues the run.                      | See below.               |
| `realm listen`                                                      | When it starts, for every workflow it mounts.     | It does not start.       |
| `realm mcp`, `realm serve`                                          | The first time a tool call needs the workflow.    | The tool call fails.     |
| `realm run respond`, `realm run drain`                              | When it runs.                                     | The command fails.       |
| `realm-mcp`, from the package `@sensigo/realm-mcp`                  | Never. A step that needs project code is blocked. |                          |
| `realm run list`, `inspect`, `attempts`, `diff`, `replay`, `export` | Never.                                            |                          |

With a code file that throws when loaded, `realm run inspect`, `list`, `replay` and `diff` gave their usual output.

`realm mcp` and `realm serve` keep the code they loaded until the process ends. After a code file changes, restart the process. `realm listen` loads again in each `realm agent` it starts.

### `realm agent --run-id` and code that does not load

| The run                   | After the failed command                                                |
| ------------------------- | ----------------------------------------------------------------------- |
| Has run no step yet       | It is ended as `failed`, with the cause `extensions_load_failed`.       |
| Has run at least one step | It is as it was. A run waiting at a gate was still waiting at the gate. |

```text
Error: Failed to import module '../ext/a.mjs' (/srv/shop/ext/a.mjs): boom at import
```

```text
Phase: failed
Sealed by: extensions_load_failure
Cause: extensions_load_failed
```

After the file was fixed, the same `realm agent --run-id` command opened the run again and ran it.

### `--extensions-module <path>`

`realm agent`, `realm workflow run`, `realm workflow validate`, `realm workflow test`, `realm mcp`, `realm serve`, `realm run respond` and `realm run drain` take `--extensions-module <path>`. The file is loaded in place of every file the workflow names. It does not have to be inside the project.

```text
[realm] --extensions-module override active: loading '/srv/repair.mjs' (resolved: /srv/repair.mjs). Declared workflow extensions are IGNORED.
```

The flag does not replace `realm.yaml`.

## What a run records

When a step runs, Realm records which code the process had loaded. `realm run inspect` prints it:

```text
Extension Identity (1 entry):
  1. captured 2026-10-02T00:21:08.513Z (pid 3318070)
     module: ../ext/a.mjs -> /srv/shop/ext/a.mjs (esm)
             entry_hash 35391d53865df6a1acba50fbda535cd9de562acbc927ce3d10340fbdc0ab4c9a
     tree: 5 files, 637 bytes
           tree_hash a2b2f92cfc3d679cfeae27ac52d4343972aaaed81ab143d6dbff914c50d706f1
     signals: package_version 1.4.0
     coverage (dir_tree_v1): covers files under /srv/shop/ext matching dir_tree_v1: include .js,.mjs,.cjs,.ts,.mts,.cts,.json; exclude dirs node_modules,.git; skip symlinks; sort by relpath; sha256(relpath\0filehash); caps 2000 files/50MB; imports outside these roots, node_modules, and runtime dynamic imports are NOT covered.
```

| Part         | Holds                                                                                                                 |
| ------------ | --------------------------------------------------------------------------------------------------------------------- |
| `captured`   | When the code was loaded, and the ID of the process that loaded it.                                                   |
| `[override]` | Printed after the process ID if `--extensions-module` was used.                                                       |
| `module`     | For each file: the path as written, the path it resolved to, the format, and a SHA-256 hash of the file.              |
| `tree`       | One hash over the code files in the folders that hold the named files, with the number of files and their size.       |
| `signals`    | The `version` in the project's `package.json`, and the commit that `.git/HEAD` points to. Recorded, and not compared. |
| `coverage`   | Which files the tree hash covers.                                                                                     |

The tree hash covers files ending in `.js`, `.mjs`, `.cjs`, `.ts`, `.mts`, `.cts` or `.json`, at any depth under the folder of each named file. It leaves out `node_modules`, `.git` and links. It stops at 2000 files or 50 MB. A file that the code imports from another folder is not covered.

For a project with a `realm.yaml`, the record also holds that file's path and hash, and the names of the secrets it refers to. See [Deployment manifest](deployment-manifest.md#what-a-run-records).

### When the code changes during a run

Realm adds an entry when a step runs and the loaded code differs from the last entry. A run was paused at a gate, a code file was edited, and a new `realm agent --run-id` continued the run:

```text
[realm] WARN: extension code identity differs from this run's last recorded identity — recorded tree_hash a2b2f92c… (captured 2026-10-02T00:21:08.513Z), current tree_hash b71e8739… (captured 2026-10-02T00:21:25.606Z). Advisory only — the run proceeds; …
```

```text
Extension Identity (2 entries):
  1. captured 2026-10-02T00:21:08.513Z (pid 3318070)
     …
  2. captured 2026-10-02T00:21:25.606Z (pid 3333013)
     …
```

The run goes on. The warning does not stop it.

### `--check-drift`

`realm run inspect <run-id> --check-drift` hashes the files on disk again and compares them with the last entry:

```text
Drift check (pure recompute of the last entry under its recorded rules):
  module /srv/shop/ext/a.mjs: same
  tree: same
```

A file that differs is shown with both hashes:

```text
  module /srv/shop/handlers.mjs: DIFFERS (recorded 1bce8906e68a…, current 7c022774ac3b…)
```

The check compares files on disk with what the run recorded. A running `realm mcp` or `realm serve` may still hold older code than the disk.

## Workflows made by an assistant

A workflow made with the `create_workflow` tool has agent steps only, and the tool takes no `extensions`. Realm also refuses to load code for a stored workflow that is marked as made by an assistant and has `extensions`.

## See also

- [Write a step handler](../guides/step-handlers.md)
- [Handlers](handlers.md), [Adapters](adapters.md), [Deployment manifest](deployment-manifest.md)
- [Deploy a project](../guides/deploy.md)
- [`realm run`: commands that read](cli/realm-run-reading.md) covers `inspect --check-drift`.
