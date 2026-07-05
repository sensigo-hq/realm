// Tests for loadProjectExtensions — resolution, containment, duck validation, collision
// policy, caching, and the operator override. Uses real module files in a tmp project tree
// (package.json at the trust root, workflow nested below — the bradley-max shape).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkflowDefinition } from '@sensigo/realm';
import { CURRENT_WORKFLOW_SCHEMA_VERSION } from '@sensigo/realm';
import {
  loadProjectExtensions,
  clearProjectExtensionsCache,
  makeRegistryProvider,
} from './load-project-extensions.js';

/** A declarative module contributing one adapter, one handler, one processor. */
const FULL_MODULE_SOURCE = `
const adapter = (id) => ({
  id,
  fetch: async () => ({ status: 200, data: { from: id } }),
  create: async () => ({ status: 201, data: {} }),
  update: async () => ({ status: 200, data: {} }),
});
export default {
  adapters: { gorgias_custom: adapter('gorgias_custom') },
  handlers: { check_offer_phrase: { id: 'check_offer_phrase', execute: async () => ({ data: { ok: true } }) } },
  processors: { normalize_offer: { id: 'normalize_offer', process: async (content) => content } },
};
`;

let root: string;
let workflowDir: string;
let distDir: string;
let moduleCounter = 0;

/** Writes a module under dist/ with a unique name (defeats Node's ESM cache across tests). */
function writeModule(source: string, dir: string = distDir): { file: string; declared: string } {
  const file = join(dir, `registry-${Date.now()}-${moduleCounter++}.js`);
  writeFileSync(file, source, 'utf8');
  return { file, declared: `../../dist/${file.split('/').pop()!}` };
}

function makeDefinition(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    id: 'ext-wf',
    name: 'Extensions WF',
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps: { s1: { description: 'step', execution: 'agent' } },
    origin: 'human',
    source_dir: workflowDir,
    trust_root: root,
    ...overrides,
  };
}

