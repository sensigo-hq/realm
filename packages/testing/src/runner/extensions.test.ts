// Tests for project-extension semantics in the fixture runner: real handlers execute,
// unmocked extension adapters TRIP in both leak paths, mocked ones pass, and the tripwire
// error enumerates unmatched fixture mock keys.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDefaultRegistry, CURRENT_WORKFLOW_SCHEMA_VERSION } from '@sensigo/realm';
import type { WorkflowDefinition, ServiceAdapter, StepHandler } from '@sensigo/realm';
import { runFixtureTests, buildFixtureRegistries } from './test-runner.js';
import type { TestFixture } from '../fixtures/fixture-loader.js';

/** A "real" extension adapter that must NEVER run inside a fixture — proves the tripwire preempts it. */
const realServiceAdapter: ServiceAdapter = {
  id: 'custom_adapter',
  fetch: async () => {
    throw new Error('REAL SERVICE HIT — the tripwire failed');
  },
  create: async () => {
    throw new Error('REAL SERVICE HIT — the tripwire failed');
  },
  update: async () => {
    throw new Error('REAL SERVICE HIT — the tripwire failed');
  },
};

const realHandler: StepHandler = {
  id: 'my_custom_handler',
  execute: async () => ({ data: { handled: true } }),
};

function makeExtensions(): NonNullable<Parameters<typeof buildFixtureRegistries>[2]['extensions']> {
  const registry = createDefaultRegistry();
  registry.register('adapter', 'custom_adapter', realServiceAdapter);
  registry.register('handler', 'my_custom_handler', realHandler);
  return {
    registry,
    manifest: {
      modules: [{ declared: '../../dist/registry.js', resolved: '/proj/dist/registry.js' }],
      adapters: ['custom_adapter'],
      handlers: ['my_custom_handler'],
      processors: [],
    },
  };
}

const SERVICE_DEFINITION: WorkflowDefinition = {
  id: 'ext-svc-wf',
  name: 'Ext Service WF',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  services: { custom_svc: { adapter: 'custom_adapter', trust: 'engine_managed' } },
  steps: { fetch_data: { description: 'fetch', execution: 'auto', uses_service: 'custom_svc' } },
};

function makeFixture(overrides: Partial<TestFixture> = {}): TestFixture {
  return {
    name: 'fixture',
    params: {},
    mocks: {},
    agent_responses: {},
    expected: { final_state: 'completed' },
    ...overrides,
  };
}

