import { describe, it, expect, beforeEach } from 'vitest';
import {
  InMemoryTraceBufferStore,
  BUFFER_LIMIT_COUNT,
  BUFFER_LIMIT_BYTES,
  FINAL_LIMIT_ENTRIES,
  FINAL_LIMIT_BYTES,
} from './trace-buffer-store.js';
import { WorkflowError } from '../types/workflow-error.js';

describe('InMemoryTraceBufferStore', () => {
  let store: InMemoryTraceBufferStore;

  beforeEach(() => {
    store = new InMemoryTraceBufferStore();
  });

  it('append returns correct buffer_count and buffer_bytes after adding entries', async () => {
    const result = await store.append('run-1', 'step-1', [
      { event: 'tool_call', data: { tool: 'search' } },
    ]);
    expect(result.buffer_count).toBe(1);
    expect(result.buffer_bytes).toBeGreaterThan(0);
    expect(result.limit_count).toBe(BUFFER_LIMIT_COUNT);
    expect(result.limit_bytes).toBe(BUFFER_LIMIT_BYTES);
    expect(result.final_limit_entries).toBe(FINAL_LIMIT_ENTRIES);
    expect(result.final_limit_bytes).toBe(FINAL_LIMIT_BYTES);
  });

  it('append normalizes entries: reserved-prefix events are dropped', async () => {
    const result = await store.append('run-1', 'step-1', [
      { event: 'trace.internal' },
      { event: 'valid_event' },
    ]);
    // Only 'valid_event' survives; 'trace.internal' is dropped.
    expect(result.buffer_count).toBe(1);
    const entries = await store.read('run-1', 'step-1');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.event).toBe('valid_event');
  });

  it('append normalizes entries: event names are trimmed and capped at 100 chars', async () => {
    const longEvent = 'a'.repeat(150);
    await store.append('run-1', 'step-1', [{ event: `  ${longEvent}  ` }]);
    const entries = await store.read('run-1', 'step-1');
    expect(entries[0]?.event).toBe('a'.repeat(100));
  });

  it('append normalizes entries: data string values are capped at 500 chars', async () => {
    const longVal = 'x'.repeat(600);
    await store.append('run-1', 'step-1', [{ event: 'evt', data: { key: longVal } }]);
    const entries = await store.read('run-1', 'step-1');
    expect(entries[0]?.data?.['key']).toBe('x'.repeat(500));
  });

  it('append throws BUFFER_FULL when BUFFER_LIMIT_COUNT would be exceeded', async () => {
    // Fill up to the limit.
    const entries = Array.from({ length: BUFFER_LIMIT_COUNT }, (_, i) => ({ event: `e${i}` }));
    await store.append('run-1', 'step-1', entries);

    await expect(store.append('run-1', 'step-1', [{ event: 'one_more' }])).rejects.toMatchObject({
      code: 'BUFFER_FULL',
    });
  });

  it('append throws BUFFER_FULL when BUFFER_LIMIT_BYTES would be exceeded', async () => {
    // Each entry is ~500 bytes of data; 201 entries would exceed 100KB.
    const bigEntry = { event: 'big', data: { payload: 'y'.repeat(490) } };
    const entries = Array.from({ length: 210 }, () => bigEntry);
    await expect(store.append('run-1', 'step-1', entries)).rejects.toMatchObject({
      code: 'BUFFER_FULL',
    });
  });

  it('read returns empty array for unknown keys', async () => {
    const result = await store.read('unknown-run', 'unknown-step');
    expect(result).toEqual([]);
  });

  it('read returns buffered entries in insertion order with _internalTs set', async () => {
    await store.append('run-1', 'step-1', [{ event: 'first' }]);
    await store.append('run-1', 'step-1', [{ event: 'second' }]);
    const entries = await store.read('run-1', 'step-1');
    expect(entries).toHaveLength(2);
    expect(entries[0]?.event).toBe('first');
    expect(entries[1]?.event).toBe('second');
    expect(entries[0]?._internalTs).toBeGreaterThan(0);
    expect(entries[1]?._internalTs).toBeGreaterThan(0);
  });

  it('delete removes the buffer; subsequent read returns []', async () => {
    await store.append('run-1', 'step-1', [{ event: 'evt' }]);
    await store.delete('run-1', 'step-1');
    const result = await store.read('run-1', 'step-1');
    expect(result).toEqual([]);
  });

  it('deleteAllForRun removes all buffers for the given run, leaves others untouched', async () => {
    await store.append('run-1', 'step-a', [{ event: 'a' }]);
    await store.append('run-1', 'step-b', [{ event: 'b' }]);
    await store.append('run-2', 'step-a', [{ event: 'c' }]);

    await store.deleteAllForRun('run-1');

    expect(await store.read('run-1', 'step-a')).toEqual([]);
    expect(await store.read('run-1', 'step-b')).toEqual([]);
    expect(await store.read('run-2', 'step-a')).toHaveLength(1);
  });

  it('deleteAllForRun ignores the optional dirEntries hint (issue #107 — in-memory has no directory)', async () => {
    await store.append('run-1', 'step-a', [{ event: 'a' }]);

    await store.deleteAllForRun('run-1', ['some-unrelated-file.jsonl']);

    expect(await store.read('run-1', 'step-a')).toEqual([]);
  });

  it('empty entries array to append returns current state without modifying buffer', async () => {
    await store.append('run-1', 'step-1', [{ event: 'existing' }]);
    const result = await store.append('run-1', 'step-1', []);
    expect(result.buffer_count).toBe(1);
    const entries = await store.read('run-1', 'step-1');
    expect(entries).toHaveLength(1);
  });

  it('multiple sequential append calls accumulate in order', async () => {
    await store.append('run-1', 'step-1', [{ event: 'a' }, { event: 'b' }]);
    await store.append('run-1', 'step-1', [{ event: 'c' }]);
    const entries = await store.read('run-1', 'step-1');
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.event)).toEqual(['a', 'b', 'c']);
  });

  it('append throws WorkflowError instance for BUFFER_FULL', async () => {
    const entries = Array.from({ length: BUFFER_LIMIT_COUNT }, (_, i) => ({ event: `e${i}` }));
    await store.append('run-1', 'step-1', entries);

    try {
      await store.append('run-1', 'step-1', [{ event: 'one_more' }]);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowError);
      expect((err as WorkflowError).code).toBe('BUFFER_FULL');
      expect((err as WorkflowError).agentAction).toBe('provide_input');
    }
  });
});
