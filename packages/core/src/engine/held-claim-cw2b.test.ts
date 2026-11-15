// held-claim-cw2b.test.ts — issue #729, the claim window, unit CW-2b: `executeChain` saves an agent step
// under the claim the drive already holds (`heldClaim`), the claim taken before with
// `claimStepForDrive` (CW-2a). Every cell runs the real entries on `InMemoryStore` with the lease double
// as its port; a lease's state is read from the double.
//
// Each assertion carries the two questions of `~/.claude/TESTING-RULES.md` rule 8 next to it.
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { InMemoryStore, createLeaseDouble, type LeaseDouble } from '@sensigo/realm-testing';
import { claimStepForDrive } from './drive-claim.js';
import { abandonRun } from './abandon-run.js';
import { executeChain, executeStep, type StepDispatcher } from './execution-loop.js';
import { createDefaultRegistry } from '../extensions/default-registry.js';
import { WorkflowError } from '../types/workflow-error.js';
import type { LeaseHold } from '../store/lease-port.js';
import type { RunStore } from '../store/store-interface.js';
import type { TraceBufferStore } from '../store/trace-buffer-store.js';
import type { StepDefinition, WorkflowDefinition } from '../types/workflow-definition.js';
import type { Snapshot } from './snapshot.js';
import type { Attributed } from './holder.js';
import type { EngineReply } from '../types/response-envelope.js';

const registry = createDefaultRegistry();
const DRIVE: Attributed = { by: 'drive', by_source: 'derived', channel: 'agent' };
const echo: StepDispatcher = async (_step, input) => ({ ...input });
const OUTPUT_SCHEMA = {
  type: 'object',
  required: ['category'],
  properties: { category: { type: 'string' } },
};

const def = (steps: Record<string, StepDefinition>, extra: Partial<WorkflowDefinition> = {}) =>
  ({ id: 'wf-cw2b', name: 'cw2b', version: 1, steps, ...extra }) as WorkflowDefinition;
const agent = (over: Partial<StepDefinition> = {}): StepDefinition =>
  ({ description: 'a', execution: 'agent', depends_on: [], ...over }) as StepDefinition;
/** A question step: an auto step whose gate asks a person. */
const QUESTION: StepDefinition = {
  description: 'q',
  execution: 'auto',
  trust: 'human_confirmed',
  depends_on: [],
  gate: { choices: ['approve', 'reject'] },
} as StepDefinition;

/** A store with the lease double, and a run of `d` in it. */
async function leased(
  d: WorkflowDefinition,
  store: InMemoryStore = new InMemoryStore({ leases: createLeaseDouble() }),
): Promise<{ store: InMemoryStore; double: LeaseDouble; runId: string }> {
  const { record } = await store.create({ workflowId: d.id, workflowVersion: 1, params: {} });
  return { store, double: store.leases as LeaseDouble, runId: record.id };
}

/** Takes `step`'s claim for the drive under a lease, as CW-5's `realm agent` will. */
async function takeHeld(store: RunStore, runId: string, step: string, d: WorkflowDefinition) {
  const answer = await claimStepForDrive(store, runId, step, {
    definition: d,
    registry,
    driver: DRIVE,
  });
  if (answer.kind !== 'claimed') throw new Error(`not claimed: ${JSON.stringify(answer)}`);
  return answer.hold;
}

const chain = (
  store: RunStore,
  d: WorkflowDefinition,
  runId: string,
  step: string,
  input: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) =>
  executeChain(store, d, {
    runId,
    command: step,
    input,
    dispatcher: echo,
    registry,
    driver: DRIVE,
    ...extra,
  });

