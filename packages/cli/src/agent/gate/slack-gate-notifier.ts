// slack-gate-notifier.ts — Slack gate notification logic.
// Owns all Slack-specific gate notification: formatting, posting, reminder timers,
// and bidirectional resolution via Events API or Socket Mode.
// Internal to the CLI package — not exported from the package's public index.
import {
  parseStamp,
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
  type Snapshot,
  judgedSnapshotOf,
  reminderScheduleOf,
} from '@sensigo/realm';
import { stripMarks, withoutMarks, writerCtx, writerSetFor } from '../../output/writer.js';
import { cliCommandOf } from '../../commands/ways-renderer.js';
import { renderOutcome } from '@sensigo/realm-mcp';
import {
  PEOPLE_DOOR_WORDS,
  cutWayLine,
  questionDeadlineLine,
  terminalRespondLines,
} from '../../lib/holder-render.js';
import type { LlmProvider } from '../providers/llm-provider.js';
import { startSlackGateServer } from './slack-gate-server.js';
import { connectSocketMode } from './slack-socket-client.js';
import { deadlineSignal, readWithin, SLACK_CALL_DEADLINE_MS } from './slack-call.js';
import { scheduleGateExpiryTimer } from './gate-expiry-timer.js';
import {
  createSlackPostFile,
  readSlackPostFile,
  releaseSlackPostFile,
  replaceSlackPostFile,
  slackPostPath,
  takeOverSlackPostFile,
} from './slack-post-file.js';

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
      cwd: process.cwd(),
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

/**
 * #729 PR-6a (B9): what a reply that was not recorded met, in the people's words, through the one
 * sentence-maker (`renderOutcome`), Slack-escaped whole — so a stated name such as `<!channel>`
 * cannot ping anyone. After the settled-by-its-time-limit sentence, whether the run goes on.
 */
