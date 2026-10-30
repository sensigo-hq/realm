// owed-condition-923.test.ts — issue #923: an owed line that its command did not judge names the
// code it needs. `realm run inspect`, `realm run drain` and `realm run resume` load no project code
// (decision C33, design D1 rule 7: an observer's `advance` carries its capability basis, never a
// runnable claim), so they cannot know whether the program that runs `realm run advance` has a step's
// handler or adapter. When an owed step needs one Realm does not build in, the line says so before
// the command: `from a program that has handler '<name>'`. Driven on the built `realm` (a child
// process, a fresh HOME); the library from '@sensigo/realm' only sets runs up.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure: step,
// handler and adapter names and the lines the command printed — never a value.
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BUILT_IN_REQUIREMENTS,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  ExtensionRegistry,
  JsonFileStore,
  JsonWorkflowStore,
  createDefaultRegistry,
  executeChain,
  executeStep,
  isBuiltInRequirement,
  type StepDefinition,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { printChildrenWhenATestFails } from '../test-support/child-output.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../../../..');
const CLI = join(HERE, '../../dist/index.js');
const READING = 'docs/reference/cli/realm-run-reading.md';
const ACTING = 'docs/reference/cli/realm-run-acting.md';
const UNTIL = 'until a step opens a question, fails or ends the run';
/** Each cell starts the built CLI (one to four times): its own budget (#371, #948's guard). */
const BUDGET = 60_000;
const children = printChildrenWhenATestFails();
const flat = (t: string) => t.replace(/\s+/g, ' ');

/** (a) red when the page no longer holds the sentence word for word; (b) prints the sentence. */
function claim(page: string, sentence: string): void {
  expect(
    flat(readFileSync(join(ROOT, page), 'utf8')),
    `${page} no longer says: ${sentence}`,
  ).toContain(flat(sentence));
}

interface Home {
  home: string;
  runs: JsonFileStore;
  workflows: JsonWorkflowStore;
}

const folders: string[] = [];
afterEach(() => {
  for (const f of folders.splice(0)) rmSync(f, { recursive: true, force: true });
});

function freshHome(): Home {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'realm-owed-923-')));
  folders.push(home);
  return {
    home,
    runs: new JsonFileStore(join(home, '.realm', 'runs')),
    workflows: new JsonWorkflowStore(join(home, '.realm', 'workflows')),
  };
}

/** The built `realm`, in a fresh HOME, from `cwd` (the HOME when not given). */
function realm(
  h: Home,
  args: string[],
  cwd = h.home,
): { code: number | null; out: string[]; err: string[] } {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    env: {
      PATH: process.env['PATH'] ?? '',
      HOME: h.home,
      NO_COLOR: '1',
      REALM_OPERATOR: 'tester',
    },
    encoding: 'utf8',
    timeout: 40_000,
  });
  children.record({ args: [CLI, ...args], ...r });
  const lines = (t: string) => t.split('\n').filter((l) => l !== '');
  return { code: r.status, out: lines(r.stdout), err: lines(r.stderr) };
}

const wf = (
  id: string,
  steps: Record<string, StepDefinition>,
  services?: WorkflowDefinition['services'],
): WorkflowDefinition => ({
  id,
  name: id,
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps,
  ...(services !== undefined ? { services } : {}),
});

/** An `auto` step: `extra` adds its handler or service. */
const step = (extra: Partial<StepDefinition> = {}, deps: string[] = []): StepDefinition => ({
  description: 'Step.',
  execution: 'auto',
  depends_on: deps,
  ...extra,
});

/** A question that expires after one second and declares `settle_default` (answer `approve`). */
const expiringGate: StepDefinition = {
  description: 'Decide.',
  execution: 'auto',
  trust: 'human_confirmed',
  depends_on: [],
  gate: {
    choices: ['approve', 'reject'],
    timeout_seconds: 1,
    on_expiry: 'settle_default',
    default_choice: 'approve',
  },
};

async function started(h: Home, d: WorkflowDefinition, params = {}): Promise<string> {
  await h.workflows.register(d);
  const { run } = await h.runs.create({ workflowId: d.id, workflowVersion: 1, params });
  return run.id;
}

/** A registry whose handlers each throw: the step fails (the fixture for `realm run resume`). */
function throwing(...names: string[]): ExtensionRegistry {
  const registry = new ExtensionRegistry();
  for (const name of names) {
    registry.register('handler', name, {
      id: name,
      execute: async () => {
        throw new Error(`${name} failed`);
      },
    });
  }
  return registry;
}

