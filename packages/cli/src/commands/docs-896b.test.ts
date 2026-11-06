// docs-896b.test.ts — #896 unit B (guardrail 7(f), 9): each docs and CHANGELOG sentence the unit adds
// is quoted here word for word and asserted to be on its page, read from the repository. The
// behaviour each states is executed by the cell named beside it (`openai-auto-896b.test.ts`, checks
// 1–9). The sentences unit B rewrote in place are pinned where they were pinned before
// (`docs-896.test.ts`, `docs-898.test.ts`, `docs-600-3b.test.ts`). Each assertion names (a) the change
// that turns it red and (b) what it prints when it fails: the sentence, never a record or an
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
/** The section that holds this unit's entry: `[Unreleased]` until a release renames it. */
function claimChangelog(sentence: string): void {
  const text = read('CHANGELOG.md');
  const start = text.includes('## [Unreleased]')
    ? text.indexOf('## [Unreleased]')
    : text.indexOf('\n## [') + 1;
  const section = text.slice(start, text.indexOf('\n## [0.48.0]'));
  expect(flat(section), `the CHANGELOG no longer says: ${sentence}`).toContain(flat(sentence));
}

describe('#896 unit B — the docs sentences', () => {
  it('cache-economics.md: OpenAI’s one lifetime, rates and fallback', () => {
    // Checks 1, 2 (costed from cache_read and cache_write), 5 (cache_write_5m not read as its write),
    // 3 and 4 (the fallback's 27 minutes), 7 (a tool step not part of the choice).
    claim(
      'docs/reference/cache-economics.md',
      "On OpenAI GPT-5.6 and later at OpenAI's own address, in place of the lifetimes, rates and fallback above: there is one lifetime, 30 minutes. It is costed when the row states `cache_read` and `cache_write`; `cache_write_5m` and `cache_write_1h` are not read as its write. On a tie with no caching, 30 minutes. Without prices, `auto` asks for 30 minutes when any of the last five gaps is under 27 minutes, and for no caching otherwise. A step that calls tools is not part of the choice (added after version 0.48.0).",
    );
  });

  it('realm agent: the Caching paragraph under auto', () => {
    // Check 1 (the off line with Anthropic's reason), check 9 (the branches).
    claim(
      'docs/reference/cli/realm-agent.md',
      "With `auto`, on a workflow with a step without tools, OpenAI's line gives the same reason as Anthropic's, and it reads `Caching: off; OpenAI is asked to cache nothing (…)` when `auto` chose no caching (added after version 0.48.0).",
    );
  });

  it('the record and run state pages: cache_auto on OpenAI, cache_write, the entry’s provider', () => {
    // Checks 1 and 5 (cache_auto recorded; missing [cache_write]); check 7 (a tool step records
    // none); check 3 (inspect reads the entry's provider).
    claim(
      'docs/reference/run-record-and-export.md',
      "On OpenAI, `cache_auto` is recorded for a step without tools on GPT-5.6 and later at OpenAI's own address, and `missing` can name `cache_write`, OpenAI's one write rate (added after version 0.48.0).",
    );
    claim(
      'docs/reference/mcp/run-state-and-health.md',
      "On OpenAI, an entry has `auto` for a step without tools on GPT-5.6 and later at OpenAI's own address, and its `prices.missing` can name `cache_write`, OpenAI's one write rate (added after version 0.48.0). An entry also has `provider`, the provider that answered its requests, as the record's `provider`, when they record a readable one (added after version 0.48.0).",
    );
  });

  it('CHANGELOG: the behaviour, the two vocabularies and the new export', () => {
    for (const lead of [
      "**`--prompt-cache auto` chooses for OpenAI GPT-5.6 and later too,** at OpenAI's own address. On a drive `realm listen` starts, a step without tools asks for 30 minutes or for no caching, by the gaps between the workflow's recent triggers and your price file's `cache_read` and `cache_write` rates. Without usable prices it asks for 30 minutes when any of the last five gaps is under 27 minutes, and for no caching otherwise. Steps with tools are left to OpenAI's own caching. (#896)",
      '**`CACHE_AUTO_RATES` gains `cache_write`.** (#896)',
      '**`CacheRequestedEntry` gains `provider`.** (#896)',
      "**Core exports `chooseAutoOneLifetime`,** `--prompt-cache auto`'s rule for a provider with one cache lifetime. (#896)",
    ])
      claimChangelog(lead);
  });
});
