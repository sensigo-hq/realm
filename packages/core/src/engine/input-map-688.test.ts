// input-map-688.test.ts — issue #688: an `auto` step that consumes its `input_map` (a `handler` or a
// `uses_service`) has its `input_schema` checked against the input the map builds — the input the
// step receives — by the view and by the engine alike; its refusal names a fix that can work.
//
// Every cell drives the public surfaces (`advanceRun`, `executeStep`, `describePending`, the ways
// composed from the record) — never the new predicates directly — so reverting the change turns them
// red. #729 PR-0: the way out is the refused step's `unavailable` entry — its remedies and whether a
// new run can change the input (`no_remedy` `start`); the doors' words for it are pinned in their
// renderer tests. Beside each: (a) what turns it red; (b) what it prints on failure (the reply's hint,
// the completed and failed steps, the handler's received input, the way out) — never an environment.
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileStore } from '../store/json-file-store.js';
import { advanceRun, executeStep, type StepDispatcher } from './execution-loop.js';
import { describePending } from './pending.js';
import { composeWaysAt } from './ways.js';
import { agentActionFor } from '../test-support/ways-view.js';
import { ExtensionRegistry } from '../extensions/registry.js';
import type { WorkflowDefinition, StepDefinition } from '../types/workflow-definition.js';
import type { RunRecord } from '../types/run-record.js';

const echo: StepDispatcher = async (_name, input) => ({ ...input });