describe('buildFixtureRegistries — tripwire in BOTH leak paths', () => {
  it('registers a throwing tripwire for an unmocked extension adapter in the fixture registry (execution-loop path)', async () => {
    const { fixtureRegistry } = buildFixtureRegistries(makeFixture(), SERVICE_DEFINITION, {
      extensions: makeExtensions(),
    });
    const adapter = fixtureRegistry.getAdapter('custom_adapter');
    expect(adapter).toBeDefined();
    await expect(adapter!.fetch('op', {}, {})).rejects.toThrow(
      "Unmocked project adapter 'custom_adapter' — mock it in the fixture (it would hit a real service).",
    );
  });

  it('registers the same tripwire in the dispatcher fallback registry (mock-agent path)', async () => {
    const { fallbackRegistry } = buildFixtureRegistries(makeFixture(), SERVICE_DEFINITION, {
      extensions: makeExtensions(),
    });
    expect(fallbackRegistry).toBeDefined();
    const adapter = fallbackRegistry!.getAdapter('custom_adapter');
    expect(adapter).toBeDefined();
    await expect(adapter!.create('op', {}, {})).rejects.toThrow(/Unmocked project adapter/);
  });

  it('the tripwire error enumerates the fixture UNMATCHED mock keys (typo detection)', async () => {
    const fixture = makeFixture({
      // 'custom_svcc' is a typo'd service name — matches nothing in the workflow.
      mocks: { custom_svcc: { fetch_data: { status: 200, data: {} } } },
    });
    const { fixtureRegistry } = buildFixtureRegistries(fixture, SERVICE_DEFINITION, {
      extensions: makeExtensions(),
    });
    await expect(fixtureRegistry.getAdapter('custom_adapter')!.fetch('op', {}, {})).rejects.toThrow(
      /Unmatched fixture mock keys.*'custom_svcc'/s,
    );
  });

  it('a mocked extension adapter gets the mock, not a tripwire', async () => {
    const fixture = makeFixture({
      mocks: { custom_svc: { fetch_data: { status: 200, data: { mocked: true } } } },
    });
    const { fixtureRegistry, fallbackRegistry } = buildFixtureRegistries(
      fixture,
      SERVICE_DEFINITION,
      { extensions: makeExtensions() },
    );
    const response = await fixtureRegistry
      .getAdapter('custom_adapter')!
      .fetch('fetch_data', {}, {});
    expect(response.data).toEqual({ mocked: true });
    // And the fallback carries no adapter under that name that could leak to a real service:
    // the tripwire loop skipped it (mocked), so the fallback simply has no entry.
    expect(fallbackRegistry!.getAdapter('custom_adapter')).toBeUndefined();
  });

  it('extension handlers merge REAL into both registries', () => {
    const { fixtureRegistry, fallbackRegistry } = buildFixtureRegistries(
      makeFixture(),
      SERVICE_DEFINITION,
      { extensions: makeExtensions() },
    );
    expect(fixtureRegistry.getHandler('my_custom_handler')).toBe(realHandler);
    expect(fallbackRegistry!.getHandler('my_custom_handler')).toBe(realHandler);
  });

  it('without extensions the registries are unchanged (byte-identical fallback)', () => {
    const { fixtureRegistry, fallbackRegistry } = buildFixtureRegistries(
      makeFixture(),
      SERVICE_DEFINITION,
      {},
    );
    expect(fixtureRegistry.getAdapter('custom_adapter')).toBeUndefined();
    expect(fallbackRegistry).toBeUndefined();
  });
});

describe('runFixtureTests with extensions (integration)', () => {
  let dir: string;
  let fixturesDir: string;

  const SERVICE_WORKFLOW_YAML = `
id: ext-svc-wf
name: Ext Service WF
version: 1
services:
  custom_svc:
    adapter: custom_adapter
    trust: engine_managed
steps:
  fetch_data:
    description: fetch
    execution: auto
    uses_service: custom_svc
`;

  const HANDLER_WORKFLOW_YAML = `
id: ext-handler-wf
name: Ext Handler WF
version: 1
steps:
  process_data:
    description: handle
    execution: auto
    handler: my_custom_handler
`;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'realm-testing-ext-'));
    fixturesDir = join(dir, 'fixtures');
    mkdirSync(fixturesDir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeWorkflow(yaml: string): string {
    const path = join(dir, 'workflow.yaml');
    writeFileSync(path, yaml, 'utf8');
    return path;
  }

  function writeFixture(name: string, yaml: string): void {
    writeFileSync(join(fixturesDir, `${name}.yaml`), yaml, 'utf8');
  }

  it('an unmocked extension adapter FAILS the fixture with the tripwire message (never silently real)', async () => {
    const workflowPath = writeWorkflow(SERVICE_WORKFLOW_YAML);
    writeFixture('unmocked', `name: unmocked\nexpected:\n  final_state: completed\n`);
    const results = await runFixtureTests({
      workflowPath,
      fixturesPath: fixturesDir,
      extensions: makeExtensions(),
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.passed).toBe(false);
    expect(results[0]!.error).toContain("Unmocked project adapter 'custom_adapter'");
    expect(results[0]!.error).not.toContain('REAL SERVICE HIT');
  });

  it('a mocked extension adapter passes', async () => {
    const workflowPath = writeWorkflow(SERVICE_WORKFLOW_YAML);
    writeFixture(
      'mocked',
      `name: mocked
mocks:
  custom_svc:
    fetch_data:
      status: 200
      data:
        ok: true
expected:
  final_state: completed
`,
    );
    const results = await runFixtureTests({
      workflowPath,
      fixturesPath: fixturesDir,
      extensions: makeExtensions(),
    });
    expect(results[0]!.error).toBeUndefined();
    expect(results[0]!.passed).toBe(true);
  });

  it('a real custom extension handler executes (testing it is the point)', async () => {
    const workflowPath = writeWorkflow(HANDLER_WORKFLOW_YAML);
    writeFixture(
      'handler',
      `name: handler
expected:
  final_state: completed
  evidence:
    - step_id: process_data
      status: success
`,
    );
    const results = await runFixtureTests({
      workflowPath,
      fixturesPath: fixturesDir,
      extensions: makeExtensions(),
    });
    expect(results[0]!.error).toBeUndefined();
    expect(results[0]!.passed).toBe(true);
  });
});

