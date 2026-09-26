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
  UsageRecord,
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
 * Issue #600 PR 1a — the MEASURED prompt size, READ from `UsageRecord.prompt_tokens` — never
 * re-derived here (D6 rule 2). `prompt_tokens` is ENGINE semantics: each adapter has already
 * computed it using its own provider's arithmetic (Anthropic's disjoint three-term sum;
 * OpenAI's reported total, verbatim). A formula written at THIS render site would be correct
 * for at most one provider and silently wrong for the other — D2 exists precisely so this
 * function contains no arithmetic at all.
 *
 * Rendering a provider's raw remainder term alone (Anthropic's `input_tokens`) is correct only
 * while nothing places a breakpoint, and it SHRINKS as caching starts working — on a fully warm
 * call it would report a prompt of 0 next to a cache read of 1150. `prompt_tokens` is the number
 * that stays put whether the cache hit or missed (a warm and a cold call of the SAME prompt both
 * report 1200 — proven live on the branch, and pinned in `inspect-cache-render.test.ts`).
 *
 * FIRST REQUEST only, never summed across requests: later requests in one step re-send the same
 * prefix, so a cross-request sum overstates the prompt several-fold and answers no question
 * anyone asks. `undefined` when the first request reported none — realm then says nothing.
 */
function firstReported(
  cache: NonNullable<StepDiagnostics['cache']>,
  pick: (r: (typeof cache.requests)[number]) => number | undefined,
): { value: number; index: number; of: number } | undefined {
  const of = cache.requests.length;
  for (let i = 0; i < of; i += 1) {
    const v = pick(cache.requests[i]!);
    // `typeof === 'number'`, for the same reason as `reportedFigure` and the classifier: a `null`
    // counter is an absence the vendor's own type allows, and `null !== undefined` is TRUE — the
    // looser test here printed `null prompt tokens (measured, first request)`, a nonsense figure
    // under a label that claims it was measured. Third site of one predicate; the finding named two.
    if (typeof v === 'number') return { value: v, index: i, of };
  }
  return undefined;
}

/**
 * The scope phrase for a per-request figure. `requests[0]` alone was the defect a fresh operator
 * walk found: a provider that reports usage on its second turn and not its first left the line with
 * NO prompt figure at all, while the cache clauses on the same line proved two of three requests had
 * reported — so the only prompt number on screen was the character estimate, two orders of magnitude
 * out. A prompt is not additive across requests (each request has its own), so the honest figure is
 * one request's, and the label must say WHICH.
 */
function whichRequest(f: { index: number; of: number }): string {
  return f.index === 0 ? 'first request' : `request ${String(f.index + 1)} of ${String(f.of)}`;
}

/**
 * Issue #600 PR 1a — the one rule for what a summed figure over per-request counters may claim, used
 * by BOTH surfaces that print one (a step's cache line and a failed drive's usage line). Only the
 * records that REPORTED the counter are counted: an unreported counter is not a zero contribution,
 * and a sum over a subset is a floor, not a total. Returning the facts rather than a sentence is
 * deliberate — the two surfaces word them differently (`read 150+ (2 of 3 …)` vs `150+ output tokens
 * (2 of 3 …)`), and the defect this guards against is the rule being implemented twice and the
 * copies disagreeing.
 *
 * `undefined` means no record reported it — the caller says "not reported", never `0`. An empty
 * `records` array yields `undefined` too, which reads the same way; both callers guard `length === 0`
 * before this point, so that case never reaches a rendered line.
 */
