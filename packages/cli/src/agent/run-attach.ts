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
import {
  sealRunLevel,
  getWorkflowForRun,
  deriveRunPhase,
  escapedBoundedValue,
  lastExecutionIdentity,
} from '@sensigo/realm';
import type {
  LoaderWarning,
  RunRecord,
  RunStore,
  WorkflowRegistrar,
  WorkflowDefinition,
} from '@sensigo/realm';
import {
  loadProjectExtensions,
  type LoadedProjectExtensions,
} from '../extensions/load-project-extensions.js';
import { identityDiffers, errorExtensionIdentityEntry } from '../extensions/extension-identity.js';
// #729 PR-3 (L-2): this message is thrown, not printed, so its command takes the PLAIN context.
import { PLAIN, RUN_PHASE_WORDS, type RenderCtx } from '../output/writer.js';

/** Terminal reason written when extension loading fails before a run has started executing. */
export const EXTENSIONS_LOAD_FAILED = 'extensions_load_failed';

/**
 * Whether an ended run is re-attached (its extensions failed to load before it executed anything)
 * rather than refused. issue #367 (part 3): key on the recorded ARM, with the prose literal as the
 * fallback for records written before the arm existed. `||` and not `??` on purpose — the left side
 * is always a boolean, so `??` would never fire and the legacy fallback would be dead code. The
 * literal leaves for good once the corpus is swept. #729 PR-3 correction 4 (I-11): one predicate,
 * read by `resolveRunAttach` and by `realm agent`'s manifest read before the refusal.
 */
export function reattachable(run: RunRecord): boolean {
  return (
    run.sealed_by?.arm === 'extensions_load_failure' ||
    run.terminal_reason === EXTENSIONS_LOAD_FAILED
  );
}

/**
 * Who ended a run, from its record (#729 PR-0, E1 (d)): an operator (`abandoned`), a guard (its seal
 * arm names the guard step), a step that failed, a declared expiry, or nothing to name (a run that
 * completed). A clause after the run's phase, or empty.
 */
function endedBy(run: RunRecord): string {
  const arm = run.sealed_by?.arm;
  const step = run.sealed_by?.step;
  if (deriveRunPhase(run) === 'abandoned') return ': an operator ended it';
  if ((arm === 'guard_abort' || arm === 'guard_resolution_error') && step !== undefined) {
    return `: guard '${step}' ended it`;
  }
  if (arm === 'handler_abort' && step !== undefined) return `: step '${step}' ended it`;
  if (arm === 'gate_expiry_abort')
    return ': its question expired, and its declared on_expiry ended it';
  if (arm === 'step_failure' && step !== undefined) return `: step '${step}' failed`;
  return '';
}

/**
 * The refusal `realm agent --run-id` gives a run that has ended — ONE mint, thrown by both
 * carriers: the pre-attach check ({@link resolveRunAttach}) and the agent loop (`runAgent`), so the
 * two can never word it differently (framework rule 3). #729 PR-0 (E1 (d), (e), (j); Table row 55):
 * the run-a-step family's `run_ended`, rendered with who ended the run and why from the record —
 * Realm's own sentence ends with Realm's stop; the recorded reason is stored text, printed after a
 * label as written through the one escaped, bounded value renderer, with no stop added; and the
 * command that delivers cleanup steps left pending ends its own line (C212). The phase is worked out
 * from the record, never the stored `run_phase` (PHASE_IS_GENERATED, `eligibility.ts`).
 *
 * issue #279 (increment 1, PR-B), design record §6: a run that still carries an undelivered
 * finalizer is pointed at the recovery verb.
 */
