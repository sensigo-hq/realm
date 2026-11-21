// The holder slice (issue #625, PR-H): who TOOK a step, and how a caller proves it was handed the
// reply that opened a question.
//
// Three facts, kept apart:
//   1. the NAME — which host PROGRAM took a step (a label for people and replies; never compared);
//   2. the PROOF — the claim's own token, handed out on the reply that opened the question, passed
//      back with the answer and judged inside the answer's write (it decides nothing);
//   3. the program fit — PR-2's, not here.
//
// Everything in this file is pure: no I/O, no environment, no OS, no store read. Hosts read their own
// raw facts and call the composer. Each vocabulary is declared ONCE, here, as an `as const` — and
// only the members something produces (a member nothing produces is not shipped).
import { WorkflowError } from '../types/workflow-error.js';
import type { ClaimRecord } from '../types/run-record.js';
import type { LeaseFact } from '../store/lease-port.js';
import { isLeaseFact, type Unleased } from '../store/lease-facts.js';
import type { ProgramFit } from './pending.js';

// ---------------------------------------------------------------------------------------------
// The vocabulary
// ---------------------------------------------------------------------------------------------

/**
 * How a program's name is known. `stated` — a host passed an explicit name; `ambient` — the
 * operator set `REALM_OPERATOR`; `derived` — the OS user and host name. `verified` (#603) and
 * `capability` (#597) are added by the units that produce them.
 * @public
 */
export const BY_SOURCE_CLASSES = ['stated', 'ambient', 'derived'] as const;
/**
 * How a program's name is known: `stated` by the host, `ambient` from `REALM_OPERATOR`, or
 * `derived` from the OS user and host name (`Attributed.by_source`).
 * @public
 */
export type BySourceClass = (typeof BY_SOURCE_CLASSES)[number];

/**
 * How a program's name is known, as words — never the class token (`from the OS user`, not
 * `derived`). The ONE copy (#625 PR-2b, the actor unit, moved here from the CLI's holder lines):
 * every line and sentence that names a program reads it.
 */
export const BY_SOURCE_WORDS: Record<BySourceClass, string> = {
  derived: 'from the OS user',
  ambient: 'from REALM_OPERATOR',
  stated: 'as stated',
};

/**
 * {@link BY_SOURCE_WORDS} for a program named as the one RECORDING an act — an answer's recording
 * program, the program that ended a run: a stated name is the one "named by the program that runs
 * Realm".
 */
export const RECORDED_BY_SOURCE_WORDS: Record<BySourceClass, string> = {
  ...BY_SOURCE_WORDS,
  stated: 'named by the program that runs Realm',
};

/**
 * A program's name, how that name is known, and the host's channel. Not a person; not a process.
 * @public
 */
export interface Attributed {
  by: string;
  by_source: BySourceClass;
  /** A short word the host supplies (`agent`, `run`, `mcp-stdio`, …). The engine never branches on it. */
  channel: string;
}

/**
 * Why a name is absent. All derived AT READ, never stored. #558 PR-V adds its own members to this
 * const; no second absence type exists.
 * @public
 */
export const ACTOR_ABSENT_CAUSES = [
  'holder_not_recorded',
  'pre_lease_claim',
  'no_claim',
  'store_keeps_no_claims',
  'driver_not_recorded',
  'name_unreadable',
  // An answer whose caller stated no name (produced by the step view).
  'not_stated',
  // An answer the gate's expiry wrote: no answer was recorded in time (produced by the step view).
  'settled_by_expiry',
] as const;
/**
 * Why the record names no program for an act, worked out when the record is read and never stored
 * (`ActorAbsent.absent_cause`).
 * @public
 */
export type ActorAbsentCause = (typeof ACTOR_ABSENT_CAUSES)[number];

/**
 * What stands in for a program's name when the record has none: `by: null` and the cause; read
 * where an `Attributed` would be.
 * @public
 */
export interface ActorAbsent {
  by: null;
  absent_cause: ActorAbsentCause;
}

