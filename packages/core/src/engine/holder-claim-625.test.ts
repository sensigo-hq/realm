// holder-claim-625.test.ts — issue #625 (the holder slice, PR-H): the NAME half. Who took a step is
// written on its claim, in the claim's own write, and kept on the evidence of the work it did.
//
// Through the REAL engine and a REAL JsonFileStore: no mocked chain. Each assertion carries (a) the
// change that turns it red and (b) what it prints on failure — synthetic names only.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileStore } from '../store/json-file-store.js';
import { declareReleaseLine } from '../release-line.js';
import {
  advanceRun,
  drainFinalizers,
  executeChain,
  executeStep,
  submitHumanResponse,
  DEFAULT_VALIDATION_EXHAUSTION_THRESHOLD,
} from './execution-loop.js';
import type { StepDispatcher } from './execution-loop.js';
import { ExtensionRegistry } from '../extensions/registry.js';
import type { StepHandler } from '../extensions/step-handler.js';
import type { Attributed } from './holder.js';
import type { RunStore, CreateRunOptions } from '../store/store-interface.js';
import type { RunRecord } from '../types/run-record.js';
import type { StepDefinition, WorkflowDefinition } from '../types/workflow-definition.js';

const echo: StepDispatcher = async (_step, input) => ({ ...input });

const DRIVER: Attributed = { by: 'alice@host', by_source: 'derived', channel: 'agent' };
const OTHER: Attributed = { by: 'REALM-OP', by_source: 'ambient', channel: 'drain' };
const DROPPED = 'this run store did not record who took the step';

let dir: string;
let store: JsonFileStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'realm-holder-claim-625-'));
  store = new JsonFileStore(dir);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function oneAgentStep(extra: Partial<StepDefinition> = {}): WorkflowDefinition {
  return {
    id: 'holder-claim-wf',
    name: 'holder claim',
    version: 1,
    steps: { work: { description: 'Work', execution: 'agent', depends_on: [], ...extra } },
  };
}

async function newRun(def: WorkflowDefinition): Promise<string> {
  return (await store.create({ workflowId: def.id, workflowVersion: 1, params: {} })).run.id;
}

/** Runs `work` and hands back the record AS IT STOOD while the step was in progress (claim written,
 *  nothing settled) — the dispatcher runs between the claim and the settle. */
async function claimWhileInProgress(
  def: WorkflowDefinition,
  driver: Attributed | undefined,
  s: RunStore = store,
): Promise<{ claim: RunRecord['claims']; reply: Awaited<ReturnType<typeof executeStep>> }> {
  const runId = (await s.create({ workflowId: def.id, workflowVersion: 1, params: {} })).run.id;
  let claims: RunRecord['claims'];
  const reply = await executeStep(s, def, {
    runId,
    command: 'work',
    input: {},
    dispatcher: async () => {
      claims = (await s.get(runId)).claims;
      return {};
    },
    ...(driver !== undefined ? { driver } : {}),
  });
  return { claim: claims, reply };
}

describe("the claim names its holder — in the claim's own write", () => {
  it('a step taken with a driver carries holder and since, beside the deadline and token', async () => {
    const before = Date.now();
    const { claim } = await claimWhileInProgress(oneAgentStep(), DRIVER);
    const after = Date.now();
    const c = claim?.['work'];
    // (a) red when executeStep stops passing options.driver to claimStep; (b) prints the claim.
    expect(c?.holder).toEqual(DRIVER);
    // (a) red when the store forgets to stamp `since`; (b) prints the value.
    expect(typeof c?.since).toBe('string');
    const sinceMs = Date.parse(c!.since!);
    // (a) red when `since` is stamped from anything but the store's own clock at the claim write.
    expect(sinceMs).toBeGreaterThanOrEqual(before);
    expect(sinceMs).toBeLessThanOrEqual(after);
    expect(typeof c?.token).toBe('string');
  });

  it('a step taken WITHOUT a driver still carries since — and no holder key at all', async () => {
    const { claim } = await claimWhileInProgress(oneAgentStep(), undefined);
    const c = claim?.['work'];
    // (a) red when `since` is stamped only when a claimant is passed (mutant g's twin).
    expect(typeof c?.since).toBe('string');
    expect(c !== undefined && 'holder' in c).toBe(false);
  });
});

