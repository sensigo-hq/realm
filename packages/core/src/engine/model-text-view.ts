// Gap 1, unit B: the reader of a `model_text` — an evidence entry's (`EvidenceSnapshot.model_text`,
// unit A1) or a drive failure's (`DriveFailureRecord.model_text`, unit A2b) — for `realm run inspect
// --verbose`. It sits beside the step-view composer and is never part of it: `composeStepViews`'
// views reach `get_run_state` whole, and the texts must not. It reads a value of any shape (a store
// or a program that embeds the engine may write anything), works out why there is no text, and
// checks each request's system text, prompt and tool list against the hashes Realm kept when it sent
// the request (`UsageRecord.prefix_parts`). The CLI only prints what it returns. Pure apart from
// hashing; reads no clock.
import { createHash } from 'node:crypto';
import type { WorkflowDefinition } from '../types/workflow-definition.js';

/** What a stored text carries beside its size, in the order a reader is told it. */
export type ModelTextMark =
  | { readonly kind: 'left_out'; readonly full_bytes: number }
  | { readonly kind: 'cut'; readonly kept_bytes: number; readonly full_bytes: number }
  | { readonly kind: 'hidden'; readonly count: number };

/** One stored message, numbered from 1 as the requests name it. */
export interface ModelTextMessageView {
  readonly number: number;
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  /** The stored text's size in UTF-8 bytes. */
  readonly bytes: number;
  readonly text: string;
  readonly marks: readonly ModelTextMark[];
}

/** One stored tool list (its JSON), numbered from 1. */
export interface ModelTextToolListView {
  readonly number: number;
  readonly bytes: number;
  readonly json: string;
  readonly marks: readonly ModelTextMark[];
}

/** How one part of a request compares with the hash Realm kept when it sent the request. */
export type ModelTextCheckOutcome =
  | { readonly outcome: 'matches' }
  | { readonly outcome: 'first_chars_match'; readonly chars: number }
  | { readonly outcome: 'differs' }
  | { readonly outcome: 'not_checkable'; readonly reason: 'left_out' | 'cut' | 'hidden' }
  | { readonly outcome: 'not_checked'; readonly reason: 'empty_head' | 'no_hash' };

/** A request's check: each part that has a stored text or a hash, or no hashes at all. */
export type ModelTextRequestCheck =
  | { readonly kind: 'no_hashes' }
  | {
      readonly kind: 'parts';
      readonly system?: ModelTextCheckOutcome;
      readonly prompt?: ModelTextCheckOutcome;
      readonly tools?: ModelTextCheckOutcome;
    };

/** One request: what it sent and got back, by message number, its tool list, and its check. */
export interface ModelTextRequestView {
  readonly number: number;
  readonly request_id: string | null;
  readonly sent: readonly number[];
  /** `null`: the request got no answer. */
  readonly reply: readonly number[] | null;
  readonly tool_list?: number;
  readonly check: ModelTextRequestCheck;
}

/**
 * What a reader is shown of one entry's `model_text`:
 * - `texts`: each message and tool list once, and the requests that name them;
 * - `switched_off` / `provider_did_not_report`: the marker Realm wrote;
 * - `no_requests`: a drive failure whose texts hold no request;
 * - `none_on_record`: no `model_text` on an entry that records a model call (or on a failure);
 * - `no_model_call`: no `model_text` on an agent step's entry that records no model call;
 * - `unreadable`: a value outside the type.
 */
export type ModelTextView =
  | {
      readonly kind: 'texts';
      readonly messages: readonly ModelTextMessageView[];
      readonly tool_lists: readonly ModelTextToolListView[];
      readonly requests: readonly ModelTextRequestView[];
      readonly dropped_messages?: number;
    }
  | { readonly kind: 'switched_off' }
  | { readonly kind: 'provider_did_not_report' }
  | { readonly kind: 'no_requests' }
  | { readonly kind: 'none_on_record' }
  | { readonly kind: 'no_model_call' }
  | { readonly kind: 'unreadable' };

const ROLES: ReadonlySet<string> = new Set(['system', 'user', 'assistant', 'tool']);

