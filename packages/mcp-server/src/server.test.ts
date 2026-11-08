// Tests for createRealmMcpServer's construction seam (issue #188, PR-1): the RunStore injection
// widen + the co-located artifact-store injection contract.
import { declared } from './test-support/declared.js';
import { declareReleaseLine } from '@sensigo/realm';
import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client';
import {
  InMemoryTraceBufferStore,
  WorkflowError,
  findEligibleSteps,
  deriveRunPhase,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  applySettlement,
  floorAtRecord,
  systemClock,
  takeRawReading,
  takeReading,
  writtenSnapshot,
} from '@sensigo/realm';
import type { RunStore, RunRecord, CreateRunOptions, WorkflowDefinition } from '@sensigo/realm';
import { createRealmMcpServer } from './server.js';
import type { FailedAttemptStoreLike } from './tools/start-run.js';
import type {
  Snapshot,
  Listing,
  CreateResult,
  SettlementDelta,
  StoreSettlement,
} from '@sensigo/realm';
import { makeTempHome } from './test-support/temp-home.js';

/**
 * Minimal hand-rolled `RunStore` — deliberately does NOT expose `runsDirPath` (no filesystem
 * backing at all), mirroring the shape a Postgres/object-storage-backed run store would have.
 * Used to exercise the "run store without runsDirPath" branches of the co-location seam.
 */
class MinimalRunStore implements RunStore {
  // issue #620 PR-C: a test double declares this realm's release line.
  static {
    declareReleaseLine(this);
  }
  private readonly runs = new Map<string, RunRecord>();
  readonly persistsClaims = true;
  /** #715 (b): every store reads the time only through its clock — here the host's. */
  readonly clock = systemClock;

  async create(options: CreateRunOptions): Promise<CreateResult> {
    const at = takeReading(this.clock);
    const now = at.toISOString();
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
    return { ...writtenSnapshot(record, at), created: true };
  }

  async get(runId: string): Promise<Snapshot> {
    const r = takeRawReading(this.clock);
    return writtenSnapshot(this.stored(runId), floorAtRecord(r, this.stored(runId)));
  }

  private stored(runId: string): RunRecord {
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

  async update(record: RunRecord): Promise<Snapshot> {
    const existing = this.stored(record.id);
    const at = takeReading(this.clock, existing);
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
      updated_at: at.toISOString(),
    };
    this.runs.set(updated.id, updated);
    return writtenSnapshot(updated, at);
  }

  async claimStep(
    runId: string,
    stepName: string,
    definition: WorkflowDefinition,
  ): Promise<Snapshot> {
    const run = this.stored(runId);
    const at = takeReading(this.clock, run);
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
      // #715 (b): the settle reads the claim it fences (`claims[step]`) — a store that keeps claims
      // writes one (token-less here); the legacy path this double used to take never read it.
      claims: { ...run.claims, [stepName]: { since: at.toISOString(), deadline: null } },
      version: run.version + 1,
      updated_at: at.toISOString(),
    };
    this.runs.set(updated.id, updated);
    return writtenSnapshot(updated, at);
  }

  /** #715 (b): `settleStep` is required — the shared transform, at this write's one reading. */
  async settleStep(
    runId: string,
    delta: SettlementDelta,
    definition?: WorkflowDefinition,
  ): Promise<StoreSettlement> {
    const fresh = this.stored(runId);
    const at = takeReading(this.clock, fresh, delta);
    const outcome = applySettlement(fresh, delta, definition, { at, cascadeGuards: true });
    if (!outcome.applied) return { ...outcome, at };
    const updated: RunRecord = {
      ...outcome.run,
      run_phase: deriveRunPhase(outcome.run),
      version: fresh.version + 1,
    };
    this.runs.set(runId, updated);
    return { ...outcome, run: updated, at };
  }

  async list(workflowId?: string): Promise<Listing> {
    const r = takeRawReading(this.clock);
    const all = [...this.runs.values()];
    const kept =
      workflowId !== undefined ? all.filter((rec) => rec.workflow_id === workflowId) : all;
    return {
      snapshots: kept.map((rec) => writtenSnapshot(rec, floorAtRecord(r, rec))),
      read_at: r,
      consistent_snapshot: true,
    };
  }
}

/** A minimal FailedAttemptStoreLike double that records every append() call for assertion. */
function makeFailedAttemptStoreDouble(): FailedAttemptStoreLike & {
  appended: Array<{ runId: string; line: string }>;
} {
  const appended: Array<{ runId: string; line: string }> = [];
  return declared({
    appended,
    async append(runId: string, line: string): Promise<void> {
      appended.push({ runId, line });
    },
    async read() {
      return { records: [], capped: false };
    },
    async deleteAllForRun() {
      return { bytes_deleted: 0 };
    },
    async listOrphans() {
      return [];
    },
  });
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
    it('the four stores from one home, spread into the server: append_trace → execute_step round-trips a WAL', async () => {
      const h = await makeTempHome();
      try {
        const workflowStore = h.stores.workflowStore;
        const def = agentWorkflowDef('seam-local-wf');
        await workflowStore.register(def);

        const server = createRealmMcpServer({
          ...h.stores,
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
        // actually ADOPTED and cleared, not merely ignored: the home's own trace store, the one
        // the server was handed, reads it empty only if execute_step consumed it (#616 PR-2c, c0).
        expect(execEnvelope['status']).toBe('ok');
        const remaining = await h.stores.traceBufferStore.read(runId, 'step-agent');
        expect(remaining).toHaveLength(0);
      } finally {
        await h.cleanup();
      }
    });
  });

  describe('injected artifact stores are used', () => {
    it('an injected traceBufferStore is the one execute_step actually reads from (not a derived default)', async () => {
      const h = await makeTempHome();
      try {
        const workflowStore = h.stores.workflowStore;
        const def = agentWorkflowDef('seam-inject-wf');
        await workflowStore.register(def);

        // issue #616 PR-0: the injected trace buffer reads the injected run store.
        const injectedRunStore = new MinimalRunStore();
        const injectedTraceBufferStore = new InMemoryTraceBufferStore(injectedRunStore);
        const injectedFailedAttemptStore = makeFailedAttemptStoreDouble();

        const server = createRealmMcpServer({
          runStore: injectedRunStore, // no runsDirPath — injection is the ONLY path here
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
        await h.cleanup();
      }
    });

    it('an injected failedAttemptStore receives a record on a validation-rejected execute_step', async () => {
      const h = await makeTempHome();
      try {
        const workflowStore = h.stores.workflowStore;
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

        const injectedRunStore = new MinimalRunStore();
        const server = createRealmMcpServer({
          runStore: injectedRunStore,
          workflowStore,
          traceBufferStore: new InMemoryTraceBufferStore(injectedRunStore),
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
        await h.cleanup();
      }
    });
  });
});
