// held-doors-922-p22.test.ts — #922 P2-2 (prompt fix-922-p2-2-cli-doors.md; checks 1, 2, 3, 5, 6, 8, 9,
// 10, 11): every CLI door names each held step's state and what frees it, from the built `realm`, on
// runs held as a store writes them (a claim past its deadline written with a past deadline). `realm
// run advance` exits 1 when the only thing it waits on is steps past their deadline. The reclaim dry
// run lists each held step's command, and that command, run as printed from another folder, frees
// it. `--all` frees each pick only while it is the claim it selected. `realm run inspect` lists each
// held step's command and a reclaim as its own line in the step's history.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure: exit
// codes and lines, run ids and instants put in place.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  executeStep,
  loadWorkflowFromString,
  loadWorkflowFromStringWithDiagnostics,
  reclaimStep,
  type ClaimRecord,
  type RunStore,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { makeTempHome, type TempHome } from '../test-support/temp-home.js';
import { reclaimPicks, selectAutoReclaims } from './reclaim.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '../../dist/index.js');

const plus = (ms: number): string => new Date(Date.now() + ms).toISOString();
const SINCE = new Date(Date.now() - 3_600_000).toISOString();
const PAST = plus(-90_000);
const NOT_IDEMPOTENT = 'It is not declared idempotent, so running it again may repeat its effects.';
const UNKNOWN = 'so whether its program still runs is not known; if it does, the step runs twice.';
const OTHER = { by: 'other@host', by_source: 'derived' as const, channel: 'advance' as const };
const FOOTER =
  "Reclaim re-drives a step (at-least-once — side effects may repeat). Run a step's command above to free it. realm run reclaim --all lists, across every run, the claims past their deadline whose steps are idempotent; with --force it frees them.";

/**
 * `x` an engine step not declared idempotent, `i` one declared idempotent, `a` an agent step, `z` an
 * engine step whose handler no program here has (it cannot run).
 */
const DEF: WorkflowDefinition = loadWorkflowFromString(
  [
    'id: held-doors-922',
    'name: held-doors-922',
    'version: 1',
    'steps:',
    '  x:',
    '    description: x.',
    '    execution: auto',
    '  i:',
    '    description: i.',
    '    execution: auto',
    '    idempotent: true',
    '  a:',
    '    description: a.',
    '    execution: agent',
    '  z:',
    '    description: z.',
    '    execution: auto',
    '    handler: nope',
    '',
  ].join('\n'),
);
const ALL = ['x', 'i', 'a', 'z'];

let h: TempHome & { readonly root: string };
let runStore: RunStore;
let elsewhere: string;

beforeEach(async () => {
  h = await makeTempHome();
  runStore = h.home.runStore;
  await h.home.workflowStore.register(DEF);
  elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'realm-922-p22-elsewhere-')));
});
afterEach(async () => {
  await h.cleanup();
  rmSync(elsewhere, { recursive: true, force: true });
});

/** The built `realm`, run from a folder that is not the home's nor a project's. */
function realm(args: string[]): { code: number | null; out: string[]; err: string[] } {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: elsewhere,
    env: { PATH: process.env['PATH'] ?? '', HOME: h.root, NO_COLOR: '1', REALM_NO_NUDGE: '1' },
    encoding: 'utf8',
    timeout: 60_000,
  });
  const lines = (t: string): string[] => t.split('\n').filter((l) => l !== '');
  return { code: r.status, out: lines(r.stdout), err: lines(r.stderr) };
}

/**
 * A run with `held` in progress, each with its claim (`undefined`: none recorded), every other step
 * of `DEF` completed unless named in `open`.
 */