/** Runs `command` in-process with `registry`, and checks the step failed (fixture). */
async function failed(
  h: Home,
  d: WorkflowDefinition,
  id: string,
  command: string,
  registry?: ExtensionRegistry,
  dispatcher: () => Promise<Record<string, unknown>> = async () => ({}),
): Promise<void> {
  await executeChain(h.runs, d, {
    runId: id,
    command,
    input: {},
    dispatcher,
    ...(registry !== undefined ? { registry } : {}),
  });
  // (a) red when the step did not fail (fixture); (b) prints the failed steps.
  expect((await h.runs.get(id)).failed_steps, 'fixture').toEqual([command]);
}

/**
 * A project folder that HAS handler `mark` (`dist/registry.js`, loaded by the workflow's
 * `extensions:`), with the workflow registered from it by the built `realm`, so the run's
 * `trust_root` is that folder and `realm run advance` loads `mark` from it.
 */
async function projectWithMark(h: Home, id: string, steps: string[]): Promise<WorkflowDefinition> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'realm-owed-923-proj-')));
  folders.push(dir);
  mkdirSync(join(dir, 'workflows', 'wf'), { recursive: true });
  mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
  writeFileSync(
    join(dir, 'dist', 'registry.js'),
    "export default { handlers: { mark: { id: 'mark', execute: async () => ({ data: { done: true } }) } } };\n",
    'utf8',
  );
  writeFileSync(
    join(dir, 'workflows', 'wf', 'workflow.yaml'),
    [
      `id: ${id}`,
      `name: ${id}`,
      'version: 1',
      'extensions:',
      '  - ../../dist/registry.js',
      'steps:',
      ...steps,
      '',
    ].join('\n'),
    'utf8',
  );
  const reg = realm(h, ['workflow', 'register', 'workflows/wf/workflow.yaml'], dir);
  if (reg.code !== 0) throw new Error(`fixture: register failed: ${reg.err.join('\n')}`);
  return h.workflows.get(id);
}

const owedOf = (lines: string[]) => lines.filter((l) => l.startsWith('Owed to the engine'));
const toRunOf = (lines: string[]) => lines.filter((l) => l.startsWith('To run'));

