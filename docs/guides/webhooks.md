# Start runs from webhooks

<!-- description: Start a workflow from an HTTP request: accept a webhook, check that it is genuine, turn its contents into run parameters, and ignore repeats. -->

This guide makes a workflow start by itself when another system sends an HTTP request: a new ticket, a pushed commit, a paid invoice. At the end you have a workflow that accepts a webhook, checks that it is genuine, turns its contents into run parameters, and ignores repeats.

## Before you start

You need a workflow you can run. [Write your first workflow](first-workflow.md) makes one.

## How it works

Two parts work together:

- A `trigger` block in the workflow says which requests start a run, and how to check them.
- `realm listen` is a small web server. For each request that passes the checks, it creates a run and starts a separate `realm agent` process to drive it. It replies as soon as the run exists.

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
realm listen on 127.0.0.1:3000 — 1 workflow(s) mounted
```

The key and the model are needed because each run is driven by `realm agent`, which will not start without them, even though this workflow's only step does not call a model.

Restart `realm listen` from the workflow's folder after any change to it, an edited `.env` included: it reads the workflow, and the `.env` of the folder it is started in, once, at start; a key already set in the shell that starts it keeps its value, unless `DOTENV_CONFIG_OVERRIDE` is set.

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

```json
{ "run_id": "ed876b82-9365-4c63-9c6e-42ffed4d617e", "status": "accepted" }
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
ed876b82-9365-4c63-9c6e-42ffed4d617e  tickets v1  completed  10/2/2026, 12:30:21 AM  1 step(s)
```

## 4. See what is turned away

Each check has its own reply. Send these to see them.

**Without the secret**, the request is refused:

```text
{"error":"forbidden"}   403
```

**The same event again** starts nothing. Within the duplicate window (`ttl_minutes`, 60 minutes by default) the reply is:

```text
{"status":"deduplicated"}   200
```

Later, while the run that event started exists (a sender's redelivery, for one), and when two copies of one delivery arrive together, the reply names that run and its phase. Nothing is started and the run is not written to, whether it is still going or has ended. Here the run had already finished:

```text
{"status":"deduplicated","run_id":"c1f1da1f-ce29-4bcd-b12b-1556c5698fc7","run_phase":"completed"}   200
```

`run_phase` is the phase on the run's record, not whether an agent is working on it: a run whose agent stopped still reads `running`.

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
- A run that ended any other way: purge it, then deliver the event again once the duplicate window has passed. The window starts again each time a delivery of the event is matched in the meantime, so it is not counted from the first delivery. (With the default file store and a `ttl_minutes` under 60, a delivery matched in the same clock hour, UTC, as the last one recorded does not start it again.) Until then the delivery gets `{"status":"deduplicated"}` and starts nothing.

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
