// scripts/test/publish-guard.test.mjs — issue #620 PR-A (D11 PG1-PG5).
// "a temporary git repository with one commit and a package.json"

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeTempDir, removeTempDir, makeIsolatedEnv, runNode, scriptPath } from './helpers.mjs';

function makeRepo(prefix) {
  const { home, env } = makeIsolatedEnv(prefix);
  const root = makeTempDir(`${prefix}-repo`);
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: '@q/guarded', version: '1.0.0' }, null, 2) + '\n',
  );
  execFileSync('git', ['init', '-q', '.'], { cwd: root, env });
  execFileSync('git', ['add', '-A'], { cwd: root, env });
  execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: root, env });
  const head = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    env,
    encoding: 'utf-8',
  }).trim();
  return { root, home, env, head };
}
function writeFixture(root, obj) {
  const p = join(root, 'fixture.json');
  writeFileSync(p, JSON.stringify(obj));
  return p;
}

test('PG1 — E404 → publish, exit 0', () => {
  const { root, home, env } = makeRepo('pg1');
  try {
    const fixture = writeFixture(root, {
      exitCode: 1,
      stdout: JSON.stringify({ error: { code: 'E404', summary: 'not found' } }),
      stderr: 'npm error code E404\n',
    });
    const r = runNode(scriptPath('publish-guard.mjs'), ['--fixture', fixture], { cwd: root, env });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'publish');
    assert.equal(r.stderr, '');
  } finally {
    removeTempDir(root);
    removeTempDir(home);
  }
});

test('PG2 — the commit equals HEAD → skip, exit 0, the notice on stderr', () => {
  const { root, home, env, head } = makeRepo('pg2');
  try {
    const fixture = writeFixture(root, { exitCode: 0, stdout: JSON.stringify(head), stderr: '' });
    const r = runNode(scriptPath('publish-guard.mjs'), ['--fixture', fixture], { cwd: root, env });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'skip');
    assert.match(
      r.stderr,
      new RegExp(
        `::notice::@q/guarded@1\\.0\\.0 is already published from this commit \\(${head.slice(0, 7)}\\); skipping\\.`,
      ),
    );
  } finally {
    removeTempDir(root);
    removeTempDir(home);
  }
});

test('PG3 — another commit → exit 1; stderr names both commits', () => {
  const { root, home, env, head } = makeRepo('pg3');
  try {
    const other = '1111111111111111111111111111111111111111';
    const fixture = writeFixture(root, { exitCode: 0, stdout: JSON.stringify(other), stderr: '' });
    const r = runNode(scriptPath('publish-guard.mjs'), ['--fixture', fixture], { cwd: root, env });
    assert.equal(r.status, 1);
    assert.equal(r.stdout, '');
    assert.match(
      r.stderr,
      new RegExp(
        `::error::@q/guarded@1\\.0\\.0 is already published from commit ${other.slice(0, 7)} \\(the v1\\.0\\.0 release\\), not from this commit ${head.slice(0, 7)}\\. npm cannot publish the same version twice\\. To publish these changes, release a new version with npm run release\\. A manual dry run shows this for any commit that carries an already-published version\\.`,
      ),
    );
  } finally {
    removeTempDir(root);
    removeTempDir(home);
  }
});

test('PG4 — exit 0 with empty output → exit 1', () => {
  const { root, home, env } = makeRepo('pg4');
  try {
    const fixture = writeFixture(root, { exitCode: 0, stdout: '', stderr: '' });
    const r = runNode(scriptPath('publish-guard.mjs'), ['--fixture', fixture], { cwd: root, env });
    assert.equal(r.status, 1);
    assert.equal(r.stdout, '');
    assert.match(
      r.stderr,
      /::error::@q\/guarded@1\.0\.0 is already published, and the registry records no commit for it, so this commit cannot be shown to be that release\. To publish these changes, release a new version with npm run release\./,
    );
  } finally {
    removeTempDir(root);
    removeTempDir(home);
  }
});

test('PG5 — exit 1 with ECONNREFUSED → exit 1', () => {
  const { root, home, env } = makeRepo('pg5');
  try {
    const fixture = writeFixture(root, {
      exitCode: 1,
      stdout: '',
      stderr: 'npm error code ECONNREFUSED\nnpm error more detail\n',
    });
    const r = runNode(scriptPath('publish-guard.mjs'), ['--fixture', fixture], { cwd: root, env });
    assert.equal(r.status, 1);
    assert.equal(r.stdout, '');
    assert.match(
      r.stderr,
      /::error::Cannot read @q\/guarded@1\.0\.0 from the registry: npm error code ECONNREFUSED\. Re-run the workflow\./,
    );
  } finally {
    removeTempDir(root);
    removeTempDir(home);
  }
});
