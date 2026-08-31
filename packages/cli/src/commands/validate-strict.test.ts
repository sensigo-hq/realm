// validate --strict + accumulator tests (issue #169). In-process via commander's parseAsync (same
// pattern as validate-retry-timeout-advisory.test.ts) — no subprocess/dist rebuild needed.
//
// RETIRED ALONGSIDE THIS FILE (issue #170): `dormant-reject.test.ts`. It proved the boundary-reject
// mechanism was real by MUTATING the exported DEFAULT_POLICY in place — flipping the two codes to
// 'error', then restoring them — which was the sanctioned simulation while the flip was dormant.
// The flip has now happened, so that file's "unflipped default only warns" control asserted the
// opposite of reality, and its two flip-simulation cells asserted the default. Both are covered
// here and in register-strict.test.ts by cells that need no shared-module mutation at all, so the
// file went rather than being re-anchored — and the mutation of shared module state went with it.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateCommand } from './validate.js';
import { printLoaderWarnings } from '../lib/loader-warnings.js';
import type { LoaderWarning } from '@sensigo/realm';
import { clearProjectExtensionsCache } from '../extensions/load-project-extensions.js';

describe('validate --strict (issue #169)', () => {
  let dir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'realm-validate-strict-'));
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('process.exit');
    }) as never);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('exits 0 and prints normally when --strict is set but there are no warnings', async () => {
    const wfPath = join(dir, 'workflow.yaml');
    writeFileSync(
      wfPath,
      `id: clean-wf
name: Clean WF
version: 1
steps:
  step-one:
    description: a step
    execution: auto
`,
      'utf8',
    );

    await validateCommand.parseAsync([wfPath, '--strict'], { from: 'user' });

    expect(exitSpy).not.toHaveBeenCalled();
    const printed = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(printed).toContain('Valid: clean-wf v1 (1 step)');
    expect(printed).not.toContain('warning(s)');
  });

  it('--strict and the DEFAULT policy now agree on an unknown key: the boundary refuses first', async () => {
    const wfPath = join(dir, 'workflow.yaml');
    writeFileSync(
      wfPath,
      `id: typo-wf
name: Typo WF
version: 1
steps:
  step-one:
    description: a step
    execution: auto
    dependson: [nothing]
`,
      'utf8',
    );

    await expect(
      validateCommand.parseAsync([wfPath, '--strict'], { from: 'user' }),
    ).rejects.toThrow('process.exit');

    expect(exitSpy).toHaveBeenCalledWith(1);
    // ORDERING, and it is the point of this cell post-#170: the policy escalation is checked
    // BEFORE --strict, so an unknown key never reaches the "failing due to --strict" summary any
    // more. The flag is not what refuses this workflow — the default policy is.
    const printed = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(printed).not.toContain('failing due to --strict');
    const errored = errorSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(errored).toContain('escalated to an error by policy');
    const warned = warnSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(warned).toContain("unknown key 'dependson'");
  });

  it('the refusing boundary does NOT say the key was "ignored" — it was not', async () => {
    // The warning is minted with "— ignored", which is true of the lenient loader and false here.
    // Printed directly above "escalated to an error", it told the author the opposite of what was
    // happening. The did-you-mean fragment — the half that lets them fix it in one edit — stays.
    const wfPath = join(dir, 'workflow.yaml');
    writeFileSync(
      wfPath,
      `id: ignored-claim-wf
name: Ignored Claim WF
version: 1
steps:
  step-one:
    description: a step
    execution: auto
    dependson: [nothing]
`,
      'utf8',
    );

    await expect(validateCommand.parseAsync([wfPath], { from: 'user' })).rejects.toThrow(
      'process.exit',
    );

    const warned = warnSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(warned).toContain("unknown key 'dependson'");
    expect(warned).not.toContain('ignored');
    expect(warned).toContain('REFUSED below');
    expect(warned).toContain("did you mean 'depends_on'?");
  });

  it('the render substitution covers BOTH flipped codes, not just the step-level one', () => {
    // Unit-level, driving printLoaderWarnings directly, because the two flipped codes travel
    // different paths to get here and the cell above only exercises one of them. Narrowing the
    // substitution to exclude UNKNOWN_WORKFLOW_KEY left the entire cli suite green before this
    // existed — a conjunct pinned for one member of a set and no other.
    const both: LoaderWarning[] = [
      {
        code: 'UNKNOWN_WORKFLOW_KEY',
        severity: 'error',
        message: "workflow 'w': unknown key 'descriptoin' — ignored (did you mean 'description'?)",
        scope: 'workflow',
        id: 'w',
        key: 'descriptoin',
        did_you_mean: 'description',
      },
      {
        code: 'UNKNOWN_STEP_KEY',
        severity: 'error',
        message: "step 's': unknown key 'dependson' — ignored (did you mean 'depends_on'?)",
        scope: 'step',
        step: 's',
        key: 'dependson',
        did_you_mean: 'depends_on',
      },
    ];

    printLoaderWarnings(both);

    const lines = warnSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).toContain('REFUSED below');
      expect(line).not.toContain('— ignored');
      // The suggestion survives the substitution — it is the useful half of the line.
      expect(line).toContain('did you mean');
    }
    // And the workflow-scoped one is genuinely present, so this cannot pass on two step lines.
    expect(lines.join('\n')).toContain("workflow 'w'");
  });

  it('without --strict, an unknown key is now REFUSED by the default policy alone', async () => {
    const wfPath = join(dir, 'workflow.yaml');
    writeFileSync(
      wfPath,
      `id: typo-wf-lenient
name: Typo WF Lenient
version: 1
steps:
  step-one:
    description: a step
    execution: auto
    dependson: [nothing]
`,
      'utf8',
    );

    // The #170 flip's headline: no flag, no opt-in, the workflow simply does not validate.
    await expect(validateCommand.parseAsync([wfPath], { from: 'user' })).rejects.toThrow(
      'process.exit',
    );

    expect(exitSpy).toHaveBeenCalledWith(1);
    const printed = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(printed).not.toContain('Valid: typo-wf-lenient');
    const errored = errorSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(errored).toContain('escalated to an error by policy');
    const warned = warnSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(warned).toContain("unknown key 'dependson'");
  });
});

