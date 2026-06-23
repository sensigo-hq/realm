// Tests for @sensigo/realm-testing — covers all exported modules.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ExtensionRegistry } from '@sensigo/realm';
import type {
  EvidenceSnapshot,
  RunRecord,
  StepHandler,
  StepHandlerInputs,
  StepContext,
  StepHandlerResult,
  Processor,
  ProcessorInput,
  ProcessorOutput,
  ServiceAdapter,
  ServiceResponse,
  WorkflowDefinition,
} from '@sensigo/realm';

import { InMemoryStore } from './store/in-memory-store.js';
import { loadFixtureFromString, loadFixturesFromDir } from './fixtures/fixture-loader.js';
import { MockServiceRecorder } from './mocks/mock-service.js';
import { createAgentDispatcher } from './mocks/mock-agent.js';
import {
  assertFinalState,
  assertStepSucceeded,
  assertStepFailed,
  assertStepOutput,
  assertEvidenceHash,
} from './assertions/evidence.js';
import { testStepHandler } from './helpers/test-step-handler.js';
import { testProcessor } from './helpers/test-processor.js';
import { testAdapter } from './helpers/test-adapter.js';
import { runFixtureTests } from './runner/test-runner.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSnapshot(stepId: string, overrides: Partial<EvidenceSnapshot> = {}): EvidenceSnapshot {
  return {
    step_id: stepId,
    started_at: '2024-01-01T00:00:00.000Z',
    completed_at: '2024-01-01T00:00:01.000Z',
    duration_ms: 1000,
    input_summary: {},
    output_summary: {},
    status: 'success',
    evidence_hash: 'abc123',
    ...overrides,
  };
}

function makeRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'run-1',
    workflow_id: 'wf-1',
    workflow_version: 1,
    run_phase: 'completed',
    completed_steps: [],
    in_progress_steps: [],
    failed_steps: [],
    skipped_steps: [],
    version: 1,
    params: {},
    evidence: [],
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:00:01.000Z',
    terminal_state: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// InMemoryStore
// ---------------------------------------------------------------------------

describe('InMemoryStore', () => {
  it('create() returns a record with version 0', async () => {
    const store = new InMemoryStore();
    const { run: record } = await store.create({
      workflowId: 'wf-1',
      workflowVersion: 1,
      params: {},
    });
    expect(record.version).toBe(0);
    expect(record.run_phase).toBe('running');
    expect(record.workflow_id).toBe('wf-1');
  });

  it('get() returns the created record', async () => {
    const store = new InMemoryStore();
    const { run: created } = await store.create({
      workflowId: 'wf-1',
      workflowVersion: 1,
      params: {},
    });
    const fetched = await store.get(created.id);
    expect(fetched.id).toBe(created.id);
  });

  it('get() throws WorkflowError(STATE_RUN_NOT_FOUND) for unknown run ID', async () => {
    const store = new InMemoryStore();
    await expect(store.get('nonexistent')).rejects.toMatchObject({
      code: 'STATE_RUN_NOT_FOUND',
    });
  });

  it('update() increments version on success', async () => {
    const store = new InMemoryStore();
    const { run: record } = await store.create({
      workflowId: 'wf-1',
      workflowVersion: 1,
      params: {},
    });
    const updated = await store.update({ ...record, completed_steps: ['step-one'] });
    expect(updated.version).toBe(1);
    expect(updated.completed_steps).toContain('step-one');
  });

  it('update() throws WorkflowError(STATE_SNAPSHOT_MISMATCH) on version mismatch', async () => {
    const store = new InMemoryStore();
    const { run: record } = await store.create({
      workflowId: 'wf-1',
      workflowVersion: 1,
      params: {},
    });
    const stale = { ...record, version: 99 };
    await expect(store.update(stale)).rejects.toMatchObject({
      code: 'STATE_SNAPSHOT_MISMATCH',
    });
  });

  it('list() filters by workflow_id', async () => {
    const store = new InMemoryStore();
    await store.create({
      workflowId: 'wf-a',
      workflowVersion: 1,
      params: {},
    });
    await store.create({
      workflowId: 'wf-b',
      workflowVersion: 1,
      params: {},
    });
    const result = await store.list('wf-a');
    expect(result).toHaveLength(1);
    expect(result[0]!.workflow_id).toBe('wf-a');
  });

  it('list() without filter returns all records', async () => {
    const store = new InMemoryStore();
    await store.create({
      workflowId: 'wf-a',
      workflowVersion: 1,
      params: {},
    });
    await store.create({
      workflowId: 'wf-b',
      workflowVersion: 1,
      params: {},
    });
    const all = await store.list();
    expect(all).toHaveLength(2);
  });

  it('create() reports created:true for a new run and created:false on a same-key match (parity with JsonFileStore)', async () => {
    const store = new InMemoryStore();
    const first = await store.create({
      workflowId: 'wf-1',
      workflowVersion: 1,
      params: {},
      idempotencyKey: 'k1',
    });
    expect(first.created).toBe(true);
    const second = await store.create({
      workflowId: 'wf-1',
      workflowVersion: 1,
      params: {},
      idempotencyKey: 'k1',
    });
    expect(second.created).toBe(false);
    expect(second.run.id).toBe(first.run.id);
    // Only one run exists for the key.
    const all = await store.list('wf-1');
    expect(all).toHaveLength(1);
  });

  it('create() idempotency is scoped per workflow and stores the key field', async () => {
    const store = new InMemoryStore();
    const { run: a } = await store.create({
      workflowId: 'wf-a',
      workflowVersion: 1,
      params: {},
      idempotencyKey: 'k1',
    });
    const { run: b } = await store.create({
      workflowId: 'wf-b',
      workflowVersion: 1,
      params: {},
      idempotencyKey: 'k1',
    });
    expect(a.id).not.toBe(b.id);
    expect(a.idempotency_key).toBe('k1');
  });
});

