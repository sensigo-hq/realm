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
  renderLoaderWarning,
  assessStructuredOutputEligibility,
  renderIneligibleMessage,
  JsonWorkflowStore,
  RUNTIME_ONLY_WORKFLOW_KEYS,
  VERSION,
  type LoaderWarning,
} from '@sensigo/realm';
import type { WorkflowDefinition, ExtensionRegistry } from '@sensigo/realm';
import {
  loadProjectExtensions,
  checkForOrphanedManifests,
} from '../extensions/load-project-extensions.js';
import {
  renderLoadFailure,
  renderEscalationLine,
  printLoaderWarnings,
  rejectOnErrorSeverity,
  failsStrict,
  wrapSentinelWarnings,
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
/** @internal Exported for testing only. */
export function findRetryWithoutExplicitTimeout(definition: WorkflowDefinition): LoaderWarning[] {
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
          `Step '${stepName}': declares 'retry' but no 'timeout_seconds' — each attempt is ` +
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
    console.log(
      `${base} — ${warnings.length} ${warnings.length === 1 ? 'warning' : 'warnings'}; failing due to --strict`,
    );
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
 *
 * issue #454: this whole channel is suppressed under `--json` — a caller checking
 * `opts.json` never calls this at all; there is no machinery for it here.
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
 * issue #454 — the severity `--json` reports for every diagnostic. Every mint site in the tree
 * ALREADY resolves severity at construction (`severity: resolveSeverity(code)`,
 * diagnostics.ts:239 and its siblings, under DEFAULT_POLICY — never the `--strict` all-error
 * policy, which is a run mode reported separately in the `strict` block) — so minted ≡ effective
 * for every constructible diagnostic today, and this re-resolution is a GUARD against a future
 * mint or a policy change landing without updating this file, not a live divergence. No real
 * fixture can distinguish the two; only a hand-constructed lying warning can (validate-json.test.ts's
 * U1 cell).
 * @internal Exported for testing only.
 */
export function normalizeDiagnosticSeverity(w: LoaderWarning): LoaderWarning {
  return { ...w, severity: resolveSeverity(w.code) };
}

/** issue #454 — the shape `--json` builds for every contract arm, before it is stringified. */
interface ValidateJsonEmit {
  valid: boolean;
  mode: 'file' | 'registered';
  path: string | null;
  workflowId: string | null;
  schemaVersion: number | null;
  strictRequested: boolean;
  strictFailed: boolean;
  diagnostics: readonly LoaderWarning[];
  errors: readonly string[];
}

/**
 * The ONE `--json` emission point (issue #454): every contract arm builds a `ValidateJsonEmit`
 * and calls this, so the machine channel cannot drift arm-to-arm the way independently-written
 * `JSON.stringify` call sites could. One `console.log` carrying the whole object is itself the
 * purity guarantee this surface's cells assert on (nothing else may write to stdout on a
 * contract arm) — `JSON.stringify(obj, null, 2)`, the `workflow list --json` sibling's own idiom.
 */
function emitValidateJson(result: ValidateJsonEmit): void {
  console.log(
    JSON.stringify(
      {
        valid: result.valid,
        mode: result.mode,
        path: result.path,
        workflow_id: result.workflowId,
        loader_version: VERSION,
        schema_version: result.schemaVersion,
        error_count: result.errors.length,
        warning_count: result.diagnostics.length,
        strict: { requested: result.strictRequested, failed: result.strictFailed },
        diagnostics: result.diagnostics.map(normalizeDiagnosticSeverity),
        errors: result.errors,
      },
      null,
      2,
    ),
  );
}

/** issue #454 — the shared `err.warnings ?? []` shape four `--json` load-failure sites need
 *  (:527, :580, :621, :423 in the pre-#454 line numbering) — everywhere EXCEPT the orphan-guard
 *  site (:548), whose diagnostics are the human loop's own accumulated set, not `err.warnings`. */
function warningsOf(err: unknown): readonly LoaderWarning[] {
  return err instanceof WorkflowError ? (err.warnings ?? []) : [];
}

/**
 * issue #454 — per-site context for a load-failure emission, passed to `exitOnLoadFailure` only
 * when `--json` was requested; its absence is exactly how that function knows to keep printing
 * the human report instead. `strictRequested` always echoes the `--strict` flag as given — the
 * strict gate is never reached on any of these arms, so `strictFailed` is always `false` here.
 */
interface ValidateJsonLoadFailureCtx {
  mode: 'file' | 'registered';
  path: string | null;
  workflowId: string | null;
  schemaVersion: number | null;
  diagnostics: readonly LoaderWarning[];
  strictRequested: boolean;
}

/**
 * The ONE place a load failure is rendered on this command (issue #445).
 *
 * WorkflowError means the workflow is invalid: print the warnings it carried (#424), render the
 * message, exit 1. Anything else is an internal bug and is RETHROWN — the #123 doctrine, pinned
 * by validate-internal-error.test.ts's "genuine-bug-still-loud" cell: a real crash must never be
 * relabelled `Invalid:`, because that tells an author their file is wrong when realm is.
 *
 * The extensions arm used to render ANY error as `Invalid:`, so it violated that doctrine in two
 * directions at once — an internal bug was swallowed, and a user's broken extension module was
 * blamed on their workflow. Both arms route here now, and extension loading has its own catch
 * with its own sentence, so the two populations stay separate.
 *
 * SCOPE, deliberate: watch/register/test/agent keep their own catches (#425's recorded
 * exclusion). If a second surface ever adopts this, move it to lib/loader-warnings.ts — one
 * caller does not earn a shared home.
 *
 * issue #454 — `jsonCtx`, when present, means `--json` was requested: the `errors[]` convention
 * there is the RAW `err.errors ?? [err.message]` (channel prefixes like `Error: `/`Invalid: `
 * are print-time decoration this never applied in the first place — nothing to strip), never the
 * human-rendered `renderLoadFailure(err)` string.
 */
function exitOnLoadFailure(err: unknown, jsonCtx?: ValidateJsonLoadFailureCtx): never {
  if (err instanceof WorkflowError) {
    if (jsonCtx !== undefined) {
      emitValidateJson({
        valid: false,
        mode: jsonCtx.mode,
        path: jsonCtx.path,
        workflowId: jsonCtx.workflowId,
        schemaVersion: jsonCtx.schemaVersion,
        strictRequested: jsonCtx.strictRequested,
        strictFailed: false,
        diagnostics: jsonCtx.diagnostics,
        errors: err.errors ?? [err.message],
      });
      process.exit(1);
    }
    if (err.warnings !== undefined) printLoaderWarnings(err.warnings);
    console.error(renderLoadFailure(err));
    process.exit(1);
  }
  throw err;
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
  // register and watch print the same line since issue #451 (watch adds its timestamp and a
  // `— refusing to register.` tail, because it does not exit); it lives in lib/loader-warnings.ts
  // for that reason. On all three surfaces printLoaderWarnings' `— REFUSED below` substitution
  // already marks each refused warning one line above.
  console.error(renderEscalationLine(warnings));
  return true;
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

/**
 * `validate --registered <id>` — audit the STORED copy of a workflow (issue #427).
 *
 * The mechanism is kubectl's server-side dry-run shape: strip the keys the loader stamps, feed
 * the rest back through the REAL loader, report what it says. Zero rules are duplicated here, so
 * this surface cannot drift from what `register` would accept tomorrow.
 *
 * What it audits is the INSTALLED loader — the same limitation kubectl documents. The
 * pre-upgrade journey is therefore: upgrade the CLI first, THEN audit. That is safe precisely
 * because grandfathering holds for the copies it applies to: a CURRENT-SCHEMA registered copy
 * keeps running under the rules it was registered with, so upgrading the CLI to look does not
 * change what your runs do. A legacy (schema_version-less or older) copy is a different case
 * entirely — see the legacy arm below: it is not grandfathered, it is already unreachable.
 */
async function validateRegistered(id: string, strict: boolean, json: boolean): Promise<void> {
  const store = new JsonWorkflowStore();

  let stored: WorkflowDefinition;
  try {
    stored = await store.get(id);
  } catch (err) {
    if (err instanceof WorkflowError && err.code === 'STATE_WORKFLOW_NOT_FOUND') {
      if (json) {
        emitValidateJson({
          valid: false,
          mode: 'registered',
          path: null,
          workflowId: id,
          schemaVersion: null,
          strictRequested: strict,
          strictFailed: false,
          diagnostics: [],
          errors: [err.message],
        });
        process.exit(1);
      }
      console.error(`Error: ${err.message}`);
      console.error('Registered workflows: realm workflow list');
      process.exit(1);
    }
    if (err instanceof WorkflowError && err.code === 'STATE_LEGACY_FORMAT') {
      // ONE clause only. There is no schema_version to name — nothing parsed far enough to read
      // one — and the grandfathering sentence would be FALSE for this cohort: every runtime
      // consumer resolves through this same get() gate (start_run, execute_step, append_trace,
      // get_workflow_protocol, submit_human_response, replay), so a legacy entry cannot run at
      // all. It is not grandfathered; it is unreachable.
      if (json) {
        emitValidateJson({
          valid: false,
          mode: 'registered',
          path: null,
          workflowId: id,
          schemaVersion: null,
          strictRequested: strict,
          strictFailed: false,
          diagnostics: [],
          errors: [err.message],
        });
        process.exit(1);
      }
      console.log(`Auditing the registered copy of '${id}' with realm ${VERSION}'s loader.`);
      // The store's own message carries the remedy; the loader would say `Missing required
      // field: 'steps'` here, which is true of the shape and useless about the cause.
      console.error(renderLoadFailure(err));
      process.exit(1);
    }
    if (!(err instanceof WorkflowError)) {
      // get()'s try wraps ONLY the read — JSON.parse sits outside it, so a corrupt stored file
      // arrives here as a bare SyntaxError with no code (executed).
      const notParseableMsg = `the registered copy of '${id}' is not parseable JSON: ${
        err instanceof Error ? err.message : String(err)
      }`;
      if (json) {
        emitValidateJson({
          valid: false,
          mode: 'registered',
          path: null,
          workflowId: id,
          schemaVersion: null,
          strictRequested: strict,
          strictFailed: false,
          diagnostics: [],
          errors: [notParseableMsg],
        });
        process.exit(1);
      }
      console.error(`Error: ${notParseableMsg}`);
      console.error('Registered workflows: realm workflow list');
      process.exit(1);
    }
    throw err; // #123: an unexpected WorkflowError is a bug, and bugs stay loud.
  }

  if (!json) {
    console.log(
      `Auditing the registered copy of '${id}' (schema_version ${String(stored.schema_version)}) ` +
        `with realm ${VERSION}'s loader.`,
    );
    console.log(
      'Registered copies stay grandfathered at runtime — this reports what re-registration today would say.',
    );
  }

  const clone = { ...stored } as Record<string, unknown>;
  for (const key of RUNTIME_ONLY_WORKFLOW_KEYS) delete clone[key];

  const declaresProfile = Object.values(stored.steps ?? {}).some(
    (step) => (step as { agent_profile?: unknown }).agent_profile !== undefined,
  );
  if ((clone['extensions'] !== undefined || declaresProfile) && !json) {
    console.log(
      'Extensions/profiles declared — module resolution, config_schema checks, and agent-profile ' +
        'file resolution need the source tree and are not audited here; structural rules only.',
    );
  }
  // MUST delete: the from-string loader hard-throws on an `extensions` key (allowExtensions:
  // false) with "Register this workflow from its YAML file" — maximally misleading here, where
  // the workflow IS registered and the operator asked about the stored copy. The honesty line
  // above is what carries the real limitation.
  delete clone['extensions'];

  let definition: WorkflowDefinition;
  let loaderWarnings: LoaderWarning[];
  try {
    ({ definition, warnings: loaderWarnings } = loadWorkflowFromStringWithDiagnostics(
      JSON.stringify(clone),
    ));
  } catch (err) {
    exitOnLoadFailure(
      err,
      json
        ? {
            mode: 'registered',
            path: null,
            workflowId: id,
            schemaVersion: stored.schema_version ?? null,
            diagnostics: warningsOf(err),
            strictRequested: strict,
          }
        : undefined,
    );
  }

  // The extension-free arm's tail, minus the orphan-manifest check (there is no source tree to
  // have one) and minus the adoption nudge (a stored copy is not where you edit; `--explain` is
  // therefore inert in this mode, deliberately — no machinery for it).
  const accumulated = [...loaderWarnings, ...findRetryWithoutExplicitTimeout(definition)];
  if (json) {
    if (rejectOnErrorSeverity(accumulated)) {
      emitValidateJson({
        valid: false,
        mode: 'registered',
        path: null,
        workflowId: definition.id,
        schemaVersion: stored.schema_version ?? null,
        strictRequested: strict,
        strictFailed: false,
        diagnostics: accumulated,
        errors: [renderEscalationLine(accumulated)],
      });
      process.exit(1);
    }
    const strictFailed = strict && failsStrict(accumulated);
    emitValidateJson({
      valid: true,
      mode: 'registered',
      path: null,
      workflowId: definition.id,
      schemaVersion: stored.schema_version ?? null,
      strictRequested: strict,
      strictFailed,
      diagnostics: accumulated,
      errors: [],
    });
    if (strictFailed) {
      process.exit(1);
    }
    return;
  }
  if (rejectIfPolicyEscalates(accumulated)) {
    process.exit(1);
  }
  const strictFailed = printValidationOutcome(definition, accumulated, strict);
  if (strictFailed) {
    process.exit(1);
  }
}

export const validateCommand = new Command('validate')
  .argument('[path]', 'Path to workflow directory or workflow.yaml file')
  .option(
    '--registered <id>',
    'Audit the STORED copy of a registered workflow instead of a file (issue #427)',
  )
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
  .option('--json', 'Emit the result as JSON on stdout, and nothing else')
  .description('Validate a workflow YAML file')
  .action(
    async (
      inputPath: string | undefined,
      opts: {
        extensionsModule?: string;
        strict?: boolean;
        explain?: boolean;
        registered?: string;
        json?: boolean;
      },
    ) => {
      const strict = opts.strict === true;
      const explain = opts.explain === true;
      const json = opts.json === true;

      // Exactly-one, checked FIRST and load-bearing: commander parses a `[path]` positional and
      // a `--registered <id>` option happily together and enforces nothing between them
      // (executed — both arrive). The flag is `--registered <id>` rather than an auto-detecting
      // positional deliberately: nothing can reliably tell an id from a path, and guessing wrong
      // means auditing something the operator did not name.
      //
      // issue #454: NOT under the contract — these two usage errors precede validation entirely
      // (terraform-consistent) and stay human + exit 1 regardless of `--json`.
      if (inputPath === undefined && opts.registered === undefined) {
        console.error(
          'Error: provide a workflow path, or --registered <id> to audit a stored definition.',
        );
        process.exit(1);
        return;
      }
      if (inputPath !== undefined && opts.registered !== undefined) {
        console.error(
          'Error: --registered audits the stored copy — it cannot be combined with a path.',
        );
        process.exit(1);
        return;
      }

      if (opts.registered !== undefined) {
        await validateRegistered(opts.registered, strict, json);
        return;
      }

      const filePath =
        inputPath!.endsWith('.yaml') || inputPath!.endsWith('.yml')
          ? inputPath!
          : join(inputPath!, 'workflow.yaml');

      let content: string;
      try {
        content = readFileSync(filePath, 'utf8');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (json) {
          emitValidateJson({
            valid: false,
            mode: 'file',
            path: inputPath!,
            workflowId: null,
            schemaVersion: null,
            strictRequested: strict,
            strictFailed: false,
            diagnostics: [],
            errors: [message],
          });
          process.exit(1);
        }
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
        // WorkflowError, which exitOnLoadFailure renders as `Invalid:` + exit(1) — this arm's
        // guard call is DIRECT, which is why it keeps that sentence while an extensions-declaring
        // load surfaces the same guard as `Error loading extensions:` (issue #445). resolve()
        // before dirname so a relative `workflow.yaml` doesn't collapse the walk to '.'.
        let definition: WorkflowDefinition;
        let loaderWarnings: LoaderWarning[];
        try {
          ({ definition, warnings: loaderWarnings } =
            loadWorkflowFromStringWithDiagnostics(content));
        } catch (err) {
          exitOnLoadFailure(
            err,
            json
              ? {
                  mode: 'file',
                  path: inputPath!,
                  workflowId: null,
                  schemaVersion: null,
                  diagnostics: warningsOf(err),
                  strictRequested: strict,
                }
              : undefined,
          );
        }
        // Its own try (issue #463): each try owns one failure population — the #445 doctrine. A
        // load failure above has nothing to print but itself; the guard below fails AFTER the
        // workflow parsed, with its warnings in hand.
        try {
          const workflowDir = dirname(resolve(filePath));
          checkForOrphanedManifests(workflowDir, findTrustRoot(workflowDir));
        } catch (err) {
          // The workflow's own warnings before the refusal — the same set the success path counts,
          // so nothing the author would otherwise see only on the NEXT run is withheld. Plain
          // render: the escalation gate has not run, so printLoaderWarnings' `— REFUSED below`
          // would name the wrong cause (test.ts's render comment, #450's reasoning). Unconditional
          // in HUMAN mode: on the #123 non-WorkflowError rethrow population the warnings print
          // before the loud crash — true statements either way. exitOnLoadFailure cannot print
          // them twice: the orphan WorkflowError is minted bare in the CLI
          // (load-project-extensions.ts), and the core `warnings` slot is set only by
          // attachLoaderWarnings inside the core loader, which this throw never transits — which
          // is exactly why this arm swallowed them until now.
          //
          // issue #454 — THE ONE SPECIAL SITE: under --json this population never prints (stderr
          // stays silent on a contract arm); its diagnostics travel in the jsonCtx instead, as the
          // ACCUMULATED set (not `err.warnings`, which this orphan WorkflowError never carries —
          // it is minted bare, as the paragraph above explains).
          const accumulated = [...loaderWarnings, ...findRetryWithoutExplicitTimeout(definition)];
          if (!json) {
            for (const w of accumulated) {
              console.warn(renderLoaderWarning(w));
            }
          }
          exitOnLoadFailure(
            err,
            json
              ? {
                  mode: 'file',
                  path: inputPath!,
                  workflowId: definition.id,
                  schemaVersion: null,
                  diagnostics: accumulated,
                  strictRequested: strict,
                }
              : undefined,
          );
        }

        // Reporting, deliberately OUTSIDE the try (issue #445): these lines only run once the
        // load succeeded, and their own `process.exit` calls have no business passing through a
        // catch that exists to classify LOAD failures. Production-neutral — the exits still exit.
        const accumulated = [...loaderWarnings, ...findRetryWithoutExplicitTimeout(definition)];
        if (json) {
          if (rejectOnErrorSeverity(accumulated)) {
            emitValidateJson({
              valid: false,
              mode: 'file',
              path: inputPath!,
              workflowId: definition.id,
              schemaVersion: null,
              strictRequested: strict,
              strictFailed: false,
              diagnostics: accumulated,
              errors: [renderEscalationLine(accumulated)],
            });
            process.exit(1);
          }
          const strictFailed = strict && failsStrict(accumulated);
          emitValidateJson({
            valid: true,
            mode: 'file',
            path: inputPath!,
            workflowId: definition.id,
            schemaVersion: null,
            strictRequested: strict,
            strictFailed,
            diagnostics: accumulated,
            errors: [],
          });
          // issue #236: the nudge is suppressed entirely under --json (documented; --explain is
          // inert with it — there is no machinery for it here at all).
          if (strictFailed) {
            process.exit(1);
          }
          return;
        }
        if (rejectIfPolicyEscalates(accumulated)) {
          process.exit(1);
        }
        const strictFailed = printValidationOutcome(definition, accumulated, strict);
        // issue #236: the nudge's own INFO channel — never affects the exit code below.
        printStructuredOutputNudge(definition, { explain });
        if (strictFailed) {
          process.exit(1);
        }
        return;
      }

      // Extensions declared (or an override supplied): file-based two-pass validation.
      //
      // THREE tries, not one (issue #445). The old single catch spanned five concerns and
      // rendered every one of them `Invalid: …` — including a user's unresolvable extension
      // module, and including internal bugs. Each try now owns one failure population, and the
      // reporting tail sits outside all of them.
      let definition: WorkflowDefinition;
      let pass1Warnings: LoaderWarning[];
      try {
        // Pass 1: structural validation + extension resolution metadata (source_dir/trust_root).
        // The universal, registry-independent structural load — its warnings are what we count.
        ({ definition, warnings: pass1Warnings } = loadWorkflowFromFileWithDiagnostics(filePath));
      } catch (err) {
        exitOnLoadFailure(
          err,
          json
            ? {
                mode: 'file',
                path: inputPath!,
                workflowId: null,
                schemaVersion: null,
                diagnostics: warningsOf(err),
                strictRequested: strict,
              }
            : undefined,
        );
      }

      let registry: ExtensionRegistry;
      let manifest: Awaited<ReturnType<typeof loadProjectExtensions>>['manifest'];
      let sentinelWarnings: string[] | undefined;
      try {
        ({ registry, manifest, sentinelWarnings } = await loadProjectExtensions(definition, {
          ...(opts.extensionsModule !== undefined ? { overrideModule: opts.extensionsModule } : {}),
          secretMode: 'sentinel',
        }));
      } catch (err) {
        // issue #445 — a DIFFERENT population, and it gets its own sentence. Everything
        // loadProjectExtensions throws is extension or deployment territory: an unresolvable
        // module path, a failed import, a module whose default export is the wrong shape, a
        // malformed `realm.yaml`, and the #123 orphaned-manifest refusal. None of those makes
        // the WORKFLOW invalid, and calling them `Invalid:` sent an author to the wrong file.
        // The sentence is `realm run`'s, verbatim (run.ts) — the sibling surface renders this
        // identical failure class exactly so.
        //
        // issue #463 — the workflow's own warnings first: pass-1's plus the retry advisory, the
        // same set the success path counts minus the sentinel wraps, which come from the load that
        // just failed — there is nothing to wrap. Plain render (test.ts's render comment, #450's
        // reasoning): the escalation gate has not run, so printLoaderWarnings' `— REFUSED below`
        // would name the wrong cause.
        //
        // issue #454 — the errors[] convention's OTHER exception: this sentence ships WHOLE, with
        // its `Error loading extensions: ` head — the #445 classification IS the composed
        // message, not a channel prefix a caller prepends at print.
        const accumulated = [...pass1Warnings, ...findRetryWithoutExplicitTimeout(definition)];
        const msg = `Error loading extensions: ${err instanceof Error ? err.message : String(err)}`;
        if (json) {
          emitValidateJson({
            valid: false,
            mode: 'file',
            path: inputPath!,
            workflowId: definition.id,
            schemaVersion: null,
            strictRequested: strict,
            strictFailed: false,
            diagnostics: accumulated,
            errors: [msg],
          });
          process.exit(1);
        }
        for (const w of accumulated) {
          console.warn(renderLoaderWarning(w));
        }
        console.error(msg);
        process.exit(1);
      }

      try {
        // Pass 2: step config validated against each resolved adapter's config_schema. Same
        // content as pass 1, registry only adds config_schema checks — its warnings are proven
        // identical to pass 1's, so they are deliberately discarded here (not collected) to avoid
        // double-counting the same unknown key twice.
        loadWorkflowFromFileWithDiagnostics(filePath, registry);
      } catch (err) {
        exitOnLoadFailure(
          err,
          json
            ? {
                mode: 'file',
                path: inputPath!,
                workflowId: definition.id,
                schemaVersion: null,
                diagnostics: warningsOf(err),
                strictRequested: strict,
              }
            : undefined,
        );
      }

      const accumulated = [
        ...pass1Warnings,
        ...findRetryWithoutExplicitTimeout(definition),
        ...wrapSentinelWarnings(sentinelWarnings),
      ];
      if (json) {
        if (rejectOnErrorSeverity(accumulated)) {
          emitValidateJson({
            valid: false,
            mode: 'file',
            path: inputPath!,
            workflowId: definition.id,
            schemaVersion: null,
            strictRequested: strict,
            strictFailed: false,
            diagnostics: accumulated,
            errors: [renderEscalationLine(accumulated)],
          });
          process.exit(1);
        }
        const strictFailed = strict && failsStrict(accumulated);
        emitValidateJson({
          valid: true,
          mode: 'file',
          path: inputPath!,
          workflowId: definition.id,
          schemaVersion: null,
          strictRequested: strict,
          strictFailed,
          diagnostics: accumulated,
          errors: [],
        });
        // issue #422/#236: the Extensions manifest line and the nudge are both suppressed under
        // --json — human-informational, not represented (additive later if ever wanted).
        if (strictFailed) {
          process.exit(1);
        }
        return;
      }
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
    },
  );
