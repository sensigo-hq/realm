// result-wait.ts — R1.2: a caller of `realm listen` asks the reply to wait for the run's result.
//
// A POST that starts a run of a workflow with `trigger.result_map` may send `Prefer: wait=N`
// (RFC 7240 §4.3). `realm listen` then holds the reply until the run ends, reaches a person's gate,
// or N seconds pass (N no more than `--max-wait`), and answers where the run stands: a finished run
// gets the `200` the read address would answer, built by the read address's own producer
// (`readReplyBody`), and any other gets R1.1's `202` with the phase reached. Every reply of a wait
// carries `Preference-Applied: wait=<N applied>`, except the one sent after a failed read, which is
// the reply the request would have had without `Prefer`. The wait never cancels the run, writes
// nothing, and ends early when the agent's process exits, when a check (one read every 2 s) finds a
// gate or a finished run, at the first Ctrl+C or `SIGTERM`, and when the caller hangs up.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { deriveRunPhase, isTerminalPhase, type RunRecord } from '@sensigo/realm';
import { readReplyBody, sendRead, type ReadContext, type ReadEntry } from './run-read-address.js';

/** How often a wait reads its run: the agent's own gate poll is every 3 s. */
export const WAIT_CHECK_MS = 2000;

/** What ended a wait, as the `webhook: wait ended` line says it. */
export type WaitEnd = 'terminal' | 'gate' | 'exit' | 'cap' | 'signal' | 'hangup' | 'failed';

