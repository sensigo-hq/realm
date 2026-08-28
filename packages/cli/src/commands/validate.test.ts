import { describe, it, expect } from 'vitest';
import { renderLoadFailure } from '../lib/loader-warnings.js';
import { loadWorkflowFromString, WorkflowError } from '@sensigo/realm';

const VALID_WORKFLOW = `
id: test-workflow
name: Test Workflow
version: 1
steps:
  step-one:
    description: First step
    execution: auto
  step-two:
    description: Second step
    execution: agent
    depends_on: [step-one]
`;

describe('validate command (via loadWorkflowFromString)', () => {
  it('valid workflow YAML parses without throwing', () => {
    expect(() => loadWorkflowFromString(VALID_WORKFLOW)).not.toThrow();
  });

  it('missing required field (id) throws WorkflowError', () => {
    const content = VALID_WORKFLOW.replace('id: test-workflow\n', '');
    expect(() => loadWorkflowFromString(content)).toThrow(WorkflowError);
  });

  it('step with unknown uses_service throws WorkflowError', () => {
    const content = VALID_WORKFLOW.replace(
      'execution: agent',
      'execution: agent\n    uses_service: nonexistent-service',
    );
    expect(() => loadWorkflowFromString(content)).toThrow(WorkflowError);
  });

  it('step with invalid execution value throws WorkflowError', () => {
    const content = VALID_WORKFLOW.replace('execution: auto', 'execution: invalid_mode');
    expect(() => loadWorkflowFromString(content)).toThrow(WorkflowError);
  });
});

// =================================================================================================
// issue #417 — the double prefix
//
// The loader's message already begins "Invalid workflow: …". Wrapping it produced
// "Invalid: Invalid workflow: …" — the same word twice before anything actionable. Nothing pinned
// the doubled form, so these cells are the new contract rather than an edit to an old one.
// =================================================================================================
describe('validate — a load failure says "invalid" once (issue #417)', () => {
  it('a loader refusal prints the message verbatim, with no added prefix', () => {
    expect(renderLoadFailure("Invalid workflow: Step 'x': 'agent_profile' is only valid…")).toBe(
      "Invalid workflow: Step 'x': 'agent_profile' is only valid…",
    );
  });

  it('a NON-loader error keeps the prefix — it announces nothing on its own', () => {
    expect(renderLoadFailure('ENOENT: no such file or directory')).toBe(
      'Invalid: ENOENT: no such file or directory',
    );
  });

  it('the predicate is anchored at the START, not a substring match', () => {
    // A message that merely mentions the phrase is not one that announces itself with it.
    expect(renderLoadFailure('Wrapper says: Invalid workflow: something')).toBe(
      'Invalid: Wrapper says: Invalid workflow: something',
    );
  });
});
