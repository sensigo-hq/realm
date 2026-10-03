// holder-host-rows-625.test.ts — issue #625 (the holder slice, PR-H): the host rows that run
// IN-PROCESS through the real command — `realm workflow run`, `realm run respond`, `realm run drain`.
// (The MCP rows and `realm agent` need a second process and are celled in
// `holder-625-journeys.test.ts`.)
//
// What each cell pins: a program that takes a step, or runs a cleanup step, writes ITS OWN name and
// door on the record — `driven_by.channel` is the command's, and `driven_by.by` is `REALM_OPERATOR`
// when set. `respond` and `drain` name the program only on the cleanup steps they run, never as the
// person who answered.
//
// Real stores in a scratch HOME; `node:readline/promises` mocked for the run prompt (the #447
// harness). Each assertion carries (a) the change that turns it red and (b) what it prints on
// failure: synthetic names only.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mocks = vi.hoisted(() => ({ question: vi.fn(), close: vi.fn() }));
vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn(() => ({ question: mocks.question, close: mocks.close })),
}));

import {
  JsonFileStore,
  JsonWorkflowStore,
  ExtensionRegistry,
  executeStep,
  submitHumanResponse,
} from '@sensigo/realm';
import { runCommand } from './run.js';
import { respondCommand } from './respond.js';
import { drainCommand } from './drain.js';
import { loadWorkflowForAdmission } from '../lib/load-workflow-for-admission.js';
import { clearProjectExtensionsCache } from '../extensions/load-project-extensions.js';

const GATE_ONLY_YAML = (id: string): string =>
  [
    `id: ${id}`,
    `name: ${id}`,
    'version: 1',
    'steps:',
    '  confirm:',
    '    description: Confirm',
    '    execution: auto',
    '    trust: human_confirmed',
    '    depends_on: []',
    '    gate:',
    '      choices: [approve, reject]',
    '',
  ].join('\n');

const FINALIZER_YAML = [
  'id: host-row-fin-wf',
  'name: host row fin',
  'version: 1',
  'extensions: ../../dist/registry.js',
  'steps:',
  '  confirm:',
  '    description: Confirm',
  '    execution: auto',
  '    trust: human_confirmed',
  '    depends_on: []',
  '    gate:',
  '      choices: [approve, reject]',
  '  fin:',
  '    description: Cleanup',
  '    execution: finalizer',
  '    on_outcome: complete',
  '    handler: h_ok',
  '',
].join('\n');

describe('`realm run respond --by` — the option the operator reads in --help', () => {
  it('is declared, optional, and says it is a stated name that is never verified', () => {
    const option = respondCommand.options.find((o) => o.long === '--by');
    // (a) red when the option goes, becomes required, or loses its description; (b) prints it.
    expect(option).toBeDefined();
    expect(option?.required).toBe(true); // takes a value (<name>) …
    expect(option?.mandatory).toBe(false); // … but the flag itself is optional
    expect(option?.description).toBe(
      'Who made the choice, as you state it — recorded with the answer, not verified. At most 200 ' +
        'characters, no control characters. Optional: the answer names its answerer only when this is given.',
    );
  });
});

describe('issue #625 PR-H — the host rows that run in-process', () => {
  let home: string;
  let proj: string;
  let savedHome: string | undefined;
  let savedOperator: string | undefined;
  let savedTTY: boolean | undefined;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clearProjectExtensionsCache();
    home = mkdtempSync(join(tmpdir(), 'realm-holder-rows-home-'));
    proj = mkdtempSync(join(tmpdir(), 'realm-holder-rows-proj-'));
    mkdirSync(join(home, '.realm', 'workflows'), { recursive: true });
    savedHome = process.env['HOME'];
    process.env['HOME'] = home;
    savedOperator = process.env['REALM_OPERATOR'];
    process.env['REALM_OPERATOR'] = 'row-operator';
    savedTTY = process.stdin.isTTY;
    process.stdin.isTTY = true;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('process.exit');
    }) as never);
  });

  afterEach(() => {
    if (savedTTY === undefined) delete (process.stdin as { isTTY?: boolean }).isTTY;
    else process.stdin.isTTY = savedTTY;
    if (savedHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = savedHome;
    if (savedOperator === undefined) delete process.env['REALM_OPERATOR'];
    else process.env['REALM_OPERATOR'] = savedOperator;
    mocks.question.mockReset();
    vi.restoreAllMocks();
    rmSync(home, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  });

  const rowDriver = (channel: string) => ({
    by: 'row-operator',
    by_source: 'ambient',
    channel,
  });

  /** The project: a registry module with the cleanup handler, and a registered workflow using it. */
  async function registerFinalizerWorkflow() {
    mkdirSync(join(proj, 'dist'), { recursive: true });
    mkdirSync(join(proj, 'workflows', 'wf'), { recursive: true });
    writeFileSync(join(proj, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
    writeFileSync(
      join(proj, 'dist', 'registry.js'),
      `export default { handlers: { h_ok: { id: 'h_ok', execute: async () => ({ data: { ran: true } }) } } };`,
      'utf8',
    );
    const file = join(proj, 'workflows', 'wf', 'workflow.yaml');
    writeFileSync(file, FINALIZER_YAML, 'utf8');
    const { definition } = await loadWorkflowForAdmission(file, { surface: 'register' });
    await new JsonWorkflowStore().register(definition);
    return definition;
  }

  async function openGate(definition: Awaited<ReturnType<typeof registerFinalizerWorkflow>>) {
    const store = new JsonFileStore();
    const { run } = await store.create({
      workflowId: definition.id,
      workflowVersion: 1,
      params: {},
    });
    const opened = await executeStep(store, definition, {
      runId: run.id,
      command: 'confirm',
      input: {},
      dispatcher: async () => ({}),
    });
    if (opened.status !== 'confirm_required')
      throw new Error(`fixture: gate not open (${opened.status})`);
    return { store, runId: run.id, gateId: opened.gate!.gate_id };
  }

  it('`realm workflow run`: the step the prompt took carries channel `run` and the REALM_OPERATOR name', async () => {
    mocks.question.mockImplementation(async (prompt: string) => {
      if (prompt.startsWith('  Choice ')) return 'approve';
      return '';
    });
    const dir = mkdtempSync(join(tmpdir(), 'realm-holder-rows-wf-'));
    try {
      writeFileSync(join(dir, 'workflow.yaml'), GATE_ONLY_YAML('host-row-run-wf'), 'utf8');
      await runCommand.parseAsync([join(dir, 'workflow.yaml')], { from: 'user' }).catch(() => {});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const id = readdirSync(join(home, '.realm', 'runs'))
      .filter((f) => f.endsWith('.json'))[0]!
      .replace('.json', '');
    const run = await new JsonFileStore().get(id);
    // (a) red when `run.ts` stops passing its identity, or uses another channel; (b) prints it.
    expect(
      run.evidence.find((e) => e.step_id === 'confirm' && e.kind !== 'gate_response')?.driven_by,
    ).toEqual(rowDriver('run'));
    expect(exitSpy).not.toHaveBeenCalledWith(2);
  }, 30_000);

  it('`realm run respond`: the cleanup step an answer runs carries channel `respond` — and the answer names NO answerer', async () => {
    const definition = await registerFinalizerWorkflow();
    const { store, runId, gateId } = await openGate(definition);
    await respondCommand.parseAsync(
      [runId, '--gate', gateId, '--choice', 'approve', '--project', proj],
      { from: 'user' },
    );
    const run = await store.get(runId);
    expect(run.run_phase).toBe('completed');
    // (a) red when respond stops passing its driver to the drain it triggers, or names the
    //     program as the person who answered; (b) prints the entries.
    expect(run.evidence.filter((e) => e.step_id === 'fin').map((e) => e.driven_by)).toEqual([
      rowDriver('respond'),
    ]);
    const answer = run.evidence.find((e) => e.kind === 'gate_response');
    expect(answer !== undefined && 'responded_by' in answer).toBe(false);
  }, 30_000);

  it('`realm run drain`: the cleanup step it runs carries channel `drain`', async () => {
    const definition = await registerFinalizerWorkflow();
    const { store, runId, gateId } = await openGate(definition);
    // Answer with a registry that lacks the cleanup handler — the run completes and the cleanup
    // step stays PENDING, which is exactly what a drain exists to run.
    await submitHumanResponse(store, definition, {
      runId,
      gateId,
      choice: 'approve',
      registry: new ExtensionRegistry(),
    });
    expect((await store.get(runId)).finalizer_ledger?.['fin']?.status).toBe('pending');
    await drainCommand.parseAsync([runId, '--force', '--project', proj], { from: 'user' });
    const run = await store.get(runId);
    expect(run.finalizer_ledger?.['fin']?.status).toBe('completed');
    // (a) red when drain's identity is not threaded to its three deps.drainFinalizers calls;
    //     (b) prints the entries.
    expect(run.evidence.filter((e) => e.step_id === 'fin').map((e) => e.driven_by)).toEqual([
      rowDriver('drain'),
    ]);
  }, 30_000);

  it('(control) the same drain with no REALM_OPERATOR names the OS user and host as `derived`', async () => {
    delete process.env['REALM_OPERATOR'];
    const definition = await registerFinalizerWorkflow();
    const { store, runId, gateId } = await openGate(definition);
    await submitHumanResponse(store, definition, {
      runId,
      gateId,
      choice: 'approve',
      registry: new ExtensionRegistry(),
    });
    await drainCommand.parseAsync([runId, '--force', '--project', proj], { from: 'user' });
    const driven = (await store.get(runId)).evidence.find((e) => e.step_id === 'fin')?.driven_by;
    expect(driven?.channel).toBe('drain');
    expect(driven?.by_source).toBe('derived');
    expect(driven?.by).toMatch(/.@./);
  }, 30_000);
});
