// code-source-reader-828.test.ts — #828 unit 2d (prompt feat-828-u2d-code-source-reader.md rev 2.1,
// checks 1–6): `codeSourceOf(entry, definition)` gives an evidence entry's `code_source`, read by its
// closed forms, or why the record has none, in `CODE_SOURCE_ABSENT_CAUSES`' order.
//
// The entries are the ones Realm writes: the real engine and registry over InMemoryStore, the run
// Realm 0.50.0 wrote into the CLI's corpus, and, where no test reaches a writer, that writer's own
// call with its own shape (named at the cell). Names and data are synthetic. Every assertion carries
// (1) the change that turns it red and (2) what it prints when it fails.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { InMemoryStore } from '@sensigo/realm-testing';
import {
  DEFAULT_VALIDATION_EXHAUSTION_THRESHOLD,
  drainFinalizers,
  executeChain,
  executeStep,
  submitHumanResponse,
  type ExecuteChainOptions,
} from './execution-loop.js';
import { reclaimStep } from './reclaim-step.js';
import { CODE_SOURCE_ABSENT_CAUSES, codeSourceOf } from './code-source.js';
import { captureEvidence } from '../evidence/snapshot.js';
import { ExtensionRegistry } from '../extensions/registry.js';
import { createDefaultRegistry } from '../extensions/default-registry.js';
import type { StepHandler } from '../extensions/step-handler.js';
import type { ServiceAdapter } from '../extensions/service-adapter.js';
import type { TraceBufferStore } from '../store/trace-buffer-store.js';
import type { EvidenceSnapshot, RunRecord } from '../types/run-record.js';
import type { StepCodeSource } from '../types/code-source.js';
import type { StepDefinition, WorkflowDefinition } from '../types/workflow-definition.js';

const ok = (id: string): StepHandler => ({ id, execute: async () => ({ data: { ok: true } }) });
const fetches = (id: string): ServiceAdapter =>
  ({
    id,
    fetch: async () => ({ status: 200, data: { fetched: true } }),
  }) as unknown as ServiceAdapter;
const HASH_A = 'a'.repeat(64);
const HASH_B = '0123456789abcdef'.repeat(4);

function wf(
  steps: Record<string, StepDefinition>,
  services?: WorkflowDefinition['services'],
): WorkflowDefinition {
  return {
    id: `csr-828-${Math.random().toString(36).slice(2)}`,
    name: 'Code source reader',
    version: 1,
    steps,
    ...(services !== undefined ? { services } : {}),
  };
}

const auto = (extra: Partial<StepDefinition>): StepDefinition => ({
  description: 'S.',
  execution: 'auto',
  depends_on: [],
  ...extra,
});
const agentStep = (extra: Partial<StepDefinition> = {}): StepDefinition => ({
  description: 'A.',
  execution: 'agent',
  depends_on: [],
  ...extra,
});

async function newRun(store: InMemoryStore, def: WorkflowDefinition): Promise<string> {
  return (await store.create({ workflowId: def.id, workflowVersion: 1, params: {} })).record.id;
}

/** Runs `step` once; returns that step's stored entries. */
async function run(
  def: WorkflowDefinition,
  step: string,
  registry?: unknown,
  input: Record<string, unknown> = {},
): Promise<EvidenceSnapshot[]> {
  const store = new InMemoryStore();
  const runId = await newRun(store, def);
  await executeStep(store, def, {
    runId,
    command: step,
    input,
    dispatcher: async () => ({ dispatched: true }),
    ...(registry !== undefined ? { registry: registry as ExtensionRegistry } : {}),
  });
  return (await store.get(runId)).record.evidence.filter((e) => e.step_id === step);
}

/** The reader's answer for `entry`, as stored and after a JSON store's round trip. */
const answers = (entry: EvidenceSnapshot, def: WorkflowDefinition | undefined) => ({
  stored: codeSourceOf(entry, def),
  json: codeSourceOf(JSON.parse(JSON.stringify(entry)) as EvidenceSnapshot, def),
});

/** `entry` with no `code_source`, as Realm 0.50.0 wrote such an entry. */
function withoutField(entry: EvidenceSnapshot): EvidenceSnapshot {
  const { code_source: _field, ...rest } = entry;
  return rest;
}

