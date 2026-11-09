// request-facts.test.ts — issue #600 PR 2 (A3, G9): the free text a request record carries is bounded
// where the record is written. The cells write through a step's evidence (`executeStep` with
// `stepMeta.usage`, the path `realm agent` takes) and read the STORED record back, never a render.
// On a failing CI host each cell prints the stored request's name fields: test values only.
import { beforeEach, describe, expect, it } from 'vitest';
import { executeStep } from './execution-loop.js';
import type { StepDispatcher } from './execution-loop.js';
import { boundRequestFacts } from './request-facts.js';
import { NAME_CAP_MARKER, NAME_MAX_LENGTH } from './holder.js';
import { InMemoryStore } from '@sensigo/realm-testing';
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
  let store: InMemoryStore;
  beforeEach(() => {
    store = new InMemoryStore();
  });

  /** Writes one request through a step's evidence; returns the stored request's name fields. */
  const stored = async (names: Partial<UsageRecord>) => {
    const { record: run } = await store.create({
      workflowId: DEF.id,
      workflowVersion: 1,
      params: {},
    });
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
    const { record: record } = await store.get(run.id);
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
    const { record: run } = await store.create({
      workflowId: DEF.id,
      workflowVersion: 1,
      params: {},
    });
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
    const value = (await store.get(run.id)).record.evidence[0]!.diagnostics!.cache!.requests[0]!
      .cache_requested as string;
    expect({ length: value.length, ending: value.slice(NAME_MAX_LENGTH) }).toEqual({
      length: NAME_MAX_LENGTH + NAME_CAP_MARKER.length,
      ending: NAME_CAP_MARKER,
    });
  });

  it('a cache_requested_source with an inner newline is not stored; valid words are stored unchanged', async () => {
    const write = async (extra: Partial<UsageRecord>) => {
      const { record: run } = await store.create({
        workflowId: DEF.id,
        workflowVersion: 1,
        params: {},
      });
      await executeStep(store, DEF, {
        runId: run.id,
        command: 'work',
        input: {},
        dispatcher: echo,
        stepMeta: {
          usage: [{ request_index: 0, request_start: '2026-10-14T00:00:00.000Z', ...extra }],
        },
      });
      const r = (await store.get(run.id)).record.evidence[0]!.diagnostics!.cache!.requests[0]!;
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
      const { record: run } = await store.create({
        workflowId: DEF.id,
        workflowVersion: 1,
        params: {},
      });
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
      const request = (await store.get(run.id)).record.evidence[0]!.diagnostics!.cache!
        .requests[0]!;
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

  // Caching 3-M (piece A-1), check 6: a request's `reference` from another writer (a provider
  // module's usage, an older Realm's record) through the engine's write normaliser, read on the
  // stored record. (a) red when `reference` is not in the normaliser (the four malformed ones are
  // then stored as written), or when a copied field's rule drops a well-formed value; (b) prints
  // each stored request's `reference` (test values only).
  it('reference on the stored record: a well-formed one is kept byte-equal; a bad source drops it whole, a bad field drops alone, a nested reference and an index are dropped, `{}` is no reference', async () => {
    const storedReference = async (reference: unknown) => {
      const { record: run } = await store.create({
        workflowId: DEF.id,
        workflowVersion: 1,
        params: {},
      });
      const usage = {
        request_index: 0,
        request_start: '2026-11-08T00:00:01.000Z',
        prompt_tokens: 10,
        reference,
      } as unknown as UsageRecord;
      await executeStep(store, DEF, {
        runId: run.id,
        command: 'work',
        input: {},
        dispatcher: echo,
        stepMeta: { usage: [usage] },
      });
      const request = (await store.get(run.id)).record.evidence[0]!.diagnostics!.cache!
        .requests[0]!;
      return {
        has: Object.hasOwn(request, 'reference'),
        json: JSON.stringify(request.reference),
        prompt_tokens: request.prompt_tokens,
      };
    };
    const HASH = (c: string) => c.repeat(64);
    const wellFormed = {
      from: 'run',
      request_start: '2026-11-08T00:00:00.000Z',
      request_id: '3a100000-0000-4000-8000-00000000a1a1',
      provider: 'anthropic',
      model: 'claude-x-20260101',
      endpoint: 'default',
      cache_requested: 'lifetime',
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 1200,
      cache_write_tokens: 1200,
      cache_creation: { ephemeral_5m_input_tokens: 1200, ephemeral_1h_input_tokens: 0 },
      cache_lifetime_s: 300,
      cache_ttl_sent: false,
      cache_auto: { basis: 'no_measurement' },
      prefix_chars: 4000,
      prefix_parts: { system: HASH('a'), tools: HASH('b'), prompt: HASH('c'), format: HASH('d') },
      cache_marked: ['system', 'prompt'],
      request_strict_sent: true,
    };
    const { prefix_parts: _parts, ...withoutParts } = wellFormed;
    expect([
      await storedReference(wellFormed),
      await storedReference({ ...wellFormed, from: 'bogus' }),
      await storedReference({
        ...wellFormed,
        prefix_parts: { ...wellFormed.prefix_parts, prompt: 'not-a-digest' },
      }),
      await storedReference({ ...wellFormed, reference: { ...wellFormed }, request_index: 3 }),
      await storedReference({}),
      // Caching 3-M C1, check 6: another run's copy is kept. (a) red when the word is not in the
      // constant (the normaliser drops the reference whole); (b) prints it.
      await storedReference({ ...wellFormed, from: 'earlier_run' }),
    ]).toEqual([
      { has: true, json: JSON.stringify(wellFormed), prompt_tokens: 10 },
      { has: false, json: undefined, prompt_tokens: 10 },
      { has: true, json: JSON.stringify(withoutParts), prompt_tokens: 10 },
      { has: true, json: JSON.stringify(wellFormed), prompt_tokens: 10 },
      { has: false, json: undefined, prompt_tokens: 10 },
      {
        has: true,
        json: JSON.stringify({ ...wellFormed, from: 'earlier_run' }),
        prompt_tokens: 10,
      },
    ]);
  });

  // Caching 3-M (piece A-1b), check 4: a request's `request_in_call` from another writer (a provider
  // module's usage, an older Realm's record) through the engine's write normaliser, read on the
  // stored record. (a) red when `request_in_call` is not in the normaliser (the four malformed ones
  // are then stored as written); (b) prints each stored request's place and its other count.
  it('request_in_call on the stored record: 0 and 3 kept; −1, 1.5, "0" and an unsafe integer dropped alone', async () => {
    const storedPlace = async (request_in_call: unknown) => {
      const { record: run } = await store.create({
        workflowId: DEF.id,
        workflowVersion: 1,
        params: {},
      });
      const usage = {
        request_index: 0,
        request_start: '2026-11-08T00:00:01.000Z',
        prompt_tokens: 10,
        request_in_call,
      } as unknown as UsageRecord;
      await executeStep(store, DEF, {
        runId: run.id,
        command: 'work',
        input: {},
        dispatcher: echo,
        stepMeta: { usage: [usage] },
      });
      const request = (await store.get(run.id)).record.evidence[0]!.diagnostics!.cache!
        .requests[0]!;
      return {
        has: Object.hasOwn(request, 'request_in_call'),
        request_in_call: request.request_in_call,
        prompt_tokens: request.prompt_tokens,
      };
    };
    const dropped = { has: false, request_in_call: undefined, prompt_tokens: 10 };
    expect([
      await storedPlace(0),
      await storedPlace(3),
      await storedPlace(-1),
      await storedPlace(1.5),
      await storedPlace('0'),
      await storedPlace(Number.MAX_SAFE_INTEGER + 1),
    ]).toEqual([
      { has: true, request_in_call: 0, prompt_tokens: 10 },
      { has: true, request_in_call: 3, prompt_tokens: 10 },
      dropped,
      dropped,
      dropped,
      dropped,
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

// Caching 3-M (piece B1), check 1: the id of a provider's answer, run through the write gate every
// provider's record passes. A request is written with `response_id` and the other fields it always
// has; the cell reads whether the gate kept the id. (a) red per row as named; (b) prints the row,
// the kept record's keys and the id's length, never the id.
describe('caching 3-M B1 — response_id is kept only when it passes the one check', () => {
  // Anthropic's documented answer id (anth-pc@2026-10-09.md:1107); every captured id has its shape.
  const DOCUMENTED = 'msg_01XFDUDYJgAACzvnptvVoYEL';
  const kept = (value: unknown): { keys: string[]; kept: boolean; length?: number } => {
    const [out] = boundRequestFacts([
      { request_index: 0, request_start: '2026-11-08T05:00:00.000Z', response_id: value },
    ]) as Record<string, unknown>[];
    const id = out?.['response_id'];
    return {
      keys: Object.keys(out ?? {}).sort(),
      kept: id !== undefined,
      ...(typeof id === 'string' ? { length: id.length } : {}),
    };
  };
  // Can fail: the prefix check removed (the UUID row), `<` 256 for `≤` (the 256 row), the control
  // check removed (the tab row), a set with only U+0000–U+001F (the U+0085 row), a set without
  // U+007F (the DEL row), the string test removed (the array row: its string form passes the other
  // three parts).
  it.each<[string, unknown, boolean]>([
    ["Anthropic's documented id", DOCUMENTED, true],
    ["OpenAI's chat id", 'chatcmpl-AbC123dEf456', false],
    ["a gateway's UUID", '715a0000-0000-4000-8000-00000000715a', false],
    ['257 characters on that shape', `msg_01${'A'.repeat(251)}`, false],
    ['exactly 256 characters on that shape', `msg_01${'A'.repeat(250)}`, true],
    ['a tab inside the id', 'msg_01XFDUDYJg\tAACzvnptvVoYEL', false],
    ['U+0085 inside the id', 'msg_01XFDUDYJg\u0085AACzvnptvVoYEL', false],
    ['U+007F (DEL) inside the id', 'msg_01XFDUDYJg\u007fAACzvnptvVoYEL', false],
    ['a number', 42, false],
    ['an array holding the documented id', [DOCUMENTED], false],
  ])('%s', (label, value, expected) => {
    let result: ReturnType<typeof kept> | undefined;
    expect(() => {
      result = kept(value);
    }, label).not.toThrow();
    expect(result?.kept, `${label}: ${JSON.stringify(result)}`).toBe(expected);
  });
});
