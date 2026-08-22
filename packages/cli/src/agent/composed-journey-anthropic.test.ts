// composed-journey-anthropic.test.ts — the #345 journey on the OTHER provider (issue #398).
//
// The two Class-B mints are structural twins, which is exactly why one journey proves nothing
// about the other: a join that exists only on this side would go unnoticed. The per-member rule,
// applied to journeys rather than to cells.
//
// FULL SEAM PARITY WITH THE OPENAI JOURNEY. Both drive their real SDK over HTTP against an
// in-process stub, so neither has a mock anywhere in the chain under test. The only difference
// left is the dialect each SDK speaks — the Messages API sends tool arguments as an object where
// chat-completions sends a JSON-encoded string — and that difference lives entirely inside the
// stubs. (This cell used to mock the SDK module, because `@anthropic-ai/sdk` was an uninstalled
// peer dependency and there was no SDK to point at a base URL. It is now a cli devDependency, the
// same re-home `openai` got in #332.)
//
// Everything below the provider seam is shared with the OpenAI journey and identical: a REAL MCP
// stdio child (realm's own server), the real store read back off disk, the real inspect render.
//
// FLAKE POSTURE, matching the sibling: exactly ONE child process (the MCP server), an ephemeral
// port, temp directories, the stub closed in a `finally`, and a per-test timeout rather than a
// change to the global config.
import { describe, it, expect } from 'vitest';
import { rmSync } from 'node:fs';
import { AnthropicProvider } from './providers/anthropic-provider.js';
import { startAnthropicStub } from './test-support/anthropic-stub.js';
import { makeJourneyHome, runComposedJourney } from './test-support/composed-journey.js';
import { resolveMcpServerEntry } from './test-support/mcp-server-entry.js';

const PROBE_WORKFLOW_ID = 'no-such-workflow-composed-journey';

// Distinctive on purpose, and now genuinely consumed: the REAL SDK reads this key and sends it as
// the `x-api-key` header, which the header assertion below checks. It also has to be distinctive
// because `sanitizeError` redacts every environment value longer than four characters as a
// substring of tool results and errors — a colliding key would rewrite the very strings this test
// asserts on into `[REDACTED]`. The same applies to `ANTHROPIC_BASE_URL`, which is why nothing
// here asserts on the stub's URL appearing in any error text.
const STUB_API_KEY = 'sk-ant-test-composed-journey-0000';

// Fails the whole file with a sentence naming the missing build, rather than an ENOENT from spawn.
resolveMcpServerEntry();

describe('composed journey (Anthropic) — a politely-failed tool call, all the way to the operator', () => {
  it('runs the real provider against a real MCP child and records, persists and renders the failure', async () => {
    const tempHome = makeJourneyHome('composed-journey-anthropic-');
    const originalKey = process.env['ANTHROPIC_API_KEY'];
    const originalBaseUrl = process.env['ANTHROPIC_BASE_URL'];

    const stub = await startAnthropicStub({
      firstToolCall: {
        match: /get_workflow_protocol/,
        arguments: { workflow_id: PROBE_WORKFLOW_ID },
      },
      // MUST satisfy the step's input_schema — a mismatch engages the #217 repair loop and
      // assertion 1 then fails for a reason that has nothing to do with this chain.
      finalContent: { summary: 'the tool reported a failure' },
    });

    // The provider passes no baseURL, so this is how the real SDK is pointed at the stub. Read
    // when the client is constructed, which is call time — so setting it here is sound.
    process.env['ANTHROPIC_API_KEY'] = STUB_API_KEY;
    process.env['ANTHROPIC_BASE_URL'] = stub.baseUrl;

    try {
      const journey = await runComposedJourney(tempHome, {
        provider: new AnthropicProvider('claude-sonnet-4-5'),
        probeWorkflowId: PROBE_WORKFLOW_ID,
        finalSummary: 'the tool reported a failure',
      });

      // 1. The run COMPLETES. A polite tool failure is a tool-level event, not a step failure —
      //    if this ever starts failing the step, every workflow using a tool that can say "not
      //    found" breaks, which is a far bigger change than it looks.
      expect(journey.result).toBe('completed');
      expect(journey.run.run_phase).toBe('completed');
      // Exactly one run — a duplicate would otherwise hide behind assertions about the first.
      expect(journey.runCount).toBe(1);

      // 2. The PERSISTED record carries the failure — the #345 fix, read back off disk rather
      //    than out of a return value. Matched by prefix + probe id: the server's wording may
      //    evolve, and this cell is about the failure being RECORDED, not about its phrasing.
      expect(journey.toolCalls).toHaveLength(1);
      const record = journey.toolCalls[0]!;
      expect(record.error).toBeDefined();
      expect(record.error).toContain('Error: Workflow not found');
      expect(record.error).toContain(PROBE_WORKFLOW_ID);
      expect(record.result).toContain('"isError":true');

      // 3. The OPERATOR sees it. Before #345 this line rendered identically to a success.
      expect(journey.inspectOutput).toMatch(
        /\[realm:get_workflow_protocol\]\s+\d+ms\s+error: Error: Workflow not found/,
      );
      expect(journey.inspectVerboseOutput).toContain('"isError":true');

      // 4. The stub was driven by what the provider ADVERTISED, not by a name this test
      //    hardcoded — otherwise assertion 3 could pass against a tool nobody offered. The
      //    bodies are parsed from the wire, so each is a snapshot of that turn by construction.
      expect(stub.requests.length).toBeGreaterThanOrEqual(2);
      const advertised = (stub.requests[0]!['tools'] as Array<{ name?: string }>)[0]?.name;
      expect(advertised).toBe('get_workflow_protocol');
      // The namespaced id is a realm-internal address and must never reach the wire.
      expect(JSON.stringify(stub.requests[0])).not.toContain('realm:get_workflow_protocol');
      // Turn 1 carried no tool reply — the two turns really are distinct.
      expect(JSON.stringify(stub.requests[0]!['messages'])).not.toContain('tool_result');

      // 5. THE REAL SDK MADE THIS CALL. A module mock could satisfy every assertion above while
      //    never touching a socket; only headers the SDK itself sets can tell the two apart.
      expect(stub.headers[0]?.['x-api-key']).toBe(STUB_API_KEY);
      expect(stub.headers[0]?.['anthropic-version']).toBe('2023-06-01');
    } finally {
      await stub.close();
      if (originalKey === undefined) delete process.env['ANTHROPIC_API_KEY'];
      else process.env['ANTHROPIC_API_KEY'] = originalKey;
      if (originalBaseUrl === undefined) delete process.env['ANTHROPIC_BASE_URL'];
      else process.env['ANTHROPIC_BASE_URL'] = originalBaseUrl;
      rmSync(tempHome, { recursive: true, force: true });
    }
  }, 25_000);
});
