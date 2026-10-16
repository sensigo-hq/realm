// issue #759 (Part F, the cross cell over three doors): an engine step refused for its input is
// named by the same cannot-run line on the library door (`libraryCannotRunWords`), the CLI door
// (`cannotRunClause`) and the MCP door (a real `start_run` reply's hint) — each prints the
// pending view's ONE composed refusal, which now names every problem. A failure prints the three
// lines: key names and rules only.
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  ExtensionRegistry,
  JsonFileStore,
  JsonWorkflowStore,
  composeWaysAt,
  libraryCannotRunWords,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { createRealmMcpServer } from '@sensigo/realm-mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { cannotRunClause } from './ways-renderer.js';

const refusedHead: WorkflowDefinition = {
  id: 'refused-head-759',
  name: 'refused head',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    compute: {
      description: 'Compute.',
      execution: 'auto',
      depends_on: [],
      input_schema: {
        type: 'object',
        required: ['n'],
        properties: { m: { type: 'number' } },
        additionalProperties: false,
      },
    },
    summarize: { description: 'Summarize.', execution: 'agent', depends_on: [] },
  },
};

/** The run's params break three rules of `compute`'s input_schema. */
const PARAMS = { m: 'x', extra: 1 };
const REFUSAL =
  "Invalid input for step 'compute': the input must have required property 'n'; 'extra' is not allowed; 'm' must be number";

describe('issue #759 — the cannot-run line is the same three-problem sentence on every door', () => {
  it("library, CLI and MCP print the pending view's one refusal (red: a door composing its own sentence — the first problem only)", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'realm-759-doors-'));
    try {
      const runStore = new JsonFileStore(join(dir, 'runs'));
      const workflowStore = new JsonWorkflowStore(join(dir, 'wf'));
      await workflowStore.register(refusedHead);
      const server = createRealmMcpServer({
        runStore,
        workflowStore,
        registry: new ExtensionRegistry(),
      });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'cannot-run-759', version: '0' });
      await Promise.all([server.connect(st), client.connect(ct)]);
      const raw = (await client.callTool({
        name: 'start_run',
        arguments: { workflow_id: refusedHead.id, params: PARAMS },
      })) as { content: Array<{ text: string }> };
      const reply = JSON.parse(raw.content[0]!.text) as { run_id: string; context_hint: string };
      await client.close();

      const run = await runStore.get(reply.run_id);
      const entry = composeWaysAt(run, new Date(), {
        definition: refusedHead,
        registry: new ExtensionRegistry(),
      }).unavailable.find((u) => u.verb === 'run_step' && u.step === 'compute');
      const line = `'compute' cannot run (input_schema): ${REFUSAL}`;
      expect({
        library: entry === undefined ? undefined : libraryCannotRunWords(entry),
        cli: entry === undefined ? undefined : cannotRunClause(entry),
        mcp: reply.context_hint.includes(`${line}.`),
      }).toEqual({ library: line, cli: line, mcp: true });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
