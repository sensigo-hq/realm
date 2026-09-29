// scripts/test/pin-deps.test.mjs — issue #620 PR-A (D11 PD1-PD4).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import semver from 'semver';
import { makeTempDir, removeTempDir, runNode, scriptPath } from './helpers.mjs';

const REPO_ROOT = new URL('../..', import.meta.url).pathname;

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf-8'));
}
function writeJson(p, obj) {
  writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
}

test('PD1 — spelling: copies the real four package.json files, pins from "*" to the shared version, idempotent', () => {
  const root = makeTempDir('pd1');
  try {
    mkdirSync(join(root, 'packages'), { recursive: true });
    for (const dir of ['core', 'mcp-server', 'testing', 'cli']) {
      mkdirSync(join(root, 'packages', dir), { recursive: true });
      cpSync(
        join(REPO_ROOT, 'packages', dir, 'package.json'),
        join(root, 'packages', dir, 'package.json'),
      );
    }
    // read the version the real tree shares FROM THE COPIES — never hard-code it.
    const version = readJson(join(root, 'packages', 'core', 'package.json')).version;
    for (const dir of ['mcp-server', 'testing', 'cli']) {
      assert.equal(readJson(join(root, 'packages', dir, 'package.json')).version, version);
    }

    // snapshot every non-internal-dep byte via a deep copy comparison after run 1: capture the
    // full JSON of each file before, so we can assert nothing ELSE changed.
    const before = {};
    for (const dir of ['core', 'mcp-server', 'testing', 'cli']) {
      before[dir] = readFileSync(join(root, 'packages', dir, 'package.json'), 'utf-8');
    }

    const r1 = runNode(scriptPath('pin-deps.mjs'), ['--root', root], {
      cwd: root,
      env: process.env,
    });
    assert.equal(r1.status, 0, r1.stderr);

    let changedSpecs = 0;
    for (const dir of ['core', 'mcp-server', 'testing', 'cli']) {
      const pkg = readJson(join(root, 'packages', dir, 'package.json'));
      for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
        for (const [dep, spec] of Object.entries(pkg[field] ?? {})) {
          if (!dep.startsWith('@sensigo/')) continue;
          const beforePkg = JSON.parse(before[dir]);
          const beforeSpec = beforePkg[field]?.[dep];
          if (beforeSpec === '*') {
            assert.equal(spec, version, `${dir} ${field}.${dep} should now be exactly ${version}`);
            changedSpecs++;
          }
        }
      }
    }
    assert.equal(
      changedSpecs,
      5,
      'exactly five internal specs should have changed from "*" to the version',
    );

    // nothing else in any file changed: rebuild a "would-have-changed" copy of the before state
    // with ONLY the internal *-specs replaced by version, and compare byte-for-byte.
    for (const dir of ['core', 'mcp-server', 'testing', 'cli']) {
      const expected = JSON.parse(before[dir]);
      for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
        for (const dep of Object.keys(expected[field] ?? {})) {
          if (dep.startsWith('@sensigo/') && expected[field][dep] === '*')
            expected[field][dep] = version;
        }
      }
      const expectedText = JSON.stringify(expected, null, 2) + '\n';
      const actualText = readFileSync(join(root, 'packages', dir, 'package.json'), 'utf-8');
      assert.equal(
        actualText,
        expectedText,
        `${dir}/package.json should be byte-identical except the pinned specs`,
      );
    }

    // a second run leaves every file byte-identical
    const afterFirstRun = {};
    for (const dir of ['core', 'mcp-server', 'testing', 'cli']) {
      afterFirstRun[dir] = readFileSync(join(root, 'packages', dir, 'package.json'), 'utf-8');
    }
    const r2 = runNode(scriptPath('pin-deps.mjs'), ['--root', root], {
      cwd: root,
      env: process.env,
    });
    assert.equal(r2.status, 0, r2.stderr);
    for (const dir of ['core', 'mcp-server', 'testing', 'cli']) {
      assert.equal(
        readFileSync(join(root, 'packages', dir, 'package.json'), 'utf-8'),
        afterFirstRun[dir],
        `${dir}/package.json must be byte-identical after a second run`,
      );
    }
  } finally {
    removeTempDir(root);
  }
});

function buildRangeFixture(root) {
  mkdirSync(join(root, 'packages', 'core', 'src'), { recursive: true });
  writeJson(join(root, 'packages', 'core', 'package.json'), {
    name: '@q/core',
    version: '0.45.0',
    main: './dist/index.js',
  });
  mkdirSync(join(root, 'packages', 'user', 'src'), { recursive: true });
  writeJson(join(root, 'packages', 'user', 'package.json'), {
    name: '@q/user',
    version: '0.45.0',
    main: './dist/index.js',
    dependencies: { '@q/core': '*' },
    optionalDependencies: { '@q/core': '*' },
    peerDependencies: { '@q/core': '*' },
  });
}

test('PD2 — range: over the grid, semver.satisfies(x, spec) === semver.eq(x, shared version)', () => {
  const root = makeTempDir('pd2');
  try {
    buildRangeFixture(root);
    const r = runNode(scriptPath('pin-deps.mjs'), ['--root', root], {
      cwd: root,
      env: process.env,
    });
    assert.equal(r.status, 0, r.stderr);
    const pkg = readJson(join(root, 'packages', 'user', 'package.json'));
    const grid = ['0.44.9', '0.45.0-rc.1', '0.45.0', '0.45.0+b.1', '0.45.1', '0.46.0', '1.0.0'];
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      const spec = pkg[field]['@q/core'];
      for (const x of grid) {
        assert.equal(
          semver.satisfies(x, spec),
          semver.eq(x, '0.45.0'),
          `${field}: semver.satisfies(${x}, "${spec}") should equal semver.eq(${x}, "0.45.0")`,
        );
      }
    }
  } finally {
    removeTempDir(root);
  }
});

