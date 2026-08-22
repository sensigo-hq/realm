// anthropic-stub.ts — scripts the Anthropic Messages API for the composed journey (issue #398).
//
// WHY THIS IS A MODULE STUB AND NOT AN HTTP STUB, and why nobody should "upgrade" it:
// `@anthropic-ai/sdk` is a PEER dependency and is NOT installed — not in this repo, not in CI.
// The provider loads it with a dynamic `import(moduleId)` and degrades gracefully when that
// fails. So there is no SDK to point at a base URL: an HTTP stub would need the package present,
// which would mean installing a peer dep purely for tests. The OpenAI sibling CAN use HTTP
// because its SDK is a real dependency; the asymmetry is in the dependency graph, not in taste.
//
// COVERAGE EQUIVALENCE, precisely. The SDK's own parsing resolves `messages.create(...)` to the
// PARSED JSON BODY (plus a non-enumerable `_request_id` realm never reads). So a wire-shaped
// object resolved here IS the object the provider would have received from a real response —
// everything above the SDK's parse boundary is the shipped code path. What this does NOT cover
// is the SDK's own request serialization and parsing, which is the SDK's tested concern.
//
// This is the house idiom for the tools path: four suite files already drive dozens of
// `callStepWithTools` invocations through exactly this module mock.
//
// RAILS THIS FILE OBEYS (both would fail elsewhere in confusing ways):
//   - it imports NOTHING from vitest, because `test-support/*.ts` compiles into the PUBLISHED
//     dist (`files: ["dist"]`; the tsconfig excludes only `*.test.ts`). The CELL owns `vi.mock`
//     and `vi.fn()`; this exports a plain function.
//   - it never writes a `.create(` immediately followed by `{`, in code OR comments — a repo
//     guard scans every non-test cli source file's whole text for that pattern and reports it as
//     an unclassified run-creating site. Hence prose like "the create call takes an opts object".
//
// REDACTION HAZARD, INHERITED BY EVERY CALLER. `sanitizeError` (agent-utils.ts) redacts every
// `process.env` value longer than four characters as a SUBSTRING, from tool results and from
// errors alike. A cell that sets an API key for this journey must pick a value colliding with no
// text it later asserts on, or the assertion reads `[REDACTED]` and the failure looks like a
// product bug. The shipped cell uses `sk-ant-test-composed-journey-0000` for exactly this reason.

/** One scripted tool call: which advertised tool to name, and the arguments to script for it. */
export interface StubToolCall {
  /** Matched against the BARE tool names the request advertises. */
  match: RegExp;
  /** Scripted arguments for the call. */
  arguments: Record<string, unknown>;
}

export interface AnthropicStubOptions {
  firstToolCall: StubToolCall;
  /**
   * The assistant's final answer, returned once the tool has replied. MUST validate against the
   * driven step's `input_schema` — a mismatch engages the #217 repair loop and the journey's own
   * assertions then fail for a reason unrelated to the chain under test.
   *
   * Mirrors `startOpenAiStub`'s option shape deliberately, so a cell reads the same way against
   * either provider. Mirrored rather than shared: the two stubs answer at different layers (HTTP
   * vs the module boundary) and a common type module with one real consumer would be indirection,
   * not shared-ness.
   */
  finalContent: Record<string, unknown>;
}

export interface AnthropicStub {
  /** Wire into the mocked SDK's messages surface. */
  create: (opts: Record<string, unknown>) => Promise<unknown>;
  /** Snapshots of every request the provider made. */
  requests: ReadonlyArray<Record<string, unknown>>;
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
 * Builds the stub. No `restore()` and no reset: vitest forks per file, and the journey cell has a
 * single `it`, so a lifecycle method here would exist only to look thorough.
 */
export function createAnthropicStub(options: AnthropicStubOptions): AnthropicStub {
  const requests: Array<Record<string, unknown>> = [];

  return {
    requests,
    create: (opts: Record<string, unknown>): Promise<unknown> => {
      // SNAPSHOTTED, not pushed by reference. The provider hands the SDK its LIVE `history` array
      // every turn, so storing the pointer would make `requests[0].messages` the FINAL history —
      // and an assertion about what turn 1 looked like would silently be reading turn 2. Every
      // payload here is plain JSON, so structuredClone is safe.
      requests.push(structuredClone(opts));

      // CONTENT-KEYED turn detection, and string-tolerant: the history mixes string-content
      // messages (the initial prompt, and the #224 correction turn) with array-content ones, so
      // anything assuming `content` is an array throws on the first turn. `tool_result` is the
      // only block type the provider ever pushes into a user turn, which makes its presence an
      // exact "the tool has already answered" signal — a request counter would desynchronise the
      // moment a retry or a repair iteration inserted a turn.
      const messages = Array.isArray(opts['messages'])
        ? (opts['messages'] as HistoryMessage[])
        : [];
      const toolAlreadyAnswered = messages.some(
        (m) =>
          Array.isArray(m.content) &&
          (m.content as ContentBlock[]).some((b) => b?.type === 'tool_result'),
      );

      if (toolAlreadyAnswered) {
        // The provider extracts JSON from the FIRST text block. This same shape also answers the
        // final-extraction request, which this journey never reaches (that path needs the tool
        // budget exhausted — 20 calls allowed, one made) but would answer correctly if it did.
        return Promise.resolve({
          content: [{ type: 'text', text: JSON.stringify(options.finalContent) }],
          // Wire fidelity only — the tools path does not read stop_reason.
          stop_reason: 'end_turn',
        });
      }

      return Promise.resolve({
        content: [
          {
            type: 'tool_use',
            id: 'toolu_01',
            name: pickToolName(opts, options.firstToolCall.match),
            // An OBJECT here — the Messages API differs from OpenAI's JSON-encoded string, and
            // the provider reads `block.input` directly.
            input: options.firstToolCall.arguments,
          },
        ],
        stop_reason: 'tool_use',
      });
    },
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
function pickToolName(opts: Record<string, unknown>, match: RegExp): string {
  const tools = Array.isArray(opts['tools']) ? (opts['tools'] as Array<{ name?: unknown }>) : [];
  const advertised = tools.map((t) => t.name).filter((n): n is string => typeof n === 'string');
  return advertised.find((n) => match.test(n)) ?? `NO_ADVERTISED_TOOL_MATCHING_${match.source}`;
}
