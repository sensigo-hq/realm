// bin-settings.ts — #627 W (§5.1): the programs' side of the gate-answers setting — reading
// `--gate-answers` and `--form-wait-seconds` with their environment variables exactly as the server
// will (the most restrictive answers value wins; the smallest wait wins), refusing a bad value before
// anything starts (W-s4, W-s8; W-s9 on the HTTP door), the start lines (W-s1, W-s3, W-s7, W-s5),
// `--check`'s value line (W-s6), and the gate-answers default's line for a session without forms
// (2026-11-14); whether the old name `offered` was given, which the programs raise as REALM-D001. Correction 2 (4.1): ONE home for the three
// programs' words — `realm mcp`, `realm serve` (the CLI re-exports these) and this package's own
// `realm-mcp` bin. Gap 2, unit (iv-b1): the failure-text setting's refusal, start line and `--check`
// line too.
import {
  alsoSetClause,
  formWaitInert,
  judgeFailureText,
  judgeFormWait,
  judgeGateAnswers,
  FAILURE_TEXT_ENV,
  FORM_WAIT_ENV,
  GATE_ANSWERS_ENV,
  type FailureTextSetting,
  type FormWaitSetting,
  type GateAnswers,
  type GateAnswersSetting,
} from '@sensigo/realm';

/** The program a line is printed by: `realm mcp`, `realm serve`, or this package's `realm-mcp` bin. */
export type BinName = 'mcp' | 'serve' | 'realm-mcp';

type SetKind = 'flag' | 'env' | 'option';

/** The program's name as its lines open. */
function programOf(bin: BinName): string {
  return bin === 'realm-mcp' ? 'realm-mcp' : `realm ${bin}`;
}

/** W-s4 (bins): a bad value a bin was given — the server does not start. */
export function gateAnswersBinRefusal(bin: BinName, kind: SetKind, raw: string): string {
  const where = kind === 'env' ? GATE_ANSWERS_ENV : '--gate-answers';
  return `${programOf(bin)}: invalid ${where} value '${raw}': expected asked, permitted or withheld — refused at start: this server does not start while it is set, because a misspelt value would leave gate answers handled differently from what you believe. Fix the value or remove it. The server starts as soon as it is valid.`;
}

/** Gap 2, unit (iv-b1): a failure-text value a bin was given that is neither word — the server does
 *  not start (W-s4's form). */
export function failureTextBinRefusal(bin: BinName, kind: SetKind, raw: string): string {
  const where = kind === 'env' ? FAILURE_TEXT_ENV : '--failure-text';
  return `${programOf(bin)}: invalid ${where} value '${raw}': expected shown or hidden — refused at start: this server does not start while it is set, because a misspelt value would show an assistant a failure's words when you believe they are hidden. Fix the value or remove it. The server starts as soon as it is valid.`;
}

/** W-s8 (bins): a form-wait value out of bounds — the server does not start. */
export function formWaitBinRefusal(bin: BinName, kind: SetKind, raw: string): string {
  const where = kind === 'env' ? FORM_WAIT_ENV : '--form-wait-seconds';
  return `${programOf(bin)}: invalid ${where} value '${raw}': expected a whole number of seconds from 30 to 3600 — refused at start: this server does not start while it is set, because a form must not wait less than a person needs, and the bound keeps a mistyped value from holding a call for hours. Fix the value or remove it; the default is 240. The server starts as soon as it is valid.`;
}

/**
 * W-s9: the form-wait setting on a door that sends no forms (`realm serve`) — refused at start under
 * the inert-config policy (validity · consequence · remedy · re-admission).
 */
export function formWaitInertRefusal(where: '--form-wait-seconds' | typeof FORM_WAIT_ENV): string {
  return `realm serve: ${where} has no effect on this server: its clients get no forms until Realm's HTTP server can hold a form open — refused at start: this server does not start while it is set, because the setting would claim a wait that never happens. Remove it. The server starts as soon as it is removed.`;
}

/**
 * Correction 2 (4.2): the form-wait setting under a gate-answers value that sends no form (`withheld`,
 * `permitted`) on a door that sends forms — refused at start, the inert-config policy's four clauses.
 */
export function formWaitNoFormsRefusal(
  bin: Exclude<BinName, 'serve'>,
  where: '--form-wait-seconds' | typeof FORM_WAIT_ENV,
  value: Exclude<GateAnswers, 'asked'>,
  asOffered = false,
): string {
  // PR #1167 correction 1 (item 6): the value as the person gave it, when its source gave the old name.
  const named = asOffered ? `${value} (given as offered)` : value;
  return `${programOf(bin)}: ${where} has no effect under gate answers ${named}: this server sends no forms then — refused at start: this server does not start while it is set, because the setting would claim a wait that never happens. Remove it, or set gate answers to asked. The server starts as soon as it is removed or gate answers is asked.`;
}

/** What a bin was given for the two settings: its flags (unchecked). */
export interface BinDoorFlags {
  gateAnswers?: string | undefined;
  formWaitSeconds?: string | undefined;
  /** Gap 2, unit (iv-b1): `--failure-text`. */
  failureText?: string | undefined;
}

