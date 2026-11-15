// corpus-guard.test.ts — CP-7: no published release goes without its corpus. Every `## [x.y.z]`
// heading in CHANGELOG.md from 0.49.0 on (patches included) has either its corpus folder
// (`packages/cli/src/corpus/<version>/`, recorded by scripts/corpus/record.mjs after the publish,
// Part B step 7a) or a PENDING marker (that folder holding only `PENDING`, committed with the
// changelog at Part B step 2), and a marker may stand only at the topmost heading: the release being
// cut. So a release whose recording was forgotten turns this red at the next release cut. It also
// fails a folder holding a marker and artifacts both, and a folder or marker naming a version the
// changelog has no heading for. The cells under (6) pin the sentences that tell a person so.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '../../../..');
const FIRST = '0.49.0';

/** The changelog's release headings, topmost first. */
function releaseHeadings(changelog: string): string[] {
  return [...changelog.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map((m) => m[1]!);
}

function atOrAfter(version: string, floor: string): boolean {
  const a = version.split('.').map(Number);
  const b = floor.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return true;
}

/** What each version folder holds, by name. */
function corpusFolders(root: string): Map<string, string[]> {
  return new Map(
    readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^\d+\.\d+\.\d+$/.test(d.name))
      .map((d) => [d.name, readdirSync(join(root, d.name))]),
  );
}

/** Every way the corpus and the changelog disagree, one line each; none when they agree. */
function guardProblems(
  headings: readonly string[],
  folders: ReadonlyMap<string, string[]>,
): string[] {
  const problems: string[] = [];
  const released = headings.filter((v) => atOrAfter(v, FIRST));
  for (const version of released) {
    const held = folders.get(version) ?? [];
    if (held.length === 0) {
      problems.push(
        `## [${version}] has neither a corpus folder nor a PENDING marker in packages/cli/src/corpus/${version}/: ` +
          'record it (Part B step 7a)',
      );
    }
  }
  for (const [version, held] of folders) {
    if (!headings.includes(version)) {
      problems.push(
        `packages/cli/src/corpus/${version}/ names a version CHANGELOG.md has no ## [${version}] heading for`,
      );
    }
    if (held.includes('PENDING') && held.length > 1) {
      problems.push(
        `packages/cli/src/corpus/${version}/ holds a PENDING marker and artifacts (${held
          .filter((n) => n !== 'PENDING')
          .join(', ')}): the recording deletes the marker`,
      );
    }
    if (held.includes('PENDING') && headings[0] !== version) {
      problems.push(
        `packages/cli/src/corpus/${version}/PENDING stands below ## [${headings[0]}]: ${version} was released ` +
          'and its corpus never recorded (Part B step 7a)',
      );
    }
  }
  return problems;
}

describe('the corpus guard: every release from 0.49.0 on has its corpus or its PENDING marker', () => {
  it('(5) the changelog and the corpus folders agree', () => {
    const headings = releaseHeadings(readFileSync(join(REPO, 'CHANGELOG.md'), 'utf8'));
    expect(headings).toContain(FIRST);
    expect(guardProblems(headings, corpusFolders(HERE))).toEqual([]);
  });

  it('(5) the guard knows each state', () => {
    const recorded = ['manifest.json', 'realm.db.gz', 'runs', 'examples', 'project'];
    const cases: Array<[string, string[], Array<[string, string[]]>, number]> = [
      ['the first corpus', ['0.49.0'], [['0.49.0', recorded]], 0],
      [
        'a release PR: its marker at the topmost heading',
        ['0.50.0', '0.49.0'],
        [
          ['0.49.0', recorded],
          ['0.50.0', ['PENDING']],
        ],
        0,
      ],
      [
        'the recording landed',
        ['0.50.0', '0.49.0'],
        [
          ['0.49.0', recorded],
          ['0.50.0', recorded],
        ],
        0,
      ],
      ['a release with neither', ['0.50.0', '0.49.0'], [['0.49.0', recorded]], 1],
      [
        'an empty folder',
        ['0.50.0', '0.49.0'],
        [
          ['0.49.0', recorded],
          ['0.50.0', []],
        ],
        1,
      ],
      [
        'a marker below the topmost heading',
        ['0.50.1', '0.50.0', '0.49.0'],
        [
          ['0.49.0', recorded],
          ['0.50.0', ['PENDING']],
        ],
        2,
      ],
      [
        'a marker and artifacts',
        ['0.50.0', '0.49.0'],
        [
          ['0.49.0', recorded],
          ['0.50.0', ['PENDING', 'manifest.json']],
        ],
        1,
      ],
      [
        'a folder with no heading',
        ['0.49.0'],
        [
          ['0.49.0', recorded],
          ['0.48.0', recorded],
        ],
        1,
      ],
      ['an older release needs none', ['0.49.0', '0.48.0'], [['0.49.0', recorded]], 0],
    ];
    for (const [label, headings, folders, count] of cases) {
      expect(guardProblems(headings, new Map(folders)), label).toHaveLength(count);
    }
  });
});

