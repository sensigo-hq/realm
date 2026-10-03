// How `realm run inspect` words the holder slice's facts (issue #625, PR-H): who took a step, who
// answered a question, and what the answer's caller showed about the question's claim.
//
// Every phrase here is a RENDER of a typed field the core composes — the field's WORDS stay data on
// the MCP carriers. The wording rule on every surface: a PROGRAM, past tense ("taken by", "question
// opened through"), with how its name is known. Never "is running", "is driving", "attended by".
import type {
  ActorAbsent,
  ActorAbsentCause,
  AnswerView,
  Attributed,
  BySourceClass,
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
 * The absence words a CLAIM line or an ATTEMPT line can show — typed over exactly the causes those
 * lines can reach (`not_stated` belongs to an answer line, which has its own text).
 */
export const ABSENCE_WORDS: Record<Exclude<ActorAbsentCause, 'not_stated'>, string> = {
  holder_not_recorded: 'no program name was recorded on this claim',
  pre_lease_claim: 'claimed before program names were recorded',
  no_claim: 'no claim is recorded for this step',
  store_keeps_no_claims: 'this run store keeps no claims',
  driver_not_recorded: 'no program name was recorded on this step',
  name_unreadable: UNSHOWABLE_NAME,
};

/** `mihai@host (from the OS user, via mcp-stdio)` — the program, how its name is known, the door. */
export function describeProgram(a: Attributed): string {
  return `${a.by} (${BY_SOURCE_WORDS[a.by_source]}, via ${a.channel})`;
}

/** The absence word for a name that is not there. */
export function describeAbsence(a: ActorAbsent): string {
  return a.absent_cause === 'not_stated' ? '(not stated)' : ABSENCE_WORDS[a.absent_cause];
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

export const PROOF_ABSENT_WORDS: Record<ClaimProofAbsentCause, string> = {
  settled_by_expiry: "none recorded — settled by the gate's expiry",
  proof_not_recorded: 'none recorded',
  proof_unreadable: 'the recorded proof cannot be read',
};

function describeProof(answer: AnswerView): string {
  const proof: GateClaimVerdict | undefined = answer.claim_proof;
  if (proof === undefined) {
    return PROOF_ABSENT_WORDS[answer.claim_proof_absent ?? 'proof_not_recorded'];
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
 * with no parentheses around it so nothing nests, the one unshowable phrase.
 */
export function renderAnswerLine(answer: AnswerView): string {
  const by = answer.answered_by;
  let answerer: string;
  if (by.by !== null) {
    answerer = `${by.by} (as stated, not verified)`;
  } else if (by.absent_cause === 'name_unreadable') {
    answerer = UNSHOWABLE_NAME;
  } else {
    answerer = '(not stated)';
  }
  const choice = answer.choice ?? '(no choice recorded)';
  return `Answer: ${choice} · answered by ${answerer} · proof: ${describeProof(answer)}`;
}
