// Tests for initWorkflow business logic.
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initWorkflow } from './init.js';
import { loadWorkflowFromString } from '@sensigo/realm';

let baseDir: string;

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), 'realm-init-test-'));
});

describe('initWorkflow', () => {
  it('creates all four files with correct name substitution', async () => {
    const target = join(baseDir, 'my-workflow');
    await initWorkflow('my-workflow', target);

    const yaml = await readFile(join(target, 'workflow.yaml'), 'utf8');
    const schema = await readFile(join(target, 'schema.json'), 'utf8');
    const envEx = await readFile(join(target, '.env.example'), 'utf8');
    const readme = await readFile(join(target, 'README.md'), 'utf8');

    expect(yaml).toContain('id: my-workflow');
    expect(yaml).toContain('name: "my-workflow"');
    expect(schema).toContain('"$schema"');
    expect(envEx).toContain('EXAMPLE_API_KEY');
    expect(readme).toContain('# my-workflow');
    expect(readme).toContain('realm workflow validate');
  });

  it('throws an error when target directory already exists', async () => {
    const target = join(baseDir, 'existing-dir');
    await mkdir(target);
    await expect(initWorkflow('existing-dir', target)).rejects.toThrow('Directory already exists');
  });

  it('generated workflow.yaml passes loadWorkflowFromString without errors', async () => {
    const target = join(baseDir, 'valid-workflow');
    await initWorkflow('valid-workflow', target);
    const yaml = await readFile(join(target, 'workflow.yaml'), 'utf8');
    const def = loadWorkflowFromString(yaml);
    expect(def.id).toBe('valid-workflow');
    expect(def.steps).toHaveProperty('step_one');
    expect(def.steps).toHaveProperty('step_two');
  });

  it('scaffolds a commented extensions line and a registry.sample.js (nothing active by default)', async () => {
    const target = join(baseDir, 'ext-workflow');
    await initWorkflow('ext-workflow', target);

    const yaml = await readFile(join(target, 'workflow.yaml'), 'utf8');
    expect(yaml).toContain('# extensions: ./registry.js');
    expect(yaml).toContain('docs/reference/project-extensions.md');
    // Commented out — the loader must see no extensions key.
    expect(loadWorkflowFromString(yaml).extensions).toBeUndefined();

    const sample = await readFile(join(target, 'registry.sample.js'), 'utf8');
    expect(sample).toContain('export default {');
    expect(sample).toContain('// adapters: {');
    expect(sample).toContain('// handlers: {');
    expect(sample).toContain('// processors: {');
    expect(sample).toContain('docs/reference/project-extensions.md');
    // The sample is valid JS whose default export declares nothing.
    const dataUrl = `data:text/javascript;base64,${Buffer.from(sample).toString('base64')}`;
    const mod = (await import(dataUrl)) as { default: Record<string, unknown> };
    expect(mod.default).toEqual({});
  });
});
