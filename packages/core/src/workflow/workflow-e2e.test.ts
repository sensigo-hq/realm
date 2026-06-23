// End-to-end tests for a full workflow run using YAML-loaded workflow definitions.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadWorkflowFromString, loadWorkflowFromFile } from './yaml-loader.js';
import { JsonFileStore } from '../store/json-file-store.js';
import { executeStep } from '../engine/execution-loop.js';
import { ExtensionRegistry } from '../extensions/registry.js';
import type { StepHandler } from '../extensions/step-handler.js';

const WORKFLOW_YAML = `
id: e2e-test
name: E2E Test Workflow
version: 1
steps:
  step_one:
    description: First step
    execution: agent
    depends_on: []
  step_two:
    description: Second step
    execution: auto
    depends_on: [step_one]
`;

describe('workflow end-to-end', () => {
  let dir: string;
  let store: JsonFileStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'realm-e2e-'));
    store = new JsonFileStore(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('full 2-step run produces completed run_phase and evidence chain', async () => {
    const definition = loadWorkflowFromString(WORKFLOW_YAML);
    const dispatcher = async () => ({});

    const { run: run0 } = await store.create({
      workflowId: definition.id,
      workflowVersion: definition.version,
      params: {},
    });

    const res1 = await executeStep(store, definition, {
      runId: run0.id,
      command: 'step_one',
      input: {},
      dispatcher,
    });
    expect(res1.status).toBe('ok');

    const res2 = await executeStep(store, definition, {
      runId: run0.id,
      command: 'step_two',
      input: {},
      dispatcher,
    });
    expect(res2.status).toBe('ok');

    const finalRun = await store.get(run0.id);
    expect(finalRun.run_phase).toBe('completed');
    expect(finalRun.terminal_state).toBe(true);
    expect(finalRun.evidence).toHaveLength(2);
  });

  it('evidence entries have correct step_ids and success status', async () => {
    const definition = loadWorkflowFromString(WORKFLOW_YAML);
    const dispatcher = async () => ({});

    const { run: run0 } = await store.create({
      workflowId: definition.id,
      workflowVersion: definition.version,
      params: {},
    });

    await executeStep(store, definition, {
      runId: run0.id,
      command: 'step_one',
      input: {},
      dispatcher,
    });

    await executeStep(store, definition, {
      runId: run0.id,
      command: 'step_two',
      input: {},
      dispatcher,
    });

    const finalRun = await store.get(run0.id);
    expect(finalRun.evidence[0]?.step_id).toBe('step_one');
    expect(finalRun.evidence[0]?.status).toBe('success');
    expect(finalRun.evidence[1]?.step_id).toBe('step_two');
    expect(finalRun.evidence[1]?.status).toBe('success');
  });

  it('depends_on blocks out-of-order execution', async () => {
    const definition = loadWorkflowFromString(WORKFLOW_YAML);

    const { run: run0 } = await store.create({
      workflowId: definition.id,
      workflowVersion: definition.version,
      params: {},
    });

    // Attempt step_two before step_one — not eligible due to depends_on.
    const result = await executeStep(store, definition, {
      runId: run0.id,
      command: 'step_two',
      input: {},
      dispatcher: async () => ({}),
    });

    expect(result.status).toBe('blocked');
    expect(result.agent_action).toBe('resolve_precondition');
  });

  it('forwards step config to handler context', async () => {
    const yaml = `
id: config-flow-test
name: Config Flow
version: 1
steps:
  check:
    description: "Check config."
    execution: auto
    handler: config_capture
    depends_on: []
    config:
      my_key: my_value
`;
    const definition = loadWorkflowFromString(yaml);

    let capturedConfig: Record<string, unknown> | undefined;
    const captureHandler: StepHandler = {
      id: 'config_capture',
      async execute(_inputs, context) {
        capturedConfig = context.config;
        return { data: {} };
      },
    };

    const registry = new ExtensionRegistry();
    registry.register('handler', 'config_capture', captureHandler);

    const { run: run } = await store.create({
      workflowId: definition.id,
      workflowVersion: definition.version,
      params: {},
    });

    await executeStep(store, definition, {
      runId: run.id,
      command: 'check',
      input: {},
      dispatcher: async () => ({}),
      registry,
    });

    expect(capturedConfig).toEqual({ my_key: 'my_value' });
  });
});

