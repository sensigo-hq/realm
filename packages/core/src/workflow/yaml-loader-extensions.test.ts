// Tests for the top-level `extensions` key: schema validation, from-string hard error,
// and source_dir / trust_root resolution metadata stamped by loadWorkflowFromFile.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadWorkflowFromFile, loadWorkflowFromString } from './yaml-loader.js';
import { WorkflowError } from '../types/workflow-error.js';

const WORKFLOW_BODY = `
id: ext-wf
name: Extensions WF
version: 1
steps:
  step_one:
    description: First step
    execution: agent
`;

function workflowWithExtensions(extensionsYaml: string): string {
  return `${WORKFLOW_BODY}extensions: ${extensionsYaml}\n`;
}

describe('extensions schema (loadWorkflowFromString → hard error)', () => {
  it('a declared extensions key is a hard load error from string', () => {
    expect(() => loadWorkflowFromString(workflowWithExtensions('./registry.js'))).toThrow(
      /extensions' requires file-based loading/,
    );
  });

  it('the from-string hard error fires even when the rest of the workflow is invalid', () => {
    // No steps/id — the extensions error must fire before other validation.
    expect(() => loadWorkflowFromString(`extensions: ./registry.js\n`)).toThrow(
      /file-based loading/,
    );
  });

  it('extension-free workflows are unaffected from string', () => {
    expect(() => loadWorkflowFromString(WORKFLOW_BODY)).not.toThrow();
  });
});

describe('extensions schema (loadWorkflowFromFile)', () => {
  let root: string;
  let workflowDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'realm-ext-schema-'));
    workflowDir = join(root, 'workflows', 'wf');
    mkdirSync(workflowDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeWorkflow(content: string): string {
    const filePath = join(workflowDir, 'workflow.yaml');
    writeFileSync(filePath, content, 'utf8');
    return filePath;
  }

  it('accepts a string declaration and normalizes it to an array (paths untouched)', () => {
    const definition = loadWorkflowFromFile(
      writeWorkflow(workflowWithExtensions('../../dist/registry.js')),
    );
    expect(definition.extensions).toEqual(['../../dist/registry.js']);
  });

  it('accepts a string[] declaration', () => {
    const definition = loadWorkflowFromFile(
      writeWorkflow(`${WORKFLOW_BODY}extensions:\n  - ./a.js\n  - ./b.js\n`),
    );
    expect(definition.extensions).toEqual(['./a.js', './b.js']);
  });

  it('rejects an absolute path with an actionable error', () => {
    expect(() =>
      loadWorkflowFromFile(writeWorkflow(workflowWithExtensions('/etc/evil.js'))),
    ).toThrow(/absolute path.*RELATIVE to the workflow directory/s);
  });

  it('rejects an empty string', () => {
    expect(() => loadWorkflowFromFile(writeWorkflow(`${WORKFLOW_BODY}extensions: ''\n`))).toThrow(
      WorkflowError,
    );
  });

  it('rejects an empty array', () => {
    expect(() => loadWorkflowFromFile(writeWorkflow(`${WORKFLOW_BODY}extensions: []\n`))).toThrow(
      /must be a non-empty module path or a non-empty array/,
    );
  });

  it('rejects non-string array entries', () => {
    expect(() =>
      loadWorkflowFromFile(writeWorkflow(`${WORKFLOW_BODY}extensions:\n  - 42\n`)),
    ).toThrow(WorkflowError);
  });

  it('stamps source_dir with the absolutized workflow directory', () => {
    const definition = loadWorkflowFromFile(writeWorkflow(workflowWithExtensions('./registry.js')));
    expect(definition.source_dir).toBe(workflowDir);
  });

  it('trust_root is the nearest ancestor containing package.json', () => {
    writeFileSync(join(root, 'package.json'), '{}', 'utf8');
    const definition = loadWorkflowFromFile(writeWorkflow(workflowWithExtensions('./registry.js')));
    expect(definition.trust_root).toBe(root);
  });

  it('trust_root is the nearest ancestor containing .git', () => {
    mkdirSync(join(root, 'workflows', '.git'), { recursive: true });
    const definition = loadWorkflowFromFile(writeWorkflow(workflowWithExtensions('./registry.js')));
    expect(definition.trust_root).toBe(join(root, 'workflows'));
  });

  it('a package.json in the workflow dir itself wins (inclusive walk)', () => {
    writeFileSync(join(root, 'package.json'), '{}', 'utf8');
    writeFileSync(join(workflowDir, 'package.json'), '{}', 'utf8');
    const definition = loadWorkflowFromFile(writeWorkflow(workflowWithExtensions('./registry.js')));
    expect(definition.trust_root).toBe(workflowDir);
  });

  it('extension-free workflows ALSO get source_dir / trust_root stamped (v0.14 manifest anchor)', () => {
    const definition = loadWorkflowFromFile(writeWorkflow(WORKFLOW_BODY));
    expect(definition.extensions).toBeUndefined();
    expect(definition.source_dir).toBe(workflowDir);
    expect(definition.trust_root).toBeDefined();
  });
});

describe('services schema (v0.14)', () => {
  const withService = (entry: string): string => `
id: svc-schema-wf
name: Svc Schema WF
version: 1
services:
  my_svc:
${entry}
steps:
  s1:
    description: step
    execution: auto
    uses_service: my_svc
`;

  it('token_from gets the TARGETED migration error (not a generic unknown-key error)', () => {
    const yaml = withService(
      `    adapter: github\n    trust: engine_managed\n    auth:\n      token_from: secrets.GITHUB_TOKEN`,
    );
    expect(() => loadWorkflowFromString(yaml)).toThrow(
      /Service 'my_svc': 'auth\.token_from' was removed in v0\.14\.0 — bind credentials in your deployment manifest \(realm\.yaml\)/,
    );
    expect(() => loadWorkflowFromString(yaml)).not.toThrow(/unknown key/);
  });

  it('unknown service keys are rejected by the strict schema', () => {
    const yaml = withService(
      `    adapter: github\n    trust: engine_managed\n    base_url: https://x`,
    );
    expect(() => loadWorkflowFromString(yaml)).toThrow(/Service 'my_svc': unknown key 'base_url'/);
  });

  it('adapter is required; trust must be a valid enum value', () => {
    expect(() => loadWorkflowFromString(withService(`    trust: engine_managed`))).toThrow(
      /my_svc/,
    );
    expect(() =>
      loadWorkflowFromString(withService(`    adapter: github\n    trust: nonsense`)),
    ).toThrow(/my_svc/);
  });

  it('a well-formed service entry passes', () => {
    expect(() =>
      loadWorkflowFromString(
        withService(
          `    adapter: github\n    trust: engine_managed\n    rate_limit:\n      requests_per_second: 2`,
        ),
      ),
    ).not.toThrow();
  });
});
