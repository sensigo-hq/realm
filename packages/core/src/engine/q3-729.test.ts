// q3-729.test.ts — issue #729, the Q3 unit (the owner's "q3 - yes", 2026-10-16): an AGENT's by-name
// call on an eligible engine step is refused by the one admission (`admitWay`) and told to advance;
// every other caller — the library embedder (no party), an operator party, the engine's own chain —
// keeps today's behaviour, by construction (the party rides the call; absence is the program itself).
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure: codes,
// step names, verbs and booleans — never a value a caller supplied.
import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { admitWay, readSupplier, type Unavailable, type WaysContext } from './ways.js';
import { writtenSnapshot } from './snapshot.js';
import { advanceRun, executeStep, notCallableWords } from './execution-loop.js';
import { JsonFileStore } from '../store/json-file-store.js';
import { ExtensionRegistry } from '../extensions/registry.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
import type { RunRecord } from '../types/run-record.js';

const AT = new Date('2026-10-16T12:00:00.000Z');
const AGENT_PARAMS = { p: 'AGENT-PARAMS' };

/** W3: the agent step `first`, then one step of each engine kind, all owed once `first` is answered. */
const W3: WorkflowDefinition = {
  id: 'q3-w3',
  name: 'q3-w3',
  version: 1,
  steps: {
    first: { description: 'First.', execution: 'agent', depends_on: [] },
    u: { description: 'U.', execution: 'auto', depends_on: ['first'], handler: 'h' },
    m: {
      description: 'M.',
      execution: 'auto',
      depends_on: ['first'],
      handler: 'hm',
      input_map: { x: 'run.params.x' },
    },
    b: { description: 'B.', execution: 'auto', depends_on: ['first'] },
    // after `u`, so it stays unsettled until the engine runs `u` (a guard settles with its dependency)
    g: {
      description: 'G.',
      execution: 'guard',
      depends_on: ['u'],
      abort_unless: ["u.ran == 'h'"],
    },
    q: {
      description: 'Q.',
      execution: 'auto',
      depends_on: ['first'],
      trust: 'human_confirmed',
      gate: { choices: ['yes', 'no'] },
    },
    f: { description: 'F.', execution: 'finalizer', on_outcome: 'complete', handler: 'h' },
  },
} as WorkflowDefinition;

/** K: the only owed step after `first` is one whose handler this program lacks. */
const WK: WorkflowDefinition = {
  id: 'q3-wk',
  name: 'q3-wk',
  version: 1,
  steps: {
    first: { description: 'First.', execution: 'agent', depends_on: [] },
    k: { description: 'K.', execution: 'auto', depends_on: ['first'], handler: 'missing' },
  },
} as WorkflowDefinition;

/** K with an agent step ready beside it: `advance`'s listed entry leads on to the agent's step. */
const WKA: WorkflowDefinition = {
  id: 'q3-wka',
  name: 'q3-wka',
  version: 1,
  steps: {
    first: { description: 'First.', execution: 'agent', depends_on: [] },
    k: { description: 'K.', execution: 'auto', depends_on: ['first'], handler: 'missing' },
    second: { description: 'Second.', execution: 'agent', depends_on: ['first'] },
  },
} as WorkflowDefinition;

/** W2's `publish`: an engine step refused for its input, building none from an input_map (T-17's lever). */
const W2: WorkflowDefinition = {
  id: 'q3-w2',
  name: 'q3-w2',
  version: 1,
  steps: {
    publish: {
      description: 'Publish.',
      execution: 'auto',
      depends_on: [],
      input_schema: { type: 'object', required: ['n'], properties: { n: { type: 'number' } } },
    },
  },
} as WorkflowDefinition;

function registry(): ExtensionRegistry {
  const r = new ExtensionRegistry();
  r.register('handler', 'h', { id: 'h', execute: async () => ({ data: { ran: 'h' } }) });
  r.register('handler', 'hm', { id: 'hm', execute: async () => ({ data: { ran: 'hm' } }) });
  return r;
}

function ctx(definition: WorkflowDefinition, extra: Partial<WaysContext> = {}): WaysContext {
  return {
    definition: { ok: definition },
    enactor: { kind: 'this_program', registry: registry() },
    store: { persistsClaims: true },
    ...extra,
  };
}

