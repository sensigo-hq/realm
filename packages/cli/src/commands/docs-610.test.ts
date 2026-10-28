// docs-610.test.ts — issue #610 (guardrail 7(f), 9): each docs sentence the tools-path usage change
// adds or rewrites is quoted here word for word and asserted to be on its page, read from the
// repository; each is red on the page's old text. The behaviour each states is pinned in the cells
// named beside it (the provider files, `run-agent-tools-usage-610.test.ts`,
// `inspect-tools-usage-610.test.ts`, `get-run-state-tools-usage-610.test.ts`). Each assertion names
// (a) the change that turns it red and (b) what it prints when it fails: the sentence.
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

describe('#610 — the docs sentences', () => {
  it('R11, agent-tools.md: the record keeps a tools step’s requests; an older record has none (V1′, D1, P2, P4)', () => {
    // Middle sentence's cells: P2, P4 in {anthropic,openai}-provider-tools-usage-610.test.ts. Red on the old page; prints the sentence.
    claim(
      'docs/guides/agent-tools.md',
      "The record keeps each request the model service answers for a step that uses tools, and `realm run inspect` shows what they cost, as for any agent step (added after version 0.48.0). A request that ends in an error is not kept, so the count can be lower than the service's own log shows. A step that Realm 0.48.0 or earlier recorded has no usage; its `cost` line says so.",
    );
  });

  it('R12, run-state-and-health.md: `tool_calling_step` means no usage on the attempt (V2 control)', () => {
    claim(
      'docs/reference/mcp/run-state-and-health.md',
      '`tool_calling_step`: the step used tools and its attempt carries no usage: Realm 0.48.0 or earlier recorded it, or a program that embeds the engine recorded its tool calls without usage.',
    );
  });

  it('R14, realm-run-reading.md: the `cost` row lists inspect’s three sentences (V3)', () => {
    claim(
      'docs/reference/cli/realm-run-reading.md',
      'Why: `not recorded — realm has no usage figures for this attempt (…)`, `not recorded — tool-calling step with no recorded usage (realm 0.48.0 or earlier recorded none)`, or `unreadable — the recorded usage is not a list`.',
    );
  });

  it('R15, realm-run-reading.md: the run’s `Cost` row counts as not measured only an older tools attempt (V4)', () => {
    claim(
      'docs/reference/cli/realm-run-reading.md',
      'a tool-calling attempt that realm 0.48.0 or earlier recorded (`not measured`)',
    );
  });

  it('the CHANGELOG entry, sentence by sentence (P1–P4, D1, D2, V1–V4)', () => {
    for (const sentence of [
      '**A step that uses tools records what its model requests cost (issue #610).**',
      "Each request such a step makes that gets an answer — every turn, the retry after a refused strict tool list, and the final answer — is kept on the step's record in the order sent, as for every other agent step, and a step that fails keeps the requests that had returned, including an earlier repair attempt's.",
      "`realm run inspect`, `get_run_state` and the run's `Cost:` line show it.",
      'Until this release such a step recorded nothing (the 0.46.0 notes said so).',
      "A provider module's `callStepWithTools` may return the new optional `usage` list on its result.",
    ]) {
      claimChangelog(sentence);
    }
  });
});
