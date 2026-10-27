// asked-person-729.test.ts — #729 PR-4 at the CLI (04 "The surfaces", B2, B3; 03): every CLI door
// that can open a gate passes the writer's set to the engine, so the stored question is masked —
// `realm workflow run`, `realm run advance`, and `realm agent` (the drive and `--run-id`); the
// question is composed once, over the gate disclosed for each surface's audience, `display`
// honoured; `realm agent` walks the printed gate once; a cut view names the way to the whole
// output under the question.
//
// In-process through the real commands (the #447 readline harness for the prompt), with the
// writer installed and a declared fake added, as the CLI's own entry does from a manifest. A
// spied `console.log` holds what a renderer composed, before the writer's stdout pass masks it —
// so a renderer composing over the raw gate shows the fake there. Every value is a fake. Each
// assertion names (a) the change that turns it red and (b) what it prints when it fails.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mocks = vi.hoisted(() => ({ question: vi.fn(), close: vi.fn() }));
vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn(() => ({ question: mocks.question, close: mocks.close })),
}));

import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  ExtensionRegistry,
  JsonFileStore,
  JsonWorkflowStore,
  createDefaultRegistry,
  submitHumanResponse,
  type PendingGate,
  type RunStore,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { runCommand } from './run.js';
import { runAdvanceCommand } from './run-advance.js';
import { clearProjectExtensionsCache } from '../extensions/load-project-extensions.js';
import { runAgent } from '../agent/run-agent.js';
import { LlmProvider } from '../agent/providers/llm-provider.js';
import { slackView } from '../agent/gate/slack-gate-notifier.js';
import {
  addDeclaredValues,
  installWriter,
  writerTally,
  writerTestSeams,
} from '../output/writer.js';

const FAKE = 'FAKE-DECLARED-PR4-0729';
const QUESTION = 'Approve {{ run.params.token }}?';
const MASKED = 'Approve [REDACTED]?';

/** One gate step: `auto`, its output from the `emit` handler, a message over the run's token. */
function definition(over: Record<string, unknown> = {}): WorkflowDefinition {
  return {
    id: 'ask-729',
    name: 'ask-729',
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps: {
      confirm: {
        description: 'Confirm',
        execution: 'auto',
        trust: 'human_confirmed',
        depends_on: [],
        handler: 'emit',
        gate: { choices: ['approve', 'reject'], message: QUESTION },
        ...over,
      },
    },
  } as unknown as WorkflowDefinition;
}
const yamlOf = (
  message: string | undefined,
  display?: string,
  execution: 'auto' | 'agent' = 'auto',
): string =>
  [
    'id: ask-729',
    'name: ask-729',
    'version: 1',
    'steps:',
    '  confirm:',
    '    description: Confirm',
    `    execution: ${execution}`,
    '    trust: human_confirmed',
    '    depends_on: []',
    ...(display !== undefined ? [`    display: "${display}"`] : []),
    '    gate:',
    '      choices: [approve, reject]',
    ...(message !== undefined ? [`      message: "${message}"`] : []),
    '',
  ].join('\n');

/** A registry whose `emit` handler answers with `output`. */
function registryEmitting(output: Record<string, unknown>): ExtensionRegistry {
  const registry = createDefaultRegistry();
  registry.register('handler', 'emit', { id: 'emit', execute: async () => ({ data: output }) });
  return registry;
}

