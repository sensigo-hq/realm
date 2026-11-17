import { WorkflowError } from '../types/workflow-error.js';

/**
 * The words the engine's entries name themselves by, one closed list per entry.
 * The word is the call the expiry line names (`this <caller> call first carried out …
 * (enacted_via: <caller>).`) when that call carries out an expired question's declared
 * `on_expiry`, and, for `advanceRun`, the reply's `command` unless `command` is given. The first
 * word of each list is the default: the library function itself, a program's own call. The others
 * are the hosts that call it and pass their own name — the MCP tools (`advance_run`, `start_run`,
 * `execute_step`, `submit_human_response`) and the CLI commands (`advance` is `realm run advance`,
 * `agent` is `realm agent`, `run` is `realm workflow run`, `respond` is `realm run respond`). No
 * word names a call that is not made (round 20's finding 5: `executeEngineStep` admits its own call).
 * Never a free string: `command` is `advanceRun`'s free label.
 * @public
 */
export const ENTRY_CALLERS = {
  advanceRun: ['advanceRun', 'advance_run', 'advance', 'start_run', 'agent'],
  executeStep: ['executeStep', 'agent'],
  executeEngineStep: ['executeEngineStep', 'agent'],
  executeChain: ['executeChain', 'execute_step', 'agent', 'run'],
  submitHumanResponse: ['submitHumanResponse', 'submit_human_response', 'respond', 'run', 'agent'],
} as const;

/** An entry that takes a `caller`. */
export type NamedEntry = keyof typeof ENTRY_CALLERS;

/** `advanceRun`'s callers (decisions C124, C133). */
export const ADVANCE_CALLERS = ENTRY_CALLERS.advanceRun;
/**
 * The names a call to `advanceRun` can give for where it came from: the library call, the MCP tools
 * `advance_run` and `start_run`, `realm run advance` or `realm agent` (`AdvanceRunOptions.caller`).
 * @public
 */
export type AdvanceCaller = (typeof ENTRY_CALLERS.advanceRun)[number];
/**
 * The names a call to `executeStep` can give for where it came from (`ExecuteStepOptions.caller`).
 * @public
 */
export type StepCaller = (typeof ENTRY_CALLERS.executeStep)[number];
/**
 * The names a call to `executeEngineStep` can give: its own word and `realm agent`'s. It admits its
 * own call, so a refusal names `executeEngineStep`.
 * @public
 */
export type EngineStepCaller = (typeof ENTRY_CALLERS.executeEngineStep)[number];
/**
 * The names a call to `executeChain` can give for where it came from
 * (`ExecuteChainOptions.caller`).
 * @public
 */
export type ChainCaller = (typeof ENTRY_CALLERS.executeChain)[number];
/**
 * The names a call to `submitHumanResponse` can give for where it came from
 * (`SubmitGateOptions.caller`).
 * @public
 */
export type AnswerCaller = (typeof ENTRY_CALLERS.submitHumanResponse)[number];

/** A value as the refusal names it: a string quoted, a number, boolean or `null` as written. */
function shownValue(value: unknown): string {
  if (typeof value === 'string') return `'${value}'`;
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return `a value of type ${typeof value}`;
}

/**
 * The admission step's check of an entry's `caller` (decisions C133, C144, C151): absent passes (the
 * entry's default applies); any value outside the entry's list in {@link ENTRY_CALLERS} THROWS
 * `VALIDATION_CALLER_INVALID` — a plain-JS host gets no type error, and the word would otherwise
 * reach the expiry line (and `advanceRun`'s reply). An entry without a list takes no `caller`.
 * Thrown before anything is read or written, as every host-wiring check is.
 */
export function validateCaller(entry: string, caller: unknown): void {
  if (caller === undefined || !(entry in ENTRY_CALLERS)) return;
  const accepted: readonly string[] = ENTRY_CALLERS[entry as NamedEntry];
  if ((accepted as readonly unknown[]).includes(caller)) return;
  const label =
    entry === 'advanceRun' ? ' To label the reply with a word of your own, pass command.' : '';
  throw new WorkflowError(
    `${entry}'s caller is one of ${accepted.join(', ')}; it was given ${shownValue(caller)}.${label} Nothing was read or written.`,
    {
      code: 'VALIDATION_CALLER_INVALID',
      category: 'VALIDATION',
      agentAction: 'report_to_user',
      retryable: false,
      details: {
        option: 'caller',
        entry,
        given: typeof caller === 'string' ? caller : shownValue(caller),
        accepted: [...accepted],
      },
    },
  );
}
