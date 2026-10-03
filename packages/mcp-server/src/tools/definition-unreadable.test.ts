// issue #558 PR-T — the MCP half of the terminal conjunct. `execute_step`, `append_trace` and
// `submit_human_response` read the run's definition BEFORE their own terminal check, so on a
// terminal run their remedy ("retry") is a falsity. They do NOT pass `terminalOk`.
import { declared } from '../test-support/declared.js';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { getWorkflowForRun, WorkflowError } from '@sensigo/realm';
import type { RunRecord, WorkflowRegistrar } from '@sensigo/realm';

function makeRun(over: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'run-1',
    workflow_id: 'wf',
    workflow_version: 1,
    completed_steps: [],
    in_progress_steps: [],
    failed_steps: [],
    skipped_steps: [],
    run_phase: 'running',
    version: 1,
    params: {},
    evidence: [],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    terminal_state: false,
    ...over,
  } as RunRecord;
}

const notFound = (): WorkflowRegistrar =>
  declared({
    register: async () => {},
    list: async () => [],
    get: async () => {
      throw new WorkflowError('Workflow not found: wf', {
        code: 'STATE_WORKFLOW_NOT_FOUND',
        category: 'STATE',
        agentAction: 'report_to_user',
        retryable: false,
      });
    },
  });

describe('the MCP tools’ (retryVerb, verb) pair (issue #558 PR-T)', () => {
  it('M1 on a TERMINAL run the agent is told there is nothing to RETRY — whole message, the one MCP site pinned byte-for-byte', async () => {
    const err = (await getWorkflowForRun(
      notFound(),
      makeRun({
        terminal_state: true,
        failed_steps: ['s1'],
        sealed_by: { arm: 'step_failure', at: '2026-01-01T00:00:00.000Z' },
      } as Partial<RunRecord>),
      { retryVerb: 'retry', verb: 'retry' },
    ).catch((e: unknown) => e)) as WorkflowError;

    expect(err.code).toBe('STATE_WORKFLOW_NOT_FOUND');
    expect(err.message).toBe(
      'Workflow not found: wf. The run is terminal (failed); there is nothing to retry.',
    );
  });

  it('M2 on a LIVE run the agent still gets the #456 remedy, unchanged', async () => {
    const err = (await getWorkflowForRun(notFound(), makeRun(), {
      retryVerb: 'retry',
      verb: 'retry',
    }).catch((e: unknown) => e)) as WorkflowError;

    expect(err.message).toBe(
      'Workflow not found: wf — most often this run was created from a file without --register. ' +
        'Register the workflow (realm workflow register <file>) and retry.',
    );
  });

  it('M3 the four MCP call sites pass ("retry", "retry") and NONE passes terminalOk', () => {
    // A source-text census: the six sites WITHOUT `terminalOk` are the population the terminal
    // conjunct exists for, and three of them are these tools. A future edit adding `terminalOk`
    // here would re-open the falsity this PR closes.
    //
    // issue #600 PR 1b: `get-run-state.ts` gained a SECOND `getWorkflowForRun(` call (the
    // per-step cost view's own resolution, WITH `terminalOk` — a live gate-waiting run's terminal
    // state has nothing to do with whether ITS definition can be read for a cost view). The old
    // `src.indexOf('});', at)` slice ran into that second call and its `terminalOk`, so it ends at
    // the call's OWN `})` instead — the status-path call's options object closing, never reaching
    // past it into the `.catch` or anything that follows.
    const files = [
      'execute-step.ts',
      'append-trace.ts',
      'submit-human-response.ts',
      'get-run-state.ts',
    ];
    for (const f of files) {
      const src = readFileSync(new URL(`./${f}`, import.meta.url), 'utf8');
      const at = src.indexOf('getWorkflowForRun(');
      expect(at, `${f} must call getWorkflowForRun`).toBeGreaterThan(-1);
      const call = src.slice(at, src.indexOf('})', at) + 2);
      expect(call, `${f} must ask to RETRY`).toContain("retryVerb: 'retry'");
      expect(call, `${f} must name the bare verb`).toContain("verb: 'retry'");
      expect(call, `${f} must NOT pass terminalOk`).not.toContain('terminalOk');
    }
  });

  it('M3b get-run-state.ts calls getWorkflowForRun exactly twice, and the SECOND one discards its failure', () => {
    // The first call (the status path) is M3's own population; the second (the #600 PR 1b view
    // resolution) is a NEW, independent call whose `.catch` must never assign `definitionError` —
    // a leak there would make the isolation this PR's own mutant (i) exists to catch untestable.
    const src = readFileSync(new URL('./get-run-state.ts', import.meta.url), 'utf8');
    const occurrences = src.split('getWorkflowForRun(').length - 1;
    expect(occurrences, 'exactly two getWorkflowForRun( calls').toBe(2);
    const firstAt = src.indexOf('getWorkflowForRun(');
    const secondAt = src.indexOf('getWorkflowForRun(', firstAt + 1);
    const secondCallAndAfter = src.slice(secondAt);
    expect(secondCallAndAfter.slice(0, 200)).toContain('terminalOk: true');
    expect(secondCallAndAfter).not.toContain('definitionError =');
  });
  it('WITNESS get_run_state narrows the definition failure with instanceof — never a duck-typed `err as { code?`', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(
      join(fileURLToPath(new URL('.', import.meta.url)), 'get-run-state.ts'),
      'utf8',
    );
    expect(src).not.toMatch(/err as \{\s*code\?:/);
    expect(src).toContain('err instanceof WorkflowError');
  });
});
