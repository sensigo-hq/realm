// Issue #524 — the gate-remedy silence: `DEAD_GATE_CONFIG.on_expiry_without_timeout` (and its
// `default_choice`/`reminder_seconds` siblings) used to tell a step with NO gate trust to "set a
// timeout" — following that remedy never makes the block live (the engine only ever mints a gate
// where `isGateTrust(trust)` holds, `execution-loop.ts:3302`), it only silences the one
// diagnostic that said so. This file pins the fork in `yaml-loader.ts` that replaces the
// per-member advisories with ONE block advisory, unconditional on which `gate.*` sub-keys are
// declared, everywhere gate trust is absent.
//
// `gate-timeout-loader.test.ts` is this module's own unit home and is BLIND to this change — its
// `gateWorkflow` helper hardcodes `trust: human_confirmed` on every fixture, so none of its
// existing cells ever reach the non-trusted arm (verified: that file's full suite is unchanged,
// byte-identical, by this round). This sibling drives the population the loader's own unit home
// cannot reach.
import { describe, it, expect } from 'vitest';
import { loadWorkflowFromStringWithDiagnostics } from './yaml-loader.js';

const BLOCK_TEXT =
  "the 'gate:' block is inert — this step declares no gate trust ('trust: human_confirmed' or " +
  "'trust: human_reviewed'), so no gate is ever minted and none of its keys are read. Remove the " +
  'block, or (on an auto or agent step) declare that trust.';

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

