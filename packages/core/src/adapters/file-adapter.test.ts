import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFile, unlink, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileSystemAdapter } from './file-adapter.js';
import { WorkflowError } from '../types/workflow-error.js';

let tmpDir: string;
let tmpFilePath: string;
const fileContent = 'line one\nline two\nline three\n';

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'realm-file-adapter-test-'));
  tmpFilePath = join(tmpDir, 'test-file.ts');
  await writeFile(tmpFilePath, fileContent, 'utf8');
});

afterAll(async () => {
  await unlink(tmpFilePath).catch(() => {});
});

describe('FileSystemAdapter', () => {
  it('id is set from constructor', () => {
    const adapter = new FileSystemAdapter('fs');
    expect(adapter.id).toBe('fs');
  });

  it('fetch read returns content, path, line_count, and size_bytes', async () => {
    const adapter = new FileSystemAdapter('fs');
    const result = await adapter.fetch('read', { path: tmpFilePath }, {});
    expect(result.status).toBe(200);
    const data = result.data as Record<string, unknown>;
    expect(data['content']).toBe(fileContent);
    expect(data['path']).toBe(tmpFilePath);
    expect(data['line_count']).toBe(4); // 3 lines + trailing newline = 4 split parts
    expect(data['size_bytes']).toBe(Buffer.byteLength(fileContent, 'utf8'));
  });

  it('fetch read with an unaborted signal still returns content unchanged', async () => {
    const adapter = new FileSystemAdapter('fs');
    const controller = new AbortController();
    const result = await adapter.fetch('read', { path: tmpFilePath }, {}, controller.signal);
    expect(result.status).toBe(200);
    const data = result.data as Record<string, unknown>;
    expect(data['content']).toBe(fileContent);
    expect(data['line_count']).toBe(4);
    expect(data['size_bytes']).toBe(Buffer.byteLength(fileContent, 'utf8'));
  });

  it('fetch read with an already-aborted signal throws STEP_ABORTED (issue A3 — abort-mapping consistency)', async () => {
    const adapter = new FileSystemAdapter('fs');
    await expect(
      adapter.fetch('read', { path: tmpFilePath }, {}, AbortSignal.abort()),
    ).rejects.toMatchObject({ code: 'STEP_ABORTED' });
    await expect(
      adapter.fetch('read', { path: tmpFilePath }, {}, AbortSignal.abort()),
    ).rejects.toBeInstanceOf(WorkflowError);
  });

  it('fetch read with empty path throws VALIDATION_EMPTY_VALUE', async () => {
    const adapter = new FileSystemAdapter('fs');
    await expect(adapter.fetch('read', { path: '' }, {})).rejects.toMatchObject({
      code: 'VALIDATION_EMPTY_VALUE',
    });
    await expect(adapter.fetch('read', { path: '' }, {})).rejects.toBeInstanceOf(WorkflowError);
  });

  it('fetch read with missing path throws VALIDATION_EMPTY_VALUE', async () => {
    const adapter = new FileSystemAdapter('fs');
    await expect(adapter.fetch('read', {}, {})).rejects.toMatchObject({
      code: 'VALIDATION_EMPTY_VALUE',
    });
  });

  it('fetch read with relative path throws VALIDATION_INPUT_SCHEMA', async () => {
    const adapter = new FileSystemAdapter('fs');
    await expect(adapter.fetch('read', { path: 'relative/path.ts' }, {})).rejects.toMatchObject({
      code: 'VALIDATION_INPUT_SCHEMA',
    });
    await expect(adapter.fetch('read', { path: 'relative/path.ts' }, {})).rejects.toBeInstanceOf(
      WorkflowError,
    );
  });

  it('fetch read with nonexistent file throws RESOURCE_FETCH_FAILED', async () => {
    const adapter = new FileSystemAdapter('fs');
    await expect(
      adapter.fetch('read', { path: '/nonexistent/missing-file.ts' }, {}),
    ).rejects.toMatchObject({
      code: 'RESOURCE_FETCH_FAILED',
    });
    await expect(
      adapter.fetch('read', { path: '/nonexistent/missing-file.ts' }, {}),
    ).rejects.toBeInstanceOf(WorkflowError);
  });

  it('fetch with unknown operation throws ENGINE_ADAPTER_FAILED', async () => {
    const adapter = new FileSystemAdapter('fs');
    await expect(adapter.fetch('write', { path: tmpFilePath }, {})).rejects.toMatchObject({
      code: 'ENGINE_ADAPTER_FAILED',
    });
    await expect(adapter.fetch('write', { path: tmpFilePath }, {})).rejects.toBeInstanceOf(
      WorkflowError,
    );
  });

  it('create throws ENGINE_ADAPTER_FAILED (not supported)', async () => {
    const adapter = new FileSystemAdapter('fs');
    await expect(adapter.create('read', { path: tmpFilePath }, {})).rejects.toMatchObject({
      code: 'ENGINE_ADAPTER_FAILED',
    });
  });

  it('update throws ENGINE_ADAPTER_FAILED (not supported)', async () => {
    const adapter = new FileSystemAdapter('fs');
    await expect(adapter.update('read', { path: tmpFilePath }, {})).rejects.toMatchObject({
      code: 'ENGINE_ADAPTER_FAILED',
    });
  });
});
