# Deployment manifest (`realm.yaml`)

`realm.yaml` holds a project's settings: how each adapter, handler and processor is built, where secrets come from, and how gates are posted to Slack. This page lists its 6 top-level keys, the rules for each, where Realm looks for the file, and what a run records about it. Every message shown came from a run of `realm` against a project at `/srv/shop`.

For a walk through a first `realm.yaml`, see [Deploy a project](../guides/deploy.md).

## Where Realm looks for it

Realm reads one file: `realm.yaml` in the top folder of the workflow's project. The project is the nearest folder, at or above the workflow's folder, that holds a `package.json` or a `.git`. If no folder above has either, the workflow's own folder is the project.

| The file is                                                | What happens                                                                |
| ---------------------------------------------------------- | --------------------------------------------------------------------------- |
| In the project's top folder                                | It is read.                                                                 |
| Absent                                                     | Nothing is built from settings. Only the `filesystem` adapter is available. |
| Between the workflow's folder and the project's top folder | The workflow is refused, with the message below.                            |
| Above the project's top folder                             | It is not read, and nothing says so.                                        |
| Named `realm.yml`                                          | It is not read, and nothing says so.                                        |

```text
Error loading extensions: Deployment manifest at '/srv/shop/w/realm.yaml' will NOT be loaded — manifests are read only from the deployment root '/srv/shop/realm.yaml'. Move it to '/srv/shop/realm.yaml' (the nearest package.json/.git ancestor of the workflow), or add a package.json/.git at '/srv/shop/w' to make that the deployment root.
```

Realm records the project's folder when a workflow is registered, and reads `realm.yaml` from that folder for every run of the workflow. A workflow that was not registered from a folder has no project. For those, `--project <dir>` on `realm mcp`, `realm serve` and `realm agent` names the project to use. See [Deploy a project](../guides/deploy.md#workflows-that-have-no-project).

## The file

```yaml
version: 1

secrets:
  sources: [dotenv]
  dotenv: config/prod.env

adapters:
  stock:
    use: http
    config:
      base_url: https://stock.example.com
      auth: { type: bearer, token: '${secret:STOCK_API_TOKEN}' }

handlers:
  order_total:
    use: ./handlers.mjs#makeTotal
    config:
      unit_price: 12.5

processors: {}

notifiers:
  slack_gate:
    type: slack
    config:
      bot_token: '${secret:SLACK_BOT_TOKEN}'
      channel_id: '${secret:SLACK_CHANNEL_ID}'
      app_token: '${secret:SLACK_APP_TOKEN}'
```

| Key          | Required | Holds                                                   |
| ------------ | -------- | ------------------------------------------------------- |
| `version`    | Yes      | `1`.                                                    |
| `secrets`    | No       | Where secret values come from.                          |
| `adapters`   | No       | The adapters to build, by name.                         |
| `handlers`   | No       | The handlers to build, by name.                         |
| `processors` | No       | The processors to build, by name.                       |
| `notifiers`  | No       | One notifier, `slack_gate`, which posts gates to Slack. |

Any other key is refused, at every level except inside a `config` block:

```text
Error loading extensions: Deployment manifest '/srv/shop/realm.yaml' is invalid:
  manifest: unknown key 'adapter'
```

A section may be empty or left out. A file that is empty, has no `version`, or has another `version` is refused:

| The file         | Message                                                                               |
| ---------------- | ------------------------------------------------------------------------------------- |
| Is empty         | `manifest: must be object`                                                            |
| Has no `version` | `manifest: must have required property 'version'`                                     |
| Has `version: 2` | `manifest/version: must be equal to constant`                                         |
| Is not YAML      | `Deployment manifest '/srv/shop/realm.yaml' is not valid YAML: …`, with the position. |

## `adapters`, `handlers`, `processors`

Each of the three is a map from a name to an entry. The name is the one a workflow uses: `adapter: stock` in a service, `handler: order_total` on a step. An entry has 2 keys:

| Key      | Required | Holds                                                                                         |
| -------- | -------- | --------------------------------------------------------------------------------------------- |
| `use`    | Yes      | What builds the thing: the name of a built-in adapter, or a code file and one of its exports. |
| `config` | No       | Settings handed to what `use` names. Any shape. Secret references are allowed in its strings. |

### `use` with a built-in adapter

For an adapter, `use` may be one of 10 names: `github`, `slack`, `http`, `airtable`, `gorgias`, `shopify`, `notion`, `parcelpanel`, `filesystem`, `mock`. The settings each one takes are in [Adapters](adapters.md). There are no built-in handlers or processors.

### `use` with a code file

A value that contains a `/`, or ends in `.js`, `.mjs`, `.cjs`, `.ts`, `.mts` or `.cts`, names a code file. The path is taken from the folder of `realm.yaml`. After `#` comes the name of an export. Without `#`, the default export is used.

