// store-door-616.test.ts — issue #616 PR-2a, unit (iii): the law that every store a host builds comes
// through its one door. A source scan, table-driven by package: each row names the only files of that
// package allowed to construct one of the six store classes. The CLI's row was the door
// (`lib/home.ts`) alone, since 2c removed the two commands that kept their own constructions; since
// #616 PR-2c c10a-3a the door opens the SQLite home (the store package builds its stores), so the
// CLI's row is empty, as core's is. Unit (ii-b) added the MCP package's row. Before this unit the CLI built its
// stores by hand in 60 places in 27 files, so a command could build one of them on a folder its
// other stores do not read (the #188 mixed-wiring class).
//
// #616 PR-2b (A1): a second table, for the package's test files. A test opens its stores through the
// package's test helper (`makeTempHome`), so unit 2c changes the door and the tests follow; the table
// names the few test files that still construct a store, each with its count and its subject.
//
// #616 PR-2c c1a: core joined both tables once c1a routed the engine's tests onto the in-memory
// stores. Core's production source builds none of the six, so its row in the first table is empty
// and that cell's check that the walk read each allowed file has nothing to check; the second
// table's exact counts for core's kept test files are what show the walk read core. The scan sees a
// construction BY NAME: a subclass's `new X(` (judged-snapshot-715b's `InterposingStore` once was) is
// invisible to it, as to `count-sites.mjs`.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// packages/cli/src/lib → packages/
const PACKAGES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Package → the files (relative to its src/) allowed to construct a store: the package's opener.
 *  The test helpers under `src/test-support/`, which
 *  the walker reads as non-test source, build none (#616 PR-2b, b3). */
const ALLOWED: Record<string, string[]> = {
  // #616 PR-2c c10a-3a: the door opens the SQLite home (`openRealmHome`); it constructs none of the six.
  cli: [],
  // #616 PR-2c c10b-2: the `realm-mcp` program's door opens the SQLite home; it constructs none of the six.
  'mcp-server': [],
  // #616 PR-2c c1a: core opens no store; a host does.
  core: [],
};

/** Test files allowed to construct a store, each with how many constructions it holds and its
 *  subject. Every other test file opens its stores through the package's test helper
 *  (`makeTempHome`, #616 PR-2b). The count keeps the list exact: a routed file that constructs again
 *  is a stray, a listed file that grows one is red. 2c deleted gc's rows with the command; PR-3
 *  deletes the rest with the classes, the mcp-server rows (b3) among them. */
const ALLOWED_TESTS: Record<string, Array<{ file: string; sites: number; subject: string }>> = {
  cli: [
    {
      file: 'commands/lazy-home-resolution-285.test.ts',
      sites: 1,
      subject:
        "`JsonFileReplayStore` resolves its default folder at construction (#285): the JSON class's own behaviour; PR-3",
    },
    {
      file: 'commands/purge.test.ts',
      sites: 4,
      subject:
        "the store helper builds the three JSON stores itself (the JSON per-store path, c10a-2a; PR-3), and one cell: the fence judged against the trace buffer's OWN reader, an anchor stub (the door wires the run store as reader)",
    },
    {
      file: 'multi-copy/multi-copy.test.ts',
      sites: 9,
      subject:
        "two copies of core on one home: the release-line law; its constructions through each copy's namespace ARE the subject; PR-3",
    },
    {
      file: 'lib/dedup-store.test.ts',
      sites: 5,
      subject:
        "`FileDedupStore`'s own cells (the in-memory cells build none of the six); PR-3 deletes the class",
    },
    {
      file: 'store-contracts/failed-attempt-store.contract.test.ts',
      sites: 1,
      subject: 'TCK conformance of `JsonFileFailedAttemptStore`; PR-3',
    },
    {
      file: 'store-contracts/json-file-store.contract.test.ts',
      sites: 1,
      subject: 'TCK conformance of `JsonFileStore`; PR-3',
    },
    {
      file: 'store-contracts/json-trace-buffer-store-fenced.contract.test.ts',
      sites: 1,
      subject: "the fenced trace buffer's contract, with a lock profile the door cannot pass; PR-3",
    },
    {
      file: 'store-contracts/json-trace-buffer-store.contract.test.ts',
      sites: 2,
      subject: 'TCK conformance of `JsonTraceBufferStore`; PR-3',
    },
    {
      file: 'store/replay-store.test.ts',
      sites: 1,
      subject: "`JsonFileReplayStore`'s own test; PR-3",
    },
    {
      file: 'test-support/json-as-run-store.test.ts',
      sites: 1,
      subject:
        "#616 PR-2c c4: the `jsonAsRunStore` adapter's own cell (the JSON store seen as a `RunStore`); PR-3 deletes both",
    },
  ],
  'mcp-server': [
    {
      file: 'json-trace-buffer-store.test.ts',
      sites: 6,
      subject:
        "`JsonTraceBufferStore`'s own cells: a stub reader, a refused non-reader, a missing folder, a broken folder; PR-3 deletes the class",
    },
    {
      file: 'release-line-hand-offs.test.ts',
      sites: 2,
      subject:
        "H3: the class refuses a run reader with no release line or another release's, the whole messages; PR-3",
    },
    {
      file: 'tools/failed-attempt-telemetry.test.ts',
      sites: 1,
      subject:
        'one cell: a sidecar store on a folder that does not exist (best-effort independence); PR-3',
    },
  ],
  // #616 PR-2c c1a: the engine's tests build their run stores in memory; these keep a JSON
  // construction because the JSON store (or registry) is their subject. PR-3 deletes them.
  core: [
    {
      file: 'engine/docs-claims-625.test.ts',
      sites: 2,
      subject:
        'the three docs cells about a run file that is not JSON, each on its own clocked JSON store, and the registry cell ("Register it with `realm workflow register <file>`": the JSON registry\'s copy judge); c12 rewrites them, PR-3',
    },
    {
      file: 'engine/execution-loop.test.ts',
      sites: 1,
      subject:
        'one cell: an unknown run id\'s error envelope carries the JSON store\'s not-found words ("Run not found") and offers no next call; PR-3',
    },
    {
      file: 'engine/sealed-by-substrate.test.ts',
      sites: 1,
      subject:
        'the purge-gate cell: `deleteAllForRun`, a verb the in-memory store lacks (c9 / PR-3)',
    },
    {
      file: 'engine/structured-output-evidence.test.ts',
      sites: 1,
      subject: 'the round-trip cell: a persist and a read through `JsonFileStore`; PR-3',
    },
    {
      file: 'engine/unanswerable-819.test.ts',
      sites: 1,
      subject: "U2/U3: the JSON registry's copy check over planted files; PR-3",
    },
    {
      file: 'engine/w-627.test.ts',
      sites: 5,
      subject:
        'the five registry cells: `getSync` on planted copies, `listWithDiagnostics` over planted shapes, a newer copy whose words embed its path; PR-3',
    },
    {
      file: 'release-line.test.ts',
      sites: 1,
      subject: 'a local `class JsonFileStore {}` fixture branded as another release, not the store',
    },
    {
      file: 'store/claim-clock.test.ts',
      sites: 1,
      subject:
        'describe 1: `claimStep` writes the claim clock atomically, a store-contract law on the JSON store (the contracts pin it on the in-memory and SQLite stores); PR-3',
    },
    {
      file: 'store/failed-attempt-store.test.ts',
      sites: 4,
      subject: "`JsonFileFailedAttemptStore`'s own cells: the `.attempts.jsonl` sidecar; PR-3",
    },
    {
      file: 'store/json-file-store-clock-715.test.ts',
      sites: 4,
      subject:
        '#715 (a)/(b) on the JSON store: readings per member, the pointer files, the per-key floor; PR-3',
    },
    {
      file: 'store/json-file-store.test.ts',
      sites: 6,
      subject: "the JSON store's own cells; PR-3",
    },
    {
      file: 'test-support/json-as-run-store.test.ts',
      sites: 1,
      subject:
        "#616 PR-2c c4: the `jsonAsRunStore` adapter's own cell (the JSON store seen as a `RunStore`); PR-3 deletes both",
    },
    {
      file: 'store/lazy-home-resolution-285.test.ts',
      sites: 2,
      subject: 'construction-time `$HOME` resolution of the two JSON classes; PR-3',
    },
    {
      file: 'store/run-file-readdir-719.test.ts',
      sites: 1,
      subject: 'a runs folder that cannot be listed while a damaged run file is read; PR-3',
    },
    {
      file: 'store/run-file.test.ts',
      sites: 4,
      subject:
        'the run-file reader: every damaged class, the folder errors, the one composer; PR-3',
    },
    {
      file: 'store/test-clock-file.test.ts',
      sites: 8,
      subject:
        "the clock file through the JSON store's construction-time resolution (C1\u2013C6, C-10); PR-3",
    },
    {
      file: 'workflow/registrar-listing-read-719.test.ts',
      sites: 1,
      subject: 'a copy whose read fails after its probe is `unreadable` with its errno; PR-3',
    },
    {
      file: 'workflow/registrar-probe.test.ts',
      sites: 7,
      subject:
        'the shapes a registered copy can be in, through real damaged files (the file-shaped arms); c5 / PR-3',
    },
    {
      file: 'workflow/registrar.test.ts',
      sites: 2,
      subject:
        'describe 1 (register, get, list over planted copies) and C14 (a fresh parse per get); PR-3',
    },
    {
      file: 'workflow/t21-729.test.ts',
      sites: 1,
      subject: "cell 3: the JSON registry's path-carrying arms (unreadable, invalid, legacy); PR-3",
    },
  ],
};

/** A construction of one of the six store classes; the failed-attempt class under both its names
 *  (PR-1b renamed `FailedAttemptStore` to `JsonFileFailedAttemptStore`). A name reached through a
 *  namespace (`new core.JsonFileStore(`, `new cliCore.JsonFileStore(`) is a construction too (#616
 *  PR-2c, c0): the scan missed 15 of them in three files. A subclass's own name is not matched. */
const CONSTRUCTION =
  /\bnew\s+(?:[A-Za-z_$][\w$]*\.)?(JsonFileStore|JsonWorkflowStore|FailedAttemptStore|JsonFileFailedAttemptStore|JsonFileReplayStore|FileDedupStore|JsonTraceBufferStore)\s*\(/;

/** Every non-test, non-declaration .ts source file under a package's src/ (purge-guard's walk). */
function sourceFiles(pkg: string): string[] {
  const root = join(PACKAGES_DIR, pkg, 'src');
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.d.ts')) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

/** Every `*.test.ts` file under a package's src/: the second table's walk. */
function testFiles(pkg: string): string[] {
  const root = join(PACKAGES_DIR, pkg, 'src');
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.test.ts')) out.push(full);
    }
  };
  walk(root);
  return out;
}

/** Whether one source line constructs a store. Comment lines are skipped by the caller; string and
 *  template text on the line is left out first, so a refusal that tells a caller how to build the
 *  stores (`new JsonFileStore()` in a message, #616 PR-2a (ii-b)) is not a construction. */
function isConstruction(line: string): boolean {
  const code = line.replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, '""');
  return CONSTRUCTION.test(code);
}

