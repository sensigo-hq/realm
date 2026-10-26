// question-view.ts — #729 PR-4 (D2 §5/§6, PD-2…PD-4; #627 coordination C6 (a)–(h)): the ONE question
// composer. A gate's question is minted ONCE, when the gate opens: the span marks stripped, the
// declared values masked, and only then cut to the view budget (Q7: a cut before the mask would leave
// a secret's prefix the mask no longer matches). Every surface that shows the question composes what
// it shows from the gate PR-3's law has disclosed for its audience (`ShownGate`), through
// `composeQuestionView` — which never cuts or appends the stored question. Pure: no I/O, no clock.
import { createHash } from 'node:crypto';
import type { PendingGate } from '../types/run-record.js';
import { canonicalJson } from '../store/params-hash.js';
import { buildDisclosureSet, disclose, type DisclosureSet } from '../utils/redaction.js';
import { withheldCauseOf } from '../utils/disclosure-walk.js';
import { discloseGate, type ShownGate } from '../utils/disclosure-tables.js';
import { TEMPLATE_PLACEHOLDER } from './render-template.js';

/**
 * The view budget, in rendered units (UTF-16 code units, the length JavaScript measures — never
 * fewer than the characters a channel counts): what agent output feeds into a question's view — the
 * question as shown, a blank line, the preview as shown. The rule: the smallest view limit among the
 * channels Realm ships, divided by that channel's worst escape expansion. The channel table and the
 * derivation cell live beside each channel's renderer. One constant for every process (C6 (a)).
 */
export const VIEW_BUDGET = 600;

const SPAN_MARKS = /[-]/g;

/**
 * The span marks (U+E000–E002) removed, each character singly — from a text, or from every string
 * of a JSON value, keys included. The marks are the CLI writer's print-time spans; one planted in
 * run data would part a declared value and defeat the law's whole-value match, so they go before a
 * value is masked. (`pending.ts`'s module-private `visibleText` removes whole span heads only and is
 * not this.)
 */
export function stripSpanMarks(text: string): string;
export function stripSpanMarks<T>(value: T): T;
export function stripSpanMarks(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(SPAN_MARKS, '');
  // JSON never escapes U+E000–E002, so the marks are removed from the serialised text.
  const json = JSON.stringify(value);
  return json === undefined ? value : JSON.parse(json.replace(SPAN_MARKS, ''));
}

/**
 * Renders a step's `display` template against its output: `{{ field }}` or `{{ nested.field }}` —
 * plain dot-path interpolation, no filters. A missing path renders as empty string; a value that is
 * not a string, as its JSON.
 */
export function renderDisplay(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, expr: string) => {
    const parts = expr.trim().split('.');
    let val: unknown = vars;
    for (const part of parts) {
      if (typeof val !== 'object' || val === null) {
        val = undefined;
        break;
      }
      val = (val as Record<string, unknown>)[part];
    }
    return val === undefined ? '' : typeof val === 'string' ? val : JSON.stringify(val);
  });
}

/** A gate's question as one audience is shown it (PD-2). */
export interface QuestionView {
  /** The gate's question as shown: the declared tier, cut when it opened under a complete set; `''`
   *  when the gate declares no message ((f): the body is the preview). Never cut at read. */
  readonly question_text: string;
  /** The step's output as this audience is shown it — `display` rendered, else the chain — fitted
   *  to what the budget leaves beside the question. */
  readonly preview_text: string;
  /** Which form `preview_text` takes, so a renderer can frame it (a code block for JSON) without
   *  composing it again. */
  readonly preview_format: 'text' | 'json';
  readonly choices: readonly string[];
  /** Set when anything of the view was cut: the characters shown, of the whole, as disclosed. */
  readonly cut?: { readonly shown: number; readonly total: number };
}

/** The line between the question and the preview, counted in the budget. */
const PART_SEPARATOR = '\n\n';
/** The line before the cut sentence. */
const SENTENCE_SEPARATOR = '\n\n';