function notRecordedWords(notice: Extract<PersonNotice, { kind: 'answer_late' }>): string {
  const { outcome } = notice;
  const sentence = slackEscape(renderOutcome(outcome, PEOPLE_DOOR_WORDS));
  if (outcome.by.kind !== 'timeout' || outcome.choice === undefined) return sentence;
  return `${sentence} ${notice.run_goes_on ? 'The run goes on.' : 'The run has ended.'}`;
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
      const choices = notice.view.choices.map((c) => `\`${slackEscape(c)}\``).join(' or ');
      // #729 PR-4 correction (A1): the route is keyed on whether Realm LISTENS in the thread, never
      // on the transport; the one respond command is always there (the ids a terminal answer needs).
      const command = slackEscape(cliCommandOf(notice.respond as RespondWay)!);
      const route = host.listens
        ? `Reply in this thread with ${choices}, or from a terminal:\n\`\`\`${command}\`\`\``
        : `*Gate requires a terminal response — open a terminal and run:*\n\`\`\`${command}\`\`\``;
      return {
        text: '⏸ Workflow gate waiting for approval',
        blocks: questionBlocks(notice, route),
      };
    }
    case 'reminder': {
      const mention =
        notice.escalation && notice.owner !== undefined ? `${slackOwner(notice.owner)} — ` : '';
      // #715 (b) (D-29, D6-72): the instant beside the words, as plain text (no Slack date token).
      const since = notice.since !== undefined ? ` (since ${notice.since})` : '';
      const open =
        notice.elapsed !== undefined
          ? `has been open for ${notice.elapsed}${since}`
          : 'is still open';
      return { blocks: [], text: `${mention}⏰ gate ${step} ${open}. Please respond.` };
    }
    case 'expiry_reminder': {
      // #715 (b) (D-29, D6-72): the deadline beside the words, as plain text (no Slack date token).
      const ago =
        notice.overdue !== undefined
          ? ` ${notice.overdue} ago${notice.deadline !== undefined ? ` (${notice.deadline})` : ''}`
          : '';
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
      return { blocks: [], text: notRecordedWords(notice) };
    case 'answer_refused':
      // #729 PR-6a (B9): a run that ended with nothing to say what the question met — no retry
      // can record the reply, so none is asked for.
      return {
        blocks: [],
        text:
          notice.code === 'STATE_RUN_TERMINAL'
            ? 'Not recorded: this run stopped before your reply arrived.'
            : `⚠️ Couldn't record your response (\`${notice.code}\`). Try again.`,
      };
    case 'question_closed': {
      // #729 PR-4 correction (C1): a channel post has no thread, so it names its gate and run.
      const subject =
        host.mode === 'webhook'
          ? `This question (gate \`${notice.step}\`, run ${notice.run_id})`
          : 'This question';
      // #729 PR-6a (B3's last row): answered elsewhere — the whole winning answer, through the one
      // sentence-maker's closing lead; Slack adds only the webhook framing above.
      if (notice.how === 'superseded' && notice.outcome !== undefined) {
        return {
          blocks: [],
          text: slackEscape(renderOutcome(notice.outcome, PEOPLE_DOOR_WORDS, subject)),
        };
      }
      const how = notice.how === 'expired' ? 'its time ran out' : 'the run stopped';
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

/**
 * The question post's blocks: the gate (and owner), the view, `route` (how to answer, or — #729 PR-6b
 * (A.1) — the closing line once the question closed), and the way to the whole output when the view
 * was cut.
 */
function questionBlocks(
  notice: Extract<PersonNotice, { kind: 'question_opened' }>,
  route: string,
): SlackBlock[] {
  const step = `\`${slackEscape(notice.step)}\``;
  const owner = notice.owner !== undefined ? `\n*Owner:* ${slackOwner(notice.owner)}` : '';
  const section = (text: string): SlackBlock => ({
    type: 'section',
    text: { type: 'mrkdwn', text },
  });
  return [
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
  ];
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
  // #715 (b) (02 §D.3, D-29): the notice is composed at the occurrence's SCHEDULED instant — "open for
  // (when − opened_at)", "expired (when − expires_at) ago" — never at the host's clock.
  const now = scheduledAt;
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

/** The longest delay Node's `setTimeout` keeps (2^31−1 ms, 24.8 days); a longer one runs after 1 ms. */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

/**
 * Starts reminder and escalation timers for an open gate.
 *
 * Issue #291 (Deliverable 6 — the authored notify clock): the REMINDER leg repeats when the gate
 * carries a frozen `reminder_seconds` ([F-A2-1]; record-keyed precedence over `reminderIntervalMs`
 * [F-A2-2] — the author's declared value always wins when present). #715 (b) (02 §D.3, D-29; D6-21,
 * D6-27): its occurrences are the run's SCHEDULE — core's one function, `reminderScheduleOf`, at the
 * snapshot's reading: occurrence k at `opened_at + k·reminder_seconds`, k ≤ `reminder_max`, each
 * before the frozen `expires_at`; the occurrence after the last one, when it is within
 * `reminder_max` and lands at or after `expires_at`, is the FINAL one, with the enforcement fact's
 * wording (never soliciting a doomed response). A notifier started late (a restarted `realm agent`)
 * registers only the occurrences its reading has not passed — missed ones are skipped, never sent in
 * a burst. Each notice is composed at its occurrence's scheduled instant. When the author declared NO
 * `reminder_seconds`, the OPERATOR fallback (`reminderIntervalMs`) stays SINGLE-SHOT ([F-A2-3]), as
 * the ESCALATION leg does: one each, `reminderIntervalMs` / `escalationThresholdMs` after the
 * snapshot's reading. The timers stay host timers (03 §A.6, D6-64: a duration from this process's
 * start). Returns a cleanup function that clears every pending timer — must be called when the gate
 * resolves. Exported for testing.
 */
export function startGateReminderTimers(
  botToken: string,
  channelId: string,
  threadTs: string,
  opened: Snapshot,
  reminderIntervalMs: number,
  escalationThresholdMs: number,
  runId = '',
  display?: string,
  listens = true,
): () => void {
  const gate = opened.record.pending_gate;
  if (gate === undefined) return (): void => {};
  const startMs = opened.at.getTime();
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  const post = (text: string, what: string): void => {
    postSlackReply(botToken, channelId, threadTs, text).catch((err) => {
      console.warn(`${what} post failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  };
  // Node runs a `setTimeout` longer than 2^31−1 ms (24.8 days) after 1 ms, so a timer further away
  // than that is armed in hops: each hop waits at most that long and arms the next for what is left;
  // only the last calls `fire`. `timers[slot]` always holds the chain's live hop, so the cleanup below
  // clears the hop that is waiting, and no hop is left to arm another.
  const at = (whenMs: number, fire: () => void): void => {
    const slot = timers.length;
    const hop = (remainingMs: number): void => {
      const waitMs = Math.min(remainingMs, MAX_TIMER_DELAY_MS);
      timers[slot] = setTimeout(() => {
        if (remainingMs > waitMs) hop(remainingMs - waitMs);
        else fire();
      }, waitMs);
    };
    hop(Math.max(0, whenMs - startMs));
  };

  const schedule = reminderScheduleOf(opened);
  if (schedule !== undefined) {
    // The authored cycle: every scheduled occurrence this reading has not passed, then the final one.
    for (const occurrence of schedule.occurrences) {
      if (schedule.next === undefined || occurrence.k < schedule.next.k) continue;
      const whenMs = parseStamp(occurrence.at)!;
      at(whenMs, () =>
        post(
          reminderFiring(gate, runId, display, false, occurrence.k, new Date(whenMs), listens),
          'Reminder',
        ),
      );
    }
    const openedAtMs = parseStamp(gate.opened_at);
    const finalK = schedule.occurrences.length + 1;
    if (openedAtMs !== undefined && gate.expires_at !== undefined && finalK <= schedule.max) {
      const finalMs = openedAtMs + finalK * gate.reminder_seconds! * 1000;
      if (finalMs >= startMs) {
        at(finalMs, () =>
          post(
            reminderFiring(gate, runId, display, true, finalK, new Date(finalMs), listens),
            'Reminder',
          ),
        );
      }
    }
  } else {
    // [F-A2-3]: the operator fallback — one reminder, `reminderIntervalMs` after this reading.
    const whenMs = startMs + reminderIntervalMs;
    const expiresAtMs = gate.expires_at !== undefined ? parseStamp(gate.expires_at) : undefined;
    const isFinal = gate.expires_at !== undefined && (expiresAtMs ?? NaN) <= whenMs;
    at(whenMs, () =>
      post(reminderFiring(gate, runId, display, isFinal, 1, new Date(whenMs), listens), 'Reminder'),
    );
  }

  const escalationMs = startMs + escalationThresholdMs;
  at(escalationMs, () => {
    // #729 PR-4 (02): the escalation is the `reminder` notice with its owner named, composed at its
    // scheduled instant (#715 (b), D-29).
    const text = renderSlack(
      composePersonNotice({
        kind: 'reminder',
        run_id: runId,
        gate,
        view: slackView(gate, display),
        respond: respondWayOfGate(runId, gate),
        scheduled_at: new Date(escalationMs).toISOString(),
        count: 1,
        escalation: true,
        now: new Date(escalationMs),
      }),
      { mode: 'bot', listens },
    ).text;
    post(text, 'Escalation');
  });

  return () => {
    for (const timer of timers) clearTimeout(timer);
    timers.length = 0;
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
  const windowMs = (parseStamp(gate.expires_at) ?? NaN) - (parseStamp(gate.opened_at) ?? NaN);
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
  /** #729 PR-6b (B): the question post's file this attendant holds — deleted when the question
   *  closes (A.1, A.5–A.7); left as it is when the wait ends by a throw (A.8). */
  postFile?: string;
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

/** #729 PR-6b (A.5, A.7): the operator's line when the question post could not be edited. */
const postNotUpdatedLine = (cause: string): string =>
  `Slack question post not updated to say the question closed — ${cause}`;

/** #729 PR-6b (A.6): the operator's line when the edit outlives the drain bound. */
const POST_UPDATE_UNFINISHED = `Slack question post not updated within ${DRAIN_TIMEOUT_MS / 1000} s; the question is closed`;

/** #729 PR-6b (B.12): a stopped agent's post taken over, with a listener (c1) or with none (c2). */
const POST_TAKEN_OVER_LISTENING =
  '  ℹ  This question is already in Slack, posted by a realm agent that has stopped; listening on that thread.';
const POST_TAKEN_OVER =
  '  ℹ  This question is already in Slack, posted by a realm agent that has stopped; using that post again.';

/** A thrown value's text. */
const thrownText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

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
    postFile,
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
  // The person's way to answer on the terminal, after the question's deadline (when it has one),
  // judged on `opened` — the one read below (#715 (b), 03 §B.2 E).
  const printTerminalWay = (opened: Snapshot | undefined): void => {
    const deadline = opened !== undefined ? questionDeadlineLine(gate, opened.at) : undefined;
    if (deadline !== undefined) console.log(deadline);
    terminalRespondLines(runId, gate).forEach((_, i) =>
      console.log(terminalRespondLines(runId, gate, writerCtx())[i]),
    );
  };
  let terminalWayOwed = false;
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
          // #715 (b) (02 §D.3, D-29; D6-17): the lines about the record after the answer are judged on
          // the snapshot the engine judged its reply on — never a second load. A reply with none: the
          // reply's own sentence, so the person still learns the answer was not recorded.
          const judged = judgedSnapshotOf(result);
          const lateLines =
            judged !== undefined
              ? describeAnswerEnding(result, judged.record, {
                  gateId: gate.gate_id,
                  via: 'agent',
                  workflow: definition,
                  before: before?.record ?? {},
                  now: judged.at,
                })
              : [result.errors[0] ?? result.context_hint];
          // #729 PR-4 (02): the operator's lines stay on this console; the thread gets the person's
          // words for what the question met (`answer_late`), naming no command.
          for (const line of lateLines) console.log(line);
          const after = judged?.record;
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
        } else if (result.outcome !== undefined) {
          // #729 PR-6a (B9): another answer — with this choice or another — or a step's abort settled
          // the question first, so this reply was not recorded and no retry can record it: the
          // thread is told, once, what the question met (never "Try again", never "✅").
          const judged = judgedSnapshotOf(result);
          console.log(renderOutcome(result.outcome, PEOPLE_DOOR_WORDS));
          // Set before the post, as above: no closed line joins it when the poll ends.
          personTold = true;
          await tellThread(
            composePersonNotice({
              kind: 'answer_late',
              run_id: runId,
              gate,
              choice: exactMatch,
              outcome: result.outcome,
              ended: result.ended_by !== undefined || judged?.record.terminal_state === true,
            }),
          );
          abortController.abort();
        } else if (result.status === 'error' && result.error_code === 'STATE_RUN_TERMINAL') {
          // #729 PR-6a (B9): the run ended before this reply arrived, with nothing to say what the
          // question met — told once; no retry can record it.
          console.warn(
            `Gate response submission failed: ${result.errors[0] ?? result.context_hint}`,
          );
          personTold = true;
          await tellThread(
            composePersonNotice({
              kind: 'answer_refused',
              run_id: runId,
              gate,
              choice: exactMatch,
              code: 'STATE_RUN_TERMINAL',
            }),
          );
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
            // #715 (b) (02 §D.3, D-29; D6-17): judged on the snapshot the engine judged its reply on
            // — never a second load. With none, the ending and its reason, which are on the reply.
            const judged = judgedSnapshotOf(result);
            const endingLines =
              judged !== undefined
                ? describeAnswerEnding(result, judged.record, {
                    gateId: gate.gate_id,
                    via: 'agent',
                    workflow: definition,
                    before: before?.record ?? {},
                    now: judged.at,
                  })
                : describeEndedBy(result);
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
    terminalWayOwed = true;
  }

  // #715 (b) (D-29, 03 §B.2 E): ONE read of the run once the listeners are wired, at the store's
  // reading (its clock) — the question's deadline line and the reminder schedule are judged on it.
  const opened = await store.get(runId).catch(() => undefined);
  if (terminalWayOwed) printTerminalWay(opened);

  // #729 PR-4 (02 §Transport (3)): no thread anchor means the opening post failed (its cause is
  // already on this console) — the person's way to answer on the terminal is printed, as `realm agent`
  // prints it when no handler attends the gate; the expiry timer and the poll below still run.
  if (gateThreadTs === undefined) printTerminalWay(opened);

  // Start reminder/escalation timers if we have a thread anchor — #715 (b) (D-29): from the one read
  // above, at the store's reading; a question already gone starts none.
  const clearTimers =
    gateThreadTs !== undefined &&
    opened !== undefined &&
    opened.record.pending_gate?.gate_id === gate.gate_id
      ? startGateReminderTimers(
          slackBotToken,
          slackChannelId,
          gateThreadTs,
          opened,
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

  // #729 PR-6b (A): the question post's edit once the question closed — its state for the drain.
  const display = definition.steps[gate.step_name]?.display;
  let editing: Promise<void> | undefined;
  let editSettled = false;
  let editPastBound = false;
  let postReleased = false;
  const releasePost = async (): Promise<void> => {
    if (postFile === undefined || postReleased) return;
    postReleased = true;
    await releaseSlackPostFile(postFile);
  };

  try {
    // Poll the store as the unified done-detector — resolves when candidate processor
    // calls submitHumanResponse OR when the terminal command is used.
    await pollUntilGateResolved(store, runId, gate.gate_id, pollIntervalMs, abortController.signal);
    // #729 PR-4 (02): the question closed without a Slack answer this thread was told about — the
    // thread is told how (its time ran out, the run stopped, it was answered elsewhere). A Slack
    // answer still in flight when the poll ended (its write is what ended the poll) decides first, so
    // the closed line never follows the person's own answer. Best effort, tracked into the drain
    // below, so the whole of it is bounded. #729 PR-6b (A.1): the same read of the record gives the
    // question post's edit its closing line.
    const answersInFlight = [...inFlight];
    const closing = (async (): Promise<ClosedReading> => {
      await Promise.allSettled(answersInFlight);
      return readClosed(store, runId, gate);
    })();
    track(
      (async (): Promise<void> => {
        const closed = await closing;
        if (personTold || !('notice' in closed)) return;
        await tellThread(closed.notice);
      })().catch((err) => {
        console.warn(`Slack reply failed: ${err instanceof Error ? err.message : String(err)}`);
      }),
    );
    if (gateThreadTs !== undefined) {
      const ts = gateThreadTs;
      editing = (async (): Promise<void> => {
        const closed = await closing;
        if (!('notice' in closed)) {
          // A.7: no edit; the record read's error is the cause.
          if (!editPastBound) console.warn(`  ⚠  ${postNotUpdatedLine(thrownText(closed.error))}`);
          return;
        }
        // A.1: the closing line, disclosed as the thread's lines are; the post keeps its gate and
        // its view, and the block that said how to answer becomes that line.
        const line = disclose(
          stripMarks(renderSlack(closed.notice, { mode: 'bot', listens }).text),
          slackSet(),
          'all',
        ).text;
        const verdict = await sendToSlack(
          'https://slack.com/api/chat.update',
          {
            channel: slackChannelId,
            ts,
            text: line,
            blocks: questionBlocks(questionOpened(gate, runId, display), line),
          },
          slackBotToken,
        );
        if (!verdict.ok && !editPastBound) {
          console.warn(
            `  ⚠  ${postNotUpdatedLine(slackFailureLine(verdict) ?? errorText(verdict))}`,
          );
        }
      })()
        .catch((err) => {
          if (!editPastBound) console.warn(`  ⚠  ${postNotUpdatedLine(thrownText(err))}`);
        })
        .finally(async () => {
          editSettled = true;
          await releasePost();
        });
    }
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
    // #729 PR-6b (A.3, A.6): the question post's edit is drained inside the same bound; past it,
    // its own line once and nothing more for it, the thread's line only for an unfinished thread
    // post, and the post's file deleted.
    let drainTimer: ReturnType<typeof setTimeout>;
    const bound = new Promise<'bound'>((resolve) => {
      drainTimer = setTimeout(() => resolve('bound'), DRAIN_TIMEOUT_MS);
    });
    try {
      const drained = await Promise.race([
        Promise.allSettled([...inFlight, ...(editing !== undefined ? [editing] : [])]).then(
          () => 'drained' as const,
        ),
        bound,
      ]);
      if (drained === 'bound') {
        if (editing !== undefined && !editSettled) {
          editPastBound = true;
          console.warn(`  ⚠  ${POST_UPDATE_UNFINISHED}`);
          await releasePost();
        }
        if (inFlight.size > 0) console.warn(`  ⚠  ${THREAD_POST_UNDELIVERED}`);
      }
    } finally {
      clearTimeout(drainTimer!);
    }
  }
}

/** How a question closed, read from the record; or the read's error (#729 PR-6b, A.7). */
type ClosedReading = { readonly notice: PersonNotice } | { readonly error: unknown };

/** #729 PR-4 (02): how a question closed, from the record as it is now (`outcomeOf`, nothing
 *  attempted by this host). A notice is never the attendant's failure: a record that cannot be read
 *  gives its error, and tells nothing. */
async function readClosed(
  store: RunStore,
  runId: string,
  gate: PendingGate,
): Promise<ClosedReading> {
  try {
    const { record: run } = await store.get(runId);
    return {
      notice: composePersonNotice({
        kind: 'question_closed',
        run_id: runId,
        gate,
        outcome: outcomeOf(run, gate.step_name, gate.expires_at, false),
      }),
    };
  } catch (error) {
    return { error };
  }
}

/** The question's opening notice, as the post's blocks are composed from it. */
function questionOpened(
  gate: PendingGate,
  runId: string,
  display: string | undefined,
): Extract<PersonNotice, { kind: 'question_opened' }> {
  const notice = openingNotice(gate, runId, display);
  if (notice.kind !== 'question_opened') throw new Error('unreachable: an opening notice');
  return notice;
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
    const { record: run } = await store.get(runId);
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
  /**
   * #729 PR-6b (B): the Realm home `realm agent` opened its store in. With a bot token, the question
   * post's channel and `ts` are kept in a file under its `slack-posts/` while the question is open, so
   * a restarted `realm agent` uses the same post. Without it, no file is kept.
   */
  home?: string;
}

/**
 * #729 PR-6b (B.10–B.14): the question's post. A stopped agent's post, when its file can be taken
 * over, is used again and nothing is posted; otherwise the question is posted, and the new post is
 * recorded in the file when no file is there (created exclusively) or the one there is not usable.
 * A running writer's file, or one this agent failed to take over, is left alone: the new post is
 * kept in memory only. `file` is set only when this agent holds the file.
 */
async function questionPost(
  config: SlackGateHandlerConfig & { botToken: string; channelId: string },
  runId: string,
  gate: PendingGate,
  listens: boolean,
): Promise<{ ts: string | undefined; file?: string }> {
  const file =
    config.home !== undefined ? slackPostPath(config.home, runId, gate.gate_id) : undefined;
  const found =
    file !== undefined
      ? await readSlackPostFile(file, config.channelId)
      : ({ kind: 'none' } as const);
  if (
    file !== undefined &&
    found.kind === 'stopped' &&
    (await takeOverSlackPostFile(file, found))
  ) {
    console.log(listens ? POST_TAKEN_OVER_LISTENING : POST_TAKEN_OVER);
    return { ts: found.record.ts, file };
  }
  const ts = await postGateViaApi(
    config.botToken,
    config.channelId,
    gate,
    runId,
    listens,
    config.definition.steps[gate.step_name]?.display,
  );
  if (ts === undefined || file === undefined) return { ts };
  const held =
    found.kind === 'none'
      ? await createSlackPostFile(file, config.channelId, ts)
      : found.kind === 'not_usable'
        ? await replaceSlackPostFile(file, config.channelId, ts)
        : false;
  return held ? { ts, file } : { ts };
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
      const listens = config.appToken !== undefined || config.signingSecret !== undefined;
      const post = await questionPost(
        { ...config, botToken: config.botToken, channelId: config.channelId },
        runId,
        gate,
        listens,
      );
      const gateThreadTs = post.ts;
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
        ...(post.file !== undefined ? { postFile: post.file } : {}),
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
        // #715 (b) (03 §B.2 E): the question's deadline first, at the reading of one read of the run.
        const shown = await config.store.get(runId).catch(() => undefined);
        const deadline = shown !== undefined ? questionDeadlineLine(gate, shown.at) : undefined;
        if (deadline !== undefined) console.log(deadline);
        terminalRespondLines(runId, gate).forEach((_, i) =>
          console.log(terminalRespondLines(runId, gate, writerCtx())[i]),
        );
      }
      console.log('   Waiting for approval...');
      const intervalMs = config.pollIntervalMs ?? 3000;
      for (;;) {
        await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
        const { record: run } = await config.store.get(runId);
        if (run.terminal_state) break;
        if (run.pending_gate === undefined || run.pending_gate.gate_id !== gate.gate_id) break;
      }
      // #729 PR-4 (02): a webhook takes no answer, so the question always closed elsewhere — the
      // channel is told how, walked at every tier as a thread reply is (not when the channel was
      // never asked: the opening post failed). Awaited under the drain bound, as the bot path's.
      const read = posted ? await readClosed(config.store, runId, gate) : undefined;
      const closed = read !== undefined && 'notice' in read ? read.notice : undefined;
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
