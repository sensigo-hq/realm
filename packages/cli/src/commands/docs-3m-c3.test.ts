// docs-3m-c3.test.ts — caching 3-M piece C3 (guardrail 7(f), 9): each docs and CHANGELOG sentence C3
// adds is quoted here word for word and asserted to be on its page, read from the repository. The
// behaviour each states is pinned in the cell named beside it (`agent_profile` in the `cause` list is
// held by `docs-3m-a2b.test.ts`, the sixteen causes). Each assertion names (a) the change that turns
// it red and (b) what it prints when it fails: the sentence, never a record or an environment.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const flat = (t: string): string => t.replace(/\s+/g, ' ');
const read = (page: string): string => readFileSync(join(ROOT, page), 'utf8');

describe('caching 3-M C3 — the docs say when a miss names a changed agent profile', () => {
  it('the record page: the fact on the copy', () => {
    // `earlier-runs-3m.test.ts` C3 check 1, every row; `request-facts.test.ts` C3 check 3.
    const sentence =
      "It also has `agent_profile_changed` (`true`) when the step's agent profile differs between the two requests and both are known (added after version 0.48.0).";
    // (a) red when the page no longer holds the sentence word for word; (b) prints the sentence.
    expect(
      flat(read('docs/reference/run-record-and-export.md')),
      `the record page no longer says: ${sentence}`,
    ).toContain(sentence);
  });

  it('the CHANGELOG entry', () => {
    // `cache-misses.test.ts` C3 check 2 (the first difference); `earlier-runs-3m.test.ts` C3 check 1
    // (both known and differ) and check 5 (the miss line and `cost.misses`).
    const sentence =
      "- **A cache miss can name a changed agent profile.** When the first difference on the record is the system text and both requests' agent profiles are known and differ, `realm run inspect`'s miss line says the profile changed, and `cost.misses` carries the cause `agent_profile` (the first difference on the record, never a proven cause). (#600)";
    // #871's form: the section that holds this unit's entry — `[Unreleased]` until a release renames
    // it, then the first release section above `[0.48.0]`.
    const text = read('CHANGELOG.md');
    const start = text.includes('## [Unreleased]')
      ? text.indexOf('## [Unreleased]')
      : text.indexOf('\n## [') + 1;
    // (a) red when the entry is gone or reworded; (b) prints the sentence.
    expect(
      flat(text.slice(start, text.indexOf('\n## [0.48.0]'))),
      `the CHANGELOG no longer says: ${sentence}`,
    ).toContain(sentence);
  });
});