async function withStore<T>(fn: (store: JsonFileStore) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'realm-688-'));
  try {
    return await fn(new JsonFileStore(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A raw definition — never through the loader, as a stored or embedded one can be. */
function def(steps: Record<string, unknown>): WorkflowDefinition {
  return {
    id: 'map-688',
    name: 'map-688',
    version: 1,
    steps: steps as Record<string, StepDefinition>,
  } as WorkflowDefinition;
}

/** A registry whose handler `h` records the input it receives. */
function recording(): { registry: ExtensionRegistry; seen: unknown[] } {
  const seen: unknown[] = [];
  const registry = new ExtensionRegistry();
  registry.register('handler', 'h', {
    id: 'h',
    execute: async (input: { params: Record<string, unknown> }) => {
      seen.push(input.params);
      return { data: { got: input.params } };
    },
  } as never);
  return { registry, seen };
}

const SHAPE_A = def({
  x: {
    description: 'X.',
    execution: 'auto',
    handler: 'h',
    input_map: { n: 'run.params.num' },
    input_schema: { type: 'object', required: ['n'], properties: { n: { type: 'number' } } },
  },
});

const SHAPE_B = def({
  summarize: { description: 'Sum.', execution: 'agent' },
  publish: {
    description: 'Pub.',
    execution: 'auto',
    handler: 'h',
    depends_on: ['summarize'],
    input_map: { text: 'context.resources.summarize.summary' },
    input_schema: { type: 'object', required: ['text'] },
  },
});

/**
 * The way out of a run whose refused step is `step`, as data: the refusal's check, its remedies' verbs,
 * and whether a new run with other params can change what the schema checks (`no_remedy` `start`).
 */
function wayOut(run: RunRecord, d: WorkflowDefinition, registry: ExtensionRegistry, step: string) {
  const entry = composeWaysAt(run, new Date(), { definition: d, registry }).unavailable.find(
    (u) => u.verb === 'run_step' && u.step === step,
  );
  return {
    code: entry?.code,
    check: entry?.code === 'refused_before_claim' ? entry.facts.check : undefined,
    remedy: entry?.remedy.map((w) => w.verb),
    new_run:
      entry?.no_remedy?.cause === 'operator_command_untyped' && entry.no_remedy.command === 'start',
  };
}
const PARAMS_FIX = {
  code: 'refused_before_claim',
  check: 'input_schema',
  remedy: ['register'],
  new_run: true,
};
const MAP_FIX = {
  code: 'refused_before_claim',
  check: 'input_schema',
  remedy: ['register'],
  new_run: false,
};
/** A step that consumes no map: the engine gives it no input — the operator's lever beside the fix (Q4). */
const NO_INPUT_FIX = {
  code: 'refused_before_claim',
  check: 'input_schema',
  remedy: ['register', 'run_step'],
  new_run: false,
};

/** Creates a run of `d`, answers its agent step `answerStep` (when given), returns the fresh record. */
async function begin(
  store: JsonFileStore,
  d: WorkflowDefinition,
  params: Record<string, unknown>,
  registry: ExtensionRegistry,
  answer?: { step: string; output: Record<string, unknown> },
): Promise<RunRecord> {
  const { run } = await store.create({ workflowId: d.id, workflowVersion: 1, params });
  if (answer !== undefined) {
    await executeStep(store, d, {
      runId: run.id,
      command: answer.step,
      input: answer.output,
      dispatcher: echo,
      registry,
    });
  }
  return store.get(run.id);
}

describe('#688 — the issue’s two shapes run, and the view agrees', () => {
  it('cell 1 (a): a handler step mapping run.params runs, and its handler receives what the map builds', async () => {
    await withStore(async (store) => {
      const { registry, seen } = recording();
      const run = await begin(store, SHAPE_A, { num: 3 }, registry);
      const reply = await advanceRun(store, SHAPE_A, { runId: run.id, registry });
      const after = await store.get(run.id);
      // (a) red when the schema checks the engine's input (the params `{num: 3}`, which lack `n`): the
      //     step is refused and the handler never called; (b) prints the hint, the steps, the input.
      expect({
        hint: reply.context_hint,
        completed: after.completed_steps,
        failed: after.failed_steps,
        received: seen,
      }).toMatchObject({ completed: ['x'], failed: [], received: [{ n: 3 }] });
    });
  });

  it('cell 1 (b): an agent step, then a handler step mapping its output, runs the handler on that output', async () => {
    await withStore(async (store) => {
      const { registry, seen } = recording();
      const run = await begin(store, SHAPE_B, {}, registry, {
        step: 'summarize',
        output: { summary: 'hello' },
      });
      const reply = await advanceRun(store, SHAPE_B, { runId: run.id, registry });
      const after = await store.get(run.id);
      // (a) red when the schema checks the engine's input (`{}` for a step with depends_on): refused,
      //     the handler never called; (b) prints the hint, the steps and the handler's input.
      expect({
        hint: reply.context_hint,
        completed: after.completed_steps,
        failed: after.failed_steps,
        received: seen,
      }).toMatchObject({
        completed: ['summarize', 'publish'],
        failed: [],
        received: [{ text: 'hello' }],
      });
    });
  });

  it('cell 2: before it runs, the view lists the mapped step as runnable', async () => {
    await withStore(async (store) => {
      const { registry } = recording();
      const run = await begin(store, SHAPE_B, {}, registry, {
        step: 'summarize',
        output: { summary: 'hello' },
      });
      const entry = describePending(SHAPE_B, run, registry, new Date()).engine_runnable.find(
        (e) => e.step === 'publish',
      );
      // (a) red when the view checks the engine's input: `runnable_here: false`, refused
      //     `input_schema`; (b) prints the view's entry.
      expect(entry).toEqual({ step: 'publish', runnable_here: true });
    });
  });
});

describe('#688 — a mapped input that does not fit: refused, report_to_user, the fix that can work', () => {
  it('cell 4 (b): an answer without `summary` — refused for `text`; the engine says report_to_user; the way out names the map or the schema', async () => {
    await withStore(async (store) => {
      const { registry, seen } = recording();
      const run = await begin(store, SHAPE_B, {}, registry, {
        step: 'summarize',
        output: { other: 'x' },
      });
      const view = describePending(SHAPE_B, run, registry, new Date());
      const entry = view.engine_runnable.find((e) => e.step === 'publish');
      const reply = await executeStep(store, SHAPE_B, {
        runId: run.id,
        command: 'publish',
        input: { text: 'typed' },
        dispatcher: echo,
        registry,
      });
      // (a) red when the schema checks the caller's input (`{text: 'typed'}` fits, so the step runs
      //     on the mapped `{}`), when the refusal says `provide_input`, or when the way out offers a
      //     new run or names only the schema; (b) prints the entry, the reply's code, action and the
      //     handler's input, and the way out.
      expect({
        refused_by: entry?.refused_by,
        namesText: String(entry?.refusal).includes("'text'"),
        code: reply.error_code,
        action: agentActionFor(reply),
        received: seen,
        way: wayOut(run, SHAPE_B, registry, 'publish'),
      }).toEqual({
        refused_by: 'input_schema',
        namesText: true,
        code: 'VALIDATION_INPUT_SCHEMA',
        action: 'report_to_user',
        received: [],
        way: MAP_FIX,
      });
    });
  });

  it('cell 4 (a): params without `num` — the map reads run.params, so a new run with params that fit is offered first', async () => {
    await withStore(async (store) => {
      const { registry } = recording();
      const run = await begin(store, SHAPE_A, { other: 1 }, registry);
      // (a) red when the refused step is offered the input_schema-only fix, or no new run; (b) prints
      //     the way out.
      expect(wayOut(run, SHAPE_A, registry, 'x')).toEqual(PARAMS_FIX);
    });
  });
});

describe('#688 cell 5 — when a new run can change what the schema checks (through the way out)', () => {
  const PARAMS_WAY = PARAMS_FIX;
  const MAP_WAY = MAP_FIX;
  async function wayFor(
    step: Record<string, unknown>,
    params: Record<string, unknown>,
    extra: Record<string, unknown> = {},
    answer?: { step: string; output: Record<string, unknown> },
  ): Promise<ReturnType<typeof wayOut>> {
    return withStore(async (store) => {
      const { registry } = recording();
      const d = def({
        ...extra,
        x: { description: 'X.', execution: 'auto', handler: 'h', ...step },
      });
      const run = await begin(store, d, params, registry, answer);
      return wayOut(run, d, registry, 'x');
    });
  }

  it('a path-looking $literal builds no params: no new run', async () => {
    // (a) red when the walk reads a sole-key `$literal`'s value as a path (break: drop the $literal
    //     rule); (b) prints the way out.
    expect(
      await wayFor(
        {
          input_map: { sku: { $literal: 'run.params.sku' } },
          input_schema: { type: 'object', properties: { sku: { type: 'number' } } },
        },
        { sku: 5 },
      ),
    ).toEqual(MAP_WAY);
  });

  it('a leaf that is exactly run.params reads the params: a new run is offered', async () => {
    // (a) red when only `run.params.` with its dot counts (break: require the trailing dot);
    //     (b) prints the way out.
    expect(
      await wayFor(
        {
          input_map: { all: 'run.params' },
          input_schema: {
            type: 'object',
            properties: { all: { type: 'object', required: ['k'] } },
          },
        },
        { other: 1 },
      ),
    ).toEqual(PARAMS_WAY);
  });

  it('a leaf with a leading space reads the params: a new run is offered', async () => {
    // (a) red when the leaf is not trimmed (break: drop the trim); (b) prints the way out.
    expect(
      await wayFor(
        {
          input_map: { n: ' run.params.num' },
          input_schema: { type: 'object', required: ['n'] },
        },
        { other: 1 },
      ),
    ).toEqual(PARAMS_WAY);
  });

  it('a mixed map whose refused key comes from context.resources: no new run', async () => {
    // (a) red when the rule looks at the whole map, which also reads run.params (break: key on the
    //     whole map); (b) prints the way out.
    expect(
      await wayFor(
        {
          depends_on: ['ask'],
          input_map: { a: 'run.params.a', b: 'context.resources.ask.b' },
          input_schema: { type: 'object', required: ['a', 'b'] },
        },
        { a: 1 },
        { ask: { description: 'Ask.', execution: 'agent' } },
        { step: 'ask', output: { other: 'x' } },
      ),
    ).toEqual(MAP_WAY);
  });

  it('a root additionalProperties refusal names no key: no new run', async () => {
    // (a) red when a root error of another keyword falls back to the whole map, which reads
    //     run.params (break: fall back to the whole map); (b) prints the way out.
    expect(
      await wayFor(
        {
          depends_on: ['ask'],
          input_map: { text: 'context.resources.ask.summary', extra: 'run.params.x' },
          input_schema: {
            type: 'object',
            properties: { text: { type: 'string' } },
            additionalProperties: false,
          },
        },
        {},
        { ask: { description: 'Ask.', execution: 'agent' } },
        { step: 'ask', output: { summary: 'hello' } },
      ),
    ).toEqual(MAP_WAY);
  });

  it('a key with `/` is found by its unescaped name: a new run is offered', async () => {
    // (a) red when the error path's `~1` is not unescaped, so the key is not found (break: drop the
    //     unescape); (b) prints the way out.
    expect(
      await wayFor(
        {
          input_map: { 'a/b': 'run.params.v' },
          input_schema: { type: 'object', properties: { 'a/b': { type: 'number' } } },
        },
        { v: 'not a number' },
      ),
    ).toEqual(PARAMS_WAY);
  });
});

describe('#688 cell 6 — a corrupted stored map whose schema refuses the engine’s input', () => {
  for (const [label, map, code] of [
    ['an unknown directive', { text: { $template: 'x' } }, 'INPUT_MAP_UNKNOWN_DIRECTIVE'],
    [
      'a map deeper than its limit',
      { text: [...Array(12).keys()].reduce<unknown>((inner) => ({ k: inner }), 'run.params.t') },
      'INPUT_MAP_DEPTH_EXCEEDED',
    ],
  ] as const) {
    it(`${label}: the view gives it runnable; the dispatch fails the step with ${code}`, async () => {
      await withStore(async (store) => {
        const { registry, seen } = recording();
        const d = def({
          first: { description: 'First.', execution: 'agent' },
          publish: {
            description: 'Pub.',
            execution: 'auto',
            handler: 'h',
            depends_on: ['first'],
            input_map: map,
            input_schema: { type: 'object', required: ['text'] },
          },
        });
        const run = await begin(store, d, { t: 'x' }, registry, { step: 'first', output: {} });
        const entry = describePending(d, run, registry, new Date()).engine_runnable.find(
          (e) => e.step === 'publish',
        );
        const reply = await executeStep(store, d, {
          runId: run.id,
          command: 'publish',
          input: {},
          dispatcher: echo,
          registry,
        });
        const after = await store.get(run.id);
        // (a) red when the check resolves the map inside its own catch, or checks the engine's
        //     input `{}` (before #688: refused before its claim, `input_schema`); (b) prints the
        //     view's entry, the reply's code, the failed steps and the handler's input.
        expect({
          entry,
          code: reply.error_code,
          failed: after.failed_steps,
          received: seen,
        }).toEqual({
          entry: { step: 'publish', runnable_here: true },
          code,
          failed: ['publish'],
          received: [],
        });
      });
    });
  }
});

describe('#688 cell 7 — each conjunct of the one rule', () => {
  it('the kind: an agent step carrying a raw input_map and a handler still has its ANSWER checked', async () => {
    await withStore(async (store) => {
      const { registry } = recording();
      const d = def({
        ask: {
          description: 'Ask.',
          execution: 'agent',
          handler: 'h',
          input_map: { text: 'run.params.t' },
          input_schema: { type: 'object', required: ['text'] },
        },
      });
      const run = await begin(store, d, { t: 'x' }, registry);
      const reply = await executeStep(store, d, {
        runId: run.id,
        command: 'ask',
        input: {},
        dispatcher: echo,
        registry,
      });
      const after = await store.get(run.id);
      // (a) red when an agent step counts as consuming its map (break: drop the kind conjunct): the
      //     map builds `text`, so the empty answer passes; (b) prints the reply's code and the steps.
      expect({ code: reply.error_code, completed: after.completed_steps }).toEqual({
        code: 'VALIDATION_INPUT_SCHEMA',
        completed: [],
      });
    });
  });

  it('not bare: a bare mapped auto step is still checked against the engine’s input, with the no-input way out', async () => {
    await withStore(async (store) => {
      const { registry } = recording();
      const d = def({
        order: { description: 'Order.', execution: 'agent' },
        show: {
          description: 'Show.',
          execution: 'auto',
          depends_on: ['order'],
          input_map: { sku: 'run.params.sku' },
          input_schema: { type: 'object', required: ['sku'] },
        },
      });
      const run = await begin(store, d, { sku: 'A-100' }, registry, {
        step: 'order',
        output: {},
      });
      const view = describePending(d, run, registry, new Date());
      // (a) red when a bare step counts as consuming its map (break: drop the handler/service
      //     conjunct): the map builds `sku`, so the step is runnable; (b) prints the entry's check
      //     and the way out.
      expect({
        refused_by: view.engine_runnable.find((e) => e.step === 'show')?.refused_by,
        way: wayOut(run, d, registry, 'show'),
      }).toEqual({
        refused_by: 'input_schema',
        way: NO_INPUT_FIX,
      });
    });
  });

  it('the map present: a handler step with no input_map keeps the no-input way out', async () => {
    await withStore(async (store) => {
      const { registry } = recording();
      const d = def({
        ask: { description: 'Ask.', execution: 'agent' },
        compute: {
          description: 'Compute.',
          execution: 'auto',
          handler: 'h',
          depends_on: ['ask'],
          input_schema: { type: 'object', required: ['n'] },
        },
      });
      const run = await begin(store, d, {}, registry, { step: 'ask', output: {} });
      // (a) red when a step with no map counts as consuming one (break: drop the map conjunct): its
      //     way out names an input_map it does not have; (b) prints the way out.
      expect(wayOut(run, d, registry, 'compute')).toEqual(NO_INPUT_FIX);
    });
  });
});