/**
 * The cut sentence (C6 (d)): what a person reads when the view was cut — on the question when the
 * gate has one, else on the body. It names no command; each door renders the way to the whole output
 * outside the question.
 */
export const CUT_SENTENCE = (shown: number, total: number): string =>
  `[Cut when this question opened: the first ${shown} of ${total} characters are shown. Your answer is checked against what is shown here only, but approving lets the step's whole output go ahead.]`;

const CUT_SENTENCE_AT_END =
  /\[Cut when this question opened: the first (\d+) of (\d+) characters are shown\. Your answer is checked against what is shown here only, but approving lets the step's whole output go ahead\.\]$/;

/** Whether `text` ends with {@link CUT_SENTENCE} — a question cut when its gate opened. */
export function endsWithCutSentence(text: string): boolean {
  return CUT_SENTENCE_AT_END.test(text);
}

function statedCut(text: string): { shown: number; total: number; sentence: number } | undefined {
  const m = CUT_SENTENCE_AT_END.exec(text);
  return m === null
    ? undefined
    : { shown: Number(m[1]), total: Number(m[2]), sentence: m[0].length };
}

/** The room a cut sentence takes beside its text: its separator and its widest form for `total`. */
const sentenceRoom = (total: number): number =>
  SENTENCE_SEPARATOR.length + CUT_SENTENCE(total, total).length;

const previewMarker = (shown: number, total: number): string =>
  `…[cut: ${shown} of ${total} characters]`;
const mintMarker = (shown: number, total: number): string =>
  `…[cut at mint: ${shown} of ${total} characters]`;
const MINT_MARKERS = /…\[cut at mint: \d+ of \d+ characters\]/g;

interface Cut {
  text: string;
  /** How many characters of the text are shown (the marker not counted). */
  shown: number;
  cut: boolean;
}

/** `text` cut to `room` units, its marker inside the room; whole when it fits. The marker is taken
 *  at its widest (`shown = total`), so the cut text never passes the room. */
function cutTo(text: string, room: number, marker: (shown: number, total: number) => string): Cut {
  if (text.length <= room) return { text, shown: text.length, cut: false };
  const total = text.length;
  let shown = room - marker(total, total).length;
  if (shown < 0) return { text: '', shown: 0, cut: true };
  // Never part a surrogate pair.
  const last = text.charCodeAt(shown - 1);
  if (shown > 0 && last >= 0xd800 && last <= 0xdbff) shown -= 1;
  return { text: text.slice(0, shown) + marker(shown, total), shown, cut: true };
}

function sliceSafe(text: string, length: number): string {
  if (length <= 0) return '';
  const last = text.charCodeAt(length - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? length - 1 : length);
}

/** The step's output as a view's preview: `display` when authored (G2), else the chain. */
function previewOf(
  preview: Record<string, unknown>,
  display: string | undefined,
): { text: string; format: 'text' | 'json' } {
  if (display !== undefined) return { text: renderDisplay(display, preview), format: 'text' };
  const headline = typeof preview['headline'] === 'string' ? preview['headline'] : undefined;
  const message = typeof preview['message'] === 'string' ? preview['message'] : undefined;
  if (headline !== undefined || message !== undefined) {
    return {
      text: [headline, message].filter((part) => part !== undefined).join('\n\n'),
      format: 'text',
    };
  }
  if (Object.keys(preview).length === 0) return { text: '(no output)', format: 'text' };
  return { text: JSON.stringify(preview, null, 2), format: 'json' };
}

/**
 * At read, on a gate PR-3's law has disclosed for one audience: the stored question as it is (never
 * cut, never appended), and the preview fitted beside it. A gate with no message shows the step's
 * output as its body, with the cut sentence on the body when the fit cuts it ((f)).
 */
export function composeQuestionView(shown: ShownGate, display?: string): QuestionView {
  const question = shown.resolved_message ?? '';
  const preview = previewOf(shown.preview, display);
  const choices = [...shown.choices];
  if (question === '') {
    if (preview.text.length <= VIEW_BUDGET) {
      return {
        question_text: '',
        preview_text: preview.text,
        preview_format: preview.format,
        choices,
      };
    }
    const total = preview.text.length;
    const body = cutTo(preview.text, VIEW_BUDGET - sentenceRoom(total), previewMarker);
    return {
      question_text: '',
      preview_text: body.text + SENTENCE_SEPARATOR + CUT_SENTENCE(body.shown, total),
      preview_format: preview.format,
      choices,
      cut: { shown: body.shown, total },
    };
  }
  // A question cut when it opened carries its sentence: the room beside it is reckoned with the
  // sentence's widest form, as the mint reckoned it, so the read shows exactly what the mint stated.
  const stated = statedCut(question);
  const questionRoom =
    stated === undefined
      ? question.length
      : question.length - stated.sentence + CUT_SENTENCE(stated.total, stated.total).length;
  const fit = cutTo(
    preview.text,
    VIEW_BUDGET - questionRoom - PART_SEPARATOR.length,
    previewMarker,
  );
  const cut =
    stated !== undefined
      ? { shown: stated.shown, total: stated.total }
      : fit.cut
        ? { shown: question.length + fit.shown, total: question.length + preview.text.length }
        : undefined;
  return {
    question_text: question,
    preview_text: fit.text,
    preview_format: preview.format,
    choices,
    ...(cut !== undefined ? { cut } : {}),
  };
}

/** Whether a set knows every declared value: given, not withheld, not partial (S2). */
function isComplete(set: DisclosureSet | undefined): set is DisclosureSet {
  return set !== undefined && withheldCauseOf(set) === undefined && set.declared !== 'partial';
}

let noSet: DisclosureSet | undefined;
/** The set a view is composed with: the host's, else one that holds nothing (an embedder with none). */
export function questionViewSet(set: DisclosureSet | undefined): DisclosureSet {
  if (set !== undefined) return set;
  noSet ??= buildDisclosureSet({
    env: undefined,
    declared: {},
    declaredState: 'unknown',
    declaredCause: 'embedder_none',
    audience: 'private',
  }).set;
  return noSet;
}

/** How the per-substitution cuts of one gate message went (the mint's (b)). */
export interface MintSubstitutions {
  /** The renderTemplate hook; absent when the host passed no set (the message renders as before). */
  readonly onSubstitution?: (rendered: string, path: string) => string;
  readonly cuts: { count: number; hidden: number; markers: number };
}

/**
 * (b), for one gate message: each RESOLVED value stripped of its marks, masked at the declared tier,
 * and — only under a complete set — cut to its share of the budget, with its marker inside the share.
 * The share leaves the cut sentence its room, so a message whose values were cut keeps its fixed
 * text whole. `n` and the fixed text are counted with renderTemplate's own placeholder rule.
 */
export function mintSubstitutions(
  template: string,
  set: DisclosureSet | undefined,
): MintSubstitutions {
  const cuts = { count: 0, hidden: 0, markers: 0 };
  if (set === undefined) return { cuts };
  const complete = isComplete(set);
  const n = [...template.matchAll(TEMPLATE_PLACEHOLDER)].length;
  const fixed = disclose(
    stripSpanMarks(template.replace(TEMPLATE_PLACEHOLDER, '')),
    set,
    'declared',
  ).text.length;
  const share =
    n === 0
      ? 0
      : Math.max(0, Math.floor((VIEW_BUDGET - sentenceRoom(Number.MAX_SAFE_INTEGER) - fixed) / n));
  return {
    cuts,
    onSubstitution: (rendered) => {
      const masked = disclose(stripSpanMarks(rendered), set, 'declared').text;
      if (!complete) return masked;
      const out = cutTo(masked, share, mintMarker);
      if (out.cut) {
        cuts.count += 1;
        cuts.hidden += masked.length - out.shown;
        cuts.markers += out.text.length - out.shown;
      }
      return out.text;
    },
  };
}

/**
 * (a), for a question minted under a complete set: when (b) cut nothing and the question and the
 * preview fit, the question as it is; else the question kept up to what the cut sentence leaves (cut
 * there when it needs all of it, the preview then empty) and the sentence appended — its numbers the
 * characters the view shows of the whole, as disclosed, the preview counted as the read fits it.
 */
function cutAtMint(
  question: string,
  previewText: string,
  b: { count: number; hidden: number; markers: number },
): string {
  if (
    b.count === 0 &&
    question.length + PART_SEPARATOR.length + previewText.length <= VIEW_BUDGET
  ) {
    return question;
  }
  const total = question.length - b.markers + b.hidden + previewText.length;
  const room = VIEW_BUDGET - sentenceRoom(total);
  const kept = question.length > room ? sliceSafe(question, room) : question;
  const keptContent =
    kept.length - [...kept.matchAll(MINT_MARKERS)].reduce((sum, m) => sum + m[0].length, 0);
  const fit = cutTo(
    previewText,
    VIEW_BUDGET - (kept.length + sentenceRoom(total)) - PART_SEPARATOR.length,
    previewMarker,
  );
  return kept + SENTENCE_SEPARATOR + CUT_SENTENCE(keptContent + fit.shown, total);
}

/**
 * At gate open (the only place a question is cut): the rendered message (through
 * {@link mintSubstitutions}'s hook) stripped and masked with the host's set, then cut under a
 * complete set — `resolved_message` is the question as shown at the declared tier, the text the
 * record stores; `view` is the frozen view (the `'private'` audience: the declared tier, unshaped)
 * and `digest` its {@link viewDigest} — computed for V-1, which stores it; PR-4 stores neither.
 * Without a set the message is stored as rendered; with a partial or withheld one it is masked but
 * never cut (a prefix a complete manifest could later match must never be stored).
 */
export function mintQuestionView(input: {
  message: string | undefined;
  substitutions?: MintSubstitutions;
  preview: Record<string, unknown>;
  choices: readonly string[];
  display?: string;
  set: DisclosureSet | undefined;
  ids: { run_id: string; gate_id: string; step: string };
}): { resolved_message: string | undefined; view: QuestionView; digest: string } {
  const { set } = input;
  const gateWith = (question: string | undefined): PendingGate => ({
    gate_id: input.ids.gate_id,
    step_name: input.ids.step,
    preview: input.preview,
    choices: [...input.choices],
    opened_at: '',
    ...(question !== undefined ? { resolved_message: question } : {}),
  });
  let question = input.message;
  if (question !== undefined && set !== undefined) {
    question = disclose(stripSpanMarks(question), set, 'declared').text;
  }
  if (question !== undefined && isComplete(set)) {
    const shownPreview = discloseGate(stripSpanMarks(gateWith(undefined)), set, 'private').preview;
    question = cutAtMint(
      question,
      previewOf(shownPreview, input.display).text,
      input.substitutions?.cuts ?? { count: 0, hidden: 0, markers: 0 },
    );
  }
  const view = composeQuestionView(
    discloseGate(stripSpanMarks(gateWith(question)), questionViewSet(set), 'private'),
    input.display,
  );
  return { resolved_message: question, view, digest: viewDigest(input.ids, view) };
}

/**
 * The digest of a frozen view (PD-4; A-21; d5r7 §6.3): sha256 over the RFC 8785 form of
 * `{ v: 1, run_id, gate_id, step, choices, question_text, preview }` — `canonicalJson` coincides with
 * RFC 8785 on this shape (strings, an array of strings, one integer). Taken over the mint's
 * `'private'` view only; a view composed for another audience is never digested.
 */
export function viewDigest(
  ids: { run_id: string; gate_id: string; step: string },
  view: QuestionView,
): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        v: 1,
        run_id: ids.run_id,
        gate_id: ids.gate_id,
        step: ids.step,
        choices: [...view.choices],
        question_text: view.question_text,
        preview: view.preview_text,
      }),
    )
    .digest('hex');
}
