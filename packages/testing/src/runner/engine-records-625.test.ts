// engine-records-625.test.ts — issue #625 PR-2a, the last prompt's F10 (review G5-1): realm-testing's
// runner records what the engine records. The engine's work runs through `advanceRun` with the
// fixture's registry, so a bare `auto` step records its dependency's output (or the run's params) —
// never `{}` named by the runner — and a fixture that completes in production passes here. A step
// whose handler has no stand-in fails the fixture with the engine's own message, after every step
// that can run (the engine's order, decision C23), never at the iteration cap.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDefaultRegistry, type StepHandler } from '@sensigo/realm';
import { runFixtureTests } from './test-runner.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const PAGE = 'docs/reference/testing-package.md';

/** (a) red when the page no longer holds the sentence word for word; (b) prints it. */
function claim(page: string, sentence: string): void {
  const flat = (t: string) => t.replace(/\s+/g, ' ');
  expect(
    flat(readFileSync(join(ROOT, page), 'utf8')),
    `${page} no longer says: ${sentence}`,
  ).toContain(flat(sentence));
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Writes `workflow.yaml` and `fixtures/one.yaml` and runs the fixture; `handlers` run REAL. */
async function runOne(
  workflow: string[],
  fixture: string[],
  handlers?: Record<string, StepHandler>,
) {
  const dir = mkdtempSync(join(tmpdir(), 'realm-f10-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'fixtures'));
  writeFileSync(join(dir, 'workflow.yaml'), workflow.join('\n') + '\n');
  writeFileSync(join(dir, 'fixtures', 'one.yaml'), fixture.join('\n') + '\n');
  let extensions: Parameters<typeof runFixtureTests>[0]['extensions'];
  if (handlers !== undefined) {
    const registry = createDefaultRegistry();
    for (const [name, handler] of Object.entries(handlers))
      registry.register('handler', name, handler);
    extensions = {
      registry,
      manifest: { modules: [], adapters: [], handlers: Object.keys(handlers), processors: [] },
    };
  }
  const [result] = await runFixtureTests({
    workflowPath: join(dir, 'workflow.yaml'),
    fixturesPath: join(dir, 'fixtures'),
    ...(extensions !== undefined ? { extensions } : {}),
  });
  return result!;
}

describe('#625 PR-2a, F10 — realm-testing’s runner records what the engine records', () => {
  it('a bare HEAD step: it records the run’s params, so the step that reads them runs — the fixture passes, as the run completes', async () => {
    claim(
      PAGE,
      "The engine's work — guards, `auto` steps, and an expired question's declared `on_expiry` — runs through `advanceRun` with the fixture's registry, as in a real run: an `auto` step with no handler and no service records what the engine records (the output of the one step it depends on, or the run's params when it depends on none), and the steps run in the engine's order: every step that can run, then one attempt of a step whose handler or adapter has no stand-in.",
    );
    const result = await runOne(
      [
        'id: f10-head',
        'name: f10-head',
        'version: 1',
        'steps:',
        '  a:',
        '    description: A.',
        '    execution: auto',
        '  b:',
        '    description: B.',
        '    execution: auto',
        '    depends_on: [a]',
        '    preconditions: ["a.n == 1"]',
      ],
      [
        'name: one',
        'params:',
        '  n: 1',
        'agent_responses: {}',
        'expected:',
        '  final_state: completed',
      ],
    );
    // (a) red when the runner names `a` and records `{}` (then `b`'s precondition finds nothing and
    //     the fixture stalls); (b) prints the result.
    expect(result).toEqual({ name: 'one', passed: true });
  });

  it('a bare step after a question: it records its dependency’s output, so the step that reads it runs — the fixture passes', async () => {
    const result = await runOne(
      [
        'id: f10-after-question',
        'name: f10-after-question',
        'version: 1',
        'steps:',
        '  q:',
        '    description: Q.',
        '    execution: agent',
        '    trust: human_confirmed',
        '    gate:',
        '      choices: [ok, no]',
        '  after:',
        '    description: After.',
        '    execution: auto',
        '    depends_on: [q]',
        '  c:',
        '    description: C.',
        '    execution: auto',
        '    depends_on: [after]',
        '    preconditions: ["after.n == 7"]',
      ],
      [
        'name: one',
        'params: {}',
        'agent_responses:',
        '  q:',
        '    n: 7',
        'gate_responses:',
        '  q: ok',
        'expected:',
        '  final_state: completed',
      ],
    );
    // (a) red when the runner names `after` after the answer and records `{}`; (b) prints the result.
    expect(result).toEqual({ name: 'one', passed: true });
  });

  it('a step whose handler has no stand-in, beside one that can run: the step that can run runs first, then the engine’s own message — never the iteration cap', async () => {
    const ran: string[] = [];
    const result = await runOne(
      [
        'id: f10-capability',
        'name: f10-capability',
        'version: 1',
        'steps:',
        '  fetch:',
        '    description: Fetch.',
        '    execution: auto',
        '    depends_on: []',
        '    handler: missing_h',
        '  file:',
        '    description: File.',
        '    execution: auto',
        '    depends_on: []',
        '    handler: rec_file',
      ],
      ['name: one', 'params: {}', 'agent_responses: {}', 'expected:', '  final_state: completed'],
      { rec_file: { id: 'rec_file', execute: async () => (ran.push('file'), { data: {} }) } },
    );
    // (a) red when the runner attempts the step with no stand-in before the step that can run (its
    //     own pick order, not the engine's), or spins to the iteration cap; (b) prints them.
    expect({ result, ran }).toEqual({
      result: { name: 'one', passed: false, error: "Handler 'missing_h' is not registered" },
      ran: ['file'],
    });
  });
});
