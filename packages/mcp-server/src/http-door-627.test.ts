// http-door-627.test.ts — #627 W correction 1 (F1): the HTTP doors, over real HTTP. F1's sentence on
// four pages (the CHANGELOG's BREAKING bullet, gate-answers.md's `asked` row, gates-and-trust.md,
// human-gates.md) — "On an HTTP server built per request — `realm serve`, or a program that builds a
// server per request or passes `statelessHttp` — no client gets forms: under `asked` every client
// keeps the answer tool, marked for approval. A program that keeps one server per HTTP session sends
// forms as stdio does." — executed with the SDK's own Streamable HTTP transports on localhost, by a
// client that declares forms in every case. `realm serve` is the per-request shape with
// `statelessHttp` (serve.ts builds a server and a stateless transport per request, and passes it).
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure: the
// listed tool names, the answer tool's _meta, the forms sent and the recorded route — never a token.
import { describe, it, expect } from 'vitest';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileStore, JsonWorkflowStore, loadWorkflowFromString } from '@sensigo/realm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createRealmMcpServer } from './server.js';

const YAML = [
  'id: http627',
  'name: http627',
  'version: 1',
  'steps:',
  '  q:',
  '    description: Ask.',
  '    execution: auto',
  '    trust: human_confirmed',
  '    gate:',
  '      choices: [approve, reject]',
  '      message: Ship it?',
  '  after:',
  '    description: After.',
  '    execution: agent',
  '    depends_on: [q]',
].join('\n');

/** How the embedding program builds its servers: one per request, or one per HTTP session. */
type Shape = 'per_request' | 'per_session';

async function bodyOf(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw.length > 0 ? JSON.parse(raw) : undefined;
}

/**
 * A Realm MCP server on localhost, built the way `shape` says, under the default `asked`, with
 * `statelessHttp` passed or not; and a client that declares forms and accepts every form with
 * `approve`.
 */
async function httpDoor(
  shape: Shape,
  statelessHttp: boolean,
  refuseGet = false,
  jsonResponse = false,
) {
  const dir = await mkdtemp(join(tmpdir(), 'realm-http-627-'));
  const runStore = new JsonFileStore(join(dir, 'runs'));
  const workflowStore = new JsonWorkflowStore(join(dir, 'wf'));
  await workflowStore.register(loadWorkflowFromString(YAML));
  const build = () =>
    createRealmMcpServer({ runStore, workflowStore, ...(statelessHttp ? { statelessHttp } : {}) });
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const http = createServer((req, res) => {
    void (async () => {
      // Correction 2 (1.7): a host that refuses the standalone GET stream — a form then reaches the
      // client only on the tool call's own stream.
      if (refuseGet && req.method === 'GET') {
        res.writeHead(405).end();
        return;
      }
      const body = await bodyOf(req);
      if (shape === 'per_request') {
        // One server and one stateless transport per request, as `realm serve` builds them.
        const transport = new StreamableHTTPServerTransport({});
        await build().connect(transport as unknown as Transport);
        await transport.handleRequest(req, res, body);
        return;
      }
      // One server per HTTP session, kept by its session id.
      const sid = req.headers['mcp-session-id'];
      let transport = typeof sid === 'string' ? sessions.get(sid) : undefined;
      if (transport === undefined) {
        const created: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          // Correction 2 (6.9): the JSON-reply mode a program may choose for its per-session transport.
          ...(jsonResponse ? { enableJsonResponse: true } : {}),
          onsessioninitialized: (id) => {
            sessions.set(id, created);
          },
        });
        transport = created;
        await build().connect(transport as unknown as Transport);
      }
      await transport.handleRequest(req, res, body);
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address() as AddressInfo;
  let forms = 0;
  const client = new Client(
    { name: 'http-627', version: '0' },
    { capabilities: { elicitation: { form: {} } } },
  );
  client.setRequestHandler(ElicitRequestSchema, async () => {
    forms++;
    return { action: 'accept', content: { choice: 'approve' } };
  });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)) as Transport,
  );
  const close = async () => {
    await client.close().catch(() => undefined);
    for (const t of sessions.values()) await t.close().catch(() => undefined);
    await new Promise<void>((resolve) => http.close(() => resolve()));
  };
  return { client, runStore, forms: () => forms, close };
}

/** What the door gives a forms client: the answer tools listed, the answer tool's _meta; then a run's
 *  question — whether a form went out, and the route the answer recorded (none when nothing did). */
async function walk(shape: Shape, statelessHttp: boolean) {
  const d = await httpDoor(shape, statelessHttp);
  try {
    // Let `list_changed` (sent when `initialize` says the client shows forms) settle.
    await new Promise((r) => setTimeout(r, 50));
    const tools = (await d.client.listTools()).tools;
    const answerTool = tools.find((t) => t.name === 'submit_human_response');
    const started = JSON.parse(
      (
        (await d.client.callTool(
          { name: 'start_run', arguments: { workflow_id: 'http627', params: {} } },
          undefined,
          { timeout: 60_000 },
        )) as { content: Array<{ text: string }> }
      ).content[0]!.text,
    ) as { run_id: string };
    const entry = (await d.runStore.get(started.run_id)).evidence.find(
      (e) => e.kind === 'gate_response',
    );
    return {
      listed: tools
        .map((t) => t.name)
        .filter((n) => n === 'submit_human_response' || n === 'present_question'),
      meta: answerTool?._meta,
      forms: d.forms(),
      recorded: entry?.answer,
    };
  } finally {
    await d.close();
  }
}

describe('#627 W correction 1 (F1) — the HTTP doors, under asked, for a client that shows forms', () => {
  it('a server built per request — realm serve’s shape, with or without statelessHttp — sends no form: the answer tool stays, marked for approval', async () => {
    const FALLBACK = {
      listed: ['submit_human_response'],
      meta: { 'anthropic/requiresUserInteraction': true },
      forms: 0,
      recorded: undefined,
    };
    // (a) red when a per-request server lists present_question or sends a form (its tools are the
    //     fallback until `initialize`, which a per-request server never keeps), or when
    //     `statelessHttp` stops turning forms off; (b) prints each door's tools, _meta, forms, route.
    expect({
      perRequest: await walk('per_request', false),
      perRequestStateless: await walk('per_request', true),
      perSessionStateless: await walk('per_session', true),
    }).toEqual({
      perRequest: FALLBACK,
      perRequestStateless: FALLBACK,
      perSessionStateless: FALLBACK,
    });
  }, 60_000);

  it('a server kept per HTTP session sends forms as stdio does: present_question listed, the answer tool gone, the form records mcp_form', async () => {
    const perSession = await walk('per_session', false);
    // (a) red when an HTTP session's forms are turned off, or its form is not sent or not recorded;
    //     (b) prints the tools, the forms sent and the recorded route.
    expect({
      listed: perSession.listed,
      forms: perSession.forms,
      route: (perSession.recorded as { route?: unknown } | undefined)?.route,
    }).toEqual({ listed: ['present_question'], forms: 1, route: 'mcp_form' });
  }, 60_000);
});

describe('#627 W correction 2 (1.7) — the form rides the tool call’s own stream', () => {
  it('a server kept per HTTP session, whose host refuses the GET stream (405): the form still arrives, and records mcp_form', async () => {
    const d = await httpDoor('per_session', false, true);
    try {
      await new Promise((r) => setTimeout(r, 50));
      const call = d.client.callTool(
        { name: 'start_run', arguments: { workflow_id: 'http627', params: {} } },
        undefined,
        { timeout: 60_000 },
      );
      // Without the call's id the form is dropped and the call waits Realm's whole timer: bound it.
      const settled = await Promise.race([
        call.then(() => true),
        new Promise<false>((r) => setTimeout(() => r(false), 5_000)),
      ]);
      const runs = await d.runStore.list();
      const entry = runs[0]?.evidence.find((e) => e.kind === 'gate_response');
      // (a) red when the elicitation is sent without the tool call's request id (it then needs the
      //     GET stream this host refuses); (b) prints whether the call settled, the forms sent and
      //     the recorded route.
      expect({
        settled,
        forms: d.forms(),
        route: (entry?.answer as { route?: unknown } | undefined)?.route,
      }).toEqual({
        settled: true,
        forms: 1,
        route: 'mcp_form',
      });
    } finally {
      await d.close();
    }
  }, 30_000);
});

describe('#627 W correction 2 (6.9) — a per-session transport in JSON-reply mode holds no form (the README’s statelessHttp row)', () => {
  it('a server kept per HTTP session with enableJsonResponse: no form reaches the client, and the call is still waiting after 5 s', async () => {
    const d = await httpDoor('per_session', false, false, true);
    try {
      await new Promise((r) => setTimeout(r, 50));
      const call = d.client.callTool(
        { name: 'start_run', arguments: { workflow_id: 'http627', params: {} } },
        undefined,
        { timeout: 60_000 },
      );
      void call.catch(() => undefined);
      // The same race as 1.7's cell, where the form arrives and the call settles inside it.
      const settled = await Promise.race([
        call.then(() => true),
        new Promise<false>((r) => setTimeout(() => r(false), 5_000)),
      ]);
      // (a) red when a JSON-reply transport delivers the form (the README's advice to pass
      //     statelessHttp would then be wrong); (b) prints whether the call settled and the forms sent.
      expect({ settled, forms: d.forms() }).toEqual({ settled: false, forms: 0 });
    } finally {
      await d.close();
    }
  }, 30_000);
});
