// library-reference.test.ts — CP-1 PR 2: the library reference, generated and kept by tests. Six pages
// under `docs/reference/library/`, one per job a program does with Realm's library, list every name of
// `@sensigo/realm` and `@sensigo/realm-mcp` tagged `@public` or `@beta`, each with its description (its
// JSDoc) and its declaration (the API report's text). `scripts/generate-library-reference.mjs` writes
// them from `docs/reference/library/jobs.json`, the committed API reports and the BUILT d.ts; this test
// runs it as a process into a temporary folder, with `--manifest`, and compares.
//
// THE CELLS: (d) every tagged name has a description, one entry on exactly one page, and a link from
// every other page whose job reaches it; the six pages' entries are the reports' tagged names, both
// ways; the committed pages are the generator's output, byte for byte; `jobs.json`'s entry points are
// each a tagged name; (3) where the names the docs lean on are placed; (5) the words the docs say
// about the reference. Every cell also needs the generator to exit clean, and the generator refuses a
// description that Markdown would misread (`<` and a letter outside a code span) and an index sentence
// (a description's first sentence) that carries an internal marker, a shouted word, or runs over 200
// characters: each is a red line naming the entry.
//
// TO REGENERATE (a change made on purpose — a new tag, a new description, a new job entry point):
// `npm run build`, then `npm run docs:library` (both from the repository root), and commit the pages.
//
// Each cell carries (a) the change that turns it red and (b) what it prints on failure.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..', '..');
const LIBRARY = join(ROOT, 'docs/reference/library');
const GENERATOR = join(ROOT, 'scripts/generate-library-reference.mjs');
const REGENERATE = '`npm run build`, then `npm run docs:library` (from the repository root)';
const PAGES = [
  'define-and-load-a-workflow.md',
  'run-and-drive-a-run.md',
  'write-a-handler.md',
  'implement-a-store.md',
  'embed-the-mcp-server.md',
  'read-a-runs-record.md',
] as const;
// The generator's run can take a few seconds on a loaded machine (2 s measured on an idle one).
const BUDGET = 60_000;

interface ManifestName {
  page: string;
  links: string[];
  description: boolean;
  tier: string;
  entries: string[];
}
interface Manifest {
  names: Record<string, ManifestName>;
  pages: Record<string, number>;
}
interface Job {
  page: string;
  entryPoints: string[];
}

/** The names the committed API reports tag `@public` or `@beta` (a row's tag other than `internal`). */
function taggedInReports(): Set<string> {
  const tagged = new Set<string>();
  for (const report of [
    'packages/core/src/inventory/api-report.txt',
    'packages/mcp-server/src/inventory/api-report.txt',
  ]) {
    for (const line of readFileSync(join(ROOT, report), 'utf8').split('\n')) {
      const row = /^([A-Za-z_$][\w$]*) · (?:value|type|both) · (.+)$/.exec(line);
      if (row !== null && row[2] !== 'internal') tagged.add(row[1]!);
    }
  }
  return tagged;
}

