// refused-answer-625.test.ts — issue #625 PR-2a, round 16 (the scoped walk on the merged head):
// - decision C117 (W3-R1): the view's clock is required — a wrong gate id on an expired question
//   offers `advance_run` and says its time is up, never the answer (which could not be recorded);
// - decision C118 (W1-Y2): a refused answer names the open question (its step and gate id) — or says
//   its time is up — or that none is open. #729 PR-0: the refusal (`gate_not_open`, the open gate,
//   its remedy) is the reply's data — the doors word it — and its action word is fixed:
//   `report_to_user` (D-8 row 6; DESIGN-D3 §6 — was C94's list-derived routing);
// - decision C122 (W3-Y1): the late answer's line is C105's — this call carried the expiry out, or
//   another call had (a program's own `submitHumanResponse` names itself since decision C151);
// - decision C124 (W3-Y3): `advanceRun`'s caller names itself, on the reply and on the line;
// - decision C125 (W1-Y1): the answer act outside the opening reply says where the question's text is
//   (#729 PR-0: the MCP door's words, pinned in mcp-server's render-reply.test.ts; core pins the
//   record's field and the respond way's presentation).
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  advanceRun,
  executeStep,
  expiryCarriedOutLine,
  submitHumanResponse,
  type AdvanceCaller,
  type EnactedVia,
} from './execution-loop.js';
import { ENTRY_CALLERS } from './callers.js';
import { describePending } from './pending.js';
import { agentActionFor, nextCalls, owedOf } from '../test-support/ways-view.js';
import type { EngineReply } from '../types/response-envelope.js';

/**
 * A refused answer's own verdict (#729 PR-0, D-A): its code, the open gate it names (whether it is
 * the run's, and its step), and its remedies' verbs — what the doors' words for it are made from.
 */
function refusalOf(reply: EngineReply, openGateId?: string) {
  const r = reply.refusal;
  if (r === undefined || r.code !== 'gate_not_open') return r?.code;
  return {
    code: r.code,
    open_gate:
      r.facts.open_gate === undefined
        ? undefined
        : [r.facts.open_gate.gate_id === openGateId, r.facts.open_gate.step],
    remedy: r.remedy.map((w) => w.verb),
  };
}
import { JsonFileStore } from '../store/json-file-store.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
import { writeTestClockFile } from '../store/test-clock-file.js';
import { writtenSnapshot } from './snapshot.js';
import { zOf } from '../test-support/instant.js';

/** #715 (b) (01 §C.4): the store's clock decides what is due — a JSON store on a test location: its
 *  runs folder sits beside the location's clock file (first set to the host's reading), which
 *  `setClockOf` rewrites. */
async function testLocationRuns(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  await writeTestClockFile(root, new Date());
  return join(root, 'runs');
}
async function clockedJsonStore(prefix: string): Promise<JsonFileStore> {
  return new JsonFileStore(await testLocationRuns(prefix));
}
async function setClockOf(store: object, t: Date): Promise<void> {
  const runsDir = (store as { runsDirPath?: string }).runsDirPath;
  if (runsDir === undefined) throw new Error('setClockOf: this store is not a JSON store');
  await writeTestClockFile(dirname(runsDir), t);
}

/** `q` (a question, 60 s, `on_expiry` as given, a message), then `after` (`auto`; a precondition that never holds when `stuck`). */
function gated(
  onExpiry: 'settle_default' | 'abort' | undefined,
  stuck = false,
): WorkflowDefinition {
  return {
    id: `ra-${onExpiry ?? 'none'}${stuck ? '-stuck' : ''}`,
    name: 'refused answer',
    version: 1,
    steps: {
      q: {
        description: 'Ask.',
        execution: 'auto',
        trust: 'human_confirmed',
        depends_on: [],
        gate: {
          message: 'Go ahead?',
          choices: ['approve', 'reject'],
          timeout_seconds: 60,
          ...(onExpiry !== undefined ? { on_expiry: onExpiry } : {}),
          ...(onExpiry === 'settle_default' ? { default_choice: 'approve' } : {}),
        },
      },
      after: {
        description: 'After.',
        execution: 'auto',
        depends_on: ['q'],
        ...(stuck ? { preconditions: ["run.params.mode == 'live'"] } : {}),
      },
    },
  };
}

describe('#625 PR-2a, C117/C118/C122/C124/C125 — the clock required, the refused answer, who carried it out', () => {
  let store: JsonFileStore;
  beforeEach(async () => {
    store = await clockedJsonStore('realm-ra-625-');
  });

  async function atQuestion(d: WorkflowDefinition) {
    const { record: run } = await store.create({
      workflowId: d.id,
      workflowVersion: 1,
      params: {},
    });
    const opened = await executeStep(store, d, {
      runId: run.id,
      command: 'q',
      input: {},
      dispatcher: async () => ({}),
    });
    if (opened.status !== 'confirm_required') throw new Error(`fixture: ${opened.status}`);
    const gate = (await store.get(run.id)).record.pending_gate!;
    const past = new Date(new Date(gate.expires_at!).getTime() + 5_000);
    return { runId: run.id, gateId: gate.gate_id, past };
  }

  it('C117, C118: a wrong gate id on an EXPIRED question offers advance_run and says its time is up — resolve_precondition, on the one store kind (#715 (b))', async () => {
    const d = gated('settle_default');
    // #715 (b): the legacy store kind (no `settleStep`) is gone — one kind left.
    for (const legacy of [false]) {
      const { runId, gateId, past } = await atQuestion(d);
      await setClockOf(store, past);
      const reply = await submitHumanResponse(store, d, {
        runId,
        gateId: 'not-the-gate',
        choice: 'reject',
      });
      const first = legacy
        ? `Gate ID mismatch on run '${runId}'.`
        : "Gate 'not-the-gate' is not the open gate and matches no committed resolution.";
      // (a) red when the refusal's view has no clock (it offers the answer), routes to report_to_user
      // with something to call, or the hint does not say the time is up; (b) prints the reply.
      expect({
        legacy,
        status: reply.status,
        agent_action: agentActionFor(reply),
        next: nextCalls(reply),
        owed: owedOf(reply),
        hint: reply.context_hint,
        refusal: refusalOf(reply, gateId),
        remedy: reply.error?.remedy.map((w) => w.verb),
      }).toEqual({
        legacy,
        status: 'error',
        agent_action: 'report_to_user',
        next: ['advance'],
        owed: [`expiry:${gateId}`],
        hint: first,
        refusal: { code: 'gate_not_open', open_gate: [true, 'q'], remedy: ['advance'] },
        remedy: ['advance'],
      });
      expect(
        describePending(d, writtenSnapshot((await store.get(runId)).record, past), undefined).owed
          .length,
      ).toBe(1);
      // (a) red when the refusal carried the expiry out itself; (b) prints the gate.
      expect((await store.get(runId)).record.pending_gate?.gate_id).toBe(gateId);
    }
  });

  it('C117 CONTROL: the same wrong gate id on an open question whose time is not up offers its answer — the question named, on the one store kind (#715 (b))', async () => {
    const d = gated('settle_default');
    // #715 (b): the legacy store kind (no `settleStep`) is gone — one kind left.
    for (const legacy of [false]) {
      const { runId, gateId } = await atQuestion(d);
      const reply = await submitHumanResponse(store, d, {
        runId,
        gateId: 'not-the-gate',
        choice: 'reject',
      });
      const first = legacy
        ? `Gate ID mismatch on run '${runId}'.`
        : "Gate 'not-the-gate' is not the open gate and matches no committed resolution.";
      // (a) red when an unexpired question offers advance_run, the answer is missing, or the routing
      // is not C94's; (b) prints the reply.
      const respond = reply.ways.find((w) => w.verb === 'respond');
      expect({
        legacy,
        agent_action: agentActionFor(reply),
        next: nextCalls(reply),
        answer:
          respond?.verb === 'respond'
            ? [respond.gate_id === gateId, respond.step, respond.choice.one_of, respond.proof]
            : undefined,
        hint: reply.context_hint,
        refusal: refusalOf(reply, gateId),
      }).toEqual({
        legacy,
        agent_action: 'report_to_user',
        next: ['respond'],
        answer: [true, 'q', ['approve', 'reject'], undefined],
        hint: first,
        refusal: { code: 'gate_not_open', open_gate: [true, 'q'], remedy: ['respond'] },
      });
    }
  });

  it('C118: a wrong gate id when no question is open — the refusal names no open gate; report_to_user (D-8 row 6), with or without work to call', async () => {
    for (const [stuck, agentAction, tools] of [
      [false, 'report_to_user', ['advance']],
      [true, 'report_to_user', []],
    ] as const) {
      const d = gated(undefined, stuck);
      const { runId, gateId } = await atQuestion(d);
      const answered = await submitHumanResponse(store, d, { runId, gateId, choice: 'approve' });
      expect(answered.status).toBe('ok');
      const reply = await submitHumanResponse(store, d, {
        runId,
        gateId: 'not-the-gate',
        choice: 'approve',
      });
      // (a) red when the routing ignores next_actions (C94's rule), or the hint names a question that
      // is not open; (b) prints the reply.
      expect({
        stuck,
        agent_action: agentActionFor(reply),
        next: nextCalls(reply),
        hint: reply.context_hint,
        refusal: refusalOf(reply),
      }).toEqual({
        stuck,
        agent_action: agentAction,
        next: [...tools],
        hint: "Gate 'not-the-gate' is not the open gate and matches no committed resolution.",
        refusal: { code: 'gate_not_open', open_gate: undefined, remedy: ['inspect'] },
      });
    }
  });

  it("C122 + F1: the late answer's line is C105's — this call carried the expiry out, naming itself (settle_default, both choices; abort), and how long before this call the question expired (5s), on both store kinds", async () => {
    // #715 (b): the legacy store kind (no `settleStep`) is gone — one kind left.
    for (const legacy of [false]) {
      for (const [onExpiry, choice] of [
        ['settle_default', 'approve'],
        ['settle_default', 'reject'],
        ['abort', 'approve'],
      ] as const) {
        const d = gated(onExpiry);
        const { runId, gateId, past } = await atQuestion(d);
        await setClockOf(store, past);
        const reply = await submitHumanResponse(store, d, {
          runId,
          gateId,
          choice,
        });
        const line =
          onExpiry === 'settle_default'
            ? `gate '${gateId}' on 'q' had expired 5s before this call (deadline ${zOf(reply.expiry!.expired_at)}) — this submitHumanResponse call first carried out its declared settle_default: the default choice 'approve' was recorded (enacted_via: submitHumanResponse).`
            : `gate '${gateId}' on 'q' had expired 5s before this call (deadline ${zOf(reply.expiry!.expired_at)}) — this submitHumanResponse call first carried out its declared abort: the run ended (enacted_via: submitHumanResponse).`;
        // (a) red when the line drops the lag (F1), says "expired 0m ago", or is not the composer's;
        // (b) prints the warnings.
        expect({ legacy, onExpiry, choice, warnings: reply.warnings.slice(0, 1) }).toEqual({
          legacy,
          onExpiry,
          choice,
          warnings: [line],
        });
        expect(reply.answer_recorded).toBe(false);
        // F1 (reverses C122's "no lag" pin): the lag is said, in seconds under a minute — never `0m`.
        // (a) red when the line drops the lag or rounds it to minutes; (b) prints the warnings.
        expect(reply.warnings.join(' ')).toMatch(/had expired 5s before this call/);
        expect(reply.warnings.join(' ')).not.toMatch(/\b0m\b/);
      }
    }
  });

  it('C122 (#715 (b)): a late answer to a question another call had already expired is not recorded, and never says "this call" carried it out', async () => {
    const d = gated('settle_default');
    const { runId, gateId, past } = await atQuestion(d);
    await setClockOf(store, past);
    // Another call carries the expiry out first — the write `realm run drain --expired --force`, the
    // timer and the sweeper make. #715 (b): the answer's write sees the question settled; there is no
    // longer a window between a refusal and a second write for another call to win (one write).
    const enacted = await store.settleStep(runId, { kind: 'expire_gate', gateId }, d);
    expect(enacted.applied).toBe(true);
    const reply = await submitHumanResponse(store, d, { runId, gateId, choice: 'reject' });
    // (a) red when the answer is recorded, or the reply claims this call carried the expiry out;
    //     (b) prints the reply's sentences.
    expect(reply.answer_recorded).toBe(false);
    expect(reply.errors.join(' ')).toContain(
      "was settled by timeout with choice 'approve' — your choice 'reject' was not recorded",
    );
    expect(reply.warnings.join(' ')).not.toMatch(/this submitHumanResponse call first carried out/);
  });

  it('C124: advanceRun names its caller — the library default advanceRun, advance_run, advance — on the reply and on the line', async () => {
    for (const caller of [undefined, 'advance_run', 'advance'] as const) {
      const d = gated('settle_default');
      const { runId, gateId, past } = await atQuestion(d);
      await setClockOf(store, past);
      const reply = await advanceRun(store, d, {
        runId,
        ...(caller !== undefined ? { caller } : {}),
      });
      const named: AdvanceCaller = caller ?? 'advanceRun';
      // (a) red when the library default is not advanceRun, or a caller's word is not used on both;
      // (b) prints the reply's command and line.
      expect({ caller, command: reply.command, line: reply.warnings[0] }).toEqual({
        caller,
        command: named,
        line: `gate '${gateId}' on 'q' had expired 5s before this call (deadline ${zOf(reply.expiry!.expired_at)}) — this ${named} call first carried out its declared settle_default: the default choice 'approve' was recorded (enacted_via: ${named}).`,
      });
    }
  });

  it("C124: expiryCarriedOutLine, every member of enacted_via's vocabulary — the call each word names; another call's line", () => {
    // decision C151: each word is the call it names — the library functions, the MCP tools, the CLI
    // commands — and `timer`; every entry's callers are members.
    const members: Array<[EnactedVia, string]> = [
      ['advanceRun', 'advanceRun'],
      ['advance_run', 'advance_run'],
      ['advance', 'advance'],
      ['start_run', 'start_run'],
      ['agent', 'agent'],
      ['executeStep', 'executeStep'],
      ['executeEngineStep', 'executeEngineStep'],
      ['executeChain', 'executeChain'],
      ['execute_step', 'execute_step'],
      ['run', 'run'],
      ['submitHumanResponse', 'submitHumanResponse'],
      ['submit_human_response', 'submit_human_response'],
      ['respond', 'respond'],
      ['timer', 'timer'],
    ];
    // (a) red when an entry gains a caller this list does not hold; (b) prints both sets.
    expect(new Set([...Object.values(ENTRY_CALLERS).flat(), 'timer'])).toEqual(
      new Set(members.map(([via]) => via)),
    );
    for (const [via, call] of members) {
      // (a) red when a member names the wrong call or drops enacted_via; (b) prints the line.
      expect(expiryCarriedOutLine('g1', 's', { on_expiry: 'abort' }, via, { ms: 15_000 })).toBe(
        `gate 'g1' on 's' had expired 15s before this call — this ${call} call first carried out its declared abort: the run ended (enacted_via: ${via}).`,
      );
    }
    // #715 (b) (Amendment 3): the race form ("another call had already carried out …") is deleted
    // with `byThisCall` — no call reports another call's expiry any more.
  });

  it("C125: the record keeps the question's text where the answer's words point; the answer outside the opening reply is presented alone (the MCP words: render-reply.test.ts)", async () => {
    const d = gated(undefined);
    const { runId } = await atQuestion(d);
    // (a) red when the record does not keep the gate's message where the pointer says; (b) prints it.
    expect((await store.get(runId)).record.pending_gate?.resolved_message).toBe('Go ahead?');
    // (a) red when a reply that did not open the question presents its answer with the gate (the
    //     door's words would then point at gate.display, which this reply has not); (b) prints it.
    const later = await advanceRun(store, d, { runId });
    const respond = later.ways.find((w) => w.verb === 'respond');
    expect(respond?.verb === 'respond' ? respond.presented : undefined).toBe('alone');
  });
});
