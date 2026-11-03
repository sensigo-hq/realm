// docs-715b.test.ts — issue #715 (b) 04 §E (guardrail 7(f), 9): every docs sentence this unit's
// commit 4 adds or changes is quoted here word for word and asserted to be on its page, read from the
// repository; the behaviour each states is pinned in the cell named in its comment. Three checks are
// GENERATED from the code, so the page cannot drift from it: the five classes' table from core's
// `CLOCK_READ_CLASSES`, the store contracts' law rows from `STORE_CLOCK_LAWS` and
// `RUN_STORE_FIDELITY_LAWS`, and the store clock contract's counts from the cases it returns. One
// claim is executed here (a reply's `as_of` is not a change cursor).
//
// Each assertion names (a) the change that turns it red and (b) what it prints when it fails: the
// sentence, the class, the law or the counts (never an environment or a path under a real home).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as realm from '@sensigo/realm';
import { CLOCK_READ_CLASSES, stampOf } from '@sensigo/realm';
import {
  InMemoryStore,
  RUN_STORE_FIDELITY_LAWS,
  STORE_CLOCK_LAWS,
  settableClock,
  storeClockContract,
} from '@sensigo/realm-testing';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const flat = (t: string): string => t.replace(/\s+/g, ' ');
const read = (page: string): string => readFileSync(join(ROOT, page), 'utf8');
/** (a) red when the page no longer holds the sentence word for word; (b) prints the sentence. */
function claim(page: string, sentence: string): void {
  expect(flat(read(page)), `${page} no longer says: ${sentence}`).toContain(flat(sentence));
}
/** #871's form: the section that holds this unit's entries — `[Unreleased]` until a release renames
 *  it, then the first release section above `[0.48.0]`. (a) red when it no longer holds the sentence;
 *  (b) prints the sentence. */
function claimChangelog(sentence: string): void {
  const text = read('CHANGELOG.md');
  const start = text.includes('## [Unreleased]')
    ? text.indexOf('## [Unreleased]')
    : text.indexOf('\n## [') + 1;
  const section = text.slice(start, text.indexOf('\n## [0.48.0]'));
  expect(flat(section), `the CHANGELOG no longer says: ${sentence}`).toContain(flat(sentence));
}
/** The cells of a Markdown table row whose first cell is `first` (trimmed), or undefined. */
function row(page: string, first: string): string[] | undefined {
  const line = read(page)
    .split('\n')
    .find((l) => l.startsWith('|') && l.split('|')[1]?.trim() === first);
  return line
    ?.split('|')
    .slice(1, -1)
    .map((c) => c.trim());
}

const CORE = 'docs/reference/core-library.md';
const TESTING = 'docs/reference/testing-package.md';
const ENV = 'docs/reference/environment-and-files.md';
const TEMPLATES = 'docs/reference/workflow/input-map-and-templates.md';
const TOOLS = 'docs/reference/mcp/tools.md';
const HEALTH = 'docs/reference/mcp/run-state-and-health.md';
const ACTING = 'docs/reference/cli/realm-run-acting.md';

