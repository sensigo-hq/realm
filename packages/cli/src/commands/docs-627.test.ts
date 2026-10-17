// docs-627.test.ts — #627 W, Part L: every sentence W adds to the docs, each held to what the build
// does (the #625 docs-claims pattern; guardrail 7(f)), and the CHANGELOG's lines under their headings.
// A claim is checked word for word; its behaviour is executed here, on the built packages.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure: the
// sentence, the tool names, the texts — never a token or an environment.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  JsonFileStore,
  JsonWorkflowStore,
  advanceRun,
  answerArrivalOf,
  judgeFormWait,
  judgeGateAnswers,
  loadWorkflowFromString,
  submitHumanResponse,
  FORM_WAIT_SECONDS_DEFAULT,
} from '@sensigo/realm';
import { createRealmMcpServer, FORM_ASKS_AFTER_FIRST } from '@sensigo/realm-mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { renderAnswerLine } from '../lib/holder-render.js';
import { gateAnswersStartLine, readBinDoorSettings } from '../lib/gate-answers-door.js';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const flat = (t: string) => t.replace(/\s+/g, ' ');
/** (a) red when the page no longer holds the sentence word for word; (b) prints the sentence. */
function claim(page: string, sentence: string): void {
  expect(
    flat(readFileSync(join(ROOT, page), 'utf8')),
    `${page} no longer says: ${sentence}`,
  ).toContain(flat(sentence));
}

const PAGE = 'docs/reference/mcp/gate-answers.md';

const YAML = [
  'id: docs627',
  'name: docs627',
  'version: 1',
  'steps:',
  '  q:',
  '    description: Ask.',
  '    execution: auto',
  '    trust: human_confirmed',
  '    gate:',
  '      choices: [approve, reject]',
  '  after:',
  '    description: After.',
  '    execution: agent',
  '    depends_on: [q]',
].join('\n');

async function session(gateAnswers?: 'asked' | 'offered' | 'withheld', forms = false) {
  const dir = await mkdtemp(join(tmpdir(), 'realm-docs-627-'));
  const runStore = new JsonFileStore(join(dir, 'runs'));
  const workflowStore = new JsonWorkflowStore(join(dir, 'wf'));
  const def = loadWorkflowFromString(YAML);
  await workflowStore.register(def);
  const server = createRealmMcpServer({
    runStore,
    workflowStore,
    ...(gateAnswers !== undefined ? { gateAnswers } : {}),
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: 'docs-627', version: '0' },
    forms ? { capabilities: { elicitation: { form: {} } } } : {},
  );
  await Promise.all([server.connect(st), client.connect(ct)]);
  await new Promise((r) => setTimeout(r, 20));
  const tools = async () => (await client.listTools()).tools;
  return { runStore, def, client, tools };
}

