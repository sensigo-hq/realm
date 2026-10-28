// ways-renderer.test.ts — issue #729 PR-0 (PR0-CONTRACT §5): the CLI door's words for the ways, pinned
// whole. Moved here from core with the composers that used to mint them (Part B): the lines an
// operator surface prints when a run cannot go on (C62, C64, C82, F15; T-20 (i)), the way out (C60),
// a capability's clause (C53), the answer command (C206, T-7), what one advance call does with the
// owed work (C211), and the operator's lever as a fact line (Amendment 14, Q12). Core pins the data
// these read; each cell here drives core's own composition (`composeWaysAt`) on a real record, so a
// change on either side turns it red. Beside each: (a) what turns it red; (b) what it prints on
// failure — run ids and step names only.
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  JsonFileStore,
  ExtensionRegistry,
  composeWaysAt,
  type ComposedWays,
  type RunRecord,
  type StepDefinition,
  type Unavailable,
  type WayOf,
  type WorkflowDefinition,
} from '@sensigo/realm';
import {
  CLI_COMMANDS,
  NO_DRIVE_FLAGS,
  cannotGoOnLines,
  cannotRunClause,
  cannotRunWayOut,
  owedCallWords,
  owedRunsWords,
  heldByAnswerWords,
  stopReasons,
} from './ways-renderer.js';

