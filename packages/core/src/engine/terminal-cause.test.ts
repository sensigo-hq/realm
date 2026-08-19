// terminal-cause.test.ts — issue #373: the run's one-line cause states ALL failures and names no
// culprit.
//
// THE DEFECT: `failed_steps` is append-ordered by settlement commit, and the fail seal named
// `failed_steps.at(-1)` by construction. So a run with several independent failures blamed
// whichever one happened to settle LAST — and under true concurrency the lock race picked the
// culprit. Executed both orders on the same workflow: the named step swapped.
//
// Nothing pinned ANY of this before now. The measurement is on record: maximal mutants at all six
// mint sites left the whole 3791-test suite green. So every cell here is new ground, and each was
// written VERIFY-FIRST — run against the real engine, then pinned to what it actually does.
import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeStep, executeChain } from './execution-loop.js';
import { renderFailCause } from './settlement.js';
import { applyResume } from './apply-resume.js';
import { captureEvidence } from '../evidence/snapshot.js';
import { JsonFileStore } from '../store/json-file-store.js';
import { ExtensionRegistry } from '../extensions/registry.js';
import type { RunStore, CreateRunOptions } from '../store/store-interface.js';
import type { RunRecord } from '../types/run-record.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
import type { StepHandler } from '../extensions/step-handler.js';

/**
 * Delegates every `RunStore` method to a real `JsonFileStore` EXCEPT `settleStep`, which is never
 * implemented at all — so `store.settleStep === undefined` holds by construction and the legacy
 * `buildFinalizedSeal` / in-loop seal is the only reachable path. Precedent:
 * `finalizer-matrix-302.test.ts`, narrowed to this file's one concern.
 */
class NonDeclaringStoreDouble implements RunStore {
  readonly persistsClaims: boolean;
  constructor(private readonly inner: JsonFileStore) {
    this.persistsClaims = inner.persistsClaims;
  }
  create(options: CreateRunOptions): Promise<{ run: RunRecord; created: boolean }> {
    return this.inner.create(options);
  }
  get(runId: string): Promise<RunRecord> {
    return this.inner.get(runId);
  }
  update(record: RunRecord): Promise<RunRecord> {
    return this.inner.update(record);
  }
  list(workflowId?: string): Promise<RunRecord[]> {
    return this.inner.list(workflowId);
  }
  claimStep(runId: string, stepName: string, definition: WorkflowDefinition): Promise<RunRecord> {
    return this.inner.claimStep(runId, stepName, definition);
  }
  // settleStep intentionally OMITTED.
}

const explode = (message: string) => async (): Promise<Record<string, unknown>> => {
  throw new Error(message);
};
const succeed = async (): Promise<Record<string, unknown>> => ({});

async function freshStore(): Promise<JsonFileStore> {
  return new JsonFileStore(await mkdtemp(join(tmpdir(), 'realm-terminal-cause-')));
}

/** A finalizer registry whose single handler either throws or succeeds. */
function finalizerRegistry(throws: boolean): ExtensionRegistry {
  const handler: StepHandler = {
    id: 'fin-handler',
    execute: async () => {
      if (throws) throw new Error('finalizer boom');
      return { data: {} };
    },
  };
  const registry = new ExtensionRegistry();
  registry.register('handler', 'fin-handler', handler);
  return registry;
}

/** Two independent agent steps; add a finalizer with `fin`. */
function fanoutDef(fin?: { on_outcome: string }): WorkflowDefinition {
  return {
    id: 'terminal-cause-wf',
    name: 'Terminal Cause',
    version: 1,
    steps: {
      fail_a: { description: 'A', execution: 'agent', depends_on: [] },
      fail_b: { description: 'B', execution: 'agent', depends_on: [] },
      ...(fin !== undefined
        ? {
            fin: {
              description: 'Finalizer',
              execution: 'finalizer' as const,
              on_outcome: fin.on_outcome as 'fail' | 'always',
              handler: 'fin-handler',
            },
          }
        : {}),
    },
  };
}