async function held(
  claims: Record<string, ClaimRecord | undefined>,
  open: string[] = [],
  workflowId = DEF.id,
): Promise<string> {
  const { record } = await runStore.create({ workflowId, workflowVersion: 1, params: {} });
  const written: Record<string, ClaimRecord> = {};
  for (const [step, claim] of Object.entries(claims))
    if (claim !== undefined) written[step] = claim;
  await runStore.update({
    ...record,
    in_progress_steps: Object.keys(claims),
    completed_steps: ALL.filter((s) => !(s in claims) && !open.includes(s)),
    claims: written,
  });
  return record.id;
}

const past = (): ClaimRecord => ({ deadline: PAST, token: 't', since: SINCE });
const pastLine = (step: string, id: string, idempotent = false): string =>
  `'${step}' was claimed and its deadline passed at ${PAST}; no result is recorded for it.${idempotent ? '' : ` ${NOT_IDEMPOTENT}`} To free it, run: realm run reclaim ${id} --step ${step} --claimed-at ${SINCE} --force`;

/** The command a line prints after `To free it…, run: `, as arguments (its first word is `realm`). */
const printed = (lines: string[]): string[] =>
  (/To free it(?: anyway)?, run: (realm .+)$/m.exec(lines.join('\n'))?.[1] ?? '')
    .split(' ')
    .slice(1);

// each cell starts the built CLI up to four times: 30 s a cold start, the budget on the block
describe(
  '#922 P2-2 — `realm run advance` on held steps (checks 1, 2, 3)',
  { timeout: 180_000 },
  () => {
    it('check 1, the bug’s screen: the only blocker is a step past its deadline — its state and the command, no "wait", exit 1', async () => {
      const id = await held({ x: past() });
      const r = realm(['run', 'advance', id]);
      // (a) red when the old held line comes back, "wait" is said for a step past its deadline, or the
      //     exit is 0; (b) prints the exit and the last line.
      expect({
        code: r.code,
        last: r.out.at(-1),
        wait: r.out.filter((l) => /wait/.test(l)),
      }).toEqual({
        code: 1,
        last: `The engine can run nothing now: ${pastLine('x', id)}`,
        wait: [],
      });
    });

    it('check 2, the mixes: past + ahead → 0; past + a ready agent step → 0; past + a step that cannot run → 1', async () => {
      const ahead = await held({
        x: past(),
        i: { deadline: plus(90_000), token: 't', since: SINCE },
      });
      const ready = await held({ x: past() }, ['a']);
      const cannot = await held({ x: past() }, ['z']);
      // (a) red when the exit rule reads "some blocker past" or "every held step past" alone; (b)
      //     prints each mix's exit.
      expect({
        ahead: realm(['run', 'advance', ahead]).code,
        ready: realm(['run', 'advance', ready]).code,
        cannot: realm(['run', 'advance', cannot]).code,
      }).toEqual({ ahead: 0, ready: 0, cannot: 1 });
    });

    it('check 3, each real state: a step killed inside its window, an agent step’s claim, no claim record', async () => {
      const aheadId = await held({}, ['x']);
      await runStore.claimStep(aheadId, 'x', DEF, OTHER);
      const x = (await runStore.get(aheadId)).record.claims!['x']!;
      const agentId = await held({}, ['a']);
      await runStore.claimStep(agentId, 'a', DEF, { ...OTHER, channel: 'agent' });
      const a = (await runStore.get(agentId)).record.claims!['a']!;
      const noRecord = await held({ x: undefined });
      const last = (id: string): { code: number | null; last: string | undefined } => {
        const r = realm(['run', 'advance', id]);
        return { code: r.code, last: r.out.at(-1) };
      };
      // (a) red when a state is read as another, "wait" is dropped for a step that can still finish,
      //     "anyway" is lost inside the window, or the stamp is left out; (b) prints each exit and line.
      expect({ ahead: last(aheadId), agent: last(agentId), noRecord: last(noRecord) }).toEqual({
        ahead: {
          code: 0,
          last: `The engine can run nothing now: 'x' is held; wait for it. Its deadline is ahead (${x.deadline}); if its program is still running, the step runs twice. ${NOT_IDEMPOTENT} To free it anyway, run: realm run reclaim ${aheadId} --step x --claimed-at ${x.since} --force`,
        },
        agent: {
          code: 0,
          last: `Nothing is owed to the engine: 'a' is held since ${a.since}; wait for it, or free it if its program has stopped. Its claim has no deadline, ${UNKNOWN} ${NOT_IDEMPOTENT} To free it, run: realm run reclaim ${agentId} --step a --claimed-at ${a.since} --force`,
        },
        noRecord: {
          code: 0,
          last: `The engine can run nothing now: 'x' is held; wait for it, or free it if its program has stopped. It is held with no claim record, ${UNKNOWN} ${NOT_IDEMPOTENT} To free it, run: realm run reclaim ${noRecord} --step x --force`,
        },
      });
    });
  },
);

describe('#922 P2-2 — check 5: the command runs as printed', { timeout: 180_000 }, () => {
  it('a claim inside its window and a stamped claim of unknown age: the dry run’s command, run from another folder, frees each', async () => {
    const window = await held({}, ['x']);
    await runStore.claimStep(window, 'x', DEF, OTHER);
    const agent = await held({}, ['a']);
    await runStore.claimStep(agent, 'a', DEF, { ...OTHER, channel: 'agent' });
    const free = async (id: string) => {
      const command = printed(realm(['run', 'reclaim', id]).out);
      const r = realm(command);
      return {
        command: command.slice(0, 3),
        code: r.code,
        left: (await runStore.get(id)).record.in_progress_steps,
      };
    };
    // (a) red when the dry run prints the old form (refused on both: exit 1, the step still held);
    //     (b) prints each command's start, its exit and what is left in progress.
    expect({ window: await free(window), agent: await free(agent) }).toEqual({
      window: { command: ['run', 'reclaim', window], code: 0, left: [] },
      agent: { command: ['run', 'reclaim', agent], code: 0, left: [] },
    });
  });
});

describe(
  '#922 P2-2 — check 6: the driven doors on a step past its deadline',
  { timeout: 180_000 },
  () => {
    it('drain: its held line, then the way out', async () => {
      const id = await held({ x: past() });
      const r = realm(['run', 'drain', id]);
      // (a) red when drain reads the record's old line, or says "wait"; (b) prints the lines.
      expect({ code: r.code, lines: [...r.out, ...r.err] }).toEqual({
        code: 0,
        lines: [
          `Run '${id}' is not terminal (phase: 'running') — nothing to drain. ${pastLine('x', id)}`,
          `To end the run instead: realm run abandon ${id}`,
        ],
      });
    });

    it('respond: an answer that leaves only a step past its deadline names it', async () => {
      const def = loadWorkflowFromString(
        [
          'id: held-doors-922-respond',
          'name: held-doors-922-respond',
          'version: 1',
          'steps:',
          '  confirm:',
          '    description: Confirm.',
          '    execution: auto',
          '    trust: human_confirmed',
          '    gate:',
          '      choices: [approve, reject]',
          '  pack:',
          '    description: pack.',
          '    execution: auto',
          '  done:',
          '    description: done.',
          '    execution: auto',
          '    depends_on: [confirm, pack]',
          '',
        ].join('\n'),
      );
      await h.home.workflowStore.register(def);
      const { record } = await runStore.create({
        workflowId: def.id,
        workflowVersion: 1,
        params: {},
      });
      const opened = await executeStep(runStore, def, {
        runId: record.id,
        command: 'confirm',
        input: {},
        dispatcher: async () => ({}),
      });
      const { record: atGate } = await runStore.get(record.id);
      await runStore.update({
        ...atGate,
        in_progress_steps: [...atGate.in_progress_steps, 'pack'],
        claims: { ...atGate.claims, pack: past() },
      });
      const r = realm([
        'run',
        'respond',
        record.id,
        '--gate',
        opened.gate!.gate_id,
        '--choice',
        'approve',
      ]);
      // (a) red when respond reads the record's old line, or says "wait"; (b) prints the lines.
      expect({ code: r.code, last: r.out.at(-1) }).toEqual({
        code: 0,
        last: pastLine('pack', record.id),
      });
    });
  },
);

describe('#922 P2-2 — check 8: the dry run', { timeout: 180_000 }, () => {
  it('every held step’s lines: a past one leads with its deadline-passed line, an unknown-age one with its command (walk N1)', async () => {
    const id = await held({ x: past() }, ['a']);
    await runStore.claimStep(id, 'a', DEF, { ...OTHER, channel: 'agent' });
    const a = (await runStore.get(id)).record.claims!['a']!;
    const r = realm(['run', 'reclaim', id]);
    // (a) red when a held step gets no command or the old form, the past line is missing, or the
    //     footer names the old form; (b) prints the dry run.
    expect({ code: r.code, out: r.out }).toEqual({
      code: 0,
      out: [
        `Run '${id}' (running) — in-progress claims:`,
        `  • x: claim_stale  (deadline: ${PAST})`,
        `      Its deadline passed at ${PAST}; no result is recorded for it.`,
        `      ${NOT_IDEMPOTENT}`,
        `      To free it, run: realm run reclaim ${id} --step x --claimed-at ${SINCE} --force`,
        '  • a: claim_unknown_age  (deadline: none (unknown age))',
        `      Its claim has no deadline, ${UNKNOWN}`,
        `      ${NOT_IDEMPOTENT}`,
        `      To free it, run: realm run reclaim ${id} --step a --claimed-at ${a.since} --force`,
        FOOTER,
      ],
    });
  });

  it('a run whose workflow this home does not hold: the commands all the same, never an exit on it', async () => {
    const id = await held({ x: past() }, [], 'held-doors-922-gone');
    const r = realm(['run', 'reclaim', id]);
    // (a) red when the dry run exits on the missing definition, or lists no command; (b) prints it.
    expect({ code: r.code, lines: r.out.slice(1, 5) }).toEqual({
      code: 0,
      lines: [
        `  • x: claim_stale  (deadline: ${PAST})`,
        `      Its deadline passed at ${PAST}; no result is recorded for it.`,
        '      Its workflow definition is not available here, so whether running it again is safe is not known.',
        `      To free it, run: realm run reclaim ${id} --step x --claimed-at ${SINCE} --force`,
      ],
    });
  });
});

describe(
  '#922 P2-2 — a run whose workflow cannot be read (m-I), and a question’s step',
  { timeout: 180_000 },
  () => {
    it('drain and inspect point at the dry run in place of the held lines', async () => {
      const id = await held({ x: past() }, [], 'held-doors-922-gone');
      const drain = realm(['run', 'drain', id]);
      const inspect = realm(['run', 'inspect', id]).out;
      const line = `Its workflow definition cannot be read here; realm run reclaim ${id} lists each held step's command.`;
      // (a) red when either door prints no way to the commands, or a command judged without the
      //     definition it says it lacks; (b) prints both doors' lines.
      expect({
        drain: [...drain.out, ...drain.err][0],
        inspect: inspect.filter((l) => l.trim() === line),
        commands: inspect.filter((l) => l.includes('To free it')),
      }).toEqual({
        drain: `Run '${id}' is not terminal (phase: 'running') — nothing to drain. ${line}`,
        inspect: [`  ${line}`],
        commands: [],
      });
    });

    it('the dry run: a step waiting at its question gets the answer command, not reclaim', async () => {
      const def = loadWorkflowFromString(
        [
          'id: held-doors-922-gate',
          'name: held-doors-922-gate',
          'version: 1',
          'steps:',
          '  confirm:',
          '    description: Confirm.',
          '    execution: auto',
          '    trust: human_confirmed',
          '    gate:',
          '      choices: [approve, reject]',
          '',
        ].join('\n'),
      );
      await h.home.workflowStore.register(def);
      const { record } = await runStore.create({
        workflowId: def.id,
        workflowVersion: 1,
        params: {},
      });
      const opened = await executeStep(runStore, def, {
        runId: record.id,
        command: 'confirm',
        input: {},
        dispatcher: async () => ({}),
      });
      const r = realm(['run', 'reclaim', record.id]);
      // The question's step is not a held step (its question holds it): its header keeps the claim's
      // own word.
      const deadline = (await runStore.get(record.id)).record.claims!['confirm']!.deadline;
      // (a) red when the gate line changes, or a reclaim command is offered for the question's step;
      //     (b) prints the dry run.
      expect(r.out.slice(1)).toEqual([
        `  • confirm: healthy  (deadline: ${deadline})`,
        `      open gate — answer it, not reclaim: realm run respond ${record.id} --gate ${opened.gate!.gate_id} --choice <one of: approve, reject>`,
        FOOTER,
      ]);
    });
  },
);

describe('#922 P2-2 — check 9: `--all`, through the batch', { timeout: 120_000 }, () => {
  it('a pick whose claim changed between selection and write: its ✗ line, nothing removed, and the batch goes on; a freed pick’s record holds no definition_absent', async () => {
    const changed = await held({ i: past() });
    const freed = await held({ i: past() });
    const picks = await selectAutoReclaims(runStore, h.home.workflowStore, {});
    // Another program takes `changed`'s step again after the selection.
    const later = new Date(Date.now() - 60_000).toISOString();
    const { record } = await runStore.get(changed);
    await runStore.update({
      ...record,
      claims: { i: { deadline: PAST, token: 'u', since: later } },
    });
    const out: string[] = [];
    const reclaimed = await reclaimPicks(
      runStore,
      picks,
      undefined,
      (l) => out.push(l),
      (l) => out.push(l),
    );
    const entry = (await runStore.get(freed)).record.evidence.at(-1)?.output_summary;
    // (a) red when the stamp read at selection is not passed (the changed claim is freed), the line
    //     says "as the command says" or drops the run id, the batch stops, or the definition is not
    //     passed (the record then says definition_absent); (b) prints the lines, the count, the
    //     record's conditions and what is left in progress.
    expect({
      picks: picks.map((p) => p.runId).sort(),
      out: out.sort(),
      reclaimed,
      discharged: entry?.['conditions_discharged'],
      left: (await runStore.get(changed)).record.in_progress_steps,
    }).toEqual({
      picks: [changed, freed].sort(),
      out: [
        `  ✗ ${changed} / 'i': claimed since ${later}, not since ${SINCE} when selected; nothing was removed.`,
        `  ✓ ${freed}: Reclaimed 'i' (was claim_stale). It is eligible again — the next driver will re-drive it.`,
      ].sort(),
      reclaimed: 1,
      discharged: [],
      left: ['i'],
    });
  });
});

describe('#922 P2-2 — check 10: inspect', { timeout: 180_000 }, () => {
  it('a held step: its deadline-passed line, its conditions, the command with the exact stamp (walk N2)', async () => {
    const id = await held({ x: past() });
    const r = realm(['run', 'inspect', id]);
    const at = r.out.findIndex((l) => l.startsWith('  x: '));
    // (a) red when inspect lists no command, the stamp is cut to the second, or the past line is
    //     missing; (b) prints the lines under the step.
    expect(r.out.slice(at + 1, at + 4)).toEqual([
      `    Its deadline passed at ${PAST}; no result is recorded for it.`,
      `    ${NOT_IDEMPOTENT}`,
      `    To free it, run: realm run reclaim ${id} --step x --claimed-at ${SINCE} --force`,
    ]);
  });

  it('a step with entries [reclaim, re-run]: the reclaim its own line, the re-run the step’s result with its program line (walk N4); a step whose only entry is a reclaim: its heading and that line', async () => {
    const rerun = await held({}, ['x']);
    await runStore.claimStep(rerun, 'x', DEF, OTHER);
    await reclaimStep(runStore, rerun, 'x');
    // fixture: the freed step runs again here (a bare engine step)
    expect(realm(['run', 'advance', rerun]).code, 'fixture').toBe(0);
    const only = await held({}, ['x']);
    await runStore.claimStep(only, 'x', DEF, OTHER);
    await reclaimStep(runStore, only, 'x');
    const at = async (id: string): Promise<string> =>
      String(
        (await runStore.get(id)).record.evidence.find(
          (e) => e.output_summary?.['reclaimed'] === true,
        )?.output_summary['reclaimed_at'],
      );
    const block = (id: string): string[] => {
      const out = realm(['run', 'inspect', id]).out;
      const from = out.findIndex((l) => /^ {2}\d+\. x\b/.test(l));
      const to = out.findIndex((l, n) => n > from && (/^ {2}\d+\. /.test(l) || !l.startsWith(' ')));
      return out.slice(from, to < 0 ? undefined : to);
    };
    const x = block(rerun);
    const line = (t: string): string =>
      `     Reclaimed at ${t}: its claim was removed so the step could run again.`;
    // (a) red when the reclaim is an attempt row, the re-run's program line is lost (a shifted
    //     attempt), the reclaim's output is shown as the step's result, or a step whose only entry is
    //     a reclaim prints more than its heading and that line; (b) prints both blocks.
    expect({
      reclaimLine: x[1],
      attempts: x.filter((l) => l.includes('(attempt')),
      taken: x.some((l) => l.trimStart().startsWith('Taken by:')),
      output: x.find((l) => l.trimStart().startsWith('Output:'))?.includes('reclaimed'),
      only: block(only),
    }).toEqual({
      reclaimLine: line(await at(rerun)),
      attempts: [],
      taken: true,
      output: false,
      only: ['  1. x', line(await at(only))],
    });
  });
});

describe('#922 P2-2 — check 11: the words that named the old form', { timeout: 120_000 }, () => {
  it('the YAML loader’s warning, `--step`’s help and the refusal without `--force` name the dry run', async () => {
    const { warnings } = loadWorkflowFromStringWithDiagnostics(
      [
        'id: held-doors-922-finalizer',
        'name: held-doors-922-finalizer',
        'version: 1',
        'steps:',
        '  work:',
        '    description: work.',
        '    execution: auto',
        '    handler: h',
        '    idempotent: true',
        '  tidy:',
        '    description: tidy.',
        '    execution: finalizer',
        '    on_outcome: always',
        '    handler: hc',
        '',
      ].join('\n'),
    );
    const id = await held({ x: past() });
    const refused = realm(['run', 'reclaim', id, '--step', 'x']);
    const help = realm(['run', 'reclaim', '--help']).out.join(' ').replace(/\s+/g, ' ');
    // (a) red when one of them names the old form `--step X --force` alone; (b) prints them.
    expect({
      warning: warnings.find((w) => w.code === 'IDEMPOTENT_INERT_IN_FINALIZER')?.message,
      refused: { code: refused.code, err: refused.err },
      help: help.includes("realm run reclaim <run-id> prints each held step's command"),
    }).toEqual({
      warning:
        "Step 'work': 'idempotent: true' cannot enable auto-reclaim in a finalizer-bearing workflow (its claim carries no deadline, so 'realm run reclaim --all' can never select it). See 'realm run reclaim <run-id>', which prints each held step's command.",
      refused: {
        code: 1,
        err: [
          `Refusing to reclaim 'x' without --force. See realm run reclaim ${id}, which prints each held step's command.`,
        ],
      },
      help: true,
    });
  });
});