describe('driven_by — the program whose code did the work, on the entries where code ran', () => {
  it("the attempt's own entry (a step completing) carries the driver", async () => {
    const def = oneAgentStep();
    const runId = await newRun(def);
    await executeStep(store, def, {
      runId,
      command: 'work',
      input: {},
      dispatcher: echo,
      driver: DRIVER,
    });
    const run = await store.get(runId);
    // (a) red when the entry stops passing drivenBy; (b) prints the entry's driven_by.
    expect(run.evidence.filter((e) => e.step_id === 'work').map((e) => e.driven_by)).toEqual([
      DRIVER,
    ]);
  });

  it('with no driver the entry carries no driven_by key — never a placeholder', async () => {
    const def = oneAgentStep();
    const runId = await newRun(def);
    await executeStep(store, def, { runId, command: 'work', input: {}, dispatcher: echo });
    const run = await store.get(runId);
    expect('driven_by' in run.evidence[0]!).toBe(false);
  });

  it("a handler abort's entry carries the driver", async () => {
    const registry = new ExtensionRegistry();
    const abortHandler: StepHandler = {
      id: 'h_abort',
      execute: async () => ({ abort: { message: 'stop here' } }),
    };
    registry.register('handler', 'h_abort', abortHandler);
    const def: WorkflowDefinition = {
      id: 'holder-abort-wf',
      name: 'abort',
      version: 1,
      steps: {
        work: { description: 'Work', execution: 'auto', depends_on: [], handler: 'h_abort' },
      },
    };
    const runId = await newRun(def);
    await executeStep(store, def, {
      runId,
      command: 'work',
      input: {},
      dispatcher: echo,
      registry,
      driver: DRIVER,
    });
    const run = await store.get(runId);
    // (a) red when the abort entry (execution-loop's abortEvidence) drops drivenBy.
    expect(run.evidence.filter((e) => e.step_id === 'work').map((e) => e.driven_by)).toEqual([
      DRIVER,
    ]);
  });

  it("a validation-exhaustion DEFAULT settle's entry and an EXHAUSTION failure's entry carry the driver", async () => {
    const schema = {
      type: 'object',
      required: ['category'],
      properties: { category: { type: 'string' } },
    };
    for (const mode of ['default', 'fail'] as const) {
      const sub = new JsonFileStore(await mkdtemp(join(tmpdir(), 'realm-holder-vx-')));
      const def = oneAgentStep({
        output_schema: schema,
        ...(mode === 'default'
          ? {
              validation_exhaustion: {
                mode: 'default' as const,
                default_output: { category: 'x' },
              },
            }
          : {}),
      });
      const { run } = await sub.create({ workflowId: def.id, workflowVersion: 1, params: {} });
      await sub.update({
        ...run,
        validation_rejections: { work: DEFAULT_VALIDATION_EXHAUSTION_THRESHOLD - 1 },
      });
      await executeStep(sub, def, {
        runId: run.id,
        command: 'work',
        input: {},
        dispatcher: echo,
        driver: DRIVER,
      });
      const done = await sub.get(run.id);
      // (a) red when defaultSnap / exhaustedSnap drop drivenBy; (b) prints the mode and the values.
      expect([
        mode,
        done.evidence.filter((e) => e.step_id === 'work').map((e) => e.driven_by),
      ]).toEqual([mode, [DRIVER]]);
    }
  });
});