function reportedFigure<T>(
  records: readonly T[],
  picks: Array<(r: T) => number | undefined>,
): { total: number; reported: number; of: number } | undefined {
  // Several picks are ALTERNATIVE SPELLINGS of one quantity across providers, never components of
  // it: the first present wins and they are never summed together.
  const value = (r: T): number | undefined => {
    for (const pick of picks) {
      const v = pick(r);
      // `typeof === 'number'`, never `!== undefined`: `null` is one of the two absence spellings a
      // provider's own type allows, and `null !== undefined` is TRUE — so the looser test counts a
      // null as REPORTED and the sum below then renders it as a `0`, which is exactly the coercion
      // this function exists to prevent. There is deliberately no `?? 0` below either: every value
      // that reaches the sum is a number, so no default can be mistaken for doctrine.
      if (typeof v === 'number') return v;
    }
    return undefined;
  };
  const values: number[] = [];
  for (const r of records) {
    const v = value(r);
    if (typeof v === 'number') values.push(v);
  }
  if (values.length === 0) return undefined;
  return {
    total: values.reduce((acc, v) => acc + v, 0),
    reported: values.length,
    of: records.length,
  };
}

/**
 * Issue #600 PR 1a — the provenance word, READ from the field rather than hardcoded beside it. A word
 * this build does not know is NAMED as unrecognised rather than printed as though it were a fact:
 * this slot is where an operator looks to learn whether a number was measured, and a record written
 * by a newer build or a third-party store can carry a word that means nothing here. `realm run
 * inspect` already does exactly this two lines up the same screen for an unknown seal arm.
 */
function basisWord(basis: NonNullable<StepDiagnostics['cache']>['basis']): string {
  if (basis === 'provider_reported') return 'provider-reported';
  // ABSENT is not UNKNOWN, and the quoted form asserts the record literally holds that token:
  // `unrecognized basis 'undefined'` sent a fresh operator hunting a stringify-undefined bug in the
  // writer. The field is required by the type, so absence means a foreign or hand-edited record —
  // a fact worth stating plainly, not a corrupt value worth quoting.
  if (basis === undefined || basis === null) return 'basis not recorded';
  if ((CACHE_BASES as readonly string[]).includes(basis)) return String(basis);
  return `unrecognized basis '${String(basis)}'`;
}

/**
 * Issue #600 PR 1a — the cache segment. One branch per state, and NO segment at all when `cache` is
 * absent, because absent means no model call happened: a different fact from "a call happened and the
 * provider reported nothing". An absent number is never printed as `0`; an OBSERVED zero is, because
 * an observed zero is a real fact.
 *
 * Every branch names its provenance, and the word comes from `basis` so a future member cannot be
 * misreported as the provider's. Multi-request totals SAY they are totals: the counters are summed
 * across the step's requests while the prompt size beside them is the first request's, and two numbers
 * of different scope on one line must each declare which.
 *
 * This segment states facts and never interprets them. It carries no excuse for a step that wrote and
 * did not read: whether that is a first call or wasted money depends on what the rest of the RUN did,
 * which this function cannot see — a step's own request count says nothing about prefixes the run
 * already paid for. Judging it is PR 2's finding, on the run's evidence.
 */
