// gate-answers-default.test.ts — the gate-answers default (2026-11-14), the library's half: by default
// no agent gets a tool that records a gate answer through Realm's MCP server, in any app.
//
// - AC1: `asked` in a stdio session whose client shows no forms lists, replies, briefs and describes
//   `abandon_run` exactly as `withheld` does, but for the await entry's one sentence naming where a
//   person answers (PR #1167 correction 1, item 10).
// - AC2: so does `asked` on a server built per HTTP request, with `statelessHttp` and without it.
// - AC3 (library half): `offered`, given as the option, the flag or the variable, is `permitted`: the
//   agent's answer is recorded, and the value reads back as `permitted` in `effectiveGateAnswers()`
//   and the `realm/gate_answers` capability; `alsoSet` quotes another source as written, and
//   `offered` ranks as `permitted`. (The ranking of the three values is core's w-627 cell.) The
//   option given as `offered` raises no REALM-D001: the library prints nothing (correction 1, item 11).
// - Correction 1, item 10: the await entry under `asked` without forms names the place a person
//   answers; `withheld`'s entry is unchanged, byte for byte.
// - AC6 (library half): `onSessionWithoutForms` is called once for an `asked` session without forms,
//   never with forms or under `permitted` or `withheld`, and the library alone prints nothing.
//
// Every server here is built on in-memory transports, or on localhost HTTP, in one process. Every
// assertion carries (a) the change that turns it red and (b) what it prints on failure: tools,
// replies, protocol rules, values — never a token.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { judgeGateAnswers, loadWorkflowFromString, saidIds } from '@sensigo/realm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createRealmMcpServer } from './server.js';
import { effectiveGateAnswers } from './door.js';
import { makeTempHome, type ServerExtras, type TempHome } from './test-support/temp-home.js';

type Reply = Record<string, unknown>;

const YAML = [
  'id: gad',
  'name: gad',
  'version: 1',
  'steps:',
  '  q:',
  '    description: Ask.',
  '    execution: auto',
  '    trust: human_confirmed',
  '    instructions: Show the draft.',
  '    gate:',
  '      choices: [approve, reject]',
  '      message: Ship it?',
  '  after:',
  '    description: After.',
  '    execution: agent',
  '    instructions: Write the note.',
  '    depends_on: [q]',
].join('\n');

const handles: TempHome[] = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
  for (const h of handles.splice(0).reverse()) await h.cleanup();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** What a session gives: its tools as listed, a gate's reply, the protocol, abandon's description. */
interface Seen {
  tools: unknown[];
  reply: Reply;
  protocol: Reply;
  abandon: string | undefined;
}

/** A client on `connect`'s transport: what it is listed, and what one run to its gate replies. */
async function seenBy(client: Client): Promise<Seen> {
  const call = async (name: string, args: Reply): Promise<Reply> =>
    JSON.parse(
      (
        (await client.callTool({ name, arguments: args }, undefined, { timeout: 60_000 })) as {
          content: Array<{ text: string }>;
        }
      ).content[0]!.text,
    ) as Reply;
  const tools = (await client.listTools()).tools;
  const started = await call('start_run', { workflow_id: 'gad', params: {} });
  const runId = String(started['run_id']);
  const gateId = String((started['gate'] as Reply | undefined)?.['gate_id'] ?? '');
  // The run and gate ids and the instants are each run's own; everything else must match word for
  // word.
  const same = (v: unknown): Reply =>
    JSON.parse(
      JSON.stringify(v)
        .split(runId)
        .join('<run>')
        .split(gateId.length > 0 ? gateId : '\u0000')
        .join('<gate>')
        .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g, '<instant>'),
    ) as Reply;
  return {
    tools: [...tools].sort((a, b) => a.name.localeCompare(b.name)),
    reply: same(started),
    protocol: await call('get_workflow_protocol', { workflow_id: 'gad' }),
    abandon: tools.find((t) => t.name === 'abandon_run')?.description,
  };
}

/** The await entry's sentence under `asked` without forms (correction 1, item 10). */
const PLACE = ' A person answers it in a terminal on the computer that runs the Realm server.';