/** A run of `definition` with `first` answered through the library (no chain), and its store. */
async function answered(
  definition: WorkflowDefinition,
  params: Record<string, unknown> = { x: 'from-params' },
): Promise<{ store: JsonFileStore; record: RunRecord }> {
  const store = new JsonFileStore(await mkdtemp(join(tmpdir(), 'realm-q3-729-')));
  const { run } = await store.create({ workflowId: definition.id, workflowVersion: 1, params });
  if (definition.steps['first'] !== undefined) {
    await executeStep(store, definition, {
      runId: run.id,
      command: 'first',
      input: {},
      dispatcher: async () => ({ answered: true }),
    });
  }
  return { store, record: await store.get(run.id) };
}

const admit = (
  record: RunRecord,
  c: WaysContext,
  command: string,
  params: Record<string, unknown> = AGENT_PARAMS,
) => admitWay('run_step', writtenSnapshot(record, AT), c, { run_id: record.id, command, params });

/** A verdict as data: the code, the facts' execution, the remedy's verbs and the no-remedy cause. */
const shapeOf = (a: ReturnType<typeof admitWay>) =>
  'ok' in a
    ? 'ok'
    : {
        code: a.code,
        execution: (a.facts as { execution?: string }).execution,
        remedy: a.remedy.map((w) => w.verb),
        no_remedy: (a as Unavailable & { no_remedy?: { cause: string } }).no_remedy?.cause,
      };

