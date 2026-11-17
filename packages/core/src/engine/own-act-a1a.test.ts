// own-act-a1a.test.ts — issue #625 PR-2b (A1a): a reply that did an act and then ran the chain
// keeps the act's own result.
//
// An assistant runs step `draft`; Realm then runs `send` by itself, and `send` fails, opens a
// question, or ends the run through a guard. The reply keeps every member it has today and adds
// `own_act` (the called step was recorded, with its own evidence entry for a library caller), and
// its text opens "Step 'draft' completed." exactly once. With no chain the reply is today's.
//
// These cells drive the REAL engine (`executeChain`) on a REAL `InMemoryStore`. They are the
// prompt's acceptance checks 2–6 at the library and the four callbacks `executeChain` now forwards
// (item 7). Every assertion carries (a) the change that turns it red and (b) what it prints.
import { describe, it, expect } from 'vitest';
import { InMemoryStore } from '@sensigo/realm-testing';
import { advanceRun, executeChain } from './execution-loop.js';
import { reclaimStep } from './reclaim-step.js';
import { ExtensionRegistry } from '../extensions/registry.js';
import type { Attributed } from './holder.js';
import type { StepDefinition, WorkflowDefinition } from '../types/workflow-definition.js';
import type { StepDispatcher } from './execution-loop.js';

const RACER: Attributed = { by: 'racer-b', by_source: 'stated', channel: 'test' };

/** agent `draft` → `next` (the step that follows it). */
function draftThen(next: Record<string, StepDefinition>): WorkflowDefinition {
  return {
    id: 'own-act-wf',
    name: 'Own act',
    version: 1,
    steps: {
      draft: { description: 'Draft', execution: 'agent', depends_on: [] },
      ...next,
    },
  };
}

/** A registry whose handler `h` (chained `send`'s) throws, as a refused mail server would. */
function sendThrows(): ExtensionRegistry {
  const registry = new ExtensionRegistry();
  registry.register('handler', 'h', {
    id: 'h',
    execute: async () => {
      throw new Error('The mail server refused the message.');
    },
  });
  return registry;
}
const echo: StepDispatcher = async (_name, input) => ({ ...input });

async function freshRun(store: InMemoryStore, def: WorkflowDefinition): Promise<string> {
  const { record } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
  return record.id;
}

/** How many times `words` appears in `text`. */
const occurrences = (text: string, words: string): number => text.split(words).length - 1;

/** The four callbacks, recorded in call order. */
function recorder() {
  const calls: string[] = [];
  return {
    calls,
    callbacks: {
      onStep: (step: string) => calls.push(`step:${step}`),
      onTaken: (step: string) => calls.push(`taken:${step}`),
      onNotRecorded: (step: string, kind: string) => calls.push(`not_recorded:${step}:${kind}`),
      onGuard: (step: string) => calls.push(`guard:${step}`),
    },
  };
}

