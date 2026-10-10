// paste-safe-625.test.ts — issue #625 PR-2a, the last prompt's F6 (review G5-5, RED): a printed command is
// safe to paste. Every value a printed command carries goes through core's one quoter (`shellWord`), so the
// line, pasted into a POSIX shell, records exactly the value it names and runs nothing the value holds.
// Each PRINTED LINE — `realm run advance` at an open question, `realm workflow run`'s hand-back, `realm run
// drain`'s refusal, and `realm run advance`'s way back in after a failed step — is run in `bash -c` with the
// built `realm` on PATH. The `$(touch "$T/ran")` choice is the payload: its red side runs it, so it only
// ever touches this test's own temporary folder.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  JsonFileStore,
  JsonWorkflowStore,
  executeStep,
  describePending,
  oneOf,
  respondCommand,
  sentenceEnd,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  type RunRecord,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { renderDetachMap } from './run.js';
import { buildReattachFlags } from './agent.js';
import { inFlightLine } from '../lib/holder-render.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '../../dist/index.js');

/** (a) red when the CHANGELOG no longer holds the sentence word for word; (b) prints it. */
function changelogSays(sentence: string): void {
  const flat = (t: string) => t.replace(/\s+/g, ' ');
  expect(
    flat(readFileSync(join(HERE, '../../../../CHANGELOG.md'), 'utf8')),
    `CHANGELOG.md no longer says: ${sentence}`,
  ).toContain(flat(sentence));
}

/** A question whose one choice is `choice` (so the printed command carries the value itself). */
const asking = (id: string, choices: string[]): WorkflowDefinition => ({
  id,
  name: id,
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    ask: {
      description: 'Ask.',
      execution: 'auto',
      trust: 'human_confirmed',
      depends_on: [],
      gate: { choices },
    },
  },
});

/** The hard values: a space, a command substitution, a pipe, a quote, the empty choice. */
const CHOICES: Array<[string, (t: string) => string]> = [
  ['a space', () => 'only one'],
  ['a command substitution', (t) => `$(touch "${t}/ran")`],
  ['a pipe', () => 'a|b'],
  ['a quote', () => "it's"],
  ['the empty choice', () => ''],
];

