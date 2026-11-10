// docs-715b.test.ts — issue #715 (b) 04 §E (guardrail 7(f), 9): every docs sentence this unit's
// commit 4 adds or changes is quoted here word for word and asserted to be on its page, read from the
// repository; the behaviour each states is pinned in the cell named in its comment. Some checks are
// GENERATED from the code, so the page cannot drift from it: the five classes' table from core's
// `CLOCK_READ_CLASSES`, the store contracts' law rows from `STORE_CLOCK_LAWS` and
// `RUN_STORE_FIDELITY_LAWS`, and the store clock contract's counts from the cases it returns; since
// correction 1 (C-3, C-4), the settlement contract's laws, case counts and adapter fields, the
// exported functions that still take a `now`, this unit's new public names, and the findings that do
// not select a run in `--stuck`. The adapter fields, the functions and the names are read from the
// built declarations (`dist/index.d.ts`, what a program that imports the package compiles against)
// with the TypeScript compiler, as `clock-census-715b.test.ts` reads the source: an interface and a
// type are not there at run time. Two claims are executed here (a reply's `as_of` is not a change
// cursor; the settlement cases that move the clock fail without `route`, saying so).
//
// Each assertion names (a) the change that turns it red and (b) what it prints when it fails: the
// sentence, the class, the law or the counts (never an environment or a path under a real home).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { CLOCK_READ_CLASSES, RUN_HEALTH_STUCK_EXCLUDED, stampOf } from '@sensigo/realm';
import {
  InMemoryStore,
  RUN_STORE_FIDELITY_LAWS,
  SETTLEMENT_LAWS,
  STORE_CLOCK_LAWS,
  defaultSettlementFixture,
  settableClock,
  settlementContract,
  storeClockContract,
  type SettlementContractAdapter,
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

/** The text of a page's section from its heading to the next heading of the same or a higher level. */
function section(page: string, heading: string): string {
  const text = read(page);
  const start = text.indexOf(`${heading}\n`);
  if (start < 0) return '';
  const level = /^#+/.exec(heading)![0];
  const next = text.slice(start + heading.length).search(new RegExp(`\\n#{1,${level.length}} `));
  return next < 0 ? text.slice(start) : text.slice(start, start + heading.length + next);
}
/** A CHANGELOG entry of this unit's section, from its bold opening to the next entry. */
function changelogEntry(opening: string): string {
  const text = read('CHANGELOG.md');
  const start = text.indexOf(`- ${opening}`);
  if (start < 0) return '';
  const end = text.indexOf('\n- ', start + 2);
  return flat(text.slice(start, end < 0 ? undefined : end));
}

/**
 * The public surface of `@sensigo/realm` and `@sensigo/realm-testing`, as their built declarations
 * declare it (one compiler program, made once for this file).
 */
let surface: { checker: ts.TypeChecker; core: ts.Symbol[]; testing: ts.Symbol[] } | undefined;
function publicSurface(): NonNullable<typeof surface> {
  if (surface !== undefined) return surface;
  const core = join(ROOT, 'packages', 'core', 'dist', 'index.d.ts');
  const testing = join(ROOT, 'packages', 'testing', 'dist', 'index.d.ts');
  const program = ts.createProgram([core, testing], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
  });
  const checker = program.getTypeChecker();
  const exportsOf = (file: string): ts.Symbol[] =>
    checker.getExportsOfModule(checker.getSymbolAtLocation(program.getSourceFile(file)!)!);
  surface = { checker, core: exportsOf(core), testing: exportsOf(testing) };
  return surface;
}
/** The symbol an export names (through `export { … } from` and `export *`). */
function resolved(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
  return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

const CORE = 'docs/reference/core-library.md';
const TESTING = 'docs/reference/testing-package.md';
const ENV = 'docs/reference/environment-and-files.md';
const TEMPLATES = 'docs/reference/workflow/input-map-and-templates.md';
const TOOLS = 'docs/reference/mcp/tools.md';
const HEALTH = 'docs/reference/mcp/run-state-and-health.md';
const ACTING = 'docs/reference/cli/realm-run-acting.md';
const READING = 'docs/reference/cli/realm-run-reading.md';

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

  it('settlementContract (correction 1, C-3): the law count and list, the case counts and the adapter table are the contract’s', () => {
    // (a) red when the page's count, law list, case counts or adapter fields drift from the contract
    //     (the 56 / 146 / 55 / 142 and the missing `route` row this correction found), or the row of
    //     a store with neither `settleStep` nor `stampSeal` comes back; (b) prints the page's and the
    //     contract's values side by side. Every case passing is pinned by the testing package's own
    //     settlement-in-memory-store.test.
    const store = new InMemoryStore();
    const adapter = (hook: boolean): SettlementContractAdapter => ({
      store,
      storeName: 'InMemoryStore',
      settlementFixture: defaultSettlementFixture,
      route: { kind: 'clock', makeStore: ({ clock }) => new InMemoryStore({ clock }) },
      ...(hook
        ? {
            // The page's hook: the run put straight into the store's map of runs.
            seedLegacyTerminal: async (id: string) => {
              const { record: run } = await store.create({
                workflowId: `tck-seed-${id}`,
                workflowVersion: 1,
                params: {},
              });
              const legacy = {
                ...run,
                id,
                completed_steps: ['a'],
                terminal_state: true,
                terminal_reason: 'Workflow completed.',
                run_phase: 'completed' as const,
              };
              (store as unknown as { runs: Map<string, typeof legacy> }).runs.set(id, legacy);
              return legacy;
            },
          }
        : {}),
    });
    const all = settlementContract(adapter(true));
    const withoutHook = settlementContract(adapter(false));
    const lawsWithCases = new Set(all.map((c) => c.law));
    const text = section(TESTING, '### `settlementContract(adapter)`');
    // The adapter table: the section's first table, its first cells.
    const tableFields = text
      .split('\n\n')
      .find((block) => block.startsWith('| Adapter field'))!
      .split('\n')
      .slice(2)
      .map((line) => line.split('|')[1]!.trim().replace(/`/g, ''));
    const { checker, testing } = publicSurface();
    const iface = resolved(
      checker,
      testing.find((s) => s.getName() === 'SettlementContractAdapter')!,
    );
    const interfaceFields = checker
      .getDeclaredTypeOfSymbol(iface)
      .getProperties()
      .map((p) => p.getName());
    const listed = /The (\d+) laws:\n\n```text\n([\s\S]*?)\n```/.exec(text);
    expect({
      row: row(TESTING, '`settlementContract`')?.slice(2),
      count: listed?.[1],
      laws: (listed?.[2] ?? '')
        .split(/[,\s]+/)
        .filter(Boolean)
        .sort(),
      fields: tableFields.sort(),
      noCaseRow: text.includes('neither `settleStep` nor `stampSeal`'),
    }).toEqual({
      row: [String(SETTLEMENT_LAWS.length), `${all.length}, with \`InMemoryStore\` (below)`],
      count: String(SETTLEMENT_LAWS.length),
      laws: [...SETTLEMENT_LAWS].sort(),
      fields: interfaceFields.sort(),
      noCaseRow: false,
    });
    // The case counts, each in the sentence that states it; the law without a case is the wiring
    // one, and the hook's absence removes `STAMP_CLASSIFIED_ROUNDTRIP`'s. (A copy of the list is
    // filtered: release-line-witness takes a test file that filters a law list itself for a runner.)
    expect({
      withoutCase: [...SETTLEMENT_LAWS].filter((l) => !lawsWithCases.has(l)),
      stampClassifiedWithoutHook: withoutHook.some((c) => c.law === 'STAMP_CLASSIFIED_ROUNDTRIP'),
    }).toEqual({ withoutCase: ['ADAPTER_WIRING'], stampClassifiedWithoutHook: false });
    claim(
      TESTING,
      `With \`InMemoryStore\`, \`defaultSettlementFixture\`, a \`route\` that builds an \`InMemoryStore\` on the case's clock and a \`seedLegacyTerminal\` that puts the run straight into the store's map of runs, ${lawsWithCases.size} of the laws have cases, ${all.length} in all, and all of them pass.`,
    );
    claim(
      TESTING,
      `Without \`seedLegacyTerminal\`, \`STAMP_CLASSIFIED_ROUNDTRIP\` has no case and a \`STAMP_PRESERVES_UPDATED_AT\` case fails, saying that the hook is missing: ${withoutHook.length} cases.`,
    );
    // #616 PR-2c c4-i: the counts table's note names the settlement contract's skips on this store.
    // (a) red when the number drifts from the cases the contract registers as skipped; (b) prints the
    // sentence.
    claim(
      TESTING,
      `the ${all.filter((c) => c.skipped === true).length} the settlement contract reports as skipped for \`InMemoryStore\``,
    );
  });

  it('#616 PR-1a unit 16a: the storeClockContract adapter table names exactly the adapter’s fields', () => {
    // (a) red when the adapter gains or loses a field without its row (the `recordsDeletionTime`
    //     row this unit adds), or a row names no field; (b) prints the table's fields beside the
    //     interface's, read from the built declarations.
    const tableFields = section(TESTING, '### `storeClockContract(adapter)`')
      .split('\n\n')
      .find((block) => block.startsWith('| Adapter field'))!
      .split('\n')
      .slice(2)
      .map((line) => line.split('|')[1]!.trim().replace(/`/g, ''));
    const { checker, testing } = publicSurface();
    const iface = resolved(
      checker,
      testing.find((s) => s.getName() === 'StoreClockContractAdapter')!,
    );
    const interfaceFields = checker
      .getDeclaredTypeOfSymbol(iface)
      .getProperties()
      .map((p) => p.getName());
    expect(tableFields.sort()).toEqual(interfaceFields.sort());
  });

  it('settlementContract (correction 1, C-3): without `route`, the cases that move the clock fail saying so, and the other cases run', async () => {
    // Executes the page's `route` row: every case of the contract, each on a fresh adapter (as the
    // page says to), with no `route`. (a) red when a case without its route passes, fails with a
    // message that does not name `route`, or no case needs it; (b) prints the failures' laws and
    // first words.
    const failures: string[] = [];
    let passed = 0;
    const fresh = (): ReturnType<typeof settlementContract> =>
      settlementContract({
        store: new InMemoryStore(),
        storeName: 'InMemoryStore',
        settlementFixture: defaultSettlementFixture,
      });
    const count = fresh().length;
    for (let i = 0; i < count; i++) {
      const c = fresh()[i]!;
      try {
        await c.run();
        passed += 1;
      } catch (e) {
        failures.push(`${c.law}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    // Without the hook, one STAMP_PRESERVES_UPDATED_AT case fails for the hook (the page's sentence).
    const routeFailures = failures.filter((f) => !f.includes('seedLegacyTerminal'));
    expect({
      someNeedRoute: routeFailures.length > 0,
      notNamingRoute: routeFailures.filter((f) => !f.includes('the adapter must supply `route`')),
      othersRan: passed + failures.length === count && passed > 0,
    }).toEqual({ someNeedRoute: true, notNamingRoute: [], othersRan: true });
    claim(
      TESTING,
      'Without it, each of those cases fails with a message that says the adapter must supply `route`; the other cases run. Added after version 0.48.0.',
    );
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

  it('realm-run-reading.md: the --stuck row names the findings that do not select a run (correction 1, C-4.4)', () => {
    // The names are core's own set (`RUN_HEALTH_STUCK_EXCLUDED`, the selection's: stuck-kinds-715b);
    // run-state-and-health.md's "five findings do not select a run" says the same. (a) red when the row
    // stops naming them, or the set gains or loses a finding the row does not follow; (b) prints the
    // sentence.
    claim(
      READING,
      `Lists only runs that have a health finding. These findings do not select a run: ${[
        ...RUN_HEALTH_STUCK_EXCLUDED,
      ]
        .map((k) => `\`${k}\``)
        .join(', ')}. Cannot be combined with \`--status\`.`,
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
  it('the new exports: each of this unit’s public names is exported and named in the line; the laws are the contracts’', () => {
    // THIS unit's additions to `@sensigo/realm`'s public surface, as a compiler scan of core's index
    // found them against main 941bc877 (correction 1, C-4.3: 29 names, none removed; 26 in `index.ts`
    // and `Listing`, `CreateResult`, `StoreSettlement` through `export *`). It pins these names, not
    // names a later unit adds. (a) red when one of them is no longer exported (removed or renamed),
    // or the CHANGELOG line stops naming it, or a law the line lists is not in its contract's list;
    // (b) prints the names missing.
    const ADDED_BY_715B = [
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
      'waysStoreOf',
      'recordStampedAheadOf',
      'CLOCK_READ_CLASSES',
      'RUN_HEALTH_KINDS',
      'RUN_HEALTH_STUCK_EXCLUDED',
      'REMINDER_BASIS_CLAUSE',
      'ClockReadClass',
      'Listing',
      'CreateResult',
      'StoreSettlement',
      'OpeningGate',
      'SealRunDelta',
      'ReminderSchedule',
      'ReminderOccurrence',
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
    const exported = new Set(publicSurface().core.map((s) => s.getName()));
    const line = changelogEntry('**New exports (issue #715).**');
    expect({
      names: ADDED_BY_715B.length,
      notExported: ADDED_BY_715B.filter((n) => !exported.has(n)),
      notInTheLine: ADDED_BY_715B.filter((n) => !line.includes(`\`${n}\``)),
      notLaws: namedInTheLine.filter((l) => !(STORE_CLOCK_LAWS as readonly string[]).includes(l)),
      fence: (RUN_STORE_FIDELITY_LAWS as readonly string[]).includes(
        'DRIVE_FAILURE_KEEPS_ITS_FENCE',
      ),
    }).toEqual({ names: 29, notExported: [], notInTheLine: [], notLaws: [], fence: true });
  });

  it('the functions that still take a `now` are each named in the line (a compiler scan of core’s exports)', () => {
    // Correction 1, C-4.2: the headline said Realm's functions take no `now`. The scan lists every
    // exported function with a parameter named `now`, and every one with a parameter whose type (any
    // member of a union) has a field `now` of type `Date`, so a new one cannot slip in unnamed: 13 by
    // parameter; `composePersonNotice` (a reminder's event) and `describeAnswerEnding` (the answer) by
    // field. A `Clock`'s `now` is a method that reads the clock, not a time given, and is not counted.
    // (a) red when a function the scan finds is not named in its place in the line, or the line names
    // one that no longer takes a `now`; (b) prints both lists.
    const { checker, core } = publicSurface();
    const byParameter: string[] = [];
    const byField: string[] = [];
    const isDate = (s: ts.Symbol): boolean =>
      checker.typeToString(checker.getTypeOfSymbolAtLocation(s, s.valueDeclaration!)) === 'Date';
    for (const symbol of core) {
      const target = resolved(checker, symbol);
      if (!(target.flags & ts.SymbolFlags.Value) || target.valueDeclaration === undefined) continue;
      const type = checker.getTypeOfSymbolAtLocation(target, target.valueDeclaration);
      for (const signature of type.getCallSignatures()) {
        for (const parameter of signature.getParameters()) {
          const parameterType = checker.getTypeOfSymbolAtLocation(
            parameter,
            parameter.valueDeclaration!,
          );
          const members = parameterType.isUnion() ? parameterType.types : [parameterType];
          if (parameter.getName() === 'now') byParameter.push(symbol.getName());
          else if (
            members.some((m) => {
              const field = m.getProperty('now');
              return field !== undefined && isDate(field);
            })
          )
            byField.push(symbol.getName());
        }
      }
    }
    const line = changelogEntry(
      "**BREAKING — Realm's functions that judge a run take the run as read (issue #715).**",
    );
    const parameterNames = /as a parameter `now`: (.*?); and /.exec(line)?.[1] ?? '';
    const fieldNames = /; and (.*?) take it as a field `now`/.exec(line)?.[1] ?? '';
    expect({
      byParameter: [...new Set(byParameter)].sort(),
      byField: [...new Set(byField)].sort(),
    }).toEqual({
      byParameter: [...parameterNames.matchAll(/`(\w+)`/g)].map((m) => m[1]).sort(),
      byField: [...fieldNames.matchAll(/`(\w+)` \(/g)].map((m) => m[1]).sort(),
    });
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
    // Correction 1, C-3: this file's settlementContract cells (the `route` failures, the two laws in
    // the generated list); the empty pass is gone with the store without settleStep (D-19).
    claimChangelog(
      'Its `settlementContract` adapter must supply `route`, which builds a store on a clock the case sets; the contract gains the laws `SEAL_RUN_NEEDS_NO_DEFINITION` and `ROUTE_CLOCK_IS_STORE_CLOCK`, and a store with neither `settleStep` nor `stampSeal` no longer passes with no cases.',
    );
    // clock-poison-715b (the engine reads no host clock); cleanup-judge-715b (stale at its deadline);
    // the functions that still take a `now`: the scan cell above (correction 1, C-4.2).
    claimChangelog(
      "**BREAKING — Realm's functions that judge a run take the run as read (issue #715).** The engine reads time only through the store's clock.",
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
    // pace-715b; door-627 "Amendment 12b" cells (2b: the hand-over only when the question's own
    // deadline sets `until`; 3: beside an earlier held step, its own deadline and no hand-over).
    claimChangelog(
      '**An MCP reply that waits says check back at the next deadline (issue #715).**',
    );
    claimChangelog(
      "The await entry names the question's own deadline: as `until` when it is `until`, and as its own when another deadline sets `until`; a question that changes the run, and whose deadline sets `until` more than 5 minutes away, is handed over: tell the user to come back then.",
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
