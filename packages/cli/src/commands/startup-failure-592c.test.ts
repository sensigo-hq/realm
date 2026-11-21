// startup-failure-592c.test.ts — Q1 (#592) unit c through the BUILT CLI (prompt
// q1-c-startup-death-mark.md): `realm agent --run-id <id>` refused by its own startup checks leaves a
// `startup_failure` mark on the run (checks 1, 2), the surfaces show it (check 4), and the pages say
// so (check 8). The foreign-copy refusal, the third `--provider-module` member, is driven on a real
// two-copy layout (multi-copy.test.ts, row 5); the outcomes the CLI cannot reach (an ended run with
// a working flag set is refused later; a store that refuses) sit at the helper
// (agent/startup-failure-592c.test.ts).
//
// Every cell runs `dist/index.js` with a scratch HOME and working folder and a minimal environment
// (PATH, HOME and only the keys the cell names); every provider address is a closed local port, so a
// red build never sends a request to a real provider. Every command is stopped after 20 s.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  abandonRun,
  executeStep,
  type DriveFailureRecord,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { createRealmMcpServer } from '@sensigo/realm-mcp';
import { makeTempHome, type TempHome } from '../test-support/temp-home.js';

const CLI_ENTRY = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const DOCS = fileURLToPath(new URL('../../../../docs/', import.meta.url));
const CHANGELOG = fileURLToPath(new URL('../../../../CHANGELOG.md', import.meta.url));
const CLOSED_PORT = 'http://127.0.0.1:9';
const WRITTEN = (id: string) =>
  `Run ${id} keeps this failure under Drive failures; realm run list --stuck lists it until the run next records a step or a question, or ends.`;
const UNCHANGED = (id: string) => `If run ${id} exists, it was not changed.`;
const NO_KEY = 'realm agent requires an LLM API key. Set OPENAI_API_KEY or ANTHROPIC_API_KEY.';
const NO_MODEL =
  '--model is required: realm has no default model. ANTHROPIC_API_KEY is set, so the provider is Anthropic; ' +
  'name one of its models (Anthropic lists them at https://platform.claude.com/docs/en/models/overview).';
const NOT_A_PROVIDER =
  'provider module default export must be an instance extending LlmProvider.\n' +
  "Import LlmProvider from '@sensigo/realm-cli/agent' and export 'export default new MyProvider()'.";

/** Two agent steps (the run stays open after the first); the marks are written on its runs. */
const AGENT_DEF: WorkflowDefinition = {
  id: 'q1c-agent',
  name: 'Q1 c agent',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    ask: { description: 'Answer with a short summary.', execution: 'agent', depends_on: [] },
    check: { description: 'Check it.', execution: 'agent', depends_on: ['ask'] },
  },
};
/** No agent step: `--prompt-cache` and `--cache-diagnostics on` would change nothing. */
const PLAIN_DEF: WorkflowDefinition = {
  id: 'q1c-plain',
  name: 'Q1 c plain',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: { note: { description: 'Note it.', execution: 'auto', handler: 'note', depends_on: [] } },
};
const AGENT_YAML = [
  'id: q1c-agent',
  'name: Q1 c agent',
  'version: 1',
  'steps:',
  '  ask:',
  '    description: Answer with a short summary.',
  '    execution: agent',
  '',
].join('\n');

let root: string;
let h: TempHome & { readonly root: string };

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'realm-592c-cli-'));
  h = await makeTempHome();
  mkdirSync(join(root, 'wf'));
  writeFileSync(join(root, 'wf', 'workflow.yaml'), AGENT_YAML, 'utf8');
  writeFileSync(join(root, 'not-a-provider.mjs'), 'export default { hello: 1 };\n', 'utf8');
  await h.home.workflowStore.register(AGENT_DEF);
  await h.home.workflowStore.register(PLAIN_DEF);
});

afterEach(async () => {
  await h.cleanup();
  rmSync(root, { recursive: true, force: true });
});

function env(extra: Record<string, string> = {}): Record<string, string> {
  return { PATH: process.env['PATH'] ?? '', HOME: h.root, ...extra };
}

