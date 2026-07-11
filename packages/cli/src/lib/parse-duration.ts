// parse-duration.ts — shared duration-string parser for CLI commands (issue #107).
//
// Extracted from cleanup.ts / reclaim.ts, which each carried their own byte-identical copy (a
// deliberate deferral noted in reclaim.ts's original comment: "cleanup.ts is out of this PR's
// scope"). Both commands, plus the new `purge` command, now import this single implementation.
import { WorkflowError } from '@sensigo/realm';

/**
 * Parses a duration string such as "30d", "6h", or "10m" into milliseconds.
 * Throws a `WorkflowError` (code `VALIDATION_INPUT_SCHEMA`) on a malformed string — this is
 * cleanup.ts's original error shape; reclaim.ts previously threw a plain `Error` for the same
 * condition, unified here onto the typed form.
 */
export function parseDuration(s: string): number {
  const match = /^(\d+)(d|h|m)$/.exec(s);
  if (match === null) {
    throw new WorkflowError(
      `Invalid duration '${s}'. Use format: <number>(d|h|m), e.g. 30d, 6h, 10m`,
      {
        code: 'VALIDATION_INPUT_SCHEMA',
        category: 'VALIDATION',
        agentAction: 'provide_input',
        retryable: false,
      },
    );
  }
  const value = parseInt(match[1]!, 10);
  const unit = match[2]!;
  const multipliers: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000 };
  return value * multipliers[unit]!;
}
