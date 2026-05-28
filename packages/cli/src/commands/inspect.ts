// inspect command — displays the full evidence chain and diagnostics for a run.
import chalk from 'chalk';
import { Command } from 'commander';
import type {
  RunStore,
  RunRecord,
  WorkflowRegistrar,
  EvidenceSnapshot,
  StepDiagnostics,
} from '@sensigo/realm';

/** Truncates a JSON-serialised summary to a readable single line. */
function formatSummary(value: unknown, maxLength = 120): string {
  const raw = JSON.stringify(value);
  if (raw.length <= maxLength) return raw;
  return raw.slice(0, maxLength) + chalk.dim('…');
}

/** Formats a diagnostics object into a readable string for the inspect output. */
function formatDiagnostics(diag: StepDiagnostics): string {
  const tokens = `~${diag.input_token_estimate} tokens`;
  if (diag.precondition_trace.length === 0) {
    return `${tokens} | no preconditions`;
  }
  const traceStr = diag.precondition_trace
    .map(
      (t) => `${t.expression} \u2192 ${t.passed ? 'true' : 'false'} (${String(t.resolved_value)})`,
    )
    .join(', ');
  return `${tokens} | preconditions: ${traceStr}`;
}

/** Applies chalk color to a step status string. */
function colorStatus(status: string): string {
  if (status === 'success') return chalk.green(status);
  if (status === 'error') return chalk.red(status);
  return chalk.yellow(status);
}

/**
 * Formats and returns a colored inspection report for a workflow run.
 * @param runId         The ID of the run to inspect.
 * @param store         Store holding run records.
 * @param workflowStore Registrar for workflow definitions.
 * @param options       Optional rendering options (e.g. verbose tool call output).
 */
