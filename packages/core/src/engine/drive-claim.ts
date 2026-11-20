// drive-claim.ts — issue #729, the claim window, unit CW-2a (design record C5 §4.3): the two engine
// entries a drive uses to take a step's claim under a lease it holds, before the step's paid work
// starts, and to give that claim back without settling the step. `realm agent` calls them for every
// agent step it drives (CW-5a).
//
// `claimStepForDrive` judges the step as `executeChain` does — `admitWay('run_step')` on the loaded
// run, then the store's own `claimStep`, re-judging a fresh read when the store refuses the claim — and
// answers what happened as a closed union keyed by `kind`. No answer carries a claim token (A-17).
// Once it has made a hold, every answer but `claimed` closes it with the record it was judged on, so
// the lease's file is deleted; a `claimStep` that throws anything else closes it with no record, so
// the file stays (the write may have landed: C5 §4.1's rule).
//
// `releaseDriveClaim` releases the step's claim with the claim's own token (the #279 fence) only when
// that claim names the drive's lease; it never closes the hold — the caller does, with the record it
// returns.
import { admitEntry } from '../admission.js';
import type { ExtensionRegistry } from '../extensions/registry.js';
import { isLeaseFact, leaseFactOf } from '../store/lease-facts.js';
import type { LeaseFact, LeaseHold, LeaseUnavailableReason } from '../store/lease-port.js';
import type { RunStore } from '../store/store-interface.js';
import type { EvidenceSnapshot, RunRecord } from '../types/run-record.js';
import type { ReleaseStepDelta, SettlementRefusalReason } from '../types/settlement.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
import { WorkflowError } from '../types/workflow-error.js';
import type { Attributed } from './holder.js';
import { writtenSnapshot, type Snapshot } from './snapshot.js';
import { admitWay, waysStoreOf, type Unavailable, type UnavailableCode } from './ways.js';

/**
 * What {@link claimStepForDrive} takes besides the store, the run and the step.
 * @beta
 */
export interface ClaimStepForDriveOptions {
  /** The run's workflow definition: what the step is judged against, and what `claimStep` checks. */
  definition: WorkflowDefinition;
  /** This program's extension registry: the step is judged as this program would run it. */
  registry: ExtensionRegistry;
  /** The program taking the step, written as the claim's `holder`, as `executeChain` writes it. */
  driver?: Attributed;
}

/**
 * What {@link claimStepForDrive} answers, keyed by `kind`. The union is open: later units add kinds
 * (Q2-a's `over_limit`), so a caller handles an unknown `kind` as a refusal.
 * - `claimed`: the step's claim is this program's, under `hold`, taken at `since`. The caller holds
 *   the lease until it closes it.
 * - `held_by`: another program holds the step. `holder` and `since` are its claim's, and `lease` its
 *   lease's fact, when the run still shows that claim (and it names a lease).
 * - `not_eligible`: the step cannot run now.
 * - `refused`: the step was refused for another reason, by its code.
 * - `lease_unavailable`: the store could not make a lease, with why; no claim was taken.
 * - `unleased_store`: the store keeps no leases; nothing was held, read or written.
 * @beta
 */
export type DriveClaim =
  | { readonly kind: 'claimed'; readonly hold: LeaseHold; readonly since: string }
  | {
      readonly kind: 'held_by';
      readonly holder?: Attributed;
      readonly since?: string;
      readonly lease?: LeaseFact;
    }
  | { readonly kind: 'not_eligible' }
  | {
      readonly kind: 'refused';
      readonly code: Exclude<UnavailableCode, 'held_elsewhere' | 'not_eligible'>;
    }
  | { readonly kind: 'lease_unavailable'; readonly reason: LeaseUnavailableReason }
  | { readonly kind: 'unleased_store' };

/**
 * What {@link releaseDriveClaim} takes besides the store, the run and the step.
 * @beta
 */
