// run-version-d002.test.ts — Q1 (#592) unit e1 (prompt q1-e1-run-version-deprecation.md): the MCP
// door says REALM-D002 at the refusals whose `run_version: 0` names no run's state, and nowhere else.
// Checks 1 (each member of the set), 2 (no non-member), 5 (the warning notification) and 6's page
// sentences. Core's said-set is switched off for this file (the house precedent,
// form-recorded-627.test.ts), so every call that raises the warning prints it, and a "no line" cell
// cannot pass because an earlier cell already said it. Check 3 (once per process) is its own file,
// without the mock.
//
// Every assertion names (a) the change that turns it red and (b) what it prints on failure.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  ElicitRequestSchema,
  LoggingMessageNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { loadWorkflowFromString } from '@sensigo/realm';
import { createRealmMcpServer } from '../server.js';
import { setDeprecationSink } from '../deprecations.js';
import { makeTempHome, type TempHome } from '../test-support/temp-home.js';

vi.mock('@sensigo/realm', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@sensigo/realm')>()),
  markSaid: () => true,
}));

const LINE =
  "Warning: [REALM-D002] A refusal that named no run's state carried run_version 0. The 0 is not the run's version; a new run is also at version 0. Read the version from an ok reply or from basis. run_version leaves these refusals in 0.52.0.";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const flat = (t: string) => t.replace(/\s+/g, ' ');
type Reply = Record<string, unknown>;

const handles: TempHome[] = [];
let stderr: string[] = [];
let seen = 0;
beforeEach(() => {
  stderr = [];
  seen = 0;
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  }) as never);
});
/** The D002 lines printed on the error output since the last read. */
function d002(): string[] {
  const lines = stderr
    .slice(seen)
    .flatMap((c) => c.split('\n'))
    .filter((l) => l.includes('REALM-D002'));
  seen = stderr.length;
  return lines;
}
afterEach(async () => {
  setDeprecationSink(undefined);
  vi.restoreAllMocks();
  for (const h of handles.splice(0).reverse()) await h.cleanup();
});

/** One server on a temp home and a connected client. */
async function session(
  options: { gateAnswers?: 'permitted' | 'asked'; forms?: boolean; notify?: boolean } = {},
) {
  const h = await makeTempHome();
  handles.push(h);
  const server = createRealmMcpServer({
    ...h.stores,
    gateAnswers: options.gateAnswers ?? 'permitted',
    ...(options.notify === true ? { deprecationNotifications: true } : {}),
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: 'd002', version: '0' },
    options.forms === true ? { capabilities: { elicitation: { form: {} } } } : {},
  );
  const notes: Array<Record<string, unknown>> = [];
  client.setNotificationHandler(LoggingMessageNotificationSchema, (n) => {
    notes.push(n.params as Record<string, unknown>);
  });
  if (options.forms === true) {
    client.setRequestHandler(ElicitRequestSchema, async () => ({ action: 'decline' as const }));
  }
  await Promise.all([server.connect(st), client.connect(ct)]);
  const call = async (name: string, args: Reply): Promise<Reply> => {
    const raw = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ text: string }>;
    };
    const text = raw.content[0]!.text;
    try {
      return JSON.parse(text) as Reply;
    } catch {
      return { _text: text };
    }
  };
  const register = async (yaml: string) => {
    const def = loadWorkflowFromString(yaml);
    await h.stores.workflowStore.register(def);
    return def;
  };
  return { call, notes, register, stores: h.stores };
}

