// slack-gate-notifier.ts — Slack gate notification logic.
// Owns all Slack-specific gate notification: formatting, posting, reminder timers,
// and bidirectional resolution via Events API or Socket Mode.
// Internal to the CLI package — not exported from the package's public index.
import {
  submitHumanResponse,
  describeAnswerEnding,
  describeEndedBy,
  type RunStore,
  type WorkflowDefinition,
  type PendingGate,
  type ExtensionRegistry,
  type Attributed,
  buildDisclosureSet,
  composePersonNotice,
  composeQuestionView,
  disclose,
  discloseGate,
  outcomeOf,
  respondWayOfGate,
  type DisclosureSet,
  type PersonNotice,
  type QuestionView,
  type RespondWay,
} from '@sensigo/realm';
import { stripMarks, withoutMarks, writerCtx, writerSetFor } from '../../output/writer.js';
import { cliCommandOf } from '../../commands/ways-renderer.js';
import { cutWayLine, terminalRespondLines } from '../../lib/holder-render.js';
import type { LlmProvider } from '../providers/llm-provider.js';
import { startSlackGateServer } from './slack-gate-server.js';
import { connectSocketMode } from './slack-socket-client.js';
import { deadlineSignal, readWithin, SLACK_CALL_DEADLINE_MS } from './slack-call.js';
import { scheduleGateExpiryTimer } from './gate-expiry-timer.js';

/**
 * #729 PR-3 (L-3; RECORD 05 "Slack"): Slack is a broadcast surface. The gate post is composed from
 * the gate as `discloseGate` shows it — the question at the declared tier, the preview as its shapes —
 * through core's ONE question composer, and is not walked again after composing. #729 PR-4 (02): it
 * renders the asked person's notices (`PersonNotice`): the opening post's route is the respond way
 * through the ways renderer; every thread reply is walked with every tier and names no operator
 * command (G9). Every body leaves through ONE send function, which strips the span marks
 * (U+E000–E002).
 */
function slackSet(): DisclosureSet {
  return (
    writerSetFor('broadcast') ??
    buildDisclosureSet({
      env: process.env,
      declared: {},
      declaredState: 'unknown',
      declaredCause: 'embedder_none',
      audience: 'broadcast',
    }).set
  );
}

/**
 * #729 PR-4 (02 §Transport (2)): what Slack said to one post — read from the HTTP status, and for the
 * Web API from its `ok`/`error` (Slack answers a Web API refusal with HTTP 200 and `ok: false`).
 */
export type SlackVerdict =
  | { readonly ok: true; readonly ts?: string }
  | { readonly ok: false; readonly cause: 'timeout' }
  | { readonly ok: false; readonly cause: 'refused'; readonly reason: string }
  | { readonly ok: false; readonly cause: 'error'; readonly error: unknown };

/** The operator's line for a post Slack did not take, naming the cause — `undefined` for a thrown
 *  error, which each caller words as it always has. */
export function slackFailureLine(verdict: SlackVerdict): string | undefined {
  if (verdict.ok) return undefined;
  if (verdict.cause === 'timeout') {
    return `Slack did not answer within ${SLACK_CALL_DEADLINE_MS / 1000} s`;
  }
  if (verdict.cause === 'refused') return `Slack refused the post: ${verdict.reason}`;
  return undefined;
}

type SlackCall = { readonly verdict: SlackVerdict } | { readonly retryAfterS: number | undefined };

/** Seconds from a `Retry-After` header in its seconds form; `undefined` otherwise. */
function retryAfterOf(response: Response): number | undefined {
  const raw = response.headers?.get('retry-after') ?? null;
  if (raw === null || !/^\d+$/.test(raw.trim())) return undefined;
  return Number(raw.trim());
}

/** One call under its own deadline, the body read included; a rate limit is returned, not judged. */
async function slackCall(
  url: string,
  body: Record<string, unknown>,
  botToken: string | undefined,
): Promise<SlackCall> {
  const deadline = deadlineSignal(SLACK_CALL_DEADLINE_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(botToken !== undefined ? { Authorization: `Bearer ${botToken}` } : {}),
      },
      body: stripMarks(JSON.stringify(body)),
      signal: deadline.signal,
    });
    if (response.status === 429) return { retryAfterS: retryAfterOf(response) };
    if (!response.ok) {
      const text = (await readWithin(deadline.signal, () => response.text())).trim();
      return {
        verdict: {
          ok: false,
          cause: 'refused',
          reason: text !== '' ? text : `HTTP ${response.status}`,
        },
      };
    }
    // A webhook answers with its status alone; the Web API with `ok`.
    if (botToken === undefined) return { verdict: { ok: true } };
    const data = (await readWithin(deadline.signal, () => response.json())) as {
      ok?: boolean;
      ts?: string;
      error?: string;
    };
    if (data.ok === true) {
      return { verdict: { ok: true, ...(data.ts !== undefined ? { ts: data.ts } : {}) } };
    }
    if (data.error === 'ratelimited') return { retryAfterS: retryAfterOf(response) };
    return { verdict: { ok: false, cause: 'refused', reason: data.error ?? 'unknown_error' } };
  } catch (err) {
    return {
      verdict: deadline.signal.aborted
        ? { ok: false, cause: 'timeout' }
        : { ok: false, cause: 'error', error: err },
    };
  } finally {
    deadline.clear();
  }
}

/**
 * The ONE send to Slack: a JSON body, with no span mark in it, under the call deadline, judged by
 * {@link SlackVerdict}. A rate limit whose `Retry-After` is within the deadline is retried ONCE, as
 * a second call with its own deadline; any other rate limit is a refusal (`ratelimited`). Never
 * throws.
 */