/** Another program's claim of `step` under the lease `lease`, written through the store's `update`. */
async function takenOver(store: RunStore, runId: string, step: string, lease: string) {
  const { record } = await store.get(runId);
  await store.update({
    ...record,
    in_progress_steps: [...record.in_progress_steps.filter((s) => s !== step), step],
    claims: {
      ...record.claims,
      [step]: {
        deadline: null,
        token: 'other-token',
        since: '2026-01-01T00:00:00.000Z',
        holder: { by: 'other', by_source: 'derived', channel: 'agent' },
        lease: { id: lease },
      },
    },
  });
}

/** A trace-buffer store whose reads return `[]`; `onRead(n)` runs before the n-th read returns. */
function traceStore(onRead: (n: number) => Promise<void>): TraceBufferStore {
  let n = 0;
  return {
    append: async () => {
      throw new Error('not used');
    },
    read: async () => {
      n += 1;
      await onRead(n);
      return [];
    },
    delete: async () => {},
    deleteAllForRun: async () => ({ bytes_deleted: 0 }),
    statAllForRun: async () => ({ bytes: 0 }),
    readAllForRun: async () => ({}),
  };
}

/** Whether a reply offers `step` to this call, and whether it lists `step` as held elsewhere. */
function seen(reply: EngineReply, step: string) {
  return {
    offered: reply.ways.some((w) => w.verb === 'run_step' && w.step === step),
    heldElsewhere: reply.unavailable.some((u) => u.step === step && u.code === 'held_elsewhere'),
  };
}

