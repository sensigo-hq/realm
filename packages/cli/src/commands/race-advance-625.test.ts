// race-advance-625.test.ts — issue #625 PR-2a, the last prompt's F7 on `realm run advance` (review
// G7-02, G7-03 = G2-R1): the command reads core's classifier (no code list of its own), and its preview
// at an open question composes its answer line from the record it read — it never calls the writer
// `advanceRun`, so it runs nothing it does not print. Rounds 25–26's C194 and C199 cells (in
// `owed-words-625.test.ts`) are the preservation cells for rows 3–8 and 11–12 and stay unchanged;
// this file adds the rows they do not build.
//
// In-process: the command's body (`advanceRunFromShell`) with a store wrapped so another program
// acts on the same store at the moment a row names.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  JsonFileStore,
  JsonWorkflowStore,
  ExtensionRegistry,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  WorkflowError,
  abandonRun,
  advanceRun,
  executeStep,
  submitHumanResponse,
  type Attributed,
  type RunRecord,
  type StepDefinition,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { advanceRunFromShell } from './run-advance.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const ACTING = 'docs/reference/cli/realm-run-acting.md';
const RACER: Attributed = { by: 'racer-b', by_source: 'stated', channel: 'test' };
const HERE: Attributed = { by: 'here-a', by_source: 'stated', channel: 'advance' };

/** (a) red when the page no longer holds the sentence word for word; (b) prints it. */
function claim(page: string, sentence: string): void {
  const flat = (t: string) => t.replace(/\s+/g, ' ');
  expect(
    flat(readFileSync(join(ROOT, page), 'utf8')),
    `${page} no longer says: ${sentence}`,
  ).toContain(flat(sentence));
}

const QUESTION = (deps: string[]): StepDefinition =>
  ({
    description: 'Q.',
    execution: 'auto',
    depends_on: deps,
    trust: 'human_confirmed',
    gate: { choices: ['ok', 'no'] },
  }) as StepDefinition;

/** `s` then `u` (auto), and, when `x` is given, a question `x` with those dependencies. */
function wf(id: string, x?: string[]): WorkflowDefinition {
  return {
    id,
    name: id,
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps: {
      s: { description: 'S.', execution: 'auto', depends_on: [] },
      u: { description: 'U.', execution: 'auto', depends_on: ['s'] },
      ...(x !== undefined ? { x: QUESTION(x) } : {}),
    },
  };
}

/**
 * One `realm run advance` (the command's body) on a fresh run of `def`, with the other program's act
 * at `moment`: `read` — after the loop picked `s`, before `s`'s own read (the third read: the
 * command's, `advanceRun`'s, then `s`'s); `claim` — at `s`'s claim. `lines` are the command's lines
 * from its `Owed to the engine:` line on, the run id as `<run>`.
 */