/** Drives the named steps in order, failing each one, and returns the persisted record. */
async function driveFailures(
  store: RunStore,
  definition: WorkflowDefinition,
  steps: readonly string[],
  registry?: ExtensionRegistry,
): Promise<RunRecord> {
  const { run } = await store.create({
    workflowId: definition.id,
    workflowVersion: 1,
    params: {},
  });
  for (const step of steps) {
    await executeStep(store, definition, {
      runId: run.id,
      command: step,
      input: {},
      dispatcher: explode(`${step} exploded`),
      ...(registry !== undefined ? { registry } : {}),
    });
  }
  return store.get(run.id);
}

describe('#373 — the multi-failure cause is order-independent', () => {
  it('(1) both settle orders produce the IDENTICAL sentence — this is also the lock-race case', async () => {
    const forward = await driveFailures(await freshStore(), fanoutDef(), ['fail_a', 'fail_b']);
    const reverse = await driveFailures(await freshStore(), fanoutDef(), ['fail_b', 'fail_a']);

    // The instability, witnessed: the RECORDS still differ in order (that is settle order, and it
    // is real) — only the sentence is stable. Without this line the pin could pass vacuously on
    // two identical inputs.
    expect(forward.failed_steps).toEqual(['fail_a', 'fail_b']);
    expect(reverse.failed_steps).toEqual(['fail_b', 'fail_a']);

    expect(forward.terminal_reason).toBe(reverse.terminal_reason);
    expect(forward.terminal_reason).toBe(
      '2 steps failed: fail_a ("Dispatcher failed: fail_a exploded"), ' +
        'fail_b ("Dispatcher failed: fail_b exploded").',
    );
    // No culprit: neither step is singled out as THE cause.
    expect(forward.terminal_reason).not.toContain('The run ended when');
  });

  it('(7) the order rule is LEXICAL, not settle order — z settles first, a is listed first', async () => {
    const definition: WorkflowDefinition = {
      id: 'sort-wf',
      name: 'Sort',
      version: 1,
      steps: {
        a_step: { description: 'A', execution: 'agent', depends_on: [] },
        z_step: { description: 'Z', execution: 'agent', depends_on: [] },
      },
    };
    const record = await driveFailures(await freshStore(), definition, ['z_step', 'a_step']);
    expect(record.failed_steps).toEqual(['z_step', 'a_step']); // settle order
    expect(record.terminal_reason).toContain('failed: a_step ('); // rendered order
    expect(record.terminal_reason!.indexOf('a_step')).toBeLessThan(
      record.terminal_reason!.indexOf('z_step'),
    );
  });
});

describe('#373 — the single-failure shape is untouched (the no-regression control)', () => {
  it('(2a) the fail seal keeps its own template verbatim', async () => {
    const definition: WorkflowDefinition = {
      id: 'single-wf',
      name: 'Single',
      version: 1,
      steps: { only: { description: 'Only', execution: 'agent', depends_on: [] } },
    };
    const record = await driveFailures(await freshStore(), definition, ['only']);
    expect(record.terminal_reason).toBe("Step 'only' failed: Dispatcher failed: only exploded");
  });

  it('(2b) the guard resolution_error seal keeps its own template verbatim', async () => {
    const definition: WorkflowDefinition = {
      id: 'guard-single-wf',
      name: 'Guard Single',
      version: 1,
      steps: {
        ok: { description: 'OK', execution: 'agent', depends_on: [] },
        g: {
          description: 'Guard',
          execution: 'guard',
          depends_on: ['ok'],
          abort_unless: ['$.nope.field == true'],
        },
      },
    };
    const store = await freshStore();
    const { run } = await store.create({
      workflowId: definition.id,
      workflowVersion: 1,
      params: {},
    });
    // Guards run inline in the CHAIN, never via a bare executeStep.
    await executeChain(store, definition, {
      runId: run.id,
      command: 'ok',
      input: {},
      dispatcher: succeed,
    });
    const record = await store.get(run.id);
    expect(record.failed_steps).toEqual(['g']);
    expect(record.terminal_reason).toBe("Guard step 'g' failed: unresolvable path '$.nope.field'");
  });
});

