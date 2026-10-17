// append-trace-627.test.ts — #627 W correction 1 (A2): `append_trace`'s error reply is worded by the
// door. Its error path renders a reply whose `respond` remedy `getWorkflowForRun` attaches for a live
// gate; before the fix it rendered with no host, so under every value it named the answer call. The
// cell runs THROUGH `createRealmMcpServer` — never a hand-built `registerAppendTrace` options object,
// whose own door would turn it green while the server left the door out.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure: whether
// the reply names an answer way, and its hint — never a token.
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

/** A `withheld` server with a run waiting at its question, and the registered copy's path. */
async function atGate() {
  const dir = await mkdtemp(join(tmpdir(), 'realm-at-627-'));
  const runStore = new JsonFileStore(join(dir, 'runs'));
  const workflowStore = new JsonWorkflowStore(join(dir, 'wf'));
  await workflowStore.register(loadWorkflowFromString(YAML));
  const server = createRealmMcpServer({ runStore, workflowStore, gateAnswers: 'withheld' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'at-627', version: '0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const text = async (name: string, args: Record<string, unknown>) =>
    (
      (await client.callTool({ name, arguments: args })) as {
        content: Array<{ text: string }>;
      }
    ).content[0]!.text;
  const started = JSON.parse(await text('start_run', { workflow_id: 'at627', params: {} })) as {
    run_id: string;
  };
  return { copy: join(dir, 'wf', 'at627.json'), runId: started.run_id, text };
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
    const s = await atGate();
    await damage(s.copy);
    const reply = await s.text('append_trace', {
      run_id: s.runId,
      step_id: 'after',
      entries: [{ event: 'note' }],
    });
    const parsed = JSON.parse(reply) as Record<string, unknown>;
    // (a) red when the server passes no door to append_trace (its reply words the gate's remedy as
    //     the answer call); (b) prints the reply's status, whether it names an answer way, and the hint.
    expect({
      status: parsed['status'],
      namesAnswer: /submit_human_response|call_with|claim_token|present_question/.test(reply),
      waitsOutside: String(parsed['context_hint']).includes('outside this conversation'),
    }).toEqual({ status: 'error', namesAnswer: false, waitsOutside: true });
  });
});
