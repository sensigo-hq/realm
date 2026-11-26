// remember-stamp-g3u1a.test.ts — gap 3, unit 1a (prompt gap3-u1a-remember-stamp.md): a step's
// `remember:` stamped on the entry its success writes (a gated step's: its answer's), through the
// library, checks 1, 2 (the library's door), 3–9. Fake values only; no model calls (an agent step's
// answer comes from the test's own dispatcher).
//
// Every assertion names (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect } from 'vitest';
import { InMemoryStore, settableClock, type SettableClock } from '@sensigo/realm-testing';
import {
  executeChain,
  executeStep,
  submitHumanResponse,
  type ExecuteChainOptions,
} from './execution-loop.js';
import { ExtensionRegistry } from '../extensions/registry.js';
import type { StepHandler, StepHandlerResult } from '../extensions/step-handler.js';
import { WorkflowError } from '../types/workflow-error.js';
import type { EvidenceSnapshot, RunRecord } from '../types/run-record.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
import { loadWorkflowFromString } from '../workflow/yaml-loader.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** A registry with the two handlers of the offer case: `norm` gives the key, `offer` the rung. */
function registryOf(norm: () => StepHandlerResult, offer?: () => StepHandlerResult | never) {
  const registry = new ExtensionRegistry();
  registry.register('handler', 'norm', { id: 'norm', execute: async () => norm() } as StepHandler);
  registry.register('handler', 'offer', {
    id: 'offer',
    execute: async () => (offer ?? (() => ({ data: { rung: 2 } })))(),
  } as StepHandler);
  return registry;
}

const REMEMBER = `    remember:
      as: offers
      key: { customer_email: context.resources.normalize_email.email }
      value: { rung: context.resources.record_offer.rung }
      keep_days: 90
`;

/** The offer case's workflow, through the loader; `extra` goes on `record_offer`. */
function offerWorkflow(remember = REMEMBER, extra = ''): WorkflowDefinition {
  return loadWorkflowFromString(`id: offers-g3u1a
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
${extra}${remember}`);
}

async function newRun(store: InMemoryStore, def: WorkflowDefinition): Promise<string> {
  const { record } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
  return record.id;
}

/** Runs both steps by name; returns the second reply and the stored record. */
async function runOffer(
  def: WorkflowDefinition,
  registry: ExtensionRegistry,
  store = new InMemoryStore(),
) {
  const runId = await newRun(store, def);
  const base = { runId, input: {}, dispatcher: async () => ({}), registry };
  await executeStep(store, def, { ...base, command: 'normalize_email' });
  const reply = await executeStep(store, def, { ...base, command: 'record_offer' });
  const stored = (await store.get(runId)).record;
  return { reply, stored, runId, store };
}

const entriesOf = (r: RunRecord, step: string): EvidenceSnapshot[] =>
  r.evidence.filter((e) => e.step_id === step);
const lastOf = (r: RunRecord, step: string): EvidenceSnapshot => entriesOf(r, step).at(-1)!;
const expiryOf = (e: EvidenceSnapshot, days: number): string =>
  new Date(Date.parse(e.completed_at) + days * DAY_MS).toISOString();
const keyed = (email: unknown) =>
  registryOf(() => ({ data: email === undefined ? {} : { email } }) as StepHandlerResult);

describe('gap 3 (1a), check 1 — the offer case', () => {
  it('the success entry holds as, the key from the upstream step, the declared value and expires_at = completed_at + 90 days', async () => {
    const { stored } = await runOffer(offerWorkflow(), keyed('a@example.test'));
    const entry = lastOf(stored, 'record_offer');
    // (a) red when the success site does not call the stamp, or the stamp's parts or time are
    //     wrong; (b) prints the stamp.
    expect(entry.remembered).toEqual({
      as: 'offers',
      key: { customer_email: 'a@example.test' },
      value: { rung: 2 },
      expires_at: expiryOf(entry, 90),
    });
    // The upstream step has no `remember:`: (a) red when the field is spread on every entry.
    expect('remembered' in lastOf(stored, 'normalize_email')).toBe(false);
  });
});

