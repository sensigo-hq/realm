// scripts/test/check-brands.test.mjs — issue #620 PR-B (CB1–CB14). Each cell builds a small fixture
// tree of hand-written `dist` files in a temp folder and runs scripts/check-brands.mjs against it
// with `--root`: the script is exercised end to end, on trees whose defect is the one thing wrong.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { cleanEnv, makeTempDir, removeTempDir, runNode, scriptPath } from './helpers.mjs';

/** What `brandClass` installs, in a fixture module: a faithful, minimal copy. */
const PRELUDE = `
const RELEASE_LINE_KEY = Symbol.for('@sensigo/realm/release-line');
const TAG = Symbol.for('@sensigo/realm/brand-check');
const fixed = { enumerable: false, writable: false, configurable: false };
function mark(Class, key, brand, { releaseLine = true, tag = true } = {}) {
  Object.defineProperty(Class.prototype, key, { value: brand, ...fixed });
  if (releaseLine) Object.defineProperty(Class.prototype, RELEASE_LINE_KEY, { value: brand, ...fixed });
  const check = function (value) { return Function.prototype[Symbol.hasInstance].call(this, value); };
  if (tag) Object.defineProperty(check, TAG, { value: key, ...fixed });
  Object.defineProperty(Class, Symbol.hasInstance, { value: check, ...fixed });
}
`;

/**
 * The text of a module exporting `classes`. Each spec: `{ name }` plus what to get wrong:
 * `unmarked`, `key` (the key it is marked under), `generation`, `brandPackage`, `releaseLine:
 * false`, `tag: false`, or `ownCheck` (an instance check of its own, no mark at all).
 */
function moduleOf(packageName, version, classes) {
  const lines = [PRELUDE];
  for (const spec of classes) {
    if (spec.ownCheck) {
      lines.push(
        `export class ${spec.name} { static [Symbol.hasInstance](value) { return true; } }`,
      );
      continue;
    }
    lines.push(`export class ${spec.name} {}`);
    if (spec.unmarked) continue;
    const key = spec.key ?? `${packageName}/${spec.name}`;
    const brand = {
      package: spec.brandPackage ?? packageName,
      generation: spec.generation ?? version,
      version: spec.generation ?? version,
      url: null,
    };
    lines.push(
      `mark(${spec.name}, Symbol.for(${JSON.stringify(key)}), Object.freeze(${JSON.stringify(brand)}), ` +
        `{ releaseLine: ${spec.releaseLine !== false}, tag: ${spec.tag !== false} });`,
    );
  }
  return lines.join('\n') + '\n';
}

function writeFile(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** One package of a fixture tree: `packages/<dir>/package.json` and its files. */
function addPackage(root, dir, { name, version = '1.0.0', isPrivate = false, files, ...manifest }) {
  writeFile(
    join(root, 'packages', dir, 'package.json'),
    JSON.stringify(
      { name, version, type: 'module', ...(isPrivate ? { private: true } : {}), ...manifest },
      null,
      2,
    ) + '\n',
  );
  for (const [relative, content] of Object.entries(files ?? {})) {
    writeFile(join(root, 'packages', dir, relative), content);
  }
}

/** Builds a fixture tree with `build(root)`, runs the check on it, removes the tree. */
function check(build) {
  const root = makeTempDir('brands');
  try {
    build(root);
    return runNode(scriptPath('check-brands.mjs'), ['--root', root], {
      cwd: root,
      env: cleanEnv(),
    });
  } finally {
    removeTempDir(root);
  }
}

const SUCCESS = (classes, packages) =>
  `check-brands: ${classes} in ${packages} ${classes.startsWith('1 ') ? 'carries its' : 'carry their'} package's release mark.\n`;

/** A package with one entry, `dist/index.js`, exporting `classes`. */
function simple(root, dir, classes, extra = {}) {
  const name = extra.name ?? `@q/${dir}`;
  const version = extra.version ?? '1.0.0';
  addPackage(root, dir, {
    name,
    version,
    exports: { '.': { import: './dist/index.js', types: './dist/index.d.ts' } },
    files: { 'dist/index.js': moduleOf(name, version, classes) },
    ...extra.manifest,
    ...(extra.isPrivate ? { isPrivate: true } : {}),
  });
}

test('CB1 — every class marked correctly, one package private: exit 0, the counts in the success line', () => {
  const r = check((root) => {
    simple(root, 'a', [{ name: 'One' }, { name: 'Two' }]);
    simple(root, 'b', [{ name: 'Three' }], { isPrivate: true });
  });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.equal(r.stdout, SUCCESS('3 exported classes', '2 packages'));
  assert.equal(r.stderr, '');
});

test('CB2 — a class with no mark: exit 1, the class named, the call to add', () => {
  const r = check((root) => simple(root, 'a', [{ name: 'Plain', unmarked: true }]));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /@q\/a: entry \.: class Plain carries no release mark/);
  assert.match(
    r.stderr,
    /brandClass\(Plain, Symbol\.for\('@q\/a\/Plain'\), <the package's brand>\);/,
  );
});

test("CB3 — a class marked with another class's key: both keys named", () => {
  const r = check((root) => simple(root, 'a', [{ name: 'Foo', key: '@q/a/Bar' }]));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /class Foo is marked under the key Symbol\(@q\/a\/Bar\)/);
  assert.match(r.stderr, /it must be marked under Symbol\(@q\/a\/Foo\)/);
});

