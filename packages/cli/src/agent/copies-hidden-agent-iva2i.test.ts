// copies-hidden-agent-iva2i.test.ts — gap 2, unit (iv-a2-i), check 6: `realm agent` is untouched by
// the MCP door's failure-text setting. A step's prompt that reads `$settlement.<step>.message` sends
// the model the failure's words, masked as every prompt `realm agent` sends is (its environment
// values hidden), never as their shape: the CLI's sets are never marked.
//
// The cell drives `runAgent` with Realm's Anthropic provider over a scripted `fetch` (a fake key)
// and reads the prompt the model was sent from the record (`model_text`). Fake secrets only. Every
// assertion carries (a) the break that turns it red and (b) what it prints.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryStore, createLeaseDouble } from '@sensigo/realm-testing';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  createDefaultRegistry,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { runAgent, type AgentDeps } from './run-agent.js';
import { AnthropicProvider } from './providers/anthropic-provider.js';

const ENV_NAME = 'IVA2I_FAKE_ENV_SECRET';
const ENV_VALUE = 'QXZENV-IVA2I-0001-FAKE';
const RAW = `upstream said ${ENV_VALUE} was declined today`;

beforeEach(() => {
  vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-fake-g2iva2i-0000');
  vi.stubEnv('REALM_NOT_SECRET', '');
  vi.stubEnv(ENV_NAME, ENV_VALUE);
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: 'msg_fake_g2iva2i',
            type: 'message',
            role: 'assistant',
            model: 'claude-test-1',
            content: [{ type: 'text', text: '{"ok":true}' }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    ),
  );
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** Every string inside `value`, depth first. */
function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(stringsIn);
  return [];
}

describe('gap 2 (iv-a2-i), check 6 — realm agent', () => {
  it('a prompt that reads the message sends its words, masked as today, never its shape', async () => {
    const def = {
      id: 'g2iva2i-agent',
      name: 'g2iva2i-agent',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: {
        boom: { description: 'Fail.', execution: 'auto', handler: 'boom', depends_on: [] },
        explain: {
          description: 'Explain.',
          execution: 'agent',
          depends_on: ['boom'],
          trigger_rule: 'one_failed',
          prompt: 'plain: {{ context.resources.$settlement.boom.message }}',
        },
      },
    } as unknown as WorkflowDefinition;
    const registry = createDefaultRegistry();
    registry.register('handler', 'boom', {
      id: 'boom',
      execute: async () => {
        throw new Error(RAW);
      },
    } as never);
    const store = new InMemoryStore({ leases: createLeaseDouble() });
    const runId = (await store.create({ workflowId: def.id, workflowVersion: 1, params: {} }))
      .record.id;
    const deps = {
      store,
      workflowStore: { register: async () => {}, get: async () => def, list: async () => [def] },
      provider: new AnthropicProvider('claude-test-1'),
      registry,
    } as unknown as AgentDeps;
    // The drive fails `boom`, then runs the step its failure allowed.
    await runAgent(deps, { existingRunId: runId, definition: def, params: {} }).catch(
      (thrown: unknown) => thrown,
    );
    const run = (await store.get(runId)).record;
    const sent = stringsIn(
      run.evidence.filter((e) => e.step_id === 'explain' && e.kind !== 'gate_response').at(-1)
        ?.model_text,
    ).filter((t) => t.includes('plain: '));
    // (a) red when the mark is read from any set (realm agent's prompt shows `‹string, N
    //     characters›`), or the prompt's masking changes (the environment value shows); (b) prints
    //     the prompt's line as sent.
    expect(sent.map((t) => t.slice(t.indexOf('plain: ')).split('\n')[0])).toEqual([
      "plain: Handler 'boom' threw: upstream said [REDACTED] was declined today",
    ]);
  });
});