type Plain = Record<string, unknown>;
const isPlain = (v: unknown): v is Plain =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/** A stored text or tool list as read: its text, and its `cut` and `hidden` when well formed. */
interface Slot {
  readonly text: string;
  readonly cut?: { readonly kept_bytes: number; readonly full_bytes: number };
  readonly hidden?: number;
}

const UNREADABLE = Symbol('unreadable');

/** A slot's `cut` and `hidden`, or `UNREADABLE` when either is not well formed. */
function readMarks(
  raw: Plain,
): { cut?: NonNullable<Slot['cut']>; hidden?: number } | typeof UNREADABLE {
  const out: { cut?: NonNullable<Slot['cut']>; hidden?: number } = {};
  if (raw['cut'] !== undefined) {
    const cut = raw['cut'];
    if (!isPlain(cut) || !isCount(cut['kept_bytes']) || !isCount(cut['full_bytes'])) {
      return UNREADABLE;
    }
    out.cut = { kept_bytes: cut['kept_bytes'], full_bytes: cut['full_bytes'] };
  }
  if (raw['hidden'] !== undefined) {
    if (!isCount(raw['hidden'])) return UNREADABLE;
    out.hidden = raw['hidden'];
  }
  return out;
}

/** A list of message numbers, each an integer in range, or `UNREADABLE`. */
function readIndexes(raw: unknown, size: number): number[] | typeof UNREADABLE {
  if (!Array.isArray(raw)) return UNREADABLE;
  const out: number[] = [];
  for (const n of raw as unknown[]) {
    if (!isCount(n) || n >= size) return UNREADABLE;
    out.push(n);
  }
  return out;
}

interface ReadRequest {
  readonly request_id: string | null;
  readonly sent: number[];
  readonly reply: number[] | null;
  readonly tools?: number;
}

type Read =
  | { readonly kind: 'marker'; readonly why: 'switched_off' | 'provider_did_not_report' }
  | {
      readonly kind: 'texts';
      readonly messages: ReadonlyArray<Slot & { role: ModelTextMessageView['role'] }>;
      readonly tools: readonly Slot[];
      readonly requests: readonly ReadRequest[];
      readonly dropped_messages?: number;
    }
  | { readonly kind: 'unreadable' };

/** A `model_text` of any shape, read whole or found unreadable (anything outside the type). */
function readModelText(value: unknown): Read {
  if (!isPlain(value)) return { kind: 'unreadable' };
  if (value['recorded'] === false) {
    const why = value['why'];
    return why === 'switched_off' || why === 'provider_did_not_report'
      ? { kind: 'marker', why }
      : { kind: 'unreadable' };
  }
  if (value['recorded'] !== true) return { kind: 'unreadable' };
  const rawMessages = value['messages'];
  const rawTools = value['tools'];
  const rawRequests = value['requests'];
  if (!Array.isArray(rawMessages) || !Array.isArray(rawTools) || !Array.isArray(rawRequests)) {
    return { kind: 'unreadable' };
  }
  const messages: Array<Slot & { role: ModelTextMessageView['role'] }> = [];
  for (const m of rawMessages as unknown[]) {
    if (!isPlain(m) || typeof m['role'] !== 'string' || !ROLES.has(m['role'])) {
      return { kind: 'unreadable' };
    }
    if (typeof m['text'] !== 'string') return { kind: 'unreadable' };
    const marks = readMarks(m);
    if (marks === UNREADABLE) return { kind: 'unreadable' };
    messages.push({ role: m['role'] as ModelTextMessageView['role'], text: m['text'], ...marks });
  }
  const tools: Slot[] = [];
  for (const t of rawTools as unknown[]) {
    if (!isPlain(t) || typeof t['json'] !== 'string') return { kind: 'unreadable' };
    const marks = readMarks(t);
    if (marks === UNREADABLE) return { kind: 'unreadable' };
    tools.push({ text: t['json'], ...marks });
  }
  const requests: ReadRequest[] = [];
  for (const r of rawRequests as unknown[]) {
    if (!isPlain(r)) return { kind: 'unreadable' };
    const id = r['request_id'];
    if (typeof id !== 'string' && id !== null) return { kind: 'unreadable' };
    const sent = readIndexes(r['sent'], messages.length);
    if (sent === UNREADABLE) return { kind: 'unreadable' };
    let reply: number[] | null = null;
    if (r['reply'] !== null) {
      const read = readIndexes(r['reply'], messages.length);
      if (read === UNREADABLE) return { kind: 'unreadable' };
      reply = read;
    }
    let toolList: number | undefined;
    if (r['tools'] !== undefined) {
      if (!isCount(r['tools']) || r['tools'] >= tools.length) return { kind: 'unreadable' };
      toolList = r['tools'];
    }
    requests.push({
      request_id: id,
      sent,
      reply,
      ...(toolList !== undefined ? { tools: toolList } : {}),
    });
  }
  let dropped: number | undefined;
  if (value['dropped_messages'] !== undefined) {
    if (!isCount(value['dropped_messages'])) return { kind: 'unreadable' };
    dropped = value['dropped_messages'];
  }
  return {
    kind: 'texts',
    messages,
    tools,
    requests,
    ...(dropped !== undefined ? { dropped_messages: dropped } : {}),
  };
}

