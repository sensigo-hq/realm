// slack-accounts.ts — #603 A3a: the CLI's one predicate, "does this name a Slack account?", and the
// helpers built on it. Core's judge (`judgeAnswerer`) compares names by equality; this module is the
// only place that knows a Slack member ID's shape. It decides the closed question's post and console
// lines, validate's warnings, the project list's entry check and the private reply's words.
import { judgeAnswerer, type AnswererQuestion } from '@sensigo/realm';

const MEMBER_ID = /^[UW][A-Z0-9]+$/;
const MEMBER_MENTION = /^<@([UW][A-Z0-9]+)>$/;

/** The bare member ID a name gives (`U1` for `U1` or `<@U1>`); `undefined` for any other name. */
export function slackMemberId(name: string): string | undefined {
  if (MEMBER_ID.test(name)) return name;
  return MEMBER_MENTION.exec(name)?.[1];
}

/** Whether a name is a Slack member ID (`U…`/`W…`) or its mention (`<@U…>`/`<@W…>`). */
export function namesSlackAccount(name: string): boolean {
  return slackMemberId(name) !== undefined;
}

/** The forms that name a Slack user, as a question may write them. */
export function senderForms(user: string): string[] {
  return [user, `<@${user}>`];
}

/** The names a question allows, from core's judge; `[]` when it names no one. */
export function namedAnswerers(question: AnswererQuestion): string[] {
  const verdict = judgeAnswerer(question, []);
  return 'refused' in verdict ? verdict.refused.allowed : [];
}

/** Whether a question names answerers and none of them is a Slack account: no reply can count. */
export function closedInSlack(question: AnswererQuestion): boolean {
  const names = namedAnswerers(question);
  return names.length > 0 && !names.some(namesSlackAccount);
}

/** Items joined as people read a list: `a`, `a or b`, `a, b or c`. */
export function orList(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;
}

/** The distinct member IDs among names, as mentions (`<@U1>`), in order. */
export function memberMentions(names: readonly string[]): string[] {
  const ids = names.map(slackMemberId).filter((id): id is string => id !== undefined);
  return [...new Set(ids)].map((id) => `<@${id}>`);
}
