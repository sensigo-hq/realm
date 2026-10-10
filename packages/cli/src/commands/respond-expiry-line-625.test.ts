// respond-expiry-line-625.test.ts — issue #625 PR-2a, round 19 (the fresh walk on the final build):
// - decision C146 (W3-Y1): `realm run respond` answering after the question's time is up prints the
//   line that says which call carried out the expiry — `this respond call …` (or another call) —
//   through core's composer, the one the MCP reply and `realm run advance` print; first, with
//   `realm run advance`'s `⚠ `; both `on_expiry` kinds;
// - decision C151 (W5-Y2): every CLI call of an engine function that can carry out an expiry passes
//   its command's own name as `caller` (a source-text witness: the hosts that print no reply line);
// - decision C147 (W3-Y2): `realm run inspect` then says `settled by the gate's expiry (no answer in
//   time)` — true when a late answer came and was not recorded, and when none came.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  JsonFileStore,
  JsonWorkflowStore,
  advanceRun,
  executeStep,
  expiryCarriedOutLine,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
} from '@sensigo/realm';
import type { RunRecord, WorkflowDefinition } from '@sensigo/realm';
import { respondCommand } from './respond.js';
import { inspectRun } from './inspect.js';
import { clearProjectExtensionsCache } from '../extensions/load-project-extensions.js';
import { lagless } from '../test-support/lag.js';

/** `confirm` (a question, `on_expiry` as given, default `approve`), then `after`, a bare `auto` step. */
const gateThenAuto = (id: string, onExpiry: 'settle_default' | 'abort'): WorkflowDefinition => ({
  id,
  name: id,
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    confirm: {
      description: 'Confirm',
      execution: 'auto',
      trust: 'human_confirmed',
      depends_on: [],
      gate: {
        choices: ['approve', 'reject'],
        timeout_seconds: 3600,
        on_expiry: onExpiry,
        ...(onExpiry === 'settle_default' ? { default_choice: 'approve' } : {}),
      },
    },
    after: { description: 'After', execution: 'auto', depends_on: ['confirm'] },
  },
});

describe('#625 PR-2a, C146/C147 — a late `realm run respond` says which call carried out the expiry; inspect says no answer came in time', () => {
  let home: string;
  let project: string;
  let savedHome: string | undefined;
  let runStore: JsonFileStore;
  let workflowStore: JsonWorkflowStore;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clearProjectExtensionsCache();
    home = mkdtempSync(join(tmpdir(), 'realm-625-c146-home-'));
    project = mkdtempSync(join(tmpdir(), 'realm-625-c146-project-'));
    mkdirSync(join(home, '.realm', 'workflows'), { recursive: true });
    savedHome = process.env['HOME'];
    process.env['HOME'] = home;
    runStore = new JsonFileStore();
    workflowStore = new JsonWorkflowStore();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('process.exit');
    }) as never);
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = savedHome;
    vi.restoreAllMocks();
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  // F1: the expiry line's lag follows the clock (these questions expired in 2020) — `<lag>` in its
  // place, in what was printed and in the line each cell expects.
  const stdout = (): string[] =>
    lagless(logSpy.mock.calls.flatMap((c: unknown[]) => String(c[0]).split('\n')));
  const stderr = (): string[] =>
    lagless(errSpy.mock.calls.flatMap((c: unknown[]) => String(c[0]).split('\n')));

  /** Registers the workflow, creates a run, opens the question, and moves its expiry into the past. */
  async function expiredQuestion(
    def: WorkflowDefinition,
  ): Promise<{ runId: string; gateId: string }> {
    await workflowStore.register(def);
    const { run } = await runStore.create({ workflowId: def.id, workflowVersion: 1, params: {} });
    const opened = await executeStep(runStore, def, {
      runId: run.id,
      command: 'confirm',
      input: {},
      dispatcher: async () => ({}),
    });
    if (opened.status !== 'confirm_required') throw new Error(`fixture: ${opened.status}`);
    const record: RunRecord = await runStore.get(run.id);
    await runStore.update({
      ...record,
      pending_gate: {
        ...record.pending_gate!,
        opened_at: '2020-01-01T00:00:00.000Z',
        expires_at: '2020-01-01T01:00:00.000Z',
      },
    });
    return { runId: run.id, gateId: opened.gate!.gate_id };
  }

  async function respond(runId: string, gateId: string, choice: string): Promise<number> {
    try {
      await respondCommand.parseAsync(
        [runId, '--gate', gateId, '--choice', choice, '--project', project],
        { from: 'user' },
      );
      return 0;
    } catch (err) {
      if (!(err instanceof Error) || err.message !== 'process.exit') throw err;
      return Number(exitSpy.mock.calls[0]?.[0]);
    }
  }

  const answerLine = async (runId: string): Promise<string> => {
    const out = await inspectRun(runId, runStore, workflowStore);
    return (
      out.split('\n').find((l) => l.trim().startsWith('Answer: ')) ?? `<no Answer line:\n${out}>`
    );
  };

  it('C146, W3-Y1: settle_default, another choice — `⚠ … this respond call first carried out …` first, then the refusal; stderr, exit 1; C147: inspect says no answer in time', async () => {
    const { runId, gateId } = await expiredQuestion(
      gateThenAuto('c146-sd-other', 'settle_default'),
    );
    const code = await respond(runId, gateId, 'reject');
    const line = lagless(
      expiryCarriedOutLine(
        gateId,
        'confirm',
        { on_expiry: 'settle_default', choice: 'approve' },
        'respond',
        0,
      ),
    );
    // (a) red when the late arm drops the line, prints it after the refusal, or names another call;
    //     (b) prints stderr.
    expect(stderr().slice(0, 3)).toEqual([
      `⚠ ${line}`,
      `Gate '${gateId}' was settled by timeout with choice 'approve' — your choice 'reject' was not recorded.`,
      `Not recorded: ${runId} | gate settled by timeout with choice 'approve' | state 'running'`,
    ]);
    expect(line).toContain('this respond call first carried out its declared settle_default');
    expect(line).toContain('(enacted_via: respond).');
    expect({ code, stdout: stdout() }).toEqual({ code: 1, stdout: [] });
    // (a) red when inspect says "no one answered" again (a late answer DID come); (b) prints the line.
    expect(await answerLine(runId)).toBe(
      "     Answer: approve · settled by the gate's expiry (no answer in time)",
    );
  });

  it('C146: settle_default, the same choice — the line first, then the same-choice sentence; stdout, exit 0', async () => {
    const { runId, gateId } = await expiredQuestion(gateThenAuto('c146-sd-same', 'settle_default'));
    const code = await respond(runId, gateId, 'approve');
    // (a) red when the same-choice arm drops the line or prints it later; (b) prints stdout.
    expect(stdout().slice(0, 3)).toEqual([
      `⚠ ${lagless(expiryCarriedOutLine(gateId, 'confirm', { on_expiry: 'settle_default', choice: 'approve' }, 'respond', 0))}`,
      'the outcome matches your choice, but it was settled by timeout; your response was not recorded.',
      `Not recorded: ${runId} | gate settled by timeout with choice 'approve' | state 'running'`,
    ]);
    expect({ code, stderr: stderr() }).toEqual({ code: 0, stderr: [] });
  });

  it('C146: abort — `⚠ … this respond call first carried out its declared abort: the run ended …` first, then the refusal; stderr, exit 1', async () => {
    const { runId, gateId } = await expiredQuestion(gateThenAuto('c146-abort', 'abort'));
    const code = await respond(runId, gateId, 'reject');
    // (a) red when the abort arm drops the line or names another call; (b) prints stderr.
    expect(stderr()).toEqual([
      `⚠ ${lagless(expiryCarriedOutLine(gateId, 'confirm', { on_expiry: 'abort' }, 'respond', 0))}`,
      `Gate '${gateId}' on 'confirm' expired and the run aborted per the workflow's declared on_expiry — your choice was NOT recorded.`,
    ]);
    expect({ code, stdout: stdout() }).toEqual({ code: 1, stdout: [] });
  });

  it('C146: another call carried the expiry out before the answer came — no expiry line (this call carried out nothing), the answer refused as already resolved', async () => {
    const def = gateThenAuto('c146-other', 'settle_default');
    const { runId, gateId } = await expiredQuestion(def);
    await advanceRun(runStore, def, { runId });
    const code = await respond(runId, gateId, 'reject');
    // (a) red when respond claims a carrying-out it did not do; (b) prints both streams.
    expect([...stdout(), ...stderr()].some((l) => l.includes('had expired'))).toBe(false);
    expect({ code, stderr: stderr(), stdout: stdout() }).toEqual({
      code: 1,
      stderr: [
        // decision C178: the expiry recorded the winning choice, and the refusal says so.
        `Gate '${gateId}' was settled by timeout with choice 'approve' — your choice 'reject' was not recorded.`,
        `Not recorded: ${runId} | gate settled by timeout with choice 'approve' | state 'completed'`,
      ],
      stdout: [],
    });
    // C147: no answer came in time here either.
    expect(await answerLine(runId)).toBe(
      "     Answer: approve · settled by the gate's expiry (no answer in time)",
    );
  });
});

