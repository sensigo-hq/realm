// Tests for error-resolution.ts — resolvePreExecutionAgentAction and resolvePostDispatchAgentAction.
import { describe, it, expect } from 'vitest';
import { WorkflowError } from '../types/workflow-error.js';
import {
  resolvePreExecutionAgentAction,
  resolvePostDispatchAgentAction,
} from './error-resolution.js';

function makeErr(agentAction: import('../types/workflow-error.js').AgentAction): WorkflowError {
  return new WorkflowError('test error', {
    code: 'ENGINE_INTERNAL',
    category: 'ENGINE',
    agentAction,
    retryable: false,
  });
}

describe('resolvePreExecutionAgentAction', () => {
  it('translates provide_input to report_to_user', () => {
    expect(resolvePreExecutionAgentAction(makeErr('provide_input'))).toBe('report_to_user');
  });

  it('translates resolve_precondition to report_to_user', () => {
    expect(resolvePreExecutionAgentAction(makeErr('resolve_precondition'))).toBe('report_to_user');
  });

  it('passes stop through unchanged', () => {
    expect(resolvePreExecutionAgentAction(makeErr('stop'))).toBe('stop');
  });

  it('passes report_to_user through unchanged', () => {
    expect(resolvePreExecutionAgentAction(makeErr('report_to_user'))).toBe('report_to_user');
  });

  it('passes wait_for_human through unchanged', () => {
    expect(resolvePreExecutionAgentAction(makeErr('wait_for_human'))).toBe('wait_for_human');
  });
});

describe('resolvePostDispatchAgentAction', () => {
  it('returns stop when isTerminalRun is true, regardless of agentAction (stop)', () => {
    expect(resolvePostDispatchAgentAction(makeErr('stop'), true)).toBe('stop');
  });

  it('returns stop when isTerminalRun is true, regardless of agentAction (report_to_user)', () => {
    expect(resolvePostDispatchAgentAction(makeErr('report_to_user'), true)).toBe('stop');
  });

  it('returns stop when isTerminalRun is true, regardless of agentAction (wait_for_human)', () => {
    expect(resolvePostDispatchAgentAction(makeErr('wait_for_human'), true)).toBe('stop');
  });

  it('returns stop when isTerminalRun is true, regardless of agentAction (provide_input)', () => {
    expect(resolvePostDispatchAgentAction(makeErr('provide_input'), true)).toBe('stop');
  });

  it('returns stop when isTerminalRun is true, regardless of agentAction (resolve_precondition)', () => {
    expect(resolvePostDispatchAgentAction(makeErr('resolve_precondition'), true)).toBe('stop');
  });

  it('translates stop to report_to_user when non-terminal', () => {
    expect(resolvePostDispatchAgentAction(makeErr('stop'), false)).toBe('report_to_user');
  });

  it('translates provide_input to report_to_user when non-terminal', () => {
    expect(resolvePostDispatchAgentAction(makeErr('provide_input'), false)).toBe('report_to_user');
  });

  it('translates resolve_precondition to report_to_user when non-terminal', () => {
    expect(resolvePostDispatchAgentAction(makeErr('resolve_precondition'), false)).toBe(
      'report_to_user',
    );
  });

  it('passes report_to_user through when non-terminal', () => {
    expect(resolvePostDispatchAgentAction(makeErr('report_to_user'), false)).toBe('report_to_user');
  });

  it('passes wait_for_human through when non-terminal', () => {
    expect(resolvePostDispatchAgentAction(makeErr('wait_for_human'), false)).toBe('wait_for_human');
  });
});
