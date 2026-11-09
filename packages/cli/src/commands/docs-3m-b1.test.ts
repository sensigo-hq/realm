// docs-3m-b1.test.ts — caching 3-M piece B1 (guardrail 7(f), 9): each docs and CHANGELOG sentence B1
// adds is quoted here word for word and asserted to be on its page, read from the repository. The
// behaviour each states is pinned in the cell named beside it. Each assertion names (a) the change
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

describe('caching 3-M B1 — the record page says what `response_id` holds', () => {
  it('which requests carry it', () => {
    // The request kinds: `anthropic-response-id-3m.test.ts` (check 2: the single-shot request, a
    // tool turn and the final extraction each record their own answer's id).
    claim(
      RECORD_PAGE,
      'An Anthropic request also carries `response_id`, the id of the answer (`msg_…`, added after version 0.48.0).',
    );
  });

  it('the rule it is kept under', () => {
    // The rule: core `request-facts.test.ts`, "caching 3-M B1 — response_id is kept only when it
    // passes the one check" (check 1).
    claim(
      RECORD_PAGE,
      'It is kept only when it starts with `msg_`, is at most 256 characters and has no control character.',
    );
  });

  it("OpenAI's none, and a provider module's", () => {
    // OpenAI's none: GROUNDING (check 3: neither OpenAI provider file writes the field). A provider
    // module's under the same rule: check 1, the write gate every provider's record passes.
    claim(
      RECORD_PAGE,
      "OpenAI's requests have none; a provider module's own `response_id` is kept under the same rule.",
    );
  });
});

describe('caching 3-M B1 — the store contract and the CHANGELOG', () => {
  it('USAGE_RECORD_ROUNDTRIP names `response_id`', () => {
    // testing `usage-record-law-600.test.ts`: the `response_id` field cell (check 4).
    claim(
      'docs/reference/testing-package.md',
      'It also comes back with its `response_id`, the id of the answer (added after version 0.48.0).',
    );
  });

  it('the CHANGELOG bullets', () => {
    // The rule: check 1; the request kinds: check 2; the store contract: check 4.
    claimChangelog(
      '- **`UsageRecord` gains `response_id`:** each Anthropic request records the id of the answer (`msg_…`), kept only when it starts with `msg_`, is at most 256 characters and has no control character, and the store contract (`USAGE_RECORD_ROUNDTRIP`) holds it. (#600)',
    );
    // The export: check 1 runs the one check through the write gate; core's index exports it.
    claimChangelog(
      "- **Core exports `normalizeResponseId`,** the one check a request's `response_id` passes. (#600)",
    );
  });
});
