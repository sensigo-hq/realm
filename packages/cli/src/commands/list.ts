// list command — displays all runs in the store, sorted by most recent first.
import chalk from 'chalk';
import { Command } from 'commander';
import { classifyRunHealth, DEFAULT_IDLE_THRESHOLD_MS } from '@sensigo/realm';
import type { RunStore, RunRecord, RunPhase, RunHealthFinding } from '@sensigo/realm';
import { parseDuration } from '../lib/parse-duration.js';

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
 * Formats a threshold duration for the `--stuck` header, e.g. `24h`, `30d`, `10m`, `0m`. Whole-
 * unit only — matches the granularity `parseDuration`/`--older-than` itself accepts (d|h|m), so
 * every value this can ever be called with round-trips exactly.
 */
function formatThreshold(ms: number): string {
  if (ms === 0) return '0m';
  if (ms % 86_400_000 === 0 && ms >= 2 * 86_400_000) return `${ms / 86_400_000}d`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  return `${Math.round(ms / 60_000)}m`;
}

/**
 * Renders one finding's `--stuck` label — EXCLUSIVELY from the finding's own kind/evidence, never
 * by re-deriving from the run record (issue #221 [S4]: line format otherwise UNCHANGED except
 * appended labels — this is what keeps CS1's reapers parsing the same shape). `never_claimed_idle`
 * has no step-scoped label of its own (its presence is already implied by the run showing up in
 * the list at all, with `idle:` shown) — returns `undefined`, filtered out by the caller.
 */
function renderFindingLabel(f: RunHealthFinding): string | undefined {
  switch (f.kind) {
    case 'stale_claim':
    case 'wedged_gate_sibling':
      return `${f.step}=${f.reason}`;
    case 'capability_block': {
      const req = f.evidence?.['requirement'] as { kind: string; name: string } | undefined;
      return req !== undefined ? `${f.step}: needs ${req.kind} '${req.name}'` : undefined;
    }
    case 'never_claimed_idle':
      return undefined;
  }
}

/**
 * Lists runs from the store, sorted by updated_at descending.
 * @param workflowId      Optional filter — only show runs from this workflow.
 * @param store           Store holding run records.
 * @param statusFilter    Optional filter — only show runs with this run_phase.
 * @param stuck           Show only runs with a typed run-health finding (issue #221).
 * @param idleThresholdMs Override for the `never_claimed_idle` age gate (issue #221's
 *                        `--older-than`). Defaults to `DEFAULT_IDLE_THRESHOLD_MS` (24h). `0`
 *                        restores today's unconditional breadth.
 * @returns               Formatted output string.
 */
export async function listRuns(
  workflowId: string | undefined,
  store: RunStore,
  statusFilter?: RunPhase,
  stuck?: boolean,
  idleThresholdMs?: number,
): Promise<string> {
  const runs = await store.list(workflowId);
  const effectiveIdleThresholdMs = idleThresholdMs ?? DEFAULT_IDLE_THRESHOLD_MS;

  let filtered = runs;
  const findingsByRun = new Map<string, RunHealthFinding[]>();
  if (stuck === true) {
    filtered = runs.filter((r) => {
      // issue #221: classifyRunHealth is the SAME shared predicate get_run_state/reclaim/inspect
      // derive from — no drift. Definition-free (list has no workflow context to load).
      const findings = classifyRunHealth(r, { idleThresholdMs: effectiveIdleThresholdMs });
      if (findings.length > 0) findingsByRun.set(r.id, findings);
      return findings.length > 0;
    });
  } else if (statusFilter !== undefined) {
    filtered = runs.filter((r) => r.run_phase === statusFilter);
  }

  if (filtered.length === 0) {
    const scope = workflowId !== undefined ? ` for workflow '${workflowId}'` : '';
    return stuck === true
      ? `No stuck runs found${scope} (threshold ${formatThreshold(effectiveIdleThresholdMs)}).`
      : `No runs found${scope}.`;
  }

  filtered.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());

  const lines: string[] = [];
  if (stuck === true) {
    lines.push(`Stuck runs (threshold ${formatThreshold(effectiveIdleThresholdMs)}):`);
  }
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
      const labels = (findingsByRun.get(run.id) ?? [])
        .map(renderFindingLabel)
        .filter((l): l is string => l !== undefined);
      if (labels.length > 0) {
        line += `  ${labels.join(', ')}`;
      }
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
  .option('--stuck', 'Show only wedged/idle runs (typed run-health classification — issue #221)')
  .option(
    '--older-than <duration>',
    'With --stuck: idle-age threshold for the never-claimed-idle check (e.g. 24h, 7d); default ' +
      "24h. '0m' restores today's breadth (flags every claimless running run regardless of age; " +
      "bare '0' is rejected — use '0m'). Distinct from 'realm run reclaim --older-than', which is " +
      'a deadline-margin add-on for auto-reclaim selection, not an idle-age threshold.',
  )
  .action(
    async (opts: { workflow?: string; status?: string; stuck?: boolean; olderThan?: string }) => {
      const { JsonFileStore } = await import('@sensigo/realm');
      const store = new JsonFileStore();

      if (opts.stuck === true && opts.status !== undefined) {
        console.error('--stuck cannot be combined with --status.');
        process.exit(1);
      }
      if (opts.olderThan !== undefined && opts.stuck !== true) {
        console.error('--older-than is only valid with --stuck.');
        process.exit(1);
      }

      let idleThresholdMs: number | undefined;
      if (opts.olderThan !== undefined) {
        try {
          idleThresholdMs = parseDuration(opts.olderThan);
        } catch (err) {
          console.error(err instanceof Error ? err.message : String(err));
          process.exit(1);
        }
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
        const output = await listRuns(
          opts.workflow,
          store,
          statusFilter,
          opts.stuck,
          idleThresholdMs,
        );
        console.log(output);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    },
  );
