import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  loadWorkflowFromString,
  loadWorkflowFromFile,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
} from './yaml-loader.js';
import { WorkflowError } from '../types/workflow-error.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

  it('preserves step config block in parsed definition', () => {
    const yaml = `
id: cfg-test
name: Config Test
version: 1
initial_state: idle
steps:
  validate:
    description: "Validate something."
    execution: auto
    handler: my_handler
    allowed_from_states: [idle]
    produces_state: completed
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
initial_state: created
templates:
  simple_pair:
    params:
      svc:
        required: true
    steps:
      fetch:
        description: Fetch from {{ svc }}
        execution: auto
        allowed_from_states: ['{{ prefix }}_created']
        produces_state: '{{ prefix }}_fetched'
      review:
        description: Review the result
        execution: agent
        allowed_from_states: ['{{ prefix }}_fetched']
        produces_state: '{{ prefix }}_done'
steps:
  init:
    description: Initialise
    execution: auto
    allowed_from_states: [created]
    produces_state: doc_created
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
    expect(def.steps['doc_fetch']?.allowed_from_states).toEqual(['doc_created']);
    expect(def.steps['doc_review']?.produces_state).toBe('doc_done');
  });

  it('throws WorkflowError when a required template param is missing at call site', () => {
    const yaml = `
id: tpl-missing-param
name: Missing Param
version: 1
initial_state: created
templates:
  needs_svc:
    params:
      svc:
        required: true
    steps:
      fetch:
        description: Fetch from {{ svc }}
        execution: auto
        allowed_from_states: [created]
        produces_state: fetched
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
initial_state: created
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
initial_state: created
templates:
  one_step:
    params:
      label:
        default: item
    steps:
      process:
        description: Process {{ label }}
        execution: agent
        allowed_from_states: ['{{ prefix }}_created']
        produces_state: '{{ prefix }}_done'
steps:
  init_alpha:
    description: Init alpha
    execution: auto
    allowed_from_states: [created]
    produces_state: alpha_created
  first:
    use_template: one_step
    prefix: alpha
    params:
      label: alpha_item
  init_beta:
    description: Init beta
    execution: auto
    allowed_from_states: [alpha_done]
    produces_state: beta_created
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
initial_state: created
templates:
  one_step:
    steps:
      run:
        description: Run step
        execution: agent
        allowed_from_states: ['{{ prefix }}_created']
        produces_state: '{{ prefix }}_done'
steps:
  prepare:
    description: Prepare
    execution: auto
    allowed_from_states: [created]
    produces_state: task_created
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
initial_state: created
steps:
  bad-step:
    description: Bad
    execution: auto
    agent_profile: some-profile
    allowed_from_states: [created]
    produces_state: done
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
initial_state: created
steps:
  agent-step:
    description: Agent step with profile
    execution: agent
    agent_profile: my-profile
    allowed_from_states: [created]
    produces_state: done
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
initial_state: created
steps:
  step-a:
    description: First agent step
    execution: agent
    agent_profile: shared-profile
    allowed_from_states: [created]
    produces_state: step_a_done
  step-b:
    description: Second agent step
    execution: agent
    agent_profile: shared-profile
    allowed_from_states: [step_a_done]
    produces_state: done
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
initial_state: created
profiles_dir: ./custom-profiles
steps:
  agent-step:
    description: Agent step
    execution: agent
    agent_profile: custom-profile
    allowed_from_states: [created]
    produces_state: done
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
      expect(message).toContain("'tool_timeout' must be a positive integer");
    }
  });
});
