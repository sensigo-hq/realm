// docs-3m-b3a.test.ts — caching 3-M piece B3a (guardrail 7(f), 9): each docs and CHANGELOG sentence
// B3a adds is quoted here word for word and asserted to be on its page, read from the repository.
// The behaviour each states is pinned in the cell named beside it. Each assertion names (a) the
// change that turns it red and (b) what it prints when it fails: the sentence, never a record or an
// environment.
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

const RECORD_PAGE = 'docs/reference/run-record-and-export.md';

describe('caching 3-M B3a — the record page says what `cache_diagnostics` holds', () => {
  it('its shapes and words', () => {
    // The states: `anthropic-cache-answer-3m.test.ts` ("the mapping of Anthropic’s answer"); the
    // closed words, and `unknown` for a reason Realm does not know: core's
    // `cache-diagnostics-3m.test.ts` ("the one normaliser").
    claim(
      RECORD_PAGE,
      "A request that asked Anthropic why it missed the cache also carries `cache_diagnostics` (added after version 0.48.0): `asked`, the id it named as `reference_id` (or `null` on a call's first request), and, when it named one, `result`: `no_divergence`, `pending`, `not_returned`, or an object with a `type` (`messages_changed`, `model_changed`, `system_changed`, `tools_changed`, `previous_message_not_found`, `unavailable`, or `unknown` for a reason Realm does not know) and, when Anthropic gives one, `cache_missed_input_tokens`, its approximate count of the tokens that would have been read from the cache had the request matched.",
    );
  });

  it('after a refusal, and on a step’s last request', () => {
    // `anthropic-cache-answer-3m.test.ts`: "a refused question" (a) and (b), and "a request that was
    // never going to ask records nothing" (the final extraction).
    claim(
      RECORD_PAGE,
      'After Anthropic refuses the question, each request that would have asked has `asked: false` and `cause: rejected`; the last request of a step that used up its tool calls never asks and has none.',
    );
  });
});

describe('caching 3-M B3a — the store contract and the CHANGELOG', () => {
  it('the testing page: the store contract holds it', () => {
    // `usage-record-law-600.test.ts`: "REJECTS a store that drops cache_diagnostics".
    claim(
      'docs/reference/testing-package.md',
      'It also comes back with its `cache_diagnostics` (added after version 0.48.0).',
    );
  });

  it('the CHANGELOG', () => {
    // Closed words and the checked id: core's `cache-diagnostics-3m.test.ts`. The store contract:
    // `usage-record-law-600.test.ts`.
    claimChangelog(
      '- **`UsageRecord` gains `cache_diagnostics`:** what a request asked Anthropic about a cache miss and what Anthropic answered, in closed words and numbers with the checked id it named, and the store contract (`USAGE_RECORD_ROUNDTRIP`) holds it. (#600)',
    );
  });
});
