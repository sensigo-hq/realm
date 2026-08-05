// list command — displays all runs in the store, sorted by most recent first.
import chalk from 'chalk';
import { Command } from 'commander';
import {
  classifyRunHealth,
  deriveRunPhase,
  DEFAULT_IDLE_THRESHOLD_MS,
  FailedAttemptStore,
} from '@sensigo/realm';
import type { RunStore, RunPhase, RunHealthFinding, FailedAttemptReadResult } from '@sensigo/realm';
import { parseDuration } from '../lib/parse-duration.js';

/** Returns a chalk-coloured phase label — `phase` is the caller's already-DERIVED value (issue
 *  #279, increment 2, PR-C — D-3 leg vi: render sweep), never a raw `run.run_phase` read here. */
function colorState(phase: RunPhase): string {
  if (phase === 'completed') return chalk.green(phase);
  if (phase === 'failed' || phase === 'abandoned') return chalk.red(phase);
  if (phase === 'gate_waiting') return chalk.cyan(phase);
  return chalk.yellow(phase);
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

// issue #289: 'aborted' was missing — RunPhase has carried it since #279 increment 2 (PR-C), but
// this list (the ONLY --status validator) was never updated, so a genuinely valid phase value was
// rejected. This is the single source both the --status help text and the validator below read.
const VALID_PHASES: RunPhase[] = [
  'running',
  'gate_waiting',
  'completed',
  'failed',
  'abandoned',
  'aborted',
];

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
    // issue #279 (increment 1, PR-B): a terminal run with an undrained finalizer — points at the
    // recovery verb directly in the label (appended-segment style; see the dedicated kind-filter
    // group below for the group header this label's segment rides in).
    case 'terminal_pending_finalizer':
      return `${f.step}=${f.reason} (realm run drain)`;
  }
}

/** Cap on the appended validation-summary text (issue #219) — keeps a `--stuck` line readable
 *  even for a long Ajv `message`/`instancePath`. Ellipsis-truncated, never hard-cut without
 *  signalling truncation (mirrors `inspect.ts`'s `formatSummary` convention). */
const MAX_CAUSE_SUMMARY_CHARS = 80;

/**
 * Renders the `--stuck` cause-attribution segment (issue #219) from a `FailedAttemptStore` read —
 * pure and unit-testable in isolation from `listRuns`/the filesystem. `''` for the empty case (no
 * records — the CLI-driven / no-sidecar / genuinely-parked-between-drives case), which the caller
 * appends as a no-op — cause is NEVER fabricated. Non-empty results are ALWAYS prefixed with the
 * same `'  '` two-space separator the claim/capability label groups use, so callers can
 * unconditionally `line += renderCauseSegment(result)`.
 *
 * `capped` renders the count as a `≥N×` FLOOR, never a claimed-exact count — #183's
 * append-and-stop ceiling means later attempts were silently dropped at write time, so `N` alone
 * would understate. The summary is built from the LATEST record (the last one in append order)
 * and its FIRST `validation_error_summary` entry only — omitted entirely when that array is empty
 * (a validation failure with no Ajv detail, or a non-validation `error_code`).
 */
export function renderCauseSegment(result: FailedAttemptReadResult): string {
  if (result.records.length === 0) return '';
  const latest = result.records[result.records.length - 1]!;
  const countLabel = `${result.capped ? '≥' : ''}${result.records.length}×`;

  let summary = '';
  const firstEntry = latest.validation_error_summary[0];
  if (firstEntry !== undefined) {
    const path = firstEntry.instancePath.length > 0 ? firstEntry.instancePath : '(root)';
    summary = ` — ${path} ${firstEntry.keyword}: ${firstEntry.message}`;
    if (summary.length > MAX_CAUSE_SUMMARY_CHARS) {
      summary = `${summary.slice(0, MAX_CAUSE_SUMMARY_CHARS)}…`;
    }
  }

  return `  rejected: ${countLabel} (${latest.step_id}: ${latest.error_code}${summary})`;
}

/**
 * Lists runs from the store, sorted by updated_at descending.
 * @param workflowId        Optional filter — only show runs from this workflow.
 * @param store             Store holding run records.
 * @param statusFilter      Optional filter — only show runs with this run_phase.
 * @param stuck             Show only runs with a typed run-health finding (issue #221).
 * @param idleThresholdMs   Override for the `never_claimed_idle` age gate (issue #221's
 *                          `--older-than`). Defaults to `DEFAULT_IDLE_THRESHOLD_MS` (24h). `0`
 *                          restores today's unconditional breadth.
 * @param failedAttemptStore Explicit injection (issue #219) for `--stuck` cause attribution —
 *                          deliberately NOT derived from `store` (no structural typing/duck-typed
 *                          `runsDirPath` probing on the `RunStore` interface, which stays plain
 *                          and untouched). The caller (the CLI action, which holds a concrete
 *                          `JsonFileStore` and its real `runsDirPath` getter) constructs this and
 *                          passes it in; `undefined` means best-effort skip — no cause attribution
 *                          — never a crash. `listRuns` never constructs one itself.
 * @returns                 Formatted output string.
 */
