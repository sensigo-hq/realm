// docs-3m-a1.test.ts — caching 3-M piece A-1 (guardrail 7(f), 9): each docs and CHANGELOG sentence
// A-1 adds is quoted here word for word and asserted to be on its page, read from the repository. The
// behaviour each states is pinned in the cell named beside it. Each assertion names (a) the change that
// turns it red and (b) what it prints when it fails: the sentence, never a record or an environment.
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

describe('caching 3-M A-1 — the record page says what `reference` holds and when', () => {
  it('when a request carries one', () => {
    // `cache-reference-3m.test.ts` check 1 (a re-attach after a drive failure), check 4 (both
    // catches), check 2 (a resumed step); "whichever was written last": check 3 and its mirror;
    // "the same step's": the cell "the same step only"; "the first request of … last call"
    // (piece A-1b): check 3 (a) and (b), and (c) for a list that names no call.
    claim(
      RECORD_PAGE,
      "A step's first request in a drive can also carry a `reference` (added after version 0.48.0): a copy of the first request of the same step's last call on the run's record, made by an earlier drive.",
    );
    // "That call is the step's last one": check 3 and its mirror (the entries' order), and A-1b's
    // check 3 (b) (the list's last call).
    claim(
      RECORD_PAGE,
      "That call is the step's last one on the record: on its evidence entry (the step settled failed, and `realm run resume` reopened it) or on a failed drive's entry in `drive_failures`, whichever was written last.",
    );
  });

  it('what it holds', () => {
    // `cache-reference-3m.test.ts` check 1 (the copied fields, exactly, read off the stored
    // request; `cache_requested` with piece A-1b's `referenceTo`, in every cell, and in check 3);
    // core `request-facts.test.ts` check 6 (every field kept as written).
    claim(
      RECORD_PAGE,
      'The copy holds `from` (`run`) and that request’s `request_start`, and each of its `request_id`, `provider`, `model`, `endpoint`, `cache_requested`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `cache_write_tokens`, `cache_creation`, `cache_lifetime_s`, `cache_ttl_sent`, `cache_auto`, `prefix_chars`, `prefix_parts`, `cache_marked` and `request_strict_sent` that it had.'.replace(
        '’',
        "'",
      ),
    );
  });

  it('which requests carry none', () => {
    // `cache-reference-3m.test.ts` check 1 (the drive's second request, and the repair call's);
    // "an earlier entry of the same list": piece A-1b's check 3 (a request's call opener is an
    // earlier entry, `run-agent-tools-usage-610.test.ts` check 1).
    claim(
      RECORD_PAGE,
      'No other request carries one: its predecessor is an earlier entry of the same list.',
    );
    // A fresh run: `drive-failure-chokepoints.test.ts` D9's exact pin over a fresh drive's stored
    // usage (check 5); a nested reference dropped: core `request-facts.test.ts` check 6.
    claim(
      RECORD_PAGE,
      'A fresh run’s requests have none, and a `reference` never holds a reference of its own.'.replace(
        '’',
        "'",
      ),
    );
  });
});

describe('caching 3-M A-1 — the store contract and the CHANGELOG', () => {
  it('USAGE_RECORD_ROUNDTRIP names `reference`', () => {
    // testing `usage-record-law-600.test.ts`: the `reference` field cell and the cell for a store
    // that drops a key inside it (check 7).
    claim(
      'docs/reference/testing-package.md',
      'It also comes back with its `reference`, the copy of an earlier request, with every field inside it (added after version 0.48.0).',
    );
  });

  it('the CHANGELOG bullet', () => {
    // `cache-reference-3m.test.ts` checks 1–4; "the first request of … last call": piece A-1b's
    // check 3; the fresh run: check 5's witness; the contract: `usage-record-law-600.test.ts`
    // (check 7).
    claimChangelog(
      "- **`UsageRecord` gains `reference`:** a step's first request in a drive carries a copy of the first request of the same step's last call on the run's record, when an earlier drive made that request, with `from: 'run'`. A fresh run's requests have none, and the store contract (`USAGE_RECORD_ROUNDTRIP`) holds it. (#600)",
    );
  });
});