describe('#373 — the sentence agrees with the record after the finalizer drain', () => {
  it('(3) two domain failures + a failing fail-finalizer ⇒ all three named, count === the record', async () => {
    const record = await driveFailures(
      await freshStore(),
      fanoutDef({ on_outcome: 'fail' }),
      ['fail_a', 'fail_b'],
      finalizerRegistry(true),
    );
    // The exact hazard on record (R8 / probeG): the finalizer appends AFTER the seal minted the
    // sentence, so a seal-frozen sentence undercounts. It does not.
    expect(record.failed_steps).toEqual(['fail_a', 'fail_b', 'fin']);
    expect(record.terminal_reason).toBe(
      '3 steps failed: fail_a ("Dispatcher failed: fail_a exploded"), ' +
        'fail_b ("Dispatcher failed: fail_b exploded"), ' +
        `fin ("Finalizer 'fin' failed: Handler 'fin-handler' threw: finalizer boom").`,
    );
    const claimedCount = Number(/^(\d+) steps failed:/.exec(record.terminal_reason!)![1]);
    expect(claimedCount).toBe(new Set(record.failed_steps).size);
  });

  it('(13) a SUCCEEDING finalizer leaves the sentence byte-identical — no-growth means no re-render', async () => {
    // The honesty conjunct of the growth gate. A no-growth re-render would rebuild the sentence
    // without the seal site's in-hand overlay, which is how the guard sites would lose their path
    // text; it must therefore not happen at all.
    const withFinalizer = await driveFailures(
      new NonDeclaringStoreDouble(await freshStore()),
      fanoutDef({ on_outcome: 'fail' }),
      ['fail_a', 'fail_b'],
      finalizerRegistry(false),
    );
    const withoutFinalizer = await driveFailures(
      new NonDeclaringStoreDouble(await freshStore()),
      fanoutDef(),
      ['fail_a', 'fail_b'],
    );
    expect(withFinalizer.completed_steps).toContain('fin'); // the finalizer really ran
    expect(withFinalizer.failed_steps).toEqual(['fail_a', 'fail_b']);
    expect(withFinalizer.terminal_reason).toBe(withoutFinalizer.terminal_reason);
  });
});

