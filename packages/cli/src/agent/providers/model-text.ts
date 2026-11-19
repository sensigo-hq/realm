// model-text.ts — gap 1, unit A1: the text of each model call, kept on the step's evidence entry.
//
// A provider reports each request that got an answer as a `ModelTextReport`: the messages it sent,
// its tool list, and the messages that came back, in its API's own shape. Realm's own providers push
// one beside each request's usage record, in the same statement, so the two share a slot; a
// `--provider-module` provider may report the same field. run-agent joins each report to its
// request's id, and builds the step's `model_text` through one path for every provider: the
// canonical text of each message, then the mask, then the cut, each distinct text once.
import type { DriveFailureModelText, ModelText, UsageRecord } from '@sensigo/realm';
import { discloseForAgentCounted, sha256Hex } from './agent-utils.js';

/**
 * What a provider reports of one request that got an answer: the messages it sent (the system text
 * as a `system` message first, where its API sends it apart), the request's tool list as sent, and
 * the messages that came back. Each message is in its API's own shape: Anthropic's
 * (`{ role, content }`, content a string or parts) or OpenAI's (`{ role, content, tool_calls?,
 * refusal?, tool_call_id? }`). Realm keeps each message's text masked, and cut at 64 KB.
 */
export interface ModelTextReport {
  sent: readonly unknown[];
  tools?: readonly unknown[];
  reply: readonly unknown[];
}

/** A message reduced to what Realm keeps of it: its role and its canonical text, not yet masked. */
interface CanonicalMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  text: string;
}

/**
 * A request reduced to what Realm keeps of it, not yet masked. Gap 1, unit A2b: `reply` is `null` for
 * a request that got no answer (the last send of a call that failed).
 */
interface CanonicalRequest {
  sent: CanonicalMessage[];
  tools?: string;
  reply: CanonicalMessage[] | null;
}

/** The most UTF-8 bytes of one text Realm keeps; a longer text is cut at a code point and marked. */
export const MODEL_TEXT_CAP_BYTES = 64 * 1024;

const ROLES: ReadonlySet<string> = new Set(['system', 'user', 'assistant', 'tool']);
/** The parts kept as a tool part: Anthropic's two, and the two read from OpenAI's message fields. */
const TOOL_PART_TYPES: ReadonlySet<string> = new Set(['tool_use', 'tool_result', 'tool_call']);
/** A tool part's kept keys, in this order; every other key (`cache_control`, …) is dropped. */
const TOOL_PART_KEYS = [
  'type',
  'id',
  'tool_use_id',
  'tool_call_id',
  'name',
  'input',
  'content',
  'is_error',
] as const;

const isPlain = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** A part as it is kept inside the JSON of a non-text part: a text part as `{type, text}`. */
function keptPart(part: Record<string, unknown>): Record<string, unknown> {
  const type = part['type'] as string;
  if (type === 'text') return { type, text: part['text'] };
  // A thinking part keeps its text and drops its signature; a redacted one keeps only its type,
  // because its data is opaque.
  if (type === 'thinking') {
    return typeof part['thinking'] === 'string' ? { type, thinking: part['thinking'] } : { type };
  }
  if (!TOOL_PART_TYPES.has(type)) return { type };
  const kept: Record<string, unknown> = {};
  for (const key of TOOL_PART_KEYS) {
    const value = part[key];
    if (value === undefined) continue;
    // A tool result's content may itself be parts (each with its own cache mark): kept the same way.
    kept[key] =
      key === 'content' && Array.isArray(value)
        ? value.map((inner) =>
            isPlain(inner) && typeof inner['type'] === 'string' ? keptPart(inner) : inner,
          )
        : value;
  }
  return kept;
}

/** One part's text: a text part (or a string) as it is, any other part as compact JSON. */
function partText(part: unknown): string | undefined {
  if (typeof part === 'string') return part;
  if (!isPlain(part) || typeof part['type'] !== 'string') return undefined;
  if (part['type'] === 'text') return typeof part['text'] === 'string' ? part['text'] : undefined;
  return JSON.stringify(keptPart(part));
}

