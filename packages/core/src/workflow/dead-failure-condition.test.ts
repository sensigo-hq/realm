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
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadWorkflowFromString } from './yaml-loader.js';
import { executeStep, executeChain } from '../engine/execution-loop.js';
import type { StepDispatcher } from '../engine/execution-loop.js';
import { JsonFileStore } from '../store/json-file-store.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';

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

// =================================================================================================
// CORRECTION (issue #362) — the message must not make a claim that cannot happen.
//
// Rev 1 emitted, for a guard carrying a dead `preconditions` leaf, "the step never settles — the
// run WEDGES in a blocked envelope". That is FALSE: `checkPreconditions` has exactly one call site
// (execution-loop.ts:1380, inside `executeStep`), and a guard goes through `executeGuardStep`,
// which evaluates only `abort_unless`. Nothing wedges, because nothing is evaluated.
//
// The defect class is the same one this whole PR exists to prevent — a confident sentence about a
// runtime consequence, unbacked by execution. So the guard fork is pinned here, and the four
// runtime claims the message makes are pinned BEHAVIOURALLY below.
// =================================================================================================

/** The consequence clause each (surface × step kind) combination is entitled to — and only it. */
const WHEN_SKIPS = 'either way the step never runs';
const PRECONDITION_WEDGES = 'the run WEDGES in a blocked envelope';
const GUARD_ABORTS = 'the guard aborts the run on every execution';
const GUARD_PRECONDITION_INERT =
  'the run behaves identically whether this condition is present or absent';

describe('dead failure condition — the message tells the truth about guards (issue #362)', () => {
  it('a guard `preconditions` leaf gets the INERT consequence, never the wedge — CO-FIRING with the #369 prohibition', () => {
    // Was a whole-string `toBe`. Post-#369 a guard declaring `preconditions` is ALSO refused
    // outright, and loader errors accumulate rather than short-circuit, so this fixture now emits
    // two messages joined into one. Two containment pins rather than one equality pin, each
    // keyed on a DISTINCTIVE substring of its own error: a whole-string pin here would have to
    // re-encode both messages and would red on any wording change to either.
    //
    // The clause this test exists for is still asserted exactly — GUARD_PRECONDITION_INERT below
    // — and its siblings' not-toContain sweep is what stops a false clause slipping in.
    const message = loadError(
      guardWf(
        "    abort_unless: ['$settlement.extract.settled_by_default == false']\n" +
          "    preconditions: ['$settlement.extract.failed == true']",
      ),
    );

    // Half 1 — the #369 prohibition, which the guard block emits FIRST (it runs at :827-850,
    // before the dead-condition scan at :1602), so it is prepended in the join.
    // ONE distinctive substring per error, deliberately: the #369 message's own clauses are
    // pinned in yaml-loader.test.ts, and re-asserting them here would make this cell red whenever
    // that message is reworded — costing the message-content cell its discriminating power for no
    // added coverage. This cell's job is that BOTH errors are present, and in which order.
    expect(message).toContain(
      `Step 'check': 'preconditions' is not valid on execution: guard steps`,
    );

    // Half 2 — the #362 dead-condition message, with the INERT consequence and never the wedge.
    expect(message).toContain(
      `Step 'check': 'preconditions' condition "$settlement.extract.failed == true" can never be true`,
    );
    expect(message).toContain(GUARD_PRECONDITION_INERT);
    expect(message).not.toContain(PRECONDITION_WEDGES);

    // Ordering, since the join is what makes both readable: the prohibition reaches the author
    // above the dead-condition explanation.
    expect(message.indexOf(`'preconditions' is not valid`)).toBeLessThan(
      message.indexOf('can never be true'),
    );
  });

  it('the three guard surfaces produce three DIFFERENT consequences — a shared string would fail here', () => {
    const messages = {
      when: loadError(
        guardWf(
          "    when: ['$settlement.extract.failed == true']\n" +
            "    abort_unless: ['$settlement.extract.settled_by_default == false']",
        ),
      ),
      abort_unless: loadError(guardWf("    abort_unless: ['$settlement.extract.failed == true']")),
      preconditions: loadError(
        guardWf(
          "    abort_unless: ['$settlement.extract.settled_by_default == false']\n" +
            "    preconditions: ['$settlement.extract.failed == true']",
        ),
      ),
    };
    const owned = {
      when: WHEN_SKIPS,
      abort_unless: GUARD_ABORTS,
      preconditions: GUARD_PRECONDITION_INERT,
    };
    const all = [WHEN_SKIPS, GUARD_ABORTS, GUARD_PRECONDITION_INERT, PRECONDITION_WEDGES];
    for (const [surface, message] of Object.entries(messages)) {
      const mine = owned[surface as keyof typeof owned];
      expect(message).toContain(mine);
      for (const other of all.filter((c) => c !== mine)) {
        expect(message).not.toContain(other);
      }
    }
  });
});

