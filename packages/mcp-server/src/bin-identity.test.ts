// bin-identity.test.ts — issue #625 (the holder slice, PR-H): the `realm-mcp` bin's own identity,
// with the OS facts and the two sinks injected. (The bin as a process — its channel on a real
// claim and its refusal before the transport opens — is celled in the CLI package's journeys.)
//
// Each assertion carries (a) the change that turns it red and (b) what it prints on failure:
// synthetic names only.
import { describe, it, expect } from 'vitest';
import { composeBinIdentity } from './bin-identity.js';

function harness(over: Parameters<typeof composeBinIdentity>[0] = {}) {
  const written: string[] = [];
  const exits: number[] = [];
  const identity = (() => {
    try {
      return composeBinIdentity({
        osUser: () => 'carol',
        osHost: () => 'box',
        operator: undefined,
        stderr: (t) => written.push(t),
        exit: ((code: number) => {
          exits.push(code);
          throw new Error(`exit ${String(code)}`);
        }) as (code: number) => never,
        ...over,
      });
    } catch (err) {
      if (!(err instanceof Error) || !err.message.startsWith('exit ')) throw err;
      return 'exited' as const;
    }
  })();
  return { identity, written, exits };
}

describe('composeBinIdentity', () => {
  it('REALM_OPERATOR set ⇒ the ambient name on the channel mcp-stdio', () => {
    const { identity, written } = harness({ operator: 'bin-operator' });
    expect(identity).toEqual({ by: 'bin-operator', by_source: 'ambient', channel: 'mcp-stdio' });
    expect(written).toEqual([]);
  });

  it('not set ⇒ the OS user and host name, derived', () => {
    expect(harness().identity).toEqual({
      by: 'carol@box',
      by_source: 'derived',
      channel: 'mcp-stdio',
    });
  });

  it('the OS user cannot be read ⇒ the notice (text pinned), the server runs without a name', () => {
    const { identity, written } = harness({
      osUser: () => {
        throw new Error('no passwd entry');
      },
    });
    expect(identity).toBeUndefined();
    // (a) red when the bin's notice changes wording or goes to stdout; (b) prints the writes.
    expect(written).toEqual([
      "this program's name cannot be recorded on the steps it takes: the OS user name is not known\n",
    ]);
  });

  it('the host name cannot be read ⇒ the notice (text pinned)', () => {
    const { written } = harness({
      osHost: () => {
        throw new Error('no hostname');
      },
    });
    expect(written).toEqual([
      "this program's name cannot be recorded on the steps it takes: the host name is not known\n",
    ]);
  });

  it('neither is known and no REALM_OPERATOR ⇒ no name and no notice', () => {
    const { identity, written } = harness({
      osUser: () => {
        throw new Error('x');
      },
      osHost: () => {
        throw new Error('x');
      },
    });
    expect(identity).toBeUndefined();
    expect(written).toEqual([]);
  });

  it.each([
    ['a control character', '\u001b[2J', 'contains a control character'],
    ['more than 200 characters', 'x'.repeat(201), 'longer than 200 characters'],
  ])('REALM_OPERATOR with %s ⇒ ONE line, exit 1, nothing started', (_label, value, reason) => {
    const { identity, written, exits } = harness({ operator: value });
    expect(identity).toBe('exited');
    expect(exits).toEqual([1]);
    expect(written).toEqual([
      `REALM_OPERATOR: ${reason}; nothing was started. Unset it or give it a name of at most 200 characters with no control characters.\n`,
    ]);
  });
});