const utf8 = new TextEncoder();
const bytesOf = (text: string): number => utf8.encode(text).length;
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** A slot's marks, in the order a reader is told them: left out, cut, secret values replaced. */
function marksOf(slot: Slot): ModelTextMark[] {
  const marks: ModelTextMark[] = [];
  if (slot.cut !== undefined) {
    marks.push(
      slot.cut.kept_bytes === 0
        ? { kind: 'left_out', full_bytes: slot.cut.full_bytes }
        : { kind: 'cut', kept_bytes: slot.cut.kept_bytes, full_bytes: slot.cut.full_bytes },
    );
  }
  if (slot.hidden !== undefined && slot.hidden > 0)
    marks.push({ kind: 'hidden', count: slot.hidden });
  return marks;
}

/** Why a disagreeing slot cannot be checked (left out, then cut, then masked), or `undefined`. */
function reasonOf(slot: Slot): 'left_out' | 'cut' | 'hidden' | undefined {
  if (slot.cut !== undefined) return slot.cut.kept_bytes === 0 ? 'left_out' : 'cut';
  if (slot.hidden !== undefined && slot.hidden > 0) return 'hidden';
  return undefined;
}

const MATCHES: ModelTextCheckOutcome = { outcome: 'matches' };
const DIFFERS: ModelTextCheckOutcome = { outcome: 'differs' };
const NO_HASH: ModelTextCheckOutcome = { outcome: 'not_checked', reason: 'no_hash' };
const EMPTY_HEAD: ModelTextCheckOutcome = { outcome: 'not_checked', reason: 'empty_head' };

/** A disagreement: not checkable for the slot's reason, else a real difference. */
function disagreement(slot: Slot | undefined): ModelTextCheckOutcome {
  const reason = slot === undefined ? undefined : reasonOf(slot);
  return reason === undefined ? DIFFERS : { outcome: 'not_checkable', reason };
}

/** A whole text against its hash (the system text, a tool list, an unsplit prompt). */
function checkWhole(
  slot: Slot | undefined,
  hash: string | undefined,
): ModelTextCheckOutcome | undefined {
  if (slot === undefined && hash === undefined) return undefined;
  if (hash === undefined) return NO_HASH;
  if (slot === undefined) return DIFFERS;
  return sha256(slot.text) === hash ? MATCHES : disagreement(slot);
}

/**
 * The prompt against its hash. With `prefixChars`, Realm hashed only the prompt's first
 * `prefixChars` UTF-16 units (the text before the first value the run fills in), so an agreement
 * says only those match, unless the stored prompt is uncut and no longer than them; a disagreement
 * is not checkable for a cut only when the stored prompt keeps fewer units than the head (a cut
 * after the head leaves it whole).
 */