async function withRun<T>(fn: (run: RunRecord) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'realm-ways-renderer-'));
  try {
    const { run } = await new JsonFileStore(dir).create({
      workflowId: 'c64-wf',
      workflowVersion: 1,
      params: {},
    });
    return await fn(run);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const def = (steps: Record<string, StepDefinition>) =>
  ({ id: 'c64-wf', name: 'c64', version: 1, steps }) as WorkflowDefinition;

const needsN: StepDefinition = {
  description: 'X',
  execution: 'auto',
  depends_on: [],
  input_schema: { type: 'object', required: ['n'], properties: { n: { type: 'number' } } },
};
const missing: StepDefinition = {
  description: 'Y',
  execution: 'auto',
  depends_on: [],
  handler: 'missing_h',
};

const ways = (run: RunRecord, d: WorkflowDefinition, registry?: ExtensionRegistry): ComposedWays =>
  composeWaysAt(run, new Date(), {
    definition: d,
    ...(registry !== undefined ? { registry } : {}),
  });

const INPUT =
  "'x' cannot run (input_schema): Invalid input for step 'x': the input must have required property 'n'.";
const LEVER =
  "'x' takes its input from an operator, checked against its input_schema; no realm command supplies it.";
// F15 + T-20 (i): `x` is refused for its input and reads the run's params: its own way out, then the
// run's — the run stays open, its phase said.
const wayOut = (id: string): string =>
  `Run ${id} stays open (phase 'running'): for 'x', start a run with params that fit, or correct its input_schema and register the workflow again; then, after a fix, realm run advance ${id} — or end it: realm run abandon ${id}`;

describe('#625 C64 → #729 PR-0 — cannotGoOnLines, the CLI door’s one composer', () => {
  it('a refusal before the claim: the step, the operator’s lever as a fact, then the way out', async () => {
    await withRun(async (run) => {
      // (a) red when the step, the lever's fact line or the way out moves; (b) prints the lines.
      expect(
        cannotGoOnLines(ways(run, def({ x: needsN }), new ExtensionRegistry()), run.id, 'running'),
      ).toEqual([INPUT, LEVER, wayOut(run.id)]);
    });
  });

  it('a capability refusal alone (judged with a registry): the step with its own way out, then the alternative (abandon)', async () => {
    await withRun(async (run) => {
      expect(
        cannotGoOnLines(ways(run, def({ y: missing }), new ExtensionRegistry()), run.id, 'running'),
      ).toEqual([
        "'y' cannot run here (capability): handler 'missing_h' is not registered here — load the missing extension, or run the step on a runner that has it.",
        `To end the run instead: realm run abandon ${run.id}`,
      ]);
    });
  });

  it("a capability refusal judged from the run's marker (no registry): the past tense, the marker's way out (no stop after the command), then the alternative", async () => {
    await withRun(async (run) => {
      const marked: RunRecord = {
        ...run,
        capability_blocks: {
          y: {
            requirement: { kind: 'handler', name: 'missing_h' },
            code: 'ENGINE_HANDLER_NOT_REGISTERED',
            at: '2026-10-05T00:00:00.000Z',
          },
        },
      };
      expect(cannotGoOnLines(ways(marked, def({ y: missing })), run.id, 'running')).toEqual([
        `'y' could not run (capability): handler 'missing_h' was not registered in the runner that last attempted it — from a program that has it: realm run advance ${run.id}`,
        `To end the run instead: realm run abandon ${run.id}`,
      ]);
    });
  });

  it('both: each step, then the way out that corrects the workflow', async () => {
    await withRun(async (run) => {
      expect(
        cannotGoOnLines(
          ways(run, def({ x: needsN, y: missing }), new ExtensionRegistry()),
          run.id,
          'running',
        ),
      ).toEqual([
        INPUT,
        LEVER,
        "'y' cannot run here (capability): handler 'missing_h' is not registered here — load the missing extension, or run the step on a runner that has it.",
        wayOut(run.id),
      ]);
    });
  });

  it('controls — the run can go on (an agent step ready, the act present) or has ended: no lines', async () => {
    await withRun(async (run) => {
      const registry = new ExtensionRegistry();
      const agent = def({ x: needsN, a: { description: 'A', execution: 'agent', depends_on: [] } });
      expect(cannotGoOnLines(ways(run, agent, registry), run.id, 'running')).toEqual([]);
      const act = def({ x: needsN, b: { description: 'B', execution: 'auto', depends_on: [] } });
      expect(cannotGoOnLines(ways(run, act, registry), run.id, 'running')).toEqual([]);
      const ended = { ...run, terminal_state: true } as RunRecord;
      expect(cannotGoOnLines(ways(ended, def({ x: needsN }), registry), run.id, 'failed')).toEqual(
        [],
      );
    });
  });
});

describe('#625 C60 / C53 / C206 / C211 → #729 PR-0 — the CLI words, from one way or one entry', () => {
  it('C60: cannotRunWayOut — F15: the one fix for a trust or precondition refusal; the run stays open, its phase said', async () => {
    await withRun(async (run) => {
      const d = def({
        x: { description: 'X', execution: 'auto', depends_on: [], trust: 'nope' as never },
      });
      // (a) red when the one fix becomes per-step words, or the phase or a command moves; (b) prints it.
      expect(cannotRunWayOut(ways(run, d), run.id, 'running')).toBe(
        `Run ${run.id} stays open (phase 'running'): correct the workflow, register it again, then realm run advance ${run.id} — or end it: realm run abandon ${run.id}`,
      );
    });
  });

  it("C53: a capability refusal judged from this program's registry ends with its way out; one judged from the marker does not", () => {
    const entry = (basis: 'registry' | 'marker'): Unavailable => ({
      verb: 'run_step',
      step: 'x',
      code: 'capability_missing',
      facts: { step: 'x', requirement: { kind: 'handler', name: 'h' }, basis },
      remedy: [],
      no_remedy: { cause: 'requires_other_program', requirement: { kind: 'handler', name: 'h' } },
    });
    // (a) red when a basis takes the other's words; (b) prints both clauses.
    expect([cannotRunClause(entry('registry')), cannotRunClause(entry('marker'))]).toEqual([
      "'x' cannot run here (capability): handler 'h' is not registered here — load the missing extension, or run the step on a runner that has it",
      "'x' could not run (capability): handler 'h' was not registered in the runner that last attempted it",
    ]);
  });

  it('C206 (T-7): the answer command — the one choice as itself, several as `<one of: a, b>`, never `a|b`', () => {
    const respond = (one_of: string[]): WayOf<'respond'> => ({
      verb: 'respond',
      conditions: [],
      run_id: 'r',
      gate_id: 'g',
      step: 's',
      choice: { one_of },
      holds: [],
      presented: 'alone',
    });
    // (a) red when one value is wrapped, several are joined with `|`, or the command differs; (b)
    //     prints them.
    expect([
      CLI_COMMANDS.respond(respond(['ship', 'hold']), undefined, NO_DRIVE_FLAGS),
      CLI_COMMANDS.respond(respond(['ack']), undefined, NO_DRIVE_FLAGS),
    ]).toEqual([
      'realm run respond r --gate g --choice <one of: ship, hold>',
      'realm run respond r --gate g --choice ack',
    ]);
  });

  it('C211 (walk c14 W2-1): owedCallWords — a declared default then runs what it leaves owed; nothing for an abort or one item; several stop at the first question, failure or end', () => {
    const advance = (owed: WayOf<'advance'>['owed']): WayOf<'advance'> => ({
      verb: 'advance',
      conditions: [],
      run_id: 'r',
      owed,
    });
    const expiry = (on_expiry: 'settle_default' | 'abort') => ({
      expiry: { gate_id: 'x', step: 'g', on_expiry },
    });
    // (a) red when a default's call is said to stop at the expiry, an abort is said to run more, or
    //     several owed lose their stop words; (b) prints them.
    expect([
      owedCallWords(advance([expiry('settle_default')] as WayOf<'advance'>['owed'])),
      owedCallWords(advance([expiry('abort')] as WayOf<'advance'>['owed'])),
      owedCallWords(advance([{ step: 'a' }] as WayOf<'advance'>['owed'])),
      owedCallWords(advance([{ step: 'a' }, { step: 'b' }] as WayOf<'advance'>['owed'])),
    ]).toEqual([
      ' carries it out, then runs what that leaves owed until a step opens a question, fails or ends the run',
      '',
      '',
      ' runs them until a step opens a question, fails or ends the run',
    ]);
  });
});

describe('#729 PR-0 — Table rows 14–19: "its phase is P" — every caller passes the run’s derived phase', () => {
  it('each call of cannotGoOnLines / cannotRunWayOut outside the renderer passes deriveRunPhase (or its alias) of the record it composed', async () => {
    const { readFileSync, readdirSync, statSync } = await import('node:fs');
    const { join, relative, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const src = join(dirname(fileURLToPath(import.meta.url)), '..');
    const files = (function walk(dir: string): string[] {
      return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) return walk(path);
        return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [path] : [];
      });
    })(src);
    const calls: string[] = [];
    const bad: string[] = [];
    for (const file of files) {
      if (file.endsWith('ways-renderer.ts')) continue;
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/\b(cannotGoOnLines|cannotRunWayOut)\(/g)) {
        // The call's text up to its closing parenthesis at depth 0.
        let depth = 0;
        let end = m.index! + m[0].length - 1;
        for (; end < text.length; end++) {
          if (text[end] === '(') depth++;
          else if (text[end] === ')' && --depth === 0) break;
        }
        // #729 PR-3 (L-2): a print site passes the writer's render context after the phase; the
        // phase is still the argument before it.
        const call = text
          .slice(m.index!, end + 1)
          .replace(/,\s*(writerCtx\(\)|ctx)\s*,?\s*\)$/, ')');
        const where = `${relative(src, file)}:${text.slice(0, m.index!).split('\n').length}`;
        calls.push(where);
        const derived = /(deriveRunPhase|derivePhase|derivePhaseOf)\([^()]*\)\s*,?\s*\)$/.test(
          call,
        );
        // A name bound in the same file to the derived phase (`const phase = deriveRunPhase(record)`).
        const name = /,\s*([A-Za-z_]\w*)\s*,?\s*\)$/.exec(call)?.[1];
        const bound =
          name !== undefined &&
          new RegExp(`const ${name} = (deriveRunPhase|derivePhase|derivePhaseOf)\\(`).test(text);
        if (!derived && !bound) bad.push(where);
      }
    }
    // (a) red when a caller passes a stored or literal phase (a stale `run_phase`); (b) prints the
    //     call sites. The denominator: the calls found.
    expect({ bad, found: calls.length >= 9 }).toEqual({ bad: [], found: true });
  });
});

describe('#729 PR-0 (Part B) — the owed clause and the held-steps words, moved from core with their callers', () => {
  const way = (owed: WayOf<'advance'>['owed']): WayOf<'advance'> => ({
    verb: 'advance',
    conditions: [],
    run_id: 'r1',
    owed,
  });
  it('C207, C211: owedRunsWords — several owed, the call stops at the first question; one, nothing; a declared default, then what it leaves; an abort, nothing', () => {
    // (a) red when one item is said to run more, several are promised to all run, a default's call
    //     is said to stop at the expiry or an abort to run more; (b) prints the four clauses.
    const expiry = (on_expiry: 'settle_default' | 'abort') => ({
      expiry: { step: 'g', gate_id: 'x', on_expiry },
    });
    expect([
      owedRunsWords(way([{ step: 'a' }, { step: 'b' }])),
      owedRunsWords(way([{ step: 'a' }])),
      owedRunsWords(way([expiry('settle_default')])),
      owedRunsWords(way([expiry('abort')])),
    ]).toEqual([
      '; it runs them until a step opens a question, fails or ends the run',
      '',
      '; then it runs what that leaves owed until a step opens a question, fails or ends the run',
      '',
    ]);
  });

  it('C211: heldByAnswerWords — the steps an open question holds, one or several; none, nothing', () => {
    // (a) red when the number agreement or the quoting changes, or an empty list gets words; (b)
    //     prints them.
    expect([
      heldByAnswerWords(['z', 'y']),
      heldByAnswerWords(['z']),
      heldByAnswerWords([]),
    ]).toEqual(["'z', 'y' wait for its answer", "'z' waits for its answer", undefined]);
  });
});

