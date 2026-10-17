// ways.test.ts — issue #729 PR-0 (PR0-CONTRACT §1–§4, Amendment 15; D2 §3; D3 A-1…A-7; D4 P-4, P-5,
// T-1, T-11, T-17, T-21, T-22): the laws of the ways, one cell per law.
//
// - S7, one cell per `UnavailableCode` (rule 19): the code is produced by its own conjunct, on a verb
//   its row lists, with its tag, carrying Amendment 15's act for that code; one cell per `NoRemedy`
//   member. Every entry holds REFUSAL_ENDS_IN_AN_ACT in its formal form (Amendment 16: the act,
//   followed through listed remedies, ends in an OFFERED way, a `no_remedy` naming why none exists,
//   or an exempt code — `door_cannot_enact`, `enactor_load_failed`, a `not_a_step` with no step to
//   offer, whose facts name why; a cycle breaks it), REMEDY_IS_JUDGED (every remedy offered or listed
//   with its own code) and rule 10 (no liveness word).
// - The sweep: those laws over every listed entry and every refusal of a curated set of run states.
// - OFFER_EQUALS_ADMISSION (R26) over the same states: the offered set equals the admitted set.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure: field
// names, codes, verbs and ids — never a token, never an environment.
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  admitWay,
  agentActionOf,
  basisOf,
  LIBRARY_WORDS,
  readSupplier,
  agentRenderedList,
  composeWaysOn,
  narrowForDoor,
  COND_TAGS,
  NO_REMEDY_CAUSES,
  UNAVAILABLE_CODES,
  type ComposedWays,
  type DoorPolicy,
  type ProgressVerb,
  type RenderedList,
  type Unavailable,
  type UnavailableCode,
  type WayOn,
  type WaysContext,
} from './ways.js';
import { writtenSnapshot } from './snapshot.js';
import { abandonRun } from './abandon-run.js';
import {
  executeEngineStep,
  executeStep,
  submitHumanResponse,
  terminalAnswerRefusalMessage,
} from './execution-loop.js';
import { JsonFileStore } from '../store/json-file-store.js';
import { ExtensionRegistry } from '../extensions/registry.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
import type { RunRecord } from '../types/run-record.js';

// ─── Fixtures ───────────────────────────────────────────────────────────────────────────────────

const AT = new Date('2026-10-16T12:00:00.000Z');

/** One workflow with every step kind the codes need. */
const W: WorkflowDefinition = {
  id: 'w',
  name: 'w',
  version: 1,
  steps: {
    a: { description: 'a', execution: 'agent', depends_on: [] },
    b: { description: 'b', execution: 'auto', depends_on: ['a'] },
    x: { description: 'x', execution: 'auto', depends_on: ['b'] },
    gd: { description: 'gd', execution: 'guard', depends_on: ['x'] },
    fin: { description: 'fin', execution: 'finalizer', depends_on: [] },
  } as WorkflowDefinition['steps'],
};

/** `a` (agent, a precondition that never holds), `c` (auto, after `a`). */
const STRANDED: WorkflowDefinition = {
  id: 'stranded',
  name: 'stranded',
  version: 1,
  steps: {
    a: {
      description: 'a',
      execution: 'agent',
      depends_on: [],
      preconditions: ["run.params.mode == 'live'"],
    },
    c: { description: 'c', execution: 'auto', depends_on: ['a'] },
  },
};

/** `f` (auto, its handler throws), `g` and `y` after it, `s` (an independent agent step). */
const FAILING: WorkflowDefinition = {
  id: 'failing',
  name: 'failing',
  version: 1,
  steps: {
    f: { description: 'f', execution: 'auto', depends_on: [], handler: 'boom' },
    g: { description: 'g', execution: 'auto', depends_on: ['f'] },
    y: { description: 'y', execution: 'auto', depends_on: ['g'] },
    s: { description: 's', execution: 'agent', depends_on: [] },
  },
};

/** `h` (auto, handler `h1` — absent from an empty registry). */
const HANDLED: WorkflowDefinition = {
  id: 'handled',
  name: 'handled',
  version: 1,
  steps: { h: { description: 'h', execution: 'auto', depends_on: [], handler: 'h1' } },
};

const N_SCHEMA = {
  type: 'object',
  required: ['n'],
  properties: { n: { type: 'string' } },
};

/** `m` (an engine step whose input_schema the engine's empty input fails; no input_map: T-17's lever). */
const LEVER: WorkflowDefinition = {
  id: 'lever',
  name: 'lever',
  version: 1,
  steps: { m: { description: 'm', execution: 'auto', depends_on: [], input_schema: N_SCHEMA } },
} as WorkflowDefinition;

/** `mm` (an engine step whose input_map reads the run's `num` param; its schema wants a string). */
const MAPPED: WorkflowDefinition = {
  id: 'mapped',
  name: 'mapped',
  version: 1,
  steps: {
    mm: {
      description: 'mm',
      execution: 'auto',
      depends_on: [],
      handler: 'h-map',
      input_map: { n: 'run.params.num' },
      input_schema: N_SCHEMA,
    },
  },
} as WorkflowDefinition;

/**
 * `q` (a question; with `onExpiry`, its deadline 60 s after it opens), then `after` (`withAfter`);
 * with `side`, an independent `side`.
 */
function gated(
  onExpiry?: 'settle_default' | 'abort',
  opts: { side?: boolean; withAfter?: boolean } = {},
): WorkflowDefinition {
  const { side = false, withAfter = true } = opts;
  return {
    id: `gated-${onExpiry ?? 'none'}${side ? '-side' : ''}${withAfter ? '' : '-alone'}`,
    name: 'gated',
    version: 1,
    steps: {
      q: {
        description: 'Ask.',
        execution: 'auto',
        trust: 'human_confirmed',
        depends_on: [],
        gate: {
          choices: ['approve', 'reject'],
          ...(onExpiry !== undefined ? { timeout_seconds: 60, on_expiry: onExpiry } : {}),
          ...(onExpiry === 'settle_default' ? { default_choice: 'approve' } : {}),
        },
      },
      ...(withAfter
        ? { after: { description: 'After.', execution: 'auto', depends_on: ['q'] } }
        : {}),
      ...(side ? { side: { description: 'Side.', execution: 'auto', depends_on: [] } } : {}),
    },
  } as WorkflowDefinition;
}

const BASE = {
  id: 'r',
  workflow_id: 'w',
  params: {},
  completed_steps: [],
  in_progress_steps: [],
  failed_steps: [],
  skipped_steps: [],
  evidence: [],
  terminal_state: false,
} as unknown as RunRecord;

function ctxOf(definition: WorkflowDefinition, extra: Partial<WaysContext> = {}): WaysContext {
  return {
    definition: { ok: definition },
    enactor: { kind: 'observer' },
    store: { persistsClaims: true },
    ...extra,
  };
}

const ABSENT: WaysContext = {
  definition: { absent: 'not_registered', workflow_id: 'w' },
  enactor: { kind: 'observer' },
  store: { persistsClaims: true },
};

const compose = (record: RunRecord, ctx: WaysContext, at: Date = AT): ComposedWays =>
  composeWaysOn(writtenSnapshot(record, at), ctx);

/** A refusal the call is given (never `ok`): fails the cell, printing the verb, when admitted. */
function refusalOf(
  verb: WayOn['verb'],
  record: RunRecord,
  ctx: WaysContext,
  input: Record<string, unknown>,
  at: Date = AT,
): Unavailable {
  const admission = admitWay(verb, writtenSnapshot(record, at), ctx, input);
  if ('ok' in admission) throw new Error(`${verb}: admitted, a refusal was expected`);
  return admission;
}

/** A way's identity: its verb and its target (the linking pass's terms). */
/** #627 W: the MCP door on `asked`'s fallback row (a session whose client shows no forms). */
const FALLBACK_DOOR: DoorPolicy = {
  door: 'mcp',
  serves: ['agent', 'asked_person'],
  route: 'mcp',
  source: { kind: 'default', ref: 'test' },
  answers: {
    value: 'asked',
    source: { kind: 'default', ref: 'test' },
    forms: { shown: false, source: { kind: 'negotiated', ref: 'test' } },
  },
};

function keyOf(way: WayOn): string {
  switch (way.verb) {
    case 'respond':
      return `respond:${way.gate_id}`;
    case 'run_step':
      return `run_step:${way.step}:${way.brief.execution}`;
    case 'register':
      return `register:${way.workflow_id}`;
    default:
      return way.verb;
  }
}

/**
 * A listed entry's identity, in {@link keyOf}'s terms: a run_step entry judges its step's ways; a
 * respond entry its gate's answer — by its gate id, or (an entry whose facts name no gate, as
 * `definition_absent`'s) by the open question's step.
 */
function listedKeysOf(entry: Unavailable): string[] {
  if (entry.verb === 'respond') {
    const gate = 'gate_id' in entry.facts ? String(entry.facts.gate_id) : undefined;
    return gate !== undefined ? [`respond:${gate}`] : [`respond-step:${entry.step ?? ''}`];
  }
  if (entry.code === 'door_cannot_enact' && entry.remedy[0] !== undefined) {
    // the conservation law: the entry lists the very way the door removed
    return [keyOf(entry.remedy[0])];
  }
  if (entry.verb === 'run_step' && entry.step !== undefined) {
    return [`run_step:${entry.step}:agent`, `run_step:${entry.step}:auto`];
  }
  return [entry.verb];
}

/** What the laws read: a composition, or a door's narrowing of one. */
type Laws = { readonly ways: readonly WayOn[]; readonly unavailable: readonly Unavailable[] };

/** Rule 10: a deadline never becomes a liveness word. */
const LIVENESS = /\b(alive|is running|still running|running now|executing now|is active)\b/i;

/** Amendment 15's exemptions: codes whose own facts name why no way leads on. */
function exempt(entry: Unavailable): boolean {
  return (
    entry.code === 'door_cannot_enact' ||
    entry.code === 'enactor_load_failed' ||
    (entry.code === 'not_a_step' && entry.remedy.length === 0)
  );
}

/**
 * The S7 laws every entry holds (PR0-CONTRACT §1–§2, Amendment 15, D4 P-4): its verb is one its row
 * lists; REFUSAL_ENDS_IN_AN_ACT — at least one remedy OFFERED in the same composition, or `no_remedy`
 * naming why none exists, or an exempt code; every remedy offered or listed (REMEDY_IS_JUDGED); no
 * liveness word. Returns each law the entry breaks, naming the code, the verb and the remedy verbs —
 * never a value.
 */
function lawViolations(entry: Unavailable, composed: Laws, where = ''): string[] {
  const label = `${where}${entry.code} (${entry.verb}${entry.step !== undefined ? ` ${entry.step}` : ''})`;
  const found: string[] = [];
  const row = UNAVAILABLE_CODES[entry.code];
  if (!(row.verbs as readonly string[]).includes(entry.verb)) {
    found.push(`${label}: verb not in its row`);
  }
  const offered = new Set(composed.ways.map(keyOf));
  const listed = new Set(composed.unavailable.flatMap(listedKeysOf));
  const act = actEnd(entry, composed, offered, new Set());
  if (act !== 'ends') {
    found.push(
      `${label}: REFUSAL_ENDS_IN_AN_ACT — remedies [${entry.remedy.map((w) => w.verb).join(', ')}]: ${act}`,
    );
  }
  for (const way of entry.remedy) {
    const byStep = way.verb === 'respond' && listed.has(`respond-step:${way.step}`);
    if (!(offered.has(keyOf(way)) || listed.has(keyOf(way)) || byStep)) {
      found.push(`${label}: REMEDY_IS_JUDGED — remedy ${way.verb} neither offered nor listed`);
    }
  }
  if (LIVENESS.test(JSON.stringify(entry))) found.push(`${label}: a liveness word`);
  return found;
}

/** The entries a composition lists for a way (its judged refusals), in {@link listedKeysOf}'s terms. */
function entriesListing(way: WayOn, composed: Pick<Laws, 'unavailable'>): Unavailable[] {
  const key = keyOf(way);
  return composed.unavailable.filter(
    (u) =>
      listedKeysOf(u).includes(key) ||
      (way.verb === 'respond' && listedKeysOf(u).includes(`respond-step:${way.step}`)),
  );
}

/**
 * REFUSAL_ENDS_IN_AN_ACT in its formal form (Amendment 16): the entry's act, followed THROUGH listed
 * remedies, ends in an offered way, a `no_remedy` cause or an exempt code. The chain is finite: a
 * visited set, a cycle a violation. `'ends'`, or why it does not.
 */
function actEnd(
  entry: Unavailable,
  composed: Laws,
  offered: ReadonlySet<string>,
  visited: Set<Unavailable>,
): 'ends' | 'a cycle' | 'no offered remedy, no no_remedy' {
  if (visited.has(entry)) return 'a cycle';
  visited.add(entry);
  if (entry.no_remedy !== undefined || exempt(entry)) return 'ends';
  if (entry.remedy.some((w) => offered.has(keyOf(w)))) return 'ends';
  let cycle = false;
  for (const way of entry.remedy) {
    for (const next of entriesListing(way, composed)) {
      const end = actEnd(next, composed, offered, visited);
      if (end === 'ends') return 'ends';
      if (end === 'a cycle') cycle = true;
    }
  }
  return cycle ? 'a cycle' : 'no offered remedy, no no_remedy';
}

/** {@link lawViolations}, asserted empty: prints every law the entry breaks. */
function expectLaws(entry: Unavailable, composed: Laws, where = '') {
  expect(lawViolations(entry, composed, where)).toEqual([]);
}

/** The listed entry of a code (and verb), or a failure naming them. */
function listedOf(composed: ComposedWays, code: UnavailableCode, verb?: string): Unavailable {
  const entry = composed.unavailable.find(
    (u) => u.code === code && (verb === undefined || u.verb === verb),
  );
  if (entry === undefined) {
    throw new Error(
      `${code}${verb !== undefined ? ` (${verb})` : ''} not listed; listed: ${composed.unavailable.map((u) => `${u.verb}:${u.code}`).join(', ')}`,
    );
  }
  return entry;
}

/** The fact names an entry carries (printed on failure; never the values). */
const factNames = (entry: Unavailable): string[] => Object.keys(entry.facts).sort();
const verbsOf = (ways: readonly WayOn[]): string[] => ways.map(keyOf);

/** A fresh store per cell. */
async function newStore(): Promise<JsonFileStore> {
  return new JsonFileStore(await mkdtemp(join(tmpdir(), 'realm-ways-729-')));
}

/** A run of `d` with its question open (opened by a real call). */
async function atQuestion(store: JsonFileStore, d: WorkflowDefinition) {
  const { run } = await store.create({ workflowId: d.id, workflowVersion: 1, params: {} });
  const opened = await executeStep(store, d, {
    runId: run.id,
    command: 'q',
    input: {},
    dispatcher: async () => ({}),
  });
  if (opened.status !== 'confirm_required') throw new Error(`fixture: ${opened.status}`);
  const record = await store.get(run.id);
  return { record, gateId: record.pending_gate!.gate_id };
}

/** The instant 5 s after a record's open question's deadline. */
const pastDeadline = (record: RunRecord): Date =>
  new Date(new Date(record.pending_gate!.expires_at!).getTime() + 5_000);

describe('#729 PR-0 — S7: one law per UnavailableCode (rule 19), Amendment 15’s act per code', () => {
  let store: JsonFileStore;
  beforeEach(async () => {
    store = await newStore();
  });

  it('the code list is exactly the 21 PR-0 produces and the 4 #627 W produces, each tagged (Amendment 8: none reserved)', () => {
    // (a) red when a code is added without its cell or one is removed; (b) prints the list.
    expect(Object.keys(UNAVAILABLE_CODES).sort()).toEqual(
      [
        // #627 W: the door's own codes (present's three; the agent's removed respond).
        'asks_exhausted',
        'door_withholds_answers',
        'form_open',
        'no_form_here',
        'argument_out_of_contract',
        'capability_missing',
        'claim_removed',
        'definition_absent',
        'deps_unsettled',
        'door_cannot_enact',
        'enactor_load_failed',
        'gate_not_open',
        'gated_step',
        'held_elsewhere',
        'not_a_step',
        'not_eligible',
        'question_due',
        'question_open',
        'question_past_deadline',
        'question_settled',
        'refused_before_claim',
        'run_ended',
        'step_settled',
        'step_engine_decided',
        'upstream_cannot_run',
      ].sort(),
    );
  });

  it('NoRemedy is closed: its five members (Amendment 15)', () => {
    // (a) red when a member is added without its cell or one is removed; (b) prints the list.
    expect([...NO_REMEDY_CAUSES].sort()).toEqual([
      'already_settled',
      'another_program_holds_it',
      'engine_runs_it_when_owed',
      'operator_command_untyped',
      'requires_other_program',
    ]);
  });

  it('run_ended (snapshot): an ended run lists advance and abandon, no progress way — operator_command_untyped, the command its ending’s prose names', async () => {
    const { run } = await store.create({ workflowId: W.id, workflowVersion: 1, params: {} });
    await abandonRun(store, run.id, 'test');
    const ended = await store.get(run.id);
    const composed = compose(ended, ctxOf(W));
    // (a) red when the terminal branch stops listing them, or names a command the ending's prose does
    //     not; (b) prints the listed verbs:codes and the command.
    for (const verb of ['advance', 'abandon']) {
      const entry = listedOf(composed, 'run_ended', verb);
      expect(UNAVAILABLE_CODES.run_ended.tag).toBe('snapshot');
      expect(factNames(entry)).toEqual(['phase']);
      expect(entry.remedy).toEqual([]);
      // An operator ended it: "to run the work again, start a new run" (endedRunWayOut's words).
      expect(entry.no_remedy).toEqual({ cause: 'operator_command_untyped', command: 'start' });
      expectLaws(entry, composed);
    }
    for (const [verb, input] of [
      ['run_step', { run_id: run.id, command: 'a' }],
      ['respond', { run_id: run.id, gate_id: 'g', choice: 'approve' }],
    ] as const) {
      const entry = refusalOf(verb, ended, ctxOf(W), input);
      expect(`${entry.code}:${entry.no_remedy?.cause}`).toBe('run_ended:operator_command_untyped');
      expectLaws(entry, composed);
    }
  });

  it('run_ended: the command named mirrors the ending’s own prose, per ending kind (Amendment 16 (e); endedRunWayOut)', () => {
    const ended = (extra: Partial<RunRecord>): RunRecord =>
      ({ ...BASE, terminal_state: true, ...extra }) as RunRecord;
    const kinds: [string, RunRecord, string, string][] = [
      [
        'completed',
        ended({ sealed_by: { arm: 'complete' } } as Partial<RunRecord>),
        'start',
        'nothing is owed',
      ],
      [
        'completed, a cleanup step pending',
        ended({
          sealed_by: { arm: 'complete' },
          finalizer_ledger: { fin: { status: 'pending' } },
        } as unknown as Partial<RunRecord>),
        'drain',
        'realm run drain',
      ],
      [
        'failed, resume takes the step',
        ended({ sealed_by: { arm: 'step_failure' }, failed_steps: ['a'] } as Partial<RunRecord>),
        'resume',
        'realm run resume',
      ],
      [
        'failed, resume takes none',
        ended({ sealed_by: { arm: 'step_failure' }, failed_steps: ['fin'] } as Partial<RunRecord>),
        'purge',
        'previews what it would remove',
      ],
      [
        'aborted',
        ended({
          sealed_by: { arm: 'handler_abort' },
          aborted_at: AT.toISOString(),
        } as unknown as Partial<RunRecord>),
        'purge',
        'previews what it would remove',
      ],
    ];
    for (const [kind, record, command, words] of kinds) {
      const entry = listedOf(compose(record, ctxOf(W)), 'run_ended', 'advance');
      // (a) red when a branch of the command no longer follows the prose; (b) prints the kind, the
      //     command and whether the prose names it.
      const prose = terminalAnswerRefusalMessage(record, W, AT);
      expect(
        `${kind}: ${entry.no_remedy?.cause === 'operator_command_untyped' ? entry.no_remedy.command : ''} / prose names it: ${prose.includes(words)}`,
      ).toBe(`${kind}: ${command} / prose names it: true`);
    }
  });

  it('question_settled (snapshot): an answer to a question already answered — the progress ways, else already_settled', async () => {
    const d = gated();
    const { record, gateId } = await atQuestion(store, d);
    await submitHumanResponse(store, d, { runId: record.id, gateId, choice: 'approve' });
    const after = await store.get(record.id);
    const input = { run_id: record.id, gate_id: gateId, choice: 'approve' };
    const entry = refusalOf('respond', after, ctxOf(d), input);
    // (a) red when the settled test is removed (it falls to gate_not_open); (b) prints the code.
    expect(entry.code).toBe('question_settled');
    expect(UNAVAILABLE_CODES.question_settled.tag).toBe('snapshot');
    expect(factNames(entry)).toEqual(['gate_id']);
    expect(verbsOf(entry.remedy)).toEqual(['advance']);
    expectLaws(entry, compose(after, ctxOf(d)));
    // Nothing callable (the next step held elsewhere): already_settled.
    const held = { ...after, in_progress_steps: ['after'] } as RunRecord;
    const none = refusalOf('respond', held, ctxOf(d), input);
    expect(`${none.code}:${none.no_remedy?.cause}`).toBe('question_settled:already_settled');
    expectLaws(none, compose(held, ctxOf(d)));
  });

  it('question_due (snapshot): the question past its deadline with on_expiry declared — respond listed, remedy [advance]', async () => {
    const d = gated('settle_default');
    const { record } = await atQuestion(store, d);
    const composed = compose(record, ctxOf(d), pastDeadline(record));
    const entry = listedOf(composed, 'question_due', 'respond');
    // (a) red when the due test is removed (respond offered); (b) prints the code and remedy verbs.
    expect(UNAVAILABLE_CODES.question_due.tag).toBe('snapshot');
    expect(factNames(entry)).toEqual(['expires_at', 'gate_id', 'on_expiry', 'step']);
    expect(verbsOf(entry.remedy)).toEqual(['advance']);
    expect(composed.ways.some((w) => w.verb === 'respond')).toBe(false);
    expectLaws(entry, composed);
    // Before the deadline: offered, not listed.
    const before = compose(record, ctxOf(d), new Date(record.pending_gate!.opened_at));
    expect(before.ways.some((w) => w.verb === 'respond')).toBe(true);
  });

  it('question_past_deadline (write): an answer that reaches the question after its deadline — [advance] when owed, else already_settled', async () => {
    // settle_default, a step after it: the expiry leaves `after` owed.
    const owed = gated('settle_default');
    const { record, gateId } = await atQuestion(store, owed);
    const reply = await submitHumanResponse(store, owed, {
      runId: record.id,
      gateId,
      choice: 'reject',
      now: pastDeadline(record),
    });
    // (a) red when the expiry reply stops carrying the refusal; (b) prints the code and remedy verbs.
    expect(reply.refusal?.code).toBe('question_past_deadline');
    expect(UNAVAILABLE_CODES.question_past_deadline.tag).toBe('write');
    expect(factNames(reply.refusal!)).toEqual(['expires_at', 'gate_id', 'step']);
    expect(reply.refusal!.verb).toBe('respond');
    expect(verbsOf(reply.refusal!.remedy)).toEqual(['advance']);
    expectLaws(reply.refusal!, reply);
    // abort: the expiry ends the run — nothing is owed.
    const ending = gated('abort', { withAfter: false });
    const second = await atQuestion(store, ending);
    const endedReply = await submitHumanResponse(store, ending, {
      runId: second.record.id,
      gateId: second.gateId,
      choice: 'approve',
      now: pastDeadline(second.record),
    });
    expect(`${endedReply.refusal?.code}:${endedReply.refusal?.no_remedy?.cause}`).toBe(
      'question_past_deadline:already_settled',
    );
    expectLaws(endedReply.refusal!, endedReply);
  });

  it('gate_not_open (input): an answer naming a gate that is not the open one — [respond <the open gate>]; no gate open — [inspect]', async () => {
    const d = gated();
    const { record, gateId } = await atQuestion(store, d);
    const entry = refusalOf('respond', record, ctxOf(d), {
      run_id: record.id,
      gate_id: 'not-the-gate',
      choice: 'approve',
    });
    // (a) red when the open-gate test stops comparing the id; (b) prints the code and remedy keys.
    expect(entry.code).toBe('gate_not_open');
    expect(UNAVAILABLE_CODES.gate_not_open.tag).toBe('input');
    expect(entry.code === 'gate_not_open' ? entry.facts.open_gate?.gate_id === gateId : false).toBe(
      true,
    );
    expect(verbsOf(entry.remedy)).toEqual([`respond:${gateId}`]);
    expectLaws(entry, compose(record, ctxOf(d)));
    const none = refusalOf('respond', BASE, ctxOf(W), {
      run_id: 'r',
      gate_id: 'g',
      choice: 'approve',
    });
    expect(`${none.code}:${verbsOf(none.remedy).join(',')}`).toBe('gate_not_open:inspect');
    expectLaws(none, compose(BASE, ctxOf(W)));
  });

  it('not_a_step (input): a step the workflow does not have — the progress ways (the steps that exist)', () => {
    const entry = refusalOf('run_step', BASE, ctxOf(W), { run_id: 'r', command: 'zz' });
    // (a) red when the definition lookup is removed; (b) prints the code and remedy keys.
    expect(entry.code).toBe('not_a_step');
    expect(UNAVAILABLE_CODES.not_a_step.tag).toBe('input');
    expect(factNames(entry)).toEqual(['step', 'workflow_id']);
    expect(verbsOf(entry.remedy)).toEqual(['run_step:a:agent']);
    expectLaws(entry, compose(BASE, ctxOf(W)));
  });

  it('step_settled (snapshot) + NoRemedy already_settled: a step already completed, failed or skipped — nothing is left to do about it', () => {
    for (const [field, outcome] of [
      ['completed_steps', 'completed'],
      ['failed_steps', 'failed'],
      ['skipped_steps', 'skipped'],
    ] as const) {
      const record = { ...BASE, [field]: ['a'] } as RunRecord;
      const entry = refusalOf('run_step', record, ctxOf(W), { run_id: 'r', command: 'a' });
      // (a) red when the settled test is removed, or its no_remedy dropped; (b) prints the code,
      //     the outcome and the cause.
      expect(
        `${entry.code}:${entry.code === 'step_settled' ? entry.facts.outcome : ''}:${entry.no_remedy?.cause}`,
      ).toBe(`step_settled:${outcome}:already_settled`);
      expect(entry.remedy).toEqual([]);
      expect(UNAVAILABLE_CODES.step_settled.tag).toBe('snapshot');
      expectLaws(entry, compose(record, ctxOf(W)));
    }
  });

  it('question_open (snapshot): a step another step’s question holds, and abandon while it is open — remedy [respond]', async () => {
    const d = gated(undefined, { side: true });
    const { record, gateId } = await atQuestion(store, d);
    const composed = compose(record, ctxOf(d));
    // (a) red when the held steps stop being listed; (b) prints the codes listed.
    const held = listedOf(composed, 'question_open', 'run_step');
    expect(held.step).toBe('side');
    expect(verbsOf(held.remedy)).toEqual([`respond:${gateId}`]);
    expectLaws(held, composed);
    const abandon = listedOf(composed, 'question_open', 'abandon');
    expect(verbsOf(abandon.remedy)).toEqual([`respond:${gateId}`]);
    expectLaws(abandon, composed);
    expect(UNAVAILABLE_CODES.question_open.tag).toBe('snapshot');
    const byName = refusalOf('run_step', record, ctxOf(d), { run_id: record.id, command: 'after' });
    expect(byName.code).toBe('question_open');
    expectLaws(byName, composed);
  });

  it('question_open (abandon) at a question whose time is up: the answer is not offered — [advance], what carries out its expiry', async () => {
    const d = gated('settle_default');
    const { record } = await atQuestion(store, d);
    const composed = compose(record, ctxOf(d), pastDeadline(record));
    const abandon = listedOf(composed, 'question_open', 'abandon');
    // (a) red when the remedy stays [respond] though the answer is listed (question_due); (b) prints
    //     the remedy keys.
    expect(verbsOf(abandon.remedy)).toEqual(['advance']);
    expectLaws(abandon, composed);
  });

  it('gated_step (snapshot): the step whose own question is open, called by name — remedy [respond]', async () => {
    const d = gated();
    const { record } = await atQuestion(store, d);
    const entry = refusalOf('run_step', record, ctxOf(d), { run_id: record.id, command: 'q' });
    // (a) red when the own-question test is removed (it reads question_open); (b) prints the code.
    expect(entry.code).toBe('gated_step');
    expect(UNAVAILABLE_CODES.gated_step.tag).toBe('snapshot');
    expect(factNames(entry)).toEqual(['choices', 'gate_id', 'step']);
    expect(entry.remedy.map((w) => w.verb)).toEqual(['respond']);
    expectLaws(entry, compose(record, ctxOf(d)));
  });

  it('held_elsewhere (snapshot) + NoRemedy another_program_holds_it: a step another call holds — its deadline, or its age unknown; never a liveness word', () => {
    const deadline = '2026-10-16T12:05:00.000Z';
    const withDeadline = {
      ...BASE,
      in_progress_steps: ['a'],
      claims: { a: { deadline, token: 't' } },
    } as unknown as RunRecord;
    const composed = compose(withDeadline, ctxOf(W));
    const entry = listedOf(composed, 'held_elsewhere', 'run_step');
    // (a) red when the held steps stop being listed, the deadline is dropped, or the no_remedy is;
    // (b) prints the facts' deadline and the cause.
    expect(entry.code === 'held_elsewhere' ? entry.facts.deadline : undefined).toBe(deadline);
    expect(entry.clears_at).toBe(deadline);
    expect(entry.no_remedy).toEqual({ cause: 'another_program_holds_it' });
    expect(UNAVAILABLE_CODES.held_elsewhere.tag).toBe('snapshot');
    expectLaws(entry, composed);
    const unknown = { ...BASE, in_progress_steps: ['a'] } as RunRecord;
    const unknownComposed = compose(unknown, ctxOf(W));
    const unknownEntry = listedOf(unknownComposed, 'held_elsewhere', 'run_step');
    expect(
      unknownEntry.code === 'held_elsewhere' ? unknownEntry.facts.deadline : undefined,
    ).toEqual({ absent: 'unknown_age' });
    expect(unknownEntry.clears_at).toBeUndefined();
    expectLaws(unknownEntry, unknownComposed);
    // advance, refused for the same step; and the step by name.
    const advance = listedOf(unknownComposed, 'held_elsewhere', 'advance');
    expect(advance.no_remedy).toEqual({ cause: 'another_program_holds_it' });
    expectLaws(advance, unknownComposed);
    const byName = refusalOf('run_step', unknown, ctxOf(W), { run_id: 'r', command: 'a' });
    expect(`${byName.code}:${byName.no_remedy?.cause}`).toBe(
      'held_elsewhere:another_program_holds_it',
    );
    expect(byName.remedy).toEqual([]);
    expectLaws(byName, unknownComposed);
  });

  it('upstream_cannot_run (snapshot): a step whose dependency is refused before its claim — the upstream entry’s remedies (T-20 v)', () => {
    const record = { ...BASE, workflow_id: STRANDED.id } as RunRecord;
    const entry = refusalOf('run_step', record, ctxOf(STRANDED), { run_id: 'r', command: 'c' });
    // (a) red when the upstream walk is removed (it reads deps_unsettled), or the remedies are not
    //     the upstream entry's; (b) prints the code and the remedy keys.
    expect(entry.code).toBe('upstream_cannot_run');
    expect(UNAVAILABLE_CODES.upstream_cannot_run.tag).toBe('snapshot');
    expect(entry.code === 'upstream_cannot_run' ? [...entry.facts.upstream] : []).toEqual(['a']);
    expect(verbsOf(entry.remedy)).toEqual(['register:stranded']);
    expectLaws(entry, compose(record, ctxOf(STRANDED)));
  });

  it('deps_unsettled (snapshot): a step whose dependencies have not settled — the ways on its dependencies, else their entries’ act', () => {
    const entry = refusalOf('run_step', BASE, ctxOf(W), { run_id: 'r', command: 'x' });
    // (a) red when the dependency test is removed, or the remedy is not the way on the steps above;
    //     (b) prints the code, the deps and the remedy keys.
    expect(entry.code).toBe('deps_unsettled');
    expect(UNAVAILABLE_CODES.deps_unsettled.tag).toBe('snapshot');
    expect(entry.code === 'deps_unsettled' ? [...entry.facts.deps] : []).toEqual(['b']);
    // `b` waits on `a`: the way on is `a`'s.
    expect(verbsOf(entry.remedy)).toEqual(['run_step:a:agent']);
    expectLaws(entry, compose(BASE, ctxOf(W)));
    // `b`, its dependency `a` held elsewhere: `a`'s entry's act.
    const held = { ...BASE, in_progress_steps: ['a'] } as RunRecord;
    const waiting = refusalOf('run_step', held, ctxOf(W), { run_id: 'r', command: 'b' });
    expect(`${waiting.code}:${waiting.no_remedy?.cause}`).toBe(
      'deps_unsettled:another_program_holds_it',
    );
    expectLaws(waiting, compose(held, ctxOf(W)));
    // `x`, its dependency `b` owed to the engine: [advance].
    const owed = { ...BASE, completed_steps: ['a'] } as RunRecord;
    const onOwed = refusalOf('run_step', owed, ctxOf(W), { run_id: 'r', command: 'x' });
    expect(verbsOf(onOwed.remedy)).toEqual(['advance']);
    expectLaws(onOwed, compose(owed, ctxOf(W)));
  });

  it('not_eligible (snapshot) by name: a step whose dependencies settled but whose `when` is false — the progress ways, else already_settled', () => {
    const d: WorkflowDefinition = {
      id: 'when',
      name: 'when',
      version: 1,
      steps: {
        first: {
          description: 'first',
          execution: 'agent',
          depends_on: [],
          when: 'run.params.go == true',
        } as WorkflowDefinition['steps'][string],
      },
    };
    const record = { ...BASE, workflow_id: 'when' } as RunRecord;
    const entry = refusalOf('run_step', record, ctxOf(d), { run_id: 'r', command: 'first' });
    // (a) red when the eligibility test is removed (the step admitted), or the act is dropped; (b)
    //     prints the code and the cause.
    expect(
      `${entry.code}:${'step' in entry.facts ? entry.facts.step : ''}:${entry.no_remedy?.cause}`,
    ).toBe('not_eligible:first:already_settled');
    expectLaws(entry, compose(record, ctxOf(d)));
  });

  it('not_eligible (snapshot): advance with nothing owed — { reason: nothing_owed }, the offered steps its remedy (Amendment 13 Q11)', () => {
    const composed = compose(BASE, ctxOf(W));
    const entry = listedOf(composed, 'not_eligible', 'advance');
    // (a) red when advance is offered with nothing owed; (b) prints the code and remedy keys.
    expect(entry.facts).toEqual({ reason: 'nothing_owed' });
    expect(verbsOf(entry.remedy)).toEqual(['run_step:a:agent']);
    expect(UNAVAILABLE_CODES.not_eligible.tag).toBe('snapshot');
    expectLaws(entry, composed);
  });

  it('claim_removed (write): the step’s claim removed before its outcome was written — the fresh record’s progress ways, else why', async () => {
    const d: WorkflowDefinition = {
      id: 'cr',
      name: 'cr',
      version: 1,
      steps: { a: { description: 'a', execution: 'agent', depends_on: [] } },
    };
    const { run } = await store.create({ workflowId: d.id, workflowVersion: 1, params: {} });
    const reply = await executeStep(store, d, {
      runId: run.id,
      command: 'a',
      input: {},
      dispatcher: async () => {
        const mid = await store.get(run.id);
        await store.update({
          ...mid,
          claims: { ...mid.claims, a: { deadline: null, token: 'another-writer' } },
        });
        return {};
      },
    });
    // (a) red when the claim_lost reply stops carrying the refusal; (b) prints the code and cause.
    expect(reply.error_code).toBe('STATE_CLAIM_LOST');
    expect(reply.refusal?.code).toBe('claim_removed');
    expect(UNAVAILABLE_CODES.claim_removed.tag).toBe('write');
    expect(factNames(reply.refusal!)).toEqual(['step']);
    // Another call holds `a` now: nothing is offered; the wait is the act.
    expect(reply.refusal!.remedy).toEqual([]);
    expect(reply.refusal!.no_remedy).toEqual({ cause: 'another_program_holds_it' });
    expectLaws(reply.refusal!, reply);
  });

  it('refused_before_claim (snapshot): a step whose precondition fails — its check, remedy [register], offered', () => {
    const record = { ...BASE, workflow_id: STRANDED.id } as RunRecord;
    const composed = compose(record, ctxOf(STRANDED));
    const entry = listedOf(composed, 'refused_before_claim', 'run_step');
    // (a) red when the view's refusal stops being listed; (b) prints the check and remedy keys.
    expect(entry.code === 'refused_before_claim' ? entry.facts.check : undefined).toBe(
      'precondition',
    );
    expect(verbsOf(entry.remedy)).toEqual(['register:stranded']);
    expect(entry.no_remedy).toBeUndefined();
    expect(UNAVAILABLE_CODES.refused_before_claim.tag).toBe('snapshot');
    expectLaws(entry, composed);
  });

  it('refused_before_claim (input_schema): the lever on a step that consumes no input_map; a new run named where one can change the input (T-17, T-12)', () => {
    const lever = compose(BASE, ctxOf(LEVER));
    const onLever = listedOf(lever, 'refused_before_claim', 'run_step');
    // (a) red when the lever is withheld from a non-consuming step, or offered on a consuming one;
    //     (b) prints the remedy keys and the cause. `m` has no dependency: the engine gives it the
    //     run's params, so a new run can change its input (#688's rule).
    expect(verbsOf(onLever.remedy)).toEqual(['register:lever', 'run_step:m:auto']);
    expect(onLever.no_remedy).toEqual({ cause: 'operator_command_untyped', command: 'start' });
    expectLaws(onLever, lever);
    const mappedRecord = { ...BASE, params: { num: 5 } } as unknown as RunRecord;
    const mapped = compose(mappedRecord, ctxOf(MAPPED));
    const onMapped = listedOf(mapped, 'refused_before_claim', 'run_step');
    expect(verbsOf(onMapped.remedy)).toEqual(['register:mapped']);
    expect(onMapped.no_remedy).toEqual({ cause: 'operator_command_untyped', command: 'start' });
    expectLaws(onMapped, mapped);
  });

  it('capability_missing (snapshot): a step whose handler this program lacks — requires_other_program; an observer is offered advance on its condition', () => {
    const record = { ...BASE, workflow_id: HANDLED.id } as RunRecord;
    const ctx = ctxOf(HANDLED, {
      enactor: { kind: 'this_program', registry: new ExtensionRegistry() },
    });
    const composed = compose(record, ctx);
    const entry = listedOf(composed, 'capability_missing', 'run_step');
    // (a) red when the capability test is removed; (b) prints the facts' names and the cause.
    expect(factNames(entry)).toEqual(['basis', 'requirement', 'step']);
    expect(entry.no_remedy?.cause).toBe('requires_other_program');
    expect(UNAVAILABLE_CODES.capability_missing.tag).toBe('snapshot');
    expectLaws(entry, composed);
    // An observer cannot judge it: advance offered, on the condition that the enactor has it.
    const observed = compose(record, ctxOf(HANDLED));
    const advance = observed.ways.find((w) => w.verb === 'advance');
    // #627 W: `Cond` gained the client-tagged `client_prompt`, which has no basis.
    expect(advance?.conditions.map((c) => `${c.code}:${'basis' in c ? c.basis : c.tag}`)).toEqual([
      'enactor_has:unjudged',
    ]);
  });

  it('step_engine_decided (snapshot) + NoRemedy engine_runs_it_when_owed: a guard or cleanup step called by name — [advance] when owed, else the engine runs it when owed', () => {
    for (const [step, execution] of [
      ['gd', 'guard'],
      ['fin', 'finalizer'],
    ] as const) {
      const entry = refusalOf('run_step', BASE, ctxOf(W), { run_id: 'r', command: step });
      // (a) red when the execution test is removed, or the no_remedy dropped; (b) prints the code,
      //     the kind and the cause.
      expect(
        `${entry.code}:${entry.code === 'step_engine_decided' ? entry.facts.execution : ''}:${entry.no_remedy?.cause}`,
      ).toBe(`step_engine_decided:${execution}:engine_runs_it_when_owed`);
      expect(entry.remedy).toEqual([]);
      expect(UNAVAILABLE_CODES.step_engine_decided.tag).toBe('snapshot');
      expectLaws(entry, compose(BASE, ctxOf(W)));
    }
    const owed = { ...BASE, completed_steps: ['a'] } as RunRecord;
    const onOwed = refusalOf('run_step', owed, ctxOf(W), { run_id: 'r', command: 'gd' });
    expect(`${verbsOf(onOwed.remedy).join(',')}:${onOwed.no_remedy?.cause}`).toBe(
      'advance:undefined',
    );
    expectLaws(onOwed, compose(owed, ctxOf(W)));
  });

  it('enactor_load_failed (snapshot): a program whose project code failed to load runs nothing (A-5) — exempt, its facts name the error', () => {
    const ctx = ctxOf(W, { enactor: { kind: 'load_failed', error_code: 'uncoded' } });
    const composed = compose(BASE, ctx);
    // (a) red when the load-failed branch stops listing, or lists a blanket remedy; (b) prints the
    //     verbs listed and the remedy keys.
    for (const verb of ['advance', 'run_step']) {
      const entry = listedOf(composed, 'enactor_load_failed', verb);
      expect(factNames(entry)).toEqual(['error_code']);
      expect(entry.remedy).toEqual([]);
      expectLaws(entry, composed);
    }
    expect(composed.ways.some((w) => w.verb === 'run_step' || w.verb === 'advance')).toBe(false);
    expect(UNAVAILABLE_CODES.enactor_load_failed.tag).toBe('snapshot');
  });

  it('definition_absent (snapshot): a run whose workflow cannot be found — remedy [register], offered (A-5, T-21)', () => {
    const composed = compose(BASE, ABSENT);
    // (a) red when the absent branch stops listing; (b) prints the verbs listed.
    for (const verb of ['advance', 'run_step']) {
      const entry = listedOf(composed, 'definition_absent', verb);
      expect(factNames(entry)).toEqual(['cause', 'workflow_id']);
      expect(verbsOf(entry.remedy)).toEqual(['register:w']);
      expectLaws(entry, composed);
    }
    expect(UNAVAILABLE_CODES.definition_absent.tag).toBe('snapshot');
  });

  it('argument_out_of_contract (input): an argument outside the verb’s contract — the SAME way re-offered (P-5, INPUT_IN_CONTRACT_ADMITTED)', async () => {
    const composed = compose(BASE, ctxOf(W));
    const cases: [WayOn['verb'], Record<string, unknown>, string, string[]][] = [
      // advance is not offered (nothing owed): its own entry's act — the agent's step.
      ['advance', { run_id: 'r', bogus: 1 }, 'bogus', ['run_step:a:agent']],
      ['advance', {}, 'run_id', ['run_step:a:agent']],
      // the named step, offered, re-offered.
      ['run_step', { run_id: 'r', command: 'a', params: 'x' }, 'params', ['run_step:a:agent']],
      ['inspect', { run_id: 'r', extra: true }, 'extra', ['inspect']],
    ];
    for (const [verb, input, arg, remedy] of cases) {
      const entry = refusalOf(verb, BASE, ctxOf(W), input);
      // (a) red when the contract check is removed, or the remedy is not the same way; (b) prints the
      //     code, the argument's name and the remedy keys.
      expect(
        `${entry.code}:${entry.code === 'argument_out_of_contract' ? entry.facts.arg : ''}:${verbsOf(entry.remedy).join(',')}`,
      ).toBe(`argument_out_of_contract:${arg}:${remedy.join(',')}`);
      expectLaws(entry, composed);
    }
    // respond at an open question, its choice mistyped: the question's answer, with its Slot.
    const d = gated();
    const { record, gateId } = await atQuestion(store, d);
    const answer = refusalOf('respond', record, ctxOf(d), {
      run_id: record.id,
      gate_id: gateId,
      choice: 5,
    });
    expect(verbsOf(answer.remedy)).toEqual([`respond:${gateId}`]);
    const way = answer.remedy[0];
    expect(way?.verb === 'respond' ? [...way.choice.one_of] : []).toEqual(['approve', 'reject']);
    expectLaws(answer, compose(record, ctxOf(d)));
    expect(UNAVAILABLE_CODES.argument_out_of_contract.tag).toBe('input');
  });

  it('door_cannot_enact (door): a way no party this door serves can take is listed with why (the conservation law) — exempt', () => {
    const composed = compose(BASE, ABSENT);
    const mcp: DoorPolicy = {
      door: 'mcp',
      serves: ['agent', 'asked_person'],
      route: 'mcp',
      source: { kind: 'default', ref: 'test' },
    };
    const narrowed = narrowForDoor(composed, mcp);
    const entry = narrowed.unavailable.find(
      (u) => u.code === 'door_cannot_enact' && u.verb === 'register',
    );
    // (a) red when the narrowing drops a way without listing it; (b) prints the verb.
    expect(entry?.facts).toEqual({ door: 'mcp' });
    expect(entry?.remedy.map((w) => w.verb)).toEqual(['register']);
    expect(narrowed.ways.some((w) => w.verb === 'register')).toBe(false);
    expect(UNAVAILABLE_CODES.door_cannot_enact.tag).toBe('door');
    expectLaws(entry!, narrowed);
  });
});

// ─── The sweep and R26, over curated run states ─────────────────────────────────────────────────

interface State {
  name: string;
  definition: WorkflowDefinition | undefined;
  record: RunRecord;
  ctx: WaysContext;
  at: Date;
}

/** The curated states: each code's producing state, and the crosses the codes' cells name. */
async function curatedStates(): Promise<State[]> {
  const store = await newStore();
  const s = (
    name: string,
    definition: WorkflowDefinition | undefined,
    record: RunRecord,
    ctx: WaysContext,
    at: Date = AT,
  ): State => ({ name, definition, record, ctx, at });
  const held = { ...BASE, in_progress_steps: ['a'] } as RunRecord;
  const gatedSide = gated(undefined, { side: true });
  const open = await atQuestion(store, gatedSide);
  const timed = gated('settle_default');
  const due = await atQuestion(store, timed);
  const plain = gated();
  const answered = await atQuestion(store, plain);
  await submitHumanResponse(store, plain, {
    runId: answered.record.id,
    gateId: answered.gateId,
    choice: 'approve',
  });
  const afterAnswer = await store.get(answered.record.id);
  const { run } = await store.create({ workflowId: W.id, workflowVersion: 1, params: {} });
  await abandonRun(store, run.id, 'test');
  const ended = await store.get(run.id);
  const loadFailed = ctxOf(W, { enactor: { kind: 'load_failed', error_code: 'uncoded' } });
  // A step that fails, on a real call: the run stays open, its dependents are skipped.
  const boom = new ExtensionRegistry();
  boom.register('handler', 'boom', {
    id: 'boom',
    execute: async () => {
      throw new Error('fixture: the handler fails');
    },
  });
  const failing = await store.create({ workflowId: FAILING.id, workflowVersion: 1, params: {} });
  await executeStep(store, FAILING, {
    runId: failing.run.id,
    command: 'f',
    input: {},
    registry: boom,
  });
  const failed = await store.get(failing.run.id);
  return [
    s('fresh', W, BASE, ctxOf(W)),
    s('held, unknown age', W, held, ctxOf(W)),
    s(
      'held, deadline',
      W,
      {
        ...BASE,
        in_progress_steps: ['a'],
        claims: { a: { deadline: '2026-10-16T12:05:00.000Z', token: 't' } },
      } as unknown as RunRecord,
      ctxOf(W),
    ),
    s('a completed (b owed)', W, { ...BASE, completed_steps: ['a'] } as RunRecord, ctxOf(W)),
    s(
      'a, b completed (x owed)',
      W,
      { ...BASE, completed_steps: ['a', 'b'] } as RunRecord,
      ctxOf(W),
    ),
    s(
      'a step failed (the run open)',
      FAILING,
      failed,
      ctxOf(FAILING, { enactor: { kind: 'this_program', registry: boom } }),
    ),
    s('stranded', STRANDED, { ...BASE, workflow_id: STRANDED.id } as RunRecord, ctxOf(STRANDED)),
    s(
      'capability missing here',
      HANDLED,
      { ...BASE, workflow_id: HANDLED.id } as RunRecord,
      ctxOf(HANDLED, { enactor: { kind: 'this_program', registry: new ExtensionRegistry() } }),
    ),
    s(
      'capability unjudged',
      HANDLED,
      { ...BASE, workflow_id: HANDLED.id } as RunRecord,
      ctxOf(HANDLED),
    ),
    s('lever', LEVER, BASE, ctxOf(LEVER)),
    s('mapped', MAPPED, { ...BASE, params: { num: 5 } } as unknown as RunRecord, ctxOf(MAPPED)),
    s('question open', gatedSide, open.record, ctxOf(gatedSide)),
    s('question due', timed, due.record, ctxOf(timed), pastDeadline(due.record)),
    s(
      'question due, load failed',
      timed,
      due.record,
      ctxOf(timed, { enactor: loadFailed.enactor }),
      pastDeadline(due.record),
    ),
    s('question answered', plain, afterAnswer, ctxOf(plain)),
    s(
      'question answered, next held',
      plain,
      { ...afterAnswer, in_progress_steps: ['after'] } as RunRecord,
      ctxOf(plain),
    ),
    s('ended', W, ended, ctxOf(W)),
    s('definition absent', undefined, BASE, ABSENT),
    s('definition absent, question open', undefined, open.record, ABSENT),
    s('load failed', W, BASE, loadFailed),
  ];
}

