// docs-g3u2a.test.ts — gap 3, unit 2a, check 7: every new sentence about the memory row and the key
// part's cap, pinned word for word where a person reads it, beside the cells that execute it:
// core's store/memory-rows-g3u2a.test.ts (the cap through a real settle, check 1; `memoryRowsOf`,
// checks 2–6). The run store's member count is pinned by docs-715b.test.ts, which derives it from
// the built interface. (a) red when the page no longer holds the sentence word for word; (b) prints
// the sentence.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

function claim(page: string, sentence: string): void {
  const flat = (t: string): string => t.replace(/\s+/g, ' ');
  expect(
    flat(readFileSync(join(ROOT, page), 'utf8')),
    `${page} no longer says: ${sentence}`,
  ).toContain(flat(sentence));
}

describe('gap 3 (2a), check 7 — the words', () => {
  it("core-library.md: the run store's memory member", () => {
    claim(
      'docs/reference/core-library.md',
      "| `memory` | No | Without it, or `null`, the store keeps no memory. Otherwise its memory store, an object with `rowsOfRun(runId)`: the memory rows Realm derived from that run's `remembered` stamps, in entry order. No store keeps one yet. Added after version 0.50.0. |",
    );
  });

  it('CHANGELOG.md: the entry, sentence by sentence', () => {
    for (const sentence of [
      "- Core declares the memory store's port: `RunStore`'s `memory` (beta), `MemoryStore` and `MemoryRow`.",
      'No store implements it yet.',
      'A step whose key part is over 1 KB remembers nothing: `NOT_REMEMBERED_REASONS` and `NotRememberedReason` gain `key_too_large`.',
    ])
      claim('CHANGELOG.md', sentence);
  });

  it("the library's pages: the reasons' sentence, and the row and its store", () => {
    claim(
      'docs/reference/library/read-a-runs-record.md',
      'a key part was absent, `null`, empty or only whitespace, not text or a finite number, held a mask marker, or was over 1 KB in UTF-8; what it would keep was over 32 KB as JSON.',
    );
    for (const sentence of [
      'One memory row: what one evidence entry remembered for later runs, as a store keeps it.',
      "A store must write a run's rows in the same transaction as the run's evidence, and never change one.",
      "A store's memory: the rows it derived from its runs' `remembered` stamps.",
    ])
      claim('docs/reference/library/implement-a-store.md', sentence);
  });
});
