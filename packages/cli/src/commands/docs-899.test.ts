// docs-899.test.ts — issue #899 (guardrail 7(f), 9): each docs sentence the tool-step cache marker
// adds or rewrites is quoted here word for word and asserted to be on its page, read from the
// repository; each is red on the page's old text. The behaviour each states is pinned in the cells
// named beside it: M1–M7 (`anthropic-provider-tools-cache-899.test.ts`), M9
// (`provider-conformance.test.ts`), M10 (`start-line-600.test.ts`), M11
// (`prompt-cache-600.test.ts`), M12 (`validate-cacheability.test.ts`), M13
// (`inspect-tools-cache-899.test.ts`) and R1 (`schema-retries-tools-907.test.ts`). The three
// `realm-workflow.md` passages #899 rewrites are claimed in `docs-pr5-cacheability.test.ts`, not
// here. Each assertion names (a) the change that turns it red and (b) what it prints when it fails:
// the sentence, or a page's count of a line.
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

const REF = 'docs/reference/cli/realm-agent.md';
const GUIDE = 'docs/guides/realm-agent.md';
const ONCE_ANTHROPIC =
  "anthropic: when realm agent or realm listen drives a step, realm marks its fixed part for caching, and on steps with tools the conversation at each turn, unless --prompt-cache turns it off; below the model's minimum nothing is cached, silently";
const ONCE_OPENAI =
  "openai: realm sends no cache marker; the provider's own rules decide — see https://developers.openai.com/api/docs/guides/prompt-caching (as of 2026-10-16)";
const ONCE_SCOPE =
  "anthropic: the cache is kept per workspace (per organization on Bedrock and Google Cloud), as Anthropic's page said on 2026-10-09: drives from different workspaces each pay the write";

describe('#899 — the docs sentences', () => {
  it('§3.2 realm-agent.md: the --prompt-cache row, the Caching line and the refusal row (M10, M11)', () => {
    claim(
      REF,
      'Refused for a provider Realm asks for no caching, and for a workflow with no agent step. Added after version 0.47.0.',
    );
    claim(
      REF,
      'With Anthropic and a setting other than off: when the workflow has no agent step, it says `Caching: no step is cached; this workflow has no agent step.`, and when an agent step calls tools, the line ends `On a step that calls tools, it is also asked to cache the conversation so far, at each turn.`',
    );
    claim(
      REF,
      "| `--prompt-cache`, and the workflow has no agent step (added after version 0.47.0) | `Error: --prompt-cache has nothing to apply to: workflow 'triage' has no agent step, so the flag would change nothing. Remove --prompt-cache. Nothing was started.` |",
    );
  });

  it('§3.2 ride-along (#907), realm-agent.md: --schema-retries does not stop the correction inside a tools step (R1)', () => {
    claim(
      REF,
      "`0` turns this off. A step that uses tools is also corrected inside its conversation, up to the step's `max_tool_calls`; `0` does not stop that. |",
    );
  });

  it('§3.4 the guide: one request for a step without tools; a tools step asks at each turn; its last request unmarked (M1, M5)', () => {
    claim(
      GUIDE,
      'For each agent step without tools, `realm agent` sends one request to Anthropic.',
    );
    claim(
      GUIDE,
      "On a step without tools, the step's prompt is not cached. A step that calls tools also asks Anthropic, at each turn, to cache the conversation so far, so a turn can read what the turn before wrote once that part reaches the model's minimum. Its last request, made only when it has used up its tool calls, is sent with no cache marker.",
    );
  });

  it('§3.5 the count of the requests that recorded an ask, on Anthropic (M7, M13 and its OpenAI control)', () => {
    claim(
      'docs/reference/cli/realm-run-reading.md',
      "When only some of a step's requests recorded what was asked, the `asked for` words end with how many did: `asked for 5 minutes (…) (recorded by 2 of 3 requests)`. On Anthropic, a step that used up its tool calls shows this, because its last request is sent with no cache marker and records no ask.",
    );
    claim(
      'docs/reference/run-record-and-export.md',
      'A request `realm agent` sent also records what Realm asked for (except, on Anthropic, the last request of a step that used up its tool calls: it is sent with no cache marker and records no ask), what answered',
    );
  });

  // (a) red when a page keeps the old once-line, or loses a copy of the new one; (b) prints, per
  // page, how many copies of each it holds.
  it('§3.6 the anthropic once-line, at each of its 10 places in six pages (M12)', () => {
    const OLD =
      "anthropic: on steps without tools, realm marks the fixed part for caching unless the drive's --prompt-cache turns it off; a fixed part below the model's minimum is sent uncached, silently";
    const pages = {
      'docs/guides/agent-steps.md': 1,
      'docs/guides/first-workflow.md': 2,
      'docs/guides/step-handlers.md': 1,
      'docs/reference/cli/realm-workflow.md': 4,
      'docs/reference/workflow/top-level-fields.md': 1,
      'docs/start/install-and-first-run.md': 1,
    };
    const copies = (text: string, line: string): number => text.split(line).length - 1;
    expect(
      Object.fromEntries(
        Object.keys(pages).map((p) => [
          p,
          { new: copies(read(p), ONCE_ANTHROPIC), old: copies(read(p), OLD) },
        ]),
      ),
    ).toEqual(Object.fromEntries(Object.entries(pages).map(([p, n]) => [p, { new: n, old: 0 }])));
  });

  // (a) red when the transcript lacks the three lines, or they follow in another order; (b) prints
  // whether the block holds them right after the step's cache line.
  it('§3.6 step-fields.md: the every-step-field transcript ends with the three once-lines (M12, no --provider)', () => {
    const text = read('docs/reference/workflow/step-fields.md');
    const cacheLine =
      "cache: summarise — uses tools: each tool's definition comes from its MCP server at run time, so the request cannot be measured before a run: not judged";
    expect(
      text.includes(`${cacheLine}\n${ONCE_ANTHROPIC}\n${ONCE_OPENAI}\n${ONCE_SCOPE}\n\`\`\``),
      'the transcript ends with the cache line and the three once-lines',
    ).toBe(true);
  });

  it('§3.7 the CHANGELOG entry, sentence by sentence (M1, M3, M5, M11; the Upgrading line: §8 problem 1)', () => {
    for (const sentence of [
      "**When `realm agent` or `realm listen` drives a step that calls tools, it now asks Anthropic to cache the step's fixed instructions and the conversation so far at each turn, so a turn can read what the turn before wrote once that part reaches the model's minimum.**",
      'The request a step makes after using up its tool calls is sent with no cache marker.',
      '`--prompt-cache off` sends what it sent before.',
      'A workflow whose every agent step calls tools no longer refuses `--prompt-cache`.',
      '**Upgrading:** a gateway or proxy that rejects `cache_control` now also fails steps that call tools, which worked before; run with `--prompt-cache off`. (#899)',
    ])
      claimChangelog(sentence);
  });
});