describe('#715 (b) 04 §E — core-library.md: a store’s clock', () => {
  it('systemClock’s `at` works and reports to the program’s sink; a test location’s clock runs its waiters', () => {
    // core clock.test.ts A6 (at works), S1 (the sink read at fire time), S2 (no sink: re-thrown), S3;
    // the CLI's sink: clock-sink-715b; the MCP bin's: server.ts's run-directly block (03 §A.1).
    claim(
      CORE,
      "Its `at` works as `createSystemClock`'s does, and passes a failure to the program's sink, which it reads when the function fails: `setClockErrorSink(sink)` sets the sink, once, when the program starts, and `clockErrorSink()` returns it (added after version 0.48.0, whose `systemClock` threw from `at`).",
    );
    claim(
      CORE,
      'With no sink set, the failure is thrown again as an uncaught exception, never dropped.',
    );
    claim(
      CORE,
      "The `realm` command and the `realm-mcp` server each set a sink that prints the error's message on standard error.",
    );
    // test-clock-file-watch-715b W1 (a rename past `when` wakes it), W4 (the poll alone), W5 (one
    // unreadable tick is no failure), W7 (50 in a row fail every waiter into the sink).
    claim(
      CORE,
      "runs a function given to `at` when the time in the location's clock file reaches `when`, in any program that has the store open: it watches the file's folder, and reads the file every 100 milliseconds while a function waits. When the file cannot be read 50 times in a row, every function waiting on it fails, and each failure goes to the program's sink (added after version 0.48.0).",
    );
  });

  it('the five classes: the table on the page is CLOCK_READ_CLASSES, word for word, in its order', () => {
    // (a) red when a class or its words change in core and not on the page (or back); (b) prints the
    //     classes whose row differs. The census (clock-census-715b) classes every read by these.
    const page = read(CORE);
    const differ = Object.entries(CLOCK_READ_CLASSES)
      .filter(([cls, words]) => row(CORE, `\`${cls}\``)?.[1] !== words)
      .map(([cls]) => cls);
    const order = Object.keys(CLOCK_READ_CLASSES).map((cls) => page.indexOf(`| \`${cls}\``));
    expect({
      differ,
      ordered: order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1]!)),
    }).toEqual({
      differ: [],
      ordered: true,
    });
    claim(
      CORE,
      "Every time Realm reads is one of five classes. A store's clock gives the first three; the last two never come from it. `CLOCK_READ_CLASSES` holds the five, with these words (added after version 0.48.0):",
    );
    // clock-census-715b (both directions; every row's class is one of the five).
    claim(
      CORE,
      "Realm's own tests list every time its code reads, each under one class with its reason, and fail when a read is not listed.",
    );
  });

  it('a reply’s as_of is not a change cursor: two reads of an unchanged run carry one run_version and two as_of', async () => {
    // (a) red when as_of is the record's own stamp (a cursor) rather than the read's reading; (b)
    //     prints both stamps.
    const clock = settableClock(new Date('2031-05-06T07:08:09.000Z'));
    const store = new InMemoryStore({ clock });
    const { record } = await store.create({ workflowId: 'w', workflowVersion: 1, params: {} });
    const first = stampOf(await store.get(record.id));
    await clock.advance(60_000);
    const second = stampOf(await store.get(record.id));
    expect({ first, second }).toMatchObject({
      first: { as_of: '2031-05-06T07:08:09.000Z', run_version: 0 },
      second: { as_of: '2031-05-06T07:09:09.000Z', run_version: 0 },
    });
    claim(
      CORE,
      "A reply's `as_of` is the instant every statement about time in the reply was judged at. It is not when the run last changed: two replies about a run that did not change carry different `as_of`s when they were judged at different times.",
    );
  });

  it('what a store’s clock does not settle (D6-29, the residuals)', () => {
    // (a) The env page's statement of support (docs-715a), stated again here.
    claim(
      CORE,
      "**More than one computer.** A store's clock is one computer's. A `JsonFileStore` on a folder that several computers share is not supported: each computer would stamp with its own clock.",
    );
    // (b) the store clock contract's MONOTONE_CAPPED and KEYED_CREATE_ORDERS_AFTER_HOLDER (store-clock
    //     contract cells, both routes); a deadline judged at a reading: classifyClaim's boundary
    //     (cleanup-judge-715b) and the expiry's (format-instant-words-715b "exactly at the reading").
    claim(
      CORE,
      "**A step of the computer's clock.** After the clock steps forward, every program judges every deadline early by the size of the step; after it steps back, late. When the clock steps back by up to 5 seconds, a write is stamped no earlier than the run's last change; after a longer step back, it is stamped 5 seconds after the clock, earlier than that change. A run started again under an idempotency key after the clock stepped back by exactly 5 seconds carries the same `created_at` as the run it replaces.",
    );
    // (c) Measured, not a cell (04 §C: a cell would pin the lock library, not this repo):
    //     plans/issue-715/reference/dr-phase2/lockprobe.out. Realm's own tests are held to it by
    //     test-time-715b.
    claim(
      CORE,
      "**A test that fakes `Date`.** A `JsonFileStore` takes file locks, and the lock library judges a lock stale by the computer's clock. A test that fakes the global `Date` while another program uses the same store can make a held lock look stale, and that program takes it. Move a test location's clock instead.",
    );
    // (e), (f): the census's `outside` and `duration` rows (clock-census-715b) and the poison cell
    //     (clock-poison-715b: an engine entry on a stepping store clock reads no host clock).
    claim(
      CORE,
      "**Times outside a run.** A log line's time, a signature's time window, a `Retry-After` wait and the day a price applies come from this computer's clock, never the store's.",
    );
    claim(
      CORE,
      "**Durations.** How long a step, a request or a wait took is real elapsed time, never read from the store's clock.",
    );
    // (g) classifyClaim at the judging program's reading (cleanup-judge-715b; the reclaim cells).
    claim(
      CORE,
      '**Claims.** Whether a claim has lapsed is judged by its deadline against the reading of the program that judges it. Realm does not watch another program to see that it is still working.',
    );
    // (h) No writer rewrites a stored `resolved_message` (render-time-715b: a stored text is rendered
    //     once, absolute).
    claim(
      CORE,
      "**Text rendered before this version.** A gate's message rendered with `from_now` before version 0.48.0 stays as it was written: it says the time from when it was rendered.",
    );
    // (i) inspect-gate-expiry-render, list-gate-expiry-render ("no send is recorded").
    claim(
      CORE,
      '**Reminders.** `realm run inspect` and `realm run list` show when a reminder is scheduled. Realm records no reminder as sent.',
    );
    // (j) drive-failing-715b "a legacy entry … is judged by the stamp order, and says so".
    claim(
      CORE,
      '**Drive failures written before this version.** They carry no evidence count or question id. The `drive_failing` finding judges such an entry by its time, and says so: `basis: legacy_stamp_order`.',
    );
    // (k) stamped-ahead-715b; cleanup-judge-715b "a record stamped an hour ahead … is not idle".
    claim(
      CORE,
      "**A record stamped ahead.** A run whose last change is stamped more than 5 seconds after a reader's clock is reported with the finding `record_stamped_ahead`, not corrected, until a later write stamps it again. Such a run has no age yet: `realm run cleanup` does not select it until the clock passes its stamp.",
    );
    // (l) a statement of process (the store contracts are run by the store's author).
    claim(
      CORE,
      '**A store of your own.** It is checked against these rules only when you run the [store contracts](testing-package.md#store-contracts) on it. Run them again after you upgrade Realm.',
    );
  });

  it('judgedSnapshotOf, in the EngineReply paragraph', () => {
    // judged-snapshot-715b (i) the basis's snapshot, (iii) a copy carries none; judged-isolation-715b
    // (a call on a run that does not exist: undefined).
    claim(
      CORE,
      "`judgedSnapshotOf(reply)` returns the `{ record, at }` a reply was judged on: `at` is the reply's `basis.as_of`, and the record's `version` its `basis.run_version` (added after version 0.48.0). A program that writes words about a reply after the call judges them on it, and does not read the run again. It is kept beside the reply, never in it: a copy of the reply (`{ ...reply }`, `structuredClone`, or the reply sent as JSON) has none, and for a copy, or for a reply about a run the call could not read, it returns `undefined`.",
    );
  });
});