describe('(6) the words that tell a person about the corpus', () => {
  it('the compatibility page says the stored data is recorded and read back, after the stored-data paragraph', () => {
    const page = readFileSync(join(REPO, 'docs/reference/compatibility.md'), 'utf8');
    const paragraph = page
      .split('\n')
      .find((line) => line.startsWith('Stored data has its own guard.'));
    const before =
      "except where the changelog says otherwise (once so far, 0.42.0's `trust` check). ";
    const sought =
      "Each release's export files and stored runs, and the shapes its loader gives the example workflows, are " +
      'recorded from the published package into the repository (`packages/cli/src/corpus/<version>/`, from 0.49.0 ' +
      "on), and every later release's tests read them back and require the same shapes; a change that is meant " +
      'lands as a reviewed exception file beside the artifact and is named in the changelog.';
    expect(paragraph, `sought: ${before}${sought}`).toBeDefined();
    expect(
      paragraph!.endsWith(before + sought),
      `sought: …${before}${sought}\nfound: ${paragraph}`,
    ).toBe(true);
  });

  it('the release checklist commits the marker at step 2 and records the corpus at step 7a', () => {
    const checklist = readFileSync(
      join(REPO, '.github/instructions/pre-publication.instructions.md'),
      'utf8',
    );
    const marker =
      "`packages/cli/src/corpus/<version>/PENDING` is created with one line, the heading's date, and added to the " +
      "same commit: the corpus guard then knows this release's recording is owed.";
    const step2 = checklist.slice(
      checklist.indexOf('**2. Update CHANGELOG.md**'),
      checklist.indexOf('**3. Run the release script**'),
    );
    expect(step2, `sought in step 2: ${marker}`).toContain(marker);
    expect(step2, 'step 2 stages the marker').toMatch(
      /^git add .*packages\/cli\/src\/corpus\/<version>\/PENDING/m,
    );
    const record =
      'Prepare the published packages once: `mkdir <nm> && cd <nm> && npm install --no-save ' +
      '@sensigo/realm-cli@<version> @sensigo/realm-testing@<version>` (a registry read; no sign-in). Then, in the ' +
      'repository root, in a clean environment: `env -i PATH="$PATH" HOME=<any folder> NM=<nm> WORK=<a fixed empty ' +
      'folder outside any home, with no package.json or .git above it> node scripts/corpus/record.mjs <version>`. ' +
      "It records the release's corpus into `packages/cli/src/corpus/<version>/` and deletes the `PENDING` " +
      'marker; the CLI it runs never sees your HOME. Commit the folder on a branch and open its PR; the corpus ' +
      'cells and the guard must be green.';
    const step7a = checklist.slice(
      checklist.indexOf("**7a. Record the release's corpus**"),
      checklist.indexOf('**8. Create the GitHub Release**'),
    );
    expect(
      checklist.indexOf("**7a. Record the release's corpus**"),
      'step 7a, after step 7',
    ).toBeGreaterThan(checklist.indexOf('**7. Verify the published artifact**'));
    expect(step7a, `sought in step 7a: ${record}`).toContain(record);
  });
});