test('PD3 — each refusal exits 1 with its text and leaves every file unchanged', () => {
  const scenarios = [
    {
      name: 'two versions in the set',
      build: (root) => {
        mkdirSync(join(root, 'packages', 'a', 'src'), { recursive: true });
        writeJson(join(root, 'packages', 'a', 'package.json'), {
          name: '@q/a',
          version: '1.0.0',
          main: 'x.js',
        });
        mkdirSync(join(root, 'packages', 'b', 'src'), { recursive: true });
        writeJson(join(root, 'packages', 'b', 'package.json'), {
          name: '@q/b',
          version: '1.0.1',
          main: 'x.js',
        });
      },
      matches:
        /the packages do not share one version \(packages\/a=1\.0\.0, packages\/b=1\.0\.1\) — make them equal\./,
    },
    {
      name: 'a published package depending on a private one',
      build: (root) => {
        mkdirSync(join(root, 'packages', 'a', 'src'), { recursive: true });
        writeJson(join(root, 'packages', 'a', 'package.json'), {
          name: '@q/a',
          version: '1.0.0',
          main: 'x.js',
          dependencies: { '@q/b': '*' },
        });
        mkdirSync(join(root, 'packages', 'b', 'src'), { recursive: true });
        writeJson(join(root, 'packages', 'b', 'package.json'), {
          name: '@q/b',
          version: '1.0.0',
          main: 'x.js',
          private: true,
        });
      },
      matches:
        /@q\/a depends on @q\/b, which is private and never published — make @q\/b public or remove the dependency\./,
    },
    {
      name: 'a published package depending on a workspace package outside the release set',
      build: (root) => {
        mkdirSync(join(root, 'packages', 'a', 'src'), { recursive: true });
        writeJson(join(root, 'packages', 'a', 'package.json'), {
          name: '@q/a',
          version: '1.0.0',
          main: 'x.js',
          dependencies: { '@q/b': '*' },
        });
        mkdirSync(join(root, 'packages', 'b', 'src'), { recursive: true });
        writeJson(join(root, 'packages', 'b', 'package.json'), { name: '@q/b', version: '1.0.0' }); // no main/exports
      },
      matches:
        /@q\/a depends on @q\/b, a workspace package outside the release set \(it has no exports or main\) — give it an entry or remove the dependency\./,
    },
    {
      name: 'a spec of ^0.44.0',
      build: (root) => {
        mkdirSync(join(root, 'packages', 'a', 'src'), { recursive: true });
        writeJson(join(root, 'packages', 'a', 'package.json'), {
          name: '@q/a',
          version: '0.45.0',
          main: 'x.js',
          dependencies: { '@q/b': '^0.44.0' },
        });
        mkdirSync(join(root, 'packages', 'b', 'src'), { recursive: true });
        writeJson(join(root, 'packages', 'b', 'package.json'), {
          name: '@q/b',
          version: '0.45.0',
          main: 'x.js',
        });
      },
      matches:
        /@q\/a depends on @q\/b at \^0\.44\.0 — write "\*" in the source; pin-deps sets the exact version when publishing\./,
    },
  ];

  for (const { name, build, matches } of scenarios) {
    const root = makeTempDir('pd3');
    try {
      build(root);
      const before = {};
      for (const dir of ['a', 'b']) {
        before[dir] = readFileSync(join(root, 'packages', dir, 'package.json'), 'utf-8');
      }
      const r = runNode(scriptPath('pin-deps.mjs'), ['--root', root], {
        cwd: root,
        env: process.env,
      });
      assert.equal(r.status, 1, `[${name}] expected exit 1, got ${r.status}\nstderr: ${r.stderr}`);
      assert.match(r.stderr, /^Error: /, `[${name}] stderr should start with "Error: "`);
      assert.match(r.stderr, matches, `[${name}] stderr text mismatch: ${r.stderr}`);
      for (const dir of ['a', 'b']) {
        assert.equal(
          readFileSync(join(root, 'packages', dir, 'package.json'), 'utf-8'),
          before[dir],
          `[${name}] ${dir}/package.json must be unchanged`,
        );
      }
    } finally {
      removeTempDir(root);
    }
  }
});

test('PD4 — a peerDependencies entry and an optionalDependencies entry are both pinned to exactly the version', () => {
  const root = makeTempDir('pd4');
  try {
    buildRangeFixture(root);
    const r = runNode(scriptPath('pin-deps.mjs'), ['--root', root], {
      cwd: root,
      env: process.env,
    });
    assert.equal(r.status, 0, r.stderr);
    const pkg = readJson(join(root, 'packages', 'user', 'package.json'));
    assert.equal(pkg.peerDependencies['@q/core'], '0.45.0');
    assert.equal(pkg.optionalDependencies['@q/core'], '0.45.0');
    assert.equal(pkg.dependencies['@q/core'], '0.45.0');
  } finally {
    removeTempDir(root);
  }
});