type Done = { code: number | null; stdout: string; stderr: string; timedOut: boolean };

/** Runs the built CLI to its end. */
function runCli(args: string[], childEnv: Record<string, string>): Promise<Done> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
      cwd: root,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, 20_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

async function newRun(def: WorkflowDefinition = AGENT_DEF): Promise<string> {
  const { record } = await h.home.runStore.create({
    workflowId: def.id,
    workflowVersion: 1,
    params: {},
  });
  return record.id;
}

async function entriesOf(runId: string): Promise<DriveFailureRecord[]> {
  return (await h.home.runStore.get(runId)).record.drive_failures?.entries ?? [];
}

/** An entry with its time and its measured span shown by their kind. */
const shape = (e: DriveFailureRecord | undefined) =>
  e && { ...e, at: typeof e.at, elapsed_ms: e.elapsed_ms > 0 ? '> 0' : e.elapsed_ms };

/** The members of the set: each case's flags (after `--run-id` or `--workflow`), its env, its words. */
const MEMBERS: Array<{
  name: string;
  flags: string[];
  env: Record<string, string>;
  provider: string;
  /** The refusal's words, without `Error: ` and the closing sentence. */
  message: string;
  /** `inline`: the closing sentence ends the refusal's one line; `own`: it is a line of its own. */
  closing: 'inline' | 'own';
}> = [
  { name: 'no key', flags: [], env: {}, provider: 'unknown', message: NO_KEY, closing: 'inline' },
  {
    name: 'no --model',
    flags: [],
    env: { ANTHROPIC_API_KEY: 'k-592c', ANTHROPIC_BASE_URL: CLOSED_PORT },
    provider: 'unknown',
    message: NO_MODEL,
    closing: 'inline',
  },
  {
    name: '--base-url with --provider anthropic',
    flags: ['--provider', 'anthropic', '--model', 'm-592c', '--base-url', CLOSED_PORT],
    env: { ANTHROPIC_API_KEY: 'k-592c' },
    provider: 'anthropic',
    message: '',
    closing: 'inline',
  },
  {
    name: 'a provider module that does not import',
    flags: ['--provider-module', './none-592c.mjs'],
    env: {},
    provider: 'unknown',
    message: '',
    closing: 'own',
  },
  {
    name: 'a provider module whose default export is not an LlmProvider',
    flags: ['--provider-module', './not-a-provider.mjs'],
    env: {},
    provider: 'unknown',
    message: NOT_A_PROVIDER,
    closing: 'own',
  },
];

describe('Q1 (#592) unit c — check 1: each member of the set marks the run', () => {
  for (const m of MEMBERS) {
    it(`${m.name}: one startup_failure entry; the message unchanged; exit 1; the written sentence last`, async () => {
      // The same refusal with --workflow: no run, so it ends as it always has (or with nothing).
      const before = await runCli(
        ['agent', '--workflow', join('wf', 'workflow.yaml'), ...m.flags],
        env(m.env),
      );
      const runId = await newRun();
      const r = await runCli(['agent', '--run-id', runId, ...m.flags], env(m.env));
      const [entry, second] = await entriesOf(runId);
      const message =
        m.message !== ''
          ? m.message
          : before.stderr
              .trim()
              .replace(/^Error: /, '')
              .replace(/ Nothing was started\.$/, '');
      // The refusal's text before the closing sentence is --workflow's, byte for byte.
      const expected =
        m.closing === 'inline'
          ? before.stderr.replace(/Nothing was started\.\n$/, `${WRITTEN(runId)}\n`)
          : `${before.stderr}${WRITTEN(runId)}\n`;
      // (a) red when this refusal does not mark the run (no entry; the old closing sentence), marks
      //     it twice, writes another shape (a step, another class or provider, no model_text, a time
      //     of 0), or changes the message before the closing sentence; (b) prints the output and the
      //     entry.
      expect({
        code: r.code,
        stderr: r.stderr,
        entry: shape(entry),
        second,
      }).toEqual({
        code: 1,
        stderr: expected,
        entry: {
          at: 'string',
          step: '',
          provider: m.provider,
          error_class: 'startup_failure',
          message,
          elapsed_ms: '> 0',
          evidence_count: 0,
          model_text: { recorded: true, messages: [], tools: [], requests: [] },
        },
        second: undefined,
      });
      // --workflow ends as it always has: `Nothing was started.` (inline) or nothing (own), and the
      // closing sentence is the --run-id output's last line.
      expect([
        before.code,
        before.stderr.includes('keeps this failure'),
        r.stderr.trimEnd().endsWith(WRITTEN(runId)),
      ]).toEqual([1, false, true]);
    }, 60_000);
  }

  it('--no-record-model-text: the entry keeps no model text (switched_off)', async () => {
    const runId = await newRun();
    const r = await runCli(['agent', '--run-id', runId, '--no-record-model-text'], env());
    const [entry] = await entriesOf(runId);
    // (a) red when the switch is not passed to the mark; (b) prints the exit and the model text.
    expect([r.code, entry?.model_text]).toEqual([1, { recorded: false, why: 'switched_off' }]);
  }, 60_000);
});

