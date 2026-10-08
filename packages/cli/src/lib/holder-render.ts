// How `realm run inspect` words the holder slice's facts (issue #625, PR-H): who took a step, who
// answered a question, and what the answer's caller showed about the question's claim.
//
// Every phrase here is a RENDER of a typed field the core composes — the field's WORDS stay data on
// the MCP carriers. The wording rule on every surface: a PROGRAM, past tense ("taken by", "question
// opened through"), with how its name is known. Never "is running", "is driving", "attended by".
import type {
  AnswerView,
  Attributed,
  BySourceClass,
  ClaimHolderAbsentCause,
  ClaimProofAbsentCause,
  GateClaimVerdict,
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
    ` If the program that took it is gone: realm run reclaim ${runId} --step ${step} --force`
  );
}

/** The proof part of an answer line, in words — never a code. */
export const PROOF_WORDS = {
  matched: 'matched the claim_token of the reply that opened this question',
  absent:
    'no claim_token passed (the CLI never passes one; over MCP, only the conversation that opened the question has one to pass)',
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
 * One answer, one line: `Answer: <choice> · answered by <name> (as stated, not verified) ·
 * proof: <words>`. The answerer is the caller-STATED, unverified name — or `(not stated)` — or,
 * with no parentheses around it so nothing nests, the one unshowable phrase. An answer the gate's
 * expiry wrote reads `Answer: <choice> · settled by the gate's expiry (no answer in time)`: no
 * answerer part and no proof part, since both would repeat the same fact.
 */
export function renderAnswerLine(answer: AnswerView): string {
  const by = answer.answered_by;
  const choice = answer.choice ?? '(no choice recorded)';
  const absent = answer.claim_proof_absent;
  if (
    (by.by === null && by.absent_cause === 'settled_by_expiry') ||
    absent === 'settled_by_expiry'
  ) {
    return `Answer: ${choice} · ${SETTLED_BY_EXPIRY_WORDS}`;
  }
  let answerer: string;
  if (by.by !== null) {
    answerer = `${by.by} (as stated, not verified)`;
  } else if (by.absent_cause === 'name_unreadable') {
    answerer = UNSHOWABLE_NAME;
  } else {
    answerer = '(not stated)';
  }
  return `Answer: ${choice} · answered by ${answerer} · proof: ${describeProof(answer.claim_proof, absent)}`;
}

/**
 * A question's text as the terminal shows it (decision C167; `realm run inspect`'s `Message:` line):
 * quoted, on one line, every control character written as an escape — a run parameter in it may
 * carry a newline or a terminal sequence. JSON quoting escapes U+0000–U+001F; the house's control
 * set (`holder.ts`) also holds U+007F–U+009F (U+009B starts a terminal sequence), which JSON leaves
 * raw, so those are escaped too.
 */
export function quotedForTerminal(text: string): string {
  return JSON.stringify(text).replace(
    /[\u007f-\u009f]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

/**
 * decision C175: a question's lines as the gate's prompt shows them — each line as written, every
 * control character but the line break written as an escape (the terminal-safety rule of
 * {@link quotedForTerminal}); one line after `Question: `, more than one each on its own line,
 * indented under it, so no line of a question can stand where the prompt's own lines start.
 */
export function questionLines(text: string): string[] {
  const lines = text
    .replace(/\n$/, '')
    .split('\n')
    .map((line) =>
      line.replace(
        // eslint-disable-next-line no-control-regex -- the control characters are what is escaped
        /[\u0000-\u001f\u007f-\u009f]/g,
        (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
      ),
    );
  return lines.length === 1
    ? [`  Question: ${lines[0]}`]
    : ['  Question:', ...lines.map((line) => `    ${line}`)];
}
