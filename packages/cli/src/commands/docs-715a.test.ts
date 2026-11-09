// docs-715a.test.ts — issue #715 (a) (guardrail 7(f), 9): every docs sentence this unit adds or
// changes is quoted here word for word and asserted to be on its page, read from the repository; the
// behaviour each states is pinned in the cell named in its comment. Each assertion names (a) the change
// that turns it red — the page no longer holds the sentence — and (b) what it prints when it fails: the
// sentence (never an environment or a path under a real home).
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const flat = (t: string): string => t.replace(/\s+/g, ' ');
const read = (page: string): string => readFileSync(join(ROOT, page), 'utf8');
/** (a) red when the page no longer holds the sentence word for word; (b) prints the sentence. */
function claim(page: string, sentence: string): void {
  expect(flat(read(page)), `${page} no longer says: ${sentence}`).toContain(flat(sentence));
}
/** #871's form: the section that holds this unit's entries — `[Unreleased]` until a release renames
 *  it, then the first release section above `[0.48.0]`, never a fixed heading. */
function claimChangelog(sentence: string): void {
  const text = read('CHANGELOG.md');
  const start = text.includes('## [Unreleased]')
    ? text.indexOf('## [Unreleased]')
    : text.indexOf('\n## [') + 1;
  const section = text.slice(start, text.indexOf('\n## [0.48.0]'));
  expect(flat(section), `the CHANGELOG no longer says: ${sentence}`).toContain(flat(sentence));
}

const ENV = 'docs/reference/environment-and-files.md';
const CORE = 'docs/reference/core-library.md';
const TESTING = 'docs/reference/testing-package.md';
const ACTING = 'docs/reference/cli/realm-run-acting.md';
const CODES = 'docs/reference/error-codes.md';

