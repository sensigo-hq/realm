// realm validate <path> — validates a workflow YAML file without registering it.
//
// Strictness asymmetry (documented): extension-free workflows validate through the EXACT
// from-string path used before project extensions existed (byte-identical behavior).
// Workflows declaring `extensions:` (or validated with --extensions-module) go through
// file-based loading so extension modules can be resolved, then a SECOND pass validates
// step `config` against each resolved adapter's `config_schema` (two-pass).
import { Command } from 'commander';
import { dirname, join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import {
  loadWorkflowFromStringWithDiagnostics,
  loadWorkflowFromFileWithDiagnostics,
  findTrustRoot,
  WorkflowError,
  shouldEnforceTimeout,
  DEFAULT_EXECUTION_TIMEOUT_SECONDS,
  resolveSeverity,
  assessStructuredOutputEligibility,
  renderIneligibleMessage,
  type LoaderWarning,
} from '@sensigo/realm';
import type { WorkflowDefinition } from '@sensigo/realm';
import {
  loadProjectExtensions,
  checkForOrphanedManifests,
} from '../extensions/load-project-extensions.js';
import {
  renderLoadFailure,
  printLoaderWarnings,
  rejectOnErrorSeverity,
  failsStrict,
} from '../lib/loader-warnings.js';

/**
 * Advisory (issue A3, never rejects): an auto step declaring `retry:` but no `timeout_seconds`
 * has EVERY attempt bounded by the generous DEFAULT_EXECUTION_TIMEOUT_SECONDS default — a hung
 * attempt can take up to that long before the retry loop even considers the next one. Returns one
 * RETRY_NO_TIMEOUT LoaderWarning per such step (issue #169: folded into the validate accumulator
 * — printed via printLoaderWarnings alongside every other warning — instead of printed directly,
 * so `--strict` and the dormant boundary-reject can see it too).
 *
 * Issue #140 text update: the per-attempt bound this warns about is now ALSO the basis of the
 * step's default total-time cap (`retry.total_timeout_seconds`, when not overridden) — so the
 * "each attempt" wording alone would understate the exposure on a multi-attempt retry (the
 * default cap compounds it: `max_attempts × the default timeout` before the step's own cap even
 * fires). The message is worded to cover both axes without requiring the reader to already know
 * about the cap.
 */
function findRetryWithoutExplicitTimeout(definition: WorkflowDefinition): LoaderWarning[] {
  const warnings: LoaderWarning[] = [];
  for (const [stepName, step] of Object.entries(definition.steps)) {
    if (
      shouldEnforceTimeout(step) &&
      step.retry !== undefined &&
      step.timeout_seconds === undefined
    ) {
      warnings.push({
        code: 'RETRY_NO_TIMEOUT',
        severity: resolveSeverity('RETRY_NO_TIMEOUT'),
        scope: 'step',
        step: stepName,
        message:
          `⚠  Step '${stepName}': declares 'retry' but no 'timeout_seconds' — each attempt is ` +
          `bounded by the default execution timeout (${DEFAULT_EXECUTION_TIMEOUT_SECONDS}s), and ` +
          `(absent an explicit 'retry.total_timeout_seconds') the step's overall retry budget ` +
          `defaults to that same per-attempt bound compounded across every attempt plus backoffs. ` +
          `Consider an explicit 'timeout_seconds' if attempts should fail faster, or an explicit ` +
          `'retry.total_timeout_seconds' to bound the overall budget independently.`,
      });
    }
  }
  return warnings;
}

/** Wraps loadProjectExtensions' sentinel-credential warnings as LoaderWarning (issue #169). */
function wrapSentinelWarnings(sentinelWarnings: string[] | undefined): LoaderWarning[] {
  return (sentinelWarnings ?? []).map((message) => ({
    code: 'EXTENSION_SENTINEL' as const,
    severity: resolveSeverity('EXTENSION_SENTINEL'),
    scope: 'workflow' as const,
    message: `⚠  ${message}`,
  }));
}

/**
 * The single success-path printer BOTH validation branches (extension-free and file-based)
 * share: prints every accumulated warning, then the summary line. Under `--strict`, a non-empty
 * accumulator turns the summary line into a failing one and returns true (the caller exits 1);
 * otherwise the summary line — and, when present, the description line existing tests assert on
 * — print exactly as before and this returns false.
 */
function printValidationOutcome(
  definition: WorkflowDefinition,
  warnings: LoaderWarning[],
  strict: boolean,
): boolean {
  printLoaderWarnings(warnings);
  const stepCount = Object.keys(definition.steps).length;
  const base = `Valid: ${definition.id} v${definition.version} (${stepCount} ${stepCount === 1 ? 'step' : 'steps'})`;
  if (strict && failsStrict(warnings)) {
    console.log(`${base} — ${warnings.length} warning(s); failing due to --strict`);
    return true;
  }
  console.log(base);
  if (definition.description !== undefined) {
    console.log(`  ${definition.description}`);
  }
  return false;
}

/** issue #236: the reasoning-position heuristic (design record §7, ratified via fixture C6) —
 *  top-level property NAME match only, never a value/content inspection. */
const REASONING_LIKE_PROPERTY = /reason|rational|think|explan|analysis/i;

function findReasoningLikeTopLevelProperty(schema: unknown): string | undefined {
  if (typeof schema !== 'object' || schema === null) return undefined;
  const properties = (schema as Record<string, unknown>)['properties'];
  if (typeof properties !== 'object' || properties === null) return undefined;
  return Object.keys(properties as Record<string, unknown>).find((name) =>
    REASONING_LIKE_PROPERTY.test(name),
  );
}

/**
 * issue #236 (Deliverable 7) — the adoption nudge, on validate's own INFO channel. Structurally
 * NOT a LoaderWarning (plain `console.log`, never routed through `printLoaderWarnings`/the
 * warnings accumulator/`--strict` — that stays a hard zero-diff rail on `loader-warnings.ts`,
 * since ANY new WarningCode there would auto-fail `validate --strict`).
 *
 * issue #422 reshaped the FORM, not the purpose. It used to print one line per caveat per step,
 * which on a green validate of a file that never mentions structured_output meant fourteen lines
 * (examples/06) or nine (examples/02) of advice nobody asked for. The field's converged answer for
 * adoption discovery on a clean run is one aggregate line plus a named detail command plus a
 * durable silencer — npm fund, cargo's future-incompat report, npm audit; no surveyed tool prints
 * per-item adoption advice on a green run, and npm's RFC 0017 explicitly rejected demoting the
 * class behind a flag instead. So: a summary by default, the full per-step detail behind
 * `--explain`, and `REALM_NO_NUDGE=1` to silence.
 *
 * THE POLICY THAT DECIDES WHICH STEPS ARE LOUD (rustc's attach-to-the-diagnostic rule, made
 * written policy here): advice about config the author DECLARED is a diagnostic and always prints;
 * advice about config they COULD adopt is one line. So an opted-in step's caveats print
 * unconditionally — `--explain` does not gate them and `REALM_NO_NUDGE` does not silence them —
 * while a not-opted-in step's detail is exactly what moves behind the flag.
 *
 * Never printed for an ineligible-and-opted-in step: the LOADER already rejected that combination
 * at load time, so this function structurally never observes it.
 */
function printStructuredOutputNudge(
  definition: WorkflowDefinition,
  opts: { explain: boolean },
): void {
  // Not-opted-in steps whose detail either renders (--explain) or feeds the summary counts.
  const ready: string[] = []; // eligible | eligible_with_caveats
  const withCaveats: string[] = []; // the subset of `ready` carrying >=1 caveat
  const oneAway: string[] = []; // ineligible

  for (const [stepName, step] of Object.entries(definition.steps)) {
    if (step.execution !== 'agent') continue;
    const effectiveSchema = step.output_schema ?? step.input_schema;
    if (effectiveSchema === undefined) continue; // nothing to nudge without a schema at all

    const optedIn = step.structured_output === 'strict';
    const verdict = assessStructuredOutputEligibility({
      ...(step.output_schema !== undefined ? { output_schema: step.output_schema } : {}),
      ...(step.input_schema !== undefined ? { input_schema: step.input_schema } : {}),
      ...(step.tools !== undefined ? { tools: step.tools } : {}),
    });
    const reasoningProp = findReasoningLikeTopLevelProperty(effectiveSchema);

    // An opted-in step's advice is about DECLARED config: a diagnostic, printed here and now
    // whatever the flags say. It is also EXCLUDED from the summary's census entirely — its
    // surface is this branch, never the aggregate line.
    if (optedIn) {
      if (verdict.verdict !== 'eligible_with_caveats') continue;
      for (const caveat of verdict.caveats) {
        console.log(`ℹ Step '${stepName}': structured_output caveat — ${caveat.remediation}`);
      }
      printReasoningAnnotation(stepName, reasoningProp);
      continue;
    }

    if (verdict.verdict === 'ineligible') {
      oneAway.push(stepName);
      if (opts.explain) {
        console.log(
          `ℹ Step '${stepName}': structured_output: strict — one line short: ` +
            `${renderIneligibleMessage(verdict.reasons)}`,
        );
      }
      continue;
    }

    ready.push(stepName);
    if (verdict.verdict === 'eligible_with_caveats') {
      // `eligible_with_caveats` with zero caveats is unconstructible — the assessor mints that
      // verdict only when it has at least one — so the verdict IS the caveated subset.
      withCaveats.push(stepName);
      if (opts.explain) {
        for (const caveat of verdict.caveats) {
          console.log(
            `ℹ Step '${stepName}': eligible for structured_output: strict, with caveat — ` +
              `${caveat.remediation}`,
          );
        }
        printReasoningAnnotation(stepName, reasoningProp);
      }
      continue;
    }

    // eligible, zero caveats — NEVER printed bare (census: this is a rare, fully-required
    // schema). Always paired with the concrete next step.
    if (opts.explain) {
      console.log(
        `ℹ Step '${stepName}': eligible for structured_output: strict — add ` +
          `'structured_output: strict' to opt in.`,
      );
    }
  }

  // `--explain` REPLACES the summary with the detail above — an explicit ask for detail should
  // not also get the pointer telling you how to ask for it.
  if (opts.explain) return;
  // Read at call time, never captured at module scope (the #285 class). An explicit `--explain`
  // beats a standing preference, which is why this check sits below the return above.
  if (process.env['REALM_NO_NUDGE'] === '1') return;

  const line = renderNudgeSummary(ready.length, withCaveats.length, oneAway.length);
  if (line !== undefined) console.log(line);
}

/** The reasoning-position annotation, printed beside a caveat list wherever one renders. */
function printReasoningAnnotation(stepName: string, reasoningProp: string | undefined): void {
  if (reasoningProp === undefined) return;
  console.log(
    `ℹ Step '${stepName}': the optional '${reasoningProp}' property looks like a ` +
      `reasoning field — see the optional_emission caveat above (position matters: with ` +
      `default thinking there is no regression; on non-thinking configurations prefer ` +
      `'required' + first property order — see docs/reference/yaml-schema.md).`,
  );
}

/**
 * The one graded summary line (issue #422), or `undefined` when there is nothing to say.
 *
 * The tail teaches BOTH escape routes in the one line it gets — the detail command (npm's
 * "Run `npm fund` for details", cargo's named report command) fused with the silencer (git's
 * squelch-teaching advice hints). A reader who wants more and a reader who wants less are both
 * served without a second line.
 *
 * Each clause pluralizes on its OWN count, and a zero-valued clause is omitted rather than
 * rendered as a zero. The caveats parenthetical and the one-change-away clause are independent:
 * gating the second on the first would silently drop it for a file whose ready steps are all
 * caveat-free.
 */
function renderNudgeSummary(
  ready: number,
  withCaveats: number,
  oneAway: number,
): string | undefined {
  if (ready === 0 && oneAway === 0) return undefined;
  const steps = (n: number): string => (n === 1 ? 'step' : 'steps');
  const tail = ` — run 'realm workflow validate --explain' for detail (REALM_NO_NUDGE=1 to silence).`;

  if (ready === 0) {
    return `ℹ ${oneAway} ${steps(oneAway)} one change away from structured_output: strict${tail}`;
  }

  let line = `ℹ ${ready} ${steps(ready)} ready for structured_output: strict`;
  if (withCaveats > 0) line += ` (${withCaveats} with caveats)`;
  if (oneAway > 0) line += `, ${oneAway} ${steps(oneAway)} one change away`;
  return line + tail;
}

/**
 * The issue #170 boundary-reject, LIVE since the flip: a workflow carrying an unrecognised
 * workflow-level or step-level key is refused here, before `--strict` is even consulted (which is
 * why `--strict` and the default now agree on this class). run/agent/listen are unaffected — they
 * load leniently, so a deployed workflow with an unknown key keeps running.
 */
function rejectIfPolicyEscalates(warnings: LoaderWarning[]): boolean {
  if (!rejectOnErrorSeverity(warnings)) return false;
  printLoaderWarnings(warnings);
  // issue #425: name WHICH warnings escalated. "at least one is escalated" left an author with
  // three warnings above and no way to tell which of them was the refusal — the counts are the
  // aggregate this line adds, so it is the line that has to say.
  //
  // register.ts and watch.ts carry sibling escalation lines and are deliberately NOT changed:
  // neither aggregates counts, and on all three surfaces printLoaderWarnings' `— REFUSED below`
  // substitution already marks each refused warning one line above.
  console.error(renderEscalationLine(warnings));
  return true;
}

/**
 * The escalation line (issue #425). Extracted so the keyless branch below is reachable from a
 * test: every WarningCode that escalates under the default policy happens to carry a key today,
 * so no real fixture can drive it — and a clause nothing can exercise rots into a wrong guess
 * about what a future keyless code would print.
 *
 * @internal Exported for testing only.
 */
export function renderEscalationLine(warnings: readonly LoaderWarning[]): string {
  // Same default policy `rejectOnErrorSeverity` just gated on, so the list can never disagree
  // with the refusal it explains.
  const escalated = warnings.filter((w) => resolveSeverity(w.code) === 'error');
  const list = escalated
    .map((w) => (w.key === undefined ? w.code : `${w.code} '${w.key}'`))
    .join(', ');
  return (
    `Invalid: ${warnings.length} ${warnings.length === 1 ? 'warning' : 'warnings'}, ` +
    `${escalated.length} escalated to an error by policy: ${list}`
  );
}

/** Pre-scan: does the YAML carry a top-level `extensions` key? (Parse errors → false; the
 *  real loader below reports them with its existing error surface.) */
function hasTopLevelExtensions(content: string): boolean {
  try {
    const raw = load(content);
    return (
      typeof raw === 'object' &&
      raw !== null &&
      !Array.isArray(raw) &&
      'extensions' in (raw as Record<string, unknown>)
    );
  } catch {
    return false;
  }
}

export const validateCommand = new Command('validate')
  .argument('<path>', 'Path to workflow directory or workflow.yaml file')
  .option(
    '--extensions-module <path>',
    "Extensions module that REPLACES the workflow's declared 'extensions' modules (repair/override)",
  )
  .option(
    '--strict',
    'Exit non-zero if any loader warning is present (unknown keys, retry-without-timeout, sentinel credentials — issue #169)',
  )
  .option(
    '--explain',
    'Print the full per-step structured_output adoption detail instead of the one-line summary the default run prints (issue #422)',
  )
  .description('Validate a workflow YAML file')
  .action(
    async (
      inputPath: string,
      opts: { extensionsModule?: string; strict?: boolean; explain?: boolean },
    ) => {
      const filePath =
        inputPath.endsWith('.yaml') || inputPath.endsWith('.yml')
          ? inputPath
          : join(inputPath, 'workflow.yaml');
      const strict = opts.strict === true;
      const explain = opts.explain === true;

      let content: string;
      try {
        content = readFileSync(filePath, 'utf8');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Error: ${message}`);
        process.exit(1);
        return;
      }

      if (!hasTopLevelExtensions(content) && opts.extensionsModule === undefined) {
        // Extension-free: the exact current from-string path — byte-identical behavior,
        // plus the orphaned-manifest guard (#123). The from-string loader stamps no
        // source_dir/trust_root, so resolve the same trust root the file-based path would
        // (findTrustRoot walks package.json/.git from the workflow dir) and run the guard
        // structural-first — after the workflow parses, before the `Valid:` print. It throws
        // WorkflowError, which the catch below renders as `Invalid:` + exit(1). resolve()
        // before dirname so a relative `workflow.yaml` doesn't collapse the walk to '.'.
        try {
          const { definition, warnings: loaderWarnings } =
            loadWorkflowFromStringWithDiagnostics(content);
          const workflowDir = dirname(resolve(filePath));
          checkForOrphanedManifests(workflowDir, findTrustRoot(workflowDir));

          const accumulated = [...loaderWarnings, ...findRetryWithoutExplicitTimeout(definition)];
          if (rejectIfPolicyEscalates(accumulated)) {
            process.exit(1);
          }
          const strictFailed = printValidationOutcome(definition, accumulated, strict);
          // issue #236: the nudge's own INFO channel — never affects the exit code below.
          printStructuredOutputNudge(definition, { explain });
          if (strictFailed) {
            process.exit(1);
          }
        } catch (err) {
          if (err instanceof WorkflowError) {
            // issue #424: a hard load error carries the warnings that were live when it was
            // thrown, so one run reports the whole defect set instead of revealing the next
            // layer after each fix. Printed BEFORE the error, matching both existing paths
            // (printValidationOutcome and the policy escalation). These never reach the
            // --strict accumulator — the run is already failing — so exit codes are unchanged.
            if (err.warnings !== undefined) printLoaderWarnings(err.warnings);
            console.error(renderLoadFailure(err));
            process.exit(1);
          }
          throw err;
        }
        return;
      }

      // Extensions declared (or an override supplied): file-based two-pass validation.
      try {
        // Pass 1: structural validation + extension resolution metadata (source_dir/trust_root).
        // The universal, registry-independent structural load — its warnings are what we count.
        const { definition, warnings: pass1Warnings } =
          loadWorkflowFromFileWithDiagnostics(filePath);
        const { registry, manifest, sentinelWarnings } = await loadProjectExtensions(definition, {
          ...(opts.extensionsModule !== undefined ? { overrideModule: opts.extensionsModule } : {}),
          secretMode: 'sentinel',
        });
        // Pass 2: step config validated against each resolved adapter's config_schema. Same
        // content as pass 1, registry only adds config_schema checks — its warnings are proven
        // identical to pass 1's, so they are deliberately discarded here (not collected) to avoid
        // double-counting the same unknown key twice.
        loadWorkflowFromFileWithDiagnostics(filePath, registry);

        const accumulated = [
          ...pass1Warnings,
          ...findRetryWithoutExplicitTimeout(definition),
          ...wrapSentinelWarnings(sentinelWarnings),
        ];
        if (rejectIfPolicyEscalates(accumulated)) {
          process.exit(1);
        }
        const strictFailed = printValidationOutcome(definition, accumulated, strict);
        if (manifest.modules.length > 0) {
          console.log(
            `Extensions: ${manifest.modules.map((m) => m.declared).join(', ')} ` +
              `(adapters: ${manifest.adapters.length}, handlers: ${manifest.handlers.length}, ` +
              `processors: ${manifest.processors.length})`,
          );
        }
        // issue #236: the nudge's own INFO channel — never affects the exit code below.
        // issue #422: genuinely end-of-report, BELOW the Extensions block — the summary is a
        // pointer at what you could do next, not part of what was just validated.
        printStructuredOutputNudge(definition, { explain });
        if (strictFailed) {
          process.exit(1);
        }
      } catch (err) {
        // issue #424, the extensions-path twin of the catch above. The non-WorkflowError arm is
        // untouched: this branch renders any Error by design, and only the warnings render is new.
        if (err instanceof WorkflowError && err.warnings !== undefined) {
          printLoaderWarnings(err.warnings);
        }
        console.error(
          renderLoadFailure(
            err instanceof WorkflowError ? err : err instanceof Error ? err.message : String(err),
          ),
        );
        process.exit(1);
      }
    },
  );
