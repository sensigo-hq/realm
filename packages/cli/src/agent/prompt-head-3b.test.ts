// prompt-head-3b.test.ts — caching 3-B, Part C (C1, C2): `realm agent` cuts the prompt it sends at
// the brief's stable boundary, once, with the same set as `discloseForAgent`, and hands the provider
// the head's length as `cachePrefixChars`; the prompt itself is sent whole. Each cell names (a) the
// change that turns it red and (b) what it prints: the prompts and lengths, built from fake values.
import { describe, it, expect, vi } from 'vitest';
import type { WorkflowDefinition } from '@sensigo/realm';
import { CURRENT_WORKFLOW_SCHEMA_VERSION, createDefaultRegistry } from '@sensigo/realm';
import { InMemoryStore } from '@sensigo/realm-testing';
import { runAgent } from './run-agent.js';
import { LlmProvider, type CallStepWithMetaResult } from './providers/llm-provider.js';
import { discloseForAgent, discloseForAgentSplit } from './providers/agent-utils.js';

describe('caching 3-B C1 — discloseForAgentSplit', () => {
  it('the cut moves left by the span marks before it, and the pieces are discloseForAgent’s text', () => {
    // Two span marks (U+E000, U+E002) inside the head: `stripMarks` removes them before the law.
    const prompt = 'Fixed \uE000rules\uE002 for the step.\nTicket: token=FAKE-T-9 end';
    const rawCut = prompt.indexOf('Ticket:');
    const split = discloseForAgentSplit(prompt, rawCut);
    // (a) red when the cut is not moved by the marks (the head would end two characters late, in
    //     the tail's text); (b) prints the pieces.
    expect(split).toEqual({
      head: 'Fixed rules for the step.\n',
      tail: 'Ticket: token=[REDACTED] end',
    });
    expect(split!.head + split!.tail).toBe(discloseForAgent(prompt));
  });

  it('the guard refuses a split whose pieces differ from the disclosed text (a test-only stand-in: no real input on this edge makes them differ, D4.6-7)', () => {
    // (a) red when the guard is removed (a split would be returned for text that is not what is
    //     sent); (b) prints what came back.
    expect(discloseForAgentSplit('Fixed head. Tail.', 12, 'a stand-in disclosed text')).toBe(
      undefined,
    );
  });
});

const SCHEMA = {
  type: 'object',
  properties: { status: { type: 'string', enum: ['OK'] } },
  required: ['status'],
};
const HEAD = 'Review the ticket below against the house rules.\nTicket: ';
const flow = {
  id: 'head-3b',
  name: 'head-3b',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    review: {
      description: 'Review',
      execution: 'agent',
      prompt: 'Review the ticket below against the house rules.\nTicket: {{ run.params.ticket }}',
      output_schema: SCHEMA,
    },
    plain: {
      description: 'Plain',
      execution: 'agent',
      depends_on: ['review'],
      output_schema: SCHEMA,
    },
  },
} as WorkflowDefinition;

/** A provider that records what each call was handed, and answers `outputs` in order. */
function recording(outputs: Array<'BAD' | 'OK'>) {
  const calls: Array<{ prompt: string; cachePrefixChars: number | undefined }> = [];
  const provider = new (class extends LlmProvider {
    async callStep(): Promise<Record<string, unknown>> {
      throw new Error('callStep is not this path');
    }
    override async callStepWithMeta(
      prompt: string,
      _schema?: Record<string, unknown>,
      _profile?: string,
      opts?: { cachePrefixChars?: number },
    ): Promise<CallStepWithMetaResult> {
      calls.push({ prompt, cachePrefixChars: opts?.cachePrefixChars });
      return { output: { status: outputs.shift() ?? 'OK' } };
    }
  })();
  return { provider, calls };
}

describe('caching 3-B C2 — run-agent hands the provider the head’s length, the prompt whole', () => {
  it('the first attempt and the repair attempt carry the same head; a step without a prompt carries none', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { provider, calls } = recording(['BAD', 'OK', 'OK']);
    await runAgent(
      {
        store: new InMemoryStore(),
        workflowStore: {
          register: async () => {},
          get: async () => flow,
          list: async () => [flow],
        } as never,
        provider,
        registry: createDefaultRegistry(),
      },
      { definition: flow, params: { ticket: 'FAKE-TICKET-7' } },
    );
    // (a) red when `cachePrefixChars` is not passed, is not the head's length, the repair attempt
    //     cuts elsewhere, or the prompt is shortened; (b) prints each call's head and length.
    expect(
      calls.map((c) => ({
        head: c.cachePrefixChars === undefined ? undefined : c.prompt.slice(0, c.cachePrefixChars),
        whole: c.prompt.startsWith(HEAD),
        n: c.cachePrefixChars,
      })),
    ).toEqual([
      { head: HEAD, whole: true, n: HEAD.length },
      { head: HEAD, whole: true, n: HEAD.length },
      { head: undefined, whole: false, n: undefined },
    ]);
    // The repair attempt's prompt is the first prompt plus the feedback, sent whole.
    expect(calls[1]!.prompt.startsWith(calls[0]!.prompt)).toBe(true);
  });
});
