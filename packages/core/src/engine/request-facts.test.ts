// request-facts.test.ts — issue #600 PR 2 (A3, G9): the free text a request record carries is bounded
// where the record is written. The cells write through a step's evidence (`executeStep` with
// `stepMeta.usage`, the path `realm agent` takes) and read the STORED record back, never a render.
// On a failing CI host each cell prints the stored request's name fields: test values only.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeStep } from './execution-loop.js';
import type { StepDispatcher } from './execution-loop.js';
import { boundRequestFacts } from './request-facts.js';
import { NAME_CAP_MARKER, NAME_MAX_LENGTH } from './holder.js';
import { JsonFileStore } from '../store/json-file-store.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
import type { UsageRecord } from '../types/run-record.js';

const echo: StepDispatcher = async (_step, input) => ({ ...input });
const DEF: WorkflowDefinition = {
  id: 'request-facts-600',
  name: 'Request facts 600',
  version: 1,
  steps: { work: { description: 'Work', execution: 'agent', depends_on: [] } },
};

describe('issue #600 PR 2 — request names are bounded on the stored record (A3)', () => {
  let store: JsonFileStore;
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'realm-request-facts-600-'));
    store = new JsonFileStore(dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Writes one request through a step's evidence; returns the stored request's name fields. */
  const stored = async (names: Partial<UsageRecord>) => {
    const { run } = await store.create({ workflowId: DEF.id, workflowVersion: 1, params: {} });
    const usage: UsageRecord = {
      request_index: 0,
      request_start: '2026-10-14T00:00:00.000Z',
      prompt_tokens: 10,
      ...names,
    };
    const envelope = await executeStep(store, DEF, {
      runId: run.id,
      command: 'work',
      input: {},
      dispatcher: echo,
      stepMeta: { usage: [usage] },
    });
    expect(envelope.status).toBe('ok');
    const record = await store.get(run.id);
    const request = record.evidence[0]!.diagnostics!.cache!.requests[0]!;
    return {
      model: request.model,
      cache_requested_by: request.cache_requested_by,
      provider: request.provider,
      prompt_tokens: request.prompt_tokens,
    };
  };

  // (a) red when `deriveCacheDetail` does not bound its requests; (b) prints the stored names.
  it('a name with a control character inside (ESC, an inner newline) is not stored; the rest of the request is', async () => {
    expect(
      await stored({
        model: 'claude-\u001b[31mx',
        cache_requested_by: 'realm\nagent',
        provider: 'anthropic\u0007',
      }),
    ).toEqual({
      model: undefined,
      cache_requested_by: undefined,
      provider: undefined,
      prompt_tokens: 10,
    });
  });

  // (a) red when the stored name is not cut; (b) prints the stored name's length and ending.
  it('a name over 200 characters is stored cut to 200, with the house marker', async () => {
    const long = 'm'.repeat(NAME_MAX_LENGTH + 1);
    const { model } = await stored({ model: long });
    expect({ length: model?.length, ending: model?.slice(NAME_MAX_LENGTH) }).toEqual({
      length: NAME_MAX_LENGTH + NAME_CAP_MARKER.length,
      ending: NAME_CAP_MARKER,
    });
  });

  // (a) red when the stored name keeps its trailing newline; (b) prints the stored name.
  it('a trailing newline is trimmed, and the name is stored', async () => {
    expect((await stored({ model: 'claude-x-20260101\n' })).model).toBe('claude-x-20260101');
  });

  // The correction of #781 (W600P2-10): `cache_requested` and `cache_requested_source` are free text a
  // provider module writes, bounded by the same rule. Read on the stored record. (a) red when the two
  // fields are not in the bounded list; (b) prints the stored fields (lengths and endings, test values).
  it('a 300-character cache_requested is stored cut to 200, with the house marker', async () => {
    const { run } = await store.create({ workflowId: DEF.id, workflowVersion: 1, params: {} });
    await executeStep(store, DEF, {
      runId: run.id,
      command: 'work',
      input: {},
      dispatcher: echo,
      stepMeta: {
        usage: [
          {
            request_index: 0,
            request_start: '2026-10-14T00:00:00.000Z',
            cache_requested: 'x'.repeat(300) as never,
          },
        ],
      },
    });
    const value = (await store.get(run.id)).evidence[0]!.diagnostics!.cache!.requests[0]!
      .cache_requested as string;
    expect({ length: value.length, ending: value.slice(NAME_MAX_LENGTH) }).toEqual({
      length: NAME_MAX_LENGTH + NAME_CAP_MARKER.length,
      ending: NAME_CAP_MARKER,
    });
  });

  it('a cache_requested_source with an inner newline is not stored; valid words are stored unchanged', async () => {
    const write = async (extra: Partial<UsageRecord>) => {
      const { run } = await store.create({ workflowId: DEF.id, workflowVersion: 1, params: {} });
      await executeStep(store, DEF, {
        runId: run.id,
        command: 'work',
        input: {},
        dispatcher: echo,
        stepMeta: {
          usage: [{ request_index: 0, request_start: '2026-10-14T00:00:00.000Z', ...extra }],
        },
      });
      const r = (await store.get(run.id)).evidence[0]!.diagnostics!.cache!.requests[0]!;
      return {
        cache_requested: r.cache_requested,
        cache_requested_source: r.cache_requested_source,
      };
    };
    expect(
      await write({ cache_requested: 'lifetime', cache_requested_source: 'sta\nted' as never }),
    ).toEqual({
      cache_requested: 'lifetime',
      cache_requested_source: undefined,
    });
    expect(await write({ cache_requested: 'lifetime', cache_requested_source: 'stated' })).toEqual({
      cache_requested: 'lifetime',
      cache_requested_source: 'stated',
    });
  });

  // (a) red when the function spreads every entry (a `null` would become `{}`); (b) prints the
  // returned array. Called directly: `deriveCacheDetail`'s own loop reads every entry as an object.
  it('an entry that is not an object passes through unchanged, and nothing throws', () => {
    const input = [null, 3, 'x', { model: 'claude-x\n', prompt_tokens: 1 }];
    expect(boundRequestFacts(input)).toEqual([
      null,
      3,
      'x',
      { model: 'claude-x', prompt_tokens: 1 },
    ]);
    // The input is not changed.
    expect(input[3]).toEqual({ model: 'claude-x\n', prompt_tokens: 1 });
  });

  // Cell 2 (the lifetime unit): `cache_auto` is a record fact a provider module may write, so it is
  // kept only in the shape the record keeps — read on the stored record. (a) red when a malformed
  // `cache_auto` is stored, an extra key survives, or the bound stops applying to the names beside
  // it; (b) prints the stored `cache_auto` and name of each request (test values only).
  it('cache_auto on the stored record: a malformed one is dropped; a valid one comes back normalised, its extra key gone', async () => {
    const storedAuto = async (cache_auto: unknown, model?: string) => {
      const { run } = await store.create({ workflowId: DEF.id, workflowVersion: 1, params: {} });
      const usage = {
        request_index: 0,
        request_start: '2026-10-16T00:00:00.000Z',
        prompt_tokens: 10,
        ...(model !== undefined ? { model } : {}),
        cache_auto,
      } as unknown as UsageRecord;
      await executeStep(store, DEF, {
        runId: run.id,
        command: 'work',
        input: {},
        dispatcher: echo,
        stepMeta: { usage: [usage] },
      });
      const request = (await store.get(run.id)).evidence[0]!.diagnostics!.cache!.requests[0]!;
      return {
        has: Object.hasOwn(request, 'cache_auto'),
        cache_auto: request.cache_auto,
        keys: Object.keys(request.cache_auto ?? {}),
        model: request.model,
        prompt_tokens: request.prompt_tokens,
      };
    };
    expect([
      await storedAuto({ basis: 'guessed' }),
      await storedAuto({ basis: 'listen_trigger_gaps', gaps_s: [1, 2, 3, 4, 5, 6] }),
      await storedAuto('no_measurement'),
      await storedAuto(
        { extra: 'x', gaps_s: [420, 720], basis: 'listen_trigger_gaps' },
        'claude-x-20260101\n',
      ),
      await storedAuto({ basis: 'no_measurement' }, 'claude-\u001bx'),
    ]).toEqual([
      { has: false, cache_auto: undefined, keys: [], model: undefined, prompt_tokens: 10 },
      { has: false, cache_auto: undefined, keys: [], model: undefined, prompt_tokens: 10 },
      { has: false, cache_auto: undefined, keys: [], model: undefined, prompt_tokens: 10 },
      {
        has: true,
        cache_auto: { basis: 'listen_trigger_gaps', gaps_s: [420, 720] },
        keys: ['basis', 'gaps_s'],
        model: 'claude-x-20260101',
        prompt_tokens: 10,
      },
      {
        has: true,
        cache_auto: { basis: 'no_measurement' },
        keys: ['basis'],
        model: undefined,
        prompt_tokens: 10,
      },
    ]);
  });

  // Cell 2, called directly. (a) red when the function changes its input's `cache_auto` in place;
  // (b) prints the returned array and the input.
  it('cache_auto, called directly: normalised in a new entry; the input is not changed', () => {
    const entry = { cache_auto: { gaps_s: [7], basis: 'listen_trigger_gaps', extra: true } };
    expect(boundRequestFacts([entry])).toEqual([
      { cache_auto: { basis: 'listen_trigger_gaps', gaps_s: [7] } },
    ]);
    expect(entry).toEqual({
      cache_auto: { gaps_s: [7], basis: 'listen_trigger_gaps', extra: true },
    });
  });
});