const AGENT = [
  'id: e1agent',
  'name: e1agent',
  'version: 1',
  'steps:',
  '  a:',
  '    description: Write.',
  '    execution: agent',
  '    instructions: Write it.',
].join('\n');
const GATE = [
  'id: e1gate',
  'name: e1gate',
  'version: 1',
  'steps:',
  '  q:',
  '    description: Ask.',
  '    execution: auto',
  '    trust: human_confirmed',
  '    instructions: Show the draft.',
  '    gate:',
  '      choices: [approve, reject]',
  '      message: Ship it?',
  '  after:',
  '    description: After.',
  '    execution: agent',
  '    instructions: Write the note.',
  '    depends_on: [q]',
].join('\n');
const AGENT_THEN_AUTO = [
  'id: e1mixed',
  'name: e1mixed',
  'version: 1',
  'steps:',
  '  a:',
  '    description: Write.',
  '    execution: agent',
  '    instructions: Write it.',
  '  b:',
  '    description: Then.',
  '    execution: auto',
  '    handler: check_quotes',
  '    depends_on: [a]',
].join('\n');
const SCHEMA = [
  'id: e1schema',
  'name: e1schema',
  'version: 1',
  'steps:',
  '  a:',
  '    description: Write.',
  '    execution: agent',
  '    instructions: Write it.',
  '    output_schema:',
  '      type: object',
  '      required: [x]',
  '      properties:',
  '        x: { type: string }',
].join('\n');

describe('Q1 (#592) unit e1 — check 1: each member of the set says REALM-D002, once per call, on the door’s error output', () => {
  it('the six outer catches on a run id (or a workflow) that does not exist, append_trace on a run that does not exist', async () => {
    const s = await session();
    const asked = await session({ gateAnswers: 'asked', forms: true });
    const members: Array<[string, () => Promise<Reply>]> = [
      [
        'execute_step',
        () => s.call('execute_step', { run_id: 'no-such-run', command: 'a', params: {} }),
      ],
      ['advance_run', () => s.call('advance_run', { run_id: 'no-such-run' })],
      ['start_run', () => s.call('start_run', { workflow_id: 'no-such-workflow' })],
      [
        'start_run_batch',
        () =>
          s.call('start_run_batch', { workflow_id: 'no-such-workflow', items: [{ params: {} }] }),
      ],
      [
        'submit_human_response',
        () =>
          s.call('submit_human_response', {
            run_id: 'no-such-run',
            gate_id: 'g',
            choice: 'approve',
          }),
      ],
      [
        'present_question',
        () => asked.call('present_question', { run_id: 'no-such-run', gate_id: 'g' }),
      ],
      [
        'append_trace',
        () =>
          s.call('append_trace', {
            run_id: 'no-such-run',
            step_id: 'a',
            entries: [{ event: 'e' }],
          }),
      ],
    ];
    const got: Record<string, unknown> = {};
    d002();
    for (const [tool, call] of members) {
      const r = await call();
      got[tool] = { status: r['status'], run_version: r['run_version'], lines: d002() };
    }
    // (a) red when a member's site does not raise it, raises it twice, or the line is not the
    //     table's; (b) prints each member's reply status, run_version and the lines it printed.
    const expected = { status: 'error', run_version: 0, lines: [LINE] };
    expect(got).toEqual(Object.fromEntries(members.map(([t]) => [t, expected])));
  });

  it('execute_step on a run whose workflow is no longer registered (the catch after the run was read)', async () => {
    const s = await session();
    const { record } = await s.stores.runStore.create({
      workflowId: 'ghost',
      workflowVersion: 1,
      params: {},
    });
    d002();
    const r = await s.call('execute_step', { run_id: record.id, command: 'a', params: {} });
    // (a) red when the post-read refusal does not raise it; (b) prints the reply's code and lines.
    expect([r['error_code'], r['run_version'], d002()]).toEqual([
      'STATE_WORKFLOW_NOT_FOUND',
      0,
      [LINE],
    ]);
  });

  it('the three reachable argument refusals (a non-finite number) and create_workflow’s refusal', async () => {
    const s = await session();
    const def = await s.register(AGENT);
    const { record } = await s.stores.runStore.create({
      workflowId: def.id,
      workflowVersion: 1,
      params: {},
    });
    d002();
    const got: Record<string, unknown> = {};
    for (const [tool, args] of [
      ['execute_step', { run_id: record.id, command: 'a', params: { n: Infinity } }],
      ['start_run', { workflow_id: def.id, params: { n: Infinity } }],
      ['start_run_batch', { workflow_id: def.id, items: [{ params: { n: Infinity } }] }],
      ['create_workflow', { steps: [{ id: 's1', description: 'd', depends_on: ['nope'] }] }],
    ] as const) {
      const r = await s.call(tool, args as unknown as Reply);
      got[tool] = { status: r['status'], run_version: r['run_version'], lines: d002() };
    }
    // (a) red when argsNumbersEnvelope or create_workflow's refusal envelope does not raise it; (b)
    //     prints each reply's status, run_version and lines.
    const expected = { status: 'error', run_version: 0, lines: [LINE] };
    expect(got).toEqual({
      execute_step: expected,
      start_run: expected,
      start_run_batch: expected,
      create_workflow: expected,
    });
  });
});

