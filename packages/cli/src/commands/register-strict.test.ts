// register --strict tests (issue #169). registerCommand constructs `new JsonWorkflowStore()`
// with no injectable directory — its default resolves via node:os homedir() at construction
// time (inside the command's own action, not at import time), so pointing $HOME at a temp dir
// before parseAsync isolates it safely (same technique as abandon.test.ts /
// register-description-echo.test.ts).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerCommand } from './register.js';

describe('register --strict (issue #169)', () => {
  let home: string;
  let originalHome: string | undefined;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'realm-register-strict-'));
    mkdirSync(join(home, '.realm', 'workflows'), { recursive: true });
    originalHome = process.env['HOME'];
    process.env['HOME'] = home;
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('process.exit');
    }) as never);
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = originalHome;
    vi.restoreAllMocks();
    rmSync(home, { recursive: true, force: true });
  });

  it('registers normally and exits 0 when --strict is set but there are no warnings', async () => {
    const wfDir = mkdtempSync(join(tmpdir(), 'realm-register-strict-wf-'));
    writeFileSync(
      join(wfDir, 'workflow.yaml'),
      `id: clean-reg
name: Clean Reg
version: 1
steps:
  step-one:
    description: a step
    execution: auto
`,
      'utf8',
    );

    await registerCommand.parseAsync([wfDir, '--strict'], { from: 'user' });

    expect(exitSpy).not.toHaveBeenCalled();
    const printed = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(printed).toContain('Registered: clean-reg v1 (1 steps)');
    rmSync(wfDir, { recursive: true, force: true });
  });

  it('--strict still tightens a code #170 did NOT flip (UNKNOWN_RETRY_KEY)', async () => {
    // Re-fixtured onto a non-flipped code deliberately. On an unknown STEP key the boundary-reject
    // now fires first, so a --strict assertion there would pass with the flag doing nothing — the
    // flag's own machinery would go silently unpinned. UNKNOWN_RETRY_KEY is still 'warn', so only
    // --strict can refuse it, which is what this cell claims to test.
    //
    // It earns a second job for free: it is an unknown-KEY code, so it still renders "— ignored".
    // That pins the #170 render substitution as CODE-SCOPED rather than a blanket text replace.
    const wfDir = mkdtempSync(join(tmpdir(), 'realm-register-strict-wf-'));
    writeFileSync(
      join(wfDir, 'workflow.yaml'),
      `id: typo-reg
name: Typo Reg
version: 1
steps:
  step-one:
    description: a step
    execution: auto
    timeout_seconds: 5
    retry:
      max_attempts: 3
      backoff: fixed
      base_delay_ms: 10
      bogus_retry_key: 1
`,
      'utf8',
    );

    await expect(registerCommand.parseAsync([wfDir, '--strict'], { from: 'user' })).rejects.toThrow(
      'process.exit',
    );

    expect(exitSpy).toHaveBeenCalledWith(1);
    const errored = errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(errored).toContain('refusing to register due to --strict');
    const warnedHere = warnSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    // SPLIT PINS (issue #392): a source position now sits between the key and the clause.
    expect(warnedHere).toContain("unknown key 'bogus_retry_key'");
    expect(warnedHere).toContain('— ignored');
    // reds under probe (a) — deliberate: the retry sub-family carries positions too.
    expect(warnedHere).toContain("unknown key 'bogus_retry_key' (line 13) — ignored");
    expect(warnedHere).not.toContain('REFUSED below');
    expect(logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')).not.toContain(
      'Registered:',
    );
    rmSync(wfDir, { recursive: true, force: true });
  });

  it('without --strict, an unknown key is now refused by the default policy alone', async () => {
    const wfDir = mkdtempSync(join(tmpdir(), 'realm-register-strict-wf-'));
    writeFileSync(
      join(wfDir, 'workflow.yaml'),
      `id: typo-reg-lenient
name: Typo Reg Lenient
version: 1
steps:
  step-one:
    description: a step
    execution: auto
    dependson: [nothing]
`,
      'utf8',
    );

    await expect(registerCommand.parseAsync([wfDir], { from: 'user' })).rejects.toThrow(
      'process.exit',
    );

    expect(exitSpy).toHaveBeenCalledWith(1);
    const printed = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(printed).not.toContain('Registered: typo-reg-lenient');
    const errored = errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(errored).toContain('escalated to an error by policy — refusing to register');
    const warned = warnSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(warned).toContain("unknown key 'dependson'");
    rmSync(wfDir, { recursive: true, force: true });
  });
});

// =================================================================================================
// issue #424 — register reports the whole defect set in one pass
//
// register renders a loader failure at ONE site (the ManifestSecretsError catch above it
// rethrows into this one), and until now that render dropped the warnings the error was thrown
// alongside: an author with a prohibited key AND a typo fixed the key, re-ran, and only then met
// the typo.
// =================================================================================================
describe('register — a hard load error carries its warnings (issue #424)', () => {
  let home: string;
  let originalHome: string | undefined;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'realm-register-424-'));
    mkdirSync(join(home, '.realm', 'workflows'), { recursive: true });
    originalHome = process.env['HOME'];
    process.env['HOME'] = home;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('process.exit');
    }) as never);
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = originalHome;
    vi.restoreAllMocks();
    rmSync(home, { recursive: true, force: true });
  });

  it('renders the warning AND the error together', async () => {
    const wfDir = mkdtempSync(join(tmpdir(), 'realm-register-424-wf-'));
    writeFileSync(
      join(wfDir, 'workflow.yaml'),
      `id: carry-reg
name: Carry Reg
version: 1
steps:
  classify:
    description: classify
    execution: agent
    dependson: [nowhere]
    timeout_seconds: 60
`,
      'utf8',
    );

    await expect(registerCommand.parseAsync([wfDir], { from: 'user' })).rejects.toThrow(
      'process.exit',
    );

    expect(exitSpy).toHaveBeenCalledWith(1);
    const errored = errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(errored).toContain("'timeout_seconds' is not valid on execution: agent steps");
    const warned = warnSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(warned).toContain("unknown key 'dependson'");
    expect(warned).toContain("did you mean 'depends_on'?");
    rmSync(wfDir, { recursive: true, force: true });
  });

  it('the FILE-path chokepoint carries too: a missing profile still reports the typo', async () => {
    // This one never reaches the parse collector — `agent_profile` resolution happens in
    // loadWorkflowFromFileCore, AFTER the parse returned successfully with its warnings. A single
    // chokepoint inside the parser would leave this case exactly as broken as it was.
    const wfDir = mkdtempSync(join(tmpdir(), 'realm-register-424-f1-'));
    writeFileSync(
      join(wfDir, 'workflow.yaml'),
      `id: carry-reg-profile
name: Carry Reg Profile
version: 1
steps:
  classify:
    description: classify
    execution: agent
    agent_profile: nonexistent
    dependson: [nowhere]
`,
      'utf8',
    );

    await expect(registerCommand.parseAsync([wfDir], { from: 'user' })).rejects.toThrow(
      'process.exit',
    );

    const errored = errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(errored).toContain("agent_profile 'nonexistent' not found");
    const warned = warnSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(warned).toContain("unknown key 'dependson'");
    rmSync(wfDir, { recursive: true, force: true });
  });
});
