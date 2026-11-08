// docs-3m-a0.test.ts — caching 3-M, piece A-0 (guardrail 7(f), 9): each docs, type-comment and
// CHANGELOG sentence A-0 adds or rewrites is quoted here word for word and asserted to be on its page,
// read from the repository. The behaviour each states is pinned in the cell named beside it. Each
// assertion names (a) the change that turns it red and (b) what it prints when it fails: the
// sentence, never a record or an environment.
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
// A doc comment's sentence, read with each line's comment marks (the opening and closing marks and
// the star that starts each line) removed. (a) red when the file no longer holds the sentence word
// for word; (b) prints the sentence.
function claimComment(file: string, sentence: string): void {
  const text = read(file).replace(/^\s*(?:\/\*\*|\*\/|\*)\s?/gm, ' ');
  expect(flat(text), `${file} no longer says: ${sentence}`).toContain(flat(sentence));
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
const RUN_RECORD = 'packages/core/src/types/run-record.ts';

describe('caching 3-M A-0 — the record page', () => {
  it('the lead sentence: the split facts on a split request, the parts on every request', () => {
    // Every request: `anthropic-provider-head-3b.test.ts` (check 4, Anthropic),
    // `anthropic-provider-tools-cache-899.test.ts` (check 2: main turns; the final request has
    // none), `openai-cache-key-3b.test.ts` (checks 1 and 4, OpenAI and o1); a split request only:
    // the same cells' `split` pins.
    claim(
      RECORD_PAGE,
      "`prefix_sha256` and `prefix_chars` are on a request whose step prompt Realm split at its stable start (its head). `prefix_parts` and `request_strict_sent` are on every request Realm's Anthropic and OpenAI providers make, except Anthropic's tool-loop final request, and `cache_marked` is on those that carried a marker or the key. `cache_controls_rejected` and `cache_key_sent` are as their rows say (added after version 0.48.0):",
    );
  });

  it('the prefix_parts row: the parts of what was sent, the prompt part the head or the prompt sent', () => {
    // The head: `openai-cache-key-3b.test.ts` check 1 (OpenAI, o1) and the 3-B head cells; the
    // prompt as sent: `anthropic-provider-head-3b.test.ts` check 4 (the JSON retry's own text).
    claim(
      RECORD_PAGE,
      'A SHA-256 for each part of what the request sent: `system`, and `tools`, `prompt` (the head on a split request, else the prompt as that request sent it) and `format` where it had them; `cache_marked` says which parts carried a marker.',
    );
  });

  it('the cache_marked row: conversation, the tool-loop final request, and the OpenAI request that carried neither', () => {
    // #896's words stay whole at the head of the list (`docs-896.test.ts` quotes them).
    // `conversation`: `anthropic-provider-tools-cache-899.test.ts` check 2 and core
    // `split-facts-3b.test.ts`; absent after a refusal: `gateway-rule-3b.test.ts` check 3; absent on
    // the tool-loop final request: `anthropic-provider-tools-cache-899.test.ts` M5 (its body carries
    // no `cache_control`) and check 2 (it records none); absent on an OpenAI request with neither:
    // `openai-cache-key-3b.test.ts` check 4.
    claim(
      RECORD_PAGE,
      "What carried a cache marker or the cache key: `system`, `prompt` (Anthropic, and OpenAI on GPT-5.6 and later) or `key` (OpenAI), and on Anthropic's tool turns `conversation` (the marker on the conversation so far). Absent when nothing did: under `--prompt-cache off`, after the endpoint refused the cache fields, on Anthropic's tool-loop final request, and on an OpenAI request that carried neither a mark nor the key.",
    );
  });

  it('the request_strict_sent row: strict structured output or strict tool arguments', () => {
    // `anthropic-provider-tools-cache-899.test.ts` check 2(a) and 2(b);
    // `openai-cache-key-3b.test.ts` check 4 (strict).
    claim(
      RECORD_PAGE,
      'Whether the request carried strict structured output or strict tool arguments.',
    );
  });
});

describe('caching 3-M A-0 — the type comments in run-record.ts', () => {
  it('CACHE_MARKED_PARTS, PrefixParts, prefix_parts and request_strict_sent say what they cover', () => {
    // The same cells as the record page's rows above.
    for (const sentence of [
      "Caching 3-M (A-0): or the `conversation` so far — the marker Anthropic's tool main turns put on a copy of the last message (#899).",
      'Caching 3-B (A6), 3-M (A-0): a SHA-256 for each part of what the request sent (64 lowercase hex): `system`, and `tools`, `prompt` (the head on a split request, else the prompt as that request sent it) and `format` where it had them; `cache_marked` says which parts carried a marker.',
      'Caching 3-B (A6), 3-M (A-0): a SHA-256 for each part of what the request sent: `system`, and `tools`, `prompt` (the head on a split request, else the prompt as that request sent it) and `format` where it had them; `cache_marked` says which parts carried a marker.',
      'Caching 3-B (A6, C5): whether this request carried strict structured output or strict tool arguments',
    ]) {
      claimComment(RUN_RECORD, sentence);
    }
  });
});

describe('caching 3-M A-0 — the CHANGELOG', () => {
  it('the facts on more requests, and CacheMarkedPart’s new word', () => {
    // Every request and the one exception: check 2 and check 4's cells; the split facts stay on a
    // split request: the `split` pins of checks 1, 2 and 4; `conversation`: check 2 and core
    // `split-facts-3b.test.ts`.
    claimChangelog(
      "- **Every request Realm's Anthropic and OpenAI providers make records what it sent, not only one whose prompt was split:** `prefix_parts` and `request_strict_sent`, and `cache_marked` when a part carried a marker or the key. Anthropic's tool-loop final request is the one exception. `prefix_sha256` and `prefix_chars` stay on a split request only. `CacheMarkedPart` gains `conversation`: the marker Anthropic's tool turns put on the conversation so far. (#600)",
    );
  });
});
