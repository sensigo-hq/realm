// Loader validation for issue #140 (declaration-gated retryable timeout + total-time cap):
// retry.on_timeout / retry.total_timeout_seconds — E1/E2/E3 hard errors, W1/W2/W3/W5 advisories,
// and the C4 emergent-rejection composition (on_timeout on a non-auto step).
import { describe, it, expect } from 'vitest';
import { loadWorkflowFromString, loadWorkflowFromStringWithDiagnostics } from './yaml-loader.js';
import { WorkflowError } from '../types/workflow-error.js';
import {
  DEFAULT_POLICY,
  resolveSeverity,
  renderLoaderWarning,
  type WarningCode,
  type LoaderWarning,
} from './diagnostics.js';

function expectThrows(yaml: string, substring: string): void {
  expect(() => loadWorkflowFromString(yaml)).toThrow(WorkflowError);
  try {
    loadWorkflowFromString(yaml);
    throw new Error('expected loadWorkflowFromString to throw');
  } catch (err) {
    expect((err as WorkflowError).message).toContain(substring);
  }
}

describe('yaml-loader — issue #140 retry.on_timeout / retry.total_timeout_seconds', () => {
  describe('E1 — on_timeout: true requires idempotent: true (declared, never inferred)', () => {
    it('AC2 loader-throw: on_timeout without idempotent is a hard error at load', () => {
      expectThrows(
        `
id: e1-wf
name: E1
version: 1
steps:
  work:
    description: Work
    execution: auto
    handler: h
    retry:
      max_attempts: 3
      on_timeout: true
`,
        "requires 'idempotent: true'",
      );
    });

    // S5(b) correction: augmented (never deleted) — the original negative-only assertion had a
    // self-catching sentinel bug: if loadWorkflowFromString stopped throwing entirely, the
    // `throw new Error('expected throw')` line itself would be caught below, and 'expected throw'
    // does not match /rung|capability ladder/i either — the negative assertion would falsely PASS
    // even though the loader silently stopped rejecting the workflow. The added POSITIVE
    // `toContain` of the actual shipped teaching sentence closes that gap (a non-throw now fails
    // on the positive assertion, not just fails to fail the negative one). The negative regex is
    // also widened (never narrowed) to catch more of the #197 vocabulary family.
    it('teaching text is declared-never-inferred and does NOT use issue #197 capability/rung vocabulary', () => {
      try {
        loadWorkflowFromString(`
id: e1-wf2
name: E1
version: 1
steps:
  work:
    description: Work
    execution: auto
    handler: h
    retry:
      max_attempts: 3
      on_timeout: true
`);
        throw new Error('expected throw');
      } catch (err) {
        const message = (err as WorkflowError).message;
        expect(message).not.toMatch(/rung|capabilit|carriage|seal|trio/i);
        expect(message).toContain(
          "'retry.on_timeout: true' requires 'idempotent: true' declared on the step",
        );
      }
    });

    it('idempotent: true declared alongside on_timeout: true passes E1', () => {
      const def = loadWorkflowFromString(`
id: e1-wf3
name: E1 OK
version: 1
steps:
  work:
    description: Work
    execution: auto
    handler: h
    idempotent: true
    retry:
      max_attempts: 3
      on_timeout: true
`);
      expect(def.steps['work']!.retry?.on_timeout).toBe(true);
    });

    it('idempotent: false (explicit) alongside on_timeout: true still fails E1 — strict === true, not truthiness', () => {
      expectThrows(
        `
id: e1-wf4
name: E1 Strict
version: 1
steps:
  work:
    description: Work
    execution: auto
    handler: h
    idempotent: false
    retry:
      max_attempts: 3
      on_timeout: true
`,
        "requires 'idempotent: true'",
      );
    });
  });

  describe('E2 — total_timeout_seconds must be a positive integer', () => {
    it('rejects a non-integer total_timeout_seconds', () => {
      expectThrows(
        `
id: e2-wf
name: E2
version: 1
steps:
  work:
    description: Work
    execution: auto
    handler: h
    retry:
      max_attempts: 3
      total_timeout_seconds: 1.5
`,
        "'retry.total_timeout_seconds' must be a positive integer",
      );
    });

    it('rejects total_timeout_seconds: 0 (authored YAML only — a hand-built definition may still use 0)', () => {
      expectThrows(
        `
id: e2-wf2
name: E2 Zero
version: 1
steps:
  work:
    description: Work
    execution: auto
    handler: h
    retry:
      max_attempts: 3
      total_timeout_seconds: 0
`,
        "'retry.total_timeout_seconds' must be a positive integer",
      );
    });

    it('rejects a negative total_timeout_seconds', () => {
      expectThrows(
        `
id: e2-wf3
name: E2 Negative
version: 1
steps:
  work:
    description: Work
    execution: auto
    handler: h
    retry:
      max_attempts: 3
      total_timeout_seconds: -5
`,
        "'retry.total_timeout_seconds' must be a positive integer",
      );
    });

    it('accepts a positive integer total_timeout_seconds — standalone-legal, no on_timeout required', () => {
      const def = loadWorkflowFromString(`
id: e2-wf4
name: E2 OK
version: 1
steps:
  work:
    description: Work
    execution: auto
    handler: h
    retry:
      max_attempts: 3
      total_timeout_seconds: 60
`);
      expect(def.steps['work']!.retry?.total_timeout_seconds).toBe(60);
    });
  });

  describe('E3 — on_timeout must be a boolean', () => {
    it('rejects a string "true"', () => {
      expectThrows(
        `
id: e3-wf
name: E3
version: 1
steps:
  work:
    description: Work
    execution: auto
    handler: h
    retry:
      max_attempts: 3
      on_timeout: "true"
`,
        "'retry.on_timeout' must be a boolean",
      );
    });
  });

  describe('W1 — on_timeout with an effective max_attempts of 1', () => {
    it('warns when max_attempts is explicitly 1', () => {
      const { warnings } = loadWorkflowFromStringWithDiagnostics(`
id: w1-wf
name: W1
version: 1
steps:
  work:
    description: Work
    execution: auto
    handler: h
    idempotent: true
    retry:
      max_attempts: 1
      on_timeout: true
`);
      const w1 = warnings.find((w) => w.code === 'ON_TIMEOUT_SINGLE_ATTEMPT');
      expect(w1).toBeDefined();
      expect(w1?.message).toContain('no effect');
    });

    it('warns when max_attempts is ABSENT (the loader admits it; the engine defaults it to 1)', () => {
      const { warnings } = loadWorkflowFromStringWithDiagnostics(`
id: w1-wf2
name: W1 Absent
version: 1
steps:
  work:
    description: Work
    execution: auto
    handler: h
    idempotent: true
    retry:
      on_timeout: true
`);
      const w1 = warnings.find((w) => w.code === 'ON_TIMEOUT_SINGLE_ATTEMPT');
      expect(w1).toBeDefined();
    });

    it('does NOT warn when max_attempts is 2 or more', () => {
      const { warnings } = loadWorkflowFromStringWithDiagnostics(`
id: w1-wf3
name: W1 No Warn
version: 1
steps:
  work:
    description: Work
    execution: auto
    handler: h
    idempotent: true
    retry:
      max_attempts: 2
      on_timeout: true
`);
      expect(warnings.find((w) => w.code === 'ON_TIMEOUT_SINGLE_ATTEMPT')).toBeUndefined();
    });
  });

  describe('W2 — the cap can never cover even a single full-length attempt', () => {
    it('(a) fires when an EXPLICIT cap is below an EXPLICIT timeout_seconds', () => {
      const { warnings } = loadWorkflowFromStringWithDiagnostics(`
id: w2a-wf
name: W2a
version: 1
steps:
  work:
    description: Work
    execution: auto
    handler: h
    timeout_seconds: 100
    retry:
      max_attempts: 3
      total_timeout_seconds: 50
`);
      const w2 = warnings.find((w) => w.code === 'TOTAL_TIMEOUT_BELOW_ATTEMPT');
      expect(w2).toBeDefined();
    });

    it('(b) fires when on_timeout: true has a cap at-or-below the effective per-attempt timeout', () => {
      const { warnings } = loadWorkflowFromStringWithDiagnostics(`
id: w2b-wf
name: W2b
version: 1
steps:
  work:
    description: Work
    execution: auto
    handler: h
    idempotent: true
    timeout_seconds: 50
    retry:
      max_attempts: 3
      on_timeout: true
      total_timeout_seconds: 50
`);
      const w2 = warnings.find((w) => w.code === 'TOTAL_TIMEOUT_BELOW_ATTEMPT');
      expect(w2).toBeDefined();
    });

    // S5(a) correction: the test above always declares an EXPLICIT timeout_seconds, so it can
    // never exercise the `explicitTimeoutSeconds ?? DEFAULT_EXECUTION_TIMEOUT_SECONDS` fallback
    // branch of W2(b)'s effective-per-attempt computation — a mutation dropping that `??` would
    // survive it undetected (effectivePerAttemptSeconds would silently read `undefined`, and
    // `1800 <= undefined` is `false` in JS, so W2 simply wouldn't fire — but the explicit
    // timeout_seconds:50 case above never routes through that branch to notice). This fixture
    // declares NO timeout_seconds at all, forcing the fallback to DEFAULT_EXECUTION_TIMEOUT_SECONDS
    // (3600s); max_attempts:2 keeps W1 out of the way.
    it('(b) fallback branch: fires via the DEFAULT_EXECUTION_TIMEOUT_SECONDS fallback when timeout_seconds is absent entirely', () => {
      const { warnings } = loadWorkflowFromStringWithDiagnostics(`
id: w2b-fallback-wf
name: W2b Fallback
version: 1
steps:
  work:
    description: Work
    execution: auto
    handler: h
    idempotent: true
    retry:
      max_attempts: 2
      on_timeout: true
      total_timeout_seconds: 1800
`);
      const w2 = warnings.find((w) => w.code === 'TOTAL_TIMEOUT_BELOW_ATTEMPT');
      expect(w2).toBeDefined();
    });

    it('never fires on the bare 3600s-default population (no explicit total_timeout_seconds at all)', () => {
      const { warnings } = loadWorkflowFromStringWithDiagnostics(`
id: w2-none-wf
name: W2 None
version: 1
steps:
  work:
    description: Work
    execution: auto
    handler: h
    retry:
      max_attempts: 3
`);
      expect(warnings.find((w) => w.code === 'TOTAL_TIMEOUT_BELOW_ATTEMPT')).toBeUndefined();
    });

    it('does not fire when the explicit cap comfortably covers the explicit attempt timeout', () => {
      const { warnings } = loadWorkflowFromStringWithDiagnostics(`
id: w2-ok-wf
name: W2 OK
version: 1
steps:
  work:
    description: Work
    execution: auto
    handler: h
    timeout_seconds: 10
    retry:
      max_attempts: 3
      total_timeout_seconds: 60
`);
      expect(warnings.find((w) => w.code === 'TOTAL_TIMEOUT_BELOW_ATTEMPT')).toBeUndefined();
    });
  });

  describe('W3 — UNKNOWN_RETRY_KEY (unknown key inside a retry: block)', () => {
    it('warns on an unrecognized retry key, with the "retry" noun (not "step")', () => {
      const { warnings } = loadWorkflowFromStringWithDiagnostics(`
id: w3-wf
name: W3
version: 1
steps:
  work:
    description: Work
    execution: auto
    handler: h
    retry:
      max_attempts: 3
      not_a_real_retry_key: 1
`);
      const w3 = warnings.find((w) => w.code === 'UNKNOWN_RETRY_KEY');
      expect(w3).toBeDefined();
      expect(w3?.message).toContain('not a recognized retry field');
      expect(w3?.message).not.toContain('recognized step field');
    });

    it('suggests a did_you_mean for a close typo of a retry key', () => {
      const { warnings } = loadWorkflowFromStringWithDiagnostics(`
id: w3-wf2
name: W3 Typo
version: 1
steps:
  work:
    description: Work
    execution: auto
    handler: h
    retry:
      max_attempts: 3
      on_timout: true
`);
      const w3 = warnings.find((w) => w.code === 'UNKNOWN_RETRY_KEY');
      expect(w3?.did_you_mean).toBe('on_timeout');
    });

    it('does not warn for any of the 6 known retry keys', () => {
      const { warnings } = loadWorkflowFromStringWithDiagnostics(`
id: w3-wf3
name: W3 Known
version: 1
steps:
  work:
    description: Work
    execution: auto
    handler: h
    idempotent: true
    retry:
      max_attempts: 3
      backoff: fixed
      base_delay_ms: 10
      max_delay_ms: 100
      on_timeout: true
      total_timeout_seconds: 60
`);
      expect(warnings.find((w) => w.code === 'UNKNOWN_RETRY_KEY')).toBeUndefined();
    });
  });

  describe('W5 — total_timeout_seconds is inert on a non-auto step (CAP-only advisory)', () => {
    it('warns when an agent step declares retry.total_timeout_seconds', () => {
      const { warnings } = loadWorkflowFromStringWithDiagnostics(`
id: w5-wf
name: W5
version: 1
steps:
  work:
    description: Work
    execution: agent
    retry:
      max_attempts: 3
      total_timeout_seconds: 60
`);
      const w5 = warnings.find((w) => w.code === 'TOTAL_TIMEOUT_NON_AUTO');
      expect(w5).toBeDefined();
      expect(w5?.message).toContain("execution: 'agent'");
    });

    it('does NOT warn (W5 is cap-only) merely for a bare retry block with no total_timeout_seconds on a non-auto step', () => {
      const { warnings } = loadWorkflowFromStringWithDiagnostics(`
id: w5-wf2
name: W5 Bare
version: 1
steps:
  work:
    description: Work
    execution: agent
    retry:
      max_attempts: 3
`);
      expect(warnings.find((w) => w.code === 'TOTAL_TIMEOUT_NON_AUTO')).toBeUndefined();
    });
  });

  describe('C4 — emergent rejection: on_timeout on a non-auto (agent/guard) step is a hard error, but NOT via E1 and with no W5', () => {
    it('IDEMPOTENT-ABSENT: no idempotent declared ⇒ E1 fires (on_timeout requires idempotent)', () => {
      expectThrows(
        `
id: c4-wf
name: C4 No Idempotent
version: 1
steps:
  work:
    description: Work
    execution: agent
    retry:
      max_attempts: 3
      on_timeout: true
`,
        "requires 'idempotent: true'",
      );
    });

    it("IDEMPOTENT-DECLARED variant: idempotent: true ALSO declared ⇒ E1 is silent, but the PRE-EXISTING idempotent-non-auto check still hard-rejects the workflow (R11's named acceptance — no W5 either, since no total_timeout_seconds is declared)", () => {
      const yaml = `
id: c4-wf2
name: C4 With Idempotent
version: 1
steps:
  work:
    description: Work
    execution: agent
    idempotent: true
    retry:
      max_attempts: 3
      on_timeout: true
`;
      // The overall load still throws — via the idempotent-only-valid-on-auto check, a mechanism
      // entirely outside #140's own E1/W5 scope (this is the "emergent" composition).
      expect(() => loadWorkflowFromString(yaml)).toThrow(WorkflowError);
      try {
        loadWorkflowFromString(yaml);
      } catch (err) {
        const message = (err as WorkflowError).message;
        // NOT rejected via E1 (idempotent IS declared true, satisfying E1's own conjunct).
        expect(message).not.toContain("requires 'idempotent: true'");
        // Rejected via the pre-existing #101 check instead.
        expect(message).toContain("'idempotent' is only valid on execution: auto steps");
      }
    });
  });

  describe('negative pin — RETRY_NO_TOTAL_TIMEOUT (design-record W4) was deleted by amendment, never shipped', () => {
    it('is not a member of WarningCode / DEFAULT_POLICY (runtime + compile-time)', () => {
      expect(Object.keys(DEFAULT_POLICY)).not.toContain('RETRY_NO_TOTAL_TIMEOUT');
      // Compile-time companion: 'RETRY_NO_TOTAL_TIMEOUT' extends WarningCode only if it IS a
      // member of the union — that branch produces an error-tuple type, which `true` cannot
      // satisfy, so a reintroduction fails the BUILD, not just this runtime assertion (same
      // drift-guard pattern as KNOWN_STEP_KEYS/KNOWN_RETRY_KEYS in workflow-definition.ts).
      type _Check = 'RETRY_NO_TOTAL_TIMEOUT' extends WarningCode
        ? ['RETRY_NO_TOTAL_TIMEOUT must never be reintroduced as a WarningCode member']
        : true;
      const neverReintroduced: _Check = true;
      expect(neverReintroduced).toBe(true);
    });
  });
});

