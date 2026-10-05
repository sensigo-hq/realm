// engine-input-625.test.ts — issue #625 PR-2a, decision C70: the testing runner (`realm workflow
// test`, `runFixtureTests`) gives an `auto` step the input the engine gives it in a real run, and a
// fixture that reaches the cannot-go-on state fails naming the step and its check — never by running
// to the iteration cap.
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

  it('(b) nothing else can run and a step is refused before its claim: the fixture fails naming the step, its check and the way out', async () => {
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
    const runId = /^Run (\S+) stays open/.exec(lines[2] ?? '')?.[1] ?? '<no run id>';
    // (a) red when the runner runs to the iteration cap again ("Workflow stalled: exceeded maximum
    //     loop iterations"), drops a line, or composes its own; (b) prints the whole result.
    expect({ name: result.name, passed: result.passed, lines }).toEqual({
      name: 'one',
      passed: false,
      lines: [
        'Workflow stalled: nothing else can run.',
        "'compute' cannot run (precondition): Precondition failed for step 'compute'. Precondition failed: 'run.params.ok == true'. Resolved value: undefined.",
        `Run ${runId} stays open (phase 'running'): correct the workflow, register it again, then realm run advance ${runId}; or end it: realm run abandon ${runId}.`,
      ],
    });
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