describe('#627 W correction 2 (3.2) — the command for a register way with a copy works', () => {
  it('a register way with a path → `realm workflow validate --registered <id>`; without one, the register command', () => {
    const way = { verb: 'register', conditions: [], workflow_id: 'w1', run_id: 'r1' } as const;
    // (a) red when the command registers the COPY (`realm workflow register <copy>`, which fails:
    //     register takes a source); (b) prints both commands.
    expect({
      withCopy: CLI_COMMANDS.register(
        { ...way, path: '/home/u/.realm/workflows/w1.json' },
        undefined,
        NO_DRIVE_FLAGS,
      ),
      without: CLI_COMMANDS.register(way, undefined, NO_DRIVE_FLAGS),
    }).toEqual({
      withCopy: 'realm workflow validate --registered w1',
      without: 'realm workflow register <file>',
    });
  });
});

describe('#872 (a) — the CLI line names a long step or handler by its length (I4)', () => {
  it('B7b: a 600-character step name in a `Stopped:` line → `‹600 characters, not kept›`, never a cut start', () => {
    const step = 's'.padEnd(600, 'x');
    const entry: Unavailable = {
      verb: 'run_step',
      step,
      code: 'capability_missing',
      facts: { step, requirement: { kind: 'handler', name: 'h' }, basis: 'registry' },
      remedy: [],
      no_remedy: { cause: 'requires_other_program', requirement: { kind: 'handler', name: 'h' } },
    };
    const reasons = stopReasons({ ways: [], unavailable: [entry] }, 'r', 'running');
    // (a) red when the CLI's line bypasses core's bounded renderer (`capText` in `cannotRunParts`);
    //     (b) prints the first reason (the name is fake).
    expect(reasons[0]).toBe(
      "'‹600 characters, not kept›' cannot run here (capability): handler 'h' is not registered here — load the missing extension, or run the step on a runner that has it",
    );
  });
});
