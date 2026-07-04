// Spawn-based test (patterned on mcp-server's server.entry.test.ts): a listen-spawned child
// is `realm agent --run-id <id>`. When the run's workflow declares a BROKEN extensions module,
// the child must exit nonzero AND mark the run terminal_reason 'extensions_load_failed'
// (the "fail the run visibly" half of the invariant — the run is never silently stranded).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonFileStore, JsonWorkflowStore, CURRENT_WORKFLOW_SCHEMA_VERSION } from '@sensigo/realm';
import type { WorkflowDefinition } from '@sensigo/realm';

// The compiled CLI entry — turbo runs test after build, so dist/ exists.
const DIST_CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'index.js');

function spawnAgentChild(
  runId: string,
  home: string,
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [DIST_CLI, 'agent', '--run-id', runId], {
      cwd: home,
      env: {
        ...process.env,
        HOME: home,
        // A key must be present so provider resolution succeeds; no LLM call happens —
        // the extension load fails first.
        OPENAI_API_KEY: 'test-key-never-used',
        ANTHROPIC_API_KEY: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`agent child did not exit within 15s. stderr: ${stderr}`));
    }, 15_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

describe('listen child failure path (spawn-based)', () => {
  let home: string;

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'realm-child-ext-'));
  });

  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('a real agent --run-id child against a broken module exits nonzero and writes extensions_load_failed', async () => {
    // Project tree: package.json trust root, broken module in dist/, workflow nested below.
    const proj = join(home, 'proj');
    const workflowDir = join(proj, 'workflows', 'wf');
    mkdirSync(join(proj, 'dist'), { recursive: true });
    mkdirSync(workflowDir, { recursive: true });
    writeFileSync(join(proj, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
    writeFileSync(
      join(proj, 'dist', 'broken.js'),
      `throw new Error('broken module: top-level import failure');`,
      'utf8',
    );

    const definition: WorkflowDefinition = {
      id: 'child-ext-wf',
      name: 'Child Ext WF',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: { s1: { description: 'step', execution: 'agent' } },
      origin: 'human',
      extensions: ['../../dist/broken.js'],
      source_dir: workflowDir,
      trust_root: proj,
    };
    const workflowStore = new JsonWorkflowStore(join(home, '.realm', 'workflows'));
    await workflowStore.register(definition);

    const runStore = new JsonFileStore(join(home, '.realm', 'runs'));
    const { run } = await runStore.create({
      workflowId: 'child-ext-wf',
      workflowVersion: 1,
      params: {},
    });

    const { code, stderr } = await spawnAgentChild(run.id, home);
    expect(code).not.toBe(0);
    expect(stderr).toContain('broken module: top-level import failure');

    const marked = await runStore.get(run.id);
    expect(marked.terminal_state).toBe(true);
    expect(marked.terminal_reason).toBe('extensions_load_failed');
  }, 20_000);
});