describe('#625 PR-2a, F6 — a printed command is safe to paste', { timeout: 60_000 }, () => {
  let home: string;
  let T: string;
  let bin: string;
  let runStore: JsonFileStore;
  let workflowStore: JsonWorkflowStore;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'realm-paste-625-'));
    T = mkdtempSync(join(tmpdir(), 'realm-paste-625-t-'));
    bin = join(home, 'bin');
    mkdirSync(join(home, '.realm', 'workflows'), { recursive: true });
    mkdirSync(join(home, '.realm', 'runs'), { recursive: true });
    mkdirSync(bin);
    writeFileSync(join(bin, 'realm'), `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`);
    chmodSync(join(bin, 'realm'), 0o755);
    runStore = new JsonFileStore(join(home, '.realm', 'runs'));
    workflowStore = new JsonWorkflowStore(join(home, '.realm', 'workflows'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(T, { recursive: true, force: true });
  });

  const env = () => ({ PATH: `${bin}:${process.env['PATH'] ?? ''}`, HOME: home, NO_COLOR: '1' });

  function realm(...args: string[]) {
    const r = spawnSync(process.execPath, [CLI, ...args], {
      cwd: home,
      env: env(),
      encoding: 'utf8',
      timeout: 60_000,
    });
    return { code: r.status, out: r.stdout.split('\n'), err: r.stderr.split('\n') };
  }

  /** The printed line pasted into bash, as a person would. */
  function paste(line: string) {
    const r = spawnSync('bash', ['-c', line], {
      cwd: home,
      env: env(),
      encoding: 'utf8',
      timeout: 60_000,
    });
    return { code: r.status, out: r.stdout, err: r.stderr };
  }

  /** The command at the end of a printed line: from its last `realm ` to the end. */
  const commandOf = (line: string | undefined) =>
    line === undefined ? '<no line>' : line.slice(line.lastIndexOf('realm '));

  /** A run at its question, the question's choices as given. */
  async function atQuestion(choices: string[], id: string) {
    const def = asking(id, choices);
    await workflowStore.register(def);
    const { run } = await runStore.create({ workflowId: def.id, workflowVersion: 1, params: {} });
    const opened = await executeStep(runStore, def, {
      runId: run.id,
      command: 'ask',
      input: {},
      dispatcher: async () => ({}),
    });
    if (opened.status !== 'confirm_required') throw new Error(`fixture: ${opened.status}`);
    return { def, runId: run.id, gateId: opened.gate!.gate_id };
  }

  /** What the question's answer recorded: the choice, or `<open>` while the question is still open. */
  const recorded = async (runId: string) => {
    const run = await runStore.get(runId);
    return run.pending_gate !== undefined ? '<open>' : (run.settled?.['ask']?.choice ?? '<none>');
  };

  for (const [label, make] of CHOICES) {
    it(`${label}: realm run advance's line, the hand-back's line and drain's line, each pasted into bash, record exactly that choice and run nothing`, async () => {
      changelogSays(
        'Such a line pasted into a shell records exactly the value it names and runs nothing the value holds; a choice with a space was split, and `$(…)` was run.',
      );
      const choice = make(T);
      const lines: Record<string, string> = {};
      // realm run advance at an open question.
      const a = await atQuestion([choice], `paste-adv-${CHOICES.findIndex(([l]) => l === label)}`);
      lines['advance'] = commandOf(
        realm('run', 'advance', a.runId).out.find((l) => l.includes('a question is open')),
      );
      // realm workflow run's hand-back (its map at a question).
      const h = await atQuestion([choice], `paste-map-${CHOICES.findIndex(([l]) => l === label)}`);
      const record = await runStore.get(h.runId);
      lines['hand-back'] = commandOf(
        renderDetachMap(record, 'ask', {
          pending: describePending(h.def, record, undefined, new Date()),
          workflow: h.def,
        })
          .split('\n')
          .find((l) => l.trim().startsWith('Respond:')),
      );
      // realm run drain on a run waiting on its question.
      const d = await atQuestion(
        [choice],
        `paste-drain-${CHOICES.findIndex(([l]) => l === label)}`,
      );
      lines['drain'] = commandOf(
        [...realm('run', 'drain', d.runId).out].find((l) => l.includes('realm run respond')),
      );
      const runs = { advance: a.runId, 'hand-back': h.runId, drain: d.runId };
      const results: Record<string, unknown> = {};
      for (const [surface, line] of Object.entries(lines)) {
        const pasted = paste(line);
        results[surface] = {
          code: pasted.code,
          recorded: await recorded(runs[surface as keyof typeof runs]),
          endsWithoutFullStop: sentenceEnd(`answer it: ${line}`) === `answer it: ${line}`,
        };
      }
      // (a) red when a value is printed bare where the shell splits, expands or runs it (the old
      //     `--choice ${c}`), or a full stop follows a quoted value; (b) prints each line and result.
      expect({ lines, results, ran: existsSync(join(T, 'ran')) }).toEqual({
        lines,
        results: Object.fromEntries(
          Object.keys(lines).map((surface) => [
            surface,
            { code: 0, recorded: choice, endsWithoutFullStop: true },
          ]),
        ),
        ran: false,
      });
    });
  }

  it("two choices, one holding '>' (yes> and no): one <one of: …> placeholder, each member quoted; bash refuses it as typed, nothing is recorded; sentenceEnd adds no full stop", async () => {
    const q = await atQuestion(['yes>', 'no'], 'paste-two');
    const line = commandOf(
      realm('run', 'advance', q.runId).out.find((l) => l.includes('a question is open')),
    );
    const pasted = paste(line);
    // (a) red when a member is printed bare (`yes>` would be read as a redirection and the line run),
    //     the placeholder is split, or a full stop follows it; (b) prints the line and the result.
    expect({
      line,
      refused: pasted.code !== 0,
      recorded: await recorded(q.runId),
      ran: existsSync(join(home, 'no')),
      end: sentenceEnd(`answer it: ${line}`) === `answer it: ${line}`,
    }).toEqual({
      line: `realm run respond ${q.runId} --gate ${q.gateId} --choice <one of: 'yes>', no>`,
      refused: true,
      recorded: '<open>',
      ran: false,
      end: true,
    });
  });

  it('several choices still print one <one of: …> placeholder (preservation)', () => {
    // (a) red when several choices stop being one placeholder; (b) prints the commands.
    expect({
      several: respondCommand('R', 'G', ['approve', 'reject']),
      fromSeveral: oneOf(['a', 'b']),
      one: oneOf(['approve']),
    }).toEqual({
      several: 'realm run respond R --gate G --choice <one of: approve, reject>',
      fromSeveral: '<one of: a, b>',
      one: 'approve',
    });
  });

  it("realm run advance's way back in after a failed step: the step name quoted, the line pasted runs `realm run resume` on exactly that step", async () => {
    changelogSays(
      'The offer of `realm run resume` ends with its command: `To make the failed step runnable again: realm run resume <id> --from <step>`',
    );
    changelogSays(
      '`To make the failed step runnable again: realm run resume <run> --from <step>` (the command last, nothing after it)',
    );
    const step = "it's a step";
    const def: WorkflowDefinition = {
      id: 'paste-resume',
      name: 'paste-resume',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: { [step]: { description: 'S.', execution: 'agent', depends_on: [] } },
    };
    await workflowStore.register(def);
    const { run } = await runStore.create({ workflowId: def.id, workflowVersion: 1, params: {} });
    await runStore.update({
      ...(await runStore.get(run.id)),
      failed_steps: [step],
      terminal_state: true,
      run_phase: 'failed',
      sealed_by: { arm: 'step_failure', step },
    } as RunRecord);
    const reason = realm('run', 'advance', run.id).out.find((l) => l.includes('realm run resume'));
    const line = commandOf(reason);
    const pasted = paste(line);
    // (a) red when the step name is printed bare (the shell splits it and resume names no such step),
    //     or a full stop follows the command; (b) prints the line and the run's phase after it.
    expect({
      line,
      code: pasted.code,
      phase: (await runStore.get(run.id)).run_phase,
      end: sentenceEnd(reason ?? '') === reason,
    }).toEqual({
      line: `realm run resume ${run.id} --from 'it'\\''s a step'`,
      code: 0,
      phase: 'running',
      end: true,
    });
  });

  it("realm agent's re-attach flags and realm run abandon's rerun line are the same as before (preservation)", async () => {
    // (a) red when core's quoter writes a value differently than the CLI's own did; (b) prints them.
    expect(
      buildReattachFlags({
        provider: 'anthropic',
        model: 'claude x',
        baseUrl: "http://h/it's",
        extensionsModule: './ext.mjs',
      }),
    ).toBe(
      "--provider anthropic --model 'claude x' --base-url 'http://h/it'\\''s' --extensions-module ./ext.mjs",
    );
    const def = asking('paste-abandon', ['ok']);
    await workflowStore.register(def);
    const { run } = await runStore.create({
      workflowId: def.id,
      workflowVersion: 1,
      params: { note: "it's" },
    });
    const r = realm('run', 'abandon', run.id);
    const again = r.out.find((l) => l.startsWith('To run the same work again:')) ?? '<none>';
    expect(again).toContain(`--params '{"note":"it'\\''s"}'`);
  });

  it("the in-flight watch line's reclaim command (#706's): a step name with a space and a quote, quoted; the line ends with the command", () => {
    const line = inFlightLine(
      'R',
      "it's held",
      {
        holder: { by: 'other', by_source: 'stated', channel: 'agent' },
        since: '2026-01-01T00:00:00.000Z',
      },
      false,
      60_000,
    );
    // (a) red when the step name is printed bare (`--step it's held` — an unterminated quote, the
    //     command refused or run on another step); (b) prints the line's command.
    expect(commandOf(line)).toBe("realm run reclaim R --step 'it'\\''s held' --force");
  });
});
