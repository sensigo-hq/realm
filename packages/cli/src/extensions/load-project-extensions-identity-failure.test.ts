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
import { computeExtensionIdentity } from './extension-identity.js';

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

describe('#729 PR-3 correction 1 (F3, D-9) — the failure is masked at its source', () => {
  it('the stored error and the printed line hide an environment value and a Bearer token', async () => {
    const ENV_CANARY = 'FAKECANENVLOAD0729';
    const BEARER_CANARY = 'FAKECANANCHLOAD0729';
    vi.stubEnv('REALM_NOT_SECRET', '');
    vi.stubEnv('IDENT_FAIL_CANARY', ENV_CANARY);
    vi.mocked(computeExtensionIdentity).mockImplementationOnce(() => {
      throw new Error(`cannot read ${ENV_CANARY}/x, sent Bearer ${BEARER_CANARY}`);
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    writeFileSync(
      join(root, 'dist', 'registry.js'),
      `export default { handlers: { h1: { id: 'h1', execute: async () => ({ data: {} }) } } };`,
      'utf8',
    );
    const { registry } = await loadProjectExtensions({
      id: 'ident-mask-wf',
      name: 'Identity Mask WF',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: { s1: { description: 'step', execution: 'agent' } },
      origin: 'human',
      extensions: ['../../dist/registry.js'],
      source_dir: workflowDir,
      trust_root: root,
    } as WorkflowDefinition);
    const logged = errSpy.mock.calls.flat().map(String).join(' ');
    vi.unstubAllEnvs();
    // (a) red when the failure's text is stored or printed as it was (the environment value and
    //     the token show); (b) prints the stored error (fake values masked) and two booleans.
    expect({
      stored: registry.identity?.error,
      loggedShows: logged.includes(ENV_CANARY) || logged.includes(BEARER_CANARY),
      loggedSays: logged.includes('extension identity capture failed'),
    }).toEqual({
      stored: 'identity capture failed: cannot read [REDACTED]/x, sent Bearer [REDACTED]',
      loggedShows: false,
      loggedSays: true,
    });
  });
});

// F2 (B2): the identity-capture failure is masked with a set that passes the working directory.
describe('F2 — the working directory (B2, load-project-extensions :540, identity capture)', () => {
  it('the stored error shows a path under the working directory whole', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    try {
      vi.stubEnv('REALM_NOT_SECRET', '');
      vi.stubEnv('INIT_CWD', root);
      vi.stubEnv('npm_config_local_prefix', root);
      vi.mocked(computeExtensionIdentity).mockImplementationOnce(() => {
        throw new Error(`cannot read ${root}/dist/registry.js`);
      });
      vi.spyOn(console, 'error').mockImplementation(() => {});
      writeFileSync(
        join(root, 'dist', 'registry.js'),
        `export default { handlers: { h1: { id: 'h1', execute: async () => ({ data: {} }) } } };`,
        'utf8',
      );
      const { registry } = await loadProjectExtensions({
        id: 'ident-fail-f2',
        name: 'Identity Fail F2',
        version: 1,
        schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
        steps: { s1: { description: 'step', execution: 'agent' } },
        origin: 'human',
        extensions: ['../../dist/registry.js'],
        source_dir: workflowDir,
        trust_root: root,
      });
      // (a) red when the identity-failure set is built without `cwd` (the path reads
      //     [REDACTED]/dist/registry.js); (b) prints the stored error (paths under the temp folder).
      expect(registry.identity!.error).toBe(
        `identity capture failed: cannot read ${root}/dist/registry.js`,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
