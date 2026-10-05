// start-run-stopped-step-676.test.ts — issue #676 (review): `start_run`'s reply says
// `command: 'start_run'`, so the step a non-ok reply belongs to is named only in `stopped_step`.
// The cells call the REGISTERED tool through an in-memory MCP client, so they read what an agent
// reads, after the tool's own relabelling.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { JsonFileStore, JsonWorkflowStore, CURRENT_WORKFLOW_SCHEMA_VERSION } from '@sensigo/realm';
import type { ResponseEnvelope, WorkflowDefinition } from '@sensigo/realm';
import { registerStartRun } from './start-run.js';

let runStore: JsonFileStore;
let workflowStore: JsonWorkflowStore;

beforeEach(async () => {
  runStore = new JsonFileStore(await mkdtemp(join(tmpdir(), 'sr676-run-')));
  workflowStore = new JsonWorkflowStore(await mkdtemp(join(tmpdir(), 'sr676-wf-')));
});

function workflow(id: string, steps: WorkflowDefinition['steps']): WorkflowDefinition {
  return { id, name: id, version: 1, schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION, steps };
}

/** Registers `def`, then calls the registered `start_run` tool once and returns its reply. */
async function startRun(def: WorkflowDefinition): Promise<ResponseEnvelope> {
  await workflowStore.register(def);
  const server = new McpServer({ name: 'test', version: '0' });
  registerStartRun(server, { runStore, workflowStore });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0' });
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({
      name: 'start_run',
      arguments: { workflow_id: def.id, params: {} },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    return JSON.parse(text) as ResponseEnvelope;
  } finally {
    await client.close();
  }
}

describe('start_run names the step a non-ok reply belongs to', () => {
  it('the first auto step stops the call: command is the tool, stopped_step names the step', async () => {
    const reply = await startRun(
      workflow('sr676-first', {
        first: { description: 'Runs first', execution: 'auto', handler: 'not_here' },
      }),
    );
    // (a) red when the engine names only steps run after the called one — the tool's relabel then
    //     leaves no step name; (b) prints command, status, code and stopped_step.
    expect({
      command: reply.command,
      status: reply.status,
      error_code: reply.error_code,
      stopped_step: reply.stopped_step,
    }).toEqual({
      command: 'start_run',
      status: 'error',
      error_code: 'ENGINE_HANDLER_NOT_REGISTERED',
      stopped_step: 'first',
    });
  });

  it('a step the engine ran after the first one stops the call: stopped_step names that step', async () => {
    const reply = await startRun(
      workflow('sr676-second', {
        first: { description: 'Runs first', execution: 'auto' },
        second: {
          description: 'Runs second',
          execution: 'auto',
          depends_on: ['first'],
          handler: 'not_here',
        },
      }),
    );
    // (a) red when the tool overwrites the engine's stopped_step; (b) prints command, status and
    //     stopped_step.
    expect({
      command: reply.command,
      status: reply.status,
      stopped_step: reply.stopped_step,
    }).toEqual({ command: 'start_run', status: 'error', stopped_step: 'second' });
  });

  it('CONTROL — an ok reply carries no stopped_step', async () => {
    const reply = await startRun(
      workflow('sr676-ok', {
        first: { description: 'Runs first', execution: 'auto' },
        draft: { description: 'Then an agent step', execution: 'agent', depends_on: ['first'] },
      }),
    );
    // (a) red when an ok reply gains the field; (b) prints status and the field's presence.
    expect({ status: reply.status, has_stopped_step: 'stopped_step' in reply }).toEqual({
      status: 'ok',
      has_stopped_step: false,
    });
  });
});
