// scripts/test/check-narrowed.test.mjs — issue #729 PR-0 (A8): the cast check for `Narrowed`. Each
// cell builds a small `packages/*/src` tree in a temp folder and runs scripts/check-narrowed.mjs
// against it with `--root`; one cell runs it on this repository, so CI holds the law on the real
// sources. A failing cell prints the exit status and the script's own output (file:line only).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanEnv, makeTempDir, removeTempDir, runNode, scriptPath } from './helpers.mjs';

const SCRIPT = scriptPath('check-narrowed.mjs');
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** A tree with one source file per entry of `files` (`{ 'core/src/x.ts': text }`). */
function tree(files) {
  const root = makeTempDir('check-narrowed');
  for (const [path, text] of Object.entries(files)) {
    const full = join(root, 'packages', path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  }
  return root;
}

function run(root) {
  return runNode(SCRIPT, ['--root', root], { cwd: root, env: cleanEnv() });
}

test('this repository: no Narrowed is built outside narrowForDoor', () => {
  const result = run(REPO);
  // (a) red when a source casts or annotates a Narrowed; (b) prints the status and the file:lines.
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /read [1-9]\d* files/);
});

for (const [form, line] of [
  ['a cast', 'const n = composed as Narrowed;'],
  ['an angle-bracket cast', 'const n = <Narrowed>composed;'],
  ['an annotated literal', 'const n: Narrowed = { ways: [], unavailable: [], basis, door };'],
  ['satisfies', 'const n = { ways: [] } satisfies Narrowed;'],
]) {
  test(`${form} outside narrowForDoor fails, naming the file and line`, () => {
    const root = tree({
      'mcp-server/src/door.ts': `import type { Narrowed } from 'x';\n${line}\n`,
    });
    try {
      const result = run(root);
      // (a) red when the pattern for this form is dropped; (b) prints the status and the output.
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stderr, /packages\/mcp-server\/src\/door\.ts:2/);
    } finally {
      removeTempDir(root);
    }
  });
}

test('a cast named in a comment is not a cast', () => {
  const root = tree({
    'core/src/a.ts': '// never `as Narrowed` here\n/* nor <Narrowed> */\nexport const x = 1;\n',
  });
  try {
    const result = run(root);
    // (a) red when comments are read as code; (b) prints the status and the output.
    assert.equal(result.status, 0, result.stderr);
  } finally {
    removeTempDir(root);
  }
});

test('a root with no packages folder is an error, never a pass', () => {
  const root = makeTempDir('check-narrowed-empty');
  try {
    const result = run(root);
    // (a) red when an empty tree reads as clean; (b) prints the status.
    assert.equal(result.status, 2);
  } finally {
    removeTempDir(root);
  }
});