/** Every (verb, input) a caller could send on a state: each gate id, each step, a stranger of each. */
function candidates(state: State): [WayOn['verb'], Record<string, unknown>][] {
  const runId = state.record.id;
  const gates = new Set<string>(['not-a-gate']);
  if (state.record.pending_gate !== undefined) gates.add(state.record.pending_gate.gate_id);
  for (const entry of Object.values(state.record.settled ?? {})) {
    if (entry.outcome === 'gate' && typeof entry.token === 'string') gates.add(entry.token);
  }
  const steps = [...Object.keys(state.definition?.steps ?? {}), 'zz'];
  return [
    ...[...gates].map((gate): [WayOn['verb'], Record<string, unknown>] => [
      'respond',
      { run_id: runId, gate_id: gate, choice: 'approve' },
    ]),
    ...steps.map((step): [WayOn['verb'], Record<string, unknown>] => [
      'run_step',
      { run_id: runId, command: step },
    ]),
    ['advance', { run_id: runId }],
    ['abandon', { run_id: runId }],
    ['inspect', { run_id: runId }],
  ];
}

describe('#729 PR-0 — the laws over curated run states', () => {
  it('REFUSAL_ENDS_IN_AN_ACT, REMEDY_IS_JUDGED and rule 10 hold on every listed entry and every refusal', async () => {
    // (a) red when any code's act is dropped (a remedy offered nowhere, no why named); (b) prints the
    //     state's name, the code, the verb, the step and the remedy verbs.
    const found: string[] = [];
    for (const state of await curatedStates()) {
      const snap = writtenSnapshot(state.record, state.at);
      const composed = composeWaysOn(snap, state.ctx);
      for (const entry of composed.unavailable) {
        found.push(...lawViolations(entry, composed, `[${state.name}] `));
      }
      for (const [verb, input] of candidates(state)) {
        const admission = admitWay(verb, snap, state.ctx, input);
        if (!('ok' in admission)) {
          found.push(...lawViolations(admission, composed, `[${state.name}] ${verb}: `));
        }
      }
    }
    expect(found).toEqual([]);
  });

  it('OFFER_EQUALS_ADMISSION (R26): the offered progress, abandon and inspect ways equal the admitted candidates — the held auto-step exception named (Amendment 13 Q3)', async () => {
    for (const state of await curatedStates()) {
      const snap = writtenSnapshot(state.record, state.at);
      const composed = composeWaysOn(snap, state.ctx);
      const admitted: string[] = [];
      const autoByName: string[] = [];
      for (const [verb, input] of candidates(state)) {
        if (!('ok' in admitWay(verb, snap, state.ctx, input))) continue;
        if (verb === 'respond') admitted.push(`respond:${String(input['gate_id'])}`);
        else if (verb === 'run_step') {
          const step = String(input['command']);
          if (state.definition?.steps[step]?.execution === 'agent') {
            admitted.push(`run_step:${step}:agent`);
          } else autoByName.push(step);
        } else admitted.push(verb);
      }
      const offered = composed.ways
        .filter(
          (w) => w.verb !== 'register' && !(w.verb === 'run_step' && w.brief.execution !== 'agent'),
        )
        .map(keyOf);
      // (a) red when a judge offers a way its admission refuses, or admits one it does not offer;
      //     (b) prints the state's name and both sets of keys (ids, verbs).
      expect(admitted.sort(), `[${state.name}] admitted vs offered`).toEqual(offered.sort());
      // #627 W (cell 31): the same law at the MCP door's fallback row, where the agent's `respond`
      // carries the `client_prompt` condition. No argument discharges it and admission does not
      // wait on it — the client discharges it outside Realm (`tag: 'client'`) — so `client`-tagged
      // conditions are filtered out of the compared set: then the door offers the agent exactly
      // the ways (and the conditions) the composition offers. That admission never waits on the
      // condition holds by STRUCTURE, not by this cell: `admitWay` takes no door policy, so no
      // core red can make it wait (correction 1, C5d). The red this cell runs: (a) the door adds
      // a Realm-judged condition beside `client_prompt` (break c37), or the filter is dropped (the
      // fallback respond's extra condition shows); (b) prints the state's name and each way's key
      // with its conditions.
      const withConds = (w: WayOn): string =>
        `${keyOf(w)}|${JSON.stringify(
          w.conditions.filter(
            (c) => !('tag' in c && (COND_TAGS as readonly string[]).includes(c.tag)),
          ),
        )}`;
      const fallback = narrowForDoor(composed, FALLBACK_DOOR);
      const atDoor = fallback.ways
        .filter(
          (w) =>
            w.for.includes('agent') &&
            w.verb !== 'register' &&
            !(w.verb === 'run_step' && w.brief.execution !== 'agent'),
        )
        .map(withConds);
      const composedOffered = composed.ways
        .filter(
          (w) => w.verb !== 'register' && !(w.verb === 'run_step' && w.brief.execution !== 'agent'),
        )
        .map(withConds);
      expect(atDoor.sort(), `[${state.name}] fallback door vs composition`).toEqual(
        composedOffered.sort(),
      );
      // Q3 HELD: an eligible auto step a caller names is admitted as today, never offered (advance
      // is the act) — exactly the auto steps advance owes.
      const owed = composed.ways.flatMap((w) =>
        w.verb === 'advance' ? w.owed.flatMap((o) => ('step' in o ? [o.step] : [])) : [],
      );
      expect(autoByName.sort(), `[${state.name}] auto steps admitted by name`).toEqual(
        owed.filter((step) => state.definition?.steps[step]?.execution === 'auto').sort(),
      );
    }
  });

  it('OFFER_EQUALS_ADMISSION for the lever (T-17, INPUT_IN_CONTRACT_ADMITTED): admitted with input that fits its input_schema, refused with input that does not', () => {
    const snap = writtenSnapshot(BASE, AT);
    const composed = composeWaysOn(snap, ctxOf(LEVER));
    expect(verbsOf(composed.ways)).toContain('run_step:m:auto');
    const fits = admitWay('run_step', snap, ctxOf(LEVER), {
      run_id: 'r',
      command: 'm',
      params: { n: 'text' },
    });
    // (a) red when admission ignores the operator's input (the lever offered, never admitted); (b)
    //     prints ok or the code.
    expect('ok' in fits ? 'ok' : fits.code).toBe('ok');
    const misfits = admitWay('run_step', snap, ctxOf(LEVER), {
      run_id: 'r',
      command: 'm',
      params: { n: 5 },
    });
    expect('ok' in misfits ? 'ok' : misfits.code).toBe('refused_before_claim');
    const none = admitWay('run_step', snap, ctxOf(LEVER), { run_id: 'r', command: 'm' });
    expect('ok' in none ? 'ok' : none.code).toBe('refused_before_claim');
  });
});