/** The `### name` entries of a page. */
function entriesOf(page: string): string[] {
  return [...page.matchAll(/^### (\S+)$/gm)].map((m) => m[1]!);
}

/** The anchor the generator gives an entry: the name lowercased, without other characters. */
const anchorOf = (name: string): string => name.toLowerCase().replace(/[^a-z0-9_-]/g, '');

/** The first lines where two texts differ, as `-`/`+` pairs, with their line numbers. */
function lineDiff(committed: string, generated: string, limit = 8): string[] {
  const a = committed.split('\n');
  const b = generated.split('\n');
  const out: string[] = [];
  for (let i = 0; i < Math.max(a.length, b.length) && out.length < limit * 2; i++) {
    if (a[i] === b[i]) continue;
    out.push(`  ${i + 1} - ${a[i] ?? '(no line)'}`, `  ${i + 1} + ${b[i] ?? '(no line)'}`);
  }
  return out;
}

let outDir = '';
let generated: { status: number | null; stderr: string; manifest: Manifest | undefined };

beforeAll(() => {
  outDir = mkdtempSync(join(tmpdir(), 'realm-library-reference-'));
  const manifestFile = join(outDir, 'manifest.json');
  const run = spawnSync(
    process.execPath,
    [GENERATOR, '--out', outDir, '--manifest', manifestFile],
    { cwd: ROOT, encoding: 'utf8', timeout: BUDGET },
  );
  let manifest: Manifest | undefined;
  try {
    manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as Manifest;
  } catch {
    manifest = undefined;
  }
  generated = { status: run.status, stderr: run.stderr, manifest };
}, BUDGET);

afterAll(() => {
  if (outDir !== '') rmSync(outDir, { recursive: true, force: true });
});

/** The manifest, once the generator has run clean; red with the generator's own words otherwise. */
function manifestOrRed(): Manifest {
  // (a) red when the generator exits 1 (an orphan, a lowercase collision, an untagged entry point,
  // `<` and a letter outside a code span, a first sentence with an internal marker, a shouted word, or
  // over 200 characters); (b) prints its exit status and its error lines.
  expect({ status: generated.status, stderr: generated.stderr.trim() }).toEqual({
    status: 0,
    stderr: '',
  });
  expect(generated.manifest).toBeDefined();
  return generated.manifest!;
}

describe('CP-1 — the library reference', { timeout: BUDGET }, () => {
  it('(d) every tagged name has a description on its declaration', () => {
    const manifest = manifestOrRed();
    const without = Object.entries(manifest.names)
      .filter(([, n]) => !n.description)
      .map(([name]) => name)
      .sort();
    // (a) red when a tagged declaration's JSDoc has no description (a tag line alone is none);
    // (b) prints the names without one.
    expect(without).toEqual([]);
  });

  it('(d) every tagged name is an entry on exactly one page, linked from every other page whose job reaches it', () => {
    const manifest = manifestOrRed();
    const pages = new Map<string, string>(
      PAGES.map((page) => [page, readFileSync(join(LIBRARY, page), 'utf8')]),
    );
    const problems: string[] = [];
    for (const [name, n] of Object.entries(manifest.names)) {
      const on = PAGES.filter((page) => entriesOf(pages.get(page)!).includes(name));
      if (on.length !== 1 || on[0] !== n.page)
        problems.push(`${name}: an entry on [${on.join(', ')}], expected on ${n.page}`);
      const link = `[\`${name}\`](${n.page}#${anchorOf(name)})`;
      const missing = n.links.filter((page) => !(pages.get(page) ?? '').includes(link));
      if (missing.length > 0) problems.push(`${name}: no link from ${missing.join(', ')}`);
    }
    // (a) red when a name has two entries, none, or an entry on another page than the walk places it,
    // or a page whose job reaches it does not link to it; (b) prints the name and the pages.
    expect(problems).toEqual([]);
  });

  it("(d) the six pages' entries are the reports' tagged names, both ways", () => {
    manifestOrRed();
    const onPages = new Set(
      PAGES.flatMap((page) => entriesOf(readFileSync(join(outDir, page), 'utf8'))),
    );
    const tagged = taggedInReports();
    // (a) red when the walk stops reaching a tagged name (a reference kind dropped) or a page lists a
    // name the reports do not tag; (b) prints each side's names the other lacks.
    expect({
      taggedButOnNoPage: [...tagged].filter((n) => !onPages.has(n)).sort(),
      onAPageButNotTagged: [...onPages].filter((n) => !tagged.has(n)).sort(),
    }).toEqual({ taggedButOnNoPage: [], onAPageButNotTagged: [] });
  });

  it('(d) the committed pages are the generator’s output', () => {
    manifestOrRed();
    const differing = PAGES.flatMap((page) => {
      const committed = readFileSync(join(LIBRARY, page), 'utf8');
      const fresh = readFileSync(join(outDir, page), 'utf8');
      return committed === fresh
        ? []
        : [`docs/reference/library/${page}:`, ...lineDiff(committed, fresh)];
    });
    // (a) red when a page is edited by hand, or a description, a tag or a declaration changed and the
    // pages were not regenerated; (b) prints each page's first differing lines and the command.
    expect(differing, `regenerate with ${REGENERATE}`).toEqual([]);
  });

  it("(d) jobs.json's entry points are each a tagged name", () => {
    const jobs = (JSON.parse(readFileSync(join(LIBRARY, 'jobs.json'), 'utf8')) as { jobs: Job[] })
      .jobs;
    const tagged = taggedInReports();
    const untagged = jobs.flatMap((job) =>
      job.entryPoints.filter((name) => !tagged.has(name)).map((name) => `${job.page}: ${name}`),
    );
    // (a) red when an entry point is not a `@public`/`@beta` name of the reports; (b) prints its page
    // and name.
    expect(untagged).toEqual([]);
    expect(jobs.map((job) => job.page)).toEqual([
      'write-a-handler.md',
      'define-and-load-a-workflow.md',
      'run-and-drive-a-run.md',
      'implement-a-store.md',
      'embed-the-mcp-server.md',
      'read-a-runs-record.md',
    ]);
  });

  it('(3) where the names the docs lean on are placed', () => {
    const manifest = manifestOrRed();
    const placed = Object.fromEntries(
      [
        'StepHandler',
        'RunStore',
        'WorkflowDefinition',
        'RunRecord',
        'EvidenceSnapshot',
        'createRealmMcpServerOnHome',
        'createDefaultRegistry',
      ].map((name) => [name, manifest.names[name]?.page]),
    );
    const registry = readFileSync(join(LIBRARY, 'write-a-handler.md'), 'utf8');
    const header = /### createDefaultRegistry\n\n(.+)\n/.exec(registry)?.[1];
    // (a) red when one of them moves page, or the registry's header loses its second package;
    // (b) prints where each is.
    expect({ placed, header }).toEqual({
      placed: {
        StepHandler: 'write-a-handler.md',
        RunStore: 'implement-a-store.md',
        WorkflowDefinition: 'define-and-load-a-workflow.md',
        RunRecord: 'read-a-runs-record.md',
        EvidenceSnapshot: 'read-a-runs-record.md',
        createRealmMcpServerOnHome: 'embed-the-mcp-server.md',
        createDefaultRegistry: 'write-a-handler.md',
      },
      header: 'function · public · also exported from `@sensigo/realm-mcp`',
    });
  });

  it('(5) the words: the core library page, the changelog and the docs index', () => {
    const flat = (t: string): string => t.replace(/\s+/g, ' ');
    const words: ReadonlyArray<readonly [string, string]> = [
      [
        'docs/reference/core-library.md',
        'The six reference pages under [`library/`](library/define-and-load-a-workflow.md) list every promised name by the job it serves, with its declaration, generated from the tagged declarations.',
      ],
      [
        'CHANGELOG.md',
        '- The library reference: six pages under `docs/reference/library/`, one per job Realm supports, generated from the `@public`/`@beta` tags with each declaration and its description; a promised name without a description, or missing from its page, fails a test.',
      ],
      [
        'CHANGELOG.md',
        "- The library reference's index: the first sentence of every promised name now says what it is for, in a reader's words; a first sentence that carries an issue number, a design label, a date or a shouted word, or runs over 200 characters, fails the reference's test.",
      ],
    ];
    const found = words.map(([page, sentence]) => [
      page,
      flat(readFileSync(join(ROOT, page), 'utf8')).includes(flat(sentence)),
    ]);
    const index = readFileSync(join(ROOT, 'docs/README.md'), 'utf8');
    const section = (heading: string): string =>
      index.split(/^## /m).find((s) => s.startsWith(`${heading}\n`)) ?? '';
    const library = section('Reference: library');
    const sought = [
      'reference/core-library.md',
      ...PAGES.map((page) => `reference/library/${page}`),
    ];
    // (a) red when one word of a sentence differs, a page leaves the index's library section, or the
    // core library page is still listed under code and settings; (b) prints what was sought and found.
    expect({
      found,
      inLibrarySection: sought.filter((link) => library.includes(`](${link})`)),
      coreLibraryUnderCodeAndSettings: section('Reference: code and settings').includes(
        'reference/core-library.md',
      ),
    }).toEqual({
      found: words.map(([page]) => [page, true]),
      inLibrarySection: sought,
      coreLibraryUnderCodeAndSettings: false,
    });
  });
});
