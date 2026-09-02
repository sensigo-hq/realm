// Tests for loadWorkflowForRegistration — register/watch MINT the trust decision:
// full module load + duck validation + config_schema two-pass BEFORE persisting.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadWorkflowForRegistration, registerCommand } from './register.js';
import { clearProjectExtensionsCache } from '../extensions/load-project-extensions.js';

let proj: string;
let workflowDir: string;

beforeEach(() => {
  clearProjectExtensionsCache();
  proj = mkdtempSync(join(tmpdir(), 'realm-register-ext-'));
  workflowDir = join(proj, 'workflows', 'wf');
  mkdirSync(join(proj, 'dist'), { recursive: true });
  mkdirSync(workflowDir, { recursive: true });
  writeFileSync(join(proj, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
});

afterEach(() => {
  rmSync(proj, { recursive: true, force: true });
});

const BASE_YAML = `
id: reg-wf
name: Register WF
version: 1
steps:
  s1:
    description: step
    execution: agent
`;

function writeWorkflow(content: string): string {
  const file = join(workflowDir, 'workflow.yaml');
  writeFileSync(file, content, 'utf8');
  return file;
}

describe('loadWorkflowForRegistration', () => {
  it('extension-free workflows load exactly as before (no loader involvement)', async () => {
    const { definition } = await loadWorkflowForRegistration(writeWorkflow(BASE_YAML));
    expect(definition.id).toBe('reg-wf');
    expect(definition.extensions).toBeUndefined();
  });

  it('a declaring workflow loads + duck-validates its modules and stamps resolution metadata', async () => {
    writeFileSync(
      join(proj, 'dist', 'registry.js'),
      `export default { handlers: { h1: { id: 'h1', execute: async () => ({ data: {} }) } } };`,
      'utf8',
    );
    const { definition } = await loadWorkflowForRegistration(
      writeWorkflow(`${BASE_YAML}extensions: ../../dist/registry.js\n`),
    );
    expect(definition.extensions).toEqual(['../../dist/registry.js']);
    expect(definition.source_dir).toBe(workflowDir);
    expect(definition.trust_root).toBe(proj);
  });

  it('a broken module fails registration BEFORE anything would be persisted', async () => {
    writeFileSync(join(proj, 'dist', 'registry.js'), `export default { handler: {} };`, 'utf8');
    await expect(
      loadWorkflowForRegistration(
        writeWorkflow(`${BASE_YAML}extensions: ../../dist/registry.js\n`),
      ),
    ).rejects.toThrow(/unknown key 'handler'/);
  });

  it('a custom adapter config_schema violation fails registration (two-pass)', async () => {
    writeFileSync(
      join(proj, 'dist', 'registry.js'),
      `export default { adapters: { custom_adapter: {
        id: 'custom_adapter',
        config_schema: { type: 'object', required: ['needed_key'] },
        fetch: async () => ({ status: 200, data: {} }),
        create: async () => ({ status: 201, data: {} }),
        update: async () => ({ status: 200, data: {} }),
      } } };`,
      'utf8',
    );
    const yaml = `
id: reg-wf
name: Register WF
version: 1
extensions: ../../dist/registry.js
services:
  custom_svc:
    adapter: custom_adapter
    trust: engine_managed
steps:
  s1:
    description: step
    execution: auto
    uses_service: custom_svc
    config:
      wrong_key: x
`;
    await expect(loadWorkflowForRegistration(writeWorkflow(yaml))).rejects.toThrow(
      /config validation failed against adapter config_schema/,
    );
  });
});

// =================================================================================================
// issue #451 — the extensions sentence at register's catch, driven through the COMMAND
// =================================================================================================
//
// loadWorkflowForRegistration tags every failure out of its extensions block ExtensionLoadError,
// and register's catch renders the tag as `Error loading extensions:` — the sentence run and
// validate already print. The helper alone cannot show a render, so these cells drive
// registerCommand end to end: spies on the three channels, a throwing exit spy, and a scratch $HOME
// for the store it constructs (the register-strict.test.ts idiom). They reuse this file's project
// tree — trust root, dist/, the workflow under workflows/wf.
describe('register — `Error loading extensions:` (issue #451)', () => {
  let home: string;
  let originalHome: string | undefined;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'realm-register-ext-home-'));
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

  const joined = (spy: ReturnType<typeof vi.spyOn>): string =>
    spy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');

  // ONE manifest for both sentinel cells, on purpose: the only thing that differs between
  // "degrades and registers" and "fails at the retry" is whether ./dist/mod.js carries the export
  // the manifest names — so a red in one of them can only be that. (The export is spelled
  // MissingExport in both; the name is the manifest's reference, not a claim about the module.)
  // Shape executed on the built CLI first (the cells lane, #451), including the secret that is
  // absent by construction: no .env is ever written here.
  const SENTINEL_MANIFEST = `version: 1
secrets:
  sources: [dotenv]
handlers:
  h1:
    use: ./dist/mod.js#MissingExport
    config:
      token: "\${secret:ABSENT_TOKEN}"
`;
  const WORKING_MODULE = `export function MissingExport({ id, config }) {
  return { id, token: config.token, async execute() { return { output: {} }; } };
}
`;
  const EXPORTLESS_MODULE = `export function presentExport() {}\n`;

  it('R2 a module that cannot be resolved reports `Error loading extensions:`, exit 1', async () => {
    // Red-first on main: `Error: Cannot resolve extension module '../../dist/does-not-exist.js'
    // of workflow 'reg-wf' (resolved: …): ENOENT …` — the bare prefix, the #417 default for a
    // message that does not announce itself. Run and validate had been saying which stage failed
    // since #445; register did not.
    const file = writeWorkflow(`${BASE_YAML}extensions: ../../dist/does-not-exist.js\n`);

    await expect(registerCommand.parseAsync([file], { from: 'user' })).rejects.toThrow(
      'process.exit',
    );

    expect(exitSpy).toHaveBeenCalledWith(1);
    const errored = joined(errSpy);
    expect(errored).toMatch(
      /^Error loading extensions: Cannot resolve extension module '\.\.\/\.\.\/dist\/does-not-exist\.js' of workflow 'reg-wf'/m,
    );
    expect(errored).not.toContain('Error: Cannot');
    expect(joined(logSpy)).not.toContain('Registered:');
    // issue #463 — the ABSENT side of the warnings carry, observable: a clean workflow carries
    // nothing, so nothing prints on warn (lane-executed on main: warn count 0). ABSENT-never-[]
    // is what keeps the catch's guard from ever printing an empty block here.
    expect(warnSpy.mock.calls.filter((c: unknown[]) => String(c[0]).startsWith('⚠'))).toHaveLength(
      0,
    );
  });

  // issue #463 — the same BASE_YAML with a typo'd step key: pass-1 warns (unknown key + did-you-
  // mean), and the question is whether that warning survives an extensions failure.
  const TYPO_YAML = `${BASE_YAML}    dependson: [nothing]\n`;

  it("C1 the workflow's own warnings print BEFORE the extensions sentence (issue #463)", async () => {
    // Red-first on main: exactly one line, on error — `Error loading extensions: Cannot resolve …`
    // — and NOTHING on warn. The unknown-key warning and its did-you-mean vanished, so the author
    // fixed the module, re-ran, and only then learned about the typo. `realm run` prints the
    // warning first; register now matches it byte for byte.
    const file = writeWorkflow(`${TYPO_YAML}extensions: ../../dist/does-not-exist.js\n`);

    await expect(registerCommand.parseAsync([file], { from: 'user' })).rejects.toThrow(
      'process.exit',
    );

    expect(exitSpy).toHaveBeenCalledWith(1);
    const warned = joined(warnSpy);
    // The PLAIN form — the render-choice tooth. printLoaderWarnings would write `— REFUSED below`
    // here, and what is below is the extensions error, not this warning's escalation: a false
    // cause. `— ignored` is the core's statement about the parse, true on every surface.
    expect(warned).toContain("⚠ step 's1': unknown key 'dependson'");
    expect(warned).toContain("— ignored (did you mean 'depends_on'?)");
    expect(warned).not.toContain('REFUSED below');
    const errored = joined(errSpy);
    expect(errored).toMatch(
      /^Error loading extensions: Cannot resolve extension module '\.\.\/\.\.\/dist\/does-not-exist\.js' of workflow 'reg-wf'/m,
    );
    // Warning BEFORE the sentence — two channels, so vitest's global invocation order
    // (register-strict.test.ts's idiom). With the carry dropped this conjunct passes VACUOUSLY
    // (Math.max of an empty spread is -Infinity): the content conjuncts above are the carry's
    // teeth; this one pins only the order.
    expect(Math.max(...warnSpy.mock.invocationCallOrder)).toBeLessThan(
      Math.min(...errSpy.mock.invocationCallOrder),
    );
    expect(joined(logSpy)).not.toContain('Registered:');
  });

  it("C2 the carry rides site (b) too — the sentinel retry's failure prints the warning first", async () => {
    // S2's fixture plus the typo. Red-first on main: the two degradation ⚠ lines, then the
    // sentence — no typo warning anywhere. Per-member: site (b)'s carry is otherwise unpinned.
    // Executed shape (verify-first, on the built CLI): THREE warn calls, in this order — the
    // secrets refusal (one multi-line message), the SENTINEL line, the carried `— ignored`
    // warning; then the sentence on error.
    writeFileSync(join(proj, 'realm.yaml'), SENTINEL_MANIFEST, 'utf8');
    writeFileSync(join(proj, 'dist', 'mod.js'), EXPORTLESS_MODULE, 'utf8');
    const file = writeWorkflow(TYPO_YAML);

    await expect(registerCommand.parseAsync([file], { from: 'user' })).rejects.toThrow(
      'process.exit',
    );

    expect(exitSpy).toHaveBeenCalledWith(1);
    const warnCalls = warnSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(warnCalls).toHaveLength(3);
    expect(warnCalls[0]).toContain(
      '⚠ Deployment manifest secrets: 1 unresolved secret reference(s):',
    );
    expect(warnCalls[1]).toBe(
      '⚠ Registering with SENTINEL credentials — execution paths still require real secret resolution.',
    );
    expect(warnCalls[2]).toContain("⚠ step 's1': unknown key 'dependson'");
    expect(warnCalls[2]).toContain("— ignored (did you mean 'depends_on'?)");
    expect(joined(warnSpy)).not.toContain('REFUSED below');
    expect(joined(errSpy)).toMatch(
      /^Error loading extensions: Deployment manifest '[^']*realm\.yaml': handlers\.h1 — module '\.\/dist\/mod\.js#MissingExport' has no export 'MissingExport'/m,
    );
    expect(Math.max(...warnSpy.mock.invocationCallOrder)).toBeLessThan(
      Math.min(...errSpy.mock.invocationCallOrder),
    );
  });

  it('S1 CONTROL: unresolvable manifest secrets still DEGRADE to a sentinel registration', async () => {
    // Green on main and green after #451 — its teeth show only under the likeliest wrong
    // implementation of site (a): replacing the whole `if (!(err instanceof ManifestSecretsError))
    // throw err;` with an unconditional `throw new ExtensionLoadError(err)`. That kills
    // degradation: the secrets failure leaves as an extensions error. Executed, that mutant reds
    // this cell, S2 below (it asserts degradation ran), and load-project-manifest.test.ts's
    // consumer-shape E2E (`toContain('SENTINEL')` on warn, through the helper) — and it does not
    // typecheck either, since the guard is also the narrowing `err.message` needs. What this cell
    // adds is register's OWN home, through the COMMAND, the whole chain asserted: both sentinel
    // lines, the registration line, exit 0, stderr silent.
    writeFileSync(join(proj, 'realm.yaml'), SENTINEL_MANIFEST, 'utf8');
    writeFileSync(join(proj, 'dist', 'mod.js'), WORKING_MODULE, 'utf8');
    const file = writeWorkflow(BASE_YAML);

    await registerCommand.parseAsync([file], { from: 'user' });

    expect(exitSpy).not.toHaveBeenCalled();
    expect(errSpy).not.toHaveBeenCalled();
    const warned = joined(warnSpy);
    expect(warned).toContain('⚠ Deployment manifest secrets: 1 unresolved secret reference(s):');
    expect(warned).toContain('handlers.h1.config.token → ${secret:ABSENT_TOKEN}');
    expect(warned).toContain(
      '⚠ Registering with SENTINEL credentials — execution paths still require real secret resolution.',
    );
    expect(joined(logSpy)).toContain('Registered: reg-wf v1 (1 step)');
  });

  it('S2 a failure at the SENTINEL RETRY — site (b) — reports `Error loading extensions:` too', async () => {
    // The module exists and lacks the export the manifest names. In real mode the secrets resolve
    // BEFORE the manifest's entry loop runs (applyDeploymentManifest), so the absent secret throws
    // first and degradation runs; the retry resolves every name to a sentinel — it has no throw
    // path of its own — and reaches the entry loop for the first time, where pickExport throws a
    // plain Error out of the RETRY call only. The wrap at site (a) never sees it. Red-first on
    // main: `Error: Deployment manifest '…/realm.yaml': handlers.h1 — module './dist/mod.js#MissingExport'
    // has no export 'MissingExport'. Available exports: presentExport.`
    writeFileSync(join(proj, 'realm.yaml'), SENTINEL_MANIFEST, 'utf8');
    writeFileSync(join(proj, 'dist', 'mod.js'), EXPORTLESS_MODULE, 'utf8');
    const file = writeWorkflow(BASE_YAML);

    await expect(registerCommand.parseAsync([file], { from: 'user' })).rejects.toThrow(
      'process.exit',
    );

    expect(exitSpy).toHaveBeenCalledWith(1);
    // Degradation DID run — the retry is where it failed.
    expect(joined(warnSpy)).toContain('⚠ Registering with SENTINEL credentials');
    const errored = joined(errSpy);
    expect(errored).toMatch(
      /^Error loading extensions: Deployment manifest '[^']*realm\.yaml': handlers\.h1 — module '\.\/dist\/mod\.js#MissingExport' has no export 'MissingExport'\. Available exports: presentExport\.$/m,
    );
    expect(errored).not.toMatch(/^Error: Deployment manifest/m);
    expect(joined(logSpy)).not.toContain('Registered:');
  });
});
