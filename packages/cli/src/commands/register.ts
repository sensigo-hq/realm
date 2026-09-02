// realm register <path> — validates and registers a workflow from a YAML file.
// Registering MINTS the trust decision for project extensions: when the workflow declares
// `extensions:`, the modules are fully loaded + duck-validated and step config is validated
// against the resolved adapters' config_schema (two-pass) BEFORE anything is persisted.
import { Command } from 'commander';
import { join } from 'node:path';
import {
  loadWorkflowFromFileWithDiagnostics,
  JsonWorkflowStore,
  WorkflowError,
} from '@sensigo/realm';
import type { WorkflowDefinition, LoaderWarning } from '@sensigo/realm';
import {
  loadProjectExtensions,
  type LoadedProjectExtensions,
} from '../extensions/load-project-extensions.js';
import { ManifestSecretsError } from '../extensions/manifest-secrets.js';
import {
  printLoaderWarnings,
  rejectOnErrorSeverity,
  failsStrict,
  renderLoadFailure,
  renderEscalationLine,
  wrapSentinelWarnings,
} from '../lib/loader-warnings.js';

/**
 * Tags a failure thrown by the extensions load inside `loadWorkflowForRegistration` so the
 * callers' catches can say `Error loading extensions:` — the sentence run and validate already
 * print for this class (issue #451) — without guessing from the message. The message is the
 * original's, byte for byte (register-extensions.test.ts's broken-module cell matches on it
 * THROUGH this wrapper), and the original rides along as `cause`.
 *
 * Minted at exactly the two throw paths out of the extensions block: the real-mode load's
 * non-secrets failure, and the sentinel retry. The retry can never throw ManifestSecretsError
 * itself (sentinel mode resolves every name without reading a source), so nothing is wrapped
 * twice. A WorkflowError from the two-pass re-validation is thrown OUTSIDE the block and keeps
 * the family split.
 *
 * @internal Exported for watch.ts and for tests.
 */
export class ExtensionLoadError extends Error {
  constructor(original: unknown) {
    super(original instanceof Error ? original.message : String(original), { cause: original });
    this.name = 'ExtensionLoadError';
  }
}

/**
 * Loads and validates a workflow for registration. Extension-declaring workflows get the
 * full extension load + config_schema two-pass; extension-free workflows are untouched.
 * Returns the definition alongside every accumulated LoaderWarning (issue #169) — pass-1's
 * structural warnings plus the sentinel-credential warnings, if any. Prints NOTHING itself;
 * both callers (register's action, watch's registerFile) decide how to surface/act on warnings
 * (register supports `--strict` + the dormant #170 reject; watch just prints and continues).
 * @throws on any validation or extension-load failure — nothing is persisted on throw.
 *         Extension-load failures are tagged `ExtensionLoadError` (issue #451).
 */
export async function loadWorkflowForRegistration(
  filePath: string,
): Promise<{ definition: WorkflowDefinition; warnings: LoaderWarning[] }> {
  const { definition, warnings: pass1Warnings } = loadWorkflowFromFileWithDiagnostics(filePath);
  // Full module load + duck validation + manifest construction + config_schema two-pass
  // BEFORE persisting. Secret sources may be unavailable at provisioning time: degrade to
  // SENTINEL construction with a loud WARN (never silent, never a registration blocker);
  // execution paths still require real resolution.
  let loaded: LoadedProjectExtensions;
  try {
    loaded = await loadProjectExtensions(definition);
  } catch (err) {
    // The guard is the degradation itself: only a secrets failure degrades, everything else is an
    // extension-load failure and leaves tagged (issue #451). Dropping the conditional kills
    // degradation — register-extensions.test.ts's sentinel control is the cell in this command's
    // own home that sees it (the manifest E2E in extensions/ does too, one substring deep).
    if (!(err instanceof ManifestSecretsError)) throw new ExtensionLoadError(err);
    console.warn(`⚠ ${err.message}`);
    console.warn(
      '⚠ Registering with SENTINEL credentials — execution paths still require real secret resolution.',
    );
    try {
      loaded = await loadProjectExtensions(definition, { secretMode: 'sentinel' });
    } catch (err) {
      throw new ExtensionLoadError(err);
    }
  }
  // Two-pass: re-validate with the resolved registry so step config is checked against
  // each adapter's config_schema before the definition is persisted. Its warnings are proven
  // identical to pass-1's (same content, registry only adds config_schema checks) — discarded
  // here to avoid double-counting the same unknown key twice.
  loadWorkflowFromFileWithDiagnostics(filePath, loaded.registry);

  return {
    definition,
    warnings: [...pass1Warnings, ...wrapSentinelWarnings(loaded.sentinelWarnings)],
  };
}

