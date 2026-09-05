// composed-journey.test.ts — the #345 journey, end to end, with nothing mocked in the chain.
//
// Every other cell for Class-B tool failures drives one link: the helper, a provider mint, the
// inspect renderer. Each is honest about its own link and silent about the joins. This one runs
// the whole thing — the real OpenAIProvider (with `classBError` in its loop), a REAL MCP stdio
// child answering over the real transport, the real JSON store, and the real inspect render —
// and asserts what an operator would actually see at the end of it.
//
// The one thing faked is the model's answer, and it is faked at the WIRE (an in-process HTTP stub
// speaking chat-completions) rather than by substituting the provider. So the provider's request
// building, its tool-call parsing, the tool loop and the record mint are all shipped code doing
// its real job.
//
// The journey BODY is shared with the Anthropic twin (`test-support/composed-journey.ts`) — only
// the provider seam differs, and the assertions stay here where a reader looks when one fails.
//
// FLAKE POSTURE — this cell is the class issue #371 tracks, so it is built to be boring: exactly
// ONE child process (the MCP server, which has to be a child to be real), an ephemeral port, temp
// directories, and the stub closed in a `finally`. The child's lifecycle belongs to runAgent's own
// `finally`, which disconnects the client; the test deliberately holds no handle to it.
import { describe, it, expect } from 'vitest';
import { rmSync } from 'node:fs';
import { OpenAIProvider } from './providers/openai-provider.js';
import { startOpenAiStub } from './test-support/openai-stub.js';
import { makeJourneyHome, runComposedJourney } from './test-support/composed-journey.js';
import { resolveMcpServerEntry } from './test-support/mcp-server-entry.js';

// Distinctive on purpose. `sanitizeError` redacts every environment value longer than four
// characters as a substring of tool results and errors — a key that collided with any real text
// would rewrite the very strings this test asserts on into `[REDACTED]`.
const STUB_API_KEY = 'sk-test-composed-journey-0000';

const PROBE_WORKFLOW_ID = 'no-such-workflow-composed-journey';

// Fails the whole file with a sentence naming the missing build, rather than an ENOENT from spawn.
resolveMcpServerEntry();

describe('composed journey — a politely-failed tool call, all the way to the operator', () => {
  it('runs the real provider against a real MCP child and records, persists and renders the failure', async () => {
    const tempHome = makeJourneyHome('composed-journey-');
    const originalKey = process.env['OPENAI_API_KEY'];
    process.env['OPENAI_API_KEY'] = STUB_API_KEY;

    const stub = await startOpenAiStub({
      firstToolCall: {
        match: /get_workflow_protocol/,
        arguments: { workflow_id: PROBE_WORKFLOW_ID },
      },
      // MUST satisfy the step's input_schema — a mismatch engages the #217 repair loop and
      // assertion 1 then fails for a reason that has nothing to do with this chain.
      finalContent: { summary: 'the tool reported a failure' },
    });

    try {
      const journey = await runComposedJourney(tempHome, {
        provider: new OpenAIProvider('gpt-4o', stub.baseUrl),
        probeWorkflowId: PROBE_WORKFLOW_ID,
        finalSummary: 'the tool reported a failure',
      });

      // ---------------------------------------------------------------------------------
      // 1. The run COMPLETES. A polite tool failure is a tool-level event, not a step
      //    failure — if this ever starts failing the step, every workflow using a tool that
      //    can say "not found" breaks, which is a far bigger change than it looks.
      // ---------------------------------------------------------------------------------
      expect(journey.result).toBe('completed');
      expect(journey.run.run_phase).toBe('completed');
      // Exactly one run — a duplicate would otherwise hide behind assertions about the first.
      expect(journey.runCount).toBe(1);

      // ---------------------------------------------------------------------------------
      // 2. The PERSISTED record carries the failure — this is the #345 fix, read back off
      //    disk rather than out of a return value.
      // ---------------------------------------------------------------------------------
      expect(journey.toolCalls).toHaveLength(1);
      const record = journey.toolCalls[0]!;

      // Matched by prefix + the probe id rather than in full: the server's exact wording may
      // evolve, and this cell is about the failure being RECORDED, not about its phrasing.
      expect(record.error).toBeDefined();
      expect(record.error).toContain('Error: Workflow not found');
      expect(record.error).toContain(PROBE_WORKFLOW_ID);
      // And the raw payload survives verbatim — evidence is never discarded to tidy a record.
      expect(record.result).toContain('"isError":true');

      // ---------------------------------------------------------------------------------
      // 3. The OPERATOR sees it. The whole point of the fix: before #345 this line rendered
      //    identically to a success.
      // ---------------------------------------------------------------------------------
      expect(journey.inspectOutput).toContain(`[realm:get_workflow_protocol]`);
      expect(journey.inspectOutput).toMatch(
        /\[realm:get_workflow_protocol\]\s+\d+ms\s+error: Error: Workflow not found/,
      );
      expect(journey.inspectVerboseOutput).toContain('"isError":true');

      // ---------------------------------------------------------------------------------
      // 4. The stub was driven by what the provider ADVERTISED, not by a name this test
      //    hardcoded — otherwise assertion 3 could pass against a tool nobody offered.
      // ---------------------------------------------------------------------------------
      expect(stub.requests.length).toBeGreaterThanOrEqual(2);
      const advertised = stub.requests[0]!.tools?.[0]?.function?.name;
      expect(advertised).toBe('get_workflow_protocol');
      // The namespaced id is a realm-internal address and must never reach the wire.
      expect(JSON.stringify(stub.requests[0])).not.toContain('realm:get_workflow_protocol');
    } finally {
      await stub.close();
      if (originalKey === undefined) delete process.env['OPENAI_API_KEY'];
      else process.env['OPENAI_API_KEY'] = originalKey;
      rmSync(tempHome, { recursive: true, force: true });
    }
  }, 25_000); // The global 5s default would kill the MCP spawn; heavy cells self-protect exactly this way — a surgical per-it() budget at birth (issue #371's class rule), never a moved global.
});
