# Start runs from webhooks

<!-- description: Start a workflow from an HTTP request: accept a webhook, check that it is genuine, turn its contents into run parameters, and ignore repeats. -->

This guide makes a workflow start by itself when another system sends an HTTP request: a new ticket, a pushed commit, a paid invoice. At the end you have a workflow that accepts a webhook, checks that it is genuine, turns its contents into run parameters, and ignores repeats.

## Before you start

You need a workflow you can run. [Write your first workflow](first-workflow.md) makes one.

## How it works

Two parts work together:

- A `trigger` block in the workflow says which requests start a run, and how to check them.
- `realm listen` is a small web server. For each request that passes the checks, it creates a run and starts a separate `realm agent` process to drive it. It replies as soon as the run exists, unless the request asks it to wait: see [Waiting for the result](../reference/workflow/webhook-trigger.md#waiting-for-the-result).

## 1. Add a trigger to the workflow

```yaml
id: tickets
name: Record a new ticket
version: 1

params_schema:
  type: object
  additionalProperties: false
  required: [ticket_id, subject]
  properties:
    ticket_id:
      type: number
    subject:
      type: string

trigger:
  type: webhook
  path: /tickets
  auth:
    mode: shared_secret
    header: X-Webhook-Token
    secret_from: TICKETS_WEBHOOK_TOKEN
  filter:
    all:
      - { path: body.type, value: ticket-created }
  dedup:
    id_from: body.id
  params_map:
    ticket_id: body.id
    subject: body.subject

steps:
  record:
    description: Record that the ticket arrived.
    execution: auto
```

The trigger has five parts:

| Key          | What it does                                                                                           |
| ------------ | ------------------------------------------------------------------------------------------------------ |
| `path`       | The address the workflow answers on. Without it, the address is `/` followed by the workflow's `id`.   |
| `auth`       | How a request proves it is genuine. Here the sender must put a secret in the `X-Webhook-Token` header. |
| `filter`     | Which requests matter. Here only those whose body has `type: ticket-created`.                          |
| `dedup`      | Where to find the event's own ID, so that a repeated delivery does not start a second run.             |
| `params_map` | Which fields of the request become the run's parameters.                                               |

In `filter`, `dedup` and `params_map`, `body.…` means a field of the request's JSON body, and `headers.…` a request header.

The secret is not written in the workflow. `secret_from` names an environment variable that holds it.

## 2. Start the server

Set the secret and a model provider key, then start `realm listen` on the workflow's folder, with the provider and the model:

```bash
export TICKETS_WEBHOOK_TOKEN=choose-a-long-secret
export ANTHROPIC_API_KEY=your-key
realm listen ./ --port 3000 --provider anthropic --model claude-sonnet-5-5
```

The command uses Anthropic and the model `claude-sonnet-5-5`; with an OpenAI key, use `--provider openai --model <a model from OpenAI's list>` ([OpenAI's models](https://developers.openai.com/api/docs/models)). Version 0.45.0 has no `--provider` or `--model` on `realm listen`: leave them out there.

It prints:

```text
listen: mounted {"workflow":"tickets","path":"/tickets","mode":"shared_secret"}
listen: caching {"anthropic":"auto: off, 5 minutes or 1 hour for each step without tools, by that step's own earlier runs and the prices in runner.cache.economics; 5 minutes for a step that calls tools","set_by":"realm listen's default"}
realm listen on 127.0.0.1:3000 — 1 workflow(s) mounted
```

The key and the model are needed because each run is driven by `realm agent`, which will not start without them, even though this workflow's only step does not call a model.

Restart `realm listen` from the workflow's folder after any change to it, an edited `.env` included: it reads the workflow, and the `.env` of the folder it is started in (or the file `DOTENV_CONFIG_PATH` names), once, at start; a key already set in the shell that starts it keeps its value, unless `DOTENV_CONFIG_OVERRIDE` is set in that shell (a line in that `.env` changes only how each agent loads its own folder's `.env`; see [`realm listen`](../reference/cli/realm-listen.md#what-it-does-when-it-starts)).

You can give `realm listen` several workflow folders. Each must have a `trigger` and its own `path`.

## 3. Send a request

Send the kind of request the other system would send:

```bash
curl -X POST http://127.0.0.1:3000/tickets \
  -H 'Content-Type: application/json' \
  -H 'X-Webhook-Token: choose-a-long-secret' \
  -d '{"type":"ticket-created","id":101,"subject":"Charged twice"}'
```

It prints:

```text
{"run_id":"ed876b82-9365-4c63-9c6e-42ffed4d617e","status":"accepted"}
```

The status code is `202`. The run now exists, and `realm listen` logs that it handed the run over:

```text
webhook: dispatched {"path":"/tickets","run_id":"ed876b82-9365-4c63-9c6e-42ffed4d617e","pid":1883248}
```

A moment later the run has finished:

```bash
realm run list
```

```text
ed876b82-9365-4c63-9c6e-42ffed4d617e  tickets v1  completed  2026-10-02T00:30:21.517Z  1 step(s)
```

### Getting the result back

The caller can also read what happened to the run, and values the workflow chooses to hand back, when the workflow declares them in `result_map` under `trigger` (with `auth.mode: shared_secret`; see [`result_map`](../reference/workflow/webhook-trigger.md#result_map)). Here, a refunds workflow at `/refunds` whose step `review` records `approved` and `note`:

```yaml
result_map:
  approved: context.resources.review.approved
  note: context.resources.review.note
```

The request that started the run was `POST /refunds`, with the shared secret in its header and the body `{"event_id":"evt-301","approved":true,"note":"refund to the original card"}`; the whole workflow is under [`result_map`](../reference/workflow/webhook-trigger.md#result_map).

Its `202` then also says where to read the run, and with what token:

```text
202 {"run_id":"d5135829-125d-4f31-9ba7-84cf1ac5b333","status":"accepted","run_phase":"running","status_path":"/refunds/runs/d5135829-125d-4f31-9ba7-84cf1ac5b333","token":"a138b12da78072298d9b77e1ba0a4e5d510e1f5982f4908fc415a983b6ac846b"}
```

Read it with `GET`, putting your own base address in front of `status_path`:

```bash
curl http://127.0.0.1:3000/refunds/runs/d5135829-125d-4f31-9ba7-84cf1ac5b333 \
  -H 'Authorization: Bearer a138b12da78072298d9b77e1ba0a4e5d510e1f5982f4908fc415a983b6ac846b'
```

Once the run has completed, the reply holds the declared values:

```text
200 {"run_id":"d5135829-125d-4f31-9ba7-84cf1ac5b333","run_phase":"completed","result":{"approved":true,"note":"refund to the original card"},"result_masked":{"declared":0,"environment":0,"pattern":0}}
```

This was added after version 0.49.0.

### Waiting for the answer

A caller that would rather have the result in the reply itself sends `Prefer: wait=20` with the request that starts the run, to a workflow that has a `result_map` (the refunds workflow above; a workflow without one ignores the header). `realm listen` then holds the reply until the run ends or stops at a person's gate, for 20 seconds at most:

```bash
curl -i http://127.0.0.1:3000/refunds \
  -H 'Content-Type: application/json' \
  -H 'X-Webhook-Token: choose-a-long-secret' \
  -H 'Prefer: wait=20' \
  -d '{"event_id":"evt-302","approved":true,"note":"refund to the original card"}'
```

The run ended about a second later, and the reply holds its result (the `Date` and connection headers are left out here):

```text
HTTP/1.1 200 OK
Content-Type: application/json
Cache-Control: no-store
Content-Length: 196
Preference-Applied: wait=20

{"run_id":"9db311b2-3159-4247-9370-83e6f2ab2ee6","run_phase":"completed","result":{"approved":true,"note":"refund to the original card"},"result_masked":{"declared":0,"environment":0,"pattern":0}}
```

A run that is still going when the time is up gets the `202` instead, with its phase, its `status_path` and its token. Here a second refunds workflow, at `/refunds-review`, with the same `result_map` and a step that asks a model, was asked with `Prefer: wait=5` while the model had not yet answered:

```text
HTTP/1.1 202 Accepted
Content-Type: application/json
Content-Length: 240
Location: /refunds-review/runs/48da5dfe-1666-4b88-915d-180fc4eac78c
Retry-After: 5
Preference-Applied: wait=5

{"run_id":"48da5dfe-1666-4b88-915d-180fc4eac78c","status":"accepted","run_phase":"running","status_path":"/refunds-review/runs/48da5dfe-1666-4b88-915d-180fc4eac78c","token":"843a235f3a349ecf96c3413302fa67222bcf768963575fa8baba4a69eeb4c3ce"}
```

The wait never stops the run: read it later at its `status_path`, as above. When the header is ignored is in [Waiting for the result](../reference/workflow/webhook-trigger.md#waiting-for-the-result); what `--max-wait` and `--max-waiting` do is in [`realm listen`](../reference/cli/realm-listen.md). This was added after version 0.49.0.

### Receive a callback

A caller that would rather not hold a connection open, or ask again, can give `realm listen` an address. When the run ends, `realm listen` sends the run's result there, signed so that the receiver can check who sent it. n8n's Wait node is the usual case: a flow starts the run, waits at its resume address, and carries on when the result arrives. Added after version 0.50.0.

Four things make it work.

**1. The workflow takes callbacks.** Its `trigger` has a `result_map` and `auth.mode: shared_secret`, as in [Getting the result back](#getting-the-result-back). The examples use the `refunds` workflow of that page: save the workflow of [`result_map`](../reference/workflow/webhook-trigger.md#result_map) (add `id: refunds`, a `name` and `version: 1` above its `trigger:`) as `refunds/workflow.yaml`, and set `WH_SECRET=choose-a-long-secret` in the environment of `realm listen`: it is the variable that workflow's `secret_from` names. A request that names a callback address to a workflow without them is answered `400` `{"error":"callback_not_enabled"}`.

**2. The receiver has a key.** `realm callback key ./refunds --host n8n.example.com` prints the key for this workflow and this receiver: 64 hexadecimal characters. The example on this page has its receiver on this machine, at `127.0.0.1:5678`, and its key is a scratch one that protects nothing:

```bash
realm callback key ./refunds --host 127.0.0.1:5678
```

```text
9861eea1e672ada7e590ca5db45a45f5bf45a63c96b1c8b040e3e71e4e841f76
Made a key for refunds → 127.0.0.1:5678 (key 05089f2a), sealed with encryption key 01769354.
```

The example was made with `REALM_ENCRYPTION_KEY` set. In a fresh home without it, `realm callback key` also makes the master key file `encryption.key` and prints a line telling you to keep a copy of it somewhere safe, because `realm db backup` does not copy it.

Give it to the receiver, which checks every callback's signature with it. Realm keeps the key sealed in its database; [`realm callback`](../reference/cli/realm-callback.md) says how to change it, and where the master key that seals it comes from.

**3. `realm listen` is told which receivers it may call.** `--callback-allow n8n.example.com` for a receiver on a public address, `--callback-allow-private http://n8n.lan:5678` for one on this machine or your own network (an entry written with `http://` allows plain `http` as well as `https`; one without it allows `https` only). Without either flag every callback address is refused. See [`realm listen`](../reference/cli/realm-listen.md#--callback-allow). The example's receiver is on plain `http` on this machine, so its `realm listen` was started as in [2. Start the server](#2-start-the-server), with the flag added: `--callback-allow-private http://127.0.0.1:5678`.

**4. The request names the address,** in the header `realm-callback-url` of the request that starts the run:

```bash
curl -i http://127.0.0.1:3000/refunds \
  -H 'Content-Type: application/json' \
  -H 'X-Webhook-Token: choose-a-long-secret' \
  -H 'realm-callback-url: http://127.0.0.1:5678/webhook-waiting/301' \
  -d '{"event_id":"evt-303","approved":true,"note":"refund to the original card"}'
```

The `202` says the address was taken:

```text
HTTP/1.1 202 Accepted
Content-Type: application/json
Content-Length: 257
Location: /refunds/runs/d1ee248d-cdd8-401d-a306-2f94ff3549a9
Retry-After: 5
Date: Sun, 22 Nov 2026 14:17:54 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"run_id":"d1ee248d-cdd8-401d-a306-2f94ff3549a9","status":"accepted","run_phase":"running","status_path":"/refunds/runs/d1ee248d-cdd8-401d-a306-2f94ff3549a9","token":"074110113b61c4be444aad24ce6a36fb890a237a570d2c413d373e1d28c02d4f","callback":"registered"}
```

#### What Realm sends

When the run ends, `realm listen` sends one `POST` to the address: a moment after the agent that was driving the run exits, and otherwise within 30 seconds: `realm listen` looks for callbacks that are due, a pass, when an agent it started exits and every 30 seconds. The body is JSON:

```text
POST /webhook-waiting/301 HTTP/1.1
webhook-id: be9a0767-2eae-42f7-b35e-22ad3bdd85c9
webhook-timestamp: 1795357077
webhook-signature: v1,ZrbGFyouDNMkYOTSSoFxyfmJJC1Yuz8Y/PnRz3Y31ro=
content-type: application/json
user-agent: realm/0.50.1-dev.0
realm-run-id: d1ee248d-cdd8-401d-a306-2f94ff3549a9
content-length: 333
Host: 127.0.0.1:5678
Connection: close

{"type":"run.finished","timestamp":"2026-11-22T14:17:57.578Z","data":{"run_id":"d1ee248d-cdd8-401d-a306-2f94ff3549a9","run_phase":"completed","result":{"approved":true,"note":"refund to the original card"},"result_masked":{"declared":0,"environment":0,"pattern":0},"status_path":"/refunds/runs/d1ee248d-cdd8-401d-a306-2f94ff3549a9"}}
```

`timestamp` is when the run ended. `data` holds what a `GET` of the run's `status_path` answers, without its `callback` member (the run's id and phase and, once it has completed, `result`, `result_masked` or `result_error`: see [Getting the result back](#getting-the-result-back)), and `status_path`. A run that failed, was aborted or was abandoned sends its id, its phase and `status_path` only. The read token is never sent.

| Header              | What it holds                                                                                                                                                                                         |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `webhook-id`        | An id for this callback, the same on every try                                                                                                                                                        |
| `webhook-timestamp` | When this try was sent, in whole seconds since 1 January 1970 (UTC)                                                                                                                                   |
| `webhook-signature` | `v1,` and the signature below; while the key that was replaced is still kept (see [`realm callback`](../reference/cli/realm-callback.md)), two of them, separated by a space, the current key's first |
| `content-type`      | `application/json`                                                                                                                                                                                    |
| `user-agent`        | `realm/` and the version                                                                                                                                                                              |
| `realm-run-id`      | The run's id                                                                                                                                                                                          |

The first three are those of the [Standard Webhooks](https://www.standardwebhooks.com/) specification, so a library for it can check them: `realm callback key ./refunds --host n8n.example.com --whsec` prints the key in the `whsec_` form such libraries take. The signature is `v1,` and the base64 of the HMAC-SHA-256 of `<webhook-id>.<webhook-timestamp>.<body>`, keyed with the key as it was printed: its 64 characters as text, not decoded.

#### Check the signature

Check the signature of the body exactly as it arrived, before it is parsed. In Node, save this as `verify.mjs`, since it uses `import`:

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

// key: the 64 characters `realm callback key` printed, as text. headers: the request's headers,
// names in lower case. body: the body exactly as it arrived (a string).
export function verify(key, headers, body, now = Math.floor(Date.now() / 1000)) {
  const id = headers['webhook-id'];
  const timestamp = headers['webhook-timestamp'];
  const signatures = headers['webhook-signature'];
  if (!id || !timestamp || !signatures) return false;
  if (!(Math.abs(now - Number(timestamp)) <= 300)) return false;
  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest();
  return signatures.split(' ').some((token) => {
    const [version, signature] = token.split(',');
    if (version !== 'v1' || !signature) return false;
    const given = Buffer.from(signature, 'base64');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}
```

Check every token in `webhook-signature`, and reject a request whose timestamp is more than five minutes from your clock.

#### If the receiver does not take it

A `2xx` answer ends the callback: it is delivered. A `410` ends it too: the receiver has said to stop. Any other answer (a redirect is one: Realm does not follow it), no answer within 10 seconds, or no connection, is tried again, with the same body and the same `webhook-id` and a new timestamp and signature. The wait before a try is 1 second after the first failure and doubles each time up to 1 hour, with 20 % either way; a `Retry-After` of whole seconds raises it, to at most 1 hour. A wait is served at the next pass, so a retry can come up to 30 seconds after its wait has ended. It is given up 1 hour after the first try when the last answer was a `4xx` other than `408`, `425` and `429`, and otherwise 3 days after the run ended.

A callback waits while no `realm listen` runs that has `--callback-allow` or `--callback-allow-private`, the workflow and a key it can read. A `realm listen` that has a flag but no entry for the receiver ends the callback at its next try and does not send it: the entry is checked again at every try. If `realm listen` is stopped while a try is in flight and the grace (`--shutdown-grace`) ends first, the exit code is still 0 and the try is made again after the next start (about a minute later: the cut try holds the callback that long), with the same `webhook-id`: ignore an id you have already handled.

Realm connects only to an address it has checked: a host name on `--callback-allow` whose address is private, local or shared is not called (the try fails and is made again later), and the receiver's certificate is always checked. Realm does not use `HTTP_PROXY` or `HTTPS_PROXY` for callbacks.

#### What a refused request says

| The reply                                                 | Why                                                                                                          |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `400` `{"error":"callback_not_enabled"}`                  | The workflow has no `result_map` with `shared_secret`, or `realm listen` was started with neither flag       |
| `400` `{"error":"callback_refused","reason":"malformed"}` | The header is empty, repeated, or not an address (it has a space or `#`, no host, or port 0)                 |
| `…"reason":"too_long"`                                    | The address is longer than 2,048 characters                                                                  |
| `…"reason":"scheme"`                                      | The scheme is not `http` or `https`, or it is `http://` to a host and port that are listed without `http://` |
| `…"reason":"userinfo"`                                    | The address holds a user name or a password                                                                  |
| `…"reason":"not_allowed"`                                 | No entry of `--callback-allow` or `--callback-allow-private` has the address's host and port                 |
| `…"reason":"no_key"`                                      | There is no key Realm can read for this workflow and this host: `realm listen` says which command makes one  |
| `503` `{"error":"callback_backlog"}`                      | 1,000 callbacks are waiting to be sent                                                                       |

A request is refused before a run is made. A repeat of an event inside the [duplicate window](../reference/workflow/webhook-trigger.md#dedup) is answered before this check, `200` `deduplicated`; when that repeat also names an address, the reply carries `"callback":"ignored_duplicate"` if the first request registered one and `"callback":"none"` if not (a repeat that names none has no `callback`). After the window the check comes first, and a refused address gets its refusal.

#### Seeing how a callback stands

`realm run inspect <run id>` has a `Callback:` line:

```text
Callback: delivered to 127.0.0.1:5678 1s ago (2026-11-22T14:17:57Z), attempt 1
Callback: pending, attempt 1, last answer 503, next try in 1m (2026-11-22T14:20:02Z)
Callback: due since 2s ago (2026-11-22T14:19:30Z); sent only while realm listen with a matching allow-list runs
Callback: failed after 2 attempts, last answer 410
Callback: expired at attempt 2, not delivered within its time limit
Callback: waiting for the run to finish
```

`pending` means the next try is still to come; `due` means a try is due now and waits for the next pass of a `realm listen` that can send it: one with `--callback-allow` or `--callback-allow-private`, the workflow, a key it can read and an entry for the receiver.

A `GET` of the run's `status_path` carries `callback` once the run is no longer running or waiting at a question: `state` (`pending`, `delivered` or `failed`), `attempts` and, when they apply, `last_status` (an HTTP status, or `timeout`, `connection`, `redirect`, `refused_address`, `not_allowed` or `expired`) and `next_try`. After the example's callback was delivered:

```bash
curl http://127.0.0.1:3000/refunds/runs/d1ee248d-cdd8-401d-a306-2f94ff3549a9 \
  -H 'Authorization: Bearer 074110113b61c4be444aad24ce6a36fb890a237a570d2c413d373e1d28c02d4f'
```

```text
{"run_id":"d1ee248d-cdd8-401d-a306-2f94ff3549a9","run_phase":"completed","result":{"approved":true,"note":"refund to the original card"},"result_masked":{"declared":0,"environment":0,"pattern":0},"callback":{"state":"delivered","attempts":1,"last_status":200}}
```

The same read of a run whose receiver had answered `503` with `Retry-After: 120`:

```text
{"run_id":"1a8890d7-07a6-4991-84c5-3d85c1a43245","run_phase":"completed","result":{"approved":true,"note":"refund to the original card"},"result_masked":{"declared":0,"environment":0,"pattern":0},"callback":{"state":"pending","attempts":1,"last_status":503,"next_try":"2026-11-22T14:20:02.145Z"}}
```

`next_try` can be in the past: the callback is due and waits for the next pass.

#### In n8n

This part is read from n8n's documentation and source (version 2.47.7); we did not run n8n for it. A flow that starts a run and waits for its callback has an **HTTP Request** node that posts to `realm listen` with the header `realm-callback-url` set to `{{ $execution.resumeUrl }}`, followed in the same execution by a **Wait** node with Resume `On Webhook Call` and HTTP Method `POST` (its default is `GET`). n8n's Wait node is read, from its source, to answer `409` (or `404`) until the flow has reached it; Realm tries a `4xx` again for an hour, so a run that ends before the flow gets there can still be delivered. Checking the signature in n8n is not settled by its documentation: the Crypto node takes its secret as text, as Realm's key is, but we could not confirm how to give it the body exactly as received. Until you have a way that works, check it in a **Code** node: the function above with `require('crypto')` in place of its `import` and no `export`. It needs the body exactly as received, and we do not know how the Wait node hands that over. On self-hosted n8n the Code node needs `NODE_FUNCTION_ALLOW_BUILTIN=crypto` set on its task runner (`crypto` and `node:crypto` are separate entries), and n8n Cloud has `crypto`.

## 4. See what is turned away

Each check has its own reply. Send these to see them.

**Without the secret**, the request is refused:

```text
{"error":"forbidden"}   403
```

**The same event again** starts nothing. The reply names the run that event started and its phase: within the duplicate window (`ttl_minutes`, 60 minutes by default), later while that run exists (a sender's redelivery, for one), and when two copies of one delivery arrive together. Nothing is started and the run is not written to, whether it is still going or has ended. Here the run had already finished:

```text
{"status":"deduplicated","run_id":"c1f1da1f-ce29-4bcd-b12b-1556c5698fc7","run_phase":"completed"}   200
```

`run_phase` is the phase on the run's record, not whether an agent is working on it: a run whose agent stopped still reads `running`. Within the duplicate window, a run that is gone (purged) gets the bare `{"status":"deduplicated"}`; until version 0.49.0 every reply within the window was that bare one (changed after version 0.49.0).

**An event the filter does not want**, for example `"type":"ticket-closed"`, starts nothing:

```text
{"status":"ignored"}   200
```

**Contents that do not fit `params_schema`**, for example `"id":"abc"`, are refused with the reason:

```text
{"error":"params_invalid","message":"Invalid params for workflow 'tickets': /ticket_id must be number","status":"rejected"}   400
```

In none of these cases is a run created or a `realm agent` started. The `200` replies are deliberate: the sender did nothing wrong, so it should not retry.

**An agent that cannot be started** (the workflow's folder missing, or a folder `realm listen` has no permission to enter) ends the run the request created as failed, and the reply says so; `realm listen` goes on serving. The same event again starts nothing and gets the same reply:

```text
{"error":"spawn_failed","run_id":"726707a4-a0f5-4b98-bff6-8edfe9c3aba8","status":"failed"}   500
```

This `500` is deliberate: the event's work never ran, and each retry of that delivery gets the same reply until you deal with the run.

One case does not behave this way yet: **two copies of one delivery arriving together while the agent fails to start.** One copy can be answered `200` `{"status":"deduplicated","run_id":"<run-id>","run_phase":"running"}`, and its ID is recorded. Retries then get the bare `{"status":"deduplicated"}` until the duplicate window has passed, then the `500` again, and purging the run and delivering again starts a new run only after the window.

**To give an event's run another go:**

- A run still going whose agent stopped: drive it again with `realm agent --run-id <run-id>` in the workflow's folder.
- A run that has ended is not driven again: `realm agent --run-id` refuses it.
- A run whose agent failed to start: remove it with `realm run purge <run-id> --force`, then deliver the event again. It starts a new run at once, unless two copies arrived together (the case above): then it starts one only after the duplicate window.
- A run that ended any other way: purge it, then deliver the event again once the duplicate window has passed. The window is counted from the delivery that was recorded; a delivery matched in the meantime does not move it. Until then the delivery gets `{"status":"deduplicated"}` and starts nothing.

## Choose how requests are checked

`auth.mode` has five values. Pick the one the sending system supports.

| Mode            | The sender proves itself by                                              |
| --------------- | ------------------------------------------------------------------------ |
| `shared_secret` | Putting a fixed secret in a header you name.                             |
| `github`        | Signing the body the way GitHub does, in `X-Hub-Signature-256`.          |
| `stripe`        | Signing the body the way Stripe does, in `Stripe-Signature`.             |
| `hmac`          | Signing the body with a secret, in a header and algorithm you name.      |
| `none`          | Nothing. Use only on a network you trust; `realm listen` warns about it. |

## Running it for real

- **`realm listen` accepts connections from this machine only**, unless you set `--host`. To receive webhooks from the internet, put it behind a web server or tunnel that provides HTTPS.
- **It limits requests, not runs.** `--max-concurrent` (20 by default) is the number of requests being handled at once; past that it replies `503`. Each accepted request starts its own `realm agent` process, and nothing limits how many of those run at the same time.
- **Workflows with human gates** need a way to be answered while no one is at a terminal. See [Answer gates from Slack](slack-gates.md).
- **Gates with a time limit** are carried out only when something acts on the run. Start `realm listen` with `--sweep-expired-gates <seconds>` to have it check on that interval.

## If you see something else

- **`Error: listen: workflow 'tickets' references secret env var 'TICKETS_WEBHOOK_TOKEN' which is not set`** The variable named in `secret_from` is not set in the shell that starts `realm listen`. Set it and start again.
- **`{"error":"forbidden"}` for a request you believe is right.** Check the header's name and value, and the address: a path that no workflow is mounted on gets the same reply.

## See also

- [Webhook `trigger` reference](../reference/workflow/webhook-trigger.md) lists every key and every `auth` mode's settings.
- [`realm listen` reference](../reference/cli/realm-listen.md)
- [Start runs safely](idempotency-and-batches.md) covers starting runs without duplicates in general.
