// #729 PR-3 (03 L-4; RECORD 01 #17; D1 D5): `realm run abandon` prints a rerun that REFERS to the
// run's params (`realm workflow run <dir> --params-from-run <id>`); the printed command runs as
// printed and starts a run with the earlier run's params as stored (raw). An answer that sends a
// marker back is recorded as sent, and the operator is told. Every value is fake. Each assertion
// names (a) the change that turns it red and (b) what it prints: booleans and fake values.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  JsonFileStore,
  JsonWorkflowStore,
  type WorkflowDefinition,
} from '@sensigo/realm';

const mocks = vi.hoisted(() => ({ question: vi.fn(), close: vi.fn() }));
vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn(() => ({ question: mocks.question, close: mocks.close })),
}));

import { runCommand } from './run.js';
import { abandonCommand } from './abandon.js';

const SECRET = 'FAKE-PFR-SECRET-0729';

let home: string;
let dir: string;
let savedHome: string | undefined;
let savedTTY: boolean | undefined;
let logged: string[];
let warned: string[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'realm-pfr-home-'));
  dir = mkdtempSync(join(tmpdir(), 'realm-pfr-wf-'));
  mkdirSync(join(home, '.realm'), { recursive: true });
  savedHome = process.env['HOME'];
  process.env['HOME'] = home;
  savedTTY = process.stdin.isTTY;
  process.stdin.isTTY = true;
  writeFileSync(
    join(dir, 'workflow.yaml'),
    'id: pfr\nname: pfr\nversion: 1\nsteps:\n  a:\n    description: a\n    execution: agent\n',
    'utf8',
  );
  logged = [];
  warned = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    logged.push(a.map(String).join(' '));
  });
  vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => {
    warned.push(a.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation(((): never => {
    throw new Error('process.exit');
  }) as never);
});

afterEach(() => {
  if (savedTTY === undefined) delete (process.stdin as { isTTY?: boolean }).isTTY;
  else process.stdin.isTTY = savedTTY;
  if (savedHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = savedHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
  mocks.question.mockReset();
  vi.restoreAllMocks();
});

async function registeredRun(params: Record<string, unknown>): Promise<string> {
  await new JsonWorkflowStore(join(home, '.realm', 'workflows')).register({
    id: 'pfr',
    name: 'pfr',
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps: { a: { description: 'a', execution: 'agent', depends_on: [] } },
    source_dir: dir,
  } as WorkflowDefinition);
  const { run } = await new JsonFileStore(join(home, '.realm', 'runs')).create({
    workflowId: 'pfr',
    workflowVersion: 1,
    params,
  });
  return run.id;
}

describe('#729 PR-3 — the rerun refers to the run, and runs as printed', () => {
  it('abandon prints `--params-from-run <id>`; that command starts a run with the stored params', async () => {
    const id = await registeredRun({ key: SECRET, n: 1 });
    await abandonCommand.parseAsync([id], { from: 'user' });
    const line =
      logged
        .join('\n')
        .split('\n')
        .find((l) => l.startsWith('  realm workflow run ')) ?? '';
    const command = /realm workflow run (\S+) --params-from-run (\S+)/.exec(line);
    // (a) red when the rerun prints the params (the value would show) or no longer refers to the
    //     run; (b) prints booleans.
    expect({ refers: command !== null, valueShown: line.includes(SECRET) }).toEqual({
      refers: true,
      valueShown: false,
    });
    mocks.question.mockImplementation(async () => '{}');
    await runCommand.parseAsync([command![1]!, '--params-from-run', command![2]!], {
      from: 'user',
    });
    const runs = await new JsonFileStore(join(home, '.realm', 'runs')).list();
    const fresh = runs.find((r) => r.id !== id)!;
    // (a) red when the flag is ignored or reads a masked copy; (b) prints the new run's params
    //     (fake values).
    expect(fresh.params).toEqual({ key: SECRET, n: 1 });
  });

  it('refuses --params with --params-from-run, and a run of another workflow', async () => {
    const id = await registeredRun({});
    const other = await new JsonFileStore(join(home, '.realm', 'runs')).create({
      workflowId: 'another',
      workflowVersion: 1,
      params: {},
    });
    const refused = async (args: string[]) =>
      runCommand.parseAsync([dir, ...args], { from: 'user' }).then(
        () => false,
        (e: Error) => e.message === 'process.exit',
      );
    // (a) red when either refusal is dropped (a run would start), or an explicit `--params '{}'`
    //     (the default's own value) is let through beside `--params-from-run` (F31); (b) prints
    //     booleans.
    expect({
      both: await refused(['--params', '{"a":1}', '--params-from-run', id]),
      bothDefaultValue: await refused(['--params', '{}', '--params-from-run', id]),
      otherWorkflow: await refused(['--params-from-run', other.run.id]),
    }).toEqual({ both: true, bothDefaultValue: true, otherWorkflow: true });
  });
});

describe('#729 PR-3 — an answer that sends a marker back (D1 D5)', () => {
  it('realm workflow run records it as sent and warns', async () => {
    mocks.question.mockImplementation(async () => '{"answer":"sent back [REDACTED] here"}');
    await runCommand.parseAsync([dir], { from: 'user' });
    const [run] = await new JsonFileStore(join(home, '.realm', 'runs')).list();
    // (a) red when the warning is dropped or the answer is changed before it is recorded; (b)
    //     prints booleans.
    expect({
      warned: warned.some((w) => w.includes("holds '[REDACTED]'")),
      recordedAsSent:
        run?.evidence.find((e) => e.step_id === 'a')?.output_summary['answer'] ===
        'sent back [REDACTED] here',
    }).toEqual({ warned: true, recordedAsSent: true });
  });
});
