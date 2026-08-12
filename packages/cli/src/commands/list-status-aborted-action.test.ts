// realm run list --status aborted (issue #289) — the ACTION-level test.
//
// The obvious test route is confirmation theater: `listRuns` (list.test.ts's own 46 cases) never
// validates `--status` at all — the rejection lives ONLY in the commander action's own
// `VALID_PHASES.includes(...)` gate (list.ts, the `.action(...)` callback). A `listRuns`-level test
// is green before AND after the fix, so it proves nothing about #289. This file drives the action
// itself.
//
// $HOME-override timing (drain.test.ts's own documented #285 leak class): `list.ts` has a
// TOP-LEVEL VALUE import of `@sensigo/realm` (`classifyRunHealth`/`deriveRunPhase`/
// `DEFAULT_IDLE_THRESHOLD_MS`/`FailedAttemptStore`) — merely importing `list.js`, even dynamically,
// eagerly evaluates `@sensigo/realm`'s module graph, including `JsonFileStore`'s module-load-time
// `DEFAULT_RUNS_DIR = join(homedir(), ...)` capture. A STATIC top-of-file `import { listCommand }
// from './list.js'` would therefore freeze the REAL $HOME before `beforeAll` ever runs (unlike
// attempts.test.ts, whose own command file only `import type`s `@sensigo/realm` — no runtime
// import to freeze). `listCommand` is imported dynamically instead, INSIDE `beforeAll`, strictly
// AFTER `process.env['HOME']` is overridden — mirroring attempts.test.ts's own ordering discipline,
// applied to the one command file where a static import would defeat it.
// issue #285 (2026-08-13): the capture itself is now fixed at the root — `DEFAULT_RUNS_DIR` no
// longer exists; the default resolves at CONSTRUCTION time (drain.ts's header has the full
// account). Historicized here only — this file's dynamic-import-in-beforeAll idiom stays.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';

let home: string;
let originalHome: string | undefined;
let listCommand: Command;

describe('realm run list --status aborted (issue #289) — action-level', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'list-status-aborted-cli-'));
    await mkdir(join(home, '.realm', 'runs'), { recursive: true });
    originalHome = process.env['HOME'];
    process.env['HOME'] = home; // set before list.js's own first '@sensigo/realm' import, below
    ({ listCommand } = await import('./list.js'));
  });

  afterAll(async () => {
    if (originalHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = originalHome;
    await rm(home, { recursive: true, force: true });
  });

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('process.exit');
    }) as never);
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  });

  function stderrText(): string {
    return errSpy.mock.calls.map((c) => String(c[0])).join('\n');
  }

  it('does NOT reject --status aborted (RunPhase has carried it since #279 PR-C; VALID_PHASES was never updated)', async () => {
    await listCommand.parseAsync(['--status', 'aborted'], { from: 'user' });

    expect(exitSpy).not.toHaveBeenCalled();
    expect(stderrText()).not.toContain('Invalid --status');
    // Empty temp runsDir — the command still runs to completion and prints its (empty) table,
    // proving the filter itself was accepted and reached listRuns, not merely that validation
    // didn't throw before some earlier bail-out.
    expect(logSpy).toHaveBeenCalled();
  });

  it('control: an ACTUALLY invalid --status value is still rejected (the gate itself still works)', async () => {
    await expect(
      listCommand.parseAsync(['--status', 'not_a_real_phase'], { from: 'user' }),
    ).rejects.toThrow('process.exit');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(stderrText()).toContain('Invalid --status');
    expect(stderrText()).toContain('aborted'); // the help text now lists it too
  });
});
