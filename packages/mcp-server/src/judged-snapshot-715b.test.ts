// judged-snapshot-715b.test.ts — issue #715 (b) 02 §B.1 (D6-17) with Amendment 4 and its addendum, on
// the MCP door: the snapshot the engine judged its reply on (`judgedSnapshotOf`) is for judging,
// never for printing. Cell (ii) (the snapshot is on no wire: `JSON.stringify` — the door realm-cloud's
// route `Response.json(envelope)` uses — and `renderReply`; the CLI `--json` door is the empty set,
// Amendment 5: no CLI command prints an engine reply as JSON), cell (iv)'s MCP half (`execute_step`
// reads the run no more after its call) and cell (v) (a declared value in a record field an
// after-statement names reaches the wire as the door's marker: the after-statement is composed through
// the door's disclosed view, never printed from the raw record).
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure —
// booleans, counts, key lists and texts with the value cut out, never the value itself.
import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  JsonFileStore,
  advanceRun,
  compileDisclosure,
  executeStep,
  judgedSnapshotOf,
  loadWorkflowFromString,
  submitHumanResponse,
  type Snapshot,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createRealmMcpServer } from './server.js';
import { renderReply } from './render-reply.js';
import { mcpHostOf } from './tools/start-run.js';
import { makeTempHome, type ServerExtras, type TempHome } from './test-support/temp-home.js';

/** A unique value put in the run's `params` — a record field no engine reply carries. */
const SENTINEL = 'SENTINEL-715B-MCP-6c1d';
/** A fake value the server's disclosure provider declares (hidden on the MCP door). */
const DECLARED = 'FAKE-DECLARED-715B-ANSWERER';

const TWO: WorkflowDefinition = {
  id: 'judged-715b-mcp',
  name: 'judged-715b-mcp',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    a: { description: 'A.', execution: 'agent', depends_on: [] },
    b: { description: 'B.', execution: 'agent', depends_on: ['a'] },
  },
};

/** One agent step: answering it completes the run (the ended-run tail is composed). */
const ONE: WorkflowDefinition = {
  id: 'judged-715b-mcp-one',
  name: 'judged-715b-mcp-one',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: { a: { description: 'A.', execution: 'agent', depends_on: [] } },
};

/** A JSON store that counts its reads. */
class CountingStore extends JsonFileStore {
  gets = 0;
  override async get(runId: string): Promise<Snapshot> {
    this.gets += 1;
    return super.get(runId);
  }
}

type Reply = Record<string, unknown>;

const handles: TempHome[] = [];
afterEach(async () => {
  for (const h of handles.splice(0).reverse()) await h.cleanup();
});

