// issue #454 — `realm workflow validate --json`: the machine contract, both modes, every arm.
//
// Harness TEMPLATE = validate-registered.test.ts's scratch-HOME/plant()/stored()/four-spies/
// throw-exitSpy idioms, PLUS the must-adds this surface needs: a LOG-ONLY accessor (the
// template's merged out() would hide a stderr leak — exactly the leak "stderr silent on
// contract arms" exists to catch), mockClear per invocation, clearProjectExtensionsCache in
// beforeEach, REALM_NO_NUDGE save/clear/restore, and validate-strict.test.ts's mkdtempSync
// file-fixture machinery.
//
// Every JSON cell asserts via JSON.parse of the joined console.log capture — asserting exactly
// ONE console.log call is ITSELF the purity assert (nothing else may write to stdout on a
// contract arm). No `process.stdout.write` exists anywhere in this surface (lane-grepped) — the
// spy idiom is sound.
//
// Red-first on main, the REAL in-process shape (lane-executed): commander refuses `--json`
// BEFORE the action and writes `error: unknown option '--json'` to `process.stderr.write` —
// INVISIBLE to the errSpy. In-cell the shared red is: `parseAsync` rejects with the exit-spy's
// 'process.exit' + exitSpy(1) + EMPTY stdout (`JSON.parse` throws on the empty string). U1's
// red-on-main is different: the named export does not exist yet, so the IMPORT reds the whole
// file.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateCommand, normalizeDiagnosticSeverity } from './validate.js';
import { CURRENT_WORKFLOW_SCHEMA_VERSION } from '@sensigo/realm';
import type { LoaderWarning } from '@sensigo/realm';
import { clearProjectExtensionsCache } from '../extensions/load-project-extensions.js';

// =================================================================================================
// U1 — the severity normalizer's ONLY honest pin (unit-level; no fixture can produce this input —
// every mint site in the tree already resolves severity at construction, so minted ≡ effective
// everywhere real; this cell pins the GUARD with a hand-constructed lying warning).
// =================================================================================================

describe('normalizeDiagnosticSeverity — the emit guard (issue #454, unit-level)', () => {
  it('U1 re-resolves a CONSTRUCTED lying severity to the live effective one', () => {
    const lying: LoaderWarning = {
      code: 'UNKNOWN_STEP_KEY',
      severity: 'warn', // the lie — UNKNOWN_STEP_KEY resolves to 'error' under DEFAULT_POLICY
      message: 'step-scoped lie',
      scope: 'step',
    };
    const result = normalizeDiagnosticSeverity(lying);
    expect(result.severity).toBe('error');
    // Every other field survives untouched — this is a targeted override, not a rebuild.
    expect(result.code).toBe('UNKNOWN_STEP_KEY');
    expect(result.message).toBe('step-scoped lie');
    expect(result.scope).toBe('step');
  });
});

// =================================================================================================
// The shared harness for every file-mode and registered-mode --json cell.
// =================================================================================================

