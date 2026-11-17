# `realm db`

<!-- description: Reference for realm db backup, which copies the store file to a new file and checks the copy, realm db migrate, which upgrades the store file after a backup, realm db check, which reports on the store file without writing it, and realm db restore, which puts a backup in place of the store file and keeps the file it replaces: their arguments, output and exit codes. -->

`realm db` acts on the store file, `realm.db` in the Realm home (`~/.realm`), never on a run. It has four subcommands.

| Subcommand            | What it does                                                               |
| --------------------- | -------------------------------------------------------------------------- |
| [`backup`](#backup)   | Copies the store file to a new file outside the home, and checks the copy. |
| [`migrate`](#migrate) | Upgrades the store file to this Realm's schema version, after a backup.    |
| [`check`](#check)     | Reports on the store file without writing it.                              |
| [`restore`](#restore) | Puts a backup in place of the store file, and keeps the file it replaces.  |

## `backup`

`realm db backup <path>`

Copies the store file to `<path>`, in four steps:

1. It refuses a `<path>` inside the Realm home, and a `<path>` where anything already exists, a file or a link: Realm never replaces a file. It refuses a home with no store file, or an empty one.
2. It creates a temporary file beside `<path>`, readable and writable by your account only (mode 600; on Linux and macOS), so the copy is never readable by others. SQLite copies the whole store into it in one step (`VACUUM INTO`).
3. It sets the copy to the journal mode Realm needs (WAL), so that Realm can open it, checks it with SQLite's quick check (`PRAGMA quick_check`), and flushes it to the disk.
4. It publishes the copy under `<path>` with a hard link, which cannot replace a file that is there; where the filesystem has no hard links (FAT, exFAT, some network filesystems), it looks at `<path>` once more and moves the copy in. Then it flushes the folder, so that the copy and its name survive a crash.

Realm writes nothing of its own to the store file. SQLite may first replay a write-ahead log that a crashed Realm left beside it, as any open of the store does. Realm may also create its four small read-only fence files in the home (`runs`, `dedup`, `replays` and `workflows`) if they are missing.

```bash
realm db backup ./realm-backup.db
```

It prints one line, with the store's schema version and the copy's size:

`Backed up <home>/realm.db (schema version <n>, <bytes> bytes) to <path>; the copy passes SQLite's quick check.`

A run that printed this line published its copy. A run that was killed before it published leaves no file at `<path>`; it may leave files whose names begin `<path>.part-`, which you can delete.

The quick check judges the copy. A copy that passes was rebuilt from the pages SQLite could read. To look for damage in the store itself, run SQLite's quick check on the store file.

### Restoring a copy

[`realm db restore <backup>`](#restore) puts the copy back in place of a store file Realm can open and copy. Into a home with no store file, or an empty one, or over a store file Realm cannot open or cannot copy, restoring is done by hand for now. Stop every Realm process that uses the home. If the home folder does not exist, on a new machine for one, create it. Put the copy in place of `realm.db` in the home. Then remove `realm.db-wal` and `realm.db-shm` from the home if they are there: a stale write-ahead log beside a restored file corrupts it. Realm then opens the store as it was when the copy was made.

**Exit code:** 0 when the copy is made and passes the check. 1 when the command refuses, with one `Error:` line on standard error, nothing written at `<path>`, and in the home only what is said above:

- `<path>` is inside the home: `Cannot back up the store to <path>: it is inside the Realm home <home>. Write the copy outside the home.`
- something exists at `<path>`, or appeared there while the copy was made: `Cannot back up the store to <path>: a file already exists there. Realm never replaces a file; name a path where nothing exists.`
- `<path>` cannot be created, for one because its folder does not exist: `Cannot back up the store to <path>: <the system's reason>. Check the path.`
- the home has no store file: `There is no store file at <home>/realm.db to back up.`; an empty one: `<home>/realm.db holds no store yet: there is nothing to back up.`
- the store file cannot be opened (not a Realm store, damaged, or written by a newer Realm): the store's own message.
- SQLite cannot read a page of the store file while it copies it: `Cannot back up the store to <path>: SQLite could not read <home>/realm.db: <SQLite's message>. The store file may be damaged. Nothing was written at <path>.`
- the copy cannot be written, because the disk is full or the system or SQLite reports an error: `Cannot back up the store to <path>: the copy could not be written: <the reason>. Nothing was written at <path>.`
- the copy fails for another reason: `Cannot back up the store to <path>: <the reason>. Nothing was written at <path>.`

These refusals have the code [`STATE_STORE_BACKUP_REFUSED`](../error-codes.md). Two cases leave a copy at `<path>` and still exit 1. When the copy fails the quick check, [`STATE_STORE_BACKUP_UNVERIFIED`](../error-codes.md): `SQLite's quick check of the copy at <path> failed: <SQLite's first line>. The store file <home>/realm.db it was copied from may be damaged. The copy was kept at <path>.` The copy is kept, so that it can be looked at. When the copy was published but its folder could not be flushed, `STATE_STORE_BACKUP_REFUSED`: `Cannot back up the store to <path>: the copy was made and published, but its folder could not be flushed: <the reason>. Check the copy before you rely on it.`

## `migrate`

`realm db migrate`, `realm db migrate --backup <path>` or `realm db migrate --no-backup`; `realm db migrate --to <n>` to step back (below)

Upgrades the store file to the schema version this Realm writes. Stop every Realm process that uses the home first: the command refuses to run a schema step while any other process has the store file open.

The copy made first:

- no flag: when a schema step is pending, a copy in the backups folder beside the home, `~/.realm-backups/` for the home `~/.realm` (made owner-only when it is missing), named from the file's schema versions before and after and the UTC time, such as `realm-v1-to-v2-20261117T020531Z.db`. It is made by [`realm db backup`](#backup), with all of its rules.
- `--backup <path>`: the copy at that path instead, outside the home and where nothing exists yet.
- `--no-backup`: no copy. Use it when you already have one, or when you accept the risk.

The command works in this order:

1. When a schema step is pending, it makes sure that no other process has the store file open, and keeps it so until it is done: no other process can open the file meanwhile. When one has it open, even an idle one, the command refuses and changes nothing: no copy, no record, no backups folder. A Realm command started while the migrate runs waits about 5 seconds, then fails as busy; run it again afterwards. A second `realm db migrate` started meanwhile fails the same way at its open. If two are started at the same instant, both may be refused; nothing is changed, so run it again. With no step pending, the command takes no such hold.
2. Unless `--no-backup` is given, it makes the copy and prints `realm db backup`'s line. When the copy cannot be made, or fails SQLite's quick check, the command stops there: nothing is migrated. With no step pending, it makes no copy unless `--backup <path>` names one.
3. It runs each pending schema step in its own transaction. A step checks that the file's schema is then exactly that version's, and that every evidence entry still matches its stored hash, before it moves the file's version. It prints one line per step.
4. It stops at the first step that fails. The file is then at the last version it completed, and the line says which version that is. Run the command again once the cause is fixed: it continues from there.
5. It records the migrate: one line in `migrations.jsonl` in the backups folder, with the time, the home, the schema versions before and after, the copy's path (`null` with `--no-backup`) and the Realm version that ran it. The record stays beside the backups, never in the home, and goes there with `--backup <path>` or `--no-backup` too. A migrate that ran no step records nothing; one whose later step failed records the steps that were committed.
6. It re-stamps the phase index. Each run's phase is stored beside it, with a stamp of the code that worked it out. When an upgrade changes that code, the command works out each such run's phase again from its record and stores it with the current stamp, so that listings by phase use the index again. It changes no run record.

```bash
realm db migrate
```

It prints one line per step:

`Migrated <home>/realm.db from schema version <v> to <v+1>: <s> statement(s) ran, the schema matches version <v+1>'s, <e> evidence entries match their stored hashes.`

or, when the file is already at this Realm's version:

`<home>/realm.db is already at schema version <n>; no schema step to run.`

then, after the step lines, `Recorded this migrate in <backups folder>/migrations.jsonl.`, and then:

`Re-stamped the phase index of <k> run(s) with the current derivation.`

When the record cannot be written, the command prints `Could not record this migrate in <path>: <the system's reason>. The file is migrated; the record is only a note for going back.` on standard error instead of the `Recorded` line, and its exit code is unchanged.

**Exit code:** 0 when every step ran, or none was pending, and the re-stamp finished. 1 when the command refuses or a step fails, with one line on standard error — the flag refusal as written below, every other refusal as an `Error:` line:

- both flags: `Cannot combine --backup with --no-backup. Use one or the other.` Nothing is opened.
- the home has no store file: `There is no store file at <home>/realm.db to migrate.`; an empty one: `<home>/realm.db holds no store yet: there is nothing to migrate.` These have the code [`STATE_STORE_MIGRATE_REFUSED`](../error-codes.md); nothing is created or copied.
- the store file cannot be opened (not a Realm store, damaged, written by a newer Realm, or older than any version this Realm can upgrade): the store's own message. Nothing is copied or migrated.
- another process has the store file open while a step is pending, [`STATE_STORE_IN_USE`](../error-codes.md): `Another process has <home>/realm.db open (a Realm agent, server, MCP server or command, or another program such as a SQLite browser). Stop it and run this again. Nothing was changed.`
- with no flag, the backups folder cannot be made or written, [`STATE_STORE_MIGRATE_REFUSED`](../error-codes.md): `Cannot make the backups folder <folder>: <the system's reason>. Nothing was changed. Use --backup <path> to name another place, or --no-backup.`
- the copy cannot be made, or fails the quick check: `realm db backup`'s refusals, above.
- a step fails, [`STATE_STORE_MIGRATE_FAILED`](../error-codes.md): `The step from schema version <v> to <v+1> failed: <the reason>. <home>/realm.db is at schema version <v>; nothing of the step is in it. Run the command again once the cause is fixed.` When the file is found at a higher version after the failure, the step is in it: `The step from schema version <v> to <v+1> failed: <the reason>. <home>/realm.db is at schema version <n>: the step is in it. Run the command again to continue from there.` Either line ends, when a copy was made, with ` The backup made before the step is at <path>.`
- another writer holds the store for longer than its wait during the re-stamp: the re-stamp line with the number of runs re-stamped so far, then `The store was busy for <s> s: another writer held it. Nothing was written. Try again.`

### Stepping back: `--to <n>`

`realm db migrate --to <n>` steps the store file back to schema version `<n>`, one version at a time, and keeps every run. It steps back only: to go forward, run `realm db migrate` without `--to`. Run it with the Realm that wrote the file, before you install the older Realm. Stop every Realm process that uses the home first. `--backup <path>` and `--no-backup` work as above.

It works in this order:

1. `<n>` must be a whole number that is a schema version this Realm knows; otherwise it refuses before it opens the store.
2. When the file is already at `<n>`, it prints `<home>/realm.db is already at schema version <n>; no step to undo.`, exits 0 and changes nothing; a `--backup <path>` given with it is ignored. When the file is below `<n>`, it refuses.
3. Every step from the file's version down to `<n>` must be one that can be undone. When one cannot, it refuses before any change.
4. It makes sure that no other process has the store file open, as a forward migrate does, then reads the file's version again and judges the plan again.
5. It makes the copy as a forward migrate does: with no flag, in the backups folder, named from the schema versions before and after, such as `realm-v2-to-v1-20261117T103918Z.db`.
6. It runs each step back in its own transaction: the version's own statements, then a check that the file's schema is exactly the version below's, then the file's version moved. It prints one line per step. It re-checks no evidence and re-stamps no phase: a step back changes neither.
7. It stops at the first step that fails. The file is then at the last version it completed.
8. It records the step back in `migrations.jsonl`, as a forward migrate does: its `from_format` is above its `to_format`.
9. It prints how to install a Realm that writes the version it reached.

Each step prints:

`Stepped <home>/realm.db back from schema version <v> to <v-1>: <s> statement(s) ran, the schema matches version <v-1>'s. <what the step dropped>`

Version 2's step back drops the `outbound` table, where `realm agent` and `realm listen --send-reminders` record the Slack reminders and escalations they send: `The outbound table was dropped: the record of <k> reminder(s) and escalation(s) sent is no longer in the file.`, where `<k>` counts those recorded as sent, or, when it held none, `The outbound table was dropped; it held no record of a reminder or escalation sent.` Every run is kept.

After the last step:

``Every command of this Realm that uses the store, except `realm db check`, `realm db backup`, `realm db migrate` and `realm db restore`, now refuses the file, because it is at schema version <n> and this Realm writes version <r>. To use it, install a Realm that writes schema version <n>: npm install -g "@sensigo/realm-cli@<range>" (in a project that lists Realm packages, give every one of them the same exact version within <range>; see "Upgrade every package together" in the upgrade guide).``

`<range>` is `0.49` for schema version 1.

**Exit code:** 0 when every step ran, or none was needed. 1 when the command refuses or a step fails, with one `Error:` line on standard error. Besides the refusals above (the store file cannot be opened, another process has it open, the backups folder or the copy):

- `<n>` is not a schema version this Realm knows, [`STATE_STORE_MIGRATE_REFUSED`](../error-codes.md): `Cannot step back to <value>: give a whole number that is a schema version this Realm knows (<lowest> to <highest>).` Nothing is opened.
- the file is below `<n>`: `The store file is at schema version <v>; --to steps back only. Run realm db migrate, without --to, to go forward.`
- a step down to `<n>` cannot be undone: `The step from schema version <v> to <v-1> cannot be undone: <why>. Nothing was changed. To go back anyway, restore a backup made before the upgrade: realm db restore <backup> (the backups realm db migrate makes are in <backups folder>/).`
- a file written by a newer Realm: the store's own message. Run `--to` with the Realm that wrote the file.
- a step back fails, [`STATE_STORE_MIGRATE_FAILED`](../error-codes.md): `The step back from schema version <v> to <v-1> failed: <the reason>. <home>/realm.db is at schema version <v>; nothing of the step is in it. Run the command again once the cause is fixed.` When a copy was made, ` The backup made before the step is at <path>.` comes before `Run the command again`.

## `check`

`realm db check [--json] [--project <dir>]`

Reports on the store file without changing it: it opens the file read-only. `db check` writes nothing to the store file; SQLite may create or update its two side files beside it (`realm.db-wal`, `realm.db-shm`), as any open of the store does.

It runs SQLite's integrity check and reads the file's settings, schema version and schema, and whether Realm can write to it. It reads every run's stored record once, checking its evidence hashes, its phase stamp, its key hash, its filter columns and its stored placeholders, and it compares the tables with each other: the purge counter, rows whose run is gone, each workflow's pointer, and each stored workflow version's hash. A problem is reported with its reason, and every check it stops is listed as not run, or as run in part. When a read meets a damaged page, or a run whose record cannot be read, that is reported and the rest of the report is kept.

With `--project <dir>`, it also names each stored run that holds, in a changed form, a secret that `<dir>/realm.yaml` declares: upper-cased, lower-cased, capitalised, title-cased, or its first 8 or more characters followed by `…` as the `truncate` filter cuts, in a run's record, its evidence, its write-once fields, its trace or its refused answers. It never prints the value, runs no project code, and does not look for a value under 8 characters, for a part made by the `replace` or `split` filter, or for the value itself, which every run that handled it holds by design. It refuses a folder with no `realm.yaml`, a `realm.yaml` that cannot be read or is invalid, and one that names a secret it cannot resolve, before it opens the store: nothing is scanned.

It refuses, with one `Error:` line, a home with no store file or an empty one, a Node.js whose built-in SQLite is below the floor, a home on a network or unrecognised filesystem or on a system other than Linux or macOS, a store file that is a folder, or a symbolic link (link the home folder instead, never the store file), and a home that still holds the old JSON store's folders (move them out of the home, then import what you want to keep with `realm run import`).

```bash
realm db check
```

The WAL counts are exact when read; other Realm processes move them.

Each report lists what this version cannot check:

- Other Realm processes' connection settings cannot be read from here.
- A purged run's phase cannot be verified: its record is gone.
- A purged run's key hash cannot be recomputed: no key is kept.
- A run deleted while a finalizer was still owed cannot be detected: the purge record keeps no finalizer field.

With `--project`, two more:

- A declared value shorter than 8 characters is not looked for in a changed form.
- A part of a declared value made by the replace or split filter is not looked for: such parts cannot be listed.

**Exit code:** 0 when every check ran and found nothing. 1 when a problem is found or a check could not run, and 1 when the command refuses, with one `Error:` line on standard error and nothing on standard output — the `--project` refusal for a secret that cannot be resolved follows its `Error:` line with the resolver's lines naming each `${secret:NAME}`, never a value. A file Realm cannot write to exits 1, a read-only copy included (`findings[].code` is `not_writable`). The side files SQLite creates beside a read-only file are read-only too: when you make the file writable, make `realm.db-wal` and `realm.db-shm` writable as well, or Realm still cannot write to the store.

`--json` prints the report: `status` (`ok` or `findings`), `path`, `schema_version`, `reads_up_to`, `facts`, `findings`, `not_run` and `not_checked`. A finding's `examples_of`, present only when it differs from `count`, says how many examples exist: `orphaned_rows` counts rows, and its examples are one per table and run. A `changed_form_of_declared_value` finding also carries `run_id`, `path` (the field that holds the form) and `kind` (`upper-cased`, `lower-cased`, `capitalised`, `title-cased` or `truncated`), so a script can purge by `run_id`; none of them holds the value.

| Code                             | Check                   | Message                                                                                                                                                                                   | Stops                                                                          |
| -------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `integrity_failed`               | integrity               | `SQLite's integrity check reported 1 problem.` / `SQLite's integrity check reported <n> problems.` / `SQLite's integrity check reported at least <n> problems.`                           | nothing                                                                        |
| `integrity_unreadable`           | integrity               | `SQLite could not finish its integrity check: SQLite error <code>, the file is damaged.`                                                                                                  | nothing                                                                        |
| `open_failed`                    | open                    | `SQLite could not open the file: <SQLite's message> (SQLite error <n>).`                                                                                                                  | every other check but writable                                                 |
| `header_damaged`                 | header                  | `The file is not a readable SQLite database: its header or schema cannot be read.`                                                                                                        | version, schema, settings, integrity, the data checks                          |
| `newer_version`                  | version                 | `Written by a later version of Realm (schema version <n>; this version reads up to <m>).`                                                                                                 | schema, the data checks; the settings' meta row                                |
| `older_version`                  | version                 | ``Written by an earlier version: schema version <n>; this version needs <m>; run `realm db migrate`.``                                                                                    | the data checks                                                                |
| `version_unknown`                | version                 | `The file's schema version is 0: it was never set up (a first open was interrupted) or it is not a Realm store.` / `The file's schema version is <n>, which no version of Realm writes.`  | schema, the data checks; the settings' meta row                                |
| `schema_differs`                 | schema                  | `The schema differs from schema version <n>'s: missing <names>; extra <names>; changed <names>.`                                                                                          | the data checks; the settings' meta row, when it is the meta table             |
| `settings_differ`                | settings                | `A store setting differs: <setting> is <found>, expected <expected>.`                                                                                                                     | nothing; the settings' meta row and `tombstones`, when the meta row is missing |
| `not_writable`                   | writable                | `Realm cannot write to this file or its folder: every other command that opens this store, reads included, is refused until it can, except the checks that only look at it.`              | nothing                                                                        |
| `data_unreadable`                | data_read               | `SQLite could not read the store's data: SQLite error <code>, the file is damaged.` / `Realm could not read the store's data: a stored integer is too large for Realm to read.`           | the data checks whose read failed                                              |
| `record_unreadable`              | records                 | `1 run holds a stored record that is not JSON; the checks that read a record skipped it.` / `<n> runs hold a stored record that is not JSON; the checks that read a record skipped them.` | the other record checks, for those runs                                        |
| `evidence_hash_mismatch`         | evidence_hashes         | `1 evidence entry does not match its stored hash.` / `<n> evidence entries do not match their stored hash.`                                                                               | nothing                                                                        |
| `phase_index_wrong`              | phase_index             | `1 run carries a phase that differs from its record's.` / `<n> runs carry a phase that differs from their record's.`                                                                      | nothing                                                                        |
| `key_hash_mismatch`              | key_hashes              | `1 run carries a key hash that does not match its key.` / `<n> runs carry a key hash that does not match their key.`                                                                      | nothing                                                                        |
| `filter_column_differs`          | filter_columns          | `1 run holds a filter column that differs from its record.` / `<n> runs hold a filter column that differs from their record.`                                                             | nothing                                                                        |
| `placeholder_mismatch`           | placeholders            | `1 run holds stored placeholders that do not match their rows.` / `<n> runs hold stored placeholders that do not match their rows.`                                                       | nothing                                                                        |
| `purged_count_mismatch`          | tombstones              | `The purged-run count (<a>) differs from the purge counter (<b>).`                                                                                                                        | nothing                                                                        |
| `orphaned_rows`                  | orphans                 | `1 row belongs to a run that is gone: <table> 1.` / `<n> rows belong to runs that are gone: <table> <k>, ….`                                                                              | nothing                                                                        |
| `workflow_pointer_mismatch`      | workflow_pointers       | `1 workflow's pointer does not match its newest registration.` / `<n> workflows' pointers do not match their newest registration.`                                                        | nothing                                                                        |
| `workflow_version_hash_mismatch` | workflow_version_hashes | `1 stored workflow version does not match its hash.` / `<n> stored workflow versions do not match their hash.`                                                                            | nothing                                                                        |
| `changed_form_of_declared_value` | declared_forms          | `run <id>: <path> holds the <kind> form of a declared value — rotate it and purge the run`                                                                                                | nothing                                                                        |

Never delete, move or replace `realm.db` or its side files while a Realm process is running.

## `restore`

`realm db restore <backup>`

Puts a backup in place of the store file: a copy that `realm db backup` or `realm db migrate` made. The file it replaces is kept, never deleted. There is no confirmation prompt: nothing is lost, so running the command is the decision. Stop every Realm process that uses the home first.

It works in this order:

1. It checks the backup before it opens the store file. It copies the backup into a private folder of its own in the system's temporary folder, readable by your account only, and checks the copy there: that it is a Realm store, that SQLite's quick check passes, and that this Realm reads its schema version. The backup itself is only read: a backup in a read-only folder can be restored, and nothing is created beside it.
2. It puts a second copy of the checked backup in the home, as `.realm-restore-<pid>-<random>.db`, readable and writable by your account only (mode 600). A restore that was killed may leave one: it is a full copy of the backup, which you can delete when no restore is running.
3. It makes sure that no other process has the store file open, and keeps it so until it is done. When one has it open, even an idle one, the command refuses and changes nothing. A Realm command started while the restore runs waits, then opens the restored file (or fails as busy after about 5 seconds). A program other than Realm (a SQLite browser, a script) that opens the store file while the restore runs may still write into the file it replaced and leave `realm.db-wal` and `realm.db-shm` beside the restored one: close such programs before you restore.
4. It keeps the file it replaces: [`realm db backup`](#backup) copies it into the backups folder beside the home, `~/.realm-backups/` for the home `~/.realm` (made owner-only when it is missing), as `realm-before-restore-<UTC time>.db`, and prints its line.
5. It counts how the runs of the two files differ.
6. It writes the store's write-ahead log into the store file, removes `realm.db-wal` and `realm.db-shm`, and renames the copy over `realm.db` in one step. A stale write-ahead log is never applied to the restored file.

```bash
realm db restore ./realm-backup.db
```

It prints `realm db backup`'s line for the kept file, then:

`Restored <home>/realm.db from <backup> (schema version <m>).`

and then either `The file it replaced and the backup hold the same runs.` or `The file it replaced had <a> run(s) the backup lacks and <b> that differ; the backup has <c> it lacked (they are back). The replaced file is the copy above. Only runs are counted.`

The counts cover runs only. Not counted: the Slack reminders and escalations already sent, which are not restored and are sent again; `realm listen`'s duplicate-webhook marks; saved replays; refused answers. A run purged after the backup was made comes back, and the record of its purge is gone.

When the backup is at an older schema version than this Realm writes, a last line says what comes next: ``This backup is at schema version <m> and this Realm writes version <r>. To use it with this Realm, run `realm db migrate`; to use it with an older Realm, install that Realm now.`` To go back to an older Realm, restore first with this Realm, then install the older one. A file that is already migrated can instead be stepped back without losing a run: `realm db migrate --to 1` (see [Going back without losing runs](../guides/upgrade.md#going-back-without-losing-runs)).

A backup made by copying a live `realm.db` without its `realm.db-wal` lacks the newest writes: make backups with `realm db backup`. To undo a restore, restore the kept file: `realm db restore ~/.realm-backups/realm-before-restore-<UTC time>.db`. The kept file's name holds the second it was made, so a second restore in the same second is refused by `realm db backup`'s rule, and changes nothing.

**Exit code:** 0 when the backup is in place. 1 when the command refuses, with one `Error:` line on standard error. The refusals have the code [`STATE_STORE_RESTORE_REFUSED`](../error-codes.md) unless another is named:

- the backup is missing or cannot be read: `Cannot restore from <backup>: <the system's reason>. Nothing was changed.`; a symbolic link: `Cannot restore from <backup>: it is a symbolic link. Nothing was changed.`; a folder, or anything but a file: `Cannot restore from <backup>: it is not a file. Nothing was changed.`; an empty file: `Cannot restore from <backup>: it is empty: it holds no store. Nothing was changed.`
- the backup is the store file, by any path: `Cannot restore from <backup>: it is the store file itself. Nothing was changed.`; one of its side files: `Cannot restore from <backup>: it is the store file's -wal file. Nothing was changed.` (or `-shm`).
- the backup is not a Realm store, is damaged, or was written by a newer Realm: `Cannot restore from <backup>:` and the words of [`realm db check`](#check), then `Nothing was changed.`, such as `Cannot restore from <backup>: Written by a later version of Realm (schema version <n>; this version reads up to <m>). Nothing was changed.`
- the home has no store file: `There is no store file at <home>/realm.db to restore over.`; an empty one: `<home>/realm.db holds no store yet: there is nothing to restore over.` Nothing is changed; put the backup in place by hand for now ([Restoring a copy](#restoring-a-copy)).
- the store file cannot be opened (it is damaged, not a Realm store, or written by a newer Realm): the store's own message. Nothing is changed; over a damaged store file, put the backup in place by hand for now.
- another process has the store file open, [`STATE_STORE_IN_USE`](../error-codes.md): `Another process has <home>/realm.db open (a Realm agent, server, MCP server or command, or another program such as a SQLite browser). Stop it and run this again. Nothing was changed.`
- the kept copy cannot be made, or fails SQLite's quick check (the store file may then be damaged): `realm db backup`'s refusal, with its code, then ` Nothing was replaced.` Over such a file, put the backup in place by hand for now ([Restoring a copy](#restoring-a-copy)).
- another failure before the rename: `Cannot restore from <backup>: <the reason>. <home>/realm.db was not replaced.`, then ` A copy of it is at <kept file>.` when the kept copy was made. After the rename, when the folder cannot be flushed: `Cannot restore from <backup>: <the reason>. <home>/realm.db was replaced.`

## See also

- [`realm workflow`](realm-workflow.md), [`realm run`: commands that read](realm-run-reading.md), [`realm run`: commands that act](realm-run-acting.md), [`realm agent`](realm-agent.md), [`realm listen`](realm-listen.md), [`realm mcp` and `realm serve`](realm-mcp-and-serve.md)
- [Error codes](../error-codes.md)