async function sendToSlack(
  url: string,
  body: Record<string, unknown>,
  botToken?: string,
): Promise<SlackVerdict> {
  const first = await slackCall(url, body, botToken);
  if ('verdict' in first) return first.verdict;
  const wait = first.retryAfterS;
  if (wait === undefined || wait * 1000 > SLACK_CALL_DEADLINE_MS) {
    return { ok: false, cause: 'refused', reason: 'ratelimited' };
  }
  console.warn(`  ⚠  Slack asked to wait ${wait} s before the post; retrying once`);
  await new Promise<void>((resolve) => setTimeout(resolve, wait * 1000));
  const second = await slackCall(url, body, botToken);
  return 'verdict' in second
    ? second.verdict
    : { ok: false, cause: 'refused', reason: 'ratelimited' };
}

/** A Slack section block's text limit, in characters (Slack's own; the derivation cell beside this
 *  renderer's test holds the channel table). */
export const SLACK_SECTION_TEXT_LIMIT = 3000;

/**
 * #729 PR-4 (g): the ONE escape table for what an author or an agent wrote (the question, the
 * preview, the step name, the owner, the choices) — never the renderer's own markup or fences:
 * `&`, `<`, `>` as Slack's entities; a run of three backticks spaced apart, so no fence can open; a
 * bidi or zero-width character as U+FFFD (one for one, visible, neutral).
 */
export const SLACK_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '```': '` ` `',
  ...Object.fromEntries(
    [...range(0x200b, 0x200f), ...range(0x202a, 0x202e), ...range(0x2066, 0x2069), 0xfeff].map(
      (cp) => [String.fromCodePoint(cp), '\uFFFD'],
    ),
  ),
};

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

const SLACK_ESCAPE_PATTERN = new RegExp(
  Object.keys(SLACK_ESCAPES)
    .sort((a, b) => b.length - a.length)
    .map((key) => key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|'),
  'gu',
);

/** An author's or an agent's string, escaped for Slack's mrkdwn by {@link SLACK_ESCAPES}. */
export function slackEscape(text: string): string {
  return text.replace(SLACK_ESCAPE_PATTERN, (match) => SLACK_ESCAPES[match]!);
}

/**
 * #729 PR-4 (02 (g), rev 8): an owner written in Slack's mention syntax keeps pinging — a user
 * (`<@U…>`, an enterprise-grid `<@W…>`), a user group (`<!subteam^S…>`) or a special mention
 * (`<!here>`, `<!channel>`, `<!everyone>`), the WHOLE string and nothing else; any other owner is
 * escaped by the one table.
 */
const SLACK_MENTION = [
  /^<@[UW][A-Z0-9]+>$/,
  /^<!subteam\^S[A-Z0-9]+>$/,
  /^<!(here|channel|everyone)>$/,
] as const;

/** The owner as Slack shows it: a mention passes through whole, anything else escaped. */
export function slackOwner(owner: string): string {
  return SLACK_MENTION.some((form) => form.test(owner)) ? owner : slackEscape(owner);
}

/** The view a gate post shows: core's composer over the gate disclosed for a broadcast (F26: the
 *  marks go before the law reads the gate). */
export function slackView(gate: PendingGate, display?: string): QuestionView {
  return composeQuestionView(discloseGate(withoutMarks(gate), slackSet(), 'broadcast'), display);
}

/** The view's own block: the question, a blank line, the preview (a code block when it is JSON),
 *  each escaped by the one table — the composer's view after this one transform. */
function viewBlockText(view: QuestionView): string {
  const question = slackEscape(view.question_text);
  const preview = slackEscape(view.preview_text);
  const join = (body: string): string =>
    question !== '' && body !== '' ? `${question}\n\n${body}` : question + body;
  const fenced =
    view.preview_format === 'json' && preview !== ''
      ? join('```\n' + preview + '\n```')
      : undefined;
  // The fence is the renderer's own markup: dropped only where it alone would pass the limit.
  const text =
    fenced !== undefined && fenced.length <= SLACK_SECTION_TEXT_LIMIT ? fenced : join(preview);
  return text !== '' ? text : '_(no output)_';
}

/** What `on_expiry` does, in the person's words (`expiry_reminder`). */
const ON_EXPIRY_WORDS: Readonly<Record<'settle_default' | 'abort' | 'none', string>> = {
  settle_default: 'its default choice will be recorded',
  abort: 'the run will be stopped',
  none: 'nothing will be done automatically; it is still waiting for a response',
};

/** How a slack host reaches the person: `mode` is the transport (a thread reply, or a channel post);
 *  `listens` says whether a listener attends the thread (#729 PR-4 correction, A1) — required, so no
 *  host claims a thread by leaving it out. A webhook post never has one. */
export interface SlackHost {
  mode: 'webhook' | 'bot';
  listens: boolean;
}

type SlackBlock = Record<string, unknown>;

/** The words a late answer's outcome is told in (`answer_late`). */
function lateWords(notice: Extract<PersonNotice, { kind: 'answer_late' }>): string {
  const { outcome } = notice;
  const choice = outcome.choice !== undefined ? `\`${slackEscape(outcome.choice)}\`` : undefined;
  switch (outcome.by.kind) {
    case 'answer': {
      const by = outcome.by.name !== undefined ? ` by ${slackEscape(outcome.by.name)}` : '';
      return `This question was already answered${by}${choice !== undefined ? ` — ${choice} —` : ''} before your reply arrived.`;
    }
    case 'timeout':
      return choice !== undefined
        ? `This question's time ran out before your reply arrived; it was settled as ${choice}.`
        : "This question's time ran out before your reply arrived; the run stopped.";
    case 'engine':
      return 'This question was withdrawn when the run stopped; your reply was not recorded.';
  }
}

/**
 * #729 PR-4 (02): one notice as Slack shows it. The opening post is four blocks — the header, the
 * view in its own block, the choices and the person's route, and (when the view was cut) the way to
 * the whole output; every other kind is one thread line, naming no operator command (G9).
 */
export function renderSlack(
  notice: PersonNotice,
  host: SlackHost,
): { blocks: SlackBlock[]; text: string } {
  const step = `\`${slackEscape(notice.step)}\``;
  switch (notice.kind) {
    case 'question_opened': {
      const owner = notice.owner !== undefined ? `\n*Owner:* ${slackOwner(notice.owner)}` : '';
      const choices = notice.view.choices.map((c) => `\`${slackEscape(c)}\``).join(' or ');
      // #729 PR-4 correction (A1): the route is keyed on whether Realm LISTENS in the thread, never
      // on the transport; the one respond command is always there (the ids a terminal answer needs).
      const command = slackEscape(cliCommandOf(notice.respond as RespondWay)!);
      const route = host.listens
        ? `Reply in this thread with ${choices}, or from a terminal:\n\`\`\`${command}\`\`\``
        : `*Gate requires a terminal response — open a terminal and run:*\n\`\`\`${command}\`\`\``;
      const section = (text: string): SlackBlock => ({
        type: 'section',
        text: { type: 'mrkdwn', text },
      });
      return {
        text: '⏸ Workflow gate waiting for approval',
        blocks: [
          section(`*Gate:* ${step}${owner}`),
          section(viewBlockText(notice.view)),
          section(route),
          ...(notice.view.cut !== undefined
            ? [
                {
                  type: 'context',
                  elements: [{ type: 'mrkdwn', text: slackEscape(cutWayLine(notice.run_id)) }],
                },
              ]
            : []),
        ],
      };
    }
    case 'reminder': {
      const mention =
        notice.escalation && notice.owner !== undefined ? `${slackOwner(notice.owner)} — ` : '';
      const open =
        notice.elapsed !== undefined ? `has been open for ${notice.elapsed}` : 'is still open';
      return { blocks: [], text: `${mention}⏰ gate ${step} ${open}. Please respond.` };
    }
    case 'expiry_reminder': {
      const ago = notice.overdue !== undefined ? ` ${notice.overdue} ago` : '';
      return {
        blocks: [],
        text: `⏰ gate ${step} expired${ago} — ${ON_EXPIRY_WORDS[notice.on_expiry]}.`,
      };
    }
    case 'answer_recorded': {
      const resolved = `✅ Gate resolved: \`${slackEscape(notice.choice)}\``;
      if (!notice.run_goes_on) return { blocks: [], text: `${resolved}. The run has ended.` };
      return {
        blocks: [],
        text:
          notice.resolution_message !== undefined
            ? `${resolved}\n${notice.resolution_message}`
            : `${resolved} — run continuing.`,
      };
    }
    case 'answer_late':
      return {
        blocks: [],
        text: `${lateWords(notice)} ${notice.run_goes_on ? 'The run goes on.' : 'The run has ended.'}`,
      };
    case 'answer_refused':
      return {
        blocks: [],
        text: `⚠️ Couldn't record your response (\`${notice.code}\`). Try again.`,
      };
    case 'question_closed': {
      const how =
        notice.how === 'expired'
          ? 'its time ran out'
          : notice.how === 'superseded'
            ? `it was answered elsewhere${notice.choice !== undefined ? ` as \`${slackEscape(notice.choice)}\`` : ''}`
            : 'the run stopped';
      // #729 PR-4 correction (C1): a channel post has no thread, so it names its gate and run.
      return {
        blocks: [],
        text:
          host.mode === 'webhook'
            ? `This question (gate ${step}, run ${notice.run_id}) is closed: ${how}.`
            : `This question is closed: ${how}.`,
      };
    }
  }
}

/** The opening notice for a gate a slack host posts. */
function openingNotice(gate: PendingGate, runId: string, display?: string): PersonNotice {
  return composePersonNotice({
    kind: 'question_opened',
    run_id: runId,
    gate,
    view: slackView(gate, display),
    respond: respondWayOfGate(runId, gate),
  });
}

/**
 * POSTs a gate-waiting notification to a Slack Incoming Webhook. A post Slack did not take is
 * reported with its cause (#729 PR-4, 02 §Transport (3)) and does not abort the workflow run.
 * Returns whether the post stood. Exported for testing.
 */
export async function postGateNotificationToSlack(
  webhookUrl: string,
  gate: PendingGate,
  runId: string,
  display?: string,
): Promise<boolean> {
  // #729 PR-4 (02): the `question_opened` notice, rendered for a webhook (the route from a terminal).
  const body = renderSlack(openingNotice(gate, runId, display), {
    mode: 'webhook',
    listens: false,
  });
  const verdict = await sendToSlack(webhookUrl, body);
  if (verdict.ok) return true;
  console.warn(
    `  ⚠  ${slackFailureLine(verdict) ?? `Slack notification failed: ${errorText(verdict)}`}`,
  );
  return false;
}

/** A thrown error's message, for the callers that word it themselves. */
function errorText(verdict: SlackVerdict): string {
  if (verdict.ok || verdict.cause !== 'error') return '';
  return verdict.error instanceof Error ? verdict.error.message : String(verdict.error);
}

/**
 * Posts a gate notification to Slack via chat.postMessage (bot token path).
 * Returns the message ts for use as a thread anchor, or undefined on failure.
 * Exported for testing.
 */
export async function postGateViaApi(
  botToken: string,
  channelId: string,
  gate: PendingGate,
  runId: string,
  listens: boolean,
  display?: string,
): Promise<string | undefined> {
  // #729 PR-4 (02): the `question_opened` notice, rendered for a bot; the route says the thread only
  // when a listener attends it (correction A1).
  const { text, blocks } = renderSlack(openingNotice(gate, runId, display), {
    mode: 'bot',
    listens,
  });
  const verdict = await sendToSlack(
    'https://slack.com/api/chat.postMessage',
    { channel: channelId, text, blocks },
    botToken,
  );
  if (verdict.ok) return verdict.ts;
  // #729 PR-4 (02 §Transport (3)): the cause on this console; the caller prints the person's way.
  const line = slackFailureLine(verdict);
  console.warn(
    line !== undefined ? `  ⚠  ${line}` : `Gate API notification failed: ${errorText(verdict)}`,
  );
  return undefined;
}

/**
 * Posts a reply to an existing Slack thread via chat.postMessage.
 * Failures are warned but not thrown — best-effort.
 * Exported for testing.
 */
export async function postSlackReply(
  botToken: string,
  channelId: string,
  threadTs: string,
  text: string,
): Promise<void> {
  // A thread reply is walked with every tier: it can carry an answer's words and a run's ending.
  const verdict = await sendToSlack(
    'https://slack.com/api/chat.postMessage',
    {
      channel: channelId,
      thread_ts: threadTs,
      text: disclose(stripMarks(text), slackSet(), 'all').text,
    },
    botToken,
  );
  if (verdict.ok) return;
  const line = slackFailureLine(verdict);
  console.warn(line !== undefined ? `  ⚠  ${line}` : `Slack reply failed: ${errorText(verdict)}`);
}

/**
 * Issue #291 ([F-A2-1]/[F-A2-2]/[F-A2-3] — the authored notify clock); #729 PR-4 (02): one firing of
 * the reminder timer, as the person's notice — `isFinal` (only ever true when `gate.expires_at` is
 * frozen) composes the `expiry_reminder` (the enforcement fact, never soliciting a doomed response),
 * any other firing the plain `reminder`. G9: the operator's command that carries out the expiry
 * (`realm run drain --expired`) is printed on this console, never posted to the person's thread.
 */
function reminderFiring(
  gate: PendingGate,
  runId: string,
  display: string | undefined,
  isFinal: boolean,
  count: number,
  scheduledAt: Date,
  listens: boolean,
): string {
  const now = new Date();
  const base = {
    run_id: runId,
    gate,
    view: slackView(gate, display),
    respond: respondWayOfGate(runId, gate),
  };
  if (isFinal && gate.on_expiry !== undefined) {
    console.log(
      `  ⏰ gate '${gate.step_name}' expired — ${writerCtx().cmd('realm run drain --expired')} carries out its on_expiry (${gate.on_expiry}).`,
    );
  }
  const notice = isFinal
    ? composePersonNotice({ kind: 'expiry_reminder', ...base, now })
    : composePersonNotice({
        kind: 'reminder',
        ...base,
        scheduled_at: scheduledAt.toISOString(),
        count,
        escalation: false,
        now,
      });
  return renderSlack(notice, { mode: 'bot', listens }).text;
}

/**
 * Starts reminder and escalation timers for an open gate.
 *
 * Issue #291 (Deliverable 6 — the authored notify clock): the REMINDER leg now repeats when the
 * gate carries a frozen `reminder_seconds` ([F-A2-1]): every `reminder_seconds` (record-keyed
 * precedence over `reminderIntervalMs` [F-A2-2] — the author's declared value always wins when
 * present), up to `reminder_max` occurrences (frozen at mint, default 3) OR until the frozen
 * `expires_at` is reached, whichever comes first — the occurrence that would land at/after
 * `expires_at` is the FINAL one, with wording switched to the enforcement fact (never soliciting
 * a doomed response). A PURE-notify gate (`reminder_seconds` frozen, no `expires_at`) is bounded
 * by `reminder_max` alone, all plain-wording occurrences. When the author declared NO
 * `reminder_seconds`, the OPERATOR fallback (`reminderIntervalMs`) stays exactly as before —
 * SINGLE-SHOT, unchanged behavior for existing deployments ([F-A2-3] — repeating it would alter
 * an unchanged config's Slack volume). The ESCALATION leg is completely untouched either way.
 * Returns a cleanup function that clears every pending timer — must be called when the gate
 * resolves. Exported for testing.
 */
export function startGateReminderTimers(
  botToken: string,
  channelId: string,
  threadTs: string,
  gate: PendingGate,
  reminderIntervalMs: number,
  escalationThresholdMs: number,
  runId = '',
  display?: string,
  listens = true,
): () => void {
  const authored = gate.reminder_seconds !== undefined;
  const effectiveReminderMs = authored ? gate.reminder_seconds! * 1000 : reminderIntervalMs;
  // [F-A2-3]: the operator fallback stays single-shot — reminder_max only ever bounds the
  // AUTHORED cycle (reminder_max is frozen alongside reminder_seconds — always defined together).
  const reminderMax = authored ? (gate.reminder_max ?? 3) : 1;
  const expiresAtMs =
    gate.expires_at !== undefined ? new Date(gate.expires_at).getTime() : undefined;

  let reminderTimer: ReturnType<typeof setTimeout> | undefined;
  let occurrence = 0;
  let cancelled = false;

  const scheduleNext = (): void => {
    if (cancelled || occurrence >= reminderMax) return;
    const nextFireAtMs = Date.now() + effectiveReminderMs;
    const isFinal = expiresAtMs !== undefined && nextFireAtMs >= expiresAtMs;
    const scheduledAt = new Date(nextFireAtMs);
    reminderTimer = setTimeout(() => {
      occurrence += 1;
      postSlackReply(
        botToken,
        channelId,
        threadTs,
        reminderFiring(gate, runId, display, isFinal, occurrence, scheduledAt, listens),
      ).catch((err) => {
        console.warn(`Reminder post failed: ${err instanceof Error ? err.message : String(err)}`);
      });
      if (!isFinal) scheduleNext();
    }, effectiveReminderMs);
  };
  scheduleNext();

  const escalationScheduledAt = new Date(Date.now() + escalationThresholdMs);
  const escalationTimer = setTimeout(() => {
    // #729 PR-4 (02): the escalation is the `reminder` notice with its owner named.
    const text = renderSlack(
      composePersonNotice({
        kind: 'reminder',
        run_id: runId,
        gate,
        view: slackView(gate, display),
        respond: respondWayOfGate(runId, gate),
        scheduled_at: escalationScheduledAt.toISOString(),
        count: 1,
        escalation: true,
        now: new Date(),
      }),
      { mode: 'bot', listens },
    ).text;
    postSlackReply(botToken, channelId, threadTs, text).catch((err) => {
      console.warn(`Escalation post failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }, escalationThresholdMs);

  return () => {
    cancelled = true;
    if (reminderTimer !== undefined) clearTimeout(reminderTimer);
    clearTimeout(escalationTimer);
  };
}

