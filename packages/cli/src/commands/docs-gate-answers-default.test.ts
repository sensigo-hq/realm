// docs-gate-answers-default.test.ts — the gate-answers default (2026-11-14), AC9 (guardrail 9): every
// sentence the change writes into the docs, quoted word for word from its page, each with the cell that
// executes what it says. A row whose page drops or rewords its sentence is red; so is a row whose
// executing cell is renamed or gone (its file no longer holds the cell's title).
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure: the
// page and the sentence, or the cell that is missing.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const flat = (t: string) => t.replace(/\s+/g, ' ');
const read = (path: string) => flat(readFileSync(join(ROOT, path), 'utf8'));

/** A cell, by its file and (part of) its title, as the test runner prints it. */
type Cell = readonly [file: string, title: string];

const MCP = 'packages/mcp-server/src';
const CLI = 'packages/cli/src';
const AC1: Cell = [
  `${MCP}/gate-answers-default.test.ts`,
  'AC1 — stdio, a client that shows no forms',
];
const AC2: Cell = [`${MCP}/gate-answers-default.test.ts`, 'AC2 — a server built per HTTP request'];
const AC3_LIB: Cell = [`${MCP}/gate-answers-default.test.ts`, 'offered given as %s'];
const AC3_ALSO: Cell = [
  `${MCP}/gate-answers-default.test.ts`,
  'alsoSet quotes another source as written',
];
// PR #1167 correction 1 (item 8): the ranking of the three values is core's own cell; offered's
// ranking is in AC3's alsoSet cell.
const RANK: Cell = [
  'packages/core/src/engine/w-627.test.ts',
  'the most restrictive value wins, whichever place sets it',
];
const AC6_LIB: Cell = [
  `${MCP}/gate-answers-default.test.ts`,
  'onSessionWithoutForms: once for asked',
];
const AC3_BINS: Cell = [
  `${CLI}/commands/gate-answers-default-programs.test.ts`,
  'the flag, the variable and both: the REALM-D001 line once on stderr',
];
const OPTION_SILENT: Cell = [
  `${MCP}/gate-answers-default.test.ts`,
  'the option given as offered raises no deprecation',
];
const NO_LATE_NOTE: Cell = [
  `${CLI}/commands/gate-answers-default-programs.test.ts`,
  'realm-mcp says REALM-D001 as it starts: on stderr once, and never as a log notification',
];
const CPW_MCP_DOOR: Cell = [
  `${MCP}/deprecations-cpw.test.ts`,
  'with the option: the line once on stderr; the notification received with no level set',
];
const COMPAT_TABLE: Cell = [
  'packages/core/src/deprecations/deprecations.test.ts',
  'the section holds a row per entry (id, since, goes away, what)',
];
const AC5_STDIO: Cell = [
  `${CLI}/commands/gate-answers-default-programs.test.ts`,
  'realm mcp and realm-mcp: asked, permitted and withheld, word for word',
];
const AC5_SERVE: Cell = [
  `${CLI}/commands/gate-answers-default-programs.test.ts`,
  'realm serve: asked, permitted and withheld, word for word, on stdout',
];
const AC6_BINS: Cell = [
  `${CLI}/commands/gate-answers-default-programs.test.ts`,
  'once for an asked session whose client shows no forms',
];
const AC7: Cell = [
  `${CLI}/commands/gate-answers-default-programs.test.ts`,
  'realm serve --dev warns that the answer tool is open under permitted only',
];
const WAIT: Cell = [
  `${CLI}/commands/gate-answers-default-programs.test.ts`,
  'the form-wait refusal reads permitted, given as offered, for offered',
];
const HELP: Cell = [
  `${CLI}/commands/gate-answers-default-programs.test.ts`,
  'realm mcp --help and realm serve --help name asked (the default), permitted or withheld',
];
const REMEDY: Cell = [
  `${CLI}/commands/gate-answers-default-programs.test.ts`,
  'the variable sets asked and the flag permitted',
];
const CHECK_DEFAULT: Cell = [
  `${CLI}/lib/separation-check-627.test.ts`,
  'asked from the default says so',
];