```yaml
handlers:
  order_total:
    use: ./handlers.mjs#makeTotal
    config:
      unit_price: 12.5
```

The export is a function. Realm calls it once, with the entry's name as `id` and the entry's `config` with its secrets filled in, and uses what it returns:

```js
export function makeTotal({ id, config }) {
  return {
    id,
    async execute(inputs) {
      return { data: { total: 4 * config.unit_price } };
    },
  };
}
```

A handler must have an `execute` function, an adapter the functions listed in [Project extensions](project-extensions.md), and a processor a `process` function.

Realm registers a processor under its name. No workflow field uses one.

### Refusals

| The entry                                             | Message                                                                                                                                                                                                                                                 |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Has no `use`                                          | `handlers.show needs 'use:' — a catalog name (adapters) or a module reference './path.js#Export'.`                                                                                                                                                      |
| Has a key other than `use` and `config`               | `manifest/handlers/show: unknown key 'uses'`                                                                                                                                                                                                            |
| Is a handler or processor with a built-in name        | `handlers.show — there is no built-in catalog for handlers; use a module reference './path.js#ExportName'.`                                                                                                                                             |
| Is an adapter with an unknown name                    | `adapters.crm — unknown catalog adapter 'salesforce'. Valid catalog names (realm v0.45.0): github, slack, http, airtable, gorgias, shopify, notion, parcelpanel, filesystem, mock. For a custom adapter use a module reference './path.js#ExportName'.` |
| Gives `config` to `filesystem` or `mock`              | `adapters.files — catalog adapter 'filesystem' takes no config; remove the 'config:' block.`                                                                                                                                                            |
| Names a file that is not there                        | `Cannot resolve manifest module './nope.mjs' (from '/srv/shop/realm.yaml', resolved: /srv/shop/nope.mjs): ENOENT: no such file or directory, lstat '/srv/shop/nope.mjs'`                                                                                |
| Names a file outside the project                      | `Deployment manifest module '../outside.mjs' resolves to '/srv/outside.mjs', which is OUTSIDE the deployment root '/srv/shop'. Manifest 'use:' modules must live within the deployment root — …`                                                        |
| Names an export the file does not have                | `handlers.show — module './handlers.mjs#makeNothing' has no export 'makeNothing'. Available exports: default, makeShow, makeStrict, notAFunction.`                                                                                                      |
| Names an export that is not a function                | `handlers.show — './handlers.mjs#notAFunction' must export a FACTORY (ctx: { id, config }) => instance; got object.`                                                                                                                                    |
| Builds a thing without the function its kind needs    | `Extension processor 'clean' in '/srv/shop/realm.yaml#processors.clean': missing callable 'process' — processors must implement 'process' per the @sensigo/realm Processor interface.`                                                                  |
| Has a name that a workflow's code file also registers | `Extension handler 'order_total' is declared by both '../reg.mjs' and the deployment manifest '/srv/shop/realm.yaml' — manifest entries and code-module exports share one namespace; names must be unique.`                                             |
| Is built by a function that throws                    | `constructing handlers.show (use: ./handlers.mjs#makeStrict) failed: bad token [redacted]`                                                                                                                                                              |

Each message follows `Error loading extensions: Deployment manifest '/srv/shop/realm.yaml':` or stands on its own after `Error loading extensions:`.

An adapter entry named `filesystem` replaces the built-in one, with a notice:

```text
[realm] manifest adapter 'filesystem' overrides the built-in adapter 'filesystem'.
```

## Secret references

A string inside a `config` block may hold `${secret:NAME}`. `NAME` is made of capital letters, digits and `_`. When Realm builds the entry, it replaces the reference with the secret's value.

With `SHOP_TOKEN=tok_from_dotenv` in `.env`:

| In `config`                              | The function received                    |
| ---------------------------------------- | ---------------------------------------- |
| `token: ${secret:SHOP_TOKEN}`            | `"token": "tok_from_dotenv"`             |
| `header: "Bearer ${secret:SHOP_TOKEN}"`  | `"header": "Bearer tok_from_dotenv"`     |
| `list: ["${secret:SHOP_TOKEN}", 7]`      | `"list": ["tok_from_dotenv", 7]`         |
| `price: "$$5 and $${secret:SHOP_TOKEN}"` | `"price": "$5 and ${secret:SHOP_TOKEN}"` |

`$$` gives one `$`, so `$${secret:NAME}` is kept as text.

A reference is allowed only in a string under `config`: in an adapter, handler or processor entry, or in `notifiers.slack_gate.config`.

