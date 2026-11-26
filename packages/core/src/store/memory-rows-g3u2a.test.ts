// memory-rows-g3u2a.test.ts — gap 3, unit 2a (prompt gap3-u2a-memory-rows-core.md): the 1 KB cap on
// a key part, through a real settle (check 1), and `memoryRowsOf`, the one pure function every store
// derives its memory rows with (checks 2–6): rows from stamps a real settle wrote, every stamp read
// again whatever wrote it, the forget markers and horizons, the expiry by the caller's `now`, and an
// evidence array that holds anything. Fake values only; no model calls (an agent's answer is the
// test's own input).
//
// Every assertion names (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect } from 'vitest';
import { InMemoryStore } from '@sensigo/realm-testing';
import { executeStep, submitHumanResponse } from '../engine/execution-loop.js';
import { ExtensionRegistry } from '../extensions/registry.js';
import type { StepHandler, StepHandlerResult } from '../extensions/step-handler.js';
import type { EvidenceSnapshot, RunRecord } from '../types/run-record.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
import { loadWorkflowFromString } from '../workflow/yaml-loader.js';
import {
  memoryKeyHashOf,
  memoryRowsOf,
  type MemoryForgetMarker,
  type MemoryHorizon,
  type MemoryRowsInput,
} from './memory-store.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const dispatcher = async () => ({});

async function newRun(store: InMemoryStore, def: WorkflowDefinition): Promise<string> {
  const { record } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
  return record.id;
}

/** The handler offer case of unit 1a: `norm` gives the key, `offer` the output. */
function registryOf(email: unknown): ExtensionRegistry {
  const registry = new ExtensionRegistry();
  const norm = { data: email === undefined ? {} : { email } } as StepHandlerResult;
  registry.register('handler', 'norm', { id: 'norm', execute: async () => norm } as StepHandler);
  registry.register('handler', 'offer', {
    id: 'offer',
    execute: async () => ({ data: { rung: 2 } }),
  } as StepHandler);
  return registry;
}

function offerWorkflow(remember: string): WorkflowDefinition {
  return loadWorkflowFromString(`id: offers-g3u2a
name: Offers
version: 1
steps:
  normalize_email:
    description: Normalise the customer's email.
    execution: auto
    handler: norm
  record_offer:
    description: Record the offer made.
    execution: auto
    handler: offer
    depends_on: [normalize_email]
${remember}`);
}

const OFFER_KEY = `    remember:
      as: offers
      key: { customer_email: context.resources.normalize_email.email }
      keep_days: 90
`;

/** Runs both steps of the offer case by name; returns the second reply and the stored record. */
async function runOffer(remember: string, email: unknown) {
  const store = new InMemoryStore();
  const def = offerWorkflow(remember);
  const runId = await newRun(store, def);
  const base = { runId, input: {}, dispatcher, registry: registryOf(email) };
  await executeStep(store, def, { ...base, command: 'normalize_email' });
  const reply = await executeStep(store, def, { ...base, command: 'record_offer' });
  return { reply, stored: (await store.get(runId)).record };
}

const lastOf = (r: RunRecord, step: string): EvidenceSnapshot =>
  r.evidence.filter((e) => e.step_id === step).at(-1)!;
const warned = (warnings: string[]): string[] =>
  warnings.filter((w) => w.includes('remembered nothing'));

