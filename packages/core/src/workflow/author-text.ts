// author-text.ts — #627 W (F31, §5.4d): text a workflow's author wrote that an agent reads. Realm
// forwards it labelled as the author's (W-t1, rendered by the MCP door) and the loader notes, never
// refuses, a field whose text names an answer tool (W-l1): when the server withholds answers, or the
// user's app shows forms, the agent has no such tool. A text match: it finds tool NAMES, not every
// way of asking an agent to answer.

/** The answer tools and the command W-l1 looks for, in the order a field's first match is reported. */
export const ANSWER_TOOL_NAMES = [
  'submit_human_response',
  'present_question',
  'realm run respond',
] as const;
export type AnswerToolName = (typeof ANSWER_TOOL_NAMES)[number];

/**
 * Each name's pattern: the whole name as a word (`respond` alone never matches, so "respond to the
 * user" is silent); the command allows any spacing between its words.
 */
const PATTERNS: readonly (readonly [AnswerToolName, RegExp])[] = [
  ['submit_human_response', /\bsubmit_human_response\b/],
  ['present_question', /\bpresent_question\b/],
  ['realm run respond', /\brealm\s+run\s+respond\b/],
];

/** The first answer tool a text names, or `undefined`. */
export function answerToolNamedIn(text: string): AnswerToolName | undefined {
  for (const [name, pattern] of PATTERNS) {
    if (pattern.test(text)) return name;
  }
  return undefined;
}

/**
 * W-l1, the load note: `field` is the author's field (`gate.agent_hint`, `instructions`,
 * `protocol.rules`), `step` the step it sits on (none for the workflow-level `protocol.rules`), `line`
 * the field's own line when the parse placed it.
 */
export function authorTextNote(where: {
  step?: string;
  field: string;
  line?: number;
  tool: AnswerToolName;
}): string {
  const at = where.line !== undefined ? ` (line ${where.line})` : '';
  const scope = where.step !== undefined ? `Step '${where.step}': ` : '';
  return (
    `Note: ${scope}${where.field}${at} tells the agent to use '${where.tool}'. When this server ` +
    "withholds answers, or the user's app shows forms, the agent has no such tool; Realm forwards " +
    "this text marked as the author's, followed by its own rule that the agent cannot answer. " +
    'Consider removing it. (This is a text match: it finds tool names, not every way of asking.)'
  );
}

/** W-t1: the label before a gate's `agent_hint` and a gated step's instructions. */
export const AUTHOR_TEXT_LABEL = "From the workflow's author:";

/** W-t1: the label before a workflow's `protocol.rules`, Realm's own rules after them. */
export const AUTHOR_RULES_LABEL = "Rules from the workflow's author:";
