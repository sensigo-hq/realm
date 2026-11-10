// agent-earlier-runs-3m.test.ts — caching 3-M piece C2 through the command: `realm agent` reads the
// workflow's earlier runs on both of its paths (check 2, the built CLI against the Anthropic stand-in,
// a scratch HOME and only a dummy key), and makes no read when nothing can use it (check 7, the command
// in this process, observed by a spy on the home's `scan`: a spawned child cannot be spied). Every
// provider address is local. On a failing host a cell prints the exit code, stderr, the requests' source
// and the scans counted: no environment, header or key.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  type RunRecord,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { startAnthropicStub } from '../agent/test-support/anthropic-stub.js';
import { LlmProvider } from '../agent/providers/llm-provider.js';
import { makeTempHome, runIds, type TempHome } from '../test-support/temp-home.js';
import { agentCommand } from './agent.js';

const CLI_ENTRY = fileURLToPath(new URL('../../dist/index.js', import.meta.url));

const ID = 'earlier-3m-command';
const AGENT_WF = [
  `id: ${ID}`,
  'name: Earlier runs 3-M',
  'version: 1',
  'steps:',
  '  ask:',
  '    description: Answer with a short summary.',
  '    execution: agent',
  '',
].join('\n');
const NO_AGENT_WF = [
  `id: ${ID}`,
  'name: Earlier runs 3-M',
  'version: 1',
  'steps:',
  '  publish:',
  '    description: Publish.',
  '    execution: auto',
  '    handler: publish_answer',
  '',
].join('\n');

let h: TempHome & { readonly root: string };
let stub: Awaited<ReturnType<typeof startAnthropicStub>>;
let workflowFile: string;

beforeEach(async () => {
  h = await makeTempHome();
  stub = await startAnthropicStub({ finalContent: { summary: 'ok' } });
  workflowFile = join(h.root, 'workflow.yaml');
  writeFileSync(workflowFile, AGENT_WF, 'utf8');
});

afterEach(async () => {
  await stub.close();
  await h.cleanup();
});

type Done = { code: number | null; stderr: string };

/** The built CLI's `realm agent`, to its end, on the scratch home. */
function agent(args: string[]): Promise<Done> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_ENTRY, 'agent', ...args], {
      cwd: h.root,
      env: {
        PATH: process.env['PATH'] ?? '',
        HOME: h.root,
        ANTHROPIC_API_KEY: 'k-c2',
        ANTHROPIC_BASE_URL: stub.baseUrl,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
  });
}

const firstRequest = (run: RunRecord) =>
  run.evidence.filter((e) => e.step_id === 'ask').at(-1)?.diagnostics?.cache?.requests?.[0];

const SECOND_DRIVE: [string, () => Promise<{ done: Done; runId: string }>][] = [
  [
    'a new run',
    async () => {
      const before = new Set(await runIds(h.home.runStore));
      const done = await agent(['--workflow', workflowFile, '--model', 'claude-x']);
      return { done, runId: (await runIds(h.home.runStore)).find((r) => !before.has(r))! };
    },
  ],
  [
    // `realm listen`'s route: every drive it starts re-attaches a run it seeded.
    '`--run-id` on a seeded, undriven run',
    async () => {
      const definition = {
        id: ID,
        name: 'Earlier runs 3-M',
        version: 1,
        schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
        steps: { ask: { description: 'Answer with a short summary.', execution: 'agent' } },
      } as unknown as WorkflowDefinition;
      await h.home.workflowStore.register(definition);
      const { record } = await h.home.runStore.create({
        workflowId: ID,
        workflowVersion: 1,
        params: {},
      });
      const done = await agent(['--run-id', record.id, '--model', 'claude-x']);
      return { done, runId: record.id };
    },
  ],
];

describe('caching 3-M C2 — check 2: through the command, both callers', () => {
  it.each(SECOND_DRIVE)(
    'the second run’s request carries the first run’s, from %s',
    async (_name, second) => {
      const first = await agent(['--workflow', workflowFile, '--model', 'claude-x']);
      const [firstId] = await runIds(h.home.runStore);
      const { done, runId } = await second();
      const before = firstRequest((await h.home.runStore.get(firstId!)).record);
      const after = firstRequest((await h.home.runStore.get(runId)).record);
      // (a) red when that caller does not pass the data to `runAgent`; (b) prints the exit codes,
      //     stderr and the copy's source and id.
      expect({
        codes: [first.code, done.code],
        stderr: done.code === 0 ? '' : done.stderr,
        from: after?.reference?.from,
        request_id: after?.reference?.request_id,
      }).toEqual({
        codes: [0, 0],
        stderr: '',
        from: 'earlier_run',
        request_id: before?.request_id,
      });
    },
    60_000,
  );
});

const PROVIDER_KEY = '__realm_c2_provider_module__';

/** A provider module: it answers without calling anything. */
class ModuleProvider extends LlmProvider {
  async callStep(): Promise<Record<string, unknown>> {
    return { summary: 'ok' };
  }
}

// `agentCommand` is one object and keeps the options of its last parse.
const OPTION_DEFAULTS: Record<string, unknown> = { ...agentCommand.opts() };

/** The command in this process, against the stand-in, on the scratch home. */
async function agentInProcess(args: string[]): Promise<void> {
  for (const key of Object.keys(agentCommand.opts())) {
    agentCommand.setOptionValue(key, OPTION_DEFAULTS[key]);
  }
  const saved = {
    HOME: process.env['HOME'],
    key: process.env['ANTHROPIC_API_KEY'],
    url: process.env['ANTHROPIC_BASE_URL'],
  };
  process.env['HOME'] = h.root;
  process.env['ANTHROPIC_API_KEY'] = 'k-c2';
  process.env['ANTHROPIC_BASE_URL'] = stub.baseUrl;
  vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await agentCommand.parseAsync(['node', 'realm', ...args]);
  } finally {
    const restore = (name: string, value: string | undefined): void => {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    };
    restore('HOME', saved.HOME);
    restore('ANTHROPIC_API_KEY', saved.key);
    restore('ANTHROPIC_BASE_URL', saved.url);
  }
}

const moduleFile = (): string => {
  const file = join(h.root, 'provider.mjs');
  writeFileSync(file, `export default globalThis['${PROVIDER_KEY}'];\n`, 'utf8');
  return pathToFileURL(file).pathname;
};

const NO_READ: [string, () => string[]][] = [
  ['a stated `--prompt-cache off`', () => ['--model', 'claude-x', '--prompt-cache', 'off']],
  ['a provider module', () => ['--provider-module', moduleFile()]],
  [
    'a workflow with no agent step',
    () => {
      writeFileSync(workflowFile, NO_AGENT_WF, 'utf8');
      return ['--model', 'claude-x'];
    },
  ],
];

describe('caching 3-M C2 — check 7: no read when nothing can use it', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as Record<string, unknown>)[PROVIDER_KEY];
  });

  // The control: without it, a spy that never saw anything would pass every row below.
  it('a plain drive makes one read', async () => {
    const scan = vi.spyOn(h.home.runStore, 'scan');
    await agentInProcess(['--workflow', workflowFile, '--model', 'claude-x']);
    // (a) red when no read is made on this path, or one is made per step; (b) prints the count.
    expect(scan.mock.calls.length).toBe(1);
  }, 60_000);

  it.each(NO_READ)(
    '%s → no `scan`',
    async (_name, flags) => {
      (globalThis as Record<string, unknown>)[PROVIDER_KEY] = new ModuleProvider();
      const scan = vi.spyOn(h.home.runStore, 'scan');
      await agentInProcess(['--workflow', workflowFile, ...flags()]);
      const [runId] = await runIds(h.home.runStore);
      // (a) red when that condition is removed from the read's guard; (b) prints the count and
      //     whether the drive reached a run at all, so a command that stopped early cannot pass.
      expect({ scans: scan.mock.calls.length, drove: runId !== undefined }).toEqual({
        scans: 0,
        drove: true,
      });
    },
    60_000,
  );
});

describe('caching 3-M C2 correction 1 — check 3: the own id on `--run-id`, through the command', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // A multi-step run re-attached for its next step: its own row is the newest naming the first step.
  // Six other runs name it too, so a row taken by the own run would leave one of them unread.
  it('the read opens the six other runs, and never the drive’s own', async () => {
    const definition = {
      id: ID,
      name: 'Earlier runs 3-M',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: {
        ask: { description: 'Answer with a short summary.', execution: 'agent' },
        next: { description: 'Then this.', execution: 'agent', depends_on: ['ask'] },
      },
    } as unknown as WorkflowDefinition;
    const store = h.home.runStore;
    await h.home.workflowStore.register(definition);
    const seed = async (completed: string[]): Promise<string> => {
      const { record } = await store.create({ workflowId: ID, workflowVersion: 1, params: {} });
      await store.update({ ...record, completed_steps: completed } as RunRecord);
      return record.id;
    };
    const others: string[] = [];
    for (let i = 0; i < 6; i += 1) others.push(await seed(['ask', 'next']));
    const own = await seed(['ask']);

    const calls: string[] = [];
    const realScan = store.scan.bind(store) as (...args: never[]) => unknown;
    const realGet = store.get.bind(store);
    vi.spyOn(store, 'scan').mockImplementation(((...args: never[]) => {
      calls.push('scan');
      return realScan(...args);
    }) as never);
    vi.spyOn(store, 'get').mockImplementation((id: string) => {
      calls.push(id);
      return realGet(id);
    });
    await agentInProcess(['--run-id', own, '--model', 'claude-x']);

    // The driver reads its own run after the read, so the read's own `get`s are those right after the
    // scan. (a) red when the caller passes `undefined` for `opts.runId` (the own row, the newest,
    // comes first and one other run is left unread); (b) prints the ids read right after the scan.
    const afterScan = calls.slice(calls.indexOf('scan') + 1, calls.indexOf('scan') + 7);
    expect([...afterScan].sort()).toEqual([...others].sort());
  }, 60_000);
});
