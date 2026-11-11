# `realm db`

<!-- description: Reference for realm db backup, which copies the store file to a new file and checks the copy, realm db migrate, which upgrades the store file after a backup, and realm db check, which reports on the store file without writing it: their arguments, output, exit codes, and how to restore a copy. -->

`realm db` acts on the store file, `realm.db` in the Realm home (`~/.realm`), never on a run. It has three subcommands.

| Subcommand            | What it does                                                               |
| --------------------- | -------------------------------------------------------------------------- |
| [`backup`](#backup)   | Copies the store file to a new file outside the home, and checks the copy. |
| [`migrate`](#migrate) | Upgrades the store file to this Realm's schema version, after a backup.    |
| [`check`](#check)     | Reports on the store file without writing it.                              |

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

Restoring is done by hand, never by a command. Stop every Realm process that uses the home. If the home folder does not exist, on a new machine for one, create it. Put the copy in place of `realm.db` in the home. Then remove `realm.db-wal` and `realm.db-shm` from the home if they are there: a stale write-ahead log beside a restored file corrupts it. Realm then opens the store as it was when the copy was made.

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

`realm db migrate --backup <path>` or `realm db migrate --no-backup`

Upgrades the store file to the schema version this Realm writes. Stop every Realm process that uses the home first: each schema step takes the store's write lock.

One of the two flags is required:

- `--backup <path>`: a copy of the store file, made by [`realm db backup`](#backup) before anything changes, with all of its rules: outside the home, and where nothing exists yet.
- `--no-backup`: no copy. Use it when you already have one, or when you accept the risk.

The command works in this order:

1. With `--backup <path>`, it makes the copy and prints `realm db backup`'s line. When the copy cannot be made, or fails SQLite's quick check, the command stops there: nothing is migrated.
2. It runs each pending schema step in its own transaction. A step checks that the file's schema is then exactly that version's, and that every evidence entry still matches its stored hash, before it moves the file's version. It prints one line per step.
3. It stops at the first step that fails. The file is then at the last version it completed, and the line says which version that is. Run the command again once the cause is fixed: it continues from there.
4. It re-stamps the phase index. Each run's phase is stored beside it, with a stamp of the code that worked it out. When an upgrade changes that code, the command works out each such run's phase again from its record and stores it with the current stamp, so that listings by phase use the index again. It changes no run record.

```bash
realm db migrate --backup ./realm-before-upgrade.db
```

It prints one line per step:

`Migrated <home>/realm.db from schema version <v> to <v+1>: <s> statement(s) ran, the schema matches version <v+1>'s, <e> evidence entries match their stored hashes.`

or, when the file is already at this Realm's version:

`<home>/realm.db is already at schema version <n>; no schema step to run.`

and then:

`Re-stamped the phase index of <k> run(s) with the current derivation.`

**Exit code:** 0 when every step ran, or none was pending, and the re-stamp finished. 1 when the command refuses or a step fails, with one line on standard error — the two flag refusals as written below, every other refusal as an `Error:` line:

- neither flag: `Provide --backup <path> (a copy of the store file, made before anything changes) or --no-backup.`; both: `Cannot combine --backup with --no-backup. Use one or the other.` Nothing is opened.
- the home has no store file: `There is no store file at <home>/realm.db to migrate.`; an empty one: `<home>/realm.db holds no store yet: there is nothing to migrate.` These have the code [`STATE_STORE_MIGRATE_REFUSED`](../error-codes.md); nothing is created or copied.
- the store file cannot be opened (not a Realm store, damaged, written by a newer Realm, or older than any version this Realm can upgrade): the store's own message. Nothing is copied or migrated.
- the copy cannot be made, or fails the quick check: `realm db backup`'s refusals, above.
- a step fails, [`STATE_STORE_MIGRATE_FAILED`](../error-codes.md): `The step from schema version <v> to <v+1> failed: <the reason>. <home>/realm.db is at schema version <v>; nothing of the step is in it. Run the command again once the cause is fixed.` When the file is found at a higher version after the failure, the step is in it: `The step from schema version <v> to <v+1> failed: <the reason>. <home>/realm.db is at schema version <n>: the step is in it. Run the command again to continue from there.` Either line ends, when a copy was made, with ` The backup made before the step is at <path>.`
- another writer holds the store for longer than its wait during the re-stamp: the re-stamp line with the number of runs re-stamped so far, then `The store was busy for <s> s: another writer held it. Nothing was written. Try again.`

## `check`

`realm db check [--json]`

Reports on the store file without changing it: it opens the file read-only. `db check` writes nothing to the store file; SQLite may create or update its two side files beside it (`realm.db-wal`, `realm.db-shm`), as any open of the store does.

It runs SQLite's integrity check and reads the file's settings, schema version and schema, and whether Realm can write to it. It reads every run's stored record once, checking its evidence hashes, its phase stamp, its key hash, its filter columns and its stored placeholders, and it compares the tables with each other: the purge counter, rows whose run is gone, each workflow's pointer, and each stored workflow version's hash. A problem is reported with its reason, and every check it stops is listed as not run, or as run in part. When a read meets a damaged page, or a run whose record cannot be read, that is reported and the rest of the report is kept.

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

**Exit code:** 0 when every check ran and found nothing. 1 when a problem is found or a check could not run, and 1 when the command refuses, with one `Error:` line on standard error and nothing on standard output. A file Realm cannot write to exits 1, a read-only copy included (`findings[].code` is `not_writable`). The side files SQLite creates beside a read-only file are read-only too: when you make the file writable, make `realm.db-wal` and `realm.db-shm` writable as well, or Realm still cannot write to the store.

`--json` prints the report: `status` (`ok` or `findings`), `path`, `schema_version`, `reads_up_to`, `facts`, `findings`, `not_run` and `not_checked`. A finding's `examples_of`, present only when it differs from `count`, says how many examples exist: `orphaned_rows` counts rows, and its examples are one per table and run.

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

Never delete, move or replace `realm.db` or its side files while a Realm process is running.

## See also

- [`realm workflow`](realm-workflow.md), [`realm run`: commands that read](realm-run-reading.md), [`realm run`: commands that act](realm-run-acting.md), [`realm agent`](realm-agent.md), [`realm listen`](realm-listen.md), [`realm mcp` and `realm serve`](realm-mcp-and-serve.md)
- [Error codes](../error-codes.md)
