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
import type {
  RunStore,
  WorkflowRegistrar,
  WorkflowDefinition,
  ExtensionRegistry,
  ExtensionManifest,
} from '@sensigo/realm';
import { loadProjectExtensions } from '../extensions/load-project-extensions.js';

/** Terminal reason written when extension loading fails before a run has started executing. */
export const EXTENSIONS_LOAD_FAILED = 'extensions_load_failed';

export interface ResolveRunAttachDeps {
  store: RunStore;
  workflowStore: Pick<WorkflowRegistrar, 'get'>;
  /** DI seam for tests — defaults to the real loader. */
  loadExtensions?: typeof loadProjectExtensions;
}

export interface ResolveRunAttachResult {
  definition: WorkflowDefinition;
  registry: ExtensionRegistry;
  manifest: ExtensionManifest;
}

/**
 * Resolves everything `realm agent --run-id` needs before the run is claimed:
 * the stored definition and the extension registry/manifest, with the v4 failure and
 * re-attach semantics described above.
 */
export async function resolveRunAttach(
  runId: string,
  deps: ResolveRunAttachDeps,
  opts?: { overrideModule?: string },
): Promise<ResolveRunAttachResult> {
  let run = await deps.store.get(runId);

  if (run.terminal_state) {
    if (run.terminal_reason === EXTENSIONS_LOAD_FAILED) {
      // Pure retry: nothing executed pre-failure. Clear exactly this marker and proceed.
      const { terminal_reason: _cleared, ...rest } = run;
      await deps.store.update({ ...rest, terminal_state: false });
      run = await deps.store.get(runId);
    } else {
      // Same refusal (and message) the agent loop raises today — thrown BEFORE any
      // extension code loads.
      throw new Error(
        `Run ${runId} is already in terminal state: ${run.terminal_reason ?? run.run_phase}`,
      );
    }
  }

  const definition = await deps.workflowStore.get(run.workflow_id);
  const loadExtensions = deps.loadExtensions ?? loadProjectExtensions;

  try {
    const { registry, manifest } = await loadExtensions(
      definition,
      opts?.overrideModule !== undefined ? { overrideModule: opts.overrideModule } : {},
    );
    return { definition, registry, manifest };
  } catch (err) {
    // Not-yet-started guard: mark only pre-execution runs; never mutate an in-flight or
    // already-terminal run. Double failure (store write also fails) → stderr, error still
    // propagates (exit nonzero) — same handling class as listen's spawn_failed.
    try {
      const fresh = await deps.store.get(runId);
      if (
        !fresh.terminal_state &&
        fresh.evidence.length === 0 &&
        fresh.pending_gate === undefined
      ) {
        fresh.terminal_state = true;
        fresh.terminal_reason = EXTENSIONS_LOAD_FAILED;
        fresh.run_phase = 'failed';
        await deps.store.update(fresh);
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