describe('gap 3 (2a), check 1 — a key part over 1 KB in UTF-8 remembers nothing', () => {
  const TOO_LARGE: Array<[string, string]> = [
    ['1,025 one-byte characters', 'a'.repeat(1025)],
    ['400 three-byte characters (1,200 bytes)', '€'.repeat(400)],
  ];
  for (const [label, email] of TOO_LARGE) {
    it(`${label}: key_too_large on customer_email, and the reply's warning`, async () => {
      const { stored, reply } = await runOffer(OFFER_KEY, email);
      // (a) red when the cap is gone or counts characters (400 three-byte characters are 400 of
      //     them); (b) prints the stamp and the warning.
      expect({
        stamp: lastOf(stored, 'record_offer').remembered,
        warned: warned(reply.warnings),
      }).toEqual({
        stamp: { as: 'offers', not_remembered: 'key_too_large', key_name: 'customer_email' },
        warned: [
          "Step 'record_offer' remembered nothing in 'offers': its key 'customer_email' was over 1 KB.",
        ],
      });
    });
  }

  it('a part of exactly 1,024 bytes is remembered (the bound is "over")', async () => {
    const { stored } = await runOffer(OFFER_KEY, 'a'.repeat(1024));
    // (a) red when the cap is "at or over"; (b) prints the stamp's key.
    expect((lastOf(stored, 'record_offer').remembered as { key?: unknown }).key).toEqual({
      customer_email: 'a'.repeat(1024),
    });
  });

  it('{ customer_email: 2 KB, region: absent }: key_too_large on customer_email, the first part written', async () => {
    const remember = `    remember:
      as: offers
      key:
        customer_email: context.resources.normalize_email.email
        region: context.resources.normalize_email.region
      keep_days: 90
`;
    const { stored } = await runOffer(remember, 'b'.repeat(2048));
    // (a) red when the cap runs as a second pass after every part (region's key_absent would be
    //     named first); (b) prints the stamp.
    expect(lastOf(stored, 'record_offer').remembered).toEqual({
      as: 'offers',
      not_remembered: 'key_too_large',
      key_name: 'customer_email',
    });
  });
});

const SCHEMA = '{ type: object, required: [route], properties: { route: { type: string } } }';
const GATE = `    trust: human_confirmed
    gate:
      choices: [approve, reject]
`;

/** An agent step that remembers its route under `key`'s parts; `extra` goes on the step. */
function routeWorkflow(extra = '', key = '{ route: context.resources.classify.route }') {
  return loadWorkflowFromString(`id: routes-g3u2a
name: Routes
version: 1
steps:
  classify:
    description: Route the ticket.
    execution: agent
    output_schema: ${SCHEMA}
${extra}    remember:
      as: routes
      key: ${key}
      keep_days: 30
`);
}

/** The agent's answer to `classify`, through the library's door; the stored record. */
async function answerRoute(def: WorkflowDefinition, store = new InMemoryStore()) {
  const runId = await newRun(store, def);
  const reply = await executeStep(store, def, {
    runId,
    command: 'classify',
    // The agent's answer, checked against the output schema; the dispatcher hands it back as the
    // step's output, as the assistant's door does.
    input: { route: 'billing', team: 'north' },
    dispatcher: async (_step, input) => ({ ...input }),
  });
  return { runId, reply, store, record: (await store.get(runId)).record };
}

/** `memoryRowsOf` over a run's whole evidence, from its first entry, with no markers or horizons. */
function rowsOfRecord(record: RunRecord, extra: Partial<MemoryRowsInput> = {}) {
  return memoryRowsOf({
    workflowId: record.workflow_id,
    workflowVersion: record.workflow_version,
    runId: record.id,
    evidence: record.evidence,
    fromSeq: 0,
    forgotten: [],
    horizons: [],
    ...extra,
  });
}

const plusDays = (at: string, days: number): string =>
  new Date(Date.parse(at) + days * DAY_MS).toISOString();

