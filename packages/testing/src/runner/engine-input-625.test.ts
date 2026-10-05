// engine-input-625.test.ts — issue #625 PR-2a, decisions C70 and C75: the testing runner (`realm
// workflow test`, `runFixtureTests`) gives an `auto` step the input the engine gives it in a real
// run, and a fixture that stops because a step is refused before its claim fails naming each step
// that cannot run and its check — never by running to the iteration cap, and never with a way out
// that names a command (the run lives in the runner's memory). A step whose handler or adapter has
// no stand-in fails on its own with the engine's own message, at the head of the run as after a
// step; beside a step refused before its claim, the stall names it too.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runFixtureTests } from './test-runner.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Writes `workflow.yaml` and `fixtures/one.yaml` into a fresh folder and runs the fixture. */
async function runOne(workflow: string[], fixture: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'realm-c70-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'fixtures'));
  writeFileSync(join(dir, 'workflow.yaml'), workflow.join('\n') + '\n');
  writeFileSync(join(dir, 'fixtures', 'one.yaml'), fixture.join('\n') + '\n');
  const [result] = await runFixtureTests({
    workflowPath: join(dir, 'workflow.yaml'),
    fixturesPath: join(dir, 'fixtures'),
  });
  return result!;
}

describe('#625 PR-2a, C70 — the testing runner drives an auto step as the engine does', () => {
  it('(a) an auto step with no depends_on receives the run params: a fixture whose first step needs them now passes', async () => {
    const result = await runOne(
      [
        'id: c70-input',
        'name: c70-input',
        'version: 1',
        'steps:',
        '  compute:',
        '    description: Compute.',
        '    execution: auto',
        '    depends_on: []',
        '    input_schema:',
        '      type: object',
        '      required: [n]',
        '      properties:',
        '        n: { type: number }',
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
    // (a) red when the runner gives the step `{}` again (it then fails with "Invalid input for step
    //     'compute'", where MCP start_run completes the same run); (b) prints the result.
    expect(result).toEqual({ name: 'one', passed: true });
  });

  it('(b) nothing else can run and a step is refused before its claim: the fixture fails naming the step and its check, with no command', async () => {
    const result = await runOne(
      [
        'id: c70-stall',
        'name: c70-stall',
        'version: 1',
        'steps:',
        '  ask:',
        '    description: Ask.',
        '    execution: agent',
        '    depends_on: []',
        '  compute:',
        '    description: Compute.',
        '    execution: auto',
        '    depends_on: [ask]',
        '    preconditions: ["run.params.ok == true"]',
      ],
      [
        'name: one',
        'params: {}',
        'agent_responses:',
        '  ask: {}',
        'expected:',
        '  final_state: completed',
      ],
    );
    const lines = (result.error ?? '').split('\n');
    // (a) red when the runner runs to the iteration cap again ("Workflow stalled: exceeded maximum
    //     loop iterations"), drops the clause, composes its own, or appends a run-level way out
    //     (decision C75); (b) prints the whole result.
    expect({ name: result.name, passed: result.passed, lines }).toEqual({
      name: 'one',
      passed: false,
      lines: [
        'Workflow stalled: nothing else can run.',
        "'compute' cannot run (precondition): Precondition failed for step 'compute'. Precondition failed: 'run.params.ok == true'. Resolved value: undefined.",
      ],
    });
    // (a) red when any `realm run …` command comes back into the error: the run lives only in the
    //     runner's memory, so `realm run advance` and `realm run abandon` print `Run not found`
    //     (decision C75); (b) prints the error.
    expect(result.error).not.toContain('realm run');
  });

  it('CONTROL — an ordinary fixture (agent step, then a bare auto step after it) passes as before', async () => {
    const result = await runOne(
      [
        'id: c70-control',
        'name: c70-control',
        'version: 1',
        'steps:',
        '  ask:',
        '    description: Ask.',
        '    execution: agent',
        '    depends_on: []',
        '  file:',
        '    description: File it.',
        '    execution: auto',
        '    depends_on: [ask]',
      ],
      [
        'name: one',
        'params: {}',
        'agent_responses:',
        '  ask: { text: hello }',
        'expected:',
        '  final_state: completed',
      ],
    );
    // (a) red when the new check stops a run that can go on, or the input change breaks a bare
    //     step after an agent step; (b) prints the result.
    expect(result).toEqual({ name: 'one', passed: true });
  });
});

// issue #625 PR-2a, decision C75: the stall fires only when a step is refused before its claim. A
// step whose handler or adapter has no stand-in is dispatched, and the fixture fails with the
// engine's own message — the same message at the head of the run as after another step.
const ORDERS_SERVICE = [
  'services:',
  '  orders:',
  '    adapter: orders_api',
  '    trust: engine_managed',
];
const ADAPTER_MESSAGE =
  "Adapter 'orders_api' for service 'orders' is not registered. Declare this adapter under 'adapters:' in realm.yaml at your deployment root.";

describe("#625 PR-2a, C75 — a missing stand-in fails with the engine's own message; the stall names each refused step", () => {
  it("a HEAD step whose adapter has no stand-in: the engine's adapter message, no stall line", async () => {
    const result = await runOne(
      [
        'id: c75-adapter-head',
        'name: c75-adapter-head',
        'version: 1',
        ...ORDERS_SERVICE,
        'steps:',
        '  fetch:',
        '    description: Fetch.',
        '    execution: auto',
        '    uses_service: orders',
        '    operation: get_order',
      ],
      ['name: one', 'params: {}', 'agent_responses: {}', 'expected:', '  final_state: completed'],
    );
    // (a) red when the stall fires on a state where only a handler or adapter is missing (the
    //     trigger back on `cannotGoOnHere`): the error then starts "Workflow stalled" and loses the
    //     remedy "Declare this adapter under 'adapters:' in realm.yaml"; (b) prints the result.
    expect(result).toEqual({ name: 'one', passed: false, error: ADAPTER_MESSAGE });
  });

  it('CONTROL — the same step after an agent step (a chained block) fails with the same message: one shape', async () => {
    const result = await runOne(
      [
        'id: c75-adapter-chained',
        'name: c75-adapter-chained',
        'version: 1',
        ...ORDERS_SERVICE,
        'steps:',
        '  ask:',
        '    description: Ask.',
        '    execution: agent',
        '    depends_on: []',
        '  fetch:',
        '    description: Fetch.',
        '    execution: auto',
        '    depends_on: [ask]',
        '    uses_service: orders',
        '    operation: get_order',
      ],
      [
        'name: one',
        'params: {}',
        'agent_responses:',
        '  ask: {}',
        'expected:',
        '  final_state: completed',
      ],
    );
    // (a) red when the chained block's message changes, so the head case above no longer has the
    //     same shape; (b) prints the result.
    expect(result).toEqual({ name: 'one', passed: false, error: ADAPTER_MESSAGE });
  });

  it("a HEAD step whose handler has no stand-in: the engine's handler message, no stall line", async () => {
    const result = await runOne(
      [
        'id: c75-handler-head',
        'name: c75-handler-head',
        'version: 1',
        'steps:',
        '  fetch:',
        '    description: Fetch.',
        '    execution: auto',
        '    handler: my_h',
      ],
      ['name: one', 'params: {}', 'agent_responses: {}', 'expected:', '  final_state: completed'],
    );
    // (a) red when the stall fires on a missing handler (the trigger back on `cannotGoOnHere`);
    //     (b) prints the result.
    expect(result).toEqual({
      name: 'one',
      passed: false,
      error: "Handler 'my_h' is not registered",
    });
  });

  it('a step refused before its claim beside a step with no stand-in: the stall names BOTH, one line each, and no command', async () => {
    const result = await runOne(
      [
        'id: c75-mixed',
        'name: c75-mixed',
        'version: 1',
        'steps:',
        '  compute:',
        '    description: Compute.',
        '    execution: auto',
        '    depends_on: []',
        '    preconditions: ["run.params.ok == true"]',
        '  fetch:',
        '    description: Fetch.',
        '    execution: auto',
        '    depends_on: []',
        '    handler: missing_h',
      ],
      ['name: one', 'params: {}', 'agent_responses: {}', 'expected:', '  final_state: completed'],
    );
    // (a) red when the stall keeps only the first step, keeps only the refused-before-claim steps,
    //     drops the clauses, or appends a run-level way out; (b) prints the whole result.
    expect({
      name: result.name,
      passed: result.passed,
      lines: (result.error ?? '').split('\n'),
    }).toEqual({
      name: 'one',
      passed: false,
      lines: [
        'Workflow stalled: nothing else can run.',
        "'compute' cannot run (precondition): Precondition failed for step 'compute'. Precondition failed: 'run.params.ok == true'. Resolved value: undefined.",
        "'fetch' cannot run here (capability): handler 'missing_h' is not registered here — load the missing extension, or run the step on a runner that has it.",
      ],
    });
  });
});