export interface ReleaseDriveClaimOptions {
  /** The run's workflow definition, which the store's settle takes. */
  definition: WorkflowDefinition;
  /** The lease the claim was taken under: only a claim that names its id is released. */
  hold: LeaseHold;
  /** Evidence appended in the release's write, as `release_step` appends it. */
  evidence?: EvidenceSnapshot[];
}

/**
 * What {@link releaseDriveClaim} answers: `released`, `not_released` or `not_ours` (`kind`).
 * Each comes with the snapshot it was judged on or the one the store's settle returned:
 * - `released`: the claim is gone and the step can run again;
 * - `not_released`: the store refused the release, with its own reason;
 * - `not_ours`: the step is not in progress, or its claim names no lease or another; nothing was
 *   written.
 * @beta
 */
export type DriveRelease =
  | { readonly kind: 'released'; readonly snapshot: Snapshot }
  | {
      readonly kind: 'not_released';
      readonly reason: SettlementRefusalReason;
      readonly snapshot: Snapshot;
    }
  | { readonly kind: 'not_ours'; readonly snapshot: Snapshot };

/** The step's claim in `run`, when the step is in progress. */
function claimOf(run: RunRecord, step: string) {
  return run.in_progress_steps.includes(step) ? run.claims?.[step] : undefined;
}

/** `admitWay('run_step')`'s verdict on `step`, judged on `snap` as this program; `undefined` when admitted. */
function judged(
  store: RunStore,
  runId: string,
  step: string,
  options: ClaimStepForDriveOptions,
  snap: Snapshot,
): Unavailable | undefined {
  const admission = admitWay(
    'run_step',
    snap,
    {
      definition: { ok: options.definition },
      enactor: { kind: 'this_program', registry: options.registry },
      store: waysStoreOf(store),
    },
    { run_id: runId, command: step },
  );
  return 'ok' in admission ? undefined : admission;
}

/**
 * A refusal as the drive's answer: `held_elsewhere` is `held_by` (with the other claim's facts on
 * `snap`), `not_eligible` stays itself, and any other code is `refused` with it.
 */
function answerOf(refusal: Unavailable, snap: Snapshot, step: string): DriveClaim {
  if (refusal.code === 'not_eligible') return { kind: 'not_eligible' };
  if (refusal.code !== 'held_elsewhere') return { kind: 'refused', code: refusal.code };
  const claim = claimOf(snap.record, step);
  const lease = leaseFactOf(snap, claim);
  return {
    kind: 'held_by',
    ...(claim?.holder !== undefined ? { holder: claim.holder } : {}),
    ...(claim?.since !== undefined ? { since: claim.since } : {}),
    ...(isLeaseFact(lease) ? { lease } : {}),
  };
}

/**
 * Takes step `stepName`'s claim for this program, under a lease it holds, before the step's work
 * starts.
 * In order: the store keeps no leases ⇒ `unleased_store`
 * (nothing held, read or written); the store's `leases.hold()` cannot make one ⇒ `lease_unavailable`;
 * the run is loaded and the step judged by `admitWay('run_step')` as this program; then the store's
 * `claimStep` writes the claim under the hold ⇒ `claimed`. When the store refuses the claim
 * (`STATE_STEP_ALREADY_CLAIMED`, `STATE_STEP_NOT_ELIGIBLE`), a fresh read is judged again — the step
 * may have settled meanwhile — or the loaded run when that read throws. Every answer but `claimed`
 * closes the hold with the record it was judged on. Any other error is thrown unchanged, after the
 * hold is closed: with no record when `claimStep` threw it (the write may have landed), else with the
 * newest record the call holds, or none.
 * @beta
 */