describe('gap 3 (2a), check 2 — the rows of stamps a real settle wrote', () => {
  it("an ungated agent writer: one row, its supplier 'agent', its value the entry's output", async () => {
    const { record } = await answerRoute(routeWorkflow());
    const entry = lastOf(record, 'classify');
    const seq = record.evidence.indexOf(entry);
    // (a) red when the row leaves out `supplied_by`, or any field differs from the entry and its
    //     stamp; (b) prints the rows and the skips.
    expect(rowsOfRecord(record)).toEqual({
      rows: [
        {
          run_id: record.id,
          seq,
          workflow_id: 'routes-g3u2a',
          workflow_version: 1,
          step: 'classify',
          memory: 'routes',
          key: { route: 'billing' },
          key_hash: memoryKeyHashOf({ route: 'billing' }),
          at: entry.completed_at,
          expires_at: plusDays(entry.completed_at, 30),
          supplied_by: 'agent',
          value: entry.output_summary,
        },
      ],
      skipped: [],
    });
    expect(entry.supplied_by).toBe('agent');
  });

  it("a gated agent writer's answer: its choice, and the supplier of the entry its question opened on", async () => {
    const store = new InMemoryStore();
    const def = routeWorkflow(GATE);
    const { runId, reply: opened } = await answerRoute(def, store);
    expect(opened.status).toBe('confirm_required');
    const gate = (await store.get(runId)).record.pending_gate!;
    await submitHumanResponse(store, def, { runId, gateId: gate.gate_id, choice: 'approve' });
    const record = (await store.get(runId)).record;
    const answer = lastOf(record, 'classify');
    expect(answer.kind).toBe('gate_response');
    expect('supplied_by' in answer).toBe(false);
    // (a) red when the row takes the answer's own (absent) supplier, or drops the choice; (b)
    //     prints the rows.
    expect(rowsOfRecord(record).rows).toEqual([
      {
        run_id: runId,
        seq: record.evidence.indexOf(answer),
        workflow_id: 'routes-g3u2a',
        workflow_version: 1,
        step: 'classify',
        memory: 'routes',
        key: { route: 'billing' },
        key_hash: memoryKeyHashOf({ route: 'billing' }),
        at: answer.completed_at,
        expires_at: plusDays(answer.completed_at, 30),
        choice: 'approve',
        supplied_by: 'agent',
        value: answer.output_summary,
      },
    ]);
  });

  it("a handler writer with no value: no supplier, its value the entry's output", async () => {
    const { stored } = await runOffer(OFFER_KEY, 'jane@example.com');
    const entry = lastOf(stored, 'record_offer');
    // (a) red when a supplier is made up for a handler's entry, or the value is not the output;
    //     (b) prints the rows.
    expect(rowsOfRecord(stored).rows).toEqual([
      {
        run_id: stored.id,
        seq: stored.evidence.indexOf(entry),
        workflow_id: 'offers-g3u2a',
        workflow_version: 1,
        step: 'record_offer',
        memory: 'offers',
        key: { customer_email: 'jane@example.com' },
        key_hash: '930017afe1d0f6bbe783b1a176c2da85af206873bccff7e219386997a3b868f4',
        at: entry.completed_at,
        expires_at: plusDays(entry.completed_at, 90),
        value: { rung: 2 },
      },
    ]);
  });

  it('the key in name order whatever the stamp holds; the hash by the parts, never their order or kind', async () => {
    const { record } = await answerRoute(
      routeWorkflow(
        '',
        '{ team: context.resources.classify.team, route: context.resources.classify.route }',
      ),
    );
    const stamp = lastOf(record, 'classify').remembered as { key: Record<string, string> };
    const [row] = rowsOfRecord(record).rows;
    // (a) red when the row keeps the stamp's own order, or the hash reads the order or drops the
    //     names; (b) prints the names and the hashes.
    expect({
      stamped: Object.keys(stamp.key),
      row: Object.keys(row?.key ?? {}),
      hashOfRow: row?.key_hash,
      reordered: memoryKeyHashOf({ b: '1', a: '2' }) === memoryKeyHashOf({ a: '2', b: '1' }),
      kinds: memoryKeyHashOf({ customer_id: '123' }) === memoryKeyHashOf({ order_id: '123' }),
    }).toEqual({
      stamped: ['team', 'route'],
      row: ['route', 'team'],
      hashOfRow: memoryKeyHashOf({ team: 'north', route: 'billing' }),
      reordered: true,
      kinds: false,
    });
  });

  it("an imported entry's supplier is kept as stored when it is text, and skipped when it is not", async () => {
    const { record } = await answerRoute(routeWorkflow());
    const entry = lastOf(record, 'classify');
    const human = { ...entry, supplied_by: 'human' };
    const five = { ...entry, supplied_by: 5 };
    // (a) red when a word other than `agent` is refused, or a number is kept; (b) prints the
    //     result.
    expect(rowsOfRecord({ ...record, evidence: [human, five] as EvidenceSnapshot[] })).toEqual({
      rows: [expect.objectContaining({ seq: 0, supplied_by: 'human' })],
      skipped: [{ seq: 1, reason: 'invalid' }],
    });
  });

  it('rows only from fromSeq on; two entries with one memory and key give two rows', async () => {
    const { record } = await answerRoute(routeWorkflow());
    const entry = lastOf(record, 'classify');
    const evidence = [entry, entry, entry];
    // (a) red when entries before fromSeq are read for rows, or rows are merged by key; (b) prints
    //     the seqs.
    expect(
      rowsOfRecord({ ...record, evidence }, { fromSeq: 1 }).rows.map((r) => [r.seq, r.key_hash]),
    ).toEqual([
      [1, memoryKeyHashOf({ route: 'billing' })],
      [2, memoryKeyHashOf({ route: 'billing' })],
    ]);
  });
});

