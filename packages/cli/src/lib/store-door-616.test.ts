// store-door-616.test.ts — issue #616 PR-2a, unit (iii): the law that every store a host builds comes
// through its one door. A source scan, table-driven by package: each row names the only files of that
// package allowed to construct one of the six store classes. The CLI's row is the door
// (`lib/home.ts`) and the two commands 2c deletes (`run gc`, `run reconcile`), which keep their own
// constructions until then; unit (ii-b) added the MCP package's row. Before this unit the CLI built its
// stores by hand in 60 places in 27 files, so a command could build one of them on a folder its
// other stores do not read (the #188 mixed-wiring class).
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

/** Whether one source line constructs a store. Comment lines are skipped by the caller; string and
 *  template text on the line is left out first, so a refusal that tells a caller how to build the
 *  stores (`new JsonFileStore()` in a message, #616 PR-2a (ii-b)) is not a construction. */
function isConstruction(line: string): boolean {
  const code = line.replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, '""');
  return CONSTRUCTION.test(code);
}

interface Site {
  file: string;
  line: number;
  text: string;
}

/** The constructions in a package's source, comment lines left out. */
function constructions(pkg: string): { files: string[]; sites: Site[] } {
  const root = join(PACKAGES_DIR, pkg, 'src');
  const files = sourceFiles(pkg).map((f) => relative(root, f).split(sep).join('/'));
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