/** The causes a claim's holder can be absent for — exactly what {@link describeClaimHolder} returns. */
export type ClaimHolderAbsentCause = Extract<
  ActorAbsentCause,
  | 'holder_not_recorded'
  | 'pre_lease_claim'
  | 'no_claim'
  | 'store_keeps_no_claims'
  | 'name_unreadable'
>;

/** What the answer's caller showed about the question's claim. Never a reason to refuse. */
export const GATE_PROOFS = ['matched', 'absent', 'mismatch', 'unverifiable', 'spent'] as const;
export type GateProof = (typeof GATE_PROOFS)[number];

export const GATE_PROOF_CAUSES = [
  'no_claim',
  'claim_has_no_token',
  'store_keeps_no_claims',
  'answered',
  'expired',
] as const;
export type GateProofCause = (typeof GATE_PROOF_CAUSES)[number];

/**
 * A verdict with a cause that does not belong to it does not compile.
 * @public
 */
export type GateClaimVerdict =
  | { proof: 'matched' | 'absent' | 'mismatch' }
  | { proof: 'unverifiable'; cause: 'no_claim' | 'claim_has_no_token' | 'store_keeps_no_claims' }
  | { proof: 'spent'; cause: 'answered' | 'expired' };

/**
 * #625 PR-2b A2a (D-8): why an answer's call did not carry the run on (`gate_claim.
 * not_carried_on_because`), one per row of D-8's table, in its order: nothing this call could run
 * after the answer's write; this call's own write did not settle the question; the claim token was
 * not passed back (`proof_absent`), was another's (`proof_mismatch`) or could not be checked
 * (`proof_unverifiable`); the call has no step registry; this program's code is not the code the
 * run last ran with (`extensions_differ`), or cannot be compared with it
 * (`extensions_not_comparable`). `EngineReply.gate_claim.not_carried_on_because` spells the same
 * words out (`_sameReasons` in execution-loop.ts holds the two together).
 */
export type NotCarriedOnReason =
  | 'nothing_runnable'
  | 'not_settled_by_this_call'
  | 'proof_absent'
  | 'proof_mismatch'
  | 'proof_unverifiable'
  | 'no_registry'
  | 'extensions_differ'
  | 'extensions_not_comparable';
/** Every {@link NotCarriedOnReason}, in D-8's order — each produced by one row of `judgeCarryOn`. */
export const NOT_CARRIED_ON_REASONS = [
  'nothing_runnable',
  'not_settled_by_this_call',
  'proof_absent',
  'proof_mismatch',
  'proof_unverifiable',
  'no_registry',
  'extensions_differ',
  'extensions_not_comparable',
] as const satisfies readonly NotCarriedOnReason[];
type UnlistedReason = Exclude<NotCarriedOnReason, (typeof NOT_CARRIED_ON_REASONS)[number]>;
const _everyReasonListed: [UnlistedReason] extends [never] ? true : UnlistedReason = true;
void _everyReasonListed;

/**
 * Why an answer's entry shows no proof. `proof_unreadable`: a stored `claim_proof` that is not a
 * readable verdict — never reported as "not recorded" for a value that is there.
 */
export const CLAIM_PROOF_ABSENT_CAUSES = [
  'settled_by_expiry',
  'proof_not_recorded',
  'proof_unreadable',
] as const;
export type ClaimProofAbsentCause = (typeof CLAIM_PROOF_ABSENT_CAUSES)[number];

/**
 * #603 A3b: why an answer's view names no account its channel reported (`account`).
 * `account_not_recorded`: the entry carries none (no channel reported one, or it was written before
 * one was kept); `account_unreadable`: what it carries is not a name that can be shown.
 */
export const ACCOUNT_ABSENT_CAUSES = [
  'settled_by_expiry',
  'account_not_recorded',
  'account_unreadable',
] as const;
export type AccountAbsentCause = (typeof ACCOUNT_ABSENT_CAUSES)[number];

