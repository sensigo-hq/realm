// scripts/lib/check-release.mjs — issue #620 PR-A (D3). `checkRelease(root, { tag })` is the one
// place that knows what the publish workflow will refuse: `release.mjs` calls it before it ever
// writes a file (so the release script never tags a tree the workflow would refuse), and
// `scripts/check-versions.mjs` (below, and this module's CLI) runs it on every PR and again in
// `publish.yml` itself, against the tagged tree.
//
// Every failure is a full sentence: what was found, what was expected, and what to change.
// `publish.yml`'s own two lists (the restore loop, the publish steps) stay hand-written — that
// file's changes are canaried (the #238 boundary) — so this checks them instead of generating
// them.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  readWorkspaceNames,
  readReleaseSet,
  publishedSet,
  internalDeps,
  isFinal,
  SHARED_VERSION,
  VERSION_LINE,
} from './release-set.mjs';

const baseName = (dir) => dir.slice('packages/'.length);

/**
 * Parse `.github/workflows/publish.yml` the way `scripts/check-action-pins.mjs` parses workflow
 * YAML: line-based, never a real YAML parse (a real parser discards the comments and quoting
 * this needs to preserve, and the shapes here are simple enough that line matching is exact).
 *
 * Returns `{ loopWords, publishSteps }`:
 * - `loopWords`: the words of the restore loop's `for p in <words>; do` line, quotes stripped.
 * - `publishSteps`: the `packages/<dir>` directory of every publish step — a step block (from
 *   one `- name:` line up to, but not including, the next) whose block has BOTH a
 *   `working-directory: packages/<dir>` line and a `run:` value (one line or a block) containing
 *   `npm publish`. Keyed on that combination, never on the step's `name:`.
 */
