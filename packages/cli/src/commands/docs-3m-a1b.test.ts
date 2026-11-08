// docs-3m-a1b.test.ts — caching 3-M piece A-1b (guardrail 7(f), 9): each docs and CHANGELOG sentence
// A-1b adds is quoted here word for word and asserted to be on its page, read from the repository.
// The sentences A-1b rewrites are quoted in `docs-3m-a1.test.ts`. The behaviour each states is pinned
// in the cell named beside it. Each assertion names (a) the change that turns it red and (b) what it
// prints when it fails: the sentence, never a record or an environment.
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

describe('caching 3-M A-1b — the record page says what `request_in_call` holds', () => {
  it('what it is', () => {
    // `run-agent-tools-usage-610.test.ts` check 1 (one call's three requests are 0, 1, 2: the slot
    // in the call's array is the place) and check 2 (a throwing call's usage too).
    claim(
      RECORD_PAGE,
      "Each request `realm agent` records also carries `request_in_call` (added after version 0.48.0): its place, from 0, among the recorded requests of one call Realm made to the model's provider for the step.",
    );
    // `run-agent-tools-usage-610.test.ts` check 1 (the repair call's request is 0 again) and check
    // 2 (the throwing repair call restarts at 0).
    claim(RECORD_PAGE, "A step's attempt is one call, and a repair attempt is a new one.");
  });

  it('which requests are 0, and which 1 and up', () => {
    // The slot is the place: `run-agent-tools-usage-610.test.ts` check 1. Each kind's slot, from
    // its provider's own array: the JSON retry is the call's second record
    // (`anthropic-provider.test.ts`, "two billed requests (the non-JSON retry) yield TWO usage
    // entries"); a tool step's main turn, its later turns and its final request are records 0–3
    // (`anthropic-provider-tools-usage-610.test.ts` P1).
    claim(
      RECORD_PAGE,
      "A single-shot step's first request and a tool step's first turn are 0; a tool step's later turns, a JSON retry, and the request a tool step sends once it has used up its tool calls are 1 and up.",
    );
    // A list recorded with none: `cache-reference-3m.test.ts` check 3 (c).
    claim(RECORD_PAGE, 'A request recorded before this version has none.');
  });
});

describe('caching 3-M A-1b — the store contract and the CHANGELOG', () => {
  it('USAGE_RECORD_ROUNDTRIP names `request_in_call`', () => {
    // testing `usage-record-law-600.test.ts`: the `request_in_call` field cell (check 5).
    claim(
      'docs/reference/testing-package.md',
      'It also comes back with its `request_in_call`, its place in the call that made it (added after version 0.48.0).',
    );
  });

  it('the CHANGELOG bullet', () => {
    // `run-agent-tools-usage-610.test.ts` checks 1–2; `cache-reference-3m.test.ts` check 3; core
    // `request-facts.test.ts` check 4; the contract: `usage-record-law-600.test.ts` (check 5).
    claimChangelog(
      '- **`UsageRecord` gains `request_in_call`:** each request `realm agent` records says its place, from 0, in the call to the provider that made it, and the store contract (`USAGE_RECORD_ROUNDTRIP`) holds it. (#600)',
    );
  });
});
