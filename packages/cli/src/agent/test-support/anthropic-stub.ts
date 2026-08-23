// anthropic-stub.ts — an in-process HTTP server speaking just enough of the Anthropic Messages
// dialect to drive the REAL `AnthropicProvider` through a scripted tool call.
//
// SEAM PARITY WITH THE OPENAI SIBLING. This stub sits at the WIRE, exactly like `openai-stub.ts`:
// the real `@anthropic-ai/sdk` builds the request, posts it here, and parses the response, so
// everything above the socket is shipped code. It used to stub at the SDK MODULE boundary, which
// it had to while the SDK was an uninstalled peer dependency — there was no SDK to point at a
// base URL. Now the SDK is a cli devDependency (the same re-home `openai` got in #332), and the
// asymmetry is gone: neither journey mocks anything in the chain under test.
//
// The provider passes no `baseURL`, so the cell reaches this server through the SDK's own
// `ANTHROPIC_BASE_URL` environment default, read when the client is constructed. Realm never sets
// or strips that variable.
//
// RAILS THIS FILE OBEYS (both would fail elsewhere in confusing ways):
//   - it imports NOTHING from vitest, because `test-support/*.ts` compiles into the PUBLISHED
//     dist (`files: ["dist"]`; the tsconfig excludes only `*.test.ts`).
//   - it never writes a `.create(` immediately followed by `{`, in code OR comments — a repo
//     guard scans every non-test cli source file's whole text for that pattern and reports it as
//     an unclassified run-creating site.
//
// REDACTION HAZARD, INHERITED BY EVERY CALLER. `sanitizeError` (agent-utils.ts) redacts every
// `process.env` value longer than four characters as a SUBSTRING, from tool results and from
// errors alike. This journey now sets TWO such values — `ANTHROPIC_API_KEY` and
// `ANTHROPIC_BASE_URL` (a `http://127.0.0.1:<port>` URL) — so a cell must pick a key colliding
// with no text it asserts on, and must never assert on the base URL appearing in any error text,
// because it will have been rewritten to `[REDACTED]`. The shipped cell uses
// `sk-ant-test-composed-journey-0000` for exactly this reason.
//
// WIRE FIDELITY, and what is decoration. The provider reads only `content[]` (its `type`, `id`,
// `name`, `input`, `text`) and `stop_reason`. `id`, `model` and `usage` are echoed here because a
// real response carries them and a stub that omits them invites someone to "simplify" the shape
// until it stops resembling the API — they are not read.
//
// ONE THING THE REAL SDK CHECKS THAT A MODULE MOCK NEVER COULD: it throws "Streaming is
// required…" BEFORE any network call when `max_tokens` exceeds the non-streaming ceiling.
// Realm's own cap for this model sits comfortably under it, so this journey passes — but a future
// bump past that guard would red THIS journey while every module-mocked unit suite stayed green.
// That asymmetry is the point of driving the real SDK, and it is deliberately not pinned here: a
// guard-value assertion would couple the journey to an SDK constant.
import { createServer, type Server } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

/** One scripted tool call: which advertised tool to name, and the arguments to script for it. */
export interface StubToolCall {
  /** Matched against the BARE tool names the request advertises. */
  match: RegExp;
  /** Scripted arguments for the call — an OBJECT, per the Messages dialect. */
  arguments: Record<string, unknown>;
}

export interface AnthropicStubOptions {
  firstToolCall: StubToolCall;
  /**
   * When set, EVERY request answers with this status and these headers instead of a scripted
   * turn — the stub becomes a rate limiter rather than a model.
   *
   * It exists for one journey: proving that a server-directed `Retry-After` is OBSERVED and never
   * honored. Pair it with `x-should-retry: false` to keep the cell fast — the real SDK obeys that
   * directive before it sleeps, so the failure comes back immediately with the long Retry-After
   * intact in the record.
   */
  failure?: { status: number; headers: Record<string, string> };
  /**
   * The assistant's final answer, returned once the tool has replied. MUST validate against the
   * driven step's `input_schema` — a mismatch engages the #217 repair loop and the journey's own
   * assertions then fail for a reason unrelated to the chain under test.
   */
  finalContent: Record<string, unknown>;
}

