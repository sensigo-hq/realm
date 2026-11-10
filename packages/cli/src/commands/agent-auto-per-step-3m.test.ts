// agent-auto-per-step-3m.test.ts — caching 3-M piece D-2 through `realm agent`: under `auto`, each
// agent step asks for the lifetime its own gaps in the workflow's earlier runs pay for, and the price
// file is read at most once per drive, only when something needs a price. The BUILT CLI drives the
// Anthropic stand-in (and, for OpenAI outside the explicit set, the OpenAI stand-in) in a scratch HOME,
// with a fixture `realm.yaml` and price file; the child runs with `NODE_OPTIONS=--import <hook>`, where
// the hook appends every path passed to an fs read to a log, so a cell counts the reads of the price
// file (#898's instrument). The failed read is driven by the command in this process, with the home's
// `scan` failing (a spawned child cannot be made to fail it). Earlier runs are written to the real
// store with their requests set back from the host's clock: constructed gaps (no real measured gaps
// exist on record, C3M7-21). Every value is a fake. Each assertion names (a) the change that turns it
// red and (b) what it prints when it fails: exit code, read count, warning lines, the markers sent and
// the record's ask, never an environment, a header or a key.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  type RunRecord,
  type UsageRecord,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { startAnthropicStub, type AnthropicStub } from '../agent/test-support/anthropic-stub.js';
import { startOpenAiStub, type OpenAiStub } from '../agent/test-support/openai-stub.js';
import { makeTempHome, runIds, type TempHome } from '../test-support/temp-home.js';
import { agentCommand } from './agent.js';

const CLI = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
/** The read log hook: every path handed to an fs read, one per line, to `$REALM_D2_READ_LOG`. */
const HOOK = `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const logFile = process.env.REALM_D2_READ_LOG;
const log = (p) => { if (logFile !== undefined && (typeof p === 'string' || p instanceof URL)) fs.appendFileSync(logFile, String(p) + '\\n'); };
const wrap = (owner, name) => { const real = owner[name]; owner[name] = function (p, ...rest) { log(p); return real.call(this, p, ...rest); }; };
wrap(fs, 'readFileSync'); wrap(fs, 'readFile'); wrap(fs.promises, 'readFile'); wrap(fs, 'openSync'); wrap(fs.promises, 'open');
syncBuiltinESMExports();
`;

const PRICES_FULL = JSON.stringify({
  version: 1,
  currency: 'USD',
  models: {
    'claude-x': {
      prices: [
        {
          per_million_tokens: {
            input: 3,
            output: 15,
            cache_read: 0.3,
            cache_write_5m: 3.75,
            cache_write_1h: 6,
          },
        },
      ],
    },
  },
});
const UNREADABLE = 'version: 1\n\tcurrency: USD\n';
const NAMES_PRICES = 'version: 1\nrunner:\n  cache:\n    economics: prices.json\n';
const ONE = { ask: { description: 'Answer.', execution: 'agent' } };
const TWO = {
  ask: { description: 'Answer.', execution: 'agent' },
  check: { description: 'Check.', execution: 'agent', depends_on: ['ask'] },
};

let root: string;
let anthropic: AnthropicStub;
let openai: OpenAiStub;
const homes: TempHome[] = [];
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'realm-3m-d2-e2e-'));
  writeFileSync(join(root, 'read-hook.mjs'), HOOK);
  anthropic = await startAnthropicStub({ finalContent: { summary: 'ok' } });
  openai = await startOpenAiStub({ finalContent: { summary: 'ok' } });
});
afterAll(async () => {
  await anthropic.close();
  await openai.close();
  for (const h of homes.splice(0)) await h.cleanup();
  rmSync(root, { recursive: true, force: true });
});

interface Deployment {
  h: TempHome & { readonly root: string };
  proj: string;
  def: WorkflowDefinition;
  pricesPath: string;
}

/** One scratch deployment: a trust root with `realm.yaml` and its price file, the workflow
 *  registered in a fresh HOME. */
async function deployment(
  name: string,
  opts: { prices: string; realmYaml?: string; steps?: Record<string, unknown> },
): Promise<Deployment> {
  const h = await makeTempHome();
  homes.push(h);
  const proj = join(root, name, 'proj');
  const wfDir = join(proj, 'workflows', 'wf');
  mkdirSync(wfDir, { recursive: true });
  writeFileSync(join(proj, 'package.json'), '{"name":"pd2","private":true}\n');
  const pricesPath = join(proj, 'prices.json');
  writeFileSync(pricesPath, opts.prices);
  writeFileSync(join(proj, 'realm.yaml'), opts.realmYaml ?? NAMES_PRICES);
  const def = {
    id: `wf-d2-${name}`,
    name: `wf d2 ${name}`,
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps: opts.steps ?? ONE,
    source_dir: wfDir,
    trust_root: proj,
  } as unknown as WorkflowDefinition;
  await h.home.workflowStore.register(def);
  return { h, proj, def, pricesPath };
}

/** A run of the deployment's workflow that no drive has touched yet: `realm listen`'s route. */
async function newRun(d: Deployment): Promise<string> {
  const { record } = await d.h.home.runStore.create({
    workflowId: d.def.id,
    workflowVersion: 1,
    params: {},
  });
  return record.id;
}

/** An earlier run whose named steps' requests started `agoS` seconds ago. */
async function seedEarlier(d: Deployment, steps: string[], agoS: number): Promise<void> {
  const store = d.h.home.runStore;
  const { record } = await store.create({ workflowId: d.def.id, workflowVersion: 1, params: {} });
  const start = new Date(Date.now() - agoS * 1000).toISOString();
  await store.update({
    ...record,
    completed_steps: steps,
    evidence: steps.map((stepId) => ({
      step_id: stepId,
      started_at: record.created_at,
      completed_at: record.created_at,
      duration_ms: 1,
      input_summary: {},
      output_summary: {},
      status: 'success',
      evidence_hash: 'a'.repeat(40),
      diagnostics: {
        input_token_estimate: 1,
        precondition_trace: [],
        cache: {
          state: 'engaged',
          basis: 'provider_reported',
          requests: [{ request_index: 0, request_in_call: 0, request_start: start }],
        },
      },
    })),
  } as unknown as RunRecord);
}

const firstRequest = (run: RunRecord, stepId: string): UsageRecord | undefined =>
  run.evidence.filter((e) => e.step_id === stepId).at(-1)?.diagnostics?.cache?.requests?.[0];

/** Drives the built `realm agent` once; reads back what it read, printed, sent and recorded. */
async function drive(name: string, d: Deployment, args: string[], runId?: string) {
  const readLog = join(root, `${name}.reads`);
  const before = new Set(await runIds(d.h.home.runStore));
  const sentBefore = anthropic.requests.length;
  const onOpenAi = args.includes('openai');
  const { code, stderr } = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [CLI, 'agent', ...args], {
      cwd: d.proj,
      env: {
        PATH: process.env['PATH'] ?? '',
        HOME: d.h.root,
        ...(onOpenAi
          ? { OPENAI_API_KEY: 'k-d2-openai', OPENAI_BASE_URL: openai.baseUrl }
          : { ANTHROPIC_API_KEY: 'k-d2-anthropic', ANTHROPIC_BASE_URL: anthropic.baseUrl }),
        NODE_OPTIONS: `--import=${pathToFileURL(join(root, 'read-hook.mjs')).href}`,
        REALM_D2_READ_LOG: readLog,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let err = '';
    child.stderr.on('data', (c: Buffer) => (err += c.toString()));
    const timer = setTimeout(() => child.kill('SIGKILL'), 40_000);
    child.on('close', (c) => {
      clearTimeout(timer);
      resolve({ code: c, stderr: err });
    });
  });
  const id = runId ?? (await runIds(d.h.home.runStore)).find((r) => !before.has(r));
  const run = id === undefined ? undefined : (await d.h.home.runStore.get(id)).record;
  const reads = existsSync(readLog) ? readFileSync(readLog, 'utf8').split('\n') : [];
  return {
    code,
    stderr: code === 0 ? '' : stderr.slice(0, 400),
    warnings: stderr.split('\n').filter((l) => l.includes('the price file could not be used'))
      .length,
    bodies: anthropic.requests.slice(sentBefore).map((body) => {
      const system = body['system'];
      return Array.isArray(system)
        ? (system as Array<Record<string, unknown>>).map((b) => b['cache_control'] ?? null)
        : 'plain';
    }),
    requests:
      run === undefined
        ? {}
        : Object.fromEntries(
            Object.keys(d.def.steps).map((s) => {
              const r = firstRequest(run, s);
              return [
                s,
                {
                  lifetime: r?.cache_lifetime_s,
                  source: r?.cache_requested_source,
                  auto: r?.cache_auto,
                },
              ];
            }),
          ),
    reads: reads.filter((p) => p === d.pricesPath || p === pathToFileURL(d.pricesPath).href).length,
  };
}

const LISTEN_GAPS = ['--spawned-by-listen', '--cache-gaps', '420,720'];

describe('caching 3-M D-2 — check 3: the price file is read once', () => {
  // (a) The real case: a listen child with measured trigger gaps and a workflow with no earlier run.
  //     Red when the read needs a step's gap (nothing settles the pending choice: the child exits on
  //     it). (b) The same child, a workflow of two steps each with an earlier run: red when the settle
  //     and the steps read separately, or each step reads (2 or more reads). (c) `realm agent` alone,
  //     a step with an earlier run: red when the read waits on a settle (no read, no cause on the
  //     record). Each prints the exit code, stderr's start, the read count and the warning lines.
  it('(a) --cache-gaps 420,720, no earlier run → completes, one read, one warning', async () => {
    const d = await deployment('3a', { prices: UNREADABLE });
    const runId = await newRun(d);
    const r = await drive(
      '3a',
      d,
      ['--run-id', runId, '--model', 'claude-x', ...LISTEN_GAPS],
      runId,
    );
    expect({ code: r.code, stderr: r.stderr, reads: r.reads, warnings: r.warnings }).toEqual({
      code: 0,
      stderr: '',
      reads: 1,
      warnings: 1,
    });
  }, 60_000);

  it('(b) --cache-gaps 420,720, two steps each with an earlier run → one read, one warning', async () => {
    const d = await deployment('3b', { prices: UNREADABLE, steps: TWO });
    await seedEarlier(d, ['ask', 'check'], 600);
    const runId = await newRun(d);
    const r = await drive(
      '3b',
      d,
      ['--run-id', runId, '--model', 'claude-x', ...LISTEN_GAPS],
      runId,
    );
    expect({ code: r.code, stderr: r.stderr, reads: r.reads, warnings: r.warnings }).toEqual({
      code: 0,
      stderr: '',
      reads: 1,
      warnings: 1,
    });
  }, 60_000);

  it('(c) realm agent alone, a step with an earlier run → one read, and the step records why it had no prices', async () => {
    const d = await deployment('3c', { prices: UNREADABLE });
    await seedEarlier(d, ['ask'], 600);
    const runId = await newRun(d);
    const r = await drive('3c', d, ['--run-id', runId, '--model', 'claude-x'], runId);
    const auto = (r.requests as Record<string, { auto?: { basis?: string; prices?: unknown } }>)[
      'ask'
    ]?.auto;
    expect({
      code: r.code,
      reads: r.reads,
      warnings: r.warnings,
      basis: auto?.basis,
      prices: auto?.prices,
    }).toEqual({
      code: 0,
      reads: 1,
      warnings: 1,
      basis: 'step_gaps',
      prices: { from: 'none', cause: 'economics_unreadable' },
    });
  }, 60_000);
});

describe('caching 3-M D-2 — check 4: no history', () => {
  // The real case: a workflow's first run, started by an operator, or by `realm listen` at its first
  // trigger. (a) red when one prior serves both runners (one row's lifetime), or the price file is
  // read with no gap (a read); (b) prints the code, the markers sent, the record's ask and the reads.
  it.each<[string, string[], unknown, number]>([
    ['a drive realm agent started → 5 minutes', [], [{ type: 'ephemeral' }], 300],
    [
      'a drive realm listen started → 1 hour',
      ['--spawned-by-listen'],
      [{ type: 'ephemeral', ttl: '1h' }],
      3600,
    ],
  ])(
    '%s, step_gaps with no gap, no price read',
    async (_case, flags, marks, lifetime) => {
      const d = await deployment(`4-${String(lifetime)}`, { prices: PRICES_FULL });
      const runId = await newRun(d);
      const r = await drive(
        `4-${String(lifetime)}`,
        d,
        ['--run-id', runId, '--model', 'claude-x', ...flags],
        runId,
      );
      expect({ code: r.code, bodies: r.bodies, requests: r.requests, reads: r.reads }).toEqual({
        code: 0,
        bodies: [marks],
        requests: {
          ask: { lifetime, source: 'runner_default', auto: { basis: 'step_gaps', gaps_s: [] } },
        },
        reads: 0,
      });
    },
    60_000,
  );
});

describe('caching 3-M D-2 — check 6 (outside the set): OpenAI at another address', () => {
  // The real case: OpenAI through a gateway (`OPENAI_BASE_URL`), a model outside the explicit set,
  // a step with an earlier run and a broken price file named. (a) red when the choice is made outside
  // the set (the step's gap then reads the file, which warns); (b) prints the code, reads, warnings.
  it('gpt-x, an earlier run, an unreadable price file → no read, no warning', async () => {
    const d = await deployment('6-outside', { prices: UNREADABLE });
    await seedEarlier(d, ['ask'], 600);
    const runId = await newRun(d);
    const r = await drive(
      '6-outside',
      d,
      ['--run-id', runId, '--provider', 'openai', '--model', 'gpt-x'],
      runId,
    );
    expect({ code: r.code, stderr: r.stderr, reads: r.reads, warnings: r.warnings }).toEqual({
      code: 0,
      stderr: '',
      reads: 0,
      warnings: 0,
    });
  }, 60_000);
});

describe('caching 3-M D-2 — check 8: stated settings', () => {
  // The real case: an operator states `--prompt-cache`, the step has an earlier run, and the price
  // file named is broken. (a) red when a choice is made for a stated setting (the record then holds
  // `cache_auto`), or the read is not gated on `auto` (a read and a warning); (b) prints the code,
  // the markers sent, the record's ask, the reads and the warnings.
  it.each<[string, unknown, number | undefined]>([
    ['off', 'plain', undefined],
    ['short', [{ type: 'ephemeral' }], 300],
    ['long', [{ type: 'ephemeral', ttl: '1h' }], 3600],
  ])(
    '--prompt-cache %s → what it sends today, no choice, no read',
    async (setting, marks, lifetime) => {
      const d = await deployment(`8-${setting}`, { prices: UNREADABLE });
      await seedEarlier(d, ['ask'], 600);
      const runId = await newRun(d);
      const r = await drive(
        `8-${setting}`,
        d,
        ['--run-id', runId, '--model', 'claude-x', '--prompt-cache', setting],
        runId,
      );
      expect({
        code: r.code,
        bodies: r.bodies,
        requests: r.requests,
        reads: r.reads,
        warnings: r.warnings,
      }).toEqual({
        code: 0,
        bodies: [marks],
        requests: { ask: { lifetime, source: 'stated', auto: undefined } },
        reads: 0,
        warnings: 0,
      });
    },
    60_000,
  );
});

describe('caching 3-M D-2 — check 12: through the command, both callers', () => {
  const workflowFile = (d: Deployment): string => {
    const file = join(d.proj, 'workflows', 'wf', 'workflow.yaml');
    writeFileSync(
      file,
      [
        `id: ${d.def.id}`,
        `name: ${d.def.name}`,
        'version: 1',
        'steps:',
        '  ask:',
        '    description: Answer.',
        '    execution: agent',
        '',
      ].join('\n'),
    );
    return file;
  };
  // The real case: a step with an earlier run, a price file named, driven as an operator starts a
  // run and as `realm listen` re-attaches one it seeded. (a) red when that caller does not pass the
  // choices to `runAgent` (the record then holds the drive's own basis); (b) prints the code and the
  // record's `cache_auto`.
  it.each<[string, (d: Deployment) => Promise<{ args: string[]; runId?: string }>]>([
    ['a new run', async (d) => ({ args: ['--workflow', workflowFile(d), '--model', 'claude-x'] })],
    [
      '`--run-id` on a seeded run',
      async (d) => {
        const runId = await newRun(d);
        return { args: ['--run-id', runId, '--model', 'claude-x'], runId };
      },
    ],
  ])(
    '%s: the step records step_gaps, priced from the price file',
    async (name, how) => {
      const d = await deployment(`12-${name.length}`, { prices: PRICES_FULL });
      await seedEarlier(d, ['ask'], 600);
      const { args, runId } = await how(d);
      const r = await drive(`12-${name.length}`, d, args, runId);
      const auto = (
        r.requests as Record<string, { auto?: { basis?: string; prices?: { from?: string } } }>
      )['ask']?.auto;
      expect({
        code: r.code,
        stderr: r.stderr,
        basis: auto?.basis,
        from: auto?.prices?.from,
      }).toEqual({
        code: 0,
        stderr: '',
        basis: 'step_gaps',
        from: 'economics',
      });
    },
    60_000,
  );
});

// `agentCommand` is one object and keeps the options of its last parse.
const OPTION_DEFAULTS: Record<string, unknown> = { ...agentCommand.opts() };

describe('caching 3-M D-2 — check 7: the read of the earlier runs failed', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  /** The command in this process, against the stand-in, on the deployment's home. */
  async function agentInProcess(d: Deployment, args: string[]): Promise<void> {
    for (const key of Object.keys(agentCommand.opts())) {
      agentCommand.setOptionValue(key, OPTION_DEFAULTS[key]);
    }
    const saved = {
      HOME: process.env['HOME'],
      key: process.env['ANTHROPIC_API_KEY'],
      url: process.env['ANTHROPIC_BASE_URL'],
      cwd: process.cwd(),
    };
    process.env['HOME'] = d.h.root;
    process.env['ANTHROPIC_API_KEY'] = 'k-d2-anthropic';
    process.env['ANTHROPIC_BASE_URL'] = anthropic.baseUrl;
    process.chdir(d.proj);
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await agentCommand.parseAsync(['node', 'realm', ...args]);
    } finally {
      process.chdir(saved.cwd);
      const restore = (key: string, value: string | undefined): void => {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      };
      restore('HOME', saved.HOME);
      restore('ANTHROPIC_API_KEY', saved.key);
      restore('ANTHROPIC_BASE_URL', saved.url);
    }
  }
  // The real case: the home's run list cannot be read when the drive starts, by an operator's drive
  // and by one `realm listen` started. (a) red when a failed read is taken as no history (`step_gaps`
  // with no gap); (b) prints the run's phase and the record's ask.
  it.each<[string, string[], number]>([
    ['a drive realm agent started', [], 300],
    ['a drive realm listen started', ['--spawned-by-listen'], 3600],
  ])(
    '%s: step_gaps_unreadable, that runner’s prior, and the drive completes',
    async (_case, flags, lifetime) => {
      const d = await deployment(`7-${String(lifetime)}`, { prices: PRICES_FULL });
      await seedEarlier(d, ['ask'], 600);
      const runId = await newRun(d);
      vi.spyOn(d.h.home.runStore, 'scan').mockImplementation(() => {
        throw new Error('the run list cannot be read');
      });
      await agentInProcess(d, ['--run-id', runId, '--model', 'claude-x', ...flags]);
      vi.restoreAllMocks();
      const { record } = await d.h.home.runStore.get(runId);
      const r = firstRequest(record, 'ask');
      expect({
        phase: record.run_phase,
        lifetime: r?.cache_lifetime_s,
        auto: r?.cache_auto,
      }).toEqual({
        phase: 'completed',
        lifetime,
        auto: { basis: 'step_gaps_unreadable' },
      });
    },
    60_000,
  );
});

/** `realm run inspect` on the deployment's home, the built CLI: the step's `asked for` clause. */
function inspectAsk(d: Deployment, runId: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, 'run', 'inspect', runId], {
      cwd: d.proj,
      env: { PATH: process.env['PATH'] ?? '', HOME: d.h.root, REALM_NO_NUDGE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString()));
    child.on('close', () => {
      const line = out.split('\n').find((l) => l.includes('asked for')) ?? '';
      // The ask's words, up to the line's next field (` | not priced …`).
      resolve(line.slice(line.indexOf('asked for')).split(' | ')[0]!);
    });
  });
}

describe('caching 3-M D-2r — check 2: with no price file, the 1-hour fallback through the command', () => {
  const EVIDENCE = "realm agent's default; auto: the last gap between this step's runs was about";
  const NO_FILE = 'no price file (runner.cache.economics is not set)';
  // The real case: the owner's runner — `realm agent --run-id …` on Anthropic, no price file named —
  // on a step whose one earlier run was 20 minutes back, or 3 hours back. (a) red when the fallback
  // still follows `realm agent`'s 5-minute prior (the 20-minute row then asks nothing); red when the
  // words are still keyed on the runner (the 3-hour row then says 270 seconds); (b) prints the code,
  // the markers sent, the inspect words and the reads.
  it.each<[string, number, unknown, string]>([
    [
      '20 minutes back → 1 hour',
      1200,
      [{ type: 'ephemeral', ttl: '1h' }],
      `asked for 1 hour (sent as 1 hour; ${EVIDENCE} 20 minutes; ${NO_FILE}, so 1 hour without prices)`,
    ],
    [
      '3 hours back → no caching',
      10800,
      'plain',
      `asked for no caching (${EVIDENCE} 3 hours; ${NO_FILE}, and no gap was under 54 minutes, so no caching)`,
    ],
  ])(
    'an earlier request %s',
    async (_case, agoS, marks, words) => {
      const d = await deployment(`d2r-${String(agoS)}`, {
        prices: PRICES_FULL,
        realmYaml: 'version: 1\n',
      });
      await seedEarlier(d, ['ask'], agoS);
      const runId = await newRun(d);
      const r = await drive(
        `d2r-${String(agoS)}`,
        d,
        ['--run-id', runId, '--model', 'claude-x'],
        runId,
      );
      expect({
        code: r.code,
        bodies: r.bodies,
        words: await inspectAsk(d, runId),
        reads: r.reads,
      }).toEqual({ code: 0, bodies: [marks], words, reads: 0 });
    },
    60_000,
  );
});
