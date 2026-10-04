// owed-words-625.test.ts — issue #625 PR-2a: whole-message pins for the CLI words the owed call mints
// that no journey cell reaches: `realm run advance`'s fit words, identity and driver words and every
// `Stopped:` reason; `inspect`'s refused-step line; listen's sweeper `owed` field.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  JsonFileStore,
  JsonWorkflowStore,
  ExtensionRegistry,
  describePending,
  executeStep,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  type RunRecord,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { FIT_WORDS, stoppedReasons, advanceRunFromShell } from './run-advance.js';
import { inspectRun } from './inspect.js';
import { sweepExpiredGates } from './listen.js';

const wf = (id: string, steps: WorkflowDefinition['steps']): WorkflowDefinition => ({
  id,
  name: id,
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps,
});

function stores() {
  const home = mkdtempSync(join(tmpdir(), 'realm-owed-words-625-'));
  return {
    home,
    runs: new JsonFileStore(join(home, 'runs')),
    workflows: new JsonWorkflowStore(join(home, 'wf')),
  };
}

describe('#625 PR-2a — realm run advance: the words', () => {
  it('FIT_WORDS, every member', () => {
    expect(FIT_WORDS).toEqual({
      same: "same as the run's last record",
      differs: "differs from the run's last record",
      not_comparable: "not comparable with the run's last record",
      none: 'neither side records project code',
    });
  });

  it('stoppedReasons, every member, one reason each and both when a refused step and agent steps hold', () => {
    const base = {
      id: 'r',
      params: {},
      completed_steps: [],
      in_progress_steps: [],
      failed_steps: [],
      skipped_steps: [],
      evidence: [],
      terminal_state: false,
    } as unknown as RunRecord;
    const none = { agent_actions: [], agent_steps: [], pending_guards: [], engine_runnable: [] };
    expect(
      stoppedReasons(
        'r',
        {
          ...base,
          terminal_state: true,
          sealed_by: { arm: 'complete' },
          terminal_reason: 'Workflow completed.',
        } as RunRecord,
        none,
      ),
    ).toEqual(['the run has ended (completed)']);
    expect(
      stoppedReasons(
        'r',
        {
          ...base,
          pending_gate: {
            gate_id: 'g1',
            step_name: 's',
            choices: ['a', 'b'],
            opened_at: '',
            preview: {},
          },
        } as RunRecord,
        none,
      ),
    ).toEqual(['a question is open — realm run respond r --gate g1 --choice <one of: a, b>']);
    expect(
      stoppedReasons('r', base, {
        ...none,
        engine_runnable: [
          { step: 'x', runnable_here: false, refused_by: 'trust', refusal: 'bad trust' },
          { step: 'y', runnable_here: false, refused_by: 'precondition', refusal: 'no' },
        ],
      }),
    ).toEqual(["'x' cannot run here (trust): bad trust", "'y' cannot run here (precondition): no"]);
    expect(stoppedReasons('r', base, { ...none, agent_steps: ['a', 'b'] })).toEqual([
      "agent steps are ready: 'a', 'b' — drive them with realm agent --run-id r",
    ]);
    expect(
      stoppedReasons('r', base, {
        ...none,
        agent_steps: ['a'],
        engine_runnable: [
          { step: 'x', runnable_here: false, refused_by: 'trust', refusal: 'bad trust' },
        ],
      }),
    ).toEqual([
      "'x' cannot run here (trust): bad trust",
      "agent steps are ready: 'a' — drive them with realm agent --run-id r",
    ]);
    expect(stoppedReasons('r', base, none)).toEqual(['nothing is ready to run now']);
  });

  it("advance: a failed engine step is the first Stopped reason, then the view's; exit 1", async () => {
    const { home, runs, workflows } = stores();
    try {
      const d = wf('failed-wf', {
        x: { description: 'X', execution: 'auto', depends_on: [], handler: 'boom' },
        y: { description: 'Y', execution: 'agent', depends_on: [] },
      });
      await workflows.register(d);
      const { run } = await runs.create({ workflowId: d.id, workflowVersion: 1, params: {} });
      const registry = new ExtensionRegistry();
      registry.register('handler', 'boom', {
        id: 'boom',
        execute: async () => {
          throw new Error('handler blew up');
        },
      });
      const lines: string[] = [];
      const code = await advanceRunFromShell(
        run.id,
        { project: home },
        runs,
        workflows,
        undefined,
        (l) => lines.push(l),
        registry,
      );
      expect(code).toBe(1);
      expect(lines.slice(4)).toEqual([
        '→ x',
        "Stopped: 'x' failed: Handler 'boom' threw: handler blew up",
        `Stopped: agent steps are ready: 'y' — drive them with realm agent --run-id ${run.id}`,
        `Run ${run.id}: phase 'running'`,
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('C21: the driver line counts in the plural, and says nothing when no newer entry lacks a driver', async () => {
    const { home, runs, workflows } = stores();
    try {
      const d = wf('plural-wf', {
        a: { description: 'A', execution: 'agent', depends_on: [] },
        b: { description: 'B', execution: 'agent', depends_on: ['a'] },
        c: { description: 'C', execution: 'auto', depends_on: ['b'] },
      });
      await workflows.register(d);
      const { run } = await runs.create({ workflowId: d.id, workflowVersion: 1, params: {} });
      const echo = async (_s: string, i: Record<string, unknown>) => i;
      const one = { by: 'one@host', by_source: 'derived', channel: 'agent' } as const;
      await executeStep(runs, d, {
        runId: run.id,
        command: 'a',
        input: {},
        dispatcher: echo,
        driver: one,
      });
      const at = (await runs.get(run.id)).evidence.find((e) => e.step_id === 'a')!.completed_at;
      const preview = async (): Promise<string> => {
        const lines: string[] = [];
        await advanceRunFromShell(
          run.id,
          { project: home },
          runs,
          workflows,
          undefined,
          (l) => lines.push(l),
          new ExtensionRegistry(),
        );
        return lines[2]!;
      };
      expect(await preview()).toBe(
        `Last recorded driver: one@host (from the OS user, via agent) at step 'a', ${at}.`,
      );
      await executeStep(runs, d, { runId: run.id, command: 'b', input: {}, dispatcher: echo });
      await executeStep(runs, d, { runId: run.id, command: 'c', input: {}, dispatcher: echo });
      expect(await preview()).toBe(
        `Last recorded driver: one@host (from the OS user, via agent) at step 'a', ${at}; 2 newer entries record no driver.`,
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('no derivable name, a driver with newer entries that record none: the preview says both', async () => {
    const { home, runs, workflows } = stores();
    try {
      const d = wf('words-wf', {
        a: { description: 'A', execution: 'agent', depends_on: [] },
        b: { description: 'B', execution: 'agent', depends_on: ['a'] },
        c: { description: 'C', execution: 'auto', depends_on: ['b'] },
      });
      await workflows.register(d);
      const { run } = await runs.create({ workflowId: d.id, workflowVersion: 1, params: {} });
      const echo = async (_s: string, i: Record<string, unknown>) => i;
      await executeStep(runs, d, {
        runId: run.id,
        command: 'a',
        input: {},
        dispatcher: echo,
        driver: { by: 'one@host', by_source: 'derived', channel: 'agent' },
      });
      await executeStep(runs, d, { runId: run.id, command: 'b', input: {}, dispatcher: echo });
      const at = (await runs.get(run.id)).evidence.find((e) => e.step_id === 'a')!.completed_at;
      const lines: string[] = [];
      await advanceRunFromShell(
        run.id,
        { project: home },
        runs,
        workflows,
        undefined,
        (l) => lines.push(l),
        new ExtensionRegistry(),
      );
      expect(lines[1]).toBe(
        'This program: no name could be recorded · project code: neither side records project code.',
      );
      expect(lines[2]).toBe(
        `Last recorded driver: one@host (from the OS user, via agent) at step 'a', ${at}; 1 newer entry records no driver.`,
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('#625 PR-2a — inspect names each engine step that cannot run', () => {
  it("`Cannot run '<s>' (<check>): <refusal>`", async () => {
    const { home, runs, workflows } = stores();
    try {
      const d = wf('inspect-refused-wf', {
        x: {
          description: 'X',
          execution: 'auto',
          depends_on: [],
          preconditions: ['nothing.ok == true'],
        },
      });
      await workflows.register(d);
      const { run } = await runs.create({ workflowId: d.id, workflowVersion: 1, params: {} });
      const out = await inspectRun(run.id, runs, workflows);
      expect(out).toContain(
        "Cannot run 'x' (precondition): Precondition failed for step 'x'. Precondition failed: 'nothing.ok == true'. Resolved value: undefined.",
      );
      expect(out).not.toContain('Owed to the engine');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("#625 PR-2a — listen's sweeper names the owed steps an expiry leaves", () => {
  it('the enacted-expiry log line gains `owed`', async () => {
    const { home, runs, workflows } = stores();
    try {
      const d = wf('sweep-owed-wf', {
        confirm: {
          description: 'C',
          execution: 'auto',
          trust: 'human_confirmed',
          depends_on: [],
          gate: {
            choices: ['approve'],
            timeout_seconds: 1,
            on_expiry: 'settle_default',
            default_choice: 'approve',
          },
        },
        after: { description: 'A', execution: 'auto', depends_on: ['confirm'] },
      });
      await workflows.register(d);
      const { run } = await runs.create({ workflowId: d.id, workflowVersion: 1, params: {} });
      await executeStep(runs, d, {
        runId: run.id,
        command: 'confirm',
        input: {},
        dispatcher: async () => ({}),
      });
      const logged: Array<[string, unknown]> = [];
      const logger = {
        info: (m: string, f?: unknown) => logged.push([m, f]),
        warn: () => {},
        error: () => {},
      };
      await sweepExpiredGates(
        { runStore: runs, workflowStore: workflows, logger } as never,
        new Date(Date.now() + 3_600_000),
      );
      const line = logged.find(([m]) => m === 'listen: sweeper enacted an expired gate');
      expect((line?.[1] as Record<string, unknown>)['owed']).toEqual(['after']);
      expect(describePending(d, await runs.get(run.id)).act).toBeDefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
