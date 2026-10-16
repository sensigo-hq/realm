// inspect-run-state-parity-729.test.ts — issue #729 PR-0 (D3 A-13): `realm run inspect` and MCP
// `get_run_state` read the run's ways from ONE composer, so on the same run they say the same thing
// about what comes next, each in its own door's words: which agent steps are ready, whether the
// engine owes work, which steps cannot run.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure: step
// names and booleans.
import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  JsonFileStore,
  JsonWorkflowStore,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { createRealmMcpServer } from '@sensigo/realm-mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { inspectRun } from './inspect.js';

const wf = (id: string, steps: WorkflowDefinition['steps']): WorkflowDefinition => ({
  id,
  name: id,
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps,
});

/** What each door says comes next, as data: ready agent steps, owed, steps that cannot run. */
interface Said {
  ready: string[];
  owed: boolean;
  cannot: string[];
}

const names = (text: string | undefined): string[] =>
  [...(text ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]!).sort();

function fromInspect(text: string): Said {
  // eslint-disable-next-line no-control-regex
  const lines = text.replace(/\u001b\[[0-9;]*m/g, '').split('\n');
  const ready = lines.find((l) => /^(An agent step is|Agent steps are) ready:/.test(l));
  return {
    ready: names(ready?.split(' — ')[0]),
    owed: lines.some((l) => l.startsWith('Owed to the engine:')),
    cannot: lines
      .filter((l) => /^(Cannot|Could not) run '/.test(l))
      .map((l) => /'([^']+)'/.exec(l)![1]!)
      .sort(),
  };
}

function fromRunState(state: Record<string, unknown>): Said {
  const next =
    (state['next_actions'] as Array<{
      instruction: { tool: string; params: Record<string, unknown> } | null;
    }>) ?? [];
  const refused = [
    ...((state['agent_refused'] as Array<{ step: string }> | undefined) ?? []),
    ...(
      (state['engine_runnable'] as Array<{ step: string; runnable_here: unknown }> | undefined) ??
      []
    ).filter((e) => e.runnable_here === false),
  ];
  return {
    ready: next
      .filter((n) => n.instruction?.tool === 'execute_step')
      .map((n) => String(n.instruction!.params['command']))
      .sort(),
    owed: next.some((n) => n.instruction?.tool === 'advance_run'),
    cannot: refused.map((e) => e.step).sort(),
  };
}

describe('#729 PR-0 — A-13: inspect and get_run_state say the same next step, each in its words', () => {
  it('a ready agent step and an owed engine step; a step that cannot run; a step held elsewhere', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'realm-parity-729-'));
    const store = new JsonFileStore(join(dir, 'runs'));
    const workflowStore = new JsonWorkflowStore(join(dir, 'wf'));
    const server = createRealmMcpServer({ runStore: store, workflowStore });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'parity-729', version: '0' });
    await Promise.all([server.connect(st), client.connect(ct)]);
    const read = async (runId: string) => {
      const raw = (await client.callTool({
        name: 'get_run_state',
        arguments: { run_id: runId },
      })) as {
        content: Array<{ text: string }>;
      };
      return JSON.parse(raw.content[0]!.text) as Record<string, unknown>;
    };
    const cases: [string, WorkflowDefinition, (id: string) => Promise<void>][] = [
      [
        'ready and owed',
        wf('par-ready', {
          a: { description: 'a', execution: 'agent', depends_on: [] },
          b: { description: 'b', execution: 'auto', depends_on: [] },
        }),
        async () => {},
      ],
      [
        'cannot run',
        wf('par-cannot', {
          a: {
            description: 'a',
            execution: 'agent',
            depends_on: [],
            preconditions: ["run.params.mode == 'live'"],
          },
        }),
        async () => {},
      ],
      [
        'held elsewhere',
        wf('par-held', { a: { description: 'a', execution: 'agent', depends_on: [] } }),
        async (id) => {
          await store.claimStep(id, 'a', await workflowStore.get('par-held'));
        },
      ],
    ];
    const found: [string, Said, Said][] = [];
    for (const [name, def, prepare] of cases) {
      await workflowStore.register(def);
      const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
      await prepare(run.id);
      const viaInspect = fromInspect(await inspectRun(run.id, store, workflowStore));
      const viaState = fromRunState(await read(run.id));
      found.push([name, viaInspect, viaState]);
    }
    // (a) red when a door composes its own reading of what comes next (a step ready on one door and
    //     not the other, owed work said by one only); (b) prints both readings per case.
    expect(found.map(([n, a, b]) => [n, JSON.stringify(a) === JSON.stringify(b)])).toEqual([
      ['ready and owed', true],
      ['cannot run', true],
      ['held elsewhere', true],
    ]);
    // The cases are not vacuous: each says something.
    expect(found.map(([n, a]) => [n, a])).toEqual([
      ['ready and owed', { ready: ['a'], owed: true, cannot: [] }],
      ['cannot run', { ready: [], owed: false, cannot: ['a'] }],
      ['held elsewhere', { ready: [], owed: false, cannot: [] }],
    ]);
  });
});
