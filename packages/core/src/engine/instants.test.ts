// instants.test.ts — issue #729 PR-0 (D4 P-8, A-15, T-2; Amendment 13 Q10): the ONE parser of a
// run's stored instants and the ONE due test of a stored deadline.
//
// - P-8: `ahead_ms` only for a `past_event`, never for a deadline; ε decides its presence (strictly
//   more than ε ahead); the stamped-ahead sentence names no clock.
// - Q10: an unparseable deadline is never past — pinned on both former copies of the due test
//   (`dueExpiry`, which read a NaN deadline as due; the settlement's `not_expired` refusal, which
//   refused it): they are one answer now.
// - T-2: a deadline not yet passed is never "0 s overdue" — `overdueOf` gives nothing.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CLOCK_SKEW_EPSILON_MS,
  isPastDeadline,
  overdueOf,
  parseStamp,
  readInstant,
  recordStampedAheadSentence,
} from './instants.js';
import { dueExpiry } from './pending.js';
import { applySettlement } from './settlement.js';
import type { RunRecord } from '../types/run-record.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';

const R = new Date('2026-10-16T12:00:00.000Z');
const at = (offsetMs: number): string => new Date(R.getTime() + offsetMs).toISOString();

describe('#729 PR-0 — readInstant (P-8)', () => {
  it('a past event more than ε ahead of the reading carries ahead_ms, the full lead', () => {
    // (a) red when the lead is capped, or ahead_ms is dropped; (b) prints the reading.
    expect(readInstant(at(12_000), 'past_event', R)).toEqual({
      ms: R.getTime() + 12_000,
      ahead_ms: 12_000,
    });
  });

  it('ε decides presence: exactly ε ahead carries none; one millisecond more does', () => {
    // (a) red when the comparison loses its strictness, or ε changes; (b) prints both readings.
    expect([
      'ahead_ms' in readInstant(at(CLOCK_SKEW_EPSILON_MS), 'past_event', R),
      'ahead_ms' in readInstant(at(CLOCK_SKEW_EPSILON_MS + 1), 'past_event', R),
      CLOCK_SKEW_EPSILON_MS,
    ]).toEqual([false, true, 5_000]);
  });

  it('a deadline ahead of the reading never carries ahead_ms — it is simply not due', () => {
    // (a) red when the class is ignored; (b) prints the reading.
    expect(readInstant(at(60_000), 'deadline', R)).toEqual({ ms: R.getTime() + 60_000 });
  });

  it('an unparseable stamp is { absent: unparseable_stamp } — never NaN', () => {
    // (a) red when NaN leaks; (b) prints the reading.
    for (const cls of ['past_event', 'deadline'] as const) {
      expect(readInstant('not a time', cls, R)).toEqual({ absent: 'unparseable_stamp' });
    }
  });

  it('record_stamped_ahead’s sentence names no clock, in whole seconds', () => {
    // (a) red when the sentence blames one clock or changes its unit; (b) prints it.
    expect(recordStampedAheadSentence(12_400)).toBe('one of the two clocks is off by 12 s');
  });
});