describe('#373 — messages', () => {
  it('(4) each failed step carries its own evidence message, verbatim', async () => {
    const record = await driveFailures(await freshStore(), fanoutDef(), ['fail_a', 'fail_b']);
    const errors = record.evidence.filter((e) => e.error !== undefined).map((e) => e.error!);
    expect(errors.length).toBeGreaterThanOrEqual(2);
    for (const error of errors) expect(record.terminal_reason).toContain(error);
  });

  it('(5) a failed step with no message appears BARE — "undefined" is unconstructible', () => {
    // Driven directly: every engine route records an error snapshot, so the missing-message case
    // is reachable only at the function boundary. That is exactly where the honesty rule lives.
    const sentence = renderFailCause(['b', 'a'], new Map([['a', 'msg-a']]));
    expect(sentence).toBe('2 steps failed: a ("msg-a"), b.');
    expect(sentence).not.toContain('undefined');
  });

  it('(11b) a DUPLICATE entry is counted once — pinned at the boundary, because no route reaches it', () => {
    // Probe (iii) earned this cell: dropping the dedup reddened NOTHING through the engine. Cell
    // (11) proves why — the hypothesised cross-epoch duplicate channel does not materialise, since
    // `applyResume` leaves the finalizer scar in place and at-most-once stops it re-running. So the
    // dedup is defensive today and unreachable from any drive; if it is going to be in the render,
    // the rule has to be pinned where it can actually be exercised.
    expect(renderFailCause(['a', 'b', 'a'], new Map())).toBe('2 steps failed: a, b.');
    // Dedup collapsing to ONE is below the call sites' `> 1` gate, but the function is a public
    // export and its output is grammatical at any count.
    expect(renderFailCause(['a', 'a'], new Map([['a', 'msg']]))).toBe('1 step failed: a ("msg").');
  });

  it('(12) an exhaustion message nests "Step \'v\'" inside the entry — verbatim, accepted, pinned', async () => {
    const definition: WorkflowDefinition = {
      id: 'exhaustion-wf',
      name: 'Exhaustion',
      version: 1,
      steps: {
        fail_a: { description: 'A', execution: 'agent', depends_on: [] },
        v: {
          description: 'V',
          execution: 'agent',
          depends_on: [],
          output_schema: { type: 'object', required: ['x'], properties: { x: { type: 'string' } } },
        },
      },
    };
    const store = await freshStore();
    const { run } = await store.create({
      workflowId: definition.id,
      workflowVersion: 1,
      params: {},
    });
    await executeStep(store, definition, {
      runId: run.id,
      command: 'fail_a',
      input: {},
      dispatcher: explode('a exploded'),
    });
    // Burn the validation-rejection budget: each drive submits output missing the required key.
    for (let attempt = 0; attempt < 7; attempt += 1) {
      await executeStep(store, definition, {
        runId: run.id,
        command: 'v',
        input: {},
        dispatcher: succeed,
      });
      if ((await store.get(run.id)).terminal_state) break;
    }
    const record = await store.get(run.id);
    expect(record.terminal_reason).toBe(
      '2 steps failed: fail_a ("Dispatcher failed: a exploded"), ' +
        `v ("Step 'v' exhausted its validation-rejection budget (6/6)").`,
    );
  });

  it('(6) an overflowing sentence is capped at 1024, ends with "...", and still leads with the true count', () => {
    const steps = Array.from({ length: 30 }, (_, i) => `step_${String(i).padStart(2, '0')}`);
    // Genuine overflow: every message is longer than the 256 per-message cap, and 30 of them
    // blow past the sentence cap even after each is trimmed.
    const messages = new Map(steps.map((s) => [s, 'x'.repeat(400)]));
    const sentence = renderFailCause(steps, messages);
    expect(sentence.length).toBe(1024);
    expect(sentence.endsWith('...')).toBe(true);
    expect(sentence.startsWith('30 steps failed: ')).toBe(true);
    // Per-message cap fires independently of the sentence cap.
    const perMessage = renderFailCause(['a', 'b'], new Map([['a', 'y'.repeat(300)]]));
    expect(perMessage).toBe(`2 steps failed: a ("${'y'.repeat(256)}..."), b.`);
  });

  it('(6b) the LONGEST message in the real corpus (254 chars) travels untruncated', () => {
    // The cap is sized from a measurement, so the witness is the measurement's own maximum: a
    // 254-character message was the longest of 31 real evidence errors, and 19% of that corpus was
    // being truncated at the previous unanchored 120.
    const corpusMax = 'z'.repeat(254);
    const sentence = renderFailCause(['a', 'b'], new Map([['a', corpusMax]]));
    expect(sentence).toBe(`2 steps failed: a ("${corpusMax}"), b.`);
    expect(sentence).not.toContain('...');
  });
});

describe('#373 — the guard resolution_error site', () => {
  it('(8) a guard failing AFTER another step names BOTH, and the unresolvable path survives', async () => {
    const definition: WorkflowDefinition = {
      id: 'guard-multi-wf',
      name: 'Guard Multi',
      version: 1,
      steps: {
        fail_a: { description: 'A', execution: 'agent', depends_on: [] },
        ok: { description: 'OK', execution: 'agent', depends_on: [] },
        g: {
          description: 'Guard',
          execution: 'guard',
          depends_on: ['ok'],
          abort_unless: ['$.nope.field == true'],
        },
      },
    };
    const store = await freshStore();
    const { run } = await store.create({
      workflowId: definition.id,
      workflowVersion: 1,
      params: {},
    });
    await executeStep(store, definition, {
      runId: run.id,
      command: 'fail_a',
      input: {},
      dispatcher: explode('a exploded'),
    });
    await executeChain(store, definition, {
      runId: run.id,
      command: 'ok',
      input: {},
      dispatcher: succeed,
    });
    const record = await store.get(run.id);
    expect(record.failed_steps).toEqual(['fail_a', 'g']);
    expect(record.terminal_reason).toBe(
      '2 steps failed: fail_a ("Dispatcher failed: a exploded"), ' +
        `g ("unresolvable path '$.nope.field'").`,
    );
    // The guard's EVIDENCE carries the path too (issue #373 correction). That is what keeps the
    // post-drain re-render — which rebuilds from evidence alone — from downgrading the diagnostic;
    // see the composition cells below.
    const guardEvidence = record.evidence.filter((e) => e.step_id === 'g' && e.error !== undefined);
    expect(guardEvidence.at(-1)!.error).toBe(
      "Guard resolution error on condition: $.nope.field == true — unresolvable path '$.nope.field'",
    );
  });
});

