// reclaim command — detect or recover an after-claim wedge (issue #101).
//
// Phase 1 (per-step): `realm run reclaim <run-id>` is a DRY-RUN; `--step <name> --force` reclaims one
// named claim (the ONLY way to override an unknown-age / non-idempotent / healthy claim, by explicit
// human judgment). Phase 2 (batch): `realm run reclaim --all [...]` auto-reclaims — DRY-RUN by
// default, `--force` to act — ONLY claims that are provably safe: author-declared `idempotent`,
// carrying a concrete past-deadline (`claim_stale`), non-gated. Everything else stays per-step-only.
import { Command } from 'commander';
import type { RunRecord, StepDefinition, InProgressClaimInfo, ReclaimResult } from '@sensigo/realm';
import { parseDuration } from '../lib/parse-duration.js';

/**
 * Pure outcome→(glyph, message) renderer (issue #221 [M4]) — the SINGLE source of both reclaim
 * CLI messages, shared by batch mode (`--all`) and per-step mode. Extracted (the `isAutoReclaimable`
 * precedent above) because the `.action` handler hard-wires a real `JsonFileStore` and is not
 * unit-reachable; this function IS. `✓` marks the one MUTATING outcome (`reclaimed`); every other
 * outcome — including the new `no_active_claim` — gets the NEUTRAL glyph `•` (the house
 * informational bullet: gc.ts:463, purge.ts:419, reclaim.ts's own dry-run listing above). The
 * `no_active_claim` message text is EXACT (never "still eligible" — unverifiable without the
 * definition, which this command does not load).
 */
export function renderReclaimOutcome(
  result: Pick<ReclaimResult, 'step' | 'outcome' | 'priorState'>,
): { glyph: string; message: string } {
  switch (result.outcome) {
    case 'reclaimed':
      return {
        glyph: '✓',
        message: `Reclaimed '${result.step}' (was ${result.priorState}). It is eligible again — the next driver will re-drive it.`,
      };
    case 'taken_over':
      return {
        glyph: '•',
        message: `'${result.step}' was re-claimed by a live driver during reclaim — left untouched (not stomped).`,
      };
    case 'already_settled':
      return {
        glyph: '•',
        message: `'${result.step}' is already settled — no active claim to reclaim.`,
      };
    case 'no_active_claim':
      return {
        glyph: '•',
        message: `no active claim on '${result.step}' and it is not settled — nothing to reclaim. If its dependencies are satisfied, driving the run will execute it.`,
      };
  }
}

/**
 * The SAFETY-CRITICAL selection rule for `--all` auto-reclaim (issue #101 Phase 2, §3).
 * A claim is auto-reclaimable IFF ALL hold:
 *  1. the run is non-terminal;
 *  2. the step is an in-progress claim (guaranteed — `claim` comes from classifyInProgressClaims);
 *  3. the claim carries a CONCRETE deadline that has passed — i.e. state === 'claim_stale'
 *     (never 'claim_unknown_age' [null/absent deadline] and never 'healthy' [within deadline]);
 *  4. if `--older-than` is set, additionally (now − deadline) ≥ the grace margin;
 *  5. the step is author-declared `idempotent: true` in the workflow definition;
 *  6. the step is NOT the open gate.
 * `--force` acts on exactly this set — it NEVER widens it to unknown-age / non-idempotent / healthy /
 * gated claims (those remain per-step `--step <S> --force` only). A null/absent deadline is never
 * past-deadline, so the finalizer crash-wedge (deadline: null ⇒ claim_unknown_age) is structurally
 * excluded from the cron — intended, not a gap.
 */
export function isAutoReclaimable(
  run: Pick<RunRecord, 'terminal_state' | 'pending_gate'>,
  claim: InProgressClaimInfo,
  stepDef: StepDefinition | undefined,
  opts: { olderThanMs?: number; now: number },
): boolean {
  if (run.terminal_state) return false; // §3.1
  if (claim.state !== 'claim_stale') return false; // §3.3 + §3.4a — concrete deadline AND past it
  if (claim.step === run.pending_gate?.step_name) return false; // §3.6 — never the gated step
  if (stepDef?.idempotent !== true) return false; // §3.5 — requires the resolved definition
  if (opts.olderThanMs !== undefined) {
    // §3.4b — a null deadline is NEVER "old enough" (defensive; claim_stale already implies concrete).
    if (claim.deadline === null) return false;
    if (opts.now - new Date(claim.deadline).getTime() < opts.olderThanMs) return false;
  }
  return true;
}

