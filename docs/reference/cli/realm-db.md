# `realm db`

<!-- description: Reference for realm db backup, which copies the store file to a new file and checks the copy: its argument, output, exit codes, and how to restore a copy. -->

`realm db` acts on the store file, `realm.db` in the Realm home (`~/.realm`), never on a run. It has one subcommand.

| Subcommand          | What it does                                                               |
| ------------------- | -------------------------------------------------------------------------- |
| [`backup`](#backup) | Copies the store file to a new file outside the home, and checks the copy. |

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

## See also

- [`realm workflow`](realm-workflow.md), [`realm run`: commands that read](realm-run-reading.md), [`realm run`: commands that act](realm-run-acting.md), [`realm agent`](realm-agent.md), [`realm listen`](realm-listen.md), [`realm mcp` and `realm serve`](realm-mcp-and-serve.md)
- [Error codes](../error-codes.md)