export async function inspectRun(
  runId: string,
  store: RunStore,
  workflowStore: WorkflowRegistrar,
  options?: { verbose?: boolean },
): Promise<string> {
  const run: RunRecord = await store.get(runId);

  // Try to load workflow definition; gracefully handle missing definition.
  let workflowLabel: string;
  let definitionMissing = false;
  try {
    const def = await workflowStore.get(run.workflow_id);
    workflowLabel = `${def.id} v${def.version}`;
  } catch {
    workflowLabel = run.workflow_id;
    definitionMissing = true;
  }

  // Color the phase label.
  let phaseLabel: string;
  if (run.run_phase === 'completed') {
    phaseLabel = chalk.green(`${run.run_phase}  \u2713`);
  } else if (run.run_phase === 'failed' || run.run_phase === 'abandoned') {
    phaseLabel = chalk.red(run.run_phase);
  } else {
    phaseLabel = chalk.yellow(run.run_phase);
  }

  const lines: string[] = [];
  lines.push(`Run: ${run.id}`);
  lines.push(`Workflow: ${workflowLabel}`);
  lines.push(`Phase: ${phaseLabel}`);
  lines.push(`Completed: ${run.completed_steps.join(', ') || '(none)'}`);
  lines.push(`In Progress: ${run.in_progress_steps.join(', ') || '(none)'}`);
  lines.push(`Failed: ${run.failed_steps.join(', ') || '(none)'}`);
  lines.push(`Skipped: ${run.skipped_steps.join(', ') || '(none)'}`);
  lines.push(`Created: ${run.created_at}`);
  lines.push(`Updated: ${run.updated_at}`);

  if (definitionMissing) {
    lines.push('');
    lines.push('(workflow definition not found \u2014 showing run record only)');
  }

  // Group evidence snapshots by step_id, preserving first-appearance order.
  const stepOrder: string[] = [];
  const stepSnapshots = new Map<string, EvidenceSnapshot[]>();
  for (const snap of run.evidence) {
    if (!stepSnapshots.has(snap.step_id)) {
      stepOrder.push(snap.step_id);
      stepSnapshots.set(snap.step_id, []);
    }
    stepSnapshots.get(snap.step_id)!.push(snap);
  }

  // Run-level trace aggregation — summarise across all evidence snapshots.
  const allSnaps = run.evidence;
  const snapsWithTrace = allSnaps.filter((s) => s.trace !== undefined && s.trace.length > 0);
  if (snapsWithTrace.length > 0) {
    const stepsWithTrace = snapsWithTrace.length;
    const stepsWithTraceUnique = new Set(snapsWithTrace.map((s) => s.step_id)).size;
    const storedEntriesTotal = allSnaps.reduce(
      (acc, s) => acc + (s.trace_summary?.stored_entries ?? 0),
      0,
    );
    const discardedEntriesTotal = allSnaps.reduce(
      (acc, s) => acc + (s.trace_summary?.discarded_entries ?? 0),
      0,
    );
    const truncatedSteps = allSnaps.filter((s) => s.trace_summary?.truncated === true).length;

    // Frequency map of events across all stored trace entries (excluding sentinel).
    const eventFreq = new Map<string, number>();
    for (const snap of allSnaps) {
      for (const entry of snap.trace ?? []) {
        if (entry.event === 'trace.truncated') continue;
        eventFreq.set(entry.event, (eventFreq.get(entry.event) ?? 0) + 1);
      }
    }
    const topEvents = [...eventFreq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([event, count]) => `${event} (${count})`);

    lines.push('');
    lines.push('Trace Summary:');
    lines.push(`  steps_with_trace:        ${stepsWithTrace}`);
    lines.push(`  steps_with_trace_unique: ${stepsWithTraceUnique}`);
    lines.push(`  stored_entries_total:   ${storedEntriesTotal}`);
    lines.push(`  discarded_entries_total:${discardedEntriesTotal}`);
    lines.push(`  truncated_steps:        ${truncatedSteps}`);
    if (topEvents.length > 0) {
      lines.push(`  top_events:             ${topEvents.join(', ')}`);
    }
  }

  lines.push('');
  lines.push(`Evidence (${stepOrder.length} steps):`);

  stepOrder.forEach((stepId, idx) => {
    const snaps = stepSnapshots.get(stepId)!;
    const hasAttempts = snaps.length > 1 && snaps.some((s) => s.attempt !== undefined);
    const totalAttempts = snaps.length;

    lines.push('');

    if (hasAttempts) {
      // Show step name as header, then each attempt as a sub-item.
      lines.push(`  ${idx + 1}. ${stepId}`);
      snaps.forEach((snap, ai) => {
        const statusColored = colorStatus(snap.status);
        const hashShort = chalk.dim(`hash: ${snap.evidence_hash.slice(0, 8)}`);
        lines.push(
          `     (attempt ${ai + 1}/${totalAttempts})  ${statusColored}   ${snap.duration_ms}ms   ${hashShort}`,
        );
      });
      // Show Input/Output/Diagnostics for the last attempt.
      const lastSnap = snaps[snaps.length - 1]!;
      lines.push(`     Input:  ${formatSummary(lastSnap.input_summary)}`);
      if (lastSnap.resolved_params !== undefined) {
        lines.push(`     Resolved: ${formatSummary(lastSnap.resolved_params)}`);
      }
      lines.push(`     Output: ${formatSummary(lastSnap.output_summary)}`);
      if (lastSnap.trace !== undefined) {
        lines.push(`     Trace:  ${lastSnap.trace.length} entries (not hashed).`);
        if (lastSnap.trace_summary?.truncated) {
          const s = lastSnap.trace_summary;
          lines.push(
            chalk.yellow(
              `     ⚠ Trace truncated (${s.truncation_reason ?? 'unknown'}): ${s.stored_entries} stored, ${s.discarded_entries} discarded.`,
            ),
          );
        }
      }
      if (lastSnap.diagnostics !== undefined) {
        lines.push(chalk.dim(`     Diagnostics: ${formatDiagnostics(lastSnap.diagnostics)}`));
      }
    } else {
      const snap = snaps[0]!;
      const statusColored = colorStatus(snap.status);
      const hashShort = chalk.dim(`hash: ${snap.evidence_hash.slice(0, 8)}`);
      const kindLabel = snap.kind === 'gate_response' ? chalk.cyan(' gate_response') : '';
      const profileLabel =
        snap.agent_profile !== undefined ? chalk.cyan(` [profile: ${snap.agent_profile}]`) : '';
      lines.push(
        `  ${idx + 1}. ${stepId.padEnd(22)}${profileLabel}${kindLabel} ${statusColored}   ${snap.duration_ms}ms   ${hashShort}`,
      );
      if (snap.kind === 'gate_response') {
        const choice = snap.input_summary['choice'] ?? snap.output_summary['choice'];
        if (choice !== undefined) {
          lines.push(`     Choice:   ${String(choice)}`);
        }
        if (snap.gate_message !== undefined) {
          lines.push(`     Message:  "${snap.gate_message}"`);
        }
        lines.push(`     Output:   ${formatSummary(snap.output_summary)}`);
      } else {
        lines.push(`     Input:  ${formatSummary(snap.input_summary)}`);
        if (snap.resolved_params !== undefined) {
          lines.push(`     Resolved: ${formatSummary(snap.resolved_params)}`);
        }
        lines.push(`     Output: ${formatSummary(snap.output_summary)}`);
        if (snap.trace !== undefined) {
          lines.push(`     Trace:  ${snap.trace.length} entries (not hashed).`);
          if (snap.trace_summary?.truncated) {
            const s = snap.trace_summary;
            lines.push(
              chalk.yellow(
                `     ⚠ Trace truncated (${s.truncation_reason ?? 'unknown'}): ${s.stored_entries} stored, ${s.discarded_entries} discarded.`,
              ),
            );
          }
        }
        if (snap.tool_calls === undefined) {
          // callStep path — print nothing
        } else if (snap.tool_calls.length === 0) {
          lines.push('     Tools declared, none called');
        } else {
          lines.push(`     Tool calls (${snap.tool_calls.length}):`);
          for (const tc of snap.tool_calls) {
            const errSuffix = tc.error ? `  error: ${tc.error}` : '';
            lines.push(`       [${tc.server_id}:${tc.tool}]  ${tc.duration_ms}ms${errSuffix}`);
            if (options?.verbose) {
              lines.push(`         args:   ${formatSummary(tc.args)}`);
              const resultStr = typeof tc.result === 'string' ? tc.result : '(null)';
              lines.push(`         result: ${resultStr}`);
            }
          }
        }
        if (snap.diagnostics !== undefined) {
          lines.push(chalk.dim(`     Diagnostics: ${formatDiagnostics(snap.diagnostics)}`));
        }
      }
    }
  });

  return lines.join('\n');
}

export const inspectCommand = new Command('inspect')
  .argument('<run-id>', 'ID of the run to inspect')
  .description('Display the full evidence chain and diagnostics for a run')
  .option('--verbose', 'Show full tool call args and results')
  .action(async (runId: string, cmdOpts: { verbose?: boolean }) => {
    const { JsonFileStore, JsonWorkflowStore } = await import('@sensigo/realm');
    const store = new JsonFileStore();
    const workflowStore = new JsonWorkflowStore();
    try {
      const output = await inspectRun(
        runId,
        store,
        workflowStore,
        cmdOpts.verbose === true ? { verbose: true } : undefined,
      );
      console.log(output);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });
