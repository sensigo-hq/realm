// fenced-trace-buffer-contract.ts — framework-agnostic Test Compatibility Kit (TCK) for the
// TraceBufferStore fenced trio (issue #207, converged design D3 — plans/issue-207-design-d3.md
// in the realm repo).
//
// Pure case descriptors, NOT describe/it/expect — mirrors per-run-artifact-store-contract.ts's
// and run-store-fidelity-contract.ts's own precedent (importing vitest here would make it a
// runtime dependency of this published package). Each calling test file supplies an adapter and
// wires the returned descriptors into ITS OWN test framework.
//
// The choreography for CS_OCCUPANCY and NO_SILENT_LOSS is deadlock-free BY CONSTRUCTION (D3 §7 is
// normative — implemented here as written, not improvised): every parked promise has a `.catch`
// attached before the law ever awaits anything else, the "drain" step never depends on the
// latched call's own settlement, and the latch is always released before the law awaits the
// latched call's result.
import { WorkflowError, type TraceBufferStore, type AgentTraceEntry } from '@sensigo/realm';

/** One of the five laws every fenced-trio-declaring `TraceBufferStore` must satisfy (issue #207). */
export type FencedTraceBufferLaw =
  | 'STRUCTURAL'
  | 'FENCE_REFUSES'
  | 'CS_OCCUPANCY'
  | 'PER_KEY_INDEPENDENCE'
  | 'NO_SILENT_LOSS';

/**
 * A single, framework-agnostic contract case. `run()` throws (rejects) on failure — any test
 * framework's `await run()` (rejecting fails the test) or `expect(run()).resolves...` /
 * `expect(run()).rejects...` maps directly onto this.
 */
export interface FencedTraceBufferContractCase {
  law: FencedTraceBufferLaw;
  name: string;
  run: () => Promise<void>;
}

/** Adapter a calling test file supplies to parameterize the contract against one concrete store. */
export interface FencedTraceBufferContractAdapter {
  /** The store under test — already declaring the fenced trio (`appendFenced`/`deleteFenced`/
   *  `deleteAllForRunFenced`). For `fenceForm: 'guard-in-cs'` stores, this instance should already
   *  be constructed with a sufficiently generous lock-acquisition profile (see `lockProfile`
   *  below) so a deliberately-parked guard in the latch-based laws doesn't cause a concurrent
   *  caller's own acquisition attempt to give up before the law's observation window completes. */
  store: TraceBufferStore;
  /** Returns a fresh, never-before-used (runId, stepId) pair for one case — callers should treat
   *  every returned pair as belonging to a disjoint run from every other pair this returns. */
  makeKey: () => { runId: string; stepId: string };
  /**
   * `'guard-in-cs'`: the store enforces the fence via an in-process critical section — the guard
   * literally runs inside the same lock/mutex the destructive effect does. `'native-predicate'`:
   * the store enforces the fence via a transaction-scoped SQL predicate instead (e.g. a future
   * Postgres store) — the latch-based laws (`CS_OCCUPANCY`, `PER_KEY_INDEPENDENCE`,
   * `NO_SILENT_LOSS`) do not apply to this fence form and produce an explicit, VISIBLE
   * documented-skip case rather than a silent omission. **A green TCK run does NOT verify race
   * closure for a native-predicate store** — that store's own in-transaction fencing suite must
   * (the same posture `RunStore.claimStep`'s cross-host obligation already states for
   * `CLAIM_SINGLE_OWNER`, issue #188).
   */
  fenceForm: 'guard-in-cs' | 'native-predicate';
  /** Descriptive only (present for `'guard-in-cs'` adapters): the lock-acquisition profile the
   *  `store` instance above was actually constructed with, for the calling test file's own
   *  documentation — the TCK itself does not need to act on this value; it exists so a wiring
   *  test can assert (and a reader can see) that a genuinely generous profile is in use. */
  lockProfile?: unknown;
}

const REFUSAL_CODE = 'STATE_RUN_BUSY';

/** A guard that always refuses with a typed, populated-category rejection — used by every
 *  FENCE_REFUSES case. Deliberately a real `WorkflowError` (not a bare `Error`) so the law can
 *  assert the reason category actually propagates, not just "something" propagates. */
