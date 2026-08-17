// dead-failure-condition.test.ts — issue #362: the loader rejects a condition that can never be
// true.
//
// THE TRAP: `depends_on: [x]` + `when: ['$settlement.x.failed == true']` with no `trigger_rule`.
// It reads exactly like "run this when x fails", and it never runs — the trigger gate is evaluated
// BEFORE the condition gate, and the default `all_success` requires x NOT to be in failed_steps.
// So if the gate passes, x succeeded and the condition is false; if x failed, the gate already
// skipped the step. The run record blames `trigger_rule_unsatisfiable` and names the rule — never
// the condition the author wrote — so the diagnosis points away from the mistake.
//
// This is an ERROR rather than a warning for two reasons that are specific, not stylistic: no
// legitimate use of this shape exists (unlike `#if 0`-style dead code, which is why compilers warn
// there), and `.failed` shipped the same day, so no workflow anywhere can already carry it.
import { describe, it, expect } from 'vitest';
import { loadWorkflowFromString } from './yaml-loader.js';

/** A two-step workflow: `extract`, then `cleanup` with the caller's body. */
function wf(cleanupBody: string, extraSteps = ''): string {
  return `
id: dead-wf
name: Dead WF
version: 1
steps:
  extract:
    description: Extract
    execution: auto
${extraSteps}  cleanup:
    description: Cleanup
    execution: auto
${cleanupBody}
`;
}

/** A guard workflow — guards may not declare `trigger_rule` at all. */
function guardWf(body: string): string {
  return `
id: guard-wf
name: Guard WF
version: 1
steps:
  extract:
    description: Extract
    execution: auto
  check:
    description: Check
    execution: guard
    depends_on: [extract]
${body}
`;
}