/**
 * Correction 1 (item 10): `asked` without forms is withheld's row but for one sentence — the session's
 * four parts with that sentence taken out of the reply, and how many times it was there.
 */
function withoutPlace(seen: Seen): { seen: Seen; placed: number } {
  const text = JSON.stringify(seen.reply);
  return {
    seen: { ...seen, reply: JSON.parse(text.split(PLACE).join('')) as Reply },
    placed: text.split(PLACE).length - 1,
  };
}

/** A stdio-shaped session (in-memory transports) on a fresh home: a client with forms or without. */
async function stdioSession(options: ServerExtras, forms = false) {
  const h = await makeTempHome();
  handles.push(h);
  await h.stores.workflowStore.register(loadWorkflowFromString(YAML));
  const server = createRealmMcpServer({ ...h.stores, ...options });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: 'gad', version: '0' },
    forms ? { capabilities: { elicitation: { form: {} } } } : {},
  );
  if (forms) client.setRequestHandler(ElicitRequestSchema, async () => ({ action: 'decline' }));
  await Promise.all([server.connect(st), client.connect(ct)]);
  // A notification sent at `initialize` lands after the connect returns.
  await new Promise((r) => setTimeout(r, 20));
  closers.push(async () => {
    await client.close().catch(() => undefined);
  });
  return { client, runStore: h.stores.runStore };
}

async function bodyOf(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw.length > 0 ? JSON.parse(raw) : undefined;
}

/**
 * A server built per HTTP request on localhost — `realm serve`'s shape — with `statelessHttp` passed
 * or not, and a client that declares forms (the HTTP door sends none either way).
 */