function formatCache(cache: NonNullable<StepDiagnostics['cache']>): string {
  const n = cache.requests.length;
  const scope = n === 1 ? '1 request' : `totals across ${n} requests`;
  // ONE sentence for "the provider told us nothing about caching", reached two ways: the classifier
  // said so, or every direction's clause below turned out to be `not reported` (a record realm did
  // not mint — a state word with no counters behind it). Printing `(0 requests)` for a call that
  // demonstrably happened would fabricate the very kind of number this field exists to stop
  // fabricating, so the scope is omitted when there is no per-request detail at all.
  const nothingReported = (): string =>
    n === 0
      ? `cache: not reported by the provider`
      : `cache: not reported by the provider (${scope})`;
  // Deliberately NOT keyed on `cache.state === 'unobservable'` any more. That early return let the
  // state word outrank the data: a record carrying a read of 77 and a write of 88 printed "not
  // reported by the provider", so an operator concluded the provider gives no cache visibility from
  // a record holding the two numbers they had just been told did not exist. The clauses below decide
  // instead, and they reach this same sentence whenever NEITHER direction was reported — every case
  // the state word used to catch, and none of the cases where it was wrong.
  // Each DIRECTION is rendered from its own reports, never from the object's, under the shared rule
  // above: a direction no request reported prints `not reported` rather than a 0 — a `0` on this
  // line always means a provider said zero — and a direction only SOME requests reported prints its
  // sum as a lower bound with the count. This is why `basis` (one word for the whole object) cannot
  // vouch for a number nobody reported: an unreported direction has no number here.
  // `at least N`, never `N+`: a partial sum of zero printed as `wrote 0+` is read as "we wrote
  // nothing" — the eye lands on the 0 and the `+` is a non-statement ("at least zero"). One form for
  // every value, so there is no special case and no value at which the marker can be missed. The
  // ratio names its OWN direction because it is counted per direction: two requests each reporting
  // one direction print `1 of 2` twice, which reads as "only one call came back with cache data".
  const clause = (
    label: string,
    noun: string,
    picks: Array<(r: (typeof cache.requests)[number]) => number | undefined>,
  ): string => {
    const f = reportedFigure(cache.requests, picks);
    if (f === undefined) return `${label} not reported`;
    return f.reported === f.of
      ? `${label} ${f.total}`
      : `${label} at least ${f.total} (${f.reported} of ${f.of} requests reported a ${noun})`;
  };
  const read = clause('read', 'read', [(r) => r.cache_read_input_tokens]);
  const wrote = clause('wrote', 'write', [
    (r) => r.cache_creation_input_tokens,
    (r) => r.cache_write_tokens,
  ]);
  if (read.endsWith('not reported') && wrote.endsWith('not reported')) {
    // NEITHER direction was reported, so there is no number for `basis` to vouch for — and stamping
    // `provider-reported` on a line that says "not reported" twice reads as "the provider reported:
    // not reported". That is the same fact as `unobservable`, whatever state word the record carries,
    // so it gets the same sentence rather than a second spelling of it.
    return nothingReported();
  }
  const prov = basisWord(cache.basis);
  if (!(CACHE_STATES as readonly string[]).includes(cache.state)) {
    // A state word this build does not know: say so, and still print the counters, which are facts
    // whatever the classifier called them. Rendering it as an ordinary state is how a typo'd
    // `not_engaged` became indistinguishable from `engaged` in a walk.
    return `cache: unrecognized state '${String(cache.state)}' — ${read}, ${wrote} (${prov}, ${scope})`;
  }
  if (cache.state === 'never_engaged') {
    // Both directions were reported and both were zero. The state word summarises; the clauses still
    // print BOTH numbers, because one `0` standing for two reported counters has an ambiguous
    // referent — and because this way every observable state renders through one composition.
    return `cache: not engaged — ${read}, ${wrote} (${prov}, ${scope})`;
  }
  return `cache: ${read}, ${wrote} (${prov}, ${scope})`;
}

/**
 * Issue #600 PR 1a (D9) — what a failed drive already cost, on the one surface an operator reads
 * first for a stuck or errored run. `get_run_state` already passes `drive_failures` (and its
 * `usage`) verbatim to an agent; a number that reaches only the machine surface and renders
 * nowhere for the operator does not discharge the disclosure this field exists for.
 *
 * `undefined` means no usage was accumulated before the throw — on the accumulating paths (the
 * single-shot and structured-output calls) that means no wire request was ever made, e.g. a
 * pre-dispatch `sdk_missing`. It does NOT mean that on the tool-calling path, which accumulates
 * nothing at all yet, so a tools step's `usage` is absent whatever it billed.
 *
 * An array — even an empty one — means a driveCall payload carried a `usage` key. `[]` says one
 * thing only: the key was present and carried no requests. It does NOT say a request was billed —
 * asserting that printed a billing claim directly beneath an `sdk_missing` line stating no request
 * ever left the process.
 *
 * Prompt size is SUMMED over the requests that reported one, like the output tokens beside it: this
 * line's own words are "billed before the throw", and a retry re-sends the prompt and is charged for
 * it again, so the sum is what was spent. (The step's own diagnostics line answers a different
 * question — how big is this prompt — and takes ONE request's figure, labelled with which.) Output
 * tokens are summed across every request, since each one is a genuinely distinct answer the drive paid for.
 */