/**
 * The one canonical function: a message's role, and its parts in order joined with no separator.
 * The content is the parts (a string is one text part). OpenAI's fields outside `content` are read
 * as parts too: `refusal` as a text part, each `tool_calls[i]` as a `tool_call` part, and a tool
 * message as one `tool_result` part. Applied the same way to every sent copy and to the reply, so a
 * message marked for caching on one turn and not on the next is one message. `undefined` when the
 * message cannot be read.
 */
function canonicalMessage(message: unknown): CanonicalMessage | undefined {
  if (!isPlain(message)) return undefined;
  const role = message['role'];
  if (typeof role !== 'string' || !ROLES.has(role)) return undefined;
  const parts: unknown[] = [];
  if (role === 'tool' && message['tool_call_id'] !== undefined) {
    parts.push({
      type: 'tool_result',
      tool_call_id: message['tool_call_id'],
      content: message['content'],
    });
  } else {
    const content = message['content'];
    if (typeof content === 'string') parts.push(content);
    else if (Array.isArray(content)) parts.push(...content);
    else if (content !== null && content !== undefined) return undefined;
    const refusal = message['refusal'];
    if (typeof refusal === 'string') parts.push({ type: 'text', text: refusal });
    const calls = message['tool_calls'];
    if (Array.isArray(calls)) {
      for (const call of calls) {
        if (!isPlain(call) || !isPlain(call['function'])) return undefined;
        parts.push({
          type: 'tool_call',
          id: call['id'],
          name: call['function']['name'],
          input: call['function']['arguments'],
        });
      }
    } else if (calls !== null && calls !== undefined) return undefined;
  }
  const texts: string[] = [];
  for (const part of parts) {
    const text = partText(part);
    if (text === undefined) return undefined;
    texts.push(text);
  }
  return { role: role as CanonicalMessage['role'], text: texts.join('') };
}

/** A report's canonical form, or `undefined` when any part of it cannot be read. */
function canonicalRequest(report: unknown): CanonicalRequest | undefined {
  if (!isPlain(report) || !Array.isArray(report['sent']) || !Array.isArray(report['reply'])) {
    return undefined;
  }
  const tools = report['tools'];
  if (tools !== undefined && !Array.isArray(tools)) return undefined;
  const sent: CanonicalMessage[] = [];
  const reply: CanonicalMessage[] = [];
  for (const [from, into] of [
    [report['sent'], sent],
    [report['reply'], reply],
  ] as const) {
    for (const message of from as unknown[]) {
      const canonical = canonicalMessage(message);
      if (canonical === undefined) return undefined;
      into.push(canonical);
    }
  }
  let toolsJson: string | undefined;
  if (tools !== undefined) {
    try {
      toolsJson = JSON.stringify(tools);
    } catch {
      return undefined;
    }
    if (typeof toolsJson !== 'string') return undefined;
  }
  return { sent, ...(toolsJson !== undefined ? { tools: toolsJson } : {}), reply };
}

/**
 * What one of Realm's own providers pushes beside a request's usage record: the request as it was
 * sent and answered, built at the push. A tool loop's history array changes after the push, so each
 * message is reduced to its canonical text here (a message the function cannot read is kept as it
 * is, and the step then records `provider_did_not_report`), and the tool list is copied. Total: it
 * never throws, because the usage record beside it must never be lost.
 */
export function answeredRequestText(
  sent: readonly unknown[],
  tools: unknown,
  reply: readonly unknown[],
): ModelTextReport {
  try {
    const snapshot = (message: unknown): unknown => {
      const canonical = canonicalMessage(message);
      return canonical === undefined ? message : { role: canonical.role, content: canonical.text };
    };
    return {
      sent: sent.map(snapshot),
      ...(Array.isArray(tools) ? { tools: JSON.parse(JSON.stringify(tools)) as unknown[] } : {}),
      reply: reply.map(snapshot),
    };
  } catch {
    return UNREADABLE;
  }
}

const UNREADABLE: ModelTextReport = { sent: [null], reply: [] };

/**
 * An Anthropic request's text: its `system` as the first message, its `messages`, its `tools`, and
 * the answer's `content` as one assistant message. Total, like {@link answeredRequestText}.
 */