export async function listRuns(
  workflowId: string | undefined,
  store: RunStore,
  statusFilter?: RunPhase,
  stuck?: boolean,
  idleThresholdMs?: number,
  failedAttemptStore?: FailedAttemptStore,
): Promise<string> {
  const runs = await store.list(workflowId);
  const effectiveIdleThresholdMs = idleThresholdMs ?? DEFAULT_IDLE_THRESHOLD_MS;

  let filtered = runs;
  const findingsByRun = new Map<string, RunHealthFinding[]>();
  if (stuck === true) {
    filtered = runs.filter((r) => {
      // issue #221: classifyRunHealth is the SAME shared predicate get_run_state/inspect (the
      // OTHER two READ surfaces) derive from — no drift. Definition-free (list has no workflow
      // context to load).
      //
      // Note: `realm run reclaim` is a separate, independent consumer of the underlying record
      // facts (settle sets, capability_blocks, reclaim-audit evidence) — it does NOT call this
      // function; see its own classifyNoActiveClaim discriminator in reclaim-step.ts.
      const findings = classifyRunHealth(r, { idleThresholdMs: effectiveIdleThresholdMs });
      if (findings.length > 0) findingsByRun.set(r.id, findings);
      // issue #302: a completed run is not stuck — deliberately INVERTS the
      // terminal_pending_finalizer precedent (which selects AND labels). A run whose entire
      // finding set is completed_with_failed_steps is excluded from --stuck; the FULL array is
      // still stored above, so a run selected for some OTHER co-occurring finding still renders
      // that finding's own label (completed_with_failed_steps itself has none — the
      // terminal_with_stale_gate/gate_corruption no-label precedent).
      return findings.some((f) => f.kind !== 'completed_with_failed_steps');
    });
  } else if (statusFilter !== undefined) {
    // issue #279 (increment 2, PR-C — D-3 leg vi): filter on the DERIVED phase, never the
    // persisted one — a grandfathered terminal-with-stale-gate record (the #282 class) must
    // never falsely match `--status gate_waiting`.
    filtered = runs.filter((r) => deriveRunPhase(r) === statusFilter);
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
    // issue #279 (increment 2, PR-C — D-3 leg vi): derive ONCE per run, used for both the
    // colored state label and the gate-line suppression below.
    const derivedPhase = deriveRunPhase(run);
    const state = colorState(derivedPhase);
    const updated = new Date(run.updated_at).toLocaleString();
    const steps = new Set(
      run.evidence.filter((e) => e.kind !== 'gate_response').map((e) => e.step_id),
    ).size;
    let line = `${chalk.dim(run.id)}  ${chalk.bold(run.workflow_id)} v${run.workflow_version}  ${state}  ${updated}  ${steps} step(s)`;
    if (stuck === true) {
      // Show how long the run has been parked (idle age since last update).
      line += `  idle: ${formatGateAge(run.updated_at)}`;
      // issue #221 correction: restore main's TWO-GROUP join (an undisclosed deviation in the
      // original round) — claim-based labels first, capability labels second (classifyRunHealth
      // already emits findings in that order), each group internally ', '-joined, each appended
      // with its OWN leading '  ' only when non-empty. The S4 rail is "line format otherwise
      // UNCHANGED" — a single flattened, comma-joined list (the original round's shape) is a
      // different wire format than main's, which CS1's reapers parse.
      const findings = findingsByRun.get(run.id) ?? [];
      const claimLabels = findings
        .filter((f) => f.kind === 'stale_claim' || f.kind === 'wedged_gate_sibling')
        .map(renderFindingLabel)
        .filter((l): l is string => l !== undefined);
      if (claimLabels.length > 0) {
        line += `  ${claimLabels.join(', ')}`;
      }
      const capabilityLabels = findings
        .filter((f) => f.kind === 'capability_block')
        .map(renderFindingLabel)
        .filter((l): l is string => l !== undefined);
      if (capabilityLabels.length > 0) {
        line += `  ${capabilityLabels.join(', ')}`;
      }
      // issue #279 (increment 1, PR-B): a THIRD kind-filter group, appended-segment style — same
      // pattern as claimLabels/capabilityLabels above, NOT routed through #219's
      // renderCauseSegment (that one is FailedAttemptStore-sourced — a different mechanism; this
      // is classifyRunHealth-sourced, like the two groups above it).
      const pendingFinalizerLabels = findings
        .filter((f) => f.kind === 'terminal_pending_finalizer')
        .map(renderFindingLabel)
        .filter((l): l is string => l !== undefined);
      if (pendingFinalizerLabels.length > 0) {
        line += `  ${pendingFinalizerLabels.join(', ')}`;
      }
      // issue #219: cause attribution, appended LAST — best-effort, per-run (one run's sidecar
      // I/O failure never aborts the rest of the list). `records.length === 0` (no throw) means
      // absence — the CLI-driven / no-sidecar / parked-between-drives case — renders nothing
      // (renderCauseSegment returns '', a no-op append). A genuine read() throw is a DIFFERENT,
      // visible outcome — never conflated with absence (issue #183) and never silently swallowed
      // into the empty rendering.
      if (failedAttemptStore !== undefined) {
        try {
          const result = await failedAttemptStore.read(run.id);
          line += renderCauseSegment(result);
        } catch {
          line += '  cause: unavailable';
        }
      }
    } else if (derivedPhase === 'gate_waiting' && run.pending_gate !== undefined) {
      // issue #279 (increment 2, PR-C — D-3 leg vi): keyed on the DERIVED phase — no live-looking
      // gate line on a terminal run carrying a stale/leftover pending_gate (the #282 class).
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
      // issue #219: explicit injection — `JsonFileStore.runsDirPath` is a real, nominal public
      // getter (not duck-typed off `RunStore`, which stays plain). Constructed ONLY for --stuck,
      // at the SAME runsDir the run store persists to.
      const failedAttemptStore =
        opts.stuck === true ? new FailedAttemptStore(store.runsDirPath) : undefined;

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
          failedAttemptStore,
        );
        console.log(output);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    },
  );
