// CP-3a-i A: the loader reads its word lists from one array each (word-lists.ts, TRIGGER_RULES).
// Two of the loader's messages print a whole list joined: `on_outcome`'s and `trigger_rule`'s. These
// two cells pin each tail word for word, so the array's order is the message's order and a word
// added or dropped shows. Red first by reordering the array.
import { describe, expect, it } from 'vitest';
import { WorkflowError } from '../types/workflow-error.js';
import { loadWorkflowFromString } from './yaml-loader.js';

/** The loader's error strings for `yaml`, one per problem (the pre-join list the error carries). */
function errorsOf(yaml: string): string[] {
  try {
    loadWorkflowFromString(yaml);
  } catch (err) {
    if (err instanceof WorkflowError) return [...(err.errors ?? [err.message])];
    throw err;
  }
  throw new Error('expected the loader to refuse the file');
}

const HEAD = 'id: lists\nname: Lists\nversion: 1\nsteps:\n';

describe("CP-3a-i A — the joined word lists in the loader's messages", () => {
  it("on_outcome: the tail lists the finalizer endings in FINALIZER_TRIGGERS' order", () => {
    const yaml =
      HEAD +
      '  work:\n    description: Work\n    execution: agent\n' +
      '  cleanup:\n    description: Clean up\n    execution: finalizer\n    handler: tidy\n    on_outcome: sometimes\n';
    // Red when FINALIZER_TRIGGERS is reordered, or gains or loses a word; prints the messages.
    const errors = errorsOf(yaml);
    expect(errors, `the loader said:\n${errors.join('\n')}`).toContain(
      "Step 'cleanup': invalid on_outcome value 'sometimes'; must be one of complete, fail, abort, always, completed_with_failed_steps (step at line 8)",
    );
  });

  it("trigger_rule: the tail lists the rules in TRIGGER_RULES' order", () => {
    const yaml =
      HEAD +
      '  first:\n    description: First\n    execution: agent\n' +
      '  second:\n    description: Second\n    execution: agent\n    depends_on: [first]\n    trigger_rule: most_success\n';
    // Red when TRIGGER_RULES is reordered, or gains or loses a word; prints the messages.
    const errors = errorsOf(yaml);
    expect(errors, `the loader said:\n${errors.join('\n')}`).toContain(
      "Step 'second': invalid trigger_rule 'most_success'; must be one of all_success, all_failed, all_done, one_failed, one_success, none_failed (step at line 8)",
    );
  });
});
