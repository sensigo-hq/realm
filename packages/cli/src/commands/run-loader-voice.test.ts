// issue #425 — `realm run`'s loader failures speak the same voice as validate/register/watch.
//
// There was no test file for the run command at all, so both of the shapes its loader catch can
// produce were unpinned. The catch wraps `loadWorkflowFromFile` alone, so everything it sees IS a
// loader failure — which is why it needs no family-split else-arm, unlike register/test/agent.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand } from './run.js';

describe('run — the loader voice (issue #425)', () => {
  let dir: string;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'realm-run-voice-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('process.exit');
    }) as never);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('a structural refusal prints the loader message verbatim', async () => {
    const file = join(dir, 'workflow.yaml');
    writeFileSync(
      file,
      `id: run-voice
name: Run Voice
version: 1
steps:
  a:
    description: a
    execution: agent
    timeout_seconds: 60
`,
      'utf8',
    );

    await expect(runCommand.parseAsync([file], { from: 'user' })).rejects.toThrow('process.exit');

    const errored = errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    const first = errored.split('\n')[0]!;
    expect(first).toContain("Invalid workflow: Step 'a': 'timeout_seconds' is not valid");
    // The old `Error loading workflow: ` prefix is gone from this family — it made run the one
    // command that announced a loader refusal differently from every other.
    expect(errored).not.toContain('Error loading workflow');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('an unreadable file rides the shared fallback prefix', async () => {
    // The deliberate text change: this used to read `Error loading workflow: ENOENT…` and now
    // reads `Invalid: ENOENT…`, because a message that announces nothing on its own still earns a
    // prefix — and it is now the SAME prefix every other command uses for the same class.
    await expect(
      runCommand.parseAsync([join(dir, 'no-such-file.yaml')], { from: 'user' }),
    ).rejects.toThrow('process.exit');

    const errored = errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(errored).toMatch(/^Invalid: /m);
    expect(errored).toContain('Failed to read workflow file');
    expect(errored).not.toContain('Error loading workflow');
  });
});

// =================================================================================================
// issue #426 — dev-mode run refuses a non-TTY stdin BEFORE it creates anything
//
// The dev runner prompts on stdin for every step kind and every gate. Piped or scripted, stdin
// EOFs, readline closes, and the first prompt throws ERR_USE_AFTER_CLOSE — but only AFTER the run
// record was minted and its id printed, so every scripted invocation left a wedged `running` run
// behind. The guard refuses at entry instead.
//
// The two loader-voice cells above are this change's free ORDER pin: they drive runCommand in
// vitest's own non-TTY environment and expect LOADER messages, so a guard placed before the load
// would red their message assertions.
// =================================================================================================
describe('run — dev mode requires a terminal (issue #426)', () => {
  const VALID = `id: run-tty
name: Run TTY
version: 1
steps:
  a:
    description: a
    execution: agent
`;

  let home: string;
  let originalHome: string | undefined;
  let dir: string;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // A scratch HOME because the load-bearing conjunct below READS the runs dir — the store
    // resolves it from homedir() at construction time (#285), so pointing HOME here isolates it.
    home = mkdtempSync(join(tmpdir(), 'realm-run-tty-home-'));
    originalHome = process.env['HOME'];
    process.env['HOME'] = home;
    dir = mkdtempSync(join(tmpdir(), 'realm-run-tty-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('process.exit');
    }) as never);
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = originalHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  /** The runs the command wrote into the scratch HOME, tolerating the dir never existing. */
  function runRecords(): string[] {
    try {
      return readdirSync(join(home, '.realm', 'runs')).filter((f) => f.endsWith('.json'));
    } catch {
      // Post-guard the store is never constructed, so the directory does not exist. A naive
      // readdirSync here would throw ENOENT and red the GREEN case.
      return [];
    }
  }

  it('refuses a piped stdin with a pointed message, and creates NO run', async () => {
    // vitest's forks pool leaves stdin non-TTY (isTTY undefined) even when the suite is started
    // from a real terminal, so this is the natural environment — no patching needed.
    const file = join(dir, 'workflow.yaml');
    writeFileSync(file, VALID, 'utf8');

    await expect(runCommand.parseAsync([file], { from: 'user' })).rejects.toThrow('process.exit');

    const errored = errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(errored.split('\n')[0]).toBe(
      "Error: dev-mode run is interactive — it prompts on stdin for every step and gate, and stdin here is not a terminal. No run was created. Scripted flows: 'realm workflow test' drives fixtures; 'realm listen' / 'realm agent' are the production drives. To run this workflow by hand, use a real terminal.",
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
    // The acceptance bar, and the reason the guard sits where it does: nothing was minted.
    expect(runRecords()).toEqual([]);
  });

  it('a terminal is let through — the guard governs entry, not execution', async () => {
    // The witness that needs no readline mock: a root step whose `when` can never be satisfied
    // leaves findEligibleSteps empty, so the loop breaks before any prompt. Real readline is
    // constructed and closed, never questioned — so parseAsync RESOLVES, and the run record it
    // left behind proves the guard passed a terminal through to store.create.
    const file = join(dir, 'workflow.yaml');
    writeFileSync(
      file,
      `id: run-tty-through
name: Run TTY Through
version: 1
steps:
  a:
    description: a
    execution: agent
    when:
      - 'run.params.never_true == true'
`,
      'utf8',
    );

    const savedIsTTY = process.stdin.isTTY;
    try {
      process.stdin.isTTY = true;
      // issue #468 — the guard passed a terminal through to store.create, but the loop then
      // stalls (no eligible steps): the run is left live and the process now exits honestly
      // instead of silently exiting 0. The map/exit content is B3's job (run-detach.test.ts) —
      // this cell's purpose stays the #426 guard, so only the entry/exit shape is pinned here.
      await expect(runCommand.parseAsync([file], { from: 'user' })).rejects.toThrow('process.exit');
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(runRecords()).toHaveLength(1);
    } finally {
      process.stdin.isTTY = savedIsTTY;
    }
  });

  it('--params is validated BEFORE the terminal check — the specific error wins', async () => {
    const file = join(dir, 'workflow.yaml');
    writeFileSync(file, VALID, 'utf8');

    await expect(runCommand.parseAsync([file, '--params', '{'], { from: 'user' })).rejects.toThrow(
      'process.exit',
    );

    const errored = errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(errored).toContain('Error: --params is not valid JSON');
    expect(errored).not.toContain('dev-mode run is interactive');
  });
});