| The reference               | Message                                                                                                                           |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Is in `use`                 | `handlers.show.use: '${secret:FILE}' is not allowed here — secret references are legal only inside string values under 'config'.` |
| Is in `secrets.dotenv`      | `secrets.dotenv: '${secret:WHERE}' is not allowed here — secret references are legal only inside string values under 'config'.`   |
| Has a name in small letters | `handlers.show.config.a: malformed secret reference '${secret:lower}' — the form is ${secret:NAME} with NAME = [A-Z0-9_]+.`       |
| Is not closed               | `handlers.show.config.b: malformed secret reference '${secret:OPEN' — the form is ${secret:NAME} with NAME = [A-Z0-9_]+.`         |

## `secrets`

| Key       | Default    | Holds                                                                               |
| --------- | ---------- | ----------------------------------------------------------------------------------- |
| `sources` | `[dotenv]` | Where Realm looks for a secret's value, in order. Each is `dotenv` or `env`.        |
| `dotenv`  | `.env`     | The file read for `dotenv`. A path from the folder of `realm.yaml`, or a full path. |

| Source   | Realm looks in                                 |
| -------- | ---------------------------------------------- |
| `dotenv` | The file, which holds one `NAME=value` a line. |
| `env`    | The environment of the Realm process.          |

The first source that has the name gives the value. With `SHOP_TOKEN=tok_from_dotenv` in `.env`:

| `sources`       | `SHOP_TOKEN` in the environment | Value used        |
| --------------- | ------------------------------- | ----------------- |
| Not set         | `tok_from_env`                  | `tok_from_dotenv` |
| `[env, dotenv]` | `tok_from_env`                  | `tok_from_env`    |
| `[env, dotenv]` | Not set                         | `tok_from_dotenv` |

The `realm` command also loads a file named `.env` in the folder it is started in into its own environment, without replacing variables that are already set. So with `sources: [env]`, a secret in that file is found when `realm` is started in the project's folder, and is not found when it is started elsewhere.

| Case                                      | Message                                                                                                                                                             |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sources` is empty                        | `manifest/secrets/sources: must NOT have fewer than 1 items`                                                                                                        |
| `sources` has another word                | `manifest/secrets/sources/0: must be equal to one of the allowed values`                                                                                            |
| The file named by `dotenv` cannot be read | `Deployment manifest secrets: declared dotenv file '/srv/shop/config/prod.env' cannot be read: ENOENT: no such file or directory, open '/srv/shop/config/prod.env'` |

Without a `dotenv` key, a missing `.env` is not an error: it is a source with nothing in it.

### A secret that is not found

A command that runs steps refuses to start:

```text
Error loading extensions: Deployment manifest secrets: 1 unresolved secret reference(s):
  handlers.show.config.token → ${secret:SHOP_TOKEN}
  handlers.show.config.header → ${secret:SHOP_TOKEN}
  handlers.show.config.nested.list[0] → ${secret:SHOP_TOKEN}