// ---------------------------------------------------------------------------
// Fixture loader
// ---------------------------------------------------------------------------

describe('loadFixtureFromString', () => {
  it('parses a valid fixture YAML string', () => {
    const yaml = `
name: my fixture
params:
  user: alice
mocks: {}
agent_responses:
  step-one:
    result: ok
expected:
  final_state: completed
`;
    const fixture = loadFixtureFromString(yaml);
    expect(fixture.name).toBe('my fixture');
    expect(fixture.params['user']).toBe('alice');
    expect(fixture.expected.final_state).toBe('completed');
  });

  it('throws on missing name', () => {
    const yaml = `
params: {}
mocks: {}
agent_responses: {}
expected:
  final_state: done
`;
    expect(() => loadFixtureFromString(yaml)).toThrow(/name/);
  });

  it('throws on missing expected.final_state', () => {
    const yaml = `
name: broken fixture
params: {}
mocks: {}
agent_responses: {}
expected: {}
`;
    expect(() => loadFixtureFromString(yaml)).toThrow(/final_state/);
  });

  it('parses gate_responses when present', () => {
    const yaml = `
name: gate fixture
params: {}
mocks: {}
agent_responses: {}
gate_responses:
  review-step: reject
expected:
  final_state: rejected
`;
    const fixture = loadFixtureFromString(yaml);
    expect(fixture.gate_responses?.['review-step']).toBe('reject');
  });

  it('returns empty gate_responses-less fixture when gate_responses is absent', () => {
    const yaml = `
name: plain
params: {}
mocks: {}
agent_responses: {}
expected:
  final_state: done
`;
    const fixture = loadFixtureFromString(yaml);
    expect(fixture.gate_responses).toBeUndefined();
  });

  it('parses skipped_steps when present', () => {
    const yaml = `
name: routing fixture
params: {}
mocks: {}
agent_responses: {}
expected:
  final_state: completed
  skipped_steps: [handle_b, handle_c]
`;
    const fixture = loadFixtureFromString(yaml);
    expect(fixture.expected.skipped_steps).toEqual(['handle_b', 'handle_c']);
  });

  it('leaves skipped_steps undefined when absent', () => {
    const yaml = `
name: no routing
params: {}
mocks: {}
agent_responses: {}
expected:
  final_state: done
`;
    const fixture = loadFixtureFromString(yaml);
    expect(fixture.expected.skipped_steps).toBeUndefined();
  });
});