describe('#715 (b) 04 §E — testing-package.md: the store contracts', () => {
  it('every law of the store clock and fidelity contracts has its row; the store clock row’s counts are the contract’s', () => {
    // (a) red when a law is added without its row, or the counts drift (the 5 | 5 this unit found
    //     stale); (b) prints the missing laws and both counts.
    const cases = storeClockContract({
      storeName: 'InMemoryStore',
      route: { kind: 'clock', makeStore: ({ clock }) => new InMemoryStore({ clock }) },
    });
    const missing = [...STORE_CLOCK_LAWS, ...RUN_STORE_FIDELITY_LAWS].filter(
      (law) => row(TESTING, `\`${law}\``) === undefined,
    );
    expect({
      missing,
      storeClock: row(TESTING, '`storeClockContract`')?.slice(2),
      fidelityLaws: row(TESTING, '`runStoreFidelityContract`')?.[2],
    }).toEqual({
      missing: [],
      storeClock: [String(STORE_CLOCK_LAWS.length), `${cases.length}, with \`InMemoryStore\``],
      fidelityLaws: String(RUN_STORE_FIDELITY_LAWS.length),
    });
  });

  it('the two new laws’ rows', () => {
    // The store clock contract's READ_AT_CAPPED case (both routes); the fidelity contract's
    // DRIVE_FAILURE_KEEPS_ITS_FENCE case (run-store-fidelity.contract.test).
    claim(
      TESTING,
      "| `READ_AT_CAPPED` | a `get` or `list` of a record stamped more than 5 seconds after the clock does not judge it at the clock's time plus 5 seconds, of one up to 5 seconds after the clock at its own time, or of one behind the clock at the clock's time |",
    );
    claim(
      TESTING,
      "| `DRIVE_FAILURE_KEEPS_ITS_FENCE` | A failed drive's entry comes back with the evidence count and the open question's id it was written at, and one written without them comes back without them. Added after version 0.48.0. |",
    );
  });
});

