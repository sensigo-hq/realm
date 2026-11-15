// validate-slack-answerers-603.test.ts — #603 A3a, acceptance checks 12 and 13 (the project's
// list): when realm.yaml has a Slack notifier that reads replies, `validate`, `register` and
// `validate --registered` name each gate whose answerers are not Slack member IDs (a warning:
// `--strict` fails on it), and realm.yaml's `answerers` entry that is not a member ID refuses the
// load. In-process via commander's parseAsync; a project is a temp folder holding `realm.yaml`.
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateCommand } from './validate.js';
import { registerCommand } from './register.js';
import { makeTempHome, type TempHome } from '../test-support/temp-home.js';

/** A gated step whose question names `gate`'s lines. */
const workflow = (gate: string[]): string =>
  [
    'id: answerers',
    'name: Answerers',
    'version: 1',
    'steps:',
    '  confirm:',
    '    description: Confirm.',
    '    execution: auto',
    '    trust: human_confirmed',
    '    gate:',
    '      choices: [approve, reject]',
    ...gate.map((l) => `      ${l}`),
    '',
  ].join('\n');

const READS_REPLIES = ['bot_token: xoxb-1', 'channel_id: C1', 'app_token: xapp-1'];
const W6 =
  "⚠ Gate on step 'confirm': no one it names (@ana) is a Slack member ID, so no reply in its Slack thread counts; answer it with `realm run respond`. Name the person by member ID (U…), list member IDs in `answerers`, or remove `owner` so that the project's `answerers`, or without them anyone in the thread, can answer.";
const W6B =
  "⚠ Gate on step 'confirm': '@ana' is not a Slack member ID, so only U1 can answer it in Slack.";

describe('#603 A3a — validate and register name the gates no Slack reply can answer', () => {
  let h: TempHome & { readonly root: string };
  let originalHome: string | undefined;
  let dir: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    h = await makeTempHome();
    originalHome = process.env['HOME'];
    process.env['HOME'] = h.root;
    dir = mkdtempSync(join(tmpdir(), 'realm-validate-answerers-'));
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
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

  /** realm.yaml with a Slack notifier holding `config` (none when `undefined`). */
  function manifest(config: string[] | undefined): void {
    const notifier =
      config === undefined
        ? []
        : [
            'notifiers:',
            '  slack_gate:',
            '    type: slack',
            '    config:',
            ...config.map((l) => `      ${l}`),
          ];
    writeFileSync(join(dir, 'realm.yaml'), ['version: 1', ...notifier, ''].join('\n'), 'utf8');
  }
  const write = (yaml: string): string => {
    const file = join(dir, 'workflow.yaml');
    writeFileSync(file, yaml, 'utf8');
    return file;
  };
  const lines = (spy: ReturnType<typeof vi.spyOn>): string[] =>
    spy.mock.calls.map((c: unknown[]) => String(c[0]));
  async function exitOf(run: () => Promise<unknown>): Promise<number> {
    try {
      await run();
    } catch (err) {
      if (!(err instanceof Error) || err.message !== 'process.exit') throw err;
    }
    const call = exitSpy.mock.calls.at(-1);
    return call === undefined ? 0 : Number(call[0] ?? 0);
  }
  const validate = (args: string[]): Promise<number> =>
    exitOf(() => validateCommand.parseAsync(args, { from: 'user' }));
  const answerersWarnings = (): string[] =>
    lines(warnSpy).filter((l) => l.startsWith('⚠ Gate on step'));

  it("check 12: a gate owned by '@ana' under a notifier that reads replies — W6, exit 0; `--strict` exits 1", async () => {
    manifest(READS_REPLIES);
    const file = write(workflow(["owner: '@ana'"]));
    const code = await validate([file]);
    const plain = answerersWarnings();
    warnSpy.mockClear();
    exitSpy.mockClear();
    const strict = await validate([file, '--strict']);
    // (1) red when no warning is made, or it is an error; (2) prints the exit codes and warnings.
    expect({ code, plain, strict, strictWarnings: answerersWarnings() }).toEqual({
      code: 0,
      plain: [W6],
      strict: 1,
      strictWarnings: [W6],
    });
  });

  it('check 12: `register --strict` stores nothing and exits 1; `register` stores it and says W6', async () => {
    manifest(READS_REPLIES);
    write(workflow(["owner: '@ana'"]));
    const strict = await exitOf(() =>
      registerCommand.parseAsync([dir, '--strict'], { from: 'user' }),
    );
    const storedAfterStrict = (await h.home.workflowStore.list()).map((d) => d.id);
    warnSpy.mockClear();
    exitSpy.mockClear();
    const plain = await exitOf(() => registerCommand.parseAsync([dir], { from: 'user' }));
    // (1) red when the warning is made in validate.ts alone (register never sees it); (2) prints the
    //     exit codes, what was stored and the warnings.
    expect({
      strict,
      storedAfterStrict,
      plain,
      warnings: answerersWarnings(),
      stored: (await h.home.workflowStore.list()).map((d) => d.id),
    }).toEqual({
      strict: 1,
      storedAfterStrict: [],
      plain: 0,
      warnings: [W6],
      stored: ['answerers'],
    });
  });

  it('check 12: `validate --registered` says W6 on the stored copy', async () => {
    manifest(undefined);
    write(workflow(["owner: '@ana'"]));
    expect(await exitOf(() => registerCommand.parseAsync([dir], { from: 'user' }))).toBe(0);
    manifest(READS_REPLIES);
    warnSpy.mockClear();
    exitSpy.mockClear();
    const code = await validate(['--registered', 'answerers']);
    // (1) red when --registered does not make the warning; (2) prints them.
    expect({ code, warnings: answerersWarnings() }).toEqual({ code: 0, warnings: [W6] });
  });

  it("check 12: owner '@ana' with answerers [U1] — W6b", async () => {
    manifest(READS_REPLIES);
    const code = await validate([write(workflow(["owner: '@ana'", 'answerers: [U1]']))]);
    // (1) red when a partly-closed gate is not named; (2) prints them.
    expect({ code, warnings: answerersWarnings() }).toEqual({ code: 0, warnings: [W6B] });
  });

  it.each([
    [
      'a notifier that does not read replies (no app_token or signing_secret)',
      ['bot_token: xoxb-1', 'channel_id: C1'],
    ],
    ['a notifier with no channel_id', ['bot_token: xoxb-1', 'app_token: xapp-1']],
    ['a notifier with no bot_token', ['channel_id: C1', 'signing_secret: s', 'events_port: 3100']],
    ['no Slack notifier', undefined],
  ])('check 12: with %s — no warning', async (_label, config) => {
    manifest(config);
    const code = await validate([write(workflow(["owner: '@ana'"]))]);
    // (1) red when the warning is made without the notifier condition; (2) prints them.
    expect({ code, warnings: answerersWarnings() }).toEqual({ code: 0, warnings: [] });
  });

  it("check 13: a project `answerers` entry '@ana' refuses realm.yaml at load, naming the entry", async () => {
    manifest([...READS_REPLIES, "answerers: ['@ana']"]);
    const code = await validate([write(workflow([]))]);
    // (1) red when the entry check is removed (the list loads and matches no reply); (2) prints
    //     the errors.
    expect({
      code,
      named: lines(errSpy).some((l) =>
        l.includes(
          "notifiers.slack_gate: 'answerers' entry '@ana' is not a Slack member ID (U… or W…, or its mention), so it would match no reply.",
        ),
      ),
    }).toEqual({ code: 1, named: true });
  });
});
