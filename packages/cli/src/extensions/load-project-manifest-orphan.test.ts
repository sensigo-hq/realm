// Tests for the orphaned-manifest guard (#123): a realm.yaml in the span
// [source_dir, trust_root) is silently ignored by the strict-single-location loader, so
// the guard fails loud before run creation. Detection-only — LOADING stays strict.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CURRENT_WORKFLOW_SCHEMA_VERSION } from '@sensigo/realm';
import type { WorkflowDefinition } from '@sensigo/realm';
import { loadProjectExtensions, clearProjectExtensionsCache } from './load-project-extensions.js';

// Topology (everything under `base`, so cleanup is total):
//   base/                         ← "monorepo root" (Case-C's above-trust_root dir)
//   base/project/                 ← trust_root (has package.json)
//   base/project/workflows/       ← intermediate dir in the span
//   base/project/workflows/wf/    ← source_dir (workflow dir)
let base: string;
let root: string;
let intermediate: string;
let workflowDir: string;
let counter = 0;

beforeEach(() => {
  clearProjectExtensionsCache();
  base = mkdtempSync(join(tmpdir(), 'realm-orphan-'));
  root = join(base, 'project');
  intermediate = join(root, 'workflows');
  workflowDir = join(intermediate, 'wf');
  mkdirSync(workflowDir, { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const MINIMAL_MANIFEST = 'version: 1\nadapters:\n  fs2:\n    use: filesystem\n';

function writeManifest(dir: string): string {
  const path = join(dir, 'realm.yaml');
  writeFileSync(path, MINIMAL_MANIFEST, 'utf8');
  return path;
}

/** Definition anchored with an explicit source_dir/trust_root span (the file-loaded shape). */
function def(
  // issue #337: 2 call sites pass source_dir/trust_root explicitly `undefined` to ERASE the base
  // defaults below (simulating no anchoring span at all) — see the identical fold in
  // load-project-extensions.test.ts's makeDefinition for the full rationale.
  overrides: Partial<Omit<WorkflowDefinition, 'source_dir' | 'trust_root'>> & {
    source_dir?: string | undefined;
    trust_root?: string | undefined;
  } = {},
): WorkflowDefinition {
  const { source_dir: sourceDirOverride, trust_root: trustRootOverride, ...rest } = overrides;
  return {
    id: `wf-${counter++}`,
    name: 'Orphan WF',
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps: { s1: { description: 'step', execution: 'agent' } },
    origin: 'human',
    ...(sourceDirOverride !== undefined
      ? { source_dir: sourceDirOverride }
      : 'source_dir' in overrides
        ? {}
        : { source_dir: workflowDir }),
    ...(trustRootOverride !== undefined
      ? { trust_root: trustRootOverride }
      : 'trust_root' in overrides
        ? {}
        : { trust_root: root }),
    ...rest,
  };
}

describe('orphaned-manifest guard (#123)', () => {
  it('1. orphan at source_dir with a higher trust_root → throws, naming orphan + trust_root + fix', async () => {
    const orphan = writeManifest(workflowDir);
    const err = await loadProjectExtensions(def()).then(
      () => undefined,
      (e: Error) => e,
    );
    expect(err).toBeDefined();
    expect(err!.message).toContain(orphan);
    expect(err!.message).toContain(join(root, 'realm.yaml'));
    expect(err!.message).toContain('will NOT be loaded');
    expect(err!.message).toContain('Move it to');
  });

  it('2. orphan in an intermediate dir between source_dir and trust_root → throws (monorepo shape)', async () => {
    const orphan = writeManifest(intermediate);
    await expect(loadProjectExtensions(def())).rejects.toThrow(orphan);
  });

  it('3. correctly-placed <trust_root>/realm.yaml → loads, NO error', async () => {
    writeManifest(root);
    const { manifest } = await loadProjectExtensions(def());
    expect(manifest.adapters).toEqual(['fs2']); // proves the trust_root manifest loaded
  });

  it('4. correct manifest at trust_root AND a stray one below → still throws (stray not excused)', async () => {
    writeManifest(root);
    const stray = writeManifest(workflowDir);
    await expect(loadProjectExtensions(def())).rejects.toThrow(stray);
  });

  it('5. genuinely absent (no realm.yaml in span or at trust_root) → defaults, NO error', async () => {
    const { manifest, registry } = await loadProjectExtensions(def());
    expect(manifest.adapters).toEqual([]);
    expect(registry.getAdapter('filesystem')).toBeDefined(); // default registry only
  });

  it('6. trust_root === source_dir → loads, no orphan false-positive', async () => {
    // Workflow dir is its own deployment root (its own package.json).
    writeFileSync(join(workflowDir, 'package.json'), '{}', 'utf8');
    writeManifest(workflowDir);
    const { manifest } = await loadProjectExtensions(
      def({ source_dir: workflowDir, trust_root: workflowDir }),
    );
    expect(manifest.adapters).toEqual(['fs2']); // the workflow-dir manifest IS the loaded one
  });

  it('7. agent-origin / from-string definition (no source_dir) → guard is a no-op; --project still reaches the manifest', async () => {
    writeManifest(root);
    const agentDef = def({ source_dir: undefined, trust_root: undefined, origin: 'agent' });
    // No source_dir → no span → no error, and no manifest without --project.
    const bare = await loadProjectExtensions(agentDef);
    expect(bare.manifest.adapters).toEqual([]);
    // --project anchors the manifest explicitly, and the guard does not fire (no source_dir).
    const anchored = await loadProjectExtensions(agentDef, { projectDir: root });
    expect(anchored.manifest.adapters).toEqual(['fs2']);
  });

  it('8. Case C control: realm.yaml ABOVE trust_root + valid one AT trust_root → loads trust_root, no error on the one above', async () => {
    // A manifest above the trust root (the monorepo root `base`) must be IGNORED, not
    // errored — Case C is deliberately out of scope.
    writeManifest(base);
    writeManifest(root);
    const { manifest } = await loadProjectExtensions(def());
    expect(manifest.adapters).toEqual(['fs2']); // trust_root manifest, no throw
  });

  it('9. M1 regression — agent-origin (no source_dir) never scans, even with a stray manifest in the subtree', async () => {
    // A stray realm.yaml sits where a span scan would trip — but an agent-origin definition
    // has no source_dir, so the loader must never invoke the guard. Loads the --project
    // root manifest cleanly.
    writeManifest(root);
    writeManifest(workflowDir); // would be an orphan for a file-loaded def; ignored here
    const agentDef = def({ source_dir: undefined, trust_root: undefined, origin: 'agent' });
    const loaded = await loadProjectExtensions(agentDef, { projectDir: root });
    expect(loaded.manifest.adapters).toEqual(['fs2']); // no throw, root manifest loaded
  });
});
