// step-key-registry.test.ts — issue #417 PR-2: the core half of the bidirectional conformance
// lock. Four instruments, run against the registry declared in step-key-registry.ts:
//   (1) the derived-count pin — the registry's key set is read FROM KNOWN_STEP_KEYS, never typed
//       by hand, and the 36×4=144 arithmetic is asserted so a missing mode is visible in a report
//       even though the `satisfies` clause already turns it into a compile error;
//   (2) the behavioral cells — every prohibited / inert / blocked_transitive cell is driven
//       through the REAL loader on a purpose-built fixture:
//         - prohibited: refused, with at least one error naming the key, and (where the cell
//           carries one) the message_data tail byte-contained in that error;
//         - inert: FULL ACCEPTANCE — any refusal at all, named or not, reds the cell and forces
//           the row to be re-classified (this is the row's whole claim: nothing stops it);
//         - blocked_transitive: a two-leg assertion — leg A (bare key, companion absent) is
//           refused naming the key under test; leg B (companion present too) is still refused,
//           but on the COMPANION's own rules, and nothing may name the key under test any more;
//   (3) core-file witnesses — every `where`/`by` pointer into a packages/core/ file is checked
//       for an EXACT count match against real source (comment-stripped, whitespace-normalized);
//   (4) loop membership by VALUE — every cell whose by-witness is one of the two kind-prohibition
//       loop templates must, in aggregate, equal the loader's own exported prohibition arrays,
//       member for member, in both directions (so a stale array and a stale registry can never
//       silently agree with each other).
// The CLI/mcp-server-file witnesses live in
// packages/cli/src/step-key-registry-conformance.test.ts — this package only ever reads its own
// source, per the purge-guard walker's convention for cross-package source-text assertions.
//
// COEXISTENCE (design-d2 F13): these behavioral cells deliberately coexist with the hand-written
// per-key pins already in yaml-loader.test.ts. Different mechanism, same rule pool — don't dedupe
// either side.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import {
  STEP_KEY_REGISTRY,
  TRACKED_RESIDUALS,
  FINALIZER_LOOP_PATTERN,
  GUARD_LOOP_PATTERN,
  countWitnessMatches,
  type StepKeyCell,
  type StepKeyWitness,
  type StepKeyVia,
} from './step-key-registry.js';
import {
  loadWorkflowFromStringWithDiagnostics,
  GUARD_PROHIBITED_STEP_KEYS,
  FINALIZER_PROHIBITED_STEP_KEYS,
} from './yaml-loader.js';
import { KNOWN_STEP_KEYS, type ExecutionMode } from '../types/workflow-definition.js';
import type { LoaderWarning } from './diagnostics.js';

// packages/core/src/workflow → repo root
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const MODES: ExecutionMode[] = ['auto', 'agent', 'guard', 'finalizer'];

// ————— fixture factory —————
// One base per kind. The finalizer base MUST carry a non-finalizer companion step — a workflow
// consisting only of finalizers is itself refused ("at least one non-finalizer step is
// required"), so no finalizer cell is constructible without one; this is a base-level fact, not
// something any individual cell needs to restate.
type StepShape = Record<string, unknown>;
const BASES: Record<ExecutionMode, { steps: Record<string, StepShape>; target: string }> = {
  auto: { steps: { s: { description: 'd', execution: 'auto' } }, target: 's' },
  agent: { steps: { s: { description: 'd', execution: 'agent' } }, target: 's' },
  guard: {
    steps: { s: { description: 'd', execution: 'guard', abort_unless: 'run.params.ok == true' } },
    target: 's',
  },
  finalizer: {
    steps: {
      c: { description: 'd', execution: 'auto' },
      f: { description: 'd', execution: 'finalizer', handler: 'cleanup', on_outcome: 'fail' },
    },
    target: 'f',
  },
};