describe('#715 (a) — the docs sentences', () => {
  it('environment-and-files.md: the clock a run’s times come from', () => {
    // B11 (an ordinary directory stamps with the wall clock).
    claim(
      ENV,
      "The store stamps the times it writes, such as a run's `created_at` and `updated_at`, with this computer's clock.",
    );
    // D6-29(a): a statement of support, pinned by this cell alone.
    claim(
      ENV,
      'A Realm home on a folder that several computers share is not supported: each computer would stamp with its own clock.',
    );
    // C4, C14 (the file beside runs/); correction 1 (C-2): the source scan in
    // lint-test-location-715.test.ts (only the testing package creates one); C1, C2 (the store reads).
    // #616 PR-2c c10a-3a: the door's cell (e) and temp-home's test-home cell read the file on a SQLite home.
    claim(ENV, 'A folder with a `.realm-test-clock` file is a test home.');
    claim(
      ENV,
      'Only `@sensigo/realm-testing` creates one, for tests; the store only reads the file.',
    );
    // C2 (create), B2 (update, claimStep at a location), C15 (another process).
    claim(
      ENV,
      "A store opened there takes the time from that file when it creates a run, starts a step, writes a run with `update`, records a step's result or reads a run, so every process that opens the folder reads the same time (added after version 0.48.0).",
    );
    // #715 (b): the C-9 sentence (a settle stamped from this computer's clock) is gone — the settle
    // takes the store's reading (json-file-store-clock-715.test.ts, the settle cells).
    // C3.
    claim(
      ENV,
      'The file names the folder it was made for: a store opened on a copy of it in another folder refuses with `STATE_TEST_CLOCK_FOREIGN`.',
    );
    // Correction 1 (C-6): foreign-test-clock-715.test.ts (deleting the copy's file, run list exits 0).
    claim(ENV, 'To use the copy as an ordinary store, delete its `.realm-test-clock` file.');
  });

  it('realm-run-acting.md: purge reports a run that changed after it was selected', () => {
    // #616 PR-2c c10a-3a: the store's path (purge-sqlite-616.test.ts: a blocked run keeps every row;
    // `changed_since_selected` and `drain_pending` from the home's purge).
    claim(
      ACTING,
      'A run that changed after `purge` selected it is reported `blocked` and kept whole — a run that was resumed with the sentence that it is no longer terminal, and any other change, such as a cleanup step that completed, as `changed_since_selected` (added after version 0.48.0).',
    );
    claim(
      ACTING,
      'A blocked run keeps every row: a run that owes a cleanup step is blocked as `drain_pending` with its trace entries and refused answers kept, and a dry run lists it among the runs that would be purged.',
    );
    claim(
      ACTING,
      '| `blocked` | Runs kept. `drain_pending` means the run still owes a cleanup step; see [`drain`](#drain). |',
    );
  });

  it('#616 PR-2c c10a-3a: the purge lines on the store, the listen row, and the CHANGELOG entries', () => {
    // The force line, the backups line and the log line: purge-sqlite-616.test.ts's print cells,
    // the code's own format strings.
    claim(
      ACTING,
      'Purged 2/3 run(s) (4.9 KB freed, store-reported; realm.db shrank by 4.0 KB). 0 already gone, 1 blocked, 0 failed.',
    );
    claim(ACTING, 'Copies of the deleted runs in backups made before this purge are not touched.');
    claim(
      ACTING,
      "The bytes freed are what the store reports for the deleted runs; `realm.db shrank by` is what the file gave back on disk — a floor: SQLite gives back whole pages, and only once nothing is left on them — a page that still holds other rows stays, and so does each table's first page, so a few small runs often give back nothing — and pages still in the write-ahead log do not show in it yet. When another process was using the log, one more line says `realm.db's log was not reset: another process was using it. The space is returned at a later checkpoint; the deleted text may stay readable in realm.db-wal until a later purge resets the log.`",
    );
    claim(
      'docs/guides/operate-runs.md',
      'Purged 6/6 run(s) (21.3 KB freed, store-reported; realm.db shrank by 20.0 KB). 0 already gone, 0 blocked, 0 failed.',
    );
    claim(
      'docs/guides/operate-runs.md',
      'Copies of the deleted runs in backups made before this purge are not touched.',
    );
    // lib/home.test.ts (a): the dedup mark reads back from the home's store.
    claim(
      'docs/reference/cli/realm-listen.md',
      "| `file` | In the Realm home's store (`realm.db`), one row for each ID. |",
    );
    for (const sentence of [
      // lib/home.test.ts (a), (d); the store's sentence: store-sqlite/src/home.ts.
      "**Every `realm` command keeps its store in `realm.db`**, one SQLite file in the Realm home (`~/.realm/realm.db`): runs, the workflow registry, replays, trace buffers, failed attempts and `realm listen`'s dedup marks.",
      "The first command on a home that still holds the old JSON store's folders (`runs`, `workflows`, `replays`, `dedup`) refuses with one line — `This Realm keeps its store in realm.db and does not read the old JSON directories (…) in <home>. Move them out of the home, then import what you want to keep with save() or realm run import.` (the store's sentence; its own code spans dropped here) — and creates nothing.",
      // packages/cli/package.json's engines.
      'The `realm` command needs Node 22.22.3 or a later 22.x release, or Node 24.15.0 or later. (#616)',
      // purge-sqlite-616.test.ts.
      '**`realm run purge` deletes on the store**, in bounded batches; the force line also reports what `realm.db` gave back on disk (`realm.db shrank by <bytes>`, a floor), copies in backups made before the purge are untouched, a blocked run keeps every row, and the log is reset once at the end — when another process was using it, one line says so. (#616)',
    ])
      claimChangelog(sentence);
  });

  it('core-library.md: the stores’ clock and a store’s clock functions', () => {
    // B2, B10.
    claim(
      CORE,
      '`JsonFileStore` and `InMemoryStore` each have a `clock`: the time they stamp their writes with (added after version 0.48.0).',
    );
    // C1, C2.
    claim(
      CORE,
      "`JsonFileStore` takes no clock: its clock is this computer's, or the clock file of a [test location](environment-and-files.md#the-clock-a-runs-times-come-from) when its folder is one.",
    );
    // B10, B11.
    claim(
      CORE,
      '`InMemoryStore` takes one, `new InMemoryStore({ clock })`, and uses `systemClock` when none is given.',
    );
    // B1, B2, B10.
    claim(
      CORE,
      "Each `create`, `update` and `claimStep` reads the clock once and stamps everything it records with that reading: `created_at`, `updated_at`, and a claim's `since` and deadline.",
    );
    // The reach cell below (only the stores take a reading); D7–D12 (durations are monotonic).
    claim(CORE, 'The clock does not stamp times taken outside the store, or durations.');
    // #715 (b): B1 J15 (reads one each), the SETTLE_ONE_READING and OPEN_GATE_MINTS_AT_AT laws, M7/M8.
    claim(
      CORE,
      "`settleStep` reads it once too, inside its write, and every time it records comes from that reading: `updated_at`, a gate's `opened_at` and `expires_at`, an ended run's `abandoned_at`.",
    );
    claim(
      CORE,
      'A read takes one reading before it loads: `get` returns `{ record, at }`, and `list` returns `{ snapshots, read_at, consistent_snapshot }`, each record with the reading it is judged at.',
    );
    claim(CORE, '`stampSeal` does not read the clock.');
    // A1, A3.
    claim(
      CORE,
      'A `Clock` has two functions: `now()`, which returns the current time as a new `Date`, and `at(when, fn)`, which runs `fn` once when the clock reaches `when` and returns a function that cancels it.',
    );
    // A2, A4.
    claim(
      CORE,
      "`createSystemClock({ onWaiterError })` builds a clock on this computer's time. A function given to `at` that throws or rejects is passed to `onWaiterError`, and a forward step of the computer's clock is noticed within 60 seconds.",
    );
    // C1, B11, A6.
    claim(
      CORE,
      // #715 (b) commit 4: the rest of this paragraph (its `at` works since commit 3) is pinned in
      // docs-715b.test.ts with its cells.
      '`systemClock` is the clock a store uses when it is given none.',
    );
    // A8, A7.
    claim(
      CORE,
      "`takeReading(clock, record?, delta?)` reads the clock once for a write. When the record's `updated_at` is ahead of the clock, the reading moves up to it, but by 5 seconds at most.",
    );
    // A10, B4.
    claim(
      CORE,
      "`floorAtHolder(reading, holderCreatedAt?)` moves a keyed `create`'s reading to 1 millisecond after the `created_at` of the run it replaces, again by 5 seconds at most. So a run started again under an idempotency key is stamped after the run it replaces when the clock stepped back by less than 5 seconds.",
    );
  });

  it('testing-package.md: clocks, test locations and the store-clock contract', () => {
    // B10, B11.
    claim(
      TESTING,
      "Given a `clock`, it stamps its writes with that clock; without one, with this computer's (added after version 0.48.0).",
    );
    // C7.
    claim(
      TESTING,
      "Clocks a test moves itself, for a store's `clock` (added after version 0.48.0).",
    );
    // C7.
    claim(
      TESTING,
      'A clock that moves only when the test calls `advance(ms)` or `set(time)`. Moving it runs each function given to `at` that is due, one at a time, earliest first, and waits for each to finish.',
    );
    // C13.
    claim(
      TESTING,
      'A clock whose time goes up by `stepMs` each time it is read, with a `reads` count. Its `at` throws.',
    );
    claim(TESTING, 'The same clock, with a `reads` count of its `now()` calls.');
    // C14, C15; correction 1 (C-3): test-location.test.ts (1)–(4); correction 2 (R-1): R1-a (a shared
    // parent and a caller file stay), R1-b (a given root keeps what was written in it), R1-c (only the
    // folders it made go), R1-d and (4) (the fresh folder goes whole), R-5 (through an alias).
    claim(
      TESTING,
      'A test location: a folder with `runs/` and a `.realm-test-clock` file. Its `clock` moves the time in that file, so a `JsonFileStore` opened on its `runsDir`, in this process or another, reads it.',
    );
    claim(
      TESTING,
      '`remove()` deletes the clock file, the `runs/` folder if the location made it, and the other folders the location made above `runs/`, each only if it is then empty; a root you gave keeps everything else in it. A folder the location makes itself, when you give no `root`, is deleted whole.',
    );
    // Correction 1: C-3 (0) (the refused roots, by the path as written), C14 (a root that holds a
    // clock file), C-6's built-CLI cell (deleting the file makes the folder an ordinary store);
    // correction 2: R-5 (an alias of the working directory is accepted), R-3b (the parent of a `..x`
    // working directory is accepted).
    claim(
      TESTING,
      '`createTestLocation` refuses an empty root, and a root that is the working directory or a folder above it, judged by the path as written: a symlink or junction to one is not followed, and the parent of a working directory whose own name starts with `..` is not recognised as a folder above it. It also refuses a root that already holds a clock file; to use that folder as an ordinary store again, delete its `.realm-test-clock` file.',
    );
    // Correction 1 (C-9), REVERSED by #715 (b) commit 1 (the page caught up in commit 5): B2 (create,
    // update, claimStep stamp the location) and json-file-store-clock-715's "(C-9 reversed) — on a test
    // location, claimStep and settleStep both stamp the location"; the store clock contract's
    // SETTLE_ONE_READING on the location route.
    claim(
      TESTING,
      "The location's time stamps everything a store opened there records: a run's `created_at` and `updated_at`, a claim's `since` and deadline, and every time `settleStep` records.",
    );
    // C9; C7, C7b; C8.
    claim(
      TESTING,
      '`set` to an earlier time runs nothing and moves the clock back. A function given to `at` sees the clock at its own time, never earlier. An `advance` runs every due function even when some throw, then rejects with their errors.',
    );
    // Correction 1 (C-2) and 2 (R-3c): the source scan (lint-test-location-715.test.ts: its
    // PACKAGES, NEEDLES and ALLOWED are the sentence's four packages, names and exceptions; its file
    // set cell: `.ts` and `.mjs`, no test file — #715 (b), #913's R2-4); C1, C2 (the store reads the
    // file beside runs/, and none elsewhere).
    claim(
      TESTING,
      "A test of Realm's own source keeps `createTestLocation` and `createTestHome`, and the clock file's helpers `@sensigo/realm` exports for this package, out of the `.ts` and `.mjs` files in the `src` folders of Realm's four packages, except test files (`*.test.ts`, which create test locations), the files that define or re-export them, the file store's own file (it reads the clock file, and a comment there names it) and this package: no command, server or library there creates a test location or writes a clock file.",
    );
    claim(TESTING, 'The file store reads a clock file, only when it sits beside `runs/`.');
    // The type count cell below.
    claim(TESTING, 'The 31 types are named in the group that uses them.');
    // C16 (the family takes an adapter and returns cases).
    claim(
      TESTING,
      'Each of the 5 contract functions takes an adapter that describes your store and returns a list of cases.',
    );
    claim(
      TESTING,
      '| `storeClockContract` | `RunStore`, on a clock the test moves | 12 | 12, with `InMemoryStore` |',
    );
    // STORE_CLOCK_LAWS has no STORE_RELEASE_LINE_TRUE (C16 runs its five laws).
    claim(TESTING, 'Each of the first four contracts has the law `STORE_RELEASE_LINE_TRUE`:');
    // The two adapters filter STORE_CLOCK_LAWS.
    claim(
      TESTING,
      'Each contract exports the names of its laws as a list, so that a test file does not keep its own copy of them: `RUN_STORE_FIDELITY_LAWS`, `SETTLEMENT_LAWS`, `ARTIFACT_STORE_LAWS` and `FENCED_TRACE_BUFFER_LAWS`, added in 0.46.0, and `STORE_CLOCK_LAWS`, added after version 0.48.0.',
    );
    // C16.
    claim(
      TESTING,
      'The laws of the time a run store writes (added after version 0.48.0). Each case builds its own store, on a clock it moves.',
    );
    claim(
      TESTING,
      "`{ kind: 'clock', makeStore({ clock }) }` for a store built with a clock it is given, such as `InMemoryStore`; `{ kind: 'location', makeStore({ location }) }` for a store opened on a test location, such as `JsonFileStore` on `location.runsDir`.",
    );
    // C17, one row per law. #616 PR-1a unit 16a corrects WRITE_ONE_READING's "refused or not" to
    // what the law checks: store-clock-contract.ts's WRITE_ONE_READING counts (a refusal after the
    // lock: C17's `refuses-unread` cell; a missing run: C16), and the adapter has no field that
    // holds a lock (docs-715b's derived adapter-table cell).
    claim(
      TESTING,
      "a `create`, `update` or `claimStep` records a time other than the clock's, or (on the `clock` route) reads the clock other than once when it is applied or refused after it takes its lock, or reads it for a run that does not exist. A call refused before it can take its lock, such as one a busy store refuses, is outside this law: the adapter has no way to hold a lock",
    );
    claim(
      TESTING,
      "a write after the clock stepped back behind a record is not stamped with the record's time, or with the clock's time plus 5 seconds when the record is further ahead",
    );
    claim(
      TESTING,
      'a run started again under an idempotency key after the clock stepped back less than 5 seconds is not stamped after the run it replaces',
    );
    // Correction 1 (C-5): the law's edge case (store-clock-contract.ts, "at exactly ε it equals the
    // holder"; json-file-store-clock-715.test.ts B4 "the boundary").
    claim(
      TESTING,
      'At a step back of exactly 5 seconds the 5-second cap wins: that run is stamped equal to the run it replaces, not after it',
    );
    claim(TESTING, "that run's time is lifted more than 5 seconds");
    // #616 PR-1a unit 16a: store-clock-in-memory.test.ts, "READS_ONE_READING counts the delete on its
    // own" (a) to (f), and C16.
    claim(
      TESTING,
      '`get`, `list` or `listWithDiagnostics` reads the clock other than once; `stampSeal`, `listRunIds` or `statAllForRun` reads it; `deleteAllForRun` fails, or reads the clock other than once when the adapter sets `recordsDeletionTime`, or at all when it does not (on the `clock` route only)',
    );
    // Correction 1 (C-4): store-clock-in-memory.test.ts (C16 with the hook; the wiring cell without it).
    claim(
      TESTING,
      "| `seedLegacyTerminal` | If the store has `stampSeal`: writes an ended run that has no record of how it ended into the store the route built for the case, past the store's own checks, and returns it; without it, the `READS_ONE_READING` case fails, saying that the hook is missing. |",
    );
    // #616 PR-1a unit 16a: store-clock-in-memory.test.ts, "READS_ONE_READING counts the delete on its
    // own": (a) true and one reading passes, (b) false or absent and one reading fails, (c) true and
    // none fails, (d) true with no deleteAllForRun fails saying so; the location route never reads
    // it (the law stops at its route check first: the location wiring's NOT_RUN).
    claim(
      TESTING,
      "| `recordsDeletionTime` | `true` if the store's `deleteAllForRun` stamps the time of the deletion, and so reads the clock once. `READS_ONE_READING` then counts that one reading; it counts readings, and cannot see the time the store records. Leave it out, or set it to `false`, for a store whose delete reads no clock. It is read on the `clock` route only. Set for a store with no `deleteAllForRun`, the `READS_ONE_READING` case fails, saying that the store has no delete. Added after version 0.48.0. |",
    );
    // C17; the location adapter's NOT_RUN (store-clock.contract.test.ts).
    claim(
      TESTING,
      "A failing case's message starts with its law's name. On the `location` route the reads cannot be counted, so a file running that route names `READS_ONE_READING`, `KEYED_FIRST_CREATE_ONE_READING` and `SNAPSHOT_AT_SOUND` in its `NOT_RUN`.",
    );
  });

  it('error-codes.md: STATE_TEST_CLOCK_FOREIGN', () => {
    // C3.
    // Correction 1 (C-6): C3 (the message), foreign-test-clock-715.test.ts (the first way out works).
    claim(
      CODES,
      "A run store was opened on a folder whose test clock file was made for another folder, as when a test location is copied. A store there would run on another location's test clock. The message names both folders and the three ways out: delete the folder's clock file to use it as an ordinary store, open the store at the folder the file names, or make a new test location with `createTestLocation` on a folder that has none. Added after version 0.48.0.",
    );
  });

  it('#616 PR-1a unit 16a: the CHANGELOG entry, sentence by sentence', () => {
    // in-memory-store.test.ts's 16a cells (the four cases; a store that leaves created out fails
    // them) and store-clock-in-memory.test.ts's 16a cells (the delete's own count, the wiring
    // failure).
    for (const sentence of [
      "**`runStoreFidelityContract` gains the law `CREATE_REPORTS_CREATED`, and `storeClockContract`'s adapter gains `recordsDeletionTime` (issue #616).**",
      "The law's four cases check that a create says whether it made a new run: `created: true` for a create with no idempotency key, for a key no run holds, and for a keyed create with `onTerminalMatch: 'rerun'` over an ended run, which makes a new run, with a different id, whose `rerun_of` names the run it replaces, in the result and when `get` reads it back; `created: false`, returning the live run, for a second create with the same key while the first run is live.",
      'A store whose `create` leaves `created` out now fails the law.',
      "A create resolves `{ record, at, created }`: a store that resolves another shape fails the case in the law's own words.",
      '`READS_ONE_READING` counts `deleteAllForRun` on its own, on the `clock` route: one reading when the adapter sets `recordsDeletionTime`, none when it does not.',
      'A store whose delete stamps the time of the deletion sets the field; set for a store with no `deleteAllForRun`, the `READS_ONE_READING` case fails.',
    ])
      claimChangelog(sentence);
  });

  it('#616 PR-2c c10a-4c: the CHANGELOG entry', () => {
    // ways-renderer.test.ts's and render-reply.test.ts's c10a-4c cells: each door's way out for a
    // copy with no file; answer-record-627.test.ts runs the printed command on a SQLite home.
    claimChangelog(
      "**A damaged registered copy sends the operator to `realm workflow validate --registered <id>`** in the MCP server's way out (the operator's command on `realm mcp`'s and `realm serve`'s person line), also when the copy has no file (the SQLite store's copies); only a copy that is not there says `realm workflow register <file>`. (#616)",
    );
  });

  it('the CHANGELOG entries, sentence by sentence', () => {
    for (const sentence of [
      // #616 PR-2c c10a-4b.
      '**No command reports "run files that could not be read" any more:** on the SQLite store a run is a row, so `realm run list`, `cleanup`, `reclaim`, `drain`, `purge` and `run migrate` print no such line, and `realm listen`\'s sweeper logs no skipped files. (#616)',
      // A1–A10, B2, B10.
      "**A run store's clock (issue #715).** `@sensigo/realm` exports `Clock`, `createSystemClock`, `systemClock`, `takeReading` and `floorAtHolder`.",
      '`JsonFileStore` and `InMemoryStore` have a `clock`, the time they stamp their writes with; `InMemoryStore` takes one: `new InMemoryStore({ clock })`.',
      // C7–C17.
      '**Test clocks and test locations (issue #715).** `@sensigo/realm-testing` exports `settableClock`, `steppingClock`, `countingClock`, `createTestLocation`, `createTestHome`, and the store contract `storeClockContract` with its laws `STORE_CLOCK_LAWS`.',
      "A test location's clock is the file `.realm-test-clock` beside its `runs/` folder.",
      // C3.
      'A store opened on a copy of a test location in another folder refuses with the new code `STATE_TEST_CLOCK_FOREIGN`.',
      // D1.
      '**`PerRunArtifactStore.deleteAllForRun` takes an optional `{ expectVersion }` (issue #715).** The store that holds the run record refuses a run whose version differs with `STATE_SNAPSHOT_MISMATCH`, and deletes nothing.',
      // D11.
      '**BREAKING — `WorkflowError.timestamp` is removed (issue #715).** A library caller that read it gets `undefined`.',
      // D2, D3, D5b; correction 1 (C-1): C-1a, C-1b, C-1c.
      '**`realm run purge` reports a run that changed after it was selected as blocked, and keeps its run file (issue #715).** A resumed run keeps its sentence; any other change reads `changed_since_selected`.',
      "Files that an artifact store had already deleted stay deleted. The run's line then ends with `(<bytes> across <n> of its artifact stores were already freed before the refusal)`.",
      'A resumed run\'s line then leaves out "refusing to purge its trace buffer".',
      'As in 0.48.0, a run that owes a cleanup step is blocked as `drain_pending` after its trace files and refused answers were deleted, and a dry run lists it among the runs that would be purged.',
      // B4, B1.
      '**A run started again under an idempotency key is stamped after the run it replaces when the clock stepped back by less than 5 seconds, and each `create`, `update` and `claimStep` of a store stamps from one reading of the clock (issue #715).**',
    ]) {
      claimChangelog(sentence);
    }
  });
});