/**
 * #603 A3b: why an answer's view shows no `admitted_by`. `admission_not_recorded`: the entry carries
 * none (written by a program that wrote none); `admission_unreadable`: a value that is not one of the
 * five.
 */
export const ADMITTED_BY_ABSENT_CAUSES = [
  'settled_by_expiry',
  'admission_not_recorded',
  'admission_unreadable',
] as const;
export type AdmittedByAbsentCause = (typeof ADMITTED_BY_ABSENT_CAUSES)[number];

// ---------------------------------------------------------------------------------------------
// The one bound for a name
// ---------------------------------------------------------------------------------------------

/** The longest name any surface will take or show, in characters. */
export const NAME_MAX_LENGTH = 200;

/** The house marker for a name cut at the read bound (the shape of `capText`'s). */
export const NAME_CAP_MARKER = '…[truncated]';

/** The house control set: C0, DEL and C1. Exported inside core (caching 3-M B1's `response_id`
 *  check), not from core's index. */
// eslint-disable-next-line no-control-regex
export const CONTROL_CHAR = /[\u0000-\u001f\u007f-\u009f]/;
const CHANNEL_RULE = /^[a-z0-9_-]{1,64}$/;

/** The three words a refusal of a stated name gives as its reason, used verbatim everywhere. */
export const NAME_REFUSAL_REASONS = {
  empty: 'empty',
  tooLong: `longer than ${NAME_MAX_LENGTH} characters`,
  control: 'contains a control character',
} as const;

function actorInvalid(field: string, reason: string): WorkflowError {
  return new WorkflowError(`Invalid ${field}: ${reason}.`, {
    code: 'VALIDATION_ACTOR_INVALID',
    category: 'VALIDATION',
    agentAction: 'report_to_user',
    retryable: false,
    details: { field, reason },
  });
}

/**
 * ONE bound for a stated name: at most 200 characters, no control character (newlines included).
 * Throws a `VALIDATION_ACTOR_INVALID` `WorkflowError` naming `field`; returns the text unchanged
 * otherwise. #604 adds `kind: 'reason'` to THIS helper (≤ 500 via `capText`) — never a second rule.
 */
export function boundStated(kind: 'by', text: string, field: string = kind): string {
  if (text.length > NAME_MAX_LENGTH) throw actorInvalid(field, NAME_REFUSAL_REASONS.tooLong);
  if (CONTROL_CHAR.test(text)) throw actorInvalid(field, NAME_REFUSAL_REASONS.control);
  return text;
}

/**
 * A name a person or caller TYPED: spaces at either end are removed first; the result is refused
 * when empty, then bounded. `field` is what the refusal names (`--by`, `responded_by`, …). Returns
 * the TRIMMED text — the caller stores that, never its raw input.
 */
export function boundStatedName(text: string, field: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) throw actorInvalid(field, NAME_REFUSAL_REASONS.empty);
  return boundStated('by', trimmed, field);
}

/**
 * The ONE line a host prints when a name is refused: `<subject>: <reason>; <consequence>. <remedy>`.
 * Minted here for every host and for `respond --by` / `responded_by`. The remedy is chosen by the
 * SUBJECT: an environment variable's name (all upper case) can be unset; any other subject (`--by`,
 * `responded_by` — both optional) can be left out.
 */
export function identityRefusalLine(subject: string, err: unknown, consequence: string): string {
  let reason: string;
  if (err instanceof WorkflowError && err.code === 'VALIDATION_ACTOR_INVALID') {
    const detail = (err.details as { reason?: unknown } | undefined)?.reason;
    reason = typeof detail === 'string' ? detail : err.message;
  } else {
    reason = err instanceof Error ? err.message : String(err);
  }
  const remedy = /^[A-Z][A-Z0-9_]*$/.test(subject)
    ? `Unset it or give it a name of at most ${NAME_MAX_LENGTH} characters with no control characters.`
    : `Give a name of at most ${NAME_MAX_LENGTH} characters with no control characters, or leave it out.`;
  return `${subject}: ${reason}; ${consequence}. ${remedy}`;
}

