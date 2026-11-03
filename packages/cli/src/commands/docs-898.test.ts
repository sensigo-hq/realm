// docs-898.test.ts — issue #898 S12 (guardrail 7(f), 9): each docs sentence that `--prompt-cache auto`
// reading the runner's price file adds or rewrites is quoted here word for word and asserted to be on
// its page, read from the repository; each is red on the page's old text. The behaviour each states is
// pinned in the cells named beside it: S1–S5 (`core/src/economics/auto-prices-898.test.ts`), S6
// (`testing/src/store/usage-record-law-600.test.ts`), S7, S8 and B.1
// (`agent/providers/anthropic-auto-prices-898.test.ts`), S7b (`agent/auto-prices.test.ts`), S9
// (`commands/auto-prices-898.test.ts`), S10 (`commands/inspect-auto-prices-898.test.ts`) and S11
// (`agent.test.ts` cell 12, `listen.test.ts`' caching line and cell 12). Each assertion names (a)
// the change that turns it red and (b) what it prints when it fails: the page and the sentence.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const flat = (t: string): string => t.replace(/\s+/g, ' ');
const read = (page: string): string => readFileSync(join(ROOT, page), 'utf8');
/** (a) red when the page no longer holds the sentence word for word; (b) prints the sentence. */
function claim(page: string, sentence: string): void {
  expect(flat(read(page)), `${page} no longer says: ${sentence}`).toContain(flat(sentence));
}
/** #871's form: the section that holds this unit's entry — `[Unreleased]` until a release renames
 *  it, then the first release section above `[0.48.0]`. */
function claimChangelog(sentence: string): void {
  const text = read('CHANGELOG.md');
  const start = text.includes('## [Unreleased]')
    ? text.indexOf('## [Unreleased]')
    : text.indexOf('\n## [') + 1;
  const section = text.slice(start, text.indexOf('\n## [0.48.0]'));
  expect(flat(section), `the CHANGELOG no longer says: ${sentence}`).toContain(flat(sentence));
}

const ECON = 'docs/reference/cache-economics.md';

