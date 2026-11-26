// one-loader-616.test.ts — issue #616 unit 4 (and its correction): `driver.ts` is the ONE place Realm
// loads Node's built-in SQLite, so its version check (the WAL-reset bug) and its warning filter cannot
// be skipped. The real case: a later unit, or a test, or a child-process helper reaches for the built-in
// directly, by an import, a `require`, or `process.getBuiltinModule` with a specifier built at run time.
//
// The scan reads EVERY source file under `packages/*/src` of any script kind (`.ts`, `.mts`, `.cts`,
// `.tsx`, `.js`, `.mjs`, `.cjs`; not declaration files), tests included, as plain text: no comment is
// blanked (blanking once hid real code in five files), so a comment or a test title outside the
// files below that names the module, or the loading function, is a finding too: word it otherwise, or
// add the file here with its reason. Each listed file names the needles it may hold: `code-text.ts`
// (#828 unit 2a) may hold the loading function only, and only in a call whose one argument is the
// literal `'node:events'` or `'node:stream'` (the second assertion); `node:sqlite` stays a finding there.
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
const CODE_TEXT = 'packages/core/src/extensions/code-text.ts';
/** The files that may hold a needle, each with the needles it may hold and its reason. */
const EXEMPT: Record<string, { needles: readonly string[]; reason: string }> = {
  [LOADER]: {
    needles: NEEDLES,
    reason: 'the one loader: it loads the built-in, through getBuiltinModule',
  },
  [SELF]: {
    needles: NEEDLES,
    reason: 'this scan: the needles are written in it, as what it looks for',
  },
  [CODE_TEXT]: {
    needles: ['getBuiltinModule'],
    reason: 'reads node:events and node:stream for the platform set (#828 2a); never SQLite',
  },
};
/** The one shape the loading function takes in `code-text.ts`: a call naming one of two modules. */
const CODE_TEXT_CALL = /^getBuiltinModule(?:\?\.)?\((['"])node:(?:events|stream)\1\)/;
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
    const named = sources.flatMap((s) =>
      NEEDLES.filter(
        (n) => s.text.includes(n) && !(EXEMPT[s.rel]?.needles.includes(n) ?? false),
      ).map((n) => `${s.rel}: ${n}`),
    );
    // The original unit's law, in this package: `import(` and `require(` take a plain string only.
    const computed = sources
      .filter((s) => s.rel.startsWith('packages/store-sqlite/src/') && s.rel !== SELF)
      .filter((s) => /\b(?:import|require)\s*\(\s*(?!['"][^'"`$]*['"]\s*\))/.test(s.text))
      .map((s) => s.rel);
    // (1) red when a file other than the loader loads or names the built-in: a `.mjs` helper that
    //     imports it, a `.ts` file that calls the loading function through an optional call or with
    //     a computed specifier, an import below a comment that once hid it; when a store-sqlite file
    //     imports through a computed specifier; when a file listed for one needle holds the other
    //     (`node:sqlite` in code-text.ts); also when the scan reads nothing (no source file found), or
    //     the loader stops holding both needles (the scan would then look for text no loader writes);
    //     (2) prints each finding as `<path>: <needle>`, whether files were read, and which needles
    //     the loader holds.
    expect({
      readSome: sources.length > 0,
      loaderHolds: NEEDLES.filter((n) => loader.includes(n)),
      named,
      computed,
    }).toEqual({ readSome: true, loaderHolds: NEEDLES, named: [], computed: [] });
  });

  it("code-text.ts holds getBuiltinModule only as a call whose one argument is the literal 'node:events' or 'node:stream'", () => {
    const text = readFileSync(join(ROOT, CODE_TEXT), 'utf8');
    const strays: string[] = [];
    for (
      let at = text.indexOf('getBuiltinModule');
      at !== -1;
      at = text.indexOf('getBuiltinModule', at + 1)
    ) {
      if (CODE_TEXT_CALL.test(text.slice(at))) continue;
      const line = text.slice(0, at).split('\n').length;
      strays.push(`line ${line}: ${text.split('\n')[line - 1]?.trim() ?? ''}`);
    }
    // (1) red when code-text.ts calls the loading function with another module (`'node:sqlite'`),
    //     with a specifier built at run time (a variable, a template), reads it without calling it,
    //     or names it in a comment; red with ENOENT when the file moves (its exemption would then
    //     name no file); (2) prints each stray use's line number and text.
    expect(strays).toEqual([]);
  });
});
