// one-loader-616.test.ts — issue #616 unit 4: `driver.ts` is the ONE place Realm loads Node's built-in
// SQLite, so its version check (the WAL-reset bug) and its warning filter cannot be skipped. The real
// case: a later unit, or a test, reaches for `node:sqlite` directly, or builds an import specifier
// at run time that a reader cannot see. The scan reads every package's TypeScript sources, tests
// included (there is no exemption), with comments blanked; this file is left out, since the needle
// is written in it.
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const THIS_FILE = fileURLToPath(import.meta.url);
const ROOT = join(dirname(THIS_FILE), '..', '..', '..');
const LOADER = 'packages/store-sqlite/src/driver.ts';
const NEEDLE = ['node', 'sqlite'].join(':');

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== 'node_modules' && name !== 'dist') tsFiles(path, out);
    } else if (path.endsWith('.ts') && !path.endsWith('.d.ts')) out.push(path);
  }
  return out;
}

/** The source with comments blanked, so a sentence about the module is not a load of it. */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (_m, lead: string) => lead);
}

describe('#616 unit 4 — one loader of node:sqlite', () => {
  it('no source but driver.ts names the built-in, and no store-sqlite source builds an import specifier at run time', () => {
    const named: string[] = [];
    const computed: string[] = [];
    for (const pkg of readdirSync(join(ROOT, 'packages'))) {
      const src = join(ROOT, 'packages', pkg, 'src');
      try {
        if (!statSync(src).isDirectory()) continue;
      } catch {
        continue;
      }
      for (const file of tsFiles(src)) {
        if (file === THIS_FILE) continue;
        const rel = relative(ROOT, file).split('\\').join('/');
        const text = code(readFileSync(file, 'utf8'));
        if (rel !== LOADER && (text.includes(NEEDLE) || /\bgetBuiltinModule\s*\(/.test(text)))
          named.push(rel);
        // In this package, `import(` and `require(` take a plain string only.
        if (
          pkg === 'store-sqlite' &&
          /\b(?:import|require)\s*\(\s*(?!['"][^'"`$]*['"]\s*\))/.test(text)
        ) {
          computed.push(rel);
        }
      }
    }
    // (1) red when a file other than driver.ts loads or names the built-in (a second `import` of it
    //     in a throwaway file, a `getBuiltinModule` call), or a store-sqlite file imports through a
    //     computed specifier; (2) prints each such file's path.
    expect({ named, computed }).toEqual({ named: [], computed: [] });
  });
});
