// option-value-guard.test.ts — issue #920, C-1: a word that starts with `-` is refused as the value of
// `--model` on `validate`, `register`, `watch`, `agent` and `listen`. Cells 1–5 run the BUILT `realm`
// (tests run after the build) in a scratch HOME and working folder, with PATH, HOME and
// REALM_NO_NUDGE only; cell 6 parses a command in this process. Each assertion names (a) the change
// that turns it red and (b) what it prints: the command, its exit code and the first line of its
// standard error, scratch paths written `<dir>` — never an environment value.
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command, CommanderError } from 'commander';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attachOptionValueGuard, looksLikeFlag } from './option-value-guard.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST_CLI = join(HERE, '..', '..', 'dist', 'index.js');
const REGISTRY_SOURCE = join(HERE, '..', 'commands-registry.ts');
const ROOT = join(HERE, '..', '..', '..', '..');
const flat = (t: string): string => t.replace(/\s+/g, ' ');
const read = (page: string): string => readFileSync(join(ROOT, page), 'utf8');
/** (a) red when the page no longer holds the text word for word; (b) prints the page and the text. */
function claim(page: string, text: string): void {
  expect(flat(read(page)).includes(flat(text)), `${page} no longer says: ${text}`).toBe(true);
}
/** The CHANGELOG's `[Unreleased]` section (#871's form). */
function unreleased(): string {
  const text = read('CHANGELOG.md');
  return text.slice(text.indexOf('## [Unreleased]'), text.indexOf('\n## [0.48.0]'));
}

let home = '';
let base = '';
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'realm-920-home-'));
  base = mkdtempSync(join(tmpdir(), 'realm-920-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(base, { recursive: true, force: true });
});

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
  /** The command, its exit code and the first line of standard error, scratch paths as `<dir>`. */
  shown: string;
}

/** Runs the built `realm`. A command that would keep running (watch, listen) is killed after
 *  `timeoutMs`: a timeout is a red, never a hang. Standard input is ignored. */