function formatDriveFailureUsage(usage: UsageRecord[] | undefined): string | undefined {
  if (usage === undefined) return undefined;
  if (usage.length === 0) {
    // An empty array says one thing only: the field was present and carried no requests. It does NOT
    // say a request was billed — the previous wording claimed exactly that, and printed it directly
    // beneath an `sdk_missing` line stating that no request ever left the process.
    return '  usage: no per-request usage was recorded';
  }
  const n = usage.length;
  const scope = n === 1 ? '1 request' : `${String(n)} requests`;
  // The same shared rule the cache line uses, so the two surfaces cannot drift: output tokens are
  // summed only over the requests that REPORTED them, and a subset sum says so.
  const out = reportedFigure(usage, [(r) => r.output_tokens]);
  const outputStr =
    out === undefined
      ? 'output not reported'
      : out.reported === out.of
        ? `${String(out.total)} output tokens`
        : `at least ${String(out.total)} output tokens (${String(out.reported)} of ${String(out.of)} requests reported output)`;
  // The prompt is SUMMED here, unlike the step's diagnostics line, because this line answers a
  // different question: its own words are "billed before the throw", and a retry re-sends the prompt
  // and is charged for it again. Sampling `usage[0]` understated every multi-request failure and, when
  // request 0 happened to be the silent one, printed `prompt not reported` with 1300 in the record.
  const promptFig = reportedFigure(usage, [(r) => r.prompt_tokens]);
  const promptStr =
    promptFig === undefined
      ? 'prompt not reported'
      : promptFig.reported === promptFig.of
        ? promptFig.of === 1
          ? `${String(promptFig.total)} prompt tokens`
          : `${String(promptFig.total)} prompt tokens (totals across ${String(promptFig.of)} requests)`
        : `at least ${String(promptFig.total)} prompt tokens (${String(promptFig.reported)} of ${String(promptFig.of)} requests reported a prompt)`;
  return `  usage: ${scope} billed before the throw — ${promptStr}, ${outputStr}`;
}