describe('#828 unit 2d — the causes', () => {
  // (1) red when a cause is renamed, added, dropped or moved; (2) prints the list.
  it('are exported in the order the reader asks them', () => {
    expect(CODE_SOURCE_ABSENT_CAUSES).toEqual([
      'unreadable',
      'not_a_code_entry',
      'definition_unavailable',
      'not_a_code_step',
      'predates_code_source',
    ]);
  });
});

describe('#828 unit 2d check 1 — every form 2c writes, read back', () => {
  /**
   * The one entry of `step`, the form its field is in (the keys that pick the form), and the
   * reader's answers. Each cell expects `{ source }` equal to the stored field, stored and after a
   * JSON round trip.
   */
  async function readBack(
    def: WorkflowDefinition,
    registry?: unknown,
  ): Promise<{ form: unknown; answers: unknown; expected: unknown }> {
    const [entry, ...more] = await run(def, 's', registry);
    if (entry === undefined || more.length > 0)
      throw new Error(`fixture: ${more.length + 1} entries`);
    const field = entry.code_source as (StepCodeSource & Record<string, unknown>) | undefined;
    const from = field?.['from'] as Record<string, unknown> | undefined;
    return {
      form: {
        absent: field?.['absent'],
        from: from?.['source'],
        from_absent: from?.['absent'],
        members: field === undefined ? [] : Object.keys(field).sort(),
      },
      answers: answers(entry, def),
      expected: { stored: { source: field }, json: { source: field } },
    };
  }

  // (1) red when the reader ignores the field, or refuses `built_in`; (2) prints the form and both
  //     answers.
  it("built-in: Realm's own check_quotes, with Realm's version", async () => {
    const got = await readBack(wf({ s: auto({ handler: 'check_quotes' }) }));
    expect(got.form).toEqual({
      absent: undefined,
      from: 'built_in',
      from_absent: undefined,
      members: ['from', 'kind', 'name', 'realm_version'],
    });
    expect(got.answers).toEqual(got.expected);
  });

  /** A `filesystem` service whose adapter the manifest built from catalog entry `use`. */
  function catalog(use: string): [WorkflowDefinition, ExtensionRegistry] {
    const registry = createDefaultRegistry();
    registry.register('adapter', 'filesystem', fetches('filesystem'), { source: 'catalog', use });
    return [
      wf(
        { s: auto({ uses_service: 'files' }) },
        { files: { adapter: 'filesystem', trust: 'engine_delivered' } },
      ),
      registry,
    ];
  }

  // (1) red when the reader refuses `catalog`, or an adapter's `service` or `realm_version`; (2)
  //     prints the form and both answers.
  it("catalog, use: filesystem: an adapter step with its service and Realm's version", async () => {
    const got = await readBack(...catalog('filesystem'));
    expect(got.form).toEqual({
      absent: undefined,
      from: 'catalog',
      from_absent: undefined,
      members: ['from', 'kind', 'name', 'realm_version', 'service'],
    });
    expect(got.answers).toEqual(got.expected);
  });

  // (1) red when the reader refuses `replaces_built_in: true`; (2) prints the form and both answers.
  it('catalog, use: http: a replacement of the built-in filesystem adapter', async () => {
    const got = await readBack(...catalog('http'));
    expect(got.form).toEqual({
      absent: undefined,
      from: 'catalog',
      from_absent: undefined,
      members: ['from', 'kind', 'name', 'replaces_built_in', 'service'],
    });
    expect(got.answers).toEqual(got.expected);
  });

  // (1) red when the reader refuses a project's hashes; (2) prints the form and both answers.
  it("project, with hashes: a project's module that replaces the built-in check_quotes", async () => {
    const registry = createDefaultRegistry();
    registry.register('handler', 'check_quotes', ok('check_quotes'), {
      source: 'project',
      declared: './ext/check-quotes.mjs',
      via: 'extensions_file',
      entry_hash: HASH_A,
      folder_tree_hash: HASH_B,
    });
    const got = await readBack(wf({ s: auto({ handler: 'check_quotes' }) }), registry);
    expect(got.form).toEqual({
      absent: undefined,
      from: 'project',
      from_absent: undefined,
      members: ['from', 'kind', 'name', 'replaces_built_in'],
    });
    expect(got.answers).toEqual(got.expected);
  });

  // (1) red when the reader refuses `hashes_unavailable`; (2) prints the form and both answers.
  it('project, hashes_unavailable: a manifest module whose files could not be read', async () => {
    const registry = new ExtensionRegistry();
    registry.register('handler', 'h', ok('h'), {
      source: 'project',
      declared: './ext/h.mjs',
      via: 'manifest',
      absent: 'hashes_unavailable',
    });
    const got = await readBack(wf({ s: auto({ handler: 'h' }) }), registry);
    expect(got.form).toEqual({
      absent: undefined,
      from: 'project',
      from_absent: 'hashes_unavailable',
      members: ['from', 'kind', 'name'],
    });
    expect(got.answers).toEqual(got.expected);
  });

  // (1) red when the reader refuses `host_registered`; (2) prints the form and both answers.
  it("host fingerprint: a host's handler registered with no source", async () => {
    const registry = new ExtensionRegistry();
    registry.register('handler', 'h', ok('h'));
    const got = await readBack(wf({ s: auto({ handler: 'h' }) }), registry);
    expect(got.form).toEqual({
      absent: undefined,
      from: 'host_registered',
      from_absent: undefined,
      members: ['from', 'kind', 'name'],
    });
    expect(got.answers).toEqual(got.expected);
  });

  // (1) red when the reader refuses `code_text_unavailable`; (2) prints the form and both answers.
  it("host code_text_unavailable: a host's handler whose execute is a bound function", async () => {
    const registry = new ExtensionRegistry();
    const execute = async function (this: unknown) {
      return { data: { ok: true } };
    };
    registry.register('handler', 'h', { id: 'h', execute: execute.bind(null) });
    const got = await readBack(wf({ s: auto({ handler: 'h' }) }), registry);
    expect(got.form).toEqual({
      absent: undefined,
      from: 'host_registered',
      from_absent: 'code_text_unavailable',
      members: ['from', 'kind', 'name'],
    });
    expect(got.answers).toEqual(got.expected);
  });

  // (1) red when the reader refuses `not_registered`, or its optional `service`; (2) prints the forms
  //     and the answers.
  it('not_registered: a handler step, and an adapter step with its service', async () => {
    const handler = await readBack(wf({ s: auto({ handler: 'nobody' }) }), new ExtensionRegistry());
    const adapter = await readBack(
      wf(
        { s: auto({ uses_service: 'svc' }) },
        { svc: { adapter: 'nobody', trust: 'engine_delivered' } },
      ),
      new ExtensionRegistry(),
    );
    expect([handler.form, adapter.form]).toEqual([
      {
        absent: 'not_registered',
        from: undefined,
        from_absent: undefined,
        members: ['absent', 'kind', 'name'],
      },
      {
        absent: 'not_registered',
        from: undefined,
        from_absent: undefined,
        members: ['absent', 'kind', 'name', 'service'],
      },
    ]);
    expect([handler.answers, adapter.answers]).toEqual([handler.expected, adapter.expected]);
  });

  // (1) red when the reader refuses `not_looked_up`, or either of its optional members; (2) prints the
  //     forms and the answers.
  it('not_looked_up: a lookup that throws (with a name), and an undeclared service (without one)', async () => {
    const limits = createDefaultRegistry();
    const throwing = {
      getHandler: () => {
        throw new Error('registry down');
      },
      getAdapter: () => undefined,
      getOrCreateRateLimiter: limits.getOrCreateRateLimiter.bind(limits),
      has: () => true,
    };
    const named = await readBack(wf({ s: auto({ handler: 'h' }) }), throwing);
    const unnamed = await readBack(
      wf({ s: auto({ uses_service: 'svc' }) }),
      new ExtensionRegistry(),
    );
    expect([named.form, unnamed.form]).toEqual([
      {
        absent: 'not_looked_up',
        from: undefined,
        from_absent: undefined,
        members: ['absent', 'kind', 'name'],
      },
      {
        absent: 'not_looked_up',
        from: undefined,
        from_absent: undefined,
        members: ['absent', 'kind', 'service'],
      },
    ]);
    expect([named.answers, unnamed.answers]).toEqual([named.expected, unnamed.expected]);
  });
});