describe('gap 3 (1a), check 2 (the library door) — executeChain stamps as executeStep does', () => {
  it("executeChain from the first step: the writer's entry holds the same stamp", async () => {
    const store = new InMemoryStore();
    const def = offerWorkflow();
    const runId = await newRun(store, def);
    await executeChain(store, def, {
      runId,
      command: 'normalize_email',
      input: {},
      dispatcher: async () => ({}),
      registry: keyed('a@example.test'),
    } as ExecuteChainOptions);
    const entry = lastOf((await store.get(runId)).record, 'record_offer');
    // (a) red when the stamp is computed in one door's code instead of the engine; (b) prints it.
    expect(entry.remembered).toEqual({
      as: 'offers',
      key: { customer_email: 'a@example.test' },
      value: { rung: 2 },
      expires_at: expiryOf(entry, 90),
    });
  });
});

describe('gap 3 (1a), check 3 — the stamp is in the reply', () => {
  it("the library's executeStep reply evidence carries the stamp, equal to the stored one", async () => {
    const { reply, stored } = await runOffer(offerWorkflow(), keyed('a@example.test'));
    const replied = reply.evidence.find((e) => e.step_id === 'record_offer');
    // (a) red when the stamp is made after the reply's evidence is built; (b) prints both.
    expect(replied?.remembered).toEqual(lastOf(stored, 'record_offer').remembered);
    expect(replied?.remembered).toMatchObject({ as: 'offers' });
    // A remembered stamp adds no warning: (a) red when every stamp warns; (b) prints the warnings.
    expect(reply.warnings.filter((w) => w.includes('remembered nothing'))).toEqual([]);
  });
});

const GATE = `    trust: human_confirmed
    gate:
      choices: [approve, reject]
`;

async function openGate(
  def: WorkflowDefinition,
  registry: ExtensionRegistry,
  store: InMemoryStore,
) {
  const runId = await newRun(store, def);
  const base = { runId, input: {}, dispatcher: async () => ({}), registry };
  await executeStep(store, def, { ...base, command: 'normalize_email' });
  const opened = await executeStep(store, def, { ...base, command: 'record_offer' });
  const gate = (await store.get(runId)).record.pending_gate!;
  return { runId, opened, gate };
}

describe('gap 3 (1a), check 4 — a gated writer remembers on its answer, with the choice', () => {
  for (const choice of ['approve', 'reject']) {
    it(`answered '${choice}': the answer entry is stamped with the choice; the entry its gate opened on is not`, async () => {
      const store = new InMemoryStore();
      const def = offerWorkflow(REMEMBER, GATE);
      const { runId, opened, gate } = await openGate(def, keyed('a@example.test'), store);
      expect(opened.status).toBe('confirm_required');
      const reply = await submitHumanResponse(store, def, { runId, gateId: gate.gate_id, choice });
      const entries = entriesOf((await store.get(runId)).record, 'record_offer');
      const answer = entries.find((e) => e.kind === 'gate_response')!;
      // (a) red when the open entry is stamped, or the answer's stamp lacks the choice; (b) prints
      //     each entry's kind and stamp.
      expect(entries.map((e) => [e.kind ?? 'step', e.remembered])).toEqual([
        ['step', undefined],
        [
          'gate_response',
          {
            as: 'offers',
            key: { customer_email: 'a@example.test' },
            value: { rung: 2 },
            choice,
            expires_at: expiryOf(answer, 90),
          },
        ],
      ]);
      expect(reply.warnings.filter((w) => w.includes('remembered nothing'))).toEqual([]);
    });
  }

  it("answered with the key absent: the answer entry says key_absent and the answer's reply warns", async () => {
    const store = new InMemoryStore();
    const def = offerWorkflow(REMEMBER, GATE);
    const { runId, gate } = await openGate(def, keyed(undefined), store);
    const reply = await submitHumanResponse(store, def, {
      runId,
      gateId: gate.gate_id,
      choice: 'approve',
    });
    const answer = entriesOf((await store.get(runId)).record, 'record_offer').at(-1)!;
    // (a) red when the gate site leaves the warning out, or warns on the open entry; (b) prints both.
    expect({
      stamp: answer.remembered,
      warnings: reply.warnings.filter((w) => w.includes('remembered')),
    }).toEqual({
      stamp: { as: 'offers', not_remembered: 'key_absent', key_name: 'customer_email' },
      warnings: [
        "Step 'record_offer' remembered nothing in 'offers': its key 'customer_email' was not there.",
      ],
    });
  });
});

