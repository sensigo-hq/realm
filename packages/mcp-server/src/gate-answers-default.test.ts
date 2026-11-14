// gate-answers-default.test.ts — the gate-answers default (2026-11-14), the library's half: by default
// no agent gets a tool that records a gate answer through Realm's MCP server, in any app.
//
// - AC1: `asked` in a stdio session whose client shows no forms lists, replies, briefs and describes
//   `abandon_run` exactly as `withheld` does.
// - AC2: so does `asked` on a server built per HTTP request, with `statelessHttp` and without it.
// - AC3 (library half): `offered`, given as the option, the flag or the variable, is `permitted`: the
//   agent's answer is recorded, and the value reads back as `permitted` in `effectiveGateAnswers()`
//   and the `realm/gate_answers` capability; `alsoSet` quotes another source as written.
// - AC4: the most restrictive value wins, one cell per pair of sources.
// - AC6 (library half): `onSessionWithoutForms` is called once for an `asked` session without forms,
//   never with forms or under `permitted` or `withheld`, and the library alone prints nothing.
//
// Every server here is built on in-memory transports, or on localhost HTTP, in one process. Every
// assertion carries (a) the change that turns it red and (b) what it prints on failure: tools,
// replies, protocol rules, values — never a token.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { judgeGateAnswers, loadWorkflowFromString } from '@sensigo/realm';
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
    //     (b) prints the asked session's four parts against withheld's.
    expect(asked).toEqual(withheld);
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
      // (a) red when the HTTP door keeps the answer tool under asked (its sessions never show forms);
      //     (b) prints the asked door's four parts against withheld's.
      expect(asked).toEqual(withheld);
    },
    60_000,
  );
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

  it('alsoSet quotes another source as written; offeredFrom names each source that gave offered', () => {
    // (a) red when an old name is rewritten in alsoSet, or not named in offeredFrom; (b) prints the
    //     readings.
    expect({
      both: effectiveGateAnswers({ gateAnswers: 'offered' }, { REALM_MCP_GATE_ANSWERS: 'asked' }),
      flagAndOption: effectiveGateAnswers(
        { gateAnswers: 'offered', gateAnswersFlag: 'offered' },
        {},
      ),
    }).toEqual({
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

describe('the gate-answers default — the most restrictive value wins (AC4)', () => {
  const win = (input: Parameters<typeof judgeGateAnswers>[0]) => {
    const r = judgeGateAnswers(input);
    return r.ok ? `${r.setting.value} from ${r.setting.source.kind}` : `refused ${r.kind}`;
  };
  it('one cell per pair of sources: asked beats permitted, withheld beats asked, whichever source holds it', () => {
    // (a) red when permitted is ranked above asked (or asked above withheld), or a tie stops going to
    //     the more direct source; (b) prints each pair's winner.
    expect({
      flagEnv: [win({ flag: 'permitted', env: 'asked' }), win({ flag: 'asked', env: 'withheld' })],
      flagOption: [
        win({ flag: 'asked', option: 'permitted' }),
        win({ flag: 'withheld', option: 'asked' }),
      ],
      envOption: [
        win({ env: 'permitted', option: 'asked' }),
        win({ env: 'asked', option: 'withheld' }),
      ],
      oldName: [
        win({ flag: 'offered', env: 'asked' }),
        win({ env: 'offered', option: 'permitted' }),
      ],
      none: win({}),
      unknown: win({ env: 'open' }),
    }).toEqual({
      flagEnv: ['asked from env', 'withheld from env'],
      flagOption: ['asked from flag', 'withheld from flag'],
      envOption: ['asked from option', 'withheld from option'],
      oldName: ['asked from env', 'permitted from env'],
      none: 'asked from default',
      unknown: 'refused env',
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
