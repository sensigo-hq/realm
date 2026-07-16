// Tests for createRealmMcpServer's construction seam (issue #188, PR-1): the RunStore injection
// widen + the co-located artifact-store injection contract.
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client';
import {
  JsonFileStore,
  JsonWorkflowStore,
  InMemoryTraceBufferStore,
  WorkflowError,
  findEligibleSteps,
  deriveRunPhase,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
} from '@sensigo/realm';
import type { RunStore, RunRecord, CreateRunOptions, WorkflowDefinition } from '@sensigo/realm';
import { createRealmMcpServer } from './server.js';
import { JsonTraceBufferStore } from './json-trace-buffer-store.js';
import type { FailedAttemptStoreLike } from './tools/start-run.js';

/**
 * Minimal hand-rolled `RunStore` — deliberately does NOT expose `runsDirPath` (no filesystem
 * backing at all), mirroring the shape a Postgres/object-storage-backed run store would have.
 * Used to exercise the "run store without runsDirPath" branches of the co-location seam.
 */
class MinimalRunStore implements RunStore {
  private readonly runs = new Map<string, RunRecord>();
  readonly persistsClaims = true;

  async create(options: CreateRunOptions): Promise<{ run: RunRecord; created: boolean }> {
    const now = new Date().toISOString();
    const record: RunRecord = {
      id: randomUUID(),
      workflow_id: options.workflowId,
      workflow_version: options.workflowVersion,
      completed_steps: [],
      in_progress_steps: [],
      failed_steps: [],
      skipped_steps: [],
      run_phase: 'running',
      version: 0,
      params: options.params,
      evidence: [],
      created_at: now,
      updated_at: now,
      terminal_state: false,
    };
    this.runs.set(record.id, record);
    return { run: record, created: true };
  }

  async get(runId: string): Promise<RunRecord> {
    const record = this.runs.get(runId);
    if (record === undefined) {
      throw new WorkflowError(`Run '${runId}' not found`, {
        code: 'STATE_RUN_NOT_FOUND',
        category: 'STATE',
        agentAction: 'report_to_user',
        retryable: false,
      });
    }
    return record;
  }

  async update(record: RunRecord): Promise<RunRecord> {
    const existing = this.runs.get(record.id);
    if (existing === undefined) {
      throw new WorkflowError(`Run '${record.id}' not found`, {
        code: 'STATE_RUN_NOT_FOUND',
        category: 'STATE',
        agentAction: 'report_to_user',
        retryable: false,
      });
    }
    if (existing.version !== record.version) {
      throw new WorkflowError('Version conflict — run was modified by another process', {
        code: 'STATE_SNAPSHOT_MISMATCH',
        category: 'STATE',
        agentAction: 'report_to_user',
        retryable: true,
      });
    }
    const updated: RunRecord = {
      ...record,
      run_phase: deriveRunPhase(record),
      version: record.version + 1,
      updated_at: new Date().toISOString(),
    };
    this.runs.set(updated.id, updated);
    return updated;
  }

  async claimStep(
    runId: string,
    stepName: string,
    definition: WorkflowDefinition,
  ): Promise<RunRecord> {
    const run = await this.get(runId);
    const alreadyDone = [
      ...run.completed_steps,
      ...run.in_progress_steps,
      ...run.failed_steps,
      ...run.skipped_steps,
    ];
    if (alreadyDone.includes(stepName)) {
      throw new WorkflowError(`Step '${stepName}' is already claimed or done`, {
        code: 'STATE_STEP_ALREADY_CLAIMED',
        category: 'STATE',
        agentAction: 'resolve_precondition',
        retryable: false,
      });
    }
    if (!findEligibleSteps(definition, run).includes(stepName)) {
      throw new WorkflowError(`Step '${stepName}' is not eligible`, {
        code: 'STATE_STEP_NOT_ELIGIBLE',
        category: 'STATE',
        agentAction: 'resolve_precondition',
        retryable: false,
      });
    }
    const updated: RunRecord = {
      ...run,
      in_progress_steps: [...run.in_progress_steps, stepName],
      version: run.version + 1,
      updated_at: new Date().toISOString(),
    };
    this.runs.set(updated.id, updated);
    return updated;
  }