describe('Q1 (#592) unit e1 — check 2: no non-member says it (the same said-set mock)', () => {
  it('get_run_state and abandon_run on a missing run; append_trace’s read-version arm on a run still at version 0; an engine refusal on a run it read', async () => {
    const s = await session();
    const mixed = await s.register(AGENT_THEN_AUTO);
    const schema = await s.register(SCHEMA);
    const { record: atZero } = await s.stores.runStore.create({
      workflowId: mixed.id,
      workflowVersion: 1,
      params: {},
    });
    const { record: forSchema } = await s.stores.runStore.create({
      workflowId: schema.id,
      workflowVersion: 1,
      params: {},
    });
    d002();
    const got: Record<string, unknown> = {};
    const get = await s.call('get_run_state', { run_id: 'no-such-run' });
    got['get_run_state'] = [get['error_code'], d002()];
    const abandon = await s.call('abandon_run', { run_id: 'no-such-run' });
    got['abandon_run'] = [abandon['error_code'], d002()];
    const trace = await s.call('append_trace', {
      run_id: atZero.id,
      step_id: 'b',
      entries: [{ event: 'e' }],
    });
    got['append_trace read-version arm'] = [trace['error_code'], trace['run_version'], d002()];
    const engine = await s.call('execute_step', { run_id: forSchema.id, command: 'a', params: {} });
    got['an engine refusal'] = [engine['error_code'], d002()];
    // (a) red when a refusal that strips the field, the read-version arm (keyed on the reply's 0,
    //     not the branch), or an engine refusal on a run it read raises it; (b) prints each.
    expect(got).toEqual({
      get_run_state: ['STATE_RUN_NOT_FOUND', []],
      abandon_run: ['STATE_RUN_NOT_FOUND', []],
      'append_trace read-version arm': ['STATE_STEP_NOT_ELIGIBLE', 0, []],
      'an engine refusal': ['VALIDATION_OUTPUT_SCHEMA', []],
    });
  });

  it('an ok reply of each of the seven tools says nothing', async () => {
    const s = await session();
    const asked = await session({ gateAnswers: 'asked', forms: true });
    const agent = await s.register(AGENT);
    const gate = await s.register(GATE);
    await asked.register(GATE);
    const started = await s.call('start_run', { workflow_id: agent.id });
    const runId = started['run_id'] as string;
    const got: Record<string, unknown> = { start_run: [started['status'], d002()] };
    const batch = await s.call('start_run_batch', {
      workflow_id: agent.id,
      items: [{ params: {} }],
    });
    // Its ok reply has no `status`: the runs it started.
    got['start_run_batch'] = [
      `started ${(batch['started'] as unknown[] | undefined)?.length}`,
      d002(),
    ];
    const trace = await s.call('append_trace', {
      run_id: runId,
      step_id: 'a',
      entries: [{ event: 'e' }],
    });
    got['append_trace'] = [trace['status'], d002()];
    const advance = await s.call('advance_run', { run_id: runId });
    got['advance_run'] = [advance['status'], d002()];
    const step = await s.call('execute_step', { run_id: runId, command: 'a', params: {} });
    got['execute_step'] = [step['status'], d002()];
    const atGate = await s.call('start_run', { workflow_id: gate.id });
    const gateId = (atGate['gate'] as { gate_id: string } | undefined)?.gate_id ?? '';
    d002();
    const answer = await s.call('submit_human_response', {
      run_id: atGate['run_id'],
      gate_id: gateId,
      choice: 'approve',
    });
    got['submit_human_response'] = [answer['status'], d002()];
    const opened = await asked.call('start_run', { workflow_id: gate.id });
    const openedGate = (opened['gate'] as { gate_id: string } | undefined)?.gate_id ?? '';
    d002();
    const present = await asked.call('present_question', {
      run_id: opened['run_id'],
      gate_id: openedGate,
    });
    got['present_question'] = [present['status'], d002()];
    // (a) red when an ok reply raises it (a warning hung on every reply, or on the reply's 0); (b)
    //     prints each tool's status and lines.
    expect(got).toEqual({
      start_run: ['ok', []],
      start_run_batch: ['started 1', []],
      append_trace: ['ok', []],
      advance_run: ['ok', []],
      execute_step: ['ok', []],
      submit_human_response: ['ok', []],
      present_question: ['ok', []],
    });
  });
});