describe('#715 (b) 04 §E — the other pages', () => {
  it('environment-and-files.md: the test-location notice and as_of_basis', () => {
    // test-clock-notice-715b (the CLI: once, with the location clock's instant; an ordinary store says
    // nothing); test-clock-basis-715b (MCP: a reply on a test clock carries it; a hand-built clock’s does not).
    claim(
      ENV,
      'The `realm` command and the `realm-mcp` server say once, on standard error, that they opened a store at a test location, on their first read of it: `this store runs on a test clock, now 2030-01-01T00:00:00.000Z`, with that read\'s time. An MCP reply judged on a test clock says so in its `basis`: `as_of_basis: "test_clock"` (added after version 0.48.0).',
    );
  });

  it('input-map-and-templates.md: from_now reads no clock', () => {
    // render-time-715b (the filter at the caller's instant; absolute in a stored text; a question's
    // stored message absolute, a step's prompt in a reply relative to the reply's as_of).
    claim(
      TEMPLATES,
      "`from_now` says how long before or after the reply's time (its `basis.as_of`) the date is, in a step's `prompt` and `instructions`, which are rendered for each reply. In a gate's `message`, which Realm stores on the run and shows later, it writes the date itself, such as `2026-01-28T14:05:00.000Z` (added after version 0.48.0, which read this computer's clock for both).",
    );
  });

  it('tools.md and run-state-and-health.md: basis — as_of is not a change cursor; as_of_basis', () => {
    // This file’s change-cursor cell; test-clock-basis-715b (MCP).
    const words =
      '`as_of` is the instant every statement about time in the reply was judged at, not when the run last changed. `as_of_basis: "test_clock"` when that instant is a test clock\'s (added after version 0.48.0).';
    claim(TOOLS, words);
    claim(HEALTH, words);
  });

  it('tools.md: the await entry names the question’s own deadline, one instant per noun (Amendment 12b)', () => {
    // door-627 "Amendment 12b, branch 2a / 2b / 3 / 3, no hand-over / 3 on the get_run_state door".
    claim(
      TOOLS,
      "The entry of a question with a deadline names that deadline: as `until` when it is `until`, and as the question's own when another deadline sets `until`, such as a step another program holds. When a question that changes the run sets `until` more than 5 minutes away, its entry says the question expires too far away to wait for: tell the user to come back then.",
    );
  });

  it('run-state-and-health.md: the sixteenth finding', () => {
    // stamped-ahead-715b (ε + 1 ms: the finding, its delta the raw lead; reader_at the raw reading);
    // stuck-kinds-715b (not a --stuck member).
    claim(
      HEALTH,
      "`record_stamped_ahead` is found on any run, open or ended: the run's last change is stamped more than 5 seconds after the clock of the program reading it, so one of the two clocks is off, and the finding cannot tell which. Its `evidence` holds `record_updated_at`, `reader_at` (the reader's own clock) and `delta_ms`. It does not select a run in `list --stuck`. Added after version 0.48.0.",
    );
  });

  it('realm-run-acting.md: cleanup keeps a run a live claim holds', () => {
    // cleanup-judge-715b "two days idle: a live claim is kept; a stale claim, a claim of unknown age
    // and no claim are swept"; selectors-715b (the command, each run at its own reading).
    claim(
      ACTING,
      'It leaves runs that are waiting at a gate, and a run whose step is held by a claim whose deadline has not passed; a claim past its deadline, or one with no recorded deadline, keeps nothing (added after version 0.48.0). Each run is judged at the time of the read that found it.',
    );
  });
});

