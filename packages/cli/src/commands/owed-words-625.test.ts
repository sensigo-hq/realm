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
  submitHumanResponse,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  type RunRecord,
  type WorkflowDefinition,
  type ExtensionIdentityEntry,
} from '@sensigo/realm';
import { FIT_WORDS, fitWords, stoppedReasons, advanceRunFromShell } from './run-advance.js';
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
    const none = {
      agent_actions: [],
      agent_steps: [],
      agent_refused: [],
      pending_guards: [],
      engine_runnable: [],
      cannot_run: [],
    };
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
        cannot_run: [
          { step: 'x', runnable_here: false, refused_by: 'trust', refusal: 'bad trust' },
          { step: 'y', runnable_here: false, refused_by: 'precondition', refusal: 'no' },
        ],
      }),
    ).toEqual(["'x' cannot run (trust): bad trust", "'y' cannot run (precondition): no"]);
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
        cannot_run: [
          { step: 'x', runnable_here: false, refused_by: 'trust', refusal: 'bad trust' },
        ],
      }),
    ).toEqual([
      "'x' cannot run (trust): bad trust",
      "an agent step is ready: 'a' — drive it with realm agent --run-id r",
    ]);
    expect(stoppedReasons('r', base, none)).toEqual(['nothing is ready to run now']);
  });

  it('C59: one ready agent step is said in the singular (an agent step is ready … drive it), two in the plural (agent steps are ready … drive them)', () => {
    const base = {
      terminal_state: false,
      completed_steps: [],
      in_progress_steps: [],
      failed_steps: [],
      skipped_steps: [],
      evidence: [],
    } as unknown as RunRecord;
    const none = {
      agent_actions: [],
      agent_steps: [],
      agent_refused: [],
      pending_guards: [],
      engine_runnable: [],
      cannot_run: [],
    };
    expect(stoppedReasons('r', base, { ...none, agent_steps: ['ask'] })).toEqual([
      "an agent step is ready: 'ask' — drive it with realm agent --run-id r",
    ]);
    expect(stoppedReasons('r', base, { ...none, agent_steps: ['a', 'b'] })).toEqual([
      "agent steps are ready: 'a', 'b' — drive them with realm agent --run-id r",
    ]);
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
        `Stopped: an agent step is ready: 'y' — drive it with realm agent --run-id ${run.id}`,
        `Run ${run.id}: phase 'running'`,
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('C23: a capability block is a step that cannot run here (capability), never "failed"; exit 1 (nothing owed)', async () => {
    const { home, runs, workflows } = stores();
    try {
      const d = wf('cap-advance-wf', {
        x: { description: 'X', execution: 'auto', depends_on: [], handler: 'missing_h' },
        y: { description: 'Y', execution: 'agent', depends_on: [] },
      });
      await workflows.register(d);
      const { run } = await runs.create({ workflowId: d.id, workflowVersion: 1, params: {} });
      const lines: string[] = [];
      const code = await advanceRunFromShell(
        run.id,
        { project: home },
        runs,
        workflows,
        undefined,
        (l) => lines.push(l),
        new ExtensionRegistry(),
      );
      // The view, judged with this shell's registry, refuses `x` before any attempt: `x` is still owed
      // but cannot run here (decision C43), and the refusal is a reason the run cannot move here —
      // exit 1, as after a call that ran.
      expect(code).toBe(1);
      expect(lines.slice(3)).toEqual([
        `The engine can run nothing now: 'x' cannot run here (capability): handler 'missing_h' is not registered here — load the missing extension, or run the step on a runner that has it; an agent step is ready: 'y' — drive it with realm agent --run-id ${run.id}.`,
      ]);
      expect(lines.join('\n')).not.toContain('failed');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('C23: the capability-once attempt during an advance is named as a step that cannot run here (capability), never "failed"; exit 1', async () => {
    const { home, runs, workflows } = stores();
    try {
      const d = wf('cap-attempt-wf', {
        x: { description: 'X', execution: 'auto', depends_on: [], handler: 'missing_h' },
        b: { description: 'B', execution: 'auto', depends_on: [] },
        y: { description: 'Y', execution: 'agent', depends_on: [] },
      });
      await workflows.register(d);
      const { run } = await runs.create({ workflowId: d.id, workflowVersion: 1, params: {} });
      const lines: string[] = [];
      const code = await advanceRunFromShell(
        run.id,
        { project: home },
        runs,
        workflows,
        undefined,
        (l) => lines.push(l),
        new ExtensionRegistry(),
      );
      expect(code).toBe(1);
      expect(lines.slice(3)).toEqual([
        "Owed to the engine: 'b'.",
        // Every owed step runs first; then the one capability attempt (the marker) stops the call.
        '→ b',
        '→ x',
        "Stopped: 'x' cannot run here (capability): handler 'missing_h' is not registered here — load the missing extension, or run the step on a runner that has it",
        `Stopped: an agent step is ready: 'y' — drive it with realm agent --run-id ${run.id}`,
        `Run ${run.id}: phase 'running'`,
      ]);
      expect(lines.join('\n')).not.toContain('failed');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('C25: a step another process claimed during advance is said with the D6.1 line, never "cannot run here"', async () => {
    const { home, runs, workflows } = stores();
    try {
      const d = wf('taken-wf', {
        x: { description: 'X', execution: 'auto', depends_on: [] },
        y: { description: 'Y', execution: 'agent', depends_on: ['x'] },
      });
      await workflows.register(d);
      const { run } = await runs.create({ workflowId: d.id, workflowVersion: 1, params: {} });
      const realClaim = runs.claimStep.bind(runs);
      let first = true;
      runs.claimStep = async (...args: Parameters<JsonFileStore['claimStep']>) => {
        if (first) {
          first = false;
          await realClaim(args[0], args[1], args[2], {
            by: 'other@host',
            by_source: 'derived',
            channel: 'agent',
          });
        }
        return realClaim(...args);
      };
      const lines: string[] = [];
      const code = await advanceRunFromShell(
        run.id,
        { project: home },
        runs,
        workflows,
        undefined,
        (l) => lines.push(l),
        new ExtensionRegistry(),
      );
      const since = (await runs.get(run.id)).claims?.['x']?.since;
      expect(code).toBe(0);
      expect(lines.slice(4)).toEqual([
        '→ x',
        `• Step 'x' was taken by other@host (from the OS user, via agent) at ${since}; not run here.`,
        // decision C37: the step the other process holds is the reason — not "nothing is ready"; the
        // holder and the time are on the taken line above, printed once (decision C43).
        `Stopped: 'x' is in flight in another program — wait for it, or see realm run inspect ${run.id}`,
        `Run ${run.id}: phase 'running'`,
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('C28: a guard the advance loop settled that ended the run — its sentence, then PR-1’s Reason line', async () => {
    const { home, runs: json, workflows } = stores();
    try {
      const d = wf('guard-end-wf', {
        confirm: {
          description: 'Confirm',
          execution: 'auto',
          trust: 'human_confirmed',
          depends_on: [],
          gate: { choices: ['approve', 'reject'] },
        },
        check: {
          description: 'Check',
          execution: 'guard',
          depends_on: ['confirm'],
          abort_unless: ["confirm.choice == 'approve'"],
          abort_message: 'Not approved by the reviewer.',
        },
        finish: { description: 'Finish', execution: 'agent', depends_on: ['check'] },
      });
      await workflows.register(d);
      // The same store with `settleStep` hidden — the legacy two-write shape, where the answer
      // leaves the guard pending and the advance loop settles it (its replies carry no `ended_by`).
      const runs = new Proxy(json, {
        get(target, prop, receiver) {
          if (prop === 'settleStep') return undefined;
          const v = Reflect.get(target, prop, receiver) as unknown;
          return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        },
      }) as unknown as JsonFileStore;
      const { run } = await runs.create({ workflowId: d.id, workflowVersion: 1, params: {} });
      await executeStep(runs, d, {
        runId: run.id,
        command: 'confirm',
        input: {},
        dispatcher: async () => ({}),
      });
      const gate = (await runs.get(run.id)).pending_gate!;
      await submitHumanResponse(runs, d, { runId: run.id, gateId: gate.gate_id, choice: 'reject' });
      const lines: string[] = [];
      const code = await advanceRunFromShell(
        run.id,
        { project: home },
        runs,
        workflows,
        undefined,
        (l) => lines.push(l),
        new ExtensionRegistry(),
      );
      expect(code).toBe(0);
      const ending = lines.slice(4);
      expect(ending.slice(1, 2)).toEqual(['Reason: Not approved by the reviewer.']);
      expect(ending[0]).toContain("'check'");
      expect(ending.slice(2)).toEqual([
        'Stopped: the run has ended (aborted)',
        `Run ${run.id}: phase 'aborted'`,
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

describe('#625 PR-2a, C37 — realm run advance and respond: the words after the walk', () => {
  it('a run the call completes gets no `Stopped:` line — the phase line says it', async () => {
    const { home, runs, workflows } = stores();
    try {
      const d = wf('completes-wf', {
        a: { description: 'A', execution: 'auto', depends_on: [] },
      });
      await workflows.register(d);
      const { run } = await runs.create({ workflowId: d.id, workflowVersion: 1, params: {} });
      const lines: string[] = [];
      const code = await advanceRunFromShell(
        run.id,
        { project: home },
        runs,
        workflows,
        undefined,
        (l) => lines.push(l),
        new ExtensionRegistry(),
      );
      expect(code).toBe(0);
      expect(lines.slice(3)).toEqual([
        "Owed to the engine: 'a'.",
        '→ a',
        `Run ${run.id}: phase 'completed'`,
      ]);
      expect(lines.some((l) => l.startsWith('Stopped:'))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('a step another program holds: the preview says `In flight:`, and the reason replaces "nothing is ready"', async () => {
    const { home, runs, workflows } = stores();
    try {
      const d = wf('held-wf', { x: { description: 'X', execution: 'auto', depends_on: [] } });
      await workflows.register(d);
      const { run } = await runs.create({ workflowId: d.id, workflowVersion: 1, params: {} });
      await runs.claimStep(run.id, 'x', d, {
        by: 'other@host',
        by_source: 'derived',
        channel: 'advance',
      });
      const since = (await runs.get(run.id)).claims?.['x']?.since;
      expect(since).toBeDefined();
      const lines: string[] = [];
      const code = await advanceRunFromShell(
        run.id,
        { project: home },
        runs,
        workflows,
        undefined,
        (l) => lines.push(l),
        new ExtensionRegistry(),
      );
      expect(code).toBe(0);
      expect(lines.slice(3)).toEqual([
        `In flight: 'x' is in flight, taken by other@host (from the OS user, via advance) since ${since}.`,
        // decision C43: `x` is still owed; the holder and the time are on the line above, once.
        `The engine can run nothing now: 'x' is in flight in another program — wait for it, or see realm run inspect ${run.id}.`,
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('a reason that ends with a full stop gets no second one', async () => {
    const { home, runs, workflows } = stores();
    try {
      const d = wf('stop-wf', {
        a: {
          description: 'A',
          execution: 'auto',
          depends_on: [],
          preconditions: ['nothing.ok == true'],
        },
      });
      await workflows.register(d);
      const { run } = await runs.create({ workflowId: d.id, workflowVersion: 1, params: {} });
      const lines: string[] = [];
      const code = await advanceRunFromShell(
        run.id,
        { project: home },
        runs,
        workflows,
        undefined,
        (l) => lines.push(l),
        new ExtensionRegistry(),
      );
      expect(code).toBe(1);
      expect(lines.slice(-2)).toEqual([
        "The engine can run nothing now: 'a' cannot run (precondition): Precondition failed for step 'a'. Precondition failed: 'nothing.ok == true'. Resolved value: undefined.",
        `Run ${run.id} stays open (phase 'running'): correct the workflow, register it again, then realm run advance ${run.id}; or end it: realm run abandon ${run.id}.`,
      ]);
      expect(lines.join('\n')).not.toContain('..');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("respond's owed line: `runs it` for one step, `runs them` for two", async () => {
    const { respondToGate } = await import('./respond.js');
    for (const [owed, them] of [
      [['after'], 'it'],
      [['after', 'also'], 'them'],
    ] as const) {
      const { home, runs, workflows } = stores();
      try {
        const steps: WorkflowDefinition['steps'] = {
          confirm: {
            description: 'C',
            execution: 'auto',
            trust: 'human_confirmed',
            depends_on: [],
            gate: { choices: ['approve', 'reject'] },
          },
        };
        for (const name of owed) {
          steps[name] = { description: name, execution: 'auto', depends_on: ['confirm'] };
        }
        const d = wf(`respond-${owed.length}`, steps);
        await workflows.register(d);
        const { run } = await runs.create({ workflowId: d.id, workflowVersion: 1, params: {} });
        await executeStep(runs, d, {
          runId: run.id,
          command: 'confirm',
          input: {},
          dispatcher: async () => ({}),
        });
        const gate = (await runs.get(run.id)).pending_gate!;
        const out = await respondToGate(
          run.id,
          { gate: gate.gate_id, choice: 'approve' },
          runs,
          workflows,
          new ExtensionRegistry(),
        );
        expect(out.lastLine.split('\n')[1]).toBe(
          `Owed to the engine: ${owed.map((n) => `'${n}'`).join(', ')} — realm run advance ${run.id} runs ${them} from this shell.`,
        );
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    }
  });
});

describe('#625 PR-2a, C43 and C44 — realm run advance: the opening says whether anything is owed; one way out', () => {
  const advance = async (
    runs: JsonFileStore,
    workflows: JsonWorkflowStore,
    home: string,
    runId: string,
  ): Promise<{ code: 0 | 1; lines: string[] }> => {
    const lines: string[] = [];
    const code = await advanceRunFromShell(
      runId,
      { project: home },
      runs,
      workflows,
      undefined,
      (l) => lines.push(l),
      new ExtensionRegistry(),
    );
    return { code, lines };
  };

  it('C43: nothing owed (the run ended) — `Nothing is owed to the engine: …`, exit 0', async () => {
    const { home, runs, workflows } = stores();
    try {
      const d = wf('c43-ended', { x: { description: 'X', execution: 'auto', depends_on: [] } });
      await workflows.register(d);
      const { run } = await runs.create({ workflowId: d.id, workflowVersion: 1, params: {} });
      expect((await advance(runs, workflows, home, run.id)).code).toBe(0);
      const again = await advance(runs, workflows, home, run.id);
      expect(again.code).toBe(0);
      expect(again.lines.slice(3)).toEqual([
        'Nothing is owed to the engine: the run has ended (completed).',
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  for (const [check, step, refusal] of [
    [
      'trust',
      { description: 'X', execution: 'auto', depends_on: [], trust: 'not_a_level' as never },
      // decision C49: the view's read-time voice, never the dispatch voice (nothing was dispatched).
      "'trust: \"not_a_level\"' is not a recognized value — the engine will refuse this step at dispatch (VALIDATION_TRUST_VALUE). Accepts auto, human_confirmed, human_reviewed — correct the value and 'realm workflow register <path>'.",
    ],
    [
      'precondition',
      {
        description: 'X',
        execution: 'auto',
        depends_on: [],
        preconditions: ['nothing.ok == true'],
      },
      "Precondition failed for step 'x'.",
    ],
    [
      'input_schema',
      {
        description: 'X',
        execution: 'auto',
        depends_on: [],
        input_schema: { type: 'object', required: ['n'] },
      },
      "Invalid input for step 'x': the input must have required property 'n'",
    ],
  ] as const) {
    it(`C43, C44 (${check}): owed but cannot run — \`The engine can run nothing now: …\`, then the one way out; exit 1`, async () => {
      const { home, runs, workflows } = stores();
      try {
        const d = wf(`c43-${check}`, {
          x: step as unknown as WorkflowDefinition['steps'][string],
        });
        await workflows.register(d);
        const { run } = await runs.create({ workflowId: d.id, workflowVersion: 1, params: {} });
        const { code, lines } = await advance(runs, workflows, home, run.id);
        expect(code).toBe(1);
        expect(lines).toHaveLength(5);
        expect(
          lines[3]!.startsWith(`The engine can run nothing now: 'x' cannot run (${check}): `),
        ).toBe(true);
        expect(lines[3]).toContain(refusal);
        expect(lines[4]).toBe(
          `Run ${run.id} stays open (phase 'running'): correct the workflow, register it again, then realm run advance ${run.id}; or end it: realm run abandon ${run.id}.`,
        );
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  }

  it('C44 after a call: the run stops on a step refused before its claim with nothing else ready — the way out is the last line, in place of the phase line', async () => {
    const { home, runs, workflows } = stores();
    try {
      const d = wf('c44-after', {
        a: { description: 'A', execution: 'auto', depends_on: [], trust: 'not_a_level' as never },
        b: { description: 'B', execution: 'auto', depends_on: [] },
      });
      await workflows.register(d);
      const { run } = await runs.create({ workflowId: d.id, workflowVersion: 1, params: {} });
      const { code, lines } = await advance(runs, workflows, home, run.id);
      expect(code).toBe(1);
      expect(lines.slice(3, 5)).toEqual(["Owed to the engine: 'b'.", '→ b']);
      expect(lines[5]!.startsWith("Stopped: 'a' cannot run (trust): ")).toBe(true);
      expect(lines.slice(6)).toEqual([
        `Run ${run.id} stays open (phase 'running'): correct the workflow, register it again, then realm run advance ${run.id}; or end it: realm run abandon ${run.id}.`,
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('C44: no way out while something else is ready (an agent step) — the phase line stays', async () => {
    const { home, runs, workflows } = stores();
    try {
      const d = wf('c44-agent', {
        a: { description: 'A', execution: 'auto', depends_on: [], trust: 'not_a_level' as never },
        y: { description: 'Y', execution: 'agent', depends_on: [] },
      });
      await workflows.register(d);
      const { run } = await runs.create({ workflowId: d.id, workflowVersion: 1, params: {} });
      const { lines } = await advance(runs, workflows, home, run.id);
      expect(lines.join('\n')).not.toContain('correct the workflow');
      expect(lines[3]!.startsWith("The engine can run nothing now: 'a' cannot run (trust): ")).toBe(
        true,
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("C43: stoppedReasons' in-flight member — no holder or time, what to do", () => {
    const run = {
      id: 'r',
      params: {},
      completed_steps: [],
      in_progress_steps: ['z'],
      failed_steps: [],
      skipped_steps: [],
      evidence: [],
      terminal_state: false,
    } as unknown as RunRecord;
    expect(
      stoppedReasons('r', run, {
        agent_actions: [],
        agent_steps: [],
        agent_refused: [],
        pending_guards: [],
        engine_runnable: [],
        cannot_run: [],
      }),
    ).toEqual(["'z' is in flight in another program — wait for it, or see realm run inspect r"]);
  });
});

describe('#625 PR-2a, C46 — inspect reads the record alone', () => {
  it('inspect is unchanged: a run another runner marked keeps its capability_block finding and the past-tense line (no registry is consulted)', async () => {
    const { home, runs, workflows } = stores();
    try {
      const d = wf('c46-inspect', {
        x: { description: 'X', execution: 'auto', depends_on: [], handler: 'missing_h' },
      });
      await workflows.register(d);
      const { run } = await runs.create({ workflowId: d.id, workflowVersion: 1, params: {} });
      const { advanceRun } = await import('@sensigo/realm');
      await advanceRun(runs, d, { runId: run.id, registry: new ExtensionRegistry() });
      // eslint-disable-next-line no-control-regex
      const screen = (await inspectRun(run.id, runs, workflows)).replace(/\x1b\[[0-9;]*m/g, '');
      const lines = screen.split('\n');
      expect(lines).toContain('Run Health (1 finding(s)):');
      expect(lines).toContain('  capability_block [x]: ENGINE_HANDLER_NOT_REGISTERED');
      expect(lines).toContain(
        `Could not run 'x' (capability): handler 'missing_h' was not registered in the runner that last attempted it — from a program that has it: realm run advance ${run.id}`,
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('#625 PR-2a, round 6 — the count words (C55), the fit words (C56), and the trust voice and the capability way out on inspect (C49, C53)', () => {
  const identity = (rules = 'r1'): ExtensionIdentityEntry =>
    ({
      captured_at: 't',
      modules: [{ declared: 'x', resolved: '/x', entry_hash: 'h', format: 'esm' }],
      tree: {
        roots: ['/'],
        rules,
        file_count: 1,
        total_bytes: 1,
        tree_hash: 'T',
        truncated: false,
      },
      coverage: 'dir_tree_v1',
    }) as ExtensionIdentityEntry;
  const preview = async (
    runs: JsonFileStore,
    workflows: JsonWorkflowStore,
    home: string,
    runId: string,
    registry: ExtensionRegistry,
  ): Promise<string[]> => {
    const lines: string[] = [];
    await advanceRunFromShell(
      runId,
      { project: home },
      runs,
      workflows,
      undefined,
      (l) => lines.push(l),
      registry,
    );
    return lines;
  };

  it("C56: not_comparable says why when the run has recorded no project code yet; the table's words otherwise", () => {
    expect(fitWords('not_comparable', {})).toBe(
      'not comparable — the run has recorded no project code yet',
    );
    expect(fitWords('not_comparable', { extension_identity: [identity()] })).toBe(
      "not comparable with the run's last record",
    );
    for (const fit of ['same', 'differs', 'none'] as const) {
      expect(fitWords(fit, {})).toBe(FIT_WORDS[fit]);
    }
  });

  it('C56 on the preview: a fresh run from a program with project code, then a run whose record was taken under other rules', async () => {
    const { home, runs, workflows } = stores();
    try {
      const d = wf('c56', { ask: { description: 'Ask', execution: 'agent', depends_on: [] } });
      await workflows.register(d);
      const registry = new ExtensionRegistry();
      registry.setIdentity(identity());
      const { run } = await runs.create({ workflowId: d.id, workflowVersion: 1, params: {} });
      expect((await preview(runs, workflows, home, run.id, registry))[1]).toBe(
        'This program: no name could be recorded · project code: not comparable — the run has recorded no project code yet.',
      );
      const stored = await runs.get(run.id);
      await runs.update({ ...stored, extension_identity: [identity('r2')] });
      expect((await preview(runs, workflows, home, run.id, registry))[1]).toBe(
        "This program: no name could be recorded · project code: not comparable with the run's last record.",
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('C55: `drive it` for one ready agent step, `drive them` for two', async () => {
    const { home, runs, workflows } = stores();
    try {
      const one = wf('c55-one', { a: { description: 'A', execution: 'agent', depends_on: [] } });
      const two = wf('c55-two', {
        a: { description: 'A', execution: 'agent', depends_on: [] },
        b: { description: 'B', execution: 'agent', depends_on: [] },
      });
      for (const d of [one, two]) await workflows.register(d);
      const r1 = (await runs.create({ workflowId: one.id, workflowVersion: 1, params: {} })).run;
      const r2 = (await runs.create({ workflowId: two.id, workflowVersion: 1, params: {} })).run;
      expect((await preview(runs, workflows, home, r1.id, new ExtensionRegistry())).at(-1)).toBe(
        `Nothing is owed to the engine: an agent step is ready: 'a' — drive it with realm agent --run-id ${r1.id}.`,
      );
      expect((await preview(runs, workflows, home, r2.id, new ExtensionRegistry())).at(-1)).toBe(
        `Nothing is owed to the engine: agent steps are ready: 'a', 'b' — drive them with realm agent --run-id ${r2.id}.`,
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('C49 on inspect: a trust-refused step is named in the read-time voice', async () => {
    const { home, runs, workflows } = stores();
    try {
      const d = wf('c49-inspect', {
        x: { description: 'X', execution: 'auto', depends_on: [], trust: 'nope' as never },
      });
      await workflows.register(d);
      const { run } = await runs.create({ workflowId: d.id, workflowVersion: 1, params: {} });
      // eslint-disable-next-line no-control-regex
      const screen = (await inspectRun(run.id, runs, workflows)).replace(/\x1b\[[0-9;]*m/g, '');
      expect(screen.split('\n')).toContain(
        "Cannot run 'x' (trust): 'trust: \"nope\"' is not a recognized value — the engine will refuse this step at dispatch (VALIDATION_TRUST_VALUE). Accepts auto, human_confirmed, human_reviewed — correct the value and 'realm workflow register <path>'.",
      );
      expect(screen).not.toContain('parked');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
