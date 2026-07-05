// Identity-capture failure must NEVER fail extension loading: the registry gets an entry
// with `error` set (the failure is itself a record) and the load succeeds. Isolated file —
// the identity module is mocked to throw for every compute.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CURRENT_WORKFLOW_SCHEMA_VERSION } from '@sensigo/realm';
import type { WorkflowDefinition } from '@sensigo/realm';

vi.mock('./extension-identity.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./extension-identity.js')>();
  return {
    ...mod,
    computeExtensionIdentity: vi.fn(() => {
      throw new Error('boom-identity-capture');
    }),
  };
});

// Imported AFTER the mock so the loader binds the throwing compute.
import { loadProjectExtensions, clearProjectExtensionsCache } from './load-project-extensions.js';

let root: string;
let workflowDir: string;

beforeEach(() => {
  clearProjectExtensionsCache();
  root = mkdtempSync(join(tmpdir(), 'realm-ident-fail-'));
  workflowDir = join(root, 'workflows', 'wf');
  mkdirSync(join(root, 'dist'), { recursive: true });
  mkdirSync(workflowDir, { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe('loader — identity capture failure is fail-soft', () => {
  it('load succeeds, registry carries an error identity entry, and stderr is not silent', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const moduleFile = join(root, 'dist', 'registry.js');
    writeFileSync(
      moduleFile,
      `export default { handlers: { h1: { id: 'h1', execute: async () => ({ data: {} }) } } };`,
      'utf8',
    );
    const definition: WorkflowDefinition = {
      id: 'ident-fail-wf',
      name: 'Identity Fail WF',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: { s1: { description: 'step', execution: 'agent' } },
      origin: 'human',
      extensions: ['../../dist/registry.js'],
      source_dir: workflowDir,
      trust_root: root,
    };

    const { registry, manifest } = await loadProjectExtensions(definition);
    // The load itself succeeded — extensions are usable.
    expect(registry.getHandler('h1')).toBeDefined();
    expect(manifest.handlers).toEqual(['h1']);
    // The capture failure is itself a record.
    expect(registry.identity).toBeDefined();
    expect(registry.identity!.error).toContain('identity capture failed: boom-identity-capture');
    expect(registry.identity!.modules).toEqual([]);
    // And it was logged, never silent.
    const logged = errSpy.mock.calls.flat().map(String).join(' ');
    expect(logged).toContain('extension identity capture failed');
  });
});
