// generator-625.test.ts — issue #625 PR-2a: the protocol text a driving agent reads names
// advance_run wherever the engine owes steps it runs when advance_run is called. Whole-message pins.
import { describe, it, expect } from 'vitest';
import type { WorkflowDefinition } from '@sensigo/realm';
import { generateProtocol } from './generator.js';

const def: WorkflowDefinition = {
  id: 'proto-625',
  name: 'proto',
  version: 1,
  steps: {
    a: { description: 'A', execution: 'agent', depends_on: [] },
    b: { description: 'B', execution: 'auto', depends_on: ['a'] },
    g: { description: 'G', execution: 'guard', depends_on: ['b'], abort_unless: ['b.ok == true'] },
    c: {
      description: 'C',
      execution: 'auto',
      trust: 'human_confirmed',
      depends_on: ['g'],
      gate: { choices: ['approve', 'reject'] },
    },
    f: {
      description: 'F',
      execution: 'finalizer',
      handler: 'h',
      on_outcome: ['complete'],
    } as never,
  },
};

describe('#625 PR-2a — protocol text', () => {
  const p = generateProtocol(def);
  const step = (id: string) => p.steps.find((s) => s.id === id)!;
  it('auto, guard, finalizer, auto+gate', () => {
    expect(step('b').agent_involvement).toBe(
      'none — the engine runs this step; when next_actions names advance_run, call it',
    );
    expect(step('g').agent_involvement).toBe(
      'none — the engine settles this guard step itself; when next_actions names advance_run, call it, and do NOT call execute_step for it.',
    );
    expect(step('f').agent_involvement).toBe(
      'none — the engine runs this finalizer step itself when the run ends; do NOT call execute_step for it.',
    );
    expect(
      step('c').agent_involvement.startsWith(
        'YOU will receive `status: confirm_required` after this step runs — the engine runs it (when next_actions names advance_run, call it), then opens a gate.',
      ),
    ).toBe(true);
  });
  it('quick_start (agent present) and the default rule', () => {
    expect(p.quick_start).toBe(
      "Call start_run with workflow_id 'proto-625'. The engine runs the steps it owns and returns control at the first step requiring agent action; when next_actions names advance_run, call it. Follow the next_action in each response until the workflow completes.",
    );
    expect(p.rules).toContain(
      'When next_actions names advance_run, call it: the engine owes steps it runs when you call advance_run.',
    );
  });
});