export const registerCommand = new Command('register')
  .argument('<path>', 'Path to workflow directory or workflow.yaml file')
  .option(
    '--strict',
    'Exit non-zero and refuse to register if any loader warning is present (issue #169)',
  )
  .description('Register a workflow definition')
  .action(async (inputPath: string, opts: { strict?: boolean }) => {
    const filePath =
      inputPath.endsWith('.yaml') || inputPath.endsWith('.yml')
        ? inputPath
        : join(inputPath, 'workflow.yaml');

    try {
      const { definition, warnings } = await loadWorkflowForRegistration(filePath);

      // The issue #170 boundary-reject, LIVE since the flip — checked before --strict, so an
      // unknown key is refused with or without the flag. Store-registered definitions already in
      // the registry are never re-parsed and are unaffected.
      if (rejectOnErrorSeverity(warnings)) {
        printLoaderWarnings(warnings);
        // One grammar with validate (issue #451): the line names WHICH warning escalated. The id
        // the old line carried is not missed — the operator just typed the path.
        console.error(renderEscalationLine(warnings));
        process.exit(1);
        return;
      }

      if (opts.strict && failsStrict(warnings)) {
        printLoaderWarnings(warnings);
        console.error(
          `Error: '${definition.id}' v${definition.version} has ${warnings.length} ${warnings.length === 1 ? 'warning' : 'warnings'}; refusing to register due to --strict`,
        );
        process.exit(1);
        return;
      }

      const store = new JsonWorkflowStore();
      await store.register(definition);
      printLoaderWarnings(warnings);
      const contextWarnings = lintWorkflowContext(definition);
      for (const warning of contextWarnings) {
        console.warn(`⚠ ${warning}`);
      }
      const stepCount = Object.keys(definition.steps).length;
      console.log(
        `Registered: ${definition.id} v${definition.version} (${stepCount} ${stepCount === 1 ? 'step' : 'steps'})`,
      );
      if (definition.description !== undefined) {
        console.log(`  ${definition.description}`);
      }
    } catch (err) {
      // issue #424 — see the comment at validate.ts's extension-free catch. This is the ONLY
      // render site for a loader failure here: the ManifestSecretsError catch above rethrows
      // into this one, so rendering there too would double-print.
      if (err instanceof WorkflowError && err.warnings !== undefined) {
        printLoaderWarnings(err.warnings);
      }
      // issue #451 — an extensions-load failure gets the sentence run and validate print for it.
      // First arm by placement only: an ExtensionLoadError is never a WorkflowError, so the
      // order against the family split below is immaterial.
      if (err instanceof ExtensionLoadError) {
        console.error(`Error loading extensions: ${err.message}`);
      }
      // issue #425 — THE FAMILY SPLIT. An `Invalid workflow:` message announces itself, so it
      // renders verbatim through the shared helper (which also lists a multi-error throw one per
      // line). Everything else this catch can see — a store failure, an unreadable path —
      // announces nothing on its own, so it keeps the prefix that earns its place (#417). The
      // predicate carries the colon, byte-matching the helper's own check.
      else if (err instanceof WorkflowError && err.message.startsWith('Invalid workflow:')) {
        console.error(renderLoadFailure(err));
      } else {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Error: ${message}`);
      }
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