function loadError(yaml: string): string {
  try {
    loadWorkflowFromString(yaml);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error('expected the workflow to FAIL loading, but it loaded');
}

const DEAD_WHEN = "    depends_on: [extract]\n    when: ['$settlement.extract.failed == true']";

describe('dead failure condition — loader rejection (issue #362)', () => {
  // (a) FIRE CELLS — three surfaces × three rule spellings.
  it('(a) `when` under an OMITTED trigger_rule is refused, and the message says "default"', () => {
    const message = loadError(wf(DEAD_WHEN));
    expect(message).toContain("Step 'cleanup'");
    expect(message).toContain('\'when\' condition "$settlement.extract.failed == true"');
    expect(message).toContain('can never be true');
    // The omission IS the bug — the message must not imply the author chose the rule.
    expect(message).toContain("the default 'all_success'");
    // Consequence names BOTH branches: it is not "never evaluated" when the dep succeeds.
    expect(message).toContain('trigger_rule_unsatisfiable');
    expect(message).toContain('when_false');
    expect(message).toContain('set trigger_rule to one of: all_done, one_failed');
  });

  it('(a) `when` under a DECLARED all_success is refused, and the message quotes the rule without "default"', () => {
    const message = loadError(
      wf(
        "    depends_on: [extract]\n    trigger_rule: all_success\n    when: ['$settlement.extract.failed == true']",
      ),
    );
    expect(message).toContain("under 'all_success' trigger rule");
    expect(message).not.toContain("the default 'all_success'");
  });

  it('(a) `when` under none_failed is refused', () => {
    expect(
      loadError(
        wf(
          "    depends_on: [extract]\n    trigger_rule: none_failed\n    when: ['$settlement.extract.failed == true']",
        ),
      ),
    ).toContain("under 'none_failed' trigger rule");
  });

  it('(a) `preconditions` is refused, and its consequence says the run WEDGES — worse than a skip', () => {
    const message = loadError(
      wf("    depends_on: [extract]\n    preconditions: ['$settlement.extract.failed == true']"),
    );
    expect(message).toContain("'preconditions' condition");
    expect(message).toContain('never settles');
    expect(message).toContain('WEDGES');
    // The when-specific consequence must NOT leak onto this surface.
    expect(message).not.toContain('when_false');
  });

  // (b) SURFACE NORMALIZATION — `when` is `string | string[]` and the loader never normalizes it.
  it('(b) the BARE-STRING `when` spelling is refused too, not just the array form', () => {
    expect(
      loadError(wf('    depends_on: [extract]\n    when: "$settlement.extract.failed == true"')),
    ).toContain('can never be true');
  });

  // (c) The bare-path spelling is semantically identical under Boolean() coercion.
  it('(c) the BARE-PATH spelling `when: [$settlement.x.failed]` is equally dead and equally refused', () => {
    const message = loadError(
      wf("    depends_on: [extract]\n    when: ['$settlement.extract.failed']"),
    );
    expect(message).toContain('"$settlement.extract.failed"');
    expect(message).toContain('can never be true');
  });

  // (d) MUST-NOT-FIRE — one cell per escape.
  it.each([
    [
      'all_done',
      "    depends_on: [extract]\n    trigger_rule: all_done\n    when: ['$settlement.extract.failed == true']",
    ],
    [
      'all_failed',
      "    depends_on: [extract]\n    trigger_rule: all_failed\n    when: ['$settlement.extract.failed == true']",
    ],
    [
      'one_failed',
      "    depends_on: [extract]\n    trigger_rule: one_failed\n    when: ['$settlement.extract.failed == true']",
    ],
    // TIER B: dead at exactly 1 distinct dep, but it rests on an unenforced run-record invariant
    // and needs the distinct-set count — deferred to issue #364 as its own decision.
    [
      'one_success (TIER B — issue #364)',
      "    depends_on: [extract]\n    trigger_rule: one_success\n    when: ['$settlement.extract.failed == true']",
    ],
    // The `== false` mirror class is also #364's.
    [
      '== false (mirror class — issue #364)',
      "    depends_on: [extract]\n    when: ['$settlement.extract.failed == false']",
    ],
    [
      '== null (the absence test)',
      "    depends_on: [extract]\n    when: ['$settlement.extract.failed == null']",
    ],
    ['!= null', "    depends_on: [extract]\n    when: ['$settlement.extract.failed != null']"],
    [
      'a different third segment',
      "    depends_on: [extract]\n    when: ['$settlement.extract.settled_by_default == true']",
    ],
    // Dead for a DIFFERENT reason (the path resolves to nothing), so the trigger remedy would be
    // wrong advice — the predicate keys on EXACTLY three segments.
    [
      'a 4-segment path',
      "    depends_on: [extract]\n    when: ['$settlement.extract.failed.deep == true']",
    ],
  ])('(d) does NOT fire: %s', (_label, body) => {
    expect(() => loadWorkflowFromString(wf(body))).not.toThrow();
  });

  it('(d) a malformed trigger_rule produces ONLY its own error — no dead-condition noise on top', () => {
    const message = loadError(
      wf(
        "    depends_on: [extract]\n    trigger_rule: all_sucess\n    when: ['$settlement.extract.failed == true']",
      ),
    );
    expect(message).toContain('invalid trigger_rule');
    expect(message).not.toContain('can never be true');
  });

  it('(d) with `depends_on` OMITTED only the one-hop error fires — the leaf is not dead-by-trigger there', () => {
    // A step with no deps passes the trigger gate unconditionally, so the condition genuinely CAN
    // be evaluated; recommending a trigger rule would be false advice.
    const message = loadError(wf("    when: ['$settlement.extract.failed == true']"));
    expect(message).toContain('one-hop rule');
    expect(message).not.toContain('can never be true');
  });

  // (e) THE REMEDY PAIR — computed per step, not a static list.
  it('(e) a 1-dep step CAN use all_failed, so the remedy includes it', () => {
    const message = loadError(wf(DEAD_WHEN));
    expect(message).toContain('all_done, one_failed, all_failed');
    expect(message).not.toContain('one_success');
  });

  it('(e) a 2-dep step must NOT be told to use all_failed — it would load clean and still never run', () => {
    const message = loadError(
      wf(
        "    depends_on: [extract, transform]\n    when: ['$settlement.extract.failed == true']",
        '  transform:\n    description: Transform\n    execution: auto\n',
      ),
    );
    expect(message).toContain('set trigger_rule to one of: all_done, one_failed.');
    // `all_failed` at 2 deps fires only if BOTH fail — recommending it bare would reconstitute
    // this very bug with the loader's blessing. It may appear only in the qualified tail.
    const bareList = message.slice(
      message.indexOf('set trigger_rule to one of:'),
      message.indexOf("('all_failed' fires only"),
    );
    expect(bareList).not.toContain('all_failed');
    expect(message).toContain("'all_failed' fires only if EVERY dependency fails");
    expect(message).not.toContain('set trigger_rule to one of: all_done, one_failed, all_failed');
  });

  it('(e) DUPLICATE depends_on entries count as ONE distinct dep, so all_failed is offered', () => {
    const message = loadError(
      wf("    depends_on: [extract, extract]\n    when: ['$settlement.extract.failed == true']"),
    );
    expect(message).toContain('all_done, one_failed, all_failed');
  });

  // (f) THE GUARD FORK — keyed on `execution`, not on the surface.
  it('(f) a guard `abort_unless` gets NO trigger-rule remedy, points at finalizer, and cites #366', () => {
    const message = loadError(guardWf("    abort_unless: ['$settlement.extract.failed == true']"));
    expect(message).toContain('aborts the run on every execution');
    expect(message).not.toContain('set trigger_rule to one of');
    expect(message).toContain('execution: finalizer');
    expect(message).toContain('#366');
    // Framed as scope, never as architecture.
    expect(message).not.toContain('by design');
  });

  it('(f) a guard `when` ALSO gets the guard fork — `when` is not prohibited on guards and IS evaluated for them', () => {
    const message = loadError(guardWf("    when: ['$settlement.extract.failed == true']"));
    expect(message).toContain('can never be true');
    // The bug rev 1 shipped: a guard's `when` receiving trigger-rule advice, which is a load error
    // to follow.
    expect(message).not.toContain('set trigger_rule to one of');
    expect(message).toContain('execution: finalizer');
    expect(message).toContain('#366');
  });

  it('(g) a guard declaring the PROHIBITED trigger_rule: all_done still gets the dead-condition error', () => {
    // Its effective rule is `all_success` regardless — declaring one must not suppress the check.
    const message = loadError(
      guardWf("    trigger_rule: all_done\n    when: ['$settlement.extract.failed == true']"),
    );
    expect(message).toContain("'trigger_rule' is not valid on execution: guard steps");
    expect(message).toContain('can never be true');
  });

  // (h) Per-leaf, not per-step: `when` is a monotone AND, so one dead leaf kills the array.
  it('(h) a multi-leaf `when` with one dead and one live leaf is refused, naming the DEAD leaf', () => {
    const message = loadError(
      wf(
        "    depends_on: [extract]\n    when:\n      - '$settlement.extract.settled_by_default == false'\n      - '$settlement.extract.failed == true'",
      ),
    );
    expect(message).toContain('"$settlement.extract.failed == true"');
    expect(message).not.toContain('"$settlement.extract.settled_by_default == false" can never');
  });
});
