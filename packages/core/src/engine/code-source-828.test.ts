// code-source-828.test.ts — #828 unit 2c (prompt feat-828-u2c-step-code-source.md rev 2.1, checks 1–5):
// each attempt's evidence entry of a step that runs a handler or an adapter records which code Realm
// chose for it, at the lookup, as `code_source`; entries that are not an attempt, and steps that run
// no code, carry none.
//
// Every cell runs the real engine over InMemoryStore with handlers and adapters written here. Names
// and data are synthetic. Every assertion carries (1) the change that turns it red and (2) what it
// prints when it fails.
import { describe, it, expect } from 'vitest';
import { InMemoryStore } from '@sensigo/realm-testing';
import {
  drainFinalizers,
  executeChain,
  executeStep,
  submitHumanResponse,
} from './execution-loop.js';
import { reclaimStep } from './reclaim-step.js';
import { ExtensionRegistry } from '../extensions/registry.js';
import { createDefaultRegistry } from '../extensions/default-registry.js';
import { codeTextOf } from '../extensions/code-text.js';
import { VERSION } from '../version.js';
import { WorkflowError } from '../types/workflow-error.js';
import type { StepHandler } from '../extensions/step-handler.js';
import type { ServiceAdapter } from '../extensions/service-adapter.js';
import type { EvidenceSnapshot } from '../types/run-record.js';
import type { StepDefinition, WorkflowDefinition } from '../types/workflow-definition.js';

const ok = (id: string): StepHandler => ({ id, execute: async () => ({ data: { ok: true } }) });
const hangs = (id: string): StepHandler => ({ id, execute: () => new Promise(() => undefined) });
const fetches = (id: string): ServiceAdapter =>
  ({
    id,
    fetch: async () => ({ status: 200, data: { fetched: true } }),
  }) as unknown as ServiceAdapter;

