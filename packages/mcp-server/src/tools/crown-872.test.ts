// crown-872.test.ts — #872 (b1) correction 1, through the door (an in-memory MCP client on a server
// with a registered definition). AC1 (C1, the crown): reading every settled step of a 300-step
// fan-out takes at most two calls — the asked steps are cut last. AC5 (C5): (a)'s pointer stays true
// when the ceiling cuts `engine_runnable`. Beside each: (a) the change that turns it red; (b) what it
// prints on failure — counts, sizes and the pointer's words, never a value.
import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  ExtensionRegistry,
  JsonFileStore,
  JsonWorkflowStore,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createRealmMcpServer } from '../server.js';
import { REPLY_CEILING_CHARS } from '../render-reply.js';

type Reply = Record<string, unknown>;

async function door(definition: WorkflowDefinition, registry?: ExtensionRegistry) {
  const dir = await mkdtemp(join(tmpdir(), 'realm-crown-872-'));
  const runStore = new JsonFileStore(join(dir, 'runs'));
  const workflowStore = new JsonWorkflowStore(join(dir, 'wf'));
  await workflowStore.register(definition);
  const server = createRealmMcpServer({
    runStore,
    workflowStore,
    ...(registry !== undefined ? { registry } : {}),
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'crown-872', version: '0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const call = async (name: string, args: Reply): Promise<{ size: number; json: Reply }> => {
    const raw = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ text: string }>;
    };
    return { size: raw.content[0]!.text.length, json: JSON.parse(raw.content[0]!.text) as Reply };
  };
  return { call };
}

const wf = (id: string, stepsOf: Record<string, unknown>): WorkflowDefinition =>
  ({
    id,
    name: id,
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps: stepsOf,
  }) as WorkflowDefinition;

describe('#872 (b1) correction 1 AC1 (C1) — the crown: the asked steps are cut last', () => {
  it('fan300 with 150 settled: every settled step read with include_steps and the cursor in at most 2 calls; every reply at or under the ceiling; the first page has one next action and next_actions_more', async () => {
    const ids = Array.from({ length: 300 }, (_, i) => `f${String(i).padStart(3, '0')}`);
    const { call } = await door(
      wf(
        'fan300',
        Object.fromEntries(
          ids.map((s) => [s, { description: 'Answer this step.', execution: 'agent' }]),
        ),
      ),
    );
    const runId = String(
      (await call('start_run', { workflow_id: 'fan300', params: {} })).json['run_id'],
    );
    for (const s of ids.slice(0, 150)) {
      await call('execute_step', { run_id: runId, command: s, params: { done: true } });
    }
    const pages: Array<{ size: number; json: Reply }> = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 200; guard += 1) {
      const page = await call('get_run_state', {
        run_id: runId,
        include_steps: true,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      pages.push(page);
      cursor = page.json['next_cursor'] as string | undefined;
      if (cursor === undefined) break;
    }
    const seen = pages.flatMap((p) => Object.keys((p.json['steps'] as object) ?? {}));
    const first = pages[0]!.json;
    // (a) red when the asked steps are cut before the run's other lists (#916's order: one step a
    //     page, 42 calls at 1,000 steps), a page passes the ceiling, or a settled step is missed;
    //     (b) prints the calls, the sizes and the first page's counts.
    expect({
      calls: pages.length <= 2,
      seen: seen.length === 150 && new Set(seen).size === 150,
      fit: pages.map((p) => p.size <= REPLY_CEILING_CHARS),
      firstActions: (first['next_actions'] as unknown[]).length,
      firstMore: first['next_actions_more'],
    }).toEqual({
      calls: true,
      seen: true,
      fit: pages.map(() => true),
      firstActions: 1,
      firstMore: 149,
    });
  }, 120_000);
});

describe('#872 (b1) correction 1 AC5 (C5) — (a)’s pointer, true under the cut', () => {
  it('w-1000-one: start_run’s hint points with "See engine_runnable in get_run_state."; get_run_state cuts engine_runnable with its exact count', async () => {
    const ids = Array.from({ length: 1000 }, (_, i) => `step${String(i).padStart(4, '0')}`);
    const { call } = await door(
      wf(
        'w-1000-one',
        Object.fromEntries(
          ids.map((s) => [s, { description: 'Auto step.', execution: 'auto', handler: 'nope' }]),
        ),
      ),
      new ExtensionRegistry(),
    );
    const started = (await call('start_run', { workflow_id: 'w-1000-one', params: {} })).json;
    const state = await call('get_run_state', { run_id: started['run_id'] });
    const shown = (state.json['engine_runnable'] as unknown[]).length;
    // (a) red when the pointer claims every entry ("lists each one" — false for the cut entries) or
    //     the cut drops its count; (b) prints the hint's end and the counts.
    expect({
      hint: String(started['context_hint']).endsWith(' See engine_runnable in get_run_state.'),
      fits: state.size <= REPLY_CEILING_CHARS,
      shown,
      more: state.json['engine_runnable_more'],
    }).toEqual({ hint: true, fits: true, shown, more: 1000 - shown });
    // The measured count, pinned (verify-first, after C1, C2 and H4: 138 — #916's halving kept 125,
    // 872-W3-06): its own assertion so a change shows as a number.
    expect(shown).toBe(138);
  }, 120_000);
});
