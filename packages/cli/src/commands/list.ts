// list command — displays all runs in the store, sorted by most recent first.
import chalk from 'chalk';
import { Command } from 'commander';
import type { RunStore, RunRecord, RunPhase } from '@sensigo/realm';

/** Returns a chalk-coloured phase label. */
function colorState(run: RunRecord): string {
  if (run.run_phase === 'completed') return chalk.green(run.run_phase);
  if (run.run_phase === 'failed' || run.run_phase === 'abandoned') return chalk.red(run.run_phase);
  if (run.run_phase === 'gate_waiting') return chalk.cyan(run.run_phase);
  return chalk.yellow(run.run_phase);
}

/**
 * Formats elapsed time since a gate was opened as a compact human-readable duration.
 * @param openedAt  ISO 8601 timestamp of when the gate was opened.
 * @param now       Current time — injectable for testing. Defaults to `new Date()`.
 */
export function formatGateAge(openedAt: string, now: Date = new Date()): string {
  const elapsedMs = now.getTime() - new Date(openedAt).getTime();
  const totalMinutes = Math.floor(elapsedMs / 60_000);
  const totalHours = Math.floor(totalMinutes / 60);
  const totalDays = Math.floor(totalHours / 24);

  if (totalMinutes < 60) return `${totalMinutes}m`;
  if (totalHours < 24) {
    const remainingMinutes = totalMinutes % 60;
    return `${totalHours}h ${remainingMinutes}m`;
  }
  const remainingHours = totalHours % 24;
  return `${totalDays}d ${remainingHours}h`;
}

const VALID_PHASES: RunPhase[] = ['running', 'gate_waiting', 'completed', 'failed', 'abandoned'];

/**
 * Lists runs from the store, sorted by updated_at descending.
 * @param workflowId    Optional filter — only show runs from this workflow.
 * @param store         Store holding run records.
 * @param statusFilter  Optional filter — only show runs with this run_phase.
 * @returns             Formatted output string.
 */
export async function listRuns(
  workflowId: string | undefined,
  store: RunStore,
  statusFilter?: RunPhase,
  stuck?: boolean,
): Promise<string> {
  const runs = await store.list(workflowId);

  let filtered = runs;
  if (stuck === true) {
    // Advanced-but-parked: phase running with no claimed step (the stuck-run incident signature).
    filtered = runs.filter((r) => r.run_phase === 'running' && r.in_progress_steps.length === 0);
  } else if (statusFilter !== undefined) {
    filtered = runs.filter((r) => r.run_phase === statusFilter);
  }

  if (filtered.length === 0) {
    const scope = workflowId !== undefined ? ` for workflow '${workflowId}'` : '';
    return stuck === true ? `No stuck runs found${scope}.` : `No runs found${scope}.`;
  }

  filtered.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());

  const lines: string[] = [];
  for (const run of filtered) {
    const state = colorState(run);
    const updated = new Date(run.updated_at).toLocaleString();
    const steps = new Set(
      run.evidence.filter((e) => e.kind !== 'gate_response').map((e) => e.step_id),
    ).size;
    let line = `${chalk.dim(run.id)}  ${chalk.bold(run.workflow_id)} v${run.workflow_version}  ${state}  ${updated}  ${steps} step(s)`;
    if (stuck === true) {
      // Show how long the run has been parked (idle age since last update).
      line += `  idle: ${formatGateAge(run.updated_at)}`;
    } else if (run.run_phase === 'gate_waiting' && run.pending_gate !== undefined) {
      const age = formatGateAge(run.pending_gate.opened_at);
      line += `  gate: ${run.pending_gate.step_name} (${age})`;
    }
    lines.push(line);
  }

  return lines.join('\n');
}

export const listCommand = new Command('list')
  .description('List all runs, sorted by most recent first')
  .option('--workflow <id>', 'Filter by workflow ID')
  .option('--status <phase>', `Filter by run phase (${VALID_PHASES.join(', ')})`)
  .option('--stuck', 'Show only advanced-but-parked runs (running with no claimed step)')
  .action(async (opts: { workflow?: string; status?: string; stuck?: boolean }) => {
    const { JsonFileStore } = await import('@sensigo/realm');
    const store = new JsonFileStore();

    if (opts.stuck === true && opts.status !== undefined) {
      console.error('--stuck cannot be combined with --status.');
      process.exit(1);
    }

    let statusFilter: RunPhase | undefined;
    if (opts.status !== undefined) {
      if (!VALID_PHASES.includes(opts.status as RunPhase)) {
        console.error(
          `Invalid --status value '${opts.status}'. Valid values: ${VALID_PHASES.join(', ')}`,
        );
        process.exit(1);
      }
      statusFilter = opts.status as RunPhase;
    }

    try {
      const output = await listRuns(opts.workflow, store, statusFilter, opts.stuck);
      console.log(output);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });
