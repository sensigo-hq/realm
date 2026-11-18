// listen-reminders.ts — issue #597 D3b (design `DESIGN-D3-rev3.md` §1, §8): `realm listen
// --send-reminders`. A poll runner of its own (never the expiry sweeper's) and the sender: each pass
// reads the runs waiting at a question and, for each one whose posting `realm agent` is gone (its post
// file's writer has stopped), posts the due reminder or nudge into the question's own thread through
// the outbound ledger (`sendOnce`), so an agent that comes back and this server never both post it. A
// row's retries wait longer each time; a Slack-wide refusal pauses that workflow's sends until a probe
// passes. Everything a pass decides derives from the store's clock; only the pass budget is monotonic.
import {
  dueReminderWork,
  reminderAnchorOf,
  type OutboundLeaseRequest,
  type OutboundLedger,
  type PendingGate,
  type RunStore,
  type SlackGateNotifierConfig,
  type WorkflowDefinition,
} from '@sensigo/realm';
import {
  composeReminderPost,
  postSlackReply,
  slackAuthTest,
  DEFAULT_ESCALATION_THRESHOLD_MS,
  DEFAULT_REMINDER_INTERVAL_MS,
  REMINDER_GRACE_MS,
  type SlackVerdict,
} from '../agent/gate/slack-gate-notifier.js';
import { sendOnce } from '../agent/gate/outbound-send.js';
import { readSlackPostFile, slackPostPath } from '../agent/gate/slack-post-file.js';
import { rowsOfOneQuestion } from '../lib/outbound-words.js';
import type { Logger } from './listen.js';
// Gap 1, unit A0: the listing that reads no model call's text.
import { scanListedRuns, type ListedRecord } from '@sensigo/realm';

/** How often a pass runs: a poll, not a stored instant (every pass derives from the store's clock). */
export const REMINDER_POLL_MS = 60_000;
/** A pass's budget: after it no send or probe starts, and the next pass comes a second later. */
export const REMINDER_PASS_BUDGET_MS = 45_000;
/** How many attempts a row gets in all; the 9th is never made. */
export const REMINDER_MAX_ATTEMPTS = 8;
/** The waits before a paused workflow's next probe, in minutes. */
const PROBE_WAITS_MIN = [1, 2, 4, 8, 16, 30] as const;

const AUTH_CODES = new Set(
  'invalid_auth token_revoked account_inactive not_authed token_expired'.split(' '),
);
/** `auth.test` answers ok for any valid token: it cannot see these, so a real attempt probes them. */
const BLIND_CODES = new Set(['not_in_channel', 'missing_scope']);
/** What pauses a whole workflow, by name (never by `sendOnce`'s class); an HTTP 5xx too. */
const SLACK_WIDE = new Set([
  ...AUTH_CODES,
  ...BLIND_CODES,
  ...'ratelimited timeout error internal_error fatal_error service_unavailable request_timeout'.split(
    ' ',
  ),
]);

/** One pass at a time; a wake during a pass asks for exactly one more after it. */
export interface PollRunner {
  wake(): Promise<void>;
  /** The first signal: no further pass; resolves when the running pass (if any) has ended. */
  stop(): Promise<void>;
}

/**
 * The runner of a poll: `pass` is given whether the runner still runs, and answers whether it ended
 * on its budget (the next pass then comes a second later). A pass that throws is logged.
 */
export function makePollRunner(
  pass: (live: () => boolean) => Promise<boolean>,
  label: string,
  logger: Pick<Logger, 'error'>,
): PollRunner {
  let running: Promise<void> | undefined;
  let again = false;
  let stopped = false;
  let soon: NodeJS.Timeout | undefined;
  const live = (): boolean => !stopped;
  const loop = async (): Promise<void> => {
    let cut = false;
    do {
      again = false;
      try {
        cut = await pass(live);
      } catch (err) {
        logger.error(`listen: ${label}: pass failed`, { error: String(err) });
      }
    } while (again && !stopped);
    running = undefined;
    if (cut && !stopped) soon = setTimeout(() => void wake(), 1000).unref();
  };
  const wake = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (running !== undefined) {
      again = true;
      return running;
    }
    running = loop();
    return running;
  };
  return {
    wake,
    stop: () => {
      stopped = true;
      if (soon !== undefined) clearTimeout(soon);
      return running ?? Promise.resolve();
    },
  };
}

