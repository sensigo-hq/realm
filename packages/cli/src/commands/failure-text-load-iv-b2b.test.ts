// failure-text-load-iv-b2b.test.ts — gap 2, unit (iv-b2b): the failure-text setting when a workflow's
// code fails to load on `realm mcp`.
//
// A workflow's code module can throw while the server loads it: code that reads a missing setting at
// import, a factory in `realm.yaml` that throws, a getter on its export. The loader's message quotes
// what the code threw, and that text can carry data (a card number, a tenant). Every tool whose call
// loads the code replies with it in `errors[0]`, and `get_run_state` repeats it in its load warning
// and in each price's `not_priced[].detail`. Under `--failure-text hidden` the server shows its length
// in its place; the code, the action and the hint stay. A sentence Realm wrote about the project (an
// invalid manifest, a missing `use:`, a manifest outside the deployment root) is Realm's and stays.
// The cells register a real project with `realm workflow register`, then change its code so it throws,
// as a deploy that breaks it does, and call the tools of the built `realm mcp` over stdio. Every
// assertion carries (a) the change that turns it red and (b) what it prints: replies' fields, never
// an environment.
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { RunRecord } from '@sensigo/realm';
import { makeTempHome, type TempHome } from '../test-support/temp-home.js';

const CLI = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

/** (a) red when the page no longer holds the sentence word for word; (b) prints the sentence. */
function claim(page: string, sentence: string): void {
  const flat = (t: string): string => t.replace(/\s+/g, ' ');
  expect(
    flat(readFileSync(join(ROOT, page), 'utf8')),
    `${page} no longer says: ${sentence}`,
  ).toContain(flat(sentence));
}

/** A fake string no masking pattern catches (an email would be masked by pattern under shown too). */
const WORDS = 'Config for card 4111-1111-1111-1111 missing';
const CARD = '4111-1111-1111-1111';
const shape = (n: number): string => `‹string, ${n} character${n === 1 ? '' : 's'}›`;

const homes: TempHome[] = [];
const closers: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const close of closers.splice(0)) await close();
  for (const h of homes.splice(0).reverse()) await h.cleanup();
});

/** How the project's code fails once it is registered: a module that throws at import, the same as
 *  TypeScript (through `jiti`), a `realm.yaml` factory that throws, a getter on the export that
 *  throws; or a sentence Realm writes about the project: `realm.yaml` not valid YAML, an entry with no
 *  `use:`, a `realm.yaml` beside the workflow below its deployment root. */
type Form = 'import' | 'ts' | 'factory' | 'getter' | 'manifest-yaml' | 'manifest-use' | 'orphan';

/** A stand-in for `jiti` v2 (the loader's TypeScript bridge): runs the module's source as JavaScript. */
const JITI_STUB = `import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
export function createJiti() {
  return {
    async import(path) {
      const js = path + '.' + Date.now() + '.stub.mjs';
      writeFileSync(js, readFileSync(path));
      return await import(pathToFileURL(js).href);
    },
  };
}
`;
const THROWS = `throw new Error(${JSON.stringify(WORDS)});\n`;
const HANDLER_FACTORY =
  'export function make(ctx) { return { id: ctx.id, async execute() { return { output: {}, warnings: [] }; } }; }\n';

interface Project {
  env: Record<string, string>;
  h: TempHome;
  workflowId: string;
  runId: string;
}

/** A project registered from its folder while its code loads, then changed as `form` says; a run of
 *  its workflow created in the same home. */
