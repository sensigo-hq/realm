// path-reasons.ts — the `<why>` of a path that may be absent, shared by `input_map` (fix 1, unit 1)
// and `when` (piece 2a): row 9's four reasons, worded once.
import { capText } from '../utils/redaction.js';
import type { AbsentCause } from './path-resolver.js';

/** Row 9's `<why>`. */
export function absentWhy(
  cause: Extract<
    AbsentCause,
    { rule: 'trigger_rule' | 'optional' | 'default_only' | 'list_position' }
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
        `its answers are refused too often`
      );
    case 'list_position':
      return `'${cause.position}' is a position in a list that may be shorter`;
  }
}
