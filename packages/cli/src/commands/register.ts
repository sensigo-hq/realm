// realm register <path> — validates and registers a workflow from a YAML file.
// Registering MINTS the trust decision for project extensions: when the workflow declares
// `extensions:`, the modules are fully loaded + duck-validated and step config is validated
// against the resolved adapters' config_schema (two-pass) BEFORE anything is persisted.
// The admission path itself lives in lib/load-workflow-for-admission.ts (issue #553) — validate
// and watch take the identical path.
import { Command } from 'commander';
import { join } from 'node:path';
import { renderLoaderWarning, JsonWorkflowStore, WorkflowError } from '@sensigo/realm';
import type { WorkflowDefinition } from '@sensigo/realm';
import {
  printLoaderWarnings,
  rejectOnErrorSeverity,
  failsStrict,
  renderLoadFailure,
  renderEscalationLine,
} from '../lib/loader-warnings.js';
import {
  loadWorkflowForAdmission,
  ExtensionLoadError,
} from '../lib/load-workflow-for-admission.js';

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
      const { definition, warnings } = await loadWorkflowForAdmission(filePath, {
        surface: 'register',
      });

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
        // issue #463 — the workflow's own warnings first, then the sentence (the #424 catch-render
        // shape). The PLAIN render, not printLoaderWarnings: historically that helper rewrote
        // `— ignored` to `— REFUSED below` for the codes this boundary refuses, and on this path
        // the escalation gate never ran — the refusal below is the extensions error, so
        // "REFUSED below" would have named the wrong cause. Issue #540 deleted that substitution
        // — the two renderers now produce identical bytes — but the plain render stays here
        // (kept as two call shapes on purpose, see #542); `— ignored` is the core's statement
        // about the PARSE, true here as on every surface, and the composition then reads exactly
        // as `realm run` prints it (test.ts's render comment — #450's reasoning, generalized).
        if (err.warnings !== undefined) {
          for (const w of err.warnings) console.warn(renderLoaderWarning(w));
        }
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
