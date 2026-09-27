// inspect command — displays the full evidence chain and diagnostics for a run.
//
// Read-only invariant: this command must never gain the capability to execute project
// code. The drift-evidence rendering and --check-drift recomputation below therefore use
// ONLY the pure fingerprint module (extension-identity.ts — fs reads + sha256, no dynamic
// import, no createRequire), never the extensions loader.
import chalk from 'chalk';
import { Command } from 'commander';
import {
  CACHE_BASES,
  CACHE_STATES,
  SEAL_ARMS,
  WorkflowError,
  classifyRunHealth,
  deriveDefaultedSteps,
  deriveRunPhase,
  computeGateDueState,
  getWorkflowForRun,
  composeStepViews,
  composeDriveFailureCosts,
} from '@sensigo/realm';
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
  CostView,
  CostFigure,
  CostUnrecordedCause,
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
    // issue #279 (increment 1, PR-A): render-only — no engine call site can produce this kind in
    // this PR (dormant until PR-B migrates the seal sites); required so the SkipDetail widening
    // doesn't red `npm run build` under this exhaustive switch's strict-TS check.
    case 'gate_cancelled_by_abort':
      return 'gate_cancelled_by_abort';
    // issue #291: a gate's OWN step, aborted by applyExpireGate on enforce-clock expiry —
    // distinct from gate_cancelled_by_abort (a DIFFERENT step's handler-abort cancelling this
    // gate).
    case 'gate_expired':
      return `gate_expired (gate_id: ${detail.gate_id})`;
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
/**
 * Issue #600 PR 1b — the ONE textual form for a summed figure that carries no "which request"
 * label: single (bare `N noun`), full (`N noun (totals across n requests)`), partial (`at least N
 * noun (k of n requests reported <phrase>)`). Shared by the failure line's every figure and the
 * step line's output figure — none of which ever say "measured" or name a specific request.
 *
 * `extraClause`, when given, is appended inside the SAME closing parenthesis (`; <extraClause>`),
 * or opens one of its own on the otherwise-bare single form — this is what lets the uncached
 * fallback say `(whole prompt not reported)` even when there is nothing else to put in parens.
 */
function summedText(fig: CostFigure, noun: string, phrase: string, extraClause?: string): string {
  const suffix = extraClause !== undefined ? `; ${extraClause}` : '';
  if (fig.reported === fig.of) {
    if (fig.of === 1) {
      return extraClause !== undefined
        ? `${fig.value} ${noun} (${extraClause})`
        : `${fig.value} ${noun}`;
    }
    return `${fig.value} ${noun} (totals across ${fig.of} requests${suffix})`;
  }
  return `at least ${fig.value} ${noun} (${fig.reported} of ${fig.of} requests reported ${phrase}${suffix})`;
}

/**
 * Issue #600 PR 1b — the step line's own prompt/uncached form: it names WHICH request when only
 * one reported (`measured, first request` / `measured, request i of n`), because a prompt is not
 * additive as a size and showing the first reporting request's figure alone hid a larger sibling
 * (a fresh operator read `777 prompt tokens (request 2 of 4)` off a record that also held 888).
 * `reported === 1` wins over `reported < of` deliberately — the "one-of-many" shape gets the
 * which-request label here, never the bare "at least" a summed context would give it.
 */
function stepMeasuredText(
  fig: CostFigure,
  noun: string,
  phrase: string,
  extraClause?: string,
): string {
  const suffix = extraClause !== undefined ? `; ${extraClause}` : '';
  if (fig.reported === 1) {
    const idx = fig.only_request_index!;
    const which = idx === 0 ? 'first request' : `request ${idx + 1} of ${fig.of}`;
    return `${fig.value} ${noun} (measured, ${which}${suffix})`;
  }
  if (fig.reported === fig.of) {
    return `${fig.value} ${noun} (measured, totals across ${fig.of} requests${suffix})`;
  }
  return (
    `at least ${fig.value} ${noun} ` +
    `(measured, ${fig.reported} of ${fig.of} requests reported ${phrase}${suffix})`
  );
}

