// run-phase-fingerprint.test.ts — issue #616 PR-1a unit 2b (design d4-frozen-r3 §3): the phase
// derivation's fingerprint, the stamp a stored phase index carries. Its golden is committed here:
// a change of `deriveRunPhase`'s answers on the corpus fails the suite until the golden is updated.
//
// Each assertion carries the two questions of `~/.claude/TESTING-RULES.md` rule 8 next to it.
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import type { RunPhase } from '../types/run-record.js';
import {
  deriveRunPhase,
  LEGACY_PROSE_PATTERNS,
  LEGACY_PROSE_WITNESSES,
  RUN_PHASE_CORPUS_AXES,
  runPhaseDerivationCorpus,
  runPhaseDerivationFingerprint,
  type RunPhaseCorpusAxes,
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

  it('the three functions that test a run terminal_reason test it only against the listed patterns', () => {
    // The prose battery, the aborted-marker branch and the legacy-seal function, read as source: a
    // pattern written inline there (a regex or string literal, or a constant not in
    // LEGACY_PROSE_PATTERNS) has no witness in the corpus, so the fingerprint would not see it move.
    // The ladder at the end of `deriveRunPhase` is not read: its own literal sits in a branch no
    // terminal record reaches.
    const source = readFileSync(
      fileURLToPath(new URL('./eligibility.ts', import.meta.url)),
      'utf8',
    );
    const file = ts.createSourceFile('eligibility.ts', source, ts.ScriptTarget.Latest, true);
    const functions = new Map<string, ts.FunctionDeclaration>();
    let listed: string[] | undefined;
    const collect = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
        functions.set(node.name.text, node);
      }
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === 'LEGACY_PROSE_PATTERNS' &&
        node.initializer !== undefined &&
        ts.isArrayLiteralExpression(node.initializer)
      ) {
        listed = node.initializer.elements.map((e) =>
          (ts.isSpreadElement(e) ? e.expression : e).getText(file),
        );
      }
      ts.forEachChild(node, collect);
    };
    collect(file);
    const allowed = new Set(listed ?? []);
    const isReason = (n: ts.Node): boolean =>
      (ts.isIdentifier(n) && n.text === 'reason') ||
      (ts.isPropertyAccessExpression(n) && n.name.text === 'terminal_reason');
    // `FAIL_PROSE.some((re) => re.test(reason))`: `re` is a member of a listed array.
    const isListedMember = (id: ts.Identifier): boolean => {
      for (let p: ts.Node | undefined = id.parent; p !== undefined; p = p.parent) {
        if (
          ts.isArrowFunction(p) &&
          p.parameters.some((q) => ts.isIdentifier(q.name) && q.name.text === id.text) &&
          ts.isCallExpression(p.parent) &&
          ts.isPropertyAccessExpression(p.parent.expression) &&
          ts.isIdentifier(p.parent.expression.expression) &&
          allowed.has(p.parent.expression.expression.text)
        ) {
          return true;
        }
      }
      return false;
    };
    const problems: string[] = [];
    if (listed === undefined) problems.push('LEGACY_PROSE_PATTERNS: not found');
    for (const name of ['classifyByProse', 'classifyByAbortedMarker', 'classifyLegacySeal']) {
      const fn = functions.get(name);
      if (fn?.body === undefined) {
        problems.push(`${name}: function not found`);
        continue;
      }
      let tests = 0;
      const check = (node: ts.Node): void => {
        if (isReason(node)) {
          const p = node.parent;
          const ok =
            (ts.isVariableDeclaration(p) && (p.name === node || p.initializer === node)) ||
            (ts.isBinaryExpression(p) &&
              [
                ts.SyntaxKind.EqualsEqualsEqualsToken,
                ts.SyntaxKind.ExclamationEqualsEqualsToken,
              ].includes(p.operatorToken.kind) &&
              (() => {
                const other = p.left === node ? p.right : p.left;
                return (
                  ts.isIdentifier(other) && (other.text === 'undefined' || allowed.has(other.text))
                );
              })()) ||
            (ts.isCallExpression(p) &&
              p.arguments.includes(node as ts.Expression) &&
              ts.isPropertyAccessExpression(p.expression) &&
              p.expression.name.text === 'test' &&
              ts.isIdentifier(p.expression.expression) &&
              (allowed.has(p.expression.expression.text) ||
                isListedMember(p.expression.expression)));
          if (!ok) problems.push(`${name}: ${p.getText(file)}`);
          else if (!ts.isVariableDeclaration(p)) tests += 1;
        }
        ts.forEachChild(node, check);
      };
      check(fn.body);
      if (tests === 0) problems.push(`${name}: tests no reason`);
    }
    // (1) Can it fail: red when one of the three functions tests the reason against an inline regex
    //     or string literal, or a constant not in LEGACY_PROSE_PATTERNS (the named break:
    //     `if (/^Foo/.test(reason)) return 'step_failure';` in the prose battery), or when one of them
    //     cannot be found (a rename), or reads no reason at all.
    // (2) Prints: each problem as the function's name and the offending expression's source text.
    expect(problems).toEqual([]);
  });

  it(
    'the fingerprint is the same on every call and in two other processes',
    { timeout: 30_000 },
    () => {
      const core = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
      const inChild = (): { status: number | null; stdout: string; stderr: string } => {
        const r = spawnSync(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            `import { runPhaseDerivationFingerprint } from ${JSON.stringify(core)}; process.stdout.write(runPhaseDerivationFingerprint());`,
          ],
          { encoding: 'utf8', timeout: 20_000 },
        );
        return { status: r.status, stdout: r.stdout, stderr: r.stderr };
      };
      const children = [inChild(), inChild()];
      const failed = children.filter((c) => c.status !== 0);
      // (1) Can it fail: red when the corpus or the hash depends on the clock or chance (the named
      //     break: the corpus gains `Date.now() % 1000` extra records, so each process builds another),
      //     or when a child cannot run (a missing or stale build of core).
      // (2) Prints: the four values (16 hex characters each); when a child failed, its exit status and
      //     its stderr (Node's own error text: a path and a code, no secret) and that the child reads
      //     the built core, so the build comes first.
      expect(
        [
          runPhaseDerivationFingerprint(),
          runPhaseDerivationFingerprint(),
          ...children.map((c) => c.stdout),
        ],
        failed.length > 0
          ? `a child process failed. The child reads the built core at ${core}: run the build first. ${children.map((c, i) => `child ${i + 1}: exit status ${String(c.status)}, stderr: ${c.stderr.trim().slice(0, 600)}`).join(' | ')}`
          : 'the fingerprint differs between calls or processes',
      ).toEqual([GOLDEN, GOLDEN, GOLDEN, GOLDEN]);
    },
  );
});
