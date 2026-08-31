// issue #444 — the CLI half of the one-grammar law.
//
// The `⚠ ` prefix belongs to `renderLoaderWarning` alone. That only holds if every producer hands
// it a bare message, so each producer has a hygiene cell asserting exactly that — and the
// composition cell below proves the whole chain emits ONE prefix, not two and not none.
import { describe, it, expect } from 'vitest';
import { printLoaderWarnings, wrapSentinelWarnings } from './loader-warnings.js';
import { resolveSeverity } from '@sensigo/realm';
import type { LoaderWarning } from '@sensigo/realm';
import { vi } from 'vitest';

describe('wrapSentinelWarnings — mint hygiene (issue #444)', () => {
  it('carries the input message verbatim, with no prefix of its own', () => {
    // It used to bake `⚠  ` (two spaces) here, in two byte-identical private copies. With the
    // renderer prefixing unconditionally, a baked prefix would render `⚠ ⚠  …` — the #417
    // double-prefix class. This cell is what reds if someone re-bakes it.
    const input = 'Using sentinel credentials for adapter X.';
    const [warning] = wrapSentinelWarnings([input]);

    expect(warning).toBeDefined();
    expect(warning!.message).toBe(input);
    expect(warning!.message).not.toMatch(/^⚠/);
    expect(warning!.code).toBe('EXTENSION_SENTINEL');
    expect(warning!.severity).toBe(resolveSeverity('EXTENSION_SENTINEL'));
  });

  it('an absent list yields no warnings', () => {
    expect(wrapSentinelWarnings(undefined)).toEqual([]);
  });
});

describe('printLoaderWarnings — one prefix, exactly (issue #444)', () => {
  it('renders an advisory warning with a single-space ⚠ and nothing doubled', () => {
    // COVERAGE, stated so nobody mistakes this cell's reach: it reds when the renderer drops the
    // prefix AND when the renderer doubles it — it is the only whole-line render pin. It is
    // structurally BLIND to a MINT-level re-bake, because it builds a literal fixture and never
    // calls a producer. That direction belongs to the per-mint hygiene cells.
    const warning: LoaderWarning = {
      code: 'RETRY_NO_TIMEOUT',
      severity: 'warn',
      scope: 'step',
      step: 'work',
      message: "Step 'work': declares 'retry' but no 'timeout_seconds' — each attempt is bounded.",
    };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    printLoaderWarnings([warning]);

    const lines = warnSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(lines).toEqual([
      "⚠ Step 'work': declares 'retry' but no 'timeout_seconds' — each attempt is bounded.",
    ]);
    vi.restoreAllMocks();
  });
});
