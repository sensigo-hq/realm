// Fix 2 (agent-written workflows), on top of issue #524. A `gate:` block on a step that can never
// open a gate used to load with ONE `DEAD_GATE_CONFIG` block advisory (#524, which replaced the
// per-member "set a timeout" remedies). Since fix 2 it is REFUSED at load: the engine mints a gate
// only where `isGateTrust(trust)` holds (Step 5b, `execution-loop.ts`), so the approval the block
// describes would ask nobody. One refusal per block:
//   - auto/agent with trust absent or `auto` (the `lawful_no_gate` verdict): message A;
//   - guard/finalizer, whatever `trust` says: message B, minted from the step-key registry;
//   - a trust the loader refuses keeps its own refusal; a malformed kind keeps its kind error.
// Beside A or B, the block's own key ERRORS still show (correction 1), so following the
// refusal's advice never meets a mistake it hid; no WARNING about the block's keys does.
// The cells below that pinned the #524 advisory now pin the refusal; the gate-trusted controls
// (cells 8, 8b, 10's second cell) are unchanged.
//
// `gate-timeout-loader.test.ts` is the loader's own unit home for the gate block's keys; its
// `gateWorkflow` helper hardcodes `trust: human_confirmed`, so this sibling drives the population
// without gate trust.
import { describe, it, expect } from 'vitest';
import { loadWorkflowFromStringWithDiagnostics } from './yaml-loader.js';
import type { LoaderWarning } from './diagnostics.js';

/** Message A, on the auto or agent step `step`, with its key-line cite. */
const MSG_A = (step: string, line: number): string =>
  `Step '${step}': the 'gate:' block is refused at load — this step declares no gate trust ` +
  "('trust: human_confirmed' or 'trust: human_reviewed'), so Realm would never open this gate: " +
  'nobody would be asked, and the run would go on exactly as if the block were not there. Set ' +
  "'trust: human_confirmed' on this step if a person must approve its result, or remove the " +
  `'gate:' block. This refusal clears as soon as either is done. (line ${line})`;

/** Message B, on a guard or finalizer step `step`, with its key-line cite. */
const MSG_B = (step: string, kind: 'guard' | 'finalizer', line: number): string =>
  `Step '${step}': 'gate' is not valid on execution: ${kind} steps — a ${kind} step never opens ` +
  "a gate (only an auto or agent step with 'trust: human_confirmed' or 'trust: human_reviewed' " +
  "does), so nobody would be asked. Move the 'gate:' block to the auto or agent step whose " +
  "result a person must approve, and set 'trust: human_confirmed' on that step; or remove the " +
  `block. This refusal clears as soon as either is done. (line ${line})`;

/** A gate block whose keys are all valid, so only the refusal under test can refuse it. */
const ON_EXPIRY_BLOCK = '      timeout_seconds: 300\n      on_expiry: abort';

function gateWorkflow(execution: string, extraStepFields: string, gateBlock: string): string {
  return `
id: gate-dead-block-524-wf
name: Gate Dead Block 524
version: 1
steps:
  work:
${extraStepFields}
    execution: ${execution}
    gate:
${gateBlock}
`;
}

const FINALIZER_WF = (trustLine: string, gateBlock: string): string => `
id: gate-dead-block-524-finalizer-wf
name: Gate Dead Block 524 Finalizer
version: 1
steps:
  domain:
    description: domain
    execution: auto
    handler: h
  work:
    description: work
    execution: finalizer
    handler: h
    on_outcome: [complete]
${trustLine}    gate:
${gateBlock}
`;

/** The load's errors and warnings; a load that succeeds fails the calling cell, naming that. */
function refusal(doc: string): { errors: string[]; warnings: LoaderWarning[] } {
  try {
    loadWorkflowFromStringWithDiagnostics(doc);
  } catch (err) {
    const e = err as { errors?: string[]; message: string; warnings?: LoaderWarning[] };
    return { errors: e.errors ?? [e.message], warnings: e.warnings ?? [] };
  }
  throw new Error('expected the workflow to be refused at load, but it loaded');
}