const ROWS: Cell = [
  `${MCP}/door-627.test.ts`,
  'row by row, by tool NAME: permitted → the answer tool',
];
const PROTOCOL: Cell = [`${MCP}/door-627.test.ts`, 'rule 2, the await rule (W-p4, every value)'];
const HTTP_PER_REQUEST: Cell = [`${MCP}/http-door-627.test.ts`, 'a server built per request'];
const HTTP_PER_SESSION: Cell = [
  `${MCP}/http-door-627.test.ts`,
  'a server kept per HTTP session sends forms',
];
const REFUSAL: Cell = [`${CLI}/commands/docs-627.test.ts`, 'who can answer follows the value'];
const COUNT_TOOLS_MD: Cell = [
  `${MCP}/tools/docs-claims-625.test.ts`,
  'C163: the server has 11 tools',
];
const COUNT_GUIDE: Cell = [
  `${MCP}/tools/docs-pages-625-guides.test.ts`,
  'connect-an-mcp-client.md, glossary.md, packages/mcp-server/README.md: the server has 11 tools',
];
const COUNT_README: Cell = [
  `${MCP}/tools/docs-sweep-625.test.ts`,
  'packages/mcp-server/README.md: the server exposes 11 tools',
];
const GATE_EXAMPLE: Cell = [
  `${MCP}/tools/docs-claims-625.test.ts`,
  '"A step with a gate" example is the opening reply',
];
const RUN_STATE_EXAMPLE: Cell = [
  `${MCP}/tools/docs-pages-625-run-state.test.ts`,
  'the reply at a gate: next_actions and next_actions_status',
];
const AWAITING_HUMAN: Cell = [
  `${MCP}/tools/docs-pages-625-run-state.test.ts`,
  'awaiting_human: a gate open whose time is not up',
];
const SIX_RULES: Cell = [
  `${MCP}/tools/docs-pages-625-guides.test.ts`,
  'top-level-fields.md: the opening instruction without protocol, and the six standard rules',
];
const RULES_ROW: Cell = [
  `${MCP}/tools/docs-pages-625-guides.test.ts`,
  'top-level-fields.md: rules replaces',
];
const TOOLS_RULES_ROW: Cell = [
  `${MCP}/tools/false-sentences-625.test.ts`,
  'F-R1: without protocol.rules',
];
const PR_EXAMPLE: Cell = [
  `${MCP}/tools/docs-pages-625-start.test.ts`,
  'how-a-run-moves.md, what-is-realm.md: the pull-request review example',
];

const S1 =
  "By default, no agent gets a tool that records a gate answer through Realm's MCP server: in an app that shows forms the person answers in the app's form; elsewhere a person answers in a terminal on the server's machine with `realm run respond`.";
const S2 = '`--gate-answers permitted` gives the answer tool to every client, the agent included.';
const S3 = '`offered`, its name until version 0.49.0, still works.';
const HTTP =
  'On an HTTP server built per request — `realm serve`, or a program that builds a server per request or passes `statelessHttp` — no client gets forms. A program that keeps one server per HTTP session sends forms as stdio does.';
const SERVE_LINE =
  'Gate answers over MCP: asked (the default). No tool on this server records a gate answer, and this server sends no forms. To answer a waiting question, a person runs, in a terminal on this machine as the user that runs this server: realm run inspect <run_id>, then realm run respond <run_id> --gate <gate_id> --choice <choice>; the agent tells the user the run id. Another Realm server or CLI on the same store can still record answers. To let the agent answer, set --gate-answers permitted.';

