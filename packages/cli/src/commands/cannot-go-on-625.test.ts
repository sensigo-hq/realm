// cannot-go-on-625.test.ts — issue #625 PR-2a, decisions C62 and C64: the CLI surfaces that report a
// run that cannot go on from here — no question open, nothing ready, nothing in flight, and an engine
// step that cannot run — name each such step and the way out, with core's lines (`cannotGoOnLines`,
// `cannotRunWayOut`), never a copy. One cell per surface on its own route into that state, and a
// control where an agent step is ready (no way out printed). Whole-message pins.
//
// `realm run respond` and `realm run inspect` (C62); `realm run drain` — a live run, and
// `--expired --force` leaving one — `realm run resume` and `realm listen`'s sweeper (C64, the census).
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  JsonFileStore,
  JsonWorkflowStore,
  ExtensionRegistry,
  executeChain,
  executeStep,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  type StepDefinition,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { inspectRun } from './inspect.js';
import { sweepExpiredGates } from './listen.js';
import { printChildrenWhenATestFails } from '../test-support/child-output.js';

const CLI_ENTRY = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
if (!existsSync(CLI_ENTRY)) {
  throw new Error(`cli dist not built — run \`npm run build\` first (looked for: ${CLI_ENTRY})`);
}
const children = printChildrenWhenATestFails();

function realm(home: string, args: string[]): { stdout: string; stderr: string; status: number } {
  const r = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    env: { ...process.env, HOME: home, REALM_OPERATOR: 'tester' },
    cwd: home,
    encoding: 'utf8',
  });
  children.record({ args: [CLI_ENTRY, ...args], ...r });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status ?? -1 };
}

const wf = (id: string, steps: Record<string, StepDefinition>): WorkflowDefinition => ({
  id,
  name: id,
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps,
});

const gate = (expiry = false): StepDefinition => ({
  description: 'Decide.',
  execution: 'auto',
  trust: 'human_confirmed',
  depends_on: [],
  gate: {
    choices: ['approve', 'reject'],
    ...(expiry
      ? { timeout_seconds: 1, on_expiry: 'settle_default' as const, default_choice: 'approve' }
      : {}),
  },
});

/** An `auto` step refused before its claim: the engine gives it `{}`, its schema needs `n`. */
const needsN = (deps: string[]): StepDefinition => ({
  description: 'Compute.',
  execution: 'auto',
  depends_on: deps,
  input_schema: { type: 'object', required: ['n'], properties: { n: { type: 'number' } } },
});

const REFUSAL = "Invalid input for step 'compute': the input must have required property 'n'";
const clause = `'compute' cannot run (input_schema): ${REFUSAL}.`;
const wayOut = (id: string): string =>
  `Run ${id} stays open (phase 'running'): correct the workflow, register it again, then realm run advance ${id}; or end it: realm run abandon ${id}.`;

async function stores(): Promise<{
  home: string;
  runs: JsonFileStore;
  workflows: JsonWorkflowStore;
}> {
  const home = mkdtempSync(join(tmpdir(), 'realm-cannot-go-on-625-'));
  return {
    home,
    runs: new JsonFileStore(join(home, '.realm', 'runs')),
    workflows: new JsonWorkflowStore(join(home, '.realm', 'workflows')),
  };
}

/** A run at its open gate: `decide` opened, unanswered. */
async function atGate(runs: JsonFileStore, d: WorkflowDefinition): Promise<[string, string]> {
  const { run } = await runs.create({ workflowId: d.id, workflowVersion: 1, params: {} });
  await executeStep(runs, d, {
    runId: run.id,
    command: 'decide',
    input: {},
    dispatcher: async () => ({}),
  });
  return [run.id, (await runs.get(run.id)).pending_gate!.gate_id];
}

