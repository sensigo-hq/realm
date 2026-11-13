// output/relay.ts — U1b: in log mode `realm agent` runs its drive in a second process, the worker,
// and keeps the first, the relay, to own the piped streams. A program a step's handler starts
// inherits the worker's streams, which are pipes to the relay, so the relay's writer masks every
// byte it prints, as it masks the handler's own prints (U1's pass, with a carry per stream).
//
// - The trigger: only in the realm program (the entry declares itself, `declareRealmProgram`), never
//   in a relay's worker, and only when a stream is not a terminal or the drive prints as a shared
//   log (broadcast). A terminal on both streams with no broadcast runs today's in-process path.
// - The relay holds what only the worker resolves — the declared values, their standings, the
//   manifests' not-secret lists — sent as numbered pieces and acknowledged one by one (`writer.ts`).
//   It opens no store and holds no claim.
// - Signals are forwarded to the worker's process group; the stop signal the sudo way; the worker's
//   status is the relay's (a signal death re-raised).
// - After the worker's exit, the relay waits at most `DRAIN_BOUND_MS` for the pipes to close; past
//   it, it says so in one line and kills the group.
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { writeSync } from 'node:fs';
import type { Readable, Writable } from 'node:stream';
import {
  NOT_BLOCKING_LINE,
  RELAY_CHILD_ENV,
  RELAY_KEY_ENV,
  addDeclaredDisclosure,
  addDeclaredValues,
  flushHeld,
  isRelayWorker,
  noteDeclaredStanding,
  relayReceiptLine,
  setStreamBlocking,
  spanKeyHex,
  writerMode,
  type RelayTally,
} from './writer.js';

/** After the worker's exit, how long the relay waits for its pipes and channel to close. */
export const DRAIN_BOUND_MS = 5000;
/** After the first forwarded signal, how long before the worker's group is killed. */
export const SIGKILL_AFTER_MS = 10_000;

/** The line printed once when a program held the output open past the drain bound. */
export const DRAIN_LINE =
  "A program started by a handler kept the output open after the command's work ended; what it printed after that is not in this log.";

/** The line printed when the worker cannot be started: the drive never runs in-process instead. */
export function spawnFailedLine(err: unknown): string {
  const code =
    err !== null && typeof err === 'object' ? (err as { code?: unknown }).code : undefined;
  return (
    'Error: realm agent could not start the process that runs its drive' +
    ` (${typeof code === 'string' ? code : 'unknown error'}). Nothing was started.`
  );
}

let realmProgram = false;

/** Prompt amendment A1: the realm program's entry says so, once, before it parses. Only then can a
 *  command relay: a host that runs a command in its own process (a test) runs it in-process. */
export function declareRealmProgram(): void {
  realmProgram = true;
}

/** S1: whether this command's drive runs in a worker (evaluated once, before identity or a store). */
export function relayNeeded(): boolean {
  return (
    realmProgram &&
    !isRelayWorker() &&
    (process.stdout.isTTY !== true || process.stderr.isTTY !== true || writerMode() === 'broadcast')
  );
}

/** What the relay uses that a test can replace: the spawn, and the streams it guards. */
export interface RelayDeps {
  spawn: typeof nodeSpawn;
  stdout: Writable;
  stderr: Writable;
}

const realDeps = (): RelayDeps => ({
  spawn: nodeSpawn,
  stdout: process.stdout,
  stderr: process.stderr,
});

/** S1/S2: when the trigger holds, runs the relay, which never returns (it ends the process with the
 *  worker's status); otherwise returns at once. */
export async function relayIfLogged(): Promise<void> {
  if (!relayNeeded()) return;
  await runRelay(realDeps());
}

/** S2–S7: the relay. The promise never resolves: the process ends with the worker's status. */
export function runRelay(deps: RelayDeps): Promise<never> {
  return new Promise<never>(() => {
    startRelay(deps);
  });
}

type EndMessage = { receipt: boolean; tally?: RelayTally };

