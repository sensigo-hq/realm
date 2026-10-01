// scripts/test/release-set.test.mjs — issue #620 PR-A (D11 RS1-RS5).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FINAL,
  isFinal,
  isAbove,
  devVersionAfter,
  readReleaseSet,
  readWorkspaceNames,
} from '../lib/release-set.mjs';
import { makeTempDir, removeTempDir } from './helpers.mjs';

describe('RS1 — FINAL', () => {
  for (const v of ['0.46.0', '1.2.3']) {
    test(`accepts ${v}`, () => {
      assert.equal(isFinal(v), true);
      assert.equal(FINAL.test(v), true);
    });
  }
  for (const v of ['0.46.0-rc.1', '0.46.0+b.1', '01.2.3', '1.2', 'v1.2.3']) {
    test(`refuses ${v}`, () => {
      assert.equal(isFinal(v), false);
      assert.equal(FINAL.test(v), false);
    });
  }
});

describe('RS2 — isAbove', () => {
  const cases = [
    ['0.46.0', '0.45.0', true],
    ['0.45.0', '0.45.0', false],
    ['0.45.9', '0.46.0', false],
    ['0.46.1', '0.46.1-dev.0', true],
    ['0.46.0', '0.46.1-dev.0', false],
    ['0.47.0', '0.46.1-dev.0', true],
    ['1.0.0', '0.99.99', true],
  ];
  for (const [v, s, expected] of cases) {
    test(`isAbove(${v}, ${s}) === ${expected}`, () => {
      assert.equal(isAbove(v, s), expected);
    });
  }
});

test('RS3 — devVersionAfter', () => {
  assert.equal(devVersionAfter('0.46.0'), '0.46.1-dev.0');
});

test('RS4 — readReleaseSet / readWorkspaceNames', () => {
  const root = makeTempDir('rs4');
  try {
    // two packages with entries
    mkdirSync(join(root, 'packages', 'alpha'), { recursive: true });
    writeFileSync(
      join(root, 'packages', 'alpha', 'package.json'),
      JSON.stringify({ name: '@q/alpha', version: '1.0.0', main: './dist/index.js' }, null, 2),
    );
    mkdirSync(join(root, 'packages', 'beta'), { recursive: true });
    writeFileSync(
      join(root, 'packages', 'beta', 'package.json'),
      JSON.stringify(
        { name: '@q/beta', version: '1.0.0', exports: { '.': './dist/index.js' } },
        null,
        2,
      ),
    );
    // a private package with NEITHER exports nor main
    mkdirSync(join(root, 'packages', 'gamma'), { recursive: true });
    writeFileSync(
      join(root, 'packages', 'gamma', 'package.json'),
      JSON.stringify({ name: '@q/gamma', version: '0.0.0', private: true }, null, 2),
    );
    // a directory with NO package.json at all
    mkdirSync(join(root, 'packages', 'delta'), { recursive: true });

    const set = readReleaseSet(root);
    assert.deepEqual(
      set.map((m) => m.dir),
      ['packages/alpha', 'packages/beta'],
    );
    assert.equal(set[0].private, false);
    assert.equal(set[1].private, false);

    const names = readWorkspaceNames(root);
    assert.deepEqual([...names].sort(), ['@q/alpha', '@q/beta', '@q/gamma'].sort());
  } finally {
    removeTempDir(root);
  }
});

test('RS5 — a package.json that is not JSON is named', () => {
  const root = makeTempDir('rs5');
  try {
    mkdirSync(join(root, 'packages', 'alpha'), { recursive: true });
    writeFileSync(
      join(root, 'packages', 'alpha', 'package.json'),
      JSON.stringify({ name: '@q/alpha', version: '1.0.0', main: './dist/index.js' }, null, 2),
    );
    mkdirSync(join(root, 'packages', 'broken'), { recursive: true });
    writeFileSync(join(root, 'packages', 'broken', 'package.json'), '{ "name": ');
    for (const read of [readReleaseSet, readWorkspaceNames]) {
      assert.throws(
        () => read(root),
        (e) => {
          assert.ok(e instanceof Error);
          assert.ok(
            e.message.startsWith('packages/broken/package.json is not valid JSON ('),
            e.message,
          );
          return true;
        },
      );
    }
  } finally {
    removeTempDir(root);
  }
});