  async list(workflowId?: string): Promise<RunRecord[]> {
    const all = [...this.runs.values()];
    return workflowId !== undefined ? all.filter((r) => r.workflow_id === workflowId) : all;
  }
}

/** A minimal FailedAttemptStoreLike double that records every append() call for assertion. */
function makeFailedAttemptStoreDouble(): FailedAttemptStoreLike & {
  appended: Array<{ runId: string; line: string }>;
} {
  const appended: Array<{ runId: string; line: string }> = [];
  return {
    appended,
    async append(runId: string, line: string): Promise<void> {
      appended.push({ runId, line });
    },
    async read() {
      return { records: [], capped: false };
    },
    async deleteAllForRun(): Promise<void> {},
    async listOrphans() {
      return [];
    },
  };
}

const agentWorkflowDef = (id: string): WorkflowDefinition => ({
  id,
  name: 'Seam Test WF',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    'step-agent': { description: 'Agent step', execution: 'agent', depends_on: [] },
  },
});

/** Connects a fresh in-memory MCP client to `server` and returns a typed callTool helper. */
async function connectClient(
  server: McpServer,
): Promise<(name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'seam-test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return async (name: string, args: Record<string, unknown>) => {
    const raw = await client.callTool({ name, arguments: args });
    const content = (raw as { content: Array<{ type: string; text: string }> }).content;
    return JSON.parse(content[0]!.text) as Record<string, unknown>;
  };
}

