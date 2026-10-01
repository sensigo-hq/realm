# Deploy a project

This guide takes workflows that run on your machine and makes them a project that can run on a server: settings in one file, secrets in another, your own code beside them, and a Realm server kept running. At the end you know what each file is for, what Realm reads when, and what to do after a change.

## Before you start

You need a workflow that calls a service or your own code. [Call a service with an adapter](call-a-service.md) and [Write a step handler](step-handlers.md) make them.

## How a project is laid out

A **project** is a folder that holds a `package.json` or a `.git` folder. Everything Realm needs for the workflows in it lives inside that folder:

```text
shop/
  package.json
  realm.yaml          settings for adapters, handlers and notifiers
  .env                the secret values
  handlers.mjs        your own code
  workflows/
    restock/workflow.yaml
    notify/workflow.yaml
```

When you register a workflow, Realm stores where its project is: the nearest folder above the workflow that holds `package.json` or `.git`. From then on, every run of that workflow reads `realm.yaml` from that folder, whichever folder the Realm process was started in.

## 1. Put the settings in `realm.yaml`

`realm.yaml` says how to build each adapter the workflows use. This one builds an adapter named `stock` for an HTTP API that needs a token:

```yaml
version: 1
adapters:
  stock:
    use: http
    config:
      base_url: https://stock.example.com
      auth: { type: bearer, token: '${secret:STOCK_API_TOKEN}' }
```

`use` names one of Realm's built-in adapters. `${secret:STOCK_API_TOKEN}` stands for a secret called `STOCK_API_TOKEN`. The value is not written here.

A workflow uses the adapter by its name:

```yaml
services:
  stock:
    adapter: stock
    trust: engine_delivered
```

## 2. Put the secrets in `.env`

Create `.env` beside `realm.yaml`, and keep it out of version control:

```text
STOCK_API_TOKEN=the-real-token
```

Realm reads this file itself. The values do not have to be in the environment of the process.

## 3. Check and register

```bash
realm workflow validate workflows/restock
realm workflow register workflows/restock
```

Each prints one line:

```text
Valid: restock v1 (1 step)
Registered: restock v1 (1 step)
```

`validate` does not need the secrets, so it can run in CI. If a secret is missing, it says so and carries on with placeholders:

```text
⚠ Deployment manifest secrets: 1 unresolved secret reference(s):
  adapters.stock.config.auth.token → ${secret:STOCK_API_TOKEN}
…
⚠ Validating with SENTINEL credentials — execution paths still require real secret resolution.
Valid: restock v1 (1 step)
```

`register` behaves the same way, so a workflow can be registered on a machine before its secrets are in place.

## 4. See a run refuse to start without its secret

Running is stricter. With `STOCK_API_TOKEN` missing from `.env`, starting a run is refused, and no run is created:

```text
status: error
Deployment manifest secrets: 1 unresolved secret reference(s):
  adapters.stock.config.auth.token → ${secret:STOCK_API_TOKEN}
Searched sources (in precedence order): dotenv (/srv/shop/.env).
Fix: add the missing name(s) to your dotenv file, or declare 'env' in secrets.sources and export them in the daemon's environment.
```

The message names the setting that needs the secret and the file Realm looked in. Put the value back, and the same call starts a run. The stock API receives the token:

```text
GET /levels?sku=A-100 auth=Bearer the-real-token
```

The token is not in the run's record. The record keeps the path of the `realm.yaml` that was used, a hash of that file, and the names of the secrets it referred to.

## Take secrets from the environment

If your server gives secrets to processes as environment variables, say so in `realm.yaml`:

```yaml
secrets:
  sources: [env]
```

`sources` lists where Realm looks, in order: `dotenv` for the `.env` file, `env` for the environment of the Realm process. Without the block, Realm looks in `.env` only. To use a file elsewhere, set `secrets.dotenv` to its path.

## Give your own code a secret

A handler that needs a secret is built from `realm.yaml` too. Export a function that receives the settings and returns the handler:

```javascript
// handlers.mjs
export function notifyBuyer({ id, config }) {
  return {
    id,
    async execute(inputs) {
      // config.api_key holds the real value here. Never return it.
      return { data: { sent_to: inputs.params.email, key_present: config.api_key.length > 0 } };
    },
  };
}
```

Name it in `realm.yaml`, with the file and the function separated by `#`:

```yaml
handlers:
  notify_buyer:
    use: ./handlers.mjs#notifyBuyer
    config: { api_key: '${secret:MAIL_API_KEY}' }
```

A step then uses `handler: notify_buyer`. Its record shows what the handler returned:

```text
Output: {"sent_to":"ana@example.com","key_present":true}
```

Whatever a handler returns is written to the record as it is. Do not return a secret.

Code must be inside the project. A workflow that points at a file outside it is refused when it is registered:

