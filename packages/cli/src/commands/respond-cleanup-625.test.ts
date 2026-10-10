// respond-cleanup-625.test.ts — issue #625 PR-2a, the last prompt's F9 (review G2-R5): `realm run
// respond` names only the cleanup steps its answer's ending ran or left pending — decision C210's rule,
// which `realm run advance` follows, now held by the one composer every answering surface prints
// (`describeAnswerEnding`, with the record read before the answer).
//
// In-process: the command's body (`respondToGate`), and `resumeRun`, on a fresh store.
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
  advanceRun,
  type StepDefinition,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { respondToGate } from './respond.js';
import { resumeRun } from './resume.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const ACTING = 'docs/reference/cli/realm-run-acting.md';

/** (a) red when the page no longer holds the sentence word for word; (b) prints it. */
function claim(page: string, sentence: string): void {
  const flat = (t: string) => t.replace(/\s+/g, ' ');
  expect(
    flat(readFileSync(join(ROOT, page), 'utf8')),
    `${page} no longer says: ${sentence}`,
  ).toContain(flat(sentence));
}

/** `s` (fails the first time it runs), the question `q`, guard `g` on its answer, cleanup step `tidy`. */
const DEF: WorkflowDefinition = {
  id: 'f9-respond',
  name: 'f9-respond',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    s: { description: 'S.', execution: 'auto', handler: 'flaky', depends_on: [] },
    q: {
      description: 'Q.',
      execution: 'auto',
      depends_on: ['s'],
      trust: 'human_confirmed',
      gate: { choices: ['ok', 'no'] },
    } as StepDefinition,
    g: {
      description: 'G.',
      execution: 'guard',
      depends_on: ['q'],
      abort_unless: ["q.choice == 'ok'"],
      abort_message: 'Not approved.',
    } as StepDefinition,
    tidy: {
      description: 'Tidy.',
      execution: 'finalizer',
      handler: 'tidy',
      on_outcome: 'always',
    } as StepDefinition,
  },
};

describe('#625 PR-2a, F9 — realm run respond names only the cleanup steps its answer’s ending ran', () => {
  /** A fresh run; `failFirst` makes `s` fail once, so the run ends, `tidy` runs, and it is resumed. */
  async function toTheQuestion(failFirst: boolean) {
    const home = mkdtempSync(join(tmpdir(), 'realm-respond-cleanup-625-'));
    const runs = new JsonFileStore(join(home, 'runs'));
    const workflows = new JsonWorkflowStore(join(home, 'wf'));
    await workflows.register(DEF);
    let flaky = 0;
    let tidy = 0;
    const registry = new ExtensionRegistry();
    registry.register('handler', 'flaky', {
      id: 'flaky',
      execute: async () => {
        flaky += 1;
        if (failFirst && flaky === 1) throw new Error('first time');
        return { data: {} };
      },
    });
    registry.register('handler', 'tidy', {
      id: 'tidy',
      execute: async () => {
        tidy += 1;
        return { data: {} };
      },
    });
    const { run } = await runs.create({ workflowId: DEF.id, workflowVersion: 1, params: {} });
    await advanceRun(runs, DEF, { runId: run.id, registry });
    if (failFirst) {
      // the first ending ran `tidy`; resume, and the run reaches the question
      expect((await runs.get(run.id)).finalizer_ledger?.['tidy']?.status, 'fixture').toBe(
        'completed',
      );
      await resumeRun(run.id, 's', runs, workflows, {});
      await advanceRun(runs, DEF, { runId: run.id, registry });
    }
    const gate = (await runs.get(run.id)).pending_gate!.gate_id;
    return { home, runs, workflows, registry, runId: run.id, gate, tidyRuns: () => tidy };
  }

  it('after a resume, the answer that ends the run again: no line for the cleanup step that ran at the first ending', async () => {
    claim(
      ACTING,
      "When the run ended and it has cleanup steps, they run in this process, and one line follows for each cleanup step this ending ran or left pending: `finalizer '<name>': <status>`. A cleanup step that completed or failed at an earlier ending, before `realm run resume`, does not run again and gets no line.",
    );
    const r = await toTheQuestion(true);
    try {
      const out = await respondToGate(
        r.runId,
        { gate: r.gate, choice: 'no' },
        r.runs,
        r.workflows,
        r.registry,
      );
      // (a) red when the answer's lines name `tidy` as if it ran in this call (G2-R5); (b) prints
      //     the lines and how many times `tidy` ran.
      expect({
        lines: out.lines.filter((l) => !l.startsWith('Responded:')),
        tidyRuns: r.tidyRuns(),
      }).toEqual({
        lines: ["Guard step 'g' aborted the run.", 'Reason: Not approved.'],
        tidyRuns: 1,
      });
    } finally {
      rmSync(r.home, { recursive: true, force: true });
    }
  });

  it('the first ending (preservation): the cleanup step that ran in this call gets its line', async () => {
    const r = await toTheQuestion(false);
    try {
      const out = await respondToGate(
        r.runId,
        { gate: r.gate, choice: 'no' },
        r.runs,
        r.workflows,
        r.registry,
      );
      // (a) red when the cleanup step this answer's ending ran loses its line; (b) prints the lines.
      expect({
        lines: out.lines.filter((l) => !l.startsWith('Responded:')),
        tidyRuns: r.tidyRuns(),
      }).toEqual({
        lines: [
          "Guard step 'g' aborted the run.",
          'Reason: Not approved.',
          "finalizer 'tidy': completed",
        ],
        tidyRuns: 1,
      });
    } finally {
      rmSync(r.home, { recursive: true, force: true });
    }
  });
});
