// How `realm run inspect` words the holder slice's facts (issue #625, PR-H): who took a step, who
// answered a question, and what the answer's caller showed about the question's claim.
//
// Every phrase here is a RENDER of a typed field the core composes — the field's WORDS stay data on
// the MCP carriers. The wording rule on every surface: a PROGRAM, past tense ("taken by", "question
// opened through"), with how its name is known. Never "is running", "is driving", "attended by".
import {
  answerArrivalOf,
  composeStepViews,
  controlEscape,
  deriveRunPhase,
  describeClaimHolder,
  isAnswerEntry,
  offeredResumeWay,
  operatorEndingSentence,
  resumeWay,
  shellWord,
} from '@sensigo/realm';
import type {
  AnswerArrival,
  AnswerView,
  Attributed,
  BySourceClass,
  ClaimHolderAbsentCause,
  ClaimProofAbsentCause,
  GateClaimVerdict,
  NotRecordedKind,
  RunRecord,
} from '@sensigo/realm';

/**
 * The one phrase for a recorded name that cannot be printed — a control character in it, or a value
 * that is not a name with its source. No byte of the stored value reaches the screen. Used on claim
 * lines, attempt lines and answer lines alike; never nested inside parentheses.
 */
export const UNSHOWABLE_NAME =
  'a recorded name that cannot be printed (control characters, or not a name with its source)';

/** How a name is known, as words — never the class token (`from the OS user`, not `derived`). */
export const BY_SOURCE_WORDS: Record<BySourceClass, string> = {
  derived: 'from the OS user',
  ambient: 'from REALM_OPERATOR',
  stated: 'as stated',
};

/**
 * The absence words a CLAIM line can show — typed over exactly the causes `describeClaimHolder`
 * returns. (An attempt line with no recorded name prints nothing; an answer line has its own text.)
 */
export const ABSENCE_WORDS: Record<ClaimHolderAbsentCause, string> = {
  holder_not_recorded: 'no program name was recorded on this claim',
  pre_lease_claim: 'claimed before program names were recorded',
  no_claim: 'no claim is recorded for this step',
  store_keeps_no_claims: 'this run store keeps no claims',
  name_unreadable: UNSHOWABLE_NAME,
};

/** `mihai@host (from the OS user, via mcp-stdio)` — the program, how its name is known, the door. */
export function describeProgram(a: Attributed): string {
  return `${a.by} (${BY_SOURCE_WORDS[a.by_source]}, via ${a.channel})`;
}

/**
 * issue #625 PR-2a (decision C22): the ONE phrase for who took a step, as a past-tense fact read off
 * its claim — `taken by <program>`, or the words for why no program can be named. A template takes
 * this whole phrase; a cause word is never spliced into a sentence.
 */
export function takenPhrase(
  described:
    | { holder: Attributed; since?: string }
    | { by: null; absent_cause: ClaimHolderAbsentCause; since?: string },
): string {
  if ('holder' in described) return `taken by ${describeProgram(described.holder)}`;
  switch (described.absent_cause) {
    case 'holder_not_recorded':
      return 'taken by a program whose name was not recorded';
    case 'pre_lease_claim':
      return 'taken before program names were recorded';
    case 'name_unreadable':
      return `taken by ${UNSHOWABLE_NAME}`;
    case 'store_keeps_no_claims':
      return 'taken by another process (this run store keeps no claims)';
    case 'no_claim':
      // Not in decision C22's list: the claim is gone by the time the record is re-read (the other
      // process already settled the step). Past tense, and nothing claimed that is not known.
      return 'taken by another process, whose claim is no longer on the record';
  }
}

/**
 * issue #625 PR-2a (D6.1): the line a driver prints for a step another process took —
 * `• Step '<s>' was <taken phrase> at <since>; not run here.` (no ` at <since>` when the claim has
 * none). The same line for an agent step and an engine step.
 */
export function takenLine(step: string, described: Parameters<typeof takenPhrase>[0]): string {
  const at = described.since !== undefined ? ` at ${described.since}` : '';
  return `• Step '${step}' was ${takenPhrase(described)}${at}; not run here.`;
}

/**
 * issue #625 PR-2a (D6.2; decision C173): the line a driver prints for a step in flight in another
 * process when the record has not changed for `watchMs` — `realm agent` and `realm workflow run`
 * print the same words.
 */
