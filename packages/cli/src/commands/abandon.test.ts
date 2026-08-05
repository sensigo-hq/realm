// Tests for the `realm run abandon` CLI command. The command constructs a JsonFileStore against
// $HOME/.realm/runs (like resume/cleanup). JsonFileStore's default dir is computed at module-load,
// so we set $HOME before the FIRST `@sensigo/realm` import (no static import here; load it lazily
// inside the tests, after beforeEach has pointed $HOME at a temp dir).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { abandonCommand } from './abandon.js';

describe('realm run abandon (CLI command)', () => {
  let home: string;
  let runsDir: string;
  let originalHome: string | undefined;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'realm-abandon-cli-'));
    runsDir = join(home, '.realm', 'runs');
    await mkdir(runsDir, { recursive: true });
    originalHome = process.env['HOME'];
    process.env['HOME'] = home;
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('process.exit');
    }) as never);
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = originalHome;
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
    await rm(home, { recursive: true, force: true });
  });

  it('success: abandons a running run and reports it', async () => {
    const { JsonFileStore } = await import('@sensigo/realm');
    const store = new JsonFileStore(); // default dir = $HOME/.realm/runs (temp)
    const { run } = await store.create({ workflowId: 'wf', workflowVersion: 1, params: {} });

    await abandonCommand.parseAsync([run.id, '--reason', 'stale'], { from: 'user' });

    const reloaded = await store.get(run.id);
    expect(reloaded.run_phase).toBe('abandoned');
    expect(reloaded.abandoned_at).toBeDefined();
    expect(reloaded.terminal_reason).toBe('stale');
    expect(logSpy).toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
    // issue #302 (D-B, M2): the abandon kill-advisory, printed unconditionally on success.
    const logged = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain(
      "abandon is a kill — declared finalizers (if any) did NOT run; 'abort' is the graceful path.",
    );
  });

  it('error: a missing run prints an error and exits non-zero', async () => {
    await expect(abandonCommand.parseAsync(['no-such-run'], { from: 'user' })).rejects.toThrow(
      'process.exit',
    );
    expect(errSpy).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