describe('#627 W — gate-answers.md, sentence by sentence', () => {
  it('the three values: what the agent gets, by tool name', async () => {
    claim(
      PAGE,
      '| `offered` | The answer tool, for any client of the server, the agent included. |',
    );
    claim(
      PAGE,
      "| `withheld` | No tool on the server records an answer, and its replies name no way to answer, except where a workflow's own text does, which Realm forwards labelled as the author's and warns about when the workflow is loaded. |",
    );
    // Correction 1 (F2): the exception is executed by door-627 :: "cell 27b — author text is
    // labelled, under every value" (the label) and w-627 :: "W-l1: a load note for author text that
    // names an answer tool" (the warning).
    claim(
      PAGE,
      // Correction 1 (F1): the row ends with the HTTP doors' sentence (http-door-627 executes it).
      "| `asked` | The default. In an app that shows forms, the question goes to the person in the app's own form, and the agent gets no tool that records an answer. In an app without forms, the agent keeps the answer tool, and the app is asked to have the person approve each call. On an HTTP server built per request — `realm serve`, or a program that builds a server per request or passes `statelessHttp` — no client gets forms: under `asked` every client keeps the answer tool, marked for approval. A program that keeps one server per HTTP session sends forms as stdio does. |",
    );
    const has = async (g: 'asked' | 'offered' | 'withheld' | undefined, forms: boolean) =>
      (await (await session(g, forms)).tools()).some((t) => t.name === 'submit_human_response');
    // (a) red when a value lists the answer tool against the page; (b) prints each.
    expect([
      await has(undefined, true),
      await has(undefined, false),
      await has('offered', true),
      await has('withheld', false),
    ]).toEqual([false, true, true, false]);
  });

  it('three ways to set it; the most restrictive wins; a bad value stops the server', () => {
    claim(
      PAGE,
      'There are three ways to set the value: the `--gate-answers` flag of `realm mcp` and `realm serve`, the `REALM_MCP_GATE_ANSWERS` environment variable, and the `gateAnswers` option of `createRealmMcpServer`. When more than one is set, the most restrictive value wins: `withheld`, then `asked`, then `offered`. A value that is not one of the three stops the server from starting.',
    );
    const r = judgeGateAnswers({ flag: 'offered', env: 'asked', option: 'withheld' });
    // (a) red when a less restrictive value wins, or a bad value starts; (b) prints the reading.
    expect({
      won: r.ok ? r.setting.value : 'bad',
      bad: readBinDoorSettings('mcp', { gateAnswers: 'nope' }, {}).ok,
    }).toEqual({ won: 'withheld', bad: false });
  });

  it('a variable exported in a shell may not reach a server the client starts (the SDK’s stdio spawn passes a reduced environment)', () => {
    // Correction 1 (F6): "may not" — only the TypeScript SDK's client is executed here; other
    // clients build their own environment.
    claim(
      PAGE,
      'Set the value in your MCP client\'s own config, as an argument (`"args": ["mcp", "--gate-answers", "withheld"]`) or in its `env` block. A variable you export in a shell may not reach a server your client starts (the MCP SDK\'s client starts servers with a reduced environment).',
    );
    process.env['REALM_MCP_GATE_ANSWERS'] = 'withheld';
    const passed = getDefaultEnvironment();
    delete process.env['REALM_MCP_GATE_ANSWERS'];
    // (a) red when the SDK's spawn starts passing the shell's variables; (b) prints whether it did.
    expect('REALM_MCP_GATE_ANSWERS' in passed).toBe(false);
  });

  it('the start lines name the value, and under withheld the person’s route', () => {
    claim(
      PAGE,
      '`realm mcp` and `realm serve` print the value they run with when they start. Under `withheld` they also print how a person answers from a terminal: `realm run inspect <run_id>`, then `realm run respond <run_id> --gate <gate_id> --choice <choice>`.',
    );
    const r = judgeGateAnswers({ flag: 'withheld' });
    const line = r.ok ? gateAnswersStartLine(r.setting, false) : '';
    // (a) red when the start line drops the route; (b) prints the line.
    expect(
      line.includes('realm run inspect <run_id>') &&
        line.includes('realm run respond <run_id> --gate <gate_id> --choice <choice>'),
    ).toBe(true);
  });

  it('another server or CLI on the same store can still record answers', async () => {
    claim(
      PAGE,
      'Another Realm server or CLI that uses the same store can still record answers. The value holds only for the server it is given to.',
    );
    const s = await session('withheld');
    const { run } = await s.runStore.create({
      workflowId: s.def.id,
      workflowVersion: 1,
      params: {},
    });
    await advanceRun(s.runStore, s.def, { runId: run.id });
    const gateId = (await s.runStore.get(run.id)).pending_gate!.gate_id;
    const reply = await submitHumanResponse(s.runStore, s.def, {
      runId: run.id,
      gateId,
      choice: 'approve',
      route: 'cli',
    });
    // (a) red when a withheld server's value reaches the store (the CLI refused); (b) prints the status.
    expect(reply.status).toBe('ok');
  });

  it('the form: sent on the first reach; one field; only an accepted choice records; the wait and its bounds; present_question’s cap', () => {
    claim(
      PAGE,
      'Under `asked`, in an app that shows forms, the question is sent to the user\'s app as a form the first time `start_run`, `execute_step` or `advance_run` reaches it. The form has one field, "Your answer", whose options are the question\'s choices. Only an accepted form holding one of those choices records an answer. A declined, cancelled or failed form records nothing, and the question keeps waiting.',
    );
    claim(
      PAGE,
      "Realm waits for the form itself. The wait ends at the question's deadline, or at the end of the call's own time: 240 seconds by default, counted from the start of the call. `--form-wait-seconds` (`REALM_MCP_FORM_WAIT_SECONDS`, the `formWaitSeconds` option) changes it, from 30 to 3600 seconds; when it is set in more than one place, the smallest value wins. `realm serve` sends no forms, and refuses the setting.",
    );
    claim(
      PAGE,
      "The tool `present_question` sends the form again. It is listed only in a session whose client shows forms, and it can send one question's form three more times in one server process.",
    );
    const w = judgeFormWait({ flag: '600', env: '120' });
    // (a) red when the default, the bounds, the smallest-wins rule, serve's refusal or the cap move;
    //     (b) prints each fact. (The form's field, its non-answers and the first send are executed in
    //     form-627.test.ts, cell 21.)
    expect({
      dflt: FORM_WAIT_SECONDS_DEFAULT,
      smallest: w.ok ? w.setting.seconds : 'bad',
      low: judgeFormWait({ flag: '29' }).ok,
      high: judgeFormWait({ flag: '3601' }).ok,
      serve: readBinDoorSettings('serve', { formWaitSeconds: '60' }, {}).ok,
      cap: FORM_ASKS_AFTER_FIRST,
    }).toEqual({ dflt: 240, smallest: 120, low: false, high: false, serve: false, cap: 3 });
  });

  it('the await entry and the fallback’s prompt: sentences pinned by door-627.test.ts’s executed cells', () => {
    claim(
      PAGE,
      "The agent never gets an answer call for such a question. Its reply's `next_actions` entry has `awaiting` instead of `instruction`: the question's run, gate, step and choices, with words that say whether a form was sent in this session.",
    );
    claim(
      PAGE,
      'In an app without forms, the answer tool carries `_meta["anthropic/requiresUserInteraction"]`, which asks the app to have the person approve each call.',
    );
    claim(
      PAGE,
      'Realm cannot see whether anyone approved. A headless client that declares forms but cancels them leaves the question waiting: set `offered` for such a client.',
    );
    // Correction 1 (F6): ":33"'s Claude Code sentence is an attributed, dated observation of another
    // program (walk-798, October 2026), which no cell here can run; the page says so in its words.
    claim(
      PAGE,
      'Some apps ask the person, some skip it (Claude Code asked in interactive sessions and refused the call in headless runs when this page was written, October 2026); other apps may not ask.',
    );
  });

  it('what an answer records, and the inspect line the page shows', () => {
    claim(
      PAGE,
      "| `answer` | `{ route, shown? }`: `mcp_form`, `mcp` or `cli`, as its door declared it; `{ absent: 'route_not_declared' }` from a program that declared none. |",
    );
    // Correction 1 (F6): ":42" is executed by answer-record-627 :: "`realm run respond` records route
    // cli …" (the entry's driven_by is the program that recorded it: respond, running as ops).
    claim(PAGE, '| `driven_by` | The program that recorded it. |');
    claim(
      PAGE,
      '| `client_prompt_requested` | `true` when the app was asked to have the person approve the call. |',
    );
    claim(
      PAGE,
      "| `principal` | Who the server's transport authenticated: an API key's id, `realm serve`'s shared token (which names no one), or why there is none. |",
    );
    claim(PAGE, 'An entry written by an earlier version reads `how it arrived was not recorded`.');
    const page = readFileSync(join(ROOT, PAGE), 'utf8');
    const example = page.split('\n').find((l) => l.startsWith('Answer: approve'));
    const line = renderAnswerLine(
      {
        choice: 'approve',
        answered_by: { by: null, absent_cause: 'not_stated' },
        claim_proof: { proof: 'absent' },
      },
      answerArrivalOf({
        answer: { route: 'mcp_form', shown: { renderer: 'realm-mcp-form/1' } },
        driven_by: { by: 'ops@server-1', by_source: 'derived', channel: 'mcp-stdio' },
      }),
    );
    // (a) red when the page's example is not what inspect prints for those facts; (b) prints both.
    expect({
      example,
      earlier: renderAnswerLine(
        { choice: 'x', answered_by: { by: null, absent_cause: 'not_stated' } },
        answerArrivalOf({}),
      ).includes('how it arrived was not recorded'),
    }).toEqual({
      example: line,
      earlier: true,
    });
  });

  it('the separation check: sentences pinned by separation-check-627.test.ts', () => {
    // Correction 1 (D2): executed by separation-check-627 :: "with su on the host the claim is may still".
    claim(
      PAGE,
      "On a host with `su` — every common system — the check cannot rule out becoming Realm's service user without a password, so it prints 'may still be able to answer'; the stronger sentence is reached where no such path exists, such as a container image without `su`.",
    );
    claim(
      PAGE,
      "`realm mcp --check` and `realm serve --check` print the value the server would start with and where it came from, then a separation check, and start nothing. Run it from the agent's own shell: it measures what that login can reach. With `HOME` set to the home of the user that runs Realm, it checks that user's store: a store this login cannot open is measured out of its reach, and one that is not found is not measured. The agent's own app settings are read from the login's own home, never from `HOME`.",
    );
    // Correction 1 (F6): ":56" is executed by separation-check-627 :: "correction 1 (D1): the mode is
    // never guessed" (the denied and the missing store) and :: "each condition line in its states"
    // (the agent's settings read from /home/agent while HOME holds the opposite).
    claim(
      PAGE,
      'The check says an agent cannot record a gate answer only when all of these hold: the store belongs to another user; this login cannot write or read the store, become that user without a password, reach the Docker engine, or change the files Realm executes; and `--gate-answers withheld` is given on the `--check` line itself.',
    );
    // Correction 1 (F6): ":58" and ":60" are executed by separation-check-627 :: "each prevents
    // conjunct alone takes the claim away" (every conjunct but reading) and :: "correction 1 (F6):
    // gate-answers.md :58 and :60" (reading the store; sudo's kept password; run0, pkexec, su), with
    // :: "condition 2" (doas) and :: "each condition line in its states" (NOPASSWD, by sudo -n; Touch
    // ID).
    claim(
      PAGE,
      'Each condition prints as measured, as configured but not enforced by Realm, or as unknown with its cause.',
    );
    claim(
      PAGE,
      'Becoming another user without a password includes `sudo` rules with `NOPASSWD`, a `timestamp_timeout` other than 0, and Touch ID for `sudo`; the check reads them where it can, and names `doas`, `run0`, `pkexec` and `su` as not probed when they are present.',
    );
  });
});

