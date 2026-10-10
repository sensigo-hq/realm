// output-source-625.test.ts — issue #625 PR-2a, the last prompt's F4, over a real MCP client:
// `get_run_state` renders nothing new for `output_source` — its step view (`include_steps`) carries each
// step's attempts and their cost, not its evidence entries — and its page says so.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  JsonFileStore,
  JsonWorkflowStore,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createRealmMcpServer } from '../server.js';

const PAGE = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../docs/reference/mcp/run-state-and-health.md',
);

const WF = {
  id: 'os-mcp-625',
  name: 'os-mcp-625',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: { fromParams: { description: 'From the params.', execution: 'auto', depends_on: [] } },
} as WorkflowDefinition;

describe('#625 PR-2a, F4 — get_run_state shows no output_source, and its page says why', () => {
  it('include_steps: the step view holds attempts and their cost, not the entry’s output_source; the record has it', async () => {
    const flat = (t: string) => t.replace(/\s+/g, ' ');
    const sentence =
      "It holds each step's attempts and their cost, not its evidence entries, so it does not show where a bare `auto` step's output came from (`output_source`); `realm run inspect` shows that, and so does the run's record:";
    // (a) red when the page stops saying why the field is not here; (b) prints the sentence.
    expect(flat(readFileSync(PAGE, 'utf8')), `the page no longer says: ${sentence}`).toContain(
      sentence,
    );
    const dir = await mkdtemp(join(tmpdir(), 'realm-os-mcp-625-'));
    const runStore = new JsonFileStore(join(dir, 'runs'));
    const workflowStore = new JsonWorkflowStore(join(dir, 'wf'));
    await workflowStore.register(WF);
    const server = createRealmMcpServer({ runStore, workflowStore });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'os-mcp-625', version: '0' });
    await Promise.all([server.connect(st), client.connect(ct)]);
    const call = async (name: string, args: Record<string, unknown>) =>
      JSON.parse(
        ((await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }> })
          .content[0]!.text,
      ) as Record<string, unknown>;
    const runId = (await call('start_run', { workflow_id: WF.id }))['run_id'] as string;
    const state = await call('get_run_state', { run_id: runId, include_steps: true });
    const record = await runStore.get(runId);
    // (a) red when get_run_state starts carrying `output_source` (its page would then be false), or
    //     the record stops carrying it; (b) prints both.
    expect({
      inReply: JSON.stringify(state).includes('output_source'),
      inRecord: record.evidence.find((e) => e.step_id === 'fromParams')?.output_source,
    }).toEqual({ inReply: false, inRecord: 'run_params' });
  });
});
