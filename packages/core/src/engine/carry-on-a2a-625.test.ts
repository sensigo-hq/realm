// carry-on-a2a-625.test.ts — #625 PR-2b unit A2a (prompt feat-625-a2a-carry-on.md): an answer from
// the conversation that opened the question carries the run on, within a budget. D-8's six rows, the
// continuation, the one merge, the budget, the token, the recorded answerer and the disclosure set.
//
// Through the REAL engine and a REAL InMemoryStore on a settable clock. Synthetic ids, tokens and
// fakes only. Each assertion carries the two questions of `~/.claude/TESTING-RULES.md` rule 8: (a) the
// change that turns it red; (b) what it prints when it fails.
import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryStore, settableClock, type SettableClock } from '@sensigo/realm-testing';
import { executeStep, submitHumanResponse } from './execution-loop.js';
import { proofOf } from '../test-support/ways-view.js';
import type { StepDispatcher, SubmitGateOptions } from './execution-loop.js';
import { judgeCarryOn, NOT_CARRIED_ON_REASONS, type Attributed } from './holder.js';
import { ExtensionRegistry } from '../extensions/registry.js';
import { createDefaultRegistry } from '../extensions/default-registry.js';
import { WorkflowError } from '../types/workflow-error.js';
import { buildDisclosureSet } from '../utils/redaction.js';
import type { ExtensionIdentityEntry } from '../types/extension-identity.js';
import type { RunStore } from '../store/store-interface.js';
import type { EngineReply } from '../types/response-envelope.js';
import type { StepDefinition, WorkflowDefinition } from '../types/workflow-definition.js';
import type {
  StepContext,
  StepHandler,
  StepHandlerInputs,
  StepHandlerResult,
} from '../extensions/step-handler.js';

const echo: StepDispatcher = async (_step, input) => ({ ...input });
/** The program that opened the question. */
const OPENER: Attributed = { by: 'alice@host', by_source: 'derived', channel: 'agent' };
/** The program the answer's call runs in. */
const HOST: Attributed = { by: 'mcp-host', by_source: 'stated', channel: 'mcp-stdio' };

/** D-8's consequence, and the sentences that end with it (holder.ts, `composeGateClaimSentence`). */
const C = 'The run was not carried on in this call.';
const CODE_C =
  'The run was not carried on in this call; its owed steps run with the code of the program that runs them.';

let clock: SettableClock;
let store: InMemoryStore;
beforeEach(() => {
  clock = settableClock(new Date());
  store = new InMemoryStore({ clock });
});

/** A handler that always throws: a chained step that fails. */
class FailingHandler implements StepHandler {
  readonly id = 'always_fail';
  async execute(_inputs: StepHandlerInputs, _ctx: StepContext): Promise<StepHandlerResult> {
    throw new WorkflowError('Handler deliberately failed', {
      code: 'ENGINE_HANDLER_FAILED',
      category: 'ENGINE',
      agentAction: 'stop',
      retryable: false,
    });
  }
}

type GateConfig = NonNullable<StepDefinition['gate']>;

/** gate `confirm`, then the steps given (default: `a`, `b` auto, then agent step `finish`). */
function wf(
  after: Record<string, StepDefinition> = {
    a: { description: 'A', execution: 'auto', depends_on: ['confirm'] },
    b: { description: 'B', execution: 'auto', depends_on: ['a'] },
    finish: { description: 'Finish', execution: 'agent', depends_on: ['b'] },
  },
  gate: Partial<GateConfig> = {},
): WorkflowDefinition {
  return {
    id: 'carry-on-a2a',
    name: 'carry on',
    version: 1,
    steps: {
      confirm: {
        description: 'Confirm',
        execution: 'auto',
        trust: 'human_confirmed',
        depends_on: [],
        gate: { choices: ['approve', 'reject'], ...gate },
      },
      ...after,
    },
  };
}

const EXPIRING: Partial<GateConfig> = {
  timeout_seconds: 1,
  on_expiry: 'settle_default',
  default_choice: 'approve',
};

interface Opened {
  runId: string;
  gateId: string;
  token: string;
  afterExpiry: Date;
}

