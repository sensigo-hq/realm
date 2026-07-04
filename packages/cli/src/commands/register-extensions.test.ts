// Tests for loadWorkflowForRegistration — register/watch MINT the trust decision:
// full module load + duck validation + config_schema two-pass BEFORE persisting.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadWorkflowForRegistration } from './register.js';
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
    const definition = await loadWorkflowForRegistration(writeWorkflow(BASE_YAML));
    expect(definition.id).toBe('reg-wf');
    expect(definition.extensions).toBeUndefined();
  });

  it('a declaring workflow loads + duck-validates its modules and stamps resolution metadata', async () => {
    writeFileSync(
      join(proj, 'dist', 'registry.js'),
      `export default { handlers: { h1: { id: 'h1', execute: async () => ({ data: {} }) } } };`,
      'utf8',
    );
    const definition = await loadWorkflowForRegistration(
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
