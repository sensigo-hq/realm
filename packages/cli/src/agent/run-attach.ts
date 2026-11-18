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
  getWorkflowForRun,
  deriveRunPhase,
  escapedBoundedValue,
  lastExecutionIdentity,
  runEndingOf,
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
 * #625 A1b-2: how an ended run ended, for the refusal — the one ending composer's sentence (from the
 * record only; no workflow is read, so a run whose workflow is gone still gets it), the stored values
 * it quotes (an abandon's reason, a guard's message) rendered through `ctx.escaped` as the `Reason:`
 * line renders its value, and whether it quoted one. `undefined` for a run whose seal is the plain
 * `complete` arm, not classified: the phase says it.
 */
function refusalEnding(
  run: RunRecord,
  ctx: RenderCtx,
): { sentence: string; quotesStoredValue: boolean } | undefined {
  if (run.sealed_by?.arm === 'complete' && run.sealed_by.classified !== true) return undefined;
  let quotesStoredValue = false;
  const ending = runEndingOf(run, undefined, {
    quote: (escaped) => {
      quotesStoredValue = true;
      return ctx.escaped(escaped);
    },
  });
  return ending === undefined ? undefined : { sentence: ending.sentence, quotesStoredValue };
}

/**
 * #625 A1b-2: whether the refusal keeps the `Reason:` line — for a run that did not complete and
 * stores a reason its sentence does not say: a step failure, a handler's abort, a guard's resolution
 * error, and a failed or aborted record with no seal. Left out where the sentence says it: an
 * abandoned run (its reason is in the sentence), a gate expiry's abort (its stored reason is the
 * sentence word for word), and the spawn and extensions failures (Realm's own codes, said in words).
 * A guard's abort stores no reason.
 */
function keepsReasonLine(run: RunRecord): boolean {
  if (run.terminal_reason === undefined) return false;
  const phase = deriveRunPhase(run);
  if (phase === 'completed' || phase === 'abandoned') return false;
  const arm = run.sealed_by?.arm;
  return arm === undefined
    ? phase === 'failed' || phase === 'aborted'
    : arm === 'step_failure' || arm === 'handler_abort' || arm === 'guard_resolution_error';
}

/**
 * #729 PR-3 correction 4 (I-11), #625 A1b-2: whether the ended-run refusal prints a stored value — its
 * `Reason:` line, or a reason or message inside its sentence (the composer says whether it quoted
 * one) — so `realm agent` prints the "Values withheld" line before it while values are withheld.
 */
export function refusalPrintsStoredValue(run: RunRecord): boolean {
  return keepsReasonLine(run) || refusalEnding(run, PLAIN)?.quotesStoredValue === true;
}

/**
 * The refusal `realm agent --run-id` gives a run that has ended — ONE mint, thrown by both
 * carriers: the pre-attach check ({@link resolveRunAttach}) and the agent loop (`runAgent`), so the
 * two can never word it differently (framework rule 3). #729 PR-0 (E1 (d), (e), (j); Table row 55):
 * the run-a-step family's `run_ended`, rendered with how the run ended, from the record (#625
 * A1b-2: the one ending composer's sentence, never who ended it) —
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
  // #625 A1b-2: how it ended, from the record only — never who ended it (Realm never claims who was
  // on the other end).
  const ending = refusalEnding(run, ctx);
  const lines = [
    `Run ${runId} has already ended (${ctx.word(phase, RUN_PHASE_WORDS)}).${ending === undefined ? '' : ` ${ending.sentence}`}`,
  ];
  if (run.terminal_reason !== undefined && keepsReasonLine(run)) {
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
  let { record: run } = await deps.store.get(runId);

  if (run.terminal_state) {
    // issue #367 (part 3): the recorded arm, or the legacy literal ({@link reattachable}).
    if (reattachable(run)) {
      // Pure retry: nothing executed pre-failure. Clear exactly this marker and proceed.
      // issue #367: `sealed_by` joins the strip — this is a resume-class write (terminal → live),
      // so the seal fact leaves in the SAME write that flips terminal_state:false.
      const { terminal_reason: _cleared, sealed_by: _sb, ...rest } = run;
      await deps.store.update({ ...rest, terminal_state: false });
      run = (await deps.store.get(runId)).record;
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
      const { record: fresh } = await deps.store.get(runId);
      if (
        !fresh.terminal_state &&
        fresh.evidence.length === 0 &&
        fresh.pending_gate === undefined
      ) {
        // issue #367: run-level seal through the ONE bypass-writer chokepoint (`sealRunLevel`) — it
        // stamps sealed_by {arm: 'extensions_load_failure'}. The identity entry rides the same
        // single write. #715 (b) (D-21): through the `seal_run` settlement delta — the seal's
        // instant is the write's own reading, the identity entry's `captured_at` is carried
        // verbatim (D6-67), and a run that moved since this read is thrown as
        // STATE_SNAPSHOT_MISMATCH and reported below, as update() threw. No definition: the load
        // that failed may be the definition's own (Amendment 1).
        await deps.store.settleStep(runId, {
          kind: 'seal_run',
          arm: 'extensions_load_failure',
          reason: EXTENSIONS_LOAD_FAILED,
          expected_version: fresh.version,
          release_claims: false,
          identity_entry: errorExtensionIdentityEntry(
            `extension load failed: ${err instanceof Error ? err.message : String(err)}`,
            opts?.overrideModule !== undefined ? { overrideActive: true } : {},
          ),
        });
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
