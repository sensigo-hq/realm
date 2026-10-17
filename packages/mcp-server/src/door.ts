// door.ts — #627 W (§5.1, §5.2b): the MCP door's gate answers. One value per server, read once from
// the bins' `--gate-answers` flag, the `REALM_MCP_GATE_ANSWERS` environment variable and the
// `gateAnswers` option — the MOST RESTRICTIVE wins (`withheld` > `asked` > `offered`), default `asked`
// — plus the form-wait setting, and what this server process has SENT for each question (never what
// the person saw, never on the run record: Amendment 4).
import {
  judgeGateAnswers,
  GATE_ANSWERS_ENV,
  type DoorAnswers,
  type DoorFormFacts,
  type FormWaitSetting,
  type GateAnswersSetting,
  type Source,
} from '@sensigo/realm';
export {
  judgeGateAnswers,
  judgeFormWait,
  alsoSetClause,
  GATE_ANSWERS_ENV,
  FORM_WAIT_ENV,
  FORM_WAIT_SECONDS_DEFAULT,
  FORM_WAIT_SECONDS_MIN,
  FORM_WAIT_SECONDS_MAX,
} from '@sensigo/realm';
export type {
  GateAnswersSetting,
  GateAnswersInput,
  FormWaitSetting,
  FormWaitInput,
} from '@sensigo/realm';

/**
 * Below this many seconds of the call's own budget left, no form is sent (the question stays "never
 * sent here"): a form closed before a person can read it is a non-answer by construction, and the
 * next `present_question` call gets a full budget. Judged on the call's budget, never on the time
 * left until the deadline, which would loop `present_question` near a deadline.
 */
export const FORM_WAIT_FLOOR_SECONDS = 20;
/**
 * How many more times the agent may send a question's form after the first send, per gate per
 * server process (R-f): bounds prompt fatigue, since the agent picks the timing. A new server process
 * starts again at the first send plus these.
 */
export const FORM_ASKS_AFTER_FIRST = 3;
/** How often an open form re-reads the run, to withdraw the form once the question is gone. */
export const FORM_SETTLE_POLL_MS = 2000;

type SetKind = 'flag' | 'env' | 'option';

/** W-s4 (library): a bad value the library was given — no server is built. */
export function gateAnswersLibraryRefusal(kind: SetKind, raw: string): string {
  const where =
    kind === 'env' ? GATE_ANSWERS_ENV : kind === 'flag' ? '--gate-answers' : 'gateAnswers option';
  return `createRealmMcpServer: invalid ${where} value '${raw}': expected asked, offered or withheld — refused: no server is built while it is set, because a misspelt value would leave gate answers handled differently from what you believe. Fix the value where this program reads it, or remove it; a program that reads its environment only at start must be restarted.`;
}

/**
 * The effective gate-answers value for embedders' logs (§5.1): the same reading
 * `createRealmMcpServer` makes from these options and this environment. Throws W-s4 (library) on a
 * value that is not one of the three.
 */
export function effectiveGateAnswers(
  options?: { gateAnswers?: string | undefined; gateAnswersFlag?: string | undefined },
  env: Record<string, string | undefined> = process.env,
): GateAnswersSetting {
  const judged = judgeGateAnswers({
    flag: options?.gateAnswersFlag,
    env: env[GATE_ANSWERS_ENV],
    option: options?.gateAnswers,
  });
  if (!judged.ok) throw new Error(gateAnswersLibraryRefusal(judged.kind, judged.raw));
  return judged.setting;
}

/** W-s8 (library): a form-wait value out of bounds — no server is built. */
export function formWaitLibraryRefusal(raw: string): string {
  return `createRealmMcpServer: invalid formWaitSeconds value '${raw}': expected a whole number of seconds from 30 to 3600 — refused: no server is built while it is set. Fix the value or remove it.`;
}

/** Correction 2 (4.2): a form-wait value where this server never sends a form — refused (library). */
export function formWaitInertLibraryRefusal(where: string, why: string): string {
  return `createRealmMcpServer: ${where} has no effect on this server: ${why} — refused: no server is built while it is set, because the setting would claim a wait that never happens. Remove it, or set gate answers to asked on a server that sends forms.`;
}

/** What this server process has sent for one question (§5.2b): never what the person saw. */
interface GateSends {
  /** How many times the form was sent, the first included. */
  sent: number;
  /** How many of those came back without an answer. */
  came_back: number;
  /** Whether one is open now. */
  open: boolean;
}

/**
 * The MCP door of one server instance (one session on stdio; one request on HTTP): the gate-answers
 * value, whether this session's client shows forms (negotiated at `initialize`; never module-level),
 * the form wait, and the per-gate form facts of this process. Built by `createRealmMcpServer`.
 */
export class McpDoor {
  readonly gateAnswers: GateAnswersSetting;
  readonly formWait: FormWaitSetting;
  /** Set at `initialize` from the client's capabilities; `false` until then, and always on HTTP. */
  forms: { shown: boolean; source: Source };
  /** Whether this door can send a form at all (stdio); `false` on stateless HTTP. */
  readonly sendsForms: boolean;
  /** The monotonic clock a call's spent time is read from (injectable for cells). */
  readonly monotonicNow: () => number;
  private readonly sends = new Map<string, GateSends>();

  constructor(args: {
    gateAnswers: GateAnswersSetting;
    formWait: FormWaitSetting;
    sendsForms: boolean;
    monotonicNow?: () => number;
  }) {
    this.gateAnswers = args.gateAnswers;
    this.formWait = args.formWait;
    this.sendsForms = args.sendsForms;
    this.monotonicNow = args.monotonicNow ?? (() => performance.now());
    this.forms = {
      shown: false,
      source: {
        kind: 'negotiated',
        ref: "the client's initialize capabilities (elicitation.form)",
      },
    };
  }

  /** The door's answers, as `narrowForDoor` reads them. */
  answers(): DoorAnswers {
    return { value: this.gateAnswers.value, source: this.gateAnswers.source, forms: this.forms };
  }

  /** What this process has sent for a question, as `narrowForDoor` and the await entry read it. */
  formFacts(gateId: string): DoorFormFacts {
    const s = this.sends.get(gateId) ?? { sent: 0, came_back: 0, open: false };
    return {
      sent_here: s.open ? 'open' : s.sent === 0 ? 'never' : 'closed',
      came_back: s.came_back,
      asks_left: Math.max(0, 1 + FORM_ASKS_AFTER_FIRST - s.sent),
      sent: s.sent,
    };
  }

  /**
   * The check-and-mark step (§5.2b): one synchronous step taken before the form's `await`, so two
   * concurrent calls on one question send one form. True when this call may send it (and it is now
   * marked open); false when one is open, no asks are left, or — `firstOnly`, the automatic send —
   * it was sent before.
   */
  claimSend(gateId: string, firstOnly: boolean): boolean {
    const s = this.sends.get(gateId) ?? { sent: 0, came_back: 0, open: false };
    if (s.open || s.sent >= 1 + FORM_ASKS_AFTER_FIRST || (firstOnly && s.sent > 0)) return false;
    this.sends.set(gateId, { ...s, sent: s.sent + 1, open: true });
    return true;
  }

  /** The form came back: with an answer (`answered`), or without one (counted). */
  closeSend(gateId: string, answered: boolean): void {
    const s = this.sends.get(gateId);
    if (s === undefined) return;
    this.sends.set(gateId, {
      ...s,
      open: false,
      came_back: answered ? s.came_back : s.came_back + 1,
    });
  }
}
