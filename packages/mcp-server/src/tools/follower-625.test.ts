// follower-625.test.ts — issue #625 PR-2a, law L4 (Follower): a client that makes ONLY the calls
// `next_actions` names (answering each gate with its first choice) finishes the workflow, within a
// finite call budget and without polling — through realm's own MCP server, spawned over stdio.
//
// Every server child gets a scratch HOME; nothing here reads or writes the real `~/.realm`.
// `FOLLOWER_SERVER_ENTRY` points the cells at another build's `dist/server.js` (the red-first run).
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  JsonFileStore,
  JsonWorkflowStore,
  applyResume,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  type WorkflowDefinition,
  type StepDefinition,
} from '@sensigo/realm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SERVER_ENTRY =
  process.env['FOLLOWER_SERVER_ENTRY'] ??
  fileURLToPath(new URL('../../dist/server.js', import.meta.url));
if (!existsSync(SERVER_ENTRY)) {
  throw new Error(`mcp-server dist not built — run the build first (looked for: ${SERVER_ENTRY})`);
}

type Reply = Record<string, unknown> & {
  status: string;
  run_id?: string;
  run_phase?: string;
  next_actions?: Array<{
    instruction: { tool: string; call_with: Record<string, unknown> } | null;
  }>;
  started?: Array<{ run_id: string; next_actions: Reply['next_actions'] }>;
  errors?: string[];
};

/**
 * A server child that is realm's own `createRealmMcpServer`, over stdio, with ONE handler registered
 * (`stamp`) — the shape an embedding host has. Used where a workflow needs a handler the default
 * registry does not hold (realm ships none).
 */
function handlerEntry(home: string): string {
  const req = createRequire(import.meta.url);
  const stdio = pathToFileURL(req.resolve('@modelcontextprotocol/sdk/server/stdio.js')).href;
  const mcp = pathToFileURL(fileURLToPath(new URL('../../dist/index.js', import.meta.url))).href;
  const core = new URL('../../../core/dist/index.js', import.meta.url).href;
  const entry = join(home, 'handler-entry.mjs');
  writeFileSync(
    entry,
    [
      `import { StdioServerTransport } from '${stdio}';`,
      `import { createRealmMcpServer } from '${mcp}';`,
      `import { createDefaultRegistry } from '${core}';`,
      `const registry = createDefaultRegistry();`,
      `registry.register('handler', 'stamp', { id: 'stamp', execute: async () => ({ data: { stamped: true } }) });`,
      `const server = createRealmMcpServer({ registry });`,
      `await server.connect(new StdioServerTransport());`,
    ].join('\n'),
  );
  return entry;
}

async function withServer<T>(
  defs: WorkflowDefinition[],
  fn: (client: Client, home: string) => Promise<T>,
  opts: { withHandler?: boolean } = {},
): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'realm-follower-625-'));
  const workflows = new JsonWorkflowStore(join(home, '.realm', 'workflows'));
  for (const d of defs) await workflows.register(d);
  const client = new Client({ name: 'follower', version: '0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [opts.withHandler === true ? handlerEntry(home) : SERVER_ENTRY],
      env: { ...process.env, HOME: home } as Record<string, string>,
    }),
  );
  try {
    return await fn(client, home);
  } finally {
    await client.close();
    rmSync(home, { recursive: true, force: true });
  }
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<Reply> {
  const result = (await client.callTool({ name, arguments: args })) as {
    content: Array<{ text?: string }>;
  };
  return JSON.parse(result.content[0]?.text ?? '{}') as Reply;
}

/**
 * The follower: from `first`, make only the calls next_actions names. An agent step is called with
 * `params: {}`; a gate is answered with its first choice. Returns the calls made (tool names) and the
 * last reply. Never polls: when next_actions is empty it stops.
 */
async function follow(
  client: Client,
  first: Reply,
  budget = 30,
): Promise<{ calls: string[]; last: Reply }> {
  const calls: string[] = [];
  let reply = first;
  for (let i = 0; i < budget; i++) {
    const action = reply.next_actions?.[0];
    if (action === undefined || action.instruction === null) return { calls, last: reply };
    const { tool, call_with } = action.instruction;
    const args: Record<string, unknown> = { ...call_with };
    if (tool === 'execute_step') args['params'] = {};
    if (tool === 'submit_human_response') {
      args['choice'] = String(call_with['choice']).replace(/^<|>$/g, '').split('|')[0];
    }
    calls.push(tool);
    reply = await call(client, tool, args);
  }
  throw new Error(`the follower did not finish within ${budget} calls: ${JSON.stringify(reply)}`);
}

