// docs-715r.test.ts — issue #715 (R) (guardrail 7(f), 9): each docs and CHANGELOG sentence the
// request-identity change adds is quoted here word for word and asserted to be on its page, read from
// the repository; each is red on the page's old text. The behaviour each states is pinned in the
// cells named beside it (R1, R4 in `agent-utils.test.ts`; R2 in `run-agent-tools-usage-610.test.ts`
// and `repair-loop-usage.test.ts`; R3 in `run-agent-tools-usage-610.test.ts`,
// `drive-failure-chokepoints.test.ts`, `chained-usage.test.ts`; R5b, R5c in `chained-usage.test.ts`;
// R6 in `testing/src/store/usage-record-law-600.test.ts`). Each assertion names (a) the change that
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
 *  it, then the first release section above `[0.48.0]`, never a fixed heading. */
function claimChangelog(sentence: string): void {
  const text = read('CHANGELOG.md');
  const start = text.includes('## [Unreleased]')
    ? text.indexOf('## [Unreleased]')
    : text.indexOf('\n## [') + 1;
  const section = text.slice(start, text.indexOf('\n## [0.48.0]'));
  expect(flat(section), `the CHANGELOG no longer says: ${sentence}`).toContain(flat(sentence));
}

const RECORD_PAGE = 'docs/reference/run-record-and-export.md';

describe('#715 (R) — the docs sentences (R8)', () => {
  it('run-record-and-export.md: every request lists `request_id` (R2)', () => {
    claim(
      RECORD_PAGE,
      'Each of `cache.requests` has `request_index`, `request_start` and `request_id` (added after version 0.48.0), and the counts the provider reported:',
    );
  });

  it('run-record-and-export.md: what `request_id` is, that Realm replaces a module’s, and that an older request has none (R1, R2, R5c)', () => {
    // R1: a version-4 UUID, minted; R1 and R2: a provider's `provider-own` value is replaced; R5c: a
    // stored request without the id is never matched as already recorded.
    for (const sentence of [
      'Each request also carries a `request_id`, a random UUID that Realm itself mints (added after version 0.48.0).',
      "It is not the model service's own request id.",
      'Realm replaces any `request_id` a provider module puts in the usage it returns.',
      'A request recorded before this version has none, and Realm never matches it against a new request.',
    ])
      claim(RECORD_PAGE, sentence);
  });

  it('testing-package.md: USAGE_RECORD_ROUNDTRIP also holds `request_id` (R6)', () => {
    claim(
      'docs/reference/testing-package.md',
      'It also comes back with its `request_id`, the identity Realm mints for each request (added after version 0.48.0).',
    );
  });

  it('the CHANGELOG entries, Added and Fixed (R2, R3, R6; R5b)', () => {
    claimChangelog(
      "**Each model request `realm agent` records carries a `request_id` (issue #715).** It is a random UUID that Realm mints for the request, stored with it in the step's evidence and in a failed drive's `usage`. It is not the model service's own request id: Realm replaces any `request_id` a provider module returns. The store TCK's `USAGE_RECORD_ROUNDTRIP` law now holds every store to round-tripping it, so a store that drops a request field it does not know fails the law.",
    );
    claimChangelog(
      "**Two different model requests with the same start time and token counts are no longer taken for one (issue #715).** When a drive failed, `realm agent` decided whether a request was already on the step's record by its start time and token counts, so a second request that matched them was not attached to the failure and its cost was lost. It now compares the request's `request_id`.",
    );
  });
});
