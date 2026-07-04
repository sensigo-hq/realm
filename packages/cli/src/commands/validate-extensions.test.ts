// Spawn-based tests for `realm workflow validate` with project extensions:
//  - extension-free workflows keep the EXACT current output (golden test on a repo example);
//  - a declaring workflow gets config_schema two-pass validation against the resolved
//    registry (a custom adapter config violation is caught at validate time).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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

describe('realm workflow validate — golden (extension-free byte-identical)', () => {
  it('validates the existing ticket-classifier example with the exact current output', async () => {
    const { code, stdout, stderr } = await runValidate([
      join(REPO_ROOT, 'examples', '02-ticket-classifier', 'workflow.yaml'),
    ]);
    expect(stderr).toBe('');
    expect(stdout).toBe('Valid: ticket-classifier v1 (4 steps)\n');
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
  }, 20_000);

  it('passes when the config satisfies the custom adapter config_schema', async () => {
    const file = join(workflowDir, 'workflow.yaml');
    writeFileSync(file, workflowYaml('      needed_key: value'), 'utf8');
    const { code, stdout } = await runValidate([file]);
    expect(stdout).toContain('Valid: cfg-wf v1 (1 steps)');
    expect(stdout).toContain('Extensions: ../../dist/registry.js');
    expect(code).toBe(0);
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