export interface AnthropicStub {
  /** Set as `ANTHROPIC_BASE_URL` — the SDK reads it when the client is constructed. */
  baseUrl: string;
  /** Every request body the provider sent, parsed from the wire. */
  requests: ReadonlyArray<Record<string, unknown>>;
  /** The headers of each request, in the same order — proof of who actually made the call. */
  headers: ReadonlyArray<IncomingHttpHeaders>;
  close: () => Promise<void>;
}

interface ContentBlock {
  type?: string;
  [key: string]: unknown;
}
interface HistoryMessage {
  role?: string;
  content?: unknown;
}

/**
 * Starts the stub on an ephemeral port. Always `close()` it in a `finally` — a leaked listener
 * keeps the vitest worker alive past the test.
 */
export async function startAnthropicStub(options: AnthropicStubOptions): Promise<AnthropicStub> {
  const requests: Array<Record<string, unknown>> = [];
  const headers: IncomingHttpHeaders[] = [];

  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString();
    });
    req.on('end', () => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(raw || '{}') as Record<string, unknown>;
      } catch {
        // A malformed body is the caller's problem — recorded empty so the assertions on
        // `requests` show what actually arrived rather than hiding it behind a 500.
      }
      // Parsed from the wire, so these are snapshots by construction: the provider's in-place
      // mutation of its history array cannot reach back into what was already serialized.
      requests.push(body);
      headers.push(req.headers);

      if (options.failure !== undefined) {
        res.writeHead(options.failure.status, {
          'content-type': 'application/json',
          ...options.failure.headers,
        });
        res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error' } }));
        return;
      }

      // CONTENT-KEYED turn detection, and string-tolerant: the history mixes string-content
      // messages (the initial prompt, and the #224 correction turn) with array-content ones, so
      // anything assuming `content` is an array throws on the first turn. `tool_result` is the
      // only block type the provider ever pushes into a user turn, which makes its presence an
      // exact "the tool has already answered" signal — a request counter would desynchronise the
      // moment a retry or a repair iteration inserted a turn.
      const messages = Array.isArray(body['messages'])
        ? (body['messages'] as HistoryMessage[])
        : [];
      const toolAlreadyAnswered = messages.some(
        (m) =>
          Array.isArray(m.content) &&
          (m.content as ContentBlock[]).some((b) => b?.type === 'tool_result'),
      );

      const content = toolAlreadyAnswered
        ? [{ type: 'text', text: JSON.stringify(options.finalContent) }]
        : [
            {
              type: 'tool_use',
              id: 'toolu_01',
              name: pickToolName(body, options.firstToolCall.match),
              // An OBJECT here — the Messages dialect differs from OpenAI's JSON-encoded string,
              // and the provider reads `block.input` directly.
              input: options.firstToolCall.arguments,
            },
          ];

      const payload = {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: body['model'],
        content,
        stop_reason: toolAlreadyAnswered ? 'end_turn' : 'tool_use',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      };

      const text = JSON.stringify(payload);
      res.writeHead(200, {
        // Load-bearing: without it the SDK does not parse the body as JSON.
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(text)),
      });
      res.end(text);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${String(port)}`,
    requests,
    headers,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

/**
 * Reads the tool name back out of the request the provider actually sent, so the stub can never
 * name a tool that was not advertised. The provider advertises BARE names; the namespaced
 * `server:tool` id lives only in its internal map and never reaches the wire.
 *
 * HOW A MISMATCH SURFACES, so nobody hunts in the wrong place: an unadvertised name makes the
 * provider's id lookup return undefined, and the id parser then throws a bare TypeError OUTSIDE
 * the inner try — the step fails with "Cannot read properties of undefined (reading 'indexOf')",
 * which says nothing about tool names. The fallback string below will be sitting in
 * `requests[0]`; look for it there, never in the failure message.
 */
function pickToolName(body: Record<string, unknown>, match: RegExp): string {
  const tools = Array.isArray(body['tools']) ? (body['tools'] as Array<{ name?: unknown }>) : [];
  const advertised = tools.map((t) => t.name).filter((n): n is string => typeof n === 'string');
  return advertised.find((n) => match.test(n)) ?? `NO_ADVERTISED_TOOL_MATCHING_${match.source}`;
}
