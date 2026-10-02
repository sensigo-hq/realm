#!/usr/bin/env node
// scripts/check-brands.mjs — issue #620 PR-B. Every class a realm package exports carries the
// release mark `brandClass` (packages/core/src/brand.ts) installs, so that copies of one release
// recognise each other's objects. A class added without the mark would silently go back to
// `instanceof` being false across copies; this check turns that into a red CI run.
//
// It imports the BUILT entries of every package in the release set (private ones included) and
// looks at what they export — so it runs after `npm run build`, and never passes because it found
// nothing to import.
//
// Usage: node scripts/check-brands.mjs [--root <dir>]
//
// Zero dependencies of its own: it reads the packages' own `package.json` files with the release
// set's reader and imports their built files with plain Node.

import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readReleaseSet } from './lib/release-set.mjs';

/** The key every realm class carries its mark under as well; set by `brandClass`. */
const RELEASE_LINE_KEY = Symbol.for('@sensigo/realm/release-line');
/** The tag `brandClass` puts on the instance check it installs. */
const BRAND_CHECK_TAG = Symbol.for('@sensigo/realm/brand-check');

const args = process.argv.slice(2);
const usage = 'usage: node scripts/check-brands.mjs [--root <dir>]';
let root = join(dirname(fileURLToPath(import.meta.url)), '..');
if (args.length === 2 && args[0] === '--root') {
  root = resolve(args[1]);
} else if (args.length > 0) {
  console.error(usage);
  process.exit(2);
}

/** A condition value resolved to the file it names for `import`: a string, or `import`/`default`. */
function importTarget(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = importTarget(item);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (value !== null && typeof value === 'object') {
    if ('import' in value) return importTarget(value.import);
    if ('default' in value) return importTarget(value.default);
  }
  return undefined; // a types-only entry has nothing to import
}

/**
 * The entries of one package: `{ key, target, file }`, each an import target of `exports` (or
 * `main` when there is no `exports`), minus any target that is also a `bin` target of the package.
 * A target with `*` is expanded by listing its folder.
 */
function entriesOf(member) {
  const { pkg } = member;
  const packageDir = join(root, member.dir);
  const raw = [];
  if (pkg.exports !== undefined) {
    const exportsValue = pkg.exports;
    const isSubpathMap =
      exportsValue !== null &&
      typeof exportsValue === 'object' &&
      !Array.isArray(exportsValue) &&
      Object.keys(exportsValue).every((k) => k.startsWith('.'));
    const pairs = isSubpathMap ? Object.entries(exportsValue) : [['.', exportsValue]];
    for (const [key, value] of pairs) {
      const target = importTarget(value);
      if (target !== undefined) raw.push({ key, target });
    }
  } else if (pkg.main !== undefined) {
    raw.push({ key: 'main', target: pkg.main });
  }

  // realm-cli's `.` entry IS its bin: importing it runs the program (`program.parse()`), so it is
  // not an entry this check can import.
  const bins =
    typeof pkg.bin === 'string' ? [pkg.bin] : Object.values(pkg.bin ?? {}).filter(Boolean);
  const binFiles = new Set(bins.map((b) => resolve(packageDir, b)));

  const entries = [];
  for (const { key, target } of raw) {
    if (!target.includes('*')) {
      const file = resolve(packageDir, target);
      if (!binFiles.has(file)) entries.push({ key, target, file });
      continue;
    }
    const star = target.indexOf('*');
    const before = target.slice(0, star);
    const after = target.slice(star + 1);
    const slash = before.lastIndexOf('/');
    const folder = resolve(packageDir, slash === -1 ? '.' : before.slice(0, slash));
    const prefix = before.slice(slash + 1);
    if (after.includes('/') || !existsSync(folder)) {
      // A wildcard whose folder is not there: the build has not run. Report it as a missing entry.
      entries.push({ key, target, file: folder, missing: true });
      continue;
    }
    for (const name of readdirSync(folder).sort()) {
      if (!name.startsWith(prefix) || !name.endsWith(after) || name.endsWith('.d.ts')) continue;
      const file = join(folder, name);
      if (!binFiles.has(file)) {
        entries.push({
          key: key.replaceAll('*', name.slice(prefix.length, name.length - after.length)),
          target,
          file,
        });
      }
    }
  }
  return entries;
}