/** `value` cut at each `sep` that is outside a quoted string (RFC 9110 §5.6.4: `\` escapes in one). */
function splitOutside(value: string, sep: string): string[] {
  const parts: string[] = [];
  let quoted = false;
  let start = 0;
  for (let i = 0; i < value.length; i += 1) {
    const c = value[i];
    if (quoted && c === '\\') i += 1;
    else if (c === '"') quoted = !quoted;
    else if (!quoted && c === sep) {
      parts.push(value.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(value.slice(start));
  return parts;
}

/**
 * The seconds a `Prefer` header asks to wait, or undefined. The header is a comma list (RFC 7240
 * §2); only its first `wait`, the name in any case, counts, and the rest are ignored. It counts only
 * as `wait=<digits>`, at least 1, with blanks around `=` allowed and no parameter
 * (`delta-seconds = 1*DIGIT`, RFC 7234 §1.2.1); anything else is ignored, never an error.
 */
export function parseWaitPreference(
  header: string | readonly string[] | undefined,
): number | undefined {
  if (header === undefined) return undefined;
  // Node joins repeated `Prefer` lines with `, ` itself; the type allows the list too.
  const list = typeof header === 'string' ? header : header.join(',');
  for (const element of splitOutside(list, ',')) {
    const [preference = '', ...parameters] = splitOutside(element, ';');
    const eq = preference.indexOf('=');
    const name = (eq === -1 ? preference : preference.slice(0, eq)).trim();
    if (name.toLowerCase() !== 'wait') continue;
    const value = eq === -1 ? '' : preference.slice(eq + 1).trim();
    if (parameters.some((p) => p.trim() !== '') || !/^[0-9]+$/.test(value)) return undefined;
    const seconds = Number(value);
    return seconds >= 1 ? seconds : undefined;
  }
  return undefined;
}

/** How a wait ended, the run as its last read found it, and how long it took. */
interface WaitOutcome {
  readonly endedBy: WaitEnd;
  /** Absent for a hang-up and after a failed read. */
  readonly run?: RunRecord;
  readonly waitedMs: number;
}

/** What one wait needs. */
interface WaitInput {
  readonly seconds: number;
  /** One read of the run from the store; never the read address's phase cache. */
  readonly read: () => Promise<RunRecord>;
  /** Settles when the agent's process exits; absent, only the check and the cap wake the wait. */
  readonly exited?: Promise<unknown>;
  readonly stopSignal?: AbortSignal;
  readonly res: ServerResponse;
  readonly onReadFailed: (err: unknown) => void;
}

/**
 * Waits for the run, never longer than `seconds`. The first of these ends it: a check (one read
 * every `WAIT_CHECK_MS`) that finds a finished run or a gate; the agent's exit, the cap or the stop
 * signal, each followed by one read (a finished run then ends it as `terminal`); the caller hanging
 * up. A check whose read fails is tried again at the next one. Every ending releases both timers and
 * both listeners. The exit promise, which may never settle (an agent at a gate), keeps what the
 * closures made for it hold, the request and response among it, until the agent exits: about 8 KB a
 * wait.
 */
function waitForRun(input: WaitInput): Promise<WaitOutcome> {
  const started = performance.now();
  return new Promise<WaitOutcome>((resolve) => {
    let settled = false;
    let ending = false;
    const timer: { check?: NodeJS.Timeout; cap?: NodeJS.Timeout } = {};
    const onExit: { fn: (() => void) | undefined } = { fn: undefined };
    const finish = (endedBy: WaitEnd, run?: RunRecord): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer.check);
      clearTimeout(timer.cap);
      input.stopSignal?.removeEventListener('abort', onAbort);
      input.res.removeListener('close', onClose);
      onExit.fn = undefined;
      resolve({
        endedBy,
        ...(run !== undefined ? { run } : {}),
        waitedMs: Math.round(performance.now() - started),
      });
    };
    const finalRead = (by: 'exit' | 'cap' | 'signal'): void => {
      if (ending || settled) return;
      ending = true;
      clearTimeout(timer.check);
      clearTimeout(timer.cap);
      input.read().then(
        (run) => finish(isTerminalPhase(deriveRunPhase(run)) ? 'terminal' : by, run),
        (err: unknown) => {
          input.onReadFailed(err);
          finish('failed');
        },
      );
    };
    const check = (): void => {
      input.read().then(
        (run) => {
          if (ending || settled) return;
          const phase = deriveRunPhase(run);
          if (isTerminalPhase(phase)) finish('terminal', run);
          else if (phase === 'gate_waiting') finish('gate', run);
          else timer.check = setTimeout(check, WAIT_CHECK_MS);
        },
        (err: unknown) => {
          input.onReadFailed(err);
          if (!ending && !settled) timer.check = setTimeout(check, WAIT_CHECK_MS);
        },
      );
    };
    const onAbort = (): void => finalRead('signal');
    // The response's `close`, not the request's: the request's fires once its body has been read.
    const onClose = (): void => finish(input.stopSignal?.aborted === true ? 'signal' : 'hangup');
    input.stopSignal?.addEventListener('abort', onAbort, { once: true });
    input.res.once('close', onClose);
    onExit.fn = () => finalRead('exit');
    input.exited?.then(
      () => onExit.fn?.(),
      () => onExit.fn?.(),
    );
    timer.check = setTimeout(check, WAIT_CHECK_MS);
    timer.cap = setTimeout(() => finalRead('cap'), input.seconds * 1000);
  });
}

/** What answering a waiting request needs from listen. */
export interface WaitReply {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly entry: ReadEntry;
  readonly runId: string;
  /** The N applied: the asked N, no more than `--max-wait`. */
  readonly seconds: number;
  readonly read: () => Promise<RunRecord>;
  readonly exited?: Promise<unknown>;
  readonly stopSignal?: AbortSignal;
  readonly disclosureProvider: ReadContext['disclosureProvider'];
  /** Writes R1.1's `202` with `runPhase`, its headers plus `extra`. */
  readonly accepted: (runPhase: string, extra?: Record<string, string>) => void;
  readonly logger: {
    info(msg: string, data?: unknown): void;
    error(msg: string, data?: unknown): void;
  };
  /** The request's path, for the `webhook: read failed` line. */
  readonly path: string;
}

/**
 * Holds a request that asked to wait (the handler has checked that it may), then answers it once:
 * the read's `200` for a finished run, R1.1's `202` with the phase for any other, both with
 * `Preference-Applied`; after a failed read, the `202` the request would have had without
 * `Prefer`; nothing to a caller who has gone. Logs one `webhook: wait ended` line.
 */
export async function answerWait(w: WaitReply): Promise<void> {
  const onReadFailed = (err: unknown): void => {
    w.logger.error('webhook: read failed', { path: w.path, run_id: w.runId, error: String(err) });
  };
  const outcome = await waitForRun({
    seconds: w.seconds,
    read: w.read,
    ...(w.exited !== undefined ? { exited: w.exited } : {}),
    ...(w.stopSignal !== undefined ? { stopSignal: w.stopSignal } : {}),
    res: w.res,
    onReadFailed,
  });
  let endedBy = outcome.endedBy;
  const applied = { 'Preference-Applied': `wait=${w.seconds}` };
  let body: Record<string, unknown> | undefined;
  if (endedBy === 'terminal' && outcome.run !== undefined) {
    try {
      body = await readReplyBody(w.entry, outcome.run, w);
    } catch (err) {
      onReadFailed(err);
      endedBy = 'failed';
    }
  }
  if (w.res.destroyed || w.req.socket.destroyed) {
    // Nothing is written to a destroyed response: the caller hung up, or the stop cut it.
    if (endedBy !== 'hangup') endedBy = w.stopSignal?.aborted === true ? 'signal' : 'hangup';
  } else if (body !== undefined) {
    sendRead(w.req, w.res, 200, body, applied);
  } else if (endedBy === 'failed' || outcome.run === undefined) {
    w.accepted('running');
  } else {
    w.accepted(deriveRunPhase(outcome.run), applied);
  }
  w.logger.info('webhook: wait ended', {
    run_id: w.runId,
    ended_by: endedBy,
    waited_ms: outcome.waitedMs,
  });
}
