// inspect-supplier-729.test.ts — issue #729 PR-0 (§5 E1 (iii), T-17 (ii); the implementer's Q20,
// ruled 2026-10-16): who supplied an attempt's input is said on `realm run inspect`'s attribution
// line BY RULE — only when the role differs from the party the step is designed for. The expected
// case (an agent's answer to an agent step) and every absence add nothing; in PR-0 no path writes a
// differing role, so its cell enters with `operator`'s producer (the prompt's Problems 13).
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure: the
// clause (empty here) and booleans.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WorkflowDefinition } from '@sensigo/realm';
import { supplierClause } from './inspect.js';

const D: Pick<WorkflowDefinition, 'steps'> = {
  steps: {
    ask: { description: 'Ask.', execution: 'agent', depends_on: [] },
    run: { description: 'Run.', execution: 'auto', depends_on: ['ask'] },
  },
};

const PAGE = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../docs/reference/cli/realm-run-reading.md',
);

describe('#729 PR-0 — Q20: the supplier on the attribution line, by rule', () => {
  it('an agent step’s attempt the agent answered: no clause (the expected case)', () => {
    // (a) red when the clause is said whatever the step's party (the rule dropped); (b) prints it.
    expect(supplierClause({ step_id: 'ask', kind: 'execution', supplied_by: 'agent' }, D)).toBe('');
  });

  it('an engine step’s attempt (its input the engine built): no clause', () => {
    // (a) red when an engine_input absence is said; (b) prints the clause.
    expect(supplierClause({ step_id: 'run', kind: 'execution' }, D)).toBe('');
  });

  it('an agent step’s entry written before the field: no clause', () => {
    // (a) red when a not_recorded absence is said; (b) prints the clause.
    expect(supplierClause({ step_id: 'ask', kind: 'execution' }, D)).toBe('');
  });

  it('realm-run-reading.md’s field table states the rule', () => {
    const page = readFileSync(PAGE, 'utf8').replace(/\s+/g, ' ');
    // (a) red when the page drops the row or its rule; (b) prints whether each part is there.
    expect({
      row: page.includes('`… supplied by the <role>`'),
      rule: page.includes(
        "said only when it is not the step's own party (an engine step given an operator's input); an agent's answer to an agent step, and an entry that records none, add nothing.",
      ),
    }).toEqual({ row: true, rule: true });
  });
});
