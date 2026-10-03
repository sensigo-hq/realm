# Environment variables and files on disk

This page lists every environment variable Realm reads, and every file and folder it reads or writes: under `~/.realm`, and in a project. The variable list comes from a search of Realm's code for each place it reads the environment. The file list comes from the code and from the folders left by the runs made for these docs.

## Environment variables

Realm's own code reads 7 variables by name:

| Variable                     | Read by                                                                                                                          | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPENAI_API_KEY`             | `realm agent`                                                                                                                    | The key for OpenAI, and for a service given with `--base-url`. If set, OpenAI is the default provider.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `ANTHROPIC_API_KEY`          | `realm agent`                                                                                                                    | The key for Anthropic.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `REALM_SERVE_TOKEN`          | `realm serve`                                                                                                                    | The token a caller must send. Required unless the token check is off.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `REALM_DEV`                  | `realm serve`                                                                                                                    | Set to `1`, turns the token check off, as `--dev` does.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `REALM_NO_NUDGE`             | `realm workflow validate`                                                                                                        | Set to `1`, leaves out the `ℹ` line that says how many steps could use strict structured output.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `REALM_REQUIRE_WRITER_NONCE` | `realm mcp`, `realm serve`, `realm agent`, `realm workflow run`                                                                  | Set to anything but `0` or `false`, makes every agent step carry a `writer_nonce`. `execute_step` refuses an agent step without one. `realm agent` and `realm workflow run` make one for each attempt.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `REALM_OPERATOR`             | `realm agent`, `realm workflow run`, `realm mcp`, `realm serve`, the `realm-mcp` command, `realm run respond`, `realm run drain` | Whoever operates this program. It labels the steps the program takes: it is written as `holder` on each step's claim and as `driven_by` on the entry the step writes, with `by_source: ambient`. `realm run respond` and `realm run drain` write it only on the cleanup steps they run, never as the person who answered. Without it, the name is the OS user and host name, with `by_source: derived`. The name is written on the record, so it reaches `realm run inspect`, `get_run_state`, the reply to an answer (which a model reads) and export bundles. At most 200 characters, with no control characters. A value that breaks that prints one line and stops the command before it starts. Added after version 0.45.0. |
| `HOME`                       | Every command                                                                                                                    | The home folder. `~/.realm` is inside it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

Realm reads other variables by names that you give it:

| Named by                                                                                                | Read by                       | Used as                                                                        |
| ------------------------------------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------ |
| `secret_from` in a workflow's [`trigger`](workflow/webhook-trigger.md)                                  | `realm listen`                | The secret that webhook requests are checked against.                          |
| `${secret:NAME}` in `realm.yaml`, when `secrets.sources` has `env`                                      | Every command that runs steps | The secret's value. See [Deployment manifest](deployment-manifest.md#secrets). |
| `'${NAME}'` in the `env` of an agent profile's [tool server](workflow/services-profiles-and-context.md) | `realm agent`                 | A value handed to the tool server it starts.                                   |

`realm agent` also reads the values of the variables in its environment, so that it can replace them with `[REDACTED]` in tool results and error messages. It leaves some values alone: see [Give an agent step tools](../guides/agent-tools.md#4-read-what-was-recorded).

Three more are read by libraries that Realm uses, and change what Realm does:

| Variable             | Read by            | What it does                                                         |
| -------------------- | ------------------ | -------------------------------------------------------------------- |
| `OPENAI_BASE_URL`    | OpenAI's client    | Sends `realm agent`'s OpenAI requests to another address.            |
| `ANTHROPIC_BASE_URL` | Anthropic's client | Sends `realm agent`'s Anthropic requests to another address.         |
| `DOTENV_CONFIG_PATH` | The `.env` loader  | The file loaded in place of `.env` in the current folder. See below. |

### The `.env` file in the current folder

When any `realm` command starts, it loads a file named `.env` from the folder it is started in, and adds each line to its environment. A variable that is already set keeps its value. With `DOTENV_CONFIG_PATH` set, that file is loaded instead:

```bash
DOTENV_CONFIG_PATH=/etc/realm/serve.env realm serve
```

With `REALM_SERVE_TOKEN` only in that file, `realm serve` started. Without the variable, started in a folder with no `.env`, it stopped with `Error: REALM_SERVE_TOKEN is not set.`

This is separate from the `.env` beside `realm.yaml`, which holds a project's secrets and is read only for `${secret:NAME}`. In a project folder the two are the same file.

## Files under `~/.realm`

| Path                                          | Holds                                                                                                | Written by                                                                                      |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `workflows/<workflow-id>.json`                | A registered workflow.                                                                               | `realm workflow register`, `watch`, `realm agent --register`, `realm listen`, `create_workflow` |
| `runs/<run-id>.json`                          | A run's [record](run-record-and-export.md).                                                          | Every command and tool that changes a run                                                       |
| `runs/<run-id>.attempts.jsonl`                | The run's refused answers, one a line.                                                               | `execute_step`, `realm agent`                                                                   |
| `runs/trace-buffer-<run-id>-<step>.jsonl`     | Trace entries sent for a step that has not completed. `<step>` is the step's name in base64.         | `append_trace`                                                                                  |
| `runs/sealed-trace-<run-id>-<step>.<n>.jsonl` | Trace entries set aside when a step was taken over from another caller.                              | `execute_step`, `realm run reclaim`                                                             |
| `runs/keys/<hash>.json`                       | For one idempotency key: the run it belongs to. `<hash>` is made from the workflow's ID and the key. | `start_run`, `start_run_batch`, `realm listen`                                                  |
| `replays/rpl_<id>.json`                       | A saved replay.                                                                                      | `realm run replay --save`                                                                       |
| `dedup/<workflow-id>/<hour>/<hash>`           | One webhook event already seen. `<hour>` is the hour it arrived, as `YYYYMMDDHH`.                    | `realm listen` with `--dedup-store file`                                                        |

A key file looks like this:

```json
{
  "run_id": "cdb126b5-3386-4194-b43c-f14c88dd6bd0",
  "workflow_id": "sync",
  "key": "order-22",
  "params_hash": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
  "updated_at": "2026-10-01T21:34:14.118Z"
}
```

Two more kinds of entry exist only while a file is being written:

| Path                             | Is                                                                                |
| -------------------------------- | --------------------------------------------------------------------------------- |
| `runs/<file>.lock`               | A folder that marks the file as being written. It is removed when the write ends. |
| `runs/<file>.<pid>.<random>.tmp` | The new contents of a file, before it replaces the old one.                       |

A temp file left behind under `runs/` by a process that was killed is removed by [`realm run gc`](cli/realm-run-acting.md#gc). A `.lock` folder left behind is not removed by gc; the next write to that file takes it over once the folder is older than 10 seconds.

On version 0.45.0 the temp file's name has a counter where the random part is: `runs/<file>.<pid>.<n>.tmp`.

A workflow is registered the same way: while `workflows/<workflow-id>.json` is being written, `workflows/<workflow-id>.json.<pid>.<random>.tmp` holds the new contents. One left behind by a process that was killed is not removed by gc; delete it by hand when no `realm` command is running.

### Which commands remove files

| Command           | Removes                                                                      |
| ----------------- | ---------------------------------------------------------------------------- |
| `realm run purge` | An ended run's record, refused answers, trace files and key file.            |
| `realm run gc`    | Leftover `.tmp` files, and refused-answer and trace files whose run is gone. |

`realm listen` removes a `dedup` hour folder once it is older than the workflow's `ttl_minutes`. Nothing removes a registered workflow or a saved replay. Realm keeps runs until `realm run purge` removes them.

## Files in a project

Realm reads these, and writes none of them:

| File                                  | Holds                                                                            | See                                                                         |
| ------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `workflow.yaml`                       | A workflow. A workflow's folder is the folder this file is in.                   | [Workflow file: top-level fields](workflow/top-level-fields.md)             |
| `profiles/<name>.md`                  | An agent profile, beside the workflow file unless `profiles_dir` says otherwise. | [Services, profiles and context](workflow/services-profiles-and-context.md) |
| The files named by `extensions`       | The project's own code.                                                          | [Project extensions](project-extensions.md)                                 |
| The files named by `workflow_context` | Text given to agent steps.                                                       | [Services, profiles and context](workflow/services-profiles-and-context.md) |
| `fixtures/*.yaml`                     | Tests for the workflow.                                                          | [Test a workflow](../guides/test-a-workflow.md)                             |
| `realm.yaml`                          | The project's settings, in the project's top folder.                             | [Deployment manifest](deployment-manifest.md)                               |
| `.env`                                | The project's secrets, beside `realm.yaml`.                                      | [Deployment manifest](deployment-manifest.md#secrets)                       |
| `package.json` or `.git`              | Marks the project's top folder.                                                  | [Deployment manifest](deployment-manifest.md#where-realm-looks-for-it)      |

Realm writes into a project in two cases:

| Command                      | Writes                                                                                                                     |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `realm workflow init <name>` | A folder `<name>` with `workflow.yaml`, `schema.json`, `.env.example`, `README.md`, `registry.sample.js` and `realm.yaml`. |
| `realm run export <run-id>`  | `<run-id>.realm.json` in the current folder, or the file given with `--out`.                                               |

## A store other than files

The paths under `~/.realm/runs` are those of the file store, which every `realm` command uses. A program that calls Realm as a library can keep runs elsewhere. See [Core library](core-library.md).

## See also

- [Deployment manifest](deployment-manifest.md) covers `realm.yaml` and secrets.
- [`realm mcp` and `realm serve`](cli/realm-mcp-and-serve.md), [`realm agent`](cli/realm-agent.md), [`realm listen`](cli/realm-listen.md)
- [`realm run`: commands that act](cli/realm-run-acting.md) covers `purge` and `gc`.
- [Run record and export bundle format](run-record-and-export.md)