export function anthropicAnsweredText(
  body: Record<string, unknown>,
  response: unknown,
): ModelTextReport {
  try {
    const system = body['system'];
    const messages = body['messages'];
    return answeredRequestText(
      [
        ...(system !== undefined ? [{ role: 'system', content: system }] : []),
        ...(Array.isArray(messages) ? (messages as unknown[]) : [UNREADABLE]),
      ],
      body['tools'],
      [{ role: 'assistant', content: isPlain(response) ? response['content'] : undefined }],
    );
  } catch {
    return UNREADABLE;
  }
}

/**
 * An OpenAI chat request's text: its `messages` (the system text among them), its `tools`, and the
 * answer's first choice's message. Total, like {@link answeredRequestText}.
 */
export function openAiAnsweredText(
  body: Record<string, unknown>,
  response: unknown,
): ModelTextReport {
  try {
    const messages = body['messages'];
    const choices = isPlain(response) ? response['choices'] : undefined;
    const message =
      Array.isArray(choices) && isPlain(choices[0]) ? choices[0]['message'] : undefined;
    return answeredRequestText(
      Array.isArray(messages) ? (messages as unknown[]) : [UNREADABLE],
      body['tools'],
      message !== undefined ? [message] : [],
    );
  } catch {
    return UNREADABLE;
  }
}

/** Pushes a request's usage record and its text in one statement, so the two share a slot. */
export function pushAnswered(
  requests: UsageRecord[],
  record: UsageRecord,
  texts: ModelTextReport[],
  text: ModelTextReport,
): void {
  requests.push(record);
  texts.push(text);
}

/**
 * The texts of a step's model calls so far: each request's canonical text with its `request_id`, or
 * `reported: false` once any call's texts could not be joined to its requests.
 */
export type StepModelTexts =
  | {
      readonly reported: true;
      readonly requests: ReadonlyArray<{ request_id: string | null; text: CanonicalRequest }>;
    }
  | { readonly reported: false };

/**
 * Joins one provider call's reports to its requests, slot by slot: `minted` is the call's usage
 * after `mintRequestIds`, so each report takes its request's id. A missing field, a count that
 * differs from the usage's, an entry with no id, or a report that cannot be read gives
 * `reported: false`. Total: a module's report is read here, and a part JSON cannot write (a BigInt,
 * a circular value) or a getter that throws gives `reported: false` too, so the call's usage, which
 * is appended after this, is never lost (correction 1).
 */
export function joinModelTexts(minted: readonly UsageRecord[], reports: unknown): StepModelTexts {
  try {
    if (!Array.isArray(reports) || reports.length !== minted.length) return { reported: false };
    const requests: Array<{ request_id: string | null; text: CanonicalRequest }> = [];
    for (let slot = 0; slot < minted.length; slot++) {
      const usage = minted[slot] as unknown;
      const id = isPlain(usage) ? usage['request_id'] : undefined;
      const text = canonicalRequest(reports[slot]);
      if (typeof id !== 'string' || text === undefined) return { reported: false };
      requests.push({ request_id: id, text });
    }
    return { reported: true, requests };
  } catch {
    return { reported: false };
  }
}

/** Adds one call's texts to the step's, in wire order, as `appendRequests` adds its usage. */
export function appendModelTexts(
  prior: StepModelTexts | undefined,
  next: StepModelTexts,
): StepModelTexts {
  if (prior === undefined) return next;
  if (!prior.reported || !next.reported) return { reported: false };
  return { reported: true, requests: [...prior.requests, ...next.requests] };
}

/**
 * `text` cut to at most `cap` bytes of UTF-8 on a code-point boundary, with what was kept and the
 * full size when it was cut. A lone surrogate counts as the 3 bytes UTF-8 writes for it.
 */
export function cutText(
  text: string,
  cap = MODEL_TEXT_CAP_BYTES,
): { text: string; cut?: { kept_bytes: number; full_bytes: number } } {
  const full = Buffer.byteLength(text, 'utf8');
  if (full <= cap) return { text };
  let bytes = 0;
  let end = 0;
  while (end < text.length) {
    const point = text.codePointAt(end)!;
    const size = point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
    if (bytes + size > cap) break;
    bytes += size;
    end += point > 0xffff ? 2 : 1;
  }
  return { text: text.slice(0, end), cut: { kept_bytes: bytes, full_bytes: full } };
}

