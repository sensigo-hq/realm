// realm-home.test.ts — issue #616 PR-2a, unit (i): realm's home comes from one function, and a home
// that cannot be used is refused with `STATE_HOME_UNUSABLE`. The built CLI's lines are pinned in
// packages/cli/src/commands/home-path-616.test.ts; the call-time reading is the three #285 cells
// (core's and the CLI's lazy-home-resolution-285.test.ts), not repeated here.
//
// Every assertion says (1) the line whose break turns it red and (2) what it prints when it fails.
// The HOME values here are fakes (`rel`, `~`, a blank, a temp folder); nothing prints an environment.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realmHomePath } from './realm-home.js';

// The system's answer, passed through to the real function unless a cell makes it throw.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: vi.fn(actual.homedir) };
});

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const REMEDY = 'Set HOME to your home directory and run the command again.';
const NO_HOME = `no home directory: HOME is empty or unset and this account has no home, so realm cannot find ~/.realm. ${REMEDY}`;
const NOT_ABSOLUTE = `no home directory: HOME is not an absolute path, so realm cannot find ~/.realm. ${REMEDY}`;

const savedHome = process.env['HOME'];
afterEach(() => {
  if (savedHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = savedHome;
  // Back to the real function (vitest's mockReset restores the implementation given to vi.fn).
  vi.mocked(homedir).mockReset();
});

/** What a call gives: the path, or the thrown error's name, code and message. */
function outcome(
  home?: string,
): { path: string } | { name: string; code: unknown; message: string } {
  try {
    return { path: realmHomePath(home) };
  } catch (err) {
    const e = err as Error & { code?: unknown };
    return { name: e.name, code: e.code, message: e.message };
  }
}

describe('#616 PR-2a (i) — the one place that asks the system for the home', () => {
  it('A1: exactly one call to homedir( in realm source, in realm-home.ts', () => {
    // Every package's src, every .ts file but tests and type declarations; comment and JSDoc lines
    // are skipped, and a property read (`info.homedir`) is not a call.
    const scanned: string[] = [];
    const calls: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          if (name !== 'node_modules' && name !== 'dist') walk(path);
        } else if (/\.ts$/.test(name) && !/\.(test|d)\.ts$/.test(name)) {
          const file = relative(ROOT, path).split(sep).join('/');
          scanned.push(file);
          readFileSync(path, 'utf8')
            .split('\n')
            .forEach((line, i) => {
              const code = line.trim();
              if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) return;
              if (/\bhomedir\s*\(/.test(line)) calls.push(`${file}:${i + 1}: ${code}`);
            });
        }
      }
    };
    for (const pkg of readdirSync(join(ROOT, 'packages'))) {
      const src = join(ROOT, 'packages', pkg, 'src');
      if (statSync(src, { throwIfNoEntry: false })?.isDirectory() === true) walk(src);
    }
    // (1) red when any source file calls homedir( again — the break: restore one of the six old
    //     spellings, e.g. listen.ts's `join(homedir(), '.realm', 'dedup')`; and red when the scan
    //     stops reading the files that held them (`files`: the walk's own denominator).
    // (2) prints every call found, as file:line: text, and which of the six files the walk read.
    const FORMER = [
      'packages/core/src/store/json-file-store.ts',
      'packages/core/src/workflow/registrar.ts',
      'packages/cli/src/store/replay-store.ts',
      'packages/cli/src/commands/listen.ts',
      'packages/cli/src/commands/migrate.ts',
      'packages/cli/src/lib/separation-check.ts',
    ];
    const seen = { calls, files: FORMER.filter((f) => scanned.includes(f)) };
    expect(seen, JSON.stringify(seen, null, 1)).toEqual({
      calls: [expect.stringMatching(/^packages\/core\/src\/store\/realm-home\.ts:\d+: /)],
      files: FORMER,
    });
  });

  it('no home at all: the system lookup throws, the function refuses with the one line', () => {
    // Node's own error for no HOME and no account entry, captured on Node 24.21.0 in a user
    // namespace with an unknown uid (`unshare --user --map-user=54321 env -i node -e …`; registry
    // row AUDI-05 and the unit's verify-first probe V15) — copied field for field.
    const systemError = Object.assign(
      new Error(
        'A system error occurred: uv_os_homedir returned ENOENT (no such file or directory)',
      ),
      {
        name: 'SystemError',
        code: 'ERR_SYSTEM_ERROR',
        info: {
          errno: -2,
          code: 'ENOENT',
          message: 'no such file or directory',
          syscall: 'uv_os_homedir',
        },
        errno: -2,
        syscall: 'uv_os_homedir',
      },
    );
    vi.mocked(homedir).mockImplementationOnce(() => {
      throw systemError;
    });
    const got = outcome();
    // (1) red when realm-home.ts's catch around homedir() is removed (the SystemError escapes: name
    //     SystemError, code ERR_SYSTEM_ERROR), or the code or the words change;
    // (2) prints the name, code and message that came out.
    expect(got, JSON.stringify(got)).toEqual({
      name: 'WorkflowError',
      code: 'STATE_HOME_UNUSABLE',
      message: NO_HOME,
    });
  });

  it('a HOME that is not an absolute path (rel, ~, a blank): refused, the value never shown', () => {
    const got = ['rel', '~', ' '].map((value) => {
      process.env['HOME'] = value;
      return outcome();
    });
    const refused = { code: 'STATE_HOME_UNUSABLE', name: 'WorkflowError', message: NOT_ABSOLUTE };
    // (1) red when realm-home.ts's isAbsolute check on the system's answer is removed (each returns
    //     a path such as `rel/.realm`), or its words take the value in;
    // (2) prints what each of the three gave.
    expect(got, JSON.stringify(got)).toEqual([refused, refused, refused]);
  });

  it('a home a program passes: a relative one is refused naming it; an absolute one is used as given', () => {
    const got = { relative: outcome('rel'), absolute: outcome('/srv/realm-home') };
    // (1) red when realm-home.ts's isAbsolute check on the argument is removed (`relative` returns
    //     the path `rel`), or when the argument is not returned as given (`absolute` would change,
    //     e.g. to `/srv/realm-home/.realm`);
    // (2) prints both outcomes.
    expect(got, JSON.stringify(got)).toEqual({
      relative: {
        name: 'WorkflowError',
        code: 'STATE_HOME_UNUSABLE',
        message: "the home must be an absolute path, got 'rel'",
      },
      absolute: { path: '/srv/realm-home' },
    });
  });
});
