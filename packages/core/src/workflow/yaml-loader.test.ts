import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  loadWorkflowFromString,
  loadWorkflowFromFile,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
} from './yaml-loader.js';
import { WorkflowError } from '../types/workflow-error.js';
import { ExtensionRegistry } from '../extensions/registry.js';
import type { ServiceAdapter } from '../extensions/service-adapter.js';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const VALID_YAML = `
id: test-workflow
name: Test Workflow
version: 1
steps:
  step-one:
    description: First step
    execution: auto
    depends_on: []
  step-two:
    description: Second step
    execution: agent
    depends_on: [step-one]
`;

describe('loadWorkflowFromString', () => {
  it('valid YAML string returns correct WorkflowDefinition', () => {
    const def = loadWorkflowFromString(VALID_YAML);
    expect(def.id).toBe('test-workflow');
    expect(def.name).toBe('Test Workflow');
    expect(def.version).toBe(1);
    expect(Object.keys(def.steps)).toHaveLength(2);
  });

  it('stamps schema_version on the loaded definition', () => {
    const def = loadWorkflowFromString(VALID_YAML);
    expect(def.schema_version).toBe(CURRENT_WORKFLOW_SCHEMA_VERSION);
  });

  it('missing top-level field throws WorkflowError', () => {
    const content = VALID_YAML.replace('id: test-workflow\n', '');
    expect(() => loadWorkflowFromString(content)).toThrow(WorkflowError);
  });

  it('step with unknown uses_service throws WorkflowError', () => {
    const content = VALID_YAML.replace(
      'depends_on: [step-one]',
      'depends_on: [step-one]\n    uses_service: nonexistent-service',
    );
    expect(() => loadWorkflowFromString(content)).toThrow(WorkflowError);
  });

  it('invalid execution value throws WorkflowError', () => {
    const content = VALID_YAML.replace('execution: auto', 'execution: invalid_mode');
    expect(() => loadWorkflowFromString(content)).toThrow(WorkflowError);
  });

  it('invalid service_method value throws WorkflowError containing service_method', () => {
    const content = VALID_YAML.replace(
      'depends_on: []',
      'depends_on: []\n    service_method: invalid_value',
    );
    expect(() => loadWorkflowFromString(content)).toThrow(WorkflowError);
    try {
      loadWorkflowFromString(content);
    } catch (err) {
      expect((err as WorkflowError).message).toContain('service_method');
    }
  });

  it('accepts service_method: delete without throwing', () => {
    const content = VALID_YAML.replace(
      'depends_on: []',
      'depends_on: []\n    service_method: delete',
    );
    expect(() => loadWorkflowFromString(content)).not.toThrow();
  });

  it('preserves step config block in parsed definition', () => {
    const yaml = `
id: cfg-test
name: Config Test
version: 1
steps:
  validate:
    description: "Validate something."
    execution: auto
    handler: my_handler
    config:
      source_step: fetch_doc
      threshold: 3
`;
    const def = loadWorkflowFromString(yaml);
    expect(def.steps['validate']?.config).toEqual({
      source_step: 'fetch_doc',
      threshold: 3,
    });
  });

  it('expands use_template: call site into concrete steps; call site key is absent', () => {
    const yaml = `
id: tpl-wf
name: Template Workflow
version: 1
templates:
  simple_pair:
    params:
      svc:
        required: true
    steps:
      fetch:
        description: Fetch from {{ svc }}
        execution: auto
      review:
        description: Review the result
        execution: agent
steps:
  init:
    description: Initialise
    execution: auto
  setup:
    use_template: simple_pair
    prefix: doc
    params:
      svc: documents
`;
    const def = loadWorkflowFromString(yaml);
    const keys = Object.keys(def.steps);
    expect(keys).toContain('doc_fetch');
    expect(keys).toContain('doc_review');
    expect(keys).not.toContain('setup');
    expect(def.steps['doc_fetch']?.description).toBe('Fetch from documents');
  });

  it('throws WorkflowError when a required template param is missing at call site', () => {
    const yaml = `
id: tpl-missing-param
name: Missing Param
version: 1
templates:
  needs_svc:
    params:
      svc:
        required: true
    steps:
      fetch:
        description: Fetch from {{ svc }}
        execution: auto
steps:
  call:
    use_template: needs_svc
    prefix: x
    params: {}
`;
    expect(() => loadWorkflowFromString(yaml)).toThrow(WorkflowError);
    try {
      loadWorkflowFromString(yaml);
    } catch (err) {
      expect((err as WorkflowError).message).toContain('svc');
    }
  });

  it('throws WorkflowError when use_template references a non-existent template', () => {
    const yaml = `
id: tpl-bad-ref
name: Bad Ref
version: 1
steps:
  call:
    use_template: does_not_exist
    prefix: x
`;
    expect(() => loadWorkflowFromString(yaml)).toThrow(WorkflowError);
    try {
      loadWorkflowFromString(yaml);
    } catch (err) {
      expect((err as WorkflowError).message).toContain('does_not_exist');
    }
  });

  it('expands two use_template instantiations of the same template with different prefixes', () => {
    const yaml = `
id: two-tpl-wf
name: Two Template Uses
version: 1
templates:
  one_step:
    params:
      label:
        default: item
    steps:
      process:
        description: Process {{ label }}
        execution: agent
steps:
  init_alpha:
    description: Init alpha
    execution: auto
  first:
    use_template: one_step
    prefix: alpha
    params:
      label: alpha_item
  init_beta:
    description: Init beta
    execution: auto
  second:
    use_template: one_step
    prefix: beta
    params:
      label: beta_item
`;
    const def = loadWorkflowFromString(yaml);
    const keys = Object.keys(def.steps);
    expect(keys).toContain('alpha_process');
    expect(keys).toContain('beta_process');
    expect(def.steps['alpha_process']?.description).toBe('Process alpha_item');
    expect(def.steps['beta_process']?.description).toBe('Process beta_item');
  });

  it('mixes a concrete step and a use_template instantiation in the same workflow', () => {
    const yaml = `
id: mixed-wf
name: Mixed Workflow
version: 1
templates:
  one_step:
    steps:
      run:
        description: Run step
        execution: agent
steps:
  prepare:
    description: Prepare
    execution: auto
  main:
    use_template: one_step
    prefix: task
`;
    const def = loadWorkflowFromString(yaml);
    const keys = Object.keys(def.steps);
    expect(keys).toContain('prepare');
    expect(keys).toContain('task_run');
    expect(keys).not.toContain('main');
  });
  it('execution: auto step with input_map on agent step is rejected', () => {
    const content = VALID_YAML.replace(
      'execution: agent',
      'execution: agent\n    input_map:\n      foo: run.params.foo',
    );
    expect(() => loadWorkflowFromString(content)).toThrow(WorkflowError);
    try {
      loadWorkflowFromString(content);
    } catch (err) {
      expect((err as WorkflowError).message).toContain('input_map');
    }
  });

  it('input_map with empty nested object is rejected', () => {
    const yaml = `
id: wf
name: WF
version: 1
services:
  svc:
    adapter: mock
    trust: engine_delivered
steps:
  step1:
    description: step
    execution: auto
    uses_service: svc
    input_map:
      fields: {}
`;
    expect(() => loadWorkflowFromString(yaml)).toThrow(WorkflowError);
    try {
      loadWorkflowFromString(yaml);
    } catch (err) {
      expect((err as WorkflowError).message).toContain('input_map');
      expect((err as WorkflowError).message).toContain('fields');
    }
  });

  it('input_map with non-string leaf is rejected', () => {
    const yaml = `
id: wf
name: WF
version: 1
services:
  svc:
    adapter: mock
    trust: engine_delivered
steps:
  step1:
    description: step
    execution: auto
    uses_service: svc
    input_map:
      fields:
        count: 42
`;
    expect(() => loadWorkflowFromString(yaml)).toThrow(WorkflowError);
    try {
      loadWorkflowFromString(yaml);
    } catch (err) {
      expect((err as WorkflowError).message).toContain('input_map');
    }
  });

  it('input_map with valid $literal string loads without error', () => {
    const yaml = `
id: wf
name: WF
version: 1
services:
  svc:
    adapter: mock
    trust: engine_delivered
steps:
  step1:
    description: step
    execution: auto
    uses_service: svc
    input_map:
      table:
        $literal: CS_Macros
`;
    expect(() => loadWorkflowFromString(yaml)).not.toThrow();
    const def = loadWorkflowFromString(yaml);
    expect((def.steps['step1']?.input_map?.['table'] as { $literal: unknown }).$literal).toBe(
      'CS_Macros',
    );
  });

  it('input_map with $literal having sibling key is rejected', () => {
    const yaml = `
id: wf
name: WF
version: 1
services:
  svc:
    adapter: mock
    trust: engine_delivered
steps:
  step1:
    description: step
    execution: auto
    uses_service: svc
    input_map:
      table:
        $literal: CS_Macros
        extra: should_fail
`;
    expect(() => loadWorkflowFromString(yaml)).toThrow(WorkflowError);
    try {
      loadWorkflowFromString(yaml);
    } catch (err) {
      expect((err as WorkflowError).message).toContain('$literal');
      expect((err as WorkflowError).message).toContain('sibling keys');
    }
  });

  it('input_map with $literal array value loads (any JSON value accepted)', () => {
    const yaml = `
id: wf
name: WF
version: 1
services:
  svc:
    adapter: mock
    trust: engine_delivered
steps:
  step1:
    description: step
    execution: auto
    uses_service: svc
    input_map:
      ids:
        $literal:
          - one
          - two
`;
    expect(() => loadWorkflowFromString(yaml)).not.toThrow();
    const def = loadWorkflowFromString(yaml);
    expect((def.steps['step1']?.input_map?.['ids'] as { $literal: unknown }).$literal).toEqual([
      'one',
      'two',
    ]);
  });

  it('input_map with $literal object value loads (any JSON value accepted)', () => {
    const yaml = `
id: wf
name: WF
version: 1
services:
  svc:
    adapter: mock
    trust: engine_delivered
steps:
  step1:
    description: step
    execution: auto
    uses_service: svc
    input_map:
      filter:
        $literal:
          tier: gold
          ids: [1, 2]
          x: run.params.y
`;
    expect(() => loadWorkflowFromString(yaml)).not.toThrow();
    const def = loadWorkflowFromString(yaml);
    expect((def.steps['step1']?.input_map?.['filter'] as { $literal: unknown }).$literal).toEqual({
      tier: 'gold',
      ids: [1, 2],
      x: 'run.params.y',
    });
  });

  it('input_map with a bare array node value is still rejected (must wrap in $literal)', () => {
    const yaml = `
id: wf
name: WF
version: 1
services:
  svc:
    adapter: mock
    trust: engine_delivered
steps:
  step1:
    description: step
    execution: auto
    uses_service: svc
    input_map:
      ids:
        - one
        - two
`;
    expect(() => loadWorkflowFromString(yaml)).toThrow(WorkflowError);
    try {
      loadWorkflowFromString(yaml);
    } catch (err) {
      expect((err as WorkflowError).message).toContain('expected a string or object');
      expect((err as WorkflowError).message).toContain('array');
    }
  });

  it('input_map with $literal nested inside object validates correctly', () => {
    const yaml = `
id: wf
name: WF
version: 1
services:
  svc:
    adapter: mock
    trust: engine_delivered
steps:
  step1:
    description: step
    execution: auto
    uses_service: svc
    input_map:
      config:
        table:
          $literal: CS_Macros
        id: run.params.id
`;
    expect(() => loadWorkflowFromString(yaml)).not.toThrow();
  });

  it('step config with a nested object now loads (v1 ban lifted)', () => {
    const yaml = `
id: wf
name: WF
version: 1
steps:
  step1:
    description: step
    execution: auto
    handler: my-handler
    config:
      retry:
        attempts: 3
        backoff: exponential
      tags: [a, b]
      enabled: true
`;
    expect(() => loadWorkflowFromString(yaml)).not.toThrow();
    const def = loadWorkflowFromString(yaml);
    expect(def.steps['step1']?.config).toEqual({
      retry: { attempts: 3, backoff: 'exponential' },
      tags: ['a', 'b'],
      enabled: true,
    });
  });
});

describe('loadWorkflowFromFile', () => {
  it('nonexistent file throws WorkflowError with code RESOURCE_FETCH_FAILED', () => {
    expect(() => loadWorkflowFromFile('/nonexistent/path/workflow.yaml')).toThrow(WorkflowError);
    try {
      loadWorkflowFromFile('/nonexistent/path/workflow.yaml');
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowError);
      expect((err as WorkflowError).code).toBe('RESOURCE_FETCH_FAILED');
    }
  });
});