async function project(form: Form): Promise<Project> {
  const h = await makeTempHome();
  homes.push(h);
  const root = mkdtempSync(join(tmpdir(), `realm-ivb2b-${form}-`));
  // The orphaned manifest needs a deployment root above the workflow's folder.
  const dir = form === 'orphan' ? join(root, 'wf') : root;
  if (form === 'orphan') {
    mkdirSync(dir);
    writeFileSync(join(root, 'package.json'), '{}\n');
  }
  const workflowId = `ivb2b-${form}`;
  const module = form === 'ts' ? './registry.ts' : './registry.mjs';
  writeFileSync(
    join(dir, 'workflow.yaml'),
    [
      `id: ${workflowId}`,
      `name: ${workflowId}`,
      'version: 1',
      ...(form === 'factory' ? [] : [`extensions: ${module}`]),
      'steps:',
      '  a:',
      '    description: A.',
      '    execution: agent',
      '',
    ].join('\n'),
  );
  const good = 'export default { handlers: {} };\n';
  if (form === 'ts') {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
    mkdirSync(join(dir, 'node_modules', 'jiti'), { recursive: true });
    writeFileSync(
      join(dir, 'node_modules', 'jiti', 'package.json'),
      JSON.stringify({ name: 'jiti', version: '2.9.9-stub', type: 'module', main: 'index.js' }),
    );
    writeFileSync(join(dir, 'node_modules', 'jiti', 'index.js'), JITI_STUB);
    writeFileSync(join(dir, 'registry.ts'), good);
  } else if (form === 'factory') {
    writeFileSync(
      join(dir, 'realm.yaml'),
      'version: 1\nhandlers:\n  h1:\n    use: ./factory.mjs#make\n',
    );
    writeFileSync(join(dir, 'factory.mjs'), HANDLER_FACTORY);
  } else {
    writeFileSync(join(dir, 'registry.mjs'), good);
  }
  const env = { PATH: process.env['PATH'] ?? '', HOME: h.root! };
  const registered = spawnSync(
    process.execPath,
    [CLI, 'workflow', 'register', join(dir, 'workflow.yaml')],
    { env, encoding: 'utf8', timeout: 60_000 },
  );
  if (registered.status !== 0) {
    throw new Error(`fixture ${form}: register exited ${registered.status}: ${registered.stderr}`);
  }
  // The change after registering, as a deploy makes it.
  if (form === 'import') writeFileSync(join(dir, 'registry.mjs'), THROWS);
  if (form === 'ts') writeFileSync(join(dir, 'registry.ts'), THROWS);
  if (form === 'factory')
    writeFileSync(join(dir, 'factory.mjs'), `export function make() { ${THROWS}}\n`);
  if (form === 'getter') {
    writeFileSync(join(dir, 'registry.mjs'), `export default { get handlers() { ${THROWS}} };\n`);
  }
  if (form === 'manifest-yaml') writeFileSync(join(dir, 'realm.yaml'), 'version: [1\n');
  if (form === 'manifest-use')
    writeFileSync(join(dir, 'realm.yaml'), 'version: 1\nhandlers:\n  h1:\n    config: {}\n');
  if (form === 'orphan') writeFileSync(join(dir, 'realm.yaml'), 'version: 1\n');
  const { record } = await h.home.runStore.create({ workflowId, workflowVersion: 1, params: {} });
  return { env, h, workflowId, runId: record.id };
}

type Reply = Record<string, unknown> & {
  errors?: string[];
  error_code?: string;
  agent_action?: string;
  context_hint?: string;
  warnings?: string[];
  disclosure?: Record<string, unknown>;
};
type Call = (
  name: string,
  args: Record<string, unknown>,
) => Promise<{ text: string; reply: Reply }>;

/** `realm mcp` with `args` over stdio, on the project's home; `forms` declares a client that shows
 *  forms (so `present_question` is listed under `asked`). */
async function session(p: Project, args: string[], forms = false): Promise<Call> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, 'mcp', ...args],
    env: p.env,
    stderr: 'pipe',
  });
  const client = new Client(
    { name: 'failure-text-load-iv-b2b', version: '0' },
    forms ? { capabilities: { elicitation: {} } } : undefined,
  );
  await client.connect(transport);
  closers.push(() => client.close());
  return async (name, toolArgs) => {
    const raw = (await client.callTool({ name, arguments: toolArgs })) as {
      content: Array<{ text?: string }>;
    };
    const text = raw.content[0]?.text ?? '{}';
    return { text, reply: JSON.parse(text) as Reply };
  };
}

/** The three settings: `--failure-text hidden`, `shown`, and none. */
const SETTINGS = [['--failure-text', 'hidden'], ['--failure-text', 'shown'], []] as const;

/** A reply's text without what only the read's own time sets (`as_of`, `idle_ms`). */
const steady = (text: string): string =>
  JSON.stringify(JSON.parse(text), (key: string, value: unknown) =>
    key === 'as_of' || key === 'idle_ms' ? undefined : value,
  );

const receiptOf = (r: Reply) => (r.disclosure ?? {}) as Record<string, unknown>;

