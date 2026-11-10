// auto-prices-898.test.ts — issue #898 S9: `realm agent` end to end. The built CLI drives a listen-
// shaped run (`--run-id … --spawned-by-listen`) against the in-test Anthropic stand-in (local,
// records each request body), in a scratch HOME, with a fixture `realm.yaml` and price file. Caching
// 3-M D-3: (a)–(d) went with `realm listen`'s measured gaps; what the price file decides, its one
// read, its warning and the fallback's words are now held by `agent-auto-per-step-3m.test.ts` (D-2's
// checks 3 and 12, D-2r's check 2).
// The child runs with `NODE_OPTIONS=--import <hook>`, where the hook appends every path passed to an
// fs read to a log, so a cell can count the reads of the price file. Beside each: (a) the change that
// turns it red; (b) what it prints when it fails — the stub's recorded `cache_control` fields only,
// the record's `cache_auto`, the start line, the warning line; never an environment, a header or a
// key.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CURRENT_WORKFLOW_SCHEMA_VERSION, type WorkflowDefinition } from '@sensigo/realm';
import { startAnthropicStub, type AnthropicStub } from '../agent/test-support/anthropic-stub.js';
import { startOpenAiStub, type OpenAiStub } from '../agent/test-support/openai-stub.js';
import { makeTempHome, type TempHome } from '../test-support/temp-home.js';

const CLI = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
/** The read log hook: every path handed to an fs read, one per line, to `$REALM_898_READ_LOG`. */
const HOOK = `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const logFile = process.env.REALM_898_READ_LOG;
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

let root: string;
/** Every deployment's home, cleaned with the root. */
const homes: TempHome[] = [];
let anthropic: AnthropicStub;
let openai: OpenAiStub;
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'realm-898-e2e-'));
  writeFileSync(join(root, 'read-hook.mjs'), HOOK);
  anthropic = await startAnthropicStub({
    finalContent: { summary: 'ok' },
    answeredModel: 'claude-x-20260101',
    usage: {
      input_tokens: 20,
      output_tokens: 3,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  });
  openai = await startOpenAiStub({ finalContent: { summary: 'ok' } });
});
afterAll(async () => {
  await anthropic.close();
  await openai.close();
  for (const t of homes.splice(0)) await t.cleanup();
  rmSync(root, { recursive: true, force: true });
});

/** One scratch deployment: a trust root with `realm.yaml` (and the price file it names, when any), the
 *  workflow registered in a fresh HOME, and one run created there. */
async function deployment(
  name: string,
  opts: { realmYaml?: string; prices?: string },
): Promise<{ home: string; proj: string; runId: string; pricesPath: string; h: TempHome }> {
  const base = join(root, name);
  const h = await makeTempHome();
  homes.push(h);
  const home = h.root;
  const proj = join(base, 'proj');
  const wfDir = join(proj, 'workflows', 'wf');
  mkdirSync(home, { recursive: true });
  mkdirSync(wfDir, { recursive: true });
  writeFileSync(join(proj, 'package.json'), '{"name":"p898","private":true}\n');
  const pricesPath = join(proj, 'prices.json');
  if (opts.prices !== undefined) writeFileSync(pricesPath, opts.prices);
  if (opts.realmYaml !== undefined) writeFileSync(join(proj, 'realm.yaml'), opts.realmYaml);
  const definition = {
    id: `wf-898-${name}`,
    name: `wf 898 ${name}`,
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps: { ask: { description: 'Answer.', execution: 'agent' } },
    source_dir: wfDir,
    trust_root: proj,
  } as unknown as WorkflowDefinition;
  await h.home.workflowStore.register(definition);
  const { record: run } = await h.home.runStore.create({
    workflowId: definition.id,
    workflowVersion: 1,
    params: {},
  });
  return { home, proj, runId: run.id, pricesPath, h };
}

const NAMES_PRICES = 'version: 1\nrunner:\n  cache:\n    economics: prices.json\n';

/** Drives `realm agent` once and reads back what it sent, recorded and printed. */
async function drive(
  name: string,
  d: { home: string; proj: string; runId: string; pricesPath: string; h: TempHome },
  args: string[],
): Promise<{
  code: number | null;
  startLine: string;
  warning: string | undefined;
  cacheControl: unknown[];
  cacheAuto: unknown;
  priceFileReads: number;
}> {
  const readLog = join(root, `${name}.reads`);
  const before = anthropic.requests.length;
  const { code, stdout, stderr } = await new Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
  }>((resolve) => {
    const child = spawn(process.execPath, [CLI, 'agent', ...args], {
      cwd: d.proj,
      env: {
        PATH: process.env['PATH'] ?? '',
        HOME: d.home,
        // One provider's key only: with both set and no --provider, Realm picks OpenAI.
        ...(args.includes('openai')
          ? { OPENAI_API_KEY: 'k-898-openai', OPENAI_BASE_URL: openai.baseUrl }
          : { ANTHROPIC_API_KEY: 'k-898-anthropic', ANTHROPIC_BASE_URL: anthropic.baseUrl }),
        NODE_OPTIONS: `--import=${pathToFileURL(join(root, 'read-hook.mjs')).href}`,
        REALM_898_READ_LOG: readLog,
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
  const sent = anthropic.requests.slice(before);
  const { record } = await d.h.home.runStore.get(d.runId);
  const request = record.evidence[0]?.diagnostics?.cache?.requests?.[0];
  const reads = existsSync(readLog) ? readFileSync(readLog, 'utf8').split('\n') : [];
  return {
    code,
    startLine: stdout.split('\n').find((l) => l.startsWith('Caching:')) ?? '',
    warning: stderr.split('\n').find((l) => l.includes('the price file could not be used')),
    cacheControl: sent.map((body) => {
      const system = body['system'];
      return Array.isArray(system)
        ? (system as Array<Record<string, unknown>>).map((b) => b['cache_control'] ?? null)
        : 'plain';
    }),
    cacheAuto: request?.cache_auto,
    priceFileReads: reads.filter(
      (p) => p === d.pricesPath || p === pathToFileURL(d.pricesPath).href,
    ).length,
  };
}

describe('#898 S9 — realm agent end to end: the price file decides what auto asks for', () => {
  // (a) red when the file is read unconditionally; (b) prints the read count and cache_auto.
  it('(e) a lone realm agent drive (no gaps) never opens the price file, and its cache_auto has no prices (its step has no earlier run)', async () => {
    const d = await deployment('e', { realmYaml: NAMES_PRICES, prices: PRICES_FULL });
    const r = await drive('e', d, ['--run-id', d.runId, '--model', 'claude-x']);
    expect({ code: r.code, reads: r.priceFileReads, cacheAuto: r.cacheAuto }).toEqual({
      code: 0,
      reads: 0,
      cacheAuto: { basis: 'step_gaps', gaps_s: [] },
    });
  }, 60_000);

  // (a) red when the file is read unconditionally; (b) prints the read count.
  it('(f) --provider openai with --prompt-cache auto never opens the price file', async () => {
    const d = await deployment('f', { realmYaml: NAMES_PRICES, prices: PRICES_FULL });
    const r = await drive('f', d, [
      '--run-id',
      d.runId,
      '--provider',
      'openai',
      '--model',
      'gpt-x',
      '--prompt-cache',
      'auto',
      '--spawned-by-listen',
    ]);
    expect({ code: r.code, reads: r.priceFileReads }).toEqual({ code: 0, reads: 0 });
  }, 60_000);

  // (a) red when a stated auto on a listen-shaped drive stops it before it starts (until caching 3-M
  //     D-3: a presence check that read a pending choice), or the C3b refusal stops firing; (b)
  //     prints the exit codes and the refusal's first words.
  // caching 3-B (row 4): the C3b refusal is gone — OpenAI applies the setting (the cache key). The
  // OpenAI command now goes past the old refusal's place to reading its workflow (`none.yaml` is
  // not written, so it stops there). (a) red when the refusal is put back; (b) prints the codes and
  // stderr's first line.
  it('(g) a stated auto on a listen-shaped drive completes; an OpenAI drive given a setting is no longer refused', async () => {
    const d = await deployment('g', { realmYaml: NAMES_PRICES, prices: PRICES_FULL });
    const stated = await drive('g', d, [
      '--run-id',
      d.runId,
      '--model',
      'claude-x',
      '--prompt-cache',
      'auto',
      '--spawned-by-listen',
    ]);
    const refused = await new Promise<{ code: number | null; first: string }>((resolve) => {
      const child = spawn(
        process.execPath,
        [
          CLI,
          'agent',
          '--workflow',
          join(d.proj, 'none.yaml'),
          '--provider',
          'openai',
          '--model',
          'gpt-x',
          '--prompt-cache',
          'short',
        ],
        {
          cwd: d.proj,
          env: {
            PATH: process.env['PATH'] ?? '',
            HOME: d.home,
            OPENAI_API_KEY: 'k-898-openai',
            OPENAI_BASE_URL: openai.baseUrl,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let err = '';
      child.stderr.on('data', (c: Buffer) => (err += c.toString()));
      child.on('close', (c) => resolve({ code: c, first: err.split('\n')[0]!.slice(0, 60) }));
    });
    expect({
      stated: stated.code,
      openai: {
        code: refused.code,
        refusedForCaching: refused.first.includes('sets caching only'),
      },
    }).toEqual({
      stated: 0,
      openai: { code: 1, refusedForCaching: false },
    });
  }, 60_000);
});
