// Tests for JsonFileReplayStore: save, get, round-trip, and error handling.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JsonFileReplayStore } from './replay-store.js';
import type { ReplayStepResult } from '@sensigo/realm';

const sampleResults: ReplayStepResult[] = [
  {
    step_id: 'fetch_doc',
    preconditions_original: true,
    preconditions_replay: true,
    changed: false,
    has_preconditions: false,
  },
  {
    step_id: 'write',
    preconditions_original: true,
    preconditions_replay: false,
    changed: true,
    has_preconditions: true,
  },
];

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

async function makeTempStore(): Promise<JsonFileReplayStore> {
  tempDir = await mkdtemp(join(tmpdir(), 'realm-replays-test-'));
  return new JsonFileReplayStore(tempDir);
}

describe('JsonFileReplayStore', () => {
  it('save() returns a record with an id starting with "rpl_" and a valid ISO timestamp', async () => {
    const store = await makeTempStore();
    const record = await store.save({
      origin_run_id: 'run-abc',
      workflow_id: 'my-workflow',
      overrides: ['validate.accepted_count=0'],
      results: sampleResults,
    });
    expect(record.id).toMatch(/^rpl_/);
    expect(new Date(record.created_at).toISOString()).toBe(record.created_at);
  });

  it('save() and get() round-trip: save a record, get it back by ID, deep-equal', async () => {
    const store = await makeTempStore();
    const saved = await store.save({
      origin_run_id: 'run-xyz',
      workflow_id: 'wf-1',
      overrides: [],
      results: sampleResults,
    });
    const retrieved = await store.get(saved.id);
    expect(retrieved).toEqual(saved);
  });

  it('get() with a non-existent ID throws Error with correct message', async () => {
    const store = await makeTempStore();
    const fakeId = 'rpl_does-not-exist';
    await expect(store.get(fakeId)).rejects.toThrow(`Replay not found: ${fakeId}`);
  });

  it('two save() calls produce different IDs', async () => {
    const store = await makeTempStore();
    const payload = {
      origin_run_id: 'run-abc',
      workflow_id: 'my-workflow',
      overrides: [],
      results: sampleResults,
    };
    const a = await store.save(payload);
    const b = await store.save(payload);
    expect(a.id).not.toBe(b.id);
  });
});