export const reclaimCommand = new Command('reclaim')
  .description('Detect or recover a wedged run (a step claimed but never settled)')
  .argument('[run-id]', 'ID of the run to inspect (default) or reclaim; omit when using --all')
  .option('--step <name>', 'Reclaim this specific in-progress claim (requires --force)')
  .option('--force', 'Actually reclaim — re-drives the step(s); side effects may repeat')
  .option(
    '--all',
    'Batch mode: auto-reclaim every idempotent, concrete-past-deadline, non-gated claim (dry-run without --force)',
  )
  .option('--workflow <id>', 'With --all: only consider runs of this workflow')
  .option(
    '--older-than <duration>',
    'With --all: only claims past deadline by ≥ this (e.g. 30m, 6h)',
  )
  .action(
    async (
      runId: string | undefined,
      opts: {
        step?: string;
        force?: boolean;
        all?: boolean;
        workflow?: string;
        olderThan?: string;
      },
    ) => {
      const { JsonFileStore, JsonWorkflowStore, reclaimStep, classifyInProgressClaims } =
        await import('@sensigo/realm');
      const { JsonTraceBufferStore } = await import('@sensigo/realm-mcp');
      const store = new JsonFileStore();
      // issue #198: wire the trace buffer so a reclaim clears the reclaimed step's stale WAL —
      // without this, reclaimStep's own clearStaleWal hook is inert (traceBufferStore stays
      // undefined) and the next attempt adopts the dead attempt's buffered lines, which is the
      // mechanical reason a sequential-abandon-then-retry is #185's dominant "adopted a
      // prior/concurrent writer's lines" population.
      const traceBufferStore = new JsonTraceBufferStore(store.runsDirPath);

      // Loud-fail on a store that cannot persist the claim clock (liveness recovery unavailable).
      if (!store.persistsClaims) {
        console.error(
          'This store does not persist claims; liveness recovery is unavailable on this store.',
        );
        process.exit(1);
      }

      // ============================ Batch mode (Phase 2) ============================
      if (opts.all === true) {
        if (runId !== undefined) {
          console.error('Cannot combine a <run-id> with --all. Use one or the other.');
          process.exit(1);
        }
        if (opts.step !== undefined) {
          console.error('--step is a per-run flag; it cannot be combined with --all.');
          process.exit(1);
        }
        let olderThanMs: number | undefined;
        if (opts.olderThan !== undefined) {
          try {
            olderThanMs = parseDuration(opts.olderThan);
          } catch (err) {
            console.error(err instanceof Error ? err.message : String(err));
            process.exit(1);
          }
        }

        const workflowStore = new JsonWorkflowStore();
        const now = Date.now();
        const nowDate = new Date(now);
        const selected: Array<{ runId: string; claim: InProgressClaimInfo }> = [];
        try {
          const runs = await store.list(opts.workflow);
          for (const run of runs) {
            if (run.terminal_state) continue;
            const claims = classifyInProgressClaims(run, nowDate);
            if (claims.length === 0) continue;
            // Resolve the definition to read the `idempotent` hint. Unresolvable → cannot confirm
            // idempotent → exclude every claim (safe: never auto-reclaim an unverifiable step).
            const def = await workflowStore.get(run.workflow_id).catch(() => undefined);
            for (const claim of claims) {
              const stepDef = def?.steps[claim.step];
              const selOpts = olderThanMs !== undefined ? { olderThanMs, now } : { now };
              if (isAutoReclaimable(run, claim, stepDef, selOpts)) {
                selected.push({ runId: run.id, claim });
              }
            }
          }
        } catch (err) {
          console.error(err instanceof Error ? err.message : String(err));
          process.exit(1);
        }

        if (selected.length === 0) {
          console.log(
            'No auto-reclaimable claims found (idempotent ∧ concrete-past-deadline ∧ non-gated).',
          );
          return;
        }

        if (opts.force !== true) {
          // DRY-RUN (default): report what WOULD be reclaimed; mutate nothing.
          console.log(
            `${selected.length} claim(s) WOULD be auto-reclaimed (idempotent ∧ past-deadline ∧ non-gated):`,
          );
          for (const { runId: rid, claim } of selected) {
            const ageMin = Math.round((now - new Date(claim.deadline!).getTime()) / 60_000);
            console.log(
              `  • ${rid} / ${claim.step}  (deadline ${claim.deadline}, ${ageMin}m past)`,
            );
          }
          console.log(
            `\nRe-run with --force to reclaim them. WARNING: each re-executes its handler ` +
              `at-least-once with NO per-step human judgment — enable only for genuinely idempotent handlers.`,
          );
          return;
        }

        // --force: reclaim each selected claim, one CAS each, continue-on-error across claims.
        console.warn(
          `⚠ Auto-reclaiming ${selected.length} claim(s); each re-executes its handler — side effects may repeat.`,
        );
        let reclaimed = 0;
        for (const { runId: rid, claim } of selected) {
          try {
            const result = await reclaimStep(store, rid, claim.step, { traceBufferStore });
            if (result.outcome === 'reclaimed') reclaimed += 1;
            const { glyph, message } = renderReclaimOutcome(result);
            console.log(`  ${glyph} ${rid}: ${message}`);
          } catch (err) {
            // continue-on-error: one CAS mismatch/failure must not abort the batch.
            console.error(
              `  ✗ ${rid} / ${claim.step}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
        console.log(`Reclaimed ${reclaimed}/${selected.length} selected claim(s).`);
        return;
      }

      // ==================== Per-step / single-run mode (Phase 1) ====================
      if (opts.workflow !== undefined || opts.olderThan !== undefined) {
        console.error('--workflow and --older-than are only valid with --all.');
        process.exit(1);
      }
      if (runId === undefined) {
        console.error('Provide a <run-id> to inspect/reclaim, or use --all for batch mode.');
        process.exit(1);
      }

      // --force without --step: refuse (must name the claim to act on — no blanket sweep here).
      if (opts.force === true && opts.step === undefined) {
        console.error(
          '--force requires --step <name> (or use --all for batch). Run without arguments to see a dry-run.',
        );
        process.exit(1);
      }

      try {
        const run = await store.get(runId);

        // --- Reclaim path: --step (+ --force) ---
        if (opts.step !== undefined) {
          if (opts.force !== true) {
            console.error(
              `Refusing to reclaim '${opts.step}' without --force. Re-run with --force to re-drive it ` +
                `(the step re-executes; its side effects may repeat).`,
            );
            process.exit(1);
          }
          const info = classifyInProgressClaims(run).find((c) => c.step === opts.step);
          if (info?.state === 'healthy') {
            console.warn(
              `⚠ '${opts.step}' currently has a HEALTHY claim (a live runner is presumed on it). ` +
                `--force will override it and may double-drive live work.`,
            );
          }
          console.warn(
            `⚠ Reclaiming '${opts.step}' on run '${runId}' — this re-drives the step; ` +
              `its side effects may repeat.`,
          );
          const result = await reclaimStep(store, runId, opts.step, { traceBufferStore });
          console.log(renderReclaimOutcome(result).message);
          return;
        }

        // --- Dry-run (default): report the run's in-progress claims, no mutation ---
        if (run.terminal_state) {
          console.log(
            `Run '${runId}' is terminal (${run.run_phase}); it has no reclaimable claim.`,
          );
          return;
        }
        const infos = classifyInProgressClaims(run);
        if (infos.length === 0) {
          console.log(
            `Run '${runId}' (${run.run_phase}) has no in-progress claims. Nothing to reclaim.`,
          );
          return;
        }
        console.log(`Run '${runId}' (${run.run_phase}) — in-progress claims:`);
        for (const c of infos) {
          const gated = run.pending_gate?.step_name === c.step;
          const deadline = c.deadline ?? 'none (unknown age)';
          console.log(`  • ${c.step}: ${c.state}  (deadline: ${deadline})`);
          if (gated) {
            console.log(`      open gate — resolve via 'realm run respond ${runId}', not reclaim.`);
          } else if (c.state !== 'healthy') {
            console.log(`      reclaim: realm run reclaim ${runId} --step ${c.step} --force`);
          }
        }
        console.log(
          `\nReclaim re-drives a step (at-least-once — side effects may repeat). ` +
            `Use --step <name> --force to act on a specific claim, or --all for batch auto-reclaim.`,
        );
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    },
  );
