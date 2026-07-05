// realm validate <path> — validates a workflow YAML file without registering it.
//
// Strictness asymmetry (documented): extension-free workflows validate through the EXACT
// from-string path used before project extensions existed (byte-identical behavior).
// Workflows declaring `extensions:` (or validated with --extensions-module) go through
// file-based loading so extension modules can be resolved, then a SECOND pass validates
// step `config` against each resolved adapter's `config_schema` (two-pass).
import { Command } from 'commander';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { loadWorkflowFromString, loadWorkflowFromFile, WorkflowError } from '@sensigo/realm';
import { loadProjectExtensions } from '../extensions/load-project-extensions.js';

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
      // Extension-free: the exact current from-string path — byte-identical behavior.
      try {
        const definition = loadWorkflowFromString(content);
        console.log(
          `Valid: ${definition.id} v${definition.version} (${Object.keys(definition.steps).length} steps)`,
        );
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
      console.log(
        `Valid: ${definition.id} v${definition.version} (${Object.keys(definition.steps).length} steps)`,
      );
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