test("CB4 — a mark whose generation is not the package's version: both versions named", () => {
  const r = check((root) => simple(root, 'a', [{ name: 'Foo', generation: '9.9.9' }]));
  assert.equal(r.status, 1);
  assert.match(
    r.stderr,
    /class Foo has a mark with the generation '9\.9\.9'; the package is at version '1\.0\.0'/,
  );
});

test('CB5 — a mark naming another package: both names in the line', () => {
  const r = check((root) => simple(root, 'a', [{ name: 'Foo', brandPackage: '@q/other' }]));
  assert.equal(r.status, 1);
  assert.match(
    r.stderr,
    /class Foo has a mark naming the package '@q\/other'; it must name '@q\/a'/,
  );
});

test('CB6 — the release-line key missing: exit 1, the key named', () => {
  const r = check((root) => simple(root, 'a', [{ name: 'Foo', releaseLine: false }]));
  assert.equal(r.status, 1);
  assert.match(
    r.stderr,
    /class Foo has no mark on its prototype under the release-line key Symbol\(@sensigo\/realm\/release-line\)/,
  );
});

test('CB7 — an unmarked class in a private package fails too', () => {
  const r = check((root) => {
    simple(root, 'a', [{ name: 'Fine' }]);
    simple(root, 'priv', [{ name: 'Hidden', unmarked: true }], { isPrivate: true });
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /@q\/priv: entry \.: class Hidden carries no release mark/);
});

test('CB8 — an entry that is also a bin target and throws when imported is not imported', () => {
  const r = check((root) => {
    addPackage(root, 'a', {
      name: '@q/a',
      exports: {
        '.': { import: './dist/bin.js' },
        './lib': { import: './dist/lib.js' },
      },
      bin: { tool: './dist/bin.js' },
      files: {
        'dist/bin.js': "throw new Error('importing the bin runs the program');\n",
        'dist/lib.js': moduleOf('@q/a', '1.0.0', [{ name: 'Lib' }]),
      },
    });
  });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.equal(
    r.stdout,
    "check-brands: 1 exported class in 1 package carries its package's release mark.\n",
  );
});

test('CB9 — a wildcard entry: the file holding an unmarked class is named', () => {
  const r = check((root) => {
    addPackage(root, 'a', {
      name: '@q/a',
      exports: { './dist/tools/*.js': { import: './dist/tools/*.js' } },
      files: {
        'dist/tools/one.js': moduleOf('@q/a', '1.0.0', [{ name: 'Tool', unmarked: true }]),
        'dist/tools/one.d.ts': 'export declare class Tool {}\n',
      },
    });
  });
  assert.equal(r.status, 1);
  assert.match(
    r.stderr,
    /@q\/a: entry \.\/dist\/tools\/one\.js: class Tool carries no release mark/,
  );
});

test('CB10 — an entry file that does not exist: the file and `npm run build` named', () => {
  const r = check((root) => {
    addPackage(root, 'a', { name: '@q/a', exports: { '.': { import: './dist/missing.js' } } });
  });
  assert.equal(r.status, 1);
  assert.match(
    r.stderr,
    /@q\/a: entry \.: packages\/a\/dist\/missing\.js does not exist — run `npm run build` first/,
  );
});

test('CB11 — the same class exported from two entries is counted once', () => {
  const r = check((root) => {
    addPackage(root, 'a', {
      name: '@q/a',
      exports: { '.': { import: './dist/a.js' }, './again': { import: './dist/b.js' } },
      files: {
        'dist/a.js': moduleOf('@q/a', '1.0.0', [{ name: 'Foo' }]),
        'dist/b.js': "export { Foo } from './a.js';\n",
      },
    });
  });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.equal(
    r.stdout,
    "check-brands: 1 exported class in 1 package carries its package's release mark.\n",
  );
});

test('CB12 — a class whose own instance check is not the release mark: said so, never "no release mark"', () => {
  const r = check((root) => simple(root, 'a', [{ name: 'Custom', ownCheck: true }]));
  assert.equal(r.status, 1);
  assert.match(
    r.stderr,
    /class Custom has an instance check of its own that is not the release mark/,
  );
  assert.doesNotMatch(r.stderr, /carries no release mark/);
});

test('CB13 — an entry that throws when imported: one line, the entry and the error message, no stack', () => {
  const r = check((root) => {
    addPackage(root, 'a', {
      name: '@q/a',
      exports: { '.': { import: './dist/index.js' } },
      files: { 'dist/index.js': "throw new Error('boom: the module failed');\n" },
    });
  });
  assert.equal(r.status, 1);
  assert.equal(r.stderr, '@q/a: entry .: importing the entry failed: boom: the module failed\n');
});

test('CB14 — a tree whose entries export no class at all is not a pass', () => {
  const r = check((root) => {
    addPackage(root, 'a', {
      name: '@q/a',
      exports: { '.': { import: './dist/index.js' } },
      files: { 'dist/index.js': 'export const answer = 42;\n' },
    });
  });
  assert.equal(r.status, 1);
  assert.match(
    r.stderr,
    /found no exported class in 1 package — nothing was checked; run `npm run build` first/,
  );
});
