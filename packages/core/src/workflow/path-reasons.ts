// path-reasons.ts — the `<why>` of a path that may be absent, shared by `input_map` (fix 1, unit 1)
// and `when` (piece 2a): row 9's four reasons, and gap 2 (ii-a)'s `failure_kind`, worded once.
import { capText } from '../utils/redaction.js';
import type { AbsentCause } from './path-resolver.js';

/** Row 9's `<why>`. */
export function absentWhy(
  cause: Extract<
    AbsentCause,
    {
      rule: 'trigger_rule' | 'optional' | 'default_only' | 'list_position' | 'model_failure_only';
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
  }
}