describe('loadFixturesFromDir', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'realm-fixtures-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns multiple fixtures from a directory', () => {
    writeFileSync(
      join(tmpDir, 'f1.yaml'),
      `name: f1\nparams: {}\nmocks: {}\nagent_responses: {}\nexpected:\n  final_state: done`,
    );
    writeFileSync(
      join(tmpDir, 'f2.yaml'),
      `name: f2\nparams: {}\nmocks: {}\nagent_responses: {}\nexpected:\n  final_state: done`,
    );
    const fixtures = loadFixturesFromDir(tmpDir);
    expect(fixtures).toHaveLength(2);
    const names = fixtures.map((f) => f.name);
    expect(names).toContain('f1');
    expect(names).toContain('f2');
  });

  it('throws when directory does not exist', () => {
    expect(() => loadFixturesFromDir('/nonexistent/path/that/does-not-exist')).toThrow(
      /does not exist/,
    );
  });
});

// ---------------------------------------------------------------------------
// MockServiceRecorder
// ---------------------------------------------------------------------------

describe('MockServiceRecorder', () => {
  it('fetch() returns the configured response', async () => {
    const recorder = new MockServiceRecorder('my-adapter', {
      get_data: { status: 200, data: { result: 'ok' } },
    });
    const resp = await recorder.fetch('get_data', {}, {});
    expect(resp.status).toBe(200);
    expect((resp.data as Record<string, unknown>)['result']).toBe('ok');
  });

  it('fetch() records the call', async () => {
    const recorder = new MockServiceRecorder('my-adapter', {
      get_data: { status: 200, data: {} },
    });
    await recorder.fetch('get_data', { q: 1 }, {});
    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0]!.method).toBe('fetch');
    expect(recorder.calls[0]!.operation).toBe('get_data');
    expect(recorder.calls[0]!.params['q']).toBe(1);
  });

  it('fetch() throws WorkflowError for unknown operation', async () => {
    const recorder = new MockServiceRecorder('my-adapter', {});
    await expect(recorder.fetch('unknown_op', {}, {})).rejects.toMatchObject({
      code: 'ENGINE_ADAPTER_FAILED',
    });
  });

  it('multiple calls accumulate in calls array', async () => {
    const recorder = new MockServiceRecorder('my-adapter', {
      op1: { status: 200, data: {} },
      op2: { status: 201, data: {} },
    });
    await recorder.fetch('op1', {}, {});
    await recorder.fetch('op2', {}, {});
    await recorder.fetch('op1', {}, {});
    expect(recorder.calls).toHaveLength(3);
    expect(recorder.calls.map((c) => c.operation)).toEqual(['op1', 'op2', 'op1']);
  });
});

// ---------------------------------------------------------------------------
// Evidence assertions
// ---------------------------------------------------------------------------

describe('assertFinalState', () => {
  it('does not throw when phase matches', () => {
    const run = makeRun({ run_phase: 'completed' });
    expect(() => assertFinalState(run, 'completed')).not.toThrow();
  });

  it('throws when phase does not match', () => {
    const run = makeRun({ run_phase: 'failed' });
    expect(() => assertFinalState(run, 'completed')).toThrow(/assertFinalState/);
  });
});

describe('assertStepSucceeded', () => {
  it('does not throw when success snapshot exists', () => {
    const evidence = [makeSnapshot('step-a', { status: 'success' })];
    expect(() => assertStepSucceeded(evidence, 'step-a')).not.toThrow();
  });

  it('throws when step has no success snapshot', () => {
    const evidence = [makeSnapshot('step-a', { status: 'error' })];
    expect(() => assertStepSucceeded(evidence, 'step-a')).toThrow(/assertStepSucceeded/);
  });

  it('ignores gate_response snapshots', () => {
    const evidence = [makeSnapshot('step-a', { status: 'success', kind: 'gate_response' })];
    expect(() => assertStepSucceeded(evidence, 'step-a')).toThrow(/assertStepSucceeded/);
  });
});

