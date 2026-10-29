// docs-918.test.ts — issue #918 (guardrail 7(f), 9), N5: the docs no longer describe the OpenAI
// shared-start form the `cache:` line dropped. The new texts are pinned word for word by the
// re-pinned claims in docs-pr5-cacheability.test.ts, so nothing is pinned twice; this cell checks
// only that each old text is gone, read from the repository. Each assertion names (a) the change
// that turns it red and (b) what it prints when it fails: the file name and the old text found.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const flat = (t: string): string => t.replace(/\s+/g, ' ');
const read = (page: string): string => flat(readFileSync(join(ROOT, page), 'utf8'));

/** Each old text, by the file that held it before #918. */
const GONE: Array<[string, string[]]> = [
  [
    'docs/reference/cli/realm-workflow.md',
    [
      'On OpenAI, two steps that carry the same profile are named too when they first differ in the schema, which comes after it.',
      'The line then says `shares its first <n> chars with …: the schemas differ`.',
      'With a minimum in force, they are named only when the estimate of the start they share reaches it or comes near it.',
      "On OpenAI the `<n> chars` count Realm's own text after the profile too, so with a short profile most of them are Realm's.",
      'The line says what the text shares, not how much of it is yours.',
      'No other shared start is named.',
      '(on OpenAI also a start shared after a profile;',
    ],
  ],
  [
    'docs/reference/workflow/loader-diagnostics.md',
    ['a cacheable start', '`divergence_at` (the name of the segment'],
  ],
  ['CHANGELOG.md', ['(on OpenAI, also a start they share after a profile)']],
];

describe('#918 N5 — the shared-start words are gone', () => {
  it('the workflow page, the diagnostics row and the CHANGELOG hold none of the old texts', () => {
    // (a) red when any of the three files is put back to its text before #918; (b) prints each file
    //     name with the old text found in it.
    const found = GONE.flatMap(([file, texts]) => {
      const page = read(file);
      return texts.filter((text) => page.includes(flat(text))).map((text) => `${file}: ${text}`);
    });
    expect(found).toEqual([]);
  });
});