/** Opens the gate on `confirm`, taken by OPENER, with `registry` (its code identity recorded). */
async function open(
  s: RunStore,
  def: WorkflowDefinition,
  opts: { registry?: ExtensionRegistry; params?: Record<string, unknown> } = {},
): Promise<Opened> {
  const { record: run } = await s.create({
    workflowId: def.id,
    workflowVersion: 1,
    params: opts.params ?? {},
  });
  const reply = await executeStep(s, def, {
    runId: run.id,
    command: 'confirm',
    input: {},
    dispatcher: echo,
    driver: OPENER,
    ...(opts.registry !== undefined ? { registry: opts.registry } : {}),
  });
  if (reply.status !== 'confirm_required') throw new Error(`fixture: ${reply.status}`);
  const gate = (await s.get(run.id)).record.pending_gate!;
  return {
    runId: run.id,
    gateId: gate.gate_id,
    token: proofOf(reply) ?? '',
    afterExpiry: new Date(new Date(gate.expires_at ?? Date.now()).getTime() + 60_000),
  };
}

/** What a cell changes about the answer: a value replaces the default, `undefined` leaves it out. */
type Over = { [K in keyof SubmitGateOptions]?: SubmitGateOptions[K] | undefined } & {
  noRegistry?: true;
};

/** Answers `confirm` with the options given; default: the token, a registry, the HOST driver. */
async function answer(def: WorkflowDefinition, o: Opened, over: Over = {}): Promise<EngineReply> {
  const { noRegistry, ...rest } = over;
  const options: Record<string, unknown> = {
    runId: o.runId,
    gateId: o.gateId,
    choice: 'approve',
    claimToken: o.token,
    driver: HOST,
    ...(noRegistry === true ? {} : { registry: createDefaultRegistry() }),
  };
  for (const [key, value] of Object.entries(rest)) {
    if (value === undefined) delete options[key];
    else options[key] = value;
  }
  return submitHumanResponse(store, def, options as unknown as SubmitGateOptions);
}

const completed = async (runId: string) => (await store.get(runId)).record.completed_steps;
const reason = (r: EngineReply) => r.gate_claim?.not_carried_on_because;
const advanceOwed = (r: EngineReply): string[] =>
  r.ways
    .filter((w) => w.verb === 'advance')
    .flatMap((w) => (w as unknown as { owed?: readonly ({ step: string } | object)[] }).owed ?? [])
    .flatMap((o) => ('step' in o ? [o.step] : []));

/** A code identity, as the CLI records it; `tree_hash` tells two programs' code apart. */
function identity(treeHash: string): ExtensionIdentityEntry {
  return {
    captured_at: '2026-11-21T00:00:00.000Z',
    modules: [{ declared: 'x', resolved: '/x', entry_hash: 'h', format: 'esm' }],
    tree: {
      roots: ['/proj'],
      rules: 'dir_tree_v1: test',
      file_count: 1,
      total_bytes: 1,
      tree_hash: treeHash,
      truncated: false,
    },
    coverage: 'dir_tree_v1',
  } as ExtensionIdentityEntry;
}
function registryWith(treeHash: string | undefined): ExtensionRegistry {
  const registry = createDefaultRegistry();
  if (treeHash !== undefined) registry.setIdentity(identity(treeHash));
  return registry;
}

// ---------------------------------------------------------------------------------------------
// Check 1 — D-8's rows, through the engine: one producing cell per reason, one per conjunct of row 6
// ---------------------------------------------------------------------------------------------

