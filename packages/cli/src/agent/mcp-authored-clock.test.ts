// mcp-authored-clock.test.ts — issue #412: the bound an AGENT authored through MCP is the bound
// the drive applies.
//
// The two halves of this were pinned in their own packages — create_workflow copies the field
// into the registered definition (mcp-server), and the drive derives its clock from a step's
// `llm_timeout_seconds` (cli) — and neither one proves the join. A field that is copied into a
// definition nobody reads, or read from a shape nobody produces, is exactly the silently-inert
// authored bound this issue exists to remove. So the join is driven here, in one cell, with the
// real tool writing to a real store and the real drive reading it back.
//
// The provider seam is where this stops: what a live model request does under the ceiling is
// covered by the budget suite (#401). What this pins is that the number an agent typed into
// create_workflow arrives at the clock, with its provenance intact.
import { describe, it, expect, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { JsonFileStore, JsonWorkflowStore, ExtensionRegistry } from '@sensigo/realm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolveMcpServerEntry } from './test-support/mcp-server-entry.js';
import { makeJourneyHome } from './test-support/composed-journey.js';
import { runAgent, type AgentDeps } from './run-agent.js';
import { LlmProvider } from './providers/llm-provider.js';
import type { LlmClock } from './providers/agent-utils.js';

class ClockSpy extends LlmProvider {
  clock: LlmClock | undefined;
  async callStep(
    _p: string,
    _s?: Record<string, unknown>,
    _a?: string,
    opts?: { llmClock?: LlmClock },
  ): Promise<Record<string, unknown>> {
    this.clock = opts?.llmClock;
    throw new Error('stop here — the clock is what this cell is about');
  }
}

describe('#412 — an MCP-authored llm_timeout_seconds reaches the drive clock', () => {
  it('create_workflow (over stdio) → registered definition → the clock the step drives under', async () => {
    // The tool is called the way an agent calls it: through realm's OWN MCP server, spawned as a
    // real child over stdio. Not the handler function — that is not on the package's public
    // surface, and reaching past the exports map to import it would be testing a path no agent
    // uses. HOME is redirected so the child registers into a temp store the parent then reads.
    const tempHome = makeJourneyHome('mcp-authored-clock-');
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolveMcpServerEntry()],
      env: { ...process.env, HOME: tempHome } as Record<string, string>,
    });
    const client = new Client({ name: 'mcp-authored-clock', version: '0' });

    let workflowId: string;
    try {
      await client.connect(transport);
      const called = (await client.callTool({
        name: 'create_workflow',
        arguments: {
          goal: 'Summarise a document',
          steps: [{ id: 'summarise', description: 'Produce a summary', llm_timeout_seconds: 45 }],
        },
      })) as { content: Array<{ type: string; text?: string }> };
      const envelope = JSON.parse(called.content[0]!.text!) as {
        status: string;
        data: Record<string, unknown>;
      };
      expect(envelope.status).toBe('ok');
      workflowId = envelope.data['workflow_id'] as string;
    } finally {
      await client.close();
    }

    // 2. It survives into the registered definition — read back out of the child's real store.
    const workflowStore = new JsonWorkflowStore(join(tempHome, '.realm', 'workflows'));
    const definition = await workflowStore.get(workflowId);
    expect(definition.steps['summarise']?.llm_timeout_seconds).toBe(45);
    expect(definition.steps['summarise']?.execution).toBe('agent');

    // 3. And the drive resolves ITS clock from that, with the provenance that says somebody chose
    //    the value — which is what keeps it out of the record when nobody did.
    const provider = new ClockSpy();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await runAgent(
      {
        store: new JsonFileStore(join(tempHome, '.realm', 'runs')),
        workflowStore,
        provider,
        registry: new ExtensionRegistry(),
      } as unknown as AgentDeps,
      { definition, params: {} },
    );
    vi.restoreAllMocks();

    expect(provider.clock?.declaredPerAttemptMs).toBe(45_000);
    expect(provider.clock?.perAttemptSource).toBe('step');
    // 45s x 3 attempts + 1.5s backoff + the 60s download allowance.
    expect(provider.clock?.ceilingMs).toBe(196_500);

    rmSync(tempHome, { recursive: true, force: true });
  }, 30_000);
});