/** What a hidden reply to a failed load must show, judged against the shown reply of the same call. */
function hiddenLoadError(hidden: { text: string; reply: Reply }, shown: { reply: Reply }) {
  return {
    actual: {
      words: hidden.text.includes(CARD),
      error: hidden.reply.errors?.[0],
      code: hidden.reply.error_code,
      action: hidden.reply.agent_action,
      hint: hidden.reply.context_hint,
      word: receiptOf(hidden.reply)['failure_text'],
      paths: receiptOf(hidden.reply)['shaped'],
    },
    expected: {
      words: false,
      error: shape(shown.reply.errors?.[0]?.length ?? -1),
      code: shown.reply.error_code,
      action: shown.reply.agent_action,
      hint: shown.reply.context_hint,
      word: 'withheld',
      paths: ['errors'],
    },
  };
}

describe('gap 2 (iv-b2b), checks 1 and 6 — the load error, per tool', () => {
  let p: Project;
  // Per setting: a session under `permitted` (the five tools) and one under `asked` with forms.
  const calls: Array<{ permitted: Call; asked: Call }> = [];
  beforeAll(async () => {
    p = await project('import');
    for (const setting of SETTINGS) {
      calls.push({
        permitted: await session(p, [...setting, '--gate-answers', 'permitted']),
        asked: await session(p, [...setting], true),
      });
    }
  }, 180_000);

  const TOOLS: Array<[string, 'permitted' | 'asked', (p: Project) => Record<string, unknown>]> = [
    ['start_run', 'permitted', (p) => ({ workflow_id: p.workflowId })],
    [
      'start_run_batch',
      'permitted',
      (p) => ({ workflow_id: p.workflowId, items: [{ params: {} }] }),
    ],
    ['execute_step', 'permitted', (p) => ({ run_id: p.runId, command: 'a', params: {} })],
    ['advance_run', 'permitted', (p) => ({ run_id: p.runId })],
    [
      'submit_human_response',
      'permitted',
      (p) => ({ run_id: p.runId, gate_id: 'g1', choice: 'yes' }),
    ],
    ['present_question', 'asked', (p) => ({ run_id: p.runId, gate_id: 'g1' })],
  ];
  it.each(TOOLS)(
    '%s: errors[0] its shape; the code, the action and the hint as under shown; shown equals no setting',
    async (tool, door, args) => {
      const [hidden, shown, unset] = await Promise.all(calls.map((c) => c[door](tool, args(p))));
      const judged = hiddenLoadError(hidden!, shown!);
      // (a) red when the loader does not mark its import throw, or the tool's catch drops the mark
      //     on the WorkflowError it builds; (b) prints the hidden reply's fields beside shown's.
      expect(judged.actual).toEqual(judged.expected);
      // (a) red when the call does not reach the load (the cell would compare two refusals), or
      //     shown shapes too; (b) prints shown's first error and whether shown equals no setting.
      expect({
        loader: shown!.reply.errors?.[0]?.startsWith("Failed to import module './registry.mjs'"),
        words: shown!.reply.errors?.[0]?.endsWith(`: ${WORDS}`),
        same: steady(shown!.text) === steady(unset!.text),
      }).toEqual({ loader: true, words: true, same: true });
    },
  );
});

describe('gap 2 (iv-b2b), check 1 — the other forms that carry the code’s words, on start_run', () => {
  const FORMS: Array<[Form, string]> = [
    ['ts', "Failed to import TypeScript module './registry.ts' via jiti: "],
    ['factory', 'constructing handlers.h1 (use: ./factory.mjs#make) failed: '],
    ['getter', "reading 'handlers' threw: "],
  ];
  it.each(FORMS)(
    '%s: errors[0] its shape under hidden',
    async (form, loaderWords) => {
      const p = await project(form);
      const [hidden, shown] = await Promise.all(
        SETTINGS.slice(0, 2).map(async (s) =>
          (await session(p, [...s]))('start_run', { workflow_id: p.workflowId }),
        ),
      );
      const judged = hiddenLoadError(hidden!, shown!);
      // (a) red when this form's throw is not marked by the loader; (b) prints the hidden fields.
      expect(judged.actual).toEqual(judged.expected);
      // (a) red when the fixture fails some other way than this form; (b) prints shown's first error.
      expect(shown!.reply.errors?.[0]).toContain(`${loaderWords}${WORDS}`);
    },
    120_000,
  );
});