/**
 * Issue #291 (Amendment: "dead-notification advisory" — [F-A2-1]/pedestal-lane Q5 rule 2): warns
 * ONCE, at notifier wiring, when the OPERATOR fallback's own reminder/escalation config could
 * never fire before the frozen enforce clock expires — never solicits a response the gate will
 * already have refused. Only meaningful for the operator-fallback path (an AUTHORED
 * `reminder_seconds` already gets its own load-time cross-validation — [Amendment 2],
 * yaml-loader.ts's `reminder_seconds >= timeout_seconds` DEAD_GATE_CONFIG warn — this is the
 * SAME check's CLI-side counterpart for the config the loader cannot see). Exported for testing.
 */
export function checkDeadNotificationAdvisory(
  gate: PendingGate,
  reminderIntervalMs: number,
  escalationThresholdMs: number,
): string | undefined {
  if (gate.reminder_seconds !== undefined || gate.expires_at === undefined) return undefined;
  const windowMs = new Date(gate.expires_at).getTime() - new Date(gate.opened_at).getTime();
  const deadReminder = reminderIntervalMs >= windowMs;
  const deadEscalation = escalationThresholdMs >= windowMs;
  if (!deadReminder && !deadEscalation) return undefined;
  const parts: string[] = [];
  if (deadReminder) parts.push(`the reminder (${reminderIntervalMs}ms)`);
  if (deadEscalation) parts.push(`the escalation (${escalationThresholdMs}ms)`);
  return (
    `dead notification: ${parts.join(' and ')} on gate '${gate.step_name}' will never fire ` +
    `before its authored timeout_seconds elapses (${windowMs}ms window) — the operator ` +
    `reminder/escalation config never reaches the human before the gate expires.`
  );
}