describe('#898 S12 — the docs say what auto reads, when, and what it does without it', () => {
  it("cache-economics.md: the section's sentences, each with its pinning cell", () => {
    // The reach and the read count: S9 (a) once, (b) a file not named is not read, (e) a lone drive
    // and (f) OpenAI read none; S8 (no settle for short, long, off, or auto with no kept gap).
    claim(
      ECON,
      "On a drive `realm listen` starts with Anthropic, `--prompt-cache auto` chooses which cache lifetime to ask for from the gaps between the workflow's recent triggers, priced from this file. This section was added after version 0.48.0.",
    );
    claim(
      ECON,
      "`realm agent` reads the file once, when the drive starts, after the workflow and `realm.yaml` load. A drive with no measured gap reads no file: a drive `realm agent` starts on its own, and a workflow's first trigger since `realm listen` started. So do `--prompt-cache short`, `long` and `off`, OpenAI and a provider module.",
    );
    // The key and the row: S1 (the exact id, a dated id finding its undated key, the day, the base
    // tier) and readAutoPrices' cell (`auto-prices.test.ts`: the base row, the dated --model).
    claim(
      ECON,
      'The choice reads the entry of the id you pass to `--model`, as a request is priced: that id, else the id without a date at its end. Key your price file by the id you pass to `--model`: an entry keyed only by a dated id does not match an undated `--model`.',
    );
    claim(
      ECON,
      "The choice reads the price row in force when the drive starts, on the base tier: the price's own rates, never a tier's.",
    );
    // The costing rules: S2 rows 4–6 (never filled; an uncostable lifetime never chosen; a single
    // cache_write not read as a lifetime's write; the made-up and the real ratios).
    claim(
      ECON,
      "Each rate is divided by `input`. 5 minutes is costed only when the row states `cache_read` and `cache_write_5m`, and 1 hour only when it states `cache_read` and `cache_write_1h`. A lifetime the row cannot cost is never chosen, no rate is filled from another, and a single `cache_write` is not read as either lifetime's write.",
    );
    claim(
      ECON,
      'Over the last five gaps, a lifetime costs `cache_read` for a gap under 90% of it, else its write rate; no caching costs `input`. `auto` asks for the cheapest; on a tie, the longer lifetime.',
    );
    // The fallback: S2 rows 2–4, S3 (the 54-minute guard), S4 (input 0), S9 (b), (c), (d).
    claim(
      ECON,
      'When the file cannot price the choice — `runner.cache.economics` is not set, the file cannot be read or is not a valid price file, it has no entry for the model, it prices `input` at 0, or it has no `cache_read` or no write rate for either lifetime — `auto` asks for 1 hour when any of the last five gaps is under 54 minutes, and for no caching otherwise.',
    );
    // No shipped price: B.1 (the provider's constant holds lifetimes only) and S9 (b) (no file:
    // the fallback, never the installed list).
    claim(
      ECON,
      '`auto` reads only this file, never the installed price list. Realm ships no prices, for the choice either.',
    );
    // The words on every surface: S9 (a)–(d) (the start line, the record), S10 (inspect,
    // get_run_state, the cross cell).
    claim(
      ECON,
      "The drive's `Caching:` line, `realm run inspect`, `get_run_state` and each request's record (`cache_auto.prices`) say whether the choice was priced from your file, and why not when it was not.",
    );
    // The trust sentence: the separation check's economics line is pinned in
    // `lib/separation-check-627.test.ts` (`economics_writable`).
    claim(
      ECON,
      "The file decides which lifetime `auto` asks for, so a login that can change it can change that choice. The separation check's economics line shows whether this login can.",
    );
  });

  it("deployment-manifest.md: the economics row of the reload table (S9 (a): read at the drive's start)", () => {
    claim(
      'docs/reference/deployment-manifest.md',
      "| The economics file named by `runner.cache.economics` | The costs `realm mcp` and `realm serve` show: no, restart the process. Added after version 0.47.0. `auto`'s choice: yes. Each drive `realm listen` starts with Anthropic, `--prompt-cache auto` and measured gaps reads the file when it starts; other drives read no file. Added after version 0.48.0. |",
    );
  });

  it('realm-listen.md: the startup line (S11), the rule with the fallback and no shipped multiples (S2, S3), the example line (S9 (a))', () => {
    const LISTEN = 'docs/reference/cli/realm-listen.md';
    claim(
      LISTEN,
      'listen: caching {"anthropic":"auto: off, 5 minutes or 1 hour for each workflow, by the gaps between its recent triggers and the prices in runner.cache.economics","set_by":"realm listen\'s default"}',
    );
    claim(
      LISTEN,
      "The agent asks Anthropic for whichever of off, 5 minutes and 1 hour costs least over those gaps, at the prices in the runner's price file (`runner.cache.economics`; see [the cache economics file](../cache-economics.md)): a gap under 90% of a lifetime reads the cached instructions, a longer one writes them again, and off pays the input price.",
    );
    claim(
      LISTEN,
      'When the price file cannot price the choice (none is set, it cannot be read, or it has no entry or no rate for the model), the agent asks for 1 hour when any of those gaps is under 54 minutes, and for no caching otherwise. Realm uses no price of its own for the choice (added after version 0.48.0).',
    );
    claim(
      LISTEN,
      "Caching: Anthropic is asked to cache each step's fixed instructions for 1 hour (auto: the last 2 gaps between this workflow's triggers were about 7 minutes and 12 minutes; priced from your price file; realm listen's default; change it with realm listen --prompt-cache).",
    );
    // (a) red when the shipped multiples return; (b) prints which.
    const page = flat(read(LISTEN));
    expect(
      ['a tenth of the input price', '1.25 times for 5 minutes', 'twice for 1 hour'].filter((w) =>
        page.includes(w),
      ),
      'realm-listen.md still states shipped multiples',
    ).toEqual([]);
  });

  it('the guide realm-agent.md: auto priced from the file, else the fallback (S3, S9 (b))', () => {
    claim(
      'docs/guides/realm-agent.md',
      "On a drive that `realm listen` starts, `auto` asks for off, 5 minutes or 1 hour, whichever costs least over the gaps between the workflow's recent triggers at the prices in the runner's price file, `runner.cache.economics` (see [`realm listen`](../reference/cli/realm-listen.md#what-it-does-for-a-request)). When that file cannot price the choice, it asks for 1 hour when a recent gap is under 54 minutes, and for no caching otherwise (added after version 0.48.0).",
    );
  });

  it("realm-agent.md: the Caching line's examples with gaps and the prices clause (S10, S9 (a)–(c))", () => {
    const REF = 'docs/reference/cli/realm-agent.md';
    claim(
      REF,
      "or, for a drive that `realm listen` started, `(auto: the last 2 gaps between this workflow's triggers were about 7 minutes and 12 minutes; priced from your price file; realm listen's default; change it with realm listen --prompt-cache)`. On such a drive, after the gaps, it says where the choice took its prices: `priced from your price file`, or why it chose without them, as in `no price file (runner.cache.economics is not set), so 1 hour without prices` (added after version 0.48.0).",
    );
    claim(
      REF,
      "and when `auto` chose off, `Caching: off; Anthropic is asked to cache nothing (auto: the last gap between this workflow's triggers was about 2 hours; priced from your price file; realm listen's default; change it with realm listen --prompt-cache).`",
    );
  });

  it("realm-run-reading.md: the ask entry's prices clause, not_recorded included (S10)", () => {
    claim(
      'docs/reference/cli/realm-run-reading.md',
      "With `auto`, the brackets end with what it chose by and, after measured gaps, where its prices came from, as the drive's `Caching:` line says it: `asked for 1 hour (sent as 1 hour; realm listen's default; auto: the last 2 gaps between this workflow's triggers were about 7 minutes and 12 minutes; priced from your price file)`, and, when it chose off, `asked for no caching (realm listen's default; auto: the last gap between this workflow's triggers was about 2 hours; priced from your price file)`. A request with measured gaps recorded before Realm priced `auto` from the price file says `price source not recorded (this request was recorded before Realm priced auto from the price file)` instead (added after version 0.48.0).",
    );
  });

  it("run-record-and-export.md, run-state-and-health.md and testing-package.md: cache_auto.prices, the view's not_recorded, the store law (S5, S10, S6)", () => {
    claim(
      'docs/reference/run-record-and-export.md',
      "`prices` (added after version 0.48.0), only with kept gaps, says where the choice took its prices: `{ from: 'economics' }`, the runner's price file, with `excluded` (`['short']` or `['long']`) and `missing` (the write rate it lacks) when the file could not cost one lifetime; or `{ from: 'none', cause }`, the fallback, `cause` one of `no_file`, `economics_unreachable`, `economics_unreadable`, `model_unknown`, `input_zero` and `rate_missing` (with `missing`, the absent rates). Absent means no price was needed.",
    );
    claim(
      'docs/reference/mcp/run-state-and-health.md',
      "and, after measured gaps, `prices`: where the choice took its prices, as the record's `cache_auto.prices`, or `{ from: 'not_recorded' }` for a request recorded before Realm priced `auto` from the price file (`prices` added after version 0.48.0).",
    );
    claim(
      'docs/reference/testing-package.md',
      'Its `cache_auto` comes back with `prices` (added after version 0.48.0).',
    );
  });

  it('CHANGELOG.md: the #898 entry, as written', () => {
    claimChangelog(
      "**`--prompt-cache auto` now chooses from the prices in the runner's price file (`runner.cache.economics`); Realm uses no price of its own for the choice.** On a drive `realm listen` starts, with measured gaps, each cached lifetime is costed only when the file states its rates, and an option the file cannot cost is never chosen. When the file cannot price the choice — no file, a file that cannot be read or is not valid, no entry for the model, an input price of 0, or no read rate or no write rate for either lifetime — `auto` asks for 1 hour when any of the last five gaps is under 54 minutes, and for no caching otherwise. Each request's record (`cache_auto.prices`), the start line, `realm run inspect` and `get_run_state` say which happened and why. **Upgrading:** with no usable price file, such a drive no longer asks for 5 minutes, and it asks for 1 hour on some gap patterns where it asked for no caching before. A file without a 1-hour write rate never asks for 1 hour, and one without a 5-minute write rate never asks for 5 minutes. A file that gives only a single `cache_write` rate, or prices input at 0, is treated as not able to price the choice. Key the file by the id you pass to `--model`. (#898)",
    );
  });
});
