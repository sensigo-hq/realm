// gate-expiry-timer.ts — issue #291, Deliverable 4e: the ATTENDING-PROCESS enactment timer host
// (Amendment 4's "attended runs = canon parity" enactment host — the CLI process holding an open
// gate schedules ONE enactment timer at the frozen `expires_at`). A STANDALONE module (never
// folded into slack-gate-notifier.ts) specifically so run-agent.ts can import it without
// reintroducing the circular dependency slack-gate-notifier.ts's own header comment already
// warns against ("avoids circular dependency with run-agent.ts"). Shared by all THREE wait-sites:
// slack-gate-notifier.ts's `handleBidirectionalGate`, run-agent.ts's non-Slack poll loop, and
// run.ts's interactive prompt.
import { applySettlement, drainFinalizers } from '@sensigo/realm';
import type {
  RunStore,
  WorkflowDefinition,
  PendingGate,
  ExtensionRegistry,
  SettlementResult,
} from '@sensigo/realm';

/** Node's `setTimeout` delay is a 32-bit signed int; a delay exceeding 2^31-1 ms (~24.8 days)
 *  overflows and fires IMMEDIATELY instead of throwing or clamping (lane-1 F-7) — self-reschedule
 *  in MAX_TIMEOUT_MS-sized hops so a >24.8-day `timeout_seconds` still gets an attended enactment
 *  at its REAL deadline, not instantly. The [F1] `not_expired` arm makes even an accidental
 *  premature fire safe (a harmless refusal, never a wrong enactment) — this clamping exists for
 *  ATTENDED-LIVENESS correctness (don't lose the attended lever for long timeouts), not safety. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

export interface GateExpiryTimerDeps {
  store: RunStore;
  definition: WorkflowDefinition;
  registry?: ExtensionRegistry;
}

/**
 * Schedules an `expire_gate` enactment attempt at `gate.expires_at` — a self-rescheduling
 * `setTimeout` chain when the delay exceeds Node's 32-bit ceiling. No-ops (returns a no-op cancel
 * function) for a finding-only gate (`on_expiry` absent) or one with no enforce clock at all
 * (`expires_at` absent) — nothing schedulable, matching every other enactment point's own gating.
 * Enactment refusals/failures are swallowed to a `console.warn` — this is a best-effort ATTENDED
 * lever, never a hard dependency: a race with any OTHER enactment point (submit/execute_step/
 * reclaim/drain --expired/the listen sweeper) is safe by construction via the [F1] arm matrix's
 * NOOPs. The returned cancel function MUST be called on gate resolution or process exit — every
 * call site wires it into its own `finally`/cleanup.
 */
export function scheduleGateExpiryTimer(
  runId: string,
  gate: PendingGate,
  deps: GateExpiryTimerDeps,
): () => void {
  if (gate.expires_at === undefined || gate.on_expiry === undefined) {
    return (): void => {};
  }
  const expiresAtMs = new Date(gate.expires_at).getTime();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;

  const fire = async (): Promise<void> => {
    if (cancelled) return;
    const remainingMs = expiresAtMs - Date.now();
    if (remainingMs > 0) {
      schedule(remainingMs);
      return;
    }
    try {
      const delta = { kind: 'expire_gate' as const, gateId: gate.gate_id };
      let outcome: SettlementResult;
      if (deps.store.settleStep !== undefined) {
        outcome = await deps.store.settleStep(runId, delta, deps.definition, { now: new Date() });
      } else {
        const fresh = await deps.store.get(runId);
        const pure = applySettlement(fresh, delta, deps.definition, { now: new Date() });
        outcome = pure.applied ? { ...pure, run: await deps.store.update(pure.run) } : pure;
      }
      if (outcome.applied) {
        console.log(
          `⏰ gate '${gate.gate_id}' on run '${runId}' expired — enacted via the attending-process timer (enacted_via: timer).`,
        );
        if (outcome.transitioned) {
          const drainOutcome = await drainFinalizers(
            deps.store,
            deps.definition,
            deps.registry,
            runId,
          );
          for (const w of drainOutcome.warnings) console.warn(`⚠ ${w}`);
        }
      }
      // A refusal (already_settled/not_expired/gate_mismatch/run_terminal) is a benign race with
      // another enactment point — silently absorbed, exactly like enactExpiredGateIfDue's own
      // advisory-not-crash posture.
    } catch (err) {
      console.warn(
        `⚠ realm: the attending-process gate-expiry timer failed for run '${runId}' ` +
          `(${err instanceof Error ? err.message : String(err)}) — another enactment point ` +
          `(submit/execute_step/reclaim/drain --expired/listen) will still catch it.`,
      );
    }
  };

  const schedule = (delayMs: number): void => {
    const clamped = Math.max(0, Math.min(delayMs, MAX_TIMEOUT_MS));
    timer = setTimeout(() => void fire(), clamped);
  };
  schedule(expiresAtMs - Date.now());

  return (): void => {
    cancelled = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}
