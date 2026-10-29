import { describe, it, expect } from 'vitest';
import { WorkflowError, storedFileFactsOf } from './workflow-error.js';
import type { ErrorCategory, ErrorFacts } from './workflow-error.js';
import {
  unreadableFactsOf,
  unreadableRunFileError,
  unreadableRunFilesError,
  unreadableRunFilesOf,
} from '../store/run-file.js';

const ALL_CATEGORIES: ErrorCategory[] = [
  'NETWORK',
  'SERVICE',
  'STATE',
  'VALIDATION',
  'ENGINE',
  'RESOURCE',
];

describe('WorkflowError', () => {
  it('is instanceof Error', () => {
    const err = new WorkflowError('test', {
      code: 'ENGINE_INTERNAL',
      category: 'ENGINE',
      agentAction: 'stop',
      retryable: false,
    });
    expect(err).toBeInstanceOf(Error);
  });

  it('has name === WorkflowError', () => {
    const err = new WorkflowError('test', {
      code: 'STATE_BLOCKED',
      category: 'STATE',
      agentAction: 'report_to_user',
      retryable: false,
    });
    expect(err.name).toBe('WorkflowError');
  });

  it('sets all fields correctly', () => {
    const err = new WorkflowError('oops', {
      code: 'VALIDATION_HASH_MISMATCH',
      category: 'VALIDATION',
      agentAction: 'provide_input',
      retryable: true,
      details: { field: 'x' },
      stepId: 'step-1',
      attempt: 3,
    });
    expect(err.code).toBe('VALIDATION_HASH_MISMATCH');
    expect(err.category).toBe('VALIDATION');
    expect(err.agentAction).toBe('provide_input');
    expect(err.retryable).toBe(true);
    expect(err.details).toEqual({ field: 'x' });
    expect(err.stepId).toBe('step-1');
    expect(err.attempt).toBe(3);
  });

  it('defaults details to empty object when not provided', () => {
    const err = new WorkflowError('test', {
      code: 'ENGINE_INTERNAL',
      category: 'ENGINE',
      agentAction: 'stop',
      retryable: false,
    });
    expect(err.details).toEqual({});
  });

  it('defaults attempt to 1 when not provided', () => {
    const err = new WorkflowError('test', {
      code: 'ENGINE_INTERNAL',
      category: 'ENGINE',
      agentAction: 'stop',
      retryable: false,
    });
    expect(err.attempt).toBe(1);
  });

  it('D11 (#715 (a), D6-23): a thrown WorkflowError carries no `timestamp` — an error is not a clock reading', () => {
    // (a) red when the field comes back; (b) prints the error's own keys.
    let caught: unknown;
    try {
      throw new WorkflowError('test', {
        code: 'ENGINE_INTERNAL',
        category: 'ENGINE',
        agentAction: 'stop',
        retryable: false,
      });
    } catch (err) {
      caught = err;
    }
    const keys = Object.keys(caught as object);
    expect(Object.prototype.hasOwnProperty.call(caught, 'timestamp'), keys.join(', ')).toBe(false);
  });

  it.each(ALL_CATEGORIES)('can be constructed with category %s', (category) => {
    const err = new WorkflowError('cat test', {
      code: 'ENGINE_INTERNAL',
      category,
      agentAction: 'stop',
      retryable: false,
    });
    expect(err.category).toBe(category);
  });
});

// issue #759 (ruling (B), tightened): the facts union is keyed by CODE, and `scope` is the
// stored-file family's own field — so its readers narrow through ONE helper, by the scope's VALUE.
// A failure prints the scopes and paths only.
describe("issue #759 — `storedFileFactsOf`, the facts union's stored-file narrowing", () => {
  const file = unreadableRunFileError({ resource: 'run_file', class: 'parse', path: '/s/r.json' });
  const files = unreadableRunFilesError('realm run list', '/s', [
    { resource: 'run_file', class: 'parse', path: '/s/r.json' },
  ]);
  const validation = new WorkflowError("Invalid input for step 's'", {
    code: 'VALIDATION_INPUT_SCHEMA',
    category: 'VALIDATION',
    agentAction: 'provide_input',
    retryable: false,
    facts: { errors: [], error_count: 0 },
  });
  // W's family (#627) on this base: a `scope` of its own that is not a stored file.
  const newer = new WorkflowError('newer', {
    code: 'STATE_NEWER_FORMAT' as never,
    category: 'STATE',
    agentAction: 'report_to_user',
    retryable: false,
    facts: { scope: 'newer_definition', path: '/s/w.json' } as unknown as ErrorFacts,
  });

  it("`scope: 'file'` and `scope: 'files'` → the facts; a scope-less validation refusal and `scope: 'newer_definition'` → nothing (reds: the presence-only check admits `newer_definition`; with no `in` check, `err.facts?.scope` fails to compile — TS2339)", () => {
    expect({
      file: storedFileFactsOf(file)?.scope,
      files: storedFileFactsOf(files)?.scope,
      validation: storedFileFactsOf(validation),
      newer: storedFileFactsOf(newer),
    }).toEqual({ file: 'file', files: 'files', validation: undefined, newer: undefined });
  });

  it("the run file's two readers go through it: each reads its own family and nothing else", () => {
    expect({
      fileAsFile: unreadableFactsOf(file)?.path,
      filesAsFiles: unreadableRunFilesOf(files)?.files.length,
      fileAsFiles: unreadableRunFilesOf(file),
      filesAsFile: unreadableFactsOf(files),
      validation: [unreadableFactsOf(validation), unreadableRunFilesOf(validation)],
      newer: [unreadableFactsOf(newer), unreadableRunFilesOf(newer)],
    }).toEqual({
      fileAsFile: '/s/r.json',
      filesAsFiles: 1,
      fileAsFiles: undefined,
      filesAsFile: undefined,
      validation: [undefined, undefined],
      newer: [undefined, undefined],
    });
  });
});
