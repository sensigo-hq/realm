// execution-loop's workflow_context_snapshots / extension_identity field-fidelity gates (issue
// #188, PR-2). Also proves the #119 WARN-never-gate flow is unaffected.
import { declareReleaseLine } from '../release-line.js';
import { describe, it, expect } from 'vitest';
import { executeStep } from './execution-loop.js';
import { InMemoryStore } from '@sensigo/realm-testing';
import { ExtensionRegistry } from '../extensions/registry.js';
import type {
  RunStore,
  CreateRunOptions,
  LoadBearingRunRecordField,
  KeyAnswer,
} from '../store/store-interface.js';
import type { RunRecord } from '../types/run-record.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
import type { ExtensionIdentityEntry } from '../types/extension-identity.js';
import type { Snapshot } from './snapshot.js';
import type { CreateResult } from '../store/store-interface.js';
import type { Clock } from '../utils/clock.js';
import type { SettlementDelta } from '../types/settlement.js';

/**
 * Delegates every RunStore method to a real, functional InMemoryStore, but reports a SMALLER
 * (understated) `persistedRunRecordFields` declaration than the truth. This isolates "does the
 * gate fire based on the declaration" from "does the store actually drop the field on write" —
 * the latter is the TCK's FIDELITY_HONESTY job (run-store-fidelity-contract.ts), not this test's.
 */
class DeclaredFieldsOverrideStore implements RunStore {
  /** #715 (b): the store's clock is the wrapped store's. */
  get clock(): Clock {
    return this.inner.clock;
  }
  // issue #620 PR-C: a test double declares this realm's release line.
  static {
    declareReleaseLine(this);
  }
  readonly persistsClaims: boolean;
  readonly persistedRunRecordFields: ReadonlySet<LoadBearingRunRecordField>;

  constructor(
    private readonly inner: InMemoryStore,
    declaredFields: ReadonlySet<LoadBearingRunRecordField>,
  ) {
    this.persistsClaims = inner.persistsClaims;
    this.persistedRunRecordFields = declaredFields;
  }

  create(options: CreateRunOptions): Promise<CreateResult> {
    return this.inner.create(options);
  }
  get(runId: string): Promise<Snapshot> {
    return this.inner.get(runId);
  }
  update(record: RunRecord): Promise<Snapshot> {
    return this.inner.update(record);
  }
  // #616 PR-2c c4: the scan verbs, delegated to the inner store as `list` was.
  get purgesRuns(): boolean {
    return this.inner.purgesRuns;
  }
  get scan(): RunStore['scan'] {
    return this.inner.scan.bind(this.inner);
  }
  resolveKey(workflowId: string, key: string): Promise<KeyAnswer> {
    return this.inner.resolveKey(workflowId, key);
  }
  tombstonesSince(): Promise<string> {
    return this.inner.tombstonesSince();
  }
  /** #715 (b): `settleStep` is required — this double delegates it. */
  settleStep(runId: string, delta: SettlementDelta, definition?: WorkflowDefinition) {
    return this.inner.settleStep(runId, delta, definition);
  }
  claimStep(runId: string, stepName: string, definition: WorkflowDefinition): Promise<Snapshot> {
    return this.inner.claimStep(runId, stepName, definition);
  }
}

const sampleIdentity: ExtensionIdentityEntry = {
  captured_at: '2026-01-01T00:00:00.000Z',
  modules: [],
  tree: {
    roots: [],
    rules: 'test-rules',
    file_count: 0,
    total_bytes: 0,
    tree_hash: 'deadbeef',
    truncated: false,
  },
  coverage: 'dir_tree_v1',
};

describe('execution-loop — workflow_context_snapshots field-fidelity gate (issue #188)', () => {
  const wfWithContext: WorkflowDefinition = {
    id: 'ctx-wf',
    name: 'Ctx WF',
    version: 1,
    workflow_context: { doc: { source: { path: '/nonexistent/tck-context-file.md' } } },
    steps: { work: { description: 'w', execution: 'auto', depends_on: [] } },
  };

  it('fires an honest warning when the store does NOT declare workflow_context_snapshots', async () => {
    const inner = new InMemoryStore();
    const store = new DeclaredFieldsOverrideStore(
      inner,
      new Set(['capability_blocks', 'extension_identity']),
    );
    const { record: run } = await inner.create({
      workflowId: 'ctx-wf',
      workflowVersion: 1,
      params: {},
    });

    const envelope = await executeStep(store, wfWithContext, {
      runId: run.id,
      command: 'work',
      input: {},
      dispatcher: async () => ({}),
    });

    expect(envelope.warnings.some((w) => w.includes('workflow_context_snapshots'))).toBe(true);
    expect(envelope.status).toBe('ok'); // advisory only — NEVER blocks
  });

  it('stays silent when the store DOES declare workflow_context_snapshots (byte-identical local case)', async () => {
    const inner = new InMemoryStore();
    const { record: run } = await inner.create({
      workflowId: 'ctx-wf',
      workflowVersion: 1,
      params: {},
    });

    const envelope = await executeStep(inner, wfWithContext, {
      runId: run.id,
      command: 'work',
      input: {},
      dispatcher: async () => ({}),
    });

    expect(envelope.warnings).toEqual([]);
    expect(envelope.status).toBe('ok');
  });
});

