// output-source-625.test.ts — issue #625 PR-2a, the last prompt's F4 (framework §5 E1; review A2-2, A3-8,
// A3-9): `output_source` is one exported vocabulary, and one core read gives, for any evidence entry,
// the source or why there is none. Each member is produced by the engine or a caller; each absence
// cause is read off an entry of exactly that kind, built the way the engine builds it.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as core from '../index.js';
import { advanceRun, executeStep, submitHumanResponse } from './execution-loop.js';
import { reclaimStep } from './reclaim-step.js';
import { ExtensionRegistry } from '../extensions/registry.js';
import { JsonFileStore } from '../store/json-file-store.js';
import type { EvidenceSnapshot } from '../types/run-record.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';

/** F4's exports, read off the module so a cell can run before they exist (and fail on that). */
const F4 = core as unknown as {
  OUTPUT_SOURCES?: readonly string[];
  OUTPUT_SOURCE_ABSENT_CAUSES?: readonly string[];
  outputSourceOf?: (
    entry: EvidenceSnapshot,
    definition: Pick<WorkflowDefinition, 'steps'> | undefined,
  ) => { source: string } | { absent_cause: string };
};
const read = (entry: EvidenceSnapshot | undefined, def: WorkflowDefinition | undefined) =>
  entry === undefined ? '<no entry>' : (F4.outputSourceOf?.(entry, def) ?? '<no outputSourceOf>');

/** `first` (agent), then bare `auto` steps: `fromDep` after `first`, `fromParams` with no
 *  dependency, `fromTwo` after two steps; `ask` a question; `handled` a step with a handler. */
const WF: WorkflowDefinition = {
  id: 'os-625',
  name: 'output source',
  version: 1,
  steps: {
    first: { description: 'First.', execution: 'agent', depends_on: [] },
    second: { description: 'Second.', execution: 'agent', depends_on: [] },
    fromDep: { description: 'From its one dependency.', execution: 'auto', depends_on: ['first'] },
    fromParams: { description: 'From the params.', execution: 'auto', depends_on: [] },
    fromTwo: {
      description: 'Two dependencies.',
      execution: 'auto',
      depends_on: ['first', 'second'],
    },
    ask: {
      description: 'Ask.',
      execution: 'auto',
      trust: 'human_confirmed',
      depends_on: ['fromTwo'],
      gate: { choices: ['approve', 'reject'] },
    },
    handled: { description: 'Handled.', execution: 'auto', handler: 'mark', depends_on: ['ask'] },
  },
};

