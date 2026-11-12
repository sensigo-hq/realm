# Upgrade Realm

<!-- description: Upgrade Realm without surprises: read what changed, upgrade every Realm package together, and check your workflows and runs against the new version. -->

This guide takes an installation from one Realm version to a newer one without surprises. You read what changed, upgrade every Realm package together, and check the workflows and runs you already have against the new version. The outputs on this page are from a real upgrade from 0.48.0 to 0.49.0 on Node 22, except three blocks in step 2, kept as they were: the block that shows two versions in one project and the `ENGINE_HANDLER_FAILED` line, from an earlier upgrade from 0.43.0 to 0.45.0, and the two lines the 0.46.0 `realm` command printed for a project still on 0.43.0.

## What an upgrade can change

Realm's version starts with 0, and a release such as 0.44.0 may change behaviour that 0.43.0 had. Three things are worth knowing before you start:

- **Workflows you registered keep working as they were, with one exception.** A new version often checks workflow files more strictly. Those checks apply when a workflow is loaded from its file. A copy that is already registered is not checked again until you register it again. The exception is the version after 0.48.0: it does not carry registered copies over, so after the move you register each workflow from its file (the first section, step 4), and the new version's checks apply then.
- **Runs carry over, with one exception.** Runs started on the old version can be listed, inspected and continued on the new one. The exception is the version after 0.48.0, which keeps runs in one SQLite file instead of JSON files: its first command on an old home refuses to run until you move the old folders out and import the runs. Do [the first section](#move-your-runs-into-the-sqlite-store) before anything else.
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

In a project that lists Realm packages in its `package.json`, give every one of them the same exact version, the version of the `realm` command you just installed (0.49.0 in this example):

```bash
npm install --save-exact @sensigo/realm@0.49.0 @sensigo/realm-cli@0.49.0
```

Then check that only one version is installed:

```bash
npm ls @sensigo/realm
```

It prints one version, with the other entries marked `deduped`. That version must be the one `realm --version` prints: a `realm` command installed for the whole machine does not appear in `npm ls`.

```text
├─┬ @sensigo/realm-cli@0.49.0
│ ├─┬ @sensigo/realm-mcp@0.49.0
│ │ └── @sensigo/realm@0.49.0 deduped
│ ├─┬ @sensigo/realm-store-sqlite@0.49.0
│ │ └── @sensigo/realm@0.49.0 deduped
│ ├─┬ @sensigo/realm-testing@0.49.0
│ │ └── @sensigo/realm@0.49.0 deduped
│ └── @sensigo/realm@0.49.0 deduped
└── @sensigo/realm@0.49.0
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
Auditing the registered copy of 'digest' (schema_version 1) with realm 0.49.0's loader.
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
