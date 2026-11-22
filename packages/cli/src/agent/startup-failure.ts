// startup-failure.ts — Q1 (#592) unit c: a startup death leaves a mark on the run.
//
// THE PROBLEM. `realm agent --run-id <id>` that died in its own startup checks — no key for the
// provider, no model, `--base-url` with Anthropic, a provider module that does not load — kept no
// trace on the run: the command printed its refusal and exited 1, and the run looked untouched on
// every surface, as if nobody had tried. A `realm listen` child killed by a signal before it wrote
// anything left nothing either.
//
// THE MARK. One drive-failure entry of kind `startup_failure`, written by the process that saw the
// death (first person): the worker for its own refusal ({@link recordStartupFailure}), `realm
// listen` for a child killed by a signal before it wrote anything ({@link markSignalDeath}). An exit
// CODE is never a verdict: `realm agent` exits 1 on every result but `completed`, and writes its own
// mark for the refusals that are deaths.
import {
  WorkflowError,
  type DriveFailureRecord,
  type RunRecord,
  type RunStore,
} from '@sensigo/realm';
import { sanitizeError } from './providers/agent-utils.js';
import { failureModelTextOf } from './providers/model-text.js';
import {
  MESSAGE_CAP,
  appendDriveFailure,
  recordDriveFailure,
  type DriveFailureOutcome,
} from './drive-failure.js';

/** The facts of one startup death, as its writer knows them. */
interface StartupDeath {
  /** When it happened, on the run store's clock. */
  at: Date;
  /** The asked `--provider`, or `'unknown'`. */
  provider: string;
  /** What was said: the refusal's own words, without the closing sentence. */
  message: string;
  /** How long it took: from the command's start (the worker), or from the spawn (listen). */
  elapsedMs: number;
  /** Whether model text is recorded (`--no-record-model-text` turns it off). */
  recordModelText: boolean;
}

/**
 * The entry a startup death writes: a drive failure before any step (`step: ''`), of kind
 * `startup_failure`, its message sanitized and capped as every entry's is, and the `model_text`
 * every CLI drive-failure entry carries (no model request belongs to it).
 */
export function startupFailureEntry(death: StartupDeath): DriveFailureRecord {
  return {
    at: death.at.toISOString(),
    step: '',
    provider: death.provider,
    error_class: 'startup_failure',
    message: sanitizeError(death.message).slice(0, MESSAGE_CAP),
    elapsed_ms: death.elapsedMs,
    model_text: failureModelTextOf(undefined, death.recordModelText),
  };
}

/**
 * The refusal's closing sentence, one per outcome of the write — what was done to the run. The
 * `written` sentence states `findDriveFailing`'s rule: the finding clears at the next evidence entry
 * of any outcome, at a gate change, or when the run ends.
 */
export function startupOutcomeSentence(runId: string, outcome: DriveFailureOutcome): string {
  switch (outcome) {
    case 'written':
      // eslint-disable-next-line no-restricted-syntax -- prose naming the command that lists the run, not a command to copy (#729 PR-3, L-2); the interpolated value is the run id, outside it.
      return `Run ${runId} keeps this failure under Drive failures; realm run list --stuck lists it until the run next records a step or a question, or ends.`;
    case 'run_ended':
      return `Run ${runId} had already ended; nothing was recorded.`;
    case 'not_found':
      return `Run ${runId} is not in the store; nothing was recorded.`;
    case 'not_written':
      return `Run ${runId} could not be updated; the failure was not recorded.`;
  }
}

/**
 * `realm agent`'s mark: records the refusal on run `runId` through {@link recordDriveFailure} (which
 * skips an ended run and a missing one, retries contention and prints its lost line when the write
 * fails) and returns the refusal's closing sentence for what happened. `elapsed_ms` is measured from
 * the process's start, so it is never 0.
 */
export async function recordStartupFailure(
  store: Pick<RunStore, 'get' | 'update' | 'clock'>,
  runId: string,
  death: { provider: string | undefined; message: string; recordModelText: boolean },
): Promise<string> {
  const entry = startupFailureEntry({
    at: store.clock.now(),
    provider: death.provider ?? 'unknown',
    message: death.message,
    elapsedMs: Math.max(1, Math.round(process.uptime() * 1000)),
    recordModelText: death.recordModelText,
  });
  return startupOutcomeSentence(runId, await recordDriveFailure(store, runId, entry));
}

/** How a child process ended, as Node's `'exit'` event gives it. */
export interface ChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/** The logger `realm listen` writes through. */
interface MarkLogger {
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
}

/**
 * `realm listen`'s mark for the `realm agent` it started: written ONLY when the child died by a
 * SIGNAL (`code === null && signal !== null`) and the run has not moved since `baseline`, the record
 * of listen's own last write. ONE compare-and-set `update` of the baseline with the entry appended
 * as {@link recordDriveFailure} appends it: a `STATE_SNAPSHOT_MISMATCH` means the child (or anyone)
 * wrote to the run, and nothing is written — never a retry, which would re-read and write onto a run
 * that moved. An exit code, any code, is never marked. Every outcome is logged; nothing throws.
 */
export async function markSignalDeath(
  store: Pick<RunStore, 'update' | 'clock'>,
  logger: MarkLogger,
  baseline: RunRecord,
  exit: ChildExit,
  spawnedAt: number,
): Promise<void> {
  if (exit.code !== null || exit.signal === null) return;
  const entry = startupFailureEntry({
    at: store.clock.now(),
    provider: 'unknown',
    // eslint-disable-next-line no-restricted-syntax -- prose naming the program that was killed, not a command to copy (#729 PR-3, L-2).
    message: `realm agent was killed by ${exit.signal} before it wrote anything to the run`,
    elapsedMs: Math.max(0, Math.round(performance.now() - spawnedAt)),
    // Listen's child records model text unless told not to; the flag is not in the handler's scope,
    // and an entry with no model request reads the same either way.
    recordModelText: true,
  });
  try {
    await store.update(appendDriveFailure(baseline, entry));
    logger.warn('listen: recorded a startup failure', {
      run_id: baseline.id,
      signal: exit.signal,
    });
  } catch (err) {
    const code = err instanceof WorkflowError ? err.code : undefined;
    if (code === 'STATE_SNAPSHOT_MISMATCH') {
      // The run's version moved since listen's own write: the agent (or another writer) wrote to it,
      // or it ended. Left to the run's other findings.
      logger.warn(
        'listen: the run moved before the agent was killed; no startup failure recorded',
        {
          run_id: baseline.id,
          signal: exit.signal,
        },
      );
    } else if (code === 'STATE_RUN_NOT_FOUND') {
      logger.warn('listen: the run is no longer in the store; no startup failure recorded', {
        run_id: baseline.id,
        signal: exit.signal,
      });
    } else {
      logger.error('listen: failed to record a startup failure', {
        run_id: baseline.id,
        signal: exit.signal,
        ...(code !== undefined ? { error_code: code } : {}),
        error: String(err),
      });
    }
  }
}