describe('#828 unit 2d check 2 — unreadable', () => {
  /** A real host-registered handler entry, its field replaced by `field`. */
  async function realEntry(): Promise<[EvidenceSnapshot, WorkflowDefinition]> {
    const registry = new ExtensionRegistry();
    registry.register('handler', 'h', ok('h'));
    const def = wf({ s: auto({ handler: 'h' }) });
    const [entry] = await run(def, 's', registry);
    return [entry!, def];
  }
  const project = {
    source: 'project',
    declared: './ext/h.mjs',
    via: 'extensions_file',
    entry_hash: HASH_A,
    folder_tree_hash: HASH_B,
  };
  const chosen = { kind: 'handler', name: 'h', from: project };

  const CELLS: ReadonlyArray<readonly [string, unknown]> = [
    ['a non-string name', { ...chosen, name: 7 }],
    ["from.source: 'from_a_newer_realm'", { ...chosen, from: { source: 'from_a_newer_realm' } }],
    ['a member no form declares, on the field', { ...chosen, picked_by: 'a newer Realm' }],
    ['a member no form declares, on from', { ...chosen, from: { ...project, signed: true } }],
    ['replaces_built_in: false', { ...chosen, replaces_built_in: false }],
    [
      'a hash that is not lowercase hex',
      { ...chosen, from: { ...project, entry_hash: HASH_A.toUpperCase() } },
    ],
    [
      'a hash that is not 64 characters',
      { ...chosen, from: { ...project, folder_tree_hash: 'ab12' } },
    ],
    ["an unknown 'via'", { ...chosen, from: { ...project, via: 'pasted' } }],
    ["an unknown 'absent'", { absent: 'not_found', kind: 'handler', name: 'h' }],
    ['null', null],
    ['a string', 'check_quotes'],
    ['an array', [chosen]],
    // The four cross-form values (828-AUD2D-R-03): each a member declared in another form only.
    ['built_in with a use', { ...chosen, from: { source: 'built_in', use: 'filesystem' } }],
    [
      'project with both hashes and absent',
      { ...chosen, from: { ...project, absent: 'hashes_unavailable' } },
    ],
    [
      'not_registered with a from',
      { absent: 'not_registered', kind: 'handler', name: 'h', from: { source: 'built_in' } },
    ],
    [
      'host_registered with both code_text_sha256 and absent',
      {
        ...chosen,
        from: {
          source: 'host_registered',
          code_text_sha256: HASH_A,
          absent: 'code_text_unavailable',
        },
      },
    ],
  ];

  // (1) red when unknown members are tolerated (the two "no form declares" cells), one key set is
  //     shared across forms (the four cross-form cells), or a member's test is loosened; (2) prints
  //     each cell's name and both answers.
  it('every malformed or newer value reads unreadable, stored and after a JSON round trip', async () => {
    const [entry, def] = await realEntry();
    const got = CELLS.map(([name, field]) => [
      name,
      answers({ ...entry, code_source: field as StepCodeSource }, def),
    ]);
    const unreadable = { absent_cause: 'unreadable' };
    expect(got).toEqual(CELLS.map(([name]) => [name, { stored: unreadable, json: unreadable }]));
  });

  // (1) red when the field's read is not guarded (a getter's throw escapes); (2) prints the answer.
  it('a field whose read throws reads unreadable, and the reader does not throw', async () => {
    const [entry, def] = await realEntry();
    const hostile = {
      kind: 'handler',
      get name(): string {
        throw new Error('a host object, not data');
      },
    };
    expect(
      codeSourceOf({ ...entry, code_source: hostile as unknown as StepCodeSource }, def),
    ).toEqual({
      absent_cause: 'unreadable',
    });
  });
});