type Recorded = Extract<ModelText, { recorded: true }>;

/**
 * The step's `model_text`: `undefined` when no model call of this drive answered (no texts were
 * gathered), the `switched_off` marker when recording is off, `provider_did_not_report` when a
 * call's texts could not be joined, and otherwise the texts.
 *
 * Each text is masked for the agent audience first (`discloseForAgent`; `hidden` counts what it
 * hid), then cut at 64 KB (`cut`). A duplicate is found by the SHA-256 of its role and its whole
 * masked text, before the cut, so two texts that share their first 64 KB stay two. A tool list is
 * found the same way, by its masked JSON.
 */
export function modelTextOf(
  texts: StepModelTexts | undefined,
  record: boolean,
): ModelText | undefined {
  if (texts === undefined) return undefined;
  if (!record) return { recorded: false, why: 'switched_off' };
  if (!texts.reported) return { recorded: false, why: 'provider_did_not_report' };
  const messages: Recorded['messages'] = [];
  const tools: Recorded['tools'] = [];
  // Two keys find a text again: its raw text (the same raw text masks the same way, so it is
  // masked once), and the hash of its masked text (two raw texts the mask makes equal are one).
  const byRaw = new Map<string, number>();
  const byMasked = new Map<string, number>();
  const keep = (
    kind: string,
    raw: string,
    add: (text: string, extra: object) => number,
  ): number => {
    const rawKey = `${kind}\n${raw}`;
    const known = byRaw.get(rawKey);
    if (known !== undefined) return known;
    const masked = discloseForAgentCounted(raw);
    const maskedKey = sha256Hex(`${kind}\n${masked.text}`);
    let index = byMasked.get(maskedKey);
    if (index === undefined) {
      const { text, cut } = cutText(masked.text);
      index = add(text, {
        ...(cut !== undefined ? { cut } : {}),
        ...(masked.hidden > 0 ? { hidden: masked.hidden } : {}),
      });
      byMasked.set(maskedKey, index);
    }
    byRaw.set(rawKey, index);
    return index;
  };
  const message = (m: CanonicalMessage): number =>
    keep(m.role, m.text, (text, extra) => messages.push({ role: m.role, text, ...extra }) - 1);
  const requests: Recorded['requests'] = texts.requests.map(({ request_id, text }) => {
    const sent = text.sent.map(message);
    const toolList =
      text.tools !== undefined
        ? keep('tools', text.tools, (json, extra) => tools.push({ json, ...extra }) - 1)
        : undefined;
    return {
      request_id,
      sent,
      ...(toolList !== undefined ? { tools: toolList } : {}),
      reply: text.reply === null ? null : text.reply.map(message),
    };
  });
  return { recorded: true, messages, tools, requests };
}

// ── Gap 1, unit A2b: a failed drive's text ──────────────────────────────────────────────────────
//
// A provider call that throws hands its texts to the drive-failure writer through a carrier keyed on
// the thrown error itself (a module-level WeakMap): nothing on the error changes, so its class, its
// message, its `cause` and every payload `findDriveCall` returns read as before, and no provider
// module can read or set it. The writer joins the texts to the failure's usage ids, builds them
// through `modelTextOf` (canonical form, mask, dedupe, cut) and keeps them within one 64 KB budget.

/**
 * What one provider call keeps for its failure, owned by the entry point as its `billed` is: each
 * answered request's text, in wire order, and the text of the last send while it has no answer.
 */
export interface CallTexts {
  readonly answered: ModelTextReport[];
  unanswered: ModelTextReport | undefined;
}

/** A new, empty {@link CallTexts}, for an entry point to own. */
export function newCallTexts(): CallTexts {
  return { answered: [], unanswered: undefined };
}

/**
 * Runs one send. While it has no answer, the call's unanswered request is the text of what it sent
 * (`sentText`, read when the send throws: the body as last built, `undefined` when nothing was
 * built); an answer clears it. A throw is passed on unchanged.
 */
export async function trackSend<T>(
  call: CallTexts,
  sentText: () => ModelTextReport | undefined,
  send: () => Promise<T>,
): Promise<T> {
  try {
    const answer = await send();
    call.unanswered = undefined;
    return answer;
  } catch (err) {
    call.unanswered = sentText();
    throw err;
  }
}

