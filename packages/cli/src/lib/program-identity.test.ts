// program-identity.test.ts — issue #625 (the holder slice, PR-H): the CLI helper that makes a drive
// command's identity ONCE. It is the only CLI file that reads the OS user; core's composer is pure.
//
// The OS facts are mocked at `node:os` so each cell chooses what the machine "says"; the environment
// variable is set and restored per cell. Each assertion carries (a) the change that turns it red and
// (b) what it prints on failure — a synthetic name only, never a real user or host.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const os = vi.hoisted(() => ({
  userInfo: vi.fn(),
  hostname: vi.fn(),
}));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, userInfo: os.userInfo, hostname: os.hostname };
});

import { resolveProgramIdentity } from './program-identity.js';

let saved: string | undefined;
let errSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  saved = process.env['REALM_OPERATOR'];
  delete process.env['REALM_OPERATOR'];
  os.userInfo.mockReset();
  os.hostname.mockReset();
  os.userInfo.mockReturnValue({ username: 'carol' });
  os.hostname.mockReturnValue('box');
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`exit ${String(code)}`);
  }) as never);
});
afterEach(() => {
  if (saved === undefined) delete process.env['REALM_OPERATOR'];
  else process.env['REALM_OPERATOR'] = saved;
  vi.restoreAllMocks();
});

const printed = (): string[] => errSpy.mock.calls.map((c: unknown[]) => String(c[0]));

describe('resolveProgramIdentity', () => {
  it('REALM_OPERATOR set ⇒ the ambient name, on the channel the command gave', () => {
    process.env['REALM_OPERATOR'] = 'nightly-batch';
    // (a) red when the variable is ignored or the class is wrong; (b) prints the identity.
    expect(resolveProgramIdentity('agent')).toEqual({
      by: 'nightly-batch',
      by_source: 'ambient',
      channel: 'agent',
    });
    expect(printed()).toEqual([]);
  });

  it('REALM_OPERATOR unset ⇒ the OS user and host name, derived', () => {
    expect(resolveProgramIdentity('run')).toEqual({
      by: 'carol@box',
      by_source: 'derived',
      channel: 'run',
    });
  });

  it('REALM_OPERATOR empty or only whitespace ⇒ not set (the derived name is used)', () => {
    process.env['REALM_OPERATOR'] = '   ';
    expect(resolveProgramIdentity('run')?.by).toBe('carol@box');
  });

  it.each([
    ['a control character', '\u001b[2J', 'contains a control character'],
    ['more than 200 characters', 'x'.repeat(201), 'longer than 200 characters'],
  ])(
    'REALM_OPERATOR with %s ⇒ ONE line on stderr naming the variable, then exit 1 — never a stack',
    (_l, value, reason) => {
      process.env['REALM_OPERATOR'] = value;
      expect(() => resolveProgramIdentity('agent')).toThrow('exit 1');
      expect(exitSpy).toHaveBeenCalledWith(1);
      // (a) red when the refusal line changes wording, goes to stdout, or gains a second line;
      //     (b) prints the lines.
      expect(printed()).toEqual([
        `REALM_OPERATOR: ${reason}; nothing was started. Unset it or give it a name of at most 200 characters with no control characters.`,
      ]);
    },
  );

  it('the consequence clause is the CALLER’S: `respond` records nothing, it starts nothing', () => {
    process.env['REALM_OPERATOR'] = 'x'.repeat(201);
    expect(() => resolveProgramIdentity('respond', 'nothing was recorded')).toThrow('exit 1');
    expect(printed()[0]).toContain('; nothing was recorded.');
  });

  it('the OS user cannot be read ⇒ one notice, the command runs, no name is recorded', () => {
    os.userInfo.mockImplementation(() => {
      throw new Error('no passwd entry');
    });
    expect(resolveProgramIdentity('agent')).toBeUndefined();
    expect(printed()).toEqual([
      "this program's name cannot be recorded on the steps it takes: the OS user name is not known",
    ]);
  });

  it('the host name cannot be read ⇒ one notice, no name', () => {
    os.hostname.mockImplementation(() => {
      throw new Error('no hostname');
    });
    expect(resolveProgramIdentity('agent')).toBeUndefined();
    expect(printed()).toEqual([
      "this program's name cannot be recorded on the steps it takes: the host name is not known",
    ]);
  });

  it('neither is known and no REALM_OPERATOR ⇒ no name and NO notice (nothing was attempted)', () => {
    os.userInfo.mockImplementation(() => {
      throw new Error('x');
    });
    os.hostname.mockImplementation(() => {
      throw new Error('x');
    });
    expect(resolveProgramIdentity('agent')).toBeUndefined();
    expect(printed()).toEqual([]);
  });

  it('REALM_OPERATOR wins even when the OS facts cannot be read', () => {
    process.env['REALM_OPERATOR'] = 'ops';
    os.userInfo.mockImplementation(() => {
      throw new Error('x');
    });
    expect(resolveProgramIdentity('mcp-stdio')).toEqual({
      by: 'ops',
      by_source: 'ambient',
      channel: 'mcp-stdio',
    });
  });
});
