// inspect command — displays the full evidence chain and diagnostics for a run.
//
// Read-only invariant: this command must never gain the capability to execute project
// code. The drift-evidence rendering and --check-drift recomputation below therefore use
// ONLY the pure fingerprint module (extension-identity.ts — fs reads + sha256, no dynamic
// import, no createRequire), never the extensions loader.
import chalk from 'chalk';
import { Command } from 'commander';
import { classifyRunHealth } from '@sensigo/realm';
// issue #221 correction: the CLI's first command→command import (sanctioned — harmless
// module-level Command construction; `listCommand` is a standalone Commander object never
// auto-registered anywhere by being imported). Reused so inspect's never_claimed_idle age
// rendering matches `realm run list --stuck`'s own `idle: <age>` humanization exactly, rather
// than re-implementing a second formatter.
import { formatGateAge } from './list.js';
import type {
  RunStore,
  RunRecord,
  WorkflowRegistrar,
  WorkflowDefinition,
  EvidenceSnapshot,
  StepDiagnostics,
  ExtensionIdentityEntry,
  SkipDetail,
} from '@sensigo/realm';
import { recomputeIdentity } from '../extensions/extension-identity.js';

/**
 * Renders one skipped step's reason inline (issue #111) — kind plus the salient detail.
 * A step lacking a detail (legacy run, or a skip family not yet carrying one) is the caller's
 * responsibility to fall back on; `skipped_steps` stays authoritative regardless.
 */
function formatSkipDetail(detail: SkipDetail): string {
  switch (detail.kind) {
    case 'when_false': {
      const falsy = detail.leaves.find((l) => !l.passed);
      const valueDisplay =
        falsy === undefined || !falsy.lhs_present
          ? 'undefined'
          : JSON.stringify(falsy.resolved_value);
      const leafTag = detail.leaves.length > 1 && falsy !== undefined ? ` '${falsy.leaf}'` : '';
      return `when_false: ${detail.expression} [lhs${leafTag} → ${valueDisplay}]`;
    }
    case 'trigger_rule_unsatisfiable': {
      const label = detail.blocking_deps.length === 1 ? 'dep' : 'deps';
      const depsText = detail.blocking_deps.map((b) => `${b.dep} ${b.state}`).join(', ');
      return `trigger_rule_unsatisfiable: ${detail.rule}, ${label} ${depsText}`;
    }
    case 'handler_abort':
      return 'handler_abort';
    case 'guard_abort':
      return 'guard_abort';
  }
}

/**
 * Renders the run's extension-code identity history (drift evidence, issue #119) plus,
 * with `checkDrift`, a pure-fs recomputation of the LAST entry against current disk state
 * under the entry's RECORDED rules — no code loading, ever.
 */