/** One model request; on a step and on a failed drive. */
const REQUEST = {
  request_index: 0,
  request_start: '2026-11-22T00:00:00.000Z',
  model: 'claude-x-20260101',
  prompt_tokens: 100,
  output_tokens: 1,
};

/** A run of the project's workflow with a step that made a model call and a drive that failed once,
 *  written as given (the store's `save`). */
async function pricedRun(p: Project, phase: 'running' | 'completed'): Promise<string> {
  const id = randomUUID();
  const priced = {
    id,
    workflow_id: p.workflowId,
    workflow_version: 1,
    params: {},
    version: 1,
    in_progress_steps: [],
    failed_steps: [],
    skipped_steps: [],
    created_at: '2026-11-22T00:00:00.000Z',
    updated_at: '2026-11-22T00:00:01.000Z',
    run_phase: phase,
    terminal_state: phase === 'completed',
    completed_steps: phase === 'completed' ? ['a'] : [],
    evidence: [
      {
        step_id: 'a',
        kind: 'execution',
        status: 'success',
        started_at: '2026-11-22T00:00:00.000Z',
        completed_at: '2026-11-22T00:00:01.000Z',
        duration_ms: 1,
        input_summary: {},
        output_summary: {},
        evidence_hash: `ivb2b-${phase}`,
        diagnostics: {
          input_token_estimate: 1,
          precondition_trace: [],
          cache: { state: 'engaged', basis: 'provider_reported', requests: [REQUEST] },
        },
      },
    ],
    drive_failures: {
      first_failed_at: '2026-11-22T00:00:02.000Z',
      total: 1,
      entries: [
        {
          at: '2026-11-22T00:00:02.000Z',
          step: 'a',
          provider: 'anthropic',
          error_class: 'other',
          message: 'connection reset',
          elapsed_ms: 1,
          usage: [REQUEST],
        },
      ],
    },
  } as unknown as RunRecord;
  await (p.h.home.runStore as unknown as { save(r: RunRecord): Promise<unknown> }).save(priced);
  return id;
}

/** Every `not_priced` entry in `node`, at any depth, in document order. */
function notPricedOf(node: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(node)) return node.flatMap(notPricedOf);
  if (typeof node !== 'object' || node === null) return [];
  return Object.entries(node).flatMap(([key, child]) =>
    key === 'not_priced' && Array.isArray(child)
      ? (child as Array<Record<string, unknown>>)
      : notPricedOf(child),
  );
}

describe('gap 2 (iv-b2b), checks 3 and 6 — not_priced[].detail when the code fails to load', () => {
  // The receipt's paths in the walk's order; the failed drive's own message and the reason quoting it
  // are (iv-b1)'s; a live run also carries the load warning (a run that ended reads no registry).
  const PHASES: Array<['running' | 'completed', string[]]> = [
    [
      'running',
      [
        'drive_failures.entries[0].message',
        'run_health[0].reason',
        'steps',
        'drive_failure_costs[0].cost',
        'run_cost.total.not_priced[0].detail',
        'warnings',
      ],
    ],
    [
      'completed',
      [
        'drive_failures.entries[0].message',
        'steps',
        'drive_failure_costs[0].cost',
        'run_cost.total.not_priced[0].detail',
      ],
    ],
  ];
  it.each(PHASES)(
    'a %s run: every carrier’s detail its shape, cause and count kept, the paths in the receipt',
    async (phase, paths) => {
      const p = await project('import');
      const runId = await pricedRun(p, phase);
      const [hidden, shown, unset] = await Promise.all(
        SETTINGS.map(async (s) =>
          (await session(p, [...s]))('get_run_state', { run_id: runId, include_steps: true }),
        ),
      );
      const shownEntries = notPricedOf(shown!.reply);
      // (a) red when the CLI's price provider does not mark its source, or priceSourceFor hands it
      //     on whole; (b) prints the entries, the receipt's word and its paths (the failed drive's
      //     own message and the reason quoting it are (iv-b1)'s).
      expect({
        words: hidden!.text.includes(CARD),
        entries: notPricedOf(hidden!.reply),
        word: receiptOf(hidden!.reply)['failure_text'],
        paths: receiptOf(hidden!.reply)['shaped'],
      }).toEqual({
        words: false,
        entries: shownEntries.map((e) => ({
          ...e,
          detail: shape(String(e['detail']).length),
        })),
        word: 'withheld',
        paths,
      });
      // (a) red when nothing is priced, the detail is not the load error, or shown shapes too;
      //     (b) prints shown's causes, whether each detail quotes the code, and shown vs no setting.
      expect({
        carriers: shownEntries.length >= 3,
        causes: [...new Set(shownEntries.map((e) => e['cause']))],
        quote: shownEntries.every((e) => String(e['detail']).endsWith(`: ${WORDS}`)),
        same: steady(shown!.text) === steady(unset!.text),
      }).toEqual({ carriers: true, causes: ['economics_unreachable'], quote: true, same: true });
    },
    120_000,
  );
});

