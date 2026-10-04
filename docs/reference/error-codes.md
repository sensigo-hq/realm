# Error codes

Every error Realm raises on purpose has a code. This page lists all 86 codes that Realm defines: the 71 it raises, with when each is raised and what it tells the caller to do, and the 15 that nothing raises. The lists were made by a script that read the `ErrorCode` type and every place in Realm's code that raises one. The replies shown came from calls to a running server.

## Where a code appears

| Place                      | The code is in                                                           |
| -------------------------- | ------------------------------------------------------------------------ |
| A reply from an MCP tool   | `error_code`, beside `errors` and `agent_action`.                        |
| An error caught in code    | `code`, on a `WorkflowError`. See [Handlers](handlers.md#workflowerror). |
| A `realm` command's output | Not shown for most errors. The command prints the message.               |

```json
{
  "status": "error",
  "errors": ["Workflow not found: nope"],
  "error_code": "STATE_WORKFLOW_NOT_FOUND",
  "agent_action": "report_to_user"
}
```

`get_run_state` is an exception: its reply for a run that does not exist has the message and no `error_code`.

## What an error carries

A `WorkflowError` has these fields besides its message:

| Field         | Holds                                                                 |
| ------------- | --------------------------------------------------------------------- |
| `code`        | One of the codes on this page.                                        |
| `category`    | `NETWORK`, `SERVICE`, `STATE`, `VALIDATION`, `ENGINE` or `RESOURCE`.  |
| `agentAction` | What the caller should do. One of the 6 values below.                 |
| `retryable`   | Whether a step with a `retry` block is tried again after this error.  |
| `details`     | An object with more about the failure. `{}` if there is nothing more. |
| `retry_after` | For `SERVICE_RATE_LIMITED`, the seconds to wait.                      |

| `agentAction`          | Means                                                               |
| ---------------------- | ------------------------------------------------------------------- |
| `provide_input`        | Send the call again with a corrected answer or value.               |
| `resolve_precondition` | Something else has to happen first. Read the run's state, then act. |
| `wait_and_proceed`     | Wait, then try again.                                               |
| `wait_for_human`       | A person has to act before the run can go on.                       |
| `report_to_user`       | Tell the user. The caller cannot fix this itself.                   |
| `stop`                 | Stop working on this run.                                           |

### The `agent_action` in a reply

The `agent_action` in a tool's reply is the error's `agentAction`, changed in three cases:

| Case                                                                           | The reply's `agent_action`                                                  |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| The call failed before the run was read, for instance because the store failed | `provide_input` and `resolve_precondition` become `report_to_user`.         |
| A step started and failed, and the run has ended                               | `stop`, whatever the error said.                                            |
| A step started and failed, and the run is still open                           | `stop`, `provide_input` and `resolve_precondition` become `report_to_user`. |

An answer that the step's schema refuses is not one of these cases: the run is read and no step starts, so the reply keeps the error's `provide_input`. A handler that threw an error with `agentAction: 'report_to_user'` on a step that ended its run gave a reply with `agent_action: "stop"`.

## The codes Realm raises

The last two columns are what the error carries where it is raised. Where a code is raised in several places with different values, all are listed, and `retryable` is `Varies`.

### `NETWORK`

| Code                  | Raised when                                                                    | `agentAction`    | `retryable` |
| --------------------- | ------------------------------------------------------------------------------ | ---------------- | ----------- |
| `NETWORK_UNREACHABLE` | A built-in adapter could not send its request: the network call itself failed. | `wait_for_human` | Yes         |

### `SERVICE`

| Code                          | Raised when                                                                                                                                       | `agentAction`                        | `retryable` |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ----------- |
| `SERVICE_HTTP_4XX`            | A service replied with a 4xx status that has no code of its own.                                                                                  | `stop`                               | No          |
| `SERVICE_HTTP_5XX`            | A service replied with a 5xx status.                                                                                                              | `report_to_user`, `wait_for_human`   | Yes         |
| `SERVICE_RATE_LIMITED`        | A service replied 429. `retry_after` holds the seconds to wait. It is not retried when the wait is longer than the service's `max_retry_seconds`. | `report_to_user`, `wait_and_proceed` | Varies      |
| `SERVICE_AUTH_FAILED`         | A service refused the credentials.                                                                                                                | `stop`                               | No          |
| `SERVICE_NOT_FOUND`           | A service replied that the record asked for does not exist.                                                                                       | `provide_input`                      | No          |
| `SERVICE_RESPONSE_INVALID`    | A service's reply could not be read, or lacked a field the adapter needs.                                                                         | `report_to_user`                     | No          |
| `SERVICE_UNEXPECTED_REDIRECT` | The Gorgias adapter was redirected on a request that must not be redirected.                                                                      | `stop`                               | No          |

### `STATE`

| Code                         | Raised when                                                                                                                                 | `agentAction`                            | `retryable` |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ----------- |
| `STATE_BLOCKED`              | A gate answer was refused: the run is not at a gate, the gate ID is not the open one, or the gate was already answered with another choice. | `report_to_user`, `resolve_precondition` | No          |
| `STATE_RUN_NOT_FOUND`        | No run has that ID.                                                                                                                         | `report_to_user`                         | No          |
| `STATE_WORKFLOW_NOT_FOUND`   | No workflow with that ID is registered.                                                                                                     | `report_to_user`                         | No          |
| `STATE_WORKFLOW_UNREADABLE`  | The workflow is registered, and its stored copy or the registry folder cannot be read.                                                      | `stop`                                   | No          |
| `STATE_RUN_TERMINAL`         | The run has ended, and the call needs an open run.                                                                                          | `report_to_user`                         | No          |
| `STATE_SNAPSHOT_MISMATCH`    | The run was changed by another writer between the read and the write.                                                                       | `report_to_user`                         | Yes         |
| `STATE_RUN_BUSY`             | The run's lock is held by another writer, or the run changed state while a command held it.                                                 | `report_to_user`                         | Yes         |
| `STATE_TRANSITION_DENIED`    | `abandon`, `reclaim` or `resume` was refused for the state the run or the step is in.                                                       | `report_to_user`                         | Varies      |
| `STATE_RUN_RESURRECTED`      | Used inside `realm run gc`: a run it was about to clean up after exists again. It is counted, not reported as a failure.                    | `report_to_user`                         | No          |
| `STATE_LEGACY_FORMAT`        | A run or a registered workflow was written by an older version of Realm in a format that is no longer read.                                 | `report_to_user`                         | No          |
| `STATE_STEP_ALREADY_CLAIMED` | The step has already been started or settled.                                                                                               | `resolve_precondition`                   | No          |
| `STATE_STEP_NOT_ELIGIBLE`    | The step cannot run now, or a trace entry was sent for a step that is not open.                                                             | `report_to_user`, `resolve_precondition` | No          |
| `STATE_STEP_ALREADY_SETTLED` | A result arrived for a step that another attempt had already settled.                                                                       | `report_to_user`, `resolve_precondition` | No          |
| `STATE_CLAIM_LOST`           | The attempt's claim on the step was taken away before its result arrived. The result was not recorded.                                      | `resolve_precondition`                   | No          |
| `STATE_RUN_DIVERGED`         | An imported run conflicts with a stored one: another version of the same run, or an idempotency key owned by another open run.              | `report_to_user`                         | No          |
| `STATE_RUN_ALREADY_ACTIVE`   | The idempotency key matches an open run, and `on_live_match` is `fail`.                                                                     | `report_to_user`                         | No          |
| `STATE_IDEMPOTENCY_KEY_USED` | The idempotency key matches an ended run, and `on_terminal_match` is `reject`.                                                              | `report_to_user`                         | No          |
| `STATE_STEP_PENDING`         | Used inside the trace buffer: a step's entries cannot be sealed while the step is in progress.                                              | `report_to_user`                         | Yes         |
| `STATE_SEAL_UNSTAMPED`       | A store was asked to end a run without recording how it ended.                                                                              | `report_to_user`                         | No          |
| `STATE_SEAL_ORPHANED`        | A store was asked to reopen a run and keep the record of how it ended.                                                                      | `report_to_user`                         | No          |
| `STATE_SEAL_ERASED`          | A store was asked to rewrite an ended run without its record of how it ended.                                                               | `report_to_user`                         | No          |
| `STATE_SEAL_UNKNOWN_ARM`     | The record of how a run ended names an ending Realm does not know.                                                                          | `report_to_user`                         | No          |
| `STATE_SEAL_INCOHERENT`      | The record of how a run ended disagrees with the rest of the run's record.                                                                  | `report_to_user`                         | No          |
| `STATE_SEAL_REWRITTEN`       | A store was asked to change the record of how a run ended, without an operator's ruling.                                                    | `report_to_user`                         | No          |
| `STEP_NOT_FOUND`             | The workflow has no step with that name.                                                                                                    | `report_to_user`                         | No          |

### `VALIDATION`

| Code                         | Raised when                                                                                                                                                                                                                                                                                                                                                    | `agentAction`                     | `retryable` |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ----------- |
| `VALIDATION_INPUT_SCHEMA`    | An answer does not fit the step's `input_schema`, or the run's parameters do not fit `params_schema`. Also a value a command or the `filesystem` adapter refuses.                                                                                                                                                                                              | `provide_input`, `report_to_user` | No          |
| `VALIDATION_OUTPUT_SCHEMA`   | A step's output does not fit its `output_schema`.                                                                                                                                                                                                                                                                                                              | `provide_input`                   | No          |
| `VALIDATION_TRACE_SCHEMA`    | A step's trace does not fit its `trace_schema`.                                                                                                                                                                                                                                                                                                                | `provide_input`                   | No          |
| `VALIDATION_EXHAUSTED`       | A step's answers were refused as many times as its limit allows. The step fails.                                                                                                                                                                                                                                                                               | `stop`                            | No          |
| `VALIDATION_WORKFLOW_SCHEMA` | A workflow file is refused by the loader, or a `realm.yaml` is in the wrong folder.                                                                                                                                                                                                                                                                            | `report_to_user`, `stop`          | No          |
| `VALIDATION_EMPTY_VALUE`     | A required value is missing or empty: a file path, or a `writer_nonce`.                                                                                                                                                                                                                                                                                        | `provide_input`                   | No          |
| `VALIDATION_BATCH_TOO_LARGE` | `start_run_batch` was given more items than its limit. Under `realm agent`: a step's model asked to start more runs than `max_fan_out`.                                                                                                                                                                                                                        | `provide_input`                   | No          |
| `VALIDATION_BATCH_ITEMS`     | One or more items of `start_run_batch` do not fit `params_schema`. No run was created.                                                                                                                                                                                                                                                                         | `provide_input`                   | No          |
| `VALIDATION_TRUST_VALUE`     | A step of a stored workflow has a `trust` value Realm does not know.                                                                                                                                                                                                                                                                                           | `report_to_user`                  | No          |
| `VALIDATION_ACTOR_INVALID`   | A name given as a program's name or as an answerer cannot be used: `--by`, `responded_by` or a `driver` passed to the engine is empty or blank, or any of these or `REALM_OPERATOR` is longer than 200 characters or has a control character. An empty or blank `REALM_OPERATOR` counts as unset. Nothing was started or recorded. Added after version 0.45.0. | `report_to_user`                  | No          |

### `ENGINE`

| Code                             | Raised when                                                                                                                                                                                              | `agentAction`                     | `retryable` |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ----------- |
| `ENGINE_INTERNAL`                | An error Realm did not expect, or a call that breaks an internal rule.                                                                                                                                   | `stop`                            | No          |
| `ENGINE_STORE_FAILED`            | The store failed while a step was being run.                                                                                                                                                             | `stop`                            | Varies      |
| `ENGINE_ARTIFACT_DELETE_FAILED`  | A store could not delete a run's files. `details.failures` lists each one.                                                                                                                               | `report_to_user`                  | Varies      |
| `ENGINE_ADAPTER_FAILED`          | An adapter threw an ordinary error, or was asked for an operation it does not have.                                                                                                                      | `report_to_user`, `stop`          | No          |
| `ENGINE_ADAPTER_NOT_REGISTERED`  | A step's adapter is not registered. The step is blocked, and the run stays open.                                                                                                                         | `stop`                            | No          |
| `ENGINE_PROCESSOR_FAILED`        | A processor failed or is missing. No command reaches the code that raises it.                                                                                                                            | `stop`                            | No          |
| `ENGINE_HANDLER_FAILED`          | A handler threw an ordinary error.                                                                                                                                                                       | `report_to_user`, `stop`          | No          |
| `ENGINE_HANDLER_NOT_REGISTERED`  | A step's handler is not registered. The step is blocked, and the run stays open.                                                                                                                         | `stop`                            | No          |
| `ENGINE_STEP_FAILED`             | Under `realm agent`: the model used every tool call it was allowed, and its final answer could not be read.                                                                                              | `stop`                            | No          |
| `ENGINE_RELEASE_LINE_MISMATCH`   | An object from another realm version: a store or registry a host handed realm, or a `WorkflowError` a handler, adapter or dispatcher threw. Names both versions and folders. Added after version 0.45.0. | `stop`                            | No          |
| `ENGINE_RELEASE_LINE_UNDECLARED` | A store a host handed realm declares no realm release line (`declareReleaseLine`). Added after version 0.45.0.                                                                                           | `stop`                            | No          |
| `GATE_MESSAGE_UNRESOLVABLE`      | A gate's `message` refers to a value that does not exist.                                                                                                                                                | `stop`                            | No          |
| `FILTER_UNKNOWN`                 | A gate's `message` uses a template filter Realm does not have.                                                                                                                                           | `stop`                            | No          |
| `ADAPTER_OP_UNSUPPORTED`         | An adapter does not have the operation, or the `service_method`, the step asked for.                                                                                                                     | `report_to_user`                  | No          |
| `ADAPTER_VALIDATION_FAILED`      | A parameter given to a built-in adapter is missing or has the wrong type.                                                                                                                                | `provide_input`, `report_to_user` | No          |
| `ADAPTER_REQUEST_FAILED`         | The Slack adapter's request failed.                                                                                                                                                                      | `report_to_user`                  | No          |
| `STEP_TIMEOUT`                   | The step ran longer than its `timeout_seconds`.                                                                                                                                                          | `report_to_user`                  | No          |
| `STEP_ABORTED`                   | An adapter's request was cancelled because the step's time limit passed.                                                                                                                                 | `report_to_user`                  | No          |
| `STEP_RETRY_EXHAUSTED`           | The step failed on every attempt its `retry` block allows. `details.lastError` holds the last message.                                                                                                   | `report_to_user`                  | No          |
| `INPUT_MAP_DEPTH_EXCEEDED`       | An `input_map` path is nested deeper than Realm follows.                                                                                                                                                 | `report_to_user`                  | No          |
| `INPUT_MAP_UNKNOWN_DIRECTIVE`    | An `input_map` of a stored workflow has a key that starts with `$` and is not a directive.                                                                                                               | `report_to_user`                  | No          |
| `BUFFER_FULL`                    | A step's trace buffer has reached its limit of entries or bytes.                                                                                                                                         | `provide_input`                   | No          |
| `TRACE_CAPABILITY_INCONSISTENT`  | A trace buffer store says it can do something and lacks the functions for it.                                                                                                                            | `stop`                            | No          |
| `MCP_CONNECTION_FAILED`          | Under `realm agent`: a tool server named by an agent step could not be started or reached.                                                                                                               | `stop`                            | No          |
| `MCP_TOOL_NOT_FOUND`             | Under `realm agent`: a step names a tool its tool servers do not have.                                                                                                                                   | `stop`                            | No          |
| `MCP_TOOL_NAME_COLLISION`        | Under `realm agent`: two tool servers of one step give a tool the same name.                                                                                                                             | `stop`                            | No          |

### `RESOURCE`

| Code                      | Raised when                                                                                  | `agentAction`                     | `retryable` |
| ------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------- | ----------- |
| `RESOURCE_FETCH_FAILED`   | A file could not be read: a workflow file, or a file asked of the `filesystem` adapter.      | `provide_input`, `report_to_user` | No          |
| `RESOURCE_FORMAT_INVALID` | A workflow file is not valid YAML, or a registered workflow's stored copy is not valid JSON. | `report_to_user`, `stop`          | No          |

`BUFFER_FULL`, `TRACE_CAPABILITY_INCONSISTENT` and the three `MCP_` codes are raised with the category `ENGINE`. `STEP_NOT_FOUND` is raised with `STATE` by one caller and `ENGINE` by another.

## The codes nothing raises

These 15 are in the `ErrorCode` type, and no code in Realm raises them:

```text
NETWORK_TIMEOUT, NETWORK_DNS_FAILED, NETWORK_CONNECTION_RESET, STATE_PRECONDITION_FAILED,
STATE_RUN_LOCKED, RUN_ABORTING, VALIDATION_HASH_MISMATCH, VALIDATION_QUOTE_NOT_FOUND,
VALIDATION_FIELD_UNKNOWN, VALIDATION_FIELD_EXCLUDED, STEP_HANDLER_ERROR, ENGINE_GATE_OPEN_FAILED,
GUARD_RESOLUTION_ERROR, RESOURCE_TOO_LARGE, RESOURCE_NOT_ACCESSIBLE
```

A handler or an adapter of your own may raise any code in the type, these included.

## See also

- [MCP tools](mcp/tools.md) covers the other fields of a reply.
- [Handlers](handlers.md#what-a-thrown-error-does) covers what a thrown error does to a step.
- [Retry and timeouts](workflow/retry-and-timeouts.md#which-errors-are-retried)
- [Adapters](adapters.md) lists the codes each built-in adapter raises.