const isClass = (value) =>
  typeof value === 'function' && /^class[\s{]/.test(Function.prototype.toString.call(value));

const keyText = (symbol) => (typeof symbol === 'symbol' ? symbol.toString() : String(symbol));
const stringOf = (value) => (typeof value === 'symbol' ? value.toString() : String(value));

/** The first thing wrong with one class's mark, in the order the mark is built; undefined if none. */
function problemWith(Class, member) {
  const expectedKey = Symbol.for(`${member.name}/${Class.name}`);
  const call = `brandClass(${Class.name}, Symbol.for('${member.name}/${Class.name}'), <the package's brand>);`;

  const own = Object.getOwnPropertyDescriptor(Class, Symbol.hasInstance);
  if (own === undefined) {
    return `carries no release mark — add the call ${call} directly after the class body`;
  }
  const check = own.value;
  const tag = typeof check === 'function' ? check[BRAND_CHECK_TAG] : undefined;
  if (typeof tag !== 'symbol') {
    return (
      'has an instance check of its own that is not the release mark — the check must come from ' +
      `the brandClass call (${call}), and a class is marked by that one call only`
    );
  }
  if (tag !== expectedKey) {
    return `is marked under the key ${keyText(tag)}; it must be marked under ${keyText(expectedKey)}`;
  }

  const proto = Class.prototype;
  if (!Object.prototype.hasOwnProperty.call(proto, tag)) {
    return `has no mark on its prototype under ${keyText(tag)}`;
  }
  const mark = proto[tag];
  if (mark === null || typeof mark !== 'object') {
    return `has a mark under ${keyText(tag)} that is not an object (${stringOf(mark)})`;
  }
  if (mark.package !== member.name) {
    return `has a mark naming the package '${stringOf(mark.package)}'; it must name '${member.name}'`;
  }
  if (mark.generation !== member.version) {
    return (
      `has a mark with the generation '${stringOf(mark.generation)}'; the package is at version ` +
      `'${member.version}'`
    );
  }
  if (!Object.prototype.hasOwnProperty.call(proto, RELEASE_LINE_KEY)) {
    return `has no mark on its prototype under the release-line key ${keyText(RELEASE_LINE_KEY)}`;
  }
  if (proto[RELEASE_LINE_KEY] !== mark) {
    return (
      `has a different object under the release-line key ${keyText(RELEASE_LINE_KEY)} than under ` +
      keyText(tag)
    );
  }
  return undefined;
}

async function main() {
  const set = readReleaseSet(root);
  const problems = [];
  const seen = new Set(); // class objects, so a class exported from two entries counts once

  for (const member of set) {
    for (const entry of entriesOf(member)) {
      const where = `${member.name}: entry ${entry.key}`;
      if (entry.missing || !existsSync(entry.file)) {
        problems.push(
          `${where}: ${entry.file.slice(root.length + 1)} does not exist — run \`npm run build\` first`,
        );
        continue;
      }
      let mod;
      try {
        mod = await import(pathToFileURL(entry.file).href);
      } catch (err) {
        problems.push(
          `${where}: importing the entry failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      for (const value of Object.values(mod)) {
        if (!isClass(value) || seen.has(value)) continue;
        seen.add(value);
        const problem = problemWith(value, member);
        if (problem !== undefined) problems.push(`${where}: class ${value.name} ${problem}`);
      }
    }
  }

  if (problems.length === 0 && seen.size === 0) {
    problems.push(
      `found no exported class in ${set.length} package${set.length === 1 ? '' : 's'} — nothing was checked; run \`npm run build\` first`,
    );
  }
  if (problems.length > 0) {
    for (const line of problems) console.error(line);
    process.exit(1);
  }

  const classes = seen.size === 1 ? '1 exported class' : `${seen.size} exported classes`;
  const packages = set.length === 1 ? '1 package' : `${set.length} packages`;
  const tail = seen.size === 1 ? "carries its package's" : "carry their package's";
  console.log(`check-brands: ${classes} in ${packages} ${tail} release mark.`);
}

try {
  await main();
} catch (err) {
  console.error(`check-brands: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