describe('#625 PR-2b A2a check 1 — D-8, row by row, through the engine', () => {
  it('row 6: the token passed back, a registry, the same code (none recorded, none here) — carried on', async () => {
    const def = wf();
    const o = await open(store, def);
    const reply = await answer(def, o);
    // (a) red when any row stops a call that meets none of them; (b) prints the claim and the steps.
    expect({ claim: reply.gate_claim?.carried_on, done: await completed(o.runId) }).toEqual({
      claim: true,
      done: ['confirm', 'a', 'b'],
    });
  });

  it('row 6 with a recorded code identity: this program records the same — carried on', async () => {
    const def = wf();
    const o = await open(store, def, { registry: registryWith('T1') });
    const reply = await answer(def, o, { registry: registryWith('T1') });
    // (a) red when `same` stops the call (the fit misread); (b) prints the claim.
    expect(reply.gate_claim?.carried_on).toBe(true);
  });

  it('row 1 (nothing_runnable): only an agent step follows — no sentence of its own', async () => {
    const def = wf({ finish: { description: 'F', execution: 'agent', depends_on: ['confirm'] } });
    const o = await open(store, def);
    const reply = await answer(def, o);
    // (a) red when the row is dropped or a later row comes first; (b) prints the reason and warnings.
    expect({ because: reason(reply), warnings: reply.warnings }).toEqual({
      because: 'nothing_runnable',
      warnings: [],
    });
  });

  it('row 2 (not_settled_by_this_call): a replay after the answer left steps owed — with a token, the spent sentence then C; with none, C alone', async () => {
    const def = wf();
    const o = await open(store, def);
    await answer(def, o, { claimToken: undefined });
    const withToken = await answer(def, o);
    const noToken = await answer(def, o, { claimToken: undefined });
    // (a) red when the row is dropped (the replay would carry the run on) or its sentences change;
    //     (b) prints both reasons, both warnings and the steps done.
    expect({
      because: [reason(withToken), reason(noToken)],
      warnings: [withToken.warnings, noToken.warnings],
      done: await completed(o.runId),
    }).toEqual({
      because: ['not_settled_by_this_call', 'not_settled_by_this_call'],
      warnings: [
        [
          `The claim_token could not be checked: this question was already settled by an earlier answer. ${C}`,
        ],
        [C],
      ],
      done: ['confirm'],
    });
  });

  it('row 3 (proof_absent): no token passed — the verdict sentence then C, and the steps stay owed', async () => {
    const def = wf();
    const o = await open(store, def);
    const reply = await answer(def, o, { claimToken: undefined });
    // (a) red when an absent proof carries on, or C is split off into a second warning; (b) prints
    //     the reason, the warnings, the steps done and the owed.
    expect({
      because: reason(reply),
      warnings: reply.warnings,
      done: await completed(o.runId),
      owed: advanceOwed(reply),
    }).toEqual({
      because: 'proof_absent',
      warnings: [
        `No claim_token was passed; the answer was recorded. Only the conversation that opened the question has one to pass. ${C}`,
      ],
      done: ['confirm'],
      owed: ['a'],
    });
  });

  it('row 3 (proof_mismatch): another token — the verdict sentence then C', async () => {
    const def = wf();
    const o = await open(store, def);
    const reply = await answer(def, o, { claimToken: 'not-the-token' });
    // (a) red when a wrong token carries on; (b) prints the reason and the warnings.
    expect({ because: reason(reply), warnings: reply.warnings }).toEqual({
      because: 'proof_mismatch',
      warnings: [`The claim_token passed is not this question's; the answer was recorded. ${C}`],
    });
  });

  it('row 3 (proof_unverifiable): the claim is gone from the record — the verdict sentence then C', async () => {
    const def = wf();
    const o = await open(store, def);
    const { record } = await store.get(o.runId);
    const { confirm: _gone, ...claims } = record.claims ?? {};
    await store.update({ ...record, claims });
    const reply = await answer(def, o);
    // (a) red when an unverifiable proof carries on; (b) prints the reason and the warnings.
    expect({ because: reason(reply), warnings: reply.warnings }).toEqual({
      because: 'proof_unverifiable',
      warnings: [
        `There is no claim to check a claim_token against — the gate step has no claim on this record; the answer was recorded. ${C}`,
      ],
    });
  });

  it('row 3 on a store that keeps no claims (correction 1): a passed-back token cannot be checked, so the run is not carried on', async () => {
    const def = wf();
    const noClaims = new InMemoryStore({ clock });
    Object.defineProperty(noClaims, 'persistsClaims', { value: false });
    const o = await open(noClaims, def);
    // The fixture is a real InMemoryStore, which writes the gate step's claim: remove it, as a store
    // that keeps none would never have written it (holder-proof-625's store_keeps_no_claims cell).
    const { record: planted } = await noClaims.get(o.runId);
    const { confirm: _gone, ...claims } = planted.claims ?? {};
    await noClaims.update({ ...planted, claims });
    const reply = await submitHumanResponse(noClaims, def, {
      runId: o.runId,
      gateId: o.gateId,
      choice: 'approve',
      claimToken: 'a-token-passed-back',
      driver: HOST,
      registry: createDefaultRegistry(),
    });
    // (a) red when a store with no claims carries the run on (the proof read as matched); (b) prints
    //     the verdict, the reason and the steps done.
    expect({
      proof: [reply.gate_claim?.proof, reply.gate_claim?.cause],
      because: reason(reply),
      done: (await noClaims.get(o.runId)).record.completed_steps,
    }).toEqual({
      proof: ['unverifiable', 'store_keeps_no_claims'],
      because: 'proof_unverifiable',
      done: ['confirm'],
    });
  });

  it('row 4 (no_registry): the token matches, the call has no step registry', async () => {
    const def = wf();
    const o = await open(store, def);
    const reply = await answer(def, o, { noRegistry: true });
    // (a) red when a call with no registry carries on; (b) prints the reason and the warnings.
    expect({ because: reason(reply), warnings: reply.warnings }).toEqual({
      because: 'no_registry',
      warnings: [`This call has no step registry. ${C}`],
    });
  });

  it('row 5 (extensions_differ): this program records other code than the run last ran with', async () => {
    const def = wf();
    const o = await open(store, def, { registry: registryWith('T1') });
    const reply = await answer(def, o, { registry: registryWith('T2') });
    // (a) red when differing code carries on; (b) prints the reason, the warnings and the steps done.
    expect({
      because: reason(reply),
      warnings: reply.warnings,
      done: await completed(o.runId),
    }).toEqual({
      because: 'extensions_differ',
      warnings: [`This server's code is not the code the run last ran with. ${CODE_C}`],
      done: ['confirm'],
    });
  });

  it('row 5 (extensions_not_comparable): the run recorded code, this program records none', async () => {
    const def = wf();
    const o = await open(store, def, { registry: registryWith('T1') });
    const reply = await answer(def, o, { registry: registryWith(undefined) });
    // (a) red when code that cannot be compared carries on; (b) prints the reason and the warnings.
    expect({ because: reason(reply), warnings: reply.warnings }).toEqual({
      because: 'extensions_not_comparable',
      warnings: [
        `This server's code cannot be compared with the code the run last ran with. ${CODE_C}`,
      ],
    });
  });

  it('NOT_CARRIED_ON_REASONS lists D-8 in its order — each member has its producing cell above', () => {
    // (a) red when a member is added, dropped or moved without its row; (b) prints the list.
    expect(NOT_CARRIED_ON_REASONS).toEqual([
      'nothing_runnable',
      'not_settled_by_this_call',
      'proof_absent',
      'proof_mismatch',
      'proof_unverifiable',
      'no_registry',
      'extensions_differ',
      'extensions_not_comparable',
    ]);
  });
});

