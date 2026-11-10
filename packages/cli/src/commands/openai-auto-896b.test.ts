// openai-auto-896b.test.ts — #896 unit B: `--prompt-cache auto` chooses no caching or 30 minutes
// for a step without tools on OpenAI GPT-5.6 and later at OpenAI's own address, by #898's rule with
// OpenAI's one lifetime and the price file's `cache_read` and `cache_write`.
//
// Check 6 and caching 3-M D-2's check 6 drive the BUILT `realm agent` on a run (`--run-id …`, the way
// `realm listen` starts it) in a scratch HOME, then `realm run inspect` on the same run. The child
// runs with `NODE_OPTIONS=--import <hook>`: the hook appends every path passed to an fs read to a log
// (so a cell can count the reads of the price file, #898's instrument), and replaces the global
// `fetch` for OpenAI's own address (`https://api.openai.com/v1/`): it records each body the openai
// SDK sends and answers with a completion whose usage copies gpt-5.6-luna's
// (plans/issue-896/live-checks/results-gpt-5.6-luna.json); any other address is refused, so nothing
// leaves the machine. The price rows are fakes in the price file's own row shape (format v1), with
// read 0.1 and write 1.25 of input. Check 9's cells run in process. Caching 3-M D-3: checks 1–5, the
// pending choice and check 7 went with `realm listen`'s measured gaps and the settle (what the price
// file decides is now D-2's checks 3, 6 and 12, and `auto-prices-898.test.ts`'s cells). Beside each:
// (a) the change that turns it red; (b) what it prints when it fails — the bodies' cache fields, the
// record's ask, the start line, the inspect line, the warning line, the read count; never an
// environment, a header or a key (the key is a fake).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  type CacheAuto,
  type RunRecord,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { OpenAIProvider } from '../agent/providers/openai-provider.js';
import type { ToolDefinition } from '../agent/mcp/mcp-extensions.js';
import type { ToolCapableLlmProvider } from '../agent/providers/llm-provider.js';
import { promptCacheStartLine } from '../agent/prompt-cache.js';
import { listenCachingFacts } from './listen.js';
import { makeTempHome, type TempHome } from '../test-support/temp-home.js';

const CLI = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const LUNA_USAGE = {
  prompt_tokens: 4015,
  completion_tokens: 6,
  total_tokens: 4021,
  prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 3930, audio_tokens: 0 },
};
const REPLY = {
  id: 'chatcmpl-fake',
  object: 'chat.completion',
  created: 0,
  model: 'gpt-5.6-luna',
  choices: [
    {
      index: 0,
      message: { role: 'assistant', content: '{"summary":"ok"}', refusal: null },
      finish_reason: 'stop',
      logprobs: null,
    },
  ],
  usage: LUNA_USAGE,
};
/** The read log and the fetch stand-in, loaded into the child before the CLI. */
const HOOK = `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const readLog = process.env.REALM_896B_READ_LOG;
const bodyLog = process.env.REALM_896B_BODY_LOG;
const log = (p) => { if (readLog !== undefined && (typeof p === 'string' || p instanceof URL)) fs.appendFileSync(readLog, String(p) + '\\n'); };
const wrap = (owner, name) => { const real = owner[name]; owner[name] = function (p, ...rest) { log(p); return real.call(this, p, ...rest); }; };
wrap(fs, 'readFileSync'); wrap(fs, 'readFile'); wrap(fs.promises, 'readFile'); wrap(fs, 'openSync'); wrap(fs.promises, 'open');
syncBuiltinESMExports();
const REPLY = ${JSON.stringify(JSON.stringify(REPLY))};
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith('https://api.openai.com/v1/')) throw new Error('the 896b hook sends nothing to ' + url);
  fs.appendFileSync(bodyLog, String(init && init.body) + '\\n');
  return new Response(REPLY, { status: 200, headers: { 'content-type': 'application/json' } });
};
`;

