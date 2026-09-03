// realm workflow watch <path> — watches a workflow YAML and re-registers on change.
import { watch, existsSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { Command } from 'commander';
import {
  loadWorkflowFromFileWithDiagnostics,
  renderLoaderWarning,
  WorkflowError,
} from '@sensigo/realm';
import type { WorkflowRegistrar, LoaderWarning } from '@sensigo/realm';
import { loadWorkflowForRegistration, ExtensionLoadError } from './register.js';
import {
  renderLoadFailure,
  renderEscalationLine,
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
function printWarningsBlock(
  timestamp: string,
  warnings: LoaderWarning[],
  opts?: { plain?: boolean },
): void {
  if (warnings.length === 0) return;
  console.warn(
    `[${timestamp}] ${warnings.length} ${warnings.length === 1 ? 'warning' : 'warnings'}:`,
  );
  // issue #463 — `plain` renders without printLoaderWarnings' `— REFUSED below` substitution. On
  // the extensions-failure path the escalation gate never ran and the refusal below is the
  // extensions error, so the substitution would name the wrong cause (test.ts's render comment,
  // #450's reasoning). The three boundary callers pass no opts and keep the substitution — there a
  // refusal of the warning's own follows: the escalation line, or renderLoadFailure's `Invalid:`.
  if (opts?.plain === true) {
    for (const w of warnings) console.warn(renderLoaderWarning(w));
  } else {
    printLoaderWarnings(warnings);
  }
}

async function registerFile(filePath: string, store: WorkflowRegistrar): Promise<void> {
  const timestamp = new Date().toISOString();
  try {
    const { definition, warnings } = await loadWorkflowForRegistration(filePath);
    if (rejectOnErrorSeverity(warnings)) {
      printWarningsBlock(timestamp, warnings);
      // One grammar with validate and register (issue #451) — plus a tail those two do not
      // need. They exit, so the refusal is the exit; watch CONTINUES, and a line that only
      // named the warning would leave it unsaid whether the file was registered anyway.
      console.error(`[${timestamp}] ${renderEscalationLine(warnings)} — refusing to register.`);
      return;
    }
    await store.register(definition);
    printWarningsBlock(timestamp, warnings);
    const stepCount = Object.keys(definition.steps).length;
    console.log(
      `[${timestamp}] Registered: ${definition.id} v${definition.version} (${stepCount} ${stepCount === 1 ? 'step' : 'steps'})`,
    );
  } catch (err) {
    if (err instanceof ExtensionLoadError) {
      // issue #451 — the sentence run, validate and register print for this class. The
      // watcher keeps running: fix the module, save, and the next pass re-registers.
      // issue #463 — the workflow's own warnings first, in the plain form (see printWarningsBlock);
      // the block's empty-array return is the belt under the ABSENT guard.
      if (err.warnings !== undefined) {
        printWarningsBlock(timestamp, [...err.warnings], { plain: true });
      }
      console.error(`[${timestamp}] Error loading extensions: ${err.message}`);
    } else if (err instanceof WorkflowError) {
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
 * issue #453 — thrown when the watched directory itself is gone: deleted, or moved somewhere the
 * watch cannot follow (an ancestor moved, or the directory's own self-event arrived and the path
 * is absent). The single source of that claim's text — minted here, thrown once, rendered once by
 * the CLI catch below as `Error: ` + this message.
 */
const DEATH_MSG =
  "The watched directory no longer exists — deleted, or moved out from under the watch. Nothing is watched any more; restart 'realm workflow watch' when the path exists again.";

/**
 * issue #453 — the profiles directory's own death is NOT fatal (it was optional at startup,
 * issue #449's :257-260 non-goal): the YAML watch continues, and this is the honest replacement
 * for what used to be silence. Timestamped like the file's other lines. Minted through this ONE
 * helper for both call sites (the coalesced callback's maintenance branch, and the profiles
 * loop's own catch-on-reopen arm) so the two can never drift apart.
 */
function renderProfilesGone(): string {
  return `[${new Date().toISOString()}] The profiles directory is gone — profile edits are no longer watched. Restart watch if you recreate it.`;
}

/**
 * Watches a workflow YAML file and re-registers it into the given store on every change.
 * Also watches the profiles directory alongside the YAML — any file change there triggers
 * re-registration. If the profiles directory does not exist, only the YAML is watched.
 * Performs an initial registration before entering the watch loop.
 * Resolves when the watcher is closed (e.g. when the AbortSignal fires) — or THROWS when the
 * watched directory stops existing (both watchers closed first — the throw never leaves a live
 * watcher behind).
 *
 * Four mechanics worth knowing (issues #449, #453):
 * - The YAML watch is on the file's DIRECTORY, filtered by basename — a file watch dies with the
 *   inode an atomic save renames away.
 * - Both watchers are persistent, so they hold the process open; Ctrl+C is what stops it.
 * - Each save's event burst is coalesced into one re-registration on a 100ms trailing edge.
 * - The watched directory ITSELF can be replaced or removed. Replacement it can OBSERVE — the
 *   directory's own rename event fires whether it was deleted or moved, and if the path still
 *   exists afterwards (a fast delete+recreate, an atomic tree replace, a same-named sibling) the
 *   watch closes its stale handle and re-arms fresh on the same path, silently. If the path does
 *   NOT exist when that check runs, the watch stops and this function throws — never waits for
 *   the path to come back; restart is the recovery, deliberately (the #449 posture: no
 *   late-mount, no self-healing poll). Detection rides the platform's watcher events, so it
 *   degrades to the pre-#453 behaviour wherever those events do not arrive — an ancestor
 *   directory moving away, with no further activity inside, delivers nothing to this handle at
 *   all (documented residual, not polled around).
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
  // issue #449 — the missing-file contract, preserved deliberately. `fs.watch` on an absent FILE
  // threw ENOENT and the action exited 1; a DIRECTORY watch would happily watch nothing forever,
  // silently. Same error, same exit, raised explicitly now that the watch itself no longer does.
  //
  // POSITION IS LOAD-BEARING: before any resource exists. Thrown after the watcher was created,
  // this left a live persistent watcher behind a reported failure — executed: the rejection
  // arrives, a workflow.yaml created afterwards still gets registered by the phantom, and the
  // caller's event loop is held open by a watch it was told had failed. It also orphaned the
  // never-awaited watchYaml promise, so a later 'error' on the leaked handle would have surfaced
  // as an unhandled rejection. The CLI never saw either — its catch calls process.exit(1) — but
  // the function's own contract ("resolves when the watcher is closed") cannot be honoured by a
  // rejection that closes nothing.
  if (!existsSync(filePath)) {
    throw new Error(`ENOENT: no such file or directory, watch '${filePath}'`);
  }

  // Computed BEFORE the Promise below: the executor's `resolve` parameter shadows node:path's
  // `resolve`, so path math inside it is a trap.
  const watchDir = dirname(resolve(filePath));
  const watchName = basename(filePath);
  // issue #453 — the directory's OWN basename: its rename event is surfaced with this name, not
  // the watched file's (IN_DELETE_SELF/IN_MOVE_SELF; grounding P3a/P3b). Computed once, beside
  // the names above — never recomputed on re-arm, since a re-arm always watches the SAME path.
  const dirSelfName = basename(watchDir);

  // issue #453 — an INTERNAL controller, always present, so a fatal death or a watcher 'error'
  // can stop BOTH loops even when the caller passed no signal at all (or the caller's signal
  // never fires). `effSignal` is what every fs.watch call below actually receives.
  const internal = new AbortController();
  const effSignal =
    signal === undefined ? internal.signal : AbortSignal.any([signal, internal.signal]);

  // The single funnel every fatal condition writes to; thrown once, after both loops have ended.
  let fatal: Error | undefined;

  // issue #453 — the coalesced callback's two inputs, set by the 'change' handlers below and
  // consumed (snapshotted, then cleared) at the TOP of the callback — never reset per-branch,
  // which would create a two-readings ambiguity between the branch that sets them and the branch
  // that reads them.
  let selfEventSeen = false;
  let profilesSelfSeen = false;
  // Latches false the moment the profiles directory is found gone — a post-close straggler event
  // on the (now-idle) old profiles watcher is then a no-op, never a second PROFILES_GONE line.
  let profilesLoopLive = true;

  const profilesDirPath = resolvedProfilesDir;

  // Each loop's "please end your current watcher with this outcome" request, set by the
  // coalesced callback (or the loop's own error/catch arm) and read by that SAME watcher's
  // 'close' handler once close() actually fires. Reset to 'aborted' at the top of every new
  // iteration, so an iteration that never gets a request defaults to ending the whole loop.
  let yamlPendingOutcome: 'aborted' | 'rearm' = 'aborted';
  let profilesPendingOutcome: 'aborted' | 'rearm' | 'gone' = 'aborted';
  // The CURRENT watcher's own close(), reachable from the coalesced callback so it can request a
  // re-arm or a gone-stop without knowing which iteration is live.
  let closeCurrentYaml: (() => void) | undefined;
  let closeCurrentProfiles: (() => void) | undefined;

  // issue #453 — the single discriminate-first chokepoint. Both watchers' 'change' handlers
  // funnel here (via the shared coalescer), so death, re-arm and profiles maintenance are decided
  // in ONE place, in a fixed order, never per-branch.
  function onCoalesced(): void {
    const selfSeen = selfEventSeen;
    const profSeen = profilesSelfSeen;
    selfEventSeen = false;
    profilesSelfSeen = false;

    // (a) Death net — checked FIRST, unconditionally. This is what catches an ancestor-mv (no
    // self event ever reaches this handle for that case — grounding addendum) and what makes an
    // mv-then-immediate-write race die with the honest message instead of a misattributed one:
    // a self event and a content event can both be pending when this runs, but the directory's
    // absence is checked before either is acted on.
    if (!existsSync(watchDir)) {
      fatal ??= new Error(DEATH_MSG);
      internal.abort();
      return;
    }

    // (b) YAML re-arm. SILENT — no line: any positive wording ("replaced") is unprovable against
    // the sibling-collision case (a file literally named like the directory emits the identical
    // event shape — grounding E2c), so the only observable contract is whatever the next
    // registerFile call prints. Requesting a re-arm on a directory that in fact never died (E2c)
    // is harmless — the old watcher closes, a fresh one opens on the same live path.
    if (selfSeen) {
      yamlPendingOutcome = 'rearm';
      closeCurrentYaml?.();
    }

    // (c) Profiles maintenance — independent of (b); either can fire alone.
    if (profSeen && profilesLoopLive) {
      if (!existsSync(profilesDirPath)) {
        console.error(renderProfilesGone());
        profilesLoopLive = false;
        profilesPendingOutcome = 'gone';
        closeCurrentProfiles?.();
      } else {
        profilesPendingOutcome = 'rearm';
        closeCurrentProfiles?.();
      }
    }

    // (d) Fall through. Runs on the re-arm and 'gone' paths alike — a profiles-deletion burst
    // still re-registers once (today's census behaviour, kept); the death path already returned
    // above and never reaches here.
    void registerFile(filePath, store);
  }

  // ONE coalescer shared by both watchers' 'change' handlers, funneling into the discriminate-first
  // chokepoint above — never wired directly to registerFile. See makeCoalescedTrigger for what
  // actually bursts.
  const coalesced = makeCoalescedTrigger(onCoalesced, COALESCE_MS);

  async function yamlLoop(): Promise<void> {
    for (;;) {
      if (effSignal.aborted) return;

      let watcher: ReturnType<typeof watch>;
      try {
        watcher = watch(watchDir, { persistent: true, signal: effSignal });
      } catch (err) {
        // issue #453 — fs.watch throws SYNC ENOENT on an absent path (grounding addendum): the
        // re-arm's own TOCTOU window (the directory vanishing between the death net's existsSync
        // and this re-creation). The YAML loop's version of this is always fatal.
        fatal ??=
          (err as NodeJS.ErrnoException).code === 'ENOENT' ? new Error(DEATH_MSG) : (err as Error);
        internal.abort();
        return;
      }

      yamlPendingOutcome = 'aborted';
      const outcome = await new Promise<'aborted' | 'rearm'>((resolveIter) => {
        closeCurrentYaml = () => watcher.close();

        watcher.on('change', (_eventType: string, filename: string | Buffer | null) => {
          // Self-name FIRST: in the pathological case where the directory is itself named
          // `workflow.yaml` (dirSelfName === watchName), self-first still detects the
          // directory's own death — it only degrades to a harmless extra re-arm on ordinary
          // file saves, never the reverse.
          if (filename === dirSelfName) {
            selfEventSeen = true;
            coalesced.trigger();
          } else if (filename === watchName || filename === null) {
            // `null` is in the type and means "the platform could not say which file" — treat
            // it as possibly-ours rather than dropping a real edit. Buffer only under
            // encoding:'buffer', which is never set here.
            coalesced.trigger();
          }
        });

        watcher.on('error', (err: Error) => {
          // issue #453 — an errored FSWatcher never emits 'close' (Node nulls the handle in its
          // error path specifically to avoid firing it — grounding addendum, executed against
          // node internals). Waiting for 'close' here would deadlock forever with the other
          // watcher already closed: settle this iteration's own promise directly.
          // This arm has no test coverage on Linux — inotify never emits 'error' for the
          // directory-death class this file cares about (the negative knowledge behind the whole
          // design), so there is no reachable trigger to construct a cell from. Stated, not
          // pretended: correctness here rests on the two executed facts cited above, not on a pin.
          fatal ??= err;
          internal.abort();
          yamlPendingOutcome = 'aborted';
          resolveIter('aborted');
        });

        watcher.on('close', () => {
          // A 'rearm' close must NOT cancel the coalescer: the OTHER watcher may have armed it
          // inside this close gap, and cancelling here would silently drop a pending save.
          if (yamlPendingOutcome === 'aborted') coalesced.cancel();
          resolveIter(yamlPendingOutcome);
        });
      });

      closeCurrentYaml = undefined;
      if (outcome === 'aborted') return;
      // outcome === 'rearm': loop — a fresh watcher opens on the same path next iteration.
    }
  }

  async function profilesLoop(): Promise<void> {
    for (;;) {
      if (effSignal.aborted) return;

      let watcher: ReturnType<typeof watch>;
      try {
        watcher = watch(profilesDirPath, { persistent: true, signal: effSignal });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          // issue #453 — the profiles directory is optional (issue #449's non-goal at startup);
          // its disappearance is never fatal and never DEATH_MSG, whose "watched directory" claim
          // would be false here. The YAML loop is untouched by this return.
          console.error(renderProfilesGone());
          profilesLoopLive = false;
          return;
        }
        fatal ??= err as Error;
        internal.abort();
        return;
      }

      profilesPendingOutcome = 'aborted';
      const outcome = await new Promise<'aborted' | 'rearm' | 'gone'>((resolveIter) => {
        closeCurrentProfiles = () => watcher.close();

        watcher.on('change', (_eventType: string, filename: string | Buffer | null) => {
          if (filename === basename(profilesDirPath)) profilesSelfSeen = true;
          // Still triggers unconditionally, matching today's behaviour: any change inside the
          // profiles directory re-registers, self-name or not.
          coalesced.trigger();
        });

        watcher.on('error', (err: Error) => {
          // Same settle-own-promise rule as the YAML loop's 'error' handler above, and the same
          // no-cell-on-Linux disclosure applies here too.
          fatal ??= err;
          internal.abort();
          profilesPendingOutcome = 'aborted';
          resolveIter('aborted');
        });

        watcher.on('close', () => {
          if (profilesPendingOutcome === 'aborted') coalesced.cancel();
          resolveIter(profilesPendingOutcome);
        });
      });

      closeCurrentProfiles = undefined;
      if (outcome !== 'rearm') return;
      // outcome === 'rearm': loop — a fresh watcher opens on the same path next iteration.
    }
  }

  const loops = [yamlLoop()];
  // Only watch the profiles directory if it exists at startup (issue #449's non-goal: no
  // late-mount for a directory created after the watch began).
  if (existsSync(resolvedProfilesDir)) loops.push(profilesLoop());

  await Promise.all(loops);
  if (fatal !== undefined) throw fatal;
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