/**
 * Throws `VALIDATION_ACTOR_INVALID` naming the field when `driver` is not a well-formed
 * `Attributed` (a name failing the bound, a class that is not a member, a channel that is not 1–64
 * characters of `[a-z0-9_-]`). `undefined` is fine: a host may pass none. Every exported engine
 * entry that takes a driver calls this before any read or write.
 */
export function validateDriver(driver: unknown, field: string = 'driver'): void {
  if (driver === undefined) return;
  if (typeof driver !== 'object' || driver === null) throw actorInvalid(field, 'not an object');
  const d = driver as Record<string, unknown>;
  if (typeof d['by'] !== 'string') {
    throw actorInvalid(`${field}.by`, 'not a non-empty string');
  }
  // Blank after trimming is `empty`, as for every stated name. The driver is stored as given (an
  // embedding program composes its name with `composeProgramIdentity`, which trims); every reader
  // removes spaces at either end before it shows the name (`readAttributed`).
  if (d['by'].trim().length === 0) throw actorInvalid(`${field}.by`, NAME_REFUSAL_REASONS.empty);
  boundStated('by', d['by'], `${field}.by`);
  if (!(BY_SOURCE_CLASSES as readonly unknown[]).includes(d['by_source'])) {
    throw actorInvalid(`${field}.by_source`, `not one of ${BY_SOURCE_CLASSES.join(', ')}`);
  }
  if (typeof d['channel'] !== 'string' || !CHANNEL_RULE.test(d['channel'])) {
    throw actorInvalid(`${field}.channel`, 'not 1–64 characters of [a-z0-9_-]');
  }
}

// ---------------------------------------------------------------------------------------------
// Composing a program's identity (pure: each host reads its own raw facts)
// ---------------------------------------------------------------------------------------------

export interface ProgramIdentityFacts {
  /** A name a host passes explicitly. */
  stated?: string;
  /** `REALM_OPERATOR`, as the host read it. */
  ambient?: string;
  /** The OS user name. */
  osUser?: string;
  /** The host name. */
  osHost?: string;
}

/**
 * Precedence `stated` → `ambient` → `derived` (`osUser@osHost`). THROWS (a `VALIDATION_ACTOR_INVALID`
 * `WorkflowError` naming the option or `REALM_OPERATOR`) for a stated name that is empty or fails
 * the bound and for an ambient name that fails it; a derived name that cannot be recorded returns
 * `{ driver: undefined, reason }` (the host prints one notice at start); nothing resolving returns
 * `{ driver: undefined }`. `channel` is the host's own word: 1–64 characters of `[a-z0-9_-]`, else it
 * THROWS.
 */
export function composeProgramIdentity(
  facts: ProgramIdentityFacts,
  channel: string,
): { driver: Attributed } | { driver: undefined; reason?: string } {
  if (!CHANNEL_RULE.test(channel)) {
    throw actorInvalid('channel', 'not 1–64 characters of [a-z0-9_-]');
  }
  if (facts.stated !== undefined) {
    return {
      driver: {
        by: boundStatedName(facts.stated, 'stated'),
        by_source: 'stated',
        channel,
      },
    };
  }
  // An empty or blank REALM_OPERATOR counts as unset; a set one is stored without the spaces at
  // either end.
  if (facts.ambient !== undefined && facts.ambient.trim().length > 0) {
    return {
      driver: {
        by: boundStated('by', facts.ambient.trim(), 'REALM_OPERATOR'),
        by_source: 'ambient',
        channel,
      },
    };
  }
  const user =
    facts.osUser !== undefined && facts.osUser.trim().length > 0 ? facts.osUser : undefined;
  const host =
    facts.osHost !== undefined && facts.osHost.trim().length > 0 ? facts.osHost : undefined;
  if (user === undefined && host === undefined) return { driver: undefined };
  if (user === undefined) return { driver: undefined, reason: 'the OS user name is not known' };
  if (host === undefined) return { driver: undefined, reason: 'the host name is not known' };
  const derived = `${user}@${host}`;
  try {
    boundStated('by', derived, 'derived');
  } catch (err) {
    const why = (err as WorkflowError).details?.['reason'];
    return {
      driver: undefined,
      reason: `the name made from the OS user and host name ${typeof why === 'string' ? why : 'is not usable'}`,
    };
  }
  return { driver: { by: derived, by_source: 'derived', channel } };
}

// ---------------------------------------------------------------------------------------------
// Reading a stored name back (ONE reader for every stored `Attributed`)
// ---------------------------------------------------------------------------------------------

/** A value cut at the read bound: an over-long name is readable and is SHOWN, never withheld. */
function capName(text: string): string {
  return text.length > NAME_MAX_LENGTH
    ? `${text.slice(0, NAME_MAX_LENGTH)}${NAME_CAP_MARKER}`
    : text;
}

/**
 * Reads a name a person typed and a store kept (`responded_by`) by the writer's own rule: spaces at
 * either end are removed first, then the name is cut at 200 characters with the house marker when
 * over-long. `undefined` when it is not a string, is empty or whitespace-only, or carries a control
 * character inside it (nothing of it may reach any surface). A name an embedding program stored with
 * spaces at either end (its own `submitHumanResponse` call bounds nothing — #604) reads the same as
 * the name the CLI and the MCP tool store.
 */
export function readStoredName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const name = value.trim();
  if (name.length === 0 || CONTROL_CHAR.test(name)) return undefined;
  return capName(name);
}

/**
 * #729 PR-6a (B2 (2)): the ONE classification of an answer's stated name (`responded_by`), for the
 * answer view and for `outcome.by` alike: no name, or a blank one, is `not_stated`; any other value
 * {@link readStoredName} refuses (a non-string, a control character) is `name_unreadable`; else the
 * name as that reader returns it.
 */
export function readStatedAnswerer(
  raw: unknown,
): { by: string; by_source: 'stated' } | ActorAbsent {
  if (raw === undefined || raw === null) return { by: null, absent_cause: 'not_stated' };
  if (typeof raw !== 'string') return { by: null, absent_cause: 'name_unreadable' };
  // A value the tool accepted before the name bound existed can be empty: it reads as no name.
  if (raw.trim().length === 0) return { by: null, absent_cause: 'not_stated' };
  const name = readStoredName(raw);
  if (name === undefined) return { by: null, absent_cause: 'name_unreadable' };
  return { by: name, by_source: 'stated' };
}

/**
 * #729 PR-6a (B4; T-19, the owner's 2026-10-11 ruling): a stated name, quoted, with `\` written `\\`
 * and `"` written `\"` inside the quotes — so a name can never close its quotes and pose as part of
 * the line around it. The ONE quoting: the CLI's answerer phrase and the outcome composer both use it.
 */