describe('#373 — the two layers agree', () => {
  it('(9) declaring and non-declaring stores emit BYTE-IDENTICAL sentences', async () => {
    const declaring = await driveFailures(await freshStore(), fanoutDef(), ['fail_a', 'fail_b']);
    const legacy = await driveFailures(
      new NonDeclaringStoreDouble(await freshStore()),
      fanoutDef(),
      ['fail_a', 'fail_b'],
    );
    expect(legacy.terminal_reason).toBe(declaring.terminal_reason);

    // And through the post-drain re-render, which is a DIFFERENT site in each layer
    // (applyMarkFinalizer vs buildFinalizedSeal) — the pair most likely to drift.
    const declaringDrained = await driveFailures(
      await freshStore(),
      fanoutDef({ on_outcome: 'fail' }),
      ['fail_a', 'fail_b'],
      finalizerRegistry(true),
    );
    const legacyDrained = await driveFailures(
      new NonDeclaringStoreDouble(await freshStore()),
      fanoutDef({ on_outcome: 'fail' }),
      ['fail_a', 'fail_b'],
      finalizerRegistry(true),
    );
    expect(legacyDrained.terminal_reason).toBe(declaringDrained.terminal_reason);
    expect(legacyDrained.terminal_reason).toContain('3 steps failed:');
  });
});

