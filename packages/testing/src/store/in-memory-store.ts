// InMemoryStore — in-memory implementation of RunStore for use in tests.
import {
  WorkflowError,
  findEligibleSteps,
  deriveRunPhase,
  decideIdempotencyPolicy,
  computeClaimDeadline,
  isStepSettledOrInFlight,
  applySettlement,
  assertSealIntegrity,
  brandClass,
  systemClock,
  takeReading,
  takeRawReading,
  floorAtRecord,
  floorAtHolder,
  parseStamp,
  writtenSnapshot,
  type Clock,
  type CreateResult,
  type Listing,
  type Snapshot,
  type StoreSettlement,
  type RunStore,
  type SealedBy,
  type StampSealResult,
  type RunRecord,
  type CreateRunOptions,
  type WorkflowDefinition,
  type LoadBearingRunRecordField,
  type SettlementDelta,
  type Attributed,
} from '@sensigo/realm';
import { REALM_TESTING_BRAND } from '../brand.js';

/** In-memory implementation of RunStore. Uses a Map keyed by run ID. No I/O, no locking. */
export class InMemoryStore implements RunStore {
  private readonly runs = new Map<string, RunRecord>();
  /** Idempotency-key pointer equivalent: `${workflowId}\0${key}` → runId. Parity with JsonFileStore. */
  private readonly keyIndex = new Map<string, string>();

  /** Parity with JsonFileStore: round-trips the per-claim `claims` liveness clock (issue #101). */
  readonly persistsClaims = true;

  /** Parity with JsonFileStore (issue #188): every `create`/`update` stores the whole `RunRecord`
   *  object as-is (no field-by-field mapping), so nothing is ever dropped — declares the full set. */
  readonly persistedRunRecordFields: ReadonlySet<LoadBearingRunRecordField> = new Set([
    'capability_blocks',
    'workflow_context_snapshots',
    'extension_identity',
    'validation_rejections',
    'defaulted_steps',
    // issue #279 (increment 1, PR-A): declared alongside settleStep — declaration-coherence.
    'settled',
    'finalizer_ledger',
    'sealed_by', // issue #367 — declaration-coherence with settleStep
  ]);

  /**
   * The clock this store reads the time from (issue #715; rule 10: an in-memory store may use any
   * clock). What it governs (#715 (b), D-16): every call that returns spends ONE reading and returns
   * it — `create`, `update`, `claimStep` and `settleStep` at the write, `get` and `list` BEFORE they
   * read. `stampSeal` and this store's own internal reads spend none. What it does not govern:
   * instants minted outside a store, and durations.
   */
  readonly clock: Clock;

  /**
   * @param options.clock The store's clock (#715 (a), D-3); defaults to core's shared
   *   `systemClock`. This is a defaulted AUTHORITY — it reads nothing at construction — not a
   *   parameter default that reads a clock at the call (`now = new Date()`), which is what #715's
   *   clock-reading lint forbids.
   */
  constructor(options?: { clock?: Clock }) {
    this.clock = options?.clock ?? systemClock;
  }

