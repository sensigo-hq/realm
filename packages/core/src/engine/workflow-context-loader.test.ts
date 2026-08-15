// Tests for workflow-context-loader — reads workflow_context entries from disk.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { loadWorkflowContext } from './workflow-context-loader.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';

function makeDefinition(
  workflow_context: WorkflowDefinition['workflow_context'],
): WorkflowDefinition {
  const base: WorkflowDefinition = {
    id: 'ctx-test',
    name: 'Context Test',
    version: 1,
    schema_version: 1,
    steps: {},
  };
  // `makeDefinition(undefined)` is a real case (the "no workflow_context at all" test), so the key
  // is OMITTED rather than set to undefined — which is what an absent block looks like on a
  // loaded definition.
  return workflow_context === undefined ? base : { ...base, workflow_context };
}

describe('loadWorkflowContext', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'realm-ctx-loader-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns {} when workflow_context is undefined', async () => {
    const def = makeDefinition(undefined);
    const result = await loadWorkflowContext(def);
    expect(result).toEqual({});
  });

  it('returns {} when workflow_context is an empty object', async () => {
    const def = makeDefinition({});
    const result = await loadWorkflowContext(def);
    expect(result).toEqual({});
  });

  it('loads an existing file and returns correct snapshot fields', async () => {
    const filePath = join(dir, 'schema.json');
    const content = '{"type":"object"}';
    await writeFile(filePath, content, 'utf-8');

    const def = makeDefinition({ schema: { source: { path: filePath } } });
    const result = await loadWorkflowContext(def);

    expect(result['schema']).toBeDefined();
    expect(result['schema']!.source_path).toBe(filePath);
    expect(result['schema']!.content).toBe(content);
    expect(result['schema']!.content_hash).toBe(createHash('sha256').update(content).digest('hex'));
    expect(result['schema']!.error).toBeUndefined();
    // loaded_at should be a valid ISO timestamp
    expect(() => new Date(result['schema']!.loaded_at)).not.toThrow();
    expect(new Date(result['schema']!.loaded_at).getFullYear()).toBeGreaterThan(2020);
  });

  it('records error snapshot (content and hash empty) when file does not exist — does not throw', async () => {
    const missing = join(dir, 'does-not-exist.md');
    const def = makeDefinition({ guidelines: { source: { path: missing } } });
    const result = await loadWorkflowContext(def);

    expect(result['guidelines']).toBeDefined();
    expect(result['guidelines']!.source_path).toBe(missing);
    expect(result['guidelines']!.content).toBe('');
    expect(result['guidelines']!.content_hash).toBe('');
    expect(result['guidelines']!.error).toBeTruthy();
  });

  it('handles multiple entries independently', async () => {
    const fileA = join(dir, 'a.md');
    const fileB = join(dir, 'b.md');
    const missing = join(dir, 'missing.md');
    await writeFile(fileA, 'content-a', 'utf-8');
    await writeFile(fileB, 'content-b', 'utf-8');

    const def = makeDefinition({
      a: { source: { path: fileA } },
      b: { source: { path: fileB } },
      missing: { source: { path: missing } },
    });
    const result = await loadWorkflowContext(def);

    expect(result['a']!.content).toBe('content-a');
    expect(result['b']!.content).toBe('content-b');
    expect(result['missing']!.error).toBeTruthy();
    expect(result['missing']!.content).toBe('');
  });
});