function checkPrompt(
  slot: Slot | undefined,
  hash: string | undefined,
  prefixChars: number | undefined,
): ModelTextCheckOutcome | undefined {
  if (prefixChars === undefined) return checkWhole(slot, hash);
  if (slot === undefined && hash === undefined) return undefined;
  if (hash === undefined) return NO_HASH;
  if (prefixChars === 0) return EMPTY_HEAD;
  if (slot === undefined) return DIFFERS;
  if (sha256(slot.text.slice(0, prefixChars)) === hash) {
    return slot.cut === undefined && slot.text.length <= prefixChars
      ? MATCHES
      : { outcome: 'first_chars_match', chars: prefixChars };
  }
  if (slot.text.length < prefixChars && slot.cut !== undefined) {
    return { outcome: 'not_checkable', reason: slot.cut.kept_bytes === 0 ? 'left_out' : 'cut' };
  }
  if (slot.hidden !== undefined && slot.hidden > 0) {
    return { outcome: 'not_checkable', reason: 'hidden' };
  }
  return DIFFERS;
}

/** Every position of a blank line (`"\n\n"`) in `text`. */
function blankLines(text: string): number[] {
  const out: number[] = [];
  for (let p = text.indexOf('\n\n'); p !== -1; p = text.indexOf('\n\n', p + 1)) out.push(p);
  return out;
}

/**
 * The reasoning provider folds the system text into the user message: the system text, a blank
 * line, then the prompt. The system text is found at the blank line whose left side its hash agrees
 * with, and the prompt is then read only after that blank line, so text added between the two is a
 * difference. Only when no blank line agrees with the system hash (a masked or cut system text) is
 * the prompt searched after every blank line. A part with no agreement takes the message's reason,
 * or differs.
 */
function checkFolded(
  slot: Slot,
  systemHash: string | undefined,
  promptHash: string | undefined,
  prefixChars: number | undefined,
): { system?: ModelTextCheckOutcome; prompt?: ModelTextCheckOutcome } {
  const splits = blankLines(slot.text);
  const systemEnd =
    systemHash === undefined
      ? undefined
      : splits.find((p) => sha256(slot.text.slice(0, p)) === systemHash);
  const system: ModelTextCheckOutcome | undefined =
    systemHash === undefined ? undefined : systemEnd !== undefined ? MATCHES : disagreement(slot);
  let prompt: ModelTextCheckOutcome;
  if (promptHash === undefined) prompt = NO_HASH;
  else if (prefixChars === 0) prompt = EMPTY_HEAD;
  else {
    const starts = systemEnd !== undefined ? [systemEnd] : splits;
    const found = starts
      .map((p) => slot.text.slice(p + 2))
      .find((right) =>
        prefixChars === undefined
          ? sha256(right) === promptHash
          : sha256(right.slice(0, prefixChars)) === promptHash,
      );
    if (found === undefined) prompt = disagreement(slot);
    else if (prefixChars === undefined) prompt = MATCHES;
    else
      prompt =
        slot.cut === undefined && found.length <= prefixChars
          ? MATCHES
          : { outcome: 'first_chars_match', chars: prefixChars };
  }
  return { ...(system !== undefined ? { system } : {}), prompt };
}

/** The usage record on the same entry whose `request_id` is `id`, when it is a plain object. */
function usageFor(usage: unknown, id: string | null): Plain | undefined {
  if (id === null || !Array.isArray(usage)) return undefined;
  return (usage as unknown[]).find((u): u is Plain => isPlain(u) && u['request_id'] === id);
}

/** One request's check, from its own usage record's top-level `prefix_parts` (never `reference`). */
function checkRequest(
  read: Extract<Read, { kind: 'texts' }>,
  request: ReadRequest,
  usage: unknown,
): ModelTextRequestCheck {
  const record = usageFor(usage, request.request_id);
  const parts = record?.['prefix_parts'];
  if (!isPlain(parts)) return { kind: 'no_hashes' };
  const hashOf = (key: string): string | undefined =>
    typeof parts[key] === 'string' ? (parts[key] as string) : undefined;
  const prefixChars = isCount(record!['prefix_chars']) ? record!['prefix_chars'] : undefined;
  const sent = request.sent.map((n) => read.messages[n]!);
  const system = sent.find((m) => m.role === 'system');
  const user = sent.find((m) => m.role === 'user');
  const toolList = request.tools !== undefined ? read.tools[request.tools] : undefined;
  const tools = checkWhole(toolList, hashOf('tools'));
  if (system === undefined && user !== undefined && hashOf('system') !== undefined) {
    const folded = checkFolded(user, hashOf('system'), hashOf('prompt'), prefixChars);
    return { kind: 'parts', ...folded, ...(tools !== undefined ? { tools } : {}) };
  }
  const systemOutcome = checkWhole(system, hashOf('system'));
  const promptOutcome = checkPrompt(user, hashOf('prompt'), prefixChars);
  return {
    kind: 'parts',
    ...(systemOutcome !== undefined ? { system: systemOutcome } : {}),
    ...(promptOutcome !== undefined ? { prompt: promptOutcome } : {}),
    ...(tools !== undefined ? { tools } : {}),
  };
}

