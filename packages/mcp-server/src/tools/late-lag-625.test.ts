// late-lag-625.test.ts — issue #625 PR-2a, the last prompt's F1, over a real MCP client: the tool that
// carries out an expired question says how long before it the question's time was up (seconds under a
// minute), and a late answer's reply carries the fact typed (`error_details.expired_at`, `overdue_ms`).
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
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
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createRealmMcpServer } from '../server.js';

type Reply = Record<string, unknown>;

async function connect() {
  const dir = await mkdtemp(join(tmpdir(), 'realm-lag-625-'));
  const runStore = new JsonFileStore(join(dir, 'runs'));
  const workflowStore = new JsonWorkflowStore(join(dir, 'wf'));
  const server = createRealmMcpServer({ runStore, workflowStore });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'late-lag-625', version: '0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const call = async (name: string, args: Record<string, unknown>): Promise<Reply> => {
    const raw = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ text: string }>;
    };
    return JSON.parse(raw.content[0]!.text) as Reply;
  };
  return { call, runStore, workflowStore };
}

/** `confirm` (a question, `on_expiry` as given, default `approve`), then a bare `auto` step `after`. */
const gated = (id: string, onExpiry: 'settle_default' | 'abort'): WorkflowDefinition =>
  ({
    id,
    name: id,
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps: {
      confirm: {
        description: 'Confirm',
        execution: 'auto',
        trust: 'human_confirmed',
        depends_on: [],
        gate: {
          choices: ['approve', 'reject'],
          timeout_seconds: 3600,
          on_expiry: onExpiry,
          ...(onExpiry === 'settle_default' ? { default_choice: 'approve' } : {}),
        },
      },
      after: { description: 'After', execution: 'auto', depends_on: ['confirm'] },
    },
  }) as WorkflowDefinition;

/** Every whole-second lag a call in `window` could say for a question that expired at `at`. */
const seconds = (at: number, window: readonly [number, number]): string[] => {
  const out: string[] = [];
  for (let s = Math.floor((window[0] - at) / 1000); s <= Math.floor((window[1] - at) / 1000); s++)
    out.push(`${s}s`);
  return out;
};

describe('#625 PR-2a, F1 — over MCP the expiry line says how late; the late answer carries it typed', () => {
  /** A run at its question, whose time was up 15 s ago (the stored `expires_at` moved back). */
  async function late(onExpiry: 'settle_default' | 'abort', id: string) {
    const { call, runStore, workflowStore } = await connect();
    await workflowStore.register(gated(id, onExpiry));
    const runId = (await call('start_run', { workflow_id: id }))['run_id'] as string;
    const record = await runStore.get(runId);
    const at = Date.now() - 15_000;
    const expiresAt = new Date(at).toISOString();
    await runStore.update({
      ...record,
      pending_gate: { ...record.pending_gate!, expires_at: expiresAt },
    });
    return { call, runId, gateId: record.pending_gate!.gate_id, at, expiresAt };
  }

  it.each([
    ['settle_default', 'approve'],
    ['settle_default', 'reject'],
    ['abort', 'approve'],
  ] as const)(
    'submit_human_response, %s, the answer %s: the line names the tool and the lag in seconds; error_details carries expired_at and overdue_ms',
    async (onExpiry, choice) => {
      const q = await late(onExpiry, `lag-submit-${onExpiry}-${choice}`);
      const t0 = Date.now();
      const r = await q.call('submit_human_response', {
        run_id: q.runId,
        gate_id: q.gateId,
        choice,
      });
      const window = [t0, Date.now()] as const;
      const details = r['error_details'] as Reply | undefined;
      const line =
        ((r['warnings'] as string[]) ?? []).find((w) => w.includes('had expired')) ?? '<no line>';
      const lag = /had expired (\S+) before this call/.exec(line)?.[1] ?? '<no lag>';
      const overdue = details?.['overdue_ms'];
      const did =
        onExpiry === 'settle_default'
          ? "settle_default: the default choice 'approve' was recorded"
          : 'abort: the run ended';
      // (a) red when the line drops the lag, says minutes under a minute, or the reply does not carry
      //     the question's `expires_at` and a lag in milliseconds that the call's window allows;
      //     (b) prints the line and the two fields.
      expect({
        line,
        lagFits: seconds(q.at, window).includes(lag),
        expired_at: details?.['expired_at'],
        overdueFits:
          typeof overdue === 'number' &&
          overdue >= window[0] - q.at - 1 &&
          overdue <= window[1] - q.at + 1,
      }).toEqual({
        line: `gate '${q.gateId}' on 'confirm' had expired ${lag} before this call — this submit_human_response call first carried out its declared ${did} (enacted_via: submit_human_response).`,
        lagFits: true,
        expired_at: q.expiresAt,
        overdueFits: true,
      });
    },
  );

  it('advance_run carries out an expired question: the line names the tool and the lag in seconds', async () => {
    const q = await late('settle_default', 'lag-advance');
    const t0 = Date.now();
    const r = await q.call('advance_run', { run_id: q.runId });
    const window = [t0, Date.now()] as const;
    const line =
      ((r['warnings'] as string[]) ?? []).find((w) => w.includes('had expired')) ?? '<no line>';
    const lag = /had expired (\S+) before this call/.exec(line)?.[1] ?? '<no lag>';
    // (a) red when advance_run's line drops the lag or says it in minutes; (b) prints the line.
    expect({ line, lagFits: seconds(q.at, window).includes(lag) }).toEqual({
      line: `gate '${q.gateId}' on 'confirm' had expired ${lag} before this call — this advance_run call first carried out its declared settle_default: the default choice 'approve' was recorded (enacted_via: advance_run).`,
      lagFits: true,
    });
  });
});
