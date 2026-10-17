// gate-answers-door.ts — #627 W (§5.1): the `realm mcp` / `realm serve` side of the gate-answers
// setting — reading `--gate-answers` and `--form-wait-seconds` with their environment variables
// exactly as the server will (the most restrictive answers value wins; the smallest wait wins),
// refusing a bad value before anything starts (W-s4, W-s8; W-s9 on the HTTP door), the start lines
// (W-s1, W-s3, W-s7, W-s5) and `--check`'s value line (W-s6).
import {
  alsoSetClause,
  judgeFormWait,
  judgeGateAnswers,
  FORM_WAIT_ENV,
  GATE_ANSWERS_ENV,
  type FormWaitSetting,
  type GateAnswersSetting,
} from '@sensigo/realm';

type SetKind = 'flag' | 'env' | 'option';
/** W-s4 (bins): a bad value a bin was given — the server does not start. */
export function gateAnswersBinRefusal(bin: 'mcp' | 'serve', kind: SetKind, raw: string): string {
  const where = kind === 'env' ? GATE_ANSWERS_ENV : '--gate-answers';
  return `realm ${bin}: invalid ${where} value '${raw}': expected asked, offered or withheld — refused at start: this server does not start while it is set, because a misspelt value would leave gate answers handled differently from what you believe. Fix the value or remove it. The server starts as soon as it is valid.`;
}

/** W-s8 (bins): a form-wait value out of bounds — the server does not start. */
export function formWaitBinRefusal(bin: 'mcp' | 'serve', kind: SetKind, raw: string): string {
  const where = kind === 'env' ? FORM_WAIT_ENV : '--form-wait-seconds';
  return `realm ${bin}: invalid ${where} value '${raw}': expected a whole number of seconds from 30 to 3600 — refused at start: this server does not start while it is set, because a form must not wait less than a person needs, and the bound keeps a mistyped value from holding a call for hours. Fix the value or remove it; the default is 240. The server starts as soon as it is valid.`;
}

/**
 * W-s9: the form-wait setting on a door that sends no forms (`realm serve`) — refused at start under
 * the inert-config policy (validity · consequence · remedy · re-admission).
 */
export function formWaitInertRefusal(where: '--form-wait-seconds' | typeof FORM_WAIT_ENV): string {
  return `realm serve: ${where} has no effect on this server: its clients get no forms until Realm's HTTP server can hold a form open — refused at start: this server does not start while it is set, because the setting would claim a wait that never happens. Remove it. The server starts as soon as it is removed.`;
}

/** What a bin was given for the two settings: its flags (unchecked). */
export interface BinDoorFlags {
  gateAnswers?: string | undefined;
  formWaitSeconds?: string | undefined;
}

/**
 * The two settings as this bin will start with them, or the one line that refuses the start.
 * `serve` sends no forms, so any form-wait value there refuses the start (W-s9, the inert-config
 * policy).
 */
export function readBinDoorSettings(
  bin: 'mcp' | 'serve',
  flags: BinDoorFlags,
  env: Record<string, string | undefined>,
):
  | { ok: true; answers: GateAnswersSetting; formWait: FormWaitSetting }
  | { ok: false; line: string } {
  const answers = judgeGateAnswers({ flag: flags.gateAnswers, env: env[GATE_ANSWERS_ENV] });
  if (!answers.ok)
    return { ok: false, line: gateAnswersBinRefusal(bin, answers.kind, answers.raw) };
  // Correction 1 (E2): on `realm serve` any form-wait value refuses the start with W-s9 — its presence
  // is tested before W-s8 judges it (W-s8's "starts as soon as it is valid" would be false there).
  if (bin === 'serve') {
    if (flags.formWaitSeconds !== undefined)
      return { ok: false, line: formWaitInertRefusal('--form-wait-seconds') };
    const fromEnv = env[FORM_WAIT_ENV];
    if (fromEnv !== undefined && fromEnv !== '')
      return { ok: false, line: formWaitInertRefusal(FORM_WAIT_ENV) };
  }
  const formWait = judgeFormWait({ flag: flags.formWaitSeconds, env: env[FORM_WAIT_ENV] });
  if (!formWait.ok)
    return { ok: false, line: formWaitBinRefusal(bin, formWait.kind, formWait.raw) };
  return { ok: true, answers: answers.setting, formWait: formWait.setting };
}

/** `from <source>` with the "also set" clause, as the start lines and `--check` print it. */
function fromClause(setting: GateAnswersSetting): string {
  return `from ${setting.source.ref}${alsoSetClause(setting)}`;
}

/**
 * The start line (`realm mcp`: stderr; `realm serve`: stdout): W-s7 under `asked`, W-s1 under
 * `withheld`, W-s3 under `offered`. `http`: the HTTP door, whose clients get no forms yet.
 */
export function gateAnswersStartLine(setting: GateAnswersSetting, http: boolean): string {
  switch (setting.value) {
    case 'asked': {
      const from =
        setting.source.kind === 'default' ? alsoSetClause(setting) : `; ${fromClause(setting)}`;
      // Correction 1 (E3): the HTTP door's first sentence is its own — no app gets forms there.
      const forms = http
        ? 'On this server no chat app gets forms: under `asked` every client keeps the answer tool, and the app is asked to have the person approve each call; some apps and settings skip that.'
        : "In chat apps that show forms, questions go to the person in the app's own form, and the agent gets no tool that records a gate answer. In apps without forms, the agent keeps the answer tool, and the app is asked to have the person approve each call; some apps and settings skip that.";
      return `Gate answers over MCP: asked (the default${from}). ${forms} To keep the agent from answering in every app, set --gate-answers withheld. To answer from a terminal: realm run inspect <run_id>, then realm run respond <run_id> --gate <gate_id> --choice <choice>.`;
    }
    case 'withheld':
      return `Gate answers over MCP: withheld (${fromClause(setting)}). No tool on this server records a gate answer, and its replies name no way to answer. To answer a waiting question, a person runs, in a terminal on this machine as the user that runs this server: realm run inspect <run_id> (shows the question, its gate id and its choices), then realm run respond <run_id> --gate <gate_id> --choice <choice>. The agent tells the user the run id. Another Realm server or CLI on the same store can still record answers.`;
    case 'offered':
      return `Gate answers over MCP: offered (${fromClause(setting)}; the default is asked). Any client of this server, the agent included, can record a gate answer; it is recorded as arriving through the MCP answer tool.`;
  }
}

/** W-s5: dev mode's warning, printed when the value is not `withheld` (an answer tool is listed). */
export const DEV_MODE_ANSWER_WARNING =
  "Warning: dev mode — authentication is disabled: any process on this machine can call this server's tools, the gate answer tool included.";

/** W-s6: `--check`'s value line. */
export function checkValueLine(setting: GateAnswersSetting): string {
  return `Gate answers over MCP: ${setting.value} (${fromClause(setting)}) — as read from this shell's environment and flags. A server started another way (your MCP client's config, launchd, systemd, or a program that embeds Realm) reads its own environment: run --check with that same environment, or read that server's start line or its embedder's log of effectiveGateAnswers(). Nothing was started.`;
}
