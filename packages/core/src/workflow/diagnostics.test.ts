// diagnostics.test.ts — golden-format + did_you_mean coverage for the structured loader-warning
// channel (issue #169). This is the regression guard once the 4 loader console.warn sites moved
// to renderLoaderWarning-based printing wrappers: any change to the rendered text must show up
// here first.
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_POLICY,
  resolveSeverity,
  findUnknownKeys,
  renderLoaderWarning,
  type LoaderWarning,
} from './diagnostics.js';

describe('DEFAULT_POLICY / resolveSeverity', () => {
  it('exactly two codes are "error" — the issue #170 flip, and nothing rode along with it', () => {
    // Written as a whole-table assertion rather than two spot checks: the risk this guards is a
    // THIRD code quietly acquiring 'error' severity, which no per-code test would ever see.
    const errored = Object.entries(DEFAULT_POLICY)
      .filter(([, severity]) => severity === 'error')
      .map(([code]) => code)
      .sort();
    expect(errored).toEqual(['UNKNOWN_STEP_KEY', 'UNKNOWN_WORKFLOW_KEY']);
  });

  it('resolveSeverity looks up the default policy when none is given', () => {
    expect(resolveSeverity('UNKNOWN_WORKFLOW_KEY')).toBe('error');
    expect(resolveSeverity('UNKNOWN_STEP_KEY')).toBe('error');
    // create_workflow stays lenient for agents FOREVER — a permanent design decision, not a code
    // the next flip is expected to reach. This is the negative half of #170.
    expect(resolveSeverity('UNKNOWN_CREATE_WORKFLOW_KEY')).toBe('warn');
  });

  it('resolveSeverity honors an explicit policy override', () => {
    // Driven on a code #170 did NOT flip, so the override is what makes it 'error' — on a
    // flipped code the assertion would pass without the override doing anything.
    const policy = { ...DEFAULT_POLICY, DUAL_SCHEMA_DECLARED: 'error' as const };
    expect(resolveSeverity('DUAL_SCHEMA_DECLARED', policy)).toBe('error');
    expect(resolveSeverity('DUAL_SCHEMA_DECLARED')).toBe('warn');
    // Unaffected codes in the same override keep their DEFAULT_POLICY value, which the spread
    // now carries as 'error' for the two flipped ones.
    expect(resolveSeverity('UNKNOWN_WORKFLOW_KEY', policy)).toBe('error');
    expect(resolveSeverity('RETRY_NO_TIMEOUT', policy)).toBe('warn');
  });
});

