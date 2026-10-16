// docs-627.test.ts — #627 W, Part L: every sentence W adds to the docs, each held to what the build
// does (the #625 docs-claims pattern; guardrail 7(f)), and the CHANGELOG's lines under their headings.
// A claim is checked word for word; its behaviour is executed here, on the built packages.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure: the
// sentence, the tool names, the texts — never a token or an environment.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
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
      '| `withheld` | No tool on the server records an answer, and its replies name no way to answer. |',
    );
    claim(
      PAGE,
      "| `asked` | The default. In an app that shows forms, the question goes to the person in the app's own form, and the agent gets no tool that records an answer. In an app without forms, the agent keeps the answer tool, and the app is asked to have the person approve each call. |",
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

  it('a variable exported in a shell does not reach a server the client starts (the SDK’s stdio spawn passes a whitelisted environment)', () => {
    claim(
      PAGE,
      'Set the value in your MCP client\'s own config, as an argument (`"args": ["mcp", "--gate-answers", "withheld"]`) or in its `env` block. A variable you export in a shell does not reach a server your client starts.',
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
  });

  it('what an answer records, and the inspect line the page shows', () => {
    claim(
      PAGE,
      "| `answer` | `{ route, shown? }`: `mcp_form`, `mcp` or `cli`, as its door declared it; `{ absent: 'route_not_declared' }` from a program that declared none. |",
    );
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
    claim(
      PAGE,
      "`realm mcp --check` and `realm serve --check` print the value the server would start with and where it came from, then a separation check, and start nothing. Run it from the agent's own shell: it measures what that login can reach. With `HOME` set to the home of the user that runs Realm, it reads that user's store.",
    );
    claim(
      PAGE,
      'The check says an agent cannot record a gate answer only when all of these hold: the store belongs to another user; this login cannot write the store, become that user without a password, reach the Docker engine, or change the files Realm executes; and `--gate-answers withheld` is given on the `--check` line itself.',
    );
  });
});

describe('#627 W — the other pages W changed', () => {
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
      "Set it here, or in the entry's `env` block as `REALM_MCP_GATE_ANSWERS`: a variable you export in a shell does not reach a server the assistant starts.",
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
