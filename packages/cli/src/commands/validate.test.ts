import { describe, it, expect } from 'vitest';
import { renderLoadFailure, renderEscalationLine } from '../lib/loader-warnings.js';
import type { LoaderWarning } from '@sensigo/realm';
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

  it('a collector that gathered SEVERAL problems lists them one per line (issue #425)', () => {
    // Driven with a constructed error rather than a YAML fixture: the branch is about the array,
    // and the loader's own collectors are pinned separately. The second item embeds '; ' on
    // purpose — a real loader message does (the #413 four-clause text), so an implementation
    // that split the joined message back apart would cut this item in half and report three.
    const err = new WorkflowError(
      "Invalid workflow: Step 'a': first problem; Step 'b': second; with a semicolon",
      {
        code: 'VALIDATION_WORKFLOW_SCHEMA',
        category: 'VALIDATION',
        agentAction: 'report_to_user',
        retryable: false,
        errors: ["Step 'a': first problem", "Step 'b': second; with a semicolon"],
      },
    );

    expect(renderLoadFailure(err)).toBe(
      'Invalid workflow — 2 errors:\n' +
        "  Step 'a': first problem\n" +
        "  Step 'b': second; with a semicolon",
    );
  });

  it('a single-error throw renders exactly as it did before (issue #425)', () => {
    const err = new WorkflowError("Invalid workflow: Step 'a': only problem", {
      code: 'VALIDATION_WORKFLOW_SCHEMA',
      category: 'VALIDATION',
      agentAction: 'report_to_user',
      retryable: false,
      errors: ["Step 'a': only problem"],
    });
    expect(renderLoadFailure(err)).toBe("Invalid workflow: Step 'a': only problem");
  });

  it('the predicate is anchored at the START, not a substring match', () => {
    // A message that merely mentions the phrase is not one that announces itself with it.
    expect(renderLoadFailure('Wrapper says: Invalid workflow: something')).toBe(
      'Invalid: Wrapper says: Invalid workflow: something',
    );
  });
});

// issue #425 — the escalation line names WHICH warnings escalated. Its keyless branch has no
// reachable fixture: every code that escalates under the default policy carries a key today, so
// this is the only place that clause is exercised rather than a guess left to rot.
describe('validate — the escalation line (issue #425)', () => {
  const escalating = (key?: string): LoaderWarning => ({
    code: 'UNKNOWN_STEP_KEY',
    severity: 'error',
    message: 'x',
    scope: 'step',
    ...(key !== undefined ? { key } : {}),
  });
  const benign: LoaderWarning = {
    code: 'RETRY_NO_TIMEOUT',
    severity: 'warn',
    message: 'y',
    scope: 'step',
  };

  it('names the escalated warning, with both counts agreeing with their own subjects', () => {
    expect(renderEscalationLine([escalating('dependson')])).toBe(
      "Invalid: 1 warning, 1 escalated to an error by policy: UNKNOWN_STEP_KEY 'dependson'",
    );
  });

  it('M < N: the total counts every warning, the list only the refusals', () => {
    expect(renderEscalationLine([escalating('dependson'), benign])).toBe(
      "Invalid: 2 warnings, 1 escalated to an error by policy: UNKNOWN_STEP_KEY 'dependson'",
    );
  });

  it('a keyless escalating warning renders its code alone — no empty quotes', () => {
    expect(renderEscalationLine([escalating()])).toBe(
      'Invalid: 1 warning, 1 escalated to an error by policy: UNKNOWN_STEP_KEY',
    );
  });

  it('several escalations are listed comma-separated', () => {
    expect(renderEscalationLine([escalating('a'), escalating('b')])).toBe(
      "Invalid: 2 warnings, 2 escalated to an error by policy: UNKNOWN_STEP_KEY 'a', UNKNOWN_STEP_KEY 'b'",
    );
  });
});
