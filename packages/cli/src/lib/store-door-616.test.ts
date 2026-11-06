// store-door-616.test.ts — issue #616 PR-2a, unit (iii): the law that every store a host builds comes
// through its one door. A source scan, table-driven by package: each row names the only files of that
// package allowed to construct one of the six store classes. The CLI's row is the door
// (`lib/home.ts`) and the two commands 2c deletes (`run gc`, `run reconcile`), which keep their own
// constructions until then; unit (ii-b) added the MCP package's row. Before this unit the CLI built its
// stores by hand in 60 places in 27 files, so a command could build one of them on a folder its
// other stores do not read (the #188 mixed-wiring class).
//
// #616 PR-2b (A1): a second table, for the package's test files. A test opens its stores through the
// package's test helper (`makeTempHome`), so unit 2c changes the door and the tests follow; the table
// names the few test files that still construct a store, each with its count and its subject.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// packages/cli/src/lib → packages/
const PACKAGES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Package → the files (relative to its src/) allowed to construct a store. The rule for both
 *  packages: the package's opener, and (mcp-server) the test helper whose artifact-stores spread
 *  builds two classes under `src/test-support/`, which the walker reads as non-test source. */
const ALLOWED: Record<string, string[]> = {
  cli: ['lib/home.ts', 'commands/gc.ts', 'commands/reconcile.ts'],
  // #616 PR-2a (ii-b): the `realm-mcp` program's opener and the test helper (unit ii-a); the
  // library and its tools build none.
  'mcp-server': ['home.ts', 'test-support/temp-home.ts'],
};

/** Test files allowed to construct a store, each with how many constructions it holds and its
 *  subject. Every other test file opens its stores through the package's test helper
 *  (`makeTempHome`, #616 PR-2b). The count keeps the list exact: a routed file that constructs again
 *  is a stray, a listed file that grows one is red. 2c deletes gc's rows with the command; PR-3 the
 *  rest with the classes. The mcp-server row is b3's. */
const ALLOWED_TESTS: Record<string, Array<{ file: string; sites: number; subject: string }>> = {
  cli: [
    {
      file: 'commands/gc-heal-composition.test.ts',
      sites: 1,
      subject: "gc's heal composition on the default path; deleted with `run gc` in 2c",
    },
    {
      file: 'commands/gc.test.ts',
      sites: 47,
      subject: '`realm run gc`, deleted in 2c (design §1.2)',
    },
    {
      file: 'commands/lazy-home-resolution-285.test.ts',
      sites: 1,
      subject:
        "`JsonFileReplayStore` resolves its default folder at construction (#285): the JSON class's own behaviour; PR-3",
    },
    {
      file: 'commands/purge.test.ts',
      sites: 1,
      subject:
        "one cell: the fence judged against the trace buffer's OWN reader, an anchor stub (the door wires the run store as reader)",
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
      file: 'store-contracts/run-store-fidelity.contract.test.ts',
      sites: 2,
      subject: 'field fidelity and claim ownership of `JsonFileStore`; PR-3',
    },
    {
      file: 'store-contracts/store-clock.contract.test.ts',
      sites: 1,
      subject: 'the store-clock contract on `JsonFileStore` through a test location; PR-3',
    },
    {
      file: 'store/replay-store.test.ts',
      sites: 1,
      subject: "`JsonFileReplayStore`'s own test; PR-3",
    },
  ],
};

/** A construction of one of the six store classes; the failed-attempt class under both its names
 *  (PR-1b renamed `FailedAttemptStore` to `JsonFileFailedAttemptStore`). */
const CONSTRUCTION =
  /\bnew\s+(JsonFileStore|JsonWorkflowStore|FailedAttemptStore|JsonFileFailedAttemptStore|JsonFileReplayStore|FileDedupStore|JsonTraceBufferStore)\s*\(/;

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
 *  line must turn it red (`gc.test.ts` builds two stores on one line in places); the source table is
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
    it(`${pkg}: no file but ${allowed.join(', ')} constructs a store`, () => {
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
