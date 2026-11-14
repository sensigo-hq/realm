// module-usage-fields-checked.test.ts — U3: what a provider module (`--provider-module`) writes in a
// usage record's `cache_requested`, `cache_requested_source`, `cache_requested_by` and `endpoint` is
// checked as text when it is not one of Realm's own words, and counted on the receipt; a record's
// `provider` is the drive's word. One run of the project below, driven twice by the BUILT CLI: the
// first drive's module call fails with its usage attached (a drive failure that keeps its request),
// the re-attached drive's module answers, so its first request carries a copy of the earlier one
// (`reference`, from the run). Then `realm run export` writes the run to a file and the built
// `realm mcp` answers `get_run_state` for it. The declared value is a fake in the project's `.env`;
// the endpoint is a fake address with a user part. Every assertion names (a) the break that turns it
// red and (b) what it prints when it fails: counts, booleans, kinds and markers, never a fake value.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { RunRecord, UsageRecord } from '@sensigo/realm';
import { makeTempHome, runsOf, type TempHome } from '../test-support/temp-home.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../../../..');
const CLI = join(HERE, '../../dist/index.js');
/** The declared fake: in the project's `.env` only. The module writes it in `cache_requested`. */
const DECLARED = 'CANARY-u3-declared-1f2e-xxxxxxxx';
/** The fake password in the endpoint's user part: hidden by the URL pattern, not by a declaration. */
const ENDPOINT_TOKEN = 'FAKE-u3-endpoint-token-cccc';
const SOURCE_TEXT = 'CANARY-u3-source-aaaa';
const BY_TEXT = 'CANARY-u3-by-bbbb';
const HIDDEN = '[REDACTED]';

/** The module: it declares `providerId: 'anthropic'`; a failing call carries its usage. */
const MODULE = `import { LlmProvider } from '@sensigo/realm-cli/agent';
const usage = () => [{
  request_index: 0,
  request_start: new Date().toISOString(),
  model: 'fake-model',
  prompt_tokens: 1,
  output_tokens: 1,
  cache_requested: ${JSON.stringify(DECLARED)},
  cache_requested_source: ${JSON.stringify(SOURCE_TEXT)},
  cache_requested_by: ${JSON.stringify(BY_TEXT)},
  endpoint: ${JSON.stringify(`https://fakeuser:${ENDPOINT_TOKEN}@host.invalid/v1`)},
}];
class Module extends LlmProvider {
  capabilities() { return { jsonMode: false, providerId: 'anthropic' }; }
  async callStep() { return { word: 'hello' }; }
  async callStepWithMeta() {
    if (process.env.U3_MODULE_FAILS === '1') {
      throw Object.assign(new Error('the module call failed on purpose'), { driveCall: { usage: usage() } });
    }
    return { output: { word: 'hello' }, usage: usage() };
  }
}
export default new Module();
`;

/** How many times each fake shows in `text`: what a failing cell prints instead of the text. */
const shown = (text: string) => ({
  declared: text.split(DECLARED).length - 1,
  endpointToken: text.split(ENDPOINT_TOKEN).length - 1,
  source: text.split(SOURCE_TEXT).length - 1,
  by: text.split(BY_TEXT).length - 1,
});

/** What a request shows of its four fields, as kinds: hidden, Realm's word, the fake, or masked by
 *  the URL pattern (the address kept, its password replaced). */
const kindsOf = (request: Partial<UsageRecord> | undefined) => {
  // The stored field is typed as Realm's words; a module's text is read as a string.
  const endpoint = request?.endpoint as string | undefined;
  return {
    cache_requested:
      request?.cache_requested === undefined
        ? 'absent'
        : (request.cache_requested as string) === HIDDEN
          ? 'hidden'
          : 'other',
    endpoint:
      endpoint === undefined
        ? 'absent'
        : endpoint === `https://fakeuser:${HIDDEN}@host.invalid/v1`
          ? 'password hidden'
          : 'other',
  };
};

let root: string;
let project: string;
let h: TempHome;
let runId: string;
let drives: { first: number | null; second: number | null };
let exportCode: number | null;
let exported: string;
let mcpText: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'realm-u3-usage-'));
  h = await makeTempHome();
  project = join(root, 'project');
  mkdirSync(project);
  symlinkSync(join(ROOT, 'node_modules'), join(project, 'node_modules'), 'dir');
  writeFileSync(join(project, 'package.json'), '{ "type": "module" }\n', 'utf8');
  writeFileSync(join(project, '.env'), `U3_TOKEN=${DECLARED}\n`, 'utf8');
  writeFileSync(
    join(project, 'realm.yaml'),
    [
      'version: 1',
      'secrets:',
      '  sources: [dotenv]',
      '  dotenv: .env',
      'adapters:',
      '  svc:',
      '    use: github',
      '    config: { token: "${secret:U3_TOKEN}" }',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    join(project, 'workflow.yaml'),
    [
      'id: u3-module-usage',
      'name: u3 module usage',
      'version: 1',
      'steps:',
      '  answer:',
      '    description: Answer with one word.',
      '    execution: agent',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(join(project, 'm.mjs'), MODULE, 'utf8');
  const realm = (args: string[], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, [CLI, ...args], {
      cwd: project,
      env: { PATH: process.env['PATH'] ?? '', HOME: h.root!, NO_COLOR: '1', ...env },
      encoding: 'utf8',
      timeout: 60_000,
    });
  // `--run-id` reads the workflow from the store, so it is registered first.
  expect(realm(['workflow', 'register', './workflow.yaml']).status).toBe(0);
  const first = realm(['agent', '--workflow', './workflow.yaml', '--provider-module', './m.mjs'], {
    U3_MODULE_FAILS: '1',
  });
  const runs = await runsOf(h.home.runStore);
  expect(runs).toHaveLength(1);
  runId = runs[0]!.record.id;
  const second = realm(['agent', '--run-id', runId, '--provider-module', './m.mjs']);
  drives = { first: first.status, second: second.status };
  const out = join(root, 'export.json');
  exportCode = realm(['run', 'export', runId, '--out', out]).status;
  exported = readFileSync(out, 'utf8');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, 'mcp'],
    env: { PATH: process.env['PATH'] ?? '', HOME: h.root! },
    cwd: project,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'u3-usage', version: '0' });
  await client.connect(transport);
  try {
    const raw = (await client.callTool({
      name: 'get_run_state',
      arguments: { run_id: runId },
    })) as { content: Array<{ text: string }> };
    mcpText = raw.content[0]!.text;
  } finally {
    await client.close();
  }
}, 180_000);