describe('Q1 (#592) unit e1 — check 5: the warning notification', () => {
  it('a server built with deprecationNotifications and a connected client gets the warning notification with the line; one built without it prints the error-output line alone', async () => {
    const quiet = await session();
    d002();
    await quiet.call('execute_step', { run_id: 'no-such-run', command: 'a', params: {} });
    await new Promise((r) => setTimeout(r, 50));
    const quietSeen = { lines: d002(), notes: quiet.notes.length };
    const loud = await session({ notify: true });
    d002();
    await loud.call('execute_step', { run_id: 'no-such-run', command: 'a', params: {} });
    await new Promise((r) => setTimeout(r, 50));
    // (a) red when the stdio-style server does not notify, notifies other text, or the server
    //     without the option notifies; (b) prints both servers' lines and notifications.
    expect({
      quiet: quietSeen,
      loud: { lines: d002(), notes: loud.notes },
    }).toEqual({
      quiet: { lines: [LINE], notes: 0 },
      loud: { lines: [LINE], notes: [{ level: 'warning', logger: 'realm', data: LINE }] },
    });
  });
});

describe('Q1 (#592) unit e1 — check 6: the pages say it', () => {
  it('tools.md: the new sentence after the refusal-shape sentence, and the run_version row’s note; CHANGELOG Upgrading item 6', () => {
    const tools = flat(readFileSync(join(ROOT, 'docs/reference/mcp/tools.md'), 'utf8'));
    const changelog = flat(readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8'));
    const sentences = {
      shape:
        "except that a refusal from `get_run_state` or `abandon_run` has no `run_version`. Where a refusal from any other tool names no run's state, its `run_version` is `0` until 0.52.0, when the field goes away (`REALM-D002`, added after version 0.50.0).",
      row: "Where a refusal names no run's state — such as a run id that does not exist, a workflow no longer registered, an argument refused before any run was read, or `create_workflow`'s refusal — the `0` is a placeholder, not the run's version: it leaves those replies in 0.52.0, and the server says so once with `REALM-D002` (added after version 0.50.0). Read the version from an ok reply or from `basis`. |",
      upgrading:
        "**6. `run_version: 0` on a refusal that names no run's state is going away in 0.52.0.** `start_run`, `start_run_batch`, `execute_step`, `advance_run`, `present_question`, `submit_human_response` and `append_trace` put `run_version: 0` on a refusal that names no run's state — such as a run id that does not exist, a workflow no longer registered, or a call refused before any run was read — as do the argument refusals and `create_workflow`'s refusal envelope; a new run is also at version 0, so the value says nothing. From this release the MCP server says so once per process (`Warning: [REALM-D002] …`, on its error output and, over the stdio MCP server, as the protocol's warning notification); in 0.52.0 the field leaves those refusals, as it already does on `get_run_state`'s and `abandon_run`'s. Read the version from an ok reply or from `basis`. Nothing in any reply changes in this release.",
    };
    // (a) red when a page no longer holds its sentence word for word; (b) prints which.
    expect({
      shape: tools.includes(flat(sentences.shape)),
      row: tools.includes(flat(sentences.row)),
      upgrading: changelog.includes(flat(sentences.upgrading)),
    }).toEqual({ shape: true, row: true, upgrading: true });
  });
});
