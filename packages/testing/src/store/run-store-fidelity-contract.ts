// run-store-fidelity-contract.ts — framework-agnostic Test Compatibility Kit (TCK) for RunStore
// field-fidelity honesty + claimStep single-owner conformance (issue #188, PR-2).
//
// Pure case descriptors, NOT describe/it/expect — mirrors per-run-artifact-store-contract.ts's
// own precedent (issue #183) and its rationale: importing vitest here would make it a runtime
// dependency of this published package (this module ships in @sensigo/realm-testing's dist).
// Each calling test file supplies an adapter and wires the returned descriptors into ITS OWN test
// framework.
//
// This is "the forcing part" (issue #188): FIDELITY_HONESTY does not just check that a store
// SAYS it persists a field — it writes a real sample value through create/update and reads it
// back, so a store that DECLARES `persistedRunRecordFields` dishonestly (claims a field, drops it
// on write) fails conformance here, before it ever ships. A store that declares NOTHING passes
// this law vacuously (zero cases generated) — see `runStoreFidelityContract`'s own doc.
import {
  WorkflowError,
  type RunStore,
  type RunRecord,
  type LoadBearingRunRecordField,
  type WorkflowDefinition,
} from '@sensigo/realm';

/** One of the two laws every `RunStore` implementation should be run against (issue #188). */
export type RunStoreFidelityLaw = 'FIDELITY_HONESTY' | 'CLAIM_SINGLE_OWNER';

/**
 * A single, framework-agnostic contract case. `run()` throws (rejects) on failure — any test
 * framework's `await run()` (rejecting fails the test) or `expect(run()).resolves...` /
 * `expect(run()).rejects...` maps directly onto this.
 */
export interface RunStoreFidelityContractCase {
  law: RunStoreFidelityLaw;
  name: string;
  run: () => Promise<void>;
}

/** Adapter a calling test file supplies to parameterize the contract against one concrete store. */
export interface RunStoreFidelityContractAdapter {
  /** The store under test. */
  store: RunStore;
  /**
   * A workflow definition carrying exactly one step, named `stepName`, that is immediately
   * eligible on a freshly-created run (no unmet `depends_on`) — used by CLAIM_SINGLE_OWNER to
   * race two concurrent `claimStep` calls against a fresh run of this definition.
   */
  definition: WorkflowDefinition;
  stepName: string;
}

/**
 * One realistic, minimal-but-valid sample value per {@link LoadBearingRunRecordField} — used by
 * FIDELITY_HONESTY to actually exercise a round-trip. Deliberately real shapes (not `{}` or
 * `null`), since a store that only round-trips empty/degenerate values would not actually prove
 * fidelity for the shapes the engine truly writes.
 *
 * The type annotation is CLOSED over every key of `LoadBearingRunRecordField` — issue #279
 * (increment 1) relies on this: widening that union to add `settled`/`finalizer_ledger` forced a
 * compile error here until both got a sample value, which is deliberate (a store declaring
 * `settleStep` gets these two FIDELITY_HONESTY cases automatically, everywhere
 * `runStoreFidelityContract` already runs — including the byte-untouched CLI contract test file;
 * see that file's own header for why it needs no edit).
 */
const SAMPLE_VALUES: {
  [K in LoadBearingRunRecordField]: NonNullable<RunRecord[K]>;
} = {
  capability_blocks: {
    'tck-step': {
      requirement: { kind: 'handler', name: 'tck-handler' },
      code: 'ENGINE_HANDLER_NOT_REGISTERED',
      at: '2026-01-01T00:00:00.000Z',
    },
  },
  workflow_context_snapshots: {
    'tck-key': {
      source_path: '/tck/sample.md',
      content: 'hello',
      content_hash: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      loaded_at: '2026-01-01T00:00:00.000Z',
    },
  },
  extension_identity: [
    {
      captured_at: '2026-01-01T00:00:00.000Z',
      modules: [],
      tree: {
        roots: [],
        rules: 'tck-rules',
        file_count: 0,
        total_bytes: 0,
        tree_hash: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        truncated: false,
      },
      coverage: 'dir_tree_v1',
    },
  ],
  validation_rejections: { 'tck-step': 3 },
  defaulted_steps: ['tck-step'],
  // issue #279 (increment 1): sample values for the two settlement fields — dormant data shapes
  // (nothing writes these until PR-B), but real/valid ones per their own RunRecord doc.
  settled: { 'tck-step': { token: 'tck-fidelity-token', outcome: 'complete' } },
  finalizer_ledger: { 'tck-finalizer': { status: 'pending', rank: 0 } },
};