/** An in-memory store on a settable clock (the late-answer tests' helper). */
function clockedStore(): InMemoryStore {
  return new InMemoryStore({ clock: settableClock(new Date()) });
}
async function setClockOf(store: object, t: Date): Promise<void> {
  const clock = (store as { clock?: Partial<SettableClock> }).clock ?? {};
  await clock.set!(t);
}
const EXPIRING = (onExpiry: 'settle_default' | 'abort') => `    trust: human_confirmed
    gate:
      choices: [approve, reject]
      timeout_seconds: 1
      on_expiry: ${onExpiry}
${onExpiry === 'settle_default' ? '      default_choice: approve\n' : ''}`;

const stamped = (r: RunRecord): EvidenceSnapshot[] => r.evidence.filter((e) => 'remembered' in e);

describe('gap 3 (1a), check 5 — never stamped', () => {
  it('a failed try before a success: only the success entry carries the stamp', async () => {
    let tries = 0;
    const registry = registryOf(
      () => ({ data: { email: 'a@example.test' } }),
      () => {
        tries += 1;
        if (tries === 1)
          throw new WorkflowError('busy (fake)', {
            code: 'SERVICE_RATE_LIMITED',
            category: 'SERVICE',
            agentAction: 'wait_for_service',
            retryable: true,
          });
        return { data: { rung: 2 } };
      },
    );
    const def = offerWorkflow(
      REMEMBER,
      '    retry: { max_attempts: 2, backoff: fixed, base_delay_ms: 1 }\n',
    );
    const { stored } = await runOffer(def, registry);
    // (a) red when every entry of the settle is stamped; (b) prints each entry's status and stamp.
    expect(entriesOf(stored, 'record_offer').map((e) => [e.status, 'remembered' in e])).toEqual([
      ['error', false],
      ['success', true],
    ]);
  });

  it('a failed step: no entry is stamped and no warning', async () => {
    const registry = registryOf(
      () => ({ data: { email: 'a@example.test' } }),
      () => {
        throw new Error('handler failed (fake)');
      },
    );
    const { stored, reply } = await runOffer(offerWorkflow(), registry);
    // (a) red when the stamp is called at the `outcome: 'fail'` settle; (b) prints the stamped entries.
    expect({ failed: stored.failed_steps, stamped: stamped(stored).length }).toEqual({
      failed: ['record_offer'],
      stamped: 0,
    });
    expect(reply.warnings.filter((w) => w.includes('remembered'))).toEqual([]);
  });

  it("a handler's abort: no entry is stamped", async () => {
    const registry = registryOf(
      () => ({ data: { email: 'a@example.test' } }),
      () => ({ abort: { message: 'already handled (fake)' } }),
    );
    const { stored } = await runOffer(offerWorkflow(), registry);
    // (a) red when the stamp is called at the abort settle; (b) prints the phase and the stamped.
    expect({ phase: stored.run_phase, stamped: stamped(stored).length }).toEqual({
      phase: 'aborted',
      stamped: 0,
    });
  });

  for (const onExpiry of ['settle_default', 'abort'] as const) {
    it(`an expired gate (${onExpiry}): no entry is stamped`, async () => {
      const store = clockedStore();
      const def = offerWorkflow(REMEMBER, EXPIRING(onExpiry));
      const { runId, gate } = await openGate(def, keyed('a@example.test'), store);
      await setClockOf(store, new Date(Date.parse(gate.expires_at!) + 60_000));
      const result = await store.settleStep(
        runId,
        { kind: 'expire_gate', gateId: gate.gate_id },
        def,
      );
      const after = (await store.get(runId)).record;
      // (a) red when applyExpireGate's arms stamp; (b) prints whether it applied and the stamped.
      expect({ applied: result.applied, stamped: stamped(after).length }).toEqual({
        applied: true,
        stamped: 0,
      });
    });
  }

  it('a late answer: no stamp and no warning', async () => {
    const store = clockedStore();
    const def = offerWorkflow(REMEMBER, EXPIRING('settle_default'));
    const { runId, gate } = await openGate(def, keyed(undefined), store);
    await setClockOf(store, new Date(Date.parse(gate.expires_at!) + 60_000));
    const reply = await submitHumanResponse(store, def, {
      runId,
      gateId: gate.gate_id,
      choice: 'approve',
    });
    const after = (await store.get(runId)).record;
    // (a) red when the warning is added before the late-answer check, or the late arm keeps the
    //     delta's evidence; (b) prints the stamped and the warnings.
    expect({
      stamped: stamped(after).length,
      warned: reply.warnings.filter((w) => w.includes('remembered')),
    }).toEqual({ stamped: 0, warned: [] });
  });

  it('a step without remember: its entry has no remembered key', async () => {
    const { stored } = await runOffer(offerWorkflow(''), keyed('a@example.test'));
    // (a) red when the field is spread unconditionally; (b) prints the entry's keys.
    expect(Object.keys(lastOf(stored, 'record_offer'))).not.toContain('remembered');
  });
});

