// cleanup-held-625.test.ts — issue #625 PR-2a, the last prompt's F12 on MCP (review G3-1): a cleanup
// step under another drainer's lease is said as held, through core's `pendingCleanupWay` —
// `get_run_state`'s `cleanup_pending` carries `held_until` while the lease has not passed, and a
// reply that ends with the cleanup sentence says the lease, its deadline and the command for after
// it; never that the drainer is alive or dead. A live and an expired lease each.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  JsonFileStore,
  JsonWorkflowStore,
  ExtensionRegistry,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  advanceRun,
  type StepDefinition,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { handleGetRunState } from './get-run-state.js';
import { handleAdvanceRun } from './advance-run.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

/** (a) red when the page no longer holds the sentence word for word; (b) prints it. */
function claim(page: string, sentence: string): void {
  const flat = (t: string) => t.replace(/\s+/g, ' ');
  expect(
    flat(readFileSync(join(ROOT, page), 'utf8')),
    `${page} no longer says: ${sentence}`,
  ).toContain(flat(sentence));
}

const DEF: WorkflowDefinition = {
  id: 'held-mcp-625',
  name: 'held-mcp-625',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    s: { description: 'S.', execution: 'auto', depends_on: [] },
    tidy: {
      description: 'Tidy.',
      execution: 'finalizer',
      handler: 'cleanup',
      on_outcome: 'always',
    } as StepDefinition,
  },
};

/** A completed run whose cleanup step `tidy` was left pending, then leased by another drainer. */
async function heldRun(lease: 'live' | 'expired') {
  const dir = await mkdtemp(join(tmpdir(), 'held-mcp-625-'));
  const runStore = new JsonFileStore(join(dir, 'runs'));
  const workflowStore = new JsonWorkflowStore(join(dir, 'wf'));
  await workflowStore.register(DEF);
  const { run } = await runStore.create({ workflowId: DEF.id, workflowVersion: 1, params: {} });
  await advanceRun(runStore, DEF, { runId: run.id, registry: new ExtensionRegistry() });
  await runStore.settleStep!(
    run.id,
    { kind: 'lease_finalizer', finalizer: 'tidy', leaseToken: 'other-drain', leaseSeconds: 300 },
    DEF,
  );
  if (lease === 'expired') {
    const r = await runStore.get(run.id);
    await runStore.update({
      ...r,
      finalizer_ledger: {
        ...r.finalizer_ledger,
        tidy: {
          ...r.finalizer_ledger!['tidy']!,
          lease_deadline: new Date(Date.now() - 60_000).toISOString(),
        },
      },
    });
  }
  const tidy = (await runStore.get(run.id)).finalizer_ledger!['tidy']!;
  return { runStore, workflowStore, id: run.id, until: tidy.lease_deadline!, status: tidy.status };
}

describe('#625 PR-2a, F12 — MCP says a cleanup step under another drainer’s lease as held', () => {
  it.each(['live', 'expired'] as const)(
    'get_run_state, %s lease: cleanup_pending carries held_until only while the lease has not passed',
    async (lease) => {
      claim(
        'docs/reference/mcp/run-state-and-health.md',
        "`held_until`, while another drainer's lease on one of them has not passed: the time it passes — the command runs nothing before then, and realm cannot tell whether that drainer is still running (added after version 0.46.0).",
      );
      const r = await heldRun(lease);
      const state = await handleGetRunState(
        { run_id: r.id },
        { runStore: r.runStore, workflowStore: r.workflowStore },
      );
      // (a) red when `cleanup_pending` offers the command as if it ran the step now under a live lease
      //     (G3-1), or says held once the lease has passed; (b) prints the field.
      expect({ status: r.status, cleanup_pending: state.cleanup_pending }).toEqual({
        status: 'pending',
        cleanup_pending: {
          steps: ['tidy'],
          command: `realm run drain ${r.id} --force`,
          ...(lease === 'live' ? { held_until: r.until } : {}),
        },
      });
    },
  );

  it.each(['live', 'expired'] as const)(
    'a reply on the ended run (advance_run), %s lease: the held sentence while the lease has not passed',
    async (lease) => {
      claim(
        'docs/reference/mcp/tools.md',
        "(while another drainer's lease on it has not passed: ` Cleanup step left pending: '<name>' — held by another drainer's lease until <time> (realm cannot tell whether it is still running) — after <time>, 'realm run drain <id> --force' runs it with code that has its handler.`, added after version 0.46.0)",
      );
      const r = await heldRun(lease);
      const reply = await handleAdvanceRun(
        { run_id: r.id },
        { runStore: r.runStore, workflowStore: r.workflowStore, registry: new ExtensionRegistry() },
      );
      const command = `'realm run drain ${r.id} --force' runs it with code that has its handler.`;
      // (a) red when the reply offers the command as if it ran the step now under a live lease, or
      //     says held once the lease has passed; (b) prints the hint's end.
      expect(
        reply.context_hint.slice(reply.context_hint.indexOf(' Cleanup step left pending')),
      ).toBe(
        lease === 'live'
          ? ` Cleanup step left pending: 'tidy' — held by another drainer's lease until ${r.until} (realm cannot tell whether it is still running) — after ${r.until}, ${command}`
          : ` Cleanup step left pending: 'tidy' — ${command}`,
      );
    },
  );
});