describe('loadWorkflowFromString — agent_profile validation', () => {
  it('agent_profile on auto step throws WorkflowError', () => {
    const content = `
id: test-wf
name: Test
version: 1
steps:
  bad-step:
    description: Bad
    execution: auto
    agent_profile: some-profile
`;
    expect(() => loadWorkflowFromString(content)).toThrow(WorkflowError);
    try {
      loadWorkflowFromString(content);
    } catch (err) {
      expect((err as WorkflowError).message).toContain(
        "agent_profile' is only valid on execution: agent steps",
      );
    }
  });

  it('output_schema on execution: auto step throws VALIDATION_WORKFLOW_SCHEMA', () => {
    const content = VALID_YAML.replace(
      'execution: auto',
      'execution: auto\n    output_schema:\n      type: object\n      required: [result]\n      properties:\n        result:\n          type: string',
    );
    expect(() => loadWorkflowFromString(content)).toThrow(WorkflowError);
    try {
      loadWorkflowFromString(content);
    } catch (err) {
      expect((err as WorkflowError).code).toBe('VALIDATION_WORKFLOW_SCHEMA');
      expect((err as WorkflowError).message).toContain('output_schema');
    }
  });

  it('trace_schema on execution: auto step throws VALIDATION_WORKFLOW_SCHEMA', () => {
    const content = VALID_YAML.replace(
      'execution: auto',
      'execution: auto\n    trace_schema:\n      type: array',
    );
    expect(() => loadWorkflowFromString(content)).toThrow(WorkflowError);
    try {
      loadWorkflowFromString(content);
    } catch (err) {
      expect((err as WorkflowError).code).toBe('VALIDATION_WORKFLOW_SCHEMA');
      expect((err as WorkflowError).message).toContain('trace_schema');
    }
  });

  it('trace_validation_mode on execution: auto step throws VALIDATION_WORKFLOW_SCHEMA', () => {
    const content = VALID_YAML.replace(
      'execution: auto',
      'execution: auto\n    trace_validation_mode: warn',
    );
    expect(() => loadWorkflowFromString(content)).toThrow(WorkflowError);
    try {
      loadWorkflowFromString(content);
    } catch (err) {
      expect((err as WorkflowError).code).toBe('VALIDATION_WORKFLOW_SCHEMA');
      expect((err as WorkflowError).message).toContain('trace_validation_mode');
    }
  });

  it('trace_validation_mode with invalid value throws VALIDATION_WORKFLOW_SCHEMA', () => {
    // Use an agent step (replace execution: agent step in VALID_YAML)
    const content = VALID_YAML.replace(
      'execution: agent',
      'execution: agent\n    trace_validation_mode: strict',
    );
    expect(() => loadWorkflowFromString(content)).toThrow(WorkflowError);
    try {
      loadWorkflowFromString(content);
    } catch (err) {
      expect((err as WorkflowError).code).toBe('VALIDATION_WORKFLOW_SCHEMA');
      expect((err as WorkflowError).message).toContain('trace_validation_mode');
    }
  });

  it('trace_schema and trace_validation_mode on execution: agent step are accepted', () => {
    const content = VALID_YAML.replace(
      'execution: agent',
      'execution: agent\n    trace_schema:\n      type: array\n    trace_validation_mode: enforce',
    );
    expect(() => loadWorkflowFromString(content)).not.toThrow();
  });
});