const SCHEMA = '{ type: object, required: [route], properties: { route: { type: string } } }';
const FAILURE: NonNullable<ExecuteChainOptions['modelFailure']> = {
  kind: 'permanent',
  stop_reason: 'non_retryable',
  message: 'Provider 400: bad request (fake)',
  attempt: 1,
  error_class: 'api_status',
  status: 400,
};

/** An agent step that takes its default answer when its model request fails; `extra` on it. */
function classifyWorkflow(extra = ''): WorkflowDefinition {
  return loadWorkflowFromString(`id: classify-g3u1a
name: Classify
version: 1
steps:
  classify:
    description: Route the ticket.
    execution: agent
    output_schema: ${SCHEMA}
    on_model_failure: default
    validation_exhaustion:
      default_output: { route: human }
${extra}    remember:
      as: routes
      key: { route: context.resources.classify.route }
      keep_days: 30
`);
}

describe('gap 3 (1a), check 6 — settled by its default', () => {
  it("an ungated step that took its default answer: not_remembered settled_by_default, and the reply's warning", async () => {
    const store = new InMemoryStore();
    const def = classifyWorkflow();
    const runId = await newRun(store, def);
    const reply = await executeChain(store, def, {
      runId,
      command: 'classify',
      input: {},
      dispatcher: async () => ({}),
      modelFailure: FAILURE,
    });
    const entries = entriesOf((await store.get(runId)).record, 'classify');
    // (a) red when "settled by default" is judged by status alone (the entry is `success`); (b)
    //     prints each entry's status and stamp, and the warning.
    expect({
      entries: entries.map((e) => [e.status, e.remembered]),
      warned: reply.warnings.filter((w) => w.includes('remembered nothing')),
    }).toEqual({
      entries: [
        ['error', undefined],
        ['success', { as: 'routes', not_remembered: 'settled_by_default' }],
      ],
      warned: ["Step 'classify' remembered nothing in 'routes': it took its default answer."],
    });
  });

  it('a gated step with on_model_failure: default, approved: its answer entry says settled_by_default, and the answer warns', async () => {
    const store = new InMemoryStore();
    const def = classifyWorkflow(GATE);
    const runId = await newRun(store, def);
    const opened = await executeChain(store, def, {
      runId,
      command: 'classify',
      input: {},
      dispatcher: async () => ({}),
      modelFailure: FAILURE,
    });
    expect(opened.status).toBe('confirm_required');
    const gate = (await store.get(runId)).record.pending_gate!;
    const reply = await submitHumanResponse(store, def, {
      runId,
      gateId: gate.gate_id,
      choice: 'approve',
    });
    const answer = entriesOf((await store.get(runId)).record, 'classify').at(-1)!;
    // (a) red when the answer is judged by its own diagnostics (which never carry the mark); (b)
    //     prints the answer's kind and stamp, and the warning.
    expect({
      kind: answer.kind,
      stamp: answer.remembered,
      warnings: reply.warnings.filter((w) => w.includes('remembered')),
    }).toEqual({
      kind: 'gate_response',
      stamp: { as: 'routes', not_remembered: 'settled_by_default' },
      warnings: ["Step 'classify' remembered nothing in 'routes': it took its default answer."],
    });
  });
});