export async function claimStepForDrive(
  store: RunStore,
  runId: string,
  stepName: string,
  options: ClaimStepForDriveOptions,
): Promise<DriveClaim> {
  admitEntry('claimStepForDrive', {
    store,
    storeKind: 'run store',
    registry: (options as Partial<ClaimStepForDriveOptions> | undefined)?.registry,
    driver: (options as Partial<ClaimStepForDriveOptions> | undefined)?.driver,
    parts: { runId, stepName, options },
  });
  // CW-BC-01: an absent `leases` reads exactly as `null`.
  const leases = store.leases ?? null;
  if (leases === null) return { kind: 'unleased_store' };
  const made = await leases.hold();
  if (!('held' in made)) return { kind: 'lease_unavailable', reason: made.unavailable };
  const hold = made.held;
  /** The newest record this call holds, which a thrown error closes the hold with. */
  let newest: RunRecord | undefined;
  /** Whether the store's `claimStep` threw the error: then the write may have landed. */
  let claimThrew = false;
  try {
    const loaded = await store.get(runId);
    newest = loaded.record;
    const refusal = judged(store, runId, stepName, options, loaded);
    if (refusal !== undefined) {
      hold.close(loaded.record);
      return answerOf(refusal, loaded, stepName);
    }
    let claimed: Snapshot;
    try {
      claimed = await store.claimStep(runId, stepName, options.definition, options.driver, hold);
    } catch (err) {
      if (
        !(err instanceof WorkflowError) ||
        (err.code !== 'STATE_STEP_ALREADY_CLAIMED' && err.code !== 'STATE_STEP_NOT_ELIGIBLE')
      ) {
        claimThrew = true;
        throw err;
      }
      // As `executeChain` does: the fresh record, or the loaded one when it cannot be read.
      const fresh = await store.get(runId).catch(() => loaded);
      newest = fresh.record;
      const again = judged(store, runId, stepName, options, fresh);
      hold.close(fresh.record);
      if (again !== undefined) return answerOf(again, fresh, stepName);
      return err.code === 'STATE_STEP_ALREADY_CLAIMED'
        ? { kind: 'held_by' }
        : { kind: 'not_eligible' };
    }
    return {
      kind: 'claimed',
      hold,
      // The store stamps `since` on every claim, from the claim's one reading (`claimStep`'s doc).
      since: claimed.record.claims?.[stepName]?.since ?? claimed.at.toISOString(),
    };
  } catch (err) {
    hold.close(claimThrew ? undefined : newest);
    throw err;
  }
}

/**
 * Gives back step `stepName`'s claim without settling the step, when that claim names `hold`'s
 * lease.
 * The run is read; the step in progress with its claim naming
 * `hold.id` ⇒ a `release_step` settle under the claim's own token, with `evidence` appended ⇒
 * `released`, or `not_released` with the store's reason; otherwise ⇒ `not_ours`, nothing written. A
 * read or settle that throws is thrown unchanged. It never closes the hold: the caller does, with the
 * record it returns.
 * @beta
 */
export async function releaseDriveClaim(
  store: RunStore,
  runId: string,
  stepName: string,
  options: ReleaseDriveClaimOptions,
): Promise<DriveRelease> {
  admitEntry('releaseDriveClaim', {
    store,
    storeKind: 'run store',
    parts: { runId, stepName, options },
  });
  const read = await store.get(runId);
  const claim = claimOf(read.record, stepName);
  if (claim === undefined || claim.lease?.id !== options.hold.id) {
    return { kind: 'not_ours', snapshot: read };
  }
  const delta: ReleaseStepDelta = {
    kind: 'release_step',
    step: stepName,
    ...(claim.token !== undefined ? { claimToken: claim.token } : {}),
    ...(options.evidence !== undefined ? { evidence: options.evidence } : {}),
  };
  const settled = await store.settleStep(runId, delta, options.definition);
  const snapshot = writtenSnapshot(settled.run, settled.at, settled.lease_facts);
  return settled.applied
    ? { kind: 'released', snapshot }
    : { kind: 'not_released', reason: settled.reason, snapshot };
}