/** A mounted workflow's Slack settings, as the sender reads them. */
export interface ReminderWorkflow {
  readonly definition: WorkflowDefinition;
  readonly botToken: string;
  readonly channelId: string;
  readonly reminderIntervalMs: number;
  readonly escalationThresholdMs: number;
}

export interface ReminderSenderDeps {
  readonly runStore: Pick<RunStore, 'scan' | 'scanListed' | 'clock'>;
  /** The store's outbound ledger (`runStore.outbound`, present). */
  readonly outbound: OutboundLedger;
  /** Where the question post files are (`<home>/slack-posts/`). */
  readonly home: string;
  /** Workflow id → its settings: only the covered workflows. */
  readonly workflows: ReadonlyMap<string, ReminderWorkflow>;
  readonly logger: Pick<Logger, 'info' | 'warn' | 'error'>;
}

/** The code a send names: a non-2xx answer by its status (`HTTP 5xx` is Slack-wide), else `sendOnce`'s. */
const codeOf = (verdict: SlackVerdict | undefined, fallback: string): string =>
  verdict?.ok === false && verdict.cause === 'refused' && verdict.status !== undefined
    ? `HTTP ${verdict.status}`
    : fallback;
const slackWide = (code: string): boolean => SLACK_WIDE.has(code) || /^HTTP 5\d\d$/.test(code);

/**
 * The sender's one pass, with its in-process memory (the lines said once, the rows not retried, the
 * paused workflows). Answers whether it ended on its budget.
 */