/** Parameters for the bidirectional gate handler. Exported for testing. */
export interface BidirectionalGateParams {
  gate: PendingGate;
  runId: string;
  definition: WorkflowDefinition;
  store: RunStore;
  provider: LlmProvider;
  slackBotToken: string;
  slackChannelId: string;
  gateThreadTs: string | undefined;
  slackSigningSecret?: string;
  slackEventsPort: number;
  /** App-level token (xapp-…) — enables Socket Mode when set (manifest: notifiers.slack_gate.app_token). */
  slackAppToken?: string;
  gateReminderIntervalMs: number;
  gateEscalationThresholdMs: number;
  pollIntervalMs: number;
  /**
   * Resolved project registry for the run — threaded into submitHumanResponse so a gate
   * resolution that COMPLETES the run fires its finalizers with project handlers. Undefined
   * falls back to the engine's default (filesystem-only) registry.
   */
  registry?: ExtensionRegistry;
  /**
   * Issue #625 (holder slice): the program this attendant runs in — named on the cleanup steps an
   * answer drains (`driven_by`). The answerer is named by nothing here: a Slack reply carries no
   * `responded_by` (#603) and no `claim_token` (the CLI never passes one).
   */
  driver?: Attributed;
}

/**
 * Handles a gate using Slack bidirectional resolution:
 * - Events API (when signing secret is present) or Socket Mode (when app token is present)
 * - LLM intent interpretation of Slack replies
 * - Reminder and escalation timers
 * - Falls back to store polling for terminal-command gate resolution
 * Exported for testing.
 */
/**
 * Bounded ceiling for the in-flight candidate drain in {@link handleBidirectionalGate}'s finally and
 * the webhook loop's closed post. Each Slack call has its own deadline (`SLACK_CALL_DEADLINE_MS`,
 * 30 s), far longer than a run should wait for a thread reply. 2s comfortably covers a healthy
 * postSlackReply flush (~100-300ms); on a hung Slack + run-completing gate it exits after 2s and the
 * operator is told the post was not delivered (#729 PR-4) — never a stall.
 */
const DRAIN_TIMEOUT_MS = 2000;

/** #729 PR-4 (02 §Transport (4)): the operator's line when a thread post outlives the drain bound —
 *  it claims nothing about the run (a closed gate may have ended it). */
const THREAD_POST_UNDELIVERED = `Slack thread post not delivered within ${DRAIN_TIMEOUT_MS / 1000} s; the question is closed`;