describe('Q1 (#592) unit c — check 2: no refusal outside the set marks the run', () => {
  const KEYED = { ANTHROPIC_API_KEY: 'k-592c', ANTHROPIC_BASE_URL: CLOSED_PORT };
  const cases: Array<{
    name: string;
    def: WorkflowDefinition;
    flags: string[];
    env: Record<string, string>;
    stderr: (id: string) => string;
  }> = [
    {
      name: '--provider-module with --model (flag usage)',
      def: AGENT_DEF,
      flags: ['--provider-module', './not-a-provider.mjs', '--model', 'm-592c'],
      env: {},
      stderr: () =>
        'Error: --provider-module cannot be combined with --provider, --model, --base-url, --strict-base-url, --prompt-cache, or --cache-diagnostics on\n',
    },
    {
      name: '--prompt-cache on a workflow with no agent step',
      def: PLAIN_DEF,
      flags: ['--model', 'm-592c', '--prompt-cache', 'short'],
      env: KEYED,
      stderr: (id) =>
        `Error: --prompt-cache has nothing to apply to: workflow 'q1c-plain' has no agent step, so the flag would change nothing. Remove --prompt-cache. ${UNCHANGED(id)}\n`,
    },
    {
      name: '--cache-diagnostics on with another provider',
      def: AGENT_DEF,
      flags: ['--provider', 'openai', '--model', 'm-592c', '--cache-diagnostics', 'on'],
      env: { OPENAI_API_KEY: 'k-592c', OPENAI_BASE_URL: CLOSED_PORT },
      stderr: (id) =>
        `Error: --cache-diagnostics on has nothing to act on: only Anthropic answers this question, and this drive uses openai. Remove --cache-diagnostics, or use --provider anthropic. ${UNCHANGED(id)}\n`,
    },
    {
      name: '--cache-diagnostics on with --prompt-cache off',
      def: AGENT_DEF,
      flags: ['--model', 'm-592c', '--cache-diagnostics', 'on', '--prompt-cache', 'off'],
      env: KEYED,
      stderr: (id) =>
        `Error: --cache-diagnostics on has nothing to act on: --prompt-cache off asks for no caching, so no request can miss. Remove --cache-diagnostics, or choose another --prompt-cache. ${UNCHANGED(id)}\n`,
    },
    {
      name: '--cache-diagnostics on with ANTHROPIC_BASE_URL set',
      def: AGENT_DEF,
      flags: ['--model', 'm-592c', '--cache-diagnostics', 'on'],
      env: KEYED,
      stderr: (id) =>
        `Error: --cache-diagnostics on has nothing to act on: only Anthropic's own address answers this question, and ANTHROPIC_BASE_URL points elsewhere. Remove --cache-diagnostics, or unset ANTHROPIC_BASE_URL. ${UNCHANGED(id)}\n`,
    },
    {
      name: '--cache-diagnostics on on a workflow with no agent step',
      def: PLAIN_DEF,
      flags: ['--model', 'm-592c', '--cache-diagnostics', 'on'],
      env: { ANTHROPIC_API_KEY: 'k-592c' },
      stderr: (id) =>
        `Error: --cache-diagnostics on has nothing to act on: workflow 'q1c-plain' has no agent step, so the flag would change nothing. Remove --cache-diagnostics. ${UNCHANGED(id)}\n`,
    },
  ];
  for (const c of cases) {
    it(`${c.name}: no entry; the refusal as today`, async () => {
      const runId = await newRun(c.def);
      const r = await runCli(['agent', '--run-id', runId, ...c.flags], env(c.env));
      // (a) red when a flag-usage or inert-flag refusal marks the run, or its words change; (b)
      //     prints the exit, the output and the ring.
      expect({ code: r.code, stderr: r.stderr, ring: await entriesOf(runId) }).toEqual({
        code: 1,
        stderr: c.stderr(runId),
        ring: [],
      });
    }, 60_000);
  }

  it('an ended run: refused as today, with no outcome sentence', async () => {
    const runId = await newRun();
    await abandonRun(h.home.runStore, runId);
    const r = await runCli(['agent', '--run-id', runId, '--model', 'm-592c'], env(KEYED));
    // (a) red when the ended-run refusal gains an outcome sentence (or is marked); (b) prints the
    //     exit and the output.
    expect({
      code: r.code,
      first: r.stderr.split('\n')[0],
      outcome: /nothing was recorded|keeps this failure|could not be updated/.test(r.stderr),
      ring: await entriesOf(runId),
    }).toEqual({
      code: 1,
      first: `Error: Run ${runId} has already ended (abandoned). It was abandoned; no reason was given.`,
      outcome: false,
      ring: [],
    });
  }, 60_000);
});

describe('Q1 (#592) unit c — check 4: the surfaces show the mark, until the run next records a step', () => {
  it('list --stuck: a bare drive_failing(startup_failure); inspect: the line with no step; get_run_state: the entry and the finding; all gone after the next evidence entry', async () => {
    const runId = await newRun();
    await runCli(['agent', '--run-id', runId], env({ ANTHROPIC_API_KEY: 'k-592c' }));
    const [entry] = await entriesOf(runId);
    const stuck = await runCli(['run', 'list', '--stuck'], env());
    const stuckLine = stuck.stdout.split('\n').find((l) => l.startsWith(runId));
    const inspect = await runCli(['run', 'inspect', runId], env());
    const lines = inspect.stdout.split('\n');
    const at = lines.indexOf('Drive failures:');
    const server = createRealmMcpServer({
      runStore: h.home.runStore,
      traceBufferStore: h.home.traceBufferStore,
      failedAttemptStore: h.home.failedAttemptStore,
      workflowStore: h.home.workflowStore,
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'q1c', version: '0' });
    await Promise.all([server.connect(st), client.connect(ct)]);
    const state = async () => {
      const raw = (await client.callTool({
        name: 'get_run_state',
        arguments: { run_id: runId },
      })) as {
        content: Array<{ text: string }>;
      };
      return JSON.parse(raw.content[0]!.text) as {
        drive_failures?: { entries: DriveFailureRecord[] };
        run_health?: Array<{ kind: string; step?: string; evidence?: { basis?: unknown } }>;
      };
    };
    const before = await state();
    const finding = before.run_health?.find((f) => f.kind === 'drive_failing');
    // (a) red when list prints `=drive_failing` (a step) or no finding, inspect prints a step or
    //     another line, or get_run_state leaves out the entry or the finding (or gives it a basis);
    //     (b) prints the lines and the reply's parts.
    expect({
      stuckEnd: stuckLine?.slice(stuckLine.lastIndexOf('  ') + 2),
      stuckHasStep: stuckLine?.includes('=drive_failing'),
      inspect: lines.slice(at, at + 2),
      entries: before.drive_failures?.entries.map((e) => [e.step, e.error_class]),
      finding: finding && { step: finding.step, basis: finding.evidence?.basis },
    }).toEqual({
      stuckEnd: 'drive_failing(startup_failure)',
      stuckHasStep: false,
      inspect: [
        'Drive failures:',
        `  ${entry!.at}    unknown  startup_failure after ${entry!.elapsed_ms}ms: ${entry!.message}`,
      ],
      entries: [['', 'startup_failure']],
      finding: { step: '', basis: undefined },
    });
    // The run's next evidence entry (the step's answer recorded) clears the finding everywhere.
    await executeStep(h.home.runStore, AGENT_DEF, {
      runId,
      command: 'ask',
      input: { summary: 'done' },
      dispatcher: async (_s, input) => input,
    });
    const afterStuck = await runCli(['run', 'list', '--stuck'], env());
    const after = await state();
    await client.close();
    // (a) red when drive_failing outlives the next evidence entry; (b) prints the listing and the
    //     findings.
    // The run is still open (its second step is next) and has no finding left: the reply leaves out an
    // empty run_health.
    expect({
      listed: afterStuck.stdout.includes('drive_failing(startup_failure)'),
      phase: (after as { run_phase?: string }).run_phase,
      health: after.run_health,
    }).toEqual({ listed: false, phase: 'running', health: undefined });
  }, 90_000);
});