Searched sources (in precedence order): dotenv (/srv/shop/.env).
Fix: add the missing name(s) to your dotenv file, or declare 'env' in secrets.sources and export them in the daemon's environment.
```

`realm workflow validate`, `realm workflow register` and `realm workflow watch` print the same text as a warning, add one line, and go on with a stand-in value, `<sentinel:NAME>`, for each secret:

```text
⚠ Validating with SENTINEL credentials — execution paths still require real secret resolution.
Valid: show v1 (1 step)
```

`register` prints `Registering` in place of `Validating`. If a function refuses the stand-in value, its entry is skipped, with a warning:

```text
⚠ Deployment manifest '/srv/shop/realm.yaml': constructing handlers.show (use: ./handlers.mjs#makeStrict) failed: bad token [redacted] (sentinel mode — entry skipped)
```

`realm workflow test` always uses stand-in values and never reads the sources.

### Secret values in messages

When a function that builds an entry throws, Realm replaces every secret value of 4 or more characters in the message with `[redacted]`. With `SHOP_TOKEN=secret-value-123` and a function that throws `bad token ${config.token}`:

```text
Error loading extensions: Deployment manifest '/srv/shop/realm.yaml': constructing handlers.show (use: ./handlers.mjs#makeStrict) failed: bad token [redacted]
```

## `notifiers`

`notifiers` has one key, `slack_gate`. It needs `type: slack` and a `config` block with any of 8 keys:

| Key                       | Type    | Holds                                                                         |
| ------------------------- | ------- | ----------------------------------------------------------------------------- |
| `webhook_url`             | String  | A Slack incoming-webhook address. Realm posts each gate to it.                |
| `bot_token`               | String  | The Slack app's bot token. Realm posts each gate with it.                     |
| `channel_id`              | String  | The channel the bot posts to.                                                 |
| `app_token`               | String  | The app-level token. With it, Realm reads replies over Socket Mode.           |
| `signing_secret`          | String  | The app's signing secret. With it, Realm reads replies sent to `events_port`. |
| `events_port`             | Integer | 1 to 65535. The port Realm listens on for Slack's requests.                   |
| `reminder_interval_ms`    | Integer | 1 or more. How long before a reminder is posted. The default is 600000.       |
| `escalation_threshold_ms` | Integer | 1 or more. How long before an escalation is posted. The default is 1800000.   |

`realm agent` uses these settings. See [Answer gates from Slack](../guides/slack-gates.md).

| The block                                 | Message                                                                                                                                                         |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Has `app_token` and no `bot_token`        | `notifiers.slack_gate: 'app_token' (Socket Mode) requires 'bot_token' — Socket Mode replies are posted via the bot token.`                                      |
| Has `signing_secret` and no `events_port` | `notifiers.slack_gate: 'signing_secret' (Events API) requires 'events_port' — the events listener needs a port to bind.`                                        |
| Has `events_port` and no `signing_secret` | `notifiers.slack_gate: 'events_port' requires 'signing_secret' — an events listener without request verification is not allowed.`                               |
| Has both `app_token` and `signing_secret` | `notifiers.slack_gate: 'app_token' and 'signing_secret' are mutually exclusive — Socket Mode and the Events API are alternative reply channels; configure one.` |
| Has another key                           | `manifest/notifiers/slack_gate/config: unknown key 'channel'`                                                                                                   |
| Has a `type` other than `slack`           | `manifest/notifiers/slack_gate/type: must be equal to constant`                                                                                                 |
| Sits beside another notifier              | `manifest/notifiers: unknown key 'email_gate'`                                                                                                                  |
| Has `events_port` as a string             | `manifest/notifiers/slack_gate/config/events_port: must be integer`                                                                                             |

A block with `bot_token` and no `channel_id`, and a block with an empty `config`, are accepted.

## When changes take effect

Realm reads `realm.yaml` and the `dotenv` file each time a run starts. In one `realm mcp` process, with 3 runs of one workflow:

| Before the run                             | The handler's `config`                  |
| ------------------------------------------ | --------------------------------------- |
| Nothing                                    | `{"token":"tok_first"}`                 |
| `.env` changed to `SHOP_TOKEN=tok_rotated` | `{"token":"tok_rotated"}`               |
| `region: eu` added to the entry's `config` | `{"token":"tok_rotated","region":"eu"}` |

| You changed                                                                               | Reaches the next run of a running process                   |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `realm.yaml`                                                                              | Yes.                                                        |
| The `dotenv` file, given as a path from the folder of `realm.yaml`, or the default `.env` | Yes.                                                        |
| The `dotenv` file, given as a full path                                                   | No, until `realm.yaml` changes or the process is restarted. |
| A variable read through `env`                                                             | No. Restart the process.                                    |
| A code file named by `use`                                                                | No. Restart the process.                                    |

The full-path case was run: after `/var/abs.env` changed, the next run still received `tok_first`.

## What a run records

Each run records the path of the `realm.yaml` it used, a hash of the file's bytes, and the names of the secrets it referred to. Values are not recorded.

```json
{
  "manifest": {
    "path": "/srv/shop/realm.yaml",
    "content_hash": "39c37842415cda1977237058afd640076a8b8186acbc76245f5424957c1d7529"
  },
  "secret_names": ["OTHER_KEY", "SHOP_TOKEN"]
}
```

These are in the run's record under `extension_identity`, and in its export. `realm run inspect` does not print them. `realm run inspect <run-id> --check-drift` compares the hash with the file on disk:

| Changed since the run      | `--check-drift` prints                                                           |
| -------------------------- | -------------------------------------------------------------------------------- |
| Nothing                    | `manifest /srv/shop/realm.yaml: same`                                            |
| A value in `.env`          | `manifest /srv/shop/realm.yaml: same`                                            |
| `realm.yaml`               | `manifest /srv/shop/realm.yaml: DIFFERS (recorded 39c37842…, current c1e68fc2…)` |
| A code file named by `use` | `module /srv/shop/handlers.mjs: DIFFERS (recorded 1bce8906…, current 7c022774…)` |

The hashes are printed in full. A changed secret value is not drift. A changed reference is, because the reference is in the file.

## Who can change what

`realm.yaml` decides which address each adapter calls, which secret it sends, and which code is loaded. Write access to a project's folder is therefore the same as write access to its code. A webhook request or an assistant's tool call cannot change which `realm.yaml` is read: the folder comes from the registration or from `--project`.

## See also

- [Deploy a project](../guides/deploy.md)
- [Adapters](adapters.md) lists the settings of each built-in adapter.
- [Handlers](handlers.md) and [Project extensions](project-extensions.md)
- [Answer gates from Slack](../guides/slack-gates.md)
- [`realm mcp` and `realm serve`](cli/realm-mcp-and-serve.md) covers `--project`.