describe('yaml-loader — fix 2: a gate: block on a step that can never open a gate is refused at load', () => {
  describe('cell 7 — every step kind without gate trust (was the #524 block advisory)', () => {
    it('guard (never gate-trusted): exactly ONE error, message B at the gate key', () => {
      const { errors } = refusal(
        gateWorkflow(
          'guard',
          "    description: check\n    abort_unless: ['work.ok == true']",
          ON_EXPIRY_BLOCK,
        ),
      );
      // (1) red when the auto/agent refusal also fires on a guard (two errors), or when gate×guard
      //     is left as before (it loads, and `refusal` throws "expected … refused"); (2) prints the
      //     error list.
      expect(errors).toEqual([MSG_B('work', 'guard', 10)]);
    });

    it('auto, NO trust declared: exactly ONE error, message A at the gate key', () => {
      const { errors } = refusal(
        gateWorkflow('auto', '    description: work\n    handler: h', ON_EXPIRY_BLOCK),
      );
      // (1) red when the refusal is removed (the file loads); (2) prints the error list.
      expect(errors).toEqual([MSG_A('work', 10)]);
    });

    it("auto, trust: 'auto' EXPLICITLY (still not gate-trusted): exactly ONE error, message A", () => {
      const { errors } = refusal(
        gateWorkflow(
          'auto',
          '    description: work\n    handler: h\n    trust: auto',
          ON_EXPIRY_BLOCK,
        ),
      );
      // (1) red when the predicate tests only an absent trust (this file then loads); (2) prints
      //     the error list.
      expect(errors).toEqual([MSG_A('work', 11)]);
    });

    it('agent, NO trust declared: exactly ONE error, message A', () => {
      const { errors } = refusal(
        gateWorkflow('agent', '    description: work\n    handler: h', ON_EXPIRY_BLOCK),
      );
      // (1) red when the refusal covers auto only (this file then loads); (2) prints the errors.
      expect(errors).toEqual([MSG_A('work', 10)]);
    });

    it('finalizer (never gate-trusted): exactly ONE error, the finalizer form of message B', () => {
      const { errors } = refusal(FINALIZER_WF('', ON_EXPIRY_BLOCK));
      // (1) red when gate×finalizer is left as before (it loads, and `refusal` throws); (2) prints
      //     the error list.
      expect(errors).toEqual([MSG_B('work', 'finalizer', 15)]);
    });

    it('auto, NO trust, the reminder member alone: still exactly ONE error, message A, and no member warning', () => {
      const { errors, warnings } = refusal(
        gateWorkflow(
          'auto',
          '    description: work\n    handler: h',
          '      timeout_seconds: 60\n      reminder_seconds: 60',
        ),
      );
      // (1) red when the refusal is removed (the file loads); (2) prints the error list.
      expect(errors).toEqual([MSG_A('work', 10)]);
      // The reminder member's own claim ("the first reminder would never fire before the gate
      // expires") must not appear: there is no gate here to expire. (1) red when the member
      // advisories run without gate trust (the #524 check, `gateTrusted`), which a refused block
      // now reaches; (2) prints the warning codes.
      expect(warnings.map((w) => w.code)).toEqual([]);
    });

    it('auto, NO trust, gate.timeout_seconds ALONE: exactly ONE error, message A (whichever keys are set)', () => {
      const { errors } = refusal(
        gateWorkflow('auto', '    description: work\n    handler: h', '      timeout_seconds: 60'),
      );
      // (1) red when the refusal is removed (the file loads); (2) prints the error list.
      expect(errors).toEqual([MSG_A('work', 10)]);
    });
  });

  describe('a refused trust beside the block', () => {
    it("guard with trust: human_confirmed and a gate: TWO errors, the guard's trust refusal and message B", () => {
      const { errors } = refusal(
        gateWorkflow(
          'guard',
          "    description: check\n    abort_unless: ['work.ok == true']\n    trust: human_confirmed",
          ON_EXPIRY_BLOCK,
        ),
      );
      // (1) red when the gate refusal is skipped because the trust is refused (one error);
      //     (2) prints the error list.
      expect(errors).toHaveLength(2);
      expect(errors[0]).toContain("Step 'work': 'trust' is not valid on execution: guard steps");
      expect(errors[1]).toBe(MSG_B('work', 'guard', 11));
    });

    it('auto with a misspelt trust (human_confrimed) and a gate: exactly ONE error, the trust refusal', () => {
      const { errors } = refusal(
        gateWorkflow(
          'auto',
          '    description: work\n    handler: h\n    trust: human_confrimed',
          ON_EXPIRY_BLOCK,
        ),
      );
      // (1) red when the predicate does not leave out a trust the loader refuses (message A beside
      //     it: two errors); (2) prints the error list.
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain(
        "Step 'work': 'trust: \"human_confrimed\"' is not a recognized value — refused at load",
      );
    });
  });

  describe("correction 1 — a guard's refused block shows its own mistakes, never its warnings", () => {
    it('guard with gate {choices: []}: TWO errors, message B and the empty-choices error', () => {
      const { errors } = refusal(
        gateWorkflow(
          'guard',
          "    description: check\n    abort_unless: ['work.ok == true']",
          '      choices: []',
        ),
      );
      // (1) red when the block's own errors are still hidden on a guard (B alone: one error);
      //     (2) prints the error list.
      expect(errors).toHaveLength(2);
      // (1) red when B's text or line changes, or when it no longer comes first; (2) prints it.
      expect(errors[0]).toBe(MSG_B('work', 'guard', 10));
      // (1) red when the empty-choices error is missing or cites another line; (2) prints it.
      expect(errors[1]).toContain(
        "Step 'work': 'gate.choices', when declared, must be non-empty — an empty list is never right",
      );
      expect(errors[1]).toMatch(/\(line 11\)$/);
    });

    it('guard with trust: human_confirmed and gate {default_choice: approve}: TWO errors, the trust refusal and message B, and no warning', () => {
      const { errors, warnings } = refusal(
        gateWorkflow(
          'guard',
          "    description: check\n    abort_unless: ['work.ok == true']\n    trust: human_confirmed",
          '      default_choice: approve',
        ),
      );
      // (1) red when another error joins them (or one goes); (2) prints the error list.
      expect(errors).toHaveLength(2);
      expect(errors[0]).toContain("Step 'work': 'trust' is not valid on execution: guard steps");
      expect(errors[1]).toBe(MSG_B('work', 'guard', 11));
      // A gate-trust value passes the member advisories' own gate-trust check, so on a guard they
      // are hidden explicitly. (1) red when they are not (a DEAD_GATE_CONFIG warning appears);
      // (2) prints the warning codes.
      expect(warnings.map((w) => w.code)).toEqual([]);
    });
  });

  describe('a step whose kind is not known', () => {
    it('execution: human with a gate: the kind error only, never message A or B (the #517 rule)', () => {
      const { errors } = refusal(gateWorkflow('human', '    description: work', ON_EXPIRY_BLOCK));
      // (1) red when the predicate runs before the kind is known (message A appears beside the
      //     kind error); (2) prints the error list.
      expect(errors).toEqual([
        "Step 'work': invalid execution value 'human'; must be 'auto', 'agent', 'guard', or 'finalizer' (step at line 6)",
      ]);
    });
  });

  describe('cell 8 — controls: the live (gate-trusted) population is unaffected', () => {
    it('human_confirmed + timeout_seconds + on_expiry: abort together — legal, no warning at all', () => {
      const { warnings } = loadWorkflowFromStringWithDiagnostics(
        gateWorkflow(
          'auto',
          '    description: work\n    handler: h\n    trust: human_confirmed',
          '      timeout_seconds: 300\n      on_expiry: abort',
        ),
      );
      expect(warnings.filter((w) => w.code === 'DEAD_GATE_CONFIG')).toEqual([]);
    });

    it('human_confirmed + timeout_seconds ALONE (no on_expiry) — legal finding-only mode, no warning', () => {
      const { warnings } = loadWorkflowFromStringWithDiagnostics(
        gateWorkflow(
          'auto',
          '    description: work\n    handler: h\n    trust: human_confirmed',
          '      timeout_seconds: 60',
        ),
      );
      expect(warnings.filter((w) => w.code === 'DEAD_GATE_CONFIG')).toEqual([]);
    });
  });

  describe('cell 8b — the SECOND gate-trust member, human_reviewed, takes the gate-trusted arm (correction: unpinned at the :1601 fork)', () => {
    // isGateTrust (GATE_TRUST_LEVELS) admits TWO values — human_confirmed and human_reviewed —
    // but every cell above (and every pre-existing cell in gate-timeout-loader.test.ts, whose
    // gateWorkflow helper hardcodes human_confirmed) exercises the gate-trusted arm with
    // human_confirmed ONLY. The CODE already reads isGateTrust (both values), so this is a pin
    // gap, not a bug: mutating the fork to `step['trust'] === 'human_confirmed'` left this file
    // green until now.
    it('human_reviewed + on_expiry: abort (no timeout_seconds) — exactly ONE DEAD_GATE_CONFIG, the UNCHANGED member text, never the block', () => {
      const { warnings } = loadWorkflowFromStringWithDiagnostics(
        gateWorkflow(
          'auto',
          '    description: work\n    handler: h\n    trust: human_reviewed',
          '      on_expiry: abort',
        ),
      );
      const gate = warnings.filter((w) => w.code === 'DEAD_GATE_CONFIG');
      expect(gate).toHaveLength(1);
      expect(gate[0]?.message).toBe(
        "Step 'work': 'gate.on_expiry' is ignored without 'gate.timeout_seconds' — set a " +
          "timeout, or remove 'gate.on_expiry'.",
      );
    });

    it('human_reviewed + timeout_seconds + on_expiry: abort together — the live population, no warning at all (control, paired with the cell above)', () => {
      const { warnings } = loadWorkflowFromStringWithDiagnostics(
        gateWorkflow(
          'auto',
          '    description: work\n    handler: h\n    trust: human_reviewed',
          '      timeout_seconds: 60\n      on_expiry: abort',
        ),
      );
      expect(warnings.filter((w) => w.code === 'DEAD_GATE_CONFIG')).toEqual([]);
    });
  });

  describe('cell 10 — the default_choice chain: on a no-trust step it is ALWAYS the refusal, never the member text', () => {
    it('default_choice alone, no-trust: exactly ONE error, message A, not "is ignored without gate.on_expiry: settle_default"', () => {
      const { errors, warnings } = refusal(
        gateWorkflow(
          'auto',
          '    description: work\n    handler: h',
          '      default_choice: approve',
        ),
      );
      // (1) red when the refusal is removed (the file loads); (2) prints the error list.
      expect(errors).toEqual([MSG_A('work', 10)]);
      // (1) red when the member advisories run without gate trust (the #524 check, `gateTrusted`),
      //     which a refused block now reaches; (2) prints the warning codes.
      expect(warnings.map((w) => w.code)).toEqual([]);
    });

    it('default_choice alone, human_confirmed (gate-trusted): the UNCHANGED member text, not the block', () => {
      const { warnings } = loadWorkflowFromStringWithDiagnostics(
        gateWorkflow(
          'auto',
          '    description: work\n    handler: h\n    trust: human_confirmed',
          '      default_choice: approve',
        ),
      );
      const gate = warnings.filter((w) => w.code === 'DEAD_GATE_CONFIG');
      expect(gate).toHaveLength(1);
      expect(gate[0]?.message).toBe(
        "Step 'work': 'gate.default_choice' is ignored without 'gate.on_expiry: settle_default' " +
          "— set it, or remove 'gate.default_choice'.",
      );
    });

    it('the full member chain, no-trust: adding on_expiry: settle_default beside default_choice still gets only the refusal — the keys never decide it', () => {
      const { errors } = refusal(
        gateWorkflow(
          'auto',
          '    description: work\n    handler: h',
          '      on_expiry: settle_default\n      default_choice: approve',
        ),
      );
      // (1) red when the refusal is removed (the file loads); (2) prints the error list.
      expect(errors).toEqual([MSG_A('work', 10)]);
    });
  });
});
