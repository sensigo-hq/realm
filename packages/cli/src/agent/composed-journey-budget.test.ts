// composed-journey-budget.test.ts — issue #401 PR-2: "observed, never honored", executed.
//
// The claim under test is the one a rate limit makes an operator care about: realm SEES the
// server's Retry-After and records it, but it does not obey it. The only honest way to show that
// is to make a real server say it, over a real socket, to the real SDK.
//
// FULL SEAM PARITY with the other composed journeys: the REAL `@anthropic-ai/sdk` builds and
// sends the request, the real counting fetch observes the response, the real driveCreate bounds
// the create, the real chokepoint mints the record, the real store persists it and the real
// inspect renders it. Nothing in that chain is doubled.
//
// NO MCP CHILD, deliberately: this step declares no tools, because a rate limit happens before a
// model can ask for one. That keeps the cell under a second, and the tool half of the chain is
// already covered by the two sibling journeys.
//
// WHY `x-should-retry: false` MAKES IT FAST. The SDK obeys the server's no-retry directive BEFORE
// it sleeps, so it comes straight back carrying a two-hour Retry-After it never waited for. That
// is the claim, literally: the header lands in the record, and nothing waits.
import { describe, it, expect } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  JsonFileStore,
  JsonWorkflowStore,
  ExtensionRegistry,
  classifyRunHealth,
} from '@sensigo/realm';
import type { WorkflowDefinition } from '@sensigo/realm';
import { AnthropicProvider } from './providers/anthropic-provider.js';
import { startAnthropicStub } from './test-support/anthropic-stub.js';
import { makeJourneyHome } from './test-support/composed-journey.js';
import { runAgent } from './run-agent.js';
import { inspectRun } from '../commands/inspect.js';

// Distinctive for the redaction hazard the harness documents: `sanitizeError` masks every env
// value over four characters as a substring, so a colliding key would rewrite the assertions.
const STUB_API_KEY = 'sk-ant-test-composed-budget-0000';

const RATE_LIMITED_WF = {
  id: 'composed-budget-wf',
  name: 'Composed Budget',
  version: 1,
  schema_version: 1,
  steps: {
    ask: {
      description: 'Ask the model something, and get rate limited',
      execution: 'agent' as const,
      depends_on: [],
      // AUTHORED on the step — this is the number that must come back out in the record.
      llm_timeout_seconds: 30,
      input_schema: {
        type: 'object',
        properties: { summary: { type: 'string' } },
        required: ['summary'],
      },
    },
  },
} as unknown as WorkflowDefinition;

describe('composed journey (budget) — a server-directed Retry-After is observed, never honored', () => {
  it('records all four discriminators and renders them, without waiting two hours', async () => {
    const tempHome = makeJourneyHome('composed-journey-budget-');
    const originalKey = process.env['ANTHROPIC_API_KEY'];
    const originalBaseUrl = process.env['ANTHROPIC_BASE_URL'];

    const stub = await startAnthropicStub({
      firstToolCall: { match: /never-used/, arguments: {} },
      finalContent: { summary: 'never reached' },
      failure: {
        status: 429,
        headers: { 'Retry-After': '7200', 'x-should-retry': 'false' },
      },
    });

    process.env['ANTHROPIC_API_KEY'] = STUB_API_KEY;
    process.env['ANTHROPIC_BASE_URL'] = stub.baseUrl;

    try {
      const store = new JsonFileStore(join(tempHome, '.realm', 'runs'));
      const workflowStore = new JsonWorkflowStore(join(tempHome, '.realm', 'workflows'));
      await workflowStore.register(RATE_LIMITED_WF);

      const started = Date.now();
      const result = await runAgent(
        {
          store,
          workflowStore,
          provider: new AnthropicProvider('claude-sonnet-4-5'),
          registry: new ExtensionRegistry(),
        },
        { definition: RATE_LIMITED_WF, params: {}, pollIntervalMs: 50 },
      );
      const elapsed = Date.now() - started;

      expect(result).toBe('failed');
      // Not honored: a two-hour Retry-After that had been obeyed would not return in a second.
      // deflake #371: widened 2000 → 15_000 for starvation immunity — stays below this cell's OWN
      // 20_000 budget below (so the assert can still fire before a timeout would mask it) while
      // still excluding the two-hour (7,200,000ms) Retry-After by a 480× margin.
      expect(elapsed).toBeLessThan(15_000);

      const runId = (await store.list())[0]!.id;
      const run = await store.get(runId);
      const entry = run.drive_failures!.entries[0]!;

      // OBSERVED — all four discriminators, from real producers:
      expect(entry.error_class).toBe('api_status');
      expect(entry.last_observed_status).toBe(429);
      expect(entry.retry_after_observed_ms).toBe(7_200_000);
      expect(entry.attempts_sdk).toBe(1); // the SDK obeyed x-should-retry and did not retry

      // The declared value reaches the WIRE, not just the record. A presence assertion would
      // prove nothing here — the Anthropic SDK emits this header on every request and would say
      // `600` (its own default) with realm's threading reverted entirely. `30` is the value only
      // the step's declared `llm_timeout_seconds` above can produce. Single-request journey, so
      // turn 1 is the only turn. (No OpenAI twin exists: that SDK emits this header only for a
      // per-REQUEST timeout, and realm passes its timeout at construction — probed on both SDKs.)
      expect(stub.headers[0]?.['x-stainless-timeout']).toBe('30');
      expect(entry.declared_per_attempt_ms).toBe(30_000); // the step's own authored key
      expect(entry.derived_ceiling_ms).toBe(151_500); // 30s x 3 + 1.5s backoff + 60s download

      // The operator's two surfaces carry them too — a record nobody can read is not a record.
      const findings = classifyRunHealth(run);
      const driveFinding = findings.find((f) => f.kind === 'drive_failing');
      expect(driveFinding?.reason).toContain('api_status');
      // The finding's EVIDENCE carries the discriminators too, not just its prose. An agent
      // reading run health consumes this object; a status that only exists inside a sentence is
      // not available to it.
      expect(driveFinding?.evidence).toMatchObject({
        error_class: 'api_status',
        last_observed_status: 429,
        retry_after_observed_ms: 7_200_000,
        declared_per_attempt_ms: 30_000,
        derived_ceiling_ms: 151_500,
      });

      const rendered = await inspectRun(runId, store, workflowStore);
      expect(rendered).toContain('Drive failures:');
      expect(rendered).toContain('(status 429)');
      expect(rendered).toContain('(Retry-After 7200000ms observed)');
      expect(rendered).toContain('(declared 30000ms)');
      expect(rendered).toContain('(ceiling 151500ms)');
      // The attempt suffix, pinned so its wording stays put: `attempts_sdk` counts attempts the
      // wrapper SAW COMPLETE, so "attempt 1" is the honest reading of one finished attempt.
      expect(rendered).toContain('(attempt 1)');
    } finally {
      await stub.close();
      if (originalKey === undefined) delete process.env['ANTHROPIC_API_KEY'];
      else process.env['ANTHROPIC_API_KEY'] = originalKey;
      if (originalBaseUrl === undefined) delete process.env['ANTHROPIC_BASE_URL'];
      else process.env['ANTHROPIC_BASE_URL'] = originalBaseUrl;
      rmSync(tempHome, { recursive: true, force: true });
    }
  }, 20_000);
});