describe('Q1 (#592) unit c — check 8: the pages say it', () => {
  const read = (p: string): string => readFileSync(p.startsWith('/') ? p : join(DOCS, p), 'utf8');
  const claim = (p: string, words: string): void => {
    // (a) red when the page no longer carries these words; (b) prints the page and the words.
    expect(read(p).includes(words), `${p} no longer says: ${words}`).toBe(true);
  };
  const W =
    '`Run <run-id> keeps this failure under Drive failures; realm run list --stuck lists it until the run next records a step or a question, or ends.`';

  it('realm-agent.md: the section, the four endings, the module refusals, the cases Realm cannot record', () => {
    const p = 'reference/cli/realm-agent.md';
    claim(p, '## A startup death leaves a mark');
    claim(
      p,
      'When `realm agent --run-id <id>` is refused by its own startup checks — no key for the provider, no model, `--base-url` with Anthropic, a provider module that does not load — it records the refusal on the run as a drive failure of kind `startup_failure` before it exits, so `realm run list --stuck` lists the run and `realm run inspect` shows it under `Drive failures` (added after version 0.50.0).',
    );
    claim(p, `- ${W}\n`);
    claim(p, '- `Run <run-id> had already ended; nothing was recorded.`\n');
    claim(
      p,
      '- `Run <run-id> is not in the store; nothing was recorded.` A mistyped run id gets this one.\n',
    );
    claim(
      p,
      '- `Run <run-id> could not be updated; the failure was not recorded.` The line `⚠ drive-failure record LOST for run <run-id> …`, printed before the refusal, says what was lost.\n',
    );
    claim(
      p,
      'The refusals about a provider module that cannot be loaded, one from another realm-cli version, and one whose default export is not an `LlmProvider` end the same way after `--run-id`, with that sentence on a line of its own (added after version 0.50.0).',
    );
    claim(
      p,
      'A refusal like this on a run that another process is driving is recorded on that run too: it shows `drive_failing(startup_failure)` until that drive next records a step or a question.',
    );
    claim(
      p,
      '- A refusal before the store is open: `--workflow` with `--run-id`, `--params` with `--run-id`, a `REALM_OPERATOR` Realm cannot use, and a flag value the command line refuses, such as `--schema-retries x`.',
    );
    claim(p, '- A `--workflow` run that is refused: there is no run yet.');
    claim(p, '- A store that cannot be opened.');
    claim(
      p,
      '- A refusal of how the flags are used, which is not a death: `--provider-module` with `--provider`, `--model` or another of its flags, and the refusals of `--prompt-cache` and `--cache-diagnostics on` when they would change nothing.',
    );
    claim(
      p,
      '- Outside `realm listen`, when the output goes to a file or a pipe: the first process failing to start the second one, which drives, and a `SIGKILL` of the second one before it writes. The run then shows as `never_claimed_idle`.',
    );
    claim(
      p,
      "Under `realm listen` the reverse can happen, rarely: when the first process is killed by a `SIGKILL` and the second one lives on, `realm listen` records the mark ([`realm listen`](realm-listen.md)), and that drive may then start. `drive_failing` clears at the drive's first recorded step.",
    );
    // The replaced sentence: gone.
    expect(read(p)).not.toContain(
      'After `--run-id`, they end `If run <run-id> exists, it was not changed.` instead.',
    );
  });

  it('realm-listen.md: the replaced sentence and the paragraph on a signal death', () => {
    const p = 'reference/cli/realm-listen.md';
    claim(
      p,
      `the run that \`realm listen\` created stays open and keeps the refusal under \`Drive failures\` (added after version 0.50.0, which left nothing on its record). Its refusal appears in the same output as the log, and ends ${W}`,
    );
    claim(
      p,
      "When the `realm agent` it started is killed by a signal before it wrote anything to the run, `realm listen` records a drive failure of kind `startup_failure` on the run (added after version 0.50.0). A child that exits with a code, any code, is not marked: the exit is the agent's own verdict. A child killed after it advanced the run is left to the run's other findings, and a child whose end reaches `realm listen` after it has stopped is not marked.",
    );
    expect(read(p)).not.toContain('stays open, with nothing on its record.');
  });

  it('guides/realm-agent.md: the two replaced sentences', () => {
    const p = 'guides/realm-agent.md';
    claim(
      p,
      `After \`--run-id\`, each refusal below that ends \`Nothing was started.\` is recorded on the run, which keeps it under \`Drive failures\`, and ends ${W} instead (added after version 0.50.0). \`realm run list --stuck\` then lists the run with \`drive_failing(startup_failure)\` at the end of its line.`,
    );
    claim(
      p,
      `After \`--run-id\`, the run keeps the refusal under \`Drive failures\`, and it ends ${W} instead.`,
    );
    expect(read(p)).not.toContain('it was not changed.');
  });

  it('the record, the findings and the run listing: the rows and the sentence', () => {
    claim(
      'reference/run-record-and-export.md',
      "The kind of failure, such as `connection_timeout`, `connection_error`, `api_status`, `sdk_missing` or `validation_rejected`; `startup_failure` when `realm agent` was refused by its own startup checks or `realm listen`'s child was killed before it wrote anything (added after version 0.50.0).",
    );
    claim(
      'reference/run-record-and-export.md',
      'When, on which step, and which provider. `step` is `""` for a failure before any step ran.',
    );
    claim(
      'reference/run-record-and-export.md',
      "How long the request took; for a startup failure, the time from the command's start.",
    );
    claim(
      'reference/mcp/run-state-and-health.md',
      '`<step>=drive_failing(<kind>)`; `drive_failing(<kind>)` alone when the failure named no step (added after version 0.50.0)',
    );
    claim(
      'reference/cli/realm-run-reading.md',
      "A run whose last drive failed ends its line with `<step>=drive_failing(<kind>)`; a failure that named no step ends it with `drive_failing(<kind>)` alone, as `startup_failure` does when `realm agent` was refused by its own startup checks or `realm listen`'s child was killed before it wrote anything (added after version 0.50.0).",
    );
  });

  it('CHANGELOG: the Added line', () => {
    claim(
      CHANGELOG,
      "- **A `realm agent` that dies in its own startup checks leaves a mark on the run.** A refusal for want of a key, a model, a usable `--base-url` or a loadable provider module, with `--run-id`, is recorded as a drive failure of kind `startup_failure` before the command exits, so `realm run list --stuck`, `realm run inspect` and `get_run_state` show it; the refusal's closing sentence says what was recorded. `realm listen` writes the same mark for a child killed by a signal before it wrote anything to the run, never for an exit code. `DriveFailureRecord`'s `error_class` gains the word: a program that switches exhaustively on it must add the case. The cases Realm cannot record are named on the `realm agent` page.",
    );
  });
});