/** The texts a thrown error carries to the drive-failure writer. */
export interface CarriedTexts {
  readonly answered: readonly ModelTextReport[];
  readonly unanswered: ModelTextReport | undefined;
}

const CARRIED = new WeakMap<object, CarriedTexts>();

/**
 * Carries `call`'s texts on `err` for the drive-failure writer, without touching `err`. A value that
 * is not an object carries nothing. Total, like `attachBilledUsage`.
 */
export function carryTexts(err: unknown, call: CallTexts): void {
  if (err === null || (typeof err !== 'object' && typeof err !== 'function')) return;
  try {
    CARRIED.set(err, { answered: [...call.answered], unanswered: call.unanswered });
  } catch {
    /* carrying never out-throws the error it rides on */
  }
}

/** The texts `err` carries, or `undefined` when no Realm provider carried any on it. */
export function carriedTexts(err: unknown): CarriedTexts | undefined {
  if (err === null || (typeof err !== 'object' && typeof err !== 'function')) return undefined;
  try {
    return CARRIED.get(err);
  } catch {
    return undefined;
  }
}

/** An Anthropic request's text as sent, for a send that got no answer. Total. */
export function anthropicSentText(body: Record<string, unknown>): ModelTextReport {
  try {
    const system = body['system'];
    const messages = body['messages'];
    return answeredRequestText(
      [
        ...(system !== undefined ? [{ role: 'system', content: system }] : []),
        ...(Array.isArray(messages) ? (messages as unknown[]) : [UNREADABLE]),
      ],
      body['tools'],
      [],
    );
  } catch {
    return UNREADABLE;
  }
}

/** An OpenAI chat request's text as sent, for a send that got no answer. Total. */
export function openAiSentText(body: Record<string, unknown>): ModelTextReport {
  try {
    const messages = body['messages'];
    return answeredRequestText(
      Array.isArray(messages) ? (messages as unknown[]) : [UNREADABLE],
      body['tools'],
      [],
    );
  } catch {
    return UNREADABLE;
  }
}

/**
 * The texts of one failed provider call: its answered requests joined to `minted` (the call's usage
 * on the failure entry, its ids minted there), then its unanswered request, with `request_id: null`
 * and `reply: null`. `reported: false` when they cannot be joined or read. Total.
 */
export function joinFailedCall(
  minted: readonly UsageRecord[],
  carried: CarriedTexts,
): StepModelTexts {
  const answered = joinModelTexts(minted, carried.answered);
  if (!answered.reported || carried.unanswered === undefined) return answered;
  try {
    const text = canonicalRequest(carried.unanswered);
    if (text === undefined) return { reported: false };
    return {
      reported: true,
      requests: [...answered.requests, { request_id: null, text: { ...text, reply: null } }],
    };
  } catch {
    return { reported: false };
  }
}

type RecordedText = Extract<ModelText, { recorded: true }>;
type Slot = { text?: string; json?: string; cut?: { kept_bytes: number; full_bytes: number } };

/**
 * A failed drive's `model_text` within `cap` bytes of UTF-8 in total (the masked texts, as
 * `modelTextOf` built them). Kept in this order, so the text that explains the failure stays:
 * 1. the focus request's system text and first user message, each cut to fit; the focus request is
 *    the one that got no answer, or, when every request was answered, the last one, whose reply
 *    comes between the two (it exists nowhere else, while the prompt can be rebuilt from the run);
 * 2. the focus request's tool list, cut to fit;
 * 3. the other messages, newest first, each kept whole or left out;
 * 4. the other tool lists, newest first, each kept whole or left out.
 * A text left out keeps its slot as `''` with `cut: { kept_bytes: 0, full_bytes }`, its full size
 * (A1's `full_bytes` when A1 had cut it), so no index points at nothing; a text cut to 0 bytes in
 * step 1 or 2 is left out. `dropped_messages` counts the messages left out, absent when none were.
 */
