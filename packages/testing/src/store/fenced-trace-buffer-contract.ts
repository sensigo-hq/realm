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
import {
  WorkflowError,
  FsIoError,
  type TraceBufferStore,
  type AgentTraceEntry,
  type TraceCapability,
  storeDeclaresSeal,
  storeDeclaresNonceCarriage,
  validateTraceCapabilities,
  BUFFER_LIMIT_COUNT,
  BUFFER_BACKSTOP_COUNT,
  SEALED_ARTIFACTS_LIMIT_PER_STEP,
} from '@sensigo/realm';

/**
 * One of the laws every fenced-trio-declaring `TraceBufferStore` must satisfy. The original five
 * (issue #207) cover the fenced trio itself; the remaining five (issue #197 PR-1) cover the
 * optional capability-ladder rungs a trio-declaring store MAY additionally declare (`seal` and
 * `writer_nonce_carriage`) — each of those five produces an explicit, VISIBLE documented-skip case
 * (never a silent omission) for a store that does not declare the relevant rung, mirroring the
 * `fenceForm: 'native-predicate'` skip precedent already established for the latch-based trio
 * laws below.
 */
export type FencedTraceBufferLaw =
  | 'STRUCTURAL'
  | 'FENCE_REFUSES'
  | 'CS_OCCUPANCY'
  | 'PER_KEY_INDEPENDENCE'
  | 'NO_SILENT_LOSS'
  | 'CARRIAGE_ROUND_TRIP'
  | 'SEAL'
  | 'SEAL_BUDGET'
  | 'PER_WRITER_BUDGET'
  | 'VERBATIM';

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

  /**
   * Per-adapter byte oracle for `PER_WRITER_BUDGET` (issue #197 PR-1) — since the in-memory and fs
   * stores compute "bytes" via genuinely different formulas (whole-array restringify vs
   * JSONL-additive), this TCK can only assert exact ENTRY COUNTS store-agnostically; exact BYTE
   * equality needs each adapter to supply its own oracle, computed however that concrete store's
   * own `AppendResult.buffer_bytes`/`file_bytes` are actually derived. Optional — a store without
   * this hook still runs every count-based `PER_WRITER_BUDGET` assertion; only the byte-exactness
   * sub-assertion is skipped (visibly, never silently) for that adapter.
   */
  bytesOracle?: (
    runId: string,
    stepId: string,
    writerNonce: string | undefined,
  ) => Promise<{ count: number; bytes: number }>;

  /**
   * fs-scoped raw on-disk byte access for `VERBATIM` (issue #197 PR-1) — reads the RAW bytes of a
   * live WAL path and of one sealed artifact (`seq`), so the law can assert a seal moves bytes
   * byte-for-byte (no parse/re-copy/truncation/dedup). `undefined` from either function means "no
   * file at that path" (mirrors `readIfExists`'s absence convention). Optional — a store without
   * this hook (e.g. the in-memory store, which has no on-disk representation at all) skips ONLY
   * the raw-byte-exactness case; the shape-tolerant sibling case still runs unconditionally for
   * every `seal`-declaring store.
   */
  rawWalAccess?: {
    readLiveRaw: (runId: string, stepId: string) => Promise<string | undefined>;
    readSealedRaw: (runId: string, stepId: string, seq: number) => Promise<string | undefined>;
  };
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

/**
 * A minimal, otherwise-legal `TraceBufferStore` STUB (issue #197 PR-1) — implements only the four
 * mandatory legacy methods (never actually called by these cases) plus a HAND-SET
 * `traceCapabilities`, deliberately WITHOUT any of the fenced-trio/seal methods regardless of what
 * `caps` declares. Used exclusively to exercise `validateTraceCapabilities` against a
 * declared-but-inconsistent shape — never mixed with the real adapter store, which always
 * satisfies its OWN declaration (see the "internally consistent" STRUCTURAL case instead).
 */
function minimalStubStore(caps: ReadonlySet<TraceCapability> | undefined): TraceBufferStore {
  return {
    ...(caps !== undefined ? { traceCapabilities: caps } : {}),
    append: async () => ({
      buffer_count: 0,
      buffer_bytes: 0,
      limit_count: 0,
      limit_bytes: 0,
      final_limit_entries: 0,
      final_limit_bytes: 0,
    }),
    read: async () => [],
    delete: async () => {},
    deleteAllForRun: async () => ({ bytes_deleted: 0 }),
    statAllForRun: async () => ({ bytes: 0 }),
    readAllForRun: async () => ({}),
  };
}

