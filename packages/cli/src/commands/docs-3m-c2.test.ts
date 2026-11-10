// docs-3m-c2.test.ts — caching 3-M piece C2 (guardrail 7(f), 9): each docs and CHANGELOG sentence C2
// adds is quoted here word for word and asserted to be on its page, read from the repository. The
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
const STATE = 'docs/reference/mcp/run-state-and-health.md';
const READING = 'docs/reference/cli/realm-run-reading.md';

describe('caching 3-M C2 — the docs say when a copy comes from an earlier run', () => {
  it('the record page: where the copy comes from', () => {
    // `earlier-runs-3m.test.ts` check 1 (the copy), check 3 (the run's own record first).
    claim(
      RECORD_PAGE,
      "When the run's record holds no such request, the copy comes from an earlier run of the same workflow.",
    );
    // `earlier-runs-3m.test.ts` check 5 (the six), check 4 (7 days and its edge; completed, failed and
    // in progress; the later start), check 2 of `agent-earlier-runs-3m.test.ts` (when the drive starts).
    claim(
      RECORD_PAGE,
      'When the drive starts, Realm reads up to the six runs updated last in the past 7 days that list the step as completed, failed or in progress, and copies whichever of their requests for the step started last.',
    );
  });

  it('the record page: the new value of `from`', () => {
    // `earlier-runs-3m.test.ts` check 1 (`earlier_run`), check 3 (`run`).
    claim(RECORD_PAGE, '`from` (`run`, or `earlier_run` for a copy from an earlier run)');
  });

  it('the run-state page: the third shape of `predecessor`', () => {
    // `earlier-runs-3m.test.ts` check 8 (`{ from: 'earlier_run' }` from `get_run_state`).
    claim(
      STATE,
      '(`{ "from": "list", "at": <position> }`, `{ "from": "reference" }` for an earlier drive of this run, or `{ "from": "earlier_run" }`)',
    );
  });

  it('the reading page: what the miss line says, and what is not compared', () => {
    // `earlier-runs-3m.test.ts` check 8 (the words on the line).
    claim(
      READING,
      "A step's first request in a drive is compared with the same step's request in an earlier run of the workflow when its own run holds none, and the line then says `an earlier run's request` (added after version 0.48.0).",
    );
    // `earlier-runs-3m.test.ts` check 9 (a tool step), core `cache-misses.test.ts` C1's cells (OpenAI's own rules).
    claim(
      READING,
      "An earlier run is not used for a tool step's first request, or for a request OpenAI caches by its own rules: what those cache holds that run's own input, so a new input always reads less.",
    );
  });

  it('the CHANGELOG entry', () => {
    // `earlier-runs-3m.test.ts` checks 1, 4, 8 and 9; check 2 of `agent-earlier-runs-3m.test.ts`.
    claimChangelog(
      "- **A step's first request is compared with an earlier run.** When its own run holds nothing earlier for the step, `realm agent` copies the same step's request from the most recent earlier run of the workflow in the last 7 days that lists the step as completed, failed or in progress, and `realm run inspect`'s miss line says so. A tool step's first request and a request OpenAI caches by its own rules are not compared with an earlier run. (#600)",
    );
  });
});