export function budgetFailureText(
  text: RecordedText,
  cap = MODEL_TEXT_CAP_BYTES,
): DriveFailureModelText {
  const messages = text.messages.map((m) => ({ ...m }));
  const tools = text.tools.map((t) => ({ ...t }));
  const done = new Set<string>();
  let left = cap;
  let dropped = 0;
  const bytesOf = (value: string): number => Buffer.byteLength(value, 'utf8');
  const fullOf = (slot: Slot, value: string): number => slot.cut?.full_bytes ?? bytesOf(value);
  /** Leaves a slot out: empty, marked with its full size; `hidden` goes with the text. */
  const leaveOut = (kind: 'message' | 'tools', index: number): void => {
    if (kind === 'message') {
      const m = messages[index]!;
      const { hidden: _hidden, ...rest } = m;
      void _hidden;
      messages[index] = {
        ...rest,
        text: '',
        cut: { kept_bytes: 0, full_bytes: fullOf(m, m.text) },
      };
      dropped++;
    } else {
      const t = tools[index]!;
      const { hidden: _hidden, ...rest } = t;
      void _hidden;
      tools[index] = { ...rest, json: '', cut: { kept_bytes: 0, full_bytes: fullOf(t, t.json) } };
    }
  };
  /** Keeps a slot cut to fit what is left (steps 1 and 2). */
  const keepCut = (kind: 'message' | 'tools', index: number | undefined): void => {
    if (index === undefined || done.has(`${kind}:${index}`)) return;
    done.add(`${kind}:${index}`);
    const slot: Slot = kind === 'message' ? messages[index]! : tools[index]!;
    const value = (kind === 'message' ? slot.text : slot.json) ?? '';
    const size = bytesOf(value);
    if (size <= left) {
      left -= size;
      return;
    }
    const cut = cutText(value, left);
    if (cut.cut === undefined || cut.cut.kept_bytes === 0) {
      leaveOut(kind, index);
      return;
    }
    left -= cut.cut.kept_bytes;
    const marked = { kept_bytes: cut.cut.kept_bytes, full_bytes: fullOf(slot, value) };
    if (kind === 'message') messages[index] = { ...messages[index]!, text: cut.text, cut: marked };
    else tools[index] = { ...tools[index]!, json: cut.text, cut: marked };
  };
  /** Keeps a slot whole, or leaves it out (steps 3 and 4). */
  const keepWhole = (kind: 'message' | 'tools', index: number): void => {
    if (done.has(`${kind}:${index}`)) return;
    done.add(`${kind}:${index}`);
    const size = bytesOf(kind === 'message' ? messages[index]!.text : tools[index]!.json);
    if (size <= left) left -= size;
    else leaveOut(kind, index);
  };
  const unanswered = text.requests.find((r) => r.reply === null);
  const focus = unanswered ?? text.requests[text.requests.length - 1];
  if (focus !== undefined) {
    const system = focus.sent.find((i) => messages[i]?.role === 'system');
    const firstUser = focus.sent.find((i) => messages[i]?.role === 'user');
    keepCut('message', system);
    if (focus.reply !== null) for (const i of focus.reply) keepCut('message', i);
    keepCut('message', firstUser);
    keepCut('tools', focus.tools);
  }
  for (let i = messages.length - 1; i >= 0; i--) keepWhole('message', i);
  for (let i = tools.length - 1; i >= 0; i--) keepWhole('tools', i);
  return {
    recorded: true,
    messages,
    tools,
    requests: text.requests,
    ...(dropped > 0 ? { dropped_messages: dropped } : {}),
  };
}

/**
 * The `model_text` of a drive-failure entry this Realm writes: the `switched_off` marker when
 * recording is off (it wins), `recorded: true` with no requests when no model request belongs to
 * the entry (`texts` undefined), `provider_did_not_report` when the texts could not be joined, and
 * otherwise the texts through A1's one path (`modelTextOf`: canonical form, mask, dedupe, cut),
 * then the entry's 64 KB budget ({@link budgetFailureText}).
 */
export function failureModelTextOf(
  texts: StepModelTexts | undefined,
  record: boolean,
): DriveFailureModelText {
  if (!record) return { recorded: false, why: 'switched_off' };
  if (texts === undefined) return { recorded: true, messages: [], tools: [], requests: [] };
  const built = modelTextOf(texts, true);
  if (built === undefined || !built.recorded) {
    return built ?? { recorded: false, why: 'provider_did_not_report' };
  }
  return budgetFailureText(built);
}
