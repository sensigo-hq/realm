// inspect command — displays the full evidence chain and diagnostics for a run.
//
// Read-only invariant: this command must never gain the capability to execute project
// code. The drift-evidence rendering and --check-drift recomputation below therefore use
// ONLY the pure fingerprint module (extension-identity.ts — fs reads + sha256, no dynamic
// import, no createRequire), never the extensions loader.
import chalk from 'chalk';
import { Command } from 'commander';
import { isAbsolute, join } from 'node:path';
import {
  describePending,
  lastExecutionIdentity,
  pendingCleanupLine,
  pendingGateQuestion,
  composeQuestionView,
  discloseGate,
  stripSpanMarks,
  resumeWay,
  dueExpiry,
  composeWaysAt,
  narrowForDoor,
  DOOR_SERVES,
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
  composeRunCost,
  describeClaimHolder,
  answerArrivalOf,
  isAnswerEntry,
  outputSourceOf,
  readSupplier,
  buildDisclosureSet,
  escapedBoundedValue,
  FIXED_TERMINAL_REASONS,
  type DisclosureReceipt,
  controlEscape,
} from '@sensigo/realm';
import {
  CLI_COMMANDS,
  cannotGoOnWithRefusal,
  cannotRunEntries,
  cannotRunParts,
  cannotRunWayOut,
  capabilityMarkerWayOut,
  operatorInputLine,
  owedCallWords,
  owedItems,
  heldByAnswerWords,
  writerHost,
} from './ways-renderer.js';
// issue #221 correction: the CLI's first command→command import (sanctioned — harmless
// module-level Command construction; `listCommand` is a standalone Commander object never
// auto-registered anywhere by being imported). Reused so inspect's never_claimed_idle age
// rendering matches `realm run list --stuck`'s own `idle: <age>` humanization exactly, rather
// than re-implementing a second formatter.
import { formatGateAge } from './list.js';
import { agentReadyReason } from './run-advance.js';
import type {
  RunStore,
  RunRecord,
  WayOn,
  WorkflowRegistrar,
  WorkflowDefinition,
  EvidenceSnapshot,
  StepDiagnostics,
  ExtensionIdentityEntry,
  SkipDetail,
  CostView,
  CostFigure,
  CostUnrecordedCause,
  AttemptView,
  CacheRequestedEntry,
  Money,
  MoneySource,
  NotPricedCause,
  PriceSource,
  RunCost,
} from '@sensigo/realm';
import { recomputeIdentity } from '../extensions/extension-identity.js';
import { autoEvidence, lifetimeText } from '../agent/prompt-cache.js';
import {
  ABSENCE_WORDS,
  UNSHOWABLE_NAME,
  describeProgram,
  renderAnswerLine,
  quotedForTerminal,
  viewSetFor,
} from '../lib/holder-render.js';
import {
  RUN_PHASE_WORDS,
  digestSpan,
  noteDeclaredStanding,
  questionReceiptWords,
  questionSpan,
  valuesShownFor,
  valuesShownLine,
  valuesWithheldFor,
  valuesWithheldLine,
  warnManifestNotSecretUnset,
  withCommand,
  withholdUnlessAccepted,
  writerCtx,
} from '../output/writer.js';
import {
  addDeclaredValues,
  declaredWords,
  escapePassCut,
  stdoutAudience,
  writerTally,
} from '../output/writer.js';
import { readRunManifest, type RunManifest } from '../lib/read-run-manifest.js';

/**
 * Renders one skipped step's reason inline (issue #111) — kind plus the salient detail.
 * A step lacking a detail (legacy run, or a skip family not yet carrying one) is the caller's
 * responsibility to fall back on; `skipped_steps` stays authoritative regardless.
 */
/**
 * #627 W (§5.4b): the open question's text as the gate froze it at open (`resolved_message`). Without
 * one, the definition tells the cases apart (correction 1, E6; correction 2, 2.1 and 8.3), in order:
 * it cannot be read; the gate's step is not in it; the gate declares a message (an earlier version
 * opened it without keeping it — its words are never printed, they may have changed since); the step
 * declares a `prompt` — the question, through the one composer (`pendingGateQuestion`), LABELLED as
 * read from the workflow as registered now (R14; V-1 freezes it at open); else none.
 */
function openQuestionLine(
  run: RunRecord,
  gate: NonNullable<RunRecord['pending_gate']>,
  definition: WorkflowDefinition | undefined,
): string {
  // #729 PR-3 correction 2 (C2): a question is shown at the declared tier, as every surface shows it
  // (P-9), and the receipt line says so.
  // #729 PR-4 (03 #5): through core's ONE composer, over the gate disclosed for this terminal — the
  // question as the gate stored it when it opened.
  if (gate.resolved_message !== undefined) {
    const { question_text } = composeQuestionView(
      discloseGate(stripSpanMarks(gate), viewSetFor('private'), 'private'),
      definition?.steps[gate.step_name]?.display,
    );
    return `  Question: ${questionSpan(quotedForTerminal(question_text))}`;
  }
  // Correction 1 (E6): with no frozen message and no definition to read, inspect cannot know whether
  // the gate declares one — it says so, never "none".
  if (definition === undefined)
    return "  Question: not shown — the workflow's definition cannot be read";
  const step = definition.steps[gate.step_name];
  if (step === undefined)
    return "  Question: not shown — the gate's step is not in the workflow's definition";
  if (step.gate?.message !== undefined)
    return '  Question: not recorded — this gate was opened by a version of Realm that did not keep its message';
  if (step.prompt !== undefined) {
    let question: string | undefined;
    try {
      question = pendingGateQuestion(definition, { ...run, pending_gate: gate });
    } catch {
      return "  Question: not shown — the step's prompt could not be rendered";
    }
    if (question !== undefined)
      return `  Question (the step's prompt, from the workflow as registered now): ${questionSpan(quotedForTerminal(question))}`;
  }
  return '  Question: none — the gate declares no message and its step no prompt';
}

/**
 * #627 W (§5.4b): the open question's `respond` way as the CLI door narrows it — callable here when
 * its `for` holds the operator or the asked person; `undefined` when the run's ways offer none (no
 * definition, the question's time is up).
 */
function cliRespondWay(
  run: RunRecord,
  definition: WorkflowDefinition | undefined,
): Extract<WayOn, { verb: 'respond' }> | undefined {
  if (definition === undefined || run.terminal_state) return undefined;
  const composed = composeWaysAt(run, new Date(), { definition });
  const narrowed = narrowForDoor(composed, {
    door: 'cli',
    serves: DOOR_SERVES.cli,
    route: 'cli',
    source: { kind: 'default', ref: 'the CLI door' },
  });
  const way = narrowed.ways.find((w) => w.verb === 'respond' && w.for.length > 0);
  return way !== undefined && way.verb === 'respond' ? way : undefined;
}

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
      // H-7'': a stored load error goes through the value span (withheld as its shape).
      lines.push(chalk.red(`     error: ${writerCtx().value(entry.error)}`));
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
    // #729 PR-3 correction 6 (C6-5): drift is judged from execution entries; the creator's start
    // entry is a record of the run's creation, never a baseline.
    const last = lastExecutionIdentity(history);
    if (last === undefined) {
      lines.push(
        "Drift check: no execution has recorded project code yet; the run's creation entry is not compared.",
      );
      return lines;
    }
    lines.push(
      'Drift check (pure recompute of the last execution entry under its recorded rules):',
    );
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
/**
 * F4 (framework §5 E1): the one line `realm run inspect` renders for a bare `auto` step's entry — where
 * its output came from, or why that is not recorded — from core's `outputSourceOf`. `undefined` for an
 * entry that is not a bare step's (or whose workflow cannot be read and that carries no source).
 */
