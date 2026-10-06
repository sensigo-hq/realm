import { WorkflowError } from '../types/workflow-error.js';

/**
 * The callers of `advanceRun` (decisions C124, C133): each names itself — on the reply's `command`
 * and, when the call carries out an expired question, on that line's `enacted_via`. `advanceRun`
 * is a program's own call (the library default); `advance_run` the MCP tool; `advance`
 * `realm run advance`; `start_run` and `agent` the other hosts that call it. A closed set: the
 * free label is `advanceRun`'s `command` option.
 */
export const ADVANCE_CALLERS = [
  'advanceRun',
  'advance_run',
  'advance',
  'start_run',
  'agent',
] as const;

export type AdvanceCaller = (typeof ADVANCE_CALLERS)[number];

/** A value as the refusal names it: a string quoted, a number, boolean or `null` as written. */
function shownValue(value: unknown): string {
  if (typeof value === 'string') return `'${value}'`;
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return `a value of type ${typeof value}`;
}

/**
 * The admission step's check of `advanceRun`'s `caller` (decision C133): absent passes (the default
 * `advanceRun` applies); any value outside {@link ADVANCE_CALLERS} THROWS — a plain-JS host gets no
 * type error, and the word would otherwise reach the reply and the expiry line. Thrown before
 * anything is read or written, as every host-wiring check is.
 */
export function validateAdvanceCaller(caller: unknown): void {
  if (caller === undefined) return;
  if ((ADVANCE_CALLERS as readonly unknown[]).includes(caller)) return;
  throw new WorkflowError(
    `advanceRun's caller is one of ${ADVANCE_CALLERS.join(', ')}; it was given ${shownValue(caller)}. To label the reply with a word of your own, pass command. Nothing was read or written.`,
    {
      code: 'ENGINE_INTERNAL',
      category: 'ENGINE',
      agentAction: 'stop',
      retryable: false,
      details: {
        option: 'caller',
        given: typeof caller === 'string' ? caller : shownValue(caller),
        accepted: [...ADVANCE_CALLERS],
      },
    },
  );
}