/** A workflow of the steps given, with `services` when given. */
function wf(
  steps: Record<string, StepDefinition>,
  services?: WorkflowDefinition['services'],
): WorkflowDefinition {
  return {
    id: `cs-828-${Math.random().toString(36).slice(2)}`,
    name: 'Code source',
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

async function newRun(store: InMemoryStore, def: WorkflowDefinition): Promise<string> {
  return (await store.create({ workflowId: def.id, workflowVersion: 1, params: {} })).record.id;
}

/** Runs `step` once; returns that step's stored entries. */
async function run(
  def: WorkflowDefinition,
  step: string,
  registry?: unknown,
  input: Record<string, unknown> = {},
  store = new InMemoryStore(),
): Promise<EvidenceSnapshot[]> {
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

/** Each entry's error code and code source, in order. */
const sourcesOf = (entries: EvidenceSnapshot[]) =>
  entries.map((e) => ({ error_code: e.error_code, code_source: e.code_source }));

describe('#828 unit 2c check 1 — one cell per producing branch', () => {
  // (1) red when the attempt's mint drops the source; (2) prints each entry's code and source.
  it('a handler step', async () => {
    const registry = new ExtensionRegistry();
    registry.register('handler', 'h', ok('h'));
    const entries = await run(wf({ s: auto({ handler: 'h' }) }), 's', registry);
    expect(sourcesOf(entries)).toEqual([
      {
        error_code: undefined,
        code_source: { kind: 'handler', name: 'h', from: registry.entry('handler', 'h')!.source },
      },
    ]);
  });

  // (1) red when the adapter's lookup sets no source, or drops `service`; (2) prints the entries.
  it('an adapter step, with its service', async () => {
    const registry = new ExtensionRegistry();
    registry.register('adapter', 'a', fetches('a'));
    const def = wf(
      { s: auto({ uses_service: 'svc' }) },
      { svc: { adapter: 'a', trust: 'engine_delivered' } },
    );
    expect(sourcesOf(await run(def, 's', registry))).toEqual([
      {
        error_code: undefined,
        code_source: {
          kind: 'adapter',
          name: 'a',
          service: 'svc',
          from: registry.entry('adapter', 'a')!.source,
        },
      },
    ]);
  });

  // (1) red when a failed attempt's mint drops the source, or a retry reuses no slot; (2) prints them.
  it('a handler that throws, then its retry: two entries, each with the source', async () => {
    let calls = 0;
    const registry = new ExtensionRegistry();
    registry.register('handler', 'h', {
      id: 'h',
      execute: async () => {
        calls++;
        if (calls === 1) {
          throw new WorkflowError('flaky once', {
            code: 'ENGINE_HANDLER_FAILED',
            category: 'ENGINE',
            agentAction: 'stop',
            retryable: true,
          });
        }
        return { data: { ok: true } };
      },
    });
    const def = wf({
      s: auto({ handler: 'h', retry: { max_attempts: 2, backoff: 'fixed', base_delay_ms: 1 } }),
    });
    const source = { kind: 'handler', name: 'h', from: registry.entry('handler', 'h')!.source };
    expect(sourcesOf(await run(def, 's', registry))).toEqual([
      { error_code: 'ENGINE_HANDLER_FAILED', code_source: source },
      { error_code: undefined, code_source: source },
    ]);
  });

  // (1) red when the abort's mint drops the source; (2) prints the entry's status and source.
  it("a handler's abort", async () => {
    const registry = new ExtensionRegistry();
    registry.register('handler', 'h', {
      id: 'h',
      execute: async () => ({ abort: { message: 'stop here' } }),
    });
    const entries = await run(wf({ s: auto({ handler: 'h' }) }), 's', registry);
    expect(entries.map((e) => ({ status: e.status, code_source: e.code_source }))).toEqual([
      {
        status: 'skipped',
        code_source: { kind: 'handler', name: 'h', from: registry.entry('handler', 'h')!.source },
      },
    ]);
  });

  // (1) red when the lookup's not-registered branch sets nothing (the slot keeps `not_looked_up`);
  //     (2) prints the entries.
  it('not registered: a handler step, and an adapter step with its service', async () => {
    const handlerEntries = await run(
      wf({ s: auto({ handler: 'nobody' }) }),
      's',
      new ExtensionRegistry(),
    );
    const adapterEntries = await run(
      wf(
        { s: auto({ uses_service: 'svc' }) },
        { svc: { adapter: 'nobody', trust: 'engine_delivered' } },
      ),
      's',
      new ExtensionRegistry(),
    );
    expect(sourcesOf([...handlerEntries, ...adapterEntries])).toEqual([
      {
        error_code: 'ENGINE_HANDLER_NOT_REGISTERED',
        code_source: { absent: 'not_registered', kind: 'handler', name: 'nobody' },
      },
      {
        error_code: 'ENGINE_ADAPTER_NOT_REGISTERED',
        code_source: { absent: 'not_registered', kind: 'adapter', name: 'nobody', service: 'svc' },
      },
    ]);
  });

  // (1) red when the slot starts empty, so a failure before the lookup records nothing; (2) prints
  //     the entries. Built in code: the YAML loader refuses both definitions.
  it('not looked up: a service that is not declared, and a hand-built service that names no adapter', async () => {
    const undeclared = await run(
      wf({ s: auto({ uses_service: 'svc' }) }),
      's',
      new ExtensionRegistry(),
    );
    const unnamed = await run(
      wf(
        { s: auto({ uses_service: 'svc' }) },
        {
          svc: { trust: 'engine_delivered' } as unknown as NonNullable<
            WorkflowDefinition['services']
          >[string],
        },
      ),
      's',
      new ExtensionRegistry(),
    );
    expect(sourcesOf([...undeclared, ...unnamed])).toEqual([
      {
        error_code: 'ENGINE_ADAPTER_FAILED',
        code_source: { absent: 'not_looked_up', kind: 'adapter', service: 'svc' },
      },
      {
        error_code: 'ENGINE_ADAPTER_NOT_REGISTERED',
        code_source: { absent: 'not_looked_up', kind: 'adapter', service: 'svc' },
      },
    ]);
  });
});

describe('#828 unit 2c check 1 — a finalizer in the drain', () => {
  const def = (fin: Partial<StepDefinition> = {}): WorkflowDefinition =>
    wf({
      work: auto({ handler: 'h_work' }),
      fin: {
        description: 'Cleanup.',
        execution: 'finalizer',
        on_outcome: 'always',
        handler: 'h_fin',
        ...fin,
      },
    });
  const handlers: Record<string, StepHandler> = {
    completed: ok('h_fin'),
    aborted: { id: 'h_fin', execute: async () => ({ abort: { message: 'cleanup stopped' } }) },
    thrown: {
      id: 'h_fin',
      execute: async () => {
        throw new Error('cleanup exploded');
      },
    },
    timed_out: hangs('h_fin'),
  };

  /** Seals a run with no cleanup handler (the pass halts), then drains with `kind`'s handler. */
  async function drained(kind: string): Promise<{ entries: EvidenceSnapshot[]; source: unknown }> {
    const store = new InMemoryStore();
    const d = def(kind === 'timed_out' ? { timeout_seconds: 0.05 } : {});
    const runId = await newRun(store, d);
    const sealing = new ExtensionRegistry();
    sealing.register('handler', 'h_work', ok('h_work'));
    await executeChain(store, d, {
      runId,
      command: 'work',
      input: {},
      dispatcher: async () => ({}),
      registry: sealing,
    });
    const draining = new ExtensionRegistry();
    draining.register('handler', 'h_fin', handlers[kind]!);
    await drainFinalizers(store, d, draining, runId);
    const { record } = await store.get(runId);
    return {
      entries: record.evidence.filter((e) => e.step_id === 'fin'),
      source: { kind: 'handler', name: 'h_fin', from: draining.entry('handler', 'h_fin')!.source },
    };
  }

  // (1) red when any of the drain's three mints drops the source (a timeout comes through the throw's
  //     mint); (2) prints the outcome, each entry's error code and its source.
  it.each(['completed', 'aborted', 'thrown', 'timed_out'])('%s', async (kind) => {
    const { entries, source } = await drained(kind);
    expect([kind, entries.map((e) => e.code_source)]).toEqual([kind, [source]]);
    if (kind === 'timed_out') expect(entries[0]!.error_code).toBe('STEP_TIMEOUT');
  });
});

describe('#828 unit 2c check 2 — timeouts, and code chosen that never ran', () => {
  // (1) red when the source is carried only on the call's return or throw (a STEP_TIMEOUT comes from
  //     the timer, outside the call); (2) prints the entry's code and source.
  it('a handler that times out records its source', async () => {
    const registry = new ExtensionRegistry();
    registry.register('handler', 'h', hangs('h'));
    const entries = await run(
      wf({ s: auto({ handler: 'h', timeout_seconds: 0.05 }) }),
      's',
      registry,
    );
    expect(sourcesOf(entries)).toEqual([
      {
        error_code: 'STEP_TIMEOUT',
        code_source: { kind: 'handler', name: 'h', from: registry.entry('handler', 'h')!.source },
      },
    ]);
  });

  // (1) red when the source is set only when the adapter's method is called (the wait comes first);
  //     (2) prints the second run's entry and how often the adapter ran.
  it("a rate-limit wait that times out records the adapter's source", async () => {
    let calls = 0;
    const registry = new ExtensionRegistry();
    registry.register('adapter', 'slow', {
      id: 'slow',
      fetch: async () => {
        calls++;
        return { status: 200, data: { n: calls } };
      },
    } as unknown as ServiceAdapter);
    const def = wf(
      { s: auto({ uses_service: 'svc', timeout_seconds: 0.05 }) },
      {
        svc: {
          adapter: 'slow',
          trust: 'engine_delivered',
          rate_limit: { requests_per_second: 0.01, burst: 1 },
        },
      },
    );
    await run(def, 's', registry); // takes the one token
    const waited = await run(def, 's', registry); // waits for the next one, and times out
    expect({ entries: sourcesOf(waited), calls }).toEqual({
      entries: [
        {
          error_code: 'STEP_TIMEOUT',
          code_source: {
            kind: 'adapter',
            name: 'slow',
            service: 'svc',
            from: registry.entry('adapter', 'slow')!.source,
          },
        },
      ],
      calls: 1,
    });
  });

  // (1) red when the source is set only when the adapter's method is called; (2) prints the entry.
  it("ADAPTER_OP_UNSUPPORTED records the adapter's source", async () => {
    const registry = new ExtensionRegistry();
    registry.register('adapter', 'only_fetch', fetches('only_fetch'));
    const def = wf(
      { s: auto({ uses_service: 'svc', service_method: 'delete' }) },
      {
        svc: { adapter: 'only_fetch', trust: 'engine_delivered' },
      },
    );
    expect(sourcesOf(await run(def, 's', registry))).toEqual([
      {
        error_code: 'ADAPTER_OP_UNSUPPORTED',
        code_source: {
          kind: 'adapter',
          name: 'only_fetch',
          service: 'svc',
          from: registry.entry('adapter', 'only_fetch')!.source,
        },
      },
    ]);
  });

  // (1) red when the source is set only when the handler is called (the map is resolved first);
  //     (2) prints the entry, and that the handler never ran.
  it("an input_map that throws records the handler's source", async () => {
    let calls = 0;
    const registry = new ExtensionRegistry();
    registry.register('handler', 'h', {
      id: 'h',
      execute: async () => {
        calls++;
        return { data: {} };
      },
    });
    const def = wf({
      s: auto({
        handler: 'h',
        input_map: { x: { $bogus: 'run.params.a' } } as unknown as NonNullable<
          StepDefinition['input_map']
        >,
      }),
    });
    expect({ entries: sourcesOf(await run(def, 's', registry)), calls }).toEqual({
      entries: [
        {
          error_code: 'INPUT_MAP_UNKNOWN_DIRECTIVE',
          code_source: { kind: 'handler', name: 'h', from: registry.entry('handler', 'h')!.source },
        },
      ],
      calls: 0,
    });
  });
});

describe('#828 unit 2c check 3 — entries that are not an attempt, and steps with no code', () => {
  // (1) red when a step that runs no code gets the field; (2) prints which entries carry one.
  it("an agent step's and a bare step's entries carry no field", async () => {
    const agent = await run(
      wf({ s: { description: 'A.', execution: 'agent', depends_on: [] } }),
      's',
      undefined,
      {
        answer: 1,
      },
    );
    const bare = await run(wf({ s: auto({}) }), 's');
    expect([...agent, ...bare].map((e) => 'code_source' in e)).toEqual([false, false]);
  });

  // (1) red when the field is stamped on every entry of a code step (the answer's entry gets one);
  //     (2) prints each entry's kind and whether it carries the field.
  it('the gate answer on a gated handler step carries none; its attempt does', async () => {
    const store = new InMemoryStore();
    const registry = new ExtensionRegistry();
    registry.register('handler', 'h', ok('h'));
    const def = wf({
      s: auto({ handler: 'h', trust: 'human_confirmed', gate: { choices: ['approve', 'reject'] } }),
    });
    const runId = await newRun(store, def);
    const opened = await executeStep(store, def, {
      runId,
      command: 's',
      input: {},
      dispatcher: async () => ({}),
      registry,
    });
    if (opened.gate === undefined) throw new Error(`fixture: no gate (${opened.status})`);
    await submitHumanResponse(store, def, {
      runId,
      gateId: opened.gate.gate_id,
      choice: 'approve',
      registry,
    });
    const { record } = await store.get(runId);
    expect(
      record.evidence.map((e) => ({ kind: e.kind ?? 'attempt', has: 'code_source' in e })),
    ).toEqual([
      { kind: 'attempt', has: true },
      { kind: 'gate_response', has: false },
    ]);
  });

  // (1) red when the field is stamped on every entry of a code step (the reclaim's audit line gets
  //     one); (2) prints whether the reclaim entry carries the field.
  it('the reclaim entry of a stuck handler step carries none', async () => {
    const store = new InMemoryStore();
    const def = wf({ s: auto({ handler: 'h' }) });
    const runId = await newRun(store, def);
    const { record: claimed } = await store.claimStep(runId, 's', def);
    await store.update({
      ...claimed,
      claims: { s: { deadline: new Date(Date.now() - 60_000).toISOString() } },
    });
    await reclaimStep(store, runId, 's');
    const { record } = await store.get(runId);
    const reclaimed = record.evidence.filter((e) => e.output_summary['reclaimed'] === true);
    expect(reclaimed.map((e) => 'code_source' in e)).toEqual([false]);
  });
});

describe('#828 unit 2c check 4 — where the chosen code came from', () => {
  // (1) red when `realm_version` is missing, or `replaces_built_in` is read from the name alone (the
  //     built-in's own code would get the flag); (2) prints the whole source.
  it("a built-in step: Realm's code, its version, no flag", async () => {
    const entries = await run(wf({ s: auto({ handler: 'check_quotes' }) }), 's');
    expect(entries.map((e) => e.code_source)).toEqual([
      {
        kind: 'handler',
        name: 'check_quotes',
        from: { source: 'built_in' },
        realm_version: VERSION,
      },
    ]);
  });

  /** A run of a `filesystem` service whose adapter the manifest built from catalog entry `use`. */
  async function catalogRun(use: string): Promise<unknown> {
    const registry = createDefaultRegistry();
    registry.register('adapter', 'filesystem', fetches('filesystem'), { source: 'catalog', use });
    const def = wf(
      { s: auto({ uses_service: 'files' }) },
      {
        files: { adapter: 'filesystem', trust: 'engine_delivered' },
      },
    );
    return (await run(def, 's', registry))[0]?.code_source;
  }

  // (1) red when `replaces_built_in` is read from the name alone, or `realm_version` is missing;
  //     (2) prints the source.
  it('filesystem: use: filesystem records catalog, Realm’s version and no flag', async () => {
    expect(await catalogRun('filesystem')).toEqual({
      kind: 'adapter',
      name: 'filesystem',
      service: 'files',
      from: { source: 'catalog', use: 'filesystem' },
      realm_version: VERSION,
    });
  });

  // (1) red when `realm_version` is set on every source; (2) prints the source.
  it('filesystem: use: http records catalog, replaces_built_in and no version', async () => {
    expect(await catalogRun('http')).toEqual({
      kind: 'adapter',
      name: 'filesystem',
      service: 'files',
      from: { source: 'catalog', use: 'http' },
      replaces_built_in: true,
    });
  });
});

describe('#828 unit 2c check 5 — a registry with only the four methods', () => {
  /** A registry holding only `getHandler`, `getAdapter`, `getOrCreateRateLimiter` and `has`. */
  function duck(
    handlers: Record<string, StepHandler>,
    adapters: Record<string, ServiceAdapter> = {},
  ) {
    const limits = createDefaultRegistry();
    return {
      getHandler: (n: string) => handlers[n],
      getAdapter: (n: string) => adapters[n],
      getOrCreateRateLimiter: limits.getOrCreateRateLimiter.bind(limits),
      has: (k: string, n: string) =>
        k === 'handler' ? n in handlers : k === 'adapter' && n in adapters,
    };
  }

  // (1) red when `entry()` is called unguarded (it throws on this registry, and the step fails);
  //     (2) prints the entry's code and source.
  it('records host_registered with the fingerprint of the object it returned', async () => {
    const h = ok('h');
    const entries = await run(wf({ s: auto({ handler: 'h' }) }), 's', duck({ h }));
    expect(sourcesOf(entries)).toEqual([
      {
        error_code: undefined,
        code_source: {
          kind: 'handler',
          name: 'h',
          from: { source: 'host_registered', ...codeTextOf(h) },
        },
      },
    ]);
  });

  // (1) red when the fingerprint is taken at each call (the handler changed itself after the first
  //     step); (2) prints both steps' fingerprints and the handler's fingerprint after the first.
  it('a handler that gives itself a function on first use keeps one fingerprint across two steps', async () => {
    const h = {
      id: 'h',
      limit: undefined as undefined | (() => number),
      async execute() {
        this.limit ??= () => 1;
        return { data: { ok: true } };
      },
    };
    const before = codeTextOf(h);
    const store = new InMemoryStore();
    const def = wf({ a: auto({ handler: 'h' }), b: auto({ handler: 'h', depends_on: ['a'] }) });
    const runId = await newRun(store, def);
    const registry = duck({ h });
    for (const command of ['a', 'b'])
      await executeStep(store, def, {
        runId,
        command,
        input: {},
        dispatcher: async () => ({}),
        registry: registry as unknown as ExtensionRegistry,
      });
    const { record } = await store.get(runId);
    const prints = record.evidence.map((e) => (e.code_source as { from?: unknown }).from);
    expect({ prints, changed: codeTextOf(h) }).toEqual({
      prints: [
        { source: 'host_registered', ...before },
        { source: 'host_registered', ...before },
      ],
      changed: expect.not.objectContaining(before),
    });
  });

  // (1) red when a duck's code is taken as Realm's (no flag on a built-in's name); (2) prints it.
  it('serving filesystem, it records replaces_built_in', async () => {
    const fs = fetches('filesystem');
    const def = wf(
      { s: auto({ uses_service: 'files' }) },
      {
        files: { adapter: 'filesystem', trust: 'engine_delivered' },
      },
    );
    const entries = await run(def, 's', duck({}, { filesystem: fs }));
    expect(entries.map((e) => e.code_source)).toEqual([
      {
        kind: 'adapter',
        name: 'filesystem',
        service: 'files',
        from: { source: 'host_registered', ...codeTextOf(fs) },
        replaces_built_in: true,
      },
    ]);
  });
});
