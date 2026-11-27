// remember-g3u1a.test.ts — gap 3, unit 1a, on the CLI: check 2 (the `realm agent` door, on the CLI's
// own SQLite home), check 10's CLI half (`realm workflow validate` and `realm run` refuse each
// sentence alike, exact, and `realm run` starts no run) and check 12 (`realm run export` masks a
// declared secret used as a key part exactly as it masks it in the output).
//
// Every assertion carries (a) the change that turns it red and (b) what it prints. Fake values only;
// no model calls (the steps are handler steps).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  buildDisclosureSet,
  createDefaultRegistry,
  executeChain,
  type EvidenceSnapshot,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { runAgent } from '../agent/run-agent.js';
import { LlmProvider } from '../agent/providers/llm-provider.js';
import { buildExportBundle } from './export.js';
import { validateCommand } from './validate.js';
import { runCommand } from './run.js';
import { makeTempHome, runIds, type TempHome } from '../test-support/temp-home.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const SECRET = 'fake-declared-secret-g3u1a-0001';

const def = {
  id: 'g3u1a-cli',
  name: 'g3u1a-cli',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    normalize_email: { description: 'N.', execution: 'auto', handler: 'norm', depends_on: [] },
    record_offer: {
      description: 'R.',
      execution: 'auto',
      handler: 'offer',
      depends_on: ['normalize_email'],
      remember: {
        as: 'offers',
        key: { customer_email: 'context.resources.normalize_email.email' },
        value: { rung: 'context.resources.record_offer.rung' },
        keep_days: 90,
      },
    },
  },
} as unknown as WorkflowDefinition;

function registryOf(email: string) {
  const registry = createDefaultRegistry();
  registry.register('handler', 'norm', {
    id: 'norm',
    execute: async () => ({ data: { email } }),
  } as never);
  registry.register('handler', 'offer', {
    id: 'offer',
    execute: async () => ({ data: { rung: 2 } }),
  } as never);
  return registry;
}
const expiryOf = (e: EvidenceSnapshot, days: number): string =>
  new Date(Date.parse(e.completed_at) + days * DAY_MS).toISOString();

const homes: TempHome[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const h of homes.splice(0)) await h.cleanup();
});

describe('gap 3 (1a), check 2 — the realm agent door, on the SQLite home', () => {
  it("realm agent drives the handler writer: its entry holds the stamp, as the library's", async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = await makeTempHome();
    homes.push(h);
    await h.home.workflowStore.register(def);
    let runId: string | undefined;
    await runAgent(
      {
        store: h.home.runStore,
        workflowStore: h.home.workflowStore,
        provider: new (class extends LlmProvider {
          async callStep(): Promise<Record<string, unknown>> {
            return {};
          }
        })(),
        registry: registryOf('a@example.test'),
        onRunStarted: (id: string) => {
          runId = id;
        },
      } as never,
      { definition: def, params: {}, pollIntervalMs: 20 } as never,
    );
    const ids = await runIds(h.home.runStore);
    runId ??= ids[0];
    const written = (await h.home.runStore.get(runId!)).record.evidence
      .filter((e) => e.step_id === 'record_offer')
      .at(-1)!;
    // (a) red when the stamp is computed in one door's code instead of the engine; (b) prints it.
    expect({ runs: ids.length, stamp: written.remembered }).toEqual({
      runs: 1,
      stamp: {
        as: 'offers',
        key: { customer_email: 'a@example.test' },
        value: { rung: 2 },
        expires_at: expiryOf(written, 90),
      },
    });
  }, 60_000);
});