let home: string;
let savedHome: string | undefined;
let savedTTY: boolean | undefined;
let logSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  clearProjectExtensionsCache();
  home = mkdtempSync(join(tmpdir(), 'realm-asked-729-home-'));
  mkdirSync(join(home, '.realm'), { recursive: true });
  savedHome = process.env['HOME'];
  process.env['HOME'] = home;
  savedTTY = process.stdin.isTTY;
  process.stdin.isTTY = true;
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation(((): never => {
    throw new Error('process.exit');
  }) as never);
  installWriter('default');
  addDeclaredValues({ SECRET_X: FAKE });
});
afterEach(() => {
  writerTestSeams.reset();
  if (savedTTY === undefined) delete (process.stdin as { isTTY?: boolean }).isTTY;
  else process.stdin.isTTY = savedTTY;
  if (savedHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = savedHome;
  rmSync(home, { recursive: true, force: true });
  mocks.question.mockReset();
  vi.restoreAllMocks();
});
/** What the renderers composed, the writer's span envelopes taken off (their bodies kept). */
const unspanned = (text: string): string =>
  text.replace(/\uE000[^\uE001\uE002]*\uE001|\uE002/g, '');
const logged = (): string =>
  unspanned(logSpy.mock.calls.map((c: unknown[]) => c.map(String).join(' ')).join('\n'));

/** `realm workflow run <dir> --params …`, typing an agent step's `output` and answering the gate
 *  with `choice`. */
async function workflowRun(
  yaml: string,
  params: Record<string, unknown>,
  output: Record<string, unknown> = {},
  choice = 'approve',
) {
  const dir = mkdtempSync(join(tmpdir(), 'realm-asked-729-wf-'));
  writeFileSync(join(dir, 'workflow.yaml'), yaml);
  mocks.question.mockImplementation(async (prompt: string) =>
    prompt.startsWith('  Choice ')
      ? choice
      : prompt.startsWith('  Agent output JSON')
        ? JSON.stringify(output)
        : '',
  );
  try {
    await runCommand.parseAsync([join(dir, 'workflow.yaml'), '--params', JSON.stringify(params)], {
      from: 'user',
    });
  } catch (err) {
    if (!(err instanceof Error) || err.message !== 'process.exit') throw err;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const runs = new JsonFileStore(join(home, '.realm', 'runs'));
  const id = readdirSync(join(home, '.realm', 'runs'))
    .filter((f) => f.endsWith('.json'))[0]!
    .replace('.json', '');
  return runs.get(id);
}

/** One `realm agent` drive in-process; the gate handler reads the stored gate, then answers it. */
async function agentDrive(
  def: WorkflowDefinition,
  output: Record<string, unknown>,
  opts: { existingRunId?: string; store?: RunStore; params?: Record<string, unknown> } = {},
) {
  const store = opts.store ?? new JsonFileStore(join(home, '.realm', 'runs'));
  const seen: { gate?: PendingGate; tallyAtGate?: ReturnType<typeof writerTally> } = {};
  const tallyBefore = writerTally();
  await runAgent(
    {
      store,
      workflowStore: {
        async register() {},
        async get() {
          return def;
        },
        async list() {
          return [def];
        },
      },
      provider: new (class extends LlmProvider {
        async callStep(): Promise<Record<string, unknown>> {
          return {};
        }
      })(),
      registry: registryEmitting(output),
      gateHandler: async (runId: string, gate: PendingGate) => {
        seen.gate = gate;
        seen.tallyAtGate = writerTally();
        await submitHumanResponse(store, def, { runId, gateId: gate.gate_id, choice: 'approve' });
      },
    } as never,
    {
      definition: def,
      params: opts.params ?? { token: FAKE },
      ...(opts.existingRunId !== undefined ? { existingRunId: opts.existingRunId } : {}),
      inFlightPollMs: 5,
      inFlightWatchMs: 20,
      pollIntervalMs: 20,
    } as never,
  );
  return { ...seen, tallyBefore };
}

describe('#729 PR-4 — the set reaches the mint through the CLI doors (B2)', () => {
  it('`realm workflow run`: the stored question is masked', async () => {
    const run = await workflowRun(yamlOf(QUESTION), { token: FAKE });
    const answered = run.evidence.find(
      (e) => e.step_id === 'confirm' && e.kind === 'gate_response',
    );
    // (a) red when `realm workflow run` passes no set to executeChain (the fake stored raw); (b)
    //     prints the stored question.
    expect(answered?.gate_message).toBe(MASKED);
  });

  it('`realm run advance`: the stored question is masked', async () => {
    const def = definition({ handler: undefined });
    await new JsonWorkflowStore(join(home, '.realm', 'workflows')).register(def);
    const runs = new JsonFileStore(join(home, '.realm', 'runs'));
    const { run } = await runs.create({
      workflowId: def.id,
      workflowVersion: 1,
      params: { token: FAKE },
    });
    try {
      await runAdvanceCommand.parseAsync([run.id], { from: 'user' });
    } catch (err) {
      if (!(err instanceof Error) || err.message !== 'process.exit') throw err;
    }
    // (a) red when `realm run advance` passes no set to advanceRun; (b) prints the stored question.
    expect((await runs.get(run.id)).pending_gate?.resolved_message).toBe(MASKED);
  });

  it('`realm agent` (the drive): the stored question is masked', async () => {
    const { gate } = await agentDrive(definition(), { summary: 'ok' });
    // (a) red when the drive's advanceRun or executeChain passes no set; (b) prints the question.
    expect(gate?.resolved_message).toBe(MASKED);
  });

  it('`realm agent --run-id`: the stored question is masked', async () => {
    const def = definition();
    const store = new JsonFileStore(join(home, '.realm', 'runs'));
    const { run } = await store.create({
      workflowId: def.id,
      workflowVersion: 1,
      params: { token: FAKE },
    });
    const { gate } = await agentDrive(def, { summary: 'ok' }, { existingRunId: run.id, store });
    // (a) red when the re-attached drive passes no set; (b) prints the stored question.
    expect(gate?.resolved_message).toBe(MASKED);
  });
});

describe('#729 PR-4 — the surfaces on one source', () => {
  it('one `display` fixture: the terminal and `realm workflow run` show the display rendering with the fake masked; Slack shows its shape; the stored message is the question on each', async () => {
    const output = { summary: FAKE, other: 'unshown' };
    const def = definition({ display: 'Summary: {{ summary }}' });
    const { gate } = await agentDrive(def, output);
    const agentPrint = logged();
    logSpy.mockClear();
    await workflowRun(yamlOf(QUESTION, 'Summary: {{ summary }}', 'agent'), { token: FAKE }, output);
    const runPrint = logged();
    const slack = slackView(gate!, 'Summary: {{ summary }}');
    // (a) red per renderer when it composes its own preview again (the chain's JSON shows, the
    //     `other` field with it) or over the raw gate (the fake shows); (b) prints booleans.
    expect({
      agentDisplay: agentPrint.includes('Summary: [REDACTED]'),
      agentQuestion: agentPrint.includes(MASKED),
      agentRaw: agentPrint.includes(FAKE) || agentPrint.includes('unshown'),
      runPreview: runPrint.includes('  Preview: Summary: [REDACTED]'),
      runQuestion: runPrint.includes(`Question: ${MASKED}`),
      runRaw: runPrint.includes(FAKE) || runPrint.includes('unshown'),
      slack: [slack.question_text, slack.preview_text],
    }).toEqual({
      agentDisplay: true,
      agentQuestion: true,
      agentRaw: false,
      runPreview: true,
      runQuestion: true,
      runRaw: false,
      slack: [MASKED, 'Summary: ‹string, 22 characters›'],
    });
  });

  it('a gate with no message: the terminal and `realm workflow run` show the output as the body, no question; the step’s prompt never shows', async () => {
    const def = definition({
      gate: { choices: ['approve', 'reject'] },
      prompt: 'PROMPT-TEXT-PR4',
    });
    await agentDrive(def, { headline: 'The body' });
    const agentPrint = logged();
    logSpy.mockClear();
    await workflowRun(yamlOf(undefined), { token: FAKE });
    const runPrint = logged();
    // (a) red when a surface renders the prompt as the question, or loses the body; (b) prints
    //     booleans.
    expect({
      agentBody: agentPrint.includes('   The body'),
      agentPrompt: agentPrint.includes('PROMPT-TEXT'),
      runQuestionLine: runPrint.includes('Question:'),
    }).toEqual({ agentBody: true, agentPrompt: false, runQuestionLine: false });
  });

  it('the cut line’s way: a cut view prints the `inspect` way under the question, through the ways renderer', async () => {
    const def = definition({ gate: { choices: ['approve', 'reject'], message: 'W'.repeat(700) } });
    await agentDrive(def, { summary: 'ok' });
    const lines = logged().split('\n');
    const way = lines.findIndex((l) => l.includes("The step's whole output: realm run inspect "));
    const sentence = lines.findIndex((l) => l.includes('[Cut when this question opened'));
    // (a) red when the way is printed inside the question's text, or not at all; (b) prints the
    //     two line numbers.
    expect({ way: way > sentence, sentence: sentence >= 0 }).toEqual({ way: true, sentence: true });
  });
});

describe('#729 PR-4 — `realm agent` walks the printed gate once (B3, F10)', () => {
  it('broadcast: the gate’s hides join the tally once; a field the print leaves out is not counted', async () => {
    writerTestSeams.reset();
    installWriter('broadcast');
    addDeclaredValues({ SECRET_X: FAKE });
    const def = definition({
      display: '{{ a }}',
      gate: {
        choices: ['approve', 'reject'],
        message: 'Ship it?',
        resolution_messages: { approve: `Shipping ${FAKE}` },
      },
    });
    const { tallyBefore, tallyAtGate } = await agentDrive(
      def,
      { a: 'alpha', b: FAKE },
      { params: {} },
    );
    // (a) red when the gate is walked twice (shaped 2) or whole (the unprinted `b` and the
    //     resolution message counted: a declared hide); (b) prints the deltas.
    expect({
      shaped: tallyAtGate!.shaped - tallyBefore!.shaped,
      declared: tallyAtGate!.declared - tallyBefore!.declared,
    }).toEqual({ shaped: 1, declared: 0 });
  });
});
