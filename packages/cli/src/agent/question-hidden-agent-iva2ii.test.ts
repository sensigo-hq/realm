// question-hidden-agent-iva2ii.test.ts — gap 2, unit (iv-a2-ii), checks 2 and 6: an approval question
// that read a failure's message, on a gate `realm agent` opened (on the CLI's own SQLite home). People
// read its words: `realm agent`'s print, `realm run inspect`, the Slack post and the answered gate's
// `gate_message`. Its twin is made by the mint whatever door opened the gate, so `realm mcp
// --failure-text hidden`, reading the same home later, serves the twin.
//
// The drive is `runAgent` with a gate handler that reads the gate the way each surface does, then
// answers it. Every assertion carries (a) the break that turns it red and (b) what it prints. Fake
// texts only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  createDefaultRegistry,
  submitHumanResponse,
  type PendingGate,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { createRealmMcpServer } from '@sensigo/realm-mcp';
import { runAgent } from './run-agent.js';
import { LlmProvider } from './providers/llm-provider.js';
import { slackView } from './gate/slack-gate-notifier.js';
import { makeTempHome, type TempHome } from '../test-support/temp-home.js';

const CLI = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const RAW = 'upstream said order 77 for card 5500 was declined today';
const MSG = `Handler 'boom' threw: ${RAW}`;
const SHAPE = `‹string, ${MSG.length} characters›`;

let logSpy: ReturnType<typeof vi.spyOn>;
const homes: TempHome[] = [];
beforeEach(() => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const h of homes.splice(0)) await h.cleanup();
});

const def = {
  id: 'g2iva2ii-agent',
  name: 'g2iva2ii-agent',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    boom: { description: 'Fail.', execution: 'auto', handler: 'boom', depends_on: [] },
    review: {
      description: 'Review.',
      execution: 'auto',
      handler: 'ok',
      depends_on: ['boom'],
      trigger_rule: 'one_failed',
      trust: 'human_confirmed',
      gate: {
        choices: ['approve'],
        message: 'why: {{ context.resources.$settlement.boom.message }}',
      },
    },
  },
} as unknown as WorkflowDefinition;

describe('gap 2 (iv-a2-ii), checks 2 and 6 — a gate realm agent opened', () => {
  it("people read the words (realm agent, realm run inspect, Slack, the answer's gate_message); realm mcp under hidden serves the twin", async () => {
    const h = await makeTempHome();
    homes.push(h);
    await h.home.workflowStore.register(def);
    const registry = createDefaultRegistry();
    registry.register('handler', 'boom', {
      id: 'boom',
      execute: async () => {
        throw new Error(RAW);
      },
    } as never);
    registry.register('handler', 'ok', {
      id: 'ok',
      execute: async () => ({ data: { ok: true } }),
    } as never);
    const store = h.home.runStore;
    const seen: {
      runId?: string;
      gate?: PendingGate;
      served?: string | undefined;
      receipt?: string[] | undefined;
      inspect?: string | undefined;
      slack?: string | undefined;
    } = {};
    await runAgent(
      {
        store,
        workflowStore: h.home.workflowStore,
        provider: new (class extends LlmProvider {
          async callStep(): Promise<Record<string, unknown>> {
            return {};
          }
        })(),
        registry,
        gateHandler: async (runId: string, gate: PendingGate) => {
          seen.runId = runId;
          seen.gate = gate;
          // `realm mcp --failure-text hidden` on the same home, while the gate is open.
          const server = createRealmMcpServer({
            runStore: store,
            workflowStore: h.home.workflowStore,
            traceBufferStore: h.home.traceBufferStore,
            failedAttemptStore: h.home.failedAttemptStore,
            registry,
            failureText: 'hidden',
          });
          const [ct, st] = InMemoryTransport.createLinkedPair();
          const client = new Client({ name: 'question-hidden-agent-iva2ii', version: '0' });
          await Promise.all([server.connect(st), client.connect(ct)]);
          const raw = (await client.callTool({
            name: 'get_run_state',
            arguments: { run_id: runId },
          })) as { content: Array<{ text?: string }> };
          const state = JSON.parse(raw.content[0]?.text ?? '{}') as {
            pending_gate?: { resolved_message?: string };
            disclosure?: { shaped?: string[] };
          };
          seen.served = state.pending_gate?.resolved_message;
          seen.receipt = state.disclosure?.shaped;
          await client.close();
          // `realm run inspect`, as a person runs it.
          const inspected = spawnSync(process.execPath, [CLI, 'run', 'inspect', runId], {
            env: { PATH: process.env['PATH'] ?? '', HOME: h.root },
            encoding: 'utf8',
            timeout: 60_000,
          });
          seen.inspect = inspected.stdout
            .split('\n')
            .find((l) => l.trim().startsWith('Question:'))
            ?.trim();
          seen.slack = slackView(gate).question_text;
          await submitHumanResponse(store, def, { runId, gateId: gate.gate_id, choice: 'approve' });
        },
      } as never,
      {
        definition: def,
        params: {},
        inFlightPollMs: 5,
        inFlightWatchMs: 20,
        pollIntervalMs: 20,
      } as never,
    );
    const printed = logSpy.mock.calls.map((c: unknown[]) => c.map(String).join(' ')).join('\n');
    const after = (await store.get(seen.runId!)).record;
    const answer = after.evidence.find((e) => e.kind === 'gate_response');
    // (a) red when a person's surface reads the twin (the CLI, Slack or the answer shows a shape),
    //     when the twin is made only under a hidden door's set (realm agent's gate then has none,
    //     and realm mcp shows the words), or when the twin outlives the answer; (b) prints each
    //     surface's text.
    expect({
      agentPrint: printed.includes(`why: ${MSG}`) && !printed.includes(SHAPE),
      inspect: seen.inspect?.includes(`why: ${MSG}`) && !seen.inspect.includes(SHAPE),
      slack: seen.slack,
      stored: { people: seen.gate?.resolved_message, twin: seen.gate?.resolved_message_shaped },
      served: seen.served,
      receipt: seen.receipt,
      gateMessage: answer?.gate_message,
      gateAfter: after.pending_gate,
    }).toEqual({
      agentPrint: true,
      inspect: true,
      slack: `why: ${MSG}`,
      stored: { people: `why: ${MSG}`, twin: `why: ${SHAPE}` },
      served: `why: ${SHAPE}`,
      receipt: expect.arrayContaining(['pending_gate.resolved_message']),
      gateMessage: `why: ${MSG}`,
      gateAfter: undefined,
    });
  }, 90_000);
});