export function quoteStatedName(name: string): string {
  return `"${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * The one phrase for a recorded name that cannot be printed — a control character in it, or a value
 * that is not a name with its source. No byte of the stored value reaches the screen. Used on claim
 * lines, attempt lines and answer lines alike, and by the outcome composer; never nested inside
 * parentheses. #729 PR-6a correction 1: defined here once (PR0-CONTRACT:52, "never a second phrase").
 */
export const UNSHOWABLE_NAME =
  'a recorded name that cannot be printed (control characters, or not a name with its source)';

/**
 * Reads a stored `Attributed` (a claim's `holder`, an entry's `driven_by`). Total: never throws.
 * A value that is not an object, whose `by` or `channel` is not a string, whose `by_source` is not a
 * member, whose `by` is blank, or whose `by` (after spaces at either end are removed) or `channel`
 * carries a control character is `name_unreadable` — no byte of it is returned. The `by` it returns
 * has no spaces at either end (the writer's rule: a `driver` an embedding program passes is stored
 * as given, so the reader removes them). An over-long `by` or `channel` is SHOWN, cut to 200
 * characters with the marker.
 */
export function readAttributed(value: unknown): Attributed | ActorAbsent {
  const unreadable: ActorAbsent = { by: null, absent_cause: 'name_unreadable' };
  if (typeof value !== 'object' || value === null) return unreadable;
  const v = value as Record<string, unknown>;
  const { by, by_source: source, channel } = v;
  if (typeof by !== 'string' || typeof channel !== 'string') return unreadable;
  if (!(BY_SOURCE_CLASSES as readonly unknown[]).includes(source)) return unreadable;
  // The writer's rule: spaces at either end are removed first; a blank `by` is not a name.
  const name = by.trim();
  if (name.length === 0) return unreadable;
  if (CONTROL_CHAR.test(name) || CONTROL_CHAR.test(channel)) return unreadable;
  return { by: capName(name), by_source: source as BySourceClass, channel: capName(channel) };
}

/**
 * Who did the work an evidence entry records, read off the entry — total; the same reader as for a
 * claim's holder. A stored `driven_by` that is not readable is `name_unreadable`; an entry with none
 * is `driver_not_recorded` (it predates the field, or no host passed a name).
 */
export function readDrivenBy(entry: { driven_by?: unknown } | undefined): Attributed | ActorAbsent {
  if (entry === undefined || entry.driven_by === undefined) {
    return { by: null, absent_cause: 'driver_not_recorded' };
  }
  return readAttributed(entry.driven_by);
}

/**
 * Who took the step, read off a claim — total, and the FIRST row that applies:
 *
 *  - a stored `holder` that is not readable → `name_unreadable` (with `since` when readable);
 *  - a claim with a `holder` → the holder, `since`;
 *  - a claim with `since` and no `holder` → `holder_not_recorded`;
 *  - a claim with no `since` → `pre_lease_claim`;
 *  - no claim, the store keeps claims → `no_claim`;
 *  - no claim, the store keeps none → `store_keeps_no_claims`.
 *
 * `storeKeepsClaims` is `store.persistsClaims === true` (fail-closed). The argument is the two
 * fields, not the whole claim, so the same function reads the copy the settlement result carries
 * after the write has deleted the claim.
 *
 * #729 CW-1b: `lease` is the claim's lease fact (`leaseFactOf` on the snapshot it was read from). A
 * fact is returned beside the answer as `lease`; `{ absent: 'unleased' }`, or no argument, returns
 * exactly the answer above.
 */
export function describeClaimHolder(
  claim: Pick<ClaimRecord, 'holder' | 'since'> | undefined,
  storeKeepsClaims: boolean,
  lease?: LeaseFact | Unleased,
):
  | { holder: Attributed; since?: string; lease?: LeaseFact }
  | (ActorAbsent & { absent_cause: ClaimHolderAbsentCause; since?: string; lease?: LeaseFact }) {
  const answer = holderOf(claim, storeKeepsClaims);
  return lease !== undefined && isLeaseFact(lease) ? { ...answer, lease } : answer;
}

/** {@link describeClaimHolder}'s answer without the lease. */
function holderOf(
  claim: Pick<ClaimRecord, 'holder' | 'since'> | undefined,
  storeKeepsClaims: boolean,
):
  | { holder: Attributed; since?: string }
  | (ActorAbsent & { absent_cause: ClaimHolderAbsentCause; since?: string }) {
  if (claim === undefined || claim === null) {
    return {
      by: null,
      absent_cause: storeKeepsClaims ? 'no_claim' : 'store_keeps_no_claims',
    };
  }
  const since = typeof claim.since === 'string' ? { since: claim.since } : {};
  if (claim.holder !== undefined) {
    const read = readAttributed(claim.holder);
    if (read.by === null) return { by: null, absent_cause: 'name_unreadable', ...since };
    return { holder: read as Attributed, ...since };
  }
  if (typeof claim.since === 'string')
    return { by: null, absent_cause: 'holder_not_recorded', ...since };
  return { by: null, absent_cause: 'pre_lease_claim' };
}

// ---------------------------------------------------------------------------------------------
// The proof
// ---------------------------------------------------------------------------------------------

/**
 * The verdict on a gate answer's proof. Pure; never reads a store (`storeKeepsClaims` is an INPUT
 * the caller supplies); does NOT use `tokensEqual` (that treats absent as equal to absent). The
 * first row that applies:
 *
 *  0. the question was settled before this call → `spent`, cause = how;
 *  1. no claim → `unverifiable` (`store_keeps_no_claims` when the store keeps none, else `no_claim`);
 *  2. a claim with no token → `unverifiable` (`claim_has_no_token`);
 *  3. a claim with a token, none passed → `absent`;
 *  4. equal → `matched`;
 *  5. different (an empty string is different) → `mismatch`.
 */
export function judgeGateProof(input: {
  claim: ClaimRecord | undefined;
  presented: string | undefined;
  settledBefore: 'answered' | 'expired' | undefined;
  storeKeepsClaims: boolean;
}): GateClaimVerdict {
  if (input.settledBefore !== undefined) return { proof: 'spent', cause: input.settledBefore };
  if (input.claim === undefined || input.claim === null) {
    return {
      proof: 'unverifiable',
      cause: input.storeKeepsClaims ? 'no_claim' : 'store_keeps_no_claims',
    };
  }
  const token = input.claim.token;
  if (typeof token !== 'string') return { proof: 'unverifiable', cause: 'claim_has_no_token' };
  if (input.presented === undefined) return { proof: 'absent' };
  return { proof: input.presented === token ? 'matched' : 'mismatch' };
}

/**
 * A stored `claim_proof` read back as a verdict, or `undefined` when it is not one (not an object, a
 * `proof` outside the vocabulary, a `cause` that does not belong to that `proof`). Total.
 */
export function readGateClaimVerdict(value: unknown): GateClaimVerdict | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const v = value as Record<string, unknown>;
  const proof = v['proof'];
  const cause = v['cause'];
  switch (proof) {
    case 'matched':
    case 'absent':
    case 'mismatch':
      return cause === undefined ? { proof } : undefined;
    case 'unverifiable':
      return cause === 'no_claim' ||
        cause === 'claim_has_no_token' ||
        cause === 'store_keeps_no_claims'
        ? { proof, cause }
        : undefined;
    case 'spent':
      return cause === 'answered' || cause === 'expired' ? { proof, cause } : undefined;
    default:
      return undefined;
  }
}

/**
 * #625 PR-2b A2a: D-8's decision — whether an answer's call carries the run on, or the first row
 * that stops it, in the table's order. Pure: the caller reads its facts on the record the answer's
 * reply was judged on. `owed`: `describePending(…).owed` is not empty; `proof`: the answer's verdict;
 * `registry`: the call has a step registry; `fit`: `judgeProgramFit(run, registry.identity)`, read
 * only with a registry.
 */
export function judgeCarryOn(input: {
  owed: boolean;
  proof: GateProof;
  registry: boolean;
  fit: ProgramFit | undefined;
}): { carried_on: true } | { carried_on: false; because: NotCarriedOnReason } {
  if (!input.owed) return { carried_on: false, because: 'nothing_runnable' };
  if (input.proof === 'spent') return { carried_on: false, because: 'not_settled_by_this_call' };
  if (input.proof !== 'matched') return { carried_on: false, because: `proof_${input.proof}` };
  if (!input.registry) return { carried_on: false, because: 'no_registry' };
  if (input.fit === 'differs') return { carried_on: false, because: 'extensions_differ' };
  if (input.fit === 'not_comparable') {
    return { carried_on: false, because: 'extensions_not_comparable' };
  }
  return { carried_on: true };
}

/**
 * #625 PR-2b A2a: what an `ok` answer's call did about the run, for its one sentence: not carried
 * on, and why; or carried on, and — when the call's time ran out before the next step — the last
 * step it ran (the gate step when it ran none).
 */
export type CarryOnSentenceFacts =
  { carried_on: false; because: NotCarriedOnReason } | { carried_on: true; ranOutAfter?: string };

/** D-8's consequence: what a verdict's sentence ends with when the call did not carry the run on. */
const NOT_CARRIED_ON = 'The run was not carried on in this call.';
/** The consequence when this program's code is not the run's: who runs the owed steps instead. */
const NOT_CARRIED_ON_CODE =
  'The run was not carried on in this call; its owed steps run with the code of the program that runs them.';

/**
 * The ONE sentence a verdict adds to a reply's `warnings` (or `undefined` when it adds none). One
 * function, one string per verdict and outcome — never a fact split over two warnings, and no
 * carrier composes a sentence from `gate_claim`. When the answer was not recorded the sentence is
 * the token fact alone: the expiry's own sentence and `answer_recorded` already say so.
 * `tokenPresented` is the engine's input, not a reply key. #625 PR-2b A2a: with `carry`, the verdict's
 * sentence and its consequence for the run are that one string; neither names a step to run or a
 * call to make — the door's sentence of what is owed and the `advance` way say those, once.
 */
export function composeGateClaimSentence(
  verdict: GateClaimVerdict,
  answerRecorded: boolean,
  tokenPresented: boolean,
  carry?: CarryOnSentenceFacts,
): string | undefined {
  const own = verdictSentence(verdict, answerRecorded, tokenPresented);
  if (carry === undefined) return own;
  if (carry.carried_on) {
    return carry.ranOutAfter !== undefined
      ? `This call's time ran out after '${carry.ranOutAfter}'; the run was not carried further in this call.`
      : own;
  }
  switch (carry.because) {
    case 'nothing_runnable':
      return own;
    case 'not_settled_by_this_call':
    case 'proof_absent':
    case 'proof_mismatch':
    case 'proof_unverifiable':
      return own === undefined ? NOT_CARRIED_ON : `${own} ${NOT_CARRIED_ON}`;
    case 'no_registry':
      return `This call has no step registry. ${NOT_CARRIED_ON}`;
    case 'extensions_differ':
      return `This server's code is not the code the run last ran with. ${NOT_CARRIED_ON_CODE}`;
    case 'extensions_not_comparable':
      return `This server's code cannot be compared with the code the run last ran with. ${NOT_CARRIED_ON_CODE}`;
  }
}

