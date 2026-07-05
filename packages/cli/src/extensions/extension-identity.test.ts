// Tests for the pure extension-identity module (dir_tree_v1): deterministic fingerprints,
// exclusions, symlink skipping, caps with a deterministic prefix, signals fail-soft, and
// recompute-under-recorded-rules for --check-drift.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeExtensionIdentity,
  errorExtensionIdentityEntry,
  recomputeIdentity,
  identityDiffers,
  DIR_TREE_V1_RULES,
} from './extension-identity.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'realm-identity-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Builds a dist dir under a fresh subdirectory of root and returns its module input. */
function makeDist(
  name: string,
  files: Record<string, string>,
): { dir: string; entry: string; module: { declared: string; resolved: string; format: 'esm' } } {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content, 'utf8');
  }
  const entry = join(dir, 'registry.js');
  return {
    dir,
    entry,
    module: { declared: './registry.js', resolved: entry, format: 'esm' },
  };
}

const BASE_FILES = {
  'registry.js': 'export default {};',
  'handlers.js': 'export const h = 1;',
  'nested/util.js': 'export const u = 1;',
  'config.json': '{"a":1}',
};

describe('computeExtensionIdentity — dir_tree_v1 determinism', () => {
  it('same tree twice → identical tree_hash and entry_hash', () => {
    const dist = makeDist('a', BASE_FILES);
    const first = computeExtensionIdentity([dist.module]);
    const second = computeExtensionIdentity([dist.module]);
    expect(second.tree.tree_hash).toBe(first.tree.tree_hash);
    expect(second.modules[0]!.entry_hash).toBe(first.modules[0]!.entry_hash);
    expect(first.tree.file_count).toBe(4);
    expect(first.coverage).toBe('dir_tree_v1');
    expect(first.tree.rules).toBe(DIR_TREE_V1_RULES);
  });

  it('on-disk creation order is irrelevant — same content in two dirs → same tree_hash', () => {
    // Write the same files in reversed orders into two separate trees.
    const distA = makeDist('order-a', {});
    const distB = makeDist('order-b', {});
    const entries = Object.entries(BASE_FILES);
    for (const [rel, content] of entries) {
      mkdirSync(join(distA.dir, rel, '..'), { recursive: true });
      writeFileSync(join(distA.dir, rel), content, 'utf8');
    }
    for (const [rel, content] of [...entries].reverse()) {
      mkdirSync(join(distB.dir, rel, '..'), { recursive: true });
      writeFileSync(join(distB.dir, rel), content, 'utf8');
    }
    const a = computeExtensionIdentity([
      { declared: './registry.js', resolved: join(distA.dir, 'registry.js'), format: 'esm' },
    ]);
    const b = computeExtensionIdentity([
      { declared: './registry.js', resolved: join(distB.dir, 'registry.js'), format: 'esm' },
    ]);
    expect(a.tree.tree_hash).toBe(b.tree.tree_hash);
  });

  it('a changed file changes the tree_hash; the entry_hash changes only for the entry file', () => {
    const dist = makeDist('change', BASE_FILES);
    const before = computeExtensionIdentity([dist.module]);
    writeFileSync(join(dist.dir, 'handlers.js'), 'export const h = 2;', 'utf8');
    const after = computeExtensionIdentity([dist.module]);
    expect(after.tree.tree_hash).not.toBe(before.tree.tree_hash);
    expect(after.modules[0]!.entry_hash).toBe(before.modules[0]!.entry_hash);
  });

  it('EXCLUDES node_modules and .git directories at any depth (jiti-TS root case)', () => {
    const clean = makeDist('clean', BASE_FILES);
    const withNm = makeDist('with-nm', BASE_FILES);
    // A node_modules tree inside the root (the jiti-TS case: entry at project root would
    // otherwise swallow the whole dependency tree) and a nested .git.
    mkdirSync(join(withNm.dir, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(join(withNm.dir, 'node_modules', 'dep', 'index.js'), 'x', 'utf8');
    mkdirSync(join(withNm.dir, 'nested', '.git'), { recursive: true });
    writeFileSync(join(withNm.dir, 'nested', '.git', 'config.json'), '{}', 'utf8');

    const cleanIdentity = computeExtensionIdentity([clean.module]);
    const nmIdentity = computeExtensionIdentity([withNm.module]);
    expect(nmIdentity.tree.tree_hash).toBe(cleanIdentity.tree.tree_hash);
    expect(nmIdentity.tree.file_count).toBe(cleanIdentity.tree.file_count);
  });

  it('skips symlinks (files and directories)', () => {
    const target = makeDist('link-target', { 'registry.js': 'export default {};' });
    const dist = makeDist('with-links', BASE_FILES);
    symlinkSync(join(target.dir, 'registry.js'), join(dist.dir, 'linked-file.js'));
    symlinkSync(target.dir, join(dist.dir, 'linked-dir'));
    const clean = makeDist('no-links', BASE_FILES);
    const withLinks = computeExtensionIdentity([dist.module]);
    const withoutLinks = computeExtensionIdentity([clean.module]);
    expect(withLinks.tree.tree_hash).toBe(withoutLinks.tree.tree_hash);
    expect(withLinks.tree.file_count).toBe(4);
  });

  it('non-included extensions are ignored (.d.ts-style false drift excluded by extension list)', () => {
    const clean = makeDist('ext-clean', BASE_FILES);
    const noisy = makeDist('ext-noisy', {
      ...BASE_FILES,
      'notes.md': 'readme',
      'map.js.map': '{}',
    });
    // .md and .map are outside the included extension set; .js.map ends in .map.
    const a = computeExtensionIdentity([clean.module]);
    const b = computeExtensionIdentity([noisy.module]);
    expect(b.tree.tree_hash).toBe(a.tree.tree_hash);
  });

  it('caps → truncated:true with a DETERMINISTIC prefix (late-sorted files beyond the cap do not change the hash)', () => {
    const files: Record<string, string> = { 'registry.js': 'export default {};' };
    for (let i = 0; i < 2100; i++) {
      files[`f${String(i).padStart(4, '0')}.js`] = `export const v = ${i};`;
    }
    const dist = makeDist('capped', files);
    const first = computeExtensionIdentity([dist.module]);
    expect(first.tree.truncated).toBe(true);
    expect(first.tree.file_count).toBe(2000);

    const second = computeExtensionIdentity([dist.module]);
    expect(second.tree.tree_hash).toBe(first.tree.tree_hash);

    // 'zzz.js' sorts after the truncation point — the deterministic prefix is unchanged.
    writeFileSync(join(dist.dir, 'zzz.js'), 'export const z = 1;', 'utf8');
    const third = computeExtensionIdentity([dist.module]);
    expect(third.tree.truncated).toBe(true);
    expect(third.tree.tree_hash).toBe(first.tree.tree_hash);

    // A file INSIDE the prefix changes it.
    writeFileSync(join(dist.dir, 'f0000.js'), 'export const v = -1;', 'utf8');
    const fourth = computeExtensionIdentity([dist.module]);
    expect(fourth.tree.tree_hash).not.toBe(first.tree.tree_hash);
  });

  it('multiple modules: deduped sorted roots; per-module entry hashes and formats preserved', () => {
    const dist = makeDist('multi', {
      ...BASE_FILES,
      'second.cjs': 'module.exports = {};',
    });
    const identity = computeExtensionIdentity([
      dist.module,
      { declared: './second.cjs', resolved: join(dist.dir, 'second.cjs'), format: 'cjs' as never },
    ]);
    expect(identity.tree.roots).toEqual([dist.dir]); // deduped
    expect(identity.modules.map((m) => m.format)).toEqual(['esm', 'cjs']);
    expect(identity.modules[0]!.entry_hash).not.toBe(identity.modules[1]!.entry_hash);
  });

  it('ts-jiti format is preserved on the module record', () => {
    const dir = join(root, 'ts');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'registry.ts'), 'export default {};', 'utf8');
    const identity = computeExtensionIdentity([
      { declared: './registry.ts', resolved: join(dir, 'registry.ts'), format: 'ts-jiti' },
    ]);
    expect(identity.modules[0]!.format).toBe('ts-jiti');
  });
});

