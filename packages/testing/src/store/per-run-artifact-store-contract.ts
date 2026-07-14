// per-run-artifact-store-contract.ts — framework-agnostic Test Compatibility Kit (TCK) for
// PerRunArtifactStore implementations (issue #183).
//
// Pure case descriptors, NOT describe/it/expect: importing vitest here would make it a runtime
// dependency of this published package (this module ships in @sensigo/realm-testing's dist,
// alongside runFixtureTests and the other framework-agnostic helpers in this package). Each
// calling test file (one per concrete store) supplies an adapter and wires the returned
// descriptors into ITS OWN test framework.
//
// Fault injection is an OPAQUE, adapter-supplied `injectFailure` callback — never a prescribed
// mechanism. In particular, do NOT use `chmod 0o500` as an injector: it is a no-op on Windows and
// silently ineffective when the test process runs as root (common in CI containers) — either way
// L3 would pass VACUOUSLY (the "failure" never actually happens, so `deleteAllForRun` resolves
// exactly as it should for a genuine success, and the law reports green for the wrong reason). A
// robust injector replaces the target with a directory (works on every platform, any uid — you
// cannot `unlink`/`readFile` a directory as if it were a file, regardless of permissions) or, for
// a store with no filesystem at all (e.g. a future Postgres-backed store), mocks the underlying
// I/O call to reject.
//
// Usage (see json-file-store.test.ts / failed-attempt-store.test.ts / json-trace-buffer-store.test.ts
// for the real wiring): construct a FRESH adapter per law you exercise — `deleteAllForRun` is
// destructive (L2 deletes the seeded artifact) and `injectFailure` mutates on-disk state, so
// reusing one adapter/store instance across multiple laws in sequence is not safe.
//
//   const cases = perRunArtifactStoreContract(makeAdapter());
//   for (const c of cases) {
//     it(`${c.law}: ${c.name}`, async () => {
//       const freshCases = perRunArtifactStoreContract(makeAdapter()); // fresh per law
//       await freshCases.find((x) => x.law === c.law)!.run();
//     });
//   }
import { WorkflowError, type PerRunArtifactStore } from '@sensigo/realm';

/** One of the four laws every `PerRunArtifactStore` implementation must satisfy (issue #183). */
export type ArtifactStoreLaw =
  | 'L1_ABSENCE_RESOLVES'
  | 'L2_IDEMPOTENT'
  | 'L3_FAILURE_REJECTS'
  | 'L4_TYPED_REJECTION';

/**
 * A single, framework-agnostic contract case. `run()` throws (rejects) on failure — any test
 * framework's `await run()` (rejecting fails the test) or `expect(run()).resolves...` /
 * `expect(run()).rejects...` maps directly onto this.
 */
export interface ArtifactStoreContractCase {
  law: ArtifactStoreLaw;
  name: string;
  run: () => Promise<void>;
}

/** Adapter a calling test file supplies to parameterize the contract against one concrete store. */
export interface PerRunArtifactStoreContractAdapter {
  /** The store under test. */
  store: PerRunArtifactStore;
  /**
   * A runId guaranteed to have at least one real, present artifact this store owns, seeded
   * BEFORE the case runs. L2 (idempotent) and L3/L4 (failure) all act on this runId.
   */
  runIdWithArtifact: string;
  /** A runId guaranteed to own NO artifact at all (never seeded). Used by L1. */
  runIdAbsent: string;
  /**
   * Makes the artifact(s) for `runIdWithArtifact` genuinely unreachable (a non-ENOENT failure) —
   * e.g. replace the target file with a directory, or mock the underlying I/O call to reject.
   * Called immediately before L3/L4 exercise the store. The calling test file is responsible for
   * ensuring this actually produces a hard failure on its platform — see the module doc above for
   * why `chmod 0o500` is disqualified.
   */
  injectFailure: (runId: string) => void | Promise<void>;
}

export function perRunArtifactStoreContract(
  adapter: PerRunArtifactStoreContractAdapter,
): ArtifactStoreContractCase[] {
  return [
    {
      law: 'L1_ABSENCE_RESOLVES',
      name: 'deleteAllForRun resolves (never rejects) for a run that owns no artifact',
      run: async () => {
        await adapter.store.deleteAllForRun(adapter.runIdAbsent);
      },
    },
    {
      law: 'L2_IDEMPOTENT',
      name: 'deleteAllForRun is idempotent — a second call after a successful delete still resolves',
      run: async () => {
        await adapter.store.deleteAllForRun(adapter.runIdWithArtifact);
        await adapter.store.deleteAllForRun(adapter.runIdWithArtifact); // already gone — still resolves
      },
    },
    {
      law: 'L3_FAILURE_REJECTS',
      name: 'deleteAllForRun rejects when the artifact exists but is genuinely unreachable (non-ENOENT)',
      run: async () => {
        await adapter.injectFailure(adapter.runIdWithArtifact);
        let threw = false;
        try {
          await adapter.store.deleteAllForRun(adapter.runIdWithArtifact);
        } catch {
          threw = true;
        }
        if (!threw) {
          throw new Error(
            'deleteAllForRun resolved despite an injected non-ENOENT failure — the store ' +
              'reported success for an artifact it could not actually delete (issue #183).',
          );
        }
      },
    },
    {
      law: 'L4_TYPED_REJECTION',
      name: 'the L3 rejection is a WorkflowError carrying a code and details.failures',
      run: async () => {
        await adapter.injectFailure(adapter.runIdWithArtifact);
        let caught: unknown;
        try {
          await adapter.store.deleteAllForRun(adapter.runIdWithArtifact);
          throw new Error('expected deleteAllForRun to reject, but it resolved');
        } catch (err) {
          caught = err;
        }
        if (!(caught instanceof WorkflowError)) {
          const kind = caught instanceof Error ? caught.constructor.name : typeof caught;
          throw new Error(`expected a WorkflowError rejection, got: ${kind}`);
        }
        if (typeof caught.code !== 'string' || caught.code.length === 0) {
          throw new Error('WorkflowError.code is missing or empty');
        }
        const failures = (caught.details as { failures?: unknown } | undefined)?.failures;
        if (!Array.isArray(failures) || failures.length === 0) {
          throw new Error('WorkflowError.details.failures is missing, empty, or not an array');
        }
      },
    },
  ];
}