describe('assertStepFailed', () => {
  it('does not throw when error snapshot exists', () => {
    const evidence = [makeSnapshot('step-a', { status: 'error' })];
    expect(() => assertStepFailed(evidence, 'step-a')).not.toThrow();
  });

  it('throws when no error snapshot exists', () => {
    const evidence = [makeSnapshot('step-a', { status: 'success' })];
    expect(() => assertStepFailed(evidence, 'step-a')).toThrow(/assertStepFailed/);
  });
});

describe('assertStepOutput', () => {
  it('throws on missing output key', () => {
    const evidence = [makeSnapshot('step-a', { output_summary: { result: 'ok' } })];
    expect(() => assertStepOutput(evidence, 'step-a', { result: 'ok', extra: 'missing' })).toThrow(
      /assertStepOutput/,
    );
  });

  it('does not throw when all expected keys match', () => {
    const evidence = [makeSnapshot('step-a', { output_summary: { result: 'ok', count: 5 } })];
    expect(() => assertStepOutput(evidence, 'step-a', { result: 'ok' })).not.toThrow();
  });
});

describe('assertEvidenceHash', () => {
  it('does not throw when hash matches', () => {
    const evidence = [makeSnapshot('step-a', { evidence_hash: 'hash123' })];
    expect(() => assertEvidenceHash(evidence, 'step-a', 'hash123')).not.toThrow();
  });

  it('throws when hash does not match', () => {
    const evidence = [makeSnapshot('step-a', { evidence_hash: 'hash123' })];
    expect(() => assertEvidenceHash(evidence, 'step-a', 'wrong')).toThrow(/assertEvidenceHash/);
  });
});

// ---------------------------------------------------------------------------
// Unit test helpers
// ---------------------------------------------------------------------------

describe('testStepHandler', () => {
  it('calls the handler and returns its result', async () => {
    const handler: StepHandler = {
      id: 'my-handler',
      async execute(inputs: StepHandlerInputs, ctx: StepContext): Promise<StepHandlerResult> {
        return { data: { echo: inputs.params['msg'], run: ctx.run_id } };
      },
    };
    const result = await testStepHandler(handler, { params: { msg: 'hello' } });
    expect(result.data['echo']).toBe('hello');
    expect(result.data['run']).toBe('test-run');
  });
});

describe('testProcessor', () => {
  it('calls the processor and returns its output', async () => {
    const processor: Processor = {
      id: 'my-processor',
      async process(
        content: ProcessorInput,
        config: Record<string, unknown>,
      ): Promise<ProcessorOutput> {
        return {
          text: content.text.toUpperCase(),
          metadata: { ...content.metadata, processed: true, lang: config['lang'] ?? 'en' },
        };
      },
    };
    const output = await testProcessor(processor, { text: 'hello', metadata: {} }, { lang: 'fr' });
    expect(output.text).toBe('HELLO');
    expect(output.metadata['lang']).toBe('fr');
  });
});

