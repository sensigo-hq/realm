// run-phase-fingerprint.test.ts — issue #616 PR-1a unit 2b (design d4-frozen-r3 §3): the phase
// derivation's fingerprint, the stamp a stored phase index carries. Its golden is committed here:
// a change of `deriveRunPhase`'s answers on the corpus fails the suite until the golden is updated.
//
// Each assertion carries the two questions of `~/.claude/TESTING-RULES.md` rule 8 next to it.
import { describe, expect, expectTypeOf, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { RunPhase } from '../types/run-record.js';
import {
  deriveRunPhase,
  LEGACY_PROSE_PATTERNS,
  LEGACY_PROSE_WITNESSES,
  RUN_PHASE_CORPUS_AXES,
  runPhaseDerivationCorpus,
  runPhaseDerivationFingerprint,
  type RunPhaseCorpusAxes,
  type RunPhaseDerivationInput,
} from './eligibility.js';

/**
 * The committed golden. Update it only when `deriveRunPhase`'s answers are meant to change, and add
 * the CHANGELOG line that names `realm db migrate` (stored phase indexes carry the old stamp).
 */
const GOLDEN = 'cb1a409f4af77e6c';

/** Every phase the derivation can return; `satisfies` makes a new phase a compile error here. */
const PHASES = {
  running: true,
  gate_waiting: true,
  completed: true,
  failed: true,
  abandoned: true,
  aborted: true,
} satisfies Record<RunPhase, true>;

describe('#616 PR-1a unit 2b — the phase derivation fingerprint', () => {
  it('the fingerprint equals the committed golden', () => {
    const now = runPhaseDerivationFingerprint();
    // (1) Can it fail: red when an answer of `deriveRunPhase` on the corpus changes (the named
    //     break: one branch of the derivation returns another phase), or the corpus changes.
    // (2) Prints: the new fingerprint, the golden, and how to update it: no record, no secret.
    expect(
      now,
      `the phase derivation's answers changed: its fingerprint is ${now}, the golden is ${GOLDEN}. If the change is meant, set GOLDEN to '${now}' in run-phase-fingerprint.test.ts and add a CHANGELOG line naming \`realm db migrate\`.`,
    ).toBe(GOLDEN);
  });

  it('the corpus answers every phase, and every legacy prose pattern has its witness in it', () => {
    const answers = new Set(runPhaseDerivationCorpus().map((run) => deriveRunPhase(run)));
    const reasons = new Set(RUN_PHASE_CORPUS_AXES.terminal_reason);
    const witnessed = new Map(
      LEGACY_PROSE_WITNESSES.map(([pattern, witness]) => [pattern, witness]),
    );
    const matches = (pattern: string | RegExp, s: string): boolean =>
      typeof pattern === 'string' ? s === pattern : pattern.test(s);
    // (1) Can it fail: red when a phase is never answered, or a pattern has no witness (the named
    //     break: delete one witness from LEGACY_PROSE_WITNESSES), or a witness does not match its
    //     pattern or is not in the corpus's reasons.
    // (2) Prints: the phases never answered and the patterns with no witness, by their source text.
    expect({
      phasesNeverAnswered: Object.keys(PHASES).filter((p) => !answers.has(p as RunPhase)),
      patternsWithoutWitness: LEGACY_PROSE_PATTERNS.filter((pattern) => {
        const witness = witnessed.get(pattern);
        return witness === undefined || !matches(pattern, witness) || !reasons.has(witness);
      }).map(String),
    }).toEqual({ phasesNeverAnswered: [], patternsWithoutWitness: [] });
  });

  it('the corpus table must vary every field the derivation reads (a type-level cell)', () => {
    // (1) Can it fail: at compile time (`typecheck:tests`, and the build for the real table's
    //     `satisfies`). Red when the table type stops requiring a field (the named break: a field
    //     removed from RUN_PHASE_CORPUS_AXES fails the build; a type that drops one leaves the
    //     `@ts-expect-error` below unused).
    // (2) Prints: tsc's error naming the missing field.
    expectTypeOf<keyof RunPhaseCorpusAxes>().toEqualTypeOf<keyof RunPhaseDerivationInput>();
    // @ts-expect-error — a table without `pending_gate` is not a corpus table.
    const missing: RunPhaseCorpusAxes = {
      terminal_state: [false],
      failed_steps: [[]],
      terminal_reason: [undefined],
      aborted_at: [undefined],
      abandoned_at: [undefined],
      sealed_by: [undefined],
    };
    void missing;
  });

  it(
    'the fingerprint is the same on every call and in two other processes',
    { timeout: 30_000 },
    () => {
      const core = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
      const inChild = (): string =>
        spawnSync(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            `import { runPhaseDerivationFingerprint } from ${JSON.stringify(core)}; process.stdout.write(runPhaseDerivationFingerprint());`,
          ],
          { encoding: 'utf8', timeout: 20_000 },
        ).stdout;
      // (1) Can it fail: red when the corpus or the hash depends on the clock or chance (the named
      //     break: the corpus gains `Date.now() % 1000` extra records, so each process builds another).
      // (2) Prints: the four values (16 hex characters each).
      expect([
        runPhaseDerivationFingerprint(),
        runPhaseDerivationFingerprint(),
        inChild(),
        inChild(),
      ]).toEqual([GOLDEN, GOLDEN, GOLDEN, GOLDEN]);
    },
  );
});
