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
  loadWorkflowFromString,
  loadWorkflowFromFile,
  findTrustRoot,
  WorkflowError,
  shouldEnforceTimeout,
  DEFAULT_EXECUTION_TIMEOUT_SECONDS,
} from '@sensigo/realm';
import type { WorkflowDefinition } from '@sensigo/realm';
import {
  loadProjectExtensions,
  checkForOrphanedManifests,
} from '../extensions/load-project-extensions.js';

/**
 * Advisory (issue A3, never rejects): an auto step declaring `retry:` but no `timeout_seconds`
 * has EVERY attempt bounded by the generous DEFAULT_EXECUTION_TIMEOUT_SECONDS default — a hung
 * attempt can take up to that long before the retry loop even considers the next one. Surfaces
 * one warning per such step so the author can opt into a tighter explicit timeout_seconds.
 */
function warnRetryWithoutExplicitTimeout(definition: WorkflowDefinition): void {
  for (const [stepName, step] of Object.entries(definition.steps)) {
    if (
      shouldEnforceTimeout(step) &&
      step.retry !== undefined &&
      step.timeout_seconds === undefined
    ) {
      console.warn(
        `⚠  Step '${stepName}': declares 'retry' but no 'timeout_seconds' — each attempt is ` +
          `bounded by the default execution timeout (${DEFAULT_EXECUTION_TIMEOUT_SECONDS}s). ` +
          `Consider an explicit 'timeout_seconds' if attempts should fail faster.`,
      );
    }
  }
}

/**
 * The single success site BOTH validation branches (extension-free and file-based) share: the
 * advisory warning is structurally inseparable from the `Valid:` line it accompanies — a branch
 * cannot drop the advisory without also dropping the `Valid:` print that existing tests assert.
 */
function printValidationSuccess(definition: WorkflowDefinition): void {
  warnRetryWithoutExplicitTimeout(definition);
  console.log(
    `Valid: ${definition.id} v${definition.version} (${Object.keys(definition.steps).length} steps)`,
  );
  if (definition.description !== undefined) {
    console.log(`  ${definition.description}`);
  }
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
  .description('Validate a workflow YAML file')
  .action(async (inputPath: string, opts: { extensionsModule?: string }) => {
    const filePath =
      inputPath.endsWith('.yaml') || inputPath.endsWith('.yml')
        ? inputPath
        : join(inputPath, 'workflow.yaml');

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
        const definition = loadWorkflowFromString(content);
        const workflowDir = dirname(resolve(filePath));
        checkForOrphanedManifests(workflowDir, findTrustRoot(workflowDir));
        printValidationSuccess(definition);
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
      const definition = loadWorkflowFromFile(filePath);
      const { registry, manifest, sentinelWarnings } = await loadProjectExtensions(definition, {
        ...(opts.extensionsModule !== undefined ? { overrideModule: opts.extensionsModule } : {}),
        secretMode: 'sentinel',
      });
      for (const warning of sentinelWarnings ?? []) console.warn(`⚠  ${warning}`);
      // Pass 2: step config validated against each resolved adapter's config_schema.
      loadWorkflowFromFile(filePath, registry);
      printValidationSuccess(definition);
      if (manifest.modules.length > 0) {
        console.log(
          `Extensions: ${manifest.modules.map((m) => m.declared).join(', ')} ` +
            `(adapters: ${manifest.adapters.length}, handlers: ${manifest.handlers.length}, ` +
            `processors: ${manifest.processors.length})`,
        );
      }
    } catch (err) {
      console.error(`Invalid: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });
