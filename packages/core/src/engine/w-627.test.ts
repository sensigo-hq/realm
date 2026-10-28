// w-627.test.ts — #627 W, the core cells: §5.2's four-row narrowing (cell 23, core half), the
// conservation of the agent's removed answer (cell 30), `present` per row and per snapshot code, the
// handed-off question as a wait (D-8), the record's answer facts per caller (cell 5, library half) and
// `outcome.via` (cell 29), R25's two pieces (cells 7(b), 8), the author-text note (cell 27b, loader
// half), the settings' judges (cell 4's core, W-s8's bounds), the separation check's predicate
// (cell 26's core), and the definition absence `newer` with its readers (MA 3's W-r2 decision).
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure: codes,
// verbs, parties, texts — never a token.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  admitWay,
  agentActionOf,
  agentRenderedList,
  composeWaysOn,
  narrowForDoor,
  presentDoorVerdict,
  presentWayOfGate,
  DOOR_SERVES,
  renderDefinitionAbsent,
  LIBRARY_WORDS,
  type DoorAnswers,
  type DoorFormFacts,
  type DoorPolicy,
  type Unavailable,
  type WayOn,
  type WaysContext,
} from './ways.js';
import { writtenSnapshot } from './snapshot.js';
import { advanceRun, executeStep, submitHumanResponse } from './execution-loop.js';
import { describeRunDriver } from './pending.js';
import { answerArrivalOf, answerViaOf, principalOf } from './answer-facts.js';
import {
  judgeFormWait,
  judgeGateAnswers,
  alsoSetClause,
  FORM_WAIT_SECONDS_DEFAULT,
} from './gate-answers-setting.js';
import {
  separationGaps,
  separationModeOf,
  separationPrevents,
  type ConditionReading,
  type SeparationEvidence,
} from './separation.js';
import { JsonFileStore } from '../store/json-file-store.js';
import { unreadableFactsOf } from '../store/run-file.js';
import {
  JsonWorkflowStore,
  definitionAbsenceOf,
  getWorkflowForRun,
} from '../workflow/registrar.js';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  loadWorkflowFromString,
  loadWorkflowFromStringWithDiagnostics,
} from '../workflow/yaml-loader.js';
import {
  WorkflowError,
  newerDefinitionFactsOf,
  storedFileFactsOf,
} from '../types/workflow-error.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
import type { RunRecord } from '../types/run-record.js';

// ─── Fixtures ───────────────────────────────────────────────────────────────────────────────────

/** `q` (a gate on an auto step), then `after` (an agent step); with `timed`, a 60 s deadline. */
function gated(timed = false): WorkflowDefinition {
  return {
    id: timed ? 'g-timed' : 'g',
    name: 'g',
    version: 1,
    steps: {
      q: {
        description: 'Ask.',
        execution: 'auto',
        trust: 'human_confirmed',
        depends_on: [],
        gate: {
          choices: ['approve', 'reject'],
          ...(timed ? { timeout_seconds: 60, on_expiry: 'abort' as const } : {}),
        },
      },
      after: { description: 'After.', execution: 'agent', depends_on: ['q'] },
    },
  } as WorkflowDefinition;
}

async function newStore(): Promise<JsonFileStore> {
  return new JsonFileStore(await mkdtemp(join(tmpdir(), 'realm-w-627-')));
}

/** A run whose `q` question is open, its record, and its gate id. */
async function atGate(def: WorkflowDefinition = gated()) {
  const store = await newStore();
  const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
  await advanceRun(store, def, { runId: run.id });
  const record = await store.get(run.id);
  return { store, def, record, gateId: record.pending_gate!.gate_id };
}

const ctxOf = (definition: WorkflowDefinition): WaysContext => ({
  definition: { ok: definition },
  enactor: { kind: 'observer' },
  store: { persistsClaims: true },
});

const SRC = { kind: 'default' as const, ref: 'test' };

const answersOf = (value: DoorAnswers['value'], shown: boolean): DoorAnswers => ({
  value,
  source: SRC,
  forms: { shown, source: { kind: 'negotiated', ref: 'test' } },
});

// Correction 1 (C5a): the parties come from the MCP door's own table, so a change to it reaches cell 23.
const mcpDoor = (answers?: DoorAnswers): DoorPolicy => ({
  door: 'mcp',
  serves: [...DOOR_SERVES.mcp],
  route: 'mcp',
  source: SRC,
  ...(answers !== undefined ? { answers } : {}),
});

const LIBRARY_DOOR: DoorPolicy = {
  door: 'library',
  serves: ['agent', 'operator'],
  route: 'library',
  source: SRC,
};

const ROWS = {
  offered: answersOf('offered', true),
  asked_forms: answersOf('asked', true),
  fallback: answersOf('asked', false),
  withheld: answersOf('withheld', true),
} as const;

const NEVER: DoorFormFacts = { sent_here: 'never', came_back: 0, asks_left: 4, sent: 0 };

/** One respond way's parties and conditions, as the narrowing rendered it. */
function respondOf(ways: readonly (WayOn & { for: readonly string[] })[]) {
  const r = ways.find((w) => w.verb === 'respond');
  return r === undefined ? undefined : { for: [...r.for].sort(), conditions: r.conditions };
}

// ─── B: the four-row table (cell 23, core half) ─────────────────────────────────────────────────

describe('#627 W — narrowForDoor applies §5.2’s four-row table', () => {
  it('row by row: the agent’s respond, its `for`, the fallback condition, the door’s listing and `present`', async () => {
    const { def, record } = await atGate();
    const composed = composeWaysOn(writtenSnapshot(record, new Date()), ctxOf(def));
    const row = (answers: DoorAnswers) => {
      const n = narrowForDoor(composed, mcpDoor(answers), () => NEVER);
      return {
        respond: respondOf(n.ways),
        withheld: n.unavailable
          .filter((u) => u.code === 'door_withholds_answers')
          .map((u) => [u.verb, u.facts]),
        present: n.ways.some((w) => w.verb === 'present' && w.for.includes('agent'))
          ? 'offered'
          : n.unavailable.find((u) => u.verb === 'present')?.code,
      };
    };
    // (a) red when two rows swap (asked with forms and the fallback), a row keeps the agent where it
    //     withholds answers, the fallback loses its condition, or `present` is offered off row 2;
    //     (b) prints each row's parties, conditions, listing and `present`.
    expect({
      offered: row(ROWS.offered),
      asked_forms: row(ROWS.asked_forms),
      fallback: row(ROWS.fallback),
      withheld: row(ROWS.withheld),
    }).toEqual({
      offered: {
        respond: { for: ['agent', 'asked_person'], conditions: [] },
        withheld: [],
        present: 'no_form_here',
      },
      asked_forms: {
        respond: { for: ['asked_person'], conditions: [] },
        withheld: [['respond', { party: 'agent' }]],
        present: 'offered',
      },
      fallback: {
        respond: {
          for: ['agent', 'asked_person'],
          conditions: [{ code: 'client_prompt', tag: 'client' }],
        },
        withheld: [],
        present: 'no_form_here',
      },
      withheld: {
        respond: { for: ['asked_person'], conditions: [] },
        withheld: [['respond', { party: 'agent' }]],
        present: 'no_form_here',
      },
    });
  });

  it('correction 1 (A5): on the withholding rows the opening claim token rides nowhere in Narrowed; where the agent answers it stays on its way', async () => {
    const { def, record } = await atGate();
    const composed = composeWaysOn(writtenSnapshot(record, new Date()), {
      ...ctxOf(def),
      opening_token: 'tok-627-a5',
    });
    const carries = (answers: DoorAnswers) =>
      JSON.stringify(narrowForDoor(composed, mcpDoor(answers), () => NEVER)).includes('tok-627-a5');
    // (a) red when the strip is removed (the token rides the person's kept way and the listing's
    //     remedy on rows 2 and 4); (b) prints, per row, whether the token is anywhere in Narrowed.
    expect({
      offered: carries(ROWS.offered),
      asked_forms: carries(ROWS.asked_forms),
      fallback: carries(ROWS.fallback),
      withheld: carries(ROWS.withheld),
    }).toEqual({ offered: true, asked_forms: false, fallback: true, withheld: false });
  });

  it('the asked person’s respond never becomes door_cannot_enact, on any row', async () => {
    const { def, record } = await atGate();
    const composed = composeWaysOn(writtenSnapshot(record, new Date()), ctxOf(def));
    const cannot = Object.values(ROWS).flatMap((answers) =>
      narrowForDoor(composed, mcpDoor(answers), () => NEVER)
        .unavailable.filter((u) => u.verb === 'respond' && u.code === 'door_cannot_enact')
        .map((u) => u.code),
    );
    // (a) red when a withholding row empties the respond's `for`; (b) prints the codes.
    expect(cannot).toEqual([]);
  });

  it('a door with no answers setting narrows as PR-0 did: the agent keeps respond, no condition', async () => {
    const { def, record } = await atGate();
    const composed = composeWaysOn(writtenSnapshot(record, new Date()), ctxOf(def));
    // (a) red when a door without the setting withholds or conditions the answer; (b) prints it.
    expect(respondOf(narrowForDoor(composed, mcpDoor()).ways)).toEqual({
      for: ['agent', 'asked_person'],
      conditions: [],
    });
  });

  it('cell 30 — the conservation law: a removed agent respond nested in a remedy is listed with party agent, its remedy narrowed', () => {
    const nested: WayOn = {
      verb: 'respond',
      conditions: [],
      run_id: 'r',
      gate_id: 'g1',
      step: 'q',
      choice: { one_of: ['approve', 'reject'] },
      holds: [],
      presented: 'alone',
    } as WayOn;
    const listed: Unavailable = {
      verb: 'abandon',
      code: 'question_open',
      facts: { step: 'q', gate_id: 'g1', question_step: 'q' },
      remedy: [nested],
    } as unknown as Unavailable;
    const n = narrowForDoor(
      {
        ways: [],
        unavailable: [listed],
        basis: {} as never,
      },
      mcpDoor(ROWS.withheld),
    );
    const entry = n.unavailable.find((u) => u.code === 'door_withholds_answers');
    const remedy = n.unavailable.find((u) => u.code === 'question_open')?.remedy[0] as
      (WayOn & { for: readonly string[] }) | undefined;
    // (a) red when a respond that appears only in a remedy is not listed, keeps the agent, or its
    //     listing loses its act (the person's respond, narrowed); (b) prints the listing, its
    //     remedy's parties and the nested remedy's parties.
    expect({
      listed: entry === undefined ? undefined : [entry.verb, entry.step, entry.facts],
      listedRemedy: entry?.remedy.map((w) => [w.verb, (w as { for?: readonly string[] }).for]),
      nestedFor: remedy?.for,
    }).toEqual({
      listed: ['respond', 'q', { party: 'agent' }],
      listedRemedy: [['respond', ['asked_person']]],
      nestedFor: ['asked_person'],
    });
  });
});

// ─── B: `present` — the door's own codes and the snapshot's (Amendments 2, 5, 15) ───────────────

describe('#627 W — present: offered only on asked with forms, re-judged on the door’s facts', () => {
  it('presentDoorVerdict: no_form_here off row 2; form_open while one is open; asks_exhausted when none are left', () => {
    const v = (answers: DoorAnswers | undefined, facts?: DoorFormFacts) => {
      const r = presentDoorVerdict(answers, 'g1', facts);
      return 'offered' in r ? 'offered' : r.code;
    };
    // (a) red when the verdict ignores the row, an open form, or the asks left; (b) prints each.
    expect({
      offered: v(ROWS.offered),
      fallback: v(ROWS.fallback),
      withheld: v(ROWS.withheld),
      library: v(undefined),
      never: v(ROWS.asked_forms, NEVER),
      open: v(ROWS.asked_forms, { sent_here: 'open', came_back: 0, asks_left: 3, sent: 1 }),
      exhausted: v(ROWS.asked_forms, { sent_here: 'closed', came_back: 4, asks_left: 0, sent: 4 }),
    }).toEqual({
      offered: 'no_form_here',
      fallback: 'no_form_here',
      withheld: 'no_form_here',
      library: 'no_form_here',
      never: 'offered',
      open: 'form_open',
      exhausted: 'asks_exhausted',
    });
  });

  it('the library door lists present as unavailable no_form_here, never offered', async () => {
    const { def, record } = await atGate();
    const composed = composeWaysOn(writtenSnapshot(record, new Date()), ctxOf(def));
    const n = narrowForDoor(composed, LIBRARY_DOOR);
    // (a) red when the library door offers present; (b) prints the present entries.
    expect({
      offered: n.ways.some((w) => w.verb === 'present'),
      listed: n.unavailable.filter((u) => u.verb === 'present').map((u) => u.code),
    }).toEqual({ offered: false, listed: ['no_form_here'] });
  });

  it('LIBRARY_WORDS.present: the library door’s words for the way', () => {
    // (a) red when the table loses the arm or names a tool the library has; (b) prints the words.
    expect(
      LIBRARY_WORDS.present(presentWayOfGate('r1', 'g1') as never, undefined, {} as never),
    ).toBe(
      "the question on gate 'g1' of run 'r1' is shown again only by an MCP server whose client shows forms (present_question)",
    );
  });

  it('a call on an open question is judged on the snapshot first (admitWay → no_form_here for the door to re-judge)', async () => {
    const { def, record, gateId } = await atGate();
    const a = admitWay('present', writtenSnapshot(record, new Date()), ctxOf(def), {
      run_id: record.id,
      gate_id: gateId,
    });
    // (a) red when the composition offers present itself (the door's verdict would be skipped);
    //     (b) prints the code.
    expect('ok' in a ? 'ok' : a.code).toBe('no_form_here');
  });

  it('each snapshot code with its Amendment-15 act: settled → the progress ways; due → [advance]; ended → no_remedy; another gate, the open one not due → [inspect]; none open → [inspect]', async () => {
    // settled: the question was answered; the run goes on (its agent step is offered).
    const settled = await atGate();
    await submitHumanResponse(settled.store, settled.def, {
      runId: settled.record.id,
      gateId: settled.gateId,
      choice: 'approve',
    });
    const afterAnswer = await settled.store.get(settled.record.id);
    const s = admitWay('present', writtenSnapshot(afterAnswer, new Date()), ctxOf(settled.def), {
      run_id: afterAnswer.id,
      gate_id: settled.gateId,
    }) as Unavailable;
    // due: a timed question past its deadline.
    const timed = await atGate(gated(true));
    const late = new Date(Date.now() + 120_000);
    const d = admitWay('present', writtenSnapshot(timed.record, late), ctxOf(timed.def), {
      run_id: timed.record.id,
      gate_id: timed.gateId,
    }) as Unavailable;
    // ended: the run is terminal.
    const ended = admitWay(
      'present',
      writtenSnapshot({ ...settled.record, terminal_state: true } as RunRecord, new Date()),
      ctxOf(settled.def),
      { run_id: settled.record.id, gate_id: settled.gateId },
    ) as Unavailable;
    // another gate: a gate id that is not the open one.
    const open = await atGate();
    const other = admitWay('present', writtenSnapshot(open.record, new Date()), ctxOf(open.def), {
      run_id: open.record.id,
      gate_id: 'not-the-open-one',
    }) as Unavailable;
    // none open: the settled run, a gate id it never had.
    const none = admitWay('present', writtenSnapshot(afterAnswer, new Date()), ctxOf(settled.def), {
      run_id: afterAnswer.id,
      gate_id: 'never-opened',
    }) as Unavailable;
    // (a) red when one act serves every code (the blanket [inspect]), or present gains a
    //     question_past_deadline arm; (b) prints each code with its remedy verbs and no_remedy cause.
    const act = (u: Unavailable) => [u.code, u.remedy.map((w) => w.verb), u.no_remedy?.cause];
    expect({
      settled: act(s),
      due: act(d),
      ended: act(ended),
      other: act(other),
      none: act(none),
    }).toEqual({
      settled: ['question_settled', ['run_step'], undefined],
      due: ['question_due', ['advance'], undefined],
      ended: ['run_ended', [], 'operator_command_untyped'],
      // Correction 2 (3.4): core's door never offers `present` — another gate leads on by [inspect]
      // unless the open one is due (the C2 cell below); the MCP door shows its own `present`.
      other: ['gate_not_open', ['inspect'], undefined],
      none: ['gate_not_open', ['inspect'], undefined],
    });
  });
});

describe('#627 W correction 1 (C2) — present on another gate follows the open gate’s listed entry', () => {
  it('another gate while the open one is due → gate_not_open, led on by the due entry’s remedy', async () => {
    const timed = await atGate(gated(true));
    const late = new Date(Date.now() + 120_000);
    const other = admitWay('present', writtenSnapshot(timed.record, late), ctxOf(timed.def), {
      run_id: timed.record.id,
      gate_id: 'not-the-open-one',
    }) as Unavailable;
    // (a) red when gate_not_open always offers [present <the open gate>], due or not; (b) prints the
    //     code, the remedy verbs and the no_remedy cause.
    expect([other.code, other.remedy.map((w) => w.verb), other.no_remedy?.cause]).toEqual([
      'gate_not_open',
      ['advance'],
      undefined,
    ]);
  });
});

// ─── D-8: a question this door hands off is a wait ──────────────────────────────────────────────

describe('#627 W — a handed-off question is waited on (agent_action await)', () => {
  it('under withheld, an ok reply at an open question with nothing else callable is await; under offered it is not', async () => {
    const { def, record } = await atGate();
    const composed = composeWaysOn(writtenSnapshot(record, new Date()), ctxOf(def));
    const action = (answers: DoorAnswers) =>
      agentActionOf(
        undefined,
        'ok',
        agentRenderedList(narrowForDoor(composed, mcpDoor(answers)), false),
      );
    // (a) red when the door's withholding is read as a blocker the agent must report, or the
    //     agent's own answer is read as a wait; (b) prints both actions.
    expect({ withheld: action(ROWS.withheld), offered: action(ROWS.offered) }).toEqual({
      withheld: 'await',
      offered: undefined,
    });
  });
});

// ─── G: the record's answer facts (cell 5, library half; cell 29) ───────────────────────────────