export function makeReminderPass(
  deps: ReminderSenderDeps,
): (live: () => boolean) => Promise<boolean> {
  const { runStore, outbound, logger } = deps;
  const said = new Set<string>();
  /** A line said once per `key` in this process. */
  const say = (key: string, line: string): void => {
    if (said.has(key)) return;
    said.add(key);
    logger.warn(`listen: reminders: ${line}`);
  };
  /** Rows whose post was made but whose mark threw: never leased again in this process. */
  const unrecorded = new Set<string>();
  /** A paused workflow: its code, whether `auth.test` can see it, and its next probe. */
  const paused = new Map<string, { code: string; blind: boolean; probeAtMs: number }>();
  /** Per workflow: the index into PROBE_WAITS_MIN, and whether a recovery line is owed. */
  const waitIndex = new Map<string, number>();
  const owed = new Set<string>();
  const waitMs = (wf: string): number => PROBE_WAITS_MIN[waitIndex.get(wf) ?? 0]! * 60_000;
  const longerWait = (wf: string): void => {
    waitIndex.set(wf, Math.min((waitIndex.get(wf) ?? 0) + 1, PROBE_WAITS_MIN.length - 1));
  };

  const pause = (wf: string, code: string, nowMs: number): void => {
    if (!owed.has(wf)) {
      owed.add(wf);
      const auth = AUTH_CODES.has(code) ? '; a changed token needs a restart of realm listen' : '';
      logger.warn(
        `listen: reminders: Slack did not take a reminder for workflow ${wf} (${code}): reminders for it wait; checking again in about ${waitMs(wf) / 60_000} min${auth}`,
      );
    } else {
      // Correction 1: entered again before Slack took a send (a probe passed, the post did not): the
      // wait grows as after a failed probe; it returns to the first wait only at a send Slack took.
      longerWait(wf);
    }
    paused.set(wf, { code, blind: BLIND_CODES.has(code), probeAtMs: nowMs + waitMs(wf) });
  };
  const probeFailed = (wf: string, nowMs: number): void => {
    longerWait(wf);
    paused.get(wf)!.probeAtMs = nowMs + waitMs(wf);
  };
  const taken = (wf: string): void => {
    paused.delete(wf);
    waitIndex.set(wf, 0);
    if (owed.delete(wf)) {
      logger.info(
        `listen: reminders: Slack took a reminder for workflow ${wf} again: reminders for it resume`,
      );
    }
  };

  /** One question; answers whether the rest of its workflow is left alone this pass. */
  const remindOne = async (
    run: ListedRecord,
    gate: PendingGate,
    wfId: string,
    wf: ReminderWorkflow,
    live: () => boolean,
    spent: () => boolean,
  ): Promise<boolean> => {
    const file = await readSlackPostFile(
      slackPostPath(deps.home, run.id, gate.gate_id),
      wf.channelId,
    );
    if (file.kind === 'none' || file.kind === 'running') return false;
    const unusable = (): false => {
      say(
        `post:${run.id}:${gate.gate_id}`,
        `no usable post for run ${run.id}, question ${gate.gate_id}: not reminded`,
      );
      return false;
    };
    if (file.kind === 'not_usable') return unusable();
    const reading = runStore.clock.now();
    const anchor = reminderAnchorOf(gate, file.record.ts, reading);
    if (anchor.tsUnreadable) return unusable();
    const rows = rowsOfOneQuestion(await outbound.read(run.id), gate.gate_id);
    const item = dueReminderWork(gate, wf, anchor.anchorMs, rows, reading).find(
      (i) => i.state === 'due',
    );
    // Never the final of a question its expiry closes: it says "the run will be stopped".
    if (item === undefined || (item.isFinal && gate.on_expiry !== undefined)) return false;
    const what: OutboundLeaseRequest['what'] =
      item.what.type === 'reminder'
        ? { type: 'reminder', gateId: gate.gate_id, occurrence: item.what.occurrence }
        : { type: 'escalation', gateId: gate.gate_id };
    const words = item.what.type === 'reminder' ? `reminder ${item.what.occurrence}` : 'the nudge';
    const key = `${run.id}:${words}:${gate.gate_id}`;
    if (unrecorded.has(key)) return false;
    // A paused workflow takes no lease until its probe passes: `auth.test`, at its time; a blind
    // pause's probe is a row's own next attempt, at the later of its time and the row's spacing.
    const pausedNow = paused.get(wfId);
    const probeDue = (): boolean =>
      pausedNow !== undefined && reading.getTime() >= pausedNow.probeAtMs && !spent() && live();
    if (pausedNow !== undefined && !pausedNow.blind) {
      if (!probeDue()) return true;
      if (!(await slackAuthTest(wf.botToken)).ok) {
        probeFailed(wfId, runStore.clock.now().getTime());
        return true;
      }
      paused.delete(wfId);
    }
    // The row's own spacing: lease_deadline + 2^(attempts − 1) minutes, at most 8 attempts.
    const row = rows.find(
      (r) =>
        r.type === what.type && (what.type === 'escalation' || r.occurrence === what.occurrence),
    );
    if (row !== undefined && row.status === 'pending' && row.attempts >= 1) {
      const deadlineMs = Date.parse(row.lease_deadline);
      if (row.attempts >= REMINDER_MAX_ATTEMPTS) {
        if (reading.getTime() >= deadlineMs) {
          say(
            `cap:${key}`,
            `${words} of run ${run.id} not confirmed after 8 tries; not tried again`,
          );
        }
        return false;
      }
      if (reading.getTime() < deadlineMs + 2 ** (row.attempts - 1) * 60_000) return false;
    }
    if (pausedNow?.blind === true && !probeDue()) return true;
    // Correction 1: the budget guards the send too, not only the probe before it (an `auth.test`
    // that passed can end past the budget).
    if (!live() || spent()) return true;
    const nowMs = runStore.clock.now().getTime();
    const text = composeReminderPost({
      gate,
      runId: run.id,
      display: wf.definition.steps[gate.step_name]?.display,
      item,
      now: new Date(nowMs - item.atMs > REMINDER_GRACE_MS ? nowMs : item.atMs),
      listens: false,
    });
    let verdict: SlackVerdict | undefined;
    const outcome = await sendOnce({
      ledger: outbound,
      runId: run.id,
      what,
      text,
      post: async (t) =>
        (verdict = await postSlackReply(wf.botToken, file.record.channel, file.record.ts, t, true)),
    });
    // A blind pause's probe is this attempt: anything but a post Slack took is a failed probe.
    const probing = pausedNow?.blind === true;
    const later = runStore.clock.now().getTime();
    let took = false;
    let hold = false;
    switch (outcome.kind) {
      case 'skipped':
        break;
      case 'failed':
        // Correction 1: a permanent refusal (the channel is gone or archived): the row is `failed`
        // and never tried again. Said once per workflow and code; no cool-down.
        say(
          `failed:${wfId}:${outcome.code}`,
          `Slack refused ${words} of run ${run.id} (${outcome.code}): not tried again`,
        );
        break;
      case 'lease_threw':
        say(
          'lease',
          `the store refused a lease for run ${run.id} (${String(outcome.error)}); nothing sent for it`,
        );
        break;
      case 'sent':
        took = true;
        if (outcome.mark !== 'applied') {
          say(
            `dup:${key}`,
            `${words} of run ${run.id} posted, but another sender ${outcome.mark === 'outbound_done' ? 'had sent it: duplicate certain' : 'took its lease over meanwhile: duplicate possible'}`,
          );
        }
        break;
      case 'mark_threw':
        unrecorded.add(key);
        took = outcome.result === 'sent';
        say(
          `mark:${key}`,
          `${words} of run ${run.id} ${took ? 'posted' : `refused (${outcome.code ?? 'no code'})`}, could not be recorded: ${String(outcome.error)}`,
        );
        break;
      case 'unmarked': {
        const code = codeOf(verdict, outcome.code);
        if (slackWide(code)) {
          if (!probing) pause(wfId, code, later);
          hold = true;
          break;
        }
        say(
          `refused:${wfId}:${code}`,
          `Slack refused ${words} of run ${run.id} (${code}): tried again later`,
        );
        break;
      }
    }
    if (took) taken(wfId);
    else if (probing) {
      probeFailed(wfId, later);
      return true;
    }
    return hold;
  };

  return async (live) => {
    const started = performance.now();
    const spent = (): boolean => performance.now() - started >= REMINDER_PASS_BUDGET_MS;
    /** Workflows left alone for the rest of this pass (paused, or a probe not due). */
    const held = new Set<string>();
    // Gap 1, unit A0: listed, so no model call's text is read.
    const pages = scanListedRuns(runStore, { phase: 'gate_waiting' }, { pageSize: 1000 });
    for await (const page of pages) {
      for (const scanned of page.items) {
        if (!live()) return false;
        if (spent()) return true;
        if (scanned.kind !== 'run') continue;
        const run = scanned.run.record;
        const gate = run.pending_gate;
        const wf = deps.workflows.get(run.workflow_id);
        if (run.terminal_state || gate === undefined || wf === undefined) continue;
        if (held.has(run.workflow_id)) continue;
        try {
          if (await remindOne(run, gate, run.workflow_id, wf, live, spent))
            held.add(run.workflow_id);
        } catch (err) {
          logger.error('listen: reminders: pass failed', { run_id: run.id, error: String(err) });
        }
      }
    }
    return false;
  };
}

