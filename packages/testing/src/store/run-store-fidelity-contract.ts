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
import { crossCopyNote } from './cross-copy-note.js';
import { storeReleaseLineLaw } from './store-release-line-law.js';
import {
  WorkflowError,
  type Attributed,
  type EvidenceSnapshot,
  type RunStore,
  type RunRecord,
  type LoadBearingRunRecordField,
  type WorkflowDefinition,
} from '@sensigo/realm';

/**
 * The laws every `RunStore` implementation should be run against — EXPORTED as a const so a wiring
 * file can derive the list it runs from it (issue #625): a law added here then runs everywhere the
 * contract is wired, or is named, with a reason, in that file's `NOT_RUN` list. The members, in
 * order: `FIDELITY_HONESTY` and `CLAIM_SINGLE_OWNER` (issue #188), `SEALED_BY_ROUNDTRIP` (issue
 * #367 — the seal arm survives a proper terminal write byte-for-byte), `CLAIM_NAMES_HOLDER` (issue
 * #625 — a claim reads back with the program that took the step and when),
 * `EVIDENCE_KEEPS_DRIVER_AND_PROOF` (issue #625 — the program that did a step's work and the proof
 * on an answer's entry survive a round trip) and `STORE_RELEASE_LINE_TRUE` (issue #620 PR-C — the
 * store's declared release line is its errors' line).
 */
export const RUN_STORE_FIDELITY_LAWS = [
  'FIDELITY_HONESTY',
  'CLAIM_SINGLE_OWNER',
  'SEALED_BY_ROUNDTRIP',
  'CLAIM_NAMES_HOLDER',
  'EVIDENCE_KEEPS_DRIVER_AND_PROOF',
  'STORE_RELEASE_LINE_TRUE',
] as const;

export type RunStoreFidelityLaw = (typeof RUN_STORE_FIDELITY_LAWS)[number];

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

/** The program the holder laws name — a synthetic label, never a real host or user. */
const TCK_CLAIMANT: Attributed = { by: 'tck-program', by_source: 'stated', channel: 'tck' };

/**
 * `CLAIM_NAMES_HOLDER`'s one assertion: the step's claim carries a `since` inside the bracket
 * [before, after] taken around the claiming call (`since` is the STORE's own act, at the write that
 * creates the claim), and carries the claimant as `holder` — or, when none was passed, no `holder`
 * key at all.
 */
