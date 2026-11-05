// registered-copy-616b2.test.ts — #616 B2: the refusals of a registered copy that has no file (unit
// B3's SQLite registry keeps a copy as a row). The real case: an operator reads what that registry
// says about a copy an older or a later Realm registered, or a damaged one — the JSON registry's
// words for the same copy, with no file path to name. Each refusal is pinned literally (never
// compared with its own builder): its code, words, category, action, retry flag, and what it carries
// instead of a path. `workflowNotFoundError` is pinned through the JSON registry's missing branch,
// which calls it (registrar-probe.test.ts T1); `classifyRegisteredCopy` through the registry's two
// reads (every registrar test).
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import { describe, expect, it } from 'vitest';
import { legacyCopyError, newerCopyError, storedCopyFaultError } from './registrar.js';
import { CURRENT_WORKFLOW_SCHEMA_VERSION } from './yaml-loader.js';

/** What an operator, or a program reading the error, gets: everything but the stack. */
const shown = (err: {
  code: string;
  message: string;
  category: string;
  agentAction: string;
  retryable: boolean;
  details: Record<string, unknown>;
  facts?: unknown;
}) => ({
  code: err.code,
  message: err.message,
  category: err.category,
  agentAction: err.agentAction,
  retryable: err.retryable,
  details: err.details,
  facts: err.facts,
});

describe('#616 B2 — the refusals of a registered copy with no file', () => {
  it('legacyCopyError: the older-format words, details { workflowId }, no path', () => {
    // (1) red when a `path` key is added (to `details` or as facts), or the words, code, category,
    //     action or retry flag differ from the JSON registry's legacy refusal; (2) prints the whole
    //     error but its stack (strict: an `undefined` key differs from no key).
    expect(shown(legacyCopyError('invoice-flow'))).toStrictEqual({
      code: 'STATE_LEGACY_FORMAT',
      message:
        'This workflow was registered with an older version of Realm. Re-register it with: realm workflow register <path-to-workflow>',
      category: 'STATE',
      agentAction: 'report_to_user',
      retryable: false,
      details: { workflowId: 'invoice-flow' },
      facts: undefined,
    });
  });

  it('newerCopyError: the later-format words, typed facts without a path', () => {
    // (1) red when the facts keep a `path` key (also `path: undefined`), or the words or facts
    //     differ from the JSON registry's newer refusal; (2) prints the whole error but its stack.
    expect(shown(newerCopyError('invoice-flow', 7))).toStrictEqual({
      code: 'STATE_NEWER_FORMAT',
      message: `Workflow 'invoice-flow' was registered by a later version of Realm (definition format 7; this version reads up to ${CURRENT_WORKFLOW_SCHEMA_VERSION}) — refused: this version would ignore requirements it cannot read. Use the Realm version that registered it, or register the workflow's source again with this version. Nothing was run.`,
      category: 'STATE',
      agentAction: 'report_to_user',
      retryable: false,
      details: {},
      facts: {
        scope: 'newer_definition',
        schema_version: 7,
        reads_up_to: CURRENT_WORKFLOW_SCHEMA_VERSION,
      },
    });
  });

  it('storedCopyFaultError, an object that is not a workflow: the fault’s words, details { workflowId, fault }, no facts', () => {
    // (1) red when the fault's words are dropped or changed, the details lose the fault, or facts
    //     (a file's) are added; (2) prints the whole error but its stack.
    expect(
      shown(storedCopyFaultError('invoice-flow', { kind: 'not_a_workflow', fault: 'no_id' })),
    ).toStrictEqual({
      code: 'RESOURCE_FORMAT_INVALID',
      message:
        "the registered copy of 'invoice-flow' is JSON but not a workflow object (it has no string id)",
      category: 'RESOURCE',
      agentAction: 'stop',
      retryable: false,
      details: { workflowId: 'invoice-flow', fault: { kind: 'not_a_workflow', fault: 'no_id' } },
      facts: undefined,
    });
  });

  it('storedCopyFaultError, JSON that is not an object: "(it is <shape>)"', () => {
    // (1) red when a non-object is rendered with the fault form (or loses its shape); (2) prints the
    //     message.
    expect(
      storedCopyFaultError('invoice-flow', { kind: 'not_object', shape: 'array' }).message,
    ).toBe("the registered copy of 'invoice-flow' is JSON but not a workflow object (it is array)");
  });
});