describe('#625 PR-2a, F4 — output_source: one vocabulary, and the source or why there is none', () => {
  let store: JsonFileStore;
  beforeEach(async () => {
    store = new JsonFileStore(await mkdtemp(join(tmpdir(), 'realm-os-625-')));
  });

  const entryOf = async (runId: string, step: string, kind?: string) =>
    (await store.get(runId)).evidence.find(
      (e) =>
        e.step_id === step && (kind === undefined ? e.kind !== 'gate_response' : e.kind === kind),
    );

  it('the vocabulary is one exported const; its members are what the type allows', () => {
    // (a) red when the members are stated anywhere but one const (no export), or one is added or
    //     dropped without the const; (b) prints the const.
    expect(F4.OUTPUT_SOURCES).toEqual(['driven_step', 'dependency', 'run_params', 'none']);
    expect(F4.OUTPUT_SOURCE_ABSENT_CAUSES).toEqual([
      'not_an_output_entry',
      'definition_unavailable',
      'not_a_bare_step',
      'predates_output_source',
    ]);
  });

  it('each member, as the engine or a caller records it: driven_step, dependency, run_params, none', async () => {
    const { run } = await store.create({ workflowId: WF.id, workflowVersion: 1, params: { x: 1 } });
    // driven_step: a caller names the bare step and its dispatcher returns the output.
    await executeStep(store, WF, {
      runId: run.id,
      command: 'fromParams',
      input: {},
      dispatcher: async () => ({ given: true }),
    });
    for (const step of ['first', 'second']) {
      await executeStep(store, WF, {
        runId: run.id,
        command: step,
        input: {},
        dispatcher: async () => ({ out: step }),
      });
    }
    // dependency and none: the engine runs the bare steps the agent steps left owed.
    await advanceRun(store, WF, { runId: run.id });
    const { run: other } = await store.create({
      workflowId: WF.id,
      workflowVersion: 1,
      params: { y: 2 },
    });
    // run_params: the engine runs a bare step with no dependency.
    await advanceRun(store, WF, { runId: other.id });
    // (a) red when a member is not recorded as its source, or the read does not return it;
    //     (b) prints each entry's read.
    expect({
      driven_step: read(await entryOf(run.id, 'fromParams'), WF),
      dependency: read(await entryOf(run.id, 'fromDep'), WF),
      none: read(await entryOf(run.id, 'fromTwo'), WF),
      run_params: read(await entryOf(other.id, 'fromParams'), WF),
    }).toEqual({
      driven_step: { source: 'driven_step' },
      dependency: { source: 'dependency' },
      none: { source: 'none' },
      run_params: { source: 'run_params' },
    });
  });

  it('each absence, read off an entry of exactly that kind: not_an_output_entry (an answer; a reclaim audit entry), definition_unavailable, not_a_bare_step, predates_output_source', async () => {
    const registry = new ExtensionRegistry();
    registry.register('handler', 'mark', {
      id: 'mark',
      execute: async () => ({ data: { marked: true } }),
    });
    const { run } = await store.create({ workflowId: WF.id, workflowVersion: 1, params: {} });
    for (const step of ['first', 'second']) {
      await executeStep(store, WF, {
        runId: run.id,
        command: step,
        input: {},
        dispatcher: async () => ({ out: step }),
      });
    }
    await advanceRun(store, WF, { runId: run.id });
    const gate = (await store.get(run.id)).pending_gate!;
    await submitHumanResponse(store, WF, {
      runId: run.id,
      gateId: gate.gate_id,
      choice: 'approve',
    });
    await advanceRun(store, WF, { runId: run.id, registry });
    // a reclaim audit entry: a claim that is cleared by `reclaimStep` writes one.
    const { run: held } = await store.create({ workflowId: WF.id, workflowVersion: 1, params: {} });
    await store.claimStep(held.id, 'first', WF);
    await reclaimStep(store, held.id, 'first');
    const reclaimEntry = (await store.get(held.id)).evidence.find(
      (e) => e.step_id === 'first' && e.output_summary?.['reclaimed'] === true,
    );
    // a bare step's entry from before the field existed: the same entry, without it.
    const fromDep = await entryOf(run.id, 'fromDep');
    const { output_source: _dropped, ...old } = fromDep!;
    // (a) red when a cause says something false about its entry, or a cause is reached out of order;
    //     (b) prints each read.
    expect({
      answer: read(await entryOf(run.id, 'ask', 'gate_response'), WF),
      reclaim: read(reclaimEntry, WF),
      noDefinition: read(old as EvidenceSnapshot, undefined),
      renamedStep: read({ ...old, step_id: 'gone' } as EvidenceSnapshot, WF),
      handled: read(await entryOf(run.id, 'handled'), WF),
      predates: read(old as EvidenceSnapshot, WF),
      carriesItAnyway: read(fromDep, undefined),
    }).toEqual({
      answer: { absent_cause: 'not_an_output_entry' },
      reclaim: { absent_cause: 'not_an_output_entry' },
      noDefinition: { absent_cause: 'definition_unavailable' },
      renamedStep: { absent_cause: 'definition_unavailable' },
      handled: { absent_cause: 'not_a_bare_step' },
      predates: { absent_cause: 'predates_output_source' },
      carriesItAnyway: { source: 'dependency' },
    });
    // (a) red when the fixture does not reach the kinds it names; (b) prints the entries' fields.
    expect({
      handledHasHandler: WF.steps['handled']?.handler,
      reclaimed: reclaimEntry?.output_summary?.['reclaimed'],
    }).toEqual({ handledHasHandler: 'mark', reclaimed: true });
  });
});