describe('#828 unit 2d check 3 — not_a_code_entry, the markers the journey does not reach', () => {
  // (1) red when `gate_cancelled_by_abort` is not a marker (the entry then reads
  //     predates_code_source: the gate is on a handler step); (2) prints each entry and its answer.
  //     The house's "realistic fan-out" (envelope-pins-279.test.ts, the audit's P2): a handler step
  //     a person confirms, and a sibling handler that aborts while the gate is open.
  it("a gate on a handler step, cancelled by a sibling's abort (settlement.ts applyAbortEdge)", async () => {
    const def = wf({
      gated: auto({
        handler: 'h',
        trust: 'human_confirmed',
        gate: { choices: ['approve', 'reject'] },
      }),
      aborter: auto({ handler: 'ab' }),
    });
    const registry = new ExtensionRegistry();
    registry.register('handler', 'h', {
      id: 'h',
      execute: async () => ({ data: { preview: true } }),
    });
    registry.register('handler', 'ab', {
      id: 'ab',
      execute: async () => ({ abort: { message: 'stop' } }),
    });
    const store = new InMemoryStore();
    const runId = await newRun(store, def);
    const { record: claimed } = await store.claimStep(runId, 'aborter', def);
    const token = claimed.claims?.['aborter']?.token;
    const opened = await executeStep(store, def, { runId, command: 'gated', input: {}, registry });
    if (opened.gate === undefined) throw new Error(`fixture: no gate (${opened.status})`);
    const settled = await store.settleStep(
      runId,
      {
        kind: 'settle_step',
        step: 'aborter',
        outcome: 'abort',
        ...(token !== undefined ? { claimToken: token } : {}),
        evidence: [],
        abort: { stepId: 'aborter', abortMessage: 'stop' },
      },
      def,
    );
    if (!settled.applied) throw new Error('fixture: the abort was not applied');
    const { record } = await store.get(runId);
    const cancelled = record.evidence.filter(
      (e) => e.output_summary['gate_cancelled_by_abort'] === true,
    );
    expect(cancelled.map((e) => [e.step_id, 'code_source' in e, codeSourceOf(e, def)])).toEqual([
      ['gated', false, { absent_cause: 'not_a_code_entry' }],
    ]);
  });

  // (1) red when the operator's void is not a marker (the entry then reads predates_code_source: the
  //     finalizer has a handler), or `provenance` is not checked; (2) prints both answers. The writer
  //     is the CLI's `realm run drain --void` (packages/cli/src/commands/drain.ts), which core cannot
  //     drive: this is its own call of `captureEvidence`, with its own output.
  it("the operator's void of a finalizer with a handler (realm run drain --void's entry)", () => {
    const def = wf({
      work: auto({ handler: 'h_work' }),
      fin: {
        description: 'Cleanup.',
        execution: 'finalizer',
        on_outcome: 'always',
        handler: 'h_fin',
      },
    });
    const at = new Date('2026-11-26T12:00:00.000Z');
    const voided = (provenance: string) =>
      captureEvidence({
        stepId: 'fin',
        startedAt: at,
        completedAt: at,
        input: {},
        output: { voided: true, provenance, never_leased: true },
      });
    expect([codeSourceOf(voided('operator'), def), codeSourceOf(voided('a handler'), def)]).toEqual(
      [{ absent_cause: 'not_a_code_entry' }, { absent_cause: 'predates_code_source' }],
    );
  });

  // (1) red when `compensating_unclaim` is not a marker (the entry then reads not_a_code_step: Realm
  //     writes it for agent steps only, 828-AUD2D-R-04); (2) prints the entry's answer. The trace
  //     buffer's second read fails after the claim (execution-loop-fenced-trio-adoption.test.ts).
  it('the compensating un-claim on an agent step (its trace buffer read fails after the claim)', async () => {
    const def = wf({ s: agentStep() });
    const store = new InMemoryStore();
    const runId = await newRun(store, def);
    let reads = 0;
    const traceBufferStore: TraceBufferStore = {
      append: async () => {
        throw new Error('not used');
      },
      read: async () => {
        reads++;
        if (reads === 1) return [];
        throw new Error('simulated post-claim read failure');
      },
      delete: async () => {},
      deleteAllForRun: async () => ({ bytes_deleted: 0 }),
      statAllForRun: async () => ({ bytes: 0 }),
      readAllForRun: async () => ({}),
    };
    await executeStep(store, def, {
      runId,
      command: 's',
      input: {},
      dispatcher: async () => ({}),
      traceBufferStore,
    });
    const { record } = await store.get(runId);
    const unclaims = record.evidence.filter(
      (e) => e.output_summary['compensating_unclaim'] === true,
    );
    expect(unclaims.map((e) => codeSourceOf(e, def))).toEqual([
      { absent_cause: 'not_a_code_entry' },
    ]);
  });
});

