// openai-stub.ts — an in-process HTTP server speaking just enough of the chat-completions dialect
// to drive the REAL `OpenAIProvider` through a scripted tool call.
//
// WHY THIS EXISTS. A journey test that mocks the provider proves the test's own mocks work. This
// stub sits at the WIRE instead, so everything above it — the provider's request building, its
// tool-call parsing, the tool loop, the ToolCallRecord mint — is the shipped code running for
// real. The only thing faked is the model's answer, which is the one part that cannot be run.
//
// WHY IN-PROCESS AND NOT A CHILD. Flake hygiene. A journey cell like this is exactly the class
// issue #371 tracks, so it gets one child process in total (the MCP server, which must be a child
// to be real) and nothing else. An ephemeral port means no collisions under parallel runs.
//
// THE WIRE SHAPES BELOW ARE EXECUTED FACTS, not guesses — each one was verified against the
// installed openai SDK, and each has a failure mode that is confusing rather than obvious:
//   - Content-Type MUST be application/json. Without it the SDK hands the provider the body as a
//     raw string, `choices` is undefined, and the provider dies with a TypeError nowhere near the
//     cause.
//   - `function.arguments` MUST be a JSON-ENCODED STRING. The provider `JSON.parse`s it outside
//     its try block, so an object there throws and fails the step.
//   - the echoed tool name MUST be the BARE advertised name, read back from the request's own
//     `tools` array. run-agent advertises the bare name; the namespaced `server:tool` id never
//     reaches the wire, so hardcoding the namespaced form fails for a reason that looks like a
//     product bug.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** One scripted tool call: which tool to name, and the arguments to script for it. */
export interface StubToolCall {
  /** Matched against the bare tool names the request advertises. */
  match: RegExp;
  /** Scripted arguments — JSON-encoded into `function.arguments` for the SDK. */
  arguments: Record<string, unknown>;
}

export interface StubOptions {
  firstToolCall: StubToolCall;
  /**
   * The assistant's final answer, returned on every turn after the tool result comes back.
   * MUST validate against the driven step's `input_schema` — a mismatch engages the #217 schema
   * repair loop, and the journey's own assertions then fail for a reason unrelated to the chain
   * under test.
   */
  finalContent: Record<string, unknown>;
}

export interface OpenAiStub {
  /** Pass to `new OpenAIProvider(model, baseUrl)`. */
  baseUrl: string;
  /** Every request body the provider sent, parsed. Assert against this to pin what went over the wire. */
  requests: ChatCompletionRequest[];
  close: () => Promise<void>;
}

interface ChatCompletionRequest {
  model?: string;
  messages?: Array<{ role?: string; content?: unknown; tool_calls?: unknown }>;
  tools?: Array<{ type?: string; function?: { name?: string; description?: string } }>;
  [key: string]: unknown;
}

/**
 * Starts the stub on an ephemeral port. Always `close()` it in a `finally` — a leaked listener
 * keeps the vitest worker alive past the test.
 */
export async function startOpenAiStub(options: StubOptions): Promise<OpenAiStub> {
  const requests: ChatCompletionRequest[] = [];

  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString();
    });
    req.on('end', () => {
      let body: ChatCompletionRequest = {};
      try {
        body = JSON.parse(raw || '{}') as ChatCompletionRequest;
      } catch {
        // A malformed body is the test's problem, not the stub's — record it as empty and let the
        // assertions on `requests` show what actually arrived.
      }
      requests.push(body);

      // Turn 1 is the one with no tool result in it yet. Keyed on the conversation's own contents
      // rather than a call counter, so a retry or a repair iteration cannot desynchronise the
      // script from what the provider actually asked for.
      const alreadyToolAnswered = (body.messages ?? []).some((m) => m.role === 'tool');

      const payload = alreadyToolAnswered
        ? {
            choices: [
              { message: { role: 'assistant', content: JSON.stringify(options.finalContent) } },
            ],
          }
        : {
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'call_1',
                      type: 'function',
                      function: {
                        name: pickToolName(body, options.firstToolCall.match),
                        // JSON-encoded STRING, not an object — see the header.
                        arguments: JSON.stringify(options.firstToolCall.arguments),
                      },
                    },
                  ],
                },
              },
            ],
          };

      const text = JSON.stringify(payload);
      res.writeHead(200, {
        // Load-bearing — see the header.
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(text)),
      });
      res.end(text);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${String(port)}/v1`,
    requests,
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
 * name a tool the provider did not advertise. Falls back to the pattern's source only when nothing
 * matched — which makes the resulting failure name the mismatch instead of hiding it.
 */
function pickToolName(body: ChatCompletionRequest, match: RegExp): string {
  const advertised = (body.tools ?? [])
    .map((t) => t.function?.name)
    .filter((n): n is string => typeof n === 'string');
  return advertised.find((n) => match.test(n)) ?? `NO_ADVERTISED_TOOL_MATCHING_${match.source}`;
}