describe('validate — double-count guard on the two-pass (extensions) branch (issue #169)', () => {
  let proj: string;
  let workflowDir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clearProjectExtensionsCache();
    proj = mkdtempSync(join(tmpdir(), 'realm-validate-double-count-'));
    workflowDir = join(proj, 'workflows', 'wf');
    mkdirSync(join(proj, 'dist'), { recursive: true });
    mkdirSync(workflowDir, { recursive: true });
    writeFileSync(join(proj, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
    writeFileSync(join(proj, 'dist', 'registry.js'), 'export default {};', 'utf8');
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(proj, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('one unknown key on a workflow that declares extensions (two loader passes) is counted/printed exactly once', async () => {
    const wfPath = join(workflowDir, 'workflow.yaml');
    writeFileSync(
      wfPath,
      `id: two-pass-wf
name: Two Pass WF
version: 1
extensions: ../../dist/registry.js
steps:
  step-one:
    description: a step
    execution: auto
    dependson: [nothing]
`,
      'utf8',
    );

    await validateCommand.parseAsync([wfPath, '--strict'], { from: 'user' }).catch(() => {
      // This fixture exits 1 either way; we only care about the count below.
    });

    // The cell's purpose is unchanged by #170 — two loader passes must not double-print the same
    // warning. What changed is which line reports the count: the policy escalation refuses before
    // --strict is consulted, so the count is read off the escalation message now.
    const warned: string[] = warnSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    const unknownKeyWarnings = warned.filter((line) => line.includes("unknown key 'dependson'"));
    expect(unknownKeyWarnings).toHaveLength(1);

    const errored = errorSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    // issue #425: whole line. The escalation message is the only one that aggregates counts, so
    // it is the one that has to say WHICH warning escalated — a substring pin on the counts
    // would not have noticed the list going missing.
    expect(errored).toContain(
      "Invalid: 1 warning, 1 escalated to an error by policy: UNKNOWN_STEP_KEY 'dependson'",
    );
    // And the refusal is a refusal: no success line is printed alongside it.
    expect(logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')).not.toContain(
      'Valid: two-pass-wf',
    );
  });
});

describe('validate — accumulator honesty: retry advisory + sentinel + unknown key all counted (issue #169)', () => {
  let dir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'realm-validate-accumulator-'));
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('process.exit');
    }) as never);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('--strict counts a retry-without-timeout advisory AND an unknown key together (extension-free branch)', async () => {
    const wfPath = join(dir, 'workflow.yaml');
    writeFileSync(
      wfPath,
      `id: accumulator-wf
name: Accumulator WF
version: 1
steps:
  step-one:
    description: a step
    execution: auto
    dependson: [nothing]
    retry:
      max_attempts: 3
      backoff: fixed
      base_delay_ms: 10
`,
      'utf8',
    );

    await expect(
      validateCommand.parseAsync([wfPath, '--strict'], { from: 'user' }),
    ).rejects.toThrow('process.exit');

    expect(exitSpy).toHaveBeenCalledWith(1);
    // Accumulator honesty is the purpose and it survives: BOTH warnings are counted and both are
    // printed. Post-#170 the count is reported by the escalation message rather than the --strict
    // summary, because the unknown key alone is already an error under the default policy.
    const errored = errorSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    // issue #425, and this is the discriminating case: TWO warnings, ONE of them escalated. The
    // old line said "at least one is escalated" and left the author to work out which of the two
    // above it was the refusal. Both counts and the named culprit, on one line.
    expect(errored).toContain(
      "Invalid: 2 warnings, 1 escalated to an error by policy: UNKNOWN_STEP_KEY 'dependson'",
    );
    expect(logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')).not.toContain(
      'Valid: accumulator-wf',
    );
    const warned = warnSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(warned).toContain("unknown key 'dependson'");
    expect(warned).toContain("declares 'retry' but no 'timeout_seconds'");
    // The retry advisory is NOT a flipped code, so its line keeps the lenient wording; only the
    // refused code's "— ignored" is substituted. One render, two different truths.
    expect(warned).toContain('REFUSED below');
  });
});