describe('#828 unit 2d check 4 — definition_unavailable and not_a_code_step', () => {
  /** A handler step's real entry, without its field. */
  async function handlerEntry(): Promise<[EvidenceSnapshot, WorkflowDefinition]> {
    const registry = new ExtensionRegistry();
    registry.register('handler', 'h', ok('h'));
    const def = wf({ s: auto({ handler: 'h' }) });
    const [entry] = await run(def, 's', registry);
    return [withoutField(entry!), def];
  }

  // (1) red when a definition test is removed (the reader then reads a step that is not there, or
  //     an inherited one); (2) prints each case's answer.
  it('no definition, a definition without steps, without the step, or whose step is not an object', async () => {
    const [entry, def] = await handlerEntry();
    const cases = {
      none: codeSourceOf(entry, undefined),
      no_steps: codeSourceOf(entry, {} as WorkflowDefinition),
      steps_not_an_object: codeSourceOf(entry, {
        ...def,
        steps: 'none' as unknown as WorkflowDefinition['steps'],
      }),
      without_the_step: codeSourceOf(entry, wf({ other: auto({ handler: 'h' }) })),
      step_not_an_object: codeSourceOf(entry, wf({ s: null as unknown as StepDefinition })),
      inherited_function: codeSourceOf({ ...entry, step_id: 'toString' }, def),
      inherited_object: codeSourceOf({ ...entry, step_id: '__proto__' }, def),
    };
    const unavailable = { absent_cause: 'definition_unavailable' };
    expect(cases).toEqual({
      none: unavailable,
      no_steps: unavailable,
      steps_not_an_object: unavailable,
      without_the_step: unavailable,
      step_not_an_object: unavailable,
      inherited_function: unavailable,
      inherited_object: unavailable,
    });
  });

  /** The entries of an agent step, the model-failure entry included (gap 2 (ii-a)). */
  async function agentEntries(): Promise<[EvidenceSnapshot[], WorkflowDefinition]> {
    const def = wf({ classify: agentStep({ on_model_failure: 'fail' }) });
    const answered = await run(def, 'classify', undefined, { label: 'x' });
    const store = new InMemoryStore();
    const runId = await newRun(store, def);
    const failure: NonNullable<ExecuteChainOptions['modelFailure']> = {
      kind: 'transient',
      stop_reason: 'no_retry_policy',
      message: 'Anthropic 503: overloaded',
      attempt: 1,
      error_class: 'api_status',
      status: 503,
    };
    await executeChain(store, def, {
      runId,
      command: 'classify',
      input: {},
      dispatcher: async (_s, input) => ({ ...input }),
      modelFailure: failure,
    });
    const failed = (await store.get(runId)).record.evidence;
    return [[...answered, ...failed], def];
  }

  // (1) red when the predicate is not `codeRequirementForStep` (the finalizer with a handler then
  //     reads not_a_code_step), or an agent or bare step is taken as a code step; (2) prints each
  //     entry's step, its failure kind and the answer.
  it('agent, bare auto and finalizer steps: by the shared predicate', async () => {
    const [agent, agentDef] = await agentEntries();
    const bareDef = wf({ s: auto({}) });
    const bare = await run(bareDef, 's');
    const finDef = wf({
      work: auto({ handler: 'h_work' }),
      plain: { description: 'Note.', execution: 'finalizer', on_outcome: 'always' },
      fin: {
        description: 'Cleanup.',
        execution: 'finalizer',
        on_outcome: 'always',
        handler: 'h_fin',
      },
    });
    const at = new Date('2026-11-26T12:00:00.000Z');
    const finEntry = (stepId: string) =>
      captureEvidence({
        stepId,
        startedAt: at,
        completedAt: at,
        input: {},
        output: { done: true },
      });
    expect({
      agent: agent.map((e) => [e.diagnostics?.failure_kind ?? 'answer', codeSourceOf(e, agentDef)]),
      bare: bare.map((e) => codeSourceOf(e, bareDef)),
      finalizer_without_handler: codeSourceOf(finEntry('plain'), finDef),
      finalizer_with_handler: codeSourceOf(finEntry('fin'), finDef),
    }).toEqual({
      agent: [
        ['answer', { absent_cause: 'not_a_code_step' }],
        ['transient', { absent_cause: 'not_a_code_step' }],
      ],
      bare: [{ absent_cause: 'not_a_code_step' }],
      finalizer_without_handler: { absent_cause: 'not_a_code_step' },
      finalizer_with_handler: { absent_cause: 'predates_code_source' },
    });
  });
});