describe('gap 3 (1a), check 12 — realm run export masks a key part as it masks the output', () => {
  it('a declared secret used as a key part is masked in remembered.key exactly as in the output', async () => {
    const h = await makeTempHome();
    homes.push(h);
    const store = h.home.runStore;
    const { record: run } = await store.create({
      workflowId: def.id,
      workflowVersion: 1,
      params: {},
    });
    await executeChain(store, def, {
      runId: run.id,
      command: 'normalize_email',
      input: {},
      dispatcher: async () => ({}),
      registry: registryOf(SECRET),
    });
    const set = buildDisclosureSet({
      env: {},
      declared: { CUSTOMER_TOKEN: SECRET },
      declaredState: 'resolved',
      audience: 'file',
    }).set;
    const { bundle } = await buildExportBundle(
      run.id,
      {
        runStore: store,
        failedAttemptStore: { read: async () => ({ records: [], capped: false }) },
        traceBufferStore: { readAllForRun: async () => ({}) },
      },
      new Date(),
      set,
    );
    const entries = bundle.run.evidence;
    const output = entries.find((e) => e.step_id === 'normalize_email')!.output_summary;
    const stamp = entries.find((e) => e.step_id === 'record_offer')!.remembered as {
      key: Record<string, string>;
    };
    // (a) red when `key` is classed a fact (returned as it is); (b) prints the two texts and
    //     whether the file holds the secret.
    expect({
      key: stamp.key['customer_email'],
      output: output['email'],
      leaked: JSON.stringify(bundle).includes(SECRET),
    }).toEqual({ key: '[REDACTED]', output: '[REDACTED]', leaked: false });
  });
});