/** Formats a diagnostics object into a readable string for the inspect output. */
function formatDiagnostics(diag: StepDiagnostics): string {
  // issue #600 PR 1a: the estimate is LABELLED, because a measured prompt count may now sit one pipe
  // away and the two are different quantities — `~N` is chars/4 of the step's resolved input, the
  // measured one is the whole prompt the provider billed (system + profile + schema + message). On a
  // real run they differ by ~100x, which is not an estimation error: they do not measure the same thing.
  // `(estimate)` alone never said WHAT it estimates. Beside a measured prompt an operator reads the
  // two numbers as two takes on one quantity and concludes the estimator is ~100x out; they measure
  // different things — this one is the step's own input, the other is the whole prompt the provider
  // received (system block, schema, history and all).
  const tokens = `~${diag.input_token_estimate} tokens (estimate, step input)`;
  // One reporting request: that request's figure, labelled with WHICH. Several: the TOTAL, labelled
  // with how many of how many — because showing the first reporting one hid a larger sibling and
  // understated what the step billed (777 on screen while the record held 777 AND 888, and the
  // failed-drive line sums the identical data shape). A prompt is not additive as a SIZE, which is
  // why the label says what it summed instead of naming one request.
  const promptFigure = (
    pick: (r: UsageRecord) => number | undefined,
  ): { text: string; total: number } | undefined => {
    if (diag.cache === undefined) return undefined;
    const one = firstReported(diag.cache, pick);
    if (one === undefined) return undefined;
    const all = reportedFigure(diag.cache.requests, [pick]);
    if (all === undefined || all.reported === 1) {
      return { text: whichRequest(one), total: one.value };
    }
    return {
      text: `totals across ${String(all.reported)} of ${String(all.of)} requests`,
      total: all.total,
    };
  };
  const measured = promptFigure((r) => r.prompt_tokens);
  const uncached = promptFigure((r) => r.uncached_input_tokens);
  const prompt =
    measured !== undefined
      ? ` | ${measured.total} prompt tokens (measured, ${measured.text})`
      : uncached !== undefined
        ? ` | ${uncached.total} uncached input tokens (measured, ${uncached.text}; whole prompt not reported)`
        : diag.cache !== undefined && diag.cache.requests.length > 0
          ? ' | prompt not reported'
          : '';
  const cache = diag.cache !== undefined ? ` | ${formatCache(diag.cache)}` : '';
  if (diag.precondition_trace.length === 0) {
    return `${tokens}${prompt} | no preconditions${cache}`;
  }
  const traceStr = diag.precondition_trace
    .map(
      (t) => `${t.expression} \u2192 ${t.passed ? 'true' : 'false'} (${String(t.resolved_value)})`,
    )
    .join(', ');
  return `${tokens}${prompt} | preconditions: ${traceStr}${cache}`;
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
  const driveFailures = run.drive_failures;
  const lastFailure = driveFailures?.entries[driveFailures.entries.length - 1];
  if (driveFailures !== undefined && lastFailure !== undefined) {
    lines.push('');
    lines.push('Drive failures:');
    // Each discriminator renders only when present: an operator debugging a 429 storm needs the
    // status and the Retry-After; padding every line with absent fields buries the ones that matter.
    const status =
      lastFailure.last_observed_status !== undefined
        ? ` (status ${String(lastFailure.last_observed_status)})`
        : '';
    const retryAfter =
      lastFailure.retry_after_observed_ms !== undefined
        ? ` (Retry-After ${String(lastFailure.retry_after_observed_ms)}ms observed)`
        : '';
    // Each clock renders INDEPENDENTLY. Pairing them behind one guard meant a ceiling-only entry
    // printed `declared 0ms` — a fabricated number an operator would read as "the timeout was set
    // to zero", which is a different bug report than the one they actually have.
    const declared =
      lastFailure.declared_per_attempt_ms !== undefined
        ? ` (declared ${String(lastFailure.declared_per_attempt_ms)}ms)`
        : '';
    const ceiling =
      lastFailure.derived_ceiling_ms !== undefined
        ? ` (ceiling ${String(lastFailure.derived_ceiling_ms)}ms)`
        : '';
    const attempts =
      lastFailure.attempts_sdk !== undefined
        ? ` (attempt ${String(lastFailure.attempts_sdk)})`
        : '';
    lines.push(
      `  ${lastFailure.at}  ${lastFailure.step}  ${lastFailure.provider}  ` +
        `${lastFailure.error_class} after ${String(lastFailure.elapsed_ms)}ms: ` +
        // Collapsed at RENDER only. `sanitizeError` preserves newlines and provider errors carry
        // them routinely; rendered raw, one entry sprawls over four lines and the block stops
        // being scannable. The RECORD keeps the raw sanitized message — it is evidence, and it
        // must not go lossy because one surface wants a single line.
        `${lastFailure.message.replace(/\s+/g, ' ')}` +
        `${status}${retryAfter}${declared}${ceiling}${attempts}`,
    );
    // Only when the ring has ROLLED — otherwise this line would restate a count the entries
    // themselves already show.
    if (driveFailures.total > driveFailures.entries.length) {
      lines.push(`  ${String(driveFailures.total)} total since ${driveFailures.first_failed_at}`);
    }
    // issue #600 PR 1a (D9): what the LAST failed attempt already cost, so a stuck run's screen
    // discloses spent money, not only the error.
    const usageLine = formatDriveFailureUsage(lastFailure.usage);
    if (usageLine !== undefined) {
      lines.push(usageLine);
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