function refusingGuard(): () => Promise<void> {
  return async () => {
    throw new WorkflowError('fenced-tck: guard refused (simulated)', {
      code: REFUSAL_CODE,
      category: 'STATE',
      agentAction: 'report_to_user',
      retryable: true,
    });
  };
}

function passingGuard(): () => Promise<void> {
  return async () => {};
}

function eventsOf(entries: readonly AgentTraceEntry[]): string[] {
  return entries.map((e) => e.event);
}

function assertDeepEqualEvents(
  actual: readonly AgentTraceEntry[],
  expected: readonly AgentTraceEntry[],
  label: string,
): void {
  const a = eventsOf(actual);
  const e = eventsOf(expected);
  const equal = a.length === e.length && a.every((v, i) => v === e[i]);
  if (!equal) {
    throw new Error(`${label}: expected events ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
  }
}

/**
 * Forces the event loop / I/O queue to advance without a fixed wall-clock sleep and without
 * depending on the latched call's own settlement: ≥5 awaited round-trips of `store.read` against
 * a DISJOINT sentinel key (never written by any other case), plus one trailing `setImmediate`
 * (D3 §7's normative drain). Used before checking a latch-based law's "Phase 1" (occupancy)
 * assertion.
 */
async function drain(store: TraceBufferStore): Promise<void> {
  const sentinelRunId = `fenced-tck-sentinel-run-${Math.random().toString(36).slice(2)}`;
  for (let i = 0; i < 5; i++) {
    await store.read(sentinelRunId, 'fenced-tck-sentinel-step');
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/** A guard that signals when it has been entered (parked) and blocks on an externally-released
 *  latch — the core primitive both CS_OCCUPANCY and PER_KEY_INDEPENDENCE latch a CS open with. */
function makeLatch(): {
  guard: () => Promise<void>;
  entered: Promise<void>;
  release: () => void;
} {
  let releaseFn: () => void;
  const latchPromise = new Promise<void>((resolve) => {
    releaseFn = resolve;
  });
  let enteredResolve: () => void;
  const entered = new Promise<void>((resolve) => {
    enteredResolve = resolve;
  });
  const guard = async (): Promise<void> => {
    enteredResolve();
    await latchPromise;
  };
  return {
    guard,
    entered,
    release: () => releaseFn(),
  };
}

/** Settlement outcome recorder — lets a law check "has this promise ALREADY settled" without
 *  awaiting it (which would just wait for eventual settlement, defeating the point of checking a
 *  point-in-time occupancy snapshot after `drain`). The recorder promise itself is pre-attached
 *  with a no-op catch so an eventual rejection observed only for BOOKKEEPING never produces an
 *  unhandled-rejection warning. */
function recordSettlement<T>(p: Promise<T>): {
  outcome: () => 'pending' | 'fulfilled' | 'rejected';
  error: () => unknown;
} {
  let state: 'pending' | 'fulfilled' | 'rejected' = 'pending';
  let capturedError: unknown;
  p.then(
    () => {
      state = 'fulfilled';
    },
    (err) => {
      state = 'rejected';
      capturedError = err;
    },
  );
  return { outcome: () => state, error: () => capturedError };
}

type CsHolder = 'appendFenced' | 'deleteFenced' | 'deleteAllForRunFenced';

/** Starts `holder` latched open on (runId, stepId), returning the parked promise + latch handle.
 *  Every fenced method requires an existing store to hold — for delete/deleteAllForRunFenced, the
 *  key is pre-seeded with a throwaway entry (the specific content doesn't matter; only that the
 *  operation has something to act on). */
async function startLatchedHolder(
  store: TraceBufferStore,
  holder: CsHolder,
  runId: string,
  stepId: string,
  entriesForAppend: AgentTraceEntry[],
): Promise<{ parkedP: Promise<unknown>; latch: ReturnType<typeof makeLatch> }> {
  const latch = makeLatch();
  let parkedP: Promise<unknown>;
  if (holder === 'appendFenced') {
    parkedP = store.appendFenced!(runId, stepId, entriesForAppend, latch.guard);
  } else if (holder === 'deleteFenced') {
    parkedP = store.deleteFenced!(runId, stepId, latch.guard);
  } else {
    parkedP = store.deleteAllForRunFenced!(runId, latch.guard);
  }
  await latch.entered;
  return { parkedP, latch };
}

/** Builds the CS_OCCUPANCY case for one `holder` kind (issue #207, D3 §7). */
function buildCsOccupancyCase(
  adapter: FencedTraceBufferContractAdapter,
  holder: CsHolder,
): FencedTraceBufferContractCase {
  return {
    law: 'CS_OCCUPANCY',
    name: `${holder} holding the CS: concurrent read/delete/deleteAllForRun neither succeed during occupancy nor corrupt state after release`,
    run: async () => {
      const { store } = adapter;
      const { runId, stepId } = adapter.makeKey();
      const B1: AgentTraceEntry[] = [{ event: 'b1-e0' }, { event: 'b1-e1' }];
      await store.append(runId, stepId, B1);

      const B2: AgentTraceEntry[] = [{ event: 'b2-e0' }];
      const { parkedP, latch } = await startLatchedHolder(store, holder, runId, stepId, B2);

      const readP = store.read(runId, stepId);
      const deleteP = store.delete(runId, stepId);
      const deleteAllP = store.deleteAllForRun(runId);
      // Attach catches BEFORE draining — deadlock/unhandled-rejection-free by construction.
      const readRec = recordSettlement(readP.catch((e) => Promise.reject(e)));
      const deleteRec = recordSettlement(deleteP.catch((e) => Promise.reject(e)));
      const deleteAllRec = recordSettlement(deleteAllP.catch((e) => Promise.reject(e)));

      await drain(store);

      // Phase 1 (occupancy): NONE of the three may have completed SUCCESSFULLY yet — still
      // pending, or a typed lock-contention rejection, both conform. Immediate success is the
      // deterministic red.
      for (const [label, rec] of [
        ['read', readRec],
        ['delete', deleteRec],
        ['deleteAllForRun', deleteAllRec],
      ] as const) {
        if (rec.outcome() === 'fulfilled') {
          throw new Error(
            `CS_OCCUPANCY violated (holder=${holder}): ${label}() completed successfully while ` +
              'the CS was still latched open — it must remain pending or reject with a typed ' +
              'lock-contention error until the latch releases.',
          );
        }
      }

      // Phase 2 (visibility): release the latch FIRST, then let everything settle.
      latch.release();
      await parkedP;
      await Promise.allSettled([readP, deleteP, deleteAllP]);

      const finalRead = await store.read(runId, stepId);
      const fullBatch = holder === 'appendFenced' ? [...B1, ...B2] : B1;
      const isFullBatch =
        eventsOf(finalRead).length === eventsOf(fullBatch).length &&
        eventsOf(finalRead).every((v, i) => v === eventsOf(fullBatch)[i]);
      const isEmpty = finalRead.length === 0;
      if (!isFullBatch && !isEmpty) {
        throw new Error(
          `CS_OCCUPANCY violated (holder=${holder}): expected exactly the full committed batch ` +
            `or exactly [] after release, got ${JSON.stringify(eventsOf(finalRead))} — a partial/` +
            'garbled result means the CS did not actually serialize these operations.',
        );
      }
    },
  };
}

/** The single-waiter subcase (issue #207, D3 §7): park a holder, start exactly ONE concurrent
 *  `read()`, release — the read must show deterministic FULL-batch visibility (no "or []" arm,
 *  since a read never destroys data — this is the case's whole point: with no concurrent
 *  destroyer in the mix, visibility after release is unambiguous). */
function buildCsOccupancySingleWaiterCase(
  adapter: FencedTraceBufferContractAdapter,
): FencedTraceBufferContractCase {
  return {
    law: 'CS_OCCUPANCY',
    name: 'single-waiter subcase: one concurrent read (no concurrent destroyer) sees deterministic full-batch visibility post-release',
    run: async () => {
      const { store } = adapter;
      const { runId, stepId } = adapter.makeKey();
      const B1: AgentTraceEntry[] = [{ event: 'b1-e0' }];
      await store.append(runId, stepId, B1);

      const B2: AgentTraceEntry[] = [{ event: 'b2-e0' }];
      const { parkedP, latch } = await startLatchedHolder(store, 'appendFenced', runId, stepId, B2);

      const readP = store.read(runId, stepId);
      await drain(store);
      latch.release();
      await parkedP;

      const result = await readP;
      assertDeepEqualEvents(result, [...B1, ...B2], 'single-waiter subcase');
    },
  };
}

function buildPerKeyIndependenceCase(
  adapter: FencedTraceBufferContractAdapter,
): FencedTraceBufferContractCase {
  return {
    law: 'PER_KEY_INDEPENDENCE',
    name: 'a disjoint-run key completes a full append+read round-trip while another key is latched open (global-lock stores hang into the framework timeout — the intended red)',
    run: async () => {
      const { store } = adapter;
      const { runId, stepId } = adapter.makeKey();
      const other = adapter.makeKey();

      const { parkedP, latch } = await startLatchedHolder(store, 'appendFenced', runId, stepId, [
        { event: 'latched' },
      ]);

      await store.append(other.runId, other.stepId, [{ event: 'independent' }]);
      const result = await store.read(other.runId, other.stepId);
      assertDeepEqualEvents(result, [{ event: 'independent' }], 'PER_KEY_INDEPENDENCE');

      latch.release();
      await parkedP;
    },
  };
}

function buildNoSilentLossCase(
  adapter: FencedTraceBufferContractAdapter,
): FencedTraceBufferContractCase {
  return {
    law: 'NO_SILENT_LOSS',
    name: 'a settle (read-then-delete) starting while append is parked adopts the full committed batch — never silent loss',
    run: async () => {
      const { store } = adapter;
      const { runId, stepId } = adapter.makeKey();
      const B: AgentTraceEntry[] = [{ event: 'b0' }, { event: 'b1' }];

      let settledFlag = false;
      let releaseLatchFn: () => void;
      const latch = new Promise<void>((resolve) => {
        releaseLatchFn = resolve;
      });
      let enteredResolveFn: () => void;
      const entered = new Promise<void>((resolve) => {
        enteredResolveFn = resolve;
      });

      const guard = async (): Promise<void> => {
        enteredResolveFn();
        if (settledFlag) {
          throw new WorkflowError('fenced-tck: refused (settled already)', {
            code: REFUSAL_CODE,
            category: 'STATE',
            agentAction: 'report_to_user',
            retryable: true,
          });
        }
        await latch;
      };

      const appendP = store.appendFenced!(runId, stepId, B, guard);
      // Detect (and safely ignore afterwards) a premature settlement — the conforming store must
      // not settle appendP before its guard has been entered.
      const prematureSettle = appendP.then(
        () => {
          throw new Error(
            'appendFenced settled (fulfilled) before entering its guard — NO_SILENT_LOSS setup invariant violated',
          );
        },
        () => {
          throw new Error(
            'appendFenced settled (rejected) before entering its guard — NO_SILENT_LOSS setup invariant violated',
          );
        },
      );
      prematureSettle.catch(() => {}); // only used for the race below; its later settlement is expected
      await Promise.race([entered, prematureSettle]);

      settledFlag = true;

      // Start (never await) the settle sequence.
      const settleP = store
        .read(runId, stepId)
        .then((adopted) => store.delete(runId, stepId).then(() => adopted));

      await drain(store);
      releaseLatchFn!();

      const committed = await appendP;
      if (committed.buffer_count !== B.length) {
        throw new Error(
          `NO_SILENT_LOSS: expected appendFenced to commit all ${B.length} entries, got ` +
            `buffer_count=${committed.buffer_count}`,
        );
      }

      const adopted = await settleP;
      assertDeepEqualEvents(
        adopted,
        B,
        'NO_SILENT_LOSS (an unlocked or CS-split settle yields [] with the append still committed)',
      );

      const finalRead = await store.read(runId, stepId);
      if (finalRead.length !== 0) {
        throw new Error(
          `NO_SILENT_LOSS: expected the buffer empty after the settle's delete, got ${finalRead.length} entries`,
        );
      }
    },
  };
}