// issue #427 — the validate half of the pluralization pair. Both directions minted: every
// pre-existing pin on this line was a count-agnostic substring, so the ternary would have gone
// in with nothing reddening either way.
describe('validate --strict — the summary counts agree with the count (issue #427)', () => {
  let dir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'realm-validate-plural-'));
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('process.exit');
    }) as never);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function write(body: string): string {
    const p = join(dir, 'workflow.yaml');
    writeFileSync(p, body, 'utf8');
    return p;
  }

  const printed = (): string => logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');

  it('one warning reads "1 warning"', async () => {
    // NON-escalating on purpose: an unknown key resolves to error under the live #170 policy and
    // refuses before this summary line is ever reached.
    const p = write(`id: plural-one
name: Plural One
version: 1
steps:
  a:
    description: a
    execution: agent
    retry:
      max_attempts: 3
`);

    await expect(validateCommand.parseAsync([p, '--strict'], { from: 'user' })).rejects.toThrow(
      'process.exit',
    );

    expect(printed()).toContain('1 warning; failing due to --strict');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('two warnings read "2 warnings"', async () => {
    const p = write(`id: plural-two
name: Plural Two
version: 1
steps:
  a:
    description: a
    execution: agent
    retry:
      max_attempts: 3
  b:
    description: b
    execution: agent
    depends_on: [a]
    retry:
      max_attempts: 2
`);

    await expect(validateCommand.parseAsync([p, '--strict'], { from: 'user' })).rejects.toThrow(
      'process.exit',
    );

    expect(printed()).toContain('2 warnings; failing due to --strict');
  });
});