// ─── agent_action: D-8 as an ordered table (D3 A-2, D4 T-22; Amendment 12) ──────────────────────

/** A rendered list: the callable progress verbs, whether the run ended, whether only others hold it. */
const rendered = (
  callable: ProgressVerb[],
  opts: { ended?: boolean; waits?: boolean } = {},
): RenderedList => ({
  callable,
  run_ended: opts.ended === true,
  only_waits_on_others: opts.waits === true,
});

describe('#729 PR-0 — agent_action: agentActionOf is D-8’s ordered table, row by row', () => {
  it('row 1 + 3: an intrinsic stop, provide_input, wait_and_proceed or wait_for_service passes through, whatever is callable — before row 4 routes a blocked reply by the list', () => {
    // (a) red when a pass-through member is routed by the list instead (on a blocked reply, row 4
    //     would say resolve_precondition beside a callable way); (b) prints the words.
    for (const intrinsic of [
      'stop',
      'provide_input',
      'wait_and_proceed',
      'wait_for_service',
    ] as const) {
      expect([
        agentActionOf(intrinsic, 'error', rendered(['advance'])),
        agentActionOf(intrinsic, 'error', rendered([])),
        agentActionOf(intrinsic, 'blocked', rendered(['advance'])),
      ]).toEqual([intrinsic, intrinsic, intrinsic]);
    }
  });

  it('row 2: ok / confirm_required carry none — an intrinsic stop passes (C154); T-22: ok on an open run with nothing callable takes row 4’s tail', () => {
    // (a) red when ok gains a word beside a callable way, loses C154's stop, or T-22's tail is
    //     dropped; (b) prints the words.
    expect({
      okCallable: agentActionOf(undefined, 'ok', rendered(['run_step'])),
      confirm: agentActionOf(undefined, 'confirm_required', rendered([])),
      okStop: agentActionOf('stop', 'ok', rendered([], { ended: true })),
      okEnded: agentActionOf(undefined, 'ok', rendered([], { ended: true })),
      okNothing: agentActionOf(undefined, 'ok', rendered([])),
      okWaits: agentActionOf(undefined, 'ok', rendered([], { waits: true })),
    }).toEqual({
      okCallable: undefined,
      confirm: undefined,
      okStop: 'stop',
      okEnded: undefined,
      okNothing: 'report_to_user',
      okWaits: 'await',
    });
  });

  it('row 4: a blocked or pre-claim refusal reply — stop if ended; resolve_precondition iff callable; await if only others hold it; else report_to_user', () => {
    // (a) red when any arm of the order changes; (b) prints the words per kind.
    for (const kind of ['blocked', 'refusal'] as const) {
      expect({
        ended: agentActionOf(undefined, kind, rendered(['run_step'], { ended: true })),
        callable: agentActionOf(undefined, kind, rendered(['run_step'])),
        waits: agentActionOf(undefined, kind, rendered([], { waits: true })),
        nothing: agentActionOf(undefined, kind, rendered([])),
      }).toEqual({
        ended: 'stop',
        callable: 'resolve_precondition',
        waits: 'await',
        nothing: 'report_to_user',
      });
    }
  });

  it('row 5: an error whose intrinsic is resolve_precondition survives only beside a callable way', () => {
    // (a) red when FIT4-4's literal survives with nothing to call; (b) prints the words.
    expect([
      agentActionOf('resolve_precondition', 'error', rendered(['advance'])),
      agentActionOf('resolve_precondition', 'error', rendered([])),
    ]).toEqual(['resolve_precondition', 'report_to_user']);
  });

  it('row 6: any other intrinsic passes — report_to_user stays, even beside a callable way (the two gate-mismatch errors)', () => {
    // (a) red when report_to_user is routed by the list; (b) prints the word.
    expect(agentActionOf('report_to_user', 'error', rendered(['respond']))).toBe('report_to_user');
  });

  it('the fan-out case: a step held elsewhere while another is eligible — resolve_precondition, the other offered', () => {
    const record = { ...BASE, in_progress_steps: ['a'] } as RunRecord;
    const d: WorkflowDefinition = {
      id: 'fan',
      name: 'fan',
      version: 1,
      steps: {
        a: { description: 'a', execution: 'agent', depends_on: [] },
        b: { description: 'b', execution: 'agent', depends_on: [] },
      },
    };
    const composed = compose(record, ctxOf(d));
    const narrowed = narrowForDoor(composed, {
      door: 'mcp',
      serves: ['agent', 'asked_person'],
      route: 'mcp',
      source: { kind: 'default', ref: 'test' },
    });
    const list = agentRenderedList(narrowed, false);
    // (a) red when the held step's refusal hides the other step, or routes to await; (b) prints
    //     the callable verbs and the word.
    expect({
      callable: list.callable,
      offered: narrowed.ways.filter((w) => w.verb === 'run_step').map((w) => keyOf(w)),
      word: agentActionOf(undefined, 'blocked', list),
    }).toEqual({
      callable: ['run_step'],
      offered: ['run_step:b:agent'],
      word: 'resolve_precondition',
    });
  });

  it('Amendment 12: an error reply’s action word is set once, where the reply is composed, from its error — the setters, enumerated', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./execution-loop.ts', import.meta.url)),
      'utf8',
    );
    const setters = [...source.matchAll(/intrinsic_action: ([^,\n}]+)/g)].map((m) => m[1]!.trim());
    // (a) red when a site sets the word from anything but its error (resolved per A-2 row 1), a
    //     literal anchor or a pass-through — e.g. a second site rewriting an error's word after the
    //     reply was composed; (b) prints the setters' expressions.
    expect(setters.sort()).toEqual(
      [
        // the error the reply is composed from (errorEnvelope; the guard settle's refusal)
        'err.agentAction',
        'err.agentAction',
        // A-2 row 1: the error's word as resolved before / after the dispatch
        'resolvePreExecutionAgentAction(err)',
        'resolvePreExecutionAgentAction(err)',
        'blockedAction',
        'migratedEffectiveAction',
        'effectiveAction',
        // the two guard-persist failures (no error object; their word is the mint's literal)
        "'stop' as const",
        "'stop' as const",
        // the three ended-run anchors on ok replies (D-8 row 2, C154)
        "'stop' as const",
        "'stop' as const",
        "'stop' as const",
        // composeAfterRaces carries the reply's own word through
        '_action',
        '_action ',
      ]
        .map((e) => e.trim())
        .sort(),
    );
  });

  it('G5-7: the engine runs a step whose input schema refuses the engine’s input — report_to_user, minted so (never provide_input); a caller’s own input keeps provide_input', async () => {
    const store = await newStore();
    const { run } = await store.create({ workflowId: LEVER.id, workflowVersion: 1, params: {} });
    const engine = await executeEngineStep(store, LEVER, { runId: run.id, step: 'm', run });
    // (a) red when the engine's refusal is minted provide_input; (b) prints the code and words.
    expect({
      code: engine.error_code,
      intrinsic: engine.intrinsic_action,
      refusal: engine.refusal?.code,
      word: agentActionOf(engine.intrinsic_action, engine.reply_kind ?? 'error', rendered([])),
    }).toEqual({
      code: 'VALIDATION_INPUT_SCHEMA',
      intrinsic: 'report_to_user',
      refusal: 'refused_before_claim',
      word: 'report_to_user',
    });
    // CONTROL: the same step called by name with the caller's input — the caller can fix it.
    const caller = await executeStep(store, LEVER, {
      runId: run.id,
      command: 'm',
      input: { n: 5 },
      dispatcher: async () => ({}),
    });
    expect(caller.intrinsic_action).toBe('provide_input');
  });
});

