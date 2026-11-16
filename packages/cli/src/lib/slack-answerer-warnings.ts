// slack-answerer-warnings.ts — #603 A3a (W6, W6b): when the project's realm.yaml has a Slack
// notifier that reads replies, each gate that names someone who is not a Slack member ID is said —
// advice, so `--json` carries it and `--strict` fails on it. Made where validate, register and
// watch share the admission, and in `validate --registered`.
import {
  resolveSeverity,
  type LoaderWarning,
  type SlackGateNotifierConfig,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { namedAnswerers, namesSlackAccount, orList } from '../agent/gate/slack-accounts.js';

/** Whether a Slack notifier reads replies: `bot_token` and `channel_id`, with `app_token` or
 *  `signing_secret` (the condition realm.yaml's `answerers` check uses too). */
export function readsSlackReplies(slack: SlackGateNotifierConfig['config'] | undefined): boolean {
  return (
    slack !== undefined &&
    slack.bot_token !== undefined &&
    slack.channel_id !== undefined &&
    (slack.app_token !== undefined || slack.signing_secret !== undefined)
  );
}

/** The warnings for a workflow's gates under the project's Slack notifier (none without one). */
export function slackAnswererWarnings(
  definition: WorkflowDefinition,
  slack: SlackGateNotifierConfig['config'] | undefined,
): LoaderWarning[] {
  if (!readsSlackReplies(slack)) return [];
  const warnings: LoaderWarning[] = [];
  for (const [step, stepDef] of Object.entries(definition.steps)) {
    const names = stepDef.gate !== undefined ? namedAnswerers(stepDef.gate) : [];
    const ids = names.filter(namesSlackAccount);
    const warn = (message: string): LoaderWarning => ({
      code: 'GATE_ANSWERER_NOT_SLACK_ID',
      severity: resolveSeverity('GATE_ANSWERER_NOT_SLACK_ID'),
      message,
      scope: 'step',
      step,
    });
    if (names.length > 0 && ids.length === 0) {
      warnings.push(
        warn(
          `Gate on step '${step}': no one it names (${names.join(', ')}) is a Slack member ID, so no reply in its Slack thread counts; answer it with \`realm run respond\`. Name the person by member ID (U…), list member IDs in \`answerers\`, or remove \`owner\` and \`answerers\` so that the project's \`answerers\`, or without them anyone in the thread, can answer.`,
        ),
      );
      continue;
    }
    for (const name of names.filter((n) => !namesSlackAccount(n))) {
      warnings.push(
        warn(
          `Gate on step '${step}': '${name}' is not a Slack member ID, so only ${orList(ids)} can answer it in Slack.`,
        ),
      );
    }
  }
  return warnings;
}