describe('#373 — a guard-sealed run whose finalizer ALSO fails keeps the path text', () => {
  // THE COMPOSITION NO OTHER CELL COVERS, and the one that exposed a real downgrade: a guard seal
  // puts the unresolvable path in the sentence via the call site's in-hand overlay, and then the
  // post-drain re-render rebuilds from EVIDENCE ALONE. Before the correction the rebuild replaced
  // the path with the generic condition text — the sentence got less useful as the run went on.
  // Fixed at the source (the guard's evidence now carries the path), so both pins below assert
  // LOSSLESSNESS rather than accepting a downgrade.

  const guardDef: WorkflowDefinition = {
    id: 'guard-drain-wf',
    name: 'Guard Drain',
    version: 1,
    steps: {
      fail_a: { description: 'A', execution: 'agent', depends_on: [] },
      g: {
        description: 'Guard',
        execution: 'guard',
        depends_on: [],
        abort_unless: ['$.nope.field == true'],
      },
      fin: {
        description: 'Finalizer',
        execution: 'finalizer',
        on_outcome: 'fail',
        handler: 'fin-handler',
      },
    },
  };

  it('(D1) settlement layer: fail + guard resolution_error + failing finalizer ⇒ the path survives the drain', async () => {
    const store = await freshStore();
    const { run } = await store.create({
      workflowId: guardDef.id,
      workflowVersion: 1,
      params: {},
    });

    // A real claim, so the settle carries a matching token — an unclaimed settle refuses with
    // `claim_lost` and the whole fixture would silently prove nothing.
    const claimed = await store.claimStep(run.id, 'fail_a', guardDef);
    const claimToken = claimed.claims!['fail_a']!.token!;
    const failed = await store.settleStep!(
      run.id,
      {
        kind: 'settle_step',
        step: 'fail_a',
        outcome: 'fail',
        claimToken,
        evidence: [
          captureEvidence({
            stepId: 'fail_a',
            startedAt: new Date(),
            completedAt: new Date(),
            input: {},
            output: {},
            error: 'Dispatcher failed: a exploded',
          }),
        ],
        failureMessage: 'Dispatcher failed: a exploded',
      },
      guardDef,
    );
    if (!failed.applied) throw new Error(`fixture: fail(fail_a) refused — ${failed.reason}`);

    // Mirrors executeGuardStep's own resolution_error snapshot, enriched string included — the
    // production mint of that string is pinned by cell (8) and by the legacy cell below.
    const sealed = await store.settleStep!(
      run.id,
      {
        kind: 'settle_guard',
        step: 'g',
        outcome: 'resolution_error',
        evidence: captureEvidence({
          stepId: 'g',
          startedAt: new Date(),
          completedAt: new Date(),
          input: {},
          output: { error: 'Unresolvable path: $.nope.field' },
          error:
            "Guard resolution error on condition: $.nope.field == true — unresolvable path '$.nope.field'",
        }),
        resolutionError: {
          condition: '$.nope.field == true',
          unresolvable_path: '$.nope.field',
        },
      },
      guardDef,
    );
    if (!sealed.applied) throw new Error(`fixture: guard settle refused — ${sealed.reason}`);
    // SEAL TIME: the path is present, carried by the call site's overlay.
    expect(sealed.run.terminal_reason).toBe(
      '2 steps failed: fail_a ("Dispatcher failed: a exploded"), ' +
        `g ("unresolvable path '$.nope.field'").`,
    );

    // The drain: lease, then mark the finalizer FAILED — the append that grows failed_steps and
    // triggers the re-render.
    const leaseToken = 'lease-d1';
    const leased = await store.settleStep!(
      run.id,
      { kind: 'lease_finalizer', finalizer: 'fin', leaseToken, leaseSeconds: 60 },
      guardDef,
    );
    if (!leased.applied) throw new Error(`fixture: lease refused — ${leased.reason}`);
    const marked = await store.settleStep!(
      run.id,
      {
        kind: 'mark_finalizer',
        finalizer: 'fin',
        leaseToken,
        result: 'failed',
        evidence: captureEvidence({
          stepId: 'fin',
          startedAt: new Date(),
          completedAt: new Date(),
          input: {},
          output: {},
          error: "Finalizer 'fin' failed: finalizer boom",
        }),
      },
      guardDef,
    );
    if (!marked.applied) throw new Error(`fixture: mark refused — ${marked.reason}`);

    const record = await store.get(run.id);
    expect(record.failed_steps).toEqual(['fail_a', 'g', 'fin']);
    expect(record.terminal_reason).toContain('3 steps failed:');
    for (const step of ['fail_a', 'g', 'fin']) expect(record.terminal_reason).toContain(step);
    expect(record.terminal_reason).toContain(`Finalizer 'fin' failed: finalizer boom`);
    // THE LOSSLESS PIN: the diagnostic survives the rebuild. (The condition text may ride along —
    // what must not happen is the path disappearing.)
    expect(record.terminal_reason).toContain("unresolvable path '$.nope.field'");
  });

  it('(D2) legacy layer: the same composition through the real chain ⇒ the path survives the drain', async () => {
    // Byte-parity with (D1) is NOT asserted — the inputs are not identical (this one runs a real
    // handler, that one hand-builds the deltas). What must match is the polarity.
    //
    // The fixture carries an extra SUCCEEDING step, and that is not decoration: `executeChain`
    // reaches its inline guard loop only after a step returns ok, so a chain driven by the failing
    // step alone never runs the guard at all — the first draft of this cell proved exactly that,
    // with `failed_steps` holding `fail_a` and nothing else.
    const chainDef: WorkflowDefinition = {
      ...guardDef,
      id: 'guard-drain-chain-wf',
      steps: {
        ...guardDef.steps,
        ok: { description: 'OK', execution: 'agent', depends_on: [] },
        g: { ...guardDef.steps['g']!, depends_on: ['ok'] },
      },
    };
    const store = new NonDeclaringStoreDouble(await freshStore());
    const { run } = await store.create({
      workflowId: chainDef.id,
      workflowVersion: 1,
      params: {},
    });
    const registry = finalizerRegistry(true);
    await executeStep(store, chainDef, {
      runId: run.id,
      command: 'fail_a',
      input: {},
      dispatcher: explode('a exploded'),
      registry,
    });
    // `ok` succeeds ⇒ the chain reaches the guard, whose resolution_error seals the run, and
    // buildFinalizedSeal then drains `fin`, which throws and grows failed_steps.
    await executeChain(store, chainDef, {
      runId: run.id,
      command: 'ok',
      input: {},
      dispatcher: succeed,
      registry,
    });

    const record = await store.get(run.id);
    expect(record.failed_steps).toContain('g');
    expect(record.failed_steps).toContain('fin');
    expect(record.terminal_reason).toContain('3 steps failed:');
    expect(record.terminal_reason).toContain(`Finalizer 'fin' failed:`);
    expect(record.terminal_reason).toContain("unresolvable path '$.nope.field'");
    // And the enriched evidence really is minted by PRODUCTION here — not hand-shaped as in (D1).
    const guardEvidence = record.evidence.filter((e) => e.step_id === 'g' && e.error !== undefined);
    expect(guardEvidence.at(-1)!.error).toContain("unresolvable path '$.nope.field'");
  });
});

