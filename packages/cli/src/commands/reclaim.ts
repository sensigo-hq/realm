// reclaim command — detect or recover an after-claim wedge (issue #101, Phase 1).
//
// Default is a DRY-RUN (no mutation): it lists the run's in-progress claims with their liveness
// state and the exact per-step remediation. Mutating requires an explicit `--step <name> --force`
// (no blanket sweep in Phase 1) — reclaim re-drives the step at-least-once, so side effects may
// repeat; `--force` is the deliberate human gate.
import { Command } from 'commander';

export const reclaimCommand = new Command('reclaim')
  .description('Detect or recover a wedged run (a step claimed but never settled)')
  .argument('<run-id>', 'ID of the run to inspect (default) or reclaim')
  .option('--step <name>', 'Reclaim this specific in-progress claim (requires --force)')
  .option('--force', 'Actually reclaim — re-drives the step; its side effects may repeat')
  .action(async (runId: string, opts: { step?: string; force?: boolean }) => {
    const { JsonFileStore, reclaimStep, classifyInProgressClaims } = await import('@sensigo/realm');
    const store = new JsonFileStore();

    // Loud-fail on a store that cannot persist the claim clock (liveness recovery unavailable).
    if (!store.persistsClaims) {
      console.error(
        'This store does not persist claims; liveness recovery is unavailable on this store.',
      );
      process.exit(1);
    }

    // --force without --step: refuse (must name the claim to act on — no blanket sweep in Phase 1).
    if (opts.force === true && opts.step === undefined) {
      console.error(
        '--force requires --step <name>. Run without arguments to see a dry-run of the run’s claims.',
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
        const result = await reclaimStep(store, runId, opts.step);
        if (result.outcome === 'reclaimed') {
          console.log(
            `Reclaimed '${opts.step}' (was ${result.priorState}). It is eligible again — the next ` +
              `driver (or 'realm run agent --run-id ${runId}') will re-drive it.`,
          );
        } else if (result.outcome === 'already_settled') {
          console.log(
            `'${opts.step}' is not an active claim (already settled or reclaimed). No change.`,
          );
        } else {
          console.log(
            `'${opts.step}' was re-claimed by a live driver during reclaim — left untouched (not stomped).`,
          );
        }
        return;
      }

      // --- Dry-run (default): report the run's in-progress claims, no mutation ---
      if (run.terminal_state) {
        console.log(`Run '${runId}' is terminal (${run.run_phase}); it has no reclaimable claim.`);
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
          `Use --step <name> --force to act on a specific claim.`,
      );
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });
