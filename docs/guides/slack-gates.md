# Answer gates from Slack

This guide makes `realm agent` post each human gate to a Slack channel and take the answer from a reply in the thread. At the end, a person approves or rejects from Slack and the run carries on within a second or two.

## Before you start

You need:

- a workflow with a human gate, driven by `realm agent`. See [Add a human gate](human-gates.md);
- a Slack workspace where you may create an app.

## How it works

When a gate opens, `realm agent` posts a message to a channel through a Slack app you own, and opens a connection to Slack to listen for replies in that message's thread. This connection is Slack's Socket Mode: it goes out from your machine, so you need no public address. When someone replies with one of the gate's choices, Realm records the answer and the run continues.

## 1. Create the Slack app

Go to [api.slack.com/apps](https://api.slack.com/apps) and create an app in your workspace. Give it four settings:

| Where in the app's settings                   | Setting                             |
| --------------------------------------------- | ----------------------------------- |
| OAuth & Permissions → Bot Token Scopes        | `chat:write` and `channels:history` |
| Socket Mode                                   | Enable Socket Mode: on              |
| Event Subscriptions                           | Enable Events: on                   |
| Event Subscriptions → Subscribe to bot events | `message.channels`                  |

The last two are easy to miss. Without the event subscription, Slack never tells Realm about a reply, and the gate stays open.

Then install the app to the workspace, and add it to the channel where gates should appear.

## 2. Collect three values

- The **bot token**, from OAuth & Permissions. It starts with `xoxb-`.
- An **app-level token**, from Basic Information → App-Level Tokens. Socket Mode uses it to open the connection. It starts with `xapp-`.
- The **channel ID**, from the channel's details in Slack. It looks like `C08V0S1ABCD`.

Put them in a file named `.env` beside your workflow. Keep this file out of version control.

```text
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_APP_TOKEN=xapp-your-app-token
SLACK_CHANNEL_ID=C08V0S1ABCD
```

## 3. Tell Realm about Slack

Create `realm.yaml` beside your workflow, or add this block to it:

```yaml
version: 1
notifiers:
  slack_gate:
    type: slack
    config:
      bot_token: '${secret:SLACK_BOT_TOKEN}'
      channel_id: '${secret:SLACK_CHANNEL_ID}'
      app_token: '${secret:SLACK_APP_TOKEN}'
```

`${secret:NAME}` is replaced with the value from `.env`. Realm reads Slack settings only from this block. Setting `SLACK_…` variables in your shell has no effect.

## 4. Run to the gate

This guide uses a workflow with one gate:

```yaml
id: slack-test
name: Slack gate test
version: 1

steps:
  review:
    description: A person decides from Slack whether the message goes out.
    execution: auto
    trust: human_confirmed
    gate:
      choices: [send, discard]
      message: |
        Realm docs test. Reply in this thread with one word: send or discard.
      resolution_messages:
        send: 'Recorded: send.'
        discard: 'Recorded: discard.'

  send:
    description: Send the message.
    execution: auto
    depends_on: [review]
    when: "review.choice == 'send'"
```

Start it with `realm agent`. Use `--register`, so that the gate can also be answered from the command line:

```bash
realm agent --workflow ./ --register
```

It prints:

```text
Realm Agent — Slack gate test v1
Run ID: 71b0ed55-f198-41b1-a6e2-e9234b1fab1c

→ [auto] review

⏸  Gate: review | ID: cc12fb7f-4157-4502-b41b-e07e2582f919

   Realm docs test. Reply in this thread with one word: send or discard.

   Waiting for approval...
  ℹ  Socket Mode connected.
```

Notice `Socket Mode connected`. Realm is now listening. In Slack, the channel shows a message headed "Workflow gate waiting for approval", with the gate's name, your gate message, and the choices.

## 5. Answer in the thread

In Slack, open the message's thread and reply with one of the choices:

```text
send
```

Realm replies in the thread with the line you set in `resolution_messages`:

```text
Recorded: send.
```

In the terminal, the run carries on:

```text
→ [auto] send
  ✓ → completed

Run complete: 71b0ed55-f198-41b1-a6e2-e9234b1fab1c
```

Two rules about replies:

- **The reply must be in the thread.** A new message in the channel is ignored.
- **The reply must be exactly one of the choices.** Capital letters do not matter, so `Send` works. `yes` or `looks good, send it` do not. For a reply that matches no choice, Realm answers in the thread with `Please reply with one of: send, discard`, at most twice.

## What is recorded

The run record keeps the choice. It does not keep who replied. Anyone who can post in the channel can answer a gate, so post gates to a channel whose members you trust to decide.

## Reminders

If nobody answers, Realm posts a reminder in the thread after 10 minutes and an escalation after 30. Change either under the same `config` block, in milliseconds:

```yaml
reminder_interval_ms: 300000
escalation_threshold_ms: 900000
```

These timers live in the `realm agent` process. If that process stops, the reminders stop.

## The command line still works

Every Slack gate can also be answered with `realm run respond`. The Slack message includes the command for each choice. `realm agent` notices the answer and carries on, whichever way it arrived.

## Other ways to connect

- **Post only.** Leave out `app_token`. Realm posts the gate to Slack and prints that it is using the terminal: the answer has to come from `realm run respond`. With only `webhook_url` set, Realm posts through a Slack incoming webhook in the same one-way manner.
- **Events API.** Set `signing_secret` and `events_port` in place of `app_token`. Slack then sends replies to an address you expose, and Realm checks each request's signature. Use this only if you cannot use Socket Mode. `app_token` and `signing_secret` cannot be set together.

## If you see something else

- **`Error: realm agent requires an LLM API key. Set OPENAI_API_KEY or ANTHROPIC_API_KEY.`** `realm agent` needs a model provider key to start, even for a workflow whose steps need no model. Set one of the two variables.
- **`Workflow not found: slack-test — most often this run was created from a file without --register.`** You answered with `realm run respond`, but the workflow was started from a file and never registered. Run `realm workflow register ./`, then answer again.
- **The gate message appears in Slack, but a reply does nothing.** Check that the reply is in the thread, that it is exactly one of the choices, and that the app's Event Subscriptions include `message.channels`.

## See also

- [Deployment manifest (`realm.yaml`)](../reference/deployment-manifest.md) lists every `slack_gate` setting.
- [Gates reference](../reference/workflow/gates.md) covers reminders written into the workflow itself.
- [Human gates and trust levels](../concepts/gates-and-trust.md) explains who can answer a gate.