/** The verdict's own sentence, as {@link composeGateClaimSentence} composed it before #625 PR-2b. */
function verdictSentence(
  verdict: GateClaimVerdict,
  answerRecorded: boolean,
  tokenPresented: boolean,
): string | undefined {
  // When the answer was not recorded, the sentence is the token fact alone: the expiry's own
  // sentence and `answer_recorded` already say it was not recorded.
  switch (verdict.proof) {
    case 'matched':
      return undefined;
    case 'absent':
      return answerRecorded
        ? 'No claim_token was passed; the answer was recorded. Only the conversation that opened the question has one to pass.'
        : 'No claim_token was passed.';
    case 'mismatch':
      return answerRecorded
        ? "The claim_token passed is not this question's; the answer was recorded."
        : "The claim_token passed is not this question's.";
    case 'unverifiable':
      switch (verdict.cause) {
        case 'no_claim':
          return answerRecorded
            ? 'There is no claim to check a claim_token against — the gate step has no claim on this record; the answer was recorded.'
            : 'There is no claim to check a claim_token against — the gate step has no claim on this record.';
        case 'claim_has_no_token':
          return answerRecorded
            ? "This question's claim carries no token, so the claim_token could not be checked; the answer was recorded."
            : "This question's claim carries no token, so the claim_token could not be checked.";
        case 'store_keeps_no_claims':
          return answerRecorded
            ? 'This store keeps no claims, so a claim_token cannot be checked; the answer was recorded.'
            : 'This store keeps no claims, so a claim_token cannot be checked.';
      }
      return undefined;
    case 'spent':
      if (!tokenPresented) return undefined;
      return verdict.cause === 'expired'
        ? 'The claim_token could not be checked: this question was already settled by its expiry.'
        : 'The claim_token could not be checked: this question was already settled by an earlier answer.';
  }
}