export function outputSourceLine(
  snap: EvidenceSnapshot,
  definition: WorkflowDefinition | undefined,
): string | undefined {
  const read = outputSourceOf(snap, definition);
  if ('absent_cause' in read) {
    return read.absent_cause === 'predates_output_source'
      ? 'Output source: not recorded — this entry was written before Realm recorded it'
      : undefined;
  }
  switch (read.source) {
    case 'driven_step':
      return 'Output source: driven_step — what the call that named the step returned';
    case 'dependency': {
      const dep = definition?.steps[snap.step_id]?.depends_on?.[0];
      return `Output source: dependency — ${dep !== undefined ? `'${dep}'` : 'its dependency'}'s recorded output`;
    }
    case 'run_params':
      return "Output source: run_params — the run's params";
    case 'none':
      return 'Output source: none — nothing to copy, so {} was recorded';
  }
}

/**
 * issue #760 (correction D1): a handler's warning, whole, on one line a terminal cannot be driven by —
 * every control character written out in decision C183's spelling (`\n` reads `\n`). Any handler's
 * warning goes through it, not only `check_quotes`'s. Never `quotedForTerminal`: that is JSON and
 * would write every `"` as `\"`.
 */
function warnLine(warn: string): string {
  // eslint-disable-next-line no-control-regex -- the control characters are what is escaped
  return warn.replace(/[\u0000-\u001f\u007f-\u009f]/g, controlEscape);
}

/** #729 PR-3 (D3/08 S2): escape → pass → cut, with a dimmed `…` (`escapePassCut`). Correction 3
 *  (H-7''): a census render of a stored value, so through the value span while values are withheld
 *  (its shape). */
