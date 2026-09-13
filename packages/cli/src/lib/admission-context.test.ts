// issue #553 — the WITNESS: no context-dependent check can hide from `validate --registered`.
//
// The file loader's post-parse block is the one place a check can run on a file surface and be
// invisible to a stored-copy audit. This cell reads `packages/core/src/workflow/yaml-loader.ts`
// as source text (cross-package source-text reads are the purge-guard precedent) and refuses two
// shapes: an INLINE `throw new WorkflowError(` in that block (a check nobody can call with a
// recorded path), and a member of CONTEXT_DEPENDENT_CHECKS whose named resolver the block does
// not call (a row that names a check the loader does not run). The read-failure throw at the top
// of `loadWorkflowFromFileCore` sits BEFORE the slice by construction: the slice starts at the
// `parseWorkflowString(` call, which is after the read.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONTEXT_DEPENDENT_CHECKS,
  notRunReason,
  renderChecksNotRunLine,
} from './admission-context.js';

const LOADER = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'core',
  'src',
  'workflow',
  'yaml-loader.ts',
);

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** The file-only post-parse block: from the parse call to the end of its `try`. */
function fileOnlyBlock(source: string): string {
  const fnStart = source.indexOf('function loadWorkflowFromFileCore(');
  expect(fnStart).toBeGreaterThan(-1);
  const parseAt = source.indexOf('parseWorkflowString(content, registry', fnStart);
  expect(parseAt).toBeGreaterThan(-1);
  const tryAt = source.indexOf('  try {', parseAt);
  expect(tryAt).toBeGreaterThan(-1);
  const catchAt = source.indexOf('\n  } catch (err) {', tryAt);
  expect(catchAt).toBeGreaterThan(-1);
  return stripComments(source.slice(parseAt, catchAt));
}

function resolverBody(source: string, name: string): string {
  const start = source.indexOf(`export function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const rest = source.slice(start + 1);
  const next = rest.search(/\n(export |function )/);
  return stripComments(next === -1 ? rest : rest.slice(0, next));
}

describe('admission-context witness (issue #553)', () => {
  const source = readFileSync(LOADER, 'utf8');

  it('(a) the file-only post-parse block contains ZERO inline throws — every check is delegated', () => {
    // Baseline on 05439cf: 5 (profile + the four context rules). After #553: 0. A planted
    // `throw new WorkflowError(` in the block reds this conjunct alone (mutant iii).
    const throws = fileOnlyBlock(source).match(/throw new WorkflowError\(/g) ?? [];
    expect(throws).toHaveLength(0);
  });

  it('(b) each member with a witness names a resolver the block actually CALLS', () => {
    const block = fileOnlyBlock(source);
    for (const check of CONTEXT_DEPENDENT_CHECKS) {
      if (check.witness === undefined) continue;
      expect(block, `${check.id}: ${check.witness}`).toContain(check.witness);
    }
  });

  it('(c) the profile resolver itself refuses exactly once, from its collected errors', () => {
    const body = resolverBody(source, 'resolveAgentProfiles');
    const throws = [...body.matchAll(/throw new WorkflowError\(/g)];
    expect(throws).toHaveLength(1);
    const head = body.slice(throws[0]!.index, throws[0]!.index! + 200);
    // `agent_profile` is NOT in the throw head (executed, audit round 2) — the collector is.
    expect(head).toContain('profileErrors');
  });

  it('exactly one member carries a witness, and it is the profile resolver', () => {
    const witnessed = CONTEXT_DEPENDENT_CHECKS.filter((c) => c.witness !== undefined);
    expect(witnessed.map((c) => c.id)).toEqual(['agent_profile_resolution']);
  });
});

describe('the derived line (issue #553)', () => {
  it('singular, one reason, one label', () => {
    expect(
      renderChecksNotRunLine([
        { id: 'project_extensions', reason: notRunReason('trust_root', '/gone') },
      ]),
    ).toBe(
      '1 check not run (trust_root /gone no longer exists): extension modules, manifest and config_schema',
    );
  });

  it('plural, two reasons `; `-joined in member order, labels `, `-joined in member order', () => {
    expect(
      renderChecksNotRunLine([
        { id: 'agent_profile_resolution', reason: notRunReason('source_dir', '/gone/wf') },
        { id: 'project_extensions', reason: notRunReason('trust_root', '/gone') },
      ]),
    ).toBe(
      '2 checks not run (source_dir /gone/wf no longer exists; trust_root /gone no longer exists): ' +
        'agent-profile file resolution, extension modules, manifest and config_schema',
    );
  });

  it('identical reasons are deduplicated', () => {
    expect(
      renderChecksNotRunLine([
        { id: 'agent_profile_resolution', reason: 'x' },
        { id: 'project_extensions', reason: 'x' },
      ]),
    ).toBe(
      '2 checks not run (x): agent-profile file resolution, extension modules, manifest and config_schema',
    );
  });

  it('the legacy reason names the missing field and the version', () => {
    expect(notRunReason('source_dir', undefined)).toBe(
      'no source_dir recorded (registered before v0.14)',
    );
  });

  it('empty input renders nothing (every check ran)', () => {
    expect(renderChecksNotRunLine([])).toBe('');
  });
});