export function terminalRunRefusal(runId: string, run: RunRecord, ctx: RenderCtx = PLAIN): Error {
  const phase = deriveRunPhase(run);
  // #729 PR-3 correction 3 (H-8): the phase is realm's own word. `ctx` is the CLI's writer context
  // on the pre-attach carrier, so it prints whole; the library carrier (`runAgent`) passes none and
  // its message carries no span mark (I13).
  const lines = [
    `Run ${runId} has already ended (${ctx.word(phase, RUN_PHASE_WORDS)})${endedBy(run)}.`,
  ];
  if (run.terminal_reason !== undefined && phase !== 'completed') {
    // Correction 4 (I-11): the stored reason is a value — its shape while the run's declared values
    // are withheld (the CLI read its manifest first); PLAIN leaves it as written.
    lines.push(`Reason: ${ctx.escaped(escapedBoundedValue(run.terminal_reason))}`);
  }
  const pendingFinalizerCount = Object.values(run.finalizer_ledger ?? {}).filter(
    (e) => e.status === 'pending',
  ).length;
  if (pendingFinalizerCount > 0) {
    lines.push(
      // eslint-disable-next-line no-restricted-syntax -- an Error's message, returned to a caller that may keep it (runAgent is a library API), so it carries no span mark; the writer masks the line it is printed on (#729 PR-3, F26).
      `${pendingFinalizerCount} cleanup ${pendingFinalizerCount === 1 ? 'step is' : 'steps are'} not yet delivered — to deliver ${pendingFinalizerCount === 1 ? 'it' : 'them'}: ${PLAIN.cmd(`realm run drain ${runId}`)}`,
    );
  }
  return new Error(lines.join('\n'));
}

export interface ResolveRunAttachDeps {
  store: RunStore;
  workflowStore: Pick<WorkflowRegistrar, 'get'>;
  /** The CLI's writer context, for the ended-run refusal's spans (#729 PR-3 correction 3, H-8). */
  ctx?: RenderCtx;
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
  opts?: {
    overrideModule?: string;
    projectDir?: string;
    onReleaseLineWarning?: (warning: LoaderWarning) => void;
  },
): Promise<ResolveRunAttachResult> {
  let run = await deps.store.get(runId);

  if (run.terminal_state) {
    // issue #367 (part 3): the recorded arm, or the legacy literal ({@link reattachable}).
    if (reattachable(run)) {
      // Pure retry: nothing executed pre-failure. Clear exactly this marker and proceed.
      // issue #367: `sealed_by` joins the strip — this is a resume-class write (terminal → live),
      // so the seal fact leaves in the SAME write that flips terminal_state:false.
      const { terminal_reason: _cleared, sealed_by: _sb, ...rest } = run;
      await deps.store.update({ ...rest, terminal_state: false });
      run = await deps.store.get(runId);
    } else {
      // Same refusal (and message) the agent loop raises — thrown BEFORE any extension code loads.
      throw terminalRunRefusal(runId, run, deps.ctx);
    }
  }

  // #401's remediation for a failed drive is "re-attach with --run-id". For a run created from a
  // FILE without --register, that is a dead end the operator cannot see from here: the workflow
  // was never persisted, the attach fails with a bare "Workflow not found", and `--run-id
  // --workflow` is mutually exclusive — so the advice names the one thing that cannot work.
  //
  // issue #456: the hedge reasoning, and the code-keyed wrap itself, now live at
  // `getWorkflowForRun` (packages/core/src/workflow/registrar.ts) — this call site's own
  // dependency type (`Pick<WorkflowRegistrar, 'get'>`, above) is exactly what forced the helper's
  // narrowed signature, since every other run-context site passes a full registrar.
  const definition: WorkflowDefinition = await getWorkflowForRun(deps.workflowStore, run, {
    retryVerb: 're-attach',
    verb: 're-attach',
  });
  const loadExtensions = deps.loadExtensions ?? loadProjectExtensions;

  try {
    const loaded = await loadExtensions(definition, {
      ...(opts?.overrideModule !== undefined ? { overrideModule: opts.overrideModule } : {}),
      ...(opts?.projectDir !== undefined ? { projectDir: opts.projectDir } : {}),
      // issue #620 PR-C: listen's children pass a silent sink; it must travel (the #353 class).
      ...(opts?.onReleaseLineWarning !== undefined
        ? { onReleaseLineWarning: opts.onReleaseLineWarning }
        : {}),
    });
    const { registry } = loaded;

    // Drift evidence (issue #119): WARN immediately when the freshly loaded identity
    // differs from the run's LAST recorded identity. Advisory only — never a gate, and
    // NO pre-claim write on the success path (a pre-claim CAS bump would kill a live
    // driver's in-flight step update). The append lands via the core lazy
    // append-on-change site after this attacher claims a step.
    const freshIdentity = registry.identity;
    const history = run.extension_identity ?? [];
    // #729 PR-3 correction 5 (J-5): drift is judged from execution entries; a start entry is not one.
    const lastIdentity = lastExecutionIdentity(history);
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
