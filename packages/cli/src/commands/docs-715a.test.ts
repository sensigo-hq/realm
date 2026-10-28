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
      "The file store stamps the times it writes, such as a run's `created_at` and `updated_at`, with this computer's clock.",
    );
    // D6-29(a): a statement of support, pinned by this cell alone.
    claim(
      ENV,
      'A file store on a folder that several computers share is not supported: each computer would stamp with its own clock.',
    );
    // C4, C14 (the file beside runs/); the lint cell (only the testing package makes one).
    claim(
      ENV,
      'A folder with a `.realm-test-clock` file beside its `runs/` folder is a test location.',
    );
    claim(ENV, 'Only `@sensigo/realm-testing` makes one, for tests.');
    // C2 (create), B2 (update, claimStep at a location), C15 (another process).
    claim(
      ENV,
      'A store opened there takes the time from that file when it creates a run, starts a step or writes a run with `update`, so every process that opens the folder reads the same time (added after version 0.48.0).',
    );
    // C3.
    claim(
      ENV,
      'The file names the folder it was made for: a store opened on a copy of it in another folder refuses with `STATE_TEST_CLOCK_FOREIGN`.',
    );
  });

  it('realm-run-acting.md: purge reports a run that changed after it was selected', () => {
    // D2, D3, D5b.
    claim(
      ACTING,
      'A run that changed after `purge` selected it keeps all its files and is reported `blocked`: a run that was resumed with the sentence that it is no longer terminal, and any other change, such as a cleanup step that completed, as `changed_since_selected` (added after version 0.48.0).',
    );
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
    // B1 J10, J11–J15; B10 M7.
    claim(CORE, 'In this version `settleStep`, `stampSeal` and the reads do not use it.');
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
      '`systemClock` is the clock a store uses when it is given none; its `at` throws, because it has nowhere to report a failure.',
    );
    // A8, A7.
    claim(
      CORE,
      "`takeReading(clock, record?)` reads the clock once for a write. When the record's `updated_at` is ahead of the clock, the reading moves up to it, but by 5 seconds at most.",
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
    // C14, C15.
    claim(
      TESTING,
      'A test location: a folder with `runs/` and a `.realm-test-clock` file. Its `clock` moves the time in that file, so a `JsonFileStore` opened on its `runsDir`, in this process or another, reads it. `remove()` deletes the folder.',
    );
    // C9; C7, C7b; C8.
    claim(
      TESTING,
      '`set` to an earlier time runs nothing and moves the clock back. A function given to `at` sees the clock at its own time, never earlier. An `advance` runs every due function even when some throw, then rejects with their errors.',
    );
    // The lint cell (lint-test-location-715.test.ts).
    claim(
      TESTING,
      "A lint rule keeps `createTestLocation`, and the clock file's helpers `@sensigo/realm` exports for this package, out of every module that is not a test or this package: production code never makes or reads a test clock.",
    );
    // The type count cell below.
    claim(TESTING, 'The 30 types are named in the group that uses them.');
    // C16 (the family takes an adapter and returns cases).
    claim(
      TESTING,
      'Each of the 5 contract functions takes an adapter that describes your store and returns a list of cases.',
    );
    claim(
      TESTING,
      '| `storeClockContract` | `RunStore`, on a clock the test moves | 5 | 5, with `InMemoryStore` |',
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
    // C17, one row per law.
    claim(
      TESTING,
      "a `create`, `update` or `claimStep` records a time other than the clock's, or (on the `clock` route) reads the clock more or less than once, refused or not",
    );
    claim(
      TESTING,
      "a write after the clock stepped back behind a record is not stamped with the record's time, or with the clock's time plus 5 seconds when the record is further ahead",
    );
    claim(
      TESTING,
      'a run started again under an idempotency key after the clock stepped back less than 5 seconds is not stamped after the run it replaces',
    );
    claim(TESTING, "that run's time is lifted more than 5 seconds");
    claim(TESTING, '`get`, `list` or `stampSeal` reads the clock (on the `clock` route only)');
    // C17; the location adapter's NOT_RUN (store-clock.contract.test.ts).
    claim(
      TESTING,
      "A failing case's message starts with its law's name. On the `location` route the reads cannot be counted, so a file running that route names `READS_SPEND_NO_READING` in its `NOT_RUN`.",
    );
  });

  it('error-codes.md: STATE_TEST_CLOCK_FOREIGN', () => {
    // C3.
    claim(
      CODES,
      "A run store was opened on a folder whose test clock file was made for another folder, as when a test location is copied. A store there would run on another location's test clock. The message names both folders and the two ways out: make a test location there with `createTestLocation`, or open the store at the folder the file names. Added after version 0.48.0.",
    );
  });

  it('the CHANGELOG entries, sentence by sentence', () => {
    for (const sentence of [
      // A1–A10, B2, B10.
      "**A run store's clock (issue #715).** `@sensigo/realm` exports `Clock`, `createSystemClock`, `systemClock`, `takeReading` and `floorAtHolder`.",
      '`JsonFileStore` and `InMemoryStore` have a `clock`, the time they stamp their writes with; `InMemoryStore` takes one: `new InMemoryStore({ clock })`.',
      // C7–C17.
      '**Test clocks and test locations (issue #715).** `@sensigo/realm-testing` exports `settableClock`, `steppingClock`, `countingClock`, `createTestLocation`, and the store contract `storeClockContract` with its laws `STORE_CLOCK_LAWS`.',
      "A test location's clock is the file `.realm-test-clock` beside its `runs/` folder.",
      // C3.
      'A store opened on a copy of a test location in another folder refuses with the new code `STATE_TEST_CLOCK_FOREIGN`.',
      // D1.
      '**`PerRunArtifactStore.deleteAllForRun` takes an optional `{ expectVersion }` (issue #715).** The store that holds the run record refuses a run whose version differs with `STATE_SNAPSHOT_MISMATCH`, and deletes nothing.',
      // D11.
      '**BREAKING — `WorkflowError.timestamp` is removed (issue #715).** A library caller that read it gets `undefined`.',
      // D2, D3, D5b.
      '**`realm run purge` reports a run that changed after it was selected as blocked, and deletes none of its files (issue #715).** A resumed run keeps its sentence; any other change reads `changed_since_selected`.',
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
    // (a) red when a module outside the stores calls `takeReading(`; (b) prints the files.
    const callers = sources().filter((file) =>
      read(file)
        .split('\n')
        .some(
          (line) =>
            /\btakeReading\(/.test(line) &&
            !/^\s*(\/\/|\*)/.test(line) &&
            !/function takeReading/.test(line),
        ),
    );
    expect(callers.sort(), callers.join(', ')).toEqual([
      'packages/core/src/store/json-file-store.ts',
      'packages/testing/src/store/in-memory-store.ts',
    ]);
  });

  it('the testing package exports 30 types (testing-package.md, "The 30 types")', () => {
    // (a) red when a type is added or dropped without the page; (b) prints the count.
    const index = read('packages/testing/src/index.ts');
    const names = [...index.matchAll(/export type \{([^}]*)\}/g)].flatMap((m) =>
      m[1]!
        .split(',')
        .map((n) => n.trim())
        .filter((n) => n !== ''),
    );
    expect(new Set(names).size, names.join(', ')).toBe(30);
  });
});
