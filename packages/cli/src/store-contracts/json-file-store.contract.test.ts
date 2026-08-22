// PerRunArtifactStore TCK conformance for JsonFileStore (issue #183).
//
// Lives in @sensigo/realm-cli, NOT in @sensigo/realm's own packages/core test suite, because
// @sensigo/realm-testing depends on @sensigo/realm — a devDependency the other way round would be
// a genuine circular PACKAGE dependency (verified empirically: adding
// `"@sensigo/realm-testing": "*"` to packages/core/package.json's devDependencies makes
// `turbo run build` fail with "Cyclic dependency detected: @sensigo/realm#build,
// @sensigo/realm-testing#build"). @sensigo/realm-cli already depends on BOTH @sensigo/realm and
// @sensigo/realm-testing (no new dependency needed) — and it's also where "does purge's safety
// story hold" is most at home, since purge.ts is the operator-facing caller whose correctness
// this whole contract exists for. store-fs-guard.test.ts's WIRED⇒TCK check looks for this file
// by content (imports JsonFileStore + calls perRunArtifactStoreContract), not by path.
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { JsonFileStore } from '@sensigo/realm';
import {
  perRunArtifactStoreContract,
  type PerRunArtifactStoreContractAdapter,
} from '@sensigo/realm-testing';

const LAWS = [
  'L1_ABSENCE_RESOLVES',
  'L2_IDEMPOTENT',
  'L3_FAILURE_REJECTS',
  'L4_TYPED_REJECTION',
  'L5_REPORT_SHAPE',
  'L6_PREVIEW_EQUALS_RECEIPT',
] as const;

/**
 * Fresh adapter per law: deleteAllForRun is destructive (L2 deletes the seeded artifact) and
 * injectFailure mutates on-disk state — reusing one adapter/store instance across multiple laws
 * in sequence would leak state between them (see per-run-artifact-store-contract.ts's own usage
 * note). injectFailure replaces the run's JSON file with a DIRECTORY — works on every platform
 * and any uid (unlike chmod, which the TCK's own doc explicitly disqualifies).
 */
async function makeAdapter(): Promise<{
  adapter: PerRunArtifactStoreContractAdapter;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'json-file-store-tck-'));
  const store = new JsonFileStore(dir);
  // FIXTURE TEETH (issue #189): the seeded run carries an idempotency KEY, so this store owns TWO
  // artifacts for it — the run file AND the content-addressed pointer. Without the key the run has
  // exactly one artifact, and L6 would be satisfied by a stat that counts only the run file —
  // which is precisely the under-count this issue retires. The law would then pass against the
  // defect it exists to catch.
  const seed = async (): Promise<string> => {
    const { run } = await store.create({
      workflowId: 'wf-tck',
      workflowVersion: 1,
      params: {},
      idempotencyKey: 'tck-key',
    });
    // issue #184: deleteAllForRun now re-verifies terminal state under its own lock and refuses a
    // non-terminal run (the resurrect-race fix) — a fresh store.create() run is 'running' by
    // default, so mark it terminal before the TCK exercises deleteAllForRun against it.
    await store.update({
      ...run,
      run_phase: 'completed',
      terminal_state: true,
      sealed_by: { arm: 'complete' },
    });
    return run.id;
  };
  const runId = await seed();

  // The teeth, ASSERTED rather than assumed: if the pointer is not on disk, this run has one
  // artifact instead of two, and L6 would go green against a stat that counts only the run file.
  // A fixture that silently loses its second artifact turns the law into decoration.
  const pointerPath = join(
    dir,
    'keys',
    `${createHash('sha256').update(`wf-tck\0tck-key`).digest('hex')}.json`,
  );
  if (!existsSync(pointerPath)) {
    throw new Error(
      `TCK fixture is toothless: the idempotency pointer was not created at ${pointerPath}. ` +
        'L6 needs this store to own TWO artifacts for the seeded run (issue #189).',
    );
  }

  const adapter: PerRunArtifactStoreContractAdapter = {
    store,
    runIdWithArtifact: runId,
    runIdAbsent: randomUUID(),
    // Re-creates the run under the SAME id with the SAME key, so L5/L6 each get a freshly-seeded
    // two-artifact run rather than whatever the previous law consumed.
    reseed: async () => {
      await store.save({
        id: runId,
        workflow_id: 'wf-tck',
        workflow_version: 1,
        idempotency_key: 'tck-key',
        completed_steps: [],
        in_progress_steps: [],
        failed_steps: [],
        skipped_steps: [],
        run_phase: 'completed',
        version: 1,
        params: {},
        evidence: [],
        created_at: new Date(0).toISOString(),
        updated_at: new Date(0).toISOString(),
        terminal_state: true,
        terminal_reason: 'Workflow completed.',
        sealed_by: { arm: 'complete' },
      } as never);
    },
    injectFailure: async (runId: string) => {
      const path = join(dir, `${runId}.json`);
      await rm(path, { recursive: true, force: true });
      await mkdir(path);
    },
  };

  return { adapter, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

describe('JsonFileStore — PerRunArtifactStore TCK conformance (issue #183)', () => {
  for (const law of LAWS) {
    it(law, async () => {
      const { adapter, cleanup } = await makeAdapter();
      try {
        const cases = perRunArtifactStoreContract(adapter);
        const target = cases.find((c) => c.law === law);
        expect(target, `no case registered for law ${law}`).toBeDefined();
        await target!.run();
      } finally {
        await cleanup();
      }
    });
  }
});