describe('gap 3 (1a), check 7 — each key part', () => {
  const NOT: Array<[string, unknown, string, string]> = [
    ['absent', undefined, 'key_absent', 'was not there'],
    ['null', null, 'key_null', 'was null'],
    ['""', '', 'key_empty', 'was empty'],
    ['"  "', '  ', 'key_empty', 'was empty'],
    ['true', true, 'key_not_text', 'was not text or a number'],
    ['{}', {}, 'key_not_text', 'was not text or a number'],
    ['a mask marker', 'sent [REDACTED] back', 'key_masked', 'was a masked value'],
  ];
  for (const [label, value, reason, words] of NOT) {
    it(`${label} → ${reason}, and the reply's warning names the part`, async () => {
      const { stored, reply } = await runOffer(offerWorkflow(), keyed(value));
      // (a) red when this reason's condition is removed (the part is kept, or another reason
      //     fires); (b) prints the stamp and the warning.
      expect({
        stamp: lastOf(stored, 'record_offer').remembered,
        warned: reply.warnings.filter((w) => w.includes('remembered nothing')),
      }).toEqual({
        stamp: { as: 'offers', not_remembered: reason, key_name: 'customer_email' },
        warned: [
          `Step 'record_offer' remembered nothing in 'offers': its key 'customer_email' ${words}.`,
        ],
      });
    });
  }

  const KEPT: Array<[unknown, string]> = [
    [42, '42'],
    [1.5, '1.5'],
    ['A@Example.test', 'A@Example.test'],
  ];
  for (const [value, text] of KEPT) {
    it(`${JSON.stringify(value)} is kept as ${JSON.stringify(text)}`, async () => {
      const { stored } = await runOffer(offerWorkflow(), keyed(value));
      // (a) red when a number is not kept as its decimal text, or a text is trimmed or case-folded;
      //     (b) prints the key.
      expect((lastOf(stored, 'record_offer').remembered as { key?: unknown }).key).toEqual({
        customer_email: text,
      });
    });
  }

  it('two parts: the first failing part is named, in the order written', async () => {
    const remember = `    remember:
      as: offers
      key:
        customer_email: context.resources.normalize_email.email
        region: context.resources.normalize_email.region
        tier: context.resources.normalize_email.tier
      keep_days: 90
`;
    const { stored } = await runOffer(
      offerWorkflow(remember),
      registryOf(() => ({ data: { email: 'a@example.test', tier: null } })),
    );
    // (a) red when the parts are checked out of their written order; (b) prints the stamp.
    expect(lastOf(stored, 'record_offer').remembered).toEqual({
      as: 'offers',
      not_remembered: 'key_absent',
      key_name: 'region',
    });
  });
});

describe('gap 3 (1a), check 8 — the value', () => {
  it("no value: the stamp holds no value (the entry's own output is the value: no copy)", async () => {
    const remember = REMEMBER.replace(
      '      value: { rung: context.resources.record_offer.rung }\n',
      '',
    );
    const { stored } = await runOffer(offerWorkflow(remember), keyed('a@example.test'));
    const entry = lastOf(stored, 'record_offer');
    // (a) red when the output is copied into the stamp; (b) prints the stamp.
    expect(entry.remembered).toEqual({
      as: 'offers',
      key: { customer_email: 'a@example.test' },
      expires_at: expiryOf(entry, 90),
    });
  });

  it('a declared value with an absent leaf leaves it out; a $literal and a nested map are kept', async () => {
    const remember = REMEMBER.replace(
      '      value: { rung: context.resources.record_offer.rung }\n',
      '      value:\n        rung: context.resources.record_offer.rung\n        missing: context.resources.record_offer.nothing\n        source: { $literal: offer-desk }\n        about: { email: context.resources.normalize_email.email, gone: run.params.nope }\n',
    );
    const { stored } = await runOffer(offerWorkflow(remember), keyed('a@example.test'));
    // (a) red when an absent leaf is kept (as undefined: strict equality sees it) or a nested map is
    //     dropped; (b) prints it.
    expect((lastOf(stored, 'record_offer').remembered as { value?: unknown }).value).toStrictEqual({
      rung: 2,
      source: 'offer-desk',
      about: { email: 'a@example.test' },
    });
  });

  const BIG = 'x'.repeat(32_768);
  it('a declared value over 32,768 bytes → value_too_large', async () => {
    const registry = registryOf(
      () => ({ data: { email: 'a@example.test' } }),
      () => ({ data: { rung: BIG } }),
    );
    const { stored, reply } = await runOffer(offerWorkflow(), registry);
    // (a) red when the size is not checked; (b) prints the stamp and the warning.
    expect({
      stamp: lastOf(stored, 'record_offer').remembered,
      warned: reply.warnings.filter((w) => w.includes('remembered nothing')),
    }).toEqual({
      stamp: { as: 'offers', not_remembered: 'value_too_large' },
      warned: [
        "Step 'record_offer' remembered nothing in 'offers': what it would remember was over 32 KB.",
      ],
    });
  });

  it('a whole output over 32,768 bytes (no value:) → value_too_large', async () => {
    const remember = REMEMBER.replace(
      '      value: { rung: context.resources.record_offer.rung }\n',
      '',
    );
    const registry = registryOf(
      () => ({ data: { email: 'a@example.test' } }),
      () => ({ data: { rung: BIG } }),
    );
    const { stored } = await runOffer(offerWorkflow(remember), registry);
    // (a) red when the size is checked on the declared value only; (b) prints the stamp.
    expect(lastOf(stored, 'record_offer').remembered).toEqual({
      as: 'offers',
      not_remembered: 'value_too_large',
    });
  });

  it('a value of exactly 32,768 bytes is kept (the bound is "over")', async () => {
    // `{"rung":"…"}` is 11 bytes around the text.
    const registry = registryOf(
      () => ({ data: { email: 'a@example.test' } }),
      () => ({ data: { rung: 'x'.repeat(32_768 - 11) } }),
    );
    const { stored } = await runOffer(offerWorkflow(), registry);
    // (a) red when the bound is `>=`; (b) prints the stamp's keys.
    expect(Object.keys(lastOf(stored, 'record_offer').remembered ?? {})).toEqual([
      'as',
      'key',
      'value',
      'expires_at',
    ]);
  });
});

