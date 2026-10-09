// owed-words-625.test.ts — issue #625 PR-2a: whole-message pins for the CLI words the owed call mints
// that no journey cell reaches: `realm run advance`'s fit words, identity and driver words and every
// `Stopped:` reason; `inspect`'s refused-step line; listen's sweeper `owed` field.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  answerAction,
  abandonRun,
  advanceRun,
  reclaimStep,
  loadWorkflowFromString,
  WorkflowError,
  type Attributed,
  type StepHandlerResult,
} from '@sensigo/realm';
import { FIT_WORDS, fitWords, stoppedReasons, advanceRunFromShell } from './run-advance.js';
import { inspectRun } from './inspect.js';
import { resumeRun } from './resume.js';
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
    // decision C103: the open question's line is rendered from an answer act core composes (its
    // gate) — after a call the reply's; at the preview, `answerAction` from the record read (F7 (a));
    // F6: its choices are read from the record's open question with that gate id (structured, never
    // split off the act's `<a|b>` text) — a choice holding `|` stays one choice, each quoted.
    const atQuestion = {
      ...base,
      pending_gate: {
        gate_id: 'g2',
        step_name: 's',
        choices: ['x|y', 'z'],
        opened_at: '',
        preview: {},
      },
    } as RunRecord;
    expect(
      stoppedReasons('r', atQuestion, none, [
        answerAction('r', { step: 's', gate_id: 'g2', choices: ['x|y', 'z'] }),
      ]),
    ).toEqual(["a question is open — realm run respond r --gate g2 --choice <one of: 'x|y', z>"]);
    // F6: an act naming a question the record does not hold gives no command (its choices are the
    // record's to give) — (a) red when the act's own text is split for them again; (b) prints it.
    expect(
      stoppedReasons(
        'r',
        { ...atQuestion, pending_gate: { ...atQuestion.pending_gate!, gate_id: 'g1' } },
        none,
        [answerAction('r', { step: 's', gate_id: 'g2', choices: ['x|y', 'z'] })],
      ),
    ).toEqual(['a question is open — see realm run inspect r']);
    // (a) red when a reply with no answer act still prints a respond command; (b) prints the reason.
    expect(stoppedReasons('r', atQuestion, none)).toEqual([
      'a question is open — see realm run inspect r',
    ]);
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
      "agent steps are ready: 'a', 'b' — drive them with realm agent --run-id r --provider <provider> --model <model>",
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
      "an agent step is ready: 'a' — drive it with realm agent --run-id r --provider <provider> --model <model>",
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
      "an agent step is ready: 'ask' — drive it with realm agent --run-id r --provider <provider> --model <model>",
    ]);
    expect(stoppedReasons('r', base, { ...none, agent_steps: ['a', 'b'] })).toEqual([
      "agent steps are ready: 'a', 'b' — drive them with realm agent --run-id r --provider <provider> --model <model>",
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
        `Stopped: an agent step is ready: 'y' — drive it with realm agent --run-id ${run.id} --provider <provider> --model <model>`,
        // decision C181: the waiting-process line `realm run respond` prints after its commands.
        'If a realm workflow run or realm agent is still waiting on this run, it goes on by itself; the line above is for when none is.',
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
        // decision C212: several reasons are each a line of their own; a line that ends with a
        // command has no full stop.
        'The engine can run nothing now:',
        "  'x' cannot run here (capability): handler 'missing_h' is not registered here — load the missing extension, or run the step on a runner that has it.",
        `  an agent step is ready: 'y' — drive it with realm agent --run-id ${run.id} --provider <provider> --model <model>`,
        // decision C181: the waiting-process line follows a preview line that names an agent step.
        'If a realm workflow run or realm agent is still waiting on this run, it goes on by itself; the line above is for when none is.',
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
        `Stopped: an agent step is ready: 'y' — drive it with realm agent --run-id ${run.id} --provider <provider> --model <model>`,
        // decision C181: the waiting-process line `realm run respond` prints after its commands.
        'If a realm workflow run or realm agent is still waiting on this run, it goes on by itself; the line above is for when none is.',
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
        // decision C109: the command renders its reply's warnings — this fixture's store is a
        // legacy one (no settleStep), whose advisory the reply carries.
        '⚠ settled via the legacy compatibility path — this store does not declare atomic settlement (RunStore.settleStep); upgrade the store to close the fan-out seal race (issue #279)',
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
      expect(describePending(d, await runs.get(run.id), undefined, new Date()).act).toBeDefined();
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
        `The engine can run nothing now: 'x' is in flight in another program — wait for it, or see realm run inspect ${run.id}`,
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
        `Run ${run.id} stays open (phase 'running'): correct the workflow, register it again, then realm run advance ${run.id} — or end it: realm run abandon ${run.id}`,
      ]);
      expect(lines.join('\n')).not.toContain('..');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("respond's owed line: `runs it` for one step, `runs them` for two", async () => {
    // decision C207: for two, the words go on with where that call stops.
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
          `Owed to the engine: ${owed.map((n) => `'${n}'`).join(', ')} — realm run advance ${run.id} runs ${them}${them === 'them' ? ' until a step opens a question, fails or ends the run' : ''}, with the project code under the folder it runs in (or its --project), in the environment of the shell it runs in.`,
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
          `Run ${run.id} stays open (phase 'running'): correct the workflow, register it again, then realm run advance ${run.id} — or end it: realm run abandon ${run.id}`,
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
        `Run ${run.id} stays open (phase 'running'): correct the workflow, register it again, then realm run advance ${run.id} — or end it: realm run abandon ${run.id}`,
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
      // decision C212: several reasons — each on a line of its own, under the opening.
      expect([lines[3], lines[4]!.startsWith("  'a' cannot run (trust): ")]).toEqual([
        'The engine can run nothing now:',
        true,
      ]);
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
      // decision C181: the waiting-process line follows the preview's ready line.
      expect((await preview(runs, workflows, home, r1.id, new ExtensionRegistry())).at(-2)).toBe(
        `Nothing is owed to the engine: an agent step is ready: 'a' — drive it with realm agent --run-id ${r1.id} --provider <provider> --model <model>`,
      );
      expect((await preview(runs, workflows, home, r2.id, new ExtensionRegistry())).at(-2)).toBe(
        `Nothing is owed to the engine: agent steps are ready: 'a', 'b' — drive them with realm agent --run-id ${r2.id} --provider <provider> --model <model>`,
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

describe('#625 PR-2a, round 24 (the architect, m174a) — the guard line when another program ends the run', () => {
  it('a guard that passed is said as passed when another program ends the run after it (the record names no guard as the ending), never as the run’s ending', async () => {
    const { home, runs, workflows } = stores();
    try {
      const d = loadWorkflowFromString(
        [
          'id: adv-guard-then-abandoned',
          'name: adv-guard-then-abandoned',
          'version: 1',
          'steps:',
          '  x:',
          '    description: X.',
          '    execution: auto',
          '    handler: ok',
          '  g:',
          '    description: G.',
          '    execution: guard',
          '    depends_on: [x]',
          '    abort_unless: ["x.ok == true"]',
          '  y:',
          '    description: Y.',
          '    execution: agent',
          '    depends_on: [g]',
        ].join('\n'),
      );
      await workflows.register(d);
      const { run } = await runs.create({ workflowId: d.id, workflowVersion: 1, params: {} });
      const registry = new ExtensionRegistry();
      registry.register('handler', 'ok', {
        id: 'ok',
        execute: async () => ({ data: { ok: true } }),
      });
      // Another program abandons the run in the moment after the guard's write: the first read that
      // finds `g` settled abandons the run first, as a second terminal's `realm run abandon` would.
      let abandoned = false;
      const racing = new Proxy(runs, {
        get(target, prop) {
          if (prop === 'get') {
            return async (id: string): Promise<RunRecord> => {
              const rec = await target.get(id);
              if (!abandoned && rec.completed_steps.includes('g')) {
                abandoned = true;
                await abandonRun(target, id, 'another program');
                return target.get(id);
              }
              return rec;
            };
          }
          const v = Reflect.get(target, prop, target) as unknown;
          return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        },
      });
      const lines: string[] = [];
      await advanceRunFromShell(
        run.id,
        { project: home },
        racing,
        workflows,
        undefined,
        (l) => lines.push(l),
        registry,
      );
      // CONTROL: the race happened, and no guard ended the run.
      expect(abandoned).toBe(true);
      const after = await runs.get(run.id);
      expect(after.terminal_state).toBe(true);
      expect(after.abandoned_at).toBeDefined();
      // The guard passed (the record says so), and the command says so; it never prints a guard
      // ending for a run that another program ended.
      expect(lines, lines.join('\n')).toContain("Guard step 'g' passed.");
      expect(lines.join('\n')).not.toMatch(/Guard step 'g' (aborted|ended|completed)/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const ACTING = 'docs/reference/cli/realm-run-acting.md';
const flat = (t: string): string => t.replace(/\s+/g, ' ');

/** (a) red when the page no longer holds the sentence word for word; (b) prints the sentence. */
function claim(page: string, sentence: string): void {
  expect(
    flat(readFileSync(join(ROOT, page), 'utf8')),
    `${page} no longer says: ${sentence}`,
  ).toContain(flat(sentence));
}

/** The lines of the page's first fenced block that holds `marker`. */
function block(page: string, marker: string): string[] {
  const text = readFileSync(join(ROOT, page), 'utf8');
  const blocks = text.split(/^```[a-z]*\n/m).filter((_, i) => i % 2 === 1);
  const found = blocks.find((b) => b.includes(marker));
  if (found === undefined) throw new Error(`${page} has no block with: ${marker}`);
  return found.replace(/\n```[\s\S]*$/, '').split('\n');
}

describe('#625 PR-2a, round 25 — C194 (walk c10, W1-2): realm run advance when another program settles or takes over the step it is running', () => {
  const RACER: Attributed = { by: 'racer-b', by_source: 'ambient', channel: 'advance' };
  const RACER_WORDS = 'racer-b (from REALM_OPERATOR, via advance)';
  type Kase = 'ran-all' | 'ran-it' | 'failed' | 'held' | 'released' | 'aborted';

  /**
   * `process` (auto) then `notify` (auto, after it). While this command's `process` handler runs,
   * another program acts on the same store first: `realm run reclaim --force` frees this program's
   * claim (`reclaimStep`), then the other program runs the step (and, for `ran-all`, the rest), takes
   * it and holds it, or does nothing more. `refusals` is what the store answered this program's own
   * settle of `process`.
   */
  async function race(kase: Kase, warnFirst = false) {
    const { home, runs, workflows } = stores();
    const d = loadWorkflowFromString(
      [
        `id: adv-race-${kase}`,
        `name: adv-race-${kase}`,
        'version: 1',
        'steps:',
        ...(warnFirst
          ? ['  prep:', '    description: Prep.', '    execution: auto', '    handler: warns']
          : []),
        '  process:',
        '    description: Process.',
        '    execution: auto',
        '    handler: slow',
        ...(warnFirst ? ['    depends_on: [prep]'] : []),
        '  notify:',
        '    description: Notify.',
        '    execution: auto',
        '    handler: quick',
        '    depends_on: [process]',
      ].join('\n'),
    );
    await workflows.register(d);
    const { run } = await runs.create({ workflowId: d.id, workflowVersion: 1, params: {} });
    const other = new ExtensionRegistry();
    other.register('handler', 'slow', {
      id: 'slow',
      execute: async () => {
        if (kase === 'failed') throw new Error('it broke there');
        if (kase === 'aborted') return { abort: { message: 'stopped there' } };
        return { data: { by: 'racer-b' } };
      },
    });
    other.register('handler', 'quick', { id: 'quick', execute: async () => ({ data: {} }) });
    let handlerRuns = 0;
    const here = new ExtensionRegistry();
    here.register('handler', 'slow', {
      id: 'slow',
      execute: async () => {
        handlerRuns += 1;
        if (handlerRuns > 1) return { data: { by: 'here' } };
        await reclaimStep(runs, run.id, 'process');
        if (kase === 'ran-all') {
          await advanceRun(runs, d, {
            runId: run.id,
            caller: 'advance',
            registry: other,
            driver: RACER,
          });
        } else if (kase === 'ran-it' || kase === 'failed' || kase === 'aborted') {
          await executeStep(runs, d, {
            runId: run.id,
            command: 'process',
            input: {},
            // `process` has a handler: the engine runs it, not this dispatcher.
            dispatcher: async () => ({}),
            registry: other,
            driver: RACER,
          });
        } else if (kase === 'held') {
          await runs.claimStep(run.id, 'process', d, RACER);
        }
        return { data: { by: 'here' } };
      },
    });
    here.register('handler', 'quick', { id: 'quick', execute: async () => ({ data: {} }) });
    here.register('handler', 'warns', {
      id: 'warns',
      execute: async () => ({ data: {}, warn: { message: 'prep warned' } }),
    });
    // What the store answers this program's own settle of `process` (the race's code).
    const refusals: string[] = [];
    const watched = new Proxy(runs, {
      get(target, prop) {
        if (prop === 'settleStep') {
          return async (...a: Parameters<NonNullable<JsonFileStore['settleStep']>>) => {
            const r = await target.settleStep!(...a);
            if (a[1].kind === 'settle_step' && a[1].step === 'process' && !r.applied) {
              refusals.push(r.reason);
            }
            return r;
          };
        }
        const v = Reflect.get(target, prop, target) as unknown;
        return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(target) : v;
      },
    });
    try {
      const lines: string[] = [];
      const code = await advanceRunFromShell(
        run.id,
        { project: home },
        watched,
        workflows,
        undefined,
        (l) => lines.push(l),
        here,
      );
      const after = await runs.get(run.id);
      return {
        id: run.id,
        code,
        refusals,
        handlerRuns,
        since: after.claims?.['process']?.since,
        lines: lines.slice(lines.indexOf('→ process')),
        after,
      };
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }

  const NOT_RECORDED = "this program's outcome for it was not recorded";

  it('the page’s screen: another program ran the step (STATE_STEP_ALREADY_SETTLED) — the line from the record, never "failed", and the command goes on with what is left; exit 0', async () => {
    claim(
      ACTING,
      "When another program settles the step or takes it over (after `realm run reclaim <id> --step <step> --force` freed this program's claim, for one), or ends the run (`realm run abandon`, for one), while this one is running it, the outcome this program reached for the step is not recorded. The command says so, read from the run's record, never that the step failed, and goes on with what is left:",
    );
    const r = await race('ran-it');
    // (a) red when the refused settle is said as `'process' failed: …`, the command stops instead of
    //     going on with `notify`, the exit code is 1, or the race is not the one built; (b) prints them.
    expect({ refusals: r.refusals, code: r.code, lines: r.lines }).toEqual({
      refusals: ['already_settled_by_other'],
      code: 0,
      lines: block(ACTING, "this program's outcome for it was not recorded")
        .filter((l) => l !== '')
        .map((l) => l.replace('65d2afc8-2cb3-4401-808c-1d83a40bf989', r.id)),
    });
    expect(r.after.completed_steps).toEqual(['process', 'notify']);
  });

  it.each([
    [
      'another program ran it and the rest (STATE_STEP_ALREADY_SETTLED): completed — no Stopped line',
      'ran-all' as const,
      'already_settled_by_other',
      0,
      (id: string) => [
        '→ process',
        `• Step 'process' was taken by ${RACER_WORDS}, and completed; ${NOT_RECORDED}.`,
        `Run ${id}: phase 'completed'`,
      ],
    ],
    [
      'another program’s run of it failed (STATE_STEP_ALREADY_SETTLED): `, and failed`, and exit 0 — it did not fail here',
      'failed' as const,
      'already_settled_by_other',
      0,
      (id: string) => [
        '→ process',
        `• Step 'process' was taken by ${RACER_WORDS}, and failed; ${NOT_RECORDED}.`,
        // decision C202: the way on from the failed step (walk c12, W1-3).
        `Stopped: the run has ended (failed) — to make 'process' runnable again: realm run resume ${id} --from process`,
        `Run ${id}: phase 'failed'`,
      ],
    ],
    [
      'another program’s run of it ended the run without settling it: the run ended',
      'aborted' as const,
      'already_settled_by_other',
      0,
      (id: string) => [
        '→ process',
        "• Step 'process': the run ended (aborted) before this program's outcome for it was recorded.",
        'Stopped: the run has ended (aborted)',
        `Run ${id}: phase 'aborted'`,
      ],
    ],
    [
      'another program took it over and holds it (STATE_CLAIM_LOST): taken at <time>; in flight in another program',
      'held' as const,
      'claim_lost',
      0,
      (id: string, since?: string) => [
        '→ process',
        `• Step 'process' was taken by ${RACER_WORDS} at ${since}; ${NOT_RECORDED}.`,
        `Stopped: 'process' is in flight in another program — wait for it, or see realm run inspect ${id}`,
        `Run ${id}: phase 'running'`,
      ],
    ],
    [
      'no program holds it and it has not settled (STATE_CLAIM_LOST): the claim was removed — the command runs it again, then what is left',
      'released' as const,
      'claim_lost',
      0,
      (id: string) => [
        '→ process',
        `• Step 'process': another process removed the claim this program held on it; ${NOT_RECORDED}.`,
        '→ process',
        '→ notify',
        `Run ${id}: phase 'completed'`,
      ],
    ],
  ])('%s', async (_name, kase, refusal, exit, expected) => {
    const r = await race(kase);
    // (a) red when the race's line, what follows it or the exit code changes, or the race is not the
    //     one built; (b) prints them.
    expect({ refusals: r.refusals, code: r.code, lines: r.lines }).toEqual({
      refusals: [refusal],
      code: exit,
      lines: expected(r.id, r.since),
    });
    expect(r.handlerRuns).toBe(kase === 'released' ? 2 : 1);
  });

  it('the refusal’s own warnings are said with the last reply’s: a step this call ran before the race warned — its ⚠ line follows the steps', async () => {
    const r = await race('ran-it', true);
    // (a) red when the warning of the reply the race returned is dropped once the command goes on;
    //     (b) prints the lines.
    expect({ refusals: r.refusals, code: r.code, lines: r.lines }).toEqual({
      refusals: ['already_settled_by_other'],
      code: 0,
      lines: [
        '→ process',
        `• Step 'process' was taken by ${RACER_WORDS}, and completed; ${NOT_RECORDED}.`,
        '→ notify',
        '⚠ prep warned',
        `Run ${r.id}: phase 'completed'`,
      ],
    });
  });

  it('the page’s sentences on the other forms and the exit code', () => {
    claim(
      ACTING,
      "The line ends `, and failed; …` when the other program's run of the step failed. While the other program still holds the step it reads `• Step '<step>' was taken by <program> at <time>; this program's outcome for it was not recorded.`, and when the run ended without the step settling, `• Step '<step>': the run ended (<phase>) before this program's outcome for it was recorded.` When no program holds the step and it has not settled, it reads `• Step '<step>': another process removed the claim this program held on it; this program's outcome for it was not recorded.`, and the step is owed again: the command goes on with it as with any owed step. A step whose outcome was not recorded did not fail here, also when the other program's run of it failed: the exit code is the one for what is left.",
    );
    claim(
      ACTING,
      'Exit code 1 when a `Stopped:` line gives a step that failed or a refusal, or when a step cannot run, else 0.',
    );
  });

  it('the same code from a guard of the chain names no step: the guard named with the engine’s words, never "failed" (it passed elsewhere), exit 1 — never the race’s line', async () => {
    // `x` (auto) runs in this call; after its write another writer records `a` (ok: false) with a plain
    // update (it settles no guard), so the call meets guard `g` and decides abort; at that settle
    // another call settles `g` first (pass): STATE_STEP_ALREADY_SETTLED with no `stopped_step`.
    const { home, runs, workflows } = stores();
    try {
      const d = loadWorkflowFromString(
        [
          'id: adv-guard-diverged',
          'name: adv-guard-diverged',
          'version: 1',
          'steps:',
          '  x:',
          '    description: X.',
          '    execution: auto',
          '    handler: ok',
          '  a:',
          '    description: A.',
          '    execution: agent',
          '  g:',
          '    description: G.',
          '    execution: guard',
          '    depends_on: [a]',
          '    abort_unless: ["a.ok == true"]',
        ].join('\n'),
      );
      await workflows.register(d);
      const { run } = await runs.create({ workflowId: d.id, workflowVersion: 1, params: {} });
      const registry = new ExtensionRegistry();
      registry.register('handler', 'ok', { id: 'ok', execute: async () => ({ data: {} }) });
      const seen: string[] = [];
      const racing = new Proxy(runs, {
        get(target, prop) {
          if (prop === 'settleStep') {
            return async (...args: Parameters<NonNullable<JsonFileStore['settleStep']>>) => {
              const [id, delta, d2, o] = args;
              if (
                delta.kind === 'settle_guard' &&
                delta.step === 'g' &&
                delta.outcome === 'abort' &&
                !seen.includes('raced')
              ) {
                seen.push('raced');
                const { abort: _abort, ...rest } = delta;
                void _abort;
                await target.settleStep!(id, { ...rest, outcome: 'pass' }, d2, o);
              }
              const r = await target.settleStep!(...args);
              if (delta.kind === 'settle_step' && delta.step === 'x' && !seen.includes('a')) {
                seen.push('a');
                const cur = await target.get(id);
                const now = new Date().toISOString();
                await target.update({
                  ...cur,
                  completed_steps: [...cur.completed_steps, 'a'],
                  evidence: [
                    ...cur.evidence,
                    {
                      step_id: 'a',
                      started_at: now,
                      completed_at: now,
                      duration_ms: 0,
                      input_summary: {},
                      output_summary: { ok: false },
                      status: 'success',
                      evidence_hash: 'r25',
                    },
                  ],
                });
              }
              if (delta.kind === 'settle_guard') {
                seen.push(`this call: ${r.applied ? 'applied' : r.reason}`);
              }
              return r;
            };
          }
          const v = Reflect.get(target, prop, target) as unknown;
          return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(target) : v;
        },
      });
      const lines: string[] = [];
      const code = await advanceRunFromShell(
        run.id,
        { project: home },
        racing,
        workflows,
        undefined,
        (l) => lines.push(l),
        registry,
      );
      // (a) red when the guard's refusal is read as the race on `x` (the step this call ran), or the
      //     race is not the one built; (b) prints the lines and the race.
      expect({
        seen,
        code,
        stopped: lines.filter((l) => l.startsWith('Stopped:')),
        notRecorded: lines.filter((l) => l.includes('was not recorded') && l.startsWith('•')),
      }).toEqual({
        seen: ['a', 'raced', 'this call: settled_outcome_divergence'],
        code: 1,
        // decision C199: the record lists `g` as completed (a different attempt passed it): the guard
        // is named with the engine's words, never "failed", and never `x`, the step this call ran.
        stopped: [
          "Stopped: 'g': Guard step 'g' was already settled (persisted: 'complete') by a different attempt — your abort was NOT recorded.",
        ],
        notRecorded: [],
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('#625 PR-2a, round 26 — C199 (walk c11 RED 1): realm run advance says "failed" only when the run\'s record lists the step the refusal is about as failed', () => {
  const HERE: Attributed = { by: 'here-a', by_source: 'ambient', channel: 'advance' };
  const RACER: Attributed = { by: 'racer-b', by_source: 'ambient', channel: 'advance' };
  type Ctx = { runs: JsonFileStore; d: WorkflowDefinition; runId: string };
  type Handler = (ctx: Ctx) => Promise<StepHandlerResult>;

  /**
   * One `realm run advance` (the command's body, with this program named `here-a`) on a fresh run of
   * `yaml`, with handlers `handlers` and the store wrapped by `wrap` — what another program (or a
   * failing store) does while this one runs. `lines` are the command's lines from its first `→ `
   * line (or after `Owed to the engine:` when it ran none), the run id put as `<run>`.
   */
  async function advance(
    yaml: string[],
    handlers: Record<string, Handler>,
    wrap: (target: JsonFileStore, ctx: Ctx) => Record<string, unknown> = () => ({}),
  ) {
    const { home, runs, workflows } = stores();
    try {
      const d = loadWorkflowFromString(yaml.join('\n'));
      await workflows.register(d);
      const { run } = await runs.create({ workflowId: d.id, workflowVersion: 1, params: {} });
      const ctx: Ctx = { runs, d, runId: run.id };
      const registry = new ExtensionRegistry();
      for (const [name, h] of Object.entries(handlers)) {
        registry.register('handler', name, { id: name, execute: async () => h(ctx) });
      }
      const overrides = wrap(runs, ctx);
      const store = new Proxy(runs, {
        get(target, prop) {
          if (typeof prop === 'string' && prop in overrides) return overrides[prop];
          const v = Reflect.get(target, prop, target) as unknown;
          return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(target) : v;
        },
      });
      const lines: string[] = [];
      const code = await advanceRunFromShell(
        run.id,
        { project: home },
        store,
        workflows,
        HERE,
        (l) => lines.push(l),
        registry,
      );
      const after = await runs.get(run.id);
      const first = lines.findIndex((l) => l.startsWith('→ '));
      const from =
        first >= 0 ? first : lines.findIndex((l) => l.startsWith('Owed to the engine:')) + 1;
      return {
        code,
        lines: lines.slice(from).map((l) => l.split(run.id).join('<run>')),
        failed: after.failed_steps,
        inProgress: after.in_progress_steps,
        phase: after.run_phase,
      };
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }

  const sAndDone = (id: string, extra: string[] = []) => [
    `id: ${id}`,
    `name: ${id}`,
    'version: 1',
    'steps:',
    '  s:',
    '    description: S.',
    '    execution: auto',
    '    handler: slow',
    ...extra,
    '  done:',
    '    description: Done.',
    '    execution: auto',
    '    handler: quick',
    '    depends_on: [s]',
  ];
  const quick: Handler = async () => ({ data: {} });

  it('the walk\'s abandon race (STATE_RUN_TERMINAL): the run-ended line from the record, never "failed"; exit 0 — nothing failed here', async () => {
    claim(
      ACTING,
      "When another program settles the step or takes it over (after `realm run reclaim <id> --step <step> --force` freed this program's claim, for one), or ends the run (`realm run abandon`, for one), while this one is running it, the outcome this program reached for the step is not recorded. The command says so, read from the run's record, never that the step failed, and goes on with what is left:",
    );
    const r = await advance(sAndDone('c199-abandon'), {
      slow: async ({ runs, runId }) => {
        await abandonRun(runs, runId, 'another program');
        return { data: {} };
      },
      quick,
    });
    // (a) red when the refusal is said as `'s' failed: Run … is terminal …`, the line is not the
    //     record's run-ended form, or the exit code is 1; (b) prints them.
    expect(r).toEqual({
      code: 0,
      lines: [
        '→ s',
        "• Step 's': the run ended (abandoned) before this program's outcome for it was recorded.",
        // F2: a run an operator ended says that ending and its reason, never the undo.
        'Stopped: the run has ended (abandoned). An operator ended this run, with the reason "another program"; to run the work again, start a new run.',
        "Run <run>: phase 'abandoned'",
      ],
      failed: [],
      inProgress: [],
      phase: 'abandoned',
    });
  });

  it('the run ended by another program\'s step while this one still holds its own (STATE_RUN_TERMINAL): the run-ended line — never "taken by" this program', async () => {
    const r = await advance(
      [
        'id: c199-ended-elsewhere',
        'name: c199-ended-elsewhere',
        'version: 1',
        'steps:',
        '  s:',
        '    description: S.',
        '    execution: auto',
        '    handler: slow',
        '  t:',
        '    description: T.',
        '    execution: auto',
        '    handler: aborts',
      ],
      {
        slow: async ({ runs, d, runId }) => {
          const other = new ExtensionRegistry();
          other.register('handler', 'aborts', {
            id: 'aborts',
            execute: async () => ({ abort: { message: 'stopped there' } }),
          });
          await executeStep(runs, d, {
            runId,
            command: 't',
            input: {},
            dispatcher: async () => ({}),
            registry: other,
            driver: RACER,
          });
          return { data: {} };
        },
        aborts: async () => ({ data: {} }),
      },
    );
    // (a) red when the line names this program's own claim as another's take, or says "failed";
    //     (b) prints them. `s` is still on the record's in-flight list under this program's claim.
    expect(r).toEqual({
      code: 0,
      lines: [
        '→ s',
        "• Step 's': the run ended (aborted) before this program's outcome for it was recorded.",
        'Stopped: the run has ended (aborted)',
        "Run <run>: phase 'aborted'",
      ],
      failed: [],
      inProgress: ['s'],
      phase: 'aborted',
    });
  });

  it.each([
    [
      'another program ended the run',
      'ended',
      [
        '→ s',
        // F2: a run an operator ended says that ending and its reason, never the undo.
        'Stopped: the run has ended (abandoned). An operator ended this run, with the reason "another program"; to run the work again, start a new run.',
        "Run <run>: phase 'abandoned'",
      ],
    ],
    [
      'another program opened a question on another step',
      'question',
      [
        '→ s',
        // decision C211: `s`, not run here, waits for the question's answer — named.
        /^Stopped: a question is open \('s' waits for its answer\) — realm run respond <run> --gate \S+ --choice <one of: ship, hold>$/,
        "Run <run>: phase 'gate_waiting'",
      ],
    ],
  ] as const)(
    'the record changed between this call\'s read and its claim (STATE_STEP_NOT_ELIGIBLE) — %s: the claim ran nothing here, so no line of its own and never "failed"; the stop reasons say what the record shows; exit 0',
    async (_name, kase, expected) => {
      let raced = false;
      const yaml =
        kase === 'question'
          ? [
              ...sAndDone('c199-claim-question'),
              '  b:',
              '    description: B.',
              '    execution: auto',
              '    trust: human_confirmed',
              '    gate:',
              '      choices: [ship, hold]',
            ]
          : sAndDone('c199-claim-ended');
      const r = await advance(yaml, { slow: quick, quick }, (target, ctx) => ({
        claimStep: async (...a: Parameters<JsonFileStore['claimStep']>) => {
          if (!raced && a[1] === 's') {
            raced = true;
            if (kase === 'question') {
              await executeStep(target, ctx.d, {
                runId: ctx.runId,
                command: 'b',
                input: {},
                dispatcher: async () => ({}),
                driver: RACER,
              });
            } else {
              await abandonRun(target, ctx.runId, 'another program');
            }
          }
          return target.claimStep(...a);
        },
      }));
      // (a) red when the claim's refusal is said as `'s' failed: Step 's' is not eligible …`, a line
      //     says `s` ran, or the exit code is 1; (b) prints them.
      expect(r.code).toBe(0);
      expect(r.lines).toHaveLength(expected.length);
      expected.forEach((line, i) =>
        typeof line === 'string' ? expect(r.lines[i]).toBe(line) : expect(r.lines[i]).toMatch(line),
      );
      expect(r.failed).toEqual([]);
    },
  );

  it("a step that failed here (the record lists it as failed): `'<step>' failed: <error>`, exit 1 — unchanged", async () => {
    const r = await advance(sAndDone('c199-failed'), {
      slow: async () => {
        throw new Error('it broke here');
      },
      quick,
    });
    // (a) red when a step the record lists as failed is no longer said as failed, or exits 0;
    //     (b) prints them.
    expect(r).toMatchObject({ code: 1, failed: ['s'], phase: 'failed' });
    expect(r.lines[1]).toMatch(/^Stopped: 's' failed: .*it broke here/);
    expect(r.lines.slice(2)).toEqual([
      // decision C202: the way on from the failed step (walk c12, W1-2).
      "Stopped: the run has ended (failed) — to make 's' runnable again: realm run resume <run> --from s",
      "Run <run>: phase 'failed'",
    ]);
  });

  it.each([
    [
      'unresolvable references (GATE_MESSAGE_UNRESOLVABLE)',
      '{{ nope.x }}',
      'gate.message has unresolvable references: nope.x',
    ],
    [
      'an unknown filter (FILTER_UNKNOWN)',
      '{{ s.x | nofilter }}',
      "gate.message uses unknown filter 'nofilter'",
    ],
  ])(
    'a gated step whose question cannot be shown — %s: the step named with the engine\'s words, never "failed" (the record does not list it) nor "in flight in another program" (the claim is this program\'s); exit 1',
    async (_name, message, words) => {
      const r = await advance(
        sAndDone('c199-gate-message', [
          '    trust: human_confirmed',
          '    gate:',
          '      choices: [ship, hold]',
          `      message: "${message}"`,
        ]),
        { slow: quick, quick },
      );
      // (a) red when the refusal is said as failed, or the step this program still holds is called
      //     in flight in another program, or the exit code is 0; (b) prints them.
      expect(r).toEqual({
        code: 1,
        lines: ['→ s', `Stopped: 's': ${words}`, "Run <run>: phase 'running'"],
        failed: [],
        inProgress: ['s'],
        phase: 'running',
      });
    },
  );

  it("another program opened a question on another step while this one ran its gated step (STATE_BLOCKED): the step named with the engine's words, then the question; exit 1", async () => {
    const gated = ['    trust: human_confirmed', '    gate:', '      choices: [ship, hold]'];
    const r = await advance(
      [
        'id: c199-gate-elsewhere',
        'name: c199-gate-elsewhere',
        'version: 1',
        'steps:',
        '  a:',
        '    description: A.',
        '    execution: auto',
        '    handler: slow',
        ...gated,
        '  b:',
        '    description: B.',
        '    execution: auto',
        ...gated,
      ],
      {
        slow: async ({ runs, d, runId }) => {
          await executeStep(runs, d, {
            runId,
            command: 'b',
            input: {},
            dispatcher: async () => ({}),
            driver: RACER,
          });
          return { data: {} };
        },
      },
    );
    // (a) red when the refusal is said as `'a' failed: …`, or exits 0; (b) prints them.
    expect({ code: r.code, failed: r.failed, inProgress: r.inProgress }).toEqual({
      code: 1,
      failed: [],
      inProgress: ['a', 'b'],
    });
    expect(r.lines.slice(0, 2)).toEqual([
      '→ a',
      "Stopped: 'a': Step 'a': a gate is open on another step — wait for its resolution; this step stays claimed.",
    ]);
    expect(r.lines[2]).toMatch(/^Stopped: a question is open — realm run respond <run> --gate /);
  });

  it.each([
    [
      'the claim (a store that throws)',
      'claimStep',
      new Error('disk gone'),
      "Stopped: 's': Failed to claim step",
      [],
    ],
    [
      'the claim (a busy run)',
      'claimStep',
      new WorkflowError('Run is busy: lock held too long', {
        code: 'STATE_RUN_BUSY',
        category: 'STATE',
        agentAction: 'stop',
        retryable: true,
      }),
      "Stopped: 's': Run is busy: lock held too long",
      [],
    ],
    [
      'the write of its outcome (a store that throws)',
      'settleStep',
      new Error('disk gone'),
      "Stopped: 's': Failed to persist run update",
      ['s'],
    ],
    [
      'the write of its outcome (a busy run)',
      'settleStep',
      new WorkflowError('Run is busy: lock held too long', {
        code: 'STATE_RUN_BUSY',
        category: 'STATE',
        agentAction: 'stop',
        retryable: true,
      }),
      "Stopped: 's': Run is busy: lock held too long",
      ['s'],
    ],
  ] as const)(
    'the store refuses %s: the step named with the engine\'s words, never "failed"; exit 1',
    async (_name, method, err, line, held) => {
      let thrown = false;
      const r = await advance(
        sAndDone(`c199-store-${method}`),
        { slow: quick, quick },
        (target) => ({
          [method]: async (...a: unknown[]) => {
            if (!thrown) {
              thrown = true;
              throw err;
            }
            return (target[method] as (...x: unknown[]) => Promise<unknown>).apply(target, a);
          },
        }),
      );
      // (a) red when the refusal is said as failed, the step this program holds is called in flight in
      //     another program, or the exit code is 0; (b) prints them. Decision C202: a step the store
      //     refused to claim is still owed, and said so with the call that runs it.
      expect(r).toEqual({
        code: 1,
        lines: [
          '→ s',
          line,
          ...(held.length === 0
            ? ["Stopped: the engine still owes 's' — to run it: realm run advance <run>"]
            : []),
          "Run <run>: phase 'running'",
        ],
        failed: [],
        inProgress: held,
        phase: 'running',
      });
    },
  );

  it.each([
    [
      "the step's own read (the reply names the step)",
      3,
      [
        '→ s',
        "Stopped: 's': Failed to load run from store: disk gone",
        // decision C202: the step is still owed, said with the call that runs it.
        "Stopped: the engine still owes 's' — to run it: realm run advance <run>",
        "Run <run>: phase 'running'",
      ],
    ],
    [
      "the advance call's first read (the reply names no step)",
      2,
      [
        'Stopped: Failed to load run from store: disk gone',
        "Stopped: the engine still owes 's' — to run it: realm run advance <run>",
        "Run <run>: phase 'running'",
      ],
    ],
  ] as const)(
    'the run cannot be read at %s: the engine\'s words, never "failed"; exit 1',
    async (_name, nth, expected) => {
      let reads = 0;
      const r = await advance(sAndDone(`c199-read-${nth}`), { slow: quick, quick }, (target) => ({
        get: async (id: string) => {
          reads += 1;
          if (reads === nth) throw new Error('disk gone');
          return target.get(id);
        },
      }));
      // (a) red when a read the store refused is said as a step that failed, or exits 0; (b) prints them.
      expect({ code: r.code, lines: r.lines }).toEqual({ code: 1, lines: expected });
    },
  );

  /**
   * `x` (auto) runs in this call; after its write another writer records agent step `a` with a plain
   * update (it settles no guard), so the call meets guard `g` itself — then `settle` decides what the
   * store does with this call's settle of `g`.
   */
  async function guardChain(
    id: string,
    okA: boolean,
    settle: (
      target: JsonFileStore,
      args: Parameters<NonNullable<JsonFileStore['settleStep']>>,
    ) => Promise<unknown>,
  ) {
    let wroteA = false;
    return advance(
      [
        `id: ${id}`,
        `name: ${id}`,
        'version: 1',
        'steps:',
        '  x:',
        '    description: X.',
        '    execution: auto',
        '    handler: quick',
        '  a:',
        '    description: A.',
        '    execution: agent',
        '  g:',
        '    description: G.',
        '    execution: guard',
        '    depends_on: [a]',
        '    abort_unless: ["a.ok == true"]',
      ],
      { quick },
      (target) => ({
        settleStep: async (...args: Parameters<NonNullable<JsonFileStore['settleStep']>>) => {
          if (args[1].kind === 'settle_guard') return settle(target, args);
          const r = await target.settleStep!(...args);
          if (args[1].kind === 'settle_step' && args[1].step === 'x' && !wroteA) {
            wroteA = true;
            const cur = await target.get(args[0]);
            const now = new Date().toISOString();
            await target.update({
              ...cur,
              completed_steps: [...cur.completed_steps, 'a'],
              evidence: [
                ...cur.evidence,
                {
                  step_id: 'a',
                  started_at: now,
                  completed_at: now,
                  duration_ms: 0,
                  input_summary: {},
                  output_summary: { ok: okA },
                  status: 'success',
                  evidence_hash: 'r26',
                },
              ],
            });
          }
          return r;
        },
      }),
    );
  }

  it("the guard race, settled as failed elsewhere: the record lists the guard as failed — `'g' failed: …`, naming the guard, never the step this call ran", async () => {
    const r = await guardChain('c199-guard-failed', false, async (target, [id, delta, d2, o]) => {
      if (delta.kind === 'settle_guard' && delta.outcome === 'abort') {
        const { abort: _abort, ...rest } = delta;
        void _abort;
        await target.settleStep!(
          id,
          {
            ...rest,
            outcome: 'resolution_error',
            resolutionError: { condition: 'a.ok == true', unresolvable_path: 'a.ok' },
          },
          d2,
          o,
        );
      }
      return target.settleStep!(id, delta, d2, o);
    });
    // (a) red when the guard the record lists as failed is not said as failed, or the line names `x`;
    //     (b) prints them.
    expect({ code: r.code, failed: r.failed, lines: r.lines }).toEqual({
      code: 1,
      failed: ['g'],
      lines: [
        '→ x',
        "Stopped: 'g' failed: Guard step 'g' was already settled (persisted: 'fail') by a different attempt — your abort was NOT recorded.",
        // decision C202: the way on from the failed guard.
        "Stopped: the run has ended (failed) — to make 'g' runnable again: realm run resume <run> --from g",
        "Run <run>: phase 'failed'",
      ],
    });
  });

  it('a guard\'s decision cannot be written (the reply names no step): the engine\'s words alone, never "failed" on the step this call ran; exit 1', async () => {
    const r = await guardChain('c199-guard-persist', true, async () => {
      throw new Error('disk gone');
    });
    // (a) red when the store's refusal is said as `'x' failed: …`, or exits 0; (b) prints them.
    expect({ code: r.code, failed: r.failed, lines: r.lines }).toEqual({
      code: 1,
      failed: [],
      lines: [
        '→ x',
        "Stopped: Failed to persist guard step 'g': disk gone",
        // decision C202: the guard is still owed, said with the call that decides it.
        "Stopped: the engine still owes 'g' — to run it: realm run advance <run>",
        "Run <run>: phase 'running'",
      ],
    });
  });

  it('the page\'s sentences: "failed" from the record; the engine\'s words otherwise; a claim the record refused; the exit code', () => {
    claim(
      ACTING,
      "a step that failed (`'<step>' failed: <error>`, only when the run's record lists the step as failed, and never for a step it started whose outcome was not recorded: when another program's run of that step failed, the step's own line says so, `…, and failed; this program's outcome for it was not recorded.` (below), and no failed line is printed), a refusal that failed no step (`'<step>': <error>`: the step it is about, with the engine's words, or the engine's words alone when the refusal names no step), the run ended",
    );
    claim(
      ACTING,
      'When the record changed after the command read it and before it claimed the step (another program ended the run, or opened a question on another step), the step did not run here: no line says it did, and the `Stopped:` lines say what the record shows.',
    );
    claim(
      ACTING,
      'Exit code 1 when a `Stopped:` line gives a step that failed or a refusal, or when a step cannot run, else 0.',
    );
  });
});

describe("#625 PR-2a, round 27 — C202 (walk c12, W1-2): realm run advance gives the way on that fits the run's state", () => {
  const HERE: Attributed = { by: 'here-a', by_source: 'ambient', channel: 'advance' };
  const OTHER: Attributed = { by: 'other-b', by_source: 'ambient', channel: 'advance' };

  /**
   * A fresh registered run of `yaml`; `advance()` is one `realm run advance` (the command's body, this
   * program named `here-a`) with handler `boom` throwing while `breaks.on` is true, `quick` returning.
   * `lines` are every line it printed, the run id put as `<run>`.
   */
  async function setup(yaml: string[]) {
    const { home, runs, workflows } = stores();
    const d = loadWorkflowFromString(yaml.join('\n'));
    await workflows.register(d);
    const { run } = await runs.create({ workflowId: d.id, workflowVersion: 1, params: {} });
    const breaks = { on: true };
    const registry = new ExtensionRegistry();
    registry.register('handler', 'boom', {
      id: 'boom',
      execute: async () => {
        if (breaks.on) throw new Error('it broke');
        return { data: {} };
      },
    });
    registry.register('handler', 'quick', { id: 'quick', execute: async () => ({ data: {} }) });
    const advance = async () => {
      const lines: string[] = [];
      const code = await advanceRunFromShell(
        run.id,
        { project: home },
        runs,
        workflows,
        HERE,
        (l) => lines.push(l),
        registry,
      );
      return { code, lines: lines.map((l) => l.split(run.id).join('<run>')) };
    };
    return { home, runs, workflows, d, id: run.id, breaks, advance };
  }
  const head = (id: string) => [`id: ${id}`, `name: ${id}`, 'version: 1', 'steps:'];
  const auto = (name: string, handler: string, extra: string[] = []) => [
    `  ${name}:`,
    `    description: ${name}.`,
    '    execution: auto',
    `    handler: ${handler}`,
    ...extra,
  ];

  it('W1-2: a step that failed — the run-ended reason gives `realm run resume <id> --from <step>`, on the call that failed it and on the next call; following it runs the step again', async () => {
    const t = await setup([
      ...head('c202-failed'),
      ...auto('s', 'boom'),
      ...auto('done', 'quick', ['    depends_on: [s]']),
    ]);
    try {
      const first = await t.advance();
      const next = await t.advance();
      // the way on, followed: resume takes `s`, and the next call runs it and the rest.
      await resumeRun(t.id, 's', t.runs, t.workflows);
      t.breaks.on = false;
      const resumed = await t.advance();
      // (a) red when the run-ended reason gives no way on, another command, or the wrong step; or the
      //     way on does not lead to the run going on; (b) prints them.
      expect({
        first: first.lines.slice(-4),
        firstCode: first.code,
        next: next.lines.at(-1),
        nextCode: next.code,
        resumed: resumed.lines.filter((l) => l.startsWith('→ ') || l.startsWith('Run ')),
      }).toEqual({
        first: [
          '→ s',
          "Stopped: 's' failed: Handler 'boom' threw: it broke",
          "Stopped: the run has ended (failed) — to make 's' runnable again: realm run resume <run> --from s",
          "Run <run>: phase 'failed'",
        ],
        firstCode: 1,
        next: "Nothing is owed to the engine: the run has ended (failed) — to make 's' runnable again: realm run resume <run> --from s",
        nextCode: 0,
        resumed: ['→ s', '→ done', "Run <run>: phase 'completed'"],
      });
    } finally {
      rmSync(t.home, { recursive: true, force: true });
    }
  });

  it('several failed steps: `a failed step` and `--from <one of: a, b>`, the names `realm run resume` takes', async () => {
    const t = await setup([...head('c202-two'), ...auto('a', 'boom'), ...auto('b', 'boom')]);
    try {
      // another program holds `b`, so `a`'s failure leaves the run open; then its claim is freed and
      // this program's next call runs `b`, which fails too.
      await t.runs.claimStep(t.id, 'b', t.d, OTHER);
      const first = await t.advance();
      await reclaimStep(t.runs, t.id, 'b');
      const second = await t.advance();
      const after = await t.runs.get(t.id);
      // (a) red when several failed steps are not named as resume's choices; (b) prints them.
      expect({
        first: first.lines.filter((l) => l.startsWith('Stopped:')),
        failed: after.failed_steps,
        second: second.lines.filter((l) => l.startsWith('Stopped:')),
      }).toEqual({
        first: [
          "Stopped: 'a' failed: Handler 'boom' threw: it broke",
          "Stopped: 'b' is in flight in another program — wait for it, or see realm run inspect <run>",
        ],
        failed: ['a', 'b'],
        second: [
          "Stopped: 'b' failed: Handler 'boom' threw: it broke",
          'Stopped: the run has ended (failed) — to make a failed step runnable again: realm run resume <run> --from <one of: a, b>',
        ],
      });
    } finally {
      rmSync(t.home, { recursive: true, force: true });
    }
  });

  it('a cleanup step that failed is not offered (resume refuses a finalizer); an abandoned run with a failed step is told the operator’s ending instead (F2); an aborted run gets no way on', async () => {
    const fin = await setup([
      ...head('c202-fin'),
      ...auto('s', 'boom'),
      '  clean:',
      '    description: Clean up.',
      '    execution: finalizer',
      '    handler: boom',
      '    on_outcome: fail',
    ]);
    const abandoned = await setup([
      ...head('c202-ab'),
      ...auto('a', 'boom'),
      ...auto('b', 'quick'),
    ]);
    const aborted = await setup([...head('c202-abort'), ...auto('s', 'stop')]);
    try {
      const finLines = (await fin.advance()).lines.filter((l) => l.startsWith('Stopped:'));
      const finFailed = (await fin.runs.get(fin.id)).failed_steps;
      // `a` fails while another program holds `b`; then the run is abandoned.
      await abandoned.runs.claimStep(abandoned.id, 'b', abandoned.d, OTHER);
      await abandoned.advance();
      await abandonRun(abandoned.runs, abandoned.id, 'another program');
      const abandonedLast = (await abandoned.advance()).lines.at(-1);
      await resumeRun(abandoned.id, 'a', abandoned.runs, abandoned.workflows);
      const resumedPhase = (await abandoned.runs.get(abandoned.id)).run_phase;
      const reg = new ExtensionRegistry();
      reg.register('handler', 'stop', {
        id: 'stop',
        execute: async () => ({ abort: { message: 'stopped by the handler' } }),
      });
      const abortedLines: string[] = [];
      await advanceRunFromShell(
        aborted.id,
        { project: aborted.home },
        aborted.runs,
        aborted.workflows,
        HERE,
        (l) => abortedLines.push(l),
        reg,
      );
      // (a) red when a failed cleanup step is offered to resume, an abandoned run's failed step is
      //     offered (F2: the operator's ending is said instead), or an aborted run is offered one;
      //     (b) prints them.
      expect({
        finLines,
        finFailed,
        abandonedLast,
        resumedPhase,
        aborted: abortedLines.filter((l) => l.startsWith('Stopped:')),
      }).toEqual({
        finLines: [
          "Stopped: 's' failed: Handler 'boom' threw: it broke",
          "Stopped: the run has ended (failed) — to make 's' runnable again: realm run resume <run> --from s",
        ],
        finFailed: ['s', 'clean'],
        // F2: an abandoned run's failed step is the operator's ending to say, never an undo to offer.
        abandonedLast:
          'Nothing is owed to the engine: the run has ended (abandoned). An operator ended this run, with the reason "another program"; to run the work again, start a new run.',
        resumedPhase: 'running',
        aborted: ['Stopped: the run has ended (aborted)'],
      });
    } finally {
      for (const t of [fin, abandoned, aborted]) rmSync(t.home, { recursive: true, force: true });
    }
  });

  it('engine work still owed when a refusal stopped the call: `the engine still owes … — to run it: realm run advance <id>`; following it runs it', async () => {
    const t = await setup([
      ...head('c202-owed'),
      ...auto('a', 'quick', [
        '    trust: human_confirmed',
        '    gate:',
        '      message: "{{ nope.x }}"',
      ]),
      ...auto('b', 'quick'),
    ]);
    try {
      const first = await t.advance();
      const next = await t.advance();
      // (a) red when the owed step is not named with the owed call, or the call does not run it;
      //     (b) prints them.
      expect({
        first: first.lines.slice(first.lines.indexOf('→ a')),
        code: first.code,
        next: next.lines.filter((l) => l.startsWith('→ ')),
        done: (await t.runs.get(t.id)).completed_steps,
      }).toEqual({
        first: [
          '→ a',
          "Stopped: 'a': gate.message has unresolvable references: nope.x",
          "Stopped: the engine still owes 'b' — to run it: realm run advance <run>",
          "Run <run>: phase 'running'",
        ],
        code: 1,
        next: ['→ b'],
        done: ['b'],
      });
    } finally {
      rmSync(t.home, { recursive: true, force: true });
    }
  });

  it("C203 (walk c12, W1-3): another program's run of the step this one started failed — the step's own line, no failed line, the way on, exit 0; the page says the exception in place", async () => {
    claim(
      ACTING,
      "a step that failed (`'<step>' failed: <error>`, only when the run's record lists the step as failed, and never for a step it started whose outcome was not recorded: when another program's run of that step failed, the step's own line says so, `…, and failed; this program's outcome for it was not recorded.` (below), and no failed line is printed)",
    );
    claim(
      ACTING,
      'the run ended (`the run has ended (<phase>)`; when an engine failure ended it and a step failed that `realm run resume` takes, it goes on `— to make \'<step>\' runnable again: realm run resume <id> --from <step>`, or, for several, `— to make a failed step runnable again: realm run resume <id> --from <one of: …>` with their names; when an operator ended it, it goes on `. An operator ended this run, with the reason "<reason>"; to run the work again, start a new run.`, never with `realm run resume`, which would erase that ending and its reason)',
    );
    claim(
      ACTING,
      "work the engine still owes when the call stops, after a refusal for one (`the engine still owes '<step>' — to run it: realm run advance <id>`, or, for several, `the engine still owes '<a>', '<b>' — to run them until a step opens a question, fails or ends the run: realm run advance <id>`)",
    );
    const { home, runs, workflows } = stores();
    try {
      const d = loadWorkflowFromString(
        [
          ...head('c203-other-failed'),
          ...auto('s', 'slow'),
          ...auto('done', 'quick', ['    depends_on: [s]']),
        ].join('\n'),
      );
      await workflows.register(d);
      const { run } = await runs.create({ workflowId: d.id, workflowVersion: 1, params: {} });
      // Another program: its run of `s` fails.
      const otherRegistry = new ExtensionRegistry();
      otherRegistry.register('handler', 'slow', {
        id: 'slow',
        execute: async () => {
          throw new Error('the other program’s run failed');
        },
      });
      otherRegistry.register('handler', 'quick', {
        id: 'quick',
        execute: async () => ({ data: {} }),
      });
      // This program: while its handler runs, `s` is freed and another program runs it, and fails.
      const registry = new ExtensionRegistry();
      registry.register('handler', 'slow', {
        id: 'slow',
        execute: async () => {
          await reclaimStep(runs, run.id, 's');
          await advanceRun(runs, d, {
            runId: run.id,
            caller: 'advance',
            registry: otherRegistry,
            driver: OTHER,
          });
          return { data: {} };
        },
      });
      registry.register('handler', 'quick', { id: 'quick', execute: async () => ({ data: {} }) });
      const lines: string[] = [];
      const code = await advanceRunFromShell(
        run.id,
        { project: home },
        runs,
        workflows,
        HERE,
        (l) => lines.push(l),
        registry,
      );
      // (a) red when a failed line is printed for the step this program started, the way on is
      //     missing, or the exit code is 1; (b) prints them.
      expect({
        code,
        lines: lines.slice(lines.indexOf('→ s')).map((l) => l.split(run.id).join('<run>')),
        failed: (await runs.get(run.id)).failed_steps,
      }).toEqual({
        code: 0,
        lines: [
          '→ s',
          "• Step 's' was taken by other-b (from REALM_OPERATOR, via advance), and failed; this program's outcome for it was not recorded.",
          "Stopped: the run has ended (failed) — to make 's' runnable again: realm run resume <run> --from s",
          "Run <run>: phase 'failed'",
        ],
        failed: ['s'],
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
