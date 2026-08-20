// settlement-contract.ts — framework-agnostic Test Compatibility Kit (TCK) for RunStore.settleStep
// (issue #279). Normative spec: plans/issue-279/design-d4-increment1.md (increment 1) +
// plans/issue-279/design-d5-increment2.md §8 (increment 2, PR-C — this file's own gate/guard/
// release law additions). This file implements the PR-C-runnable law subset (increment 1's own
// laws, plus increment 2's gate/guard/release laws + PHASE_IS_GENERATED); the PR-D-only laws
// (RESUME_CLEARS_SETTLED / DRAIN_REREADS_LEDGER, needing `applyResume`/the drain verb) are
// deliberately NOT here.
//
// Pure case descriptors, NOT describe/it/expect — mirrors run-store-fidelity-contract.ts's and
// fenced-trace-buffer-contract.ts's own precedent (importing vitest here would make it a runtime
// dependency of this published package). Each calling test file supplies an adapter and wires the
// returned descriptors into ITS OWN test framework.
//
// Wiring note (divergence from the issue #183/#188 precedent, deliberate): the #183/#188 pattern
// keeps a JsonFileStore conformance test in @sensigo/realm-cli (cli depends on both core and
// testing; a testing→cli dependency would be circular). That constraint does NOT apply here:
// JsonFileStore is exported directly from @sensigo/realm's own index (core), and
// @sensigo/realm-testing already depends on @sensigo/realm — so BOTH stores' settlement
// conformance can live in NEW test files right here in packages/testing/src/store/, with no
// circular-package hazard. See this module's own calling test files for the actual wiring.
import {
  applySettlement,
  deriveRunPhase,
  type RunStore,
  type RunRecord,
  type WorkflowDefinition,
  type StepDefinition,
  type SettlementDelta,
  type SettlementResult,
  type EvidenceSnapshot,
  type PendingGate,
} from '@sensigo/realm';

/** One of the PR-A-runnable settlement laws (design record §8, narrowed to the PR-A subset named
 *  in the hand-off prompt's D4 section — see this module's own header). */
export type SettlementLaw =
  | 'FRESH_APPLICATION' // L1
  | 'CONDITIONAL_NOOP' // L2
  | 'CONDITIONAL_NOOP_GRANDFATHERED'
  | 'OWNERSHIP_REFUSAL' // L3
  | 'LEDGER_MINT_ATOMICITY' // L4
  | 'DRAIN_MARK_DEDUP' // L5
  | 'TERMINAL_REFUSAL' // L6
  | 'TERMINAL_STATE_ONLY' // PR-A correction (architect novel probe): pins isTerminal's adjudication
  | 'CS_PURITY' // L7
  | 'NEVER_DOWNGRADE' // L8
  | 'SETTLE_OUTCOME_INTEGRITY' // L9
  | 'SETTLED_ORPHAN_OVERWRITE' // L10
  | 'TRANSFORM_FIDELITY' // L11
  | 'RESULT_AS_APPLIED'
  | 'MARK_MEMBERSHIP' // L12
  | 'REFUSAL_SWEEP' // L13
  | 'MINT_FRESH' // L14 (PR-A form)
  | 'SELF_IMAGE_IDEMPOTENCE' // L21
  | 'TERMINAL_GATE_EXCLUSION'
  | 'COMPLETE_SEAL_PHASE'
  | 'WHEN_ROUTED_TERMINALIZATION'
  | 'G1_GATE_COEXISTENCE'
  // issue #279, increment 2 (PR-C — design record design-d5-increment2.md §8): gate/guard/release
  // laws.
  | 'GATE_OPEN_IDEMPOTENT'
  | 'GATE_RESOLUTION_CONFLICT'
  | 'GATE_MISMATCH'
  | 'GUARD_OUTCOME_DIVERGENCE'
  | 'GUARD_WAITS_ON_OPEN_GATE'
  | 'GUARD_PASS_COMPLETE_OUTCOME'
  | 'GUARD_ABORT_CASCADE'
  | 'GUARD_NO_ENTRY'
  | 'RELEASE_IDEMPOTENT'
  /** A NEW universal TCK law (lane-C steal 1 — the PG "generated columns cannot be written to
   *  directly" invariant, quantified): after EVERY store mutation op, persisted `run_phase ≡
   *  deriveRunPhase(record)`. */
  | 'PHASE_IS_GENERATED'
  // issue #302 (finalizer outcome×trigger matrix) — the completed_with_failed_steps trigger laws.
  /** Mixed-complete (a `complete` seal with `failed_steps ≠ ∅`) mints the declared
   *  `completed_with_failed_steps` finalizer, discriminated per-arm — VIA `settle_step`, VIA
   *  `settle_gate` resolution, and VIA `settle_guard` pass all independently reach `mintFresh`'s
   *  one chokepoint (design record S3). */
  | 'CWFS_FIRES_PER_ARM'
  /** The new trigger never over-fires: a CLEAN complete (no `failed_steps`) does not select it;
   *  a PURE fail seal (never reaches `complete`) does not select it either. */
  | 'CWFS_NEGATIVES'
  /** issue #367 — a fresh seal (non-terminal → terminal write) that names no arm is REFUSED
   *  (`STATE_SEAL_UNSTAMPED`). Transition-scoped: re-writing an already-terminal legacy record
   *  passes untouched, which is what keeps the pre-#367 population usable. */
  | 'SEAL_FRESH_WRITE_REFUSED'
  /** issue #367 — a terminal → live write that RETAINS the seal is REFUSED
   *  (`STATE_SEAL_ORPHANED`): every resume/strip path must drop the fact in the same write. */
  | 'SEAL_ORPHAN_REFUSED'
  /** issue #367 — a terminal rewrite that DROPS a stored seal is REFUSED (`STATE_SEAL_ERASED`),
   *  so a field-enumerating rewriter cannot silently drain the stamped population back to prose. */
  | 'SEAL_ERASE_REFUSED'
  /** issue #367 — an arm outside `SEAL_ARMS` never persists (`STATE_SEAL_UNKNOWN_ARM`). */
  | 'SEAL_UNKNOWN_ARM_REFUSED'
  /** issue #367 part 3 — `stampSeal` leaves `updated_at` byte-identical. Stamping is not
   *  activity, and the retention clock must not move because a migration ran. */
  | 'STAMP_PRESERVES_UPDATED_AT'
  /** issue #367 part 3 — `stampSeal` bumps `version` exactly once, so a writer holding a
   *  pre-stamp snapshot loses its CAS instead of silently erasing the stamp. */
  | 'STAMP_BUMPS_VERSION_ONCE'
  /** issue #367 part 3 — a stale `expectedVersion` THROWS `STATE_SNAPSHOT_MISMATCH`. */
  | 'STAMP_REFUSES_ON_VERSION_MOVE'
  /** issue #367 part 3 — predicate refusals RETURN. A throw-shaped implementation fails. */
  | 'STAMP_RETURNS_NOT_THROWS_PREDICATES'
  /** issue #367 part 3 — re-stamping is byte-identical: no second write, no clock move. */
  | 'STAMP_IDEMPOTENT'
  /** issue #367 part 3 — a `classified: true` stamp survives write → read byte-for-byte, so a
   *  classifier-minted stamp stays distinguishable from a writer-asserted one forever. */
  | 'STAMP_CLASSIFIED_ROUNDTRIP'
  /** issue #367 part 3 — a stored arm may not be CHANGED while the run stays terminal. */
  | 'SEAL_REWRITE_REFUSED'
  /** Uniform-predicate pin (design record M1): a second-epoch complete seal whose ONLY
   *  `failed_steps` scar is a PRIOR epoch's finalizer self-failure (unresumable, so it never
   *  leaves `failed_steps`) still fires — no exclusion of finalizer-declared step names. */
  | 'CWFS_SECOND_EPOCH'
  /** A finalizer never fires twice for one seal: the array form
   *  (`on_outcome: [complete, completed_with_failed_steps]`) fires EXACTLY once on mixed-complete
   *  (Group A, single push despite a multi-element intersection); `always` fires EXACTLY once on
   *  mixed-complete too (Group B, once — never double-counted alongside a Group A hit). */
  | 'CWFS_ARRAY_ONCE'
  /** The REJECTED design alternative (D-C: auto-firing `fail` on mixed-complete) never happens,
   *  pinned both ways: clean-complete × a `fail`-only finalizer ⇒ not selected (unsurprising);
   *  mixed-complete × a `fail`-only finalizer ⇒ ALSO not selected (`fail`-only genuinely requires
   *  a `fail` seal — a `complete` seal carrying `failed_steps` is not a backdoor into it). */
  | 'CURRENT_BEHAVIOR_PINNED'
  // issue #291 (gate-timeout-291-correction, Leg 2 — ported from the dedicated core-only
  // gate-expiry-tck-laws.test.ts, per the PR-C precedent that new delta kinds' laws join this
  // shared, cross-store conformance kit): the `expire_gate` delta's own arm matrix + its two
  // dispositions' postconditions.
  /** The full `applyExpireGate` arm matrix: not_expired (arm-verified, never the caller-implied
   *  clock), replay ×2 idempotence (both dispositions), a DIFFERENT terminal cause refuses
   *  run_terminal (never resurrecting/re-terminalizing), an unknown/superseded gateId refuses
   *  gate_mismatch, finding-only (expires_at present, on_expiry absent) refuses no_disposition
   *  arm-level before APPLY. */
  | 'EXPIRE_ARM_MATRIX'
  /** The abort disposition's full postcondition shape: pending_gate + claim cleared, aborted_at +
   *  skip_details `{kind:'gate_expired', gate_id}` (day-one) + finalizers minted in ONE write;
   *  the D-4 discriminator (never mistaken for `gate_cancelled_by_abort`); never stamps
   *  `defaulted_steps` on the abort edge (the FM-5/#232 guard). */
  | 'EXPIRE_ABORT_CASCADE'
  /** The settle_default disposition's full postcondition shape: `resolved_by:'timeout'`
   *  attribution + both isComplete legs (terminalizing/non-terminalizing); FROZEN-BEATS-
   *  DEFINITION (enactment reads the RECORD-frozen `default_choice`, never a re-registered
   *  definition's drifted value); the evidence `gate_response` snapshot's `responded_by`/
   *  `resolution` fields. */
  | 'EXPIRE_DEFAULT_RESOLVE'
  /** Not a real settlement law — a wiring-gap sentinel (see `settlementContract`'s own doc: a
   *  store declaring `settleStep` with no `settlementFixture` supplied gets ONE failing case
   *  tagged with this, never a silent zero-cases pass). */
  | 'ADAPTER_WIRING';

/**
 * A single, framework-agnostic contract case. `run()` throws (rejects) on failure — any test
 * framework's `await run()` (rejecting fails the test) or `expect(run()).resolves...` maps
 * directly onto this.
 */
export interface SettlementContractCase {
  law: SettlementLaw;
  name: string;
  run: () => Promise<void>;
}

/**
 * Definition-building hook a calling test file supplies so the store-exercising cases below never
 * hand-roll their own `WorkflowDefinition`s inline — a concrete, named type (not a structural
 * `Pick<>`/intersection), mirroring `runStoreFidelityContract`'s own adapter-supplied
 * `definition`/`stepName` precedent, generalized to a factory since this TCK needs many distinct
 * shapes (fan-out pairs, finalizer-bearing definitions, ranked finalizer pairs).
 */
export interface SettlementFixture {
  /** A definition with the named agent steps, all immediately eligible (no `depends_on`). */
  minimalDefinition(stepNames: string[]): WorkflowDefinition;
  /** Adds one finalizer step (`execution: 'finalizer'`) to a definition built above. */
  withFinalizer(
    def: WorkflowDefinition,
    finalizerName: string,
    onOutcome: NonNullable<StepDefinition['on_outcome']>,
  ): WorkflowDefinition;
  /**
   * Adds one guard step (issue #279, increment 2, PR-C — design record §8 fixture mechanics).
   * OPTIONAL on this published interface (never a required-member widening): a store's own
   * `SettlementFixture` that omits this triggers the `ADAPTER_WIRING`-style failing-case idiom
   * for guard cases specifically, rather than a silent skip (see `guardOutcomeDivergenceCases`
   * and friends, below). `opts.dependents` (optional) names steps that get `depends_on:
   * [guardName]` — needed by `GUARD_ABORT_CASCADE`'s propagateSkips-cascade case.
   */
  withGuard?(
    def: WorkflowDefinition,
    guardName: string,
    abortUnless: string | string[],
    opts?: { dependents?: string[] },
  ): WorkflowDefinition;
}

/** Adapter a calling test file supplies to parameterize the contract against one concrete store. */
export interface SettlementContractAdapter {
  /** The store under test. A store that does not declare `settleStep` gets zero cases (vacuous
   *  pass — mirrors the established optional-capability idiom, e.g.
   *  `runStoreFidelityContract`'s zero-cases-on-no-declaration). */
  store: RunStore;
  /** Descriptive label for case names (e.g. `'JsonFileStore'`, `'InMemoryStore'`). */
  storeName: string;
  /**
   * Required for a store that DOES declare `settleStep` — the contract's own store-exercising
   * cases are built from this. Omitting it (while the store declares `settleStep`) is a WIRING
   * GAP, not a vacuous pass: `settlementContract` returns one explicit `ADAPTER_WIRING` failing
   * case rather than silently skipping real conformance coverage. Both calling test files in this
   * package pass `defaultSettlementFixture` (exported below) — a store needing bespoke definition
   * shapes may supply its own.
   */
  settlementFixture?: SettlementFixture;
  /**
   * Issue #367 (part 3): raw-seed an UNSTAMPED terminal record and return it — the shape the
   * migration vehicle actually meets, and one the store's own boundary would refuse if written
   * through it. Each store supplies its sanctioned channel (a direct file write, a direct map
   * insert). The ADAPTER_WIRING idiom applies: a `stampSeal`-declaring store that omits this gets
   * a failing wiring case rather than a silent pass, because the stamp laws' SUCCESS legs are
   * unobservable without it — and a store that never writes at all would otherwise conform.
   */
  seedLegacyTerminal?: (id: string) => Promise<RunRecord>;
}

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

let seq = 0;
/** A unique-per-call identifier — used for workflowId strings, which need only be locally unique
 *  (RunStore never validates them against a registry). */
