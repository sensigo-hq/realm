# Compatibility: what a release keeps, how a change is announced, and the road to 1.0

<!-- description: What a Realm release keeps working, how a change is announced, the record so far, and what comes before 1.0. -->

Realm's version starts with 0. From 0.50.0 on, every change to Realm follows one rule, in this order: keep what works working; where that cannot be done, give a migration guide and a tool that does the work; release a change that breaks what works only as a last resort, and then still with an easy way across; and for the odd case that neither covers, a specific remedy. This page says what that rule covers today, how a change reaches you, what has happened so far, and what is still to come before 1.0.

## What a release keeps

Two kinds of thing are outside Realm and depend on it: what you write and store (workflow files, the project file `realm.yaml`, registered workflows, the runs in `realm.db`, export files, the environment names Realm reads and the files under its home folder) and what you call (the CLI's commands, flags and exit codes; the MCP tools and the fields of their replies; `realm listen`'s addresses and reply fields; the store interface and its test kit; the library's exported names).

From 0.50.0 on, a change to any of these follows the rule above. Two things may still change in a minor release and are announced when they do: the exact wording of lines meant for a person to read (the CLI's human text, the `Disclosure:` line, the Slack post's text, the sentences the MCP replies carry for an assistant), and the library's exported names beyond the ones the [core library page](core-library.md) documents. A script should read machine output where a command offers it (`--json`) and match a human line only when it has to; where it has to, the changelog names every change to such a line.

Stored data has its own guard. `realm.db` carries a format version. `realm db migrate` upgrades a file written by an older Realm, after a backup; an older Realm refuses a file written by a newer one with one line that says so, and changes nothing. A registered workflow keeps running as it was registered until you register it again; a new release's stricter checks apply at that registration, not before, except where the changelog says otherwise (once so far, 0.42.0's `trust` check).

## How a change reaches you

A change to what a file may contain or means, to a command, a flag, an exit code, a reply field, an address, a store-interface member or an exported name ships in a minor release (0.x.0), never in a patch release, and the changelog's **Upgrading** section names it and what to write instead. From 0.50.0 on, a command, a flag or a key that is removed keeps answering for one more minor release with what replaced it, instead of failing as unknown; the changelog names the release it goes away in.

## The record so far

Sixty releases, 0.1.0 (2026-06-01) to 0.49.0 (2026-11-11); eleven of them patch releases, none of which changed any of the above. What a correct workflow file does or may contain changed fifteen times, in six releases; eleven of the fifteen refused a file that was already wrong, each with a message saying what to write instead; one key was removed (0.14.0, `services.auth.token_from`; a file that still has it is refused with a message that says so). The library's exported names and the MCP replies' fields changed more often; the units below are what makes them easy to keep from here. These numbers are refreshed at each release.

## The road to 1.0

Before 1.0, each of these lands as its own change, in this order, so that keeping compatibility is a property of the code and its tests rather than of care: a place for deprecation warnings (the error output, once per message, so a script that reads the main output never sees one); a committed inventory of the CLI's commands, flags and exit codes, the environment names and `realm listen`'s reply fields, checked by a test; a corpus of each published release's stored shapes (export files, run records, workflow files) that every later release must still read, generated from the published packages at each release; a promised list of the library's exported names, with the rest kept for one release and marked deprecated; the run state's published schema; a published schema of the workflow file derived from the loader itself, and tightenings that apply to newly registered copies only; `--json` output with a format version on the `realm run` commands scripts read; a format field on the run record; a stated reading window for export files; and the store test kit's laws frozen per release for anyone who implements a store. Then 1.0 comes with its own written promise for the 1.x series.
