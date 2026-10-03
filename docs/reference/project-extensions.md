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

## Which realm your code imports

npm can install a realm package more than once on one machine: once in your project, and once more with the `realm` command, or nested under another realm package. Your code imports the copy nearest its own file. The `realm` command imports the copy installed with it. This page calls each of them a copy.

Your code and the `realm` command must use the same realm version. Copies of one version work together: an error or a provider made with one copy is recognised by the other. Copies of different versions do not, even one patch apart. The same holds for a program of your own that uses the realm packages as a library.

Copies of one version working together was added after version 0.45.0. On 0.45.0 two copies do not recognise each other's objects, whatever their versions, so matching version numbers are not enough there: your code and the command must share one copy. Install `@sensigo/realm-cli` in the project beside `@sensigo/realm`, at the same version, and run it with `npx realm`.

With different versions, Realm objects do not cross versions: a `WorkflowError` your handlers or adapters throw is not recognised — its step fails after one attempt, without that error's own code and retry setting. From a copy that carries the release mark, the message names both versions and both folders, and the reply of the call that ran the step (`start_run` or `execute_step` over MCP) carries the code `ENGINE_RELEASE_LINE_MISMATCH`. From an older copy with no mark (0.45.0 and earlier), the step fails with the ordinary failure message plus a note — the class carries no release mark, what was not used if it is realm's, and the way out — and the reply carries `ENGINE_HANDLER_FAILED` (`ENGINE_ADAPTER_FAILED` for an adapter); [Upgrade Realm](../guides/upgrade.md) shows one. Either way the run record keeps the message only. A handler of the project's 0.45.1 copy under a `realm agent` of 0.45.0 fails its step like this (folders shortened):

```text
✗ Step 'only' failed: Handler 'flaky' threw a WorkflowError from realm 0.45.1 (/srv/shop/node_modules/@sensigo/realm); this engine runs realm 0.45.0 (/usr/lib/node_modules/@sensigo/realm-cli/node_modules/@sensigo/realm). Realm objects do not cross versions, so its code 'SERVICE_RATE_LIMITED' and its retry setting were not used. Install @sensigo/realm@0.45.0 (and every other @sensigo package the project has, at 0.45.0) in the project your code imports it from, or, when you run the realm command, run version 0.45.1 there: npm install --save-dev @sensigo/realm-cli@0.45.1, then npx realm.
```

Where your code is loaded, the command warns about it first, as [`REALM_RELEASE_LINE_MISMATCH`](workflow/loader-diagnostics.md#warning-codes):

```text
⚠ Your project's @sensigo/realm is 0.45.1 (/srv/shop/node_modules/@sensigo/realm, installed by the project); this realm command runs @sensigo/realm 0.45.0. Realm objects do not cross versions: a WorkflowError your handlers or adapters throw is not recognised — its step fails after one attempt, without that error's own code and retry setting. Install @sensigo/realm@0.45.0 (and every other @sensigo package the project has, at 0.45.0) in the project your code imports it from, or, when you run the realm command, run version 0.45.1 there: npm install --save-dev @sensigo/realm-cli@0.45.1, then npx realm.
```

A provider module given to `realm agent --provider-module` whose `LlmProvider` comes from another realm-cli version is refused with `Error: the provider module's LlmProvider comes from @sensigo/realm-cli <its version> (<its folder>); this realm command is @sensigo/realm-cli <the command's version> (<its folder>). …` and exit code 1. The message ends with the two ways out: run the project's own realm at its version (`npm install --save-dev @sensigo/realm-cli@<its version>`, then `npx realm`), or install `@sensigo/realm-cli` and `@sensigo/realm` at the command's version in the project — installing only the matching `@sensigo/realm-cli` would let the provider through and fail at the first handler error instead. These messages were added after version 0.45.0; on 0.45.0 the step fails as `ENGINE_HANDLER_FAILED` and the provider is refused with `Error: provider module default export must be an instance extending LlmProvider.`

To see the versions, run `realm --version`, and in the project `npm ls @sensigo/realm @sensigo/realm-cli`. Every number must be the same. To fix a difference, install every realm package the project uses, and the `realm` command, at one exact version (see [Upgrade Realm](../guides/upgrade.md#2-upgrade-every-package-together)). Or install `@sensigo/realm-cli` in the project at the same version as the project's `@sensigo/realm`, and run it with `npx realm`.

A package of handlers or adapters that other projects install should declare `@sensigo/realm` in `peerDependencies` with a caret range on the version it was built against (for example `"^0.45.0"`), and also in `devDependencies`, so that its own tests have a copy. When the project's version is inside the range, the package uses the project's copy. When it is outside, npm with its default settings refuses the install with `ERESOLVE`. A package that declares `@sensigo/realm` as an ordinary dependency at a version other than the project's brings a second copy, and Realm does not recognise that copy's errors.

### A store of your own

A program that hands Realm a store of its own (a run store, a workflow store, a trace buffer or a failed-attempt store) must declare which realm it belongs to, once, from the `@sensigo/realm` the store imports its errors from:

```js
import { declareReleaseLine } from '@sensigo/realm';

class TenantScopedRunStore {
  /* … */
}
declareReleaseLine(TenantScopedRunStore);
```

A store built as a plain object is declared with `declareReleaseLine(store)`. Realm's own store classes already carry their line. A store that declares none is refused with `ENGINE_RELEASE_LINE_UNDECLARED`; a store from another realm version with `ENGINE_RELEASE_LINE_MISMATCH` — by `createRealmMcpServer`, every published tool handler, the exported engine functions that take a store, and the two trace-buffer constructors that take a run reader, before any work. A program that builds the MCP server inside an `http` request handler must catch the refusal: a handler that throws ends the process. This was added after version 0.45.0.

## See also

- [Write a step handler](../guides/step-handlers.md)
- [Handlers](handlers.md), [Adapters](adapters.md), [Deployment manifest](deployment-manifest.md)
- [Deploy a project](../guides/deploy.md)
- [`realm run`: commands that read](cli/realm-run-reading.md) covers `inspect --check-drift`.