describe('#828 unit 2d check 5 — predates_code_source', () => {
  // (1) red when the cause is folded into not_a_code_step, or the predicate loses its third branch
  //     (an adapter step whose service is not declared); (2) prints each entry's answer.
  it("a handler step's, an adapter step's and an undeclared service's entries, with the field removed", async () => {
    const registry = new ExtensionRegistry();
    registry.register('handler', 'h', ok('h'));
    registry.register('adapter', 'a', fetches('a'));
    const handlerDef = wf({ s: auto({ handler: 'h' }) });
    const adapterDef = wf(
      { s: auto({ uses_service: 'svc' }) },
      { svc: { adapter: 'a', trust: 'engine_delivered' } },
    );
    const undeclaredDef = wf({ s: auto({ uses_service: 'svc' }) });
    const read = async (def: WorkflowDefinition) =>
      (await run(def, 's', registry)).map((e) => [
        'code_source' in e,
        codeSourceOf(withoutField(e), def),
      ]);
    const predates = { absent_cause: 'predates_code_source' };
    expect({
      handler: await read(handlerDef),
      adapter: await read(adapterDef),
      undeclared_service: await read(undeclaredDef),
    }).toEqual({
      handler: [[true, predates]],
      adapter: [[true, predates]],
      undeclared_service: [[true, predates]],
    });
  });

  // (1) red when the reader takes a stored record from before 2c as anything but what it is; (2)
  //     prints each entry's step, kind and answer. The run is the one Realm 0.50.0 wrote into the CLI's
  //     corpus (packages/cli/src/corpus/0.50.0), read with the definition stored beside it.
  it('the pull-request review run Realm 0.50.0 wrote, read with its stored definition', () => {
    const corpus = (path: string): unknown =>
      JSON.parse(
        readFileSync(
          fileURLToPath(new URL(`../../../cli/src/corpus/0.50.0/${path}`, import.meta.url)),
          'utf8',
        ),
      );
    const bundle = corpus('runs/08-pr-review.realm.json') as { run: RunRecord };
    const def = corpus('examples/08-pr-review/definition.json') as WorkflowDefinition;
    expect(
      bundle.run.evidence.map((e) => [e.step_id, e.kind ?? 'attempt', codeSourceOf(e, def)]),
    ).toEqual([
      ['fetch_pr', 'attempt', { absent_cause: 'predates_code_source' }],
      ['write_review', 'attempt', { absent_cause: 'not_a_code_step' }],
      ['confirm_review', 'attempt', { absent_cause: 'not_a_code_step' }],
      ['confirm_review', 'gate_response', { absent_cause: 'not_a_code_entry' }],
      ['post_approval', 'attempt', { absent_cause: 'predates_code_source' }],
    ]);
  });
});

