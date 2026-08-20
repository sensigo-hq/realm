// run-attach.ts — pre-attach resolution for `realm agent --run-id` (project extensions, v4).
//
// Invariant: "fail before claim, OR fail the run visibly."
//  - Re-attach: a run whose terminal_reason is exactly 'extensions_load_failed' has executed
//    nothing — clearing the marker and retrying is pure. Every other terminal reason keeps
//    today's refusal (thrown BEFORE any extension code is loaded).
//  - Extension modules load BEFORE the run is claimed.
//  - On load failure: if the run has NOT begun executing (no evidence entries, not terminal),
//    write terminal_reason 'extensions_load_failed' + terminal state (mirrors the listen
//    spawn_failed mechanics) so listen-spawned children fail their runs visibly; if it HAS
//    begun executing, propagate the error with NO run mutation — a failed bystander attach
//    can never kill a healthy in-flight run.
import { sealRunLevel } from '@sensigo/realm';
import type { RunStore, WorkflowRegistrar, WorkflowDefinition } from '@sensigo/realm';
import {
  loadProjectExtensions,
  type LoadedProjectExtensions,
} from '../extensions/load-project-extensions.js';
import { identityDiffers, errorExtensionIdentityEntry } from '../extensions/extension-identity.js';

/** Terminal reason written when extension loading fails before a run has started executing. */
export const EXTENSIONS_LOAD_FAILED = 'extensions_load_failed';

export interface ResolveRunAttachDeps {
  store: RunStore;
  workflowStore: Pick<WorkflowRegistrar, 'get'>;
  /** DI seam for tests — defaults to the real loader. */
  loadExtensions?: typeof loadProjectExtensions;
}

export type ResolveRunAttachResult = { definition: WorkflowDefinition } & LoadedProjectExtensions;

/**
 * Resolves everything `realm agent --run-id` needs before the run is claimed:
 * the stored definition and the extension registry/manifest, with the v4 failure and
 * re-attach semantics described above.
 */
export async function resolveRunAttach(
  runId: string,
  deps: ResolveRunAttachDeps,
  opts?: { overrideModule?: string; projectDir?: string },
): Promise<ResolveRunAttachResult> {
  let run = await deps.store.get(runId);

  if (run.terminal_state) {
    if (run.terminal_reason === EXTENSIONS_LOAD_FAILED) {
      // Pure retry: nothing executed pre-failure. Clear exactly this marker and proceed.
      // issue #367: `sealed_by` joins the strip — this is a resume-class write (terminal → live),
      // so the seal fact leaves in the SAME write that flips terminal_state:false.
      const { terminal_reason: _cleared, sealed_by: _sb, ...rest } = run;
      await deps.store.update({ ...rest, terminal_state: false });
      run = await deps.store.get(runId);
    } else {
      // Same refusal (and message) the agent loop raises today — thrown BEFORE any
      // extension code loads.
      //
      // issue #279 (increment 1, PR-B), design record §6: point at the recovery verb when the
      // terminal run this attach targeted still carries an undelivered finalizer.
      const pendingFinalizerCount = Object.values(run.finalizer_ledger ?? {}).filter(
        (e) => e.status === 'pending',
      ).length;
      const drainHint =
        pendingFinalizerCount > 0
          ? ` ${pendingFinalizerCount} finalizer(s) not yet delivered — realm run drain ${runId}.`
          : '';
      throw new Error(
        `Run ${runId} is already in terminal state: ${run.terminal_reason ?? run.run_phase}.${drainHint}`,
      );
    }
  }

  const definition = await deps.workflowStore.get(run.workflow_id);
  const loadExtensions = deps.loadExtensions ?? loadProjectExtensions;

  try {
    const loaded = await loadExtensions(definition, {
      ...(opts?.overrideModule !== undefined ? { overrideModule: opts.overrideModule } : {}),
      ...(opts?.projectDir !== undefined ? { projectDir: opts.projectDir } : {}),
    });
    const { registry } = loaded;

    // Drift evidence (issue #119): WARN immediately when the freshly loaded identity
    // differs from the run's LAST recorded identity. Advisory only — never a gate, and
    // NO pre-claim write on the success path (a pre-claim CAS bump would kill a live
    // driver's in-flight step update). The append lands via the core lazy
    // append-on-change site after this attacher claims a step.
    const freshIdentity = registry.identity;
    const history = run.extension_identity ?? [];
    const lastIdentity = history[history.length - 1];
    if (
      freshIdentity !== undefined &&
      lastIdentity !== undefined &&
      identityDiffers(lastIdentity, freshIdentity)
    ) {
      console.error(
        `[realm] WARN: extension code identity differs from this run's last recorded identity — ` +
          `recorded tree_hash ${lastIdentity.tree.tree_hash || '(none)'} (captured ${lastIdentity.captured_at}), ` +
          `current tree_hash ${freshIdentity.tree.tree_hash || '(none)'} (captured ${freshIdentity.captured_at}). ` +
          `Advisory only — the run proceeds; the new identity is appended to the run's history at the next step.`,
      );
    }

    return { definition, ...loaded };
  } catch (err) {
    // Not-yet-started guard: mark only pre-execution runs; never mutate an in-flight or
    // already-terminal run. Double failure (store write also fails) → stderr, error still
    // propagates (exit nonzero) — same handling class as listen's spawn_failed.
    // The failed load is itself drift evidence: the extensions_load_failed write carries
    // an identity entry with `error` set, so the repair loop gets its before/after pair.
    // When the run has begun executing nothing is mutated — no error entry either (the
    // pair lands via the post-claim append on a successful re-attach); this asymmetry is
    // deliberate.
    try {
      const fresh = await deps.store.get(runId);
      if (
        !fresh.terminal_state &&
        fresh.evidence.length === 0 &&
        fresh.pending_gate === undefined
      ) {
        // issue #367: run-level seal through the ONE bypass-writer chokepoint — it stamps
        // sealed_by {arm: 'extensions_load_failure'}; the fossil hand-written run_phase is
        // retired (the store write tail derives it) and the field-assignment writer shape is
        // gone. The identity entry rides the same single write.
        await deps.store.update(
          sealRunLevel(
            {
              ...fresh,
              extension_identity: [
                ...(fresh.extension_identity ?? []),
                errorExtensionIdentityEntry(
                  `extension load failed: ${err instanceof Error ? err.message : String(err)}`,
                  opts?.overrideModule !== undefined ? { overrideActive: true } : {},
                ),
              ],
            },
            'extensions_load_failure',
            EXTENSIONS_LOAD_FAILED,
          ),
        );
      }
    } catch (writeErr) {
      console.error(
        `Failed to mark run '${runId}' as ${EXTENSIONS_LOAD_FAILED}: ${
          writeErr instanceof Error ? writeErr.message : String(writeErr)
        }`,
      );
    }
    throw err;
  }
}
