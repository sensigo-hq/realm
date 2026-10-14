# Webhook trigger

<!-- description: Reference for the trigger block that lets an HTTP request start a run: every key, the ways a request can be checked, and the reply to each kind. -->

The `trigger` block of `workflow.yaml` lets an HTTP request start a run. `realm listen` reads it. This page lists every key of the block, the five ways a request can be checked, and the reply for each kind of request. Every reply shown came from a running `realm listen`.

For a walk through one webhook, see [Start runs from webhooks](../../guides/webhooks.md).

## The block

```yaml
trigger:
  type: webhook
  path: /shared
  auth:
    mode: shared_secret
    header: X-Webhook-Token
    secret_from: WH_SECRET
  filter:
    all:
      - { path: body.type, value: [ticket-created, ticket-updated] }
      - { header: x-source, value: helpdesk }
  dedup:
    id_from: body.event_id
    ttl_minutes: 5
    on_missing_id: reject
  params_map:
    ticket_id: body.id
    source: headers.x-source
```

| Key                         | Type            | Required | What it holds                                           |
| --------------------------- | --------------- | -------- | ------------------------------------------------------- |
| `type`                      | `webhook`       | Yes      | The only kind of trigger.                               |
| [`path`](#path)             | text            | No       | The address the workflow answers on.                    |
| [`auth`](#auth)             | map             | Yes      | How a request proves it is genuine.                     |
| [`filter`](#filter)         | map             | No       | Which requests start a run.                             |
| [`dedup`](#dedup)           | map, or `false` | No       | How a repeated delivery is recognised.                  |
| [`params_map`](#params_map) | map             | No       | Which parts of the request become the run's parameters. |

No other key is allowed: `Invalid workflow: trigger: unknown property 'retries'`.

In `filter`, `dedup` and `params_map`, a value in the request is named by a path that starts with `body.` or `headers.`: `body.id` is the `id` field of the JSON body, and `headers.x-source` is the `X-Source` header. Header names are written in lower case.

## `path`

The address, written with a leading `/`. Without it, the address is `/` followed by the workflow's `id`. Two workflows given to one `realm listen` must not share an address:

```text
Error: listen: path collision on '/open' — workflow 'dup' conflicts with 'open'
```

## `auth`

`auth.mode` says how a request is checked. Each mode has its own keys, and a key of another mode is refused: `trigger/auth: unknown property 'algorithm'`.

| `mode`          | The request must carry                                           | Other keys                                                                                         |
| --------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `shared_secret` | The secret itself, in the header named by `header`.              | `header`, `secret_from` (both required)                                                            |
| `github`        | `X-Hub-Signature-256: sha256=<signature>`, as GitHub sends it.   | `secret_from` (required)                                                                           |
| `stripe`        | `Stripe-Signature: t=<time>,v1=<signature>`, as Stripe sends it. | `secret_from` (required), `max_age_seconds`                                                        |
| `hmac`          | A signature of the body in the header named by `header`.         | `secret_from`, `header` (required), `algorithm`, `encoding`, `timestamp_header`, `max_age_seconds` |
| `none`          | Nothing. The request is not checked.                             | None                                                                                               |

`secret_from` is the name of an environment variable that holds the secret. It is read when `realm listen` starts, and a variable that is not set stops it:

```text
Error: listen: workflow 'shared' references secret env var 'WH_SECRET' which is not set
```

A signature is an HMAC of the request body, computed with the secret:

| Mode     | Signed text                    | Algorithm                                           | Written as                              |
| -------- | ------------------------------ | --------------------------------------------------- | --------------------------------------- |
| `github` | The body                       | SHA-256                                             | Hexadecimal                             |
| `stripe` | The time, a dot, then the body | SHA-256                                             | Hexadecimal                             |
| `hmac`   | The body                       | `algorithm`: `sha1`, `sha256` (default) or `sha512` | `encoding`: `hex` (default) or `base64` |

`max_age_seconds` refuses a request whose time is older than that many seconds. In `stripe` mode the time is the `t=` value. In `hmac` mode it is the header named by `timestamp_header`, in seconds; once `timestamp_header` is set, a request without that header is refused.

With `mode: none`, `realm listen` warns when it starts:

```text
listen: workflow 'open' uses auth.mode 'none' — webhook verification is DISABLED for path '/open'. Use only on a trusted network.
```

## `filter`

`filter` holds up to 8 conditions under `all`. A request starts a run only if every condition holds. A single condition can be written without `all`:

```yaml
filter: { path: body.type, value: order-paid }
```

Each condition has `value`, and exactly one of:

| Key      | Compares                                            |
| -------- | --------------------------------------------------- |
| `path`   | The value found at a path such as `body.type`.      |
| `header` | The value of a request header, named in lower case. |

`value` is one text, or a list of texts. With a list, the condition holds if the value equals any of them.

## `dedup`

`dedup` tells Realm how to recognise the same event delivered twice.

| Key             | Type                     | Default  | What it does                                                                                                                                      |
| --------------- | ------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id_from`       | path                     | Required | Where the event's own ID is in the request.                                                                                                       |
| `ttl_minutes`   | whole number, 1 to 10080 | 60       | How long the duplicate check remembers an ID. 10080 minutes is seven days. The run store recognises the ID for as long as its run exists (below). |
| `on_missing_id` | `skip` or `reject`       | `skip`   | What to do when the ID is not in the request: carry on without the check, or refuse.                                                              |

The ID must be unique to each delivery: a sender's own event or delivery ID, never the ID of the thing the event is about. A reused ID is answered `deduplicated`, and that request's values are not used. After the duplicate window, the reply's `"params_differ":true` says when its mapped parameters differed from the run's; inside the window the reply is the bare `200` `{"status":"deduplicated"}`, and nothing says the values differed. A delivery whose agent failed to start is the exception: its retries, whatever their values, get that first `500` again, inside the window and after it, with no `params_differ` (except when two copies arrived together, below). In the block above, `id_from` names the event's ID, and the ticket's ID goes into the parameters, so every update of a ticket starts its own run.

The event's ID also becomes the run's idempotency key. A run started for event `evt-201` has `idempotency_key: evt-201`. So a delivery whose ID belongs to a run that exists starts nothing and writes nothing to that run, whether the run is still going or has ended: after the duplicate window (which starts again when a delivery of the event is matched, unless that run was ended by a failed start; with the default file store and a `ttl_minutes` under 60, only when that delivery comes in a later clock hour, UTC, than the last one recorded), and when two copies of one delivery arrive together, the reply is `200` with the run's `run_id` and its `run_phase` — or, when that run's agent failed to start, the first reply again, `500` `spawn_failed` (see [Replies](#replies)). One case does not behave this way yet: when two copies of one delivery arrive together while the agent fails to start, one copy can be answered `200` `{"status":"deduplicated","run_id":"<run-id>","run_phase":"running"}`, and its ID is recorded. Its retries then get the bare `200` `{"status":"deduplicated"}` until the duplicate window has passed, then the `500` again, and a purge followed by a new delivery starts a new run only after the window. Added after version 0.46.0, which started a second `realm agent` on that run and replied `202`.

With the block at the top of this page, event `evt-201` delivered again within five minutes gets `200` `{"status":"deduplicated"}` — unless its agent failed to start: then it gets its `500` again (the two-copy case above aside). Delivered again later, while its run exists, it gets `200` `{"status":"deduplicated","run_id":"<the run's id>","run_phase":"running"}` (or the phase the run has reached), and no run or agent starts. If that run's agent failed to start, it gets `500` `{"error":"spawn_failed","run_id":"<the run's id>","status":"failed"}` again instead. A later update of ticket `102` comes with its own event ID, and starts its own run.

Without a `dedup` block, and with `dedup: false`, deliveries are not checked: the same request twice starts two runs.

## `params_map`

A map from a parameter name to a path in the request. The values found become the run's parameters, and are checked against the workflow's `params_schema` before a run is created.

With the block at the top of this page, this request:

```text
POST /shared
X-Webhook-Token: <the secret>
X-Source: helpdesk
Content-Type: application/json

{"type": "ticket-updated", "event_id": "evt-201", "id": 102}
```

started a run with the parameters `{"ticket_id": 102, "source": "helpdesk"}` and the idempotency key `evt-201`.

## Replies

`realm listen` checks a request in this order, and stops at the first check that fails.

| Check                                                                           | Reply when it fails                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An HTTP/1.1 request's `Expect` header, if it sends one, includes `100-continue` | `417` `{"error":"expectation_failed"}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| An HTTP/1.1 request carries a `Host` header                                     | `400` `{"error":"host_required"}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| The method is `POST`                                                            | `405` `{"error":"method_not_allowed"}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| A workflow is mounted at the address                                            | `403` `{"error":"forbidden"}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Fewer requests are being handled than the limit                                 | `503` `{"error":"busy","status":"rejected"}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| The body is within the size limit and arrives in time                           | `413` `{"error":"payload_too_large","max_body_bytes":<limit>}`, or `408` `{"error":"request_timeout","body_timeout_ms":<limit>}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `Content-Type` is `application/json`                                            | `415` `{"error":"unsupported_media_type"}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| The `auth` check                                                                | `403` `{"error":"forbidden"}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| The body is JSON                                                                | `400` `{"error":"invalid_json"}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| The `filter`                                                                    | `200` `{"status":"ignored"}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| The event ID is present, with `on_missing_id: reject`                           | `400` `{"error":"dedup_id_unresolvable","status":"rejected"}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| The event has not been seen within `ttl_minutes`                                | `200` `{"status":"deduplicated"}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| The parameters fit `params_schema`                                              | `400` `{"error":"params_invalid","message":"Invalid params for workflow 'shared': /ticket_id must be number","status":"rejected"}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| No run has the event's ID                                                       | `200` `{"status":"deduplicated","run_id":"746ade77-2fcf-4ad6-8710-88cdc7f63768","run_phase":"running"}`. Nothing is started, and the run is not written to. `run_phase` is the run's phase: `abandoned` for a run that was stopped, for one. With `"params_differ":true` when the request's mapped parameters differ from the run's; its values are not used. When the run's agent failed to start: `500` `{"error":"spawn_failed","run_id":"726707a4-a0f5-4b98-bff6-8edfe9c3aba8","status":"failed"}`, the first reply again (except when two copies arrived together: see [`dedup`](#dedup)). Added after version 0.46.0. |

Every reply up to and including the body check is sent before the body has been read in full. It closes the connection: the reply carries `Connection: close`, and `realm listen` reads and discards whatever the sender is still sending for at most 2 seconds, so that the sender can receive the reply, then closes the connection. At most `--max-concurrent` connections are closed this way at once; beyond that, a refused connection is closed at once, and a sender still uploading may then see a dropped connection instead of the reply. A sender that reads the reply only after it has sent its whole body may also see a dropped connection instead of the reply, when sending the rest of the body takes longer than those 2 seconds; a sender that reads while it sends receives the reply. A body declared larger than `--max-body-bytes` (by its `Content-Length`) is refused before any of it is read. An HTTP/1.1 sender that sends `Expect: 100-continue` is told to send its body only once the checks before the body have passed. Each of these refusals logs a `webhook: refused` line.

A refusal of a request sent while an earlier reply on the same connection is still pending is sent after that reply; the 2 seconds start when the refusal is sent. A request sent on a connection after its refusal is not handled. If the refusal has not been sent yet, the replies before it and the refusal are still sent, in order, and the connection then closes as above; after more than 32 such requests, it is closed at once, and a reply not yet sent on it is lost. If the refusal has been sent, the connection is closed at once, and a sender still sending that request may see a dropped connection. A sender that asked for its connection to be closed after a request (HTTP/1.1 `Connection: close`, or HTTP/1.0 without keep-alive) cannot send a second request on it: the second is not handled, the reply to the first is still sent, and the connection then closes.

The headers must arrive within `--body-timeout-ms`, and a whole request, from its first byte to its last, within five minutes (or within twice `--body-timeout-ms` plus 3 seconds, if that is longer). Otherwise the reply is `408` `{"error":"request_timeout","headers_timeout_ms":<limit>,"request_timeout_ms":<limit>}`. A request that is not valid HTTP is refused whenever Node finds the fault, even after the checks above: `431` `{"error":"header_fields_too_large","max_header_bytes":16384}` for headers over Node's limit, `413` `{"error":"chunk_extensions_too_large"}`, and `400` `{"error":"bad_request"}` for anything else. These replies close the connection right after they are sent, as Node's own did, so a sender still sending may see a dropped connection instead. None is sent while a reply to an earlier request on the same connection is still pending: those replies are still sent, in order, and the connection then closes. The faulty message is not answered, with two exceptions. A request whose body breaks there is refused with `408` when `--body-timeout-ms` runs out. A request whose headers were late, but still arrive before the connection closes, is handled anyway: it is answered if its headers arrive before the earlier reply is sent, and its reply is lost if they arrive after (a later release fixes this). None is sent after a refusal either: the connection is already closing, and nothing is logged for it. Each of the replies above logs a `webhook: refused` line.

A request that passes them all gets:

```text
202 {"run_id":"82253b6f-9564-4dd1-91bd-f4c108d33242","status":"accepted"}
```

The reply is sent once the run exists and the separate process that drives it has started; `realm listen` does not wait for the run. When that process starts and then stops at once (no model key, for one), the request still gets this `202` and its run stays open: see the [`realm listen` reference](../cli/realm-listen.md#what-it-does-for-a-request). If that process cannot be started (its workflow folder missing, or a folder `realm listen` has no permission to enter), the run is ended as failed, the reply is instead the one below, and `realm listen` goes on serving.

```text
500 {"error":"spawn_failed","run_id":"726707a4-a0f5-4b98-bff6-8edfe9c3aba8","status":"failed"}
```

An unknown address and a failed `auth` check get the same reply.

## Rules the loader applies

| The block has                             | Refusal                                                             |
| ----------------------------------------- | ------------------------------------------------------------------- |
| A `type` other than `webhook`             | `trigger/type must be equal to constant`                            |
| No `auth`                                 | `trigger: missing required property 'auth'`                         |
| An unknown `mode`                         | `trigger/auth/mode must be equal to one of the allowed values`      |
| A mode's required key missing             | `trigger/auth: missing required property 'secret_from'`             |
| A condition with both `path` and `header` | `trigger/filter/all/0: must have exactly one of 'header' or 'path'` |
| More than 8 conditions                    | `trigger/filter/all must NOT have more than 8 items`                |
| `dedup` without `id_from`                 | `trigger/dedup: missing required property 'id_from'`                |
| `ttl_minutes` above 10080                 | `trigger/dedup/ttl_minutes must be <= 10080`                        |
| A `params_map` value that is not text     | `trigger/params_map/a must be string`                               |
| `max_age_seconds` below 1                 | `trigger/auth/max_age_seconds must be >= 1`                         |

A workflow with no `trigger` block is not mounted by `realm listen`. If none of the workflows it is given has one, it stops: `Error: no workflows with a trigger: block to mount.`

## See also

- [Start runs from webhooks](../../guides/webhooks.md)
- [`realm listen` reference](../cli/realm-listen.md) covers the size limit, the request limit and the other flags.
- [Top-level fields](top-level-fields.md)
