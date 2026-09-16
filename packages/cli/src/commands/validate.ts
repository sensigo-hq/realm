// realm validate <path> — validates a workflow YAML file without registering it.
//
// ONE admission path (issue #553): `validate <file>` calls the same `loadWorkflowForAdmission`
// register and watch call — file loader (agent-profile resolution), the unconditional
// project-extensions pass (modules, manifest, config_schema two-pass), real-then-sentinel
// secret resolution — so what validate blesses register accepts, and what register refuses
// validate refuses, by construction. The pre-#553 "strictness asymmetry" (extension-free
// workflows parsed from string, skipping every file-context check) is gone; `--registered`
// runs the same rules on the stored copy and supplies-or-declares the context-dependent ones.
import { Command } from 'commander';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import {
  loadWorkflowFromStringWithDiagnostics,
  resolveAgentProfiles,
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
import type { WorkflowDefinition } from '@sensigo/realm';
import type { LoadedProjectExtensions } from '../extensions/load-project-extensions.js';
import {
  renderLoadFailure,
  renderEscalationLine,
  printLoaderWarnings,
  rejectOnErrorSeverity,
  failsStrict,
  wrapSentinelWarnings,
  extensionKeysOf,
  renderExtensionKeysClause,
} from '../lib/loader-warnings.js';
import {
  loadWorkflowForAdmission,
  admitProjectExtensions,
  ExtensionLoadError,
  admittedDefinitionOf,
} from '../lib/load-workflow-for-admission.js';
import {
  CONTEXT_DEPENDENT_CHECKS,
  notRunReason,
  renderChecksNotRunLine,
  type CheckNotRun,
} from '../lib/admission-context.js';

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
 *
 * `checksNotRun` (issue #553 correction C9, default 0 — the file-mode call site never passes it,
 * since every check runs there) adds the FIRST tail clause when non-zero: `N check(s) not run`.
 * There is no non-strict `— N warning(s)` tail today and this does not invent one — a
 * warnings-bearing run without `--strict` and without a not-run count still prints the bare line,
 * warnings above it. The failing-`--strict` clause, when both fire, comes SECOND, `; `-joined
 * with the not-run clause — `— N check(s) not run; M warning(s); failing due to --strict` — and
 * the description-suppression rule is UNCHANGED: only a failing `--strict` suppresses it, not a
 * bare not-run disclosure (a moved tree is not a reason to hide the workflow's own description).
 *
 * `extensionKeys` (issue #559, default `[]`) adds a SECOND tail clause, between the not-run
 * clause and the strict clause, naming every top-level `x-` key the definition carries — the
 * accepted-but-unread namespace mints no warning of its own, so this is the only disclosure an
 * author who believed `x-timeout` configured something gets.
 */
function printValidationOutcome(
  definition: WorkflowDefinition,
  warnings: LoaderWarning[],
  strict: boolean,
  checksNotRun = 0,
  extensionKeys: readonly string[] = [],
): boolean {
  printLoaderWarnings(warnings);
  const stepCount = Object.keys(definition.steps).length;
  const base = `Valid: ${definition.id} v${definition.version} (${stepCount} ${stepCount === 1 ? 'step' : 'steps'})`;
  const strictFailing = strict && failsStrict(warnings);
  const clauses: string[] = [];
  if (checksNotRun > 0) {
    clauses.push(`${checksNotRun} ${checksNotRun === 1 ? 'check' : 'checks'} not run`);
  }
  const extensionClause = renderExtensionKeysClause(extensionKeys);
  if (extensionClause !== undefined) {
    clauses.push(extensionClause);
  }
  if (strictFailing) {
    clauses.push(
      `${warnings.length} ${warnings.length === 1 ? 'warning' : 'warnings'}; failing due to --strict`,
    );
  }
  console.log(clauses.length > 0 ? `${base} — ${clauses.join('; ')}` : base);
  if (!strictFailing && definition.description !== undefined) {
    console.log(`  ${definition.description}`);
  }
  return strictFailing;
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
  /**
   * issue #553 — the context-dependent checks `--registered` could not run, `[{ id, reason }]`.
   * Emitted on EVERY arm and never absent (file mode: always `[]` — every check runs there), so
   * a consumer can tell "ran all" from "old CLI". Lists ONLY skips caused by a missing recorded
   * path (issue #553 correction C4) — a `valid: false` arm always emits `[]` here too, even
   * though the context-dependent checks were never reached: the refusal ends the audit outright
   * and is its own reason, not a "not run" one.
   */
  checksNotRun: readonly CheckNotRun[];
  /**
   * issue #559 — the author-extension (`x-`) keys the definition carries, in authored order.
   * Emitted on EVERY arm (the `checksNotRun` precedent): the accepted list on a success arm,
   * `[]` on every refusal or load-failure arm — the field reports what was ACCEPTED, so a
   * `valid: false` arm always shows `[]` even when the file carries such keys.
   */
  extensionKeys: readonly string[];
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
        checks_not_run: result.checksNotRun,
        extension_keys: result.extensionKeys,
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
  checksNotRun: readonly CheckNotRun[];
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
        checksNotRun: jsonCtx.checksNotRun,
        extensionKeys: [],
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
  // for that reason. On all three surfaces the warnings printed one line above still read
  // `— ignored` (issue #540 deleted the CLI's print-time rewrite to `— REFUSED below`) — this
  // line is where the refusal, and WHICH warning triggered it, actually gets said.
  console.error(renderEscalationLine(warnings));
  return true;
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
async function validateRegistered(
  id: string,
  strict: boolean,
  json: boolean,
  overrideModule?: string,
): Promise<void> {
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
          checksNotRun: [],
          extensionKeys: [],
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
          checksNotRun: [],
          extensionKeys: [],
        });
        process.exit(1);
      }
      console.log(`Auditing the registered copy of '${id}' with realm ${VERSION}'s loader.`);
      // The store's own message carries the remedy; the loader would say `Missing required
      // field: 'steps'` here, which is true of the shape and useless about the cause.
      console.error(renderLoadFailure(err));
      process.exit(1);
    }
    // issue #558 PR-T — the store now CLASSIFIES every read failure and mints the sentence
    // itself (`registrar.ts` `probeClassToError` / `parseFailureError`), so these arrive as
    // typed `WorkflowError`s and must be keyed on their CODE. Without these two arms they fall
    // past the `!(err instanceof WorkflowError)` guard below into the `:581` rethrow and crash
    // with a stack trace where main printed a clean line.
    if (
      err instanceof WorkflowError &&
      (err.code === 'RESOURCE_FORMAT_INVALID' || err.code === 'STATE_WORKFLOW_UNREADABLE')
    ) {
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
          checksNotRun: [],
          extensionKeys: [],
        });
        process.exit(1);
      }
      console.error(`Error: ${err.message}`);
      console.error('Registered workflows: realm workflow list');
      process.exit(1);
    }
    if (!(err instanceof WorkflowError)) {
      // A raw throw out of `get()` is a TOCTOU remnant only — `probe()` classifies every read
      // failure it can see, and both parse classes now arrive as `RESOURCE_FORMAT_INVALID`
      // above. Kept as armor; its own sentence is whatever the runtime said.
      const rawMsg = err instanceof Error ? err.message : String(err);
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
          errors: [rawMsg],
          checksNotRun: [],
          extensionKeys: [],
        });
        process.exit(1);
      }
      console.error(`Error: ${rawMsg}`);
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
      'Registered copies stay grandfathered at runtime against LOADER changes — this reports ' +
        'what re-registration today would say. A NEW engine-side dispatch check (issue #508, ' +
        'realm 0.42.0) is NOT grandfathered: it applies immediately, whatever schema_version ' +
        'is on file.',
    );
  }

  // issue #553 — read the recorded context BEFORE the strip: these are the paths the
  // context-dependent checks are supplied with (the file loader stamps both since v0.14;
  // older copies carry neither, and say so below).
  const recorded: Record<'source_dir' | 'trust_root', string | undefined> = {
    source_dir: typeof stored.source_dir === 'string' ? stored.source_dir : undefined,
    trust_root: typeof stored.trust_root === 'string' ? stored.trust_root : undefined,
  };
  const storedExtensions = stored.extensions;

  const clone = { ...stored } as Record<string, unknown>;
  for (const key of RUNTIME_ONLY_WORKFLOW_KEYS) delete clone[key];
  // MUST delete: the from-string loader hard-throws on an `extensions` key (allowExtensions:
  // false) with "Register this workflow from its YAML file" — maximally misleading here, where
  // the workflow IS registered and the operator asked about the stored copy. The declared
  // modules are re-attached to the parsed definition below, for the extensions pass that
  // actually consumes them.
  delete clone['extensions'];
  const stripped = JSON.stringify(clone);

  // Supply or declare (issue #553): per member of CONTEXT_DEPENDENT_CHECKS, either the recorded
  // path still exists and the check RUNS with it, or the check is declared not run — here, on
  // the human line, and in `checks_not_run` on every `--json` arm from this point.
  const notRun: CheckNotRun[] = [];
  const registeredCtx = (
    workflowId: string | null,
    diagnostics: readonly LoaderWarning[],
  ): ValidateJsonLoadFailureCtx => ({
    mode: 'registered',
    path: null,
    workflowId,
    schemaVersion: stored.schema_version ?? null,
    diagnostics,
    strictRequested: strict,
    checksNotRun: notRun,
  });

  let definition: WorkflowDefinition;
  let loaderWarnings: LoaderWarning[];
  try {
    // After #553 the four context-free rules (context_wrapper, the workflow_context names,
    // source.path) run here too — the string loader carries them. No `(line N)`: the body is
    // JSON, not the author's file.
    ({ definition, warnings: loaderWarnings } = loadWorkflowFromStringWithDiagnostics(stripped));
  } catch (err) {
    exitOnLoadFailure(err, json ? registeredCtx(id, warningsOf(err)) : undefined);
  }

  const applicable = CONTEXT_DEPENDENT_CHECKS.filter((check) => check.applies(definition));
  for (const check of applicable) {
    const path = recorded[check.needs];
    // `existsSync` is load-bearing for BOTH members: `resolveAgentProfiles` against a dead
    // tree would name a path under the missing tree (the WRONG error), and
    // `admitProjectExtensions` against a nonexistent trust root returns defaults SILENTLY
    // (executed) — a copy whose tree moved would audit as if it had no manifest at all.
    if (path === undefined || !existsSync(path)) {
      const reason = notRunReason(check.needs, path, stored.origin);
      // issue #553 correction C5 — the extensions member cannot apply an override it never
      // reaches: say so beside the reason, never silently, on the human line AND
      // `checks_not_run[].reason` alike, so 7c's label+reason parity holds by construction.
      notRun.push({
        id: check.id,
        reason:
          check.id === 'project_extensions' && overrideModule !== undefined
            ? `${reason}; --extensions-module not applied`
            : reason,
      });
    }
  }
  // The disclosure line — always on, never verbose-gated, the old honesty line's slot: after
  // the header, before any verdict. Derived from the constant; nothing hand-typed. A non-empty
  // set does NOT flip `--strict`: a disclosure, not a warning — a moved tree must not fail CI
  // for a reason the operator cannot act on.
  if (!json && notRun.length > 0) console.log(renderChecksNotRunLine(notRun));

  let sentinelWarnings: string[] | undefined;
  for (const check of applicable) {
    if (notRun.some((n) => n.id === check.id)) continue;
    if (check.id === 'agent_profile_resolution') {
      try {
        resolveAgentProfiles(definition, recorded.source_dir!);
      } catch (err) {
        exitOnLoadFailure(err, json ? registeredCtx(definition.id, loaderWarnings) : undefined);
      }
    } else {
      // The extensions pass exactly as loadWorkflowForAdmission runs it — ONE shared call
      // (issue #553 correction C2: `admitProjectExtensions` is now the single mint site for the
      // sentinel-credentials advisory pair, replacing this arm's own hand-typed copy) — against
      // the RECORDED paths, re-stamped on the parsed copy (the strip removed them).
      if (recorded.source_dir !== undefined) definition.source_dir = recorded.source_dir;
      definition.trust_root = recorded.trust_root!; // the member ran ⇒ recorded and present
      if (storedExtensions !== undefined) definition.extensions = storedExtensions;
      let loaded: LoadedProjectExtensions;
      try {
        loaded = await admitProjectExtensions(definition, {
          surface: 'validate',
          ...(overrideModule !== undefined ? { overrideModule } : {}),
        });
      } catch (err) {
        // issue #445's sentence, issue #454's whole-message convention, issue #463's
        // warnings-first — the file arm's shape, on the stored copy.
        const accumulated = [...loaderWarnings, ...findRetryWithoutExplicitTimeout(definition)];
        const msg = `Error loading extensions: ${err instanceof Error ? err.message : String(err)}`;
        if (json) {
          emitValidateJson({
            valid: false,
            mode: 'registered',
            path: null,
            workflowId: definition.id,
            schemaVersion: stored.schema_version ?? null,
            strictRequested: strict,
            strictFailed: false,
            diagnostics: accumulated,
            errors: [msg],
            checksNotRun: notRun,
            extensionKeys: [],
          });
          process.exit(1);
        }
        for (const w of accumulated) console.warn(renderLoaderWarning(w));
        console.error(msg);
        process.exit(1);
      }
      sentinelWarnings = loaded.sentinelWarnings;
      try {
        loadWorkflowFromStringWithDiagnostics(stripped, loaded.registry);
      } catch (err) {
        exitOnLoadFailure(err, json ? registeredCtx(definition.id, warningsOf(err)) : undefined);
      }
    }
  }

  // The file arm's tail, minus the adoption nudge (a stored copy is not where you edit;
  // `--explain` is therefore inert in this mode, deliberately — no machinery for it).
  const accumulated = [
    ...loaderWarnings,
    ...findRetryWithoutExplicitTimeout(definition),
    ...wrapSentinelWarnings(sentinelWarnings),
  ];
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
        checksNotRun: notRun,
        extensionKeys: [],
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
      checksNotRun: notRun,
      extensionKeys: extensionKeysOf(definition),
    });
    if (strictFailed) {
      process.exit(1);
    }
    return;
  }
  if (rejectIfPolicyEscalates(accumulated)) {
    process.exit(1);
  }
  const strictFailed = printValidationOutcome(
    definition,
    accumulated,
    strict,
    notRun.length,
    extensionKeysOf(definition),
  );
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
        await validateRegistered(opts.registered, strict, json, opts.extensionsModule);
        return;
      }

      const filePath =
        inputPath!.endsWith('.yaml') || inputPath!.endsWith('.yml')
          ? inputPath!
          : join(inputPath!, 'workflow.yaml');

      // ONE call (issue #553) — the path register and watch take, byte for byte: the file
      // loader (read failure → the loader's `Failed to read workflow file:` sentence; profile
      // resolution; the four context rules), the unconditional extensions pass with real-then-
      // sentinel secret resolution, the config_schema pass 2. Two failure populations leave it,
      // and each keeps its own sentence (issue #445): an ExtensionLoadError is extension or
      // deployment territory (an unresolvable module, a malformed `realm.yaml`, the #123
      // orphaned-manifest refusal) and says `Error loading extensions:`; everything else is the
      // workflow's own invalidity, rendered by exitOnLoadFailure (a non-WorkflowError rethrows
      // loud — the #123 doctrine).
      let definition: WorkflowDefinition;
      let warnings: LoaderWarning[];
      let manifest: LoadedProjectExtensions['manifest'];
      try {
        ({ definition, warnings, manifest } = await loadWorkflowForAdmission(filePath, {
          ...(opts.extensionsModule !== undefined ? { overrideModule: opts.extensionsModule } : {}),
          surface: 'validate',
        }));
      } catch (err) {
        if (err instanceof ExtensionLoadError) {
          // issue #463 — the workflow's own warnings first: pass-1's plus the retry advisory,
          // the same set the success path counts minus the sentinel wraps, which come from the
          // load that just failed — there is nothing to wrap. Plain render, not
          // printLoaderWarnings — the escalation gate never ran on this arm (#540/#542).
          //
          // issue #454 — the errors[] convention's exception: this sentence ships WHOLE, with
          // its `Error loading extensions: ` head — the #445 classification IS the composed
          // message, not a channel prefix a caller prepends at print. Under `--json` the
          // helper's two sentinel ⚠ lines may already have reached stderr (`console.warn`;
          // register has no `--json`): stdout purity holds — #454's contract is stdout — and
          // stderr may carry advisories on a contract arm (J7b pins it).
          const failed = err.definition;
          const accumulated = [
            ...(err.warnings ?? []),
            ...(failed !== undefined ? findRetryWithoutExplicitTimeout(failed) : []),
          ];
          const msg = `Error loading extensions: ${err.message}`;
          if (json) {
            emitValidateJson({
              valid: false,
              mode: 'file',
              path: inputPath!,
              workflowId: failed?.id ?? null,
              schemaVersion: null,
              strictRequested: strict,
              strictFailed: false,
              diagnostics: accumulated,
              errors: [msg],
              checksNotRun: [],
              extensionKeys: [],
            });
            process.exit(1);
          }
          for (const w of accumulated) console.warn(renderLoaderWarning(w));
          console.error(msg);
          process.exit(1);
        }
        // A pass-2 (config_schema) refusal carries the pass-1 definition beside it, so
        // `workflow_id` is named exactly as before the collapse (round-2 Q9); a pass-1 refusal
        // has no definition to name.
        exitOnLoadFailure(
          err,
          json
            ? {
                mode: 'file',
                path: inputPath!,
                workflowId: admittedDefinitionOf(err)?.id ?? null,
                schemaVersion: null,
                diagnostics: warningsOf(err),
                strictRequested: strict,
                checksNotRun: [],
              }
            : undefined,
        );
      }

      const accumulated = [...warnings, ...findRetryWithoutExplicitTimeout(definition)];
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
            checksNotRun: [],
            extensionKeys: [],
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
          checksNotRun: [],
          extensionKeys: extensionKeysOf(definition),
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
      const strictFailed = printValidationOutcome(
        definition,
        accumulated,
        strict,
        0,
        extensionKeysOf(definition),
      );
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
