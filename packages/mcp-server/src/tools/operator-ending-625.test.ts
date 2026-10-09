// operator-ending-625.test.ts — issue #625 PR-2a, the last prompt's F2, over a real MCP client: the
// stopped agent's next call on a run an operator ended (`execute_step`, `advance_run`, a late
// `submit_human_response`, `start_run`'s key match) is never offered `realm run resume` — which would
// erase the operator's ending and its reason — and is told who ended it and why; `get_run_state`
// drops `resumable` there and still carries the ending as data. A failed run is still offered it.
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
  type RunRecord,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createRealmMcpServer } from '../server.js';

type Reply = Record<string, unknown>;

const DOCS = join(dirname(fileURLToPath(import.meta.url)), '../../../../docs/reference');

/** (a) red when the page no longer holds the sentence word for word; (b) prints it. */
function claim(page: string, sentence: string): void {
  const flat = (t: string) => t.replace(/\s+/g, ' ');
  expect(
    flat(readFileSync(join(DOCS, page), 'utf8')),
    `${page} no longer says: ${sentence}`,
  ).toContain(flat(sentence));
}

/** `a`, `b` (agent steps), `c` after `b` — the reviewer's workflow (`probes/a1/wf2`). */
const TWO = {
  id: 'two-branch',
  name: 'Two branches',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    a: { description: 'A.', execution: 'agent', depends_on: [] },
    b: { description: 'B.', execution: 'agent', depends_on: [] },
    c: { description: 'C.', execution: 'agent', depends_on: ['b'] },
  },
} as WorkflowDefinition;

const REASON = 'wrong run\nPhase: completed\u001b[31m RED';
const SHOWN = '"wrong run\\nPhase: completed\\u001b[31m RED"';
const SENTENCE = `An operator ended this run, with the reason ${SHOWN}; to run the work again, start a new run.`;

async function connect() {
  const dir = await mkdtemp(join(tmpdir(), 'realm-op-625-'));
  const runStore = new JsonFileStore(join(dir, 'runs'));
  const workflowStore = new JsonWorkflowStore(join(dir, 'wf'));
  const server = createRealmMcpServer({ runStore, workflowStore });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'operator-ending-625', version: '0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const call = async (name: string, args: Record<string, unknown>): Promise<Reply> => {
    const raw = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ text: string }>;
    };
    return JSON.parse(raw.content[0]!.text) as Reply;
  };
  await workflowStore.register(TWO);
  return { call, runStore };
}

/** A run (started with an idempotency key) whose step `a` failed, then ended as `how`. */
async function ended(how: 'abandoned' | 'failed', key: string) {
  const { call, runStore } = await connect();
  const runId = (await call('start_run', { workflow_id: TWO.id, idempotency_key: key }))[
    'run_id'
  ] as string;
  await runStore.update({ ...(await runStore.get(runId)), failed_steps: ['a'] });
  if (how === 'abandoned') {
    await call('abandon_run', { run_id: runId, reason: REASON });
  } else {
    await runStore.update({
      ...(await runStore.get(runId)),
      terminal_state: true,
      run_phase: 'failed',
      sealed_by: { arm: 'step_failure', step: 'a' },
    } as RunRecord);
  }
  return { call, runId };
}

