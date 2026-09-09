// render-consistency-540.test.ts — the four laws issue #540's deletion (`line.replace(IGNORED_
// CLAUSE, REFUSED_CLAUSE)` at lib/loader-warnings.ts, removed) must uphold, now that every loader
// warning renders "— ignored" unmodified everywhere. See `plans/issue-540/design-d2.md` for the
// full adjudication and `prompts/ignored-clause-substitution-540.md` for REV 2's corrected law
// text (2 of the 4 laws below were false as first specified — see each law's own comment for what
// changed and why).
//
// Each law crosses TWO INDEPENDENT PRODUCERS: the core loader's structured `code`/`key` fields
// (read via `loadWorkflowFromStringWithDiagnostics` — fields no renderer writes) against the CLI's
// rendered text (`validateCommand`/`registerCommand` console output) and `renderEscalationLine`.
// Clause literals ("— ignored", "— REFUSED") are HARD-CODED here, never imported from
// `lib/loader-warnings.ts` — importing them is the self-licking pin this repo has been bitten by
// twice (a pin that imports the very constant it is meant to guard passes even when the guarded
// behavior is gone).
//
// Red-first on pristine main (before the #540 deletion), executed: exactly 4 reds —
// law1/validate-carry, law1/register-carry, law3/step-collision, law3/key-collision. Laws 2 and 4
// were already true on pristine main (they harden coverage, they do not fix a defect) — see the
// report for the observed set and how it was obtained.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadWorkflowFromStringWithDiagnostics } from '@sensigo/realm';
import type { LoaderWarning } from '@sensigo/realm';
import { validateCommand } from './validate.js';
import { registerCommand } from './register.js';
import { renderEscalationLine } from '../lib/loader-warnings.js';
import { clearProjectExtensionsCache } from '../extensions/load-project-extensions.js';

let dir: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  clearProjectExtensionsCache();
  dir = mkdtempSync(join(tmpdir(), 'realm-render-consistency-'));
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((): never => {
    throw new Error('process.exit');
  }) as never);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function write(content: string): string {
  const p = join(dir, 'workflow.yaml');
  writeFileSync(p, content, 'utf8');
  return p;
}

/** Every console.{log,warn,error} line from the last invocation, in call order per channel. */
function allLines(): string[] {
  return [logSpy, warnSpy, errSpy].flatMap((spy) =>
    spy.mock.calls.map((c: unknown[]) => String(c[0])),
  );
}

const warnedLines = (): string[] => warnSpy.mock.calls.map((c: unknown[]) => String(c[0]));
const errored = (): string => errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');

// =================================================================================================
// LAW 1 — no rendered line ever contains "— REFUSED" (issue #540).
//
// REV 2 correction: the prompt's first draft specified an IMPLICATION ("a line claiming refusal
// ⇒ errors names that key"), which was green on every fixture EXCEPT the carry one even BEFORE the
// fix — an implication with a false antecedent is vacuously true, so it has no teeth against
// reintroduction. The POSITIVE form below — no line anywhere contains the clause, full stop — has
// teeth on every path, because the substitution no longer exists to produce that clause at all.
//
// The hard-error carry is the scenario that made this law necessary: a workflow with an
// escalatable warning AND an UNRELATED hard error thrown from the same load. Pre-deletion,
// printLoaderWarnings still fired on `err.warnings` at the "hard load error carries the warnings
// channel" chokepoints (validate.ts's exitOnLoadFailure, register.ts's WorkflowError catch) and
// would have rewritten the unrelated warning's line to claim "REFUSED below" — false, since the
// refusal below is NOT that warning's escalation, it is the unrelated hard error.
// =================================================================================================

const CARRY_YAML = `
id: carry-540
name: Carry 540
version: 1
steps:
  classify:
    description: classify
    execution: agent
    dependson: [nowhere]
    timeout_seconds: 60
`;

