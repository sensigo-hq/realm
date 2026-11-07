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
2. It creates `<path>` empty, readable and writable by your account only (mode 600; on Linux and macOS), so the copy is never readable by others.
3. SQLite copies the whole store into it in one step (`VACUUM INTO`). The store file is only read.
4. It sets the copy to the journal mode Realm needs (WAL), so that Realm can open it, and checks it with SQLite's quick check (`PRAGMA quick_check`).

```bash
realm db backup ./realm-backup.db
```

It prints one line, with the store's schema version and the copy's size:

`Backed up <home>/realm.db (schema version <n>, <bytes> bytes) to <path>; the copy passes SQLite's quick check.`

### Restoring a copy

Restoring is done by hand, never by a command. Stop every Realm process that uses the home. Put the copy in place of `realm.db` in the home. Then remove `realm.db-wal` and `realm.db-shm` from the home if they are there: a stale write-ahead log beside a restored file corrupts it. Realm then opens the store as it was when the copy was made.

**Exit code:** 0 when the copy is made and passes the check. 1 when the command refuses, with one `Error:` line on standard error and nothing written:

- `<path>` is inside the home: `Cannot back up the store to <path>: it is inside the Realm home <home>. Write the copy outside the home.`
- something exists at `<path>`: `Cannot back up the store to <path>: a file already exists there. Realm never replaces a file; name a path where nothing exists.`
- `<path>` cannot be created, for one because its folder does not exist: `Cannot back up the store to <path>: <the system's reason>. Check the path.`
- the home has no store file: `There is no store file at <home>/realm.db to back up.`; an empty one: `<home>/realm.db holds no store yet: there is nothing to back up.`
- the store file cannot be opened (not a Realm store, damaged, or written by a newer Realm): the store's own message.

These refusals have the code [`STATE_STORE_BACKUP_REFUSED`](../error-codes.md). Exit code 1 also when the copy fails the quick check, [`STATE_STORE_BACKUP_UNVERIFIED`](../error-codes.md): `SQLite's quick check of the copy at <path> failed: <SQLite's first line>. The store file <home>/realm.db it was copied from may be damaged. The copy was kept at <path>.` The copy is kept, so that it can be looked at.

## See also

- [`realm workflow`](realm-workflow.md), [`realm run`: commands that read](realm-run-reading.md), [`realm run`: commands that act](realm-run-acting.md), [`realm agent`](realm-agent.md), [`realm listen`](realm-listen.md), [`realm mcp` and `realm serve`](realm-mcp-and-serve.md)
- [Error codes](../error-codes.md)