// One lawful value per key, chosen so that every KIND-BLIND value/shape rule (schema shape,
// non-empty-array, etc.) already passes — a behavioral cell's error set is then exactly the kind
// rule under test, never incidental value noise.
const VALUE_TABLE: Record<string, unknown> = {
  description: 'd2',
  execution: 'auto',
  depends_on: ['c'], // matches the finalizer base's companion — the one kind this key is live on
  trigger_rule: 'all_done',
  when: 'run.params.ok == true',
  abort_unless: 'run.params.ok == true',
  abort_message: 'stop',
  on_outcome: 'fail',
  idempotent: true,
  uses_service: 'svc',
  service_method: 'fetch',
  operation: 'op',
  input_map: { x: 'run.params.y' },
  handler: 'h',
  config: { a: 1 },
  input_schema: { type: 'object' },
  output_schema: { type: 'object' },
  trace_schema: { type: 'object' },
  trace_validation_mode: 'warn',
  preconditions: ['run.params.ok == true'],
  trust: 'human_confirmed', // D4-1's except-cell (trust×finalizer) probes the OTHER literal, 'auto'
  timeout_seconds: 30,
  retry: { max_attempts: 2 },
  validation_exhaustion: { threshold: 3 },
  instructions: 'do the thing',
  prompt: 'a prompt',
  display: '{{ x }}',
  gate: { choices: ['approve', 'reject'] },
  agent_profile: 'p',
  tools: ['srv:t'],
  max_tool_calls: 2,
  max_fan_out: 2,
  tool_timeout: 5,
  structured_output: 'strict',
  llm_timeout_seconds: 5,
};

// A handful of cells need a workflow- or step-level extra the base+value pair can't express —
// keyed `${key}.${mode}`, applied only to that one fixture.
const FIXTURE_OVERRIDES: Record<string, { workflow?: Record<string, unknown>; step?: StepShape }> =
  {
    // The kind-blind "declared service must exist" check would refuse this fixture for a reason
    // that has nothing to do with kind-inertness on the agent arm — declare the service so the
    // ONLY thing left to observe is whether uses_service itself does anything on an agent step.
    'uses_service.agent': { workflow: { services: { svc: { adapter: 'http' } } } },
  };

function buildFixture(key: string, mode: ExecutionMode, extraStep?: StepShape): string {
  const base = BASES[mode];
  const steps: Record<string, StepShape> = {};
  for (const [name, def] of Object.entries(base.steps)) steps[name] = { ...def };
  const override = FIXTURE_OVERRIDES[`${key}.${mode}`] ?? {};
  steps[base.target] = {
    ...steps[base.target],
    [key]: VALUE_TABLE[key],
    ...(override.step ?? {}),
    ...(extraStep ?? {}),
  };
  return yaml.dump({ id: 'wf', name: 'WF', version: 1, ...(override.workflow ?? {}), steps });
}

type LoadOutcome =
  | { refused: false; warnings: LoaderWarning[] }
  | { refused: true; errors: string[]; warnings: LoaderWarning[] };

function load(doc: string): LoadOutcome {
  try {
    const { warnings } = loadWorkflowFromStringWithDiagnostics(doc);
    return { refused: false, warnings };
  } catch (err) {
    const e = err as { errors?: string[]; message: string; warnings?: LoaderWarning[] };
    return { refused: true, errors: e.errors ?? [e.message], warnings: e.warnings ?? [] };
  }
}

/** An error "names" a key when it quotes it — every kind-prohibition message in the loader
 *  renders the offending key inside single quotes (including the value-scoped trust check, whose
 *  message opens the same way). */
const namesKey = (error: string, key: string): boolean => error.includes(`'${key}`);

const cellOf = (key: string, mode: ExecutionMode): StepKeyCell =>
  (STEP_KEY_REGISTRY as Record<string, Record<ExecutionMode, StepKeyCell>>)[key]![mode];

describe('#417-PR2 — the step-key consumption registry (core conformance)', () => {
  it('takes its key set from KNOWN_STEP_KEYS, and covers all 36 × 4 = 144 cells', () => {
    expect(Object.keys(STEP_KEY_REGISTRY).sort()).toEqual([...KNOWN_STEP_KEYS].sort());
    expect(Object.keys(STEP_KEY_REGISTRY).length * MODES.length).toBe(144);
  });

  it('loop-membership cells equal the loader-exported prohibition arrays, by value, both ways', () => {
    const keysProhibitedVia = (mode: ExecutionMode, loopPattern: string): string[] =>
      [...KNOWN_STEP_KEYS].filter((key) => {
        const cell = cellOf(key, mode);
        return cell.c === 'prohibited' && cell.by.some((w) => w.pattern === loopPattern);
      });
    expect(keysProhibitedVia('guard', GUARD_LOOP_PATTERN).sort()).toEqual(
      [...GUARD_PROHIBITED_STEP_KEYS].sort(),
    );
    expect(keysProhibitedVia('finalizer', FINALIZER_LOOP_PATTERN).sort()).toEqual(
      [...FINALIZER_PROHIBITED_STEP_KEYS].sort(),
    );
  });

  it("the companion-pattern lock: a companion-shaped rule is never spelled 'prohibited' (D4-4)", () => {
    // The two-leg blocked_transitive assertion below cannot detect a TRUE blocked_transitive cell
    // mislabelled 'prohibited' — leg B (the companion-satisfied, zero-naming leg) simply vanishes
    // along with the arm, and leg A's "≥1 error names it" holds regardless of which arm minted
    // it. This lock closes the one known instance of that hole mechanically: any cell whose
    // by-witness IS the companion-requires firing condition (today, only tool_timeout's
    // toolsMissing guard) must carry the blocked_transitive arm, which is the only arm that runs
    // leg B at all. A future companion rule not yet listed here falls back to review — a stated,
    // accepted residual (see this file's sibling registry header).
    const COMPANION_PATTERNS = ["if (step['tool_timeout'] !== undefined && toolsMissing) {"];
    for (const key of KNOWN_STEP_KEYS) {
      for (const mode of MODES) {
        const cell = cellOf(key, mode);
        if (cell.c !== 'prohibited') continue;
        for (const witness of cell.by) {
          expect(
            COMPANION_PATTERNS.includes(witness.pattern),
            `${key}×${mode}: a companion-shaped by-witness on a 'prohibited' cell — this rule is transitive, reclassify as blocked_transitive`,
          ).toBe(false);
        }
      }
    }
  });

  it('every Via is well-formed: waived reasons are non-empty, tracked issues are #-numbers', () => {
    const vias: StepKeyVia[] = [];
    for (const key of KNOWN_STEP_KEYS) {
      for (const mode of MODES) {
        const cell = cellOf(key, mode);
        if (cell.c === 'inert') vias.push(cell.via);
        if (cell.c === 'consumed') for (const sub of cell.inert_subpop ?? []) vias.push(sub.via);
        if (cell.c === 'prohibited' && cell.except !== undefined) vias.push(cell.except.via);
      }
    }
    for (const via of vias) {
      if (via.kind === 'waived') expect(via.reason.trim().length).toBeGreaterThan(0);
      if (via.kind === 'tracked') expect(via.issue).toMatch(/^#\d+$/);
    }
    for (const residual of TRACKED_RESIDUALS) {
      expect(residual.issue).toMatch(/^#\d+$/);
      expect(residual.desc.trim().length).toBeGreaterThan(0);
    }
  });

  // ————— behavioral cells: drive the real loader on a purpose-built fixture per cell —————
  for (const key of KNOWN_STEP_KEYS) {
    for (const mode of MODES) {
      const cell = cellOf(key, mode);

      if (cell.c === 'prohibited') {
        it(`prohibited: ${key}×${mode} — refused, at least one error names the key`, () => {
          const outcome = load(buildFixture(key, mode));
          expect(outcome.refused, `${key}×${mode} should have been refused`).toBe(true);
          if (!outcome.refused) return;
          const naming = outcome.errors.filter((e) => namesKey(e, key));
          expect(naming.length, outcome.errors.join('\n')).toBeGreaterThanOrEqual(1);
          if (cell.message_data !== undefined) {
            expect(
              outcome.errors.some((e) => e.includes(cell.message_data!)),
              `message_data no longer matches the loader's minted text:\n${outcome.errors.join('\n')}`,
            ).toBe(true);
          }
        });
        if (cell.except !== undefined && key === 'trust' && mode === 'finalizer') {
          it(`prohibited-except: trust×finalizer still admits the literal 'auto' (D4-1)`, () => {
            const outcome = load(buildFixture(key, mode, { trust: 'auto' }));
            expect(outcome.refused).toBe(false);
          });
        }
      } else if (cell.c === 'inert') {
        it(`inert: ${key}×${mode} — full acceptance (any refusal forces a row reclassification)`, () => {
          const outcome = load(buildFixture(key, mode));
          expect(
            outcome.refused,
            outcome.refused ? (outcome as { errors: string[] }).errors.join('\n') : '',
          ).toBe(false);
          if (cell.via.kind === 'advisory') {
            expect(outcome.warnings.map((w) => w.code)).toContain(cell.via.code);
          }
        });
      } else if (cell.c === 'blocked_transitive') {
        it(`blocked_transitive: ${key}×${mode} — leg A: bare key is refused, naming it`, () => {
          const outcome = load(buildFixture(key, mode));
          expect(outcome.refused).toBe(true);
          if (!outcome.refused) return;
          expect(outcome.errors.filter((e) => namesKey(e, key)).length).toBeGreaterThanOrEqual(1);
          if (cell.message_data !== undefined) {
            expect(outcome.errors.some((e) => e.includes(cell.message_data!))).toBe(true);
          }
        });
        it(`blocked_transitive: ${key}×${mode} — leg B: companion present ⇒ nothing names the key`, () => {
          // Declaring the companion (cell.via) doesn't make the fixture load clean — the
          // companion carries its own kind rules on this mode too — but the key under test must
          // vanish entirely from the error set. A later direct kind rule on this key would red
          // this leg, correctly forcing a re-arm to 'prohibited'.
          const outcome = load(buildFixture(key, mode, { [cell.via]: VALUE_TABLE[cell.via] }));
          expect(outcome.refused).toBe(true);
          if (!outcome.refused) return;
          expect(outcome.errors.filter((e) => e.includes(key))).toEqual([]);
        });
      }
      // 'consumed' and 'na' cells carry no fixture of their own: consumed is checked purely by
      // witness below, and 'na' is — by definition — not constructible as a loaded fixture at all.
    }
  }

  // ————— core-file witnesses —————
  const sourceCache = new Map<string, string>();
  const readSource = (relPath: string): string => {
    let cached = sourceCache.get(relPath);
    if (cached === undefined) {
      cached = readFileSync(join(REPO_ROOT, relPath), 'utf8');
      sourceCache.set(relPath, cached);
    }
    return cached;
  };
  const coreWitnessesOf = (cell: StepKeyCell): StepKeyWitness[] => {
    const gathered: StepKeyWitness[] = [];
    if (cell.c === 'consumed') {
      gathered.push(...cell.where);
      if (cell.when !== undefined) gathered.push(cell.when.witness);
    } else if (cell.c === 'prohibited' || cell.c === 'blocked_transitive') {
      gathered.push(...cell.by);
    }
    return gathered.filter((w) => w.file.startsWith('packages/core/'));
  };
  for (const key of KNOWN_STEP_KEYS) {
    for (const mode of MODES) {
      const witnesses = coreWitnessesOf(cellOf(key, mode));
      if (witnesses.length === 0) continue;
      it(`witness: ${key}×${mode} — exact count match in core source`, () => {
        for (const witness of witnesses) {
          const found = countWitnessMatches(readSource(witness.file), witness.pattern);
          expect(
            found,
            `${key}×${mode} in ${witness.file}\n  pattern: ${witness.pattern}\n  expected ${witness.count ?? 1}, found ${found}`,
          ).toBe(witness.count ?? 1);
        }
      });
    }
  }
});
