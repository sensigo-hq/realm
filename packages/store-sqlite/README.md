# @sensigo/realm-store-sqlite

SQLite-backed stores for Realm: runs, duplicate-webhook ids, workflow definitions, failed attempts, replays and trace buffers, in one `realm.db` file in the Realm home. Realm's own store package, published so that `@sensigo/realm-cli` can depend on it; you do not need to install it yourself.

## Opening a home

`openRealmHome({ home, clock })` opens a Realm home and resolves to a handle with `runStore`, `dedupStoreFor`, `workflowStore`, `failedAttemptStore`, `replayStore`, `traceBufferStore` and `close()`. Callers in one process that open the same home share one handle and one connection, so a `close()` by any of them ends it for all.

## The store file

Realm keeps run records in one SQLite file, `realm.db`, in the Realm home. Never delete, move or replace `realm.db` or its side files `realm.db-wal` and `realm.db-shm` while a Realm process is running.

Text of a deleted run may stay readable in `realm.db`'s free pages and in `realm.db-wal` until the file is vacuumed and checkpointed (purge, a later unit, does both).

One exception to Realm stamping every time itself: a run deleted by SQL outside Realm is stamped with SQLite's own clock.

Duplicate webhooks: each id is remembered, as a hash, for its window, measured on the store's clock and fixed when it is recorded; each record also clears up to 100 expired ids.

## The workflow registry

The workflow registry stores each distinct definition text once, under its hash, with a pointer per workflow to its current text and a record of every move of that pointer; an identical re-register writes nothing.

## Failed attempts and replays

Failed attempts are kept per run in append order; recording stops once a run's records reach 256 KiB, and recording one never fails the step.
Replays are saved and read by id; a store failure is reported as itself, never as "not found".

## The trace buffer

The trace buffer keeps one row per line, in append order, and a step's read waits for a write in flight.
A fenced write checks the run inside its own write: when another writer is changing the run at that moment, the write waits for that change, then checks the run as it now stands, so it is refused with the fence's own error and writes nothing when the run no longer passes, and goes ahead when it does.

## Concurrent writers

Writers take turns on one lock. A write that cannot get its turn within 5 seconds is refused with `STATE_RUN_BUSY`, which is retryable: nothing is written, and trying again is safe. Realm's own test run prints the commits per second and the busy refusals it saw with 1, 4, 8 and 16 writer processes, in lines that start with `L-THROUGHPUT`, so the log of a run shows what that machine did. The lines are recorded, not asserted, and they are not a promise.

## Where it runs

Realm refuses a home on a network drive or on a filesystem it does not recognise, including WSL's `/mnt/c`, because SQLite's write-ahead log does not work there. Set `REALM_STORE_FS=local` to use such a folder anyway.

The store uses Node's built-in SQLite, which Node 22 labels as in development and Node 24.15.0 and later as a release candidate. Realm needs Node 22.22.3 or a later 22.x release, or Node 24.15.0 or later: the releases that carry the fix for SQLite's WAL-reset bug.

## Test support

`@sensigo/realm-store-sqlite/test-support` exports one function, `openForeignConnection(home)`: a second, raw connection on a home's `realm.db`, opened through the package's one loader, for tests that need a hostile writer or reader beside the store (a held lock, a foreign write, a raised schema version). It is test support, not a production API, and it may change with any release.