describe('secret-bearing handlers (v0.14 manifest sentinel guard)', () => {
  const HANDLER_WORKFLOW: string = `
id: secret-handler-wf
name: Secret Handler WF
version: 1
steps:
  record:
    description: record via secret-bearing handler
    execution: auto
    handler: secret_handler
  plain:
    description: plain handler step
    execution: auto
    handler: my_custom_handler
    depends_on: [record]
`;

  function makeSecretExtensions(): NonNullable<
    Parameters<typeof buildFixtureRegistries>[2]['extensions']
  > {
    const registry = createDefaultRegistry();
    registry.register('handler', 'secret_handler', {
      id: 'secret_handler',
      execute: async () => ({ data: { leaked: '<sentinel:KEY>' } }),
    });
    registry.register('handler', 'my_custom_handler', realHandler);
    return {
      registry,
      manifest: {
        modules: [],
        adapters: [],
        handlers: ['secret_handler', 'my_custom_handler'],
        processors: [],
        secret_bearing_handlers: ['secret_handler'],
      },
    };
  }

  it('the runner FAILS the fixture the first time a secret-bearing handler executes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'realm-secret-handler-'));
    try {
      writeFileSync(join(dir, 'workflow.yaml'), HANDLER_WORKFLOW, 'utf8');
      const fixturesDir = join(dir, 'fixtures');
      mkdirSync(fixturesDir);
      writeFileSync(
        join(fixturesDir, 'f.yaml'),
        `name: f\nexpected:\n  final_state: completed\n`,
        'utf8',
      );
      const results = await runFixtureTests({
        workflowPath: join(dir, 'workflow.yaml'),
        fixturesPath: fixturesDir,
        extensions: makeSecretExtensions(),
      });
      expect(results[0]!.passed).toBe(false);
      expect(results[0]!.error).toContain(
        "handler 'secret_handler' is secret-bearing; fixture tests cannot exercise it — adapter-mediate its I/O or exclude the step.",
      );
      // The sentinel-constructed handler never executed.
      expect(results[0]!.error).not.toContain('<sentinel:KEY>');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('secret-free handlers still execute real (0.13 semantics)', () => {
    const { fixtureRegistry, fallbackRegistry } = buildFixtureRegistries(
      makeFixture(),
      SERVICE_DEFINITION,
      { extensions: makeSecretExtensions() },
    );
    // Poisoned in BOTH paths...
    expect(fixtureRegistry.getHandler('secret_handler')).not.toBeUndefined();
    expect(fallbackRegistry!.getHandler('secret_handler')).not.toBeUndefined();
    // ...while the secret-free handler is the REAL instance in both.
    expect(fixtureRegistry.getHandler('my_custom_handler')).toBe(realHandler);
    expect(fallbackRegistry!.getHandler('my_custom_handler')).toBe(realHandler);
  });

  it('the poisoned handler throws the targeted message in both registries', async () => {
    const { fixtureRegistry, fallbackRegistry } = buildFixtureRegistries(
      makeFixture(),
      SERVICE_DEFINITION,
      { extensions: makeSecretExtensions() },
    );
    for (const registry of [fixtureRegistry, fallbackRegistry!]) {
      await expect(
        registry
          .getHandler('secret_handler')!
          .execute({ params: {} }, { run_id: 'r', run_params: {}, config: {} }),
      ).rejects.toThrow(/secret-bearing; fixture tests cannot exercise it/);
    }
  });
});