export function parsePublishYml(content) {
  const lines = content.split('\n');

  let loopWords = [];
  for (const line of lines) {
    const m = /^\s*for p in (.+?); do\s*$/.exec(line);
    if (m) {
      loopWords = m[1].split(/\s+/).map((w) => w.replace(/^['"]|['"]$/g, ''));
      break;
    }
  }

  const stepStarts = [];
  lines.forEach((line, i) => {
    if (/^\s*- name:/.test(line)) stepStarts.push(i);
  });
  const publishSteps = [];
  for (let s = 0; s < stepStarts.length; s++) {
    const start = stepStarts[s];
    const end = s + 1 < stepStarts.length ? stepStarts[s + 1] : lines.length;
    const block = lines.slice(start, end);
    let dir = null;
    for (const line of block) {
      const m = /^\s*working-directory:\s*['"]?packages\/([^'"\s]+)['"]?\s*$/.exec(line);
      if (m) {
        dir = m[1];
        break;
      }
    }
    if (dir === null) continue;
    if (block.some((line) => /npm publish\b/.test(line))) publishSteps.push(dir);
  }
  return { loopWords, publishSteps };
}

/**
 * `dirs` (base names, e.g. `core`, possibly with duplicates) against `publishedBaseNames` (a
 * `Set` of base names). Reports, via `fail`, every duplicate, every named directory that does not
 * exist, every named directory that exists but is not published, and every published directory
 * not named — each in `templates`' own words.
 */
function checkYamlSet(fail, root, dirs, publishedBaseNames, templates) {
  const seen = new Set();
  for (const dir of dirs) {
    if (seen.has(dir)) fail(templates.dupe(dir));
    seen.add(dir);
  }
  for (const dir of seen) {
    if (!existsSync(join(root, 'packages', dir, 'package.json'))) {
      fail(templates.missingPkg(dir));
    } else if (!publishedBaseNames.has(dir)) {
      fail(templates.extra(dir));
    }
  }
  for (const base of publishedBaseNames) {
    if (!seen.has(base)) fail(templates.missing(base));
  }
}

/**
 * Returns a list of failure sentences (empty when everything holds):
 * 1. the release set shares one version, and it matches `SHARED_VERSION`;
 * 2. each member's `src/version.ts` contains `VERSION_LINE`, equal to its `package.json`;
 * 3. `publish.yml`'s restore loop, publish steps and the published set are the same set of
 *    directories; every named directory exists; none is named twice;
 * 4. every internal dependency of a published member is itself a published member;
 * 5. the publish steps publish every dependency before its dependents;
 * 6. with `tag`: it is `v<shared version>`, and the shared version is final.
 */
export function checkRelease(root, { tag } = {}) {
  const errors = [];
  const fail = (msg) => errors.push(msg);

  const workspaceNames = new Set(readWorkspaceNames(root));
  const set = readReleaseSet(root);
  const published = publishedSet(set);
  const setByName = new Map(set.map((m) => [m.name, m]));
  const publishedByName = new Map(published.map((m) => [m.name, m]));
  const publishedBaseNames = new Set(published.map((m) => baseName(m.dir)));

  // 1. one shared version, and it is a well-formed release or development version
  const versions = [...new Set(set.map((m) => m.version))];
  let sharedVersion = null;
  if (versions.length !== 1) {
    fail(
      `The release set does not share one version: ${set.map((m) => `${m.dir}=${m.version}`).join(', ')}. Make every package.json version equal (the release script writes them all).`,
    );
  } else {
    const [v] = versions;
    if (!SHARED_VERSION.test(v)) {
      fail(
        `The packages' version "${v}" is not a valid version (expected MAJOR.MINOR.PATCH, optionally with a prerelease like -dev.0). Fix every packages/*/package.json.`,
      );
    } else {
      sharedVersion = v;
    }
  }

  // 2. src/version.ts matches package.json
  for (const m of set) {
    const versionFile = join(root, m.dir, 'src/version.ts');
    const content = existsSync(versionFile) ? readFileSync(versionFile, 'utf-8') : null;
    const match = content !== null ? VERSION_LINE.exec(content) : null;
    if (!match) {
      fail(
        `${m.dir}/src/version.ts is missing, or has no VERSION line. Create it with: export const VERSION = '${m.version}';`,
      );
    } else if (match[1] !== m.version) {
      fail(
        `${m.dir}/src/version.ts says ${match[1]}, but ${m.dir}/package.json says ${m.version}. Make them equal (the release script writes both).`,
      );
    }
  }

  // 3. publish.yml's two sets, against the published set
  const ymlPath = join(root, '.github/workflows/publish.yml');
  const { loopWords, publishSteps } = parsePublishYml(readFileSync(ymlPath, 'utf-8'));
  checkYamlSet(fail, root, loopWords, publishedBaseNames, {
    dupe: (d) =>
      `publish.yml's restore loop names packages/${d} more than once. Remove the duplicate from .github/workflows/publish.yml.`,
    missingPkg: (d) =>
      `publish.yml's restore loop names packages/${d}, which does not exist. Remove it from .github/workflows/publish.yml, or create the package.`,
    extra: (d) =>
      `publish.yml's restore loop names packages/${d}, which is not published. Remove it from the loop in .github/workflows/publish.yml.`,
    missing: (d) =>
      `publish.yml's restore loop does not list packages/${d}, which is published. Add it to the loop in .github/workflows/publish.yml.`,
  });
  checkYamlSet(fail, root, publishSteps, publishedBaseNames, {
    dupe: (d) =>
      `publish.yml has more than one publish step for packages/${d}. Remove the duplicate from .github/workflows/publish.yml.`,
    missingPkg: (d) =>
      `publish.yml has a publish step for packages/${d}, which does not exist. Remove the step from .github/workflows/publish.yml, or create the package.`,
    extra: (d) =>
      `publish.yml has a publish step for packages/${d}, which is not published. Remove the step from .github/workflows/publish.yml.`,
    missing: (d) =>
      `publish.yml does not have a publish step for packages/${d}, which is published. Add a publish step for it to .github/workflows/publish.yml.`,
  });

  // 4. every internal dependency of a published member is a published member
  for (const m of published) {
    for (const dep of internalDeps(m.pkg, workspaceNames)) {
      const depMember = setByName.get(dep.name);
      if (!depMember) {
        fail(
          `${m.name} depends on ${dep.name}, a workspace package outside the release set (it has no exports or main). Give it an entry, or remove the dependency from ${m.dir}/package.json.`,
        );
      } else if (depMember.private) {
        fail(
          `${m.name} depends on ${dep.name}, which is private and never published. Make ${dep.name} public, or remove the dependency from ${m.dir}/package.json.`,
        );
      }
    }
  }

  // 5. the publish steps publish dependencies before dependents
  for (const m of published) {
    const mIdx = publishSteps.indexOf(baseName(m.dir));
    if (mIdx === -1) continue; // check 3 already reported: no publish step for m
    for (const dep of internalDeps(m.pkg, workspaceNames)) {
      const depMember = publishedByName.get(dep.name);
      if (!depMember) continue; // check 4 already reported this dependency
      const depIdx = publishSteps.indexOf(baseName(depMember.dir));
      if (depIdx === -1) continue; // check 3 already reported: no publish step for the dependency
      if (depIdx > mIdx) {
        fail(
          `publish.yml publishes ${m.name} before its dependency ${dep.name}. Move the publish step for ${depMember.dir} above the one for ${m.dir}.`,
        );
      }
    }
  }

  // 6. with a tag: it names the shared version, and the shared version is final
  if (tag !== undefined && tag !== null && sharedVersion !== null) {
    const expectedTag = `v${sharedVersion}`;
    if (tag !== expectedTag) {
      fail(
        `Tag ${tag} does not name the packages' version, ${sharedVersion}. Push the tag the release script created.`,
      );
    }
    if (!isFinal(sharedVersion)) {
      fail(
        `The packages' version ${sharedVersion} is not a release version, so it cannot be published. Only a commit made by npm run release can be tagged for publishing.`,
      );
    }
  }

  return errors;
}
