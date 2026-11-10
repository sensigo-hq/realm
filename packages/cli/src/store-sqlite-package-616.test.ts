// store-sqlite-package-616.test.ts — issue #616 PR-1a unit 1: the package `@sensigo/realm-store-sqlite`
// (`packages/store-sqlite`) exists, and the repo's checks that watch every package already see it.
//
// HOME: the cli package, as the source censuses (`commands/clock-census-715b.test.ts`): cli's test
// task waits for every package's build, so an edit in any package re-hashes it.
//
// WHAT IT CANNOT SEE: a list of packages written after this file (it checks the lists named below);
// whether CI would refuse a run with a build missing from the test task (that needs a fresh runner).
//
// Each assertion carries the two questions of `~/.claude/TESTING-RULES.md` rule 8 next to it.
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const PACKAGES = join(ROOT, 'packages');

/** Every `packages/*` folder that has a `src` folder, sorted. */
function packagesWithSource(): string[] {
  return readdirSync(PACKAGES, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(PACKAGES, e.name, 'src')))
    .map((e) => e.name)
    .sort();
}

/** One list of packages in a repo file. */
interface PackageList {
  readonly file: string;
  /** Matches the list (global); group 1 is its text. */
  readonly list: RegExp;
  /** How many times the list occurs in the file. */
  readonly count: number;
  /** A package in the list's text (global, group 1). Default: a quoted folder, `'core'` or `'core/src'`. */
  readonly name?: RegExp;
  /** The packages the list leaves out, each with its reason. */
  readonly leavesOut?: Readonly<Record<string, string>>;
}

const QUOTED = /'([a-z][a-z-]*)(?:\/src)?'/g;
const WORD = /([a-z][a-z-]*)/g;

/** The lists of packages the repo's checks keep by hand (the query of #616 unit 1). */
const LISTS: readonly PackageList[] = [
  // The scans that watch every package's source for a law: widened to the new package.
  {
    file: 'packages/cli/src/commands/clock-census-715b.test.ts',
    list: /const SCANNED = \[([^\]]*)\]/g,
    count: 1,
  },
  {
    file: 'packages/cli/src/commands/lint-test-location-715.test.ts',
    list: /const PACKAGES = \[([^\]]*)\] as const/g,
    count: 1,
  },
  {
    file: 'packages/cli/src/commands/purge-guard.test.ts',
    list: /const SCANNED_PACKAGES = \[([^\]]*)\]/g,
    count: 1,
  },
  {
    file: 'packages/cli/src/commands/store-fs-guard.test.ts',
    list: /const packages = \[([^\]]*)\]/g,
    count: 2,
  },
  {
    file: 'packages/cli/src/commands/terminal-writer-census.test.ts',
    list: /const SCANNED_PACKAGES = \[([^\]]*)\]/g,
    count: 1,
  },
  {
    file: 'packages/cli/src/spawn-budget-guard.test.ts',
    list: /const PACKAGES = \[([^\]]*)\]/g,
    count: 1,
  },
  {
    file: 'packages/cli/src/commands/test-time-715b.test.ts',
    list: /for \(const pkg of \[([^\]]*)\]\)/g,
    count: 1,
  },
  {
    file: 'packages/cli/src/release-line-witness.test.ts',
    list: /for \(const pkg of \[([^\]]*)\]\) \{/g,
    count: 2,
  },
  {
    file: 'packages/cli/src/commands/list.test.ts',
    list: /const SCANNED_PACKAGES = \[([^\]]*)\]/g,
    count: 1,
  },
  {
    file: 'packages/core/src/engine/holder-audit.test.ts',
    list: /const FILES = \[([^\]]*)\]\.flatMap/g,
    count: 1,
  },
  {
    file: 'packages/core/src/engine/instants.test.ts',
    list: /const files = (sourceFiles\(join\(root, '[a-z-]+', 'src'\)\)(?:\s*\.concat\(sourceFiles\(join\(root, '[a-z-]+', 'src'\)\)\))*)/g,
    count: 1,
    name: /join\(root, '([a-z-]+)', 'src'\)/g,
  },
  {
    file: 'packages/core/src/engine/question-view.test.ts',
    list: /const callers = \[([^\]]*)\]\.flatMap/g,
    count: 1,
  },
  {
    file: 'packages/core/src/engine/snapshot.test.ts',
    list: /const files = \[([^\]]*)\]\.flatMap/g,
    count: 1,
  },
  {
    file: 'packages/core/src/engine/pending-625.test.ts',
    list: /for \(const pkg of \[([^\]]*)\]\)\s*walk\(pkg\);/g,
    count: 1,
  },
  {
    file: 'packages/core/src/engine/cannot-run-summary-872.test.ts',
    list: /for \(const pkg of \[([^\]]*)\]\)\s*walk\(pkg\);/g,
    count: 1,
  },
  {
    file: 'packages/core/src/brand.test.ts',
    list: /it\.each\(\[([^\]]*)\]\)\(/g,
    count: 1,
    leavesOut: {
      core: 'its own brand.ts is checked by the cell before this one (it imports only ./version.js)',
    },
  },
  // Lists that leave the new package out, each with its reason.
  {
    file: 'packages/cli/src/commands/capability-warn-enumeration.test.ts',
    list: /const SCANNED_PACKAGES = \[([^\]]*)\]/g,
    count: 1,
    leavesOut: {
      core: 'the engine: the scan partitions the run-creating call sites of the runner packages',
      'store-sqlite': 'a store, not a runner: it creates no run of its own',
    },
  },
  {
    file: '.github/workflows/publish.yml',
    list: /for p in ([a-z -]+); do/g,
    count: 1,
    name: WORD,
  },
  // scripts/test/pin-deps.test.mjs keeps no list by hand since c13a: PD1 reads the published set from the tree.
  {
    file: 'packages/cli/src/multi-copy/layout.ts',
    list: /const PACKAGES: Record<PackageKey, \{ dir: string; name: string \}> = \{([\s\S]*?)\n\};/g,
    count: 1,
    name: /dir: '([a-z-]+)'/g,
  },
  {
    file: 'packages/cli/src/multi-copy/multi-copy.test.ts',
    list: /packages\/\(((?:[a-z-]+\|)+[a-z-]+)\)\/\(dist\|src\)\//g,
    count: 1,
    name: WORD,
  },
];