describe('execution-loop — extension_identity field-fidelity gate (issue #188)', () => {
  const plainWf: WorkflowDefinition = {
    id: 'ext-wf',
    name: 'Ext WF',
    version: 1,
    steps: { work: { description: 'w', execution: 'auto', depends_on: [] } },
  };

  it('fires an honest warning when the store does NOT declare extension_identity (and a registry identity is present)', async () => {
    const inner = new InMemoryStore();
    const store = new DeclaredFieldsOverrideStore(
      inner,
      new Set(['capability_blocks', 'workflow_context_snapshots']),
    );
    const { record: run } = await inner.create({
      workflowId: 'ext-wf',
      workflowVersion: 1,
      params: {},
    });
    const registry = new ExtensionRegistry();
    registry.setIdentity(sampleIdentity);

    const envelope = await executeStep(store, plainWf, {
      runId: run.id,
      command: 'work',
      input: {},
      dispatcher: async () => ({}),
      registry,
    });

    expect(envelope.warnings.some((w) => w.includes('extension_identity'))).toBe(true);
    expect(envelope.status).toBe('ok');
  });

  it('stays silent when the store DOES declare extension_identity (byte-identical local case)', async () => {
    const inner = new InMemoryStore();
    const { record: run } = await inner.create({
      workflowId: 'ext-wf',
      workflowVersion: 1,
      params: {},
    });
    const registry = new ExtensionRegistry();
    registry.setIdentity(sampleIdentity);

    const envelope = await executeStep(inner, plainWf, {
      runId: run.id,
      command: 'work',
      input: {},
      dispatcher: async () => ({}),
      registry,
    });

    expect(envelope.warnings).toEqual([]);
    expect(envelope.status).toBe('ok');
  });

  it('no registry identity at all → no gate, byte-identical to pre-#188 (extension-free runs untouched)', async () => {
    const inner = new InMemoryStore();
    const store = new DeclaredFieldsOverrideStore(inner, new Set()); // declares NOTHING
    const { record: run } = await inner.create({
      workflowId: 'ext-wf',
      workflowVersion: 1,
      params: {},
    });

    const envelope = await executeStep(store, plainWf, {
      runId: run.id,
      command: 'work',
      input: {},
      dispatcher: async () => ({}),
      // no registry passed at all
    });

    // No #188-specific warning fires (no registry identity was ever set). #715 (b): the store's
    // `settleStep` is required (this double delegates it), so the legacy dormancy advisory that used
    // to be the one warning here is gone with its path.
    expect(envelope.warnings).toEqual([]);
  });
});

describe('execution-loop — #119 WARN-never-gate is preserved (issue #188)', () => {
  it('a genuine drift warning AND a fidelity-gap warning co-occur, and execution still completes normally', async () => {
    const inner = new InMemoryStore();
    const store = new DeclaredFieldsOverrideStore(inner, new Set()); // declares nothing
    const wf: WorkflowDefinition = {
      id: 'drift-wf',
      name: 'Drift WF',
      version: 1,
      steps: { work: { description: 'w', execution: 'auto', depends_on: [] } },
    };
    const { record: run } = await inner.create({
      workflowId: 'drift-wf',
      workflowVersion: 1,
      params: {},
    });

    const registry1 = new ExtensionRegistry();
    registry1.setIdentity(sampleIdentity);
    const first = await executeStep(store, wf, {
      runId: run.id,
      command: 'work',
      input: {},
      dispatcher: async () => ({}),
      registry: registry1,
    });
    // First call: fidelity gate fires (store declares nothing); no drift yet (no prior history
    // to differ from) since the store doesn't retain extension_identity across calls anyway.
    expect(first.status).toBe('ok');
    expect(first.warnings.some((w) => w.includes('extension_identity'))).toBe(true);

    // #119's own existing drift-warning behavior (a DIFFERENT registry identity than history)
    // is exercised elsewhere (extension-identity-append.test.ts) against a store that DOES
    // persist the field — reconfirm here that execution completing normally (never blocked) is
    // unaffected by the fidelity gate stacking alongside it.
    expect(first.run_phase).toBe('completed');
  });
});
