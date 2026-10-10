// docs-pages-625.test.ts — issue #625 PR-2a, decision C174 (round 22, lane E1): every sentence
// docs/reference/testing-package.md says about behaviour #625 PR-2a adds or changes — what an
// `auto` step gets in a fixture run, and how a fixture that stalls on a step refused before its
// claim fails — is quoted here (read from the repository, whitespace folded) and the case it states
// is driven through `runFixtureTests` (and, where the page names them, the built `realm workflow
// test` and `realm workflow run`), so neither the page nor the behaviour can change alone.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createDefaultRegistry,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  type StepHandler,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { runFixtureTests } from './index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const CLI = join(ROOT, 'packages/cli/dist/index.js');
const PAGE = 'docs/reference/testing-package.md';
const flat = (t: string) => t.replace(/\s+/g, ' ');

/** (a) red when the page no longer holds the sentence word for word; (b) prints the sentence. */
function claim(page: string, sentence: string): void {
  expect(
    flat(readFileSync(join(ROOT, page), 'utf8')),
    `${page} no longer says: ${sentence}`,
  ).toContain(flat(sentence));
}

/** The lines of the page's first fenced block that holds `marker`. */
function block(page: string, marker: string): string[] {
  const text = readFileSync(join(ROOT, page), 'utf8');
  const blocks = text.split(/^```[a-z]*\n/m).filter((_, i) => i % 2 === 1);
  const found = blocks.find((b) => b.includes(marker));
  if (found === undefined) throw new Error(`${page} has no block with: ${marker}`);
  return found.replace(/\n```[\s\S]*$/, '').split('\n');
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A fresh folder holding `workflow.yaml` and `fixtures/<name>.yaml` for each fixture given. */
function project(workflow: string[], fixtures: Record<string, string[]>): string {
  const dir = mkdtempSync(join(tmpdir(), 'realm-pages-625-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'home'));
  mkdirSync(join(dir, 'flow', 'fixtures'), { recursive: true });
  writeFileSync(join(dir, 'flow', 'workflow.yaml'), workflow.join('\n') + '\n');
  for (const [name, lines] of Object.entries(fixtures)) {
    writeFileSync(join(dir, 'flow', 'fixtures', `${name}.yaml`), lines.join('\n') + '\n');
  }
  return dir;
}

/** The built `realm`, with a fresh HOME inside the project folder. */
function realm(dir: string, args: string[]) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: dir,
    env: { PATH: process.env['PATH'] ?? '', HOME: join(dir, 'home'), NO_COLOR: '1' },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { code: r.status, out: r.stdout.split('\n').filter((l) => l !== '') };
}

/**
 * `realm workflow run` refuses a stdin that is not a terminal, so it is run under `script`, which
 * gives it one (util-linux and BSD spell the call differently).
 */
function realmOnATerminal(dir: string, args: string[]) {
  const q = (w: string) => `'${w.replaceAll("'", "'\\''")}'`;
  const argv =
    process.platform === 'darwin'
      ? ['-q', '/dev/null', process.execPath, CLI, ...args]
      : ['-qec', [process.execPath, CLI, ...args].map(q).join(' '), '/dev/null'];
  const r = spawnSync('script', argv, {
    cwd: dir,
    env: {
      PATH: process.env['PATH'] ?? '',
      HOME: join(dir, 'home'),
      NO_COLOR: '1',
      SHELL: '/bin/sh',
    },
    input: '',
    encoding: 'utf8',
    timeout: 60_000,
  });
  return {
    code: r.status,
    out: r.stdout
      .replaceAll('\r', '')
      .split('\n')
      .filter((l) => l !== ''),
  };
}

describe(
  '#625 PR-2a, C174 — testing-package.md’s sentences about fixture runs',
  { timeout: 60_000 },
  () => {
    it('an agent step’s input is the fixture’s answer; an auto step gets the run’s params with no depends_on, and nothing otherwise', async () => {
      claim(PAGE, "An agent step's input is the fixture's answer for it.");
      claim(
        PAGE,
        "An `auto` step gets what the engine gives it in a real run: the run's params when the step has no `depends_on`, and nothing otherwise.",
      );
      const seen: Record<string, unknown> = {};
      const capture = (step: string): StepHandler =>
        ({
          async execute(inputs: { params: Record<string, unknown> }) {
            seen[step] = inputs.params;
            return { data: { seen: true } };
          },
        }) as unknown as StepHandler;
      const registry = createDefaultRegistry();
      registry.register('handler', 'capture_first', capture('first'));
      registry.register('handler', 'capture_second', capture('second'));
      const dir = project(
        [
          'id: inputs',
          'name: inputs',
          'version: 1',
          'steps:',
          '  first:',
          '    description: First.',
          '    execution: auto',
          '    handler: capture_first',
          '  ask:',
          '    description: Ask.',
          '    execution: agent',
          '    depends_on: [first]',
          '    input_schema:',
          '      type: object',
          '      required: [verdict]',
          '      properties:',
          '        verdict: { enum: [yes, no] }',
          '  second:',
          '    description: Second.',
          '    execution: auto',
          '    depends_on: [ask]',
          '    handler: capture_second',
        ],
        {
          a: [
            'name: answered',
            'params: { order: 7 }',
            'agent_responses:',
            '  ask: { verdict: "yes" }',
            'expected: { final_state: completed }',
          ],
          b: [
            'name: refused answer',
            'params: { order: 7 }',
            'agent_responses:',
            '  ask: { verdict: "maybe" }',
            'expected: { final_state: completed }',
          ],
        },
      );
      // Loaded as project code, so the handlers run as they are.
      const results = await runFixtureTests({
        workflowPath: join(dir, 'flow'),
        fixturesPath: join(dir, 'flow', 'fixtures'),
        extensions: {
          registry,
          manifest: {
            modules: [],
            adapters: [],
            handlers: ['capture_first', 'capture_second'],
            processors: [],
          },
        },
      });
      const byName = Object.fromEntries(results.map((r) => [r.name, r]));
      // (a) red when an auto step with no depends_on does not get the run's params, or one after
      //     another step gets anything; (b) prints what each step got.
      expect(seen).toEqual({ first: { order: 7 }, second: {} });
      // (a) red when the agent step's input is not the fixture's answer (a refused answer passes, or
      //     an accepted one fails); (b) prints both results.
      expect([byName['answered'], byName['refused answer']]).toEqual([
        { name: 'answered', passed: true },
        { name: 'refused answer', passed: false, error: "Invalid input for step 'ask'" },
      ]);
    });

    it('a fixture that stalls on a precondition fails with the page’s two lines', async () => {
      claim(PAGE, 'For a step whose precondition fails (`error`, from `runFixtureTests`):');
      const shown = block(PAGE, 'Workflow stalled: nothing else can run.').filter((l) => l !== '');
      const dir = project(
        [
          'id: compute',
          'name: compute',
          'version: 1',
          'steps:',
          '  compute:',
          '    description: Compute.',
          '    execution: auto',
          "    preconditions: ['run.params.ok == true']",
        ],
        { a: ['name: stalls', 'expected: { final_state: completed }'] },
      );
      const [result] = await runFixtureTests({
        workflowPath: join(dir, 'flow'),
        fixturesPath: join(dir, 'flow', 'fixtures'),
      });
      // (a) red when the error is not the page's block, line for line; (b) prints both.
      expect(result!.error?.split('\n')).toEqual(shown);
    });

    it('a stall on each check refused before the claim — a failed precondition, an invalid trust, a refused input — names every step, one line each, and no command', async () => {
      claim(
        PAGE,
        '| Reaches a point where nothing else can run, with a step refused before its claim: a failed precondition, an invalid `trust` or an input its schema refuses | `Workflow stalled: nothing else can run.`, then one line per step that cannot run (see below). Added after version 0.46.0 |',
      );
      claim(
        PAGE,
        'A fixture stalled this way fails with `Workflow stalled: nothing else can run.` and one line per step that cannot run, joined by newlines',
      );
      claim(
        PAGE,
        "It names no command that ends the run, because the run is in the runner's memory and no `realm run` command can reach it.",
      );
      const dir = project([], { a: ['name: stalls', 'expected: { final_state: completed }'] });
      // The loader refuses an invalid trust, so the workflow is handed in already loaded.
      const definition = {
        id: 'three',
        name: 'three',
        version: 1,
        schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
        steps: {
          p: {
            description: 'P.',
            execution: 'auto',
            depends_on: [],
            preconditions: ['run.params.ok == true'],
          },
          t: { description: 'T.', execution: 'auto', depends_on: [], trust: 'bogus_value' },
          s: {
            description: 'S.',
            execution: 'auto',
            depends_on: [],
            input_schema: { type: 'object', required: ['sku'] },
          },
        },
      } as unknown as WorkflowDefinition;
      const [result] = await runFixtureTests({
        workflowPath: join(dir, 'flow'),
        fixturesPath: join(dir, 'flow', 'fixtures'),
        definition,
      });
      // (a) red when the stall is not its first line and one line per refused step, each naming its
      //     check; (b) prints the error.
      expect(result!.error?.split('\n')).toEqual([
        'Workflow stalled: nothing else can run.',
        "'p' cannot run (precondition): Precondition failed for step 'p'. Precondition failed: 'run.params.ok == true'. Resolved value: undefined.",
        "'t' cannot run (trust): 'trust: \"bogus_value\"' is not a recognized value — the engine will refuse this step at dispatch (VALIDATION_TRUST_VALUE). Accepts auto, human_confirmed, human_reviewed — correct the value and 'realm workflow register <path>'.",
        "'s' cannot run (input_schema): Invalid input for step 's': the input must have required property 'sku'.",
      ]);
      // (a) red when the stall names a command that ends the run; (b) prints the error.
      expect(result!.error).not.toMatch(/realm run|abandon|advance/);
    });

    it('a missing handler beside a refused step: the stall lists it as cannot run here; the lines are `realm workflow run`’s, and `realm workflow test` indents them under FAIL', async () => {
      claim(
        PAGE,
        'one line per step that cannot run, joined by newlines: the step lines `realm workflow run` prints in the same state.',
      );
      claim(
        PAGE,
        "When the fixture stops before running it, beside a step that is refused before its claim, the stall lists it too, as `'<step>' cannot run here (capability): …`.",
      );
      claim(
        PAGE,
        "[`realm workflow test`](cli/realm-workflow.md#test) prints the second and later lines indented under the fixture's `FAIL` line.",
      );
      const dir = project(
        [
          'id: stall',
          'name: stall',
          'version: 1',
          'steps:',
          '  compute:',
          '    description: Compute.',
          '    execution: auto',
          "    preconditions: ['run.params.ok == true']",
          '  call:',
          '    description: Call.',
          '    execution: auto',
          '    handler: nope_h',
        ],
        { a: ['name: stalls', 'expected: { final_state: completed }'] },
      );
      const [result] = await runFixtureTests({
        workflowPath: join(dir, 'flow'),
        fixturesPath: join(dir, 'flow', 'fixtures'),
      });
      const lines = result!.error!.split('\n');
      // (a) red when the step with no handler is left out of the stall, or named another way;
      //     (b) prints the error.
      expect(lines).toEqual([
        'Workflow stalled: nothing else can run.',
        "'compute' cannot run (precondition): Precondition failed for step 'compute'. Precondition failed: 'run.params.ok == true'. Resolved value: undefined.",
        "'call' cannot run here (capability): handler 'nope_h' is not registered here — load the missing extension, or run the step on a runner that has it.",
      ]);
      const dev = realmOnATerminal(dir, ['workflow', 'run', 'flow']);
      const from = dev.out.indexOf(lines[0]!);
      // (a) red when `realm workflow run` prints other step lines in the same state; (b) prints its
      //     screen.
      expect({ code: dev.code, lines: dev.out.slice(from, from + lines.length) }).toEqual({
        code: 1,
        lines,
      });
      const test = realm(dir, ['workflow', 'test', 'flow', '-f', 'flow/fixtures']);
      const fail = test.out.findIndex((l) => l.startsWith('  FAIL stalls: '));
      // (a) red when `realm workflow test` does not print the first line on the FAIL line and each
      //     later line indented under it; (b) prints its screen.
      expect({ code: test.code, lines: test.out.slice(fail, fail + lines.length) }).toEqual({
        code: 1,
        lines: [`  FAIL stalls: ${lines[0]}`, ...lines.slice(1).map((l) => `    ${l}`)],
      });
    });

    it('a step whose service has no stand-in, on its own, fails the fixture with the engine’s message', async () => {
      claim(
        PAGE,
        "A step whose handler or adapter has no stand-in is not refused before its claim, so on its own it fails the fixture with the engine's message (the table above).",
      );
      const dir = project(
        [
          'id: orders',
          'name: orders',
          'version: 1',
          'services:',
          '  orders:',
          '    adapter: orders_api',
          '    trust: engine_delivered',
          'steps:',
          '  fetch:',
          '    description: Fetch.',
          '    execution: auto',
          '    uses_service: orders',
          '    operation: get',
        ],
        { a: ['name: unmocked', 'expected: { final_state: completed }'] },
      );
      const [result] = await runFixtureTests({
        workflowPath: join(dir, 'flow'),
        fixturesPath: join(dir, 'flow', 'fixtures'),
      });
      // (a) red when such a step stalls the fixture instead of failing with the engine's message
      //     (the page's table row); (b) prints the error.
      expect(result!.error).toBe(
        "Adapter 'orders_api' for service 'orders' is not registered. Declare this adapter under 'adapters:' in realm.yaml at your deployment root.",
      );
      claim(
        PAGE,
        "| Has no stand-in for a service the run calls | `Adapter 'orders_api' for service 'orders' is not registered. Declare this adapter under 'adapters:' in realm.yaml at your deployment root.` |",
      );
    });
  },
);