// ─── DESIGN-PLAN A.3, do-not-regress (#3, #7) ───────────────────────────────────────────────────

describe('#729 PR-0 — A.3 shipped strengths PR-0 owns', () => {
  it('#3: an April-shaped record (no claims, no token, a bare gate) — the answer offered with no proof, and admitted', () => {
    const april = {
      ...BASE,
      workflow_id: 'gated-none',
      in_progress_steps: ['q'],
      pending_gate: {
        gate_id: 'g-april',
        step_name: 'q',
        preview: {},
        choices: ['approve', 'reject'],
        opened_at: '2026-04-02T09:00:00.000Z',
      },
    } as unknown as RunRecord;
    const d = gated();
    const composed = compose(april, { ...ctxOf(d), store: {} });
    const respond = composed.ways.find((w) => w.verb === 'respond');
    const admission = admitWay('respond', writtenSnapshot(april, AT), ctxOf(d), {
      run_id: 'r',
      gate_id: 'g-april',
      choice: 'approve',
    });
    // (a) red when an old record's question is refused or demands a token; (b) prints the verdicts.
    expect({
      offered: respond !== undefined ? keyOf(respond) : undefined,
      proof: respond?.verb === 'respond' ? respond.proof !== undefined : undefined,
      admitted: 'ok' in admission ? 'ok' : admission.code,
    }).toEqual({ offered: 'respond:g-april', proof: false, admitted: 'ok' });
  });

  it('#7: the whole eligible set is offered to a concurrent runner — every agent step, and advance for what the engine owes', () => {
    const d: WorkflowDefinition = {
      id: 'set',
      name: 'set',
      version: 1,
      steps: {
        a: { description: 'a', execution: 'agent', depends_on: [] },
        b: { description: 'b', execution: 'agent', depends_on: [] },
        c: { description: 'c', execution: 'auto', depends_on: [] },
      },
    };
    const composed = compose(BASE, ctxOf(d));
    const advance = composed.ways.find((w) => w.verb === 'advance');
    // (a) red when the set is cut to one step, or the owed step is dropped; (b) prints the keys.
    expect({
      progress: composed.ways
        .filter((w) => w.verb === 'run_step' || w.verb === 'advance')
        .map(keyOf)
        .sort(),
      owed: advance?.verb === 'advance' ? advance.owed : undefined,
    }).toEqual({
      progress: ['advance', 'run_step:a:agent', 'run_step:b:agent'],
      owed: [{ step: 'c' }],
    });
  });
});