  async create(options: CreateRunOptions): Promise<CreateResult> {
    // Idempotency: a key match applies the re-encounter policy, like JsonFileStore.
    // issue #558 PR-C: the id of the run this create SUPERSEDES, when it supersedes one — the
    // in-memory twin of JsonFileStore's `supersede()` parameter. Stays undefined when the mapped
    // run VANISHED (nothing was superseded) and on every fresh-key create.
    let supersededId: string | undefined;
    // issue #715 (a) (M1–M4): the create's ONE reading. Unkeyed (M1): taken here, with no holder.
    // Keyed: taken first thing in the keyed path; a create that returns the existing run (M2) has
    // spent it; a superseding create (M3) is floored by the run it supersedes; a vanished mapped
    // run or an unmapped key (M4) is floored by the key's newest run, if any.
    let at: Date;
    if (options.idempotencyKey !== undefined) {
      const r = takeReading(this.clock);
      const gk = `${options.workflowId}\0${options.idempotencyKey}`;
      const existingId = this.keyIndex.get(gk);
      if (existingId !== undefined) {
        const existing = this.runs.get(existingId);
        if (existing !== undefined) {
          // `reuse` → return the existing run; `supersede` → fall through to a fresh create
          // (which overwrites the keyIndex entry below). `fail`/`reject` throw. Derives (issue
          // #279, increment 2, PR-C — D-3 leg v), matching JsonFileStore's own call-site derive —
          // decideIdempotencyPolicy's own exported `Pick<>` signature stays untouched.
          if (
            decideIdempotencyPolicy(
              { ...existing, run_phase: deriveRunPhase(existing) },
              options,
            ) === 'reuse'
          ) {
            // #715 (b): the reading it spent, floored by the existing run's own stamp (pure).
            return { ...writtenSnapshot(existing, floorAtRecord(r, existing)), created: false };
          }
          // Not `reuse` → this fresh create supersedes `existing`; stamp the link.
          supersededId = existing.id;
        }
        // mapped run vanished (or superseded) → fall through to a fresh create.
      }
      if (supersededId !== undefined) {
        at = floorAtHolder(r, this.runs.get(supersededId)!.created_at);
      } else {
        at = floorAtHolder(
          r,
          this.newestCreatedAtForKey(options.workflowId, options.idempotencyKey),
        );
      }
    } else {
      at = takeReading(this.clock);
    }

    const now = at.toISOString();
    const record: RunRecord = {
      id: crypto.randomUUID(),
      workflow_id: options.workflowId,
      workflow_version: options.workflowVersion,
      ...(options.parentRunId !== undefined ? { parent_run_id: options.parentRunId } : {}),
      ...(options.idempotencyKey !== undefined ? { idempotency_key: options.idempotencyKey } : {}),
      ...(supersededId !== undefined ? { rerun_of: supersededId } : {}),
      // #729 PR-3 correction 5 (J-5): the creator's start entry, written with the record.
      ...(options.extensionIdentity !== undefined && options.extensionIdentity.length > 0
        ? { extension_identity: options.extensionIdentity }
        : {}),
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
    if (options.idempotencyKey !== undefined) {
      this.keyIndex.set(`${options.workflowId}\0${options.idempotencyKey}`, record.id);
    }
    return { ...writtenSnapshot(record, at), created: true };
  }

  /**
   * #715 (b) (D-15, D-16): ONE raw reading BEFORE the record is read (D6-16), then the record floored
   * by its own `updated_at`. A run that does not exist has spent its reading, and throws.
   */
  async get(runId: string): Promise<Snapshot> {
    const r = takeRawReading(this.clock);
    const record = this.runs.get(runId);
    if (record === undefined) {
      throw new WorkflowError(`Run '${runId}' not found`, {
        code: 'STATE_RUN_NOT_FOUND',
        category: 'STATE',
        agentAction: 'report_to_user',
        retryable: false,
      });
    }
    return writtenSnapshot(record, floorAtRecord(r, record));
  }

  async update(record: RunRecord): Promise<Snapshot> {
    const existing = this.runs.get(record.id);
    if (existing === undefined) {
      throw new WorkflowError(`Run '${record.id}' not found`, {
        code: 'STATE_RUN_NOT_FOUND',
        category: 'STATE',
        agentAction: 'report_to_user',
        retryable: false,
      });
    }
    // issue #715 (a) (M5): the update's ONE reading, after the run is found and BEFORE the version
    // check and the seal guard (a refused update has spent it); floored by the stored record.
    const at = takeReading(this.clock, existing);
    if (existing.version !== record.version) {
      throw new WorkflowError('Version conflict — run was modified by another process', {
        code: 'STATE_SNAPSHOT_MISMATCH',
        category: 'STATE',
        agentAction: 'report_to_user',
        retryable: true,
        details: { runId: record.id, expected: record.version, actual: existing.version },
      });
    }
    // issue #367: the seal-integrity boundary — identical to JsonFileStore's update tail (the
    // measured update/settle asymmetry closed; the listen/run-attach suites drive THIS store).
    assertSealIntegrity(existing, record);
    const updated: RunRecord = {
      ...record,
      run_phase: deriveRunPhase(record),
      version: record.version + 1,
      updated_at: at.toISOString(),
    };
    this.runs.set(updated.id, updated);
    return writtenSnapshot(updated, at);
  }

  /** issue #715 (a) (M4): the newest PARSEABLE `created_at` among this store's runs under the key. */
  private newestCreatedAtForKey(workflowId: string, key: string): string | undefined {
    let newest: { ms: number; stamp: string } | undefined;
    for (const run of this.runs.values()) {
      if (run.workflow_id !== workflowId || run.idempotency_key !== key) continue;
      const ms = parseStamp(run.created_at);
      if (ms === undefined) continue;
      if (newest === undefined || ms > newest.ms) newest = { ms, stamp: run.created_at };
    }
    return newest?.stamp;
  }

  async claimStep(
    runId: string,
    stepName: string,
    definition: WorkflowDefinition,
    claimant?: Attributed,
  ): Promise<Snapshot> {
    // issue #188: read the record SYNCHRONOUSLY (a direct Map.get, not `await this.get(...)`) so
    // the read → eligibility-check → write below is one indivisible synchronous stretch. This is
    // what makes claimStep single-owner for concurrent same-process calls (the cross-cutting
    // obligation on RunStore.claimStep; the TCK's concurrent-claimStep case exercises exactly
    // this against this store). `await this.get(runId)` would NOT be safe here even though the
    // lookup itself has no I/O: unwrapping an already-resolved promise still costs one microtask
    // tick, during which a second `Promise.all`'d claimStep call's own (equally synchronous) read
    // can run BEFORE either call has written — verified empirically: two concurrent claimStep
    // calls for the same (runId, step) both resolved successfully before this fix.
    // issue #207: `isStepSettledOrInFlight` (below) is pure/synchronous by design — it performs no
    // I/O and awaits nothing, so calling it here does not reintroduce the microtask-yield point
    // this fix removes; the no-await constraint above still holds.
    const run = this.runs.get(runId);
    if (run === undefined) {
      throw new WorkflowError(`Run '${runId}' not found`, {
        code: 'STATE_RUN_NOT_FOUND',
        category: 'STATE',
        agentAction: 'report_to_user',
        retryable: false,
      });
    }
    // issue #715 (a) (M6): the claim's ONE reading, after the run is found and BEFORE both guards;
    // `takeReading` is synchronous, so the single-owner stretch above stays unbroken.
    const at = takeReading(this.clock, run);
    if (isStepSettledOrInFlight(run, stepName)) {
      throw new WorkflowError(`Step '${stepName}' is already claimed or done`, {
        code: 'STATE_STEP_ALREADY_CLAIMED',
        category: 'STATE',
        agentAction: 'resolve_precondition',
        retryable: false,
      });
    }
    const eligible = findEligibleSteps(definition, run);
    if (!eligible.includes(stepName)) {
      throw new WorkflowError(`Step '${stepName}' is not eligible`, {
        code: 'STATE_STEP_NOT_ELIGIBLE',
        category: 'STATE',
        agentAction: 'resolve_precondition',
        retryable: false,
      });
    }
    // Per-claim liveness clock (issue #101) — mirrors JsonFileStore.claimStep: stamp claims[S]
    // atomically with the in_progress add (OVERWRITE, so a missed settle-site delete self-heals).
    const deadline = computeClaimDeadline(definition, stepName, at);
    // issue #279 (increment 1, PR-A): mint an acquirer-minted fencing token alongside the
    // deadline, in the SAME synchronous stretch — dormant until PR-B's settleStep migration.
    const token = crypto.randomUUID();
    // issue #279 (increment 2, PR-C — D-3 leg vii): derive instead of hardcoding 'running' —
    // parity with JsonFileStore.claimStep, which derives off the PRE-claim `run` (claiming a step
    // touches none of deriveRunPhase's own inputs, so `deriveRunPhase(run)` and
    // `deriveRunPhase(updated)` are always identical; derived off `run` for consistency with that
    // precedent, not because it matters here).
    const updated: RunRecord = {
      ...run,
      in_progress_steps: [...run.in_progress_steps, stepName],
      claims: {
        ...run.claims,
        // issue #625 (holder slice): `since` on every claim (the store's own act); `holder` when
        // the caller passed one.
        [stepName]: {
          deadline,
          token,
          since: at.toISOString(),
          ...(claimant !== undefined ? { holder: claimant } : {}),
        },
      },
      run_phase: deriveRunPhase(run),
      version: run.version + 1,
      updated_at: at.toISOString(),
    };
    this.runs.set(updated.id, updated);
    return writtenSnapshot(updated, at);
  }

  /**
   * Atomically applies one `SettlementDelta` to this run's fresh state (issue #279) — see
   * `RunStore.settleStep`'s own JSDoc for the full contract. #715 (b) (D-19): ONE reading
   * `takeReading(clock, fresh, delta)` handed to the transform, which mints every instant from it
   * (`updated_at` included); returned as `at`, applied or refused. A `seal_run` refused `moved` is
   * THROWN as `STATE_SNAPSHOT_MISMATCH` (D6-65). A `seal_run` takes no definition (Amendment 1).
   *
   * NO `await` between the read (`this.runs.get`) and the write (`this.runs.set`) — mirrors
   * `claimStep`'s own documented no-await stretch above (issue #188's single-owner discipline):
   * `applySettlement` is itself pure/synchronous, so calling it here does not introduce a
   * microtask-yield point between the fresh read and the committing write. A behavioral overlap
   * test (this package's own conformance suite) pins this directly: two disjoint concurrent
   * settles via `Promise.all` both land, proving no interleaving window exists.
   */
  async settleStep(
    runId: string,
    delta: SettlementDelta,
    definition?: WorkflowDefinition,
  ): Promise<StoreSettlement> {
    const fresh = this.runs.get(runId);
    if (fresh === undefined) {
      throw new WorkflowError(`Run '${runId}' not found`, {
        code: 'STATE_RUN_NOT_FOUND',
        category: 'STATE',
        agentAction: 'report_to_user',
        retryable: false,
      });
    }
    // issue #625: a store's own `settleStep` settles, in this SAME write, every guard the delta
    // makes eligible (the published law GUARD_CASCADE_ONE_WRITE).
    const at = takeReading(this.clock, fresh, delta);
    const outcome = applySettlement(fresh, delta, definition, {
      at,
      cascadeGuards: true,
      // issue #625 (holder slice): the transform mints the proof verdict's `store_keeps_no_claims`
      // cause itself, from this one input.
      storeKeepsClaims: this.persistsClaims === true,
    });
    if (!outcome.applied) {
      if (outcome.reason === 'moved') {
        throw new WorkflowError('Version conflict — run was modified by another process', {
          code: 'STATE_SNAPSHOT_MISMATCH',
          category: 'STATE',
          agentAction: 'report_to_user',
          retryable: true,
          details: { runId, expected: outcome.expected, actual: outcome.stored },
        });
      }
      return { ...outcome, at }; // refusal/noop — fresh state, NO write (version unchanged)
    }
    // issue #367: the boundary on the settle tail too (both stores, both tails).
    // `assertSealIntegrity` is pure and synchronous — the documented no-await stretch above holds.
    assertSealIntegrity(fresh, outcome.run);
    const updated: RunRecord = {
      ...outcome.run,
      run_phase: deriveRunPhase(outcome.run),
      version: fresh.version + 1,
    };
    this.runs.set(updated.id, updated);
    return { ...outcome, run: updated, at };
  }

  /**
   * Issue #367 (part 3): the stamp verb — see `RunStore.stampSeal` for the contract. Same shape as
   * JsonFileStore's, including the one thing that makes this verb exist: `updated_at` is carried
   * through byte-for-byte, because stamping is not activity.
   */
  async stampSeal(
    runId: string,
    sealedBy: SealedBy,
    expectedVersion: number,
  ): Promise<StampSealResult> {
    const fresh = this.runs.get(runId);
    if (fresh === undefined) {
      throw new WorkflowError(`Run '${runId}' not found`, {
        code: 'STATE_RUN_NOT_FOUND',
        category: 'STATE',
        agentAction: 'report_to_user',
        retryable: false,
      });
    }
    if (fresh.version !== expectedVersion) {
      throw new WorkflowError('Version conflict — run was modified by another process', {
        code: 'STATE_SNAPSHOT_MISMATCH',
        category: 'STATE',
        agentAction: 'report_to_user',
        retryable: true,
        details: { runId, expected: expectedVersion, actual: fresh.version },
      });
    }
    if (fresh.sealed_by !== undefined) {
      return { stamped: false, reason: 'already_stamped', run: fresh };
    }
    if (fresh.terminal_state !== true) {
      return { stamped: false, reason: 'not_terminal', run: fresh };
    }
    const stamped: RunRecord = { ...fresh, sealed_by: sealedBy };
    assertSealIntegrity(fresh, stamped);
    const written: RunRecord = {
      ...stamped,
      run_phase: deriveRunPhase(stamped),
      version: fresh.version + 1,
      updated_at: fresh.updated_at, // DELIBERATELY unchanged.
    };
    this.runs.set(runId, written);
    return { stamped: true, run: written };
  }

  /**
   * #715 (b) (D-15, D-16): ONE raw reading `read_at` before the read; each snapshot's `at` is
   * `read_at` floored by its own record. `consistent_snapshot: true` — one synchronous pass, one cut.
   */
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

brandClass(InMemoryStore, Symbol.for('@sensigo/realm-testing/InMemoryStore'), REALM_TESTING_BRAND);
