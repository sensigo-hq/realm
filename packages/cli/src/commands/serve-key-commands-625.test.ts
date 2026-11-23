// serve-key-commands-625.test.ts — #625 PR-2b, named keys unit 1: `realm serve key add | list |
// remove`, the commands that give each caller of `realm serve` its own key (prompt
// feat-625-named-keys-unit1.md rev 4, checks 1, 10, 11's command cells, 12, 14 and 16).
//
// Through the built `realm` (a child with a fresh HOME) where a cell reads what a person sees: the
// key on stdout, the refusals, the file left behind. Through the command bodies (`serveKeyAdd`,
// `serveKeyRemove`, as `realm callback key`'s cells call `callbackKey`) where a cell must stand
// between a command and the lock. Every assertion carries (1) the break that turns it red and (2)
// what it prints when it fails: the lines, the exit code, the file's fingerprint or mode, never a
// key's text.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command, CommanderError } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { takeServeKeysLock } from '@sensigo/realm-store-sqlite';
import { buildRealmProgram, topLevelCommands } from '../commands-registry.js';
import { openCliHome } from '../lib/home.js';
import { serveKeysPath } from '../lib/serve-keys.js';
import { serveKeyAdd, serveKeyRemove, type ServeKeyDeps } from './serve-key.js';
import { makeServeCommand } from './serve.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', '..', 'dist', 'index.js');

let root: string;
let home: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'realm-nk1-cmd-'));
  home = join(root, '.realm');
});
afterEach(() => {
  try {
    chmodSync(home, 0o700);
  } catch {
    // No home was made.
  }
  rmSync(root, { recursive: true, force: true });
});