describe('#625 PR-2a, F2 — over MCP, a run an operator ended is never offered the undo', () => {
  it('execute_step, advance_run, a late submit_human_response and start_run’s key match: the ending and its reason, one line, no realm run resume (discrimination)', async () => {
    claim(
      'mcp/tools.md',
      'for a run an operator ended (`abandoned`), never that offer — resuming it would erase the operator\'s ending and its reason — but who ended it and why: `An operator ended this run, with the reason "<reason>"; to run the work again, start a new run.`;',
    );
    claim(
      'mcp/tools.md',
      "`Run '<id>' is already terminal (<phase>); no steps executed.`, and for a run an engine failure ended with a failed step `realm run resume` takes, `'realm run resume <id> --from <step>' makes the failed step runnable again.` after it; for a run an operator ended, `An operator ended this run, with the reason \"<reason>\"; to run the work again, start a new run.` in its place",
    );
    claim(
      'mcp/tools.md',
      "`Run '<id>' is already terminal (<phase>); nothing ran.`, and for a run an engine failure ended with a failed step `realm run resume` takes, `'realm run resume <id> --from <step>' makes the failed step runnable again.` after it; for a run an operator ended, `An operator ended this run, with the reason \"<reason>\"; to run the work again, start a new run.` in its place",
    );
    claim(
      'mcp/tools.md',
      "`an operator ended this run, with the reason \"<reason>\"; to run the work again, start a new run; 'realm run purge <id>' previews what it would remove.` for an abandoned one (never `realm run resume`, which would erase the operator's ending and its reason);",
    );
    claim(
      'mcp/tools.md',
      'when an operator ended the run, with `An operator ended this run, with the reason "<reason>"; to run the work again, start a new run.`',
    );
    const { call, runId } = await ended('abandoned', 'op-625-key');
    const replies = {
      execute_step: await call('execute_step', { run_id: runId, command: 'b', params: {} }),
      advance_run: await call('advance_run', { run_id: runId }),
      submit_human_response: await call('submit_human_response', {
        run_id: runId,
        gate_id: 'g-old',
        choice: 'yes',
      }),
      start_run: await call('start_run', { workflow_id: TWO.id, idempotency_key: 'op-625-key' }),
    };
    const hints = Object.fromEntries(
      Object.entries(replies).map(([tool, r]) => [tool, String(r['context_hint'])]),
    );
    // (a) red when any reply offers `realm run resume`, drops the operator's ending or its reason, or
    //     prints the reason raw (a newline, an ESC); (b) prints each reply's hint.
    expect(
      Object.fromEntries(
        Object.entries(hints).map(([tool, h]) => [
          tool,
          {
            resume: h.includes('realm run resume'),
            ending:
              h.includes(SENTENCE) || h.includes(SENTENCE.replace(/^A/, 'a').replace(/\.$/, ';')),
            // eslint-disable-next-line no-control-regex -- a raw newline or ESC is what is looked for
            oneLine: !/[\n\u001b]/.test(h),
          },
        ]),
      ),
      JSON.stringify(hints),
    ).toEqual({
      execute_step: { resume: false, ending: true, oneLine: true },
      advance_run: { resume: false, ending: true, oneLine: true },
      submit_human_response: { resume: false, ending: true, oneLine: true },
      start_run: { resume: false, ending: true, oneLine: true },
    });
  });

  it('get_run_state on a run an operator ended: no resumable (discrimination); terminal_reason and sealed_by_arm still carry the ending (preservation)', async () => {
    claim(
      'mcp/tools.md',
      '`resumable` names, for a run an engine failure ended, the failed steps `realm run resume` takes and its command (never for a run an operator ended: its `terminal_reason` and `sealed_by_arm` say who ended it and why),',
    );
    claim(
      'mcp/run-state-and-health.md',
      "| `resumable` | An engine failure ended the run (`failed`) with a failed step `realm run resume` takes | `steps`, those steps (never a cleanup step), and `command`, `realm run resume <id> --from <step>`. Never for a run an operator ended (`abandoned`): resuming it would erase the operator's ending and its reason, which `terminal_reason` and `sealed_by_arm` give.",
    );
    const { call, runId } = await ended('abandoned', 'op-625-state');
    const s = await call('get_run_state', { run_id: runId });
    // (a) red when `resumable` is given for the operator's ending, or the ending's data goes;
    //     (b) prints the three fields.
    expect({
      resumable: s['resumable'] ?? '<absent>',
      terminal_reason: s['terminal_reason'],
      sealed_by_arm: s['sealed_by_arm'],
    }).toEqual({
      resumable: '<absent>',
      terminal_reason: REASON,
      sealed_by_arm: 'abandon_requested',
    });
  });

  it('a run an engine failure ended is still offered realm run resume — execute_step and get_run_state (preservation)', async () => {
    const { call, runId } = await ended('failed', 'op-625-failed');
    const r = await call('execute_step', { run_id: runId, command: 'b', params: {} });
    const s = await call('get_run_state', { run_id: runId });
    // (a) red when the failed run loses its offer; (b) prints the hint and resumable.
    expect({ hint: r['context_hint'], resumable: s['resumable'] }).toEqual({
      hint: `Run '${runId}' is already terminal (failed); no steps executed. 'realm run resume ${runId} --from a' makes the failed step runnable again.`,
      resumable: { steps: ['a'], command: `realm run resume ${runId} --from a` },
    });
  });
});
