// composed-journey-anthropic.test.ts — the #345 journey on the OTHER provider (issue #398).
//
// The two mints are structural twins, which is exactly why one journey proves nothing about the
// other: a join that exists only on this side would go unnoticed. The per-member rule, applied to
// journeys rather than to cells.
//
// Everything below the provider seam is shared with the OpenAI journey and identical: a REAL MCP
// stdio child (realm's own server), the real store read back off disk, the real inspect render.
// Only the seam differs, and it differs because it has to — `@anthropic-ai/sdk` is an uninstalled
// peer dependency, so there is no SDK to point at an HTTP stub. See `anthropic-stub.ts` for the
// full reasoning; the short version is that the stub sits at the module boundary and the SDK
// resolves `messages.create(...)` to the parsed body anyway, so the provider receives the same
// object it would have received from the wire.
//
// FLAKE POSTURE, matching the sibling: exactly ONE child process (the MCP server), temp
// directories, and a per-test timeout rather than a change to the global config.
import { describe, it, expect, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { AnthropicProvider } from './providers/anthropic-provider.js';
import { createAnthropicStub } from './test-support/anthropic-stub.js';
import { makeJourneyHome, runComposedJourney } from './test-support/composed-journey.js';
import { resolveMcpServerEntry } from './test-support/mcp-server-entry.js';

const PROBE_WORKFLOW_ID = 'no-such-workflow-composed-journey';

// Distinctive on purpose. `sanitizeError` redacts every environment value longer than four
// characters as a substring of tool results and errors, so a colliding key would rewrite the very
// strings this test asserts on into `[REDACTED]`.
//
// Kept even though nothing reads it under the module mock — the mocked constructor ignores its
// argument, and the only presence check lives on the CLI command path, which an injected provider
// never reaches. It is here to mirror what an operator's environment looks like and to keep the
// redaction hazard live rather than accidentally absent.
const STUB_API_KEY = 'sk-ant-test-composed-journey-0000';

const stub = createAnthropicStub({
  firstToolCall: {
    match: /get_workflow_protocol/,
    arguments: { workflow_id: PROBE_WORKFLOW_ID },
  },
  finalContent: { summary: 'the tool reported a failure' },
});

// The factory runs lazily at the provider's first dynamic `import()`, inside `it()` — after `stub`
// is initialised. The same posture as every existing `const mockCreate = vi.fn()` cell in this
// package. vitest keys both the registration and the runtime dynamic import on the raw specifier,
// which is what lets an UNINSTALLED module be mocked at all.
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(function () {
    return { messages: { create: (opts: Record<string, unknown>) => stub.create(opts) } };
  }),
}));

// Fails the whole file with a sentence naming the missing build, rather than an ENOENT from spawn.
resolveMcpServerEntry();

describe('composed journey (Anthropic) — a politely-failed tool call, all the way to the operator', () => {
  it('runs the real provider against a real MCP child and records, persists and renders the failure', async () => {
    const tempHome = makeJourneyHome('composed-journey-anthropic-');
    const originalKey = process.env['ANTHROPIC_API_KEY'];
    process.env['ANTHROPIC_API_KEY'] = STUB_API_KEY;

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
      //    hardcoded — otherwise assertion 3 could pass against a tool nobody offered.
      //    Asserted on the SNAPSHOT: the provider mutates its history array in place, so a
      //    live reference would show the final turn here instead of the first.
      expect(stub.requests.length).toBeGreaterThanOrEqual(2);
      const advertised = (stub.requests[0]!['tools'] as Array<{ name?: string }>)[0]?.name;
      expect(advertised).toBe('get_workflow_protocol');
      // The namespaced id is a realm-internal address and must never reach the wire.
      expect(JSON.stringify(stub.requests[0])).not.toContain('realm:get_workflow_protocol');
      // The snapshot really is a snapshot: turn 1 carried no tool reply.
      expect(JSON.stringify(stub.requests[0]!['messages'])).not.toContain('tool_result');
    } finally {
      if (originalKey === undefined) delete process.env['ANTHROPIC_API_KEY'];
      else process.env['ANTHROPIC_API_KEY'] = originalKey;
      rmSync(tempHome, { recursive: true, force: true });
    }
  }, 25_000);
});
