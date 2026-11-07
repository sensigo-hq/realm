// composers-mcp-715b.test.ts — issue #715 (b) 02 §B.2 (D6-17, D6-25): the MCP door's composers judge
// time at the reading of the record they describe — never the host's clock. Each run here ended with
// a cleanup step under another drainer's lease until 2020-01-01T00:00:01Z, and the store's (settable)
// clock stands one second BEFORE that: judged at the store's reading the lease is held ("held by
// another drainer's lease until …"); judged at the host's clock (years later) it has passed and the
// sentence would not say so.
//   - `start_run` with the run's key (a matched run): its hand-back sentence (`handBackHint`);
//   - `start_run_batch` with the same key: the item's hint.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect, afterEach } from 'vitest';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  InMemoryTraceBufferStore,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { InMemoryStore, settableClock } from '@sensigo/realm-testing';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createRealmMcpServer } from './server.js';
import { makeTempHome, type TempHome } from './test-support/temp-home.js';

const LEASE = '2020-01-01T00:00:01.000Z';
const HELD = `held by another drainer's lease until ${LEASE}`;

const DEF: WorkflowDefinition = {
  id: 'composers-mcp-715b',
  name: 'composers-mcp-715b',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: { a: { description: 'A.', execution: 'agent', depends_on: [] } },
};

type Reply = Record<string, unknown>;

const handles: TempHome[] = [];
afterEach(async () => {
  for (const h of handles.splice(0).reverse()) await h.cleanup();
});

async function server() {
  const clock = settableClock(new Date(Date.parse(LEASE) - 1_000));
  const runStore = new InMemoryStore({ clock });
  const h = await makeTempHome();
  handles.push(h);
  const workflowStore = h.stores.workflowStore;
  await workflowStore.register(DEF);
  const s = createRealmMcpServer({
    runStore,
    workflowStore,
    traceBufferStore: new InMemoryTraceBufferStore(runStore),
    failedAttemptStore: h.stores.failedAttemptStore,
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'composers-mcp-715b', version: '0' });
  await Promise.all([s.connect(st), client.connect(ct)]);
  const call = async (name: string, args: Reply): Promise<Reply> => {
    const raw = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ text: string }>;
    };
    return JSON.parse(raw.content[0]!.text) as Reply;
  };
  // A keyed run, then ended with a cleanup step under another drainer's lease.
  const { record } = await runStore.create({
    workflowId: DEF.id,
    workflowVersion: 1,
    params: {},
    idempotencyKey: 'k-715b',
  });
  // Ended through the store's seal (the one way a run is sealed), then a cleanup step left pending
  // under another drainer's lease.
  await runStore.settleStep(record.id, {
    kind: 'seal_run',
    arm: 'abandon_requested',
    reason: 'ended for the cell',
    expected_version: record.version,
    release_claims: true,
  });
  const { record: ended } = await runStore.get(record.id);
  await runStore.update({
    ...ended,
    finalizer_ledger: {
      tidy: { status: 'pending', rank: 0, lease_token: 'other', lease_deadline: LEASE },
    },
  });
  return { call };
}

describe('#715 (b) §B.2 — the MCP composers judge at the record’s reading', () => {
  it('start_run on a matched ended run: the hand-back names the lease as held at the store’s reading', async () => {
    // (a) red when handBackHint judges the ended run's ways at the host's clock (the lease has
    //     passed there: no "held"); (b) prints the hint.
    const { call } = await server();
    const reply = await call('start_run', { workflow_id: DEF.id, idempotency_key: 'k-715b' });
    expect(String(reply['context_hint']).includes(HELD), String(reply['context_hint'])).toBe(true);
  });

  it('start_run_batch with the same key: the item’s hint names the lease as held at the store’s reading', async () => {
    // (a) red when the batch judges its item at the host's clock; (b) prints the item's hint.
    const { call } = await server();
    const reply = await call('start_run_batch', {
      workflow_id: DEF.id,
      items: [{ params: {}, idempotency_key: 'k-715b' }],
    });
    const hint = String((reply['started'] as Array<Record<string, unknown>>)[0]?.['context_hint']);
    expect(hint.includes(HELD), hint).toBe(true);
  });

  it('submit_human_response on an answer that ends the run: the ended run’s tail is composed from the answer’s snapshot — no read after the call', async () => {
    // (a) red when the tool reads the run again for the ended run's tail (one read more); (b) prints
    //     the count and the phase.
    const ONE_Q: WorkflowDefinition = {
      id: 'answer-ends-715b',
      name: 'answer-ends-715b',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: {
        q: {
          description: 'Q.',
          execution: 'auto',
          trust: 'human_confirmed',
          depends_on: [],
          gate: { choices: ['approve', 'reject'] },
        },
      },
    };
    const store = new InMemoryStore();
    let gets = 0;
    const counting = new Proxy(store, {
      get(target, prop) {
        if (prop === 'get') {
          return async (id: string) => {
            gets += 1;
            return target.get(id);
          };
        }
        const v = Reflect.get(target, prop, target) as unknown;
        return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(target) : v;
      },
    }) as unknown as InMemoryStore;
    const h = await makeTempHome();
    handles.push(h);
    const workflowStore = h.stores.workflowStore;
    await workflowStore.register(ONE_Q);
    const s2 = createRealmMcpServer({
      runStore: counting,
      workflowStore,
      traceBufferStore: new InMemoryTraceBufferStore(counting),
      failedAttemptStore: h.stores.failedAttemptStore,
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'answer-ends-715b', version: '0' });
    await Promise.all([s2.connect(st), client.connect(ct)]);
    const call = async (name: string, args: Reply): Promise<Reply> => {
      const raw = (await client.callTool({ name, arguments: args })) as {
        content: Array<{ text: string }>;
      };
      return JSON.parse(raw.content[0]!.text) as Reply;
    };
    const started = await call('start_run', { workflow_id: ONE_Q.id });
    const runId = started['run_id'] as string;
    const gateId = (await store.get(runId)).record.pending_gate!.gate_id;
    const before = gets;
    const done = await call('submit_human_response', {
      run_id: runId,
      gate_id: gateId,
      choice: 'approve',
    });
    expect({ phase: done['run_phase'], reads: gets - before }).toEqual({
      phase: 'completed',
      reads: SUBMIT_READS,
    });
  });
});

/** The reads one `submit_human_response` makes on a run its answer completes (measured): before and
 *  inside the engine call — none after it. */
const SUBMIT_READS = 4;
