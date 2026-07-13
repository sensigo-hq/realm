// realm register <path> — validates and registers a workflow from a YAML file.
// Registering MINTS the trust decision for project extensions: when the workflow declares
// `extensions:`, the modules are fully loaded + duck-validated and step config is validated
// against the resolved adapters' config_schema (two-pass) BEFORE anything is persisted.
import { Command } from 'commander';
import { join } from 'node:path';
import { loadWorkflowFromFile, JsonWorkflowStore } from '@sensigo/realm';
import type { WorkflowDefinition } from '@sensigo/realm';
import {
  loadProjectExtensions,
  type LoadedProjectExtensions,
} from '../extensions/load-project-extensions.js';
import { ManifestSecretsError } from '../extensions/manifest-secrets.js';

/**
 * Loads and validates a workflow for registration. Extension-declaring workflows get the
 * full extension load + config_schema two-pass; extension-free workflows are untouched.
 * @throws on any validation or extension-load failure — nothing is persisted on throw.
 */
export async function loadWorkflowForRegistration(filePath: string): Promise<WorkflowDefinition> {
  const definition = loadWorkflowFromFile(filePath);
  // Full module load + duck validation + manifest construction + config_schema two-pass
  // BEFORE persisting. Secret sources may be unavailable at provisioning time: degrade to
  // SENTINEL construction with a loud WARN (never silent, never a registration blocker);
  // execution paths still require real resolution.
  let loaded: LoadedProjectExtensions;
  try {
    loaded = await loadProjectExtensions(definition);
  } catch (err) {
    if (!(err instanceof ManifestSecretsError)) throw err;
    console.warn(`⚠  ${err.message}`);
    console.warn(
      '⚠  Registering with SENTINEL credentials — execution paths still require real secret resolution.',
    );
    loaded = await loadProjectExtensions(definition, { secretMode: 'sentinel' });
  }
  for (const warning of loaded.sentinelWarnings ?? []) console.warn(`⚠  ${warning}`);
  // Two-pass: re-validate with the resolved registry so step config is checked against
  // each adapter's config_schema before the definition is persisted.
  loadWorkflowFromFile(filePath, loaded.registry);
  return definition;
}

export const registerCommand = new Command('register')
  .argument('<path>', 'Path to workflow directory or workflow.yaml file')
  .description('Register a workflow definition')
  .action(async (inputPath: string) => {
    const filePath =
      inputPath.endsWith('.yaml') || inputPath.endsWith('.yml')
        ? inputPath
        : join(inputPath, 'workflow.yaml');

    try {
      const definition = await loadWorkflowForRegistration(filePath);
      const store = new JsonWorkflowStore();
      await store.register(definition);
      const contextWarnings = lintWorkflowContext(definition);
      for (const warning of contextWarnings) {
        console.warn(`⚠  ${warning}`);
      }
      console.log(
        `Registered: ${definition.id} v${definition.version} (${Object.keys(definition.steps).length} steps)`,
      );
      if (definition.description !== undefined) {
        console.log(`  ${definition.description}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${message}`);
      process.exit(1);
    }
  });

/** @internal Exported for testing only. */
export function lintWorkflowContext(definition: WorkflowDefinition): string[] {
  const contextEntries = Object.keys(definition.workflow_context ?? {});
  if (contextEntries.length === 0) return [];

  // Only lint agent steps that have a prompt — auto steps have no agent-visible prompt.
  const agentStepsWithPrompt = Object.values(definition.steps).filter(
    (s) => s.execution === 'agent' && typeof s.prompt === 'string',
  );
  // Need at least 2 agent steps for a proportion warning to be meaningful.
  if (agentStepsWithPrompt.length < 2) return [];

  const threshold = Math.floor(agentStepsWithPrompt.length / 2);
  const warnings: string[] = [];

  for (const name of contextEntries) {
    const refPattern = `workflow.context.${name}`;
    const refCount = agentStepsWithPrompt.filter((s) =>
      (s.prompt as string).includes(refPattern),
    ).length;
    if (refCount > threshold) {
      warnings.push(
        `workflow.context.${name} is referenced in ${refCount} of ${agentStepsWithPrompt.length} ` +
          `agent step prompts. If this context applies universally, that is intentional — ` +
          `otherwise consider whether all steps truly need it.`,
      );
    }
  }
  return warnings;
}