/** Runs a SYNCHRONOUS throwing function and returns what it threw, or `undefined` if it didn't —
 *  `validateTraceCapabilities` is synchronous, so this avoids an unnecessary async try/catch at
 *  every call site above. */
function catchSync(fn: () => void): unknown {
  try {
    fn();
    return undefined;
  } catch (err) {
    return err;
  }
}

/** Asserts `err` is exactly the typed `TRACE_CAPABILITY_INCONSISTENT` `WorkflowError`
 *  `validateTraceCapabilities` throws for a declared-but-inconsistent rung, naming `capability` in
 *  its `details` — never some other error shape. */
function assertCapabilityInconsistent(err: unknown, capability: TraceCapability): void {
  if (
    !(err instanceof WorkflowError) ||
    err.code !== 'TRACE_CAPABILITY_INCONSISTENT' ||
    err.details.capability !== capability
  ) {
    throw new Error(
      `expected a typed WorkflowError(TRACE_CAPABILITY_INCONSISTENT, details.capability=${capability}), got: ${err instanceof Error ? err.message : err}`,
    );
  }
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

/**
 * Builds the CS_OCCUPANCY case for one `holder` kind (issue #207, D3 §7).
 *
 * Honest guarantee this law provides (issue #207 correction): it is deterministic-no-false-red —
 * a conforming store can never fail it by bad luck, only a genuinely non-serializing store fails
 * it. It is NOT deterministic-no-false-green against every possible violator: a store whose
 * read/delete merely SKIP the lock (rather than sharing no critical section at all) can, on a
 * sufficiently loaded machine, false-green here — the lock-skipping concurrent call may simply
 * not have reached its own I/O completion yet when the Phase-1 assertion runs, even though it
 * never actually respected the CS. An in-memory (synchronous-scheduling) violator has no such
 * escape and reddens deterministically. Empirically (mutation probe (b), issue #207 correction),
 * the fs store's own lock-skipping mutation reddened deterministically 5/5 runs on a fast,
 * unloaded machine — this does not contradict the caveat above; it shows the false-green risk is
 * a loaded/slow-environment concern, not a claim that the fs law usually (or ever, on a given
 * machine) false-greens.
 *
 * The single-waiter subcase (`buildCsOccupancySingleWaiterCase`, below) is this law's
 * probabilistic net against a "CS-split" store — one that releases its lock/CS handle before the
 * write it guards has actually completed (write-after-release). Such a store could conceivably
 * survive the multi-op Phase 1 above by chance (three concurrent operations racing the same
 * narrow post-release window), but a single, isolated concurrent read is a comparatively larger
 * fraction of that same window to land inside — raising, not guaranteeing, the odds of catching a
 * CS-split violator. Like the caveat above, this is a probabilistic, not deterministic, net.
 */
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
      // pending, or ANY rejection (not just a typed lock-contention error), both conform.
      // Immediate success is the deterministic red. Tolerating any rejection type here (wider
      // than requiring a specific typed lock-contention error) is deliberate (issue #207
      // correction): widening what counts as "conforming" can only ever make this check
      // false-green (a store rejecting for some unrelated reason still passes Phase 1), never
      // false-red — consistent with Phase 1's own guarantee already being one-sided toward
      // false-green, never false-red (see this function's own doc, above).
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

/**
 * Builds the NO_SILENT_LOSS case (issue #207, D3 §7): a settle (read-then-delete) racing a
 * still-parked `appendFenced` must adopt the full committed batch — never lose it silently.
 *
 * Scope note (issue #207 correction): this case only exercises the "settle wins the race, the
 * guard is never asked to refuse" path. The complementary branch — the guard REFUSING because a
 * settle already started (the `settledFlag` check inside this case's own guard) — is deliberately
 * NOT separately re-asserted as its own top-level assertion here: it is absorbed by
 * FENCE_REFUSES's own `appendFenced` refusal case above, which already asserts identical content
 * (typed rejection, nothing written). Duplicating that assertion under this law's banner too would
 * add no additional coverage.
 *
 * The one-sided fs caveat from `buildCsOccupancyCase`'s doc (above) applies here too: against a
 * lock-skipping (rather than genuinely non-serializing) violator, false-green risk here is a
 * loaded/slow-environment concern only, not a claim this case usually passes such a store.
 */
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

/** A visible, non-silent documented-skip case for a law that a store's declared capabilities
 *  don't reach — mirrors the `fenceForm: 'native-predicate'` skip precedent for the latch-based
 *  trio laws. `reason` names exactly why (e.g. "store does not declare 'seal'"). */
function skipCase(
  law: FencedTraceBufferLaw,
  name: string,
  reason: string,
): FencedTraceBufferContractCase {
  return {
    law,
    name: `SKIPPED — ${reason}: ${name}`,
    run: async () => {
      // Intentional no-op — see the case name for why.
    },
  };
}

// ── CARRIAGE_ROUND_TRIP (issue #197 PR-1, the writer_nonce_carriage rung) ────────────────────────
function buildCarriageRoundTripCases(
  adapter: FencedTraceBufferContractAdapter,
): FencedTraceBufferContractCase[] {
  const { store } = adapter;
  if (!storeDeclaresNonceCarriage(store)) {
    return [
      skipCase(
        'CARRIAGE_ROUND_TRIP',
        "nonce round-trip via options.writerNonce and read()'s _nonce",
        "store does not declare 'writer_nonce_carriage'",
      ),
    ];
  }
  return [
    {
      law: 'CARRIAGE_ROUND_TRIP',
      name: 'a nonced append round-trips _nonce on read(); a bare append NEVER has _nonce fabricated',
      run: async () => {
        const { runId, stepId } = adapter.makeKey();
        const NONCE = 'carriage-tck-nonce-1';
        await store.append(runId, stepId, [{ event: 'nonced' }], { writerNonce: NONCE });
        await store.append(runId, stepId, [{ event: 'bare' }]);

        const entries = await store.read(runId, stepId);
        const nonced = entries.find((e) => e.event === 'nonced');
        const bare = entries.find((e) => e.event === 'bare');

        if (nonced?._nonce !== NONCE) {
          throw new Error(
            `expected the nonced entry's _nonce to round-trip as '${NONCE}', got: ${nonced?._nonce}`,
          );
        }
        if (bare !== undefined && Object.prototype.hasOwnProperty.call(bare, '_nonce')) {
          throw new Error(
            `expected the bare entry to have NO _nonce property at all (never fabricated), got: ${JSON.stringify(bare)}`,
          );
        }
      },
    },
  ];
}

// ── SEAL + SEAL_BUDGET (issue #197 PR-1, the seal rung) ──────────────────────────────────────────
function buildSealCases(
  adapter: FencedTraceBufferContractAdapter,
): FencedTraceBufferContractCase[] {
  const { store } = adapter;
  if (!storeDeclaresSeal(store)) {
    return [
      skipCase(
        'SEAL',
        'sealFenced retires a live WAL to a sealed artifact',
        "store does not declare 'seal'",
      ),
      skipCase(
        'SEAL_BUDGET',
        'repeated seals up to SEALED_ARTIFACTS_LIMIT_PER_STEP, then capped',
        "store does not declare 'seal'",
      ),
    ];
  }

  const cases: FencedTraceBufferContractCase[] = [];

  cases.push({
    law: 'SEAL',
    name: 'sealFenced on an absent key returns {sealed:false, reason:"absent"}; the guard still runs',
    run: async () => {
      const { runId, stepId } = adapter.makeKey();
      let guardCalls = 0;
      const result = await store.sealFenced!(runId, stepId, async () => {
        guardCalls++;
      });
      if (!(result.sealed === false && result.reason === 'absent')) {
        throw new Error(`expected {sealed:false, reason:'absent'}, got: ${JSON.stringify(result)}`);
      }
      if (guardCalls < 1) {
        throw new Error('expected the guard to run at least once even for an absent key');
      }
    },
  });

  cases.push({
    law: 'SEAL',
    name: 'sealFenced retires the live WAL: read() goes empty, listSealedForRun reports the same lines',
    run: async () => {
      const { runId, stepId } = adapter.makeKey();
      await store.append(runId, stepId, [{ event: 'a1' }]);
      await store.append(runId, stepId, [{ event: 'a2' }]);

      const result = await store.sealFenced!(runId, stepId, passingGuard());
      if (result.sealed !== true) {
        throw new Error(`expected {sealed:true}, got: ${JSON.stringify(result)}`);
      }

      const afterLive = await store.read(runId, stepId);
      if (afterLive.length !== 0) {
        throw new Error(
          `expected the live WAL empty after sealing, got ${afterLive.length} entries`,
        );
      }

      const sealedArtifacts = await store.listSealedForRun!(runId);
      const thisKeyArtifacts = sealedArtifacts.filter((a) => a.step_id === stepId);
      if (thisKeyArtifacts.length !== 1) {
        throw new Error(
          `expected exactly 1 sealed artifact for this key, got ${thisKeyArtifacts.length}`,
        );
      }
      const sealedEvents = thisKeyArtifacts[0]!.lines.flatMap((l) => l.entries.map((e) => e.event));
      if (JSON.stringify(sealedEvents) !== JSON.stringify(['a1', 'a2'])) {
        throw new Error(
          `expected sealed lines to preserve ['a1','a2'] in order, got ${JSON.stringify(sealedEvents)}`,
        );
      }
    },
  });

  cases.push({
    law: 'SEAL',
    name: 'a refusing guard rejects sealFenced — nothing is moved (live content survives, no new sealed artifact)',
    run: async () => {
      const { runId, stepId } = adapter.makeKey();
      await store.append(runId, stepId, [{ event: 'a' }]);
      const before = await store.listSealedForRun!(runId);

      let caught: unknown;
      try {
        await store.sealFenced!(runId, stepId, refusingGuard());
      } catch (err) {
        caught = err;
      }
      if (!(caught instanceof WorkflowError) || caught.code !== REFUSAL_CODE) {
        throw new Error(`expected a typed WorkflowError(${REFUSAL_CODE}), got: ${caught}`);
      }

      const afterLive = await store.read(runId, stepId);
      if (afterLive.length !== 1) {
        throw new Error(
          `expected the live WAL untouched after a refused seal, got ${afterLive.length} entries`,
        );
      }
      const after = await store.listSealedForRun!(runId);
      if (after.length !== before.length) {
        throw new Error('expected no new sealed artifact after a refused seal');
      }
    },
  });

  cases.push({
    law: 'SEAL',
    name: 'deleteAllForRun retires sealed artifacts for the run too, not just the live WAL',
    run: async () => {
      const { runId, stepId } = adapter.makeKey();
      await store.append(runId, stepId, [{ event: 'a' }]);
      await store.sealFenced!(runId, stepId, passingGuard());
      const beforeCount = (await store.listSealedForRun!(runId)).length;
      if (beforeCount < 1) {
        throw new Error(
          'setup invariant violated: expected at least one sealed artifact before deleteAllForRun',
        );
      }

      await store.deleteAllForRun(runId);

      const after = await store.listSealedForRun!(runId);
      if (after.length !== 0) {
        throw new Error(
          `expected deleteAllForRun to also remove sealed artifacts, got ${after.length} remaining`,
        );
      }
    },
  });

  cases.push({
    law: 'SEAL_BUDGET',
    name: 'repeated seals of the same key succeed up to SEALED_ARTIFACTS_LIMIT_PER_STEP, then return {sealed:false, reason:"capped"} without evicting or losing data',
    run: async () => {
      const { runId, stepId } = adapter.makeKey();
      for (let i = 0; i < SEALED_ARTIFACTS_LIMIT_PER_STEP; i++) {
        await store.append(runId, stepId, [{ event: `e${i}` }]);
        const result = await store.sealFenced!(runId, stepId, passingGuard());
        if (result.sealed !== true) {
          throw new Error(`expected seal #${i} to succeed, got: ${JSON.stringify(result)}`);
        }
      }
      const atCap = (await store.listSealedForRun!(runId)).filter((a) => a.step_id === stepId);
      if (atCap.length !== SEALED_ARTIFACTS_LIMIT_PER_STEP) {
        throw new Error(
          `expected exactly SEALED_ARTIFACTS_LIMIT_PER_STEP (${SEALED_ARTIFACTS_LIMIT_PER_STEP}) sealed artifacts, got ${atCap.length}`,
        );
      }

      await store.append(runId, stepId, [{ event: 'one-too-many' }]);
      const capped = await store.sealFenced!(runId, stepId, passingGuard());
      if (!(capped.sealed === false && capped.reason === 'capped')) {
        throw new Error(`expected {sealed:false, reason:'capped'}, got: ${JSON.stringify(capped)}`);
      }

      // No silent eviction: still exactly the same N sealed artifacts, and the live content that
      // failed to seal is still readable (the caller's fallback path — destructive drain — remains
      // available; this law only asserts nothing was silently lost yet).
      const stillAtCap = (await store.listSealedForRun!(runId)).filter((a) => a.step_id === stepId);
      if (stillAtCap.length !== SEALED_ARTIFACTS_LIMIT_PER_STEP) {
        throw new Error(
          `expected the cap to hold at exactly ${SEALED_ARTIFACTS_LIMIT_PER_STEP} (no eviction), got ${stillAtCap.length}`,
        );
      }
      const liveAfterCapped = await store.read(runId, stepId);
      if (liveAfterCapped.length !== 1 || liveAfterCapped[0]?.event !== 'one-too-many') {
        throw new Error(
          'expected the un-sealable live content to remain readable (fallback-eligible), got: ' +
            JSON.stringify(liveAfterCapped),
        );
      }
    },
  });

  return cases;
}

// ── PER_WRITER_BUDGET (issue #197 PR-1, design §5) ────────────────────────────────────────────────
function buildPerWriterBudgetCases(
  adapter: FencedTraceBufferContractAdapter,
): FencedTraceBufferContractCase[] {
  const { store } = adapter;
  const batch = (n: number, label: string): AgentTraceEntry[] =>
    Array.from({ length: n }, (_, i) => ({ event: `${label}-${i}` }));

  const cases: FencedTraceBufferContractCase[] = [];

  cases.push({
    law: 'PER_WRITER_BUDGET',
    name: "theft-fixed: one writer's near-full own partition does not steal another writer's independent budget on the SAME key",
    run: async () => {
      const { runId, stepId } = adapter.makeKey();
      const NEAR_LIMIT = BUFFER_LIMIT_COUNT - 1;
      await store.append(runId, stepId, batch(NEAR_LIMIT, 'w1'), { writerNonce: 'w1' });
      const r2 = await store.append(runId, stepId, batch(NEAR_LIMIT, 'w2'), { writerNonce: 'w2' });
      // A "theft" bug (partitioning by whole-file instead of by writer) would see w1's NEAR_LIMIT
      // already committed and refuse w2's own NEAR_LIMIT-sized append (combined > BUFFER_LIMIT_COUNT
      // if mistakenly compared against the PER-WRITER ceiling) — a conforming store must not.
      if (r2.buffer_count !== NEAR_LIMIT) {
        throw new Error(
          `expected writer 'w2' to independently commit its own ${NEAR_LIMIT} entries regardless ` +
            `of writer 'w1's own near-full partition on the same key, got buffer_count=${r2.buffer_count}`,
        );
      }
    },
  });

  cases.push({
    law: 'PER_WRITER_BUDGET',
    name: 'the whole-file backstop binds across combined writers even when no single writer exceeds its own per-writer ceiling',
    run: async () => {
      const { runId, stepId } = adapter.makeKey();
      const THIRD = Math.floor(BUFFER_BACKSTOP_COUNT / 3) + 10; // 3× exceeds the backstop; each alone is well under BUFFER_LIMIT_COUNT
      await store.append(runId, stepId, batch(THIRD, 'a'), { writerNonce: 'a' });
      await store.append(runId, stepId, batch(THIRD, 'b'), { writerNonce: 'b' });

      let caught: unknown;
      try {
        await store.append(runId, stepId, batch(THIRD, 'c'), { writerNonce: 'c' });
      } catch (err) {
        caught = err;
      }
      if (!(caught instanceof WorkflowError) || caught.code !== 'BUFFER_FULL') {
        throw new Error(
          `expected a BUFFER_FULL WorkflowError once the combined file exceeds the backstop, got: ${caught}`,
        );
      }
      const details = caught.details as { scope?: string };
      if (details.scope !== 'file') {
        throw new Error(
          `expected details.scope === 'file' for a whole-file-backstop refusal, got: ${JSON.stringify(details)}`,
        );
      }
    },
  });

  if (adapter.bytesOracle !== undefined) {
    cases.push({
      law: 'PER_WRITER_BUDGET',
      name: "byte-exactness (adapter-supplied oracle): AppendResult's writer/file byte numbers match the oracle's own independent computation",
      run: async () => {
        const { runId, stepId } = adapter.makeKey();
        const NONCE = 'byte-oracle-writer';
        const result = await store.append(runId, stepId, [{ event: 'e1' }, { event: 'e2' }], {
          writerNonce: NONCE,
        });
        const oracle = await adapter.bytesOracle!(runId, stepId, NONCE);
        if (result.buffer_bytes !== oracle.bytes || result.buffer_count !== oracle.count) {
          throw new Error(
            `expected AppendResult writer-scope {count:${oracle.count}, bytes:${oracle.bytes}} per the ` +
              `oracle, got {count:${result.buffer_count}, bytes:${result.buffer_bytes}}`,
          );
        }
      },
    });
  } else {
    cases.push(
      skipCase(
        'PER_WRITER_BUDGET',
        'byte-exactness against an adapter-supplied oracle',
        'adapter did not supply bytesOracle (count-based assertions above still ran)',
      ),
    );
  }

  return cases;
}

// ── VERBATIM (issue #197 PR-1, the seal rung's byte-fidelity guarantee) ──────────────────────────
function buildVerbatimCases(
  adapter: FencedTraceBufferContractAdapter,
): FencedTraceBufferContractCase[] {
  const { store } = adapter;
  if (!storeDeclaresSeal(store)) {
    return [
      skipCase(
        'VERBATIM',
        'a seal moves bytes/shape without loss',
        "store does not declare 'seal'",
      ),
    ];
  }

  const cases: FencedTraceBufferContractCase[] = [];

  // Shape-tolerant sibling — runs UNCONDITIONALLY for every seal-declaring store (in-memory has no
  // on-disk representation at all, so only logical content/order can be asserted for it).
  cases.push({
    law: 'VERBATIM',
    name: 'shape-tolerant: sealed content preserves every entry, in order, with no duplication or loss',
    run: async () => {
      const { runId, stepId } = adapter.makeKey();
      const B: AgentTraceEntry[] = [{ event: 'v0' }, { event: 'v1' }, { event: 'v2' }];
      await store.append(runId, stepId, B);
      await store.sealFenced!(runId, stepId, passingGuard());

      const sealedArtifacts = (await store.listSealedForRun!(runId)).filter(
        (a) => a.step_id === stepId,
      );
      const events = sealedArtifacts.flatMap((a) =>
        a.lines.flatMap((l) => l.entries.map((e) => e.event)),
      );
      if (JSON.stringify(events) !== JSON.stringify(['v0', 'v1', 'v2'])) {
        throw new Error(
          `expected sealed content ['v0','v1','v2'] in order, got ${JSON.stringify(events)}`,
        );
      }
    },
  });

  if (adapter.rawWalAccess !== undefined) {
    cases.push({
      law: 'VERBATIM',
      name: 'fs-scoped: a seal moves the live WAL bytes to the sealed artifact byte-for-byte (no parse/re-copy)',
      run: async () => {
        const { runId, stepId } = adapter.makeKey();
        await store.append(runId, stepId, [{ event: 'raw1' }, { event: 'raw2' }]);
        const rawBefore = await adapter.rawWalAccess!.readLiveRaw(runId, stepId);
        if (rawBefore === undefined) {
          throw new Error('expected the live WAL to exist (raw bytes) before sealing');
        }

        const result = await store.sealFenced!(runId, stepId, passingGuard());
        if (result.sealed !== true) {
          throw new Error(`expected {sealed:true}, got: ${JSON.stringify(result)}`);
        }

        const rawAfter = await adapter.rawWalAccess!.readSealedRaw(runId, stepId, 0);
        if (rawAfter === undefined) {
          throw new Error(
            'expected the sealed artifact to exist (raw bytes) at seq 0 after sealing',
          );
        }
        if (rawAfter !== rawBefore) {
          throw new Error(
            'expected the sealed artifact bytes to be byte-for-byte identical to the pre-seal live ' +
              `WAL bytes, got a difference (before=${JSON.stringify(rawBefore)}, after=${JSON.stringify(rawAfter)})`,
          );
        }
      },
    });
  } else {
    cases.push(
      skipCase(
        'VERBATIM',
        'byte-for-byte raw comparison against an adapter-supplied rawWalAccess hook',
        'adapter did not supply rawWalAccess (the shape-tolerant sibling case above still ran)',
      ),
    );
  }

  return cases;
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

  // issue #197 PR-1: the capability-ladder STRUCTURAL cases below. The first three exercise
  // `validateTraceCapabilities` against hand-built STUB stores (never the real adapter store) —
  // this is deliberately a MECHANISM test: PR-1 ships `validateTraceCapabilities` itself, but
  // invoking it at real injection seams is PR-2's job, so there is no real call site yet whose
  // behavior this could observe indirectly.
  cases.push({
    law: 'STRUCTURAL',
    name: 'validateTraceCapabilities: declaring writer_nonce_carriage without seal methods throws TRACE_CAPABILITY_INCONSISTENT',
    run: async () => {
      const stub = minimalStubStore(new Set<TraceCapability>(['writer_nonce_carriage']));
      const err = catchSync(() => validateTraceCapabilities(stub));
      assertCapabilityInconsistent(err, 'writer_nonce_carriage');
    },
  });

  cases.push({
    law: 'STRUCTURAL',
    name: 'validateTraceCapabilities: declaring seal without the fenced trio + sealFenced/listSealedForRun throws TRACE_CAPABILITY_INCONSISTENT',
    run: async () => {
      const stub = minimalStubStore(new Set<TraceCapability>(['seal'])); // no fenced trio, no sealFenced
      const err = catchSync(() => validateTraceCapabilities(stub));
      assertCapabilityInconsistent(err, 'seal');
    },
  });

  cases.push({
    law: 'STRUCTURAL',
    name: 'validateTraceCapabilities: an undeclared store (no traceCapabilities at all) is a silent no-op — trio-alone stays legal',
    run: async () => {
      const stub = minimalStubStore(undefined);
      const err = catchSync(() => validateTraceCapabilities(stub));
      if (err !== undefined) {
        throw new Error(`expected no throw for an undeclared store, got: ${err}`);
      }
    },
  });

  cases.push({
    law: 'STRUCTURAL',
    name: "traceCapabilities is immutable: two reads of the REAL adapter store's declaration are content-identical",
    run: async () => {
      const first = store.traceCapabilities;
      const second = store.traceCapabilities;
      const firstArr = [...(first ?? [])].sort();
      const secondArr = [...(second ?? [])].sort();
      if (JSON.stringify(firstArr) !== JSON.stringify(secondArr)) {
        throw new Error(
          `expected two reads of traceCapabilities to be content-identical, got ${JSON.stringify(firstArr)} then ${JSON.stringify(secondArr)}`,
        );
      }
    },
  });

  cases.push({
    law: 'STRUCTURAL',
    name: "the REAL adapter store's own declaration is internally consistent (ladder holds for what it actually declares)",
    run: async () => {
      const caps = store.traceCapabilities;
      if (caps?.has('seal') === true && !storeDeclaresSeal(store)) {
        throw new Error(
          "adapter store declares 'seal' but storeDeclaresSeal(store) is false — declared but inconsistent",
        );
      }
      if (caps?.has('writer_nonce_carriage') === true && !storeDeclaresNonceCarriage(store)) {
        throw new Error(
          "adapter store declares 'writer_nonce_carriage' but storeDeclaresNonceCarriage(store) is false — declared but inconsistent",
        );
      }
    },
  });

  // ── FENCE_REFUSES ───────────────────────────────────────────────────────────────────────────
  // Accepted limits of this law (issue #207 correction): FENCE_REFUSES asserts that a guard
  // rejection propagates typed/unwrapped with nothing written/deleted — it does NOT, and cannot,
  // distinguish that outcome from a store that (a) performs the write/delete, THEN discovers the
  // guard should have refused, and rolls the effect back via a compensating action
  // (write-then-rollback); or (b) a genuine crash between the effect and its own bookkeeping
  // happens to leave residue that looks, from this law's own read-after observation, like
  // "nothing written". Both are indistinguishable from a true refusal by this law's assertions —
  // a store relying on either is simply out of this TCK's detection range, not certified free of
  // that residue by a green run here.
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
    name: 'deleteAllForRunFenced: refusal with >=2 seeded files — ALL files intact, error propagates exactly as the guard threw it',
    run: async () => {
      const { runId } = adapter.makeKey();
      const stepA = 'fenced-tck-step-a';
      const stepB = 'fenced-tck-step-b';
      await store.append(runId, stepA, [{ event: 'a' }]);
      await store.append(runId, stepB, [{ event: 'b' }]);
      let caught: unknown;
      try {
        await store.deleteAllForRunFenced!(runId, refusingGuard());
      } catch (err) {
        caught = err;
      }
      // issue #207 correction: assert the propagated error IS the guard's own typed error —
      // never something a wrapping layer (e.g. toArtifactDeleteFailedError) substituted in its
      // place (that would surface as ENGINE_ARTIFACT_DELETE_FAILED instead of REFUSAL_CODE).
      if (!(caught instanceof WorkflowError) || caught.code !== REFUSAL_CODE) {
        throw new Error(
          `expected deleteAllForRunFenced to reject with the guard's own typed error ` +
            `(WorkflowError, code=${REFUSAL_CODE}) — never wrapped — got: ${caught}`,
        );
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
    name: 'deleteAllForRunFenced: zero-match sweep still invokes the guard at least once, and its rejection propagates unwrapped',
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
      let caught: unknown;
      try {
        await store.deleteAllForRunFenced!(runId, countingRefusingGuard);
      } catch (err) {
        caught = err;
      }
      // issue #207 correction: same exact-identity assertion as the >=2-file case above — a
      // zero-match sweep is not a laxer case, it must reject with the guard's own typed error too.
      if (!(caught instanceof WorkflowError) || caught.code !== REFUSAL_CODE) {
        throw new Error(
          `expected a zero-match sweep with a refusing guard to reject with the guard's own typed ` +
            `error (WorkflowError, code=${REFUSAL_CODE}) — never wrapped — got: ${caught}`,
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
    name: "deleteAllForRunFenced: a guard throwing FsIoError propagates it exactly — never mistaken for deleteIfExists's own failure and wrapped",
    run: async () => {
      // issue #207 correction, dedicated case (D3 §1's own demanded test): a realistic scenario
      // is the guard's lock-free `runStore.get` itself hitting a filesystem error (e.g. EACCES on
      // the run-record file) — since that surfaces as an FsIoError too, a sweep implementation
      // that wraps "any FsIoError seen inside the per-file try" (rather than scoping the wrap to
      // ONLY deleteIfExists's own failure) would incorrectly re-wrap the guard's own error as
      // ENGINE_ARTIFACT_DELETE_FAILED, discarding its original identity.
      const { runId } = adapter.makeKey();
      const stepA = 'fenced-tck-step-fsio';
      await store.append(runId, stepA, [{ event: 'seed' }]);
      const cause = Object.assign(new Error('EACCES (simulated)'), { code: 'EACCES' });
      const fsIoGuard = async (): Promise<void> => {
        throw new FsIoError('read', '/fenced-tck/simulated-guard-path', cause);
      };
      let caught: unknown;
      try {
        await store.deleteAllForRunFenced!(runId, fsIoGuard);
      } catch (err) {
        caught = err;
      }
      if (!(caught instanceof FsIoError)) {
        throw new Error(
          `expected the guard's own FsIoError to propagate exactly (not wrapped as ` +
            `ENGINE_ARTIFACT_DELETE_FAILED via toArtifactDeleteFailedError), got: ${caught}`,
        );
      }
      const after = await store.read(runId, stepA);
      if (after.length !== 1) {
        throw new Error(
          `expected the seeded file intact after a sweep refused by an FsIoError guard, got ${after.length}`,
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

  // ── Capability-ladder laws (issue #197 PR-1): CARRIAGE_ROUND_TRIP, SEAL, SEAL_BUDGET,
  // PER_WRITER_BUDGET, VERBATIM. Each produces a visible documented-skip (never a silent
  // omission) for a store that doesn't declare the relevant rung — see each build*Cases
  // function's own doc.
  cases.push(...buildCarriageRoundTripCases(adapter));
  cases.push(...buildSealCases(adapter));
  cases.push(...buildPerWriterBudgetCases(adapter));
  cases.push(...buildVerbatimCases(adapter));

  return cases;
}
