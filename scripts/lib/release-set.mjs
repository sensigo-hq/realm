// scripts/lib/release-set.mjs — issue #620 PR-A (D2). The release set, derived once from
// `packages/*` on disk, instead of the four hand-kept package lists this module replaces
// (release.mjs's PACKAGES/SOURCE_VERSIONS, check-versions.mjs's CHECKS, pin-deps.mjs's
// INTERNAL_DEPS). A package that misses one of those lists was silently not bumped, not checked
// or not pinned; deriving the set removes the list.
//
// Zero dependencies: `scripts/pin-deps.mjs` runs from the publish job with plain Node, before
// `npm ci`, so nothing here may import outside `node:*`.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `<root>/packages/<dir>/package.json`, parsed. A file that is not JSON is named: without the name,
 * the parser's own message ("Unexpected end of JSON input") says nothing about which of the
 * workspace's files it came from.
 */
function readPackageJson(pkgPath, dir) {
  try {
    return JSON.parse(readFileSync(pkgPath, 'utf-8'));
  } catch (e) {
    throw new Error(`packages/${dir}/package.json is not valid JSON (${e.message})`, { cause: e });
  }
}

/**
 * The `name` of every `<root>/packages/*` directory that has a `package.json`, in the release
 * set or not. These are the "workspace packages" — a superset of the release set, since a
 * private package with neither `exports` nor `main` (issue #616's `engine-tests`) is still a
 * workspace package, just not a published or publishable one.
 */
export function readWorkspaceNames(root) {
  const packagesDir = join(root, 'packages');
  const dirs = readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const names = [];
  for (const dir of dirs) {
    const pkgPath = join(packagesDir, dir, 'package.json');
    if (!existsSync(pkgPath)) continue;
    const pkg = readPackageJson(pkgPath, dir);
    names.push(pkg.name);
  }
  return names;
}

/**
 * Every `<root>/packages/*` package whose `package.json` declares `exports` or `main` — the
 * release set. Sorted by directory. A package with neither field is outside the set (it has no
 * entry point to publish or import, so it is never bumped, checked or pinned).
 *
 * Each member: `{ dir, name, version, private, pkg }`. `dir` is relative to `root`, like
 * `packages/core`. `private` is always a boolean (`pkg.private === true`, never `undefined`).
 */
export function readReleaseSet(root) {
  const packagesDir = join(root, 'packages');
  const dirs = readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const set = [];
  for (const dir of dirs) {
    const pkgPath = join(packagesDir, dir, 'package.json');
    if (!existsSync(pkgPath)) continue;
    const pkg = readPackageJson(pkgPath, dir);
    if (pkg.exports === undefined && pkg.main === undefined) continue;
    set.push({
      dir: `packages/${dir}`,
      name: pkg.name,
      version: pkg.version,
      private: pkg.private === true,
      pkg,
    });
  }
  return set;
}

/** The release set's non-private members — the ones the publish job actually publishes. */
export function publishedSet(set) {
  return set.filter((member) => !member.private);
}

// ── versions ────────────────────────────────────────────────────────────────────────────────
// Realm compares versions only two ways: is this final version above the tree's shared version
// (release or development), and is it above a published final. No other comparison — no ranges,
// no coercion, no sorting a list of arbitrary versions — is needed anywhere in the release flow.

/** A release version: MAJOR.MINOR.PATCH, no prerelease, no build metadata, no leading zeros. */
export const FINAL = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function isFinal(v) {
  return FINAL.test(v);
}

/**
 * The forms a tree's shared version may take: a release (FINAL) or a development prerelease
 * (`X.Y.Z-dev.0`, or in general any valid prerelease suffix — the exact prerelease grammar is
 * not enforced here, only that one exists).
 */
export const SHARED_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$/;

/**
 * True when the final version `v` is above the tree/registry version `s` (which matches
 * `SHARED_VERSION`): `v`'s three numbers are greater than `s`'s, compared numerically: or they
 * are equal and `s` carries a prerelease (so `v` is the final release of the development version
 * `s` already sits at). `v` is never itself a prerelease — callers only ever compare a final
 * candidate release against the tree's version or a published final.
 */
export function isAbove(v, s) {
  const vm = FINAL.exec(v);
  if (!vm) throw new Error(`isAbove: "${v}" is not a final version`);
  const sm = SHARED_VERSION.exec(s);
  if (!sm) throw new Error(`isAbove: "${s}" does not match SHARED_VERSION`);
  const vTuple = [Number(vm[1]), Number(vm[2]), Number(vm[3])];
  const sTuple = [Number(sm[1]), Number(sm[2]), Number(sm[3])];
  for (let i = 0; i < 3; i++) {
    if (vTuple[i] > sTuple[i]) return true;
    if (vTuple[i] < sTuple[i]) return false;
  }
  return sm[4] !== undefined; // equal numbers: above iff s is a prerelease of that same release
}

/** The development version after a final release: `MAJOR.MINOR.(PATCH+1)-dev.0`. */
export function devVersionAfter(v) {
  const m = FINAL.exec(v);
  if (!m) throw new Error(`devVersionAfter: "${v}" is not a final version`);
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}-dev.0`;
}

// ── dependencies ────────────────────────────────────────────────────────────────────────────

/**
 * The internal dependencies of `pkg` — every entry of `dependencies`, `optionalDependencies` and
 * `peerDependencies` whose name is in `names` (a `Set` of workspace package names, from
 * `readWorkspaceNames`). Each result: `{ field, name, spec }`.
 */
export function internalDeps(pkg, names) {
  const found = [];
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    const deps = pkg[field] ?? {};
    for (const name of Object.keys(deps)) {
      if (names.has(name)) found.push({ field, name, spec: deps[name] });
    }
  }
  return found;
}

// ── the version literal in src/version.ts ──────────────────────────────────────────────────
export const VERSION_LINE = /^export const VERSION = '([^']+)';$/m;