describe('#627 W — each answer records how it arrived', () => {
  it('a library call with a route records it (and the form’s `shown`); without one, route_not_declared; a driver-less call records no program (driver_not_recorded); no principal passed reads principal_not_passed', async () => {
    const withRoute = await atGate();
    await submitHumanResponse(withRoute.store, withRoute.def, {
      runId: withRoute.record.id,
      gateId: withRoute.gateId,
      choice: 'approve',
      route: 'mcp_form',
      shown: { renderer: 'test/1' },
      driver: { by: 'tester', by_source: 'stated', channel: 'test' },
      clientPromptRequested: true,
      principal: { kind: 'api_key', id: 'key-1' },
    });
    const without = await atGate();
    await submitHumanResponse(without.store, without.def, {
      runId: without.record.id,
      gateId: without.gateId,
      choice: 'reject',
    });
    const entryOf = async (s: Awaited<ReturnType<typeof atGate>>) =>
      (await s.store.get(s.record.id)).evidence.find((e) => e.kind === 'gate_response')!;
    const a = await entryOf(withRoute);
    const b = await entryOf(without);
    // (a) red when the route parameter is dropped, an absent route is left unstated, a driver is
    //     invented, or the principal's absence is not recorded; (b) prints both entries' facts.
    expect({
      routed: [a.answer, a.driven_by, a.client_prompt_requested, a.principal],
      bare: [b.answer, 'driven_by' in b, 'client_prompt_requested' in b, b.principal],
      bareDriver: answerArrivalOf(b).recorded_by,
    }).toEqual({
      routed: [
        { route: 'mcp_form', shown: { renderer: 'test/1' } },
        { by: 'tester', by_source: 'stated', channel: 'test' },
        true,
        { kind: 'api_key', id: 'key-1' },
      ],
      bare: [{ absent: 'route_not_declared' }, false, false, { absent: 'principal_not_passed' }],
      bareDriver: { by: null, absent_cause: 'driver_not_recorded' },
    });
  });

  it('cell 5 — both write paths: a store without settleStep (the legacy inline write) records the same answer facts', async () => {
    const s = await atGate();
    const legacy = Object.create(s.store) as JsonFileStore;
    Object.defineProperty(legacy, 'settleStep', { value: undefined });
    await submitHumanResponse(legacy, s.def, {
      runId: s.record.id,
      gateId: s.gateId,
      choice: 'approve',
      route: 'cli',
      principal: { absent: 'not_a_server_door' },
      driver: { by: 'ops', by_source: 'ambient', channel: 'respond' },
      clientPromptRequested: true,
    });
    const entry = (await s.store.get(s.record.id)).evidence.find((e) => e.kind === 'gate_response');
    // (a) red when the legacy path drops a fact the migrated path writes; (b) prints the facts.
    expect([
      entry?.answer,
      entry?.principal,
      entry?.driven_by,
      entry?.client_prompt_requested,
    ]).toEqual([
      { route: 'cli' },
      { absent: 'not_a_server_door' },
      { by: 'ops', by_source: 'ambient', channel: 'respond' },
      true,
    ]);
  });

  it('cell 29 — outcome.via: a repeat answer’s reply carries the WINNING entry’s route, never the losing call’s', async () => {
    const s = await atGate();
    await submitHumanResponse(s.store, s.def, {
      runId: s.record.id,
      gateId: s.gateId,
      choice: 'approve',
      route: 'cli',
    });
    const again = await submitHumanResponse(s.store, s.def, {
      runId: s.record.id,
      gateId: s.gateId,
      choice: 'approve',
      route: 'mcp',
    });
    // (a) red when via copies the losing call's route; (b) prints the outcome's via.
    expect(again.outcome?.via).toBe('cli');
  });

  it('answerViaOf / principalOf / answerArrivalOf read every shape totally', () => {
    // (a) red when an expiry's entry, an entry with no answer, or a malformed field is read as a
    //     route, a principal or a client prompt; (b) prints each reading.
    expect({
      expiry: answerViaOf({ resolution: 'timeout_default' } as never),
      noAnswer: answerViaOf({} as never),
      garbage: answerViaOf({ answer: { route: 7 } } as never),
      declared: answerViaOf({ answer: { route: 'mcp' } } as never),
      undeclared: answerViaOf({ answer: { absent: 'route_not_declared' } } as never),
      sharedToken: principalOf({ principal: { kind: 'shared_token' } } as never),
      badKey: principalOf({ principal: { kind: 'api_key', id: '' } } as never),
      badAbsence: principalOf({ principal: { absent: 'made_up' } } as never),
      arrivalOfNothing: answerArrivalOf(undefined),
      promptRequested: answerArrivalOf({ client_prompt_requested: true }).client_prompt_requested,
      promptMalformed: answerArrivalOf({ client_prompt_requested: 'yes' }).client_prompt_requested,
    }).toEqual({
      expiry: { absent: 'settled_by_expiry' },
      noAnswer: { absent: 'recorded_without_route' },
      garbage: { absent: 'recorded_without_route' },
      declared: 'mcp',
      undeclared: { absent: 'route_not_declared' },
      sharedToken: { kind: 'shared_token' },
      badKey: undefined,
      badAbsence: undefined,
      arrivalOfNothing: {
        via: { absent: 'recorded_without_route' },
        recorded_by: { by: null, absent_cause: 'driver_not_recorded' },
        client_prompt_requested: false,
      },
      promptRequested: true,
      promptMalformed: false,
    });
  });

  it('correction 1 (C1): the principal is written through the total reader — an extra key never reaches the record', async () => {
    const s = await atGate();
    const embedderPrincipal = { kind: 'api_key', id: 'key-627', key: 'never-recorded-627' };
    await submitHumanResponse(s.store, s.def, {
      runId: s.record.id,
      gateId: s.gateId,
      choice: 'approve',
      route: 'mcp',
      principal: embedderPrincipal as never,
    });
    const entry = (await s.store.get(s.record.id)).evidence.find((e) => e.kind === 'gate_response');
    // (a) red when the principal is written as given (its extra key persisted in the run file);
    //     (b) prints the recorded principal's keys — never a value.
    expect(Object.keys((entry?.principal ?? {}) as object).sort()).toEqual(['id', 'kind']);
  });

  it.each([
    ['an empty route', { route: '' }, 'options.route must be a non-empty string'],
    [
      'a principal that reads as none',
      { principal: { kind: 'made_up' } },
      // Correction 2 (3.6): the absences by name.
      "options.principal must be a principal: { kind: 'api_key', id: <a non-empty string> }, { kind: 'shared_token' } or { absent: <one of: door_authentication_disabled, principal_not_passed, door_authenticates_no_principal, not_a_server_door> }",
    ],
  ] as const)(
    'correction 1 (C1): %s is refused with VALIDATION_OPTION_INVALID, and nothing is recorded; the words name what is expected (correction 2, 3.6)',
    async (_label, extra, words) => {
      const s = await atGate();
      const refused = await submitHumanResponse(s.store, s.def, {
        runId: s.record.id,
        gateId: s.gateId,
        choice: 'approve',
        ...extra,
      } as never).catch((e: unknown) => e);
      const code =
        refused instanceof WorkflowError
          ? refused.code
          : (refused as { error_code?: string }).error_code;
      const recorded = (await s.store.get(s.record.id)).evidence.filter(
        (e) => e.kind === 'gate_response',
      ).length;
      // (a) red when the option is written as given, or the refusal's words change; (b) prints the
      //     code, the answers recorded and whether the message holds the words.
      expect({
        code,
        recorded,
        words: refused instanceof Error && refused.message.includes(words),
      }).toEqual({ code: 'VALIDATION_OPTION_INVALID', recorded: 0, words: true });
    },
  );

  it('an unknown submitHumanResponse option is refused before any read; W’s four members are admitted (the closed list)', async () => {
    const s = await atGate();
    const refused = await submitHumanResponse(s.store, s.def, {
      runId: s.record.id,
      gateId: s.gateId,
      choice: 'approve',
      channelEvidence: {},
    } as never).catch((e: unknown) => e);
    const code =
      refused instanceof WorkflowError
        ? refused.code
        : (refused as { error_code?: string }).error_code;
    const admitted = await submitHumanResponse(s.store, s.def, {
      runId: s.record.id,
      gateId: s.gateId,
      choice: 'approve',
      route: 'mcp',
      shown: { renderer: 'x' },
      principal: { kind: 'shared_token' },
      clientPromptRequested: false,
    });
    // (a) red when an unlisted member (V-1's channelEvidence) is admitted, or one of W's four is
    //     refused; (b) prints the refusal's code and the admitted call's status.
    expect({ code, admitted: admitted.status }).toEqual({
      code: 'VALIDATION_OPTION_INVALID',
      admitted: 'ok',
    });
  });

  it('the run’s driver line skips an answer’s entry: the program that recorded an answer is not the run’s driver (C191 kept)', async () => {
    const s = await atGate();
    await submitHumanResponse(s.store, s.def, {
      runId: s.record.id,
      gateId: s.gateId,
      choice: 'approve',
      driver: { by: 'recorder', by_source: 'stated', channel: 'respond' },
    });
    const run = await s.store.get(s.record.id);
    // (a) red when the answer's recorder is taken as the run's driver; (b) prints the reading.
    expect(describeRunDriver(run, s.def).driver).toEqual({
      by: null,
      absent_cause: 'driver_not_recorded',
    });
  });
});

// ─── J: R25's two pieces (cells 8, 7(b)) and the definition absence `newer` ─────────────────────

const GATE_YAML = (gate: string) =>
  [
    'id: rv',
    'name: rv',
    'version: 1',
    'steps:',
    '  q:',
    '    description: Ask.',
    '    execution: auto',
    '    trust: human_confirmed',
    '    gate:',
    gate,
  ].join('\n');

