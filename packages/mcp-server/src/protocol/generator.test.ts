// Tests for the protocol generator — generateProtocol from WorkflowDefinition.
import { describe, it, expect } from 'vitest';
import { loadWorkflowFromFile } from '@sensigo/realm';
import { join } from 'node:path';
import { generateProtocol } from './generator.js';
import type { WorkflowDefinition } from '@sensigo/realm';

const MULTI_STEP_FIXTURE = join(
  new URL('../../fixtures/multi-step-workflow.yaml', import.meta.url).pathname,
);

describe('generateProtocol', () => {
  it('generates protocol for a 4-step workflow', () => {
    const definition = loadWorkflowFromFile(MULTI_STEP_FIXTURE);
    const protocol = generateProtocol(definition);

    expect(protocol.workflow_id).toBe('multi-step-demo');
    expect(protocol.steps.length).toBe(4);

    const fetchDoc = protocol.steps.find((s) => s.id === 'fetch_document')!;
    expect(fetchDoc.agent_involvement).toContain('automatically');

    const extractFields = protocol.steps.find((s) => s.id === 'extract_fields')!;
    expect(extractFields.agent_involvement).toContain('YOU execute');

    const finalize = protocol.steps.find((s) => s.id === 'finalize')!;
    expect(finalize.agent_involvement).toContain('confirm');
    expect(finalize.possible_gate).toBeDefined();

    expect(protocol.agent_steps_summary).toContain('1 of 4');
    expect(protocol.rules.length).toBeGreaterThanOrEqual(1);
    expect(protocol.error_handling).toHaveProperty('provide_input');
    expect(protocol.error_handling).toHaveProperty('report_to_user');
    expect(protocol.error_handling).toHaveProperty('stop');
    expect(protocol.quick_start.length).toBeGreaterThan(0);
  });

  it('uses protocol.quick_start override when present', () => {
    const definition: WorkflowDefinition = {
      id: 'test-wf',
      name: 'Test',
      version: 1,
      protocol: { quick_start: 'Custom start' },
      steps: {},
    };
    const protocol = generateProtocol(definition);
    expect(protocol.quick_start).toBe('Custom start');
  });

  // issue #178: an empty/whitespace-only authored quick_start must not blank the generated
  // default — `??` treats '' as "present," this must not.
  describe('quick_start — empty/whitespace-only falls back to the generated default (issue #178)', () => {
    const GENERATED_DEFAULT =
      "Call start_run with workflow_id 'test-wf'. The engine handles all steps automatically. " +
      'Follow the next_action in each response until the workflow completes.';

    it('protocol.quick_start: "" falls back to the generated default', () => {
      const definition: WorkflowDefinition = {
        id: 'test-wf',
        name: 'Test',
        version: 1,
        protocol: { quick_start: '' },
        steps: {},
      };
      const protocol = generateProtocol(definition);
      expect(protocol.quick_start).toBe(GENERATED_DEFAULT);
    });

    it('protocol.quick_start: "   " (whitespace-only) falls back to the generated default', () => {
      const definition: WorkflowDefinition = {
        id: 'test-wf',
        name: 'Test',
        version: 1,
        protocol: { quick_start: '   ' },
        steps: {},
      };
      const protocol = generateProtocol(definition);
      expect(protocol.quick_start).toBe(GENERATED_DEFAULT);
    });

    it('absent protocol.quick_start still falls back to the generated default (unchanged, regression guard)', () => {
      const definition: WorkflowDefinition = {
        id: 'test-wf',
        name: 'Test',
        version: 1,
        steps: {},
      };
      const protocol = generateProtocol(definition);
      expect(protocol.quick_start).toBe(GENERATED_DEFAULT);
    });

    it('a real quick_start with surrounding whitespace but real content is used VERBATIM — not swallowed', () => {
      const definition: WorkflowDefinition = {
        id: 'test-wf',
        name: 'Test',
        version: 1,
        protocol: { quick_start: '  Custom start with padding  ' },
        steps: {},
      };
      const protocol = generateProtocol(definition);
      expect(protocol.quick_start).toBe('  Custom start with padding  ');
    });
  });

  it('uses protocol.rules override when present', () => {
    const definition: WorkflowDefinition = {
      id: 'test-wf',
      name: 'Test',
      version: 1,
      protocol: { rules: ['Rule A'] },
      steps: {},
    };
    const protocol = generateProtocol(definition);
    expect(protocol.rules).toEqual(['Rule A']);
  });

  it('auto step with trust: human_confirmed gets possible_gate', () => {
    const definition: WorkflowDefinition = {
      id: 'test-wf',
      name: 'Test',
      version: 1,
      steps: {
        'gate-step': {
          description: 'A gate step',
          execution: 'auto',
          trust: 'human_confirmed',
        },
      },
    };
    const protocol = generateProtocol(definition);
    const step = protocol.steps[0]!;
    expect(step.possible_gate).toBeDefined();
    expect(step.possible_gate!.choices).toContain('approve');
    expect(step.agent_involvement).toContain('confirm');
  });

  it('agent step with resolved profile includes agent_profile_instructions', () => {
    const definition: WorkflowDefinition = {
      id: 'test-wf',
      name: 'Test',
      version: 1,
      steps: {
        'profiled-step': {
          description: 'A profiled agent step',
          execution: 'agent',
          agent_profile: 'my-profile',
        },
      },
      resolved_profiles: {
        'my-profile': { content: 'You are a specialist.', content_hash: 'abc123' },
      },
    };
    const protocol = generateProtocol(definition);
    const step = protocol.steps[0]!;
    expect(step.agent_profile_instructions).toBe('You are a specialist.');
  });

  it('agent step with agent_profile but no resolved_profiles omits agent_profile_instructions', () => {
    const definition: WorkflowDefinition = {
      id: 'test-wf',
      name: 'Test',
      version: 1,
      steps: {
        'profiled-step': {
          description: 'A profiled agent step',
          execution: 'agent',
          agent_profile: 'my-profile',
        },
      },
    };
    const protocol = generateProtocol(definition);
    const step = protocol.steps[0]!;
    expect(step.agent_profile_instructions).toBeUndefined();
  });

  it('never briefs a guard or finalizer step as "YOU execute" (engine-run only)', () => {
    const definition: WorkflowDefinition = {
      id: 'engine-run-wf',
      name: 'Engine Run Workflow',
      version: 1,
      steps: {
        work: { description: 'Domain step', execution: 'agent', depends_on: [] },
        gate_check: {
          description: 'A guard',
          execution: 'guard',
          depends_on: ['work'],
          abort_unless: ["work.status == 'open'"],
        },
        cleanup: {
          description: 'A finalizer',
          execution: 'finalizer',
          on_outcome: 'always',
          handler: 'do_cleanup',
        },
      },
    };
    const protocol = generateProtocol(definition);

    const guard = protocol.steps.find((s) => s.id === 'gate_check')!;
    expect(guard.agent_involvement).not.toContain('YOU execute');
    expect(guard.agent_involvement).toContain('do NOT call execute_step');

    const finalizer = protocol.steps.find((s) => s.id === 'cleanup')!;
    expect(finalizer.agent_involvement).not.toContain('YOU execute');
    expect(finalizer.agent_involvement).toContain('do NOT call execute_step');

    // The domain agent step is still briefed for the agent.
    const work = protocol.steps.find((s) => s.id === 'work')!;
    expect(work.agent_involvement).toContain('YOU execute');
  });

  it('workflow with a description surfaces it on the protocol (issue #144 correction)', () => {
    const definition: WorkflowDefinition = {
      id: 'test-wf',
      name: 'Test',
      description: 'What this workflow is for.',
      version: 1,
      steps: {},
    };
    const protocol = generateProtocol(definition);
    expect(protocol.description).toBe('What this workflow is for.');
  });

  it('workflow with no description omits it from the protocol — no synthesized default', () => {
    const definition: WorkflowDefinition = {
      id: 'test-wf',
      name: 'Test',
      version: 1,
      steps: {},
    };
    const protocol = generateProtocol(definition);
    expect(protocol.description).toBeUndefined();
  });
});