function assertClaimNames(
  record: RunRecord,
  stepName: string,
  claimant: Attributed | undefined,
  before: number,
  after: number,
  where: string,
): void {
  const claim = record.claims?.[stepName];
  if (claim === undefined) {
    throw new Error(
      `CLAIM_NAMES_HOLDER (${where}): the store wrote no claim for step '${stepName}'`,
    );
  }
  if (typeof claim.since !== 'string') {
    throw new Error(
      `CLAIM_NAMES_HOLDER (${where}): the claim carries no 'since' — a store stamps it on EVERY ` +
        `claim, in the write that creates it (got ${JSON.stringify(claim.since)})`,
    );
  }
  const at = Date.parse(claim.since);
  if (!(at >= before && at <= after)) {
    throw new Error(
      `CLAIM_NAMES_HOLDER (${where}): 'since' ${claim.since} is outside the bracket around the ` +
        `claiming call (${new Date(before).toISOString()} .. ${new Date(after).toISOString()}) — ` +
        "it is the store's own act, stamped at the claim write",
    );
  }
  if (claimant === undefined) {
    if ('holder' in claim) {
      throw new Error(
        `CLAIM_NAMES_HOLDER (${where}): a claim made with no claimant must carry no 'holder' ` +
          `(got ${JSON.stringify(claim.holder)})`,
      );
    }
    return;
  }
  if (JSON.stringify(claim.holder) !== JSON.stringify(claimant)) {
    throw new Error(
      `CLAIM_NAMES_HOLDER (${where}): expected holder ${JSON.stringify(claimant)}, got ` +
        `${JSON.stringify(claim.holder)} — claimStep's fourth argument must be written as ` +
        '`claims[step].holder`',
    );
  }
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
  // issue #367: present so the closed-map compile check stays satisfied. The GENERIC loop below
  // deliberately skips this field — see SEALED_BY_ROUNDTRIP for why writing it the generic way
  // would violate the boundary it shares a package with.
  sealed_by: { arm: 'complete' },
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
    // issue #367: `sealed_by` cannot ride the generic loop. That loop writes its sample onto a
    // LIVE record, and a live record carrying a seal is an orphan — the store boundary refuses it
    // (STATE_SEAL_ORPHANED), so the case would red for a reason that has nothing to do with
    // fidelity. It gets the dedicated SEALED_BY_ROUNDTRIP case below, which seals the run properly
    // first and then asserts the arm survives byte-for-byte.
    if (field === 'sealed_by') continue;
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

  if (declaredFields.has('sealed_by')) {
    cases.push({
      law: 'SEALED_BY_ROUNDTRIP',
      name: 'a store declaring sealed_by round-trips the seal arm through a PROPER terminal write',
      run: async () => {
        const { run } = await adapter.store.create({
          workflowId: 'tck-fidelity-sealed-by',
          workflowVersion: 1,
          params: {},
        });
        // A real seal: terminal_state and sealed_by in the same write, exactly as every engine
        // seal site does it.
        await adapter.store.update({
          ...run,
          completed_steps: ['tck-step'],
          terminal_state: true,
          sealed_by: { arm: 'complete', step: 'tck-step' },
          terminal_reason: 'Workflow completed.',
        });
        const reread = await adapter.store.get(run.id);
        const wrote = JSON.stringify({ arm: 'complete', step: 'tck-step' });
        const read = JSON.stringify(reread.sealed_by);
        if (read !== wrote) {
          throw new Error(
            `store declares persistedRunRecordFields includes 'sealed_by' but a terminal ` +
              `round-trip did NOT preserve it — the run's recorded outcome silently changed ` +
              `(issue #367). wrote: ${wrote}, read back: ${read}`,
          );
        }
      },
    });
  }

  // issue #625 (the holder slice) — CLAIM_NAMES_HOLDER. Active only for a store that keeps claims
  // (`persistsClaims === true`): a store that keeps none has nothing to name a holder ON, and says
  // so by name rather than passing silently. The case name follows the fenced trace-buffer
  // contract's skip idiom — `SKIPPED — <reason>: <name>` — so a wiring run lists it.
  if (adapter.store.persistsClaims === true) {
    cases.push(
      {
        law: 'CLAIM_NAMES_HOLDER',
        name: 'a claim made with a claimant reads back with that holder and a since — returned and re-read',
        run: async () => {
          const { run } = await adapter.store.create({
            workflowId: `tck-holder-${Math.random().toString(36).slice(2)}`,
            workflowVersion: 1,
            params: {},
          });
          const before = Date.now();
          const claimed = await adapter.store.claimStep(
            run.id,
            adapter.stepName,
            adapter.definition,
            TCK_CLAIMANT,
          );
          const after = Date.now();
          assertClaimNames(
            claimed,
            adapter.stepName,
            TCK_CLAIMANT,
            before,
            after,
            'the returned record',
          );
          assertClaimNames(
            await adapter.store.get(run.id),
            adapter.stepName,
            TCK_CLAIMANT,
            before,
            after,
            'a re-read of the stored record',
          );
        },
      },
      {
        law: 'CLAIM_NAMES_HOLDER',
        name: 'a claim made WITHOUT a claimant reads back with a since and NO holder',
        run: async () => {
          const { run } = await adapter.store.create({
            workflowId: `tck-holder-${Math.random().toString(36).slice(2)}`,
            workflowVersion: 1,
            params: {},
          });
          const before = Date.now();
          await adapter.store.claimStep(run.id, adapter.stepName, adapter.definition);
          const after = Date.now();
          assertClaimNames(
            await adapter.store.get(run.id),
            adapter.stepName,
            undefined,
            before,
            after,
            'a re-read of the stored record',
          );
        },
      },
    );
  } else {
    cases.push({
      law: 'CLAIM_NAMES_HOLDER',
      name: "SKIPPED — store does not declare 'persistsClaims': claim holder round-trip",
      run: async () => {
        // Intentional no-op — see the case name for why.
      },
    });
  }

  // issue #625 — EVIDENCE_KEEPS_DRIVER_AND_PROOF. Always active: every store round-trips evidence.
  cases.push({
    law: 'EVIDENCE_KEEPS_DRIVER_AND_PROOF',
    name: 'an entry written with driven_by and a gate_response entry written with claim_proof read back with both',
    run: async () => {
      const { run } = await adapter.store.create({
        workflowId: `tck-evidence-${Math.random().toString(36).slice(2)}`,
        workflowVersion: 1,
        params: {},
      });
      const base: EvidenceSnapshot = {
        step_id: adapter.stepName,
        started_at: '2026-01-01T00:00:00.000Z',
        completed_at: '2026-01-01T00:00:01.000Z',
        duration_ms: 1,
        input_summary: {},
        output_summary: {},
        status: 'success',
        evidence_hash: 'tck-evidence',
      };
      const proof = { proof: 'unverifiable', cause: 'claim_has_no_token' } as const;
      await adapter.store.update({
        ...run,
        evidence: [
          { ...base, driven_by: TCK_CLAIMANT },
          { ...base, kind: 'gate_response', claim_proof: proof },
        ],
      });
      const reread = await adapter.store.get(run.id);
      const wroteDriver = JSON.stringify(TCK_CLAIMANT);
      const readDriver = JSON.stringify(reread.evidence[0]?.driven_by);
      if (readDriver !== wroteDriver) {
        throw new Error(
          `a store must round-trip an evidence entry's driven_by (issue #625): wrote ${wroteDriver}, ` +
            `read back ${readDriver}`,
        );
      }
      const wroteProof = JSON.stringify(proof);
      const readProof = JSON.stringify(reread.evidence[1]?.claim_proof);
      if (readProof !== wroteProof) {
        throw new Error(
          `a store must round-trip a gate_response entry's claim_proof (issue #625): wrote ` +
            `${wroteProof}, read back ${readProof}`,
        );
      }
    },
  });

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
              `STATE_STEP_ALREADY_CLAIMED, got: ${described}${crossCopyNote(err, WorkflowError)}`,
          );
        }
      }
    },
  });

  cases.push({
    law: 'STORE_RELEASE_LINE_TRUE',
    name: "the store's declared release line is the line of its own refusal (get of a missing run)",
    run: () =>
      storeReleaseLineLaw(adapter.store, () =>
        adapter.store.get('store-release-line-true-missing-run'),
      ),
  });

  return cases;
}