describe('#923 C1 — realm run inspect: the owed line names the code an owed step needs', () => {
  it(
    'C1 (a) an `auto` step whose handler the project does not load, not yet attempted: the condition names it',
    async () => {
      const h = freshHome();
      const id = await started(h, wf('c1a', { s1: step({ handler: 'h_missing' }) }));
      const r = realm(h, ['run', 'inspect', id]);
      // (a) red when inspect's owed line names no condition (today's line) or the wrong one; (b)
      //     prints inspect's owed lines.
      expect({ code: r.code, owed: owedOf(r.out) }).toEqual({
        code: 0,
        owed: [
          `Owed to the engine: 's1' — from a program that has handler 'h_missing': realm run advance ${id}`,
        ],
      });
    },
    BUDGET,
  );

  it('C8 the reading page and the CHANGELOG say it (executed by C1 a, C2 a, C3 and C4 a)', () => {
    claim(
      READING,
      "In the `Owed to the engine` line, when an owed step needs a handler or adapter that Realm does not build in, `from a program that has handler '<name>'` (or `adapter '<name>'`) comes before the command: `inspect` loads no project code, so it cannot check. Added after version 0.48.0.",
    );
    claim(
      READING,
      'A step that has not been attempted is listed as owed, with the handler or adapter it needs before the command.',
    );
    claim(
      'CHANGELOG.md',
      '`realm run inspect`, `realm run drain` and `realm run resume` no longer list work as something `realm run advance` runs without saying what it needs: when a step needs a handler or adapter Realm does not build in, the line names it before the command (issue #923).',
    );
  });

  it(
    'C1 (b) an owed step with no handler or adapter: today’s line, byte for byte',
    async () => {
      const h = freshHome();
      const id = await started(h, wf('c1b', { s1: step() }));
      const r = realm(h, ['run', 'inspect', id]);
      // (a) red when the condition is printed with no requirement behind it; (b) prints the lines.
      expect(owedOf(r.out)).toEqual([`Owed to the engine: 's1' — realm run advance ${id}`]);
    },
    BUDGET,
  );

  it(
    'C1 (c) a due question expiry owed (`on_expiry: settle_default`), the step after it needing a handler: today’s line',
    async () => {
      const h = freshHome();
      const d = wf('c1c', {
        decide: expiringGate,
        after: step({ handler: 'h_after' }, ['decide']),
      });
      const id = await started(h, d);
      await executeStep(h.runs, d, {
        runId: id,
        command: 'decide',
        input: {},
        dispatcher: async () => ({}),
      });
      await new Promise((r) => setTimeout(r, 1300));
      const r = realm(h, ['run', 'inspect', id]);
      // (a) red when a due expiry gains a condition (it is owed alone: the step after it is not owed
      //     yet); (b) prints the lines.
      expect(owedOf(r.out)).toEqual([
        `Owed to the engine: the expired question on 'decide' (its declared settle_default) — realm run advance ${id} carries it out, then runs what that leaves owed ${UNTIL}`,
      ]);
    },
    BUDGET,
  );

  it(
    'C1 (e) three steps, two needing handler `h1` and one adapter `a1`: each requirement once, in the way’s order',
    async () => {
      const h = freshHome();
      const id = await started(
        h,
        wf(
          'c1e',
          {
            x: step({ handler: 'h1' }),
            y: step({ handler: 'h1' }),
            z: step({ uses_service: 'svc', operation: 'read' }),
          },
          { svc: { adapter: 'a1', trust: 'engine_delivered' } },
        ),
      );
      const r = realm(h, ['run', 'inspect', id]);
      // (a) red when a requirement is repeated, dropped or reordered; (b) prints the lines.
      expect(owedOf(r.out)).toEqual([
        `Owed to the engine: 'x', 'y', 'z' — from a program that has handler 'h1', adapter 'a1': realm run advance ${id} runs them ${UNTIL}`,
      ]);
    },
    BUDGET,
  );

  it(
    'C1 (f) eleven steps with eleven distinct handlers: ten named, then ` and 1 more`',
    async () => {
      const h = freshHome();
      const names = Array.from({ length: 11 }, (_, i) => String(i + 1).padStart(2, '0'));
      const id = await started(
        h,
        wf('c1f', Object.fromEntries(names.map((n) => [`s${n}`, step({ handler: `h${n}` })]))),
      );
      const r = realm(h, ['run', 'inspect', id]);
      const items = names.map((n) => `'s${n}'`).join(', ');
      const needs = names
        .slice(0, 10)
        .map((n) => `handler 'h${n}'`)
        .join(', ');
      // (a) red when the list is not bounded at ten (core's one bounded list); (b) prints the lines.
      expect(owedOf(r.out)).toEqual([
        `Owed to the engine: ${items} — from a program that has ${needs} and 1 more: realm run advance ${id} runs them ${UNTIL}`,
      ]);
    },
    BUDGET,
  );

  it(
    'C1 (g) a step whose project HAS the handler: the condition still shows (inspect cannot know), and the project runs it',
    async () => {
      const h = freshHome();
      const d = await projectWithMark(h, 'c1g', [
        '  s1:',
        '    description: Step.',
        '    execution: auto',
        '    handler: mark',
      ]);
      const id = await started(h, d);
      const r = realm(h, ['run', 'inspect', id]);
      // (a) red when inspect drops the condition or judges the step itself; (b) prints the lines.
      expect(owedOf(r.out)).toEqual([
        `Owed to the engine: 's1' — from a program that has handler 'mark': realm run advance ${id}`,
      ]);
      const advanced = realm(h, ['run', 'advance', id]);
      // Fixture: (a) red when the project does not have `mark` after all (advance refuses); (b)
      //     prints advance's exit code and the completed steps.
      expect(
        { code: advanced.code, completed: (await h.runs.get(id)).completed_steps },
        'fixture',
      ).toEqual({ code: 0, completed: ['s1'] });
    },
    BUDGET,
  );
});

