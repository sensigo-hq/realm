// cleanup-owed-625.test.ts — issue #625 PR-2a, the last prompt's F11 (review G5-2): the refusal of an
// answer to a COMPLETED run whose ending left a cleanup step `pending` never says "nothing is owed"
// beside it — it says the cleanup step and the command that runs it, in `pendingCleanupWay`'s words,
// once: in the library's refusal, and once in the MCP reply (which ended with its own cleanup
// sentence after the refusal, so the reply contradicted itself).
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
  submitHumanResponse,
  type StepDefinition,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { handleSubmitHumanResponse } from './submit-human-response.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

/** (a) red when the page no longer holds the sentence word for word; (b) prints it. */
function claim(page: string, sentence: string): void {
  const flat = (t: string) => t.replace(/\s+/g, ' ');
  expect(
    flat(readFileSync(join(ROOT, page), 'utf8')),
    `${page} no longer says: ${sentence}`,
  ).toContain(flat(sentence));
}

/** `s` (auto), and a cleanup step `tidy` whose handler `withTidy` decides whether this program has. */
const def = (withTidy: boolean): WorkflowDefinition => ({
  id: withTidy ? 'f11-done' : 'f11-pending',
  name: 'f11',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    s: { description: 'S.', execution: 'auto', depends_on: [] },
    ...(withTidy
      ? {}
      : {
          tidy: {
            description: 'Tidy.',
            execution: 'finalizer',
            handler: 'tidy',
            on_outcome: 'always',
          } as StepDefinition,
        }),
  },
});

const PENDING_WAY = (id: string) =>
  `it completed; cleanup step left pending: 'tidy' — 'realm run drain ${id} --force' runs it with code that has its handler.`;

describe('#625 PR-2a, F11 — the ended-run refusal never says "nothing is owed" beside a pending cleanup step', () => {
  async function completed(withTidyMissing: boolean) {
    const dir = await mkdtemp(join(tmpdir(), 'f11-'));
    const runStore = new JsonFileStore(join(dir, 'runs'));
    const workflowStore = new JsonWorkflowStore(join(dir, 'wf'));
    const d = def(!withTidyMissing);
    await workflowStore.register(d);
    const { run } = await runStore.create({ workflowId: d.id, workflowVersion: 1, params: {} });
    // the run completes; its cleanup step has no handler here, so the ending leaves it pending
    await advanceRun(runStore, d, { runId: run.id });
    return { runStore, workflowStore, d, id: run.id };
  }

  it('the library’s refusal says the pending cleanup step and its command; the MCP reply says it once', async () => {
    claim(
      'docs/reference/mcp/tools.md',
      "`it completed, and nothing is owed.` for a completed run, or, when its ending left a cleanup step pending, `it completed; cleanup step left pending: '<name>' — 'realm run drain <id> --force' runs it with code that has its handler.`, said once (added after version 0.46.0);",
    );
    const r = await completed(true);
    const ledger = (await r.runStore.get(r.id)).finalizer_ledger?.['tidy']?.status;
    const lib = await submitHumanResponse(r.runStore, r.d, {
      runId: r.id,
      gateId: 'g-old',
      choice: 'yes',
    });
    const mcp = await handleSubmitHumanResponse(
      { run_id: r.id, gate_id: 'g-old', choice: 'yes' },
      { runStore: r.runStore, workflowStore: r.workflowStore },
    );
    const times = (text: string) => text.split(`'realm run drain ${r.id} --force'`).length - 1;
    // (a) red when the refusal says "nothing is owed" beside the pending cleanup step, or the MCP
    //     reply states the cleanup step twice; (b) prints the refusal, the reply's hint and the count.
    expect({
      ledger,
      library: lib.errors[0],
      mcpHint: mcp.context_hint,
      mcpTimes: times(mcp.context_hint),
    }).toEqual({
      ledger: 'pending',
      library: `Run '${r.id}' is terminal (completed); cannot submit a gate response — ${PENDING_WAY(r.id)}`,
      mcpHint: `Run '${r.id}' is terminal (completed); cannot submit a gate response — ${PENDING_WAY(r.id)}`,
      mcpTimes: 1,
    });
  });

  it('a completed run with no cleanup step pending (preservation): "it completed, and nothing is owed."', async () => {
    const r = await completed(false);
    const lib = await submitHumanResponse(r.runStore, r.d, {
      runId: r.id,
      gateId: 'g-old',
      choice: 'yes',
    });
    // (a) red when a completed run with nothing owed is said otherwise; (b) prints the refusal.
    expect(lib.errors[0]).toBe(
      `Run '${r.id}' is terminal (completed); cannot submit a gate response — it completed, and nothing is owed.`,
    );
  });
});
