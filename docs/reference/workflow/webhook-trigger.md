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

| Key                         | Type            | Required | What it holds                                                                                               |
| --------------------------- | --------------- | -------- | ----------------------------------------------------------------------------------------------------------- |
| `type`                      | `webhook`       | Yes      | The only kind of trigger.                                                                                   |
| [`path`](#path)             | text            | No       | The address the workflow answers on.                                                                        |
| [`auth`](#auth)             | map             | Yes      | How a request proves it is genuine.                                                                         |
| [`filter`](#filter)         | map             | No       | Which requests start a run.                                                                                 |
| [`dedup`](#dedup)           | map, or `false` | No       | How a repeated delivery is recognised.                                                                      |
| [`params_map`](#params_map) | map             | No       | Which parts of the request become the run's parameters.                                                     |
| [`result_map`](#result_map) | map             | No       | What a caller can read of a finished run. Only with `auth.mode: shared_secret`. Added after version 0.49.0. |

No other key is allowed: `Invalid workflow: trigger: unknown property 'retries'`.

In `filter`, `dedup` and `params_map`, a value in the request is named by a path that starts with `body.` or `headers.`: `body.id` is the `id` field of the JSON body, and `headers.x-source` is the `X-Source` header. Header names are written in lower case.

## `path`

The address, written with a leading `/`. Without it, the address is `/` followed by the workflow's `id`. Two workflows given to one `realm listen` must not share an address:

```text
Error: listen: path collision on '/open' — workflow 'dup' conflicts with 'open'
```

`/health` is taken by the health address; a workflow cannot have it. Added after version 0.49.0.

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

The ID must be unique to each delivery: a sender's own event or delivery ID, never the ID of the thing the event is about. A reused ID is answered `deduplicated`, and that request's values are not used. After the duplicate window, the reply's `"params_differ":true` says when its mapped parameters differed from the run's; inside the window the reply names the run, `200` `{"status":"deduplicated","run_id":"<run-id>","run_phase":"<phase>"}` (the bare `{"status":"deduplicated"}` when the run is gone), and nothing says the values differed (changed after version 0.49.0). A delivery whose agent failed to start is the exception: its retries, whatever their values, get that first `500` again, inside the window and after it, with no `params_differ` (except when two copies arrived together, below). In the block above, `id_from` names the event's ID, and the ticket's ID goes into the parameters, so every update of a ticket starts its own run.

The event's ID also becomes the run's idempotency key. A run started for event `evt-201` has `idempotency_key: evt-201`. So a delivery whose ID belongs to a run that exists starts nothing and writes nothing to that run, whether the run is still going or has ended: after the duplicate window (counted from the delivery that was recorded; a run ended by a failed start recorded no mark, so a delivery of its event reaches the store again), and when two copies of one delivery arrive together, the reply is `200` with the run's `run_id` and its `run_phase` — or, when that run's agent failed to start, the first reply again, `500` `spawn_failed` (see [Replies](#replies)). One case does not behave this way yet: when two copies of one delivery arrive together while the agent fails to start, one copy can be answered `200` `{"status":"deduplicated","run_id":"<run-id>","run_phase":"running"}`, and its ID is recorded. Its retries then get the bare `200` `{"status":"deduplicated"}` until the duplicate window has passed, then the `500` again, and a purge followed by a new delivery starts a new run only after the window. Added after version 0.46.0, which started a second `realm agent` on that run and replied `202`.

With the block at the top of this page, event `evt-201` delivered again, within five minutes or later while its run exists, gets `200` `{"status":"deduplicated","run_id":"<the run's id>","run_phase":"running"}` (or the phase the run has reached), and no run or agent starts — unless its agent failed to start: then it gets its `500` again (the two-copy case above aside). Within the five minutes, this reply was the bare `{"status":"deduplicated"}` until version 0.49.0 (changed after version 0.49.0). If that run's agent failed to start, it gets `500` `{"error":"spawn_failed","run_id":"<the run's id>","status":"failed"}` again instead. A later update of ticket `102` comes with its own event ID, and starts its own run.

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

## `result_map`

By default the caller of `realm listen` learns only that its request was accepted. With `result_map`, it can also ask later what happened to the run it started, and read the values you choose. This section was added after version 0.49.0.

```yaml
trigger:
  type: webhook
  path: /refunds
  auth:
    mode: shared_secret
    header: X-Webhook-Token
    secret_from: WH_SECRET
  dedup:
    id_from: body.event_id
  params_map:
    approved: body.approved
    note: body.note
  result_map:
    approved: context.resources.review.approved
    note: context.resources.review.note
steps:
  review:
    description: Record the decision.
    execution: auto
```

Each name becomes a key of the `result` in the reply. Each value is `context.resources.<step>.<field>`: a field of that step's recorded output. A field the run did not produce is left out; a field the run set to `null` is sent as `null`. `result_map: {}` hands out the run's phase only.

A step with no handler and no service, and no `depends_on`, records the run's parameters as its output, so a path that names it hands those parameters out. The step `review` above is one: its output is the run's `approved` and `note`.

For a workflow with `result_map`, the `202` carries `status_path` and `token`. Send `GET` or `HEAD` to `status_path`, with your own base address in front, and `Authorization: Bearer <token>`. With the block above, this request:

```text
POST /refunds
X-Webhook-Token: <the secret>
Content-Type: application/json

{"event_id":"evt-301","approved":true,"note":"refund to the original card"}
```

got:

```text
202 {"run_id":"d5135829-125d-4f31-9ba7-84cf1ac5b333","status":"accepted","run_phase":"running","status_path":"/refunds/runs/d5135829-125d-4f31-9ba7-84cf1ac5b333","token":"a138b12da78072298d9b77e1ba0a4e5d510e1f5982f4908fc415a983b6ac846b"}
Location: /refunds/runs/d5135829-125d-4f31-9ba7-84cf1ac5b333
Retry-After: 5
```

Read at once, with the token:

```text
GET /refunds/runs/d5135829-125d-4f31-9ba7-84cf1ac5b333
Authorization: Bearer a138b12da78072298d9b77e1ba0a4e5d510e1f5982f4908fc415a983b6ac846b
```

the run was still going:

```text
200 {"run_id":"d5135829-125d-4f31-9ba7-84cf1ac5b333","run_phase":"running"}
```

Read again once it had completed:

```text
200 {"run_id":"d5135829-125d-4f31-9ba7-84cf1ac5b333","run_phase":"completed","result":{"approved":true,"note":"refund to the original card"},"result_masked":{"declared":0,"environment":0,"pattern":0}}
```

| Field                      | What it holds                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run_id`                   | The run.                                                                                                                                                                                                                                                                                                                                                                  |
| `run_phase`                | `running`, `gate_waiting`, `completed`, `failed`, `aborted` or `abandoned`: Realm's own words, and for a run that failed, nothing more. The phase is the record's, not whether an agent is working on it: a run whose agent stopped still reads `running`.                                                                                                                |
| `result`                   | Once the run has completed: each name of `result_map` with its value.                                                                                                                                                                                                                                                                                                     |
| `result_masked`            | How many times Realm hid a value in the result, by kind: declared secrets, environment values, and values under names that read as credentials. A value the map reaches twice counts twice. A value Realm hides is sent as the text `[REDACTED]`.                                                                                                                         |
| `result_error`             | In place of `result`. `too_large`: the declared values are longer than 40,000 characters; none is sent. `values_withheld`, with `because` (`declared values changed` or `declared values could not be read`): Realm could not tell which values are secret, after the project's `secrets:` changed or became unreadable; none is sent. `realm run inspect` shows the run. |
| `workflow_version_differs` | `true`: the `version:` of the workflow `realm listen` loaded at start is not the one the run started under; the result is still given.                                                                                                                                                                                                                                    |

The token belongs to that run of that workflow and opens nothing else. It is worked out from the workflow's secret, so it stops working when the secret changes, and it sits wherever the caller logs the reply it came in: anyone who can read it can read that run's phase and declared values, and no more.

A wrong or missing token, a run that does not exist or was purged, and a run of another workflow all get the same `403` `{"error":"forbidden"}`.

Realm hides a value equal to one of the project's declared secrets, or to an environment value of 8 or more characters, wherever it appears in a result, even if it is not a secret; and it hides a text or a number kept under a name like `token` or `password` in the run's output, whichever way `result_map` reaches it.

A name is refused when Realm treats a field of that name as a credential's: `token`, `password`, `api_key`, `secret`, `authorization`, `cookie` and `private_key` are, in any case and with a prefix (`my_token`, `x_secret`); `tokens`, `auth` and `session` are not. Realm hides a value by the field it sits under in the run's output, not by the name given here, so a name like these would look protected and not be.

`result_map` is refused for `hmac`, `stripe`, `github` and `none`: a sender who replays a captured signed request would be handed the token, and `none` has no secret to work it out from.

A repeat of an event within `ttl_minutes` gets `200` `{"status":"deduplicated","run_id","run_phase"}`; if the run is gone, the bare `{"status":"deduplicated"}`. For a workflow with `result_map`, a repeat, inside the window or after it, also carries `status_path` and `token` again.

A proxy or gateway that sets or removes the `Authorization` header itself keeps the token from reaching `realm listen`: the read then gets the `403`.

## Replies

`realm listen` checks a request in this order, and stops at the first check that fails. Before the method check, `realm listen` answers a `GET` or `HEAD` of `/health` itself: `200` `{"status":"ok"}`, or `503` `{"status":"shutting_down"}` once it is stopping. It is not one of the checks below, and a workflow cannot have that path. Added after version 0.49.0.

Also before the method check, a `GET` or `HEAD` whose path ends in `/runs/` and a run id in lower case is a read request (see [`result_map`](#result_map)): it is answered there, takes no signature and no `--max-concurrent` slot, and gets the one `403` unless it carries a valid code. Added after version 0.49.0.

| Check                                                                                      | Reply when it fails                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An HTTP/1.1 request's `Expect` header, if it sends one, includes `100-continue`            | `417` `{"error":"expectation_failed"}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| An HTTP/1.1 request carries a `Host` header                                                | `400` `{"error":"host_required"}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| The method is `POST`, or the request is a read request, above (added after version 0.49.0) | `405` `{"error":"method_not_allowed"}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| A workflow is mounted at the address                                                       | `403` `{"error":"forbidden"}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Fewer requests are being handled than the limit                                            | `503` `{"error":"busy","status":"rejected"}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| The body is within the size limit and arrives in time                                      | `413` `{"error":"payload_too_large","max_body_bytes":<limit>}`, or `408` `{"error":"request_timeout","body_timeout_ms":<limit>}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `Content-Type` is `application/json`                                                       | `415` `{"error":"unsupported_media_type"}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| The `auth` check                                                                           | `403` `{"error":"forbidden"}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| The body is JSON                                                                           | `400` `{"error":"invalid_json"}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| The `filter`                                                                               | `200` `{"status":"ignored"}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| The event ID is present, with `on_missing_id: reject`                                      | `400` `{"error":"dedup_id_unresolvable","status":"rejected"}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| The event has not been seen within `ttl_minutes`                                           | `200` with the run's `run_id` and `run_phase`, as in the row for a run with the event's ID below, or the bare `200` `{"status":"deduplicated"}` when that run is gone (changed after version 0.49.0)                                                                                                                                                                                                                                                                                                                                                                                                                        |
| The parameters fit `params_schema`                                                         | `400` `{"error":"params_invalid","message":"Invalid params for workflow 'shared': /ticket_id must be number","status":"rejected"}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| No run has the event's ID                                                                  | `200` `{"status":"deduplicated","run_id":"746ade77-2fcf-4ad6-8710-88cdc7f63768","run_phase":"running"}`. Nothing is started, and the run is not written to. `run_phase` is the run's phase: `abandoned` for a run that was stopped, for one. With `"params_differ":true` when the request's mapped parameters differ from the run's; its values are not used. When the run's agent failed to start: `500` `{"error":"spawn_failed","run_id":"726707a4-a0f5-4b98-bff6-8edfe9c3aba8","status":"failed"}`, the first reply again (except when two copies arrived together: see [`dedup`](#dedup)). Added after version 0.46.0. |

Every reply up to and including the body check is sent before the body has been read in full. It closes the connection: the reply carries `Connection: close`, and `realm listen` reads and discards whatever the sender is still sending for at most 2 seconds, so that the sender can receive the reply, then closes the connection. At most `--max-concurrent` connections are closed this way at once; beyond that, a refused connection is closed at once, and a sender still uploading may then see a dropped connection instead of the reply. A sender that reads the reply only after it has sent its whole body may also see a dropped connection instead of the reply, when sending the rest of the body takes longer than those 2 seconds; a sender that reads while it sends receives the reply. A body declared larger than `--max-body-bytes` (by its `Content-Length`) is refused before any of it is read. An HTTP/1.1 sender that sends `Expect: 100-continue` is told to send its body only once the checks before the body have passed. Each of these refusals logs a `webhook: refused` line.

A refusal of a request sent while an earlier reply on the same connection is still pending is sent after that reply; the 2 seconds start when the refusal is sent. A request sent on a connection after its refusal is not handled. If the refusal has not been sent yet, the replies before it and the refusal are still sent, in order, and the connection then closes as above; after more than 32 such requests, it is closed at once, and a reply not yet sent on it is lost. If the refusal has been sent, the connection is closed at once, and a sender still sending that request may see a dropped connection. A sender that asked for its connection to be closed after a request (HTTP/1.1 `Connection: close`, or HTTP/1.0 without keep-alive) cannot send a second request on it: the second is not handled, the reply to the first is still sent, and the connection then closes.

The headers must arrive within `--body-timeout-ms`, and a whole request, from its first byte to its last, within five minutes (or within twice `--body-timeout-ms` plus 3 seconds, if that is longer). Otherwise the reply is `408` `{"error":"request_timeout","headers_timeout_ms":<limit>,"request_timeout_ms":<limit>}`. A request that is not valid HTTP is refused whenever Node finds the fault, even after the checks above: `431` `{"error":"header_fields_too_large","max_header_bytes":16384}` for headers over Node's limit, `413` `{"error":"chunk_extensions_too_large"}`, and `400` `{"error":"bad_request"}` for anything else. These replies close the connection right after they are sent, as Node's own did, so a sender still sending may see a dropped connection instead. None is sent while a reply to an earlier request on the same connection is still pending: those replies are still sent, in order, and the connection then closes. The faulty message is not answered, with two exceptions. A request whose body breaks there is refused with `408` when `--body-timeout-ms` runs out. A request whose headers were late, but still arrive before the connection closes, is handled anyway: it is answered if its headers arrive before the earlier reply is sent, and its reply is lost if they arrive after (a later release fixes this). None is sent after a refusal either: the connection is already closing, and nothing is logged for it. Each of the replies above logs a `webhook: refused` line.

A request that passes them all gets:

```text
202 {"run_id":"82253b6f-9564-4dd1-91bd-f4c108d33242","status":"accepted"}
```

For a workflow with `result_map`, the `202` also carries `run_phase`, `status_path` and `token`, with the headers `Location: <status_path>` and `Retry-After: 5` (the example is under [`result_map`](#result_map)). Added after version 0.49.0.

The reply is sent once the run exists and the separate process that drives it has started; `realm listen` does not wait for the run. When that process starts and then stops at once (no model key, for one), the request still gets this `202` and its run stays open: see the [`realm listen` reference](../cli/realm-listen.md#what-it-does-for-a-request). If that process cannot be started (its workflow folder missing, or a folder `realm listen` has no permission to enter), the run is ended as failed, the reply is instead the one below, and `realm listen` goes on serving.

```text
500 {"error":"spawn_failed","run_id":"726707a4-a0f5-4b98-bff6-8edfe9c3aba8","status":"failed"}
```

An unknown address and a failed `auth` check get the same reply.

## Rules the loader applies

| The block has                                                                                              | Refusal                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A `type` other than `webhook`                                                                              | `trigger/type must be equal to constant`                                                                                                                                                                                                                                                                                                                                                         |
| No `auth`                                                                                                  | `trigger: missing required property 'auth'`                                                                                                                                                                                                                                                                                                                                                      |
| An unknown `mode`                                                                                          | `trigger/auth/mode must be equal to one of the allowed values`                                                                                                                                                                                                                                                                                                                                   |
| A mode's required key missing                                                                              | `trigger/auth: missing required property 'secret_from'`                                                                                                                                                                                                                                                                                                                                          |
| A condition with both `path` and `header`                                                                  | `trigger/filter/all/0: must have exactly one of 'header' or 'path'`                                                                                                                                                                                                                                                                                                                              |
| More than 8 conditions                                                                                     | `trigger/filter/all must NOT have more than 8 items`                                                                                                                                                                                                                                                                                                                                             |
| `dedup` without `id_from`                                                                                  | `trigger/dedup: missing required property 'id_from'`                                                                                                                                                                                                                                                                                                                                             |
| `ttl_minutes` above 10080                                                                                  | `trigger/dedup/ttl_minutes must be <= 10080`                                                                                                                                                                                                                                                                                                                                                     |
| A `params_map` value that is not text                                                                      | `trigger/params_map/a must be string`                                                                                                                                                                                                                                                                                                                                                            |
| `max_age_seconds` below 1                                                                                  | `trigger/auth/max_age_seconds must be >= 1`                                                                                                                                                                                                                                                                                                                                                      |
| `result_map` on a mode other than `shared_secret` (added after version 0.49.0)                             | `trigger.result_map is allowed only with auth.mode 'shared_secret'; this trigger uses 'hmac'. A caller reads a run with a code worked out from the shared secret, and only a request that carries the secret in a header is handed it: with a signed body the code would go to anyone who replays a captured signed request, and 'none' has no secret. Remove result_map, or use shared_secret.` |
| A `result_map` name that reads as a credential's (added after version 0.49.0)                              | `trigger.result_map: 'token' reads as a credential's name. Realm hides a value because of the field it sits under in the run's output, not because of the name given here, so this name would look protected and not be. Rename it.`                                                                                                                                                             |
| A `result_map` value that does not start with `context.resources.` and a step (added after version 0.49.0) | `trigger.result_map.approved: 'review.approved' must start with 'context.resources.' and a step of this workflow, as in context.resources.review.approved.`                                                                                                                                                                                                                                      |
| A `result_map` step that is not this workflow's (added after version 0.49.0)                               | `trigger.result_map.approved: 'reveiw' is not a step of this workflow. Did you mean 'review'? Name a step of this workflow.`                                                                                                                                                                                                                                                                     |

A workflow with no `trigger` block is not mounted by `realm listen`. If none of the workflows it is given has one, it stops: `Error: no workflows with a trigger: block to mount.`

## See also

- [Start runs from webhooks](../../guides/webhooks.md)
- [`realm listen` reference](../cli/realm-listen.md) covers the size limit, the request limit and the other flags.
- [Top-level fields](top-level-fields.md)
