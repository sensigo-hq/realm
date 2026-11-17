// The docs pages' frontmatter as sync-docs writes it (scripts/sync-docs.mjs): the library reference
// pages' "On this page" panel lists their `##` sections only (Starlight's `tableOfContents`, at most
// level 2); every other page keeps Starlight's default. The test runs sync-docs on this checkout's docs
// and reads the pages it wrote (src/content/docs/docs/, ignored by git, written by every build).
//
// Run: `npm run test:deploy-build` in website/ (it runs this file too), or `node --test` on it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(WEB, 'src', 'content', 'docs', 'docs');

/** A written page's frontmatter: the text between its first two `---` lines. */
function frontmatter(file) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const end = lines.indexOf('---', 1);
  return lines.slice(1, end).join('\n');
}

test('sync-docs: the library reference pages list their sections only in the panel; another page keeps the default', () => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('REALM_DOCS_')),
  );
  const run = spawnSync(process.execPath, ['scripts/sync-docs.mjs'], {
    cwd: WEB,
    env,
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  const library = path.join(OUT, 'reference', 'library');
  const pages = fs
    .readdirSync(library)
    .filter((n) => n.endsWith('.md'))
    .sort();
  // (1) red when the key is not written for a library page, or is written for another page;
  //     (2) prints each page with its frontmatter.
  assert.equal(pages.length, 6, `the library pages: ${pages.join(', ')}`);
  for (const page of pages) {
    const fm = frontmatter(path.join(library, page));
    assert.match(fm, /^tableOfContents:\n {2}maxHeadingLevel: 2$/m, `${page}:\n${fm}`);
  }
  const other = frontmatter(path.join(OUT, 'reference', 'workflow', 'step-fields.md'));
  assert.doesNotMatch(other, /tableOfContents/, `reference/workflow/step-fields.md:\n${other}`);
});