describe('cleanup steps — the program whose code and credentials run them is named', () => {
  function finalizerWorkflow(): WorkflowDefinition {
    return {
      id: 'holder-final-wf',
      name: 'final',
      version: 1,
      steps: {
        work: { description: 'Work', execution: 'auto', depends_on: [], handler: 'h_work' },
        fin: {
          description: 'Cleanup',
          execution: 'finalizer',
          on_outcome: 'always',
          handler: 'h_ok',
        },
      },
    };
  }

  function registryOf(kind: 'ok' | 'abort' | 'throw' | 'none'): ExtensionRegistry {
    const registry = new ExtensionRegistry();
    registry.register('handler', 'h_work', { id: 'h_work', execute: async () => ({ data: {} }) });
    const handlers: Record<string, StepHandler> = {
      ok: { id: 'h_ok', execute: async () => ({ data: { ran: true } }) },
      abort: { id: 'h_ok', execute: async () => ({ abort: { message: 'cleanup stopped' } }) },
      throw: {
        id: 'h_ok',
        execute: async () => {
          throw new Error('cleanup exploded');
        },
      },
    };
    if (kind !== 'none') registry.register('handler', 'h_ok', handlers[kind]!);
    return registry;
  }

  it.each(['ok', 'abort', 'throw'] as const)(
    'the seal path (buildFinalizedSeal, %s): the cleanup entry carries the driver of the call that sealed the run',
    async (kind) => {
      const def = finalizerWorkflow();
      const runId = await newRun(def);
      await executeChain(store, def, {
        runId,
        command: 'work',
        input: {},
        dispatcher: echo,
        registry: registryOf(kind),
        driver: DRIVER,
      });
      const run = await store.get(runId);
      // (a) red when ANY of buildFinalizedSeal's three entry kinds drops drivenBy, or a call line
      //     (one of the six) stops passing the driver; (b) prints the kind and the entries' names.
      expect([
        kind,
        run.evidence.filter((e) => e.step_id === 'fin').map((e) => e.driven_by),
      ]).toEqual([kind, [DRIVER]]);
      // The step's OWN entry carries it too.
      expect(run.evidence.find((e) => e.step_id === 'work')?.driven_by).toEqual(DRIVER);
    },
  );

  it.each(['ok', 'abort', 'throw'] as const)(
    'drainFinalizers (%s): the three entry kinds a drain writes carry the driver it was given',
    async (kind) => {
      const def = finalizerWorkflow();
      const runId = await newRun(def);
      // Seal with NO handler available for the cleanup step (the pass halts, the entry stays
      // pending), then drain with a registry that has it — the drain is what runs the code.
      await executeChain(store, def, {
        runId,
        command: 'work',
        input: {},
        dispatcher: echo,
        registry: registryOf('none'),
      });
      const sealed = await store.get(runId);
      expect(sealed.finalizer_ledger?.['fin']?.status).toBe('pending');
      await drainFinalizers(store, def, registryOf(kind), runId, OTHER);
      const run = await store.get(runId);
      // (a) red when the drain drops the driver at ANY of its three entries (success, abort,
      //     throw), or the parameter is not threaded; (b) prints the kind and the values.
      expect([
        kind,
        run.evidence.filter((e) => e.step_id === 'fin').map((e) => e.driven_by),
      ]).toEqual([kind, [OTHER]]);
    },
  );

  it('a drain given no driver writes no driven_by on the cleanup entry', async () => {
    const def = finalizerWorkflow();
    const runId = await newRun(def);
    await executeChain(store, def, {
      runId,
      command: 'work',
      input: {},
      dispatcher: echo,
      registry: registryOf('none'),
    });
    await drainFinalizers(store, def, registryOf('ok'), runId);
    const run = await store.get(runId);
    expect('driven_by' in run.evidence.find((e) => e.step_id === 'fin')!).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// The dropped-claimant warning
// ---------------------------------------------------------------------------------------------

/** A store whose claimStep forwards THREE arguments only — the claimant is dropped on the floor. */
class ThreeArgForwarderStore implements RunStore {
  // issue #620 PR-C: a test double declares this realm's release line.
  static {
    declareReleaseLine(this);
  }
  readonly persistedRunRecordFields: JsonFileStore['persistedRunRecordFields'];
  constructor(
    private readonly inner: JsonFileStore,
    readonly persistsClaims: boolean,
  ) {
    this.persistedRunRecordFields = inner.persistedRunRecordFields;
  }
  create(options: CreateRunOptions) {
    return this.inner.create(options);
  }
  get(runId: string) {
    return this.inner.get(runId);
  }
  update(record: RunRecord) {
    return this.inner.update(record);
  }
  list(workflowId?: string) {
    return this.inner.list(workflowId);
  }
  claimStep(runId: string, stepName: string, definition: WorkflowDefinition) {
    return this.inner.claimStep(runId, stepName, definition);
  }
  settleStep: JsonFileStore['settleStep'] = (...args) => this.inner.settleStep(...args);
}

describe('the dropped-claimant warning — advisory only', () => {
  it('a driver was passed, the store keeps claims, the claim has no holder ⇒ ONE line on the reply; the step still runs', async () => {
    const { reply } = await claimWhileInProgress(
      oneAgentStep(),
      DRIVER,
      new ThreeArgForwarderStore(store, true),
    );
    // (a) red when the warning is dropped; (b) prints the warnings.
    expect(reply.warnings.filter((w) => w === DROPPED)).toHaveLength(1);
    expect(reply.status).toBe('ok');
  });

  it('CONTROL (mutant m): a store that keeps no claims says nothing — it cannot have recorded one', async () => {
    const { reply } = await claimWhileInProgress(
      oneAgentStep(),
      DRIVER,
      new ThreeArgForwarderStore(store, false),
    );
    // (a) red when the persistsClaims === true conjunct is removed; (b) prints the warnings.
    expect(reply.warnings).not.toContain(DROPPED);
  });

  it('CONTROL: no driver passed ⇒ no warning, whatever the store does', async () => {
    const { reply } = await claimWhileInProgress(
      oneAgentStep(),
      undefined,
      new ThreeArgForwarderStore(store, true),
    );
    expect(reply.warnings).not.toContain(DROPPED);
  });

  it('CONTROL: a store that records the holder ⇒ no warning', async () => {
    const { reply } = await claimWhileInProgress(oneAgentStep(), DRIVER);
    expect(reply.warnings).not.toContain(DROPPED);
  });
});

// ---------------------------------------------------------------------------------------------
// The validator at the five exported entries
// ---------------------------------------------------------------------------------------------

describe('VALIDATION_ACTOR_INVALID — a malformed driver is refused at every exported entry, before anything is read', () => {
  const BAD = { by: 'a\nb', by_source: 'derived', channel: 'agent' } as unknown as Attributed;

  /** A store that records every call — and answers none of them. */
  function untouchedStore(): { s: RunStore; calls: string[] } {
    const calls: string[] = [];
    const trap = (name: string) => () => {
      calls.push(name);
      throw new Error(`the store was read: ${name}`);
    };
    const s = {
      persistsClaims: true,
      create: trap('create'),
      get: trap('get'),
      update: trap('update'),
      list: trap('list'),
      claimStep: trap('claimStep'),
      settleStep: trap('settleStep'),
    } as unknown as RunStore;
    // issue #620 PR-C: declared, so the host-wiring check passes and the driver is what is refused.
    declareReleaseLine(s);
    return { s, calls };
  }

  const def = oneAgentStep();

  it.each([
    [
      'executeStep',
      (s: RunStore) =>
        executeStep(s, def, {
          runId: 'r',
          command: 'work',
          input: {},
          dispatcher: echo,
          driver: BAD,
        }),
    ],
    [
      'executeChain',
      (s: RunStore) =>
        executeChain(s, def, {
          runId: 'r',
          command: 'work',
          input: {},
          dispatcher: echo,
          driver: BAD,
        }),
    ],
    [
      'advanceRun',
      (s: RunStore) =>
        advanceRun(s, def, {
          runId: 'r',
          command: 'work',
          input: {},
          dispatcher: echo,
          driver: BAD,
        }),
    ],
    [
      'submitHumanResponse',
      (s: RunStore) =>
        submitHumanResponse(s, def, { runId: 'r', gateId: 'g', choice: 'approve', driver: BAD }),
    ],
  ])(
    '%s returns the error envelope with the code and the field — and the store is never touched',
    async (_n, call) => {
      const { s, calls } = untouchedStore();
      const reply = await call(s);
      // (a) red when the validator moves below the first store read, or is dropped; (b) prints the
      //     envelope's code/status and the store calls made.
      expect(reply.status).toBe('error');
      expect(reply.error_code).toBe('VALIDATION_ACTOR_INVALID');
      expect(reply.errors).toEqual(['Invalid driver.by: contains a control character.']);
      expect(reply.agent_action).toBe('report_to_user');
      expect(calls).toEqual([]);
    },
  );

  it('drainFinalizers (which returns no envelope) THROWS the same code — mutant (n) — and reads nothing', async () => {
    const { s, calls } = untouchedStore();
    // (a) red when drainFinalizers skips the validator; (b) prints what (if anything) was thrown.
    await expect(drainFinalizers(s, def, undefined, 'r', BAD)).rejects.toMatchObject({
      code: 'VALIDATION_ACTOR_INVALID',
      message: 'Invalid driver.by: contains a control character.',
    });
    expect(calls).toEqual([]);
  });
});