describe('#923 C2 — realm run drain on a live run: the way out names the code', () => {
  it(
    'C2 (a) the dry run on a run whose step needs a handler the project does not load: the condition',
    async () => {
      const h = freshHome();
      const id = await started(h, wf('c2a', { s1: step({ handler: 'h_missing' }) }));
      const r = realm(h, ['run', 'drain', id]);
      // (a) red when drain's owed line names no condition; (b) prints drain's lines.
      expect({ code: r.code, out: r.out }).toEqual({
        code: 0,
        out: [
          `Run '${id}' is not terminal (phase: 'running') — nothing to drain. To run the step the engine owes ('s1'), from a program that has handler 'h_missing': realm run advance ${id}`,
          `To end the run instead: realm run abandon ${id}`,
        ],
      });
    },
    BUDGET,
  );

  it(
    'C2 (b) the dry run, a handler-less step: today’s line',
    async () => {
      const h = freshHome();
      const id = await started(h, wf('c2b', { s1: step() }));
      const r = realm(h, ['run', 'drain', id]);
      // (a) red when the condition is printed with no requirement behind it; (b) prints the lines.
      expect(r.out).toEqual([
        `Run '${id}' is not terminal (phase: 'running') — nothing to drain. To run the step the engine owes ('s1'): realm run advance ${id}`,
        `To end the run instead: realm run abandon ${id}`,
      ]);
    },
    BUDGET,
  );

  it(
    'C2 (h) `--force` on that live run: the same line on stderr, exit 1',
    async () => {
      const h = freshHome();
      const id = await started(h, wf('c2h', { s1: step({ handler: 'h_missing' }) }));
      const r = realm(h, ['run', 'drain', id, '--force']);
      // (a) red when drain's refusal of a live run names no condition; (b) prints the exit code and
      //     both streams' lines.
      expect({ code: r.code, out: r.out, err: r.err }).toEqual({
        code: 1,
        out: [],
        err: [
          `Run '${id}' is not terminal (phase: 'running') — nothing to drain. To run the step the engine owes ('s1'), from a program that has handler 'h_missing': realm run advance ${id}`,
          `To end the run instead: realm run abandon ${id}`,
        ],
      });
    },
    BUDGET,
  );
});

describe('#923 C3 — realm run drain after an expiry enactment', () => {
  it(
    'C3 `--expired --force` carries out a `settle_default` question; the step it leaves owed needs a handler: the condition',
    async () => {
      const h = freshHome();
      const d = wf('c3', {
        decide: expiringGate,
        after: step({ handler: 'h_after' }, ['decide']),
      });
      const id = await started(h, d);
      await executeStep(h.runs, d, {
        runId: id,
        command: 'decide',
        input: {},
        dispatcher: async () => ({}),
      });
      await new Promise((r) => setTimeout(r, 1300));
      const r = realm(h, ['run', 'drain', id, '--expired', '--force']);
      // (a) red when the after-expiry owed line names no condition; (b) prints the exit code and the
      //     `To run` lines.
      expect({ code: r.code, toRun: toRunOf(r.out) }).toEqual({
        code: 0,
        toRun: [
          `To run the step the engine owes ('after'), from a program that has handler 'h_after': realm run advance ${id}`,
        ],
      });
    },
    BUDGET,
  );

  it('C8 the acting page says it for drain', () => {
    claim(
      ACTING,
      "When a step it names needs a handler or adapter that Realm does not build in, `, from a program that has handler '<name>'` comes before the `:` (drain loads no project code, so it cannot check).",
    );
  });
});

describe('#923 C4 — realm run resume', () => {
  it(
    'C4 (a) a failed step resumed, the project lacks its handler: the condition',
    async () => {
      const h = freshHome();
      const d = wf('c4a', { a: step({ handler: 'boom' }) });
      const id = await started(h, d);
      await failed(h, d, id, 'a', throwing('boom'));
      const r = realm(h, ['run', 'resume', id, '--from', 'a']);
      // (a) red when resume's owed line names no condition; (b) prints the exit code and the lines.
      expect({ code: r.code, toRun: toRunOf(r.out) }).toEqual({
        code: 0,
        toRun: [
          `To run the step the engine owes ('a') without a model, from a program that has handler 'boom': realm run advance ${id}`,
        ],
      });
    },
    BUDGET,
  );

  it('C8 the acting page says it for resume', () => {
    claim(
      ACTING,
      "When a step it names needs a handler or adapter that Realm does not build in, `, from a program that has handler '<name>'` comes before the `:` (resume loads no project code, so it cannot check).",
    );
  });

  it(
    'C4 (g) a failed step resumed, the project HAS its handler: the condition still shows, and the project runs it',
    async () => {
      const h = freshHome();
      const d = await projectWithMark(h, 'c4g', [
        '  a:',
        '    description: Step.',
        '    execution: auto',
        '    handler: mark',
      ]);
      const id = await started(h, d);
      await failed(h, d, id, 'a', throwing('mark'));
      const r = realm(h, ['run', 'resume', id, '--from', 'a']);
      // (a) red when resume drops the condition or judges the step itself; (b) prints the lines.
      expect(toRunOf(r.out)).toEqual([
        `To run the step the engine owes ('a') without a model, from a program that has handler 'mark': realm run advance ${id}`,
      ]);
      const advanced = realm(h, ['run', 'advance', id]);
      // Fixture: (a) red when the project does not have `mark` after all; (b) prints advance's exit
      //     code and the completed steps.
      expect(
        { code: advanced.code, completed: (await h.runs.get(id)).completed_steps },
        'fixture',
      ).toEqual({ code: 0, completed: ['a'] });
    },
    BUDGET,
  );

  it(
    'C4 (b) a handler-less failed step resumed: today’s line',
    async () => {
      const h = freshHome();
      const d = wf('c4b', { a: step() });
      const id = await started(h, d);
      await failed(h, d, id, 'a', undefined, async () => {
        throw new Error('the host failed it');
      });
      const r = realm(h, ['run', 'resume', id, '--from', 'a']);
      // (a) red when the condition is printed with no requirement behind it; (b) prints the lines.
      expect(toRunOf(r.out)).toEqual([
        `To run the step the engine owes ('a') without a model: realm run advance ${id}`,
      ]);
    },
    BUDGET,
  );
});