describe('loadWorkflowFromFile — agent profile resolution', () => {
  let tmpDir: string;
  const workflowYaml = `
id: profile-wf
name: Profile Workflow
version: 1
steps:
  agent-step:
    description: Agent step with profile
    execution: agent
    agent_profile: my-profile
`;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'realm-profile-test-'));
    mkdirSync(join(tmpDir, 'profiles'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resolves profile content and hash when profiles/ directory exists', () => {
    writeFileSync(join(tmpDir, 'workflow.yaml'), workflowYaml);
    writeFileSync(join(tmpDir, 'profiles', 'my-profile.md'), 'You are a helpful agent.');

    const def = loadWorkflowFromFile(join(tmpDir, 'workflow.yaml'));
    expect(def.resolved_profiles).toBeDefined();
    expect(def.resolved_profiles!['my-profile']).toBeDefined();
    expect(def.resolved_profiles!['my-profile']!.content).toBe('You are a helpful agent.');
    expect(def.resolved_profiles!['my-profile']!.content_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('throws WorkflowError when profile file is missing', () => {
    writeFileSync(join(tmpDir, 'workflow.yaml'), workflowYaml);
    // no profiles/my-profile.md written

    expect(() => loadWorkflowFromFile(join(tmpDir, 'workflow.yaml'))).toThrow(WorkflowError);
    try {
      loadWorkflowFromFile(join(tmpDir, 'workflow.yaml'));
    } catch (err) {
      expect((err as WorkflowError).message).toContain("agent_profile 'my-profile' not found");
      expect((err as WorkflowError).message).toContain('my-profile.md');
    }
  });

  it('shared profile used by two steps is resolved once with the same hash', () => {
    const sharedYaml = `
id: shared-profile-wf
name: Shared Profile Workflow
version: 1
steps:
  step-a:
    description: First agent step
    execution: agent
    agent_profile: shared-profile
  step-b:
    description: Second agent step
    execution: agent
    agent_profile: shared-profile
`;
    writeFileSync(join(tmpDir, 'workflow.yaml'), sharedYaml);
    writeFileSync(join(tmpDir, 'profiles', 'shared-profile.md'), 'Shared persona content.');

    const def = loadWorkflowFromFile(join(tmpDir, 'workflow.yaml'));
    expect(def.resolved_profiles).toBeDefined();
    const keys = Object.keys(def.resolved_profiles!);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toBe('shared-profile');
    expect(def.resolved_profiles!['shared-profile']!.content_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('custom profiles_dir is used when declared', () => {
    const customProfilesDir = join(tmpDir, 'custom-profiles');
    mkdirSync(customProfilesDir);
    const customDirYaml = `
id: custom-dir-wf
name: Custom Dir Workflow
version: 1
profiles_dir: ./custom-profiles
steps:
  agent-step:
    description: Agent step
    execution: agent
    agent_profile: custom-profile
`;
    writeFileSync(join(tmpDir, 'workflow.yaml'), customDirYaml);
    writeFileSync(join(customProfilesDir, 'custom-profile.md'), 'Custom profile content.');

    const def = loadWorkflowFromFile(join(tmpDir, 'workflow.yaml'));
    expect(def.resolved_profiles!['custom-profile']!.content).toBe('Custom profile content.');
  });
});

describe('loadWorkflowFromFile — workflow_context', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'realm-ctx-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const baseYaml = `
id: ctx-wf
name: Context Workflow
version: 1
steps:
  step-one:
    description: A step
    execution: agent
    depends_on: []
`;

  it('workflow_context relative path is resolved to absolute in the output', () => {
    writeFileSync(join(tmpDir, 'rules.md'), '# Rules');
    writeFileSync(
      join(tmpDir, 'workflow.yaml'),
      baseYaml + `\nworkflow_context:\n  rules:\n    source:\n      path: ./rules.md\n`,
    );
    const def = loadWorkflowFromFile(join(tmpDir, 'workflow.yaml'));
    expect(def.workflow_context?.['rules']?.source.path).toBe(join(tmpDir, 'rules.md'));
  });

  it('context_wrapper value is parsed and stored on the definition', () => {
    writeFileSync(join(tmpDir, 'rules.md'), '# Rules');
    writeFileSync(
      join(tmpDir, 'workflow.yaml'),
      baseYaml +
        `\ncontext_wrapper: brackets\nworkflow_context:\n  rules:\n    source:\n      path: ./rules.md\n`,
    );
    const def = loadWorkflowFromFile(join(tmpDir, 'workflow.yaml'));
    expect(def.context_wrapper).toBe('brackets');
  });

  it('invalid context_wrapper value throws a descriptive WorkflowError', () => {
    writeFileSync(join(tmpDir, 'workflow.yaml'), baseYaml + `\ncontext_wrapper: markdown\n`);
    expect(() => loadWorkflowFromFile(join(tmpDir, 'workflow.yaml'))).toThrow(WorkflowError);
    try {
      loadWorkflowFromFile(join(tmpDir, 'workflow.yaml'));
    } catch (err) {
      expect((err as WorkflowError).message).toContain('context_wrapper');
    }
  });

  it('missing source.path on an entry throws with the entry name in the message', () => {
    writeFileSync(
      join(tmpDir, 'workflow.yaml'),
      baseYaml + `\nworkflow_context:\n  rules:\n    description: no source\n`,
    );
    expect(() => loadWorkflowFromFile(join(tmpDir, 'workflow.yaml'))).toThrow(WorkflowError);
    try {
      loadWorkflowFromFile(join(tmpDir, 'workflow.yaml'));
    } catch (err) {
      expect((err as WorkflowError).message).toContain('workflow_context.rules.source.path');
    }
  });

  it('schema.json present + no explicit workflow_context.schema → auto-registered with absolute path', () => {
    writeFileSync(join(tmpDir, 'schema.json'), '{}');
    writeFileSync(join(tmpDir, 'workflow.yaml'), baseYaml);
    const def = loadWorkflowFromFile(join(tmpDir, 'workflow.yaml'));
    expect(def.workflow_context?.['schema']).toBeDefined();
    expect(def.workflow_context!['schema']!.source.path).toBe(join(tmpDir, 'schema.json'));
  });

  it('schema.json present + explicit workflow_context.schema declared → auto-registration skipped', () => {
    writeFileSync(join(tmpDir, 'schema.json'), '{}');
    writeFileSync(join(tmpDir, 'explicit-schema.json'), '{"explicit":true}');
    writeFileSync(
      join(tmpDir, 'workflow.yaml'),
      baseYaml +
        `\nworkflow_context:\n  schema:\n    source:\n      path: ./explicit-schema.json\n`,
    );
    const def = loadWorkflowFromFile(join(tmpDir, 'workflow.yaml'));
    expect(def.workflow_context!['schema']!.source.path).toBe(join(tmpDir, 'explicit-schema.json'));
  });

  it('schema.json absent → workflow_context.schema not created', () => {
    writeFileSync(join(tmpDir, 'workflow.yaml'), baseYaml);
    const def = loadWorkflowFromFile(join(tmpDir, 'workflow.yaml'));
    expect(def.workflow_context?.['schema']).toBeUndefined();
  });
});

describe('MCP tools validation', () => {
  const MCP_BASE_YAML = `
id: mcp-test
name: MCP Test
version: 1
mcp_servers:
  - id: github
    command: npx
    args: [-y, '@modelcontextprotocol/server-github']
steps:
  step-one:
    description: First step
    execution: auto
    depends_on: []
  step-two:
    description: Agent step with tools
    execution: agent
    depends_on: [step-one]
    input_schema:
      type: object
      properties:
        result:
          type: string
      required: [result]
    tools:
      - github:get_pull_request
`;

  it('tools on execution: auto step throws WorkflowError about only valid on agent', () => {
    const content = MCP_BASE_YAML.replace(
      'execution: auto',
      'execution: auto\n    tools:\n      - github:list_issues',
    ).replace(
      'input_schema:\n      type: object\n      properties:\n        result:\n          type: string\n      required: [result]\n    tools:\n      - github:get_pull_request',
      '',
    );
    expect(() => loadWorkflowFromString(content)).toThrow(WorkflowError);
    try {
      loadWorkflowFromString(content);
    } catch (err) {
      expect((err as WorkflowError).message).toContain('only valid on execution: agent steps');
    }
  });

  it('tools on a step with handler throws WorkflowError about only valid on agent steps', () => {
    const content = `
id: handler-tools-test
name: Handler Tools Test
version: 1
mcp_servers:
  - id: github
    command: npx
    args: [-y, '@modelcontextprotocol/server-github']
steps:
  step-one:
    description: Handler step with tools
    execution: agent
    handler: my_handler
    input_schema:
      type: object
      properties:
        result:
          type: string
      required: [result]
    tools:
      - github:get_pull_request
`;
    expect(() => loadWorkflowFromString(content)).toThrow(WorkflowError);
    try {
      loadWorkflowFromString(content);
    } catch (err) {
      expect((err as WorkflowError).message).toContain('only valid on execution: agent steps');
    }
  });

  it('tools without input_schema throws WorkflowError about requires input_schema', () => {
    const content = MCP_BASE_YAML.replace(
      '    input_schema:\n      type: object\n      properties:\n        result:\n          type: string\n      required: [result]\n    tools:\n      - github:get_pull_request',
      '    tools:\n      - github:get_pull_request',
    );
    expect(() => loadWorkflowFromString(content)).toThrow(WorkflowError);
    try {
      loadWorkflowFromString(content);
    } catch (err) {
      expect((err as WorkflowError).message).toContain("requires 'input_schema'");
    }
  });

  it('tools entry not in server_id:tool_name format throws WorkflowError', () => {
    const content = MCP_BASE_YAML.replace('- github:get_pull_request', '- invalid-format');
    expect(() => loadWorkflowFromString(content)).toThrow(WorkflowError);
    try {
      loadWorkflowFromString(content);
    } catch (err) {
      expect((err as WorkflowError).message).toContain("must be in 'server_id:tool_name' format");
    }
  });

  it('issue #338: tools declared with NO mcp_servers block at all is refused at load', () => {
    // The corner the server-reference check below could never see: it runs only when an
    // `mcp_servers` block EXISTS, so a workflow declaring tools without one loaded clean and ran
    // with its tools silently never offered.
    const content = MCP_BASE_YAML.replace(
      `mcp_servers:
  - id: github
    command: npx
    args: [-y, '@modelcontextprotocol/server-github']
`,
      '',
    );
    expect(() => loadWorkflowFromString(content)).toThrow(WorkflowError);
    try {
      loadWorkflowFromString(content);
    } catch (err) {
      const message = (err as WorkflowError).message;
      expect(message).toContain(
        "Step 'step-two': declares tools but the workflow defines no mcp_servers",
      );
      expect(message).toContain('can never be satisfied');
      expect(message).toContain("Define an mcp_servers block, or remove 'tools'");
      // ONE error for the step, not one per entry — the entries are not individually wrong.
      expect(message.match(/declares tools but the workflow defines no mcp_servers/g)).toHaveLength(
        1,
      );
    }
  });

  it('issue #338 CONTROL: an EMPTY tools array with no mcp_servers block still loads', () => {
    // The refusal is keyed on a non-empty declaration. An empty array declares nothing, so there
    // is nothing that can never be satisfied.
    const content = MCP_BASE_YAML.replace(
      `mcp_servers:
  - id: github
    command: npx
    args: [-y, '@modelcontextprotocol/server-github']
`,
      '',
    ).replace('    tools:\n      - github:get_pull_request', '    tools: []');
    expect(() => loadWorkflowFromString(content)).not.toThrow();
  });

  it('tools entry referencing unknown mcp_servers id throws WorkflowError', () => {
    const content = MCP_BASE_YAML.replace(
      '- github:get_pull_request',
      '- unknown-server:some_tool',
    );
    expect(() => loadWorkflowFromString(content)).toThrow(WorkflowError);
    try {
      loadWorkflowFromString(content);
    } catch (err) {
      expect((err as WorkflowError).message).toContain('references unknown MCP server');
    }
  });

  it('mcp_servers with duplicate id throws WorkflowError', () => {
    const content = `
id: dup-server-test
name: Dup Server Test
version: 1
mcp_servers:
  - id: github
    command: npx
    args: [-y, '@modelcontextprotocol/server-github']
  - id: github
    command: npx
    args: [-y, '@modelcontextprotocol/server-github']
steps:
  step-one:
    description: A step
    execution: auto
`;
    expect(() => loadWorkflowFromString(content)).toThrow(WorkflowError);
    try {
      loadWorkflowFromString(content);
    } catch (err) {
      expect((err as WorkflowError).message).toContain('duplicate server id');
    }
  });

  it('max_tool_calls: 0 throws WorkflowError about positive integer', () => {
    const content = MCP_BASE_YAML.replace(
      '    tools:\n      - github:get_pull_request',
      '    max_tool_calls: 0\n    tools:\n      - github:get_pull_request',
    );
    expect(() => loadWorkflowFromString(content)).toThrow(WorkflowError);
    try {
      loadWorkflowFromString(content);
    } catch (err) {
      expect((err as WorkflowError).message).toContain(
        "'max_tool_calls' must be a positive integer",
      );
    }
  });

  it('max_tool_calls: -1 throws WorkflowError about positive integer', () => {
    const content = MCP_BASE_YAML.replace(
      '    tools:\n      - github:get_pull_request',
      '    max_tool_calls: -1\n    tools:\n      - github:get_pull_request',
    );
    expect(() => loadWorkflowFromString(content)).toThrow(WorkflowError);
    try {
      loadWorkflowFromString(content);
    } catch (err) {
      expect((err as WorkflowError).message).toContain(
        "'max_tool_calls' must be a positive integer",
      );
    }
  });

  it('max_tool_calls: 1.5 throws WorkflowError about positive integer', () => {
    const content = MCP_BASE_YAML.replace(
      '    tools:\n      - github:get_pull_request',
      '    max_tool_calls: 1.5\n    tools:\n      - github:get_pull_request',
    );
    expect(() => loadWorkflowFromString(content)).toThrow(WorkflowError);
    try {
      loadWorkflowFromString(content);
    } catch (err) {
      expect((err as WorkflowError).message).toContain(
        "'max_tool_calls' must be a positive integer",
      );
    }
  });

  it('tool_timeout: 0 throws WorkflowError about positive integer', () => {
    const content = MCP_BASE_YAML.replace(
      '    tools:\n      - github:get_pull_request',
      '    tool_timeout: 0\n    tools:\n      - github:get_pull_request',
    );
    expect(() => loadWorkflowFromString(content)).toThrow(WorkflowError);
    try {
      loadWorkflowFromString(content);
    } catch (err) {
      expect((err as WorkflowError).message).toContain("'tool_timeout' must be a positive integer");
    }
  });

  it('valid tools on execution: agent with input_schema and known server loads without error', () => {
    expect(() => loadWorkflowFromString(MCP_BASE_YAML)).not.toThrow();
    const def = loadWorkflowFromString(MCP_BASE_YAML);
    expect(def.steps['step-two']?.tools).toEqual(['github:get_pull_request']);
    expect(def.mcp_servers).toHaveLength(1);
    expect(def.mcp_servers![0]!.id).toBe('github');
  });

  it('multiple validation errors in one workflow are all collected and thrown together', () => {
    const content = `
id: multi-error-test
name: Multi Error Test
version: 1
steps:
  step-one:
    description: Bad step
    execution: auto
    max_tool_calls: 0
    tool_timeout: -5
`;
    expect(() => loadWorkflowFromString(content)).toThrow(WorkflowError);
    try {
      loadWorkflowFromString(content);
    } catch (err) {
      const message = (err as WorkflowError).message;
      expect(message).toContain("'max_tool_calls' must be a positive integer");
      // REPOINTED by issue #413: this step is TOOLLESS, so `tool_timeout` no longer reaches the
      // shape check at all — it is refused outright. The cell's purpose is multi-error
      // COLLECTION, which two distinct errors exercise just as well; the shape pin itself lives
      // on a tools-bearing fixture above and stays green.
      expect(message).toContain("'tool_timeout' requires 'tools'");
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: timeout_seconds validation (issue A3)
// ---------------------------------------------------------------------------
describe('loadWorkflowFromString — timeout_seconds validation', () => {
  it('timeout_seconds: 0 on an auto step throws WorkflowError about positive integer', () => {
    const content = VALID_YAML.replace(
      'execution: auto',
      'execution: auto\n    timeout_seconds: 0',
    );
    expect(() => loadWorkflowFromString(content)).toThrow(WorkflowError);
    try {
      loadWorkflowFromString(content);
    } catch (err) {
      expect((err as WorkflowError).message).toContain(
        "'timeout_seconds' must be a positive integer",
      );
    }
  });

  it('timeout_seconds: -5 on an auto step throws WorkflowError about positive integer', () => {
    const content = VALID_YAML.replace(
      'execution: auto',
      'execution: auto\n    timeout_seconds: -5',
    );
    expect(() => loadWorkflowFromString(content)).toThrow(WorkflowError);
    try {
      loadWorkflowFromString(content);
    } catch (err) {
      expect((err as WorkflowError).message).toContain(
        "'timeout_seconds' must be a positive integer",
      );
    }
  });

  it('timeout_seconds: 1.5 on an auto step throws WorkflowError about positive integer', () => {
    const content = VALID_YAML.replace(
      'execution: auto',
      'execution: auto\n    timeout_seconds: 1.5',
    );
    expect(() => loadWorkflowFromString(content)).toThrow(WorkflowError);
    try {
      loadWorkflowFromString(content);
    } catch (err) {
      expect((err as WorkflowError).message).toContain(
        "'timeout_seconds' must be a positive integer",
      );
    }
  });

  it("timeout_seconds: 'x' (non-numeric) on an auto step throws WorkflowError about positive integer", () => {
    const content = VALID_YAML.replace(
      'execution: auto',
      "execution: auto\n    timeout_seconds: 'x'",
    );
    expect(() => loadWorkflowFromString(content)).toThrow(WorkflowError);
    try {
      loadWorkflowFromString(content);
    } catch (err) {
      expect((err as WorkflowError).message).toContain(
        "'timeout_seconds' must be a positive integer",
      );
    }
  });

  // The AUTO control for the issue-#402 prohibition below, and deliberately not duplicated
  // there: auto is where the key is actually enforced (`shouldEnforceTimeout` is
  // `execution === 'auto'`, claim-liveness.ts), so a check written as `!== 'agent'`-style
  // over-reach would red exactly here. One cell, one job.
  it('timeout_seconds: 60 (positive integer) on an auto step loads without error', () => {
    const content = VALID_YAML.replace(
      'execution: auto',
      'execution: auto\n    timeout_seconds: 60',
    );
    const def = loadWorkflowFromString(content);
    expect(def.steps['step-one']?.timeout_seconds).toBe(60);
  });

  // The FINALIZER control, and the reason issue #402's check reads `=== 'agent'` rather than
  // `!== 'auto'`: a finalizer consumes this key TWICE — the drain lease
  // (execution-loop.ts:5226) and the handler's own dispatch bound (:5030) — so a `!== 'auto'`
  // prohibition would break a working feature. That mutant reds exactly this cell, which is only
  // true because it is not duplicated anywhere else.
  it('timeout_seconds: 60 on a finalizer step loads without error (finalizers use their own drain-ceiling default)', () => {
    const content = `
id: finalizer-timeout-test
name: Finalizer Timeout Test
version: 1
steps:
  step-one:
    description: First step
    execution: auto
    depends_on: []
  cleanup:
    description: Cleanup
    execution: finalizer
    on_outcome: always
    handler: do_cleanup
    timeout_seconds: 60
`;
    const def = loadWorkflowFromString(content);
    expect(def.steps['cleanup']?.timeout_seconds).toBe(60);
  });

  // REPLACES the cell that pinned the pre-#402 acceptance ("loads without error (advisory
  // only…)"). That acceptance was the defect: nothing enforces the key on an agent step, and at
  // the time the engine also handed the driving agent an `expected_timeout` display built from
  // it, so the step looked time-bounded while nothing bounded anything. Issue #412 deleted that
  // display; the load error stays, because an author writing a bound that does nothing should be
  // told so rather than discover it.
  it('timeout_seconds on an agent step is a load error naming the bounds that DO exist', () => {
    const content = VALID_YAML.replace(
      'execution: agent',
      'execution: agent\n    timeout_seconds: 60',
    );
    expect(() => loadWorkflowFromString(content)).toThrow(WorkflowError);
    try {
      loadWorkflowFromString(content);
    } catch (err) {
      const message = (err as WorkflowError).message;
      expect(message).toContain("'timeout_seconds' is not valid on execution: agent steps");
      // The consequence, in the author's terms — not just "invalid".
      expect(message).toContain('LOOK');
      expect(message).toContain('never enforces it');
      // Both real bounds named, so the author is not left to hunt for the replacement. Scoped to
      // realm's own drive, because an external agent gets neither.
      expect(message).toContain('llm_timeout_seconds');
      expect(message).toContain('--llm-timeout');
      expect(message).toContain('tool_timeout');
      expect(message).toContain("realm's own drive");
      // And it points at the KEY's own line (issue #417), not the step's. The fixture puts
      // `timeout_seconds` on line 13 while `step-two:` is on line 10 — a number-agnostic regex
      // passes either way and would prove nothing about the move.
      expect(message).toContain('(line 13)');
    }
  });

  it('agent + timeout_seconds: -1 reports the prohibition ONLY, not also a shape error', () => {
    // The agent twin of the guard cell below: two messages for one root cause is how an author
    // ends up fixing the wrong thing first. Same suppression, same reason.
    const content = VALID_YAML.replace(
      'execution: agent',
      'execution: agent\n    timeout_seconds: -1',
    );
    try {
      loadWorkflowFromString(content);
      throw new Error('expected a load error');
    } catch (err) {
      const message = (err as WorkflowError).message;
      expect(message).toContain("'timeout_seconds' is not valid on execution: agent steps");
      expect(message).not.toContain("'timeout_seconds' must be a positive integer");
    }
  });

  it('agent + BOTH timeout keys: the prohibition fires, llm_timeout_seconds stays legal', () => {
    // The two checks must not reject each other's key. `llm_timeout_seconds` is the RIGHT key on
    // an agent step — an error telling the author it is "only valid on agent steps", on an agent
    // step, would be worse than useless.
    const content = VALID_YAML.replace(
      'execution: agent',
      'execution: agent\n    llm_timeout_seconds: 30\n    timeout_seconds: 60',
    );
    try {
      loadWorkflowFromString(content);
      throw new Error('expected a load error');
    } catch (err) {
      const message = (err as WorkflowError).message;
      expect(message).toContain("'timeout_seconds' is not valid on execution: agent steps");
      expect(message).not.toContain("'llm_timeout_seconds' is only valid");
    }
  });

  it('ACCUMULATION — a second unrelated error on the same step is still reported', () => {
    // The loader accumulates rather than stopping at the first problem, and the new check must
    // not become a short-circuit: an author fixing two things wants to see two things.
    const content = VALID_YAML.replace(
      'execution: agent',
      'execution: agent\n    timeout_seconds: 60\n    idempotent: true',
    );
    try {
      loadWorkflowFromString(content);
      throw new Error('expected a load error');
    } catch (err) {
      const message = (err as WorkflowError).message;
      expect(message).toContain("'timeout_seconds' is not valid on execution: agent steps");
      expect(message).toContain("'idempotent' is only valid on execution: auto steps");
    }
  });

  it('guard-prohibition is unchanged: timeout_seconds on a guard step reports exactly the prohibited-field error, not also a positive-integer error', () => {
    const yaml = `
id: guard-test
name: Guard Test
version: 1
steps:
  step_a:
    description: First step
    execution: agent
    depends_on: []
  guard_b:
    description: Guard step
    execution: guard
    depends_on: [step_a]
    abort_unless: "step_a.status == 'open'"
    timeout_seconds: 0
`;
    try {
      loadWorkflowFromString(yaml);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowError);
      const message = (err as WorkflowError).message;
      expect(message).toContain("'timeout_seconds' is not valid on execution: guard steps");
      expect(message).not.toContain("'timeout_seconds' must be a positive integer");
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: rate_limit validation
// ---------------------------------------------------------------------------

const VALID_YAML_WITH_SERVICE = `
id: test-workflow
name: Test Workflow
version: 1
services:
  my-service:
    adapter: airtable
    trust: engine_delivered
steps:
  step-one:
    description: First step
    execution: auto
    depends_on: []
    uses_service: my-service
`;

describe('loadWorkflowFromString — rate_limit validation', () => {
  it('rate_limit with valid requests_per_second — no error', () => {
    const content = VALID_YAML_WITH_SERVICE.replace(
      'trust: engine_delivered',
      'trust: engine_delivered\n    rate_limit:\n      requests_per_second: 2',
    );
    expect(() => loadWorkflowFromString(content)).not.toThrow();
  });

  it('rate_limit.requests_per_second = 0 — hard error', () => {
    const content = VALID_YAML_WITH_SERVICE.replace(
      'trust: engine_delivered',
      'trust: engine_delivered\n    rate_limit:\n      requests_per_second: 0',
    );
    expect(() => loadWorkflowFromString(content)).toThrow(WorkflowError);
    try {
      loadWorkflowFromString(content);
    } catch (err) {
      expect((err as WorkflowError).message).toContain('requests_per_second');
    }
  });

  it('rate_limit.requests_per_second = -1 — hard error', () => {
    const content = VALID_YAML_WITH_SERVICE.replace(
      'trust: engine_delivered',
      'trust: engine_delivered\n    rate_limit:\n      requests_per_second: -1',
    );
    expect(() => loadWorkflowFromString(content)).toThrow(WorkflowError);
  });

  it('rate_limit.burst without requests_per_second — hard error', () => {
    const content = VALID_YAML_WITH_SERVICE.replace(
      'trust: engine_delivered',
      'trust: engine_delivered\n    rate_limit:\n      burst: 5',
    );
    expect(() => loadWorkflowFromString(content)).toThrow(WorkflowError);
    try {
      loadWorkflowFromString(content);
    } catch (err) {
      expect((err as WorkflowError).message).toContain('burst');
    }
  });

  it('rate_limit.burst = 0 — hard error', () => {
    const content = VALID_YAML_WITH_SERVICE.replace(
      'trust: engine_delivered',
      'trust: engine_delivered\n    rate_limit:\n      requests_per_second: 2\n      burst: 0',
    );
    expect(() => loadWorkflowFromString(content)).toThrow(WorkflowError);
  });

  it('rate_limit.max_retry_seconds = 0 — hard error', () => {
    const content = VALID_YAML_WITH_SERVICE.replace(
      'trust: engine_delivered',
      'trust: engine_delivered\n    rate_limit:\n      requests_per_second: 2\n      max_retry_seconds: 0',
    );
    expect(() => loadWorkflowFromString(content)).toThrow(WorkflowError);
    try {
      loadWorkflowFromString(content);
    } catch (err) {
      expect((err as WorkflowError).message).toContain('max_retry_seconds');
    }
  });

  it('rate_limit.fallback_retry_seconds = 0 — hard error', () => {
    const content = VALID_YAML_WITH_SERVICE.replace(
      'trust: engine_delivered',
      'trust: engine_delivered\n    rate_limit:\n      requests_per_second: 2\n      fallback_retry_seconds: 0',
    );
    expect(() => loadWorkflowFromString(content)).toThrow(WorkflowError);
    try {
      loadWorkflowFromString(content);
    } catch (err) {
      expect((err as WorkflowError).message).toContain('fallback_retry_seconds');
    }
  });

  it('rate_limit.fallback_retry_seconds = -1 — hard error', () => {
    const content = VALID_YAML_WITH_SERVICE.replace(
      'trust: engine_delivered',
      'trust: engine_delivered\n    rate_limit:\n      requests_per_second: 2\n      fallback_retry_seconds: -1',
    );
    expect(() => loadWorkflowFromString(content)).toThrow(WorkflowError);
  });

  it('accepts min_retry_seconds on rate_limit without requests_per_second', () => {
    const content = VALID_YAML_WITH_SERVICE.replace(
      'trust: engine_delivered',
      'trust: engine_delivered\n    rate_limit:\n      min_retry_seconds: 30',
    );
    const def = loadWorkflowFromString(content);
    expect(def.services!['my-service']!.rate_limit?.min_retry_seconds).toBe(30);
  });

  // min_retry_seconds = 0 is invalid (must be > 0)
  it('rejects min_retry_seconds ≤ 0', () => {
    const content = VALID_YAML_WITH_SERVICE.replace(
      'trust: engine_delivered',
      'trust: engine_delivered\n    rate_limit:\n      min_retry_seconds: 0',
    );
    expect(() => loadWorkflowFromString(content)).toThrow(WorkflowError);
    try {
      loadWorkflowFromString(content);
    } catch (err) {
      expect((err as WorkflowError).message).toContain(
        "'rate_limit.min_retry_seconds' must be a positive number",
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: retry validation
// ---------------------------------------------------------------------------

describe('loadWorkflowFromString — retry validation', () => {
  it('retry.backoff invalid value — hard error', () => {
    const content = VALID_YAML.replace(
      'depends_on: []',
      'depends_on: []\n    retry:\n      max_attempts: 3\n      backoff: invalid_value',
    );
    expect(() => loadWorkflowFromString(content)).toThrow(WorkflowError);
    try {
      loadWorkflowFromString(content);
    } catch (err) {
      expect((err as WorkflowError).message).toContain('retry.backoff');
    }
  });

  it('retry.backoff omitted — no error (backoff is now optional)', () => {
    const content = VALID_YAML.replace(
      'depends_on: []',
      'depends_on: []\n    retry:\n      max_attempts: 3\n      base_delay_ms: 100',
    );
    expect(() => loadWorkflowFromString(content)).not.toThrow();
  });

  it('retry with only max_attempts — no error', () => {
    const content = VALID_YAML.replace(
      'depends_on: []',
      'depends_on: []\n    retry:\n      max_attempts: 2',
    );
    expect(() => loadWorkflowFromString(content)).not.toThrow();
  });
});

describe('issue #369 — `preconditions` is prohibited on a guard, with a message that earns it', () => {
  // Before this check, a guard could declare `preconditions` and the loader accepted it. The engine
  // then never evaluated it — `checkPreconditions` is reached only from `executeStep`, and a guard
  // goes through `executeGuardStep` — so the author shipped a workflow that LOOKED guarded and was
  // not. Accepted-and-meaningless is the class this whole PR refuses.
  const GUARD_WITH_PRECONDITIONS = `
id: guard-precond
name: Guard Precond
version: 1
steps:
  step_a:
    description: First step
    execution: agent
    depends_on: []
  guard_b:
    description: Guard step
    execution: guard
    depends_on: [step_a]
    abort_unless: "step_a.status == 'open'"
    preconditions:
      - "step_a.result.count > 0"
`;

  /** The joined loader message for a definition, or '' if it loaded. */
  function loadError(yaml: string): string {
    try {
      loadWorkflowFromString(yaml);
      return '';
    } catch (err) {
      return (err as WorkflowError).message;
    }
  }

  it('refuses the guard, naming the step', () => {
    expect(() => loadWorkflowFromString(GUARD_WITH_PRECONDITIONS)).toThrow(WorkflowError);
    expect(loadError(GUARD_WITH_PRECONDITIONS)).toContain(
      "Step 'guard_b': 'preconditions' is not valid on execution: guard steps",
    );
  });

  it('the message carries all four things it promises: cause, consequence, remedy, and the open question', () => {
    // Each clause is a separate claim the message makes, and each is pinned on its own — a message
    // that keeps the prohibition and quietly loses the remedy is still a worse message.
    const message = loadError(GUARD_WITH_PRECONDITIONS);
    // CAUSE — why it is prohibited, scoped exactly ("there", not "anywhere").
    expect(message).toContain('the engine never evaluates it there');
    expect(message).toContain("a guard's execution evaluates only 'abort_unless'");
    // CONSEQUENCE — the hazard, which no surveyed system prints.
    expect(message).toContain('so the run would LOOK guarded while the declared check never ran');
    // REMEDY — what to do instead.
    expect(message).toContain("Move the condition into 'abort_unless'");
    // THE OPEN QUESTION — worded as open, never as a decision. It must NOT say what preconditions
    // WOULD mean on a guard; that would pre-decide #366.
    expect(message).toContain('open design question (issue #366)');
    expect(message).toContain('if admitted later, existing workflows are unaffected');
  });

  it("the CAUSE clause's claim is only true while `checkPreconditions` has ONE engine call site", () => {
    // The message asserts the engine never evaluates preconditions on a guard. That rests entirely
    // on there being a single call site, inside `executeStep`. A second one added anywhere in the
    // engine would make this message a confident lie, and nothing else in the suite would notice.
    //
    // SCOPE, deliberately: `packages/core/src`, excluding tests, the definition in
    // precondition.ts, and the index re-export. The CLI's replay re-evaluator
    // (replay.ts:116-117) calls it twice and is NOT counted — replay reproduces `executeStep`
    // semantics for a completed run, it is not a guard surface, and it cannot make this message
    // false.
    const root = fileURLToPath(new URL('..', import.meta.url));
    const callSites: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (
          entry.name.endsWith('.ts') &&
          !entry.name.endsWith('.test.ts') &&
          entry.name !== 'precondition.ts' &&
          entry.name !== 'index.ts'
        ) {
          for (const line of readFileSync(full, 'utf8').split('\n')) {
            if (line.includes('checkPreconditions('))
              callSites.push(`${entry.name}: ${line.trim()}`);
          }
        }
      }
    };
    walk(root);
    expect(callSites).toHaveLength(1);
    expect(callSites[0]).toContain('execution-loop.ts');
  });

  it('CONTROL: the same guard without `preconditions` loads', () => {
    expect(() =>
      loadWorkflowFromString(
        GUARD_WITH_PRECONDITIONS.replace(
          '    preconditions:\n      - "step_a.result.count > 0"\n',
          '',
        ),
      ),
    ).not.toThrow();
  });

  it('CONTROL: `preconditions` on a NON-guard step is untouched', () => {
    // The prohibition is guard-scoped. Every other step kind evaluates preconditions for real.
    const nonGuard = `
id: precond-ok
name: Precond OK
version: 1
steps:
  step_a:
    description: First step
    execution: agent
    depends_on: []
  step_b:
    description: Second step
    execution: agent
    depends_on: [step_a]
    preconditions:
      - "step_a.result.count > 0"
`;
    expect(() => loadWorkflowFromString(nonGuard)).not.toThrow();
  });
});

describe('loadWorkflowFromString — guard step validation', () => {
  it('guard step with abort_unless string loads without error', () => {
    const yaml = `
id: guard-test
name: Guard Test
version: 1
steps:
  step_a:
    description: First step
    execution: agent
    depends_on: []
  guard_b:
    description: Guard step
    execution: guard
    depends_on: [step_a]
    abort_unless: "step_a.status == 'open'"
`;
    expect(() => loadWorkflowFromString(yaml)).not.toThrow();
  });

  it('guard step with abort_unless array loads without error', () => {
    const yaml = `
id: guard-test
name: Guard Test
version: 1
steps:
  step_a:
    description: First step
    execution: agent
    depends_on: []
  guard_b:
    description: Guard step
    execution: guard
    depends_on: [step_a]
    abort_unless:
      - "step_a.status == 'open'"
      - "step_a.count > 0"
`;
    expect(() => loadWorkflowFromString(yaml)).not.toThrow();
  });

  it('guard step with abort_message loads without error', () => {
    const yaml = `
id: guard-test
name: Guard Test
version: 1
steps:
  step_a:
    description: First step
    execution: agent
    depends_on: []
  guard_b:
    description: Guard step
    execution: guard
    depends_on: [step_a]
    abort_unless: "step_a.status == 'open'"
    abort_message: Ticket is not open
`;
    expect(() => loadWorkflowFromString(yaml)).not.toThrow();
  });

  it('guard step missing abort_unless throws WorkflowError', () => {
    const yaml = `
id: guard-test
name: Guard Test
version: 1
steps:
  step_a:
    description: First step
    execution: agent
    depends_on: []
  guard_b:
    description: Guard step
    execution: guard
    depends_on: [step_a]
`;
    try {
      loadWorkflowFromString(yaml);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowError);
      expect((err as WorkflowError).message).toContain('abort_unless');
    }
  });

  it('guard step with prohibited field (handler) throws WorkflowError', () => {
    const yaml = `
id: guard-test
name: Guard Test
version: 1
steps:
  step_a:
    description: First step
    execution: agent
    depends_on: []
  guard_b:
    description: Guard step
    execution: guard
    depends_on: [step_a]
    abort_unless: "step_a.status == 'open'"
    handler: some_handler
`;
    try {
      loadWorkflowFromString(yaml);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowError);
      expect((err as WorkflowError).message).toContain('handler');
    }
  });

  it('guard step with prohibited field (uses_service) throws WorkflowError', () => {
    const yaml = `
id: guard-test
name: Guard Test
version: 1
services:
  my_service:
    base_url: https://example.com
steps:
  step_a:
    description: First step
    execution: agent
    depends_on: []
  guard_b:
    description: Guard step
    execution: guard
    depends_on: [step_a]
    abort_unless: "step_a.status == 'open'"
    uses_service: my_service
`;
    try {
      loadWorkflowFromString(yaml);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowError);
      expect((err as WorkflowError).message).toContain('uses_service');
    }
  });

  it('guard step with prohibited field (trigger_rule) throws WorkflowError', () => {
    const yaml = `
id: guard-test
name: Guard Test
version: 1
steps:
  step_a:
    description: First step
    execution: agent
    depends_on: []
  guard_b:
    description: Guard step
    execution: guard
    depends_on: [step_a]
    abort_unless: "step_a.status == 'open'"
    trigger_rule: one_failed
`;
    try {
      loadWorkflowFromString(yaml);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowError);
      expect((err as WorkflowError).message).toContain('trigger_rule');
    }
  });

  it('abort_unless on a non-guard step throws WorkflowError', () => {
    const yaml = `
id: guard-test
name: Guard Test
version: 1
steps:
  step_a:
    description: First step
    execution: agent
    depends_on: []
    abort_unless: "step_a.status == 'open'"
`;
    try {
      loadWorkflowFromString(yaml);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowError);
      expect((err as WorkflowError).message).toContain('abort_unless');
    }
  });

  it('abort_message on a non-guard step throws WorkflowError', () => {
    const yaml = `
id: guard-test
name: Guard Test
version: 1
steps:
  step_a:
    description: First step
    execution: agent
    depends_on: []
    abort_message: Not allowed here
`;
    try {
      loadWorkflowFromString(yaml);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowError);
      expect((err as WorkflowError).message).toContain('abort_message');
    }
  });
});

describe('loadWorkflowFromString — adapter config validation', () => {
  const BASE_YAML = `
id: config-test
name: Config Test
version: 1
services:
  my_service:
    adapter: my_adapter
    trust: engine_delivered
steps:
  step_a:
    description: First step
    execution: agent
    depends_on: []
`;

  function makeAdapter(withSchema: boolean): ServiceAdapter {
    const base: ServiceAdapter = {
      id: 'my_adapter',
      fetch: async () => ({ status: 200, data: {} }),
      create: async () => ({ status: 201, data: {} }),
      update: async () => ({ status: 200, data: {} }),
    };
    if (withSchema) {
      return {
        ...base,
        config_schema: {
          type: 'object',
          properties: { table: { type: 'string' } },
          required: ['table'],
        },
      };
    }
    return base;
  }

  it('step with config targeting adapter with config_schema loads successfully', () => {
    const registry = new ExtensionRegistry();
    registry.register('adapter', 'my_adapter', makeAdapter(true));

    const yaml =
      BASE_YAML +
      `  fetch_step:
    description: Fetch from service
    execution: auto
    depends_on: [step_a]
    uses_service: my_service
    config:
      table: Tickets
`;
    const def = loadWorkflowFromString(yaml, registry);
    expect(def.steps['fetch_step']?.config).toEqual({ table: 'Tickets' });
  });

  it('step with config targeting adapter WITHOUT config_schema throws WorkflowError', () => {
    const registry = new ExtensionRegistry();
    registry.register('adapter', 'my_adapter', makeAdapter(false));

    const yaml =
      BASE_YAML +
      `  fetch_step:
    description: Fetch from service
    execution: auto
    depends_on: [step_a]
    uses_service: my_service
    config:
      table: Tickets
`;
    try {
      loadWorkflowFromString(yaml, registry);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowError);
      expect((err as WorkflowError).message).toContain("does not declare 'config_schema'");
    }
  });

  it('step config failing schema validation throws WorkflowError', () => {
    const registry = new ExtensionRegistry();
    registry.register('adapter', 'my_adapter', makeAdapter(true));

    const yaml =
      BASE_YAML +
      `  fetch_step:
    description: Fetch from service
    execution: auto
    depends_on: [step_a]
    uses_service: my_service
    config:
      table: 123
`;
    try {
      loadWorkflowFromString(yaml, registry);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowError);
      expect((err as WorkflowError).message).toContain('config validation failed');
    }
  });

  it('step with a nested object in config now loads (v1 ban lifted) when the adapter config_schema allows it', () => {
    const registry = new ExtensionRegistry();
    registry.register('adapter', 'my_adapter', {
      id: 'my_adapter',
      fetch: async () => ({ status: 200, data: {} }),
      create: async () => ({ status: 201, data: {} }),
      update: async () => ({ status: 200, data: {} }),
      config_schema: {
        type: 'object',
        properties: { retry: { type: 'object' } },
      },
    } as ServiceAdapter);

    const yaml =
      BASE_YAML +
      `  fetch_step:
    description: Fetch from service
    execution: auto
    depends_on: [step_a]
    uses_service: my_service
    config:
      retry:
        attempts: 3
        backoff: exponential
`;
    expect(() => loadWorkflowFromString(yaml, registry)).not.toThrow();
    const def = loadWorkflowFromString(yaml, registry);
    expect(def.steps['fetch_step']?.config).toEqual({
      retry: { attempts: 3, backoff: 'exponential' },
    });
  });

  it('a nested-object config that violates the adapter config_schema is still rejected (the real gate moved there, not vanished)', () => {
    const registry = new ExtensionRegistry();
    registry.register('adapter', 'my_adapter', makeAdapter(true)); // requires { table: string }

    const yaml =
      BASE_YAML +
      `  fetch_step:
    description: Fetch from service
    execution: auto
    depends_on: [step_a]
    uses_service: my_service
    config:
      table:
        nested: object
`;
    try {
      loadWorkflowFromString(yaml, registry);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowError);
      expect((err as WorkflowError).message).toContain('config validation failed');
    }
  });
});

describe('loadWorkflowFromString — uses_resources validation', () => {
  function makeHandler(id: string, usesResources?: string[]) {
    return {
      id,
      ...(usesResources !== undefined ? { uses_resources: usesResources } : {}),
      execute: async () => ({ data: {} }),
    };
  }

  const BASE_YAML = `
id: res-test
name: Resource Test
version: 1
steps:
  step-a:
    description: First step
    execution: auto
    depends_on: []
    handler: my_handler
  step-b:
    description: Second step
    execution: agent
    depends_on: [step-a]
`;

  it('valid reference — handler uses_resources points to existing step loads without error', () => {
    const registry = new ExtensionRegistry();
    registry.register('handler', 'my_handler', makeHandler('my_handler', ['step-b']));
    expect(() => loadWorkflowFromString(BASE_YAML, registry)).not.toThrow();
  });

  it('missing step ID — handler uses_resources references nonexistent step throws WorkflowError', () => {
    const registry = new ExtensionRegistry();
    registry.register('handler', 'my_handler', makeHandler('my_handler', ['nonexistent-step']));
    try {
      loadWorkflowFromString(BASE_YAML, registry);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowError);
      expect((err as WorkflowError).message).toContain(
        "declares uses_resources 'nonexistent-step' but no step with that ID exists in this workflow",
      );
    }
  });

  it('no registry — uses_resources check is silently skipped', () => {
    // Registry is not passed; validation must not throw even if uses_resources
    // references a nonexistent step (the handler is not inspectable without a registry).
    expect(() => loadWorkflowFromString(BASE_YAML)).not.toThrow();
  });

  it('handler not in registry — skips uses_resources check without error', () => {
    // The step declares handler: 'unknown-handler' but the registry does not contain it.
    // The loader must not throw — handler-not-found is a runtime concern, not a loader concern.
    const registry = new ExtensionRegistry();
    // Intentionally do not register 'my_handler'.
    expect(() => loadWorkflowFromString(BASE_YAML, registry)).not.toThrow();
  });

  it('handler without uses_resources — no regression, loads without error', () => {
    const registry = new ExtensionRegistry();
    registry.register('handler', 'my_handler', makeHandler('my_handler'));
    expect(() => loadWorkflowFromString(BASE_YAML, registry)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Gap B — reserved step names
// ---------------------------------------------------------------------------

describe('reserved step names', () => {
  it("step named 'run' is rejected with a reserved-name error", () => {
    const yaml = `
id: wf
name: WF
version: 1
steps:
  run:
    description: reserved step name
    execution: auto
    handler: my_handler
`;
    expect(() => loadWorkflowFromString(yaml)).toThrow(WorkflowError);
    try {
      loadWorkflowFromString(yaml);
    } catch (err) {
      expect((err as WorkflowError).message).toContain("'run'");
      expect((err as WorkflowError).message).toContain('reserved');
    }
  });

  it("step named 'context' is rejected with a reserved-name error", () => {
    const yaml = `
id: wf
name: WF
version: 1
steps:
  context:
    description: reserved step name
    execution: agent
`;
    expect(() => loadWorkflowFromString(yaml)).toThrow(WorkflowError);
    try {
      loadWorkflowFromString(yaml);
    } catch (err) {
      expect((err as WorkflowError).message).toContain("'context'");
      expect((err as WorkflowError).message).toContain('reserved');
    }
  });
});

// ---------------------------------------------------------------------------
// Gap C — input_map on handler steps
// ---------------------------------------------------------------------------

describe('input_map on handler steps', () => {
  it('handler step with input_map is accepted by the loader', () => {
    const yaml = `
id: wf
name: WF
version: 1
steps:
  fetch_data:
    description: Fetch data with input map
    execution: auto
    handler: my_handler
    input_map:
      key:
        $literal: CS_Macros
`;
    expect(() => loadWorkflowFromString(yaml)).not.toThrow();
    const def = loadWorkflowFromString(yaml);
    expect(def.steps['fetch_data']?.input_map).toBeDefined();
  });

  it('execution: agent step with input_map is rejected with a clear error', () => {
    const yaml = `
id: wf
name: WF
version: 1
steps:
  classify:
    description: Classify
    execution: agent
    input_map:
      key: run.params.value
`;
    expect(() => loadWorkflowFromString(yaml)).toThrow(WorkflowError);
    try {
      loadWorkflowFromString(yaml);
    } catch (err) {
      expect((err as WorkflowError).message).toContain('input_map');
      expect((err as WorkflowError).message).toContain('auto');
    }
  });
});

describe('trigger: block validation', () => {
  /** Wraps a top-level `trigger:` block (column 0) into a complete valid workflow. */
  const wf = (trigger: string): string => `
id: wf-trigger
name: WF Trigger
version: 1
${trigger}
steps:
  step-one:
    description: First
    execution: auto
    depends_on: []
`;

  it('valid Gorgias shared_secret trigger → loads', () => {
    const trigger = `trigger:
  type: webhook
  path: /hooks/gorgias
  auth:
    mode: shared_secret
    header: Authorization
    secret_from: GORGIAS_WEBHOOK_TOKEN
  filter:
    all:
      - { path: body.type, value: [ticket-created, ticket-message-created] }
  dedup:
    id_from: body.id
  params_map:
    ticket_id: body.id`;
    const def = loadWorkflowFromString(wf(trigger));
    expect(def.trigger?.type).toBe('webhook');
    expect(def.trigger?.auth.mode).toBe('shared_secret');
  });

  it('each HMAC-preset auth mode loads', () => {
    for (const auth of [
      `mode: github
    secret_from: GH_SECRET`,
      `mode: stripe
    secret_from: STRIPE_SECRET
    max_age_seconds: 300`,
      `mode: hmac
    secret_from: HMAC_SECRET
    header: x-signature`,
      `mode: none`,
    ]) {
      const trigger = `trigger:
  type: webhook
  auth:
    ${auth}`;
      expect(() => loadWorkflowFromString(wf(trigger))).not.toThrow();
    }
  });

  it('auth missing → error', () => {
    const trigger = `trigger:
  type: webhook`;
    expect(() => loadWorkflowFromString(wf(trigger))).toThrow(/auth/);
  });

  it('shared_secret missing header → error', () => {
    const trigger = `trigger:
  type: webhook
  auth:
    mode: shared_secret
    secret_from: TOKEN`;
    expect(() => loadWorkflowFromString(wf(trigger))).toThrow(/header/);
  });

  it('invalid auth mode → error', () => {
    const trigger = `trigger:
  type: webhook
  auth:
    mode: paypal
    secret_from: TOKEN`;
    expect(() => loadWorkflowFromString(wf(trigger))).toThrow(/mode/);
  });

  it('cross-mode field bleed (github + algorithm) → error', () => {
    const trigger = `trigger:
  type: webhook
  auth:
    mode: github
    secret_from: GH_SECRET
    algorithm: sha256`;
    expect(() => loadWorkflowFromString(wf(trigger))).toThrow(/unknown property|algorithm/);
  });

  it('dedup missing id_from → error (clean message, no const/oneOf noise)', () => {
    const trigger = `trigger:
  type: webhook
  auth:
    mode: none
  dedup:
    ttl_minutes: 60`;
    let message = '';
    try {
      loadWorkflowFromString(wf(trigger));
    } catch (err) {
      message = (err as WorkflowError).message;
    }
    expect(message).toMatch(/id_from/);
    expect(message).not.toMatch(/equal to constant/);
    expect(message).not.toMatch(/oneOf/);
  });

  it('filter both header and path → clear XOR message', () => {
    const trigger = `trigger:
  type: webhook
  auth:
    mode: none
  filter:
    header: x-h
    path: body.x
    value: v`;
    expect(() => loadWorkflowFromString(wf(trigger))).toThrow(/exactly one of 'header' or 'path'/);
  });

  it('filter shorthand → normalised to { all: [condition] }', () => {
    const trigger = `trigger:
  type: webhook
  auth:
    mode: none
  filter:
    header: x-event
    value: push`;
    const def = loadWorkflowFromString(wf(trigger));
    expect(def.trigger?.filter).toEqual({ all: [{ header: 'x-event', value: 'push' }] });
  });

  it('params_map non-string value → error', () => {
    const trigger = `trigger:
  type: webhook
  auth:
    mode: none
  params_map:
    ticket_id: 123`;
    expect(() => loadWorkflowFromString(wf(trigger))).toThrow(/params_map/);
  });

  it("typo'd trigger key → error", () => {
    const trigger = `trigger:
  type: webhook
  auth:
    mode: none
  dedpu: false`;
    expect(() => loadWorkflowFromString(wf(trigger))).toThrow(/unknown property|dedpu/);
  });
});

// ---------------------------------------------------------------------------
// Condition leaf validation: when / abort_unless / preconditions (Change 1b/2/3)
// ---------------------------------------------------------------------------

describe('loadWorkflowFromString — when/abort_unless/preconditions validation', () => {
  /** A two-step workflow where `gate`/`act` can carry a `when`/`preconditions` block. */
  function wf(actBlock: string): string {
    return `
id: cond-wf
name: Cond WF
version: 1
steps:
  classify:
    description: classify
    execution: agent
    depends_on: []
  act:
    description: act
    execution: agent
    depends_on: [classify]
${actBlock}
`;
  }

  // --- Change 3: when string | string[] ---
  it('accepts a single-string when referencing a direct dependency', () => {
    expect(() =>
      loadWorkflowFromString(wf('    when: "classify.category == \'billing\'"')),
    ).not.toThrow();
  });

  it('accepts a string[] when (implicit AND) of valid leaves', () => {
    const block =
      '    when:\n      - "classify.category == \'billing\'"\n      - "classify.confidence >= 0.8"';
    expect(() => loadWorkflowFromString(wf(block))).not.toThrow();
  });

  it('rejects an empty when array', () => {
    expect(() => loadWorkflowFromString(wf('    when: []'))).toThrow(
      /'when' array must not be empty/,
    );
  });

  it('preserves a bare-path leaf inside a when array', () => {
    const block = '    when:\n      - "classify.ready"\n      - "classify.category == \'billing\'"';
    expect(() => loadWorkflowFromString(wf(block))).not.toThrow();
  });

  // --- 1b: compound rejection with actionable echo ---
  it('rejects a compound `and` when string with an actionable list-form message', () => {
    let msg = '';
    try {
      loadWorkflowFromString(
        wf('    when: "classify.category == \'billing\' and classify.confidence >= 0.8"'),
      );
    } catch (e) {
      msg = (e as WorkflowError).message;
    }
    expect(msg).toContain("'when' uses unsupported 'and' — write it as a list:");
    expect(msg).toContain('- "classify.category == \'billing\'"');
    expect(msg).toContain('- "classify.confidence >= 0.8"');
  });

  it('rejects a compound `or` when string', () => {
    expect(() =>
      loadWorkflowFromString(wf('    when: "classify.a == 1 or classify.b == 2"')),
    ).toThrow(/uses unsupported 'or'/);
  });

  it('rejects a when leaf with multiple comparison operators', () => {
    expect(() => loadWorkflowFromString(wf('    when: "classify.a == classify.b == 1"'))).toThrow(
      /multiple comparison operators/,
    );
  });

  // --- 1a quote-aware: operator inside quotes does NOT trip compound/multi-op detection ---
  it('accepts a when whose quoted RHS contains an operator', () => {
    expect(() =>
      loadWorkflowFromString(wf('    when: "classify.subject == \'a >= b\'"')),
    ).not.toThrow();
  });

  // --- Change 2: direct-depends_on reference check (when only) ---
  it('rejects a when referencing a step not in depends_on', () => {
    expect(() => loadWorkflowFromString(wf('    when: "other_step.x == 1"'))).toThrow(
      /references step 'other_step' which is not in its depends_on/,
    );
  });

  it('accepts a when referencing run.params.*', () => {
    expect(() =>
      loadWorkflowFromString(wf('    when: "run.params.mode == \'live\'"')),
    ).not.toThrow();
  });

  it('rejects a when referencing run.<not-params>', () => {
    expect(() => loadWorkflowFromString(wf('    when: "run.something == 1"'))).toThrow(
      /only 'run.params.\*' is available/,
    );
  });

  // --- Scope B: preconditions ---
  it('rejects a compound precondition', () => {
    const block = '    preconditions:\n      - "classify.count > 0 and classify.ok == true"';
    expect(() => loadWorkflowFromString(wf(block))).toThrow(
      /'preconditions' uses unsupported 'and'/,
    );
  });

  it('rejects a bare-path precondition (must be a comparison)', () => {
    const block = '    preconditions:\n      - "classify.ready"';
    expect(() => loadWorkflowFromString(wf(block))).toThrow(/must be a comparison/);
  });

  it('accepts a valid comparison precondition', () => {
    const block = '    preconditions:\n      - "classify.count > 0"';
    expect(() => loadWorkflowFromString(wf(block))).not.toThrow();
  });

  // --- Scope B: abort_unless (guard step) ---
  function guardWf(abortBlock: string): string {
    return `
id: guard-wf
name: Guard WF
version: 1
steps:
  classify:
    description: classify
    execution: agent
    depends_on: []
  gate:
    description: gate
    execution: guard
    depends_on: [classify]
${abortBlock}
`;
  }

  it('rejects a compound abort_unless', () => {
    const block = '    abort_unless:\n      - "classify.a == 1 and classify.b == 2"';
    expect(() => loadWorkflowFromString(guardWf(block))).toThrow(
      /'abort_unless' uses unsupported 'and'/,
    );
  });

  it('accepts a valid abort_unless (string and array)', () => {
    expect(() =>
      loadWorkflowFromString(guardWf('    abort_unless: "classify.a == 1"')),
    ).not.toThrow();
    const block = '    abort_unless:\n      - "classify.a == 1"\n      - "classify.b != null"';
    expect(() => loadWorkflowFromString(guardWf(block))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Reject depends_on cycles (issue #153) — detection-only, load-time DAG cycle check.
// detectDependencyCycles is module-private (the codebase's established pattern for a
// single-caller pure helper — see eligibility.ts's canTriggerRuleEverBeSatisfied); its
// behavior is exercised entirely through the two public load entry points.
// ---------------------------------------------------------------------------

describe('dependency cycle detection (issue #153)', () => {
  function expectThrowsWithMessage(yaml: string, ...substrings: string[]): void {
    expect(() => loadWorkflowFromString(yaml)).toThrow(WorkflowError);
    try {
      loadWorkflowFromString(yaml);
      throw new Error('expected loadWorkflowFromString to throw');
    } catch (err) {
      for (const s of substrings) {
        expect((err as WorkflowError).message).toContain(s);
      }
    }
  }

  it('direct cycle a<->b throws, naming both steps', () => {
    const yaml = `
id: cycle-direct
name: Direct Cycle
version: 1
steps:
  a:
    description: Step A
    execution: agent
    depends_on: [b]
  b:
    description: Step B
    execution: agent
    depends_on: [a]
`;
    expectThrowsWithMessage(yaml, 'dependency cycle', 'a', 'b');
  });

  it('transitive cycle a->b->c->a throws, naming all three steps', () => {
    const yaml = `
id: cycle-transitive
name: Transitive Cycle
version: 1
steps:
  a:
    description: Step A
    execution: agent
    depends_on: [b]
  b:
    description: Step B
    execution: agent
    depends_on: [c]
  c:
    description: Step C
    execution: agent
    depends_on: [a]
`;
    expectThrowsWithMessage(yaml, 'dependency cycle', 'a', 'b', 'c');
  });

  it('self-dependency still yields exactly the existing "cannot depend on itself" error — no double-report', () => {
    const yaml = `
id: self-dep
name: Self Dep
version: 1
steps:
  a:
    description: Step A
    execution: agent
    depends_on: [a]
`;
    expect(() => loadWorkflowFromString(yaml)).toThrow(WorkflowError);
    try {
      loadWorkflowFromString(yaml);
      throw new Error('expected loadWorkflowFromString to throw');
    } catch (err) {
      const message = (err as WorkflowError).message;
      expect(message).toContain('a step cannot depend on itself');
      // The self-edge is excluded from the cycle graph — must not ALSO report a cycle.
      expect(message).not.toContain('dependency cycle');
      // Exactly one error total for this workflow (the self-dep message, nothing else).
      expect(message.split(';').map((s) => s.trim())).toHaveLength(1);
    }
  });

  it('acyclic diamond (a depends on b and c, both depend on d) loads clean', () => {
    const yaml = `
id: diamond
name: Diamond
version: 1
steps:
  d:
    description: Step D
    execution: agent
  b:
    description: Step B
    execution: agent
    depends_on: [d]
  c:
    description: Step C
    execution: agent
    depends_on: [d]
  a:
    description: Step A
    execution: agent
    depends_on: [b, c]
`;
    expect(() => loadWorkflowFromString(yaml)).not.toThrow();
  });

  it('acyclic domain DAG plus a finalizer step loads clean (finalizer correctly excluded from the graph)', () => {
    const yaml = `
id: with-finalizer
name: With Finalizer
version: 1
steps:
  a:
    description: Step A
    execution: agent
  b:
    description: Step B
    execution: agent
    depends_on: [a]
  cleanup:
    description: Cleanup
    execution: finalizer
    on_outcome: always
    handler: do_cleanup
`;
    expect(() => loadWorkflowFromString(yaml)).not.toThrow();
  });

  it('a cycle plus an unrelated error in the same workflow both surface (accumulation, no early-return)', () => {
    const yaml = `
id: cycle-plus-error
name: Cycle Plus Error
version: 1
steps:
  a:
    description: Step A
    execution: agent
    depends_on: [b]
    service_method: invalid_value
  b:
    description: Step B
    execution: agent
    depends_on: [a]
`;
    expectThrowsWithMessage(yaml, 'dependency cycle', 'invalid service_method');
  });

  it('disjoint multiple cycles in the same workflow are each reported once', () => {
    const yaml = `
id: multi-cycle
name: Multi Cycle
version: 1
steps:
  a:
    description: Step A
    execution: agent
    depends_on: [b]
  b:
    description: Step B
    execution: agent
    depends_on: [a]
  x:
    description: Step X
    execution: agent
    depends_on: [y]
  y:
    description: Step Y
    execution: agent
    depends_on: [x]
`;
    expect(() => loadWorkflowFromString(yaml)).toThrow(WorkflowError);
    try {
      loadWorkflowFromString(yaml);
      throw new Error('expected loadWorkflowFromString to throw');
    } catch (err) {
      const message = (err as WorkflowError).message;
      const cycleMentions = message.match(/dependency cycle/g) ?? [];
      expect(cycleMentions).toHaveLength(2); // one per disjoint cycle, not deduped into one
      expect(message).toContain('a');
      expect(message).toContain('b');
      expect(message).toContain('x');
      expect(message).toContain('y');
    }
  });

  it('rejects a cycle via BOTH load entry points (loadWorkflowFromString and loadWorkflowFromFile)', () => {
    const yaml = `
id: cycle-both-entries
name: Cycle Both Entries
version: 1
steps:
  a:
    description: Step A
    execution: agent
    depends_on: [b]
  b:
    description: Step B
    execution: agent
    depends_on: [a]
`;
    // Extension-free path.
    expectThrowsWithMessage(yaml, 'dependency cycle');

    // File path.
    const tmpDir = mkdtempSync(join(tmpdir(), 'realm-cycle-test-'));
    try {
      const filePath = join(tmpDir, 'workflow.yaml');
      writeFileSync(filePath, yaml);
      expect(() => loadWorkflowFromFile(filePath)).toThrow(WorkflowError);
      try {
        loadWorkflowFromFile(filePath);
        throw new Error('expected loadWorkflowFromFile to throw');
      } catch (err) {
        expect((err as WorkflowError).message).toContain('dependency cycle');
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('unknown-key warnings (issue #144)', () => {
  it('unknown step key warns, is not validated against anything, and the workflow still loads', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const def = loadWorkflowFromString(`
id: unknown-step-key-wf
name: Unknown Step Key
version: 1
steps:
  step-one:
    description: First step
    execution: auto
    not_a_real_key: true
`);
    expect(def.steps['step-one']?.description).toBe('First step');
    expect(def.steps['step-one']?.execution).toBe('auto');
    const out = warn.mock.calls.flat().join('\n');
    // SPLIT PINS (issue #392): the message now carries a source position between the key and the
    // '— ignored' clause, so the two halves are asserted separately. Keeping them as one string
    // would make this cell red whenever positions change, and it is not a position test.
    expect(out).toContain("step 'step-one': unknown key 'not_a_real_key'");
    expect(out).toContain('— ignored (not a recognized step field).');
    // reds under probe (a) — deliberate: this half IS the position.
    expect(out).toContain("unknown key 'not_a_real_key' (line 9) — ignored");
    warn.mockRestore();
  });

  it('unknown workflow-level key warns and the workflow still loads', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const def = loadWorkflowFromString(`
id: unknown-wf-key-wf
name: Unknown Workflow Key
version: 1
not_a_real_workflow_key: true
steps:
  step-one:
    description: First step
    execution: auto
`);
    expect(def.id).toBe('unknown-wf-key-wf');
    const out = warn.mock.calls.flat().join('\n');
    // SPLIT PINS (issue #392) — see the cell above.
    expect(out).toContain("workflow 'unknown-wf-key-wf': unknown key 'not_a_real_workflow_key'");
    expect(out).toContain('— ignored (not a recognized workflow field).');
    // reds under probe (a) — deliberate.
    expect(out).toContain("unknown key 'not_a_real_workflow_key' (line 5) — ignored");
    warn.mockRestore();
  });

  it('hand-authoring a runtime-only key (schema_version) warns — proves the authorable/runtime-only partition', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const def = loadWorkflowFromString(`
id: runtime-only-key-wf
name: Runtime Only Key
version: 1
schema_version: 999
model: gpt-4
steps:
  step-one:
    description: First step
    execution: auto
`);
    // The loader's own stamp wins regardless — the authored value never takes effect.
    expect(def.schema_version).toBe(CURRENT_WORKFLOW_SCHEMA_VERSION);
    const out = warn.mock.calls.flat().join('\n');
    expect(out).toContain("workflow 'runtime-only-key-wf': unknown key 'schema_version'");
    expect(out).toContain("workflow 'runtime-only-key-wf': unknown key 'model'");
    warn.mockRestore();
  });

  it('a valid trigger: workflow loads with no unknown-key warning — trigger is authorable', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const def = loadWorkflowFromString(`
id: trigger-no-warn-wf
name: Trigger No Warn
version: 1
trigger:
  type: webhook
  auth:
    mode: none
steps:
  step-one:
    description: First step
    execution: auto
`);
    expect(def.trigger?.type).toBe('webhook');
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('a close-typo step key ("dependson") warns with a did_you_mean suggestion (issue #169)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const def = loadWorkflowFromString(`
id: typo-step-key-wf
name: Typo Step Key
version: 1
steps:
  step-one:
    description: First step
    execution: agent
  step-two:
    description: Second step
    execution: auto
    dependson: [step-one]
`);
    expect(def.steps['step-two']?.description).toBe('Second step');
    const out = warn.mock.calls.flat().join('\n');
    // SPLIT PINS (issue #392) — see the first cell in this describe.
    expect(out).toContain("step 'step-two': unknown key 'dependson'");
    expect(out).toContain("— ignored (did you mean 'depends_on'?)");
    // reds under probe (a) — deliberate.
    expect(out).toContain("unknown key 'dependson' (line 12) — ignored");
    warn.mockRestore();
  });

  it('a far/unrelated unknown step key ("produces_state") warns with NO did_you_mean suggestion (issue #169)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const def = loadWorkflowFromString(`
id: far-key-wf
name: Far Key
version: 1
steps:
  step-one:
    description: First step
    execution: auto
    produces_state: done
`);
    expect(def.steps['step-one']?.description).toBe('First step');
    const out = warn.mock.calls.flat().join('\n');
    // SPLIT PINS (issue #392) — see the first cell in this describe.
    expect(out).toContain("step 'step-one': unknown key 'produces_state'");
    expect(out).toContain('— ignored (not a recognized step field).');
    // reds under probe (a) — deliberate.
    expect(out).toContain("unknown key 'produces_state' (line 9) — ignored");
    expect(out).not.toContain('did you mean');
    warn.mockRestore();
  });
});

describe('loadWorkflowFromString — llm_timeout_seconds validation (issue #401)', () => {
  const wf = (execution: string, extra = 'llm_timeout_seconds: 30'): string => `
id: test-wf
name: Test
version: 1
steps:
  the-step:
    description: A step
    execution: ${execution}
    ${execution === 'auto' ? 'service: svc\n    operation: op' : ''}
    ${extra}
`;

  // Per member, not "everything except agent": each kind is its own load error because each one
  // would have accepted a key that can never do anything there.
  for (const kind of ['auto', 'guard', 'finalizer']) {
    it(`llm_timeout_seconds on a ${kind} step is a load error`, () => {
      expect(() => loadWorkflowFromString(wf(kind))).toThrow(WorkflowError);
      try {
        loadWorkflowFromString(wf(kind));
      } catch (err) {
        expect((err as WorkflowError).message).toContain(
          "llm_timeout_seconds' is only valid on execution: agent steps",
        );
      }
    });
  }

  it('llm_timeout_seconds on an agent step LOADS, and the value survives', () => {
    const def = loadWorkflowFromString(wf('agent'));
    expect(def.steps['the-step']?.llm_timeout_seconds).toBe(30);
  });

  it('an agent step without the key loads with the key absent — never a fabricated default', () => {
    // The default lives in the drive (and in the CLI flag), not in the definition. A loader that
    // stamped 600 here would make every workflow file claim a timeout its author never wrote.
    const def = loadWorkflowFromString(wf('agent', 'agent_profile: p'));
    expect(def.steps['the-step']?.llm_timeout_seconds).toBeUndefined();
  });

  for (const [label, value] of [
    ['zero', '0'],
    ['negative', '-5'],
    ['fractional', '1.5'],
    ['a string', "'30'"],
  ] as const) {
    it(`llm_timeout_seconds of ${label} is refused`, () => {
      expect(() => loadWorkflowFromString(wf('agent', `llm_timeout_seconds: ${value}`))).toThrow(
        /must be a positive integer/,
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Tests: tool_timeout requires tools (issue #413)
//
// `tool_timeout` bounds ONE tool call inside the agentic loop (run-agent.ts). A step with no
// tools never enters that loop, so the key sits there bounding nothing — an author who wrote it
// believes tool calls are capped on a step that makes none. The predicate keys on TOOLS, never on
// execution kind: the day `tools` becomes legal somewhere new, this follows it automatically.
// ---------------------------------------------------------------------------

describe('loadWorkflowFromString — tool_timeout requires tools (issue #413)', () => {
  /**
   * Counts the errors in a thrown loader message.
   *
   * By the per-error `Step '<name>':` prefix, NOT by splitting on the '; ' the loader joins with:
   * this issue's own message contains a semicolon, so a naive split reported 3 errors where there
   * were 2 — the instrument, not the behaviour. Verified against a real two-error message.
   */
  const errorCount = (message: string): number => (message.match(/Step '/g) ?? []).length;

  /**
   * A two-step workflow whose second step is the subject. `depends_on` is omitted for finalizers
   * because they prohibit it — a fixture that sets it mints a SECOND error and the "exactly one"
   * assertions below would then be measuring the fixture rather than the rule.
   */
  const step = (execution: string, body: string): string => `
id: tt-test
name: Tool Timeout Test
version: 1
steps:
  first:
    description: First step
    execution: auto
    depends_on: []
  subject:
    description: The step under test
    execution: ${execution}
${execution === 'finalizer' ? '' : '    depends_on: [first]\n'}${body}
`;

  /**
   * A tools-BEARING agent step, self-contained: the `mcp_servers` block and `input_schema` are
   * both present because the other `tools` rules would otherwise speak over the one under test.
   */
  const TOOLS_YAML = `
id: tt-tools-test
name: Tool Timeout Tools Test
version: 1
mcp_servers:
  - id: github
    command: npx
    args: [-y, '@modelcontextprotocol/server-github']
steps:
  first:
    description: First step
    execution: auto
    depends_on: []
  subject:
    description: Agent step with tools
    execution: agent
    depends_on: [first]
    input_schema:
      type: object
      properties:
        result:
          type: string
      required: [result]
    tools:
      - github:get_pull_request
`;

  const loadError = (content: string): string => {
    try {
      loadWorkflowFromString(content);
      throw new Error('expected a load error');
    } catch (err) {
      return (err as WorkflowError).message;
    }
  };

  it('a TOOLLESS agent step with tool_timeout is a load error that says what it needs', () => {
    const message = loadError(step('agent', '    tool_timeout: 30'));
    // The parenthetical is load-bearing for the `tools: []` author, who can SEE the key and would
    // otherwise read "requires 'tools'" as a claim about something already on the page.
    expect(message).toContain("'tool_timeout' requires 'tools' (a declared, non-empty list)");
    // The consequence, in the author's terms.
    expect(message).toContain('nothing for it to bound');
    expect(message).toContain('a bound with nothing to bind');
    // The runtime facts the message asserts — both of them.
    expect(message).toContain("realm's own drive");
    expect(message).toContain('default 30');
    // The remedy, phrased so an author who wrote `tools: []` is not told to add a key they have.
    expect(message).toContain('declare at least one tool or remove the key');
    // The KEY's own line (issue #417), not the step's — see the twin note on the #402 cell.
    // 14 is `tool_timeout`; `subject:` is on line 10. Taken from the loader, not counted by eye:
    // a hand-counted line number is the #392 hazard in the test rather than in the product.
    expect(message).toContain('(line 14)');
  });

  // Per member, because the predicate is kind-agnostic and each kind reaches it differently:
  // guard and finalizer ban `tools` outright, auto restricts it, and none of that is what makes
  // this fire — the ABSENCE of tools is.
  for (const kind of ['auto', 'guard', 'finalizer']) {
    it(`a ${kind} step with tool_timeout reports exactly ONE error — the prohibition`, () => {
      // Each kind's own required shape, satisfied — an empty `abort_unless` and a finalizer
      // with `depends_on` are both refused in their own right, and either would make the
      // one-error assertion below pass or fail for reasons unrelated to tool_timeout.
      const body =
        kind === 'finalizer'
          ? '    on_outcome: always\n    handler: do_cleanup\n    tool_timeout: 30'
          : kind === 'guard'
            ? "    abort_unless: ['first.result']\n    tool_timeout: 30"
            : '    tool_timeout: 30';
      const message = loadError(step(kind, body));
      expect(message).toContain("'tool_timeout' requires 'tools'");
      expect(errorCount(message)).toBe(1);
    });
  }

  it('CONTROL — a tools-bearing agent step with tool_timeout is legal', () => {
    const def = loadWorkflowFromString(
      TOOLS_YAML.replace('    tools:', '    tool_timeout: 45\n    tools:'),
    );
    expect(def.steps['subject']?.tool_timeout).toBe(45);
  });

  it('tool_timeout: -5 WITHOUT tools reports the prohibition ONLY, not also a shape error', () => {
    // Same suppression convention as #402's: two messages for one root cause points the author at
    // the shape, which is not the problem.
    const message = loadError(step('agent', '    tool_timeout: -5'));
    expect(message).toContain("'tool_timeout' requires 'tools'");
    expect(message).not.toContain("'tool_timeout' must be a positive integer");
  });

  it('tool_timeout: -5 WITH tools still reports the shape error', () => {
    // The suppression's other polarity: where the key is legal, its value is still checked.
    const message = loadError(TOOLS_YAML.replace('    tools:', '    tool_timeout: -5\n    tools:'));
    expect(message).toContain("'tool_timeout' must be a positive integer");
    expect(message).not.toContain("'tool_timeout' requires 'tools'");
  });

  it('COMPOSITION — tools on an AUTO step reports the tools error, and NOT also this one', () => {
    // The step HAS tools, so the requires-predicate must stay silent and let the tools-placement
    // error speak alone. input_schema and a matching mcp_servers block are present so the other
    // tools rules stay quiet too — the single error is the placement one.
    const message = loadError(
      TOOLS_YAML.replace(
        'execution: agent\n    depends_on: [first]',
        'execution: auto\n    depends_on: [first]\n    tool_timeout: 30',
      ),
    );
    expect(message).toContain("'tools' is only valid on execution: agent steps");
    expect(message).not.toContain("'tool_timeout' requires 'tools'");
    expect(errorCount(message)).toBe(1);
  });

  // An EMPTY tools list declares no tool calls: run-agent's tools path is gated on
  // `tools.length > 0`, so `tool_timeout` is exactly as inert there as with no key at all. These
  // two are why the predicate and the shape-check suppression share one helper — under a plain
  // `tools !== undefined` conjunct the second cell would mint TWO errors.
  it('tools: [] + tool_timeout reports the prohibition, exactly ONE error', () => {
    const message = loadError(
      step('agent', '    input_schema:\n      type: object\n    tools: []\n    tool_timeout: 30'),
    );
    expect(message).toContain("'tool_timeout' requires 'tools' (a declared, non-empty list)");
    expect(errorCount(message)).toBe(1);
  });

  it('tools: [] + tool_timeout: -5 reports the prohibition ONLY', () => {
    const message = loadError(
      step('agent', '    input_schema:\n      type: object\n    tools: []\n    tool_timeout: -5'),
    );
    expect(message).toContain("'tool_timeout' requires 'tools' (a declared, non-empty list)");
    expect(message).not.toContain("'tool_timeout' must be a positive integer");
  });
});

// ---------------------------------------------------------------------------
// The family's COUNT and ORDER (issue #417 PR-1)
//
// This cell was written against main BEFORE the retrofit and must stay green through it. The
// retrofit rewrites message TEXT and moves where errors point; it may not change which checks
// fire or the order they fire in. A red here at any point during that work means a message edit
// reached the predicates, which nothing in that PR is allowed to do.
//
// Counted by the per-error `Step '<name>':` prefix — never by splitting on the '; ' the loader
// joins with, because family messages contain semicolons of their own (the #413 lesson).
// ---------------------------------------------------------------------------
describe('the prohibition family — count and order are fixed (issue #417)', () => {
  it('one auto step trips five family checks, in declaration order', () => {
    const content = `
id: order-probe
name: Order Probe
version: 1
steps:
  first:
    description: First step
    execution: auto
    depends_on: []
  subject:
    description: The step under test
    execution: auto
    depends_on: [first]
    on_outcome: always
    abort_unless: ['first.x']
    abort_message: nope
    agent_profile: p
    llm_timeout_seconds: 30
`;
    let message: string;
    try {
      loadWorkflowFromString(content);
      throw new Error('expected a load error');
    } catch (err) {
      message = (err as WorkflowError).message;
    }

    expect((message.match(/Step '/g) ?? []).length).toBe(5);
    // ORDER, by first-occurrence index — the checks run in source order and must keep doing so.
    const order = [
      'on_outcome',
      'abort_unless',
      'abort_message',
      'agent_profile',
      'llm_timeout_seconds',
    ];
    const positions = order.map((key) => message.indexOf(`'${key}'`));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });
});

// ---------------------------------------------------------------------------
// The four-clause retrofit (issue #417 PR-1)
//
// Each of these messages already said WHAT was wrong. What they did not say is what the key
// would have DONE and where it does work — so an author read "only valid on X steps", moved on,
// and learned nothing about why. Each clause below is derived from the key's actual consumer,
// cited beside the message in the loader.
//
// The existing `toContain` pins for these messages stay green by construction: the retrofit
// appends after the original text rather than rewriting it.
// ---------------------------------------------------------------------------
describe('the prohibition family speaks in four clauses (issue #417)', () => {
  const load = (execution: string, body: string): string => {
    const content = `
id: retrofit-test
name: Retrofit Test
version: 1
steps:
  first:
    description: First step
    execution: auto
    depends_on: []
  subject:
    description: The step under test
    execution: ${execution}
    depends_on: [first]
${body}
`;
    try {
      loadWorkflowFromString(content);
      throw new Error('expected a load error');
    } catch (err) {
      return (err as WorkflowError).message;
    }
  };

  it('on_outcome names what it selects and where to put it', () => {
    const m = load('auto', '    on_outcome: always');
    expect(m).toContain("'on_outcome' is only valid on execution: finalizer steps");
    expect(m).toContain('selects which finalizers run');
    expect(m).toContain('would decide nothing');
    expect(m).toContain('Move it to the finalizer');
  });

  it('abort_unless names what it gates and where to put it', () => {
    const m = load('auto', "    abort_unless: ['first.x']");
    expect(m).toContain("'abort_unless' is only valid on execution: guard steps");
    expect(m).toContain('condition list a guard evaluates');
    // "that way" carries the claim: every step is evaluated in SOME sense, so the elliptical
    // form is false read literally. The on_outcome sibling already qualifies it this way.
    expect(m).toContain('only guard steps are evaluated that way');
    expect(m).toContain('would gate nothing');
    expect(m).toContain('Put the check on a guard step');
  });

  it('abort_message names who reads it and where to put it', () => {
    const m = load('auto', '    abort_message: nope');
    expect(m).toContain("'abort_message' is only valid on execution: guard steps");
    expect(m).toContain('text reported when a guard aborts');
    // NOT "only a guard aborts" — handler_abort and gate_expiry_abort are seal arms too. The
    // true basis is readership: every reader of this key is a guard path.
    expect(m).toContain('nothing but a guard reads it');
    expect(m).toContain('would never be read');
    expect(m).toContain('Move it to the guard');
  });

  it('agent_profile names what consumes it and where to put it', () => {
    const m = load('auto', '    agent_profile: reviewer');
    expect(m).toContain("'agent_profile' is only valid on execution: agent steps");
    expect(m).toContain('resolved into the model prompt');
    expect(m).toContain('would reach no model');
    expect(m).toContain('Move it to the agent step');
  });

  it('llm_timeout_seconds names the per-kind equivalent, not just the refusal', () => {
    // The remedy is the useful half: an auto step DOES have a bound, and it has a different name.
    const m = load('auto', '    llm_timeout_seconds: 30');
    expect(m).toContain("'llm_timeout_seconds' is only valid on execution: agent steps");
    expect(m).toContain('bounds one model request');
    expect(m).toContain('would bound nothing');
    // The remedial verb its five siblings all carry — "here is where it goes", not only "here
    // is where it works". Added ahead of the redirect, which stays byte-identical.
    expect(m).toContain('Move it to the agent step whose request it should bound, or remove it.');
    expect(m).toContain("An auto step's dispatch is bounded by 'timeout_seconds'");
    expect(m).toContain("finalizer's handler");
  });

  it('idempotent names BOTH things it gates', () => {
    // Two consumers, and a message naming only one would be half a truth — the loader's own
    // comment records that this key acquired its second function in issue #140.
    const m = load('agent', '    idempotent: true');
    expect(m).toContain("'idempotent' is only valid on execution: auto steps");
    expect(m).toContain("'retry.on_timeout'");
    expect(m).toContain('reclaim eligibility');
    expect(m).toContain('would gate nothing');
  });

  it("the message names the KEY's line, not the step's", () => {
    // The move that makes a long step usable: `subject:` is on line 10 and the offending key is
    // five lines further down. Read from the loader rather than counted by eye.
    const m = load('auto', '    max_tool_calls: 5\n    agent_profile: reviewer');
    expect(m).toContain('(line 15)');
    expect(m).not.toContain('(line 10)');
    // And it is the KEY-EXACT form, not the fallback (issue #420). Without this the rung-1 and
    // rung-2 renders would be indistinguishable to the assertion, so a fallback that started
    // firing here — pointing at the declaration instead of the field — would pass unnoticed.
    expect(m).not.toContain('step at');
  });

  it('FALLBACK 1 — a merge-key body falls back to the STEP line, never a guess', () => {
    // The position map refuses a mapping it cannot pair key-for-key, so the KEY has no line. The
    // step's own name is still placeable, so that is what the message names — one rung down the
    // chain, not a guess and not nothing.
    const content = `id: merge-key-wf
name: Merge Key
version: 1
defaults: &d
  execution: auto
steps:
  subject:
    <<: *d
    description: A step assembled through a merge key
    agent_profile: reviewer
`;
    let message: string;
    try {
      loadWorkflowFromString(content);
      throw new Error('expected a load error');
    } catch (err) {
      message = (err as WorkflowError).message;
    }
    expect(message).toContain("'agent_profile' is only valid on execution: agent steps");
    // The FALLBACK form, and it says so: `subject:` is the step's line, reached because the key
    // itself is unplaceable. `(line N)` would have been indistinguishable from a key-exact cite.
    expect(message).toContain('(step at line 7)');
  });

  it('FALLBACK 2 — a TEMPLATED step carries no position at all', () => {
    // The bottom of the chain. A step expanded from a template exists at no line in the file —
    // its name was synthesized — so there is nothing truthful to point at, and the message says
    // nothing rather than pointing at the call site the author did not write the key in.
    const content = `
id: tpl-wf
name: Template Workflow
version: 1
templates:
  pair:
    steps:
      review:
        description: Review the result
        execution: auto
        agent_profile: reviewer
steps:
  init:
    description: Initialise
    execution: auto
  setup:
    use_template: pair
    prefix: doc
`;
    let message: string;
    try {
      loadWorkflowFromString(content);
      throw new Error('expected a load error');
    } catch (err) {
      message = (err as WorkflowError).message;
    }
    expect(message).toContain("Step 'doc_review'");
    expect(message).toContain("'agent_profile' is only valid on execution: agent steps");
    // Widened past `(line N)` (issue #420): the message must carry NO position in either form,
    // and the bare-`(line N)` pattern no longer excludes a `(step at line N)` regression.
    expect(message).not.toMatch(/line \d+/);
  });
});