/** How many constructions one line holds, by the same rule: every match of `CONSTRUCTION` on the line
 *  (a global copy of the pattern). The test table counts constructions, not lines, because its counts
 *  equal `plans/issue-616/pr2b/count-sites.mjs`'s rows and a second construction added to a counted
 *  line must turn it red (`gc.test.ts`, removed in 2c, built two stores on one line in places); the
 *  source table is
 *  unit (iii)'s and keeps counting lines (MA 1's ruling, MA1-2B2-18). */
function constructionsOn(line: string): number {
  const code = line.replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, '""');
  return code.match(new RegExp(CONSTRUCTION.source, 'g'))?.length ?? 0;
}

interface Site {
  file: string;
  line: number;
  text: string;
}

/** The constructions in a package's source, comment lines left out. */
function constructions(pkg: string): { files: string[]; sites: Site[] } {
  return sitesIn(pkg, sourceFiles(pkg));
}

/** The constructions in a package's test files, by the same rule. */
function testConstructions(pkg: string): { files: string[]; sites: Site[] } {
  return sitesIn(pkg, testFiles(pkg));
}

/** The constructions in the given files of a package, comment lines left out; the files relative to
 *  the package's src/. */
function sitesIn(pkg: string, paths: string[]): { files: string[]; sites: Site[] } {
  const root = join(PACKAGES_DIR, pkg, 'src');
  const files = paths.map((f) => relative(root, f).split(sep).join('/'));
  const sites: Site[] = [];
  for (const file of files) {
    readFileSync(join(root, file), 'utf8')
      .split('\n')
      .forEach((text, i) => {
        const trimmed = text.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
        if (isConstruction(text)) sites.push({ file, line: i + 1, text: trimmed });
      });
  }
  return { files, sites };
}