describe('#923 C6 — a marked step stays out of the owed list', () => {
  it(
    'C6 a step the engine attempted without its handler: `Could not run …` for it, and only the other step is owed',
    async () => {
      const h = freshHome();
      const d = wf('c6', {
        s1: step({ handler: 'h_missing' }),
        s2: step({ handler: 'h_missing2' }),
      });
      const id = await started(h, d);
      await executeChain(h.runs, d, {
        runId: id,
        command: 's1',
        input: {},
        dispatcher: async () => ({}),
        registry: new ExtensionRegistry(),
      });
      // Fixture: (a) red when the attempt left no marker on `s1`, or marked `s2` too; (b) prints the
      //     marked steps.
      expect(Object.keys((await h.runs.get(id)).capability_blocks ?? {}), 'fixture').toEqual([
        's1',
      ]);
      const r = realm(h, ['run', 'inspect', id]);
      // (a) red when the marked step is listed as owed (the marker branch gone) or loses its line;
      //     (b) prints the owed items (the words before ` — `; C1 pins the condition after them) and
      //     the `Could not run` lines.
      expect({
        owed: owedOf(r.out).map((l) => l.split(' — ')[0]),
        couldNot: r.out.filter((l) => l.startsWith('Could not run')),
      }).toEqual({
        owed: ["Owed to the engine: 's2'"],
        couldNot: [
          `Could not run 's1' (capability): handler 'h_missing' was not registered in the runner that last attempted it — from a program that has it: realm run advance ${id}`,
        ],
      });
    },
    BUDGET,
  );
});

describe('#923 C7 — a built-in requirement is not code a project must supply', () => {
  it(
    'C7 an owed `auto` step using adapter `filesystem`: no condition on inspect and drain',
    async () => {
      const h = freshHome();
      const id = await started(
        h,
        wf(
          'c7',
          {
            fetch: step({
              uses_service: 'files',
              operation: 'read',
              input_map: { path: 'run.params.path' },
            }),
          },
          { files: { adapter: 'filesystem', trust: 'engine_delivered' } },
        ),
        { path: '/no/such/file-923' },
      );
      const shown = realm(h, ['run', 'inspect', id]);
      const drained = realm(h, ['run', 'drain', id]);
      // (a) red when a built-in gets the condition (A0's skip gone); (b) prints both lines.
      expect({ inspect: owedOf(shown.out), drain: drained.out[0] }).toEqual({
        inspect: [`Owed to the engine: 'fetch' — realm run advance ${id}`],
        drain: `Run '${id}' is not terminal (phase: 'running') — nothing to drain. To run the step the engine owes ('fetch'): realm run advance ${id}`,
      });
    },
    BUDGET,
  );

  it('C7 witness: every requirement the default registry registers is built-in by the table, and the other way round', () => {
    const registry = createDefaultRegistry();
    const registered = (['handler', 'adapter'] as const)
      .flatMap((kind) => registry.names(kind).map((name) => `${kind} ${name}`))
      .sort();
    const table = BUILT_IN_REQUIREMENTS.map((r) => `${r.kind} ${r.name}`).sort();
    // (a) red when the default registry registers a handler or adapter the table does not hold, or
    //     the table holds one it does not register; (b) prints both lists (names only).
    expect({
      registered,
      table,
      judged: registered.every((r) => {
        const [kind, name] = r.split(' ') as ['handler' | 'adapter', string];
        return isBuiltInRequirement(kind, name);
      }),
    }).toEqual({ registered: table, table, judged: true });
  });
});