describe('#373 — across resume epochs', () => {
  it('(10) after resume + re-fail the sentence renders the CURRENT failures, with the new message', async () => {
    const definition = fanoutDef();
    const store = await freshStore();
    const { run } = await store.create({
      workflowId: definition.id,
      workflowVersion: 1,
      params: {},
    });
    for (const step of ['fail_a', 'fail_b']) {
      await executeStep(store, definition, {
        runId: run.id,
        command: step,
        input: {},
        dispatcher: explode(`${step} v1`),
      });
    }
    const sealed = await store.get(run.id);
    expect(sealed.terminal_reason).toContain('fail_a ("Dispatcher failed: fail_a v1")');

    const { run: resumed } = applyResume(sealed, 'fail_a', definition);
    await store.update(resumed);
    await executeStep(store, definition, {
      runId: run.id,
      command: 'fail_a',
      input: {},
      dispatcher: explode('fail_a v2'),
    });

    const record = await store.get(run.id);
    // Settle order flipped across the epoch; the sentence did not.
    expect(record.failed_steps).toEqual(['fail_b', 'fail_a']);
    expect(record.terminal_reason).toBe(
      '2 steps failed: fail_a ("Dispatcher failed: fail_a v2"), ' +
        'fail_b ("Dispatcher failed: fail_b v1").',
    );
  });

  it('(11) a prior-epoch finalizer scar stays in the record AND in the sentence; no duplicate arises', async () => {
    // UNEXECUTED TERRITORY before this cell. The hypothesis under test was that a re-minted
    // finalizer could append a DUPLICATE across epochs. It does not: `applyResume` filters only
    // the resumed step, so `fin` survives in `failed_steps` with its ledger entry still 'failed',
    // and at-most-once keeps it from re-running. Dedup is therefore correct-but-unexercised on
    // this route — pinned as observed, not as hoped.
    const definition = fanoutDef({ on_outcome: 'always' });
    const store = await freshStore();
    const registry = finalizerRegistry(true);
    const { run } = await store.create({
      workflowId: definition.id,
      workflowVersion: 1,
      params: {},
    });
    for (const step of ['fail_a', 'fail_b']) {
      await executeStep(store, definition, {
        runId: run.id,
        command: step,
        input: {},
        dispatcher: explode(`${step} v1`),
        registry,
      });
    }
    const sealed = await store.get(run.id);
    expect(sealed.failed_steps).toEqual(['fail_a', 'fail_b', 'fin']);

    const { run: resumed } = applyResume(sealed, 'fail_a', definition);
    expect(resumed.failed_steps).toEqual(['fail_b', 'fin']); // the scar survives the resume
    await store.update(resumed);
    await executeStep(store, definition, {
      runId: run.id,
      command: 'fail_a',
      input: {},
      dispatcher: explode('fail_a v2'),
      registry,
    });

    const record = await store.get(run.id);
    expect(record.failed_steps).toEqual(['fail_b', 'fin', 'fail_a']);
    expect(record.failed_steps.length).toBe(new Set(record.failed_steps).size); // no duplicate
    // The count matches the DEDUPED set — the property that holds whether or not a duplicate ever
    // appears, which is the whole reason dedup is in the render.
    const claimedCount = Number(/^(\d+) steps failed:/.exec(record.terminal_reason!)![1]);
    expect(claimedCount).toBe(new Set(record.failed_steps).size);
    expect(record.terminal_reason).toBe(
      '3 steps failed: fail_a ("Dispatcher failed: fail_a v2"), ' +
        'fail_b ("Dispatcher failed: fail_b v1"), ' +
        `fin ("Finalizer 'fin' failed: Handler 'fin-handler' threw: finalizer boom").`,
    );
  });
});
