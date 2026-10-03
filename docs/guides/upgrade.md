# Upgrade Realm

This guide takes an installation from one Realm version to a newer one without surprises. You read what changed, upgrade every Realm package together, and check the workflows and runs you already have against the new version. The outputs on this page are from a real upgrade from 0.43.0 to 0.45.0.

## What an upgrade can change

Realm's version starts with 0, and a release such as 0.44.0 may change behaviour that 0.43.0 had. Three things are worth knowing before you start:

- **Workflows you registered keep working as they were.** A new version often checks workflow files more strictly. Those checks apply when a workflow is loaded from its file. A copy that is already registered is not checked again until you register it again.
- **Runs carry over.** Runs started on the old version can be listed, inspected and continued on the new one.
- **All Realm packages must be the same version.** There are four: `@sensigo/realm`, `@sensigo/realm-cli`, `@sensigo/realm-mcp` and `@sensigo/realm-testing`.

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

In a project that lists Realm packages in its `package.json`, give every one of them the same exact version, the version of the `realm` command you just installed (0.45.0 in this example):

```bash
npm install --save-exact @sensigo/realm@0.45.0 @sensigo/realm-cli@0.45.0
```

Then check that only one version is installed:

```bash
npm ls @sensigo/realm
```

It prints one version, with the other entries marked `deduped`. That version must be the one `realm --version` prints: a `realm` command installed for the whole machine does not appear in `npm ls`.

```text
├─┬ @sensigo/realm-cli@0.45.0
│ ├─┬ @sensigo/realm-mcp@0.45.0
│ │ └── @sensigo/realm@0.45.0 deduped
│ ├─┬ @sensigo/realm-testing@0.45.0
│ │ └── @sensigo/realm@0.45.0 deduped
│ └── @sensigo/realm@0.45.0 deduped
└── @sensigo/realm@0.45.0
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

After version 0.45.0 the command also says why. Run with a `realm` command built after 0.45.0 against a project still on 0.43.0, a retryable handler printed the warning first and then failed its step after one attempt, with a note saying what was not used and the way out (over MCP the reply carries `ENGINE_HANDLER_FAILED`):

```text
⚠ Your project's @sensigo/realm is 0.43.0 (/srv/shop/node_modules/@sensigo/realm, installed by the project); this realm command runs @sensigo/realm 0.45.0. Realm objects do not cross versions: a WorkflowError your handlers or adapters throw is not recognised — its step fails after one attempt, without that error's own code and retry setting. Install @sensigo/realm@0.45.0 (and every other @sensigo package the project has, at 0.45.0) in the project your code imports it from, or, when you run the realm command, run version 0.43.0 there: npm install --save-dev @sensigo/realm-cli@0.43.0, then npx realm.
…
✗ Step 'only' failed: Handler 'flaky' threw: rate limited — it looks like realm's WorkflowError by its class name but carries no release mark: an older realm copy that does not mark its classes, or another library's class of the same name. If it is realm's, its code 'SERVICE_RATE_LIMITED' and its retry setting were not used: install @sensigo/realm@0.45.0 (and every other @sensigo package the project has, at 0.45.0) in the project your code imports it from, or, when you run the realm command, run the version the project has: npm install --save-dev @sensigo/realm-cli@<that version>, then npx realm (npm ls @sensigo/realm shows that version).
```

With both copies at a version that carries the release mark, the message names both versions and both folders; the step fails with that message; the reply of the call that ran the step (`start_run` or `execute_step` over MCP) carries the code `ENGINE_RELEASE_LINE_MISMATCH`, and the run record keeps the message only.

With both packages at 0.45.0, the same handler was retried and the run completed.

Two copies of the same version work together: an error or a provider made with one copy is recognised by the other. This was added after version 0.45.0. On 0.45.0, your code and the command must share one copy: run the project's own command with `npx realm`. A `realm` command installed for the whole machine is a second copy, and fails as above even at the same version.

## 3. Check the workflows you have registered

List them:

```bash
realm workflow list
```

It prints:

```text
ID      NAME                       VERSION  ORIGIN  SCHEMA
digest  Summarise a note           1        human   1 (current)
intake  Take in a support request  1        human   1 (current)

2 workflows registered.
```

Then ask the new version what it thinks of each registered copy:

```bash
realm workflow validate --registered digest
```

For a workflow the new version accepts, it prints:

```text
Auditing the registered copy of 'digest' (schema_version 1) with realm 0.45.0's loader.
Registered copies stay grandfathered at runtime against LOADER changes — this reports what re-registration today would say. …
Valid: digest v1 (1 step)
```

The command changes nothing. It reports what would happen if you registered the workflow again today.

## 4. See the new version find a problem

The `intake` workflow was written with a misspelt rule, `minlength` where JSON Schema says `minLength`. Version 0.43.0 said the file was valid. Version 0.45.0 does not:

```bash
realm workflow validate --registered intake
```

It prints, after the same two opening lines:

```text
Invalid workflow: Step 'summarise': 'input_schema' is refused by realm's validator — 'minlength' is not a JSON-Schema keyword ('minlength: 10' here), at "input_schema/properties/summary". Every execute_step submission to this step would be rejected with that error at run time; remove 'minlength', or write 'minLength' if that is what you meant.
```

The command exits with code 1, so a script can check every workflow and report the ones that need attention. This loop needs `jq`:

```bash
for id in $(realm workflow list --json | jq -r '.workflows[].id'); do
  realm workflow validate --registered "$id" > /dev/null 2>&1 || echo "needs attention: $id"
done
```

It prints:

```text
needs attention: intake
```

The registered copy still starts runs, on the new version as on the old. In this case the step could never be completed on either, because of the mistake. The upgrade did not break the workflow; it named a problem that was already there.

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
```

Registering again replaces the stored copy. Runs that are still open use the new copy from their next step. A run of `intake` that had been started on 0.43.0, and could not be completed there, completed on 0.45.0 once the corrected workflow was registered.

## 6. Check the runs

```bash
realm run list
```

Runs from before the upgrade are listed with the others. A run that was open on the old version can be continued on the new one in the usual way. See [Operate runs](operate-runs.md).

If your store holds runs that finished on a version before 0.39.0, give each its recorded ending. First see what would change:

```bash
realm run migrate --stamp-seals
```

On a store with nothing to do, it prints:

```text
Nothing would be stamped — every terminal run already carries its seal arm.
2 run(s) already stamped, and their arms agree with the record.
Residue: 0 terminal run(s) still without a recorded seal arm.
```

If it lists runs it would change, run it again with `--force`.

## 7. Restart what is running

A `realm serve` or `realm listen` process that was started before the upgrade is still the old version. Restart it. An assistant's client starts `realm mcp` itself, so restart the client or reconnect it.

## See also

- [Changelog](https://github.com/sensigo-hq/realm/blob/main/CHANGELOG.md)
- [`realm workflow` reference](../reference/cli/realm-workflow.md) covers `list` and `validate --registered`.
- [Deploy a project](deploy.md)