describe('#627 W — the other pages W changed', () => {
  it('tools.md (correction 1, C4): poll_after_ms rides an await entry, the opening confirm_required reply included', async () => {
    claim(
      'docs/reference/mcp/tools.md',
      'Whenever the reply carries an await entry — with `agent_action: "await"`, and on a `confirm_required` reply whose question this session cannot answer',
    );
    const s = await session('withheld');
    const opened = JSON.parse(
      (
        (await s.client.callTool({
          name: 'start_run',
          arguments: { workflow_id: s.def.id, params: {} },
        })) as { content: Array<{ text: string }> }
      ).content[0]!.text,
    ) as Record<string, unknown>;
    // (a) red when the opening reply under withheld carries no pace, or is not confirm_required;
    //     (b) prints the status and the pace's presence.
    expect({ status: opened['status'], paced: typeof opened['poll_after_ms'] }).toEqual({
      status: 'confirm_required',
      paced: 'number',
    });
  });

  it('gates-and-trust.md, connect-an-mcp-client.md, human-gates.md, what-is-realm.md: who can answer follows the value', async () => {
    claim(
      'docs/concepts/gates-and-trust.md',
      'Under `offered` the assistant has `submit_human_response`, and nothing stops it from answering on its own. Under `withheld` no tool on the server records an answer.',
    );
    claim(
      'docs/concepts/gates-and-trust.md',
      'start the MCP server with `--gate-answers withheld` and answer from the command line',
    );
    claim(
      'docs/guides/connect-an-mcp-client.md',
      'Under the default `asked`, an app that shows forms asks you in its own form, and the assistant gets no tool that records an answer.',
    );
    claim(
      'docs/guides/human-gates.md',
      'Under `withheld`, or in an app that shows forms, the refusal names no answer, and `next_actions` holds the await entry instead of the answer call',
    );
    claim(
      'docs/start/what-is-realm.md',
      'That is a session whose assistant has the answer tool. Under `withheld`, or in an app that shows forms, the refusal names no answer',
    );
    /** A step waiting on the open question, called by name: the refusal's answer words and entry. */
    const refusalAt = async (g: 'asked' | 'offered' | 'withheld', forms: boolean) => {
      const s = await session(g, forms);
      const text = async (name: string, args: Record<string, unknown>) =>
        JSON.parse(
          (
            (await s.client.callTool({ name, arguments: args })) as {
              content: Array<{ text: string }>;
            }
          ).content[0]!.text,
        ) as Record<string, unknown>;
      const started = await text('start_run', { workflow_id: s.def.id, params: {} });
      const r = await text('execute_step', {
        run_id: started['run_id'],
        command: 'after',
        params: {},
      });
      const first = (r['next_actions'] as Array<{ instruction: unknown; awaiting?: unknown }>)[0];
      return {
        tools: (await s.tools())
          .map((t) => t.name)
          .filter((n) => n === 'submit_human_response' || n === 'present_question'),
        namesAnswer: String(r['context_hint']).includes('submit_human_response'),
        firstEntry: first?.awaiting !== undefined ? 'await' : 'call',
      };
    };
    // (a) red when a session lists an answer tool against these pages, or a refusal names the
    //     answer where no tool records one; (b) prints each session's tools and refusal.
    expect({
      withheld: await refusalAt('withheld', false),
      forms: await refusalAt('asked', true),
      fallback: await refusalAt('asked', false),
      offered: await refusalAt('offered', false),
    }).toEqual({
      withheld: { tools: [], namesAnswer: false, firstEntry: 'await' },
      forms: { tools: ['present_question'], namesAnswer: false, firstEntry: 'await' },
      fallback: { tools: ['submit_human_response'], namesAnswer: true, firstEntry: 'call' },
      offered: { tools: ['submit_human_response'], namesAnswer: true, firstEntry: 'call' },
    });
  });

  it('tools.md: the gate example is the default session’s; error_details names the new typed facts', () => {
    claim(
      'docs/reference/mcp/tools.md',
      'This reply came from a server with the default gate-answers value, `asked`, in a session whose client shows no forms: the entry ends with the approval sentence.',
    );
    claim(
      'docs/reference/mcp/tools.md',
      'a registered workflow a later version of Realm wrote: `STATE_NEWER_FORMAT`, added after version 0.47.0',
    );
  });

  it('run-state-and-health.md and the MCP README: the read’s session; one answer tool per session (the README’s list is checked against the server by docs-sweep-625)', () => {
    claim(
      'docs/reference/mcp/run-state-and-health.md',
      'This read came from a server with the default gate-answers value, `asked`, in a session whose client shows no forms.',
    );
    claim(
      'packages/mcp-server/README.md',
      "under `asked` in a session whose client shows forms, `present_question` takes its place and sends the waiting question to the user's app as a form",
    );
  });

  it('top-level-fields.md: rule 2’s variants by value', () => {
    claim(
      'docs/reference/workflow/top-level-fields.md',
      'Under `withheld`, and under `asked` with a client that shows forms, it reads: "When you receive status \'confirm_required\', read gate.agent_hint, present gate.display to the user verbatim, and follow next_actions: the question is answered outside this conversation."',
    );
  });

  it('error-codes.md and run-record-and-export.md: the new code and the three evidence rows', () => {
    claim(
      'docs/reference/error-codes.md',
      'A registered workflow was written by a later version of Realm, in a definition format above the one this version reads, so this version refuses it instead of ignoring requirements it cannot read.',
    );
    claim(
      'docs/reference/run-record-and-export.md',
      '| `client_prompt_requested` | boolean | No | On a gate answer: `true` when the door asked the client to have the person approve the call. Added after version 0.47.0. |',
    );
  });

  it('realm-mcp-and-serve.md and connect-an-mcp-client.md: the flags, the start line, the tool list', () => {
    claim(
      'docs/reference/cli/realm-mcp-and-serve.md',
      'When it starts, `realm mcp` prints one line to standard error: the gate-answers value it runs with, where it came from, and what that means (added after version 0.47.0, which printed nothing).',
    );
    claim(
      'docs/reference/cli/realm-mcp-and-serve.md',
      '`realm serve` sends no forms, so `--form-wait-seconds`, or `REALM_MCP_FORM_WAIT_SECONDS`, stops it from starting. Added after version 0.47.0.',
    );
    claim(
      'docs/guides/connect-an-mcp-client.md',
      // Correction 2 (6.5): "may not reach", with the reason — as gate-answers.md :17 (correction 1, F6).
      "Set it here, or in the entry's `env` block as `REALM_MCP_GATE_ANSWERS`: a variable you export in a shell may not reach a server the assistant starts (the MCP SDK's client starts servers with a reduced environment).",
    );
  });

  it('realm-run-reading.md and human-gates.md: the question line and the respond line (cell 13 executes them)', () => {
    claim(
      'docs/reference/cli/realm-run-reading.md',
      "The `Question:` line is the gate's message as it read when the gate opened — never the workflow's current text.",
    );
    claim(
      'docs/guides/human-gates.md',
      "`realm run inspect <run-id>` shows the gate's ID, its question as the person reads it, its choices and the command that answers it",
    );
  });
});