describe('validate --json (issue #454)', () => {
  let home: string;
  let wfDir: string;
  let originalHome: string | undefined;
  let savedNoNudge: string | undefined;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clearProjectExtensionsCache();
    home = mkdtempSync(join(tmpdir(), 'realm-validate-json-'));
    wfDir = join(home, '.realm', 'workflows');
    mkdirSync(wfDir, { recursive: true });
    originalHome = process.env['HOME'];
    process.env['HOME'] = home;
    savedNoNudge = process.env['REALM_NO_NUDGE'];
    delete process.env['REALM_NO_NUDGE'];
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
    if (savedNoNudge === undefined) delete process.env['REALM_NO_NUDGE'];
    else process.env['REALM_NO_NUDGE'] = savedNoNudge;
    rmSync(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  /** issue #454 — LOG-ONLY, never warn/err: the registered-mode template's `out()` merges three
   *  channels, which would hide a stderr leak — exactly what "stderr silent on contract arms"
   *  exists to catch. */
  const logOut = (): string => logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
  const errOut = (): string => errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
  const warnOut = (): string => warnSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');

  /** Asserts EXACTLY one console.log call — itself the purity guarantee — and parses it. */
  function parseJson(): Record<string, unknown> {
    expect(logSpy.mock.calls).toHaveLength(1);
    return JSON.parse(String(logSpy.mock.calls[0]![0])) as Record<string, unknown>;
  }

  function plant(fileBase: string, def: unknown): void {
    writeFileSync(join(wfDir, `${fileBase}.json`), JSON.stringify(def, null, 2), 'utf8');
  }

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

  function writeWorkflow(dir: string, yaml: string): string {
    const p = join(dir, 'workflow.yaml');
    writeFileSync(p, yaml, 'utf8');
    return p;
  }

  // ===============================================================================================
  // J1/J2 — the warn-only split (validate-retry-timeout-advisory.test.ts's inline idiom).
  // ===============================================================================================

  describe('J1/J2 — warn-only: the valid-vs-strict split', () => {
    function makeWarnOnlyFixture(dir: string): string {
      return writeWorkflow(
        dir,
        `id: j1-wf
name: J1 WF
description: a nice description
version: 1
steps:
  s1:
    description: a
    execution: auto
    retry:
      max_attempts: 3
      backoff: fixed
      base_delay_ms: 10
`,
      );
    }

    it('J1 default: valid, one warning, strict both false, exit 0', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'realm-validate-json-j1-'));
      const p = makeWarnOnlyFixture(dir);

      await validateCommand.parseAsync([p, '--json'], { from: 'user' });

      const result = parseJson();
      expect(result['valid']).toBe(true);
      expect(result['mode']).toBe('file');
      expect(result['path']).toBe(p);
      expect(result['workflow_id']).toBe('j1-wf');
      expect(result['warning_count']).toBe(1);
      expect(result['error_count']).toBe(0);
      expect(result['strict']).toEqual({ requested: false, failed: false });
      const diagnostics = result['diagnostics'] as LoaderWarning[];
      expect(diagnostics[0]?.code).toBe('RETRY_NO_TIMEOUT');
      expect(exitSpy).not.toHaveBeenCalled();
      // The description line the human leg prints — its ABSENCE here is the free suppression
      // pin: --json's whole point is that nothing but the object reaches stdout.
      expect(logOut()).not.toContain('a nice description');
      expect(errOut()).toBe('');
      expect(warnOut()).toBe('');
      rmSync(dir, { recursive: true, force: true });
    }, 20_000);

    it('J2 --strict --json: valid STAYS true, strict split flips, exit 1', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'realm-validate-json-j2-'));
      const p = makeWarnOnlyFixture(dir);

      await expect(
        validateCommand.parseAsync([p, '--strict', '--json'], { from: 'user' }),
      ).rejects.toThrow('process.exit');

      const result = parseJson();
      expect(result['valid']).toBe(true);
      expect(result['strict']).toEqual({ requested: true, failed: true });
      expect(exitSpy).toHaveBeenCalledWith(1);
      rmSync(dir, { recursive: true, force: true });
    }, 20_000);
  });

  // ===============================================================================================
  // J3/J3b — the escalated-typo family.
  // ===============================================================================================

  describe('J3/J3b/J3c — escalation', () => {
    function makeEscalatedFixture(dir: string): string {
      return writeWorkflow(
        dir,
        `id: j3-wf
name: J3 WF
version: 1
steps:
  s1:
    description: a
    execution: auto
    dependson: [nothing]
`,
      );
    }

    it('J3 escalated dependson: valid false, whole-string escalation, effective severity, exit 1', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'realm-validate-json-j3-'));
      const p = makeEscalatedFixture(dir);

      await expect(validateCommand.parseAsync([p, '--json'], { from: 'user' })).rejects.toThrow(
        'process.exit',
      );

      const result = parseJson();
      expect(result['valid']).toBe(false);
      const errors = result['errors'] as string[];
      expect(errors[0]).toMatch(/^Invalid: 1 warning/);
      expect(errors[0]).toContain('escalated to an error by policy');
      const diagnostics = result['diagnostics'] as LoaderWarning[];
      // A VALUE pin — the minted object already says 'error' (minted ≡ effective); U1 above
      // carries the normalizer's own discrimination.
      expect(diagnostics[0]?.severity).toBe('error');
      expect(exitSpy).toHaveBeenCalledWith(1);
      rmSync(dir, { recursive: true, force: true });
    }, 20_000);

    it('J3b escalation + --strict --json: strict.failed stays false — the gate was never reached', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'realm-validate-json-j3b-'));
      const p = makeEscalatedFixture(dir);

      await expect(
        validateCommand.parseAsync([p, '--strict', '--json'], { from: 'user' }),
      ).rejects.toThrow('process.exit');

      const result = parseJson();
      expect(result['strict']).toEqual({ requested: true, failed: false });
      expect(exitSpy).toHaveBeenCalledWith(1);
      rmSync(dir, { recursive: true, force: true });
    }, 20_000);

    it('J3c (correction) the extensions-arm escalation fork — a RESOLVABLE module + escalated dependson, no hard error: valid false, whole-string escalation, effective severity, exit 1', async () => {
      // The third rejectOnErrorSeverity(accumulated) instance (validate.ts's extensions-arm
      // `if (json)` tail) — implemented since the base implementation but reachable by no cell
      // until now (MA review, the #453-D2c per-member-pin precedent). Reuses J7b's minimal
      // resolvable-module shape: an empty registry is enough to route into the extensions arm
      // and have BOTH passes succeed, so the only failure this fixture can produce is the
      // escalation itself — never a load error, which would prove a different fork.
      const proj = mkdtempSync(join(tmpdir(), 'realm-validate-json-j3c-'));
      const workflowDir = join(proj, 'workflows', 'wf');
      mkdirSync(join(proj, 'dist'), { recursive: true });
      mkdirSync(workflowDir, { recursive: true });
      writeFileSync(join(proj, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
      writeFileSync(join(proj, 'dist', 'registry.js'), 'export default {};\n', 'utf8');
      const p = writeWorkflow(
        workflowDir,
        `id: j3c-wf
name: J3c WF
version: 1
extensions: ../../dist/registry.js
steps:
  s1:
    description: a
    execution: auto
    dependson: [nothing]
`,
      );

      await expect(validateCommand.parseAsync([p, '--json'], { from: 'user' })).rejects.toThrow(
        'process.exit',
      );

      const result = parseJson();
      expect(result['valid']).toBe(false);
      const errors = result['errors'] as string[];
      expect(errors[0]).toMatch(/^Invalid: 1 warning/);
      expect(errors[0]).toContain('escalated to an error by policy');
      const diagnostics = result['diagnostics'] as LoaderWarning[];
      expect(diagnostics[0]?.code).toBe('UNKNOWN_STEP_KEY');
      expect(diagnostics[0]?.severity).toBe('error');
      expect(exitSpy).toHaveBeenCalledWith(1);
      rmSync(proj, { recursive: true, force: true });
    }, 20_000);
  });

  // ===============================================================================================
  // J4/J4b — the arc's densest cell: TWO structural errors + ONE loader-minted warning, one throw.
  // ===============================================================================================

  describe('J4/J4b — multi-error load carries both #402 boundaries and the #424 warnings plank', () => {
    const J4_BODY = `id: j4-wf
name: J4 WF
version: 1
steps:
  step-one:
    description: a
    execution: agent
    timeout_seconds: 60
    dependson: [nothing]
  step-two:
    description: b
    execution: agent
    timeout_seconds: 30
`;

    it('J4 (extension-free): errors.length === error_count === 2, diagnostics[0] is the loader-minted warning, exit 1', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'realm-validate-json-j4-'));
      const p = writeWorkflow(dir, J4_BODY);

      await expect(validateCommand.parseAsync([p, '--json'], { from: 'user' })).rejects.toThrow(
        'process.exit',
      );

      const result = parseJson();
      expect(result['valid']).toBe(false);
      const errors = result['errors'] as string[];
      expect(errors).toHaveLength(2);
      expect(result['error_count']).toBe(2);
      const diagnostics = result['diagnostics'] as LoaderWarning[];
      expect(diagnostics[0]?.code).toBe('UNKNOWN_STEP_KEY');
      expect(exitSpy).toHaveBeenCalledWith(1);
      rmSync(dir, { recursive: true, force: true });
    }, 20_000);

    it('J4b (:580 pass-1, extensions arm): same assertions, workflow_id null (the row this cell pins)', async () => {
      const proj = mkdtempSync(join(tmpdir(), 'realm-validate-json-j4b-'));
      const workflowDir = join(proj, 'workflows', 'wf');
      mkdirSync(join(proj, 'dist'), { recursive: true });
      mkdirSync(workflowDir, { recursive: true });
      writeFileSync(join(proj, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
      // Routes to the FILE-based arm (a top-level extensions: block) — pass-1 fails before module
      // resolution is ever attempted, so no module needs to exist.
      const p = writeWorkflow(
        workflowDir,
        `extensions: ../../dist/registry.js
${J4_BODY}`,
      );

      await expect(validateCommand.parseAsync([p, '--json'], { from: 'user' })).rejects.toThrow(
        'process.exit',
      );

      const result = parseJson();
      expect(result['valid']).toBe(false);
      const errors = result['errors'] as string[];
      expect(errors).toHaveLength(2);
      expect(result['error_count']).toBe(2);
      const diagnostics = result['diagnostics'] as LoaderWarning[];
      expect(diagnostics[0]?.code).toBe('UNKNOWN_STEP_KEY');
      // THE row this per-member cell pins — :580 has no `definition` to read yet.
      expect(result['workflow_id']).toBeNull();
      expect(exitSpy).toHaveBeenCalledWith(1);
      rmSync(proj, { recursive: true, force: true });
    }, 20_000);
  });

  // ===============================================================================================
  // J5 — unreadable path.
  // ===============================================================================================

  it('J5 unreadable path: valid false, path echoed, workflow_id null, exit 1', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'realm-validate-json-j5-'));
    const missing = join(dir, 'nonexistent-dir');

    await expect(validateCommand.parseAsync([missing, '--json'], { from: 'user' })).rejects.toThrow(
      'process.exit',
    );

    const result = parseJson();
    expect(result['valid']).toBe(false);
    expect(result['path']).toBe(missing);
    expect(result['workflow_id']).toBeNull();
    expect(exitSpy).toHaveBeenCalledWith(1);
    rmSync(dir, { recursive: true, force: true });
  }, 20_000);

  // ===============================================================================================
  // J6/J6b/J6c — the extensions family: unresolvable module, a pass-2 config_schema violation
  // carrying a loader-minted warning, and the orphan-manifest special site.
  // ===============================================================================================

  describe('J6/J6b/J6c — the extensions family', () => {
    it('J6 unresolvable module, non-empty accumulated set: valid false, errors[0] starts "Error loading extensions:"', async () => {
      const proj = mkdtempSync(join(tmpdir(), 'realm-validate-json-j6-'));
      const workflowDir = join(proj, 'workflows', 'wf');
      mkdirSync(join(proj, 'dist'), { recursive: true });
      mkdirSync(workflowDir, { recursive: true });
      writeFileSync(join(proj, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
      // The :611 accumulated set must be NON-EMPTY (an AUTO step with retry-without-timeout).
      const p = writeWorkflow(
        workflowDir,
        `id: j6-wf
name: J6 WF
version: 1
extensions: ../../dist/does-not-exist.js
steps:
  s1:
    description: a
    execution: auto
    retry:
      max_attempts: 3
      backoff: fixed
      base_delay_ms: 10
`,
      );

      await expect(validateCommand.parseAsync([p, '--json'], { from: 'user' })).rejects.toThrow(
        'process.exit',
      );

      const result = parseJson();
      expect(result['valid']).toBe(false);
      const errors = result['errors'] as string[];
      expect(errors[0]).toMatch(/^Error loading extensions:/);
      const diagnostics = result['diagnostics'] as LoaderWarning[];
      expect(diagnostics[0]?.code).toBe('RETRY_NO_TIMEOUT');
      expect(exitSpy).toHaveBeenCalledWith(1);
      rmSync(proj, { recursive: true, force: true });
    }, 20_000);

    it('J6b (:621 pass-2) a config_schema violation via a RESOLVABLE module: diagnostics[0] is the loader-minted RETRY_INERT_NON_AUTO', async () => {
      const proj = mkdtempSync(join(tmpdir(), 'realm-validate-json-j6b-'));
      const workflowDir = join(proj, 'workflows', 'wf');
      mkdirSync(join(proj, 'dist'), { recursive: true });
      mkdirSync(workflowDir, { recursive: true });
      writeFileSync(join(proj, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
      writeFileSync(
        join(proj, 'dist', 'registry.js'),
        `
export default {
  adapters: {
    custom_adapter: {
      id: 'custom_adapter',
      config_schema: {
        type: 'object',
        required: ['needed_key'],
        properties: { needed_key: { type: 'string' } },
      },
      fetch: async () => ({ status: 200, data: {} }),
      create: async () => ({ status: 201, data: {} }),
      update: async () => ({ status: 200, data: {} }),
    },
  },
};
`,
        'utf8',
      );
      // The fixture ALSO declares retry: on an agent step — a warning-free fixture would make
      // this pin []-vacuous (verified: an agent+retry fixture with a hard error throws with
      // err.warnings: ['RETRY_INERT_NON_AUTO'] — the #424 attach carries it).
      const p = writeWorkflow(
        workflowDir,
        `id: j6b-wf
name: J6b WF
version: 1
extensions: ../../dist/registry.js
services:
  custom_svc:
    adapter: custom_adapter
    trust: engine_managed
steps:
  fetch_data:
    description: fetch
    execution: auto
    uses_service: custom_svc
    config:
      wrong_key: value
  agent_step:
    description: agent
    execution: agent
    retry:
      max_attempts: 3
      backoff: fixed
      base_delay_ms: 10
`,
      );

      await expect(validateCommand.parseAsync([p, '--json'], { from: 'user' })).rejects.toThrow(
        'process.exit',
      );

      const result = parseJson();
      expect(result['valid']).toBe(false);
      const errors = result['errors'] as string[];
      expect(errors[0]).toContain('config validation failed against adapter config_schema');
      const diagnostics = result['diagnostics'] as LoaderWarning[];
      expect(diagnostics[0]?.code).toBe('RETRY_INERT_NON_AUTO');
      expect(exitSpy).toHaveBeenCalledWith(1);
      rmSync(proj, { recursive: true, force: true });
    }, 20_000);

    it('J6c (:548 the ONE special site) orphaned manifest + a warning-bearing workflow: diagnostics = the accumulated set', async () => {
      const base = mkdtempSync(join(tmpdir(), 'realm-validate-json-j6c-'));
      writeFileSync(join(base, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
      const workflowDir = join(base, 'workflows', 'wf');
      mkdirSync(workflowDir, { recursive: true });
      const p = writeWorkflow(
        workflowDir,
        `id: j6c-wf
name: J6c WF
version: 1
steps:
  s1:
    description: a
    execution: auto
    retry:
      max_attempts: 3
      backoff: fixed
      base_delay_ms: 10
`,
      );
      writeFileSync(
        join(workflowDir, 'realm.yaml'),
        'version: 1\nadapters:\n  fs2:\n    use: filesystem\n',
        'utf8',
      );

      await expect(validateCommand.parseAsync([p, '--json'], { from: 'user' })).rejects.toThrow(
        'process.exit',
      );

      const result = parseJson();
      expect(result['valid']).toBe(false);
      expect(result['workflow_id']).toBe('j6c-wf');
      const diagnostics = result['diagnostics'] as LoaderWarning[];
      // The retry advisory present — the one special-site pin: this arm's diagnostics are the
      // ACCUMULATED set the human loop prints, never `err.warnings` (this orphan WorkflowError
      // is minted bare and carries none).
      expect(diagnostics[0]?.code).toBe('RETRY_NO_TIMEOUT');
      const errors = result['errors'] as string[];
      expect(errors[0]).toContain('will NOT be loaded');
      expect(exitSpy).toHaveBeenCalledWith(1);
      rmSync(base, { recursive: true, force: true });
    }, 20_000);
  });

  // ===============================================================================================
  // J7/J7b/J7c/J7d — registered mode (success, extensions+sentinels, load-failure, escalation).
  // ===============================================================================================

  describe('J7/J7b/J7c/J7d — registered mode', () => {
    it('J7 stored-and-valid: mode registered, schema_version set, path null, exit 0 (purity pins the suppressed headers)', async () => {
      plant('stored-wf', stored());

      await validateCommand.parseAsync(['--registered', 'stored-wf', '--json'], { from: 'user' });

      const result = parseJson();
      expect(result['valid']).toBe(true);
      expect(result['mode']).toBe('registered');
      expect(result['path']).toBeNull();
      expect(result['workflow_id']).toBe('stored-wf');
      expect(result['schema_version']).toBe(CURRENT_WORKFLOW_SCHEMA_VERSION);
      expect(exitSpy).not.toHaveBeenCalled();
      // Purity: neither header line, nor the honesty line, reached stdout.
      expect(logOut()).not.toContain('Auditing');
      expect(errOut()).toBe('');
    }, 20_000);

    it('J7b file-mode extensions success WITH a sentinel-credential warning: valid, EXTENSION_SENTINEL present, no manifest line', async () => {
      // The sentinel channel is DEPLOYMENT-MANIFEST-driven (realm.yaml's `use:`-declared
      // adapters/handlers, secretMode: 'sentinel'), not a workflow-level `extensions:` module
      // property — verified directly: a workflow with no realm.yaml manifest at its trust root
      // mints zero sentinel warnings regardless of what its own extensions module declares. The
      // workflow's own `extensions:` module here is a TRIVIAL, unrelated one — its only job is
      // to route this fixture into the extensions arm at all; the realm.yaml manifest at the
      // trust root is what actually trips sentinel mode via a constructor that throws.
      const proj = mkdtempSync(join(tmpdir(), 'realm-validate-json-j7b-'));
      const workflowDir = join(proj, 'workflows', 'wf');
      mkdirSync(join(proj, 'dist'), { recursive: true });
      mkdirSync(workflowDir, { recursive: true });
      writeFileSync(join(proj, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
      writeFileSync(join(proj, 'dist', 'registry.js'), 'export default {};\n', 'utf8');
      writeFileSync(
        join(proj, 'dist', 'factories.js'),
        `
export function throwingFactory({ id, config }) {
  throw new Error('bad credentials: ' + config.token);
}
`,
        'utf8',
      );
      writeFileSync(
        join(proj, 'realm.yaml'),
        `version: 1
adapters:
  boom:
    use: ./dist/factories.js#throwingFactory
    config: { token: "\${secret:MISSING_EVERYWHERE}" }
`,
        'utf8',
      );
      const p = writeWorkflow(
        workflowDir,
        `id: j7b-wf
name: J7b WF
version: 1
extensions: ../../dist/registry.js
steps:
  fetch_data:
    description: fetch
    execution: auto
`,
      );

      await validateCommand.parseAsync([p, '--json'], { from: 'user' });

      const result = parseJson();
      expect(result['valid']).toBe(true);
      const diagnostics = result['diagnostics'] as LoaderWarning[];
      expect(diagnostics.some((d) => d.code === 'EXTENSION_SENTINEL')).toBe(true);
      expect(logOut()).not.toContain('Extensions: ');
      expect(exitSpy).not.toHaveBeenCalled();
      rmSync(proj, { recursive: true, force: true });
    }, 20_000);

    it("J7c (:423 registered load-failure) the R1 shape + --json: workflow_id = requested, schema_version = CURRENT (the table's only pin of that claim)", async () => {
      plant(
        'stored-wf',
        stored({ steps: { a: { description: 'a', execution: 'agent', timeout_seconds: 60 } } }),
      );

      await expect(
        validateCommand.parseAsync(['--registered', 'stored-wf', '--json'], { from: 'user' }),
      ).rejects.toThrow('process.exit');

      const result = parseJson();
      expect(result['valid']).toBe(false);
      expect(result['workflow_id']).toBe('stored-wf');
      expect(result['schema_version']).toBe(CURRENT_WORKFLOW_SCHEMA_VERSION);
      const errors = result['errors'] as string[];
      expect(errors[0]).toContain("'timeout_seconds' is not valid on execution: agent steps");
      expect(exitSpy).toHaveBeenCalledWith(1);
    }, 20_000);

    it('J7d (:430 registered escalation) a stored dependson step key survives the RUNTIME_ONLY strip', async () => {
      plant(
        'stored-wf',
        stored({
          steps: { a: { description: 'a', execution: 'agent', dependson: ['nothing'] } },
        }),
      );

      await expect(
        validateCommand.parseAsync(['--registered', 'stored-wf', '--json'], { from: 'user' }),
      ).rejects.toThrow('process.exit');

      const result = parseJson();
      expect(result['valid']).toBe(false);
      const errors = result['errors'] as string[];
      expect(errors[0]).toMatch(/^Invalid: 1 warning/);
      expect(result['schema_version']).toBe(CURRENT_WORKFLOW_SCHEMA_VERSION);
      expect(result['workflow_id']).toBe('stored-wf');
      expect(exitSpy).toHaveBeenCalledWith(1);
    }, 20_000);
  });

  // ===============================================================================================
  // J8/J8b/J9 — registered not-found, legacy, corrupt-JSON.
  // ===============================================================================================

  describe('J8/J8b/J9 — registered failure-before-parse', () => {
    it('J8 not-found: workflow_id = requested id, errors contains "Workflow not found", no Error: prefix', async () => {
      await expect(
        validateCommand.parseAsync(['--registered', 'no-such-wf', '--json'], { from: 'user' }),
      ).rejects.toThrow('process.exit');

      const result = parseJson();
      expect(result['valid']).toBe(false);
      expect(result['workflow_id']).toBe('no-such-wf');
      const errors = result['errors'] as string[];
      expect(errors[0]).toContain('Workflow not found');
      expect(errors[0]).not.toMatch(/^Error: /);
      expect(exitSpy).toHaveBeenCalledWith(1);
    }, 20_000);

    it("J8b legacy (schema_version-less): errors = the store's own re-register message, schema_version null", async () => {
      plant('ancient-wf', { id: 'ancient-wf', name: 'Ancient', version: 2 });

      await expect(
        validateCommand.parseAsync(['--registered', 'ancient-wf', '--json'], { from: 'user' }),
      ).rejects.toThrow('process.exit');

      const result = parseJson();
      expect(result['valid']).toBe(false);
      expect(result['schema_version']).toBeNull();
      const errors = result['errors'] as string[];
      expect(errors[0]).toContain('registered with an older version of Realm');
      expect(exitSpy).toHaveBeenCalledWith(1);
    }, 20_000);

    it("J9 corrupt-JSON: errors contains 'not parseable JSON', exit 1", async () => {
      writeFileSync(join(wfDir, 'broken.json'), '{ not json', 'utf8');

      await expect(
        validateCommand.parseAsync(['--registered', 'broken', '--json'], { from: 'user' }),
      ).rejects.toThrow('process.exit');

      const result = parseJson();
      expect(result['valid']).toBe(false);
      const errors = result['errors'] as string[];
      expect(errors[0]).toContain('not parseable JSON');
      expect(exitSpy).toHaveBeenCalledWith(1);
    }, 20_000);
  });

  // ===============================================================================================
  // J11 — the nudge/--explain suppression (a NUDGE-DRAWING fixture; J1's auto step draws none).
  // ===============================================================================================

  describe('J11 — the nudge is suppressed under --json, with and without --explain/REALM_NO_NUDGE', () => {
    function makeNudgeFixture(dir: string): string {
      return writeWorkflow(
        dir,
        `id: j11-wf
name: J11 WF
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
`,
      );
    }

    it('the human leg PRINTS the nudge (non-vacuity control)', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'realm-validate-json-j11-control-'));
      const p = makeNudgeFixture(dir);

      await validateCommand.parseAsync([p], { from: 'user' });

      expect(logOut()).toContain('one change away from structured_output: strict');
      rmSync(dir, { recursive: true, force: true });
    }, 20_000);

    it('--json alone: the bare object, no nudge line', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'realm-validate-json-j11-a-'));
      const p = makeNudgeFixture(dir);

      await validateCommand.parseAsync([p, '--json'], { from: 'user' });

      const result = parseJson();
      expect(result['valid']).toBe(true);
      rmSync(dir, { recursive: true, force: true });
    }, 20_000);

    it('--json --explain: --explain is INERT — still the bare object, no per-step detail', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'realm-validate-json-j11-b-'));
      const p = makeNudgeFixture(dir);

      await validateCommand.parseAsync([p, '--json', '--explain'], { from: 'user' });

      parseJson(); // one call, still parseable — the same purity assert
      rmSync(dir, { recursive: true, force: true });
    }, 20_000);

    it('--json with REALM_NO_NUDGE=1: still the bare object (the env var is irrelevant to --json)', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'realm-validate-json-j11-c-'));
      const p = makeNudgeFixture(dir);
      process.env['REALM_NO_NUDGE'] = '1';

      await validateCommand.parseAsync([p, '--json'], { from: 'user' });

      parseJson();
      rmSync(dir, { recursive: true, force: true });
    }, 20_000);
  });

  // ===============================================================================================
  // J10 — purity + parity, table-driven over the whole family (incl. every per-member sibling;
  // J11's legs live in its own cell above, J12 is non-contract by design). Each scenario mirrors
  // its own dedicated cell's fixture EXACTLY (same shape, same reachable arm) so this walk proves
  // the invariant holds FAMILY-WIDE, not just at the 18 individually-typed pins above. Adds one
  // --strict leg on J7's registered-success scenario — the registered strict fork has no other
  // cell.
  // ===============================================================================================

  describe('J10 — purity + parity, table-driven over the whole family', () => {
    interface J10Scenario {
      name: string;
      /** Builds whatever files/registered entries are needed; returns the CLI args EXCLUDING
       *  --json (the runner appends it for the json leg, and reuses the same args bare for the
       *  human leg — same fixture, both legs, since validate never mutates what it reads). */
      setup: () => string[];
    }

    it('walks every family scenario: json parses as one object, exit parity, stderr silent, counts match', async () => {
      const createdDirs: string[] = [];
      function tmp(prefix: string): string {
        const d = mkdtempSync(join(tmpdir(), `realm-validate-json-j10-${prefix}-`));
        createdDirs.push(d);
        return d;
      }

      const scenarios: J10Scenario[] = [
        {
          name: 'J1 warn-only',
          setup: () => [
            writeWorkflow(
              tmp('j1'),
              `id: t-j1
name: T
version: 1
steps:
  s1:
    description: a
    execution: auto
    retry:
      max_attempts: 3
      backoff: fixed
      base_delay_ms: 10
`,
            ),
          ],
        },
        {
          name: 'J2 warn-only --strict',
          setup: () => [
            writeWorkflow(
              tmp('j2'),
              `id: t-j2
name: T
version: 1
steps:
  s1:
    description: a
    execution: auto
    retry:
      max_attempts: 3
      backoff: fixed
      base_delay_ms: 10
`,
            ),
            '--strict',
          ],
        },
        {
          name: 'J3 escalated dependson',
          setup: () => [
            writeWorkflow(
              tmp('j3'),
              `id: t-j3
name: T
version: 1
steps:
  s1:
    description: a
    execution: auto
    dependson: [nothing]
`,
            ),
          ],
        },
        {
          name: 'J3b escalated + --strict',
          setup: () => [
            writeWorkflow(
              tmp('j3b'),
              `id: t-j3b
name: T
version: 1
steps:
  s1:
    description: a
    execution: auto
    dependson: [nothing]
`,
            ),
            '--strict',
          ],
        },
        {
          name: 'J3c (correction) the extensions-arm escalation fork',
          setup: () => {
            const proj = tmp('j3c');
            const workflowDir = join(proj, 'workflows', 'wf');
            mkdirSync(join(proj, 'dist'), { recursive: true });
            mkdirSync(workflowDir, { recursive: true });
            writeFileSync(join(proj, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
            writeFileSync(join(proj, 'dist', 'registry.js'), 'export default {};\n', 'utf8');
            return [
              writeWorkflow(
                workflowDir,
                `id: t-j3c
name: T
version: 1
extensions: ../../dist/registry.js
steps:
  s1:
    description: a
    execution: auto
    dependson: [nothing]
`,
              ),
            ];
          },
        },
        {
          name: 'J4 multi-error (extension-free)',
          setup: () => [
            writeWorkflow(
              tmp('j4'),
              `id: t-j4
name: T
version: 1
steps:
  step-one:
    description: a
    execution: agent
    timeout_seconds: 60
    dependson: [nothing]
  step-two:
    description: b
    execution: agent
    timeout_seconds: 30
`,
            ),
          ],
        },
        {
          name: 'J4b multi-error (:580 extensions arm pass-1)',
          setup: () => {
            const proj = tmp('j4b');
            const workflowDir = join(proj, 'workflows', 'wf');
            mkdirSync(join(proj, 'dist'), { recursive: true });
            mkdirSync(workflowDir, { recursive: true });
            writeFileSync(join(proj, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
            // Pass-1 fails before module resolution — no registry.js file needed (mirrors J4b).
            return [
              writeWorkflow(
                workflowDir,
                `extensions: ../../dist/registry.js
id: t-j4b
name: T
version: 1
steps:
  step-one:
    description: a
    execution: agent
    timeout_seconds: 60
    dependson: [nothing]
  step-two:
    description: b
    execution: agent
    timeout_seconds: 30
`,
              ),
            ];
          },
        },
        {
          name: 'J5 unreadable path',
          setup: () => [join(tmp('j5'), 'nonexistent-dir')],
        },
        {
          name: 'J6 unresolvable extensions module',
          setup: () => {
            const proj = tmp('j6');
            const workflowDir = join(proj, 'workflows', 'wf');
            mkdirSync(join(proj, 'dist'), { recursive: true });
            mkdirSync(workflowDir, { recursive: true });
            writeFileSync(join(proj, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
            return [
              writeWorkflow(
                workflowDir,
                `id: t-j6
name: T
version: 1
extensions: ../../dist/does-not-exist.js
steps:
  s1:
    description: a
    execution: auto
    retry:
      max_attempts: 3
      backoff: fixed
      base_delay_ms: 10
`,
              ),
            ];
          },
        },
        {
          name: 'J6b (:621 pass-2) config_schema violation via a resolvable module',
          setup: () => {
            const proj = tmp('j6b');
            const workflowDir = join(proj, 'workflows', 'wf');
            mkdirSync(join(proj, 'dist'), { recursive: true });
            mkdirSync(workflowDir, { recursive: true });
            writeFileSync(join(proj, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
            writeFileSync(
              join(proj, 'dist', 'registry.js'),
              `
export default {
  adapters: {
    custom_adapter: {
      id: 'custom_adapter',
      config_schema: {
        type: 'object',
        required: ['needed_key'],
        properties: { needed_key: { type: 'string' } },
      },
      fetch: async () => ({ status: 200, data: {} }),
      create: async () => ({ status: 201, data: {} }),
      update: async () => ({ status: 200, data: {} }),
    },
  },
};
`,
              'utf8',
            );
            return [
              writeWorkflow(
                workflowDir,
                `id: t-j6b
name: T
version: 1
extensions: ../../dist/registry.js
services:
  custom_svc:
    adapter: custom_adapter
    trust: engine_managed
steps:
  fetch_data:
    description: fetch
    execution: auto
    uses_service: custom_svc
    config:
      wrong_key: value
  agent_step:
    description: agent
    execution: agent
    retry:
      max_attempts: 3
      backoff: fixed
      base_delay_ms: 10
`,
              ),
            ];
          },
        },
        {
          name: 'J6c (:548 the special site) orphaned manifest',
          setup: () => {
            const base = tmp('j6c');
            writeFileSync(join(base, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
            const workflowDir = join(base, 'workflows', 'wf');
            mkdirSync(workflowDir, { recursive: true });
            const p = writeWorkflow(
              workflowDir,
              `id: t-j6c
name: T
version: 1
steps:
  s1:
    description: a
    execution: auto
    retry:
      max_attempts: 3
      backoff: fixed
      base_delay_ms: 10
`,
            );
            writeFileSync(
              join(workflowDir, 'realm.yaml'),
              'version: 1\nadapters:\n  fs2:\n    use: filesystem\n',
              'utf8',
            );
            return [p];
          },
        },
        {
          name: 'J7 registered success',
          setup: () => {
            plant('t-j7', stored({ id: 't-j7' }));
            return ['--registered', 't-j7'];
          },
        },
        {
          name: 'J7-strict registered success + --strict (the only --strict leg this fork gets)',
          setup: () => {
            plant('t-j7-strict', stored({ id: 't-j7-strict' }));
            return ['--registered', 't-j7-strict', '--strict'];
          },
        },
        {
          name: 'J7b file-mode extensions + sentinel credential',
          setup: () => {
            const proj = tmp('j7b');
            const workflowDir = join(proj, 'workflows', 'wf');
            mkdirSync(join(proj, 'dist'), { recursive: true });
            mkdirSync(workflowDir, { recursive: true });
            writeFileSync(join(proj, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
            writeFileSync(join(proj, 'dist', 'registry.js'), 'export default {};\n', 'utf8');
            writeFileSync(
              join(proj, 'dist', 'factories.js'),
              `
export function throwingFactory({ id, config }) {
  throw new Error('bad credentials: ' + config.token);
}
`,
              'utf8',
            );
            writeFileSync(
              join(proj, 'realm.yaml'),
              `version: 1
adapters:
  boom:
    use: ./dist/factories.js#throwingFactory
    config: { token: "\${secret:MISSING_EVERYWHERE}" }
`,
              'utf8',
            );
            return [
              writeWorkflow(
                workflowDir,
                `id: t-j7b
name: T
version: 1
extensions: ../../dist/registry.js
steps:
  fetch_data:
    description: fetch
    execution: auto
`,
              ),
            ];
          },
        },
        {
          name: 'J7c (:423) registered load-failure',
          setup: () => {
            plant(
              't-j7c',
              stored({
                id: 't-j7c',
                steps: { a: { description: 'a', execution: 'agent', timeout_seconds: 60 } },
              }),
            );
            return ['--registered', 't-j7c'];
          },
        },
        {
          name: 'J7d (:430) registered escalation',
          setup: () => {
            plant(
              't-j7d',
              stored({
                id: 't-j7d',
                steps: { a: { description: 'a', execution: 'agent', dependson: ['nothing'] } },
              }),
            );
            return ['--registered', 't-j7d'];
          },
        },
        {
          name: 'J8 registered not-found',
          setup: () => ['--registered', 'no-such-wf-j10'],
        },
        {
          name: 'J8b registered legacy',
          setup: () => {
            plant('t-j8b', { id: 't-j8b', name: 'Legacy', version: 2 });
            return ['--registered', 't-j8b'];
          },
        },
        {
          name: 'J9 registered corrupt-JSON',
          setup: () => {
            writeFileSync(join(wfDir, 'broken-j10.json'), '{ not json', 'utf8');
            return ['--registered', 'broken-j10'];
          },
        },
      ];

      try {
        for (const scenario of scenarios) {
          const args = scenario.setup();

          // --- the JSON leg ---
          logSpy.mockClear();
          warnSpy.mockClear();
          errSpy.mockClear();
          exitSpy.mockClear();
          let jsonExit: number | undefined;
          try {
            await validateCommand.parseAsync([...args, '--json'], { from: 'user' });
          } catch (err) {
            expect(String(err), `${scenario.name}: json leg threw`).toContain('process.exit');
            const call = exitSpy.mock.calls[0] as unknown[] | undefined;
            jsonExit = call?.[0] as number | undefined;
          }
          // (a) exactly one console.log call, and it parses as one object — the purity assert.
          expect(logSpy.mock.calls, `${scenario.name}: json leg log-call count`).toHaveLength(1);
          const result = JSON.parse(String(logSpy.mock.calls[0]![0])) as Record<string, unknown>;
          // (c) stderr silent on the json leg.
          expect(errOut(), `${scenario.name}: json leg stderr`).toBe('');
          // (d) the counts agree with the arrays they describe.
          const errors = result['errors'] as unknown[];
          const diagnostics = result['diagnostics'] as unknown[];
          expect(result['error_count'], `${scenario.name}: error_count`).toBe(errors.length);
          expect(result['warning_count'], `${scenario.name}: warning_count`).toBe(
            diagnostics.length,
          );
          if (jsonExit === undefined) {
            expect(exitSpy, `${scenario.name}: json leg exit`).not.toHaveBeenCalled();
          }

          // --- the human leg (same fixture, no --json) ---
          logSpy.mockClear();
          warnSpy.mockClear();
          errSpy.mockClear();
          exitSpy.mockClear();
          let humanExit: number | undefined;
          try {
            await validateCommand.parseAsync(args, { from: 'user' });
          } catch (err) {
            expect(String(err), `${scenario.name}: human leg threw`).toContain('process.exit');
            const call = exitSpy.mock.calls[0] as unknown[] | undefined;
            humanExit = call?.[0] as number | undefined;
          }

          // (b) exit parity — the SAME scenario's json and human legs agree, never hardcoded.
          expect(
            humanExit,
            `${scenario.name}: exit parity (json exit was ${String(jsonExit)})`,
          ).toBe(jsonExit);
        }
      } finally {
        for (const d of createdDirs) rmSync(d, { recursive: true, force: true });
      }
    }, 120_000);
  });

  // ===============================================================================================
  // J12 — the usage-error class: NOT under the contract, human + exit 1 regardless of --json.
  // ===============================================================================================

  it('J12 usage error (path + --registered + --json): the exact sentence, logSpy never called, exit 1', async () => {
    await expect(
      validateCommand.parseAsync(['some/path', '--registered', 'stored-wf', '--json'], {
        from: 'user',
      }),
    ).rejects.toThrow('process.exit');

    expect(errOut()).toContain(
      'Error: --registered audits the stored copy — it cannot be combined with a path.',
    );
    expect(logSpy).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  }, 20_000);
});