const MODEL = 'gpt-5.6-luna';
/** The step's prompt: a fixed head, then the run's ticket (a fake). */
const HEAD = 'You sort support tickets for a small shop. Pick exactly one queue.\nTicket: ';
const TICKET = 'FAKE-TICKET-1: my parcel never came';
const row = (rates: Record<string, number>): string =>
  JSON.stringify({
    version: 1,
    currency: 'USD',
    models: { [MODEL]: { prices: [{ per_million_tokens: { input: 4, output: 20, ...rates } }] } },
  });
/** Read 0.1 and write 1.25 of input. */
const PRICED = row({ cache_read: 0.4, cache_write: 5 });
const NAMES_PRICES = 'version: 1\nrunner:\n  cache:\n    economics: prices.json\n';

let root: string;
/** Every deployment's home, cleaned with the root. */
const homes: TempHome[] = [];
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'realm-896b-e2e-'));
  writeFileSync(join(root, 'hook.mjs'), HOOK);
});
afterAll(async () => {
  for (const t of homes.splice(0)) await t.cleanup();
  rmSync(root, { recursive: true, force: true });
});

type Deployment = { home: string; proj: string; runId: string; pricesPath: string; h: TempHome };
/** One scratch deployment: a trust root with `realm.yaml` (and its price file, when any), the
 *  one-step workflow registered in a fresh HOME, and one run created there. */
async function deployment(
  name: string,
  opts: { realmYaml?: string; prices?: string },
): Promise<Deployment> {
  const base = join(root, name);
  const h = await makeTempHome();
  homes.push(h);
  const home = h.root;
  const proj = join(base, 'proj');
  const wfDir = join(proj, 'workflows', 'wf');
  mkdirSync(home, { recursive: true });
  mkdirSync(wfDir, { recursive: true });
  writeFileSync(join(proj, 'package.json'), '{"name":"p896b","private":true}\n');
  const pricesPath = join(proj, 'prices.json');
  if (opts.prices !== undefined) writeFileSync(pricesPath, opts.prices);
  if (opts.realmYaml !== undefined) writeFileSync(join(proj, 'realm.yaml'), opts.realmYaml);
  const definition = {
    id: `wf-896b-${name}`,
    name: `wf 896b ${name}`,
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps: {
      ask: {
        description: 'Sort one ticket.',
        execution: 'agent',
        prompt: `${HEAD}{{ run.params.ticket }}`,
      },
    },
    source_dir: wfDir,
    trust_root: proj,
  } as unknown as WorkflowDefinition;
  await h.home.workflowStore.register(definition);
  const { record: run } = await h.home.runStore.create({
    workflowId: definition.id,
    workflowVersion: 1,
    params: { ticket: TICKET },
  });
  return { home, proj, runId: run.id, pricesPath, h };
}

function run(
  d: Deployment,
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: d.proj,
      env: {
        PATH: process.env['PATH'] ?? '',
        HOME: d.home,
        REALM_NO_NUDGE: '1',
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString()));
    child.stderr.on('data', (c: Buffer) => (err += c.toString()));
    const timer = setTimeout(() => child.kill('SIGKILL'), 40_000);
    child.on('close', (c) => {
      clearTimeout(timer);
      resolve({ code: c, stdout: out, stderr: err });
    });
  });
}

type Body = Record<string, unknown>;
const sha256 = (t: string): string => createHash('sha256').update(t, 'utf8').digest('hex');
function shape(content: unknown): unknown {
  if (typeof content === 'string') return 'plain';
  return (content as Array<{ text: string; prompt_cache_breakpoint?: unknown }>).map((p) => ({
    chars: p.text.length,
    marked: p.prompt_cache_breakpoint !== undefined,
  }));
}
/** A body's cache fields, short: the options, the system and prompt shapes, the key. */
const cacheView = (b: Body) => {
  const messages = b['messages'] as Array<{ content: unknown }>;
  return {
    options: b['prompt_cache_options'],
    system: shape(messages[0]!.content),
    user: shape(messages[1]!.content),
    key: b['prompt_cache_key'],
  };
};
const ASK = [
  'cache_requested',
  'cache_lifetime_s',
  'cache_ttl_sent',
  'cache_requested_source',
  'cache_requested_by',
  'cache_auto',
  'cache_marked',
] as const;

/** Drives `realm agent` once on the run, then `realm run inspect` on it, and reads back what was
 *  sent, recorded and printed. */
async function drive(name: string, d: Deployment, args: string[]) {
  const readLog = join(root, `${name}.reads`);
  const bodyLog = join(root, `${name}.bodies`);
  const agent = await run(
    d,
    ['agent', '--run-id', d.runId, '--provider', 'openai', '--model', MODEL, ...args],
    {
      OPENAI_API_KEY: 'k-896b-fake',
      NODE_OPTIONS: `--import=${pathToFileURL(join(root, 'hook.mjs')).href}`,
      REALM_896B_READ_LOG: readLog,
      REALM_896B_BODY_LOG: bodyLog,
    },
  );
  const inspect = await run(d, ['run', 'inspect', d.runId]);
  const { record } = await d.h.home.runStore.get(d.runId);
  const request = record.evidence[0]?.diagnostics?.cache?.requests?.[0] as
    Record<string, unknown> | undefined;
  const bodies = existsSync(bodyLog)
    ? readFileSync(bodyLog, 'utf8')
        .split('\n')
        .filter((l) => l !== '')
        .map((l) => JSON.parse(l) as Body)
    : [];
  const reads = existsSync(readLog) ? readFileSync(readLog, 'utf8').split('\n') : [];
  return {
    code: agent.code,
    startLine: agent.stdout.split('\n').find((l) => l.startsWith('Caching:')) ?? agent.stderr,
    warning: agent.stderr.split('\n').find((l) => l.includes('the price file could not be used')),
    bodies: bodies.map(cacheView),
    ask: request === undefined ? undefined : Object.fromEntries(ASK.map((k) => [k, request[k]])),
    priceFileReads: reads.filter(
      (p) => p === d.pricesPath || p === pathToFileURL(d.pricesPath).href,
    ).length,
    inspect: inspect.stdout.split('\n').find((l) => l.includes('asked for')) ?? inspect.stderr,
  };
}

const OFF = 'Caching: off; OpenAI is asked to cache nothing';
/** Caching 3-M D-3: the OpenAI line under `auto`, which names no single lifetime. */
const AUTO_LINE =
  "Caching: OpenAI is asked to cache each step's fixed instructions and the stable start of its prompt for 30 minutes or not at all, as auto chooses per step from that step's own earlier runs";
/** Unit A's request: explicit mode for 30 minutes, the system text and the head marked, the key. */
const UNIT_A_BODY = {
  options: { mode: 'explicit', ttl: '30m' },
  system: [{ chars: expect.any(Number), marked: true }],
  user: [
    { chars: HEAD.length, marked: true },
    { chars: TICKET.length, marked: false },
  ],
  key: sha256(HEAD),
};
/** Unit A's real off: explicit mode, no mark, no key. */
const OFF_BODY = { options: { mode: 'explicit' }, system: 'plain', user: 'plain', key: undefined };
const lifetimeAsk = (cacheAuto: unknown) => ({
  cache_requested: 'lifetime',
  cache_lifetime_s: 1800,
  cache_ttl_sent: true,
  cache_requested_source: 'runner_default',
  cache_requested_by: 'realm listen',
  cache_auto: cacheAuto,
  cache_marked: ['system', 'prompt', 'key'],
});
const offAsk = (cacheAuto: unknown) => ({
  cache_requested: 'off',
  cache_lifetime_s: undefined,
  cache_ttl_sent: undefined,
  cache_requested_source: 'runner_default',
  cache_requested_by: 'realm listen',
  cache_auto: cacheAuto,
  cache_marked: undefined,
});