function loadError(yaml: string): string {
  try {
    loadWorkflowFromString(yaml);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return 'loaded';
}

describe('#627 W — R25: the loader and the registry refuse what this version cannot hold', () => {
  it('cell 8 — gate.answer_via is refused in either form, timed or not, with W-r1 and the key’s line', () => {
    const ids = loadError(GATE_YAML('      answer_via: [slack]'));
    const traits = loadError(GATE_YAML('      answer_via:\n        checks_accounts: true'));
    const timed = loadError(
      GATE_YAML('      timeout_seconds: 60\n      on_expiry: abort\n      answer_via: [slack]'),
    );
    const w = (_line: number) =>
      `Step 'q': 'gate.answer_via' is not supported by this version of Realm (`;
    // (a) red when the traits form or a timed answer_via loads; (b) prints each message's start.
    expect({
      ids: ids.includes(w(10)) && ids.endsWith('(line 10)'),
      traits: traits.includes(w(10)) && traits.endsWith('(line 10)'),
      timed: timed.includes(w(12)) && timed.endsWith('(line 12)'),
      noTypoAdvice: ids.includes('UNKNOWN_GATE_KEY'),
    }).toEqual({ ids: true, traits: true, timed: true, noTypoAdvice: false });
  });

  it('cell 7(b) — a definition at CURRENT+1 is refused at read with W-r2 and typed facts; the damaged-file readers stay blind to it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'realm-w-627-wf-'));
    const store = new JsonWorkflowStore(dir);
    await writeFile(
      join(dir, 'later.json'),
      JSON.stringify({
        ...gated(),
        id: 'later',
        schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION + 1,
      }),
    );
    const err = (() => {
      try {
        store.getSync('later');
      } catch (e) {
        return e as WorkflowError;
      }
      return undefined;
    })();
    // (a) red when the upper bound is dropped (the copy reads), the code or its facts change, or a
    //     damaged-file reader takes the facts; (b) prints the code, the message's start and facts.
    expect({
      code: err?.code,
      message: err?.message.startsWith(
        `Workflow 'later' was registered by a later version of Realm (definition format ${CURRENT_WORKFLOW_SCHEMA_VERSION + 1}; this version reads up to ${CURRENT_WORKFLOW_SCHEMA_VERSION}) — refused: this version would ignore requirements it cannot read.`,
      ),
      facts: err?.facts,
      details: err?.details,
      damagedReader: unreadableFactsOf(err),
    }).toEqual({
      code: 'STATE_NEWER_FORMAT',
      message: true,
      facts: {
        scope: 'newer_definition',
        path: join(dir, 'later.json'),
        schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION + 1,
        reads_up_to: CURRENT_WORKFLOW_SCHEMA_VERSION,
      },
      details: {},
      damagedReader: undefined,
    });
  });

  it('after #759: storedFileFactsOf takes no newer copy’s facts; newerDefinitionFactsOf reads them (MA 3’s rebase note)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'realm-w-627-wf-'));
    await writeFile(
      join(dir, 'later.json'),
      JSON.stringify({
        ...gated(),
        id: 'later',
        schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION + 1,
      }),
    );
    const err = (() => {
      try {
        new JsonWorkflowStore(dir).getSync('later');
      } catch (e) {
        return e as WorkflowError;
      }
      return undefined;
    })()!;
    // (a) red when the stored-file narrowing takes the `newer_definition` scope (its readers would
    //     call a healthy newer copy damaged), or the newer reader misses it; (b) prints both readings.
    expect({
      storedFile: storedFileFactsOf(err),
      newer: newerDefinitionFactsOf(err)?.schema_version,
    }).toEqual({ storedFile: undefined, newer: CURRENT_WORKFLOW_SCHEMA_VERSION + 1 });
  });

  it('correction 2 (3.7, 8.6 (c)(d)): one reading of a copy at both sites — getSync’s error and the listing’s class agree for every shape', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'realm-w-627-shapes-'));
    const copies: Record<string, unknown> = {
      'a string 99': { ...gated(), id: 'v99', schema_version: '99' },
      'a string abc': { ...gated(), id: 'vabc', schema_version: 'abc' },
      'an empty object': {},
      'an object with no id': { a: 1 },
      'no schema_version (legacy)': { ...gated(), id: 'old' },
      // The schema_version-less cohort's own shape (#427: no `steps` key at all) — legacy, never
      // damaged (validate-registered.test.ts R4 pins the same shape through the CLI).
      'no schema_version and no steps (the #427 cohort)': {
        id: 'ancient',
        name: 'Ancient',
        version: 2,
      },
    };
    const files = Object.keys(copies).map((_, i) => `c${i}`);
    for (const [i, value] of Object.values(copies).entries()) {
      await writeFile(join(dir, `${files[i]}.json`), JSON.stringify(value));
    }
    const store = new JsonWorkflowStore(dir);
    const { unreadable } = await store.listWithDiagnostics();
    const classOf = (file: string) => unreadable.find((u) => u.file === `${file}.json`)?.class;
    const codeOf = (file: string) => {
      try {
        store.getSync(file);
        return 'read';
      } catch (e) {
        return e instanceof WorkflowError ? e.code : 'thrown';
      }
    };
    const rows = Object.keys(copies).map((label, i) => [
      label,
      codeOf(files[i]!),
      classOf(files[i]!),
    ]);
    // (a) red when getSync compares schema_version untyped ("99" read as newer, "abc" as current),
    //     a copy with no id reads as legacy, or the listing keeps a legacy copy readable;
    //     (b) prints, per copy, getSync's code and the listing's class.
    expect(rows).toEqual([
      ['a string 99', 'RESOURCE_FORMAT_INVALID', 'parse'],
      ['a string abc', 'RESOURCE_FORMAT_INVALID', 'parse'],
      ['an empty object', 'RESOURCE_FORMAT_INVALID', 'parse'],
      ['an object with no id', 'RESOURCE_FORMAT_INVALID', 'parse'],
      ['no schema_version (legacy)', 'STATE_LEGACY_FORMAT', 'legacy'],
      ['no schema_version and no steps (the #427 cohort)', 'STATE_LEGACY_FORMAT', 'legacy'],
    ]);
    // The words name what the copy lacks.
    const reasonOf = (file: string) =>
      unreadable.find((u) => u.file === `${file}.json`)?.reason ?? '';
    expect({
      version: reasonOf(files[0]!).includes('its schema_version is not a number'),
      noId: reasonOf(files[2]!).includes('it has no string id'),
    }).toEqual({ version: true, noId: true });
  });

  it('correction 1 (C3): listWithDiagnostics lists a newer copy unreadable, with W-r2’s reason, never readable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'realm-w-627-wf-'));
    await writeFile(
      join(dir, 'later.json'),
      JSON.stringify({
        ...gated(),
        id: 'later',
        schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION + 1,
      }),
    );
    const { workflows, unreadable } = await new JsonWorkflowStore(dir).listWithDiagnostics();
    // (a) red when the listing returns the newer copy as readable; (b) prints what each list holds.
    expect({
      readable: workflows.map((w) => w.id),
      unreadable: unreadable.map((u) => [u.file, u.class, u.reason.split(' — ')[0]]),
    }).toEqual({
      readable: [],
      unreadable: [
        [
          'later.json',
          'newer',
          `Workflow 'later' was registered by a later version of Realm (definition format ${CURRENT_WORKFLOW_SCHEMA_VERSION + 1}; this version reads up to ${CURRENT_WORKFLOW_SCHEMA_VERSION})`,
        ],
      ],
    });
  });

  it('the newer copy is a typed definition absence: definitionAbsenceOf → newer; its words; a run’s ways list definition_absent with [register]; the registry read’s arm keeps the message', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'realm-w-627-wf-'));
    const wfStore = new JsonWorkflowStore(dir);
    await writeFile(
      join(dir, 'g.json'),
      JSON.stringify({ ...gated(), schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION + 1 }),
    );
    const s = await atGate();
    let thrown: unknown;
    await getWorkflowForRun(wfStore, s.record, { retryVerb: 'retry', verb: 'retry' }).catch(
      (e: unknown) => {
        thrown = e;
      },
    );
    const absence = definitionAbsenceOf(thrown, s.record);
    const composed = composeWaysOn(writtenSnapshot(s.record, new Date()), {
      definition: absence!,
      enactor: { kind: 'observer' },
      store: { persistsClaims: true },
    });
    const entry = composed.unavailable.find((u) => u.code === 'definition_absent');
    // (a) red when the code falls to the default (no absence, the error rethrown untyped), the
    //     words name a damaged or older copy, or the remedy is not register; (b) prints each.
    expect({
      code: thrown instanceof WorkflowError ? thrown.code : 'none',
      keepsMessage:
        thrown instanceof WorkflowError &&
        thrown.message.includes('registered by a later version of Realm'),
      absence: absence === undefined ? undefined : [absence.absent, absence.format],
      words: entry === undefined ? undefined : renderDefinitionAbsent(entry.facts as never),
      remedy: entry?.remedy.map((w) => w.verb),
    }).toEqual({
      code: 'STATE_NEWER_FORMAT',
      keepsMessage: true,
      absence: [
        'newer',
        {
          schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION + 1,
          reads_up_to: CURRENT_WORKFLOW_SCHEMA_VERSION,
        },
      ],
      words: `Workflow 'g' (${join(dir, 'g.json')}) was registered by a later version of Realm (definition format ${CURRENT_WORKFLOW_SCHEMA_VERSION + 1}; this version reads up to ${CURRENT_WORKFLOW_SCHEMA_VERSION}), so this version would ignore requirements it cannot read`,
      remedy: ['register'],
    });
  });
});