```text
Error loading extensions: Extension module '../../../outside/x.mjs' resolves to '/srv/outside/x.mjs', which is OUTSIDE the workflow's trust root '/srv/shop'. Extension modules must live within the project containing the workflow (nearest package.json/.git ancestor of the workflow directory). …
```

## Keep a server running

Which process you keep running depends on how runs start:

| Process        | Started by                               | Needs in its environment                                   |
| -------------- | ---------------------------------------- | ---------------------------------------------------------- |
| `realm mcp`    | The assistant's client, when it wants it | Nothing. It is not a service.                              |
| `realm serve`  | You                                      | `REALM_SERVE_TOKEN`                                        |
| `realm listen` | You                                      | The variable each webhook `trigger` names, and a model key |

Each of them keeps its runs under `~/.realm/` of the user it runs as. `realm mcp` and `realm serve` read the registered workflows from there as well, so register the workflows as that user.

On Linux with systemd, this unit keeps `realm serve` running and starts it again if it stops with an error:

```ini
[Unit]
Description=Realm MCP server
After=network.target

[Service]
EnvironmentFile=/srv/shop/realm-serve.env
Environment=PATH=/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/local/bin/realm serve --port 3001
Restart=on-failure

[Install]
WantedBy=default.target
```

In both lines, `/usr/local/bin` stands for the folder that `which realm` prints. A service does not get your shell's `PATH`, and `realm` has to find `node` there. `realm-serve.env` holds `REALM_SERVE_TOKEN=…` and should be readable only by that user.

Started this way, the server's log shows:

```text
Realm MCP server listening on http://127.0.0.1:3001/
Authentication: Bearer token (REALM_SERVE_TOKEN)
```

Stopped with `kill -9`, the server was started again by systemd and answered the next request.

`realm serve` accepts connections from the same machine only, unless you set `--host`. To reach it from elsewhere, put it behind a web server that provides HTTPS. See [Connect an MCP client](connect-an-mcp-client.md#connecting-over-http) and [Start runs from webhooks](webhooks.md#running-it-for-real).

## After a change

| You changed          | What to do                                                     |
| -------------------- | -------------------------------------------------------------- |
| A value in `.env`    | Nothing. The next run uses the new value.                      |
| `realm.yaml`         | Nothing. The next run uses the new settings.                   |
| Your own code        | Restart the server. A running server keeps the code it loaded. |
| A `workflow.yaml`    | Register it again.                                             |
| Where the project is | Register each workflow again from the new place.               |

To see whether the code or settings on disk still match what a run used, ask:

```bash
realm run inspect <run-id> --check-drift
```

After the handler file was edited while a server was still running the old code, a run from that server reported:

```text
Drift check (pure recompute of the last entry under its recorded rules):
  module /srv/shop/handlers.mjs: DIFFERS (recorded 95e24e2b…, current 2183f6a1…)
  manifest /srv/shop/realm.yaml: same
```

### If the project folder has moved

Realm looks for `realm.yaml` in the place it stored at registration. After the folder was moved, a run could not find its adapter. The step was blocked, and the run stayed open:

```text
Step 'check' is blocked: its adapter 'stock' is not registered in this runner. The run is NOT terminated — the step remains eligible, …
```

`realm workflow validate --registered restock` names the cause:

```text
1 check not run: project extensions (modules, manifest, config_schema) (trust_root /srv/shop no longer exists)
```

Registering the workflow again from the new place fixed it, and the blocked run then completed when its step was called again.

## Workflows that have no project

A workflow that an assistant makes with `create_workflow` was not registered from a folder, so it has no project. `--project <dir>` names the project whose `realm.yaml` applies to such workflows:

```bash
realm mcp --project /srv/shop
```

`realm serve`, `realm agent` and `realm workflow run` use the folder they were started in unless you give `--project`. `realm mcp` uses none unless you give it, because the assistant's client decides which folder `realm mcp` starts in, and a `realm.yaml` in a folder you did not choose should not be read.

## Who can change what

Anyone who can write to the project folder can change which service an adapter talks to, which secret it sends, and which code runs. Give write access to the project folder, and to `~/.realm/workflows/`, only to people you would let change the code.

## If you see something else

- **`Adapter 'stock' for service 'stock' is not registered. Declare this adapter under 'adapters:' in realm.yaml at your deployment root.`** Realm found no `realm.yaml` with that adapter in the workflow's project. Check that the file is in the project's top folder, and see [If the project folder has moved](#if-the-project-folder-has-moved).

- **`/usr/bin/env: ‘node’: No such file or directory` in the service's log.** The service's `PATH` does not include the folder that holds `node`. Add the `Environment=PATH=…` line shown in [Keep a server running](#keep-a-server-running).

## See also

- [`realm.yaml` reference](../reference/deployment-manifest.md) lists every key and every built-in adapter.
- [Project extensions reference](../reference/project-extensions.md)
- [Environment variables and files](../reference/environment-and-files.md)
- [Upgrade Realm](upgrade.md)