describe('#896 unit B — `auto` on a drive realm listen starts, GPT-5.6 and later at OpenAI’s own address', () => {
  // (a) red when the price file is read with no kept gap; (b) prints the read count, the
  //     warning, the ask and the start line.
  it('check 6: realm agent alone (no gap), an unreadable price file named → 30 minutes; a step with no earlier run and no prices; no price error', async () => {
    const d = await deployment('c6', {
      realmYaml: NAMES_PRICES,
      prices: 'version: 1\n\tcurrency: USD\n',
    });
    const r = await drive('c6', d, []);
    expect({
      code: r.code,
      reads: r.priceFileReads,
      warning: r.warning,
      cacheAuto: r.ask?.['cache_auto'],
      bodies: r.bodies,
      startLine: r.startLine,
    }).toEqual({
      code: 0,
      reads: 0,
      warning: undefined,
      cacheAuto: { basis: 'step_gaps', gaps_s: [] },
      bodies: [UNIT_A_BODY],
      startLine: `${AUTO_LINE} (realm agent's default; turn it off with --prompt-cache off).`,
    });
  }, 90_000);
});

/** An earlier run of the deployment's workflow, its step's request started `ago_s` seconds ago. */
async function seedEarlier(d: Deployment, agoS: number): Promise<void> {
  const store = d.h.home.runStore;
  const { record: current } = await store.get(d.runId);
  const { record } = await store.create({
    workflowId: current.workflow_id,
    workflowVersion: 1,
    params: { ticket: TICKET },
  });
  const start = new Date(Date.now() - agoS * 1000).toISOString();
  await store.update({
    ...record,
    completed_steps: ['ask'],
    evidence: [
      {
        step_id: 'ask',
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
      },
    ],
  } as unknown as RunRecord);
}

describe('caching 3-M D-2 — check 6: OpenAI in the explicit set chooses for each step', () => {
  // The real case: a step without tools on a drive `realm listen` started, its earlier runs every 2
  // hours (constructed), or every 5 minutes; the price file's rates (write 1.25, read 0.1).
  it.each<[string, number, 'off' | 1800]>([
    ['earlier runs every 2 hours → no caching', 7200, 'off'],
    ['earlier runs every 5 minutes → 30 minutes', 300, 1800],
  ])(
    '%s, recorded step_gaps',
    async (_case, every, chosen) => {
      const d = await deployment(`d2-${String(every)}`, {
        realmYaml: NAMES_PRICES,
        prices: PRICED,
      });
      for (const k of [3, 2, 1]) await seedEarlier(d, k * every);
      const r = await drive(`d2-${String(every)}`, d, ['--spawned-by-listen']);
      const auto = r.ask?.['cache_auto'] as CacheAuto | undefined;
      const last = auto?.gaps_s?.at(-1) ?? -1;
      // (a) red when the rule is not asked for OpenAI (the step then asks the instance's 30 minutes,
      //     recorded on listen's basis); (b) prints the bodies, the ask, the read count and whether the
      //     last gap is the host's reading within 5 seconds.
      expect({
        code: r.code,
        bodies: r.bodies,
        ask: r.ask,
        reads: r.priceFileReads,
        lastGap: last >= every && last <= every + 5,
      }).toEqual({
        code: 0,
        bodies: [chosen === 'off' ? OFF_BODY : UNIT_A_BODY],
        ask: (chosen === 'off' ? offAsk : lifetimeAsk)({
          basis: 'step_gaps',
          gaps_s: [every, every, expect.any(Number)],
          prices: { from: 'economics' },
        }),
        reads: 1,
        lastGap: true,
      });
    },
    90_000,
  );
});

// In process: the real `openai` package with the global `fetch` stubbed, as unit A's checks are.
let sent: Body[] = [];
let script: unknown[] = [];
const completion = (message: Record<string, unknown>) => ({
  ...REPLY,
  choices: [
    {
      ...REPLY.choices[0],
      message: { role: 'assistant', refusal: null, ...message },
      finish_reason: message['tool_calls'] !== undefined ? 'tool_calls' : 'stop',
    },
  ],
});
beforeEach(() => {
  sent = [];
  script = [];
  vi.stubEnv('OPENAI_API_KEY', 'k-896b-fake');
  vi.stubEnv('OPENAI_BASE_URL', '');
  delete process.env['OPENAI_BASE_URL'];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: unknown, init?: { body?: unknown }) => {
      sent.push(JSON.parse(String(init?.body)) as Body);
      const next = script.shift() ?? completion({ content: '{"summary":"ok"}' });
      return new Response(JSON.stringify(next), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const tool: ToolDefinition = {
  id: 'srv:t',
  serverId: 'srv',
  name: 't',
  description: 'A tool',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
};
const EXECUTOR = (async () => ({ content: [{ type: 'text', text: 'ok' }] })) as never;

describe('#896 unit B — a tool step', () => {
  // Caching 3-M D-3, test rule (4): the drive is an `auto` instance `realm listen` started, with no
  // gaps, and the step's choice of no caching is the call's own option (it was the drive settled
  // with no price file on gaps of 40 minutes and 2 hours).
  // (a) red when the call's off is applied to a tool step; (b) prints each turn's cache fields and
  //     the record's ask and cache_auto.
  it('check 7: a tool step whose call carries auto’s no caching is as on the base, with no cache_auto', async () => {
    // Called as `runAgent` calls it, through the interface that carries the call's option.
    const provider: ToolCapableLlmProvider = new OpenAIProvider(MODEL, undefined, false, {
      endpoint: 'default',
      promptCache: { value: 'auto', source: 'runner_default', by: 'realm listen' },
    });
    script = [
      completion({
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 't', arguments: '{}' } }],
      }),
    ];
    const r = await provider.callStepWithTools(`${HEAD}${TICKET}`, [tool], EXECUTOR, {
      cachePrefixChars: HEAD.length,
      cacheChoice: { choice: 'off', auto: { basis: 'step_gaps', gaps_s: [2400, 7200] } },
    });
    expect({
      turns: sent.map((b) => [
        b['prompt_cache_options'],
        JSON.stringify(b).includes('prompt_cache_breakpoint'),
        b['prompt_cache_key'],
      ]),
      asks: r.usage!.map((u) => [u.cache_requested, u.cache_auto]),
    }).toEqual({
      turns: [
        [undefined, false, sha256(HEAD)],
        [undefined, false, sha256(HEAD)],
      ],
      asks: [
        ['provider_rules', undefined],
        ['provider_rules', undefined],
      ],
    });
  });
});

describe('#896 unit B check 9 — the words', () => {
  const TOOLS_ONLY = {
    steps: { lookup: { execution: 'agent', description: 'L.', tools: ['srv:t'] } },
  };
  // (a) red when the step counts are checked before a stated off; (b) prints the line.
  it('every agent step calls tools, off stated: unit A’s off line', () => {
    const setting = { value: 'off', source: 'stated', by: 'realm agent' } as const;
    const provider = new OpenAIProvider(MODEL, undefined, false, {
      endpoint: 'default',
      promptCache: setting,
    });
    expect(
      promptCacheStartLine({
        caps: provider.capabilities(),
        promptCache: setting,
        moduleProviderId: undefined,
        definition: TOOLS_ONLY as never,
      }),
    ).toBe(`${OFF} (set by --prompt-cache off).`);
  });
  // (a) red when listen's value under auto (or no setting) is reverted to unit A's, or `long` takes
  //     it; (b) prints the three values.
  it('listen’s openai value: auto and no setting choose; long keeps unit A’s value', () => {
    const value = (setting: 'auto' | 'long' | undefined) =>
      listenCachingFacts('openai', setting, 'default', MODEL)['openai'];
    const AUTO =
      "auto: off or 30 minutes for each step without tools, by that step's own earlier runs and the prices in runner.cache.economics; a cache key, except on a step without tools when off";
    expect([value('auto'), value(undefined), value('long')]).toEqual([
      AUTO,
      AUTO,
      '30 minutes, the one lifetime Realm can ask OpenAI for, and a cache key',
    ]);
  });
});
