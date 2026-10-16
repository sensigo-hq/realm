#!/usr/bin/env node
// issue #729 PR-0 (A8; PR0-CONTRACT §4, D2 D-1) — the cast check for `Narrowed`.
//
// A door renders only what `narrowForDoor` (packages/core/src/engine/ways.ts) gave it: the ways it
// serves, each with its parties (`for`), and everything it removed, with why (the conservation law).
// `for` is minted in ONE place. A `Narrowed` built anywhere else — a cast (`as Narrowed`,
// `<Narrowed>`) or a literal annotated with the type — would mint parties outside that law, and
// the type system would never notice. This script finds every such construction in the packages'
// TypeScript sources and fails when one exists.
//
// What it reads: every `.ts` file under `packages/*/src` (tests included — a test that fakes a
// `Narrowed` would pin a shape the law never produces), comments stripped first so a sentence
// about a cast is not a cast. What it prints: the file and line of each construction, never the
// line's text. Exit 0: none; exit 1: one or more; exit 2: the root has no packages to read.
//
// `--root <dir>` points it at another tree (its own test's fixtures).

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DEFAULT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The three ways to build a `Narrowed` without `narrowForDoor`. */
const CONSTRUCTIONS = [
  /\bas\s+Narrowed\b/,
  /<\s*Narrowed\s*>/,
  /:\s*Narrowed\s*=\s*\{/,
  /\bsatisfies\s+Narrowed\b/,
];

function parseArgs(argv) {
  const args = { root: ROOT_DEFAULT };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') args.root = argv[++i];
  }
  return args;
}

/** Every `.ts` file under `dir`, skipping build output and dependencies. */
function tsFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...tsFiles(path));
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) out.push(path);
  }
  return out;
}

/** The source with comments blanked (line numbers kept): `//` to the line's end, block comments. */
function withoutComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, (_m, lead) => lead);
}

function main() {
  const { root } = parseArgs(process.argv.slice(2));
  const packagesDir = join(root, 'packages');
  if (!existsSync(packagesDir)) {
    console.error(`check-narrowed: no packages folder under ${root}`);
    process.exit(2);
  }
  const found = [];
  let read = 0;
  for (const pkg of readdirSync(packagesDir)) {
    const src = join(packagesDir, pkg, 'src');
    if (!existsSync(src)) continue;
    for (const file of tsFiles(src)) {
      read += 1;
      const lines = withoutComments(readFileSync(file, 'utf8')).split('\n');
      lines.forEach((line, i) => {
        if (CONSTRUCTIONS.some((pattern) => pattern.test(line))) {
          found.push(`${relative(root, file)}:${i + 1}`);
        }
      });
    }
  }
  if (found.length > 0) {
    console.error(
      `check-narrowed: ${found.length} Narrowed built outside narrowForDoor (read ${read} files):`,
    );
    for (const where of found) console.error(`  ${where}`);
    process.exit(1);
  }
  console.log(`check-narrowed: no Narrowed built outside narrowForDoor (read ${read} files).`);
}

main();