describe('#828 unit 2d check 6 — one whole run, every entry', () => {
  // TESTING-RULES rule 10's whole-run exception: one run that reaches the writers a code step meets,
  // every entry's exact answer asserted against the writer table.
  //
  // (1) red when the gate or the reclaim marker is removed (those code-step entries read
  //     predates_code_source), or `settled_by_default` or `guard_conditions` is removed (those entries
  //     read not_a_code_step), or the reader ignores the field; (2) prints every entry in order: its
  //     step, what wrote it, and the answer.
  it('a gated handler, a reclaimed handler, an adapter, a default settle, a guard and a drained finalizer', async () => {
    const outputSchema = {
      type: 'object',
      required: ['category'],
      properties: { category: { type: 'string' } },
    };
    const def = wf(
      {
        gated: auto({
          handler: 'h_gated',
          trust: 'human_confirmed',
          gate: { choices: ['approve', 'reject'] },
        }),
        check: {
          description: 'Guard.',
          execution: 'guard',
          depends_on: ['gated'],
          abort_unless: ["gated.status == 'open'"],
        },
        stuck: auto({ handler: 'h_stuck' }),
        fetch: auto({ uses_service: 'svc' }),
        ask: agentStep({
          output_schema: outputSchema,
          validation_exhaustion: { mode: 'default', default_output: { category: 'fallback' } },
        }),
        fin: {
          description: 'Cleanup.',
          execution: 'finalizer',
          on_outcome: 'always',
          handler: 'h_fin',
        },
      },
      { svc: { adapter: 'a', trust: 'engine_delivered' } },
    );
    const registry = new ExtensionRegistry();
    registry.register('handler', 'h_gated', {
      id: 'h_gated',
      execute: async () => ({ data: { status: 'open' } }),
    });
    registry.register('handler', 'h_stuck', ok('h_stuck'));
    registry.register('handler', 'h_fin', ok('h_fin'));
    registry.register('adapter', 'a', fetches('a'));
    const store = new InMemoryStore();
    const runId = await newRun(store, def);
    const step = (command: string, input: Record<string, unknown> = {}) =>
      executeStep(store, def, {
        runId,
        command,
        input,
        dispatcher: async (_s, i) => ({ ...i }),
        registry,
      });

    // The gated handler: its attempt, then the person's answer (the guard settles on it).
    const opened = await step('gated');
    if (opened.gate === undefined) throw new Error(`fixture: no gate (${opened.status})`);
    await submitHumanResponse(store, def, {
      runId,
      gateId: opened.gate.gate_id,
      choice: 'approve',
      registry,
    });
    // The stuck handler: claimed, reclaimed past its deadline, then run.
    const { record: claimed } = await store.claimStep(runId, 'stuck', def);
    await store.update({
      ...claimed,
      claims: { stuck: { deadline: new Date(Date.now() - 60_000).toISOString() } },
    });
    await reclaimStep(store, runId, 'stuck');
    await step('stuck');
    await step('fetch');
    // The agent step, settled by default once its answers are exhausted (#220).
    const { record: before } = await store.get(runId);
    await store.update({
      ...before,
      validation_rejections: { ask: DEFAULT_VALIDATION_EXHAUSTION_THRESHOLD - 1 },
    });
    await step('ask', {});
    await drainFinalizers(store, def, registry, runId);

    const { record } = await store.get(runId);
    const source = (e: EvidenceSnapshot) => ({ source: e.code_source });
    const written = (e: EvidenceSnapshot): string =>
      e.kind === 'gate_response'
        ? 'gate answer'
        : e.output_summary['reclaimed'] === true
          ? 'reclaim'
          : e.diagnostics?.settled_by_default === true
            ? 'default settle'
            : e.diagnostics?.guard_conditions !== undefined
              ? 'guard pass'
              : 'attempt';
    const got = record.evidence.map((e) => [e.step_id, written(e), codeSourceOf(e, def)]);
    const byStep = (id: string, what: string) =>
      record.evidence.find((e) => e.step_id === id && written(e) === what)!;
    expect(got).toEqual([
      ['gated', 'attempt', source(byStep('gated', 'attempt'))],
      ['gated', 'gate answer', { absent_cause: 'not_a_code_entry' }],
      ['check', 'guard pass', { absent_cause: 'not_a_code_entry' }],
      ['stuck', 'reclaim', { absent_cause: 'not_a_code_entry' }],
      ['stuck', 'attempt', source(byStep('stuck', 'attempt'))],
      ['fetch', 'attempt', source(byStep('fetch', 'attempt'))],
      ['ask', 'default settle', { absent_cause: 'not_a_code_entry' }],
      ['fin', 'attempt', source(byStep('fin', 'attempt'))],
    ]);
    // Each `{ source }` above is a real field, not an absent one: the three handlers, the adapter.
    expect(
      ['gated', 'stuck', 'fetch', 'fin'].map((id) => {
        const field = byStep(id, 'attempt').code_source as Record<string, unknown> | undefined;
        return [id, field?.['kind'], field?.['absent']];
      }),
    ).toEqual([
      ['gated', 'handler', undefined],
      ['stuck', 'handler', undefined],
      ['fetch', 'adapter', undefined],
      ['fin', 'handler', undefined],
    ]);
  });
});
