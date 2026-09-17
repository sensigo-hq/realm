// Tests for the `realm run abandon` CLI command. The command constructs a JsonFileStore against
// $HOME/.realm/runs (like resume/cleanup). JsonFileStore's default dir is computed at module-load,
// so we set $HOME before the FIRST `@sensigo/realm` import (no static import here; load it lazily
// inside the tests, after beforeEach has pointed $HOME at a temp dir).
// issue #285 (2026-08-13): fixed at the root — the default dir now resolves at CONSTRUCTION time,
// not module load (drain.ts's header has the full account). This file's lazy-import idiom stays;
// historicized here only.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { abandonCommand } from './abandon.js';

/** issue #558 PR-C: the ONE core mint, asserted by VALUE here — this cell is the CLI half of
 *  the cross-surface pin (the MCP half lives in `run-recovery.test.ts`). */
const ADVISORY =
  'abandon is a kill — declared finalizers (if any) did NOT run and will not for this run. ' +
  "The graceful path is the workflow's own guard step (abort_unless), which runs them; " +
  'there is no operator abort command.';

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
    const logged = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(logged).toContain(ADVISORY);
    // issue #558 PR-C: line 2 names a CLI verb (`start_run` is an MCP tool an operator cannot run)
    // and line 3 no longer names a nonexistent `abort` command.
    expect(logged).toContain(
      `To run the same work again: realm workflow run <the workflow.yaml you registered '${run.workflow_id}' from> — a fresh run; this run's evidence stays at realm run inspect ${run.id}.`,
    );
    expect(logged).not.toContain('use start_run');
    expect(logged).not.toContain("'abort' is the graceful path");
  });

  it('issue #558 PR-C (walk 2): line 2 names the DIRECTORY the copy was registered from when the copy reads', async () => {
    // The blank form above is the honest sentence only when realm holds no path. A registered copy
    // records `source_dir` (since v0.14) and `realm workflow run` takes a directory — so the
    // command is executable from this screen. Read AFTER the seal; the kill never depends on it.
    const { JsonFileStore, JsonWorkflowStore, CURRENT_WORKFLOW_SCHEMA_VERSION } =
      await import('@sensigo/realm');
    await new JsonWorkflowStore().register({
      id: 'wf-src',
      name: 'With Source',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: { one: { description: 'one', execution: 'agent', depends_on: [] } },
      source_dir: '/tmp/prc-src-dir',
    });
    const store = new JsonFileStore();
    const { run } = await store.create({
      workflowId: 'wf-src',
      workflowVersion: 1,
      params: { path: "/tmp/it's", n: 1 },
    });

    await abandonCommand.parseAsync([run.id], { from: 'user' });

    const logged = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(logged).toContain(
      // walk 3: the printed command must start a run AS PRINTED — the workflow's params ride along,
      // shell-quoted (a single quote inside them survives the quoting).
      `To run the same work again: realm workflow run /tmp/prc-src-dir --params '{"path":"/tmp/it'\\''s","n":1}' (the directory it was registered from) — a fresh run; this run's evidence stays at realm run inspect ${run.id}.`,
    );
    expect(logged).not.toContain('<the workflow.yaml you registered');
  });

  it('issue #558 PR-C: the reason names THIS surface, and every claim is released', async () => {
    const { JsonFileStore } = await import('@sensigo/realm');
    const store = new JsonFileStore();
    const { run } = await store.create({ workflowId: 'wf', workflowVersion: 1, params: {} });
    await store.update({
      ...run,
      in_progress_steps: ['analyze'],
      claims: {
        analyze: {
          deadline: new Date(Date.now() + 3_600_000).toISOString(),
        },
      },
    });

    await abandonCommand.parseAsync([run.id], { from: 'user' });

    const reloaded = await store.get(run.id);
    expect(reloaded.terminal_reason).toBe('Abandoned via realm run abandon');
    expect(reloaded.in_progress_steps).toEqual([]);
    expect(reloaded.claims).toEqual({});
  });

  it('issue #558 PR-C: the gate refusal ends in the command a CLI operator can run', async () => {
    const { JsonFileStore } = await import('@sensigo/realm');
    const store = new JsonFileStore();
    const { run } = await store.create({ workflowId: 'wf', workflowVersion: 1, params: {} });
    await store.update({
      ...run,
      pending_gate: {
        gate_id: 'g-approve-1',
        step_name: 'review_changes',
        preview: {},
        choices: ['approve', 'reject'],
        opened_at: new Date().toISOString(),
      },
    });

    await expect(abandonCommand.parseAsync([run.id], { from: 'user' })).rejects.toThrow(
      'process.exit',
    );

    const printed = errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(printed).toBe(
      `Run '${run.id}' is waiting on human gate 'review_changes' (gate 'g-approve-1'); answer it before abandoning. ` +
        `Answer it: realm run respond ${run.id} --gate g-approve-1 --choice <one of: approve, reject>.`,
    );
    expect(printed).not.toContain('submit_human_response');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('error: a missing run prints an error and exits non-zero', async () => {
    await expect(abandonCommand.parseAsync(['no-such-run'], { from: 'user' })).rejects.toThrow(
      'process.exit',
    );
    expect(errSpy).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