function uid(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}-${Math.random().toString(36).slice(2, 8)}`;
}

/** A minimal workflow definition with the named agent steps, all immediately eligible (no deps). */
function minimalDefinition(stepNames: string[]): WorkflowDefinition {
  const steps: Record<string, StepDefinition> = {};
  for (const name of stepNames) {
    steps[name] = { description: name, execution: 'agent', depends_on: [] };
  }
  return { id: uid('settlement-wf'), name: 'Settlement TCK fixture', version: 1, steps };
}

/** Adds one finalizer step to a definition. */
function withFinalizer(
  def: WorkflowDefinition,
  finalizerName: string,
  onOutcome: NonNullable<StepDefinition['on_outcome']>,
): WorkflowDefinition {
  return {
    ...def,
    steps: {
      ...def.steps,
      [finalizerName]: {
        description: finalizerName,
        execution: 'finalizer',
        on_outcome: onOutcome,
      },
    },
  };
}

/** Adds one guard step (+ optional dependents) to a definition. */
function withGuard(
  def: WorkflowDefinition,
  guardName: string,
  abortUnless: string | string[],
  opts?: { dependents?: string[] },
): WorkflowDefinition {
  const dependentSteps: Record<string, StepDefinition> = {};
  for (const dep of opts?.dependents ?? []) {
    dependentSteps[dep] = { description: dep, execution: 'agent', depends_on: [guardName] };
  }
  return {
    ...def,
    steps: {
      ...def.steps,
      [guardName]: { description: guardName, execution: 'guard', abort_unless: abortUnless },
      ...dependentSteps,
    },
  };
}

/** Default settlement fixture — builds minimal agent-step / finalizer-step / guard-step
 *  definitions with no store-specific requirements beyond `RunStore.create` never validating
 *  `workflowId` against an external registry. Suitable for JsonFileStore and InMemoryStore; both
 *  this package's own conformance test files wire this in directly. */
export const defaultSettlementFixture: SettlementFixture = {
  minimalDefinition,
  withFinalizer,
  withGuard,
};

/**
 * Contract-INTERNAL helper (design record §8 fixture mechanics) — deliberately NOT a
 * `SettlementFixture` member: gate state lives on the RUN RECORD side (`pending_gate`), not the
 * step definition — the transform never reads step-def gate config at all, so there is nothing
 * store-specific to inject here.
 */
function makePendingGate(
  stepName: string,
  opts?: {
    gateId?: string;
    choices?: string[];
    /** issue #291 (gate-timeout-291-correction, Leg 2): the mint-frozen enforce/notify fields —
     *  additive-optional, existing callers (GATE_OPEN_IDEMPOTENT/GATE_RESOLUTION_CONFLICT/
     *  GATE_MISMATCH/guard cases) are unaffected. */
    expiresAt?: string;
    onExpiry?: 'settle_default' | 'abort';
    defaultChoice?: string;
  },
): PendingGate {
  return {
    gate_id: opts?.gateId ?? uid('tck-gate'),
    step_name: stepName,
    preview: {},
    choices: opts?.choices ?? ['approve', 'reject'],
    opened_at: '2026-01-01T00:00:00.000Z',
    ...(opts?.expiresAt !== undefined ? { expires_at: opts.expiresAt } : {}),
    ...(opts?.onExpiry !== undefined ? { on_expiry: opts.onExpiry } : {}),
    ...(opts?.defaultChoice !== undefined ? { default_choice: opts.defaultChoice } : {}),
  };
}

function makeEvidence(stepId: string, overrides: Partial<EvidenceSnapshot> = {}): EvidenceSnapshot {
  return {
    step_id: stepId,
    started_at: '2026-01-01T00:00:00.000Z',
    completed_at: '2026-01-01T00:00:01.000Z',
    duration_ms: 1,
    input_summary: {},
    output_summary: {},
    status: 'success',
    evidence_hash: 'tck-evidence',
    ...overrides,
  };
}

/** Creates a fresh run and claims `stepName` — returns the claimed run plus the REAL,
 *  store-minted fencing token (never hand-constructed — the law-3 mint-forcing rule). */
async function createClaimed(
  store: RunStore,
  def: WorkflowDefinition,
  stepName: string,
): Promise<{ run: RunRecord; token: string }> {
  const { run } = await store.create({
    workflowId: def.id,
    workflowVersion: def.version,
    params: {},
  });
  const claimed = await store.claimStep(run.id, stepName, def);
  const token = claimed.claims?.[stepName]?.token;
  if (token === undefined) {
    throw new Error(`fixture setup failed: claimStep did not mint a token for step '${stepName}'`);
  }
  return { run: claimed, token };
}

function requireSettleStep(store: RunStore): NonNullable<RunStore['settleStep']> {
  if (store.settleStep === undefined) {
    throw new Error('settlementContract requires an adapter.store that declares settleStep');
  }
  return store.settleStep.bind(store);
}

function assertApplied(
  result: SettlementResult,
  context: string,
): asserts result is Extract<SettlementResult, { applied: true }> {
  if (!result.applied) {
    throw new Error(`${context}: expected applied:true, got refusal reason '${result.reason}'`);
  }
}

type SettlementRefusalReasonType = Extract<SettlementResult, { applied: false }>['reason'];

function assertRefused(
  result: SettlementResult,
  expectedReason: SettlementRefusalReasonType,
  context: string,
): asserts result is Extract<SettlementResult, { applied: false }> {
  if (result.applied) {
    throw new Error(
      `${context}: expected a refusal (reason '${expectedReason}'), got applied:true`,
    );
  }
  if (result.reason !== expectedReason) {
    throw new Error(`${context}: expected reason '${expectedReason}', got '${result.reason}'`);
  }
}

// ---------------------------------------------------------------------------
// L1 FRESH_APPLICATION
// ---------------------------------------------------------------------------

function freshApplicationCases(adapter: SettlementContractAdapter): SettlementContractCase[] {
  const { minimalDefinition } = adapter.settlementFixture!;
  const settleStep = requireSettleStep(adapter.store);
  return [
    {
      law: 'FRESH_APPLICATION',
      name: `[${adapter.storeName}] routine same-run fan-out (2 disjoint steps settling concurrently) produces ZERO refusals — disjoint deltas compose in-CS`,
      run: async () => {
        const def = minimalDefinition(['a', 'b']);
        const { run } = await adapter.store.create({
          workflowId: def.id,
          workflowVersion: 1,
          params: {},
        });
        const claimedA = await adapter.store.claimStep(run.id, 'a', def);
        const tokenA = claimedA.claims!['a']!.token!;
        const claimedB = await adapter.store.claimStep(run.id, 'b', def);
        const tokenB = claimedB.claims!['b']!.token!;

        const [resultA, resultB] = await Promise.all([
          settleStep(
            run.id,
            {
              kind: 'settle_step',
              step: 'a',
              outcome: 'complete',
              claimToken: tokenA,
              evidence: [makeEvidence('a')],
            },
            def,
          ),
          settleStep(
            run.id,
            {
              kind: 'settle_step',
              step: 'b',
              outcome: 'complete',
              claimToken: tokenB,
              evidence: [makeEvidence('b')],
            },
            def,
          ),
        ]);
        assertApplied(resultA, 'fan-out settle of step a');
        assertApplied(resultB, 'fan-out settle of step b');

        const final = await adapter.store.get(run.id);
        if (!final.completed_steps.includes('a') || !final.completed_steps.includes('b')) {
          throw new Error(
            `expected both 'a' and 'b' in completed_steps after concurrent settle, got: ${JSON.stringify(final.completed_steps)}`,
          );
        }
        if (final.terminal_state !== true) {
          throw new Error('expected the run to terminalize once both disjoint steps settled');
        }
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// L2 CONDITIONAL_NOOP (+ abort variant) + CONDITIONAL_NOOP_GRANDFATHERED
// ---------------------------------------------------------------------------

function conditionalNoopCases(adapter: SettlementContractAdapter): SettlementContractCase[] {
  const { minimalDefinition } = adapter.settlementFixture!;
  const settleStep = requireSettleStep(adapter.store);
  return [
    {
      law: 'CONDITIONAL_NOOP',
      name: `[${adapter.storeName}] a same-token, same-outcome (complete) retry NOOPs as already_settled — version unchanged`,
      run: async () => {
        const def = minimalDefinition(['a', 'b']);
        const { run, token } = await createClaimed(adapter.store, def, 'a');
        const delta: SettlementDelta = {
          kind: 'settle_step',
          step: 'a',
          outcome: 'complete',
          claimToken: token,
          evidence: [makeEvidence('a')],
        };
        const first = await settleStep(run.id, delta, def);
        assertApplied(first, 'first settle of step a');
        const second = await settleStep(run.id, delta, def);
        assertRefused(
          second,
          'already_settled',
          'retry settle of step a (same token, same outcome)',
        );
        if (second.run.version !== first.run.version) {
          throw new Error(
            `expected version unchanged on a NOOP (${first.run.version}), got ${second.run.version}`,
          );
        }
      },
    },
    {
      law: 'CONDITIONAL_NOOP',
      name: `[${adapter.storeName}] a same-token, same-outcome (abort) retry NOOPs as already_settled — the mapped-space abort variant`,
      run: async () => {
        const def = minimalDefinition(['a', 'b']);
        const { run, token } = await createClaimed(adapter.store, def, 'a');
        const delta: SettlementDelta = {
          kind: 'settle_step',
          step: 'a',
          outcome: 'abort',
          claimToken: token,
          evidence: [makeEvidence('a')],
          abort: { stepId: 'a', abortMessage: 'tck-abort' },
        };
        const first = await settleStep(run.id, delta, def);
        assertApplied(first, 'first abort-settle of step a');
        const second = await settleStep(run.id, delta, def);
        assertRefused(
          second,
          'already_settled',
          'retry abort-settle of step a (same token, same outcome)',
        );
      },
    },
    {
      law: 'CONDITIONAL_NOOP_GRANDFATHERED',
      name: `[${adapter.storeName}] a grandfathered (token-less) claim settles with no claimToken presented, and absent≡absent NOOPs on retry`,
      run: async () => {
        const def = minimalDefinition(['a']);
        const { run } = await adapter.store.create({
          workflowId: def.id,
          workflowVersion: 1,
          params: {},
        });
        // Hand-seed a pre-#279-shaped claim (no token) — simulates a grandfathered claim record.
        // This is the ONE deliberate exception to "tokens MUST come from store-returned claim
        // records" (law-3's mint-forcing sentence) — the whole point of this fixture is to prove
        // the ABSENCE of a token is handled correctly, so it must be genuinely absent here.
        const seeded = await adapter.store.update({
          ...run,
          in_progress_steps: ['a'],
          claims: { a: { deadline: null } },
        });
        const delta: SettlementDelta = {
          kind: 'settle_step',
          step: 'a',
          outcome: 'complete',
          evidence: [makeEvidence('a')],
          // claimToken deliberately omitted
        };
        const first = await settleStep(seeded.id, delta, def);
        assertApplied(first, 'grandfathered (token-less) settle');
        const second = await settleStep(seeded.id, delta, def);
        assertRefused(second, 'already_settled', 'grandfathered retry (absent≡absent)');
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// L3 OWNERSHIP_REFUSAL
// ---------------------------------------------------------------------------

function ownershipRefusalCases(adapter: SettlementContractAdapter): SettlementContractCase[] {
  const { minimalDefinition } = adapter.settlementFixture!;
  const settleStep = requireSettleStep(adapter.store);
  return [
    {
      law: 'OWNERSHIP_REFUSAL',
      name: `[${adapter.storeName}] a settle_step with a WRONG claimToken refuses claim_lost — outcome NOT recorded`,
      run: async () => {
        const def = minimalDefinition(['a']);
        const { run } = await createClaimed(adapter.store, def, 'a');
        const result = await settleStep(
          run.id,
          {
            kind: 'settle_step',
            step: 'a',
            outcome: 'complete',
            claimToken: 'wrong-token',
            evidence: [],
          },
          def,
        );
        assertRefused(result, 'claim_lost', 'settle with a wrong token');
        if (result.run.completed_steps.includes('a')) {
          throw new Error('a claim_lost refusal must never record the outcome');
        }
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// L4 LEDGER_MINT_ATOMICITY (+ cross-backend caveat — documented, not testable in-repo beyond this)
// ---------------------------------------------------------------------------

function ledgerMintAtomicityCases(adapter: SettlementContractAdapter): SettlementContractCase[] {
  const { minimalDefinition, withFinalizer } = adapter.settlementFixture!;
  const settleStep = requireSettleStep(adapter.store);
  return [
    {
      law: 'LEDGER_MINT_ATOMICITY',
      name: `[${adapter.storeName}] a terminal edge mints the ledger in the SAME write as membership/terminal_state — never a torn intermediate state (single version bump)`,
      run: async () => {
        // CROSS-BACKEND CAVEAT (design record §8/L4): this in-repo store's atomicity comes from
        // ITS OWN single lock+read+write critical section (JsonFileStore) or its documented
        // no-await synchronous stretch (InMemoryStore) — verified structurally elsewhere in this
        // suite. A MULTI-STATEMENT backend (e.g. a future Postgres store) MUST prove its own
        // atomicity in ITS OWN conformance suite; a green run here does not and cannot verify
        // that (mirrors claimStep's own cross-host caveat). This case's own assertion is a
        // same-process proxy: exactly ONE version bump carries both the membership AND the ledger
        // mint — never two separate writes.
        const def = withFinalizer(minimalDefinition(['a']), 'fin', 'complete');
        const { run, token } = await createClaimed(adapter.store, def, 'a');
        const before = run.version;
        const result = await settleStep(
          run.id,
          {
            kind: 'settle_step',
            step: 'a',
            outcome: 'complete',
            claimToken: token,
            evidence: [makeEvidence('a')],
          },
          def,
        );
        assertApplied(result, 'terminal settle minting a finalizer');
        if (result.run.version !== before + 1) {
          throw new Error(
            `expected exactly one version bump (${before} -> ${before + 1}) carrying both membership and the mint, got version ${result.run.version}`,
          );
        }
        if (result.run.finalizer_ledger?.['fin']?.status !== 'pending') {
          throw new Error('expected the finalizer to be minted pending in the SAME write');
        }
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// L5 DRAIN_MARK_DEDUP
// ---------------------------------------------------------------------------

function drainMarkDedupCases(adapter: SettlementContractAdapter): SettlementContractCase[] {
  const { minimalDefinition, withFinalizer } = adapter.settlementFixture!;
  const settleStep = requireSettleStep(adapter.store);
  return [
    {
      law: 'DRAIN_MARK_DEDUP',
      name: `[${adapter.storeName}] a same-token, same-result mark_finalizer retry NOOPs as already_marked — completed_steps not double-appended`,
      run: async () => {
        const def = withFinalizer(minimalDefinition(['a']), 'fin', 'complete');
        const { run, token } = await createClaimed(adapter.store, def, 'a');
        const settled = await settleStep(
          run.id,
          {
            kind: 'settle_step',
            step: 'a',
            outcome: 'complete',
            claimToken: token,
            evidence: [makeEvidence('a')],
          },
          def,
        );
        assertApplied(settled, 'terminal settle minting the finalizer');
        const leaseToken = uid('lease');
        const leased = await settleStep(
          run.id,
          { kind: 'lease_finalizer', finalizer: 'fin', leaseToken, leaseSeconds: 60 },
          def,
        );
        assertApplied(leased, 'lease the pending finalizer');
        const markDelta: SettlementDelta = {
          kind: 'mark_finalizer',
          finalizer: 'fin',
          leaseToken,
          result: 'completed',
          evidence: makeEvidence('fin'),
        };
        const firstMark = await settleStep(run.id, markDelta, def);
        assertApplied(firstMark, 'first mark');
        const secondMark = await settleStep(run.id, markDelta, def);
        assertRefused(secondMark, 'already_marked', 'retry mark (same token, same result)');
        const occurrences = secondMark.run.completed_steps.filter((s) => s === 'fin').length;
        if (occurrences !== 1) {
          throw new Error(
            `expected 'fin' to appear exactly once in completed_steps, got ${occurrences}`,
          );
        }
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// L6 TERMINAL_REFUSAL
// ---------------------------------------------------------------------------

function terminalRefusalCases(adapter: SettlementContractAdapter): SettlementContractCase[] {
  const { minimalDefinition } = adapter.settlementFixture!;
  const settleStep = requireSettleStep(adapter.store);
  return [
    {
      law: 'TERMINAL_REFUSAL',
      name: `[${adapter.storeName}] settle_step on an ALREADY-terminal run (a different, never-settled step) refuses run_terminal`,
      run: async () => {
        const def = minimalDefinition(['a', 'b']);
        const { run } = await adapter.store.create({
          workflowId: def.id,
          workflowVersion: 1,
          params: {},
        });
        // Terminalize the run directly (no need to route through a real settle for this fixture).
        await adapter.store.update({
          ...run,
          terminal_state: true,
          // issue #367: a terminal record names its arm. These fixtures mean "this run is over";
          // their opaque `tck` prose is deliberately unclassifiable, so the boundary's coherence
          // check abstains and the fixture stays a pure terminal-precondition seeder.
          sealed_by: { arm: 'complete' as const },
          terminal_reason: 'tck-terminal',
        });
        const result = await settleStep(
          run.id,
          {
            kind: 'settle_step',
            step: 'b',
            outcome: 'complete',
            claimToken: 'irrelevant',
            evidence: [],
          },
          def,
        );
        assertRefused(result, 'run_terminal', 'settle on an already-terminal run');
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// TERMINAL_STATE_ONLY (PR-A correction, atomic-settle-279-pr-a-pin-correction.md) — pins
// `isTerminal := terminal_state === true` EXACTLY, refuting the earlier trio adjudication
// (`terminal_state === true || abandoned_at !== undefined || aborted_at !== undefined`), which
// the restart's bottom-up Finding 1 identified as the deterministic resumed-abandoned wedge.
// terminal_state-only is load-bearing TODAY: `resume` (packages/cli/src/commands/resume.ts:71)
// strips only `terminal_reason`, never `abandoned_at` — so `abandoned_at ∧ terminal_state:false`
// is a LIVE, in-contract record shape on main right now. Under the trio, every settle on such a
// run would refuse `run_terminal` forever.
//
// Reintroducing either trio disjunct into `isTerminal` reds this law; genuine terminal refusal is
// TERMINAL_REFUSAL's job (`terminal_state: true` — which abandon/abort ALWAYS set atomically,
// abandon-run.ts:66-71 / execution-loop.ts:1803-1811).
//
// REPINNED 2026-08-20 (issue #367) — ARM-WINS. Each case below now also asserts the DERIVED PHASE
// of its product record, and that phase CHANGED with #367: the run is settled `complete`, so it
// stamps `sealed_by: {arm: 'complete'}`, and the recorded arm outranks the seeded marker. Before
// #367 the same record derived `abandoned`/`aborted` from the marker alone.
//
// These two product records are the ONLY engine-constructible arm-vs-marker disagreements in the
// suite, which makes them the keystone: revert the sealed-wins branch in `deriveRunPhase` and the
// new assertions below are what reds. Nothing else observes that revert — the arm path and the
// legacy path agree on every honest record.
//
// The seeded foreign marker violates nothing: `SEAL_MARKERS_AGREE` is transform-scoped and
// ONE-DIRECTIONAL (an arm requires its own marker; it never forbids a marker it did not write).
// Do not "fix" these fixtures by removing the marker — the disagreement IS the test.
//
// (The law's own premise comment above — "resume never strips abandoned_at" — has been stale since
// #281; the honest production channel for this shape is a mixed-version fleet.)
// ---------------------------------------------------------------------------

function terminalStateOnlyCases(adapter: SettlementContractAdapter): SettlementContractCase[] {
  const { minimalDefinition } = adapter.settlementFixture!;
  const settleStep = requireSettleStep(adapter.store);
  return [
    {
      law: 'TERMINAL_STATE_ONLY',
      name: `[${adapter.storeName}] a resumed-abandoned shape (abandoned_at SET, terminal_state:false) — settle_step APPLIES, never run_terminal`,
      run: async () => {
        const def = minimalDefinition(['a']);
        const { run, token } = await createClaimed(adapter.store, def, 'a');
        // Hand-authored fixture via update() (mirrors MINT_FRESH's own pattern) — a LIVE,
        // in-contract shape today, not a hypothetical: resume never strips abandoned_at.
        const seeded = await adapter.store.update({
          ...run,
          abandoned_at: '2026-01-01T00:00:00.000Z',
        });
        const result = await settleStep(
          seeded.id,
          {
            kind: 'settle_step',
            step: 'a',
            outcome: 'complete',
            claimToken: token,
            evidence: [makeEvidence('a')],
          },
          def,
        );
        assertApplied(result, 'settle on a resumed-abandoned (terminal_state:false) run');
        if (!result.run.completed_steps.includes('a')) {
          throw new Error(
            `expected 'a' to land in completed_steps, got: ${JSON.stringify(result.run.completed_steps)}`,
          );
        }
        // issue #367 KEYSTONE: the run sealed `complete`, so the recorded arm decides — even
        // though `abandoned_at` is still on the record. Pre-#367 this derived 'abandoned'.
        const phase = deriveRunPhase(result.run);
        if (phase !== 'completed') {
          throw new Error(
            `arm-wins: expected derived phase 'completed' from sealed_by.arm '${String(
              result.run.sealed_by?.arm,
            )}' despite the seeded abandoned_at, got '${phase}'`,
          );
        }
      },
    },
    {
      law: 'TERMINAL_STATE_ONLY',
      name: `[${adapter.storeName}] an aborted-marker shape (aborted_at SET, terminal_state:false) — settle_step APPLIES, never run_terminal`,
      run: async () => {
        const def = minimalDefinition(['a']);
        const { run, token } = await createClaimed(adapter.store, def, 'a');
        // Fixture-legal via update() regardless of whether the real engine can currently reach
        // this exact combination — the law pins the PREDICATE itself, so it must make ANY trio
        // disjunct reintroduction red, not just the abandoned one.
        const seeded = await adapter.store.update({
          ...run,
          aborted_at: { step_id: 'a', abort_message: 'tck-aborted-marker' },
        });
        const result = await settleStep(
          seeded.id,
          {
            kind: 'settle_step',
            step: 'a',
            outcome: 'complete',
            claimToken: token,
            evidence: [makeEvidence('a')],
          },
          def,
        );
        assertApplied(result, 'settle on an aborted-marker (terminal_state:false) run');
        if (!result.run.completed_steps.includes('a')) {
          throw new Error(
            `expected 'a' to land in completed_steps, got: ${JSON.stringify(result.run.completed_steps)}`,
          );
        }
        // issue #367 KEYSTONE (the aborted half): same disagreement, other marker.
        const phase = deriveRunPhase(result.run);
        if (phase !== 'completed') {
          throw new Error(
            `arm-wins: expected derived phase 'completed' from sealed_by.arm '${String(
              result.run.sealed_by?.arm,
            )}' despite the seeded aborted_at, got '${phase}'`,
          );
        }
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// L7 CS-purity — structural: `options` carries VALUES only ({now}); no callback, no registry.
// In-repo source-text guard (the calling test file greps applySettlement's own signature).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// issue #367 — the seal-integrity boundary laws. An assertion-capable store (one declaring
// `settleStep`) must REFUSE each of the four violations rather than persisting them: a record that
// lies about how it ended is permanent, and an advisory would report success on a write that broke
// its own invariant.
// ---------------------------------------------------------------------------

function sealIntegrityCases(adapter: SettlementContractAdapter): SettlementContractCase[] {
  const { minimalDefinition } = adapter.settlementFixture!;
  requireSettleStep(adapter.store); // assertion-capable stores only

  /** Runs `write`, expecting it to reject with `code`. */
  async function expectRefusedWith(
    code: string,
    what: string,
    write: () => Promise<unknown>,
  ): Promise<void> {
    let threw: unknown;
    try {
      await write();
    } catch (err) {
      threw = err;
    }
    if (threw === undefined) {
      throw new Error(`expected ${what} to be REFUSED with ${code}, but the write succeeded`);
    }
    const actual = (threw as { code?: string }).code;
    if (actual !== code) {
      throw new Error(`expected ${what} to be refused with ${code}, got '${String(actual)}'`);
    }
  }

  async function freshRun(name: string): Promise<RunRecord> {
    const def = minimalDefinition(['a']);
    const { run } = await adapter.store.create({
      workflowId: `${def.id}-${name}`,
      workflowVersion: 1,
      params: {},
    });
    return run;
  }

  return [
    {
      law: 'SEAL_FRESH_WRITE_REFUSED',
      name: `[${adapter.storeName}] a live → terminal write carrying NO sealed_by is refused`,
      run: async () => {
        const run = await freshRun('unstamped');
        await expectRefusedWith('STATE_SEAL_UNSTAMPED', 'an unstamped fresh seal', () =>
          /* eslint-disable-next-line no-restricted-syntax --
           * issue #367 (part 2), AUTHORIZED: this violation is the LAW. SEAL_FRESH_WRITE_REFUSED
           * exists to prove the store refuses an unstamped fresh seal, so the fixture has to
           * construct one. (This file is a published contract source, not a `.test.ts`, which is
           * why the test-file scoping does not cover it.)
           */
          adapter.store.update({ ...run, terminal_state: true, terminal_reason: 'tck' }),
        );
      },
    },
    {
      law: 'SEAL_FRESH_WRITE_REFUSED',
      name: `[${adapter.storeName}] NEGATIVE CONTROL: re-writing an ALREADY-terminal unstamped record passes (the legacy population stays usable)`,
      run: async () => {
        const run = await freshRun('legacy-repersist');
        const sealed = await adapter.store.update({
          ...run,
          terminal_state: true,
          sealed_by: { arm: 'complete' },
          terminal_reason: 'tck',
        });
        // A terminal → terminal rewrite. The forward clause is transition-scoped, so this is fine.
        await adapter.store.update({ ...sealed, terminal_reason: 'tck (touched)' });
      },
    },
    {
      law: 'SEAL_ORPHAN_REFUSED',
      name: `[${adapter.storeName}] a terminal → live write that RETAINS sealed_by is refused`,
      run: async () => {
        const run = await freshRun('orphan');
        const sealed = await adapter.store.update({
          ...run,
          terminal_state: true,
          sealed_by: { arm: 'complete' },
          terminal_reason: 'tck',
        });
        await expectRefusedWith('STATE_SEAL_ORPHANED', 'a resume that kept the seal', () =>
          adapter.store.update({ ...sealed, terminal_state: false }),
        );
      },
    },
    {
      law: 'SEAL_ORPHAN_REFUSED',
      name: `[${adapter.storeName}] NEGATIVE CONTROL: the same transition WITH the seal stripped passes`,
      run: async () => {
        const run = await freshRun('orphan-control');
        const sealed = await adapter.store.update({
          ...run,
          terminal_state: true,
          sealed_by: { arm: 'complete' },
          terminal_reason: 'tck',
        });
        const { sealed_by: _dropped, ...base } = sealed;
        await adapter.store.update({ ...base, terminal_state: false });
      },
    },
    {
      law: 'SEAL_ERASE_REFUSED',
      name: `[${adapter.storeName}] a terminal rewrite that DROPS a stored sealed_by is refused`,
      run: async () => {
        const run = await freshRun('erase');
        const sealed = await adapter.store.update({
          ...run,
          terminal_state: true,
          sealed_by: { arm: 'complete' },
          terminal_reason: 'tck',
        });
        const { sealed_by: _erased, ...withoutSeal } = sealed;
        await expectRefusedWith('STATE_SEAL_ERASED', 'a terminal rewrite dropping the seal', () =>
          adapter.store.update({ ...withoutSeal, terminal_reason: 'tck (erased)' }),
        );
      },
    },
    {
      law: 'SEAL_ERASE_REFUSED',
      name: `[${adapter.storeName}] NEGATIVE CONTROL: the same rewrite KEEPING the seal passes`,
      run: async () => {
        const run = await freshRun('erase-control');
        const sealed = await adapter.store.update({
          ...run,
          terminal_state: true,
          sealed_by: { arm: 'complete' },
          terminal_reason: 'tck',
        });
        await adapter.store.update({ ...sealed, terminal_reason: 'tck (kept)' });
      },
    },
    {
      law: 'SEAL_REWRITE_REFUSED',
      name: `[${adapter.storeName}] a stored arm may NOT be changed while the run stays terminal`,
      run: async () => {
        const run = await freshRun('rewrite');
        const sealed = await adapter.store.update({
          ...run,
          terminal_state: true,
          sealed_by: { arm: 'complete' },
          terminal_reason: 'Workflow completed.',
        });
        await expectRefusedWith('STATE_SEAL_REWRITTEN', 'a seal-arm rewrite', () =>
          adapter.store.update({ ...sealed, sealed_by: { arm: 'guard_pass_complete' } }),
        );
      },
    },
    {
      law: 'SEAL_REWRITE_REFUSED',
      name: `[${adapter.storeName}] a rewrite WITH truthful adjudication provenance is ACCEPTED`,
      run: async () => {
        // The lawful key, published day-one so this law never has to be loosened later. The arm
        // pair is deliberately SAME-PHASE: a cross-phase ruling on a record whose prose still says
        // otherwise is refused by SEAL_COHERENT instead, which is a different law's job.
        const run = await freshRun('adjudicated');
        const sealed = await adapter.store.update({
          ...run,
          terminal_state: true,
          sealed_by: { arm: 'complete' },
          terminal_reason: 'Workflow completed.',
        });
        const ruled = await adapter.store.update({
          ...sealed,
          sealed_by: {
            arm: 'guard_pass_complete',
            adjudicated: { by: 'tck', at: '2026-01-01T00:00:00.000Z', previous_arm: 'complete' },
          },
        });
        if (ruled.sealed_by?.arm !== 'guard_pass_complete') {
          throw new Error(`the adjudicated arm did not land: ${JSON.stringify(ruled.sealed_by)}`);
        }
        const reread = await adapter.store.get(run.id);
        if (reread.sealed_by?.adjudicated?.previous_arm !== 'complete') {
          throw new Error(
            `the ruling's provenance did not survive the round trip: ` +
              `${JSON.stringify(reread.sealed_by)} — the chain must stay one-step walkable`,
          );
        }
      },
    },
    {
      law: 'SEAL_REWRITE_REFUSED',
      name: `[${adapter.storeName}] a rewrite whose adjudication LIES about previous_arm is refused`,
      run: async () => {
        const run = await freshRun('adjudicated-lying');
        const sealed = await adapter.store.update({
          ...run,
          terminal_state: true,
          sealed_by: { arm: 'complete' },
          terminal_reason: 'Workflow completed.',
        });
        await expectRefusedWith('STATE_SEAL_REWRITTEN', 'a lying adjudication', () =>
          adapter.store.update({
            ...sealed,
            sealed_by: {
              arm: 'guard_pass_complete',
              adjudicated: { by: 'tck', at: 'now', previous_arm: 'step_failure' },
            },
          }),
        );
      },
    },
    {
      law: 'SEAL_REWRITE_REFUSED',
      name: `[${adapter.storeName}] a SAME-arm write minting lying provenance is refused; a truthful acknowledgment is accepted`,
      run: async () => {
        const run = await freshRun('adjudicated-same');
        const sealed = await adapter.store.update({
          ...run,
          terminal_state: true,
          sealed_by: { arm: 'complete' },
          terminal_reason: 'Workflow completed.',
        });
        await expectRefusedWith('STATE_SEAL_REWRITTEN', 'a same-arm lying mint', () =>
          adapter.store.update({
            ...sealed,
            sealed_by: {
              arm: 'complete',
              adjudicated: { by: 'tck', at: 'now', previous_arm: 'guard_abort' },
            },
          }),
        );
        // The acknowledgment channel: "looked at it, it stands."
        await adapter.store.update({
          ...sealed,
          sealed_by: {
            arm: 'complete',
            adjudicated: { by: 'tck', at: 'now', previous_arm: 'complete' },
          },
        });
      },
    },
    {
      law: 'SEAL_REWRITE_REFUSED',
      name: `[${adapter.storeName}] a terminal rewrite dropping stored adjudication provenance is refused`,
      run: async () => {
        const run = await freshRun('adjudicated-erase');
        const sealed = await adapter.store.update({
          ...run,
          terminal_state: true,
          sealed_by: { arm: 'complete' },
          terminal_reason: 'Workflow completed.',
        });
        const ruled = await adapter.store.update({
          ...sealed,
          sealed_by: {
            arm: 'complete',
            adjudicated: { by: 'tck', at: 'now', previous_arm: 'complete' },
          },
        });
        await expectRefusedWith('STATE_SEAL_REWRITTEN', 'erasing a recorded ruling', () =>
          adapter.store.update({ ...ruled, sealed_by: { arm: 'complete' } }),
        );
      },
    },
    {
      law: 'SEAL_REWRITE_REFUSED',
      name: `[${adapter.storeName}] NEGATIVE CONTROL: a rewrite keeping the SAME arm passes`,
      run: async () => {
        const run = await freshRun('rewrite-control');
        const sealed = await adapter.store.update({
          ...run,
          terminal_state: true,
          sealed_by: { arm: 'complete' },
          terminal_reason: 'Workflow completed.',
        });
        // Every ordinary terminal rewrite spreads the record — without this passing, the clause
        // would wedge the engine.
        await adapter.store.update({ ...sealed, terminal_reason: 'Workflow completed. (touched)' });
      },
    },
    {
      law: 'SEAL_UNKNOWN_ARM_REFUSED',
      name: `[${adapter.storeName}] an arm outside SEAL_ARMS never persists`,
      run: async () => {
        const run = await freshRun('unknown-arm');
        await expectRefusedWith('STATE_SEAL_UNKNOWN_ARM', 'a foreign arm', () =>
          adapter.store.update({
            ...run,
            terminal_state: true,
            // Deliberately outside the closed set — the shape a record written by a FUTURE
            // binary would have. The cast is the point: the type system cannot stop a foreign arm
            // arriving from disk or from another version, which is why the boundary checks it.
            sealed_by: { arm: 'from_the_future' } as unknown as NonNullable<RunRecord['sealed_by']>,
            terminal_reason: 'tck',
          }),
        );
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// issue #367 part 3 — the `stampSeal` laws. A store that declares the verb is promising a very
// specific write: the seal arm lands, `version` moves so the CAS protocol can see it, and
// `updated_at` does NOT move because stamping is not activity. Get that split wrong in either
// direction and either the stamp is silently erasable or every migrated record looks freshly
// touched to retention.
// ---------------------------------------------------------------------------

function stampSealCases(adapter: SettlementContractAdapter): SettlementContractCase[] {
  const stampSeal = adapter.store.stampSeal;
  if (stampSeal === undefined) return []; // dormant store — the laws bind declarers only
  const stamp = stampSeal.bind(adapter.store);

  /**
   * A terminal, ALREADY-STAMPED record — the refusal legs' fixture. (An earlier version of this
   * comment claimed the seal was "then removed by a direct write"; no such removal existed, and
   * the boundary's ERASED clause would refuse one. Corrected rather than reworded.)
   */
  async function stampedTerminal(name: string): Promise<RunRecord> {
    const { run } = await adapter.store.create({
      workflowId: `tck-stamp-${name}`,
      workflowVersion: 1,
      params: {},
    });
    return adapter.store.update({
      ...run,
      completed_steps: ['a'],
      terminal_state: true,
      sealed_by: { arm: 'complete' },
      terminal_reason: 'Workflow completed.',
    });
  }

  return [
    {
      law: 'STAMP_PRESERVES_UPDATED_AT',
      name: `[${adapter.storeName}] stampSeal leaves updated_at byte-identical`,
      run: async () => {
        const sealed = await stampedTerminal('clock');
        // Already stamped, so this exercises the refusal path's clock too — the record must not be
        // touched at all.
        const before = await adapter.store.get(sealed.id);
        await stamp(sealed.id, { arm: 'complete' }, before.version);
        const after = await adapter.store.get(sealed.id);
        if (after.updated_at !== before.updated_at) {
          throw new Error(
            `stampSeal moved updated_at (${before.updated_at} -> ${after.updated_at}) — stamping ` +
              `is not activity; the retention clock must not move`,
          );
        }
      },
    },
    // --- SUCCESS legs. These need an UNSTAMPED terminal record, which is why the seed hook
    // exists: without them a store that NEVER WRITES conforms to all five laws.
    ...(adapter.seedLegacyTerminal === undefined
      ? [
          {
            law: 'STAMP_PRESERVES_UPDATED_AT' as const,
            name: `[${adapter.storeName}] ADAPTER_WIRING: a stampSeal-declaring store must supply seedLegacyTerminal`,
            run: async (): Promise<void> => {
              throw new Error(
                'This store declares stampSeal but the adapter has no `seedLegacyTerminal` hook, ' +
                  'so the laws cannot observe an ACTUAL stamp — only its refusals. A store that ' +
                  'never writes would pass. Supply the hook.',
              );
            },
          },
        ]
      : [
          {
            law: 'STAMP_PRESERVES_UPDATED_AT' as const,
            name: `[${adapter.storeName}] a SUCCESSFUL stamp leaves updated_at byte-identical`,
            run: async (): Promise<void> => {
              const seeded = await adapter.seedLegacyTerminal!('tck-stamp-success-clock');
              const result = await stamp(
                seeded.id,
                { arm: 'complete', classified: true },
                seeded.version,
              );
              if (!result.stamped) {
                throw new Error(
                  `expected an unstamped terminal record to be STAMPED, got refusal ` +
                    `'${result.reason}' — a store that never writes is not conformant`,
                );
              }
              const after = await adapter.store.get(seeded.id);
              if (after.sealed_by?.arm !== 'complete') {
                throw new Error(`the arm did not land: ${JSON.stringify(after.sealed_by)}`);
              }
              if (after.updated_at !== seeded.updated_at) {
                throw new Error(
                  `stamping moved updated_at (${seeded.updated_at} -> ${after.updated_at}) — ` +
                    `stamping is not activity`,
                );
              }
            },
          },
          {
            law: 'STAMP_BUMPS_VERSION_ONCE' as const,
            name: `[${adapter.storeName}] a SUCCESSFUL stamp bumps version exactly once`,
            run: async (): Promise<void> => {
              const seeded = await adapter.seedLegacyTerminal!('tck-stamp-success-version');
              await stamp(seeded.id, { arm: 'complete', classified: true }, seeded.version);
              const after = await adapter.store.get(seeded.id);
              if (after.version !== seeded.version + 1) {
                throw new Error(
                  `expected version ${seeded.version + 1}, got ${after.version} — the CAS ` +
                    `protocol is what stops a stale writer erasing the stamp`,
                );
              }
            },
          },
          {
            law: 'STAMP_CLASSIFIED_ROUNDTRIP' as const,
            name: `[${adapter.storeName}] a \`classified: true\` stamp survives write → read byte-for-byte`,
            run: async (): Promise<void> => {
              // The provenance marker is what keeps a classifier-minted stamp distinguishable from
              // a writer's own assertion FOREVER. A store that drops it looks conformant on every
              // other law while quietly destroying that distinction.
              const seeded = await adapter.seedLegacyTerminal!('tck-stamp-classified');
              await stamp(seeded.id, { arm: 'complete', classified: true }, seeded.version);
              const after = await adapter.store.get(seeded.id);
              if (after.sealed_by?.classified !== true) {
                throw new Error(
                  `the \`classified\` provenance marker did not survive the round trip: ` +
                    `${JSON.stringify(after.sealed_by)} — a vehicle-minted stamp must stay ` +
                    `distinguishable from a writer-asserted one`,
                );
              }
            },
          },
        ]),
    {
      law: 'STAMP_RETURNS_NOT_THROWS_PREDICATES',
      name: `[${adapter.storeName}] a NON-TERMINAL record RETURNS 'not_terminal', never throws`,
      run: async () => {
        // No seed hook needed: `create()` makes a live record, which is exactly the shape.
        const { run } = await adapter.store.create({
          workflowId: 'tck-stamp-live',
          workflowVersion: 1,
          params: {},
        });
        const result = await stamp(run.id, { arm: 'complete' }, run.version);
        if (result.stamped !== false || result.reason !== 'not_terminal') {
          throw new Error(
            `expected a RETURNED {stamped:false, reason:'not_terminal'}, got ` +
              `${JSON.stringify(result)}`,
          );
        }
      },
    },
    {
      law: 'STAMP_RETURNS_NOT_THROWS_PREDICATES',
      name: `[${adapter.storeName}] an already-stamped record RETURNS, never throws`,
      run: async () => {
        const sealed = await stampedTerminal('already');
        const fresh = await adapter.store.get(sealed.id);
        const result = await stamp(fresh.id, { arm: 'complete' }, fresh.version);
        if (result.stamped !== false || result.reason !== 'already_stamped') {
          throw new Error(
            `expected a RETURNED {stamped:false, reason:'already_stamped'}, got ` +
              `${JSON.stringify(result)} — a predicate refusal is not an exceptional condition`,
          );
        }
      },
    },
    {
      law: 'STAMP_BUMPS_VERSION_ONCE',
      name: `[${adapter.storeName}] a refused stamp does not bump version`,
      run: async () => {
        const sealed = await stampedTerminal('version');
        const before = await adapter.store.get(sealed.id);
        await stamp(before.id, { arm: 'complete' }, before.version);
        const after = await adapter.store.get(before.id);
        if (after.version !== before.version) {
          throw new Error(
            `a refused stamp moved version (${before.version} -> ${after.version}) — only a real ` +
              `write bumps it`,
          );
        }
      },
    },
    {
      law: 'STAMP_REFUSES_ON_VERSION_MOVE',
      name: `[${adapter.storeName}] a stale expectedVersion THROWS STATE_SNAPSHOT_MISMATCH`,
      run: async () => {
        const sealed = await stampedTerminal('cas');
        let code: string | undefined;
        try {
          await stamp(sealed.id, { arm: 'complete' }, sealed.version + 99);
        } catch (err) {
          code = (err as { code?: string }).code;
        }
        if (code !== 'STATE_SNAPSHOT_MISMATCH') {
          throw new Error(
            `expected STATE_SNAPSHOT_MISMATCH on a version move, got '${String(code)}' — the ` +
              `sweep classified a record that has since changed, and must not write over it`,
          );
        }
      },
    },
    {
      law: 'STAMP_IDEMPOTENT',
      name: `[${adapter.storeName}] re-stamping leaves the record byte-identical`,
      run: async () => {
        const sealed = await stampedTerminal('idem');
        const before = JSON.stringify(await adapter.store.get(sealed.id));
        await stamp(sealed.id, { arm: 'complete' }, sealed.version);
        await stamp(sealed.id, { arm: 'complete' }, sealed.version);
        const after = JSON.stringify(await adapter.store.get(sealed.id));
        if (after !== before) {
          throw new Error(`re-stamping changed the record:\n  before ${before}\n  after  ${after}`);
        }
      },
    },
  ];
}

function csPurityCases(_adapter: SettlementContractAdapter): SettlementContractCase[] {
  return [
    {
      law: 'CS_PURITY',
      name: 'applySettlement is callable with ONLY {now?: Date} as its options — no callback, no registry parameter exists to pass',
      run: async () => {
        // A structural proof, not a source-text grep (that lives in the calling test file, which
        // can read its own source — this module ships compiled and has no access to its own
        // source text at runtime). Calling applySettlement with a bare {now} object and nothing
        // else demonstrates the FULL options surface is exhausted by that one field — TypeScript
        // itself would reject an extra property on a literal passed here if the type carried one.
        const def = minimalDefinition(['a']);
        const fresh: RunRecord = {
          id: 'tck-cs-purity',
          workflow_id: def.id,
          workflow_version: 1,
          completed_steps: [],
          in_progress_steps: ['a'],
          failed_steps: [],
          skipped_steps: [],
          run_phase: 'running',
          version: 0,
          params: {},
          evidence: [],
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
          terminal_state: false,
          claims: { a: { deadline: null, token: 'tck-token' } },
        };
        const result = applySettlement(
          fresh,
          {
            kind: 'settle_step',
            step: 'a',
            outcome: 'complete',
            claimToken: 'tck-token',
            evidence: [],
          },
          def,
          { now: new Date('2026-01-01T00:00:00.000Z') },
        );
        if (!result.applied) {
          throw new Error(
            `expected applied:true from a purity-check call, got refusal: ${result.reason}`,
          );
        }
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// L8 never-downgrade — completed/failed ledger entries are immutable across a re-mint.
// ---------------------------------------------------------------------------

function neverDowngradeCases(_adapter: SettlementContractAdapter): SettlementContractCase[] {
  return [
    {
      law: 'NEVER_DOWNGRADE',
      name: 'mintFresh (via a hand-authored fresh state) never downgrades an already-completed finalizer ledger entry back to pending',
      run: async () => {
        // Transform-level (not store-level): hand-author a fresh state where 'fin' is selected by
        // selectFinalizers (not yet in completed_steps) but its ledger entry ALREADY shows
        // 'completed' — the defensive guard mintFresh's own doc names ("membership-skip SHOULD
        // exclude this; the guard is defensive"). Exercised directly against applySettlement so
        // the terminal false→true edge fires mintFresh in a single, controlled call.
        const def = withFinalizer(minimalDefinition(['a']), 'fin', 'complete');
        const fresh: RunRecord = {
          id: 'tck-never-downgrade',
          workflow_id: def.id,
          workflow_version: 1,
          completed_steps: [],
          in_progress_steps: ['a'],
          failed_steps: [],
          skipped_steps: [],
          run_phase: 'running',
          version: 0,
          params: {},
          evidence: [],
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
          terminal_state: false,
          claims: { a: { deadline: null, token: 'tck-token' } },
          finalizer_ledger: { fin: { status: 'completed', rank: 0 } },
        };
        const result = applySettlement(
          fresh,
          {
            kind: 'settle_step',
            step: 'a',
            outcome: 'complete',
            claimToken: 'tck-token',
            evidence: [makeEvidence('a')],
          },
          def,
          { now: new Date('2026-01-01T00:00:00.000Z') },
        );
        if (!result.applied)
          throw new Error(`expected applied:true, got refusal: ${result.reason}`);
        if (result.run.finalizer_ledger?.['fin']?.status !== 'completed') {
          throw new Error(
            `expected the already-completed finalizer to stay 'completed', got '${result.run.finalizer_ledger?.['fin']?.status}'`,
          );
        }
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// L9 SETTLE_OUTCOME_INTEGRITY
// ---------------------------------------------------------------------------

function settleOutcomeIntegrityCases(adapter: SettlementContractAdapter): SettlementContractCase[] {
  const { minimalDefinition } = adapter.settlementFixture!;
  const settleStep = requireSettleStep(adapter.store);
  return [
    {
      law: 'SETTLE_OUTCOME_INTEGRITY',
      name: `[${adapter.storeName}] the SAME token settling the SAME step with a DIFFERENT outcome refuses settled_outcome_divergence`,
      run: async () => {
        const def = minimalDefinition(['a', 'b']);
        const { run, token } = await createClaimed(adapter.store, def, 'a');
        const first = await settleStep(
          run.id,
          {
            kind: 'settle_step',
            step: 'a',
            outcome: 'complete',
            claimToken: token,
            evidence: [makeEvidence('a')],
          },
          def,
        );
        assertApplied(first, 'first settle (complete)');
        const second = await settleStep(
          run.id,
          {
            kind: 'settle_step',
            step: 'a',
            outcome: 'fail',
            claimToken: token,
            evidence: [],
            failureMessage: 'tck-divergent',
          },
          def,
        );
        assertRefused(second, 'settled_outcome_divergence', 'same token, divergent outcome');
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// L10 SETTLED_ORPHAN_OVERWRITE (+ wrong-set fixture, lens-3 F7)
// ---------------------------------------------------------------------------

function settledOrphanOverwriteCases(adapter: SettlementContractAdapter): SettlementContractCase[] {
  const { minimalDefinition } = adapter.settlementFixture!;
  const settleStep = requireSettleStep(adapter.store);
  return [
    {
      law: 'SETTLED_ORPHAN_OVERWRITE',
      name: `[${adapter.storeName}] a settled entry {outcome:'fail'} while the step is ACTUALLY in completed_steps (wrong-set) is treated as ABSENT (orphan) — never a false already_settled_by_other`,
      run: async () => {
        const def = minimalDefinition(['a']);
        const { run, token } = await createClaimed(adapter.store, def, 'a');
        // Hand-author the wrong-set orphan: 'a' is in completed_steps, but its settled entry
        // claims 'fail' — a genuinely inconsistent state that only a hand-authored fixture (or an
        // external store's own divergent history) could produce; settleStep itself always writes
        // both atomically and could never reach this state on its own.
        const seeded = await adapter.store.update({
          ...run,
          completed_steps: ['a'],
          in_progress_steps: [],
          settled: { a: { token: 'stale-different-token', outcome: 'fail' } },
        });
        const result = await settleStep(
          seeded.id,
          {
            kind: 'settle_step',
            step: 'a',
            outcome: 'complete',
            claimToken: token,
            evidence: [makeEvidence('a')],
          },
          def,
        );
        // The orphan rule's own scope: the predicate must NOT treat the stale entry as a real
        // idempotence match (which would incorrectly refuse already_settled_by_other, since the
        // stale entry's token differs from the real claim token). It is explicitly out of THIS
        // law's scope whether the resulting membership arrays stay duplicate-free when fed a
        // deliberately-inconsistent hand-authored input.
        if (result.applied === false && result.reason === 'already_settled_by_other') {
          throw new Error(
            'the orphaned settled entry incorrectly wedged the predicate into already_settled_by_other — entryOf must treat it as absent',
          );
        }
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// L11 TRANSFORM_FIDELITY (+ TERMINAL_GATE_EXCLUSION asserted across the same fixtures)
// ---------------------------------------------------------------------------

function transformFidelityCases(adapter: SettlementContractAdapter): SettlementContractCase[] {
  const { minimalDefinition } = adapter.settlementFixture!;
  const settleStep = requireSettleStep(adapter.store);

  async function fidelityRun(outcome: 'complete' | 'fail' | 'abort'): Promise<void> {
    const def = minimalDefinition(['a', 'b']);
    const { run, token } = await createClaimed(adapter.store, def, 'a');
    const now = new Date('2026-06-15T12:00:00.000Z');
    const delta: SettlementDelta =
      outcome === 'abort'
        ? {
            kind: 'settle_step',
            step: 'a',
            outcome: 'abort',
            claimToken: token,
            evidence: [makeEvidence('a')],
            abort: { stepId: 'a', abortMessage: 'tck-fidelity-abort' },
          }
        : {
            kind: 'settle_step',
            step: 'a',
            outcome,
            claimToken: token,
            evidence: [makeEvidence('a')],
            ...(outcome === 'fail' ? { failureMessage: 'tck-fidelity-fail' } : {}),
          };

    // Harness-controlled fresh read — the SAME state settleStep's own internal fresh read will see
    // (nothing else mutates this run between the two reads in a single-threaded test).
    const freshRead = await adapter.store.get(run.id);
    const expected = applySettlement(freshRead, delta, def, { now });
    const actual = await settleStep(run.id, delta, def, { now });

    if (expected.applied !== actual.applied) {
      throw new Error(
        `transform/store fidelity mismatch: harness applySettlement applied=${expected.applied}, store settleStep applied=${actual.applied}`,
      );
    }
    if (expected.applied && actual.applied) {
      const { version: _ev, updated_at: _eu, ...expectedRest } = expected.run;
      const { version: _av, updated_at: _au, ...actualRest } = actual.run;
      const expectedJson = JSON.stringify(expectedRest);
      const actualJson = JSON.stringify(actualRest);
      if (expectedJson !== actualJson) {
        throw new Error(
          `transform fidelity mismatch (modulo version/updated_at):\nharness: ${expectedJson}\nstore:   ${actualJson}`,
        );
      }
      // TERMINAL_GATE_EXCLUSION, asserted across this fixture: no settleStep APPLY output ever
      // carries BOTH terminal_state:true AND a defined pending_gate.
      if (actual.run.terminal_state === true && actual.run.pending_gate !== undefined) {
        throw new Error('TERMINAL_GATE_EXCLUSION violated: terminal AND pending_gate both present');
      }
    }
  }

  return [
    {
      law: 'TRANSFORM_FIDELITY',
      name: `[${adapter.storeName}] settleStep's persisted output matches applySettlement's own output exactly (modulo version/updated_at) — complete outcome, {now} injected`,
      run: () => fidelityRun('complete'),
    },
    {
      law: 'TRANSFORM_FIDELITY',
      name: `[${adapter.storeName}] settleStep's persisted output matches applySettlement's own output exactly (modulo version/updated_at) — fail outcome, {now} injected`,
      run: () => fidelityRun('fail'),
    },
    {
      law: 'TRANSFORM_FIDELITY',
      name: `[${adapter.storeName}] settleStep's persisted output matches applySettlement's own output exactly (modulo version/updated_at) — abort outcome, {now} injected`,
      run: () => fidelityRun('abort'),
    },
    {
      law: 'TERMINAL_GATE_EXCLUSION',
      name: `[${adapter.storeName}] no settleStep APPLY output ever carries BOTH terminal_state:true and a defined pending_gate (asserted across the TRANSFORM_FIDELITY fixtures)`,
      run: () => fidelityRun('complete'),
    },
  ];
}

// ---------------------------------------------------------------------------
// RESULT_AS_APPLIED (a fidelity-dropping fixture store — final-gate F5)
// ---------------------------------------------------------------------------

/** A deliberately LOSSY store (issue #279 TCK only) — its `get()` strips `defaulted_steps` on
 *  every read, but its internal storage and its OWN `settleStep` never do. Proves
 *  `SettlementResult.run` on `applied:true` is the AS-APPLIED transform output, NEVER a re-read —
 *  a store whose round-trip drops a field must still return that field's TRUE value directly. */
class LossyFixtureStore implements RunStore {
  private readonly runs = new Map<string, RunRecord>();
  readonly persistsClaims = true;
  // Deliberately dishonest — never declares anything (`persistedRunRecordFields` omitted, not set
  // to `undefined`: exactOptionalPropertyTypes forbids assigning `undefined` to an optional field).

  async create(options: {
    workflowId: string;
    workflowVersion: number;
    params: Record<string, unknown>;
  }): Promise<{ run: RunRecord; created: boolean }> {
    const now = new Date().toISOString();
    const run: RunRecord = {
      id: uid('lossy-run'),
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
    this.runs.set(run.id, run);
    return { run, created: true };
  }

  async get(runId: string): Promise<RunRecord> {
    const run = this.runs.get(runId);
    if (run === undefined) throw new Error(`lossy fixture store: run '${runId}' not found`);
    // LOSSY: strips defaulted_steps on every read — the whole point of this fixture.
    const { defaulted_steps: _dropped, ...rest } = run;
    return rest as RunRecord;
  }

  async update(record: RunRecord): Promise<RunRecord> {
    const updated: RunRecord = {
      ...record,
      version: record.version + 1,
      updated_at: new Date().toISOString(),
    };
    this.runs.set(updated.id, updated);
    return updated;
  }

  async list(): Promise<RunRecord[]> {
    return [...this.runs.values()];
  }

  async claimStep(
    runId: string,
    stepName: string,
    _definition: WorkflowDefinition,
  ): Promise<RunRecord> {
    const run = this.runs.get(runId);
    if (run === undefined) throw new Error(`lossy fixture store: run '${runId}' not found`);
    const claimed: RunRecord = {
      ...run,
      in_progress_steps: [...run.in_progress_steps, stepName],
      claims: { ...run.claims, [stepName]: { deadline: null, token: uid('lossy-token') } },
      version: run.version + 1,
      updated_at: new Date().toISOString(),
    };
    this.runs.set(claimed.id, claimed);
    return claimed;
  }

  async settleStep(
    runId: string,
    delta: SettlementDelta,
    definition: WorkflowDefinition,
    options?: { now?: Date },
  ): Promise<SettlementResult> {
    // Reads its OWN internal map directly (never through the lossy `get()` above).
    const fresh = this.runs.get(runId);
    if (fresh === undefined) throw new Error(`lossy fixture store: run '${runId}' not found`);
    const outcome = applySettlement(fresh, delta, definition, options);
    if (!outcome.applied) return outcome;
    const updated: RunRecord = {
      ...outcome.run,
      version: fresh.version + 1,
      updated_at: new Date().toISOString(),
    };
    this.runs.set(runId, updated);
    return { ...outcome, run: updated }; // the AS-APPLIED output — never routed through get()
  }
}

function resultAsAppliedCases(): SettlementContractCase[] {
  return [
    {
      law: 'RESULT_AS_APPLIED',
      name: "a fidelity-dropping store (its own get() strips defaulted_steps) still returns the TRUE stamped defaulted_steps directly on settleStep's result — never a re-read",
      run: async () => {
        const store = new LossyFixtureStore();
        const def = minimalDefinition(['a']);
        const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
        const claimed = await store.claimStep(run.id, 'a', def);
        const token = claimed.claims!['a']!.token!;
        const result = await store.settleStep(
          run.id,
          {
            kind: 'settle_step',
            step: 'a',
            outcome: 'complete',
            claimToken: token,
            evidence: [
              makeEvidence('a', {
                diagnostics: {
                  input_token_estimate: 1,
                  precondition_trace: [],
                  settled_by_default: true,
                },
              }),
            ],
          },
          def,
        );
        assertApplied(result, 'settle on the lossy fixture store');
        if (!result.run.defaulted_steps?.includes('a')) {
          throw new Error(
            `expected settleStep's OWN result to carry defaulted_steps:['a'] directly, got: ${JSON.stringify(result.run.defaulted_steps)}`,
          );
        }
        // Prove the store really IS lossy on round-trip (the premise the whole test depends on).
        const reread = await store.get(run.id);
        if (reread.defaulted_steps !== undefined) {
          throw new Error(
            'fixture premise violated: the lossy store did not actually drop defaulted_steps on get()',
          );
        }
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// L12 MARK_MEMBERSHIP
// ---------------------------------------------------------------------------

function markMembershipCases(adapter: SettlementContractAdapter): SettlementContractCase[] {
  const { minimalDefinition, withFinalizer } = adapter.settlementFixture!;
  const settleStep = requireSettleStep(adapter.store);

  async function markRun(
    result: 'completed' | 'failed',
    expectedArray: 'completed_steps' | 'failed_steps',
  ): Promise<void> {
    const def = withFinalizer(minimalDefinition(['a']), 'fin', 'always');
    const { run, token } = await createClaimed(adapter.store, def, 'a');
    const settled = await settleStep(
      run.id,
      {
        kind: 'settle_step',
        step: 'a',
        outcome: 'complete',
        claimToken: token,
        evidence: [makeEvidence('a')],
      },
      def,
    );
    assertApplied(settled, 'terminal settle minting the finalizer');
    const leaseToken = uid('lease');
    const leased = await settleStep(
      run.id,
      { kind: 'lease_finalizer', finalizer: 'fin', leaseToken, leaseSeconds: 60 },
      def,
    );
    assertApplied(leased, 'lease the pending finalizer');
    const marked = await settleStep(
      run.id,
      {
        kind: 'mark_finalizer',
        finalizer: 'fin',
        leaseToken,
        result,
        evidence: makeEvidence('fin'),
      },
      def,
    );
    assertApplied(marked, `mark the finalizer ${result}`);
    if (!marked.run[expectedArray].includes('fin')) {
      throw new Error(
        `expected 'fin' to join ${expectedArray} on a '${result}' mark, got: ${JSON.stringify(marked.run[expectedArray])}`,
      );
    }
  }

  return [
    {
      law: 'MARK_MEMBERSHIP',
      name: `[${adapter.storeName}] mark_finalizer result:'completed' adds the finalizer name to completed_steps`,
      run: () => markRun('completed', 'completed_steps'),
    },
    {
      law: 'MARK_MEMBERSHIP',
      name: `[${adapter.storeName}] mark_finalizer result:'failed' adds the finalizer name to failed_steps`,
      run: () => markRun('failed', 'failed_steps'),
    },
  ];
}

// ---------------------------------------------------------------------------
// L13 REFUSAL_SWEEP — one fixture per REFUSE/NOOP line of §3 (17 total: 6 settle_step,
// 6 lease_finalizer, 5 mark_finalizer). Every fixture asserts the typed literal reason AND that
// the record/version are unchanged (a refusal/noop never writes).
// ---------------------------------------------------------------------------

function refusalSweepCases(adapter: SettlementContractAdapter): SettlementContractCase[] {
  const { minimalDefinition, withFinalizer } = adapter.settlementFixture!;
  const settleStep = requireSettleStep(adapter.store);

  async function expectRefusalUnchanged(
    runId: string,
    delta: SettlementDelta,
    def: WorkflowDefinition,
    expectedReason: string,
    versionBefore: number,
    label: string,
  ): Promise<void> {
    const result = await settleStep(runId, delta, def);
    if (result.applied) {
      throw new Error(`${label}: expected a refusal/noop ('${expectedReason}'), got applied:true`);
    }
    if (result.reason !== expectedReason) {
      throw new Error(`${label}: expected reason '${expectedReason}', got '${result.reason}'`);
    }
    if (result.run.version !== versionBefore) {
      throw new Error(
        `${label}: expected version unchanged (${versionBefore}), got ${result.run.version}`,
      );
    }
  }

  const cases: SettlementContractCase[] = [];

  // --- settle_step (6) ---
  cases.push({
    law: 'REFUSAL_SWEEP',
    name: `[${adapter.storeName}] settle_step: already_settled_by_other (different token on a settled step)`,
    run: async () => {
      const def = minimalDefinition(['a']);
      const { run, token } = await createClaimed(adapter.store, def, 'a');
      const settled = await settleStep(
        run.id,
        {
          kind: 'settle_step',
          step: 'a',
          outcome: 'complete',
          claimToken: token,
          evidence: [makeEvidence('a')],
        },
        def,
      );
      assertApplied(settled, 'setup settle');
      await expectRefusalUnchanged(
        run.id,
        {
          kind: 'settle_step',
          step: 'a',
          outcome: 'complete',
          claimToken: 'a-different-token',
          evidence: [],
        },
        def,
        'already_settled_by_other',
        settled.run.version,
        'already_settled_by_other',
      );
    },
  });
  cases.push({
    law: 'REFUSAL_SWEEP',
    name: `[${adapter.storeName}] settle_step: already_settled (NOOP — same token, same outcome)`,
    run: async () => {
      const def = minimalDefinition(['a']);
      const { run, token } = await createClaimed(adapter.store, def, 'a');
      const delta: SettlementDelta = {
        kind: 'settle_step',
        step: 'a',
        outcome: 'complete',
        claimToken: token,
        evidence: [makeEvidence('a')],
      };
      const settled = await settleStep(run.id, delta, def);
      assertApplied(settled, 'setup settle');
      await expectRefusalUnchanged(
        run.id,
        delta,
        def,
        'already_settled',
        settled.run.version,
        'already_settled',
      );
    },
  });
  cases.push({
    law: 'REFUSAL_SWEEP',
    name: `[${adapter.storeName}] settle_step: settled_outcome_divergence (same token, different outcome)`,
    run: async () => {
      const def = minimalDefinition(['a']);
      const { run, token } = await createClaimed(adapter.store, def, 'a');
      const settled = await settleStep(
        run.id,
        {
          kind: 'settle_step',
          step: 'a',
          outcome: 'complete',
          claimToken: token,
          evidence: [makeEvidence('a')],
        },
        def,
      );
      assertApplied(settled, 'setup settle');
      await expectRefusalUnchanged(
        run.id,
        {
          kind: 'settle_step',
          step: 'a',
          outcome: 'fail',
          claimToken: token,
          evidence: [],
          failureMessage: 'x',
        },
        def,
        'settled_outcome_divergence',
        settled.run.version,
        'settled_outcome_divergence',
      );
    },
  });
  cases.push({
    law: 'REFUSAL_SWEEP',
    name: `[${adapter.storeName}] settle_step: run_terminal (a different, never-settled step on an already-terminal run)`,
    run: async () => {
      const def = minimalDefinition(['a', 'b']);
      const { run } = await adapter.store.create({
        workflowId: def.id,
        workflowVersion: 1,
        params: {},
      });
      const terminal = await adapter.store.update({
        ...run,
        terminal_state: true,
        // issue #367: a terminal record names its arm. These fixtures mean "this run is over";
        // their opaque `tck` prose is deliberately unclassifiable, so the boundary's coherence
        // check abstains and the fixture stays a pure terminal-precondition seeder.
        sealed_by: { arm: 'complete' as const },
        terminal_reason: 'tck',
      });
      await expectRefusalUnchanged(
        run.id,
        { kind: 'settle_step', step: 'b', outcome: 'complete', claimToken: 'x', evidence: [] },
        def,
        'run_terminal',
        terminal.version,
        'run_terminal',
      );
    },
  });
  cases.push({
    law: 'REFUSAL_SWEEP',
    name: `[${adapter.storeName}] settle_step: claim_lost (no claim record at all for the step)`,
    run: async () => {
      const def = minimalDefinition(['a']);
      const { run } = await adapter.store.create({
        workflowId: def.id,
        workflowVersion: 1,
        params: {},
      });
      await expectRefusalUnchanged(
        run.id,
        { kind: 'settle_step', step: 'a', outcome: 'complete', claimToken: 'x', evidence: [] },
        def,
        'claim_lost',
        run.version,
        'claim_lost',
      );
    },
  });
  cases.push({
    law: 'REFUSAL_SWEEP',
    name: `[${adapter.storeName}] settle_step: gate_mismatch (the step IS the currently-open gate)`,
    run: async () => {
      const def = minimalDefinition(['a']);
      const { run, token } = await createClaimed(adapter.store, def, 'a');
      const gated = await adapter.store.update({
        ...run,
        pending_gate: {
          gate_id: 'tck-gate',
          step_name: 'a',
          preview: {},
          choices: ['approve'],
          opened_at: '2026-01-01T00:00:00.000Z',
        },
      });
      await expectRefusalUnchanged(
        run.id,
        { kind: 'settle_step', step: 'a', outcome: 'complete', claimToken: token, evidence: [] },
        def,
        'gate_mismatch',
        gated.version,
        'gate_mismatch',
      );
    },
  });

  // --- lease_finalizer (6) ---
  cases.push({
    law: 'REFUSAL_SWEEP',
    name: `[${adapter.storeName}] lease_finalizer: run_not_terminal (defensive; a non-terminal run somehow carrying a ledger entry)`,
    run: async () => {
      const def = withFinalizer(minimalDefinition(['a']), 'fin', 'always');
      const { run } = await adapter.store.create({
        workflowId: def.id,
        workflowVersion: 1,
        params: {},
      });
      const seeded = await adapter.store.update({
        ...run,
        finalizer_ledger: { fin: { status: 'pending', rank: 0 } },
      });
      await expectRefusalUnchanged(
        run.id,
        { kind: 'lease_finalizer', finalizer: 'fin', leaseToken: uid('lease'), leaseSeconds: 30 },
        def,
        'run_not_terminal',
        seeded.version,
        'lease run_not_terminal',
      );
    },
  });
  cases.push({
    law: 'REFUSAL_SWEEP',
    name: `[${adapter.storeName}] lease_finalizer: not_eligible (unknown finalizer id)`,
    run: async () => {
      const def = minimalDefinition(['a']);
      const { run } = await adapter.store.create({
        workflowId: def.id,
        workflowVersion: 1,
        params: {},
      });
      const terminal = await adapter.store.update({
        ...run,
        terminal_state: true,
        // issue #367: a terminal record names its arm. These fixtures mean "this run is over";
        // their opaque `tck` prose is deliberately unclassifiable, so the boundary's coherence
        // check abstains and the fixture stays a pure terminal-precondition seeder.
        sealed_by: { arm: 'complete' as const },
        terminal_reason: 'tck',
      });
      await expectRefusalUnchanged(
        run.id,
        {
          kind: 'lease_finalizer',
          finalizer: 'nonexistent',
          leaseToken: uid('lease'),
          leaseSeconds: 30,
        },
        def,
        'not_eligible',
        terminal.version,
        'lease not_eligible',
      );
    },
  });
  cases.push({
    law: 'REFUSAL_SWEEP',
    name: `[${adapter.storeName}] lease_finalizer: ledger_not_pending (entry already completed)`,
    run: async () => {
      const def = withFinalizer(minimalDefinition(['a']), 'fin', 'always');
      const { run } = await adapter.store.create({
        workflowId: def.id,
        workflowVersion: 1,
        params: {},
      });
      const seeded = await adapter.store.update({
        ...run,
        terminal_state: true,
        // issue #367: a terminal record names its arm. These fixtures mean "this run is over";
        // their opaque `tck` prose is deliberately unclassifiable, so the boundary's coherence
        // check abstains and the fixture stays a pure terminal-precondition seeder.
        sealed_by: { arm: 'complete' as const },
        terminal_reason: 'tck',
        finalizer_ledger: { fin: { status: 'completed', rank: 0 } },
      });
      await expectRefusalUnchanged(
        run.id,
        { kind: 'lease_finalizer', finalizer: 'fin', leaseToken: uid('lease'), leaseSeconds: 30 },
        def,
        'ledger_not_pending',
        seeded.version,
        'lease ledger_not_pending',
      );
    },
  });
  cases.push({
    law: 'REFUSAL_SWEEP',
    name: `[${adapter.storeName}] lease_finalizer: already_leased (NOOP — same token, unexpired)`,
    run: async () => {
      const def = withFinalizer(minimalDefinition(['a']), 'fin', 'always');
      const { run } = await adapter.store.create({
        workflowId: def.id,
        workflowVersion: 1,
        params: {},
      });
      await adapter.store.update({
        ...run,
        terminal_state: true,
        // issue #367: a terminal record names its arm. These fixtures mean "this run is over";
        // their opaque `tck` prose is deliberately unclassifiable, so the boundary's coherence
        // check abstains and the fixture stays a pure terminal-precondition seeder.
        sealed_by: { arm: 'complete' as const },
        terminal_reason: 'tck',
        finalizer_ledger: { fin: { status: 'pending', rank: 0 } },
      });
      const leaseToken = uid('lease');
      const first = await settleStep(
        run.id,
        { kind: 'lease_finalizer', finalizer: 'fin', leaseToken, leaseSeconds: 60 },
        def,
      );
      assertApplied(first, 'setup lease');
      await expectRefusalUnchanged(
        run.id,
        { kind: 'lease_finalizer', finalizer: 'fin', leaseToken, leaseSeconds: 60 },
        def,
        'already_leased',
        first.run.version,
        'lease already_leased',
      );
    },
  });
  cases.push({
    law: 'REFUSAL_SWEEP',
    name: `[${adapter.storeName}] lease_finalizer: rank_blocked (a lower-ranked pending entry still unleased)`,
    run: async () => {
      const def = withFinalizer(
        withFinalizer(minimalDefinition(['a']), 'first', 'always'),
        'second',
        'always',
      );
      const { run } = await adapter.store.create({
        workflowId: def.id,
        workflowVersion: 1,
        params: {},
      });
      const seeded = await adapter.store.update({
        ...run,
        terminal_state: true,
        // issue #367: a terminal record names its arm. These fixtures mean "this run is over";
        // their opaque `tck` prose is deliberately unclassifiable, so the boundary's coherence
        // check abstains and the fixture stays a pure terminal-precondition seeder.
        sealed_by: { arm: 'complete' as const },
        terminal_reason: 'tck',
        finalizer_ledger: {
          first: { status: 'pending', rank: 0 },
          second: { status: 'pending', rank: 1 },
        },
      });
      await expectRefusalUnchanged(
        run.id,
        {
          kind: 'lease_finalizer',
          finalizer: 'second',
          leaseToken: uid('lease'),
          leaseSeconds: 30,
        },
        def,
        'rank_blocked',
        seeded.version,
        'lease rank_blocked',
      );
    },
  });
  cases.push({
    law: 'REFUSAL_SWEEP',
    name: `[${adapter.storeName}] lease_finalizer: lease_held (a DIFFERENT token's unexpired lease)`,
    run: async () => {
      const def = withFinalizer(minimalDefinition(['a']), 'fin', 'always');
      const { run } = await adapter.store.create({
        workflowId: def.id,
        workflowVersion: 1,
        params: {},
      });
      await adapter.store.update({
        ...run,
        terminal_state: true,
        // issue #367: a terminal record names its arm. These fixtures mean "this run is over";
        // their opaque `tck` prose is deliberately unclassifiable, so the boundary's coherence
        // check abstains and the fixture stays a pure terminal-precondition seeder.
        sealed_by: { arm: 'complete' as const },
        terminal_reason: 'tck',
        finalizer_ledger: { fin: { status: 'pending', rank: 0 } },
      });
      const first = await settleStep(
        run.id,
        { kind: 'lease_finalizer', finalizer: 'fin', leaseToken: uid('lease-a'), leaseSeconds: 60 },
        def,
      );
      assertApplied(first, 'setup lease');
      await expectRefusalUnchanged(
        run.id,
        { kind: 'lease_finalizer', finalizer: 'fin', leaseToken: uid('lease-b'), leaseSeconds: 60 },
        def,
        'lease_held',
        first.run.version,
        'lease lease_held',
      );
    },
  });

  // --- mark_finalizer (5) ---
  cases.push({
    law: 'REFUSAL_SWEEP',
    name: `[${adapter.storeName}] mark_finalizer: not_eligible (unknown finalizer id)`,
    run: async () => {
      const def = minimalDefinition(['a']);
      const { run } = await adapter.store.create({
        workflowId: def.id,
        workflowVersion: 1,
        params: {},
      });
      const terminal = await adapter.store.update({
        ...run,
        terminal_state: true,
        // issue #367: a terminal record names its arm. These fixtures mean "this run is over";
        // their opaque `tck` prose is deliberately unclassifiable, so the boundary's coherence
        // check abstains and the fixture stays a pure terminal-precondition seeder.
        sealed_by: { arm: 'complete' as const },
        terminal_reason: 'tck',
      });
      await expectRefusalUnchanged(
        run.id,
        {
          kind: 'mark_finalizer',
          finalizer: 'nonexistent',
          leaseToken: uid('lease'),
          result: 'completed',
          evidence: makeEvidence('nonexistent'),
        },
        def,
        'not_eligible',
        terminal.version,
        'mark not_eligible',
      );
    },
  });
  cases.push({
    law: 'REFUSAL_SWEEP',
    name: `[${adapter.storeName}] mark_finalizer: already_marked (NOOP — same token, same result)`,
    run: async () => {
      const def = withFinalizer(minimalDefinition(['a']), 'fin', 'always');
      const { run } = await adapter.store.create({
        workflowId: def.id,
        workflowVersion: 1,
        params: {},
      });
      await adapter.store.update({
        ...run,
        terminal_state: true,
        // issue #367: a terminal record names its arm. These fixtures mean "this run is over";
        // their opaque `tck` prose is deliberately unclassifiable, so the boundary's coherence
        // check abstains and the fixture stays a pure terminal-precondition seeder.
        sealed_by: { arm: 'complete' as const },
        terminal_reason: 'tck',
        finalizer_ledger: { fin: { status: 'pending', rank: 0 } },
      });
      const leaseToken = uid('lease');
      const leased = await settleStep(
        run.id,
        { kind: 'lease_finalizer', finalizer: 'fin', leaseToken, leaseSeconds: 60 },
        def,
      );
      assertApplied(leased, 'setup lease');
      const markDelta: SettlementDelta = {
        kind: 'mark_finalizer',
        finalizer: 'fin',
        leaseToken,
        result: 'completed',
        evidence: makeEvidence('fin'),
      };
      const marked = await settleStep(run.id, markDelta, def);
      assertApplied(marked, 'setup mark');
      await expectRefusalUnchanged(
        run.id,
        markDelta,
        def,
        'already_marked',
        marked.run.version,
        'mark already_marked',
      );
    },
  });
  cases.push({
    law: 'REFUSAL_SWEEP',
    name: `[${adapter.storeName}] mark_finalizer: ledger_not_pending (entry already voided)`,
    run: async () => {
      const def = withFinalizer(minimalDefinition(['a']), 'fin', 'always');
      const { run } = await adapter.store.create({
        workflowId: def.id,
        workflowVersion: 1,
        params: {},
      });
      const seeded = await adapter.store.update({
        ...run,
        terminal_state: true,
        // issue #367: a terminal record names its arm. These fixtures mean "this run is over";
        // their opaque `tck` prose is deliberately unclassifiable, so the boundary's coherence
        // check abstains and the fixture stays a pure terminal-precondition seeder.
        sealed_by: { arm: 'complete' as const },
        terminal_reason: 'tck',
        finalizer_ledger: { fin: { status: 'voided', rank: 0 } },
      });
      await expectRefusalUnchanged(
        run.id,
        {
          kind: 'mark_finalizer',
          finalizer: 'fin',
          leaseToken: uid('lease'),
          result: 'completed',
          evidence: makeEvidence('fin'),
        },
        def,
        'ledger_not_pending',
        seeded.version,
        'mark ledger_not_pending',
      );
    },
  });
  cases.push({
    law: 'REFUSAL_SWEEP',
    name: `[${adapter.storeName}] mark_finalizer: lease_lost (a WRONG token on a genuinely-leased entry)`,
    run: async () => {
      const def = withFinalizer(minimalDefinition(['a']), 'fin', 'always');
      const { run } = await adapter.store.create({
        workflowId: def.id,
        workflowVersion: 1,
        params: {},
      });
      await adapter.store.update({
        ...run,
        terminal_state: true,
        // issue #367: a terminal record names its arm. These fixtures mean "this run is over";
        // their opaque `tck` prose is deliberately unclassifiable, so the boundary's coherence
        // check abstains and the fixture stays a pure terminal-precondition seeder.
        sealed_by: { arm: 'complete' as const },
        terminal_reason: 'tck',
        finalizer_ledger: { fin: { status: 'pending', rank: 0 } },
      });
      const leaseToken = uid('lease');
      const leased = await settleStep(
        run.id,
        { kind: 'lease_finalizer', finalizer: 'fin', leaseToken, leaseSeconds: 60 },
        def,
      );
      assertApplied(leased, 'setup lease');
      await expectRefusalUnchanged(
        run.id,
        {
          kind: 'mark_finalizer',
          finalizer: 'fin',
          leaseToken: 'a-wrong-token',
          result: 'completed',
          evidence: makeEvidence('fin'),
        },
        def,
        'lease_lost',
        leased.run.version,
        'mark lease_lost',
      );
    },
  });
  cases.push({
    law: 'REFUSAL_SWEEP',
    name: `[${adapter.storeName}] mark_finalizer: run_not_terminal (defensive; a leased-but-non-terminal run)`,
    run: async () => {
      const def = withFinalizer(minimalDefinition(['a']), 'fin', 'always');
      const { run } = await adapter.store.create({
        workflowId: def.id,
        workflowVersion: 1,
        params: {},
      });
      const leaseToken = uid('lease');
      const seeded = await adapter.store.update({
        ...run,
        finalizer_ledger: {
          fin: {
            status: 'pending',
            rank: 0,
            lease_token: leaseToken,
            lease_deadline: '2099-01-01T00:00:00.000Z',
          },
        },
      });
      await expectRefusalUnchanged(
        run.id,
        {
          kind: 'mark_finalizer',
          finalizer: 'fin',
          leaseToken,
          result: 'completed',
          evidence: makeEvidence('fin'),
        },
        def,
        'run_not_terminal',
        seeded.version,
        'mark run_not_terminal',
      );
    },
  });

  return cases;
}

// ---------------------------------------------------------------------------
// L14 MINT_FRESH — PR-A form (hand-author the post-resume state as a FIXTURE via update(); do NOT
// implement applyResume, which is PR-B's job).
// ---------------------------------------------------------------------------

function mintFreshCases(adapter: SettlementContractAdapter): SettlementContractCase[] {
  const { minimalDefinition, withFinalizer } = adapter.settlementFixture!;
  const settleStep = requireSettleStep(adapter.store);
  return [
    {
      law: 'MINT_FRESH',
      name: `[${adapter.storeName}] a re-fail edge, after a hand-authored post-resume-void state, re-mints a FRESH pending entry for the still-selected finalizer; a re-complete edge does not select it; completed/failed entries are never rewritten`,
      run: async () => {
        // Two finalizers: 'onFail' fires on fail+always is absent (fail-only), 'onComplete' fires
        // on complete only — lets the test distinguish "re-selected" from "not selected".
        const def = withFinalizer(
          withFinalizer(minimalDefinition(['a', 'b']), 'onFail', 'fail'),
          'onComplete',
          'complete',
        );
        const { run, token } = await createClaimed(adapter.store, def, 'a');
        // First terminal edge: fail 'a' (the only step — a 1-step-visible workflow) to mint 'onFail'.
        // 'a' alone won't terminalize a 2-step def, so also settle 'b' the same way to reach terminal.
        const failA = await settleStep(
          run.id,
          {
            kind: 'settle_step',
            step: 'a',
            outcome: 'fail',
            claimToken: token,
            evidence: [],
            failureMessage: 'x',
          },
          def,
        );
        assertApplied(failA, 'fail step a');
        const claimedB = await adapter.store.claimStep(run.id, 'b', def);
        const tokenB = claimedB.claims!['b']!.token!;
        const failB = await settleStep(
          run.id,
          {
            kind: 'settle_step',
            step: 'b',
            outcome: 'fail',
            claimToken: tokenB,
            evidence: [],
            failureMessage: 'x',
          },
          def,
        );
        assertApplied(failB, 'fail step b (terminalizes)');
        if (failB.run.finalizer_ledger?.['onFail']?.status !== 'pending') {
          throw new Error('expected onFail minted pending after the first fail-terminal edge');
        }
        if (failB.run.finalizer_ledger?.['onComplete'] !== undefined) {
          throw new Error('onComplete must NOT be selected on a fail edge');
        }

        // Mark onFail completed (so the never-rewritten assertion has teeth later).
        const leaseToken = uid('lease');
        const leased = await settleStep(
          run.id,
          { kind: 'lease_finalizer', finalizer: 'onFail', leaseToken, leaseSeconds: 60 },
          def,
        );
        assertApplied(leased, 'lease onFail');
        const marked = await settleStep(
          run.id,
          {
            kind: 'mark_finalizer',
            finalizer: 'onFail',
            leaseToken,
            result: 'completed',
            evidence: makeEvidence('onFail'),
          },
          def,
        );
        assertApplied(marked, 'mark onFail completed');

        // Hand-author the post-resume-void state a real `applyResume` (PR-B) would produce:
        // terminal_state:false, failed_steps cleared, settled-map entries for the re-opened steps
        // dropped, and the STILL-PENDING... there are none pending now (onFail was already
        // marked) — this fixture specifically exercises re-mint on a run with NO pending entries
        // left post-void, proving mintFresh re-arms fresh regardless of prior history.
        // issue #367: a real `applyResume` STRIPS `sealed_by` in the same write that flips the run
        // live — a live run carrying a seal is an orphan, and the store boundary refuses it. This
        // hand-authored fixture mirrors that, or it would stop mirroring the function it stands in
        // for.
        const { sealed_by: _voidSeal, ...markedBase } = marked.run;
        const postResumeVoid = await adapter.store.update({
          ...markedBase,
          terminal_state: false,
          in_progress_steps: [],
          failed_steps: [],
          settled: {},
        });
        if (postResumeVoid.finalizer_ledger?.['onFail']?.status !== 'completed') {
          throw new Error(
            'fixture setup: onFail must still read completed after the hand-authored void',
          );
        }

        // Re-fail edge: re-claim + re-fail 'a' and 'b' — a SECOND terminal fail edge.
        const reclaimedA = await adapter.store.claimStep(run.id, 'a', def);
        const reTokenA = reclaimedA.claims!['a']!.token!;
        const reFailA = await settleStep(
          run.id,
          {
            kind: 'settle_step',
            step: 'a',
            outcome: 'fail',
            claimToken: reTokenA,
            evidence: [],
            failureMessage: 'y',
          },
          def,
        );
        assertApplied(reFailA, 're-fail step a');
        const reclaimedB = await adapter.store.claimStep(run.id, 'b', def);
        const reTokenB = reclaimedB.claims!['b']!.token!;
        const reFailB = await settleStep(
          run.id,
          {
            kind: 'settle_step',
            step: 'b',
            outcome: 'fail',
            claimToken: reTokenB,
            evidence: [],
            failureMessage: 'y',
          },
          def,
        );
        assertApplied(reFailB, 're-fail step b (re-terminalizes)');

        // onFail is selected again by selectFinalizers (fail outcome), but it's already
        // 'completed' in the ledger — the never-downgrade guard means it STAYS completed, never
        // rewritten back to pending. onComplete is still not selected (this is a fail edge).
        if (reFailB.run.finalizer_ledger?.['onFail']?.status !== 'completed') {
          throw new Error(
            `expected onFail to STAY 'completed' (never rewritten) on the re-fail edge, got '${reFailB.run.finalizer_ledger?.['onFail']?.status}'`,
          );
        }
        if (reFailB.run.finalizer_ledger?.['onComplete'] !== undefined) {
          throw new Error('onComplete must not be selected on a re-fail edge either');
        }
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// L21 SELF_IMAGE_IDEMPOTENCE — store-level matrix (apply→re-apply per kind)
// ---------------------------------------------------------------------------

function selfImageIdempotenceCases(adapter: SettlementContractAdapter): SettlementContractCase[] {
  const { minimalDefinition, withFinalizer } = adapter.settlementFixture!;
  const settleStep = requireSettleStep(adapter.store);
  return [
    {
      law: 'SELF_IMAGE_IDEMPOTENCE',
      name: `[${adapter.storeName}] settle_step: predicate(S', d) is ok-shaped after predicate(S, d) applied — re-applying the SAME delta NOOPs`,
      run: async () => {
        const def = minimalDefinition(['a']);
        const { run, token } = await createClaimed(adapter.store, def, 'a');
        const delta: SettlementDelta = {
          kind: 'settle_step',
          step: 'a',
          outcome: 'complete',
          claimToken: token,
          evidence: [makeEvidence('a')],
        };
        const first = await settleStep(run.id, delta, def);
        assertApplied(first, 'first apply');
        const second = await settleStep(run.id, delta, def);
        if (second.applied)
          throw new Error('expected the re-apply to be ok-shaped NOOP, not applied:true');
      },
    },
    {
      law: 'SELF_IMAGE_IDEMPOTENCE',
      name: `[${adapter.storeName}] lease_finalizer: predicate(S', d) is ok-shaped after predicate(S, d) applied — re-leasing with the SAME token NOOPs`,
      run: async () => {
        const def = withFinalizer(minimalDefinition(['a']), 'fin', 'always');
        const { run, token } = await createClaimed(adapter.store, def, 'a');
        const settled = await settleStep(
          run.id,
          {
            kind: 'settle_step',
            step: 'a',
            outcome: 'complete',
            claimToken: token,
            evidence: [makeEvidence('a')],
          },
          def,
        );
        assertApplied(settled, 'setup settle');
        const leaseToken = uid('lease');
        const delta: SettlementDelta = {
          kind: 'lease_finalizer',
          finalizer: 'fin',
          leaseToken,
          leaseSeconds: 60,
        };
        const first = await settleStep(run.id, delta, def);
        assertApplied(first, 'first lease');
        const second = await settleStep(run.id, delta, def);
        if (second.applied)
          throw new Error('expected the re-lease to be ok-shaped NOOP, not applied:true');
      },
    },
    {
      law: 'SELF_IMAGE_IDEMPOTENCE',
      name: `[${adapter.storeName}] mark_finalizer: predicate(S', d) is ok-shaped after predicate(S, d) applied — re-marking with the SAME token+result NOOPs`,
      run: async () => {
        const def = withFinalizer(minimalDefinition(['a']), 'fin', 'always');
        const { run, token } = await createClaimed(adapter.store, def, 'a');
        const settled = await settleStep(
          run.id,
          {
            kind: 'settle_step',
            step: 'a',
            outcome: 'complete',
            claimToken: token,
            evidence: [makeEvidence('a')],
          },
          def,
        );
        assertApplied(settled, 'setup settle');
        const leaseToken = uid('lease');
        const leased = await settleStep(
          run.id,
          { kind: 'lease_finalizer', finalizer: 'fin', leaseToken, leaseSeconds: 60 },
          def,
        );
        assertApplied(leased, 'setup lease');
        const delta: SettlementDelta = {
          kind: 'mark_finalizer',
          finalizer: 'fin',
          leaseToken,
          result: 'completed',
          evidence: makeEvidence('fin'),
        };
        const first = await settleStep(run.id, delta, def);
        assertApplied(first, 'first mark');
        const second = await settleStep(run.id, delta, def);
        if (second.applied)
          throw new Error('expected the re-mark to be ok-shaped NOOP, not applied:true');
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// COMPLETE_SEAL_PHASE + WHEN_ROUTED_TERMINALIZATION (hand-authored transform pins, non-circular)
// ---------------------------------------------------------------------------

function completeSealPhaseCases(_adapter: SettlementContractAdapter): SettlementContractCase[] {
  return [
    {
      law: 'COMPLETE_SEAL_PHASE',
      name: "a complete-terminal edge sets run_phase 'completed' AND terminal_reason 'Workflow completed.' together (hand-authored, non-circular)",
      run: async () => {
        const def = minimalDefinition(['a']);
        const fresh: RunRecord = {
          id: 'tck-complete-seal-phase',
          workflow_id: def.id,
          workflow_version: 1,
          completed_steps: [],
          in_progress_steps: ['a'],
          failed_steps: [],
          skipped_steps: [],
          run_phase: 'running',
          version: 0,
          params: {},
          evidence: [],
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
          terminal_state: false,
          claims: { a: { deadline: null, token: 'tck-token' } },
        };
        const result = applySettlement(
          fresh,
          {
            kind: 'settle_step',
            step: 'a',
            outcome: 'complete',
            claimToken: 'tck-token',
            evidence: [makeEvidence('a')],
          },
          def,
          { now: new Date('2026-01-01T00:00:00.000Z') },
        );
        if (!result.applied) throw new Error(`expected applied:true, got: ${result.reason}`);
        if (
          result.run.run_phase !== 'completed' ||
          result.run.terminal_reason !== 'Workflow completed.'
        ) {
          throw new Error(
            `expected run_phase:'completed' + terminal_reason:'Workflow completed.', got run_phase:'${result.run.run_phase}' terminal_reason:'${result.run.terminal_reason}'`,
          );
        }
      },
    },
  ];
}

function whenRoutedTerminalizationCases(
  _adapter: SettlementContractAdapter,
): SettlementContractCase[] {
  return [
    {
      law: 'WHEN_ROUTED_TERMINALIZATION',
      name: 'the safety-net-disjunct-only case (isWorkflowComplete false, but in_progress empty + zero eligible steps/guards) terminalizes and mints (hand-authored, non-circular)',
      run: async () => {
        // 'b' is permanently skipped by an unsatisfiable when-clause against 'a's own output —
        // isWorkflowComplete is FALSE at the settle-of-'a' instant (propagateSkips runs INSIDE
        // the same apply and marks 'b' skipped only as a RESULT of this very settle), so the
        // safety-net second disjunct (in_progress empty + zero eligible steps/guards) is what
        // fires terminalization here, not the first disjunct evaluated against the PRE-apply state.
        const def: WorkflowDefinition = {
          id: uid('when-routed-wf'),
          name: 'When-routed TCK fixture',
          version: 1,
          steps: {
            a: { description: 'a', execution: 'agent', depends_on: [] },
            b: {
              description: 'b',
              execution: 'agent',
              depends_on: ['a'],
              when: ["evidence.a.output.category == 'never-matches'"],
            },
          },
        };
        const fresh: RunRecord = {
          id: 'tck-when-routed',
          workflow_id: def.id,
          workflow_version: 1,
          completed_steps: [],
          in_progress_steps: ['a'],
          failed_steps: [],
          skipped_steps: [],
          run_phase: 'running',
          version: 0,
          params: {},
          evidence: [],
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
          terminal_state: false,
          claims: { a: { deadline: null, token: 'tck-token' } },
        };
        const result = applySettlement(
          fresh,
          {
            kind: 'settle_step',
            step: 'a',
            outcome: 'complete',
            claimToken: 'tck-token',
            evidence: [makeEvidence('a', { output_summary: { category: 'something-else' } })],
          },
          def,
          { now: new Date('2026-01-01T00:00:00.000Z') },
        );
        if (!result.applied) throw new Error(`expected applied:true, got: ${result.reason}`);
        if (!result.run.skipped_steps.includes('b')) {
          throw new Error(
            "fixture premise violated: 'b' must be propagated-skipped by its own when-clause",
          );
        }
        if (!result.transitioned || result.run.terminal_state !== true) {
          throw new Error('expected the safety-net disjunct to terminalize the run');
        }
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// G-1 transform pin (sibling settle under an open LEGACY gate ⇒ transitioned:false)
// ---------------------------------------------------------------------------

function g1GateCoexistenceCases(_adapter: SettlementContractAdapter): SettlementContractCase[] {
  return [
    {
      law: 'G1_GATE_COEXISTENCE',
      name: 'settling a sibling step while a LEGACY gate is open on another step never transitions the run — the gate step itself keeps in_progress non-empty (hand-authored, non-circular)',
      run: async () => {
        const def: WorkflowDefinition = {
          id: uid('g1-wf'),
          name: 'G-1 TCK fixture',
          version: 1,
          steps: {
            gated: { description: 'g', execution: 'agent', depends_on: [] },
            sibling: { description: 's', execution: 'agent', depends_on: [] },
          },
        };
        const fresh: RunRecord = {
          id: 'tck-g1',
          workflow_id: def.id,
          workflow_version: 1,
          completed_steps: [],
          in_progress_steps: ['gated', 'sibling'],
          failed_steps: [],
          skipped_steps: [],
          run_phase: 'gate_waiting',
          version: 0,
          params: {},
          evidence: [],
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
          terminal_state: false,
          claims: { sibling: { deadline: null, token: 'tck-token' } },
          pending_gate: {
            gate_id: 'tck-gate',
            step_name: 'gated',
            preview: {},
            choices: ['approve'],
            opened_at: '2026-01-01T00:00:00.000Z',
          },
        };
        const result = applySettlement(
          fresh,
          {
            kind: 'settle_step',
            step: 'sibling',
            outcome: 'complete',
            claimToken: 'tck-token',
            evidence: [makeEvidence('sibling')],
          },
          def,
          { now: new Date('2026-01-01T00:00:00.000Z') },
        );
        if (!result.applied) throw new Error(`expected applied:true, got: ${result.reason}`);
        if (result.transitioned !== false || result.run.terminal_state !== false) {
          throw new Error(
            'expected transitioned:false — the open gate step keeps in_progress non-empty',
          );
        }
        if (result.run.pending_gate === undefined) {
          throw new Error('the legacy open gate must survive a sibling settle untouched');
        }
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// GATE_OPEN_IDEMPOTENT (issue #279, increment 2, PR-C — design record §8)
// ---------------------------------------------------------------------------

function gateOpenIdempotentCases(adapter: SettlementContractAdapter): SettlementContractCase[] {
  const fixture = adapter.settlementFixture!;
  const { minimalDefinition } = fixture;
  const settleStep = requireSettleStep(adapter.store);
  return [
    {
      law: 'GATE_OPEN_IDEMPOTENT',
      name: `[${adapter.storeName}] an exact-delta open_gate replay NOOPs as already_settled — version unchanged`,
      run: async () => {
        const def = minimalDefinition(['gated']);
        const { run, token } = await createClaimed(adapter.store, def, 'gated');
        const gate = makePendingGate('gated');
        const delta: SettlementDelta = {
          kind: 'open_gate',
          step: 'gated',
          claimToken: token,
          pendingGate: gate,
          evidence: [],
        };
        const first = await settleStep(run.id, delta, def);
        assertApplied(first, 'first open_gate');
        const second = await settleStep(run.id, delta, def);
        assertRefused(second, 'already_settled', 'exact-delta open_gate replay');
        if (second.run.version !== first.run.version) {
          throw new Error(
            `expected version unchanged on a NOOP (${first.run.version}), got ${second.run.version}`,
          );
        }
      },
    },
    {
      law: 'GATE_OPEN_IDEMPOTENT',
      name: `[${adapter.storeName}] a re-submitted open_gate AFTER the step ALSO settled via a totally different route (settle_step complete) refuses already_settled_by_other`,
      run: async () => {
        const def = minimalDefinition(['a']);
        const { run, token } = await createClaimed(adapter.store, def, 'a');
        const completed = await settleStep(
          run.id,
          {
            kind: 'settle_step',
            step: 'a',
            outcome: 'complete',
            claimToken: token,
            evidence: [makeEvidence('a')],
          },
          def,
        );
        assertApplied(completed, 'settle_step complete');
        const result = await settleStep(
          run.id,
          {
            kind: 'open_gate',
            step: 'a',
            claimToken: token,
            pendingGate: makePendingGate('a'),
            evidence: [],
          },
          def,
        );
        assertRefused(
          result,
          'already_settled_by_other',
          'open_gate on a step already settled via a different route',
        );
      },
    },
    {
      law: 'GATE_OPEN_IDEMPOTENT',
      name: `[${adapter.storeName}] a re-submitted open_gate AFTER the gate already resolved (BU F6) NOOPs as already_settled`,
      run: async () => {
        const def = minimalDefinition(['gated']);
        const { run, token } = await createClaimed(adapter.store, def, 'gated');
        const gate = makePendingGate('gated');
        const openDelta: SettlementDelta = {
          kind: 'open_gate',
          step: 'gated',
          claimToken: token,
          pendingGate: gate,
          evidence: [],
        };
        const opened = await settleStep(run.id, openDelta, def);
        assertApplied(opened, 'open_gate');
        const resolved = await settleStep(
          run.id,
          { kind: 'settle_gate', gateId: gate.gate_id, choice: 'approve', evidence: [] },
          def,
        );
        assertApplied(resolved, 'settle_gate resolve');
        // A delayed/retried open_gate for the SAME gate_id, arriving after resolution.
        const replay = await settleStep(run.id, openDelta, def);
        assertRefused(replay, 'already_settled', 'open_gate replay after resolution');
      },
    },
    {
      law: 'GATE_OPEN_IDEMPOTENT',
      name: `[${adapter.storeName}] fence-checked already_open: a matching claimant re-opening a DIFFERENT gate_id on the SAME step gets the LIVE gate back verbatim (defensive — in-contract unreachable)`,
      run: async () => {
        const def = minimalDefinition(['gated']);
        const { run, token } = await createClaimed(adapter.store, def, 'gated');
        const liveGate = makePendingGate('gated', { gateId: 'live-gate' });
        const opened = await settleStep(
          run.id,
          {
            kind: 'open_gate',
            step: 'gated',
            claimToken: token,
            pendingGate: liveGate,
            evidence: [],
          },
          def,
        );
        assertApplied(opened, 'open_gate (live)');
        const other = makePendingGate('gated', { gateId: 'other-gate' });
        const result = await settleStep(
          run.id,
          { kind: 'open_gate', step: 'gated', claimToken: token, pendingGate: other, evidence: [] },
          def,
        );
        assertRefused(result, 'already_open', 'same-claimant re-open with a different gate_id');
        if (result.gate?.gate_id !== 'live-gate') {
          throw new Error(
            `already_open must return the LIVE gate verbatim, got: ${JSON.stringify(result.gate)}`,
          );
        }
      },
    },
    {
      law: 'GATE_OPEN_IDEMPOTENT',
      name: `[${adapter.storeName}] a successor gate-open attempt on a DIFFERENT step while a gate is open elsewhere refuses gate_mismatch, and the target step STAYS claimed (L13)`,
      run: async () => {
        const def = minimalDefinition(['gated', 'successor']);
        const { run, token: gatedToken } = await createClaimed(adapter.store, def, 'gated');
        const gate = makePendingGate('gated');
        const opened = await settleStep(
          run.id,
          {
            kind: 'open_gate',
            step: 'gated',
            claimToken: gatedToken,
            pendingGate: gate,
            evidence: [],
          },
          def,
        );
        assertApplied(opened, 'open_gate on gated');
        // 'successor' can never be claimed while a gate is open (findEligibleSteps returns []),
        // so this hand-constructs the claim to isolate the ARM being tested (open_gate's OWN
        // serialization refusal), matching the fixture-mechanics precedent set by
        // g1GateCoexistenceCases above.
        const seeded = await adapter.store.update({
          ...opened.run,
          in_progress_steps: [...opened.run.in_progress_steps, 'successor'],
          claims: { ...opened.run.claims, successor: { deadline: null, token: 'successor-token' } },
        });
        const result = await settleStep(
          seeded.id,
          {
            kind: 'open_gate',
            step: 'successor',
            claimToken: 'successor-token',
            pendingGate: makePendingGate('successor'),
            evidence: [],
          },
          def,
        );
        assertRefused(result, 'gate_mismatch', 'open_gate on another step while a gate is open');
        if (!result.run.in_progress_steps.includes('successor')) {
          throw new Error('gate_mismatch must leave the target step STILL claimed (L13)');
        }
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// GATE_RESOLUTION_CONFLICT (issue #279, increment 2, PR-C)
// ---------------------------------------------------------------------------

function gateResolutionConflictCases(adapter: SettlementContractAdapter): SettlementContractCase[] {
  const { minimalDefinition } = adapter.settlementFixture!;
  const settleStep = requireSettleStep(adapter.store);

  async function openGate(
    def: WorkflowDefinition,
    stepName: string,
  ): Promise<{ runId: string; gate: PendingGate }> {
    const { run, token } = await createClaimed(adapter.store, def, stepName);
    const gate = makePendingGate(stepName);
    const opened = await settleStep(
      run.id,
      { kind: 'open_gate', step: stepName, claimToken: token, pendingGate: gate, evidence: [] },
      def,
    );
    assertApplied(opened, `open_gate on ${stepName}`);
    return { runId: run.id, gate };
  }

  return [
    {
      law: 'GATE_RESOLUTION_CONFLICT',
      name: `[${adapter.storeName}] a same-choice settle_gate retry (double-submit) NOOPs as already_settled`,
      run: async () => {
        const def = minimalDefinition(['gated']);
        const { runId, gate } = await openGate(def, 'gated');
        const delta: SettlementDelta = {
          kind: 'settle_gate',
          gateId: gate.gate_id,
          choice: 'approve',
          evidence: [],
        };
        const first = await settleStep(runId, delta, def);
        assertApplied(first, 'first settle_gate');
        const second = await settleStep(runId, delta, def);
        assertRefused(second, 'already_settled', 'same-choice settle_gate retry');
      },
    },
    {
      law: 'GATE_RESOLUTION_CONFLICT',
      name: `[${adapter.storeName}] a choice NOT among the gate's own choices refuses choice_not_eligible, gate stays open`,
      run: async () => {
        const def = minimalDefinition(['gated']);
        const { runId, gate } = await openGate(def, 'gated');
        const result = await settleStep(
          runId,
          { kind: 'settle_gate', gateId: gate.gate_id, choice: 'not-a-real-choice', evidence: [] },
          def,
        );
        assertRefused(result, 'choice_not_eligible', 'settle_gate with an ineligible choice');
        if (result.choices?.join(',') !== gate.choices.join(',')) {
          throw new Error(
            `expected choices:${JSON.stringify(gate.choices)}, got: ${JSON.stringify(result.choices)}`,
          );
        }
        if (result.run.pending_gate?.gate_id !== gate.gate_id) {
          throw new Error('choice_not_eligible must leave the gate open, unchanged');
        }
      },
    },
    {
      law: 'GATE_RESOLUTION_CONFLICT',
      name: `[${adapter.storeName}] a DIFFERENT-choice settle_gate after resolution refuses gate_choice_conflict with the winning choice`,
      run: async () => {
        const def = minimalDefinition(['gated']);
        const { runId, gate } = await openGate(def, 'gated');
        const first = await settleStep(
          runId,
          { kind: 'settle_gate', gateId: gate.gate_id, choice: 'approve', evidence: [] },
          def,
        );
        assertApplied(first, 'first settle_gate (approve)');
        const second = await settleStep(
          runId,
          { kind: 'settle_gate', gateId: gate.gate_id, choice: 'reject', evidence: [] },
          def,
        );
        assertRefused(second, 'gate_choice_conflict', 'conflicting-choice settle_gate');
        if (second.winningChoice !== 'approve') {
          throw new Error(`expected winningChoice:'approve', got: ${second.winningChoice}`);
        }
      },
    },
    {
      law: 'GATE_RESOLUTION_CONFLICT',
      name: `[${adapter.storeName}] a delayed retry of an ALREADY-RESOLVED gate's choice still NOOPs, even after a SECOND gate has since opened on another step (TD F1 — lookup is by gateId alone)`,
      run: async () => {
        const def = minimalDefinition(['gate1', 'gate2']);
        const { runId, gate: gate1 } = await openGate(def, 'gate1');
        const resolve1: SettlementDelta = {
          kind: 'settle_gate',
          gateId: gate1.gate_id,
          choice: 'approve',
          evidence: [],
        };
        const first = await settleStep(runId, resolve1, def);
        assertApplied(first, 'resolve gate1');

        // A second, unrelated gate opens on a different step.
        const { token: gate2Token } = { token: 'gate2-token' } as { token: string };
        const seeded = await adapter.store.update({
          ...first.run,
          in_progress_steps: [...first.run.in_progress_steps, 'gate2'],
          claims: { ...first.run.claims, gate2: { deadline: null, token: gate2Token } },
        });
        const gate2 = makePendingGate('gate2');
        const opened2 = await settleStep(
          seeded.id,
          {
            kind: 'open_gate',
            step: 'gate2',
            claimToken: gate2Token,
            pendingGate: gate2,
            evidence: [],
          },
          def,
        );
        assertApplied(opened2, 'open_gate on gate2');

        // The delayed retry of gate1's ORIGINAL resolution — found by gateId lookup regardless
        // of what is currently open.
        const delayedRetry = await settleStep(runId, resolve1, def);
        assertRefused(delayedRetry, 'already_settled', 'delayed retry of gate1 resolution');
      },
    },
    {
      law: 'GATE_RESOLUTION_CONFLICT',
      name: `[${adapter.storeName}] G2 corruption fixture: a hand-shaped record where BOTH a settled 'gate' entry and a live pending_gate share the same gate_id ⇒ the lookup-first NOOP wins, never a RESOLVE (fail-safe, lens-2 m3)`,
      run: async () => {
        const def = minimalDefinition(['gated']);
        const { run } = await adapter.store.create({
          workflowId: def.id,
          workflowVersion: def.version,
          params: {},
        });
        const gateId = 'corrupt-gate';
        // Hand-shaped: an entry ALREADY records this gate as resolved with choice 'approve', but
        // pending_gate is STILL live with the SAME gate_id — never producible by settleStep
        // itself (APPLY always clears pending_gate in the SAME write it settles); only a
        // hand-authored fixture or an external store's divergent history can produce this.
        const corrupted = await adapter.store.update({
          ...run,
          completed_steps: ['gated'],
          settled: { gated: { token: gateId, outcome: 'gate', choice: 'approve' } },
          pending_gate: {
            gate_id: gateId,
            step_name: 'gated',
            preview: {},
            choices: ['approve', 'reject'],
            opened_at: '2026-01-01T00:00:00.000Z',
          },
        });
        const result = await settleStep(
          corrupted.id,
          { kind: 'settle_gate', gateId, choice: 'approve', evidence: [] },
          def,
        );
        // The lookup-first ordering means this is ALWAYS a NOOP against the settled entry — the
        // live-gate RESOLVE branch is structurally unreachable once a matching settled entry
        // exists, regardless of corruption.
        assertRefused(result, 'already_settled', 'G2-corrupted both-match record');
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// GATE_MISMATCH (issue #279, increment 2, PR-C)
// ---------------------------------------------------------------------------

function gateMismatchCases(adapter: SettlementContractAdapter): SettlementContractCase[] {
  const { minimalDefinition } = adapter.settlementFixture!;
  const settleStep = requireSettleStep(adapter.store);
  return [
    {
      law: 'GATE_MISMATCH',
      name: `[${adapter.storeName}] settle_gate with an UNKNOWN gateId on a live, gate-free run refuses gate_mismatch`,
      run: async () => {
        const def = minimalDefinition(['a']);
        const { run } = await adapter.store.create({
          workflowId: def.id,
          workflowVersion: def.version,
          params: {},
        });
        const result = await settleStep(
          run.id,
          { kind: 'settle_gate', gateId: 'nonexistent-gate', choice: 'approve', evidence: [] },
          def,
        );
        assertRefused(result, 'gate_mismatch', 'settle_gate with an unknown gateId');
      },
    },
    {
      law: 'GATE_MISMATCH',
      name: `[${adapter.storeName}] settle_gate with a SUPERSEDED gateId (a DIFFERENT gate is now open) refuses gate_mismatch`,
      run: async () => {
        const def = minimalDefinition(['a']);
        const { run, token } = await createClaimed(adapter.store, def, 'a');
        const liveGate = makePendingGate('a', { gateId: 'live-gate' });
        const opened = await settleStep(
          run.id,
          { kind: 'open_gate', step: 'a', claimToken: token, pendingGate: liveGate, evidence: [] },
          def,
        );
        assertApplied(opened, 'open_gate');
        const result = await settleStep(
          run.id,
          { kind: 'settle_gate', gateId: 'stale-superseded-gate', choice: 'approve', evidence: [] },
          def,
        );
        assertRefused(result, 'gate_mismatch', 'settle_gate with a superseded gateId');
      },
    },
    {
      law: 'GATE_MISMATCH',
      name: `[${adapter.storeName}] zombie submit: a hand-shaped terminal ∧ pending_gate record refuses run_terminal on a matching gateId submit, record/version UNCHANGED`,
      run: async () => {
        const def = minimalDefinition(['a']);
        const { run } = await adapter.store.create({
          workflowId: def.id,
          workflowVersion: def.version,
          params: {},
        });
        const gateId = 'zombie-gate';
        // Hand-shaped grandfathered/#282-class record: terminal AND still carrying a pending_gate
        // — the exact class D-3 exists to close on the RENDER side; this pins the TRANSFORM's own
        // zombie-submit refusal independent of that closure.
        const zombie = await adapter.store.update({
          ...run,
          completed_steps: ['a'],
          terminal_state: true,
          // issue #367: a terminal record names its arm. These fixtures mean "this run is over";
          // their opaque `tck` prose is deliberately unclassifiable, so the boundary's coherence
          // check abstains and the fixture stays a pure terminal-precondition seeder.
          sealed_by: { arm: 'complete' as const },
          terminal_reason: 'Workflow completed.',
          pending_gate: {
            gate_id: gateId,
            step_name: 'a',
            preview: {},
            choices: ['approve', 'reject'],
            opened_at: '2026-01-01T00:00:00.000Z',
          },
        });
        const result = await settleStep(
          zombie.id,
          { kind: 'settle_gate', gateId, choice: 'approve', evidence: [] },
          def,
        );
        assertRefused(result, 'run_terminal', 'zombie gate submit on a terminal record');
        if (result.run.version !== zombie.version) {
          throw new Error('a zombie-submit refusal must leave the record/version UNCHANGED');
        }
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// GUARD_OUTCOME_DIVERGENCE / GUARD_WAITS_ON_OPEN_GATE / GUARD_PASS_COMPLETE_OUTCOME /
// GUARD_ABORT_CASCADE / GUARD_NO_ENTRY (issue #279, increment 2, PR-C)
// ---------------------------------------------------------------------------

function guardCases(adapter: SettlementContractAdapter): SettlementContractCase[] {
  const fixture = adapter.settlementFixture!;
  if (fixture.withGuard === undefined) {
    return [
      {
        law: 'ADAPTER_WIRING',
        name: `[${adapter.storeName}] declares RunStore.settleStep but the supplied settlementFixture has no withGuard — guard-law coverage is a WIRING GAP, not a vacuous pass`,
        run: async () => {
          throw new Error(
            `[${adapter.storeName}] settlementContract: adapter.settlementFixture.withGuard is ` +
              "undefined — pass 'defaultSettlementFixture' (or a store-specific fixture " +
              'implementing withGuard) to exercise guard conformance coverage.',
          );
        },
      },
    ];
  }
  const { minimalDefinition } = fixture;
  const withGuard = fixture.withGuard;
  const settleStep = requireSettleStep(adapter.store);

  return [
    // --- GUARD_OUTCOME_DIVERGENCE ---
    {
      law: 'GUARD_OUTCOME_DIVERGENCE',
      name: `[${adapter.storeName}] a same-outcome (pass) settle_guard retry NOOPs as already_settled`,
      run: async () => {
        const def = withGuard(minimalDefinition([]), 'g', []);
        const { run } = await adapter.store.create({
          workflowId: def.id,
          workflowVersion: def.version,
          params: {},
        });
        const delta: SettlementDelta = {
          kind: 'settle_guard',
          step: 'g',
          outcome: 'pass',
          evidence: makeEvidence('g'),
        };
        const first = await settleStep(run.id, delta, def);
        assertApplied(first, 'first settle_guard pass');
        const second = await settleStep(run.id, delta, def);
        assertRefused(second, 'already_settled', 'same-outcome settle_guard retry');
      },
    },
    {
      law: 'GUARD_OUTCOME_DIVERGENCE',
      name: `[${adapter.storeName}] a CROSS-outcome settle_guard retry (pass, then resolution_error) refuses settled_outcome_divergence`,
      run: async () => {
        const def = withGuard(minimalDefinition([]), 'g', []);
        const { run } = await adapter.store.create({
          workflowId: def.id,
          workflowVersion: def.version,
          params: {},
        });
        const first = await settleStep(
          run.id,
          { kind: 'settle_guard', step: 'g', outcome: 'pass', evidence: makeEvidence('g') },
          def,
        );
        assertApplied(first, 'first settle_guard pass');
        const second = await settleStep(
          run.id,
          {
            kind: 'settle_guard',
            step: 'g',
            outcome: 'resolution_error',
            evidence: makeEvidence('g'),
            resolutionError: { condition: 'x > 1', unresolvable_path: 'x' },
          },
          def,
        );
        assertRefused(second, 'settled_outcome_divergence', 'cross-outcome settle_guard retry');
      },
    },
    {
      law: 'GUARD_OUTCOME_DIVERGENCE',
      name: `[${adapter.storeName}] an abort settle_guard retry against a step skipped for a DIFFERENT reason (not guard_abort) refuses settled_outcome_divergence — the skip_details conjunct`,
      run: async () => {
        // 'g' skipped via an unsatisfiable trigger_rule (its own dep 'never' fails), never via a
        // guard_abort — a settle_guard abort retry for 'g' must diverge, not converge.
        const def: WorkflowDefinition = {
          id: uid('guard-divergence-wf'),
          name: 'Guard divergence TCK fixture',
          version: 1,
          steps: {
            never: { description: 'n', execution: 'agent', depends_on: [] },
            g: {
              description: 'g',
              execution: 'guard',
              abort_unless: [],
              depends_on: ['never'],
              trigger_rule: 'all_failed',
            },
          },
        };
        const { run } = await adapter.store.create({
          workflowId: def.id,
          workflowVersion: def.version,
          params: {},
        });
        const seeded = await adapter.store.update({ ...run, skipped_steps: ['never'] });
        // propagateSkips (run via any settle_step on 'never'-adjacent... simpler: hand-seed 'g'
        // as skipped via trigger_rule_unsatisfiable directly, matching what propagateSkips itself
        // would produce.
        const skipped = await adapter.store.update({
          ...seeded,
          skipped_steps: ['never', 'g'],
          skip_details: {
            g: { kind: 'trigger_rule_unsatisfiable', rule: 'all_failed', blocking_deps: [] },
          },
        });
        const result = await settleStep(
          skipped.id,
          {
            kind: 'settle_guard',
            step: 'g',
            outcome: 'abort',
            evidence: makeEvidence('g'),
            abort: { conditions: [] },
          },
          def,
        );
        assertRefused(
          result,
          'settled_outcome_divergence',
          'abort settle_guard vs non-guard_abort skip',
        );
        if (result.persisted !== 'skip-non-abort') {
          throw new Error(`expected persisted:'skip-non-abort', got: ${result.persisted}`);
        }
      },
    },
    {
      law: 'GUARD_OUTCOME_DIVERGENCE',
      name: `[${adapter.storeName}] a terminalizing guard's own retry (same outcome, already terminal) still converges as already_settled`,
      run: async () => {
        const def = withGuard(minimalDefinition([]), 'g', ['1 == 2']); // always fails ⇒ abort
        const { run } = await adapter.store.create({
          workflowId: def.id,
          workflowVersion: def.version,
          params: {},
        });
        const delta: SettlementDelta = {
          kind: 'settle_guard',
          step: 'g',
          outcome: 'abort',
          evidence: makeEvidence('g'),
          abort: { conditions: [{ condition: '1 == 2', resolved_value: false, passed: false }] },
        };
        const first = await settleStep(run.id, delta, def);
        assertApplied(first, 'first settle_guard abort');
        if (first.run.terminal_state !== true) {
          throw new Error('fixture premise violated: abort must terminalize');
        }
        const second = await settleStep(run.id, delta, def);
        assertRefused(second, 'already_settled', 'terminalizing guard retry');
      },
    },

    // --- GUARD_WAITS_ON_OPEN_GATE ---
    {
      law: 'GUARD_WAITS_ON_OPEN_GATE',
      name: `[${adapter.storeName}] a non-pass settle_guard under an open gate refuses gate_open_wait, record UNCHANGED`,
      run: async () => {
        let def = minimalDefinition(['gated']);
        def = withGuard(def, 'g', ['1 == 2']);
        const { run, token } = await createClaimed(adapter.store, def, 'gated');
        const gate = makePendingGate('gated');
        const opened = await settleStep(
          run.id,
          { kind: 'open_gate', step: 'gated', claimToken: token, pendingGate: gate, evidence: [] },
          def,
        );
        assertApplied(opened, 'open_gate');
        const result = await settleStep(
          run.id,
          {
            kind: 'settle_guard',
            step: 'g',
            outcome: 'abort',
            evidence: makeEvidence('g'),
            abort: { conditions: [{ condition: '1 == 2', resolved_value: false, passed: false }] },
          },
          def,
        );
        assertRefused(result, 'gate_open_wait', 'non-pass settle_guard under an open gate');
        if (result.run.version !== opened.run.version) {
          throw new Error('gate_open_wait must leave the record UNCHANGED (quiet end-of-pass)');
        }
      },
    },
    {
      law: 'GUARD_WAITS_ON_OPEN_GATE',
      name: `[${adapter.storeName}] re-applying the SAME guard after the gate resolves now APPLIES`,
      run: async () => {
        let def = minimalDefinition(['gated']);
        def = withGuard(def, 'g', ['1 == 2']);
        const { run, token } = await createClaimed(adapter.store, def, 'gated');
        const gate = makePendingGate('gated');
        const opened = await settleStep(
          run.id,
          { kind: 'open_gate', step: 'gated', claimToken: token, pendingGate: gate, evidence: [] },
          def,
        );
        assertApplied(opened, 'open_gate');
        const guardDelta: SettlementDelta = {
          kind: 'settle_guard',
          step: 'g',
          outcome: 'abort',
          evidence: makeEvidence('g'),
          abort: { conditions: [{ condition: '1 == 2', resolved_value: false, passed: false }] },
        };
        const waited = await settleStep(run.id, guardDelta, def);
        assertRefused(waited, 'gate_open_wait', 'first attempt, gate open');
        const resolved = await settleStep(
          run.id,
          { kind: 'settle_gate', gateId: gate.gate_id, choice: 'approve', evidence: [] },
          def,
        );
        assertApplied(resolved, 'settle_gate resolve');
        const retried = await settleStep(run.id, guardDelta, def);
        assertApplied(retried, 'settle_guard retry, gate resolved');
      },
    },
    {
      law: 'GUARD_WAITS_ON_OPEN_GATE',
      name: `[${adapter.storeName}] a PASS settle_guard under an open gate APPLIES (non-terminal — the gate wins on any terminalizing attempt, but pass alone never terminalizes under it, G-1)`,
      run: async () => {
        let def = minimalDefinition(['gated']);
        def = withGuard(def, 'g', []); // trivially passes (zero conditions)
        const { run, token } = await createClaimed(adapter.store, def, 'gated');
        const gate = makePendingGate('gated');
        const opened = await settleStep(
          run.id,
          { kind: 'open_gate', step: 'gated', claimToken: token, pendingGate: gate, evidence: [] },
          def,
        );
        assertApplied(opened, 'open_gate');
        const result = await settleStep(
          run.id,
          { kind: 'settle_guard', step: 'g', outcome: 'pass', evidence: makeEvidence('g') },
          def,
        );
        assertApplied(result, 'pass settle_guard under an open gate');
        if (result.transitioned !== false) {
          throw new Error('a pass-under-gate settle_guard must never terminalize (G-1)');
        }
      },
    },

    // --- GUARD_PASS_COMPLETE_OUTCOME ---
    {
      law: 'GUARD_PASS_COMPLETE_OUTCOME',
      name: `[${adapter.storeName}] a guard pass that completes the run sets terminal_reason 'Workflow completed.' and phase 'completed'`,
      run: async () => {
        const def = withGuard(minimalDefinition([]), 'g', []);
        const { run } = await adapter.store.create({
          workflowId: def.id,
          workflowVersion: def.version,
          params: {},
        });
        const result = await settleStep(
          run.id,
          { kind: 'settle_guard', step: 'g', outcome: 'pass', evidence: makeEvidence('g') },
          def,
        );
        assertApplied(result, 'guard pass, sole step');
        if (
          result.run.terminal_state !== true ||
          result.run.terminal_reason !== 'Workflow completed.' ||
          result.run.run_phase !== 'completed'
        ) {
          throw new Error(
            `expected terminal 'completed' seal, got terminal_state:${result.run.terminal_state} ` +
              `terminal_reason:${result.run.terminal_reason} run_phase:${result.run.run_phase}`,
          );
        }
      },
    },

    // --- GUARD_ABORT_CASCADE ---
    {
      law: 'GUARD_ABORT_CASCADE',
      name: `[${adapter.storeName}] a guard abort skips the guard (object-array aborted_at, terminal_reason ABSENT) AND cascades propagateSkips onto a dependent step`,
      run: async () => {
        let def = minimalDefinition([]);
        def = withGuard(def, 'g', ['1 == 2'], { dependents: ['downstream'] });
        const { run } = await adapter.store.create({
          workflowId: def.id,
          workflowVersion: def.version,
          params: {},
        });
        const conditions = [{ condition: '1 == 2', resolved_value: false, passed: false }];
        const result = await settleStep(
          run.id,
          {
            kind: 'settle_guard',
            step: 'g',
            outcome: 'abort',
            evidence: makeEvidence('g'),
            abort: { conditions, abort_message: 'tck guard abort' },
          },
          def,
        );
        assertApplied(result, 'guard abort');
        if (!result.run.skipped_steps.includes('g')) {
          throw new Error('the guard itself must land in skipped_steps');
        }
        if (result.run.skip_details?.['g']?.kind !== 'guard_abort') {
          throw new Error('skip_details for the guard must carry kind:guard_abort');
        }
        if (!result.run.skipped_steps.includes('downstream')) {
          throw new Error('propagateSkips must cascade onto the dependent step');
        }
        if (
          result.run.aborted_at === undefined ||
          result.run.aborted_at.step_id !== 'g' ||
          !Array.isArray(result.run.aborted_at.conditions) ||
          result.run.aborted_at.conditions[0]?.condition !== '1 == 2'
        ) {
          throw new Error(
            `expected aborted_at with the object-array conditions shape, got: ${JSON.stringify(result.run.aborted_at)}`,
          );
        }
        if (result.run.terminal_reason !== undefined) {
          throw new Error(
            `terminal_reason must be ABSENT on a guard-abort seal (phase derives from aborted_at), got: '${result.run.terminal_reason}'`,
          );
        }
        if (result.run.terminal_state !== true) {
          throw new Error('a guard abort must terminalize the run');
        }
      },
    },

    // --- GUARD_NO_ENTRY ---
    {
      law: 'GUARD_NO_ENTRY',
      name: `[${adapter.storeName}] settle_guard NEVER writes a settled-map entry, regardless of outcome (SE-4)`,
      run: async () => {
        const def = withGuard(minimalDefinition([]), 'g', []);
        const { run } = await adapter.store.create({
          workflowId: def.id,
          workflowVersion: def.version,
          params: {},
        });
        const result = await settleStep(
          run.id,
          { kind: 'settle_guard', step: 'g', outcome: 'pass', evidence: makeEvidence('g') },
          def,
        );
        assertApplied(result, 'guard pass');
        if (result.run.settled?.['g'] !== undefined) {
          throw new Error('settle_guard must never write a settled-map entry (SE-4)');
        }
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// RELEASE_IDEMPOTENT (issue #279, increment 2, PR-C)
// ---------------------------------------------------------------------------

function releaseIdempotentCases(adapter: SettlementContractAdapter): SettlementContractCase[] {
  const { minimalDefinition } = adapter.settlementFixture!;
  const settleStep = requireSettleStep(adapter.store);
  return [
    {
      law: 'RELEASE_IDEMPOTENT',
      name: `[${adapter.storeName}] release_step on a claim-absent step NOOPs as already_released (TD F10)`,
      run: async () => {
        const def = minimalDefinition(['a']);
        const { run } = await adapter.store.create({
          workflowId: def.id,
          workflowVersion: def.version,
          params: {},
        });
        const result = await settleStep(
          run.id,
          { kind: 'release_step', step: 'a', claimToken: 'anything' },
          def,
        );
        assertRefused(result, 'already_released', 'release_step with no claim outstanding');
      },
    },
    {
      law: 'RELEASE_IDEMPOTENT',
      name: `[${adapter.storeName}] release_step with the WRONG token refuses claim_lost — never stomps a successor`,
      run: async () => {
        const def = minimalDefinition(['a']);
        const { run } = await createClaimed(adapter.store, def, 'a');
        const result = await settleStep(
          run.id,
          { kind: 'release_step', step: 'a', claimToken: 'wrong-token' },
          def,
        );
        assertRefused(result, 'claim_lost', 'release_step with a wrong token');
      },
    },
    {
      law: 'RELEASE_IDEMPOTENT',
      name: `[${adapter.storeName}] release_step on the currently-open gate step refuses gate_mismatch (reclaim-step.ts:389 parity)`,
      run: async () => {
        const def = minimalDefinition(['gated']);
        const { run, token } = await createClaimed(adapter.store, def, 'gated');
        const gate = makePendingGate('gated');
        const opened = await settleStep(
          run.id,
          { kind: 'open_gate', step: 'gated', claimToken: token, pendingGate: gate, evidence: [] },
          def,
        );
        assertApplied(opened, 'open_gate');
        const result = await settleStep(
          run.id,
          { kind: 'release_step', step: 'gated', claimToken: token },
          def,
        );
        assertRefused(result, 'gate_mismatch', 'release_step on the open-gate step');
      },
    },
    {
      law: 'RELEASE_IDEMPOTENT',
      name: `[${adapter.storeName}] a successful release_step frees the claim (never terminal, no settled entry) — the step is eligible again`,
      run: async () => {
        const def = minimalDefinition(['a']);
        const { run, token } = await createClaimed(adapter.store, def, 'a');
        const result = await settleStep(
          run.id,
          { kind: 'release_step', step: 'a', claimToken: token },
          def,
        );
        assertApplied(result, 'release_step');
        if (result.transitioned !== false || result.run.terminal_state !== false) {
          throw new Error('release_step must never terminalize');
        }
        if (result.run.in_progress_steps.includes('a') || result.run.claims?.['a'] !== undefined) {
          throw new Error('release_step must clear both in_progress_steps and claims');
        }
        if (result.run.settled?.['a'] !== undefined) {
          throw new Error('release_step must never write a settled-map entry');
        }
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// PHASE_IS_GENERATED (issue #279, increment 2, PR-C, lane-C steal 1 — a NEW universal law: after
// EVERY store mutation op, persisted run_phase ≡ deriveRunPhase(record)).
// ---------------------------------------------------------------------------

function phaseIsGeneratedCases(adapter: SettlementContractAdapter): SettlementContractCase[] {
  const { minimalDefinition } = adapter.settlementFixture!;
  const settleStep = requireSettleStep(adapter.store);

  function assertGenerated(record: RunRecord, context: string): void {
    const expected = deriveRunPhase(record);
    if (record.run_phase !== expected) {
      throw new Error(
        `PHASE_IS_GENERATED violated at ${context}: persisted run_phase '${record.run_phase}' ` +
          `!== derived '${expected}'`,
      );
    }
  }

  return [
    {
      law: 'PHASE_IS_GENERATED',
      name: `[${adapter.storeName}] persisted run_phase ≡ deriveRunPhase(record) after settleStep (all four kinds exercised) / update / claimStep`,
      run: async () => {
        const def = minimalDefinition(['a', 'b']);
        const { run } = await adapter.store.create({
          workflowId: def.id,
          workflowVersion: def.version,
          params: {},
        });
        assertGenerated(run, 'create()');

        const claimed = await adapter.store.claimStep(run.id, 'a', def);
        assertGenerated(claimed, 'claimStep()');

        const token = claimed.claims!['a']!.token!;
        const settled = await settleStep(
          run.id,
          {
            kind: 'settle_step',
            step: 'a',
            outcome: 'complete',
            claimToken: token,
            evidence: [makeEvidence('a')],
          },
          def,
        );
        assertApplied(settled, 'settle_step complete');
        assertGenerated(settled.run, 'settleStep(settle_step)');

        const updated = await adapter.store.update({ ...settled.run });
        assertGenerated(updated, 'update()');
      },
    },
    {
      law: 'PHASE_IS_GENERATED',
      name: `[${adapter.storeName}] the claimStep leg's discriminating fixture: abandoned_at ∧ terminal_state:false ⇒ claimStep persists the DERIVED 'abandoned' phase, not a hardcoded 'running'`,
      run: async () => {
        const def = minimalDefinition(['a']);
        const { run } = await adapter.store.create({
          workflowId: def.id,
          workflowVersion: def.version,
          params: {},
        });
        // eligibility.ts's findEligibleSteps does NOT check abandoned_at (only terminal_state /
        // pending_gate) — so this hand-shaped record is still claimable, while deriveRunPhase
        // (which DOES check abandoned_at first) derives 'abandoned' for it. A store that still
        // hardcodes 'running' on claim (rather than deriving) would persist the wrong phase here.
        const seeded = await adapter.store.update({
          ...run,
          abandoned_at: '2026-01-01T00:00:00.000Z',
        });
        const claimed = await adapter.store.claimStep(seeded.id, 'a', def);
        if (claimed.run_phase !== 'abandoned') {
          throw new Error(
            `PHASE_IS_GENERATED (claimStep leg) violated: expected persisted 'abandoned', got '${claimed.run_phase}'`,
          );
        }
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// issue #302 (finalizer outcome×trigger matrix) — completed_with_failed_steps laws.
// ---------------------------------------------------------------------------

/** CWFS_FIRES_PER_ARM — mixed-complete mints the declared completed_with_failed_steps finalizer,
 *  discriminated per settlement ARM (S3): VIA settle_step, VIA settle_gate resolution, VIA
 *  settle_guard pass. Each case independently fails a step FIRST (claimed, then settled), THEN
 *  drives the arm under test as the run's LAST remaining piece — so failed_steps is non-empty at
 *  the moment that arm's own settle terminalizes the run to 'complete'. */
function cwfsFiresPerArmCases(adapter: SettlementContractAdapter): SettlementContractCase[] {
  const fixture = adapter.settlementFixture!;
  const { minimalDefinition, withFinalizer } = fixture;
  const settleStep = requireSettleStep(adapter.store);
  const cases: SettlementContractCase[] = [
    {
      law: 'CWFS_FIRES_PER_ARM',
      name: `[${adapter.storeName}] mixed-complete VIA settle_step mints the declared completed_with_failed_steps finalizer`,
      run: async () => {
        const def = withFinalizer(
          minimalDefinition(['fail_step', 'complete_step']),
          'fin',
          'completed_with_failed_steps',
        );
        const { run, token: failToken } = await createClaimed(adapter.store, def, 'fail_step');
        const claimedComplete = await adapter.store.claimStep(run.id, 'complete_step', def);
        const completeToken = claimedComplete.claims!['complete_step']!.token!;

        const failed = await settleStep(
          run.id,
          {
            kind: 'settle_step',
            step: 'fail_step',
            outcome: 'fail',
            claimToken: failToken,
            evidence: [],
            failureMessage: 'x',
          },
          def,
        );
        assertApplied(failed, 'fail fail_step');
        if (failed.run.terminal_state) {
          throw new Error(
            'fixture setup: run must NOT terminalize while complete_step is still claimed',
          );
        }

        const completed = await settleStep(
          run.id,
          {
            kind: 'settle_step',
            step: 'complete_step',
            outcome: 'complete',
            claimToken: completeToken,
            evidence: [makeEvidence('complete_step')],
          },
          def,
        );
        assertApplied(completed, 'complete complete_step (terminalizes mixed-complete)');
        if (completed.run.finalizer_ledger?.['fin']?.status !== 'pending') {
          throw new Error(
            `expected 'fin' minted pending on the settle_step-driven mixed-complete seal, got: ${JSON.stringify(completed.run.finalizer_ledger)}`,
          );
        }
      },
    },
    {
      law: 'CWFS_FIRES_PER_ARM',
      name: `[${adapter.storeName}] mixed-complete VIA settle_gate resolution mints the declared completed_with_failed_steps finalizer`,
      run: async () => {
        const def = withFinalizer(
          minimalDefinition(['fail_step', 'gated_step']),
          'fin',
          'completed_with_failed_steps',
        );
        // PR-C ordering rule: claim BOTH steps before any gate opens — once a gate is open,
        // findEligibleSteps returns [] globally, so a fresh claim for 'gated_step' after opening a
        // gate on it would be the wrong sequencing (this claims first, opens second).
        const { run, token: failToken } = await createClaimed(adapter.store, def, 'fail_step');
        const claimedGated = await adapter.store.claimStep(run.id, 'gated_step', def);
        const gatedToken = claimedGated.claims!['gated_step']!.token!;

        const failed = await settleStep(
          run.id,
          {
            kind: 'settle_step',
            step: 'fail_step',
            outcome: 'fail',
            claimToken: failToken,
            evidence: [],
            failureMessage: 'x',
          },
          def,
        );
        assertApplied(failed, 'fail fail_step');

        const gate = makePendingGate('gated_step');
        const opened = await settleStep(
          run.id,
          {
            kind: 'open_gate',
            step: 'gated_step',
            claimToken: gatedToken,
            pendingGate: gate,
            evidence: [],
          },
          def,
        );
        assertApplied(opened, 'open_gate on gated_step');
        if (opened.run.terminal_state) {
          throw new Error('fixture setup: run must not be terminal merely from opening the gate');
        }

        const resolved = await settleStep(
          run.id,
          { kind: 'settle_gate', gateId: gate.gate_id, choice: 'approve', evidence: [] },
          def,
        );
        assertApplied(resolved, 'settle_gate resolve (terminalizes mixed-complete)');
        if (resolved.run.finalizer_ledger?.['fin']?.status !== 'pending') {
          throw new Error(
            `expected 'fin' minted pending on the settle_gate-driven mixed-complete seal, got: ${JSON.stringify(resolved.run.finalizer_ledger)}`,
          );
        }
      },
    },
  ];
  if (fixture.withGuard === undefined) {
    cases.push({
      law: 'ADAPTER_WIRING',
      name: `[${adapter.storeName}] declares RunStore.settleStep but the supplied settlementFixture has no withGuard — CWFS_FIRES_PER_ARM's guard leg is a WIRING GAP, not a vacuous pass`,
      run: async () => {
        throw new Error(
          `[${adapter.storeName}] settlementContract: adapter.settlementFixture.withGuard is ` +
            "undefined — pass 'defaultSettlementFixture' (or a store-specific fixture " +
            'implementing withGuard) to exercise the CWFS_FIRES_PER_ARM guard-leg coverage.',
        );
      },
    });
  } else {
    const withGuard = fixture.withGuard;
    cases.push({
      law: 'CWFS_FIRES_PER_ARM',
      name: `[${adapter.storeName}] mixed-complete VIA settle_guard pass mints the declared completed_with_failed_steps finalizer`,
      run: async () => {
        const def = withFinalizer(
          withGuard(minimalDefinition(['fail_step']), 'g', []), // empty abort_unless ⇒ always passes
          'fin',
          'completed_with_failed_steps',
        );
        const { run, token: failToken } = await createClaimed(adapter.store, def, 'fail_step');
        const failed = await settleStep(
          run.id,
          {
            kind: 'settle_step',
            step: 'fail_step',
            outcome: 'fail',
            claimToken: failToken,
            evidence: [],
            failureMessage: 'x',
          },
          def,
        );
        assertApplied(failed, 'fail fail_step');
        if (failed.run.terminal_state) {
          throw new Error(
            "fixture setup: run must NOT terminalize while guard 'g' is still eligible",
          );
        }

        const passed = await settleStep(
          run.id,
          { kind: 'settle_guard', step: 'g', outcome: 'pass', evidence: makeEvidence('g') },
          def,
        );
        assertApplied(passed, 'settle_guard pass (terminalizes mixed-complete)');
        if (passed.run.finalizer_ledger?.['fin']?.status !== 'pending') {
          throw new Error(
            `expected 'fin' minted pending on the settle_guard-driven mixed-complete seal, got: ${JSON.stringify(passed.run.finalizer_ledger)}`,
          );
        }
      },
    });
  }
  return cases;
}

/** CWFS_NEGATIVES — the new trigger never over-fires: a clean complete (no failed_steps) does not
 *  select it; a pure fail seal (never reaches complete) does not select it either. */
function cwfsNegativesCases(adapter: SettlementContractAdapter): SettlementContractCase[] {
  const { minimalDefinition, withFinalizer } = adapter.settlementFixture!;
  const settleStep = requireSettleStep(adapter.store);
  return [
    {
      law: 'CWFS_NEGATIVES',
      name: `[${adapter.storeName}] a CLEAN complete seal (no failed_steps) does NOT select completed_with_failed_steps`,
      run: async () => {
        const def = withFinalizer(minimalDefinition(['a']), 'fin', 'completed_with_failed_steps');
        const { run, token } = await createClaimed(adapter.store, def, 'a');
        const completed = await settleStep(
          run.id,
          {
            kind: 'settle_step',
            step: 'a',
            outcome: 'complete',
            claimToken: token,
            evidence: [makeEvidence('a')],
          },
          def,
        );
        assertApplied(completed, 'clean complete of a');
        if (completed.run.finalizer_ledger?.['fin'] !== undefined) {
          throw new Error(
            `expected 'fin' NOT selected on a clean complete seal, got: ${JSON.stringify(completed.run.finalizer_ledger)}`,
          );
        }
      },
    },
    {
      law: 'CWFS_NEGATIVES',
      name: `[${adapter.storeName}] a PURE fail seal does NOT select completed_with_failed_steps (it requires a complete seal, never a fail seal)`,
      run: async () => {
        const def = withFinalizer(minimalDefinition(['a']), 'fin', 'completed_with_failed_steps');
        const { run, token } = await createClaimed(adapter.store, def, 'a');
        const failed = await settleStep(
          run.id,
          {
            kind: 'settle_step',
            step: 'a',
            outcome: 'fail',
            claimToken: token,
            evidence: [],
            failureMessage: 'x',
          },
          def,
        );
        assertApplied(failed, 'pure fail of a');
        if (failed.run.finalizer_ledger?.['fin'] !== undefined) {
          throw new Error(
            `expected 'fin' NOT selected on a pure fail seal, got: ${JSON.stringify(failed.run.finalizer_ledger)}`,
          );
        }
      },
    },
  ];
}

/** CWFS_SECOND_EPOCH — the M1 uniform-predicate pin: a second-epoch complete seal whose ONLY
 *  failed_steps scar is a PRIOR epoch's finalizer self-failure (unresumable, so it never leaves
 *  failed_steps) still fires completed_with_failed_steps. The post-resume state is HAND-AUTHORED
 *  via update() (the mintFreshCases/L14 precedent) — this TCK case does not drive real
 *  applyResume; a core-homed witness through the REAL applyResume lives in core's own test suite
 *  (finalizer-matrix-302.test.ts), per the hand-off prompt's "Core tests" bullet. */
function cwfsSecondEpochCases(adapter: SettlementContractAdapter): SettlementContractCase[] {
  const { minimalDefinition, withFinalizer } = adapter.settlementFixture!;
  const settleStep = requireSettleStep(adapter.store);
  return [
    {
      law: 'CWFS_SECOND_EPOCH',
      name: `[${adapter.storeName}] a second-epoch complete seal driven SOLELY by a prior epoch's finalizer self-failure still fires completed_with_failed_steps`,
      run: async () => {
        const def = withFinalizer(
          withFinalizer(minimalDefinition(['a']), 'onFail', 'fail'),
          'fin',
          'completed_with_failed_steps',
        );
        const { run, token } = await createClaimed(adapter.store, def, 'a');
        const failedA = await settleStep(
          run.id,
          {
            kind: 'settle_step',
            step: 'a',
            outcome: 'fail',
            claimToken: token,
            evidence: [],
            failureMessage: 'x',
          },
          def,
        );
        assertApplied(failedA, 'fail step a (terminalizes fail, mints onFail)');
        if (failedA.run.finalizer_ledger?.['onFail']?.status !== 'pending') {
          throw new Error(
            'fixture setup: expected onFail minted pending on the fail-terminal edge',
          );
        }
        if (failedA.run.finalizer_ledger?.['fin'] !== undefined) {
          throw new Error("fixture setup: 'fin' must NOT be selected on a pure fail seal");
        }

        // The prior epoch's finalizer self-failure: onFail itself FAILS (unresumable — its name
        // enters failed_steps and stays there forever).
        const leaseToken = uid('lease');
        const leased = await settleStep(
          run.id,
          { kind: 'lease_finalizer', finalizer: 'onFail', leaseToken, leaseSeconds: 60 },
          def,
        );
        assertApplied(leased, 'lease onFail');
        const markedFailed = await settleStep(
          run.id,
          {
            kind: 'mark_finalizer',
            finalizer: 'onFail',
            leaseToken,
            result: 'failed',
            evidence: makeEvidence('onFail'),
          },
          def,
        );
        assertApplied(markedFailed, 'mark onFail failed');
        if (!markedFailed.run.failed_steps.includes('onFail')) {
          throw new Error(
            "fixture setup: expected 'onFail' in failed_steps after its own self-failure",
          );
        }

        // Hand-author the post-resume state: 'a' is resumed/cleared (eligible again), but
        // 'onFail' — a FINALIZER, unresumable — stays in failed_steps (the M1 scenario's own
        // premise). terminal_state:false / in_progress_steps:[] / settled:{} mirror the
        // mintFreshCases precedent's own void shape.
        // issue #367: same as the mintFreshCases precedent — the seal fact leaves in the write
        // that flips the run live again.
        const { sealed_by: _voidSeal2, ...markedFailedBase } = markedFailed.run;
        const postResumeVoid = await adapter.store.update({
          ...markedFailedBase,
          terminal_state: false,
          in_progress_steps: [],
          failed_steps: ['onFail'],
          settled: {},
        });
        if (postResumeVoid.finalizer_ledger?.['onFail']?.status !== 'failed') {
          throw new Error(
            "fixture setup: onFail must still read 'failed' after the hand-authored void",
          );
        }

        // Second epoch: re-claim + complete 'a'. Its own failed_steps has NOTHING from this
        // epoch — only onFail's own prior-epoch scar.
        const reclaimed = await adapter.store.claimStep(run.id, 'a', def);
        const reToken = reclaimed.claims!['a']!.token!;
        const reCompleted = await settleStep(
          run.id,
          {
            kind: 'settle_step',
            step: 'a',
            outcome: 'complete',
            claimToken: reToken,
            evidence: [makeEvidence('a')],
          },
          def,
        );
        assertApplied(reCompleted, 're-complete step a on its second epoch');
        if (reCompleted.run.finalizer_ledger?.['fin']?.status !== 'pending') {
          throw new Error(
            `expected 'fin' minted pending on the second-epoch complete seal (driven solely by ` +
              `onFail's prior-epoch self-failure), got: ${JSON.stringify(reCompleted.run.finalizer_ledger)}`,
          );
        }
        // onFail itself must NOT be re-selected (its own trigger is 'fail', not 'complete'/
        // 'completed_with_failed_steps') — it stays 'failed', never rewritten.
        if (reCompleted.run.finalizer_ledger?.['onFail']?.status !== 'failed') {
          throw new Error(
            `expected onFail to STAY 'failed' (never re-selected on a complete seal), got: '${reCompleted.run.finalizer_ledger?.['onFail']?.status}'`,
          );
        }
      },
    },
  ];
}

/** CWFS_ARRAY_ONCE — a finalizer never fires twice for one seal: the array form fires exactly
 *  once on mixed-complete (Group A, a single push despite a multi-element intersection); `always`
 *  fires exactly once on mixed-complete too (Group B). */
function cwfsArrayOnceCases(adapter: SettlementContractAdapter): SettlementContractCase[] {
  const { minimalDefinition, withFinalizer } = adapter.settlementFixture!;
  const settleStep = requireSettleStep(adapter.store);

  /** Builds a mixed-complete seal (fail 'fail_step' first, then complete 'complete_step' last)
   *  over whatever finalizer(s) `withFin` has already added to the definition. */
  async function driveMixedComplete(def: WorkflowDefinition): Promise<SettlementResult> {
    const { run, token: failToken } = await createClaimed(adapter.store, def, 'fail_step');
    const claimedComplete = await adapter.store.claimStep(run.id, 'complete_step', def);
    const completeToken = claimedComplete.claims!['complete_step']!.token!;
    const failed = await settleStep(
      run.id,
      {
        kind: 'settle_step',
        step: 'fail_step',
        outcome: 'fail',
        claimToken: failToken,
        evidence: [],
        failureMessage: 'x',
      },
      def,
    );
    assertApplied(failed, 'fail fail_step');
    return settleStep(
      run.id,
      {
        kind: 'settle_step',
        step: 'complete_step',
        outcome: 'complete',
        claimToken: completeToken,
        evidence: [makeEvidence('complete_step')],
      },
      def,
    );
  }

  return [
    {
      law: 'CWFS_ARRAY_ONCE',
      name: `[${adapter.storeName}] on_outcome: [complete, completed_with_failed_steps] fires EXACTLY ONCE on a mixed-complete seal (Group A, one push despite a two-element intersection)`,
      run: async () => {
        const def = withFinalizer(minimalDefinition(['fail_step', 'complete_step']), 'fin', [
          'complete',
          'completed_with_failed_steps',
        ]);
        const result = await driveMixedComplete(def);
        assertApplied(result, 'array-form mixed-complete seal');
        const entry = result.run.finalizer_ledger?.['fin'];
        if (entry?.status !== 'pending' || entry.rank !== 0) {
          throw new Error(
            `expected exactly one 'fin' entry (rank 0, pending), got: ${JSON.stringify(entry)}`,
          );
        }
        if (result.run.completed_steps.filter((s) => s === 'fin').length > 1) {
          throw new Error("'fin' must not appear more than once in completed_steps");
        }
      },
    },
    {
      law: 'CWFS_ARRAY_ONCE',
      name: `[${adapter.storeName}] on_outcome: 'always' fires EXACTLY ONCE on a mixed-complete seal (Group B, never double-counted alongside a Group A hit)`,
      run: async () => {
        const def = withFinalizer(
          minimalDefinition(['fail_step', 'complete_step']),
          'fin',
          'always',
        );
        const result = await driveMixedComplete(def);
        assertApplied(result, 'always-form mixed-complete seal');
        const entry = result.run.finalizer_ledger?.['fin'];
        if (entry?.status !== 'pending' || entry.rank !== 0) {
          throw new Error(
            `expected exactly one 'fin' entry (rank 0, pending), got: ${JSON.stringify(entry)}`,
          );
        }
      },
    },
  ];
}

/** CURRENT_BEHAVIOR_PINNED — the REJECTED design alternative (D-C: auto-firing 'fail' on
 *  mixed-complete) never happens, pinned both ways. */
function currentBehaviorPinnedCases(adapter: SettlementContractAdapter): SettlementContractCase[] {
  const { minimalDefinition, withFinalizer } = adapter.settlementFixture!;
  const settleStep = requireSettleStep(adapter.store);
  return [
    {
      law: 'CURRENT_BEHAVIOR_PINNED',
      name: `[${adapter.storeName}] a clean complete seal does NOT select a 'fail'-only finalizer`,
      run: async () => {
        const def = withFinalizer(minimalDefinition(['a']), 'onFail', 'fail');
        const { run, token } = await createClaimed(adapter.store, def, 'a');
        const completed = await settleStep(
          run.id,
          {
            kind: 'settle_step',
            step: 'a',
            outcome: 'complete',
            claimToken: token,
            evidence: [makeEvidence('a')],
          },
          def,
        );
        assertApplied(completed, 'clean complete of a');
        if (completed.run.finalizer_ledger?.['onFail'] !== undefined) {
          throw new Error("expected 'onFail' NOT selected on a clean complete seal");
        }
      },
    },
    {
      law: 'CURRENT_BEHAVIOR_PINNED',
      name: `[${adapter.storeName}] a MIXED-complete seal (failed_steps ≠ ∅) still does NOT select a 'fail'-only finalizer — D-C's rejected auto-fire alternative is contract, not merely untested`,
      run: async () => {
        const def = withFinalizer(
          minimalDefinition(['fail_step', 'complete_step']),
          'onFail',
          'fail',
        );
        const { run, token: failToken } = await createClaimed(adapter.store, def, 'fail_step');
        const claimedComplete = await adapter.store.claimStep(run.id, 'complete_step', def);
        const completeToken = claimedComplete.claims!['complete_step']!.token!;
        const failed = await settleStep(
          run.id,
          {
            kind: 'settle_step',
            step: 'fail_step',
            outcome: 'fail',
            claimToken: failToken,
            evidence: [],
            failureMessage: 'x',
          },
          def,
        );
        assertApplied(failed, 'fail fail_step');
        const completed = await settleStep(
          run.id,
          {
            kind: 'settle_step',
            step: 'complete_step',
            outcome: 'complete',
            claimToken: completeToken,
            evidence: [makeEvidence('complete_step')],
          },
          def,
        );
        assertApplied(completed, 'complete complete_step (terminalizes mixed-complete)');
        if (completed.run.finalizer_ledger?.['onFail'] !== undefined) {
          throw new Error(
            `expected 'onFail' (fail-only trigger) NOT selected on a mixed-complete seal — the ` +
              `rejected auto-fire-fail-on-mixed-complete alternative must not happen; got: ` +
              `${JSON.stringify(completed.run.finalizer_ledger)}`,
          );
        }
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// EXPIRE_ARM_MATRIX / EXPIRE_ABORT_CASCADE / EXPIRE_DEFAULT_RESOLVE (issue #291,
// gate-timeout-291-correction Leg 2 — ported from the dedicated core-only
// gate-expiry-tck-laws.test.ts per the PR-C precedent: new delta kinds' laws join this shared,
// cross-store conformance kit rather than staying core-internal only). The dedicated core file
// stays (see its own SCOPE NOTE, amended) as fast unit-level coverage exercising `applySettlement`
// directly with hand-rolled fixtures — this is the STORE-EXERCISING cross-conformance layer,
// proving BOTH JsonFileStore and InMemoryStore's `settleStep` reach the identical, correct
// `applyExpireGate` behavior through the real store surface, matching every other delta kind's
// own dual coverage (a dedicated engine-level test file + a settlement-contract.ts law family).
// ---------------------------------------------------------------------------

function expireArmMatrixCases(adapter: SettlementContractAdapter): SettlementContractCase[] {
  const { minimalDefinition } = adapter.settlementFixture!;
  const settleStep = requireSettleStep(adapter.store);
  return [
    {
      law: 'EXPIRE_ARM_MATRIX',
      name: `[${adapter.storeName}] expire_gate refuses not_expired with the injectable now, never the caller-implied clock`,
      run: async () => {
        const def = minimalDefinition(['gated']);
        const { run, token } = await createClaimed(adapter.store, def, 'gated');
        const gate = makePendingGate('gated', {
          gateId: 'gate-1',
          expiresAt: '2026-01-01T00:05:00.000Z',
          onExpiry: 'abort',
        });
        const opened = await settleStep(
          run.id,
          { kind: 'open_gate', step: 'gated', claimToken: token, pendingGate: gate, evidence: [] },
          def,
        );
        assertApplied(opened, 'open_gate');
        const result = await settleStep(run.id, { kind: 'expire_gate', gateId: 'gate-1' }, def, {
          now: new Date('2026-01-01T00:00:30.000Z'),
        });
        assertRefused(result, 'not_expired', 'expire_gate before expires_at');
      },
    },
    {
      law: 'EXPIRE_ARM_MATRIX',
      name: `[${adapter.storeName}] expire_gate replay ×2 (settle_default): the SECOND attempt NOOPs already_settled — version-safe idempotence`,
      run: async () => {
        const def = minimalDefinition(['gated']);
        const { run, token } = await createClaimed(adapter.store, def, 'gated');
        const gate = makePendingGate('gated', {
          gateId: 'gate-1',
          expiresAt: '2026-01-01T00:05:00.000Z',
          onExpiry: 'settle_default',
          defaultChoice: 'approve',
        });
        const opened = await settleStep(
          run.id,
          { kind: 'open_gate', step: 'gated', claimToken: token, pendingGate: gate, evidence: [] },
          def,
        );
        assertApplied(opened, 'open_gate');
        const now = new Date('2026-01-01T00:10:00.000Z');
        const first = await settleStep(run.id, { kind: 'expire_gate', gateId: 'gate-1' }, def, {
          now,
        });
        assertApplied(first, 'first expire_gate (settle_default)');
        const second = await settleStep(run.id, { kind: 'expire_gate', gateId: 'gate-1' }, def, {
          now,
        });
        assertRefused(
          second,
          'already_settled',
          'replay expire_gate for an already-settled settle_default gate',
        );
      },
    },
    {
      law: 'EXPIRE_ARM_MATRIX',
      name: `[${adapter.storeName}] expire_gate replay ×2 (abort): the SECOND attempt NOOPs already_settled (terminal split)`,
      run: async () => {
        const def = minimalDefinition(['gated']);
        const { run, token } = await createClaimed(adapter.store, def, 'gated');
        const gate = makePendingGate('gated', {
          gateId: 'gate-1',
          expiresAt: '2026-01-01T00:05:00.000Z',
          onExpiry: 'abort',
        });
        const opened = await settleStep(
          run.id,
          { kind: 'open_gate', step: 'gated', claimToken: token, pendingGate: gate, evidence: [] },
          def,
        );
        assertApplied(opened, 'open_gate');
        const now = new Date('2026-01-01T00:10:00.000Z');
        const first = await settleStep(run.id, { kind: 'expire_gate', gateId: 'gate-1' }, def, {
          now,
        });
        assertApplied(first, 'first expire_gate (abort)');
        const second = await settleStep(run.id, { kind: 'expire_gate', gateId: 'gate-1' }, def, {
          now,
        });
        assertRefused(
          second,
          'already_settled',
          'replay expire_gate for an already-aborted gate (terminal-split arm)',
        );
      },
    },
    {
      law: 'EXPIRE_ARM_MATRIX',
      name: `[${adapter.storeName}] expire_gate against a run terminalized by a DIFFERENT cause refuses run_terminal — never resurrecting or re-terminalizing`,
      run: async () => {
        const def = minimalDefinition(['gated']);
        const { run, token } = await createClaimed(adapter.store, def, 'gated');
        const completed = await settleStep(
          run.id,
          {
            kind: 'settle_step',
            step: 'gated',
            outcome: 'complete',
            claimToken: token,
            evidence: [makeEvidence('gated')],
          },
          def,
        );
        assertApplied(
          completed,
          'complete gated (terminalizes — sole step, unrelated to any gate)',
        );
        const result = await settleStep(run.id, { kind: 'expire_gate', gateId: 'gate-1' }, def, {
          now: new Date('2026-01-01T00:10:00.000Z'),
        });
        assertRefused(
          result,
          'run_terminal',
          'expire_gate against a run terminalized by an unrelated cause',
        );
      },
    },
    {
      law: 'EXPIRE_ARM_MATRIX',
      name: `[${adapter.storeName}] expire_gate with an unknown/superseded gateId refuses gate_mismatch`,
      run: async () => {
        const def = minimalDefinition(['gated']);
        const { run, token } = await createClaimed(adapter.store, def, 'gated');
        const gate = makePendingGate('gated', {
          gateId: 'live-gate',
          expiresAt: '2026-01-01T00:05:00.000Z',
          onExpiry: 'abort',
        });
        const opened = await settleStep(
          run.id,
          { kind: 'open_gate', step: 'gated', claimToken: token, pendingGate: gate, evidence: [] },
          def,
        );
        assertApplied(opened, 'open_gate');
        const result = await settleStep(
          run.id,
          { kind: 'expire_gate', gateId: 'stale-unknown-gate' },
          def,
          { now: new Date('2026-01-01T00:10:00.000Z') },
        );
        assertRefused(result, 'gate_mismatch', 'expire_gate with an unknown gateId');
      },
    },
    {
      law: 'EXPIRE_ARM_MATRIX',
      name: `[${adapter.storeName}] expire_gate on a finding-only gate (expires_at present, on_expiry absent) refuses no_disposition, arm-level, before APPLY — never cleared`,
      run: async () => {
        const def = minimalDefinition(['gated']);
        const { run, token } = await createClaimed(adapter.store, def, 'gated');
        const gate = makePendingGate('gated', {
          gateId: 'gate-1',
          expiresAt: '2026-01-01T00:05:00.000Z',
          // no onExpiry — finding-only.
        });
        const opened = await settleStep(
          run.id,
          { kind: 'open_gate', step: 'gated', claimToken: token, pendingGate: gate, evidence: [] },
          def,
        );
        assertApplied(opened, 'open_gate');
        const result = await settleStep(run.id, { kind: 'expire_gate', gateId: 'gate-1' }, def, {
          now: new Date('2026-01-01T00:10:00.000Z'),
        });
        assertRefused(result, 'no_disposition', 'expire_gate on a finding-only gate');
        if (result.run.pending_gate === undefined) {
          throw new Error('a finding-only refusal must NEVER clear pending_gate');
        }
      },
    },
  ];
}

function expireAbortCascadeCases(adapter: SettlementContractAdapter): SettlementContractCase[] {
  const { minimalDefinition, withFinalizer } = adapter.settlementFixture!;
  const settleStep = requireSettleStep(adapter.store);
  return [
    {
      law: 'EXPIRE_ABORT_CASCADE',
      name: `[${adapter.storeName}] expire_gate (abort) clears pending_gate + claim, writes aborted_at + skip_details {gate_expired, gate_id} (day-one), mints finalizers — all in ONE write`,
      run: async () => {
        const def = withFinalizer(minimalDefinition(['gated']), 'fin', 'abort');
        const { run, token } = await createClaimed(adapter.store, def, 'gated');
        const gate = makePendingGate('gated', {
          gateId: 'gate-1',
          expiresAt: '2026-01-01T00:05:00.000Z',
          onExpiry: 'abort',
        });
        const opened = await settleStep(
          run.id,
          { kind: 'open_gate', step: 'gated', claimToken: token, pendingGate: gate, evidence: [] },
          def,
        );
        assertApplied(opened, 'open_gate');
        const result = await settleStep(run.id, { kind: 'expire_gate', gateId: 'gate-1' }, def, {
          now: new Date('2026-01-01T00:10:00.000Z'),
        });
        assertApplied(result, 'expire_gate (abort)');
        if (result.run.pending_gate !== undefined) {
          throw new Error('expected pending_gate cleared');
        }
        if (result.run.claims?.['gated'] !== undefined) {
          throw new Error('expected the claim cleared');
        }
        if (result.run.in_progress_steps.includes('gated')) {
          throw new Error("expected 'gated' removed from in_progress_steps");
        }
        if (result.run.terminal_state !== true) {
          throw new Error('expected the run to terminalize');
        }
        if (result.run.aborted_at?.step_id !== 'gated') {
          throw new Error(
            `expected aborted_at.step_id === 'gated', got ${JSON.stringify(result.run.aborted_at)}`,
          );
        }
        const detail = result.run.skip_details?.['gated'];
        if (detail === undefined || detail.kind !== 'gate_expired' || detail.gate_id !== 'gate-1') {
          throw new Error(
            `expected skip_details.gated = {kind:'gate_expired', gate_id:'gate-1'}, got ${JSON.stringify(detail)}`,
          );
        }
        if (result.run.settled?.['gated'] !== undefined) {
          throw new Error(
            'TERMINAL_GATE_EXCLUSION: the abort disposition must never ALSO write a settled gate entry',
          );
        }
        if (result.run.finalizer_ledger?.['fin'] === undefined) {
          throw new Error("expected the 'abort'-triggered finalizer minted on the abort edge");
        }
      },
    },
    {
      law: 'EXPIRE_ABORT_CASCADE',
      name: `[${adapter.storeName}] the D-4 discriminator: a gate_expired skip_detail is NEVER mistaken for gate_cancelled_by_abort`,
      run: async () => {
        const def = minimalDefinition(['gated']);
        const { run, token } = await createClaimed(adapter.store, def, 'gated');
        const gate = makePendingGate('gated', {
          gateId: 'gate-1',
          expiresAt: '2026-01-01T00:05:00.000Z',
          onExpiry: 'abort',
        });
        const opened = await settleStep(
          run.id,
          { kind: 'open_gate', step: 'gated', claimToken: token, pendingGate: gate, evidence: [] },
          def,
        );
        assertApplied(opened, 'open_gate');
        const result = await settleStep(run.id, { kind: 'expire_gate', gateId: 'gate-1' }, def, {
          now: new Date('2026-01-01T00:10:00.000Z'),
        });
        assertApplied(result, 'expire_gate (abort)');
        const kind = result.run.skip_details?.['gated']?.kind;
        if (kind !== 'gate_expired') {
          throw new Error(`expected skip_details.gated.kind === 'gate_expired', got '${kind}'`);
        }
        // TypeScript narrows `kind` to the literal above; the discriminator being tested is that
        // it is NEVER 'gate_cancelled_by_abort' — asserted by construction (the union excludes it
        // once narrowed) and restated here as an explicit, readable pin.
      },
    },
    {
      law: 'EXPIRE_ABORT_CASCADE',
      name: `[${adapter.storeName}] expire_gate (abort) never stamps defaulted_steps, even though it terminalizes (the FM-5/#232 guard)`,
      run: async () => {
        const def = minimalDefinition(['gated']);
        const { run, token } = await createClaimed(adapter.store, def, 'gated');
        const gate = makePendingGate('gated', {
          gateId: 'gate-1',
          expiresAt: '2026-01-01T00:05:00.000Z',
          onExpiry: 'abort',
        });
        const opened = await settleStep(
          run.id,
          { kind: 'open_gate', step: 'gated', claimToken: token, pendingGate: gate, evidence: [] },
          def,
        );
        assertApplied(opened, 'open_gate');
        const result = await settleStep(run.id, { kind: 'expire_gate', gateId: 'gate-1' }, def, {
          now: new Date('2026-01-01T00:10:00.000Z'),
        });
        assertApplied(result, 'expire_gate (abort)');
        if (result.run.defaulted_steps !== undefined) {
          throw new Error('expire_gate (abort) must never stamp defaulted_steps');
        }
      },
    },
  ];
}

function expireDefaultResolveCases(adapter: SettlementContractAdapter): SettlementContractCase[] {
  const { minimalDefinition } = adapter.settlementFixture!;
  const settleStep = requireSettleStep(adapter.store);
  return [
    {
      law: 'EXPIRE_DEFAULT_RESOLVE',
      name: `[${adapter.storeName}] expire_gate (settle_default) resolves with resolved_by:'timeout' attribution + terminalizes (sole step)`,
      run: async () => {
        const def = minimalDefinition(['gated']);
        const { run, token } = await createClaimed(adapter.store, def, 'gated');
        const gate = makePendingGate('gated', {
          gateId: 'gate-1',
          expiresAt: '2026-01-01T00:05:00.000Z',
          onExpiry: 'settle_default',
          defaultChoice: 'approve',
        });
        const opened = await settleStep(
          run.id,
          { kind: 'open_gate', step: 'gated', claimToken: token, pendingGate: gate, evidence: [] },
          def,
        );
        assertApplied(opened, 'open_gate');
        const result = await settleStep(run.id, { kind: 'expire_gate', gateId: 'gate-1' }, def, {
          now: new Date('2026-01-01T00:10:00.000Z'),
        });
        assertApplied(result, 'expire_gate (settle_default)');
        const entry = result.run.settled?.['gated'];
        if (
          entry?.token !== 'gate-1' ||
          entry.outcome !== 'gate' ||
          entry.choice !== 'approve' ||
          entry.resolved_by !== 'timeout'
        ) {
          throw new Error(
            `expected settled.gated = {token:'gate-1', outcome:'gate', choice:'approve', ` +
              `resolved_by:'timeout'}, got ${JSON.stringify(entry)}`,
          );
        }
        if (result.run.terminal_state !== true) {
          throw new Error('sole step ⇒ isComplete ⇒ the run must terminalize');
        }
      },
    },
    {
      law: 'EXPIRE_DEFAULT_RESOLVE',
      name: `[${adapter.storeName}] expire_gate (settle_default): a sibling step still in progress keeps the run non-terminal`,
      run: async () => {
        const def = minimalDefinition(['gated', 'sibling']);
        const { run, token } = await createClaimed(adapter.store, def, 'gated');
        await adapter.store.claimStep(run.id, 'sibling', def);
        const gate = makePendingGate('gated', {
          gateId: 'gate-1',
          expiresAt: '2026-01-01T00:05:00.000Z',
          onExpiry: 'settle_default',
          defaultChoice: 'approve',
        });
        const opened = await settleStep(
          run.id,
          { kind: 'open_gate', step: 'gated', claimToken: token, pendingGate: gate, evidence: [] },
          def,
        );
        assertApplied(opened, 'open_gate');
        const result = await settleStep(run.id, { kind: 'expire_gate', gateId: 'gate-1' }, def, {
          now: new Date('2026-01-01T00:10:00.000Z'),
        });
        assertApplied(result, 'expire_gate (settle_default)');
        if (result.run.terminal_state !== false) {
          throw new Error("'sibling' still in_progress ⇒ the run must stay non-terminal");
        }
        if (!result.run.completed_steps.includes('gated')) {
          throw new Error("expected 'gated' in completed_steps");
        }
      },
    },
    {
      law: 'EXPIRE_DEFAULT_RESOLVE',
      name: `[${adapter.storeName}] FROZEN-BEATS-DEFINITION: expire_gate reads the RECORD-frozen default_choice, NEVER a re-registered definition's drifted value`,
      run: async () => {
        const def = minimalDefinition(['gated']);
        const { run, token } = await createClaimed(adapter.store, def, 'gated');
        // The gate was minted under a definition whose gate.default_choice was 'approve' — frozen
        // into the record's own pending_gate.default_choice at mint (simulated directly here, as
        // the source test targets applyExpireGate's own read behavior, not the mint site).
        const gate = makePendingGate('gated', {
          gateId: 'gate-1',
          expiresAt: '2026-01-01T00:05:00.000Z',
          onExpiry: 'settle_default',
          defaultChoice: 'approve',
        });
        const opened = await settleStep(
          run.id,
          { kind: 'open_gate', step: 'gated', claimToken: token, pendingGate: gate, evidence: [] },
          def,
        );
        assertApplied(opened, 'open_gate');
        // A DIFFERENT definition — simulating a workflow re-registered with a changed
        // default_choice ('reject') and a different choice set entirely — passed only at
        // enactment time. applyExpireGate never reads step-def gate config (gate state lives
        // entirely on the RECORD's frozen pending_gate), so this must have zero effect.
        const driftedDef: WorkflowDefinition = {
          id: uid('settlement-wf-drifted'),
          name: 'Drifted default_choice',
          version: 1,
          steps: {
            gated: {
              description: 'gated',
              execution: 'agent',
              depends_on: [],
              trust: 'human_confirmed',
              gate: {
                choices: ['ship', 'hold'],
                on_expiry: 'settle_default',
                default_choice: 'reject',
              },
            },
          },
        };
        const result = await settleStep(
          run.id,
          { kind: 'expire_gate', gateId: 'gate-1' },
          driftedDef,
          {
            now: new Date('2026-01-01T00:10:00.000Z'),
          },
        );
        assertApplied(result, 'expire_gate against a drifted definition');
        if (result.run.settled?.['gated']?.choice !== 'approve') {
          throw new Error(
            `expected the FROZEN choice 'approve' to win, got '${result.run.settled?.['gated']?.choice}'`,
          );
        }
      },
    },
    {
      law: 'EXPIRE_DEFAULT_RESOLVE',
      name: `[${adapter.storeName}] expire_gate (settle_default): the evidence gate_response snapshot carries responded_by:'timeout' + resolution:'expired_default'`,
      run: async () => {
        const def = minimalDefinition(['gated']);
        const { run, token } = await createClaimed(adapter.store, def, 'gated');
        const gate = makePendingGate('gated', {
          gateId: 'gate-1',
          expiresAt: '2026-01-01T00:05:00.000Z',
          onExpiry: 'settle_default',
          defaultChoice: 'approve',
        });
        const opened = await settleStep(
          run.id,
          { kind: 'open_gate', step: 'gated', claimToken: token, pendingGate: gate, evidence: [] },
          def,
        );
        assertApplied(opened, 'open_gate');
        const result = await settleStep(run.id, { kind: 'expire_gate', gateId: 'gate-1' }, def, {
          now: new Date('2026-01-01T00:10:00.000Z'),
        });
        assertApplied(result, 'expire_gate (settle_default)');
        const snapshot = result.run.evidence.at(-1);
        if (
          snapshot?.kind !== 'gate_response' ||
          snapshot.responded_by !== 'timeout' ||
          snapshot.resolution !== 'expired_default'
        ) {
          throw new Error(
            `expected the last evidence entry to be a gate_response with responded_by:'timeout'/` +
              `resolution:'expired_default', got ${JSON.stringify(snapshot)}`,
          );
        }
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/**
 * Builds every PR-A-runnable settlement contract case for `adapter`.
 *
 * - `adapter.store.settleStep` undeclared ⇒ **zero cases** (vacuous pass — mirrors the
 *   established optional-capability idiom, e.g. `runStoreFidelityContract`'s own
 *   zero-cases-on-no-declaration precedent for a store that opts out entirely).
 * - `settleStep` declared but `adapter.settlementFixture` absent ⇒ **one `ADAPTER_WIRING`
 *   failing case**, never a silent zero-cases pass — a store that opts INTO settlement
 *   conformance must not be able to pass this TCK by accident of an unwired adapter.
 * - Both present ⇒ the full law set below.
 */
export function settlementContract(adapter: SettlementContractAdapter): SettlementContractCase[] {
  if (adapter.store.settleStep === undefined) {
    return [];
  }
  if (adapter.settlementFixture === undefined) {
    return [
      {
        law: 'ADAPTER_WIRING',
        name: `[${adapter.storeName}] declares RunStore.settleStep but no settlementFixture was supplied to the adapter — wire in 'defaultSettlementFixture' (or a store-specific SettlementFixture) to run real conformance coverage`,
        run: async () => {
          throw new Error(
            `[${adapter.storeName}] settlementContract: adapter.store declares settleStep, but ` +
              `adapter.settlementFixture is undefined — this is a WIRING GAP in the calling test ` +
              `file, not a store defect. Pass 'defaultSettlementFixture' from this module (or a ` +
              'store-specific SettlementFixture) to exercise the real conformance cases.',
          );
        },
      },
    ];
  }
  return [
    ...freshApplicationCases(adapter),
    ...conditionalNoopCases(adapter),
    ...ownershipRefusalCases(adapter),
    ...ledgerMintAtomicityCases(adapter),
    ...drainMarkDedupCases(adapter),
    ...terminalRefusalCases(adapter),
    ...terminalStateOnlyCases(adapter),
    ...sealIntegrityCases(adapter),
    ...stampSealCases(adapter),
    ...csPurityCases(adapter),
    ...neverDowngradeCases(adapter),
    ...settleOutcomeIntegrityCases(adapter),
    ...settledOrphanOverwriteCases(adapter),
    ...transformFidelityCases(adapter),
    ...resultAsAppliedCases(),
    ...markMembershipCases(adapter),
    ...refusalSweepCases(adapter),
    ...mintFreshCases(adapter),
    ...selfImageIdempotenceCases(adapter),
    ...completeSealPhaseCases(adapter),
    ...whenRoutedTerminalizationCases(adapter),
    ...g1GateCoexistenceCases(adapter),
    // issue #279, increment 2 (PR-C).
    ...gateOpenIdempotentCases(adapter),
    ...gateResolutionConflictCases(adapter),
    ...gateMismatchCases(adapter),
    ...guardCases(adapter),
    ...releaseIdempotentCases(adapter),
    ...phaseIsGeneratedCases(adapter),
    // issue #302 (finalizer outcome×trigger matrix).
    ...cwfsFiresPerArmCases(adapter),
    ...cwfsNegativesCases(adapter),
    ...cwfsSecondEpochCases(adapter),
    ...cwfsArrayOnceCases(adapter),
    ...currentBehaviorPinnedCases(adapter),
    // issue #291 (gate-timeout-291-correction, Leg 2).
    ...expireArmMatrixCases(adapter),
    ...expireAbortCascadeCases(adapter),
    ...expireDefaultResolveCases(adapter),
  ];
}