afterAll(async () => {
  await h?.cleanup();
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

describe("U3 — a provider module's usage fields are checked and counted", () => {
  it('the arrangement: the first drive fails with its usage, the re-attached drive completes, and its first request carries the copy', async () => {
    const record = (await h.home.runStore.get(runId)).record;
    const request = record.evidence[0]?.diagnostics?.cache?.requests[0];
    // (a) red when a drive does not end as arranged, the failure keeps no usage, or the copy is not
    //     made (the other cells would then check fewer places); (b) prints the exit codes and counts.
    expect({
      drives,
      exportCode,
      failures: record.drive_failures?.entries.length,
      failureUsage: record.drive_failures?.entries[0]?.usage?.length,
      requests: record.evidence[0]?.diagnostics?.cache?.requests.length,
      referenceFrom: request?.reference?.from,
    }).toEqual({
      drives: { first: 1, second: 0 },
      exportCode: 0,
      failures: 1,
      failureUsage: 1,
      requests: 1,
      referenceFrom: 'run',
    });
  });

  it("realm run export: the module's text is checked in the request, in its copy and in the failed drive's usage, and counted once per place", () => {
    const bundle = JSON.parse(exported) as {
      run: RunRecord;
      disclosure: { hidden: { declared: number; environment: number; pattern: number } };
    };
    const request = bundle.run.evidence[0]?.diagnostics?.cache?.requests[0];
    const failed = bundle.run.drive_failures?.entries[0]?.usage?.[0];
    // (a) red when `cache_requested`'s row is `fact` (the declared fake whole in three places, 0
    //     declared counted) or `endpoint`'s is (the password whole, 0 by pattern); (b) prints the
    //     receipt's counts, each place's kinds and how often each fake shows in the file.
    expect({
      hidden: bundle.disclosure.hidden,
      request: kindsOf(request),
      reference: kindsOf(request?.reference as Partial<UsageRecord> | undefined),
      failedDrive: kindsOf(failed),
      shown: shown(exported),
    }).toEqual({
      hidden: { declared: 3, environment: 0, pattern: 3 },
      request: { cache_requested: 'hidden', endpoint: 'password hidden' },
      reference: { cache_requested: 'hidden', endpoint: 'password hidden' },
      failedDrive: { cache_requested: 'hidden', endpoint: 'password hidden' },
      // Checked is not hidden: a text that matches no declared value and no pattern stays, in the
      // request and in the failed drive's usage (the copy holds neither field).
      shown: { declared: 0, endpointToken: 0, source: 2, by: 2 },
    });
  });

  it("get_run_state: the failed drive's usage is checked and counted", () => {
    const state = JSON.parse(mcpText) as {
      drive_failures?: { entries: Array<{ usage?: Partial<UsageRecord>[] }> };
      disclosure?: { hidden?: { declared: number; environment: number; pattern: number } };
    };
    // (a) red when `cache_requested`'s or `endpoint`'s row is `fact` (the fake whole, its count 0);
    //     (b) prints the reply's counts, the usage's kinds and how often each fake shows in it.
    expect({
      hidden: state.disclosure?.hidden,
      usage: kindsOf(state.drive_failures?.entries[0]?.usage?.[0]),
      shown: { declared: shown(mcpText).declared, endpointToken: shown(mcpText).endpointToken },
    }).toEqual({
      hidden: { declared: 1, environment: 0, pattern: 1 },
      usage: { cache_requested: 'hidden', endpoint: 'password hidden' },
      shown: { declared: 0, endpointToken: 0 },
    });
  });

  it("a module that declares a provider name: every request and the failure record read the drive's word", async () => {
    const record = (await h.home.runStore.get(runId)).record;
    const request = record.evidence[0]?.diagnostics?.cache?.requests[0];
    const failure = record.drive_failures?.entries[0];
    // (a) red when the module's declared `providerId` wins over the drive's word (`anthropic`
    //     everywhere); (b) prints the four stored words (Realm's or the module's fixed name).
    expect({
      request: request?.provider,
      reference: request?.reference?.provider,
      failure: failure?.provider,
      failureUsage: failure?.usage?.[0]?.provider,
    }).toEqual({
      request: 'module:m.mjs',
      reference: 'module:m.mjs',
      failure: 'module:m.mjs',
      failureUsage: 'module:m.mjs',
    });
  });
});