// ─── H: the author-text note (cell 27b, loader half) ────────────────────────────────────────────

const AUTHOR_YAML = (instructions: string, opts: { gated?: boolean; rules?: string } = {}) =>
  [
    'id: at',
    'name: at',
    'version: 1',
    ...(opts.rules !== undefined ? ['protocol:', '  rules:', `    - ${opts.rules}`] : []),
    'steps:',
    '  s:',
    '    description: S.',
    '    execution: agent',
    ...(opts.gated !== false ? ['    trust: human_confirmed'] : []),
    `    instructions: ${JSON.stringify(instructions)}`,
  ].join('\n');

const notes = (yaml: string) =>
  loadWorkflowFromStringWithDiagnostics(yaml)
    .warnings.filter((w) => w.code === 'AUTHOR_TEXT_NAMES_ANSWER_TOOL')
    .map((w) => w.message);

describe('#627 W — W-l1: a load note for author text that names an answer tool', () => {
  it.each([
    ['submit_human_response', 'Call submit_human_response with the choice.'],
    ['present_question', 'Then call present_question.'],
    ['realm run respond', 'Run realm  run respond in a terminal.'],
  ])('a gated step’s instructions naming %s: one note, with the line', (tool, text) => {
    // (a) red when the name is not matched, or the line is lost; (b) prints the notes.
    expect(notes(AUTHOR_YAML(text))).toEqual([
      `Note: Step 's': instructions (line 9) tells the agent to use '${tool}'. When this server withholds answers, or the user's app shows forms, the agent has no such tool; Realm forwards this text marked as the author's, followed by its own rule that the agent cannot answer. Consider removing it. (This is a text match: it finds tool names, not every way of asking.)`,
    ]);
  });

  it('correction 1 (E7): the command is matched in any case — a sentence may open with "Realm run respond"', () => {
    // (a) red when the command pattern is case-sensitive; (b) prints the notes.
    expect(notes(AUTHOR_YAML('Realm run respond answers it.'))).toEqual([
      `Note: Step 's': instructions (line 9) tells the agent to use 'realm run respond'. When this server withholds answers, or the user's app shows forms, the agent has no such tool; Realm forwards this text marked as the author's, followed by its own rule that the agent cannot answer. Consider removing it. (This is a text match: it finds tool names, not every way of asking.)`,
    ]);
  });

  it('silent on text that names no answer tool ("respond to the user"), and on an ordinary step', () => {
    // (a) red when "respond" alone matches, or an ungated step is noted (its text is not labelled,
    //     so the note's claim would be false); (b) prints the notes.
    expect({
      respond: notes(AUTHOR_YAML('Respond to the user, then respond to the reviewer.')),
      ordinary: notes(AUTHOR_YAML('Call submit_human_response.', { gated: false })),
    }).toEqual({ respond: [], ordinary: [] });
  });

  it('correction 1 (F3): no gated step’s instructions and no protocol.rules of a shipped example names an answer tool (example 03 told the agent to call submit_human_response)', () => {
    const examples = fileURLToPath(new URL('../../../../examples/', import.meta.url));
    const found = readdirSync(examples, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
      .map((dir) => ({
        dir,
        notes: notes(readFileSync(join(examples, dir, 'workflow.yaml'), 'utf8')),
      }));
    // (a) red when an example's gated step or protocol.rules names an answer tool again (under forms
    //     an answer given in chat is not recorded); (b) prints each example's notes. The count checks
    //     the instrument read all nine.
    expect({
      read: found.length,
      noted: found.filter((f) => f.notes.length > 0),
    }).toEqual({ read: 9, noted: [] });
  });

  it('correction 2 (8.4): no shipped example’s gated step asks the person to "reply with" an answer — a reply in chat is not recorded', () => {
    const examples = fileURLToPath(new URL('../../../../examples/', import.meta.url));
    const asked: string[] = [];
    let gated = 0;
    for (const dir of readdirSync(examples, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()) {
      const wf = loadWorkflowFromString(readFileSync(join(examples, dir, 'workflow.yaml'), 'utf8'));
      for (const [id, step] of Object.entries(wf.steps)) {
        if (step.gate === undefined) continue;
        gated += 1;
        for (const [field, text] of [
          ['prompt', step.prompt],
          ['gate.message', step.gate.message],
        ] as const) {
          if (typeof text === 'string' && /reply with/i.test(text))
            asked.push(`${dir} ${id} ${field}`);
        }
      }
    }
    // Ordinary steps that draft a reply (example 06) are out of scope: only a gated step's words go
    // to the person who answers. (a) red when example 03's prompt says "Reply with" again; (b) prints
    // each example, step and field that asks, and the count of gated steps read (the instrument: 03,
    // 07, 08 and 09 gate one step each).
    expect({ gated, asked }).toEqual({ gated: 4, asked: [] });
  });

  it('protocol.rules: one note for the field, with the line of `rules`', () => {
    // (a) red when the rules are not read, or noted per rule; (b) prints the notes.
    expect(notes(AUTHOR_YAML('Do the work.', { rules: 'Use submit_human_response.' }))).toEqual([
      "Note: protocol.rules (line 5) tells the agent to use 'submit_human_response'. When this server withholds answers, or the user's app shows forms, the agent has no such tool; Realm forwards this text marked as the author's, followed by its own rule that the agent cannot answer. Consider removing it. (This is a text match: it finds tool names, not every way of asking.)",
    ]);
  });
});

// ─── A: the settings' judges (cell 4's core; W-s8's bounds) ─────────────────────────────────────

describe('#627 W — the gate-answers value and the form wait, judged once', () => {
  it('the most restrictive value wins, whichever place sets it; the others are named; none set ⇒ asked from the default', () => {
    const j = (input: Parameters<typeof judgeGateAnswers>[0]) => {
      const r = judgeGateAnswers(input);
      return r.ok
        ? [r.setting.value, r.setting.source.kind, alsoSetClause(r.setting)]
        : ['bad', r.kind, r.raw];
    };
    // (a) red when the option overrides the env, the flag loses to a less restrictive env, or the
    //     default is not asked; (b) prints value, source and the also-set clause.
    expect({
      none: j({}),
      optionVsEnv: j({ env: 'withheld', option: 'offered' }),
      flagVsEnv: j({ flag: 'offered', env: 'asked' }),
      tie: j({ flag: 'withheld', env: 'withheld' }),
      bad: j({ env: 'witheld' }),
    }).toEqual({
      none: ['asked', 'default', ''],
      optionVsEnv: [
        'withheld',
        'env',
        '; also set: the program that started this server (gateAnswers option) = offered — the most restrictive value wins',
      ],
      flagVsEnv: [
        'asked',
        'env',
        '; also set: --gate-answers = offered — the most restrictive value wins',
      ],
      tie: [
        'withheld',
        'flag',
        '; also set: REALM_MCP_GATE_ANSWERS = withheld — the most restrictive value wins',
      ],
      bad: ['bad', 'env', 'witheld'],
    });
  });

  it('the form wait: whole seconds from 30 to 3600; the smallest set wins; none ⇒ 240', () => {
    const j = (input: Parameters<typeof judgeFormWait>[0]) => {
      const r = judgeFormWait(input);
      return r.ok ? [r.setting.seconds, r.setting.source.kind] : ['bad', r.kind, r.raw];
    };
    // (a) red when 10 or 3601 is accepted, a larger value wins, or the default moves; (b) prints each.
    expect({
      none: j({}),
      low: j({ flag: '10' }),
      high: j({ env: '3601' }),
      edges: [j({ flag: '30' }), j({ flag: '3600' })],
      fraction: j({ option: '45.5' }),
      smallest: j({ flag: '600', env: '120', option: 300 }),
    }).toEqual({
      none: [FORM_WAIT_SECONDS_DEFAULT, 'default'],
      low: ['bad', 'flag', '10'],
      high: ['bad', 'env', '3601'],
      edges: [
        [30, 'flag'],
        [3600, 'flag'],
      ],
      fraction: ['bad', 'option', '45.5'],
      smallest: [120, 'env'],
    });
    expect(FORM_WAIT_SECONDS_DEFAULT).toBe(240);
  });
});

// ─── K: the separation check's predicate (cell 26's core) ───────────────────────────────────────

const NO: ConditionReading = { basis: 'measured', answer: 'no' };
const YES: ConditionReading = { basis: 'measured', answer: 'yes' };
const UNKNOWN: ConditionReading = { basis: 'unknown', cause: 'not readable' };

function evidence(
  over: Partial<SeparationEvidence> = {},
  conds: Partial<SeparationEvidence['conditions']> = {},
): SeparationEvidence {
  return {
    login: 'agent',
    service_user: 'realm',
    store_owned_by_other: true,
    // #819 (C4): the guardrail-6 sweep's one add-only member here — another user's store
    owns_store: false,
    value: { value: 'withheld', source: { kind: 'flag', ref: '--gate-answers' } },
    ...over,
    conditions: {
      store_reach: NO,
      become_service_user: NO,
      root_engine: NO,
      trust_root_writable: NO,
      other_answer_host: { basis: 'unknown', cause: 'one look' },
      time_basis: { basis: 'measured', answer: 'fact', detail: 'clock' },
      agent_sandbox: NO,
      economics_writable: { basis: 'measured', answer: 'fact', detail: 'none' },
      ...conds,
    },
  };
}

describe('#627 W — the separation check: the mode derived, "prevents" only when everything is measured', () => {
  it('the positive case prevents; each conjunct alone takes it away', () => {
    // (a) red when any one conjunct is skipped — the mode, one of conditions 1–4, the value, or
    //     the value's source (an env withheld is configured, not measured); (b) prints each verdict.
    expect({
      all: separationPrevents(evidence()),
      sameLogin: separationPrevents(evidence({ store_owned_by_other: false })),
      store: separationPrevents(evidence({}, { store_reach: YES })),
      become: separationPrevents(evidence({}, { become_service_user: UNKNOWN })),
      rootEngine: separationPrevents(evidence({}, { root_engine: YES })),
      trustRoot: separationPrevents(evidence({}, { trust_root_writable: UNKNOWN })),
      asked: separationPrevents(
        evidence({ value: { value: 'asked', source: { kind: 'flag', ref: '--gate-answers' } } }),
      ),
      fromEnv: separationPrevents(
        evidence({
          value: { value: 'withheld', source: { kind: 'env', ref: 'REALM_MCP_GATE_ANSWERS' } },
        }),
      ),
    }).toEqual({
      all: true,
      sameLogin: false,
      store: false,
      become: false,
      rootEngine: false,
      trustRoot: false,
      asked: false,
      fromEnv: false,
    });
  });

  it('the mode: same_account when this login reaches its own store; separate_user for another user’s store whatever condition 1 reads (correction 2, 5.4); sandbox_configured when a sandbox is configured and the store is reachable from outside it; the sandbox cross (5.8)', () => {
    // (a) red when same_account is derived with condition 1 "no" and another owner, or from a
    //     condition 1 that is not measured "yes" (correction 1, D1: an unknown, or "no" on an owned
    //     store, is `unknown`); (b) prints each mode.
    // Correction 2 (5.4): the reach, unknown and sandbox rows are this login's own store
    // (`store_owned_by_other: false`), so they keep their subject; another user's store is
    // `separate_user` whatever condition 1 reads; 5.8, the sandbox cross: a configured sandbox with
    // condition 1 not measured is `unknown`, never `sandbox_configured`.
    // #819 (C4): this login's own store — it owns it (the same-login modes need that).
    const own = { store_owned_by_other: false, owns_store: true };
    // #819 (C4): a store this login reaches whose owner is not known (no uid) — never the same login.
    const unowned = { store_owned_by_other: false, owns_store: false };
    const CONFIGURED: ConditionReading = {
      basis: 'configured_not_enforced',
      detail: 'Claude Code',
    };
    expect({
      separate: separationModeOf(evidence()),
      otherReadable: separationModeOf(evidence({}, { store_reach: YES })),
      reach: separationModeOf(evidence(own, { store_reach: YES })),
      unknown: separationModeOf(evidence(own, { store_reach: UNKNOWN })),
      ownStore: separationModeOf(evidence(own)),
      sandbox: separationModeOf(evidence(own, { store_reach: YES, agent_sandbox: CONFIGURED })),
      sandboxCross: separationModeOf(
        evidence(own, { store_reach: UNKNOWN, agent_sandbox: CONFIGURED }),
      ),
      reachUnowned: separationModeOf(evidence(unowned, { store_reach: YES })),
      sandboxUnowned: separationModeOf(
        evidence(unowned, { store_reach: YES, agent_sandbox: CONFIGURED }),
      ),
    }).toEqual({
      separate: 'separate_user',
      otherReadable: 'separate_user',
      reach: 'same_account',
      unknown: 'unknown',
      ownStore: 'unknown',
      sandbox: 'sandbox_configured',
      sandboxCross: 'unknown',
      // #819 (C4): red when same_account or sandbox_configured does not need `owns_store`.
      reachUnowned: 'unknown',
      sandboxUnowned: 'unknown',
    });
  });

  it('the gaps the "may still" form names: the prevents conditions not measured no, and the value', () => {
    // (a) red when a met condition is named, the env-set value is not, or a gap loses its reading
    //     (#819 Unit B: an unknown reads "is unknown", or "was not measured" when nothing was read
    //     for it); (b) prints the gaps.
    expect(
      separationGaps(
        evidence(
          { value: { value: 'withheld', source: { kind: 'env', ref: 'REALM_MCP_GATE_ANSWERS' } } },
          { root_engine: YES, trust_root_writable: UNKNOWN },
        ),
      ),
    ).toEqual([
      { gap: 'root_engine', reading: YES },
      { gap: 'trust_root_writable', reading: UNKNOWN },
      { gap: 'value' },
    ]);
  });
});

// ─── correction 2 (2.1): the question of a gate with no message, through the one composer ───────

// #729 PR-4 (f), re-pinned: the already-open reply showed the step's prompt as gate.display; now it
// composes the live gate through the one composer, and a gate with no message has no question.
describe('#627 W correction 2 (2.1); #729 PR-4 (f) — a re-read gate shows no question made from its step’s prompt', () => {
  it('a second caller reaching an already-open prompt-only gate gets no gate.display', async () => {
    const def = loadWorkflowFromString(
      [
        'id: prompt627',
        'name: prompt627',
        'version: 1',
        'steps:',
        '  q:',
        '    description: Ask.',
        '    execution: auto',
        '    trust: human_confirmed',
        '    prompt: Ship the release to production?',
        '    gate:',
        '      choices: [approve, reject]',
      ].join('\n'),
    );
    // The second caller: its own settle of the gate finds it already open (D-1's `already_open` arm,
    // which renders the LIVE gate) — reached by replaying the opening settle once.
    class SecondCaller extends JsonFileStore {
      override async settleStep(
        ...args: Parameters<JsonFileStore['settleStep']>
      ): ReturnType<JsonFileStore['settleStep']> {
        const first = await super.settleStep(...args);
        const delta = args[1];
        if (delta.kind !== 'open_gate') return first;
        // A second caller's gate: its own id, finding the first one open.
        return super.settleStep(
          args[0],
          { ...delta, pendingGate: { ...delta.pendingGate, gate_id: 'second-caller-gate' } },
          args[2],
        );
      }
    }
    const store = new SecondCaller(await mkdtemp(join(tmpdir(), 'realm-w627-prompt-')));
    const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
    const again = await executeStep(store, def, {
      runId: run.id,
      command: 'q',
      input: {},
      dispatcher: async () => ({}),
    });
    const hint = again.context_hint;
    // (a) red when the already-open arm renders the step's prompt into the display again; (b)
    //     prints the reply's status, hint and whether it carries a display.
    expect({ status: again.status, hint, display: 'display' in (again.gate ?? {}) }).toEqual({
      status: 'confirm_required',
      hint: `Run is already paused at gate '${again.gate?.gate_id}'.`,
      display: false,
    });
  });
});

// ─── correction 2 (3.3): B1's route reaches every branch of the answer's reply ──────────────────

describe('#627 W correction 2 (3.3) — a form’s answer gets no token sentence on any branch', () => {
  /** A gate whose expiry settles its default, `approve` (the late answer `ok` only with that choice). */
  const settlesDefault = (): WorkflowDefinition => {
    const def = gated();
    return {
      ...def,
      id: 'g-default',
      steps: {
        ...def.steps,
        q: {
          ...def.steps['q']!,
          gate: {
            choices: ['approve', 'reject'],
            timeout_seconds: 60,
            on_expiry: 'settle_default',
            default_choice: 'approve',
          },
        },
      },
    } as WorkflowDefinition;
  };
  const form = (s: Awaited<ReturnType<typeof atGate>>, store: JsonFileStore = s.store) =>
    submitHumanResponse(store, s.def, {
      runId: s.record.id,
      gateId: s.gateId,
      choice: 'approve',
      route: 'mcp_form',
    });
  it.each([
    ['recorded', async () => form(await atGate())],
    [
      // Its claim verdict is `spent`, for which no sentence is composed: this row cannot turn red by
      // dropping its route (the red-first run, break 3.3-same) — it pins that the branch composes none.
      'the same choice again (already settled)',
      async () => {
        const s = await atGate();
        await form(s);
        return form(s);
      },
    ],
    [
      'past expires_at (its settle_default enacted by this answer)',
      async () => {
        const s = await atGate(settlesDefault());
        const record = await s.store.get(s.record.id);
        await s.store.update({
          ...record,
          pending_gate: {
            ...record.pending_gate!,
            expires_at: new Date(Date.now() - 60_000).toISOString(),
          },
        });
        return form(s);
      },
    ],
    [
      'a store without settleStep (the legacy write)',
      async () => {
        const s = await atGate();
        const legacy = Object.create(s.store) as JsonFileStore;
        Object.defineProperty(legacy, 'settleStep', { value: undefined });
        return form(s, legacy);
      },
    ],
  ] as const)('%s: no warning names claim_token', async (_branch, answer) => {
    const reply = await answer();
    // (a) red when that branch's caller drops the route (the sentence "No claim_token was passed…"
    //     comes back for a form's answer, which carries none by design); (b) prints the status and
    //     whether any warning names claim_token.
    expect({
      status: reply.status,
      tokenSentence: reply.warnings.some((w) => w.includes('claim_token')),
    }).toEqual({ status: 'ok', tokenSentence: false });
  });
});