describe('workflow_context integration', () => {
  let dir: string;
  let store: JsonFileStore;
  let wfDir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'realm-e2e-ctx-'));
    store = new JsonFileStore(dir);
    wfDir = await mkdtemp(join(tmpdir(), 'realm-e2e-wf-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(wfDir, { recursive: true, force: true });
  });

  it('workflow_context_snapshots is populated in the run record after first step executes', async () => {
    const contextPath = join(wfDir, 'rules.md');
    await writeFile(contextPath, '# Rules\nBe concise.', 'utf-8');
    await writeFile(
      join(wfDir, 'workflow.yaml'),
      `id: ctx-e2e\nname: Context E2E\nversion: 1\nworkflow_context:\n  rules:\n    source:\n      path: ./rules.md\nsteps:\n  do_work:\n    description: Do work with context\n    execution: agent\n    depends_on: []\n`,
    );
    const definition = loadWorkflowFromFile(join(wfDir, 'workflow.yaml'));

    const { run: run } = await store.create({
      workflowId: definition.id,
      workflowVersion: definition.version,
      params: {},
    });

    await executeStep(store, definition, {
      runId: run.id,
      command: 'do_work',
      input: { result: 'done' },
      dispatcher: async () => ({ result: 'done' }),
    });

    const finalRun = await store.get(run.id);
    expect(finalRun.workflow_context_snapshots).toBeDefined();
    expect(finalRun.workflow_context_snapshots!['rules']).toBeDefined();
    expect(finalRun.workflow_context_snapshots!['rules']!.content).toBe('# Rules\nBe concise.');
  });

  it('{{ workflow.context.NAME }} in step prompt resolves to XML-wrapped content in next_actions', async () => {
    const contextPath = join(wfDir, 'schema.md');
    await writeFile(contextPath, '{"type":"object"}', 'utf-8');
    await writeFile(
      join(wfDir, 'workflow.yaml'),
      `id: ctx-prompt-e2e\nname: Context Prompt E2E\nversion: 1\nworkflow_context:\n  schema:\n    source:\n      path: ./schema.md\nsteps:\n  step_one:\n    description: First step\n    execution: agent\n    depends_on: []\n  step_two:\n    description: Second step with context\n    execution: agent\n    depends_on: [step_one]\n    prompt: "Use this schema: {{ workflow.context.schema }}"\n`,
    );
    const definition = loadWorkflowFromFile(join(wfDir, 'workflow.yaml'));

    const { run: run } = await store.create({
      workflowId: definition.id,
      workflowVersion: definition.version,
      params: {},
    });

    // Execute step_one to make step_two eligible.
    const res1 = await executeStep(store, definition, {
      runId: run.id,
      command: 'step_one',
      input: {},
      dispatcher: async () => ({}),
    });
    expect(res1.status).toBe('ok');

    // The run now has workflow_context_snapshots loaded. step_two prompt should be resolved.
    const res1Run = await store.get(run.id);
    // Snapshot was loaded at step_one — verify it exists.
    expect(res1Run.workflow_context_snapshots?.['schema']?.content).toBe('{"type":"object"}');

    // next_actions after step_one should include step_two with resolved prompt.
    const stepTwoAction = res1.next_actions.find(
      (a) =>
        (a.instruction?.call_with as Record<string, unknown> | undefined)?.['command'] ===
        'step_two',
    );
    expect(stepTwoAction).toBeDefined();
    expect(stepTwoAction!.prompt).toContain('<schema>');
    expect(stepTwoAction!.prompt).toContain('{"type":"object"}');
    expect(stepTwoAction!.prompt).toContain('</schema>');
  });

  it('file read failure: error snapshot recorded, step still executes, {{ }} left unresolved', async () => {
    const missingPath = join(wfDir, 'missing.md');
    await writeFile(
      join(wfDir, 'workflow.yaml'),
      `id: ctx-err-e2e\nname: Context Error E2E\nversion: 1\nworkflow_context:\n  rules:\n    source:\n      path: ${missingPath}\nsteps:\n  work:\n    description: Work step\n    execution: agent\n    depends_on: []\n    prompt: "Rules: {{ workflow.context.rules }}"\n`,
    );
    const definition = loadWorkflowFromFile(join(wfDir, 'workflow.yaml'));

    const { run: run } = await store.create({
      workflowId: definition.id,
      workflowVersion: definition.version,
      params: {},
    });

    const result = await executeStep(store, definition, {
      runId: run.id,
      command: 'work',
      input: {},
      dispatcher: async () => ({}),
    });
    // Step still executes — not blocked by missing context file.
    expect(result.status).toBe('ok');

    const finalRun = await store.get(run.id);
    expect(finalRun.workflow_context_snapshots!['rules']!.error).toBeTruthy();
    expect(finalRun.workflow_context_snapshots!['rules']!.content).toBe('');
  });

  it('context entries do not appear in completed_steps, in_progress_steps, or evidence[]', async () => {
    const contextPath = join(wfDir, 'rules.md');
    await writeFile(contextPath, 'Obey rules.', 'utf-8');
    await writeFile(
      join(wfDir, 'workflow.yaml'),
      `id: ctx-isolation-e2e\nname: Context Isolation E2E\nversion: 1\nworkflow_context:\n  rules:\n    source:\n      path: ./rules.md\nsteps:\n  work:\n    description: Work\n    execution: agent\n    depends_on: []\n`,
    );
    const definition = loadWorkflowFromFile(join(wfDir, 'workflow.yaml'));

    const { run: run } = await store.create({
      workflowId: definition.id,
      workflowVersion: definition.version,
      params: {},
    });

    await executeStep(store, definition, {
      runId: run.id,
      command: 'work',
      input: {},
      dispatcher: async () => ({}),
    });

    const finalRun = await store.get(run.id);
    expect(finalRun.completed_steps).not.toContain('rules');
    expect(finalRun.in_progress_steps).not.toContain('rules');
    expect(finalRun.evidence.map((e) => e.step_id)).not.toContain('rules');
  });
});