describe('#616 unit 1: the SQLite store package', () => {
  it('every list of packages the checks keep by hand holds every package with a src folder, or names it as left out with a reason', () => {
    const packages = packagesWithSource();
    const problems: unknown[] = [];
    for (const l of LISTS) {
      const found = [...readFileSync(join(ROOT, l.file), 'utf8').matchAll(l.list)];
      if (found.length !== l.count) {
        problems.push({ file: l.file, occurrences: found.length, expected: l.count });
        continue;
      }
      found.forEach((m, i) => {
        const names = [...m[1]!.matchAll(l.name ?? QUOTED)].map((n) => n[1]!);
        const expected = packages.filter((p) => !(p in (l.leavesOut ?? {})));
        const missing = expected.filter((p) => !names.includes(p));
        const unexpected = names.filter((n) => !expected.includes(n));
        if (missing.length > 0 || unexpected.length > 0) {
          problems.push({ file: l.file, occurrence: i + 1, missing, unexpected });
        }
      });
    }
    // (1) Can it fail: red when one list loses a package (the named break: remove 'store-sqlite'
    //     from `SCANNED` in clock-census-715b.test.ts), names one that is left out or does not exist,
    //     or is renamed so its pattern no longer finds it the expected number of times.
    // (2) Prints: per list, the file, which occurrence, the packages missing and the unexpected ones
    //     (folder names only).
    expect({ packages, problems }).toEqual({
      packages: ['cli', 'core', 'mcp-server', 'store-sqlite', 'testing'],
      problems: [],
    });
  });

  it('the test task waits for the build of every workspace package that builds', () => {
    const turbo = JSON.parse(readFileSync(join(ROOT, 'turbo.json'), 'utf8')) as {
      tasks: { test: { dependsOn: string[] } };
    };
    const builds = readdirSync(PACKAGES)
      .filter((d) => existsSync(join(PACKAGES, d, 'package.json')))
      .map(
        (d) =>
          JSON.parse(readFileSync(join(PACKAGES, d, 'package.json'), 'utf8')) as {
            name: string;
            scripts?: Record<string, string>;
          },
      )
      .filter((p) => p.scripts?.['build'] !== undefined)
      .map((p) => `${p.name}#build`)
      .sort();
    const dependsOn = [...turbo.tasks.test.dependsOn].sort();
    // (1) Can it fail: red when a package's build is missing from `test.dependsOn` (the named
    //     break: remove "@sensigo/realm-store-sqlite#build" from turbo.json): a fresh runner would
    //     then start the tests before that build, and the build-is-current check refuses every run
    //     (INFERRED: a fresh runner cannot be reproduced on this machine).
    // (2) Prints: the builds missing from `test.dependsOn` and the entries naming no workspace build.
    expect({
      missing: builds.filter((b) => !dependsOn.includes(b)),
      unexpected: dependsOn.filter((d) => !builds.includes(d)),
    }).toEqual({ missing: [], unexpected: [] });
  });

  it(
    "the pack ships the built entry and, of the test support, exactly the ./test-support subpath's twelve files (c9a, c10b-2b); none of the tests or the build info",
    { timeout: 60_000 },
    () => {
      const pkg = join(PACKAGES, 'store-sqlite');
      const dir = mkdtempSync(join(tmpdir(), 'realm-616-pack-'));
      try {
        cpSync(join(pkg, 'package.json'), join(dir, 'package.json'));
        cpSync(join(pkg, 'README.md'), join(dir, 'README.md'));
        cpSync(join(pkg, 'dist'), join(dir, 'dist'), { recursive: true });
        // `dist/test-support/` already holds the package's real test support (the ./test-support
        // entry, its two helpers and the modules that stay unpublished); a probe beside them, where a later
        // unit's module would sit, and a test source and a test where later units put them.
        mkdirSync(join(dir, 'dist', 'test-support'), { recursive: true });
        writeFileSync(join(dir, 'dist', 'test-support', 'probe.js'), 'export {};\n');
        mkdirSync(join(dir, 'src', 'test-support'), { recursive: true });
        writeFileSync(join(dir, 'src', 'test-support', 'probe.ts'), 'export {};\n');
        writeFileSync(join(dir, 'src', 'probe.test.ts'), 'export {};\n');
        const r = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
          cwd: dir,
          encoding: 'utf8',
          timeout: 30_000,
          env: { ...process.env, npm_config_update_notifier: 'false' },
        });
        const files =
          r.status === 0
            ? (JSON.parse(r.stdout) as [{ files: { path: string }[] }])[0].files.map((f) => f.path)
            : [];
        // (1) Can it fail: red when `files` in packages/store-sqlite/package.json drops the
        //     ./test-support subpath's re-include (its twelve files missing; #616 PR-2c c9a, c10b-2b), widens it
        //     or drops "!dist/**/test-support/**" (the probe, or the unpublished modules, then ship),
        //     ships the build info or the source, or stops shipping `dist` (then `dist/index.js` is
        //     absent); red too when npm fails. (2) Prints: npm's exit status, the test-support paths it
        //     would pack, and the paths that should not ship (file names only; npm's output holds no
        //     secret).
        expect({
          status: r.status,
          index: files.includes('dist/index.js'),
          testSupport: files.filter((f) => f.includes('test-support')).sort(),
          tests: files.filter((f) => /\.test\./.test(f)),
          buildInfo: files.filter((f) => f.endsWith('.tsbuildinfo')),
          source: files.filter((f) => f.startsWith('src/')),
        }).toEqual({
          status: 0,
          index: true,
          testSupport: [
            'dist/test-support/foreign-connection.d.ts',
            'dist/test-support/foreign-connection.d.ts.map',
            'dist/test-support/foreign-connection.js',
            'dist/test-support/foreign-connection.js.map',
            'dist/test-support/index.d.ts',
            'dist/test-support/index.d.ts.map',
            'dist/test-support/index.js',
            'dist/test-support/index.js.map',
            'dist/test-support/plant-registry-row.d.ts',
            'dist/test-support/plant-registry-row.d.ts.map',
            'dist/test-support/plant-registry-row.js',
            'dist/test-support/plant-registry-row.js.map',
          ],
          tests: [],
          buildInfo: [],
          source: [],
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