describe('#627 W correction 1 — the claims F asks for', () => {
  const F1 =
    'On an HTTP server built per request — `realm serve`, or a program that builds a server per request or passes `statelessHttp` — no client gets forms: under `asked` every client keeps the answer tool, marked for approval. A program that keeps one server per HTTP session sends forms as stdio does.';

  it('F1: the HTTP doors, on the four pages (executed by realm-mcp’s http-door-627.test.ts over real HTTP)', () => {
    // (a) red when a page drops or rewords the sentence; (b) prints it. Its behaviour: http-door-627
    // :: "a server built per request …" and :: "a server kept per HTTP session …".
    for (const page of [
      'CHANGELOG.md',
      PAGE,
      'docs/concepts/gates-and-trust.md',
      'docs/guides/human-gates.md',
    ]) {
      claim(page, F1);
    }
    // The README's options row: `statelessHttp` by http-door-627, `principal` by principal-627 (cell
    // 25 through the real doors), the two values by w-627's judged-once cells.
    claim(
      'packages/mcp-server/README.md',
      '`gateAnswers?` (`asked`, `offered` or `withheld`), `formWaitSeconds?`, `principal?` (what the transport authenticated, stamped on every answer), `statelessHttp?` (pass `true` when a server is built per HTTP request: no form can be held open)',
    );
  });

  it('F4: tools.md :46 and :105 — advance_run at a question under withheld: ok, agent_action await, the await entry; with the answer tool, the answer', async () => {
    claim(
      'docs/reference/mcp/tools.md',
      'as `await` (a step in flight elsewhere, or a question handed to the person)',
    );
    claim(
      'docs/reference/mcp/tools.md',
      'Follow `next_actions`; an open question is named there by its answer where this session has the answer tool; else by the await entry.',
    );
    const stateAt = async (g: 'withheld' | 'offered') => {
      const s = await session(g);
      const call = async (name: string, args: Record<string, unknown>) =>
        JSON.parse(
          (
            (await s.client.callTool({ name, arguments: args })) as {
              content: Array<{ text: string }>;
            }
          ).content[0]!.text,
        ) as Record<string, unknown>;
      const started = await call('start_run', { workflow_id: s.def.id, params: {} });
      const state = await call('advance_run', { run_id: started['run_id'] });
      const first = (
        state['next_actions'] as Array<{ awaiting?: unknown; instruction?: { tool?: unknown } }>
      )[0];
      return {
        status: state['status'],
        action: state['agent_action'],
        first: first?.awaiting !== undefined ? 'await' : first?.instruction?.tool,
      };
    };
    // (a) red when a question handed to the person does not read as await, or the answer tool's
    //     session is not named the answer; (b) prints each reply's status, action and first entry.
    expect({ withheld: await stateAt('withheld'), offered: await stateAt('offered') }).toEqual({
      withheld: { status: 'ok', action: 'await', first: 'await' },
      offered: { status: 'ok', action: undefined, first: 'submit_human_response' },
    });
  });

  it('F6: realm-mcp-and-serve.md — a bad value stops realm mcp with one line and exit 1; serve’s start line and dev-mode warning (gate-answers-door-627 cell 19)', () => {
    claim(
      'docs/reference/cli/realm-mcp-and-serve.md',
      'A gate-answers or form-wait value that is not valid stops it before it starts, with one line on standard error and exit code 1.',
    );
    // Executed by gate-answers-door-627 :: "cell 19 — dev mode warns …" (the value line, and the
    // warning iff not withheld); the order is serve.ts's (the listening lines, then these).
    claim(
      'docs/reference/cli/realm-mcp-and-serve.md',
      "After these lines, `realm serve` prints the gate-answers value it runs with, and, in dev mode when that value is not `withheld`, `Warning: dev mode — authentication is disabled: any process on this machine can call this server's tools, the gate answer tool included.` (added after version 0.47.0).",
    );
    const CLI = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
    const mcp = (args: string[]) => {
      const r = spawnSync(process.execPath, [CLI, 'mcp', ...args], {
        env: {
          PATH: process.env['PATH'] ?? '',
          HOME: mkdtempSync(join(tmpdir(), 'realm-docs-627-mcp-')),
        },
        input: '',
        encoding: 'utf8',
        timeout: 60_000,
      });
      return { code: r.status, lines: r.stderr.trim().split('\n').length, out: r.stdout };
    };
    // (a) red when a bad value starts the server, exits 0, or prints more than one line; (b) prints
    //     the exit code, the count of stderr lines and stdout.
    expect({
      answers: mcp(['--gate-answers', 'nope']),
      wait: mcp(['--form-wait-seconds', '10']),
    }).toEqual({
      answers: { code: 1, lines: 1, out: '' },
      wait: { code: 1, lines: 1, out: '' },
    });
  }, 60_000);

  it('F5, F6: realm-run-reading.md — the To answer: line, the answer line, the token row (answer-record-627 executes each)', () => {
    const READING = 'docs/reference/cli/realm-run-reading.md';
    // Executed by answer-record-627 :: "cell 13: … the frozen question and the respond line".
    claim(READING, 'The `To answer:` line is printed while the question can be answered here.');
    // Executed by answer-record-627 :: "one phrase per route (W-i10)", :: "the absences (W-i2, W-i3,
    // W-i7)" — F5: the program part reads "did not name itself" when driven_by is ABSENT — and
    // :: "cell 25 — the principal by kind (W-i8) …; the client prompt (W-i5)".
    claim(
      READING,
      "Then the line says how the answer arrived, as its door declared it — `through the user's app, as a form`, `through Realm's MCP answer tool` or `through a terminal (realm run respond)`, each followed by `(as its door declared)` — and the program that recorded it: its channel, the name it runs as, and how that name is known. An answer from a program that declared no route reads `through a route its program did not declare`; one from a program that did not name itself reads `as recorded by a program that did not name itself`; an answer recorded by an earlier version, or with no route, reads `how it arrived was not recorded`.",
    );
    claim(
      READING,
      "When the server's transport authenticated someone, the line adds `authenticated by API key <id>`, `through realm serve's shared token, which names no one`, or `with authentication turned off (dev mode)`; when the app was asked to have the person approve the call, `client prompt requested (anthropic/requiresUserInteraction); Realm cannot tell whether anyone approved`.",
    );
    // Executed by answer-record-627 :: "`realm run respond` records route cli …" (no token passed).
    claim(
      READING,
      "| `none passed (a token is passed only by Realm's MCP answer tool, from the conversation that opened the question, or by a program that calls the library with it)` | No token was passed, over either door. |",
    );
  });

  it('F6: gates-and-trust.md — the five places, what the record keeps, the asked sentence', () => {
    const TRUST = 'docs/concepts/gates-and-trust.md';
    claim(
      TRUST,
      'A gate is answered by one call that names the run, the gate and the choice. There are five places it can come from:',
    );
    claim(
      TRUST,
      '- the form a chat app shows the person, on an MCP server whose gate-answers value is `asked`, the default (added after version 0.47.0);',
    );
    // "records the choice and how it arrived": answer-record-627 :: "`realm run respond` records
    // route cli …" and form-627 cell 21 (route mcp_form). The asked sentence: this file's "who can
    // answer follows the value" (the tools per session) and door-627's fallback _meta cell.
    claim(TRUST, 'It records the choice and how it arrived.');
    claim(
      TRUST,
      'Under the default `asked`, an app that shows forms asks the person in its own form, and the assistant gets no tool that records an answer; an app that shows no forms keeps `submit_human_response`, and the app is asked to have the person approve each call.',
    );
    const text = flat(readFileSync(join(ROOT, TRUST), 'utf8'));
    const list = text
      .slice(text.indexOf('There are five places it can come from:'))
      .split(' **Realm does not check who answers.**')[0]!;
    // (a) red when the list and its count part; (b) prints the count of the list's items.
    expect(list.split(' - ').length - 1).toBe(5);
  });

  it('F6: connect-an-mcp-client.md and human-gates.md — the tool in each session; the terminal route; the form', () => {
    // Executed by this file's "who can answer follows the value" (present_question in a forms
    // session, neither tool under withheld) and its "the start lines" cell (the terminal route).
    claim(
      'docs/guides/connect-an-mcp-client.md',
      'In an app that shows forms, under the default `asked`, `present_question` takes the place of `submit_human_response`; under `withheld` neither is listed (added after version 0.47.0).',
    );
    claim(
      'docs/guides/connect-an-mcp-client.md',
      '- Under `withheld`, you answer from a terminal: `realm run inspect <run_id>`, then `realm run respond <run_id> --gate <gate_id> --choice <choice>`.',
    );
    // Executed by form-627 cell 21 (the form, and its answer recorded) and this file's "who can
    // answer follows the value" (no tool under withheld).
    claim(
      'docs/guides/human-gates.md',
      'Under the default, `asked`, a chat app that shows forms gets the question as a form, and the person answers there; under `withheld`, no tool answers.',
    );
  });

  it('correction 2 (4.1, 4.5): the MCP README’s realm-mcp sentence (realm-mcp’s cells execute it)', () => {
    // Executed by door-627 :: "(A4) — `realm-mcp --gate-answers withheld` refuses the start" (no
    // flags, any refused) and :: "correction 2 (4.1) — realm-mcp judges its variables …" (both
    // variables judged; the start line on stderr).
    claim(
      'packages/mcp-server/README.md',
      '`realm-mcp` takes no flags and refuses any: set the gate-answers value, or the form wait, in the entry\'s `env` block (`"env": { "REALM_MCP_GATE_ANSWERS": "withheld" }`, `REALM_MCP_FORM_WAIT_SECONDS`), or run `realm mcp --gate-answers <value>`. It judges both variables before it starts, and prints its start line on stderr.',
    );
  });

  it('F7: the CHANGELOG’s upgrade sentence for a store shared with 0.47.0 (skew-627 cell 6(b) pins the residual)', () => {
    claim(
      'CHANGELOG.md',
      "A store shared with version 0.47.0: its `realm run advance` prints the program that recorded an answer as the run's `Last recorded driver:`, because this version stamps `driven_by` on answers and 0.47.0 does not skip them; 0.46.0 is unaffected.",
    );
  });
});