/**
 * The settings as this bin will start with them, or the one line that refuses the start. A
 * form-wait value where no form is sent refuses the start (correction 2, 4.2: `formWaitInert` — under
 * `withheld` or `permitted`, and on `realm serve`, which sends no forms: W-s9), tested for its presence
 * before W-s8 judges it.
 */
export function readBinDoorSettings(
  bin: BinName,
  flags: BinDoorFlags,
  env: Record<string, string | undefined>,
):
  | {
      ok: true;
      answers: GateAnswersSetting;
      formWait: FormWaitSetting;
      failureText: FailureTextSetting;
    }
  | { ok: false; line: string } {
  const answers = judgeGateAnswers({ flag: flags.gateAnswers, env: env[GATE_ANSWERS_ENV] });
  if (!answers.ok)
    return { ok: false, line: gateAnswersBinRefusal(bin, answers.kind, answers.raw) };
  const fromEnv = env[FORM_WAIT_ENV];
  const given =
    flags.formWaitSeconds !== undefined
      ? ('--form-wait-seconds' as const)
      : fromEnv !== undefined && fromEnv !== ''
        ? FORM_WAIT_ENV
        : undefined;
  if (given !== undefined && formWaitInert(answers.setting.value, bin !== 'serve')) {
    const value = answers.setting.value;
    return {
      ok: false,
      line:
        bin === 'serve' || value === 'asked'
          ? formWaitInertRefusal(given)
          : formWaitNoFormsRefusal(bin, given, value, givenAsOffered(answers.setting)),
    };
  }
  const formWait = judgeFormWait({ flag: flags.formWaitSeconds, env: env[FORM_WAIT_ENV] });
  if (!formWait.ok)
    return { ok: false, line: formWaitBinRefusal(bin, formWait.kind, formWait.raw) };
  // Gap 2, unit (iv-b1): the failure-text value, judged as the server will judge it.
  const failureText = judgeFailureText({ flag: flags.failureText, env: env[FAILURE_TEXT_ENV] });
  if (!failureText.ok)
    return { ok: false, line: failureTextBinRefusal(bin, failureText.kind, failureText.raw) };
  return {
    ok: true,
    answers: answers.setting,
    formWait: formWait.setting,
    failureText: failureText.setting,
  };
}

/** Whether the source the value in force came from gave it as `offered` (its old name). */
function givenAsOffered(setting: GateAnswersSetting): boolean {
  return setting.offeredFrom?.some((s) => s.kind === setting.source.kind) === true;
}

/** `from <source>` with the "also set" clause, as the start lines and `--check` print it. */
function fromClause(setting: GateAnswersSetting | FailureTextSetting): string {
  return `from ${setting.source.ref}${alsoSetClause(setting)}`;
}

/**
 * The start line (`realm mcp` and `realm-mcp`: stderr; `realm serve`: stdout): W-s7 under `asked`,
 * W-s1 under `withheld`, W-s3 under `permitted`. `http`: the HTTP door, whose clients get no forms yet.
 * `bin`: `realm-mcp` takes no flags, so its remedy names the variable.
 */
export function gateAnswersStartLine(
  setting: GateAnswersSetting,
  http: boolean,
  bin: BinName = http ? 'serve' : 'mcp',
): string {
  switch (setting.value) {
    case 'asked': {
      // Correction 2 (8.6 (i)): a flag or the variable that sets `asked` is its source; the default
      // is then named as also asked, never as the source.
      const source =
        setting.source.kind === 'default'
          ? `the default${alsoSetClause(setting)}`
          : `${fromClause(setting)}; the default is also asked`;
      // Correction 1 (E3), correction 2 (4.7: no backticks on a terminal line): the HTTP door's
      // sentences are its own — no app gets forms there. The gate-answers default (2026-11-14): no
      // agent gets the answer tool under asked, in any app.
      const terminal =
        'a person runs, in a terminal on this machine as the user that runs this server: realm run inspect <run_id>, then realm run respond <run_id> --gate <gate_id> --choice <choice>; the agent tells the user the run id. Another Realm server or CLI on the same store can still record answers.';
      const ways = http
        ? `No tool on this server records a gate answer, and this server sends no forms. To answer a waiting question, ${terminal}`
        : `The agent gets no tool on this server that records a gate answer. In chat apps that show forms, questions go to the person in the app's own form. In apps without forms, ${terminal}`;
      return `Gate answers over MCP: asked (${source}). ${ways} To let the agent answer, ${permittedRemedy(setting, bin)}.`;
    }
    case 'withheld':
      return `Gate answers over MCP: withheld (${fromClause(setting)}). No tool on this server records a gate answer, and its replies name no way to answer. To answer a waiting question, a person runs, in a terminal on this machine as the user that runs this server: realm run inspect <run_id> (shows the question, its gate id and its choices), then realm run respond <run_id> --gate <gate_id> --choice <choice>. The agent tells the user the run id. Another Realm server or CLI on the same store can still record answers.`;
    case 'permitted':
      return `Gate answers over MCP: permitted (${fromClause(setting)}; the default is asked). Any client of this server, the agent included, can record a gate answer; it is recorded as arriving through the MCP answer tool.`;
  }
}