describe('#625 PR-2a, C151 — every CLI call that can carry out an expiry names its command', () => {
  const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
  /** Each file's engine calls, in order, and the `caller` each passes (`-` when none). */
  function callersIn(file: string): string[] {
    const code = readFileSync(join(SRC, file), 'utf8');
    const out: string[] = [];
    for (const m of code.matchAll(
      /await (executeChain|submitHumanResponse|executeEngineStep|advanceRun)\(/g,
    )) {
      let i = code.indexOf('{', m.index);
      const start = i;
      for (let depth = 0; i < code.length; i++) {
        if (code[i] === '{') depth++;
        else if (code[i] === '}' && --depth === 0) break;
      }
      const options = code.slice(start, i + 1);
      out.push(`${m[1]}:${/\bcaller: '([a-zA-Z_]+)'/.exec(options)?.[1] ?? '-'}`);
    }
    return out;
  }

  it('C151, W5-Y2: realm agent, realm workflow run, realm run respond and realm run advance pass their own names', () => {
    // (a) red when a call stops passing its command's name (the library default would name the
    //     function), or a new engine call passes none; (b) prints each file's calls.
    expect({
      'agent/run-agent.ts': callersIn('agent/run-agent.ts'),
      'agent/gate/slack-gate-notifier.ts': callersIn('agent/gate/slack-gate-notifier.ts'),
      'commands/run.ts': callersIn('commands/run.ts'),
      'commands/respond.ts': callersIn('commands/respond.ts'),
      'commands/run-advance.ts': callersIn('commands/run-advance.ts'),
    }).toEqual({
      'agent/run-agent.ts': ['advanceRun:agent', 'executeEngineStep:agent', 'executeChain:agent'],
      'agent/gate/slack-gate-notifier.ts': ['submitHumanResponse:agent'],
      'commands/run.ts': ['submitHumanResponse:run', 'executeChain:run'],
      'commands/respond.ts': ['submitHumanResponse:respond'],
      // F7 (a): one call — the preview at an open question calls no writer.
      'commands/run-advance.ts': ['advanceRun:advance'],
    });
  });
});