const AT = '2026-01-01T00:00:00.000Z';

/** An entry as an import may bring it: the offer case's stamp, its parts replaceable. */
function imported(
  stamp: Record<string, unknown> | null = {},
  entry: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    step_id: 'record_offer',
    status: 'success',
    completed_at: AT,
    output_summary: { rung: 2 },
    remembered:
      stamp === null
        ? null
        : {
            as: 'offers',
            key: { customer_email: 'jane@example.com' },
            expires_at: plusDays(AT, 90),
            ...stamp,
          },
    ...entry,
  };
}

function rowsOf(evidence: unknown[], extra: Partial<MemoryRowsInput> = {}) {
  return memoryRowsOf({
    workflowId: 'offers-g3u2a',
    workflowVersion: 1,
    runId: 'run-1',
    evidence,
    fromSeq: 0,
    forgotten: [],
    horizons: [],
    ...extra,
  });
}

describe('gap 3 (2a), check 3 — every stamp is read again, whatever wrote it', () => {
  it('a stamp that remembered nothing, and an entry with no stamp: nothing, not even a skip', () => {
    const notRemembered = imported(
      {},
      { remembered: { as: 'offers', not_remembered: 'key_absent', key_name: 'customer_email' } },
    );
    const { remembered: _gone, ...unstamped } = imported();
    // (a) red when either is skipped or gives a row; (b) prints the result.
    expect(rowsOf([notRemembered, unstamped])).toEqual({ rows: [], skipped: [] });
  });

  it('the readable stamp gives its row (the cells below each break one part of it)', () => {
    // (a) red when the base the cells change is itself refused; (b) prints the result.
    expect(rowsOf([imported()]).rows).toHaveLength(1);
    expect(rowsOf([imported({ key: { customer_email: 'a'.repeat(1024) } })]).rows).toHaveLength(1);
    const exactly = { t: 'x'.repeat(32_768 - '{"t":""}'.length) };
    expect(rowsOf([imported({ value: exactly })]).rows).toHaveLength(1);
  });

  const INVALID: Array<[string, Record<string, unknown> | null, Record<string, unknown>?]> = [
    ['a masked part', { key: { customer_email: '‹string, 16 characters›' } }],
    ['an empty part', { key: { customer_email: '' } }],
    ['a 1,025-byte part', { key: { customer_email: 'a'.repeat(1025) } }],
    ['a 65-character name', { key: { ['n'.repeat(65)]: 'jane@example.com' } }],
    ['a bad as', { as: 'not-a-name' }],
    ['a key {}', { key: {} }],
    ['a number part', { key: { customer_email: 5 } }],
    ['a choice that is not text', { choice: 1 }],
    ['a step_id that is not text', {}, { step_id: 7 }],
    ['a completed_at that does not read', {}, { completed_at: 'not a time' }],
    ['expires_at "2030-01-01"', { expires_at: '2030-01-01' }],
    [
      'expires_at 36 hours after at',
      { expires_at: new Date(Date.parse(AT) + 36 * 3_600_000).toISOString() },
    ],
    ['a 32,769-byte value', { value: { t: 'x'.repeat(32_769 - '{"t":""}'.length) } }],
    ['a value that is an array', { value: ['rung'] }],
    ['remembered: null', null],
  ];
  for (const [label, stamp, entry] of INVALID) {
    it(`${label}: one invalid skip, no row`, () => {
      // (a) red when the stamp is trusted as written, or this part's check is gone (for
      //     "2030-01-01", when `parseStamp` replaces the canonical-instant check); (b) prints the
      //     result.
      expect(rowsOf([imported(stamp, entry)])).toEqual({
        rows: [],
        skipped: [{ seq: 0, reason: 'invalid' }],
      });
    });
  }
});