/** The setting that lets the agent answer, as this program takes it (`realm-mcp` takes no flags). */
function permittedSetting(bin: BinName): string {
  return bin === 'realm-mcp' ? `${GATE_ANSWERS_ENV}=permitted` : '--gate-answers permitted';
}

/** Each place's name in the remedy (no backticks on a terminal line). */
const PLACE_NAMES = {
  flag: '--gate-answers',
  env: GATE_ANSWERS_ENV,
  option: 'the gateAnswers option',
} as const;

/**
 * The remedy under `asked`, after "To let the agent answer, " (PR #1167 correction 1, item 2): from
 * the default, the setting this program takes; when a flag, the variable or the option set `asked`,
 * every place that holds it, in flag, variable, option order — the most restrictive value wins, so
 * setting `permitted` beside them changes nothing.
 */
function permittedRemedy(setting: GateAnswersSetting, bin: BinName): string {
  if (setting.source.kind === 'default') return `set ${permittedSetting(bin)}`;
  const holding = [
    setting.source,
    ...setting.alsoSet.filter((a) => a.value === 'asked').map((a) => a.source),
  ];
  const places = (['flag', 'env', 'option'] as const)
    .filter((kind) => holding.some((s) => s.kind === kind))
    .map((kind) => PLACE_NAMES[kind]);
  const list =
    places.length === 1
      ? places[0]
      : `${places.slice(0, -1).join(', ')} and ${places[places.length - 1]}`;
  return `set permitted in place of asked in ${list}`;
}

/** CP-W's id for the gate-answers value `offered`, its old name (REALM-D001 in core's table). */
export const OFFERED_DEPRECATION_ID = 'REALM-D001';

/**
 * Whether this program's own reading of its flag or variable gave `offered` (PR #1167 correction 1,
 * item 11): the program then raises {@link OFFERED_DEPRECATION_ID} through its own deprecation
 * door, once per command — the CLI's `warnDeprecated` for `realm mcp` and `realm serve`, the MCP
 * server's for `realm-mcp`. Never the library's option: the library prints nothing.
 */
export function offeredGivenToProgram(setting: GateAnswersSetting): boolean {
  return (setting.offeredFrom ?? []).some((s) => s.kind === 'flag' || s.kind === 'env');
}

/**
 * The line for a session whose client shows no forms, under `asked` (the gate-answers default,
 * 2026-11-14): printed once on stderr by `realm mcp` and `realm-mcp` when such a session starts, from
 * the library's `onSessionWithoutForms`. `realm serve` prints none: its start line says this. Its
 * remedy names where `asked` was set, as the start line's does.
 */
export function gateAnswersConnectLine(
  bin: Exclude<BinName, 'serve'>,
  setting: GateAnswersSetting,
): string {
  return `Gate answers over MCP: this app shows no forms, so the agent cannot answer gates on this server and the person cannot answer in the app. A person answers in a terminal on this machine with realm run respond; to let the agent answer, ${permittedRemedy(setting, bin)}.`;
}

/**
 * Gap 2, unit (iv-b1): the failure-text start line, printed under `hidden` only, where the program
 * prints its gate-answers line (`realm mcp` and `realm-mcp`: stderr; `realm serve`: stdout); none
 * under `shown`.
 */
export function failureTextStartLine(setting: FailureTextSetting): string | undefined {
  if (setting.value !== 'hidden') return undefined;
  return `Failure text over MCP: hidden (${fromClause(setting)}). In get_run_state and in the replies to its own calls, an assistant sees the step and its code, category or class, not the failure's words, except where a step copies them into its own output; realm run inspect still shows them.`;
}

/** Gap 2, unit (iv-b1): `--check`'s failure-text line, printed after the gate-answers value line. */
export function failureTextCheckLine(setting: FailureTextSetting): string {
  return `Failure text over MCP: ${setting.value} (${fromClause(setting)}) — as read from this shell's environment and flags.`;
}

/** W-s5: dev mode's warning, printed when the value is `permitted` (the answer tool is listed). */
export const DEV_MODE_ANSWER_WARNING =
  "Warning: dev mode — authentication is disabled: any process on this machine can call this server's tools, the gate answer tool included.";

/** W-s6: `--check`'s value line. */
export function checkValueLine(
  setting: GateAnswersSetting,
  word: (value: string) => string = (value) => value,
): string {
  // #729 PR-3 correction 2 (C1): the value stands alone; a printer may show it as realm's own word.
  return `Gate answers over MCP: ${word(setting.value)} (${fromClause(setting)}) — as read from this shell's environment and flags. A server started another way (your MCP client's config, launchd, systemd, or a program that embeds Realm) reads its own environment: run --check with that same environment, or read that server's start line or its embedder's log of effectiveGateAnswers(). Nothing was started.`;
}
