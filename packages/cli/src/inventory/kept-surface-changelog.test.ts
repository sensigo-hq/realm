// kept-surface-changelog.test.ts — CP-I, the accept rule (Go's `cmd/api` rule): an entry of the kept
// surface that changed since the last release is named in the changelog. `kept-surface.frozen.txt` is
// `kept-surface.txt` as of the last release (a plain file: `vitest -u` never touches it; the release
// checklist's Part B copies the live file over it at each cut). Every row added, removed or changed
// between the two must have its key, in backticks, under `## [Unreleased]` in CHANGELOG.md — except
// rows marked `hidden` and the `exit site` / `reply site` rows, which are listed to be seen, not
// promised. And the compatibility page says where the list is.
//
// Each cell carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..', '..');
const LIVE = join(HERE, 'kept-surface.txt');
const FROZEN = join(HERE, 'kept-surface.frozen.txt');
/** The key of a row is the text before this separator (as `kept-surface.test.ts` renders it). */
const SEP = ' — ';

/** The rows a release promises: not comments, not `hidden`, not a site row. */
function promised(text: string): string[] {
  let section = '';
  return text.split('\n').filter((line) => {
    if (line.startsWith('## ')) section = line.slice(3);
    if (line === '' || line.startsWith('#')) return false;
    if (/^(exit|reply) site /.test(line)) return false;
    const attributes = line.slice(line.indexOf(SEP) + SEP.length).split(', ');
    return !(section === 'commands' && attributes.includes('hidden'));
  });
}

/** The keys of the rows that are in one file and not in the other (a changed row is in both lists). */
function changedKeys(live: string[], frozen: string[]): { added: string[]; removed: string[] } {
  const count = new Map<string, number>();
  for (const r of live) count.set(r, (count.get(r) ?? 0) + 1);
  for (const r of frozen) count.set(r, (count.get(r) ?? 0) - 1);
  const keyOf = (r: string): string => r.slice(0, r.indexOf(SEP));
  const keys = (sign: number): string[] =>
    [...new Set([...count].filter(([, n]) => Math.sign(n) === sign).map(([r]) => keyOf(r)))].sort();
  return { added: keys(1), removed: keys(-1) };
}

/** The changelog's `## [Unreleased]` section. */
function unreleased(): string {
  const text = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
  const at = text.indexOf('\n## [Unreleased]');
  const next = text.indexOf('\n## [', at + 1);
  return at === -1 ? '' : text.slice(at, next === -1 ? undefined : next);
}

describe('CP-I — a changed entry of the kept surface is named in the changelog', () => {
  it('every key added, removed or changed since the frozen copy is under `## [Unreleased]`, in backticks', () => {
    const frozenText = readFileSync(FROZEN, 'utf8');
    const live = promised(readFileSync(LIVE, 'utf8'));
    const frozen = promised(frozenText);
    // The instrument: the frozen copy is a frozen inventory, and both files were read in full.
    expect({
      frozenHeader: /^# frozen at /m.test(frozenText),
      liveRows: live.length > 200,
      frozenRows: frozen.length > 200,
    }).toEqual({ frozenHeader: true, liveRows: true, frozenRows: true });
    const { added, removed } = changedKeys(live, frozen);
    const section = unreleased();
    // (a) red when an inventory entry changed (a flag renamed, a default, an exit code, a reply code)
    //     and the changelog does not name its key; a `hidden` flag or a site row demands nothing;
    //     (b) prints the keys that are missing, the new ones and the old ones.
    expect({
      missingFromTheChangelog: {
        added: added.filter((k) => !section.includes(`\`${k}\``)),
        removed: removed.filter((k) => !section.includes(`\`${k}\``)),
      },
    }).toEqual({ missingFromTheChangelog: { added: [], removed: [] } });
  });
});

/** Words 1, verbatim: the second paragraph of the compatibility page's "What a release keeps". */
const SENTENCE =
  "The CLI's commands, flags and exit codes, and the reply codes of `realm listen` and `realm serve`, are listed in one file in the repository, `packages/cli/src/inventory/kept-surface.txt`. The test suite regenerates that list from the code and fails when it differs from the file, and it fails too when an entry changed since the last release without a changelog line naming it — so a change to them is made on purpose, in the same change as the line that announces it.";

describe('CP-I — the compatibility page says where the kept surface is listed', () => {
  it('the paragraph is the second of "What a release keeps", and the file it names exists', () => {
    const page = readFileSync(join(ROOT, 'docs/reference/compatibility.md'), 'utf8');
    const at = page.indexOf('\n## What a release keeps\n');
    const section = page.slice(at, page.indexOf('\n## ', at + 1));
    const paragraphs = section
      .split('\n\n')
      .map((p) => p.trim())
      .filter((p) => p !== '' && !p.startsWith('## '));
    const named = /`(packages\/[^`]+)`/.exec(SENTENCE)?.[1] ?? '';
    // (a) red when the paragraph is reworded, moved or removed, or the file it names is moved; (b)
    //     prints the sentence sought, the paragraph found and whether the file exists.
    expect({ paragraph: paragraphs[1], named, exists: existsSync(join(ROOT, named)) }).toEqual({
      paragraph: SENTENCE,
      named: 'packages/cli/src/inventory/kept-surface.txt',
      exists: true,
    });
  });
});