export async function handleBidirectionalGate(params: BidirectionalGateParams): Promise<void> {
  const {
    gate,
    runId,
    definition,
    store,
    provider: _provider,
    slackBotToken,
    slackChannelId,
    gateThreadTs,
    slackSigningSecret,
    slackEventsPort,
    slackAppToken,
    gateReminderIntervalMs,
    gateEscalationThresholdMs,
    pollIntervalMs,
    registry,
    driver,
  } = params;

  let clarificationCount = 0;
  // Posted at most once per gate — a repeatedly-failing submit must not hammer Slack.
  let submitErrorPosted = false;
  // #729 PR-4 (02): whether the thread was told how a Slack answer went — else, when the question
  // closes, the thread is told it closed (`question_closed`).
  let personTold = false;
  const abortController = new AbortController();
  // #729 PR-4 correction (A1): a listener attends the thread — the two intake branches below.
  const listens = slackAppToken !== undefined || slackSigningSecret !== undefined;
  // #729 PR-4: one notice, as the thread shows it — through `postSlackReply`, walked at every tier.
  const tellThread = async (notice: PersonNotice): Promise<void> => {
    if (gateThreadTs === undefined) return;
    await postSlackReply(
      slackBotToken,
      slackChannelId,
      gateThreadTs,
      renderSlack(notice, { mode: 'bot', listens }).text,
    );
  };

  // Track in-flight candidate processing so the finally can drain it (bounded) before returning —
  // otherwise a run-completing gate can process.exit() and truncate the confirmation reply that is
  // still in flight inside the un-awaited processCandidate chain.
  const inFlight = new Set<Promise<void>>();
  const track = (p: Promise<void>): void => {
    inFlight.add(p);
    void p.finally(() => inFlight.delete(p));
  };

  const processCandidate = async (text: string): Promise<void> => {
    if (abortController.signal.aborted) return;

    // Gate choices must be exact (case-insensitive). No LLM interpretation — gate responses
    // are irreversible writes and must reflect unambiguous intent.
    const normalised = text.trim().toLowerCase();
    const exactMatch = gate.choices.find((c) => c.toLowerCase() === normalised);

    if (exactMatch !== undefined) {
      // Surface a submit failure to the operator ONCE. Deliberately does NOT abort()/resolve — the
      // gate stays open so the poll loop keeps waiting and the operator can retry or use the terminal
      // fallback. Runs inside processCandidate → tracked + drained (§track), so it is guaranteed sent
      // before handleBidirectionalGate returns.
      // #729 PR-4 (02): the person is told the code, never a terminal command (G9); the detail
      // stays on this console.
      const postSubmitError = async (
        detail: string,
        code: Extract<PersonNotice, { kind: 'answer_refused' }>['code'],
      ): Promise<void> => {
        console.warn(`Gate response submission failed: ${detail}`);
        if (gateThreadTs !== undefined && !submitErrorPosted) {
          submitErrorPosted = true;
          await tellThread(
            composePersonNotice({
              kind: 'answer_refused',
              run_id: runId,
              gate,
              choice: exactMatch,
              code,
            }),
          );
        }
      };
      try {
        // submitHumanResponse signals failure by RETURNING an error envelope (it does not throw);
        // gate on that status so we never post a false confirmation or abort on a failed submit.
        // (The catch below still handles an unexpected throw identically.)
        // F9: the record before the answer — the finalizer lines name only the cleanup steps this
        // answer's ending ran or left pending. A record this read could not get leaves every
        // cleanup step's line (the answer's own call then reads it, or refuses).
        const before = await store.get(runId).catch(() => undefined);
        const result = await submitHumanResponse(store, definition, {
          runId,
          gateId: gate.gate_id,
          choice: exactMatch,
          // #819 (item 28): the answer records how it arrived — a Slack thread.
          route: 'slack',
          // decision C151: an expiry this late answer carries out names `realm agent`.
          caller: 'agent',
          ...(registry !== undefined ? { registry } : {}),
          ...(driver !== undefined ? { driver } : {}),
        });
        if (result.answer_recorded === false) {
          // decision C146: an answer that came after the question's time was up was not recorded —
          // the expiry settled the gate (or ended the run), so there is nothing to try again. The
          // composer's lines go to the thread and to this terminal, as `realm run respond` and the
          // run prompt print them: which call carried out the expiry (`this agent call …`, or
          // another call), the refusal or the same-choice sentence, what the expiry's guards did.
          let lateLines: string[];
          try {
            lateLines = describeAnswerEnding(result, await store.get(runId), {
              gateId: gate.gate_id,
              via: 'agent',
              workflow: definition,
              before: before ?? {},
              now: new Date(),
            });
          } catch {
            // The record could not be read (only the finalizer outcomes need it): the reply's own
            // sentence, so the person still learns the answer was not recorded.
            lateLines = [result.errors[0] ?? result.context_hint];
          }
          // #729 PR-4 (02): the operator's lines stay on this console; the thread gets the person's
          // words for what the question met (`answer_late`), naming no command.
          for (const line of lateLines) console.log(line);
          const after = await store.get(runId).catch(() => undefined);
          const outcome =
            result.outcome ??
            (after !== undefined
              ? outcomeOf(after, gate.step_name, gate.expires_at, true)
              : undefined);
          // Set before the post: a reply still in flight when the poll ends must not be joined by
          // a closed line (the drain is bounded; a hung Slack would otherwise post both).
          personTold = true;
          if (outcome !== undefined) {
            await tellThread(
              composePersonNotice({
                kind: 'answer_late',
                run_id: runId,
                gate,
                choice: exactMatch,
                outcome,
                ended: result.ended_by !== undefined || after?.terminal_state === true,
              }),
            );
          }
          abortController.abort();
        } else if (result.status === 'error') {
          await postSubmitError(
            result.errors[0] ?? result.context_hint ?? 'unknown error',
            result.error_code ?? 'ENGINE_INTERNAL',
          );
        } else {
          // Success — resolution IS the store write inside submitHumanResponse. Confirm + stop.
          // issue #625: the answer's own write settles the guards it makes eligible, and one of
          // them may have ENDED the run. #729 PR-4 (02): the thread is told the choice was recorded
          // (`answer_recorded`) — with the authored resolution message only when the run goes on —
          // and, when the answer ended the run, the operator's lines (the guard's sentence, its
          // reason, each finalizer's outcome) go to this console, never to the person's thread.
          if (result.ended_by !== undefined) {
            let endingLines: string[];
            try {
              endingLines = describeAnswerEnding(result, await store.get(runId), {
                gateId: gate.gate_id,
                via: 'agent',
                workflow: definition,
                before: before ?? {},
                now: new Date(),
              });
            } catch {
              // The answer IS recorded — a failed read here must not reach the catch below and
              // tell the person their answer was not recorded. Only the finalizer outcomes need
              // the record; the ending and its reason are on the reply.
              endingLines = describeEndedBy(result);
            }
            for (const line of endingLines) console.log(line);
          }
          personTold = true;
          await tellThread(
            composePersonNotice({
              kind: 'answer_recorded',
              run_id: runId,
              gate,
              choice: exactMatch,
              ended: result.ended_by !== undefined,
            }),
          );
          abortController.abort();
        }
      } catch (err) {
        await postSubmitError(err instanceof Error ? err.message : String(err), 'ENGINE_INTERNAL');
      }
    } else if (clarificationCount < 2 && gateThreadTs !== undefined) {
      clarificationCount++;
      await postSlackReply(
        slackBotToken,
        slackChannelId,
        gateThreadTs,
        `Please reply with one of: ${gate.choices.join(', ')}`,
      );
    }
  };

  // Set up candidate intake — Socket Mode (preferred), Events API, or none.
  // Dedup set prevents duplicate onEvent calls. Socket Mode (preferred) and Events API both
  // have at-least-once delivery — the same event can arrive more than once.
  const seenEventIds = new Set<string>();
  let serverHandle: { close(): void } | undefined;
  if (slackAppToken !== undefined && gateThreadTs !== undefined) {
    // Mode 2 — Socket Mode (WebSocket push, no public URL required)
    serverHandle = connectSocketMode({
      appToken: slackAppToken,
      threadTs: gateThreadTs,
      onEvent: (event) => {
        if (seenEventIds.has(event.event_id)) return;
        seenEventIds.add(event.event_id);
        track(
          processCandidate(event.text).catch((err) => {
            console.warn(
              `Candidate processing failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }),
        );
      },
      signal: abortController.signal,
    });
  } else if (slackSigningSecret !== undefined && gateThreadTs !== undefined) {
    // Mode 3 — Events API (HTTP push, requires public URL)
    serverHandle = startSlackGateServer({
      port: slackEventsPort,
      signingSecret: slackSigningSecret,
      onEvent: (event) => {
        if (seenEventIds.has(event.event_id)) return;
        seenEventIds.add(event.event_id);
        if (event.thread_ts !== gateThreadTs) return;
        track(
          processCandidate(event.text).catch((err) => {
            console.warn(
              `Candidate processing failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }),
        );
      },
    });
  } else if (gateThreadTs !== undefined) {
    // Gate notification posted but no listener configured: nobody reads the thread, so the
    // person's way to answer is the terminal's (#729 PR-4 correction, A2).
    console.log(
      '  ℹ  Gate notification posted; no listener is configured (app_token for Socket Mode, or signing_secret + events_port for the Events API under notifiers.slack_gate in realm.yaml), so the answer comes from the terminal:',
    );
    terminalRespondLines(runId, gate).forEach((_, i) =>
      console.log(terminalRespondLines(runId, gate, writerCtx())[i]),
    );
  }

  // #729 PR-4 (02 §Transport (3)): no thread anchor means the opening post failed (its cause is
  // already on this console) — the person's way to answer on the terminal is printed, as `realm agent`
  // prints it when no handler attends the gate; the expiry timer and the poll below still run.
  if (gateThreadTs === undefined) {
    terminalRespondLines(runId, gate).forEach((_, i) =>
      console.log(terminalRespondLines(runId, gate, writerCtx())[i]),
    );
  }

  // Start reminder/escalation timers if we have a thread anchor.
  const clearTimers =
    gateThreadTs !== undefined
      ? startGateReminderTimers(
          slackBotToken,
          slackChannelId,
          gateThreadTs,
          gate,
          gateReminderIntervalMs,
          gateEscalationThresholdMs,
          runId,
          definition.steps[gate.step_name]?.display,
          listens,
        )
      : (): void => {};

  // issue #291 (dead-notification advisory): printed once, at notifier wiring.
  if (gateThreadTs !== undefined) {
    const advisory = checkDeadNotificationAdvisory(
      gate,
      gateReminderIntervalMs,
      gateEscalationThresholdMs,
    );
    if (advisory !== undefined) console.warn(`⚠ ${advisory}`);
  }

  // issue #291 (Deliverable 4e, Amendment 4): the ATTENDING-PROCESS enactment timer — independent
  // of Slack notification wiring (it fires regardless of whether a thread anchor exists; this
  // process is holding the gate open either way). A no-op for a finding-only/non-expiring gate.
  const clearExpiryTimer = scheduleGateExpiryTimer(runId, gate, {
    store,
    definition,
    ...(registry !== undefined ? { registry } : {}),
    ...(driver !== undefined ? { driver } : {}),
  });

  try {
    // Poll the store as the unified done-detector — resolves when candidate processor
    // calls submitHumanResponse OR when the terminal command is used.
    await pollUntilGateResolved(store, runId, gate.gate_id, pollIntervalMs, abortController.signal);
    // #729 PR-4 (02): the question closed without a Slack answer this thread was told about — the
    // thread is told how (its time ran out, the run stopped, it was answered elsewhere). A Slack
    // answer still in flight when the poll ended (its write is what ended the poll) decides first, so
    // the closed line never follows the person's own answer. Best effort, tracked into the drain
    // below, so the whole of it is bounded.
    const answersInFlight = [...inFlight];
    track(
      (async (): Promise<void> => {
        await Promise.allSettled(answersInFlight);
        if (personTold) return;
        const closed = await closedNotice(store, runId, gate);
        if (closed !== undefined) await tellThread(closed);
      })().catch((err) => {
        console.warn(`Slack reply failed: ${err instanceof Error ? err.message : String(err)}`);
      }),
    );
  } finally {
    abortController.abort();
    clearTimers();
    clearExpiryTimer();
    serverHandle?.close();
    // Let the resolving candidate's confirmation (or submit-error) reply flush before process.exit()
    // can truncate it on a run-completing gate. BOUNDED by DRAIN_TIMEOUT_MS so a hung Slack can't
    // stall run progress; the timer is CLEARED so it never leaks a pending handle (this is a
    // de-flake change). ~instant on the common single-exact-match path (the resolving
    // processCandidate calls abort() only AFTER awaiting postSlackReply, so by the time the poll
    // loop breaks the reply has flushed); it waits (≤2s) only when a reply is genuinely still in
    // flight. Candidate-scoped: reminder/escalation replies stay best-effort (cleared on resolve).
    // #729 PR-4 (02 §Transport (4)): when the bound fires, the operator is told — once.
    let drainTimer: ReturnType<typeof setTimeout>;
    const bound = new Promise<'bound'>((resolve) => {
      drainTimer = setTimeout(() => resolve('bound'), DRAIN_TIMEOUT_MS);
    });
    try {
      const drained = await Promise.race([
        Promise.allSettled([...inFlight]).then(() => 'drained' as const),
        bound,
      ]);
      if (drained === 'bound') console.warn(`  ⚠  ${THREAD_POST_UNDELIVERED}`);
    } finally {
      clearTimeout(drainTimer!);
    }
  }
}

/** #729 PR-4 (02): how a question closed, from the record as it is now (`outcomeOf`, nothing
 *  attempted by this host); `undefined` when the record cannot be read. */
async function closedNotice(
  store: RunStore,
  runId: string,
  gate: PendingGate,
): Promise<PersonNotice | undefined> {
  try {
    const run = await store.get(runId);
    return composePersonNotice({
      kind: 'question_closed',
      run_id: runId,
      gate,
      outcome: outcomeOf(run, gate.step_name, gate.expires_at, false),
    });
  } catch {
    // A notice is never the attendant's failure: a record that cannot be read tells nothing.
    return undefined;
  }
}

/** Polls the store until the gate is resolved or the run reaches a terminal state. */
async function pollUntilGateResolved(
  store: RunStore,
  runId: string,
  gateId: string,
  intervalMs: number,
  signal?: AbortSignal,
): Promise<void> {
  console.log('   Waiting for approval...');
  for (;;) {
    if (signal?.aborted) break;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, intervalMs);
      if (signal !== undefined) {
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      }
    });
    if (signal?.aborted) break;
    const run = await store.get(runId);
    if (run.terminal_state) break;
    if (run.pending_gate === undefined || run.pending_gate.gate_id !== gateId) break;
  }
}