const wf = (id: string, steps: Record<string, StepDefinition>): WorkflowDefinition => ({
  id,
  name: id,
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps,
});

const gate = (depends_on: string[], choices = ['approve', 'reject']): StepDefinition => ({
  description: 'Confirm.',
  execution: 'auto',
  trust: 'human_confirmed',
  depends_on,
  gate: { choices },
});

async function phaseOf(home: string, runId: string): Promise<string> {
  return (await new JsonFileStore(join(home, '.realm', 'runs')).get(runId)).run_phase;
}

describe('#625 PR-2a — L4 Follower over real MCP stdio', () => {
  it('gate→auto: the follower finishes (the act after the answer runs the owed step)', async () => {
    const d = wf('f-gate-auto', {
      write: { description: 'Write.', execution: 'agent', depends_on: [] },
      confirm: gate(['write']),
      after: { description: 'After.', execution: 'auto', depends_on: ['confirm'] },
      finish: { description: 'Finish.', execution: 'agent', depends_on: ['after'] },
    });
    await withServer([d], async (client, home) => {
      const started = await call(client, 'start_run', { workflow_id: d.id, params: {} });
      const { calls, last } = await follow(client, started);
      expect(calls).toContain('advance_run');
      expect(last.next_actions).toEqual([]);
      expect(await phaseOf(home, started.run_id!)).toBe('completed');
    });
  }, 30000);

  it('gate→guard, approve and reject: completed / aborted', async () => {
    const d = wf('f-gate-guard', {
      write: { description: 'Write.', execution: 'agent', depends_on: [] },
      confirm: gate(['write']),
      check: {
        description: 'Check.',
        execution: 'guard',
        depends_on: ['confirm'],
        abort_unless: ["confirm.choice == 'approve'"],
      },
      finish: { description: 'Finish.', execution: 'agent', depends_on: ['check'] },
    });
    const rejectFirst = wf('f-gate-guard-reject', {
      ...d.steps,
      confirm: gate(['write'], ['reject', 'approve']),
    });
    await withServer([d, rejectFirst], async (client, home) => {
      const a = await call(client, 'start_run', { workflow_id: d.id, params: {} });
      await follow(client, a);
      expect(await phaseOf(home, a.run_id!)).toBe('completed');
      const r = await call(client, 'start_run', { workflow_id: rejectFirst.id, params: {} });
      await follow(client, r);
      expect(await phaseOf(home, r.run_id!)).toBe('aborted');
    });
  }, 30000);

  it('gate→guard→gate: completed', async () => {
    const d = wf('f-gate-guard-gate', {
      write: { description: 'Write.', execution: 'agent', depends_on: [] },
      confirm: gate(['write']),
      check: {
        description: 'Check.',
        execution: 'guard',
        depends_on: ['confirm'],
        abort_unless: ["confirm.choice == 'approve'"],
      },
      second: gate(['check']),
    });
    await withServer([d], async (client, home) => {
      const s = await call(client, 'start_run', { workflow_id: d.id, params: {} });
      await follow(client, s);
      expect(await phaseOf(home, s.run_id!)).toBe('completed');
    });
  }, 30000);

  it('an auto step after a failed step (one_failed): the follower reaches it', async () => {
    const d = wf('f-one-failed', {
      work: {
        description: 'Work.',
        execution: 'agent',
        depends_on: [],
        input_schema: { type: 'object', required: ['must'] },
      },
      recover: {
        description: 'Recover.',
        execution: 'auto',
        depends_on: ['work'],
        trigger_rule: 'one_failed',
      },
    });
    await withServer([d], async (client, home) => {
      const s = await call(client, 'start_run', { workflow_id: d.id, params: {} });
      const { calls } = await follow(client, s);
      // The follower keeps sending {} — refused each time until the rejection budget is spent and
      // `work` FAILS; the recovery step behind it (`one_failed`) is then owed and reached.
      expect(calls.filter((c) => c === 'execute_step').length).toBeGreaterThan(1);
      const run = await new JsonFileStore(join(home, '.realm', 'runs')).get(s.run_id!);
      expect(run.failed_steps).toEqual(['work']);
      expect(run.completed_steps).toContain('recover');
    });
  }, 30000);

  it('a batch-created run: each started entry names its first call, and the follower finishes', async () => {
    const d = wf('f-batch', {
      head: { description: 'Head.', execution: 'auto', depends_on: [] },
      finish: { description: 'Finish.', execution: 'agent', depends_on: ['head'] },
    });
    await withServer([d], async (client, home) => {
      const batch = await call(client, 'start_run_batch', {
        workflow_id: d.id,
        items: [{ params: {} }],
      });
      const entry = batch.started![0]!;
      expect(entry.next_actions?.map((a) => a?.instruction?.tool)).toEqual(['advance_run']);
      await follow(client, { status: 'ok', next_actions: entry.next_actions ?? [] });
      expect(await phaseOf(home, entry.run_id)).toBe('completed');
    });
  }, 30000);

  it('refusals end with the refusal named and the act withdrawn: invalid trust, failed precondition, input schema', async () => {
    const trust = wf('f-trust', {
      write: { description: 'Write.', execution: 'agent', depends_on: [] },
      x: { description: 'X.', execution: 'auto', depends_on: ['write'], trust: 'nope' as never },
    });
    const pre = wf('f-pre', {
      write: { description: 'Write.', execution: 'agent', depends_on: [] },
      x: {
        description: 'X.',
        execution: 'auto',
        depends_on: ['write'],
        preconditions: ['write.ok == true'],
      },
    });
    const schema = wf('f-schema', {
      x: {
        description: 'X.',
        execution: 'auto',
        depends_on: [],
        input_schema: { type: 'object', required: ['alpha'] },
      },
    });
    await withServer([trust, pre, schema], async (client) => {
      for (const [d, member] of [
        [trust, 'trust'],
        [pre, 'precondition'],
        [schema, 'input_schema'],
      ] as const) {
        const s = await call(client, 'start_run', { workflow_id: d.id, params: {} });
        const { last } = await follow(client, s);
        expect(last.next_actions, d.id).toEqual([]);
        const state = await call(client, 'get_run_state', { run_id: s.run_id! });
        const runnable = state['engine_runnable'] as Array<Record<string, unknown>>;
        expect(
          runnable.map((e) => e['refused_by']),
          d.id,
        ).toEqual([member]);
        expect(state['next_actions'], d.id).toEqual([]);
      }
    });
  }, 30000);

  it('a head guard: the run ends failed', async () => {
    const d = wf('f-head-guard', {
      g: {
        description: 'G.',
        execution: 'guard',
        depends_on: [],
        abort_unless: ['nothing.ok == true'],
      },
      after: { description: 'After.', execution: 'agent', depends_on: ['g'] },
    });
    await withServer([d], async (client, home) => {
      const s = await call(client, 'start_run', { workflow_id: d.id, params: {} });
      await follow(client, s);
      expect(await phaseOf(home, s.run_id!)).toBe('failed');
    });
  }, 30000);

  it('expiry→default→auto: a late answer after the default settled names the owed step, and the follower finishes', async () => {
    const d = wf('f-expiry-default', {
      write: { description: 'Write.', execution: 'agent', depends_on: [] },
      confirm: {
        description: 'Confirm.',
        execution: 'auto',
        trust: 'human_confirmed',
        depends_on: ['write'],
        gate: {
          choices: ['approve', 'reject'],
          timeout_seconds: 1,
          on_expiry: 'settle_default',
          default_choice: 'approve',
        },
      },
      after: { description: 'After.', execution: 'auto', depends_on: ['confirm'] },
    });
    await withServer([d], async (client, home) => {
      const started = await call(client, 'start_run', { workflow_id: d.id, params: {} });
      const opened = await call(client, 'execute_step', {
        run_id: started.run_id!,
        command: 'write',
        params: {},
      });
      expect(opened.status).toBe('confirm_required');
      // The person answers after the gate's time is up (a late human, not a poll).
      await new Promise((resolve) => setTimeout(resolve, 1300));
      const { calls } = await follow(client, opened);
      expect(calls).toContain('advance_run');
      expect(await phaseOf(home, started.run_id!)).toBe('completed');
    });
  }, 30000);

  it('a handler auto step after a gate: the act names it (never the handler as a tool), and the follower finishes', async () => {
    const d = wf('f-gate-handler', {
      write: { description: 'Write.', execution: 'agent', depends_on: [] },
      confirm: gate(['write']),
      stamp_it: {
        description: 'Stamp.',
        execution: 'auto',
        depends_on: ['confirm'],
        handler: 'stamp',
      },
    });
    await withServer(
      [d],
      async (client, home) => {
        const started = await call(client, 'start_run', { workflow_id: d.id, params: {} });
        const { calls } = await follow(client, started);
        expect(calls).toEqual(['execute_step', 'submit_human_response', 'advance_run']);
        expect(calls).not.toContain('stamp');
        const run = await new JsonFileStore(join(home, '.realm', 'runs')).get(started.run_id!);
        expect(run.run_phase).toBe('completed');
        expect(run.completed_steps).toContain('stamp_it');
      },
      { withHandler: true },
    );
  }, 30000);

  it('resume --from <failed guard>: the resumed run names the act, and advance_run settles the guard', async () => {
    const d = wf('f-resume-guard', {
      g: {
        description: 'G.',
        execution: 'guard',
        depends_on: [],
        abort_unless: ['nothing.ok == true'],
      },
      after: { description: 'After.', execution: 'agent', depends_on: ['g'] },
    });
    await withServer([d], async (client, home) => {
      const s = await call(client, 'start_run', { workflow_id: d.id, params: {} });
      await follow(client, s);
      const runs = new JsonFileStore(join(home, '.realm', 'runs'));
      const failed = await runs.get(s.run_id!);
      expect(failed.failed_steps).toEqual(['g']);
      // What `realm run resume --from g` writes (the core transform, then one update).
      await runs.update(applyResume(failed, 'g', d).run);
      const state = await call(client, 'get_run_state', { run_id: s.run_id! });
      expect(state['next_actions_status']).toBe('advance_owed');
      const { calls, last } = await follow(client, state);
      expect(calls).toEqual(['advance_run']);
      expect(last.chained_auto_steps).toEqual([expect.objectContaining({ step: 'g' })]);
      expect(await phaseOf(home, s.run_id!)).toBe('failed');
    });
  }, 30000);

  it('capability-blocked: the first advance attempts it once (the marker), then the act is withdrawn and the refusal named', async () => {
    const d = wf('f-capability', {
      write: { description: 'Write.', execution: 'agent', depends_on: [] },
      x: { description: 'X.', execution: 'auto', depends_on: ['write'], handler: 'missing_h' },
    });
    await withServer([d], async (client, home) => {
      const s = await call(client, 'start_run', { workflow_id: d.id, params: {} });
      const { calls, last } = await follow(client, s);
      // decision C24: the attempt's reply is rebuilt with the server's registry, so it offers no act
      // for the step that just failed to dispatch — the follower spends no call to learn it.
      expect(calls).toEqual(['execute_step']);
      expect(last.next_actions).toEqual([]);
      const run = await new JsonFileStore(join(home, '.realm', 'runs')).get(s.run_id!);
      expect(run.capability_blocks?.['x']).toBeDefined();
      const state = await call(client, 'get_run_state', { run_id: s.run_id! });
      expect(state['engine_runnable']).toEqual([
        {
          step: 'x',
          runnable_here: false,
          refused_by: 'capability',
          refusal: "handler 'missing_h' is not registered here",
        },
      ]);
      expect(state['next_actions']).toEqual([]);
    });
  }, 30000);

  it('advance_run: continued_by names this server; a repeat with nothing owed runs nothing, never an error', async () => {
    const d = wf('f-advance', {
      head: { description: 'Head.', execution: 'auto', depends_on: [] },
      finish: { description: 'Finish.', execution: 'agent', depends_on: ['head'] },
    });
    await withServer([d], async (client) => {
      const batch = await call(client, 'start_run_batch', {
        workflow_id: d.id,
        items: [{ params: {} }],
      });
      const runId = batch.started![0]!.run_id;
      const first = await call(client, 'advance_run', { run_id: runId, extra: 1 });
      expect(first.status).toBe('ok');
      expect((first['continued_by'] as Record<string, unknown>)['channel']).toBe('mcp-stdio');
      expect(first['warnings']).toEqual(["advance_run: unknown argument 'extra' was ignored."]);
      const again = await call(client, 'advance_run', { run_id: runId });
      expect(again.status).toBe('ok');
      expect(again['chained_auto_steps']).toBeUndefined();
    });
  }, 30000);

  it('the three tool descriptions this PR mints, whole, over tools/list', async () => {
    await withServer([], async (client) => {
      const { tools } = await client.listTools();
      const d = Object.fromEntries(tools.map((t) => [t.name, t.description]));
      expect(d['start_run']).toBe('Create a new workflow run and run its first automatic steps.');
      expect(d['advance_run']).toBe(
        "Run the guards and automatic steps a run owes, in this server's environment. Call it when next_actions names it.",
      );
      expect(d['start_run_batch']).toBe(
        "Atomically enqueue multiple runs of the same workflow. No step runs; each started entry's next_actions names its first call. All items are validated before any run is created. If idempotency keys are provided, duplicate runs are returned instead of created.",
      );
      // decision C30.15: the package's own description counts the tools the server lists.
      const pkg = JSON.parse(
        readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
      ) as { description: string };
      expect(pkg.description).toBe(
        `MCP server for Realm — exposes ${tools.length} tools for AI agent connections over stdio or HTTP.`,
      );
    });
  }, 30000);
});