describe('yaml-loader — issue #524, the gate-remedy silence (DEAD_GATE_CONFIG block advisory)', () => {
  describe('cell 7 — at-stake first, RED-FIRST on the pre-#524 loader: the silenced remedy', () => {
    const ON_EXPIRY_BLOCK = '      timeout_seconds: 300\n      on_expiry: abort';

    it('guard (never trust-eligible): exactly ONE DEAD_GATE_CONFIG, the block text, on the gate key', () => {
      const { warnings } = loadWorkflowFromStringWithDiagnostics(
        gateWorkflow(
          'guard',
          "    description: check\n    abort_unless: ['true == true']",
          ON_EXPIRY_BLOCK,
        ),
      );
      const gate = warnings.filter((w) => w.code === 'DEAD_GATE_CONFIG');
      expect(gate).toHaveLength(1);
      expect(gate[0]?.message).toBe(`Step 'work': ${BLOCK_TEXT}`);
      expect(gate[0]?.key).toBe('gate');
      expect(gate[0]?.line).toBeDefined();
      expect(gate[0]?.column).toBeDefined();
      expect(gate[0]?.endLine).toBeDefined();
      expect(gate[0]?.endColumn).toBeDefined();
    });

    it('auto, NO trust declared: exactly ONE DEAD_GATE_CONFIG, the block text', () => {
      const { warnings } = loadWorkflowFromStringWithDiagnostics(
        gateWorkflow('auto', '    description: work\n    handler: h', ON_EXPIRY_BLOCK),
      );
      const gate = warnings.filter((w) => w.code === 'DEAD_GATE_CONFIG');
      expect(gate).toHaveLength(1);
      expect(gate[0]?.message).toBe(`Step 'work': ${BLOCK_TEXT}`);
    });

    it("auto, trust: 'auto' EXPLICITLY (still not gate-trusted): exactly ONE DEAD_GATE_CONFIG, the block text", () => {
      const { warnings } = loadWorkflowFromStringWithDiagnostics(
        gateWorkflow(
          'auto',
          '    description: work\n    handler: h\n    trust: auto',
          ON_EXPIRY_BLOCK,
        ),
      );
      const gate = warnings.filter((w) => w.code === 'DEAD_GATE_CONFIG');
      expect(gate).toHaveLength(1);
      expect(gate[0]?.message).toBe(`Step 'work': ${BLOCK_TEXT}`);
    });

    it('agent, NO trust declared: exactly ONE DEAD_GATE_CONFIG, the block text', () => {
      const { warnings } = loadWorkflowFromStringWithDiagnostics(
        gateWorkflow('agent', '    description: work\n    handler: h', ON_EXPIRY_BLOCK),
      );
      const gate = warnings.filter((w) => w.code === 'DEAD_GATE_CONFIG');
      expect(gate).toHaveLength(1);
      expect(gate[0]?.message).toBe(`Step 'work': ${BLOCK_TEXT}`);
    });

    it('finalizer (structurally never trust-eligible): exactly ONE DEAD_GATE_CONFIG, the block text', () => {
      const { warnings } = loadWorkflowFromStringWithDiagnostics(`
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
    gate:
${ON_EXPIRY_BLOCK}
`);
      const gate = warnings.filter((w) => w.code === 'DEAD_GATE_CONFIG');
      expect(gate).toHaveLength(1);
      expect(gate[0]?.message).toBe(`Step 'work': ${BLOCK_TEXT}`);
    });

    it('auto, NO trust, the reminder member alone (F1 — the third silenced member, folded into REV 2): still exactly ONE, the block text', () => {
      const { warnings } = loadWorkflowFromStringWithDiagnostics(
        gateWorkflow(
          'auto',
          '    description: work\n    handler: h',
          '      timeout_seconds: 60\n      reminder_seconds: 60',
        ),
      );
      const gate = warnings.filter((w) => w.code === 'DEAD_GATE_CONFIG');
      expect(gate).toHaveLength(1);
      expect(gate[0]?.message).toBe(`Step 'work': ${BLOCK_TEXT}`);
      // The pre-#524 reminder member's own claim ("the first reminder would never fire before
      // the gate expires") must NOT appear — there is no gate here to expire.
      expect(gate[0]?.message).not.toContain('would never fire before the gate expires');
    });

    it('auto, NO trust, gate.timeout_seconds ALONE (no on_expiry/default_choice/reminder — the block is equally inert whichever keys are set)', () => {
      const { warnings } = loadWorkflowFromStringWithDiagnostics(
        gateWorkflow('auto', '    description: work\n    handler: h', '      timeout_seconds: 60'),
      );
      const gate = warnings.filter((w) => w.code === 'DEAD_GATE_CONFIG');
      expect(gate).toHaveLength(1);
      expect(gate[0]?.message).toBe(`Step 'work': ${BLOCK_TEXT}`);
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
      expect(gate[0]?.message).not.toContain("gate:' block is inert");
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

  describe('cell 9 — the registry-derived kind list can never drift from the vocabulary that gates it', () => {
    it("the rendered whole message contains every member of consumedKindsFor('trust'), joined 'X or Y'", () => {
      const { warnings } = loadWorkflowFromStringWithDiagnostics(
        gateWorkflow(
          'auto',
          '    description: work\n    handler: h',
          '      timeout_seconds: 60\n      on_expiry: abort',
        ),
      );
      const gate = warnings.find((w) => w.code === 'DEAD_GATE_CONFIG');
      // consumedKindsFor('trust') is ['auto', 'agent'] today (STEP_KEY_REGISTRY.trust.{auto,
      // agent}.c === 'consumed', .guard/.finalizer === 'prohibited') — asserted against the
      // rendered TEXT, not re-derived by this test, so a registry change reds this cell instead
      // of the registry cell silently drifting from the mint's own wording.
      expect(gate?.message).toContain('on an auto or agent step');
    });
  });

  describe('cell 10 — the default_choice chain: on a no-trust step it is ALWAYS the block advisory, never the member text', () => {
    it('default_choice alone, no-trust: the block advisory, not "is ignored without gate.on_expiry: settle_default"', () => {
      const { warnings } = loadWorkflowFromStringWithDiagnostics(
        gateWorkflow(
          'auto',
          '    description: work\n    handler: h',
          '      default_choice: approve',
        ),
      );
      const gate = warnings.filter((w) => w.code === 'DEAD_GATE_CONFIG');
      expect(gate).toHaveLength(1);
      expect(gate[0]?.message).toBe(`Step 'work': ${BLOCK_TEXT}`);
      expect(gate[0]?.message).not.toContain('gate.default_choice');
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

    it('the full remedy chain, no-trust: remedy 1 (add on_expiry: settle_default) does not clear the block — it still needs default_choice; adding it too still yields the block advisory, never the member texts', () => {
      // Step 1: default_choice alone → block advisory (already asserted above). Step 2: an
      // author "following remedy 1" adds on_expiry too — settle_default REQUIRES a valid
      // default_choice as a hard error (unconditional, unaffected by this fork), which this
      // fixture already satisfies, so the load-time hard-error checks pass; the ADVISORY layer
      // still reports the true cause: the whole block is inert without gate trust.
      const { warnings } = loadWorkflowFromStringWithDiagnostics(
        gateWorkflow(
          'auto',
          '    description: work\n    handler: h',
          '      on_expiry: settle_default\n      default_choice: approve',
        ),
      );
      const gate = warnings.filter((w) => w.code === 'DEAD_GATE_CONFIG');
      expect(gate).toHaveLength(1);
      expect(gate[0]?.message).toBe(`Step 'work': ${BLOCK_TEXT}`);
    });
  });
});
