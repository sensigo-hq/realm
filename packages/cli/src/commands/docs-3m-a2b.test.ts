// docs-3m-a2b.test.ts — caching 3-M piece A-2b (guardrail 7(f), 9): each docs and CHANGELOG sentence
// A-2b adds is quoted here word for word and asserted to be on its page, read from the repository.
// The behaviour each states is pinned in the cell named beside it. Each assertion names (a) the
// change that turns it red and (b) what it prints when it fails: the sentence, never a record or an
// environment.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CACHE_MISS_CAUSES } from '@sensigo/realm';

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

const READING = 'docs/reference/cli/realm-run-reading.md';
const STATE = 'docs/reference/mcp/run-state-and-health.md';
const ECONOMICS = 'docs/reference/cache-economics.md';

describe('caching 3-M A-2b — the reading page says what the miss line is', () => {
  it('where the line is printed', () => {
    // `inspect-misses-3m.test.ts`: beneath `attempt 1/2:`, `Diagnostics (attempt 2/2):`,
    // `Diagnostics:` and, in A-2b3's block, a failed drive's usage line.
    claim(
      READING,
      "A request that read less from the cache than the request it is compared with left there gets a line of its own under its cost, under each `attempt i/n` line too and under a failed drive's `usage` line (added after version 0.48.0).",
    );
    // The table row: the same cells.
    claim(
      READING,
      '| `cache miss` | A request read less from the cache than the one it is compared with left there | One line per such request, under its cost; see below (added after version 0.48.0). |',
    );
  });

  it('which requests count', () => {
    // `cache-misses.test.ts`: "a turn one token short of that is missed by 1 under the exact rule".
    claim(READING, 'On Anthropic any shortfall counts.');
    // `cache-misses.test.ts`, describe "the tolerance rule (OpenAI, Claude Code's thresholds)".
    claim(
      READING,
      'On other providers it must read under 95% of that and at least 2000 tokens less.',
    );
  });

  it('what the line ends in', () => {
    // `inspect-miss-words-3m.test.ts` (one sentence per cause and scope) and the `satisfies` map
    // `MISS_SENTENCES` in `inspect.ts` (a cause with no sentence does not compile).
    claim(
      READING,
      'After the dash the line gives a sentence: the first difference the record holds between the two requests and what could have made it, or that the entry possibly expired (the pause was longer than its lifetime), or that the record cannot compare what the two requests sent, or that nothing the cache covers differs on the record.',
    );
    // `inspect-miss-words-3m.test.ts` holds every sentence word for word; none says the difference
    // caused the miss.
    claim(READING, 'It is never a proven cause.');
  });

  it('the example, and when it says what the miss cost', () => {
    // `inspect-misses-3m.test.ts`, A-2b3's "a step: the line ends with what the miss cost": this
    // exact line, rendered.
    claim(
      READING,
      'For example: `cache miss: request 5 of 6 read 0 of 7181 expected tokens — possibly expired: it started 7 minutes after request 4, longer than the 5 minutes the provider granted; this miss cost about $0.0172 more than a full read (your economics file)`.',
    );
    // `step-view.test.ts`, A-2b3's (g) rows: no figure from a list price, a file with no
    // `cache_read` rate, or a full read that would exceed the prompt.
    claim(READING, 'The last clause appears only when your economics file prices the request.');
  });

  it('what Anthropic said (B3b)', () => {
    // `step-view.test.ts`, B3b's table of answers; `inspect-misses-3m.test.ts`, B3b's rendered lines.
    claim(
      READING,
      'When a request asked Anthropic to compare it with the request before it in the same call and Anthropic answered, the line adds what Anthropic said (added after version 0.48.0).',
    );
    // `step-view.test.ts`, B3b's "a call's first request: no provider key" row.
    claim(READING, "A call's first request has no such comparison, so its line never does.");
  });
});