describe("gap 3 (2a), check 4 — forget markers and horizons, at or after the row's time", () => {
  const hash = memoryKeyHashOf({ customer_email: 'jane@example.com' });
  const msBefore = new Date(Date.parse(AT) - 1).toISOString();
  const marker = (m: Partial<MemoryForgetMarker>): MemoryForgetMarker => ({
    memory: 'offers',
    key_hash: hash,
    forgotten_at: AT,
    ...m,
  });
  const horizon = (h: Partial<MemoryHorizon>): MemoryHorizon => ({
    memory: 'offers',
    through: AT,
    ...h,
  });
  const CASES: Array<[string, Partial<MemoryRowsInput>, string | undefined]> = [
    ["a marker at the row's time", { forgotten: [marker({})] }, 'forgotten'],
    [
      'a marker a millisecond before it',
      { forgotten: [marker({ forgotten_at: msBefore })] },
      undefined,
    ],
    ['a marker for another memory', { forgotten: [marker({ memory: 'quotes' })] }, undefined],
    [
      'a marker for another key',
      { forgotten: [marker({ key_hash: memoryKeyHashOf({ customer_email: 'x@example.com' }) })] },
      undefined,
    ],
    [
      'a marker whose time is "yesterday"',
      { forgotten: [marker({ forgotten_at: 'yesterday' })] },
      'forgotten',
    ],
    ["a horizon at the row's time", { horizons: [horizon({})] }, 'before_horizon'],
    [
      'a horizon a millisecond before it',
      { horizons: [horizon({ through: msBefore })] },
      undefined,
    ],
    ['a horizon for another memory', { horizons: [horizon({ memory: 'quotes' })] }, undefined],
    [
      'a horizon whose time is "yesterday"',
      { horizons: [horizon({ through: 'yesterday' })] },
      'before_horizon',
    ],
  ];
  for (const [label, extra, reason] of CASES) {
    it(`${label}: ${reason ?? 'the row'}`, () => {
      // (a) red when the comparison is strict (after, not at or after), a marker reads another
      //     memory or key, or an unreadable time does not fail closed; (b) prints the result.
      expect(rowsOf([imported()], extra)).toEqual(
        reason === undefined
          ? { rows: [expect.objectContaining({ seq: 0 })], skipped: [] }
          : { rows: [], skipped: [{ seq: 0, reason }] },
      );
    });
  }
});

describe("gap 3 (2a), check 5 — expired only by the caller's now", () => {
  const expires = plusDays(AT, 90);
  const CASES: Array<[string, Date | undefined, string | undefined]> = [
    ['now a millisecond past expires_at', new Date(Date.parse(expires) + 1), 'expired'],
    ['now equal to expires_at', new Date(expires), 'expired'],
    ['now a millisecond before expires_at', new Date(Date.parse(expires) - 1), undefined],
    ['no now, expires_at long past', undefined, undefined],
  ];
  for (const [label, now, reason] of CASES) {
    it(`${label}: ${reason ?? 'the row'}`, () => {
      // (a) red when the expiry check runs without now (the current time in its place), or is
      //     strict; (b) prints the result.
      expect(rowsOf([imported()], now === undefined ? {} : { now })).toEqual(
        reason === undefined
          ? { rows: [expect.objectContaining({ seq: 0 })], skipped: [] }
          : { rows: [], skipped: [{ seq: 0, reason }] },
      );
    });
  }
});

describe('gap 3 (2a), check 6 — it never throws, whatever evidence holds', () => {
  it('[null, "x"]: an invalid skip for each, with its seq', () => {
    // (a) red when the field is read before the shape check ("x" has no `remembered`, so it
    //     would give nothing); (b) prints the result.
    expect(rowsOf([null, 'x'])).toEqual({
      rows: [],
      skipped: [
        { seq: 0, reason: 'invalid' },
        { seq: 1, reason: 'invalid' },
      ],
    });
  });

  it("an entry whose remembered throws when read: an invalid skip, and the next entry's row", () => {
    const throwing = Object.defineProperty({}, 'remembered', {
      enumerable: true,
      get() {
        throw new Error('fake: a getter that throws');
      },
    });
    // (a) red when an entry's throw escapes (the judgement unguarded); (b) prints the result.
    expect(rowsOf([throwing, imported()])).toEqual({
      rows: [expect.objectContaining({ seq: 1 })],
      skipped: [{ seq: 0, reason: 'invalid' }],
    });
  });
});
