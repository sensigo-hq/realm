// cannot-go-on-625.test.ts — issue #625 PR-2a, decisions C62 and C64: WHEN a run cannot go on from
// here. #729 PR-0: the state is core's one predicate over the ways (`cannotGoOnFrom`, with
// `cannotGoOnUntilCorrected` for a step refused before its claim); the lines an operator surface
// prints for it are the CLI door's (`cannotGoOnLines`, pinned whole in cli's ways-renderer.test.ts).
// A cell per branch, and a control for each condition of the state.
import { describe, it, expect } from 'vitest';
import { mkdtemp as mkdtempP, rm as rmP } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileStore } from '../store/json-file-store.js';
import {
  cannotGoOnFrom,
  cannotGoOnUntilCorrected,
  composeWaysAt,
  type ComposedWays,
  type Unavailable,
} from './ways.js';
import { ExtensionRegistry } from '../extensions/registry.js';
import type { WorkflowDefinition, StepDefinition } from '../types/workflow-definition.js';
import type { RunRecord } from '../types/run-record.js';

async function withRun<T>(fn: (run: RunRecord) => Promise<T>): Promise<T> {
  const dir = await mkdtempP(join(tmpdir(), 'realm-cannot-go-on-625-'));
  try {
    const { run } = await new JsonFileStore(dir).create({
      workflowId: 'c64-wf',
      workflowVersion: 1,
      params: {},
    });
    return await fn(run);
  } finally {
    await rmP(dir, { recursive: true, force: true });
  }
}

const def = (steps: Record<string, StepDefinition>) =>
  ({ id: 'c64-wf', name: 'c64', version: 1, steps }) as WorkflowDefinition;

const needsN: StepDefinition = {
  description: 'X',
  execution: 'auto',
  depends_on: [],
  input_schema: { type: 'object', required: ['n'], properties: { n: { type: 'number' } } },
};
const missing: StepDefinition = {
  description: 'Y',
  execution: 'auto',
  depends_on: [],
  handler: 'missing_h',
};

/** The ways of `run` under `d`, judged with an empty registry (this program) or none (an observer). */
const ways = (run: RunRecord, d: WorkflowDefinition, registry?: ExtensionRegistry): ComposedWays =>
  composeWaysAt(run, new Date(), {
    definition: d,
    ...(registry !== undefined ? { registry } : {}),
  });

/** Both predicates, and the codes of the steps that cannot run, in one object. */
const state = (composed: ComposedWays) => ({
  here: cannotGoOnFrom(composed),
  corrected: cannotGoOnUntilCorrected(composed),
  cannot_run: composed.unavailable
    .filter(
      (u) =>
        u.verb === 'run_step' &&
        (u.code === 'refused_before_claim' || u.code === 'capability_missing'),
    )
    .map((u) => `${u.step}:${u.code}`),
});

