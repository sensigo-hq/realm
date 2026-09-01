// issue #427 — `realm workflow validate --registered <id>`: auditing the STORED copy.
//
// The mechanism is strip-the-stamped-keys and re-serialize through the REAL loader (kubectl's
// server-side dry-run shape), so no rule is duplicated and this surface cannot drift from what
// `register` would accept. These cells pin the four verdict shapes it can reach, the honesty
// line, and the fidelity of the strip.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateCommand } from './validate.js';
import { CURRENT_WORKFLOW_SCHEMA_VERSION, RUNTIME_ONLY_WORKFLOW_KEYS } from '@sensigo/realm';

describe('validate --registered (issue #427)', () => {
  let home: string;
  let wfDir: string;
  let originalHome: string | undefined;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'realm-validate-reg-'));
    wfDir = join(home, '.realm', 'workflows');
    mkdirSync(wfDir, { recursive: true });
    originalHome = process.env['HOME'];
    process.env['HOME'] = home;
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('process.exit');
    }) as never);
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = originalHome;
    rmSync(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function plant(fileBase: string, def: unknown): void {
    writeFileSync(join(wfDir, `${fileBase}.json`), JSON.stringify(def, null, 2), 'utf8');
  }

  const out = (): string =>
    [logSpy, warnSpy, errSpy]
      .flatMap((s) => s.mock.calls.map((c: unknown[]) => String(c[0])))
      .join('\n');

  /** A stored shape carrying the keys the file loader stamps — the realistic starting point. */
  function stored(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 'stored-wf',
      name: 'Stored WF',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      origin: 'human',
      source_dir: '/somewhere/on/the/registering/machine',
      trust_root: '/somewhere',
      steps: { a: { description: 'a', execution: 'agent' } },
      ...over,
    };
  }

  it("R1 THE CROWN — a stored definition today's loader would refuse", async () => {
    // The whole point of the surface: a workflow that is registered and runs today, whose stored
    // shape the CURRENT loader rejects. On the real registry this is `08-pr-review` and its
    // `auth.token_from` (removed in v0.14.0); the synthetic here uses the #402 prohibition,
    // which is the same class and needs no service block.
    plant(
      'stored-wf',
      stored({ steps: { a: { description: 'a', execution: 'agent', timeout_seconds: 60 } } }),
    );

    await expect(
      validateCommand.parseAsync(['--registered', 'stored-wf'], { from: 'user' }),
    ).rejects.toThrow('process.exit');

    const text = out();
    expect(text).toContain(
      "Auditing the registered copy of 'stored-wf' (schema_version 1) with realm",
    );
    expect(text).toContain(
      'Registered copies stay grandfathered at runtime — this reports what re-registration today would say.',
    );
    expect(text).toContain("'timeout_seconds' is not valid on execution: agent steps");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('R2 warnings-only — the header, the warnings, Valid, exit 0', async () => {
    // The fixture's warning MUST be non-escalating. #170 is LIVE: an unknown-key fixture
    // resolves to ERROR under the default policy and refuses, flipping this cell to exit 1 and
    // testing the opposite of what it claims. `retry` on an agent step is inert-and-warned.
    plant(
      'stored-wf',
      stored({
        steps: { a: { description: 'a', execution: 'agent', retry: { max_attempts: 3 } } },
      }),
    );

    await validateCommand.parseAsync(['--registered', 'stored-wf'], { from: 'user' });

    const text = out();
    expect(text).toContain("Auditing the registered copy of 'stored-wf'");
    expect(text).toContain("'retry' is inert on execution: 'agent' steps");
    expect(text).toContain('Valid: stored-wf');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('R3 --strict flips a warnings-only audit to exit 1, in the singular', async () => {
    plant(
      'stored-wf',
      stored({
        steps: { a: { description: 'a', execution: 'agent', retry: { max_attempts: 3 } } },
      }),
    );

    await expect(
      validateCommand.parseAsync(['--registered', 'stored-wf', '--strict'], { from: 'user' }),
    ).rejects.toThrow('process.exit');

    expect(out()).toContain('1 warning; failing due to --strict');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("R4 an ancient (schema_version-less) entry gets the LEGACY verdict, not the loader's", async () => {
    // A true sv-less shape, matching the real cohort's topology — no `steps` key at all. Fed to
    // the loader ungated it yields `Missing required field: 'steps'`, which is true of the shape
    // and useless about the cause; the gate is what turns that into the re-register remedy.
    plant('ancient-wf', { id: 'ancient-wf', name: 'Ancient', version: 2 });

    await expect(
      validateCommand.parseAsync(['--registered', 'ancient-wf'], { from: 'user' }),
    ).rejects.toThrow('process.exit');

    const text = out();
    expect(text).toContain("Auditing the registered copy of 'ancient-wf' with realm");
    // ONE clause: no schema_version parenthetical (nothing parsed to read one from) and no
    // grandfathering sentence (false here — every runtime consumer goes through this same gate,
    // so a legacy entry cannot run at all).
    expect(text).not.toContain('schema_version');
    expect(text).not.toContain('stay grandfathered');
    expect(text).toContain('registered with an older version of Realm');
    expect(text).not.toContain("Missing required field: 'steps'");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('R5 an unknown id names the list command', async () => {
    await expect(
      validateCommand.parseAsync(['--registered', 'no-such-wf'], { from: 'user' }),
    ).rejects.toThrow('process.exit');

    const text = out();
    expect(text).toContain('Error: Workflow not found: no-such-wf');
    expect(text).toContain('Registered workflows: realm workflow list');
  });

  it('R6 an extensions-declaring stored copy: the honesty line, and a real verdict', async () => {
    // The from-string loader HARD-THROWS on an `extensions` key with "Register this workflow
    // from its YAML file" — maximally misleading here, where the workflow IS registered. The
    // key is deleted after the honesty line; both conjuncts below are what pin that.
    plant('stored-wf', stored({ extensions: './dist/registry.js' }));

    await validateCommand.parseAsync(['--registered', 'stored-wf'], { from: 'user' });

    const text = out();
    expect(text).toContain('Extensions/profiles declared — module resolution, config_schema');
    expect(text).toContain('Valid: stored-wf'); // it reached a verdict
    expect(text).not.toContain('Register this workflow from its YAML file');

    // ORDER, per header line. The honesty line only means anything under the "Auditing…" frame,
    // and nothing else pins that: header-before-VERDICT is true by construction (a refusing
    // parse exits before a late header could print), but header-before-HONESTY-LINE was pinned
    // by nothing — moving the header below it left 12/12 green.
    //
    // Per-member deliberately: a single first-line conjunct would be VACUOUS under header
    // deletion (indexOf's -1 satisfies `< x`) and blind to a line-2-only reorder.
    const honestyAt = text.indexOf('Extensions/profiles declared');
    const headerAt = text.indexOf("Auditing the registered copy of 'stored-wf'");
    expect(headerAt).toBeGreaterThanOrEqual(0);
    expect(headerAt).toBeLessThan(honestyAt);
    const gfAt = text.indexOf('stay grandfathered at runtime');
    expect(gfAt).toBeGreaterThanOrEqual(0);
    expect(gfAt).toBeLessThan(honestyAt);
  });

  it('R6b the honesty line also fires for an agent_profile, with no extensions key', async () => {
    // The OR-arm, pinned separately: profile FILE resolution is equally unavailable without the
    // source tree, and a fixture carrying extensions would not prove this half.
    plant(
      'stored-wf',
      stored({
        steps: { a: { description: 'a', execution: 'agent', agent_profile: 'reviewer' } },
      }),
    );

    await validateCommand.parseAsync(['--registered', 'stored-wf'], { from: 'user' });

    const text = out();
    expect(text).toContain('agent-profile file resolution need the source tree');
    expect(text).toContain('Valid: stored-wf');
  });

  it('R7a THE FIDELITY PIN — a realistic stored copy mints no stamped-key warnings', async () => {
    plant('stored-wf', stored());

    await validateCommand.parseAsync(['--registered', 'stored-wf'], { from: 'user' });

    const text = out();
    for (const key of RUNTIME_ONLY_WORKFLOW_KEYS) {
      expect(text).not.toContain(`unknown key '${key}'`);
    }
    expect(text).toContain('Valid: stored-wf');
  });

  it('R7b every member of the partition is stripped, not just the ones a file load stamps', async () => {
    // The file loader stamps only SOME of the seven, so R7a alone leaves the constant-iterating
    // assertion partly vacuous. Planting all of them directly makes it bite on each — and keeps
    // the pin honest if the partition ever grows a member.
    const withEveryStampedKey: Record<string, unknown> = stored();
    for (const key of RUNTIME_ONLY_WORKFLOW_KEYS) {
      withEveryStampedKey[key] ??= key === 'resolved_profiles' ? {} : 'planted';
    }
    withEveryStampedKey['schema_version'] = CURRENT_WORKFLOW_SCHEMA_VERSION;
    plant('stored-wf', withEveryStampedKey);

    await validateCommand.parseAsync(['--registered', 'stored-wf'], { from: 'user' });

    const text = out();
    for (const key of RUNTIME_ONLY_WORKFLOW_KEYS) {
      expect(text, `stamped key leaked: ${key}`).not.toContain(`unknown key '${key}'`);
    }
    expect(text).toContain('Valid: stored-wf');
  });

  it('R8 neither a path nor --registered is an error that names both routes', async () => {
    await expect(validateCommand.parseAsync([], { from: 'user' })).rejects.toThrow('process.exit');
    expect(out()).toContain(
      'Error: provide a workflow path, or --registered <id> to audit a stored definition.',
    );
  });

  it('R8 both a path and --registered is refused — commander gates neither', async () => {
    await expect(
      validateCommand.parseAsync(['some/path', '--registered', 'stored-wf'], { from: 'user' }),
    ).rejects.toThrow('process.exit');
    expect(out()).toContain(
      'Error: --registered audits the stored copy — it cannot be combined with a path.',
    );
  });

  it('R9 a corrupt stored file is reported as unparseable, without a stack', async () => {
    // get()'s try wraps ONLY the read — JSON.parse sits outside it — so this arrives as a bare
    // code-less SyntaxError, which the third catch arm exists for.
    writeFileSync(join(wfDir, 'broken.json'), '{ not json', 'utf8');

    await expect(
      validateCommand.parseAsync(['--registered', 'broken'], { from: 'user' }),
    ).rejects.toThrow('process.exit');

    const text = out();
    expect(text).toContain("Error: the registered copy of 'broken' is not parseable JSON:");
    expect(text).toContain('Registered workflows: realm workflow list');
    expect(text).not.toContain('    at ');
  });
});