function renderExtensionIdentity(
  history: ExtensionIdentityEntry[],
  checkDrift: boolean,
  trustRoot: string | undefined,
): string[] {
  const lines: string[] = [];
  lines.push('');
  lines.push(
    `Extension Identity (${history.length} ${history.length === 1 ? 'entry' : 'entries'}):`,
  );

  history.forEach((entry, idx) => {
    const flags = [
      entry.override_active === true ? chalk.yellow('[override]') : '',
      entry.error !== undefined ? chalk.red('[error]') : '',
    ]
      .filter((f) => f !== '')
      .join(' ');
    lines.push(
      `  ${idx + 1}. captured ${entry.captured_at}${entry.pid !== undefined ? ` (pid ${entry.pid})` : ''}${flags ? ` ${flags}` : ''}`,
    );
    if (entry.error !== undefined) {
      lines.push(chalk.red(`     error: ${entry.error}`));
    }
    for (const mod of entry.modules) {
      lines.push(`     module: ${mod.declared} -> ${mod.resolved} (${mod.format})`);
      lines.push(`             entry_hash ${mod.entry_hash}`);
    }
    lines.push(
      `     tree: ${entry.tree.file_count} files, ${entry.tree.total_bytes} bytes${entry.tree.truncated ? ', TRUNCATED' : ''}`,
    );
    lines.push(`           tree_hash ${entry.tree.tree_hash || '(none)'}`);
    if (entry.signals !== undefined) {
      const sig: string[] = [];
      if (entry.signals.package_version !== undefined)
        sig.push(`package_version ${entry.signals.package_version}`);
      if (entry.signals.git_head !== undefined) sig.push(`git_head ${entry.signals.git_head}`);
      lines.push(`     signals: ${sig.join(', ')}`);
    }
    lines.push(
      chalk.dim(
        `     coverage (${entry.coverage}): covers files under ${entry.tree.roots.join(', ') || '(none)'} matching ${entry.tree.rules}; imports outside these roots, node_modules, and runtime dynamic imports are NOT covered.`,
      ),
    );
  });

  if (checkDrift) {
    lines.push('');
    lines.push('Drift check (pure recompute of the last entry under its recorded rules):');
    const last = history[history.length - 1]!;
    if (last.error !== undefined) {
      lines.push(
        chalk.yellow(
          '  last entry records a load/capture error — nothing to compare against current disk state.',
        ),
      );
      return lines;
    }
    const result = recomputeIdentity(last, trustRoot !== undefined ? { trustRoot } : {});
    if (!result.comparable) {
      lines.push(chalk.yellow(`  ${result.reason}`));
      return lines;
    }
    for (const mod of result.modules) {
      if (mod.current_hash === undefined) {
        lines.push(chalk.red(`  module ${mod.resolved}: MISSING (unreadable on current disk)`));
      } else if (mod.current_hash === mod.recorded_hash) {
        lines.push(chalk.green(`  module ${mod.resolved}: same`));
      } else {
        lines.push(
          chalk.yellow(
            `  module ${mod.resolved}: DIFFERS (recorded ${mod.recorded_hash}, current ${mod.current_hash})`,
          ),
        );
      }
    }
    if (result.manifest !== undefined) {
      if (result.manifest.current_hash === undefined) {
        lines.push(
          chalk.red(`  manifest ${result.manifest.path}: MISSING (unreadable on current disk)`),
        );
      } else if (result.manifest.current_hash === result.manifest.recorded_hash) {
        lines.push(chalk.green(`  manifest ${result.manifest.path}: same`));
      } else {
        lines.push(
          chalk.yellow(
            `  manifest ${result.manifest.path}: DIFFERS (recorded ${result.manifest.recorded_hash}, current ${result.manifest.current_hash})`,
          ),
        );
      }
    }
    if (result.tree.current_hash === result.tree.recorded_hash) {
      lines.push(chalk.green('  tree: same'));
    } else {
      lines.push(
        chalk.yellow(
          `  tree: DIFFERS (recorded ${result.tree.recorded_hash || '(none)'}, current ${result.tree.current_hash}${result.tree.current_truncated ? ', current truncated' : ''})`,
        ),
      );
    }
    if (result.signals !== undefined || last.signals !== undefined) {
      lines.push(
        chalk.dim(
          `  signals (informational): recorded ${JSON.stringify(last.signals ?? {})}, current ${JSON.stringify(result.signals ?? {})}`,
        ),
      );
    }
  }

  return lines;
}

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
  options?: { verbose?: boolean; checkDrift?: boolean },
): Promise<string> {
  const run: RunRecord = await store.get(runId);

  // Try to load workflow definition; gracefully handle missing definition. `definition` is
  // hoisted (issue #221) so classifyRunHealth below can reuse it when resolved — the try/catch
  // logic itself is otherwise UNCHANGED.
  let workflowLabel: string;
  let definitionMissing = false;
  let trustRoot: string | undefined;
  let definition: WorkflowDefinition | undefined;
  try {
    const def = await workflowStore.get(run.workflow_id);
    workflowLabel = `${def.id} v${def.version}`;
    trustRoot = def.trust_root;
    definition = def;
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
  for (const stepName of run.skipped_steps) {
    const detail = run.skip_details?.[stepName];
    lines.push(
      `  ${stepName}: ${detail !== undefined ? formatSkipDetail(detail) : 'skipped (reason unavailable)'}`,
    );
  }
  lines.push(`Created: ${run.created_at}`);
  lines.push(`Updated: ${run.updated_at}`);

  // issue #221: typed run-health findings — the SAME shared classifyRunHealth predicate the three
  // READ surfaces (get_run_state, list --stuck, inspect) derive from. Definition-aware when
  // resolved above (adds eligible_steps evidence to any never_claimed_idle finding); tolerates
  // definitionMissing (classification still runs, just without that evidence).
  //
  // Note: `realm run reclaim` is a separate, independent consumer of the underlying record facts
  // (settle sets, capability_blocks, reclaim-audit evidence) — it does NOT call this function; see
  // its own classifyNoActiveClaim discriminator in reclaim-step.ts.
  const runHealth = classifyRunHealth(run, definition !== undefined ? { definition } : {});
  if (runHealth.length > 0) {
    lines.push('');
    lines.push(`Run Health (${runHealth.length} finding(s)):`);
    for (const f of runHealth) {
      const stepLabel = f.step !== undefined ? ` [${f.step}]` : '';
      // issue #221 correction: never_claimed_idle's reason text ends "…, idle" with no duration —
      // append the humanized age (matches list --stuck's own `idle: <age>` rendering). Other kinds'
      // reason text is already complete on its own. `eligible_steps` evidence stays data-only (a
      // named residual in the record) — deliberately NOT rendered here.
      const idleSuffix =
        f.kind === 'never_claimed_idle' && f.since !== undefined
          ? ` ${formatGateAge(f.since)}`
          : '';
      lines.push(`  ${chalk.yellow(f.kind)}${stepLabel}: ${f.reason}${idleSuffix}`);
    }
  }

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

  // Drift evidence (issue #119): render the extension-identity history when present.
  if (run.extension_identity !== undefined && run.extension_identity.length > 0) {
    lines.push(
      ...renderExtensionIdentity(run.extension_identity, options?.checkDrift === true, trustRoot),
    );
  } else if (options?.checkDrift === true) {
    lines.push('');
    lines.push('Drift check: no extension identity recorded for this run.');
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
  .option(
    '--check-drift',
    'Recompute the last recorded extension identity against current disk state (pure hashing — never loads code)',
  )
  .action(async (runId: string, cmdOpts: { verbose?: boolean; checkDrift?: boolean }) => {
    const { JsonFileStore, JsonWorkflowStore } = await import('@sensigo/realm');
    const store = new JsonFileStore();
    const workflowStore = new JsonWorkflowStore();
    try {
      const output = await inspectRun(runId, store, workflowStore, {
        ...(cmdOpts.verbose === true ? { verbose: true } : {}),
        ...(cmdOpts.checkDrift === true ? { checkDrift: true } : {}),
      });
      console.log(output);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });
