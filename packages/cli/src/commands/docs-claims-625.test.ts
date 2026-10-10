// docs-claims-625.test.ts — issue #625 PR-2a, decision C163 (the method): each sentence about what a
// command prints that #625 PR-2a adds or changes in `docs/reference/workflow/gates.md` (and the
// `realm run resume` part of `docs/reference/mcp/tools.md`'s `resolve_precondition` row) is pinned
// here, one cell per command and case. Each cell quotes its sentence exactly and asserts the page
// still holds it (read from the repository), then runs the built `realm` (a child process, a fresh
// HOME) and asserts what the sentence states — so neither the page nor the behaviour can change alone.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  JsonFileStore,
  JsonWorkflowStore,
  ExtensionRegistry,
  advanceRun,
  executeStep,
  loadWorkflowFromString,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
} from '@sensigo/realm';
import type { WorkflowDefinition } from '@sensigo/realm';
import { sweepExpiredGates } from './listen.js';
import { readFileSync as readDoc625 } from 'node:fs';
import { join as joinDoc625, dirname as dirDoc625 } from 'node:path';
import { fileURLToPath as urlDoc625 } from 'node:url';
import { lagless } from '../test-support/lag.js';

/** C174: (a) red when the page no longer holds the sentence word for word; (b) prints it. */
function claimDoc625(page: string, sentence: string): void {
  const text = readDoc625(
    joinDoc625(dirDoc625(urlDoc625(import.meta.url)), '../../../..', page),
    'utf8',
  );
  expect(text.replace(/\s+/g, ' '), `${page} no longer says: ${sentence}`).toContain(
    sentence.replace(/\s+/g, ' '),
  );
}

const HERE = dirname(fileURLToPath(import.meta.url));
const DOCS = join(HERE, '../../../../docs/reference');
const CLI = join(HERE, '../../dist/index.js');
const flat = (t: string) => t.replace(/\s+/g, ' ');

/** (a) red when the page no longer holds the sentence word for word; (b) prints the sentence. */
function claim(
  page:
    | 'workflow/gates.md'
    | 'mcp/tools.md'
    | 'core-library.md'
    | 'cli/realm-workflow.md'
    | 'cli/realm-run-acting.md',
  sentence: string,
): void {
  expect(
    flat(readFileSync(join(DOCS, page), 'utf8')),
    `${page} no longer says: ${sentence}`,
  ).toContain(flat(sentence));
}

/** `confirm` (a question, `on_expiry` as given, default `approve`), then `after`, a bare `auto` step. */
const gateThenAuto = (
  id: string,
  onExpiry?: 'settle_default' | 'abort' | 'finding_only',
): WorkflowDefinition =>
  ({
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
          ...(onExpiry !== undefined ? { on_expiry: onExpiry } : {}),
          ...(onExpiry === 'settle_default' ? { default_choice: 'approve' } : {}),
        },
      },
      after: { description: 'After', execution: 'auto', depends_on: ['confirm'] },
    },
  }) as WorkflowDefinition;

// Each cell runs the built `realm` several times as a child process: 60 s, not vitest's default 5 s.
describe(
  '#625 PR-2a, C163 — gates.md: what the commands print, sentence by sentence, from the built realm',
  { timeout: 60_000 },
  () => {
    let home: string;
    let runStore: JsonFileStore;
    let workflowStore: JsonWorkflowStore;

    beforeEach(() => {
      home = mkdtempSync(join(tmpdir(), 'realm-625-docs-cli-'));
      mkdirSync(join(home, '.realm', 'workflows'), { recursive: true });
      mkdirSync(join(home, '.realm', 'runs'), { recursive: true });
      runStore = new JsonFileStore(join(home, '.realm', 'runs'));
      workflowStore = new JsonWorkflowStore(join(home, '.realm', 'workflows'));
    });
    afterEach(() => rmSync(home, { recursive: true, force: true }));

    /** Runs the built `realm` with this HOME; returns exit, stdout and stderr (lines). */
    function realm(...args: string[]): { code: number | null; out: string[]; err: string[] } {
      const r = spawnSync(process.execPath, [CLI, ...args], {
        cwd: home,
        env: { PATH: process.env['PATH'] ?? '', HOME: home, NO_COLOR: '1' },
        encoding: 'utf8',
        timeout: 60_000,
      });
      return { code: r.status, out: r.stdout.split('\n'), err: r.stderr.split('\n') };
    }

    /** Registers the workflow, opens its question; `expired` moves the question's time into the past. */
    async function atQuestion(
      def: WorkflowDefinition,
      expired = true,
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
      if (expired) {
        const record = await runStore.get(run.id);
        await runStore.update({
          ...record,
          pending_gate: {
            ...record.pending_gate!,
            opened_at: '2020-01-01T00:00:00.000Z',
            expires_at: '2020-01-01T01:00:00.000Z',
          },
        });
      }
      return { runId: run.id, gateId: opened.gate!.gate_id };
    }

    const answerLine = (runId: string): string =>
      realm('run', 'inspect', runId)
        .out.find((l) => l.trim().startsWith('Answer: '))
        ?.trim() ?? '<no Answer line>';

    it('C163 gates.md: realm run list --stuck names realm run advance for settle_default and abort, realm run respond for finding_only', async () => {
      claimDoc625(
        'docs/reference/mcp/run-state-and-health.md',
        '| `<step>=gate_expired(<on_expiry>) (realm run advance)`, or `<step>=gate_expired(finding_only) (realm run respond)` |',
      );
      claim(
        'workflow/gates.md',
        'The two dispositions the engine carries out name `realm run advance`, which carries them out now; the finding-only one names `realm run respond`.',
      );
      claim('workflow/gates.md', 'approve=gate_expired(settle_default) (realm run advance)');
      claim('workflow/gates.md', 'approve=gate_expired(abort) (realm run advance)');
      const a = await atQuestion(gateThenAuto('dc-list-default', 'settle_default'));
      const b = await atQuestion(gateThenAuto('dc-list-abort', 'abort'));
      const c = await atQuestion(gateThenAuto('dc-list-finding', 'finding_only'));
      claim(
        'workflow/gates.md',
        'Until a call carries the expiry out, the run is listed as expired:',
      );
      const listed = realm('run', 'list').out;
      for (const id of [a.runId, b.runId, c.runId]) {
        expect(listed.find((l) => l.startsWith(id.slice(0, 8))) ?? '').toMatch(/EXPIRED/);
      }
      const out = realm('run', 'list', '--stuck').out;
      const row = (id: string) =>
        out.find((l) => l.startsWith(id.slice(0, 8))) ?? `<no row for ${id}>`;
      // (a) red when a disposition names another command, or none; (b) prints the rows.
      expect(row(a.runId)).toContain('confirm=gate_expired(settle_default) (realm run advance)');
      expect(row(b.runId)).toContain('confirm=gate_expired(abort) (realm run advance)');
      expect(row(c.runId)).toContain('confirm=gate_expired(finding_only) (realm run respond)');
    });

    it('C163 gates.md: an expired question stays open until a call acts on its run — realm run advance carries it out; realm run drain --expired --force carries it out', async () => {
      claim(
        'workflow/gates.md',
        'A gate whose time is up stays open until a call acts on its run: a late answer, a call to another step of the run, `advance_run` (or `realm run advance`, or `advanceRun` in a program), `realm run drain --expired`, or `realm listen` started with `--sweep-expired-gates`.',
      );
      const a = await atQuestion(gateThenAuto('dc-open-adv', 'settle_default'));
      const b = await atQuestion(gateThenAuto('dc-open-drain', 'settle_default'));
      // (a) red when an expired question is carried out with no call, or a listed call does not carry it out; (b) prints the record.
      expect((await runStore.get(a.runId)).pending_gate?.gate_id).toBe(a.gateId);
      expect(realm('run', 'advance', a.runId).code).toBe(0);
      expect((await runStore.get(a.runId)).pending_gate).toBeUndefined();
      const drained = realm('run', 'drain', b.runId, '--expired', '--force');
      expect(drained.code, drained.err.join('\n')).toBe(0);
      expect((await runStore.get(b.runId)).pending_gate).toBeUndefined();
    });

    it('C163 gates.md: the sweep `realm listen --sweep-expired-gates` runs on its interval carries an expired question out', async () => {
      claim('workflow/gates.md', 'or `realm listen` started with `--sweep-expired-gates`.');
      const { runId } = await atQuestion(gateThenAuto('dc-listen', 'settle_default'));
      const logger = { info: () => {}, warn: () => {}, error: () => {} };
      const swept = await sweepExpiredGates({ runStore, workflowStore, logger } as never);
      // (a) red when the sweep leaves an expired, enactable question open; (b) prints its result.
      expect(swept.enacted).toBe(1);
      expect((await runStore.get(runId)).pending_gate).toBeUndefined();
    });

    it('C163 gates.md: realm run advance prints the expiry line first, after ⚠, naming advance — before the steps it runs', async () => {
      claim(
        'workflow/gates.md',
        '`realm run advance` prints that line first, after `⚠ ` (`this advance call …`), before the steps it runs;',
      );
      const { runId, gateId } = await atQuestion(gateThenAuto('dc-adv-line', 'settle_default'));
      const r = realm('run', 'advance', runId);
      // F1: the line says how long before the call the question's time was up — `<lag>` in its place.
      const out = lagless(r.out);
      const all = [...out, ...lagless(r.err)];
      const line = `⚠ gate '${gateId}' on 'confirm' had expired <lag> before this call — this advance call first carried out its declared settle_default: the default choice 'approve' was recorded (enacted_via: advance).`;
      // (a) red when the line is not printed, or prints after a step; (b) prints the output.
      expect(all.filter((l) => l === line)).toHaveLength(1);
      expect(out.indexOf(line) === -1 || out.indexOf(line) < out.indexOf('→ after')).toBe(true);
      expect(r.out).toContain('→ after');
    });

    it('C163 gates.md: realm run respond, late — the line first (this respond call), before the refusal; then Not recorded: and what the run owes', async () => {
      claim(
        'workflow/gates.md',
        'an answer that came after the time was up and carried the expiry out prints it first too, before its refusal or the sentence that says it was not recorded — through `realm run respond` (`this respond call …`)',
      );
      claim(
        'workflow/gates.md',
        "It prints `Not recorded:`, with the choice the gate was settled with and the run's phase, and after it the lines an answer in time prints after `Responded:`: what the run owes (`Owed to the engine: … — realm run advance <id> …`, an agent step that is ready, or the steps that cannot run).",
      );
      // F1: the late answer is told how late it was.
      claim(
        'workflow/gates.md',
        'An answer that finds the expired question still open is also told how late it was: its line says how long before the answer the time was up (`had expired 15s before this call`)',
      );
      const { runId, gateId } = await atQuestion(gateThenAuto('dc-respond-late', 'settle_default'));
      const r = realm('run', 'respond', runId, '--gate', gateId, '--choice', 'reject');
      const err = r.err.filter((l) => l !== '');
      // (a) red when the order changes or a line goes; (b) prints stderr.
      expect(r.code).toBe(1);
      // F1: the question's time ended in 2020 (the fixture), so the lag is days and hours.
      // (a) red when the line says no lag, or a lag not in days; (b) prints the line.
      expect(err[0]).toMatch(/had expired \d+d \d+h before this call — /);
      expect(lagless(err[0] ?? '')).toBe(
        `⚠ gate '${gateId}' on 'confirm' had expired <lag> before this call — this respond call first carried out its declared settle_default: the default choice 'approve' was recorded (enacted_via: respond).`,
      );
      expect(err[1]).toBe(
        `Gate '${gateId}' was settled by timeout with choice 'approve' — your choice 'reject' was not recorded.`,
      );
      expect(err[2]).toBe(
        `Not recorded: ${runId} | gate settled by timeout with choice 'approve' | state 'running'`,
      );
      expect(err[3]).toMatch(
        new RegExp(`^Owed to the engine: 'after' — realm run advance ${runId} `),
      );
    });

    it('C163 gates.md (C178): a late answer after another call carried the expiry out — its first line, Not recorded:, what the run owes; a different choice is told it was settled by timeout', async () => {
      claim(
        'workflow/gates.md',
        "The late answer then prints its first line, `Not recorded:` and what the run owes; a different choice is told `was settled by timeout with choice 'ship'`, as the call that carried the expiry out is told:",
      );
      const { runId, gateId } = await atQuestion(
        gateThenAuto('dc-respond-after', 'settle_default'),
      );
      const drained = realm('run', 'drain', runId, '--expired', '--force');
      expect(drained.code, drained.err.join('\n')).toBe(0);
      const r = realm('run', 'respond', runId, '--gate', gateId, '--choice', 'reject');
      const err = r.err.filter((l) => l !== '');
      // (a) red when the refusal or its lines change; (b) prints stderr.
      expect(err[0]).toBe(
        `Gate '${gateId}' was settled by timeout with choice 'approve' — your choice 'reject' was not recorded.`,
      );
      expect(err[1]).toBe(
        `Not recorded: ${runId} | gate settled by timeout with choice 'approve' | state 'running'`,
      );
      expect(err[2]).toMatch(/^Owed to the engine: 'after' — realm run advance /);
      expect(err.some((l) => l.startsWith('⚠ '))).toBe(false);
    });

    it('C147/C163 gates.md: inspect prints `(no answer in time)` — when no answer came, and when one came late and was not recorded', async () => {
      claimDoc625(
        'docs/reference/cli/realm-run-reading.md',
        "The outputs in this section are from version 0.46.0, except the lines marked as added after it and the `Answer:` line of an answer the gate's expiry wrote, which 0.46.0 prints as `(no one answered)`.",
      );
      claim(
        'workflow/gates.md',
        "On the gate's step, `realm run inspect` prints `Answer: hold · settled by the gate's expiry (no answer in time)` — no answer came before the time was up, or one came after it and was not recorded —",
      );
      const none = await atQuestion(gateThenAuto('dc-inspect-none', 'settle_default'));
      realm('run', 'advance', none.runId);
      const late = await atQuestion(gateThenAuto('dc-inspect-late', 'settle_default'));
      realm('run', 'respond', late.runId, '--gate', late.gateId, '--choice', 'reject');
      // (a) red when either case reads otherwise; (b) prints the line.
      expect(answerLine(none.runId)).toBe(
        "Answer: approve · settled by the gate's expiry (no answer in time)",
      );
      expect(answerLine(late.runId)).toBe(
        "Answer: approve · settled by the gate's expiry (no answer in time)",
      );
    });

    it.each([
      ['stated', 'nightly@box (as stated, via cron)'],
      ['ambient', 'nightly@box (from REALM_OPERATOR, via cron)'],
      ['derived', 'nightly@box (from the OS user, via cron)'],
    ] as const)(
      'C163 core-library.md: advanceRun with a driver (%s) — written as driven_by on the auto step it runs; realm run inspect shows it as Taken by:',
      async (bySource, shown) => {
        claim(
          'core-library.md',
          "`driver` (your program's name, `{ by, by_source, channel }`: written as `driven_by` on the evidence of each `auto` step the call runs, which `realm run inspect` shows as `Taken by:`",
        );
        claim(
          'core-library.md',
          "`realm run inspect` shows a step's driver as `Taken by: <by> (as stated, via <channel>)`, `(from REALM_OPERATOR, via <channel>)` or `(from the OS user, via <channel>)`.",
        );
        const def = {
          id: `dc-taken-${bySource}`,
          name: 'taken',
          version: 1,
          schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
          steps: { only: { description: 'O.', execution: 'auto', depends_on: [] } },
        } as WorkflowDefinition;
        await workflowStore.register(def);
        const { run } = await runStore.create({
          workflowId: def.id,
          workflowVersion: 1,
          params: {},
        });
        await advanceRun(runStore, def, {
          runId: run.id,
          driver: { by: 'nightly@box', by_source: bySource, channel: 'cron' },
        });
        const out = realm('run', 'inspect', run.id).out.map((l) => l.trim());
        // (a) red when the driver is not written, or inspect words it otherwise; (b) prints inspect.
        expect(out, out.join('\n')).toContain(`Taken by: ${shown}`);
      },
    );

    it('C160 tools.md: a failed step in a run that goes on — realm run resume refuses the running run; after abandon, resume --from makes it runnable', async () => {
      claim(
        'mcp/tools.md',
        'one that has failed runs again only after [`realm run resume --from <step>`](../cli/realm-run-acting.md#resume) makes it runnable, and `resume` takes only a run that has ended (`failed` or `abandoned`): while the run goes on, end it first with `abandon_run`;',
      );
      const def = {
        id: 'dc-resume',
        name: 'dc-resume',
        version: 1,
        schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
        steps: {
          a: { description: 'A.', execution: 'agent', depends_on: [] },
          b: { description: 'B.', execution: 'agent', depends_on: [] },
        },
      } as WorkflowDefinition;
      await workflowStore.register(def);
      const { run } = await runStore.create({ workflowId: def.id, workflowVersion: 1, params: {} });
      await executeStep(runStore, def, {
        runId: run.id,
        command: 'a',
        input: {},
        dispatcher: async () => {
          throw new Error('the step broke');
        },
      });
      const failed = await runStore.get(run.id);
      expect([failed.failed_steps, failed.run_phase], 'fixture').toEqual([['a'], 'running']);
      const refused = realm('run', 'resume', run.id, '--from', 'a');
      // (a) red when resume takes a running run, or no longer takes an abandoned one; (b) prints the output.
      expect(refused.code).toBe(1);
      expect(refused.err.join('\n')).toContain("is in phase 'running', which is not resumable");
      expect(realm('run', 'abandon', run.id).code).toBe(0);
      const resumed = realm('run', 'resume', run.id, '--from', 'a');
      expect(resumed.code, resumed.err.join('\n')).toBe(0);
      const after = await runStore.get(run.id);
      expect([after.run_phase, after.failed_steps]).toEqual(['running', []]);
      const again = await executeStep(runStore, def, {
        runId: run.id,
        command: 'a',
        input: {},
        dispatcher: async () => ({}),
      });
      expect(again.status).toBe('ok');
    });

    it('C164, W1-Y1/W2-Y1: realm run respond, after the command an answer leaves, says a waiting realm workflow run or realm agent goes on by itself — true whether or not one waits', async () => {
      claim(
        'cli/realm-run-acting.md',
        "After the lines that name a command — `Owed to the engine: …`, `An agent step is ready: …` — one more line says that a `realm workflow run` or `realm agent` still waiting on the run goes on by itself (`the lines above are` when there are two): the run's record does not show whether one is waiting, so the line holds either way.",
      );
      const { runId, gateId } = await atQuestion(gateThenAuto('dc-attend'), false);
      const r = realm('run', 'respond', runId, '--gate', gateId, '--choice', 'approve');
      const out = r.out.filter((l) => l !== '');
      // (a) red when the line is gone, comes before the command, or claims to know; (b) prints stdout.
      expect(out[1]).toMatch(/^Owed to the engine: 'after' — realm run advance /);
      expect(out[2]).toBe(
        'If a realm workflow run or realm agent is still waiting on this run, it goes on by itself; the line above is for when none is.',
      );
      // Nothing on the record tells a waiting process from none (it writes nothing while it waits).
      const rec = await runStore.get(runId);
      expect(Object.keys(rec).filter((k) => /attend|lease|watch/.test(k))).toEqual([]);
    });

    it('C166, W1-Y3: realm run respond, advance and drain act on a run only once its workflow is registered', async () => {
      claim(
        'cli/realm-workflow.md',
        'Those read the workflow from the registry, so they act on the run only once it is registered (`realm workflow register <file>`): for a workflow never registered, `realm run respond`, `realm run advance` and `realm run drain` are refused with `Workflow not found: <id> — …`, and `realm listen` skips the run.',
      );
      const def = gateThenAuto('dc-unregistered', 'settle_default');
      const { run } = await runStore.create({ workflowId: def.id, workflowVersion: 1, params: {} });
      const opened = await executeStep(runStore, def, {
        runId: run.id,
        command: 'confirm',
        input: {},
        dispatcher: async () => ({}),
      });
      const gateId = opened.gate!.gate_id;
      // The question's time is up, so `drain --expired` has something to act on.
      const open = await runStore.get(run.id);
      await runStore.update({
        ...open,
        pending_gate: { ...open.pending_gate!, expires_at: '2020-01-01T00:00:00.000Z' },
      });
      for (const args of [
        ['run', 'respond', run.id, '--gate', gateId, '--choice', 'approve'],
        ['run', 'advance', run.id],
        ['run', 'drain', run.id, '--expired', '--force'],
      ]) {
        const r = realm(...args);
        // (a) red when one of them acts on a run whose workflow is not registered; (b) prints stderr.
        expect([...r.out, ...r.err].join('\n'), args.join(' ')).toContain(
          `Workflow not found: ${def.id} — `,
        );
      }
      expect((await runStore.get(run.id)).pending_gate?.gate_id).toBe(gateId);
      const logger = { info: () => {}, warn: () => {}, error: () => {} };
      const swept = await sweepExpiredGates({ runStore, workflowStore, logger } as never);
      expect([swept.enacted, swept.skipped_unregistered]).toEqual([0, 1]);
    });

    it('C170 gates.md: an answer after the abort is refused with the aborted run’s way out (realm run respond)', async () => {
      claimDoc625(
        'docs/reference/cli/realm-run-acting.md',
        "| The run has ended | `Run '00b33778-…' is terminal (aborted); cannot submit a gate response — an aborted run is never resumed; 'realm run purge 00b33778-…' previews what it would remove.` The words after the dash name the way out that kind of ending has, as `submit_human_response` names it: see [A run that has ended](../mcp/tools.md#a-run-that-has-ended). |",
      );
      claim(
        'workflow/gates.md',
        "Run '063dee23-e68e-4d7f-bcc2-968dd764370c' is terminal (aborted); cannot submit a gate response — an aborted run is never resumed; 'realm run purge 063dee23-e68e-4d7f-bcc2-968dd764370c' previews what it would remove.",
      );
      const { runId, gateId } = await atQuestion(gateThenAuto('dc-aborted', 'abort'));
      expect(realm('run', 'advance', runId).code).toBe(0);
      const r = realm('run', 'respond', runId, '--gate', gateId, '--choice', 'approve');
      expect(r.err.filter((l) => l !== '')).toContain(
        `Run '${runId}' is terminal (aborted); cannot submit a gate response — an aborted run is never resumed; 'realm run purge ${runId}' previews what it would remove.`,
      );
    });

    it.each(['completed', 'aborted', 'failed', 'abandoned'] as const)(
      'C170, W4-Y1: realm run resume takes a %s run exactly when the refusal offers it (a failed step); realm run purge --force removes the record',
      async (kind) => {
        claim(
          'mcp/tools.md',
          "for a failed one in which a step `realm run resume` takes failed (that step named, several as `<one of: a, b>`; never a cleanup step, which `resume --from` refuses), `'realm run resume' takes none of the steps that failed (<steps>), so it has nothing to run again; 'realm run purge <id>' previews what it would remove.` for a failed one in which only steps it does not take failed, and `no step failed, so 'realm run resume' has nothing to run again; 'realm run purge <id>' previews what it would remove.` for a failed one in which none did.",
        );
        let runId: string;
        let step: string;
        if (kind === 'completed' || kind === 'aborted') {
          const def =
            kind === 'completed' ? gateThenAuto('dc-r-done') : gateThenAuto('dc-r-abort', 'abort');
          const q = await atQuestion(def, kind === 'aborted');
          runId = q.runId;
          step = 'confirm';
          if (kind === 'completed') {
            realm('run', 'respond', runId, '--gate', q.gateId, '--choice', 'approve');
          }
          realm('run', 'advance', runId);
        } else {
          const def = {
            id: `dc-r-${kind}`,
            name: 'r',
            version: 1,
            schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
            steps: {
              a: {
                description: 'A.',
                execution: 'agent',
                depends_on: [],
                validation_exhaustion: { threshold: 1 },
                input_schema: {
                  type: 'object',
                  properties: { n: { type: 'integer' } },
                  required: ['n'],
                },
              },
            },
          } as unknown as WorkflowDefinition;
          await workflowStore.register(def);
          const { run } = await runStore.create({
            workflowId: def.id,
            workflowVersion: 1,
            params: {},
          });
          runId = run.id;
          step = 'a';
          if (kind === 'failed') {
            for (let i = 0; i < 3; i += 1) {
              await executeStep(runStore, def, {
                runId,
                command: 'a',
                input: { n: 'x' },
                dispatcher: async () => ({}),
              });
            }
          } else {
            expect(realm('run', 'abandon', runId).code).toBe(0);
          }
        }
        expect((await runStore.get(runId)).run_phase, 'fixture').toBe(kind);
        // `realm run purge --force` on a copy of the ended run (purge refuses a run that goes on, so it
        // is tried while the run is still ended), then `resume` on the run itself.
        const ended = await runStore.get(runId);
        const copy = (
          await runStore.create({ workflowId: ended.workflow_id, workflowVersion: 1, params: {} })
        ).run;
        await runStore.update({ ...ended, id: copy.id, version: copy.version });
        expect((await runStore.get(copy.id)).run_phase, 'fixture copy').toBe(kind);
        const purged = realm('run', 'purge', copy.id, '--force');
        expect(purged.code, [...purged.out, ...purged.err].join('\n')).toBe(0);
        await expect(runStore.get(copy.id)).rejects.toMatchObject({ code: 'STATE_RUN_NOT_FOUND' });
        const resumed = realm('run', 'resume', runId, '--from', step);
        // (a) red when resume takes a kind the refusal says it does not, or refuses one it offers; (b) prints it.
        // `resume` takes the run exactly when the refusal offers it: a failed step to run again.
        expect(resumed.code, [...resumed.out, ...resumed.err].join('\n')).toBe(
          kind === 'failed' ? 0 : 1,
        );
      },
    );

    it('C204 (round 27 finding 4): realm run respond on a run whose step and cleanup step failed offers `--from s` only, and `resume --from` takes it; once only the cleanup step is failed, it offers none', async () => {
      claim(
        'mcp/tools.md',
        "for a failed one in which a step `realm run resume` takes failed (that step named, several as `<one of: a, b>`; never a cleanup step, which `resume --from` refuses), `'realm run resume' takes none of the steps that failed (<steps>), so it has nothing to run again; 'realm run purge <id>' previews what it would remove.` for a failed one in which only steps it does not take failed",
      );
      const def = loadWorkflowFromString(
        [
          'id: dc-r28-clean',
          'name: dc-r28-clean',
          'version: 1',
          'steps:',
          '  s:',
          '    description: S.',
          '    execution: auto',
          '    handler: boom',
          '  clean:',
          '    description: Clean up.',
          '    execution: finalizer',
          '    handler: boom',
          '    on_outcome: fail',
          '',
        ].join('\n'),
      );
      await workflowStore.register(def);
      const registry = new ExtensionRegistry();
      registry.register('handler', 'boom', {
        id: 'boom',
        execute: async () => {
          throw new Error('it broke');
        },
      });
      const { run } = await runStore.create({ workflowId: def.id, workflowVersion: 1, params: {} });
      const runId = run.id;
      // `s` fails, the run seals failed, and its cleanup step runs and fails too.
      await advanceRun(runStore, def, { runId, registry });
      const failed = await runStore.get(runId);
      expect([failed.run_phase, failed.failed_steps], 'fixture').toEqual([
        'failed',
        ['s', 'clean'],
      ]);
      const purge = `'realm run purge ${runId}' previews what it would remove`;
      const respond = () => realm('run', 'respond', runId, '--gate', 'any', '--choice', 'approve');
      const first = respond();
      const fromClean = realm('run', 'resume', runId, '--from', 'clean');
      const fromS = realm('run', 'resume', runId, '--from', 's');
      const abandoned = realm('run', 'abandon', runId);
      const cleanOnly = await runStore.get(runId);
      const second = respond();
      // F2: once an operator abandoned the run it is told that ending, never offered the undo.
      // (a) red when the refusal offers the cleanup step, offers no step while `s` failed, or offers
      //     the undo for the operator's ending; or when resume refuses the step offered; (b) prints them.
      expect({
        first: [first.code, first.err.filter((l) => l !== '')],
        fromClean: fromClean.code,
        fromS: [fromS.code, fromS.err.filter((l) => l !== '')],
        abandoned: abandoned.code,
        cleanOnly: [cleanOnly.run_phase, cleanOnly.failed_steps],
        second: [second.code, second.err.filter((l) => l !== '')],
      }).toEqual({
        first: [
          1,
          [
            `Run '${runId}' is terminal (failed); cannot submit a gate response — ${purge}; to make the failed step runnable again: realm run resume ${runId} --from s`,
          ],
        ],
        fromClean: 1,
        fromS: [0, []],
        abandoned: 0,
        cleanOnly: ['abandoned', ['clean']],
        second: [
          1,
          [
            `Run '${runId}' is terminal (abandoned); cannot submit a gate response — an operator ended this run, with the reason "Abandoned via realm run abandon"; to run the work again, start a new run; ${purge}.`,
          ],
        ],
      });
    });

    it('C164 (the sweep’s member): an answer that leaves both a command and an agent step says "the lines above are"', async () => {
      claim(
        'cli/realm-run-acting.md',
        'one more line says that a `realm workflow run` or `realm agent` still waiting on the run goes on by itself (`the lines above are` when there are two)',
      );
      const def = {
        ...gateThenAuto('dc-attend-two'),
        steps: {
          ...gateThenAuto('dc-attend-two').steps,
          ask: { description: 'Ask', execution: 'agent', depends_on: ['confirm'] },
        },
      } as WorkflowDefinition;
      const { runId, gateId } = await atQuestion(def, false);
      const r = realm('run', 'respond', runId, '--gate', gateId, '--choice', 'approve');
      const out = r.out.filter((l) => l !== '');
      // (a) red when the two-command form says "the line above is"; (b) prints stdout.
      expect(out.slice(1).map((l) => l.slice(0, 30))).toEqual([
        "Owed to the engine: 'after' — ",
        "An agent step is ready: 'ask' ",
        'If a realm workflow run or rea',
      ]);
      expect(out[3]).toBe(
        'If a realm workflow run or realm agent is still waiting on this run, it goes on by itself; the lines above are for when none is.',
      );
    });
  },
);
