// Fix-holder regression test for the loader-cache decontamination (design Q1 resolution):
// `realm agent` composes its per-run registry on a CLONE of the loader-returned registry.
// The cached instance must never gain the legacy env-gated adapters — a fresh
// loadProjectExtensions for the same definition must come back github-free.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CURRENT_WORKFLOW_SCHEMA_VERSION } from '@sensigo/realm';
import type { WorkflowDefinition } from '@sensigo/realm';
import { composeAgentRegistry } from './agent.js';
import {
  loadProjectExtensions,
  clearProjectExtensionsCache,
} from '../extensions/load-project-extensions.js';

let proj: string;
let workflowDir: string;

beforeEach(() => {
  clearProjectExtensionsCache();
  vi.stubEnv('GITHUB_TOKEN', 'ghp_test_token');
  vi.stubEnv('SLACK_WEBHOOK_URL', 'https://hooks.slack.example/T000/B000/x');
  proj = mkdtempSync(join(tmpdir(), 'realm-compose-'));
  workflowDir = join(proj, 'workflows', 'wf');
  mkdirSync(join(proj, 'dist'), { recursive: true });
  mkdirSync(workflowDir, { recursive: true });
  writeFileSync(join(proj, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(proj, { recursive: true, force: true });
});

function makeDefinition(extensions?: string[]): WorkflowDefinition {
  return {
    id: 'compose-wf',
    name: 'Compose WF',
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps: { s1: { description: 'step', execution: 'agent' } },
    origin: 'human',
    ...(extensions !== undefined ? { extensions, source_dir: workflowDir, trust_root: proj } : {}),
  };
}

describe('composeAgentRegistry — loader cache decontamination (fix holder)', () => {
  it('agent composition with GITHUB_TOKEN set does NOT contaminate the cached registry (extension-less sentinel)', async () => {
    const definition = makeDefinition();

    // The agent path: load (cache entry), compose the per-run registry.
    const loaded = await loadProjectExtensions(definition);
    const runRegistry = composeAgentRegistry(loaded);
    expect(runRegistry.has('adapter', 'github')).toBe(true); // legacy tier applied to the run

    // A fresh load for the same definition must come back UNCONTAMINATED.
    const fresh = await loadProjectExtensions(definition);
    expect(fresh.registry.has('adapter', 'github')).toBe(false);
    // And it is the very same cached instance — proving the compose never touched it.
    expect(fresh.registry).toBe(loaded.registry);
  });

  it('agent composition does not contaminate a declared-extensions cache entry either', async () => {
    writeFileSync(
      join(proj, 'dist', 'registry.js'),
      `export default { handlers: { h1: { id: 'h1', execute: async () => ({ data: {} }) } } };`,
      'utf8',
    );
    const definition = makeDefinition(['../../dist/registry.js']);

    const loaded = await loadProjectExtensions(definition);
    const runRegistry = composeAgentRegistry(loaded);
    expect(runRegistry.has('adapter', 'github')).toBe(true);
    expect(runRegistry.getHandler('h1')).toBeDefined(); // extensions carried through the clone

    const fresh = await loadProjectExtensions(definition);
    expect(fresh.registry.has('adapter', 'github')).toBe(false);
    expect(fresh.registry).toBe(loaded.registry);
  });

  it('legacy tier still yields to extension-claimed names on the composed clone', async () => {
    writeFileSync(
      join(proj, 'dist', 'registry.js'),
      `const adapter = { id: 'github', fetch: async () => ({ status: 200, data: { custom: true } }), create: async () => ({ status: 201, data: {} }), update: async () => ({ status: 200, data: {} }) };
export default { adapters: { github: adapter } };`,
      'utf8',
    );
    const definition = makeDefinition(['../../dist/registry.js']);
    const loaded = await loadProjectExtensions(definition);
    const runRegistry = composeAgentRegistry(loaded);
    // The extension's github adapter wins over the legacy env-gated one.
    const response = await runRegistry.getAdapter('github')!.fetch('op', {}, {});
    expect(response.data).toEqual({ custom: true });
  });

  it('extension-free composition still carries defaults + both legacy adapters (0.12 parity)', async () => {
    const loaded = await loadProjectExtensions(makeDefinition());
    const runRegistry = composeAgentRegistry(loaded);
    expect(runRegistry.has('adapter', 'filesystem')).toBe(true);
    expect(runRegistry.has('adapter', 'slack')).toBe(true);
    expect(runRegistry.has('adapter', 'github')).toBe(true);
  });
});
