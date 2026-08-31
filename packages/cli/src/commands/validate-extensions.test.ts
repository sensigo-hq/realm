// Spawn-based tests for `realm workflow validate` with project extensions:
//  - extension-free workflows keep the EXACT current output (golden test on a repo example);
//  - a declaring workflow gets config_schema two-pass validation against the resolved
//    registry (a custom adapter config violation is caught at validate time).
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST_CLI = join(CLI_DIR, 'dist', 'index.js');
const REPO_ROOT = join(CLI_DIR, '..', '..');

function runValidate(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [DIST_CLI, 'workflow', 'validate', ...args],
      { timeout: 15_000 },
      (err, stdout, stderr) => {
        const code = err !== null && typeof err.code === 'number' ? err.code : err !== null ? 1 : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

// issue #422: the golden and the order cell below both assert a summary line that
// `REALM_NO_NUDGE=1` suppresses, so an operator with it exported in their shell would red them.
// `execFile` is given no `env`, so the child inherits the caller's LIVE `process.env` at call
// time — clearing it here is visible to the spawned CLI, no explicit spawn-env needed. (Verified
// by defanging this delete under an ambient export: exactly these two cells red.)
let savedNoNudge: string | undefined;
beforeEach(() => {
  savedNoNudge = process.env['REALM_NO_NUDGE'];
  delete process.env['REALM_NO_NUDGE'];
});
afterEach(() => {
  if (savedNoNudge === undefined) delete process.env['REALM_NO_NUDGE'];
  else process.env['REALM_NO_NUDGE'] = savedNoNudge;
});

describe('realm workflow validate — golden (extension-free byte-identical)', () => {
  // issue #236 gave this golden the structured_output nudge's own INFO lines — the sweep added
  // `additionalProperties: false` to this example's step schemas (Deliverable 8), making both
  // agent steps eligible_with_caveats (pattern/minLength/maxLength are all post-hoc-only under
  // strict). issue #422 then collapsed those NINE per-caveat lines — seven for `identify_ticket`,
  // two for `classify_ticket`, neither step opted in — into the ONE aggregate line below. The
  // detail is not gone; it is behind `validate --explain`. Updated deliberately, not a silent
  // snapshot bump — see the report.
  it('validates the existing ticket-classifier example with the exact current output', async () => {
    const { code, stdout, stderr } = await runValidate([
      join(REPO_ROOT, 'examples', '02-ticket-classifier', 'workflow.yaml'),
    ]);
    expect(stderr).toBe('');
    expect(stdout).toBe(
      'Valid: ticket-classifier v1 (4 steps)\n' +
        "ℹ 2 steps ready for structured_output: strict (2 with caveats) — run 'realm workflow validate --explain' for detail (REALM_NO_NUDGE=1 to silence).\n",
    );
    expect(code).toBe(0);
  }, 20_000);
});

describe('realm workflow validate — declaring workflow (config_schema two-pass)', () => {
  let proj: string;
  let workflowDir: string;

  const ADAPTER_MODULE = `
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
`;

  function workflowYaml(config: string): string {
    return `
id: cfg-wf
name: Config WF
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
${config}
`;
  }

  beforeAll(() => {
    proj = mkdtempSync(join(tmpdir(), 'realm-validate-ext-'));
    workflowDir = join(proj, 'workflows', 'wf');
    mkdirSync(join(proj, 'dist'), { recursive: true });
    mkdirSync(workflowDir, { recursive: true });
    writeFileSync(join(proj, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
    writeFileSync(join(proj, 'dist', 'registry.js'), ADAPTER_MODULE, 'utf8');
  });

  afterAll(() => {
    rmSync(proj, { recursive: true, force: true });
  });

  it('catches a custom adapter config_schema violation at validate time (pass 2)', async () => {
    const file = join(workflowDir, 'workflow.yaml');
    writeFileSync(file, workflowYaml('      wrong_key: value'), 'utf8');
    const { code, stderr } = await runValidate([file]);
    expect(code).toBe(1);
    expect(stderr).toContain('config validation failed against adapter config_schema');
    // issue #445: this is a WORKFLOW refusal reaching the chokepoint, not an internal bug — so
    // no stack. The fragment above would match INSIDE a stack trace too, so without this
    // conjunct a pass-2 crash rendering as a rethrow would still look like a pass.
    expect(stderr).not.toContain('    at ');
  }, 20_000);

  it('passes when the config satisfies the custom adapter config_schema', async () => {
    const file = join(workflowDir, 'workflow.yaml');
    writeFileSync(file, workflowYaml('      needed_key: value'), 'utf8');
    const { code, stdout } = await runValidate([file]);
    expect(stdout).toContain('Valid: cfg-wf v1 (1 step)');
    expect(stdout).toContain('Extensions: ../../dist/registry.js');
    expect(code).toBe(0);
  }, 20_000);

  it('(b) an unresolvable extension module blames the EXTENSIONS, not the workflow', async () => {
    // issue #445. This used to print `Invalid: Cannot resolve extension module '…' … ENOENT …`
    // — the workflow called invalid because a module beside it was missing, sending the author
    // to the wrong file. `realm run` has always rendered this exact failure class as
    // `Error loading extensions:`; validate says the same thing now.
    const file = join(workflowDir, 'ext-missing.yaml');
    writeFileSync(
      file,
      `
id: ext-missing
name: Ext Missing
version: 1
extensions: ../../dist/does-not-exist.js
steps:
  fetch_data:
    description: fetch
    execution: auto
    handler: h
`,
      'utf8',
    );

    const { code, stderr } = await runValidate([file]);
    expect(code).toBe(1);
    expect(stderr).toContain('Error loading extensions:');
    expect(stderr).toContain('Cannot resolve extension module');
    expect(stderr).not.toContain('Invalid:');
    // Not an internal bug either — the extensions catch renders a sentence, never a stack.
    expect(stderr).not.toContain('    at ');
  }, 20_000);

  it('(e) the orphaned-manifest refusal joins the extensions family on this arm', async () => {
    // issue #445, the disclosed render change: this WorkflowError used to reach the shared
    // `Invalid:` render. It is a deployment-layout problem, not an invalid workflow, and `run`
    // already reported it as such — so on the extensions arm it now reads the same way. The
    // extension-FREE arm still renders it `Invalid:` (its guard call is direct, not through
    // loadProjectExtensions), which is pinned by validate-orphan-manifest.test.ts.
    const file = join(workflowDir, 'ext-orphan.yaml');
    writeFileSync(
      file,
      `
id: ext-orphan
name: Ext Orphan
version: 1
extensions: ../../dist/registry.js
steps:
  fetch_data:
    description: fetch
    execution: auto
    handler: h
`,
      'utf8',
    );
    const orphan = join(workflowDir, 'realm.yaml');
    writeFileSync(orphan, 'version: 1\n', 'utf8');

    try {
      const { code, stderr } = await runValidate([file]);
      expect(code).toBe(1);
      expect(stderr).toContain('Error loading extensions:');
      expect(stderr).toContain('will NOT be loaded');
      expect(stderr).not.toContain('Invalid:');
    } finally {
      rmSync(orphan, { force: true });
    }
  }, 20_000);

  it('the summary still prints on this branch when --strict is FAILING the run', async () => {
    // The extensions-path twin of the extension-free cell in
    // validate-structured-output-nudge.test.ts. Both call sites reach their exit through
    // `strictFailed` with the nudge in between, and each needed its own cell: a mutant that
    // skips the nudge on one branch leaves the other's cell green.
    //
    // This file is spawn-based, so the assertion is the CHILD's real exit code from
    // `runValidate` — an in-process `vi.spyOn(process, 'exit')` here would mock the test
    // runner's own exit and could never observe the child, which is an assertion that can only
    // ever pass. `retry:` on the agent step mints RETRY_INERT_NON_AUTO (warn), which fails
    // --strict without escalating.
    const file = join(workflowDir, 'workflow.yaml');
    writeFileSync(
      file,
      `
id: cfg-wf-strict
name: Config WF Strict
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
      needed_key: value
  summarise:
    description: summarise
    execution: agent
    depends_on: [fetch_data]
    retry:
      max_attempts: 3
    output_schema:
      type: object
      required: [summary]
      properties:
        summary: { type: string }
`,
      'utf8',
    );

    const { code, stdout } = await runValidate([file, '--strict']);

    expect(code).not.toBe(0);
    expect(stdout).toContain('failing due to --strict');
    expect(stdout).toContain(
      "ℹ 1 step one change away from structured_output: strict — run 'realm workflow validate --explain' for detail (REALM_NO_NUDGE=1 to silence).",
    );
  }, 20_000);

  it('(i) the adoption summary is genuinely end-of-report — below the Extensions block', async () => {
    // issue #422: the summary points at what you could do NEXT, so it belongs after everything
    // that describes what was just validated. On this path that means below `Extensions:`, which
    // is where the nudge call moved. The agent step carries no `agent_profile`, so profile
    // resolution is skipped entirely and no profiles machinery is needed here.
    const file = join(workflowDir, 'workflow.yaml');
    writeFileSync(
      file,
      `
id: cfg-wf-order
name: Config WF Order
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
      needed_key: value
  summarise:
    description: summarise
    execution: agent
    depends_on: [fetch_data]
    output_schema:
      type: object
      additionalProperties: false
      required: [summary]
      properties:
        summary: { type: string, pattern: "^[a-z]+$" }
`,
      'utf8',
    );
    const { code, stdout } = await runValidate([file]);
    expect(code).toBe(0);

    const lines = stdout.trimEnd().split('\n');
    const validAt = lines.findIndex((l) => l.startsWith('Valid:'));
    const extensionsAt = lines.findIndex((l) => l.startsWith('Extensions:'));
    const summaryAt = lines.findIndex((l) => l.startsWith('ℹ'));
    // Non-vacuity: all three actually printed, so the ordering below compares real positions.
    expect(validAt).toBeGreaterThanOrEqual(0);
    expect(extensionsAt).toBeGreaterThan(validAt);
    expect(summaryAt).toBeGreaterThan(extensionsAt);
    expect(lines[summaryAt]).toBe(
      "ℹ 1 step ready for structured_output: strict (1 with caveats) — run 'realm workflow validate --explain' for detail (REALM_NO_NUDGE=1 to silence).",
    );
  }, 20_000);
});

describe('realm workflow validate — CJS-ESM interop (raw Node semantics)', () => {
  // This MUST be spawn-based: under vitest, vite-node's module interop auto-unwraps
  // __esModule CJS wrappers, so an in-process test passes with or without the loader's
  // unwrap. Only a raw `node` child proves the production behavior.
  let proj: string;

  beforeAll(() => {
    proj = mkdtempSync(join(tmpdir(), 'realm-cjs-interop-'));
    mkdirSync(join(proj, 'workflows', 'wf'), { recursive: true });
    mkdirSync(join(proj, 'dist'), { recursive: true });
    // NO "type": "module" — Node loads dist/*.js as CJS; import() then yields
    // { __esModule: true, default: <manifest> } (the tsc "module: commonjs" emit shape).
    writeFileSync(
      join(proj, 'package.json'),
      '{ "name": "cjs-consumer", "version": "1.0.0" }\n',
      'utf8',
    );
    writeFileSync(
      join(proj, 'dist', 'registry.js'),
      `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = {
  handlers: { cjs_handler: { id: 'cjs_handler', async execute() { return { output: { ok: true }, warnings: [] }; } } },
};
`,
      'utf8',
    );
    writeFileSync(
      join(proj, 'workflows', 'wf', 'workflow.yaml'),
      `
id: cjs-wf
name: CJS WF
version: 1
extensions: ../../dist/registry.js
params_schema: { type: object }
steps:
  s1:
    description: handled
    execution: auto
    depends_on: []
    handler: cjs_handler
`,
      'utf8',
    );
  });

  afterAll(() => {
    rmSync(proj, { recursive: true, force: true });
  });

  it('accepts a tsc-CommonJS extension module (unwraps the __esModule wrapper)', async () => {
    const { code, stdout, stderr } = await runValidate([
      join(proj, 'workflows', 'wf', 'workflow.yaml'),
    ]);
    expect(stderr).not.toMatch(/unknown key 'default'/);
    expect(stdout).toContain('Valid: cjs-wf v1');
    expect(stdout).toContain('handlers: 1');
    expect(code).toBe(0);
  }, 20_000);
});
