// resume-owed-625.test.ts — issue #625 PR-2a (D7.5): after `realm run resume --from <failed auto step>`
// the step is owed to the engine, and resume names the call that runs it without a model.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  JsonFileStore,
  JsonWorkflowStore,
  ExtensionRegistry,
  executeChain,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { printChildrenWhenATestFails } from '../test-support/child-output.js';

const CLI_ENTRY = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const children = printChildrenWhenATestFails();

describe('#625 PR-2a — resume names the owed call', () => {
  it('`To run the step(s) the engine owes (…) without a model: realm run advance <id>` — the noun by count', async () => {
    const home = mkdtempSync(join(tmpdir(), 'realm-resume-owed-625-'));
    try {
      const d: WorkflowDefinition = {
        id: 'resume-owed-wf',
        name: 'resume owed',
        version: 1,
        schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
        steps: { a: { description: 'A', execution: 'auto', depends_on: [], handler: 'boom' } },
      };
      await new JsonWorkflowStore(join(home, '.realm', 'workflows')).register(d);
      const runs = new JsonFileStore(join(home, '.realm', 'runs'));
      const { run } = await runs.create({ workflowId: d.id, workflowVersion: 1, params: {} });
      const registry = new ExtensionRegistry();
      registry.register('handler', 'boom', {
        id: 'boom',
        execute: async () => {
          throw new Error('boom');
        },
      });
      await executeChain(runs, d, {
        runId: run.id,
        command: 'a',
        input: {},
        dispatcher: async () => ({}),
        registry,
      });
      expect((await runs.get(run.id)).failed_steps).toEqual(['a']);
      const r = spawnSync(process.execPath, [CLI_ENTRY, 'run', 'resume', run.id, '--from', 'a'], {
        env: { ...process.env, HOME: home },
        cwd: home,
        encoding: 'utf8',
      });
      children.record({ args: [CLI_ENTRY, 'run', 'resume', run.id, '--from', 'a'], ...r });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(
        `To run the step the engine owes ('a') without a model: realm run advance ${run.id}`,
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 60000);
});
