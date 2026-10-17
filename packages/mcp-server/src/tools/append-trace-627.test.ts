// append-trace-627.test.ts — #627 W correction 1 (A2): `append_trace`'s error reply is worded by the
// door. Its error path renders a reply whose remedy `getWorkflowForRun` attaches for a live gate;
// before the fix it rendered with no host, so under every value it named the answer call. The cell
// runs THROUGH `createRealmMcpServer` — never a hand-built `registerAppendTrace` options object,
// whose own door would turn it green while the server left the door out.
//
// Correction 2 (3.1, MCP F7): the remedy at a live gate whose copy cannot be read is the REPAIR (the
// listing's `register` way), never the answer, under every value — so neither `append_trace` nor
// `submit_human_response` names an answer tool there, and on the doors that hand questions to the
// person the question is said to wait outside this conversation once the copy is repaired.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure: whether
// the reply's hint and next_actions name an answer way, and the hint — never a token.
import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  JsonFileStore,
  JsonWorkflowStore,
  loadWorkflowFromString,
} from '@sensigo/realm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createRealmMcpServer } from '../server.js';

const YAML = [
  'id: at627',
  'name: at627',
  'version: 1',
  'steps:',
  '  q:',
  '    description: Ask.',
  '    execution: auto',
  '    trust: human_confirmed',
  '    gate:',
  '      choices: [approve, reject]',
  '  after:',
  '    description: After.',
  '    execution: agent',
  '    depends_on: [q]',
].join('\n');

/** Names an answer way, in a reply's hint or next_actions (correction 2 adds the CLI command). */
const ANSWER_WAY = /submit_human_response|call_with|claim_token|present_question|run respond/;
/** The handing-off doors' sentence for a register remedy (correction 2, 3.1). */
const WAITS_ONCE_REPAIRED =
  'Once the copy is repaired, the question waits for an answer outside this conversation.';

type Door = 'offered' | 'asked' | 'withheld';

/** A server with a run waiting at its question, the registered copy's path, and a tool caller. */
async function atGate(gateAnswers: Door, forms = false) {
  const dir = await mkdtemp(join(tmpdir(), 'realm-at-627-'));
  const runStore = new JsonFileStore(join(dir, 'runs'));
  const workflowStore = new JsonWorkflowStore(join(dir, 'wf'));
  await workflowStore.register(loadWorkflowFromString(YAML));
  const server = createRealmMcpServer({ runStore, workflowStore, gateAnswers });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: 'at-627', version: '0' },
    forms ? { capabilities: { elicitation: { form: {} } } } : {},
  );
  // A forms client that never answers: the opening form comes back, the question stays open.
  if (forms) {
    const { ElicitRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');
    client.setRequestHandler(ElicitRequestSchema, async () => ({ action: 'decline' }));
  }
  await Promise.all([server.connect(st), client.connect(ct)]);
  await new Promise((r) => setTimeout(r, 20));
  const text = async (name: string, args: Record<string, unknown>) =>
    (
      (await client.callTool({ name, arguments: args })) as {
        content: Array<{ text: string }>;
      }
    ).content[0]!.text;
  const started = JSON.parse(await text('start_run', { workflow_id: 'at627', params: {} })) as {
    run_id: string;
  };
  const gateId = (await runStore.get(started.run_id)).pending_gate!.gate_id;
  return { copy: join(dir, 'wf', 'at627.json'), runId: started.run_id, gateId, text };
}

/** A reply's hint and next_actions, when it is Realm's JSON reply; nothing for an SDK error text. */
function judged(reply: string): { hint: string; next: string } {
  try {
    const parsed = JSON.parse(reply) as Record<string, unknown>;
    return {
      hint: String(parsed['context_hint'] ?? ''),
      next: JSON.stringify(parsed['next_actions'] ?? []),
    };
  } catch {
    return { hint: '', next: '' };
  }
}