describe('#627 W — the CHANGELOG’s lines are under their headings (Part L)', () => {
  it('BREAKING and Changed under Changed; the new parts under Added; none under Fixed', () => {
    const text = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
    const unreleased = text.slice(
      text.indexOf('## [Unreleased]'),
      text.indexOf('\n## [', text.indexOf('## [Unreleased]') + 5),
    );
    const section = (h: string) => {
      const start = unreleased.indexOf(`### ${h}`);
      const end = unreleased.indexOf('\n### ', start + 4);
      return unreleased.slice(start, end === -1 ? undefined : end);
    };
    const w = (part: string) =>
      part
        .split('\n- ')
        .filter((b) => b.includes('(issue #627)'))
        .map((b) => b.split('**')[1]);
    // (a) red when a bullet sits under the wrong heading; (b) prints each heading's #627 bullets.
    expect({
      added: w(section('Added')),
      changed: w(section('Changed')),
      fixed: w(section('Fixed')),
    }).toEqual({
      added: [
        'How the MCP door handles gate answers is one setting (issue #627).',
        'Questions go to the person as a form in the chat app (issue #627).',
        '`realm mcp --check` and `realm serve --check` (issue #627).',
        'The `initialize` result names the gate-answers value (issue #627).',
        'Each answer records how it arrived (issue #627).',
        'A load note for author text that names an answer tool (issue #627).',
        'A code for a workflow a later Realm registered (issue #627).',
      ],
      changed: [
        "BREAKING — the MCP door's default is `asked` (issue #627).",
        "BREAKING — the published reply types gain W's members (issue #627).",
        'The loader and the registry refuse what this version cannot hold (issue #627).',
        'Every MCP tool carries annotations and a title (issue #627).',
        "The protocol says what the session's way means (issue #627).",
        "Author text is labelled as the author's (issue #627).",
        "`realm run inspect`'s answer line (issue #627).",
      ],
      fixed: [],
    });
  });
});
