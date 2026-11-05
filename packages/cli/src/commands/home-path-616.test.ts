// home-path-616.test.ts — issue #616 PR-2a, unit (i): a home that cannot be used stops the command, on
// the BUILT CLI. With HOME set but empty, Node answers `''` for the home, and realm used to keep its
// runs in a `.realm` folder under the current directory (`realm run list` made `.realm/runs` there).
// Now every command that opens its stores stops with one line before it opens anything: `Error: …`
// through the entry's one handler (`lib/expected-refusal.ts`), or `realm mcp: …` / `realm serve: …`
// from those hosts' own handler; exit 1, no stack, nothing created. The function's other states (no
// home at all, a relative HOME, a program's home) are pinned in core's realm-home.test.ts.
//
// Each child runs in a fresh scratch folder (also its working directory), with an environment of PATH
// and an empty HOME only, and stdin closed. Every assertion says (1) the line whose break turns it red
// and (2) what it prints when it fails: the exit code, stdout and stderr, the scratch folder written
// `<dir>`, and what the child created there.
import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const REFUSAL =
  'no home directory: HOME is empty or unset and this account has no home, so realm cannot find ~/.realm. Set HOME to your home directory and run the command again.';
const STACK = /^ {4}at /m;

const scratches: string[] = [];
afterAll(() => {
  for (const dir of scratches) rmSync(dir, { recursive: true, force: true });
});

interface Result {
  code: number | null;
  stdout: string;
  stderr: string;
  /** What the child left in its working directory. */
  created: string[];
  /** Everything above, the scratch folder written `<dir>`: the failure message. */
  shown: string;
}

function realm(args: string[]): Result {
  const dir = mkdtempSync(join(tmpdir(), 'realm-home-616-'));
  scratches.push(dir);
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: dir,
    env: { PATH: process.env['PATH'] ?? '', HOME: '' },
    encoding: 'utf8',
    timeout: 20_000,
    input: '',
  });
  const created = readdirSync(dir);
  const res = { code: r.status, stdout: r.stdout, stderr: r.stderr, created };
  return { ...res, shown: JSON.stringify(res, null, 1).replaceAll(dir, '<dir>') };
}

describe('#616 PR-2a (i) — an empty HOME, on the built CLI', () => {
  it('realm run list: one Error line, exit 1, no stack, no .realm under the current folder', () => {
    const r = realm(['run', 'list']);
    // (1) red when realm-home.ts's empty check is removed (the line then gives the not-absolute
    //     clause) or both its checks are (the listing makes `.realm/runs` here and exits 0), or when
    //     the code leaves the entry's set in expected-refusal.ts (a stack, no `Error:` line);
    // (2) prints the exit code, stdout, stderr and what was created.
    expect(
      {
        code: r.code,
        stdout: r.stdout,
        stderr: r.stderr,
        stack: STACK.test(r.stderr),
        created: r.created,
      },
      r.shown,
    ).toEqual({ code: 1, stdout: '', stderr: `Error: ${REFUSAL}\n`, stack: false, created: [] });
  }, 20_000);

  it('realm mcp and realm serve --dev print it in their own shape, exit 1, nothing listening', () => {
    // Without --dev, serve stops at its token check first; with it, its dev warning comes first.
    const mcp = realm(['mcp']);
    const serve = realm(['serve', '--dev', '--port', '0']);
    // (1) red when mcp.ts builds its registry outside its try again (the line becomes `Error: …`), or
    //     a host's catch stops printing the refusal (a stack); `serve` listening would print its
    //     `listening on` line on stdout and run until the timeout (code null);
    // (2) prints each child's exit code, stdout, stderr and what it created.
    expect(
      {
        mcp: [mcp.code, mcp.stdout, mcp.stderr, mcp.created],
        serve: [serve.code, serve.stdout, serve.stderr, serve.created],
      },
      `${mcp.shown}\n${serve.shown}`,
    ).toEqual({
      mcp: [1, '', `realm mcp: ${REFUSAL}\n`, []],
      serve: [
        1,
        '',
        `Warning: Running in dev mode — authentication is disabled. Do not expose this to a network.\nrealm serve: ${REFUSAL}\n`,
        [],
      ],
    });
  }, 30_000);

  it('realm mcp --check and realm serve --check: the value line, then the Error line, exit 1', () => {
    const doors = ['mcp', 'serve'].map((door) => realm([door, '--check']));
    // (1) red when separation-check.ts's store path stops coming from realmHomePath() (the check then
    //     runs and prints `Separation: …` on stdout, exit 0), or the value line stops coming first;
    // (2) prints each door's exit code, stdout, stderr and what it created.
    expect(
      doors.map((r) => ({
        code: r.code,
        stdoutLines: r.stdout.split('\n').filter((l) => l !== '').length,
        valueLine: r.stdout.startsWith('Gate answers over MCP: asked (from the default)'),
        stderr: r.stderr,
        created: r.created,
      })),
      doors.map((r) => r.shown).join('\n'),
    ).toEqual(
      ['mcp', 'serve'].map(() => ({
        code: 1,
        stdoutLines: 1,
        valueLine: true,
        stderr: `Error: ${REFUSAL}\n`,
        created: [],
      })),
    );
  }, 60_000);
});