describe('createRealmMcpServer — RunStore injection seam (issue #188, PR-1)', () => {
  describe('local default — byte-identical to pre-#188 behavior', () => {
    it('a JsonFileStore run store (no artifact stores injected) derives co-located artifact stores from runsDirPath — append_trace → execute_step round-trips a WAL', async () => {
      const runDir = await mkdtemp(join(tmpdir(), 'realm-seam-runs-'));
      const workflowDir = await mkdtemp(join(tmpdir(), 'realm-seam-wf-'));
      try {
        const workflowStore = new JsonWorkflowStore(workflowDir);
        const def = agentWorkflowDef('seam-local-wf');
        await workflowStore.register(def);

        const server = createRealmMcpServer({
          runStore: new JsonFileStore(runDir),
          workflowStore,
        });
        const callTool = await connectClient(server);

        const startEnvelope = await callTool('start_run', { workflow_id: def.id });
        const runId = startEnvelope['run_id'] as string;

        await callTool('append_trace', {
          run_id: runId,
          step_id: 'step-agent',
          entries: [{ event: 'wal_entry' }],
        });

        const execEnvelope = await callTool('execute_step', {
          run_id: runId,
          command: 'step-agent',
          params: {},
        });

        // execute_step's own MCP response deliberately strips evidence/data (agents are
        // directed to get_run_state instead) — so the round-trip proof is that the WAL was
        // actually ADOPTED and cleared, not merely ignored. A fresh JsonTraceBufferStore
        // pointed at the SAME runDir (as the co-located derivation would have used internally)
        // reads empty ONLY if the derivation genuinely pointed there and execute_step consumed it.
        expect(execEnvelope['status']).toBe('ok');
        const verifyTraceBufferStore = new JsonTraceBufferStore(runDir);
        const remaining = await verifyTraceBufferStore.read(runId, 'step-agent');
        expect(remaining).toHaveLength(0);
      } finally {
        await rm(runDir, { recursive: true, force: true });
        await rm(workflowDir, { recursive: true, force: true });
      }
    });
  });

  describe('injected artifact stores are used', () => {
    it('an injected traceBufferStore is the one execute_step actually reads from (not a derived default)', async () => {
      const workflowDir = await mkdtemp(join(tmpdir(), 'realm-seam-inject-wf-'));
      try {
        const workflowStore = new JsonWorkflowStore(workflowDir);
        const def = agentWorkflowDef('seam-inject-wf');
        await workflowStore.register(def);

        const injectedTraceBufferStore = new InMemoryTraceBufferStore();
        const injectedFailedAttemptStore = makeFailedAttemptStoreDouble();

        const server = createRealmMcpServer({
          runStore: new MinimalRunStore(), // no runsDirPath — injection is the ONLY path here
          workflowStore,
          traceBufferStore: injectedTraceBufferStore,
          failedAttemptStore: injectedFailedAttemptStore,
        });
        const callTool = await connectClient(server);

        const startEnvelope = await callTool('start_run', { workflow_id: def.id });
        const runId = startEnvelope['run_id'] as string;

        await callTool('append_trace', {
          run_id: runId,
          step_id: 'step-agent',
          entries: [{ event: 'injected_wal_entry' }],
        });
        // Prove it landed in the INJECTED instance specifically, before execute_step consumes it.
        const preFinalize = await injectedTraceBufferStore.read(runId, 'step-agent');
        expect(preFinalize.some((e) => e.event === 'injected_wal_entry')).toBe(true);

        const execEnvelope = await callTool('execute_step', {
          run_id: runId,
          command: 'step-agent',
          params: {},
        });

        // execute_step's own MCP response deliberately strips evidence/data — the round-trip
        // proof is that the INJECTED store (the only trace-buffer store that exists in this
        // test — MinimalRunStore has no runsDirPath, so nothing could have been derived) was
        // actually adopted-from and cleared by a successful execute_step.
        expect(execEnvelope['status']).toBe('ok');
        const remaining = await injectedTraceBufferStore.read(runId, 'step-agent');
        expect(remaining).toHaveLength(0);
      } finally {
        await rm(workflowDir, { recursive: true, force: true });
      }
    });

    it('an injected failedAttemptStore receives a record on a validation-rejected execute_step', async () => {
      const workflowDir = await mkdtemp(join(tmpdir(), 'realm-seam-inject-fa-wf-'));
      try {
        const workflowStore = new JsonWorkflowStore(workflowDir);
        const def: WorkflowDefinition = {
          id: 'seam-inject-fa-wf',
          name: 'Seam Inject FA WF',
          version: 1,
          schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
          steps: {
            'step-agent': {
              description: 'Agent step with a required input field',
              execution: 'agent',
              depends_on: [],
              input_schema: { type: 'object', required: ['must_have'] },
            },
          },
        };
        await workflowStore.register(def);

        const injectedFailedAttemptStore = makeFailedAttemptStoreDouble();

        const server = createRealmMcpServer({
          runStore: new MinimalRunStore(),
          workflowStore,
          traceBufferStore: new InMemoryTraceBufferStore(),
          failedAttemptStore: injectedFailedAttemptStore,
        });
        const callTool = await connectClient(server);

        const startEnvelope = await callTool('start_run', { workflow_id: def.id });
        const runId = startEnvelope['run_id'] as string;

        // Missing the required 'must_have' field → VALIDATION_INPUT_SCHEMA rejection, which is
        // exactly the path that fans out to the failed-attempt sidecar.
        const execEnvelope = await callTool('execute_step', {
          run_id: runId,
          command: 'step-agent',
          params: {},
        });
        expect(execEnvelope['status']).toBe('error');
        expect(execEnvelope['error_code']).toBe('VALIDATION_INPUT_SCHEMA');

        expect(injectedFailedAttemptStore.appended.length).toBe(1);
        expect(injectedFailedAttemptStore.appended[0]?.runId).toBe(runId);
      } finally {
        await rm(workflowDir, { recursive: true, force: true });
      }
    });
  });

  describe('co-location fail-loud', () => {
    it('a run store without runsDirPath and NO injected artifact stores throws a typed misconfiguration error — never a silent empty-trace store', () => {
      expect(() => createRealmMcpServer({ runStore: new MinimalRunStore() })).toThrow(
        /runsDirPath/,
      );
    });

    it('the thrown error is a typed WorkflowError (ENGINE_INTERNAL, stop, not retryable)', () => {
      try {
        createRealmMcpServer({ runStore: new MinimalRunStore() });
        expect.unreachable('createRealmMcpServer should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(WorkflowError);
        expect((err as WorkflowError).code).toBe('ENGINE_INTERNAL');
        expect((err as WorkflowError).agentAction).toBe('stop');
        expect((err as WorkflowError).retryable).toBe(false);
      }
    });

    it('injecting only ONE of the two artifact stores (with a runsDirPath-less run store) still throws — partial injection is not enough', () => {
      expect(() =>
        createRealmMcpServer({
          runStore: new MinimalRunStore(),
          traceBufferStore: new InMemoryTraceBufferStore(),
          // failedAttemptStore NOT injected.
        }),
      ).toThrow(/runsDirPath/);
    });
  });
});