export function inFlightLine(
  runId: string,
  step: string,
  described: Parameters<typeof takenPhrase>[0],
  stale: boolean,
  watchMs: number,
): string {
  const since = described.since ?? 'an unrecorded time';
  return (
    `• Step '${step}' has been in flight since ${since}, ${takenPhrase(described)}; the record has not changed for ${Math.round(watchMs / 1000)}s.` +
    (stale ? ' Its claim is past its deadline (its runner likely died).' : '') +
    ` If the program that took it is gone: realm run reclaim ${runId} --step ${shellWord(step)} --force`
  );
}

/**
 * decisions C202, C205: the hand-back line for a run that an engine failure ended with a failed step
 * `realm run resume` takes — `  Resume:    realm run resume <id> --from <step>` (core's
 * `offeredResumeWay`, F2); for a run an operator ended, a line of its own in the offer's place —
 * `  Ended:     An operator ended this run, with the reason "<reason>"; to run the work again, start
 * a new run.` (core's `operatorEndingSentence`); `undefined` for any other run. `realm workflow
 * run`'s map and its last line, and `realm agent`'s stop, print it.
 */
export function resumeLine(
  run: Parameters<typeof resumeWay>[0],
  workflow: Parameters<typeof resumeWay>[1],
): string | undefined {
  const operator = operatorEndingSentence(run);
  if (operator !== undefined) return `  Ended:     ${operator}`;
  const resume = offeredResumeWay(run, workflow);
  return resume === undefined ? undefined : `  Resume:    ${resume.command}`;
}

/**
 * decisions C188, C195: the way on a driver gives when it stops waiting for steps another process
 * holds — `  Go on:     once '<s>' is no longer in flight, <command>` (`'<a>', '<b>' are` for
 * several). `realm workflow run` gives `realm run advance <run>`; `realm agent` gives itself again,
 * with the flags it was started with.
 */
export function goOnLine(held: readonly string[], command: string): string {
  const names = held.map((s) => `'${s}'`).join(', ');
  const are = held.length === 1 ? 'is' : 'are';
  return `  Go on:     once ${names} ${are} no longer in flight, ${command}`;
}

/**
 * decision C182: the line a driver prints when it starts waiting for a step another process holds —
 * `• Step '<s>' is in flight, <taken phrase> since <since>: waiting up to <n>s for the run's record
 * to change.` (no ` since <since>` when the claim has none). `realm workflow run` and `realm agent`
 * print the same words; {@link inFlightLine} is the line when the wait ends with no change.
 */
export function waitingLine(
  step: string,
  described: Parameters<typeof takenPhrase>[0],
  watchMs: number,
): string {
  const since = described.since !== undefined ? ` since ${described.since}` : '';
  return `• Step '${step}' is in flight, ${takenPhrase(described)}${since}: waiting up to ${Math.round(watchMs / 1000)}s for the run's record to change.`;
}

/**
 * decisions C165, C179: who ran a step that another process settled, and how it ended — `taken by
 * <program>, and completed` (or `, and failed`), the program read off the step's own evidence
 * (`driven_by`), since its claim is gone once it settled. `undefined` while the step has not
 * settled.
 */
export function ranElsewherePhrase(run: RunRecord, step: string): string | undefined {
  const done = run.completed_steps.includes(step)
    ? 'completed'
    : run.failed_steps.includes(step)
      ? 'failed'
      : undefined;
  if (done === undefined) return undefined;
  const ev = [...run.evidence]
    .reverse()
    .find((e) => e.step_id === step && e.kind !== 'gate_response');
  const by =
    ev?.driven_by !== undefined
      ? takenPhrase({ holder: ev.driven_by })
      : takenPhrase({ by: null, absent_cause: 'no_claim' });
  return `${by}, and ${done}`;
}

/**
 * decision C179: the line `realm agent` prints, never `✓`, when the agent step its model answered
 * was taken or run by another process before the answer reached the engine — the claim's holder
 * while that process holds the step, the program that ran it once it settled, or the run's ending
 * when the run ended without it. `undefined` when none of these holds (the reply is then the
 * drive's to explain).
 *
 * F7: when the drive's own settle of the answer was refused (core's classifier: `ran_here`), the
 * arm is the classifier's `kind`, never read again here — on a run that ended it says the run
 * ended, and a claim another process removed is said too (the step is then asked for again).
 */
export function answerNotRecordedLine(
  run: RunRecord,
  step: string,
  keepsClaims: boolean,
  kind?: NotRecordedKind,
): string | undefined {
  const notRecorded = "this drive's answer was not recorded";
  const takenArm = (): string => {
    const described = describeClaimHolder(run.claims?.[step], keepsClaims);
    const at = described.since !== undefined ? ` at ${described.since}` : '';
    return `• Step '${step}' was ${takenPhrase(described)}${at}; ${notRecorded}.`;
  };
  const endedArm = `• Step '${step}' was not run: the run ended (${deriveRunPhase(run)}) before this drive's answer reached it; the answer was not recorded.`;
  if (kind !== undefined) {
    switch (kind) {
      case 'held_elsewhere':
        return takenArm();
      case 'step_settled':
        return `• Step '${step}' was ${ranElsewherePhrase(run, step) ?? takenPhrase({ by: null, absent_cause: 'no_claim' })}; ${notRecorded}.`;
      case 'run_ended':
        return endedArm;
      case 'claim_removed':
        return `• Step '${step}': another process removed the claim this drive held on it; ${notRecorded}.`;
    }
  }
  if (run.in_progress_steps.includes(step)) return takenArm();
  const ran = ranElsewherePhrase(run, step);
  if (ran !== undefined) return `• Step '${step}' was ${ran}; ${notRecorded}.`;
  if (run.terminal_state === true) return endedArm;
  return undefined;
}

/**
 * decisions C194, C199: the line `realm run advance` prints, never "failed", when the step it was
 * running was settled or taken over by another process, or the run was ended, before its own outcome
 * was recorded (that step's own `STATE_STEP_ALREADY_SETTLED`, `STATE_CLAIM_LOST` or
 * `STATE_RUN_TERMINAL`: another program ran it after a `realm run reclaim --force` freed this one's
 * claim, or `realm run abandon` ended the run, for one). F7: one arm per kind core's classifier
 * names (`classifyStop`, `ran_here`), read off the record after the refusal: the claim's holder
 * while another process holds the step on a run that has not ended (`held_elsewhere`), the program
 * that ran it once it settled (`step_settled`), the run's ending (`run_ended`), or else the claim this
 * program held was removed (`claim_removed`). Its own work on the step may have run here: the line
 * says only that its outcome was not recorded, never "not run here". `realm agent` prints it for an
 * engine step its call ran, and `realm workflow run` for the step it drives.
 */
export function outcomeNotRecordedLine(
  kind: NotRecordedKind,
  run: RunRecord,
  step: string,
  keepsClaims: boolean,
): string {
  const notRecorded = "this program's outcome for it was not recorded";
  // F7: the arm is core's classifier's kind, never read again here. Decision C199: on a run that has
  // ended, the ending is said — a claim the ending left on the record may be this program's own (an
  // ending that is not an abandon leaves the claims of the steps still running in place), so the
  // classifier never names it another program's take.
  switch (kind) {
    case 'held_elsewhere': {
      const described = describeClaimHolder(run.claims?.[step], keepsClaims);
      const at = described.since !== undefined ? ` at ${described.since}` : '';
      return `• Step '${step}' was ${takenPhrase(described)}${at}; ${notRecorded}.`;
    }
    case 'step_settled':
      return `• Step '${step}' was ${ranElsewherePhrase(run, step) ?? takenPhrase({ by: null, absent_cause: 'no_claim' })}; ${notRecorded}.`;
    case 'run_ended':
      return `• Step '${step}': the run ended (${deriveRunPhase(run)}) before this program's outcome for it was recorded.`;
    case 'claim_removed':
      return `• Step '${step}': another process removed the claim this program held on it; ${notRecorded}.`;
  }
}

/** The proof part of an answer line, in words — never a code. */
export const PROOF_WORDS = {
  matched: 'matched the claim_token of the reply that opened this question',
  // #627 W (W-i4).
  absent:
    "none passed (a token is passed only by Realm's MCP answer tool, from the conversation that opened the question, or by a program that calls the library with it)",
  mismatch: "the claim_token passed is not this question's",
  unverifiable: {
    no_claim: 'could not be checked — no claim on this record',
    claim_has_no_token: 'could not be checked — the claim has no token',
    store_keeps_no_claims: 'could not be checked — this store keeps no claims',
  },
  spent: {
    answered: 'could not be checked — already settled by an earlier answer',
    expired: 'could not be checked — already settled by its expiry',
  },
} as const;

/**
 * Why an answer line shows no proof — typed over the causes a proof part can show. An answer the
 * gate's expiry wrote (`settled_by_expiry`) has no proof part at all (see {@link renderAnswerLine}).
 */
export const PROOF_ABSENT_WORDS: Record<
  Exclude<ClaimProofAbsentCause, 'settled_by_expiry'>,
  string
> = {
  proof_not_recorded: 'none recorded',
  proof_unreadable: 'the recorded proof cannot be read',
};

/**
 * The line an answer the gate's expiry wrote reads after its choice: no answerer, no proof. The
 * words hold in every case (decision C147): no answer was recorded in time — none came, or one came
 * after the time was up and was not recorded (it may itself have carried the expiry out).
 */
const SETTLED_BY_EXPIRY_WORDS = "settled by the gate's expiry (no answer in time)";

function describeProof(
  proof: GateClaimVerdict | undefined,
  absent: Exclude<ClaimProofAbsentCause, 'settled_by_expiry'> | undefined,
): string {
  if (proof === undefined) {
    return PROOF_ABSENT_WORDS[absent ?? 'proof_not_recorded'];
  }
  switch (proof.proof) {
    case 'matched':
      return PROOF_WORDS.matched;
    case 'absent':
      return PROOF_WORDS.absent;
    case 'mismatch':
      return PROOF_WORDS.mismatch;
    case 'unverifiable':
      return PROOF_WORDS.unverifiable[proof.cause];
    case 'spent':
      return PROOF_WORDS.spent[proof.cause];
  }
}

/**
 * #706 walk W8-R1: the ONE reader of the answer the record holds for a step's question — the last
 * answer of the step's view (`composeStepViews`), or `undefined` when the step has no answer. Every
 * CLI surface that names an answerer reads it here: `realm workflow run`'s closed-question line and
 * `realm run respond`'s `Responded:` line.
 */
export function recordedAnswer(run: RunRecord, step: string): AnswerView | undefined {
  const answers = composeStepViews(run)[step]?.answers ?? [];
  return answers[answers.length - 1];
}

/**
 * #706 walk W8-R1: the ONE phrase for who answered a question, each absence in its own words by
 * cause: a name → `<name> (<statedLabel>)`; a recorded name that cannot be printed → the one
 * unshowable phrase, with no parentheses around it so nothing nests; no name stated →
 * `(not stated)`. For any `answered_by` but `settled_by_expiry` — an answer the gate's expiry wrote
 * has no answerer, and each caller words that case itself before it calls this.
 */
export function answererPhrase(by: AnswerView['answered_by'], statedLabel: string): string {
  if (by.by !== null) return `${by.by} (${statedLabel})`;
  if (by.absent_cause === 'name_unreadable') return UNSHOWABLE_NAME;
  return '(not stated)';
}

/**
 * #627 W (W-i1, W-i8 by_source): how the program that recorded an answer knows its own name, as
 * words — on the answer line a stated name is the one "named by the program that runs Realm".
 */
const RECORDED_BY_SOURCE_WORDS: Record<BySourceClass, string> = {
  ...BY_SOURCE_WORDS,
  stated: 'named by the program that runs Realm',
};

/**
 * #627 W (W-i1, W-i2): the program part of the route — channel first, then the name it runs as; or,
 * with no program recorded, that it did not name itself.
 */
function recordedByPhrase(
  recordedBy: AnswerArrival['recorded_by'],
  lead: 'recorded by' | 'as recorded by',
): string {
  if (recordedBy.by !== null) {
    return `${lead} ${recordedBy.channel}, running as ${recordedBy.by} (${RECORDED_BY_SOURCE_WORDS[recordedBy.by_source]})`;
  }
  if (recordedBy.absent_cause === 'name_unreadable') return `${lead} ${UNSHOWABLE_NAME}`;
  return 'as recorded by a program that did not name itself';
}

/**
 * #627 W: how the answer arrived — "through <route> (as its door declared)" states a declaration,
 * never an arrival (W-i1); a route its program did not declare (W-i7); no route recorded (W-i3,
 * which claims nothing about when the entry was written; the program part is omitted).
 */
function arrivalPhrase(arrival: AnswerArrival): string {
  const via = arrival.via;
  if (typeof via === 'string') {
    return `through ${routePhraseOf(via)} (as its door declared), ${recordedByPhrase(arrival.recorded_by, 'recorded by')}`;
  }
  if (via.absent === 'route_not_declared') {
    return `through a route its program did not declare, ${recordedByPhrase(arrival.recorded_by, 'as recorded by')}`;
  }
  return 'how it arrived was not recorded';
}

/**
 * #627 W (W-i10): how a route is named to the OPERATOR on inspect. Its own table, not the MCP door's:
 * the operator's `cli` phrase names the command; the agent's never does (correction 1, A1).
 */
function routePhraseOf(route: string): string {
  switch (route) {
    case 'mcp_form':
      return "the user's app, as a form";
    case 'mcp':
      return "Realm's MCP answer tool";
    case 'cli':
      return 'a terminal (realm run respond)';
    // #819 (item 28): `realm agent`'s Slack thread, its own words — never the fallback.
    case 'slack':
      return 'a Slack thread';
    default:
      // Correction 2 (8.2): an embedder's route may hold a newline or a terminal sequence (C1
      // admits any non-empty route) — quoted on one line, as the question is.
      return `route ${quotedForTerminal(route)}`;
  }
}

/** #627 W (W-i8): the transport's principal, by kind — nothing for the absences that name no one. */
function principalPhrase(principal: AnswerArrival['principal']): string | undefined {
  if (principal === undefined) return undefined;
  if ('kind' in principal) {
    return principal.kind === 'api_key'
      ? `authenticated by API key ${principal.id}`
      : "through realm serve's shared token, which names no one";
  }
  return principal.absent === 'door_authentication_disabled'
    ? 'with authentication turned off (dev mode)'
    : undefined;
}

/** #627 W (W-i5): the door asked the client to have the person approve the call. */
const CLIENT_PROMPT_WORDS =
  'client prompt requested (anthropic/requiresUserInteraction); Realm cannot tell whether anyone approved';

/**
 * One answer, one line (#627 W, W-i1): `Answer: <choice> · answered by <name> (as stated) · through
 * <route> (as its door declared), recorded by <program>, running as <name> (<source>) · <principal> ·
 * <client prompt> · token: <words>`. The answerer is the caller-STATED name — or `(not stated)` — or,
 * with no parentheses around it so nothing nests, the one unshowable phrase ({@link answererPhrase}).
 * An answer the gate's expiry wrote reads `Answer: <choice> · settled by the gate's expiry (no
 * answer in time)` (W-i6): no answerer, route or token part, since each would repeat the same fact.
 * `arrival` is the answer entry's own facts (`answerArrivalOf`), read beside its view.
 */
export function renderAnswerLine(answer: AnswerView, arrival: AnswerArrival): string {
  const by = answer.answered_by;
  const choice = answer.choice ?? '(no choice recorded)';
  const absent = answer.claim_proof_absent;
  if (
    (by.by === null && by.absent_cause === 'settled_by_expiry') ||
    absent === 'settled_by_expiry'
  ) {
    return `Answer: ${choice} · ${SETTLED_BY_EXPIRY_WORDS}`;
  }
  const principal = principalPhrase(arrival.principal);
  return [
    `Answer: ${choice}`,
    `answered by ${answererPhrase(by, 'as stated')}`,
    arrivalPhrase(arrival),
    ...(principal !== undefined ? [principal] : []),
    ...(arrival.client_prompt_requested ? [CLIENT_PROMPT_WORDS] : []),
    `token: ${describeProof(answer.claim_proof, absent)}`,
  ].join(' · ');
}

/** The arrival facts of the answer the record holds for a step's question (its last answer entry). */
export function recordedArrival(run: RunRecord, step: string): AnswerArrival {
  const entries = (Array.isArray(run.evidence) ? run.evidence : []).filter(
    (e) => isAnswerEntry(e) && (e as { step_id?: unknown }).step_id === step,
  );
  return answerArrivalOf(entries[entries.length - 1]);
}

/**
 * A question's text as the terminal shows it (decision C167; `realm run inspect`'s `Message:` line):
 * quoted, on one line, every control character written as an escape ({@link controlEscape}) — a
 * run parameter in it may carry a newline or a terminal sequence.
 */
export function quotedForTerminal(text: string): string {
  return JSON.stringify(text).replace(/[\u007f-\u009f]/g, controlEscape);
}

/**
 * decision C175: a question's lines as the gate's prompt shows them — each line as written, every
 * control character but the line break written as an escape, the same as `realm run inspect`'s
 * (decision C183, {@link controlEscape}); one line after `Question: `, more than one each on its
 * own line, indented under it, so no line of a question can stand where the prompt's own lines start.
 */
export function questionLines(text: string): string[] {
  const lines = text
    .replace(/\n$/, '')
    .split('\n')
    .map((line) =>
      // eslint-disable-next-line no-control-regex -- the control characters are what is escaped
      line.replace(/[\u0000-\u001f\u007f-\u009f]/g, controlEscape),
    );
  return lines.length === 1
    ? [`  Question: ${lines[0]}`]
    : ['  Question:', ...lines.map((line) => `    ${line}`)];
}
