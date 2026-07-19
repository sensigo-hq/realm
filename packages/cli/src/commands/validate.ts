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
  type LoaderWarning,
} from '@sensigo/realm';
import type { WorkflowDefinition } from '@sensigo/realm';
import {
  loadProjectExtensions,
  checkForOrphanedManifests,
} from '../extensions/load-project-extensions.js';
import { printLoaderWarnings, rejectOnErrorSeverity, failsStrict } from '../lib/loader-warnings.js';

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
  const base = `Valid: ${definition.id} v${definition.version} (${Object.keys(definition.steps).length} steps)`;
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

/**
 * The dormant issue #170 boundary-reject: inert today (DEFAULT_POLICY has no 'error' entries),
 * but once #170 flips UNKNOWN_WORKFLOW_KEY/UNKNOWN_STEP_KEY, this refuses those workflows here.
 */
function rejectIfPolicyEscalates(warnings: LoaderWarning[]): boolean {
  if (!rejectOnErrorSeverity(warnings)) return false;
  printLoaderWarnings(warnings);
  console.error(
    `Invalid: ${warnings.length} warning(s) present, and at least one is escalated to an error by policy.`,
  );
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
  .description('Validate a workflow YAML file')
  .action(async (inputPath: string, opts: { extensionsModule?: string; strict?: boolean }) => {
    const filePath =
      inputPath.endsWith('.yaml') || inputPath.endsWith('.yml')
        ? inputPath
        : join(inputPath, 'workflow.yaml');
    const strict = opts.strict === true;

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
        if (printValidationOutcome(definition, accumulated, strict)) {
          process.exit(1);
        }
      } catch (err) {
        if (err instanceof WorkflowError) {
          console.error(`Invalid: ${err.message}`);
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
      const { definition, warnings: pass1Warnings } = loadWorkflowFromFileWithDiagnostics(filePath);
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
      if (strictFailed) {
        process.exit(1);
      }
    } catch (err) {
      console.error(`Invalid: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });
