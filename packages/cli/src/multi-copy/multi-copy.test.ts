// The multi-copy test (issue #620 PR-B): npm sometimes installs realm more than once in one
// project — the project's own `@sensigo/realm`, and a copy of its own under each of realm-cli,
// realm-mcp and realm-testing. Each copy has its own classes, so `err instanceof WorkflowError` is
// false for an error another copy made.
//
// This file proves what a copy does with an object another copy made, on a layout built from the
// BUILT packages (`layout.ts`): rows 1–9 are the crossings that went wrong, row 10 is the control
// (a copy of ANOTHER release is never recognised), row 11 is the non-vacuity guard (the copies are
// distinct, and none silently resolved the repository's own workspace).
//
// The assertions state what must hold once copies of one release recognise each other. Written
// before the change, rows 1–9 are red and rows 10–11 are green.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { RunRecord, RunStore, PerRunArtifactStore, WorkflowDefinition } from '@sensigo/realm';
import {
  buildLayout,
  describeSpawn,
  recordResolvedFiles,
  REPO_ROOT,
  runNode,
  type Copy,
  type Layout,
} from './layout.js';

type Core = typeof import('@sensigo/realm');
type Mcp = typeof import('@sensigo/realm-mcp');
type Testing = typeof import('@sensigo/realm-testing');
type GcModule = typeof import('../commands/gc.js');
type PurgeModule = typeof import('../commands/purge.js');
type LlmProviderModule = typeof import('../agent/providers/llm-provider.js');

const SETUP_TIMEOUT = 120_000;
const TEST_TIMEOUT = 60_000;
const ONE_HOUR_MS = 3_600_000;

let layout: Layout;
const scratch: string[] = [];

beforeAll(async () => {
  layout = await buildLayout();
}, SETUP_TIMEOUT);

afterAll(async () => {
  await layout.cleanup();
  for (const dir of scratch) await rm(dir, { recursive: true, force: true });
});

/** A fresh temp folder, removed at the end. Every store and every spawned process gets one. */
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `realm-mc-${prefix}-`));
  scratch.push(dir);
  return dir;
}

const core = (copy: Copy): Promise<Core> => layout.load<Core>(copy);

/** A terminal run record, written directly (a store's `create` would stamp its own timestamps). */
function makeRun(overrides: Partial<RunRecord> & { id: string }): RunRecord {
  const now = new Date().toISOString();
  return {
    workflow_id: 'wf-1',
    workflow_version: 1,
    run_phase: 'completed',
    completed_steps: [],
    in_progress_steps: [],
    failed_steps: [],
    skipped_steps: [],
    params: {},
    evidence: [],
    version: 0,
    created_at: now,
    updated_at: now,
    terminal_state: true,
    sealed_by: { arm: 'complete' },
    ...overrides,
  };
}

async function injectRun(dir: string, run: RunRecord): Promise<void> {
  await writeFile(join(dir, `${run.id}.json`), JSON.stringify(run, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------------------------
// Row 1 — gc: a `Run not found` thrown by the CLI copy's run store, read by realm-mcp's core copy
// inside the trace-buffer fence.
// ---------------------------------------------------------------------------------------------

const ORPHAN_ID = '22222222-2222-4222-8222-222222222222';

/** Reaps one orphaned trace file, the run store being `runStoreCore`'s `JsonFileStore`. */
async function reapOrphanWith(runStoreCore: Copy): Promise<{
  reaped: number;
  failed: string[];
}> {
  const dir = await tempDir('gc');
  const cliCore = await core(runStoreCore);
  const mcp = await layout.load<Mcp>(layout.cli.mcp);
  const gc = await layout.load<GcModule>(layout.cli.cli, 'dist/commands/gc.js');

  const runStore = new cliCore.JsonFileStore(dir);
  const trace = new mcp.JsonTraceBufferStore(dir, runStore);
  await trace.append(ORPHAN_ID, 'step-a', [{ event: 'x' }]);
  const wal = join(
    dir,
    `trace-buffer-${ORPHAN_ID}-${Buffer.from('step-a').toString('base64url')}.jsonl`,
  );
  const backdated = new Date(Date.now() - 2 * ONE_HOUR_MS);
  await utimes(wal, backdated, backdated);

  const liveRunIds = await runStore.listRunIds();
  const result = await gc.sweepOrphanArtifacts([trace], liveRunIds, {
    olderThanMs: ONE_HOUR_MS,
    dryRun: false,
  });
  return { reaped: result.reaped.length, failed: result.failed.map((f) => f.error) };
}

// ---------------------------------------------------------------------------------------------
// Row 2 — purge: a run resumed mid-purge; realm-mcp's core copy refuses the trace-buffer delete.
// ---------------------------------------------------------------------------------------------

/** What `purgeRuns` (the CLI copy's) files a refusal as, the trace-buffer store being `traceFor`. */
async function purgeResumedRun(
  makeTrace: (dir: string, anchor: Pick<RunStore, 'get'>) => Promise<PerRunArtifactStore>,
): Promise<{
  blocked: Array<{ reason: string }>;
  failed: Array<{ error: string }>;
  purged: string[];
}> {
  const dir = await tempDir('purge');
  const cliCore = await core(layout.cli.cliCore);
  const purge = await layout.load<PurgeModule>(layout.cli.cli, 'dist/commands/purge.js');
  const runStore = new cliCore.JsonFileStore(dir);
  const id = 'resumed-mid-purge';
  await injectRun(dir, makeRun({ id }));

  let getCalls = 0;
  const anchorStub: Pick<RunStore, 'get' | 'list'> & PerRunArtifactStore & { runsDirPath: string } =
    {
      runsDirPath: runStore.runsDirPath,
      get: async (runId: string) => {
        getCalls++;
        // Calls 1–2 are purge's own selection and pre-delete re-check (still terminal). Call 3 on is
        // the fence's read from inside the trace buffer — a `realm run resume` landing exactly there.
        if (getCalls <= 2) return runStore.get(runId);
        const fresh = await runStore.get(runId);
        return { ...fresh, run_phase: 'running' as const, terminal_state: false };
      },
      list: (workflowId?: string) => runStore.list(workflowId),
      statAllForRun: (runId: string, dirEntries?: readonly string[]) =>
        runStore.statAllForRun(runId, dirEntries),
      deleteAllForRun: (runId: string, dirEntries?: readonly string[]) =>
        runStore.deleteAllForRun(runId, dirEntries),
    };
  const trace = await makeTrace(dir, anchorStub);
  const result = await purge.purgeRuns({ runId: id, dryRun: false }, anchorStub, [trace]);
  return { blocked: result.blocked, failed: result.failed, purged: result.purged };
}

/** The real `JsonTraceBufferStore` of realm-mcp's own copy, holding one WAL line for the run. */
async function realTraceFor(
  dir: string,
  anchor: Pick<RunStore, 'get'>,
): Promise<PerRunArtifactStore> {
  const mcp = await layout.load<Mcp>(layout.cli.mcp);
  const trace = new mcp.JsonTraceBufferStore(dir, anchor);
  await trace.append('resumed-mid-purge', 'step-agent', [{ event: 'e' }]);
  return trace;
}

// ---------------------------------------------------------------------------------------------
// Row 3 — reclaim: `ReclaimVersionChanged` thrown by realm-mcp's core copy.
// ---------------------------------------------------------------------------------------------

async function reclaimWith(
  seal: 'mcp-core' | { otherCore: Copy },
): Promise<{ outcome?: string; thrown?: string; warnings: string[]; stillInProgress: boolean }> {
  const dir = await tempDir('reclaim');
  const cliCore = await core(layout.cli.cliCore);
  const mcp = await layout.load<Mcp>(layout.cli.mcp);
  const store = new cliCore.JsonFileStore(dir);
  const id = 'reclaim-run';
  await injectRun(
    dir,
    makeRun({
      id,
      run_phase: 'running',
      terminal_state: false,
      in_progress_steps: ['work'],
      claims: { work: { deadline: '2020-01-01T00:00:00.000Z' } },
      version: 1,
    }),
  );
  // The trace buffer reads the run through a reader that sees it ALREADY CHANGED (version 8): the
  // reclaim decision was taken at version 1.
  const reader = { get: async (runId: string) => ({ ...(await store.get(runId)), version: 8 }) };
  const real = new mcp.JsonTraceBufferStore(dir, reader);
  await real.append(id, 'work', [{ event: 'e' }]);

  let trace: typeof real = real;
  if (seal !== 'mcp-core') {
    // Control: the refusal is another RELEASE's own object.
    const other = await core(seal.otherCore);
    trace = Object.create(real) as typeof real;
    trace.sealFenced = async () => {
      throw new other.ReclaimVersionChanged(
        "reclaim's version fence refused: run 'reclaim-run' changed since the reclaim decision (expected version 1, observed 8)",
      );
    };
  }

  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const result = await cliCore.reclaimStep(store, id, 'work', { traceBufferStore: trace });
    const after = await store.get(id);
    return {
      outcome: result.outcome,
      warnings: warn.mock.calls.map((call) => String(call[0])),
      stillInProgress: after.in_progress_steps.includes('work'),
    };
  } catch (err) {
    return {
      thrown: err instanceof Error ? err.message : String(err),
      warnings: warn.mock.calls.map((call) => String(call[0])),
      stillInProgress: true,
    };
  } finally {
    warn.mockRestore();
  }
}

// ---------------------------------------------------------------------------------------------
// Row 4 — a handler's retryable WorkflowError, run by the CLI copy's engine.
// ---------------------------------------------------------------------------------------------

const retryDefinition: WorkflowDefinition = {
  id: 'retry-wf',
  name: 'Retry',
  version: 1,
  steps: {
    only: {
      description: 'A handler that always fails with a retryable error',
      execution: 'auto',
      depends_on: [],
      handler: 'flaky',
      retry: { max_attempts: 3, backoff: 'fixed', base_delay_ms: 0 },
    },
  },
};

/** Writes a handler module that throws `copy`'s retryable WorkflowError every time it is called. */
async function writeAlwaysFailing(dir: string): Promise<string> {
  const file = join(dir, 'always-fails.mjs');
  await writeFile(
    file,
    [
      "import { WorkflowError } from '@sensigo/realm';",
      'export const calls = [];',
      "export default { id: 'flaky', execute: async () => {",
      "  calls.push('call');",
      "  throw new WorkflowError('rate limited', { code: 'ENGINE_HANDLER_FAILED', category: 'ENGINE', agentAction: 'stop', retryable: true });",
      '} };',
      '',
    ].join('\n'),
    'utf8',
  );
  return file;
}

interface HandlerModule {
  calls: string[];
  default: import('@sensigo/realm').StepHandler;
}

async function runRetryingStep(handlerSource: 'own' | { dir: string }): Promise<{
  attempts: number;
  errorCode: string | undefined;
  agentAction: string | undefined;
  status: string;
}> {
  const dir = await tempDir('retry');
  const cliCore = await core(layout.cli.cliCore);
  const store = new cliCore.JsonFileStore(dir);
  const registry = new cliCore.ExtensionRegistry();
  let attempts: () => number;
  if (handlerSource === 'own') {
    // The handler imports the engine's OWN copy: nothing crosses.
    let calls = 0;
    attempts = () => calls;
    registry.register('handler', 'flaky', {
      id: 'flaky',
      execute: async () => {
        calls++;
        throw new cliCore.WorkflowError('rate limited', {
          code: 'ENGINE_HANDLER_FAILED',
          category: 'ENGINE',
          agentAction: 'stop',
          retryable: true,
        });
      },
    });
  } else {
    const file = await writeAlwaysFailing(handlerSource.dir);
    const mod = (await import(pathToFileURL(file).href)) as HandlerModule;
    attempts = () => mod.calls.length;
    registry.register('handler', 'flaky', mod.default);
  }
  const { run } = await store.create({ workflowId: 'retry-wf', workflowVersion: 1, params: {} });
  const envelope = await cliCore.executeStep(store, retryDefinition, {
    runId: run.id,
    command: 'only',
    input: {},
    dispatcher: async () => ({}),
    registry,
  });
  return {
    attempts: attempts(),
    errorCode: envelope.error_code,
    agentAction: envelope.agent_action,
    status: envelope.status,
  };
}

// ---------------------------------------------------------------------------------------------
// Row 5 — a provider that extends the project's `@sensigo/realm-cli/agent` class.
// ---------------------------------------------------------------------------------------------

async function writeProviders(dir: string): Promise<{ plain: string; toolCapable: string }> {
  const plain = join(dir, 'plain-provider.mjs');
  const toolCapable = join(dir, 'tool-provider.mjs');
  await writeFile(
    plain,
    [
      "import { LlmProvider } from '@sensigo/realm-cli/agent';",
      'class Plain extends LlmProvider { async callStep() { return { ok: true }; } }',
      'export default new Plain();',
      '',
    ].join('\n'),
    'utf8',
  );
  await writeFile(
    toolCapable,
    [
      "import { ToolCapableLlmProvider } from '@sensigo/realm-cli/agent';",
      'class Tools extends ToolCapableLlmProvider {',
      '  async callStep() { return { ok: true }; }',
      '  async callStepWithTools() { return { output: { ok: true }, toolCalls: [] }; }',
      '}',
      'export default new Tools();',
      '',
    ].join('\n'),
    'utf8',
  );
  return { plain, toolCapable };
}

const AGENT_WORKFLOW = [
  'id: one-agent-step',
  'name: One agent step',
  'version: 1',
  'steps:',
  '  only:',
  '    description: Answer with whatever the provider returns',
  '    execution: agent',
  '    depends_on: []',
  '',
].join('\n');

/** Spawns the CLI copy's `realm agent --provider-module <file>` on the one-step workflow. */
async function runAgentWithProvider(
  cliCopy: Copy,
  providerFile: string,
): Promise<{ status: number | null; text: string }> {
  const dir = await tempDir('agent');
  const home = await tempDir('home');
  await writeFile(join(dir, 'package.json'), '{"name":"agent-project","private":true}\n', 'utf8');
  const workflowFile = join(dir, 'workflow.yaml');
  await writeFile(workflowFile, AGENT_WORKFLOW, 'utf8');
  const result = runNode(
    [
      layout.file(cliCopy, 'dist/index.js'),
      'agent',
      '--workflow',
      workflowFile,
      '--provider-module',
      providerFile,
    ],
    { cwd: dir, home },
  );
  return { status: result.status, text: describeSpawn(result) };
}

// ---------------------------------------------------------------------------------------------
// Row 6 — two copies writing one file at once (a fresh child process).
// ---------------------------------------------------------------------------------------------

async function raceTwoWriters(
  a: Copy,
  b: Copy,
  rounds: number,
): Promise<{ torn: number; rejected: number }> {
  const dir = await tempDir('race');
  const script = join(dir, 'race.mjs');
  await writeFile(
    script,
    [
      "import { readFile } from 'node:fs/promises';",
      "import { join } from 'node:path';",
      "import { pathToFileURL } from 'node:url';",
      `const A = await import(pathToFileURL(${JSON.stringify(layout.file(a, 'dist/index.js'))}).href);`,
      `const B = await import(pathToFileURL(${JSON.stringify(layout.file(b, 'dist/index.js'))}).href);`,
      `const dir = ${JSON.stringify(dir)};`,
      'let torn = 0;',
      'let rejected = 0;',
      `for (let round = 0; round < ${rounds}; round++) {`,
      '  const path = join(dir, `file-${round}.json`);',
      "  const a = JSON.stringify({ writer: 'a', round, pad: 'x'.repeat(4096) });",
      "  const b = JSON.stringify({ writer: 'b', round, pad: 'y'.repeat(4096) });",
      '  const results = await Promise.allSettled([A.atomicWriteFile(path, a), B.atomicWriteFile(path, b)]);',
      "  rejected += results.filter((r) => r.status === 'rejected').length;",
      "  const text = await readFile(path, 'utf8').catch(() => null);",
      '  if (text !== a && text !== b) torn++;',
      '}',
      'console.log(JSON.stringify({ torn, rejected }));',
      '',
    ].join('\n'),
    'utf8',
  );
  const home = await tempDir('home');
  const result = runNode([script], { cwd: dir, home, timeoutMs: 45_000 });
  if (result.status !== 0) throw new Error(`the race child failed:\n${describeSpawn(result)}`);
  return JSON.parse(result.stdout.trim().split('\n').pop()!) as { torn: number; rejected: number };
}

// ---------------------------------------------------------------------------------------------
// Row 7 — realm-testing's store checks, run on realm-testing's own nested core.
// ---------------------------------------------------------------------------------------------

const claimWorkflow: WorkflowDefinition = {
  id: 'run-store-fidelity-tck-wf',
  name: 'RunStore Fidelity TCK WF',
  version: 1,
  steps: {
    work: { description: 'Agent step, immediately eligible', execution: 'agent', depends_on: [] },
  },
};

async function runSingleOwnerLaw(testingCopy: Copy, storeCore: Copy): Promise<void> {
  const dir = await tempDir('contract');
  const testing = await layout.load<Testing>(testingCopy);
  const storeCoreModule = await core(storeCore);
  const store = new storeCoreModule.JsonFileStore(dir);
  const cases = testing
    .runStoreFidelityContract({ store, definition: claimWorkflow, stepName: 'work' })
    .filter((c) => c.law === 'CLAIM_SINGLE_OWNER');
  expect(cases).toHaveLength(1);
  await cases[0]!.run();
}

// ---------------------------------------------------------------------------------------------
// Row 8 — `realm workflow test` (the CLI copy, spawned) on a project whose handler throws a
// retryable WorkflowError of the project's own copy.
// ---------------------------------------------------------------------------------------------

async function writeFlakyProject(
  projectRoot: string,
): Promise<{ workflowDir: string; fixtures: string; calls: string }> {
  const workflowDir = join(projectRoot, 'flaky-flow');
  const fixtures = join(workflowDir, 'fixtures');
  await mkdir(fixtures, { recursive: true });
  await writeFile(
    join(workflowDir, 'workflow.yaml'),
    [
      'id: flaky-flow',
      'name: Flaky flow',
      'version: 1',
      'extensions: ./handlers.mjs',
      'steps:',
      '  only:',
      '    description: Calls a handler that fails twice, then succeeds',
      '    execution: auto',
      '    handler: flaky',
      '    depends_on: []',
      '    retry:',
      '      max_attempts: 3',
      '      backoff: fixed',
      '      base_delay_ms: 0',
      '',
    ].join('\n'),
    'utf8',
  );
  await writeFile(
    join(workflowDir, 'handlers.mjs'),
    [
      "import { appendFileSync } from 'node:fs';",
      "import { fileURLToPath } from 'node:url';",
      "import { WorkflowError } from '@sensigo/realm';",
      "const log = fileURLToPath(new URL('./calls.log', import.meta.url));",
      'const handler = {',
      "  id: 'flaky',",
      '  execute: async () => {',
      "    appendFileSync(log, 'call\\n');",
      "    const calls = (await import('node:fs')).readFileSync(log, 'utf8').split('\\n').filter(Boolean).length;",
      "    if (calls <= 2) throw new WorkflowError('rate limited', { code: 'ENGINE_HANDLER_FAILED', category: 'ENGINE', agentAction: 'stop', retryable: true });",
      '    return { data: { done: true } };',
      '  },',
      '};',
      'export default { handlers: { flaky: handler } };',
      '',
    ].join('\n'),
    'utf8',
  );
  await writeFile(
    join(fixtures, 'retries.yaml'),
    ['name: flaky handler retries', 'params: {}', 'expected:', '  final_state: completed', ''].join(
      '\n',
    ),
    'utf8',
  );
  return { workflowDir, fixtures, calls: join(workflowDir, 'calls.log') };
}

async function callCount(file: string): Promise<number> {
  if (!existsSync(file)) return 0;
  return (await readFile(file, 'utf8')).split('\n').filter((line) => line.length > 0).length;
}

async function runWorkflowTest(
  projectRoot: string,
): Promise<{ output: string; status: number | null; calls: number }> {
  const { workflowDir, fixtures, calls } = await writeFlakyProject(projectRoot);
  const home = await tempDir('home');
  const result = runNode(
    [
      layout.file(layout.cli.cli, 'dist/index.js'),
      'workflow',
      'test',
      workflowDir,
      '--fixtures',
      fixtures,
    ],
    { cwd: projectRoot, home },
  );
  return { output: describeSpawn(result), status: result.status, calls: await callCount(calls) };
}

// ---------------------------------------------------------------------------------------------
// Row 9 — a store built with another copy's core, driven by the CLI copy's engine: its
// `settleStep` throws STATE_RUN_BUSY once on the finalizer's `mark_finalizer` write.
// ---------------------------------------------------------------------------------------------

const drainDefinition: WorkflowDefinition = {
  id: 'drain-wf',
  name: 'Drain',
  version: 1,
  steps: {
    work: { description: 'Domain step', execution: 'auto', depends_on: [], handler: 'work_h' },
    cleanup: {
      description: 'Finalizer',
      execution: 'finalizer',
      on_outcome: 'always',
      handler: 'cleanup_h',
    },
  },
};

async function drainWithBusyStore(
  storeCore: Copy,
): Promise<{ status: string | undefined; entry: unknown; thrown?: string }> {
  const dir = await tempDir('drain');
  const engine = await core(layout.cli.cliCore);
  const storeCoreModule = await core(storeCore);
  const real = new storeCoreModule.JsonFileStore(dir);
  let refusals = 0;
  const store = Object.create(real) as typeof real;
  store.settleStep = async (runId, delta, definition) => {
    if (delta.kind === 'mark_finalizer' && refusals === 0) {
      refusals++;
      throw new storeCoreModule.WorkflowError('the run file is busy', {
        code: 'STATE_RUN_BUSY',
        category: 'STATE',
        agentAction: 'report_to_user',
        retryable: true,
      });
    }
    return real.settleStep!(runId, delta, definition);
  };
  const registry = new engine.ExtensionRegistry();
  registry.register('handler', 'work_h', {
    id: 'work_h',
    execute: async () => ({ data: { ok: true } }),
  });
  registry.register('handler', 'cleanup_h', {
    id: 'cleanup_h',
    execute: async () => ({ data: { cleaned: true } }),
  });
  const { run } = await real.create({ workflowId: 'drain-wf', workflowVersion: 1, params: {} });
  let thrown: string | undefined;
  try {
    await engine.executeChain(store, drainDefinition, {
      runId: run.id,
      command: 'work',
      input: {},
      dispatcher: async () => ({}),
      registry,
    });
  } catch (err) {
    thrown = err instanceof Error ? err.message : String(err);
  }
  const record = JSON.parse(await readFile(join(dir, `${run.id}.json`), 'utf8')) as RunRecord;
  const entry = record.finalizer_ledger?.['cleanup'];
  return { status: entry?.status, entry, ...(thrown !== undefined ? { thrown } : {}) };
}

/** A folder inside `base` for code a test writes there (so the code finds `base`'s copies). */
async function codeDir(base: string, prefix: string): Promise<string> {
  const dir = await mkdtemp(join(base, `${prefix}-`));
  scratch.push(dir);
  return dir;
}

// =============================================================================================
// The rows
// =============================================================================================

describe('1 — gc reads a `Run not found` that another copy of the same release made', () => {
  it(
    'an orphaned trace file is reaped',
    async () => {
      const result = await reapOrphanWith(layout.cli.cliCore);
      expect(result.failed).toEqual([]);
      expect(result.reaped).toBe(1);
    },
    TEST_TIMEOUT,
  );
});

describe('2 — purge classifies a refusal that another copy of the same release made', () => {
  it(
    'a run resumed mid-purge is blocked, never failed',
    async () => {
      const result = await purgeResumedRun(realTraceFor);
      expect(result.failed).toEqual([]);
      expect(result.blocked).toHaveLength(1);
      expect(result.purged).toEqual([]);
    },
    TEST_TIMEOUT,
  );
});

describe('3 — reclaim reads a `ReclaimVersionChanged` that another copy of the same release made', () => {
  it(
    'reclaim skips the buffer and says so',
    async () => {
      const result = await reclaimWith('mcp-core');
      expect(result.thrown).toBeUndefined();
      expect(result.outcome).toBe('reclaimed');
      expect(result.warnings.some((w) => w.includes('version fence refused'))).toBe(true);
    },
    TEST_TIMEOUT,
  );
});

describe('4 — the engine retries a handler that throws a retryable error of another copy of the same release', () => {
  it(
    'the same result as a handler that imports the engine’s own copy: 3 attempts, STEP_RETRY_EXHAUSTED, stop',
    async () => {
      const own = await runRetryingStep('own');
      expect(own).toEqual({
        attempts: 3,
        errorCode: 'STEP_RETRY_EXHAUSTED',
        agentAction: 'stop',
        status: 'error',
      });
      const crossing = await runRetryingStep({ dir: await codeDir(layout.projectDir, 'handler') });
      expect(crossing).toEqual(own);
    },
    TEST_TIMEOUT,
  );
});

describe('5 — `--provider-module` accepts a provider that extends another copy’s LlmProvider', () => {
  it(
    'a plain provider is accepted',
    async () => {
      const { plain } = await writeProviders(await codeDir(layout.projectDir, 'providers'));
      const run = await runAgentWithProvider(layout.cli.cli, plain);
      expect(run.text).not.toContain('must be an instance extending LlmProvider');
      expect(run.status, run.text).toBe(0);
    },
    TEST_TIMEOUT,
  );

  it(
    'a tool-capable provider is tool-capable',
    async () => {
      const { toolCapable } = await writeProviders(await codeDir(layout.projectDir, 'providers'));
      const llm = await layout.load<LlmProviderModule>(
        layout.cli.cli,
        'dist/agent/providers/llm-provider.js',
      );
      const mod = (await import(pathToFileURL(toolCapable).href)) as { default: object };
      expect(llm.isToolCapable(mod.default as never)).toBe(true);
    },
    TEST_TIMEOUT,
  );
});

describe('6 — two copies write one file at the same time', () => {
  it(
    'no write is rejected and no file is left torn (200 rounds, a fresh child process)',
    async () => {
      const result = await raceTwoWriters(layout.project.core, layout.cli.cliCore, 200);
      expect(result).toEqual({ torn: 0, rejected: 0 });
    },
    TEST_TIMEOUT,
  );
});

describe('7 — realm-testing’s store checks on a store built with another copy’s core', () => {
  it(
    'CLAIM_SINGLE_OWNER passes',
    async () => {
      await runSingleOwnerLaw(layout.cli.testing, layout.project.core);
    },
    TEST_TIMEOUT,
  );
});

describe('8 — `realm workflow test` on a project whose handler throws a retryable error of the project’s copy', () => {
  it(
    'the handler is retried: PASS, exit 0, three calls',
    async () => {
      const root = await codeDir(layout.projectDir, 'flaky');
      const run = await runWorkflowTest(root);
      expect(run.output).toContain('PASS flaky handler retries');
      expect(run.status, run.output).toBe(0);
      expect(run.calls).toBe(3);
    },
    TEST_TIMEOUT,
  );
});

describe('9 — the drain retries a `STATE_RUN_BUSY` that a store of another copy of the same release made', () => {
  it(
    'the finalizer ledger entry ends completed',
    async () => {
      const result = await drainWithBusyStore(layout.project.core);
      expect(result.thrown).toBeUndefined();
      expect(result.status).toBe('completed');
    },
    TEST_TIMEOUT,
  );
});

// --- Row 10: the control. The same crossing with a copy of ANOTHER release — not recognised. ---

describe('10 — control: a copy of another release is not recognised (the outcome is today’s)', () => {
  it(
    '1: the orphaned trace file is not reaped; the failure carries the message',
    async () => {
      const result = await reapOrphanWith(layout.other.core);
      expect(result.reaped).toBe(0);
      expect(result.failed.join('\n')).toContain('Run not found');
    },
    TEST_TIMEOUT,
  );

  it(
    '2: a stand-in store refusing with another release’s STATE_RUN_BUSY lands in failed, not blocked',
    async () => {
      const other = await core(layout.other.core);
      const result = await purgeResumedRun(async () => ({
        statAllForRun: async () => ({ bytes: 0 }),
        deleteAllForRun: async () => ({ bytes_deleted: 0 }),
        deleteAllForRunFenced: async () => {
          throw new other.WorkflowError(
            "run 'resumed-mid-purge' is no longer terminal — refusing to purge its trace buffer",
            {
              code: 'STATE_RUN_BUSY',
              category: 'STATE',
              agentAction: 'report_to_user',
              retryable: true,
              details: { reason: 'resumed since selection' },
            },
          );
        },
      }));
      expect(result.blocked).toEqual([]);
      expect(result.failed).toHaveLength(1);
      expect(result.purged).toEqual([]);
    },
    TEST_TIMEOUT,
  );

  it(
    '3: a ReclaimVersionChanged of another release is not skipped; reclaim throws',
    async () => {
      const result = await reclaimWith({ otherCore: layout.other.core });
      expect(result.thrown).toContain("reclaim's version fence refused");
      expect(result.stillInProgress).toBe(true);
    },
    TEST_TIMEOUT,
  );

  it(
    '4: a handler importing another release’s copy runs once and fails as ENGINE_HANDLER_FAILED',
    async () => {
      const result = await runRetryingStep({ dir: await codeDir(layout.otherDir, 'handler') });
      expect(result.attempts).toBe(1);
      expect(result.errorCode).toBe('ENGINE_HANDLER_FAILED');
    },
    TEST_TIMEOUT,
  );

  it(
    '5: a provider extending another release’s LlmProvider is refused, and is not tool-capable',
    async () => {
      const { plain, toolCapable } = await writeProviders(
        await codeDir(layout.otherDir, 'providers'),
      );
      const run = await runAgentWithProvider(layout.cli.cli, plain);
      expect(run.status).toBe(1);
      expect(run.text).toContain(
        'provider module default export must be an instance extending LlmProvider',
      );
      const llm = await layout.load<LlmProviderModule>(
        layout.cli.cli,
        'dist/agent/providers/llm-provider.js',
      );
      const mod = (await import(pathToFileURL(toolCapable).href)) as { default: object };
      expect(llm.isToolCapable(mod.default as never)).toBe(false);
    },
    TEST_TIMEOUT,
  );

  it(
    '7: a store built with another release’s core fails the single-owner law',
    async () => {
      await expect(runSingleOwnerLaw(layout.cli.testing, layout.other.core)).rejects.toThrow(
        /expected the losing claimStep call to reject with a WorkflowError carrying code STATE_STEP_ALREADY_CLAIMED, got: WorkflowError/,
      );
    },
    TEST_TIMEOUT,
  );

  it(
    '8: `realm workflow test` with a handler importing another release’s copy fails the fixture after one call',
    async () => {
      const run = await runWorkflowTest(await codeDir(layout.otherDir, 'flaky'));
      expect(run.status).toBe(1);
      expect(run.output).toContain(
        "FAIL flaky handler retries: Handler 'flaky' threw: rate limited",
      );
      expect(run.calls).toBe(1);
    },
    TEST_TIMEOUT,
  );

  it(
    '9: a store built with another release’s core stops the drain at the first refusal',
    async () => {
      const result = await drainWithBusyStore(layout.other.core);
      expect(result.status).toBe('pending');
    },
    TEST_TIMEOUT,
  );
});

// --- Row 11: non-vacuity. The copies are distinct, and none silently found the repository's. ---

describe('11 — the layout is what it claims to be', () => {
  it(
    'the five core copies are five different classes, each at the version the layout wrote',
    async () => {
      const copies: Array<[string, Copy, string]> = [
        ['project core', layout.project.core, layout.version],
        ['the command’s core', layout.cli.cliCore, layout.version],
        ['realm-mcp’s core', layout.cli.mcpCore, layout.version],
        ['realm-testing’s core', layout.cli.testingCore, layout.version],
        ['the other release’s core', layout.other.core, layout.otherVersion],
      ];
      const modules = await Promise.all(copies.map(([, copy]) => core(copy)));
      expect(new Set(modules.map((m) => m.WorkflowError)).size).toBe(5);
      expect(new Set(modules.map((m) => m.JsonFileStore)).size).toBe(5);
      modules.forEach((m, i) => expect(m.VERSION, copies[i]![0]).toBe(copies[i]![2]));
      expect((await layout.load<Mcp>(layout.cli.mcp)).VERSION).toBe(layout.version);
      expect((await layout.load<Testing>(layout.cli.testing)).VERSION).toBe(layout.version);
      expect((await layout.load<Testing>(layout.other.testing)).VERSION).toBe(layout.otherVersion);
    },
    TEST_TIMEOUT,
  );

  it(
    'every realm module a copy loads is inside the layout, none from the repository’s workspace',
    async () => {
      const entries = [
        layout.file(layout.project.core, 'dist/index.js'),
        layout.file(layout.project.cli, 'dist/agent/index.js'),
        layout.file(layout.cli.cli, 'dist/agent/index.js'),
        layout.file(layout.cli.cli, 'dist/commands/gc.js'),
        layout.file(layout.cli.cli, 'dist/commands/purge.js'),
        layout.file(layout.cli.cliCore, 'dist/index.js'),
        layout.file(layout.cli.mcp, 'dist/index.js'),
        layout.file(layout.cli.mcpCore, 'dist/index.js'),
        layout.file(layout.cli.testing, 'dist/index.js'),
        layout.file(layout.cli.testingCore, 'dist/index.js'),
        layout.file(layout.other.core, 'dist/index.js'),
        layout.file(layout.other.cli, 'dist/agent/index.js'),
        layout.file(layout.other.testing, 'dist/index.js'),
      ];
      const resolved = await recordResolvedFiles(layout, entries);
      const workspace = new RegExp(
        `^${pathToFileURL(REPO_ROOT).href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(packages/(core|cli|mcp-server|testing)/(dist|src)/|node_modules/@sensigo/)`,
      );
      expect(resolved.filter((url) => workspace.test(url))).toEqual([]);
      const inside = pathToFileURL(layout.root).href;
      for (const entry of entries) {
        expect(resolved, entry).toContain(pathToFileURL(entry).href);
        expect(pathToFileURL(entry).href.startsWith(inside)).toBe(true);
      }
    },
    TEST_TIMEOUT,
  );
});
