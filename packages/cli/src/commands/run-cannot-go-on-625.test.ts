// run-cannot-go-on-625.test.ts — issue #625 PR-2a, decision C64 (the census): `realm workflow run`
// (dev mode) answers an `auto` step with the typed output. An input refusal is the operator's to fix
// at the prompt (the control: the step is offered, a valid answer completes the run). A precondition,
// trust or capability refusal is not — no typed output changes it — and the prompt looped forever,
// printing `✗ blocked: ` with an EMPTY reason for a precondition (measured on `d2f0b3cf` and on round
// 7's head). Such a step is no longer offered; when nothing else is eligible the run cannot go on
// from here, and the screen names each step that cannot run and the way out (core's lines), exit 1.
//
// In-process through the real command, with `node:readline/promises` mocked (the #447 harness).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mocks = vi.hoisted(() => ({ question: vi.fn(), close: vi.fn() }));
vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn(() => ({ question: mocks.question, close: mocks.close })),
}));

import { runCommand } from './run.js';
import { clearProjectExtensionsCache } from '../extensions/load-project-extensions.js';

const yaml = (id: string, compute: string[]): string =>
  [
    `id: ${id}`,
    `name: ${id}`,
    'version: 1',
    'steps:',
    '  ask:',
    '    description: Ask.',
    '    execution: agent',
    '    depends_on: []',
    '  compute:',
    '    description: Compute.',
    '    execution: auto',
    '    depends_on: [ask]',
    ...compute,
    '',
  ].join('\n');

describe('#625 PR-2a, C64 — realm workflow run: a step no typed output can unblock', () => {
  let home: string;
  let dir: string;
  let savedHome: string | undefined;
  let savedTTY: boolean | undefined;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clearProjectExtensionsCache();
    home = mkdtempSync(join(tmpdir(), 'realm-625-c64-run-home-'));
    dir = mkdtempSync(join(tmpdir(), 'realm-625-c64-run-wf-'));
    mkdirSync(join(home, '.realm'), { recursive: true });
    savedHome = process.env['HOME'];
    process.env['HOME'] = home;
    savedTTY = process.stdin.isTTY;
    process.stdin.isTTY = true;
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
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
    rmSync(home, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
    mocks.question.mockReset();
    vi.restoreAllMocks();
  });

  const logged = (): string[] => logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
  const errored = (): string[] => errSpy.mock.calls.map((c: unknown[]) => String(c[0]));
  const asked = (): string[] => mocks.question.mock.calls.map((c: unknown[]) => String(c[0]));
  const runId = (): string =>
    readdirSync(join(home, '.realm', 'runs'))
      .filter((f) => f.endsWith('.json'))[0]!
      .replace('.json', '');
  const wayOut = (id: string): string =>
    `Run ${id} stays open (phase 'running'): correct the workflow, register it again, then realm run advance ${id} — or end it: realm run abandon ${id}`;

  async function run(text: string, extra: string[] = []): Promise<number> {
    writeFileSync(join(dir, 'workflow.yaml'), text, 'utf8');
    try {
      await runCommand.parseAsync([join(dir, 'workflow.yaml'), ...extra], { from: 'user' });
      return 0;
    } catch (err) {
      if (!(err instanceof Error) || err.message !== 'process.exit') throw err;
      return Number(exitSpy.mock.calls[0]?.[0]);
    }
  }

  it('a precondition refusal: the step is never offered; the stall names it and the way out, exit 1', async () => {
    mocks.question.mockResolvedValue('');
    const code = await run(yaml('c64-run-pre', ['    preconditions: ["run.params.ok == true"]']));
    expect(code).toBe(1);
    expect(asked()).toEqual(['  Agent output JSON (Enter for {}): ']);
    expect(errored()).toEqual([
      '\nWorkflow stalled: nothing else can run.',
      "'compute' cannot run (precondition): Precondition failed for step 'compute'. Precondition failed: 'run.params.ok == true'. Resolved value: undefined.",
      wayOut(runId()),
    ]);
  });

  it('a chained capability block: the agent step is said as completed, then the stall names the blocked step and the way out, exit 1', async () => {
    mocks.question.mockResolvedValue('');
    const code = await run(yaml('c64-run-cap', ['    handler: missing_h']));
    expect(code).toBe(1);
    expect(asked()).toEqual(['  Agent output JSON (Enter for {}): ']);
    // The step's duration is the machine's (round 12 saw `1ms` under load): the line's text is
    // compared with the number replaced.
    expect(
      logged()
        .filter((l) => l.startsWith('  ✓ →') || l.startsWith('  ✗'))
        .map((l) => l.replace(/\| \d+ms\n$/, '| <n>ms\n')),
    ).toEqual(['  ✓ → running | hash: 44136fa3... | <n>ms\n']);
    expect(errored()).toEqual([
      '\nWorkflow stalled: nothing else can run.',
      "'compute' cannot run here (capability): handler 'missing_h' is not registered here — load the missing extension, or run the step on a runner that has it.",
      `To end the run instead: realm run abandon ${runId()}`,
    ]);
  });

  it('control (C73): a chained step whose handler throws — the ✗ line names it and the engine ran it after the agent step; the agent step is not said as completed', async () => {
    // (a) red when the ok arm takes every non-ok reply from a later step, not only a capability
    //     block (round 9's mutant r9k: the failure is then printed as the agent step's ✓);
    // (b) prints the ✓/✗ lines and the exit code.
    mocks.question.mockResolvedValue('');
    const ext = join(dir, 'boom-ext.mjs');
    writeFileSync(
      ext,
      "export default { handlers: { boom: { id: 'boom', async execute() { throw new Error('the printer is on fire'); } } } };\n",
      'utf8',
    );
    const code = await run(yaml('c64-run-fail', ['    handler: boom']), [
      '--extensions-module',
      ext,
    ]);
    expect(code).toBe(1);
    expect(asked()).toEqual(['  Agent output JSON (Enter for {}): ']);
    expect(
      [...logged(), ...errored()].filter((l) => l.startsWith('  ✓ →') || l.startsWith('  ✗')),
    ).toEqual([
      "  ✗ error (step 'compute', run by the engine after 'ask' finished): Handler 'boom' threw: the printer is on fire\n",
    ]);
  });

  it('control: an input refusal stays the prompt’s — the step is offered, a valid typed output completes the run', async () => {
    const answers = ['', '', '{"n": 1}'];
    mocks.question.mockImplementation(async () => answers.shift() ?? '');
    const code = await run(
      yaml('c64-run-input', [
        '    input_schema:',
        '      type: object',
        '      required: [n]',
        '      properties:',
        '        n: { type: number }',
      ]),
    );
    expect(code).toBe(0);
    expect(asked()).toEqual([
      '  Agent output JSON (Enter for {}): ',
      '  Mock output (auto) — JSON (Enter for {}): ',
      '  Mock output (auto) — JSON (Enter for {}): ',
    ]);
    expect(errored().filter((l) => l.includes('stalled'))).toEqual([]);
  });
});
