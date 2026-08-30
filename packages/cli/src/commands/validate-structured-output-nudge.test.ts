// issue #236, Deliverable 7 — the structured_output adoption nudge on validate's own INFO
// channel. In-process via commander's parseAsync (validate-retry-timeout-advisory.test.ts's own
// precedent) — no subprocess/dist rebuild needed to observe console.log output.
//
// issue #422 reshaped it: one graded summary line by default, the full per-step detail behind
// `--explain`, `REALM_NO_NUDGE=1` to silence the summary, and an opted-in step's caveats loud
// under every combination of the two. The four per-item cells below are therefore now `--explain`
// cells asserting the SAME strings — the detail moved, it did not change.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateCommand } from './validate.js';

/** The tail every summary line carries — spelled once so a cell pins the whole sentence. */
const TAIL = " — run 'realm workflow validate --explain' for detail (REALM_NO_NUDGE=1 to silence).";

describe('validate — structured_output nudge (issue #236)', () => {
  let dir: string;
  let savedNoNudge: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'realm-validate-so-nudge-'));
    // An operator with REALM_NO_NUDGE=1 exported in their shell would otherwise red every
    // default-run summary cell in this file. Saved and cleared per cell; cells that need it set
    // it themselves.
    savedNoNudge = process.env['REALM_NO_NUDGE'];
    delete process.env['REALM_NO_NUDGE'];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
    if (savedNoNudge === undefined) delete process.env['REALM_NO_NUDGE'];
    else process.env['REALM_NO_NUDGE'] = savedNoNudge;
  });

  /** The summary is the only line starting `ℹ` on a default run — this returns those lines. */
  function infoLines(logSpy: { mock: { calls: unknown[][] } }): string[] {
    return logSpy.mock.calls
      .flat()
      .map(String)
      .flatMap((s) => s.split('\n'))
      .filter((l) => l.startsWith('ℹ'));
  }

  function write(yaml: string): string {
    const wfPath = join(dir, 'workflow.yaml');
    writeFileSync(wfPath, yaml, 'utf8');
    return wfPath;
  }

  it('a NOT-opted-in ineligible schema prints the exact migration remediation, and does NOT fail --strict', async () => {
    const wfPath = write(`
id: nudge-ineligible
name: Nudge Ineligible
version: 1
steps:
  classify:
    description: classify
    execution: agent
    output_schema:
      type: object
      required: [category]
      properties:
        category: { type: string }
`);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as never);

    await validateCommand.parseAsync([wfPath, '--strict', '--explain'], { from: 'user' });

    const logged = logSpy.mock.calls.flat().map(String).join('\n');
    expect(logged).toContain("Step 'classify'");
    expect(logged).toContain('one line short');
    expect(logged).toContain('additionalProperties: false');
    expect(exitSpy).not.toHaveBeenCalled(); // the nudge never affects --strict's exit code
  });

  it('a NOT-opted-in eligible_with_caveats schema prints the caveat remediation', async () => {
    const wfPath = write(`
id: nudge-caveat
name: Nudge Caveat
version: 1
steps:
  classify:
    description: classify
    execution: agent
    output_schema:
      type: object
      additionalProperties: false
      required: [category]
      properties:
        category: { type: string, pattern: "^[a-z]+$" }
`);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await validateCommand.parseAsync([wfPath, '--explain'], { from: 'user' });

    const logged = logSpy.mock.calls.flat().map(String).join('\n');
    expect(logged).toContain("Step 'classify'");
    expect(logged).toContain('eligible for structured_output: strict, with caveat');
  });

  it('an eligible schema with an optional reasoning-like property names the instance', async () => {
    const wfPath = write(`
id: nudge-reasoning
name: Nudge Reasoning
version: 1
steps:
  classify:
    description: classify
    execution: agent
    output_schema:
      type: object
      additionalProperties: false
      required: [category]
      properties:
        category: { type: string }
        reasoning: { type: string }
`);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await validateCommand.parseAsync([wfPath, '--explain'], { from: 'user' });

    const logged = logSpy.mock.calls.flat().map(String).join('\n');
    expect(logged).toContain("the optional 'reasoning' property looks like a reasoning field");
  });

  it('an already-opted-in step with caveats prints its OWN caveat wording (not the "eligible for" migration framing)', async () => {
    const wfPath = write(`
id: nudge-opted
name: Nudge Opted
version: 1
steps:
  classify:
    description: classify
    execution: agent
    structured_output: strict
    output_schema:
      type: object
      additionalProperties: false
      required: [category]
      properties:
        category: { type: string, pattern: "^[a-z]+$" }
`);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await validateCommand.parseAsync([wfPath], { from: 'user' });

    const logged = logSpy.mock.calls.flat().map(String).join('\n');
    expect(logged).toContain("Step 'classify': structured_output caveat");
    expect(logged).not.toContain('eligible for structured_output: strict, with caveat');
    // issue #422: an all-opted-in file mints NO summary line — opted-in steps are excluded from
    // the census entirely, which is a third route to no-line, distinct from "nothing eligible"
    // and from the env silencer.
    expect(logged).not.toMatch(/^ℹ \d+ steps?/m);

    // And the diagnostic is never silenced: it is advice about config the author DECLARED.
    logSpy.mockClear();
    process.env['REALM_NO_NUDGE'] = '1';
    await validateCommand.parseAsync([wfPath], { from: 'user' });
    const silenced = logSpy.mock.calls.flat().map(String).join('\n');
    expect(silenced).toContain("Step 'classify': structured_output caveat");
  });

  it('a fully-required (zero-optional), eligible, NOT-opted-in schema prints the opt-in suggestion — never a bare "eligible"', async () => {
    const wfPath = write(`
id: nudge-bare-eligible
name: Nudge Bare Eligible
version: 1
steps:
  classify:
    description: classify
    execution: agent
    output_schema:
      type: object
      additionalProperties: false
      required: [category]
      properties:
        category: { type: string }
`);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await validateCommand.parseAsync([wfPath, '--explain'], { from: 'user' });

    const logged = logSpy.mock.calls.flat().map(String).join('\n');
    expect(logged).toContain("add 'structured_output: strict' to opt in");
    // Never a bare standalone "eligible" line with nothing else.
    expect(logged).not.toMatch(/Step 'classify': eligible\.?\s*$/m);
  });

  it('a step with no schema at all is silently skipped (nothing to nudge)', async () => {
    const wfPath = write(`
id: nudge-no-schema
name: Nudge No Schema
version: 1
steps:
  work:
    description: work
    execution: agent
`);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await validateCommand.parseAsync([wfPath], { from: 'user' });

    const logged = logSpy.mock.calls.flat().map(String).join('\n');
    expect(logged).not.toContain('structured_output');
    expect(infoLines(logSpy)).toEqual([]); // and no summary line either (issue #422)
  });

  it('an auto step (non-agent) is never nudged, even with an output_schema-shaped input_schema present', async () => {
    const wfPath = write(`
id: nudge-auto-skip
name: Nudge Auto Skip
version: 1
steps:
  work:
    description: work
    execution: auto
    input_schema:
      type: object
      properties:
        x: { type: string }
`);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await validateCommand.parseAsync([wfPath], { from: 'user' });

    const logged = logSpy.mock.calls.flat().map(String).join('\n');
    expect(logged).not.toContain('structured_output');
    expect(infoLines(logSpy)).toEqual([]); // and no summary line either (issue #422)
  });

  // ===============================================================================================
  // issue #422 — the summary line
  //
  // Every cell below pins the WHOLE rendered sentence with `toBe`, not a substring. A substring
  // assertion cannot see a sentence's subject, so a clause rendered against the wrong count would
  // pass one (the #420 lesson).
  // ===============================================================================================

  it('(a) mixed: 2 ready (1 caveated) + 1 ineligible renders every clause, each pluralized on its own count', async () => {
    const wfPath = write(`
id: nudge-mixed
name: Nudge Mixed
version: 1
steps:
  ready_bare:
    description: ready bare
    execution: agent
    output_schema:
      type: object
      additionalProperties: false
      required: [category]
      properties:
        category: { type: string }
  ready_caveated:
    description: ready caveated
    execution: agent
    output_schema:
      type: object
      additionalProperties: false
      required: [category]
      properties:
        category: { type: string, pattern: "^[a-z]+$" }
  not_eligible:
    description: not eligible
    execution: agent
    output_schema:
      type: object
      required: [category]
      properties:
        category: { type: string }
`);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await validateCommand.parseAsync([wfPath], { from: 'user' });

    expect(infoLines(logSpy)).toEqual([
      'ℹ 2 steps ready for structured_output: strict (1 with caveats), 1 step one change away' +
        TAIL,
    ]);
  });

  it('(b) ready-only, no caveats: no parenthetical and no "one change away" clause', async () => {
    const wfPath = write(`
id: nudge-ready-only
name: Nudge Ready Only
version: 1
steps:
  a:
    description: a
    execution: agent
    output_schema:
      type: object
      additionalProperties: false
      required: [category]
      properties:
        category: { type: string }
  b:
    description: b
    execution: agent
    output_schema:
      type: object
      additionalProperties: false
      required: [name]
      properties:
        name: { type: string }
`);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await validateCommand.parseAsync([wfPath], { from: 'user' });

    // A zero-valued clause is omitted, never rendered as "(0 with caveats)".
    expect(infoLines(logSpy)).toEqual(['ℹ 2 steps ready for structured_output: strict' + TAIL]);
  });

  it('(c) ineligible-only: the R=0 form reads "one change away FROM"', async () => {
    const wfPath = write(`
id: nudge-ineligible-only
name: Nudge Ineligible Only
version: 1
steps:
  a:
    description: a
    execution: agent
    output_schema:
      type: object
      required: [category]
      properties:
        category: { type: string }
  b:
    description: b
    execution: agent
    output_schema:
      type: object
      required: [name]
      properties:
        name: { type: string }
`);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await validateCommand.parseAsync([wfPath], { from: 'user' });

    expect(infoLines(logSpy)).toEqual([
      'ℹ 2 steps one change away from structured_output: strict' + TAIL,
    ]);
  });

  it('(d) singular: one step reads "1 step", not "1 steps"', async () => {
    const wfPath = write(`
id: nudge-singular
name: Nudge Singular
version: 1
steps:
  a:
    description: a
    execution: agent
    output_schema:
      type: object
      required: [category]
      properties:
        category: { type: string }
`);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await validateCommand.parseAsync([wfPath], { from: 'user' });

    expect(infoLines(logSpy)).toEqual([
      'ℹ 1 step one change away from structured_output: strict' + TAIL,
    ]);
  });

  it('(k) the "one change away" clause is independent of the caveats parenthetical', async () => {
    // The bug this exists for: gating the I-clause on C > 0. Every other summary cell passes
    // under that mistake, because every other one has either C > 0 or I = 0.
    const wfPath = write(`
id: nudge-bare-plus-ineligible
name: Nudge Bare Plus Ineligible
version: 1
steps:
  a:
    description: a
    execution: agent
    output_schema:
      type: object
      additionalProperties: false
      required: [category]
      properties:
        category: { type: string }
  b:
    description: b
    execution: agent
    output_schema:
      type: object
      additionalProperties: false
      required: [name]
      properties:
        name: { type: string }
  c:
    description: c
    execution: agent
    output_schema:
      type: object
      required: [other]
      properties:
        other: { type: string }
`);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await validateCommand.parseAsync([wfPath], { from: 'user' });

    expect(infoLines(logSpy)).toEqual([
      'ℹ 2 steps ready for structured_output: strict, 1 step one change away' + TAIL,
    ]);
  });

  it('(h) a mixed opted-in/not-opted-in file prints BOTH surfaces, and the env var silences only the summary', async () => {
    // The census-exclusion pin. An implementation that suppressed the summary whenever any step
    // is opted in, or that leaked the opted-in step into R/C/I, reds exactly here.
    const wfPath = write(`
id: nudge-mixed-optin
name: Nudge Mixed OptIn
version: 1
steps:
  declared:
    description: declared
    execution: agent
    structured_output: strict
    output_schema:
      type: object
      additionalProperties: false
      required: [category]
      properties:
        category: { type: string, pattern: "^[a-z]+$" }
  candidate:
    description: candidate
    execution: agent
    output_schema:
      type: object
      required: [other]
      properties:
        other: { type: string }
`);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await validateCommand.parseAsync([wfPath], { from: 'user' });

    const lines = infoLines(logSpy);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(
      "ℹ Step 'declared': structured_output caveat — 'pattern' at 'properties.category' is " +
        "silently ignored or rejected by the API — enforced post-hoc by realm's own validation only",
    );
    // The opted-in step is NOT counted: 1 step one change away, not 2 of anything.
    expect(lines[1]).toBe('ℹ 1 step one change away from structured_output: strict' + TAIL);

    // Under the silencer the declared-config diagnostic stays and only the summary goes.
    logSpy.mockClear();
    process.env['REALM_NO_NUDGE'] = '1';
    await validateCommand.parseAsync([wfPath], { from: 'user' });
    const silenced = infoLines(logSpy);
    expect(silenced).toHaveLength(1);
    expect(silenced[0]).toContain("Step 'declared': structured_output caveat");
  });

  it('(e) REALM_NO_NUDGE=1 silences the summary — but an explicit --explain beats the standing preference', async () => {
    const wfPath = write(`
id: nudge-silenced
name: Nudge Silenced
version: 1
steps:
  a:
    description: a
    execution: agent
    output_schema:
      type: object
      additionalProperties: false
      required: [category]
      properties:
        category: { type: string, pattern: "^[a-z]+$" }
`);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    process.env['REALM_NO_NUDGE'] = '1';

    await validateCommand.parseAsync([wfPath], { from: 'user' });
    expect(infoLines(logSpy)).toEqual([]);

    // Same file, env var STILL SET — without that the precedence pin would be vacuous.
    logSpy.mockClear();
    await validateCommand.parseAsync([wfPath, '--explain'], { from: 'user' });
    const explained = infoLines(logSpy);
    expect(explained.length).toBeGreaterThan(0);
    expect(explained[0]).toContain('eligible for structured_output: strict, with caveat');
  });

  it('(f) --explain replaces the summary rather than adding to it', async () => {
    const wfPath = write(`
id: nudge-either-or
name: Nudge Either Or
version: 1
steps:
  a:
    description: a
    execution: agent
    output_schema:
      type: object
      additionalProperties: false
      required: [category]
      properties:
        category: { type: string, pattern: "^[a-z]+$" }
`);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await validateCommand.parseAsync([wfPath, '--explain'], { from: 'user' });

    const lines = infoLines(logSpy);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some((l) => l.includes('ready for structured_output'))).toBe(false);
    expect(lines.some((l) => l.includes('REALM_NO_NUDGE=1 to silence'))).toBe(false);
  });

  it('(g) a default run prints the summary INSTEAD of the per-item detail — the noise actually moved', async () => {
    const wfPath = write(`
id: nudge-relocated
name: Nudge Relocated
version: 1
steps:
  a:
    description: a
    execution: agent
    output_schema:
      type: object
      additionalProperties: false
      required: [category]
      properties:
        category: { type: string, pattern: "^[a-z]+$" }
`);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await validateCommand.parseAsync([wfPath], { from: 'user' });

    const logged = logSpy.mock.calls.flat().map(String).join('\n');
    expect(logged).not.toContain('eligible for structured_output: strict, with caveat');
    expect(logged).not.toContain('one line short');
    expect(infoLines(logSpy)).toEqual([
      'ℹ 1 step ready for structured_output: strict (1 with caveats)' + TAIL,
    ]);
  });

  it('an OPTED-IN step with a reasoning-like property gets the annotation too, unconditionally', async () => {
    // Found by mutation: deleting this call left the whole 1418-cell cli suite green. The
    // reasoning annotation on a DECLARED-config step is the always-loud surface rule 1 exists to
    // protect, and it was the one part of it nothing held down — a future refactor could have
    // dropped advice from the one channel that is never supposed to go quiet.
    const wfPath = write(`
id: nudge-opted-reasoning
name: Nudge Opted Reasoning
version: 1
steps:
  classify:
    description: classify
    execution: agent
    structured_output: strict
    output_schema:
      type: object
      additionalProperties: false
      required: [category]
      properties:
        category: { type: string, pattern: "^[a-z]+$" }
        reasoning: { type: string }
`);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    process.env['REALM_NO_NUDGE'] = '1'; // and not even the silencer reaches it

    await validateCommand.parseAsync([wfPath], { from: 'user' });

    const logged = logSpy.mock.calls.flat().map(String).join('\n');
    expect(logged).toContain("Step 'classify': structured_output caveat");
    expect(logged).toContain("the optional 'reasoning' property looks like a reasoning field");
  });

  it('only the exact string "1" silences — REALM_NO_NUDGE=0 still prints', async () => {
    // The repo's env convention is an exact `=== '1'` match (serve.ts:165), and every other cell
    // here only ever sets '1' or leaves it unset — so a `!== undefined` check would pass all of
    // them while silently silencing an operator who wrote `REALM_NO_NUDGE=0` meaning "no, do not
    // silence". `0`, `false` and empty are all values a person reasonably expects to be OFF.
    const wfPath = write(`
id: nudge-env-zero
name: Nudge Env Zero
version: 1
steps:
  a:
    description: a
    execution: agent
    output_schema:
      type: object
      required: [category]
      properties:
        category: { type: string }
`);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    process.env['REALM_NO_NUDGE'] = '0';

    await validateCommand.parseAsync([wfPath], { from: 'user' });

    expect(infoLines(logSpy)).toEqual([
      'ℹ 1 step one change away from structured_output: strict' + TAIL,
    ]);
  });

  it('the summary still prints when --strict is FAILING the run — the INFO channel is independent of the exit code', async () => {
    // A warn-class warning does not escalate (rejectIfPolicyEscalates is error-only), so
    // --strict reaches its exit through `strictFailed`, and the nudge sits between the two. No
    // cell anywhere traversed that path with a nudgeable step, so a change that skipped the
    // nudge on a failing run would have gone unnoticed — and the whole design of this channel is
    // that it is independent of whether validation succeeded.
    //
    // `retry:` on an agent step mints RETRY_INERT_NON_AUTO, a warn-severity warning — the
    // cheapest way to make --strict fail without escalating anything.
    const wfPath = write(`
id: nudge-strict-failing
name: Nudge Strict Failing
version: 1
steps:
  classify:
    description: classify
    execution: agent
    retry:
      max_attempts: 3
    output_schema:
      type: object
      required: [category]
      properties:
        category: { type: string }
`);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('process.exit');
    }) as never);

    await expect(
      validateCommand.parseAsync([wfPath, '--strict'], { from: 'user' }),
    ).rejects.toThrow('process.exit');

    expect(exitSpy).toHaveBeenCalledWith(1);
    // And the summary printed anyway. `infoLines` filters to `ℹ` only, so the warning and the
    // `Valid: … failing due to --strict` line cannot stand in for it here.
    expect(infoLines(logSpy)).toEqual([
      'ℹ 1 step one change away from structured_output: strict' + TAIL,
    ]);
  });

  it('(j) --explain on a file with nothing to show prints nothing extra', async () => {
    const wfPath = write(`
id: nudge-nothing
name: Nudge Nothing
version: 1
steps:
  work:
    description: work
    execution: auto
    input_schema:
      type: object
      properties:
        x: { type: string }
`);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await validateCommand.parseAsync([wfPath, '--explain'], { from: 'user' });

    expect(infoLines(logSpy)).toEqual([]);
  });
});