/** Runs the built `realm` with this cell's HOME and nothing else of the environment. */
function realm(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    env: { PATH: process.env['PATH'] ?? '', HOME: root },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** The key file's SHA-256 (or `absent`), to say whether a command changed it. */
function fileState(): string {
  const path = serveKeysPath(home);
  return existsSync(path)
    ? createHash('sha256').update(readFileSync(path)).digest('hex')
    : 'absent';
}

/** Every file under `dir`, recursively. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)],
  );
}

const FILE = (): string => serveKeysPath(home);
const NAME_RULE =
  "is not a key name: use 1 to 64 characters from a-z, 0-9, '.', '_' and '-', starting with a letter or a digit. No key was changed.";

describe('check 1 — add prints the key once and stores only its hash', () => {
  it('stdout is the key and one newline; no file under the home holds its text; the file is 0600', () => {
    const r = realm('serve', 'key', 'add', 'ana-laptop');
    // (1) red when add prints anything else on stdout, or fails; (2) prints the exit code, stderr
    //     and stdout's length and shape, never the key.
    expect({
      status: r.status,
      shape: /^realm_key_[0-9a-f]{64}\n$/.test(r.stdout),
      length: r.stdout.length,
    }).toEqual({ status: 0, shape: true, length: 75 });
    const key = r.stdout.trimEnd();
    const secret = key.slice('realm_key_'.length);
    // Every file the command left under the home, realm.db included: none holds the key's text.
    const holding = filesUnder(home).filter((f) => {
      const bytes = readFileSync(f);
      return bytes.includes(key) || bytes.includes(secret);
    });
    // (1) red when the key's text is written into the entry (or any file); (2) prints the paths.
    expect(holding).toEqual([]);
    // (1) red when the file is written with the default mode; (2) prints the mode.
    expect((statSync(FILE()).mode & 0o777).toString(8)).toBe('600');
    // The file holds the key's SHA-256 under its name.
    const entry = (
      JSON.parse(readFileSync(FILE(), 'utf8')) as { keys: Array<{ name: string; sha256: string }> }
    ).keys[0];
    // (1) red when the stored fingerprint is not the key's SHA-256; (2) prints the entry's name.
    expect({
      name: entry?.name,
      matches: entry?.sha256 === createHash('sha256').update(key).digest('hex'),
    }).toEqual({ name: 'ana-laptop', matches: true });
  }, 60_000);
});

/** The command bodies' collaborators on this cell's home, the lock as `takeLock` gives it. */
function depsWith(takeLock: ServeKeyDeps['takeLock']): ServeKeyDeps {
  return { home: () => home, openHome: () => openCliHome({ home }), takeLock };
}

describe('check 10 — two key commands at once lose no change', () => {
  it('(a) while the lock is held, a second command waits, then refuses with the lock words; the file is unchanged', async () => {
    expect(realm('serve', 'key', 'add', 'a').status).toBe(0);
    const before = fileState();
    const held = await takeServeKeysLock(home);
    if (!('taken' in held))
      throw new Error(`the test could not take the lock: ${JSON.stringify(held)}`);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const code = await serveKeyAdd(
        'b',
        undefined,
        depsWith((h) => takeServeKeysLock(h, { ticks: 4, tickMs: 25 })),
      );
      // (1) red when add writes without the lock (it would succeed); (2) prints the code and lines.
      expect({
        code,
        lines: err.mock.calls.map((c) => String(c[0])),
        printed: out.mock.calls.length,
      }).toEqual({
        code: 1,
        lines: [
          `Error: another 'realm serve key' command is changing ${FILE()}. No key was changed. Try again.`,
        ],
        printed: 0,
      });
    } finally {
      err.mockRestore();
      out.mockRestore();
      held.taken.release();
    }
    // (1) red when the file was written; (2) prints both fingerprints.
    expect(fileState()).toBe(before);
  }, 60_000);

  /** Starts `run` with a lock wait the test can see begin, holding the lock meanwhile. */
  async function race(
    run: (deps: ServeKeyDeps) => Promise<0 | 1>,
    writeA: () => void,
  ): Promise<0 | 1> {
    const held = await takeServeKeysLock(home);
    if (!('taken' in held))
      throw new Error(`the test could not take the lock: ${JSON.stringify(held)}`);
    let reached!: () => void;
    const waiting = new Promise<void>((r) => (reached = r));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const done = run(
        depsWith((h) => {
          reached();
          return takeServeKeysLock(h);
        }),
      );
      await waiting;
      // While the command waits, and the test still holds the lock, another writer adds `a`.
      writeA();
      held.taken.release();
      return await done;
    } finally {
      err.mockRestore();
      out.mockRestore();
    }
  }

  /** The key file's text with one more entry, as a command that held the lock would write it. */
  function withEntry(name: string): () => void {
    return () => {
      const file = JSON.parse(readFileSync(FILE(), 'utf8')) as { format: 1; keys: unknown[] };
      file.keys.push({
        name,
        sha256: createHash('sha256').update(`realm_key_${name}`).digest('hex'),
        created_at: '2026-11-22T10:00:00.000Z',
        expires_at: null,
      });
      writeFileSync(FILE(), `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    };
  }

  const names = (): string[] =>
    (JSON.parse(readFileSync(FILE(), 'utf8')) as { keys: Array<{ name: string }> }).keys
      .map((k) => k.name)
      .sort();

  it('(b) add b waits while another writer adds a under the lock; afterwards both are there', async () => {
    expect(realm('serve', 'key', 'add', 'c').status).toBe(0);
    const code = await race((deps) => serveKeyAdd('b', undefined, deps), withEntry('a'));
    // (1) red when add reads the file before it takes the lock (it writes c and b, losing a);
    //     (2) prints the code and the names in the file.
    expect({ code, names: names() }).toEqual({ code: 0, names: ['a', 'b', 'c'] });
  }, 60_000);

  it('(b) remove c waits while another writer adds a under the lock; afterwards c is gone and a is there', async () => {
    expect(realm('serve', 'key', 'add', 'c').status).toBe(0);
    const code = await race((deps) => serveKeyRemove('c', deps), withEntry('a'));
    // (1) red when remove reads the file before it takes the lock (it writes no key, losing a);
    //     (2) prints the code and the names in the file.
    expect({ code, names: names() }).toEqual({ code: 0, names: ['a'] });
  }, 60_000);
});

describe('check 11 — the mode warning, on a key command (list and add)', () => {
  it('list on a 0644 file prints the house warning once', () => {
    expect(realm('serve', 'key', 'add', 'ana').status).toBe(0);
    chmodSync(FILE(), 0o644);
    const r = realm('serve', 'key', 'list');
    const warnings = r.stderr.split('\n').filter((l) => l.startsWith('Warning:'));
    // (1) red when the mode check is dropped; (2) prints the exit code and the warning lines.
    expect({ status: r.status, warnings }).toEqual({
      status: 0,
      warnings: [
        `Warning: ${FILE()} is open to other users (mode 0644). Fix that with: chmod 600 ${FILE()}`,
      ],
    });
  }, 60_000);

  it('add on a 0644 file succeeds, leaves the file at 0600, and prints no mode warning (MA 2, 2026-11-22)', () => {
    expect(realm('serve', 'key', 'add', 'ana').status).toBe(0);
    chmodSync(FILE(), 0o644);
    const r = realm('serve', 'key', 'add', 'bob');
    // (1) red when add prints the warning from the mode read before the change, or leaves the mode;
    //     (2) prints the exit code, the mode and every Warning line.
    expect({
      status: r.status,
      mode: (statSync(FILE()).mode & 0o777).toString(8),
      warnings: r.stderr.split('\n').filter((l) => l.startsWith('Warning:')),
    }).toEqual({ status: 0, mode: '600', warnings: [] });
  }, 60_000);
});

describe("check 12 — realm-cloud's list of commands is unchanged", () => {
  it('two programs build in one process; the shared serve has no key; a cli-cloud program refuses serve key list', () => {
    const previous = process.env['HOME'];
    process.env['HOME'] = root;
    try {
      // (1) red when key is added to the shared instance: the second build throws (commander refuses a
      //     second `key` on one object); (2) prints the error.
      expect(() => {
        buildRealmProgram();
        buildRealmProgram();
      }).not.toThrow();
      const shared = topLevelCommands.find((c) => c.name() === 'serve')!;
      // (1) red when the shared serve carries key; (2) prints its subcommands' names.
      expect(shared.commands.map((c) => c.name())).toEqual([]);
      // A program built as realm-cloud's CLI builds it (cli-cloud/src/index.ts:35): it adds the shared
      // objects of topLevelCommands itself.
      const cloud = new Command('realm-cloud').exitOverride();
      for (const cmd of topLevelCommands) cloud.addCommand(cmd);
      shared.exitOverride();
      const silence = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      let refused: unknown;
      try {
        cloud.parse(['node', 'realm-cloud', 'serve', 'key', 'list']);
      } catch (err) {
        refused = err;
      } finally {
        silence.mockRestore();
      }
      // (1) red when the shared serve runs `key list`; (2) prints what was thrown and whether the
      //     command made a home.
      expect({
        code: refused instanceof CommanderError ? refused.code : String(refused),
        madeHome: existsSync(home),
      }).toEqual({ code: 'commander.excessArguments', madeHome: false });
    } finally {
      process.env['HOME'] = previous;
    }
  });

  it("the shared serve's start refusal names no command it lacks; realm's own names realm serve key add (UNIT-1B-UPDATES item 2)", async () => {
    const saved = {
      HOME: process.env['HOME'],
      REALM_SERVE_TOKEN: process.env['REALM_SERVE_TOKEN'],
      REALM_DEV: process.env['REALM_DEV'],
    };
    process.env['HOME'] = root;
    delete process.env['REALM_SERVE_TOKEN'];
    delete process.env['REALM_DEV'];
    /** The refusal an instance prints with no token and no key file: its stderr lines and exit code. */
    const refusal = async (cmd: Command): Promise<{ lines: string[]; exit: unknown }> => {
      const lines: string[] = [];
      const error = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
        lines.push(a.map(String).join(' '));
      });
      const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
        throw new Error(`exit ${String(code)}`);
      }) as never);
      let thrown: unknown;
      try {
        await cmd.exitOverride().parseAsync(['--project', root], { from: 'user' });
      } catch (err) {
        thrown = err instanceof Error ? err.message : err;
      } finally {
        error.mockRestore();
        exit.mockRestore();
      }
      return { lines: lines.join('\n').split('\n'), exit: thrown };
    };
    try {
      const shared = await refusal(makeServeCommand());
      const own = await refusal(makeServeCommand({ keys: true }));
      // (1) red when both instances print one line (the shared one naming `realm serve key add`,
      //     which realm-cloud's CLI does not have, or realm's own not naming it), or either starts;
      //     (2) prints both instances' lines and exits.
      expect({ shared, own }).toEqual({
        shared: {
          lines: [
            'Error: REALM_SERVE_TOKEN is not set and there is no named key.',
            'Set it to a secret token, or use --dev / REALM_DEV=1 for local development only.',
          ],
          exit: 'exit 1',
        },
        own: {
          lines: [
            'Error: REALM_SERVE_TOKEN is not set and there is no named key.',
            "Set it to a secret token, add a key with 'realm serve key add <name>', or use --dev / REALM_DEV=1 for local development only.",
          ],
          exit: 'exit 1',
        },
      });
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

describe('check 14 — the name rule', () => {
  it.each([
    ['an empty name', '', "''"],
    ['an upper-case name', 'Ana', "'Ana'"],
    ['a name with a space', 'ana laptop', "'ana laptop'"],
    // MA 2, 2026-11-22: a control character, so a cell can fail for the escape.
    ['a name with a control character', 'a\u001bb', "'a\\u001bb'"],
  ])('%s is refused, escaped, and nothing changes', async (_label, name, shown) => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    let code: 0 | 1;
    let printed: string[];
    try {
      code = await serveKeyAdd(
        name,
        undefined,
        depsWith((h) => takeServeKeysLock(h)),
      );
      printed = err.mock.calls.map((c) => JSON.stringify(String(c[0])));
    } finally {
      err.mockRestore();
    }
    // (1) red when any name is accepted, or the name is printed raw; (2) prints the code and lines,
    //     the name as JSON.
    expect({ code, lines: printed }).toEqual({
      code: 1,
      lines: [JSON.stringify(`Error: ${shown} ${NAME_RULE}`)],
    });
    // (1) red when the refused command made the home or the file; (2) prints what it made.
    expect({ home: existsSync(home), file: fileState() }).toEqual({ home: false, file: 'absent' });
  });
});

describe('check 16 — the lock cannot be opened (MA 2, 2026-11-22)', () => {
  it('remove on a home Realm cannot write to refuses with the lock words, exit 1, the file unchanged', () => {
    if (process.getuid?.() === 0) return; // root writes through a 0500 folder
    expect(realm('serve', 'key', 'add', 'a').status).toBe(0);
    rmSync(join(home, 'serve-keys.lock'), { force: true });
    const before = fileState();
    chmodSync(home, 0o500);
    const r = realm('serve', 'key', 'remove', 'a');
    chmodSync(home, 0o700);
    // (1) red when the open error reaches the generic handler (other words, or another code);
    //     (2) prints the exit code and stderr.
    expect({ status: r.status, stderr: r.stderr }).toEqual({
      status: 1,
      stderr: `Error: ${join(home, 'serve-keys.lock')} cannot be opened (SQLITE_CANTOPEN). No key was changed.\n`,
    });
    // (1) red when the file was changed; (2) prints both fingerprints.
    expect(fileState()).toBe(before);
  }, 60_000);
});

describe('list and remove, their words', () => {
  it('list with no key file says there are none and how to add one', () => {
    const r = realm('serve', 'key', 'list');
    // (1) red when the none-line changes or goes to stderr; (2) prints the code and both streams.
    expect(r).toEqual({
      status: 0,
      stdout: "No named keys. Add one with 'realm serve key add <name>'.\n",
      stderr: '',
    });
  }, 60_000);

  it('remove with no home folder refuses with the unknown-name words and makes nothing', () => {
    const r = realm('serve', 'key', 'remove', 'ana');
    // (1) red when remove takes a lock or makes the home first; (2) prints the code, stderr, and
    //     whether the home was made.
    expect({ ...r, madeHome: existsSync(home) }).toEqual({
      status: 1,
      stdout: '',
      stderr:
        "Error: no key named 'ana'. No key was changed. See the keys with 'realm serve key list'.\n",
      madeHome: false,
    });
  }, 60_000);
});