/**
 * Issue #600 PR 1b — a cache direction's clause, label first (`read N` / `wrote N`), unchanged
 * from PR 1a's `formatCache` other than reading a `CostFigure` instead of re-summing one. The
 * "full" form never says "totals across" — the segment's own trailing `(scope)` already does.
 */
function cacheDirectionText(fig: CostFigure | undefined, label: string, phrase: string): string {
  if (fig === undefined) return `${label} not reported`;
  if (fig.reported === fig.of) return `${label} ${fig.value}`;
  return `${label} at least ${fig.value} (${fig.reported} of ${fig.of} requests reported ${phrase})`;
}

/**
 * Issue #600 PR 1b — true only where every cache token counted is provably inside the shown
 * prompt figure: the line shows the PROMPT figure (never the uncached fallback), and every request
 * that contributed to `requests` also reported it (`reported === of`). False for a partial prompt
 * (some cache tokens could belong to the silent requests), a one-of-many prompt (one request's
 * size beside every request's cache), the uncached fallback (never inside it by construction), or
 * no prompt figure at all.
 */
function includedInPrompt(cost: CostView): boolean {
  const p = cost.prompt;
  return p !== undefined && p.reported === p.of;
}

/**
 * Issue #600 PR 1b — the provenance word, READ from the field rather than hardcoded beside it. A
 * word this build does not know is NAMED as unrecognised rather than printed as though it were a
 * fact — this slot is where an operator learns whether a number was measured.
 */
function basisWord(basis: string | undefined): string {
  if (basis === 'provider_reported') return 'provider-reported';
  if (basis === undefined) return 'basis not recorded';
  if ((CACHE_BASES as readonly string[]).includes(basis)) return basis;
  return `unrecognized basis '${basis}'`;
}

/**
 * Issue #600 PR 1b — the cache segment, sourced from the ONE composed `CostView` (`step-view.ts`)
 * instead of re-summing `StepDiagnostics.cache` at this render site. Every branch, every sentence
 * and the provenance discipline are unchanged from PR 1a's `formatCache`; the one addition is the
 * `included in the prompt` clause (D2), printed only where `includedInPrompt` says it is true, and
 * NEVER on the `never_engaged` branch (two zeros — noise).
 */
function formatCache(cost: CostView): string {
  const n = cost.requests;
  const scope = n === 1 ? '1 request' : `totals across ${n} requests`;
  const nothingReported = (): string =>
    n === 0
      ? `cache: not reported by the provider`
      : `cache: not reported by the provider (${scope})`;
  const read = cacheDirectionText(cost.cache_read, 'read', 'a read');
  const wrote = cacheDirectionText(cost.cache_write, 'wrote', 'a write');
  if (read.endsWith('not reported') && wrote.endsWith('not reported')) {
    return nothingReported();
  }
  const prov = basisWord(cost.basis);
  const includedClause = includedInPrompt(cost) ? 'included in the prompt; ' : '';
  if (cost.state === undefined || !(CACHE_STATES as readonly string[]).includes(cost.state)) {
    return `cache: unrecognized state '${String(cost.state)}' — ${read}, ${wrote} (${includedClause}${prov}, ${scope})`;
  }
  if (cost.state === 'never_engaged') {
    return `cache: not engaged — ${read}, ${wrote} (${prov}, ${scope})`;
  }
  return `cache: ${read}, ${wrote} (${includedClause}${prov}, ${scope})`;
}

/**
 * Issue #600 PR 1b (D9/#611) — what a failed drive already cost, on the one surface an operator
 * reads first for a stuck or errored run. Sourced from `composeDriveFailureCosts`'s per-entry
 * `CostView`, which carries no `basis`/`state` (a drive failure's usage carries no classification)
 * — so this line's provenance is silence, not a word. Cache traffic is NEW here (#611): before this
 * PR the failure line showed prompt/output only, so an operator staring at "Drive failures:" could
 * not see that a step had already written or read the cache before the drive died.
 *
 * Every figure here is SUMMED (never "which request"), because this line answers a COST question —
 * for every class but `validation_rejected` its own words are "billed before the throw" — and a
 * retry re-sends the prompt and is charged for it again.
 */
