// list command — displays all runs in the store, sorted by most recent first.
import chalk from 'chalk';
import { Command } from 'commander';
import {
  classifyRunHealth,
  deriveRunPhase,
  DEFAULT_IDLE_THRESHOLD_MS,
  FailedAttemptStore,
  computeGateDueState,
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
    // issue #406: an expired gate. The disposition is what an operator acts on — whether the
    // declared enactment is coming, or whether only a human response ends this. The producer
    // always supplies one (`on_expiry ?? 'finding_only'`), so the typeof guard is armor against a
    // corrupt record rather than doubt about the contract: a raw interpolation of a non-string
    // would ship `gate_expired([object Object])` on the very records this surface exists for.
    // The step is interpolated unguarded because `pending_gate.step_name` is a REQUIRED string
    // (run-record.ts) — unlike drive_failing, which can fire before any step is selected.
    case 'gate_expired_awaiting_drive': {
      const disposition = f.evidence?.['disposition'];
      return `${f.step}=gate_expired(${typeof disposition === 'string' ? disposition : 'unknown'})`;
    }
    // issue #406: a settled gate entry coexisting with a live pending_gate of the same id. This
    // kind IS the out-of-contract-store detection surface, so the step guard is load-bearing
    // here in a way it is not for the other two: a corrupt empty settled key must not render a
    // bare leading `=`. Detail lives in evidence/inspect; the label's job is the cause name.
    case 'gate_corruption':
      return f.step !== undefined && f.step !== ''
        ? `${f.step}=gate_corruption`
        : 'gate_corruption';
    // issue #406: a terminal record still carrying a pending_gate. Points at the recovery verb
    // directly, like terminal_pending_finalizer's `(realm run drain)`.
    //
    // The pointer is TRUE end-to-end, checked rather than assumed: purge keys on the DERIVED
    // phase (purge.ts's header invariant), so a grandfathered stale-gate record derives terminal
    // and is never refused as "still gate_waiting"; the store's only refusals are
    // no_longer_terminal and drain_pending, neither keyed on pending_gate. One nuance the label
    // has no room for: if the gate step's claim still lingers in `in_progress_steps` the record
    // classifies claim_unknown_age, which a BATCH purge skips with a warning — the single-id path
    // needs `--force` to delete (its dry-run selects and reports either way).
    case 'terminal_with_stale_gate':
      return `${f.step}=stale_gate (realm run purge)`;
    // These kinds carry no --stuck label, and issue #406 settled why for each — this is a
    // decision, not a status quo. `never_claimed_idle` IS the listing reason itself; the
    // threshold header already says it, and a per-step label would restate the line.
    // `resolved_gate_with_eligible_guard` cannot reach this surface at all: its producer requires
    // a workflow definition and `list` classifies definition-free, so a label would be dead code.
    // `completed_with_failed_steps` and `structured_output_downgraded` are EXCLUDED from --stuck
    // selection (issues #302/#316, the filter below) — either can only co-ride a run selected by
    // some other finding, which renders its own label, so a label here would never be the reason
    // a reader is looking at the line.
    case 'never_claimed_idle':
    case 'resolved_gate_with_eligible_guard':
    case 'completed_with_failed_steps':
    case 'structured_output_downgraded':
      return undefined;
    // issue #279 (increment 1, PR-B): a terminal run with an undrained finalizer — points at the
    // recovery verb directly in the label (appended-segment style; see the dedicated kind-filter
    // group below for the group header this label's segment rides in).
    case 'terminal_pending_finalizer':
      return `${f.step}=${f.reason} (realm run drain)`;
    // issue #401: the drive died and nothing has happened since. The step prefix appears only
    // when there IS a step — a pre-step-selection failure rendering as a bare leading `=` is a
    // rendering bug, not a convention.
    case 'drive_failing': {
      const errorClass = f.evidence?.['error_class'];
      const label = `drive_failing(${typeof errorClass === 'string' ? errorClass : 'unknown'})`;
      return f.step !== undefined && f.step !== '' ? `${f.step}=${label}` : label;
    }
    default: {
      // Ride-along (boy-scout, not the reported problem): an exhaustiveness guard. A future
      // finding kind now fails to COMPILE here instead of silently rendering nothing — which is
      // how a finding reaches an operator's screen as absence rather than as news.
      const _exhaustive: never = f.kind;
      return _exhaustive;
    }
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
      //
      // issue #316: structured_output_downgraded joins the SAME exclusion — a degraded-assurance
      // disclosure is not a "stuck" symptom either. MORE load-bearing than the #302 conjunct: that
      // kind is terminal-only (a completed run was already excluded from --stuck's live-run scan
      // by other means), but this kind fires on LIVE runs too — without this exclusion, a
      // perfectly healthy in-flight run that merely downgraded strict on one step would
      // misreport as --stuck.
      return findings.some(
        (f) =>
          f.kind !== 'completed_with_failed_steps' && f.kind !== 'structured_output_downgraded',
      );
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
      // issue #401: a FOURTH kind-filter group, same appended-segment pattern — classifyRunHealth-
      // sourced like the three above it, deliberately NOT #219's renderCauseSegment channel.
      const driveFailingLabels = findings
        .filter((f) => f.kind === 'drive_failing')
        .map(renderFindingLabel)
        .filter((l): l is string => l !== undefined);
      if (driveFailingLabels.length > 0) {
        line += `  ${driveFailingLabels.join(', ')}`;
      }
      const pendingFinalizerLabels = findings
        .filter((f) => f.kind === 'terminal_pending_finalizer')
        .map(renderFindingLabel)
        .filter((l): l is string => l !== undefined);
      if (pendingFinalizerLabels.length > 0) {
        line += `  ${pendingFinalizerLabels.join(', ')}`;
      }
      // issue #406: the three gate-shaped causes, in ONE group so their findings-array order
      // survives to the line. A terminal both-match record fires stale_gate then gate_corruption,
      // and that order is part of what a reader (or a reaper parsing this line) sees.
      const gateCauseLabels = findings
        .filter(
          (f) =>
            f.kind === 'gate_expired_awaiting_drive' ||
            f.kind === 'gate_corruption' ||
            f.kind === 'terminal_with_stale_gate',
        )
        .map(renderFindingLabel)
        .filter((l): l is string => l !== undefined);
      if (gateCauseLabels.length > 0) {
        line += `  ${gateCauseLabels.join(', ')}`;
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
      // issue #291 (Deliverable 7): the EXPIRED marker + next-reminder-due annotation — the SAME
      // shared computeGateDueState derivation get_run_state/inspect also read from, off the
      // frozen record fields only (never the definition — definition-free by construction here).
      const due = computeGateDueState(run.pending_gate, new Date());
      if (due.expired) {
        line += `  EXPIRED ${formatGateAge(run.pending_gate.expires_at!)} ago`;
      }
      if (due.next_reminder_due_at !== undefined) {
        const dueMs = new Date(due.next_reminder_due_at).getTime();
        const overdueReminder = dueMs <= Date.now();
        line += overdueReminder
          ? `  reminder overdue (was due ${formatGateAge(due.next_reminder_due_at)} ago)`
          : `  reminder due in ${formatGateAge(new Date().toISOString(), new Date(due.next_reminder_due_at))}`;
      }
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
