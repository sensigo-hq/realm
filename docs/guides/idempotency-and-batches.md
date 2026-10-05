# Start runs safely

When a program starts runs, the same request can arrive twice: a retry after a timeout, a webhook delivered again, a script run a second time. This guide shows how to make sure one piece of work gets one run, how to start a fresh run on purpose, and how to start many runs at once.

## Before you start

You need a registered workflow and a way to call Realm's tools, such as an [MCP client](connect-an-mcp-client.md).

## Give each piece of work a key

Pass an `idempotency_key` to `start_run`. Choose a value that names the piece of work, such as an order number:

```json
{ "workflow_id": "sync", "params": {}, "idempotency_key": "order-4417" }
```

The first call starts a run:

```text
status: ok
deduped: false
run_id: 6c48086c-cb0f-47ea-9c33-6279fe42ffdc
```

A second call with the same key, for the same workflow, starts nothing. It returns the run that already exists:

```text
status: ok
deduped: true
run_id: 6c48086c-cb0f-47ea-9c33-6279fe42ffdc
Matched existing run '6c48086c-cb0f-47ea-9c33-6279fe42ffdc' (idempotent) in phase 'running'; no new run created. Ready for the agent: 'fetch'.
```

Notice `deduped: true` and the same `run_id`. The caller can carry on with that run as if it had started it: the reply also says what comes next for it, as the first one did (here, `sync`'s first step, `fetch`, is ready for the assistant).

A key belongs to one workflow. The same key under another workflow is a different key.

## Decide what a repeat means

What should happen on a repeat depends on whether the first run is still going. Two settings control it.

### While the first run is still open: `on_live_match`

| Value          | A repeat                                   |
| -------------- | ------------------------------------------ |
| `use_existing` | Returns the open run. This is the default. |
| `fail`         | Is refused.                                |

With `fail`:

```text
status: error
STATE_RUN_ALREADY_ACTIVE: Idempotency key for workflow 'sync' is owned by an active run '6c48086c-…' (phase 'running').
```

Use `fail` when a second caller must not join work that someone else is already doing.

### After the first run has ended: `on_terminal_match`

| Value             | A repeat                                                               |
| ----------------- | ---------------------------------------------------------------------- |
| `reuse`           | Returns the finished run. This is the default.                         |
| `reject`          | Is refused with `STATE_IDEMPOTENCY_KEY_USED`.                          |
| `rerun_if_failed` | Starts a new run if the first one failed; otherwise returns the first. |
| `rerun`           | Always starts a new run.                                               |

With `rerun` after a completed run, a new run starts and says which run it replaces:

```text
status: ok
deduped: false
run_id: 3fa445f0-6a22-424b-9a64-8a866925039a
rerun_of: 6c48086c-cb0f-47ea-9c33-6279fe42ffdc
This run supersedes run '6c48086c-…' under the same idempotency key (on_terminal_match).
```

The key now points at the new run. The old run stays in the store, and the new run's record links back to it:

```text
Rerun of: 6c48086c-cb0f-47ea-9c33-6279fe42ffdc
```

`rerun_if_failed` is the usual choice for work that should be tried again after a failure but never done twice. After a run that failed, it started a new one; after a run that completed, it returned the completed run.

## Start many runs at once

`start_run_batch` starts several runs of one workflow in one call. Give each item its parameters and, if you want, its own key:

```json
{
  "workflow_id": "sync",
  "items": [
    { "params": {}, "idempotency_key": "order-21" },
    { "params": {}, "idempotency_key": "order-22" },
    { "params": {}, "idempotency_key": "order-4417" }
  ]
}
```

The reply lists one entry per item. Items whose key already has a run are returned as `deduped`:

```text
order-21    run baf9ec57-…  deduped: false
order-22    run cdb126b5-…  deduped: false
order-4417  run 3fa445f0-…  deduped: true
```

The whole batch is checked before any run is created. If one item's parameters do not fit the workflow's `params_schema`, nothing starts:

```text
status: error
VALIDATION_BATCH_ITEMS: start_run_batch: 1 item(s) failed schema validation
One or more items failed schema validation. No runs were created.
```

`start_run_batch` takes the same `on_live_match` and `on_terminal_match` settings, applied to every item.

## Webhooks

`realm listen` does this for you. A workflow's `trigger` names where the event's ID is in the request, and a repeated delivery starts no second run. See [Start runs from webhooks](webhooks.md).

## Check the keys in a store

`realm run reconcile --dry-run` reports the keys in use, and the keys that have more than one run:

```text
Would write 0 pointer(s) across 4 key group(s); 4 already current.
Duplicate-key groups: 2
  - workflow 'sync' → canonical 3fa445f0-…; other runs: 6c48086c-…
```

A key with more than one run is normal after a `rerun`: the newest run is the one the key points at.

## See also

- [MCP tools reference](../reference/mcp/tools.md) covers `start_run` and `start_run_batch` in full.
- [Operate runs](operate-runs.md) covers what to do with runs that failed.