function formatDriveFailureUsage(cost: CostView, errorClass?: string): string {
  if (cost.requests === 0) {
    // An empty array says one thing only: the field was present and carried no requests. It does
    // NOT say a request was billed — asserting that printed a billing claim directly beneath an
    // `sdk_missing` line stating that no request ever left the process.
    return '    usage: no per-request usage was recorded';
  }
  const n = cost.requests;
  const scope = n === 1 ? '1 request' : `${n} requests`;
  const promptStr =
    cost.prompt !== undefined
      ? summedText(cost.prompt, 'prompt tokens', 'a prompt')
      : cost.uncached_input !== undefined
        ? summedText(
            cost.uncached_input,
            'uncached input tokens',
            'uncached input',
            'whole prompt not reported',
          )
        : 'prompt not reported';
  const outputStr =
    cost.output !== undefined
      ? summedText(cost.output, 'output tokens', 'output')
      : 'output not reported';
  const readStr = cacheDirectionText(cost.cache_read, 'read', 'a read');
  const wroteStr = cacheDirectionText(cost.cache_write, 'wrote', 'a write');
  const cacheStr =
    readStr.endsWith('not reported') && wroteStr.endsWith('not reported')
      ? 'cache not reported'
      : `cache ${readStr}, ${wroteStr}${includedInPrompt(cost) ? ' (included in the prompt)' : ''}`;
  const ended =
    errorClass === 'validation_rejected' ? 'before the output was rejected' : 'before the throw';
  return `    usage: ${scope} billed ${ended} — ${promptStr}, ${outputStr}, ${cacheStr}`;
}

/**
 * Issue #600 PR 1b — the one sentence for a step whose evidence entry carries neither `cost` nor
 * an unreadable `cache`: WHY there is nothing to show, never asserting a model call happened
 * (`cost_unrecorded`'s two causes are both silent on that — see `StepDiagnostics.cache`'s own doc).
 */
function costAbsenceSentence(
  costUnrecorded: CostUnrecordedCause | undefined,
  costUnreadable: true | undefined,
): string | undefined {
  if (costUnreadable === true) return 'cost: unreadable — the recorded usage is not a list';
  if (costUnrecorded === 'tool_calling_step') {
    return 'cost: not recorded — tool-calling steps do not record usage yet';
  }
  if (costUnrecorded === 'not_driven_by_realm') {
    return (
      'cost: not recorded — realm did not drive this step (an outside agent over MCP, an answer ' +
      'typed at a realm workflow run prompt, or a record written before usage was measured)'
    );
  }
  return undefined;
}

/**
 * Issue #600 PR 1b — the prompt/uncached segment of a step's Diagnostics line, sourced from a
 * composed `CostView` rather than re-summing `StepDiagnostics.cache` here. `cost === undefined`
 * means nothing was recorded for the step at all — no segment, as PR 1a shipped it.
 */
function formatPromptSegment(cost: CostView | undefined): string {
  if (cost === undefined) return '';
  if (cost.prompt !== undefined) {
    return ` | ${stepMeasuredText(cost.prompt, 'prompt tokens', 'a prompt')}`;
  }
  if (cost.uncached_input !== undefined) {
    return ` | ${stepMeasuredText(cost.uncached_input, 'uncached input tokens', 'uncached input', 'whole prompt not reported')}`;
  }
  if (cost.requests > 0) return ' | prompt not reported';
  return '';
}

/**
 * Issue #600 PR 1b (#611) — output tokens on the step line, NEW in this PR: before it, output was
 * rendered only on a failed drive's line, never on a successful step's. Summed, never "which
 * request" — an output is not a size measured once per step the way a prompt is.
 */
function formatOutputSegment(cost: CostView | undefined): string {
  if (cost === undefined) return '';
  if (cost.output !== undefined) return ` | ${summedText(cost.output, 'output tokens', 'output')}`;
  if (cost.requests > 0) return ' | output not reported';
  return '';
}