describe('testAdapter', () => {
  it('calls adapter.fetch() and returns the response', async () => {
    const adapter: ServiceAdapter = {
      id: 'test-adapter',
      async fetch(
        _op: string,
        params: Record<string, unknown>,
        _cfg: Record<string, unknown>,
      ): Promise<ServiceResponse> {
        return { status: 200, data: { received: params['x'] } };
      },
      async create(): Promise<ServiceResponse> {
        return { status: 201, data: {} };
      },
      async update(): Promise<ServiceResponse> {
        return { status: 200, data: {} };
      },
    };
    const resp = await testAdapter(adapter, 'do_thing', { x: 42 });
    expect(resp.status).toBe(200);
    expect((resp.data as Record<string, unknown>)['received']).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// createAgentDispatcher
// ---------------------------------------------------------------------------

const DISPATCHER_DEFINITION: WorkflowDefinition = {
  id: 'dispatcher-test',
  name: 'Dispatcher Test',
  version: 1,
  initial_state: 'created',
  steps: {
    'agent-step': {
      description: 'An agent step',
      execution: 'agent',
      allowed_from_states: ['created'],
      produces_state: 'agent_done',
    },
    'handler-step': {
      description: 'A handler step',
      execution: 'auto',
      allowed_from_states: ['agent_done'],
      produces_state: 'completed',
      handler: 'my-handler',
    },
    'no-handler-step': {
      description: 'Step with no handler or service',
      execution: 'auto',
      allowed_from_states: ['agent_done'],
      produces_state: 'completed',
    },
  },
};

function makeMinimalRun(): RunRecord {
  return makeRun({ id: 'test-run', run_phase: 'running', terminal_state: false });
}

describe('createAgentDispatcher', () => {
  it('returns pre-built agent response for execution: agent step', async () => {
    const registry = new ExtensionRegistry();
    const dispatcher = createAgentDispatcher(DISPATCHER_DEFINITION, registry, {
      'agent-step': { score: 99 },
    });
    const result = await dispatcher('agent-step', {}, makeMinimalRun());
    expect(result['score']).toBe(99);
  });

  it('throws WorkflowError when agent step has no pre-built response', async () => {
    const registry = new ExtensionRegistry();
    const dispatcher = createAgentDispatcher(DISPATCHER_DEFINITION, registry, {});
    await expect(dispatcher('agent-step', {}, makeMinimalRun())).rejects.toMatchObject({
      code: 'ENGINE_HANDLER_FAILED',
    });
  });

  it('delegates to handler from registry for handler-based step', async () => {
    const registry = new ExtensionRegistry();
    const handler: StepHandler = {
      id: 'my-handler',
      async execute(): Promise<StepHandlerResult> {
        return { data: { handled: true } };
      },
    };
    registry.register('handler', 'my-handler', handler);
    const dispatcher = createAgentDispatcher(DISPATCHER_DEFINITION, registry, {});
    const result = await dispatcher('handler-step', {}, makeMinimalRun());
    expect(result['handled']).toBe(true);
  });

  it('returns {} for step with no handler, service, or agent response', async () => {
    const registry = new ExtensionRegistry();
    const dispatcher = createAgentDispatcher(DISPATCHER_DEFINITION, registry, {});
    const result = await dispatcher('no-handler-step', {}, makeMinimalRun());
    expect(result).toEqual({});
  });

  it('injects errors from agentErrors before returning the real response', async () => {
    const registry = new ExtensionRegistry();
    const dispatcher = createAgentDispatcher(
      DISPATCHER_DEFINITION,
      registry,
      { 'agent-step': { score: 42 } },
      undefined,
      { 'agent-step': ['provider timed out'] },
    );
    // First call: error injected
    await expect(dispatcher('agent-step', {}, makeMinimalRun())).rejects.toMatchObject({
      message: 'provider timed out',
      code: 'ENGINE_HANDLER_FAILED',
    });
    // Second call: real response returned
    const result = await dispatcher('agent-step', {}, makeMinimalRun());
    expect(result['score']).toBe(42);
  });

  it('multiple errors are injected in order before the real response', async () => {
    const registry = new ExtensionRegistry();
    const dispatcher = createAgentDispatcher(
      DISPATCHER_DEFINITION,
      registry,
      { 'agent-step': { score: 1 } },
      undefined,
      { 'agent-step': ['error-one', 'error-two'] },
    );
    await expect(dispatcher('agent-step', {}, makeMinimalRun())).rejects.toMatchObject({
      message: 'error-one',
    });
    await expect(dispatcher('agent-step', {}, makeMinimalRun())).rejects.toMatchObject({
      message: 'error-two',
    });
    const result = await dispatcher('agent-step', {}, makeMinimalRun());
    expect(result['score']).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// runFixtureTests integration
// ---------------------------------------------------------------------------

const THREE_STEP_WORKFLOW = `
id: three-step-wf
name: Three Step Workflow
version: 1
initial_state: created
steps:
  auto-start:
    description: Auto step at start
    execution: auto
    allowed_from_states: [created]
    produces_state: started
  agent-step:
    description: Agent step
    execution: agent
    allowed_from_states: [started]
    produces_state: agent_done
  auto-finish:
    description: Auto step at end
    execution: auto
    allowed_from_states: [agent_done]
    produces_state: completed
`;

const HAPPY_FIXTURE = `
name: happy path
params:
  user: alice
mocks: {}
agent_responses:
  agent-step:
    result: success
expected:
  final_state: completed
  evidence:
    - step_id: auto-start
      status: success
    - step_id: agent-step
      status: success
    - step_id: auto-finish
      status: success
`;

describe('runFixtureTests', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'realm-runner-'));
    mkdirSync(join(tmpDir, 'fixtures'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('happy path: 3-step workflow passes all assertions', async () => {
    writeFileSync(join(tmpDir, 'workflow.yaml'), THREE_STEP_WORKFLOW);
    writeFileSync(join(tmpDir, 'fixtures', 'happy.yaml'), HAPPY_FIXTURE);

    const results = await runFixtureTests({
      workflowPath: join(tmpDir, 'workflow.yaml'),
      fixturesPath: join(tmpDir, 'fixtures'),
    });

    expect(results).toHaveLength(1);
    expect(results[0]!.passed).toBe(true);
    expect(results[0]!.error).toBeUndefined();
  });

  it('agent step with no pre-built response causes fixture to fail', async () => {
    writeFileSync(join(tmpDir, 'workflow.yaml'), THREE_STEP_WORKFLOW);
    writeFileSync(
      join(tmpDir, 'fixtures', 'missing-agent.yaml'),
      `
name: missing agent response
params: {}
mocks: {}
agent_responses: {}
expected:
  final_state: completed
`,
    );

    const results = await runFixtureTests({
      workflowPath: join(tmpDir, 'workflow.yaml'),
      fixturesPath: join(tmpDir, 'fixtures'),
    });

    expect(results).toHaveLength(1);
    expect(results[0]!.passed).toBe(false);
    expect(results[0]!.error).toMatch(/agent-step|no pre-built/i);
  });

  it('wrong expected final_state causes fixture to fail', async () => {
    writeFileSync(join(tmpDir, 'workflow.yaml'), THREE_STEP_WORKFLOW);
    writeFileSync(
      join(tmpDir, 'fixtures', 'wrong-state.yaml'),
      `
name: wrong final state
params: {}
mocks: {}
agent_responses:
  agent-step:
    result: ok
expected:
  final_state: failed
`,
    );

    const results = await runFixtureTests({
      workflowPath: join(tmpDir, 'workflow.yaml'),
      fixturesPath: join(tmpDir, 'fixtures'),
    });

    expect(results).toHaveLength(1);
    expect(results[0]!.passed).toBe(false);
    expect(results[0]!.error).toMatch(/assertFinalState|failed|completed/);
  });

  it('multiple fixtures produce correct pass/fail per entry', async () => {
    writeFileSync(join(tmpDir, 'workflow.yaml'), THREE_STEP_WORKFLOW);
    writeFileSync(join(tmpDir, 'fixtures', 'pass.yaml'), HAPPY_FIXTURE);
    writeFileSync(
      join(tmpDir, 'fixtures', 'fail.yaml'),
      `
name: failing fixture
params: {}
mocks: {}
agent_responses: {}
expected:
  final_state: completed
`,
    );

    const results = await runFixtureTests({
      workflowPath: join(tmpDir, 'workflow.yaml'),
      fixturesPath: join(tmpDir, 'fixtures'),
    });

    expect(results).toHaveLength(2);
    const byName = Object.fromEntries(results.map((r) => [r.name, r]));
    expect(byName['happy path']!.passed).toBe(true);
    expect(byName['failing fixture']!.passed).toBe(false);
  });

  it('agent_errors: step fails once then succeeds after auto-resume — fixture passes', async () => {
    writeFileSync(join(tmpDir, 'workflow.yaml'), THREE_STEP_WORKFLOW);
    writeFileSync(
      join(tmpDir, 'fixtures', 'resume.yaml'),
      `
name: resume after mock error
params: {}
mocks: {}
agent_responses:
  agent-step:
    result: recovered
agent_errors:
  agent-step:
    - provider timed out after 30s
expected:
  final_state: completed
  evidence:
    - step_id: auto-start
      status: success
    - step_id: agent-step
      status: success
    - step_id: auto-finish
      status: success
`,
    );

    const results = await runFixtureTests({
      workflowPath: join(tmpDir, 'workflow.yaml'),
      fixturesPath: join(tmpDir, 'fixtures'),
    });

    expect(results).toHaveLength(1);
    expect(results[0]!.passed).toBe(true);
    expect(results[0]!.error).toBeUndefined();
  });

  it('skipped_steps: correct assertion passes', async () => {
    const routingWorkflow = `
id: routing-wf
name: Routing Workflow
version: 1
steps:
  classifier:
    description: Classify the input
    execution: agent
    depends_on: []
    input_schema:
      type: object
      required: [category]
      properties:
        category:
          type: string
          enum: [a, b]
  handle_a:
    description: Handle category a
    execution: agent
    depends_on: [classifier]
    when: "classifier.category == 'a'"
    input_schema:
      type: object
      required: [result]
      properties:
        result:
          type: string
  handle_b:
    description: Handle category b
    execution: agent
    depends_on: [classifier]
    when: "classifier.category == 'b'"
    input_schema:
      type: object
      required: [result]
      properties:
        result:
          type: string
`;
    writeFileSync(join(tmpDir, 'workflow.yaml'), routingWorkflow);
    writeFileSync(
      join(tmpDir, 'fixtures', 'route-a.yaml'),
      `
name: route to a
params: {}
mocks: {}
agent_responses:
  classifier:
    category: a
  handle_a:
    result: handled
expected:
  final_state: completed
  skipped_steps: [handle_b]
  evidence:
    - step_id: handle_a
      status: success
`,
    );

    const results = await runFixtureTests({
      workflowPath: join(tmpDir, 'workflow.yaml'),
      fixturesPath: join(tmpDir, 'fixtures'),
    });

    expect(results).toHaveLength(1);
    expect(results[0]!.passed).toBe(true);
  });

  it('skipped_steps: wrong assertion fails with descriptive error', async () => {
    const routingWorkflow = `
id: routing-wf-2
name: Routing Workflow 2
version: 1
steps:
  classifier:
    description: Classify
    execution: agent
    depends_on: []
    input_schema:
      type: object
      required: [category]
      properties:
        category:
          type: string
          enum: [a, b]
  handle_a:
    description: Handle a
    execution: agent
    depends_on: [classifier]
    when: "classifier.category == 'a'"
    input_schema:
      type: object
      required: [result]
      properties:
        result:
          type: string
  handle_b:
    description: Handle b
    execution: agent
    depends_on: [classifier]
    when: "classifier.category == 'b'"
    input_schema:
      type: object
      required: [result]
      properties:
        result:
          type: string
`;
    writeFileSync(join(tmpDir, 'workflow.yaml'), routingWorkflow);
    writeFileSync(
      join(tmpDir, 'fixtures', 'route-wrong.yaml'),
      `
name: wrong skipped assertion
params: {}
mocks: {}
agent_responses:
  classifier:
    category: a
  handle_a:
    result: handled
expected:
  final_state: completed
  skipped_steps: [handle_a]
`,
    );

    const results = await runFixtureTests({
      workflowPath: join(tmpDir, 'workflow.yaml'),
      fixturesPath: join(tmpDir, 'fixtures'),
    });

    expect(results).toHaveLength(1);
    expect(results[0]!.passed).toBe(false);
    expect(results[0]!.error).toMatch(/skipped_steps/);
  });
});
