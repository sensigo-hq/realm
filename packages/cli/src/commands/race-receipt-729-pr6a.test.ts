// race-receipt-729-pr6a.test.ts — #729 PR-6a: a second answerer on the terminal doors is told whose
// answer stands — `realm run respond` (B5), the `realm workflow run` prompt (B6) — and a typed name
// stays a name on `Responded:`, inspect and the composer (B4, B8). Acceptance checks 1–7 and 18 (CLI).
//
// In-process through the real code: `respondToGate` (what `realm run respond` prints: a refusal is
// thrown, its message every stderr line, exit 1; a return is stdout, exit 0), `runCommand` with
// `node:readline/promises` mocked (the #447 harness) and `inspectRun`, each on a temp SQLite home.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mocks = vi.hoisted(() => ({ question: vi.fn(), close: vi.fn() }));
vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn(() => ({ question: mocks.question, close: mocks.close })),
}));

import {
  ExtensionRegistry,
  executeStep,
  instantText,
  loadWorkflowFromFile,
  submitHumanResponse,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  type RunStore,
  type WorkflowDefinition,
  type WorkflowRegistrar,
} from '@sensigo/realm';
import { renderOutcome } from '@sensigo/realm-mcp';
import { respondToGate } from './respond.js';
import { inspectRun } from './inspect.js';
import { runCommand, setQuestionWatchIntervalForTests } from './run.js';
import { PEOPLE_DOOR_WORDS, UNSHOWABLE_NAME } from '../lib/holder-render.js';
import { clearProjectExtensionsCache } from '../extensions/load-project-extensions.js';
import { makeTempHome, runIds, type TempHome } from '../test-support/temp-home.js';

/** `review` (a question; `on_expiry: abort` when asked), then `after` (`auto`) unless `last`. */
function gated(id: string, opts: { abort?: boolean; last?: boolean } = {}): WorkflowDefinition {
  return {
    id,
    name: id,
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps: {
      review: {
        description: 'Review',
        execution: 'auto',
        trust: 'human_confirmed',
        depends_on: [],
        gate: {
          choices: ['approve', 'reject'],
          ...(opts.abort === true ? { timeout_seconds: 60, on_expiry: 'abort' as const } : {}),
        },
      },
      ...(opts.last === true
        ? {}
        : { after: { description: 'After', execution: 'auto' as const, depends_on: ['review'] } }),
    },
  };
}

