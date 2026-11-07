# @sensigo/realm-store-sqlite

SQLite-backed stores for Realm. Not yet released: a later change wires them in.
Do not depend on this package.

## Opening a home

`openRealmHome({ home, clock })` opens a Realm home and resolves to a handle with `runStore`, `dedupStoreFor`, `workflowStore` and `close()`. Callers in one process that open the same home share one handle and one connection, so a `close()` by any of them ends it for all.

## The store file

Realm keeps run records in one SQLite file, `realm.db`, in the Realm home. Never delete, move or replace `realm.db` or its side files `realm.db-wal` and `realm.db-shm` while a Realm process is running.

Text of a deleted run may stay readable in `realm.db`'s free pages and in `realm.db-wal` until the file is vacuumed and checkpointed (purge, a later unit, does both).

One exception to Realm stamping every time itself: a run deleted by SQL outside Realm is stamped with SQLite's own clock.

Duplicate webhooks: each id is remembered, as a hash, for its window, measured on the store's clock and fixed when it is recorded; each record also clears up to 100 expired ids.

## The workflow registry

The workflow registry stores each distinct definition text once, under its hash, with a pointer per workflow to its current text and a record of every move of that pointer; an identical re-register writes nothing.

## Where it runs

Realm refuses a home on a network drive or on a filesystem it does not recognise, including WSL's `/mnt/c`, because SQLite's write-ahead log does not work there. Set `REALM_STORE_FS=local` to use such a folder anyway.

The store uses Node's built-in SQLite, which Node 22 labels as in development and Node 24.15.0 and later as a release candidate. Realm needs Node 22.22.3 or a later 22.x release, or Node 24.15.0 or later: the releases that carry the fix for SQLite's WAL-reset bug.