async function perRequestSession(options: ServerExtras, statelessHttp: boolean) {
  const h = await makeTempHome();
  handles.push(h);
  await h.stores.workflowStore.register(loadWorkflowFromString(YAML));
  const http = createServer((req, res) => {
    void (async () => {
      const body = await bodyOf(req);
      const transport = new StreamableHTTPServerTransport({});
      await createRealmMcpServer({
        ...h.stores,
        ...options,
        ...(statelessHttp ? { statelessHttp } : {}),
      }).connect(transport as unknown as Transport);
      await transport.handleRequest(req, res, body);
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address() as AddressInfo;
  const client = new Client(
    { name: 'gad-http', version: '0' },
    { capabilities: { elicitation: { form: {} } } },
  );
  client.setRequestHandler(ElicitRequestSchema, async () => ({ action: 'decline' }));
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)) as Transport,
  );
  await new Promise((r) => setTimeout(r, 50));
  closers.push(async () => {
    await client.close().catch(() => undefined);
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });
  return { client, runStore: h.stores.runStore };
}

describe('the gate-answers default — asked without forms is withheld’s row (AC1, AC2)', () => {
  it('AC1 — stdio, a client that shows no forms: tools/list, a gate’s reply, the protocol and abandon_run’s description equal withheld’s', async () => {
    const asked = await seenBy((await stdioSession({})).client);
    const withheld = await seenBy((await stdioSession({ gateAnswers: 'withheld' })).client);
    // (a) red when the fallback row is kept: the answer tool listed (with its approval mark), the
    //     answer call in the reply, the approval sentence in the protocol, or today's abandon text;
    //     or when the await entry's place sentence is missing or repeated (correction 1, item 10);
    //     (b) prints the asked session's four parts, its sentence taken out, against withheld's.
    expect(withoutPlace(asked)).toEqual({ seen: withheld, placed: 1 });
    // Grounding for the comparison: withheld's own parts are the no-answer-tool ones.
    expect({
      answerTool: (withheld.tools as Array<{ name: string }>).some(
        (t) => t.name === 'submit_human_response',
      ),
      awaiting: JSON.stringify(withheld.reply['next_actions']).includes('"awaiting"'),
    }).toEqual({ answerTool: false, awaiting: true });
  }, 60_000);

  it.each([
    ['with statelessHttp (realm serve passes it)', true],
    ['without statelessHttp', false],
  ] as const)(
    'AC2 — a server built per HTTP request, %s: the same four parts equal withheld’s',
    async (_label, statelessHttp) => {
      const asked = await seenBy((await perRequestSession({}, statelessHttp)).client);
      const withheld = await seenBy(
        (await perRequestSession({ gateAnswers: 'withheld' }, statelessHttp)).client,
      );
      // (a) red when the HTTP door keeps the answer tool under asked (its sessions never show forms),
      //     or its await entry lacks the place sentence (correction 1, item 10); (b) prints the asked
      //     door's four parts, its sentence taken out, against withheld's.
      expect(withoutPlace(asked)).toEqual({ seen: withheld, placed: 1 });
    },
    60_000,
  );
});

describe('the gate-answers default — the await entry names where a person answers (correction 1, item 10)', () => {
  /** The await entry's words in start_run's reply, run id masked. */
  const awaitWords = (seen: Seen): unknown =>
    (seen.reply['next_actions'] as Array<Reply>)
      .filter((a) => a['awaiting'] !== undefined)
      .map((a) => a['human_readable']);
  const WITHHELD_WORDS =
    "The question on step 'q' of run <run> is answered outside this conversation. Show the user gate.display and tell them it is waiting for their answer; an answer they give here is not recorded. Give the user this run id (<run>); they may need it to answer. Check again no sooner than poll_after_ms.";

  it('asked, a client that shows no forms: the entry says a person answers in a terminal on the computer that runs the Realm server', async () => {
    const asked = await seenBy((await stdioSession({})).client);
    // (a) red when the sentence is not added under asked (the owner's (a), c9e89f1a), or names the
    //     command; (b) prints the entry's words.
    expect(awaitWords(asked)).toEqual([
      "The question on step 'q' of run <run> is answered outside this conversation. A person answers it in a terminal on the computer that runs the Realm server. Show the user gate.display and tell them it is waiting for their answer; an answer they give here is not recorded. Give the user this run id (<run>); they may need it to answer. Check again no sooner than poll_after_ms.",
    ]);
  }, 60_000);

  it('withheld: the entry is unchanged, byte for byte — no place named', async () => {
    const withheld = await seenBy((await stdioSession({ gateAnswers: 'withheld' })).client);
    // (a) red when the sentence is added under withheld too; (b) prints the entry's words.
    expect(awaitWords(withheld)).toEqual([WITHHELD_WORDS]);
  }, 60_000);
});

describe('the gate-answers default — offered is permitted (AC3, library half)', () => {
  it.each([
    ['the option', { gateAnswers: 'offered' } as ServerExtras, undefined],
    ['the flag', { gateAnswersFlag: 'offered' } as ServerExtras, undefined],
    ['the variable', {} as ServerExtras, 'offered'],
  ] as const)(
    'offered given as %s: the agent’s answer is recorded, and the capability and effectiveGateAnswers() read permitted',
    async (_label, options, env) => {
      if (env !== undefined) vi.stubEnv('REALM_MCP_GATE_ANSWERS', env);
      const s = await stdioSession(options);
      const call = async (name: string, args: Reply): Promise<Reply> =>
        JSON.parse(
          (
            (await s.client.callTool({ name, arguments: args })) as {
              content: Array<{ text: string }>;
            }
          ).content[0]!.text,
        ) as Reply;
      const started = await call('start_run', { workflow_id: 'gad', params: {} });
      const runId = String(started['run_id']);
      const gateId = String((started['gate'] as Reply)['gate_id']);
      await call('submit_human_response', { run_id: runId, gate_id: gateId, choice: 'approve' });
      const entry = (await s.runStore.get(runId)).record.evidence.find(
        (e) => e.kind === 'gate_response',
      );
      // (a) red when offered is refused (no server, or no answer tool), or reads back as offered;
      //     (b) prints the recorded route, the capability and the library's reading.
      expect({
        recorded: (entry?.answer as { route?: unknown } | undefined)?.route,
        capability: s.client.getServerCapabilities()?.experimental?.['realm/gate_answers'],
        effective: effectiveGateAnswers(options).value,
      }).toEqual({
        recorded: 'mcp',
        capability: {
          value: 'permitted',
          source_kind:
            'gateAnswers' in options ? 'option' : 'gateAnswersFlag' in options ? 'flag' : 'env',
        },
        effective: 'permitted',
      });
    },
    60_000,
  );

  it('the option given as offered raises no deprecation: the library prints nothing (correction 1, item 11)', async () => {
    const stderr = vi.spyOn(process.stderr, 'write');
    const consoleError = vi.spyOn(console, 'error');
    await stdioSession({ gateAnswers: 'offered' });
    const written = [...stderr.mock.calls, ...consoleError.mock.calls].map((c) => String(c[0]));
    // (a) red when the library raises REALM-D001 for its option (its TSDoc is the option's notice);
    //     (b) prints the lines written and whether the id was recorded as said.
    expect({
      lines: written.filter((l) => l.includes('REALM-D001') || l.includes('offered')),
      said: saidIds().includes('REALM-D001'),
    }).toEqual({ lines: [], said: false });
  }, 60_000);

  it('alsoSet quotes another source as written; offeredFrom names each source that gave offered; offered ranks as permitted', () => {
    const win = (input: Parameters<typeof judgeGateAnswers>[0]) => {
      const r = judgeGateAnswers(input);
      return r.ok ? `${r.setting.value} from ${r.setting.source.kind}` : `refused ${r.kind}`;
    };
    // (a) red when an old name is rewritten in alsoSet, or not named in offeredFrom, or offered ranks
    //     other than permitted (above asked; or below permitted, so the tie leaves the more direct
    //     source); (b) prints the readings and each pair's winner.
    expect({
      oldName: [
        win({ flag: 'offered', env: 'asked' }),
        win({ env: 'offered', option: 'permitted' }),
      ],
      both: effectiveGateAnswers({ gateAnswers: 'offered' }, { REALM_MCP_GATE_ANSWERS: 'asked' }),
      flagAndOption: effectiveGateAnswers(
        { gateAnswers: 'offered', gateAnswersFlag: 'offered' },
        {},
      ),
    }).toEqual({
      oldName: ['asked from env', 'permitted from env'],
      both: {
        value: 'asked',
        source: { kind: 'env', ref: 'REALM_MCP_GATE_ANSWERS' },
        alsoSet: [
          {
            source: {
              kind: 'option',
              ref: 'the program that started this server (gateAnswers option)',
            },
            value: 'offered',
          },
        ],
        offeredFrom: [
          { kind: 'option', ref: 'the program that started this server (gateAnswers option)' },
        ],
      },
      flagAndOption: {
        value: 'permitted',
        source: { kind: 'flag', ref: '--gate-answers' },
        alsoSet: [
          {
            source: {
              kind: 'option',
              ref: 'the program that started this server (gateAnswers option)',
            },
            value: 'offered',
          },
        ],
        offeredFrom: [
          { kind: 'flag', ref: '--gate-answers' },
          { kind: 'option', ref: 'the program that started this server (gateAnswers option)' },
        ],
      },
    });
  });
});

describe('the gate-answers default — the library tells a program about a session without forms (AC6, library half)', () => {
  it('onSessionWithoutForms: once for asked without forms; never with forms, under permitted or withheld; the library alone prints nothing', async () => {
    const stderr = vi.spyOn(process.stderr, 'write');
    const consoleError = vi.spyOn(console, 'error');
    const calls = async (options: ServerExtras, forms: boolean) => {
      let n = 0;
      await stdioSession({ ...options, onSessionWithoutForms: () => n++ }, forms);
      return n;
    };
    const counts = {
      askedNoForms: await calls({}, false),
      askedForms: await calls({}, true),
      permitted: await calls({ gateAnswers: 'permitted' }, false),
      withheld: await calls({ gateAnswers: 'withheld' }, false),
    };
    const written = stderr.mock.calls.length + consoleError.mock.calls.length;
    // Without the option, an asked session without forms prints nothing from the library.
    await stdioSession({}, false);
    const writtenAfter = stderr.mock.calls.length + consoleError.mock.calls.length;
    // (a) red when the call is missing, made with forms or under permitted or withheld, or the
    //     library prints a line of its own; (b) prints each count and the lines written.
    expect({ counts, libraryPrinted: writtenAfter - written }).toEqual({
      counts: { askedNoForms: 1, askedForms: 0, permitted: 0, withheld: 0 },
      libraryPrinted: 0,
    });
  }, 60_000);
});