describe('findUnknownKeys', () => {
  const ALLOW_LIST = ['description', 'execution', 'depends_on', 'input_schema'] as const;

  it('returns one LoaderWarning per own-key not in the allow-list', () => {
    const warnings = findUnknownKeys(
      { description: 'x', execution: 'auto', rogue_key: 1, another_rogue: 2 },
      ALLOW_LIST,
      { scope: 'step', code: 'UNKNOWN_STEP_KEY', step: 'my-step' },
    );
    expect(warnings).toHaveLength(2);
    expect(warnings.map((w) => w.key).sort()).toEqual(['another_rogue', 'rogue_key']);
    for (const w of warnings) {
      expect(w.code).toBe('UNKNOWN_STEP_KEY');
      // Resolved at construction against DEFAULT_POLICY, so the #170 flip reaches the structured
      // warning itself, not only the boundary that reads it.
      expect(w.severity).toBe('error');
      expect(w.scope).toBe('step');
      expect(w.step).toBe('my-step');
    }
  });

  it('returns an empty array when every key is in the allow-list', () => {
    const warnings = findUnknownKeys({ description: 'x', execution: 'auto' }, ALLOW_LIST, {
      scope: 'step',
      code: 'UNKNOWN_STEP_KEY',
      step: 'my-step',
    });
    expect(warnings).toEqual([]);
  });

  it('did_you_mean: "dependson" (missing underscore) suggests "depends_on"', () => {
    const warnings = findUnknownKeys({ dependson: ['a'] }, ALLOW_LIST, {
      scope: 'step',
      code: 'UNKNOWN_STEP_KEY',
      step: 'my-step',
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.did_you_mean).toBe('depends_on');
  });

  it('did_you_mean: a far/unrelated key ("produces_state") suggests nothing', () => {
    const warnings = findUnknownKeys({ produces_state: 'done' }, ALLOW_LIST, {
      scope: 'step',
      code: 'UNKNOWN_STEP_KEY',
      step: 'my-step',
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.did_you_mean).toBeUndefined();
  });

  it('workflow-scope warnings carry id, not step', () => {
    const warnings = findUnknownKeys({ rogue: 1 }, ['id', 'name'], {
      scope: 'workflow',
      code: 'UNKNOWN_WORKFLOW_KEY',
      id: 'my-workflow',
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.id).toBe('my-workflow');
    expect(warnings[0]!.step).toBeUndefined();
  });
});

describe('renderLoaderWarning — golden format', () => {
  it('UNKNOWN_WORKFLOW_KEY, no suggestion', () => {
    const w: LoaderWarning = {
      code: 'UNKNOWN_WORKFLOW_KEY',
      severity: 'warn',
      scope: 'workflow',
      id: 'my-wf',
      key: 'produces_state',
      message:
        "workflow 'my-wf': unknown key 'produces_state' — ignored (not a recognized workflow field).",
    };
    expect(renderLoaderWarning(w)).toBe(
      "⚠ workflow 'my-wf': unknown key 'produces_state' — ignored (not a recognized workflow field).",
    );
  });

  it('UNKNOWN_STEP_KEY, did_you_mean form', () => {
    const warnings = findUnknownKeys({ dependson: ['a'] }, ['depends_on'], {
      scope: 'step',
      code: 'UNKNOWN_STEP_KEY',
      step: 'my-step',
    });
    expect(renderLoaderWarning(warnings[0]!)).toBe(
      "⚠ step 'my-step': unknown key 'dependson' — ignored (did you mean 'depends_on'?)",
    );
  });

  it('UNKNOWN_RETRY_KEY (issue #140) renders with the "retry" noun, not "step" or "workflow"', () => {
    const warnings = findUnknownKeys({ rogue_field: 1 }, ['max_attempts', 'on_timeout'], {
      scope: 'step',
      code: 'UNKNOWN_RETRY_KEY',
      step: 'my-step',
      noun: 'retry',
    });
    expect(renderLoaderWarning(warnings[0]!)).toBe(
      "⚠ step 'my-step': unknown key 'rogue_field' — ignored (not a recognized retry field).",
    );
  });

  it('UNKNOWN_RETRY_KEY did_you_mean still resolves against the passed-in retry allow-list', () => {
    const warnings = findUnknownKeys({ on_timout: true }, ['on_timeout', 'max_attempts'], {
      scope: 'step',
      code: 'UNKNOWN_RETRY_KEY',
      step: 'my-step',
      noun: 'retry',
    });
    expect(renderLoaderWarning(warnings[0]!)).toBe(
      "⚠ step 'my-step': unknown key 'on_timout' — ignored (did you mean 'on_timeout'?)",
    );
  });

  it('UNKNOWN_CREATE_WORKFLOW_KEY renders the same templated shape as UNKNOWN_STEP_KEY', () => {
    const warnings = findUnknownKeys({ rogue_field: 1 }, ['id', 'description'], {
      scope: 'step',
      code: 'UNKNOWN_CREATE_WORKFLOW_KEY',
      step: 'step-a',
    });
    expect(renderLoaderWarning(warnings[0]!)).toBe(
      "⚠ step 'step-a': unknown key 'rogue_field' — ignored (not a recognized step field).",
    );
  });

  it('IDEMPOTENT_INERT_IN_FINALIZER and DUAL_SCHEMA_DECLARED render message verbatim — no ⚠ prefix added (byte-identical to the pre-#169 text)', () => {
    const idempotentWarning: LoaderWarning = {
      code: 'IDEMPOTENT_INERT_IN_FINALIZER',
      severity: 'warn',
      scope: 'step',
      step: 'my-step',
      message:
        "Step 'my-step': 'idempotent: true' is inert in a finalizer-bearing workflow (its claim " +
        "carries no deadline, so 'realm run reclaim --all' can never select it). Recover it with " +
        "'realm run reclaim --step my-step --force'.",
    };
    expect(renderLoaderWarning(idempotentWarning)).toBe(idempotentWarning.message);
    expect(renderLoaderWarning(idempotentWarning)).not.toMatch(/^⚠/);

    const dualSchemaWarning: LoaderWarning = {
      code: 'DUAL_SCHEMA_DECLARED',
      severity: 'warn',
      scope: 'step',
      step: 'my-step',
      message:
        "Step 'my-step': declares both input_schema and output_schema; the agent's submitted " +
        'output is validated against both — prefer one to avoid divergence.',
    };
    expect(renderLoaderWarning(dualSchemaWarning)).toBe(dualSchemaWarning.message);
    expect(renderLoaderWarning(dualSchemaWarning)).not.toMatch(/^⚠/);
  });

  it('RETRY_NO_TIMEOUT and EXTENSION_SENTINEL render message verbatim — their own ⚠  (two-space) prefix is baked into message, not added here', () => {
    const retryWarning: LoaderWarning = {
      code: 'RETRY_NO_TIMEOUT',
      severity: 'warn',
      scope: 'step',
      step: 'my-step',
      message:
        "⚠  Step 'my-step': declares 'retry' but no 'timeout_seconds' — each attempt is bounded.",
    };
    expect(renderLoaderWarning(retryWarning)).toBe(retryWarning.message);

    const sentinelWarning: LoaderWarning = {
      code: 'EXTENSION_SENTINEL',
      severity: 'warn',
      scope: 'workflow',
      message: '⚠  Using sentinel credentials for adapter X.',
    };
    expect(renderLoaderWarning(sentinelWarning)).toBe(sentinelWarning.message);
  });
});