/** Every non-test `.ts` file under `packages/<pkg>/src`, repo-relative. */
function sources(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        if (name !== 'node_modules') walk(path);
      } else if (/\.ts$/.test(name) && !/\.(test|d)\.ts$/.test(name)) {
        out.push(relative(ROOT, path));
      }
    }
  };
  for (const pkg of readdirSync(join(ROOT, 'packages'))) {
    try {
      walk(join(ROOT, 'packages', pkg, 'src'));
    } catch {
      // a package with no src
    }
  }
  return out;
}

describe('#715 (a) — the facts two docs sentences rest on', () => {
  it('the clock’s reach: only the two stores take a reading (core-library.md, "times taken outside the store")', () => {
    // #616 unit 8: a store can take its reading in two halves, `takeRawReading` and then the pure
    // `foldReading` (the SQLite write path takes the raw one; its bodies fold it), so the cell counts
    // every caller of the three, outside the module that defines them.
    // (a) red when a module not listed calls `takeReading(`, `takeRawReading(` or `foldReading(`,
    //     or a listed one stops; (b) prints the files.
    const callers = sources().filter(
      (file) =>
        file !== join('packages', 'core', 'src', 'store', 'take-reading.ts') &&
        read(file)
          .split('\n')
          .some(
            (line) =>
              /\b(?:takeReading|takeRawReading|foldReading)\(/.test(line) &&
              !/^\s*(\/\/|\*)/.test(line),
          ),
    );
    expect(callers.sort(), callers.join(', ')).toEqual([
      // A test double of what a store writes: it stamps a snapshot with the system clock.
      'packages/cli/src/test-support/snapshot-double.ts',
      'packages/core/src/store/json-file-store.ts',
      'packages/core/src/test-support/snapshot-double.ts',
      'packages/mcp-server/src/test-support/snapshot-double.ts',
      // #616 unit 8: the SQLite write path takes each call's raw reading.
      'packages/store-sqlite/src/connection.ts',
      // #616 unit 12b: the SQLite run store's update and claimStep take the call's one raw reading and fold it
      'packages/store-sqlite/src/run-store.ts',
      // The fenced contract's run reader returns a read's reading, as a store's read does.
      'packages/testing/src/store/fence-run-source.ts',
      'packages/testing/src/store/in-memory-store.ts',
      // #715 (b) B.3: the TCK's own fixture store (`LossyFixtureStore`) reads its clock as a store.
      'packages/testing/src/store/settlement-contract.ts',
    ]);
  });

  it('the testing package exports 31 types (testing-package.md, "The 31 types")', () => {
    // (a) red when a type is added or dropped without the page; (b) prints the count.
    const index = read('packages/testing/src/index.ts');
    const names = [...index.matchAll(/export type \{([^}]*)\}/g)].flatMap((m) =>
      m[1]!
        .split(',')
        .map((n) => n.trim())
        .filter((n) => n !== ''),
    );
    expect(new Set(names).size, names.join(', ')).toBe(31);
  });
});
