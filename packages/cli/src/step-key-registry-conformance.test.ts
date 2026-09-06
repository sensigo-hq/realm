// step-key-registry-conformance.test.ts — issue #417 PR-2: the CLI-side half of the
// bidirectional conformance lock. The core runner (packages/core/src/workflow/step-key-registry.test.ts)
// checks every registry witness that points into packages/core/; this runner checks every witness
// that points OUTSIDE it — run-agent.ts, cli commands, and mcp-server's protocol generator — since
// this package is a dependency-graph LEAF and can read both its own source and, for a
// cross-package assertion like this one, mcp-server's source too (the purge-guard walker's own
// convention: packages/cli/src/commands/purge-guard.test.ts already reads mcp-server source from
// this package for the same reason).
//
// THE STALE-DIST TRAP: this suite imports the registry from `@sensigo/realm`, i.e. from core's
// BUILT dist, not its source — this package always resolves the core workspace dependency through
// node_modules. Editing the registry and re-running this suite without rebuilding core first
// exercises the OLD registry: green for the wrong reason. Build core, THEN run this suite.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  STEP_KEY_REGISTRY,
  countWitnessMatches,
  KNOWN_STEP_KEYS,
  type StepKeyCell,
  type StepKeyWitness,
} from '@sensigo/realm';

// packages/cli/src → repo root
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MODES = ['auto', 'agent', 'guard', 'finalizer'] as const;

const registryCellOf = (key: string, mode: string): StepKeyCell =>
  (STEP_KEY_REGISTRY as Record<string, Record<string, StepKeyCell>>)[key]![mode]!;

const nonCoreWitnessesOf = (cell: StepKeyCell): StepKeyWitness[] => {
  const gathered: StepKeyWitness[] = [];
  if (cell.c === 'consumed') {
    gathered.push(...cell.where);
    if (cell.when !== undefined) gathered.push(cell.when.witness);
  } else if (cell.c === 'prohibited' || cell.c === 'blocked_transitive') {
    gathered.push(...cell.by);
  }
  return gathered.filter((w) => !w.file.startsWith('packages/core/'));
};

describe('#417-PR2 — the step-key consumption registry (cli + mcp-server witnesses)', () => {
  const sourceCache = new Map<string, string>();
  const readSource = (relPath: string): string => {
    let cached = sourceCache.get(relPath);
    if (cached === undefined) {
      cached = readFileSync(join(REPO_ROOT, relPath), 'utf8');
      sourceCache.set(relPath, cached);
    }
    return cached;
  };

  it('every non-core witness points into a package this runner may read', () => {
    for (const key of KNOWN_STEP_KEYS) {
      for (const mode of MODES) {
        for (const witness of nonCoreWitnessesOf(registryCellOf(key, mode))) {
          expect(
            witness.file.startsWith('packages/cli/') ||
              witness.file.startsWith('packages/mcp-server/'),
            `witness file outside this runner's readable set: ${witness.file}`,
          ).toBe(true);
        }
      }
    }
  });

  for (const key of KNOWN_STEP_KEYS) {
    for (const mode of MODES) {
      const witnesses = nonCoreWitnessesOf(registryCellOf(key, mode));
      if (witnesses.length === 0) continue;
      it(`witness: ${key}×${mode} — exact count match outside core`, () => {
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