/** Formats a diagnostics object plus its composed cost into the step line's readable string. */
function formatDiagnostics(
  diag: Pick<StepDiagnostics, 'input_token_estimate' | 'precondition_trace'>,
  cost: CostView | undefined,
): string {
  const tokens = `~${diag.input_token_estimate} tokens (estimate, step input)`;
  const prompt = formatPromptSegment(cost);
  const output = formatOutputSegment(cost);
  const cache = cost !== undefined ? ` | ${formatCache(cost)}` : '';
  if (diag.precondition_trace.length === 0) {
    return `${tokens}${prompt}${output} | no preconditions${cache}`;
  }
  const traceStr = diag.precondition_trace
    .map((t) => `${t.expression} → ${t.passed ? 'true' : 'false'} (${String(t.resolved_value)})`)
    .join(', ');
  return `${tokens}${prompt}${output} | preconditions: ${traceStr}${cache}`;
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
  // issue #558 PR-T — the failure is KEPT (the bare `catch {` threw it away, so every class
  // printed "not found", false for a copy that exists). It names the line below and feeds
  // classifyRunHealth's `definition_unresolvable` finding.
  let definitionError: { code: string; message: string; class?: string } | undefined;
  try {
    // issue #558 PR-T (review fold C8) — through the ONE helper every other surface uses, so the
    // line below carries the composed sentence: the class, the way out and the repair. It was
    // the one surface with no remedy at all (the fresh walk). `terminalOk`: inspect reads any run.
    const def = await getWorkflowForRun(workflowStore, run, {
      retryVerb: 'inspect again',
      verb: 'inspect',
      terminalOk: true,
    });
    workflowLabel = `${def.id} v${def.version}`;
    trustRoot = def.trust_root;
    definition = def;
  } catch (err) {
    // Review fold R8: the record carries the version — `run list` prints it for the same run; a
    // label that drops it here degrades a field the unreadable copy was never needed for.
    workflowLabel = `${run.workflow_id} v${run.workflow_version}`;
    definitionMissing = true;
    // Narrowed with `instanceof WorkflowError` — never duck-typed on `err.code` (house rule:
    // an error's shape is not its identity). A non-WorkflowError escape keeps the old behaviour.
    if (err instanceof WorkflowError) {
      const cls = (err.details as Record<string, unknown> | undefined)?.['class'];
      definitionError = {
        code: err.code,
        message: err.message,
        ...(typeof cls === 'string' ? { class: cls } : {}),
      };
    }
  }

  // issue #600 PR 1b: the one composed cost view, derived ONCE from `run` \u2014 every render below
  // reads it rather than re-summing `StepDiagnostics.cache` at each call site.
  const stepViews = composeStepViews(run, definition !== undefined ? { definition } : {});

  // Color the phase label \u2014 derived, never the persisted run_phase (issue #279, increment 2,
  // PR-C \u2014 D-3 leg vi: render sweep). A grandfathered terminal-with-stale-gate record (the #282
  // class) must render its TRUE phase here, not a stale 'gate_waiting'.
  const derivedPhase = deriveRunPhase(run);
  let phaseLabel: string;
  if (derivedPhase === 'completed') {
    phaseLabel = chalk.green(`${derivedPhase}  \u2713`);
  } else if (derivedPhase === 'failed' || derivedPhase === 'abandoned') {
    phaseLabel = chalk.red(derivedPhase);
  } else {
    phaseLabel = chalk.yellow(derivedPhase);
  }

  const lines: string[] = [];
  lines.push(`Run: ${run.id}`);
  lines.push(`Workflow: ${workflowLabel}`);
  lines.push(`Phase: ${phaseLabel}`);
  // issue #558 PR-C: the supersede link, beside the phase. Absent for a first run and a `reuse`.
  if (run.rerun_of !== undefined) lines.push(`Rerun of: ${run.rerun_of}`);
  // issue #367: the recorded seal fact, beside the phase it derives. An unrecognised arm is shown
  // rather than hidden — an operator reading a record written by a newer binary should see that
  // there IS a seal, even if this binary cannot name it.
  if (run.sealed_by !== undefined) {
    const arm = (SEAL_ARMS as readonly string[]).includes(run.sealed_by.arm)
      ? run.sealed_by.arm
      : `unrecognized arm '${run.sealed_by.arm}'`;
    // issue #367: the `(step)` suffix renders ONLY where the step is the arm's deterministic
    // identity — a guard, a gate, or the handler that aborted. For `complete` and `step_failure`
    // the recorded step is whichever one happened to settle LAST, a scheduling artifact: issue
    // #373 deliberately stopped the cause line from naming a culprit, and printing that step one
    // line above the culprit-free Cause would read as the culprit and undo exactly that. The
    // RECORD is untouched — the step stays persisted and export carries it. Render fork only.
    const stepIsDeterministic =
      run.sealed_by.arm.startsWith('guard_') ||
      run.sealed_by.arm.startsWith('gate_') ||
      run.sealed_by.arm === 'handler_abort';
    const stepSuffix =
      stepIsDeterministic && run.sealed_by.step !== undefined ? ` (${run.sealed_by.step})` : '';
    // issue #367 (part 5): classifier provenance is provenance too — a reader deserves to know the
    // arm was RECOVERED from a legacy record rather than asserted by the writer that sealed it.
    const classifiedSuffix = run.sealed_by.classified === true ? ' (recovered by classifier)' : '';
    lines.push(`Sealed by: ${arm}${stepSuffix}${classifiedSuffix}`);
    // issue #367 (part 5): an operator's ruling on this run, on the surface operators actually
    // use. Shipping a ruling channel whose rulings were invisible here was the defect this closes.
    const ruling = run.sealed_by.adjudicated;
    if (ruling !== undefined) {
      // `null` means no arm existed before the ruling — the operator's FIRST stamp of a record
      // that had none. Deliberately not called "unclassifiable": the boundary admits a null
      // first-stamp on ANY already-terminal unstamped record, so saying so would claim more than
      // the condition guarding this line.
      const was =
        ruling.previous_arm === null
          ? 'first stamp — no prior arm existed'
          : `was ${ruling.previous_arm}`;
      // The reason is the operator's own words, rendered verbatim — never truncated, never
      // summarised.
      const because = ruling.reason !== undefined ? ` — ${ruling.reason}` : '';
      lines.push(`Ruled: ${ruling.by} at ${ruling.at} (${was})${because}`);
    }
  }
  // The one-line cause has never been rendered here — four rounds of #367/#373 review kept
  // finding that the operator's primary surface shows the failed SET but not why the run ended.
  if (run.terminal_reason !== undefined) {
    lines.push(`Cause: ${run.terminal_reason}`);
  }
  // issue #401: failed drive attempts. Before this, a run whose drive kept dying showed nothing
  // here at all — the console said so once, at the time, to whoever happened to be watching.
  //
  // issue #600 PR 1b: EVERY entry the ring holds renders now, oldest first — before this PR only
  // `entries[length - 1]` ever reached the screen, so a run with several distinct failures showed
  // just the most recent one. Each entry's cost line indents FOUR spaces (was two) so N failures
  // scan as N events and not 2N, and the rolled-total line moves to AFTER every entry+usage pair.
  const driveFailures = run.drive_failures;
  if (driveFailures !== undefined && driveFailures.entries.length > 0) {
    lines.push('');
    lines.push('Drive failures:');
    const driveFailureCosts = composeDriveFailureCosts(run);
    driveFailures.entries.forEach((entry, i) => {
      // Each discriminator renders only when present: an operator debugging a 429 storm needs the
      // status and the Retry-After; padding every line with absent fields buries what matters.
      const status =
        entry.last_observed_status !== undefined
          ? ` (status ${String(entry.last_observed_status)})`
          : '';
      const retryAfter =
        entry.retry_after_observed_ms !== undefined
          ? ` (Retry-After ${String(entry.retry_after_observed_ms)}ms observed)`
          : '';
      // Each clock renders INDEPENDENTLY. Pairing them behind one guard meant a ceiling-only entry
      // printed `declared 0ms` — a fabricated number an operator would read as "the timeout was set
      // to zero", which is a different bug report than the one they actually have.
      const declared =
        entry.declared_per_attempt_ms !== undefined
          ? ` (declared ${String(entry.declared_per_attempt_ms)}ms)`
          : '';
      const ceiling =
        entry.derived_ceiling_ms !== undefined
          ? ` (ceiling ${String(entry.derived_ceiling_ms)}ms)`
          : '';
      const attempts =
        entry.attempts_sdk !== undefined ? ` (attempt ${String(entry.attempts_sdk)})` : '';
      lines.push(
        `  ${entry.at}  ${entry.step}  ${entry.provider}  ` +
          `${entry.error_class} after ${String(entry.elapsed_ms)}ms: ` +
          // Collapsed at RENDER only. `sanitizeError` preserves newlines and provider errors carry
          // them routinely; rendered raw, one entry sprawls over four lines and the block stops
          // being scannable. The RECORD keeps the raw sanitized message — it is evidence, and it
          // must not go lossy because one surface wants a single line.
          `${entry.message.replace(/\s+/g, ' ')}` +
          `${status}${retryAfter}${declared}${ceiling}${attempts}`,
      );
      // issue #600 PR 1a (D9) / #611: what THIS attempt already cost, so a stuck run's screen
      // discloses spent money, not only the error.
      const cost = driveFailureCosts[i]?.cost;
      if (cost !== undefined) {
        lines.push(formatDriveFailureUsage(cost, entry.error_class));
      }
    });
    // Only when the ring has ROLLED — otherwise this line would restate a count the entries
    // themselves already show.
    if (driveFailures.total > driveFailures.entries.length) {
      lines.push(`  ${String(driveFailures.total)} total since ${driveFailures.first_failed_at}`);
    }
    lines.push('');
  }
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
  // issue #232: read-time derivation, computed UNIFORMLY regardless of terminal state or seal
  // outcome (complete/failed/aborted/still running) — via the SAME shared helper the persisted
  // RunRecord.defaulted_steps field is stamped from (issue #220 PR-2, complete-only). Omitted
  // entirely when empty (AC-3) — never a "Defaulted: (none)" line.
  const defaultedSteps = deriveDefaultedSteps(run.evidence);
  if (defaultedSteps.length > 0) {
    lines.push(`Defaulted (settled by default): ${defaultedSteps.join(', ')}`);
  }
  lines.push(`Created: ${run.created_at}`);
  lines.push(`Updated: ${run.updated_at}`);

  // issue #291 (Deliverable 7): an open gate's due/overdue state — off the SAME shared
  // computeGateDueState derivation list/get_run_state also read from. The EXPIRED fact ITSELF is
  // additionally (and independently) disclosed via the gate_expired_awaiting_drive run-health
  // finding below (the generic finding-render loop already covers it); this line's own job is
  // the reminder due/overdue annotation, which [B1] deliberately keeps OUT of run-health.
  if (derivedPhase === 'gate_waiting' && run.pending_gate !== undefined) {
    const gate = run.pending_gate;
    const due = computeGateDueState(gate, new Date());
    // issue #406: the gate id is on the line because `realm run respond --gate <gate-id>` needs
    // it, and the --stuck label now points an operator here to get it. The drive-time surfaces
    // that already print it are the ones a stuck run no longer has.
    let gateLine = `Gate: ${gate.step_name} (gate ${gate.gate_id}, opened ${formatGateAge(gate.opened_at)} ago)`;
    if (due.expired) {
      gateLine += ` — EXPIRED ${formatGateAge(gate.expires_at!)} ago`;
    }
    if (due.next_reminder_due_at !== undefined) {
      const overdueReminder = new Date(due.next_reminder_due_at).getTime() <= Date.now();
      gateLine += overdueReminder
        ? `, reminder overdue (was due ${formatGateAge(due.next_reminder_due_at)} ago)`
        : `, reminder due in ${formatGateAge(new Date().toISOString(), new Date(due.next_reminder_due_at))}`;
    }
    lines.push(gateLine);
    // issue #406: the OTHER argument `realm run respond` requires. Rendered from
    // `run.pending_gate.choices`, which is the same source BOTH validation sites read
    // (execution-loop.ts's CLI path and settlement.ts's store path each do
    // `pending_gate.choices.includes(...)`) — and the field is frozen at mint, so a definition
    // edited after this gate opened never applies to it. Printed and accepted cannot drift.
    //
    // Empty renders NOTHING rather than an empty menu: the authored form is a load error since
    // #433 — but a GRANDFATHERED registered copy (registered before #433 shipped) can still
    // carry `gate.choices: []` and keeps running, and that such a gate is human-unresolvable
    // stays true for that population, not this line's to fix. An ABSENT `choices` is out of
    // contract — the field is required and always minted — and is trusted exactly as the Gate
    // line above trusts `gate_id` and `step_name`.
    if (gate.choices.length > 0) {
      lines.push(`  Choices: ${gate.choices.join(', ')}`);
    }
  }

  // issue #221: typed run-health findings — the SAME shared classifyRunHealth predicate the three
  // READ surfaces (get_run_state, list --stuck, inspect) derive from. Definition-aware when
  // resolved above (adds eligible_steps evidence to any never_claimed_idle finding); tolerates
  // definitionMissing (classification still runs, just without that evidence).
  //
  // Note: `realm run reclaim` is a separate, independent consumer of the underlying record facts
  // (settle sets, capability_blocks, reclaim-audit evidence) — it does NOT call this function; see
  // its own classifyNoActiveClaim discriminator in reclaim-step.ts.
  const runHealth = classifyRunHealth(run, {
    ...(definition !== undefined ? { definition } : {}),
    ...(definitionError !== undefined ? { definitionError } : {}),
  });
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
    // issue #558 PR-T — the helper's composed sentence already names the class ("could not be
    // read (EACCES: …)", "is not parseable JSON", "was registered with an older version"), the
    // way out and the repair — a class prefix here said "could not be read" twice (executed on
    // the pre-fold build). The bare "not found" line survives only for a non-WorkflowError escape.
    // R4 (the review walk): on a LIVE run the `definition_unresolvable` finding above already
    // carries the composed sentence — printed twice, the screen read as two different failures.
    // The parenthetical carries it only when no finding does (a terminal run: the finding is
    // minted for live runs only, review fold C6).
    const carriedByFinding = runHealth.some((f) => f.kind === 'definition_unresolvable');
    lines.push(
      carriedByFinding
        ? // R13 (walk 2): the bare form was subjectless — say where the reason is (Run Health
          // prints before this line, always).
          '(showing run record only \u2014 the reason is in Run Health above)'
        : definitionError !== undefined
          ? `(showing run record only \u2014 ${definitionError.message})`
          : '(workflow definition not found \u2014 showing run record only)',
    );
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
  lines.push(`Evidence (${stepOrder.length} ${stepOrder.length === 1 ? 'step' : 'steps'}):`);

  stepOrder.forEach((stepId, idx) => {
    const snaps = stepSnapshots.get(stepId)!;
    // issue #600 PR 1b: multi-attempt is now keyed on EXECUTION-entry count alone — the `attempt`
    // field is ignored. A resumed agent step has two execution entries and no `attempt` at all;
    // the old `snaps.length > 1 && snaps.some(s => s.attempt !== undefined)` gate sent it to the
    // single branch, which renders only `snaps[0]` — the FAILED first entry, hiding the success.
    const executionSnaps = snaps.filter((s) => s.kind === undefined || s.kind === 'execution');
    const gateSnaps = snaps.filter((s) => s.kind === 'gate_response');
    const isMultiAttempt = executionSnaps.length >= 2;
    const totalAttempts = executionSnaps.length;
    const view = stepViews[stepId];
    const attempts = view?.attempts ?? [];

    lines.push('');

    if (isMultiAttempt) {
      // Show step name as header, then each attempt as a sub-item.
      const lastSnap = executionSnaps[executionSnaps.length - 1]!;
      const profileLabel =
        lastSnap.agent_profile !== undefined
          ? chalk.cyan(` [profile: ${lastSnap.agent_profile}]`)
          : '';
      lines.push(`  ${idx + 1}. ${stepId}${profileLabel}`);
      executionSnaps.forEach((snap, ai) => {
        const statusColored = colorStatus(snap.status);
        const hashShort = chalk.dim(`hash: ${snap.evidence_hash.slice(0, 8)}`);
        lines.push(
          `     (attempt ${ai + 1}/${totalAttempts})  ${statusColored}   ${snap.duration_ms}ms   ${hashShort}`,
        );
      });
      // Show Input/Output/Trace/Tool calls for the last attempt.
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
      if (lastSnap.tool_calls === undefined) {
        // callStep path — print nothing
      } else if (lastSnap.tool_calls.length === 0) {
        lines.push('     Tools declared, none called');
      } else {
        lines.push(`     Tool calls (${lastSnap.tool_calls.length}):`);
        for (const tc of lastSnap.tool_calls) {
          const errSuffix = tc.error ? `  error: ${tc.error}` : '';
          lines.push(`       [${tc.server_id}:${tc.tool}]  ${tc.duration_ms}ms${errSuffix}`);
          if (options?.verbose) {
            lines.push(`         args:   ${formatSummary(tc.args)}`);
            const resultStr = typeof tc.result === 'string' ? tc.result : '(null)';
            lines.push(`         result: ${resultStr}`);
          }
        }
      }
      // issue #600 PR 1b: every EARLIER attempt's cost, chronological, one line each — only for an
      // attempt that carries cost/cost_unrecorded/cost_unreadable (a handler-classified earlier
      // attempt gets no line at all, exactly as it gets no segment on the single-step line).
      for (let ai = 0; ai < totalAttempts - 1; ai += 1) {
        const attempt = attempts[ai];
        if (attempt === undefined) continue;
        const label = `attempt ${ai + 1}/${totalAttempts}`;
        if (attempt.cost !== undefined) {
          const prompt = formatPromptSegment(attempt.cost).replace(/^ \| /, '');
          const output = formatOutputSegment(attempt.cost).replace(/^ \| /, '');
          const cache = formatCache(attempt.cost);
          const segs = [prompt, output, cache].filter((s) => s !== '');
          lines.push(chalk.dim(`     ${label}: ${segs.join(' | ')}`));
        } else {
          const sentence = costAbsenceSentence(attempt.cost_unrecorded, attempt.cost_unreadable);
          if (sentence !== undefined) lines.push(chalk.dim(`     ${label}: ${sentence}`));
        }
      }
      const lastAttempt = attempts[totalAttempts - 1];
      if (lastSnap.diagnostics !== undefined) {
        // issue #600 PR 1b: LABELLED `Diagnostics (attempt n/n):` — an unlabelled line here read,
        // in a fresh walk, as the step's WHOLE cost rather than its last attempt's alone.
        lines.push(
          chalk.dim(
            `     Diagnostics (attempt ${totalAttempts}/${totalAttempts}): ` +
              `${formatDiagnostics(lastSnap.diagnostics, lastAttempt?.cost)}`,
          ),
        );
      }
      const lastSentence = costAbsenceSentence(
        lastAttempt?.cost_unrecorded,
        lastAttempt?.cost_unreadable,
      );
      if (lastSentence !== undefined) {
        lines.push(chalk.dim(`     ${lastSentence}`));
      }
      // issue #600 PR 1b: a multi-attempt step's gate_response entries render AFTER, each as
      // today's gate block, with no header line of their own.
      for (const gate of gateSnaps) {
        const choice = gate.input_summary['choice'] ?? gate.output_summary['choice'];
        if (choice !== undefined) {
          lines.push(`     Choice:   ${String(choice)}`);
        }
        if (gate.gate_message !== undefined) {
          lines.push(`     Message:  "${gate.gate_message}"`);
        }
        lines.push(`     Output:   ${formatSummary(gate.output_summary)}`);
      }
    } else {
      // The single-entry branch is otherwise UNCHANGED: it still renders `snaps[0]` alone,
      // whatever its kind. A step with one execution entry and a gate_response renders exactly as
      // today — a known, separately homed issue (the gate answer hidden when the gate step ran
      // first → P4).
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
        const singleAttempt = view?.attempts[0];
        if (snap.diagnostics !== undefined) {
          lines.push(
            chalk.dim(
              `     Diagnostics: ${formatDiagnostics(snap.diagnostics, singleAttempt?.cost)}`,
            ),
          );
        }
        // issue #600 PR 1b: the absence sentence — beneath Diagnostics when there is one, beneath
        // the entry line otherwise (a step whose evidence carries no `diagnostics` at all).
        const sentence = costAbsenceSentence(
          singleAttempt?.cost_unrecorded,
          singleAttempt?.cost_unreadable,
        );
        if (sentence !== undefined) {
          lines.push(chalk.dim(`     ${sentence}`));
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
