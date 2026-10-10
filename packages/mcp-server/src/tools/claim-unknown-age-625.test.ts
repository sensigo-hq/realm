// claim-unknown-age-625.test.ts — issue #625 PR-2a, the last prompt's F14 (review F-R5): `get_run_state`
// never says `claim_unknown_age` with no claim in flight. The open question's own claim is not work in
// flight; once it is set aside the list can be empty, and an empty list is no claim at all. The
// reviewer's case — an expired question that declares `on_expiry`, on a server that cannot read the
// run's workflow — reads `workflow_unresolved`, as `gates.md` says.
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
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  advanceRun,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { handleGetRunState } from './get-run-state.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

/** (a) red when the page no longer holds the sentence word for word; (b) prints it. */
function claim(page: string, sentence: string): void {
  const flat = (t: string) => t.replace(/\s+/g, ' ');
  expect(
    flat(readFileSync(join(ROOT, page), 'utf8')),
    `${page} no longer says: ${sentence}`,
  ).toContain(flat(sentence));
}

/** `confirm` (a question, 60 s, `on_expiry: settle_default`), then `after`. */
const GATED: WorkflowDefinition = {
  id: 'f14-gated',
  name: 'f14-gated',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    confirm: {
      description: 'Confirm.',
      execution: 'auto',
      trust: 'human_confirmed',
      depends_on: [],
      gate: {
        choices: ['approve', 'reject'],
        timeout_seconds: 60,
        on_expiry: 'settle_default',
        default_choice: 'approve',
      },
    },
    after: { description: 'After.', execution: 'auto', depends_on: ['confirm'] },
  },
};

describe('#625 PR-2a, F14 — get_run_state never says claim_unknown_age with no claim in flight', () => {
  /** A run whose question is open, then its time made up (its `expires_at` a minute ago). */
  async function expired(register: boolean) {
    const dir = await mkdtemp(join(tmpdir(), 'f14-'));
    const runStore = new JsonFileStore(join(dir, 'runs'));
    const workflowStore = new JsonWorkflowStore(join(dir, 'wf'));
    if (register) await workflowStore.register(GATED);
    const { run } = await runStore.create({ workflowId: GATED.id, workflowVersion: 1, params: {} });
    await advanceRun(runStore, GATED, { runId: run.id });
    const open = await runStore.get(run.id);
    await runStore.update({
      ...open,
      pending_gate: {
        ...open.pending_gate!,
        expires_at: new Date(Date.now() - 60_000).toISOString(),
      },
    });
    const record = await runStore.get(run.id);
    return { runStore, workflowStore, id: run.id, inProgress: record.in_progress_steps };
  }

  it('an expired question that declares on_expiry, the workflow unreadable: workflow_unresolved — never claim_unknown_age', async () => {
    claim(
      'docs/reference/workflow/gates.md',
      'A server that cannot read the workflow says `workflow_unresolved` instead.',
    );
    const r = await expired(false);
    const state = await handleGetRunState(
      { run_id: r.id },
      { runStore: r.runStore, workflowStore: r.workflowStore },
    );
    // (a) red when the question's own claim, set aside, leaves an empty list that reads as
    //     `claim_unknown_age` (F-R5); (b) prints the status, the claims in progress and stuck_claims.
    expect({
      inProgress: r.inProgress,
      status: state.next_actions_status,
      stuck: state.stuck_claims,
    }).toEqual({ inProgress: ['confirm'], status: 'workflow_unresolved', stuck: undefined });
  });

  it('the same question with the workflow readable (preservation): advance_owed', async () => {
    const r = await expired(true);
    const state = await handleGetRunState(
      { run_id: r.id },
      { runStore: r.runStore, workflowStore: r.workflowStore },
    );
    // (a) red when an expired question that declares `on_expiry` is not said owed to advance_run;
    //     (b) prints the status.
    expect(state.next_actions_status).toBe('advance_owed');
  });
});
