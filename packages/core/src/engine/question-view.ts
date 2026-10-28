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

const SPAN_MARKS = /[\uE000-\uE002]/g;

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
  // One quantifier between the braces, and no brace inside (the trim is the code's; renderTemplate's
  // own placeholder rule): `\s*([^}]+?)\s*` let three quantifiers match the same spaces, and a
  // `[^}]+` that admits `{` rescans from every `{{` — `{{{{` + spaces took cubic time, `{{{{|`
  // repeated quadratic (CodeQL js/polynomial-redos). A display is author text, and an agent can
  // author a workflow. A `{{ dot.path }}` holds no brace, so it renders as before.
  return template.replace(/\{\{([^{}]+)\}\}/g, (_, expr: string) => {
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

/** The first render of one gate message (the mint's (b), rev 8): what the caps are computed from. */
export interface MintSubstitutions {
  /** The FIRST render's hook: each resolved value stripped and masked, never cut; it records the
   *  masked length. Absent when the host passed no set (the message renders as before). */
  readonly onSubstitution?: (rendered: string, path: string) => string;
  /** Each masked value's length, in the order the first render met them. */
  readonly lengths: readonly number[];
  /** The fixed text's length, stripped and masked — counted with renderTemplate's own placeholder
   *  rule, so a filtered `{{ x | f }}` is a substitution, not fixed text. */
  readonly fixed: number;
}

/**
 * (b)'s first half, for one gate message: the hook for the UNCUT render (R1) — each RESOLVED value
 * stripped of its marks and masked at the declared tier, its length recorded in a closure. The hook
 * is pure in its output; the caps come from the recorded lengths, and the second render (inside
 * {@link mintQuestionView}) applies them.
 */
export function mintSubstitutions(
  template: string,
  set: DisclosureSet | undefined,
): MintSubstitutions {
  const lengths: number[] = [];
  if (set === undefined) return { lengths, fixed: 0 };
  const fixed = disclose(
    stripSpanMarks(template.replace(TEMPLATE_PLACEHOLDER, '')),
    set,
    'declared',
  ).text.length;
  return {
    lengths,
    fixed,
    onSubstitution: (rendered) => {
      const masked = disclose(stripSpanMarks(rendered), set, 'declared').text;
      lengths.push(masked.length);
      return masked;
    },
  };
}

/** The largest cap `c` with `Σ min(len_i, c) <= room` (water-filling): a value no longer than the
 *  even share keeps its length, and the room it leaves goes to the longer ones. */
function waterFill(lengths: readonly number[], room: number): number {
  if (room <= 0) return 0;
  const sorted = [...lengths].sort((a, b) => a - b);
  let left = room;
  let longer = sorted.length;
  for (const length of sorted) {
    const even = Math.floor(left / longer);
    if (length > even) return even;
    left -= length;
    longer -= 1;
  }
  return Number.MAX_SAFE_INTEGER;
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
 * At gate open (the only place a question is cut). The message comes rendered once UNCUT through
 * {@link mintSubstitutions}'s hook (R1: each value stripped and masked); one mask over the whole of
 * it (M1) finds a declared member anywhere — in the fixed text, straddling a boundary, split across
 * two substitutions. Under a complete set: when M1 equals R1 and the question overflows the budget,
 * `rerender` renders it again with each value cut to its water-filled cap ((b)); when M1 differs,
 * (b) is skipped and M1 is the message, so no fragment of a member known at mint survives a cut.
 * Then (a) over the whole. `resolved_message` is the question as shown at the declared tier, the
 * text the record stores; `view` is the frozen view (the `'private'` audience: the declared tier,
 * unshaped) and `digest` its {@link viewDigest} — computed for V-1, which stores it; PR-4 stores
 * neither. Without a set the message is stored as rendered; with a partial or withheld one it is
 * masked but never cut (a prefix a complete manifest could later match must never be stored).
 */
export function mintQuestionView(input: {
  message: string | undefined;
  substitutions?: MintSubstitutions;
  /** The message rendered again with the given hook — the engine's own renderTemplate call. */
  rerender?: (onSubstitution: (rendered: string, path: string) => string) => string;
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
    const r1 = stripSpanMarks(question);
    const m1 = disclose(r1, set, 'declared').text;
    question = m1;
    if (isComplete(set)) {
      const shownPreview = discloseGate(
        stripSpanMarks(gateWith(undefined)),
        set,
        'private',
      ).preview;
      const previewText = previewOf(shownPreview, input.display).text;
      const b = { count: 0, hidden: 0, markers: 0 };
      const subs = input.substitutions;
      if (
        m1 === r1 &&
        subs !== undefined &&
        input.rerender !== undefined &&
        subs.fixed + subs.lengths.reduce((sum, length) => sum + length, 0) > VIEW_BUDGET
      ) {
        // The room leaves the cut sentence its place, sized for this view's whole, so the values'
        // cuts keep the fixed text whole and the sentence then fits.
        const cap = waterFill(
          subs.lengths,
          VIEW_BUDGET - sentenceRoom(r1.length + previewText.length) - subs.fixed,
        );
        // #729 PR-4 correction (B1): a value cut to nothing left no trace (PR4-MA1-REV-18). So the
        // values are cut one by one only when each keeps at least one character beside its marker
        // (the marker at its widest for this message's values; + 1 keeps a surrogate pair whole);
        // otherwise the message is cut as a whole below, with its sentence.
        const longest = subs.lengths.length > 0 ? Math.max(...subs.lengths) : 0;
        if (subs.lengths.length > 0 && cap > mintMarker(longest, longest).length + 1) {
          const r2 = input.rerender((rendered) => {
            const masked = disclose(stripSpanMarks(rendered), set, 'declared').text;
            const out = cutTo(masked, cap, mintMarker);
            if (out.cut) {
              b.count += 1;
              b.hidden += masked.length - out.shown;
              b.markers += out.text.length - out.shown;
            }
            return out.text;
          });
          question = disclose(stripSpanMarks(r2), set, 'declared').text;
        }
      }
      question = cutAtMint(question, previewText, b);
    }
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
