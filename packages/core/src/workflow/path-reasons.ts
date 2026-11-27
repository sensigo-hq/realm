// path-reasons.ts — the `<why>` of a path that may be absent, shared by `input_map` (fix 1, unit 1)
// and `when` (piece 2a): row 9's four reasons, and gap 2 (ii-a)'s `failure_kind`, worded once.
// Gap 3, unit 1b-i: and `input_map`'s sentence for a path that can never be found, which a
// `remember:` path reads too, with its own opening.
import { capText } from '../utils/redaction.js';
import type { AbsentCause, NeverCause } from './path-resolver.js';

/**
 * A path that can never be found, as `input_map`'s words say it (fix 1, unit 1): `opening` is the
 * finding's start (`Step '<s>': input_map '<key>'`), and `field` the field that takes a path, for
 * the `template` cause.
 */
export function neverWords(
  opening: string,
  path: string,
  cause: NeverCause,
  field: 'input_map' | 'remember',
): { text: string; didYouMean?: string } {
  const p = capText(path);
  switch (cause.rule) {
    case 'bad_start':
    case 'bad_root':
      return {
        text:
          `${opening} reads '${p}', which can never be found: a path starts with 'run.params.' or ` +
          `'context.resources.<step>.'.` +
          (cause.fix !== undefined ? ` Write it as '${capText(cause.fix)}'.` : ''),
      };
    case 'template':
      return {
        text:
          `${opening} is '${p}': ${field} takes a path, not a template, so the braces make it a ` +
          `path that can never be found.` +
          (cause.fix !== undefined ? ` Write it as '${capText(cause.fix)}'.` : ''),
      };
    case 'no_step':
      return withDidYouMean(
        `${opening} reads '${p}', but the workflow has no step '${capText(cause.step)}'.`,
        cause.didYouMean,
      );
    case 'no_field':
      return withDidYouMean(
        `${opening} reads '${p}', but step '${cause.step}' has no field '${capText(cause.field)}' ` +
          `there, and its schema allows no other fields.`,
        cause.didYouMean,
      );
    case 'no_settlement_field':
      return withDidYouMean(
        `${opening} reads '${p}', but '$settlement.${cause.step}' holds only 'failed', ` +
          `'settled_by_default', 'validation_rejections', 'failure_kind' and 'message'.`,
        cause.didYouMean,
      );
    case 'no_param':
      return withDidYouMean(
        `${opening} reads '${p}', but params_schema has no parameter '${capText(cause.param)}' ` +
          `and allows no others.`,
        cause.didYouMean,
      );
    // Piece 3a-ii-a's rows, which no `input_map` path reaches: its surface has no context root and
    // does not read the step's own output (a `remember:` path words its own two).
    case 'own_settlement':
    case 'own_choice':
    case 'no_context_entry':
      return { text: `${opening} reads '${p}', which can never be found.` };
  }
}

function withDidYouMean(
  text: string,
  didYouMean: string | undefined,
): { text: string; didYouMean?: string } {
  return didYouMean === undefined
    ? { text }
    : { text: `${text} Did you mean '${capText(didYouMean)}'?`, didYouMean };
}

/** Row 9's `<why>`. */
export function absentWhy(
  cause: Extract<
    AbsentCause,
    {
      rule:
        | 'trigger_rule'
        | 'optional'
        | 'default_only'
        | 'list_position'
        | 'model_failure_only'
        | 'failure_only';
    }
  >,
): string {
  switch (cause.rule) {
    case 'trigger_rule':
      return cause.through === undefined
        ? `this step's trigger_rule lets it run when '${cause.step}' did not complete`
        : `step '${cause.through}''s trigger_rule lets it run when '${cause.step}' did not complete`;
    case 'optional':
      return `'${capText(cause.field)}' is optional in its schema`;
    case 'default_only':
      return (
        `'${capText(cause.field)}' is only in default_output, which the step records only when ` +
        `it takes its default answer`
      );
    case 'list_position':
      return `'${cause.position}' is a position in a list that may be shorter`;
    case 'model_failure_only':
      return (
        `'failure_kind' is set only when step '${capText(cause.step)}''s model request failed and ` +
        `the step has on_model_failure`
      );
    case 'failure_only':
      // Gap 2, unit (iv-a1), Words 4.
      return (
        `'message' is set only when step '${capText(cause.step)}' failed, or took its default ` +
        `answer after its model request failed`
      );
  }
}
