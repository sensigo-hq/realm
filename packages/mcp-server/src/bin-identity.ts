// The `realm-mcp` bin's own program identity (issue #625, the holder slice): `REALM_OPERATOR` if
// set, else the OS user and host name, on the channel `mcp-stdio`. One of the two production places
// that read the OS user (the other is the CLI's helper); core reads none.
//
// A name that cannot be USED prints ONE line to stderr and exits 1 before the transport opens —
// never a stack, never a half-started server. A name that merely cannot be DERIVED prints one notice
// and the server runs without one. The facts and the two sinks are injectable so a test can make
// the OS "say" anything; the defaults are the real ones.
import { hostname, userInfo } from 'node:os';
import { composeProgramIdentity, identityRefusalLine, type Attributed } from '@sensigo/realm';

export interface BinIdentityDeps {
  osUser?: () => string;
  osHost?: () => string;
  /** `process.env.REALM_OPERATOR`. */
  operator?: string | undefined;
  stderr?: (text: string) => void;
  exit?: (code: number) => never;
}

export function composeBinIdentity(deps: BinIdentityDeps = {}): Attributed | undefined {
  const readUser = deps.osUser ?? ((): string => userInfo().username);
  const readHost = deps.osHost ?? ((): string => hostname());
  const operator = 'operator' in deps ? deps.operator : process.env['REALM_OPERATOR'];
  const stderr = deps.stderr ?? ((text: string): void => void process.stderr.write(text));
  const exit = deps.exit ?? ((code: number): never => process.exit(code));
  let osUser: string | undefined;
  try {
    osUser = readUser();
  } catch {
    osUser = undefined;
  }
  let osHost: string | undefined;
  try {
    osHost = readHost();
  } catch {
    osHost = undefined;
  }
  try {
    const composed = composeProgramIdentity(
      {
        ...(operator !== undefined ? { ambient: operator } : {}),
        ...(osUser !== undefined ? { osUser } : {}),
        ...(osHost !== undefined ? { osHost } : {}),
      },
      'mcp-stdio',
    );
    if (composed.driver === undefined && composed.reason !== undefined) {
      stderr(`this program's name cannot be recorded on the steps it takes: ${composed.reason}\n`);
    }
    return composed.driver;
  } catch (err) {
    stderr(`${identityRefusalLine('REALM_OPERATOR', err, 'nothing was started')}\n`);
    return exit(1);
  }
}