describe('computeExtensionIdentity — signals (labeled advisory, fail-soft)', () => {
  it('no trustRoot → no signals; trustRoot without package.json/.git → no signals, no throw', () => {
    const dist = makeDist('sig-none', BASE_FILES);
    const bare = computeExtensionIdentity([dist.module]);
    expect(bare.signals).toBeUndefined();
    const emptyRoot = join(root, 'empty-trust');
    mkdirSync(emptyRoot);
    const soft = computeExtensionIdentity([dist.module], { trustRoot: emptyRoot });
    expect(soft.signals).toBeUndefined();
  });

  it('package_version read from the trust root package.json', () => {
    const dist = makeDist('sig-pkg', BASE_FILES);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '3.1.4' }), 'utf8');
    const identity = computeExtensionIdentity([dist.module], { trustRoot: root });
    expect(identity.signals?.package_version).toBe('3.1.4');
  });

  it('git_head dereferences one ref file (and reads a detached HEAD directly); fail-soft on packed refs', () => {
    const dist = makeDist('sig-git', BASE_FILES);
    const gitDir = join(root, '.git');
    mkdirSync(join(gitDir, 'refs', 'heads'), { recursive: true });
    writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    writeFileSync(join(gitDir, 'refs', 'heads', 'main'), 'abc123def456\n', 'utf8');
    const viaRef = computeExtensionIdentity([dist.module], { trustRoot: root });
    expect(viaRef.signals?.git_head).toBe('abc123def456');

    writeFileSync(join(gitDir, 'HEAD'), 'deadbeefcafe\n', 'utf8'); // detached
    const detached = computeExtensionIdentity([dist.module], { trustRoot: root });
    expect(detached.signals?.git_head).toBe('deadbeefcafe');

    writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/gone\n', 'utf8'); // packed/missing ref
    const packed = computeExtensionIdentity([dist.module], { trustRoot: root });
    expect(packed.signals?.git_head).toBeUndefined(); // fail-soft, no throw
  });
});

