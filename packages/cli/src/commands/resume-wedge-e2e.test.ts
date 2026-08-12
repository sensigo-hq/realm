// resume-wedge-e2e.test.ts — verification item 4 (issue #279, increment 1, PR-B): ONE end-to-end
// R1-wedge reproduction through the REAL CLI — settle-fail → resume (via the real resumeCommand)
// → re-claim → settle applies. JsonFileStore's default dir is computed at module-load time, so
// $HOME must be set BEFORE the first `@sensigo/realm` import (mirrors abandon.test.ts/drain.test.ts).
// issue #285 (2026-08-13): fixed at the root — the default dir now resolves at CONSTRUCTION time,
// not module load (drain.ts's header has the full account). This file's ordering idiom stays;
// historicized here only.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resumeCommand } from './resume.js';

describe('resume wedge e2e (issue #279, increment 1, PR-B, verification item 4)', () => {
  let home: string;
  let originalHome: string | undefined;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'realm-resume-wedge-e2e-'));
    await mkdir(join(home, '.realm', 'runs'), { recursive: true });
    await mkdir(join(home, '.realm', 'workflows'), { recursive: true });
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

  it('settle-fail → resume (real CLI) → re-claim → settle APPLIES (the R1 wedge is gone on the migrated path)', async () => {
    const { JsonFileStore, JsonWorkflowStore, executeStep, CURRENT_WORKFLOW_SCHEMA_VERSION } =
      await import('@sensigo/realm');
    const runStore = new JsonFileStore();
    const workflowStore = new JsonWorkflowStore();

    const def = {
      id: 'resume-wedge-wf',
      name: 'Resume Wedge WF',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: {
        work: { description: 'w', execution: 'agent' as const },
      },
    };
    await workflowStore.register(def);

    const { run } = await runStore.create({
      workflowId: 'resume-wedge-wf',
      workflowVersion: 1,
      params: {},
    });

    // 1. Settle-fail 'work' through the REAL migrated engine path.
    const failResult = await executeStep(runStore, def, {
      runId: run.id,
      command: 'work',
      input: {},
      dispatcher: async () => {
        throw new Error('handler boom');
      },
    });
    expect(failResult.status).toBe('error');
    const afterFail = await runStore.get(run.id);
    expect(afterFail.failed_steps).toContain('work');
    expect(afterFail.terminal_state).toBe(true);
    expect(afterFail.run_phase).toBe('failed');

    // 2. Resume through the REAL CLI command (not a hand-called function — the literal Command
    // object `realm resume` wires).
    await resumeCommand.parseAsync([run.id, '--from', 'work'], { from: 'user' });
    expect(exitSpy).not.toHaveBeenCalled();
    const afterResume = await runStore.get(run.id);
    expect(afterResume.terminal_state).toBe(false);
    expect(afterResume.failed_steps).not.toContain('work');
    expect(afterResume.claims?.['work']).toBeUndefined(); // claim released

    // 3. Re-claim + settle again — this time succeeding. Under the LEGACY (pre-#279) mechanism,
    // this re-settle raced the read-then-update draft against whatever state existed at read
    // time; on the migrated path it settles atomically against fresh state and simply APPLIES.
    const completeResult = await executeStep(runStore, def, {
      runId: run.id,
      command: 'work',
      input: {},
      dispatcher: async () => ({ result: 'ok' }),
    });

    expect(completeResult.status).toBe('ok');
    expect(completeResult.errors).toEqual([]);
    const finalRun = await runStore.get(run.id);
    expect(finalRun.completed_steps).toContain('work');
    expect(finalRun.terminal_state).toBe(true);
    expect(finalRun.run_phase).toBe('completed');
  });
});
