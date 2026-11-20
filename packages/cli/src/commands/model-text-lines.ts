// Gap 1, unit B: the lines `realm run inspect --verbose` prints for one entry's `model_text`, from
// core's reader (`evidenceModelTextView`, `failureModelTextView`), which works out the texts, why
// there are none and each request's check. This file only words and prints them.
//
// Every stored text and tool list reaches the terminal through the writer's value path, as a tool
// call's result does: masked for stdout's audience at print, a shape under broadcast, its type and
// size while values are withheld. The value path is given the stored text itself, so a shape
// describes it, never its escaped form (the writer's rule for `escaped`). What it returns then has
// every control character but `\n` and `\t`, the C1 controls and U+2028/U+2029 escaped (inspect's
// own spelling, `controlEscape`), still before stdout's masking pass, so a stored text can neither
// move the cursor nor overwrite a line.
import {
  controlEscape,
  type ModelTextCheckOutcome,
  type ModelTextMark,
  type ModelTextRequestCheck,
  type ModelTextView,
} from '@sensigo/realm';
import { writerCtx } from '../output/writer.js';

// eslint-disable-next-line no-control-regex -- the control characters are what is escaped
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/g;

/** A stored text with every control character but `\n` and `\t` written as its escape. */
export function escapeStoredText(text: string): string {
  return text.replace(CONTROLS, controlEscape);
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
/** A size as inspect writes sizes. */
const size = (bytes: number): string => `${bytes} bytes`;

function markText(mark: ModelTextMark): string {
  switch (mark.kind) {
    case 'left_out':
      return `left out to fit 64 KB (${size(mark.full_bytes)})`;
    case 'cut':
      return `cut: kept ${size(mark.kept_bytes)} of ${size(mark.full_bytes)}`;
    case 'hidden':
      return `${plural(mark.count, 'known secret value', 'known secret values')} replaced by [REDACTED]`;
  }
}

function outcomeText(outcome: ModelTextCheckOutcome): string {
  switch (outcome.outcome) {
    case 'matches':
      return 'matches';
    case 'first_chars_match':
      return `first ${outcome.chars} characters match`;
    case 'differs':
      return 'differs';
    case 'not_checkable':
      return `not checkable (${
        outcome.reason === 'left_out'
          ? 'left out'
          : outcome.reason === 'cut'
            ? 'cut'
            : 'secret values replaced'
      })`;
    case 'not_checked':
      return outcome.reason === 'empty_head'
        ? 'not checked (only its empty start was hashed)'
        : 'not checked (no hash on the record)';
  }
}

function checkText(check: ModelTextRequestCheck): string {
  if (check.kind === 'no_hashes') return 'Not checked: no hashes on the record for this request.';
  const parts = [
    check.system !== undefined ? `system text ${outcomeText(check.system)}` : undefined,
    check.prompt !== undefined ? `prompt ${outcomeText(check.prompt)}` : undefined,
    check.tools !== undefined ? `tool list ${outcomeText(check.tools)}` : undefined,
  ].filter((p): p is string => p !== undefined);
  return parts.length === 0
    ? 'Not checked: no hashes on the record for this request.'
    : `Checked against what was sent: ${parts.join(', ')}.`;
}

const numbers = (list: readonly number[]): string => (list.length === 0 ? 'none' : list.join(', '));

/**
 * A stored text's lines, each under `indent`: the writer's value path for the stored text, then
 * escaped. A shape names no character of the text, so the escape leaves it as it is; on the plain
 * path the value path only strips span marks, a set the escape never touches, so the order changes
 * no plain line.
 */
function textLines(text: string, indent: string): string[] {
  return escapeStoredText(writerCtx().value(text))
    .split('\n')
    .map((line) => `${indent}${line}`);
}

/**
 * The lines for one entry's `model_text` view, under `indent`: `evidence` for a step's entry,
 * `failure` for a drive failure (the absence sentences differ). `undefined` prints nothing.
 */
export function modelTextLines(
  view: ModelTextView | undefined,
  where: 'evidence' | 'failure',
  indent: string,
): string[] {
  if (view === undefined) return [];
  const line = (text: string): string => `${indent}${text}`;
  switch (view.kind) {
    case 'switched_off':
      return [
        line('Model text: not kept. Recording was off for this drive (--no-record-model-text).'),
      ];
    case 'provider_did_not_report':
      return [line('Model text: not kept. The provider module did not report it.')];
    case 'unreadable':
      return [line('Model text: could not be read on the record.')];
    case 'no_model_call':
      return [
        line(
          'Model text: none. The record holds no model call for this step: for example, an assistant answered it over MCP, a person typed the answer, a program that embeds the engine ran it, or Realm 0.45.0 or earlier drove it.',
        ),
      ];
    case 'no_requests':
      return [
        line(
          "Model text: none for this failure. It came before any model request, or its step's requests are on the step's own entry.",
        ),
      ];
    case 'none_on_record':
      return [
        line(
          where === 'failure'
            ? 'Model text: none on the record for this failure. Realm 0.50.0 and earlier did not keep it, and only realm agent and realm listen write it.'
            : 'Model text: none on the record. Realm 0.50.0 and earlier did not keep it, and a program that embeds the engine keeps it only when it passes it.',
        ),
      ];
    case 'texts': {
      const out = [line(`Model text: ${plural(view.requests.length, 'request', 'requests')}`)];
      const inner = `${indent}  `;
      for (const request of view.requests) {
        const tools = request.tool_list !== undefined ? `; tool list ${request.tool_list}` : '';
        const label =
          request.reply === null
            ? 'got no answer'
            : request.request_id === null
              ? 'no id'
              : escapeStoredText(request.request_id);
        const reply = request.reply === null ? '' : `; reply ${numbers(request.reply)}`;
        out.push(
          `${inner}Request ${request.number} (${label}): sent ${numbers(request.sent)}${reply}${tools}`,
        );
        out.push(`${inner}  ${checkText(request.check)}`);
      }
      for (const message of view.messages) {
        const marks = message.marks.map((m) => ` · ${markText(m)}`).join('');
        out.push(
          `${inner}Message ${message.number} · ${message.role} · ${size(message.bytes)}${marks}`,
        );
        if (!message.marks.some((m) => m.kind === 'left_out')) {
          out.push(...textLines(message.text, `${inner}  `));
        }
      }
      for (const list of view.tool_lists) {
        const marks = list.marks.map((m) => ` · ${markText(m)}`).join('');
        out.push(`${inner}Tool list ${list.number} · ${size(list.bytes)}${marks}`);
        if (!list.marks.some((m) => m.kind === 'left_out')) {
          out.push(...textLines(list.json, `${inner}  `));
        }
      }
      if (view.dropped_messages !== undefined) {
        out.push(
          `${inner}${plural(view.dropped_messages, 'message', 'messages')} left out to fit 64 KB.`,
        );
      }
      return out;
    }
  }
}
