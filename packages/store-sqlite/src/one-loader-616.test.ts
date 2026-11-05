// one-loader-616.test.ts — issue #616 unit 4 (and its correction): `driver.ts` is the ONE place Realm
// loads Node's built-in SQLite, so its version check (the WAL-reset bug) and its warning filter cannot
// be skipped. The real case: a later unit, or a test, or a child-process helper reaches for the built-in
// directly, by an import, a `require`, or `process.getBuiltinModule` with a specifier built at run time.
//
// The scan reads EVERY source file under `packages/*/src` of any script kind (`.ts`, `.mts`, `.cts`,
// `.tsx`, `.js`, `.mjs`, `.cjs`; not declaration files), tests included, as plain text: no comment is
// blanked (blanking once hid real code in five files), so a comment or a test title outside the two
// files below that names the module, or the loading function, is a finding too: word it otherwise, or
// add the file here with its reason.
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const THIS_FILE = fileURLToPath(import.meta.url);
const ROOT = join(dirname(THIS_FILE), '..', '..', '..');
const LOADER = 'packages/store-sqlite/src/driver.ts';
const SELF = relative(ROOT, THIS_FILE).split('\\').join('/');
/** The text that loads the built-in: its specifier, and the function that loads a built-in by name. */
const NEEDLES = ['node:sqlite', 'getBuiltinModule'];
/** The files that may hold a needle, each with its reason. */
const EXEMPT: Record<string, string> = {
  [LOADER]: 'the one loader: it loads the built-in, through getBuiltinModule',
  [SELF]: 'this scan: the needles are written in it, as what it looks for',
};
const SCRIPT = /\.(?:ts|mts|cts|tsx|js|mjs|cjs)$/;
const DECLARATION = /\.d\.(?:ts|mts|cts)$/;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== 'node_modules' && name !== 'dist') sourceFiles(path, out);
    } else if (SCRIPT.test(name) && !DECLARATION.test(name)) out.push(path);
  }
  return out;
}

/** Every package's source files, as repository paths with their text. */
function allSources(): Array<{ rel: string; text: string }> {
  const out: Array<{ rel: string; text: string }> = [];
  for (const pkg of readdirSync(join(ROOT, 'packages'))) {
    const src = join(ROOT, 'packages', pkg, 'src');
    try {
      if (!statSync(src).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const file of sourceFiles(src)) {
      out.push({
        rel: relative(ROOT, file).split('\\').join('/'),
        text: readFileSync(file, 'utf8'),
      });
    }
  }
  return out;
}

describe('#616 unit 4 — one loader of the built-in SQLite', () => {
  it('no source file of any script kind but the loader names the built-in or the function that loads it, and no store-sqlite source imports through a specifier built at run time', () => {
    const sources = allSources();
    const loader = sources.find((s) => s.rel === LOADER)?.text ?? '';
    const named = sources
      .filter((s) => !(s.rel in EXEMPT))
      .filter((s) => NEEDLES.some((n) => s.text.includes(n)))
      .map((s) => s.rel);
    // The original unit's law, in this package: `import(` and `require(` take a plain string only.
    const computed = sources
      .filter((s) => s.rel.startsWith('packages/store-sqlite/src/') && s.rel !== SELF)
      .filter((s) => /\b(?:import|require)\s*\(\s*(?!['"][^'"`$]*['"]\s*\))/.test(s.text))
      .map((s) => s.rel);
    // (1) red when a file other than the loader loads or names the built-in: a `.mjs` helper that
    //     imports it, a `.ts` file that calls the loading function through an optional call or with
    //     a computed specifier, an import below a comment that once hid it; when a store-sqlite file
    //     imports through a computed specifier; also when the scan reads nothing (no source file
    //     found), or the loader stops holding both needles (the scan would then look for text no
    //     loader writes); (2) prints each finding's path, whether files were read, and which needles
    //     the loader holds.
    expect({
      readSome: sources.length > 0,
      loaderHolds: NEEDLES.filter((n) => loader.includes(n)),
      named,
      computed,
    }).toEqual({ readSome: true, loaderHolds: NEEDLES, named: [], computed: [] });
  });
});