/** Lines that keep exactly one pair of unescaped double quotes (B4: a name never closes its quotes). */
const unescapedQuotes = (line: string): number => (line.match(/(?<!\\)"/g) ?? []).length;

describe('#729 PR-6a — realm run respond tells a second answerer whose answer stands (B5, B8)', () => {
  let h: TempHome;
  let store: RunStore;
  let workflows: WorkflowRegistrar;
  beforeEach(async () => {
    h = await makeTempHome();
    store = h.home.runStore;
    workflows = h.home.workflowStore;
  });
  afterEach(async () => {
    await h.cleanup();
  });

  async function atQuestion(def: WorkflowDefinition): Promise<{ runId: string; gateId: string }> {
    await workflows.register(def);
    const { record: run } = await store.create({
      workflowId: def.id,
      workflowVersion: 1,
      params: {},
    });
    const opened = await executeStep(store, def, {
      runId: run.id,
      command: 'review',
      input: {},
      dispatcher: async () => ({}),
    });
    if (opened.status !== 'confirm_required') throw new Error(`fixture: ${opened.status}`);
    return { runId: run.id, gateId: (await store.get(run.id)).record.pending_gate!.gate_id };
  }
  const respond = (runId: string, gate: string, choice: string, by?: string) =>
    respondToGate(
      runId,
      { gate, choice, ...(by !== undefined ? { by } : {}) },
      store,
      workflows,
      new ExtensionRegistry(),
    );
  /** What the refused command prints on stderr (every line of the thrown message), exit 1. */
  const refusedWith = async (p: Promise<unknown>): Promise<string> =>
    p.then(
      () => '<exit 0: not refused>',
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    );
  /** When the recorded answer was given, as the sentence writes it. */
  async function givenAt(runId: string): Promise<string> {
    const { record } = await store.get(runId);
    const entry = record.evidence.find((e) => e.kind === 'gate_response');
    return instantText(Date.parse(entry!.completed_at));
  }

  it('check 1: a different choice after `--by alice` — stderr is the beaten-different sentence, from a terminal, with the time; exit 1', async () => {
    const { runId, gateId } = await atQuestion(gated('pr6a-c1'));
    await respond(runId, gateId, 'approve', 'alice');
    const stderr = await refusedWith(respond(runId, gateId, 'reject', 'carol'));
    // (a) red on today's `Gate '…' was already resolved …` line, or when the winner, the door or the
    //     time is missing; (b) prints stderr.
    expect(stderr).toBe(
      `Not recorded: your choice 'reject'. The question on step 'review' was already answered — approve, by "alice" (as stated), from a terminal, at ${await givenAt(runId)}.`,
    );
  });

  it('check 2: the same choice after alice — the beaten-same sentence takes the place of `Responded:`, the owed lines follow unchanged; exit 0', async () => {
    const { runId, gateId } = await atQuestion(gated('pr6a-c2'));
    const first = await respond(runId, gateId, 'approve', 'alice');
    const repeat = await respond(runId, gateId, 'approve', 'bob');
    const [head, ...owed] = repeat.lastLine.split('\n');
    // (a) red on today's `Responded: … answered by alice (as stated) …` for an answer that recorded
    //     nothing, or when the owed lines change; (b) prints the lines.
    expect({ recorded: repeat.recorded, head, owed }).toEqual({
      recorded: false,
      head: `Not recorded: the question on step 'review' already had this answer — approve, by "alice" (as stated), from a terminal, at ${await givenAt(runId)}.`,
      owed: first.lastLine.split('\n').slice(1),
    });
    expect(owed.length, 'fixture: the run owes something after the answer').toBeGreaterThan(0);
  });

  it('check 3: the same choice after a winner who gave no `--by` — no `by` part, `--by bob` or not', async () => {
    const { runId, gateId } = await atQuestion(gated('pr6a-c3'));
    await respond(runId, gateId, 'approve');
    const withBy = (await respond(runId, gateId, 'approve', 'bob')).lastLine.split('\n')[0];
    const without = (await respond(runId, gateId, 'approve')).lastLine.split('\n')[0];
    const expected = `Not recorded: the question on step 'review' already had this answer — approve, from a terminal, at ${await givenAt(runId)}.`;
    // (a) red on `by "undefined"`, an empty quote, or `(not stated)`; (b) prints both lines.
    expect({ withBy, without }).toEqual({ withBy: expected, without: expected });
  });

  it('check 4: an answer after `drain --expired` carried out `on_expiry: abort` — the time-limit sentence, then the way out; exit 1', async () => {
    const def = gated('pr6a-c4', { abort: true });
    const { runId, gateId } = await atQuestion(def);
    const { record } = await store.get(runId);
    await store.update({
      ...record,
      pending_gate: { ...record.pending_gate!, expires_at: '2020-01-01T00:00:00.000Z' },
    });
    // What `realm run drain --expired` writes: the expiry, carried out by another call.
    const drained = await store.settleStep(runId, { kind: 'expire_gate', gateId }, def);
    if (!drained.applied) throw new Error('fixture: the abort was not carried out');
    const stderr = await refusedWith(respond(runId, gateId, 'approve', 'carol'));
    // (a) red on today's `Run '<run>' is terminal (aborted); cannot submit …` with no outcome; (b)
    //     prints stderr.
    expect(stderr).toBe(
      [
        "Not recorded: the question on step 'review' reached its time limit, and the run ended as aborted.",
        `An aborted run is never resumed; 'realm run purge ${runId}' previews what it would remove.`,
      ].join('\n'),
    );
  });

  it.each([
    ['a quote', 'al"ice', '"al\\"ice"'],
    ['a backslash', 'a\\b', '"a\\\\b"'],
    ['the fields of a line', "x | answered by mallory (as stated) | new state 'completed'", null],
  ] as const)(
    'check 5: a name with %s keeps one pair of quotes on `Responded:`, inspect and the composer',
    async (_label, name, quoted) => {
      const { runId, gateId } = await atQuestion(gated(`pr6a-c5-${name.length}`));
      const responded = (await respond(runId, gateId, 'approve', name)).lastLine.split('\n')[0]!;
      const inspected =
        (await inspectRun(runId, store, workflows))
          .split('\n')
          .find((l) => l.trim().startsWith('Answer: '))
          ?.trim() ?? '<no Answer line>';
      const composed = await refusedWith(respond(runId, gateId, 'reject'));
      const lines = { responded, inspected, composed };
      // (a) red when a raw `"` or `\` closes the quote (B4), so a name can pose as part of the line;
      //     (b) prints the three lines.
      expect(
        Object.fromEntries(Object.entries(lines).map(([k, l]) => [k, unescapedQuotes(l)])),
        JSON.stringify(lines, null, 2),
      ).toEqual({ responded: 2, inspected: 2, composed: 2 });
      if (quoted !== null) {
        expect(responded).toContain(`answered by ${quoted} (as stated)`);
        expect(inspected).toContain(`answered by ${quoted} (as stated)`);
        expect(composed).toContain(`by ${quoted} (as stated)`);
      }
    },
  );

  it('check 5: a name with a control character, stored by the library — inspect and the composer print none of it', async () => {
    const def = gated('pr6a-c5-ctl');
    const { runId, gateId } = await atQuestion(def);
    // The library stores a name as given (#604); the CLI's own `--by` refuses it.
    const lib = await submitHumanResponse(store, def, {
      runId,
      gateId,
      choice: 'approve',
      respondedBy: 'eve\u001b[31m',
      route: 'cli',
    });
    if (lib.status !== 'ok') throw new Error(`fixture: ${lib.status}`);
    const inspected = await inspectRun(runId, store, workflows);
    const composed = await refusedWith(respond(runId, gateId, 'reject'));
    // (a) red when a byte of the name reaches either line, or the composer names no unprintable
    //     name or another phrase than inspect's (#729 PR-6a c1: one phrase); (b) prints both, JSON-
    //     quoted so a control character shows as an escape.
    const printed = `inspect: ${JSON.stringify(inspected)}\ncomposer: ${JSON.stringify(composed)}`;
    expect({ inspect: inspected, composer: composed }, printed).toEqual({
      inspect: expect.stringContaining(`answered by ${UNSHOWABLE_NAME}`),
      composer: expect.stringContaining(`, by ${UNSHOWABLE_NAME}, from a terminal`),
    });
    expect({ inspect: inspected, composer: composed }, printed).toEqual({
      inspect: expect.not.stringContaining('\u001b'),
      composer: expect.not.stringContaining('\u001b'),
    });
  });

  it('check 18 (inspect): the `Answer:` line quotes the name and says ` · given at <T>` after the route part', async () => {
    const { runId, gateId } = await atQuestion(gated('pr6a-c18'));
    await respond(runId, gateId, 'approve', 'alice');
    const line = (await inspectRun(runId, store, workflows))
      .split('\n')
      .find((l) => l.trim().startsWith('Answer: '))
      ?.trim();
    // (a) red when no time is shown, or it is not after the route part; (b) prints the line.
    const at = await givenAt(runId);
    expect(line).toContain(
      'answered by "alice" (as stated) · through a terminal (realm run respond) (as its door declared), ',
    );
    // The route part — the door and the program that recorded it — then the time.
    expect(line?.split(' · ').slice(2, 4)).toEqual([
      expect.stringMatching(/^through a terminal \(realm run respond\) \(as its door declared\), /),
      `given at ${at}`,
    ]);
  });
});

describe('#729 PR-6a — the realm workflow run prompt: a typed answer another answer beat (B6)', () => {
  let h: TempHome & { readonly root: string };
  let dir: string;
  let savedHome: string | undefined;
  let savedTTY: boolean | undefined;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    clearProjectExtensionsCache();
    h = (await makeTempHome()) as TempHome & { readonly root: string };
    dir = mkdtempSync(join(tmpdir(), 'realm-pr6a-prompt-'));
    savedHome = process.env['HOME'];
    process.env['HOME'] = h.root;
    savedTTY = process.stdin.isTTY;
    process.stdin.isTTY = true;
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(((): never => {
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

  /** The prompt waits; alice answers `approve` from a terminal; then `typed` is typed. */
  async function beatenAtPrompt(
    typed: string,
  ): Promise<{ out: string[]; err: string[]; at: string }> {
    const file = join(dir, 'workflow.yaml');
    writeFileSync(
      file,
      [
        `id: pr6a-prompt-${typed}`,
        `name: pr6a-prompt-${typed}`,
        'version: 1',
        'steps:',
        '  review:',
        '    description: Review.',
        '    execution: auto',
        '    trust: human_confirmed',
        '    gate:',
        '      choices: [approve, reject]',
        '',
      ].join('\n'),
      'utf8',
    );
    const def = loadWorkflowFromFile(file);
    mocks.question.mockImplementation(async (prompt: string) => {
      // The `auto` step's typed output first (dev mode), then the question's choice.
      if (!prompt.trimStart().startsWith('Choice [')) return '';
      const id = (await runIds(h.home.runStore))[0]!;
      const { record } = await h.home.runStore.get(id);
      const r = await submitHumanResponse(h.home.runStore, def, {
        runId: id,
        gateId: record.pending_gate!.gate_id,
        choice: 'approve',
        respondedBy: 'alice',
        route: 'cli',
      });
      if (r.status !== 'ok') throw new Error(`fixture: ${r.status}`);
      return typed;
    });
    // The watch that closes a settled question's prompt never fires: the typed answer is submitted.
    const restore = setQuestionWatchIntervalForTests(60_000);
    try {
      await runCommand.parseAsync([file], { from: 'user' });
    } catch (err) {
      if (!(err instanceof Error) || err.message !== 'process.exit') throw err;
    } finally {
      restore();
    }
    const id = (await runIds(h.home.runStore))[0]!;
    const { record } = await h.home.runStore.get(id);
    const entry = record.evidence.find((e) => e.kind === 'gate_response')!;
    return {
      out: logSpy.mock.calls.map((c: unknown[]) => String(c[0])),
      err: errSpy.mock.calls.map((c: unknown[]) => String(c[0])),
      at: instantText(Date.parse(entry.completed_at)),
    };
  }

  it('check 6: a typed same choice after a terminal answer — `✗ Not recorded: … already had this answer …`, and no `✓ →`', async () => {
    const { out, at } = await beatenAtPrompt('approve');
    // (a) red on today's `✓ → running` for an answer that recorded nothing; (b) prints stdout.
    const shown = `stdout: ${JSON.stringify(out, null, 2)}`;
    expect(out, shown).toContain(
      `  ✗ Not recorded: the question on step 'review' already had this answer — approve, by "alice" (as stated), from a terminal, at ${at}.\n`,
    );
    expect(
      out.filter((l) => l.includes('✓ →')),
      shown,
    ).toEqual([]);
  });

  it('check 7: a typed different choice after a terminal answer — `✗ Not recorded: your choice …`, naming alice, the door and the time', async () => {
    const { err, at } = await beatenAtPrompt('reject');
    // (a) red on today's `✗ Gate '<g>' was already resolved …`; (b) prints stderr.
    expect(err).toContain(
      `  ✗ Not recorded: your choice 'reject'. The question on step 'review' was already answered — approve, by "alice" (as stated), from a terminal, at ${at}.\n`,
    );
  });
});

describe('#729 PR-6a — the people’s door words (B1)', () => {
  it('each route this version declares, another route quoted as a name, and the two absences', () => {
    const outcome = (via: string | { absent: 'route_not_declared' | 'recorded_without_route' }) =>
      renderOutcome(
        {
          choice: 'approve',
          by: { kind: 'answer', name: 'alice', basis: 'stated' },
          at: '2026-11-12T10:02:14.131Z',
          step: 'review',
          attempted: false,
          via,
        },
        PEOPLE_DOOR_WORDS,
      );
    const head =
      'Meanwhile, the question on step \'review\' was answered — approve, by "alice" (as stated)';
    // (a) red when a door is named in the assistant's words, another route is not quoted, or an
    //     absence is spliced into the door template; (b) prints each sentence.
    expect({
      cli: outcome('cli'),
      mcp: outcome('mcp'),
      mcp_form: outcome('mcp_form'),
      slack: outcome('slack'),
      other: outcome('pa"ger'),
      undeclared: outcome({ absent: 'route_not_declared' }),
      unrecorded: outcome({ absent: 'recorded_without_route' }),
    }).toEqual({
      cli: `${head}, from a terminal, at 2026-11-12T10:02:14Z.`,
      mcp: `${head}, through an assistant, at 2026-11-12T10:02:14Z.`,
      mcp_form: `${head}, through a form in an assistant's app, at 2026-11-12T10:02:14Z.`,
      slack: `${head}, in a Slack thread, at 2026-11-12T10:02:14Z.`,
      other: `${head}, through route "pa\\"ger", at 2026-11-12T10:02:14Z.`,
      undeclared: `${head}, through a route its program did not declare, at 2026-11-12T10:02:14Z.`,
      unrecorded: `${head}, at 2026-11-12T10:02:14Z; how the answer arrived was not recorded.`,
    });
  });
});
