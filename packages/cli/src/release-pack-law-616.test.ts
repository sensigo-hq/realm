// release-pack-law-616.test.ts — #616 PR-2c c13b, law (A), the pack law: every package the release
// publishes packs what its manifest promises, and no test support beyond the store's own entry.
//
// WHAT IT JUDGES. Every folder under `packages/` whose `package.json` has `private` other than `true`
// (the four older manifests say `false`; the store's says nothing). The judged set must be exactly
// today's five: a sixth published package turns the cell red, so this list is revisited on purpose.
// The packer itself answers what the tarball holds: `npm pack --dry-run --json --offline` in the
// package's folder, on the built tree (cli's test task waits for every package's build, and the root
// vitest config refuses a stale `dist/`). No network; the repository's `.npmrc` sets
// `ignore-scripts=true`, so no lifecycle script runs, as at the publish (which passes `--ignore-scripts`).
// In the tarball, per package: the file each `exports` entry resolves to under every condition (a
// subpath pattern such as `./dist/tools/*.js`: at least one packed file matching it); every `bin`
// target; `main`; `types`; `README.md`. Not in it: any file under a `test-support` folder, except the
// store package's three re-included basenames (its `./test-support` entry, c10b-2b; the positive pin is
// the store's `test-support-export-616` cell, so this law carries only the negative, across all five).
//
// HOME: the cli package, as `store-sqlite-package-616.test.ts`: cli's test task waits for every
// package's build. (`scripts/test/` runs before the build in CI, so it cannot be the home.)
//
// WHAT IT CANNOT SEE: whether the packed files work once installed (the store's own cells, c10b-3b's
// packaging laws); a file no manifest field promises; what the registry already holds (`--offline`).
//
// Each assertion carries the two questions of `~/.claude/TESTING-RULES.md` rule 8 next to it.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PACKAGES = fileURLToPath(new URL('../../', import.meta.url));

/** The packer. A5's break points it at a binary that does not exist, to show the red it prints. */
const NPM = 'npm';
const PACK = ['pack', '--dry-run', '--json', '--offline'];

/** What the release publishes today (sorted). */
const PUBLISHED = [
  '@sensigo/realm',
  '@sensigo/realm-cli',
  '@sensigo/realm-mcp',
  '@sensigo/realm-store-sqlite',
  '@sensigo/realm-testing',
];

/** The store package's deliberate test support: its `files` list re-includes these three basenames. */
const STORE = '@sensigo/realm-store-sqlite';
const STORE_TEST_SUPPORT = /^dist\/test-support\/(index|foreign-connection|plant-registry-row)\./;

interface Manifest {
  readonly name: string;
  readonly private?: unknown;
  readonly main?: string;
  readonly types?: string;
  readonly bin?: string | Readonly<Record<string, string>>;
  readonly exports?: unknown;
}

/** A path the manifest promises, with what promises it. */
interface Promised {
  readonly what: string;
  readonly target: string;
  /** Only an `exports` target must sit under `dist/`. */
  readonly isExport: boolean;
}

const strip = (p: string): string => p.replace(/^\.\//, '');

/** Every target of an `exports` value, with its subpath and condition, at any depth. */
function exportTargets(value: unknown, where: string, out: Promised[]): void {
  if (typeof value === 'string') {
    out.push({ what: `exports ${where}`, target: strip(value), isExport: true });
  } else if (Array.isArray(value)) {
    for (const v of value) exportTargets(v, where, out);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, v] of Object.entries(value)) {
      exportTargets(v, key.startsWith('.') ? `"${key}"` : `${where} (${key})`, out);
    }
  }
}

function promises(m: Manifest): Promised[] {
  const out: Promised[] = [];
  exportTargets(m.exports, '"."', out);
  const bin = typeof m.bin === 'string' ? { [m.name]: m.bin } : (m.bin ?? {});
  for (const [name, target] of Object.entries(bin)) {
    out.push({ what: `bin ${name}`, target: strip(target), isExport: false });
  }
  if (m.main !== undefined) out.push({ what: 'main', target: strip(m.main), isExport: false });
  if (m.types !== undefined) out.push({ what: 'types', target: strip(m.types), isExport: false });
  out.push({ what: 'the README', target: 'README.md', isExport: false });
  return out;
}

/** A subpath pattern's `*` matches any string, as Node resolves it. */
function patternMatches(pattern: string, packed: readonly string[]): number {
  const re = new RegExp(
    `^${pattern
      .split('*')
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.+')}$`,
  );
  return packed.filter((p) => re.test(p)).length;
}