async function connect(
  definitions: WorkflowDefinition[],
  options: ServerExtras = {},
  elicit?: () => Promise<{ action: 'accept' | 'decline'; content?: Record<string, unknown> }>,
) {
  const h = await makeTempHome();
  handles.push(h);
  const runStore = new CountingStore(join(h.path, 'runs'));
  const workflowStore = h.stores.workflowStore;
  for (const d of definitions) await workflowStore.register(d);
  const server = createRealmMcpServer({
    ...h.stores,
    runStore,
    ...options,
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  // Every byte the server sends, captured at its transport.
  const sent: string[] = [];
  const send = st.send.bind(st);
  st.send = async (message, opts) => {
    sent.push(JSON.stringify(message));
    return send(message, opts);
  };
  const client = new Client(
    { name: 'judged-715b', version: '0' },
    elicit !== undefined ? { capabilities: { elicitation: { form: {} } } } : {},
  );
  if (elicit !== undefined) client.setRequestHandler(ElicitRequestSchema, async () => elicit());
  await Promise.all([server.connect(st), client.connect(ct)]);
  const call = async (name: string, args: Reply): Promise<Reply> => {
    const raw = (await client.callTool({ name, arguments: args }, undefined, {
      timeout: 600_000,
    })) as { content: Array<{ text: string }> };
    return JSON.parse(raw.content[0]!.text) as Reply;
  };
  return { call, sent, runStore };
}

describe('#715 (b) Amendment 4 (ii) — the judged snapshot is on no wire', () => {
  it('a value in a record field no reply carries (`params`) is in the judged snapshot, and absent from JSON.stringify(reply) and from renderReply(reply)', async () => {
    // (a) red when the snapshot rides the reply as a key (an enumerable `judged` field: JSON and the
    //     rendered envelope then hold the record's params); (b) prints booleans and key membership.
    const h = await makeTempHome();
    handles.push(h);
    const runStore = h.stores.runStore;
    const { record } = await runStore.create({
      workflowId: TWO.id,
      workflowVersion: 1,
      params: { note: SENTINEL },
    });
    const reply = await executeStep(runStore, TWO, {
      runId: record.id,
      command: 'a',
      input: {},
      dispatcher: async (_c, input) => input,
    });
    const judged = judgedSnapshotOf(reply);
    const rendered = renderReply(reply, mcpHostOf(undefined));
    expect({
      // non-vacuity: the snapshot holds the value, in a field the record has and the reply has not.
      judgedHoldsIt: JSON.stringify(judged?.record.params).includes(SENTINEL),
      recordHasParams: judged !== undefined && 'params' in judged.record,
      replyHasParams: 'params' in (JSON.parse(JSON.stringify(reply)) as Reply),
      // the doors: JSON (realm-cloud's `Response.json(envelope)` is this door) and the MCP render.
      json: JSON.stringify(reply).includes(SENTINEL),
      mcp: JSON.stringify(rendered.envelope).includes(SENTINEL),
    }).toEqual({
      judgedHoldsIt: true,
      recordHasParams: true,
      replyHasParams: false,
      json: false,
      mcp: false,
    });
  });
});

describe('#715 (b) Amendment 4 (iv), MCP half — execute_step reads the run no more after its call', () => {
  it('an answer that completes the run (its ended-run tail is composed) makes exactly the reads before and inside the engine call', async () => {
    // (a) red when execute_step reads the run again for the ended-run tail (one read more);
    //     (b) prints the count and the phase.
    const { call, runStore } = await connect([ONE]);
    const started = await call('start_run', { workflow_id: ONE.id });
    const before = runStore.gets;
    const done = await call('execute_step', {
      run_id: started['run_id'] as string,
      command: 'a',
      params: {},
    });
    expect({ phase: done['run_phase'], reads: runStore.gets - before }).toEqual({
      phase: 'completed',
      reads: EXECUTE_STEP_READS,
    });
  });
});

/**
 * The reads one `execute_step` makes on a run its answer completes (measured, 2026-10-30): the
 * tool's own and the engine's — none after the call.
 */
const EXECUTE_STEP_READS = 5;

describe('#715 (b) Amendment 4 addendum (v) — an after-statement composed from the judged snapshot is disclosed', () => {
  it('a form accepted after another route answered under a DECLARED name: the reply names the answerer, and the declared value reaches the wire only as the door’s marker', async () => {
    // (a) red when the after-form sentence leaves the door unwalked (the reply serialized raw, past
    //     `toolContentOf`): the declared name is then on the wire; (b) prints booleans and the hint with
    //     the value cut out.
    const QUESTION = loadWorkflowFromString(
      [
        'id: judged715bform',
        'name: judged715bform',
        'version: 1',
        'steps:',
        '  q:',
        '    description: Ask.',
        '    execution: auto',
        '    trust: human_confirmed',
        '    gate:',
        '      choices: [approve, reject]',
        '      message: Ship it?',
        '  after:',
        '    description: After.',
        '    execution: agent',
        '    depends_on: [q]',
      ].join('\n'),
    );
    const box: { runId?: string; gateId?: string; store?: JsonFileStore } = {};
    const { call, sent, runStore } = await connect(
      [QUESTION],
      {
        disclosureProvider: async () =>
          compileDisclosure([{ value: DECLARED, source: 'declared:API' }], {
            declared: 'resolved',
            audience: 'agent',
            environment: 'swept',
          }).set,
      },
      async () => {
        // Another route answers first, naming its answerer with the declared value.
        await submitHumanResponse(box.store!, QUESTION, {
          runId: box.runId!,
          gateId: box.gateId!,
          choice: 'reject',
          respondedBy: DECLARED,
          route: 'cli',
        });
        return { action: 'accept', content: { choice: 'approve' } };
      },
    );
    box.store = runStore;
    const { record } = await runStore.create({
      workflowId: QUESTION.id,
      workflowVersion: 1,
      params: {},
    });
    await advanceRun(runStore, QUESTION, { runId: record.id });
    box.runId = record.id;
    box.gateId = (await runStore.get(record.id)).record.pending_gate!.gate_id;
    const reply = await call('present_question', { run_id: box.runId, gate_id: box.gateId });
    const hint = String(reply['context_hint']);
    const stored = (await runStore.get(record.id)).record;
    expect({
      // non-vacuity: the record holds the declared name the sentence names.
      recordedBy: JSON.stringify(stored.evidence).includes(DECLARED),
      hintOpens: hint.startsWith(
        "Not recorded: the question on step 'q' was answered — reject, by \"",
      ),
      hintHoldsIt: hint.includes(DECLARED),
      wireHoldsIt: sent.some((m) => m.includes(DECLARED)),
      hint: hint.split(DECLARED).join('<DECLARED>'),
    }).toEqual({
      recordedBy: true,
      hintOpens: true,
      hintHoldsIt: false,
      wireHoldsIt: false,
      hint: expect.any(String),
    });
  });
});