describe('LAW 1 — no rendered line ever contains "— REFUSED" (issue #540)', () => {
  it('law1/validate-carry: the hard-error carry never claims a refusal that is not its own', async () => {
    const p = write(CARRY_YAML);

    await expect(validateCommand.parseAsync([p], { from: 'user' })).rejects.toThrow('process.exit');

    const lines = allLines();
    // Producer floor (REV 2): a law asserting an absence over an EMPTY set is vacuous. This
    // fixture must actually produce output for the assertion below to mean anything.
    expect(lines.length).toBeGreaterThan(0);
    // The hard error itself, unrelated to the warning — confirms this really is the carry case.
    expect(errored()).toContain("'timeout_seconds' is not valid on execution: agent steps");
    for (const line of lines) {
      expect(line).not.toContain('— REFUSED');
    }
  });

  it('law1/register-carry: same shape through register — err.warnings carried on a hard throw', async () => {
    mkdirSync(join(dir, '.realm', 'workflows'), { recursive: true });
    const originalHome = process.env['HOME'];
    process.env['HOME'] = dir;
    try {
      const p = write(CARRY_YAML);

      await expect(registerCommand.parseAsync([p], { from: 'user' })).rejects.toThrow(
        'process.exit',
      );

      const lines = allLines();
      expect(lines.length).toBeGreaterThan(0);
      expect(errored()).toContain("'timeout_seconds' is not valid on execution: agent steps");
      for (const line of lines) {
        expect(line).not.toContain('— REFUSED');
      }
    } finally {
      if (originalHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = originalHome;
    }
  });
});

// =================================================================================================
// LAW 2 — every policy-escalated warning is named by code+key in `errors`, SCOPED to the
// escalation path (`rejectIfPolicyEscalates` → `renderEscalationLine`).
//
// REV 2 correction: the prompt's first draft claimed this held EVERYWHERE. False — three arms
// bypass `rejectIfPolicyEscalates` entirely and print their own warnings plainly before a
// DIFFERENT, unrelated failure: the hard-error carry, the orphan-manifest refusal, and the
// extensions-load failure. On those three, `errors[0]` (or the human error line) is about the
// unrelated cause, and NEVER names the escalated key — the cost issue #540 pays for deleting the
// substitution (tracked as issue #544, not fixed here). This law's own novelty, honestly stated,
// is the EXHAUSTIVE-over-escalated quantifier ("every", not "the one this fixture picked") — a
// mutant dropping the key from `renderEscalationLine` already reds 7 pre-existing cells elsewhere
// in this package, so the underlying mechanism was never in question.
// =================================================================================================

describe('LAW 2 — every policy-escalated warning is named by code+key in errors, scoped to the escalation path (issue #540)', () => {
  it('the boundary-refusal path names EVERY escalated warning, not just the first', async () => {
    // Two escalatable typos at once — a workflow-level key and a step-level key — so "every" is
    // load-bearing: a law that only drove one warning could not tell "names the escalated warning"
    // from "names the first warning".
    const p = write(`
id: multi-540
name: Multi 540
descriptoin: typo at workflow scope
version: 1
steps:
  s1:
    description: a step
    execution: auto
    dependson: [nothing]
`);
    const { warnings } = loadWorkflowFromStringWithDiagnostics(
      `
id: multi-540
name: Multi 540
descriptoin: typo at workflow scope
version: 1
steps:
  s1:
    description: a step
    execution: auto
    dependson: [nothing]
`,
    );
    const escalated = warnings.filter(
      (w) => w.code === 'UNKNOWN_WORKFLOW_KEY' || w.code === 'UNKNOWN_STEP_KEY',
    );
    expect(escalated).toHaveLength(2); // non-vacuity: the fixture really produces two

    await expect(validateCommand.parseAsync([p], { from: 'user' })).rejects.toThrow('process.exit');

    for (const w of escalated) {
      expect(errored()).toContain(`${w.code} '${w.key ?? ''}'`);
    }
    // Cross-checked against the shared renderer directly, not just the command's own output.
    expect(renderEscalationLine(warnings)).toContain(`UNKNOWN_WORKFLOW_KEY 'descriptoin'`);
    expect(renderEscalationLine(warnings)).toContain(`UNKNOWN_STEP_KEY 'dependson'`);
  });

  it('EXCLUSION 1 — the hard-error carry: errors never name the escalated key (issue #544)', async () => {
    // This fixture's own hard error THROWS even off the WithDiagnostics loader — only printing is
    // suppressed, not the throw — so the accumulated warnings are read off the caught error's
    // `.warnings` (issue #424's carry mechanism), the same field the CLI's own catch reads.
    let escalatedKey: string | undefined;
    try {
      loadWorkflowFromStringWithDiagnostics(CARRY_YAML);
      expect.unreachable('the carry fixture must throw');
    } catch (err) {
      const warnings = (err as { warnings?: LoaderWarning[] }).warnings ?? [];
      escalatedKey = warnings.find((w) => w.code === 'UNKNOWN_STEP_KEY')?.key;
    }
    expect(escalatedKey).toBe('dependson'); // non-vacuity: confirms the escalation really happened

    const p = write(CARRY_YAML);
    await expect(validateCommand.parseAsync([p], { from: 'user' })).rejects.toThrow('process.exit');

    // The escalation gate (rejectIfPolicyEscalates) never ran on this arm — validate.ts's
    // exitOnLoadFailure classifies the hard error first. `errored()` names the UNRELATED cause,
    // never the warning's own key.
    expect(errored()).toContain("'timeout_seconds' is not valid on execution: agent steps");
    expect(errored()).not.toContain('dependson');
    expect(errored()).not.toContain('escalated to an error by policy');
  });

  it('EXCLUSION 2 — the orphaned-manifest refusal: errors never name the escalated key', async () => {
    const workflowDir = join(dir, 'workflows', 'wf');
    mkdirSync(workflowDir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
    writeFileSync(
      join(workflowDir, 'realm.yaml'),
      'version: 1\nadapters:\n  fs2:\n    use: filesystem\n',
      'utf8',
    );
    const workflowPath = join(workflowDir, 'workflow.yaml');
    writeFileSync(
      workflowPath,
      `id: orphan-540
name: Orphan 540
version: 1
steps:
  s1:
    description: a step
    execution: agent
    dependson: [nothing]
`,
      'utf8',
    );

    await expect(validateCommand.parseAsync([workflowPath], { from: 'user' })).rejects.toThrow(
      'process.exit',
    );

    expect(errored()).toContain('will NOT be loaded');
    expect(errored()).not.toContain('dependson');
    expect(errored()).not.toContain('escalated to an error by policy');
  });

  it('EXCLUSION 3 — the extensions-load failure: errors never name the escalated key', async () => {
    const workflowDir = join(dir, 'workflows', 'wf');
    mkdirSync(join(dir, 'dist'), { recursive: true });
    mkdirSync(workflowDir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
    const workflowPath = join(workflowDir, 'workflow.yaml');
    writeFileSync(
      workflowPath,
      `id: extfail-540
name: Extfail 540
version: 1
steps:
  s1:
    description: a step
    execution: agent
    dependson: [nothing]
extensions: ../../dist/does-not-exist.js
`,
      'utf8',
    );

    await expect(validateCommand.parseAsync([workflowPath], { from: 'user' })).rejects.toThrow(
      'process.exit',
    );

    expect(errored()).toContain('Error loading extensions:');
    expect(errored()).not.toContain('dependson');
    expect(errored()).not.toContain('escalated to an error by policy');
  });
});

// =================================================================================================
// LAW 3 — the author's key/step bytes appear VERBATIM in every line that speaks about them.
//
// Audit-verified permanently non-vacuous: this is the only cell that would notice a future
// substring-anchored render doing to THIS class what the deleted substitution did — a first-
// occurrence, unanchored `.replace()` over the whole rendered line corrupts whichever occurrence
// of its anchor text comes first, author-controlled or not (issue #525 item 1). Both fixtures
// below put "— ignored" — the deleted substitution's own anchor — INSIDE author-controlled text,
// so on pristine main the mint's real trailing "— ignored" clause is the SECOND occurrence: a
// naive `.replace()` hits the author's text first, corrupting it, and leaves the real clause
// unmodified (doubly wrong — the wrong text is rewritten, and the true clause is never rewritten
// at all). After the deletion, nothing rewrites either occurrence.
// =================================================================================================

describe("LAW 3 — the author's key/step bytes appear verbatim in every line that speaks about them (issue #540)", () => {
  it('law3/step-collision: a step whose own name contains "— ignored" renders untouched', async () => {
    const yaml = `
id: collision-540a
name: Collision 540a
version: 1
steps:
  "weird — ignored step":
    description: a step
    execution: auto
    dependson: [nothing]
`;
    const { warnings } = loadWorkflowFromStringWithDiagnostics(yaml);
    expect(warnings.length).toBeGreaterThan(0); // producer floor

    const p = write(yaml);
    await expect(validateCommand.parseAsync([p], { from: 'user' })).rejects.toThrow('process.exit');

    const lines = warnedLines();
    expect(lines.length).toBeGreaterThan(0);
    const line = lines.find((l) => l.includes('unknown key'));
    expect(line).toBeDefined();
    // The step name is a SINGLE, unmangled unit — not split by a stray substitution.
    expect(line).toContain("step 'weird — ignored step': unknown key 'dependson'");
  });

  it('law3/key-collision: an unknown key whose own name contains "— ignored" renders untouched', async () => {
    const yaml = `
id: collision-540b
name: Collision 540b
version: 1
steps:
  s1:
    description: a step
    execution: auto
    "weird — ignored key": true
`;
    const { warnings } = loadWorkflowFromStringWithDiagnostics(yaml);
    expect(warnings.length).toBeGreaterThan(0); // producer floor

    const p = write(yaml);
    await expect(validateCommand.parseAsync([p], { from: 'user' })).rejects.toThrow('process.exit');

    const lines = warnedLines();
    expect(lines.length).toBeGreaterThan(0);
    const line = lines.find((l) => l.includes('unknown key'));
    expect(line).toBeDefined();
    expect(line).toContain("unknown key 'weird — ignored key'");
  });
});

// =================================================================================================
// LAW 4 — exit 1 ⟺ (errors non-empty ∨ strict.failed) — NOT `errors non-empty ⟺ exit 1`.
//
// REV 2 correction: the biconditional-on-errors form is FALSE — `--strict` on a warning-only
// workflow gives `valid:true`, `errors:[]`, `strict.failed:true`, and still exits 1. The
// "advisory + --strict" cell is named explicitly (not left to be true only by whichever fixture
// happened to be picked) so this law cannot silently narrow back to the false form.
// =================================================================================================

describe('LAW 4 — exit 1 iff (errors non-empty or strict.failed) (issue #540)', () => {
  it('advisory + --strict: errors EMPTY, strict.failed TRUE, exit 1 anyway', async () => {
    const p = write(`
id: advisory-540
name: Advisory 540
version: 1
steps:
  s1:
    description: a step
    execution: auto
    retry:
      max_attempts: 3
      backoff: fixed
      base_delay_ms: 10
`);

    await expect(
      validateCommand.parseAsync([p, '--strict', '--json'], { from: 'user' }),
    ).rejects.toThrow('process.exit');

    const result = JSON.parse(String(logSpy.mock.calls[0]![0])) as {
      valid: boolean;
      errors: string[];
      strict: { requested: boolean; failed: boolean };
    };
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.strict).toEqual({ requested: true, failed: true });
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('escalated, no --strict: errors NON-EMPTY, strict never requested, exit 1', async () => {
    const p = write(`
id: escalated-540
name: Escalated 540
version: 1
steps:
  s1:
    description: a step
    execution: auto
    dependson: [nothing]
`);

    await expect(validateCommand.parseAsync([p, '--json'], { from: 'user' })).rejects.toThrow(
      'process.exit',
    );

    const result = JSON.parse(String(logSpy.mock.calls[0]![0])) as {
      valid: boolean;
      errors: string[];
      strict: { requested: boolean; failed: boolean };
    };
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.strict).toEqual({ requested: false, failed: false });
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('clean: errors empty, strict not requested, exit 0', async () => {
    const p = write(`
id: clean-540
name: Clean 540
version: 1
steps:
  s1:
    description: a step
    execution: auto
`);

    await validateCommand.parseAsync([p, '--json'], { from: 'user' });

    const result = JSON.parse(String(logSpy.mock.calls[0]![0])) as {
      valid: boolean;
      errors: string[];
      strict: { requested: boolean; failed: boolean };
    };
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.strict).toEqual({ requested: false, failed: false });
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