function realm(args: string[], timeoutMs = 20_000): Run {
  const r = spawnSync(process.execPath, [DIST_CLI, ...args], {
    cwd: base,
    env: { PATH: process.env['PATH'] ?? '', HOME: home, REALM_NO_NUDGE: '1' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
  });
  const first = (r.stderr ?? '').split('\n')[0] ?? '';
  const hide = (t: string): string => t.split(base).join('<dir>').split(home).join('<home>');
  return {
    code: r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    shown: `realm ${hide(args.join(' '))} → exit ${String(r.status)}${r.signal ? ` (${r.signal})` : ''}: ${hide(first)}`,
  };
}

/** A project folder holding one workflow whose only agent step has `retry` (it warns). */
function retryProject(): string {
  const dir = join(base, 'proj');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{}\n');
  writeFileSync(
    join(dir, 'workflow.yaml'),
    'id: retried\nname: retried\nversion: 1\nsteps:\n  retried:\n    description: a step\n    execution: agent\n    prompt: Do it.\n    retry: { max_attempts: 3 }\n',
  );
  return dir;
}

/** A project folder holding one workflow with a webhook trigger, for `realm listen`. */
function triggerProject(): string {
  const dir = join(base, 'hook');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{}\n');
  writeFileSync(
    join(dir, 'workflow.yaml'),
    'id: hooked\nname: hooked\nversion: 1\nparams_schema:\n  type: object\n  additionalProperties: false\n  properties:\n    subject: { type: string }\ntrigger:\n  type: webhook\n  path: /hook\n  auth:\n    mode: shared_secret\n    header: X-Webhook-Token\n    secret_from: HOOK_TOKEN\n  params_map:\n    subject: body.subject\nsteps:\n  a:\n    description: say hello\n    execution: agent\n    prompt: say hello\n',
  );
  return dir;
}

const firstLineFor = (word: string, flags = '--model <id>'): string =>
  `error: option '${flags}' argument is ambiguous: '${word}' looks like a flag.`;
const SECOND_LINE =
  "Did you forget to specify the option argument for '--model'? To specify an option argument starting with a dash use '--model=-XYZ'.";

describe('#920 C-1 — `--model` refuses a word that starts with `-` (the built realm)', () => {
  it('1. the --strict contrast: --strict alone fails; --model --strict is refused (it used to pass); --model=--strict is a model id', () => {
    // (a) red when the guard is removed (the second run exits 0 and prints `Valid:`), when the equals
    // spelling is refused, or when the contrast run stops failing; (b) prints each run.
    const dir = retryProject();
    const alone = realm(['workflow', 'validate', dir, '--strict']);
    const typo = realm([
      'workflow',
      'validate',
      dir,
      '--provider',
      'anthropic',
      '--model',
      '--strict',
    ]);
    const equals = realm([
      'workflow',
      'validate',
      dir,
      '--provider',
      'anthropic',
      '--model=--strict',
    ]);
    const shown = [alone, typo, equals].map((r) => r.shown).join(' | ');
    expect(
      {
        alone: [alone.code, alone.stdout.split('\n')[0]?.endsWith('failing due to --strict')],
        typo: [typo.code, typo.stdout, typo.stderr.split('\n').slice(0, 2)],
        equals: [equals.code, equals.stdout.startsWith('Valid:')],
      },
      shown,
    ).toEqual({
      alone: [1, true],
      typo: [1, '', [firstLineFor('--strict'), SECOND_LINE]],
      equals: [0, true],
    });
  }, 25_000);

  it('2. the word: --json, --, -x and --help are refused; a lone -, a model id and --model=-x are accepted', () => {
    // (a) red when the flag-like test is dropped (`-` and the model id are refused), the adjacency
    // test is dropped (`--model=-x` is refused), or a word that starts with `-` is accepted; (b)
    // prints each run.
    const dir = retryProject();
    const v = ['workflow', 'validate', dir, '--provider', 'anthropic'];
    const refused = ['--json', '--', '-x', '--help'].map((w) => realm([...v, '--model', w]));
    const accepted = [
      realm([...v, '--model', '-']),
      realm([...v, '--model', 'claude-sonnet-5-5']),
      realm([...v, '--model=-x']),
    ];
    const shown = [...refused, ...accepted].map((r) => r.shown).join(' | ');
    expect(
      {
        refused: refused.map((r) => [r.code, r.stdout, r.stderr.split('\n')[0]]),
        accepted: accepted.map((r) => [r.code, r.stdout.startsWith('Valid:')]),
      },
      shown,
    ).toEqual({
      refused: ['--json', '--', '-x', '--help'].map((w) => [1, '', firstLineFor(w)]),
      accepted: [
        [0, true],
        [0, true],
        [0, true],
      ],
    });
    expect(looksLikeFlag('-'), "a lone '-'").toBe(false);
  }, 30_000);

  it('3. each of the five commands refuses `--model <a flag of its own>` and does nothing', () => {
    // (a) red when any one of the five is left out of the guarded table (that command then runs: it
    // registers, watches, starts a run or a server, or fails with another message); (b) prints each.
    const dir = retryProject();
    const hook = triggerProject();
    const register = realm([
      'workflow',
      'register',
      dir,
      '--provider',
      'anthropic',
      '--model',
      '--strict',
    ]);
    const watch = realm(
      ['workflow', 'watch', dir, '--provider', 'anthropic', '--model', '--json'],
      8_000,
    );
    const agent = realm([
      'agent',
      '--workflow',
      join(dir, 'workflow.yaml'),
      '--provider',
      'anthropic',
      '--model',
      '--register',
    ]);
    const listen = realm(
      ['listen', hook, '--port', '0', '--model', '--provider', 'anthropic'],
      8_000,
    );
    const runs = { register, watch, agent, listen };
    const shown = Object.values(runs)
      .map((r) => r.shown)
      .join(' | ');
    const registered = existsSync(join(home, '.realm', 'workflows'))
      ? readdirSync(join(home, '.realm', 'workflows'))
      : [];
    const runFiles = existsSync(join(home, '.realm', 'runs'))
      ? readdirSync(join(home, '.realm', 'runs')).filter((f) => f.endsWith('.json'))
      : [];
    expect(
      {
        codes: Object.fromEntries(Object.entries(runs).map(([k, r]) => [k, r.code])),
        stdout: Object.fromEntries(Object.entries(runs).map(([k, r]) => [k, r.stdout])),
        first: Object.fromEntries(
          Object.entries(runs).map(([k, r]) => [k, r.stderr.split('\n')[0]]),
        ),
        registered,
        runFiles,
        listening:
          listen.stdout.includes('realm listen on') || listen.stderr.includes('realm listen on'),
      },
      shown,
    ).toEqual({
      codes: { register: 1, watch: 1, agent: 1, listen: 1 },
      stdout: { register: '', watch: '', agent: '', listen: '' },
      first: {
        register: firstLineFor('--strict'),
        watch: firstLineFor('--json'),
        agent: firstLineFor('--register', '--model <model>'),
        listen: firstLineFor('--provider', '--model <model>'),
      },
      registered: [],
      runFiles: [],
      listening: false,
    });
  }, 30_000);

  it('4. the options that already refuse keep their own messages', () => {
    // (a) red when the guard is applied to every option (each line becomes the guard's); (b) prints
    // each run.
    const dir = retryProject();
    const runs = [
      realm(['workflow', 'validate', dir, '--floor', '--json']),
      realm(['workflow', 'validate', dir, '--provider', '--json']),
      realm(['run', 'list', '--status', '-x']),
    ];
    expect(
      runs.map((r) => [r.code, r.stderr.split('\n')[0]]),
      runs.map((r) => r.shown).join(' | '),
    ).toEqual([
      [1, "Error: --floor must be a whole number of tokens, 1 or more (got '--json')."],
      [
        1,
        "error: option '--provider <name>' argument '--json' is invalid. --provider must be openai or anthropic.",
      ],
      [1, expect.stringContaining("Invalid --status value '-x'")],
    ]);
  }, 25_000);

  it('5. the echo stops at the first `=`: a swallowed --api-key=<secret> prints only --api-key', () => {
    // (a) red when the whole word is echoed; (b) prints the run (its first line has no secret either way).
    const dir = retryProject();
    const r = realm([
      'workflow',
      'validate',
      dir,
      '--provider',
      'anthropic',
      '--model',
      '--api-key=sk-abc12345678',
    ]);
    expect(
      { code: r.code, first: r.stderr.split('\n')[0], echoed: r.stderr.includes('sk-abc12345678') },
      r.shown.replace('sk-abc12345678', '<secret>'),
    ).toEqual({ code: 1, first: firstLineFor('--api-key'), echoed: false });
  }, 20_000);
});

describe('#920 C-1 — the hook in this process', () => {
  /** A leaf named `validate` with `--model` and `--strict`, the guard attached, then a later hook. */
  function leaf(): { command: Command; later: string[] } {
    const later: string[] = [];
    const command = new Command('validate')
      .option('--model <id>', 'the model id')
      .option('--strict', 'fail on a warning')
      .action(() => {});
    attachOptionValueGuard([[command]]);
    command.hook('preAction', () => {
      later.push('ran');
    });
    command.exitOverride();
    command.configureOutput({ writeErr: () => {}, writeOut: () => {} });
    return { command, later };
  }

  it('6. a refusal is a CommanderError (code commander.error, exit 1, the message); a hook added after the guard runs only on an accepted value', async () => {
    // (a) red when the later hook runs on a refusal (the guard is not the first hook), or the refusal
    // is not Commander's error; (b) prints the caught error and the later hook's runs.
    const refused = leaf();
    let caught: unknown;
    await refused.command
      .parseAsync(['--model', '--strict'], { from: 'user' })
      .catch((err: unknown) => {
        caught = err;
      });
    const e = caught as CommanderError | undefined;
    const shown = `caught ${String(e?.code)} ${String(e?.exitCode)}: ${String(e?.message)}; later ${refused.later.join(',')}`;
    expect(
      {
        isCommander: caught instanceof CommanderError,
        code: e?.code,
        exitCode: e?.exitCode,
        message: e?.message,
        later: refused.later,
      },
      shown,
    ).toEqual({
      isCommander: true,
      code: 'commander.error',
      exitCode: 1,
      message: `${firstLineFor('--strict')}\n${SECOND_LINE}`,
      later: [],
    });
    const accepted = leaf();
    await accepted.command.parseAsync(['--model', 'claude-sonnet-5-5'], { from: 'user' });
    expect(accepted.later, 'the later hook on an accepted value').toEqual(['ran']);
  });

  it('6b. in the registry the guard is attached before the writer (a source-order pin: Commander has no public list of hooks)', () => {
    // (a) red when the two attach lines are swapped; (b) prints both line numbers.
    const lines = readFileSync(REGISTRY_SOURCE, 'utf8').split('\n');
    const guard = lines.findIndex((l) => l.startsWith('attachOptionValueGuard('));
    const writer = lines.findIndex((l) => l.startsWith('attachWriterHook('));
    expect(
      guard >= 0 && writer >= 0 && guard < writer,
      `attachOptionValueGuard( at line ${guard + 1}, attachWriterHook( at line ${writer + 1}`,
    ).toBe(true);
  });
});

describe('#920 C-1 — the pages say what the guard does', () => {
  it('7. realm-workflow.md, realm-agent.md, realm-listen.md and the CHANGELOG, word for word; the old --model sentence is gone', () => {
    // (a) red when a page loses a new sentence or keeps the old one; (b) prints the page and the text.
    const WORKFLOW = 'docs/reference/cli/realm-workflow.md';
    claim(
      WORKFLOW,
      '`--model` refuses a value that starts with `-`, except a lone `-`: `--provider anthropic --model --json` and `--model --strict` print the message below on standard error, exit 1 and print nothing on standard output; write `--model=--json` to mean that model id.',
    );
    const lines = read(WORKFLOW).split('\n');
    expect(
      [firstLineFor('--strict'), SECOND_LINE].map((l) => lines.includes(l)),
      `${WORKFLOW}: the message block, cell 1's two lines`,
    ).toEqual([true, true]);
    expect(read(WORKFLOW), `${WORKFLOW} still says --model has no check`).not.toContain(
      '`--model` has no check on its value',
    );
    // C-2 extended these two sentences with the page's other guarded options (re-pinned there).
    claim(
      'docs/reference/cli/realm-agent.md',
      '`--model`, `--project`, `--params` and `--base-url` refuse a value that starts with `-`, except a lone `-`; write `--option=value` for one.',
    );
    claim(
      'docs/reference/cli/realm-listen.md',
      '`--model`, `--port`, `--host`, `--dedup-store`, `--log-level` and `--sweep-expired-gates` refuse a value that starts with `-`, except a lone `-`; write `--option=value` for one.',
    );
    expect(flat(unreleased()), 'the CHANGELOG [Unreleased] #920 bullet').toContain(
      flat(
        '**A word that starts with `-` is refused as the value of `--model` (issue #920).** `realm agent`, `realm listen`, `realm workflow validate`, `register` and `watch` now refuse a value that starts with `-` (a lone `-` is accepted) as the value of `--model`; `--model --strict` used to take `--strict` as the model id and drop the flag, so a CI gate passed. Write `--model=<id>` for a value that starts with `-`.',
      ),
    );
  });
});

/** The guard's two lines for an option, as the built `realm` prints them. */
function guardLines(flags: string, long: string, word: string): string[] {
  return [
    `error: option '${flags}' argument is ambiguous: '${word}' looks like a flag.`,
    `Did you forget to specify the option argument for '${long}'? To specify an option argument starting with a dash use '${long}=-XYZ'.`,
  ];
}

describe('#920 C-2 — the other 23 options, one command family each (the built realm)', () => {
  // Each: the option typed with a real flag of the command after it, as the typo; the run exits 1
  // with the guard's two lines, prints nothing on standard output and does nothing. (a) red when the
  // family's row is missing from the guarded table (the command then runs: it writes, drains, starts
  // a server, or prints another message); (b) prints the run.
  const ID = '00000000-0000-4000-8000-000000000920';
  function refusedBy(r: Run, flags: string, long: string, word: string): void {
    expect([r.code, r.stdout, r.stderr.split('\n').slice(0, 2)], r.shown).toEqual([
      1,
      '',
      guardLines(flags, long, word),
    ]);
  }

  it('run reconcile --workflow --dry-run: refused, nothing written', () => {
    const r = realm(['run', 'reconcile', '--workflow', '--dry-run']);
    refusedBy(r, '--workflow <id>', '--workflow', '--dry-run');
    expect(r.stdout.includes('Wrote'), r.shown).toBe(false);
  }, 20_000);

  it('run drain <id> --extensions-module --force: refused (it drained nothing and said so)', () => {
    refusedBy(
      realm(['run', 'drain', ID, '--extensions-module', '--force']),
      '--extensions-module <path>',
      '--extensions-module',
      '--force',
    );
  }, 20_000);

  it('workflow run <dir> --project --params: refused before the run starts', () => {
    const dir = retryProject();
    refusedBy(
      realm(['workflow', 'run', dir, '--project', '--params']),
      '--project <dir>',
      '--project',
      '--params',
    );
    expect(existsSync(join(home, '.realm', 'runs')), 'no runs folder made').toBe(false);
  }, 20_000);

  it('run purge --older-than 0m --workflow --force: refused (it was a silent dry run)', () => {
    refusedBy(
      realm(['run', 'purge', '--older-than', '0m', '--workflow', '--force']),
      '--workflow <id>',
      '--workflow',
      '--force',
    );
  }, 20_000);

  it('run export <id> --out --accept-partial-disclosure: refused, no file named after the flag', () => {
    const r = realm(['run', 'export', ID, '--out', '--accept-partial-disclosure']);
    refusedBy(r, '--out <path>', '--out', '--accept-partial-disclosure');
    expect(readdirSync(base).includes('--accept-partial-disclosure'), r.shown).toBe(false);
  }, 20_000);

  it('agent --project --register: refused, no run made', () => {
    const dir = retryProject();
    const r = realm([
      'agent',
      '--workflow',
      join(dir, 'workflow.yaml'),
      '--provider',
      'anthropic',
      '--model',
      'claude-sonnet-5-5',
      '--project',
      '--register',
    ]);
    refusedBy(r, '--project <dir>', '--project', '--register');
    expect(existsSync(join(home, '.realm', 'runs')), r.shown).toBe(false);
  }, 20_000);

  it('mcp --extensions-module --check: refused at once, the server is not started', () => {
    refusedBy(
      realm(['mcp', '--extensions-module', '--check'], 8_000),
      '--extensions-module <path>',
      '--extensions-module',
      '--check',
    );
  }, 20_000);

  it('run list --workflow --stuck: refused (it said "No runs found")', () => {
    refusedBy(
      realm(['run', 'list', '--workflow', '--stuck']),
      '--workflow <id>',
      '--workflow',
      '--stuck',
    );
  }, 20_000);

  it('serve --dev --port -1: refused with the message, not a Node RangeError', () => {
    refusedBy(realm(['serve', '--dev', '--port', '-1'], 8_000), '--port <number>', '--port', '-1');
  }, 20_000);

  it('listen <workflow> --port -1: refused with the message, not an uncaught stack', () => {
    const hook = triggerProject();
    refusedBy(
      realm(
        ['listen', hook, '--port', '-1', '--provider', 'anthropic', '--model', 'claude-sonnet-5-5'],
        8_000,
      ),
      '--port <n>',
      '--port',
      '-1',
    );
  }, 20_000);
});

describe('#920 C-2 — the pages name every guarded option', () => {
  it('the C-2 sentences, word for word, at their places on four pages', () => {
    // (a) red when a page loses a sentence; (b) prints the page and the sentence. (realm-agent.md and
    // realm-listen.md: cell 7.)
    const one = (o: string): string =>
      `\`${o}\` refuses a value that starts with \`-\`, except a lone \`-\`; write \`--option=value\` for one.`;
    const two = (a: string, b: string): string =>
      `\`${a}\` and \`${b}\` refuse a value that starts with \`-\`, except a lone \`-\`; write \`--option=value\` for one.`;
    const WORKFLOW = 'docs/reference/cli/realm-workflow.md';
    const READING = 'docs/reference/cli/realm-run-reading.md';
    const ACTING = 'docs/reference/cli/realm-run-acting.md';
    const MCP = 'docs/reference/cli/realm-mcp-and-serve.md';
    claim(WORKFLOW, one('--project'));
    claim(READING, one('--workflow'));
    claim(READING, one('--out'));
    claim(ACTING, two('--project', '--extensions-module'));
    claim(MCP, two('--project', '--extensions-module'));
    claim(
      MCP,
      '`--port`, `--project` and `--extensions-module` refuse a value that starts with `-`, except a lone `-`; write `--option=value` for one.',
    );
    // On realm-run-acting.md the single-option sentence stands after five sections: respond and
    // advance (--project), reclaim, purge and reconcile (--workflow).
    const acting = flat(read(ACTING));
    const count = (text: string): number => acting.split(flat(text)).length - 1;
    expect(
      { project: count(one('--project')), workflow: count(one('--workflow')) },
      `${ACTING}: the single-option sentences`,
    ).toEqual({ project: 2, workflow: 3 });
    expect(flat(unreleased()), 'the CHANGELOG [Unreleased] #920 bullet, C-2 clause').toContain(
      flat(
        'The same now holds for 23 other options that took any word: `--project` (on `workflow run`, `agent`, `run drain`, `run respond`, `run advance`, `mcp` and `serve`), `--extensions-module` (`run drain`, `mcp`, `serve`), `--workflow` (`run list`, `reclaim`, `purge`, `reconcile`), `run export --out`, `agent --params` and `--base-url`, `serve --port`, and `listen --port`, `--host`, `--dedup-store`, `--log-level` and `--sweep-expired-gates`.',
      ),
    );
  });
});
