// docs-3m-b2b.test.ts — caching 3-M piece B2b (guardrail 7(f), 9): each docs and CHANGELOG sentence B2b
// adds or rewrites is quoted here word for word and asserted to be on its page, read from the
// repository. The behaviour each states is pinned in the cell named beside it. Each assertion names
// (a) the change that turns it red and (b) what it prints when it fails: the sentence, never a record
// or an environment.
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

const AGENT = 'docs/reference/cli/realm-agent.md';
const LISTEN = 'docs/reference/cli/realm-listen.md';

describe('caching 3-M B2b — realm-agent.md', () => {
  it('the flag row', () => {
    // The default and `off`: `cache-diagnostics-resolve-3m.test.ts`. A request marked for caching,
    // Anthropic's own address, the id named, the re-send without the question and stopping for the
    // drive: `anthropic-cache-ask-3m.test.ts` (B2a).
    claim(
      AGENT,
      "| `--cache-diagnostics <on\\|off>` | on at Anthropic's own address | Whether to ask Anthropic why a request missed the cache (added after version 0.48.0). It applies to a request marked for caching, at Anthropic's own address. Inside one provider call each request after the first names the answer before it, so Anthropic can say what changed. Each request that asks leaves a short-lived fingerprint of what it sent at Anthropic. If Anthropic refuses the question, the request is sent again without it, and Realm stops asking for the rest of the drive. `off` stops it. |",
    );
  });

  it('the page opening and --provider-module', () => {
    // The count: 17 rows; the one refusal: `prompt-cache-600.test.ts`, G18 and the B2b
    // `--provider-module` cell.
    claim(AGENT, 'This page lists its 17 flags,');
    claim(
      AGENT,
      'Cannot be combined with `--provider`, `--model`, `--base-url`, `--strict-base-url`, `--prompt-cache` or `--cache-diagnostics on`.',
    );
    claim(
      AGENT,
      '`Error: --provider-module cannot be combined with --provider, --model, --base-url, --strict-base-url, --prompt-cache, or --cache-diagnostics on`',
    );
  });

  it('the refusals (each row: its cell in prompt-cache-600.test.ts, B2b describe)', () => {
    claim(
      AGENT,
      '`Error: --cache-diagnostics on has nothing to act on: only Anthropic answers this question, and this drive uses openai. Remove --cache-diagnostics, or use --provider anthropic. Nothing was started.`',
    );
    claim(
      AGENT,
      "`Error: --cache-diagnostics on has nothing to act on: only Anthropic's own address answers this question, and ANTHROPIC_BASE_URL points elsewhere. Remove --cache-diagnostics, or unset ANTHROPIC_BASE_URL. Nothing was started.`",
    );
    claim(
      AGENT,
      '`Error: --cache-diagnostics on has nothing to act on: --prompt-cache off asks for no caching, so no request can miss. Remove --cache-diagnostics, or choose another --prompt-cache. Nothing was started.`',
    );
    claim(
      AGENT,
      "`Error: --cache-diagnostics on has nothing to act on: workflow 'triage' has no agent step, so the flag would change nothing. Remove --cache-diagnostics. Nothing was started.`",
    );
    // The parser: `prompt-cache.test.ts`, parseCacheDiagnostics.
    claim(
      AGENT,
      "`error: option '--cache-diagnostics <on\\|off>' argument 'yes' is invalid. --cache-diagnostics must be on or off.`",
    );
    // The `--run-id` rows of the B2b describe.
    claim(
      AGENT,
      "The refusals that begin `Error: --cache-diagnostics on has nothing to act on` end the same way; the one about the workflow reads the run and its workflow first, as `--prompt-cache`'s does (added after version 0.48.0).",
    );
  });

  it('the re-attach paragraph', () => {
    // `reattach-commands-676.test.ts`, the B2b describe.
    claim(
      AGENT,
      'It also repeats `--cache-diagnostics off` when the drive was given it (added after version 0.48.0).',
    );
  });
});

describe('caching 3-M B2b — realm-listen.md', () => {
  it('the flag row and the opening count', () => {
    // `listen.test.ts`, WIRED — the spawn carries a stated --cache-diagnostics.
    claim(
      LISTEN,
      '| `--cache-diagnostics <on\\|off>` | not passed | Passed to each `realm agent` it starts, only when stated (added after version 0.48.0). An agent that cannot ask (another provider, another address) simply does not. |',
    );
    claim(LISTEN, 'This page lists its argument and 15 flags,');
  });

  it('the parser refusal', () => {
    // `prompt-cache.test.ts`, parseCacheDiagnostics (both commands use the one parser).
    claim(
      LISTEN,
      "`error: option '--cache-diagnostics <on\\|off>' argument 'yes' is invalid. --cache-diagnostics must be on or off.`",
    );
  });

  it('the re-drive sentences', () => {
    // The same WIRED cell.
    claim(
      LISTEN,
      '`--llm-timeout`, `--prompt-cache` and `--cache-diagnostics` when `realm listen` was given them',
    );
    claim(
      LISTEN,
      'adding `--llm-timeout` if `realm listen` was given one, `--cache-diagnostics off` if it was given one (added after version 0.48.0), and `--prompt-cache` if it was given one (added after version 0.47.0; without it,',
    );
  });
});

describe('caching 3-M B2b — the other pages and the CHANGELOG', () => {
  it('the re-drive lists', () => {
    // `reattach-commands-676.test.ts`, the B2b describe.
    claim(
      'docs/reference/handlers.md',
      'It also repeats `--cache-diagnostics off` when the drive was given it (added after version 0.48.0).',
    );
    const list =
      '`--mint-writer-nonce`, `--prompt-cache` or `--cache-diagnostics off` if you used them';
    claim('docs/reference/cli/realm-run-acting.md', list);
    claim('docs/guides/operate-runs.md', list);
  });

  it('the guide says what the request carries', () => {
    // `cache-diagnostics-resolve-3m.test.ts`; the wire: `anthropic-cache-ask-wire-3m.test.ts` (B2a).
    claim(
      'docs/guides/realm-agent.md',
      "At Anthropic's own address the request also opts in to Anthropic's cache diagnostics, which leaves a short-lived fingerprint of what it sent at Anthropic and lets a later request of the same call ask why it missed the cache; `--cache-diagnostics off` stops that (added after version 0.48.0).",
    );
  });

  it('the record page', () => {
    // `anthropic-cache-ask-3m.test.ts` (B2a): the id named is the answer before it, in one call.
    claim(
      'docs/reference/run-record-and-export.md',
      "Inside one provider call at Anthropic's own address, Realm sends this id back with the next request when it asks Anthropic why that request missed the cache (`--cache-diagnostics`).",
    );
  });

  it('the CHANGELOG bullet', () => {
    // `cache-diagnostics-resolve-3m.test.ts`; `listen.test.ts`, the WIRED cell.
    claimChangelog(
      "- **`realm agent` and `realm listen` take `--cache-diagnostics on|off`.** On by default at Anthropic's own address: Realm asks Anthropic why a request missed the cache, and each request that asks leaves a short-lived fingerprint at Anthropic. (#600)",
    );
  });
});