describe('#729 CW-2b — executeChain saves an agent step under the claim the drive holds', () => {
  it('1. saved under the held claim: the step settles, its claim is gone, and no claim was taken', async () => {
    const d = def({ work: agent() });
    const { store, runId } = await leased(d);
    const hold = await takeHeld(store, runId, 'work', d);
    const before = (await store.get(runId)).record;
    const claimed: string[] = [];
    const claimStep = store.claimStep.bind(store);
    store.claimStep = (...a) => {
      claimed.push(a[1]);
      return claimStep(...a);
    };
    const reply = await chain(store, d, runId, 'work', { category: 'x' }, { heldClaim: { hold } });
    const after = (await store.get(runId)).record;
    // (1) red when Step 3 claims anyway (the claim then refuses, the step is not saved) or writes
    //     more than the settle; (2) prints the reply's status, the steps completed, the claim, how far
    //     the version moved and every claimStep call.
    expect({
      status: reply.status,
      completed: after.completed_steps,
      claim: after.claims?.['work'],
      moved: after.version - before.version,
      claimed,
    }).toEqual({ status: 'ok', completed: ['work'], claim: undefined, moved: 1, claimed: [] });
  });

  it('2. without heldClaim: another program’s step in progress under a lease is refused held_elsewhere', async () => {
    const d = def({ work: agent() });
    const { store, runId } = await leased(d);
    await takeHeld(store, runId, 'work', d);
    const before = (await store.get(runId)).record.version;
    const reply = await chain(store, d, runId, 'work', { category: 'x' });
    // (1) red when any in-progress claim with a lease is admitted (the call then goes on to the store's
    //     claim, which refuses it with STATE_STEP_ALREADY_CLAIMED instead of the admission); (2) prints
    //     the reply's status, its refusal's code, its error code, its hint and how far the version moved.
    expect({
      status: reply.status,
      refusal: reply.refusal?.code,
      code: reply.error_code,
      hint: reply.context_hint,
      moved: (await store.get(runId)).record.version - before,
    }).toEqual({
      status: 'blocked',
      refusal: 'held_elsewhere',
      code: undefined,
      hint: expect.stringMatching(/^Step 'work' cannot be called now: /),
      moved: 0,
    });
  });

  describe('3. the claim no longer names the lease', () => {
    it('3a. replaced by another program’s claim between Step 2 and Step 3: not saved, nothing written, the other claim stays', async () => {
      const d = def({ work: agent() });
      const { store, runId } = await leased(d);
      const hold = await takeHeld(store, runId, 'work', d);
      let replacedAt = -1;
      // The pre-claim trace-buffer read is the last thing before Step 3.
      const traceBufferStore = traceStore(async (n) => {
        if (n !== 1) return;
        await takenOver(store, runId, 'work', 'lease-other');
        replacedAt = (await store.get(runId)).record.version;
      });
      const reply = await chain(
        store,
        d,
        runId,
        'work',
        { category: 'x' },
        { heldClaim: { hold }, traceBufferStore },
      );
      const after = (await store.get(runId)).record;
      // (1) red when Step 3 skips the lease check (it then saves under the other program's token);
      //     (2) prints the reply's code and refusal, how far the version moved after the take-over,
      //     the steps completed and the claim's lease.
      expect({
        code: reply.error_code,
        refusal: reply.refusal?.code,
        moved: after.version - replacedAt,
        completed: after.completed_steps,
        lease: after.claims?.['work']?.lease,
      }).toEqual({
        code: 'STATE_CLAIM_LOST',
        refusal: 'claim_removed',
        moved: 0,
        completed: [],
        lease: { id: 'lease-other' },
      });
    });

    it('3b. the run abandoned between Step 2 and Step 3: not saved, the refusal’s abandon arm', async () => {
      const d = def({ work: agent() });
      const { store, runId } = await leased(d);
      const hold = await takeHeld(store, runId, 'work', d);
      const traceBufferStore = traceStore(async (n) => {
        if (n === 1) await abandonRun(store, runId);
      });
      const reply = await chain(
        store,
        d,
        runId,
        'work',
        { category: 'x' },
        { heldClaim: { hold }, traceBufferStore },
      );
      const after = (await store.get(runId)).record;
      // (1) red when the ended run's save goes on, or the refusal loses the ended run's act; (2)
      //     prints the reply's code, the refusal's code, remedies and why none, and the run's phase.
      expect({
        code: reply.error_code,
        refusal: reply.refusal?.code,
        remedy: reply.refusal?.remedy,
        noRemedy: reply.refusal?.no_remedy?.cause,
        phase: after.run_phase,
      }).toEqual({
        code: 'STATE_CLAIM_LOST',
        refusal: 'claim_removed',
        remedy: [],
        noRemedy: 'operator_command_untyped',
        phase: 'abandoned',
      });
    });

    it('3c. replaced before the call: refused held_elsewhere at the admission', async () => {
      const d = def({ work: agent() });
      const { store, runId } = await leased(d);
      const hold = await takeHeld(store, runId, 'work', d);
      await takenOver(store, runId, 'work', 'lease-other');
      const reply = await chain(
        store,
        d,
        runId,
        'work',
        { category: 'x' },
        { heldClaim: { hold } },
      );
      // (1) red when a claim naming another lease is admitted under the held claim; (2) prints the
      //     reply's status and refusal's code.
      expect({ status: reply.status, refusal: reply.refusal?.code }).toEqual({
        status: 'blocked',
        refusal: 'held_elsewhere',
      });
    });
  });

  it('4. a question open on another step: the held step’s answer is saved', async () => {
    const d = def({ q: QUESTION, work: agent() });
    const { store, runId } = await leased(d);
    const hold = await takeHeld(store, runId, 'work', d);
    const opened = await executeStep(store, d, {
      runId,
      command: 'q',
      input: {},
      dispatcher: async () => ({}),
    });
    const reply = await chain(store, d, runId, 'work', { category: 'x' }, { heldClaim: { hold } });
    const after = (await store.get(runId)).record;
    // (1) red when the gate check comes before the held branch (`question_open`, nothing saved); (2)
    //     prints the question's opening, the reply's status, the steps completed and the open gate.
    expect({
      opened: opened.status,
      status: reply.status,
      completed: after.completed_steps,
      gate: after.pending_gate?.step_name,
    }).toEqual({ opened: 'confirm_required', status: 'ok', completed: ['work'], gate: 'q' });
  });

  it('5. a rejection counts under the held claim when another step’s gate opens between the load and the count (L13)', async () => {
    const d = def({ q: QUESTION, work: agent({ output_schema: OUTPUT_SCHEMA }) });
    // The second read after arming (Step 1's load; the first is executeChain's entry read) returns
    // the run as read, then another step's gate opens: the count's first write is then stale.
    class GateOpensStore extends InMemoryStore {
      armed = false;
      private reads = 0;
      override async get(runId: string): Promise<Snapshot> {
        const read = await super.get(runId);
        if (this.armed && ++this.reads === 2) {
          this.armed = false;
          await executeStep(this, d, {
            runId,
            command: 'q',
            input: {},
            dispatcher: async () => ({}),
          });
        }
        return read;
      }
    }
    const { store, runId } = await leased(d, new GateOpensStore({ leases: createLeaseDouble() }));
    const hold = await takeHeld(store, runId, 'work', d);
    (store as GateOpensStore).armed = true;
    const reply = await chain(store, d, runId, 'work', {}, { heldClaim: { hold } });
    const after = (await store.get(runId)).record;
    // (1) red when the count's retry keeps today's eligibility conjunct (an open gate drops it); (2)
    //     prints the reply's code, the count, the open gate, the claim's lease and the warnings.
    expect({
      code: reply.error_code,
      count: after.validation_rejections?.['work'],
      gate: after.pending_gate?.step_name,
      lease: after.claims?.['work']?.lease,
      dropped: reply.warnings.some((w) => w.includes('rejection count not persisted')),
    }).toEqual({
      code: 'VALIDATION_OUTPUT_SCHEMA',
      count: 1,
      gate: 'q',
      lease: { id: hold.id },
      dropped: false,
    });
  });

  it('6. the exhaustion path, with workflow context: the exhaustion settles under the held claim, read fresh', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'realm-cw2b-'));
    try {
      const file = join(dir, 'rules.md');
      await writeFile(file, 'Be brief.', 'utf8');
      const d = def(
        { work: agent({ output_schema: OUTPUT_SCHEMA, validation_exhaustion: { threshold: 1 } }) },
        { workflow_context: { rules: { source: { path: file } } } } as Partial<WorkflowDefinition>,
      );
      const { store, runId } = await leased(d);
      const hold = await takeHeld(store, runId, 'work', d);
      const reply = await chain(store, d, runId, 'work', {}, { heldClaim: { hold } });
      const after = (await store.get(runId)).record;
      // (1) red when Step 3 holds the stale snapshot (the context write then refuses its version); (2)
      //     prints the reply's code, the steps failed, the claim and whether the context was kept.
      expect({
        code: reply.error_code,
        failed: after.failed_steps,
        claim: after.claims?.['work'],
        context: after.workflow_context_snapshots !== undefined,
      }).toEqual({
        code: 'VALIDATION_EXHAUSTED',
        failed: ['work'],
        claim: undefined,
        context: true,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('7. the un-claim: the second trace-buffer read fails — ENGINE_STORE_FAILED, and the claim still names the lease', async () => {
    const d = def({ work: agent() });
    const { store, runId } = await leased(d);
    const hold = await takeHeld(store, runId, 'work', d);
    const traceBufferStore = traceStore(async (n) => {
      if (n === 2) throw new Error('simulated post-claim read failure');
    });
    const reply = await chain(
      store,
      d,
      runId,
      'work',
      { category: 'x' },
      { heldClaim: { hold }, traceBufferStore },
    );
    const after = (await store.get(runId)).record;
    // (1) red when the un-claim runs (the drive's claim is released); (2) prints the reply's code, the
    //     claim's lease and the steps in progress.
    expect({
      code: reply.error_code,
      lease: after.claims?.['work']?.lease,
      inProgress: after.in_progress_steps,
    }).toEqual({ code: 'ENGINE_STORE_FAILED', lease: { id: hold.id }, inProgress: ['work'] });
  });

  describe('8. every reply inside a held call offers the held step and never lists it as held elsewhere', () => {
    const run = async (step: StepDefinition, input: Record<string, unknown>, extra = {}) => {
      const d = def({ work: step });
      const { store, runId } = await leased(d);
      const hold = await takeHeld(store, runId, 'work', d);
      return chain(store, d, runId, 'work', input, { heldClaim: { hold }, ...extra });
    };

    it('8a. the input-schema rejection', async () => {
      const reply = await run(
        agent({ input_schema: { type: 'object', required: ['x'] } } as Partial<StepDefinition>),
        {},
      );
      // (1) red when this reply's ways are composed without the held member; (2) prints the code and
      //     what the ways say of the step.
      expect({ code: reply.error_code, ...seen(reply, 'work') }).toEqual({
        code: 'VALIDATION_INPUT_SCHEMA',
        offered: true,
        heldElsewhere: false,
      });
    });

    it('8b. the output-schema rejection', async () => {
      const reply = await run(agent({ output_schema: OUTPUT_SCHEMA }), {});
      // (1) red when this reply's ways are composed without the held member; (2) prints the code and
      //     what the ways say of the step.
      expect({ code: reply.error_code, ...seen(reply, 'work') }).toEqual({
        code: 'VALIDATION_OUTPUT_SCHEMA',
        offered: true,
        heldElsewhere: false,
      });
    });

    it('8c. the trace-enforce rejection', async () => {
      const reply = await run(
        agent({
          trace_schema: {
            type: 'array',
            items: { type: 'object', required: ['event', 'myField'] },
          },
          trace_validation_mode: 'enforce',
        } as Partial<StepDefinition>),
        { category: 'x' },
        { trace: [{ event: 'bad_entry' }] },
      );
      // (1) red when this reply's ways are composed without the held member; (2) prints the code and
      //     what the ways say of the step.
      expect({ code: reply.error_code, ...seen(reply, 'work') }).toEqual({
        code: 'VALIDATION_TRACE_SCHEMA',
        offered: true,
        heldElsewhere: false,
      });
    });

    it('8d. a settle that throws a store WorkflowError', async () => {
      const d = def({ work: agent() });
      const { store, runId } = await leased(d);
      const hold = await takeHeld(store, runId, 'work', d);
      store.settleStep = (async () => {
        throw new WorkflowError('The run is busy.', {
          code: 'STATE_RUN_BUSY',
          category: 'STATE',
          agentAction: 'report_to_user',
          retryable: true,
        });
      }) as InMemoryStore['settleStep'];
      const reply = await chain(
        store,
        d,
        runId,
        'work',
        { category: 'x' },
        { heldClaim: { hold } },
      );
      // (1) red when this reply's ways are composed without the held member; (2) prints the code and
      //     what the ways say of the step.
      expect({ code: reply.error_code, ...seen(reply, 'work') }).toEqual({
        code: 'STATE_RUN_BUSY',
        offered: true,
        heldElsewhere: false,
      });
    });
  });

  it('9. the chain after the held step: a chained step takes its own claim, which names no lease', async () => {
    const d = def({
      work: agent(),
      next: { description: 'n', execution: 'auto', depends_on: ['work'] } as StepDefinition,
    });
    const { store, runId } = await leased(d);
    const hold = await takeHeld(store, runId, 'work', d);
    const claims: Array<{ step: string; hold: boolean; lease: unknown }> = [];
    const claimStep = store.claimStep.bind(store);
    store.claimStep = async (...a) => {
      const snap = await claimStep(...a);
      claims.push({
        step: a[1],
        hold: a[4] !== undefined,
        lease: snap.record.claims?.[a[1]]?.lease,
      });
      return snap;
    };
    const reply = await chain(store, d, runId, 'work', { category: 'x' }, { heldClaim: { hold } });
    const after = (await store.get(runId)).record;
    // (1) red when the chain stops after the held save, or a chained step claims with a hold or
    //     under a lease. A held claim that reached the loop shows here only with the engine's
    //     agent-only rule off too, because the chain runs only auto steps (red-first E9); (2)
    //     prints the reply's status, every claim taken with whether it was given a hold and its
    //     lease, and the steps completed.
    expect({ status: reply.status, claims, completed: after.completed_steps }).toEqual({
      status: 'ok',
      claims: [{ step: 'next', hold: false, lease: undefined }],
      completed: ['work', 'next'],
    });
  });

  describe('11. an auto step under heldClaim is judged and run as today', () => {
    const d = def({
      job: { description: 'j', execution: 'auto', depends_on: [] } as StepDefinition,
    });

    it('11a. an auto step held under the lease is refused held_elsewhere', async () => {
      const { store, runId } = await leased(d);
      const hold = await takeHeld(store, runId, 'job', d);
      const reply = await chain(store, d, runId, 'job', {}, { heldClaim: { hold } });
      // (1) red when the held branch is applied to an auto step (it is then saved). That needs
      //     the engine's, the composer's and the admission's agent-only rules all off (red-first
      //     E11a2): with only the first two off, the admission still refuses it; (2) prints the
      //     reply's status and refusal's code.
      expect({ status: reply.status, refusal: reply.refusal?.code }).toEqual({
        status: 'blocked',
        refusal: 'held_elsewhere',
      });
    });

    it('11b. an unclaimed, eligible auto step is claimed and run as today', async () => {
      const { store, double, runId } = await leased(d);
      const made = await double.hold();
      const hold = (made as { held: LeaseHold }).held;
      const reply = await chain(store, d, runId, 'job', {}, { heldClaim: { hold } });
      const after = (await store.get(runId)).record;
      // (1) red when Step 3's adoption is keyed on heldClaim alone (the claim is then "lost"); (2)
      //     prints the reply's status and the steps completed.
      expect({ status: reply.status, completed: after.completed_steps }).toEqual({
        status: 'ok',
        completed: ['job'],
      });
    });
  });
});

describe('#729 CW-2b — the step body composes every reply’s ways through its per-call builder', () => {
  it('no call in executeStepBody composes ways without `ways`: no waysOf, every makeErrorEnvelope given a definition, and both envelope builders, end in `ways`', () => {
    const path = fileURLToPath(new URL('./execution-loop.ts', import.meta.url));
    const sf = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
    const body = sf.statements.find(
      (st): st is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(st) && st.name?.text === 'executeStepBody',
    );
    const calls: Array<{ name: string; line: number; last: string; args: number }> = [];
    const names = [
      'waysOf',
      'makeErrorEnvelope',
      'buildSettlementRefusalEnvelope',
      'buildAlreadySettledEnvelope',
    ];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const name = node.expression.text;
        if (names.includes(name)) {
          const last = node.arguments[node.arguments.length - 1];
          calls.push({
            name,
            line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
            last: last === undefined ? '' : last.getText(sf),
            args: node.arguments.length,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    if (body !== undefined) visit(body);
    // A makeErrorEnvelope call without a definition composes no ways (its fifth argument).
    const composing = calls.filter((c) => c.name !== 'makeErrorEnvelope' || c.args >= 5);
    // (1) red when a site in the step body composes its reply's ways without the call's builder (a
    //     waysOf call, or a call that does not pass `ways`), or the walk finds the body or its calls
    //     no more (it would then see nothing); (2) prints each such call with its line, and how many
    //     calls the walk read.
    expect({
      body: body !== undefined,
      read: composing.length > 0,
      without: composing
        .filter((c) => c.name === 'waysOf' || c.last !== 'ways')
        .map((c) => `${c.name} :${c.line}`),
    }).toEqual({ body: true, read: true, without: [] });
  });
});
