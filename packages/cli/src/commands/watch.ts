// realm workflow watch <path> — watches a workflow YAML and re-registers on change.
import { watch, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { Command } from 'commander';
import { loadWorkflowFromFileWithDiagnostics, WorkflowError } from '@sensigo/realm';
import type { WorkflowRegistrar, LoaderWarning } from '@sensigo/realm';
import { loadWorkflowForRegistration } from './register.js';
import {
  renderLoadFailure,
  printLoaderWarnings,
  rejectOnErrorSeverity,
} from '../lib/loader-warnings.js';

/**
 * Attempts to load and register a workflow YAML file.
 * Logs the result (success or validation error) to stdout/stderr.
 * Like `realm workflow register`, each (re-)registration mints the trust decision: when the
 * workflow declares `extensions:`, the modules load + duck-validate and step config gets the
 * config_schema two-pass BEFORE persisting. NOTE: long-lived watch processes keep the FIRST
 * imported content of each module path (ESM cache) — restart watch to pick up module changes.
 *
 * Prints every accumulated loader warning via printLoaderWarnings (issue #169) and applies the
 * issue #170 boundary-reject, LIVE since the flip — but never `--strict` (watch is a dev loop;
 * `--strict` is deliberately validate/register-only). Unlike validate/register this refuses
 * WITHOUT exiting: the watcher keeps running so the author can fix the key and be re-registered on
 * the next save, which is the whole point of a dev loop.
 * @param filePath Path to the workflow YAML file.
 * @param store    The registrar to register into.
 */
/**
 * issue #425: watch's own lines are timestamped and its warnings block was not, so on a busy
 * watch session the warnings floated free of the save that produced them. One gated header ties
 * them together. GATED because the clean-save path below calls printLoaderWarnings
 * unconditionally: an ungated header would print `[iso] 0 warnings:` over nothing on every
 * successful save. On console.warn, so it heads the block it belongs to rather than splitting
 * across channels.
 */
function printWarningsBlock(timestamp: string, warnings: LoaderWarning[]): void {
  if (warnings.length === 0) return;
  console.warn(
    `[${timestamp}] ${warnings.length} ${warnings.length === 1 ? 'warning' : 'warnings'}:`,
  );
  printLoaderWarnings(warnings);
}

async function registerFile(filePath: string, store: WorkflowRegistrar): Promise<void> {
  const timestamp = new Date().toISOString();
  try {
    const { definition, warnings } = await loadWorkflowForRegistration(filePath);
    if (rejectOnErrorSeverity(warnings)) {
      printWarningsBlock(timestamp, warnings);
      console.error(
        `[${timestamp}] Invalid: '${definition.id}' has a warning escalated to an error by policy — refusing to register.`,
      );
      return;
    }
    await store.register(definition);
    printWarningsBlock(timestamp, warnings);
    const stepCount = Object.keys(definition.steps).length;
    console.log(
      `[${timestamp}] Registered: ${definition.id} v${definition.version} (${stepCount} ${stepCount === 1 ? 'step' : 'steps'})`,
    );
  } catch (err) {
    if (err instanceof WorkflowError) {
      // issue #424 — see the comment at validate.ts's extension-free catch.
      if (err.warnings !== undefined) printWarningsBlock(timestamp, [...err.warnings]);
      console.error(`[${timestamp}] ${renderLoadFailure(err)}`);
    } else {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[${timestamp}] Error: ${message}`);
    }
  }
}

/**
 * Watches a workflow YAML file and re-registers it into the given store on every change.
 * Also watches the profiles directory alongside the YAML — any file change there triggers
 * re-registration. If the profiles directory does not exist, only the YAML is watched.
 * Performs an initial registration before entering the watch loop.
 * Resolves when the watcher is closed (e.g. when the AbortSignal fires).
 *
 * @param filePath    Path to the workflow YAML file.
 * @param store       The workflow registrar to register into — injected, never instantiated here.
 * @param signal      Optional AbortSignal; when aborted the watcher stops and the promise resolves.
 * @param profilesDir Optional override for the profiles directory path. Defaults to
 *                    `<workflow-dir>/profiles` (or `profiles_dir` declared in the YAML).
 */
export async function watchWorkflow(
  filePath: string,
  store: WorkflowRegistrar,
  signal?: AbortSignal,
  profilesDir?: string,
): Promise<void> {
  await registerFile(filePath, store);

  // Derive the profiles directory: caller override → YAML profiles_dir → default.
  let resolvedProfilesDir = profilesDir;
  if (resolvedProfilesDir === undefined) {
    const workflowDir = dirname(resolve(filePath));
    try {
      // WithDiagnostics + discard its warnings (issue #169): this load exists only to read
      // profiles_dir, not to surface anything — registerFile (just above) already owns
      // surfacing every warning for this same file, so printing here would double it.
      const { definition } = loadWorkflowFromFileWithDiagnostics(filePath);
      resolvedProfilesDir =
        definition.profiles_dir !== undefined
          ? resolve(workflowDir, definition.profiles_dir)
          : join(workflowDir, 'profiles');
    } catch {
      // If the YAML is invalid on startup we still run the YAML watcher.
      resolvedProfilesDir = join(workflowDir, 'profiles');
    }
  }

  const watchYaml = new Promise<void>((resolve, reject) => {
    const watcher = watch(filePath, { persistent: false, signal });

    watcher.on('change', (eventType: string) => {
      if (eventType === 'change') {
        void registerFile(filePath, store);
      }
    });

    watcher.on('error', (err: Error) => {
      reject(err);
    });

    watcher.on('close', () => {
      resolve();
    });
  });

  // Only watch the profiles directory if it exists.
  if (!existsSync(resolvedProfilesDir)) {
    return watchYaml;
  }

  const profilesDirPath = resolvedProfilesDir;
  const watchProfiles = new Promise<void>((resolve, reject) => {
    const watcher = watch(profilesDirPath, { persistent: false, signal });

    watcher.on('change', () => {
      void registerFile(filePath, store);
    });

    watcher.on('error', (err: Error) => {
      reject(err);
    });

    watcher.on('close', () => {
      resolve();
    });
  });

  await Promise.all([watchYaml, watchProfiles]);
}

export const watchCommand = new Command('watch')
  .argument('<path>', 'Path to workflow directory or workflow.yaml file')
  .description('Watch a workflow YAML file and re-register it on every change')
  .action(async (inputPath: string) => {
    const filePath =
      inputPath.endsWith('.yaml') || inputPath.endsWith('.yml')
        ? inputPath
        : join(inputPath, 'workflow.yaml');

    const { JsonWorkflowStore } = await import('@sensigo/realm');
    const store = new JsonWorkflowStore();

    console.log(`Watching ${filePath} — press Ctrl+C to stop`);
    try {
      await watchWorkflow(filePath, store);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${message}`);
      process.exit(1);
    }
  });