describe('identityDiffers', () => {
  it('false for identical identities; true on tree, entry-hash, or override differences', () => {
    const dist = makeDist('diff', BASE_FILES);
    const a = computeExtensionIdentity([dist.module], { capturedAt: '2026-01-01T00:00:00Z' });
    const b = computeExtensionIdentity([dist.module], { capturedAt: '2026-02-02T00:00:00Z' });
    expect(identityDiffers(a, b)).toBe(false); // timestamps/pid never compared

    expect(identityDiffers(a, { ...b, override_active: true })).toBe(true);
    expect(identityDiffers(a, { ...b, tree: { ...b.tree, tree_hash: 'other' } })).toBe(true);
    expect(
      identityDiffers(a, {
        ...b,
        modules: [{ ...b.modules[0]!, entry_hash: 'other' }],
      }),
    ).toBe(true);
  });
});

describe('recomputeIdentity — strictly under the RECORDED rules', () => {
  it('unknown rules version → explicit cannot-compare, never a guess', () => {
    const dist = makeDist('rules', BASE_FILES);
    const entry = computeExtensionIdentity([dist.module]);
    const alien = { ...entry, tree: { ...entry.tree, rules: 'dir_tree_v9: from the future' } };
    const result = recomputeIdentity(alien);
    expect(result.comparable).toBe(false);
    if (!result.comparable) {
      expect(result.reason).toBe("cannot compare (unknown rules 'dir_tree_v9: from the future')");
    }
  });

  it('unchanged disk → all components same', () => {
    const dist = makeDist('same', BASE_FILES);
    const entry = computeExtensionIdentity([dist.module]);
    const result = recomputeIdentity(entry);
    expect(result.comparable).toBe(true);
    if (result.comparable) {
      expect(result.tree.current_hash).toBe(entry.tree.tree_hash);
      expect(result.modules[0]!.current_hash).toBe(entry.modules[0]!.entry_hash);
    }
  });

  it('changed file → tree differs; changed entry → module differs; deleted entry → missing', () => {
    const dist = makeDist('drift', BASE_FILES);
    const entry = computeExtensionIdentity([dist.module]);
    writeFileSync(join(dist.dir, 'handlers.js'), 'export const h = 99;', 'utf8');
    const treeDrift = recomputeIdentity(entry);
    expect(treeDrift.comparable && treeDrift.tree.current_hash !== entry.tree.tree_hash).toBe(true);

    writeFileSync(dist.entry, 'export default { changed: true };', 'utf8');
    const entryDrift = recomputeIdentity(entry);
    expect(
      entryDrift.comparable && entryDrift.modules[0]!.current_hash !== entry.modules[0]!.entry_hash,
    ).toBe(true);

    rmSync(dist.entry);
    const missing = recomputeIdentity(entry);
    expect(missing.comparable && missing.modules[0]!.current_hash === undefined).toBe(true);
  });
});

describe('errorExtensionIdentityEntry', () => {
  it('carries the error message, placeholder tree, and the override flag when set', () => {
    const entry = errorExtensionIdentityEntry('extension load failed: boom', {
      overrideActive: true,
    });
    expect(entry.error).toBe('extension load failed: boom');
    expect(entry.modules).toEqual([]);
    expect(entry.tree.tree_hash).toBe('');
    expect(entry.override_active).toBe(true);
    expect(entry.coverage).toBe('dir_tree_v1');
  });
});