function formatSummary(value: unknown, maxLength = 120): string {
  if (valuesWithheldFor() !== undefined) return writerCtx().value(value);
  return escapePassCut(JSON.stringify(value) ?? 'undefined', maxLength, chalk.dim('…'));
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
 * Issue #600 caching PR P (ride-along) — a stored word in quotes: `'word'` as before when it needs
 * no escaping, else through `quotedForTerminal` (double quotes, every control character escaped), so
 * no control byte a record carries reaches the terminal.
 */
function quotedWord(word: string): string {
  const quoted = quotedForTerminal(word);
  return quoted.slice(1, -1) === word ? `'${word}'` : quoted;
}

/**
 * Issue #600 PR 1b — the provenance word, READ from the field rather than hardcoded beside it. A
 * word this build does not know is NAMED as unrecognised rather than printed as though it were a
 * fact — this slot is where an operator learns whether a number was measured.
 */
function basisWord(basis: string | undefined): string {
  if (basis === 'provider_reported') return 'provider-reported';
  // `composeCostView` keeps `basis` only when it is a string, so a missing, `null` or corrupt
  // (non-string) basis all arrive here as `undefined`. `no readable basis` is true of all three;
  // `not recorded` would be false for a corrupt value, and quoting a token the record lacks is worse.
  if (basis === undefined) return 'no readable basis';
  if ((CACHE_BASES as readonly string[]).includes(basis)) return basis;
  // issue #600 caching PR P (ride-along): a stored word reaches the terminal escaped.
  return `unrecognized basis ${quotedWord(basis)}`;
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
  // The `basisWord` rule, applied to its sibling. `composeCostView` keeps `state` only when it is a
  // string, so a missing, `null` or corrupt (non-string) state all arrive here as `undefined`.
  // `no readable state` is true of all three; quoting `'undefined'` asserted a token the record lacks.
  if (cost.state === undefined) {
    return `cache: no readable state — ${read}, ${wrote} (${includedClause}${prov}, ${scope})`;
  }
  if (!(CACHE_STATES as readonly string[]).includes(cost.state)) {
    return `cache: unrecognized state ${quotedWord(cost.state)} — ${read}, ${wrote} (${includedClause}${prov}, ${scope})`;
  }
  if (cost.state === 'never_engaged') {
    return `cache: not engaged — ${read}, ${wrote} (${prov}, ${scope})`;
  }
  return `cache: ${read}, ${wrote} (${includedClause}${prov}, ${scope})`;
}

/**
 * Issue #600 PR 2 (D3) — a stored name (a model, a runner) as the terminal shows it: as written, or
 * quoted through `quotedForTerminal` when it needs it, that is when escaping would change it (a `"`
 * or a `\`). `readStoredName` has already refused a name with a control character.
 */
function nameForTerminal(name: string): string {
  const quoted = quotedForTerminal(name);
  return quoted.slice(1, -1) !== name ? quoted : name;
}

/** The longest lifetime the record's render accepts as stated: 7 days, in seconds. */
const MAX_LIFETIME_S = 604_800;

/**
 * Issue #600 (D3; the lifetime unit) — a stored lifetime as the operator reads it, or `undefined`
 * when it is not a whole number of seconds from 1 to 7 days: exact words (`5 minutes`, `1 hour`,
 * `90 seconds` — `lifetimeText`, the start line's own); core's `formatDuration` would round 90 s to
 * `1m`.
 */
function lifetimeWord(seconds: number | undefined): string | undefined {
  if (seconds === undefined || !Number.isInteger(seconds)) return undefined;
  if (seconds < 1 || seconds > MAX_LIFETIME_S) return undefined;
  return lifetimeText(seconds);
}

/** Issue #600 PR 2 (D3) — where an ask's setting came from, and which runner chose it. */
function askSourceText(entry: CacheRequestedEntry): string {
  const by = entry.by !== undefined ? nameForTerminal(entry.by) : undefined;
  if (entry.source === undefined) return 'source not recorded';
  if (entry.source === 'stated') return by !== undefined ? `stated on ${by}` : 'stated';
  if (entry.source === 'runner_default') {
    return by !== undefined ? `${by}'s default` : "a runner's default";
  }
  return `unrecognized source ${quotedForTerminal(entry.source)}`;
}

/**
 * Issue #600 PR 2 (D3) — one distinct ask, in words; the lifetime unit: when `auto` chose it, what it
 * read (`; auto: <evidence>`, the start line's words).
 */
function askEntryText(entry: CacheRequestedEntry): string {
  const auto = entry.auto !== undefined ? `; auto: ${autoEvidence(entry.auto)}` : '';
  if (entry.value === 'off') return `asked for no caching (${askSourceText(entry)}${auto})`;
  if (entry.value === 'provider_rules') {
    return "asked for nothing (the provider's own caching, if any, applies)";
  }
  if (entry.value !== 'lifetime') return `asked: unrecognized ${quotedForTerminal(entry.value)}`;
  if (entry.lifetime_s === undefined) return 'asked for a lifetime the record does not state';
  const lifetime = lifetimeWord(entry.lifetime_s);
  if (lifetime === undefined) return 'asked for a lifetime: unrecognized lifetime';
  const sent =
    entry.ttl_sent === undefined
      ? 'whether Realm sent it is not recorded'
      : entry.ttl_sent
        ? `sent as ${lifetime}`
        : "the provider's default lifetime";
  return `asked for ${lifetime} (${sent}; ${askSourceText(entry)}${auto})`;
}

/**
 * Issue #600 PR 2 (D3) — THE one composer of a cost line's request facts, shared by the step line,
 * each earlier attempt's line and the failed-drive line, so the three print the same words.
 * `model`: the model the responses named. `ask`: what realm asked the provider to cache, then —
 * when the record shows it — a write kept for another lifetime than the one asked, or a lifetime
 * asked with nothing written or read. A fact the record holds no readable value for (`absent_cause`,
 * A5) prints nothing: a record without the request facts prints exactly what it printed before.
 */
function requestFactsText(cost: CostView): { model?: string; ask?: string } {
  const out: { model?: string; ask?: string } = {};
  const models = cost.models;
  if (models !== undefined && !('absent_cause' in models)) {
    const names = models.names.map(nameForTerminal);
    const base =
      names.length === 1
        ? `model ${names[0]}`
        : `models ${names.join(', ')} (the requests used different models)`;
    out.model =
      models.reported < models.of
        ? `${base} (named by ${models.reported} of ${models.of} requests)`
        : base;
  }
  const asked = cost.cache_requested;
  if (asked !== undefined && !('absent_cause' in asked)) {
    const clauses = [
      asked.entries.map(askEntryText).join(', then ') +
        (asked.reported < asked.of
          ? ` (recorded by ${asked.reported} of ${asked.of} requests)`
          : ''),
    ];
    const only = asked.entries.length === 1 ? asked.entries[0] : undefined;
    if (only?.value === 'lifetime') {
      const kept5m = cost.cache_write_5m?.value ?? 0;
      const kept1h = cost.cache_write_1h?.value ?? 0;
      if (only.lifetime_s === 3600 && kept5m > 0) {
        clauses.push(
          `${kept5m} of the tokens written were kept for 5 minutes, not the 1 hour asked`,
        );
      } else if (only.lifetime_s === 300 && kept1h > 0) {
        clauses.push(
          `${kept1h} of the tokens written were kept for 1 hour, not the 5 minutes asked`,
        );
      }
    }
    const zeroFromEvery = (fig: CostFigure | undefined): boolean =>
      fig !== undefined && fig.reported === fig.of && fig.value === 0;
    if (
      asked.entries.some((e) => e.value === 'lifetime') &&
      zeroFromEvery(cost.cache_read) &&
      zeroFromEvery(cost.cache_write)
    ) {
      // issue #600 caching PR P: the gateway reason, only where a request went to a custom endpoint.
      const gateway =
        cost.endpoints !== undefined && 'custom' in cost.endpoints && cost.endpoints.custom > 0;
      clauses.push(
        "nothing was written or read: the cached part may be shorter than the model's minimum" +
          (gateway ? ', or the endpoint dropped the request to cache' : ''),
      );
    }
    out.ask = clauses.join('; ');
  }
  return out;
}

/**
 * Issue #600 caching PR P — a USD figure as the operator reads it: three significant figures below
 * $1 (trailing zeros dropped), two decimals from $1; an exact zero is `$0`. `floor` floors instead
 * of rounding, for a figure that is a lower bound (rounding a "≥" up would make it false).
 */
export function formatUsd(value: number, floor = false): string {
  if (value === 0) return '$0';
  const round = (x: number): number => (floor ? Math.floor(x + 1e-9) : Math.round(x));
  if (value < 1) {
    const exponent = Math.floor(Math.log10(value));
    const places = 2 - exponent;
    const scaled = round(value * 10 ** places) / 10 ** places;
    if (scaled < 1) return `$${scaled.toFixed(places).replace(/\.?0+$/, '')}`;
    return `$${scaled.toFixed(2)}`;
  }
  return `$${(round(value * 100) / 100).toFixed(2)}`;
}

/** Issue #600 caching PR P — a source's name: the runner's file, or the list and its version. */
function sourceLabel(source: Pick<MoneySource, 'source_class' | 'version'>): string {
  if (source.source_class === 'economics') return 'your economics file';
  return source.version === undefined || source.version === 'version unknown'
    ? 'genai-prices, version unknown'
    : `genai-prices ${source.version}`;
}

/** Issue #600 caching PR P — the date basis of figures: how many of `count` were priced at the call's date. */
function dateBasisText(dated: number, count: number): string {
  if (dated === count) return "at the call's date";
  if (dated === 0) return 'current price';
  return `${dated} at the call's date, ${count - dated} current`;
}

/** Issue #600 caching PR P — `prices from: <name> (N), <name> (M)`, from core's per-source counts. */
function sourceTotalsText(money: Money): string {
  return `prices from: ${money.source_totals.map((t) => `${sourceLabel(t)} (${t.count})`).join(', ')}`;
}

/** A host's or a list's free text, escaped when it needs it. */
function safeText(text: string): string {
  const quoted = quotedForTerminal(text);
  return quoted.slice(1, -1) === text ? text : quoted;
}

/** Issue #600 caching PR P — why a request has no price, in the operator's words. */
function notPricedWords(cause: NotPricedCause, detail: string | undefined): string {
  const d = detail !== undefined ? safeText(detail) : undefined;
  switch (cause) {
    case 'no_price_source':
      return (
        'no price source: add prices in runner.cache.economics, or install @pydantic/genai-prices beside realm' +
        (d !== undefined ? ` (${d})` : '')
      );
    case 'economics_unreachable':
      return `economics unreachable: ${d ?? 'no reason given'}`;
    case 'economics_unreadable':
      return `your economics file: ${d ?? 'it does not parse'}`;
    case 'model_not_recorded':
      return 'model not recorded';
    case 'model_unknown':
      return (
        'no price for this model: add it to your economics file' +
        (d !== undefined ? ` (${d})` : '')
      );
    case 'usage_incomplete':
      return 'the recorded usage is incomplete';
    case 'date_unreadable':
      return "the call's date is unreadable";
    case 'price_list_error':
      return `price list error${d !== undefined ? `: ${d}` : ''}`;
    case 'rate_missing':
      return `your economics file ${d ?? 'lacks a rate'}`;
  }
}

/** The not-priced groups, each with its count when the figure also prices something. */
function notPricedList(money: Money, withCounts: boolean): string[] {
  return (money.not_priced ?? []).map((n) =>
    withCounts || (money.not_priced ?? []).length > 1
      ? `${n.count} not priced: ${notPricedWords(n.cause, n.detail)}`
      : notPricedWords(n.cause, n.detail),
  );
}

/**
 * Issue #600 caching PR P — the sources part of a money figure: the source's name (the runner's
 * file, or one list version), the date basis over all the figures, what they priced a request as
 * when that differs from the recorded model, and their notes. Sources with several names read
 * `prices from: <name> (N), <name> (M)` in place of the one name, then the same parts. With
 * `recordedModels` `undefined` (the run's line: a run records many names), the `priced as` part is
 * left to the step and attempt lines.
 */
function sourcesText(money: Money, recordedModels: readonly string[] | undefined): string {
  const parts = [
    money.source_totals.length > 1 ? sourceTotalsText(money) : sourceLabel(money.source_totals[0]!),
    dateBasisText(money.dated, money.priced),
  ];
  if (recordedModels !== undefined) {
    const pricedAs = money.sources
      .filter((s) => !recordedModels.includes(s.matched_model))
      .map(
        (s) =>
          `priced as ${s.matched_provider !== undefined ? `${safeText(s.matched_provider)}'s ` : ''}${safeText(s.matched_model)}`,
      );
    parts.push(...new Set(pricedAs));
  }
  parts.push(
    ...new Set(
      money.sources.flatMap((s) => (s.endpoint_note !== undefined ? [s.endpoint_note] : [])),
    ),
  );
  parts.push(
    ...new Set(
      money.sources.flatMap((s) => (s.source_note !== undefined ? [safeText(s.source_note)] : [])),
    ),
  );
  return parts.join('; ');
}

/**
 * Issue #600 caching PR P — THE one composer of a cost line's money, shared by the step line, each
 * earlier attempt's line and the failed-drive line. `undefined` when there is nothing to say: no
 * price source was given, no request, or every request names no model (a record from 0.47.0 or
 * earlier prints exactly what it printed before).
 */
function moneyText(cost: CostView): string | undefined {
  const money = cost.money;
  if (money === undefined || money.of === 0) return undefined;
  const notPriced = money.not_priced ?? [];
  if (money.priced === 0) {
    if (notPriced.every((n) => n.cause === 'model_not_recorded')) return undefined;
    return `not priced (${notPricedList(money, false).join('; ')})`;
  }
  const recorded = cost.models !== undefined && 'names' in cost.models ? cost.models.names : [];
  const partial = money.priced < money.of;
  const parts = [sourcesText(money, recorded)];
  if (partial) {
    parts.push(`${money.priced} of ${money.of} requests priced`, ...notPricedList(money, true));
  }
  const figure = partial ? `≥ ${formatUsd(money.total, true)}` : formatUsd(money.total);
  return `${figure} (${parts.join('; ')})${netText(money)}`;
}

/**
 * Issue #600 caching PR P — what caching saved or cost, after a money figure: `; caching saved $X`,
 * `; caching cost $X more`, or nothing when the net is 0. Shared by `moneyText` and the run's line.
 */
function netText(money: Money): string {
  return money.net > 0
    ? `; caching saved ${formatUsd(money.net)}`
    : money.net < 0
      ? `; caching cost ${formatUsd(-money.net)} more`
      : '';
}

/**
 * Issue #600 caching PR P — a step's money across its attempts, for its header:
 * ` — $0.123 across 3 attempts (your economics file)`. A lower bound (`≥`, floored) when a request
 * was not priced, or when `leavesOut`: one of its attempts has no usage figures, so its cost is not
 * in the figure. Empty when nothing was priced.
 */
function stepTotalText(total: Money | undefined, attempts: number, leavesOut: boolean): string {
  if (total === undefined || total.priced === 0) return '';
  const figure =
    total.priced < total.of || leavesOut
      ? `≥ ${formatUsd(total.total, true)}`
      : formatUsd(total.total);
  const names = total.source_totals.map((t) => sourceLabel(t)).join(', ');
  return ` — ${figure} across ${attempts} attempts (${names})`;
}

/**
 * Issue #600 caching PR P — the run's cost line, after `Phase:`. Every request of every step and of
 * every failed drive on the record, with what the figure leaves out: attempts realm has no usage
 * for, failed drives on the record with no usage figures, and failed drives no longer on the
 * record. A full figure, as the step's: its sources, its date basis, its notes and what caching
 * saved or cost (the `priced as` part is left to the step lines). `undefined` when there is nothing
 * to price, or when every request names no model.
 */
function runCostLine(cost: RunCost | undefined): string | undefined {
  if (cost === undefined) return undefined;
  const money = cost.total;
  if (money.of === 0) return undefined;
  const notPriced = money.not_priced ?? [];
  if (money.priced === 0) {
    if (notPriced.every((n) => n.cause === 'model_not_recorded')) return undefined;
    return `Cost: not priced (${notPricedList(money, false).join('; ')})`;
  }
  const leftOut: string[] = [];
  const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
  if (cost.unmeasured.tool_calling_step > 0) {
    leftOut.push(
      `${plural(cost.unmeasured.tool_calling_step, 'tool-calling attempt', 'tool-calling attempts')} not measured`,
    );
  }
  if (cost.unmeasured.cost_unreadable > 0) {
    leftOut.push(
      `${plural(cost.unmeasured.cost_unreadable, 'attempt', 'attempts')} with unreadable usage`,
    );
  }
  if (cost.unmeasured.not_measured_by_realm > 0) {
    leftOut.push(
      `${plural(cost.unmeasured.not_measured_by_realm, 'attempt', 'attempts')} realm has no usage figures for`,
    );
  }
  // The drives on the record first, then the ones off it.
  if (cost.failed_drives_without_usage > 0) {
    leftOut.push(
      `${plural(cost.failed_drives_without_usage, 'failed drive', 'failed drives')} without usage figures`,
    );
  }
  if (cost.failed_drives_not_on_record > 0) {
    leftOut.push(
      `${plural(cost.failed_drives_not_on_record, 'failed drive', 'failed drives')} not on the record`,
    );
  }
  const lowerBound =
    money.priced < money.of ||
    cost.unmeasured.tool_calling_step > 0 ||
    cost.unmeasured.cost_unreadable > 0 ||
    cost.unmeasured.not_measured_by_realm > 0 ||
    cost.failed_drives_without_usage > 0 ||
    cost.failed_drives_not_on_record > 0;
  const figure = lowerBound ? `≥ ${formatUsd(money.total, true)}` : formatUsd(money.total);
  const parts = [
    sourcesText(money, undefined),
    `${money.priced} of ${money.of} requests priced`,
    ...(money.priced < money.of ? notPricedList(money, true) : []),
    ...leftOut,
  ];
  return `Cost: ${figure} (${parts.join('; ')})${netText(money)}`;
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
  // issue #600 PR 2 (D3): the model, then the ask, through the shared composer.
  const facts = requestFactsText(cost);
  const model = facts.model !== undefined ? `; ${facts.model}` : '';
  const ask = facts.ask !== undefined ? `; ${facts.ask}` : '';
  // issue #600 caching PR P: the money, through the shared composer.
  const money = moneyText(cost);
  return `    usage: ${scope} billed ${ended} — ${promptStr}, ${outputStr}, ${cacheStr}${model}${ask}${money !== undefined ? ` | ${money}` : ''}`;
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
    // Issue #610: pinned by docs-610.test.ts (the realm-run-reading.md `cost` row) and by
    // inspect-cost-view.test.ts / cost-view-disclosure-parity.test.ts (the printed line).
    return 'cost: not recorded — tool-calling step with no recorded usage (realm 0.48.0 or earlier recorded none)';
  }
  if (costUnrecorded === 'not_measured_by_realm') {
    return (
      'cost: not recorded — realm has no usage figures for this attempt (for example: an outside ' +
      'agent over MCP made it, a person typed its answer at a realm workflow run prompt, or realm ' +
      '0.45.0 or earlier recorded it)'
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
  diag: Pick<StepDiagnostics, 'input_token_estimate' | 'precondition_trace' | 'guard_conditions'>,
  cost: CostView | undefined,
): string {
  const tokens = `~${diag.input_token_estimate} tokens (estimate, step input)`;
  const prompt = formatPromptSegment(cost);
  const output = formatOutputSegment(cost);
  // issue #600 PR 2 (D3): the model after output, the ask after the cache segment.
  const facts = cost !== undefined ? requestFactsText(cost) : {};
  const model = facts.model !== undefined ? ` | ${facts.model}` : '';
  const ask = facts.ask !== undefined ? `; ${facts.ask}` : '';
  // issue #600 caching PR P: the money after the cache segment, through the shared composer.
  const money = cost !== undefined ? moneyText(cost) : undefined;
  const cache =
    cost !== undefined
      ? ` | ${formatCache(cost)}${ask}${money !== undefined ? ` | ${money}` : ''}`
      : '';
  // F28 (#729 PR-3 correction 1): a guard step's conditions, every one — the condition, whether it
  // passed, and its value (escaped and bounded; the writer masks the line at stdout's tier).
  const guard =
    diag.guard_conditions !== undefined && diag.guard_conditions.length > 0
      ? ` | guard: ${diag.guard_conditions
          .map(
            (c) =>
              `${c.condition} → ${c.passed ? 'passed' : 'failed'} (${escapedBoundedValue(c.resolved_value)})`,
          )
          .join(', ')}`
      : '';
  if (diag.precondition_trace.length === 0) {
    return `${tokens}${prompt}${output}${model} | no preconditions${guard}${cache}`;
  }
  const traceStr = diag.precondition_trace
    .map((t) => `${t.expression} → ${t.passed ? 'true' : 'false'} (${String(t.resolved_value)})`)
    .join(', ');
  return `${tokens}${prompt}${output}${model} | preconditions: ${traceStr}${guard}${cache}`;
}
/**
 * issue #625 (holder slice): the line naming the program whose code did an attempt's work. The
 * attempt that opened a step's question — the last attempt of a step whose question is open or
 * answered — reads "Question opened through" (the program that OPENED it — never who answered,
 * never who is working on it); every other attempt reads "Taken by". An attempt
 * with no recorded name prints nothing — its absence is withheld on this surface; a stored name
 * that cannot be shown prints the one unshowable phrase and no byte of the value.
 */
function attemptProgramLine(
  attempt: AttemptView | undefined,
  isQuestionStep: boolean,
  supplier = '',
): string | undefined {
  const driven = attempt?.driven_by;
  if (driven === undefined) return undefined;
  const label = isQuestionStep ? 'Question opened through' : 'Taken by';
  if (driven.by !== null) return `${label}: ${describeProgram(driven, writerCtx())}${supplier}`;
  if (driven.absent_cause === 'name_unreadable') return `${label}: ${UNSHOWABLE_NAME}${supplier}`;
  return undefined;
}

/**
 * #729 PR-0 (§5 E1 (iii), T-17 (ii); the implementer's Q20, ruled 2026-10-16): who supplied an
 * attempt's input, said on its attribution line BY RULE — ` — its input supplied by the <role>` only
 * when the role differs from the party the step is designed for (an engine step given an operator's
 * input, T-17's lever). The expected case — an agent's answer to an agent step — and every absence
 * (`not_recorded`, `engine_input`) print nothing: a clause that is the same on every agent attempt is
 * not information, and `driven_by`'s own surface withholds its expected case the same way. In PR-0 no
 * path writes a differing role (`operator` enters with its producer).
 *
 * @internal Exported for testing only.
 */
export function supplierClause(
  entry: Pick<EvidenceSnapshot, 'supplied_by' | 'step_id' | 'kind'>,
  definition: Pick<WorkflowDefinition, 'steps'> | undefined,
): string {
  const read = readSupplier(entry, definition);
  if (!('role' in read)) return '';
  const designed = definition?.steps[entry.step_id]?.execution === 'agent' ? 'agent' : 'engine';
  return read.role === designed ? '' : ` — its input supplied by the ${read.role}`;
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
  options?: {
    verbose?: boolean;
    checkDrift?: boolean;
    /** Issue #600 caching PR P: the prices to show money with (tests inject one). */
    priceSource?: PriceSource;
    /** Issue #600 caching PR P: builds the prices from the run's definition (the command's own). */
    priceSourceFor?: (definition: WorkflowDefinition | undefined) => Promise<PriceSource>;
  },
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
  let definitionError:
    { code: string; message: string; class?: string; repairCommand?: string } | undefined;
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
      // G7: the repair's shell command, printed whole below.
      const command = (err.details as Record<string, unknown> | undefined)?.['repair_command'];
      definitionError = {
        code: err.code,
        message: err.message,
        ...(typeof cls === 'string' ? { class: cls } : {}),
        ...(typeof command === 'string' ? { repairCommand: command } : {}),
      };
    }
  }

  // issue #600 PR 1b: the one composed cost view, derived ONCE from `run` \u2014 every render below
  // reads it rather than re-summing `StepDiagnostics.cache` at each call site.
  // issue #600 caching PR P: money only with a price source — injected, or built from the run's
  // deployment root by the command.
  const priceSource =
    options?.priceSource ??
    (options?.priceSourceFor !== undefined ? await options.priceSourceFor(definition) : undefined);
  const viewDeps = {
    ...(definition !== undefined ? { definition } : {}),
    ...(priceSource !== undefined ? { priceSource } : {}),
  };
  const stepViews = composeStepViews(run, viewDeps);
  // issue #625 (holder slice): a step is a QUESTION step while its question is open and once it has
  // been answered or has expired — the word on its claim and attempt lines changes with it. Keyed on
  // the step's `gate_response` entries, not on its answers: an `on_expiry: abort` expiry leaves an
  // entry that is not an answer, and the step still opened a question.
  const evidenceList: readonly unknown[] = Array.isArray(run.evidence) ? run.evidence : [];
  const isQuestionStepId = (stepId: string): boolean =>
    run.pending_gate?.step_name === stepId ||
    evidenceList.some(
      (e) =>
        typeof e === 'object' &&
        e !== null &&
        (e as Record<string, unknown>)['step_id'] === stepId &&
        (e as Record<string, unknown>)['kind'] === 'gate_response',
    );

  // Color the phase label \u2014 derived, never the persisted run_phase (issue #279, increment 2,
  // PR-C \u2014 D-3 leg vi: render sweep). A grandfathered terminal-with-stale-gate record (the #282
  // class) must render its TRUE phase here, not a stale 'gate_waiting'.
  const derivedPhase = deriveRunPhase(run);
  // #729 PR-3 correction 2 (C1): the phase is realm's own word, printed whole (a span around the
  // enum only, inside its colour).
  const phaseWord = writerCtx().word(derivedPhase, RUN_PHASE_WORDS);
  let phaseLabel: string;
  if (derivedPhase === 'completed') {
    phaseLabel = chalk.green(`${phaseWord}  \u2713`);
  } else if (derivedPhase === 'failed' || derivedPhase === 'abandoned') {
    phaseLabel = chalk.red(phaseWord);
  } else {
    phaseLabel = chalk.yellow(phaseWord);
  }

  const lines: string[] = [];
  lines.push(`Run: ${run.id}`);
  lines.push(`Workflow: ${workflowLabel}`);
  lines.push(`Phase: ${phaseLabel}`);
  // issue #600 caching PR P: what the run cost, priced at read.
  const costLine = runCostLine(composeRunCost(run, viewDeps));
  if (costLine !== undefined) lines.push(costLine);
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
      const because = ruling.reason !== undefined ? ` — ${writerCtx().value(ruling.reason)}` : '';
      lines.push(`Ruled: ${ruling.by} at ${ruling.at} (${was})${because}`);
    }
  }
  // The one-line cause has never been rendered here — four rounds of #367/#373 review kept
  // finding that the operator's primary surface shows the failed SET but not why the run ended.
  if (run.terminal_reason !== undefined) {
    // #729 PR-3 correction 3 (H-8): a fixed sentence is realm's own words, printed whole; any other
    // reason is a stored value (H-7'': withheld as its shape).
    const reason = run.terminal_reason;
    lines.push(
      `Cause: ${FIXED_TERMINAL_REASONS.includes(reason) ? writerCtx().word(reason, FIXED_TERMINAL_REASONS) : writerCtx().value(reason)}`,
    );
  }
  // F28 (#729 PR-3 correction 1): the guard that aborted the run, and its message — a handler's
  // runtime text, escaped and bounded whole (the class `bounded`); its conditions are on the guard
  // step's `Diagnostics:` line.
  if (run.aborted_at !== undefined) {
    const message =
      run.aborted_at.abort_message !== undefined
        ? `: ${writerCtx().escaped(escapedBoundedValue(run.aborted_at.abort_message))}`
        : '';
    lines.push(`Aborted at: '${run.aborted_at.step_id}'${message}`);
  }
  // decision C205: a run that ended with failed steps `realm run resume` takes (core's one rule,
  // C204 — never a cleanup step) names them and the command that makes them runnable again.
  // F2: the operator's own read surface names the fact for a run an operator ended too, with what
  // resuming it does — no other surface offers it there.
  const resumable = definition === undefined ? undefined : resumeWay(run, definition);
  if (resumable !== undefined) {
    lines.push(
      `Resumable: ${resumable.steps.map((step) => `'${step}'`).join(', ')} — ${resumable.command}` +
        (deriveRunPhase(run) === 'abandoned'
          ? " — resuming erases the operator's ending and its reason, and records no one and no reason for the undo"
          : ''),
    );
  }
  // decision C211 (walk c14 W3-4's class): cleanup steps the ending left pending — the command that
  // runs them.
  const cleanup = pendingCleanupLine(run, new Date());
  if (cleanup !== undefined) lines.push(cleanup);
  // issue #625 PR-2a (D7.3): what the engine owes on a live run with no open question, and each
  // step this record shows cannot run — an engine step, or an agent step refused before its claim
  // (decision C82). No registry here: a capability need is judged by the run's own marker (what the
  // runner that last attempted the step lacked), else is unknown (decision C33).
  // decision C95: an open question whose time is up and that declares `on_expiry` is owed engine
  // work too — named here with the command that carries it out.
  const inspectNow = new Date();
  if (
    definition !== undefined &&
    !run.terminal_state &&
    (run.pending_gate === undefined || dueExpiry(run.pending_gate, inspectNow) !== undefined)
  ) {
    const pending = describePending(definition, run, undefined, inspectNow);
    // #729 PR-0 (A-10): the run's ways, composed by core with no registry (an observer, C33), and
    // rendered by the CLI's one renderer.
    const ways = composeWaysAt(run, inspectNow, { definition });
    const advance = ways.ways.find((w) => w.verb === 'advance');
    if (advance !== undefined && advance.verb === 'advance') {
      // decision C207: with several owed, where the call stops — the clause the preview ends with.
      // decision C212: the words after the command are set off by a space — no punctuation follows
      // it (`owedCallWords`).
      lines.push(
        `Owed to the engine: ${owedItems(advance).join(', ')} — ${CLI_COMMANDS.advance(advance, undefined, writerHost())}${owedCallWords(advance)}`,
      );
    }
    // decision C205: an agent step ready — the drive, in the words `realm run advance` and `realm
    // run respond` print.
    const ready = agentReadyReason(run.id, pending.agent_steps);
    if (ready !== undefined) lines.push(`${ready.charAt(0).toUpperCase()}${ready.slice(1)}`);
    for (const entry of cannotRunEntries(ways)) {
      const e = cannotRunParts(entry);
      if (e === undefined) continue;
      // decision C41: a capability refusal judged from the run's marker (inspect passes no
      // registry) is past tense — no runner was consulted here.
      const verb = e.marker ? 'Could not run' : 'Cannot run';
      // decision C53: the marker line ends with its way out — a program that has the extension
      // runs the step.
      const wayOut = e.marker ? capabilityMarkerWayOut(run.id, writerCtx()) : '';
      lines.push(`${verb} '${e.step}' (${e.check}): ${e.refusal}${wayOut}`);
      // PR0-CONTRACT Amendment 14 (T-17's lever): an operator may supply this step's input — a fact.
      const lever = operatorInputLine(entry);
      if (lever !== undefined) lines.push(lever);
    }
    // decision C62: when the run cannot go on until its workflow is corrected, the way out follows
    // the steps that cannot run — the line `realm run advance` and the drive's stop line print.
    if (cannotGoOnWithRefusal(ways))
      lines.push(cannotRunWayOut(ways, run.id, deriveRunPhase(run), writerCtx()));
  }
  // decision C211 (walk c14 W2-2): at an open question, the steps it holds — they go on after the
  // answer, and nothing is owed until then.
  if (
    definition !== undefined &&
    !run.terminal_state &&
    run.pending_gate !== undefined &&
    dueExpiry(run.pending_gate, inspectNow) === undefined
  ) {
    // #729 PR-0 (Part B): the steps the question holds are its `respond` way's, in the CLI's words.
    const respond = composeWaysAt(run, inspectNow, { definition }).ways.find(
      (w) => w.verb === 'respond',
    );
    const waiting = heldByAnswerWords(respond?.verb === 'respond' ? respond.holds : []);
    if (waiting !== undefined) {
      lines.push(`Question open on '${run.pending_gate.step_name}': ${waiting}.`);
    }
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
    const driveFailureCosts = composeDriveFailureCosts(
      run,
      priceSource !== undefined ? { priceSource } : undefined,
    );
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
          `${writerCtx().value(entry.message.replace(/\s+/g, ' '))}` +
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
  // issue #625 (holder slice): one line per in-progress step — the program that took it, how its
  // name is known, the door it came through, how long ago; or why there is no name. A step whose
  // question is open or answered reads "question opened through": that claim names the program
  // through which the question was OPENED, never who is working on it now.
  for (const step of run.in_progress_steps) {
    const described = describeClaimHolder(run.claims?.[step], store.persistsClaims === true);
    const verb = isQuestionStepId(step) ? 'question opened through' : 'taken by';
    const sinceMs = described.since !== undefined ? Date.parse(described.since) : Number.NaN;
    const age = Number.isFinite(sinceMs) ? `, ${formatGateAge(described.since!)} ago` : '';
    // An unreadable name keeps the verb ("taken by a recorded name that cannot be printed …"); the
    // other absences are whole sentences of their own.
    const body =
      'holder' in described
        ? `${verb} ${describeProgram(described.holder, writerCtx())}`
        : described.absent_cause === 'name_unreadable'
          ? `${verb} ${ABSENCE_WORDS.name_unreadable}`
          : ABSENCE_WORDS[described.absent_cause];
    lines.push(`  ${step}: ${body}${age}`);
  }
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
    // #627 W (§5.4b): the question as it was frozen when the gate opened — never the live
    // definition's message, which may have been edited since. A gate with no message, and one an
    // earlier version opened without keeping it, each say so.
    lines.push(openQuestionLine(run, gate, definition));
    if (gate.choices.length > 0) {
      lines.push(`  Choices: ${gate.choices.join(', ')}`);
    }
    // #627 W (§5.4b): the person's route — whenever the CLI door's narrowed list holds a callable
    // `respond` (W-s1 says `realm run inspect` shows the question, its gate id and its choices).
    const respond = cliRespondWay(run, definition);
    if (respond !== undefined) {
      lines.push(`  To answer: ${CLI_COMMANDS.respond(respond, undefined, { driveFlags: '' })}`);
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
      // G7: a damaged copy's finding carries its repair command, printed whole.
      const reason =
        f.kind === 'definition_unresolvable'
          ? withCommand(f.reason, definitionError?.repairCommand, writerCtx())
          : f.reason;
      lines.push(`  ${chalk.yellow(f.kind)}${stepLabel}: ${reason}${idleSuffix}`);
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
          ? `(showing run record only \u2014 ${withCommand(definitionError.message, definitionError.repairCommand, writerCtx())})`
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
      // issue #600 caching PR P: the step's money across its attempts, beside its name; a lower
      // bound when an attempt has no usage figures (the composer's own attempt facts, never a sum).
      const leavesOut =
        view?.attempts.some((a) => a.cost_unrecorded !== undefined || a.cost_unreadable === true) ??
        false;
      lines.push(
        `  ${idx + 1}. ${stepId}${profileLabel}${stepTotalText(view?.total, totalAttempts, leavesOut)}`,
      );
      executionSnaps.forEach((snap, ai) => {
        const statusColored = colorStatus(snap.status);
        // #729 PR-3 correction 4 (I-9, I-9b): a hash of the output is a value — shown as its type and
        // size where the output would be, and wherever the law hid anything inside the output.
        const hashShort = chalk.dim(
          `hash: ${digestSpan(snap.evidence_hash.slice(0, 8), snap.output_summary)}`,
        );
        lines.push(
          `     (attempt ${ai + 1}/${totalAttempts})  ${statusColored}   ${snap.duration_ms}ms   ${hashShort}`,
        );
        // Only the last attempt opened the step's question; an earlier attempt that failed opened
        // nothing and reads "Taken by".
        const programLine = attemptProgramLine(
          attempts[ai],
          isQuestionStepId(stepId) && ai === executionSnaps.length - 1,
          supplierClause(snap, definition),
        );
        if (programLine !== undefined) lines.push(`       ${programLine}`);
      });
      // Show Input/Output/Trace/Tool calls for the last attempt.
      lines.push(`     Input:  ${formatSummary(lastSnap.input_summary)}`);
      if (lastSnap.resolved_params !== undefined) {
        lines.push(`     Resolved: ${formatSummary(lastSnap.resolved_params)}`);
      }
      lines.push(`     Output: ${formatSummary(lastSnap.output_summary)}`);
      const lastSource = outputSourceLine(lastSnap, definition);
      if (lastSource !== undefined) lines.push(`     ${lastSource}`);
      // issue #760: a handler's warning, whole — a sentence the operator reads in full, never cut.
      if (lastSnap.warn !== undefined) lines.push(`     Warn: ${warnLine(lastSnap.warn)}`);
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
          const errSuffix = tc.error ? `  error: ${writerCtx().value(tc.error)}` : '';
          lines.push(`       [${tc.server_id}:${tc.tool}]  ${tc.duration_ms}ms${errSuffix}`);
          if (options?.verbose) {
            lines.push(`         args:   ${formatSummary(tc.args)}`);
            const resultStr = typeof tc.result === 'string' ? tc.result : '(null)';
            lines.push(`         result: ${writerCtx().value(resultStr)}`);
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
          // issue #600 PR 2 (D3): this attempt's own model and ask, through the shared composer.
          const facts = requestFactsText(attempt.cost);
          const cache =
            formatCache(attempt.cost) + (facts.ask !== undefined ? `; ${facts.ask}` : '');
          // issue #600 caching PR P: this attempt's own money, through the shared composer.
          const money = moneyText(attempt.cost) ?? '';
          const segs = [prompt, output, facts.model ?? '', cache, money].filter((s) => s !== '');
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
    } else {
      // The single-entry branch renders `snaps[0]`, whatever its kind. A gate entry there (a step
      // whose first entry is its answer) prints its heading line and, when it is an answer, the
      // step's output it recorded — its `{...preview, choice}` without the choice, which is on
      // the `Answer:` line below. (The mint writes the choice last, so the entry never held a
      // preview field named `choice` apart from the answer's.)
      const snap = snaps[0]!;
      const statusColored = colorStatus(snap.status);
      // #729 PR-3 correction 4 (I-9, I-9b): a hash of the output is a value — shown as its type and
      // size where the output would be, and wherever the law hid anything inside the output.
      const hashShort = chalk.dim(
        `hash: ${digestSpan(snap.evidence_hash.slice(0, 8), snap.output_summary)}`,
      );
      const kindLabel = snap.kind === 'gate_response' ? chalk.cyan(' gate_response') : '';
      const profileLabel =
        snap.agent_profile !== undefined ? chalk.cyan(` [profile: ${snap.agent_profile}]`) : '';
      lines.push(
        `  ${idx + 1}. ${stepId.padEnd(22)}${profileLabel}${kindLabel} ${statusColored}   ${snap.duration_ms}ms   ${hashShort}`,
      );
      if (snap.kind === 'gate_response') {
        if (isAnswerEntry(snap)) {
          const { choice: _choice, ...shown } = snap.output_summary;
          if (Object.keys(shown).length > 0) lines.push(`     Output: ${formatSummary(shown)}`);
        }
      } else {
        const programLine = attemptProgramLine(
          attempts[0],
          isQuestionStepId(stepId),
          supplierClause(snap, definition),
        );
        if (programLine !== undefined) lines.push(`     ${programLine}`);
        lines.push(`     Input:  ${formatSummary(snap.input_summary)}`);
        if (snap.resolved_params !== undefined) {
          lines.push(`     Resolved: ${formatSummary(snap.resolved_params)}`);
        }
        lines.push(`     Output: ${formatSummary(snap.output_summary)}`);
        const source = outputSourceLine(snap, definition);
        if (source !== undefined) lines.push(`     ${source}`);
        // issue #760: a handler's warning, whole — a sentence the operator reads in full, never cut.
        if (snap.warn !== undefined) lines.push(`     Warn: ${warnLine(snap.warn)}`);
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
            const errSuffix = tc.error ? `  error: ${writerCtx().value(tc.error)}` : '';
            lines.push(`       [${tc.server_id}:${tc.tool}]  ${tc.duration_ms}ms${errSuffix}`);
            if (options?.verbose) {
              lines.push(`         args:   ${formatSummary(tc.args)}`);
              const resultStr = typeof tc.result === 'string' ? tc.result : '(null)';
              lines.push(`         result: ${writerCtx().value(resultStr)}`);
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
    // issue #625 (holder slice): the step's answers, on every layout, in entry order — each as the
    // question its person read (`Message:`, when the gate had one) and then its `Answer:` line,
    // which carries the choice. Nothing else of a gate entry prints: its output is the step's own
    // output plus the choice (`{...preview, choice}`), and the step's output prints once, above.
    // A gate entry that is not an answer (an `on_expiry: abort` expiry) prints nothing: the run's
    // `Cause:` line and the step's `Skipped:` line say what it did. The view's `answers` and these
    // entries are chosen by the same rule (`isAnswerEntry`), in the same order, so they pair.
    const answerEntries = snaps.filter((s) => isAnswerEntry(s));
    (view?.answers ?? []).forEach((answer, i) => {
      const message = answerEntries[i]?.gate_message;
      // The question is printed quoted, on one line, every control character an escape
      // (`quotedForTerminal`, shared with `realm workflow run`'s question line).
      if (message !== undefined) {
        lines.push(`     Message:  ${questionSpan(quotedForTerminal(message))}`);
      }
      lines.push(
        `     ${renderAnswerLine(answer, answerArrivalOf(answerEntries[i]), writerCtx())}`,
      );
    });
  });

  return lines.join('\n');
}

/**
 * Issue #600 caching PR P — the prices `realm run inspect` shows money with, built from the run's
 * own deployment root WITHOUT the extensions loader (this file's read-only invariant): it reads
 * `<trust_root>/realm.yaml` through core's `parseDeploymentManifest`, and loads realm-mcp's
 * `loadPriceSource` with the economics file it names (no project code runs). A run whose workflow
 * copy is unreadable, or records no deployment root, prices nothing (`economics_unreachable`, with
 * that reason); no `realm.yaml` there, or one without the key, means the installed price list only;
 * a `realm.yaml` that cannot be read or is invalid prices nothing, naming the file.
 */
export async function inspectPriceSource(
  definition: WorkflowDefinition | undefined,
  manifest?: RunManifest,
): Promise<PriceSource> {
  const unreachable = (detail: string): PriceSource => {
    const result = { not_priced: 'economics_unreachable' as const, detail };
    return { price: () => result };
  };
  if (definition === undefined) return unreachable("the run's workflow copy could not be read");
  const root = definition.trust_root;
  if (root === undefined) return unreachable("the run's workflow copy records no deployment root");
  const { loadPriceSource } = await import('@sensigo/realm-mcp');
  // #729 PR-3 (L-4): the one read of the run's manifest, shared with the receipt's declared part.
  const read = manifest ?? (await readRunManifest(definition));
  if (read.document === undefined) {
    // No `realm.yaml` found (none at the root, or the recorded one is gone): the installed price
    // list only, as before; one that cannot be read or is invalid prices nothing, naming the file.
    return read.declaredCause === 'load_failed'
      ? unreachable(read.detail ?? 'the deployment manifest could not be read')
      : loadPriceSource({});
  }
  const named = read.document.runner?.cache?.economics;
  if (named === undefined) return loadPriceSource({});
  return loadPriceSource({ economicsPath: isAbsolute(named) ? named : join(root, named) });
}

/** What `realm run inspect` hid on its own surface (F13): the writer's counts while it printed, the
 *  run's declared standing, and whether it showed a question. */
export interface InspectSurfaceReceipt {
  declared: DisclosureReceipt['declared'];
  declared_cause?: DisclosureReceipt['declared_cause'];
  /** The operator's own terminal (the declared tier): environment values and the values after a
   *  credential's name are shown there. */
  terminal: boolean;
  hidden: { declared: number; environment: number; pattern: number };
  unchecked: number;
  unmaskable: number;
  /** The sources of what was hidden — on the terminal only. */
  members?: readonly string[];
  question: boolean;
  /** #729 PR-3 correction 3 (H-7''): while values are withheld, how many were shown as their shapes. */
  withheld?: number;
}

/**
 * #729 PR-3 (F13, F16): inspect's one `Disclosure:` line — what THIS surface hid while it printed
 * the run, never the record walk's totals. On the operator's terminal (the declared tier) it says
 * that environment values and the values after a credential's name are shown there, and names the
 * sources it hid; on a log, kinds and counts. A shown question is said to be masked at the declared
 * tier only.
 */
export function inspectReceiptLine(receipt: InspectSurfaceReceipt): string {
  const declared = declaredWords({
    declared: receipt.declared,
    ...(receipt.declared_cause !== undefined ? { declaredCause: receipt.declared_cause } : {}),
  });
  const question =
    // Correction 4 (I-6): under the flag, where it would have withheld, the words name the flag.
    (receipt.question ? `; ${questionReceiptWords()}` : '') +
    // I-7: nothing shaped is said as such, never a count of nothing.
    (receipt.withheld === undefined
      ? ''
      : receipt.withheld === 0
        ? '; values withheld (none to show)'
        : `; values withheld: ${receipt.withheld} shown as ${receipt.withheld === 1 ? 'its' : 'their'} type and size`);
  if (receipt.terminal) {
    const names =
      receipt.members !== undefined && receipt.members.length > 0
        ? `: ${receipt.members.join(', ')}`
        : '';
    return (
      `Disclosure: ${declared}; environment values and values after a credential's name are shown on this terminal; ` +
      `hidden ${receipt.hidden.declared} declared${names}; ` +
      `${receipt.unchecked} not checked; ${receipt.unmaskable} too short to hide${question}.`
    );
  }
  return (
    `Disclosure: ${declared}; environment swept; ` +
    `hidden ${receipt.hidden.declared} declared, ${receipt.hidden.environment} environment, ${receipt.hidden.pattern} by pattern; ` +
    `${receipt.unchecked} not checked; ${receipt.unmaskable} too short to hide${question}.`
  );
}

export const inspectCommand = new Command('inspect')
  .argument('<run-id>', 'ID of the run to inspect')
  .description('Display the full evidence chain and diagnostics for a run')
  .option('--verbose', 'Show full tool call args and results')
  .option(
    '--check-drift',
    'Recompute the last recorded extension identity against current disk state (pure hashing — never loads code)',
  )
  .option(
    '--accept-partial-disclosure',
    "Print the run's stored values even when Realm cannot read every declared secret of the run (masked with what is known)",
  )
  .action(
    async (
      runId: string,
      cmdOpts: { verbose?: boolean; checkDrift?: boolean; acceptPartialDisclosure?: boolean },
    ) => {
      const { JsonFileStore, JsonWorkflowStore } = await import('@sensigo/realm');
      const store = new JsonFileStore();
      const workflowStore = new JsonWorkflowStore();
      try {
        // #729 PR-3 (L-4): the run's declared values join the writer's set before anything prints,
        // and the receipt line says what the law hid in this record for stdout's audience.
        const run = await store.get(runId);
        const definition = await getWorkflowForRun(workflowStore, run, {
          retryVerb: 'inspect again',
          verb: 'inspect',
          terminalOk: true,
        }).catch(() => undefined);
        const manifest = await readRunManifest(definition, run);
        warnManifestNotSecretUnset(manifest.path, manifest.notSecret);
        addDeclaredValues(
          manifest.declared,
          manifest.document !== undefined ? (manifest.notSecret ?? []) : undefined,
        );
        // #729 PR-3 correction 3 (H-7''): the run's declared standing is the writer's; under a
        // failed or changed manifest its values are withheld unless the flag is given, and the
        // first line says why.
        noteDeclaredStanding(manifest.path ?? `run ${runId}`, {
          declared: manifest.declaredState,
          ...(manifest.declaredCause !== undefined
            ? { declaredCause: manifest.declaredCause }
            : {}),
        });
        withholdUnlessAccepted(cmdOpts.acceptPartialDisclosure === true);
        const withheld = valuesWithheldFor();
        if (withheld !== undefined) console.log(valuesWithheldLine(withheld));
        else {
          // Correction 4 (I-6): shown on the flag where they would have been withheld — said first.
          const shown = valuesShownFor();
          if (shown !== undefined) console.log(valuesShownLine(shown));
        }
        // F13: what this surface hid — its render's own passes (long values are passed and cut
        // there) and the print — never the record walk's totals.
        const before = writerTally();
        const output = await inspectRun(runId, store, workflowStore, {
          ...(cmdOpts.verbose === true ? { verbose: true } : {}),
          ...(cmdOpts.checkDrift === true ? { checkDrift: true } : {}),
          priceSourceFor: (def) => inspectPriceSource(def, manifest),
        });
        console.log(output);
        const audience = stdoutAudience();
        const after = writerTally();
        if (audience !== undefined && before !== undefined && after !== undefined) {
          const set = buildDisclosureSet({
            env: process.env,
            cwd: process.cwd(),
            declared: manifest.declared,
            declaredState: manifest.declaredState,
            ...(manifest.declaredCause !== undefined
              ? { declaredCause: manifest.declaredCause }
              : {}),
            audience,
            ...(manifest.notSecret !== undefined ? { notSecret: manifest.notSecret } : {}),
          }).set;
          const terminal = audience === 'private';
          console.log(
            inspectReceiptLine({
              declared: set.declared,
              ...(set.declaredCause !== undefined ? { declared_cause: set.declaredCause } : {}),
              terminal,
              hidden: {
                declared: after.declared - before.declared,
                environment: after.environment - before.environment,
                pattern: after.pattern - before.pattern,
              },
              unchecked: after.unchecked - before.unchecked,
              unmaskable: set.unmaskable,
              ...(terminal
                ? { members: [...after.members].filter((m) => !before.members.has(m)).sort() }
                : {}),
              question: after.question && !before.question,
              ...(withheld !== undefined ? { withheld: after.shaped - before.shaped } : {}),
            }),
          );
        }
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    },
  );
