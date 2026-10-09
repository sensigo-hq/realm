// holder-proof-625.test.ts — issue #625 (the holder slice, PR-H): the PROOF half. The claim's own
// token is handed out on the reply that opened a question (ONE door), passed back with the answer,
// judged INSIDE the answer's write, and reported on the reply and the record. It never decides the
// answer: the answer is decided by the gate id alone.
//
// Through the REAL engine and a REAL JsonFileStore. Each assertion carries (a) the change that turns
// it red and (b) what it prints on failure — synthetic ids and tokens only, never a credential.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileStore } from '../store/json-file-store.js';
import { declareReleaseLine } from '../release-line.js';
import {
  buildNextActions,
  executeChain,
  executeStep,
  submitHumanResponse,
} from './execution-loop.js';
import type { StepDispatcher } from './execution-loop.js';
import { applySettlement } from './settlement.js';
import { classifyRunHealth } from './run-health.js';
import type { Attributed } from './holder.js';
import type { RunStore, CreateRunOptions } from '../store/store-interface.js';
import type { RunRecord } from '../types/run-record.js';
import type { ResponseEnvelope } from '../types/response-envelope.js';
import type { StepDefinition, WorkflowDefinition } from '../types/workflow-definition.js';

const echo: StepDispatcher = async (_step, input) => ({ ...input });
const PROGRAM: Attributed = { by: 'alice@host', by_source: 'derived', channel: 'agent' };

let dir: string;
let store: JsonFileStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'realm-holder-proof-625-'));
  store = new JsonFileStore(dir);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

type GateConfig = NonNullable<StepDefinition['gate']>;