describe('caching 3-M A-2b — get_run_state documents `cost.misses`', () => {
  it('what a row is', () => {
    // `step-view.test.ts`, A-2b1's 1 (b) and "two misses in one list": in order, each at its place.
    claim(
      STATE,
      '| `cost.misses` | Each request of this attempt (or failed drive) that missed the cache, in order (added after version 0.48.0).',
    );
    // A-2b1's 1 (b): position 4 of six, from 0.
    claim(
      STATE,
      "`position` is its place in all of the attempt's (or failed drive's) requests, from 0.",
    );
  });

  it('what `derived` holds', () => {
    // A-2b1's 1 (b) (`exact`, `from: list`) and 1 (c) (`tolerance`, `from: reference`).
    claim(
      STATE,
      '`derived` has `cause`, `rule` (`exact` on Anthropic, `tolerance` elsewhere), `expected_tokens`, `shortfall_tokens` and `predecessor` (`{ "from": "list", "at": <position> }`, `{ "from": "reference" }` for an earlier drive of this run, or `{ "from": "earlier_run" }`).',
    );
    // A-2b1's 1 (b) (`written`) and 1 (c) (a gap and no lifetime); `cache-misses.test.ts`, A-2a3's
    // cells (`asked`: "a reference that only read").
    claim(
      STATE,
      "When both requests' starts parse and the second is later, it adds `gap_s` (seconds), and `lifetime_s` with `lifetime_from` (`written` or `asked`) when the earlier request records a lifetime.",
    );
  });

  it('the fifteen causes', () => {
    // Red when a word is added to or dropped from the vocabulary and the page is not changed.
    claim(STATE, CACHE_MISS_CAUSES.map((cause) => `\`${cause}\``).join(', '));
    // `cache-misses.test.ts`, A-2a2's and A-2a3's cells, one per cause.
    claim(
      STATE,
      "`cause` is one of `provider_changed`, `endpoint_changed`, `model_changed`, `parts_not_recorded`, `final_request`, `strict_ladder`, `strict_changed`, `tools`, `system`, `repair_feedback`, `prompt`, `format`, `cache_settings`, `possibly_expired`, `unexplained`: the first difference the record holds, or a pause longer than the entry's lifetime, or none on the record; never a proven cause.",
    );
  });

  it('the money, and when the field is absent', () => {
    // `step-view.test.ts`, A-2b3's (a) to (f) and (g); get_run_state: the mcp parity test's A-2b3 cell.
    claim(
      STATE,
      "`extra_usd`, beside `derived`, is what the miss cost more than a full read, in US dollars, when the runner's economics file prices both the request and that full read (it needs a `cache_read` rate, and the expected tokens must fit in the prompt).",
    );
    // `step-view.test.ts`, B3b's table of answers (each reason, and a count only where one was
    // given) and "Realm's cause and Anthropic's reason disagree" (`provider` beside `derived`).
    claim(
      STATE,
      '`provider`, beside `derived`, is what Anthropic itself said, when the request asked it to compare with the request before it in the same call and Anthropic answered (added after version 0.48.0): `reason` (`messages_changed`, `model_changed`, `system_changed`, `tools_changed`, `previous_message_not_found`, `unavailable`, `no_divergence` or `unknown`) and, when Anthropic gives one, `cache_missed_input_tokens`, its approximate count of the tokens that would have been read from the cache had the request matched.',
    );
    // `step-view.test.ts`: A-2b1's 1 (a) (every request held: no key) and A-2b3's "a list none of
    // whose requests could be compared has no misses key".
    claim(
      STATE,
      '`cost.misses` is absent when no request missed, including when none could be compared.',
    );
    // `step-view.test.ts`, A-2b3's (h): composing changes nothing stored.
    claim(STATE, 'Worked out when the run is read; never stored. |');
  });
});

describe('caching 3-M A-2b — the economics page and the CHANGELOG', () => {
  it('the economics page', () => {
    // `inspect-misses-3m.test.ts`, each print site.
    claim(ECONOMICS, 'A request that missed the cache has its own line on `realm run inspect`.');
    // `step-view.test.ts`, A-2b3's (a) and (g); `inspect-misses-3m.test.ts`, A-2b3's block.
    claim(
      ECONOMICS,
      'When the file prices both the request and a full read of what it missed, that line ends with what the miss cost.',
    );
  });

  it('the CHANGELOG', () => {
    // `inspect-misses-3m.test.ts`; `inspect-miss-words-3m.test.ts`; `step-view.test.ts`, A-2b3's (a).
    claimChangelog(
      "**`realm run inspect` adds a line under a step's cost for each request that missed the cache.** The line names the first difference on the record, a pause longer than the entry's lifetime, or that the record shows no difference (never a proven cause), and what the miss cost when your economics file prices it. (#600)",
    );
    // The exports: `packages/core/src/index.ts`, and this file imports `CACHE_MISS_CAUSES` from it.
    claimChangelog(
      '**Core exports `CostMiss`, `CacheMissCause`, `CACHE_MISS_CAUSES`, `CacheMissRule`, `CachePredecessorPlace`, `CacheLifetimeSource` and `CACHE_LIFETIME_SOURCES`.** (#600)',
    );
    // `step-view.test.ts`, A-2b1's cells; the CLI and MCP parity registries' `misses` routes.
    claimChangelog(
      '**The composed cost view gains `CostView.misses`.** Numbers and closed words only. (#600)',
    );
    // `step-view.test.ts`, B3b's table of answers; `inspect-misses-3m.test.ts`, B3b's rendered lines.
    claimChangelog(
      "**`cost.misses` gains `provider`:** what Anthropic itself said about a cache miss, beside Realm's own reason; `realm run inspect` prints it on the miss line. (#600)",
    );
  });
});