describe('#627 W correction 1 (A2) — append_trace’s error reply names no answer way under withheld', () => {
  it.each([
    ['unreadable', async (copy: string) => writeFile(copy, '{ not json')],
    [
      'newer (W-r2)',
      async (copy: string) => {
        const parsed = JSON.parse(await readFile(copy, 'utf8')) as Record<string, unknown>;
        await writeFile(
          copy,
          JSON.stringify({ ...parsed, schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION + 1 }),
        );
      },
    ],
  ] as const)('the registered copy %s', async (_label, damage) => {
    const s = await atGate('withheld');
    await damage(s.copy);
    const reply = await s.text('append_trace', {
      run_id: s.runId,
      step_id: 'after',
      entries: [{ event: 'note' }],
    });
    const parsed = JSON.parse(reply) as Record<string, unknown>;
    const { hint, next } = judged(reply);
    // (a) red when the server passes no door to append_trace (its reply words the gate's remedy as
    //     the answer call); (b) prints the reply's status, whether it names an answer way, and the hint.
    expect({
      status: parsed['status'],
      namesAnswer: ANSWER_WAY.test(hint) || ANSWER_WAY.test(next),
      waitsOutside: hint.includes('outside this conversation'),
    }).toEqual({ status: 'error', namesAnswer: false, waitsOutside: true });
  });
});

describe('#627 W correction 2 (3.1, MCP F7) — a copy Realm cannot read: the way on is the repair, on every door', () => {
  it.each([
    ['offered', 'offered', false, false],
    ['asked, a client without forms', 'asked', false, false],
    ['withheld', 'withheld', false, true],
    ['asked, a client with forms', 'asked', true, true],
  ] as const)(
    '%s: neither append_trace nor submit_human_response names an answer way',
    async (_label, door, forms, handsOff) => {
      const s = await atGate(door, forms);
      await writeFile(s.copy, '{ not json');
      const trace = judged(
        await s.text('append_trace', {
          run_id: s.runId,
          step_id: 'after',
          entries: [{ event: 'note' }],
        }),
      );
      const answer = judged(
        await s.text('submit_human_response', {
          run_id: s.runId,
          gate_id: s.gateId,
          choice: 'approve',
        }),
      );
      // (a) red when the `respond` remedy is restored (the agent is told to answer, then refused in a
      //     loop), or the server passes no door to append_trace (the handing-off sentence goes);
      //     (b) prints whether each reply names an answer way, and whether the trace's hint holds the
      //     handing-off doors' sentence.
      expect({
        traceNamesAnswer: ANSWER_WAY.test(trace.hint) || ANSWER_WAY.test(trace.next),
        answerNamesAnswer: ANSWER_WAY.test(answer.hint) || ANSWER_WAY.test(answer.next),
        waitsOnceRepaired: trace.hint.includes(WAITS_ONCE_REPAIRED),
      }).toEqual({
        traceNamesAnswer: false,
        answerNamesAnswer: false,
        waitsOnceRepaired: handsOff,
      });
    },
  );

  it('get_run_state on a handing-off door: the elsewhere entry for the repair holds the sentence', async () => {
    const s = await atGate('withheld');
    await writeFile(s.copy, '{ not json');
    const read = JSON.parse(await s.text('get_run_state', { run_id: s.runId })) as {
      elsewhere?: Array<{ verb: string; human_readable: string }>;
    };
    const register = (read.elsewhere ?? []).find((e) => e.verb === 'register');
    // (a) red when the elsewhere words drop the handing-off sentence, or (3.2) offer the COPY as a
    //     file to register from ("again from <path>"); (b) prints the entry's words.
    expect({
      words: register?.human_readable,
      againFrom: register?.human_readable.includes('again from') ?? true,
    }).toEqual({
      words: `Workflow 'at627''s registered copy (${s.copy}) cannot be used; an operator repairs it, outside this conversation. ${WAITS_ONCE_REPAIRED}`,
      againFrom: false,
    });
  });
});