describe('#729 PR-0 — isPastDeadline and overdueOf (A-15, T-2, Q10)', () => {
  it('past at the deadline itself and after it; not before (the engine’s `!(at < deadline)`)', () => {
    // (a) red when the boundary moves; (b) prints the three answers.
    expect([isPastDeadline(at(1), R), isPastDeadline(at(0), R), isPastDeadline(at(-1), R)]).toEqual(
      [false, true, true],
    );
  });

  it('Q10: an unparseable deadline is never past', () => {
    // (a) red when NaN reads as due (`!(at < NaN)` is true); (b) prints the answer.
    expect(isPastDeadline('not a time', R)).toBe(false);
  });

  it('T-2: overdue only when past — never "0 s" for a deadline not yet due; absent for an unparseable one', () => {
    // (a) red when a future deadline gets an overdue figure; (b) prints the three readings.
    expect([overdueOf(at(1), R), overdueOf(at(-1_500), R), overdueOf('nope', R)]).toEqual([
      undefined,
      { ms: 1_500 },
      { absent: 'unparseable_stamp' },
    ]);
  });

  it('Q10 on both former copies: the view offers no expiry and the settlement does not expire on an unparseable deadline', () => {
    const gate = {
      gate_id: 'g',
      step_name: 'q',
      preview: {},
      choices: ['approve', 'reject'],
      opened_at: at(-120_000),
      expires_at: 'not a time',
      on_expiry: 'abort' as const,
    };
    // (a) red when either copy reads the stamp its own way again; (b) prints both answers.
    const run = {
      id: 'r',
      workflow_id: 'w',
      workflow_version: 1,
      completed_steps: [],
      in_progress_steps: ['q'],
      failed_steps: [],
      skipped_steps: [],
      run_phase: 'gate_waiting',
      version: 3,
      params: {},
      evidence: [],
      created_at: at(-120_000),
      updated_at: at(-120_000),
      terminal_state: false,
      pending_gate: gate,
    } as unknown as RunRecord;
    const def: WorkflowDefinition = {
      id: 'w',
      name: 'w',
      version: 1,
      steps: { q: { description: 'q', execution: 'agent', depends_on: [] } },
    };
    const settled = applySettlement(run, { kind: 'expire_gate', gateId: 'g' }, def, { at: R });
    expect({
      view: dueExpiry(gate, R),
      settlement: settled.applied ? 'applied' : settled.reason,
    }).toEqual({ view: undefined, settlement: 'not_expired' });
  });
});

// #715 (b) A.2 (D-25): the ONE parser of a stored stamp. `readInstant` and every production read of a
// stored instant call `parseStamp`; the source cell below keeps the rest of core from parsing one.
describe('#715 (b) A.2 — parseStamp, the one stamp parser', () => {
  it('a parseable stamp gives its epoch ms; an unparseable one gives undefined — never NaN', () => {
    // (a) red when NaN leaks (Date.parse returned bare) or a valid stamp is refused; (b) prints both.
    expect([parseStamp(at(0)), parseStamp('garbage'), parseStamp('')]).toEqual([
      R.getTime(),
      undefined,
      undefined,
    ]);
  });

  it('source: core parses stored stamps only in instants.ts — Date.parse elsewhere is a named non-stamp parser, and no hand-rolled new Date(<stamp>).getTime() remains', () => {
    // (a) red when a production file outside instants.ts parses a stored stamp itself (a new
    //     Date.parse site, or a `new Date(x_at|deadline|since).getTime()`); (b) prints the sites.
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    const files = sourceFiles(join(root, 'core', 'src'))
      .concat(sourceFiles(join(root, 'cli', 'src')))
      .concat(sourceFiles(join(root, 'mcp-server', 'src')))
      .concat(sourceFiles(join(root, 'testing', 'src')));
    const dateParse: string[] = [];
    const handRolled: string[] = [];
    for (const f of files) {
      const rel = relative(root, f).split(sep).join('/');
      readFileSync(f, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (rel.startsWith('core/') && line.includes('Date.parse(')) dateParse.push(rel);
          if (/new Date\([^)]*(_at|deadline|since)[^)]*\)\.getTime\(\)/.test(line))
            handRolled.push(`${rel}:${i + 1}`);
        });
    }
    expect(dateParse.sort()).toEqual([
      'core/src/economics/cache-economics.ts', // a price-file `at` (config), not a run's stamp
      'core/src/economics/price-source.ts', // the same, validated at load
      'core/src/engine/instants.ts', // parseStamp itself
      'core/src/store/test-clock-file.ts', // a test location's clock file, not a run's stamp
    ]);
    expect(handRolled).toEqual([]);
  });
});

/** Every non-test, non-declaration .ts/.mjs source file under `dir`, recursively. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|mjs)$/.test(entry.name) && !/\.test\.ts$|\.d\.ts$/.test(entry.name))
      out.push(full);
  }
  return out;
}
