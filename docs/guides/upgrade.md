# Upgrade Realm

<!-- description: Upgrade Realm without surprises: read what changed, upgrade every Realm package together, and check your workflows and runs against the new version. -->

This guide takes an installation from one Realm version to a newer one without surprises. You read what changed, upgrade every Realm package together, and check the workflows and runs you already have against the new version. The outputs on this page are from a real upgrade from 0.49.0 to 0.50.0 on Node 22, except three blocks in step 2, kept as they were: the block that shows two versions in one project and the `ENGINE_HANDLER_FAILED` line, from an earlier upgrade from 0.43.0 to 0.45.0, and the two lines the 0.46.0 `realm` command printed for a project still on 0.43.0. The blocks in [A store version change](#a-store-version-change) and [Going back without losing runs](#going-back-without-losing-runs) are from the published 0.50.0, run on a home that the published 0.49.0 wrote.

## What an upgrade can change

Realm's version starts with 0, and a release such as 0.44.0 may change behaviour that 0.43.0 had. Four things are worth knowing before you start:

- **Workflows you registered keep working as they were, with two exceptions.** A new version often checks workflow files more strictly. Those checks apply when a workflow is loaded from its file. A copy that is already registered is not checked again until you register it again. The first is the version after 0.48.0: it does not carry registered copies over, so after the move you register each workflow from its file (the first section, step 4), and the new version's checks apply then. The second is the version after 0.49.0: in Slack, a registered gate whose `owner` is not a Slack member ID can no longer be answered in its thread (see [In Slack, only the people a question names can answer](#in-slack-only-the-people-a-question-names-can-answer)).
- **Runs carry over, with one exception.** Runs started on the old version can be listed, inspected and continued on the new one. The exception is the version after 0.48.0, which keeps runs in one SQLite file instead of JSON files: its first command on an old home refuses to run until you move the old folders out and import the runs. Do [the first section](#move-your-runs-into-the-sqlite-store) before anything else.
- **A home of 0.49.0 needs one command, from the version after 0.49.0.** Its store file moves to format version 2, and every command that opens the store, except `realm db check`, `realm db backup`, `realm db migrate` and `realm db restore`, refuses the home with one line until you run `realm db migrate` with Realm stopped. See [A store version change](#a-store-version-change).
- **All Realm packages must be the same version.** There are five: `@sensigo/realm`, `@sensigo/realm-cli`, `@sensigo/realm-mcp`, `@sensigo/realm-testing` and, from the version after 0.48.0, `@sensigo/realm-store-sqlite`, which `@sensigo/realm-cli` and `@sensigo/realm-mcp` install for you.

## Move your runs into the SQLite store

From the version after 0.48.0, every `realm` command and the `realm-mcp` server keep their data in one SQLite file, `realm.db`, in the Realm home (`~/.realm`), and need Node 22.22.3 or a later 22.x release, or Node 24.15.0 or later. Earlier versions kept JSON files in four folders there: `runs`, `workflows`, `replays` and `dedup`. The new version does not read them. Its first command on such a home prints one line, creates nothing and exits with code 1:

```text
Error: This Realm keeps its store in realm.db and does not read the old JSON directories (runs, workflows) in /home/dana/.realm. Move them out of the home, then import what you want to keep with `save()` or `realm run import`.
```

The names in the parentheses are the folders it found. When the output goes to a file or a pipe, the home folder's name in this line and in the import's lines is hidden, as in every other output; a terminal shows it.

Do this, in this order:

1. **Stop every Realm process that uses the home**: `realm listen`, `realm serve`, `realm mcp` or `realm-mcp` (restart the assistant's client afterwards) and any `realm agent` that is running.
2. **Upgrade the packages** (step 2 below).
3. **Move the four folders out of the home — do not delete them yet.** For example `mkdir ~/realm-old && mv ~/.realm/runs ~/.realm/workflows ~/.realm/replays ~/.realm/dedup ~/realm-old/`, for those that exist.
4. **Register your workflows again from their source files**, `realm workflow register <path>` for each. The registry is not carried over: the new store registers a workflow from its file. Do it before importing, so that a run you then inspect or continue finds its workflow.
5. **Import the runs**: `realm run import ~/realm-old/runs`. One line per file, then one line that counts them, then one that counts the folder's other entries (the `keys` folder, the `.attempts.jsonl` and trace files) as ignored:

   ```text
   imported  /home/dana/realm-old/runs/8372be7d-ef0f-489b-98cf-cb87faa5efac.json
   imported  /home/dana/realm-old/runs/e8e798ce-144e-4c8a-ae98-92ca9585bc14.json
   2 files: 2 imported.
   Ignored 2 entries that are not .json files.
   ```

6. **Check** with `realm run list`: the imported runs are listed with any new ones.

   ```text
   8372be7d-ef0f-489b-98cf-cb87faa5efac  tidy-notes v1  running  2026-10-20T09:01:00.000Z  0 step(s)
   e8e798ce-144e-4c8a-ae98-92ca9585bc14  tidy-notes v1  running  2026-10-20T09:00:00.000Z  0 step(s)
   ```

7. Once every line read `imported` or `unchanged`, you may delete the moved folders. Running the import again is safe: the runs it imported read `unchanged`.

**What is not carried over** stays in the moved folders:

- The import reads the files and moves none of them: the records stay in the moved folder until you delete it. Not imported from it: a run's refused answers (the old `<id>.attempts.jsonl` files), its trace buffer and sealed traces (the old `trace-buffer-…` and `sealed-trace-…` `.jsonl` files) and the `keys` folder (the store works out which run holds a key from the runs themselves). From an export bundle, its failed attempts, trace buffer and sealed traces are not imported either (the line's notes `attempts_not_imported`, `wal_not_imported`, `sealed_not_imported`).
- The registered workflows (`workflows/`): register each again from its source (step 4).
- Saved replays (`replays/`), and `realm listen`'s duplicate-webhook marks (`dedup/`). A delivery whose event id belongs to an imported run still starts nothing: the id is that run's idempotency key.
- A run whose idempotency key a live run already holds reads `diverged`, and its line names that run; the stored run is kept.

## A store version change

From the version after 0.49.0, the store file `realm.db` is at format version 2, which adds `outbound`, a per-run table where `realm agent` records the Slack reminders and escalation it sends. A home that 0.49.0 used is at version 1. Every command that opens the store, except `realm db check`, `realm db backup`, `realm db migrate` and `realm db restore`, refuses it with one line, creates nothing and exits with code 1:

```text
Error: This store's file is at schema version 1; this Realm writes version 2. Run `realm db migrate` with Realm stopped to upgrade it.
```

Do this, in this order:

1. **Stop every Realm process that uses the home**: `realm listen`, `realm agent`, `realm serve` and every MCP server (`realm mcp`, `realm-mcp`), supervised ones too. A 0.49 process still running when the file is migrated cannot use the store afterwards: its next call fails and records nothing. A command prints `This store was migrated by a newer Realm: its schema is version 2 and this Realm writes version 1. Upgrade Realm to read or write it.`; an assistant connected through `realm mcp` may be told only to try again. `realm db migrate`, when a schema step is pending, refuses to run while any process still has the store file open, and changes nothing, so stop them first.
2. **Upgrade the packages** (section 2 below, "Upgrade every package together").
3. **Migrate**: `realm db migrate`. It copies the store first, into the backups folder beside the home (`~/.realm-backups/`), then runs the step in one transaction, re-checks every evidence entry's hash and moves the file to version 2, and records the migrate in `~/.realm-backups/migrations.jsonl`; when the copy or the step fails, it stops and leaves the file at version 1, as it was; when only the record cannot be written, the file is migrated and a warning on standard error says so. `--backup <path>` puts the copy at a path you name instead, outside the home; `--no-backup` makes none. On a sample home that 0.49.0 wrote, holding two finished runs and six evidence entries:

   ```text
   Backed up [REDACTED]/.realm/realm.db (schema version 1, 638976 bytes) to [REDACTED]/.realm-backups/realm-v1-to-v2-20261117T193757Z.db; the copy passes SQLite's quick check.
   Migrated [REDACTED]/.realm/realm.db from schema version 1 to 2: 1 statement(s) ran, the schema matches version 2's, 6 evidence entries match their stored hashes.
   Recorded this migrate in [REDACTED]/.realm-backups/migrations.jsonl.
   Re-stamped the phase index of 0 run(s) with the current derivation.
   ```

   The last line is printed by every migrate that finishes; 0 means that no run's stored phase needed re-stamping.

4. **Check** with `realm db check`: its second line reads `No problems found by the checks that ran.`
5. **Start the processes again.**

If the migrate stops with an error, the file is still at version 1 with nothing of the step in it, and the backup it made first is where its first line says. Run the command again once the cause is fixed: each copy in the backups folder is named by the second it was made. With `--backup <path>`, the command never replaces a file, so give a new path when you run it again. The error names the cause: an evidence entry that no longer matches its stored hash means a stored run was changed outside Realm, and the step cannot run until that is fixed (restore the file from an earlier backup of your own), then run the command again.

A home the new version creates, or that `realm run import` fills, is created at version 2 and needs no migrate. An older Realm refuses a version-2 file with the line quoted in step 1, exits with code 1 and changes nothing. To go back, run `realm db restore <backup>` with this Realm first, then reinstall the older Realm: writes made after the backup are not in the restored file, but are in the copy the command keeps of the file it replaced. A file that is already migrated can instead be stepped back without losing a run: `realm db migrate --to 1` (see [Going back without losing runs](#going-back-without-losing-runs)). See [`realm db restore`](../reference/cli/realm-db.md#restore).

## Going back without losing runs

To use an older Realm again and keep every run this one stored, step the store file back before you install the older Realm:

1. **Stop every Realm process that uses the home**, as for an upgrade.
2. **Step back**, with this Realm still installed: `realm db migrate --to 1` takes a file at version 2 back to version 1, the version 0.49.0 writes. It makes a backup first, as a forward migrate does, keeps every run, records the step back in `~/.realm-backups/migrations.jsonl`, and prints the command that installs a Realm that writes version 1. On the sample home above, after its migrate:

   ```text
   Backed up [REDACTED]/.realm/realm.db (schema version 2, 655360 bytes) to [REDACTED]/.realm-backups/realm-v2-to-v1-20261117T193806Z.db; the copy passes SQLite's quick check.
   Stepped [REDACTED]/.realm/realm.db back from schema version 2 to 1: 1 statement(s) ran, the schema matches version 1's. The outbound table was dropped; it held no record of a reminder or escalation sent.
   Recorded this migrate in [REDACTED]/.realm-backups/migrations.jsonl.
   Every command of this Realm that uses the store, except `realm db check`, `realm db backup`, `realm db migrate` and `realm db restore`, now refuses the file, because it is at schema version 1 and this Realm writes version 2. To use it, install a Realm that writes schema version 1: npm install -g "@sensigo/realm-cli@0.49" (in a project that lists Realm packages, give every one of them the same exact version within 0.49; see "Upgrade every package together" in the upgrade guide).
   ```

3. **Install that Realm**, and give every Realm package in a project the same exact version (section 2 below).
4. **Start the processes again.**

`realm rollback` finds the version for you: in step 2, run it instead of `realm db migrate --to 1`. It reads the last migrate recorded for this home in `~/.realm-backups/migrations.jsonl` and steps the store file back to the version before it, the same way. A home that no migrate of Realm 0.50.0 or later has touched (one created at version 2, or one whose record was deleted) has no record: there, `realm db migrate --to 1` is the way. See [`realm rollback`](../reference/cli/realm-db.md#realm-rollback).

Version 2's step back drops the `outbound` table, the record of the Slack reminders and escalations `realm agent` or `realm listen --send-reminders` sent; its line says how many were recorded as sent. Without that record, an agent that restarts may send a reminder or an escalation again, as 0.49.0's agents could. When a step cannot be undone, `realm db migrate --to` refuses and changes nothing; restore a backup made before the upgrade instead, with `realm db restore <backup>`. See [`realm db migrate`](../reference/cli/realm-db.md#migrate).

## The agent no longer answers gates by default

From the version after 0.49.0, the agent no longer answers gates by default in an app without forms, through `realm serve`, or through a program that builds its server per HTTP request or passes `statelessHttp`. If an agent answered gates for you there, start the server with `--gate-answers permitted` (`REALM_MCP_GATE_ANSWERS=permitted` for `realm-mcp`; `gateAnswers: 'permitted'` in a program that embeds Realm). The tool the agent then gets no longer asks the app to have you approve each call, as the old default's tool did. Code that reads `offered` from `GATE_ANSWERS_VALUES`, `GateAnswers`, `AnswersRow` or the `realm/gate_answers` capability reads `permitted` now. See [Gate answers over MCP](../reference/mcp/gate-answers.md).

## In Slack, only the people a question names can answer

From the version after 0.49.0, when a gate has an `owner` or the new `answerers`, a reply in its Slack thread counts only when it comes from one of them, by Slack member ID. A question whose `owner` is a handle such as `@ana`, a user group or `@here`, and that lists no `answerers`, can no longer be answered in Slack. When Realm listens in the thread, its post says `Replies in this thread are not counted`. A question already open when you upgrade follows the same rule.

Do this, in this order:

1. **Before you upgrade, answer or finish the open Slack questions that have such an owner.** After the upgrade, answer them with `realm run respond <run-id> --gate <gate-id> --choice <choice>`.
2. **Find the gates.** When the project's `realm.yaml` has a Slack notifier that reads replies (`bot_token` and `channel_id`, with `app_token` or `signing_secret`), `realm workflow validate` on each file, or `realm workflow validate --registered <id>` on each stored workflow, names each such gate. `validate --strict` and `register --strict` fail on one.
3. **Write who may answer.** Write the person's member ID (`U…`), list member IDs in `answerers`, or remove `owner` so that the project's `answerers`, or without them anyone in the thread, can answer. Then register the workflow again.

## 1. Read what changed

Note the version you have:

```bash
realm --version
```

Then open the [changelog](https://github.com/sensigo-hq/realm/blob/main/CHANGELOG.md) and read the entry of every version after yours, up to the one you are moving to. A version that changes existing behaviour has an **Upgrading** section, which lists the changes marked `BREAKING`, what they affect, and what to do about each.

## 2. Upgrade every package together

For the command installed for the whole machine:

```bash
npm install -g @sensigo/realm-cli@latest
```

In a project that lists Realm packages in its `package.json`, give every one of them the same exact version, the version of the `realm` command you just installed (0.50.0 in this example):

```bash
npm install --save-exact @sensigo/realm@0.50.0 @sensigo/realm-cli@0.50.0
```

Then check that only one version is installed:

```bash
npm ls @sensigo/realm
```

It prints one version, with the other entries marked `deduped`. That version must be the one `realm --version` prints: a `realm` command installed for the whole machine does not appear in `npm ls`.

```text
├─┬ @sensigo/realm-cli@0.50.0
│ ├─┬ @sensigo/realm-mcp@0.50.0
│ │ └── @sensigo/realm@0.50.0 deduped
│ ├─┬ @sensigo/realm-store-sqlite@0.50.0
│ │ └── @sensigo/realm@0.50.0 deduped
│ ├─┬ @sensigo/realm-testing@0.50.0
│ │ └── @sensigo/realm@0.50.0 deduped
│ └── @sensigo/realm@0.50.0 deduped
└── @sensigo/realm@0.50.0
```

If you see two versions here, your code and the project's `@sensigo/realm-cli` are using two different versions of Realm:

```text
├─┬ @sensigo/realm-cli@0.45.0
│ └── @sensigo/realm@0.45.0
└── @sensigo/realm@0.43.0
```

This breaks things quietly. With the two versions above, a handler that threw a retryable error, as shown in [Handle failure](handle-failure.md#retry-a-step), was not retried. The run failed on the first attempt:

```text
ENGINE_HANDLER_FAILED: Handler 'fetch_record' threw: upstream returned 503
```

From version 0.46.0 the command also says why. Run with the 0.46.0 `realm` command against a project still on 0.43.0, a retryable handler printed the warning first and then failed its step after one attempt, with a note saying what was not used and the way out (over MCP the reply carries `ENGINE_HANDLER_FAILED`). Version 0.43.0 marks none of its classes, so the note is the one for a copy with no release mark:

```text
⚠ Your project's @sensigo/realm is 0.43.0 (/srv/shop/node_modules/@sensigo/realm, installed by the project); this realm command runs @sensigo/realm 0.46.0. Realm objects do not cross versions: a WorkflowError your handlers or adapters throw is not recognised — its step fails after one attempt, without that error's own code and retry setting. Install @sensigo/realm@0.46.0 (and every other @sensigo package the project has, at 0.46.0) in the project your code imports it from, or, when you run the realm command, run version 0.43.0 there: 'npm install --save-dev @sensigo/realm-cli@0.43.0', then 'npx realm'.
…
✗ Step 'only' failed: Handler 'flaky' threw a WorkflowError — it looks like realm's WorkflowError by its class name but carries no release mark: an older realm copy that does not mark its classes, or another library's class of the same name. If it is realm's, its code 'SERVICE_RATE_LIMITED' and its retry setting were not used: install @sensigo/realm@0.46.0 (and every other @sensigo package the project has, at 0.46.0) in the project your code imports it from, or, when you run the realm command, run the version the project has: 'npm install --save-dev @sensigo/realm-cli@<that version>', then 'npx realm' (npm ls @sensigo/realm shows that version). Its message: rate limited
```

With both copies at a version that carries the release mark, the message names both versions and both folders; the step fails with that message; the reply of the call that ran the step (`start_run` or `execute_step` over MCP) carries the code `ENGINE_RELEASE_LINE_MISMATCH`, and the run record keeps the message only.

With both packages at 0.45.0, the same handler was retried and the run completed.

Two copies of the same version work together: an error or a provider made with one copy is recognised by the other. This was added in 0.46.0. On 0.45.0, your code and the command must share one copy: run the project's own command with `npx realm`. A `realm` command installed for the whole machine is a second copy: even at the same version, a retryable handler fails on its first attempt, as in the output above that begins `ENGINE_HANDLER_FAILED: Handler 'fetch_record' threw`.

## 3. Check the workflows you have registered

List them:

```bash
realm workflow list
```

It prints:

```text
ID          NAME              VERSION  ORIGIN  SCHEMA
digest      Summarise a note  1        human   1 (current)
tidy-notes  Tidy notes        1        human   1 (current)

2 workflows registered.
```

These are the workflows you registered again when you moved your runs. `intake` is not there, for the reason in the next section.

Then ask the new version what it thinks of each registered copy:

```bash
realm workflow validate --registered digest
```

For a workflow the new version accepts, it prints:

```text
Auditing the registered copy of 'digest' (schema_version 1) with realm 0.50.0's loader.
Registered copies stay grandfathered at runtime against LOADER changes — the checks run today's loader on the copy, as registering the unchanged workflow again would; the cache lines size the copy as stored. A NEW engine-side dispatch check (issue #508, realm 0.42.0) is NOT grandfathered: it applies immediately, whatever schema_version is on file.
Valid: digest v1 (1 step)
cache: summarise — anthropic 570 chars ≈ 334–758 tokens, with Anthropic's tool text · openai 313 chars ≈ 63–125 tokens (estimates: 2.5–5 chars/token, with margin)
anthropic: when realm agent or realm listen drives a step, realm marks its fixed part for caching, and on steps with tools the conversation at each turn, unless --prompt-cache turns it off; below the model's minimum nothing is cached, silently
openai: on OpenAI's own address realm sends a cache key and, for GPT-5.6 and later, marks the fixed instructions and the stable start of the prompt of each step without tools for 30 minutes, unless --prompt-cache turns it off; otherwise the provider's own rules decide — see https://developers.openai.com/api/docs/guides/prompt-caching (as of 2026-10-16)
anthropic: the cache is kept per workspace (per organization on Bedrock and Google Cloud), as Anthropic's page said on 2026-10-09: drives from different workspaces each pay the write
```

The command changes nothing. Its checks run the new version's loader on the registered copy, as registering the unchanged workflow again would. From the version after 0.48.0 it also prints a cache line for each agent step, sized from the copy as stored, profile text included, not from the files now in the folder (see [the cache lines](../reference/cli/realm-workflow.md#the-cache-lines)).

## 4. See the new version find a problem

The `intake` workflow was written with a misspelt rule, `minlength` where JSON Schema says `minLength`. Versions before 0.44.0 registered the file without complaint. Every version from 0.44.0 refuses it, so registering it again after the move stops there:

```bash
realm workflow register intake
```

It prints one line and exits with code 1, and nothing is stored:

```text
Invalid workflow: Step 'summarise': 'input_schema' is refused by realm's validator — 'minlength' is not a JSON-Schema keyword ('minlength: 10' here), at "input_schema/properties/summary". Every execute_step submission to this step would be rejected with that error at run time; remove 'minlength', or write 'minLength' if that is what you meant. (line 15)
```

To find every workflow that needs attention before you register it, check the source folders. `realm workflow validate <folder>` checks a folder without registering it and exits with code 1 when it finds a problem. Run this loop in the folder that holds your workflows' folders:

```bash
for dir in */; do
  realm workflow validate "$dir" > /dev/null 2>&1 || echo "needs attention: ${dir%/}"
done
```

It prints:

```text
needs attention: intake
```

On a later upgrade the registered copies carry over, so check those instead: `realm workflow validate --registered <id>` for each ID that `realm workflow list --json` lists.

A copy that is already registered is not checked again until you register it again. So a copy registered before 0.44.0 went unchecked through every upgrade since, and started runs whose step could never be completed. The move registers each workflow from its file, so the problem shows now. The upgrade did not break the workflow; it named a problem that was already there.

## 5. Fix, and register again

Correct the workflow file, then:

```bash
realm workflow register intake
realm workflow validate --registered intake
```

They print:

```text
Registered: intake v1 (1 step)
…
Valid: intake v1 (1 step)
…
```

Registering again replaces the stored copy. Runs that are still open use the new copy from their next step. Then one run of `intake`, started after the fix, completed over the MCP server, `realm mcp`: `start_run`, then `execute_step` with a summary of ten characters or more.

## 6. Check the runs

```bash
realm run list
```

Runs from before the upgrade are listed with the others. Runs from a home of 0.48.0 or earlier appear here once you have imported them (the first section). A run that was open on the old version can be continued on the new one in the usual way. See [Operate runs](operate-runs.md).

If your store holds runs that finished on a version before 0.39.0, give each its recorded ending. First see what would change:

```bash
realm run migrate --stamp-seals
```

On a store with nothing to do, it prints:

```text
Nothing would be stamped — every terminal run already carries its seal arm.
1 run(s) already stamped, and their arms agree with the record.
Residue: 0 terminal run(s) still without a recorded seal arm.
```

If it lists runs it would change, run it again with `--force`.

From the version after 0.47.1, what Realm prints is masked for who reads it: an agent, a log and an export hide every environment value of 8 or more characters (see [What the output hides](operate-runs.md#what-the-output-hides)). Name the ordinary variables you want to see in `REALM_NOT_SECRET`, or in a manifest's `disclosure.not_secret`. Adding `disclosure:` to `realm.yaml` does not make earlier runs refuse `realm run export`: only removing a secret a run referred to does, or, for a run made by this version, changing the manifest's `secrets` block (a run made by 0.47.1 or earlier is judged by its secret names alone; see [Deployment manifest](../reference/deployment-manifest.md#what-a-run-records)).

## 7. Restart what is running

A `realm serve` or `realm listen` process that was started before the upgrade is still the old version. Restart it. An assistant's client starts `realm mcp` itself, so restart the client or reconnect it.

## See also

- [Changelog](https://github.com/sensigo-hq/realm/blob/main/CHANGELOG.md)
- [`realm workflow` reference](../reference/cli/realm-workflow.md) covers `list` and `validate --registered`.
- [Deploy a project](deploy.md)
