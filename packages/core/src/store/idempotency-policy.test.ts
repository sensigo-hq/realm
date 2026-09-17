// issue #558 PR-C (C-7): the idempotency-decision CONTRACT, witnessed.
//
// `decideIdempotencyPolicy` is pure and takes a `Pick<RunRecord, …>` whose shape is public API
// (#279 D-3 leg v — it stays untouched). It therefore TRUSTS the `run_phase` it is handed. Under
// `PHASE_IS_GENERATED` the persisted label can be stale, so a caller that forwards it gets a
// decision computed against a phase the run is not in: a record persisted `completed` that DERIVES
// `failed` yields `reuse` under `rerun_if_failed` — silently reusing a failed run instead of
// rerunning it. Both in-tree callers already derive at the call site; nothing shipped is wrong
// today. What was missing is anything that FAILS when a future caller stops deriving.
//
// Two cells: the contract itself (executed, so the consequence is a fact, not a comment), and a
// source-text witness over every in-tree call site.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { decideIdempotencyPolicy } from './idempotency-policy.js';
import { deriveRunPhase } from '../engine/eligibility.js';
import type { RunRecord } from '../types/run-record.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoSrc = join(here, '..', '..', '..'); // packages/

/** Strip `//` and block comments so a mention inside prose is never counted as a call site. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const CALL_SITE_FILES = [
  join(repoSrc, 'core', 'src', 'store', 'json-file-store.ts'),
  join(repoSrc, 'testing', 'src', 'store', 'in-memory-store.ts'),
] as const;

function makeMatched(over: Partial<RunRecord>): RunRecord {
  const now = new Date().toISOString();
  return {
    id: 'r1',
    workflow_id: 'wf',
    workflow_version: 1,
    completed_steps: [],
    in_progress_steps: [],
    failed_steps: [],
    skipped_steps: [],
    run_phase: 'completed',
    version: 1,
    params: {},
    evidence: [],
    created_at: now,
    updated_at: now,
    terminal_state: true,
    ...over,
  };
}

describe('decideIdempotencyPolicy — the caller-derives contract (issue #558 PR-C)', () => {
  it('trusts the run_phase it is given: a stale `completed` label makes `rerun_if_failed` reuse a FAILED run', () => {
    // The G8 fixture: persisted `completed`, sealed `step_failure` with a failed step ⇒ derives
    // `failed`. This is the function's contract, not a defect — and it is exactly why the witness
    // below exists.
    const matched = makeMatched({
      run_phase: 'completed',
      failed_steps: ['analyze'],
      sealed_by: { arm: 'step_failure' },
    });
    expect(deriveRunPhase(matched)).toBe('failed');

    // Forwarding the PERSISTED label — what a non-deriving caller would do.
    expect(decideIdempotencyPolicy(matched, { onTerminalMatch: 'rerun_if_failed' })).toBe('reuse');

    // Deriving first — what every caller MUST do, and what every in-tree caller does.
    expect(
      decideIdempotencyPolicy(
        { ...matched, run_phase: deriveRunPhase(matched) },
        { onTerminalMatch: 'rerun_if_failed' },
      ),
    ).toBe('supersede');
  });

  it('WITNESS: every in-tree call site passes `run_phase: deriveRunPhase(…)`', () => {
    const sites: { file: string; head: string }[] = [];
    for (const file of CALL_SITE_FILES) {
      const src = stripComments(readFileSync(file, 'utf8'));
      let idx = src.indexOf('decideIdempotencyPolicy(');
      while (idx !== -1) {
        // The first argument reaches at most to the top-level `, options` that follows it; a
        // 200-char window covers every in-tree shape (one-line and Prettier-wrapped).
        sites.push({ file, head: src.slice(idx, idx + 200) });
        idx = src.indexOf('decideIdempotencyPolicy(', idx + 1);
      }
    }

    // Exactly three today (json-file-store ×2, in-memory-store ×1). A NEW call site that does not
    // derive fails the property below; a new call site that does derive raises this count and the
    // author must say so here — deliberately, not silently.
    expect(sites.length).toBe(3);
    for (const site of sites) {
      expect(site.head).toContain('run_phase: deriveRunPhase(');
    }
  });
});