describe('#625 PR-2a, C62 — realm run respond and realm run inspect in the "cannot go on" state', () => {
  it('respond: after the answer only a refused engine step remains — each step that cannot run, then the way out; the control (an agent step ready) prints neither', async () => {
    const { respondToGate } = await import('./respond.js');
    const { home, runs, workflows } = await stores();
    try {
      const stuck = wf('c62-respond', { decide: gate(), compute: needsN(['decide']) });
      const ready = wf('c62-respond-ctl', {
        decide: gate(),
        ask: { description: 'Ask.', execution: 'agent', depends_on: ['decide'] },
        compute: needsN(['decide']),
      });
      await workflows.register(stuck);
      await workflows.register(ready);
      const [id, g] = await atGate(runs, stuck);
      const out = await respondToGate(
        id,
        { gate: g, choice: 'approve' },
        runs,
        workflows,
        new ExtensionRegistry(),
      );
      expect(out.lastLine).toBe(
        `Responded: ${id} | choice 'approve' | new state 'running'\n${clause}\n${wayOut(id)}`,
      );
      // Control: an agent step is ready after the answer — the run can go on; no cannot-run line and
      // no way out, only the ready line `realm run advance` prints (decision C96).
      const [cid, cg] = await atGate(runs, ready);
      const ctl = await respondToGate(
        cid,
        { gate: cg, choice: 'approve' },
        runs,
        workflows,
        new ExtensionRegistry(),
      );
      expect(ctl.lastLine).toBe(
        `Responded: ${cid} | choice 'approve' | new state 'running'\n` +
          `An agent step is ready: 'ask' — drive it with realm agent --run-id ${cid} --provider <provider> --model <model>.\n` +
          // decision C164: the attending line after the command an answer leaves.
          'If a realm workflow run or realm agent is still waiting on this run, it goes on by itself; the line above is for when none is.',
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('inspect: the way out follows the `Cannot run` line; the control (an agent step ready) names the step and prints no way out', async () => {
    const { home, runs, workflows } = await stores();
    try {
      const stuck = wf('c62-inspect', { compute: needsN([]) });
      const ready = wf('c62-inspect-ctl', {
        ask: { description: 'Ask.', execution: 'agent', depends_on: [] },
        compute: needsN([]),
      });
      await workflows.register(stuck);
      await workflows.register(ready);
      const { run } = await runs.create({ workflowId: stuck.id, workflowVersion: 1, params: {} });
      const lines = (await inspectRun(run.id, runs, workflows)).split('\n');
      const at = lines.indexOf(`Cannot run 'compute' (input_schema): ${REFUSAL}`);
      expect(at).toBeGreaterThan(-1);
      expect(lines[at + 1]).toBe(wayOut(run.id));
      const { run: c } = await runs.create({
        workflowId: ready.id,
        workflowVersion: 1,
        params: {},
      });
      const ctl = (await inspectRun(c.id, runs, workflows)).split('\n');
      expect(ctl).toContain(`Cannot run 'compute' (input_schema): ${REFUSAL}`);
      expect(ctl.filter((l) => l.includes('stays open'))).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('#625 PR-2a, C64 — the census: drain, resume and the sweeper name the stuck step and the way out', () => {
  it('drain on a live run that cannot go on: the step and the way out on its one line; the control keeps `To end the run: …`', async () => {
    const { home, runs, workflows } = await stores();
    try {
      const stuck = wf('c64-drain', { compute: needsN([]) });
      const ready = wf('c64-drain-ctl', {
        ask: { description: 'Ask.', execution: 'agent', depends_on: [] },
        compute: needsN([]),
      });
      await workflows.register(stuck);
      await workflows.register(ready);
      const { run } = await runs.create({ workflowId: stuck.id, workflowVersion: 1, params: {} });
      const r = realm(home, ['run', 'drain', run.id]);
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe(
        `Run '${run.id}' is not terminal (phase: 'running') — nothing to drain. ${clause} ${wayOut(run.id)}`,
      );
      const { run: c } = await runs.create({
        workflowId: ready.id,
        workflowVersion: 1,
        params: {},
      });
      const ctl = realm(home, ['run', 'drain', c.id]);
      expect(ctl.stdout.trim()).toBe(
        `Run '${c.id}' is not terminal (phase: 'running') — nothing to drain. To end the run: realm run abandon ${c.id}.`,
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 60000);

  it('drain --expired --force whose expiry leaves the run unable to go on: the step and the way out after its line', async () => {
    const { home, runs, workflows } = await stores();
    try {
      const d = wf('c64-expiry', { decide: gate(true), compute: needsN(['decide']) });
      await workflows.register(d);
      const [id] = await atGate(runs, d);
      await new Promise((r) => setTimeout(r, 1300));
      const r = realm(home, ['run', 'drain', id, '--expired', '--force']);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(
        `Run '${id}' is not terminal (phase: 'running') — nothing further to drain.\n${clause}\n${wayOut(id)}\n`,
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 60000);

  it('resume into a run that cannot go on (the workflow registered again with a precondition on the resumed step): the step and the way out', async () => {
    const { home, runs, workflows } = await stores();
    try {
      const v1 = wf('c64-resume', {
        a: { description: 'A', execution: 'auto', depends_on: [], handler: 'boom' },
      });
      await workflows.register(v1);
      const { run } = await runs.create({ workflowId: v1.id, workflowVersion: 1, params: {} });
      const registry = new ExtensionRegistry();
      registry.register('handler', 'boom', {
        id: 'boom',
        execute: async () => {
          throw new Error('boom');
        },
      });
      await executeChain(runs, v1, {
        runId: run.id,
        command: 'a',
        input: {},
        dispatcher: async () => ({}),
        registry,
      });
      expect((await runs.get(run.id)).failed_steps).toEqual(['a']);
      await workflows.register(
        wf('c64-resume', {
          a: {
            description: 'A',
            execution: 'auto',
            depends_on: [],
            preconditions: ['run.params.ok == true'],
          },
        }),
      );
      const r = realm(home, ['run', 'resume', run.id, '--from', 'a']);
      expect(r.status).toBe(0);
      // decision C68: the steps and the way out take the place of #676's `Drive it with:` line
      // (driving the run would only print the cannot-run exit). (a) red when the drive line is
      // printed in this state or a line is dropped; (b) prints the whole stdout.
      expect(r.stdout).toBe(
        `Resumed run '${run.id}': step 'a' re-enabled and run reset to 'running'.\n` +
          `'a' cannot run (precondition): Precondition failed for step 'a'. Precondition failed: 'run.params.ok == true'. Resolved value: undefined.\n${wayOut(run.id)}\n`,
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 60000);

  it('CONTROL (C68) — resume into a run with an agent step ready: the drive line as #676 prints it, no stuck lines', async () => {
    const { home, runs, workflows } = await stores();
    try {
      const v1 = wf('c68-resume-ready', {
        a: { description: 'A', execution: 'auto', depends_on: [], handler: 'boom' },
      });
      await workflows.register(v1);
      const { run } = await runs.create({ workflowId: v1.id, workflowVersion: 1, params: {} });
      const registry = new ExtensionRegistry();
      registry.register('handler', 'boom', {
        id: 'boom',
        execute: async () => {
          throw new Error('boom');
        },
      });
      await executeChain(runs, v1, {
        runId: run.id,
        command: 'a',
        input: {},
        dispatcher: async () => ({}),
        registry,
      });
      await workflows.register(
        wf('c68-resume-ready', {
          a: {
            description: 'A',
            execution: 'auto',
            depends_on: [],
            preconditions: ['run.params.ok == true'],
          },
          ask: { description: 'Ask.', execution: 'agent', depends_on: [] },
        }),
      );
      const r = realm(home, ['run', 'resume', run.id, '--from', 'a']);
      expect(r.status).toBe(0);
      // (a) red when the drive line is withheld outside the cannot-go-on state; (b) prints stdout.
      expect(r.stdout).toBe(
        `Resumed run '${run.id}': step 'a' re-enabled and run reset to 'running'.\n` +
          `Drive it with: realm agent --run-id ${run.id} --provider <provider> --model <model>\n` +
          `Add the other flags the run was driven with, such as --extensions-module or --project (realm run inspect ${run.id} shows the extension module the run loaded).\n`,
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 60000);

  it("listen's sweeper: an expiry that leaves the run unable to go on logs `cannot_go_on` (the step, then the way out); the control (an agent step ready) logs none", async () => {
    const { home, runs, workflows } = await stores();
    try {
      const stuck = wf('c64-sweep', { decide: gate(true), compute: needsN(['decide']) });
      const ready = wf('c64-sweep-ctl', {
        decide: gate(true),
        ask: { description: 'Ask.', execution: 'agent', depends_on: ['decide'] },
        compute: needsN(['decide']),
      });
      await workflows.register(stuck);
      await workflows.register(ready);
      const [id] = await atGate(runs, stuck);
      const [cid] = await atGate(runs, ready);
      const logged: Array<[string, Record<string, unknown>]> = [];
      const logger = {
        info: (m: string, f?: unknown) => logged.push([m, (f ?? {}) as Record<string, unknown>]),
        warn: () => {},
        error: () => {},
      };
      await sweepExpiredGates(
        { runStore: runs, workflowStore: workflows, logger } as never,
        new Date(Date.now() + 3_600_000),
      );
      const fields = (runId: string) =>
        logged.find(
          ([m, f]) => m === 'listen: sweeper enacted an expired gate' && f['run_id'] === runId,
        )?.[1];
      expect(fields(id)?.['cannot_go_on']).toEqual([clause, wayOut(id)]);
      expect(fields(cid)).toBeDefined();
      expect(fields(cid)?.['cannot_go_on']).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
