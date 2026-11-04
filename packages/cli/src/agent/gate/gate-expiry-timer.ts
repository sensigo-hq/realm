// gate-expiry-timer.ts — issue #291, Deliverable 4e: the ATTENDING-PROCESS enactment timer host
// (Amendment 4's "attended runs = canon parity" enactment host — the CLI process holding an open
// gate schedules ONE enactment timer at the frozen `expires_at`). A STANDALONE module (never
// folded into slack-gate-notifier.ts) specifically so run-agent.ts can import it without
// reintroducing the circular dependency slack-gate-notifier.ts's own header comment already
// warns against ("avoids circular dependency with run-agent.ts"). Shared by all THREE wait-sites:
// slack-gate-notifier.ts's `handleBidirectionalGate`, run-agent.ts's non-Slack poll loop, and
// run.ts's interactive prompt.
import {
  parseStamp,
  describeGuardLines,
  drainFinalizers,
  expiryCarriedOutLine,
  expiryReceiptLine,
  expiryReceiptOf,
  unreadableFactsOf,
  WorkflowError,
} from '@sensigo/realm';
import type {
  EnactedVia,
  RunStore,
  WorkflowDefinition,
  PendingGate,
  ExtensionRegistry,
  Attributed,
} from '@sensigo/realm';

/** The `enacted_via` word of this timer's line — a member of core's vocabulary (decision C124). */
const TIMER_VIA: EnactedVia = 'timer';

export interface GateExpiryTimerDeps {
  store: RunStore;
  definition: WorkflowDefinition;
  registry?: ExtensionRegistry;
  /**
   * Issue #625 (holder slice): the program whose timer enacts the expiry — named on the cleanup
   * steps its drain runs (`driven_by`).
   */
  driver?: Attributed;
  /**
   * Called once this timer's own write has carried the expiry out (after its line and its drain) —
   * so a host waiting on the question (`realm workflow run`'s prompt) closes it (decision C158).
   */
  onApplied?: () => void;
}

/**
 * Schedules an `expire_gate` enactment attempt at `gate.expires_at` on the STORE's clock (#715 (b),
 * 03 §A.3; D6-7, D6-8): `deps.store.clock.at` — the system clock re-checks the wall clock in hops of
 * at most a minute, a test clock runs it at the `advance` that reaches it, and a test location's
 * clock when its file does. No-ops (returns a no-op cancel function) for a finding-only gate
 * (`on_expiry` absent) or one with no enforce clock at all (`expires_at` absent, or one that is not an
 * instant) — nothing schedulable, matching every other enactment point's own gating. Enactment
 * refusals/failures are swallowed to a `console.warn` — this is a best-effort ATTENDED lever, never a
 * hard dependency: a race with any OTHER enactment point (submit/execute_step/reclaim/drain
 * --expired/the listen sweeper) is safe by construction via the [F1] arm matrix's NOOPs. The waiter
 * returns its enactment's promise, so a test clock's `advance` awaits it (D6-20). The returned cancel
 * function MUST be called on gate resolution or process exit — every call site wires it into its own
 * `finally`/cleanup.
 */
export function scheduleGateExpiryTimer(
  runId: string,
  gate: PendingGate,
  deps: GateExpiryTimerDeps,
): () => void {
  if (gate.expires_at === undefined || gate.on_expiry === undefined) {
    return (): void => {};
  }
  const expiresAtMs = parseStamp(gate.expires_at);
  if (expiresAtMs === undefined) return (): void => {};
  let cancelled = false;

  const fire = async (): Promise<void> => {
    if (cancelled) return;
    try {
      const delta = { kind: 'expire_gate' as const, gateId: gate.gate_id };
      // #715 (b): the store's clock decides the gate is due, and the settle returns its reading.
      const outcome = await deps.store.settleStep(runId, delta, deps.definition);
      if (outcome.applied) {
        // issue #625: the expiry's write also settled the guards its default made eligible. This
        // timer logs ONE line, so what they did is appended to it: the ending sentence and its
        // `Reason:` when a guard ended the run, otherwise a passed line per guard.
        const guardLines = describeGuardLines(outcome);
        // #729 PR-0 (T-2, G7-18): the timer's line is the expiry receipt's — core's ONE line
        // composer, the same words every enactor's line carries (no second composer here).
        const settledEntry = outcome.run.settled?.[gate.step_name];
        const carried =
          settledEntry?.resolved_by === 'timeout'
            ? {
                on_expiry: 'settle_default' as const,
                choice: settledEntry.choice ?? gate.default_choice ?? '',
              }
            : { on_expiry: 'abort' as const };
        const receipt = expiryReceiptOf(
          { gate_id: gate.gate_id, step: gate.step_name, expires_at: gate.expires_at },
          carried,
          TIMER_VIA,
          outcome.at,
        );
        console.log(
          `⏰ ${receipt !== undefined ? expiryReceiptLine(receipt) : expiryCarriedOutLine(gate.gate_id, gate.step_name, carried, TIMER_VIA, undefined)}` +
            (guardLines.length > 0 ? ` ${guardLines.join(' ')}` : ''),
        );
        if (outcome.transitioned) {
          const drainOutcome = await drainFinalizers(
            deps.store,
            deps.definition,
            deps.registry,
            runId,
            deps.driver,
          );
          for (const w of drainOutcome.warnings) console.warn(`⚠ ${w}`);
        }
        deps.onApplied?.();
      }
      // A refusal (already_settled/not_expired/gate_mismatch/run_terminal) is a benign race with
      // another enactment point — silently absorbed, exactly like enactExpiredGateIfDue's own
      // advisory-not-crash posture.
    } catch (err) {
      // issue #719 (C2, F6.4): when the run's own file cannot be read, every enactment point reads
      // that same file — none can catch the gate until it can be read (a read error) or is repaired
      // (damaged bytes), or is moved out. A retryable read error (EBUSY, EIO) may pass: another
      // enactment point may still catch it.
      const facts = unreadableFactsOf(err);
      const stuck = facts !== undefined && !(err instanceof WorkflowError && err.retryable);
      const until =
        facts?.class === 'unreadable' ? 'can be read or is moved out' : 'is repaired or moved out';
      const tail = stuck
        ? ` — no enactment point can read this run until its file ${until}.`
        : ' — another enactment point (submit/execute_step/reclaim/drain --expired/listen) will ' +
          'still catch it.';
      console.warn(
        `⚠ realm: the attending-process gate-expiry timer failed for run '${runId}' ` +
          `(${err instanceof Error ? err.message : String(err)})${tail}`,
      );
    }
  };

  const cancelWaiter = deps.store.clock.at(new Date(expiresAtMs), () => fire());

  return (): void => {
    cancelled = true;
    cancelWaiter();
  };
}