// ─── The library door (Amendment 14 Q12/Q13; PR0-CONTRACT §5; Q8) ───────────────────────────────

describe('#729 PR-0 — the library door', () => {
  it('Q12: the lever is enacted through the library — executeStep with an operator’s input that fits runs the engine step', async () => {
    const store = await newStore();
    const { run } = await store.create({ workflowId: LEVER.id, workflowVersion: 1, params: {} });
    const before = compose(await store.get(run.id), ctxOf(LEVER));
    const lever = before.ways.find((w) => w.verb === 'run_step' && w.step === 'm');
    const reply = await executeStep(store, LEVER, {
      runId: run.id,
      command: 'm',
      input: { n: 'from the operator' },
      dispatcher: async (_step, input) => ({ ...input }),
    });
    // (a) red when the lever is offered but the library refuses the input that fits; (b) prints
    //     the offer, the status and the run's completed steps.
    expect({
      offered: lever !== undefined ? keyOf(lever) : undefined,
      words:
        lever !== undefined ? LIBRARY_WORDS.run_step(lever as never, undefined, {}) : undefined,
      status: reply.status,
      completed: (await store.get(run.id)).completed_steps,
    }).toEqual({
      offered: 'run_step:m:auto',
      words:
        "supply step 'm''s input with executeStep — an operator's input, checked against its input_schema",
      status: 'ok',
      completed: ['m'],
    });
  });

  it('LIBRARY_WORDS: each verb in the library’s own functions, from the way alone — never a CLI command or an MCP tool', () => {
    const composed = compose({ ...BASE, completed_steps: ['a'] } as RunRecord, ctxOf(W));
    const absent = compose(BASE, ABSENT);
    const ways = [...composed.ways, ...absent.ways.filter((w) => w.verb === 'register')];
    const words = ways.map((w) =>
      (LIBRARY_WORDS[w.verb] as (way: WayOn, b: undefined, h: object) => string | null)(
        w,
        undefined,
        {},
      ),
    );
    const FOREIGN =
      /\brealm (run|workflow)\b|execute_step|advance_run|submit_human_response|get_run_state|abandon_run/;
    // (a) red when a door's word leaks into the library's, or a verb's function changes; (b)
    //     prints the verbs and the library functions named.
    expect({
      foreign: words.filter((t) => t !== null && FOREIGN.test(t)),
      functions: ways.map((w, i) => [
        w.verb,
        /\b(advanceRun|executeStep|abandonRun|submitHumanResponse|store)\b/.exec(
          words[i] ?? '',
        )?.[1] ?? null,
      ]),
    }).toEqual({
      foreign: [],
      functions: [
        ['inspect', 'store'],
        ['advance', 'advanceRun'],
        ['abandon', 'abandonRun'],
        ['register', null],
      ],
    });
  });

  it('Q13: who supplied an entry’s input — agent on an agent step’s entry; engine_input on an engine step’s; not_recorded on an agent entry written before the field', async () => {
    const store = await newStore();
    const d: WorkflowDefinition = {
      id: 'sup',
      name: 'sup',
      version: 1,
      steps: {
        a: { description: 'a', execution: 'agent', depends_on: [] },
        e: { description: 'e', execution: 'auto', depends_on: ['a'] },
      },
    };
    const { run } = await store.create({ workflowId: d.id, workflowVersion: 1, params: {} });
    await executeStep(store, d, {
      runId: run.id,
      command: 'a',
      input: {},
      dispatcher: async () => ({}),
    });
    await executeStep(store, d, {
      runId: run.id,
      command: 'e',
      input: {},
      dispatcher: async () => ({}),
    });
    const evidence = (await store.get(run.id)).evidence;
    const of = (step: string) => evidence.find((e) => e.step_id === step)!;
    const { supplied_by: _gone, ...older } = of('a');
    // (a) red when the agent's entry loses its role, or an absence is told as a role; (b) prints
    //     the readings.
    expect([readSupplier(of('a'), d), readSupplier(of('e'), d), readSupplier(older, d)]).toEqual([
      { role: 'agent' },
      { absent: 'engine_input' },
      { absent: 'not_recorded' },
    ]);
  });

  it('Q8: the basis names the definition by its workflow id, or why it is absent — never its version', () => {
    // (a) red when the basis carries the author's version, or loses the absence's cause; (b)
    //     prints both.
    expect([
      basisOf(writtenSnapshot(BASE, AT), ctxOf(W)).definition,
      basisOf(writtenSnapshot(BASE, AT), ABSENT).definition,
    ]).toEqual([{ workflow_id: 'w' }, { absent: 'not_registered' }]);
  });
});