/**
 * Builds the contract cases for `adapter`.
 *
 * **FIDELITY_HONESTY** — one case PER FIELD in `adapter.store.persistedRunRecordFields` (zero
 * cases if the store declares nothing — a store with no declaration passes this law vacuously,
 * by construction, and gets the conservative runtime gates instead; that combination is
 * correct-by-design, not a TCK gap). Each case: `create` a fresh run, `update` it to carry a
 * realistic sample value for that field, `get` it back, and byte-compare (via JSON, since every
 * `LoadBearingRunRecordField` is plain-JSON-serializable data) what was written against what was
 * read. A mismatch means the store's declaration is DISHONEST.
 *
 * **CLAIM_SINGLE_OWNER** — races two concurrent `claimStep(runId, sameStep)` calls against a
 * fresh run; asserts exactly one resolves and the other rejects with
 * `STATE_STEP_ALREADY_CLAIMED`. **Cross-host caveat: this only exercises and asserts the
 * SAME-PROCESS (same-host) guarantee** — for an in-memory store this is same-process by
 * construction; for a lock-based store like `JsonFileStore` it exercises same-host
 * multi-process safety via the real OS-level lock the two concurrent calls contend on, but this
 * TCK run happens within ONE test process, so it does not and cannot exercise true cross-host
 * concurrency. The CROSS-HOST single-owner obligation (stated on `RunStore.claimStep`'s own
 * JSDoc) can only be verified by a store's OWN conformance suite against its real concurrent
 * backend (e.g. a Postgres store's suite exercising genuine multi-connection contention) — do
 * NOT read a green result here as proof of cross-host safety.
 */
export function runStoreFidelityContract(
  adapter: RunStoreFidelityContractAdapter,
): RunStoreFidelityContractCase[] {
  const cases: RunStoreFidelityContractCase[] = [];

  const declaredFields =
    adapter.store.persistedRunRecordFields ?? new Set<LoadBearingRunRecordField>();
  for (const field of declaredFields) {
    cases.push({
      law: 'FIDELITY_HONESTY',
      name: `a store declaring '${field}' actually round-trips it (create → update → get)`,
      run: async () => {
        const { run } = await adapter.store.create({
          workflowId: `tck-fidelity-${field}`,
          workflowVersion: 1,
          params: {},
        });
        const sampleValue = SAMPLE_VALUES[field];
        await adapter.store.update({ ...run, [field]: sampleValue });
        const reread = await adapter.store.get(run.id);
        const actual = (reread as unknown as Record<string, unknown>)[field];
        const wroteJson = JSON.stringify(sampleValue);
        const readJson = JSON.stringify(actual);
        if (readJson !== wroteJson) {
          throw new Error(
            `store declares persistedRunRecordFields includes '${field}' but a round-trip did ` +
              `NOT preserve it — the declared fidelity is DISHONEST (issue #188). wrote: ` +
              `${wroteJson}, read back: ${readJson}`,
          );
        }
      },
    });
  }

  cases.push({
    law: 'CLAIM_SINGLE_OWNER',
    name: 'two concurrent claimStep calls for the same (runId, step) — exactly one succeeds',
    run: async () => {
      const { run } = await adapter.store.create({
        workflowId: `tck-claim-${Math.random().toString(36).slice(2)}`,
        workflowVersion: 1,
        params: {},
      });
      const results = await Promise.allSettled([
        adapter.store.claimStep(run.id, adapter.stepName, adapter.definition),
        adapter.store.claimStep(run.id, adapter.stepName, adapter.definition),
      ]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (fulfilled.length !== 1) {
        throw new Error(
          `expected exactly ONE of two concurrent claimStep calls for the same (runId, step) to ` +
            `succeed, got ${fulfilled.length} — the single-owner guarantee is violated (breaks ` +
            'the resurrect-race protection, issue #184, and the trace-buffer epoch minting, issue #185).',
        );
      }
      for (const r of rejected) {
        const err: unknown = r.reason;
        if (!(err instanceof WorkflowError) || err.code !== 'STATE_STEP_ALREADY_CLAIMED') {
          const described = err instanceof WorkflowError ? err.code : String(err);
          throw new Error(
            `expected the losing claimStep call to reject with a WorkflowError carrying code ` +
              `STATE_STEP_ALREADY_CLAIMED, got: ${described}`,
          );
        }
      }
    },
  });

  return cases;
}