describe('#625 A1a — executeChain: the act recorded, then the chain', () => {
  it('check 2 — the chained `send` fails: today’s members, plus own_act (with the act’s own entry), and the opening once', async () => {
    const store = new InMemoryStore();
    const def = draftThen({
      send: { description: 'Send', execution: 'auto', handler: 'h', depends_on: ['draft'] },
    });
    const runId = await freshRun(store, def);
    const rec = recorder();

    const reply = await executeChain(store, def, {
      runId,
      command: 'draft',
      input: { body: 'Hello' },
      dispatcher: echo,
      registry: sendThrows(),
      ...rec.callbacks,
    });

    // (a) red when `status`/`stopped_step`/`error_code` become the act's (`ok`) or `own_act` is
    //     left out; (b) prints the members.
    expect({
      status: reply.status,
      error_code: reply.error_code,
      errors: reply.errors,
      stopped_step: reply.stopped_step,
      own_act: reply.own_act && {
        command: reply.own_act.command,
        recorded: reply.own_act.recorded,
        evidence_step: reply.own_act.evidence?.step_id,
        evidence_output: reply.own_act.evidence?.output_summary,
      },
    }).toEqual({
      status: 'error',
      error_code: 'ENGINE_HANDLER_FAILED',
      errors: ["Handler 'h' threw: The mail server refused the message."],
      stopped_step: 'send',
      own_act: {
        command: 'draft',
        recorded: true,
        evidence_step: 'draft',
        evidence_output: { body: 'Hello' },
      },
    });
    // (a) red when the opening is left out, doubled, or replaces today's text; (b) prints the hint.
    expect(reply.context_hint).toBe(
      "Step 'draft' completed. Step 'send' failed. Run is terminated.",
    );
    // Item 7: `onStep` is told of the chained step (red when executeChain drops the callback).
    expect(rec.calls).toEqual(['step:send']);
  });

  it('check 3 — the chain reaches a gate: confirm_required as today, plus own_act (a chained gate is not in chained_auto_steps)', async () => {
    const store = new InMemoryStore();
    const def = draftThen({
      send: {
        description: 'Send',
        execution: 'auto',
        trust: 'human_confirmed',
        depends_on: ['draft'],
        gate: { choices: ['approve', 'reject'] },
      },
    });
    const runId = await freshRun(store, def);

    const reply = await executeChain(store, def, {
      runId,
      command: 'draft',
      input: { body: 'Hello' },
      dispatcher: echo,
    });

    // (a) red when presence is keyed on how many steps the chain recorded (a gate it opened is
    //     never pushed there, so the member would be missing); (b) prints the members.
    expect({
      status: reply.status,
      chained: reply.chained_auto_steps ?? [],
      own_act: reply.own_act && {
        command: reply.own_act.command,
        recorded: reply.own_act.recorded,
      },
      evidence_step: reply.own_act?.evidence?.step_id,
      opening: reply.context_hint.startsWith("Step 'draft' completed. "),
      once: occurrences(reply.context_hint, "Step 'draft' completed."),
    }).toEqual({
      status: 'confirm_required',
      chained: [],
      own_act: { command: 'draft', recorded: true },
      evidence_step: 'draft',
      opening: true,
      once: 1,
    });
  });

  it('check 4 — no chain: an agent step followed by another agent step, and a named auto step with nothing after it, get no own_act and today’s words', async () => {
    // (a) red when presence is keyed on object identity (the loop returns a new object for the
    //     named reply even when nothing ran after it); (b) prints the member and the hint.
    {
      const store = new InMemoryStore();
      const def = draftThen({
        review: { description: 'Review', execution: 'agent', depends_on: ['draft'] },
      });
      const runId = await freshRun(store, def);
      const reply = await executeChain(store, def, {
        runId,
        command: 'draft',
        input: {},
        dispatcher: echo,
      });
      expect({ status: reply.status, own_act: reply.own_act, hint: reply.context_hint }).toEqual({
        status: 'ok',
        own_act: undefined,
        // The library's own `ok` reply; the MCP door adds what comes next.
        hint: "Step 'draft' completed.",
      });
    }
    {
      const store = new InMemoryStore();
      const def: WorkflowDefinition = {
        id: 'own-act-last-auto',
        name: 'Own act — last auto',
        version: 1,
        steps: {
          tidy: { description: 'Tidy', execution: 'auto', depends_on: [] },
        },
      };
      const runId = await freshRun(store, def);
      const reply = await executeChain(store, def, {
        runId,
        command: 'tidy',
        input: {},
        dispatcher: echo,
      });
      expect({
        status: reply.status,
        own_act: reply.own_act,
        hint: reply.context_hint,
        phase: reply.run_phase,
      }).toEqual({
        status: 'ok',
        own_act: undefined,
        // Today's words for a named step that ends the run with nothing after it.
        hint: "Run completed (phase: 'completed').",
        phase: 'completed',
      });
    }
  });

  it('check 5 (RF-06) — the act’s own write ends the run through a guard: own_act.evidence is the act’s entry, not the guard’s; the opening once; onGuard told', async () => {
    const store = new InMemoryStore();
    const def: WorkflowDefinition = {
      id: 'own-act-guard',
      name: 'Own act — guard',
      version: 1,
      steps: {
        work: { description: 'Work', execution: 'agent', depends_on: [] },
        check: {
          description: 'Check',
          execution: 'guard',
          depends_on: ['work'],
          abort_unless: ['work.ok == true'],
          abort_message: 'Work was not ok.',
        },
      },
    };
    const runId = await freshRun(store, def);
    const rec = recorder();

    const reply = await executeChain(store, def, {
      runId,
      command: 'work',
      input: {},
      dispatcher: async () => ({ ok: false }),
      ...rec.callbacks,
    });

    // (a) red when the act's evidence is read from `named.evidence` (the guard's entry, step
    //     `check`) or from `judgedSnapshotOf(named)` (always undefined in the chain: no entry);
    //     (b) prints the entry's step, kind and output.
    expect({
      command: reply.own_act?.command,
      step: reply.own_act?.evidence?.step_id,
      kind: reply.own_act?.evidence?.kind ?? 'execution',
      output: reply.own_act?.evidence?.output_summary,
      replyEvidence: reply.evidence.map((e) => e.step_id),
    }).toEqual({
      command: 'work',
      step: 'work',
      kind: 'execution',
      output: { ok: false },
      // The reply's own `evidence` keeps today's meaning: the guard's.
      replyEvidence: ['check'],
    });
    // (a) red when the opening is left out or doubled; (b) prints the hint.
    expect(reply.context_hint).toBe("Step 'work' completed. Guard step 'check' aborted the run.");
    // Item 7 (AU-14): the guard the named step's own write decided is told to `onGuard`.
    expect(rec.calls).toEqual(['guard:check']);
  });

  it('check 6 — a race with no step after the act: the chained step taken by another process → own_act, the opening once; onTaken told', async () => {
    const store = new InMemoryStore();
    const def: WorkflowDefinition = {
      id: 'own-act-race',
      name: 'Own act — race',
      version: 1,
      steps: {
        a: { description: 'A', execution: 'agent' },
        s: { description: 'S', execution: 'auto', handler: 'h', depends_on: ['a'] },
      },
    };
    const registry = new ExtensionRegistry();
    registry.register('handler', 'h', { id: 'h', execute: async () => ({ data: { by: 'h' } }) });
    const runId = await freshRun(store, def);
    let fired = false;
    // At this call's claim of `s`, another program runs it to the run's end first.
    const racing = new Proxy(store, {
      get(target, prop) {
        if (prop === 'claimStep') {
          return async (...a: Parameters<InMemoryStore['claimStep']>) => {
            if (a[1] === 's' && !fired) {
              fired = true;
              await advanceRun(store, def, { runId, registry, driver: RACER });
            }
            return target.claimStep(...a);
          };
        }
        const v = Reflect.get(target, prop, target) as unknown;
        return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(target) : v;
      },
    });
    const rec = recorder();

    const reply = await executeChain(racing, def, {
      runId,
      command: 'a',
      input: {},
      dispatcher: echo,
      registry,
      ...rec.callbacks,
    });

    // (a) red when the opening is applied on top of the race reply's own head ("Step 'a'
    //     completed." twice), or the member is left out; (b) prints the member and the hint.
    expect({
      own_act: reply.own_act && {
        command: reply.own_act.command,
        recorded: reply.own_act.recorded,
      },
      races: (reply.races ?? []).length,
      once: occurrences(reply.context_hint, "Step 'a' completed."),
      opens: reply.context_hint.startsWith("Step 'a' completed."),
    }).toEqual({
      own_act: { command: 'a', recorded: true },
      races: 1,
      once: 1,
      opens: true,
    });
    // Item 7: the taken step is told to `onTaken` after `onStep` (red when either is dropped).
    expect(rec.calls).toEqual(['step:s', 'taken:s']);
  });

  it('item 7 — onNotRecorded is forwarded: a chained step whose claim another program removed while it ran', async () => {
    const store = new InMemoryStore();
    const def: WorkflowDefinition = {
      id: 'own-act-not-recorded',
      name: 'Own act — not recorded',
      version: 1,
      steps: {
        a: { description: 'A', execution: 'agent' },
        s: { description: 'S', execution: 'auto', handler: 'h', depends_on: ['a'] },
      },
    };
    const runId = await freshRun(store, def);
    let runs = 0;
    const registry = new ExtensionRegistry();
    registry.register('handler', 'h', {
      id: 'h',
      execute: async () => {
        runs += 1;
        if (runs === 1) await reclaimStep(store, runId, 's');
        return { data: { by: 'h' } };
      },
    });
    const rec = recorder();

    const reply = await executeChain(store, def, {
      runId,
      command: 'a',
      input: {},
      dispatcher: echo,
      registry,
      ...rec.callbacks,
    });

    // (a) red when executeChain does not forward `onNotRecorded`; (b) prints the calls.
    expect(rec.calls.slice(0, 2)).toEqual(['step:s', 'not_recorded:s:claim_removed']);
    // (a) red when the member is missing on a race reply; (b) prints it.
    expect(reply.own_act && { command: reply.own_act.command }).toEqual({ command: 'a' });
  });
});
