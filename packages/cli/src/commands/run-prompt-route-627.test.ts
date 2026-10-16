// run-prompt-route-627.test.ts — #627 W (§5.8), the CLI door's second answer path: the dev runner's
// gate prompt (`realm workflow run`) records route `cli` and the principal's absence
// `not_a_server_door`, as `realm run respond` does (answer-record-627.test.ts pins that one). The
// prompt is driven through a mocked readline, as run-detach.test.ts drives it.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure: the
// record's answer facts — never a token.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mocks = vi.hoisted(() => ({ question: vi.fn(), close: vi.fn() }));
vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn(() => ({ question: mocks.question, close: mocks.close })),
}));

import { runCommand } from './run.js';

describe('#627 W — the dev prompt records its route (cell 5, the CLI door’s second path)', () => {
  let home: string;
  let dir: string;
  let savedHome: string | undefined;
  let savedTTY: boolean | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'realm-prompt-627-home-'));
    dir = mkdtempSync(join(tmpdir(), 'realm-prompt-627-wf-'));
    mkdirSync(join(home, '.realm'), { recursive: true });
    savedHome = process.env['HOME'];
    process.env['HOME'] = home;
    // Without this the non-TTY guard refuses before the prompt is reached.
    savedTTY = process.stdin.isTTY;
    process.stdin.isTTY = true;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
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

  it('`realm workflow run`’s gate prompt records route cli and not_a_server_door', async () => {
    writeFileSync(
      join(dir, 'workflow.yaml'),
      [
        'id: prompt-627',
        'name: prompt-627',
        'version: 1',
        'steps:',
        '  a:',
        '    description: gated',
        '    execution: auto',
        '    trust: human_confirmed',
        '    gate:',
        '      choices: [approve, reject]',
        '',
      ].join('\n'),
      'utf8',
    );
    // The step's mock output opens the gate (executeChain's confirm_required); then the answer.
    mocks.question
      .mockImplementationOnce(async () => '{}')
      .mockImplementationOnce(async () => 'approve');

    await runCommand.parseAsync([join(dir, 'workflow.yaml')], { from: 'user' });

    // The store is constructed after the scratch HOME is live (the #285 idiom).
    const { JsonFileStore } = await import('@sensigo/realm');
    const runs = join(home, '.realm', 'runs');
    const files = readdirSync(runs).filter((f) => f.endsWith('.json'));
    const run = await new JsonFileStore(runs).get(files[0]!.replace('.json', ''));
    const entry = run.evidence.find((e) => e.kind === 'gate_response');
    // (a) red when the prompt's answer drops the route or the principal's absence (it would read
    //     route_not_declared / principal_not_passed); (b) prints the prompt count and both facts.
    expect({
      prompts: mocks.question.mock.calls.length,
      answer: entry?.answer,
      principal: entry?.principal,
    }).toEqual({
      prompts: 2,
      answer: { route: 'cli' },
      principal: { absent: 'not_a_server_door' },
    });
  }, 20_000);
});