beforeEach(() => {
  clearProjectExtensionsCache();
  root = mkdtempSync(join(tmpdir(), 'realm-ext-loader-'));
  // bradley-max shape: package.json at project root; workflow nested two levels below;
  // compiled registry in <root>/dist — declared as ../../dist/registry.js.
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
  workflowDir = join(root, 'workflows', 'wf');
  distDir = join(root, 'dist');
  mkdirSync(workflowDir, { recursive: true });
  mkdirSync(distDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('loadProjectExtensions — fallback and happy path', () => {
  it('no extensions and no override → default registry + empty manifest', async () => {
    const { registry, manifest } = await loadProjectExtensions(
      makeDefinition({ source_dir: undefined, trust_root: undefined }),
    );
    expect(registry.getAdapter('filesystem')).toBeDefined();
    expect(registry.getAdapter('slack')).toBeDefined();
    expect(manifest).toEqual({ modules: [], adapters: [], handlers: [], processors: [] });
  });

  it('declarative export happy path: all three maps registered under their map keys (bradley-max ../../dist shape)', async () => {
    const { declared, file } = writeModule(FULL_MODULE_SOURCE);
    const definition = makeDefinition({ extensions: [declared] });
    const { registry, manifest } = await loadProjectExtensions(definition);

    expect(registry.getAdapter('gorgias_custom')).toBeDefined();
    expect(registry.getHandler('check_offer_phrase')).toBeDefined();
    expect(registry.getProcessor('normalize_offer')).toBeDefined();
    // Defaults are still present underneath.
    expect(registry.getAdapter('filesystem')).toBeDefined();

    expect(manifest.modules).toEqual([{ declared, resolved: realpathSync(file) }]);
    expect(manifest.adapters).toEqual(['gorgias_custom']);
    expect(manifest.handlers).toEqual(['check_offer_phrase']);
    expect(manifest.processors).toEqual(['normalize_offer']);
  });

  it('cache identity: repeated loads of the same modules return the identical registry instance', async () => {
    const { declared } = writeModule(FULL_MODULE_SOURCE);
    const definition = makeDefinition({ extensions: [declared] });
    const first = await loadProjectExtensions(definition);
    const second = await loadProjectExtensions(definition);
    expect(second.registry).toBe(first.registry);
    expect(second.manifest).toBe(first.manifest);
  });

  it('cache identity: the extension-less default registry is also process-stable', async () => {
    const def = makeDefinition({ source_dir: undefined, trust_root: undefined });
    const first = await loadProjectExtensions(def);
    const second = await loadProjectExtensions(def);
    expect(second.registry).toBe(first.registry);
  });
});

describe('loadProjectExtensions — trust model', () => {
  it('refuses agent-origin definitions carrying extensions', async () => {
    const { declared } = writeModule(FULL_MODULE_SOURCE);
    const definition = makeDefinition({ extensions: [declared], origin: 'agent' });
    await expect(loadProjectExtensions(definition)).rejects.toThrow(
      /origin: 'agent'.*operator-only/s,
    );
  });

  it('refuses definitions with extensions but no source_dir/trust_root, with re-register guidance', async () => {
    const definition = makeDefinition({
      extensions: ['./registry.js'],
      source_dir: undefined,
      trust_root: undefined,
    });
    await expect(loadProjectExtensions(definition)).rejects.toThrow(/[Rr]e-register this workflow/);
  });

  it('refuses a declared path escaping the trust root, naming both paths', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'realm-ext-outside-'));
    try {
      const escapeFile = join(outside, 'x.js');
      writeFileSync(escapeFile, 'export default {};', 'utf8');
      // Declared relative path escaping the trust root: source_dir/../../../<outside>/x.js
      const depth = workflowDir.split('/').length;
      const declared = '../'.repeat(depth) + escapeFile.replace(/^\//, '');
      const definition = makeDefinition({ extensions: [declared] });
      const err = await loadProjectExtensions(definition).then(
        () => undefined,
        (e: Error) => e,
      );
      expect(err).toBeDefined();
      expect(err!.message).toContain('OUTSIDE');
      expect(err!.message).toContain(realpathSync(escapeFile));
      expect(err!.message).toContain(realpathSync(root));
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('refuses a symlink inside the trust root whose realpath escapes it', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'realm-ext-symlink-'));
    try {
      const target = join(outside, 'escape.js');
      writeFileSync(target, 'export default {};', 'utf8');
      symlinkSync(target, join(distDir, 'escape-link.js'));
      const definition = makeDefinition({ extensions: ['../../dist/escape-link.js'] });
      await expect(loadProjectExtensions(definition)).rejects.toThrow(/OUTSIDE/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('errors actionably on a missing module file', async () => {
    const definition = makeDefinition({ extensions: ['../../dist/does-not-exist.js'] });
    await expect(loadProjectExtensions(definition)).rejects.toThrow(
      /Cannot resolve extension module '\.\.\/\.\.\/dist\/does-not-exist\.js'/,
    );
  });

  it('errors actionably when a .ts module is declared and jiti is absent', async () => {
    const tsFile = join(distDir, 'registry.ts');
    writeFileSync(tsFile, 'export default {};', 'utf8');
    const definition = makeDefinition({ extensions: ['../../dist/registry.ts'] });
    await expect(loadProjectExtensions(definition)).rejects.toThrow(
      /jiti' is not installed in your project.*compile the module to JS/s,
    );
  });
});

describe('loadProjectExtensions — duck validation', () => {
  async function expectRejection(moduleSource: string, pattern: RegExp): Promise<void> {
    const { declared } = writeModule(moduleSource);
    const definition = makeDefinition({ extensions: [declared] });
    await expect(loadProjectExtensions(definition)).rejects.toThrow(pattern);
  }

  it('rejects a module with no default export', async () => {
    await expectRejection(`export const adapters = {};`, /no default export/);
  });

  it('rejects a non-object default export', async () => {
    await expectRejection(`export default 42;`, /must be a plain object/);
  });

  it('rejects a registry-instance-like default export', async () => {
    await expectRejection(
      `export default { register() {}, getAdapter() {} };`,
      /looks like an ExtensionRegistry instance/,
    );
  });

  it('rejects unknown top-level keys (typo protection)', async () => {
    await expectRejection(`export default { handler: {} };`, /unknown key 'handler'/);
  });

  it('rejects an adapter missing its request entrypoints', async () => {
    await expectRejection(
      `export default { adapters: { broken: { id: 'broken', fetch: async () => ({}) } } };`,
      /missing callable 'create'.*ServiceAdapter/s,
    );
  });

  it('rejects a handler whose execute is not callable', async () => {
    await expectRejection(
      `export default { handlers: { broken: { id: 'broken', execute: 'not-a-fn' } } };`,
      /missing callable 'execute'.*StepHandler/s,
    );
  });

  it('rejects a processor without process()', async () => {
    await expectRejection(
      `export default { processors: { broken: { id: 'broken' } } };`,
      /missing callable 'process'.*Processor/s,
    );
  });

  it('a throwing getter produces a clean validation error, not a crash', async () => {
    await expectRejection(
      `export default { adapters: { boom: { id: 'boom', get fetch() { throw new Error('trap'); } } } };`,
      /reading 'fetch' threw: trap/,
    );
  });

  it('WARNs when the instance id differs from the registration map key (evidence prints ids)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { declared } = writeModule(`
export default { handlers: { key_name: { id: 'other_id', execute: async () => ({ data: {} }) } } };
`);
    await loadProjectExtensions(makeDefinition({ extensions: [declared] }));
    const messages = warn.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes("'key_name'") && m.includes("'other_id'"))).toBe(true);
  });
});

describe('loadProjectExtensions — collision policy', () => {
  it('overriding a BUILT-IN name WARNs and allows', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { declared } = writeModule(`
export default { adapters: { filesystem: {
  id: 'filesystem',
  fetch: async () => ({ status: 200, data: { custom: true } }),
  create: async () => ({ status: 201, data: {} }),
  update: async () => ({ status: 200, data: {} }),
} } };
`);
    const { registry } = await loadProjectExtensions(makeDefinition({ extensions: [declared] }));
    const messages = warn.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes("overrides the built-in adapter 'filesystem'"))).toBe(
      true,
    );
    const response = await registry.getAdapter('filesystem')!.fetch('op', {}, {});
    expect(response.data).toEqual({ custom: true });
  });

  it('the same name claimed by two declared modules is an ERROR', async () => {
    const handlerModule = `export default { handlers: { dup_handler: { id: 'dup_handler', execute: async () => ({ data: {} }) } } };`;
    const a = writeModule(handlerModule);
    const b = writeModule(handlerModule);
    const definition = makeDefinition({ extensions: [a.declared, b.declared] });
    await expect(loadProjectExtensions(definition)).rejects.toThrow(
      /dup_handler.*declared by both.*unique across declared modules/s,
    );
  });
});

describe('loadProjectExtensions — override module', () => {
  it('--extensions-module REPLACES declared modules and logs loudly', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const declaredModule = writeModule(
      `export default { handlers: { declared_handler: { id: 'declared_handler', execute: async () => ({ data: {} }) } } };`,
    );
    const overrideModule = writeModule(
      `export default { handlers: { override_handler: { id: 'override_handler', execute: async () => ({ data: {} }) } } };`,
    );
    const definition = makeDefinition({ extensions: [declaredModule.declared] });
    const { registry, manifest } = await loadProjectExtensions(definition, {
      overrideModule: overrideModule.file,
    });
    expect(registry.getHandler('override_handler')).toBeDefined();
    expect(registry.getHandler('declared_handler')).toBeUndefined();
    expect(manifest.handlers).toEqual(['override_handler']);
    const messages = warn.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes('--extensions-module override active'))).toBe(true);
  });

  it('override works for definitions with no declared extensions and no resolution metadata', async () => {
    const overrideModule = writeModule(
      `export default { adapters: { solo: {
        id: 'solo',
        fetch: async () => ({ status: 200, data: {} }),
        create: async () => ({ status: 201, data: {} }),
        update: async () => ({ status: 200, data: {} }),
      } } };`,
    );
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const definition = makeDefinition({ source_dir: undefined, trust_root: undefined });
    const { registry } = await loadProjectExtensions(definition, {
      overrideModule: overrideModule.file,
    });
    expect(registry.getAdapter('solo')).toBeDefined();
  });
});

describe('makeRegistryProvider', () => {
  it('resolves each definition through the loader (extension entries present)', async () => {
    const { declared } = writeModule(FULL_MODULE_SOURCE);
    const provider = makeRegistryProvider();
    const registry = await provider(makeDefinition({ extensions: [declared] }));
    expect(registry.getAdapter('gorgias_custom')).toBeDefined();
    expect(registry.getHandler('check_offer_phrase')).toBeDefined();
  });

  it('returns the extension-less default registry for extension-free definitions', async () => {
    const provider = makeRegistryProvider();
    const registry = await provider(
      makeDefinition({ source_dir: undefined, trust_root: undefined }),
    );
    expect(registry.getAdapter('filesystem')).toBeDefined();
    expect(registry.names('handler')).toEqual([]);
  });

  it('propagates loader errors (broken module rejects the provider call)', async () => {
    const { declared } = writeModule(`export default { handler: {} };`);
    const provider = makeRegistryProvider();
    await expect(provider(makeDefinition({ extensions: [declared] }))).rejects.toThrow(
      /unknown key 'handler'/,
    );
  });

  it('honors the override module (declared modules replaced)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const declaredModule = writeModule(
      `export default { handlers: { declared_h: { id: 'declared_h', execute: async () => ({ data: {} }) } } };`,
    );
    const overrideModule = writeModule(
      `export default { handlers: { override_h: { id: 'override_h', execute: async () => ({ data: {} }) } } };`,
    );
    const provider = makeRegistryProvider(overrideModule.file);
    const registry = await provider(makeDefinition({ extensions: [declaredModule.declared] }));
    expect(registry.getHandler('override_h')).toBeDefined();
    expect(registry.getHandler('declared_h')).toBeUndefined();
  });

  it('hits the process-lifetime cache — repeated calls return the identical registry instance', async () => {
    const { declared } = writeModule(FULL_MODULE_SOURCE);
    const provider = makeRegistryProvider();
    const definition = makeDefinition({ extensions: [declared] });
    const first = await provider(definition);
    const second = await provider(definition);
    expect(second).toBe(first);
  });
});

describe('loadProjectExtensions — drift-evidence identity capture', () => {
  it('attaches a dir_tree_v1 identity to the registry (modules, tree, trust-root signals)', async () => {
    const { declared, file } = writeModule(FULL_MODULE_SOURCE);
    const definition = makeDefinition({ extensions: [declared] });
    const { registry } = await loadProjectExtensions(definition);
    const identity = registry.identity;
    expect(identity).toBeDefined();
    expect(identity!.coverage).toBe('dir_tree_v1');
    expect(identity!.modules).toHaveLength(1);
    expect(identity!.modules[0]!.declared).toBe(declared);
    expect(identity!.modules[0]!.resolved).toBe(realpathSync(file));
    expect(identity!.modules[0]!.entry_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(identity!.tree.tree_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(identity!.override_active).toBeUndefined();
    expect(identity!.error).toBeUndefined();
  });

  it('identity is computed ONCE per cache entry — a cache hit returns the same entry object', async () => {
    const { declared } = writeModule(FULL_MODULE_SOURCE);
    const definition = makeDefinition({ extensions: [declared] });
    const first = await loadProjectExtensions(definition);
    const second = await loadProjectExtensions(definition);
    expect(second.registry.identity).toBeDefined();
    expect(second.registry.identity).toBe(first.registry.identity);
  });

  it('clone() carries the identity through tier composition', async () => {
    const { declared } = writeModule(FULL_MODULE_SOURCE);
    const { registry } = await loadProjectExtensions(makeDefinition({ extensions: [declared] }));
    expect(registry.clone().identity).toBe(registry.identity);
  });

  it('override runs are flagged override_active', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const overrideModule = writeModule(FULL_MODULE_SOURCE);
    const definition = makeDefinition({ source_dir: undefined, trust_root: undefined });
    const { registry } = await loadProjectExtensions(definition, {
      overrideModule: overrideModule.file,
    });
    expect(registry.identity?.override_active).toBe(true);
  });

  it('the extension-less sentinel gets NO identity (extension-free runs record nothing)', async () => {
    const definition = makeDefinition({ source_dir: undefined, trust_root: undefined });
    const { registry } = await loadProjectExtensions(definition);
    expect(registry.identity).toBeUndefined();
  });
});
