// ways-renderer.ts — issue #729 PR-0 (PR0-CONTRACT §5; D2 §5, D3 A-10, A-14, A-27, D4 T-7, T-17,
// T-20): the CLI door's ONE renderer of the ways. Core composes what can be done next as data
// (`ways`, `unavailable`); this module turns each into the command an operator types and the lines
// a CLI command prints about a run that cannot go on. No CLI command composes those words itself.
//
// The renderer law (§5, A-27): an entry takes ONE way (or the entries of one composition), its basis
// stamp and the host's static settings — never a record, view, definition, registry, clock or
// snapshot. The import census and a source-text ban on the clock witness it. Values through
// `shellWord`; a `Slot` printed as its one value or `<one of: …>` with each member quoted (T-7); no
// full stop after a printed command (C212).
import {
  cannotGoOnFrom,
  cannotGoOnUntilCorrected,
  oneOf,
  sentenceEnd,
  shellWord,
  withFullStop,
  type Basis,
  type ComposedWays,
  type ForWay,
  type RunPhase,
  type Unavailable,
  type WayOf,
  type WayOn,
  type WayRenderer,
} from '@sensigo/realm';

/**
 * The CLI door's static settings. `driveFlags`: the flags a drive was started with, as shell words —
 * built by the ONE function `buildReattachFlags` (`agent.ts`) and read by every printer of a drive
 * command; empty when the printer has none (the model's placeholders are printed then: since #676
 * `realm agent` refuses to start without a model).
 */
export interface CliHost {
  driveFlags: string;
}

/** A host with no drive flags. */
export const NO_DRIVE_FLAGS: CliHost = { driveFlags: '' };

/**
 * The CLI door's command for each verb (PR0-CONTRACT §5, Amendment 4) — what an operator types to
 * take the way, from the way alone; `null` where no realm command takes it:
 * - `respond`: `realm run respond <run> --gate <gate> --choice <Slot>` (C206, T-7);
 * - `run_step`: an agent step is driven by `realm agent --run-id <run>` with the drive's flags; an
 *   engine step's input supplied by an operator (T-17's lever) has no command (PR0-CONTRACT
 *   Amendment 14: a fact line, `operatorInputLine`);
 * - `advance`, `inspect`, `abandon`: `realm run <verb> <run>` (`abandon` with `--gate <gate>` when the
 *   way names the gate of a question that can never be answered, #819 U1);
 * - `register`: `realm workflow register <file>` — the file's path when the registry knows it;
 * - `present` (#627 W): `null` — showing a question again as a form in a chat app is the MCP door's
 *   alone (its party is the agent, whom this door does not serve: `door_cannot_enact` here); a person
 *   at a terminal reads the question with `realm run inspect`.
 */
export const CLI_COMMANDS: WayRenderer<string, CliHost> = {
  respond: (way) =>
    `realm run respond ${way.run_id} --gate ${way.gate_id} --choice ${oneOf(way.choice.one_of)}`,
  run_step: (way, _basis, host) => {
    // T-17 / Amendment 14: no realm command supplies an engine step's input.
    if (way.brief.execution !== 'agent') return null;
    // C89: the drive's own flags (`buildReattachFlags` builds them with the model), else the model's
    // placeholders — on the printing line, as the drive-command witness reads it.
    return `realm agent --run-id ${way.run_id} ${host.driveFlags !== '' ? host.driveFlags : '--provider <provider> --model <model>'}`;
  },
  advance: (way) => `realm run advance ${way.run_id}`,
  inspect: (way) => `realm run inspect ${way.run_id}`,
  // #819 (U1): with the gate of a question that can never be answered.
  abandon: (way) =>
    `realm run abandon ${way.run_id}${way.gate_id !== undefined ? ` --gate ${way.gate_id}` : ''}`,
  // Correction 2 (3.2): `path` is the registered COPY that cannot be used — `register` takes a source,
  // so the command for it reads why the copy cannot be used and its way out.
  register: (way) =>
    way.path !== undefined
      ? `realm workflow validate --registered ${shellWord(way.workflow_id)}`
      : 'realm workflow register <file>',
  // #627 W: no realm command shows a question as a chat app's form (see above).
  present: () => null,
};

/** One way's command on this door, or `null` when no command takes it. */
export function cliCommandOf(
  way: WayOn,
  basis?: Basis,
  host: CliHost = NO_DRIVE_FLAGS,
): string | null {
  const render = CLI_COMMANDS[way.verb] as (
    w: WayOn,
    b: Basis | undefined,
    h: CliHost,
  ) => string | null;
  return render(way, basis, host);
}

/** The command of the first way of `verb` in a composition (narrowed or not), or `undefined`. */
function commandOfVerb(
  ways: readonly (WayOn | ForWay)[],
  verb: WayOn['verb'],
  host: CliHost = NO_DRIVE_FLAGS,
): string | undefined {
  const way = ways.find((w) => w.verb === verb);
  return way === undefined ? undefined : (cliCommandOf(way, undefined, host) ?? undefined);
}

// ─── A step that cannot run (C36, C41, C53, C82; T-17; T-20) ────────────────────────────────────

/** The entries of a composition for steps that cannot run: refused before their claim, or a capability. */
export function cannotRunEntries(composed: Pick<ComposedWays, 'unavailable'>): Unavailable[] {
  return composed.unavailable.filter(
    (u) =>
      u.verb === 'run_step' &&
      (u.code === 'refused_before_claim' || u.code === 'capability_missing'),
  );
}

/**
 * The parts of a step-that-cannot-run entry, as every line names them: its step, the check that
 * refuses it (`trust`, `precondition`, `input_schema`, `capability`), the refusal's own words (a
 * capability's: what this program lacks, or what the runner that last attempted it lacked — C41),
 * and whether it was judged from the run's marker.
 */
export function cannotRunParts(
  entry: Unavailable,
): { step: string; check: string; refusal: string; marker: boolean } | undefined {
  if (entry.code === 'capability_missing') {
    const { kind, name } = entry.facts.requirement;
    const marker = entry.facts.basis === 'marker';
    return {
      step: entry.facts.step,
      check: 'capability',
      refusal: marker
        ? `${kind} '${name}' was not registered in the runner that last attempted it`
        : `${kind} '${name}' is not registered here`,
      marker,
    };
  }
  if (entry.code === 'refused_before_claim') {
    return {
      step: entry.facts.step,
      check: entry.facts.check,
      refusal: entry.facts.refusal,
      marker: false,
    };
  }
  return undefined;
}

/**
 * `'<s>' cannot run (<check>): <refusal>` — one step that cannot run, as every line names it (C36):
 * `cannot run here (capability)` for a capability this program's registry lacks, with its way out
 * (C53: load the missing extension, or run the step on a runner that has it); `could not run
 * (capability)` judged from the run's own marker (C41).
 */
export function cannotRunClause(entry: Unavailable): string {
  const parts = cannotRunParts(entry);
  if (parts === undefined) return `'${entry.step ?? ''}' cannot run`;
  const words =
    parts.check !== 'capability'
      ? `cannot run (${parts.check})`
      : parts.marker
        ? 'could not run (capability)'
        : 'cannot run here (capability)';
  const clause = `'${parts.step}' ${words}: ${parts.refusal}`;
  return parts.check === 'capability' && !parts.marker
    ? `${clause} — load the missing extension, or run the step on a runner that has it`
    : clause;
}

/**
 * The way out of a capability judged from the run's marker (C53): run the step from a program that
 * has the extension — ` — from a program that has it: realm run advance <id>`.
 */
export function capabilityMarkerWayOut(runId: string): string {
  return ` — from a program that has it: ${CLI_COMMANDS.advance({ verb: 'advance', conditions: [], run_id: runId, owed: [] }, undefined, NO_DRIVE_FLAGS)}`;
}

/**
 * The fact line of T-17's lever (PR0-CONTRACT Amendment 14, Q12): an engine step whose input an
 * operator may supply, checked against its `input_schema` — a fact, with no command (no realm
 * command supplies it). `undefined` for an entry with no lever.
 */
export function operatorInputLine(entry: Unavailable): string | undefined {
  const lever = entry.remedy.find(
    (w): w is WayOf<'run_step'> => w.verb === 'run_step' && w.brief.execution !== 'agent',
  );
  return lever === undefined
    ? undefined
    : `'${lever.step}' takes its input from an operator, checked against its input_schema; no realm command supplies it`;
}

/**
 * One refused step's own way (F15, T-13, T-20 (v)): a trust or precondition refusal is corrected in
 * the workflow; an input refusal in its schema (or its map, #688) — and, when a run with other params
 * could change the input, a new run with params that fit, naming the param the map reads.
 */
function refusedStepWay(entry: Unavailable & { code: 'refused_before_claim' }): string {
  if (entry.facts.check !== 'input_schema') return 'correct the workflow and register it again';
  const start =
    entry.no_remedy?.cause === 'operator_command_untyped' && entry.no_remedy.command === 'start';
  const param = entry.facts.param !== undefined ? ` (its param '${entry.facts.param}')` : '';
  const lever = entry.remedy.some((w) => w.verb === 'run_step');
  if (!lever) {
    return `${start ? `start a run with params that fit${param}, or ` : ''}correct its input_map or its input_schema and register the workflow again`;
  }
  return start
    ? `start a run with params that fit${param}, or correct its input_schema and register the workflow again`
    : 'the engine gives it no input, so correct its input_schema and register the workflow again';
}

/** The refused-before-claim entries of a composition (never a capability), in its order. */
function refusedBeforeClaim(
  composed: Pick<ComposedWays, 'unavailable'>,
): (Unavailable & { code: 'refused_before_claim' })[] {
  return cannotRunEntries(composed).filter(
    (u): u is Unavailable & { code: 'refused_before_claim' } => u.code === 'refused_before_claim',
  );
}

/** When nothing can run from here (C64, C82): core's one predicate over the ways. */
export function cannotGoOnHere(composed: Pick<ComposedWays, 'ways' | 'unavailable'>): boolean {
  return cannotGoOnFrom(composed);
}

/** When the run cannot go on until its workflow is corrected (C44, C51): core's one predicate. */
export function cannotGoOnWithRefusal(
  composed: Pick<ComposedWays, 'ways' | 'unavailable'>,
): boolean {
  return cannotGoOnUntilCorrected(composed);
}

/**
 * The one way out for a run that stops on a step refused before its claim (C44; F15; T-20 (i)): the
 * run stays open — its phase said — then the fix and the alternative (abandon). Every refusal for
 * trust or precondition: the one fix; otherwise each step's own way, then, after a fix, advance — or
 * end it.
 */
export function cannotRunWayOut(
  composed: Pick<ComposedWays, 'ways' | 'unavailable'>,
  runId: string,
  phase: RunPhase,
): string {
  const head = `Run ${runId} stays open (phase '${phase}'): `;
  const advance = `realm run advance ${runId}`;
  const abandon = `realm run abandon ${runId}`;
  const refused = refusedBeforeClaim(composed);
  if (refused.every((e) => e.facts.check !== 'input_schema')) {
    return `${head}correct the workflow, register it again, then ${advance} — or end it: ${abandon}`;
  }
  const ways = refused.map((e) => `for '${e.facts.step}', ${refusedStepWay(e)}`);
  return `${head}${ways.join('; ')}; then, after a fix, ${advance} — or end it: ${abandon}`;
}

/**
 * What an operator surface prints when the run cannot go on from here (C62, C64, C82): one line per
 * step that cannot run — `'<s>' cannot run (<check>): <refusal>.`, a marker's capability refusal
 * with its own way out, an operator's lever as its fact line (Amendment 14) — then the run's way
 * out: {@link cannotRunWayOut} when a step is refused before its claim, otherwise the alternative to
 * running the step elsewhere (abandon). Empty in every other state. `realm run respond`, `realm run
 * drain`, `realm run resume`, `realm workflow run` and `realm listen`'s sweeper print these lines;
 * none composes its own.
 */
export function cannotGoOnLines(
  composed: Pick<ComposedWays, 'ways' | 'unavailable'>,
  runId: string,
  phase: RunPhase,
): string[] {
  if (!cannotGoOnHere(composed)) return [];
  const lines: string[] = [];
  for (const entry of cannotRunEntries(composed)) {
    const marker =
      entry.code === 'capability_missing' && entry.facts.basis === 'marker'
        ? capabilityMarkerWayOut(runId)
        : '';
    // C212: a line that ends with a command ends without a full stop.
    lines.push(sentenceEnd(cannotRunClause(entry) + marker));
    const lever = operatorInputLine(entry);
    if (lever !== undefined) lines.push(withFullStop(lever));
  }
  lines.push(
    cannotGoOnWithRefusal(composed)
      ? cannotRunWayOut(composed, runId, phase)
      : `To end the run instead: ${commandOfVerb(composed.ways, 'abandon') ?? `realm run abandon ${runId}`}`,
  );
  return lines;
}

// ─── What the engine owes, and the stop reasons (C202, C207, C211) ─────────────────────────────

/** decision C207: where one advance call stops, said after several owed items. */
const OWED_UNTIL = ' until a step opens a question, fails or ends the run';

/** The owed items of an `advance` way: a due expiry first (C95), then each owed step quoted. */
export function owedItems(way: WayOf<'advance'>): string[] {
  return way.owed.map((o) =>
    'expiry' in o
      ? `the expired question on '${o.expiry.step}' (its declared ${o.expiry.on_expiry})`
      : `'${o.step}'`,
  );
}

/**
 * Decisions C207, C211, C212: what `realm run advance <id>` does with the owed work, as the words
 * that follow the command on a line that names it — ` runs them until a step opens a question,
 * fails or ends the run` for several, ` carries it out, then runs what that leaves owed until …` for
 * an expired question's declared default, empty for one item or a declared abort.
 */
export function owedCallWords(way: WayOf<'advance'>): string {
  const expiry = way.owed.find((o): o is Extract<typeof o, { expiry: unknown }> => 'expiry' in o);
  if (expiry !== undefined) {
    return expiry.expiry.on_expiry === 'settle_default'
      ? ` carries it out, then runs what that leaves owed${OWED_UNTIL}`
      : '';
  }
  return way.owed.length > 1 ? ` runs them${OWED_UNTIL}` : '';
}

/**
 * Decisions C207, C211: the clause a line that names the owed work and the call that runs it ends
 * with — `; it runs them until …` for several items, `; then it runs what that leaves owed until …`
 * after an expired question's declared default, empty for one item or a declared abort. From the
 * `advance` way alone (#729 PR-0, Part B: core's `owedRunsClause` died with its PR-0 callers).
 */
export function owedRunsWords(way: WayOf<'advance'>): string {
  const expiry = way.owed.find((o): o is Extract<typeof o, { expiry: unknown }> => 'expiry' in o);
  if (expiry !== undefined) {
    return expiry.expiry.on_expiry === 'settle_default'
      ? `; then it runs what that leaves owed${OWED_UNTIL}`
      : '';
  }
  return way.owed.length > 1 ? `; it runs them${OWED_UNTIL}` : '';
}

/**
 * Decision C211: the steps an open question holds, as a line names them — `'z' waits for its answer`,
 * `'z', 'x' wait for its answer` — from the `respond` way's `holds`; `undefined` when it holds none
 * (#729 PR-0, Part B: core's `waitingWords` died with its PR-0 caller).
 */
export function heldByAnswerWords(holds: readonly string[]): string | undefined {
  if (holds.length === 0) return undefined;
  return `${holds.map((s) => `'${s}'`).join(', ')} ${holds.length === 1 ? 'waits' : 'wait'} for its answer`;
}

/**
 * The one ready line for agent steps (decisions C55, C59, C89, C96): `an agent step is ready: '<s>'
 * — drive it with realm agent --run-id <id> --provider <provider> --model <model>`, plural for two or
 * more; `undefined` when none is ready. Since #676 `realm agent` refuses to start without a model, so
 * the line carries the placeholders the other printers use.
 */
export function agentReadyLine(runId: string, agentSteps: readonly string[]): string | undefined {
  if (agentSteps.length === 0) return undefined;
  const ready =
    agentSteps.length === 1
      ? `an agent step is ready: '${agentSteps[0]}' — drive it`
      : `agent steps are ready: ${agentSteps.map((s) => `'${s}'`).join(', ')} — drive them`;
  return `${ready} with realm agent --run-id ${runId} --provider <provider> --model <model>`;
}

/**
 * The reason for one step in flight in another program (decisions C37, C205): `'<s>' is in flight in
 * another program — wait for it, or see realm run inspect <id>`.
 */
export function inFlightLine(runId: string, step: string): string {
  return `'${step}' is in flight in another program — wait for it, or see ${CLI_COMMANDS.inspect({ verb: 'inspect', conditions: [], run_id: runId }, undefined, NO_DRIVE_FLAGS)}`;
}

/**
 * Every reason that holds for the run to stop where it is (D4.4's order; a failed step is the
 * caller's to add, first), from the run's ways (A-10, T-14): the run ended · a question is open —
 * with its answer command, or where to read it when its time is up · each step that cannot run ·
 * engine work still owed, with the call that runs it (C202) · agent steps ready · each step in flight
 * elsewhere (C43) · and, when none of these holds, `nothing is ready to run now`.
 */
export function stopReasons(
  composed: Pick<ComposedWays, 'ways' | 'unavailable'>,
  runId: string,
  phase: RunPhase,
): string[] {
  if (composed.unavailable.some((u) => u.code === 'run_ended')) {
    return [`the run has ended (${phase})`];
  }
  const respond = composed.ways.find((w): w is WayOf<'respond'> => w.verb === 'respond');
  const listedQuestion = composed.unavailable.find((u) => u.verb === 'respond');
  if (respond !== undefined || listedQuestion !== undefined) {
    // decision C211 (walk c14 W2-2): the steps the question holds are named.
    const waiting = heldByAnswerWords(respond?.holds ?? []);
    const open = waiting === undefined ? 'a question is open' : `a question is open (${waiting})`;
    return [
      respond !== undefined
        ? // decision C206: the one answer command (`--choice <one of: a, b>`, or the one choice).
          `${open} — ${CLI_COMMANDS.respond(respond, undefined, NO_DRIVE_FLAGS)}`
        : `${open} — see ${commandOfVerb(composed.ways, 'inspect') ?? `realm run inspect ${runId}`}`,
    ];
  }
  const reasons = cannotRunEntries(composed).map((e) => cannotRunClause(e));
  const advance = composed.ways.find((w): w is WayOf<'advance'> => w.verb === 'advance');
  if (advance !== undefined) {
    const items = owedItems(advance);
    const one = items.length === 1;
    reasons.push(
      `the engine still owes ${items.join(', ')} — to run ${one ? 'it' : 'them'}${one ? '' : OWED_UNTIL}: ${CLI_COMMANDS.advance(advance, undefined, NO_DRIVE_FLAGS)}`,
    );
  }
  const agentSteps = composed.ways
    .filter((w): w is WayOf<'run_step'> => w.verb === 'run_step' && w.brief.execution === 'agent')
    .map((w) => w.step);
  const ready = agentReadyLine(runId, agentSteps);
  if (ready !== undefined) reasons.push(ready);
  for (const held of composed.unavailable) {
    if (held.verb === 'run_step' && held.code === 'held_elsewhere') {
      reasons.push(inFlightLine(runId, held.facts.step));
    }
  }
  return reasons.length > 0 ? reasons : ['nothing is ready to run now'];
}

/**
 * The answer lines of an open question at the run prompt (`realm workflow run`'s hand-back): one per
 * choice, each the command that records it (C206; T-7: the choice through `shellWord`).
 */
export function respondLines(way: WayOf<'respond'>): { choice: string; command: string }[] {
  return way.choice.one_of.map((choice) => ({
    choice,
    command: CLI_COMMANDS.respond(
      { ...way, choice: { one_of: [choice] } },
      undefined,
      NO_DRIVE_FLAGS,
    )!,
  }));
}

/**
 * The operator route the CLI hands an MCP server it launches (D2 §5, D4 P-6): `realm mcp` and `realm
 * serve` inject it, so the block of a reply addressed to the person names the command an operator
 * runs for a way only an operator can take — never a structured entry the model reads. The
 * standalone `realm-mcp` bin injects none. `ref` names the launching command.
 */
export function cliOperatorRoute(ref: 'realm mcp' | 'realm serve'): {
  render: (way: WayOn, basis: Basis | undefined) => string | null;
  source: { kind: 'default'; ref: string };
} {
  return {
    render: (way, basis) => cliCommandOf(way, basis, NO_DRIVE_FLAGS),
    source: { kind: 'default', ref },
  };
}