/** The offer case built without the loader, with `remember` as given. */
function unloaded(remember: unknown): WorkflowDefinition {
  return {
    id: 'offers-unloaded',
    name: 'Offers',
    version: 1,
    steps: {
      normalize_email: {
        description: 'Normalise.',
        execution: 'auto',
        handler: 'norm',
        depends_on: [],
      },
      record_offer: {
        description: 'Record.',
        execution: 'auto',
        handler: 'offer',
        depends_on: ['normalize_email'],
        remember: remember as never,
      },
    },
  } as WorkflowDefinition;
}

describe('gap 3 (1a), check 9 — the stamp is total', () => {
  it("a value with an unknown $ directive (no loader): paths_unreadable, and the step's result is written", async () => {
    const { stored, reply } = await runOffer(
      unloaded({
        as: 'offers',
        key: { customer_email: 'context.resources.normalize_email.email' },
        value: { rung: { $unknown: 'context.resources.record_offer.rung' } },
        keep_days: 90,
      }),
      keyed('a@example.test'),
    );
    // (a) red when the resolver's throw escapes (the write fails); (b) prints the outcome.
    expect({
      status: reply.status,
      completed: stored.completed_steps,
      stamp: lastOf(stored, 'record_offer').remembered,
    }).toEqual({
      status: 'ok',
      completed: ['normalize_email', 'record_offer'],
      stamp: { as: 'offers', not_remembered: 'paths_unreadable' },
    });
  });

  it('a block the schema refuses (keep_days missing, no loader): no stamp, and the write succeeds', async () => {
    const { stored, reply } = await runOffer(
      unloaded({
        as: 'offers',
        key: { customer_email: 'context.resources.normalize_email.email' },
      }),
      keyed('a@example.test'),
    );
    // (a) red when the stamp does not re-check the block (an Invalid Date throws, or a stamp with
    //     no expiry is written); (b) prints the outcome.
    expect({
      status: reply.status,
      completed: stored.completed_steps,
      stamped: 'remembered' in lastOf(stored, 'record_offer'),
    }).toEqual({ status: 'ok', completed: ['normalize_email', 'record_offer'], stamped: false });
  });

  it('a block the schema refuses that would still stamp (keep_days 0, no loader): no stamp', async () => {
    const { stored, reply } = await runOffer(
      unloaded({
        as: 'offers',
        key: { customer_email: 'context.resources.normalize_email.email' },
        keep_days: 0,
      }),
      keyed('a@example.test'),
    );
    // (a) red when the stamp does not re-check the block with the schema (a stamp expiring at its
    //     own write is kept); (b) prints the outcome.
    expect({
      status: reply.status,
      stamped: 'remembered' in lastOf(stored, 'record_offer'),
    }).toEqual({ status: 'ok', stamped: false });
  });
});