describe('#616 c13b (A): the pack law', () => {
  it(
    'every published package packs its entries, its program and its README, and no test support but the store entry',
    { timeout: 150_000 },
    () => {
      const judged: string[] = [];
      const notJudged: string[] = [];
      const problems: string[] = [];
      const counts: string[] = [];
      const seen: Record<string, string> = {};
      const started = performance.now();
      for (const dir of readdirSync(PACKAGES).sort()) {
        const file = join(PACKAGES, dir, 'package.json');
        if (!existsSync(file)) continue;
        const m = JSON.parse(readFileSync(file, 'utf8')) as Manifest;
        if (m.private === true) {
          notJudged.push(
            `${m.name} (packages/${dir}): private: true, so the release does not publish it`,
          );
          continue;
        }
        judged.push(m.name);
        const r = spawnSync(NPM, PACK, {
          cwd: join(PACKAGES, dir),
          encoding: 'utf8',
          timeout: 25_000,
          maxBuffer: 64 * 1024 * 1024,
        });
        let answer: { name?: string; files?: { path: string }[] }[] | undefined;
        try {
          answer = r.status === 0 ? JSON.parse(r.stdout) : undefined;
        } catch {
          answer = undefined;
        }
        if (answer?.[0]?.files === undefined) {
          const why =
            r.error !== undefined
              ? String((r.error as NodeJS.ErrnoException).code ?? r.error.message)
              : r.status === 0
                ? 'exit 0, but no file list on its output'
                : `exit ${r.status}: ${(r.stderr ?? '').trim().split('\n')[0] ?? ''}`;
          problems.push(
            `${m.name}: npm could not pack packages/${dir} (${why}). The pack law asks the packer itself and never skips: run it where npm runs.`,
          );
          continue;
        }
        if (answer[0].name !== m.name) {
          problems.push(
            `${m.name}: the packer answered for ${String(answer[0].name)}, not this package`,
          );
        }
        const packed = answer[0].files.map((f) => f.path);
        counts.push(`${m.name} ${packed.length}`);
        for (const p of promises(m)) {
          if (p.isExport && !p.target.startsWith('dist/')) {
            problems.push(
              `${m.name}: ${p.what} → ${p.target} is not under dist/, so it cannot be packed`,
            );
          } else if (p.target.includes('*')) {
            const n = patternMatches(p.target, packed);
            if (n === 0) problems.push(`${m.name}: ${p.what} → ${p.target} matches no packed file`);
            if (m.name === '@sensigo/realm-mcp' && p.target === 'dist/tools/*.js')
              seen['mcp tools'] = n > 0 ? 'matched' : 'none';
          } else if (!packed.includes(p.target)) {
            problems.push(
              `${m.name}: ${p.what} → ${p.target} is not in the tarball (the files list leaves it out)`,
            );
          } else if (m.name === STORE && p.what === 'exports "./test-support" (import)') {
            seen['store test-support'] = p.target;
          } else if (m.name === '@sensigo/realm-cli' && p.what === 'bin realm') {
            seen['cli bin realm'] = p.target;
          }
        }
        for (const p of packed) {
          if (!p.split('/').includes('test-support')) continue;
          if (m.name === STORE && STORE_TEST_SUPPORT.test(p)) continue;
          problems.push(`${m.name}: packs ${p}, test support no published entry asks for`);
        }
      }
      const seconds = ((performance.now() - started) / 1000).toFixed(2);
      console.log(
        `pack law: ${judged.length} packages, dry runs ${seconds} s; packed files: ${counts.join(', ')}`,
      );
      // (1) Can it fail: red when a published package's files list leaves an entry out (A2: the store
      //     loses `dist/test-support/index.*`), when a package gains or loses `private: true` (A3),
      //     when a test-support file is packed outside the store's entry (A4: core re-includes
      //     `dist/test-support/extra.*`), when npm cannot run (A5), and when a seeing-proof is not
      //     seen (the store's entry, the mcp tools pattern, the cli program).
      // (2) Prints: the judged and not-judged names, one sentence per problem (package, field, path),
      //     and the three seeing-proofs; on a pass, the packed-file count of each package and the time.
      expect({ judged: judged.sort(), notJudged, problems, seen }).toEqual({
        judged: PUBLISHED,
        notJudged: [],
        problems: [],
        seen: {
          'store test-support': 'dist/test-support/index.js',
          'mcp tools': 'matched',
          'cli bin realm': 'dist/index.js',
        },
      });
    },
  );
});