/**
 * Builds the contract cases for `adapter`. See each law's own doc above (the `build*Case`
 * functions) for what it asserts. For `fenceForm: 'native-predicate'` adapters, `CS_OCCUPANCY`,
 * `PER_KEY_INDEPENDENCE`, and `NO_SILENT_LOSS` are replaced with an explicit, VISIBLE
 * documented-skip case each (never a silent omission) — see the adapter's own `fenceForm` doc.
 */
export function fencedTraceBufferContract(
  adapter: FencedTraceBufferContractAdapter,
): FencedTraceBufferContractCase[] {
  const cases: FencedTraceBufferContractCase[] = [];
  const { store } = adapter;

  // ── STRUCTURAL ──────────────────────────────────────────────────────────────────────────────
  cases.push({
    law: 'STRUCTURAL',
    name: 'declaring any fenced method requires declaring all three',
    run: async () => {
      const s = store as Partial<TraceBufferStore>;
      const has = {
        appendFenced: typeof s.appendFenced === 'function',
        deleteFenced: typeof s.deleteFenced === 'function',
        deleteAllForRunFenced: typeof s.deleteAllForRunFenced === 'function',
      };
      const anyDeclared = has.appendFenced || has.deleteFenced || has.deleteAllForRunFenced;
      const allDeclared = has.appendFenced && has.deleteFenced && has.deleteAllForRunFenced;
      if (anyDeclared && !allDeclared) {
        throw new Error(
          `store declares a SUBSET of the fenced trio (must be all-or-nothing): ${JSON.stringify(has)}`,
        );
      }
    },
  });

  // ── FENCE_REFUSES ───────────────────────────────────────────────────────────────────────────
  cases.push({
    law: 'FENCE_REFUSES',
    name: 'appendFenced: guard rejection propagates typed with a populated reason category, nothing written',
    run: async () => {
      const { runId, stepId } = adapter.makeKey();
      let caught: unknown;
      try {
        await store.appendFenced!(runId, stepId, [{ event: 'e' }], refusingGuard());
      } catch (err) {
        caught = err;
      }
      if (!(caught instanceof WorkflowError) || caught.code !== REFUSAL_CODE || !caught.category) {
        throw new Error(
          `expected a typed WorkflowError(${REFUSAL_CODE}) with a populated category, got: ${caught}`,
        );
      }
      const after = await store.read(runId, stepId);
      if (after.length !== 0) {
        throw new Error(
          `expected nothing written after a refused appendFenced, got ${after.length} entries`,
        );
      }
    },
  });

  cases.push({
    law: 'FENCE_REFUSES',
    name: 'deleteFenced: guard rejection propagates typed with a populated reason category, nothing deleted',
    run: async () => {
      const { runId, stepId } = adapter.makeKey();
      await store.append(runId, stepId, [{ event: 'seed' }]);
      let caught: unknown;
      try {
        await store.deleteFenced!(runId, stepId, refusingGuard());
      } catch (err) {
        caught = err;
      }
      if (!(caught instanceof WorkflowError) || caught.code !== REFUSAL_CODE || !caught.category) {
        throw new Error(
          `expected a typed WorkflowError(${REFUSAL_CODE}) with a populated category, got: ${caught}`,
        );
      }
      const after = await store.read(runId, stepId);
      if (after.length !== 1) {
        throw new Error(
          `expected the seeded entry to survive a refused deleteFenced, got ${after.length}`,
        );
      }
    },
  });

  cases.push({
    law: 'FENCE_REFUSES',
    name: 'sequential two-call guard-caching kill: pass-guard append then refuse-guard append — second refuses, first entries intact',
    run: async () => {
      const { runId, stepId } = adapter.makeKey();
      const r1 = await store.appendFenced!(runId, stepId, [{ event: 'first' }], passingGuard());
      if (r1.buffer_count !== 1) {
        throw new Error(
          `expected the first append to commit 1 entry, got buffer_count=${r1.buffer_count}`,
        );
      }
      let threw = false;
      try {
        await store.appendFenced!(runId, stepId, [{ event: 'second' }], refusingGuard());
      } catch {
        threw = true;
      }
      if (!threw) {
        throw new Error(
          'expected the second (refuse-guard) append to reject — guard-caching would make this incorrectly pass',
        );
      }
      const after = await store.read(runId, stepId);
      assertDeepEqualEvents(after, [{ event: 'first' }], 'sequential two-call guard-caching kill');
    },
  });

  cases.push({
    law: 'FENCE_REFUSES',
    name: 'deleteAllForRunFenced: refusal with >=2 seeded files — ALL files intact',
    run: async () => {
      const { runId } = adapter.makeKey();
      const stepA = 'fenced-tck-step-a';
      const stepB = 'fenced-tck-step-b';
      await store.append(runId, stepA, [{ event: 'a' }]);
      await store.append(runId, stepB, [{ event: 'b' }]);
      let threw = false;
      try {
        await store.deleteAllForRunFenced!(runId, refusingGuard());
      } catch {
        threw = true;
      }
      if (!threw) {
        throw new Error('expected deleteAllForRunFenced to reject when the guard refuses');
      }
      const a = await store.read(runId, stepA);
      const b = await store.read(runId, stepB);
      if (a.length !== 1 || b.length !== 1) {
        throw new Error(
          `expected both seeded files intact after a refused sweep, got a=${a.length} b=${b.length}`,
        );
      }
    },
  });

  cases.push({
    law: 'FENCE_REFUSES',
    name: 'deleteAllForRunFenced: zero-match sweep still invokes the guard at least once',
    run: async () => {
      const { runId } = adapter.makeKey(); // never written — zero files match
      let guardCalls = 0;
      const countingRefusingGuard = async (): Promise<void> => {
        guardCalls++;
        throw new WorkflowError('fenced-tck: guard refused (simulated)', {
          code: REFUSAL_CODE,
          category: 'STATE',
          agentAction: 'report_to_user',
          retryable: true,
        });
      };
      let threw = false;
      try {
        await store.deleteAllForRunFenced!(runId, countingRefusingGuard);
      } catch {
        threw = true;
      }
      if (!threw) {
        throw new Error(
          'expected a zero-match sweep with a refusing guard to still reject (guard consulted first)',
        );
      }
      if (guardCalls < 1) {
        throw new Error(
          'expected the guard to be invoked at least once even for a zero-match sweep',
        );
      }
    },
  });

  cases.push({
    law: 'FENCE_REFUSES',
    name: 'COUNT_FIDELITY: deleteFenced with a pass-guard returns exactly the seeded entry count',
    run: async () => {
      const { runId, stepId } = adapter.makeKey();
      const N = 5;
      for (let i = 0; i < N; i++) {
        await store.append(runId, stepId, [{ event: `e${i}` }]);
      }
      const count = await store.deleteFenced!(runId, stepId, passingGuard());
      if (count !== N) {
        throw new Error(`expected deleteFenced to return exactly ${N}, got ${count}`);
      }
    },
  });

  // ── Latch-based laws: CS_OCCUPANCY, PER_KEY_INDEPENDENCE, NO_SILENT_LOSS ───────────────────
  if (adapter.fenceForm === 'native-predicate') {
    for (const law of ['CS_OCCUPANCY', 'PER_KEY_INDEPENDENCE', 'NO_SILENT_LOSS'] as const) {
      cases.push({
        law,
        name:
          `SKIPPED for native-predicate stores — TCK-green does NOT verify race closure; ` +
          "the store's own in-transaction fencing suite must (issue #207; the same posture " +
          "CLAIM_SINGLE_OWNER's own cross-host caveat states, issue #188). This case is an " +
          'explicit, visible documented-skip, not a silent omission.',
        run: async () => {
          // Intentional no-op — see the case name for why.
        },
      });
    }
  } else {
    cases.push(buildCsOccupancyCase(adapter, 'appendFenced'));
    cases.push(buildCsOccupancyCase(adapter, 'deleteFenced'));
    cases.push(buildCsOccupancyCase(adapter, 'deleteAllForRunFenced'));
    cases.push(buildCsOccupancySingleWaiterCase(adapter));
    cases.push(buildPerKeyIndependenceCase(adapter));
    cases.push(buildNoSilentLossCase(adapter));
  }

  return cases;
}