/** Every changed sentence: its page, its words, and the cells that execute it. */
const SENTENCES: ReadonlyArray<readonly [page: string, sentence: string, cells: Cell[]]> = [
  [
    'docs/reference/mcp/gate-answers.md',
    "The default. No agent gets a tool that records an answer, in any app. In an app that shows forms, the question goes to the person in the app's own form. In an app without forms, and on an HTTP server built per request (`realm serve`, or a program that builds a server per request or passes `statelessHttp`), no form is sent: a person answers in a terminal on the server's machine, as the user that runs the server, with `realm run respond`. Changed after version 0.49.0: before, the agent kept the answer tool in an app without forms.",
    [AC1, AC2, AC5_STDIO],
  ],
  [
    'docs/reference/mcp/gate-answers.md',
    `| \`permitted\` | The answer tool, for any client of the server, the agent included. ${S3}`,
    [ROWS, AC3_LIB],
  ],
  [
    'docs/reference/mcp/gate-answers.md',
    'the most restrictive value wins: `withheld`, then `asked`, then `permitted`. A value that is not one of the three, and not `offered`, stops the server from starting.',
    [RANK, AC3_ALSO],
  ],
  [
    'docs/reference/mcp/gate-answers.md',
    'The setting is refused at start wherever no form is sent: under `withheld` or `permitted`, on `realm serve`, and with `statelessHttp`.',
    [WAIT],
  ],
  [
    'docs/reference/mcp/gate-answers.md',
    'To let an agent answer in an app without forms, set `permitted`: the agent then records answers itself, and Realm cannot see whether a person agreed. A headless client that declares forms but cancels them leaves the question waiting: set `permitted` for such a client.',
    [AC3_LIB, ROWS],
  ],
  ['docs/reference/mcp/gate-answers.md', 'the asked, permitted and withheld values', [ROWS]],
  [
    'docs/concepts/gates-and-trust.md',
    `${S1} ${HTTP} ${S2} ${S3}`,
    [AC1, HTTP_PER_REQUEST, HTTP_PER_SESSION, ROWS, AC3_LIB],
  ],
  [
    'docs/guides/human-gates.md',
    `${S1} Under \`withheld\`, no tool answers. ${HTTP} ${S2} ${S3}`,
    [AC1, HTTP_PER_REQUEST, HTTP_PER_SESSION, ROWS, AC3_LIB],
  ],
  [
    'docs/guides/human-gates.md',
    'That refusal is from a server started with `--gate-answers permitted`, whose sessions list the answer tool. Under the default `asked`, and under `withheld`, the refusal names no answer, and `next_actions` holds the await entry instead of the answer call',
    [REFUSAL],
  ],
  [
    'docs/start/what-is-realm.md',
    'That is a session of a server started with `--gate-answers permitted`, whose assistant has the answer tool. Under the default `asked`, and under `withheld`, the refusal names no answer',
    [REFUSAL],
  ],
  [
    'docs/start/how-a-run-moves.md',
    'In the same example, on a server started with `--gate-answers permitted`, after the reviewer approved:',
    [PR_EXAMPLE],
  ],
  ['docs/guides/connect-an-mcp-client.md', `${S1} See [Gate answers over MCP]`, [AC1, ROWS]],
  [
    'docs/guides/connect-an-mcp-client.md',
    "The assistant now has ten tools under `withheld` (the value step 1's example sets), and under the default `asked` in an app that shows no forms; eleven under `asked` in an app that shows forms, and under `permitted` (`advance_run` was added after version 0.46.0, which has ten). The table lists the eleven of `permitted`:",
    [COUNT_GUIDE, ROWS],
  ],
  [
    'docs/guides/connect-an-mcp-client.md',
    '`submit_human_response` is listed under `permitted` only. Under the default `asked`, in an app that shows forms, `present_question` takes its place; in an app without forms, and under `withheld`, neither is listed (added after version 0.47.0; changed after version 0.49.0: before, the agent kept `submit_human_response` in an app without forms).',
    [ROWS],
  ],
  [
    'docs/guides/connect-an-mcp-client.md',
    `- ${S1} - Under \`permitted\`, the briefing instructs the assistant to show you that text, wait for your choice, and pass it on with \`submit_human_response\`. ${S3}`,
    [AC1, PROTOCOL],
  ],
  ['docs/guides/connect-an-mcp-client.md', SERVE_LINE, [AC5_SERVE]],
  ['docs/guides/deploy.md', SERVE_LINE, [AC5_SERVE]],
  ['docs/reference/cli/realm-mcp-and-serve.md', SERVE_LINE, [AC5_SERVE]],
  [
    'docs/reference/cli/realm-mcp-and-serve.md',
    "Which answer tool is among them follows the server's gate-answers value and the client: `submit_human_response` under `permitted`, `present_question` under `asked` with a forms client of `realm mcp` (never on `realm serve`, which sends no forms), and neither under `withheld`, or under `asked` with a client that shows no forms, which serve 10.",
    [ROWS, HTTP_PER_REQUEST],
  ],
  [
    'docs/reference/cli/realm-mcp-and-serve.md',
    `How the server handles gate answers: \`asked\`, \`permitted\` or \`withheld\`. ${S3} With \`REALM_MCP_GATE_ANSWERS\` also set, the most restrictive wins.`,
    [RANK, AC3_ALSO, AC3_BINS],
  ],
  [
    'docs/reference/cli/realm-mcp-and-serve.md',
    'Refused at start under `withheld` or `permitted`, which send no form.',
    [WAIT],
  ],
  [
    'docs/reference/cli/realm-mcp-and-serve.md',
    'as it stops `realm mcp` under `withheld` or `permitted`: the setting is refused at start wherever no form is sent.',
    [WAIT],
  ],
  [
    'docs/reference/cli/realm-mcp-and-serve.md',
    'Under `asked`, when an app that shows no forms connects, it prints one more: `Gate answers over MCP: this app shows no forms, so the agent cannot answer gates on this server and the person cannot answer in the app. A person answers in a terminal on this machine with realm run respond; to let the agent answer, set --gate-answers permitted.` A value given as `offered`, as the flag or the variable, prints `Warning: [REALM-D001] The gate-answers value offered was given. It is now called permitted, and works the same. Write permitted in its place. offered keeps working: no removal is scheduled.` once, as every [deprecation](../compatibility.md#deprecations) does. Both were added after version 0.49.0.',
    [AC6_BINS, AC3_BINS],
  ],
  [
    'docs/reference/cli/realm-mcp-and-serve.md',
    'and prints its start line on stderr, and the same two lines as `realm mcp` for an app that shows no forms (its remedy naming `REALM_MCP_GATE_ANSWERS`) and for `offered`.',
    [AC6_BINS, AC3_BINS],
  ],
  [
    'docs/reference/cli/realm-mcp-and-serve.md',
    "in dev mode when that value is `permitted`, `Warning: dev mode — authentication is disabled: any process on this machine can call this server's tools, the gate answer tool included.`",
    [AC7],
  ],
  [
    'docs/reference/mcp/tools.md',
    "Realm's MCP server has 11 tools under `permitted`, and, on `realm mcp`, under `asked` in an app that shows forms (where `present_question` takes the place of `submit_human_response`); and 10 under `withheld`, and under the default `asked` in an app that shows no forms, which list no answer tool. A reply on this page that shows the answer call came from a server started with `--gate-answers permitted`.",
    [COUNT_TOOLS_MD, ROWS, HTTP_PER_REQUEST],
  ],
  [
    'docs/reference/mcp/tools.md',
    "a line for the server's gate-answers value (none under `permitted`), and two rules about concurrent attempts.",
    [TOOLS_RULES_ROW, PROTOCOL],
  ],
  [
    'docs/reference/mcp/tools.md',
    'This reply came from a server started with `--gate-answers permitted`. Under the default `asked`, and under `withheld`, the agent gets no answer call: the entry has `awaiting` instead of `instruction`.',
    [GATE_EXAMPLE, AC1],
  ],
  [
    'docs/reference/workflow/top-level-fields.md',
    "a line for the server's gate-answers value (none under `permitted`), and two rules about concurrent attempts.",
    [RULES_ROW],
  ],
  [
    'docs/reference/workflow/top-level-fields.md',
    "When you receive status 'confirm_required', read gate.agent_hint when the reply has one, present gate.display to the user verbatim when the reply has one, and follow next_actions: the question is answered outside this conversation. Do NOT auto-confirm",
    [SIX_RULES],
  ],
  [
    'docs/reference/workflow/top-level-fields.md',
    'The second rule above is the one a session gets from a server whose gate-answers value is `asked`, the default, when its client shows no forms, and under `withheld`. Under `permitted` it reads: "When you receive status \'confirm_required\', read gate.agent_hint for instructions when the reply has one, present gate.display to the user verbatim when the reply has one, wait for their response, then call submit_human_response by copying the call in next_actions[0].instruction.call_with and filling in their choice."',
    [PROTOCOL],
  ],
  [
    'docs/reference/mcp/run-state-and-health.md',
    'This read came from a server started with `--gate-answers permitted`. Under the default `asked`, and under `withheld`, the entry has `awaiting` in place of `instruction`,',
    [RUN_STATE_EXAMPLE, AC1],
  ],
  [
    'docs/reference/mcp/run-state-and-health.md',
    "The question's answer, `submit_human_response`, without a `claim_token`, where the session has the answer tool (under `permitted`); under the default `asked` and under `withheld`, the await entry.",
    [AWAITING_HUMAN],
  ],
  ['README.md', '`realm-mcp` MCP server — 11 tools (10 without an answer tool)', [COUNT_TOOLS_MD]],
  [
    'README.md',
    '`submit_human_response` (under `permitted` only; `present_question` in its place under the default `asked` with a forms client of `realm mcp` (never on `realm serve`, which sends no forms); neither under `withheld`, or under `asked` with a client that shows no forms, which list 10),',
    [ROWS, HTTP_PER_REQUEST],
  ],
  [
    'packages/mcp-server/README.md',
    'Exposes up to 11 workflow tools (10 without an answer tool: under `withheld`, and under the default `asked` in an app that shows no forms) over stdio or HTTP',
    [COUNT_README, COUNT_GUIDE],
  ],
  [
    'packages/mcp-server/README.md',
    'A client is listed 11 tools under `permitted`, and under `asked` in a session whose client shows forms (never with `statelessHttp`); else 10. Under `asked` `present_question` is registered, and a session whose client shows forms enables it.',
    [COUNT_GUIDE, HTTP_PER_REQUEST],
  ],
  [
    'packages/mcp-server/README.md',
    '`gateAnswers?` (`asked`, `permitted` or `withheld`; `offered`, its name until version 0.49.0, still works), `onSessionWithoutForms?` (called once when a session whose client shows no forms starts under `asked`; the library prints nothing)',
    [AC3_LIB, AC6_LIB],
  ],
  [
    'packages/mcp-server/README.md',
    'runs with (`asked`, `permitted` or `withheld`), where it came from',
    [AC3_LIB, AC3_ALSO],
  ],
  [
    'packages/mcp-server/README.md',
    "- `submit_human_response` — resolve a human gate (listed under `permitted` only; under `asked` in a session whose client shows forms, `present_question` takes its place and sends the waiting question to the user's app as a form — added after version 0.47.0; under `withheld`, and under `asked` in a session whose client shows no forms, neither is listed — changed after version 0.49.0)",
    [ROWS],
  ],
  [
    'docs/reference/core-library.md',
    '`createRealmMcpServer` returns the MCP server that `realm mcp` runs, with 11 tools, or 10 where no answer tool is listed: under `withheld`, and under the default `asked` in a session whose client shows no forms',
    [COUNT_TOOLS_MD],
  ],
  [
    'docs/reference/glossary.md',
    'Realm is an MCP server with 11 tools, or 10 where no answer tool is listed (10 in version 0.46.0).',
    [COUNT_GUIDE],
  ],
  [
    'docs/reference/environment-and-files.md',
    'How the server handles gate answers: `asked`, `permitted` or `withheld` (`offered`, its name until version 0.49.0, still works).',
    [AC3_LIB, AC3_BINS],
  ],
  [
    'docs/guides/upgrade.md',
    "From the version after 0.49.0, the agent no longer answers gates by default in an app without forms, through `realm serve`, or through a program that builds its server per HTTP request or passes `statelessHttp`. If an agent answered gates for you there, start the server with `--gate-answers permitted` (`REALM_MCP_GATE_ANSWERS=permitted` for `realm-mcp`; `gateAnswers: 'permitted'` in a program that embeds Realm). The tool the agent then gets no longer asks the app to have you approve each call, as the old default's tool did. Code that reads `offered` from `GATE_ANSWERS_VALUES`, `GateAnswers`, `AnswersRow` or the `realm/gate_answers` capability reads `permitted` now.",
    [AC1, AC2, AC3_LIB, AC3_BINS, ROWS],
  ],
  [
    'CHANGELOG.md',
    "**1. The agent no longer answers gates by default in an app without forms, through `realm serve`, or through a program that builds its server per HTTP request or passes `statelessHttp`.** If an agent answered gates for you there, start the server with `--gate-answers permitted` (`REALM_MCP_GATE_ANSWERS=permitted` for `realm-mcp`; `gateAnswers: 'permitted'` in a program that embeds Realm). The tool the agent then gets no longer asks the app to have you approve each call, as the old default's tool did. Code that reads `offered` from `GATE_ANSWERS_VALUES`, `GateAnswers`, `AnswersRow` or the `realm/gate_answers` capability reads `permitted` now. See [The agent no longer answers gates by default](docs/guides/upgrade.md#the-agent-no-longer-answers-gates-by-default).",
    [AC1, AC2, AC3_LIB, AC3_BINS, ROWS],
  ],
  [
    'CHANGELOG.md',
    "- **By default, an agent can no longer answer a gate through Realm's MCP server, in any app.** In an app that shows forms nothing changes: the person answers in the app's form. In an app without forms, on `realm serve`, and in a program that builds its server per HTTP request or passes `statelessHttp`, the agent no longer gets the answer tool: a person answers in a terminal on the server's machine with `realm run respond`, and the start line, and a line when such an app connects, say so. `--gate-answers permitted` (`REALM_MCP_GATE_ANSWERS=permitted`, `gateAnswers: 'permitted'`) lets the agent answer, as `offered` did; `offered` still works and prints a line saying it is now called `permitted`. Changed lines: the start lines, `--check`'s value lines and the words of its value gap, the bad-value refusal, the form-wait refusal's value, both commands' `--help`, and `realm serve --dev`'s answer-tool warning, which now prints only under `permitted`. Library: `GATE_ANSWERS_VALUES`, `GateAnswers` and `AnswersRow` name `permitted` in place of `offered`; `AnswersRow` has no `fallback`; `effectiveGateAnswers()` and the `realm/gate_answers` capability read `permitted`.",
    [
      AC1,
      AC2,
      AC5_STDIO,
      AC5_SERVE,
      AC6_BINS,
      AC3_BINS,
      AC3_LIB,
      ROWS,
      WAIT,
      HELP,
      AC7,
      REMEDY,
      CHECK_DEFAULT,
    ],
  ],
  [
    'docs/reference/mcp/gate-answers.md',
    '`realm mcp` and `realm serve` print the value they run with when they start. Under `withheld`, and under `asked`, they also print how a person answers from a terminal: `realm run inspect <run_id>`, then `realm run respond <run_id> --gate <gate_id> --choice <choice>`.',
    [AC5_STDIO, AC5_SERVE],
  ],
  [
    'docs/reference/compatibility.md',
    '| REALM-D001 | 0.50.0 | not scheduled | The gate-answers value offered was given. |',
    [COMPAT_TABLE, AC3_BINS, OPTION_SILENT],
  ],
  // PR #1167, MA 2's wording slips after correction 1 (W1, W2): REALM-D001 is said before any app
  // connects, so its line goes to the error output only.
  [
    'CHANGELOG.md',
    "over the stdio MCP server also the protocol's log notification. The first is REALM-D001, the gate-answers value `offered`: the program says it as it starts, before any app connects, so its line goes to the error output only (see [Compatibility](docs/reference/compatibility.md)).",
    [AC3_BINS, NO_LATE_NOTE, CPW_MCP_DOOR],
  ],
  [
    'docs/reference/compatibility.md',
    "to the protocol's log notification. A value read as the program starts, such as REALM-D001's, is said before any app connects, so its line goes to the error output only. The identifier never changes",
    [AC3_BINS, NO_LATE_NOTE, CPW_MCP_DOOR],
  ],
];