/** The view of a `model_text` read whole, its requests checked against `usage` (that entry's). */
function viewOf(read: Extract<Read, { kind: 'texts' }>, usage: unknown): ModelTextView {
  return {
    kind: 'texts',
    messages: read.messages.map((m, i) => ({
      number: i + 1,
      role: m.role,
      bytes: bytesOf(m.text),
      text: m.text,
      marks: marksOf(m),
    })),
    tool_lists: read.tools.map((t, i) => ({
      number: i + 1,
      bytes: bytesOf(t.text),
      json: t.text,
      marks: marksOf(t),
    })),
    requests: read.requests.map((r, i) => ({
      number: i + 1,
      request_id: r.request_id,
      sent: r.sent.map((n) => n + 1),
      reply: r.reply === null ? null : r.reply.map((n) => n + 1),
      ...(r.tools !== undefined ? { tool_list: r.tools + 1 } : {}),
      check: checkRequest(read, r, usage),
    })),
    ...(read.dropped_messages !== undefined && read.dropped_messages > 0
      ? { dropped_messages: read.dropped_messages }
      : {}),
  };
}

/**
 * What `realm run inspect --verbose` shows for one EXECUTION evidence entry (any shape): its texts;
 * a marker; with no `model_text`, `none_on_record` when the entry records a model call
 * (`diagnostics.cache` or `tool_calls`, whatever the step's kind), `no_model_call` for an agent
 * step's entry that records none (the composer's `not_measured_by_realm` rule: an agent step by its
 * definition, else by its `agent_profile`), and `undefined` (nothing) for any other entry.
 * @internal
 */
export function evidenceModelTextView(
  entry: unknown,
  definition?: Pick<WorkflowDefinition, 'steps'>,
): ModelTextView | undefined {
  if (!isPlain(entry)) return undefined;
  const diagnostics = entry['diagnostics'];
  const cache = isPlain(diagnostics) ? diagnostics['cache'] : undefined;
  if (entry['model_text'] === undefined) {
    if (isPlain(cache) || entry['tool_calls'] !== undefined) return { kind: 'none_on_record' };
    const stepId = entry['step_id'];
    const byDefinition =
      typeof stepId === 'string' && definition?.steps[stepId] !== undefined
        ? definition.steps[stepId]!.execution === 'agent'
        : undefined;
    return (byDefinition ?? entry['agent_profile'] !== undefined)
      ? { kind: 'no_model_call' }
      : undefined;
  }
  const read = readModelText(entry['model_text']);
  if (read.kind === 'unreadable') return { kind: 'unreadable' };
  if (read.kind === 'marker') return { kind: read.why };
  return viewOf(read, isPlain(cache) ? cache['requests'] : undefined);
}

/**
 * What `realm run inspect --verbose` shows for one drive-failure entry (any shape): its texts, its
 * requests checked against its own `usage`; `no_requests` when it holds none; a marker;
 * `none_on_record` with no `model_text`.
 * @internal
 */
export function failureModelTextView(entry: unknown): ModelTextView {
  if (!isPlain(entry) || entry['model_text'] === undefined) return { kind: 'none_on_record' };
  const read = readModelText(entry['model_text']);
  if (read.kind === 'unreadable') return { kind: 'unreadable' };
  if (read.kind === 'marker') return { kind: read.why };
  if (read.requests.length === 0) return { kind: 'no_requests' };
  return viewOf(read, entry['usage']);
}