describe('#715 (b) 04 §E — the CHANGELOG', () => {
  it('the new exports are exported, and the laws are the contracts’ (generated from the line)', () => {
    // (a) red when a name the line lists is not a runtime export of @sensigo/realm, or a law is not
    //     in its contract's list; (b) prints the names missing.
    const values = [
      'setClockErrorSink',
      'clockErrorSink',
      'takeRawReading',
      'floorAtRecord',
      'parseStamp',
      'formatInstantWords',
      'isIdleForCleanup',
      'judgedSnapshotOf',
      'reminderScheduleOf',
      'reminderScheduleWords',
      'withTestClockNotice',
      'testClockNoticeLine',
      'markTestClock',
      'isTestLocationClock',
      'clockBasis',
      'CLOCK_READ_CLASSES',
    ];
    // The law names the CHANGELOG line lists, checked against the contract's export — not a runner
    // (runners take their laws from the export: release-line-witness).
    const namedInTheLine = [
      'READ_AT_CAPPED',
      'READS_ONE_READING',
      'SNAPSHOT_AT_SOUND',
      'SETTLE_ONE_READING',
      'OPEN_GATE_MINTS_AT_AT',
      'LATE_ANSWER_ONE_WRITE',
      'SEAL_RUN_ONE_WRITE',
      'KEYED_FIRST_CREATE_ONE_READING',
    ];
    expect({
      notExported: values.filter((n) => (realm as Record<string, unknown>)[n] === undefined),
      notLaws: namedInTheLine.filter((l) => !(STORE_CLOCK_LAWS as readonly string[]).includes(l)),
      fence: (RUN_STORE_FIDELITY_LAWS as readonly string[]).includes(
        'DRIVE_FAILURE_KEEPS_ITS_FENCE',
      ),
    }).toEqual({ notExported: [], notLaws: [], fence: true });
    claimChangelog(
      `\`@sensigo/realm\` exports ${values
        .slice(0, -1)
        .map((n) => `\`${n}\``)
        .join(
          ', ',
        )} and \`CLOCK_READ_CLASSES\`, and the types \`ClockReadClass\`, \`Listing\`, \`StoreSettlement\`, \`OpeningGate\` and \`SealRunDelta\`.`,
    );
  });

  it('each entry, word for word (the behaviour each states is pinned in the cell named beside it)', () => {
    // clock.test A6, S1–S3; clock-sink-715b; test-clock-file-watch-715b.
    claimChangelog(
      "**A store's clock runs waits, and says when one fails (issue #715).** `systemClock`'s `at` runs a function at its time; it threw before.",
    );
    // test-clock-basis-715b; test-clock-notice-715b; judged-snapshot-715b.
    claimChangelog(
      'An MCP reply judged on a test clock carries `as_of_basis: "test_clock"` in its `basis`, and the `realm` command and the `realm-mcp` server say once, on standard error, that they opened a store at a test location.',
    );
    // stamped-ahead-715b; stuck-kinds-715b.
    claimChangelog(
      "**The finding `record_stamped_ahead` (issue #715).** A run whose last change is stamped more than 5 seconds after the reader's clock is reported, with both times. It does not select a run in `realm run list --stuck`.",
    );
    // pace-715b.
    claimChangelog(
      'It says which deadline set `poll_after_ms`: `gate_expiry`, `claim_deadline` or `fixed`.',
    );
    // The store contracts (WRITE_ONE_READING, READS_ONE_READING, SETTLE_ONE_READING); the admission
    // cells of commit 1 (a store with no clock or no settleStep).
    claimChangelog(
      '**BREAKING — every run store call returns the time it was judged at (issue #715).** `get`, `update` and `claimStep` return `{ record, at }`; `create` returns `{ record, at, created }`; `list` returns `{ snapshots, read_at, consistent_snapshot }`; `settleStep` returns its result with `at`. A store must have `clock` and `settleStep`: Realm refuses one without either with `VALIDATION_OPTION_INVALID`.',
    );
    // clock-poison-715b (the engine reads no host clock); cleanup-judge-715b (stale at its deadline).
    claimChangelog(
      "**BREAKING — Realm's functions take no `now` (issue #715).** The engine reads time only through the store's clock.",
    );
    // format-instant-words-715b; age-words-715b; slack-reminder-late-fire-715b; inspect/list
    // gate-expiry-render ("no send is recorded").
    claimChangelog('**Every age and deadline people read carries its time (issue #715).**');
    // age-words-715b (A7: list's column); list.test.
    claimChangelog(
      "**BREAKING — `realm run list`'s time column is the run's stored `updated_at`, in UTC with milliseconds (issue #715).** It was the time in this computer's local format.",
    );
    // Type-checked: each new shape is what its callers compile against.
    claimChangelog('**BREAKING — four signatures change (issue #715).**');
    // pace-715b; door-627 "Amendment 12b" cells.
    claimChangelog(
      '**An MCP reply that waits says check back at the next deadline (issue #715).**',
    );
    // cleanup-judge-715b; selectors-715b.
    claimChangelog(
      '**`realm run cleanup` no longer abandons a run whose step still has a live claim (issue #715).**',
    );
    // render-time-715b.
    claimChangelog('**BREAKING — `from_now` reads no clock (issue #715).**');
    // expiry-receipt-729 (re-pinned in commit 2); the late-answer cells (LATE_ANSWER_ONE_WRITE).
    claimChangelog('**BREAKING — `ExpiryReceipt.by_this_call` (issue #715).**');
    claimChangelog('**The refusal reason `gate_expired_pending` (issue #715).**');
  });
});
