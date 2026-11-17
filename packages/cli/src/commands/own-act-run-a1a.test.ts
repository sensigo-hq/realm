// own-act-run-a1a.test.ts — issue #625 PR-2b (A1a), check 10: `realm workflow run` prints the
// agent step's own ✓ after its chain.
//
// `realm workflow run` asks the person for the agent step's output, records it, and the engine
// then runs the steps after it. Before A1a, the ✓ line printed for that step showed the hash of
// the LAST step the chain ran (the reply's first evidence entry), and a chain that stopped at a
// question printed no ✓ for the step at all. Now the ✓ shows the step's own hash (`own_act`), a
// chain that stops at a question prints the step's ✓ before "Gate opened", and a step that waits
// at its own question prints "Gate opened" only, as before.
//
// Driven through the real command with readline mocked. Every assertion carries (a) the change
// that turns it red and (b) what it prints.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mocks = vi.hoisted(() => ({ question: vi.fn(), close: vi.fn() }));
vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn(() => ({ question: mocks.question, close: mocks.close })),
}));

import { runCommand } from './run.js';
import { clearProjectExtensionsCache } from '../extensions/load-project-extensions.js';
import { makeTempHome, runIds, type TempHome } from '../test-support/temp-home.js';

const yaml = (id: string, steps: string[]): string =>
  [`id: ${id}`, `name: ${id}`, 'version: 1', 'steps:', ...steps, ''].join('\n');

const ASK = ['  ask:', '    description: Ask.', '    execution: agent', '    depends_on: []'];

describe('#625 A1a, check 10 — realm workflow run: the agent step’s own ✓ after its chain', () => {
  let h: TempHome & { readonly root: string };
  let dir: string;
  let savedHome: string | undefined;
  let savedTTY: boolean | undefined;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    clearProjectExtensionsCache();
    h = await makeTempHome();
    dir = mkdtempSync(join(tmpdir(), 'realm-625-a1a-run-wf-'));
    savedHome = process.env['HOME'];
    process.env['HOME'] = h.root;
    savedTTY = process.stdin.isTTY;
    process.stdin.isTTY = true;
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('process.exit');
    }) as never);
  });

  afterEach(async () => {
    if (savedTTY === undefined) delete (process.stdin as { isTTY?: boolean }).isTTY;
    else process.stdin.isTTY = savedTTY;
    if (savedHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = savedHome;
    await h.cleanup();
    rmSync(dir, { recursive: true, force: true });
    mocks.question.mockReset();
    vi.restoreAllMocks();
  });

  /** The lines printed, the step's duration put as `<n>ms`. */
  const logged = (): string[] =>
    logSpy.mock.calls.map((c: unknown[]) => String(c[0]).replace(/\| \d+ms\n$/, '| <n>ms\n'));
  const ticks = (): string[] => logged().filter((l) => l.startsWith('  ✓ →'));

  /** Answers each prompt by its start: the agent's output, an auto step's mock output, a choice. */
  function answer(agent: string, auto: string, choice = 'ok'): void {
    mocks.question.mockImplementation(async (prompt: string) => {
      if (prompt.startsWith('  Agent output')) return agent;
      if (prompt.startsWith('  Mock output')) return auto;
      if (prompt.startsWith('  Choice ')) return choice;
      throw new Error(`fixture: an unexpected prompt: ${prompt}`);
    });
  }

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

  /** The first 8 characters of `step`'s recorded entry's hash. */
  async function hashOf(step: string): Promise<string> {
    const id = (await runIds(h.home.runStore))[0]!;
    const { record } = await h.home.runStore.get(id);
    return record.evidence.find((e) => e.step_id === step)!.evidence_hash.slice(0, 8);
  }

  it('after a chain, the ✓ shows the agent step’s own hash, not the last chained step’s', async () => {
    answer('{"a": 1}', '{}');
    // `compute` has a handler of its own, so its entry (and hash) differs from the agent step's.
    const ext = join(dir, 'calc-ext.mjs');
    writeFileSync(
      ext,
      "export default { handlers: { calc: { id: 'calc', async execute() { return { data: { b: 2 } }; } } } };\n",
      'utf8',
    );
    const code = await run(
      yaml('a1a-run-chain', [
        ...ASK,
        '  compute:',
        '    description: Compute.',
        '    execution: auto',
        '    handler: calc',
        '    depends_on: [ask]',
      ]),
      ['--extensions-module', ext],
    );
    const ask = await hashOf('ask');
    const compute = await hashOf('compute');
    // (a) red when the line reads the reply's first evidence entry (the chained `compute`'s);
    //     (b) prints the ✓ lines and both hashes.
    expect({ code, ticks: ticks(), differ: ask !== compute }).toEqual({
      code: 0,
      ticks: [`  ✓ → completed | hash: ${ask}... | <n>ms\n`],
      differ: true,
    });
  });

  it('a chain that stops at a question: the agent step’s ✓, then "Gate opened"', async () => {
    answer('{"a": 1}', '{}');
    const code = await run(
      yaml('a1a-run-chained-gate', [
        ...ASK,
        '  q:',
        '    description: Q.',
        '    execution: auto',
        '    depends_on: [ask]',
        '    trust: human_confirmed',
        '    gate:',
        '      choices: [ok, no]',
      ]),
    );
    const lines = logged();
    const opened = lines.indexOf("  Gate opened for 'q'.\n");
    // (a) red when the gate arm prints no ✓ for a step the chain went past (keyed on `own_act`);
    //     (b) prints the lines before the gate and the exit code.
    expect({
      code,
      beforeGate: lines.slice(0, opened).filter((l) => l.startsWith('  ✓ →')),
      opened: opened > -1,
    }).toEqual({
      code: 0,
      beforeGate: [`  ✓ → gate_waiting | hash: ${await hashOf('ask')}... | <n>ms\n`],
      opened: true,
    });
  });

  it('a step waiting at its own question: "Gate opened" only, no ✓', async () => {
    answer('{"a": 1}', '{}');
    const code = await run(
      yaml('a1a-run-own-gate', [
        ...ASK,
        '    trust: human_confirmed',
        '    gate:',
        '      choices: [ok, no]',
      ]),
    );
    const lines = logged();
    const opened = lines.indexOf("  Gate opened for 'ask'.\n");
    // (a) red when the ✓ is keyed on the reply's status (`confirm_required` with a gate) rather
    //     than on `own_act`; (b) prints the lines before the gate.
    expect({
      code,
      beforeGate: lines.slice(0, opened).filter((l) => l.startsWith('  ✓ →')),
      opened: opened > -1,
    }).toEqual({ code: 0, beforeGate: [], opened: true });
  });
});