describe('yaml-loader — issue #218 RETRY_INERT_NON_AUTO (bare retry sub-keys on a non-auto step)', () => {
  it('1. agent step, bare retry ⇒ advisory fires, message contains --schema-retries AND the embedder caveat', () => {
    const { warnings } = loadWorkflowFromStringWithDiagnostics(`
id: retry-inert-agent-wf
name: Retry Inert Agent
version: 1
steps:
  work:
    description: Work
    execution: agent
    retry:
      max_attempts: 3
      backoff: fixed
      base_delay_ms: 10
`);
    const w = warnings.find((warning) => warning.code === 'RETRY_INERT_NON_AUTO');
    expect(w).toBeDefined();
    expect(w?.message).toContain("execution: 'agent'");
    expect(w?.message).toContain('--schema-retries');
    expect(w?.message).toContain('embedder-supplied throwing dispatcher');
  });

  it('2. guard step, same block ⇒ fires, message does NOT contain --schema-retries', () => {
    const { warnings } = loadWorkflowFromStringWithDiagnostics(`
id: retry-inert-guard-wf
name: Retry Inert Guard
version: 1
steps:
  work:
    description: Work
    execution: guard
    abort_unless: ["work.ok == true"]
    retry:
      max_attempts: 3
      backoff: fixed
      base_delay_ms: 10
`);
    const w = warnings.find((warning) => warning.code === 'RETRY_INERT_NON_AUTO');
    expect(w).toBeDefined();
    expect(w?.message).toContain("execution: 'guard'");
    expect(w?.message).not.toContain('--schema-retries');
    expect(w?.message).toContain('embedder-supplied throwing dispatcher');
  });

  it("3. finalizer step, same block ⇒ load HARD-ERRORS with \"'retry' is not valid on execution: finalizer steps\" and no advisory is observable (composition pin; mirrors finalizer-loader.test.ts:99-106) — the issue's AC2 finalizer clause is satisfied by this PRE-EXISTING STRONGER rejection, not by the new advisory", () => {
    expectThrows(
      `
id: retry-inert-finalizer-wf
name: Retry Inert Finalizer
version: 1
steps:
  work:
    description: Work
    execution: auto
    handler: h
  cleanup:
    description: Cleanup finalizer
    execution: finalizer
    on_outcome: always
    handler: do_cleanup
    retry:
      max_attempts: 3
      backoff: fixed
      base_delay_ms: 10
`,
      "'retry' is not valid on execution: finalizer steps",
    );
  });

  it('4. auto step, same block ⇒ NO RETRY_INERT_NON_AUTO (and no W5)', () => {
    const { warnings } = loadWorkflowFromStringWithDiagnostics(`
id: retry-inert-auto-wf
name: Retry Inert Auto
version: 1
steps:
  work:
    description: Work
    execution: auto
    handler: h
    retry:
      max_attempts: 3
      backoff: fixed
      base_delay_ms: 10
`);
    expect(warnings.find((w) => w.code === 'RETRY_INERT_NON_AUTO')).toBeUndefined();
    expect(warnings.find((w) => w.code === 'TOTAL_TIMEOUT_NON_AUTO')).toBeUndefined();
  });

  describe('5. mutual-exclusivity pin, both directions', () => {
    it('non-auto + explicit cap ⇒ W5 fires AND RETRY_INERT_NON_AUTO does NOT', () => {
      const { warnings } = loadWorkflowFromStringWithDiagnostics(`
id: mutex-cap-wf
name: Mutex Cap
version: 1
steps:
  work:
    description: Work
    execution: agent
    retry:
      max_attempts: 3
      backoff: fixed
      base_delay_ms: 10
      total_timeout_seconds: 60
`);
      expect(warnings.find((w) => w.code === 'TOTAL_TIMEOUT_NON_AUTO')).toBeDefined();
      expect(warnings.find((w) => w.code === 'RETRY_INERT_NON_AUTO')).toBeUndefined();
    });

    it('non-auto + bare keys ⇒ RETRY_INERT_NON_AUTO fires AND W5 does NOT', () => {
      const { warnings } = loadWorkflowFromStringWithDiagnostics(`
id: mutex-bare-wf
name: Mutex Bare
version: 1
steps:
  work:
    description: Work
    execution: agent
    retry:
      max_attempts: 3
      backoff: fixed
      base_delay_ms: 10
`);
      expect(warnings.find((w) => w.code === 'RETRY_INERT_NON_AUTO')).toBeDefined();
      expect(warnings.find((w) => w.code === 'TOTAL_TIMEOUT_NON_AUTO')).toBeUndefined();
    });
  });

  it('6. strict-severity proof at the LOADER level: the code appears in warnings[] and resolveSeverity honors a policy override to error (the same array + policy mechanism validate/register --strict count on, already pinned code-agnostically by cli/src/commands/validate-strict.test.ts — no new CLI test added here)', () => {
    const { warnings } = loadWorkflowFromStringWithDiagnostics(`
id: strict-wf
name: Strict
version: 1
steps:
  work:
    description: Work
    execution: agent
    retry:
      max_attempts: 3
      backoff: fixed
      base_delay_ms: 10
`);
    const w = warnings.find((warning) => warning.code === 'RETRY_INERT_NON_AUTO');
    expect(w).toBeDefined();
    expect(w?.severity).toBe('warn');
    const strictPolicy: Record<WarningCode, 'warn' | 'error'> = {
      ...DEFAULT_POLICY,
      RETRY_INERT_NON_AUTO: 'error',
    };
    expect(resolveSeverity('RETRY_INERT_NON_AUTO', strictPolicy)).toBe('error');
    // create_workflow: NO test possible and none required — create_workflow never runs the YAML
    // loader at all (its envelope is findUnknownKeys-only; its stepSchema has no `retry` field, so
    // `retry` is dropped as UNKNOWN_CREATE_WORKFLOW_KEY before this code could ever run) — the
    // issue's AC3 "create_workflow stays lenient" holds BY CONSTRUCTION. See the report.
  });

  it('7. renderer golden test: RETRY_INERT_NON_AUTO renders message verbatim (the #169 renderLoaderWarning family pattern — no ⚠ prefix added, byte-identical to whatever constructed it)', () => {
    const warning: LoaderWarning = {
      code: 'RETRY_INERT_NON_AUTO',
      severity: 'warn',
      scope: 'step',
      step: 'work',
      message: "Step 'work': 'retry' is inert on execution: 'agent' steps.",
    };
    expect(renderLoaderWarning(warning)).toBe(warning.message);
  });
});