describe('#625 PR-2a, C64 — when a run cannot go on from here (the one predicate)', () => {
  it('a refusal before the claim: the state, and it waits on a corrected workflow', async () => {
    await withRun(async (run) => {
      // (a) red when a step refused before its claim does not make the state; (b) prints it.
      expect(state(ways(run, def({ x: needsN }), new ExtensionRegistry()))).toEqual({
        here: true,
        corrected: true,
        cannot_run: ['x:refused_before_claim'],
      });
    });
  });

  it('a capability refusal alone (judged with a registry): the state, but not a corrected workflow — another runner can run it', async () => {
    await withRun(async (run) => {
      // (a) red when a capability counts as a refusal the workflow must correct; (b) prints it.
      expect(state(ways(run, def({ y: missing }), new ExtensionRegistry()))).toEqual({
        here: true,
        corrected: false,
        cannot_run: ['y:capability_missing'],
      });
    });
  });

  it("a capability refusal judged from the run's marker (no registry): the state", async () => {
    await withRun(async (run) => {
      const marked: RunRecord = {
        ...run,
        capability_blocks: {
          y: {
            requirement: { kind: 'handler', name: 'missing_h' },
            code: 'ENGINE_HANDLER_NOT_REGISTERED',
            at: '2026-10-05T00:00:00.000Z',
          },
        },
      };
      const composed = ways(marked, def({ y: missing }));
      expect(state(composed)).toEqual({
        here: true,
        corrected: false,
        cannot_run: ['y:capability_missing'],
      });
      // (a) red when the marker's basis is lost; (b) prints the basis.
      const entry = composed.unavailable.find((u) => u.code === 'capability_missing');
      expect(entry?.code === 'capability_missing' ? entry.facts.basis : undefined).toBe('marker');
    });
  });

  it('both: a refusal before the claim and a capability refusal — the state, waiting on a corrected workflow', async () => {
    await withRun(async (run) => {
      expect(state(ways(run, def({ x: needsN, y: missing }), new ExtensionRegistry()))).toEqual({
        here: true,
        corrected: true,
        cannot_run: ['x:refused_before_claim', 'y:capability_missing'],
      });
    });
  });

  it('controls — the run can go on: an agent step ready, the act present, a step in flight, a question open, a terminal run: not the state', async () => {
    await withRun(async (run) => {
      const registry = new ExtensionRegistry();
      const withAgent = def({
        x: needsN,
        a: { description: 'A', execution: 'agent', depends_on: [] },
      });
      expect(cannotGoOnFrom(ways(run, withAgent, registry))).toBe(false);
      const withAct = def({
        x: needsN,
        b: { description: 'B', execution: 'auto', depends_on: [] },
      });
      const act = ways(run, withAct, registry);
      expect(act.ways.some((w) => w.verb === 'advance')).toBe(true);
      expect(cannotGoOnFrom(act)).toBe(false);
      const stuck = def({ x: needsN });
      expect(cannotGoOnFrom(ways({ ...run, in_progress_steps: ['x'] }, stuck, registry))).toBe(
        false,
      );
      const atQuestion = {
        ...run,
        pending_gate: {
          gate_id: 'g',
          step_name: 'x',
          choices: ['approve'],
          opened_at: '2026-10-05T00:00:00.000Z',
        },
      } as unknown as RunRecord;
      expect(cannotGoOnFrom(ways(atQuestion, stuck, registry))).toBe(false);
      expect(
        cannotGoOnFrom(ways({ ...run, terminal_state: true } as RunRecord, stuck, registry)),
      ).toBe(false);
      // Not vacuous: the same run, nothing else, IS the state.
      expect(cannotGoOnFrom(ways(run, stuck, registry))).toBe(true);
    });
  });

  it('C71 — a live run with no question, no act, no agent step ready, nothing in flight and no engine step that cannot run (#537’s structurally dead run): not this state', () => {
    // Hand-built: ways where nothing is offered but reading and ending, and nothing is refused. Every
    // other conjunct of `cannotGoOnFrom` holds here, so only "a step cannot run" decides it.
    const nothing: Pick<ComposedWays, 'ways' | 'unavailable'> = {
      ways: [
        { verb: 'inspect', conditions: [], run_id: 'r' },
        { verb: 'abandon', conditions: [], run_id: 'r' },
      ],
      unavailable: [],
    };
    // (a) red when `cannotGoOnFrom` drops its last conjunct (every surface would then print a bare
    //     "To end the run instead" with no reason); (b) prints the boolean.
    expect(cannotGoOnFrom(nothing)).toBe(false);
    // Not vacuous: the same ways with one step that cannot run IS the state.
    const refusedX: Unavailable = {
      verb: 'run_step',
      step: 'x',
      code: 'refused_before_claim',
      facts: { step: 'x', check: 'precondition', refusal: 'no' },
      remedy: [],
    };
    expect(cannotGoOnFrom({ ...nothing, unavailable: [refusedX] })).toBe(true);
  });
});