function startRelay(deps: RelayDeps): void {
  // Constraint 5: the relay's own piped streams are blocking, so its exit completes their writes; a
  // handle without the call (another runtime) refuses, never runs unmasked. A file has no handle.
  for (const stream of [deps.stdout, deps.stderr]) {
    if ((stream as { isTTY?: boolean }).isTTY === true) continue;
    if (setStreamBlocking(stream as never) === 'missing') {
      try {
        writeSync(2, `${NOT_BLOCKING_LINE}\n`);
      } catch {
        // Nothing more can be written.
      }
      process.exit(1);
    }
  }
  const broadcast = writerMode() === 'broadcast';
  const piped = (stream: 'stdout' | 'stderr'): 'pipe' | 'inherit' =>
    process[stream].isTTY !== true || broadcast ? 'pipe' : 'inherit';
  const failed = (err: unknown): never => {
    console.error(spawnFailedLine(err));
    return process.exit(1);
  };

  let child: ChildProcess;
  try {
    child = deps.spawn(
      process.execPath,
      [...process.execArgv.filter((a) => !a.startsWith('--inspect')), ...process.argv.slice(1)],
      {
        stdio: ['inherit', piped('stdout'), piped('stderr'), 'ipc'],
        detached: true,
        env: {
          ...process.env,
          [RELAY_CHILD_ENV]: String(process.pid),
          [RELAY_KEY_ENV]: spanKeyHex(),
        },
      },
    );
  } catch (err) {
    failed(err);
    return;
  }
  let spawned = false;
  child.once('spawn', () => {
    spawned = true;
  });
  // An error after the spawn (a failed send, a failed kill) never ends the relay before the drain.
  child.on('error', (err) => {
    if (!spawned) failed(err);
  });

  const alive = (): boolean =>
    child.pid !== undefined && child.exitCode === null && child.signalCode === null;
  const signalGroup = (signal: NodeJS.Signals): void => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      // The group is gone.
    }
  };
  // The relay's own exit while the worker lives (and only then) ends the worker's group; a program a
  // clean drive left running in the background survives, as today.
  process.once('exit', () => {
    if (alive()) signalGroup('SIGTERM');
  });

  // The declared set the worker resolves, piece by piece, each acknowledged.
  let end: EndMessage | undefined;
  let heardDelta = false;
  child.on('message', (message: unknown) => {
    try {
      const m = message as Record<string, unknown> | null;
      if (m === null || typeof m !== 'object') return;
      if (m['t'] === 'realm-relay-end') {
        end = {
          receipt: m['receipt'] === true,
          ...(m['tally'] !== undefined ? { tally: m['tally'] as RelayTally } : {}),
        };
        return;
      }
      if (m['t'] !== 'realm-relay-delta' || typeof m['seq'] !== 'number') return;
      heardDelta = true;
      const payload = m['payload'] as Record<string, unknown>;
      if (m['kind'] === 'declared') {
        addDeclaredDisclosure(
          payload['declared'] as Record<string, string>,
          (payload['notSecret'] as readonly string[] | null) ?? undefined,
        );
      } else if (m['kind'] === 'values') {
        addDeclaredValues(
          payload['declared'] as Record<string, string>,
          (payload['manifestNotSecret'] as readonly string[] | null) ?? undefined,
        );
      } else if (m['kind'] === 'standing') {
        noteDeclaredStanding(
          payload['path'] as string,
          payload['standing'] as Parameters<typeof noteDeclaredStanding>[1],
        );
      }
      child.send({ t: 'realm-relay-ack', seq: m['seq'] }, undefined, undefined, () => {
        // The worker is gone.
      });
    } catch {
      // A message the relay cannot read changes nothing.
    }
  });

  // Every byte of each piped stream through this process's writer (U1's pass, its carry), with the
  // reader paused while the destination cannot take more (inert while the destination is blocking).
  const relayStream = (source: Readable | null, destination: Writable): void => {
    source?.on('data', (chunk: Buffer) => {
      if (!destination.write(chunk)) {
        source.pause();
        destination.once('drain', () => source.resume());
      }
    });
  };
  relayStream(child.stdout, process.stdout);
  relayStream(child.stderr, process.stderr);

  // S5: signals, as received, to the worker's group; the same signal twice, or 10 s after the first,
  // kills it.
  const received = new Set<NodeJS.Signals>();
  let killTimer: NodeJS.Timeout | undefined;
  const forward = new Map<NodeJS.Signals, () => void>();
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    const handler = (): void => {
      if (received.has(signal)) {
        signalGroup('SIGKILL');
        return;
      }
      received.add(signal);
      signalGroup(signal);
      killTimer ??= setTimeout(() => signalGroup('SIGKILL'), SIGKILL_AFTER_MS);
    };
    forward.set(signal, handler);
    process.on(signal, handler);
  }
  // The stop signal: the worker's group is in its own session, where a terminal's stop signal is
  // discarded, so it is stopped with SIGSTOP; the relay then stops itself with SIGTSTP, so its
  // shell reads the stop as the terminal's (sudo's way). On SIGCONT both resume.
  const onStop = (): void => {
    signalGroup('SIGSTOP');
    process.off('SIGTSTP', onStop);
    process.kill(process.pid, 'SIGTSTP');
  };
  process.on('SIGTSTP', onStop);
  process.on('SIGCONT', () => {
    if (!process.listeners('SIGTSTP').includes(onStop)) process.on('SIGTSTP', onStop);
    signalGroup('SIGCONT');
  });

  // S5–S7: on the worker's exit, the drain (its pipes and channel closing, at most the bound), the
  // held tails, the receipt, then the worker's status.
  let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let drainTimer: NodeJS.Timeout | undefined;
  let finished = false;
  const finish = (): void => {
    if (finished || exited === undefined) return;
    finished = true;
    if (drainTimer !== undefined) clearTimeout(drainTimer);
    flushHeld();
    if (broadcast && (end === undefined || end.receipt)) {
      const line = relayReceiptLine(end?.tally, heardDelta);
      if (line !== undefined) console.error(line);
    }
    flushHeld();
    const { code, signal } = exited;
    if (signal === null) process.exit(code ?? 1);
    const own = forward.get(signal);
    if (own !== undefined) process.off(signal, own);
    if (signal === 'SIGTSTP') process.off('SIGTSTP', onStop);
    process.kill(process.pid, signal);
    // Reached only if the signal did not end this process.
    setTimeout(() => process.exit(1), 1000);
  };
  child.on('exit', (code, signal) => {
    exited = { code, signal };
    if (killTimer !== undefined) clearTimeout(killTimer);
    drainTimer = setTimeout(() => {
      child.stdout?.destroy();
      child.stderr?.destroy();
      console.error(DRAIN_LINE);
      signalGroup('SIGKILL');
      finish();
    }, DRAIN_BOUND_MS);
  });
  child.on('close', finish);
}