describe('gap 3 (1a), check 10 (CLI) — validate and realm run refuse each sentence alike', () => {
  let h: TempHome & { readonly root: string };
  let originalHome: string | undefined;
  let dir: string;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    h = await makeTempHome();
    originalHome = process.env['HOME'];
    process.env['HOME'] = h.root;
    dir = mkdtempSync(join(tmpdir(), 'realm-remember-g3u1a-'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('process.exit');
    }) as never);
  });
  afterEach(async () => {
    if (originalHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = originalHome;
    vi.restoreAllMocks();
    await h.cleanup();
    rmSync(dir, { recursive: true, force: true });
  });

  async function exitOf(run: () => Promise<unknown>): Promise<number> {
    try {
      await run();
    } catch (err) {
      if (!(err instanceof Error) || err.message !== 'process.exit') throw err;
    }
    const call = exitSpy.mock.calls.at(-1);
    return call === undefined ? 0 : Number(call[0] ?? 0);
  }
  const printed = (): string =>
    errSpy.mock.calls.map((c: unknown[]) => c.map(String).join(' ')).join('\n');

  /** Step `s` of `kind` with `remember` as written; the line `remember:` sits on. */
  function file(remember: string, kind: string, extra: string[]): { path: string; line: number } {
    const head = [
      'id: g3u1a-load',
      'name: G3U1A load',
      'version: 1',
      'steps:',
      '  c:',
      '    description: c',
      '    execution: auto',
      '    handler: h',
      '  s:',
      '    description: d',
      `    execution: ${kind}`,
      ...extra,
    ];
    const text = [...head, ...remember.split('\n').map((l) => `    ${l}`)].join('\n') + '\n';
    const path = join(dir, 'workflow.yaml');
    writeFileSync(path, text, 'utf8');
    return { path, line: head.length + 1 };
  }

  const KEY = 'key: { email: context.resources.c.email }';
  const HANDLER = ['    handler: h'];
  const GUARD = ["    abort_unless: 'c.ok == true'"];
  const FINALIZER = ['    handler: tidy', '    on_outcome: always'];
  const SENTENCES: Array<[string, string, string, string[]]> = [
    ['Words 1 (guard)', `remember:\n  as: offers\n  ${KEY}\n  keep_days: 90`, 'guard', GUARD],
    [
      'Words 1 (finalizer)',
      `remember:\n  as: offers\n  ${KEY}\n  keep_days: 90`,
      'finalizer',
      FINALIZER,
    ],
    ['Words 2', `remember:\n  as: offers\n  ${KEY}\n  keep_days: 90`, 'auto', []],
    ['Words 3', `remember:\n  as: offers\n  ${KEY}`, 'auto', HANDLER],
    ['Words 4', `remember:\n  as: offers\n  ${KEY}\n  keep_days: 0`, 'auto', HANDLER],
    ['Words 5', `remember:\n  as: 9x\n  ${KEY}\n  keep_days: 90`, 'auto', HANDLER],
    ['Words 6 (key)', 'remember:\n  as: offers\n  key: {}\n  keep_days: 90', 'auto', HANDLER],
    ['Words 6 (needs)', `remember:\n  ${KEY}\n  keep_days: 90`, 'auto', HANDLER],
    ['Words 6 (map)', 'remember: offers', 'auto', HANDLER],
    [
      'Words 6 (value form)',
      `remember:\n  as: offers\n  ${KEY}\n  value: { rung: '' }\n  keep_days: 90`,
      'auto',
      HANDLER,
    ],
    [
      'value not a map',
      `remember:\n  as: offers\n  ${KEY}\n  value: [a]\n  keep_days: 90`,
      'auto',
      HANDLER,
    ],
    ['Words 7', `remember:\n  as: offers\n  ${KEY}\n  keep_days: 90\n  ttl: 1`, 'auto', HANDLER],
    [
      'Words 8',
      `remember:\n  as: offers\n  key: { why: context.resources.$settlement.c.message }\n  keep_days: 90`,
      'auto',
      HANDLER,
    ],
  ];
  const WORDS: Record<string, (line: number) => string> = {
    'Words 1 (guard)': (n) =>
      `Step 's': 'remember' is not valid on execution: guard steps — 'remember' goes on an agent step or an auto step with 'handler' or 'uses_service'. (line ${n})`,
    'Words 1 (finalizer)': (n) =>
      `Step 's': 'remember' is not valid on execution: finalizer steps — 'remember' goes on an agent step or an auto step with 'handler' or 'uses_service'. (line ${n})`,
    'Words 2': (n) =>
      `Step 's': 'remember' needs a step that makes its own output: an agent step, or an auto step with 'handler' or 'uses_service'. A bare auto step's output depends on what drives the run, so its memory would too. (line ${n})`,
    'Words 3': (n) =>
      `Step 's': 'remember' needs 'keep_days': how many days to keep each entry, a whole number from 1 to 3650. (line ${n})`,
    'Words 4': (n) =>
      `Step 's': 'remember.keep_days' is 0; it must be a whole number from 1 to 3650. (line ${n})`,
    'Words 5': (n) =>
      `Step 's': 'remember.as' must be a name of letters, digits and underscores that starts with a letter, at most 64 characters. (line ${n})`,
    'Words 6 (key)': (n) =>
      `Step 's': 'remember.key' must name at least one part, each a path such as context.resources.<step>.<field>. (line ${n})`,
    'Words 6 (needs)': (n) => `Step 's': 'remember' needs 'as'. (line ${n})`,
    'Words 6 (map)': (n) =>
      `Step 's': 'remember' must be a map of as, key, value and keep_days. (line ${n})`,
    'Words 6 (value form)': (n) =>
      `Step 's': remember.value path "rung": source path must be a non-empty string (line ${n})`,
    'value not a map': (n) =>
      `Step 's': 'remember.value' must be a map of names to paths, not a list. (line ${n})`,
    'Words 7': (n) =>
      `Step 's': 'remember' has no 'ttl'. It takes as, key, value and keep_days. (line ${n})`,
    'Words 8': (n) =>
      `Step 's': 'remember' can't read a step's failure message ('context.resources.$settlement.c.message'): a memory outlives the run, and a failure's words can carry anything the failed request echoed back. (line ${n})`,
  };

  for (const [name, remember, kind, extra] of SENTENCES) {
    it(`${name}: refused by validate and by realm run, exact; realm run starts no run`, async () => {
      const { path, line } = file(remember, kind, extra);
      const words = WORDS[name]!(line);
      const validate = await exitOf(() => validateCommand.parseAsync([path], { from: 'user' }));
      const validateSaid = printed().includes(words);
      errSpy.mockClear();
      exitSpy.mockClear();
      const run = await exitOf(() => runCommand.parseAsync([path], { from: 'user' }));
      // (a) red when a load lets the block through, or the words drift; (b) prints each door's
      //     exit, whether it said the words, and what it printed.
      expect({
        validate,
        validateSaid,
        run,
        runSaid: printed().includes(words),
        runs: (await runIds(h.home.runStore)).length,
      }).toEqual({ validate: 1, validateSaid: true, run: 1, runSaid: true, runs: 0 });
    });
  }
});