// =================================================================================================
// BEHAVIOURAL PINS — every runtime claim the error message makes, EXECUTED.
//
// The error tells an author what happens if they ship this shape. Rev 1's guard/preconditions
// clause proves that asserting the WORDING is not enough: it was pinned, green, and false. So each
// claimed consequence is driven through the real engine here.
//
// These definitions are hand-built `WorkflowDefinition` objects on purpose. The loader now REFUSES
// every one of them — that is the feature — so the only way to observe the behaviour the refusal
// describes is to bypass the loader. Same precedent as the `settlement-namespace.test.ts` and
// `replay.test.ts` fixtures, which carry the identical note.
// =================================================================================================
describe('dead failure condition — the claimed consequences, executed (issue #362)', () => {
  const echo: StepDispatcher = async (_step, input) => ({ ...input });
  const explode: StepDispatcher = async () => {
    throw new Error('work exploded');
  };
  let store: JsonFileStore;

  beforeEach(async () => {
    store = new JsonFileStore(await mkdtemp(join(tmpdir(), 'realm-dead-cond-')));
  });

  /** `work`, then a dependent `cleanup` carrying the dead leaf on the caller's surface. */
  function def(surface: 'when' | 'preconditions'): WorkflowDefinition {
    return {
      id: 'dead-behaviour-wf',
      name: 'Dead Behaviour',
      version: 1,
      steps: {
        work: { description: 'Work', execution: 'auto', depends_on: [] },
        cleanup: {
          description: 'Cleanup',
          execution: 'auto',
          depends_on: ['work'],
          // No `trigger_rule` — the default `all_success` IS the trap.
          [surface]: ['$settlement.work.failed == true'],
        },
      },
    };
  }

  async function drive(
    definition: WorkflowDefinition,
    opts: { failWork: boolean },
  ): Promise<string> {
    const { run } = await store.create({
      workflowId: definition.id,
      workflowVersion: 1,
      params: {},
    });
    await executeStep(store, definition, {
      runId: run.id,
      command: 'work',
      input: {},
      dispatcher: opts.failWork ? explode : echo,
    });
    await executeStep(store, definition, {
      runId: run.id,
      command: 'cleanup',
      input: {},
      dispatcher: echo,
    });
    return run.id;
  }

  // CLAIM: "if <dep> fails the step is skipped as trigger_rule_unsatisfiable before the condition
  // is evaluated; if <dep> succeeds the condition evaluates to false (when_false)". BOTH halves.
  it('`when`, non-guard: a FAILED dep skips the step as trigger_rule_unsatisfiable', async () => {
    const after = await store.get(await drive(def('when'), { failWork: true }));
    expect(after.failed_steps).toContain('work');
    expect(after.skip_details?.['cleanup']?.kind).toBe('trigger_rule_unsatisfiable');
    expect(after.completed_steps).not.toContain('cleanup');
  });

  it('`when`, non-guard: a SUCCEEDED dep skips the step as when_false — the other half of the claim', async () => {
    const after = await store.get(await drive(def('when'), { failWork: false }));
    expect(after.completed_steps).toContain('work');
    expect(after.skip_details?.['cleanup']?.kind).toBe('when_false');
    expect(after.completed_steps).not.toContain('cleanup');
  });

  // CLAIM: "the step never settles — the run WEDGES in a blocked envelope". Pin the OBSERVABLE,
  // not the adjective: blocked envelope + unsettled step + a run that is still going nowhere.
  it('`preconditions`, non-guard: the step never settles and the run wedges in a blocked envelope', async () => {
    const { run } = await store.create({
      workflowId: 'dead-behaviour-wf',
      workflowVersion: 1,
      params: {},
    });
    const definition = def('preconditions');
    await executeStep(store, definition, {
      runId: run.id,
      command: 'work',
      input: {},
      dispatcher: echo,
    });
    const envelope = await executeStep(store, definition, {
      runId: run.id,
      command: 'cleanup',
      input: {},
      dispatcher: echo,
    });
    expect(envelope.status).toBe('blocked');
    // It is offered as eligible and refused on every attempt — that is the wedge, not a skip.
    expect(envelope.blocked_reason?.eligible_steps).toContain('cleanup');
    const after = await store.get(run.id);
    expect(after.completed_steps).not.toContain('cleanup');
    expect(after.failed_steps).not.toContain('cleanup');
    expect(after.skipped_steps).not.toContain('cleanup');
    expect(after.terminal_state).toBe(false);
  });

  // CLAIM: "the guard aborts the run on every execution". Guards run inline in the chain, so this
  // needs executeChain — a bare executeStep never reaches the guard at all.
  it('`abort_unless`, guard: the run aborts', async () => {
    const definition: WorkflowDefinition = {
      id: 'dead-guard-wf',
      name: 'Dead Guard',
      version: 1,
      steps: {
        work: { description: 'Work', execution: 'auto', depends_on: [] },
        check: {
          description: 'Check',
          execution: 'guard',
          depends_on: ['work'],
          abort_unless: ['$settlement.work.failed == true'],
        },
        tail: { description: 'Tail', execution: 'auto', depends_on: ['check'] },
      },
    };
    const { run } = await store.create({
      workflowId: definition.id,
      workflowVersion: 1,
      params: {},
    });
    await executeChain(store, definition, {
      runId: run.id,
      command: 'work',
      input: {},
      dispatcher: echo,
    });
    const after = await store.get(run.id);
    expect(after.aborted_at).toBeDefined();
    expect(after.run_phase).toBe('aborted');
    expect(after.completed_steps).not.toContain('tail');
  });

  // CLAIM (the one this correction adds): on a guard, `preconditions` is never evaluated, so the
  // run behaves identically whether it is present or absent. Executed, not asserted.
  it('`preconditions`, guard: present and absent produce byte-identical outcomes — the leaf is inert', async () => {
    const guardDef = (withPreconditions: boolean): WorkflowDefinition => ({
      id: 'dead-guard-pre-wf',
      name: 'Dead Guard Pre',
      version: 1,
      steps: {
        work: { description: 'Work', execution: 'auto', depends_on: [] },
        check: {
          description: 'Check',
          execution: 'guard',
          depends_on: ['work'],
          // Deliberately SATISFIED, so the guard actually executes. With an abort_unless that
          // failed, the run would abort before the precondition could matter and the comparison
          // would be vacuous — identical outcomes proving nothing.
          abort_unless: ['$settlement.work.settled_by_default == false'],
          ...(withPreconditions ? { preconditions: ['$settlement.work.failed == true'] } : {}),
        },
        tail: { description: 'Tail', execution: 'auto', depends_on: ['check'] },
      },
    });

    const outcomes: string[] = [];
    for (const withPreconditions of [true, false]) {
      const definition = guardDef(withPreconditions);
      const { run } = await store.create({
        workflowId: definition.id,
        workflowVersion: 1,
        params: {},
      });
      const envelope = await executeChain(store, definition, {
        runId: run.id,
        command: 'work',
        input: {},
        dispatcher: echo,
      });
      const after = await store.get(run.id);
      outcomes.push(
        JSON.stringify({
          envelope: envelope.status,
          completed: after.completed_steps,
          failed: after.failed_steps,
          skipped: after.skipped_steps,
          skip_details: after.skip_details,
          aborted: after.aborted_at !== undefined,
          run_phase: after.run_phase,
          terminal_state: after.terminal_state,
        }),
      );
    }
    expect(outcomes[0]).toBe(outcomes[1]);
    // Non-vacuity: the guard and everything behind it genuinely RAN in both arms. Without this,
    // two runs that both died early would compare equal and "inert" would be unproven.
    expect(outcomes[0]).toContain('"completed":["work","check","tail"]');
  });
});