// The words a user reads about it. Each pin names the cells that execute its claims.
const flat = (t: string): string => t.replace(/\s+/g, ' ');
const read = (page: string): string => readFileSync(join(ROOT, page), 'utf8');
function claim(page: string, sentence: string): void {
  // (1) red when the page no longer holds the sentence word for word; (2) prints the page and the
  //     sentence.
  expect(flat(read(page)), `${page} no longer says: ${sentence}`).toContain(flat(sentence));
}

describe('#616 PR-2a (i) — the docs', () => {
  it('error-codes.md: STATE_HOME_UNUSABLE', () => {
    // Executed: this file's empty-HOME cells (the command stops before anything is opened); core's
    // realm-home.test.ts (no home directory; HOME, or a program's home, not an absolute path).
    claim(
      'docs/reference/error-codes.md',
      '| `STATE_HOME_UNUSABLE` | The home realm would use cannot be used: HOME is empty, or the account has no home directory, or HOME, or a home a program gave the opener, is not an absolute path. The command stops before anything is opened; set HOME to an absolute path, or pass one. Added after version 0.48.0. | `report_to_user` | No |',
    );
  });

  it('environment-and-files.md: the HOME row', () => {
    // Executed: "never at start" — the three #285 cells (lazy-home-resolution-285.test.ts in core and
    // the CLI); the stop and its two shapes — this file's empty-HOME cells and core's realm-home.test.ts
    // (no home, not absolute); the two `--check` doors reading it — this file's `--check` cell. The
    // sudo sentence is sudoers(5)'s, not a realm behaviour.
    claim(
      'docs/reference/environment-and-files.md',
      "| `HOME` | Every command that opens its stores, and `realm mcp --check` / `realm serve --check` | The home folder. `~/.realm` is inside it. Read when a command opens its stores, never at start. Empty, not an absolute path, or absent on an account with no home: the command stops with `Error: no home directory: …` (`realm mcp` and `realm serve` print it as `realm mcp: no home directory: …`; the code is `STATE_HOME_UNUSABLE`). Under `sudo`, HOME is what your sudoers passes on — root's on a stock Linux (`env_reset`), the invoking user's where `HOME` is in `env_keep`; `sudo -H` always makes it root's. |",
    );
  });

  it('the CHANGELOG entry', () => {
    // Executed: this file's `realm run list` cell (stops, nothing under the current folder); core's
    // realm-home.test.ts (no home: the same line, no stack); the one call — its A1 scan.
    // #871's form: `[Unreleased]` until a release renames it, then the first section above [0.48.0].
    const text = read('CHANGELOG.md');
    const start = text.includes('## [Unreleased]')
      ? text.indexOf('## [Unreleased]')
      : text.indexOf('\n## [') + 1;
    const section = text.slice(start, text.indexOf('\n## [0.48.0]'));
    const sentence =
      "**One function in core names realm's home (`~/.realm`, read when a command opens its stores) (issue #616).** A command run with `HOME` empty or not absolute now stops with one line instead of keeping its runs under the current folder; one run on an account with no home stops with the same line instead of a stack.";
    // (1) red when the [Unreleased] section no longer holds the entry; (2) prints the sentence.
    expect(flat(section), `the CHANGELOG no longer says: ${sentence}`).toContain(flat(sentence));
  });
});