describe('#616 PR-2a (iii) — every store comes through the one door', () => {
  it('the matcher: a string that names a construction is not one; a construction after a string is', () => {
    const inString =
      '      `createRealmMcpServer: no runStore was given — the file stores are new JsonFileStore(), new JsonWorkflowStore()`,';
    const afterString =
      "  const note = 'new JsonFileStore()'; const runStore = new JsonFileStore(dir);";
    // (1) red when the matcher counts a string's text (the library's refusal would read as a
    //     construction and the mcp-server row would fail on approved words), or stops seeing a real
    //     construction on a line that also holds a string (a stray would pass the scan);
    // (2) prints what the matcher said for each line.
    expect({
      inString: isConstruction(inString),
      afterString: isConstruction(afterString),
    }).toEqual({
      inString: false,
      afterString: true,
    });
  });

  for (const [pkg, allowed] of Object.entries(ALLOWED)) {
    it(`${pkg}: ${allowed.length > 0 ? `no file but ${allowed.join(', ')}` : 'no file'} constructs a store`, () => {
      const { files, sites } = constructions(pkg);
      // The instrument accounts for its input: it read each allowed file, and the pattern matches
      // the constructions those files really hold (a scan that read nothing, or a pattern that
      // matches nothing, would pass the next assertion for the wrong reason). (1) red when the walk
      // misses a file or the pattern stops matching a real construction; (2) prints the allowed
      // files and how many constructions the scan found in each.
      const inAllowed = allowed.map((f) => ({
        file: f,
        read: files.includes(f),
        constructions: sites.filter((s) => s.file === f).length,
      }));
      expect(
        inAllowed.every((a) => a.read && a.constructions > 0),
        JSON.stringify(inAllowed),
      ).toBe(true);
      // The law. (1) red when any other file builds one of the six classes — a command that builds
      // its own store again (the 56 sites this unit routed through the door); (2) prints each
      // stray as file:line and its text.
      const strays = sites.filter((s) => !allowed.includes(s.file));
      expect(
        strays.map((s) => `${pkg}/src/${s.file}:${s.line}: ${s.text}`),
        `a store built outside ${pkg}'s door`,
      ).toEqual([]);
    });
  }
});

