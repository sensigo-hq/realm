// issue #425 — `realm run`'s loader failures speak the same voice as validate/register/watch.
//
// There was no test file for the run command at all, so both of the shapes its loader catch can
// produce were unpinned. The catch wraps `loadWorkflowFromFile` alone, so everything it sees IS a
// loader failure — which is why it needs no family-split else-arm, unlike register/test/agent.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
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
