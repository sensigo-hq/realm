// Unit tests for the pure capability helpers (issue #134): requirementForStep, unmetCapabilities,
// capabilityWarning, and the DEFINITION-FREE findCapabilityBlockedSteps detector.
import { describe, it, expect } from 'vitest';
import {
  requirementForStep,
  unmetCapabilities,
  capabilityWarning,
  findCapabilityBlockedSteps,
} from './capability.js';
import { ExtensionRegistry } from '../extensions/registry.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
import type { RunRecord } from '../types/run-record.js';
import type { StepHandler } from '../extensions/step-handler.js';
import type { ServiceAdapter } from '../extensions/service-adapter.js';

const def: WorkflowDefinition = {
  id: 'wf',
  name: 'WF',
  version: 1,
  services: { svc: { adapter: 'my_adapter', trust: 'engine_delivered' } },
  steps: {
    auto_handler: { description: 'h', execution: 'auto', depends_on: [], handler: 'my_handler' },
    auto_adapter: { description: 'a', execution: 'auto', depends_on: [], uses_service: 'svc' },
    agent_step: { description: 'g', execution: 'agent', depends_on: [] },
    orphan_service: {
      description: 'o',
      execution: 'auto',
      depends_on: [],
      uses_service: 'not_declared',
    },
  },
};

function stubHandler(): StepHandler {
  return { id: 'my_handler', execute: async () => ({ data: {} }) };
}
function stubAdapter(): ServiceAdapter {
  return {
    id: 'my_adapter',
    fetch: async () => ({ status: 200, data: {} }),
    create: async () => ({ status: 200, data: {} }),
    update: async () => ({ status: 200, data: {} }),
  };
}

/** Minimal RunRecord for the pure detector — only the four step sets + capability_blocks are read. */
function makeRun(over: Partial<RunRecord>): RunRecord {
  return {
    completed_steps: [],
    in_progress_steps: [],
    failed_steps: [],
    skipped_steps: [],
    ...over,
  } as RunRecord;
}

describe('requirementForStep (#134)', () => {
  it('adapter step → {kind:adapter, name} from services[uses_service].adapter', () => {
    expect(requirementForStep('auto_adapter', def.steps['auto_adapter']!, def)).toEqual({
      step: 'auto_adapter',
      kind: 'adapter',
      name: 'my_adapter',
    });
  });
  it('handler step → {kind:handler, name}', () => {
    expect(requirementForStep('auto_handler', def.steps['auto_handler']!, def)).toEqual({
      step: 'auto_handler',
      kind: 'handler',
      name: 'my_handler',
    });
  });
  it('agent step → undefined (no registry requirement)', () => {
    expect(requirementForStep('agent_step', def.steps['agent_step']!, def)).toBeUndefined();
  });
  it('uses_service naming an ABSENT service → undefined (workflow bug, not a capability gap)', () => {
    expect(requirementForStep('orphan_service', def.steps['orphan_service']!, def)).toBeUndefined();
  });
});

describe('unmetCapabilities (#134)', () => {
  it('empty registry → both auto reqs unmet (agent + orphan excluded)', () => {
    const unmet = unmetCapabilities(def, new ExtensionRegistry());
    expect(unmet.map((r) => `${r.kind}:${r.name}`).sort()).toEqual([
      'adapter:my_adapter',
      'handler:my_handler',
    ]);
  });
  it('fully-provisioned registry → no unmet', () => {
    const reg = new ExtensionRegistry();
    reg.register('handler', 'my_handler', stubHandler());
    reg.register('adapter', 'my_adapter', stubAdapter());
    expect(unmetCapabilities(def, reg)).toEqual([]);
  });
  it('partial registry → only the missing one is reported', () => {
    const reg = new ExtensionRegistry();
    reg.register('handler', 'my_handler', stubHandler());
    expect(unmetCapabilities(def, reg).map((r) => r.name)).toEqual(['my_adapter']);
  });
});

describe('capabilityWarning (#134)', () => {
  it('names the step, kind, and requirement, and frames it advisorily (recoverable, not a failure)', () => {
    const msg = capabilityWarning({ step: 's1', kind: 'handler', name: 'h1' });
    expect(msg).toContain("Step 's1'");
    expect(msg).toContain("handler 'h1'");
    expect(msg).toContain('block recoverably');
    expect(msg).not.toContain('refuse');
  });
});

describe('findCapabilityBlockedSteps (#134) — definition-free + self-suppression', () => {
  const blocks: RunRecord['capability_blocks'] = {
    s1: {
      requirement: { kind: 'handler', name: 'h1' },
      code: 'ENGINE_HANDLER_NOT_REGISTERED',
      at: 't',
    },
  };

  it('returns the block for an eligible-but-unclaimed step (no definition param)', () => {
    const out = findCapabilityBlockedSteps(makeRun({ capability_blocks: blocks }));
    expect(out).toEqual([
      {
        step: 's1',
        requirement: { kind: 'handler', name: 'h1' },
        code: 'ENGINE_HANDLER_NOT_REGISTERED',
        at: 't',
      },
    ]);
  });

  it('self-suppresses once the step is in completed_steps', () => {
    expect(
      findCapabilityBlockedSteps(makeRun({ capability_blocks: blocks, completed_steps: ['s1'] })),
    ).toHaveLength(0);
  });
  it('self-suppresses once the step is in in_progress_steps (reclaimed)', () => {
    expect(
      findCapabilityBlockedSteps(makeRun({ capability_blocks: blocks, in_progress_steps: ['s1'] })),
    ).toHaveLength(0);
  });
  it('self-suppresses once the step is in failed_steps', () => {
    expect(
      findCapabilityBlockedSteps(makeRun({ capability_blocks: blocks, failed_steps: ['s1'] })),
    ).toHaveLength(0);
  });
  it('self-suppresses once the step is in skipped_steps', () => {
    expect(
      findCapabilityBlockedSteps(makeRun({ capability_blocks: blocks, skipped_steps: ['s1'] })),
    ).toHaveLength(0);
  });
  it('returns [] for a record with no capability_blocks (legacy / capability-clean)', () => {
    expect(findCapabilityBlockedSteps(makeRun({}))).toEqual([]);
  });
});