describe('the gate-answers default — every changed docs sentence, with the cell that runs it (AC9)', () => {
  it.each(SENTENCES.map(([page, sentence, cells], i) => [i + 1, page, sentence, cells] as const))(
    'sentence %i, %s',
    (_i, page, sentence, cells) => {
      // (a) red when the page drops or rewords the sentence; (b) prints the page and the sentence.
      expect(read(page), `${page} no longer says: ${sentence}`).toContain(flat(sentence));
      // (a) red when a cell named as this sentence's executor is renamed or gone; (b) prints it.
      expect(
        cells.filter(([file, title]) => !readFileSync(join(ROOT, file), 'utf8').includes(title)),
        `${page}: a cell that runs this sentence is missing`,
      ).toEqual([]);
    },
  );

  it('the gate-answers default left no old sentence: no page names the old default’s tool or offered as a value in force', () => {
    const pages = [...new Set(SENTENCES.map(([page]) => page).filter((p) => p !== 'CHANGELOG.md'))];
    const stale = [
      'the app is asked to have the person approve each call',
      'keeps the answer tool',
      'marked for approval',
      'anthropic/requiresUserInteraction',
      'under `offered`',
      '`asked`, `offered` or `withheld`',
      'asked, offered or withheld',
      'To keep the agent from answering in every app',
      'is now called permitted; offered still works',
    ];
    // (a) red when one of the pages keeps an old default sentence; (b) prints each page and phrase.
    expect(
      pages.flatMap((page) =>
        stale.filter((s) => read(page).includes(flat(s))).map((s) => `${page}: ${s}`),
      ),
    ).toEqual([]);
  });
});