describe('gap 2 (iv-b2b), checks 4 and 5 — a sentence Realm wrote about the project stays', () => {
  // Each form's own sign that it failed as named. A `realm.yaml` that cannot be read makes the walk
  // withhold every value whatever the setting (#729 PR-3, H-7''), so that one is told by its receipt.
  const OWN: Array<[Form, string | undefined]> = [
    ['manifest-yaml', undefined],
    ['manifest-use', 'Deployment manifest '],
    ['orphan', 'will NOT be loaded'],
  ];
  it.each(OWN)(
    '%s: start_run and the load warning byte for byte under hidden, no receipt word',
    async (form, sentence) => {
      const p = await project(form);
      const [hidden, shown] = await Promise.all(
        SETTINGS.slice(0, 2).map(async (s) => {
          const call = await session(p, [...s]);
          return {
            start: await call('start_run', { workflow_id: p.workflowId }),
            state: await call('get_run_state', { run_id: p.runId }),
          };
        }),
      );
      const warningOf = (r: Reply) =>
        (r.warnings ?? []).find((x) => x.startsWith('this server could not load the project code'));
      // (a) red when every plain throw of Realm's own providers is marked, or the warning shapes
      //     every throw; (b) prints the first error, the warning and the receipts' words.
      expect({
        start: hidden!.start.text === shown!.start.text,
        warning: warningOf(hidden!.state.reply) === warningOf(shown!.state.reply),
        words: [
          receiptOf(hidden!.start.reply)['failure_text'],
          receiptOf(hidden!.state.reply)['failure_text'],
        ],
      }).toEqual({ start: true, warning: true, words: [undefined, undefined] });
      // (a) red when the fixture fails some other way; (b) prints the first error and the warning,
      //     or the receipt's cause for the manifest that cannot be read.
      expect(
        sentence === undefined
          ? {
              cause: receiptOf(hidden!.start.reply)['declared_cause'],
              values: receiptOf(hidden!.start.reply)['values'],
            }
          : {
              error: hidden!.start.reply.errors?.[0]?.includes(sentence),
              warning: warningOf(hidden!.state.reply)?.includes(sentence),
            },
      ).toEqual(
        sentence === undefined
          ? { cause: 'load_failed', values: 'withheld' }
          : { error: true, warning: true },
      );
    },
    120_000,
  );
});

describe('gap 2 (iv-b2b), check 8 — the words', () => {
  it('the run-state row, the CHANGELOG sentence and the embed page say what the replies show', () => {
    // Executed by checks 3 and 6 (the detail its shape, cause and count kept), check 1 (errors[0]
    // on every tool) and checks 4 and 5 (Realm's sentences kept); the paragraph itself is pinned
    // whole by (iv-b2a)'s check 8, with this unit's load-error sentence in it.
    claim(
      'docs/reference/mcp/run-state-and-health.md',
      "| `not_priced[].detail` (under `include_steps`) | `‹string, N characters›` when the project's code threw while it was loaded | Its `cause` and `count` |",
    );
    claim(
      'CHANGELOG.md',
      "The error a workflow's code throws while it is loaded is shaped the same way, in every reply's `errors[0]` and in `get_run_state`'s `not_priced[].detail`.",
    );
    claim(
      'docs/reference/library/embed-the-mcp-server.md',
      "which shows an assistant, in `get_run_state` and in the replies to its own calls, the length of a failure's words in place of the words",
    );
  });
});
