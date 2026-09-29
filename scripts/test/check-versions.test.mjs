// scripts/test/check-versions.test.mjs — issue #620 PR-A (D11 CV1-CV3).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkRelease } from '../lib/check-release.mjs';
import { makeTempDir, removeTempDir, runNode, scriptPath, publishYmlFor } from './helpers.mjs';

const REPO_ROOT = new URL('../..', import.meta.url).pathname;

function writeJson(p, obj) {
  writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
}
function writeMember(
  root,
  dir,
  {
    version = '1.0.0',
    deps = {},
    versionTs = version,
    skipVersionTs = false,
    main = './x.js',
  } = {},
) {
  mkdirSync(join(root, 'packages', dir, 'src'), { recursive: true });
  writeJson(join(root, 'packages', dir, 'package.json'), {
    name: `@q/${dir}`,
    version,
    main,
    dependencies: deps,
  });
  if (!skipVersionTs) {
    writeFileSync(
      join(root, 'packages', dir, 'src', 'version.ts'),
      `export const VERSION = '${versionTs}';\n`,
    );
  }
}
function writePublishYml(root, content) {
  mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(root, '.github', 'workflows', 'publish.yml'), content);
}

test('CV1 — the real tree passes', () => {
  const r = runNode(scriptPath('check-versions.mjs'), ['--root', REPO_ROOT], {
    cwd: REPO_ROOT,
    env: process.env,
  });
  assert.equal(r.status, 0, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
  assert.match(r.stdout, /^✓ /);
});

test('CV2 — each fixture exits 1 with its ✗ line', () => {
  const scenarios = [
    {
      name: 'a member without src/version.ts',
      build: (root) => {
        writeMember(root, 'a', { version: '1.0.0', skipVersionTs: true });
        writePublishYml(root, publishYmlFor(['a']));
      },
      matches:
        /✗ packages\/a\/src\/version\.ts is missing, or has no VERSION line\. Create it with: export const VERSION = '1\.0\.0';/,
    },
    {
      name: 'a src/version.ts that differs from package.json',
      build: (root) => {
        writeMember(root, 'a', { version: '1.0.0', versionTs: '0.9.0' });
        writePublishYml(root, publishYmlFor(['a']));
      },
      matches:
        /✗ packages\/a\/src\/version\.ts says 0\.9\.0, but packages\/a\/package\.json says 1\.0\.0\. Make them equal \(the release script writes both\)\./,
    },
    {
      name: 'two versions',
      build: (root) => {
        writeMember(root, 'a', { version: '1.0.0' });
        writeMember(root, 'b', { version: '1.0.1' });
        writePublishYml(root, publishYmlFor(['a', 'b']));
      },
      matches:
        /✗ The release set does not share one version: packages\/a=1\.0\.0, packages\/b=1\.0\.1\./,
    },
    {
      name: 'the restore loop missing a published package',
      build: (root) => {
        writeMember(root, 'a', { version: '1.0.0' });
        writeMember(root, 'b', { version: '1.0.0' });
        writePublishYml(root, publishYmlFor(['a'], ['a', 'b'])); // loop names only 'a'; steps publish a and b
      },
      matches:
        /✗ publish\.yml's restore loop does not list packages\/b, which is published\. Add it to the loop in \.github\/workflows\/publish\.yml\./,
    },
    {
      name: 'a publish step for a directory that does not exist',
      build: (root) => {
        writeMember(root, 'a', { version: '1.0.0' });
        writePublishYml(root, publishYmlFor(['a'], ['a', 'ghost']));
      },
      matches:
        /✗ publish\.yml has a publish step for packages\/ghost, which does not exist\. Remove the step from \.github\/workflows\/publish\.yml, or create the package\./,
    },
    {
      name: 'a package named twice',
      build: (root) => {
        writeMember(root, 'a', { version: '1.0.0' });
        writePublishYml(root, publishYmlFor(['a', 'a'], ['a']));
      },
      matches:
        /✗ publish\.yml's restore loop names packages\/a more than once\. Remove the duplicate from \.github\/workflows\/publish\.yml\./,
    },
    {
      name: 'a published package depending on a private package',
      build: (root) => {
        writeMember(root, 'a', { version: '1.0.0', deps: { '@q/b': '*' } });
        mkdirSync(join(root, 'packages', 'b', 'src'), { recursive: true });
        writeJson(join(root, 'packages', 'b', 'package.json'), {
          name: '@q/b',
          version: '1.0.0',
          main: './x.js',
          private: true,
        });
        writeFileSync(
          join(root, 'packages', 'b', 'src', 'version.ts'),
          "export const VERSION = '1.0.0';\n",
        );
        writePublishYml(root, publishYmlFor(['a']));
      },
      matches:
        /✗ @q\/a depends on @q\/b, which is private and never published\. Make @q\/b public, or remove the dependency from packages\/a\/package\.json\./,
    },
    {
      name: 'a publish order with a dependent before its dependency',
      build: (root) => {
        writeMember(root, 'a', { version: '1.0.0', deps: { '@q/b': '*' } });
        writeMember(root, 'b', { version: '1.0.0' });
        writePublishYml(root, publishYmlFor(['a', 'b'], ['a', 'b'])); // a published before its dependency b
      },
      matches:
        /✗ publish\.yml publishes @q\/a before its dependency @q\/b\. Move the publish step for packages\/b above the one for packages\/a\./,
    },
  ];

  for (const { name, build, matches } of scenarios) {
    const root = makeTempDir('cv2');
    try {
      build(root);
      const r = runNode(scriptPath('check-versions.mjs'), ['--root', root], {
        cwd: root,
        env: process.env,
      });
      assert.equal(
        r.status,
        1,
        `[${name}] expected exit 1, got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`,
      );
      assert.match(r.stderr, matches, `[${name}] stderr mismatch: ${r.stderr}`);
    } finally {
      removeTempDir(root);
    }
  }
});

test('CV2 — --tag v9.9.9 (does not name the version)', () => {
  const root = makeTempDir('cv2-tag');
  try {
    writeMember(root, 'a', { version: '0.45.0' });
    writePublishYml(root, publishYmlFor(['a']));
    const r = runNode(scriptPath('check-versions.mjs'), ['--root', root, '--tag', 'v9.9.9'], {
      cwd: root,
      env: process.env,
    });
    assert.equal(r.status, 1);
    assert.match(
      r.stderr,
      /✗ Tag v9\.9\.9 does not name the packages' version, 0\.45\.0\. Push the tag the release script created\./,
    );
  } finally {
    removeTempDir(root);
  }
});

test('CV2 — --tag v0.46.1-dev.0 when the shared version is 0.46.1-dev.0 (not final)', () => {
  const root = makeTempDir('cv2-devtag');
  try {
    writeMember(root, 'a', { version: '0.46.1-dev.0' });
    writePublishYml(root, publishYmlFor(['a']));
    const r = runNode(
      scriptPath('check-versions.mjs'),
      ['--root', root, '--tag', 'v0.46.1-dev.0'],
      {
        cwd: root,
        env: process.env,
      },
    );
    assert.equal(r.status, 1);
    assert.match(
      r.stderr,
      /✗ The packages' version 0\.46\.1-dev\.0 is not a release version, so it cannot be published\. Only a commit made by npm run release can be tagged for publishing\./,
    );
  } finally {
    removeTempDir(root);
  }
});

test('CV3 — the reader finds publish steps in both shapes: block run: | and one-line run: npm publish', () => {
  const root = makeTempDir('cv3');
  try {
    writeMember(root, 'a', { version: '1.0.0' });
    writeMember(root, 'b', { version: '1.0.0' });
    mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
    writeFileSync(
      join(root, '.github', 'workflows', 'publish.yml'),
      `name: Publish
jobs:
  build:
    steps:
      - name: Restore dist
        run: |
          for p in a b; do
            echo restore $p
          done
  publish:
    steps:
      - name: Publish @q/a
        working-directory: packages/a
        run: |
          npm publish --provenance
      - name: Publish @q/b
        working-directory: packages/b
        run: npm publish --provenance
`,
    );
    // checkRelease directly, so we can assert zero failures precisely
    const errors = checkRelease(root, {});
    assert.deepEqual(errors, []);
    const r = runNode(scriptPath('check-versions.mjs'), ['--root', root], {
      cwd: root,
      env: process.env,
    });
    assert.equal(r.status, 0, r.stderr);
  } finally {
    removeTempDir(root);
  }
});