/** #616 PR-2c c10a-3a correction 1: the SQLite openers the CLI's production source may call, each
 *  with the only files allowed to: the door, and the three verbs that act on the store file. */
const OPENERS: ReadonlyArray<{ opener: string; allowed: readonly string[] }> = [
  { opener: 'openRealmHome', allowed: ['lib/home.ts'] },
  {
    opener: 'openRealmHomeForMaintenance',
    allowed: ['commands/db-backup.ts', 'commands/db-migrate.ts', 'commands/db-check.ts'],
  },
];

/** The calls of `opener` in the CLI's source: comment lines and the text of strings left out, so an
 *  import (a plain name) or a mention is not a call. */
function openerCalls(opener: string): Site[] {
  const root = join(PACKAGES_DIR, 'cli', 'src');
  const call = new RegExp(`\\b${opener}\\(`);
  const sites: Site[] = [];
  for (const path of sourceFiles('cli')) {
    const file = relative(root, path).split(sep).join('/');
    readFileSync(path, 'utf8')
      .split('\n')
      .forEach((text, i) => {
        const trimmed = text.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
        const code = text.replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, '""');
        if (call.test(code)) sites.push({ file, line: i + 1, text: trimmed });
      });
  }
  return sites;
}

describe("#616 PR-2c c10a-3a — the SQLite openers in the CLI's source", () => {
  it('each opener is called only from its allowed files, and from every one of them', () => {
    const report = OPENERS.map(({ opener, allowed }) => {
      const sites = openerCalls(opener);
      return {
        opener,
        strays: sites
          .filter((s) => !allowed.includes(s.file))
          .map((s) => `cli/src/${s.file}:${s.line}: ${s.text}`),
        uncalled: allowed.filter((f) => !sites.some((s) => s.file === f)),
      };
    });
    // (1) red when another file opens the store itself (the one-door rule), or an allowed file no
    //     longer calls its opener (a stale row, or a pattern that matches nothing); (2) prints each
    //     stray as file:line and its text, and each allowed file with no call.
    expect(report).toEqual(OPENERS.map(({ opener }) => ({ opener, strays: [], uncalled: [] })));
  });
});

describe('#616 PR-2b (A1) — a test opens its stores through the helper; the exceptions are listed', () => {
  for (const [pkg, allowed] of Object.entries(ALLOWED_TESTS)) {
    it(`${pkg}: each listed test file holds exactly its count of constructions`, () => {
      const { files, sites } = testConstructions(pkg);
      // A1-1. (a) red when a listed file gains or loses a construction, or an entry names a file that
      //     is not there; (b) prints the list with each file's actual count (`not found` for a file
      //     the walk did not read).
      const actual = allowed.map((a) => ({
        file: a.file,
        sites: files.includes(a.file)
          ? sites.filter((s) => s.file === a.file).reduce((n, s) => n + constructionsOn(s.text), 0)
          : 'not found',
      }));
      expect(actual).toEqual(allowed.map((a) => ({ file: a.file, sites: a.sites })));
    });

    it(`${pkg}: no other test file constructs a store`, () => {
      const { sites } = testConstructions(pkg);
      const listed = new Set(allowed.map((a) => a.file));
      // A1-2. (a) red when a routed test file builds one of the six classes again (a listed file's
      //     excess is A1-1's); (b) prints each stray as `<pkg>/src/<file>:<line>: <text>`.
      const strays = sites.filter((s) => !listed.has(s.file));
      expect(
        strays.map((s) => `${pkg}/src/${s.file}:${s.line}: ${s.text}`),
        `a test store built outside ${pkg}'s test helper`,
      ).toEqual([]);
    });
  }
});
