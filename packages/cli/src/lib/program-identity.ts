// The host PROGRAM's name for the claims it takes and the evidence it writes (issue #625, the holder
// slice). One helper for every drive command of this package, and the ONLY file here that reads the
// OS user: core reads no environment variable and no OS fact — a host reads its own and calls core's
// pure composer.
//
// `REALM_OPERATOR`, when set, names whoever operates this program; otherwise the name is the OS user
// and host name. It labels the steps this program TAKES (and the cleanup steps it drains) — never the
// person who answered a question.
import { hostname, userInfo } from 'node:os';
import { composeProgramIdentity, identityRefusalLine, type Attributed } from '@sensigo/realm';
import { exitProcess } from '../output/writer.js';

/**
 * #627 W (§5.9): the OS login this process runs as — its name, uid and passwd home — for the
 * separation check, which measures that login's reach. The home is the login's own (correction 1 D4:
 * the agent-scoped paths are read from it, never from `$HOME`, which may point at Realm's store).
 * Read here, the one file of this package that reads the OS user. `undefined` when the OS will not say.
 */
export function osLogin(): { name: string; uid: number; home: string } | undefined {
  try {
    const info = userInfo();
    return { name: info.username, uid: info.uid, home: info.homedir };
  } catch {
    return undefined;
  }
}

/**
 * Makes this program's identity once, for `channel` (a short word naming the command: `agent`,
 * `run`, `mcp-stdio`, `mcp-http`, `respond`, `drain`, `abandon`, `cleanup`).
 *
 *  - A name that cannot be USED (`REALM_OPERATOR` is over-long or carries a control character)
 *    prints ONE line to stderr and exits 1 before any other output — never a stack, never a
 *    half-started command. `consequence` is the clause after the reason: `nothing was started` for
 *    a command that drives, `nothing was recorded` for `respond`.
 *  - A name that merely cannot be DERIVED prints one notice and returns `undefined`: the program
 *    runs, and what it writes simply names no program.
 */
export function resolveProgramIdentity(
  channel: string,
  consequence: string = 'nothing was started',
): Attributed | undefined {
  try {
    const composed = composeProgramIdentity(identityFacts(), channel);
    if (composed.driver === undefined && composed.reason !== undefined) {
      console.error(
        `this program's name cannot be recorded on the steps it takes: ${composed.reason}`,
      );
    }
    return composed.driver;
  } catch (err) {
    console.error(identityRefusalLine('REALM_OPERATOR', err, consequence));
    // U1b: in a relay's worker its end message goes first; elsewhere `process.exit(1)`.
    exitProcess(1);
  }
}

/** The facts this program's name is made from: `REALM_OPERATOR`, the OS user and the host name. */
function identityFacts(): { ambient?: string; osUser?: string; osHost?: string } {
  let osUser: string | undefined;
  try {
    osUser = userInfo().username;
  } catch {
    osUser = undefined;
  }
  let osHost: string | undefined;
  try {
    osHost = hostname();
  } catch {
    osHost = undefined;
  }
  const ambient = process.env['REALM_OPERATOR'];
  return {
    ...(ambient !== undefined ? { ambient } : {}),
    ...(osUser !== undefined ? { osUser } : {}),
    ...(osHost !== undefined ? { osHost } : {}),
  };
}

/**
 * #625 PR-2b, the actor unit: this program's identity for a command that ENDS runs (`realm run
 * abandon`, `realm run cleanup`), recorded on each run it ends. As {@link resolveProgramIdentity},
 * except that a `REALM_OPERATOR` it cannot use never stops the command: it records no name, does the
 * work as before, and `warning(consequence)` is the one line to print after a write that ended a run
 * (`⚠ REALM_OPERATOR: <reason>; <consequence>. <remedy>`). A name that cannot be derived prints its
 * notice and records none, as there.
 */
export function endingProgramIdentity(channel: string): {
  driver: Attributed | undefined;
  warning?: (consequence: string) => string;
} {
  try {
    const composed = composeProgramIdentity(identityFacts(), channel);
    if (composed.driver === undefined && composed.reason !== undefined) {
      console.error(
        `this program's name cannot be recorded on the runs it ends: ${composed.reason}`,
      );
    }
    return { driver: composed.driver };
  } catch (err) {
    return {
      driver: undefined,
      warning: (consequence) => `⚠ ${identityRefusalLine('REALM_OPERATOR', err, consequence)}`,
    };
  }
}
