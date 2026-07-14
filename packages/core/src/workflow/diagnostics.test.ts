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
  it('every DEFAULT_POLICY entry is "warn" today (no code is pre-flipped)', () => {
    for (const severity of Object.values(DEFAULT_POLICY)) {
      expect(severity).toBe('warn');
    }
  });

  it('resolveSeverity looks up the default policy when none is given', () => {
    expect(resolveSeverity('UNKNOWN_WORKFLOW_KEY')).toBe('warn');
    expect(resolveSeverity('UNKNOWN_STEP_KEY')).toBe('warn');
    expect(resolveSeverity('UNKNOWN_CREATE_WORKFLOW_KEY')).toBe('warn');
  });

  it('resolveSeverity honors an explicit policy override', () => {
    const policy = { ...DEFAULT_POLICY, UNKNOWN_STEP_KEY: 'error' as const };
    expect(resolveSeverity('UNKNOWN_STEP_KEY', policy)).toBe('error');
    // Unaffected codes in the same override stay at their DEFAULT_POLICY value.
    expect(resolveSeverity('UNKNOWN_WORKFLOW_KEY', policy)).toBe('warn');
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
      expect(w.severity).toBe('warn');
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