export interface SlackGateHandlerConfig {
  store: RunStore;
  definition: WorkflowDefinition;
  /** Required by handleBidirectionalGate for LLM intent parsing. */
  provider: LlmProvider;
  webhookUrl?: string;
  botToken?: string;
  channelId?: string;
  signingSecret?: string;
  eventsPort?: number;
  appToken?: string;
  reminderIntervalMs?: number;
  escalationThresholdMs?: number;
  pollIntervalMs?: number;
  /** Resolved project registry for the run — forwarded so gate-completed runs fire finalizers. */
  registry?: ExtensionRegistry;
  /** Issue #625: the program this handler runs in — forwarded to the attendant. */
  driver?: Attributed;
}

/**
 * Creates a gate handler that notifies via Slack and waits for resolution.
 * Returns a function typed (runId, gate) => Promise<void>.
 */
export function createSlackGateHandler(
  config: SlackGateHandlerConfig,
): (runId: string, gate: PendingGate) => Promise<void> {
  return async (runId, gate) => {
    // Bidirectional path (bot token + channel).
    if (config.botToken !== undefined && config.channelId !== undefined) {
      const display = config.definition.steps[gate.step_name]?.display;
      const gateThreadTs = await postGateViaApi(
        config.botToken,
        config.channelId,
        gate,
        runId,
        config.appToken !== undefined || config.signingSecret !== undefined,
        display,
      );
      await handleBidirectionalGate({
        gate,
        runId,
        definition: config.definition,
        store: config.store,
        provider: config.provider,
        slackBotToken: config.botToken,
        slackChannelId: config.channelId,
        gateThreadTs,
        ...(config.signingSecret !== undefined ? { slackSigningSecret: config.signingSecret } : {}),
        slackEventsPort: config.eventsPort ?? 3100,
        ...(config.appToken !== undefined ? { slackAppToken: config.appToken } : {}),
        gateReminderIntervalMs: config.reminderIntervalMs ?? 600_000,
        gateEscalationThresholdMs: config.escalationThresholdMs ?? 1_800_000,
        pollIntervalMs: config.pollIntervalMs ?? 3000,
        ...(config.registry !== undefined ? { registry: config.registry } : {}),
        ...(config.driver !== undefined ? { driver: config.driver } : {}),
      });
    } else if (config.webhookUrl !== undefined) {
      // One-way webhook + inline poll loop (avoids circular dependency with run-agent.ts).
      const posted = await postGateNotificationToSlack(
        config.webhookUrl,
        gate,
        runId,
        config.definition.steps[gate.step_name]?.display,
      );
      // #729 PR-4 (02 §Transport (3)): a post Slack did not take (its cause already printed) — the
      // person's way to answer on the terminal, as `realm agent` prints it with no handler.
      if (!posted) {
        terminalRespondLines(runId, gate).forEach((_, i) =>
          console.log(terminalRespondLines(runId, gate, writerCtx())[i]),
        );
      }
      console.log('   Waiting for approval...');
      const intervalMs = config.pollIntervalMs ?? 3000;
      for (;;) {
        await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
        const run = await config.store.get(runId);
        if (run.terminal_state) break;
        if (run.pending_gate === undefined || run.pending_gate.gate_id !== gate.gate_id) break;
      }
      // #729 PR-4 (02): a webhook takes no answer, so the question always closed elsewhere — the
      // channel is told how, walked at every tier as a thread reply is (not when the channel was
      // never asked: the opening post failed). Awaited under the drain bound, as the bot path's.
      const closed = posted ? await closedNotice(config.store, runId, gate) : undefined;
      if (closed !== undefined) {
        let bound: ReturnType<typeof setTimeout> | undefined;
        try {
          const sent = await Promise.race([
            sendToSlack(config.webhookUrl, {
              text: disclose(
                stripMarks(renderSlack(closed, { mode: 'webhook', listens: false }).text),
                slackSet(),
                'all',
              ).text,
            }).then((verdict) => {
              if (!verdict.ok) {
                const line = slackFailureLine(verdict);
                console.warn(`  ⚠  ${line ?? `Slack notification failed: ${errorText(verdict)}`}`);
              }
              return 'sent' as const;
            }),
            new Promise<'bound'>((resolve) => {
              bound = setTimeout(() => resolve('bound'), DRAIN_TIMEOUT_MS);
            }),
          ]);
          if (sent === 'bound') console.warn(`  ⚠  ${THREAD_POST_UNDELIVERED}`);
        } finally {
          clearTimeout(bound);
        }
      }
    }
  };
}