describe('#729 Q3 — the agent party: an eligible engine step called by name is the engine’s', () => {
  it('cell 1: U, M, B and Q with party agent → step_engine_decided { execution: auto }, remedy [advance]', async () => {
    const { record } = await answered(W3);
    const c = ctx(W3, { party: 'agent' });
    // (a) red when the party conjunct is dropped (each step admitted); (b) prints each verdict.
    expect(
      Object.fromEntries(['u', 'm', 'b', 'q'].map((s) => [s, shapeOf(admit(record, c, s))])),
    ).toEqual(
      Object.fromEntries(
        ['u', 'm', 'b', 'q'].map((s) => [
          s,
          {
            code: 'step_engine_decided',
            execution: 'auto',
            remedy: ['advance'],
            no_remedy: undefined,
          },
        ]),
      ),
    );
  });

  it('cell 1 (K): the only owed step lacks its handler here → step_engine_decided, remedy [], no_remedy requires_other_program (the listed advance entry’s)', async () => {
    const { record } = await answered(WK);
    // (a) red when the arm says the engine runs it on a program that cannot, or admits it; (b)
    //     prints the verdict.
    expect(shapeOf(admit(record, ctx(WK, { party: 'agent' }), 'k'))).toEqual({
      code: 'step_engine_decided',
      execution: 'auto',
      remedy: [],
      no_remedy: 'requires_other_program',
    });
  });

  it('cell 1 (K beside a ready agent step): the listed advance entry’s remedy leads on — no no_remedy beside it', async () => {
    const { record } = await answered(WKA);
    // (a) red when a no-remedy cause is set beside a remedy that leads on (the prompt snippet's `??`
    //     would add engine_runs_it_when_owed here); (b) prints the verdict.
    expect(shapeOf(admit(record, ctx(WKA, { party: 'agent' }), 'k'))).toEqual({
      code: 'step_engine_decided',
      execution: 'auto',
      remedy: ['run_step'],
      no_remedy: undefined,
    });
  });

  it('cell 2: the same calls with NO party (the library, the engine) → admitted for U, M, B, Q; K keeps its capability entry', async () => {
    const { record } = await answered(W3);
    const k = await answered(WK);
    // (a) red when the arm fires for a call with no party (the inverse break); (b) prints each.
    expect({
      ...Object.fromEntries(
        ['u', 'm', 'b', 'q'].map((s) => [s, shapeOf(admit(record, ctx(W3), s))]),
      ),
      k: (shapeOf(admit(k.record, ctx(WK), 'k')) as { code: string }).code,
    }).toEqual({ u: 'ok', m: 'ok', b: 'ok', q: 'ok', k: 'capability_missing' });
  });

  it('cell 3: party operator → admitted (the arm is the agent’s alone, never `party !== undefined`)', async () => {
    const { record } = await answered(W3);
    // (a) red when the conjunct reads any party; (b) prints the verdict.
    expect(shapeOf(admit(record, ctx(W3, { party: 'operator' }), 'u'))).toBe('ok');
  });

  it('cell 4: the agent step called by name with party agent → admitted (the agent’s own step)', async () => {
    const store = new JsonFileStore(await mkdtemp(join(tmpdir(), 'realm-q3-729-')));
    const { run } = await store.create({ workflowId: W3.id, workflowVersion: 1, params: {} });
    // (a) red when the arm refuses an agent step; (b) prints the verdict.
    expect(shapeOf(admit(await store.get(run.id), ctx(W3, { party: 'agent' }), 'first'))).toBe(
      'ok',
    );
  });

  it('cell 5: a guard and a cleanup step with party agent → today’s step_engine_decided (A-7)', async () => {
    const { record } = await answered(W3);
    const c = ctx(W3, { party: 'agent' });
    // (a) red when the guard or finalizer arm moves; (b) prints each code and execution.
    expect({
      g: shapeOf(admit(record, c, 'g')),
      f: (shapeOf(admit(record, c, 'f')) as { code: string; execution: string }).execution,
    }).toEqual({
      g: {
        code: 'step_engine_decided',
        execution: 'guard',
        remedy: ['advance'],
        no_remedy: undefined,
      },
      f: 'finalizer',
    });
  });

  it('cell 6: a step refused before its claim → that refusal for the agent, with or without fitting params; the lever (fitting params, no party) admitted', async () => {
    const { record } = await answered(W2, {});
    const agent = ctx(W2, { party: 'agent' });
    // (a) red when the pre-claim refusal is replaced by the engine's (conjunct (iii)), or the lever
    //     becomes the agent's, or the library loses it; (b) prints each verdict's code.
    expect({
      agent: (shapeOf(admit(record, agent, 'publish', {})) as { code: string }).code,
      agentFitting: (shapeOf(admit(record, agent, 'publish', { n: 1 })) as { code: string }).code,
      libraryFitting: shapeOf(admit(record, ctx(W2), 'publish', { n: 1 })),
    }).toEqual({
      agent: 'refused_before_claim',
      agentFitting: 'refused_before_claim',
      libraryFitting: 'ok',
    });
  });

  it('cell 7: the words — an automatic step’s sentence; the guard’s and the cleanup step’s unchanged', () => {
    const words = (execution: 'auto' | 'guard' | 'finalizer') =>
      notCallableWords({
        verb: 'run_step',
        step: 's',
        code: 'step_engine_decided',
        facts: { step: 's', execution },
        remedy: [],
      });
    // (a) red when a word changes; (b) prints the three sentences.
    expect([words('auto'), words('guard'), words('finalizer')]).toEqual([
      'it is an automatic step: the engine runs it when it is owed',
      'it is a guard step: the engine runs it when the run reaches it',
      'it is a cleanup step: the engine runs it when the run ends',
    ]);
  });

  it('cell 8: after a refusal, the engine’s own chain runs U, M, B and Q as today — the engine’s input, no supplier recorded', async () => {
    const { store, record } = await answered(W3);
    const c = ctx(W3, { party: 'agent' });
    expect(['u', 'm', 'b', 'q'].map((s) => shapeOf(admit(record, c, s)) !== 'ok')).toEqual([
      true,
      true,
      true,
      true,
    ]);
    await advanceRun(store, W3, { runId: record.id, registry: registry() });
    const after = await store.get(record.id);
    const entry = (step: string) => after.evidence.find((e) => e.step_id === step);
    // (a) red when the engine's chain is refused (a party reached it), a step runs on the agent's
    //     params, or a supplier is recorded; (b) prints the steps run, the gate's step, the sources
    //     and whether any entry carries the agent's params — never a value.
    expect({
      ran: ['u', 'm', 'b'].map((s) => after.completed_steps.includes(s)),
      gate: after.pending_gate?.step_name,
      supplier: ['u', 'm', 'b'].map((s) => readSupplier(entry(s)!, W3)),
      mapped: entry('m')?.resolved_params,
      bare: entry('b')?.output_source,
      agentParams: JSON.stringify(after.evidence).includes('AGENT-PARAMS'),
    }).toEqual({
      ran: [true, true, true],
      gate: 'q',
      supplier: [
        { absent: 'engine_input' },
        { absent: 'engine_input' },
        { absent: 'engine_input' },
      ],
      mapped: { x: 'from-params' },
      bare: 'dependency',
      agentParams: false,
    });
  });
});