/** gate `confirm` → agent step `finish`. */
function gateWorkflow(
  gate: Partial<GateConfig> = {},
  more: Record<string, StepDefinition> = {},
): WorkflowDefinition {
  return {
    id: 'holder-proof-wf',
    name: 'holder proof',
    version: 1,
    steps: {
      confirm: {
        description: 'Confirm',
        execution: 'auto',
        trust: 'human_confirmed',
        depends_on: [],
        gate: { choices: ['approve', 'reject'], ...gate },
      },
      finish: { description: 'Finish', execution: 'agent', depends_on: ['confirm'] },
      ...more,
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
  reply: ResponseEnvelope;
  afterExpiry: Date;
}

/** Opens the gate on `confirm`, taken by `driver`. */
async function open(
  s: RunStore,
  def: WorkflowDefinition,
  driver: Attributed | undefined = PROGRAM,
): Promise<Opened> {
  const { run } = await s.create({ workflowId: def.id, workflowVersion: 1, params: {} });
  const reply = await executeStep(s, def, {
    runId: run.id,
    command: 'confirm',
    input: {},
    dispatcher: echo,
    ...(driver !== undefined ? { driver } : {}),
  });
  if (reply.status !== 'confirm_required')
    throw new Error(`fixture: gate not open (${reply.status})`);
  const gate = (await s.get(run.id)).pending_gate!;
  return {
    runId: run.id,
    gateId: gate.gate_id,
    token: reply.gate!.claim_token ?? '',
    reply,
    afterExpiry:
      gate.expires_at !== undefined
        ? new Date(new Date(gate.expires_at).getTime() + 60_000)
        : new Date(),
  };
}

const entryOf = (run: RunRecord) => run.evidence.filter((e) => e.kind === 'gate_response');
const occurrences = (haystack: unknown, needle: string): number =>
  JSON.stringify(haystack).split(needle).length - 1;

/** A store that does NOT declare `settleStep` — the legacy two-write shape. */
class LegacyStore implements RunStore {
  // issue #620 PR-C: a test double declares this realm's release line.
  static {
    declareReleaseLine(this);
  }
  readonly persistsClaims: boolean;
  readonly persistedRunRecordFields: JsonFileStore['persistedRunRecordFields'];
  constructor(
    private readonly inner: JsonFileStore,
    opts: { persistsClaims?: boolean; stripToken?: boolean } = {},
  ) {
    this.persistsClaims = opts.persistsClaims ?? true;
    this.persistedRunRecordFields = inner.persistedRunRecordFields;
    this.stripToken = opts.stripToken ?? false;
  }
  private readonly stripToken: boolean;
  create(o: CreateRunOptions) {
    return this.inner.create(o);
  }
  get(id: string) {
    return this.inner.get(id);
  }
  update(r: RunRecord) {
    return this.inner.update(r);
  }
  list(w?: string) {
    return this.inner.list(w);
  }
  async claimStep(
    runId: string,
    stepName: string,
    definition: WorkflowDefinition,
    claimant?: Attributed,
  ) {
    const claimed = await this.inner.claimStep(runId, stepName, definition, claimant);
    if (!this.stripToken) return claimed;
    const claim = claimed.claims?.[stepName];
    if (claim === undefined) return claimed;
    const { token: _t, ...rest } = claim;
    return { ...claimed, claims: { ...claimed.claims, [stepName]: rest } };
  }
}

/** The same JsonFileStore, declaring it keeps no claims. */
function storeKeepingNoClaims(): JsonFileStore {
  const s = new JsonFileStore(dir);
  Object.defineProperty(s, 'persistsClaims', { value: false });
  return s;
}

// ---------------------------------------------------------------------------------------------
// ONE door
// ---------------------------------------------------------------------------------------------

describe('CLAIM_TOKEN_ONE_DOOR — the token leaves the engine on the opening reply and nowhere else', () => {
  it('the fresh gate-opening reply carries it in EXACTLY three places: gate.claim_token and both instruction renderings', async () => {
    const opened = await open(store, gateWorkflow());
    const claimToken = (await store.get(opened.runId)).claims!['confirm']!.token!;
    // (a) red when the token is not handed out, or is not the claim's own; (b) prints both.
    expect(opened.reply.gate!.claim_token).toBe(claimToken);
    const instruction = opened.reply.next_actions[0]!.instruction!;
    expect(instruction.params['claim_token']).toBe(claimToken);
    expect(instruction.call_with!['claim_token']).toBe(claimToken);
    // (a) red when a fourth place (a hint, a context sentence, the orientation) repeats it.
    expect(occurrences(opened.reply, claimToken)).toBe(3);
  });

  it('the human_readable sentence tells the caller to pass it back — only when the reply carries a token', async () => {
    const opened = await open(store, gateWorkflow());
    expect(opened.reply.next_actions[0]!.human_readable).toContain(
      'then call submit_human_response with call_with, passing claim_token back unchanged — it shows that this answer comes from the conversation that opened the question.',
    );
    // A store that minted no token: no key, no sentence — never a promise the reply cannot keep.
    const bare = new LegacyStore(
      new JsonFileStore(await mkdtemp(join(tmpdir(), 'realm-holder-bare-'))),
      {
        stripToken: true,
      },
    );
    const reply = (await open(bare, gateWorkflow())).reply;
    // (a) red when the sentence is unconditional; (b) prints the sentence.
    expect(reply.next_actions[0]!.human_readable).not.toContain('claim_token');
    expect(reply.gate).not.toHaveProperty('claim_token');
    expect(reply.next_actions[0]!.instruction!.call_with).not.toHaveProperty('claim_token');
  });

  it('the legacy (no settleStep) opening reply hands it out too', async () => {
    const legacy = new LegacyStore(
      new JsonFileStore(await mkdtemp(join(tmpdir(), 'realm-holder-legacy-'))),
    );
    const opened = await open(legacy, gateWorkflow());
    expect(opened.token).not.toBe('');
    expect(opened.reply.next_actions[0]!.instruction!.call_with!['claim_token']).toBe(opened.token);
  });

  it("executeChain / start_run's chained reply passes the same block through (not re-minted)", async () => {
    const def: WorkflowDefinition = {
      id: 'holder-chain-wf',
      name: 'chain',
      version: 1,
      steps: {
        prep: { description: 'Prep', execution: 'auto', depends_on: [] },
        confirm: {
          description: 'Confirm',
          execution: 'auto',
          trust: 'human_confirmed',
          depends_on: ['prep'],
          gate: { choices: ['approve', 'reject'] },
        },
      },
    };
    const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
    const reply = await executeChain(store, def, {
      runId: run.id,
      command: 'prep',
      input: {},
      dispatcher: echo,
    });
    expect(reply.status).toBe('confirm_required');
    const claimToken = (await store.get(run.id)).claims!['confirm']!.token!;
    // (a) red when the chain re-mints, drops or doubles it; (b) prints the count.
    expect(reply.gate!.claim_token).toBe(claimToken);
    expect(occurrences(reply, claimToken)).toBe(3);
  });

  it("NEGATIVE: a sibling's refused gate open (the already_open reply) names the LIVE gate and carries NO token", async () => {
    const def: WorkflowDefinition = {
      id: 'holder-two-gates',
      name: 'two gates',
      version: 1,
      steps: {
        g1: {
          description: 'G1',
          execution: 'auto',
          trust: 'human_confirmed',
          depends_on: [],
          gate: { choices: ['approve'] },
        },
        g2: {
          description: 'G2',
          execution: 'auto',
          trust: 'human_confirmed',
          depends_on: [],
          gate: { choices: ['approve'] },
        },
      },
    };
    const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
    const first = await executeStep(store, def, {
      runId: run.id,
      command: 'g1',
      input: {},
      dispatcher: echo,
    });
    const g1Token = first.gate!.claim_token!;
    const second = await executeStep(store, def, {
      runId: run.id,
      command: 'g2',
      input: {},
      dispatcher: echo,
    });
    const claims = (await store.get(run.id)).claims ?? {};
    // (a) red when the already_open arm renders a token (its own or the live gate's); (b) prints
    //     the count of each token in the reply.
    expect(occurrences(second, g1Token)).toBe(0);
    for (const c of Object.values(claims)) {
      expect(occurrences(second, c.token!)).toBe(0);
    }
  });

  it('NEGATIVE: the refused answers (gate_mismatch, choice_not_eligible, conflict, replay) and the not-eligible reply carry no token', async () => {
    const opened = await open(store, gateWorkflow());
    const replies: ResponseEnvelope[] = [];
    replies.push(
      await submitHumanResponse(store, gateWorkflow(), {
        runId: opened.runId,
        gateId: 'no-such-gate',
        choice: 'approve',
      }),
    );
    replies.push(
      await submitHumanResponse(store, gateWorkflow(), {
        runId: opened.runId,
        gateId: opened.gateId,
        choice: 'bogus',
      }),
    );
    replies.push(
      await executeStep(store, gateWorkflow(), {
        runId: opened.runId,
        command: 'finish',
        input: {},
        dispatcher: echo,
      }),
    );
    replies.push(
      await executeStep(store, gateWorkflow(), {
        runId: opened.runId,
        command: 'confirm',
        input: {},
        dispatcher: echo,
      }),
    );
    await submitHumanResponse(store, gateWorkflow(), {
      runId: opened.runId,
      gateId: opened.gateId,
      choice: 'approve',
    });
    replies.push(
      await submitHumanResponse(store, gateWorkflow(), {
        runId: opened.runId,
        gateId: opened.gateId,
        choice: 'reject',
      }),
    );
    for (const r of replies) {
      // (a) red when any of these surfaces repeats the claim's token; (b) prints the reply's status.
      expect([r.status, occurrences(r, opened.token)]).toEqual([r.status, 0]);
    }
  });

  it('NEGATIVE: next actions built from the record, run-health findings and the settlement result carry no token', async () => {
    const def = gateWorkflow();
    const opened = await open(store, def);
    const run = await store.get(opened.runId);
    expect(occurrences(buildNextActions(def, run, undefined, new Date()), opened.token)).toBe(0);
    expect(occurrences(classifyRunHealth(run), opened.token)).toBe(0);
    // The settlement result of the answer itself: its `gateClaim` copies holder and since — never
    // the token (the transform's own output, observed through the store).
    const result = await store.settleStep!(
      opened.runId,
      {
        kind: 'settle_gate',
        gateId: opened.gateId,
        choice: 'approve',
        claimToken: opened.token,
        evidence: [],
      },
      def,
    );
    expect(result.applied).toBe(true);
    // (a) red when gateClaim.claim is built by spreading the claim; (b) prints the occurrences.
    expect(occurrences(result.gateClaim, opened.token)).toBe(0);
    expect(result.gateClaim).toEqual({
      proof: 'matched',
      claim: { holder: PROGRAM, since: expect.any(String) },
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Judged inside the answer's write: the six rows, on the record AND the reply
// ---------------------------------------------------------------------------------------------

describe("the proof is judged in the answer's write — one verdict on the record, the reply and the sentence", () => {
  const ABSENT_SENTENCE =
    'No claim_token was passed; the answer was recorded. Only the conversation that opened the question has one to pass.';

  async function answer(
    s: RunStore,
    def: WorkflowDefinition,
    o: Opened,
    claimToken: string | undefined,
    choice = 'approve',
  ) {
    const reply = await submitHumanResponse(s, def, {
      runId: o.runId,
      gateId: o.gateId,
      choice,
      ...(claimToken !== undefined ? { claimToken } : {}),
    });
    const run = await s.get(o.runId);
    return { reply, run, entry: entryOf(run) };
  }

  it('matched: the entry records it, the reply reports it with the opener, and adds NO sentence', async () => {
    const def = gateWorkflow();
    const o = await open(store, def);
    const { reply, entry } = await answer(store, def, o, o.token);
    // (a) red when a matching token is judged otherwise (mutant a's twin); (b) prints the object.
    expect(reply.gate_claim).toEqual({ proof: 'matched', opened_by: PROGRAM });
    expect(entry.map((e) => e.claim_proof)).toEqual([{ proof: 'matched' }]);
    expect(reply.warnings).toEqual([]);
  });

  it('absent: no token passed ⇒ absent on the record and the reply, with the ONE sentence — and the answer is still recorded', async () => {
    const def = gateWorkflow();
    const o = await open(store, def);
    const { reply, run, entry } = await answer(store, def, o, undefined);
    expect(reply.status).toBe('ok');
    expect(reply.gate_claim).toEqual({ proof: 'absent', opened_by: PROGRAM });
    // (a) red when the sentence is reworded, split over two warnings, or says the answer failed.
    expect(reply.warnings).toEqual([ABSENT_SENTENCE]);
    expect(entry.map((e) => e.claim_proof)).toEqual([{ proof: 'absent' }]);
    expect(run.settled?.['confirm']?.choice).toBe('approve');
  });

  it('mismatch (a wrong token, and the EMPTY string): recorded as mismatch, answer recorded, never "another program took over"', async () => {
    for (const wrong of ['not-the-token', '']) {
      const sub = new JsonFileStore(await mkdtemp(join(tmpdir(), 'realm-holder-mm-')));
      const def = gateWorkflow();
      const o = await open(sub, def);
      const { reply, entry, run } = await answer(sub, def, o, wrong);
      // (a) red when '' is treated as "not passed", or a wrong token refuses/changes the answer;
      //     (b) prints the wrong value and the verdict.
      expect([wrong, reply.gate_claim?.proof]).toEqual([wrong, 'mismatch']);
      expect(reply.status).toBe('ok');
      expect(reply.warnings).toEqual([
        "The claim_token passed is not this question's; the answer was recorded.",
      ]);
      expect(entry.map((e) => e.claim_proof)).toEqual([{ proof: 'mismatch' }]);
      expect(run.settled?.['confirm']?.choice).toBe('approve');
    }
  });

  it("unverifiable / no_claim: the gate step's claim is gone from the record", async () => {
    const def = gateWorkflow();
    const o = await open(store, def);
    const planted = await store.get(o.runId);
    const { confirm: _gone, ...rest } = planted.claims!;
    await store.update({ ...planted, claims: rest });
    const { reply, entry } = await answer(store, def, o, undefined);
    // (a) red when absent≡absent turns this into `matched` (mutant b); (b) prints the verdict.
    expect(reply.gate_claim).toEqual({
      proof: 'unverifiable',
      cause: 'no_claim',
      opened_by: { by: null, absent_cause: 'no_claim' },
    });
    expect(reply.warnings).toEqual([
      'There is no claim to check a claim_token against — the gate step has no claim on this record; the answer was recorded.',
    ]);
    expect(entry.map((e) => e.claim_proof)).toEqual([{ proof: 'unverifiable', cause: 'no_claim' }]);
  });

  it('unverifiable / claim_has_no_token (a planted claim without a token) — and the holder still shows', async () => {
    const def = gateWorkflow();
    const o = await open(store, def);
    const planted = await store.get(o.runId);
    const claim = planted.claims!['confirm']!;
    await store.update({
      ...planted,
      claims: { confirm: { deadline: claim.deadline, since: claim.since!, holder: PROGRAM } },
    });
    const { reply, entry } = await answer(store, def, o, undefined);
    expect(reply.gate_claim).toEqual({
      proof: 'unverifiable',
      cause: 'claim_has_no_token',
      opened_by: PROGRAM,
    });
    expect(reply.warnings).toEqual([
      "This question's claim carries no token, so the claim_token could not be checked; the answer was recorded.",
    ]);
    expect(entry.map((e) => e.claim_proof)).toEqual([
      { proof: 'unverifiable', cause: 'claim_has_no_token' },
    ]);
  });

  it('unverifiable / store_keeps_no_claims: record and reply AGREE on the cause (the transform mints it once)', async () => {
    const noClaims = storeKeepingNoClaims();
    const def = gateWorkflow();
    const o = await open(noClaims, def);
    // On this store the gate step's claim exists on disk (the fixture is a real JsonFileStore), so
    // remove it as a store that keeps none would never have written it.
    const planted = await noClaims.get(o.runId);
    const { confirm: _gone, ...rest } = planted.claims!;
    await noClaims.update({ ...planted, claims: rest });
    const { reply, entry } = await answer(noClaims, def, o, undefined);
    // (a) red when the engine refines the cause differently from the record (or either side takes
    //     `no_claim`); (b) prints both causes.
    expect(reply.gate_claim?.cause).toBe('store_keeps_no_claims');
    expect(entry[0]!.claim_proof).toEqual({
      proof: 'unverifiable',
      cause: 'store_keeps_no_claims',
    });
    expect(reply.gate_claim?.opened_by).toEqual({
      by: null,
      absent_cause: 'store_keeps_no_claims',
    });
    expect(reply.warnings).toEqual([
      'This store keeps no claims, so a claim_token cannot be checked; the answer was recorded.',
    ]);
  });

  it("spent: a replay of the same answer ⇒ spent/answered, the opener read off the gate step's entry; a sentence only with a token", async () => {
    const def = gateWorkflow();
    const o = await open(store, def);
    await answer(store, def, o, o.token);
    const withToken = await answer(store, def, o, o.token);
    // (a) red when row 0 is not first (the claim is gone, so row 1 would say `no_claim`); (b)
    //     prints the verdict.
    expect(withToken.reply.gate_claim).toEqual({
      proof: 'spent',
      cause: 'answered',
      opened_by: PROGRAM,
    });
    expect(withToken.reply.warnings).toEqual([
      'The claim_token could not be checked: this question was already settled by an earlier answer.',
    ]);
    const noToken = await answer(store, def, o, undefined);
    expect(noToken.reply.gate_claim?.proof).toBe('spent');
    expect(noToken.reply.warnings).toEqual([]);
    // The replay writes nothing: still ONE answer entry, with the first verdict.
    expect(noToken.entry.map((e) => e.claim_proof)).toEqual([{ proof: 'matched' }]);
  });

  it('the answer path adds at most ONE warning for the proof, in every verdict', async () => {
    for (const token of [undefined, 'wrong', '']) {
      const sub = new JsonFileStore(await mkdtemp(join(tmpdir(), 'realm-holder-one-')));
      const def = gateWorkflow();
      const o = await open(sub, def);
      const { reply } = await answer(sub, def, o, token);
      expect(reply.warnings.length).toBeLessThanOrEqual(1);
    }
  });

  it("gate_claim has NO `since` key on any ok reply (the question's own time is pending_gate.opened_at)", async () => {
    const def = gateWorkflow();
    const o = await open(store, def);
    const { reply } = await answer(store, def, o, o.token);
    expect(Object.keys(reply.gate_claim!)).toEqual(['proof', 'opened_by']);
  });
});

describe("GATE_PROOF_NEVER_GATES_THE_ANSWER — the record differs only in the answer entry's claim_proof", () => {
  it("for every verdict the transform can mint, applySettlement's record equals the token-less one except claim_proof", async () => {
    const def = gateWorkflow();
    const o = await open(store, def);
    const fresh = await store.get(o.runId);
    const now = new Date();
    const entryTemplate = fresh.evidence.find((e) => e.step_id === 'confirm')!;
    const evidence = [{ ...entryTemplate, kind: 'gate_response' as const }];
    const run = (claimToken: string | undefined, f = fresh, keeps = true) =>
      applySettlement(
        f,
        {
          kind: 'settle_gate',
          gateId: o.gateId,
          choice: 'approve',
          evidence,
          ...(claimToken !== undefined ? { claimToken } : {}),
        },
        def,
        { now, storeKeepsClaims: keeps },
      );
    const baseline = run(undefined);
    expect(baseline.applied).toBe(true);
    const stripProof = (r: RunRecord) => ({
      ...r,
      evidence: r.evidence.map((e) => {
        const { claim_proof: _p, ...rest } = e;
        return rest;
      }),
    });
    const noClaim = (() => {
      const { confirm: _c, ...rest } = fresh.claims!;
      return { ...fresh, claims: rest };
    })();
    const noToken = (() => {
      const c = fresh.claims!['confirm']!;
      return { ...fresh, claims: { confirm: { deadline: c.deadline } } };
    })();
    const scenarios: Array<[string, ReturnType<typeof run>]> = [
      ['matched', run(o.token)],
      ['absent', run(undefined)],
      ['mismatch', run('not-the-token')],
      ['mismatch (empty)', run('')],
      ['unverifiable/no_claim', run(undefined, noClaim)],
      ['unverifiable/claim_has_no_token', run(undefined, noToken)],
      ['unverifiable/store_keeps_no_claims', run(undefined, noClaim, false)],
    ];
    for (const [label, result] of scenarios) {
      // (a) red when ANY verdict changes the answer's outcome (a "refuse on mismatch" build);
      //     (b) prints the label.
      expect([label, result.applied]).toEqual([label, true]);
      if (!result.applied || !baseline.applied) continue;
      // The claim differs between scenarios only where the scenario planted it; compare the parts
      // a verdict could possibly touch.
      expect([label, stripProof(result.run).completed_steps]).toEqual([
        label,
        baseline.run.completed_steps,
      ]);
      expect([label, result.run.settled]).toEqual([label, baseline.run.settled]);
      expect([label, result.run.pending_gate]).toEqual([label, baseline.run.pending_gate]);
      expect([label, result.run.terminal_state]).toEqual([label, baseline.run.terminal_state]);
      expect([label, result.run.skipped_steps]).toEqual([label, baseline.run.skipped_steps]);
      const proofs = result.run.evidence
        .filter((e) => e.kind === 'gate_response')
        .map((e) => e.claim_proof);
      expect([label, proofs.length]).toEqual([label, 1]);
    }
    // Same fresh record + same token-less delta, different claim token ⇒ equal outside claim_proof.
    const a = run(o.token);
    const b = run(undefined);
    if (a.applied && b.applied) {
      expect(stripProof(a.run)).toEqual(stripProof(b.run));
    }
  });
});

describe('the verdict survives the guard cascade (mutant d)', () => {
  it("a guard after the gate settles in the answer's write — and the reply still carries gate_claim", async () => {
    const def = gateWorkflow(
      {},
      {
        check: {
          description: 'Check',
          execution: 'guard',
          depends_on: ['confirm'],
          abort_unless: ["confirm.choice == 'approve'"],
        },
      },
    );
    const o = await open(store, def);
    const reply = await submitHumanResponse(store, def, {
      runId: o.runId,
      gateId: o.gateId,
      choice: 'approve',
      claimToken: o.token,
    });
    // (a) red when settleEligibleGuards rebuilds the result from four fields and drops
    //     `gateClaim`; (b) prints both.
    expect(reply.guards).toEqual([{ step: 'check', outcome: 'pass' }]);
    expect(reply.gate_claim).toEqual({ proof: 'matched', opened_by: PROGRAM });
    expect(entryOf(await store.get(o.runId)).map((e) => e.claim_proof)).toEqual([
      { proof: 'matched' },
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// The late path: the gate expired before the answer arrived
// ---------------------------------------------------------------------------------------------

describe("a late answer — the verdict stands when the call's own expiry write applies", () => {
  it('same-choice late answer (ok, answer_recorded false): the verdict earned when the gate id matched, the sentence says "not recorded"', async () => {
    const def = gateWorkflow(EXPIRING);
    const o = await open(store, def);
    const reply = await submitHumanResponse(store, def, {
      runId: o.runId,
      gateId: o.gateId,
      choice: 'approve',
      claimToken: 'not-the-token',
      now: o.afterExpiry,
    });
    expect(reply.status).toBe('ok');
    expect(reply.answer_recorded).toBe(false);
    // (a) red when the refusal's verdict is dropped on the late path, or the consequence clause
    //     says "recorded"; (b) prints both.
    expect(reply.gate_claim).toEqual({ proof: 'mismatch', opened_by: PROGRAM });
    // Issue #625, PR-H review correction C6: the answer was not recorded ⇒ the token fact alone
    // (the expiry's own sentence and `answer_recorded` already say "not recorded").
    expect(reply.warnings).toContain("The claim_token passed is not this question's.");
    // The expiry's own entry is the one on the record; it carries NO claim_proof (the late
    // answer's verdict is on the reply only — #598).
    const entries = entryOf(await store.get(o.runId));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.claim_proof).toBeUndefined();
    expect(entries[0]!.responded_by).toBe('timeout');
  });

  it('C6: a late answer with NO token: the expiry sentence and `No claim_token was passed.`, nothing that reads as if a token would have helped', async () => {
    const def = gateWorkflow(EXPIRING);
    const o = await open(store, def);
    const reply = await submitHumanResponse(store, def, {
      runId: o.runId,
      gateId: o.gateId,
      choice: 'approve',
      now: o.afterExpiry,
    });
    expect(reply.status).toBe('ok');
    expect(reply.answer_recorded).toBe(false);
    // (a) red when the gate-claim sentence repeats "not recorded" or keeps "Only the conversation
    //     that opened the question has one to pass."; (b) prints the warnings.
    expect(reply.warnings).toEqual([
      `gate '${o.gateId}' on 'confirm' had expired 1m before this call — this submitHumanResponse call first carried out its declared settle_default: the default choice 'approve' was recorded (enacted_via: submitHumanResponse).`,
      'No claim_token was passed.',
    ]);
    expect(reply.warnings.some((w) => w.includes('Only the conversation'))).toBe(false);
  });

  it('a late answer that matches carries gate_claim matched and no sentence', async () => {
    const def = gateWorkflow(EXPIRING);
    const o = await open(store, def);
    const reply = await submitHumanResponse(store, def, {
      runId: o.runId,
      gateId: o.gateId,
      choice: 'approve',
      claimToken: o.token,
      now: o.afterExpiry,
    });
    expect(reply.gate_claim).toEqual({ proof: 'matched', opened_by: PROGRAM });
  });

  it('a late answer whose expiry write finds the question ALREADY settled by the clock ⇒ spent/expired', async () => {
    const def = gateWorkflow(EXPIRING);
    const o = await open(store, def);
    const enacted = await store.settleStep!(
      o.runId,
      { kind: 'expire_gate', gateId: o.gateId },
      def,
      {
        now: o.afterExpiry,
      },
    );
    expect(enacted.applied).toBe(true);
    const reply = await submitHumanResponse(store, def, {
      runId: o.runId,
      gateId: o.gateId,
      choice: 'approve',
      claimToken: o.token,
    });
    // (a) red when row 0 reads the cause from anything but the settled entry's `resolved_by`;
    //     (b) prints the verdict.
    expect(reply.gate_claim).toEqual({ proof: 'spent', cause: 'expired', opened_by: PROGRAM });
    expect(reply.warnings).toContain(
      'The claim_token could not be checked: this question was already settled by its expiry.',
    );
    expect(reply.answer_recorded).toBe(false);
  });

  it('a REFUSED late answer (a different choice than the expiry enacted) carries NO gate_claim', async () => {
    const def = gateWorkflow(EXPIRING);
    const o = await open(store, def);
    const reply = await submitHumanResponse(store, def, {
      runId: o.runId,
      gateId: o.gateId,
      choice: 'reject',
      claimToken: o.token,
      now: o.afterExpiry,
    });
    expect(reply.status).toBe('error');
    // (a) red when a refused reply carries the verdict; (b) prints the key.
    expect(reply).not.toHaveProperty('gate_claim');
  });
});

describe('refused answers carry no gate_claim', () => {
  it.each([
    ['an unknown gate id', (_o: Opened) => ({ gateId: 'no-such-gate', choice: 'approve' })],
    ['a choice outside the menu', (o: Opened) => ({ gateId: o.gateId, choice: 'bogus' })],
  ])('%s', async (_label, args) => {
    const def = gateWorkflow();
    const o = await open(store, def);
    const reply = await submitHumanResponse(store, def, {
      runId: o.runId,
      ...args(o),
      claimToken: o.token,
    });
    expect(reply.status).toBe('error');
    expect(reply).not.toHaveProperty('gate_claim');
  });

  it('the conflict (a different choice after the question was settled)', async () => {
    const def = gateWorkflow();
    const o = await open(store, def);
    await submitHumanResponse(store, def, { runId: o.runId, gateId: o.gateId, choice: 'approve' });
    const reply = await submitHumanResponse(store, def, {
      runId: o.runId,
      gateId: o.gateId,
      choice: 'reject',
      claimToken: o.token,
    });
    expect(reply.status).toBe('error');
    expect(reply).not.toHaveProperty('gate_claim');
  });
});

// ---------------------------------------------------------------------------------------------
// The store without settleStep: the engine judges ONCE
// ---------------------------------------------------------------------------------------------

describe('a store without settleStep — one verdict serves the record, the ok reply and the expiry replies', () => {
  function legacy(opts?: { persistsClaims?: boolean }) {
    return new LegacyStore(new JsonFileStore(dir), opts);
  }

  it('matched / absent / mismatch on the record and the reply', async () => {
    for (const [token, proof] of [
      ['TOKEN', 'matched'],
      [undefined, 'absent'],
      ['wrong', 'mismatch'],
    ] as const) {
      const s = legacy();
      const def = gateWorkflow();
      const o = await open(s, def);
      const reply = await submitHumanResponse(s, def, {
        runId: o.runId,
        gateId: o.gateId,
        choice: 'approve',
        ...(token === 'TOKEN'
          ? { claimToken: o.token }
          : token !== undefined
            ? { claimToken: token }
            : {}),
      });
      const run = await s.get(o.runId);
      // (a) red when the legacy path skips the judgement or stamps a different verdict than the
      //     reply carries; (b) prints both.
      expect([proof, reply.gate_claim?.proof]).toEqual([proof, proof]);
      expect([proof, entryOf(run).map((e) => e.claim_proof?.proof)]).toEqual([proof, [proof]]);
    }
  });

  it('persistsClaims false ⇒ store_keeps_no_claims on the record AND the reply (claim removed)', async () => {
    const s = legacy({ persistsClaims: false });
    const def = gateWorkflow();
    const o = await open(s, def);
    const planted = await s.get(o.runId);
    const { confirm: _c, ...rest } = planted.claims!;
    await s.update({ ...planted, claims: rest });
    const reply = await submitHumanResponse(s, def, {
      runId: o.runId,
      gateId: o.gateId,
      choice: 'approve',
    });
    expect(reply.gate_claim?.cause).toBe('store_keeps_no_claims');
    expect(entryOf(await s.get(o.runId))[0]!.claim_proof).toEqual({
      proof: 'unverifiable',
      cause: 'store_keeps_no_claims',
    });
  });

  it('the late path on this store carries the one verdict (ok reply) and none on the refused one', async () => {
    const s = legacy();
    const def = gateWorkflow(EXPIRING);
    const o = await open(s, def);
    const reply = await submitHumanResponse(s, def, {
      runId: o.runId,
      gateId: o.gateId,
      choice: 'approve',
      claimToken: o.token,
      now: o.afterExpiry,
    });
    expect(reply.status).toBe('ok');
    expect(reply.gate_claim?.proof).toBe('matched');
  });
});
