// Tests for the deployment-manifest side of the project loader (v0.14): anchors, catalog
// vs module refs, factory contract, secrets wiring, collisions, containment, cache +
// hot rotation, drift integration, notifiers, and the consumer-shape E2E fixture.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CURRENT_WORKFLOW_SCHEMA_VERSION, loadWorkflowFromFile } from '@sensigo/realm';
import type { WorkflowDefinition } from '@sensigo/realm';
import {
  loadProjectExtensions,
  makeRegistryProvider,
  clearProjectExtensionsCache,
} from './load-project-extensions.js';
import { loadWorkflowForRegistration } from '../commands/register.js';

let root: string;
let counter = 0;

beforeEach(() => {
  clearProjectExtensionsCache();
  root = mkdtempSync(join(tmpdir(), 'realm-manifest-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
  mkdirSync(join(root, 'dist'), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function writeManifest(yaml: string, dir: string = root): string {
  const path = join(dir, 'realm.yaml');
  writeFileSync(path, yaml, 'utf8');
  return path;
}

function writeEnv(content: string, dir: string = root): void {
  writeFileSync(join(dir, '.env'), content, 'utf8');
}

/** A factory module exposing adapter + handler factories and a broken export. */
function writeFactoryModule(): string {
  const name = `factories-${counter++}.js`;
  writeFileSync(
    join(root, 'dist', name),
    `
export function adapterFactory({ id, config }) {
  return {
    id,
    receivedConfig: config,
    fetch: async () => ({ status: 200, data: { token: config.token } }),
    create: async () => ({ status: 201, data: {} }),
    update: async () => ({ status: 200, data: {} }),
  };
}
export function handlerFactory({ id, config }) {
  return { id, execute: async () => ({ data: { key: config.api_key } }) };
}
export function throwingFactory({ id, config }) {
  throw new Error('bad credentials: ' + config.token);
}
export const notAFactory = 42;
export default function defaultFactory({ id }) {
  return {
    id,
    fetch: async () => ({ status: 200, data: { via: 'default' } }),
    create: async () => ({ status: 201, data: {} }),
    update: async () => ({ status: 200, data: {} }),
  };
}
`,
    'utf8',
  );
  return `./dist/${name}`;
}

/** Definition anchored at the tmp root (trust_root present, like a registered workflow). */
function anchoredDefinition(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    id: `wf-${counter++}`,
    name: 'Manifest WF',
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps: { s1: { description: 'step', execution: 'agent' } },
    origin: 'human',
    source_dir: root,
    trust_root: root,
    ...overrides,
  };
}

/** Agent-origin definition (no trust_root) — anchors at the daemon's --project root. */
function agentOriginDefinition(): WorkflowDefinition {
  return {
    id: `dyn-${counter++}`,
    name: 'Dynamic WF',
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps: { s1: { description: 'step', execution: 'agent' } },
    origin: 'agent',
  };
}

describe('anchors', () => {
  it('trust_root definitions load <trust_root>/realm.yaml', async () => {
    writeEnv('GITHUB_TOKEN=ghp_real_token_value\n');
    writeManifest(
      `version: 1\nadapters:\n  github:\n    use: github\n    config: { auth: { token: "\${secret:GITHUB_TOKEN}" } }\n`,
    );
    const { registry, manifest } = await loadProjectExtensions(anchoredDefinition());
    expect(registry.getAdapter('github')).toBeDefined();
    expect(manifest.adapters).toEqual(['github']);
  });

  it('absent manifest = defaults only (no walking, no error)', async () => {
    const { registry, manifest } = await loadProjectExtensions(anchoredDefinition());
    expect(registry.getAdapter('filesystem')).toBeDefined();
    expect(manifest.adapters).toEqual([]);
  });

  it('agent-origin definitions use the DAEMON anchor (--project) only', async () => {
    writeManifest(`version: 1\nadapters:\n  fs2:\n    use: filesystem\n`);
    // Without projectDir: no manifest — defaults only.
    const bare = await loadProjectExtensions(agentOriginDefinition());
    expect(bare.registry.getAdapter('fs2')).toBeUndefined();
    // With projectDir: the daemon root's manifest applies.
    const anchored = await loadProjectExtensions(agentOriginDefinition(), { projectDir: root });
    expect(anchored.registry.getAdapter('fs2')).toBeDefined();
  });

  it('mcp refusal: makeRegistryProvider WITHOUT projectDir never loads the manifest for anchor-less definitions — even when the process cwd HAS one', async () => {
    writeManifest(`version: 1\nadapters:\n  fs2:\n    use: filesystem\n`);
    // Simulate the mcp threat model: the client-controlled cwd contains a realm.yaml.
    const previousCwd = process.cwd();
    process.chdir(root);
    try {
      const noProject = makeRegistryProvider(undefined, undefined);
      const registry = await noProject(agentOriginDefinition());
      expect(registry.getAdapter('fs2')).toBeUndefined();
    } finally {
      process.chdir(previousCwd);
    }
    const withProject = makeRegistryProvider(undefined, root);
    const registry2 = await withProject(agentOriginDefinition());
    expect(registry2.getAdapter('fs2')).toBeDefined();
  });
});

describe('catalog vs module refs', () => {
  it('unknown catalog name → error listing valid names + version', async () => {
    writeManifest(`version: 1\nadapters:\n  x:\n    use: githab\n`);
    await expect(loadProjectExtensions(anchoredDefinition())).rejects.toThrow(
      /unknown catalog adapter 'githab'.*Valid catalog names \(realm v.*github.*filesystem/s,
    );
  });

  it('config on a config-less catalog adapter → error', async () => {
    writeManifest(`version: 1\nadapters:\n  fs2:\n    use: filesystem\n    config: { a: 1 }\n`);
    await expect(loadProjectExtensions(anchoredDefinition())).rejects.toThrow(
      /catalog adapter 'filesystem' takes no config/,
    );
  });

  it('handlers have no catalog — bare names error with module-ref guidance', async () => {
    writeManifest(`version: 1\nhandlers:\n  h:\n    use: github\n`);
    await expect(loadProjectExtensions(anchoredDefinition())).rejects.toThrow(
      /no built-in catalog for handlers; use a module reference/,
    );
  });

  it('module ref with #Export constructs via the factory contract (adapter + handler)', async () => {
    const mod = writeFactoryModule();
    writeEnv('TOK=real-token-1234\nKEY=real-key-5678\n');
    writeManifest(
      `version: 1
adapters:
  my_adapter:
    use: ${mod}#adapterFactory
    config: { token: "\${secret:TOK}" }
handlers:
  my_handler:
    use: ${mod}#handlerFactory
    config: { api_key: "\${secret:KEY}" }
`,
    );
    const { registry, manifest } = await loadProjectExtensions(anchoredDefinition());
    const adapter = registry.getAdapter('my_adapter')!;
    expect((await adapter.fetch('op', {}, {})).data).toEqual({ token: 'real-token-1234' });
    const handler = registry.getHandler('my_handler')!;
    const result = await handler.execute(
      { params: {} },
      { run_id: 'r', run_params: {}, config: {} },
    );
    expect(result.data).toEqual({ key: 'real-key-5678' });
    expect(manifest.secret_bearing_handlers).toEqual(['my_handler']);
  });

  it('module ref without # uses the default export', async () => {
    const mod = writeFactoryModule();
    writeManifest(`version: 1\nadapters:\n  d:\n    use: ${mod}\n`);
    const { registry } = await loadProjectExtensions(anchoredDefinition());
    expect((await registry.getAdapter('d')!.fetch('op', {}, {})).data).toEqual({
      via: 'default',
    });
  });

  it('missing export → error naming available exports', async () => {
    const mod = writeFactoryModule();
    writeManifest(`version: 1\nadapters:\n  x:\n    use: ${mod}#nope\n`);
    await expect(loadProjectExtensions(anchoredDefinition())).rejects.toThrow(
      /no export 'nope'.*Available exports:.*adapterFactory/s,
    );
  });

  it('a non-function export → factory-contract error', async () => {
    const mod = writeFactoryModule();
    writeManifest(`version: 1\nadapters:\n  x:\n    use: ${mod}#notAFactory\n`);
    await expect(loadProjectExtensions(anchoredDefinition())).rejects.toThrow(
      /must export a FACTORY/,
    );
  });

  it('manifest-dir-relative refs escaping the deployment root are refused', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'realm-manifest-escape-'));
    try {
      writeFileSync(join(outside, 'x.js'), 'export default () => ({});', 'utf8');
      const depth = root.split('/').length;
      const escape = '../'.repeat(depth) + join(outside, 'x.js').replace(/^\//, '');
      writeManifest(`version: 1\nadapters:\n  x:\n    use: ${escape}\n`);
      await expect(loadProjectExtensions(anchoredDefinition())).rejects.toThrow(
        /OUTSIDE the deployment root/,
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('manifest names and code-module exports share one namespace (duplicate = ERROR)', async () => {
    // Code module exports handler 'dup'; manifest also declares handler 'dup'.
    const codeModule = join(root, 'dist', `code-${counter++}.js`);
    writeFileSync(
      codeModule,
      `export default { handlers: { dup: { id: 'dup', execute: async () => ({ data: {} }) } } };`,
      'utf8',
    );
    const mod = writeFactoryModule();
    writeManifest(`version: 1\nhandlers:\n  dup:\n    use: ${mod}#handlerFactory\n`);
    const definition = anchoredDefinition({
      extensions: [`./dist/${codeModule.split('/').pop()!}`],
    });
    await expect(loadProjectExtensions(definition)).rejects.toThrow(
      /handler 'dup' is declared by both .* and the deployment manifest/,
    );
  });

  it('overriding a default-registry name from the manifest WARNs and applies', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mod = writeFactoryModule();
    writeManifest(`version: 1\nadapters:\n  filesystem:\n    use: ${mod}#adapterFactory\n`);
    const { registry } = await loadProjectExtensions(anchoredDefinition());
    expect((await registry.getAdapter('filesystem')!.fetch('op', {}, {})).status).toBe(200);
    expect(warn.mock.calls.flat().join(' ')).toContain(
      "overrides the built-in adapter 'filesystem'",
    );
  });
});

describe('secrets wiring, redaction, sentinel', () => {
  it('real mode: unresolved refs fail before construction with the aggregated error', async () => {
    writeManifest(
      `version: 1\nadapters:\n  github:\n    use: github\n    config: { auth: { token: "\${secret:NOPE_TOKEN}" } }\n`,
    );
    await expect(loadProjectExtensions(anchoredDefinition())).rejects.toThrow(
      /unresolved secret reference.*adapters\.github\.config\.auth\.token/s,
    );
  });

  it('constructor throws are wrapped with manifest context and REDACTED', async () => {
    const mod = writeFactoryModule();
    writeEnv('TOK=super-secret-value-9999\n');
    writeManifest(
      `version: 1\nadapters:\n  boom:\n    use: ${mod}#throwingFactory\n    config: { token: "\${secret:TOK}" }\n`,
    );
    let error: Error | undefined;
    try {
      await loadProjectExtensions(anchoredDefinition());
    } catch (err) {
      error = err as Error;
    }
    expect(error).toBeDefined();
    expect(error!.message).toContain('constructing adapters.boom');
    expect(error!.message).toContain('[redacted]');
    expect(error!.message).not.toContain('super-secret-value-9999');
  });

  it('sentinel mode: refs resolve to labels; construction failures downgrade to warnings (entry skipped)', async () => {
    const mod = writeFactoryModule();
    writeManifest(
      `version: 1
adapters:
  ok:
    use: ${mod}#adapterFactory
    config: { token: "\${secret:MISSING_EVERYWHERE}" }
  boom:
    use: ${mod}#throwingFactory
    config: { token: "\${secret:MISSING_EVERYWHERE}" }
`,
    );
    const loaded = await loadProjectExtensions(anchoredDefinition(), { secretMode: 'sentinel' });
    const adapter = loaded.registry.getAdapter('ok')!;
    expect((await adapter.fetch('op', {}, {})).data).toEqual({
      token: '<sentinel:MISSING_EVERYWHERE>',
    });
    expect(loaded.registry.getAdapter('boom')).toBeUndefined();
    expect(loaded.sentinelWarnings?.join(' ')).toContain('boom');
    expect(loaded.sentinelWarnings?.join(' ')).toContain('sentinel mode — entry skipped');
  });
});

describe('notifiers', () => {
  it('slack_gate config is secret-resolved and returned', async () => {
    writeEnv('HOOK=https://hooks.example/xyz9\n');
    writeManifest(
      `version: 1
notifiers:
  slack_gate:
    type: slack
    config:
      webhook_url: "\${secret:HOOK}"
      channel_id: C0FIXED
`,
    );
    const loaded = await loadProjectExtensions(anchoredDefinition());
    expect(loaded.notifiers?.slack_gate).toEqual({
      webhook_url: 'https://hooks.example/xyz9',
      channel_id: 'C0FIXED',
    });
  });
});

describe('cache + hot rotation', () => {
  it('nested roots with the same module realpath never share entries (realpathed key includes root)', async () => {
    const inner = join(root, 'packages', 'app');
    mkdirSync(inner, { recursive: true });
    writeFileSync(join(inner, 'package.json'), '{}', 'utf8');
    writeEnv('TOK=outer-token-1234\n');
    writeFileSync(join(inner, '.env'), 'TOK=inner-token-5678\n', 'utf8');
    const manifestYaml = `version: 1\nadapters:\n  github:\n    use: github\n    config: { auth: { token: "\${secret:TOK}" } }\n`;
    writeManifest(manifestYaml);
    writeManifest(manifestYaml, inner);

    const outer = await loadProjectExtensions(anchoredDefinition());
    const innerLoaded = await loadProjectExtensions(
      anchoredDefinition({ source_dir: inner, trust_root: inner }),
    );
    expect(innerLoaded.registry).not.toBe(outer.registry);
  });

  it('dotenv rotation reaches the next load without restart, mints ZERO drift entries, and resets limiter buckets', async () => {
    const mod = writeFactoryModule();
    writeEnv('TOK=first-token-1111\n');
    writeManifest(
      `version: 1\nadapters:\n  my_adapter:\n    use: ${mod}#adapterFactory\n    config: { token: "\${secret:TOK}" }\n`,
    );
    const definition = anchoredDefinition();
    const first = await loadProjectExtensions(definition);
    expect((await first.registry.getAdapter('my_adapter')!.fetch('op', {}, {})).data).toEqual({
      token: 'first-token-1111',
    });
    const firstLimiter = first.registry.getOrCreateRateLimiter('svc', {
      requests_per_second: 5,
    });

    // Rotate the secret VALUE only.
    writeEnv('TOK=second-token-2222\n');
    const second = await loadProjectExtensions(definition);
    expect(second.registry).not.toBe(first.registry); // rebuilt-and-replaced
    expect((await second.registry.getAdapter('my_adapter')!.fetch('op', {}, {})).data).toEqual({
      token: 'second-token-2222',
    });
    // Limiter buckets reset with the new registry (documented).
    const secondLimiter = second.registry.getOrCreateRateLimiter('svc', {
      requests_per_second: 5,
    });
    expect(secondLimiter).not.toBe(firstLimiter);
    // ZERO drift: identity (manifest hash + modules + tree) is unchanged by rotation.
    expect(second.registry.identity).toBeDefined();
    expect(JSON.stringify({ ...second.registry.identity, captured_at: '', pid: 0 })).toBe(
      JSON.stringify({ ...first.registry.identity, captured_at: '', pid: 0 }),
    );
  });

  it('a manifest EDIT rebuilds and changes the identity (drift entry material)', async () => {
    writeEnv('TOK=token-value-1234\n');
    writeManifest(
      `version: 1\nadapters:\n  github:\n    use: github\n    config: { auth: { token: "\${secret:TOK}" } }\n`,
    );
    const definition = anchoredDefinition();
    const first = await loadProjectExtensions(definition);
    writeManifest(
      `version: 1\nadapters:\n  github:\n    use: github\n    config: { auth: { token: "\${secret:TOK}" }, base_url: "https://other.example" }\n`,
    );
    const second = await loadProjectExtensions(definition);
    expect(second.registry).not.toBe(first.registry);
    expect(second.registry.identity!.manifest!.content_hash).not.toBe(
      first.registry.identity!.manifest!.content_hash,
    );
  });

  it('unchanged manifest+dotenv → cache hit (same registry instance)', async () => {
    writeManifest(`version: 1\nadapters:\n  fs2:\n    use: filesystem\n`);
    const definition = anchoredDefinition();
    const first = await loadProjectExtensions(definition);
    const second = await loadProjectExtensions(definition);
    expect(second.registry).toBe(first.registry);
  });
});

describe('drift integration', () => {
  it('identity records manifest {path, content_hash} + sorted secret_names; use:-modules contribute; freshness never recorded', async () => {
    const mod = writeFactoryModule();
    writeEnv('B_TOK=bbbb-1234\nA_TOK=aaaa-1234\n');
    writeManifest(
      `version: 1
adapters:
  a1:
    use: ${mod}#adapterFactory
    config: { token: "\${secret:B_TOK}", second: "\${secret:A_TOK}" }
`,
    );
    const { registry } = await loadProjectExtensions(anchoredDefinition());
    const identity = registry.identity!;
    expect(identity.manifest?.path).toBe(join(root, 'realm.yaml'));
    expect(identity.manifest?.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(identity.secret_names).toEqual(['A_TOK', 'B_TOK']); // names only, sorted
    // use:-resolved module contributes like an extension-list module (sweep root + hash).
    expect(identity.modules.some((m) => m.resolved.endsWith(mod.split('/').pop()!))).toBe(true);
    expect(identity.tree.roots.some((r) => r === join(root, 'dist'))).toBe(true);
    // Secret VALUES and the freshness hash never appear anywhere in the record.
    const json = JSON.stringify(identity);
    expect(json).not.toContain('bbbb-1234');
    expect(json).not.toContain('aaaa-1234');
    expect(json).not.toContain('freshness');
  });
});

describe('consumer-shape E2E (bradley-max layout: workflows/* + dist + realm.yaml + .env)', () => {
  it('validate(sentinel) → register(degrade or real) → run-shape load(real) with manifest-bound config', async () => {
    // Project tree.
    const workflowDir = join(root, 'workflows', 'offers');
    mkdirSync(workflowDir, { recursive: true });
    const mod = writeFactoryModule();
    writeManifest(
      `version: 1
handlers:
  record_offer:
    use: ${mod}#handlerFactory
    config: { api_key: "\${secret:AIRTABLE_PAT}" }
`,
    );
    const workflowYaml = `
id: offers-wf
name: Offers WF
version: 1
steps:
  record:
    description: record the offer
    execution: auto
    handler: record_offer
`;
    const workflowPath = join(workflowDir, 'workflow.yaml');
    writeFileSync(workflowPath, workflowYaml, 'utf8');

    // 1. Register with NO .env yet → degrade-with-WARN to sentinel (provisioning flow).
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const definition = await loadWorkflowForRegistration(workflowPath);
    expect(definition.trust_root).toBe(root);
    expect(warn.mock.calls.flat().join(' ')).toContain('SENTINEL');
    warn.mockRestore();
    clearProjectExtensionsCache();

    // 2. Provision the secret; execution-path load (real mode) binds the real value.
    writeEnv('AIRTABLE_PAT=patREALVALUE123\n');
    const loaded = await loadProjectExtensions(definition);
    const handler = loaded.registry.getHandler('record_offer')!;
    const result = await handler.execute(
      { params: {} },
      { run_id: 'r', run_params: {}, config: {} },
    );
    expect(result.data).toEqual({ key: 'patREALVALUE123' });
    expect(loaded.manifest.secret_bearing_handlers).toEqual(['record_offer']);

    // 3. The same workflow re-loaded from its file re-anchors identically.
    const reloaded = loadWorkflowFromFile(workflowPath);
    expect(reloaded.trust_root).toBe(root);
  });
});

describe('sentinel/real cache isolation (fix-holder for the mode cache-key component)', () => {
  it('a sentinel-mode load never serves a subsequent real-mode load for the same definition', async () => {
    writeEnv('MY_TOKEN=real-value\n');
    writeManifest(
      `version: 1
secrets: { sources: [dotenv] }
handlers:
  h1:
    use: ./dist/registry.js#makeHandler
    config: { token: "\${secret:MY_TOKEN}" }
`,
    );
    writeFileSync(
      join(root, 'dist', 'registry.js'),
      `export function makeHandler(ctx) {
  return { id: ctx.id, token: ctx.config.token, async execute() { return { output: {}, warnings: [] }; } };
}
`,
      'utf8',
    );
    const def = anchoredDefinition();
    const sentinel = await loadProjectExtensions(def, { secretMode: 'sentinel' });
    const real = await loadProjectExtensions(def, { secretMode: 'real' });
    // distinct registries, and the real path carries the REAL secret, never the sentinel label
    expect(real.registry).not.toBe(sentinel.registry);
    const sHandler = sentinel.registry.getHandler('h1') as unknown as { token: string };
    const rHandler = real.registry.getHandler('h1') as unknown as { token: string };
    expect(sHandler.token).toBe('<sentinel:MY_TOKEN>');
    expect(rHandler.token).toBe('real-value');
  });
});