async function advance(
  def: WorkflowDefinition,
  moment: 'read' | 'claim',
  act: (runs: JsonFileStore, runId: string) => Promise<void>,
) {
  const home = mkdtempSync(join(tmpdir(), 'realm-race-advance-625-'));
  try {
    const runs = new JsonFileStore(join(home, 'runs'));
    const workflows = new JsonWorkflowStore(join(home, 'wf'));
    await workflows.register(def);
    const { run } = await runs.create({ workflowId: def.id, workflowVersion: 1, params: {} });
    let gets = 0;
    let fired = false;
    const store = new Proxy(runs, {
      get(target, prop) {
        if (prop === 'get' && moment === 'read') {
          return async (id: string) => {
            if (++gets === 3 && !fired) {
              fired = true;
              await act(target, id);
            }
            return target.get(id);
          };
        }
        if (prop === 'claimStep' && moment === 'claim') {
          return async (...a: Parameters<JsonFileStore['claimStep']>) => {
            if (a[1] === 's' && !fired) {
              fired = true;
              await act(target, a[0]);
            }
            return target.claimStep(...a);
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
      store,
      workflows,
      HERE,
      (l) => lines.push(l),
      new ExtensionRegistry(),
    );
    const after = await runs.get(run.id);
    const from = lines.findIndex((l) => l.startsWith('Owed to the engine:'));
    return {
      fired,
      code,
      lines: lines.slice(from).map((l) => l.split(run.id).join('<run>')),
      after,
    };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe('#625 PR-2a, F7 — realm run advance reads core’s classifier', () => {
  it('G7-02: another program ran the step and its chain opened a question first (taken) — the stop line names the answer command, from the record the call ended on', async () => {
    const def = wf('race-adv-g702', ['u']);
    const r = await advance(def, 'read', async (runs, id) => {
      await advanceRun(runs, def, { runId: id, driver: RACER });
    });
    // (a) red when the question's line names no `realm run respond` command (the reply the call
    //     first composed had no answer act); (b) prints the lines.
    expect({
      fired: r.fired,
      code: r.code,
      lines: r.lines.map((l) => l.replace(/--gate \S+/, '--gate <gate>')),
    }).toEqual({
      fired: true,
      code: 0,
      lines: [
        "Owed to the engine: 's'.",
        '→ s',
        // the taken line as before (decision C25; review G7-15 is not this unit's)
        "• Step 's' was taken by another process, whose claim is no longer on the record; not run here.",
        'Stopped: a question is open — realm run respond <run> --gate <gate> --choice <one of: ok, no>',
        "Run <run>: phase 'gate_waiting'",
      ],
    });
  });

  it('row 2b (G7-04’s r2 abandon): another program ended the run before the step’s read — never the taken line; the stop says the ending (preservation)', async () => {
    const r = await advance(wf('race-adv-2b'), 'read', async (runs, id) => {
      await abandonRun(runs, id, 'another program');
    });
    // (a) red when the race is said as taken, or as `'s' failed`; (b) prints the lines.
    expect({ fired: r.fired, code: r.code, lines: r.lines }).toEqual({
      fired: true,
      code: 0,
      lines: [
        "Owed to the engine: 's'.",
        '→ s',
        'Stopped: the run has ended (abandoned). An operator ended this run, with the reason "another program"; to run the work again, start a new run.',
        "Run <run>: phase 'abandoned'",
      ],
    });
  });

  it('row 2c: another program opened a question before the step’s read — no line of its own; the stop names the answer (preservation)', async () => {
    const def = wf('race-adv-2c', []);
    const r = await advance(def, 'read', async (runs, id) => {
      await executeStep(runs, def, {
        runId: id,
        command: 'x',
        input: {},
        dispatcher: async () => ({}),
        driver: RACER,
      });
    });
    // (a) red when the race prints a line of its own, `'s'` is said as failed or taken, or the stop
    //     names no answer; (b) prints the lines.
    expect({
      fired: r.fired,
      code: r.code,
      lines: r.lines.map((l) => l.replace(/--gate \S+/, '--gate <gate>')),
    }).toEqual({
      fired: true,
      code: 0,
      lines: [
        "Owed to the engine: 's', 'x'; it runs them until a step opens a question, fails or ends the run.",
        '→ s',
        "Stopped: a question is open ('s' waits for its answer) — realm run respond <run> --gate <gate> --choice <one of: ok, no>",
        "Run <run>: phase 'gate_waiting'",
      ],
    });
  });

  it('row 9: the claim’s re-check refuses with nothing on the record to say why — no line, the step runs (preservation)', async () => {
    const r = await advance(wf('race-adv-9'), 'claim', async () => {
      throw new WorkflowError("Step 's' is not eligible for execution.", {
        code: 'STATE_STEP_NOT_ELIGIBLE',
        category: 'STATE',
        agentAction: 'resolve_precondition',
        retryable: false,
      });
    });
    // (a) red when the refusal is said as a failure or the step is not run again; (b) prints them.
    expect({ fired: r.fired, code: r.code, lines: r.lines, done: r.after.completed_steps }).toEqual(
      {
        fired: true,
        code: 0,
        lines: ["Owed to the engine: 's'.", '→ s', '→ s', '→ u', "Run <run>: phase 'completed'"],
        done: ['s', 'u'],
      },
    );
  });
});

describe('#625 PR-2a, F7 (a) — the preview at an open question calls no writer (G7-03 = G2-R1)', () => {
  it('another program answers the question after the command read the run: the preview runs nothing — never the steps that answer made ready, unprinted', async () => {
    claim(
      ACTING,
      "At an open question the command runs nothing, and its `Nothing is owed to the engine: a question is open — realm run respond …` line is composed from the run's record as the command read it: when another program answers the question meanwhile, the steps that answer made ready are left for the next `realm run advance`.",
    );
    const home = mkdtempSync(join(tmpdir(), 'realm-race-preview-625-'));
    try {
      const def: WorkflowDefinition = {
        id: 'race-preview',
        name: 'race-preview',
        version: 1,
        schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
        steps: {
          q: QUESTION([]),
          t: { description: 'T.', execution: 'auto', depends_on: ['q'] },
          u: { description: 'U.', execution: 'auto', depends_on: ['t'] },
        },
      };
      const runs = new JsonFileStore(join(home, 'runs'));
      const workflows = new JsonWorkflowStore(join(home, 'wf'));
      await workflows.register(def);
      const { run } = await runs.create({ workflowId: def.id, workflowVersion: 1, params: {} });
      await advanceRun(runs, def, { runId: run.id });
      const gate = (await runs.get(run.id)).pending_gate!.gate_id;
      let reads = 0;
      // The command's own read returns the run with its question open; then another program answers.
      const store = new Proxy(runs, {
        get(target, prop) {
          if (prop === 'get') {
            return async (id: string): Promise<RunRecord> => {
              const record = await target.get(id);
              if (++reads === 1) {
                await submitHumanResponse(target, def, { runId: id, gateId: gate, choice: 'ok' });
              }
              return record;
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
        store,
        workflows,
        HERE,
        (l) => lines.push(l),
        new ExtensionRegistry(),
      );
      const after = await runs.get(run.id);
      // (a) red when the preview calls the writer `advanceRun` (it runs `t` and `u` with no `→`
      //     line, and the record shows them completed); (b) prints the last line and the record.
      expect({
        code,
        ran: lines.filter((l) => l.startsWith('→ ')),
        last: lines.at(-1)?.split(run.id).join('<run>').replace(gate, '<gate>'),
        done: after.completed_steps,
      }).toEqual({
        code: 0,
        ran: [],
        last: 'Nothing is owed to the engine: a question is open — realm run respond <run> --gate <gate> --choice <one of: ok, no>',
        done: ['q'],
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