describe('#625 PR-2b A2a check 1 — D-8, the order: where two rows apply, the earlier one names the reason', () => {
  const carried = { owed: true, proof: 'matched', registry: true, fit: 'same' } as const;
  it.each([
    ['1∧2', { ...carried, owed: false, proof: 'spent' }, 'nothing_runnable'],
    ['1∧3', { ...carried, owed: false, proof: 'absent' }, 'nothing_runnable'],
    [
      '2∧4',
      { ...carried, proof: 'spent', registry: false, fit: undefined },
      'not_settled_by_this_call',
    ],
    ['3∧4', { ...carried, proof: 'mismatch', registry: false, fit: undefined }, 'proof_mismatch'],
    ['4∧5', { ...carried, registry: false, fit: 'differs' }, 'no_registry'],
  ] as const)('%s', (_pair, input, expected) => {
    // (a) red when the two rows are swapped in `judgeCarryOn`; (b) prints the decision.
    expect(judgeCarryOn(input)).toEqual({ carried_on: false, because: expected });
  });

  it.each([
    ['owed', { ...carried, owed: false }, 'nothing_runnable'],
    ['settled by this call', { ...carried, proof: 'spent' }, 'not_settled_by_this_call'],
    ['proof matched (absent)', { ...carried, proof: 'absent' }, 'proof_absent'],
    ['proof matched (mismatch)', { ...carried, proof: 'mismatch' }, 'proof_mismatch'],
    ['proof matched (unverifiable)', { ...carried, proof: 'unverifiable' }, 'proof_unverifiable'],
    ['a registry', { ...carried, registry: false, fit: undefined }, 'no_registry'],
    ['the code fits (differs)', { ...carried, fit: 'differs' }, 'extensions_differ'],
    [
      'the code fits (not comparable)',
      { ...carried, fit: 'not_comparable' },
      'extensions_not_comparable',
    ],
  ] as const)('row 6, one conjunct false: %s', (_conjunct, input, expected) => {
    // (a) red when that conjunct no longer stops the call; (b) prints the decision.
    expect(judgeCarryOn(input)).toEqual({ carried_on: false, because: expected });
  });

  it('row 6: every conjunct true — the same code, or none on either side', () => {
    // (a) red when `same` or `none` stops the call; (b) prints both decisions.
    expect([judgeCarryOn(carried), judgeCarryOn({ ...carried, fit: 'none' })]).toEqual([
      { carried_on: true },
      { carried_on: true },
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// Check 2 — carried on: the owed steps run in the one call
// ---------------------------------------------------------------------------------------------

describe('#625 PR-2b A2a check 2 — carried on', () => {
  it('the owed auto steps run to the next pause in the answering call: their evidence on the record, the call’s driver, the gate step as command', async () => {
    const def = wf();
    const o = await open(store, def);
    const reply = await answer(def, o, { respondedBy: 'Ana' });
    const { record } = await store.get(o.runId);
    // (a) red when the answer does not continue (a, b not run), the reply takes the chain's
    //     `command` (`submit_human_response`), or `continued_by` is not this call's driver;
    //     (b) prints the fields.
    expect({
      status: reply.status,
      command: reply.command,
      claim: reply.gate_claim,
      chained: reply.chained_auto_steps?.map((c) => c.step),
      drivenBy: record.evidence
        .filter((e) => e.step_id === 'a' || e.step_id === 'b')
        .map((e) => [e.step_id, e.driven_by]),
      ownAct: reply.own_act,
      hint: reply.context_hint.startsWith("Gate 'confirm' resolved with choice 'approve'. "),
      next: advanceOwed(reply),
    }).toEqual({
      status: 'ok',
      command: 'confirm',
      claim: {
        proof: 'matched',
        opened_by: OPENER,
        carried_on: true,
        continued_by: HOST,
        answered_by: { by: 'Ana', by_source: 'stated' },
      },
      chained: ['a', 'b'],
      drivenBy: [
        ['a', HOST],
        ['b', HOST],
      ],
      ownAct: undefined,
      hint: true,
      next: [],
    });
  });

  it('no driver passed: `continued_by` says none was recorded', async () => {
    const def = wf();
    const o = await open(store, def);
    const reply = await answer(def, o, { driver: undefined });
    // (a) red when the absent driver is left out or named; (b) prints `continued_by`.
    expect(reply.gate_claim?.continued_by).toEqual({
      by: null,
      absent_cause: 'driver_not_recorded',
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Check 3 — the merge, on the late, same-choice arm; check 4 — the late refused arm
// ---------------------------------------------------------------------------------------------

describe('#625 PR-2b A2a checks 3 and 4 — the late answer', () => {
  const failing = (): ExtensionRegistry => {
    const registry = createDefaultRegistry();
    registry.register('handler', 'always_fail', new FailingHandler());
    return registry;
  };
  const failingWf = () =>
    wf(
      {
        a: { description: 'A', execution: 'auto', handler: 'always_fail', depends_on: ['confirm'] },
        finish: { description: 'F', execution: 'agent', depends_on: ['a'] },
      },
      EXPIRING,
    );

  it('check 3: a chained step fails — the error is the status; the answer’s facts, hint and expiry line stay; the refusal’s remedy is this reply’s', async () => {
    const def = failingWf();
    const o = await open(store, def, { registry: failing() });
    await clock.set(o.afterExpiry);
    const reply = await answer(def, o, { registry: failing() });
    const pastDeadline = reply.refusal;
    // (a) red when the chain's reply replaces the answer's (no `answer_recorded`, no `gate_claim`,
    //     the hint not opening with the same-choice sentence, the expiry line gone or after the
    //     chain's), or the refusal keeps the answer's stale remedy; (b) prints the fields.
    expect({
      status: reply.status,
      code: reply.error_code,
      stopped: reply.stopped_step,
      command: reply.command,
      recorded: reply.answer_recorded,
      carried: reply.gate_claim?.carried_on,
      hint: reply.context_hint.startsWith(
        'the outcome matches your choice, but it was settled by timeout; your response was not recorded. ',
      ),
      expiryFirst: reply.warnings[0]?.includes('carried out its declared settle_default'),
      refusal: {
        code: pastDeadline?.code,
        step: pastDeadline?.step,
        remedy: pastDeadline?.remedy,
        noRemedy: pastDeadline?.no_remedy,
      },
      advance: reply.ways.filter((w) => w.verb === 'advance'),
    }).toEqual({
      status: 'error',
      code: 'ENGINE_HANDLER_FAILED',
      stopped: 'a',
      command: 'confirm',
      recorded: false,
      carried: true,
      hint: true,
      expiryFirst: true,
      refusal: {
        code: 'question_past_deadline',
        step: 'confirm',
        remedy: [],
        noRemedy: { cause: 'already_settled' },
      },
      advance: [],
    });
  });

  it('check 3: the late arm stopped by the budget after `a` — the refusal’s remedy is this reply’s advance way (owing `b`), not the answer’s (owing `a`)', async () => {
    const def = wf(undefined, EXPIRING);
    const o = await open(store, def);
    await clock.set(o.afterExpiry);
    let reads = 0;
    const reply = await answer(def, o, {
      budget: { remainingMs: () => (reads++ === 0 ? 5_000 : 0) },
    });
    // (a) red when the remedy is the answer's own ways (judged before the chain) or `no_remedy`
    //     stays beside a remedy; (b) prints the remedy and the reply's advance ways.
    expect({
      remedy: reply.refusal?.remedy,
      noRemedy: reply.refusal?.no_remedy,
      stopped: reply.gate_claim?.chain_stopped,
    }).toEqual({
      remedy: reply.ways.filter((w) => w.verb === 'advance'),
      noRemedy: undefined,
      stopped: 'budget',
    });
    expect(reply.refusal?.remedy).toHaveLength(1);
    // (a) red when the remedy still owes `a`, which the call ran; (b) prints the owed steps.
    expect(
      (reply.refusal?.remedy ?? []).flatMap(
        (w) => (w as unknown as { owed?: { step?: string }[] }).owed?.map((x) => x.step) ?? [],
      ),
    ).toEqual(['b']);
  });

  it('check 4: a late answer whose choice the expiry did not record (STATE_BLOCKED) never carries on', async () => {
    const def = wf(undefined, EXPIRING);
    const o = await open(store, def);
    await clock.set(o.afterExpiry);
    const reply = await answer(def, o, { choice: 'reject' });
    // (a) red when a refused answer carries the run on, or gains `gate_claim`; (b) prints the fields.
    expect({
      status: reply.status,
      code: reply.error_code,
      claim: reply.gate_claim,
      done: await completed(o.runId),
      owed: advanceOwed(reply),
    }).toEqual({
      status: 'error',
      code: 'STATE_BLOCKED',
      claim: undefined,
      done: ['confirm'],
      owed: ['a'],
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Check 5 — the budget
// ---------------------------------------------------------------------------------------------

describe('#625 PR-2b A2a check 5 — the budget', () => {
  /** A budget that has `ms` left at each read, in turn (the last value repeats). */
  const reads = (...ms: number[]) => {
    let i = 0;
    return { remainingMs: () => ms[Math.min(i++, ms.length - 1)]! };
  };

  it('the time runs out after `a`: `a` runs to its end, `b` is not claimed, the reply says so and owes `b`', async () => {
    const def = wf();
    const o = await open(store, def);
    const reply = await answer(def, o, { budget: reads(5_000, 0) });
    const { record } = await store.get(o.runId);
    // (a) red when no check runs before the claim (`b` runs), a claim is left on `b`, or the reply
    //     does not say why it stopped; (b) prints the fields.
    expect({
      done: record.completed_steps,
      claimOnB: record.claims?.['b'],
      stopped: reply.gate_claim?.chain_stopped,
      carried: reply.gate_claim?.carried_on,
      owed: advanceOwed(reply),
      namesNext: reply.names_next,
      warnings: reply.warnings,
    }).toEqual({
      done: ['confirm', 'a'],
      claimOnB: undefined,
      stopped: 'budget',
      carried: true,
      owed: ['b'],
      namesNext: true,
      warnings: [
        "This call's time ran out after 'a'; the run was not carried further in this call.",
      ],
    });
  });

  it('the time is spent before any step: the sentence names the gate step, and both steps stay owed', async () => {
    const def = wf();
    const o = await open(store, def);
    const reply = await answer(def, o, { budget: reads(0) });
    // (a) red when a step starts with no time left, or the sentence names no step; (b) prints them.
    expect({
      done: await completed(o.runId),
      warnings: reply.warnings,
      owed: advanceOwed(reply),
    }).toEqual({
      done: ['confirm'],
      warnings: [
        "This call's time ran out after 'confirm'; the run was not carried further in this call.",
      ],
      owed: ['a'],
    });
  });

  it('no budget: the carry-on runs to the next pause', async () => {
    const def = wf();
    const o = await open(store, def);
    const reply = await answer(def, o);
    // (a) red when the carry-on stops with no budget given; (b) prints the steps and the claim.
    expect({ done: await completed(o.runId), stopped: reply.gate_claim?.chain_stopped }).toEqual({
      done: ['confirm', 'a', 'b'],
      stopped: undefined,
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Check 6 — the token; check 8 — the disclosure set
// ---------------------------------------------------------------------------------------------

describe('#625 PR-2b A2a checks 6 and 8 — a question the carry-on reaches', () => {
  const twoGates = (message?: string): WorkflowDefinition =>
    wf({
      a: { description: 'A', execution: 'auto', depends_on: ['confirm'] },
      review: {
        description: 'Review',
        execution: 'auto',
        trust: 'human_confirmed',
        depends_on: ['a'],
        gate: { choices: ['ship', 'hold'], ...(message !== undefined ? { message } : {}) },
      },
      finish: { description: 'F', execution: 'agent', depends_on: ['review'] },
    });

  it('check 6: handed on as an opening reply hands it on — its respond way and a fresh token, the answer’s token nowhere', async () => {
    const def = twoGates();
    const o = await open(store, def);
    const reply = await answer(def, o);
    const fresh = proofOf(reply);
    // (a) red when the answer's token is copied into the merge, or the new question loses its
    //     respond way's token; (b) prints booleans and the reply's status (tokens are synthetic).
    expect({
      status: reply.status,
      gate: reply.gate !== undefined,
      fresh: typeof fresh === 'string' && fresh.length > 0 && fresh !== o.token,
      oldTokenAnywhere: JSON.stringify(reply).includes(o.token),
      freshOnce: JSON.stringify(reply).split(fresh ?? '\u0000').length - 1,
      carried: reply.gate_claim?.carried_on,
    }).toEqual({
      status: 'confirm_required',
      gate: true,
      fresh: true,
      oldTokenAnywhere: false,
      freshOnce: 1,
      carried: true,
    });
  });

  it('check 8: the question the carry-on opens is masked with the call’s set before its filter — stored and in the reply', async () => {
    const FAKE = 'canary-declared-a2a-0123456789abcdef';
    const set = buildDisclosureSet({
      env: {},
      declared: { SECRET_X: FAKE },
      declaredState: 'resolved',
      audience: 'agent',
    }).set;
    const def = twoGates('Ship {{ run.params.token | upper }} now');
    const o = await open(store, def, { params: { token: FAKE } });
    const reply = await answer(def, o, { disclosure: set });
    const stored = (await store.get(o.runId)).record.pending_gate?.resolved_message;
    // (a) red when the call's set is not passed to the continuation (the value stored and shown in
    //     upper case); (b) prints the stored question and the reply's (the value is a fake).
    expect({ stored, shown: reply.gate?.display }).toEqual({
      stored: 'Ship [REDACTED] now',
      shown: 'Ship [REDACTED] now',
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Check 7 — the recorded answerer
// ---------------------------------------------------------------------------------------------

describe('#625 PR-2b A2a check 7 — gate_claim.answered_by', () => {
  it('on time, a replay (`spent`) and late: the name recorded, the earlier answer’s, the expiry’s', async () => {
    const def = wf({ finish: { description: 'F', execution: 'agent', depends_on: ['confirm'] } });
    const onTime = await open(store, def);
    const first = await answer(def, onTime, { respondedBy: 'Ana' });
    const replay = await answer(def, onTime, { respondedBy: 'Bob' });
    const late = await open(store, wf(undefined, EXPIRING));
    await clock.set(late.afterExpiry);
    const lateReply = await answer(wf(undefined, EXPIRING), late, { respondedBy: 'Cleo' });
    // (a) red when `answered_by` is missing on one arm, a replay names the replayer, or the expiry's
    //     entry is read as the literal `timeout`; (b) prints the three.
    expect([
      first.gate_claim?.answered_by,
      replay.gate_claim?.answered_by,
      lateReply.gate_claim?.answered_by,
    ]).toEqual([
      { by: 'Ana', by_source: 'stated' },
      { by: 'Ana', by_source: 'stated' },
      { by: null, absent_cause: 'settled_by_expiry' },
    ]);
  });
});