/** What a mounted workflow brings to the sender: its definition and its resolved Slack settings. */
export interface ReminderSource {
  readonly definition: WorkflowDefinition;
  readonly slackGate?: SlackGateNotifierConfig['config'];
}

/**
 * `--send-reminders` at start: the sender's runner, or `undefined` (and one line saying why) when the
 * store keeps no ledger, no home folder is known, or no mounted workflow has a bot token and channel.
 */
export function reminderSenderOf(
  sources: readonly ReminderSource[],
  deps: {
    readonly runStore: Pick<RunStore, 'scan' | 'scanListed' | 'clock' | 'outbound'>;
    readonly home: string | undefined;
    readonly logger: Pick<Logger, 'info' | 'warn' | 'error'>;
  },
): PollRunner | undefined {
  const { runStore, home, logger } = deps;
  const outbound = runStore.outbound;
  if (outbound === undefined || outbound === null) {
    logger.warn('listen: reminders: the store keeps no outbound ledger; not sent');
    return undefined;
  }
  if (home === undefined) {
    logger.warn('listen: reminders: no home folder known; not sent');
    return undefined;
  }
  const workflows = new Map<string, ReminderWorkflow>();
  for (const { definition, slackGate } of sources) {
    if (slackGate?.bot_token === undefined || slackGate.channel_id === undefined) continue;
    workflows.set(definition.id, {
      definition,
      botToken: slackGate.bot_token,
      channelId: slackGate.channel_id,
      reminderIntervalMs: slackGate.reminder_interval_ms ?? DEFAULT_REMINDER_INTERVAL_MS,
      escalationThresholdMs: slackGate.escalation_threshold_ms ?? DEFAULT_ESCALATION_THRESHOLD_MS,
    });
  }
  if (workflows.size === 0) {
    logger.info(
      'listen: reminders: no mounted workflow has a Slack bot token and channel; nothing to remind',
    );
    return undefined;
  }
  logger.info(`listen: reminders: covering workflows ${[...workflows.keys()].join(', ')}`);
  const pass = makeReminderPass({ runStore, outbound, home, workflows, logger });
  return makePollRunner(pass, 'reminders', logger);
}
