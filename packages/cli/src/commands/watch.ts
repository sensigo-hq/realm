// realm workflow watch <path> — watches a workflow YAML and re-registers on change.
import { watch, existsSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
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

/** The trailing-edge window a save's event burst collapses into (issue #449). */
const COALESCE_MS = 100;

/**
 * A trailing-edge coalescer: every `trigger()` (re)arms one timer, so a burst of calls inside the
 * window produces exactly one `fn()` at the end of it (issue #449).
 *
 * WHAT ACTUALLY BURSTS, precisely — the YAML watcher is not the reason. On this platform the
 * basename filter already reduces an atomic save to ONE passing event. The burst is the
 * profiles watcher, which has no filter: creating a file there emits `rename` + `change`, two
 * events, probe-proven. Cross-platform event shapes vary besides, so one instance is shared by
 * both watchers rather than reasoned about per-watcher.
 *
 * `cancel()` exists because an abort must not leave a pending timer: it would fire after the
 * watch resolved, re-registering into a store whose owner has moved on. Idempotent.
 *
 * @internal Exported for testing only.
 */
export function makeCoalescedTrigger(
  fn: () => void,
  delayMs: number,
): { trigger(): void; cancel(): void } {
  let timer: NodeJS.Timeout | undefined;
  return {
    trigger(): void {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        fn();
      }, delayMs);
    },
    cancel(): void {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}

/**
 * Watches a workflow YAML file and re-registers it into the given store on every change.
 * Also watches the profiles directory alongside the YAML — any file change there triggers
 * re-registration. If the profiles directory does not exist, only the YAML is watched.
 * Performs an initial registration before entering the watch loop.
 * Resolves when the watcher is closed (e.g. when the AbortSignal fires).
 *
 * Three mechanics worth knowing (issue #449):
 * - The YAML watch is on the file's DIRECTORY, filtered by basename — a file watch dies with the
 *   inode an atomic save renames away.
 * - Both watchers are persistent, so they hold the process open; Ctrl+C is what stops it.
 * - Each save's event burst is coalesced into one re-registration on a 100ms trailing edge.
 *
 * RESTART REQUIRED for three things, all read once at startup and never re-read: the extension
 * modules (ESM cache, note below), a `profiles/` directory created after the watch began, and a
 * `profiles_dir:` value edited mid-watch — an edit to that key keeps watching the OLD directory
 * until you restart. No late-mount machinery; watch-before-create is a separate feature.
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

  // issue #449 — `fs.watch` on the FILE dies with the inode. A vim-style atomic save writes a
  // temp file and renames it over the target, so the watched inode is renamed away: the save that
  // does it can still slip through as the dying inode's final `change` (executed: v2 DOES
  // register), but the handle is dead from then on — the NEXT atomic save, and an ordinary
  // in-place write after it, emit nothing at all (executed: count stays 2 through both). One vim
  // save left watch silently blind to every later edit.
  //
  // Watching the DIRECTORY and filtering by basename fixes it structurally: the directory sees
  // the rename INTO the name, and a directory handle has no inode to die with. No eventType
  // filter — event shapes vary by platform, and on this one an atomic save's passing event is a
  // `rename`, not a `change`.
  //
  // Computed BEFORE the Promise below: the executor's `resolve` parameter shadows node:path's
  // `resolve`, so path math inside it is a trap.
  const watchDir = dirname(resolve(filePath));
  const watchName = basename(filePath);

  // ONE coalescer shared by both watchers, created after the initial registration above so that
  // first pass stays immediate. See makeCoalescedTrigger for what actually bursts.
  const coalesced = makeCoalescedTrigger(() => {
    void registerFile(filePath, store);
  }, COALESCE_MS);

  const watchYaml = new Promise<void>((resolveWatch, reject) => {
    // persistent: true (issue #449) — this was the liveness half. Non-persistent watchers do not
    // hold the event loop, so the real CLI ran its initial registration and exited ~0.6s later
    // while claiming to watch. No in-process test could ever see it: under vitest the runner's
    // own loop keeps the process alive, which is exactly what `persistent` decides.
    const watcher = watch(watchDir, { persistent: true, signal });

    watcher.on('change', (_eventType: string, filename: string | Buffer | null) => {
      // `null` is in the type and means "the platform could not say which file" — treat it as
      // possibly-ours rather than dropping a real edit. Buffer only under encoding:'buffer',
      // which is never set here.
      if (filename === watchName || filename === null) coalesced.trigger();
    });

    watcher.on('error', (err: Error) => {
      reject(err);
    });

    watcher.on('close', () => {
      // Before resolving, or a pending timer fires after the watch is over — re-registering into
      // a store whose owner has finished with it.
      coalesced.cancel();
      resolveWatch();
    });
  });

  // issue #449 — the missing-file contract, preserved deliberately. `fs.watch` on an absent FILE
  // threw ENOENT and the action exited 1; a DIRECTORY watch would happily watch nothing forever,
  // silently. Same error, same exit, raised explicitly now that the watch itself no longer does.
  if (!existsSync(filePath)) {
    throw new Error(`ENOENT: no such file or directory, watch '${filePath}'`);
  }

  // Only watch the profiles directory if it exists.
  if (!existsSync(resolvedProfilesDir)) {
    return watchYaml;
  }

  const profilesDirPath = resolvedProfilesDir;
  const watchProfiles = new Promise<void>((resolveWatch, reject) => {
    const watcher = watch(profilesDirPath, { persistent: true, signal });

    watcher.on('change', () => {
      coalesced.trigger();
    });

    watcher.on('error', (err: Error) => {
      reject(err);
    });

    watcher.on('close', () => {
      coalesced.cancel();
      resolveWatch();
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
