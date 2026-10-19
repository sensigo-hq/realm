// copy-819.test.ts — #819 (03) on the MCP door. U2: a registered copy that is valid JSON at the
// current format but has no `steps` object is named, with its repair, by `get_run_state` and
// `advance_run` — never a raw internal error (W's walk 1: "Cannot convert undefined or null to
// object"). MCP's `abandon_run` stays definition-blind: a run waiting at a gate is refused there,
// whatever its copy. #819 correction 1 (01): at a live question a hex-suffixed workflow with no copy
// reads `not_registered` in the agent's replies too — never "created by an agent".
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure: codes,
// texts — never a token.
import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileStore, JsonWorkflowStore } from '@sensigo/realm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createRealmMcpServer } from './server.js';

type Reply = Record<string, unknown>;

/** One session on a server over a fresh run store and workflow store, and a run at gate `g-1`. */
async function atGate(workflowId: string, copy?: unknown) {
  const dir = await mkdtemp(join(tmpdir(), 'realm-copy-819-'));
  const wfDir = join(dir, 'wf');
  await mkdir(wfDir, { recursive: true });
  if (copy !== undefined) await writeFile(join(wfDir, `${workflowId}.json`), JSON.stringify(copy));
  const runStore = new JsonFileStore(join(dir, 'runs'));
  const workflowStore = new JsonWorkflowStore(wfDir);
  const { run } = await runStore.create({ workflowId, workflowVersion: 1, params: {} });
  await runStore.update({
    ...run,
    pending_gate: {
      gate_id: 'g-1',
      step_name: 'approve',
      preview: {},
      choices: ['ship', 'hold'],
      opened_at: '2026-01-01T00:00:00.000Z',
    },
  });
  const server = createRealmMcpServer({ runStore, workflowStore });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'copy-819', version: '0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const call = async (name: string, args: Reply): Promise<Reply> => {
    const r = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ text: string }>;
    };
    return JSON.parse(r.content[0]!.text) as Reply;
  };
  return { call, runId: run.id, runStore, file: join(wfDir, `${workflowId}.json`) };
}

describe('#819 U2 — a copy with no steps, over MCP', () => {
  it('get_run_state and advance_run name the copy and its repair, with no internal error', async () => {
    const s = await atGate('plain-gate', {
      id: 'plain-gate',
      name: 'plain-gate',
      version: 1,
      schema_version: 1,
    });
    const state = await s.call('get_run_state', { run_id: s.runId });
    const advanced = await s.call('advance_run', { run_id: s.runId });
    const text = (r: Reply) => JSON.stringify(r);
    const internal = (r: Reply) =>
      /Cannot convert undefined|Cannot read properties|ENGINE_INTERNAL|definition\.steps must be/.test(
        text(r),
      );
    const elsewhere = (state['elsewhere'] as Array<{ verb: string; human_readable: string }>) ?? [];
    // (a) red when the copy passes the copy check (each tool then fails inside: W's walk 1 —
    //     "Cannot convert undefined or null to object", "definition.steps must be an object"), or a
    //     reply names neither the copy nor its repair; (b) prints, per tool, what it names.
    expect({
      state: {
        elsewhere: elsewhere.map((e) => `${e.verb}: ${e.human_readable}`),
        internal: internal(state),
      },
      advanced: {
        status: advanced['status'],
        copy: text(advanced).includes(
          "the registered copy of 'plain-gate' is JSON but not a workflow object (its steps is not an object)",
        ),
        repair: text(advanced).includes(
          're-register the workflow from its source (realm workflow register <path-to-workflow>)',
        ),
        internal: internal(advanced),
      },
    }).toEqual({
      state: {
        elsewhere: [
          `register: Workflow 'plain-gate''s registered copy (${s.file}) cannot be used; an operator repairs it, outside this conversation.`,
        ],
        internal: false,
      },
      advanced: { status: 'error', copy: true, repair: true, internal: false },
    });
  });
});

describe('#819 — abandon_run stays definition-blind', () => {
  it('a run waiting at a gate whose hex-suffixed workflow has no copy is refused by abandon_run, as every gate run is', async () => {
    const s = await atGate('triage-0123456789abcdef');
    const reply = await s.call('abandon_run', { run_id: s.runId, reason: 'stuck' });
    // (a) red when MCP's abandon ends a question — under `withheld` the agent's tool, and the agent
    //     never ends a person's question; (b) prints the code and the run's phase.
    expect({
      code: reply['error_code'],
      phase: (await s.runStore.get(s.runId)).run_phase,
    }).toEqual({ code: 'STATE_TRANSITION_DENIED', phase: 'gate_waiting' });
  });
});

describe("#819 correction 1 (01) — the agent is never told a gate run's workflow was created by an agent", () => {
  it('submit_human_response on a run at a gate whose hex-suffixed workflow has no copy: the message says it is not registered', async () => {
    const s = await atGate('ops-review-0123456789abcdef');
    const reply = await s.call('submit_human_response', {
      run_id: s.runId,
      gate_id: 'g-1',
      choice: 'ship',
    });
    const text = JSON.stringify(reply);
    // (a) red when the id's shape decides at a live question (the message then says the workflow
    //     was created by an agent and offers no register way); (b) prints the code and what the
    //     message says.
    expect({
      code: reply['error_code'],
      agent: text.includes('created by an agent'),
      notRegistered: text.includes(
        "Workflow 'ops-review-0123456789abcdef' is not registered in this workflow store",
      ),
    }).toEqual({ code: 'STATE_WORKFLOW_NOT_FOUND', agent: false, notRegistered: true });
  });
});
